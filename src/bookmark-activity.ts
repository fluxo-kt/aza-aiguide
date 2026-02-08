#!/usr/bin/env node
import { loadConfig } from './lib/config'
import { appendEvent, parseLog } from './lib/log'
import { buildInjectionCommand, spawnDetached, requestCompaction } from './lib/inject'
import type { InjectionMethod, InjectionConfig } from './lib/inject'
import { readStdin } from './lib/stdin'
import { readSessionConfig } from './lib/session'
import { shouldInjectBookmark, shouldCompact } from './lib/evaluate'
import { getContextPressure } from './lib/context-pressure'

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

export function handleSubagentStop(sessionId: string, data: Record<string, unknown>, logDir?: string, sessionStateDir?: string, configPath?: string): boolean {
  const charCount = measureSize(data.output ?? data.result ?? data.response ?? data.agent_output)
  appendEvent(sessionId, `A ${Date.now()} ${charCount}`, logDir)

  const config = loadConfig(configPath)
  const metrics = parseLog(sessionId, logDir)

  // Read session config ONCE — shared by both compaction and bookmark evaluation
  const sessionConfig = readSessionConfig(sessionId, sessionStateDir)
  const injectionMethod = sessionConfig?.injectionMethod ?? 'disabled'
  const injectionTarget = sessionConfig?.injectionTarget ?? ''
  const jsonlPath = sessionConfig?.jsonlPath ?? null

  // Context guard: proactive compaction injection (independent of bookmark)
  const pressure = getContextPressure(jsonlPath, metrics.cumulativeEstimatedTokens, config.contextGuard)

  // Burst detection: 5+ agent returns in 10 seconds AND pressure > 60%
  // During agent cascades the Stop hook never fires — SubagentStop is the only checkpoint
  const recentBurst = metrics.recentAgentTimestamps.filter(t => Date.now() - t < 10000).length >= 5
  const burstCompact = recentBurst && pressure > 0.60

  const compactEval = shouldCompact({
    pressure,
    config: config.contextGuard,
    metrics,
    injectionMethod
  })

  if (compactEval.shouldCompact || burstCompact) {
    const injection: InjectionConfig = {
      method: injectionMethod as InjectionMethod,
      target: injectionTarget
    }
    requestCompaction(sessionId, injection, logDir)
  }

  // Unified bookmark evaluation — same guard ordering as Stop hook
  const evaluation = shouldInjectBookmark({ config, metrics, injectionMethod })

  if (evaluation.shouldInject) {
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
    const input = await readStdin(2500)
    const data = JSON.parse(input) as HookEvent

    const eventName = data.hook_event_name || data.hookEventName || ''
    const sessionId = data.session_id || data.sessionId || ''

    if (!sessionId) {
      console.log(JSON.stringify({ continue: true }))
      process.exit(0)
    }

    // Dispatch by event name, with fallback heuristics if hook_event_name
    // is missing: presence of tool_name implies PostToolUse, agent_id
    // implies SubagentStop.
    if (eventName === 'PostToolUse' || (!eventName && data.tool_name)) {
      handlePostToolUse(sessionId, data)
    } else if (eventName === 'SubagentStop' || (!eventName && data.agent_id)) {
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
