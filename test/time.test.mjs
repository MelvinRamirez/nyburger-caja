import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseServerStamp, elapsedMs, formatElapsed } from '../js/time.js';

// --- parseServerStamp ---

test('parseServerStamp: applies the fixed -360 min (UTC-6) offset', () => {
  // 2026-10-13 12:00:00 local (America/Tegucigalpa, UTC-6) -> 18:00:00Z.
  const ms = parseServerStamp('2026-10-13 12:00:00', -360);
  assert.equal(new Date(ms).toISOString(), '2026-10-13T18:00:00.000Z');
});

test('parseServerStamp: uses SERVER_UTC_OFFSET_MIN as the default offset', () => {
  const ms = parseServerStamp('2026-10-13 12:00:00');
  assert.equal(new Date(ms).toISOString(), '2026-10-13T18:00:00.000Z');
});

test('parseServerStamp: returns null for a malformed stamp', () => {
  assert.equal(parseServerStamp(''), null);
  assert.equal(parseServerStamp('not a date'), null);
  assert.equal(parseServerStamp('2026-10-13'), null);
  assert.equal(parseServerStamp('2026/10/13 12:00:00'), null);
  assert.equal(parseServerStamp(undefined), null);
  assert.equal(parseServerStamp(null), null);
  assert.equal(parseServerStamp(12345), null);
});

// --- elapsedMs ---

test('elapsedMs: returns now - at', () => {
  assert.equal(elapsedMs(1000, 5000), 4000);
});

test('elapsedMs: clamps at 0, never negative', () => {
  assert.equal(elapsedMs(5000, 1000), 0);
});

test('elapsedMs: returns NaN when atMs is not a finite number', () => {
  assert.ok(Number.isNaN(elapsedMs(null, 5000)));
  assert.ok(Number.isNaN(elapsedMs(undefined, 5000)));
  assert.ok(Number.isNaN(elapsedMs(NaN, 5000)));
});

// --- formatElapsed ---

test('formatElapsed: M:SS under 1 hour, boundary at 59:59', () => {
  assert.equal(formatElapsed(59 * 60000 + 59000), '59:59');
});

test('formatElapsed: switches to H:MM:SS at exactly 1:00:00', () => {
  assert.equal(formatElapsed(60 * 60000), '1:00:00');
});

test('formatElapsed: small values', () => {
  assert.equal(formatElapsed(0), '0:00');
  assert.equal(formatElapsed(5000), '0:05');
  assert.equal(formatElapsed(65000), '1:05');
});

test('formatElapsed: multi-hour values', () => {
  assert.equal(formatElapsed(2 * 3600000 + 3 * 60000 + 4000), '2:03:04');
});

test('formatElapsed: renders "--:--" for a non-finite or negative input (unparseable timer context)', () => {
  assert.equal(formatElapsed(NaN), '--:--');
  assert.equal(formatElapsed(undefined), '--:--');
  assert.equal(formatElapsed(null), '--:--');
  assert.equal(formatElapsed(-1), '--:--');
});
