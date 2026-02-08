# Changelog

All notable changes to tav are documented here. Format based on [Keep a Changelog](https://keepachangelog.com/).

## [0.5.0] — 2025-02-08

### Added
- **Smart bookmark placement** in repair tool — death zone detection (`isDeadAssistant`), text block validation (`hasTextContentBlock`), single validation gate (`isValidRewindPoint`). Only inserts bookmarks where CC's rewind UI can actually use them
- **Backup-first repair** — restores from `.tav-backup` before re-repairing, never overwrites existing backup, detects pre-existing bookmarks

### Changed
- **Bookmarks and context guard disabled by default** — both `bookmarks.enabled` and `contextGuard.enabled` now default to `false`. Users must explicitly enable in `~/.claude/tav/config.json`. Prevents unexpected terminal injection for new installations
- **Repair tool chain-aware** — walks parentUuid chain instead of linear file order, matching CC's rewind navigation model
- Default repair interval changed from 5 to 1 for maximum recovery density

### Fixed
- Repair tool inserted bookmarks at positions where CC's rewind UI couldn't reach them (no assistant successor with text block)
- Repair tool used wrong entry type `'human'` instead of `'user'` for synthetic entries
- Synthetic entries now include `gitBranch` and `slug` fields required by CC

## [0.4.0] — 2025-02-08

### Added
- **Session location verification** (opt-in) — prevents keystrokes landing in wrong terminal tab/pane. Enable via `sessionLocation.enabled: true` in config
- **Config caching** — config loaded once at SessionStart, cached in session state. All 5 hooks read cached config, preventing mid-session hot-reload races
- **Incremental SessionStart writes** — 4-stage atomic writes (detecting → method → JSONL path → location). Crash at any stage leaves valid partial config
- **JSONL most-recent-by-timestamp** — tail-read now collects ALL assistant entries and returns highest timestamp, preventing stale cache segment readings
- **Burst detection windowed** — `recentAgentTimestamps` reset at B markers. Uses `compactPercent × 0.8` (~60%) for early warning during rapid cascades
- **Atomic session config writes** — write-to-tmp + `renameSync` prevents partial writes from concurrent hooks
- **Type-safe InjectionMethod** — `SessionConfig.injectionMethod` typed as `InjectionMethod | 'detecting'` instead of `string`
- **Mtime-based JSONL resolution** — `resolveJsonlPath` returns most recent match when multiple project hash directories contain the same session
- **Version bump script** — `scripts/bump-version.sh` updates all 3 version-bearing files atomically

### Fixed
- Burst detection was dead code — used same threshold as `shouldCompact()`, making the OR'd path unreachable. Now uses `compactPercent × 0.8`
- `recentAgentTimestamps` populated from entire log, not windowed after last B marker — caused false burst detection
- JSONL tail-read returned first assistant entry found, not most recent by timestamp — cache segments caused stale readings (183K instead of 5K)
- SessionStart failure before writing config left all downstream hooks without state — now writes minimal config immediately
- Config hot-reload race — each hook independently loaded config, causing non-deterministic behaviour mid-session
- `resolveJsonlPath` returned first match instead of most recent by mtime — old killed sessions could interfere

### Changed
- Context pressure thresholds use percentages (0–1) instead of absolute token counts — model-agnostic
- Legacy `compactThreshold`/`denyThreshold` auto-converted to percentages by `validateConfig()`
- `SessionConfig.injectionMethod` properly typed (was `string`, now `InjectionMethod | 'detecting'`)

## [0.3.0] — 2025-02-07

### Added
- **Context guard** (defence-in-depth) — dual-layer protection: `/compact` injection at 76% pressure, agent throttling at 85%
- **JSONL tail-read** — reads real token counts from CC session JSONL (primary pressure source)
- **Fallback pressure** — chars/4 estimation scaled by `responseRatio` when JSONL unavailable
- **PreToolUse hook** — denies `Task` calls when context pressure exceeds `denyPercent`
- **PreCompact hook** — resets activity window, injects summary into compaction context
- **Burst detection** — emergency compaction on 5+ agent returns in 10 seconds
- **osascript frontmost check** — prevents keystrokes landing in wrong application

### Changed
- Thresholds migrated from absolute tokens to percentage-based (model-agnostic)

## [0.2.0] — 2025-02-06

### Added
- **Session repair tool** — offline JSONL surgery for dead sessions
- **Extract session tool** — JSONL preprocessor for Gemini analysis
- **`/tav` skill** — repair, list, summarize, analyze commands
- SubagentStop hook — evaluates ALL thresholds during agent cascades (Stop never fires during cascades)

## [0.1.0] — 2025-02-05

### Added
- Initial release
- PostToolUse/Stop hook pipeline for bookmark injection
- tmux/screen/osascript injection fallback chain
- UserPromptSubmit hook to intercept synthetic bookmark messages
- Configurable thresholds with deep-merge defaults
- Append-only activity log (POSIX-atomic writes)
- Three-layer feedback loop prevention
