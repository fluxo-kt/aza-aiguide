#!/usr/bin/env node
import { loadConfig } from './lib/config'
import { appendEvent, parseLog, sanitizeSessionId } from './lib/log'
import { buildInjectionCommand, spawnDetached } from './lib/inject'
import type { InjectionMethod } from './lib/inject'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

interface SessionConfig {
  sessionId: string
  injectionMethod: string
  injectionTarget: string
  startedAt: number
}

interface HookEvent {
  hook_event_name?: string
  hookEventName?: string
  session_id?: string
  sessionId?: string
  tool_name?: string
  toolName?: string
  tool_response?: string
  toolResponse?: string
  toolOutput?: string
  output?: string
  [key: string]: unknown
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = ''
    process.stdin.setEncoding('utf-8')
    process.stdin.on('data', (chunk: string) => { data += chunk })
    process.stdin.on('end', () => { resolve(data) })
    setTimeout(() => { resolve(data) }, 2000)
  })
}

function getSessionConfig(sessionId: string, stateDir?: string): SessionConfig | null {
  const dir = stateDir || join(homedir(), '.claude', 'tav', 'state')
  const sanitized = sanitizeSessionId(sessionId)
  const path = join(dir, `${sanitized}.json`)

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
 * Measures the size of a hook data field in characters.
 * Handles strings directly, serialises objects, and defaults to 0 for nullish values.
 */
function measureSize(value: unknown): number {
  if (typeof value === 'string') return value.length
  if (value == null) return 0
  try {
    return JSON.stringify(value).length
  } catch {
    return 0
  }
}

export function handlePostToolUse(sessionId: string, data: Record<string, unknown>, logDir?: string): void {
  const charCount = measureSize(data.tool_response ?? data.toolResponse ?? data.toolOutput)
  appendEvent(sessionId, `T ${Date.now()} ${charCount}`, logDir)
}

export function handleSubagentStop(sessionId: string, data: Record<string, unknown>, logDir?: string, sessionStateDir?: string): boolean {
  const charCount = measureSize(data.output)
  appendEvent(sessionId, `A ${Date.now()} ${charCount}`, logDir)

  const config = loadConfig()
  const metrics = parseLog(sessionId, logDir)

  if (metrics.agentReturns >= config.bookmarks.thresholds.agentBurstThreshold) {
    const cooldownMs = config.bookmarks.thresholds.cooldownSeconds * 1000
    const timeSinceLastAction = Date.now() - Math.max(metrics.lastInjectionAt, metrics.lastBookmarkAt)

    if (timeSinceLastAction < cooldownMs) {
      return false
    }

    const sessionConfig = getSessionConfig(sessionId, sessionStateDir)
    if (!sessionConfig) {
      return false
    }

    const { injectionMethod, injectionTarget } = sessionConfig

    if (injectionMethod === 'disabled') {
      return false
    }

    appendEvent(sessionId, `I ${Date.now()}`, logDir)

    const command = buildInjectionCommand(injectionMethod as InjectionMethod, injectionTarget, config.bookmarks.marker)
    if (command) {
      spawnDetached(command)
      return true
    }
  }

  return false
}

async function main(): Promise<void> {
  try {
    const input = await readStdin()
    const data = JSON.parse(input) as HookEvent

    const eventName = data.hook_event_name || data.hookEventName || ''
    const sessionId = data.session_id || data.sessionId || ''

    if (!sessionId) {
      console.log(JSON.stringify({ continue: true }))
      process.exit(0)
    }

    if (eventName === 'PostToolUse') {
      handlePostToolUse(sessionId, data)
    } else if (eventName === 'SubagentStop') {
      handleSubagentStop(sessionId, data)
    }

    console.log(JSON.stringify({ continue: true }))
    process.exit(0)
  } catch {
    console.log(JSON.stringify({ continue: true }))
    process.exit(0)
  }
}

if (require.main === module) {
  main()
}
