import { describe, test, expect } from 'bun:test'
import { parseJSONL } from '../src/lib/jsonl-types'
import type { JournalEntry } from '../src/lib/jsonl-types'

describe('parseJSONL', () => {
  test('parses valid JSONL lines', () => {
    const content = [
      JSON.stringify({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'hello' } }),
      JSON.stringify({ type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: 'hi' } }),
    ].join('\n')

    const result = parseJSONL(content)
    expect(result).toHaveLength(2)
    expect(result[0].entry?.type).toBe('user')
    expect(result[0].entry?.uuid).toBe('u1')
    expect(result[1].entry?.type).toBe('assistant')
  })

  test('preserves raw strings for valid entries', () => {
    const line = JSON.stringify({ type: 'user', uuid: 'u1' })
    const result = parseJSONL(line)
    expect(result[0].raw).toBe(line)
  })

  test('preserves malformed JSON as raw with null entry', () => {
    const content = '{"valid": true}\n{broken json\n{"also": "valid"}'
    const result = parseJSONL(content)

    expect(result).toHaveLength(3)
    expect(result[0].entry).not.toBeNull()
    expect(result[1].entry).toBeNull()
    expect(result[1].raw).toBe('{broken json')
    expect(result[2].entry).not.toBeNull()
  })

  test('filters empty lines', () => {
    const content = '{"a":1}\n\n\n{"b":2}\n   \n'
    const result = parseJSONL(content)
    expect(result).toHaveLength(2)
  })

  test('returns empty array for empty string', () => {
    expect(parseJSONL('')).toHaveLength(0)
  })

  test('returns empty array for whitespace-only content', () => {
    expect(parseJSONL('   \n  \n\n  ')).toHaveLength(0)
  })

  test('handles single line without trailing newline', () => {
    const result = parseJSONL('{"type":"user","uuid":"x"}')
    expect(result).toHaveLength(1)
    expect(result[0].entry?.type).toBe('user')
  })

  test('handles entries with all JournalEntry fields', () => {
    const entry = {
      type: 'assistant',
      subtype: 'response',
      uuid: 'abc-123',
      parentUuid: 'parent-456',
      sessionId: 'sess-789',
      version: '1.0',
      cwd: '/home/user',
      message: {
        role: 'assistant',
        content: 'test',
        usage: { input_tokens: 100, cache_creation_input_tokens: 200, cache_read_input_tokens: 300, output_tokens: 50 }
      },
      timestamp: '2025-01-01T00:00:00Z',
      isSidechain: false,
      userType: 'external'
    }
    const result = parseJSONL(JSON.stringify(entry))
    const parsed = result[0].entry as JournalEntry

    expect(parsed.type).toBe('assistant')
    expect(parsed.subtype).toBe('response')
    expect(parsed.uuid).toBe('abc-123')
    expect(parsed.parentUuid).toBe('parent-456')
    expect(parsed.message?.usage?.input_tokens).toBe(100)
    expect(parsed.timestamp).toBe('2025-01-01T00:00:00Z')
  })

  test('handles entries with extra unknown fields via index signature', () => {
    const entry = { type: 'custom', uuid: 'x', customField: 'value', nested: { deep: true } }
    const result = parseJSONL(JSON.stringify(entry))
    const parsed = result[0].entry as JournalEntry

    expect(parsed.type).toBe('custom')
    expect(parsed['customField']).toBe('value')
    expect((parsed['nested'] as Record<string, boolean>).deep).toBe(true)
  })
})
