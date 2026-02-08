"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.readSessionConfig = readSessionConfig;
exports.writeSessionConfig = writeSessionConfig;
const fs_1 = require("fs");
const fs_2 = require("fs");
const path_1 = require("path");
const os_1 = require("os");
const log_1 = require("./log");
function resolveStateDir(stateDir) {
    return stateDir || (0, path_1.join)((0, os_1.homedir)(), '.claude', 'tav', 'state');
}
function sessionConfigPath(sessionId, stateDir) {
    const sanitized = (0, log_1.sanitizeSessionId)(sessionId);
    return (0, path_1.join)(resolveStateDir(stateDir), `${sanitized}.json`);
}
/**
 * Reads session config from the state directory.
 * Returns null if the file doesn't exist or is unreadable.
 */
function readSessionConfig(sessionId, stateDir) {
    const path = sessionConfigPath(sessionId, stateDir);
    if (!(0, fs_2.existsSync)(path)) {
        return null;
    }
    try {
        const content = (0, fs_1.readFileSync)(path, 'utf-8');
        return JSON.parse(content);
    }
    catch {
        return null;
    }
}
/**
 * Writes session config to the state directory using atomic write operation.
 * Ensures the state directory exists before writing.
 * Uses write-to-temp + rename for atomicity (prevents partial writes on crash).
 */
function writeSessionConfig(sessionId, config, stateDir) {
    (0, log_1.ensureStateDir)(stateDir);
    const path = sessionConfigPath(sessionId, stateDir);
    const tmpPath = path + '.tmp';
    // Write to temp file first
    (0, fs_1.writeFileSync)(tmpPath, JSON.stringify(config, null, 2), 'utf-8');
    // Atomic rename (POSIX guarantees atomicity)
    (0, fs_1.renameSync)(tmpPath, path);
}
