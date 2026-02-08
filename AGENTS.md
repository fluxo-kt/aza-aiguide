# tav — Conversation Bookmark Plugin for Claude Code

Defence-in-depth context protection for Claude Code sessions. Five layers prevent context death during parallel agent execution: proactive `/compact` injection, PreToolUse agent throttling, PreCompact state preservation, bookmark rewind point injection, and offline JSONL session repair. Terminal input injection via tmux/screen/osascript creates navigable rewind points (`·`). A UserPromptSubmit hook intercepts the synthetic message and tells Claude to ignore it via `additionalContext`.

## Architecture

**Hook pipeline** (6 scripts, 8 hook events):

| Hook Event | Script | Timeout | readStdin | Purpose |
|------------|--------|---------|-----------|---------|
| SessionStart | session-start.ts | 5s | 3000ms | Detect injection method (tmux/screen/osascript), write session config |
| PreToolUse | context-guard.ts | 3s | 2500ms | Deny `Task` tool calls when context pressure exceeds `denyPercent` |
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

Two metric scopes: **windowed** (T/A lines after last `B` = current window, used for bookmark thresholds) and **cumulative** (T/A chars after last `C` marker = since last compaction, used as fallback for context pressure). `meetsAnyThreshold()` in `lib/log.ts` is the **single source of truth** for threshold evaluation. `shouldInjectBookmark()` in `lib/evaluate.ts` is the **single source of truth** for guard ordering — used by both Stop and SubagentStop. `shouldCompact()` in `lib/evaluate.ts` is the **single source of truth** for compaction evaluation.

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
bun test                 # 316 tests across 16 files
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
| `src/lib/inject.ts` | Injection: detection, command building, `requestBookmark()`, `requestCompaction()`, `detectSessionLocation()`, `verifyLocation()` |
| `src/lib/evaluate.ts` | `shouldInjectBookmark()`, `shouldCompact()` — unified guard ordering |
| `src/lib/context-pressure.ts` | Dual-source context pressure: JSONL tail-read (primary) + chars/4 (fallback) |
| `src/lib/jsonl-types.ts` | Shared `JournalEntry`, `ParsedLine` types and `parseJSONL()` for repair + extract |
| `src/lib/session.ts` | `SessionConfig` type (incl. `jsonlPath`, `cachedConfig`, `SessionLocation`), `readSessionConfig()`, `writeSessionConfig()` (atomic via tmp+rename) |
| `src/lib/guards.ts` | Stop guards: `isContextLimitStop()`, `isUserAbort()` — pure functions |
| `src/lib/stdin.ts` | Shared `readStdin(timeoutMs)` — single implementation for all hooks |
| `src/context-guard.ts` | PreToolUse hook: denies `Task` calls when context pressure exceeds threshold |
| `src/bookmark-precompact.ts` | PreCompact hook: resets activity window, injects summary into compaction |
| `src/repair.ts` | Standalone CLI: JSONL surgery to insert rewind points in dead sessions |
| `src/extract-session.ts` | JSONL preprocessor for Gemini analysis (filters noise, truncates tool_use) |
| `skills/tav/SKILL.md` | `/tav` skill: repair, list, summarize, analyze, status commands |
| `hooks/hooks.json` | 8 hook events → 6 scripts. Runner: bun first, node dist/ fallback |

## Configuration

`~/.claude/tav/config.json` — partial configs deep-merged with defaults. All threshold values validated via `validNumber()` (rejects `Infinity`, null, arrays, objects that `Number()` would silently coerce to 0).

**Bookmark thresholds**: `minTokens:6000`, `minToolCalls:15`, `minSeconds:120`, `agentBurstThreshold:3`, `cooldownSeconds:25`. ANY threshold met triggers bookmark.

**Context guard** (defence-in-depth):
```json
{
  "contextGuard": {
    "enabled": true,
    "contextWindowTokens": 200000,
    "compactPercent": 0.76,
    "denyPercent": 0.85,
    "compactCooldownSeconds": 120,
    "responseRatio": 0.25
  }
}
```
- `compactPercent`: context pressure ratio (0–1) at which `/compact` is injected (default 76%)
- `denyPercent`: pressure ratio at which new `Task` tool calls are denied (default 85%)
- `contextWindowTokens`: nominal context window size (MUST match actual model — no auto-detection)
- `responseRatio`: fraction of context that is response content (default 0.25). Used by fallback pressure calculation: `cumulativeEstimatedTokens / (windowTokens × responseRatio)`. Also used for legacy threshold-to-percentage conversion
- Compaction injects `/compact` as real user input via terminal — the only external mechanism that triggers compaction
- Agent throttling returns `permissionDecision: "deny"` on `PreToolUse` for `Task` calls
- Legacy `compactThreshold`/`denyThreshold` fields are auto-converted to percentages by `validateConfig()`

## Injection Fallback Chain

Detected once at SessionStart, stored in `~/.claude/tav/state/{id}.json`:

1. **tmux** (`$TMUX` + `$TMUX_PANE`) — primary. Per-pane targeting, works regardless of foreground app
2. **GNU Screen** (`$STY`) — `screen -X stuff`
3. **osascript** (macOS) — only when terminal process is identifiable via `$TERM_PROGRAM`. Uses process-targeted AppleScript (`tell process "X"`) with **frontmost application check** to prevent keystrokes landing in wrong apps. Injection only occurs if terminal is the active foreground application. Supported: Terminal.app, iTerm2, Warp, VS Code, Ghostty, kitty, Alacritty, Hyper. Needs Accessibility permissions
4. **disabled** — graceful degradation, no errors. Also used when macOS terminal is unrecognised (safety over convenience)

## Context Pressure System

Dual-source context pressure measurement replaces absolute token thresholds:

**Primary: JSONL tail-read** — reads last 64KB of `~/.claude/projects/{hash}/{sessionId}.jsonl`, collects ALL `"type":"assistant"` entries with `message.usage`, returns the one with highest `timestamp` (most recent). This prevents cache segments from causing stale high-token readings. Effective context = `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`. O(1) relative to file size (<5ms for 25MB files).

**Fallback: chars/4 estimation** — `cumulativeEstimatedTokens` from tav's activity log (T/A char counts after last `C` marker, divided by 4). Scaled by `responseRatio` to convert response-only tokens to full-context pressure: `cumulativeEstimatedTokens / (windowTokens × responseRatio)`. Without this scaling, the fallback would need ~4× more tokens to trigger. Used when JSONL unavailable.

**JSONL path resolution**: Resolved once at SessionStart via `resolveJsonlPath(sessionId)`, cached in `SessionConfig.jsonlPath`. Scans `~/.claude/projects/*/` for matching `{sessionId}.jsonl`. Returns null if not found (new session) — triggers fallback gracefully.

**Concurrent write safety**: CC appends to the JSONL while hooks read. `readLastAssistantUsage()` always discards the last line (may be partial write). Only discards the first line when reading from mid-file (chunk boundary may split a JSON line); when reading the whole file (position=0), the first line is always complete and is kept.

**Burst detection**: Emergency compaction when 5+ agent returns in 10 seconds AND pressure > `compactPercent` AND contextGuard is enabled AND injection method is not disabled AND compaction cooldown has elapsed. Respects the same `compactCooldownSeconds` as normal compaction to prevent `/compact` spam during rapid agent returns. During agent cascades, the Stop hook never fires — SubagentStop is the only checkpoint.

## Session JSONL Structure

Session JSONL at `~/.claude/projects/{hash}/{sessionId}.jsonl` — entry type distribution:
- `progress`: ~42.6% (tool execution status — noise)
- `user`: ~39.8% (human messages, tool results)
- `assistant`: ~16.2% (responses, has `message.usage` with real token counts)
- `file-history-snapshot`: ~1% (file tracking — noise)

Assistant entries contain `message.usage`:
```json
{"input_tokens": 3, "cache_creation_input_tokens": 1426, "cache_read_input_tokens": 160480, "output_tokens": 1}
```

## Common Pitfalls

- `Number(null) === 0` not `NaN` — that's why `validNumber()` checks `typeof` first
- Hook timeout kills process hard — no catch block runs if readStdin exceeds it
- `tmux send-keys` needs `-l` flag for literal Unicode (without it, `·` could be interpreted as a key name)
- osascript needs separate `keystroke` + `key code 36` (Enter) — single command is unreliable
- 1.5s sleep before injection is the verified minimum for Ink-based apps (300ms is unreliable)
- CC hooks run as separate processes — each invocation is a fresh Node/Bun process, no shared memory
- `ensureStateDir()` calls `mkdirSync({recursive:true})` on every `appendEvent` — cheap syscall, prevents race on first write
- Session IDs can contain any characters — `sanitizeSessionId()` replaces non-alphanumeric with `_` and truncates to 200 chars (filesystem limit is 255 minus suffix)
- JSONL path null at SessionStart is OK — new sessions may not have a JSONL yet; falls back to chars/4
- `cumulativeEstimatedTokens` MUST reset after last `C` marker — without this, post-compaction content is still counted, causing immediate re-trigger (compaction loop)
- `contextWindowTokens` must match actual model — no auto-detection possible. 200K default is wrong for 1M models
- osascript requires process-targeted injection — without it, keystrokes go to frontmost app (e.g. browser). Unknown terminals get `disabled` instead
- Pressure ratio can exceed 1.0 (cache segments) — `getContextPressure()` clamps to `Math.min(ratio, 1.0)`
- `recentAgentTimestamps` MUST reset at B markers — without this, pre-bookmark agent timestamps persist, causing false burst detection
- Burst detection threshold MUST use `config.contextGuard.compactPercent`, never hardcoded values — hardcoded 0.60 caused premature compaction at 55%

## Design Decisions & Rationale

**Append-only log vs JSON state**: JSON would require read-modify-write on every PostToolUse (fires per tool call). `appendFileSync` is atomic for <4KB writes (POSIX PIPE_BUF). No locking needed, no corruption possible, no drift from missed increments. Metrics derived fresh each time = self-healing counters.

**`tsc` not `bun build`**: `bun build` is a bundler (splitting, chunking). `tsc` preserves directory structure (`src/lib/` → `dist/lib/`), handles multi-entrypoint correctly, outputs CommonJS that Node runs natively. Predictable, battle-tested.

**SubagentStop evaluates ALL thresholds (not just agent burst)**: During long agent-cascade turns (10+ agents returning sequentially), the Stop hook never fires because Claude's turn hasn't ended. SubagentStop is the ONLY checkpoint. If it only checked `agentBurstThreshold`, token/time thresholds would never trigger during bursts.

**Anti-collision check removed from bookmark-submit**: Originally checked for a recent `I` line before confirming a bookmark. Removed because: (a) enables manual `·` bookmarks when injection is unavailable, (b) the `·` marker is sufficiently uncommon that false positives are negligible, (c) simpler code = fewer failure modes. User can change marker in config if needed.

**Pre-spawn `I` marker**: Written to log BEFORE spawning the background injection process. Prevents double-bookmark race: if Stop and SubagentStop fire close together, the second sees the first's `I` line → cooldown blocks it.

**Token estimation `chars/4`**: Underestimates code/JSON by ~25%. This is intentionally conservative — triggers slightly late rather than early. Now a fallback only — primary path uses real JSONL tokens.

**Percentage-based thresholds over absolute**: Absolute token thresholds (30K/45K) don't scale across context window sizes (200K vs 1M). Percentages (76%/85%) are model-agnostic. The user sets `contextWindowTokens` once; all thresholds adapt automatically.

**JSONL tail-read over full parse**: A 25MB JSONL has ~50K lines. Full parse takes ~100ms. Tail-read of 64KB takes <5ms. Since we only need the LAST assistant entry's usage, scanning backwards from the end is optimal.

**JSONL path caching over per-hook glob**: Globbing `~/.claude/projects/*/` on every hook adds ~5-15ms per invocation. Resolving once at SessionStart and caching in `SessionConfig.jsonlPath` makes subsequent reads O(1). Stale path degrades to fallback gracefully.

**Config caching over per-hook loadConfig()**: Each hook runs as a separate process. Without caching, editing `config.json` mid-session applies changes inconsistently — one hook may read the old config while another reads the new one. Caching once at SessionStart ensures all hooks use identical config throughout the session. Fallback to `loadConfig()` preserves backward compatibility.

**JSONL most-recent-by-timestamp over last-found**: Cache segments can create assistant entries with inflated token counts (183K) that appear after the actual most recent entry (5K). Sorting by `timestamp` field and returning the highest ensures accurate pressure readings regardless of file order.

**Atomic session config writes**: Uses write-to-tmp + `renameSync` instead of direct `writeFileSync`. POSIX `rename()` is atomic — prevents partial writes if the process is killed mid-write. Without this, concurrent hooks could read half-written JSON.

**Marker `·` (U+00B7 middle dot)**: 1 token, visually minimal in conversation, no collision with any known CC trigger or slash command. Configurable via `config.json`.

## Session Skill (`/tav`)

Registered via `"skills": "./skills/"` in `.claude-plugin/plugin.json`. Each skill is a `SKILL.md` with YAML frontmatter (name + description).

| Command | Action |
|---------|--------|
| `/tav list` | List session JSONL files |
| `/tav repair <prefix>` | Run offline JSONL surgery (`src/repair.ts`) |
| `/tav summarize <prefix>` | Preprocess JSONL → Gemini Flash summary |
| `/tav analyze <prefix>` | Preprocess JSONL → Gemini Pro deep analysis |
| `/tav status` | Report current session's context pressure |

**Session JSONL preprocessing** (`src/extract-session.ts`): Filters noise entries (progress, file-history-snapshot — ~44% reduction), truncates tool_use content blocks, caps output at `--max-chars` (default 500K ~125K tokens). Output is markdown suitable for Gemini consumption.

**Session resolution**: searches `~/.claude/projects/{hash}/` and `~/.claude/transcripts/` for matching JSONL files. Deduplicates by session ID, sorts by mtime.

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
- **Context pressure tests**: tail-read with concurrent-write safety, fallback, clamping, path resolution
- **Extract session tests**: noise filtering, tool_use truncation, maxChars truncation, structured content blocks
- **JSONL types tests**: parsing, malformed lines, index signature, round-trip fidelity

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

## Config Caching (Hot-Reload Race Prevention)

All 5 downstream hooks read config from `SessionConfig.cachedConfig` (typed as `TavConfig`) instead of calling `loadConfig()` independently. Config is loaded once at SessionStart and cached in the session config file. This prevents mid-session config changes from causing non-deterministic behaviour across hooks (e.g. one hook using old thresholds, another using new ones).

Fallback: if `cachedConfig` is undefined (session started before caching was implemented), hooks fall back to `loadConfig()`.

## Session Location (Opt-In Targeting Verification)

Optional feature to prevent keystrokes landing in the wrong terminal tab/pane. Disabled by default (`sessionLocation.enabled: false`).

When enabled, `detectSessionLocation()` captures terminal identifiers at SessionStart (tmux pane ID, screen session, terminal app name) and stores them in `SessionConfig.location`. Before injection, `verifyLocation()` compares declared location against current environment — injection is skipped on mismatch.

Four-tier graceful degradation: feature disabled → pass, no declared location → pass, detection failure → pass, mismatch → block.

```json
{
  "sessionLocation": {
    "enabled": false,
    "verifyTab": false,
    "terminals": {
      "iterm2": { "tabVerification": false },
      "terminal": { "tabVerification": false }
    }
  }
}
```

## SessionStart Incremental Writes

SessionStart writes config incrementally to prevent downstream hook failures if the hook crashes mid-execution. Each detection step updates the session config file via atomic write (write to `.tmp`, then `renameSync`):

1. Write minimal config immediately (sessionId, startedAt, injectionMethod: 'detecting', cachedConfig)
2. Update with injection method after detection
3. Update with JSONL path after resolution
4. Update with session location after detection (if enabled)

If SessionStart crashes after step 1, downstream hooks still have a valid config to read.

## Multi-Session Safety

Each CC session has a unique session ID → unique log file + session config. tmux injection targets the specific `$TMUX_PANE` (e.g. `%3`), not the session. Multiple CC instances in different tmux panes work independently — each targets its own pane, reads its own log, writes its own state. No cross-session interference.
