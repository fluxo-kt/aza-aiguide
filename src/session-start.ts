#!/usr/bin/env node

import { writeFileSync } from 'fs'
import { loadConfig } from './lib/config'
import type { TavConfig } from './lib/config'
import { ensureStateDir, getLogPath, cleanOldSessions } from './lib/log'
import { detectInjectionMethod, checkAccessibilityPermission } from './lib/inject'
import type { InjectionConfig } from './lib/inject'
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

    // Ensure state directory exists
    ensureStateDir()

    // Resolve JSONL path for context pressure reading (cached for all hooks)
    const jsonlPath = resolveJsonlPath(sessionId)

    // Write session config via shared module
    const sessionConfig: SessionConfig = {
      sessionId,
      injectionMethod: injection.method,
      injectionTarget: injection.target,
      startedAt: Date.now(),
      ...(jsonlPath ? { jsonlPath } : {}),
      ...(disabledReason ? { disabledReason } : {})
    }

    writeSessionConfig(sessionId, sessionConfig)

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
