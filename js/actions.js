import { STALE_ALERT_MS } from './config.js';
import * as payment from './payment.js';
import { closeActions, IDLE_CLOSE } from './close.js';

/**
 * Store state shape (Caja), adapted from foodc-kds/js/actions.js:
 *
 * {
 *   auth:    { status: 'locked'|'verifying'|'unlocked',
 *              error: null|'wrong_pin'|'offline'|'not_configured'|'contract' },
 *   queue:   { orders: Order[], lastSyncAt: number|null, pollSeq: number },
 *   sync:    { status: 'idle'|'connecting'|'ok'|'retrying'|'stale'|'contract'|'not_configured',
 *              failingSince: number|null },
 *   payment: { pending: PendingPayment[] },
 *   close:   see js/close.js IDLE_CLOSE shape,
 *   notice:  null | { kind: 'restored', table_number: string },
 * }
 *
 * `queue.pollSeq` is kept here as plain bookkeeping (last applied poll
 * sequence), never read by any reducer's branching logic, same as
 * foodc-kds.
 *
 * @param {{ pending?: import('./payment.js').PendingPayment[], hasPin?: boolean }} [hydrated]
 */
export function initialState({ pending = [], hasPin = false } = {}) {
  return {
    auth: { status: hasPin ? 'unlocked' : 'locked', error: null },
    queue: { orders: [], lastSyncAt: null, pollSeq: 0 },
    // While locked there is no polling at all, hence 'idle' (same posture
    // as foodc-kds's A2).
    sync: { status: hasPin ? 'connecting' : 'idle', failingSince: null },
    payment: { pending },
    close: { ...IDLE_CLOSE },
    notice: null,
  };
}

export const actions = {
  unlockStarted(state) {
    return { ...state, auth: { status: 'verifying', error: null } };
  },

  unlockSucceeded(state) {
    return {
      ...state,
      auth: { status: 'unlocked', error: null },
      sync: { status: 'connecting', failingSince: null },
    };
  },

  unlockFailed(state, { error }) {
    return { ...state, auth: { status: 'locked', error } };
  },

  // Re-lock never clears the queue or pending payments: the cards the
  // cashier was looking at, and anything mid-flight to the server, must
  // survive a PIN rejection/rotation (same posture as foodc-kds).
  relock(state, { reason }) {
    return { ...state, auth: { status: 'locked', error: reason } };
  },

  pollSucceeded(state, { orders, seq, at }) {
    return {
      ...state,
      queue: { orders, lastSyncAt: at, pollSeq: seq },
      sync: { status: 'ok', failingSince: null },
      payment: { pending: payment.purgeAfterPoll(state.payment.pending, seq) },
    };
  },

  pollFailed(state, { kind, at }) {
    // failingSince is set once per failing streak: only when the previous
    // state had no clock running yet (reset to null by the last pollSucceeded).
    const failingSince = state.sync.failingSince === null ? at : state.sync.failingSince;
    const status = kind === 'transient' ? 'retrying' : kind; // 'contract' | 'not_configured' pass through
    return { ...state, sync: { status, failingSince } };
  },

  staleCheck(state, { at }) {
    const { status, failingSince } = state.sync;
    if (status === 'retrying' && failingSince !== null && at - failingSince >= STALE_ALERT_MS) {
      return { ...state, sync: { status: 'stale', failingSince } };
    }
    return state;
  },

  paymentQueued(state, { order, at }) {
    return { ...state, payment: { pending: payment.enqueue(state.payment.pending, order, at) } };
  },

  paymentConfirmed(state, { id, seq }) {
    return { ...state, payment: { pending: payment.markConfirmed(state.payment.pending, id, seq) } };
  },

  paymentRetry(state, { id, at }) {
    return { ...state, payment: { pending: payment.markRetry(state.payment.pending, id, at) } };
  },

  paymentRestored(state, { id }) {
    const entry = state.payment.pending.find((p) => p.order_id === id);
    return {
      ...state,
      payment: { pending: payment.restore(state.payment.pending, id) },
      notice: { kind: 'restored', table_number: entry ? entry.table_number : null },
    };
  },

  dismissNotice(state) {
    if (state.notice === null) return state;
    return { ...state, notice: null };
  },

  // --- close-dialog state machine, delegated to js/close.js's closeActions ---

  closeOpened(state) {
    return { ...state, close: closeActions.open(state.close) };
  },

  closePinEntered(state, { pin }) {
    return { ...state, close: closeActions.pinEntered(state.close, pin) };
  },

  closeConfirmed(state) {
    return { ...state, close: closeActions.confirmed(state.close) };
  },

  closeCancelled(state) {
    return { ...state, close: closeActions.cancelled(state.close) };
  },

  closeResultReceived(state, { apiResult }) {
    return { ...state, close: closeActions.resultReceived(state.close, apiResult) };
  },

  closeReset(state) {
    return { ...state, close: closeActions.reset(state.close) };
  },
};
