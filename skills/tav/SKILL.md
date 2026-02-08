---
name: tav
description: >
  Session management for tav bookmark plugin. Use when the user says "/tav" followed by a command.
  Commands: repair (fix dead sessions), list (show sessions), summarize (Gemini Flash summary),
  analyze (Gemini Pro deep analysis), status (current session context pressure).
  Triggers: "/tav", "tav repair", "tav list", "tav summarize", "tav analyze", "tav status".
---

# tav Session Management

## Commands

### `/tav list`

List available session JSONL files.

```bash
bun run src/repair.ts list
```

If bun unavailable: `node dist/repair.js list`

### `/tav repair <prefix>`

Repair a dead session by inserting synthetic rewind points.

```bash
bun run src/repair.ts <prefix>
```

Add `--dry-run` to preview without modifying. Add `--interval N` to set break interval (default: 5).

### `/tav status`

Report current session's context pressure. Steps:

1. Read session config: `~/.claude/tav/state/*.json` (find the one matching current session)
2. If `jsonlPath` exists in config, run:
   ```bash
   bun -e "
   const {readLastAssistantUsage} = require('./dist/lib/context-pressure');
   const tokens = readLastAssistantUsage('JSONL_PATH');
   console.log(JSON.stringify({tokens, pressure: tokens ? tokens/200000 : null}));
   "
   ```
3. Read the activity log at `~/.claude/tav/state/{sessionId}.log`
4. Report: context pressure %, cumulative tokens, last bookmark time, injection method

### `/tav summarize <prefix>`

Generate a session summary using Gemini Flash.

1. Resolve session JSONL — search `~/.claude/projects/` AND `~/.claude/transcripts/` for files matching `<prefix>*`
   ```bash
   bun run src/repair.ts list
   ```
   Pick the matching session file path.

2. Extract session content:
   ```bash
   bun run src/extract-session.ts <session.jsonl> --output /tmp/tav-extract.md --max-chars 500000
   ```

3. Create a prompt file at `/tmp/tav-summarize-prompt.md`:
   ```
   Summarize this Claude Code session. Focus on:
   - What was the user trying to accomplish (goals)
   - Key decisions and turning points
   - What was completed vs what remains
   - Problems encountered and how they were resolved
   - Timeline of major phases

   Be concise but thorough. Use bullet points.
   ```

4. Call Gemini Flash:
   ```
   mcp__g__ask_gemini(
     agent_role: "analyst",
     model: "gemini-3-flash-preview",
     prompt_file: "/tmp/tav-summarize-prompt.md",
     files: ["/tmp/tav-extract.md"],
     output_file: "/tmp/tav-summarize-result.md"
   )
   ```

5. Read and present `/tmp/tav-summarize-result.md` to the user.

If Gemini CLI unavailable (check: `which gemini`), fall back to reading the extracted markdown directly and summarizing it yourself.

### `/tav analyze <prefix>`

Deep session analysis using Gemini Pro. Same flow as summarize with these differences:

- Use `--max-chars 800000` for extract (Pro has larger context)
- Model: `gemini-3-pro-preview`
- Prompt file at `/tmp/tav-analyze-prompt.md`:
  ```
  Perform a deep analysis of this Claude Code session. Cover:
  - Goal decomposition: what tasks were attempted, their dependencies
  - Token efficiency: where tokens were spent vs wasted (look at usage data)
  - Agent patterns: subagent spawning frequency, cascade depth
  - Error patterns: recurring failures, recovery strategies
  - Context pressure trajectory: how close to limits did the session get
  - Recommendations: what could be done differently next time

  Include specific evidence (timestamps, token counts, tool names) for each finding.
  ```

- Output: `/tmp/tav-analyze-result.md`

For sessions with >= 5000 entries, always use Pro. For smaller sessions, Flash is sufficient unless the user explicitly requests deep analysis.

## Session Resolution

Sessions are identified by UUID prefix. To resolve a full path from a prefix:

```bash
bun run src/repair.ts list | grep <prefix>
```

Or resolve programmatically — session JSONLs live at:
- `~/.claude/projects/{hash}/{sessionId}.jsonl` (primary)
- `~/.claude/transcripts/{sessionId}.jsonl` (alternative)

## Error Handling

- If `bun` unavailable, use `node dist/` equivalents
- If Gemini CLI unavailable, note this and offer to analyze the extracted content directly
- If session not found, show available sessions via `list` command
