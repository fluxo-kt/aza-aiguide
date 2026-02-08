"use strict";
/**
 * Shared types and parsing for Claude Code session JSONL files.
 *
 * Session JSONL entry type distribution (from real session analysis):
 *   - progress: ~42.6% (tool execution status — noise)
 *   - user:     ~39.8% (human messages, tool results)
 *   - assistant: ~16.2% (responses, has message.usage)
 *   - file-history-snapshot: ~1% (file tracking — noise)
 *
 * Both repair.ts and extract-session.ts import from here.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseJSONL = parseJSONL;
/**
 * Parses a JSONL string into an array of entries.
 * Invalid JSON lines are preserved as raw strings for round-trip fidelity.
 * Empty lines are filtered out.
 */
function parseJSONL(content) {
    const lines = content.split('\n');
    return lines
        .filter(line => line.trim())
        .map(raw => {
        try {
            return { entry: JSON.parse(raw), raw };
        }
        catch {
            return { entry: null, raw };
        }
    });
}
