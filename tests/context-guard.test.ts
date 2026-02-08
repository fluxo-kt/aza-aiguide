import { describe, test, expect } from 'bun:test'
import { evaluateContextPressure } from '../src/context-guard'
import { DEFAULT_CONFIG } from '../src/lib/config'
import type { TavConfig } from '../src/lib/config'
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
    lastLineIsBookmark: false
  }
}

describe('context-guard', () => {
  test('allows non-Task tool calls regardless of pressure', () => {
    const metrics = { ...defaultMetrics(), cumulativeEstimatedTokens: 100000 }
    const result = evaluateContextPressure(DEFAULT_CONFIG, metrics, 'Read')
    expect(result.continue).toBe(true)
    expect(result.permissionDecision).toBeUndefined()
  })

  test('allows Task when below denyThreshold', () => {
    const metrics = { ...defaultMetrics(), cumulativeEstimatedTokens: 44999 }
    const result = evaluateContextPressure(DEFAULT_CONFIG, metrics, 'Task')
    expect(result.continue).toBe(true)
    expect(result.permissionDecision).toBeUndefined()
  })

  test('denies Task when at denyThreshold', () => {
    const metrics = { ...defaultMetrics(), cumulativeEstimatedTokens: 45000 }
    const result = evaluateContextPressure(DEFAULT_CONFIG, metrics, 'Task')
    expect(result.continue).toBe(true)
    expect(result.permissionDecision).toBe('deny')
    expect(result.reason).toContain('Context pressure critical')
    expect(result.reason).toContain('45000')
  })

  test('denies Task when above denyThreshold', () => {
    const metrics = { ...defaultMetrics(), cumulativeEstimatedTokens: 60000 }
    const result = evaluateContextPressure(DEFAULT_CONFIG, metrics, 'Task')
    expect(result.continue).toBe(true)
    expect(result.permissionDecision).toBe('deny')
    expect(result.hookSpecificOutput).toBeDefined()
    expect(result.hookSpecificOutput!.hookEventName).toBe('PreToolUse')
    expect(result.hookSpecificOutput!.additionalContext).toContain('context guard')
  })

  test('allows Task when contextGuard is disabled', () => {
    const config: TavConfig = {
      ...DEFAULT_CONFIG,
      contextGuard: { ...DEFAULT_CONFIG.contextGuard, enabled: false }
    }
    const metrics = { ...defaultMetrics(), cumulativeEstimatedTokens: 100000 }
    const result = evaluateContextPressure(config, metrics, 'Task')
    expect(result.continue).toBe(true)
    expect(result.permissionDecision).toBeUndefined()
  })

  test('uses custom denyThreshold from config', () => {
    const config: TavConfig = {
      ...DEFAULT_CONFIG,
      contextGuard: { ...DEFAULT_CONFIG.contextGuard, denyThreshold: 10000 }
    }
    const metrics = { ...defaultMetrics(), cumulativeEstimatedTokens: 10000 }
    const result = evaluateContextPressure(config, metrics, 'Task')
    expect(result.permissionDecision).toBe('deny')
  })

  test('always returns continue:true even when denying', () => {
    const metrics = { ...defaultMetrics(), cumulativeEstimatedTokens: 100000 }
    const result = evaluateContextPressure(DEFAULT_CONFIG, metrics, 'Task')
    // continue:true is required for all hook outputs — deny is in permissionDecision
    expect(result.continue).toBe(true)
  })

  test('deny reason includes both actual and threshold values', () => {
    const metrics = { ...defaultMetrics(), cumulativeEstimatedTokens: 50000 }
    const result = evaluateContextPressure(DEFAULT_CONFIG, metrics, 'Task')
    expect(result.reason).toContain('50000')
    expect(result.reason).toContain('45000')
  })
})
