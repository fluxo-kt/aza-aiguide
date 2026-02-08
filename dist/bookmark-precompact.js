#!/usr/bin/env node
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.processPreCompact = processPreCompact;
const log_1 = require("./lib/log");
const stdin_1 = require("./lib/stdin");
const session_1 = require("./lib/session");
const config_1 = require("./lib/config");
const context_pressure_1 = require("./lib/context-pressure");
/**
 * Processes a PreCompact event: resets the activity log window and injects
 * additionalContext so compaction preserves bookmark awareness.
 *
 * Optionally includes real context pressure % when JSONL path is available.
 */
function processPreCompact(sessionId, logDir, sessionStateDir) {
    // Read current metrics before reset
    const metrics = (0, log_1.parseLog)(sessionId, logDir);
    // Append B marker — resets the activity window.
    // After compaction, old T/A lines represent tokens that no longer exist
    // in the context. The B marker ensures thresholds start from zero.
    (0, log_1.appendEvent)(sessionId, `B ${Date.now()}`, logDir);
    // Read session config for cached config and JSONL path
    const sessionConfig = (0, session_1.readSessionConfig)(sessionId, sessionStateDir);
    // Optionally compute real context pressure for informational message
    let pressureInfo = '';
    try {
        if (sessionConfig?.jsonlPath) {
            // Use cached config from SessionStart (prevents hot-reload race)
            const config = sessionConfig.cachedConfig || (0, config_1.loadConfig)();
            const pressure = (0, context_pressure_1.getContextPressure)(sessionConfig.jsonlPath, metrics.cumulativeEstimatedTokens, config.contextGuard);
            pressureInfo = ` Context pressure at compaction: ${(pressure * 100).toFixed(0)}%.`;
        }
    }
    catch {
        // Non-critical — skip pressure info on error
    }
    // Build summary for additionalContext — survives into the compacted context
    const summary = `<system-reminder>tav bookmark plugin: activity log reset after compaction. ` +
        `Pre-compaction metrics: ~${metrics.cumulativeEstimatedTokens} cumulative tokens, ` +
        `${metrics.toolCalls} tool calls, ${metrics.agentReturns} agent returns.` +
        pressureInfo +
        ` Bookmark navigation points (·) are being managed automatically.</system-reminder>`;
    return {
        continue: true,
        hookSpecificOutput: {
            hookEventName: 'PreCompact',
            additionalContext: summary
        }
    };
}
async function main() {
    try {
        const input = await (0, stdin_1.readStdin)(2500);
        const data = JSON.parse(input);
        const sessionId = data.session_id ?? data.sessionId ?? '';
        if (!sessionId) {
            console.log(JSON.stringify({ continue: true }));
            return;
        }
        const result = processPreCompact(sessionId);
        console.log(JSON.stringify(result));
    }
    catch {
        // Never block compaction on error
        console.log(JSON.stringify({ continue: true }));
    }
}
if (require.main === module) {
    main().then(() => process.exit(0), () => {
        console.log(JSON.stringify({ continue: true }));
        process.exit(0);
    });
}
