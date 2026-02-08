#!/usr/bin/env node
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.evaluateContextPressure = evaluateContextPressure;
const config_1 = require("./lib/config");
const log_1 = require("./lib/log");
const stdin_1 = require("./lib/stdin");
const session_1 = require("./lib/session");
const context_pressure_1 = require("./lib/context-pressure");
/**
 * Evaluates whether a Task tool call should be denied due to context pressure.
 * Pure function for testability — no I/O, no side effects.
 * Receives pre-computed pressure ratio (0–1) rather than computing it internally.
 */
function evaluateContextPressure(config, pressure, toolName) {
    // Intercept all agent spawns — Task is CC's universal agent tool
    // (Explorer, Plan, general-purpose are all subagent_type params to Task)
    if (toolName !== 'Task') {
        return { continue: true };
    }
    if (!config.contextGuard.enabled) {
        return { continue: true };
    }
    // Compare pressure ratio against deny percentage
    if (pressure >= config.contextGuard.denyPercent) {
        const pressurePct = (pressure * 100).toFixed(0);
        const thresholdPct = (config.contextGuard.denyPercent * 100).toFixed(0);
        return {
            continue: true,
            permissionDecision: 'deny',
            reason: `Context pressure critical: ${pressurePct}% (threshold: ${thresholdPct}%). Run /compact before spawning new agents.`,
            hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                additionalContext: '<system-reminder>Context pressure is critically high. Do NOT spawn new subagents. ' +
                    'Instead: (1) complete current work, (2) write large outputs to files rather than returning them inline, ' +
                    '(3) wait for /compact to reduce context size. The context guard has denied this Task call to prevent session death.</system-reminder>'
            }
        };
    }
    return { continue: true };
}
async function main() {
    try {
        const input = await (0, stdin_1.readStdin)(2500);
        const data = JSON.parse(input);
        const sessionId = data.session_id ?? data.sessionId ?? '';
        const toolName = data.tool_name ?? data.toolName ?? '';
        if (!sessionId || !toolName) {
            console.log(JSON.stringify({ continue: true }));
            return;
        }
        const metrics = (0, log_1.parseLog)(sessionId);
        // Read session config ONCE — provides cached config and JSONL path
        const sessionConfig = (0, session_1.readSessionConfig)(sessionId);
        // Use cached config from SessionStart (prevents hot-reload race)
        // Fallback to loadConfig() only if session started before config caching was implemented
        const config = sessionConfig?.cachedConfig || (0, config_1.loadConfig)();
        const jsonlPath = sessionConfig?.jsonlPath ?? null;
        const pressure = (0, context_pressure_1.getContextPressure)(jsonlPath, metrics.cumulativeEstimatedTokens, config.contextGuard);
        const result = evaluateContextPressure(config, pressure, toolName);
        console.log(JSON.stringify(result));
    }
    catch {
        // Never block tool calls on error
        console.log(JSON.stringify({ continue: true }));
    }
}
if (require.main === module) {
    main().then(() => process.exit(0), () => {
        console.log(JSON.stringify({ continue: true }));
        process.exit(0);
    });
}
