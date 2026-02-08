import type { TavConfig } from './config'
import type { LogMetrics } from './log'
import { meetsAnyThreshold } from './log'

/**
 * Common inputs for bookmark injection evaluation.
 * Callers handle context-specific pre-guards before calling shouldInjectBookmark:
 * - Stop hook: isContextLimitStop, isUserAbort (checked before calling)
 * - SubagentStop hook: session config resolution (read first, pass injectionMethod)
 */
export interface EvalContext {
  config: TavConfig
  metrics: LogMetrics
  injectionMethod: string
}

export interface EvalResult {
  shouldInject: boolean
  reason: string
}

/**
 * Unified bookmark injection evaluation — single source of truth for guard
 * ordering. Both Stop and SubagentStop hooks call this after their own
 * context-specific pre-guards.
 *
 * Guard order (fixed, not subject to drift):
 *   1. bookmarks.enabled
 *   2. injectionMethod !== 'disabled'
 *   3. lastLineIsBookmark
 *   4. cooldown
 *   5. threshold evaluation (ANY threshold met → inject)
 */
export function shouldInjectBookmark(ctx: EvalContext): EvalResult {
  const { config, metrics, injectionMethod } = ctx

  if (!config.bookmarks.enabled) {
    return { shouldInject: false, reason: 'bookmarks disabled in config' }
  }

  if (injectionMethod === 'disabled') {
    return { shouldInject: false, reason: 'injection method is disabled' }
  }

  if (metrics.lastLineIsBookmark) {
    return { shouldInject: false, reason: 'last line is already a bookmark' }
  }

  const lastActivityAt = Math.max(metrics.lastInjectionAt, metrics.lastBookmarkAt)
  const cooldownMs = config.bookmarks.thresholds.cooldownSeconds * 1000
  if (Date.now() - lastActivityAt < cooldownMs) {
    return { shouldInject: false, reason: 'within cooldown period' }
  }

  const { met, reason } = meetsAnyThreshold(metrics, config.bookmarks.thresholds)
  return { shouldInject: met, reason }
}
