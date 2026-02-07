import { readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

export interface ThresholdConfig {
  minTokens: number
  minToolCalls: number
  minSeconds: number
  agentBurstThreshold: number
  cooldownSeconds: number
}

export interface BookmarkConfig {
  enabled: boolean
  marker: string
  thresholds: ThresholdConfig
}

export interface TavConfig {
  bookmarks: BookmarkConfig
}

export const DEFAULT_CONFIG: TavConfig = {
  bookmarks: {
    enabled: true,
    marker: '\u00B7', // middle dot
    thresholds: {
      minTokens: 10000,
      minToolCalls: 15,
      minSeconds: 300,
      agentBurstThreshold: 5,
      cooldownSeconds: 30,
    },
  },
}

/**
 * Deep merge helper that recursively merges partial config into defaults
 */
function deepMerge<T>(target: T, source: Partial<T>): T {
  const result = { ...target } as T

  for (const key in source) {
    const sourceValue = source[key]
    const targetValue = result[key]

    if (
      sourceValue &&
      typeof sourceValue === 'object' &&
      !Array.isArray(sourceValue) &&
      targetValue &&
      typeof targetValue === 'object' &&
      !Array.isArray(targetValue)
    ) {
      result[key] = deepMerge(targetValue, sourceValue) as T[Extract<
        keyof T,
        string
      >]
    } else if (sourceValue !== undefined) {
      result[key] = sourceValue as T[Extract<keyof T, string>]
    }
  }

  return result
}

/**
 * Load TAV config from ~/.claude/tav/config.json
 * Falls back to defaults if file missing or invalid
 * @param configPath Optional override for testing
 */
export function loadConfig(configPath?: string): TavConfig {
  const path = configPath ?? join(homedir(), '.claude', 'tav', 'config.json')

  try {
    const content = readFileSync(path, 'utf-8')
    const parsed = JSON.parse(content) as Partial<TavConfig>
    return deepMerge(DEFAULT_CONFIG, parsed)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      // Log parse/read errors to stderr, but still return defaults
      console.error(`TAV config error (using defaults): ${err}`)
    }
    return DEFAULT_CONFIG
  }
}
