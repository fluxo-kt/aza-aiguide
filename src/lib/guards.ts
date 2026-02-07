/**
 * Stop guard conditions for the tav plugin.
 * Pure functions that detect stop reasons preventing bookmark injection.
 * Adapted from OMC's persistent-mode.cjs patterns.
 */

/**
 * Detects if the stop was due to context/token limit being reached.
 * Checks both stop_reason and end_turn_reason fields (snake_case + camelCase).
 */
export function isContextLimitStop(data: Record<string, unknown>): boolean {
  const contextLimitPatterns = [
    'context_limit',
    'context_window',
    'context_exceeded',
    'context_full',
    'max_context',
    'token_limit',
    'max_tokens',
    'conversation_too_long',
    'input_too_long',
  ];

  // Check stop_reason / stopReason / reason (all known field name variants)
  const stopReason = (data.stop_reason ?? data.stopReason ?? data.reason) as string | undefined;
  if (stopReason) {
    const normalized = String(stopReason).toLowerCase();
    if (contextLimitPatterns.some((pattern) => normalized.includes(pattern))) {
      return true;
    }
  }

  // Check end_turn_reason (snake_case and camelCase)
  const endTurnReason = (data.end_turn_reason ?? data.endTurnReason) as string | undefined;
  if (endTurnReason) {
    const normalized = String(endTurnReason).toLowerCase();
    if (contextLimitPatterns.some((pattern) => normalized.includes(pattern))) {
      return true;
    }
  }

  return false;
}

/**
 * Detects if the stop was due to user abort/cancellation.
 * Checks user_requested flag and stop_reason patterns.
 */
export function isUserAbort(data: Record<string, unknown>): boolean {
  // Check explicit user_requested flag
  if (data.user_requested || data.userRequested) {
    return true;
  }

  // Check stop_reason / stopReason / reason (all known field name variants)
  const stopReason = (data.stop_reason ?? data.stopReason ?? data.reason) as string | undefined;
  if (!stopReason) {
    return false;
  }

  const normalized = String(stopReason).toLowerCase();

  // Exact match patterns (short words, risky for substring)
  const exactMatchPatterns = ['aborted', 'abort', 'cancel', 'interrupt'];
  if (exactMatchPatterns.includes(normalized)) {
    return true;
  }

  // Substring match patterns (compound words, safe)
  const substringPatterns = ['user_cancel', 'user_interrupt', 'ctrl_c', 'manual_stop'];
  if (substringPatterns.some((pattern) => normalized.includes(pattern))) {
    return true;
  }

  return false;
}
