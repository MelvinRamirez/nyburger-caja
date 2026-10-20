/**
 * Pure close-flow reducer and result classifier for the day-close
 * ("cierre de día") action. Mirrors design.md "js/close.js" exactly.
 *
 * close.status: 'idle' | 'pin' | 'confirm' | 'running' | 'done' |
 *   'already_closed' | 'nothing' | 'in_progress' | 'failed' | 'unknown' |
 *   'blocked' | 'contract'
 */

const IDLE_CLOSE = Object.freeze({
  status: 'idle',
  pin: null,
  summary: null,
  error: null,
  step: null,
  code: null,
  retryAfterS: null,
});

/**
 * Classifies the `closeDay` ApiResult (see js/api.js) into the close-flow
 * result shape, per every row of design's status table.
 *
 * @param {import('./api.js').ApiResult} apiResult
 * @returns {{ status: string, [k: string]: any }}
 */
export function classifyCloseResult(apiResult) {
  if (apiResult.kind === 'success') {
    return { status: 'done', summary: apiResult.data };
  }

  if (apiResult.kind === 'definitive') {
    switch (apiResult.code) {
      case 'DAY_ALREADY_CLOSED':
        return { status: 'already_closed', summary: apiResult.details ?? null };
      case 'NOTHING_TO_CLOSE':
        return { status: 'nothing' };
      case 'CLOSE_IN_PROGRESS':
        return { status: 'in_progress', retryAfterS: apiResult.details?.retry_after_s ?? null };
      case 'CLOSE_STEP_FAILED':
        return { status: 'failed', step: apiResult.details?.step ?? null };
      case 'LOCK_TIMEOUT':
      case 'SHEET_UNAVAILABLE':
      case 'INTERNAL_ERROR':
        return { status: 'failed', step: null };
      case 'UNAUTHORIZED':
        // Dialog-only: the re-entered close PIN was rejected. This does NOT
        // produce a close "failed" result; the global screen re-lock (clear
        // stored PIN, stop polling) is wired at the effects layer (K2, see
        // design.md "A wrong close PIN does not re-lock the queue screen"
        // and `caja-day-close-flow` "UNAUTHORIZED on the Close Request
        // Re-Locks Instead of Showing a Close Error").
        return { status: 'pin', error: 'wrong_pin' };
      case 'PIN_NOT_CONFIGURED':
      case 'CLOSE_NOT_CONFIGURED':
      case 'ARCHIVE_CONFLICT':
        return { status: 'blocked', code: apiResult.code };
      case 'UNKNOWN_ACTION':
      case 'INVALID_JSON':
      case 'VALIDATION_ERROR':
        return { status: 'contract' };
      default:
        return { status: 'unknown' };
    }
  }

  // ambiguous (network, timeout, invalid_response): "reintentar es seguro".
  return { status: 'unknown' };
}

/**
 * Tapping the "Cerrar día" action: enters the PIN re-prompt step (C12 —
 * always required even when the screen is already unlocked).
 *
 * @param {object} _close current close sub-state (ignored: always resets).
 * @returns {object}
 */
export function open(_close) {
  return { ...IDLE_CLOSE, status: 'pin' };
}

/**
 * The cashier re-entered the Caja PIN: move to the explicit "are you sure"
 * confirmation step, per `caja-day-close-flow` "Double Confirmation".
 *
 * @param {object} close
 * @param {string} pin
 * @returns {object}
 */
export function pinEntered(close, pin) {
  return { ...close, status: 'confirm', pin };
}

/**
 * The cashier accepted the explicit confirmation: the close request is now
 * sent (orchestrated by effects.js, K2). This reducer only records the
 * transition to 'running'.
 *
 * @param {object} close
 * @returns {object}
 */
export function confirmed(close) {
  return { ...close, status: 'running' };
}

/**
 * The cashier declined or cancelled the confirmation step: no request is
 * sent, and the flow resets to idle (`caja-day-close-flow` "Cancelling the
 * confirmation step sends no request").
 *
 * @param {object} _close
 * @returns {object}
 */
export function cancelled(_close) {
  return { ...IDLE_CLOSE };
}

/**
 * The closeDay ApiResult arrived: classify it and merge into the close
 * sub-state, preserving the previously entered pin for a possible retry.
 *
 * @param {object} close
 * @param {import('./api.js').ApiResult} apiResult
 * @returns {object}
 */
export function resultReceived(close, apiResult) {
  return { ...close, ...classifyCloseResult(apiResult) };
}

/**
 * Dismisses a terminal result (done/already_closed/nothing/blocked/
 * contract/unknown) and returns to idle, ready for "Cerrar día" to be
 * tapped again. Also used to start a fresh double-confirmation after a
 * retryable failure (`caja-day-close-flow` "Retrying after a partial
 * failure reuses double confirmation").
 *
 * @param {object} _close
 * @returns {object}
 */
export function reset(_close) {
  return { ...IDLE_CLOSE };
}

export const closeActions = { open, pinEntered, confirmed, cancelled, resultReceived, reset };

export { IDLE_CLOSE };
