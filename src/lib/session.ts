import { readFileSync, writeFileSync } from 'fs'
import { existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { sanitizeSessionId, ensureStateDir } from './log'

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
  disabledReason?: string
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
 * Writes session config to the state directory.
 * Ensures the state directory exists before writing.
 */
export function writeSessionConfig(sessionId: string, config: SessionConfig, stateDir?: string): void {
  ensureStateDir(stateDir)
  const path = sessionConfigPath(sessionId, stateDir)
  writeFileSync(path, JSON.stringify(config, null, 2), 'utf-8')
}
