"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const bun_test_1 = require("bun:test");
const fs_1 = require("fs");
const path_1 = require("path");
const os_1 = require("os");
const config_1 = require("../src/lib/config");
(0, bun_test_1.describe)('config loader', () => {
    let tempDir;
    let configPath;
    (0, bun_test_1.beforeEach)(() => {
        // Create unique temp directory for each test
        tempDir = (0, path_1.join)((0, os_1.tmpdir)(), `tav-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        (0, fs_1.mkdirSync)(tempDir, { recursive: true });
        configPath = (0, path_1.join)(tempDir, 'config.json');
    });
    (0, bun_test_1.afterEach)(() => {
        // Clean up temp directory
        if ((0, fs_1.existsSync)(tempDir)) {
            (0, fs_1.rmSync)(tempDir, { recursive: true, force: true });
        }
    });
    (0, bun_test_1.test)('loadConfig returns DEFAULT_CONFIG when no config file exists', () => {
        const config = (0, config_1.loadConfig)(configPath);
        (0, bun_test_1.expect)(config).toEqual(config_1.DEFAULT_CONFIG);
    });
    (0, bun_test_1.test)('loadConfig deep merges partial config', () => {
        const partialConfig = {
            bookmarks: {
                enabled: false,
                marker: '★',
                thresholds: {
                    minTokens: 20000,
                    // Intentionally omit other threshold fields to test deep merge
                },
            },
        };
        (0, fs_1.writeFileSync)(configPath, JSON.stringify(partialConfig), 'utf-8');
        const config = (0, config_1.loadConfig)(configPath);
        // User overrides should be applied
        (0, bun_test_1.expect)(config.bookmarks.enabled).toBe(false);
        (0, bun_test_1.expect)(config.bookmarks.marker).toBe('★');
        (0, bun_test_1.expect)(config.bookmarks.thresholds.minTokens).toBe(20000);
        // Missing fields should fall back to defaults
        (0, bun_test_1.expect)(config.bookmarks.thresholds.minToolCalls).toBe(config_1.DEFAULT_CONFIG.bookmarks.thresholds.minToolCalls);
        (0, bun_test_1.expect)(config.bookmarks.thresholds.minSeconds).toBe(config_1.DEFAULT_CONFIG.bookmarks.thresholds.minSeconds);
        (0, bun_test_1.expect)(config.bookmarks.thresholds.agentBurstThreshold).toBe(config_1.DEFAULT_CONFIG.bookmarks.thresholds.agentBurstThreshold);
        (0, bun_test_1.expect)(config.bookmarks.thresholds.cooldownSeconds).toBe(config_1.DEFAULT_CONFIG.bookmarks.thresholds.cooldownSeconds);
    });
    (0, bun_test_1.test)('loadConfig returns defaults for invalid JSON', () => {
        (0, fs_1.writeFileSync)(configPath, '{ invalid json content }', 'utf-8');
        const config = (0, config_1.loadConfig)(configPath);
        (0, bun_test_1.expect)(config).toEqual(config_1.DEFAULT_CONFIG);
    });
    (0, bun_test_1.test)('loadConfig returns defaults for empty file', () => {
        (0, fs_1.writeFileSync)(configPath, '', 'utf-8');
        const config = (0, config_1.loadConfig)(configPath);
        (0, bun_test_1.expect)(config).toEqual(config_1.DEFAULT_CONFIG);
    });
    (0, bun_test_1.test)('DEFAULT_CONFIG has correct default values', () => {
        (0, bun_test_1.expect)(config_1.DEFAULT_CONFIG.bookmarks.enabled).toBe(true);
        (0, bun_test_1.expect)(config_1.DEFAULT_CONFIG.bookmarks.marker).toBe('\u00B7');
        (0, bun_test_1.expect)(config_1.DEFAULT_CONFIG.bookmarks.thresholds.minTokens).toBe(10000);
        (0, bun_test_1.expect)(config_1.DEFAULT_CONFIG.bookmarks.thresholds.minToolCalls).toBe(15);
        (0, bun_test_1.expect)(config_1.DEFAULT_CONFIG.bookmarks.thresholds.minSeconds).toBe(300);
        (0, bun_test_1.expect)(config_1.DEFAULT_CONFIG.bookmarks.thresholds.agentBurstThreshold).toBe(5);
        (0, bun_test_1.expect)(config_1.DEFAULT_CONFIG.bookmarks.thresholds.cooldownSeconds).toBe(30);
    });
});
