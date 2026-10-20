import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  enqueue,
  nextDue,
  markRetry,
  markConfirmed,
  purgeAfterPoll,
  restore,
  dropExpired,
  backoffMs,
} from '../js/payment.js';

function order(overrides = {}) {
  return { order_id: 'ORD-1', table_number: '05', ...overrides };
}

// --- enqueue ---

test('enqueue: adds a new entry with the expected initial shape', () => {
  const pending = enqueue([], order(), 1000);
  assert.deepStrictEqual(pending, [
    { order_id: 'ORD-1', table_number: '05', tappedAt: 1000, attempts: 0, nextAttemptAt: 1000, confirmedAtSeq: null },
  ]);
});

test('enqueue: is idempotent for an already-present order_id, returning the SAME array reference', () => {
  const first = enqueue([], order(), 1000);
  const second = enqueue(first, order({ table_number: 'different' }), 2000);
  assert.strictEqual(second, first);
  assert.equal(first.length, 1);
});

// --- nextDue ---

test('nextDue: returns null when nothing is due', () => {
  const pending = enqueue([], order(), 1000);
  assert.equal(nextDue(pending, 500), null);
});

test('nextDue: returns the oldest (by tappedAt) unconfirmed due entry', () => {
  let pending = enqueue([], order({ order_id: 'A' }), 2000);
  pending = enqueue(pending, order({ order_id: 'B' }), 1000);
  pending = enqueue(pending, order({ order_id: 'C' }), 3000);
  const due = nextDue(pending, 5000);
  assert.equal(due.order_id, 'B');
});

test('nextDue: skips confirmed (tombstoned) entries even if due', () => {
  let pending = enqueue([], order({ order_id: 'A' }), 1000);
  pending = markConfirmed(pending, 'A', 10);
  assert.equal(nextDue(pending, 5000), null);
});

test('nextDue: skips entries whose nextAttemptAt has not arrived yet', () => {
  let pending = enqueue([], order({ order_id: 'A' }), 1000);
  pending = markRetry(pending, 'A', 1000); // nextAttemptAt = 1000 + 2000 = 3000
  assert.equal(nextDue(pending, 2000), null);
  assert.notEqual(nextDue(pending, 3000), null);
});

// --- markRetry / backoffMs ---

test('backoffMs: follows the configured sequence [2000,5000,10000,20000,30000]', () => {
  assert.equal(backoffMs(1), 2000);
  assert.equal(backoffMs(2), 5000);
  assert.equal(backoffMs(3), 10000);
  assert.equal(backoffMs(4), 20000);
  assert.equal(backoffMs(5), 30000);
});

test('backoffMs: caps at the last value (30000) for attempts beyond the array length', () => {
  assert.equal(backoffMs(6), 30000);
  assert.equal(backoffMs(100), 30000);
});

test('markRetry: increments attempts and schedules nextAttemptAt via backoffMs(attempts)', () => {
  let pending = enqueue([], order({ order_id: 'A' }), 1000);
  pending = markRetry(pending, 'A', 5000);
  assert.equal(pending[0].attempts, 1);
  assert.equal(pending[0].nextAttemptAt, 5000 + 2000);

  pending = markRetry(pending, 'A', 9000);
  assert.equal(pending[0].attempts, 2);
  assert.equal(pending[0].nextAttemptAt, 9000 + 5000);
});

test('markRetry: returns a new array (does not mutate in place)', () => {
  const pending = enqueue([], order({ order_id: 'A' }), 1000);
  const next = markRetry(pending, 'A', 2000);
  assert.notStrictEqual(next, pending);
  assert.equal(pending[0].attempts, 0); // original untouched
});

// --- markConfirmed / purgeAfterPoll (tombstone race, task 9.11 RED test) ---

test('markConfirmed: sets confirmedAtSeq without removing the entry', () => {
  let pending = enqueue([], order({ order_id: 'A' }), 1000);
  pending = markConfirmed(pending, 'A', 42);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].confirmedAtSeq, 42);
});

test('purgeAfterPoll: removes a confirmed entry once startedSeq >= confirmedAtSeq', () => {
  let pending = enqueue([], order({ order_id: 'A' }), 1000);
  pending = markConfirmed(pending, 'A', 10);
  assert.equal(purgeAfterPoll(pending, 10).length, 0); // equal boundary purges
  assert.equal(purgeAfterPoll(pending, 11).length, 0); // later poll purges too
});

// Task 9.11 RED test (caja-payment-queue "A poll racing an optimistic
// mark-Pagada does not redisplay the card"): a poll that STARTED before
// confirmation must NOT purge the tombstone, or the card would flash back
// onto the visible queue.
test('purgeAfterPoll: a poll that STARTED before confirmation must NOT purge (the race)', () => {
  let pending = enqueue([], order({ order_id: 'A' }), 1000);
  pending = markConfirmed(pending, 'A', 10);
  const afterRacingPoll = purgeAfterPoll(pending, 9);
  assert.equal(afterRacingPoll.length, 1);
  assert.equal(afterRacingPoll[0].order_id, 'A');
});

test('purgeAfterPoll: leaves unconfirmed entries untouched', () => {
  const pending = enqueue([], order({ order_id: 'A' }), 1000);
  assert.equal(purgeAfterPoll(pending, 999).length, 1);
});

// --- restore (contract-bug / definitive-reject path) ---

test('restore: removes the entry entirely regardless of confirmation state', () => {
  let pending = enqueue([], order({ order_id: 'A' }), 1000);
  pending = restore(pending, 'A');
  assert.equal(pending.length, 0);
});

// --- dropExpired ---

test('dropExpired: keeps an entry exactly at the PENDING_MAX_AGE_MS boundary', () => {
  const TWELVE_HOURS = 12 * 60 * 60 * 1000;
  const pending = enqueue([], order({ order_id: 'A' }), 0);
  const result = dropExpired(pending, TWELVE_HOURS);
  assert.equal(result.length, 1);
});

test('dropExpired: drops an entry one ms past the PENDING_MAX_AGE_MS boundary', () => {
  const TWELVE_HOURS = 12 * 60 * 60 * 1000;
  const pending = enqueue([], order({ order_id: 'A' }), 0);
  const result = dropExpired(pending, TWELVE_HOURS + 1);
  assert.equal(result.length, 0);
});

test('dropExpired: keeps entries well within the window', () => {
  const pending = enqueue([], order({ order_id: 'A' }), 1000);
  assert.equal(dropExpired(pending, 2000).length, 1);
});
