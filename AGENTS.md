# tav — Conversation Bookmark Plugin for Claude Code

Auto-injects minimal bookmark messages (`·`) into long Claude Code sessions via terminal input injection (tmux/screen/osascript), creating navigable rewind points. Dual-hook pipeline: activity hooks count work, Stop/SubagentStop hooks evaluate adaptive thresholds and spawn detached background processes that type `·` into the terminal after 1.5s delay. A UserPromptSubmit hook intercepts the synthetic message and tells Claude to ignore it via `additionalContext`.

## Architecture

**Hook pipeline** (4 scripts, 5 hook events):

| Hook Event | Script | Timeout | readStdin | Purpose |
|------------|--------|---------|-----------|---------|
| SessionStart | session-start.ts | 5s | 3000ms | Detect injection method (tmux/screen/osascript), write session config |
| PostToolUse | bookmark-activity.ts | 3s | 2500ms | Append `T` line to activity log |
| SubagentStop | bookmark-activity.ts | 5s | 2500ms | Append `A` line + evaluate ALL thresholds (burst protection) |
| Stop | bookmark-stop.ts | 5s | 4000ms | Parse log, evaluate thresholds, spawn injection |
| UserPromptSubmit | bookmark-submit.ts | 3s | 2500ms | Intercept `·`, return `additionalContext` telling Claude to ignore it |

**CRITICAL: readStdin timeout MUST be < hook timeout** with >= 500ms margin. If readStdin exceeds hook timeout, process is killed silently — no error handling, no `{"continue":true}` output.

## Activity Log (Core State Mechanism)

Append-only text file at `~/.claude/tav/state/{sessionId}.log`. No JSON state, no read-modify-write. `appendFileSync` is POSIX-atomic for writes < PIPE_BUF (4KB).

```
T 1707321600000 1234     # Tool call: timestamp, response char count
A 1707321601000 5678     # Agent return: timestamp, output char count
I 1707321603000          # Injection spawned (pre-spawn marker)
B 1707321605000          # Bookmark confirmed
```

All metrics derived fresh from log on each evaluation — counters never accumulate drift. Lines after last `B` = current window. `meetsAnyThreshold()` in `lib/log.ts` is the **single source of truth** for threshold evaluation — used by both Stop and SubagentStop.

## Three-Layer Feedback Loop Prevention

1. **Cooldown** — I/B timestamp within `cooldownSeconds` blocks new injections
2. **Counter reset** — metrics only count T/A lines after last B
3. **Bookmark-response skip** — if last log line is B, no activity happened, skip

These three barriers make infinite loops **structurally impossible**.

## Critical Constraints

- **Node-compatible APIs ONLY** in `src/` — no `Bun.file()`, `Bun.spawn()`, `Bun.stdin`. dist/ must run on Node.
- **`import type`** for all TS type imports
- **No file extensions** in TS imports — use `'./lib/config'` not `'./lib/config.ts'`
- **All hooks output `{"continue": true}`** on stdout — even on error. Never block Claude Code.
- **Exit 0 always** — hook errors must never cause non-zero exit
- **Shell injection** — all interpolated values in `buildInjectionCommand` are sanitised via `sanitizeForShell()`. osascript path has double sanitisation (AppleScript + shell).

## Build & Test

```bash
bun install              # dev deps only (typescript, @types/node, bun-types)
bun test                 # 149 tests across 8 files
bun run build            # tsc -p tsconfig.build.json → dist/
bunx tsc --noEmit        # typecheck (includes tests)
```

**Two tsconfigs**: `tsconfig.json` (full, includes tests), `tsconfig.build.json` (extends base, excludes tests, sets rootDir=src/). Build uses `tsconfig.build.json`.

**dist/ is committed intentionally** — CC plugins have no build lifecycle. Without dist/, users without bun get a broken plugin. Every commit touching `src/` must rebuild dist/.

## Key Files

| File | Role |
|------|------|
| `src/lib/log.ts` | Activity log: append, parse, derive metrics, `meetsAnyThreshold()` |
| `src/lib/config.ts` | Config loader with deep merge + type validation (`validNumber()`, `validateConfig()`) |
| `src/lib/inject.ts` | Injection method detection, shell command building, `spawnDetached()` |
| `src/lib/guards.ts` | Stop guards: `isContextLimitStop()`, `isUserAbort()` — pure functions |
| `src/lib/stdin.ts` | Shared `readStdin(timeoutMs)` — single implementation for all hooks |
| `hooks/hooks.json` | 5 hook events → 4 scripts. Runner: bun first, node dist/ fallback |

## Configuration

`~/.claude/tav/config.json` — partial configs deep-merged with defaults. All threshold values validated via `validNumber()` (rejects null/arrays/objects that `Number()` would silently coerce to 0).

Defaults: `minTokens:6000`, `minToolCalls:15`, `minSeconds:120`, `agentBurstThreshold:3`, `cooldownSeconds:25`. ANY threshold met triggers bookmark.

## Injection Fallback Chain

Detected once at SessionStart, stored in `~/.claude/tav/state/{id}.json`:

1. **tmux** (`$TMUX` + `$TMUX_PANE`) — primary. Per-pane targeting, works regardless of foreground app
2. **GNU Screen** (`$STY`) — `screen -X stuff`
3. **osascript** (macOS) — lowest priority. Breaks when user switches apps. Needs Accessibility permissions
4. **disabled** — graceful degradation, no errors

## Common Pitfalls

- `Number(null) === 0` not `NaN` — that's why `validNumber()` checks `typeof` first
- Hook timeout kills process hard — no catch block runs if readStdin exceeds it
- `tmux send-keys` needs `-l` flag for literal Unicode (without it, `·` could be interpreted as a key name)
- osascript needs separate `keystroke` + `key code 36` (Enter) — single command is unreliable
- 1.5s sleep before injection is the verified minimum for Ink-based apps (300ms is unreliable)
- CC hooks run as separate processes — each invocation is a fresh Node/Bun process, no shared memory
- `ensureStateDir()` calls `mkdirSync({recursive:true})` on every `appendEvent` — cheap syscall, prevents race on first write
- Session IDs can contain any characters — `sanitizeSessionId()` replaces non-alphanumeric with `_` and truncates to 200 chars (filesystem limit is 255 minus suffix)

## Design Decisions & Rationale

**Append-only log vs JSON state**: JSON would require read-modify-write on every PostToolUse (fires per tool call). `appendFileSync` is atomic for <4KB writes (POSIX PIPE_BUF). No locking needed, no corruption possible, no drift from missed increments. Metrics derived fresh each time = self-healing counters.

**`tsc` not `bun build`**: `bun build` is a bundler (splitting, chunking). `tsc` preserves directory structure (`src/lib/` → `dist/lib/`), handles multi-entrypoint correctly, outputs CommonJS that Node runs natively. Predictable, battle-tested.

**SubagentStop evaluates ALL thresholds (not just agent burst)**: During long agent-cascade turns (10+ agents returning sequentially), the Stop hook never fires because Claude's turn hasn't ended. SubagentStop is the ONLY checkpoint. If it only checked `agentBurstThreshold`, token/time thresholds would never trigger during bursts.

**Anti-collision check removed from bookmark-submit**: Originally checked for a recent `I` line before confirming a bookmark. Removed because: (a) enables manual `·` bookmarks when injection is unavailable, (b) the `·` marker is sufficiently uncommon that false positives are negligible, (c) simpler code = fewer failure modes. User can change marker in config if needed.

**Pre-spawn `I` marker**: Written to log BEFORE spawning the background injection process. Prevents double-bookmark race: if Stop and SubagentStop fire close together, the second sees the first's `I` line → cooldown blocks it.

**Token estimation `chars/4`**: Underestimates code/JSON by ~25%. This is intentionally conservative — triggers slightly late rather than early. Precision not needed since thresholds are approximate.

**Marker `·` (U+00B7 middle dot)**: 1 token, visually minimal in conversation, no collision with any known CC trigger or slash command. Configurable via `config.json`.

## Testing Approach

All tests use `bun:test`. Each test file creates a temp dir (`os.tmpdir()`), passes it as `stateDir`/`logDir`/`configPath` to functions, and cleans up in `afterEach`. No global state, no test ordering dependencies.

Key test patterns:
- **Config tests**: write temp config files with various invalid/partial data, verify `loadConfig()` returns validated defaults
- **Log tests**: append events to temp dir, verify `parseLog()` returns correct metrics
- **Inject tests**: mock `process.env` for method detection, verify command strings are properly sanitised
- **Hook tests**: call exported functions directly (`evaluateBookmark`, `handleSubagentStop`, `processBookmark`) — no subprocess spawning in tests

## Multi-Session Safety

Each CC session has a unique session ID → unique log file + session config. tmux injection targets the specific `$TMUX_PANE` (e.g. `%3`), not the session. Multiple CC instances in different tmux panes work independently — each targets its own pane, reads its own log, writes its own state. No cross-session interference.
