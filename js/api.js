/**
 * @typedef {{ kind: 'success', data: any, meta: any }
 *   | { kind: 'definitive', code: string, message: string, details: object|null }
 *   | { kind: 'ambiguous', reason: 'network'|'timeout'|'invalid_response' }} ApiResult
 */

/**
 * Clasificador puro del cuerpo de respuesta ya leído como texto. No conoce
 * fetch, timers ni AbortController: solo decide `success` / `definitive` /
 * `ambiguous(invalid_response)` a partir del texto y de `validateData`.
 * Copiado verbatim de foodc-kds/js/api.js (que a su vez lo copió de
 * foodc-cliente/js/api.js).
 *
 * @param {string} text
 * @param {(data: any) => boolean} validateData
 * @returns {ApiResult}
 */
export function classifyResponseText(text, validateData) {
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return { kind: 'ambiguous', reason: 'invalid_response' };
  }

  if (!body || typeof body !== 'object' || typeof body.ok !== 'boolean') {
    return { kind: 'ambiguous', reason: 'invalid_response' };
  }

  if (body.ok === false) {
    const error = body.error && typeof body.error === 'object' ? body.error : {};
    return {
      kind: 'definitive',
      code: typeof error.code === 'string' ? error.code : 'UNKNOWN_ERROR',
      message: typeof error.message === 'string' ? error.message : '',
      details: error.details ?? null,
    };
  }

  // body.ok === true
  if (!validateData(body.data)) {
    return { kind: 'ambiguous', reason: 'invalid_response' };
  }

  return { kind: 'success', data: body.data, meta: body.meta ?? null };
}

function validateVerifyCajaPinData(data) {
  return data?.valid === true;
}

function validateGetCajaOrdersData(data) {
  return Array.isArray(data) && data.every((item) => typeof item.order_id === 'string');
}

function validateMarkOrderPaidData(data) {
  return typeof data?.order_id === 'string';
}

function validateCloseDayData(data) {
  return (
    data !== null &&
    typeof data === 'object' &&
    typeof data.date === 'string' &&
    typeof data.archived_count === 'number' &&
    typeof data.total_amount === 'number' &&
    typeof data.file_id === 'string'
  );
}

const LOCAL_UNAUTHORIZED = Object.freeze({
  kind: 'definitive',
  code: 'UNAUTHORIZED',
  message: '',
  details: null,
});

/**
 * @param {{
 *   baseUrl: string,
 *   getPin: () => string|null,
 *   fetchImpl?: typeof fetch,
 *   timeouts: { poll: number, verify: number, pay: number, close: number },
 *   setTimer?: typeof setTimeout,
 *   clearTimer?: typeof clearTimeout,
 * }} options
 */
export function createCajaApiClient({
  baseUrl,
  getPin,
  fetchImpl = globalThis.fetch.bind(globalThis),
  timeouts: { poll, verify, pay, close },
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  /**
   * Fixed POST transport for all four Caja calls. The URL is always exactly
   * `baseUrl` (never a query string), so the PIN can never appear in a URL
   * (task 9.8 RED test; `caja-access` "Every Protected Request Carries the
   * Stored PIN in Its Body, Never a URL").
   *
   * @param {object} body
   * @param {number} timeoutMs
   * @param {(data: any) => boolean} validateData
   * @returns {Promise<ApiResult>}
   */
  async function post(body, timeoutMs, validateData) {
    const ctrl = new AbortController();
    let timedOut = false;
    const timer = setTimer(() => {
      timedOut = true;
      ctrl.abort();
    }, timeoutMs);

    try {
      const res = await fetchImpl(baseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(body),
        redirect: 'follow',
        credentials: 'omit',
        cache: 'no-store',
        signal: ctrl.signal,
      });
      // El timer sigue activo durante la lectura del body.
      const text = await res.text();
      return classifyResponseText(text, validateData);
    } catch {
      return { kind: 'ambiguous', reason: timedOut ? 'timeout' : 'network' };
    } finally {
      clearTimer(timer);
    }
  }

  async function verifyCajaPin(pin) {
    // Deliberately NOT guarded by getPin()===null: verifyCajaPin's whole job
    // is to check a just-entered PIN, which has not been stored via getPin()
    // yet (same reasoning as foodc-kds's verifyPin).
    return post({ action: 'verifyCajaPin', pin }, verify, validateVerifyCajaPinData);
  }

  async function getCajaOrders(paymentStatus) {
    const storedPin = getPin();
    if (storedPin === null) {
      return LOCAL_UNAUTHORIZED;
    }
    const body =
      paymentStatus === undefined
        ? { action: 'getCajaOrders', pin: storedPin }
        : { action: 'getCajaOrders', payment_status: paymentStatus, pin: storedPin };
    return post(body, poll, validateGetCajaOrdersData);
  }

  async function markOrderPaid(order_id) {
    const storedPin = getPin();
    if (storedPin === null) {
      return LOCAL_UNAUTHORIZED;
    }
    return post({ action: 'markOrderPaid', order_id, pin: storedPin }, pay, validateMarkOrderPaidData);
  }

  /**
   * C12 / design Decision 2's `js/close.js` contract: `closeDay` MUST send
   * the PIN argument passed to IT (the value re-entered in the close
   * dialog at the moment of closing), never `getPin()`'s stored session
   * value — the close dialog always re-prompts for the PIN even when the
   * screen is already unlocked from earlier polling. Deliberately NOT
   * guarded by getPin()===null, for the same reason as verifyCajaPin: this
   * PIN is whatever the dialog just collected, not the stored session PIN.
   *
   * @param {string} pin the PIN re-entered in the close dialog.
   */
  async function closeDay(pin) {
    return post({ action: 'closeDay', pin }, close, validateCloseDayData);
  }

  return { verifyCajaPin, getCajaOrders, markOrderPaid, closeDay };
}

export function isRelock(result) {
  return result.kind === 'definitive' && result.code === 'UNAUTHORIZED';
}
