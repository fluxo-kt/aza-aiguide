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
  detectSessionLocation,
  verifyLocation,
  buildInjectionCommand,
  spawnDetached,
  requestBookmark,
  requestCompaction,
} from '../src/lib/inject'
import type { InjectionConfig, SessionLocation } from '../src/lib/inject'
import { getLogPath } from '../src/lib/log'
import type { TavConfig } from '../src/lib/config'

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

    test('returns disabled for unknown terminal (prevents keystrokes to wrong app)', () => {
      delete process.env.TMUX;
      delete process.env.TMUX_PANE;
      delete process.env.STY;
      delete process.env.TERM_PROGRAM;

      const result = detectInjectionMethod();
      // Unknown terminal → disabled on all platforms (macOS can't safely target)
      expect(result.method).toBe('disabled');
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

    test('returns null for osascript with empty target (prevents blind keystrokes)', () => {
      const command = buildInjectionCommand('osascript', '', '📖');
      expect(command).toBeNull();
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

    test('osascript command includes frontmost application check', () => {
      const command = buildInjectionCommand('osascript', 'Warp', '·');
      expect(command).not.toBeNull();
      // Verify frontmost check is present
      expect(command).toContain('name of first application process whose frontmost is true');
      expect(command).toContain('is "Warp"');
      // Verify conditional structure (if check passes, then inject)
      expect(command).toContain('if osascript');
      expect(command).toContain('then osascript');
      expect(command).toContain('; fi');
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

      // osascript requires a process target; verify with a real target
      const osascriptCmd = buildInjectionCommand('osascript', 'Terminal', '📖');
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
    const mockConfig: TavConfig = {
      bookmarks: {
        enabled: true,
        marker: '·',
        thresholds: { minTokens: 6000, minToolCalls: 15, minSeconds: 120, agentBurstThreshold: 3, cooldownSeconds: 25 }
      },
      contextGuard: { enabled: true, contextWindowTokens: 200000, compactPercent: 0.76, denyPercent: 0.85, compactCooldownSeconds: 120, responseRatio: 0.25 },
      sessionLocation: {
        enabled: false,
        verifyTab: false,
        terminals: { iterm2: { tabVerification: false }, terminal: { tabVerification: false } }
      }
    }

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
      const result = requestBookmark('test-session', injection, '·', undefined, mockConfig, tempDir)
      expect(result).toBe(false)
    })

    test('appends I event to log and returns true for tmux', () => {
      const injection: InjectionConfig = { method: 'tmux', target: '%99' }
      const result = requestBookmark('test-session', injection, '·', undefined, mockConfig, tempDir)
      expect(result).toBe(true)

      const logContent = readFileSync(getLogPath('test-session', tempDir), 'utf-8')
      expect(logContent).toMatch(/^I \d+\n$/)
    })

    test('does not write log when disabled', () => {
      const injection: InjectionConfig = { method: 'disabled', target: '' }
      requestBookmark('test-session', injection, '·', undefined, mockConfig, tempDir)

      const logPath = getLogPath('test-session', tempDir)
      expect(existsSync(logPath)).toBe(false)
    })
  })

  describe('detectSessionLocation', () => {
    test('detects tmux pane from env', () => {
      process.env.TMUX = '/tmp/tmux-1000/default,12345,0'
      process.env.TMUX_PANE = '%3'
      delete process.env.STY

      const location = detectSessionLocation()
      expect(location).not.toBeNull()
      expect(location!.tmuxPane).toBe('%3')
      expect(location!.detectedAt).toBeGreaterThan(0)
    })

    test('detects screen session from env', () => {
      delete process.env.TMUX
      delete process.env.TMUX_PANE
      process.env.STY = '12345.pts-0.hostname'

      const location = detectSessionLocation()
      expect(location).not.toBeNull()
      expect(location!.screenSession).toBe('12345.pts-0.hostname')
    })

    test('returns null when no location identifiers found', () => {
      delete process.env.TMUX
      delete process.env.TMUX_PANE
      delete process.env.STY
      delete process.env.TERM_PROGRAM

      const location = detectSessionLocation()
      // On darwin, might still detect terminal app; on other platforms, null
      if (process.platform !== 'darwin') {
        expect(location).toBeNull()
      }
    })

    test('rejects invalid tmux pane IDs', () => {
      process.env.TMUX = '/tmp/tmux-1000/default'
      process.env.TMUX_PANE = 'invalid'
      delete process.env.STY
      delete process.env.TERM_PROGRAM

      const location = detectSessionLocation()
      // Invalid pane ID should not be stored
      if (location) {
        expect(location.tmuxPane).toBeUndefined()
      }
    })
  })

  describe('verifyLocation', () => {
    const enabledConfig: TavConfig = {
      bookmarks: {
        enabled: true,
        marker: '·',
        thresholds: { minTokens: 6000, minToolCalls: 15, minSeconds: 120, agentBurstThreshold: 3, cooldownSeconds: 25 }
      },
      contextGuard: { enabled: true, contextWindowTokens: 200000, compactPercent: 0.76, denyPercent: 0.85, compactCooldownSeconds: 120, responseRatio: 0.25 },
      sessionLocation: {
        enabled: true,
        verifyTab: false,
        terminals: { iterm2: { tabVerification: false }, terminal: { tabVerification: false } }
      }
    }

    const disabledConfig: TavConfig = {
      ...enabledConfig,
      sessionLocation: {
        enabled: false,
        verifyTab: false,
        terminals: { iterm2: { tabVerification: false }, terminal: { tabVerification: false } }
      }
    }

    test('returns true when feature disabled', () => {
      const declared: SessionLocation = { tmuxPane: '%99', detectedAt: Date.now() }
      // Even with mismatched location, disabled = always pass
      expect(verifyLocation(declared, disabledConfig)).toBe(true)
    })

    test('returns true when no declared location (graceful degradation)', () => {
      expect(verifyLocation(undefined, enabledConfig)).toBe(true)
    })

    test('returns true when tmux pane matches', () => {
      process.env.TMUX = '/tmp/tmux-1000/default'
      process.env.TMUX_PANE = '%3'

      const declared: SessionLocation = { tmuxPane: '%3', detectedAt: Date.now() }
      expect(verifyLocation(declared, enabledConfig)).toBe(true)
    })

    test('returns false when tmux pane mismatches', () => {
      process.env.TMUX = '/tmp/tmux-1000/default'
      process.env.TMUX_PANE = '%5'

      const declared: SessionLocation = { tmuxPane: '%3', detectedAt: Date.now() }
      expect(verifyLocation(declared, enabledConfig)).toBe(false)
    })

    test('returns false when screen session mismatches', () => {
      delete process.env.TMUX
      delete process.env.TMUX_PANE
      process.env.STY = 'different-session'

      const declared: SessionLocation = { screenSession: '12345.pts-0', detectedAt: Date.now() }
      expect(verifyLocation(declared, enabledConfig)).toBe(false)
    })
  })

  describe('requestCompaction', () => {
    let tempDir: string
    const mockConfig: TavConfig = {
      bookmarks: {
        enabled: true,
        marker: '·',
        thresholds: { minTokens: 6000, minToolCalls: 15, minSeconds: 120, agentBurstThreshold: 3, cooldownSeconds: 25 }
      },
      contextGuard: { enabled: true, contextWindowTokens: 200000, compactPercent: 0.76, denyPercent: 0.85, compactCooldownSeconds: 120, responseRatio: 0.25 },
      sessionLocation: {
        enabled: false,
        verifyTab: false,
        terminals: { iterm2: { tabVerification: false }, terminal: { tabVerification: false } }
      }
    }

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
      const result = requestCompaction('test-session', injection, undefined, mockConfig, tempDir)
      expect(result).toBe(false)
    })

    test('appends C event to log and returns true for tmux', () => {
      const injection: InjectionConfig = { method: 'tmux', target: '%99' }
      const result = requestCompaction('test-session', injection, undefined, mockConfig, tempDir)
      expect(result).toBe(true)

      const logContent = readFileSync(getLogPath('test-session', tempDir), 'utf-8')
      expect(logContent).toMatch(/^C \d+\n$/)
    })

    test('does not write log when disabled', () => {
      const injection: InjectionConfig = { method: 'disabled', target: '' }
      requestCompaction('test-session', injection, undefined, mockConfig, tempDir)

      const logPath = getLogPath('test-session', tempDir)
      expect(existsSync(logPath)).toBe(false)
    })
  })
});
