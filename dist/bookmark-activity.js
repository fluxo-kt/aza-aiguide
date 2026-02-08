#!/usr/bin/env node
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handlePostToolUse = handlePostToolUse;
exports.handleSubagentStop = handleSubagentStop;
const config_1 = require("./lib/config");
const log_1 = require("./lib/log");
const inject_1 = require("./lib/inject");
const stdin_1 = require("./lib/stdin");
const session_1 = require("./lib/session");
const evaluate_1 = require("./lib/evaluate");
const context_pressure_1 = require("./lib/context-pressure");
/**
 * Measures the size of a hook data field in characters.
 * Handles strings directly, serialises objects, and defaults to 0 for nullish values.
 */
function measureSize(value) {
    if (typeof value === 'string')
        return value.length;
    if (value == null)
        return 0;
    try {
        return JSON.stringify(value).length;
    }
    catch {
        return 0;
    }
}
function handlePostToolUse(sessionId, data, logDir) {
    const charCount = measureSize(data.tool_response ?? data.toolResponse ?? data.toolOutput);
    (0, log_1.appendEvent)(sessionId, `T ${Date.now()} ${charCount}`, logDir);
}
function handleSubagentStop(sessionId, data, logDir, sessionStateDir, configPath) {
    const charCount = measureSize(data.output ?? data.result ?? data.response ?? data.agent_output);
    (0, log_1.appendEvent)(sessionId, `A ${Date.now()} ${charCount}`, logDir);
    const config = (0, config_1.loadConfig)(configPath);
    const metrics = (0, log_1.parseLog)(sessionId, logDir);
    // Read session config ONCE — shared by both compaction and bookmark evaluation
    const sessionConfig = (0, session_1.readSessionConfig)(sessionId, sessionStateDir);
    const injectionMethod = sessionConfig?.injectionMethod ?? 'disabled';
    const injectionTarget = sessionConfig?.injectionTarget ?? '';
    const jsonlPath = sessionConfig?.jsonlPath ?? null;
    // Context guard: proactive compaction injection (independent of bookmark)
    const pressure = (0, context_pressure_1.getContextPressure)(jsonlPath, metrics.cumulativeEstimatedTokens, config.contextGuard);
    // Burst detection: 5+ agent returns in 10 seconds AND pressure > compactPercent
    // During agent cascades the Stop hook never fires — SubagentStop is the only checkpoint
    // Must respect: contextGuard.enabled (user's choice), injection method (can't inject when
    // disabled), and compaction cooldown (prevents /compact spam during rapid agent returns)
    const recentBurst = metrics.recentAgentTimestamps.filter(t => Date.now() - t < 10000).length >= 5;
    const compactCooldownMs = config.contextGuard.compactCooldownSeconds * 1000;
    const withinCompactCooldown = (Date.now() - metrics.lastCompactionAt) < compactCooldownMs;
    const burstCompact = recentBurst && pressure > config.contextGuard.compactPercent && config.contextGuard.enabled
        && injectionMethod !== 'disabled' && !withinCompactCooldown;
    const compactEval = (0, evaluate_1.shouldCompact)({
        pressure,
        config: config.contextGuard,
        metrics,
        injectionMethod
    });
    if (compactEval.shouldCompact || burstCompact) {
        const injection = {
            method: injectionMethod,
            target: injectionTarget
        };
        (0, inject_1.requestCompaction)(sessionId, injection, logDir);
    }
    // Unified bookmark evaluation — same guard ordering as Stop hook
    const evaluation = (0, evaluate_1.shouldInjectBookmark)({ config, metrics, injectionMethod });
    if (evaluation.shouldInject) {
        (0, log_1.appendEvent)(sessionId, `I ${Date.now()}`, logDir);
        const command = (0, inject_1.buildInjectionCommand)(injectionMethod, injectionTarget, config.bookmarks.marker);
        if (command) {
            (0, inject_1.spawnDetached)(command);
            return true;
        }
    }
    return false;
}
async function main() {
    try {
        const input = await (0, stdin_1.readStdin)(2500);
        const data = JSON.parse(input);
        const eventName = data.hook_event_name || data.hookEventName || '';
        const sessionId = data.session_id || data.sessionId || '';
        if (!sessionId) {
            console.log(JSON.stringify({ continue: true }));
            process.exit(0);
        }
        // Dispatch by event name, with fallback heuristics if hook_event_name
        // is missing: presence of tool_name implies PostToolUse, agent_id
        // implies SubagentStop.
        if (eventName === 'PostToolUse' || (!eventName && data.tool_name)) {
            handlePostToolUse(sessionId, data);
        }
        else if (eventName === 'SubagentStop' || (!eventName && data.agent_id)) {
            handleSubagentStop(sessionId, data);
        }
        console.log(JSON.stringify({ continue: true }));
        process.exit(0);
    }
    catch {
        console.log(JSON.stringify({ continue: true }));
        process.exit(0);
    }
}
if (require.main === module) {
    main();
}
