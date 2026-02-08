import { describe, test, expect } from 'bun:test'
import { extractSession } from '../src/extract-session'
import type { ExtractOptions } from '../src/extract-session'

const defaults: ExtractOptions = { maxChars: 500000, toolUseMaxChars: 200 }

function line(entry: Record<string, unknown>): string {
  return JSON.stringify(entry)
}

describe('extractSession', () => {
  test('filters progress entries', () => {
    const lines = [
      line({ type: 'user', message: { role: 'user', content: 'hello' } }),
      line({ type: 'progress', status: 'running' }),
      line({ type: 'progress', status: 'done' }),
      line({ type: 'assistant', message: { role: 'assistant', content: 'hi' } }),
    ]
    const result = extractSession(lines, defaults)

    expect(result.totalEntries).toBe(4)
    expect(result.keptEntries).toBe(2)
    expect(result.discardedEntries).toBe(2)
    expect(result.output).toContain('hello')
    expect(result.output).toContain('hi')
    expect(result.output).not.toContain('running')
  })

  test('filters file-history-snapshot entries', () => {
    const lines = [
      line({ type: 'user', message: { role: 'user', content: 'test' } }),
      line({ type: 'file-history-snapshot', files: ['/a.ts'] }),
    ]
    const result = extractSession(lines, defaults)

    expect(result.totalEntries).toBe(2)
    expect(result.keptEntries).toBe(1)
    expect(result.discardedEntries).toBe(1)
  })

  test('keeps user and assistant entries', () => {
    const lines = [
      line({ type: 'user', message: { role: 'user', content: 'What is 2+2?' } }),
      line({ type: 'assistant', message: { role: 'assistant', content: 'The answer is 4.' } }),
    ]
    const result = extractSession(lines, defaults)

    expect(result.keptEntries).toBe(2)
    expect(result.output).toContain('What is 2+2?')
    expect(result.output).toContain('The answer is 4.')
  })

  test('includes timestamps in output', () => {
    const lines = [
      line({ type: 'assistant', timestamp: '2025-01-15T10:30:00Z', message: { role: 'assistant', content: 'done' } }),
    ]
    const result = extractSession(lines, defaults)
    expect(result.output).toContain('2025-01-15T10:30:00Z')
  })

  test('includes token usage in output', () => {
    const lines = [
      line({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: 'result',
          usage: { input_tokens: 100, cache_creation_input_tokens: 500, cache_read_input_tokens: 9400, output_tokens: 200 }
        }
      }),
    ]
    const result = extractSession(lines, defaults)
    // 100 + 500 + 9400 = 10000
    expect(result.output).toContain('ctx:10000')
    expect(result.output).toContain('out:200')
  })

  test('truncates tool_use content blocks', () => {
    const longInput = 'x'.repeat(500)
    const lines = [
      line({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Let me read.' },
            { type: 'tool_use', name: 'Read', input: { path: longInput } }
          ]
        }
      }),
    ]
    const result = extractSession(lines, { maxChars: 500000, toolUseMaxChars: 50 })

    expect(result.output).toContain('**Tool: Read**')
    expect(result.output).toContain('...')
    // The full 500-char input should NOT appear
    expect(result.output).not.toContain(longInput)
  })

  test('truncates tool_result content', () => {
    const longResult = 'y'.repeat(500)
    const lines = [
      line({
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', content: longResult }
          ]
        }
      }),
    ]
    const result = extractSession(lines, { maxChars: 500000, toolUseMaxChars: 100 })

    expect(result.output).toContain('**Result:**')
    expect(result.output).toContain('...')
    expect(result.output).not.toContain(longResult)
  })

  test('respects maxChars limit', () => {
    const lines = Array.from({ length: 100 }, (_, i) =>
      line({ type: 'user', message: { role: 'user', content: `Message ${i}: ${'a'.repeat(200)}` } })
    )
    const result = extractSession(lines, { maxChars: 2000, toolUseMaxChars: 200 })

    expect(result.truncated).toBe(true)
    expect(result.output).toContain('truncated')
    expect(result.keptEntries).toBeLessThan(100)
    // Output should be near maxChars (accounting for truncation marker overhead)
    expect(result.output.length).toBeLessThanOrEqual(2200)
  })

  test('handles empty input', () => {
    const result = extractSession([], defaults)
    expect(result.totalEntries).toBe(0)
    expect(result.keptEntries).toBe(0)
    expect(result.output).toBe('')
    expect(result.truncated).toBe(false)
  })

  test('skips entries without message', () => {
    const lines = [
      line({ type: 'user', message: { role: 'user', content: 'kept' } }),
      line({ type: 'assistant' }), // no message field
      line({ type: 'user', noMessage: true }),
    ]
    const result = extractSession(lines, defaults)

    // 3 total entries parsed, but only 1 has a message (after noise filter)
    expect(result.totalEntries).toBe(3)
    expect(result.keptEntries).toBe(1)
    expect(result.output).toContain('kept')
  })

  test('skips malformed JSON lines gracefully', () => {
    const lines = [
      line({ type: 'user', message: { role: 'user', content: 'valid' } }),
      '{broken json',
      line({ type: 'assistant', message: { role: 'assistant', content: 'also valid' } }),
    ]
    const result = extractSession(lines, defaults)

    expect(result.totalEntries).toBe(2) // broken line skipped entirely
    expect(result.keptEntries).toBe(2)
    expect(result.output).toContain('valid')
    expect(result.output).toContain('also valid')
  })

  test('handles string content directly', () => {
    const lines = [
      line({ type: 'user', message: { role: 'user', content: 'plain string content' } }),
    ]
    const result = extractSession(lines, defaults)
    expect(result.output).toContain('plain string content')
  })

  test('handles structured content blocks with text', () => {
    const lines = [
      line({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Here is the result.' },
            { type: 'text', text: 'And more text.' }
          ]
        }
      }),
    ]
    const result = extractSession(lines, defaults)
    expect(result.output).toContain('Here is the result.')
    expect(result.output).toContain('And more text.')
  })

  test('handles nested tool_result content blocks', () => {
    const lines = [
      line({
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', content: [{ type: 'text', text: 'nested text' }] }
          ]
        }
      }),
    ]
    const result = extractSession(lines, defaults)
    expect(result.output).toContain('nested text')
  })

  test('does not truncate when within maxChars', () => {
    const lines = [
      line({ type: 'user', message: { role: 'user', content: 'short' } }),
    ]
    const result = extractSession(lines, { maxChars: 500000, toolUseMaxChars: 200 })
    expect(result.truncated).toBe(false)
  })

  test('formats role header correctly', () => {
    const lines = [
      line({ type: 'user', message: { role: 'user', content: 'test' } }),
      line({ type: 'assistant', message: { role: 'assistant', content: 'reply' } }),
    ]
    const result = extractSession(lines, defaults)
    expect(result.output).toContain('### user')
    expect(result.output).toContain('### assistant')
  })
})
