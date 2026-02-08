import { describe, test, expect } from 'bun:test'
import { shouldInjectBookmark, shouldCompact } from '../src/lib/evaluate'
import { DEFAULT_CONFIG } from '../src/lib/config'
import type { TavConfig, ContextGuardConfig } from '../src/lib/config'
import type { LogMetrics } from '../src/lib/log'

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

describe('shouldInjectBookmark', () => {
  test('returns false when bookmarks disabled', () => {
    const config: TavConfig = {
      ...DEFAULT_CONFIG,
      bookmarks: { ...DEFAULT_CONFIG.bookmarks, enabled: false }
    }
    const metrics = { ...defaultMetrics(), toolCalls: 100, estimatedTokens: 50000, elapsedSeconds: 999 }
    const result = shouldInjectBookmark({ config, metrics, injectionMethod: 'tmux' })
    expect(result.shouldInject).toBe(false)
    expect(result.reason).toContain('disabled')
  })

  test('returns false when injection method is disabled', () => {
    const metrics = { ...defaultMetrics(), toolCalls: 100, estimatedTokens: 50000, elapsedSeconds: 999 }
    const result = shouldInjectBookmark({ config: DEFAULT_CONFIG, metrics, injectionMethod: 'disabled' })
    expect(result.shouldInject).toBe(false)
    expect(result.reason).toContain('disabled')
  })

  test('returns false when last line is bookmark', () => {
    const metrics = { ...defaultMetrics(), toolCalls: 100, estimatedTokens: 50000, elapsedSeconds: 999, lastLineIsBookmark: true }
    const result = shouldInjectBookmark({ config: DEFAULT_CONFIG, metrics, injectionMethod: 'tmux' })
    expect(result.shouldInject).toBe(false)
    expect(result.reason).toContain('bookmark')
  })

  test('returns false within cooldown period', () => {
    const metrics = {
      ...defaultMetrics(),
      toolCalls: 100,
      estimatedTokens: 50000,
      elapsedSeconds: 999,
      lastInjectionAt: Date.now() - 5000 // 5s ago, cooldown is 25s
    }
    const result = shouldInjectBookmark({ config: DEFAULT_CONFIG, metrics, injectionMethod: 'tmux' })
    expect(result.shouldInject).toBe(false)
    expect(result.reason).toContain('cooldown')
  })

  test('returns true when thresholds met and no guards block', () => {
    const metrics = {
      ...defaultMetrics(),
      toolCalls: 20, // above minToolCalls (15)
      estimatedTokens: 10000, // above minTokens (6000)
      elapsedSeconds: 200 // above minSeconds (120)
    }
    const result = shouldInjectBookmark({ config: DEFAULT_CONFIG, metrics, injectionMethod: 'tmux' })
    expect(result.shouldInject).toBe(true)
  })

  test('returns false when no thresholds met', () => {
    const metrics = {
      ...defaultMetrics(),
      toolCalls: 1,
      estimatedTokens: 100,
      elapsedSeconds: 5
    }
    const result = shouldInjectBookmark({ config: DEFAULT_CONFIG, metrics, injectionMethod: 'tmux' })
    expect(result.shouldInject).toBe(false)
  })

  test('guard ordering: disabled config checked before injection method', () => {
    // Even with valid injection method, disabled config should block first
    const config: TavConfig = {
      ...DEFAULT_CONFIG,
      bookmarks: { ...DEFAULT_CONFIG.bookmarks, enabled: false }
    }
    const metrics = { ...defaultMetrics(), toolCalls: 100 }
    const result = shouldInjectBookmark({ config, metrics, injectionMethod: 'tmux' })
    expect(result.reason).toContain('bookmarks disabled')
  })

  test('respects lastBookmarkAt for cooldown (not just lastInjectionAt)', () => {
    const metrics = {
      ...defaultMetrics(),
      toolCalls: 100,
      estimatedTokens: 50000,
      elapsedSeconds: 999,
      lastInjectionAt: 0,
      lastBookmarkAt: Date.now() - 3000 // 3s ago, cooldown is 25s
    }
    const result = shouldInjectBookmark({ config: DEFAULT_CONFIG, metrics, injectionMethod: 'tmux' })
    expect(result.shouldInject).toBe(false)
    expect(result.reason).toContain('cooldown')
  })
})

describe('shouldCompact', () => {
  const defaultCG: ContextGuardConfig = DEFAULT_CONFIG.contextGuard

  test('returns false when context guard disabled', () => {
    const config: ContextGuardConfig = { ...defaultCG, enabled: false }
    const result = shouldCompact({
      pressure: 0.90,
      config,
      metrics: defaultMetrics(),
      injectionMethod: 'tmux'
    })
    expect(result.shouldCompact).toBe(false)
    expect(result.reason).toContain('disabled')
  })

  test('returns false when injection method is disabled', () => {
    const result = shouldCompact({
      pressure: 0.90,
      config: defaultCG,
      metrics: defaultMetrics(),
      injectionMethod: 'disabled'
    })
    expect(result.shouldCompact).toBe(false)
    expect(result.reason).toContain('disabled')
  })

  test('returns false when pressure below compactPercent', () => {
    const result = shouldCompact({
      pressure: 0.50,
      config: defaultCG,
      metrics: defaultMetrics(),
      injectionMethod: 'tmux'
    })
    expect(result.shouldCompact).toBe(false)
    expect(result.reason).toContain('below')
  })

  test('returns true when pressure at compactPercent', () => {
    const result = shouldCompact({
      pressure: 0.76,
      config: defaultCG,
      metrics: defaultMetrics(),
      injectionMethod: 'tmux'
    })
    expect(result.shouldCompact).toBe(true)
    expect(result.reason).toContain('76%')
  })

  test('returns true when pressure above compactPercent', () => {
    const result = shouldCompact({
      pressure: 0.90,
      config: defaultCG,
      metrics: defaultMetrics(),
      injectionMethod: 'tmux'
    })
    expect(result.shouldCompact).toBe(true)
  })

  test('returns false within compaction cooldown', () => {
    const metrics = {
      ...defaultMetrics(),
      lastCompactionAt: Date.now() - 30000 // 30s ago, cooldown is 120s
    }
    const result = shouldCompact({
      pressure: 0.90,
      config: defaultCG,
      metrics,
      injectionMethod: 'tmux'
    })
    expect(result.shouldCompact).toBe(false)
    expect(result.reason).toContain('cooldown')
  })

  test('returns true after cooldown expires', () => {
    const metrics = {
      ...defaultMetrics(),
      lastCompactionAt: Date.now() - 130000 // 130s ago, cooldown is 120s
    }
    const result = shouldCompact({
      pressure: 0.80,
      config: defaultCG,
      metrics,
      injectionMethod: 'tmux'
    })
    expect(result.shouldCompact).toBe(true)
  })

  test('guard ordering: disabled checked before pressure', () => {
    const config: ContextGuardConfig = { ...defaultCG, enabled: false }
    const result = shouldCompact({
      pressure: 0.99,
      config,
      metrics: defaultMetrics(),
      injectionMethod: 'tmux'
    })
    expect(result.shouldCompact).toBe(false)
    expect(result.reason).toContain('guard disabled')
  })

  test('guard ordering: injection method checked before pressure', () => {
    const result = shouldCompact({
      pressure: 0.99,
      config: defaultCG,
      metrics: defaultMetrics(),
      injectionMethod: 'disabled'
    })
    expect(result.shouldCompact).toBe(false)
    expect(result.reason).toContain('injection method')
  })

  test('works with custom compactPercent', () => {
    const config: ContextGuardConfig = { ...defaultCG, compactPercent: 0.50 }
    const result = shouldCompact({
      pressure: 0.55,
      config,
      metrics: defaultMetrics(),
      injectionMethod: 'tmux'
    })
    expect(result.shouldCompact).toBe(true)
  })
})
