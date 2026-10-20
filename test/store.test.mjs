import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore, select } from '../js/store.js';

test('notifies listeners on a state change', () => {
  const store = createStore({ count: 0 });
  const calls = [];
  store.subscribe((state, prev) => calls.push([state, prev]));
  store.setState({ count: 1 });
  assert.deepStrictEqual(calls, [[{ count: 1 }, { count: 0 }]]);
});

test('does not notify when the new state reference equals the previous one', () => {
  const store = createStore({ count: 0 });
  let calls = 0;
  store.subscribe(() => calls++);
  const same = store.getState();
  store.setState(same);
  assert.equal(calls, 0);
});

test('setState accepts a function receiving the current state', () => {
  const store = createStore({ count: 0 });
  store.setState((s) => ({ count: s.count + 1 }));
  assert.deepStrictEqual(store.getState(), { count: 1 });
});

test('unsubscribe during notification does not skip or duplicate remaining listeners', () => {
  const store = createStore({ count: 0 });
  const order = [];
  let unsubB;
  const unsubA = store.subscribe(() => {
    order.push('a');
  });
  unsubB = store.subscribe(() => {
    order.push('b');
    unsubA(); // se desuscribe a sí mismo ya habiendo corrido en este ciclo
  });
  const unsubC = store.subscribe(() => order.push('c'));

  store.setState({ count: 1 });
  assert.deepStrictEqual(order, ['a', 'b', 'c']);

  order.length = 0;
  store.setState({ count: 2 });
  // 'a' ya fue desuscripto antes de este segundo ciclo
  assert.deepStrictEqual(order, ['b', 'c']);

  unsubB();
  unsubC();
});

test('one listener throwing does not stop other listeners from running', () => {
  const store = createStore({ count: 0 });
  const ran = [];
  store.subscribe(() => {
    ran.push('first');
    throw new Error('boom');
  });
  store.subscribe(() => ran.push('second'));

  const originalError = console.error;
  console.error = () => {};
  try {
    store.setState({ count: 1 });
  } finally {
    console.error = originalError;
  }

  assert.deepStrictEqual(ran, ['first', 'second']);
});

test('unsubscribe is safe to call more than once', () => {
  const store = createStore({ count: 0 });
  const unsubscribe = store.subscribe(() => {});
  unsubscribe();
  assert.doesNotThrow(() => unsubscribe());
});

test('select only fires onChange when the selected slice reference changes', () => {
  const store = createStore({ a: { value: 1 }, b: { value: 1 } });
  const seen = [];
  select(store, (s) => s.a, (slice) => seen.push(slice));

  // Cambia 'b' pero no 'a': no debe disparar onChange.
  store.setState((s) => ({ ...s, b: { value: 2 } }));
  assert.deepStrictEqual(seen, []);

  // Cambia 'a': debe disparar onChange exactamente una vez.
  store.setState((s) => ({ ...s, a: { value: 2 } }));
  assert.deepStrictEqual(seen, [{ value: 2 }]);
});
