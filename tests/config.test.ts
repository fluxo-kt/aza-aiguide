import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { TavConfig } from '../src/lib/config'
import { loadConfig, DEFAULT_CONFIG } from '../src/lib/config'

describe('config loader', () => {
  let tempDir: string
  let configPath: string

  beforeEach(() => {
    // Create unique temp directory for each test
    tempDir = join(tmpdir(), `tav-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(tempDir, { recursive: true })
    configPath = join(tempDir, 'config.json')
  })

  afterEach(() => {
    // Clean up temp directory
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test('loadConfig returns DEFAULT_CONFIG when no config file exists', () => {
    const config = loadConfig(configPath)
    expect(config).toEqual(DEFAULT_CONFIG)
  })

  test('loadConfig deep merges partial config', () => {
    const partialConfig: Partial<TavConfig> = {
      bookmarks: {
        enabled: false,
        marker: '★',
        thresholds: {
          minTokens: 20000,
          // Intentionally omit other threshold fields to test deep merge
        } as any,
      },
    }

    writeFileSync(configPath, JSON.stringify(partialConfig), 'utf-8')
    const config = loadConfig(configPath)

    // User overrides should be applied
    expect(config.bookmarks.enabled).toBe(false)
    expect(config.bookmarks.marker).toBe('★')
    expect(config.bookmarks.thresholds.minTokens).toBe(20000)

    // Missing fields should fall back to defaults
    expect(config.bookmarks.thresholds.minToolCalls).toBe(DEFAULT_CONFIG.bookmarks.thresholds.minToolCalls)
    expect(config.bookmarks.thresholds.minSeconds).toBe(DEFAULT_CONFIG.bookmarks.thresholds.minSeconds)
    expect(config.bookmarks.thresholds.agentBurstThreshold).toBe(DEFAULT_CONFIG.bookmarks.thresholds.agentBurstThreshold)
    expect(config.bookmarks.thresholds.cooldownSeconds).toBe(DEFAULT_CONFIG.bookmarks.thresholds.cooldownSeconds)
  })

  test('loadConfig returns defaults for invalid JSON', () => {
    writeFileSync(configPath, '{ invalid json content }', 'utf-8')
    const config = loadConfig(configPath)
    expect(config).toEqual(DEFAULT_CONFIG)
  })

  test('loadConfig returns defaults for empty file', () => {
    writeFileSync(configPath, '', 'utf-8')
    const config = loadConfig(configPath)
    expect(config).toEqual(DEFAULT_CONFIG)
  })

  test('loadConfig coerces string threshold values to numbers', () => {
    writeFileSync(configPath, JSON.stringify({
      bookmarks: { thresholds: { minTokens: '5000', cooldownSeconds: '30' } }
    }), 'utf-8')
    const config = loadConfig(configPath)

    expect(config.bookmarks.thresholds.minTokens).toBe(5000)
    expect(typeof config.bookmarks.thresholds.minTokens).toBe('number')
    expect(config.bookmarks.thresholds.cooldownSeconds).toBe(30)
    expect(typeof config.bookmarks.thresholds.cooldownSeconds).toBe('number')
  })

  test('loadConfig falls back to defaults for non-numeric threshold values', () => {
    writeFileSync(configPath, JSON.stringify({
      bookmarks: { thresholds: {
        minTokens: 'banana',
        minToolCalls: null,
        minSeconds: {},
        agentBurstThreshold: [],
        cooldownSeconds: 'NaN'
      } }
    }), 'utf-8')
    const config = loadConfig(configPath)

    // All invalid values should fall back to defaults
    expect(config.bookmarks.thresholds.minTokens).toBe(DEFAULT_CONFIG.bookmarks.thresholds.minTokens)
    expect(config.bookmarks.thresholds.minToolCalls).toBe(DEFAULT_CONFIG.bookmarks.thresholds.minToolCalls)
    expect(config.bookmarks.thresholds.minSeconds).toBe(DEFAULT_CONFIG.bookmarks.thresholds.minSeconds)
    expect(config.bookmarks.thresholds.agentBurstThreshold).toBe(DEFAULT_CONFIG.bookmarks.thresholds.agentBurstThreshold)
    expect(config.bookmarks.thresholds.cooldownSeconds).toBe(DEFAULT_CONFIG.bookmarks.thresholds.cooldownSeconds)
  })

  test('loadConfig rejects negative threshold values', () => {
    writeFileSync(configPath, JSON.stringify({
      bookmarks: { thresholds: { minTokens: -100, cooldownSeconds: -5 } }
    }), 'utf-8')
    const config = loadConfig(configPath)

    expect(config.bookmarks.thresholds.minTokens).toBe(DEFAULT_CONFIG.bookmarks.thresholds.minTokens)
    expect(config.bookmarks.thresholds.cooldownSeconds).toBe(DEFAULT_CONFIG.bookmarks.thresholds.cooldownSeconds)
  })

  test('loadConfig rejects string "Infinity" threshold values', () => {
    // JSON has no infinity literal, so the realistic attack vector is string values
    // that Number() would coerce: Number("Infinity") === Infinity
    writeFileSync(configPath, JSON.stringify({
      bookmarks: { thresholds: { minTokens: 'Infinity', cooldownSeconds: '-Infinity' } }
    }), 'utf-8')
    const config = loadConfig(configPath)

    expect(config.bookmarks.thresholds.minTokens).toBe(DEFAULT_CONFIG.bookmarks.thresholds.minTokens)
    expect(config.bookmarks.thresholds.cooldownSeconds).toBe(DEFAULT_CONFIG.bookmarks.thresholds.cooldownSeconds)
  })

  test('loadConfig validates enabled as boolean', () => {
    writeFileSync(configPath, JSON.stringify({
      bookmarks: { enabled: 'yes' }
    }), 'utf-8')
    const config = loadConfig(configPath)

    // Non-boolean 'enabled' should fall back to default (false)
    expect(config.bookmarks.enabled).toBe(false)
    expect(typeof config.bookmarks.enabled).toBe('boolean')
  })

  test('loadConfig validates marker as non-empty string', () => {
    writeFileSync(configPath, JSON.stringify({
      bookmarks: { marker: '' }
    }), 'utf-8')
    const config = loadConfig(configPath)

    // Empty marker should fall back to default
    expect(config.bookmarks.marker).toBe('\u00B7')
  })

  test('loadConfig accepts zero as valid threshold', () => {
    writeFileSync(configPath, JSON.stringify({
      bookmarks: { thresholds: { minTokens: 0, cooldownSeconds: 0 } }
    }), 'utf-8')
    const config = loadConfig(configPath)

    // Zero is a valid non-negative number
    expect(config.bookmarks.thresholds.minTokens).toBe(0)
    expect(config.bookmarks.thresholds.cooldownSeconds).toBe(0)
  })

  test('DEFAULT_CONFIG has correct default values', () => {
    expect(DEFAULT_CONFIG.bookmarks.enabled).toBe(false)
    expect(DEFAULT_CONFIG.bookmarks.marker).toBe('\u00B7')
    expect(DEFAULT_CONFIG.bookmarks.thresholds.minTokens).toBe(6000)
    expect(DEFAULT_CONFIG.bookmarks.thresholds.minToolCalls).toBe(15)
    expect(DEFAULT_CONFIG.bookmarks.thresholds.minSeconds).toBe(120)
    expect(DEFAULT_CONFIG.bookmarks.thresholds.agentBurstThreshold).toBe(3)
    expect(DEFAULT_CONFIG.bookmarks.thresholds.cooldownSeconds).toBe(25)
    expect(DEFAULT_CONFIG.contextGuard.enabled).toBe(false)
    expect(DEFAULT_CONFIG.contextGuard.contextWindowTokens).toBe(200000)
    expect(DEFAULT_CONFIG.contextGuard.compactPercent).toBe(0.76)
    expect(DEFAULT_CONFIG.contextGuard.denyPercent).toBe(0.85)
    expect(DEFAULT_CONFIG.contextGuard.compactCooldownSeconds).toBe(120)
    expect(DEFAULT_CONFIG.contextGuard.responseRatio).toBe(0.25)
  })

  test('loadConfig deep merges partial contextGuard config', () => {
    writeFileSync(configPath, JSON.stringify({
      contextGuard: { compactPercent: 0.60 }
    }), 'utf-8')
    const config = loadConfig(configPath)

    // User override applied
    expect(config.contextGuard.compactPercent).toBe(0.60)
    // Missing fields fall back to defaults
    expect(config.contextGuard.enabled).toBe(false)
    expect(config.contextGuard.contextWindowTokens).toBe(200000)
    expect(config.contextGuard.denyPercent).toBe(0.85)
    expect(config.contextGuard.compactCooldownSeconds).toBe(120)
    expect(config.contextGuard.responseRatio).toBe(0.25)
  })

  test('loadConfig validates contextGuard numeric fields', () => {
    writeFileSync(configPath, JSON.stringify({
      contextGuard: {
        contextWindowTokens: 'banana',
        compactPercent: -0.5,
        denyPercent: null,
        compactCooldownSeconds: -10,
        responseRatio: 'NaN',
      }
    }), 'utf-8')
    const config = loadConfig(configPath)

    // All invalid values fall back to defaults
    expect(config.contextGuard.contextWindowTokens).toBe(DEFAULT_CONFIG.contextGuard.contextWindowTokens)
    expect(config.contextGuard.compactPercent).toBe(DEFAULT_CONFIG.contextGuard.compactPercent)
    expect(config.contextGuard.denyPercent).toBe(DEFAULT_CONFIG.contextGuard.denyPercent)
    expect(config.contextGuard.compactCooldownSeconds).toBe(DEFAULT_CONFIG.contextGuard.compactCooldownSeconds)
    expect(config.contextGuard.responseRatio).toBe(DEFAULT_CONFIG.contextGuard.responseRatio)
  })

  test('loadConfig validates contextGuard enabled as boolean', () => {
    writeFileSync(configPath, JSON.stringify({
      contextGuard: { enabled: 'no' }
    }), 'utf-8')
    const config = loadConfig(configPath)

    expect(config.contextGuard.enabled).toBe(false)
    expect(typeof config.contextGuard.enabled).toBe('boolean')
  })

  test('loadConfig returns contextGuard defaults when section missing', () => {
    writeFileSync(configPath, JSON.stringify({
      bookmarks: { enabled: false }
    }), 'utf-8')
    const config = loadConfig(configPath)

    // contextGuard section missing entirely — all defaults
    expect(config.contextGuard).toEqual(DEFAULT_CONFIG.contextGuard)
  })

  test('loadConfig converts legacy compactThreshold to compactPercent', () => {
    // Legacy: compactThreshold: 30000 tokens at responseRatio 0.25, contextWindowTokens 200000
    // → denominator = 200000 * 0.25 = 50000
    // → compactPercent = 30000 / 50000 = 0.60
    writeFileSync(configPath, JSON.stringify({
      contextGuard: { compactThreshold: 30000 }
    }), 'utf-8')
    const config = loadConfig(configPath)

    expect(config.contextGuard.compactPercent).toBe(0.60)
    // denyPercent untouched — uses default
    expect(config.contextGuard.denyPercent).toBe(0.85)
  })

  test('loadConfig converts legacy denyThreshold to denyPercent', () => {
    // Legacy: denyThreshold: 45000 → 45000 / 50000 = 0.90
    writeFileSync(configPath, JSON.stringify({
      contextGuard: { denyThreshold: 45000 }
    }), 'utf-8')
    const config = loadConfig(configPath)

    expect(config.contextGuard.denyPercent).toBe(0.90)
    // compactPercent untouched — uses default
    expect(config.contextGuard.compactPercent).toBe(0.76)
  })

  test('loadConfig converts both legacy thresholds simultaneously', () => {
    writeFileSync(configPath, JSON.stringify({
      contextGuard: { compactThreshold: 25000, denyThreshold: 40000 }
    }), 'utf-8')
    const config = loadConfig(configPath)

    // denominator = 200000 * 0.25 = 50000
    expect(config.contextGuard.compactPercent).toBe(0.50)  // 25000 / 50000
    expect(config.contextGuard.denyPercent).toBe(0.80)     // 40000 / 50000
  })

  test('loadConfig prefers new percentage fields over legacy thresholds', () => {
    // When both old and new fields are present, new ones win
    writeFileSync(configPath, JSON.stringify({
      contextGuard: { compactThreshold: 30000, compactPercent: 0.70 }
    }), 'utf-8')
    const config = loadConfig(configPath)

    // New field wins — legacy ignored when new field is present
    expect(config.contextGuard.compactPercent).toBe(0.70)
  })

  test('loadConfig rejects compactPercent > 1.0', () => {
    writeFileSync(configPath, JSON.stringify({
      contextGuard: { compactPercent: 1.5 }
    }), 'utf-8')
    const config = loadConfig(configPath)

    // Values > 1.0 fall back to default
    expect(config.contextGuard.compactPercent).toBe(DEFAULT_CONFIG.contextGuard.compactPercent)
  })

  test('loadConfig accepts compactPercent at boundary values', () => {
    // 0.0 is valid (effectively disables compaction)
    writeFileSync(configPath, JSON.stringify({
      contextGuard: { compactPercent: 0, denyPercent: 1.0 }
    }), 'utf-8')
    const config = loadConfig(configPath)

    expect(config.contextGuard.compactPercent).toBe(0)
    expect(config.contextGuard.denyPercent).toBe(1.0)
  })

  test('loadConfig legacy conversion clamps to 1.0', () => {
    // Legacy threshold that would exceed 100%: 60000 / 50000 = 1.2 → clamped to 1.0
    writeFileSync(configPath, JSON.stringify({
      contextGuard: { compactThreshold: 60000 }
    }), 'utf-8')
    const config = loadConfig(configPath)

    expect(config.contextGuard.compactPercent).toBe(1.0)
  })
})
