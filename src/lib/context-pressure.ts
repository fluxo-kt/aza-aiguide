import { openSync, fstatSync, readSync, closeSync, readdirSync, statSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

import type { ContextGuardConfig } from './config'

/**
 * Reads the last assistant entry's effective token count from a session JSONL.
 *
 * Uses efficient tail-read: reads only the last `chunkSize` bytes,
 * scans backwards for last {"type":"assistant"...} entry with message.usage.
 *
 * Effective context = input_tokens + cache_creation_input_tokens + cache_read_input_tokens
 *
 * Concurrent write safety:
 * - Discards the very last line (may be a partial write from CC appending)
 * - Discards the first line in the chunk (may be truncated mid-JSON)
 *
 * Returns null on any failure (missing file, no assistant entries, parse error).
 */
export function readLastAssistantUsage(jsonlPath: string, chunkSize: number = 65536): number | null {
  let fd: number | null = null
  try {
    fd = openSync(jsonlPath, 'r')
    const stat = fstatSync(fd)
    const fileSize = stat.size

    if (fileSize === 0) return null

    // Read the last chunk (or entire file if smaller than chunkSize)
    const readSize = Math.min(chunkSize, fileSize)
    const position = fileSize - readSize
    const buffer = Buffer.alloc(readSize)
    readSync(fd, buffer, 0, readSize, position)

    const chunk = buffer.toString('utf-8')
    const lines = chunk.split('\n')

    // Discard first line (may be truncated if we started mid-line)
    // Discard last line (may be incomplete from concurrent CC write)
    // Need at least 3 lines for this to produce any valid lines
    if (lines.length < 3) return null

    const validLines = lines.slice(1, -1)

    // Scan backwards for last assistant entry with usage data
    for (let i = validLines.length - 1; i >= 0; i--) {
      const line = validLines[i].trim()
      if (!line) continue

      // Quick pre-check before parsing — avoid parsing non-assistant entries
      if (!line.includes('"type":"assistant"') && !line.includes('"type": "assistant"')) {
        continue
      }

      try {
        const entry = JSON.parse(line)
        if (entry.type !== 'assistant') continue

        const usage = entry.message?.usage
        if (!usage) continue

        const inputTokens = typeof usage.input_tokens === 'number' ? usage.input_tokens : 0
        const cacheCreation = typeof usage.cache_creation_input_tokens === 'number' ? usage.cache_creation_input_tokens : 0
        const cacheRead = typeof usage.cache_read_input_tokens === 'number' ? usage.cache_read_input_tokens : 0

        const total = inputTokens + cacheCreation + cacheRead
        return total > 0 ? total : null
      } catch {
        // Malformed JSON — skip this line, try next
        continue
      }
    }

    return null
  } catch {
    return null
  } finally {
    if (fd !== null) {
      try { closeSync(fd) } catch { /* ignore */ }
    }
  }
}

/**
 * Computes context pressure as a 0–1 ratio.
 *
 * Primary path: real JSONL tokens / contextWindowTokens
 * Fallback path: cumulativeEstimatedTokens (chars/4) / contextWindowTokens
 *
 * The fallback uses raw token estimate against the full window (not scaled by
 * responseRatio) because cumulativeEstimatedTokens already represents response
 * content only, while contextWindowTokens is the total window. The responseRatio
 * field exists for legacy backward-compat conversion only.
 *
 * Returns 0 when both sources are unavailable.
 * Clamped to [0, 1.0] — cache segments can occasionally push effective tokens
 * beyond the nominal context window.
 */
export function getContextPressure(
  jsonlPath: string | null,
  cumulativeEstimatedTokens: number,
  config: ContextGuardConfig
): number {
  const windowTokens = config.contextWindowTokens
  if (windowTokens <= 0) return 0

  // Primary: JSONL real token usage
  if (jsonlPath) {
    const realTokens = readLastAssistantUsage(jsonlPath)
    if (realTokens !== null && realTokens > 0) {
      return Math.min(realTokens / windowTokens, 1.0)
    }
  }

  // Fallback: chars/4 estimation from activity log
  if (cumulativeEstimatedTokens > 0) {
    return Math.min(cumulativeEstimatedTokens / windowTokens, 1.0)
  }

  return 0
}

/**
 * Resolves the JSONL path for a session ID by searching ~/.claude/projects/.
 * Scans all project hash directories for a matching {sessionId}.jsonl file.
 *
 * Called once at SessionStart and cached in SessionConfig.jsonlPath.
 * Returns null if not found (e.g. session just started, no JSONL yet).
 * @param homeOverride Optional home dir override for testing
 */
export function resolveJsonlPath(sessionId: string, homeOverride?: string): string | null {
  const projectsDir = join(homeOverride ?? homedir(), '.claude', 'projects')

  if (!existsSync(projectsDir)) return null

  try {
    const dirs = readdirSync(projectsDir)
    const targetFile = `${sessionId}.jsonl`

    for (const dir of dirs) {
      const dirPath = join(projectsDir, dir)
      try {
        const stat = statSync(dirPath)
        if (!stat.isDirectory()) continue

        const candidate = join(dirPath, targetFile)
        if (existsSync(candidate)) {
          return candidate
        }
      } catch {
        // Skip unreadable directories
      }
    }
  } catch {
    // Projects dir unreadable
  }

  return null
}
