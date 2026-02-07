#!/usr/bin/env node
import { loadConfig } from './lib/config'
import type { TavConfig } from './lib/config'
import { parseLog, appendEvent, sanitizeSessionId } from './lib/log'
import type { LogMetrics } from './lib/log'
import { buildInjectionCommand, spawnDetached } from './lib/inject'
import type { InjectionMethod } from './lib/inject'
import { isContextLimitStop, isUserAbort } from './lib/guards'
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
  const thresholds = config.bookmarks.thresholds

  if (metrics.estimatedTokens >= thresholds.minTokens) {
    return { shouldInject: true, reason: `token threshold met (${metrics.estimatedTokens} >= ${thresholds.minTokens})` }
  }

  if (metrics.toolCalls >= thresholds.minToolCalls) {
    return { shouldInject: true, reason: `tool call threshold met (${metrics.toolCalls} >= ${thresholds.minToolCalls})` }
  }

  if (metrics.elapsedSeconds >= thresholds.minSeconds) {
    return { shouldInject: true, reason: `time threshold met (${metrics.elapsedSeconds} >= ${thresholds.minSeconds})` }
  }

  if (metrics.agentReturns >= thresholds.agentBurstThreshold) {
    return { shouldInject: true, reason: `agent burst threshold met (${metrics.agentReturns} >= ${thresholds.agentBurstThreshold})` }
  }

  return { shouldInject: false, reason: 'no threshold met' }
}

/**
 * Read stdin with timeout
 */
function readStdin(timeoutMs = 5000): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    const timeout = setTimeout(() => {
      reject(new Error('stdin read timeout'))
    }, timeoutMs)

    process.stdin.on('data', (chunk) => chunks.push(chunk))
    process.stdin.on('end', () => {
      clearTimeout(timeout)
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
    process.stdin.on('error', (err) => {
      clearTimeout(timeout)
      reject(err)
    })
  })
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  try {
    const config = loadConfig()
    const input = await readStdin()
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

    // Always allow continuation
    console.log(JSON.stringify({ continue: true }))
  } catch (error) {
    // Always allow continuation even on error
    console.log(JSON.stringify({ continue: true }))
  }
}

if (require.main === module) {
  main()
}
