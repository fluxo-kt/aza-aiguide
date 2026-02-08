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

    test('handles object tool_response (non-string)', () => {
      const data = { tool_response: { content: 'file contents here' } }
      handlePostToolUse(TEST_SESSION_ID, data, logDir)

      const log = readLog(TEST_SESSION_ID, logDir)
      const lines = log.trim().split('\n')
      const lastLine = lines[lines.length - 1]

      // Should write a numeric charCount, not "undefined"
      expect(lastLine).toMatch(/^T \d+ \d+$/)
      expect(lastLine).not.toContain('undefined')

      const parts = lastLine.split(' ')
      const charCount = parseInt(parts[2], 10)
      // JSON.stringify({content:"file contents here"}).length = 34
      expect(charCount).toBeGreaterThan(0)
    })

    test('handles null/undefined tool_response', () => {
      const data = { tool_response: null }
      handlePostToolUse(TEST_SESSION_ID, data, logDir)

      const log = readLog(TEST_SESSION_ID, logDir)
      const lines = log.trim().split('\n')
      const lastLine = lines[lines.length - 1]

      expect(lastLine).toMatch(/^T \d+ 0$/)
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

      // Add 2 A lines (threshold is 3)
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

      // Add 2 A lines first
      for (let i = 0; i < 2; i++) {
        handleSubagentStop(TEST_SESSION_ID, data, logDir, stateDir)
      }

      // 3rd call should trigger injection (threshold is 3)
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

      // Manually add an I line within cooldown period (25 seconds default)
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

    test('triggers on token threshold via tool results', () => {
      writeSessionConfig(TEST_SESSION_ID, stateDir, {
        injectionMethod: 'tmux',
        injectionTarget: '%1'
      })

      // Pre-populate log with T lines totalling >= 6000 tokens (24000 chars)
      // This simulates a long turn with many tool results but few agent returns
      const logPath = getLogPath(TEST_SESSION_ID, logDir)
      const now = Date.now()
      let logContent = ''
      for (let i = 0; i < 10; i++) {
        logContent += `T ${now - 5000 + i * 100} 2500\n`
      }
      writeFileSync(logPath, logContent)

      // A single SubagentStop should now trigger because tokens >= 6000
      const data = { output: 'x'.repeat(100) }
      const result = handleSubagentStop(TEST_SESSION_ID, data, logDir, stateDir)

      expect(result).toBe(true)

      const log = readLog(TEST_SESSION_ID, logDir)
      const lines = log.trim().split('\n')
      const iLines = lines.filter(line => line.startsWith('I '))
      expect(iLines.length).toBe(1)
    })

    test('triggers on tool call count threshold', () => {
      writeSessionConfig(TEST_SESSION_ID, stateDir, {
        injectionMethod: 'tmux',
        injectionTarget: '%1'
      })

      // Pre-populate log with 15 T lines (>= minToolCalls default of 15)
      const logPath = getLogPath(TEST_SESSION_ID, logDir)
      const now = Date.now()
      let logContent = ''
      for (let i = 0; i < 15; i++) {
        logContent += `T ${now - 5000 + i * 100} 100\n`
      }
      writeFileSync(logPath, logContent)

      // A single SubagentStop should trigger because toolCalls >= 15
      const data = { output: 'test' }
      const result = handleSubagentStop(TEST_SESSION_ID, data, logDir, stateDir)

      expect(result).toBe(true)
    })

    test('does not trigger when bookmarks.enabled is false', () => {
      writeSessionConfig(TEST_SESSION_ID, stateDir, {
        injectionMethod: 'tmux',
        injectionTarget: '%1'
      })

      // Write a config with enabled=false
      const configPath = join(logDir, 'disabled-config.json')
      writeFileSync(configPath, JSON.stringify({
        bookmarks: { enabled: false }
      }))

      // Pre-populate log with enough activity to exceed all thresholds
      const logPath = getLogPath(TEST_SESSION_ID, logDir)
      const now = Date.now()
      let logContent = ''
      for (let i = 0; i < 20; i++) {
        logContent += `T ${now - 200000 + i * 100} 2000\n`
      }
      for (let i = 0; i < 5; i++) {
        logContent += `A ${now - 100000 + i * 100} 1000\n`
      }
      writeFileSync(logPath, logContent)

      // Should NOT trigger despite all thresholds being met
      const data = { output: 'test' }
      const result = handleSubagentStop(TEST_SESSION_ID, data, logDir, stateDir, configPath)

      expect(result).toBe(false)

      const log = readLog(TEST_SESSION_ID, logDir)
      const lines = log.trim().split('\n')
      const iLines = lines.filter(line => line.startsWith('I '))
      expect(iLines.length).toBe(0)
    })

    test('triggers compaction when pressure exceeds compactPercent', () => {
      writeSessionConfig(TEST_SESSION_ID, stateDir, {
        injectionMethod: 'tmux',
        injectionTarget: '%1'
      })

      // Fallback pressure = cumulativeEstimatedTokens / (windowTokens × responseRatio)
      // = cumulativeEstimatedTokens / (200000 × 0.25) = cumulativeEstimatedTokens / 50000
      // Need >= 0.76, so need >= 38000 tokens = 152000 chars
      // Use 250 T lines × 2500 chars = 625000 chars = 156250 tokens (pressure 1.0, clamped)
      const logPath = getLogPath(TEST_SESSION_ID, logDir)
      const now = Date.now()
      let logContent = ''
      for (let i = 0; i < 250; i++) {
        logContent += `T ${now - 5000 + i * 20} 2500\n`
      }
      writeFileSync(logPath, logContent)

      const data = { output: 'test' }
      handleSubagentStop(TEST_SESSION_ID, data, logDir, stateDir)

      const log = readLog(TEST_SESSION_ID, logDir)
      const lines = log.trim().split('\n')
      const cLines = lines.filter(line => line.startsWith('C '))

      expect(cLines.length).toBe(1)
    })

    test('compaction respects its own cooldown', () => {
      writeSessionConfig(TEST_SESSION_ID, stateDir, {
        injectionMethod: 'tmux',
        injectionTarget: '%1'
      })

      // Pre-populate with enough chars + a recent C line (within cooldown)
      // After C marker, fallback pressure = tokens / 50000, need >= 0.76 → >= 38000 tokens
      const logPath = getLogPath(TEST_SESSION_ID, logDir)
      const now = Date.now()
      let logContent = `C ${now - 5000}\n`  // Compaction 5s ago (cooldown is 120s)
      for (let i = 0; i < 250; i++) {
        logContent += `T ${now - 4000 + i * 15} 2500\n`  // 625000 chars after C
      }
      writeFileSync(logPath, logContent)

      const data = { output: 'test' }
      handleSubagentStop(TEST_SESSION_ID, data, logDir, stateDir)

      const log = readLog(TEST_SESSION_ID, logDir)
      const lines = log.trim().split('\n')
      const cLines = lines.filter(line => line.startsWith('C '))

      // Should still have only the original C line — cooldown blocks new compaction
      expect(cLines.length).toBe(1)
    })

    test('compaction does not fire when contextGuard disabled', () => {
      writeSessionConfig(TEST_SESSION_ID, stateDir, {
        injectionMethod: 'tmux',
        injectionTarget: '%1'
      })

      // Write config with contextGuard disabled
      const configPath = join(logDir, 'no-cg-config.json')
      writeFileSync(configPath, JSON.stringify({
        contextGuard: { enabled: false }
      }))

      // Pre-populate with enough chars to exceed compactPercent if guard were enabled
      const logPath = getLogPath(TEST_SESSION_ID, logDir)
      const now = Date.now()
      let logContent = ''
      for (let i = 0; i < 250; i++) {
        logContent += `T ${now - 5000 + i * 20} 2500\n`
      }
      writeFileSync(logPath, logContent)

      const data = { output: 'test' }
      handleSubagentStop(TEST_SESSION_ID, data, logDir, stateDir, configPath)

      const log = readLog(TEST_SESSION_ID, logDir)
      const lines = log.trim().split('\n')
      const cLines = lines.filter(line => line.startsWith('C '))

      expect(cLines.length).toBe(0)
    })

    test('burst compaction respects cooldown (prevents /compact spam)', () => {
      writeSessionConfig(TEST_SESSION_ID, stateDir, {
        injectionMethod: 'tmux',
        injectionTarget: '%1'
      })

      // Pre-populate with a recent C line AND 5+ recent A lines at >60% pressure
      // This creates the burst condition but cooldown should block extra compaction
      const logPath = getLogPath(TEST_SESSION_ID, logDir)
      const now = Date.now()
      let logContent = `C ${now - 30000}\n`  // Compaction 30s ago (cooldown is 120s)
      // 5 recent A lines (burst) with enough chars for >60% fallback pressure
      // Need > 0.60 × 50000 = 30000 tokens = 120000 chars after C
      for (let i = 0; i < 5; i++) {
        logContent += `A ${now - 8000 + i * 1000} 25000\n`  // 125000 chars total
      }
      writeFileSync(logPath, logContent)

      const data = { output: 'test' }
      handleSubagentStop(TEST_SESSION_ID, data, logDir, stateDir)

      const log = readLog(TEST_SESSION_ID, logDir)
      const lines = log.trim().split('\n')
      const cLines = lines.filter(line => line.startsWith('C '))

      // Should still have only the original C line — both shouldCompact AND
      // burstCompact are blocked by cooldown (30s < 120s)
      expect(cLines.length).toBe(1)
    })

    test('burst compaction does not fire when injection disabled', () => {
      writeSessionConfig(TEST_SESSION_ID, stateDir, {
        injectionMethod: 'disabled',
        injectionTarget: ''
      })

      // Pre-populate with 5+ recent A lines at >60% pressure (no recent C)
      const logPath = getLogPath(TEST_SESSION_ID, logDir)
      const now = Date.now()
      let logContent = ''
      for (let i = 0; i < 5; i++) {
        logContent += `A ${now - 8000 + i * 1000} 25000\n`
      }
      writeFileSync(logPath, logContent)

      const data = { output: 'test' }
      handleSubagentStop(TEST_SESSION_ID, data, logDir, stateDir)

      const log = readLog(TEST_SESSION_ID, logDir)
      const lines = log.trim().split('\n')
      const cLines = lines.filter(line => line.startsWith('C '))

      // No compaction — injection is disabled, burstCompact should not fire
      expect(cLines.length).toBe(0)
    })

    test('burst compaction triggers at lower threshold than normal compaction', () => {
      writeSessionConfig(TEST_SESSION_ID, stateDir, {
        injectionMethod: 'tmux',
        injectionTarget: '%1'
      })

      // Burst compaction uses compactPercent × 0.8 = 0.76 × 0.8 = 0.608
      // Normal compaction uses compactPercent = 0.76
      // Need pressure between 0.608 and 0.76 so burst fires but shouldCompact doesn't
      // Fallback pressure = cumulativeTokens / (200000 × 0.25) = cumulativeTokens / 50000
      // For pressure 0.65: need 32500 tokens = 130000 chars
      const logPath = getLogPath(TEST_SESSION_ID, logDir)
      const now = Date.now()
      let logContent = ''
      // 5 recent A lines (burst condition: 5+ in 10s)
      for (let i = 0; i < 5; i++) {
        logContent += `A ${now - 8000 + i * 1000} 26000\n`  // 130000 chars = 32500 tokens → ~65% pressure
      }
      writeFileSync(logPath, logContent)

      const data = { output: 'test' }
      handleSubagentStop(TEST_SESSION_ID, data, logDir, stateDir)

      const log = readLog(TEST_SESSION_ID, logDir)
      const lines = log.trim().split('\n')
      const cLines = lines.filter(line => line.startsWith('C '))

      // Burst should trigger at ~65% (> 60.8% burst threshold)
      // Normal compaction would NOT trigger (65% < 76%)
      expect(cLines.length).toBe(1)
    })

    test('does not inject when injectionMethod is detecting', () => {
      // 'detecting' is the interim state during SessionStart setup
      writeSessionConfig(TEST_SESSION_ID, stateDir, {
        injectionMethod: 'detecting',
        injectionTarget: ''
      })

      const data = { output: 'test' }

      // Add enough A lines to exceed burst threshold
      for (let i = 0; i < 5; i++) {
        handleSubagentStop(TEST_SESSION_ID, data, logDir, stateDir)
      }

      const log = readLog(TEST_SESSION_ID, logDir)
      const lines = log.trim().split('\n')
      const iLines = lines.filter(line => line.startsWith('I '))

      // Should NOT inject — 'detecting' is mapped to 'disabled'
      expect(iLines.length).toBe(0)
    })

    test('does not trigger when last line is bookmark', () => {
      writeSessionConfig(TEST_SESSION_ID, stateDir, {
        injectionMethod: 'tmux',
        injectionTarget: '%1'
      })

      // Pre-populate log with enough activity + a B line at the end
      const logPath = getLogPath(TEST_SESSION_ID, logDir)
      const now = Date.now()
      let logContent = ''
      for (let i = 0; i < 20; i++) {
        logContent += `T ${now - 60000 + i * 100} 2000\n`
      }
      logContent += `B ${now - 100}\n`
      writeFileSync(logPath, logContent)

      // SubagentStop should not trigger — last line is bookmark
      const data = { output: 'test' }
      const result = handleSubagentStop(TEST_SESSION_ID, data, logDir, stateDir)

      // The A line gets appended AFTER the B, so counters reset.
      // With only 1 A line and 0 T lines after B, no threshold is met.
      expect(result).toBe(false)
    })
  })
})
