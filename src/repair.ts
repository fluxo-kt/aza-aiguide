#!/usr/bin/env node

import { readFileSync, writeFileSync, copyFileSync, readdirSync, statSync, existsSync } from 'fs'
import { join, basename } from 'path'
import { homedir } from 'os'
import { randomUUID } from 'crypto'
// Re-export for backward compatibility (existing tests import from repair.ts)
export { type JournalEntry, type ParsedLine, parseJSONL } from './lib/jsonl-types'

// Local imports for use within this file
import type { JournalEntry } from './lib/jsonl-types'
import { parseJSONL } from './lib/jsonl-types'

// --- Types ---

export interface SessionMetadata {
  sessionId: string
  version: string
  cwd: string
  gitBranch?: string
  slug?: string
}

export interface RepairOptions {
  interval: number    // Insert every N assistant entries (default: 5)
  dryRun: boolean     // Preview only
  verify: boolean     // Validate after repair
  marker: string      // Bookmark marker (default: ·)
}

export interface RepairResult {
  inserted: number
  backupPath: string | null
  errors: string[]
  warnings: string[]
}

export const DEFAULT_REPAIR_OPTIONS: RepairOptions = {
  interval: 5,
  dryRun: false,
  verify: true,
  marker: '\u00B7'
}

// --- Session Resolution ---

/**
 * Searches ~/.claude/projects/ for JSONL files matching a session ID prefix.
 * Returns matching file paths sorted by modification time (newest first).
 */
export function resolveSessionFiles(prefix: string): string[] {
  const claudeDir = join(homedir(), '.claude')
  const matches: Array<{ path: string; mtime: number }> = []
  const seen = new Set<string>()

  // Helper: add matching JSONL files from a flat directory
  function scanFlat(dirPath: string): void {
    if (!existsSync(dirPath)) return
    try {
      const files = readdirSync(dirPath)
      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue
        const sessionName = file.replace('.jsonl', '')
        if (sessionName.startsWith(prefix) && !seen.has(sessionName)) {
          const filePath = join(dirPath, file)
          try {
            const fileStat = statSync(filePath)
            matches.push({ path: filePath, mtime: fileStat.mtimeMs })
            seen.add(sessionName)
          } catch { /* skip unreadable */ }
        }
      }
    } catch { /* dir unreadable */ }
  }

  // Search ~/.claude/projects/{hash}/ (nested — each hash dir contains JSONL files)
  const projectsDir = join(claudeDir, 'projects')
  if (existsSync(projectsDir)) {
    try {
      const projectDirs = readdirSync(projectsDir)
      for (const dir of projectDirs) {
        const projectPath = join(projectsDir, dir)
        try {
          const stat = statSync(projectPath)
          if (!stat.isDirectory()) continue
          scanFlat(projectPath)
        } catch { /* skip unreadable */ }
      }
    } catch { /* projects dir unreadable */ }
  }

  // Search ~/.claude/transcripts/ (flat — JSONL files directly inside)
  scanFlat(join(claudeDir, 'transcripts'))

  // Sort by mtime descending (newest first)
  matches.sort((a, b) => b.mtime - a.mtime)
  return matches.map(m => m.path)
}

// --- Metadata Extraction ---

/**
 * Extracts session metadata from the first user (human) entry.
 */
export function extractMetadata(entries: Array<{ entry: JournalEntry | null }>): SessionMetadata | null {
  for (const { entry } of entries) {
    if (!entry) continue
    if (entry.type === 'user' && entry.sessionId) {
      return {
        sessionId: entry.sessionId,
        version: entry.version ?? '1',
        cwd: entry.cwd ?? '',
        gitBranch: (entry as Record<string, unknown>).gitBranch as string | undefined,
        slug: (entry as Record<string, unknown>).slug as string | undefined
      }
    }
  }
  return null
}

// --- Break Point Detection ---

/**
 * Identifies break points where synthetic bookmarks should be inserted.
 * A break point is the index of the entry AFTER which the bookmark goes.
 *
 * Criteria (any one triggers a break point):
 * - Every `interval` assistant entries since the last break point
 * - System entries with subtype "turn_duration" (natural turn boundaries)
 * - Time gaps > 60 seconds between adjacent entries
 */
export function findBreakPoints(
  entries: Array<{ entry: JournalEntry | null }>,
  startIdx: number,
  interval: number
): number[] {
  const breakPoints: number[] = []
  let assistantCount = 0
  let lastBreakIdx = startIdx - 1

  for (let i = startIdx; i < entries.length; i++) {
    const { entry } = entries[i]
    if (!entry) continue

    // Count assistant entries
    if (entry.type === 'assistant') {
      assistantCount++
    }

    // Criterion 1: Every N assistant entries
    if (assistantCount >= interval && entry.type === 'assistant') {
      // Only add if we have a preceding entry to anchor to
      if (i > startIdx) {
        breakPoints.push(i)
        assistantCount = 0
        lastBreakIdx = i
      }
    }

    // Criterion 2: Turn duration markers (natural boundaries)
    if (entry.type === 'system' && entry.subtype === 'turn_duration') {
      // Avoid double-inserting if we just hit an interval break
      if (i > lastBreakIdx + 1) {
        breakPoints.push(i)
        assistantCount = 0
        lastBreakIdx = i
      }
    }

    // Criterion 3: Time gaps > 60 seconds
    if (i > startIdx) {
      const prev = entries[i - 1]?.entry
      if (prev?.timestamp && entry.timestamp) {
        const gap = new Date(entry.timestamp).getTime() - new Date(prev.timestamp).getTime()
        if (gap > 60000 && i > lastBreakIdx + 1) {
          breakPoints.push(i)
          assistantCount = 0
          lastBreakIdx = i
        }
      }
    }
  }

  return [...new Set(breakPoints)].sort((a, b) => a - b)
}

/**
 * Finds the index of the last compact_boundary entry, or -1 if none.
 */
export function findLastCompactBoundary(entries: Array<{ entry: JournalEntry | null }>): number {
  for (let i = entries.length - 1; i >= 0; i--) {
    const { entry } = entries[i]
    if (entry?.type === 'system' && entry?.subtype === 'compact_boundary') {
      return i
    }
  }
  return -1
}

// --- Synthetic Entry Generation ---

/**
 * Creates a synthetic user message entry that CC will interpret as a
 * rewind point. Mirrors the structure of real user entries.
 */
export function createSyntheticEntry(
  metadata: SessionMetadata,
  parentUuid: string,
  timestamp: string,
  marker: string
): JournalEntry {
  const entry: JournalEntry = {
    parentUuid,
    isSidechain: false,
    userType: 'external',
    cwd: metadata.cwd,
    sessionId: metadata.sessionId,
    version: metadata.version,
    type: 'user',
    message: {
      role: 'user',
      content: marker
    },
    uuid: randomUUID(),
    timestamp
  }
  // Include optional fields that real CC entries have (required for rewind point recognition)
  if (metadata.gitBranch) entry.gitBranch = metadata.gitBranch
  if (metadata.slug) entry.slug = metadata.slug
  return entry
}

/**
 * Computes a timestamp midpoint between two ISO timestamps.
 * Falls back to the earlier timestamp if parsing fails.
 */
export function midpointTimestamp(before: string, after: string): string {
  const t1 = new Date(before).getTime()
  const t2 = new Date(after).getTime()

  if (isNaN(t1) || isNaN(t2)) {
    return before || after || new Date().toISOString()
  }

  return new Date(Math.floor((t1 + t2) / 2)).toISOString()
}

// --- Validation ---

/**
 * Validates the repaired JSONL for chain integrity.
 * Checks for duplicate UUIDs and broken parent references.
 */
export function validate(entries: Array<{ entry: JournalEntry | null }>): {
  valid: boolean
  errors: string[]
} {
  const errors: string[] = []
  const uuids = new Set<string>()

  for (let i = 0; i < entries.length; i++) {
    const { entry } = entries[i]
    if (!entry?.uuid) continue

    // Check duplicate UUIDs
    if (uuids.has(entry.uuid)) {
      errors.push(`Duplicate UUID at line ${i + 1}: ${entry.uuid}`)
    }
    uuids.add(entry.uuid)
  }

  // Check parent references (skip first entry which has no parent)
  for (let i = 1; i < entries.length; i++) {
    const { entry } = entries[i]
    if (!entry?.parentUuid) continue
    if (!uuids.has(entry.parentUuid)) {
      errors.push(`Broken parent reference at line ${i + 1}: ${entry.parentUuid} not found`)
    }
  }

  return { valid: errors.length === 0, errors }
}

// --- Repair ---

/**
 * Performs the actual repair: inserts synthetic bookmarks at break points
 * and repairs the chain (updates parentUuid of following entries).
 *
 * Returns the modified entries array (does not write to disk).
 */
export function insertBookmarks(
  entries: Array<{ entry: JournalEntry | null; raw: string }>,
  breakPoints: number[],
  metadata: SessionMetadata,
  marker: string
): { result: Array<{ entry: JournalEntry | null; raw: string }>; inserted: number } {
  if (breakPoints.length === 0) {
    return { result: entries, inserted: 0 }
  }

  // Work backwards to preserve indices
  const result = [...entries]
  let inserted = 0
  const sortedBreaks = [...breakPoints].sort((a, b) => b - a)

  for (const breakIdx of sortedBreaks) {
    const breakEntry = result[breakIdx]?.entry
    if (!breakEntry?.uuid) continue

    // Find preceding assistant entry's uuid for parentUuid
    let parentUuid = breakEntry.uuid
    for (let j = breakIdx; j >= 0; j--) {
      const e = result[j]?.entry
      if (e?.type === 'assistant' && e?.uuid) {
        parentUuid = e.uuid
        break
      }
    }

    // Compute timestamp midpoint
    const beforeTs = breakEntry.timestamp ?? new Date().toISOString()
    const afterEntry = result[breakIdx + 1]?.entry
    const afterTs = afterEntry?.timestamp ?? beforeTs
    const ts = midpointTimestamp(beforeTs, afterTs)

    // Create synthetic entry
    const synthetic = createSyntheticEntry(metadata, parentUuid, ts, marker)
    const syntheticRaw = JSON.stringify(synthetic)

    // Chain repair: update next entry's parentUuid
    if (breakIdx + 1 < result.length && result[breakIdx + 1].entry) {
      const nextEntry = { ...result[breakIdx + 1].entry! }
      nextEntry.parentUuid = synthetic.uuid
      result[breakIdx + 1] = { entry: nextEntry, raw: JSON.stringify(nextEntry) }
    }

    // Insert after break point
    result.splice(breakIdx + 1, 0, { entry: synthetic, raw: syntheticRaw })
    inserted++
  }

  return { result, inserted }
}

/**
 * Main repair function. Orchestrates the full pipeline:
 * resolve → parse → backup → find breaks → insert → validate → write.
 */
export function repair(
  filePath: string,
  options: RepairOptions = DEFAULT_REPAIR_OPTIONS
): RepairResult {
  const result: RepairResult = {
    inserted: 0,
    backupPath: null,
    errors: [],
    warnings: []
  }

  // Read file
  let content: string
  try {
    content = readFileSync(filePath, 'utf-8')
  } catch (err) {
    result.errors.push(`Cannot read file: ${filePath}`)
    return result
  }

  // Parse JSONL
  const entries = parseJSONL(content)
  if (entries.length === 0) {
    result.errors.push('File is empty')
    return result
  }

  // Extract metadata
  const metadata = extractMetadata(entries)
  if (!metadata) {
    result.errors.push('No user entry found — cannot extract session metadata')
    return result
  }

  // Find last compact_boundary
  const lastCompactIdx = findLastCompactBoundary(entries)
  const startIdx = lastCompactIdx === -1 ? 0 : lastCompactIdx + 1

  // Find break points
  const breakPoints = findBreakPoints(entries, startIdx, options.interval)

  if (breakPoints.length === 0) {
    result.warnings.push('No break points found — file may be too short or already well-segmented')
    return result
  }

  // Dry run — report but don't modify
  if (options.dryRun) {
    result.inserted = breakPoints.length
    result.warnings.push(`DRY RUN: Would insert ${breakPoints.length} rewind points`)
    for (const bp of breakPoints) {
      const entry = entries[bp]?.entry
      const ts = entry?.timestamp ?? 'unknown'
      result.warnings.push(`  Break at line ${bp + 1} (${ts})`)
    }
    return result
  }

  // Create backup
  const backupPath = `${filePath}.tav-backup`
  try {
    copyFileSync(filePath, backupPath)
    result.backupPath = backupPath
  } catch (err) {
    result.errors.push(`Cannot create backup: ${backupPath}`)
    return result
  }

  // Insert bookmarks
  const { result: modifiedEntries, inserted } = insertBookmarks(
    entries,
    breakPoints,
    metadata,
    options.marker
  )
  result.inserted = inserted

  // Validate
  if (options.verify) {
    const validation = validate(modifiedEntries)
    if (!validation.valid) {
      result.errors.push(...validation.errors)
      result.warnings.push('Validation failed — repaired file NOT written. Backup preserved.')
      return result
    }
  }

  // Write repaired file
  const repairedContent = modifiedEntries.map(e => e.raw).join('\n') + '\n'
  try {
    writeFileSync(filePath, repairedContent, 'utf-8')
  } catch (err) {
    result.errors.push(`Cannot write repaired file: ${filePath}`)
    return result
  }

  // Add UNVERIFIED warning
  result.warnings.push(
    'NOTE: CC loading repaired JSONL as rewind points is UNVERIFIED. ' +
    'Test on a non-critical session first. ' +
    `Backup at: ${backupPath}`
  )

  return result
}

// --- List Sessions ---

export interface SessionInfo {
  path: string
  sessionId: string
  size: number
  modified: Date
  entryCount: number
}

/**
 * Lists recent JSONL sessions with metadata.
 */
export function listSessions(limit: number = 10): SessionInfo[] {
  const projectsDir = join(homedir(), '.claude', 'projects')

  if (!existsSync(projectsDir)) {
    return []
  }

  const sessions: SessionInfo[] = []

  try {
    const projectDirs = readdirSync(projectsDir)
    for (const dir of projectDirs) {
      const projectPath = join(projectsDir, dir)
      try {
        const stat = statSync(projectPath)
        if (!stat.isDirectory()) continue

        const files = readdirSync(projectPath)
        for (const file of files) {
          if (!file.endsWith('.jsonl')) continue
          const filePath = join(projectPath, file)
          const fileStat = statSync(filePath)
          const sessionId = file.replace('.jsonl', '')

          // Count entries (cheap — just count newlines)
          let entryCount = 0
          try {
            const content = readFileSync(filePath, 'utf-8')
            entryCount = content.split('\n').filter(l => l.trim()).length
          } catch {
            // Skip unreadable files
          }

          sessions.push({
            path: filePath,
            sessionId,
            size: fileStat.size,
            modified: new Date(fileStat.mtimeMs),
            entryCount
          })
        }
      } catch {
        // Skip unreadable dirs
      }
    }
  } catch {
    // Projects dir unreadable
  }

  // Sort by modification time descending
  sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime())
  return sessions.slice(0, limit)
}

// --- CLI ---

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

function printUsage(): void {
  console.log(`tav repair — Session Repair Tool

Usage:
  tav repair <session-id-prefix>        Repair by session ID prefix
  tav repair <path/to/session.jsonl>    Repair by full path
  tav list [--recent N]                 List sessions

Options:
  --dry-run        Preview changes without modifying
  --interval N     Insert every N assistant entries (default: 5)
  --verify         Validate chain integrity after repair (default: on)
  --no-verify      Skip validation
  --marker CHAR    Bookmark marker (default: ·)

WARNING: CC loading repaired sessions as rewind points is UNVERIFIED.
Always test on a non-critical session first.`)
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    printUsage()
    return
  }

  // Parse command
  const command = args[0]

  if (command === 'list') {
    const recentIdx = args.indexOf('--recent')
    const limit = recentIdx !== -1 ? parseInt(args[recentIdx + 1], 10) || 10 : 10

    const sessions = listSessions(limit)
    if (sessions.length === 0) {
      console.log('No sessions found in ~/.claude/projects/')
      return
    }

    console.log(`Recent sessions (${sessions.length}):`)
    console.log('')
    for (const s of sessions) {
      const prefix = s.sessionId.slice(0, 8)
      const age = Math.floor((Date.now() - s.modified.getTime()) / (1000 * 60 * 60))
      const ageStr = age < 24 ? `${age}h ago` : `${Math.floor(age / 24)}d ago`
      console.log(`  ${prefix}  ${formatBytes(s.size).padStart(8)}  ${String(s.entryCount).padStart(5)} entries  ${ageStr.padStart(8)}`)
      console.log(`           ${s.path}`)
    }
    return
  }

  // Parse options
  const options: RepairOptions = { ...DEFAULT_REPAIR_OPTIONS }
  for (let i = 1; i < args.length; i++) {
    switch (args[i]) {
      case '--dry-run':
        options.dryRun = true
        break
      case '--interval':
        options.interval = parseInt(args[++i], 10) || 5
        break
      case '--verify':
        options.verify = true
        break
      case '--no-verify':
        options.verify = false
        break
      case '--marker':
        options.marker = args[++i] || '\u00B7'
        break
    }
  }

  // Resolve file path
  let filePath: string

  if (command.endsWith('.jsonl') || command.includes('/')) {
    // Direct path
    filePath = command
    if (!existsSync(filePath)) {
      console.error(`File not found: ${filePath}`)
      process.exit(1)
    }
  } else {
    // Session ID prefix
    const matches = resolveSessionFiles(command)
    if (matches.length === 0) {
      console.error(`No sessions found matching prefix: ${command}`)
      process.exit(1)
    }
    if (matches.length > 1) {
      console.error(`Multiple sessions match prefix "${command}":`)
      for (const m of matches) {
        const name = basename(m, '.jsonl')
        console.error(`  ${name.slice(0, 8)}  ${m}`)
      }
      console.error('\nProvide a longer prefix or use the full path.')
      process.exit(1)
    }
    filePath = matches[0]
  }

  console.log(`Repairing: ${filePath}`)
  console.log(`Options: interval=${options.interval}, dryRun=${options.dryRun}, verify=${options.verify}`)
  console.log('')

  const result = repair(filePath, options)

  // Report
  if (result.errors.length > 0) {
    console.error('Errors:')
    for (const err of result.errors) {
      console.error(`  ✘ ${err}`)
    }
  }

  for (const warn of result.warnings) {
    console.log(`  ⚠ ${warn}`)
  }

  if (result.inserted > 0 && result.errors.length === 0) {
    console.log('')
    console.log(`Inserted ${result.inserted} rewind points.`)
    if (result.backupPath) {
      console.log(`Backup: ${result.backupPath}`)
    }
  }

  process.exit(result.errors.length > 0 ? 1 : 0)
}

if (require.main === module) {
  main()
}
