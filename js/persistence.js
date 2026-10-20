import { dropExpired } from './payment.js';

function toFiniteNumber(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

/**
 * @param {unknown} raw
 * @returns {import('./payment.js').PendingPayment|null}
 */
function sanitizeEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.order_id !== 'string' || raw.order_id.length === 0) return null;
  if (typeof raw.table_number !== 'string') return null;

  const tappedAt = toFiniteNumber(raw.tappedAt);
  const attempts = toFiniteNumber(raw.attempts);
  const nextAttemptAt = toFiniteNumber(raw.nextAttemptAt);
  if (tappedAt === null || attempts === null || nextAttemptAt === null) return null;

  let confirmedAtSeq = null;
  if (raw.confirmedAtSeq !== null && raw.confirmedAtSeq !== undefined) {
    if (typeof raw.confirmedAtSeq !== 'number' || !Number.isFinite(raw.confirmedAtSeq)) return null;
    confirmedAtSeq = raw.confirmedAtSeq;
  }

  return { order_id: raw.order_id, table_number: raw.table_number, tappedAt, attempts, nextAttemptAt, confirmedAtSeq };
}

/**
 * Hydrates `payment.pending` from `storage`. Tolerates a null storage, a
 * storage whose getItem throws, corrupt JSON, an unknown version, and a
 * non-array `pending` field, returning `[]` in every one of those cases.
 * Valid-shaped entries are sanitized individually (malformed ones dropped),
 * then PENDING_MAX_AGE_MS-expired entries are dropped (see payment.js
 * `dropExpired`), applied only here, at hydration. Storage holds pending
 * payments only, per design's STORAGE_KEY = 'foodc.caja.v1'.
 *
 * @param {{ getItem: (key: string) => string|null } | null} storage
 * @param {string} key
 * @returns {import('./payment.js').PendingPayment[]}
 */
export function loadPersisted(storage, key) {
  if (!storage) return [];

  let raw;
  try {
    raw = storage.getItem(key);
  } catch {
    return [];
  }
  if (!raw) return [];

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  if (!parsed || typeof parsed !== 'object' || parsed.v !== 1) return [];
  if (!Array.isArray(parsed.pending)) return [];

  const sanitized = parsed.pending.map(sanitizeEntry).filter((entry) => entry !== null);
  return dropExpired(sanitized, Date.now());
}

/**
 * Subscribes to `store` and writes `{ v: 1, pending }` to `storage[key]`
 * only when `state.payment.pending`'s reference actually changed since the
 * last write (not on every state change). Write failures (quota, private
 * mode, unavailable storage) are swallowed so the app keeps working.
 *
 * @param {import('./store.js').createStore<any>} store
 * @param {{ setItem: (key: string, value: string) => void } | null} storage
 * @param {string} key
 * @returns {() => void} unsubscribe
 */
export function attachPersistence(store, storage, key) {
  if (!storage) {
    return () => {};
  }

  let prevPending = store.getState().payment.pending;

  return store.subscribe((state) => {
    const pending = state.payment.pending;
    if (pending === prevPending) {
      return;
    }
    prevPending = pending;

    const payload = JSON.stringify({ v: 1, pending });
    try {
      storage.setItem(key, payload);
    } catch {
      // Quota exceeded or storage unavailable: keep running without persisting.
    }
  });
}
