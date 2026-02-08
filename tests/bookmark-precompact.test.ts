import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, rmSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { processPreCompact } from '../src/bookmark-precompact'
import { sanitizeSessionId } from '../src/lib/log'

const TEST_SESSION_ID = 'precompact-test-123'

function createTestEnv() {
  const testDir = join(tmpdir(), `precompact-test-${Date.now()}`)
  const logDir = join(testDir, 'logs')
  mkdirSync(logDir, { recursive: true })
  return { testDir, logDir }
}

function cleanup(testDir: string) {
  try {
    rmSync(testDir, { recursive: true, force: true })
  } catch {
    // Ignore cleanup errors
  }
}

function getLogPath(sessionId: string, logDir: string): string {
  return join(logDir, `${sanitizeSessionId(sessionId)}.log`)
}

function readLog(sessionId: string, logDir: string): string {
  const path = getLogPath(sessionId, logDir)
  try {
    return readFileSync(path, 'utf-8')
  } catch {
    return ''
  }
}

describe('bookmark-precompact', () => {
  let testDir: string
  let logDir: string

  beforeEach(() => {
    const env = createTestEnv()
    testDir = env.testDir
    logDir = env.logDir
  })

  afterEach(() => {
    cleanup(testDir)
  })

  test('appends B marker to activity log', () => {
    // Pre-populate with some activity
    const logPath = getLogPath(TEST_SESSION_ID, logDir)
    const now = Date.now()
    writeFileSync(logPath, `T ${now - 5000} 1000\nA ${now - 3000} 500\n`)

    processPreCompact(TEST_SESSION_ID, logDir)

    const log = readLog(TEST_SESSION_ID, logDir)
    const lines = log.trim().split('\n')
    const lastLine = lines[lines.length - 1]
    expect(lastLine).toMatch(/^B \d+$/)
  })

  test('returns continue:true', () => {
    const result = processPreCompact(TEST_SESSION_ID, logDir)
    expect(result.continue).toBe(true)
  })

  test('returns additionalContext with PreCompact hookEventName', () => {
    const result = processPreCompact(TEST_SESSION_ID, logDir)
    expect(result.hookSpecificOutput).toBeDefined()
    expect(result.hookSpecificOutput!.hookEventName).toBe('PreCompact')
  })

  test('additionalContext includes cumulative token count', () => {
    // Pre-populate with known activity
    const logPath = getLogPath(TEST_SESSION_ID, logDir)
    const now = Date.now()
    writeFileSync(logPath, `T ${now - 5000} 4000\nT ${now - 3000} 4000\n`)
    // 8000 chars / 4 = 2000 tokens

    const result = processPreCompact(TEST_SESSION_ID, logDir)
    expect(result.hookSpecificOutput!.additionalContext).toContain('2000')
  })

  test('additionalContext includes tool call count', () => {
    const logPath = getLogPath(TEST_SESSION_ID, logDir)
    const now = Date.now()
    let logContent = ''
    for (let i = 0; i < 7; i++) {
      logContent += `T ${now - 5000 + i * 100} 100\n`
    }
    writeFileSync(logPath, logContent)

    const result = processPreCompact(TEST_SESSION_ID, logDir)
    expect(result.hookSpecificOutput!.additionalContext).toContain('7 tool calls')
  })

  test('additionalContext includes agent return count', () => {
    const logPath = getLogPath(TEST_SESSION_ID, logDir)
    const now = Date.now()
    writeFileSync(logPath, `A ${now - 5000} 100\nA ${now - 3000} 200\nA ${now - 1000} 300\n`)

    const result = processPreCompact(TEST_SESSION_ID, logDir)
    expect(result.hookSpecificOutput!.additionalContext).toContain('3 agent returns')
  })

  test('B marker resets window for subsequent metrics', () => {
    // Pre-populate with activity, then PreCompact
    const logPath = getLogPath(TEST_SESSION_ID, logDir)
    const now = Date.now()
    let logContent = ''
    for (let i = 0; i < 20; i++) {
      logContent += `T ${now - 60000 + i * 1000} 1000\n`
    }
    writeFileSync(logPath, logContent)

    processPreCompact(TEST_SESSION_ID, logDir)

    // Read log and verify B is there
    const log = readLog(TEST_SESSION_ID, logDir)
    const bLines = log.trim().split('\n').filter(l => l.startsWith('B '))
    expect(bLines.length).toBe(1)
  })

  test('works with empty log', () => {
    const result = processPreCompact(TEST_SESSION_ID, logDir)
    expect(result.continue).toBe(true)
    expect(result.hookSpecificOutput).toBeDefined()

    // B marker should be created even for empty log
    const log = readLog(TEST_SESSION_ID, logDir)
    expect(log.trim()).toMatch(/^B \d+$/)
  })

  test('additionalContext mentions tav plugin', () => {
    const result = processPreCompact(TEST_SESSION_ID, logDir)
    expect(result.hookSpecificOutput!.additionalContext).toContain('tav')
  })
})
