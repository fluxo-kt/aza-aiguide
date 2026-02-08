# tav — Conversation Bookmark Plugin for Claude Code

Defence-in-depth context protection for Claude Code sessions. Five layers prevent context death during parallel agent execution: proactive `/compact` injection, PreToolUse agent throttling, PreCompact state preservation, bookmark rewind point injection, and offline JSONL session repair. Terminal input injection via tmux/screen/osascript creates navigable rewind points (`·`). A UserPromptSubmit hook intercepts the synthetic message and tells Claude to ignore it via `additionalContext`.

## Architecture

**Hook pipeline** (6 scripts, 8 hook events):

| Hook Event | Script | Timeout | readStdin | Purpose |
|------------|--------|---------|-----------|---------|
| SessionStart | session-start.ts | 5s | 3000ms | Detect injection method (tmux/screen/osascript), write session config |
| PreToolUse | context-guard.ts | 3s | 2500ms | Deny `Task` tool calls when context pressure exceeds `denyThreshold` |
| PostToolUse | bookmark-activity.ts | 3s | 2500ms | Append `T` line to activity log |
| SubagentStop | bookmark-activity.ts | 5s | 2500ms | Append `A` line + evaluate ALL thresholds + compaction check |
| PreCompact | bookmark-precompact.ts | 3s | 2500ms | Reset activity window (`B` marker), inject `additionalContext` summary |
| Stop | bookmark-stop.ts | 5s | 4000ms | Parse log, evaluate thresholds, spawn injection + compaction check |
| UserPromptSubmit | bookmark-submit.ts | 3s | 2500ms | Intercept `·`, return `additionalContext` telling Claude to ignore it |

**Standalone CLI**: `src/repair.ts` — offline JSONL surgery for dead sessions (inserts synthetic rewind points).

**CRITICAL: readStdin timeout MUST be < hook timeout** with >= 500ms margin. If readStdin exceeds hook timeout, process is killed silently — no error handling, no `{"continue":true}` output.

## Activity Log (Core State Mechanism)

Append-only text file at `~/.claude/tav/state/{sessionId}.log`. No JSON state, no read-modify-write. `appendFileSync` is POSIX-atomic for writes < PIPE_BUF (4KB).

```
T 1707321600000 1234     # Tool call: timestamp, response char count
A 1707321601000 5678     # Agent return: timestamp, output char count
I 1707321603000          # Injection spawned (pre-spawn marker)
B 1707321605000          # Bookmark confirmed
C 1707321610000          # Compaction injected (/compact sent to terminal)
```

Two metric scopes: **windowed** (T/A lines after last `B` = current window, used for bookmark thresholds) and **cumulative** (all T/A chars across entire log, used for context guard). `meetsAnyThreshold()` in `lib/log.ts` is the **single source of truth** for threshold evaluation. `shouldInjectBookmark()` in `lib/evaluate.ts` is the **single source of truth** for guard ordering — used by both Stop and SubagentStop.

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
bun test                 # 227 tests across 13 files
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
| `src/lib/inject.ts` | Injection: detection, command building, `requestBookmark()`, `requestCompaction()` |
| `src/lib/evaluate.ts` | `shouldInjectBookmark()` — unified guard ordering for Stop + SubagentStop |
| `src/lib/session.ts` | `SessionConfig` type, `readSessionConfig()`, `writeSessionConfig()` |
| `src/lib/guards.ts` | Stop guards: `isContextLimitStop()`, `isUserAbort()` — pure functions |
| `src/lib/stdin.ts` | Shared `readStdin(timeoutMs)` — single implementation for all hooks |
| `src/context-guard.ts` | PreToolUse hook: denies `Task` calls when context pressure exceeds threshold |
| `src/bookmark-precompact.ts` | PreCompact hook: resets activity window, injects summary into compaction |
| `src/repair.ts` | Standalone CLI: JSONL surgery to insert rewind points in dead sessions |
| `hooks/hooks.json` | 8 hook events → 6 scripts. Runner: bun first, node dist/ fallback |

## Configuration

`~/.claude/tav/config.json` — partial configs deep-merged with defaults. All threshold values validated via `validNumber()` (rejects `Infinity`, null, arrays, objects that `Number()` would silently coerce to 0).

**Bookmark thresholds**: `minTokens:6000`, `minToolCalls:15`, `minSeconds:120`, `agentBurstThreshold:3`, `cooldownSeconds:25`. ANY threshold met triggers bookmark.

**Context guard** (defence-in-depth):
```json
{
  "contextGuard": {
    "enabled": true,
    "compactThreshold": 30000,
    "compactCooldownSeconds": 120,
    "denyThreshold": 45000
  }
}
```
- `compactThreshold`: cumulative estimated tokens before injecting `/compact` (~60% capacity)
- `denyThreshold`: cumulative tokens before denying new `Task` tool calls (~90% capacity)
- Compaction injects `/compact` as real user input via terminal — the only external mechanism that triggers compaction
- Agent throttling returns `permissionDecision: "deny"` on `PreToolUse` for `Task` calls

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
- **Log tests**: append events to temp dir, verify `parseLog()` returns correct metrics (windowed + cumulative)
- **Inject tests**: mock `process.env` for method detection, verify command strings are properly sanitised
- **Hook tests**: call exported functions directly (`evaluateBookmark`, `handleSubagentStop`, `processBookmark`, `evaluateContextPressure`, `processPreCompact`) — no subprocess spawning in tests
- **Evaluate tests**: verify unified guard ordering in `shouldInjectBookmark()` — covers all guard paths
- **Session tests**: round-trip `writeSessionConfig`/`readSessionConfig` with edge cases (corrupted JSON, special chars)
- **Repair tests**: end-to-end JSONL surgery with chain validation, break point detection, dry-run, compact boundary handling

## Session Repair Tool

Standalone CLI for offline JSONL surgery on dead sessions. Run from a separate terminal (the dead session cannot repair itself).

```bash
bun run src/repair.ts <session-id-prefix>        # Repair by prefix
bun run src/repair.ts <path/to/session.jsonl>    # Repair by path
bun run src/repair.ts list                        # List sessions
bun run src/repair.ts <prefix> --dry-run          # Preview only
bun run src/repair.ts <prefix> --interval 3       # Break every 3 assistant entries
```

Creates `.tav-backup` before modifying. Inserts synthetic user messages (`·`) at break points (every N assistant entries, turn boundaries, time gaps). Repairs UUID chain. Validates integrity.

**WARNING**: CC loading repaired JSONL as rewind points is UNVERIFIED. Always test on a non-critical session first.

## Multi-Session Safety

Each CC session has a unique session ID → unique log file + session config. tmux injection targets the specific `$TMUX_PANE` (e.g. `%3`), not the session. Multiple CC instances in different tmux panes work independently — each targets its own pane, reads its own log, writes its own state. No cross-session interference.
