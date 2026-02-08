#!/usr/bin/env node

import { appendEvent, parseLog } from './lib/log'
import { readStdin } from './lib/stdin'
import { readSessionConfig } from './lib/session'
import { loadConfig } from './lib/config'
import { getContextPressure } from './lib/context-pressure'

interface PreCompactInput {
  session_id?: string
  sessionId?: string
  [key: string]: unknown
}

interface HookOutput {
  continue: boolean
  hookSpecificOutput?: {
    hookEventName: string
    additionalContext: string
  }
}

/**
 * Processes a PreCompact event: resets the activity log window and injects
 * additionalContext so compaction preserves bookmark awareness.
 *
 * Optionally includes real context pressure % when JSONL path is available.
 */
export function processPreCompact(
  sessionId: string,
  logDir?: string,
  sessionStateDir?: string
): HookOutput {
  // Read current metrics before reset
  const metrics = parseLog(sessionId, logDir)

  // Append B marker — resets the activity window.
  // After compaction, old T/A lines represent tokens that no longer exist
  // in the context. The B marker ensures thresholds start from zero.
  appendEvent(sessionId, `B ${Date.now()}`, logDir)

  // Optionally compute real context pressure for informational message
  let pressureInfo = ''
  try {
    const sessionConfig = readSessionConfig(sessionId, sessionStateDir)
    if (sessionConfig?.jsonlPath) {
      const config = loadConfig()
      const pressure = getContextPressure(sessionConfig.jsonlPath, metrics.cumulativeEstimatedTokens, config.contextGuard)
      pressureInfo = ` Context pressure at compaction: ${(pressure * 100).toFixed(0)}%.`
    }
  } catch {
    // Non-critical — skip pressure info on error
  }

  // Build summary for additionalContext — survives into the compacted context
  const summary =
    `<system-reminder>tav bookmark plugin: activity log reset after compaction. ` +
    `Pre-compaction metrics: ~${metrics.cumulativeEstimatedTokens} cumulative tokens, ` +
    `${metrics.toolCalls} tool calls, ${metrics.agentReturns} agent returns.` +
    pressureInfo +
    ` Bookmark navigation points (·) are being managed automatically.</system-reminder>`

  return {
    continue: true,
    hookSpecificOutput: {
      hookEventName: 'PreCompact',
      additionalContext: summary
    }
  }
}

async function main(): Promise<void> {
  try {
    const input = await readStdin(2500)
    const data: PreCompactInput = JSON.parse(input)

    const sessionId = data.session_id ?? data.sessionId ?? ''

    if (!sessionId) {
      console.log(JSON.stringify({ continue: true }))
      return
    }

    const result = processPreCompact(sessionId)
    console.log(JSON.stringify(result))
  } catch {
    // Never block compaction on error
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
