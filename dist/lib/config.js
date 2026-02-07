"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_CONFIG = void 0;
exports.loadConfig = loadConfig;
const fs_1 = require("fs");
const path_1 = require("path");
const os_1 = require("os");
exports.DEFAULT_CONFIG = {
    bookmarks: {
        enabled: true,
        marker: '\u00B7', // middle dot
        thresholds: {
            minTokens: 6000,
            minToolCalls: 15,
            minSeconds: 120,
            agentBurstThreshold: 4,
            cooldownSeconds: 25,
        },
    },
};
/**
 * Deep merge helper that recursively merges partial config into defaults
 */
function deepMerge(target, source) {
    const result = { ...target };
    for (const key in source) {
        const sourceValue = source[key];
        const targetValue = result[key];
        if (sourceValue &&
            typeof sourceValue === 'object' &&
            !Array.isArray(sourceValue) &&
            targetValue &&
            typeof targetValue === 'object' &&
            !Array.isArray(targetValue)) {
            result[key] = deepMerge(targetValue, sourceValue);
        }
        else if (sourceValue !== undefined) {
            result[key] = sourceValue;
        }
    }
    return result;
}
/**
 * Load TAV config from ~/.claude/tav/config.json
 * Falls back to defaults if file missing or invalid
 * @param configPath Optional override for testing
 */
function loadConfig(configPath) {
    const path = configPath ?? (0, path_1.join)((0, os_1.homedir)(), '.claude', 'tav', 'config.json');
    try {
        const content = (0, fs_1.readFileSync)(path, 'utf-8');
        const parsed = JSON.parse(content);
        return deepMerge(exports.DEFAULT_CONFIG, parsed);
    }
    catch (err) {
        if (err.code !== 'ENOENT') {
            // Log parse/read errors to stderr, but still return defaults
            console.error(`TAV config error (using defaults): ${err}`);
        }
        return exports.DEFAULT_CONFIG;
    }
}
