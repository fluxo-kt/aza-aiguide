"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.readStdin = readStdin;
/**
 * Shared stdin reader for hook scripts.
 * Uses Buffer accumulation and rejects on timeout to surface failures
 * rather than silently returning partial data.
 */
function readStdin(timeoutMs) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        const timer = setTimeout(() => {
            reject(new Error(`stdin read timeout after ${timeoutMs}ms`));
        }, timeoutMs);
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
