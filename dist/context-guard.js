#!/usr/bin/env node
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.evaluateContextPressure = evaluateContextPressure;
const config_1 = require("./lib/config");
const log_1 = require("./lib/log");
const stdin_1 = require("./lib/stdin");
/**
 * Evaluates whether a Task tool call should be denied due to context pressure.
 * Pure function for testability — no I/O, no side effects.
 */
function evaluateContextPressure(config, metrics, toolName) {
    // Only intercept Task tool calls (subagent spawns)
    if (toolName !== 'Task') {
        return { continue: true };
    }
    // Check if context guard is enabled
    if (!config.contextGuard.enabled) {
        return { continue: true };
    }
    // Check cumulative tokens against deny threshold
    if (metrics.cumulativeEstimatedTokens >= config.contextGuard.denyThreshold) {
        return {
            continue: true,
            permissionDecision: 'deny',
            reason: `Context pressure critical: ${metrics.cumulativeEstimatedTokens} estimated tokens (threshold: ${config.contextGuard.denyThreshold}). Run /compact before spawning new agents.`,
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
        const config = (0, config_1.loadConfig)();
        const metrics = (0, log_1.parseLog)(sessionId);
        const result = evaluateContextPressure(config, metrics, toolName);
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
