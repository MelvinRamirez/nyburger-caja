import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPersisted, attachPersistence } from '../js/persistence.js';
import { createStore } from '../js/store.js';
import { initialState, actions } from '../js/actions.js';

function fakeStorage(initial = new Map()) {
  const map = initial;
  return {
    map,
    getItem(key) {
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      map.set(key, value);
    },
  };
}

function throwingStorage() {
  return {
    getItem() {
      throw new Error('storage unavailable');
    },
    setItem() {
      throw new Error('storage unavailable');
    },
  };
}

// tappedAt must be recent: loadPersisted applies dropExpired(sanitized,
// Date.now()) at hydration, so a fixed epoch-adjacent timestamp (e.g. 1000)
// would always be dropped as expired by the time this test runs.
const validEntry = {
  order_id: 'A',
  table_number: '05',
  tappedAt: Date.now(),
  attempts: 0,
  nextAttemptAt: Date.now(),
  confirmedAtSeq: null,
};

// --- loadPersisted: tolerance ---

test('loadPersisted: tolerates a null storage', () => {
  assert.deepStrictEqual(loadPersisted(null, 'k'), []);
});

test('loadPersisted: tolerates a storage whose getItem throws', () => {
  assert.deepStrictEqual(loadPersisted(throwingStorage(), 'k'), []);
});

test('loadPersisted: tolerates a missing key', () => {
  assert.deepStrictEqual(loadPersisted(fakeStorage(), 'k'), []);
});

test('loadPersisted: tolerates corrupt JSON', () => {
  const storage = fakeStorage(new Map([['k', '{not valid json']]));
  assert.deepStrictEqual(loadPersisted(storage, 'k'), []);
});

test('loadPersisted: tolerates a missing version field', () => {
  const storage = fakeStorage(new Map([['k', JSON.stringify({ pending: [validEntry] })]]));
  assert.deepStrictEqual(loadPersisted(storage, 'k'), []);
});

test('loadPersisted: tolerates an old version (v=0)', () => {
  const storage = fakeStorage(new Map([['k', JSON.stringify({ v: 0, pending: [validEntry] })]]));
  assert.deepStrictEqual(loadPersisted(storage, 'k'), []);
});

test('loadPersisted: tolerates a future version (v=2)', () => {
  const storage = fakeStorage(new Map([['k', JSON.stringify({ v: 2, pending: [validEntry] })]]));
  assert.deepStrictEqual(loadPersisted(storage, 'k'), []);
});

test('loadPersisted: tolerates pending not being an array', () => {
  const storage = fakeStorage(new Map([['k', JSON.stringify({ v: 1, pending: { not: 'an array' } })]]));
  assert.deepStrictEqual(loadPersisted(storage, 'k'), []);
});

// --- loadPersisted: sanitization of individual entries ---

test('loadPersisted: keeps a well-formed entry', () => {
  const storage = fakeStorage(new Map([['k', JSON.stringify({ v: 1, pending: [validEntry] })]]));
  assert.deepStrictEqual(loadPersisted(storage, 'k'), [validEntry]);
});

test('loadPersisted: drops an entry with a non-string order_id', () => {
  const bad = { ...validEntry, order_id: 123 };
  const storage = fakeStorage(new Map([['k', JSON.stringify({ v: 1, pending: [bad, validEntry] })]]));
  assert.deepStrictEqual(loadPersisted(storage, 'k'), [validEntry]);
});

test('loadPersisted: drops an entry with a non-string table_number', () => {
  const bad = { ...validEntry, order_id: 'B', table_number: 5 };
  const storage = fakeStorage(new Map([['k', JSON.stringify({ v: 1, pending: [bad, validEntry] })]]));
  assert.deepStrictEqual(loadPersisted(storage, 'k'), [validEntry]);
});

test('loadPersisted: drops an entry with non-numeric tappedAt/attempts/nextAttemptAt', () => {
  const bad1 = { ...validEntry, order_id: 'B', tappedAt: 'not-a-number' };
  const bad2 = { ...validEntry, order_id: 'C', attempts: null };
  const bad3 = { ...validEntry, order_id: 'D', nextAttemptAt: undefined };
  const storage = fakeStorage(
    new Map([['k', JSON.stringify({ v: 1, pending: [bad1, bad2, bad3, validEntry] })]]),
  );
  assert.deepStrictEqual(loadPersisted(storage, 'k'), [validEntry]);
});

test('loadPersisted: drops an entry whose confirmedAtSeq is neither a number nor null', () => {
  const bad = { ...validEntry, order_id: 'B', confirmedAtSeq: 'seven' };
  const storage = fakeStorage(new Map([['k', JSON.stringify({ v: 1, pending: [bad, validEntry] })]]));
  assert.deepStrictEqual(loadPersisted(storage, 'k'), [validEntry]);
});

test('loadPersisted: keeps an entry with a numeric confirmedAtSeq', () => {
  const confirmed = { ...validEntry, order_id: 'B', confirmedAtSeq: 9 };
  const storage = fakeStorage(new Map([['k', JSON.stringify({ v: 1, pending: [confirmed] })]]));
  assert.deepStrictEqual(loadPersisted(storage, 'k'), [confirmed]);
});

test('loadPersisted: drops a non-object entry', () => {
  const storage = fakeStorage(new Map([['k', JSON.stringify({ v: 1, pending: ['not-an-object', validEntry] })]]));
  assert.deepStrictEqual(loadPersisted(storage, 'k'), [validEntry]);
});

// --- loadPersisted: dropExpired applied at hydration ---

test('loadPersisted: drops entries older than PENDING_MAX_AGE_MS (12h)', () => {
  const TWELVE_HOURS = 12 * 60 * 60 * 1000;
  const expired = { ...validEntry, order_id: 'OLD', tappedAt: Date.now() - TWELVE_HOURS - 1000 };
  const fresh = { ...validEntry, order_id: 'NEW', tappedAt: Date.now() };
  const storage = fakeStorage(new Map([['k', JSON.stringify({ v: 1, pending: [expired, fresh] })]]));
  const result = loadPersisted(storage, 'k');
  assert.deepStrictEqual(
    result.map((e) => e.order_id),
    ['NEW'],
  );
});

// --- attachPersistence ---

test('attachPersistence: returns a no-op unsubscribe for a null storage', () => {
  const store = createStore(initialState());
  const unsubscribe = attachPersistence(store, null, 'k');
  assert.doesNotThrow(() => unsubscribe());
});

test('attachPersistence: writes {v:1, pending} only when payment.pending reference changes', () => {
  const storage = fakeStorage();
  let setItemCalls = 0;
  const originalSetItem = storage.setItem.bind(storage);
  storage.setItem = (...args) => {
    setItemCalls++;
    originalSetItem(...args);
  };

  const store = createStore(initialState());
  attachPersistence(store, storage, 'k');

  // Unrelated state changes must not trigger a write.
  store.setState((s) => actions.unlockStarted(s));
  store.setState((s) => actions.unlockSucceeded(s));
  assert.equal(setItemCalls, 0);

  // A payment.pending change triggers exactly one write.
  store.setState((s) => actions.paymentQueued(s, { order: { order_id: 'A', table_number: '05' }, at: 1000 }));
  assert.equal(setItemCalls, 1);

  const stored = JSON.parse(storage.map.get('k'));
  assert.equal(stored.v, 1);
  assert.equal(stored.pending.length, 1);
  assert.equal(stored.pending[0].order_id, 'A');
});

test('attachPersistence: a dispatch sequence with exactly one pending-changing mutation among three writes exactly once', () => {
  const storage = fakeStorage();
  let setItemCalls = 0;
  const originalSetItem = storage.setItem.bind(storage);
  storage.setItem = (...args) => {
    setItemCalls++;
    originalSetItem(...args);
  };

  const store = createStore(initialState());
  attachPersistence(store, storage, 'k');

  store.setState((s) => actions.unlockStarted(s)); // no pending change
  store.setState((s) =>
    actions.paymentQueued(s, { order: { order_id: 'A', table_number: '05' }, at: 1000 }),
  ); // pending change
  store.setState((s) => actions.unlockSucceeded(s)); // no pending change

  assert.equal(setItemCalls, 1);
});

test('attachPersistence: a setItem that throws does not crash the store or lose in-memory state', () => {
  const storage = throwingStorage();
  const store = createStore(initialState());
  assert.doesNotThrow(() => attachPersistence(store, storage, 'k'));

  assert.doesNotThrow(() => {
    store.setState((s) => actions.paymentQueued(s, { order: { order_id: 'A', table_number: '05' }, at: 1000 }));
  });
  assert.equal(store.getState().payment.pending.length, 1);
});
