import { appendFileSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

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
  return sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')
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
    const charCount = parts[2] ? parseInt(parts[2], 10) : 0

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
  const elapsedSeconds = firstTimestamp > 0
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
