#!/usr/bin/env node
import { loadConfig } from './lib/config'
import type { TavConfig } from './lib/config'
import { parseLog, appendEvent, sanitizeSessionId, meetsAnyThreshold } from './lib/log'
import type { LogMetrics } from './lib/log'
import { buildInjectionCommand, spawnDetached, requestCompaction } from './lib/inject'
import type { InjectionMethod, InjectionConfig } from './lib/inject'
import { isContextLimitStop, isUserAbort } from './lib/guards'
import { readStdin } from './lib/stdin'
import { readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

/**
 * Evaluates whether to inject a bookmark after Claude's turn ends.
 */
export function evaluateBookmark(
  data: Record<string, unknown>,
  config: TavConfig,
  metrics: LogMetrics,
  injectionMethod: InjectionMethod
): { shouldInject: boolean; reason: string } {
  // Guard 1: Bookmarks disabled globally
  if (!config.bookmarks.enabled) {
    return { shouldInject: false, reason: 'bookmarks disabled in config' }
  }

  // Guard 2: Injection disabled for this session
  if (injectionMethod === 'disabled') {
    return { shouldInject: false, reason: 'injection method is disabled' }
  }

  // Guard 3: Context limit stop (let compaction happen)
  if (isContextLimitStop(data)) {
    return { shouldInject: false, reason: 'context limit stop detected' }
  }

  // Guard 4: User abort
  if (isUserAbort(data)) {
    return { shouldInject: false, reason: 'user abort detected' }
  }

  // Guard 5: Last line is already a bookmark
  if (metrics.lastLineIsBookmark) {
    return { shouldInject: false, reason: 'last line is already a bookmark' }
  }

  // Guard 6: Cooldown check
  const lastActivityAt = Math.max(metrics.lastInjectionAt, metrics.lastBookmarkAt)
  const cooldownMs = config.bookmarks.thresholds.cooldownSeconds * 1000
  if (Date.now() - lastActivityAt < cooldownMs) {
    return { shouldInject: false, reason: 'within cooldown period' }
  }

  // Threshold evaluation (ANY threshold met triggers bookmark)
  const { met, reason } = meetsAnyThreshold(metrics, config.bookmarks.thresholds)
  return { shouldInject: met, reason }
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

    // Read session config
    const sanitized = sanitizeSessionId(sessionId)
    const sessionConfigPath = join(homedir(), '.claude', 'tav', 'state', `${sanitized}.json`)

    let injectionMethod: InjectionMethod = 'disabled'
    let injectionTarget = ''

    try {
      const sessionConfigRaw = readFileSync(sessionConfigPath, 'utf8')
      const sessionConfig = JSON.parse(sessionConfigRaw)
      injectionMethod = sessionConfig.injectionMethod || 'disabled'
      injectionTarget = sessionConfig.injectionTarget || ''
    } catch {
      // Session config missing or unreadable
      console.log(JSON.stringify({ continue: true }))
      return
    }

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
    if (config.contextGuard.enabled && injectionMethod !== 'disabled') {
      const cg = config.contextGuard
      if (metrics.cumulativeEstimatedTokens >= cg.compactThreshold) {
        const compactCooldownMs = cg.compactCooldownSeconds * 1000
        const timeSinceCompaction = Date.now() - metrics.lastCompactionAt
        if (timeSinceCompaction >= compactCooldownMs) {
          const injection: InjectionConfig = { method: injectionMethod, target: injectionTarget }
          requestCompaction(sessionId, injection)
        }
      }
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
