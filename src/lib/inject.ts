import { spawn, execSync } from 'child_process'
import type { ChildProcess } from 'child_process'
import { appendEvent } from './log'

export type InjectionMethod = 'tmux' | 'screen' | 'osascript' | 'disabled';

export interface InjectionConfig {
  method: InjectionMethod;
  target: string; // pane ID for tmux (%N), session for screen, empty for osascript/disabled
  tabId?: string;  // terminal tab identifier (iTerm2: UUID, Terminal.app: tab index)
  windowId?: string; // terminal window identifier
}

/**
 * Validates that a pane ID matches the tmux pane format (%N).
 */
export function isValidPaneId(paneId: string): boolean {
  return /^%\d+$/.test(paneId);
}

/**
 * Escapes single quotes for safe use in single-quoted shell strings.
 * Replaces ' with '\''
 */
export function sanitizeForShell(text: string): string {
  return text.replace(/'/g, "'\\''");
}

/**
 * Escapes characters for safe interpolation into AppleScript double-quoted strings.
 * Escapes backslash and double-quote to prevent breakout.
 */
export function sanitizeForAppleScript(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Resolves the macOS process name for the current terminal emulator.
 * Used for process-targeted AppleScript keystroke injection.
 *
 * Returns empty string for unrecognised terminals — detectInjectionMethod
 * will disable osascript to prevent keystrokes landing in the wrong app.
 */
export function resolveTerminalProcessName(): string {
  const termProgram = process.env.TERM_PROGRAM || '';
  const mapping: Record<string, string> = {
    'WarpTerminal': 'Warp',
    'iTerm.app': 'iTerm2',
    'Apple_Terminal': 'Terminal',
    'ghostty': 'ghostty',
    'vscode': 'Code',
    'Hyper': 'Hyper',
    'Alacritty': 'Alacritty',
    'kitty': 'kitty',
  };
  return mapping[termProgram] ?? '';
}

/**
 * Tests whether macOS Accessibility permissions are granted for osascript.
 * Runs a lightweight probe command against System Events.
 * Returns true if Accessibility is available, false otherwise.
 * Always returns true on non-macOS platforms (not applicable).
 */
export function checkAccessibilityPermission(): boolean {
  if (process.platform !== 'darwin') return true;

  try {
    execSync(
      'osascript -e \'tell application "System Events" to return name of first process\'',
      { timeout: 2000, stdio: ['pipe', 'pipe', 'pipe'] }
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Detects the available injection method based on environment variables and platform.
 */
export function detectInjectionMethod(): InjectionConfig {
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

  // Check for macOS — only use osascript when we can identify the terminal process.
  // Without process-targeted injection, keystrokes go to the frontmost app which
  // can land in the wrong application (browser, editor) when the user switches focus.
  if (process.platform === 'darwin') {
    const terminalProcess = resolveTerminalProcessName()
    if (terminalProcess) {
      return { method: 'osascript', target: terminalProcess }
    }
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
export function buildInjectionCommand(
  method: InjectionMethod,
  target: string,
  marker: string
): string | null {
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

    case 'osascript': {
      // macOS keystroke automation — split into separate keystroke + Enter for reliability.
      // CRITICAL: Frontmost application check prevents keystrokes landing in the wrong app.
      // Double sanitisation: AppleScript first (escape " and \), then shell (escape ')
      // to prevent both AppleScript injection and shell single-quote breakout.
      if (!target) return null  // Defence-in-depth: never send blind keystrokes
      const asTarget = sanitizeForShell(sanitizeForAppleScript(target))
      const asMarker = sanitizeForShell(sanitizeForAppleScript(marker))

      // Frontmost check: only inject if terminal is the active application
      // This prevents keystrokes landing in browser/IDE when user switches windows
      const frontmostCheck = `tell application "System Events" to (name of first application process whose frontmost is true) is "${asTarget}"`
      const tellTarget = `tell application "System Events" to tell process "${asTarget}"`

      // Command structure: check frontmost → keystroke → Enter (only if check passes)
      return `sleep 1.5 && if osascript -e '${frontmostCheck}' >/dev/null 2>&1; then osascript -e '${tellTarget} to keystroke "${asMarker}"' && sleep 0.2 && osascript -e '${tellTarget} to key code 36'; fi`
    }

    default:
      return null;
  }
}

/**
 * Spawns a detached shell command that won't keep the parent process alive.
 * Never throws - errors are silently ignored.
 */
export function spawnDetached(command: string): void {
  try {
    const child: ChildProcess = spawn('sh', ['-c', command], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  } catch {
    // Silently ignore errors
  }
}

/**
 * High-level bookmark injection: appends pre-spawn 'I' marker, builds
 * injection command for the configured marker, and spawns detached.
 * Returns true if injection was spawned, false if method is disabled.
 */
export function requestBookmark(
  sessionId: string,
  injection: InjectionConfig,
  marker: string,
  stateDir?: string
): boolean {
  if (injection.method === 'disabled') return false

  const command = buildInjectionCommand(injection.method, injection.target, marker)
  if (!command) return false

  appendEvent(sessionId, `I ${Date.now()}`, stateDir)
  spawnDetached(command)
  return true
}

/**
 * High-level compaction injection: appends pre-spawn 'C' marker, builds
 * injection command for '/compact', and spawns detached.
 * Returns true if injection was spawned, false if method is disabled.
 */
export function requestCompaction(
  sessionId: string,
  injection: InjectionConfig,
  stateDir?: string
): boolean {
  if (injection.method === 'disabled') return false

  const command = buildInjectionCommand(injection.method, injection.target, '/compact')
  if (!command) return false

  appendEvent(sessionId, `C ${Date.now()}`, stateDir)
  spawnDetached(command)
  return true
}
