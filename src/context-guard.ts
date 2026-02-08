#!/usr/bin/env node

import { loadConfig } from './lib/config'
import type { TavConfig } from './lib/config'
import { parseLog } from './lib/log'
import { readStdin } from './lib/stdin'
import { readSessionConfig } from './lib/session'
import { getContextPressure } from './lib/context-pressure'

interface PreToolUseInput {
  session_id?: string
  sessionId?: string
  tool_name?: string
  toolName?: string
  [key: string]: unknown
}

interface PreToolUseOutput {
  continue: boolean
  permissionDecision?: 'allow' | 'deny'
  reason?: string
  hookSpecificOutput?: {
    hookEventName: string
    additionalContext: string
  }
}

/**
 * Evaluates whether a Task tool call should be denied due to context pressure.
 * Pure function for testability — no I/O, no side effects.
 * Receives pre-computed pressure ratio (0–1) rather than computing it internally.
 */
export function evaluateContextPressure(
  config: TavConfig,
  pressure: number,
  toolName: string
): PreToolUseOutput {
  // Intercept all agent spawns — Task is CC's universal agent tool
  // (Explorer, Plan, general-purpose are all subagent_type params to Task)
  if (toolName !== 'Task') {
    return { continue: true }
  }

  if (!config.contextGuard.enabled) {
    return { continue: true }
  }

  // Compare pressure ratio against deny percentage
  if (pressure >= config.contextGuard.denyPercent) {
    const pressurePct = (pressure * 100).toFixed(0)
    const thresholdPct = (config.contextGuard.denyPercent * 100).toFixed(0)
    return {
      continue: true,
      permissionDecision: 'deny',
      reason: `Context pressure critical: ${pressurePct}% (threshold: ${thresholdPct}%). Run /compact before spawning new agents.`,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext:
          '<system-reminder>Context pressure is critically high. Do NOT spawn new subagents. ' +
          'Instead: (1) complete current work, (2) write large outputs to files rather than returning them inline, ' +
          '(3) wait for /compact to reduce context size. The context guard has denied this Task call to prevent session death.</system-reminder>'
      }
    }
  }

  return { continue: true }
}

async function main(): Promise<void> {
  try {
    const input = await readStdin(2500)
    const data: PreToolUseInput = JSON.parse(input)

    const sessionId = data.session_id ?? data.sessionId ?? ''
    const toolName = data.tool_name ?? data.toolName ?? ''

    if (!sessionId || !toolName) {
      console.log(JSON.stringify({ continue: true }))
      return
    }

    const metrics = parseLog(sessionId)

    // Read session config ONCE — provides cached config and JSONL path
    const sessionConfig = readSessionConfig(sessionId)

    // Use cached config from SessionStart (prevents hot-reload race)
    // Fallback to loadConfig() only if session started before config caching was implemented
    const config = sessionConfig?.cachedConfig || loadConfig()
    const jsonlPath = sessionConfig?.jsonlPath ?? null

    const pressure = getContextPressure(jsonlPath, metrics.cumulativeEstimatedTokens, config.contextGuard)
    const result = evaluateContextPressure(config, pressure, toolName)

    console.log(JSON.stringify(result))
  } catch {
    // Never block tool calls on error
    console.log(JSON.stringify({ continue: true }))
  }
}

if (require.main === module) {
  main().then(
    () => process.exit(0),
    () => {
      console.log(JSON.stringify({ continue: true }))
      process.exit(0)
    }
  )
}
