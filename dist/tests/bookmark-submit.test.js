"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const bun_test_1 = require("bun:test");
const bookmark_submit_1 = require("../src/bookmark-submit");
const log_1 = require("../src/lib/log");
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const os = __importStar(require("node:os"));
(0, bun_test_1.describe)('processBookmark', () => {
    const marker = '\u00B7';
    const sessionId = 'test-session';
    const now = Date.now();
    (0, bun_test_1.test)('detects bookmark marker with recent injection', () => {
        const lastInjectionAt = now - 5000; // 5 seconds ago
        const { isBookmark, output } = (0, bookmark_submit_1.processBookmark)('·', sessionId, marker, lastInjectionAt, now);
        (0, bun_test_1.expect)(isBookmark).toBe(true);
        (0, bun_test_1.expect)(output.continue).toBe(true);
    });
    (0, bun_test_1.test)('returns additionalContext for bookmark', () => {
        const lastInjectionAt = now - 5000;
        const { isBookmark, output } = (0, bookmark_submit_1.processBookmark)('·', sessionId, marker, lastInjectionAt, now);
        (0, bun_test_1.expect)(isBookmark).toBe(true);
        (0, bun_test_1.expect)(output.hookSpecificOutput).toBeDefined();
        (0, bun_test_1.expect)(output.hookSpecificOutput?.hookEventName).toBe('UserPromptSubmit');
        (0, bun_test_1.expect)(output.hookSpecificOutput?.additionalContext).toContain('system-reminder');
        (0, bun_test_1.expect)(output.hookSpecificOutput?.additionalContext).toContain('Automated navigation bookmark');
    });
    (0, bun_test_1.test)('passes through non-marker messages', () => {
        const lastInjectionAt = now - 5000;
        const { isBookmark, output } = (0, bookmark_submit_1.processBookmark)('hello', sessionId, marker, lastInjectionAt, now);
        (0, bun_test_1.expect)(isBookmark).toBe(false);
        (0, bun_test_1.expect)(output.continue).toBe(true);
        (0, bun_test_1.expect)(output.hookSpecificOutput).toBeUndefined();
    });
    (0, bun_test_1.test)('passes through when marker matches but no recent injection', () => {
        const lastInjectionAt = 0; // No injection ever
        const { isBookmark, output } = (0, bookmark_submit_1.processBookmark)('·', sessionId, marker, lastInjectionAt, now);
        (0, bun_test_1.expect)(isBookmark).toBe(false);
        (0, bun_test_1.expect)(output.continue).toBe(true);
        (0, bun_test_1.expect)(output.hookSpecificOutput).toBeUndefined();
    });
    (0, bun_test_1.test)('passes through when injection is too old', () => {
        const lastInjectionAt = now - 15000; // 15 seconds ago (> 10s threshold)
        const { isBookmark, output } = (0, bookmark_submit_1.processBookmark)('·', sessionId, marker, lastInjectionAt, now);
        (0, bun_test_1.expect)(isBookmark).toBe(false);
        (0, bun_test_1.expect)(output.continue).toBe(true);
        (0, bun_test_1.expect)(output.hookSpecificOutput).toBeUndefined();
    });
    (0, bun_test_1.test)('handles trimming of marker', () => {
        const lastInjectionAt = now - 5000;
        const { isBookmark, output } = (0, bookmark_submit_1.processBookmark)(' · ', sessionId, marker, lastInjectionAt, now);
        (0, bun_test_1.expect)(isBookmark).toBe(true);
        (0, bun_test_1.expect)(output.continue).toBe(true);
    });
    (0, bun_test_1.test)('returns continue:true in all cases', () => {
        const testCases = [
            { prompt: '·', lastInjectionAt: now - 5000 }, // bookmark
            { prompt: 'hello', lastInjectionAt: now - 5000 }, // not marker
            { prompt: '·', lastInjectionAt: 0 }, // no injection
            { prompt: '·', lastInjectionAt: now - 15000 }, // old injection
        ];
        for (const { prompt, lastInjectionAt } of testCases) {
            const { output } = (0, bookmark_submit_1.processBookmark)(prompt, sessionId, marker, lastInjectionAt, now);
            (0, bun_test_1.expect)(output.continue).toBe(true);
        }
    });
    (0, bun_test_1.test)('uses custom marker from config', () => {
        const customMarker = '###';
        const lastInjectionAt = now - 5000;
        const { isBookmark: isBookmark1 } = (0, bookmark_submit_1.processBookmark)('###', sessionId, customMarker, lastInjectionAt, now);
        (0, bun_test_1.expect)(isBookmark1).toBe(true);
        const { isBookmark: isBookmark2 } = (0, bookmark_submit_1.processBookmark)('·', sessionId, customMarker, lastInjectionAt, now);
        (0, bun_test_1.expect)(isBookmark2).toBe(false);
    });
});
(0, bun_test_1.describe)('bookmark-submit integration', () => {
    let tempDir;
    let originalLogDir;
    (0, bun_test_1.beforeEach)(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bookmark-test-'));
        originalLogDir = process.env.AIGUIDE_LOG_DIR;
        process.env.AIGUIDE_LOG_DIR = tempDir;
    });
    (0, bun_test_1.afterEach)(() => {
        if (originalLogDir) {
            process.env.AIGUIDE_LOG_DIR = originalLogDir;
        }
        else {
            delete process.env.AIGUIDE_LOG_DIR;
        }
        fs.rmSync(tempDir, { recursive: true, force: true });
    });
    (0, bun_test_1.test)('appends B line to log on bookmark', () => {
        const sessionId = 'integration-test';
        const logPath = path.join(tempDir, `${sessionId}.log`);
        // Simulate recent injection
        const injectionTime = Date.now() - 5000;
        (0, log_1.appendEvent)(sessionId, `I ${injectionTime}`, tempDir);
        // Verify I line exists
        const beforeContent = fs.readFileSync(logPath, 'utf8');
        (0, bun_test_1.expect)(beforeContent).toContain('I ');
        // Process bookmark
        const marker = '\u00B7';
        const lastInjectionAt = Date.now() - 5000;
        const { isBookmark } = (0, bookmark_submit_1.processBookmark)('·', sessionId, marker, lastInjectionAt);
        (0, bun_test_1.expect)(isBookmark).toBe(true);
        // Append B line (simulating what main() does)
        (0, log_1.appendEvent)(sessionId, `B ${Date.now()}`, tempDir);
        // Verify B line exists
        const afterContent = fs.readFileSync(logPath, 'utf8');
        (0, bun_test_1.expect)(afterContent).toContain('B ');
        const lines = afterContent.trim().split('\n');
        (0, bun_test_1.expect)(lines.length).toBe(2);
        (0, bun_test_1.expect)(lines[0]).toMatch(/^I \d+$/);
        (0, bun_test_1.expect)(lines[1]).toMatch(/^B \d+$/);
    });
});
