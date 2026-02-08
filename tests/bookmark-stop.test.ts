import { describe, test, expect } from 'bun:test'
import { evaluateBookmark } from '../src/bookmark-stop'
import { DEFAULT_CONFIG } from '../src/lib/config'
import type { TavConfig } from '../src/lib/config'
import type { LogMetrics } from '../src/lib/log'

/** Config with both features enabled — for testing active behaviour */
const ACTIVE_CONFIG: TavConfig = {
  ...DEFAULT_CONFIG,
  bookmarks: { ...DEFAULT_CONFIG.bookmarks, enabled: true },
  contextGuard: { ...DEFAULT_CONFIG.contextGuard, enabled: true },
}

function defaultMetrics(): LogMetrics {
  return {
    toolCalls: 0,
    agentReturns: 0,
    estimatedTokens: 0,
    cumulativeEstimatedTokens: 0,
    elapsedSeconds: 0,
    lastInjectionAt: 0,
    lastBookmarkAt: 0,
    lastCompactionAt: 0,
    lastLineIsBookmark: false,
    recentAgentTimestamps: []
  }
}

describe('evaluateBookmark', () => {
  test('returns shouldInject false when bookmarks disabled', () => {
    const config: TavConfig = {
      ...DEFAULT_CONFIG,
      bookmarks: {
        ...DEFAULT_CONFIG.bookmarks,
        enabled: false
      }
    }
    const metrics = defaultMetrics()
    const data = {}
    const result = evaluateBookmark(data, config, metrics, 'tmux')

    expect(result.shouldInject).toBe(false)
    expect(result.reason).toBe('bookmarks disabled in config')
  })

  test('returns shouldInject false when injection method is disabled', () => {
    const config = ACTIVE_CONFIG
    const metrics = defaultMetrics()
    const data = {}
    const result = evaluateBookmark(data, config, metrics, 'disabled')

    expect(result.shouldInject).toBe(false)
    expect(result.reason).toBe('injection method is disabled')
  })

  test('returns shouldInject false on context limit stop', () => {
    const config = ACTIVE_CONFIG
    const metrics = defaultMetrics()
    const data = { stop_reason: 'context_limit' }
    const result = evaluateBookmark(data, config, metrics, 'tmux')

    expect(result.shouldInject).toBe(false)
    expect(result.reason).toBe('context limit stop detected')
  })

  test('returns shouldInject false on user abort', () => {
    const config = ACTIVE_CONFIG
    const metrics = defaultMetrics()
    const data = { stop_reason: 'abort' }
    const result = evaluateBookmark(data, config, metrics, 'tmux')

    expect(result.shouldInject).toBe(false)
    expect(result.reason).toBe('user abort detected')
  })

  test('returns shouldInject false when last line is bookmark', () => {
    const config = ACTIVE_CONFIG
    const metrics = {
      ...defaultMetrics(),
      lastLineIsBookmark: true
    }
    const data = {}
    const result = evaluateBookmark(data, config, metrics, 'tmux')

    expect(result.shouldInject).toBe(false)
    expect(result.reason).toBe('last line is already a bookmark')
  })

  test('returns shouldInject false during cooldown', () => {
    const config = ACTIVE_CONFIG
    const metrics = {
      ...defaultMetrics(),
      lastBookmarkAt: Date.now() - 5000, // 5 seconds ago, within 30s cooldown
      estimatedTokens: 20000 // High tokens but within cooldown
    }
    const data = {}
    const result = evaluateBookmark(data, config, metrics, 'tmux')

    expect(result.shouldInject).toBe(false)
    expect(result.reason).toBe('within cooldown period')
  })

  test('returns shouldInject true when token threshold met', () => {
    const config = ACTIVE_CONFIG
    const metrics = {
      ...defaultMetrics(),
      estimatedTokens: 15000 // >= 6000
    }
    const data = {}
    const result = evaluateBookmark(data, config, metrics, 'tmux')

    expect(result.shouldInject).toBe(true)
    expect(result.reason).toContain('token threshold met')
  })

  test('returns shouldInject true when tool call threshold met', () => {
    const config = ACTIVE_CONFIG
    const metrics = {
      ...defaultMetrics(),
      toolCalls: 20 // >= 15
    }
    const data = {}
    const result = evaluateBookmark(data, config, metrics, 'tmux')

    expect(result.shouldInject).toBe(true)
    expect(result.reason).toContain('tool call threshold met')
  })

  test('returns shouldInject true when time threshold met', () => {
    const config = ACTIVE_CONFIG
    const metrics = {
      ...defaultMetrics(),
      elapsedSeconds: 400 // >= 300
    }
    const data = {}
    const result = evaluateBookmark(data, config, metrics, 'tmux')

    expect(result.shouldInject).toBe(true)
    expect(result.reason).toContain('time threshold met')
  })

  test('returns shouldInject true when agent burst threshold met', () => {
    const config = ACTIVE_CONFIG
    const metrics = {
      ...defaultMetrics(),
      agentReturns: 6 // >= 3
    }
    const data = {}
    const result = evaluateBookmark(data, config, metrics, 'tmux')

    expect(result.shouldInject).toBe(true)
    expect(result.reason).toContain('agent burst threshold met')
  })

  test('returns shouldInject false when no threshold met', () => {
    const config = ACTIVE_CONFIG
    const metrics = {
      ...defaultMetrics(),
      toolCalls: 5,
      estimatedTokens: 2000,
      elapsedSeconds: 100,
      agentReturns: 2
    }
    const data = {}
    const result = evaluateBookmark(data, config, metrics, 'tmux')

    expect(result.shouldInject).toBe(false)
    expect(result.reason).toBe('no threshold met')
  })

  test('guard conditions take priority over thresholds', () => {
    const config: TavConfig = {
      ...DEFAULT_CONFIG,
      bookmarks: {
        ...DEFAULT_CONFIG.bookmarks,
        enabled: false
      }
    }
    const metrics = {
      ...defaultMetrics(),
      estimatedTokens: 20000, // High tokens
      toolCalls: 50,           // High tool calls
      elapsedSeconds: 500,     // High time
      agentReturns: 10         // High agent returns
    }
    const data = {}
    const result = evaluateBookmark(data, config, metrics, 'tmux')

    expect(result.shouldInject).toBe(false)
    expect(result.reason).toBe('bookmarks disabled in config')
  })
})
