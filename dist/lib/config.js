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
            agentBurstThreshold: 3,
            cooldownSeconds: 25,
        },
    },
    contextGuard: {
        enabled: true,
        compactThreshold: 30000,
        compactCooldownSeconds: 120,
        denyThreshold: 45000,
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
 * Coerces a value to a non-negative number, returning fallback if invalid.
 * Only accepts actual numbers and numeric strings — rejects null, arrays,
 * objects etc. that Number() would silently coerce to 0.
 */
function validNumber(value, fallback) {
    if (typeof value === 'number')
        return !Number.isFinite(value) || value < 0 ? fallback : value;
    if (typeof value === 'string') {
        const n = Number(value);
        return !Number.isFinite(n) || n < 0 ? fallback : n;
    }
    return fallback;
}
/**
 * Validates merged config, coercing threshold fields to numbers and
 * falling back to defaults for invalid values. This prevents silent
 * corruption where e.g. "minTokens": "banana" makes the threshold
 * unreachable (string comparison always false).
 */
function validateConfig(config) {
    const d = exports.DEFAULT_CONFIG.bookmarks;
    const t = config.bookmarks.thresholds;
    const dt = d.thresholds;
    const cg = config.contextGuard;
    const dcg = exports.DEFAULT_CONFIG.contextGuard;
    return {
        bookmarks: {
            enabled: typeof config.bookmarks.enabled === 'boolean'
                ? config.bookmarks.enabled
                : d.enabled,
            marker: typeof config.bookmarks.marker === 'string' && config.bookmarks.marker.length > 0
                ? config.bookmarks.marker
                : d.marker,
            thresholds: {
                minTokens: validNumber(t.minTokens, dt.minTokens),
                minToolCalls: validNumber(t.minToolCalls, dt.minToolCalls),
                minSeconds: validNumber(t.minSeconds, dt.minSeconds),
                agentBurstThreshold: validNumber(t.agentBurstThreshold, dt.agentBurstThreshold),
                cooldownSeconds: validNumber(t.cooldownSeconds, dt.cooldownSeconds),
            },
        },
        contextGuard: {
            enabled: typeof cg.enabled === 'boolean' ? cg.enabled : dcg.enabled,
            compactThreshold: validNumber(cg.compactThreshold, dcg.compactThreshold),
            compactCooldownSeconds: validNumber(cg.compactCooldownSeconds, dcg.compactCooldownSeconds),
            denyThreshold: validNumber(cg.denyThreshold, dcg.denyThreshold),
        },
    };
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
        return validateConfig(deepMerge(exports.DEFAULT_CONFIG, parsed));
    }
    catch (err) {
        if (err.code !== 'ENOENT') {
            // Log parse/read errors to stderr, but still return defaults
            console.error(`TAV config error (using defaults): ${err}`);
        }
        return exports.DEFAULT_CONFIG;
    }
}
