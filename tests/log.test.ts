import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync, utimesSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  sanitizeSessionId,
  appendEvent,
  parseLog,
  cleanOldSessions,
  meetsAnyThreshold
} from '../src/lib/log'
import type { LogMetrics } from '../src/lib/log'
import type { ThresholdConfig } from '../src/lib/config'

describe('log', () => {
  let testDir: string

  beforeEach(() => {
    testDir = join(tmpdir(), `tav-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(testDir, { recursive: true })
  })

  afterEach(() => {
    try {
      rmSync(testDir, { recursive: true, force: true })
    } catch {
      // Ignore cleanup errors
    }
  })

  test('sanitizeSessionId replaces invalid chars', () => {
    expect(sanitizeSessionId('abc-123_def')).toBe('abc-123_def')
    expect(sanitizeSessionId('abc/123\\def')).toBe('abc_123_def')
    expect(sanitizeSessionId('abc.123:def')).toBe('abc_123_def')
    expect(sanitizeSessionId('abc@123#def')).toBe('abc_123_def')
    expect(sanitizeSessionId('hello world!')).toBe('hello_world_')
  })

  test('sanitizeSessionId truncates to 200 chars', () => {
    const long = 'a'.repeat(250)
    expect(sanitizeSessionId(long).length).toBe(200)
    // Exactly 200 chars should not be truncated
    expect(sanitizeSessionId('b'.repeat(200)).length).toBe(200)
    // 199 chars should remain 199
    expect(sanitizeSessionId('c'.repeat(199)).length).toBe(199)
  })

  test('appendEvent creates file and appends lines', () => {
    const sessionId = 'test-session'

    appendEvent(sessionId, 'T 1000 100', testDir)
    appendEvent(sessionId, 'A 2000 200', testDir)
    appendEvent(sessionId, 'I 3000', testDir)

    const metrics = parseLog(sessionId, testDir)
    expect(metrics.toolCalls).toBe(1)
    expect(metrics.agentReturns).toBe(1)
    expect(metrics.lastInjectionAt).toBe(3000)
  })

  test('parseLog returns zero metrics for missing file', () => {
    const metrics = parseLog('nonexistent-session', testDir)

    expect(metrics.toolCalls).toBe(0)
    expect(metrics.agentReturns).toBe(0)
    expect(metrics.estimatedTokens).toBe(0)
    expect(metrics.elapsedSeconds).toBe(0)
    expect(metrics.lastInjectionAt).toBe(0)
    expect(metrics.lastBookmarkAt).toBe(0)
    expect(metrics.lastLineIsBookmark).toBe(false)
  })

  test('parseLog counts T and A lines correctly', () => {
    const sessionId = 'count-test'

    appendEvent(sessionId, 'T 1000 100', testDir)
    appendEvent(sessionId, 'T 2000 150', testDir)
    appendEvent(sessionId, 'A 3000 200', testDir)
    appendEvent(sessionId, 'T 4000 120', testDir)
    appendEvent(sessionId, 'A 5000 180', testDir)

    const metrics = parseLog(sessionId, testDir)
    expect(metrics.toolCalls).toBe(3)
    expect(metrics.agentReturns).toBe(2)
  })

  test('parseLog resets counters after B line', () => {
    const sessionId = 'bookmark-test'

    appendEvent(sessionId, 'T 1000 100', testDir)
    appendEvent(sessionId, 'A 2000 200', testDir)
    appendEvent(sessionId, 'B 3000', testDir)
    appendEvent(sessionId, 'T 4000 150', testDir)
    appendEvent(sessionId, 'T 5000 120', testDir)

    const metrics = parseLog(sessionId, testDir)
    // Only count lines after bookmark
    expect(metrics.toolCalls).toBe(2)
    expect(metrics.agentReturns).toBe(0)
  })

  test('parseLog calculates estimatedTokens from charCounts', () => {
    const sessionId = 'tokens-test'

    appendEvent(sessionId, 'T 1000 400', testDir)  // 100 tokens
    appendEvent(sessionId, 'A 2000 800', testDir)  // 200 tokens
    appendEvent(sessionId, 'T 3000 200', testDir)  // 50 tokens

    const metrics = parseLog(sessionId, testDir)
    expect(metrics.estimatedTokens).toBe(350)  // (400 + 800 + 200) / 4
  })

  test('parseLog calculates elapsedSeconds as activity span (not wall-clock)', () => {
    const sessionId = 'elapsed-test'
    const baseTime = 1000000

    appendEvent(sessionId, `T ${baseTime} 100`, testDir)
    appendEvent(sessionId, `A ${baseTime + 5000} 200`, testDir)

    const metrics = parseLog(sessionId, testDir)
    // elapsedSeconds = lastTimestamp - firstTimestamp (activity span)
    // Not Date.now() - firstTimestamp (wall-clock) — avoids false triggers after idle
    expect(metrics.elapsedSeconds).toBe(5)
  })

  test('parseLog elapsedSeconds is zero with single event (no span)', () => {
    const sessionId = 'single-event-test'

    appendEvent(sessionId, `T ${Date.now()} 100`, testDir)

    const metrics = parseLog(sessionId, testDir)
    // Single event has no span — first === last
    expect(metrics.elapsedSeconds).toBe(0)
  })

  test('parseLog tracks lastInjectionAt and lastBookmarkAt', () => {
    const sessionId = 'tracking-test'

    appendEvent(sessionId, 'I 1000', testDir)
    appendEvent(sessionId, 'T 2000 100', testDir)
    appendEvent(sessionId, 'I 3000', testDir)
    appendEvent(sessionId, 'B 4000', testDir)
    appendEvent(sessionId, 'I 5000', testDir)
    appendEvent(sessionId, 'B 6000', testDir)

    const metrics = parseLog(sessionId, testDir)
    expect(metrics.lastInjectionAt).toBe(5000)
    expect(metrics.lastBookmarkAt).toBe(6000)
  })

  test('parseLog detects lastLineIsBookmark', () => {
    const sessionId = 'last-line-test'

    appendEvent(sessionId, 'T 1000 100', testDir)
    appendEvent(sessionId, 'A 2000 200', testDir)

    let metrics = parseLog(sessionId, testDir)
    expect(metrics.lastLineIsBookmark).toBe(false)

    appendEvent(sessionId, 'B 3000', testDir)

    metrics = parseLog(sessionId, testDir)
    expect(metrics.lastLineIsBookmark).toBe(true)
  })

  test('parseLog tracks cumulativeEstimatedTokens since last compaction', () => {
    const sessionId = 'cumulative-test'

    appendEvent(sessionId, 'T 1000 400', testDir)   // 100 tokens
    appendEvent(sessionId, 'A 2000 800', testDir)   // 200 tokens
    appendEvent(sessionId, 'B 3000', testDir)        // bookmark resets window
    appendEvent(sessionId, 'T 4000 200', testDir)   // 50 tokens
    appendEvent(sessionId, 'A 5000 600', testDir)   // 150 tokens

    const metrics = parseLog(sessionId, testDir)
    // estimatedTokens only counts after last bookmark: (200 + 600) / 4 = 200
    expect(metrics.estimatedTokens).toBe(200)
    // cumulativeEstimatedTokens counts ALL T/A lines (no C marker): (400 + 800 + 200 + 600) / 4 = 500
    expect(metrics.cumulativeEstimatedTokens).toBe(500)
  })

  test('parseLog resets cumulativeEstimatedTokens after C marker', () => {
    const sessionId = 'cumulative-reset-test'

    appendEvent(sessionId, 'T 1000 4000', testDir)  // 1000 tokens
    appendEvent(sessionId, 'A 2000 8000', testDir)  // 2000 tokens
    appendEvent(sessionId, 'C 3000', testDir)        // compaction — resets cumulative
    appendEvent(sessionId, 'T 4000 400', testDir)   // 100 tokens
    appendEvent(sessionId, 'A 5000 800', testDir)   // 200 tokens

    const metrics = parseLog(sessionId, testDir)
    // Cumulative only counts AFTER last C marker: (400 + 800) / 4 = 300
    // NOT (4000 + 8000 + 400 + 800) / 4 = 3300
    expect(metrics.cumulativeEstimatedTokens).toBe(300)
  })

  test('parseLog cumulative reset handles multiple C markers', () => {
    const sessionId = 'multi-compact-test'

    appendEvent(sessionId, 'T 1000 10000', testDir)  // before first C
    appendEvent(sessionId, 'C 2000', testDir)
    appendEvent(sessionId, 'T 3000 4000', testDir)   // between C markers
    appendEvent(sessionId, 'C 4000', testDir)          // second C — this is the reset point
    appendEvent(sessionId, 'T 5000 800', testDir)    // after last C: 200 tokens

    const metrics = parseLog(sessionId, testDir)
    // Only chars after LAST C marker: 800 / 4 = 200
    expect(metrics.cumulativeEstimatedTokens).toBe(200)
  })

  test('parseLog tracks lastCompactionAt from C events', () => {
    const sessionId = 'compaction-test'

    appendEvent(sessionId, 'T 1000 100', testDir)
    appendEvent(sessionId, 'C 2000', testDir)
    appendEvent(sessionId, 'T 3000 200', testDir)
    appendEvent(sessionId, 'C 4000', testDir)

    const metrics = parseLog(sessionId, testDir)
    expect(metrics.lastCompactionAt).toBe(4000)
  })

  test('parseLog returns zero for new cumulative fields when log missing', () => {
    const metrics = parseLog('nonexistent', testDir)
    expect(metrics.cumulativeEstimatedTokens).toBe(0)
    expect(metrics.lastCompactionAt).toBe(0)
    expect(metrics.recentAgentTimestamps).toEqual([])
  })

  test('parseLog collects recentAgentTimestamps within 15s window', () => {
    const sessionId = 'recent-agents-test'
    const now = Date.now()

    // Agent returns: 2 recent (within 15s), 1 old (>15s ago)
    appendEvent(sessionId, `A ${now - 20000} 100`, testDir)  // 20s ago — too old
    appendEvent(sessionId, `A ${now - 10000} 200`, testDir)  // 10s ago — recent
    appendEvent(sessionId, `A ${now - 3000} 300`, testDir)   // 3s ago — recent
    appendEvent(sessionId, `T ${now - 1000} 100`, testDir)   // T line — not collected

    const metrics = parseLog(sessionId, testDir)
    // Only the 2 recent A timestamps should be collected
    expect(metrics.recentAgentTimestamps.length).toBe(2)
    expect(metrics.recentAgentTimestamps).toContain(now - 10000)
    expect(metrics.recentAgentTimestamps).toContain(now - 3000)
  })

  test('parseLog skips malformed lines without NaN propagation', () => {
    const sessionId = 'malformed-test'

    // Write a mix of valid and malformed lines
    appendEvent(sessionId, 'T 1000 100', testDir)       // valid
    appendEvent(sessionId, 'T abc 200', testDir)         // malformed timestamp
    appendEvent(sessionId, 'T', testDir)                 // missing timestamp entirely
    appendEvent(sessionId, 'A 2000 xyz', testDir)        // malformed charCount
    appendEvent(sessionId, 'I 3000', testDir)            // valid injection
    appendEvent(sessionId, 'garbage line here', testDir)  // completely malformed

    const metrics = parseLog(sessionId, testDir)
    // Only valid T line counted (malformed ones skipped)
    expect(metrics.toolCalls).toBe(1)
    // A line with malformed charCount still counted (timestamp is valid)
    expect(metrics.agentReturns).toBe(1)
    // charCount: 100 (valid T) + 0 (A with NaN charCount treated as 0) = 100 / 4 = 25
    expect(metrics.estimatedTokens).toBe(25)
    // lastInjectionAt from the valid I line
    expect(metrics.lastInjectionAt).toBe(3000)
    // No NaN in any field
    expect(Number.isFinite(metrics.toolCalls)).toBe(true)
    expect(Number.isFinite(metrics.agentReturns)).toBe(true)
    expect(Number.isFinite(metrics.estimatedTokens)).toBe(true)
    expect(Number.isFinite(metrics.elapsedSeconds)).toBe(true)
    expect(Number.isFinite(metrics.lastInjectionAt)).toBe(true)
    expect(Number.isFinite(metrics.lastBookmarkAt)).toBe(true)
  })

  test('cleanOldSessions removes old files', () => {
    const now = Date.now()
    const oldTime = now - (10 * 24 * 60 * 60 * 1000)  // 10 days ago

    // Create old log file
    const oldLogPath = join(testDir, 'old-session.log')
    writeFileSync(oldLogPath, 'T 1000 100\n')
    utimesSync(oldLogPath, new Date(oldTime), new Date(oldTime))

    // Create old json file
    const oldJsonPath = join(testDir, 'old-session.json')
    writeFileSync(oldJsonPath, '{}')
    utimesSync(oldJsonPath, new Date(oldTime), new Date(oldTime))

    // Create recent file
    const recentLogPath = join(testDir, 'recent-session.log')
    writeFileSync(recentLogPath, 'T 2000 200\n')

    // Clean with 7 day threshold
    cleanOldSessions(7, testDir)

    // Verify old files removed and recent file kept
    expect(parseLog('old-session', testDir).toolCalls).toBe(0)  // File missing, returns zero metrics
    expect(parseLog('recent-session', testDir).toolCalls).toBe(1)  // File exists
  })

  describe('meetsAnyThreshold', () => {
    const baseMetrics: LogMetrics = {
      toolCalls: 0,
      agentReturns: 0,
      estimatedTokens: 0,
      cumulativeEstimatedTokens: 0,
      elapsedSeconds: 0,
      lastInjectionAt: 0,
      lastBookmarkAt: 0,
      lastCompactionAt: 0,
      lastLineIsBookmark: false,
      recentAgentTimestamps: []
    }

    const thresholds: ThresholdConfig = {
      minTokens: 6000,
      minToolCalls: 15,
      minSeconds: 120,
      agentBurstThreshold: 3,
      cooldownSeconds: 25
    }

    test('returns false when no threshold met', () => {
      const result = meetsAnyThreshold(baseMetrics, thresholds)
      expect(result.met).toBe(false)
      expect(result.reason).toBe('no threshold met')
    })

    test('triggers on token threshold', () => {
      const result = meetsAnyThreshold({ ...baseMetrics, estimatedTokens: 6000 }, thresholds)
      expect(result.met).toBe(true)
      expect(result.reason).toContain('token threshold')
    })

    test('triggers on tool call threshold', () => {
      const result = meetsAnyThreshold({ ...baseMetrics, toolCalls: 15 }, thresholds)
      expect(result.met).toBe(true)
      expect(result.reason).toContain('tool call threshold')
    })

    test('triggers on time threshold', () => {
      const result = meetsAnyThreshold({ ...baseMetrics, elapsedSeconds: 120 }, thresholds)
      expect(result.met).toBe(true)
      expect(result.reason).toContain('time threshold')
    })

    test('triggers on agent burst threshold', () => {
      const result = meetsAnyThreshold({ ...baseMetrics, agentReturns: 3 }, thresholds)
      expect(result.met).toBe(true)
      expect(result.reason).toContain('agent burst threshold')
    })

    test('does not trigger when just below all thresholds', () => {
      const result = meetsAnyThreshold({
        ...baseMetrics,
        estimatedTokens: 5999,
        toolCalls: 14,
        elapsedSeconds: 119,
        agentReturns: 2
      }, thresholds)
      expect(result.met).toBe(false)
    })

    test('token threshold has priority (checked first)', () => {
      const result = meetsAnyThreshold({
        ...baseMetrics,
        estimatedTokens: 6000,
        toolCalls: 15,
        elapsedSeconds: 120,
        agentReturns: 3
      }, thresholds)
      expect(result.met).toBe(true)
      expect(result.reason).toContain('token threshold')
    })
  })
})
