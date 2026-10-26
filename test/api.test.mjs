import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCajaApiClient, classifyResponseText, isRelock } from '../js/api.js';

const BASE_URL = 'https://example.test/exec';

function noopTimer() {
  return {
    setTimer: () => 'fake-timer-id',
    clearTimer: () => {},
  };
}

function okResponse(body) {
  return new Response(JSON.stringify(body));
}

function makeClient({ fetchImpl, getPin = () => '123456', ...rest } = {}) {
  return createCajaApiClient({
    baseUrl: BASE_URL,
    getPin,
    fetchImpl,
    timeouts: { poll: 15000, verify: 15000, pay: 30000, close: 90000 },
    ...noopTimer(),
    ...rest,
  });
}

// --- Task 9.8 RED test (mirrors kds-kitchen-display task 8.3, threat-matrix
// case 5, client side): the PIN must never leak into the request URL, for
// every one of the 4 Caja actions and every input, including a null PIN and
// the close dialog's re-entered PIN. Written and confirmed failing BEFORE
// js/api.js existed (no module to import); kept here as the permanent
// regression test, per `caja-access` "Every Protected Request Carries the
// Stored PIN in Its Body, Never a URL". ---

test('verifyCajaPin never puts the PIN in the request URL, for any pin value', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return okResponse({ ok: true, data: { valid: true } });
  };
  const client = makeClient({ fetchImpl });

  for (const pin of ['123456', null, '000000000000', '', 'abc123']) {
    await client.verifyCajaPin(pin);
  }

  assert.ok(calls.length > 0);
  for (const call of calls) {
    assert.equal(call.url, BASE_URL);
  }
});

test('getCajaOrders never puts the PIN in the request URL, for any pin value', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return okResponse({ ok: true, data: [] });
  };

  for (const pin of ['123456', null, '000000000000', '']) {
    const client = makeClient({ fetchImpl, getPin: () => pin });
    await client.getCajaOrders('Pendiente');
  }

  // getPin()===null short-circuits with zero fetch calls (see dedicated
  // test below), so only the non-null pins reach fetchImpl here.
  assert.ok(calls.length > 0);
  for (const call of calls) {
    assert.equal(call.url, BASE_URL);
  }
});

test('markOrderPaid never puts the PIN in the request URL, for any pin value', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return okResponse({ ok: true, data: { order_id: 'ORD-1' } });
  };

  for (const pin of ['123456', null, '000000000000', '']) {
    const client = makeClient({ fetchImpl, getPin: () => pin });
    await client.markOrderPaid('ORD-1');
  }

  assert.ok(calls.length > 0);
  for (const call of calls) {
    assert.equal(call.url, BASE_URL);
  }
});

test('closeDay never puts the PIN in the request URL, for any pin value including the re-entered dialog pin', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return okResponse({
      ok: true,
      data: { date: '2026-10-15', archived_count: 1, total_amount: 100, file_id: 'f1' },
    });
  };
  const client = makeClient({ fetchImpl, getPin: () => '999999' }); // stored session pin (must be ignored)

  for (const pin of ['123456', null, '000000000000', '']) {
    await client.closeDay(pin);
  }

  assert.ok(calls.length > 0);
  for (const call of calls) {
    assert.equal(call.url, BASE_URL);
  }
});

// --- classifyResponseText: copied verbatim, same rows as foodc-kds ---

test('classifyResponseText: ok:false with error object classifies as definitive (any code)', () => {
  const result = classifyResponseText(
    JSON.stringify({ ok: false, error: { code: 'LOCK_TIMEOUT', message: 'busy' } }),
    () => true,
  );
  assert.deepStrictEqual(result, {
    kind: 'definitive',
    code: 'LOCK_TIMEOUT',
    message: 'busy',
    details: null,
  });
});

test('classifyResponseText: ok:false with an unlisted code is still definitive', () => {
  const result = classifyResponseText(
    JSON.stringify({ ok: false, error: { code: 'UNAUTHORIZED', message: 'Invalid caja PIN' } }),
    () => true,
  );
  assert.equal(result.kind, 'definitive');
  assert.equal(result.code, 'UNAUTHORIZED');
});

test('classifyResponseText: ok:true with valid data classifies as success', () => {
  const result = classifyResponseText(JSON.stringify({ ok: true, data: [] }), () => true);
  assert.deepStrictEqual(result, { kind: 'success', data: [], meta: null });
});

test('classifyResponseText: ok:true with invalid data shape classifies as ambiguous/invalid_response', () => {
  const result = classifyResponseText(JSON.stringify({ ok: true, data: null }), () => false);
  assert.deepStrictEqual(result, { kind: 'ambiguous', reason: 'invalid_response' });
});

test('classifyResponseText: non-JSON body classifies as ambiguous/invalid_response', () => {
  const result = classifyResponseText('<html>not json</html>', () => true);
  assert.deepStrictEqual(result, { kind: 'ambiguous', reason: 'invalid_response' });
});

test('classifyResponseText: JSON missing boolean ok classifies as ambiguous/invalid_response', () => {
  const result = classifyResponseText(JSON.stringify({ data: [] }), () => true);
  assert.deepStrictEqual(result, { kind: 'ambiguous', reason: 'invalid_response' });
});

// --- transport options (fixed for all four calls) ---

test('verifyCajaPin sends the exact fixed POST transport options and body', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return okResponse({ ok: true, data: { valid: true } });
  };
  const client = makeClient({ fetchImpl, getPin: () => null });

  await client.verifyCajaPin('123456');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, BASE_URL);
  assert.equal(calls[0].options.method, 'POST');
  assert.deepStrictEqual(calls[0].options.headers, { 'Content-Type': 'text/plain;charset=utf-8' });
  assert.equal(calls[0].options.redirect, 'follow');
  assert.equal(calls[0].options.credentials, 'omit');
  assert.equal(calls[0].options.cache, 'no-store');
  assert.ok(calls[0].options.signal);
  assert.deepStrictEqual(JSON.parse(calls[0].options.body), { action: 'verifyCajaPin', pin: '123456' });
});

test('getCajaOrders sends the exact fixed POST transport options and body, default status omitted', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return okResponse({ ok: true, data: [] });
  };
  const client = makeClient({ fetchImpl, getPin: () => '654321' });

  await client.getCajaOrders();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, BASE_URL);
  assert.equal(calls[0].options.method, 'POST');
  assert.deepStrictEqual(calls[0].options.headers, { 'Content-Type': 'text/plain;charset=utf-8' });
  assert.equal(calls[0].options.redirect, 'follow');
  assert.equal(calls[0].options.credentials, 'omit');
  assert.equal(calls[0].options.cache, 'no-store');
  assert.deepStrictEqual(JSON.parse(calls[0].options.body), {
    action: 'getCajaOrders',
    pin: '654321',
  });
});

test('getCajaOrders sends an explicit payment_status when provided (e.g. "Pagada")', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return okResponse({ ok: true, data: [] });
  };
  const client = makeClient({ fetchImpl, getPin: () => '654321' });

  await client.getCajaOrders('Pagada');

  assert.deepStrictEqual(JSON.parse(calls[0].options.body), {
    action: 'getCajaOrders',
    payment_status: 'Pagada',
    pin: '654321',
  });
});

test('markOrderPaid sends the exact fixed POST transport options and body', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return okResponse({ ok: true, data: { order_id: 'ORD-9' } });
  };
  const client = makeClient({ fetchImpl, getPin: () => '654321' });

  await client.markOrderPaid('ORD-9');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, BASE_URL);
  assert.equal(calls[0].options.method, 'POST');
  assert.deepStrictEqual(calls[0].options.headers, { 'Content-Type': 'text/plain;charset=utf-8' });
  assert.equal(calls[0].options.redirect, 'follow');
  assert.equal(calls[0].options.credentials, 'omit');
  assert.equal(calls[0].options.cache, 'no-store');
  assert.deepStrictEqual(JSON.parse(calls[0].options.body), {
    action: 'markOrderPaid',
    order_id: 'ORD-9',
    pin: '654321',
  });
});

test('closeDay sends the exact fixed POST transport options and body, using the ARGUMENT pin not getPin()', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return okResponse({
      ok: true,
      data: { date: '2026-10-15', archived_count: 2, total_amount: 500, file_id: 'f1' },
    });
  };
  // Stored session PIN differs from the dialog-entered PIN on purpose (C12):
  // closeDay MUST send the argument, never getPin()'s stored value.
  const client = makeClient({ fetchImpl, getPin: () => '000000' });

  await client.closeDay('111111');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, BASE_URL);
  assert.equal(calls[0].options.method, 'POST');
  assert.deepStrictEqual(calls[0].options.headers, { 'Content-Type': 'text/plain;charset=utf-8' });
  assert.equal(calls[0].options.redirect, 'follow');
  assert.equal(calls[0].options.credentials, 'omit');
  assert.equal(calls[0].options.cache, 'no-store');
  assert.deepStrictEqual(JSON.parse(calls[0].options.body), { action: 'closeDay', pin: '111111' });
});

// --- validators ---

test('verifyCajaPin: data.valid === true classifies as success; anything else is ambiguous/invalid_response', async () => {
  const client1 = makeClient({
    fetchImpl: async () => okResponse({ ok: true, data: { valid: true } }),
  });
  assert.deepStrictEqual(await client1.verifyCajaPin('123456'), {
    kind: 'success',
    data: { valid: true },
    meta: null,
  });

  const client2 = makeClient({
    fetchImpl: async () => okResponse({ ok: true, data: { valid: false } }),
  });
  assert.deepStrictEqual(await client2.verifyCajaPin('123456'), {
    kind: 'ambiguous',
    reason: 'invalid_response',
  });

  const client3 = makeClient({
    fetchImpl: async () => okResponse({ ok: true, data: {} }),
  });
  assert.deepStrictEqual(await client3.verifyCajaPin('123456'), {
    kind: 'ambiguous',
    reason: 'invalid_response',
  });
});

test('getCajaOrders: array of objects with string order_id classifies as success; otherwise ambiguous', async () => {
  const client1 = makeClient({
    fetchImpl: async () => okResponse({ ok: true, data: [{ order_id: 'A' }, { order_id: 'B' }] }),
  });
  const r1 = await client1.getCajaOrders();
  assert.equal(r1.kind, 'success');
  assert.deepStrictEqual(r1.data, [{ order_id: 'A' }, { order_id: 'B' }]);

  const client2 = makeClient({
    fetchImpl: async () => okResponse({ ok: true, data: [{ order_id: 'A' }, { order_id: 5 }] }),
  });
  assert.deepStrictEqual(await client2.getCajaOrders(), { kind: 'ambiguous', reason: 'invalid_response' });

  const client3 = makeClient({
    fetchImpl: async () => okResponse({ ok: true, data: {} }),
  });
  assert.deepStrictEqual(await client3.getCajaOrders(), { kind: 'ambiguous', reason: 'invalid_response' });

  const client4 = makeClient({
    fetchImpl: async () => okResponse({ ok: true, data: [] }),
  });
  assert.deepStrictEqual(await client4.getCajaOrders(), { kind: 'success', data: [], meta: null });
});

test('markOrderPaid: data.order_id string classifies as success; otherwise ambiguous', async () => {
  const client1 = makeClient({
    fetchImpl: async () => okResponse({ ok: true, data: { order_id: 'ORD-1' } }),
  });
  assert.deepStrictEqual(await client1.markOrderPaid('ORD-1'), {
    kind: 'success',
    data: { order_id: 'ORD-1' },
    meta: null,
  });

  const client2 = makeClient({
    fetchImpl: async () => okResponse({ ok: true, data: { order_id: 5 } }),
  });
  assert.deepStrictEqual(await client2.markOrderPaid('ORD-1'), {
    kind: 'ambiguous',
    reason: 'invalid_response',
  });
});

test('closeDay: a well-formed close summary classifies as success; otherwise ambiguous', async () => {
  const client1 = makeClient({
    fetchImpl: async () =>
      okResponse({
        ok: true,
        data: { date: '2026-10-15', archived_count: 3, total_amount: 900, file_id: 'f1' },
      }),
  });
  const r1 = await client1.closeDay('123456');
  assert.equal(r1.kind, 'success');
  assert.equal(r1.data.archived_count, 3);

  const client2 = makeClient({
    fetchImpl: async () => okResponse({ ok: true, data: { date: '2026-10-15' } }), // missing fields
  });
  assert.deepStrictEqual(await client2.closeDay('123456'), {
    kind: 'ambiguous',
    reason: 'invalid_response',
  });
});

// --- timeout behavior (fake timers, one per call kind) ---

function makeTimeoutHarness(timeoutMs) {
  let capturedTimeoutMs;
  let timerCallback;
  const setTimer = (cb, ms) => {
    timerCallback = cb;
    capturedTimeoutMs = ms;
    return 'timer-id';
  };
  const clearTimer = () => {};
  const fetchImpl = (url, options) =>
    new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
  return {
    setTimer,
    clearTimer,
    fetchImpl,
    getCapturedTimeoutMs: () => capturedTimeoutMs,
    fire: () => timerCallback(),
  };
}

test('verifyCajaPin times out using timeouts.verify', async () => {
  const harness = makeTimeoutHarness();
  const client = createCajaApiClient({
    baseUrl: BASE_URL,
    getPin: () => '123456',
    fetchImpl: harness.fetchImpl,
    timeouts: { poll: 15000, verify: 15000, pay: 30000, close: 90000 },
    setTimer: harness.setTimer,
    clearTimer: harness.clearTimer,
  });

  const promise = client.verifyCajaPin('123456');
  harness.fire();
  const result = await promise;

  assert.equal(harness.getCapturedTimeoutMs(), 15000);
  assert.deepStrictEqual(result, { kind: 'ambiguous', reason: 'timeout' });
});

test('getCajaOrders times out using timeouts.poll', async () => {
  const harness = makeTimeoutHarness();
  const client = createCajaApiClient({
    baseUrl: BASE_URL,
    getPin: () => '123456',
    fetchImpl: harness.fetchImpl,
    timeouts: { poll: 15000, verify: 15000, pay: 30000, close: 90000 },
    setTimer: harness.setTimer,
    clearTimer: harness.clearTimer,
  });

  const promise = client.getCajaOrders();
  harness.fire();
  const result = await promise;

  assert.equal(harness.getCapturedTimeoutMs(), 15000);
  assert.deepStrictEqual(result, { kind: 'ambiguous', reason: 'timeout' });
});

test('markOrderPaid times out using timeouts.pay', async () => {
  const harness = makeTimeoutHarness();
  const client = createCajaApiClient({
    baseUrl: BASE_URL,
    getPin: () => '123456',
    fetchImpl: harness.fetchImpl,
    timeouts: { poll: 15000, verify: 15000, pay: 30000, close: 90000 },
    setTimer: harness.setTimer,
    clearTimer: harness.clearTimer,
  });

  const promise = client.markOrderPaid('ORD-1');
  harness.fire();
  const result = await promise;

  assert.equal(harness.getCapturedTimeoutMs(), 30000);
  assert.deepStrictEqual(result, { kind: 'ambiguous', reason: 'timeout' });
});

test('closeDay times out using timeouts.close', async () => {
  const harness = makeTimeoutHarness();
  const client = createCajaApiClient({
    baseUrl: BASE_URL,
    getPin: () => '123456',
    fetchImpl: harness.fetchImpl,
    timeouts: { poll: 15000, verify: 15000, pay: 30000, close: 90000 },
    setTimer: harness.setTimer,
    clearTimer: harness.clearTimer,
  });

  const promise = client.closeDay('123456');
  harness.fire();
  const result = await promise;

  assert.equal(harness.getCapturedTimeoutMs(), 90000);
  assert.deepStrictEqual(result, { kind: 'ambiguous', reason: 'timeout' });
});

test('a network rejection not caused by the timeout is classified as ambiguous/network', async () => {
  const client = makeClient({
    fetchImpl: async () => {
      throw new Error('network down');
    },
  });
  assert.deepStrictEqual(await client.getCajaOrders(), { kind: 'ambiguous', reason: 'network' });
});

// --- getPin()===null short-circuit on session-PIN-protected calls ---

test('getCajaOrders short-circuits locally to UNAUTHORIZED with zero fetch calls when getPin() is null', async () => {
  let fetchCalls = 0;
  const fetchImpl = async () => {
    fetchCalls++;
    return okResponse({ ok: true, data: [] });
  };
  const client = makeClient({ fetchImpl, getPin: () => null });

  const result = await client.getCajaOrders();

  assert.equal(fetchCalls, 0);
  assert.deepStrictEqual(result, { kind: 'definitive', code: 'UNAUTHORIZED', message: '', details: null });
});

test('markOrderPaid short-circuits locally to UNAUTHORIZED with zero fetch calls when getPin() is null', async () => {
  let fetchCalls = 0;
  const fetchImpl = async () => {
    fetchCalls++;
    return okResponse({ ok: true, data: { order_id: 'ORD-1' } });
  };
  const client = makeClient({ fetchImpl, getPin: () => null });

  const result = await client.markOrderPaid('ORD-1');

  assert.equal(fetchCalls, 0);
  assert.deepStrictEqual(result, { kind: 'definitive', code: 'UNAUTHORIZED', message: '', details: null });
});

test('verifyCajaPin does NOT short-circuit when getPin() is null (verifyCajaPin checks a just-entered pin, not getPin())', async () => {
  let fetchCalls = 0;
  const fetchImpl = async () => {
    fetchCalls++;
    return okResponse({ ok: true, data: { valid: true } });
  };
  const client = makeClient({ fetchImpl, getPin: () => null });

  const result = await client.verifyCajaPin('123456');

  assert.equal(fetchCalls, 1);
  assert.deepStrictEqual(result, { kind: 'success', data: { valid: true }, meta: null });
});

test('closeDay does NOT short-circuit when getPin() is null (closeDay sends the re-entered argument pin, not getPin())', async () => {
  let fetchCalls = 0;
  const fetchImpl = async () => {
    fetchCalls++;
    return okResponse({
      ok: true,
      data: { date: '2026-10-15', archived_count: 0, total_amount: 0, file_id: 'f1' },
    });
  };
  const client = makeClient({ fetchImpl, getPin: () => null });

  const result = await client.closeDay('123456');

  assert.equal(fetchCalls, 1);
  assert.equal(result.kind, 'success');
});

// --- isRelock ---

test('isRelock: true only for definitive UNAUTHORIZED', () => {
  assert.equal(isRelock({ kind: 'definitive', code: 'UNAUTHORIZED', message: '', details: null }), true);
  assert.equal(isRelock({ kind: 'definitive', code: 'PIN_NOT_CONFIGURED', message: '', details: null }), false);
  assert.equal(isRelock({ kind: 'ambiguous', reason: 'timeout' }), false);
  assert.equal(isRelock({ kind: 'success', data: [], meta: null }), false);
});
