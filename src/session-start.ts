#!/usr/bin/env node

import { writeFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { loadConfig } from './lib/config'
import type { TavConfig } from './lib/config'
import { ensureStateDir, getLogPath, cleanOldSessions, sanitizeSessionId } from './lib/log'
import { detectInjectionMethod, checkAccessibilityPermission } from './lib/inject'
import type { InjectionConfig } from './lib/inject'

interface StdinData {
  session_id?: string
  sessionId?: string
  cwd?: string
}

interface SessionConfig {
  sessionId: string
  injectionMethod: string
  injectionTarget: string
  startedAt: number
  disabledReason?: string
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = ''
    process.stdin.setEncoding('utf-8')
    process.stdin.on('data', (chunk: string) => { data += chunk })
    process.stdin.on('end', () => { resolve(data) })
    // Safety timeout — never block
    setTimeout(() => { resolve(data) }, 3000)
  })
}

async function main(): Promise<void> {
  try {
    // Read stdin
    const stdinRaw = await readStdin()
    const data: StdinData = stdinRaw.trim() ? JSON.parse(stdinRaw) : {}

    // Extract session_id (support both formats)
    const sessionId = data.session_id || data.sessionId || 'unknown'

    // Load config
    const config: TavConfig = loadConfig()

    // If bookmarks disabled, exit early
    if (config.bookmarks.enabled === false) {
      console.log(JSON.stringify({
        continue: true,
        note: 'Bookmarks disabled in config'
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

    // Sanitize session ID for filesystem
    const sanitizedId = sanitizeSessionId(sessionId)

    // Write session config
    const sessionConfig: SessionConfig = {
      sessionId,
      injectionMethod: injection.method,
      injectionTarget: injection.target,
      startedAt: Date.now(),
      ...(disabledReason ? { disabledReason } : {})
    }

    const sessionConfigPath = join(homedir(), '.claude', 'tav', 'state', `${sanitizedId}.json`)
    writeFileSync(sessionConfigPath, JSON.stringify(sessionConfig, null, 2), 'utf-8')

    // Create empty activity log
    const logPath = getLogPath(sessionId)
    writeFileSync(logPath, '', 'utf-8')

    // Clean old sessions (7 days)
    cleanOldSessions(7)

    // Output success
    console.log(JSON.stringify({ continue: true }))
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
