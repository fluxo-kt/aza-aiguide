"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const bun_test_1 = require("bun:test");
const bookmark_stop_1 = require("../src/bookmark-stop");
const config_1 = require("../src/lib/config");
function defaultMetrics() {
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
(0, bun_test_1.describe)('evaluateBookmark', () => {
    (0, bun_test_1.test)('returns shouldInject false when bookmarks disabled', () => {
        const config = {
            ...config_1.DEFAULT_CONFIG,
            bookmarks: {
                ...config_1.DEFAULT_CONFIG.bookmarks,
                enabled: false
            }
        };
        const metrics = defaultMetrics();
        const data = {};
        const result = (0, bookmark_stop_1.evaluateBookmark)(data, config, metrics, 'tmux');
        (0, bun_test_1.expect)(result.shouldInject).toBe(false);
        (0, bun_test_1.expect)(result.reason).toBe('bookmarks disabled in config');
    });
    (0, bun_test_1.test)('returns shouldInject false when injection method is disabled', () => {
        const config = config_1.DEFAULT_CONFIG;
        const metrics = defaultMetrics();
        const data = {};
        const result = (0, bookmark_stop_1.evaluateBookmark)(data, config, metrics, 'disabled');
        (0, bun_test_1.expect)(result.shouldInject).toBe(false);
        (0, bun_test_1.expect)(result.reason).toBe('injection method is disabled');
    });
    (0, bun_test_1.test)('returns shouldInject false on context limit stop', () => {
        const config = config_1.DEFAULT_CONFIG;
        const metrics = defaultMetrics();
        const data = { stop_reason: 'context_limit' };
        const result = (0, bookmark_stop_1.evaluateBookmark)(data, config, metrics, 'tmux');
        (0, bun_test_1.expect)(result.shouldInject).toBe(false);
        (0, bun_test_1.expect)(result.reason).toBe('context limit stop detected');
    });
    (0, bun_test_1.test)('returns shouldInject false on user abort', () => {
        const config = config_1.DEFAULT_CONFIG;
        const metrics = defaultMetrics();
        const data = { stop_reason: 'abort' };
        const result = (0, bookmark_stop_1.evaluateBookmark)(data, config, metrics, 'tmux');
        (0, bun_test_1.expect)(result.shouldInject).toBe(false);
        (0, bun_test_1.expect)(result.reason).toBe('user abort detected');
    });
    (0, bun_test_1.test)('returns shouldInject false when last line is bookmark', () => {
        const config = config_1.DEFAULT_CONFIG;
        const metrics = {
            ...defaultMetrics(),
            lastLineIsBookmark: true
        };
        const data = {};
        const result = (0, bookmark_stop_1.evaluateBookmark)(data, config, metrics, 'tmux');
        (0, bun_test_1.expect)(result.shouldInject).toBe(false);
        (0, bun_test_1.expect)(result.reason).toBe('last line is already a bookmark');
    });
    (0, bun_test_1.test)('returns shouldInject false during cooldown', () => {
        const config = config_1.DEFAULT_CONFIG;
        const metrics = {
            ...defaultMetrics(),
            lastBookmarkAt: Date.now() - 5000, // 5 seconds ago, within 30s cooldown
            estimatedTokens: 20000 // High tokens but within cooldown
        };
        const data = {};
        const result = (0, bookmark_stop_1.evaluateBookmark)(data, config, metrics, 'tmux');
        (0, bun_test_1.expect)(result.shouldInject).toBe(false);
        (0, bun_test_1.expect)(result.reason).toBe('within cooldown period');
    });
    (0, bun_test_1.test)('returns shouldInject true when token threshold met', () => {
        const config = config_1.DEFAULT_CONFIG;
        const metrics = {
            ...defaultMetrics(),
            estimatedTokens: 15000 // >= 10000
        };
        const data = {};
        const result = (0, bookmark_stop_1.evaluateBookmark)(data, config, metrics, 'tmux');
        (0, bun_test_1.expect)(result.shouldInject).toBe(true);
        (0, bun_test_1.expect)(result.reason).toContain('token threshold met');
    });
    (0, bun_test_1.test)('returns shouldInject true when tool call threshold met', () => {
        const config = config_1.DEFAULT_CONFIG;
        const metrics = {
            ...defaultMetrics(),
            toolCalls: 20 // >= 15
        };
        const data = {};
        const result = (0, bookmark_stop_1.evaluateBookmark)(data, config, metrics, 'tmux');
        (0, bun_test_1.expect)(result.shouldInject).toBe(true);
        (0, bun_test_1.expect)(result.reason).toContain('tool call threshold met');
    });
    (0, bun_test_1.test)('returns shouldInject true when time threshold met', () => {
        const config = config_1.DEFAULT_CONFIG;
        const metrics = {
            ...defaultMetrics(),
            elapsedSeconds: 400 // >= 300
        };
        const data = {};
        const result = (0, bookmark_stop_1.evaluateBookmark)(data, config, metrics, 'tmux');
        (0, bun_test_1.expect)(result.shouldInject).toBe(true);
        (0, bun_test_1.expect)(result.reason).toContain('time threshold met');
    });
    (0, bun_test_1.test)('returns shouldInject true when agent burst threshold met', () => {
        const config = config_1.DEFAULT_CONFIG;
        const metrics = {
            ...defaultMetrics(),
            agentReturns: 6 // >= 5
        };
        const data = {};
        const result = (0, bookmark_stop_1.evaluateBookmark)(data, config, metrics, 'tmux');
        (0, bun_test_1.expect)(result.shouldInject).toBe(true);
        (0, bun_test_1.expect)(result.reason).toContain('agent burst threshold met');
    });
    (0, bun_test_1.test)('returns shouldInject false when no threshold met', () => {
        const config = config_1.DEFAULT_CONFIG;
        const metrics = {
            ...defaultMetrics(),
            toolCalls: 5,
            estimatedTokens: 2000,
            elapsedSeconds: 100,
            agentReturns: 2
        };
        const data = {};
        const result = (0, bookmark_stop_1.evaluateBookmark)(data, config, metrics, 'tmux');
        (0, bun_test_1.expect)(result.shouldInject).toBe(false);
        (0, bun_test_1.expect)(result.reason).toBe('no threshold met');
    });
    (0, bun_test_1.test)('guard conditions take priority over thresholds', () => {
        const config = {
            ...config_1.DEFAULT_CONFIG,
            bookmarks: {
                ...config_1.DEFAULT_CONFIG.bookmarks,
                enabled: false
            }
        };
        const metrics = {
            ...defaultMetrics(),
            estimatedTokens: 20000, // High tokens
            toolCalls: 50, // High tool calls
            elapsedSeconds: 500, // High time
            agentReturns: 10 // High agent returns
        };
        const data = {};
        const result = (0, bookmark_stop_1.evaluateBookmark)(data, config, metrics, 'tmux');
        (0, bun_test_1.expect)(result.shouldInject).toBe(false);
        (0, bun_test_1.expect)(result.reason).toBe('bookmarks disabled in config');
    });
});
