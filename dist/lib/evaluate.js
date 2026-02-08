"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.shouldInjectBookmark = shouldInjectBookmark;
const log_1 = require("./log");
/**
 * Unified bookmark injection evaluation — single source of truth for guard
 * ordering. Both Stop and SubagentStop hooks call this after their own
 * context-specific pre-guards.
 *
 * Guard order (fixed, not subject to drift):
 *   1. bookmarks.enabled
 *   2. injectionMethod !== 'disabled'
 *   3. lastLineIsBookmark
 *   4. cooldown
 *   5. threshold evaluation (ANY threshold met → inject)
 */
function shouldInjectBookmark(ctx) {
    const { config, metrics, injectionMethod } = ctx;
    if (!config.bookmarks.enabled) {
        return { shouldInject: false, reason: 'bookmarks disabled in config' };
    }
    if (injectionMethod === 'disabled') {
        return { shouldInject: false, reason: 'injection method is disabled' };
    }
    if (metrics.lastLineIsBookmark) {
        return { shouldInject: false, reason: 'last line is already a bookmark' };
    }
    const lastActivityAt = Math.max(metrics.lastInjectionAt, metrics.lastBookmarkAt);
    const cooldownMs = config.bookmarks.thresholds.cooldownSeconds * 1000;
    if (Date.now() - lastActivityAt < cooldownMs) {
        return { shouldInject: false, reason: 'within cooldown period' };
    }
    const { met, reason } = (0, log_1.meetsAnyThreshold)(metrics, config.bookmarks.thresholds);
    return { shouldInject: met, reason };
}
