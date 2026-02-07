import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { processBookmark } from '../src/bookmark-submit'
import { appendEvent } from '../src/lib/log'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

describe('processBookmark', () => {
  const marker = '\u00B7'
  const sessionId = 'test-session'
  const now = Date.now()

  test('detects bookmark marker with recent injection', () => {
    const lastInjectionAt = now - 5000 // 5 seconds ago
    const { isBookmark, output } = processBookmark('·', sessionId, marker, lastInjectionAt, now)

    expect(isBookmark).toBe(true)
    expect(output.continue).toBe(true)
  })

  test('returns additionalContext for bookmark', () => {
    const lastInjectionAt = now - 5000
    const { isBookmark, output } = processBookmark('·', sessionId, marker, lastInjectionAt, now)

    expect(isBookmark).toBe(true)
    expect(output.hookSpecificOutput).toBeDefined()
    expect(output.hookSpecificOutput?.hookEventName).toBe('UserPromptSubmit')
    expect(output.hookSpecificOutput?.additionalContext).toContain('system-reminder')
    expect(output.hookSpecificOutput?.additionalContext).toContain('Automated navigation bookmark')
  })

  test('passes through non-marker messages', () => {
    const lastInjectionAt = now - 5000
    const { isBookmark, output } = processBookmark('hello', sessionId, marker, lastInjectionAt, now)

    expect(isBookmark).toBe(false)
    expect(output.continue).toBe(true)
    expect(output.hookSpecificOutput).toBeUndefined()
  })

  test('passes through when marker matches but no recent injection', () => {
    const lastInjectionAt = 0 // No injection ever
    const { isBookmark, output } = processBookmark('·', sessionId, marker, lastInjectionAt, now)

    expect(isBookmark).toBe(false)
    expect(output.continue).toBe(true)
    expect(output.hookSpecificOutput).toBeUndefined()
  })

  test('passes through when injection is too old', () => {
    const lastInjectionAt = now - 15000 // 15 seconds ago (> 10s threshold)
    const { isBookmark, output } = processBookmark('·', sessionId, marker, lastInjectionAt, now)

    expect(isBookmark).toBe(false)
    expect(output.continue).toBe(true)
    expect(output.hookSpecificOutput).toBeUndefined()
  })

  test('handles trimming of marker', () => {
    const lastInjectionAt = now - 5000
    const { isBookmark, output } = processBookmark(' · ', sessionId, marker, lastInjectionAt, now)

    expect(isBookmark).toBe(true)
    expect(output.continue).toBe(true)
  })

  test('returns continue:true in all cases', () => {
    const testCases = [
      { prompt: '·', lastInjectionAt: now - 5000 }, // bookmark
      { prompt: 'hello', lastInjectionAt: now - 5000 }, // not marker
      { prompt: '·', lastInjectionAt: 0 }, // no injection
      { prompt: '·', lastInjectionAt: now - 15000 }, // old injection
    ]

    for (const { prompt, lastInjectionAt } of testCases) {
      const { output } = processBookmark(prompt, sessionId, marker, lastInjectionAt, now)
      expect(output.continue).toBe(true)
    }
  })

  test('uses custom marker from config', () => {
    const customMarker = '###'
    const lastInjectionAt = now - 5000

    const { isBookmark: isBookmark1 } = processBookmark(
      '###',
      sessionId,
      customMarker,
      lastInjectionAt,
      now
    )
    expect(isBookmark1).toBe(true)

    const { isBookmark: isBookmark2 } = processBookmark(
      '·',
      sessionId,
      customMarker,
      lastInjectionAt,
      now
    )
    expect(isBookmark2).toBe(false)
  })
})

describe('bookmark-submit integration', () => {
  let tempDir: string
  let originalLogDir: string | undefined

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bookmark-test-'))
    originalLogDir = process.env.AIGUIDE_LOG_DIR
    process.env.AIGUIDE_LOG_DIR = tempDir
  })

  afterEach(() => {
    if (originalLogDir) {
      process.env.AIGUIDE_LOG_DIR = originalLogDir
    } else {
      delete process.env.AIGUIDE_LOG_DIR
    }
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  test('appends B line to log on bookmark', () => {
    const sessionId = 'integration-test'
    const logPath = path.join(tempDir, `${sessionId}.log`)

    // Simulate recent injection
    const injectionTime = Date.now() - 5000
    appendEvent(sessionId, `I ${injectionTime}`, tempDir)

    // Verify I line exists
    const beforeContent = fs.readFileSync(logPath, 'utf8')
    expect(beforeContent).toContain('I ')

    // Process bookmark
    const marker = '\u00B7'
    const lastInjectionAt = Date.now() - 5000
    const { isBookmark } = processBookmark('·', sessionId, marker, lastInjectionAt)

    expect(isBookmark).toBe(true)

    // Append B line (simulating what main() does)
    appendEvent(sessionId, `B ${Date.now()}`, tempDir)

    // Verify B line exists
    const afterContent = fs.readFileSync(logPath, 'utf8')
    expect(afterContent).toContain('B ')

    const lines = afterContent.trim().split('\n')
    expect(lines.length).toBe(2)
    expect(lines[0]).toMatch(/^I \d+$/)
    expect(lines[1]).toMatch(/^B \d+$/)
  })
})
