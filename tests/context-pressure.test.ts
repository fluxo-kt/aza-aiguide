import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { readLastAssistantUsage, getContextPressure, resolveJsonlPath } from '../src/lib/context-pressure'
import type { ContextGuardConfig } from '../src/lib/config'

const defaultContextGuard: ContextGuardConfig = {
  enabled: true,
  contextWindowTokens: 200000,
  compactPercent: 0.76,
  denyPercent: 0.85,
  compactCooldownSeconds: 120,
  responseRatio: 0.25,
}

describe('readLastAssistantUsage', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = join(tmpdir(), `tav-cp-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(tempDir, { recursive: true })
  })

  afterEach(() => {
    try { rmSync(tempDir, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  test('returns null for missing file', () => {
    expect(readLastAssistantUsage('/nonexistent/file.jsonl')).toBeNull()
  })

  test('returns null for empty file', () => {
    const path = join(tempDir, 'empty.jsonl')
    writeFileSync(path, '')
    expect(readLastAssistantUsage(path)).toBeNull()
  })

  test('reads effective context from last assistant entry', () => {
    const path = join(tempDir, 'session.jsonl')
    const lines = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'hi', usage: { input_tokens: 100, cache_creation_input_tokens: 500, cache_read_input_tokens: 1400, output_tokens: 50 } } }),
      JSON.stringify({ type: 'progress', status: 'running' }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'done', usage: { input_tokens: 200, cache_creation_input_tokens: 1000, cache_read_input_tokens: 160000, output_tokens: 100 } } }),
    ]
    writeFileSync(path, lines.join('\n') + '\n')

    // Should return last assistant entry: 200 + 1000 + 160000 = 161200
    expect(readLastAssistantUsage(path)).toBe(161200)
  })

  test('discards last line for concurrent write safety', () => {
    const path = join(tempDir, 'concurrent.jsonl')
    const completeEntry = JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'ok', usage: { input_tokens: 50, cache_creation_input_tokens: 100, cache_read_input_tokens: 850, output_tokens: 10 } } })
    // Last line is a truncated/partial write
    const lines = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'test' } }),
      completeEntry,
      '{"type":"assistant","message":{"role":"assistant","content":"partial'  // truncated
    ]
    writeFileSync(path, lines.join('\n') + '\n')

    // Should find the complete assistant entry (50 + 100 + 850 = 1000), not the truncated one
    expect(readLastAssistantUsage(path)).toBe(1000)
  })

  test('returns null when no assistant entries exist', () => {
    const path = join(tempDir, 'no-assistant.jsonl')
    const lines = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' } }),
      JSON.stringify({ type: 'progress', status: 'done' }),
    ]
    writeFileSync(path, lines.join('\n') + '\n')
    expect(readLastAssistantUsage(path)).toBeNull()
  })

  test('returns null when assistant entry has no usage', () => {
    const path = join(tempDir, 'no-usage.jsonl')
    const lines = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'test' } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'reply' } }),
    ]
    writeFileSync(path, lines.join('\n') + '\n')
    expect(readLastAssistantUsage(path)).toBeNull()
  })

  test('returns null when usage tokens are all zero', () => {
    const path = join(tempDir, 'zero-tokens.jsonl')
    const lines = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'test' } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'reply', usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 50 } } }),
    ]
    writeFileSync(path, lines.join('\n') + '\n')
    expect(readLastAssistantUsage(path)).toBeNull()
  })

  test('finds assistant entry in whole-file read (first line not discarded)', () => {
    const path = join(tempDir, 'short.jsonl')
    // Single assistant entry — when reading the whole file (position=0),
    // the first line is complete and should NOT be discarded.
    writeFileSync(path, JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 900 } } }) + '\n')
    // position=0 (whole file), first line is kept → finds the entry (100 + 0 + 900 = 1000)
    expect(readLastAssistantUsage(path)).toBe(1000)
  })

  test('returns null for single line without trailing newline', () => {
    const path = join(tempDir, 'no-newline.jsonl')
    // Single line without trailing newline — only 1 element after split,
    // which is both the first and last line. Must discard last line for
    // concurrent write safety, leaving nothing.
    writeFileSync(path, JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 100 } } }))
    expect(readLastAssistantUsage(path)).toBeNull()
  })

  test('ignores non-number token fields gracefully', () => {
    const path = join(tempDir, 'bad-tokens.jsonl')
    const lines = [
      JSON.stringify({ type: 'user', message: { content: 'a' } }),
      JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 'banana', cache_creation_input_tokens: null, cache_read_input_tokens: 5000 } } }),
    ]
    writeFileSync(path, lines.join('\n') + '\n')
    // Only cache_read is a valid number: 0 + 0 + 5000 = 5000
    expect(readLastAssistantUsage(path)).toBe(5000)
  })

  test('returns most recent assistant entry by timestamp, not file order', () => {
    const path = join(tempDir, 'out-of-order.jsonl')
    // File order: entry with timestamp 2000 comes AFTER entry with timestamp 5000
    // The fix ensures we return the one with highest timestamp (5000), not the last in file
    const lines = [
      JSON.stringify({ type: 'user', message: { content: 'hello' } }),
      JSON.stringify({ type: 'assistant', timestamp: 5000, message: { usage: { input_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 49900 } } }),
      JSON.stringify({ type: 'progress', status: 'running' }),
      JSON.stringify({ type: 'assistant', timestamp: 2000, message: { usage: { input_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 950 } } }),
    ]
    writeFileSync(path, lines.join('\n') + '\n')

    // Should return entry with timestamp 5000 (100 + 0 + 49900 = 50000), NOT timestamp 2000 (1000)
    expect(readLastAssistantUsage(path)).toBe(50000)
  })

  test('returns most recent when cache segment creates stale high-token entry', () => {
    const path = join(tempDir, 'cache-segment.jsonl')
    // Simulates cache segment scenario: old entry has inflated tokens (183K),
    // recent entry has low tokens (5K). Must return the recent one.
    const lines = [
      JSON.stringify({ type: 'user', message: { content: 'start' } }),
      JSON.stringify({ type: 'assistant', timestamp: 1000, message: { usage: { input_tokens: 3000, cache_creation_input_tokens: 0, cache_read_input_tokens: 180000 } } }),
      JSON.stringify({ type: 'user', message: { content: 'after compaction' } }),
      JSON.stringify({ type: 'assistant', timestamp: 9000, message: { usage: { input_tokens: 1000, cache_creation_input_tokens: 500, cache_read_input_tokens: 3500 } } }),
    ]
    writeFileSync(path, lines.join('\n') + '\n')

    // Should return 5000 (timestamp 9000), NOT 183000 (timestamp 1000)
    expect(readLastAssistantUsage(path)).toBe(5000)
  })

  test('handles entries without timestamps (defaults to 0)', () => {
    const path = join(tempDir, 'no-timestamp.jsonl')
    const lines = [
      JSON.stringify({ type: 'user', message: { content: 'test' } }),
      JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 900 } } }),
      JSON.stringify({ type: 'assistant', timestamp: 5000, message: { usage: { input_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 1800 } } }),
    ]
    writeFileSync(path, lines.join('\n') + '\n')

    // Entry with timestamp 5000 > default 0, so returns 2000
    expect(readLastAssistantUsage(path)).toBe(2000)
  })

  test('works with small chunkSize', () => {
    const path = join(tempDir, 'small-chunk.jsonl')
    const entry1 = JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 900 } } })
    const entry2 = JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 1800 } } })
    const lines = [
      JSON.stringify({ type: 'user', message: { content: 'hi' } }),
      entry1,
      entry2,
    ]
    writeFileSync(path, lines.join('\n') + '\n')

    // With a very small chunk, we may only see the last entry
    const result = readLastAssistantUsage(path, 512)
    // Should still find at least one assistant entry
    expect(result).toBeGreaterThan(0)
  })
})

describe('getContextPressure', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = join(tmpdir(), `tav-gcp-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(tempDir, { recursive: true })
  })

  afterEach(() => {
    try { rmSync(tempDir, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  test('returns 0 when both sources unavailable', () => {
    expect(getContextPressure(null, 0, defaultContextGuard)).toBe(0)
  })

  test('uses JSONL primary path when available', () => {
    const path = join(tempDir, 'session.jsonl')
    // 100000 tokens out of 200000 = 0.5
    const lines = [
      JSON.stringify({ type: 'user', message: { content: 'test' } }),
      JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 100, cache_creation_input_tokens: 900, cache_read_input_tokens: 99000 } } }),
      '' // trailing newline produces empty string that gets discarded
    ]
    writeFileSync(path, lines.join('\n') + '\n')

    const pressure = getContextPressure(path, 5000, defaultContextGuard)
    // Primary: (100 + 900 + 99000) / 200000 = 100000 / 200000 = 0.5
    expect(pressure).toBe(0.5)
  })

  test('falls back to cumulative estimation scaled by responseRatio', () => {
    const pressure = getContextPressure(null, 12500, defaultContextGuard)
    // Fallback: 12500 / (200000 × 0.25) = 12500 / 50000 = 0.25
    expect(pressure).toBe(0.25)
  })

  test('falls back to cumulative when JSONL path is null', () => {
    const pressure = getContextPressure(null, 25000, defaultContextGuard)
    // 25000 / (200000 × 0.25) = 25000 / 50000 = 0.5
    expect(pressure).toBe(0.5)
  })

  test('clamps pressure to 1.0', () => {
    const path = join(tempDir, 'high.jsonl')
    // 300000 tokens out of 200000 = 1.5, clamped to 1.0
    const lines = [
      JSON.stringify({ type: 'user', message: { content: 'test' } }),
      JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 1000, cache_creation_input_tokens: 99000, cache_read_input_tokens: 200000 } } }),
      ''
    ]
    writeFileSync(path, lines.join('\n') + '\n')

    const pressure = getContextPressure(path, 0, defaultContextGuard)
    expect(pressure).toBe(1.0)
  })

  test('clamps fallback pressure to 1.0', () => {
    // 60000 cumulative / (200000 × 0.25) = 60000 / 50000 = 1.2, clamped to 1.0
    const pressure = getContextPressure(null, 60000, defaultContextGuard)
    expect(pressure).toBe(1.0)
  })

  test('returns 0 when contextWindowTokens is 0', () => {
    const config = { ...defaultContextGuard, contextWindowTokens: 0 }
    expect(getContextPressure(null, 50000, config)).toBe(0)
  })

  test('falls back to cumulative when JSONL file does not exist', () => {
    const pressure = getContextPressure('/nonexistent/path.jsonl', 10000, defaultContextGuard)
    // JSONL fails → fallback: 10000 / (200000 × 0.25) = 10000 / 50000 = 0.2
    expect(pressure).toBe(0.2)
  })

  test('returns 0 when responseRatio is 0 (fallback path)', () => {
    const config = { ...defaultContextGuard, responseRatio: 0 }
    expect(getContextPressure(null, 50000, config)).toBe(0)
  })
})

describe('resolveJsonlPath', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = join(tmpdir(), `tav-rjp-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(join(tempDir, '.claude', 'projects', 'hash1'), { recursive: true })
    mkdirSync(join(tempDir, '.claude', 'projects', 'hash2'), { recursive: true })
  })

  afterEach(() => {
    try { rmSync(tempDir, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  test('finds session JSONL in projects directory', () => {
    const sessionId = 'abc-123-def-456'
    writeFileSync(join(tempDir, '.claude', 'projects', 'hash1', `${sessionId}.jsonl`), '{}')

    const result = resolveJsonlPath(sessionId, tempDir)
    expect(result).toBe(join(tempDir, '.claude', 'projects', 'hash1', `${sessionId}.jsonl`))
  })

  test('returns null when session not found', () => {
    expect(resolveJsonlPath('nonexistent-session', tempDir)).toBeNull()
  })

  test('returns null when projects dir does not exist', () => {
    const noHome = '/tmp/tav-no-home-' + Date.now()
    expect(resolveJsonlPath('any-session', noHome)).toBeNull()
  })
})
