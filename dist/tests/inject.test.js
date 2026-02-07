"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const bun_test_1 = require("bun:test");
const inject_1 = require("../src/lib/inject");
(0, bun_test_1.describe)('inject utilities', () => {
    // Store original env values
    let originalTmux;
    let originalTmuxPane;
    let originalSty;
    (0, bun_test_1.beforeEach)(() => {
        originalTmux = process.env.TMUX;
        originalTmuxPane = process.env.TMUX_PANE;
        originalSty = process.env.STY;
    });
    (0, bun_test_1.afterEach)(() => {
        // Restore original values
        if (originalTmux !== undefined) {
            process.env.TMUX = originalTmux;
        }
        else {
            delete process.env.TMUX;
        }
        if (originalTmuxPane !== undefined) {
            process.env.TMUX_PANE = originalTmuxPane;
        }
        else {
            delete process.env.TMUX_PANE;
        }
        if (originalSty !== undefined) {
            process.env.STY = originalSty;
        }
        else {
            delete process.env.STY;
        }
    });
    (0, bun_test_1.describe)('isValidPaneId', () => {
        (0, bun_test_1.test)('accepts valid pane IDs', () => {
            (0, bun_test_1.expect)((0, inject_1.isValidPaneId)('%0')).toBe(true);
            (0, bun_test_1.expect)((0, inject_1.isValidPaneId)('%1')).toBe(true);
            (0, bun_test_1.expect)((0, inject_1.isValidPaneId)('%123')).toBe(true);
            (0, bun_test_1.expect)((0, inject_1.isValidPaneId)('%999')).toBe(true);
        });
        (0, bun_test_1.test)('rejects invalid pane IDs', () => {
            (0, bun_test_1.expect)((0, inject_1.isValidPaneId)('')).toBe(false);
            (0, bun_test_1.expect)((0, inject_1.isValidPaneId)('%abc')).toBe(false);
            (0, bun_test_1.expect)((0, inject_1.isValidPaneId)('123')).toBe(false);
            (0, bun_test_1.expect)((0, inject_1.isValidPaneId)('%')).toBe(false);
            (0, bun_test_1.expect)((0, inject_1.isValidPaneId)('; rm -rf')).toBe(false);
            (0, bun_test_1.expect)((0, inject_1.isValidPaneId)('% 1')).toBe(false);
            (0, bun_test_1.expect)((0, inject_1.isValidPaneId)('%1a')).toBe(false);
        });
    });
    (0, bun_test_1.describe)('sanitizeForShell', () => {
        (0, bun_test_1.test)('escapes single quotes', () => {
            (0, bun_test_1.expect)((0, inject_1.sanitizeForShell)("it's")).toBe("it'\\''s");
            (0, bun_test_1.expect)((0, inject_1.sanitizeForShell)("don't")).toBe("don'\\''t");
            (0, bun_test_1.expect)((0, inject_1.sanitizeForShell)("'quoted'")).toBe("'\\''quoted'\\''");
            (0, bun_test_1.expect)((0, inject_1.sanitizeForShell)("no quotes")).toBe("no quotes");
        });
    });
    (0, bun_test_1.describe)('detectInjectionMethod', () => {
        (0, bun_test_1.test)('returns tmux when TMUX and TMUX_PANE set', () => {
            process.env.TMUX = '/tmp/tmux-1000/default,12345,0';
            process.env.TMUX_PANE = '%0';
            const result = (0, inject_1.detectInjectionMethod)();
            (0, bun_test_1.expect)(result.method).toBe('tmux');
            (0, bun_test_1.expect)(result.target).toBe('%0');
        });
        (0, bun_test_1.test)('returns screen when STY set', () => {
            delete process.env.TMUX;
            delete process.env.TMUX_PANE;
            process.env.STY = '12345.pts-0.hostname';
            const result = (0, inject_1.detectInjectionMethod)();
            (0, bun_test_1.expect)(result.method).toBe('screen');
            (0, bun_test_1.expect)(result.target).toBe('12345.pts-0.hostname');
        });
        (0, bun_test_1.test)('returns osascript on darwin with no tmux/screen', () => {
            delete process.env.TMUX;
            delete process.env.TMUX_PANE;
            delete process.env.STY;
            const result = (0, inject_1.detectInjectionMethod)();
            if (process.platform === 'darwin') {
                (0, bun_test_1.expect)(result.method).toBe('osascript');
                (0, bun_test_1.expect)(result.target).toBe('');
            }
            else {
                (0, bun_test_1.expect)(result.method).toBe('disabled');
            }
        });
        (0, bun_test_1.test)('returns disabled when nothing available', () => {
            delete process.env.TMUX;
            delete process.env.TMUX_PANE;
            delete process.env.STY;
            const originalPlatform = process.platform;
            // Mock platform check by testing on non-darwin if available
            const result = (0, inject_1.detectInjectionMethod)();
            if (process.platform !== 'darwin') {
                (0, bun_test_1.expect)(result.method).toBe('disabled');
                (0, bun_test_1.expect)(result.target).toBe('');
            }
        });
    });
    (0, bun_test_1.describe)('buildInjectionCommand', () => {
        (0, bun_test_1.test)('returns tmux command', () => {
            const command = (0, inject_1.buildInjectionCommand)('tmux', '%0', '📖');
            (0, bun_test_1.expect)(command).not.toBeNull();
            (0, bun_test_1.expect)(command).toContain('tmux send-keys');
            (0, bun_test_1.expect)(command).toContain('-t %0');
            (0, bun_test_1.expect)(command).toContain('-l');
            (0, bun_test_1.expect)(command).toContain('📖');
            (0, bun_test_1.expect)(command).toContain('Enter');
        });
        (0, bun_test_1.test)('returns screen command', () => {
            const command = (0, inject_1.buildInjectionCommand)('screen', '12345.pts-0', '📖');
            (0, bun_test_1.expect)(command).not.toBeNull();
            (0, bun_test_1.expect)(command).toContain('screen -S 12345.pts-0');
            (0, bun_test_1.expect)(command).toContain('-X stuff');
            (0, bun_test_1.expect)(command).toContain('📖');
            (0, bun_test_1.expect)(command).toContain('\\n');
        });
        (0, bun_test_1.test)('returns osascript command', () => {
            const command = (0, inject_1.buildInjectionCommand)('osascript', '', '📖');
            (0, bun_test_1.expect)(command).not.toBeNull();
            (0, bun_test_1.expect)(command).toContain('osascript');
            (0, bun_test_1.expect)(command).toContain('tell application "System Events"');
            (0, bun_test_1.expect)(command).toContain('keystroke');
            (0, bun_test_1.expect)(command).toContain('📖');
            (0, bun_test_1.expect)(command).toContain('return');
        });
        (0, bun_test_1.test)('returns null for disabled', () => {
            const command = (0, inject_1.buildInjectionCommand)('disabled', '', '📖');
            (0, bun_test_1.expect)(command).toBeNull();
        });
        (0, bun_test_1.test)('includes sleep 1.5', () => {
            const tmuxCmd = (0, inject_1.buildInjectionCommand)('tmux', '%0', '📖');
            (0, bun_test_1.expect)(tmuxCmd).toContain('sleep 1.5');
            const screenCmd = (0, inject_1.buildInjectionCommand)('screen', '12345', '📖');
            (0, bun_test_1.expect)(screenCmd).toContain('sleep 1.5');
            const osascriptCmd = (0, inject_1.buildInjectionCommand)('osascript', '', '📖');
            (0, bun_test_1.expect)(osascriptCmd).toContain('sleep 1.5');
        });
    });
    (0, bun_test_1.describe)('spawnDetached', () => {
        (0, bun_test_1.test)('does not throw on valid command', () => {
            (0, bun_test_1.expect)(() => {
                (0, inject_1.spawnDetached)('echo test');
            }).not.toThrow();
        });
        (0, bun_test_1.test)('does not throw on invalid command', () => {
            (0, bun_test_1.expect)(() => {
                (0, inject_1.spawnDetached)('');
            }).not.toThrow();
        });
    });
});
