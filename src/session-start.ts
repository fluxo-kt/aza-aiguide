#!/usr/bin/env node

import { writeFileSync } from 'fs'
import { loadConfig } from './lib/config'
import type { TavConfig } from './lib/config'
import { ensureStateDir, getLogPath, cleanOldSessions } from './lib/log'
import { detectInjectionMethod, checkAccessibilityPermission, detectSessionLocation } from './lib/inject'
import type { InjectionConfig, SessionLocation } from './lib/inject'
import { readStdin } from './lib/stdin'
import { writeSessionConfig } from './lib/session'
import type { SessionConfig } from './lib/session'
import { resolveJsonlPath } from './lib/context-pressure'

interface StdinData {
  session_id?: string
  sessionId?: string
  cwd?: string
}

async function main(): Promise<void> {
  try {
    // Read stdin (3s timeout — SessionStart hook has 5s budget)
    const stdinRaw = await readStdin(3000)
    const data: StdinData = stdinRaw.trim() ? JSON.parse(stdinRaw) : {}

    // Extract session_id (support both formats)
    const sessionId = data.session_id || data.sessionId || 'unknown'

    // Load config
    const config: TavConfig = loadConfig()

    // Write minimal config IMMEDIATELY (failure recovery point)
    // If SessionStart crashes after this, downstream hooks have valid config to read
    // Cache config here to prevent hot-reload race in downstream hooks
    ensureStateDir()
    const minimalConfig: SessionConfig = {
      sessionId,
      startedAt: Date.now(),
      injectionMethod: 'detecting',
      injectionTarget: '',
      cachedConfig: config  // Cache full config to prevent hot-reload
    }
    writeSessionConfig(sessionId, minimalConfig)

    // Only exit early when BOTH bookmarks AND contextGuard are disabled.
    // contextGuard needs jsonlPath even when bookmarks are off.
    if (config.bookmarks.enabled === false && config.contextGuard.enabled === false) {
      console.log(JSON.stringify({
        continue: true,
        note: 'Both bookmarks and context guard disabled in config'
      }))
      return
    }

    // Detect injection method
    let injection: InjectionConfig = detectInjectionMethod()
    let disabledReason: string | undefined

    // If osascript detected, verify Accessibility permissions are granted.
    // Without Accessibility, osascript silently fails — downgrade to disabled
    // with a clear warning so the user knows what to do.
    if (injection.method === 'osascript') {
      const hasAccess = checkAccessibilityPermission()
      if (!hasAccess) {
        disabledReason = 'macOS Accessibility permissions not granted'
        injection = { method: 'disabled', target: '' }
        console.error(
          'tav: macOS Accessibility permissions required for automatic bookmarks.\n' +
          'Grant permission: System Settings > Privacy & Security > Accessibility > Enable your terminal app.\n' +
          'Until then, you can still type \u00B7 manually to create bookmark anchor points.'
        )
      }
    }

    // Update config with injection method (incremental write #2)
    let sessionConfig: SessionConfig = {
      ...minimalConfig,
      injectionMethod: injection.method,
      injectionTarget: injection.target,
      ...(disabledReason ? { disabledReason } : {})
    }
    writeSessionConfig(sessionId, sessionConfig)

    // Resolve JSONL path for context pressure reading (cached for all hooks)
    const jsonlPath = resolveJsonlPath(sessionId)
    if (jsonlPath) {
      sessionConfig = { ...sessionConfig, jsonlPath }
      writeSessionConfig(sessionId, sessionConfig)
    }

    // Detect session location (only if enabled in config)
    if (config.sessionLocation.enabled) {
      const detected = detectSessionLocation()
      if (detected) {
        sessionConfig = { ...sessionConfig, location: detected }
        writeSessionConfig(sessionId, sessionConfig)
      } else {
        console.error('tav: Failed to detect session location (hostname/directory unavailable)')
      }
    }

    // Create empty activity log (exclusive create — if a concurrent hook
    // already created it via appendEvent, don't truncate their data)
    const logPath = getLogPath(sessionId)
    try { writeFileSync(logPath, '', { flag: 'wx' }) } catch { /* already exists */ }

    // Output success BEFORE cleanup — cleanup can be slow with many files
    // and must not block the {continue:true} output within the hook timeout
    console.log(JSON.stringify({ continue: true }))

    // Clean old sessions (7 days) — best-effort, after output
    cleanOldSessions(7)
  } catch (error) {
    // Never block session start
    console.error('SessionStart error:', error instanceof Error ? error.message : String(error))
    console.log(JSON.stringify({ continue: true }))
  }
}

if (require.main === module) {
  main().then(
    () => process.exit(0),
    (error) => {
      console.error('Fatal error:', error)
      console.log(JSON.stringify({ continue: true }))
      process.exit(0)
    }
  )
}
