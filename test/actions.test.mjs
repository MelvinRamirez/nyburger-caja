import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialState, actions } from '../js/actions.js';
import { IDLE_CLOSE } from '../js/close.js';

// --- initialState ---

test('initialState: locked / idle sync when no persisted pin', () => {
  const s = initialState();
  assert.deepStrictEqual(s.auth, { status: 'locked', error: null });
  assert.deepStrictEqual(s.sync, { status: 'idle', failingSince: null });
  assert.deepStrictEqual(s.queue, { orders: [], lastSyncAt: null, pollSeq: 0 });
  assert.deepStrictEqual(s.payment, { pending: [] });
  assert.deepStrictEqual(s.close, IDLE_CLOSE);
  assert.equal(s.notice, null);
});

test('initialState: unlocked / connecting sync when hasPin is true', () => {
  const s = initialState({ hasPin: true });
  assert.deepStrictEqual(s.auth, { status: 'unlocked', error: null });
  assert.deepStrictEqual(s.sync, { status: 'connecting', failingSince: null });
});

test('initialState: carries hydrated pending payments', () => {
  const pending = [{ order_id: 'A' }];
  const s = initialState({ pending });
  assert.strictEqual(s.payment.pending, pending);
});

// --- unlock lifecycle ---

test('unlockStarted: moves auth to verifying, clears error', () => {
  const s = actions.unlockStarted(initialState());
  assert.deepStrictEqual(s.auth, { status: 'verifying', error: null });
});

test('unlockSucceeded: unlocks and resets sync to connecting', () => {
  let s = initialState();
  s = actions.unlockStarted(s);
  s = actions.unlockSucceeded(s);
  assert.deepStrictEqual(s.auth, { status: 'unlocked', error: null });
  assert.deepStrictEqual(s.sync, { status: 'connecting', failingSince: null });
});

test('unlockFailed: stays locked with the given error', () => {
  const s = actions.unlockFailed(initialState(), { error: 'wrong_pin' });
  assert.deepStrictEqual(s.auth, { status: 'locked', error: 'wrong_pin' });
});

// --- relock: queue and pending payments untouched ---

test('relock: locks auth with the reason, leaving queue and pending payments untouched', () => {
  let s = initialState({ hasPin: true });
  s = actions.pollSucceeded(s, { orders: [{ order_id: 'A' }], seq: 1, at: 1000 });
  s = actions.paymentQueued(s, { order: { order_id: 'B', table_number: '05' }, at: 1000 });
  const before = { queue: s.queue, payment: s.payment };

  const relocked = actions.relock(s, { reason: 'rejected' });

  assert.deepStrictEqual(relocked.auth, { status: 'locked', error: 'rejected' });
  assert.strictEqual(relocked.queue, before.queue);
  assert.strictEqual(relocked.payment, before.payment);
});

// --- pollSucceeded ---

test('pollSucceeded: updates queue, sets sync ok, resets failingSince, purges tombstones', () => {
  let s = initialState({ hasPin: true });
  s = actions.paymentQueued(s, { order: { order_id: 'A', table_number: '05' }, at: 100 });
  s = actions.paymentConfirmed(s, { id: 'A', seq: 5 });
  s = actions.pollFailed(s, { kind: 'transient', at: 200 }); // simulate a prior failing streak

  const orders = [{ order_id: 'B' }];
  s = actions.pollSucceeded(s, { orders, seq: 5, at: 300 });

  assert.deepStrictEqual(s.queue, { orders, lastSyncAt: 300, pollSeq: 5 });
  assert.deepStrictEqual(s.sync, { status: 'ok', failingSince: null });
  assert.deepStrictEqual(s.payment.pending, []); // purged: startedSeq(5) >= confirmedAtSeq(5)
});

test('pollSucceeded: the "empty queue, sync ok" state is only reachable via pollSucceeded', () => {
  let s = initialState({ hasPin: true });
  s = actions.pollFailed(s, { kind: 'transient', at: 100 });
  assert.notEqual(s.sync.status, 'ok');
  s = actions.staleCheck(s, { at: 100 });
  assert.notEqual(s.sync.status, 'ok');

  s = actions.pollSucceeded(s, { orders: [], seq: 1, at: 200 });
  assert.equal(s.sync.status, 'ok');
  assert.deepStrictEqual(s.queue.orders, []);
});

// --- pollFailed / staleCheck ---

test('pollFailed: transient maps to retrying and sets failingSince once', () => {
  let s = initialState({ hasPin: true });
  s = actions.pollFailed(s, { kind: 'transient', at: 1000 });
  assert.deepStrictEqual(s.sync, { status: 'retrying', failingSince: 1000 });

  // A second consecutive failure does not move failingSince forward.
  s = actions.pollFailed(s, { kind: 'transient', at: 2000 });
  assert.deepStrictEqual(s.sync, { status: 'retrying', failingSince: 1000 });
});

test('pollFailed: contract and not_configured pass through as distinct statuses', () => {
  let s = initialState({ hasPin: true });
  const contractState = actions.pollFailed(s, { kind: 'contract', at: 1000 });
  assert.deepStrictEqual(contractState.sync, { status: 'contract', failingSince: 1000 });

  const notConfiguredState = actions.pollFailed(s, { kind: 'not_configured', at: 1000 });
  assert.deepStrictEqual(notConfiguredState.sync, { status: 'not_configured', failingSince: 1000 });
});

test('staleCheck: no-op (same reference) below the 60 s boundary', () => {
  let s = initialState({ hasPin: true });
  s = actions.pollFailed(s, { kind: 'transient', at: 1000 });
  const result = actions.staleCheck(s, { at: 1000 + 59999 });
  assert.strictEqual(result, s);
  assert.equal(result.sync.status, 'retrying');
});

test('staleCheck: escalates to stale exactly at the 60 s (STALE_ALERT_MS) boundary', () => {
  let s = initialState({ hasPin: true });
  s = actions.pollFailed(s, { kind: 'transient', at: 1000 });
  const result = actions.staleCheck(s, { at: 1000 + 60000 });
  assert.deepStrictEqual(result.sync, { status: 'stale', failingSince: 1000 });
});

test('staleCheck: no-op when sync.status is not retrying', () => {
  let s = initialState({ hasPin: true }); // sync.status === 'connecting'
  const result = actions.staleCheck(s, { at: 999999 });
  assert.strictEqual(result, s);
});

test('retrying -> ok recovery clears failingSince', () => {
  let s = initialState({ hasPin: true });
  s = actions.pollFailed(s, { kind: 'transient', at: 1000 });
  s = actions.pollSucceeded(s, { orders: [], seq: 1, at: 2000 });
  assert.deepStrictEqual(s.sync, { status: 'ok', failingSince: null });
});

test('stale -> ok recovery clears failingSince', () => {
  let s = initialState({ hasPin: true });
  s = actions.pollFailed(s, { kind: 'transient', at: 1000 });
  s = actions.staleCheck(s, { at: 1000 + 60000 });
  assert.equal(s.sync.status, 'stale');
  s = actions.pollSucceeded(s, { orders: [], seq: 1, at: 70000 });
  assert.deepStrictEqual(s.sync, { status: 'ok', failingSince: null });
});

// --- payment reducers ---

test('paymentQueued: enqueues via payment.enqueue', () => {
  const s = actions.paymentQueued(initialState(), { order: { order_id: 'A', table_number: '05' }, at: 1000 });
  assert.equal(s.payment.pending.length, 1);
  assert.equal(s.payment.pending[0].order_id, 'A');
});

test('paymentConfirmed: tombstones the matching entry', () => {
  let s = actions.paymentQueued(initialState(), { order: { order_id: 'A', table_number: '05' }, at: 1000 });
  s = actions.paymentConfirmed(s, { id: 'A', seq: 9 });
  assert.equal(s.payment.pending[0].confirmedAtSeq, 9);
});

test('paymentRetry: bumps attempts and reschedules', () => {
  let s = actions.paymentQueued(initialState(), { order: { order_id: 'A', table_number: '05' }, at: 1000 });
  s = actions.paymentRetry(s, { id: 'A', at: 5000 });
  assert.equal(s.payment.pending[0].attempts, 1);
  assert.equal(s.payment.pending[0].nextAttemptAt, 5000 + 2000);
});

test('paymentRestored: removes the entry and raises a restored notice with its table_number', () => {
  let s = actions.paymentQueued(initialState(), { order: { order_id: 'A', table_number: '12' }, at: 1000 });
  s = actions.paymentRestored(s, { id: 'A' });
  assert.equal(s.payment.pending.length, 0);
  assert.deepStrictEqual(s.notice, { kind: 'restored', table_number: '12' });
});

// --- dismissNotice ---

test('dismissNotice: clears the notice', () => {
  let s = actions.paymentQueued(initialState(), { order: { order_id: 'A', table_number: '12' }, at: 1000 });
  s = actions.paymentRestored(s, { id: 'A' });
  s = actions.dismissNotice(s);
  assert.equal(s.notice, null);
});

test('dismissNotice: no-op (same reference) when there is no notice', () => {
  const s = initialState();
  assert.strictEqual(actions.dismissNotice(s), s);
});

// --- close-dialog state machine, wired through closeActions ---

test('closeOpened: moves close.status to pin', () => {
  const s = actions.closeOpened(initialState({ hasPin: true }));
  assert.equal(s.close.status, 'pin');
});

test('closePinEntered -> closeConfirmed: moves through confirm to running, carrying the pin', () => {
  let s = actions.closeOpened(initialState({ hasPin: true }));
  s = actions.closePinEntered(s, { pin: '123456' });
  assert.equal(s.close.status, 'confirm');
  s = actions.closeConfirmed(s);
  assert.equal(s.close.status, 'running');
  assert.equal(s.close.pin, '123456');
});

test('closeCancelled: resets close to idle, dropping the entered pin', () => {
  let s = actions.closeOpened(initialState({ hasPin: true }));
  s = actions.closePinEntered(s, { pin: '123456' });
  s = actions.closeCancelled(s);
  assert.equal(s.close.status, 'idle');
  assert.equal(s.close.pin, null);
});

test('closeResultReceived: classifies the apiResult into close.status', () => {
  let s = actions.closeConfirmed(actions.closePinEntered(actions.closeOpened(initialState({ hasPin: true })), { pin: '123456' }));
  s = actions.closeResultReceived(s, {
    apiResult: { kind: 'success', data: { date: '2026-10-15', archived_count: 2, total_amount: 500 }, meta: null },
  });
  assert.equal(s.close.status, 'done');
  assert.equal(s.close.summary.archived_count, 2);
});

test('closeResultReceived: leaves auth, queue and payment untouched (dialog-only state)', () => {
  let s = initialState({ hasPin: true });
  s = actions.pollSucceeded(s, { orders: [{ order_id: 'A' }], seq: 1, at: 100 });
  const before = { auth: s.auth, queue: s.queue, payment: s.payment };

  s = actions.closeOpened(s);
  s = actions.closePinEntered(s, { pin: '123456' });
  s = actions.closeConfirmed(s);
  s = actions.closeResultReceived(s, { apiResult: { kind: 'definitive', code: 'UNAUTHORIZED', message: '', details: null } });

  assert.strictEqual(s.auth, before.auth);
  assert.strictEqual(s.queue, before.queue);
  assert.strictEqual(s.payment, before.payment);
  assert.equal(s.close.status, 'pin'); // UNAUTHORIZED classifies to dialog-only 'pin'
});

test('closeReset: returns close to idle after a terminal result', () => {
  let s = actions.closeConfirmed(actions.closePinEntered(actions.closeOpened(initialState({ hasPin: true })), { pin: '123456' }));
  s = actions.closeResultReceived(s, { apiResult: { kind: 'definitive', code: 'LOCK_TIMEOUT', message: '', details: null } });
  s = actions.closeReset(s);
  assert.equal(s.close.status, 'idle');
  assert.equal(s.close.pin, null);
});
