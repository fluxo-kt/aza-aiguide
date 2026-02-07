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

  test('loadConfig validates enabled as boolean', () => {
    writeFileSync(configPath, JSON.stringify({
      bookmarks: { enabled: 'yes' }
    }), 'utf-8')
    const config = loadConfig(configPath)

    // Non-boolean 'enabled' should fall back to default (true)
    expect(config.bookmarks.enabled).toBe(true)
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
    expect(DEFAULT_CONFIG.bookmarks.enabled).toBe(true)
    expect(DEFAULT_CONFIG.bookmarks.marker).toBe('\u00B7')
    expect(DEFAULT_CONFIG.bookmarks.thresholds.minTokens).toBe(6000)
    expect(DEFAULT_CONFIG.bookmarks.thresholds.minToolCalls).toBe(15)
    expect(DEFAULT_CONFIG.bookmarks.thresholds.minSeconds).toBe(120)
    expect(DEFAULT_CONFIG.bookmarks.thresholds.agentBurstThreshold).toBe(3)
    expect(DEFAULT_CONFIG.bookmarks.thresholds.cooldownSeconds).toBe(25)
  })
})
