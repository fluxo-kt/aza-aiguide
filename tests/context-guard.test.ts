import { describe, test, expect } from 'bun:test'
import { evaluateContextPressure } from '../src/context-guard'
import { DEFAULT_CONFIG } from '../src/lib/config'
import type { TavConfig } from '../src/lib/config'

/** Config with both features enabled — for testing active behaviour */
const ACTIVE_CONFIG: TavConfig = {
  ...DEFAULT_CONFIG,
  bookmarks: { ...DEFAULT_CONFIG.bookmarks, enabled: true },
  contextGuard: { ...DEFAULT_CONFIG.contextGuard, enabled: true },
}

describe('context-guard', () => {
  test('allows non-Task tool calls regardless of pressure', () => {
    const result = evaluateContextPressure(ACTIVE_CONFIG, 0.99, 'Read')
    expect(result.continue).toBe(true)
    expect(result.permissionDecision).toBeUndefined()
  })

  test('allows Task when below denyPercent', () => {
    // 0.80 < 0.85 (default denyPercent)
    const result = evaluateContextPressure(ACTIVE_CONFIG, 0.80, 'Task')
    expect(result.continue).toBe(true)
    expect(result.permissionDecision).toBeUndefined()
  })

  test('denies Task when at denyPercent', () => {
    // 0.85 >= 0.85
    const result = evaluateContextPressure(ACTIVE_CONFIG, 0.85, 'Task')
    expect(result.continue).toBe(true)
    expect(result.permissionDecision).toBe('deny')
    expect(result.reason).toContain('Context pressure critical')
    expect(result.reason).toContain('85%')
  })

  test('denies Task when above denyPercent', () => {
    const result = evaluateContextPressure(ACTIVE_CONFIG, 0.95, 'Task')
    expect(result.continue).toBe(true)
    expect(result.permissionDecision).toBe('deny')
    expect(result.hookSpecificOutput).toBeDefined()
    expect(result.hookSpecificOutput!.hookEventName).toBe('PreToolUse')
    expect(result.hookSpecificOutput!.additionalContext).toContain('context guard')
  })

  test('allows Task when contextGuard is disabled', () => {
    const config: TavConfig = {
      ...ACTIVE_CONFIG,
      contextGuard: { ...ACTIVE_CONFIG.contextGuard, enabled: false }
    }
    const result = evaluateContextPressure(config, 0.99, 'Task')
    expect(result.continue).toBe(true)
    expect(result.permissionDecision).toBeUndefined()
  })

  test('uses custom denyPercent from config', () => {
    const config: TavConfig = {
      ...ACTIVE_CONFIG,
      contextGuard: { ...ACTIVE_CONFIG.contextGuard, denyPercent: 0.50 }
    }
    const result = evaluateContextPressure(config, 0.55, 'Task')
    expect(result.permissionDecision).toBe('deny')
  })

  test('always returns continue:true even when denying', () => {
    const result = evaluateContextPressure(ACTIVE_CONFIG, 0.99, 'Task')
    // continue:true is required for all hook outputs — deny is in permissionDecision
    expect(result.continue).toBe(true)
  })

  test('deny reason includes percentage values', () => {
    const result = evaluateContextPressure(ACTIVE_CONFIG, 0.90, 'Task')
    expect(result.reason).toContain('90%')
    expect(result.reason).toContain('85%')
  })

  test('allows Task at pressure just below threshold', () => {
    // 0.849 < 0.85
    const result = evaluateContextPressure(ACTIVE_CONFIG, 0.849, 'Task')
    expect(result.continue).toBe(true)
    expect(result.permissionDecision).toBeUndefined()
  })

  test('denies at pressure 1.0 (fully saturated)', () => {
    const result = evaluateContextPressure(ACTIVE_CONFIG, 1.0, 'Task')
    expect(result.permissionDecision).toBe('deny')
    expect(result.reason).toContain('100%')
  })
})
