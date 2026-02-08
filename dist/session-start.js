#!/usr/bin/env node
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const fs_1 = require("fs");
const config_1 = require("./lib/config");
const log_1 = require("./lib/log");
const inject_1 = require("./lib/inject");
const stdin_1 = require("./lib/stdin");
const session_1 = require("./lib/session");
async function main() {
    try {
        // Read stdin (3s timeout — SessionStart hook has 5s budget)
        const stdinRaw = await (0, stdin_1.readStdin)(3000);
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
        // Write session config via shared module
        const sessionConfig = {
            sessionId,
            injectionMethod: injection.method,
            injectionTarget: injection.target,
            startedAt: Date.now(),
            ...(disabledReason ? { disabledReason } : {})
        };
        (0, session_1.writeSessionConfig)(sessionId, sessionConfig);
        // Create empty activity log (exclusive create — if a concurrent hook
        // already created it via appendEvent, don't truncate their data)
        const logPath = (0, log_1.getLogPath)(sessionId);
        try {
            (0, fs_1.writeFileSync)(logPath, '', { flag: 'wx' });
        }
        catch { /* already exists */ }
        // Output success BEFORE cleanup — cleanup can be slow with many files
        // and must not block the {continue:true} output within the hook timeout
        console.log(JSON.stringify({ continue: true }));
        // Clean old sessions (7 days) — best-effort, after output
        (0, log_1.cleanOldSessions)(7);
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
