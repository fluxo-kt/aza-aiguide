import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { handlePostToolUse, handleSubagentStop } from '../src/bookmark-activity'
import { sanitizeSessionId } from '../src/lib/log'

const TEST_SESSION_ID = 'test-session-123'

function createTestEnv() {
  const testDir = join(tmpdir(), `bookmark-test-${Date.now()}`)
  const stateDir = join(testDir, 'state')
  const logDir = join(testDir, 'logs')

  mkdirSync(stateDir, { recursive: true })
  mkdirSync(logDir, { recursive: true })

  return { testDir, stateDir, logDir }
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
  if (!existsSync(path)) {
    return ''
  }
  return readFileSync(path, 'utf-8')
}

function writeSessionConfig(sessionId: string, stateDir: string, config: Record<string, unknown>) {
  const sanitized = sanitizeSessionId(sessionId)
  const path = join(stateDir, `${sanitized}.json`)
  writeFileSync(path, JSON.stringify(config, null, 2))
}

describe('bookmark-activity', () => {
  let testDir: string
  let stateDir: string
  let logDir: string

  beforeEach(() => {
    const env = createTestEnv()
    testDir = env.testDir
    stateDir = env.stateDir
    logDir = env.logDir
  })

  afterEach(() => {
    cleanup(testDir)
  })

  describe('handlePostToolUse', () => {
    test('appends T line with correct format', () => {
      const data = { tool_response: 'test output' }
      handlePostToolUse(TEST_SESSION_ID, data, logDir)

      const log = readLog(TEST_SESSION_ID, logDir)
      const lines = log.trim().split('\n')
      const lastLine = lines[lines.length - 1]

      expect(lastLine).toMatch(/^T \d+ \d+$/)
    })

    test('captures tool_response length', () => {
      const testContent = 'x'.repeat(1234)
      const data = { tool_response: testContent }
      handlePostToolUse(TEST_SESSION_ID, data, logDir)

      const log = readLog(TEST_SESSION_ID, logDir)
      const lines = log.trim().split('\n')
      const lastLine = lines[lines.length - 1]
      const parts = lastLine.split(' ')

      expect(parts[0]).toBe('T')
      expect(parts[2]).toBe('1234')
    })

    test('handles toolResponse variant', () => {
      const data = { toolResponse: 'test' }
      handlePostToolUse(TEST_SESSION_ID, data, logDir)

      const log = readLog(TEST_SESSION_ID, logDir)
      expect(log).toContain('T ')
    })

    test('handles toolOutput variant', () => {
      const data = { toolOutput: 'test' }
      handlePostToolUse(TEST_SESSION_ID, data, logDir)

      const log = readLog(TEST_SESSION_ID, logDir)
      expect(log).toContain('T ')
    })
  })

  describe('handleSubagentStop', () => {
    test('appends A line with correct format', () => {
      writeSessionConfig(TEST_SESSION_ID, stateDir, {
        injectionMethod: 'disabled',
        injectionTarget: ''
      })

      const data = { output: 'agent result' }
      handleSubagentStop(TEST_SESSION_ID, data, logDir, stateDir)

      const log = readLog(TEST_SESSION_ID, logDir)
      const lines = log.trim().split('\n')
      const lastLine = lines[lines.length - 1]

      expect(lastLine).toMatch(/^A \d+ \d+$/)
    })

    test('does not trigger below threshold', () => {
      writeSessionConfig(TEST_SESSION_ID, stateDir, {
        injectionMethod: 'tmux',
        injectionTarget: '%1'
      })

      // Add 2 A lines (threshold is 5)
      const data = { output: 'test' }
      handleSubagentStop(TEST_SESSION_ID, data, logDir, stateDir)
      const result = handleSubagentStop(TEST_SESSION_ID, data, logDir, stateDir)

      expect(result).toBe(false)

      const log = readLog(TEST_SESSION_ID, logDir)
      const lines = log.trim().split('\n')
      const iLines = lines.filter(line => line.startsWith('I '))

      expect(iLines.length).toBe(0)
    })

    test('triggers injection at burst threshold', () => {
      writeSessionConfig(TEST_SESSION_ID, stateDir, {
        injectionMethod: 'tmux',
        injectionTarget: '%1'
      })

      const data = { output: 'test' }

      // Add 4 A lines first
      for (let i = 0; i < 4; i++) {
        handleSubagentStop(TEST_SESSION_ID, data, logDir, stateDir)
      }

      // 5th call should trigger injection (threshold is 5)
      const result = handleSubagentStop(TEST_SESSION_ID, data, logDir, stateDir)

      expect(result).toBe(true)

      const log = readLog(TEST_SESSION_ID, logDir)
      const lines = log.trim().split('\n')
      const iLines = lines.filter(line => line.startsWith('I '))

      expect(iLines.length).toBe(1)
    })

    test('respects cooldown', () => {
      writeSessionConfig(TEST_SESSION_ID, stateDir, {
        injectionMethod: 'tmux',
        injectionTarget: '%1'
      })

      // Manually add an I line within cooldown period (30 seconds default)
      const logPath = getLogPath(TEST_SESSION_ID, logDir)
      const nowMs = Date.now()
      writeFileSync(logPath, `I ${nowMs}\n`)

      const data = { output: 'test' }

      // Add enough A lines to exceed threshold
      for (let i = 0; i < 5; i++) {
        const result = handleSubagentStop(TEST_SESSION_ID, data, logDir, stateDir)
        // Should not trigger because we're within cooldown
        expect(result).toBe(false)
      }

      const log = readLog(TEST_SESSION_ID, logDir)
      const lines = log.trim().split('\n')
      const iLines = lines.filter(line => line.startsWith('I '))

      // Should still be just 1 I line (the one we wrote manually)
      expect(iLines.length).toBe(1)
    })

    test('does not trigger when injection method is disabled', () => {
      writeSessionConfig(TEST_SESSION_ID, stateDir, {
        injectionMethod: 'disabled',
        injectionTarget: ''
      })

      const data = { output: 'test' }

      // Add 5 A lines to exceed threshold
      for (let i = 0; i < 5; i++) {
        handleSubagentStop(TEST_SESSION_ID, data, logDir, stateDir)
      }

      const result = handleSubagentStop(TEST_SESSION_ID, data, logDir, stateDir)

      expect(result).toBe(false)

      const log = readLog(TEST_SESSION_ID, logDir)
      const lines = log.trim().split('\n')
      const iLines = lines.filter(line => line.startsWith('I '))

      expect(iLines.length).toBe(0)
    })

    test('does not trigger when session config missing', () => {
      const data = { output: 'test' }

      // Add 5 A lines to exceed threshold
      for (let i = 0; i < 5; i++) {
        handleSubagentStop(TEST_SESSION_ID, data, logDir, stateDir)
      }

      const result = handleSubagentStop(TEST_SESSION_ID, data, logDir, stateDir)

      expect(result).toBe(false)
    })
  })
})
