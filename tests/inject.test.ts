import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  isValidPaneId,
  sanitizeForShell,
  sanitizeForAppleScript,
  resolveTerminalProcessName,
  checkAccessibilityPermission,
  detectInjectionMethod,
  buildInjectionCommand,
  spawnDetached,
  requestBookmark,
  requestCompaction,
} from '../src/lib/inject'
import type { InjectionConfig } from '../src/lib/inject'
import { getLogPath } from '../src/lib/log'

describe('inject utilities', () => {
  // Store original env values
  let originalTmux: string | undefined;
  let originalTmuxPane: string | undefined;
  let originalSty: string | undefined;
  let originalTermProgram: string | undefined;

  beforeEach(() => {
    originalTmux = process.env.TMUX;
    originalTmuxPane = process.env.TMUX_PANE;
    originalSty = process.env.STY;
    originalTermProgram = process.env.TERM_PROGRAM;
  });

  afterEach(() => {
    // Restore original values
    if (originalTmux !== undefined) {
      process.env.TMUX = originalTmux;
    } else {
      delete process.env.TMUX;
    }
    if (originalTmuxPane !== undefined) {
      process.env.TMUX_PANE = originalTmuxPane;
    } else {
      delete process.env.TMUX_PANE;
    }
    if (originalSty !== undefined) {
      process.env.STY = originalSty;
    } else {
      delete process.env.STY;
    }
    if (originalTermProgram !== undefined) {
      process.env.TERM_PROGRAM = originalTermProgram;
    } else {
      delete process.env.TERM_PROGRAM;
    }
  });

  describe('isValidPaneId', () => {
    test('accepts valid pane IDs', () => {
      expect(isValidPaneId('%0')).toBe(true);
      expect(isValidPaneId('%1')).toBe(true);
      expect(isValidPaneId('%123')).toBe(true);
      expect(isValidPaneId('%999')).toBe(true);
    });

    test('rejects invalid pane IDs', () => {
      expect(isValidPaneId('')).toBe(false);
      expect(isValidPaneId('%abc')).toBe(false);
      expect(isValidPaneId('123')).toBe(false);
      expect(isValidPaneId('%')).toBe(false);
      expect(isValidPaneId('; rm -rf')).toBe(false);
      expect(isValidPaneId('% 1')).toBe(false);
      expect(isValidPaneId('%1a')).toBe(false);
    });
  });

  describe('sanitizeForShell', () => {
    test('escapes single quotes', () => {
      expect(sanitizeForShell("it's")).toBe("it'\\''s");
      expect(sanitizeForShell("don't")).toBe("don'\\''t");
      expect(sanitizeForShell("'quoted'")).toBe("'\\''quoted'\\''");
      expect(sanitizeForShell("no quotes")).toBe("no quotes");
    });
  });

  describe('detectInjectionMethod', () => {
    test('returns tmux when TMUX and TMUX_PANE set', () => {
      process.env.TMUX = '/tmp/tmux-1000/default,12345,0';
      process.env.TMUX_PANE = '%0';

      const result = detectInjectionMethod();
      expect(result.method).toBe('tmux');
      expect(result.target).toBe('%0');
    });

    test('returns screen when STY set', () => {
      delete process.env.TMUX;
      delete process.env.TMUX_PANE;
      process.env.STY = '12345.pts-0.hostname';

      const result = detectInjectionMethod();
      expect(result.method).toBe('screen');
      expect(result.target).toBe('12345.pts-0.hostname');
    });

    test('returns osascript on darwin with terminal process name as target', () => {
      delete process.env.TMUX;
      delete process.env.TMUX_PANE;
      delete process.env.STY;
      process.env.TERM_PROGRAM = 'WarpTerminal';

      const result = detectInjectionMethod();
      if (process.platform === 'darwin') {
        expect(result.method).toBe('osascript');
        expect(result.target).toBe('Warp');
      } else {
        expect(result.method).toBe('disabled');
      }
    });

    test('returns osascript with empty target for unknown terminal', () => {
      delete process.env.TMUX;
      delete process.env.TMUX_PANE;
      delete process.env.STY;
      delete process.env.TERM_PROGRAM;

      const result = detectInjectionMethod();
      if (process.platform === 'darwin') {
        expect(result.method).toBe('osascript');
        expect(result.target).toBe('');
      } else {
        expect(result.method).toBe('disabled');
      }
    });

    test('returns disabled when nothing available', () => {
      delete process.env.TMUX;
      delete process.env.TMUX_PANE;
      delete process.env.STY;

      // Can only test on non-darwin platforms
      const result = detectInjectionMethod();
      if (process.platform !== 'darwin') {
        expect(result.method).toBe('disabled');
        expect(result.target).toBe('');
      }
    });
  });

  describe('sanitizeForAppleScript', () => {
    test('escapes double quotes', () => {
      expect(sanitizeForAppleScript('hello "world"')).toBe('hello \\"world\\"');
    });

    test('escapes backslashes', () => {
      expect(sanitizeForAppleScript('path\\to\\file')).toBe('path\\\\to\\\\file');
    });

    test('escapes both together', () => {
      expect(sanitizeForAppleScript('" & do shell script "evil" & "')).toBe(
        '\\" & do shell script \\"evil\\" & \\"'
      );
    });

    test('leaves safe strings unchanged', () => {
      expect(sanitizeForAppleScript('·')).toBe('·');
      expect(sanitizeForAppleScript('Warp')).toBe('Warp');
    });
  });

  describe('resolveTerminalProcessName', () => {
    test('resolves known terminals to process names', () => {
      const cases: [string, string][] = [
        ['WarpTerminal', 'Warp'],
        ['iTerm.app', 'iTerm2'],
        ['Apple_Terminal', 'Terminal'],
        ['ghostty', 'ghostty'],
        ['vscode', 'Code'],
        ['Hyper', 'Hyper'],
        ['Alacritty', 'Alacritty'],
        ['kitty', 'kitty'],
      ];
      for (const [termProgram, expected] of cases) {
        process.env.TERM_PROGRAM = termProgram;
        expect(resolveTerminalProcessName()).toBe(expected);
      }
    });

    test('returns empty string for unknown terminal', () => {
      process.env.TERM_PROGRAM = 'SomeOtherTerminal';
      expect(resolveTerminalProcessName()).toBe('');
    });

    test('returns empty string for JetBrains embedded terminal', () => {
      // IDE terminals get empty string — falls back to generic osascript.
      // Injection may not work in IDE terminals; user types · manually.
      process.env.TERM_PROGRAM = 'JetBrains-JediTerm';
      expect(resolveTerminalProcessName()).toBe('');
    });

    test('returns empty string when TERM_PROGRAM is unset', () => {
      delete process.env.TERM_PROGRAM;
      expect(resolveTerminalProcessName()).toBe('');
    });
  });

  describe('checkAccessibilityPermission', () => {
    test('returns a boolean', () => {
      // On macOS this will actually probe Accessibility;
      // on other platforms it always returns true.
      const result = checkAccessibilityPermission();
      expect(typeof result).toBe('boolean');
    });

    test('returns true on non-darwin platforms', () => {
      if (process.platform !== 'darwin') {
        expect(checkAccessibilityPermission()).toBe(true);
      }
    });

    test('returns boolean on darwin (actual system check)', () => {
      if (process.platform === 'darwin') {
        // We can't control Accessibility state in tests, but we can
        // verify it doesn't throw and returns a boolean.
        const result = checkAccessibilityPermission();
        expect(typeof result).toBe('boolean');
      }
    });
  });

  describe('buildInjectionCommand', () => {
    test('returns tmux command with quoted target and marker', () => {
      const command = buildInjectionCommand('tmux', '%0', '📖');
      expect(command).not.toBeNull();
      expect(command).toContain('tmux send-keys');
      expect(command).toContain("-t '%0'");
      expect(command).toContain('-l');
      expect(command).toContain("'📖'");
      expect(command).toContain('Enter');
    });

    test('returns screen command with quoted target and marker', () => {
      const command = buildInjectionCommand('screen', '12345.pts-0', '📖');
      expect(command).not.toBeNull();
      expect(command).toContain("screen -S '12345.pts-0'");
      expect(command).toContain('-X stuff');
      expect(command).toContain("'📖");
      expect(command).toContain('\\n');
    });

    test('returns osascript command with generic targeting', () => {
      const command = buildInjectionCommand('osascript', '', '📖');
      expect(command).not.toBeNull();
      expect(command).toContain('osascript');
      expect(command).toContain('tell application "System Events"');
      expect(command).toContain('keystroke');
      expect(command).toContain('📖');
      // Separate keystroke and Enter commands
      expect(command).toContain('key code 36');
    });

    test('returns osascript command with process-targeted injection', () => {
      const command = buildInjectionCommand('osascript', 'Warp', '📖');
      expect(command).not.toBeNull();
      expect(command).toContain('tell process "Warp"');
      expect(command).toContain('keystroke');
      expect(command).toContain('📖');
      expect(command).toContain('key code 36');
    });

    test('osascript command prevents single-quote shell breakout', () => {
      // If marker contains a single quote, it must be escaped for the shell context
      const command = buildInjectionCommand('osascript', 'Warp', "test'marker");
      expect(command).not.toBeNull();
      // The single quote should be escaped via sanitizeForShell (becomes '\'')
      expect(command).not.toContain("test'marker");
      expect(command).toContain('test');
      expect(command).toContain('marker');
    });

    test('returns null for disabled', () => {
      const command = buildInjectionCommand('disabled', '', '📖');
      expect(command).toBeNull();
    });

    test('includes sleep 1.5', () => {
      const tmuxCmd = buildInjectionCommand('tmux', '%0', '📖');
      expect(tmuxCmd).toContain('sleep 1.5');

      const screenCmd = buildInjectionCommand('screen', '12345', '📖');
      expect(screenCmd).toContain('sleep 1.5');

      const osascriptCmd = buildInjectionCommand('osascript', '', '📖');
      expect(osascriptCmd).toContain('sleep 1.5');
    });
  });

  describe('spawnDetached', () => {
    test('does not throw on valid command', () => {
      expect(() => {
        spawnDetached('echo test');
      }).not.toThrow();
    });

    test('does not throw on invalid command', () => {
      expect(() => {
        spawnDetached('');
      }).not.toThrow();
    });
  });

  describe('requestBookmark', () => {
    let tempDir: string

    beforeEach(() => {
      tempDir = join(tmpdir(), `tav-inject-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
      mkdirSync(tempDir, { recursive: true })
    })

    afterEach(() => {
      if (existsSync(tempDir)) {
        rmSync(tempDir, { recursive: true, force: true })
      }
    })

    test('returns false when injection method is disabled', () => {
      const injection: InjectionConfig = { method: 'disabled', target: '' }
      const result = requestBookmark('test-session', injection, '·', tempDir)
      expect(result).toBe(false)
    })

    test('appends I event to log and returns true for tmux', () => {
      const injection: InjectionConfig = { method: 'tmux', target: '%99' }
      const result = requestBookmark('test-session', injection, '·', tempDir)
      expect(result).toBe(true)

      const logContent = readFileSync(getLogPath('test-session', tempDir), 'utf-8')
      expect(logContent).toMatch(/^I \d+\n$/)
    })

    test('does not write log when disabled', () => {
      const injection: InjectionConfig = { method: 'disabled', target: '' }
      requestBookmark('test-session', injection, '·', tempDir)

      const logPath = getLogPath('test-session', tempDir)
      expect(existsSync(logPath)).toBe(false)
    })
  })

  describe('requestCompaction', () => {
    let tempDir: string

    beforeEach(() => {
      tempDir = join(tmpdir(), `tav-inject-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
      mkdirSync(tempDir, { recursive: true })
    })

    afterEach(() => {
      if (existsSync(tempDir)) {
        rmSync(tempDir, { recursive: true, force: true })
      }
    })

    test('returns false when injection method is disabled', () => {
      const injection: InjectionConfig = { method: 'disabled', target: '' }
      const result = requestCompaction('test-session', injection, tempDir)
      expect(result).toBe(false)
    })

    test('appends C event to log and returns true for tmux', () => {
      const injection: InjectionConfig = { method: 'tmux', target: '%99' }
      const result = requestCompaction('test-session', injection, tempDir)
      expect(result).toBe(true)

      const logContent = readFileSync(getLogPath('test-session', tempDir), 'utf-8')
      expect(logContent).toMatch(/^C \d+\n$/)
    })

    test('does not write log when disabled', () => {
      const injection: InjectionConfig = { method: 'disabled', target: '' }
      requestCompaction('test-session', injection, tempDir)

      const logPath = getLogPath('test-session', tempDir)
      expect(existsSync(logPath)).toBe(false)
    })
  })
});
