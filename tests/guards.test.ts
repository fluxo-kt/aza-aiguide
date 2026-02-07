import { describe, expect, test } from 'bun:test';
import { isContextLimitStop, isUserAbort } from '../src/lib/guards';

describe('isContextLimitStop', () => {
  test('returns true for context_limit stop_reason', () => {
    expect(isContextLimitStop({ stop_reason: 'context_limit' })).toBe(true);
  });

  test('returns true for token_limit stopReason (camelCase)', () => {
    expect(isContextLimitStop({ stopReason: 'token_limit' })).toBe(true);
  });

  test('returns true for context_window in end_turn_reason', () => {
    expect(isContextLimitStop({ end_turn_reason: 'context_window' })).toBe(true);
  });

  test('returns true for token_limit in endTurnReason (camelCase)', () => {
    expect(isContextLimitStop({ endTurnReason: 'max_tokens' })).toBe(true);
  });

  test('returns true for conversation_too_long', () => {
    expect(isContextLimitStop({ stop_reason: 'conversation_too_long' })).toBe(true);
  });

  test('returns true for input_too_long', () => {
    expect(isContextLimitStop({ stop_reason: 'input_too_long' })).toBe(true);
  });

  test('returns true for context_exceeded', () => {
    expect(isContextLimitStop({ stop_reason: 'context_exceeded' })).toBe(true);
  });

  test('returns true for context_full', () => {
    expect(isContextLimitStop({ stop_reason: 'context_full' })).toBe(true);
  });

  test('returns true for max_context', () => {
    expect(isContextLimitStop({ stop_reason: 'max_context' })).toBe(true);
  });

  test('returns false for normal stop', () => {
    expect(isContextLimitStop({ stop_reason: 'end_turn' })).toBe(false);
  });

  test('returns false for completed stop', () => {
    expect(isContextLimitStop({ stop_reason: 'completed' })).toBe(false);
  });

  test('handles empty data gracefully', () => {
    expect(isContextLimitStop({})).toBe(false);
  });

  test('handles undefined stop_reason gracefully', () => {
    expect(isContextLimitStop({ stop_reason: undefined })).toBe(false);
  });

  test('handles null stop_reason gracefully', () => {
    expect(isContextLimitStop({ stop_reason: null })).toBe(false);
  });
});

describe('isUserAbort', () => {
  test('returns true for user_requested flag', () => {
    expect(isUserAbort({ user_requested: true })).toBe(true);
  });

  test('returns true for userRequested flag (camelCase)', () => {
    expect(isUserAbort({ userRequested: true })).toBe(true);
  });

  test('returns true for abort stop_reason (exact match)', () => {
    expect(isUserAbort({ stop_reason: 'abort' })).toBe(true);
  });

  test('returns true for aborted stop_reason (exact match)', () => {
    expect(isUserAbort({ stop_reason: 'aborted' })).toBe(true);
  });

  test('returns true for cancel stop_reason (exact match)', () => {
    expect(isUserAbort({ stop_reason: 'cancel' })).toBe(true);
  });

  test('returns true for interrupt stop_reason (exact match)', () => {
    expect(isUserAbort({ stop_reason: 'interrupt' })).toBe(true);
  });

  test('returns true for user_cancel stop_reason (substring)', () => {
    expect(isUserAbort({ stop_reason: 'user_cancel' })).toBe(true);
  });

  test('returns true for user_interrupt stop_reason (substring)', () => {
    expect(isUserAbort({ stop_reason: 'user_interrupt' })).toBe(true);
  });

  test('returns true for ctrl_c stop_reason', () => {
    expect(isUserAbort({ stop_reason: 'ctrl_c' })).toBe(true);
  });

  test('returns true for manual_stop stop_reason', () => {
    expect(isUserAbort({ stop_reason: 'manual_stop' })).toBe(true);
  });

  test('returns true for ABORT (case insensitive)', () => {
    expect(isUserAbort({ stop_reason: 'ABORT' })).toBe(true);
  });

  test('returns false for normal stop', () => {
    expect(isUserAbort({ stop_reason: 'end_turn' })).toBe(false);
  });

  test('returns false for completed stop', () => {
    expect(isUserAbort({ stop_reason: 'completed' })).toBe(false);
  });

  test('handles empty data gracefully', () => {
    expect(isUserAbort({})).toBe(false);
  });

  test('handles undefined stop_reason gracefully', () => {
    expect(isUserAbort({ stop_reason: undefined })).toBe(false);
  });

  test('handles null stop_reason gracefully', () => {
    expect(isUserAbort({ stop_reason: null })).toBe(false);
  });

  test('does not false-positive on words containing abort', () => {
    expect(isUserAbort({ stop_reason: 'elaboration' })).toBe(false);
  });

  test('does not false-positive on words containing cancel', () => {
    expect(isUserAbort({ stop_reason: 'cancellation_policy' })).toBe(false);
  });

  test('does not false-positive on words containing interrupt', () => {
    expect(isUserAbort({ stop_reason: 'uninterrupted' })).toBe(false);
  });
});
