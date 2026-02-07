#!/usr/bin/env node
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handlePostToolUse = handlePostToolUse;
exports.handleSubagentStop = handleSubagentStop;
const config_1 = require("./lib/config");
const log_1 = require("./lib/log");
const inject_1 = require("./lib/inject");
const fs_1 = require("fs");
const path_1 = require("path");
const os_1 = require("os");
function readStdin() {
    return new Promise((resolve) => {
        let data = '';
        process.stdin.setEncoding('utf-8');
        process.stdin.on('data', (chunk) => { data += chunk; });
        process.stdin.on('end', () => { resolve(data); });
        setTimeout(() => { resolve(data); }, 2000);
    });
}
function getSessionConfig(sessionId, stateDir) {
    const dir = stateDir || (0, path_1.join)((0, os_1.homedir)(), '.claude', 'tav', 'state');
    const sanitized = (0, log_1.sanitizeSessionId)(sessionId);
    const path = (0, path_1.join)(dir, `${sanitized}.json`);
    if (!(0, fs_1.existsSync)(path)) {
        return null;
    }
    try {
        const content = (0, fs_1.readFileSync)(path, 'utf-8');
        return JSON.parse(content);
    }
    catch {
        return null;
    }
}
function handlePostToolUse(sessionId, data, logDir) {
    const toolOutput = (data.tool_response || data.toolResponse || data.toolOutput || '');
    const charCount = toolOutput.length;
    (0, log_1.appendEvent)(sessionId, `T ${Date.now()} ${charCount}`, logDir);
}
function handleSubagentStop(sessionId, data, logDir, sessionStateDir) {
    const output = (data.output || '');
    const charCount = output.length;
    (0, log_1.appendEvent)(sessionId, `A ${Date.now()} ${charCount}`, logDir);
    const config = (0, config_1.loadConfig)();
    const metrics = (0, log_1.parseLog)(sessionId, logDir);
    if (metrics.agentReturns >= config.bookmarks.thresholds.agentBurstThreshold) {
        const cooldownMs = config.bookmarks.thresholds.cooldownSeconds * 1000;
        const timeSinceLastAction = Date.now() - Math.max(metrics.lastInjectionAt, metrics.lastBookmarkAt);
        if (timeSinceLastAction < cooldownMs) {
            return false;
        }
        const sessionConfig = getSessionConfig(sessionId, sessionStateDir);
        if (!sessionConfig) {
            return false;
        }
        const { injectionMethod, injectionTarget } = sessionConfig;
        if (injectionMethod === 'disabled') {
            return false;
        }
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
        const input = await readStdin();
        const data = JSON.parse(input);
        const eventName = data.hook_event_name || data.hookEventName || '';
        const sessionId = data.session_id || data.sessionId || '';
        if (!sessionId) {
            console.log(JSON.stringify({ continue: true }));
            process.exit(0);
            return;
        }
        if (eventName === 'PostToolUse') {
            handlePostToolUse(sessionId, data);
        }
        else if (eventName === 'SubagentStop') {
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
