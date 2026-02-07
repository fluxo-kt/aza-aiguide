#!/usr/bin/env node
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.processBookmark = processBookmark;
const config_1 = require("./lib/config");
const log_1 = require("./lib/log");
function processBookmark(userPrompt, marker) {
    const trimmedPrompt = userPrompt.trim();
    // Not the marker — pass through
    if (trimmedPrompt !== marker) {
        return {
            isBookmark: false,
            output: { continue: true }
        };
    }
    // Marker detected — always treat as bookmark.
    // The marker (· U+00B7 middle dot) is sufficiently uncommon that false
    // positives are negligible. Removing the anti-collision check also enables
    // manual bookmarks when terminal injection is unavailable — the user can
    // simply type · to create a rewind anchor point at any time.
    return {
        isBookmark: true,
        output: {
            continue: true,
            hookSpecificOutput: {
                hookEventName: 'UserPromptSubmit',
                additionalContext: '<system-reminder>Automated navigation bookmark (tav plugin). This is not a real user message. Do not respond to or acknowledge it. Continue working on your current task exactly where you left off.</system-reminder>'
            }
        }
    };
}
async function readStdin(timeout = 5000) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        const timer = setTimeout(() => {
            reject(new Error('Stdin read timeout'));
        }, timeout);
        process.stdin.on('data', (chunk) => chunks.push(chunk));
        process.stdin.on('end', () => {
            clearTimeout(timer);
            resolve(Buffer.concat(chunks).toString('utf8'));
        });
        process.stdin.on('error', (err) => {
            clearTimeout(timer);
            reject(err);
        });
    });
}
async function main() {
    try {
        const input = await readStdin();
        const data = JSON.parse(input);
        const sessionId = data.session_id ?? data.sessionId ?? 'unknown';
        const userPrompt = data.prompt ?? data.user_prompt ?? data.userPrompt ?? '';
        const config = (0, config_1.loadConfig)();
        const marker = config.bookmarks?.marker ?? '\u00B7';
        const { isBookmark, output } = processBookmark(userPrompt, marker);
        // If bookmark confirmed, append B line to log
        if (isBookmark) {
            (0, log_1.appendEvent)(sessionId, `B ${Date.now()}`);
        }
        console.log(JSON.stringify(output));
    }
    catch (error) {
        // Always allow continuation even on error
        console.error('bookmark-submit error:', error, { file: __filename });
        console.log(JSON.stringify({ continue: true }));
    }
}
// Only run main if executed directly (not imported)
if (require.main === module) {
    main().then(() => process.exit(0), (err) => {
        console.error('Fatal error:', err);
        process.exit(0);
    });
}
