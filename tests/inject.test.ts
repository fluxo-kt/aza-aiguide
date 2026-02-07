import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  isValidPaneId,
  sanitizeForShell,
  detectInjectionMethod,
  buildInjectionCommand,
  spawnDetached,
} from '../src/lib/inject';
import type { InjectionMethod } from '../src/lib/inject';

describe('inject utilities', () => {
  // Store original env values
  let originalTmux: string | undefined;
  let originalTmuxPane: string | undefined;
  let originalSty: string | undefined;

  beforeEach(() => {
    originalTmux = process.env.TMUX;
    originalTmuxPane = process.env.TMUX_PANE;
    originalSty = process.env.STY;
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

    test('returns osascript on darwin with no tmux/screen', () => {
      delete process.env.TMUX;
      delete process.env.TMUX_PANE;
      delete process.env.STY;

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

      const originalPlatform = process.platform;
      // Mock platform check by testing on non-darwin if available
      const result = detectInjectionMethod();
      if (process.platform !== 'darwin') {
        expect(result.method).toBe('disabled');
        expect(result.target).toBe('');
      }
    });
  });

  describe('buildInjectionCommand', () => {
    test('returns tmux command', () => {
      const command = buildInjectionCommand('tmux', '%0', '📖');
      expect(command).not.toBeNull();
      expect(command).toContain('tmux send-keys');
      expect(command).toContain('-t %0');
      expect(command).toContain('-l');
      expect(command).toContain('📖');
      expect(command).toContain('Enter');
    });

    test('returns screen command', () => {
      const command = buildInjectionCommand('screen', '12345.pts-0', '📖');
      expect(command).not.toBeNull();
      expect(command).toContain('screen -S 12345.pts-0');
      expect(command).toContain('-X stuff');
      expect(command).toContain('📖');
      expect(command).toContain('\\n');
    });

    test('returns osascript command', () => {
      const command = buildInjectionCommand('osascript', '', '📖');
      expect(command).not.toBeNull();
      expect(command).toContain('osascript');
      expect(command).toContain('tell application "System Events"');
      expect(command).toContain('keystroke');
      expect(command).toContain('📖');
      expect(command).toContain('return');
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
});
