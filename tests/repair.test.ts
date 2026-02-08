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
  buildChain,
  findChainBreakPoints,
  insertChainBookmarks,
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
    type: 'user',
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
      const content = '{"type":"user","uuid":"a"}\n{"type":"assistant","uuid":"b"}\n'
      const result = parseJSONL(content)
      expect(result.length).toBe(2)
      expect(result[0].entry?.type).toBe('user')
      expect(result[1].entry?.type).toBe('assistant')
    })

    test('handles invalid JSON lines gracefully', () => {
      const content = '{"type":"user","uuid":"a"}\ninvalid json\n{"type":"assistant","uuid":"b"}\n'
      const result = parseJSONL(content)
      expect(result.length).toBe(3)
      expect(result[0].entry?.type).toBe('user')
      expect(result[1].entry).toBeNull()
      expect(result[1].raw).toBe('invalid json')
      expect(result[2].entry?.type).toBe('assistant')
    })

    test('skips empty lines', () => {
      const content = '{"type":"user","uuid":"a"}\n\n\n{"type":"assistant","uuid":"b"}\n'
      const result = parseJSONL(content)
      expect(result.length).toBe(2)
    })
  })

  describe('extractMetadata', () => {
    test('extracts from first user entry', () => {
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

    test('returns null when no user entry exists', () => {
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
        { entry: makeEntry({ type: 'user' }), raw: '' }
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
    test('creates valid user entry with correct fields', () => {
      const entry = createSyntheticEntry(metadata, 'parent-uuid', '2024-01-15T10:00:00Z', '·')

      expect(entry.type).toBe('user')
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
        { entry: makeEntry({ uuid: 'dup', type: 'user' }) },
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
      expect(synthetic?.type).toBe('user')
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

  describe('buildChain', () => {
    test('builds linear chain from parentUuid links', () => {
      const entries = [
        { entry: makeUserEntry({ uuid: 'u0', parentUuid: undefined }), raw: '' },
        { entry: makeEntry({ uuid: 'a1', parentUuid: 'u0' }), raw: '' },
        { entry: makeEntry({ uuid: 'a2', parentUuid: 'a1' }), raw: '' },
        { entry: makeEntry({ uuid: 'a3', parentUuid: 'a2' }), raw: '' }
      ]
      const chain = buildChain(entries)
      expect(chain.length).toBe(4)
      expect(chain[0].entry.uuid).toBe('u0')
      expect(chain[1].entry.uuid).toBe('a1')
      expect(chain[2].entry.uuid).toBe('a2')
      expect(chain[3].entry.uuid).toBe('a3')
    })

    test('follows chain even when file order differs from chain order', () => {
      // Simulate sidechains: entries in file order don't match chain order
      const entries = [
        { entry: makeUserEntry({ uuid: 'u0', parentUuid: undefined }), raw: '' },
        { entry: makeEntry({ uuid: 'a1', parentUuid: 'u0' }), raw: '' },
        { entry: makeEntry({ uuid: 'side1', parentUuid: 'a1', isSidechain: true }), raw: '' },  // sidechain
        { entry: makeEntry({ uuid: 'side2', parentUuid: 'side1', isSidechain: true }), raw: '' }, // sidechain
        { entry: makeEntry({ uuid: 'a2', parentUuid: 'a1' }), raw: '' },  // main chain continues
        { entry: makeEntry({ uuid: 'a3', parentUuid: 'a2' }), raw: '' }   // last entry
      ]
      const chain = buildChain(entries)
      // Chain follows last entry (a3) backwards: a3 → a2 → a1 → u0
      // side1 and side2 are NOT on the chain
      expect(chain.length).toBe(4)
      expect(chain.map(c => c.entry.uuid)).toEqual(['u0', 'a1', 'a2', 'a3'])
    })

    test('preserves fileIndex for each chain entry', () => {
      const entries = [
        { entry: makeUserEntry({ uuid: 'u0', parentUuid: undefined }), raw: '' },
        { entry: makeEntry({ uuid: 'noise', parentUuid: 'u0' }), raw: '' },   // index 1
        { entry: makeEntry({ uuid: 'a1', parentUuid: 'u0' }), raw: '' },      // index 2
        { entry: makeEntry({ uuid: 'a2', parentUuid: 'a1' }), raw: '' }       // index 3
      ]
      const chain = buildChain(entries)
      // Chain: u0(0) → a1(2) → a2(3)  — noise(1) not on chain
      expect(chain.length).toBe(3)
      expect(chain[0].fileIndex).toBe(0)
      expect(chain[1].fileIndex).toBe(2)
      expect(chain[2].fileIndex).toBe(3)
    })

    test('returns empty array when no entries have uuid', () => {
      const entries = [
        { entry: null, raw: 'bad json' },
        { entry: null, raw: 'more bad' }
      ]
      expect(buildChain(entries)).toEqual([])
    })

    test('handles single entry', () => {
      const entries = [
        { entry: makeUserEntry({ uuid: 'u0', parentUuid: undefined }), raw: '' }
      ]
      const chain = buildChain(entries)
      expect(chain.length).toBe(1)
      expect(chain[0].entry.uuid).toBe('u0')
    })

    test('handles circular parentUuid without infinite loop', () => {
      const entries = [
        { entry: makeEntry({ uuid: 'a', parentUuid: 'b' }), raw: '' },
        { entry: makeEntry({ uuid: 'b', parentUuid: 'a' }), raw: '' }
      ]
      const chain = buildChain(entries)
      // Should terminate (visited set prevents infinite loop)
      expect(chain.length).toBe(2)
    })
  })

  describe('findChainBreakPoints', () => {
    test('breaks every N assistant entries on chain', () => {
      const now = Date.now()
      const chain = Array.from({ length: 15 }, (_, i) => ({
        entry: makeEntry({
          type: 'assistant',
          uuid: `a-${i}`,
          timestamp: new Date(now + i * 1000).toISOString()
        }),
        fileIndex: i
      }))

      const breaks = findChainBreakPoints(chain, 0, 5)
      expect(breaks.length).toBeGreaterThanOrEqual(2)
      // All break indices should be valid chain indices
      for (const bp of breaks) {
        expect(bp).toBeGreaterThanOrEqual(0)
        expect(bp).toBeLessThan(chain.length)
      }
    })

    test('respects startFileIndex — skips chain entries before it', () => {
      const now = Date.now()
      const chain = Array.from({ length: 20 }, (_, i) => ({
        entry: makeEntry({
          type: 'assistant',
          uuid: `a-${i}`,
          timestamp: new Date(now + i * 1000).toISOString()
        }),
        fileIndex: i
      }))

      const breaksAll = findChainBreakPoints(chain, 0, 5)
      const breaksLate = findChainBreakPoints(chain, 10, 5)
      expect(breaksLate.length).toBeLessThan(breaksAll.length)
    })

    test('detects turn_duration boundaries on chain', () => {
      const now = Date.now()
      const chain = [
        { entry: makeEntry({ type: 'assistant', uuid: 'a1', timestamp: new Date(now).toISOString() }), fileIndex: 0 },
        { entry: makeEntry({ type: 'assistant', uuid: 'a2', timestamp: new Date(now + 1000).toISOString() }), fileIndex: 1 },
        { entry: makeEntry({ type: 'system', subtype: 'turn_duration', uuid: 'td', timestamp: new Date(now + 2000).toISOString() }), fileIndex: 2 },
        { entry: makeEntry({ type: 'assistant', uuid: 'a3', timestamp: new Date(now + 3000).toISOString() }), fileIndex: 3 }
      ]
      const breaks = findChainBreakPoints(chain, 0, 100) // High interval so only turn_duration triggers
      expect(breaks).toContain(2)
    })

    test('detects time gaps > 60 seconds on chain', () => {
      const now = Date.now()
      // Break goes BEFORE the gap (at i-1) so bookmark's child is chain[i]
      // With 2 entries: gap at i=1, break at i-1=0, child=chain[1] (assistant) ✓
      const chain = [
        { entry: makeEntry({ type: 'assistant', uuid: 'a1', timestamp: new Date(now).toISOString() }), fileIndex: 0 },
        { entry: makeEntry({ type: 'assistant', uuid: 'a2', timestamp: new Date(now + 120000).toISOString() }), fileIndex: 1 }
      ]
      const breaks = findChainBreakPoints(chain, 0, 100)
      expect(breaks).toContain(0)
    })

    test('returns empty when chain is too short', () => {
      const chain = [
        { entry: makeEntry({ type: 'assistant', uuid: 'a1' }), fileIndex: 0 }
      ]
      const breaks = findChainBreakPoints(chain, 0, 5)
      expect(breaks).toEqual([])
    })
  })

  describe('insertChainBookmarks', () => {
    test('inserts bookmarks on chain and reparents chain successors', () => {
      const entries = [
        { entry: makeUserEntry({ uuid: 'u0', parentUuid: undefined }), raw: '' },
        { entry: makeEntry({ uuid: 'a1', parentUuid: 'u0' }), raw: '' },
        { entry: makeEntry({ uuid: 'a2', parentUuid: 'a1' }), raw: '' },
        { entry: makeEntry({ uuid: 'a3', parentUuid: 'a2' }), raw: '' },
        { entry: makeEntry({ uuid: 'a4', parentUuid: 'a3' }), raw: '' }
      ]
      for (const e of entries) e.raw = JSON.stringify(e.entry)

      const chain = buildChain(entries)
      // Break at chain index 2 (which is entry a2)
      const { result, inserted } = insertChainBookmarks(entries, chain, [2], metadata, '·')

      expect(inserted).toBe(1)
      expect(result.length).toBe(6) // 5 + 1

      // Find the synthetic
      const synthetics = result.filter(e => e.entry?.message?.content === '·')
      expect(synthetics.length).toBe(1)

      const synthetic = synthetics[0].entry!
      // Synthetic's parent should be the break entry (a2)
      expect(synthetic.parentUuid).toBe('a2')

      // The next-in-chain entry (a3) should now point to the synthetic
      const a3 = result.find(e => e.entry?.uuid === 'a3')
      expect(a3?.entry?.parentUuid).toBe(synthetic.uuid)
    })

    test('handles multiple chain break points', () => {
      const now = Date.now()
      const entries = Array.from({ length: 16 }, (_, i) => ({
        entry: i === 0
          ? makeUserEntry({ uuid: 'e-0', parentUuid: undefined, timestamp: new Date(now).toISOString() })
          : makeEntry({ uuid: `e-${i}`, parentUuid: `e-${i - 1}`, timestamp: new Date(now + i * 1000).toISOString() }),
        raw: ''
      }))
      for (const e of entries) e.raw = JSON.stringify(e.entry)

      const chain = buildChain(entries)
      // Break at chain indices 5, 10
      const { result, inserted } = insertChainBookmarks(entries, chain, [5, 10], metadata, '·')

      expect(inserted).toBe(2)
      expect(result.length).toBe(18)

      // Validate the full chain is intact
      const validation = validate(result)
      expect(validation.valid).toBe(true)

      // Verify ALL synthetics are on the new chain
      const newChain = buildChain(result)
      const syntheticUuids = result
        .filter(e => e.entry?.message?.content === '·')
        .map(e => e.entry!.uuid)
      const chainUuids = new Set(newChain.map(c => c.entry.uuid))
      for (const sid of syntheticUuids) {
        expect(chainUuids.has(sid)).toBe(true)
      }
    })

    test('skips sidechain entries — only reparents chain successors', () => {
      // u0 → a1 → a2 → a3, with side1/side2 branching from a1
      const entries = [
        { entry: makeUserEntry({ uuid: 'u0', parentUuid: undefined }), raw: '' },
        { entry: makeEntry({ uuid: 'a1', parentUuid: 'u0' }), raw: '' },
        { entry: makeEntry({ uuid: 'side1', parentUuid: 'a1' }), raw: '' },
        { entry: makeEntry({ uuid: 'side2', parentUuid: 'side1' }), raw: '' },
        { entry: makeEntry({ uuid: 'a2', parentUuid: 'a1' }), raw: '' },
        { entry: makeEntry({ uuid: 'a3', parentUuid: 'a2' }), raw: '' }
      ]
      for (const e of entries) e.raw = JSON.stringify(e.entry)

      const chain = buildChain(entries)
      // Chain: u0 → a1 → a2 → a3 (side1/side2 excluded)
      expect(chain.length).toBe(4)

      // Break at chain index 1 (a1)
      const { result, inserted } = insertChainBookmarks(entries, chain, [1], metadata, '·')
      expect(inserted).toBe(1)

      // side1 should still point to a1 (NOT reparented)
      const side1 = result.find(e => e.entry?.uuid === 'side1')
      expect(side1?.entry?.parentUuid).toBe('a1')

      // a2 (next in chain) should point to synthetic
      const synthetic = result.find(e => e.entry?.message?.content === '·')!
      const a2 = result.find(e => e.entry?.uuid === 'a2')
      expect(a2?.entry?.parentUuid).toBe(synthetic.entry!.uuid)
    })

    test('returns unmodified when no break points', () => {
      const entries = [
        { entry: makeEntry({ uuid: 'a1' }), raw: '{}' }
      ]
      const chain = buildChain(entries)
      const { result, inserted } = insertChainBookmarks(entries, chain, [], metadata, '·')
      expect(inserted).toBe(0)
      expect(result.length).toBe(1)
    })

    test('all bookmarks appear on rebuilt chain (critical invariant)', () => {
      // This is the core test: after repair, ALL synthetic bookmarks
      // must be reachable from the last entry via parentUuid
      const now = Date.now()
      const entries = Array.from({ length: 21 }, (_, i) => ({
        entry: i === 0
          ? makeUserEntry({ uuid: `e-0`, parentUuid: undefined, sessionId: 'test-sess', timestamp: new Date(now).toISOString() })
          : makeEntry({ uuid: `e-${i}`, parentUuid: `e-${i - 1}`, timestamp: new Date(now + i * 1000).toISOString() }),
        raw: ''
      }))
      for (const e of entries) e.raw = JSON.stringify(e.entry)

      const chain = buildChain(entries)
      const breakPoints = findChainBreakPoints(chain, 0, 5)
      expect(breakPoints.length).toBeGreaterThan(0)

      const { result, inserted } = insertChainBookmarks(entries, chain, breakPoints, metadata, '·')
      // Last break point at chain tail has no successor to reparent — correctly skipped
      expect(inserted).toBeGreaterThan(0)
      expect(inserted).toBeLessThanOrEqual(breakPoints.length)

      // THE KEY CHECK: rebuild chain from result, verify all synthetics are on it
      const newChain = buildChain(result)
      const chainUuids = new Set(newChain.map(c => c.entry.uuid))

      const syntheticEntries = result.filter(e => e.entry?.message?.content === '·')
      expect(syntheticEntries.length).toBe(inserted)

      for (const s of syntheticEntries) {
        expect(chainUuids.has(s.entry!.uuid)).toBe(true)
      }
    })
  })

  describe('repair (chain-aware end-to-end)', () => {
    test('all bookmarks are on the parentUuid chain after repair', () => {
      const now = Date.now()
      const entries: JournalEntry[] = [
        makeUserEntry({ uuid: 'u0', sessionId: 'test-sess', version: '1', cwd: '/proj', timestamp: new Date(now).toISOString() })
      ]

      // Linear chain of 20 assistant entries
      for (let i = 1; i <= 20; i++) {
        entries.push(makeEntry({
          uuid: `a${i}`,
          parentUuid: i === 1 ? 'u0' : `a${i - 1}`,
          timestamp: new Date(now + i * 1000).toISOString()
        }))
      }

      const filePath = join(testDir, 'chain-repair.jsonl')
      writeFileSync(filePath, entriesToJSONL(entries))

      const result = repair(filePath, { ...DEFAULT_REPAIR_OPTIONS, interval: 5 })
      expect(result.errors.length).toBe(0)
      expect(result.inserted).toBeGreaterThan(0)

      // Read repaired file, build chain, verify all bookmarks are on it
      const repaired = readFileSync(filePath, 'utf-8')
      const repairedEntries = parseJSONL(repaired)
      const chain = buildChain(repairedEntries)
      const chainUuids = new Set(chain.map(c => c.entry.uuid))

      const bookmarks = repairedEntries.filter(e => e.entry?.message?.content === '·')
      expect(bookmarks.length).toBe(result.inserted)

      for (const bm of bookmarks) {
        expect(chainUuids.has(bm.entry!.uuid)).toBe(true)
      }
    })

    test('repair with sidechains puts bookmarks on main chain only', () => {
      const now = Date.now()
      const entries: JournalEntry[] = [
        makeUserEntry({ uuid: 'u0', sessionId: 's', version: '1', cwd: '/p', timestamp: new Date(now).toISOString() })
      ]

      // Main chain: u0 → a1 → a2 → ... → a15
      for (let i = 1; i <= 15; i++) {
        entries.push(makeEntry({
          uuid: `a${i}`,
          parentUuid: i === 1 ? 'u0' : `a${i - 1}`,
          timestamp: new Date(now + i * 1000).toISOString()
        }))
      }

      // Sidechains branching from a5 and a10
      for (let i = 1; i <= 3; i++) {
        entries.push(makeEntry({
          uuid: `side-5-${i}`,
          parentUuid: i === 1 ? 'a5' : `side-5-${i - 1}`,
          timestamp: new Date(now + (5 + i) * 500).toISOString(),
          isSidechain: true
        }))
      }
      for (let i = 1; i <= 3; i++) {
        entries.push(makeEntry({
          uuid: `side-10-${i}`,
          parentUuid: i === 1 ? 'a10' : `side-10-${i - 1}`,
          timestamp: new Date(now + (10 + i) * 500).toISOString(),
          isSidechain: true
        }))
      }

      const filePath = join(testDir, 'sidechain-repair.jsonl')
      writeFileSync(filePath, entriesToJSONL(entries))

      const result = repair(filePath, { ...DEFAULT_REPAIR_OPTIONS, interval: 5 })
      expect(result.errors.length).toBe(0)
      expect(result.inserted).toBeGreaterThan(0)

      // Verify bookmarks are on chain
      const repaired = readFileSync(filePath, 'utf-8')
      const repairedEntries = parseJSONL(repaired)
      const chain = buildChain(repairedEntries)
      const chainUuids = new Set(chain.map(c => c.entry.uuid))

      const bookmarks = repairedEntries.filter(e => e.entry?.message?.content === '·')
      for (const bm of bookmarks) {
        expect(chainUuids.has(bm.entry!.uuid)).toBe(true)
      }

      // Sidechain entries should NOT be reparented
      const side51 = repairedEntries.find(e => e.entry?.uuid === 'side-5-1')
      expect(side51?.entry?.parentUuid).toBe('a5')
    })
  })
})
