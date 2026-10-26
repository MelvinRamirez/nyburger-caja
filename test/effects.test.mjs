import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../js/store.js';
import { initialState, actions } from '../js/actions.js';
import { POLL_INTERVAL_MS } from '../js/config.js';
import {
  startPolling,
  pollNow,
  unlock,
  markPaid,
  startPaymentRunner,
  lock,
  relock,
  runClose,
} from '../js/effects.js';

// --- test helpers -----------------------------------------------------

function makeFakeTimers() {
  let nextId = 1;
  let now = 0;
  const pending = new Map();

  function setTimer(cb, ms) {
    const id = nextId++;
    pending.set(id, { cb, due: now + ms });
    return id;
  }
  function clearTimer(id) {
    pending.delete(id);
  }
  function advance(ms) {
    now += ms;
    for (;;) {
      let nextDue = null;
      for (const [id, entry] of pending) {
        if (entry.due <= now && (nextDue === null || entry.due < nextDue.due)) {
          nextDue = { id, ...entry };
        }
      }
      if (nextDue === null) break;
      pending.delete(nextDue.id);
      nextDue.cb();
    }
  }
  function getNow() {
    return now;
  }
  return { setTimer, clearTimer, advance, getNow, pending };
}

function makeMemoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, v),
    removeItem: (k) => map.delete(k),
  };
}

function makeCtx({ api, timers = makeFakeTimers(), pinStorage = makeMemoryStorage(), unlocked = true } = {}) {
  const store = createStore(initialState({ hasPin: unlocked }));
  const ctx = {
    store,
    api,
    pinStorage,
    now: timers.getNow,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    isVisible: () => true,
    isOnline: () => true,
  };
  return { ctx, store, timers };
}

function okOrders(orders) {
  return { kind: 'success', data: orders, meta: null };
}

function okClose(data) {
  return { kind: 'success', data, meta: null };
}

function unauthorized() {
  return { kind: 'definitive', code: 'UNAUTHORIZED', message: '', details: null };
}

function definitive(code, details = null) {
  return { kind: 'definitive', code, message: '', details };
}

// --- Task 11.1 RED test (polls never overlap) --------------------------
// Written before js/effects.js existed. Confirmed RED with
// `ERR_MODULE_NOT_FOUND: Cannot find module '.../js/effects.js'` running
// `node --test test/effects.test.mjs`. Now GREEN against the implementation.

test('11.1: polls never overlap; next poll is scheduled POLL_INTERVAL_MS after both concurrent calls settle', async () => {
  // Each poll tick now fires TWO concurrent getCajaOrders calls (Pendiente +
  // Pagada, `caja-order-prepay` scope item 2), so this counts raw
  // getCajaOrders invocations (2 per tick), not ticks.
  let getCajaOrdersCalls = 0;
  let resolvers = [];
  const api = {
    getCajaOrders: () => {
      getCajaOrdersCalls++;
      return new Promise((resolve) => {
        resolvers.push(resolve);
      });
    },
  };
  const { ctx, timers } = makeCtx({ api });

  const stop = startPolling(ctx);
  assert.equal(typeof stop, 'function');
  assert.equal(getCajaOrdersCalls, 2, 'first poll tick fires both concurrent getCajaOrders calls immediately');

  timers.advance(POLL_INTERVAL_MS * 3);
  assert.equal(getCajaOrdersCalls, 2, 'no overlapping poll tick while the first is in flight');

  resolvers.forEach((resolve) => resolve(okOrders([])));
  resolvers = [];
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(getCajaOrdersCalls, 2);

  timers.advance(POLL_INTERVAL_MS - 1);
  assert.equal(getCajaOrdersCalls, 2);

  timers.advance(1);
  assert.equal(getCajaOrdersCalls, 4, 'next tick (2 more calls) scheduled exactly POLL_INTERVAL_MS after settle');

  stop();
});

// --- caja-order-prepay T2: dual-fetch (Pendiente + Pagada) merged poll ---

test('dual-fetch poll: fetches both Pendiente and Pagada concurrently and merges the two arrays', async () => {
  const seen = [];
  const api = {
    getCajaOrders: (paymentStatus) => {
      seen.push(paymentStatus);
      if (paymentStatus === 'Pendiente') return Promise.resolve(okOrders([{ order_id: 'P1' }]));
      return Promise.resolve(okOrders([{ order_id: 'G1' }]));
    },
  };
  const { ctx, store } = makeCtx({ api });

  startPolling(ctx);
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  assert.deepStrictEqual(seen.sort(), ['Pagada', 'Pendiente'], 'both legs requested exactly once per tick');
  assert.deepStrictEqual(
    store.getState().queue.orders.map((o) => o.order_id),
    ['P1', 'G1'],
    'pollSucceeded receives the merged array (Pendiente first, then Pagada)',
  );
});

test('dual-fetch poll: a tick only succeeds if BOTH legs resolve kind:"success"', async () => {
  const api = {
    getCajaOrders: (paymentStatus) => {
      if (paymentStatus === 'Pendiente') return Promise.resolve(okOrders([{ order_id: 'P1' }]));
      return Promise.resolve(definitive('SHEET_UNAVAILABLE'));
    },
  };
  const { ctx, store } = makeCtx({ api });

  startPolling(ctx);
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(store.getState().sync.status, 'retrying', 'one failing leg fails the whole tick');
  assert.equal(store.getState().queue.orders.length, 0, 'queue is not updated from the half-succeeded tick');
});

test('dual-fetch poll failure tie-break: UNAUTHORIZED on either leg relocks even if the other leg is a contract error', async () => {
  const api = {
    getCajaOrders: (paymentStatus) => {
      if (paymentStatus === 'Pendiente') return Promise.resolve(unauthorized());
      return Promise.resolve(definitive('VALIDATION_ERROR'));
    },
  };
  const { ctx, store } = makeCtx({ api, pinStorage: makeMemoryStorage() });
  ctx.pinStorage.setItem('foodc.caja.pin', '123456');

  startPolling(ctx);
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(store.getState().auth.status, 'locked', 'UNAUTHORIZED outranks the other leg\'s contract error');
  assert.equal(ctx.pinStorage.getItem('foodc.caja.pin'), null);
});

test('dual-fetch poll failure tie-break: a contract-bug code on either leg outranks a transient/ambiguous failure on the other', async () => {
  const api = {
    getCajaOrders: (paymentStatus) => {
      if (paymentStatus === 'Pendiente') return Promise.resolve({ kind: 'ambiguous', reason: 'network' });
      return Promise.resolve(definitive('UNKNOWN_ACTION'));
    },
  };
  const { ctx, store } = makeCtx({ api });

  startPolling(ctx);
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(store.getState().sync.status, 'contract', 'the more specific contract-bug code is reported');
});

test('polling stops entirely while locked', async () => {
  let getCajaOrdersCalls = 0;
  const api = { getCajaOrders: () => { getCajaOrdersCalls++; return Promise.resolve(okOrders([])); } };
  const { ctx } = makeCtx({ api, unlocked: false });

  startPolling(ctx);
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(getCajaOrdersCalls, 0, 'no Caja listing request sent while locked');
});

// --- Task 11.2 RED test (UNAUTHORIZED relock) ---------------------------
// Written before relock existed in js/effects.js. Confirmed RED with the
// same ERR_MODULE_NOT_FOUND. Now GREEN.

test('11.2: UNAUTHORIZED from a poll clears the PIN, stops the poller, keeps queue/pending, resumes after unlock', async () => {
  let getCajaOrdersCalls = 0;
  let nextResult = unauthorized();
  const api = {
    getCajaOrders: () => {
      getCajaOrdersCalls++;
      return Promise.resolve(nextResult);
    },
    verifyCajaPin: () => Promise.resolve({ kind: 'success', data: { valid: true }, meta: null }),
  };
  const { ctx, store, timers } = makeCtx({ api, pinStorage: makeMemoryStorage() });

  store.setState((s) => actions.pollSucceeded(s, { orders: [{ order_id: 'Q1' }], seq: 1, at: 0 }));
  store.setState((s) =>
    actions.paymentQueued(s, { order: { order_id: 'P1', table_number: '7' }, at: 0 }),
  );
  const queueBefore = store.getState().queue;
  const pendingBefore = store.getState().payment.pending;

  ctx.pinStorage.setItem('foodc.caja.pin', '123456');

  startPolling(ctx);

  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(store.getState().auth.status, 'locked');
  assert.equal(store.getState().auth.error, 'rejected');
  assert.strictEqual(store.getState().queue, queueBefore, 'queue.orders untouched by relock');
  assert.strictEqual(store.getState().payment.pending, pendingBefore, 'payment.pending untouched by relock');
  assert.equal(ctx.pinStorage.getItem('foodc.caja.pin'), null, 'stored PIN cleared');

  const callsAtRelock = getCajaOrdersCalls;
  timers.advance(POLL_INTERVAL_MS * 5);
  assert.equal(getCajaOrdersCalls, callsAtRelock, 'poller does not reschedule after UNAUTHORIZED');

  let markPaidCalls = 0;
  api.markOrderPaid = () => {
    markPaidCalls++;
    return Promise.resolve({ kind: 'success', data: { order_id: 'P1' }, meta: null });
  };
  const runner = startPaymentRunner(ctx);
  await Promise.resolve();
  assert.equal(markPaidCalls, 0, 'runner does not process entries while locked');
  runner.wake();
  await Promise.resolve();
  assert.equal(markPaidCalls, 0, 'runner stays paused after relock even when woken');

  nextResult = okOrders([{ order_id: 'Q1' }]);
  await unlock(ctx, '654321');
  assert.equal(store.getState().auth.status, 'unlocked');

  await Promise.resolve();
  await Promise.resolve();
  assert.ok(getCajaOrdersCalls > callsAtRelock, 'poller resumes after a successful unlock');

  runner.wake();
  await Promise.resolve();
  await Promise.resolve();
  assert.ok(markPaidCalls > 0, 'payment runner resumes processing pending entries after unlock');

  runner.stop();
});

test('11.2b: UNAUTHORIZED from a markPaid attempt relocks, keeps the entry pending, and pauses the runner', async () => {
  let markPaidCalls = 0;
  const api = {
    getCajaOrders: () => Promise.resolve(okOrders([])),
    markOrderPaid: () => {
      markPaidCalls++;
      return Promise.resolve(unauthorized());
    },
  };
  const { ctx, store } = makeCtx({ api, pinStorage: makeMemoryStorage() });
  ctx.pinStorage.setItem('foodc.caja.pin', '123456');

  store.setState((s) =>
    actions.paymentQueued(s, { order: { order_id: 'C1', table_number: '3' }, at: 0 }),
  );
  const pendingBefore = store.getState().payment.pending;

  const runner = startPaymentRunner(ctx);
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(markPaidCalls, 1);
  assert.equal(store.getState().auth.status, 'locked');
  assert.equal(store.getState().auth.error, 'rejected');
  assert.strictEqual(store.getState().payment.pending, pendingBefore, 'pending entry kept, not confirmed/retried');
  assert.equal(ctx.pinStorage.getItem('foodc.caja.pin'), null);

  runner.wake();
  await Promise.resolve();
  assert.equal(markPaidCalls, 1, 'runner paused: no further markPaid attempts while locked');

  runner.stop();
});

test('lock(ctx): manual lock clears PIN and relocks with reason', async () => {
  const api = { getCajaOrders: () => Promise.resolve(okOrders([])) };
  const { ctx, store } = makeCtx({ api, pinStorage: makeMemoryStorage() });
  ctx.pinStorage.setItem('foodc.caja.pin', '123456');
  startPolling(ctx);
  await Promise.resolve();

  lock(ctx);

  assert.equal(store.getState().auth.status, 'locked');
  assert.equal(store.getState().auth.error, 'manual');
  assert.equal(ctx.pinStorage.getItem('foodc.caja.pin'), null);
});

test('relock(ctx, reason) is directly callable and uses the given reason', async () => {
  const api = { getCajaOrders: () => Promise.resolve(okOrders([])) };
  const { ctx, store } = makeCtx({ api, pinStorage: makeMemoryStorage() });
  ctx.pinStorage.setItem('foodc.caja.pin', '123456');

  relock(ctx, 'custom-reason');

  assert.equal(store.getState().auth.status, 'locked');
  assert.equal(store.getState().auth.error, 'custom-reason');
  assert.equal(ctx.pinStorage.getItem('foodc.caja.pin'), null);
});

// --- Task 11.3 RED test (runClose: exactly one request, never auto-retried;
// wrong close PIN does NOT re-lock the queue screen) ---------------------
// Written before runClose existed in js/effects.js. Confirmed RED with the
// same ERR_MODULE_NOT_FOUND. Now GREEN.

test('11.3: runClose sends exactly one closeDay request per confirmation and is never auto-retried', async () => {
  let closeDayCalls = 0;
  const api = {
    closeDay: (pin) => {
      closeDayCalls++;
      return Promise.resolve(okClose({ date: '2026-10-16', archived_count: 5, total_amount: 1230, file_id: 'f1' }));
    },
  };
  const { ctx, store } = makeCtx({ api });
  store.setState((s) => actions.closeOpened(s));
  store.setState((s) => actions.closePinEntered(s, { pin: '123456' }));

  await runClose(ctx, '123456');

  assert.equal(closeDayCalls, 1, 'exactly one closeDay request sent');
  assert.equal(store.getState().close.status, 'done');

  // Advancing time or awaiting further microtasks must never trigger a
  // second request: runClose does not schedule any retry of its own.
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(closeDayCalls, 1, 'never auto-retried');
});

test('11.3: runClose sends the dialog-entered pin argument, never a stored session PIN', async () => {
  let sentPin = null;
  const api = {
    closeDay: (pin) => {
      sentPin = pin;
      return Promise.resolve(okClose({ date: '2026-10-16', archived_count: 0, total_amount: 0, file_id: 'f1' }));
    },
  };
  const { ctx } = makeCtx({ api, pinStorage: makeMemoryStorage() });
  // The stored session PIN (used by polling/markPaid) is deliberately
  // different from the PIN re-entered in the close dialog.
  ctx.pinStorage.setItem('foodc.caja.pin', '999999');

  await runClose(ctx, '111111');

  assert.equal(sentPin, '111111', 'closeDay receives the dialog-entered pin, not the stored session PIN');
});

test('11.3: a wrong close PIN (UNAUTHORIZED on closeDay) does not re-lock the queue screen', async () => {
  const api = {
    getCajaOrders: () => Promise.resolve(okOrders([{ order_id: 'Q1' }])),
    closeDay: () => Promise.resolve(unauthorized()),
  };
  const { ctx, store } = makeCtx({ api, pinStorage: makeMemoryStorage() });
  ctx.pinStorage.setItem('foodc.caja.pin', '123456');
  startPolling(ctx);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(store.getState().auth.status, 'unlocked', 'precondition: screen unlocked from a valid stored PIN');

  await runClose(ctx, '000000');

  assert.equal(store.getState().close.status, 'pin', 'dialog-only: close flow returns to its PIN step');
  assert.equal(store.getState().close.error, 'wrong_pin');
  assert.equal(
    store.getState().auth.status,
    'unlocked',
    'the stored session PIN may still be valid: the global screen is not re-locked by a wrong close PIN',
  );
  assert.notEqual(ctx.pinStorage.getItem('foodc.caja.pin'), null, 'stored PIN is not cleared by this path');
});

// --- Task 11.5: Mark-Pagada Recovery Policy table, exercised end-to-end
// through effects -----------------------------------------------------

test('markPaid: tapping optimistically hides the card and sends the request', async () => {
  let markPaidCalls = 0;
  let resolveSlow;
  const api = {
    markOrderPaid: () => {
      markPaidCalls++;
      return new Promise((resolve) => {
        resolveSlow = resolve;
      });
    },
  };
  const { ctx, store } = makeCtx({ api });
  store.setState((s) =>
    actions.pollSucceeded(s, { orders: [{ order_id: 'ORD-1234', table_number: '03' }], seq: 1, at: 0 }),
  );

  markPaid(ctx, 'ORD-1234');

  assert.ok(
    store.getState().payment.pending.some((p) => p.order_id === 'ORD-1234'),
    'order added to the pending-Pagada set immediately',
  );

  const runner = startPaymentRunner(ctx);
  await Promise.resolve();
  assert.equal(markPaidCalls, 1, 'mark-Pagada request sent');
  resolveSlow({ kind: 'success', data: { order_id: 'ORD-1234' }, meta: null });
  await Promise.resolve();
  await Promise.resolve();
  runner.stop();
});

test('markPaid recovery policy: success confirms with the tombstone seq (next poll purges it)', async () => {
  const api = {
    getCajaOrders: () => Promise.resolve(okOrders([{ order_id: 'A' }])),
    markOrderPaid: () => Promise.resolve({ kind: 'success', data: { order_id: 'A' }, meta: null }),
  };
  const { ctx, store, timers } = makeCtx({ api });

  store.setState((s) => actions.pollSucceeded(s, { orders: [{ order_id: 'A' }], seq: 1, at: 0 }));
  markPaid(ctx, 'A');
  const runner = startPaymentRunner(ctx);

  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  const entry = store.getState().payment.pending.find((p) => p.order_id === 'A');
  assert.notEqual(entry.confirmedAtSeq, null);

  runner.stop();
  timers.advance(0);
});

test('markPaid recovery policy: NOT_FOUND is treated as confirmed (no retry)', async () => {
  const api = {
    markOrderPaid: () => Promise.resolve(definitive('NOT_FOUND')),
  };
  const { ctx, store } = makeCtx({ api });
  markPaid(ctx, 'A');
  const runner = startPaymentRunner(ctx);
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  const entry = store.getState().payment.pending.find((p) => p.order_id === 'A');
  assert.notEqual(entry.confirmedAtSeq, null);
  runner.stop();
});

test('markPaid recovery policy: INVALID_TRANSITION restores the card and raises a notice', async () => {
  const api = {
    markOrderPaid: () => Promise.resolve(definitive('INVALID_TRANSITION')),
  };
  const { ctx, store } = makeCtx({ api });
  markPaid(ctx, 'A');
  const runner = startPaymentRunner(ctx);
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(store.getState().payment.pending.length, 0, 'entry removed and card restored');
  assert.ok(store.getState().notice, 'visible error/notice raised');
  runner.stop();
});

test('markPaid recovery policy: transient codes (LOCK_TIMEOUT, SHEET_UNAVAILABLE, INTERNAL_ERROR, PIN_NOT_CONFIGURED) retry with backoff', async () => {
  for (const code of ['LOCK_TIMEOUT', 'SHEET_UNAVAILABLE', 'INTERNAL_ERROR', 'PIN_NOT_CONFIGURED']) {
    const api = { markOrderPaid: () => Promise.resolve(definitive(code)) };
    const { ctx, store } = makeCtx({ api });
    markPaid(ctx, 'A');
    const runner = startPaymentRunner(ctx);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const entry = store.getState().payment.pending.find((p) => p.order_id === 'A');
    assert.equal(entry.confirmedAtSeq, null, `${code}: still pending`);
    assert.equal(entry.attempts, 1, `${code}: attempts bumped`);
    runner.stop();
  }
});

test('markPaid recovery policy: ambiguous network failure retries because the action is idempotent', async () => {
  const api = { markOrderPaid: () => Promise.resolve({ kind: 'ambiguous', reason: 'network' }) };
  const { ctx, store } = makeCtx({ api });
  markPaid(ctx, 'A');
  const runner = startPaymentRunner(ctx);
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  const entry = store.getState().payment.pending.find((p) => p.order_id === 'A');
  assert.equal(entry.confirmedAtSeq, null);
  assert.equal(entry.attempts, 1);
  runner.stop();
});

test('markPaid recovery policy: VALIDATION_ERROR/INVALID_JSON/UNKNOWN_ACTION restore the card and raise a notice', async () => {
  for (const code of ['VALIDATION_ERROR', 'INVALID_JSON', 'UNKNOWN_ACTION']) {
    const api = { markOrderPaid: () => Promise.resolve(definitive(code)) };
    const { ctx, store } = makeCtx({ api });
    markPaid(ctx, 'A');
    const runner = startPaymentRunner(ctx);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(store.getState().payment.pending.length, 0, `${code}: entry removed`);
    assert.ok(store.getState().notice, `${code}: notice raised`);
    runner.stop();
  }
});

test('markPaid recovery policy: UNAUTHORIZED keeps the entry pending, stops retries, and relocks', async () => {
  const api = { markOrderPaid: () => Promise.resolve(unauthorized()) };
  const { ctx, store } = makeCtx({ api, pinStorage: makeMemoryStorage() });
  ctx.pinStorage.setItem('foodc.caja.pin', '123456');
  markPaid(ctx, 'A');
  const runner = startPaymentRunner(ctx);
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  const entry = store.getState().payment.pending.find((p) => p.order_id === 'A');
  assert.notEqual(entry, undefined, 'entry stays in the pending set');
  assert.equal(entry.confirmedAtSeq, null);
  assert.equal(store.getState().auth.status, 'locked');
  assert.equal(ctx.pinStorage.getItem('foodc.caja.pin'), null);
  runner.stop();
});

test('payment runner processes entries serially, oldest tap first', async () => {
  const callOrder = [];
  const api = {
    markOrderPaid: (id) => {
      callOrder.push(id);
      return Promise.resolve({ kind: 'success', data: { order_id: id }, meta: null });
    },
  };
  const { ctx } = makeCtx({ api });
  markPaid(ctx, 'A');
  markPaid(ctx, 'B');
  const runner = startPaymentRunner(ctx);
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  assert.deepStrictEqual(callOrder, ['A', 'B']);
  runner.stop();
});

// --- pending-markPaid race through effects (payment.js + actions.js + effects.js) ---

test('a poll started before a mark-Pagada confirms does not let the order reappear', async () => {
  // Only the Pendiente leg of the first tick hangs; the Pagada leg (and
  // every later Pendiente call) resolves immediately with no orders, so the
  // dual-fetch merge still reduces to the single-leg race this test exists
  // to cover.
  let resolvePendiente;
  let pendienteCallCount = 0;
  const api = {
    getCajaOrders: (paymentStatus) => {
      if (paymentStatus !== 'Pendiente') return Promise.resolve(okOrders([]));
      pendienteCallCount++;
      if (pendienteCallCount === 1) {
        return new Promise((resolve) => {
          resolvePendiente = resolve;
        });
      }
      return Promise.resolve(okOrders([]));
    },
    markOrderPaid: () => Promise.resolve({ kind: 'success', data: { order_id: 'A' }, meta: null }),
  };
  const { ctx, store, timers } = makeCtx({ api });

  store.setState((s) => actions.pollSucceeded(s, { orders: [{ order_id: 'A' }], seq: 0, at: 0 }));

  startPolling(ctx);
  assert.equal(pendienteCallCount, 1, 'first poll tick fires the Pendiente leg immediately');

  markPaid(ctx, 'A');
  const runner = startPaymentRunner(ctx);
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  const confirmedEntry = store.getState().payment.pending.find((p) => p.order_id === 'A');
  assert.notEqual(confirmedEntry.confirmedAtSeq, null);

  resolvePendiente(okOrders([{ order_id: 'A' }]));
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  assert.ok(
    store.getState().payment.pending.some((p) => p.order_id === 'A'),
    'tombstone not purged yet by the stale poll',
  );

  timers.advance(POLL_INTERVAL_MS);
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  assert.ok(
    !store.getState().payment.pending.some((p) => p.order_id === 'A'),
    'tombstone purged by a poll started at/after the confirmation seq',
  );

  runner.stop();
});

// --- A2-equivalent sync-state table, triggered through real polling ----

test('sync: poll success -> ok; transient definitive/ambiguous -> retrying -> stale after 60s', async () => {
  let result = definitive('SHEET_UNAVAILABLE');
  const api = { getCajaOrders: () => Promise.resolve(result) };
  const { ctx, store, timers } = makeCtx({ api });

  startPolling(ctx);
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(store.getState().sync.status, 'retrying');

  for (let i = 0; i < 10; i++) {
    timers.advance(POLL_INTERVAL_MS);
    await Promise.resolve();
    await Promise.resolve();
  }
  assert.equal(store.getState().sync.status, 'stale');
});

test('sync: poll PIN_NOT_CONFIGURED -> sync.not_configured', async () => {
  const api = { getCajaOrders: () => Promise.resolve(definitive('PIN_NOT_CONFIGURED')) };
  const { ctx, store } = makeCtx({ api });
  startPolling(ctx);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(store.getState().sync.status, 'not_configured');
});

test('sync: poll UNKNOWN_ACTION/INVALID_JSON/VALIDATION_ERROR -> sync.contract', async () => {
  for (const code of ['UNKNOWN_ACTION', 'INVALID_JSON', 'VALIDATION_ERROR']) {
    const api = { getCajaOrders: () => Promise.resolve(definitive(code)) };
    const { ctx, store } = makeCtx({ api });
    startPolling(ctx);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(store.getState().sync.status, 'contract', code);
  }
});

// --- online / visibilitychange triggers (pollNow, wired to those browser
// events by main.js in K3) ------------------------------------------------

test('pollNow: fires an immediate poll bypassing the scheduled timer, only if none is in flight', async () => {
  // 2 getCajaOrders calls per tick (Pendiente + Pagada).
  let getCajaOrdersCalls = 0;
  const api = { getCajaOrders: () => { getCajaOrdersCalls++; return Promise.resolve(okOrders([])); } };
  const { ctx, timers } = makeCtx({ api });

  startPolling(ctx);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(getCajaOrdersCalls, 2);

  pollNow(ctx);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(getCajaOrdersCalls, 4, 'pollNow triggers an immediate poll tick');

  timers.advance(POLL_INTERVAL_MS);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(getCajaOrdersCalls, 6, 'the scheduled timer from the pollNow-triggered tick still fires once');
});

test('pollNow: ignored while a poll is already in flight', async () => {
  let getCajaOrdersCalls = 0;
  let resolvers = [];
  const api = {
    getCajaOrders: () => {
      getCajaOrdersCalls++;
      return new Promise((resolve) => {
        resolvers.push(resolve);
      });
    },
  };
  const { ctx } = makeCtx({ api });

  startPolling(ctx);
  assert.equal(getCajaOrdersCalls, 2, 'first tick fires both concurrent calls immediately');

  pollNow(ctx);
  assert.equal(getCajaOrdersCalls, 2, 'pollNow ignored while in flight');

  resolvers.forEach((resolve) => resolve(okOrders([])));
  await Promise.resolve();
  await Promise.resolve();
});

test('pollNow: no-op while locked (no poller running)', async () => {
  const api = { getCajaOrders: () => Promise.resolve(okOrders([])) };
  const { ctx } = makeCtx({ api, unlocked: false });
  // Should not throw even though no poller has ever started.
  pollNow(ctx);
});

// --- unlock -------------------------------------------------------------

test('unlock: success stores the PIN, unlocks, and starts polling', async () => {
  let getCajaOrdersCalls = 0;
  const api = {
    verifyCajaPin: () => Promise.resolve({ kind: 'success', data: { valid: true }, meta: null }),
    getCajaOrders: () => { getCajaOrdersCalls++; return Promise.resolve(okOrders([])); },
  };
  const { ctx, store } = makeCtx({ api, pinStorage: makeMemoryStorage(), unlocked: false });

  await unlock(ctx, '123456');

  assert.equal(store.getState().auth.status, 'unlocked');
  assert.equal(ctx.pinStorage.getItem('foodc.caja.pin'), '123456');
  await Promise.resolve();
  assert.equal(getCajaOrdersCalls, 2, 'polling starts after a successful unlock (Pendiente + Pagada)');
});

test('unlock: UNAUTHORIZED shows wrong_pin and does not store a PIN', async () => {
  const api = { verifyCajaPin: () => Promise.resolve(unauthorized()) };
  const { ctx, store } = makeCtx({ api, pinStorage: makeMemoryStorage(), unlocked: false });

  await unlock(ctx, '000000');

  assert.equal(store.getState().auth.status, 'locked');
  assert.equal(store.getState().auth.error, 'wrong_pin');
  assert.equal(ctx.pinStorage.getItem('foodc.caja.pin'), null);
});

test('unlock: ambiguous failure shows offline, retryable', async () => {
  const api = { verifyCajaPin: () => Promise.resolve({ kind: 'ambiguous', reason: 'network' }) };
  const { ctx, store } = makeCtx({ api, pinStorage: makeMemoryStorage(), unlocked: false });

  await unlock(ctx, '123456');

  assert.equal(store.getState().auth.status, 'locked');
  assert.equal(store.getState().auth.error, 'offline');
});
