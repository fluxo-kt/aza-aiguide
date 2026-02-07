import { spawn } from 'child_process';
import type { ChildProcess } from 'child_process';

export type InjectionMethod = 'tmux' | 'screen' | 'osascript' | 'disabled';

export interface InjectionConfig {
  method: InjectionMethod;
  target: string; // pane ID for tmux (%N), session for screen, empty for osascript/disabled
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
      return `sh -c 'sleep 1.5 && tmux send-keys -t ${sanitizedTarget} -l '\''${sanitizedMarker}'\'' && tmux send-keys -t ${sanitizedTarget} Enter'`;

    case 'screen':
      // Use stuff command with \n for newline
      return `sh -c 'sleep 1.5 && screen -S ${sanitizedTarget} -X stuff '\''${sanitizedMarker}\\n'\'''`;

    case 'osascript':
      // macOS keystroke automation
      return `sh -c 'sleep 1.5 && osascript -e '\''tell application "System Events" to keystroke "${sanitizedMarker}" & return'\'''`;

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
