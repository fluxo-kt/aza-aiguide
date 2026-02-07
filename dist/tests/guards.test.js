"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const bun_test_1 = require("bun:test");
const guards_1 = require("../src/lib/guards");
(0, bun_test_1.describe)('isContextLimitStop', () => {
    (0, bun_test_1.test)('returns true for context_limit stop_reason', () => {
        (0, bun_test_1.expect)((0, guards_1.isContextLimitStop)({ stop_reason: 'context_limit' })).toBe(true);
    });
    (0, bun_test_1.test)('returns true for token_limit stopReason (camelCase)', () => {
        (0, bun_test_1.expect)((0, guards_1.isContextLimitStop)({ stopReason: 'token_limit' })).toBe(true);
    });
    (0, bun_test_1.test)('returns true for context_window in end_turn_reason', () => {
        (0, bun_test_1.expect)((0, guards_1.isContextLimitStop)({ end_turn_reason: 'context_window' })).toBe(true);
    });
    (0, bun_test_1.test)('returns true for token_limit in endTurnReason (camelCase)', () => {
        (0, bun_test_1.expect)((0, guards_1.isContextLimitStop)({ endTurnReason: 'max_tokens' })).toBe(true);
    });
    (0, bun_test_1.test)('returns true for conversation_too_long', () => {
        (0, bun_test_1.expect)((0, guards_1.isContextLimitStop)({ stop_reason: 'conversation_too_long' })).toBe(true);
    });
    (0, bun_test_1.test)('returns true for input_too_long', () => {
        (0, bun_test_1.expect)((0, guards_1.isContextLimitStop)({ stop_reason: 'input_too_long' })).toBe(true);
    });
    (0, bun_test_1.test)('returns true for context_exceeded', () => {
        (0, bun_test_1.expect)((0, guards_1.isContextLimitStop)({ stop_reason: 'context_exceeded' })).toBe(true);
    });
    (0, bun_test_1.test)('returns true for context_full', () => {
        (0, bun_test_1.expect)((0, guards_1.isContextLimitStop)({ stop_reason: 'context_full' })).toBe(true);
    });
    (0, bun_test_1.test)('returns true for max_context', () => {
        (0, bun_test_1.expect)((0, guards_1.isContextLimitStop)({ stop_reason: 'max_context' })).toBe(true);
    });
    (0, bun_test_1.test)('returns false for normal stop', () => {
        (0, bun_test_1.expect)((0, guards_1.isContextLimitStop)({ stop_reason: 'end_turn' })).toBe(false);
    });
    (0, bun_test_1.test)('returns false for completed stop', () => {
        (0, bun_test_1.expect)((0, guards_1.isContextLimitStop)({ stop_reason: 'completed' })).toBe(false);
    });
    (0, bun_test_1.test)('handles empty data gracefully', () => {
        (0, bun_test_1.expect)((0, guards_1.isContextLimitStop)({})).toBe(false);
    });
    (0, bun_test_1.test)('handles undefined stop_reason gracefully', () => {
        (0, bun_test_1.expect)((0, guards_1.isContextLimitStop)({ stop_reason: undefined })).toBe(false);
    });
    (0, bun_test_1.test)('handles null stop_reason gracefully', () => {
        (0, bun_test_1.expect)((0, guards_1.isContextLimitStop)({ stop_reason: null })).toBe(false);
    });
});
(0, bun_test_1.describe)('isUserAbort', () => {
    (0, bun_test_1.test)('returns true for user_requested flag', () => {
        (0, bun_test_1.expect)((0, guards_1.isUserAbort)({ user_requested: true })).toBe(true);
    });
    (0, bun_test_1.test)('returns true for userRequested flag (camelCase)', () => {
        (0, bun_test_1.expect)((0, guards_1.isUserAbort)({ userRequested: true })).toBe(true);
    });
    (0, bun_test_1.test)('returns true for abort stop_reason (exact match)', () => {
        (0, bun_test_1.expect)((0, guards_1.isUserAbort)({ stop_reason: 'abort' })).toBe(true);
    });
    (0, bun_test_1.test)('returns true for aborted stop_reason (exact match)', () => {
        (0, bun_test_1.expect)((0, guards_1.isUserAbort)({ stop_reason: 'aborted' })).toBe(true);
    });
    (0, bun_test_1.test)('returns true for cancel stop_reason (exact match)', () => {
        (0, bun_test_1.expect)((0, guards_1.isUserAbort)({ stop_reason: 'cancel' })).toBe(true);
    });
    (0, bun_test_1.test)('returns true for interrupt stop_reason (exact match)', () => {
        (0, bun_test_1.expect)((0, guards_1.isUserAbort)({ stop_reason: 'interrupt' })).toBe(true);
    });
    (0, bun_test_1.test)('returns true for user_cancel stop_reason (substring)', () => {
        (0, bun_test_1.expect)((0, guards_1.isUserAbort)({ stop_reason: 'user_cancel' })).toBe(true);
    });
    (0, bun_test_1.test)('returns true for user_interrupt stop_reason (substring)', () => {
        (0, bun_test_1.expect)((0, guards_1.isUserAbort)({ stop_reason: 'user_interrupt' })).toBe(true);
    });
    (0, bun_test_1.test)('returns true for ctrl_c stop_reason', () => {
        (0, bun_test_1.expect)((0, guards_1.isUserAbort)({ stop_reason: 'ctrl_c' })).toBe(true);
    });
    (0, bun_test_1.test)('returns true for manual_stop stop_reason', () => {
        (0, bun_test_1.expect)((0, guards_1.isUserAbort)({ stop_reason: 'manual_stop' })).toBe(true);
    });
    (0, bun_test_1.test)('returns true for ABORT (case insensitive)', () => {
        (0, bun_test_1.expect)((0, guards_1.isUserAbort)({ stop_reason: 'ABORT' })).toBe(true);
    });
    (0, bun_test_1.test)('returns false for normal stop', () => {
        (0, bun_test_1.expect)((0, guards_1.isUserAbort)({ stop_reason: 'end_turn' })).toBe(false);
    });
    (0, bun_test_1.test)('returns false for completed stop', () => {
        (0, bun_test_1.expect)((0, guards_1.isUserAbort)({ stop_reason: 'completed' })).toBe(false);
    });
    (0, bun_test_1.test)('handles empty data gracefully', () => {
        (0, bun_test_1.expect)((0, guards_1.isUserAbort)({})).toBe(false);
    });
    (0, bun_test_1.test)('handles undefined stop_reason gracefully', () => {
        (0, bun_test_1.expect)((0, guards_1.isUserAbort)({ stop_reason: undefined })).toBe(false);
    });
    (0, bun_test_1.test)('handles null stop_reason gracefully', () => {
        (0, bun_test_1.expect)((0, guards_1.isUserAbort)({ stop_reason: null })).toBe(false);
    });
    (0, bun_test_1.test)('does not false-positive on words containing abort', () => {
        (0, bun_test_1.expect)((0, guards_1.isUserAbort)({ stop_reason: 'elaboration' })).toBe(false);
    });
    (0, bun_test_1.test)('does not false-positive on words containing cancel', () => {
        (0, bun_test_1.expect)((0, guards_1.isUserAbort)({ stop_reason: 'cancellation_policy' })).toBe(false);
    });
    (0, bun_test_1.test)('does not false-positive on words containing interrupt', () => {
        (0, bun_test_1.expect)((0, guards_1.isUserAbort)({ stop_reason: 'uninterrupted' })).toBe(false);
    });
});
