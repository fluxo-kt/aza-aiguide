#!/usr/bin/env node
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.evaluateBookmark = evaluateBookmark;
const config_1 = require("./lib/config");
const log_1 = require("./lib/log");
const inject_1 = require("./lib/inject");
const guards_1 = require("./lib/guards");
const stdin_1 = require("./lib/stdin");
const session_1 = require("./lib/session");
const evaluate_1 = require("./lib/evaluate");
/**
 * Evaluates whether to inject a bookmark after Claude's turn ends.
 * Stop-specific guards (contextLimitStop, userAbort) are checked here;
 * common guards are delegated to shouldInjectBookmark.
 */
function evaluateBookmark(data, config, metrics, injectionMethod) {
    // Stop-specific guard: context limit stop (let compaction happen)
    if ((0, guards_1.isContextLimitStop)(data)) {
        return { shouldInject: false, reason: 'context limit stop detected' };
    }
    // Stop-specific guard: user abort
    if ((0, guards_1.isUserAbort)(data)) {
        return { shouldInject: false, reason: 'user abort detected' };
    }
    // Common evaluation (enabled, disabled, lastLineIsBookmark, cooldown, thresholds)
    return (0, evaluate_1.shouldInjectBookmark)({ config, metrics, injectionMethod });
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
        // Read session config via shared module
        const sessionConfig = (0, session_1.readSessionConfig)(sessionId);
        if (!sessionConfig) {
            console.log(JSON.stringify({ continue: true }));
            return;
        }
        const injectionMethod = (sessionConfig.injectionMethod || 'disabled');
        const injectionTarget = sessionConfig.injectionTarget || '';
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
