// Set after the NYBurger backend's Apps Script Web App is deployed — see
// NYBurger/docs/backend-deployment.md for the deployment procedure.
export const API_URL = 'https://script.google.com/macros/s/<SET_AFTER_NYBURGER_BACKEND_DEPLOY>/exec';
export const POLL_INTERVAL_MS = 10000; // cashier screen; KDS stays at 5 s
export const POLL_TIMEOUT_MS = 15000; // lock-free read
export const VERIFY_TIMEOUT_MS = 15000; // no lock, no Sheets
export const PAY_TIMEOUT_MS = 30000; // 15 s lock wait + hold + cold start
export const PAYMENT_BACKOFF_MS = [2000, 5000, 10000, 20000, 30000]; // last value repeats
export const CLOSE_TIMEOUT_MS = 90000; // two lock waits (<= 30 s) + Drive + Mail, with margin
export const STALE_ALERT_MS = 60000;
export const PIN_MIN = 6;
export const PIN_MAX = 12;
export const PENDING_MAX_AGE_MS = 12 * 60 * 60 * 1000;
export const STORAGE_KEY = 'foodc.caja.v1'; // localStorage: { v:1, pending: PendingPayment[] }
export const PIN_SESSION_KEY = 'foodc.caja.pin'; // sessionStorage: raw PIN string
export const SERVER_UTC_OFFSET_MIN = -360; // appsscript.json timeZone America/Tegucigalpa (UTC-6, no DST)
