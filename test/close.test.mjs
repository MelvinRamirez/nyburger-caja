import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyCloseResult, closeActions, IDLE_CLOSE } from '../js/close.js';

function success(data) {
  return { kind: 'success', data, meta: null };
}
function definitive(code, details = null) {
  return { kind: 'definitive', code, message: '', details };
}
function ambiguous(reason = 'network') {
  return { kind: 'ambiguous', reason };
}

// --- classifyCloseResult: every row of design's status table ---

test('classifyCloseResult: success -> done, carrying the summary', () => {
  const summary = { date: '2026-10-15', archived_count: 5, total_amount: 1230.0 };
  assert.deepStrictEqual(classifyCloseResult(success(summary)), { status: 'done', summary });
});

test('classifyCloseResult: DAY_ALREADY_CLOSED -> already_closed, carrying details as summary', () => {
  const details = { date: '2026-10-15', archived_count: 5, total_amount: 1230.0, file_id: 'f1' };
  assert.deepStrictEqual(classifyCloseResult(definitive('DAY_ALREADY_CLOSED', details)), {
    status: 'already_closed',
    summary: details,
  });
});

test('classifyCloseResult: NOTHING_TO_CLOSE -> nothing', () => {
  assert.deepStrictEqual(classifyCloseResult(definitive('NOTHING_TO_CLOSE', { date: '2026-10-15' })), {
    status: 'nothing',
  });
});

test('classifyCloseResult: CLOSE_IN_PROGRESS -> in_progress, carrying retry_after_s', () => {
  assert.deepStrictEqual(
    classifyCloseResult(definitive('CLOSE_IN_PROGRESS', { date: '2026-10-15', retry_after_s: 42 })),
    { status: 'in_progress', retryAfterS: 42 },
  );
});

test('classifyCloseResult: CLOSE_IN_PROGRESS with no retry_after_s yields retryAfterS null', () => {
  assert.deepStrictEqual(classifyCloseResult(definitive('CLOSE_IN_PROGRESS', { date: '2026-10-15' })), {
    status: 'in_progress',
    retryAfterS: null,
  });
});

test('classifyCloseResult: CLOSE_STEP_FAILED -> failed, carrying step', () => {
  assert.deepStrictEqual(
    classifyCloseResult(definitive('CLOSE_STEP_FAILED', { date: '2026-10-15', step: 'archive' })),
    { status: 'failed', step: 'archive' },
  );
});

test('classifyCloseResult: LOCK_TIMEOUT, SHEET_UNAVAILABLE, INTERNAL_ERROR -> failed with step null', () => {
  for (const code of ['LOCK_TIMEOUT', 'SHEET_UNAVAILABLE', 'INTERNAL_ERROR']) {
    assert.deepStrictEqual(classifyCloseResult(definitive(code)), { status: 'failed', step: null });
  }
});

// Task 9.13: `caja-day-close-flow` "UNAUTHORIZED on the Close Request
// Re-Locks Instead of Showing a Close Error" — at THIS pure layer,
// UNAUTHORIZED classifies as the dialog-only 'pin' status (not 'failed'),
// signaling the effects layer (K2) to perform the actual screen re-lock.
test('classifyCloseResult: UNAUTHORIZED -> pin (dialog-only; the global relock itself is wired in effects.js, K2)', () => {
  assert.deepStrictEqual(classifyCloseResult(definitive('UNAUTHORIZED')), { status: 'pin', error: 'wrong_pin' });
});

test('classifyCloseResult: PIN_NOT_CONFIGURED, CLOSE_NOT_CONFIGURED, ARCHIVE_CONFLICT -> blocked, carrying the code', () => {
  for (const code of ['PIN_NOT_CONFIGURED', 'CLOSE_NOT_CONFIGURED', 'ARCHIVE_CONFLICT']) {
    assert.deepStrictEqual(classifyCloseResult(definitive(code)), { status: 'blocked', code });
  }
});

test('classifyCloseResult: UNKNOWN_ACTION, INVALID_JSON, VALIDATION_ERROR -> contract', () => {
  for (const code of ['UNKNOWN_ACTION', 'INVALID_JSON', 'VALIDATION_ERROR']) {
    assert.deepStrictEqual(classifyCloseResult(definitive(code)), { status: 'contract' });
  }
});

test('classifyCloseResult: an unrecognized definitive code -> unknown', () => {
  assert.deepStrictEqual(classifyCloseResult(definitive('SOME_NEW_CODE')), { status: 'unknown' });
});

test('classifyCloseResult: ambiguous (network, timeout, invalid_response) -> unknown ("reintentar es seguro")', () => {
  assert.deepStrictEqual(classifyCloseResult(ambiguous('network')), { status: 'unknown' });
  assert.deepStrictEqual(classifyCloseResult(ambiguous('timeout')), { status: 'unknown' });
  assert.deepStrictEqual(classifyCloseResult(ambiguous('invalid_response')), { status: 'unknown' });
});

// --- closeActions: double confirmation state machine ---

test('open: resets to the pin step from any prior state', () => {
  const dirty = { ...IDLE_CLOSE, status: 'done', summary: { archived_count: 1 } };
  assert.deepStrictEqual(closeActions.open(dirty), { ...IDLE_CLOSE, status: 'pin' });
});

test('pinEntered: moves to confirm and records the pin', () => {
  const close = closeActions.open(IDLE_CLOSE);
  const next = closeActions.pinEntered(close, '123456');
  assert.equal(next.status, 'confirm');
  assert.equal(next.pin, '123456');
});

test('confirmed: moves to running', () => {
  let close = closeActions.open(IDLE_CLOSE);
  close = closeActions.pinEntered(close, '123456');
  const next = closeActions.confirmed(close);
  assert.equal(next.status, 'running');
  assert.equal(next.pin, '123456'); // pin survives into running, to be sent by effects.runClose
});

// Task 9.13 / caja-day-close-flow "Cancelling the confirmation step sends
// no request": cancelled resets fully back to idle (no leftover pin).
test('cancelled: resets fully back to idle', () => {
  let close = closeActions.open(IDLE_CLOSE);
  close = closeActions.pinEntered(close, '123456');
  const next = closeActions.cancelled(close);
  assert.deepStrictEqual(next, IDLE_CLOSE);
});

test('resultReceived: classifies the apiResult and merges it into the close sub-state, keeping the pin', () => {
  let close = closeActions.open(IDLE_CLOSE);
  close = closeActions.pinEntered(close, '123456');
  close = closeActions.confirmed(close);
  const summary = { date: '2026-10-15', archived_count: 2, total_amount: 500 };
  const next = closeActions.resultReceived(close, success(summary));
  assert.equal(next.status, 'done');
  assert.deepStrictEqual(next.summary, summary);
  assert.equal(next.pin, '123456');
});

test('resultReceived: a retryable failure keeps the status distinct from done and already_closed', () => {
  let close = closeActions.confirmed(closeActions.pinEntered(closeActions.open(IDLE_CLOSE), '123456'));
  const next = closeActions.resultReceived(close, definitive('LOCK_TIMEOUT'));
  assert.equal(next.status, 'failed');
  assert.notEqual(next.status, 'done');
  assert.notEqual(next.status, 'already_closed');
});

// caja-day-close-flow "Retrying after a partial failure reuses double
// confirmation": reset returns fully to idle so "Cerrar día" must be
// re-opened through open() -> pinEntered() -> confirmed() again.
test('reset: returns fully to idle after a terminal result, for the retry flow to start over', () => {
  let close = closeActions.confirmed(closeActions.pinEntered(closeActions.open(IDLE_CLOSE), '123456'));
  close = closeActions.resultReceived(close, definitive('LOCK_TIMEOUT'));
  const next = closeActions.reset(close);
  assert.deepStrictEqual(next, IDLE_CLOSE);
});
