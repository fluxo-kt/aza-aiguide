"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sanitizeSessionId = sanitizeSessionId;
exports.getLogPath = getLogPath;
exports.ensureStateDir = ensureStateDir;
exports.appendEvent = appendEvent;
exports.parseLog = parseLog;
exports.cleanOldSessions = cleanOldSessions;
const fs_1 = require("fs");
const path_1 = require("path");
const os_1 = require("os");
const DEFAULT_STATE_DIR = (0, path_1.join)((0, os_1.homedir)(), '.claude', 'tav', 'state');
function sanitizeSessionId(sessionId) {
    // Truncate to 200 chars to prevent ENAMETOOLONG (255 limit minus .json/.log suffix)
    return sessionId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 200);
}
function getLogPath(sessionId, stateDir = DEFAULT_STATE_DIR) {
    return (0, path_1.join)(stateDir, `${sanitizeSessionId(sessionId)}.log`);
}
function ensureStateDir(stateDir = DEFAULT_STATE_DIR) {
    (0, fs_1.mkdirSync)(stateDir, { recursive: true });
}
function appendEvent(sessionId, line, stateDir = DEFAULT_STATE_DIR) {
    ensureStateDir(stateDir);
    (0, fs_1.appendFileSync)(getLogPath(sessionId, stateDir), `${line}\n`);
}
function parseLog(sessionId, stateDir = DEFAULT_STATE_DIR) {
    const logPath = getLogPath(sessionId, stateDir);
    let content;
    try {
        content = (0, fs_1.readFileSync)(logPath, 'utf-8');
    }
    catch {
        return {
            toolCalls: 0,
            agentReturns: 0,
            estimatedTokens: 0,
            elapsedSeconds: 0,
            lastInjectionAt: 0,
            lastBookmarkAt: 0,
            lastLineIsBookmark: false
        };
    }
    const lines = content.split('\n').filter(l => l.trim());
    // Find last bookmark index
    let lastBookmarkIdx = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i].startsWith('B ')) {
            lastBookmarkIdx = i;
            break;
        }
    }
    // Only count lines after last bookmark
    const relevantLines = lastBookmarkIdx === -1
        ? lines
        : lines.slice(lastBookmarkIdx + 1);
    let toolCalls = 0;
    let agentReturns = 0;
    let totalCharCount = 0;
    let firstTimestamp = 0;
    let lastTimestamp = 0;
    let lastInjectionAt = 0;
    let lastBookmarkAt = 0;
    // Parse all lines for lastInjectionAt and lastBookmarkAt
    for (const line of lines) {
        const parts = line.split(' ');
        const type = parts[0];
        const timestamp = parseInt(parts[1], 10);
        if (isNaN(timestamp))
            continue;
        if (type === 'I') {
            lastInjectionAt = Math.max(lastInjectionAt, timestamp);
        }
        else if (type === 'B') {
            lastBookmarkAt = Math.max(lastBookmarkAt, timestamp);
        }
    }
    // Parse relevant lines for metrics
    for (const line of relevantLines) {
        const parts = line.split(' ');
        const type = parts[0];
        const timestamp = parseInt(parts[1], 10);
        if (isNaN(timestamp))
            continue;
        const rawCharCount = parts[2] ? parseInt(parts[2], 10) : 0;
        const charCount = isNaN(rawCharCount) ? 0 : rawCharCount;
        if (type === 'T') {
            toolCalls++;
            totalCharCount += charCount;
            if (firstTimestamp === 0)
                firstTimestamp = timestamp;
            lastTimestamp = Math.max(lastTimestamp, timestamp);
        }
        else if (type === 'A') {
            agentReturns++;
            totalCharCount += charCount;
            if (firstTimestamp === 0)
                firstTimestamp = timestamp;
            lastTimestamp = Math.max(lastTimestamp, timestamp);
        }
    }
    const estimatedTokens = Math.floor(totalCharCount / 4);
    const elapsedSeconds = firstTimestamp > 0
        ? Math.floor((Date.now() - firstTimestamp) / 1000)
        : 0;
    const lastLineIsBookmark = lines.length > 0 && lines[lines.length - 1].startsWith('B ');
    return {
        toolCalls,
        agentReturns,
        estimatedTokens,
        elapsedSeconds,
        lastInjectionAt,
        lastBookmarkAt,
        lastLineIsBookmark
    };
}
function cleanOldSessions(maxAgeDays = 7, stateDir = DEFAULT_STATE_DIR) {
    try {
        const files = (0, fs_1.readdirSync)(stateDir);
        const cutoffTime = Date.now() - (maxAgeDays * 24 * 60 * 60 * 1000);
        for (const file of files) {
            if (!file.endsWith('.log') && !file.endsWith('.json'))
                continue;
            const filePath = (0, path_1.join)(stateDir, file);
            try {
                const stats = (0, fs_1.statSync)(filePath);
                if (stats.mtimeMs < cutoffTime) {
                    (0, fs_1.unlinkSync)(filePath);
                }
            }
            catch {
                // Silently ignore errors
            }
        }
    }
    catch {
        // Silently ignore errors
    }
}
