#!/usr/bin/env node

import type { LogMetrics } from './lib/log'
import { loadConfig } from './lib/config'
import { parseLog, appendEvent } from './lib/log'

interface StdinData {
  hook_event_name?: string
  hookEventName?: string
  session_id?: string
  sessionId?: string
  user_prompt?: string
  userPrompt?: string
}

interface HookOutput {
  continue: boolean
  hookSpecificOutput?: {
    hookEventName: string
    additionalContext: string
  }
}

export function processBookmark(
  userPrompt: string,
  sessionId: string,
  marker: string,
  lastInjectionAt: number,
  now?: number
): { isBookmark: boolean; output: HookOutput } {
  const currentTime = now ?? Date.now()
  const trimmedPrompt = userPrompt.trim()

  // Not the marker — pass through
  if (trimmedPrompt !== marker) {
    return {
      isBookmark: false,
      output: { continue: true }
    }
  }

  // Anti-collision check: recent injection within 10 seconds
  const hasRecentInjection = lastInjectionAt > 0 && currentTime - lastInjectionAt < 10000

  if (!hasRecentInjection) {
    // User typed marker manually — pass through as real input
    return {
      isBookmark: false,
      output: { continue: true }
    }
  }

  // Valid bookmark detected
  return {
    isBookmark: true,
    output: {
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext:
          '<system-reminder>Automated navigation bookmark (tav plugin). This is not a real user message. Do not respond to or acknowledge it. Continue working on your current task exactly where you left off.</system-reminder>'
      }
    }
  }
}

async function readStdin(timeout = 5000): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    const timer = setTimeout(() => {
      reject(new Error('Stdin read timeout'))
    }, timeout)

    process.stdin.on('data', (chunk) => chunks.push(chunk))
    process.stdin.on('end', () => {
      clearTimeout(timer)
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
    process.stdin.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

async function main(): Promise<void> {
  try {
    const input = await readStdin()
    const data: StdinData = JSON.parse(input)

    const sessionId = data.session_id ?? data.sessionId ?? 'unknown'
    const userPrompt = data.user_prompt ?? data.userPrompt ?? ''

    const config = loadConfig()
    const marker = config.bookmarks?.marker ?? '\u00B7'

    // Parse log to get last injection time
    const metrics: LogMetrics = parseLog(sessionId)

    const { isBookmark, output } = processBookmark(
      userPrompt,
      sessionId,
      marker,
      metrics.lastInjectionAt
    )

    // If bookmark confirmed, append B line to log
    if (isBookmark) {
      appendEvent(sessionId, `B ${Date.now()}`)
    }

    console.log(JSON.stringify(output))
  } catch (error) {
    // Always allow continuation even on error
    console.error('bookmark-submit error:', error, { file: __filename })
    console.log(JSON.stringify({ continue: true }))
  }
}

// Only run main if executed directly (not imported)
if (require.main === module) {
  main().then(
    () => process.exit(0),
    (err) => {
      console.error('Fatal error:', err)
      process.exit(0)
    }
  )
}
