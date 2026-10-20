import { SERVER_UTC_OFFSET_MIN } from './config.js';

const STAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;

/**
 * Parses a `YYYY-MM-DD HH:mm:ss` stamp written by the backend in the script
 * timezone (no offset) into an epoch ms value, applying a fixed UTC offset
 * instead of the tablet's own timezone. Adapted from foodc-kds/js/time.js;
 * the Caja screen uses this to show elapsed time since `updated_at` (the
 * moment an order became `Completado`), not `created_at`.
 *
 * @param {string} stamp
 * @param {number} [offsetMin]
 * @returns {number|null} epoch ms, or null when `stamp` cannot be parsed.
 */
export function parseServerStamp(stamp, offsetMin = SERVER_UTC_OFFSET_MIN) {
  if (typeof stamp !== 'string') return null;
  const m = STAMP_PATTERN.exec(stamp);
  if (!m) return null;

  const [, yearStr, monthStr, dayStr, hourStr, minuteStr, secondStr] = m;
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);
  const hour = Number(hourStr);
  const minute = Number(minuteStr);
  const second = Number(secondStr);

  const utcMs = Date.UTC(year, month - 1, day, hour, minute, second);
  if (!Number.isFinite(utcMs)) return null;

  return utcMs - offsetMin * 60000;
}

/**
 * @param {number|null} atMs
 * @param {number} nowMs
 * @returns {number} elapsed ms, clamped at 0. NaN when `atMs` is not a
 *   finite number (unparseable stamp), so the view renders "--:--".
 */
export function elapsedMs(atMs, nowMs) {
  if (typeof atMs !== 'number' || !Number.isFinite(atMs)) return NaN;
  return Math.max(0, nowMs - atMs);
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * @param {number} ms
 * @returns {string} 'M:SS' under 1 h, 'H:MM:SS' from 1 h; '--:--' when `ms`
 *   is not a finite, non-negative number (unparseable timer context).
 */
export function formatElapsed(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '--:--';

  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours >= 1) {
    return `${hours}:${pad2(minutes)}:${pad2(seconds)}`;
  }
  return `${minutes}:${pad2(seconds)}`;
}
