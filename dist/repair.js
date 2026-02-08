#!/usr/bin/env node
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_REPAIR_OPTIONS = exports.parseJSONL = void 0;
exports.resolveSessionFiles = resolveSessionFiles;
exports.extractMetadata = extractMetadata;
exports.findBreakPoints = findBreakPoints;
exports.findLastCompactBoundary = findLastCompactBoundary;
exports.buildChain = buildChain;
exports.findChainBreakPoints = findChainBreakPoints;
exports.insertChainBookmarks = insertChainBookmarks;
exports.createSyntheticEntry = createSyntheticEntry;
exports.midpointTimestamp = midpointTimestamp;
exports.validate = validate;
exports.insertBookmarks = insertBookmarks;
exports.repair = repair;
exports.listSessions = listSessions;
const fs_1 = require("fs");
const path_1 = require("path");
const os_1 = require("os");
const crypto_1 = require("crypto");
// Re-export for backward compatibility (existing tests import from repair.ts)
var jsonl_types_1 = require("./lib/jsonl-types");
Object.defineProperty(exports, "parseJSONL", { enumerable: true, get: function () { return jsonl_types_1.parseJSONL; } });
const jsonl_types_2 = require("./lib/jsonl-types");
exports.DEFAULT_REPAIR_OPTIONS = {
    interval: 1,
    dryRun: false,
    verify: true,
    marker: '\u00B7'
};
// --- Session Resolution ---
/**
 * Searches ~/.claude/projects/ for JSONL files matching a session ID prefix.
 * Returns matching file paths sorted by modification time (newest first).
 */
function resolveSessionFiles(prefix) {
    const claudeDir = (0, path_1.join)((0, os_1.homedir)(), '.claude');
    const matches = [];
    const seen = new Set();
    // Helper: add matching JSONL files from a flat directory
    function scanFlat(dirPath) {
        if (!(0, fs_1.existsSync)(dirPath))
            return;
        try {
            const files = (0, fs_1.readdirSync)(dirPath);
            for (const file of files) {
                if (!file.endsWith('.jsonl'))
                    continue;
                const sessionName = file.replace('.jsonl', '');
                if (sessionName.startsWith(prefix) && !seen.has(sessionName)) {
                    const filePath = (0, path_1.join)(dirPath, file);
                    try {
                        const fileStat = (0, fs_1.statSync)(filePath);
                        matches.push({ path: filePath, mtime: fileStat.mtimeMs });
                        seen.add(sessionName);
                    }
                    catch { /* skip unreadable */ }
                }
            }
        }
        catch { /* dir unreadable */ }
    }
    // Search ~/.claude/projects/{hash}/ (nested — each hash dir contains JSONL files)
    const projectsDir = (0, path_1.join)(claudeDir, 'projects');
    if ((0, fs_1.existsSync)(projectsDir)) {
        try {
            const projectDirs = (0, fs_1.readdirSync)(projectsDir);
            for (const dir of projectDirs) {
                const projectPath = (0, path_1.join)(projectsDir, dir);
                try {
                    const stat = (0, fs_1.statSync)(projectPath);
                    if (!stat.isDirectory())
                        continue;
                    scanFlat(projectPath);
                }
                catch { /* skip unreadable */ }
            }
        }
        catch { /* projects dir unreadable */ }
    }
    // Search ~/.claude/transcripts/ (flat — JSONL files directly inside)
    scanFlat((0, path_1.join)(claudeDir, 'transcripts'));
    // Sort by mtime descending (newest first)
    matches.sort((a, b) => b.mtime - a.mtime);
    return matches.map(m => m.path);
}
// --- Metadata Extraction ---
/**
 * Extracts session metadata from the first user (human) entry.
 */
function extractMetadata(entries) {
    for (const { entry } of entries) {
        if (!entry)
            continue;
        if (entry.type === 'user' && entry.sessionId) {
            return {
                sessionId: entry.sessionId,
                version: entry.version ?? '1',
                cwd: entry.cwd ?? '',
                gitBranch: entry.gitBranch,
                slug: entry.slug
            };
        }
    }
    return null;
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
function findBreakPoints(entries, startIdx, interval) {
    const breakPoints = [];
    let assistantCount = 0;
    let lastBreakIdx = startIdx - 1;
    for (let i = startIdx; i < entries.length; i++) {
        const { entry } = entries[i];
        if (!entry)
            continue;
        // Count assistant entries
        if (entry.type === 'assistant') {
            assistantCount++;
        }
        // Criterion 1: Every N assistant entries
        if (assistantCount >= interval && entry.type === 'assistant') {
            // Only add if we have a preceding entry to anchor to
            if (i > startIdx) {
                breakPoints.push(i);
                assistantCount = 0;
                lastBreakIdx = i;
            }
        }
        // Criterion 2: Turn duration markers (natural boundaries)
        if (entry.type === 'system' && entry.subtype === 'turn_duration') {
            // Avoid double-inserting if we just hit an interval break
            if (i > lastBreakIdx + 1) {
                breakPoints.push(i);
                assistantCount = 0;
                lastBreakIdx = i;
            }
        }
        // Criterion 3: Time gaps > 60 seconds
        if (i > startIdx) {
            const prev = entries[i - 1]?.entry;
            if (prev?.timestamp && entry.timestamp) {
                const gap = new Date(entry.timestamp).getTime() - new Date(prev.timestamp).getTime();
                if (gap > 60000 && i > lastBreakIdx + 1) {
                    breakPoints.push(i);
                    assistantCount = 0;
                    lastBreakIdx = i;
                }
            }
        }
    }
    return [...new Set(breakPoints)].sort((a, b) => a - b);
}
/**
 * Finds the index of the last compact_boundary entry, or -1 if none.
 */
function findLastCompactBoundary(entries) {
    for (let i = entries.length - 1; i >= 0; i--) {
        const { entry } = entries[i];
        if (entry?.type === 'system' && entry?.subtype === 'compact_boundary') {
            return i;
        }
    }
    return -1;
}
/**
 * Builds the parentUuid chain from the last entry backwards.
 * Returns entries in chronological order (oldest first).
 * This is the ACTUAL conversation path that CC's rewind UI follows.
 */
function buildChain(entries) {
    const byUuid = new Map();
    for (let i = 0; i < entries.length; i++) {
        const { entry } = entries[i];
        if (entry?.uuid) {
            byUuid.set(entry.uuid, { entry, fileIndex: i });
        }
    }
    // Find last entry with a uuid
    let lastEntry;
    for (let i = entries.length - 1; i >= 0; i--) {
        const { entry } = entries[i];
        if (entry?.uuid) {
            lastEntry = { entry, fileIndex: i };
            break;
        }
    }
    if (!lastEntry)
        return [];
    // Walk backwards via parentUuid
    const chain = [];
    let current = lastEntry;
    const visited = new Set();
    while (current) {
        if (visited.has(current.entry.uuid))
            break;
        visited.add(current.entry.uuid);
        chain.push(current);
        if (!current.entry.parentUuid)
            break;
        current = byUuid.get(current.entry.parentUuid);
    }
    chain.reverse();
    return chain;
}
/**
 * Finds break points on the chain. Returns indices into the chain array.
 * Operates on the actual conversation chain (parentUuid path).
 *
 * CRITICAL: Break points MUST have an assistant entry as their successor
 * (chain[breakIdx + 1].type === 'assistant'). CC's rewind UI only shows
 * user entries that have an assistant child. Without this constraint,
 * bookmarks inserted before tool-result user entries are invisible.
 */
function findChainBreakPoints(chain, startFileIndex, interval) {
    const breakPoints = [];
    let assistantCount = 0;
    let lastBreakChainIdx = -1;
    // Check if placing a break at position i would create a visible rewind point.
    // The bookmark is inserted AFTER chain[i], so chain[i+1] becomes its child.
    // CC requires the child to be an assistant entry.
    function hasAssistantSuccessor(i) {
        return i + 1 < chain.length && chain[i + 1].entry.type === 'assistant';
    }
    // Find nearest valid break position at or after `from`.
    // Scans forward — shift is typically 1-2 positions since the chain
    // alternates assistant/user(tool-result)/assistant.
    function findNearestValid(from) {
        for (let j = from; j < chain.length - 1; j++) {
            if (hasAssistantSuccessor(j))
                return j;
        }
        return -1;
    }
    for (let i = 0; i < chain.length; i++) {
        if (chain[i].fileIndex < startFileIndex)
            continue;
        const { entry } = chain[i];
        if (entry.type === 'assistant')
            assistantCount++;
        // Criterion 1: Every N assistant entries
        if (assistantCount >= interval && entry.type === 'assistant' && i > 0) {
            const pos = findNearestValid(i);
            if (pos >= 0 && (lastBreakChainIdx < 0 || pos > lastBreakChainIdx + 1)) {
                breakPoints.push(pos);
                assistantCount = 0;
                lastBreakChainIdx = pos;
            }
        }
        // Criterion 2: Turn duration markers (natural boundaries)
        if (entry.type === 'system' && entry.subtype === 'turn_duration') {
            if (lastBreakChainIdx < 0 || i > lastBreakChainIdx + 1) {
                const pos = findNearestValid(i);
                if (pos >= 0 && (lastBreakChainIdx < 0 || pos > lastBreakChainIdx + 1)) {
                    breakPoints.push(pos);
                    assistantCount = 0;
                    lastBreakChainIdx = pos;
                }
            }
        }
        // Criterion 3: Time gaps > 60 seconds
        // Gap is between chain[i-1] and chain[i]. Break goes IN the gap (at i-1),
        // so the bookmark is inserted after chain[i-1] and chain[i] becomes its child.
        if (i > 0 && chain[i - 1].fileIndex >= startFileIndex) {
            const prev = chain[i - 1].entry;
            if (prev.timestamp && entry.timestamp) {
                const gap = new Date(entry.timestamp).getTime() - new Date(prev.timestamp).getTime();
                if (gap > 60000 && (lastBreakChainIdx < 0 || i - 1 > lastBreakChainIdx + 1)) {
                    // Try before gap first, then after
                    const pos = findNearestValid(i - 1);
                    if (pos >= 0 && (lastBreakChainIdx < 0 || pos > lastBreakChainIdx + 1)) {
                        breakPoints.push(pos);
                        assistantCount = 0;
                        lastBreakChainIdx = pos;
                    }
                }
            }
        }
    }
    return [...new Set(breakPoints)].sort((a, b) => a - b);
}
/**
 * Inserts bookmarks ON the chain. Two-phase approach:
 * 1. Create all synthetics, record insertions and reparents
 * 2. Rebuild entry array with insertions and reparents applied
 *
 * Re-parents chain successors (not file-adjacent entries) so bookmarks
 * are always on the parentUuid path that CC's rewind UI follows.
 */
function insertChainBookmarks(entries, chain, chainBreakPoints, metadata, marker) {
    if (chainBreakPoints.length === 0) {
        return { result: entries, inserted: 0 };
    }
    // Phase 1: create synthetics, record where they go and what to reparent
    const insertAfter = new Map();
    const reparents = new Map();
    for (const chainIdx of chainBreakPoints) {
        const breakEntry = chain[chainIdx];
        if (!breakEntry?.entry?.uuid)
            continue;
        const nextInChain = chain[chainIdx + 1];
        if (!nextInChain?.entry?.uuid)
            continue;
        const beforeTs = breakEntry.entry.timestamp ?? new Date().toISOString();
        const afterTs = nextInChain.entry.timestamp ?? beforeTs;
        const ts = midpointTimestamp(beforeTs, afterTs);
        const synthetic = createSyntheticEntry(metadata, breakEntry.entry.uuid, ts, marker);
        insertAfter.set(breakEntry.fileIndex, { entry: synthetic, raw: JSON.stringify(synthetic) });
        reparents.set(nextInChain.entry.uuid, synthetic.uuid);
    }
    // Phase 2: rebuild array with insertions and reparents
    const result = [];
    for (let i = 0; i < entries.length; i++) {
        let current = entries[i];
        if (current.entry?.uuid && reparents.has(current.entry.uuid)) {
            const modified = { ...current.entry };
            modified.parentUuid = reparents.get(current.entry.uuid);
            current = { entry: modified, raw: JSON.stringify(modified) };
        }
        result.push(current);
        const insertion = insertAfter.get(i);
        if (insertion)
            result.push(insertion);
    }
    return { result, inserted: insertAfter.size };
}
// --- Synthetic Entry Generation ---
/**
 * Creates a synthetic user message entry that CC will interpret as a
 * rewind point. Mirrors the structure of real user entries.
 */
function createSyntheticEntry(metadata, parentUuid, timestamp, marker) {
    const entry = {
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
        uuid: (0, crypto_1.randomUUID)(),
        timestamp
    };
    // Include optional fields that real CC entries have (required for rewind point recognition)
    if (metadata.gitBranch)
        entry.gitBranch = metadata.gitBranch;
    if (metadata.slug)
        entry.slug = metadata.slug;
    return entry;
}
/**
 * Computes a timestamp midpoint between two ISO timestamps.
 * Falls back to the earlier timestamp if parsing fails.
 */
function midpointTimestamp(before, after) {
    const t1 = new Date(before).getTime();
    const t2 = new Date(after).getTime();
    if (isNaN(t1) || isNaN(t2)) {
        return before || after || new Date().toISOString();
    }
    return new Date(Math.floor((t1 + t2) / 2)).toISOString();
}
// --- Validation ---
/**
 * Validates the repaired JSONL for chain integrity.
 * Checks for duplicate UUIDs and broken parent references.
 */
function validate(entries) {
    const errors = [];
    const uuids = new Set();
    for (let i = 0; i < entries.length; i++) {
        const { entry } = entries[i];
        if (!entry?.uuid)
            continue;
        // Check duplicate UUIDs
        if (uuids.has(entry.uuid)) {
            errors.push(`Duplicate UUID at line ${i + 1}: ${entry.uuid}`);
        }
        uuids.add(entry.uuid);
    }
    // Check parent references (skip first entry which has no parent)
    for (let i = 1; i < entries.length; i++) {
        const { entry } = entries[i];
        if (!entry?.parentUuid)
            continue;
        if (!uuids.has(entry.parentUuid)) {
            errors.push(`Broken parent reference at line ${i + 1}: ${entry.parentUuid} not found`);
        }
    }
    return { valid: errors.length === 0, errors };
}
// --- Repair ---
/**
 * Performs the actual repair: inserts synthetic bookmarks at break points
 * and repairs the chain (updates parentUuid of following entries).
 *
 * Returns the modified entries array (does not write to disk).
 */
function insertBookmarks(entries, breakPoints, metadata, marker) {
    if (breakPoints.length === 0) {
        return { result: entries, inserted: 0 };
    }
    // Work backwards to preserve indices
    const result = [...entries];
    let inserted = 0;
    const sortedBreaks = [...breakPoints].sort((a, b) => b - a);
    for (const breakIdx of sortedBreaks) {
        const breakEntry = result[breakIdx]?.entry;
        if (!breakEntry?.uuid)
            continue;
        // Find preceding assistant entry's uuid for parentUuid
        let parentUuid = breakEntry.uuid;
        for (let j = breakIdx; j >= 0; j--) {
            const e = result[j]?.entry;
            if (e?.type === 'assistant' && e?.uuid) {
                parentUuid = e.uuid;
                break;
            }
        }
        // Compute timestamp midpoint
        const beforeTs = breakEntry.timestamp ?? new Date().toISOString();
        const afterEntry = result[breakIdx + 1]?.entry;
        const afterTs = afterEntry?.timestamp ?? beforeTs;
        const ts = midpointTimestamp(beforeTs, afterTs);
        // Create synthetic entry
        const synthetic = createSyntheticEntry(metadata, parentUuid, ts, marker);
        const syntheticRaw = JSON.stringify(synthetic);
        // Chain repair: update next entry's parentUuid
        if (breakIdx + 1 < result.length && result[breakIdx + 1].entry) {
            const nextEntry = { ...result[breakIdx + 1].entry };
            nextEntry.parentUuid = synthetic.uuid;
            result[breakIdx + 1] = { entry: nextEntry, raw: JSON.stringify(nextEntry) };
        }
        // Insert after break point
        result.splice(breakIdx + 1, 0, { entry: synthetic, raw: syntheticRaw });
        inserted++;
    }
    return { result, inserted };
}
/**
 * Main repair function. Orchestrates the full pipeline:
 * resolve → parse → backup → find breaks → insert → validate → write.
 */
function repair(filePath, options = exports.DEFAULT_REPAIR_OPTIONS) {
    const result = {
        inserted: 0,
        backupPath: null,
        errors: [],
        warnings: []
    };
    // Read file
    let content;
    try {
        content = (0, fs_1.readFileSync)(filePath, 'utf-8');
    }
    catch (err) {
        result.errors.push(`Cannot read file: ${filePath}`);
        return result;
    }
    // Parse JSONL
    const entries = (0, jsonl_types_2.parseJSONL)(content);
    if (entries.length === 0) {
        result.errors.push('File is empty');
        return result;
    }
    // Extract metadata
    const metadata = extractMetadata(entries);
    if (!metadata) {
        result.errors.push('No user entry found — cannot extract session metadata');
        return result;
    }
    // Build the parentUuid chain (the actual path CC's rewind UI follows)
    const chain = buildChain(entries);
    if (chain.length === 0) {
        result.errors.push('Cannot build parentUuid chain — no entries with uuid');
        return result;
    }
    // Find last compact_boundary to scope break points
    const lastCompactIdx = findLastCompactBoundary(entries);
    const startFileIndex = lastCompactIdx === -1 ? 0 : lastCompactIdx + 1;
    // Find break points ON THE CHAIN (not file order)
    const chainBreakPoints = findChainBreakPoints(chain, startFileIndex, options.interval);
    if (chainBreakPoints.length === 0) {
        result.warnings.push('No break points found on chain — file may be too short or already well-segmented');
        return result;
    }
    // Dry run — report but don't modify
    if (options.dryRun) {
        result.inserted = chainBreakPoints.length;
        result.warnings.push(`DRY RUN: Would insert ${chainBreakPoints.length} rewind points`);
        for (const bp of chainBreakPoints) {
            const entry = chain[bp]?.entry;
            const ts = entry?.timestamp ?? 'unknown';
            result.warnings.push(`  Break at chain[${bp}] file line ${chain[bp].fileIndex + 1} (${ts})`);
        }
        return result;
    }
    // Create backup
    const backupPath = `${filePath}.tav-backup`;
    try {
        (0, fs_1.copyFileSync)(filePath, backupPath);
        result.backupPath = backupPath;
    }
    catch (err) {
        result.errors.push(`Cannot create backup: ${backupPath}`);
        return result;
    }
    // Insert bookmarks ON THE CHAIN (re-parents chain successors, not file-adjacent)
    const { result: modifiedEntries, inserted } = insertChainBookmarks(entries, chain, chainBreakPoints, metadata, options.marker);
    result.inserted = inserted;
    // Validate
    if (options.verify) {
        const validation = validate(modifiedEntries);
        if (!validation.valid) {
            result.errors.push(...validation.errors);
            result.warnings.push('Validation failed — repaired file NOT written. Backup preserved.');
            return result;
        }
    }
    // Write repaired file
    const repairedContent = modifiedEntries.map(e => e.raw).join('\n') + '\n';
    try {
        (0, fs_1.writeFileSync)(filePath, repairedContent, 'utf-8');
    }
    catch (err) {
        result.errors.push(`Cannot write repaired file: ${filePath}`);
        return result;
    }
    // Add UNVERIFIED warning
    result.warnings.push('NOTE: CC loading repaired JSONL as rewind points is UNVERIFIED. ' +
        'Test on a non-critical session first. ' +
        `Backup at: ${backupPath}`);
    return result;
}
/**
 * Lists recent JSONL sessions with metadata.
 */
function listSessions(limit = 10) {
    const projectsDir = (0, path_1.join)((0, os_1.homedir)(), '.claude', 'projects');
    if (!(0, fs_1.existsSync)(projectsDir)) {
        return [];
    }
    const sessions = [];
    try {
        const projectDirs = (0, fs_1.readdirSync)(projectsDir);
        for (const dir of projectDirs) {
            const projectPath = (0, path_1.join)(projectsDir, dir);
            try {
                const stat = (0, fs_1.statSync)(projectPath);
                if (!stat.isDirectory())
                    continue;
                const files = (0, fs_1.readdirSync)(projectPath);
                for (const file of files) {
                    if (!file.endsWith('.jsonl'))
                        continue;
                    const filePath = (0, path_1.join)(projectPath, file);
                    const fileStat = (0, fs_1.statSync)(filePath);
                    const sessionId = file.replace('.jsonl', '');
                    // Count entries (cheap — just count newlines)
                    let entryCount = 0;
                    try {
                        const content = (0, fs_1.readFileSync)(filePath, 'utf-8');
                        entryCount = content.split('\n').filter(l => l.trim()).length;
                    }
                    catch {
                        // Skip unreadable files
                    }
                    sessions.push({
                        path: filePath,
                        sessionId,
                        size: fileStat.size,
                        modified: new Date(fileStat.mtimeMs),
                        entryCount
                    });
                }
            }
            catch {
                // Skip unreadable dirs
            }
        }
    }
    catch {
        // Projects dir unreadable
    }
    // Sort by modification time descending
    sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
    return sessions.slice(0, limit);
}
// --- CLI ---
function formatBytes(bytes) {
    if (bytes < 1024)
        return `${bytes}B`;
    if (bytes < 1024 * 1024)
        return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
function printUsage() {
    console.log(`tav repair — Session Repair Tool

Usage:
  tav repair <session-id-prefix>        Repair by session ID prefix
  tav repair <path/to/session.jsonl>    Repair by full path
  tav list [--recent N]                 List sessions

Options:
  --dry-run        Preview changes without modifying
  --interval N     Insert every N assistant entries (default: 1)
  --verify         Validate chain integrity after repair (default: on)
  --no-verify      Skip validation
  --marker CHAR    Bookmark marker (default: ·)

WARNING: CC loading repaired sessions as rewind points is UNVERIFIED.
Always test on a non-critical session first.`);
}
async function main() {
    const args = process.argv.slice(2);
    if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
        printUsage();
        return;
    }
    // Parse command
    const command = args[0];
    if (command === 'list') {
        const recentIdx = args.indexOf('--recent');
        const limit = recentIdx !== -1 ? parseInt(args[recentIdx + 1], 10) || 10 : 10;
        const sessions = listSessions(limit);
        if (sessions.length === 0) {
            console.log('No sessions found in ~/.claude/projects/');
            return;
        }
        console.log(`Recent sessions (${sessions.length}):`);
        console.log('');
        for (const s of sessions) {
            const prefix = s.sessionId.slice(0, 8);
            const age = Math.floor((Date.now() - s.modified.getTime()) / (1000 * 60 * 60));
            const ageStr = age < 24 ? `${age}h ago` : `${Math.floor(age / 24)}d ago`;
            console.log(`  ${prefix}  ${formatBytes(s.size).padStart(8)}  ${String(s.entryCount).padStart(5)} entries  ${ageStr.padStart(8)}`);
            console.log(`           ${s.path}`);
        }
        return;
    }
    // Parse options
    const options = { ...exports.DEFAULT_REPAIR_OPTIONS };
    for (let i = 1; i < args.length; i++) {
        switch (args[i]) {
            case '--dry-run':
                options.dryRun = true;
                break;
            case '--interval':
                options.interval = parseInt(args[++i], 10) || 1;
                break;
            case '--verify':
                options.verify = true;
                break;
            case '--no-verify':
                options.verify = false;
                break;
            case '--marker':
                options.marker = args[++i] || '\u00B7';
                break;
        }
    }
    // Resolve file path
    let filePath;
    if (command.endsWith('.jsonl') || command.includes('/')) {
        // Direct path
        filePath = command;
        if (!(0, fs_1.existsSync)(filePath)) {
            console.error(`File not found: ${filePath}`);
            process.exit(1);
        }
    }
    else {
        // Session ID prefix
        const matches = resolveSessionFiles(command);
        if (matches.length === 0) {
            console.error(`No sessions found matching prefix: ${command}`);
            process.exit(1);
        }
        if (matches.length > 1) {
            console.error(`Multiple sessions match prefix "${command}":`);
            for (const m of matches) {
                const name = (0, path_1.basename)(m, '.jsonl');
                console.error(`  ${name.slice(0, 8)}  ${m}`);
            }
            console.error('\nProvide a longer prefix or use the full path.');
            process.exit(1);
        }
        filePath = matches[0];
    }
    console.log(`Repairing: ${filePath}`);
    console.log(`Options: interval=${options.interval}, dryRun=${options.dryRun}, verify=${options.verify}`);
    console.log('');
    const result = repair(filePath, options);
    // Report
    if (result.errors.length > 0) {
        console.error('Errors:');
        for (const err of result.errors) {
            console.error(`  ✘ ${err}`);
        }
    }
    for (const warn of result.warnings) {
        console.log(`  ⚠ ${warn}`);
    }
    if (result.inserted > 0 && result.errors.length === 0) {
        console.log('');
        console.log(`Inserted ${result.inserted} rewind points.`);
        if (result.backupPath) {
            console.log(`Backup: ${result.backupPath}`);
        }
    }
    process.exit(result.errors.length > 0 ? 1 : 0);
}
if (require.main === module) {
    main();
}
