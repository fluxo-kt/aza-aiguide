import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync, utimesSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { LogMetrics } from '../src/lib/log'
import {
  sanitizeSessionId,
  appendEvent,
  parseLog,
  cleanOldSessions,
  getLogPath
} from '../src/lib/log'

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

  test('parseLog calculates elapsedSeconds', () => {
    const sessionId = 'elapsed-test'
    const startTime = 1000000
    const endTime = 1005000  // 5 seconds later

    appendEvent(sessionId, `T ${startTime} 100`, testDir)
    appendEvent(sessionId, `A ${endTime} 200`, testDir)

    const metrics = parseLog(sessionId, testDir)
    expect(metrics.elapsedSeconds).toBe(5)
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
})
