"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_CONFIG = void 0;
exports.validNumber = validNumber;
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
        contextWindowTokens: 200000,
        compactPercent: 0.76,
        denyPercent: 0.85,
        compactCooldownSeconds: 120,
        responseRatio: 0.25,
    },
    sessionLocation: {
        enabled: false,
        verifyTab: false,
        terminals: {
            iterm2: { tabVerification: false },
            terminal: { tabVerification: false },
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
 * Validates a percentage value (0–1 range). Returns fallback for out-of-range
 * or invalid values. Accepts values like 0.76, 0.85.
 */
function validPercent(value, fallback) {
    const n = validNumber(value, fallback);
    return n > 1.0 ? fallback : n;
}
/**
 * Validates merged config, coercing threshold fields to numbers and
 * falling back to defaults for invalid values. This prevents silent
 * corruption where e.g. "minTokens": "banana" makes the threshold
 * unreachable (string comparison always false).
 *
 * Backward compatibility: if legacy fields (compactThreshold, denyThreshold)
 * are present in the contextGuard section but new percentage fields are absent,
 * converts them to percentages using responseRatio and contextWindowTokens.
 */
function validateConfig(config, rawContextGuard) {
    const d = exports.DEFAULT_CONFIG.bookmarks;
    const t = config.bookmarks.thresholds;
    const dt = d.thresholds;
    const cg = config.contextGuard;
    const dcg = exports.DEFAULT_CONFIG.contextGuard;
    // Resolve contextWindowTokens and responseRatio first (needed for legacy conversion)
    const contextWindowTokens = validNumber(cg.contextWindowTokens, dcg.contextWindowTokens);
    const responseRatio = validNumber(cg.responseRatio, dcg.responseRatio);
    // Legacy backward compat: convert absolute thresholds to percentages
    // Only applies when raw config has legacy fields but NOT the new percentage fields
    let compactPercent = validPercent(cg.compactPercent, dcg.compactPercent);
    let denyPercent = validPercent(cg.denyPercent, dcg.denyPercent);
    if (rawContextGuard) {
        const hasLegacyCompact = 'compactThreshold' in rawContextGuard && rawContextGuard.compactThreshold !== undefined;
        const hasNewCompact = 'compactPercent' in rawContextGuard && rawContextGuard.compactPercent !== undefined;
        const hasLegacyDeny = 'denyThreshold' in rawContextGuard && rawContextGuard.denyThreshold !== undefined;
        const hasNewDeny = 'denyPercent' in rawContextGuard && rawContextGuard.denyPercent !== undefined;
        const denominator = contextWindowTokens * responseRatio;
        if (denominator > 0) {
            if (hasLegacyCompact && !hasNewCompact) {
                const legacyVal = validNumber(rawContextGuard.compactThreshold, 0);
                if (legacyVal > 0) {
                    compactPercent = Math.min(legacyVal / denominator, 1.0);
                }
            }
            if (hasLegacyDeny && !hasNewDeny) {
                const legacyVal = validNumber(rawContextGuard.denyThreshold, 0);
                if (legacyVal > 0) {
                    denyPercent = Math.min(legacyVal / denominator, 1.0);
                }
            }
        }
    }
    const dsl = exports.DEFAULT_CONFIG.sessionLocation;
    const sl = config.sessionLocation;
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
            contextWindowTokens,
            compactPercent,
            denyPercent,
            compactCooldownSeconds: validNumber(cg.compactCooldownSeconds, dcg.compactCooldownSeconds),
            responseRatio,
        },
        sessionLocation: {
            enabled: typeof sl.enabled === 'boolean' ? sl.enabled : dsl.enabled,
            verifyTab: typeof sl.verifyTab === 'boolean' ? sl.verifyTab : dsl.verifyTab,
            terminals: {
                iterm2: {
                    tabVerification: typeof sl.terminals?.iterm2?.tabVerification === 'boolean'
                        ? sl.terminals.iterm2.tabVerification
                        : dsl.terminals.iterm2.tabVerification,
                },
                terminal: {
                    tabVerification: typeof sl.terminals?.terminal?.tabVerification === 'boolean'
                        ? sl.terminals.terminal.tabVerification
                        : dsl.terminals.terminal.tabVerification,
                },
            },
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
        // Pass raw contextGuard section for legacy backward compat detection
        const rawContextGuard = parsed.contextGuard;
        return validateConfig(deepMerge(exports.DEFAULT_CONFIG, parsed), rawContextGuard);
    }
    catch (err) {
        if (err.code !== 'ENOENT') {
            // Log parse/read errors to stderr, but still return defaults
            console.error(`TAV config error (using defaults): ${err}`);
        }
        return exports.DEFAULT_CONFIG;
    }
}
