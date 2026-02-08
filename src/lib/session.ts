import { readFileSync, writeFileSync, renameSync } from 'fs'
import { existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { sanitizeSessionId, ensureStateDir } from './log'
import type { TavConfig } from './config'

/**
 * Terminal location snapshot captured at session start.
 * Used for injection safety verification.
 */
export interface SessionLocation {
  tmuxPane?: string      // tmux pane ID (e.g., "%3")
  screenSession?: string // GNU Screen session name
  terminalApp?: string   // macOS terminal process name (e.g., "iTerm2", "Terminal")
  tabId?: string         // terminal tab identifier (iTerm2 UUID, Terminal.app index)
  windowId?: string      // terminal window identifier
  detectedAt: number     // timestamp of detection
}

/**
 * Persisted session config written at SessionStart, read by Stop/SubagentStop hooks.
 * Single source of truth — all hooks import from here.
 */
export interface SessionConfig {
  sessionId: string
  injectionMethod: string
  injectionTarget: string
  startedAt: number
  jsonlPath?: string           // cached JSONL path for context pressure reading (resolved at SessionStart)
  location?: SessionLocation   // terminal location at session start
  disabledReason?: string
  cachedConfig?: TavConfig      // Full config loaded at SessionStart (prevents hot-reload race)
}

function resolveStateDir(stateDir?: string): string {
  return stateDir || join(homedir(), '.claude', 'tav', 'state')
}

function sessionConfigPath(sessionId: string, stateDir?: string): string {
  const sanitized = sanitizeSessionId(sessionId)
  return join(resolveStateDir(stateDir), `${sanitized}.json`)
}

/**
 * Reads session config from the state directory.
 * Returns null if the file doesn't exist or is unreadable.
 */
export function readSessionConfig(sessionId: string, stateDir?: string): SessionConfig | null {
  const path = sessionConfigPath(sessionId, stateDir)

  if (!existsSync(path)) {
    return null
  }

  try {
    const content = readFileSync(path, 'utf-8')
    return JSON.parse(content) as SessionConfig
  } catch {
    return null
  }
}

/**
 * Writes session config to the state directory using atomic write operation.
 * Ensures the state directory exists before writing.
 * Uses write-to-temp + rename for atomicity (prevents partial writes on crash).
 */
export function writeSessionConfig(sessionId: string, config: SessionConfig, stateDir?: string): void {
  ensureStateDir(stateDir)
  const path = sessionConfigPath(sessionId, stateDir)
  const tmpPath = path + '.tmp'

  // Write to temp file first
  writeFileSync(tmpPath, JSON.stringify(config, null, 2), 'utf-8')

  // Atomic rename (POSIX guarantees atomicity)
  renameSync(tmpPath, path)
}
