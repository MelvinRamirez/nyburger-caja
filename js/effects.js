import { actions } from './actions.js';
import * as pin from './pin.js';
import { nextDue } from './payment.js';
import { isRelock } from './api.js';
import { POLL_INTERVAL_MS } from './config.js';

/**
 * Internal engine. `ctx` is created once by `main.js` (the composition
 * root, K3) and shared across every effect call for the life of the page,
 * so the running poll loop, the running payment runner, and the monotonic
 * poll sequence counter are stashed as private fields directly on that
 * same `ctx` object (same judgment call as `foodc-kds/js/effects.js`):
 *
 *   ctx.__poll              - { running, inFlight, timer, stop, pollOnce }
 *   ctx.__runner            - { running, paused, timer, busy, wake, stop, pause }
 *   ctx.__pollSeqCounter    - number, the last seq handed to a poll attempt
 *
 * This keeps every effect pure with respect to its inputs and keeps a
 * second independent `ctx` (as used throughout this test suite) fully
 * isolated from any other page/test's polling or runner state.
 */

// Codes that indicate a contract bug in the poll request itself (never a
// data-state mismatch): mirrors foodc-kds's effects.js CONTRACT_ERROR_CODES,
// used only for classifying POLL failures into sync.status.
const POLL_CONTRACT_ERROR_CODES = new Set(['UNKNOWN_ACTION', 'INVALID_JSON', 'VALIDATION_ERROR']);

// Codes that restore a mark-Pagada card to the visible queue with a visible
// notice, per `caja-payment-queue` "Mark-Pagada Recovery Policy". Distinct
// from POLL_CONTRACT_ERROR_CODES: markOrderPaid can additionally fail with
// INVALID_TRANSITION (a data-state mismatch, e.g. the order was not already
// Completado), which the policy table treats the same way as the three
// generic contract-bug codes (restore + visible error).
const PAYMENT_CONTRACT_ERROR_CODES = new Set([
  'VALIDATION_ERROR',
  'INVALID_JSON',
  'UNKNOWN_ACTION',
  'INVALID_TRANSITION',
]);

function ensurePollSeqCounter(ctx) {
  if (typeof ctx.__pollSeqCounter !== 'number') {
    ctx.__pollSeqCounter = ctx.store.getState().queue.pollSeq || 0;
  }
  return ctx.__pollSeqCounter;
}

/** Increments and returns the seq used as THIS poll attempt's startedSeq. */
function incrementPollSeq(ctx) {
  ensurePollSeqCounter(ctx);
  ctx.__pollSeqCounter += 1;
  return ctx.__pollSeqCounter;
}

/** Peeks (without incrementing) the seq the NEXT poll attempt will receive. */
function peekNextPollSeq(ctx) {
  ensurePollSeqCounter(ctx);
  return ctx.__pollSeqCounter + 1;
}

function mapPollFailureKind(result) {
  if (result.kind === 'definitive') {
    if (result.code === 'PIN_NOT_CONFIGURED') return 'not_configured';
    if (POLL_CONTRACT_ERROR_CODES.has(result.code)) return 'contract';
    return 'transient';
  }
  return 'transient'; // ambiguous
}

/**
 * Severity rank for one half of the dual-fetch poll (`Pendiente` +
 * `Pagada`), lower = more specific/higher priority. Mirrors the existing
 * single-fetch priority this poll already applied before the dual fetch:
 * a relock-triggering UNAUTHORIZED outranks PIN_NOT_CONFIGURED, which
 * outranks a contract-bug code, which outranks everything else
 * (transient/ambiguous). Only used to pick ONE failure to report when both
 * concurrent `getCajaOrders` calls fail differently — this tie-break isn't
 * further specified by the task, so it reuses the poll's own existing
 * priority order instead of inventing a new one.
 *
 * @param {import('./api.js').ApiResult} result
 * @returns {0|1|2|3}
 */
function pollFailureRank(result) {
  if (isRelock(result)) return 0;
  if (result.kind === 'definitive' && result.code === 'PIN_NOT_CONFIGURED') return 1;
  if (result.kind === 'definitive' && POLL_CONTRACT_ERROR_CODES.has(result.code)) return 2;
  return 3;
}

/**
 * Picks which of the two concurrent `getCajaOrders` results to report when
 * at least one of them did not succeed: the single failing one, or (when
 * both failed and differ) the more specific one per `pollFailureRank`.
 *
 * @param {import('./api.js').ApiResult} pendienteResult
 * @param {import('./api.js').ApiResult} pagadaResult
 * @returns {import('./api.js').ApiResult}
 */
function pickPollFailure(pendienteResult, pagadaResult) {
  const failures = [pendienteResult, pagadaResult].filter((r) => r.kind !== 'success');
  if (failures.length === 1) return failures[0];
  return pollFailureRank(failures[0]) <= pollFailureRank(failures[1]) ? failures[0] : failures[1];
}

// --- re-lock ----------------------------------------------------------

/**
 * Shared re-lock path for "any protected call -> UNAUTHORIZED -> relock"
 * (`caja-access` "UNAUTHORIZED Response Re-Locks the Screen"), and for the
 * manual "Bloquear" button (`lock`): clears the stored PIN, dispatches
 * `actions.relock`, stops the poller, and pauses the payment runner.
 * `queue.orders` and `payment.pending` are left untouched by
 * `actions.relock` itself (see actions.js).
 *
 * Exported directly (unlike foodc-kds's private `doRelock`) because task
 * 11.4 names it as part of effects.js's own contract, separate from `lock`.
 *
 * @param {object} ctx
 * @param {string} reason
 */
export function relock(ctx, reason) {
  pin.clearPin(ctx.pinStorage);
  ctx.store.setState((s) => actions.relock(s, { reason }));
  if (ctx.__poll) {
    ctx.__poll.stop();
  }
  if (ctx.__runner) {
    ctx.__runner.pause();
  }
}

// --- unlock -------------------------------------------------------------

export async function unlock(ctx, pinValue) {
  ctx.store.setState((s) => actions.unlockStarted(s));
  const result = await ctx.api.verifyCajaPin(pinValue);

  if (result.kind === 'success') {
    pin.savePin(ctx.pinStorage, pinValue);
    ctx.store.setState((s) => actions.unlockSucceeded(s));
    startPolling(ctx);
    if (ctx.__runner) {
      ctx.__runner.wake();
    }
    return;
  }

  let error;
  if (result.kind === 'definitive' && result.code === 'UNAUTHORIZED') {
    error = 'wrong_pin';
  } else if (result.kind === 'definitive' && result.code === 'PIN_NOT_CONFIGURED') {
    error = 'not_configured';
  } else if (result.kind === 'definitive' && POLL_CONTRACT_ERROR_CODES.has(result.code)) {
    error = 'contract';
  } else {
    error = 'offline';
  }
  ctx.store.setState((s) => actions.unlockFailed(s, { error }));
}

// --- polling loop (no overlap) ------------------------------------------

export function startPolling(ctx) {
  if (ctx.__poll && ctx.__poll.running) {
    return ctx.__poll.stop;
  }

  const poll = { running: true, inFlight: false, timer: null };
  ctx.__poll = poll;

  function stop() {
    poll.running = false;
    if (poll.timer !== null) {
      ctx.clearTimer(poll.timer);
      poll.timer = null;
    }
  }
  poll.stop = stop;

  function scheduleNext() {
    if (!poll.running) return;
    poll.timer = ctx.setTimer(() => {
      poll.timer = null;
      pollOnce();
    }, POLL_INTERVAL_MS);
  }

  async function pollOnce() {
    if (!poll.running || poll.inFlight) return;

    // "seq <- ++pollSeqCounter" happens before the unlocked check, same
    // ordering as foodc-kds's polling loop sequence.
    const seq = incrementPollSeq(ctx);

    if (ctx.store.getState().auth.status !== 'unlocked') {
      stop();
      return;
    }

    poll.inFlight = true;
    // Dual fetch: the main queue shows both unpaid and already-paid orders
    // together (`caja-order-prepay` scope item 2), so one poll tick now
    // issues both concurrently and merges them. The tick is a success only
    // if BOTH resolve `kind:'success'` — if either fails, the whole tick
    // fails via the existing classify/reschedule path, reporting whichever
    // of the two failures is more specific (see `pickPollFailure`).
    const [pendienteResult, pagadaResult] = await Promise.all([
      ctx.api.getCajaOrders('Pendiente'),
      ctx.api.getCajaOrders('Pagada'),
    ]);
    poll.inFlight = false;

    if (!poll.running) return; // stopped (e.g. relocked) while this poll was in flight

    if (pendienteResult.kind === 'success' && pagadaResult.kind === 'success') {
      const orders = [...pendienteResult.data, ...pagadaResult.data];
      ctx.store.setState((s) => actions.pollSucceeded(s, { orders, seq, at: ctx.now() }));
      scheduleNext();
      return;
    }

    const failure = pickPollFailure(pendienteResult, pagadaResult);

    if (isRelock(failure)) {
      relock(ctx, 'rejected');
      return; // no reschedule
    }

    const kind = mapPollFailureKind(failure);
    ctx.store.setState((s) => actions.pollFailed(s, { kind, at: ctx.now() }));
    // The 60 s stale escalation has no timer of its own: it piggybacks on
    // this 10 s poll cadence.
    ctx.store.setState((s) => actions.staleCheck(s, { at: ctx.now() }));
    scheduleNext();
  }

  poll.pollOnce = pollOnce;
  pollOnce();
  return stop;
}

export function stopPolling(ctx) {
  if (ctx.__poll) {
    ctx.__poll.stop();
  }
}

export function pollNow(ctx) {
  const poll = ctx.__poll;
  if (!poll || !poll.running) return;
  if (poll.inFlight) return; // ignored; the in-flight poll will reschedule
  if (poll.timer !== null) {
    ctx.clearTimer(poll.timer);
    poll.timer = null;
  }
  poll.pollOnce();
}

// --- mark-Pagada (optimistic) --------------------------------------------

export function markPaid(ctx, orderId) {
  const state = ctx.store.getState();
  const order = state.queue.orders.find((o) => o.order_id === orderId);
  const table_number = order ? order.table_number : null;
  ctx.store.setState((s) =>
    actions.paymentQueued(s, { order: { order_id: orderId, table_number }, at: ctx.now() }),
  );
  if (ctx.__runner) {
    ctx.__runner.wake();
  }
}

export function startPaymentRunner(ctx) {
  if (ctx.__runner && ctx.__runner.running) {
    return { wake: ctx.__runner.wake, stop: ctx.__runner.stop };
  }

  const runner = { running: true, paused: false, timer: null, busy: false };
  ctx.__runner = runner;

  function clearPendingTimer() {
    if (runner.timer !== null) {
      ctx.clearTimer(runner.timer);
      runner.timer = null;
    }
  }

  function stop() {
    runner.running = false;
    clearPendingTimer();
  }

  function pause() {
    runner.paused = true;
    clearPendingTimer();
  }

  function wake() {
    if (!runner.running) return;
    runner.paused = false;
    clearPendingTimer();
    tick();
  }

  runner.stop = stop;
  runner.pause = pause;
  runner.wake = wake;

  async function tick() {
    if (!runner.running || runner.paused || runner.busy) return;
    // Defense in depth alongside the explicit `paused` flag set by
    // `relock`/`pause()`: the runner never processes entries while the app
    // is not unlocked, even if `wake()` is called while locked (e.g. by an
    // `online`/`visibilitychange` listener that does not itself know the
    // current auth state).
    if (ctx.store.getState().auth.status !== 'unlocked') return;

    const state = ctx.store.getState();
    const entry = nextDue(state.payment.pending, ctx.now());
    if (!entry) return; // idle until wake() or the entry's own retry timer

    runner.busy = true;
    const result = await ctx.api.markOrderPaid(entry.order_id);
    runner.busy = false;

    if (!runner.running) return;

    const confirmed = result.kind === 'success' || (result.kind === 'definitive' && result.code === 'NOT_FOUND');
    if (confirmed) {
      const nextSeq = peekNextPollSeq(ctx);
      ctx.store.setState((s) => actions.paymentConfirmed(s, { id: entry.order_id, seq: nextSeq }));
      tick(); // keep draining while entries are due
      return;
    }

    if (isRelock(result)) {
      relock(ctx, 'rejected'); // relock: entry stays pending, runner paused
      return;
    }

    const isContractBug = result.kind === 'definitive' && PAYMENT_CONTRACT_ERROR_CODES.has(result.code);
    if (isContractBug) {
      ctx.store.setState((s) => actions.paymentRestored(s, { id: entry.order_id }));
      tick();
      return;
    }

    // Transient-ish (LOCK_TIMEOUT, SHEET_UNAVAILABLE, INTERNAL_ERROR,
    // PIN_NOT_CONFIGURED) or ambiguous: keep hidden, retry with backoff.
    ctx.store.setState((s) => actions.paymentRetry(s, { id: entry.order_id, at: ctx.now() }));
    if (!runner.running || runner.paused) return;
    const updated = ctx.store
      .getState()
      .payment.pending.find((p) => p.order_id === entry.order_id);
    const delay = updated ? Math.max(0, updated.nextAttemptAt - ctx.now()) : 0;
    clearPendingTimer();
    runner.timer = ctx.setTimer(() => {
      runner.timer = null;
      tick();
    }, delay);
  }

  tick();
  return { wake, stop };
}

// --- manual lock ("Bloquear" button) -------------------------------------

export function lock(ctx) {
  relock(ctx, 'manual');
}

// --- day close ------------------------------------------------------------

/**
 * Orchestrates one `closeDay` request per explicit double-confirmation
 * (`caja-day-close-flow` "Double Confirmation Before the Close Executes"),
 * per design's "Day close (sequence)" diagram: dispatches the transition to
 * `close.running`, sends exactly one `closeDay` request carrying the
 * PIN re-entered in the close dialog (`pinValue`, NEVER `ctx.api`'s stored
 * session PIN — C12), then dispatches the classified result.
 *
 * Deliberately never auto-retried: a failure (including a wrong close PIN,
 * classified by `close.js`'s `classifyCloseResult` as `{status:'pin',
 * error:'wrong_pin'}`) only updates `close` sub-state. `UNAUTHORIZED` here
 * is dialog-only and does NOT call `relock`: the stored session PIN may
 * still be valid (the next poll or markPaid re-locks if it is not), per
 * design.md's `js/close.js` contract note and `caja-day-close-flow`'s
 * own "Reintentar" posture. "Reintentar" (K3, close-view) restarts the
 * full PIN + confirmation sequence by calling `runClose` again with a
 * freshly re-entered PIN — never by retrying this call automatically.
 *
 * @param {object} ctx
 * @param {string} pinValue the PIN re-entered in the close dialog.
 */
export async function runClose(ctx, pinValue) {
  ctx.store.setState((s) => actions.closeConfirmed(s));
  const result = await ctx.api.closeDay(pinValue);
  ctx.store.setState((s) => actions.closeResultReceived(s, { apiResult: result }));
}
