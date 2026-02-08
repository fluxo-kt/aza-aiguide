import { appendFileSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import type { ThresholdConfig } from './config'

const DEFAULT_STATE_DIR = join(homedir(), '.claude', 'tav', 'state')

export interface LogMetrics {
  toolCalls: number
  agentReturns: number
  estimatedTokens: number
  elapsedSeconds: number
  lastInjectionAt: number
  lastBookmarkAt: number
  lastLineIsBookmark: boolean
}

export function sanitizeSessionId(sessionId: string): string {
  // Truncate to 200 chars to prevent ENAMETOOLONG (255 limit minus .json/.log suffix)
  return sessionId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 200)
}

export function getLogPath(sessionId: string, stateDir: string = DEFAULT_STATE_DIR): string {
  return join(stateDir, `${sanitizeSessionId(sessionId)}.log`)
}

export function ensureStateDir(stateDir: string = DEFAULT_STATE_DIR): void {
  mkdirSync(stateDir, { recursive: true })
}

export function appendEvent(sessionId: string, line: string, stateDir: string = DEFAULT_STATE_DIR): void {
  ensureStateDir(stateDir)
  appendFileSync(getLogPath(sessionId, stateDir), `${line}\n`)
}

export function parseLog(sessionId: string, stateDir: string = DEFAULT_STATE_DIR): LogMetrics {
  const logPath = getLogPath(sessionId, stateDir)

  let content: string
  try {
    content = readFileSync(logPath, 'utf-8')
  } catch {
    return {
      toolCalls: 0,
      agentReturns: 0,
      estimatedTokens: 0,
      elapsedSeconds: 0,
      lastInjectionAt: 0,
      lastBookmarkAt: 0,
      lastLineIsBookmark: false
    }
  }

  const lines = content.split('\n').filter(l => l.trim())

  // Find last bookmark index
  let lastBookmarkIdx = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith('B ')) {
      lastBookmarkIdx = i
      break
    }
  }

  // Only count lines after last bookmark
  const relevantLines = lastBookmarkIdx === -1
    ? lines
    : lines.slice(lastBookmarkIdx + 1)

  let toolCalls = 0
  let agentReturns = 0
  let totalCharCount = 0
  let firstTimestamp = 0
  let lastTimestamp = 0
  let lastInjectionAt = 0
  let lastBookmarkAt = 0

  // Parse all lines for lastInjectionAt and lastBookmarkAt
  for (const line of lines) {
    const parts = line.split(' ')
    const type = parts[0]
    const timestamp = parseInt(parts[1], 10)
    if (isNaN(timestamp)) continue

    if (type === 'I') {
      lastInjectionAt = Math.max(lastInjectionAt, timestamp)
    } else if (type === 'B') {
      lastBookmarkAt = Math.max(lastBookmarkAt, timestamp)
    }
  }

  // Parse relevant lines for metrics
  for (const line of relevantLines) {
    const parts = line.split(' ')
    const type = parts[0]
    const timestamp = parseInt(parts[1], 10)
    if (isNaN(timestamp)) continue
    const rawCharCount = parts[2] ? parseInt(parts[2], 10) : 0
    const charCount = isNaN(rawCharCount) ? 0 : rawCharCount

    if (type === 'T') {
      toolCalls++
      totalCharCount += charCount
      if (firstTimestamp === 0) firstTimestamp = timestamp
      lastTimestamp = Math.max(lastTimestamp, timestamp)
    } else if (type === 'A') {
      agentReturns++
      totalCharCount += charCount
      if (firstTimestamp === 0) firstTimestamp = timestamp
      lastTimestamp = Math.max(lastTimestamp, timestamp)
    }
  }

  const estimatedTokens = Math.floor(totalCharCount / 4)
  // Activity span — not wall-clock time. Using lastTimestamp instead of
  // Date.now() prevents false triggers after idle periods (e.g. lunch break)
  const elapsedSeconds = firstTimestamp > 0 && lastTimestamp > firstTimestamp
    ? Math.floor((lastTimestamp - firstTimestamp) / 1000)
    : 0

  const lastLineIsBookmark = lines.length > 0 && lines[lines.length - 1].startsWith('B ')

  return {
    toolCalls,
    agentReturns,
    estimatedTokens,
    elapsedSeconds,
    lastInjectionAt,
    lastBookmarkAt,
    lastLineIsBookmark
  }
}

/**
 * Single source of truth for threshold evaluation.
 * Returns whether ANY threshold is met and which one triggered.
 * Used by both Stop hook (evaluateBookmark) and SubagentStop hook (handleSubagentStop).
 */
export function meetsAnyThreshold(
  metrics: LogMetrics,
  thresholds: ThresholdConfig
): { met: boolean; reason: string } {
  if (metrics.estimatedTokens >= thresholds.minTokens) {
    return { met: true, reason: `token threshold met (${metrics.estimatedTokens} >= ${thresholds.minTokens})` }
  }
  if (metrics.toolCalls >= thresholds.minToolCalls) {
    return { met: true, reason: `tool call threshold met (${metrics.toolCalls} >= ${thresholds.minToolCalls})` }
  }
  if (metrics.elapsedSeconds >= thresholds.minSeconds) {
    return { met: true, reason: `time threshold met (${metrics.elapsedSeconds} >= ${thresholds.minSeconds})` }
  }
  if (metrics.agentReturns >= thresholds.agentBurstThreshold) {
    return { met: true, reason: `agent burst threshold met (${metrics.agentReturns} >= ${thresholds.agentBurstThreshold})` }
  }
  return { met: false, reason: 'no threshold met' }
}

export function cleanOldSessions(maxAgeDays: number = 7, stateDir: string = DEFAULT_STATE_DIR): void {
  try {
    const files = readdirSync(stateDir)
    const cutoffTime = Date.now() - (maxAgeDays * 24 * 60 * 60 * 1000)

    for (const file of files) {
      if (!file.endsWith('.log') && !file.endsWith('.json')) continue

      const filePath = join(stateDir, file)
      try {
        const stats = statSync(filePath)
        if (stats.mtimeMs < cutoffTime) {
          unlinkSync(filePath)
        }
      } catch {
        // Silently ignore errors
      }
    }
  } catch {
    // Silently ignore errors
  }
}
