#!/usr/bin/env node

/**
 * JSONL session preprocessor for Gemini analysis.
 *
 * Filters noise entries (progress, file-history-snapshot ~44% reduction),
 * keeps user + assistant entries, truncates tool_use content blocks,
 * and outputs clean markdown suitable for LLM consumption.
 *
 * Usage:
 *   bun run src/extract-session.ts <session.jsonl> [--output /tmp/out.md] [--max-chars 500000]
 */

import { readFileSync, writeFileSync, existsSync } from 'fs'
import type { JournalEntry } from './lib/jsonl-types'

// --- Types ---

export interface ExtractOptions {
  maxChars: number        // Output character limit (default: 500000 ~125K tokens)
  toolUseMaxChars: number // Truncation limit for tool_use content blocks (default: 200)
}

export interface ExtractResult {
  output: string
  totalEntries: number
  keptEntries: number
  discardedEntries: number
  truncated: boolean
}

// --- Core ---

const NOISE_TYPES = new Set(['progress', 'file-history-snapshot'])

/**
 * Extracts meaningful content from a parsed JSONL session.
 * Filters noise, truncates tool_use blocks, formats as markdown.
 *
 * Exported for testing — the CLI entry point is main().
 */
export function extractSession(
  lines: string[],
  options: ExtractOptions = { maxChars: 500000, toolUseMaxChars: 200 }
): ExtractResult {
  const chunks: string[] = []
  let charCount = 0
  let totalEntries = 0
  let keptEntries = 0
  let truncated = false

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue

    let entry: JournalEntry
    try {
      entry = JSON.parse(trimmed) as JournalEntry
    } catch {
      continue // malformed JSON — skip
    }

    totalEntries++

    // Discard noise types (~44% of entries)
    if (NOISE_TYPES.has(entry.type)) continue

    const message = entry.message
    if (!message) continue

    keptEntries++

    const chunk = formatEntry(entry, options.toolUseMaxChars)
    // Account for \n\n separator between chunks in join()
    const sepLen = chunks.length > 0 ? 2 : 0
    const newCount = charCount + sepLen + chunk.length

    if (newCount > options.maxChars) {
      truncated = true
      const remaining = options.maxChars - charCount - sepLen
      if (remaining > 100) {
        chunks.push(chunk.slice(0, remaining) + '\n\n[... truncated ...]')
      } else {
        chunks.push('[... truncated ...]')
      }
      break
    }

    chunks.push(chunk)
    charCount = newCount
  }

  const discardedEntries = totalEntries - keptEntries

  return {
    output: chunks.join('\n\n'),
    totalEntries,
    keptEntries,
    discardedEntries,
    truncated
  }
}

/**
 * Formats a single JSONL entry as a markdown section.
 */
function formatEntry(entry: JournalEntry, toolUseMaxChars: number): string {
  const role = entry.message?.role ?? entry.type
  const timestamp = entry.timestamp ? ` (${entry.timestamp})` : ''
  const usage = formatUsage(entry)

  const header = `### ${role}${timestamp}${usage}`
  const body = formatContent(entry.message?.content, toolUseMaxChars)

  return `${header}\n\n${body}`
}

/**
 * Formats token usage data if present.
 */
function formatUsage(entry: JournalEntry): string {
  const usage = entry.message?.usage
  if (!usage) return ''

  const input = (usage.input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0)
  const output = usage.output_tokens ?? 0

  if (input === 0 && output === 0) return ''
  return ` [ctx:${input} out:${output}]`
}

/**
 * Formats message content. Handles both string content and
 * structured content blocks (array of text/tool_use/tool_result).
 * Truncates tool_use input blocks to keep output manageable.
 */
function formatContent(content: unknown, toolUseMaxChars: number): string {
  if (typeof content === 'string') return content

  if (!Array.isArray(content)) {
    return typeof content === 'object' && content !== null
      ? JSON.stringify(content, null, 2)
      : String(content ?? '')
  }

  // Structured content blocks
  const parts: string[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) {
      parts.push(String(block))
      continue
    }

    const b = block as Record<string, unknown>
    switch (b.type) {
      case 'text':
        parts.push(String(b.text ?? ''))
        break

      case 'tool_use': {
        const name = String(b.name ?? 'unknown_tool')
        const input = b.input != null ? JSON.stringify(b.input) : ''
        const truncInput = input.length > toolUseMaxChars
          ? input.slice(0, toolUseMaxChars) + '...'
          : input
        parts.push(`**Tool: ${name}**\n\`\`\`\n${truncInput}\n\`\`\``)
        break
      }

      case 'tool_result': {
        const resultContent = b.content
        if (typeof resultContent === 'string') {
          const truncResult = resultContent.length > toolUseMaxChars
            ? resultContent.slice(0, toolUseMaxChars) + '...'
            : resultContent
          parts.push(`**Result:**\n\`\`\`\n${truncResult}\n\`\`\``)
        } else if (Array.isArray(resultContent)) {
          // Nested content blocks in tool results
          const nested = formatContent(resultContent, toolUseMaxChars)
          parts.push(`**Result:**\n${nested}`)
        }
        break
      }

      default:
        parts.push(JSON.stringify(b))
    }
  }

  return parts.join('\n\n')
}

// --- CLI ---

function printUsage(): void {
  process.stderr.write(
    'Usage: extract-session <session.jsonl> [--output <path>] [--max-chars <n>]\n' +
    '\nPreprocesses session JSONL for Gemini analysis.\n' +
    'Filters noise (progress, file-history-snapshot), truncates tool_use blocks.\n'
  )
}

export function main(args: string[] = process.argv.slice(2)): void {
  if (args.length === 0 || args.includes('--help')) {
    printUsage()
    process.exit(args.includes('--help') ? 0 : 1)
  }

  const inputPath = args[0]
  let outputPath: string | null = null
  let maxChars = 500000

  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--output' && args[i + 1]) {
      outputPath = args[++i]
    } else if (args[i] === '--max-chars' && args[i + 1]) {
      const parsed = parseInt(args[++i], 10)
      if (!isNaN(parsed) && parsed > 0) maxChars = parsed
    }
  }

  if (!existsSync(inputPath)) {
    process.stderr.write(`Error: file not found: ${inputPath}\n`)
    process.exit(1)
  }

  const content = readFileSync(inputPath, 'utf-8')
  const lines = content.split('\n')

  const result = extractSession(lines, { maxChars, toolUseMaxChars: 200 })

  const summary = [
    `<!-- Session extract: ${result.keptEntries}/${result.totalEntries} entries kept`,
    `(${result.discardedEntries} noise discarded)${result.truncated ? ' [TRUNCATED]' : ''} -->`
  ].join(' ')

  const fullOutput = `${summary}\n\n${result.output}`

  if (outputPath) {
    writeFileSync(outputPath, fullOutput, 'utf-8')
    process.stderr.write(
      `Extracted ${result.keptEntries}/${result.totalEntries} entries → ${outputPath}\n`
    )
  } else {
    process.stdout.write(fullOutput)
  }
}

// Run if executed directly
const isDirectExecution = process.argv[1]?.endsWith('extract-session.ts') ||
  process.argv[1]?.endsWith('extract-session.js')
if (isDirectExecution) {
  main()
}
