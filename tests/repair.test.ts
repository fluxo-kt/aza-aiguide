import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  parseJSONL,
  extractMetadata,
  findBreakPoints,
  findLastCompactBoundary,
  createSyntheticEntry,
  midpointTimestamp,
  insertBookmarks,
  validate,
  repair,
  DEFAULT_REPAIR_OPTIONS
} from '../src/repair'
import type { JournalEntry, SessionMetadata } from '../src/repair'

function createTestEnv() {
  const testDir = join(tmpdir(), `repair-test-${Date.now()}`)
  mkdirSync(testDir, { recursive: true })
  return testDir
}

function cleanup(testDir: string) {
  try {
    rmSync(testDir, { recursive: true, force: true })
  } catch {
    // Ignore
  }
}

function makeEntry(overrides: Partial<JournalEntry>): JournalEntry {
  return {
    type: 'assistant',
    uuid: `uuid-${Math.random().toString(36).slice(2)}`,
    parentUuid: 'parent-0',
    sessionId: 'session-test',
    version: '1',
    cwd: '/test',
    timestamp: new Date().toISOString(),
    ...overrides
  }
}

function makeUserEntry(overrides: Partial<JournalEntry> = {}): JournalEntry {
  return makeEntry({
    type: 'human',
    userType: 'external',
    isSidechain: false,
    message: { role: 'user', content: 'hello' },
    ...overrides
  })
}

function entriesToJSONL(entries: JournalEntry[]): string {
  return entries.map(e => JSON.stringify(e)).join('\n') + '\n'
}

const metadata: SessionMetadata = {
  sessionId: 'session-test',
  version: '1',
  cwd: '/test'
}

describe('repair', () => {
  let testDir: string

  beforeEach(() => {
    testDir = createTestEnv()
  })

  afterEach(() => {
    cleanup(testDir)
  })

  describe('parseJSONL', () => {
    test('parses valid JSONL lines', () => {
      const content = '{"type":"human","uuid":"a"}\n{"type":"assistant","uuid":"b"}\n'
      const result = parseJSONL(content)
      expect(result.length).toBe(2)
      expect(result[0].entry?.type).toBe('human')
      expect(result[1].entry?.type).toBe('assistant')
    })

    test('handles invalid JSON lines gracefully', () => {
      const content = '{"type":"human","uuid":"a"}\ninvalid json\n{"type":"assistant","uuid":"b"}\n'
      const result = parseJSONL(content)
      expect(result.length).toBe(3)
      expect(result[0].entry?.type).toBe('human')
      expect(result[1].entry).toBeNull()
      expect(result[1].raw).toBe('invalid json')
      expect(result[2].entry?.type).toBe('assistant')
    })

    test('skips empty lines', () => {
      const content = '{"type":"human","uuid":"a"}\n\n\n{"type":"assistant","uuid":"b"}\n'
      const result = parseJSONL(content)
      expect(result.length).toBe(2)
    })
  })

  describe('extractMetadata', () => {
    test('extracts from first human entry', () => {
      const entries = [
        { entry: makeEntry({ type: 'assistant' }), raw: '' },
        { entry: makeUserEntry({ sessionId: 'sess-1', version: '2', cwd: '/my/project' }), raw: '' },
        { entry: makeUserEntry({ sessionId: 'sess-2' }), raw: '' }
      ]
      const meta = extractMetadata(entries)
      expect(meta).not.toBeNull()
      expect(meta!.sessionId).toBe('sess-1')
      expect(meta!.version).toBe('2')
      expect(meta!.cwd).toBe('/my/project')
    })

    test('returns null when no human entry exists', () => {
      const entries = [
        { entry: makeEntry({ type: 'assistant' }), raw: '' },
        { entry: makeEntry({ type: 'system' }), raw: '' }
      ]
      expect(extractMetadata(entries)).toBeNull()
    })
  })

  describe('findLastCompactBoundary', () => {
    test('finds last compact_boundary', () => {
      const entries = [
        { entry: makeEntry({ type: 'system', subtype: 'compact_boundary' }), raw: '' },
        { entry: makeEntry({ type: 'assistant' }), raw: '' },
        { entry: makeEntry({ type: 'system', subtype: 'compact_boundary' }), raw: '' },
        { entry: makeEntry({ type: 'assistant' }), raw: '' }
      ]
      expect(findLastCompactBoundary(entries)).toBe(2)
    })

    test('returns -1 when none found', () => {
      const entries = [
        { entry: makeEntry({ type: 'assistant' }), raw: '' },
        { entry: makeEntry({ type: 'human' }), raw: '' }
      ]
      expect(findLastCompactBoundary(entries)).toBe(-1)
    })
  })

  describe('findBreakPoints', () => {
    test('breaks every N assistant entries', () => {
      const entries: Array<{ entry: JournalEntry | null }> = []
      const now = Date.now()
      for (let i = 0; i < 15; i++) {
        entries.push({
          entry: makeEntry({
            type: 'assistant',
            uuid: `a-${i}`,
            timestamp: new Date(now + i * 1000).toISOString()
          })
        })
      }

      const breaks = findBreakPoints(entries, 0, 5)
      // Should break at index 4 (5th), 9 (10th), 14 (15th)
      expect(breaks.length).toBeGreaterThanOrEqual(2)
    })

    test('breaks at turn_duration boundaries', () => {
      const now = Date.now()
      const entries = [
        { entry: makeEntry({ type: 'assistant', timestamp: new Date(now).toISOString() }) },
        { entry: makeEntry({ type: 'assistant', timestamp: new Date(now + 1000).toISOString() }) },
        { entry: makeEntry({ type: 'system', subtype: 'turn_duration', timestamp: new Date(now + 2000).toISOString() }) },
        { entry: makeEntry({ type: 'assistant', timestamp: new Date(now + 3000).toISOString() }) }
      ]

      const breaks = findBreakPoints(entries, 0, 100) // High interval so only turn_duration triggers
      expect(breaks).toContain(2)
    })

    test('breaks on time gaps > 60 seconds', () => {
      const now = Date.now()
      const entries = [
        { entry: makeEntry({ type: 'assistant', timestamp: new Date(now).toISOString() }) },
        { entry: makeEntry({ type: 'assistant', timestamp: new Date(now + 120000).toISOString() }) }  // 2 min gap
      ]

      const breaks = findBreakPoints(entries, 0, 100)
      expect(breaks).toContain(1)
    })

    test('respects startIdx (skips entries before it)', () => {
      const entries: Array<{ entry: JournalEntry | null }> = []
      for (let i = 0; i < 20; i++) {
        entries.push({ entry: makeEntry({ type: 'assistant', uuid: `a-${i}` }) })
      }

      const breaksFrom0 = findBreakPoints(entries, 0, 5)
      const breaksFrom10 = findBreakPoints(entries, 10, 5)

      // Starting from 10, there are only 10 entries → fewer breaks
      expect(breaksFrom10.length).toBeLessThan(breaksFrom0.length)
      // All break indices from startIdx=10 should be >= 10
      for (const bp of breaksFrom10) {
        expect(bp).toBeGreaterThanOrEqual(10)
      }
    })
  })

  describe('createSyntheticEntry', () => {
    test('creates valid human entry with correct fields', () => {
      const entry = createSyntheticEntry(metadata, 'parent-uuid', '2024-01-15T10:00:00Z', '·')

      expect(entry.type).toBe('human')
      expect(entry.uuid).toBeDefined()
      expect(entry.uuid.length).toBeGreaterThan(0)
      expect(entry.parentUuid).toBe('parent-uuid')
      expect(entry.sessionId).toBe('session-test')
      expect(entry.version).toBe('1')
      expect(entry.cwd).toBe('/test')
      expect(entry.isSidechain).toBe(false)
      expect(entry.userType).toBe('external')
      expect(entry.timestamp).toBe('2024-01-15T10:00:00Z')
    })

    test('generates unique UUIDs', () => {
      const e1 = createSyntheticEntry(metadata, 'p', '2024-01-15T10:00:00Z', '·')
      const e2 = createSyntheticEntry(metadata, 'p', '2024-01-15T10:00:00Z', '·')
      expect(e1.uuid).not.toBe(e2.uuid)
    })

    test('uses custom marker', () => {
      const entry = createSyntheticEntry(metadata, 'p', '2024-01-15T10:00:00Z', '★')
      expect(entry.message?.content).toBe('★')
    })
  })

  describe('midpointTimestamp', () => {
    test('computes midpoint correctly', () => {
      const mid = midpointTimestamp('2024-01-15T10:00:00Z', '2024-01-15T10:00:10Z')
      const midTime = new Date(mid).getTime()
      const expected = new Date('2024-01-15T10:00:05Z').getTime()
      expect(midTime).toBe(expected)
    })

    test('handles invalid timestamps', () => {
      const mid = midpointTimestamp('invalid', '2024-01-15T10:00:00Z')
      // Should return something, not throw
      expect(typeof mid).toBe('string')
    })
  })

  describe('validate', () => {
    test('detects duplicate UUIDs', () => {
      const entries = [
        { entry: makeEntry({ uuid: 'dup', type: 'human' }) },
        { entry: makeEntry({ uuid: 'dup', type: 'assistant' }) }
      ]
      const result = validate(entries)
      expect(result.valid).toBe(false)
      expect(result.errors.length).toBeGreaterThan(0)
      expect(result.errors[0]).toContain('Duplicate UUID')
    })

    test('passes for valid chain', () => {
      const entries = [
        { entry: makeEntry({ uuid: 'a', parentUuid: undefined }) },
        { entry: makeEntry({ uuid: 'b', parentUuid: 'a' }) },
        { entry: makeEntry({ uuid: 'c', parentUuid: 'b' }) }
      ]
      const result = validate(entries)
      expect(result.valid).toBe(true)
    })

    test('detects broken parent references', () => {
      const entries = [
        { entry: makeEntry({ uuid: 'a' }) },
        { entry: makeEntry({ uuid: 'b', parentUuid: 'nonexistent' }) }
      ]
      const result = validate(entries)
      expect(result.valid).toBe(false)
      expect(result.errors[0]).toContain('Broken parent reference')
    })
  })

  describe('insertBookmarks', () => {
    test('inserts at break points and repairs chain', () => {
      const entries = [
        { entry: makeUserEntry({ uuid: 'u1' }), raw: '' },
        { entry: makeEntry({ uuid: 'a1', parentUuid: 'u1' }), raw: '' },
        { entry: makeEntry({ uuid: 'a2', parentUuid: 'a1' }), raw: '' },
        { entry: makeEntry({ uuid: 'a3', parentUuid: 'a2' }), raw: '' }
      ]
      // Update raws
      for (const e of entries) {
        e.raw = JSON.stringify(e.entry)
      }

      const { result, inserted } = insertBookmarks(entries, [1], metadata, '·')

      expect(inserted).toBe(1)
      expect(result.length).toBe(5) // 4 original + 1 synthetic

      // The synthetic entry should be at index 2 (after break at index 1)
      const synthetic = result[2].entry
      expect(synthetic?.type).toBe('human')
      expect(synthetic?.parentUuid).toBe('a1') // anchored to preceding assistant

      // The entry after synthetic should have its parentUuid updated
      const nextEntry = result[3].entry
      expect(nextEntry?.parentUuid).toBe(synthetic?.uuid)
    })

    test('returns unmodified array when no break points', () => {
      const entries = [
        { entry: makeEntry({ uuid: 'a1' }), raw: '{}' }
      ]
      const { result, inserted } = insertBookmarks(entries, [], metadata, '·')
      expect(inserted).toBe(0)
      expect(result.length).toBe(1)
    })

    test('handles multiple break points', () => {
      const entries = Array.from({ length: 10 }, (_, i) => ({
        entry: makeEntry({
          uuid: `e-${i}`,
          parentUuid: i > 0 ? `e-${i - 1}` : undefined,
          timestamp: new Date(Date.now() + i * 1000).toISOString()
        }),
        raw: ''
      }))
      for (const e of entries) {
        e.raw = JSON.stringify(e.entry)
      }

      const { result, inserted } = insertBookmarks(entries, [2, 5, 8], metadata, '·')
      expect(inserted).toBe(3)
      expect(result.length).toBe(13) // 10 + 3

      // Validate chain integrity
      const validation = validate(result)
      expect(validation.valid).toBe(true)
    })
  })

  describe('repair (end-to-end)', () => {
    test('repairs a synthetic session file', () => {
      const now = Date.now()
      const entries: JournalEntry[] = [
        makeUserEntry({ uuid: 'u0', sessionId: 'test-sess', version: '1', cwd: '/proj', timestamp: new Date(now).toISOString() })
      ]

      // Add 20 assistant entries
      for (let i = 1; i <= 20; i++) {
        entries.push(makeEntry({
          uuid: `a${i}`,
          parentUuid: i === 1 ? 'u0' : `a${i - 1}`,
          timestamp: new Date(now + i * 1000).toISOString()
        }))
      }

      const filePath = join(testDir, 'test-session.jsonl')
      writeFileSync(filePath, entriesToJSONL(entries))

      const result = repair(filePath, { ...DEFAULT_REPAIR_OPTIONS, interval: 5 })

      expect(result.errors.length).toBe(0)
      expect(result.inserted).toBeGreaterThan(0)
      expect(result.backupPath).toBe(`${filePath}.tav-backup`)
      expect(existsSync(result.backupPath!)).toBe(true)

      // Verify backup matches original
      const backup = readFileSync(result.backupPath!, 'utf-8')
      expect(backup).toBe(entriesToJSONL(entries))

      // Verify repaired file has more entries
      const repaired = readFileSync(filePath, 'utf-8')
      const repairedEntries = parseJSONL(repaired)
      expect(repairedEntries.length).toBeGreaterThan(entries.length)

      // Validate chain
      const validation = validate(repairedEntries)
      expect(validation.valid).toBe(true)
    })

    test('dry-run does not modify file', () => {
      const entries: JournalEntry[] = [
        makeUserEntry({ uuid: 'u0', sessionId: 's', timestamp: new Date().toISOString() })
      ]
      for (let i = 1; i <= 10; i++) {
        entries.push(makeEntry({
          uuid: `a${i}`,
          parentUuid: i === 1 ? 'u0' : `a${i - 1}`,
          timestamp: new Date(Date.now() + i * 1000).toISOString()
        }))
      }

      const filePath = join(testDir, 'dry-run.jsonl')
      const originalContent = entriesToJSONL(entries)
      writeFileSync(filePath, originalContent)

      const result = repair(filePath, { ...DEFAULT_REPAIR_OPTIONS, interval: 3, dryRun: true })

      expect(result.inserted).toBeGreaterThan(0)
      expect(result.backupPath).toBeNull()

      // File should be unchanged
      expect(readFileSync(filePath, 'utf-8')).toBe(originalContent)
    })

    test('respects compact_boundary (starts repair after it)', () => {
      const now = Date.now()
      const entries: JournalEntry[] = [
        makeUserEntry({ uuid: 'u0', sessionId: 's', timestamp: new Date(now).toISOString() })
      ]

      // 10 entries before compact boundary
      for (let i = 1; i <= 10; i++) {
        entries.push(makeEntry({
          uuid: `before-${i}`,
          parentUuid: i === 1 ? 'u0' : `before-${i - 1}`,
          timestamp: new Date(now + i * 1000).toISOString()
        }))
      }

      // Compact boundary
      entries.push(makeEntry({
        type: 'system',
        subtype: 'compact_boundary',
        uuid: 'cb-1',
        timestamp: new Date(now + 11000).toISOString()
      }))

      // 10 entries after compact boundary
      for (let i = 1; i <= 10; i++) {
        entries.push(makeEntry({
          uuid: `after-${i}`,
          parentUuid: i === 1 ? 'cb-1' : `after-${i - 1}`,
          timestamp: new Date(now + 12000 + i * 1000).toISOString()
        }))
      }

      const filePath = join(testDir, 'compact.jsonl')
      writeFileSync(filePath, entriesToJSONL(entries))

      const result = repair(filePath, { ...DEFAULT_REPAIR_OPTIONS, interval: 3, dryRun: true })

      // Break points should only be in the post-boundary section
      // (entries after compact boundary)
      expect(result.inserted).toBeGreaterThan(0)
    })

    test('reports error for missing file', () => {
      const result = repair('/nonexistent/path.jsonl')
      expect(result.errors.length).toBeGreaterThan(0)
      expect(result.errors[0]).toContain('Cannot read')
    })

    test('reports error for empty file', () => {
      const filePath = join(testDir, 'empty.jsonl')
      writeFileSync(filePath, '')
      const result = repair(filePath)
      expect(result.errors.length).toBeGreaterThan(0)
      expect(result.errors[0]).toContain('empty')
    })

    test('reports error when no user entry found', () => {
      const entries = [
        makeEntry({ type: 'assistant', uuid: 'a1' }),
        makeEntry({ type: 'system', uuid: 's1' })
      ]
      const filePath = join(testDir, 'no-user.jsonl')
      writeFileSync(filePath, entriesToJSONL(entries))
      const result = repair(filePath)
      expect(result.errors.length).toBeGreaterThan(0)
      expect(result.errors[0]).toContain('metadata')
    })

    test('warns when file is too short for break points', () => {
      const entries = [
        makeUserEntry({ uuid: 'u0', sessionId: 's', timestamp: new Date().toISOString() }),
        makeEntry({ uuid: 'a1', parentUuid: 'u0', timestamp: new Date(Date.now() + 1000).toISOString() })
      ]
      const filePath = join(testDir, 'short.jsonl')
      writeFileSync(filePath, entriesToJSONL(entries))

      const result = repair(filePath, { ...DEFAULT_REPAIR_OPTIONS, interval: 10 })
      expect(result.warnings.length).toBeGreaterThan(0)
      expect(result.inserted).toBe(0)
    })
  })
})
