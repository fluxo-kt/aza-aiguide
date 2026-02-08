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
 * - Discards the first line ONLY when reading from mid-file (chunk boundary
 *   may split a JSON line). When reading the whole file (position=0),
 *   the first line is always complete.
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

    // Always discard last line (may be incomplete from concurrent CC write).
    // Only discard first line when reading from mid-file (position > 0),
    // because the chunk boundary may split a JSON line. When reading the
    // whole file (position === 0), the first line is always complete.
    const startSlice = position > 0 ? 1 : 0
    const minLines = startSlice + 2 // need at least 1 valid line + discarded last
    if (lines.length < minLines) return null

    const validLines = lines.slice(startSlice, -1)

    // Collect ALL assistant entries with timestamps to find the most recent
    const assistantEntries: Array<{ timestamp: number; total: number }> = []

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
        if (total > 0) {
          const timestamp = typeof entry.timestamp === 'number' ? entry.timestamp : 0
          assistantEntries.push({ timestamp, total })
        }
      } catch {
        // Malformed JSON — skip this line, try next
        continue
      }
    }

    // Return entry with highest timestamp (most recent)
    if (assistantEntries.length === 0) return null
    assistantEntries.sort((a, b) => b.timestamp - a.timestamp)
    return assistantEntries[0].total
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
 * Fallback path: cumulativeEstimatedTokens / (contextWindowTokens × responseRatio)
 *
 * The fallback scales by responseRatio because cumulativeEstimatedTokens counts
 * only tool/agent response content (a fraction of full context). responseRatio
 * (default 0.25) estimates that response content is ~25% of the total window.
 * Without this scaling, the fallback would need ~4× more tokens to trigger —
 * e.g. 152K response tokens instead of 38K at compactPercent=0.76.
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

  // Fallback: chars/4 estimation from activity log, scaled by responseRatio.
  // cumulativeEstimatedTokens counts response content only (~25% of total context).
  // Dividing by (windowTokens × responseRatio) converts to full-context pressure.
  if (cumulativeEstimatedTokens > 0) {
    const effectiveWindow = windowTokens * config.responseRatio
    if (effectiveWindow <= 0) return 0
    return Math.min(cumulativeEstimatedTokens / effectiveWindow, 1.0)
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
