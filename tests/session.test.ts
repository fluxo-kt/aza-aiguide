import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, rmSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { readSessionConfig, writeSessionConfig } from '../src/lib/session'
import type { SessionConfig } from '../src/lib/session'

describe('session', () => {
  let testDir: string
  let stateDir: string

  beforeEach(() => {
    testDir = join(tmpdir(), `session-test-${Date.now()}`)
    stateDir = join(testDir, 'state')
    mkdirSync(stateDir, { recursive: true })
  })

  afterEach(() => {
    try {
      rmSync(testDir, { recursive: true, force: true })
    } catch {
      // Ignore cleanup errors
    }
  })

  test('writeSessionConfig creates valid JSON file', () => {
    const config: SessionConfig = {
      sessionId: 'test-123',
      injectionMethod: 'tmux',
      injectionTarget: '%1',
      startedAt: Date.now()
    }

    writeSessionConfig('test-123', config, stateDir)

    const written = readFileSync(join(stateDir, 'test-123.json'), 'utf-8')
    const parsed = JSON.parse(written)
    expect(parsed.sessionId).toBe('test-123')
    expect(parsed.injectionMethod).toBe('tmux')
    expect(parsed.injectionTarget).toBe('%1')
  })

  test('readSessionConfig returns written config', () => {
    const config: SessionConfig = {
      sessionId: 'round-trip',
      injectionMethod: 'screen',
      injectionTarget: 'mysession',
      startedAt: 1234567890
    }

    writeSessionConfig('round-trip', config, stateDir)
    const result = readSessionConfig('round-trip', stateDir)

    expect(result).not.toBeNull()
    expect(result!.sessionId).toBe('round-trip')
    expect(result!.injectionMethod).toBe('screen')
    expect(result!.startedAt).toBe(1234567890)
  })

  test('readSessionConfig returns null for missing session', () => {
    const result = readSessionConfig('nonexistent', stateDir)
    expect(result).toBeNull()
  })

  test('writeSessionConfig includes disabledReason when present', () => {
    const config: SessionConfig = {
      sessionId: 'disabled-test',
      injectionMethod: 'disabled',
      injectionTarget: '',
      startedAt: Date.now(),
      disabledReason: 'No Accessibility permissions'
    }

    writeSessionConfig('disabled-test', config, stateDir)
    const result = readSessionConfig('disabled-test', stateDir)

    expect(result).not.toBeNull()
    expect(result!.disabledReason).toBe('No Accessibility permissions')
  })

  test('readSessionConfig handles corrupted JSON gracefully', () => {
    const path = join(stateDir, 'corrupted.json')
    const { writeFileSync } = require('fs')
    writeFileSync(path, '{invalid json', 'utf-8')

    const result = readSessionConfig('corrupted', stateDir)
    expect(result).toBeNull()
  })

  test('writeSessionConfig sanitises session IDs with special characters', () => {
    const config: SessionConfig = {
      sessionId: 'test/with:special chars',
      injectionMethod: 'tmux',
      injectionTarget: '%2',
      startedAt: Date.now()
    }

    writeSessionConfig('test/with:special chars', config, stateDir)

    // Should create a sanitised filename (not containing / or :)
    const result = readSessionConfig('test/with:special chars', stateDir)
    expect(result).not.toBeNull()
    expect(result!.injectionMethod).toBe('tmux')
  })
})
