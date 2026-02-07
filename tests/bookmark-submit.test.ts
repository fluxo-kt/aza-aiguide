import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { processBookmark } from '../src/bookmark-submit'
import { appendEvent } from '../src/lib/log'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

describe('processBookmark', () => {
  const marker = '\u00B7'

  test('detects bookmark marker', () => {
    const { isBookmark, output } = processBookmark('·', marker)

    expect(isBookmark).toBe(true)
    expect(output.continue).toBe(true)
  })

  test('returns additionalContext for bookmark', () => {
    const { isBookmark, output } = processBookmark('·', marker)

    expect(isBookmark).toBe(true)
    expect(output.hookSpecificOutput).toBeDefined()
    expect(output.hookSpecificOutput?.hookEventName).toBe('UserPromptSubmit')
    expect(output.hookSpecificOutput?.additionalContext).toContain('system-reminder')
    expect(output.hookSpecificOutput?.additionalContext).toContain('Automated navigation bookmark')
  })

  test('passes through non-marker messages', () => {
    const { isBookmark, output } = processBookmark('hello', marker)

    expect(isBookmark).toBe(false)
    expect(output.continue).toBe(true)
    expect(output.hookSpecificOutput).toBeUndefined()
  })

  test('passes through empty string', () => {
    const { isBookmark, output } = processBookmark('', marker)

    expect(isBookmark).toBe(false)
    expect(output.continue).toBe(true)
    expect(output.hookSpecificOutput).toBeUndefined()
  })

  test('handles trimming of marker', () => {
    const { isBookmark, output } = processBookmark(' · ', marker)

    expect(isBookmark).toBe(true)
    expect(output.continue).toBe(true)
  })

  test('always treats marker as bookmark regardless of timing', () => {
    // Manual bookmarks should work — no anti-collision gating
    const { isBookmark } = processBookmark('·', marker)
    expect(isBookmark).toBe(true)
  })

  test('returns continue:true in all cases', () => {
    const testCases = [
      { prompt: '·' },    // bookmark
      { prompt: 'hello' }, // not marker
      { prompt: '' },      // empty
      { prompt: '··' },    // double marker (not exact match)
    ]

    for (const { prompt } of testCases) {
      const { output } = processBookmark(prompt, marker)
      expect(output.continue).toBe(true)
    }
  })

  test('uses custom marker from config', () => {
    const customMarker = '###'

    const { isBookmark: isBookmark1 } = processBookmark('###', customMarker)
    expect(isBookmark1).toBe(true)

    const { isBookmark: isBookmark2 } = processBookmark('·', customMarker)
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

    // Add some activity first
    appendEvent(sessionId, `T ${Date.now()} 500`, tempDir)

    // Process bookmark
    const marker = '\u00B7'
    const { isBookmark } = processBookmark('·', marker)

    expect(isBookmark).toBe(true)

    // Append B line (simulating what main() does)
    appendEvent(sessionId, `B ${Date.now()}`, tempDir)

    // Verify B line exists
    const afterContent = fs.readFileSync(logPath, 'utf8')
    expect(afterContent).toContain('B ')

    const lines = afterContent.trim().split('\n')
    expect(lines.length).toBe(2)
    expect(lines[0]).toMatch(/^T \d+ \d+$/)
    expect(lines[1]).toMatch(/^B \d+$/)
  })
})
