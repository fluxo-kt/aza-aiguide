#!/usr/bin/env node
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const fs_1 = require("fs");
const path_1 = require("path");
const os_1 = require("os");
const config_1 = require("./lib/config");
const log_1 = require("./lib/log");
const inject_1 = require("./lib/inject");
function readStdin() {
    return new Promise((resolve) => {
        let data = '';
        process.stdin.setEncoding('utf-8');
        process.stdin.on('data', (chunk) => { data += chunk; });
        process.stdin.on('end', () => { resolve(data); });
        // Safety timeout — never block
        setTimeout(() => { resolve(data); }, 3000);
    });
}
async function main() {
    try {
        // Read stdin
        const stdinRaw = await readStdin();
        const data = stdinRaw.trim() ? JSON.parse(stdinRaw) : {};
        // Extract session_id (support both formats)
        const sessionId = data.session_id || data.sessionId || 'unknown';
        // Load config
        const config = (0, config_1.loadConfig)();
        // If bookmarks disabled, exit early
        if (config.bookmarks.enabled === false) {
            console.log(JSON.stringify({
                continue: true,
                note: 'Bookmarks disabled in config'
            }));
            return;
        }
        // Detect injection method
        let injection = (0, inject_1.detectInjectionMethod)();
        let disabledReason;
        // If osascript detected, verify Accessibility permissions are granted.
        // Without Accessibility, osascript silently fails — downgrade to disabled
        // with a clear warning so the user knows what to do.
        if (injection.method === 'osascript') {
            const hasAccess = (0, inject_1.checkAccessibilityPermission)();
            if (!hasAccess) {
                disabledReason = 'macOS Accessibility permissions not granted';
                injection = { method: 'disabled', target: '' };
                console.error('tav: macOS Accessibility permissions required for automatic bookmarks.\n' +
                    'Grant permission: System Settings > Privacy & Security > Accessibility > Enable your terminal app.\n' +
                    'Until then, you can still type \u00B7 manually to create bookmark anchor points.');
            }
        }
        // Ensure state directory exists
        (0, log_1.ensureStateDir)();
        // Sanitize session ID for filesystem
        const sanitizedId = (0, log_1.sanitizeSessionId)(sessionId);
        // Write session config
        const sessionConfig = {
            sessionId,
            injectionMethod: injection.method,
            injectionTarget: injection.target,
            startedAt: Date.now(),
            ...(disabledReason ? { disabledReason } : {})
        };
        const sessionConfigPath = (0, path_1.join)((0, os_1.homedir)(), '.claude', 'tav', 'state', `${sanitizedId}.json`);
        (0, fs_1.writeFileSync)(sessionConfigPath, JSON.stringify(sessionConfig, null, 2), 'utf-8');
        // Create empty activity log
        const logPath = (0, log_1.getLogPath)(sessionId);
        (0, fs_1.writeFileSync)(logPath, '', 'utf-8');
        // Clean old sessions (7 days)
        (0, log_1.cleanOldSessions)(7);
        // Output success
        console.log(JSON.stringify({ continue: true }));
    }
    catch (error) {
        // Never block session start
        console.error('SessionStart error:', error instanceof Error ? error.message : String(error));
        console.log(JSON.stringify({ continue: true }));
    }
}
if (require.main === module) {
    main().then(() => process.exit(0), (error) => {
        console.error('Fatal error:', error);
        console.log(JSON.stringify({ continue: true }));
        process.exit(0);
    });
}
