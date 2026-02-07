"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const bun_test_1 = require("bun:test");
const fs_1 = require("fs");
const path_1 = require("path");
const os_1 = require("os");
const log_1 = require("../src/lib/log");
(0, bun_test_1.describe)('log', () => {
    let testDir;
    (0, bun_test_1.beforeEach)(() => {
        testDir = (0, path_1.join)((0, os_1.tmpdir)(), `tav-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        (0, fs_1.mkdirSync)(testDir, { recursive: true });
    });
    (0, bun_test_1.afterEach)(() => {
        try {
            (0, fs_1.rmSync)(testDir, { recursive: true, force: true });
        }
        catch {
            // Ignore cleanup errors
        }
    });
    (0, bun_test_1.test)('sanitizeSessionId replaces invalid chars', () => {
        (0, bun_test_1.expect)((0, log_1.sanitizeSessionId)('abc-123_def')).toBe('abc-123_def');
        (0, bun_test_1.expect)((0, log_1.sanitizeSessionId)('abc/123\\def')).toBe('abc_123_def');
        (0, bun_test_1.expect)((0, log_1.sanitizeSessionId)('abc.123:def')).toBe('abc_123_def');
        (0, bun_test_1.expect)((0, log_1.sanitizeSessionId)('abc@123#def')).toBe('abc_123_def');
        (0, bun_test_1.expect)((0, log_1.sanitizeSessionId)('hello world!')).toBe('hello_world_');
    });
    (0, bun_test_1.test)('appendEvent creates file and appends lines', () => {
        const sessionId = 'test-session';
        (0, log_1.appendEvent)(sessionId, 'T 1000 100', testDir);
        (0, log_1.appendEvent)(sessionId, 'A 2000 200', testDir);
        (0, log_1.appendEvent)(sessionId, 'I 3000', testDir);
        const metrics = (0, log_1.parseLog)(sessionId, testDir);
        (0, bun_test_1.expect)(metrics.toolCalls).toBe(1);
        (0, bun_test_1.expect)(metrics.agentReturns).toBe(1);
        (0, bun_test_1.expect)(metrics.lastInjectionAt).toBe(3000);
    });
    (0, bun_test_1.test)('parseLog returns zero metrics for missing file', () => {
        const metrics = (0, log_1.parseLog)('nonexistent-session', testDir);
        (0, bun_test_1.expect)(metrics.toolCalls).toBe(0);
        (0, bun_test_1.expect)(metrics.agentReturns).toBe(0);
        (0, bun_test_1.expect)(metrics.estimatedTokens).toBe(0);
        (0, bun_test_1.expect)(metrics.elapsedSeconds).toBe(0);
        (0, bun_test_1.expect)(metrics.lastInjectionAt).toBe(0);
        (0, bun_test_1.expect)(metrics.lastBookmarkAt).toBe(0);
        (0, bun_test_1.expect)(metrics.lastLineIsBookmark).toBe(false);
    });
    (0, bun_test_1.test)('parseLog counts T and A lines correctly', () => {
        const sessionId = 'count-test';
        (0, log_1.appendEvent)(sessionId, 'T 1000 100', testDir);
        (0, log_1.appendEvent)(sessionId, 'T 2000 150', testDir);
        (0, log_1.appendEvent)(sessionId, 'A 3000 200', testDir);
        (0, log_1.appendEvent)(sessionId, 'T 4000 120', testDir);
        (0, log_1.appendEvent)(sessionId, 'A 5000 180', testDir);
        const metrics = (0, log_1.parseLog)(sessionId, testDir);
        (0, bun_test_1.expect)(metrics.toolCalls).toBe(3);
        (0, bun_test_1.expect)(metrics.agentReturns).toBe(2);
    });
    (0, bun_test_1.test)('parseLog resets counters after B line', () => {
        const sessionId = 'bookmark-test';
        (0, log_1.appendEvent)(sessionId, 'T 1000 100', testDir);
        (0, log_1.appendEvent)(sessionId, 'A 2000 200', testDir);
        (0, log_1.appendEvent)(sessionId, 'B 3000', testDir);
        (0, log_1.appendEvent)(sessionId, 'T 4000 150', testDir);
        (0, log_1.appendEvent)(sessionId, 'T 5000 120', testDir);
        const metrics = (0, log_1.parseLog)(sessionId, testDir);
        // Only count lines after bookmark
        (0, bun_test_1.expect)(metrics.toolCalls).toBe(2);
        (0, bun_test_1.expect)(metrics.agentReturns).toBe(0);
    });
    (0, bun_test_1.test)('parseLog calculates estimatedTokens from charCounts', () => {
        const sessionId = 'tokens-test';
        (0, log_1.appendEvent)(sessionId, 'T 1000 400', testDir); // 100 tokens
        (0, log_1.appendEvent)(sessionId, 'A 2000 800', testDir); // 200 tokens
        (0, log_1.appendEvent)(sessionId, 'T 3000 200', testDir); // 50 tokens
        const metrics = (0, log_1.parseLog)(sessionId, testDir);
        (0, bun_test_1.expect)(metrics.estimatedTokens).toBe(350); // (400 + 800 + 200) / 4
    });
    (0, bun_test_1.test)('parseLog calculates elapsedSeconds', () => {
        const sessionId = 'elapsed-test';
        const startTime = 1000000;
        const endTime = 1005000; // 5 seconds later
        (0, log_1.appendEvent)(sessionId, `T ${startTime} 100`, testDir);
        (0, log_1.appendEvent)(sessionId, `A ${endTime} 200`, testDir);
        const metrics = (0, log_1.parseLog)(sessionId, testDir);
        (0, bun_test_1.expect)(metrics.elapsedSeconds).toBe(5);
    });
    (0, bun_test_1.test)('parseLog tracks lastInjectionAt and lastBookmarkAt', () => {
        const sessionId = 'tracking-test';
        (0, log_1.appendEvent)(sessionId, 'I 1000', testDir);
        (0, log_1.appendEvent)(sessionId, 'T 2000 100', testDir);
        (0, log_1.appendEvent)(sessionId, 'I 3000', testDir);
        (0, log_1.appendEvent)(sessionId, 'B 4000', testDir);
        (0, log_1.appendEvent)(sessionId, 'I 5000', testDir);
        (0, log_1.appendEvent)(sessionId, 'B 6000', testDir);
        const metrics = (0, log_1.parseLog)(sessionId, testDir);
        (0, bun_test_1.expect)(metrics.lastInjectionAt).toBe(5000);
        (0, bun_test_1.expect)(metrics.lastBookmarkAt).toBe(6000);
    });
    (0, bun_test_1.test)('parseLog detects lastLineIsBookmark', () => {
        const sessionId = 'last-line-test';
        (0, log_1.appendEvent)(sessionId, 'T 1000 100', testDir);
        (0, log_1.appendEvent)(sessionId, 'A 2000 200', testDir);
        let metrics = (0, log_1.parseLog)(sessionId, testDir);
        (0, bun_test_1.expect)(metrics.lastLineIsBookmark).toBe(false);
        (0, log_1.appendEvent)(sessionId, 'B 3000', testDir);
        metrics = (0, log_1.parseLog)(sessionId, testDir);
        (0, bun_test_1.expect)(metrics.lastLineIsBookmark).toBe(true);
    });
    (0, bun_test_1.test)('cleanOldSessions removes old files', () => {
        const now = Date.now();
        const oldTime = now - (10 * 24 * 60 * 60 * 1000); // 10 days ago
        // Create old log file
        const oldLogPath = (0, path_1.join)(testDir, 'old-session.log');
        (0, fs_1.writeFileSync)(oldLogPath, 'T 1000 100\n');
        (0, fs_1.utimesSync)(oldLogPath, new Date(oldTime), new Date(oldTime));
        // Create old json file
        const oldJsonPath = (0, path_1.join)(testDir, 'old-session.json');
        (0, fs_1.writeFileSync)(oldJsonPath, '{}');
        (0, fs_1.utimesSync)(oldJsonPath, new Date(oldTime), new Date(oldTime));
        // Create recent file
        const recentLogPath = (0, path_1.join)(testDir, 'recent-session.log');
        (0, fs_1.writeFileSync)(recentLogPath, 'T 2000 200\n');
        // Clean with 7 day threshold
        (0, log_1.cleanOldSessions)(7, testDir);
        // Verify old files removed and recent file kept
        (0, bun_test_1.expect)((0, log_1.parseLog)('old-session', testDir).toolCalls).toBe(0); // File missing, returns zero metrics
        (0, bun_test_1.expect)((0, log_1.parseLog)('recent-session', testDir).toolCalls).toBe(1); // File exists
    });
});
