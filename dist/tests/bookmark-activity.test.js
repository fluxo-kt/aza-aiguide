"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const bun_test_1 = require("bun:test");
const fs_1 = require("fs");
const path_1 = require("path");
const os_1 = require("os");
const bookmark_activity_1 = require("../src/bookmark-activity");
const log_1 = require("../src/lib/log");
const TEST_SESSION_ID = 'test-session-123';
function createTestEnv() {
    const testDir = (0, path_1.join)((0, os_1.tmpdir)(), `bookmark-test-${Date.now()}`);
    const stateDir = (0, path_1.join)(testDir, 'state');
    const logDir = (0, path_1.join)(testDir, 'logs');
    (0, fs_1.mkdirSync)(stateDir, { recursive: true });
    (0, fs_1.mkdirSync)(logDir, { recursive: true });
    return { testDir, stateDir, logDir };
}
function cleanup(testDir) {
    try {
        (0, fs_1.rmSync)(testDir, { recursive: true, force: true });
    }
    catch {
        // Ignore cleanup errors
    }
}
function getLogPath(sessionId, logDir) {
    return (0, path_1.join)(logDir, `${(0, log_1.sanitizeSessionId)(sessionId)}.log`);
}
function readLog(sessionId, logDir) {
    const path = getLogPath(sessionId, logDir);
    if (!(0, fs_1.existsSync)(path)) {
        return '';
    }
    return (0, fs_1.readFileSync)(path, 'utf-8');
}
function writeSessionConfig(sessionId, stateDir, config) {
    const sanitized = (0, log_1.sanitizeSessionId)(sessionId);
    const path = (0, path_1.join)(stateDir, `${sanitized}.json`);
    (0, fs_1.writeFileSync)(path, JSON.stringify(config, null, 2));
}
(0, bun_test_1.describe)('bookmark-activity', () => {
    let testDir;
    let stateDir;
    let logDir;
    (0, bun_test_1.beforeEach)(() => {
        const env = createTestEnv();
        testDir = env.testDir;
        stateDir = env.stateDir;
        logDir = env.logDir;
    });
    (0, bun_test_1.afterEach)(() => {
        cleanup(testDir);
    });
    (0, bun_test_1.describe)('handlePostToolUse', () => {
        (0, bun_test_1.test)('appends T line with correct format', () => {
            const data = { tool_response: 'test output' };
            (0, bookmark_activity_1.handlePostToolUse)(TEST_SESSION_ID, data, logDir);
            const log = readLog(TEST_SESSION_ID, logDir);
            const lines = log.trim().split('\n');
            const lastLine = lines[lines.length - 1];
            (0, bun_test_1.expect)(lastLine).toMatch(/^T \d+ \d+$/);
        });
        (0, bun_test_1.test)('captures tool_response length', () => {
            const testContent = 'x'.repeat(1234);
            const data = { tool_response: testContent };
            (0, bookmark_activity_1.handlePostToolUse)(TEST_SESSION_ID, data, logDir);
            const log = readLog(TEST_SESSION_ID, logDir);
            const lines = log.trim().split('\n');
            const lastLine = lines[lines.length - 1];
            const parts = lastLine.split(' ');
            (0, bun_test_1.expect)(parts[0]).toBe('T');
            (0, bun_test_1.expect)(parts[2]).toBe('1234');
        });
        (0, bun_test_1.test)('handles toolResponse variant', () => {
            const data = { toolResponse: 'test' };
            (0, bookmark_activity_1.handlePostToolUse)(TEST_SESSION_ID, data, logDir);
            const log = readLog(TEST_SESSION_ID, logDir);
            (0, bun_test_1.expect)(log).toContain('T ');
        });
        (0, bun_test_1.test)('handles toolOutput variant', () => {
            const data = { toolOutput: 'test' };
            (0, bookmark_activity_1.handlePostToolUse)(TEST_SESSION_ID, data, logDir);
            const log = readLog(TEST_SESSION_ID, logDir);
            (0, bun_test_1.expect)(log).toContain('T ');
        });
    });
    (0, bun_test_1.describe)('handleSubagentStop', () => {
        (0, bun_test_1.test)('appends A line with correct format', () => {
            writeSessionConfig(TEST_SESSION_ID, stateDir, {
                injectionMethod: 'disabled',
                injectionTarget: ''
            });
            const data = { output: 'agent result' };
            (0, bookmark_activity_1.handleSubagentStop)(TEST_SESSION_ID, data, logDir, stateDir);
            const log = readLog(TEST_SESSION_ID, logDir);
            const lines = log.trim().split('\n');
            const lastLine = lines[lines.length - 1];
            (0, bun_test_1.expect)(lastLine).toMatch(/^A \d+ \d+$/);
        });
        (0, bun_test_1.test)('does not trigger below threshold', () => {
            writeSessionConfig(TEST_SESSION_ID, stateDir, {
                injectionMethod: 'tmux',
                injectionTarget: '%1'
            });
            // Add 2 A lines (threshold is 5)
            const data = { output: 'test' };
            (0, bookmark_activity_1.handleSubagentStop)(TEST_SESSION_ID, data, logDir, stateDir);
            const result = (0, bookmark_activity_1.handleSubagentStop)(TEST_SESSION_ID, data, logDir, stateDir);
            (0, bun_test_1.expect)(result).toBe(false);
            const log = readLog(TEST_SESSION_ID, logDir);
            const lines = log.trim().split('\n');
            const iLines = lines.filter(line => line.startsWith('I '));
            (0, bun_test_1.expect)(iLines.length).toBe(0);
        });
        (0, bun_test_1.test)('triggers injection at burst threshold', () => {
            writeSessionConfig(TEST_SESSION_ID, stateDir, {
                injectionMethod: 'tmux',
                injectionTarget: '%1'
            });
            const data = { output: 'test' };
            // Add 4 A lines first
            for (let i = 0; i < 4; i++) {
                (0, bookmark_activity_1.handleSubagentStop)(TEST_SESSION_ID, data, logDir, stateDir);
            }
            // 5th call should trigger injection (threshold is 5)
            const result = (0, bookmark_activity_1.handleSubagentStop)(TEST_SESSION_ID, data, logDir, stateDir);
            (0, bun_test_1.expect)(result).toBe(true);
            const log = readLog(TEST_SESSION_ID, logDir);
            const lines = log.trim().split('\n');
            const iLines = lines.filter(line => line.startsWith('I '));
            (0, bun_test_1.expect)(iLines.length).toBe(1);
        });
        (0, bun_test_1.test)('respects cooldown', () => {
            writeSessionConfig(TEST_SESSION_ID, stateDir, {
                injectionMethod: 'tmux',
                injectionTarget: '%1'
            });
            // Manually add an I line within cooldown period (30 seconds default)
            const logPath = getLogPath(TEST_SESSION_ID, logDir);
            const nowMs = Date.now();
            (0, fs_1.writeFileSync)(logPath, `I ${nowMs}\n`);
            const data = { output: 'test' };
            // Add enough A lines to exceed threshold
            for (let i = 0; i < 5; i++) {
                const result = (0, bookmark_activity_1.handleSubagentStop)(TEST_SESSION_ID, data, logDir, stateDir);
                // Should not trigger because we're within cooldown
                (0, bun_test_1.expect)(result).toBe(false);
            }
            const log = readLog(TEST_SESSION_ID, logDir);
            const lines = log.trim().split('\n');
            const iLines = lines.filter(line => line.startsWith('I '));
            // Should still be just 1 I line (the one we wrote manually)
            (0, bun_test_1.expect)(iLines.length).toBe(1);
        });
        (0, bun_test_1.test)('does not trigger when injection method is disabled', () => {
            writeSessionConfig(TEST_SESSION_ID, stateDir, {
                injectionMethod: 'disabled',
                injectionTarget: ''
            });
            const data = { output: 'test' };
            // Add 5 A lines to exceed threshold
            for (let i = 0; i < 5; i++) {
                (0, bookmark_activity_1.handleSubagentStop)(TEST_SESSION_ID, data, logDir, stateDir);
            }
            const result = (0, bookmark_activity_1.handleSubagentStop)(TEST_SESSION_ID, data, logDir, stateDir);
            (0, bun_test_1.expect)(result).toBe(false);
            const log = readLog(TEST_SESSION_ID, logDir);
            const lines = log.trim().split('\n');
            const iLines = lines.filter(line => line.startsWith('I '));
            (0, bun_test_1.expect)(iLines.length).toBe(0);
        });
        (0, bun_test_1.test)('does not trigger when session config missing', () => {
            const data = { output: 'test' };
            // Add 5 A lines to exceed threshold
            for (let i = 0; i < 5; i++) {
                (0, bookmark_activity_1.handleSubagentStop)(TEST_SESSION_ID, data, logDir, stateDir);
            }
            const result = (0, bookmark_activity_1.handleSubagentStop)(TEST_SESSION_ID, data, logDir, stateDir);
            (0, bun_test_1.expect)(result).toBe(false);
        });
    });
});
