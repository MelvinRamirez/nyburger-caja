/**
 * Observable genérico mínimo. Sin conocimiento del dominio: las
 * transiciones viven como reducers puros en actions.js.
 *
 * @template S
 * @param {S} initialState
 * @returns {{
 *   getState: () => S,
 *   setState: (next: S | ((state: S) => S)) => void,
 *   subscribe: (listener: (state: S, prev: S) => void) => () => void
 * }}
 */
export function createStore(initialState) {
  let state = initialState;
  let listeners = [];

  function getState() {
    return state;
  }

  function setState(next) {
    const prev = state;
    const resolved = typeof next === 'function' ? next(state) : next;
    if (resolved === prev) {
      return;
    }
    state = resolved;
    // Iterar sobre una copia: unsubscribe durante la notificación no debe
    // saltear ni duplicar listeners restantes.
    const snapshot = listeners.slice();
    for (const listener of snapshot) {
      try {
        listener(state, prev);
      } catch (err) {
        // Aislar la excepción de un listener del resto.
        console.error(err);
      }
    }
  }

  function subscribe(listener) {
    listeners.push(listener);
    let unsubscribed = false;
    return function unsubscribe() {
      if (unsubscribed) return;
      unsubscribed = true;
      listeners = listeners.filter((l) => l !== listener);
    };
  }

  return { getState, setState, subscribe };
}

/**
 * Suscribe `onChange` para que solo se invoque cuando la porción
 * seleccionada cambia de referencia.
 *
 * @template S, T
 * @param {{ getState: () => S, subscribe: (listener: (state: S, prev: S) => void) => () => void }} store
 * @param {(state: S) => T} selector
 * @param {(slice: T) => void} onChange
 * @returns {() => void} unsubscribe
 */
export function select(store, selector, onChange) {
  let prevSlice = selector(store.getState());
  return store.subscribe((state) => {
    const slice = selector(state);
    if (slice !== prevSlice) {
      prevSlice = slice;
      onChange(slice);
    }
  });
}
