import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs'
import { join } from 'path'
import {
  detectInjectionMethod,
  checkAccessibilityPermission,
  resolveTerminalProcessName,
} from '../src/lib/inject'
import {
  getLogPath,
  sanitizeSessionId,
  cleanOldSessions,
} from '../src/lib/log'

const TEST_STATE_DIR = join(
  process.env.TMPDIR || '/tmp',
  'tav-test-session-start-' + process.pid
)

describe('session-start integration', () => {
  let originalTmux: string | undefined
  let originalTmuxPane: string | undefined
  let originalSty: string | undefined
  let originalTermProgram: string | undefined

  beforeEach(() => {
    originalTmux = process.env.TMUX
    originalTmuxPane = process.env.TMUX_PANE
    originalSty = process.env.STY
    originalTermProgram = process.env.TERM_PROGRAM

    // Clean slate
    if (existsSync(TEST_STATE_DIR)) {
      rmSync(TEST_STATE_DIR, { recursive: true })
    }
    mkdirSync(TEST_STATE_DIR, { recursive: true })
  })

  afterEach(() => {
    if (originalTmux !== undefined) process.env.TMUX = originalTmux
    else delete process.env.TMUX
    if (originalTmuxPane !== undefined) process.env.TMUX_PANE = originalTmuxPane
    else delete process.env.TMUX_PANE
    if (originalSty !== undefined) process.env.STY = originalSty
    else delete process.env.STY
    if (originalTermProgram !== undefined) process.env.TERM_PROGRAM = originalTermProgram
    else delete process.env.TERM_PROGRAM

    if (existsSync(TEST_STATE_DIR)) {
      rmSync(TEST_STATE_DIR, { recursive: true })
    }
  })

  describe('injection method detection at session start', () => {
    test('tmux takes priority over screen and osascript', () => {
      process.env.TMUX = '/tmp/tmux-1000/default,12345,0'
      process.env.TMUX_PANE = '%3'
      process.env.STY = '12345.pts-0.hostname'

      const result = detectInjectionMethod()
      expect(result.method).toBe('tmux')
      expect(result.target).toBe('%3')
    })

    test('screen takes priority over osascript', () => {
      delete process.env.TMUX
      delete process.env.TMUX_PANE
      process.env.STY = '54321.pts-1.hostname'

      const result = detectInjectionMethod()
      expect(result.method).toBe('screen')
      expect(result.target).toBe('54321.pts-1.hostname')
    })

    test('osascript used on darwin when no multiplexer', () => {
      delete process.env.TMUX
      delete process.env.TMUX_PANE
      delete process.env.STY
      process.env.TERM_PROGRAM = 'WarpTerminal'

      const result = detectInjectionMethod()
      if (process.platform === 'darwin') {
        expect(result.method).toBe('osascript')
        expect(result.target).toBe('Warp')
      } else {
        expect(result.method).toBe('disabled')
      }
    })

    test('disabled on non-darwin without multiplexer', () => {
      delete process.env.TMUX
      delete process.env.TMUX_PANE
      delete process.env.STY

      const result = detectInjectionMethod()
      if (process.platform !== 'darwin') {
        expect(result.method).toBe('disabled')
        expect(result.target).toBe('')
      }
    })

    test('invalid TMUX_PANE falls through to next method', () => {
      process.env.TMUX = '/tmp/tmux-1000/default,12345,0'
      process.env.TMUX_PANE = 'invalid'
      delete process.env.STY

      const result = detectInjectionMethod()
      // tmux skipped due to invalid pane, falls through
      if (process.platform === 'darwin') {
        expect(result.method).toBe('osascript')
      } else {
        expect(result.method).toBe('disabled')
      }
    })
  })

  describe('accessibility permission check', () => {
    test('returns boolean without throwing', () => {
      const result = checkAccessibilityPermission()
      expect(typeof result).toBe('boolean')
    })

    test('returns true on non-macOS', () => {
      if (process.platform !== 'darwin') {
        expect(checkAccessibilityPermission()).toBe(true)
      }
    })
  })

  describe('session config file creation', () => {
    test('writes session config JSON to state directory', () => {
      const sessionId = 'test-session-abc123'
      const sanitized = sanitizeSessionId(sessionId)
      const configPath = join(TEST_STATE_DIR, `${sanitized}.json`)

      const sessionConfig = {
        sessionId,
        injectionMethod: 'tmux',
        injectionTarget: '%0',
        startedAt: Date.now(),
      }

      writeFileSync(configPath, JSON.stringify(sessionConfig, null, 2), 'utf-8')

      expect(existsSync(configPath)).toBe(true)
      const content = JSON.parse(readFileSync(configPath, 'utf-8'))
      expect(content.sessionId).toBe(sessionId)
      expect(content.injectionMethod).toBe('tmux')
      expect(content.injectionTarget).toBe('%0')
      expect(content.startedAt).toBeGreaterThan(0)
    })

    test('writes disabledReason when accessibility check fails', () => {
      const sessionId = 'test-disabled-session'
      const sanitized = sanitizeSessionId(sessionId)
      const configPath = join(TEST_STATE_DIR, `${sanitized}.json`)

      const sessionConfig = {
        sessionId,
        injectionMethod: 'disabled',
        injectionTarget: '',
        startedAt: Date.now(),
        disabledReason: 'macOS Accessibility permissions not granted',
      }

      writeFileSync(configPath, JSON.stringify(sessionConfig, null, 2), 'utf-8')

      const content = JSON.parse(readFileSync(configPath, 'utf-8'))
      expect(content.injectionMethod).toBe('disabled')
      expect(content.disabledReason).toBe('macOS Accessibility permissions not granted')
    })
  })

  describe('activity log creation', () => {
    test('creates empty log file for new session', () => {
      const sessionId = 'test-log-session'
      const logPath = getLogPath(sessionId, TEST_STATE_DIR)

      writeFileSync(logPath, '', 'utf-8')

      expect(existsSync(logPath)).toBe(true)
      expect(readFileSync(logPath, 'utf-8')).toBe('')
    })
  })

  describe('session ID sanitisation', () => {
    test('strips unsafe characters from session IDs', () => {
      expect(sanitizeSessionId('abc-123')).toBe('abc-123')
      expect(sanitizeSessionId('abc/def')).toBe('abc_def')
      expect(sanitizeSessionId('../../../etc/passwd')).toBe('_________etc_passwd')
      expect(sanitizeSessionId('session with spaces')).toBe('session_with_spaces')
      expect(sanitizeSessionId('a'.repeat(200))).toBe('a'.repeat(200))
    })

    test('handles UUID-style session IDs', () => {
      const uuid = 'f76c594a-1959-4a0a-89c3-d8d9b45f12b7'
      expect(sanitizeSessionId(uuid)).toBe(uuid)
    })
  })

  describe('old session cleanup', () => {
    test('removes files older than max age', () => {
      const oldFile = join(TEST_STATE_DIR, 'old-session.json')
      const newFile = join(TEST_STATE_DIR, 'new-session.json')

      writeFileSync(oldFile, '{}', 'utf-8')
      writeFileSync(newFile, '{}', 'utf-8')

      // Set old file to 10 days ago
      const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000)
      const { utimesSync } = require('fs')
      utimesSync(oldFile, tenDaysAgo, tenDaysAgo)

      cleanOldSessions(7, TEST_STATE_DIR)

      expect(existsSync(oldFile)).toBe(false)
      expect(existsSync(newFile)).toBe(true)
    })

    test('keeps files within max age', () => {
      const recentFile = join(TEST_STATE_DIR, 'recent-session.log')
      writeFileSync(recentFile, 'T 1234 100\n', 'utf-8')

      cleanOldSessions(7, TEST_STATE_DIR)

      expect(existsSync(recentFile)).toBe(true)
    })

    test('does not throw on empty directory', () => {
      expect(() => {
        cleanOldSessions(7, TEST_STATE_DIR)
      }).not.toThrow()
    })

    test('does not throw on non-existent directory', () => {
      expect(() => {
        cleanOldSessions(7, join(TEST_STATE_DIR, 'nonexistent'))
      }).not.toThrow()
    })
  })

  describe('terminal process name resolution', () => {
    test('maps all supported terminals correctly', () => {
      const cases: [string, string][] = [
        ['WarpTerminal', 'Warp'],
        ['iTerm.app', 'iTerm2'],
        ['Apple_Terminal', 'Terminal'],
        ['ghostty', 'ghostty'],
        ['vscode', 'Code'],
        ['Hyper', 'Hyper'],
        ['Alacritty', 'Alacritty'],
        ['kitty', 'kitty'],
      ]

      for (const [termProgram, expected] of cases) {
        process.env.TERM_PROGRAM = termProgram
        expect(resolveTerminalProcessName()).toBe(expected)
      }
    })

    test('IDE terminals return empty string for graceful fallback', () => {
      process.env.TERM_PROGRAM = 'JetBrains-JediTerm'
      expect(resolveTerminalProcessName()).toBe('')
    })

    test('Claude Code SDK terminal returns empty string', () => {
      // Claude Code SDK may set a custom TERM_PROGRAM;
      // unknown values gracefully fall back to generic osascript.
      process.env.TERM_PROGRAM = 'claude-code-sdk'
      expect(resolveTerminalProcessName()).toBe('')
    })
  })
})
