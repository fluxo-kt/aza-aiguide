"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isValidPaneId = isValidPaneId;
exports.sanitizeForShell = sanitizeForShell;
exports.detectInjectionMethod = detectInjectionMethod;
exports.buildInjectionCommand = buildInjectionCommand;
exports.spawnDetached = spawnDetached;
const child_process_1 = require("child_process");
/**
 * Validates that a pane ID matches the tmux pane format (%N).
 */
function isValidPaneId(paneId) {
    return /^%\d+$/.test(paneId);
}
/**
 * Escapes single quotes for safe use in single-quoted shell strings.
 * Replaces ' with '\''
 */
function sanitizeForShell(text) {
    return text.replace(/'/g, "'\\''");
}
/**
 * Detects the available injection method based on environment variables and platform.
 */
function detectInjectionMethod() {
    // Check for tmux
    const tmuxEnv = process.env.TMUX;
    const tmuxPane = process.env.TMUX_PANE;
    if (tmuxEnv && tmuxPane && isValidPaneId(tmuxPane)) {
        return { method: 'tmux', target: tmuxPane };
    }
    // Check for screen
    const screenSession = process.env.STY;
    if (screenSession) {
        return { method: 'screen', target: screenSession };
    }
    // Check for macOS
    if (process.platform === 'darwin') {
        return { method: 'osascript', target: '' };
    }
    // No method available
    return { method: 'disabled', target: '' };
}
/**
 * Builds a shell command to inject a marker character into the terminal.
 * Returns null if the method is disabled.
 *
 * The returned command is intended for use with spawnDetached(), which passes
 * it to spawn('sh', ['-c', command]). All interpolated values are single-quoted
 * with sanitizeForShell() escaping for defense-in-depth.
 */
function buildInjectionCommand(method, target, marker) {
    if (method === 'disabled') {
        return null;
    }
    const sanitizedMarker = sanitizeForShell(marker);
    const sanitizedTarget = sanitizeForShell(target);
    switch (method) {
        case 'tmux':
            // Use -l flag for literal text, separate commands for marker and Enter
            // All values single-quoted for defense-in-depth
            return `sleep 1.5 && tmux send-keys -t '${sanitizedTarget}' -l '${sanitizedMarker}' && tmux send-keys -t '${sanitizedTarget}' Enter`;
        case 'screen':
            // Use stuff command with \\n for newline (screen interprets \n as newline)
            // All values single-quoted for defense-in-depth
            return `sleep 1.5 && screen -S '${sanitizedTarget}' -X stuff '${sanitizedMarker}\\n'`;
        case 'osascript':
            // macOS keystroke automation — marker placed in AppleScript double-quotes
            return `sleep 1.5 && osascript -e 'tell application "System Events" to keystroke "${sanitizedMarker}" & return'`;
        default:
            return null;
    }
}
/**
 * Spawns a detached shell command that won't keep the parent process alive.
 * Never throws - errors are silently ignored.
 */
function spawnDetached(command) {
    try {
        const child = (0, child_process_1.spawn)('sh', ['-c', command], {
            detached: true,
            stdio: 'ignore',
        });
        child.unref();
    }
    catch {
        // Silently ignore errors
    }
}
