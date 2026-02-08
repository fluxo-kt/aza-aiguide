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
    // Context guard: proactive compaction injection (independent of bookmark)
    if (config.contextGuard.enabled) {
        const cg = config.contextGuard;
        if (metrics.cumulativeEstimatedTokens >= cg.compactThreshold) {
            const compactCooldownMs = cg.compactCooldownSeconds * 1000;
            const timeSinceCompaction = Date.now() - metrics.lastCompactionAt;
            if (timeSinceCompaction >= compactCooldownMs) {
                const sessionConfig = (0, session_1.readSessionConfig)(sessionId, sessionStateDir);
                if (sessionConfig && sessionConfig.injectionMethod !== 'disabled') {
                    const injection = {
                        method: sessionConfig.injectionMethod,
                        target: sessionConfig.injectionTarget
                    };
                    (0, inject_1.requestCompaction)(sessionId, injection, logDir);
                }
            }
        }
    }
    // Read session config for injection details
    const sessionConfig = (0, session_1.readSessionConfig)(sessionId, sessionStateDir);
    const injectionMethod = sessionConfig?.injectionMethod ?? 'disabled';
    // Unified evaluation — same guard ordering as Stop hook
    const evaluation = (0, evaluate_1.shouldInjectBookmark)({ config, metrics, injectionMethod });
    if (evaluation.shouldInject) {
        const injectionTarget = sessionConfig?.injectionTarget ?? '';
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
