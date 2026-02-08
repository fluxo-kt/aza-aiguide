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

/**
 * A single entry in a Claude Code session JSONL file.
 * Covers all known entry types: human, assistant, system, progress,
 * file-history-snapshot, and any future additions via index signature.
 */
export interface JournalEntry {
  type: string
  subtype?: string
  uuid: string
  parentUuid?: string
  sessionId?: string
  version?: string
  cwd?: string
  message?: { role: string; content: unknown; usage?: TokenUsage }
  timestamp?: string
  isSidechain?: boolean
  userType?: string
  [key: string]: unknown
}

/**
 * Token usage data found in assistant entry's message.usage.
 * Effective context = input_tokens + cache_creation_input_tokens + cache_read_input_tokens
 */
export interface TokenUsage {
  input_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
  output_tokens?: number
}

/**
 * A parsed JSONL line — either a valid entry or a raw string (malformed JSON).
 * Preserving raw strings enables round-trip fidelity in repair operations.
 */
export interface ParsedLine {
  entry: JournalEntry | null
  raw: string
}

/**
 * Parses a JSONL string into an array of entries.
 * Invalid JSON lines are preserved as raw strings for round-trip fidelity.
 * Empty lines are filtered out.
 */
export function parseJSONL(content: string): ParsedLine[] {
  const lines = content.split('\n')
  return lines
    .filter(line => line.trim())
    .map(raw => {
      try {
        return { entry: JSON.parse(raw) as JournalEntry, raw }
      } catch {
        return { entry: null, raw }
      }
    })
}
