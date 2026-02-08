#!/usr/bin/env node
import { loadConfig } from './lib/config'
import type { TavConfig } from './lib/config'
import { parseLog, appendEvent } from './lib/log'
import type { LogMetrics } from './lib/log'
import { buildInjectionCommand, spawnDetached, requestCompaction } from './lib/inject'
import type { InjectionMethod, InjectionConfig } from './lib/inject'
import { isContextLimitStop, isUserAbort } from './lib/guards'
import { readStdin } from './lib/stdin'
import { readSessionConfig } from './lib/session'
import { shouldInjectBookmark, shouldCompact } from './lib/evaluate'
import { getContextPressure } from './lib/context-pressure'

/**
 * Evaluates whether to inject a bookmark after Claude's turn ends.
 * Stop-specific guards (contextLimitStop, userAbort) are checked here;
 * common guards are delegated to shouldInjectBookmark.
 */
export function evaluateBookmark(
  data: Record<string, unknown>,
  config: TavConfig,
  metrics: LogMetrics,
  injectionMethod: InjectionMethod
): { shouldInject: boolean; reason: string } {
  // Stop-specific guard: context limit stop (let compaction happen)
  if (isContextLimitStop(data)) {
    return { shouldInject: false, reason: 'context limit stop detected' }
  }

  // Stop-specific guard: user abort
  if (isUserAbort(data)) {
    return { shouldInject: false, reason: 'user abort detected' }
  }

  // Common evaluation (enabled, disabled, lastLineIsBookmark, cooldown, thresholds)
  return shouldInjectBookmark({ config, metrics, injectionMethod })
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  try {
    const config = loadConfig()
    const input = await readStdin(4000)
    const data: Record<string, unknown> = JSON.parse(input)

    // Normalize field names (camelCase variants)
    const sessionId = (data.session_id || data.sessionId) as string | undefined

    if (!sessionId) {
      console.log(JSON.stringify({ continue: true }))
      return
    }

    // Read session config via shared module
    const sessionConfig = readSessionConfig(sessionId)

    if (!sessionConfig) {
      console.log(JSON.stringify({ continue: true }))
      return
    }

    const injectionMethod = (sessionConfig.injectionMethod || 'disabled') as InjectionMethod
    const injectionTarget = sessionConfig.injectionTarget || ''
    const jsonlPath = sessionConfig.jsonlPath ?? null

    // Parse log metrics
    const metrics = parseLog(sessionId)

    // Evaluate whether to inject bookmark
    const evaluation = evaluateBookmark(data, config, metrics, injectionMethod)

    if (evaluation.shouldInject) {
      // Append pre-spawn marker to log
      appendEvent(sessionId, `I ${Date.now()}`)

      // Build and spawn injection command
      const command = buildInjectionCommand(
        injectionMethod,
        injectionTarget,
        config.bookmarks.marker
      )

      if (command) {
        spawnDetached(command)
      }
    }

    // Context guard: proactive compaction injection (independent of bookmark)
    const pressure = getContextPressure(jsonlPath, metrics.cumulativeEstimatedTokens, config.contextGuard)

    const compactEval = shouldCompact({
      pressure,
      config: config.contextGuard,
      metrics,
      injectionMethod
    })

    if (compactEval.shouldCompact) {
      const injection: InjectionConfig = { method: injectionMethod, target: injectionTarget }
      requestCompaction(sessionId, injection)
    }

    // Always allow continuation
    console.log(JSON.stringify({ continue: true }))
  } catch (error) {
    // Always allow continuation even on error
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
