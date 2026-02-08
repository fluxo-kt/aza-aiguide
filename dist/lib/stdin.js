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
        const cleanup = () => {
            process.stdin.removeListener('data', onData);
            process.stdin.removeListener('end', onEnd);
            process.stdin.removeListener('error', onError);
        };
        const timer = setTimeout(() => {
            cleanup();
            reject(new Error(`stdin read timeout after ${timeoutMs}ms`));
        }, timeoutMs);
        const onData = (chunk) => { chunks.push(chunk); };
        const onEnd = () => {
            clearTimeout(timer);
            cleanup();
            resolve(Buffer.concat(chunks).toString('utf8'));
        };
        const onError = (err) => {
            clearTimeout(timer);
            cleanup();
            reject(err);
        };
        process.stdin.on('data', onData);
        process.stdin.on('end', onEnd);
        process.stdin.on('error', onError);
    });
}
