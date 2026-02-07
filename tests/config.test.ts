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
