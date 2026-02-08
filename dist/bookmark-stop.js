#!/usr/bin/env node
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.evaluateBookmark = evaluateBookmark;
const config_1 = require("./lib/config");
const log_1 = require("./lib/log");
const inject_1 = require("./lib/inject");
const guards_1 = require("./lib/guards");
const stdin_1 = require("./lib/stdin");
const fs_1 = require("fs");
const path_1 = require("path");
const os_1 = require("os");
/**
 * Evaluates whether to inject a bookmark after Claude's turn ends.
 */
function evaluateBookmark(data, config, metrics, injectionMethod) {
    // Guard 1: Bookmarks disabled globally
    if (!config.bookmarks.enabled) {
        return { shouldInject: false, reason: 'bookmarks disabled in config' };
    }
    // Guard 2: Injection disabled for this session
    if (injectionMethod === 'disabled') {
        return { shouldInject: false, reason: 'injection method is disabled' };
    }
    // Guard 3: Context limit stop (let compaction happen)
    if ((0, guards_1.isContextLimitStop)(data)) {
        return { shouldInject: false, reason: 'context limit stop detected' };
    }
    // Guard 4: User abort
    if ((0, guards_1.isUserAbort)(data)) {
        return { shouldInject: false, reason: 'user abort detected' };
    }
    // Guard 5: Last line is already a bookmark
    if (metrics.lastLineIsBookmark) {
        return { shouldInject: false, reason: 'last line is already a bookmark' };
    }
    // Guard 6: Cooldown check
    const lastActivityAt = Math.max(metrics.lastInjectionAt, metrics.lastBookmarkAt);
    const cooldownMs = config.bookmarks.thresholds.cooldownSeconds * 1000;
    if (Date.now() - lastActivityAt < cooldownMs) {
        return { shouldInject: false, reason: 'within cooldown period' };
    }
    // Threshold evaluation (ANY threshold met triggers bookmark)
    const { met, reason } = (0, log_1.meetsAnyThreshold)(metrics, config.bookmarks.thresholds);
    return { shouldInject: met, reason };
}
/**
 * Main entry point
 */
async function main() {
    try {
        const config = (0, config_1.loadConfig)();
        const input = await (0, stdin_1.readStdin)(4000);
        const data = JSON.parse(input);
        // Normalize field names (camelCase variants)
        const sessionId = (data.session_id || data.sessionId);
        if (!sessionId) {
            console.log(JSON.stringify({ continue: true }));
            return;
        }
        // Read session config
        const sanitized = (0, log_1.sanitizeSessionId)(sessionId);
        const sessionConfigPath = (0, path_1.join)((0, os_1.homedir)(), '.claude', 'tav', 'state', `${sanitized}.json`);
        let injectionMethod = 'disabled';
        let injectionTarget = '';
        try {
            const sessionConfigRaw = (0, fs_1.readFileSync)(sessionConfigPath, 'utf8');
            const sessionConfig = JSON.parse(sessionConfigRaw);
            injectionMethod = sessionConfig.injectionMethod || 'disabled';
            injectionTarget = sessionConfig.injectionTarget || '';
        }
        catch {
            // Session config missing or unreadable
            console.log(JSON.stringify({ continue: true }));
            return;
        }
        // Parse log metrics
        const metrics = (0, log_1.parseLog)(sessionId);
        // Evaluate whether to inject bookmark
        const evaluation = evaluateBookmark(data, config, metrics, injectionMethod);
        if (evaluation.shouldInject) {
            // Append pre-spawn marker to log
            (0, log_1.appendEvent)(sessionId, `I ${Date.now()}`);
            // Build and spawn injection command
            const command = (0, inject_1.buildInjectionCommand)(injectionMethod, injectionTarget, config.bookmarks.marker);
            if (command) {
                (0, inject_1.spawnDetached)(command);
            }
        }
        // Context guard: proactive compaction injection (independent of bookmark)
        if (config.contextGuard.enabled && injectionMethod !== 'disabled') {
            const cg = config.contextGuard;
            if (metrics.cumulativeEstimatedTokens >= cg.compactThreshold) {
                const compactCooldownMs = cg.compactCooldownSeconds * 1000;
                const timeSinceCompaction = Date.now() - metrics.lastCompactionAt;
                if (timeSinceCompaction >= compactCooldownMs) {
                    const injection = { method: injectionMethod, target: injectionTarget };
                    (0, inject_1.requestCompaction)(sessionId, injection);
                }
            }
        }
        // Always allow continuation
        console.log(JSON.stringify({ continue: true }));
    }
    catch (error) {
        // Always allow continuation even on error
        console.log(JSON.stringify({ continue: true }));
    }
}
if (require.main === module) {
    main().then(() => process.exit(0), () => {
        console.log(JSON.stringify({ continue: true }));
        process.exit(0);
    });
}
