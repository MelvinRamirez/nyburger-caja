import { PIN_MIN, PIN_MAX, PIN_SESSION_KEY } from './config.js';

const PIN_PATTERN = new RegExp(`^[0-9]{${PIN_MIN},${PIN_MAX}}$`);

/**
 * @param {string} s
 * @returns {boolean}
 */
export function isValidPinInput(s) {
  return typeof s === 'string' && PIN_PATTERN.test(s);
}

// In-memory fallback: when the injected storage object is unavailable or
// throws on every access (e.g. sessionStorage disabled, private browsing
// restrictions, or a storage quota/security error), the PIN still needs to
// survive for the rest of THIS page session so unlocking keeps working.
// This variable holds that fallback. It is deliberately module-level (not
// persisted anywhere): it never substitutes for real storage across a
// reload, it only keeps the current in-memory session usable when the
// storage write/read itself is the thing failing.
let inMemoryPinFallback = null;

/**
 * @param {{ getItem(key: string): string|null }} sessionStorageLike
 * @returns {string|null}
 */
export function loadPin(sessionStorageLike) {
  try {
    const raw = sessionStorageLike ? sessionStorageLike.getItem(PIN_SESSION_KEY) : null;
    if (typeof raw === 'string' && isValidPinInput(raw)) {
      return raw;
    }
  } catch {
    // Storage threw on access; fall through to the in-memory fallback below.
  }
  return inMemoryPinFallback;
}

/**
 * @param {{ setItem(key: string, value: string): void }} sessionStorageLike
 * @param {string} pin
 */
export function savePin(sessionStorageLike, pin) {
  inMemoryPinFallback = pin;
  try {
    sessionStorageLike.setItem(PIN_SESSION_KEY, pin);
  } catch {
    // Keep the in-memory fallback: the current page session still works
    // even though nothing persisted to real storage.
  }
}

/**
 * @param {{ removeItem(key: string): void }} sessionStorageLike
 */
export function clearPin(sessionStorageLike) {
  inMemoryPinFallback = null;
  try {
    sessionStorageLike.removeItem(PIN_SESSION_KEY);
  } catch {
    // Nothing to persist; the fallback is already cleared above.
  }
}
