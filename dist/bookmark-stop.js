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
const context_pressure_1 = require("./lib/context-pressure");
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
        // Use cached config from SessionStart (prevents hot-reload race)
        // Fallback to loadConfig() only if session started before config caching was implemented
        const config = sessionConfig.cachedConfig || (0, config_1.loadConfig)();
        // Map 'detecting' (interim SessionStart state) to 'disabled' — don't inject during setup
        const injectionMethod = sessionConfig.injectionMethod === 'detecting'
            ? 'disabled' : (sessionConfig.injectionMethod || 'disabled');
        const injectionTarget = sessionConfig.injectionTarget || '';
        const jsonlPath = sessionConfig.jsonlPath ?? null;
        const declaredLocation = sessionConfig.location;
        // Parse log metrics
        const metrics = (0, log_1.parseLog)(sessionId);
        // Evaluate whether to inject bookmark
        const evaluation = evaluateBookmark(data, config, metrics, injectionMethod);
        if (evaluation.shouldInject) {
            const injection = { method: injectionMethod, target: injectionTarget };
            (0, inject_1.requestBookmark)(sessionId, injection, config.bookmarks.marker, declaredLocation, config);
        }
        // Context guard: proactive compaction injection (independent of bookmark)
        const pressure = (0, context_pressure_1.getContextPressure)(jsonlPath, metrics.cumulativeEstimatedTokens, config.contextGuard);
        const compactEval = (0, evaluate_1.shouldCompact)({
            pressure,
            config: config.contextGuard,
            metrics,
            injectionMethod
        });
        if (compactEval.shouldCompact) {
            const injection = { method: injectionMethod, target: injectionTarget };
            (0, inject_1.requestCompaction)(sessionId, injection, declaredLocation, config);
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
