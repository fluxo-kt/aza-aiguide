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
      minTokens: 6000,
      minToolCalls: 15,
      minSeconds: 120,
      agentBurstThreshold: 3,
      cooldownSeconds: 25,
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
 * Coerces a value to a non-negative number, returning fallback if invalid.
 * Only accepts actual numbers and numeric strings — rejects null, arrays,
 * objects etc. that Number() would silently coerce to 0.
 */
function validNumber(value: unknown, fallback: number): number {
  if (typeof value === 'number') return isNaN(value) || value < 0 ? fallback : value
  if (typeof value === 'string') {
    const n = Number(value)
    return isNaN(n) || n < 0 ? fallback : n
  }
  return fallback
}

/**
 * Validates merged config, coercing threshold fields to numbers and
 * falling back to defaults for invalid values. This prevents silent
 * corruption where e.g. "minTokens": "banana" makes the threshold
 * unreachable (string comparison always false).
 */
function validateConfig(config: TavConfig): TavConfig {
  const d = DEFAULT_CONFIG.bookmarks
  const t = config.bookmarks.thresholds
  const dt = d.thresholds

  return {
    bookmarks: {
      enabled: typeof config.bookmarks.enabled === 'boolean'
        ? config.bookmarks.enabled
        : d.enabled,
      marker: typeof config.bookmarks.marker === 'string' && config.bookmarks.marker.length > 0
        ? config.bookmarks.marker
        : d.marker,
      thresholds: {
        minTokens: validNumber(t.minTokens, dt.minTokens),
        minToolCalls: validNumber(t.minToolCalls, dt.minToolCalls),
        minSeconds: validNumber(t.minSeconds, dt.minSeconds),
        agentBurstThreshold: validNumber(t.agentBurstThreshold, dt.agentBurstThreshold),
        cooldownSeconds: validNumber(t.cooldownSeconds, dt.cooldownSeconds),
      },
    },
  }
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
    return validateConfig(deepMerge(DEFAULT_CONFIG, parsed))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      // Log parse/read errors to stderr, but still return defaults
      console.error(`TAV config error (using defaults): ${err}`)
    }
    return DEFAULT_CONFIG
  }
}
