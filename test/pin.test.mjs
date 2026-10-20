import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isValidPinInput, loadPin, savePin, clearPin } from '../js/pin.js';

function fakeStorage(initial = {}) {
  const data = { ...initial };
  return {
    getItem: (key) => (Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null),
    setItem: (key, value) => {
      data[key] = value;
    },
    removeItem: (key) => {
      delete data[key];
    },
    _data: data,
  };
}

function throwingStorage() {
  return {
    getItem: () => {
      throw new Error('storage unavailable');
    },
    setItem: () => {
      throw new Error('storage unavailable');
    },
    removeItem: () => {
      throw new Error('storage unavailable');
    },
  };
}

// Reset the module-level in-memory fallback before each boundary/isolation
// test so earlier tests' saved PINs don't leak into later assertions.
function resetFallback() {
  clearPin(fakeStorage());
}

// --- isValidPinInput: boundary inputs ---

test('isValidPinInput: rejects 5 digits (below PIN_MIN)', () => {
  assert.equal(isValidPinInput('12345'), false);
});

test('isValidPinInput: accepts 6 digits (PIN_MIN)', () => {
  assert.equal(isValidPinInput('123456'), true);
});

test('isValidPinInput: accepts 12 digits (PIN_MAX)', () => {
  assert.equal(isValidPinInput('123456789012'), true);
});

test('isValidPinInput: rejects 13 digits (above PIN_MAX)', () => {
  assert.equal(isValidPinInput('1234567890123'), false);
});

test('isValidPinInput: rejects non-digit characters', () => {
  assert.equal(isValidPinInput('12345a'), false);
  assert.equal(isValidPinInput('123 456'), false);
  assert.equal(isValidPinInput('123456.'), false);
});

test('isValidPinInput: rejects empty string', () => {
  assert.equal(isValidPinInput(''), false);
});

// --- loadPin / savePin / clearPin: normal storage ---

test('loadPin: returns null when the key is missing', () => {
  resetFallback();
  const storage = fakeStorage();
  assert.equal(loadPin(storage), null);
});

test('loadPin: returns null when the stored value is an invalid format', () => {
  resetFallback();
  const storage = fakeStorage({ 'foodc.caja.pin': 'abc' });
  assert.equal(loadPin(storage), null);
});

test('savePin then loadPin round-trips a valid pin through normal storage', () => {
  resetFallback();
  const storage = fakeStorage();
  savePin(storage, '123456');
  assert.equal(loadPin(storage), '123456');
});

test('clearPin removes the key from storage', () => {
  resetFallback();
  const storage = fakeStorage();
  savePin(storage, '123456');
  clearPin(storage);
  assert.equal(loadPin(storage), null);
});

// --- storage-failure tolerance ---

test('loadPin: tolerates a storage whose getItem throws, returning null when no fallback is set', () => {
  resetFallback();
  const storage = throwingStorage();
  assert.doesNotThrow(() => loadPin(storage));
  assert.equal(loadPin(storage), null);
});

test('savePin: tolerates a storage whose setItem throws', () => {
  resetFallback();
  const storage = throwingStorage();
  assert.doesNotThrow(() => savePin(storage, '123456'));
});

test('clearPin: tolerates a storage whose removeItem throws', () => {
  const storage = throwingStorage();
  assert.doesNotThrow(() => clearPin(storage));
});

// --- in-memory fallback round-trip: savePin then loadPin succeeds even when
// the injected storage throws on both calls ---

test('savePin then loadPin succeeds via the in-memory fallback when storage throws on both getItem and setItem', () => {
  const storage = throwingStorage();
  savePin(storage, '987654');
  assert.equal(loadPin(storage), '987654');
});

test('clearPin also clears the in-memory fallback', () => {
  const storage = throwingStorage();
  savePin(storage, '987654');
  assert.equal(loadPin(storage), '987654');
  clearPin(storage);
  assert.equal(loadPin(storage), null);
});
