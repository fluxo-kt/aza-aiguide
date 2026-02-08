# tav

Automatic conversation bookmarks for Claude Code.

In long single-prompt sessions, Claude Code only lets you rewind to user messages. With just one initial prompt, there are no intermediate anchor points — if something goes wrong deep into a session, you lose everything back to the start. **tav** solves this by injecting minimal bookmark messages at strategic intervals, creating navigable checkpoints you can rewind to.

## Install

```bash
claude plugin marketplace add fluxo-kt/aza-aiguide && claude plugin install tav@fluxo
```

Then restart Claude Code.

## Requirements

**tmux** (primary) — tav injects bookmarks via `tmux send-keys`. Run Claude Code inside a tmux session.

Fallback chain if tmux is unavailable: GNU Screen > macOS osascript > graceful disable (no bookmarks, no errors).

## How it works

tav uses Claude Code's hook system to track activity and inject bookmarks:

1. **PostToolUse / SubagentStop** — counts tool calls and agent returns in an append-only activity log
2. **Stop** — when Claude finishes a turn, evaluates adaptive thresholds against accumulated activity
3. If any threshold is met, spawns a detached `tmux send-keys` that types a `·` (middle dot) into the terminal after a 1.5s delay
4. **UserPromptSubmit** — intercepts the synthetic message, tells Claude to ignore it via `additionalContext`, and records the bookmark

Each bookmark costs ~50 tokens. In a 200K-token session, 10 bookmarks = 0.25% overhead.

### Thresholds (any one triggers a bookmark)

| Threshold | Default | Description |
|-----------|---------|-------------|
| `minTokens` | 6,000 | Estimated tokens since last bookmark |
| `minToolCalls` | 15 | Tool calls since last bookmark |
| `minSeconds` | 120 | Seconds since first activity after last bookmark |
| `agentBurstThreshold` | 3 | Agent returns without a bookmark (burst protection) |
| `cooldownSeconds` | 25 | Minimum gap between bookmarks |

### Feedback loop prevention

Three independent barriers make infinite loops structurally impossible:

1. **Cooldown** — 25s minimum between injection attempts
2. **Counter reset** — all metrics reset to zero after each bookmark
3. **Bookmark-response skip** — if the last log entry is a bookmark, no new thresholds can fire (no activity happened)

## Configuration

Optional. tav works with sensible defaults out of the box. To customise, create `~/.claude/tav/config.json`:

```json
{
  "bookmarks": {
    "enabled": true,
    "marker": "\u00B7",
    "thresholds": {
      "minTokens": 6000,
      "minToolCalls": 15,
      "minSeconds": 120,
      "agentBurstThreshold": 3,
      "cooldownSeconds": 25
    }
  }
}
```

Partial configs are deep-merged with defaults — only specify what you want to change:

```json
{
  "bookmarks": {
    "thresholds": {
      "minToolCalls": 10,
      "cooldownSeconds": 60
    }
  }
}
```

Set `"enabled": false` to disable bookmarks entirely without uninstalling.

### Context Guard (Defence-in-Depth)

Proactive context protection that prevents session death during parallel agent execution:

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

| Layer | Trigger | Action |
|-------|---------|--------|
| Compaction | Context pressure > 76% | Injects `/compact` via terminal (best-effort) |
| Agent throttling | Context pressure > 85% | Denies new `Task` tool calls (deterministic) |

`contextWindowTokens` must match your model's actual context window (200K for Sonnet, 1M for some models). No auto-detection is possible.

### Session Location Verification (Opt-In)

Prevents keystrokes from landing in the wrong terminal tab/pane. **Disabled by default** — enable only if you run multiple Claude Code sessions in different tabs.

```json
{
  "sessionLocation": {
    "enabled": true
  }
}
```

When enabled, tav captures your terminal location at session start (tmux pane ID, terminal app) and verifies it before each injection. If the location doesn't match (e.g. you switched tabs), injection is silently skipped.

## Terminal Support

| Terminal | Injection | Tab Verification | Notes |
|----------|-----------|-----------------|-------|
| **tmux** | Per-pane (`send-keys`) | N/A (pane-level) | Recommended. No focus required |
| **GNU Screen** | Session-level (`stuff`) | N/A | No per-window targeting |
| **iTerm2** | osascript | Planned | Requires Accessibility permissions |
| **Terminal.app** | osascript | Planned | Requires Accessibility permissions |
| **Warp** | osascript | Not supported | No tab API |
| **Ghostty** | osascript | Not supported | New terminal, API unknown |
| **VS Code** | osascript | Not supported | Electron, no AppleScript tab API |
| **kitty** | osascript | Not supported | No AppleScript support |
| **Alacritty** | osascript | Not supported | No AppleScript support |
| **Hyper** | osascript | Not supported | Electron |

All osascript terminals require macOS Accessibility permissions and terminal focus (frontmost app check).

## Known Issues & Limitations

### osascript Requires Terminal Focus (macOS)

If using osascript injection (fallback when tmux/screen unavailable), bookmarks are only injected when the terminal is the **active foreground application**. If you switch to another app (browser, IDE), injection is silently skipped for security.

**Why:** Without this check, keystrokes could land in the wrong application, potentially triggering unintended actions.

**Workarounds:**
- **Recommended:** Use tmux or screen (no focus requirement)
- Keep terminal window focused during Claude Code sessions
- Manually type `·` (middle dot) if you need a bookmark while terminal is unfocused

**Detection:** SessionStart will show which injection method is active in `~/.claude/tav/state/{sessionId}.json`

## Update

```bash
claude plugin marketplace update fluxo && claude plugin update tav@fluxo
```

## Uninstall

```bash
claude plugin uninstall tav@fluxo
```

## State files

Per-session state is stored in `~/.claude/tav/state/` and auto-cleaned after 7 days. To clean manually:

```bash
rm -rf ~/.claude/tav/state/
```

## Development

```bash
bun install
bun test        # 316 tests
bun run build   # compile dist/ for node fallback
```

Source is TypeScript (`src/`), pre-compiled to JS (`dist/`) for environments without bun. Hooks use a runner pattern: try bun first, fall back to node.

## Licence

MIT
