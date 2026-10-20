import { select } from '../store.js';

/**
 * Helper compartido por cada vista: crea un elemento DOM con `createElement`
 * y asigna atributos/propiedades/listeners/hijos SIN usar nunca `innerHTML`
 * con datos (design.md, "Technical Approach" — Presentation layer). El
 * texto de los hijos se agrega siempre vía `textContent`/nodos de texto.
 * Copiado verbatim de foodc-cliente/js/views/dom.js (design.md "Reuse
 * foodc-cliente modules near-verbatim").
 *
 * @param {string} tag
 * @param {Record<string, any>} [attrs]
 * @param {(Node|string|null|undefined)[]} [children]
 * @returns {HTMLElement}
 */
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null) continue;
    if (key === 'class') {
      node.className = value;
    } else if (key.startsWith('data-')) {
      node.setAttribute(key, String(value));
    } else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key in node) {
      node[key] = value;
    } else {
      node.setAttribute(key, String(value));
    }
  }
  for (const child of children) {
    if (child == null) continue;
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

/**
 * Patrón de montaje compartido por todas las vistas (`js/views/*.js`):
 * - Se suscribe solo a la porción de estado que le importa (`select`).
 * - Re-renderiza ÚNICAMENTE su propia región usando un `DocumentFragment`.
 * - Delega eventos de `click`/`input` por atributos `data-action` /
 *   `data-order-id` en vez de un listener por nodo.
 *
 * @param {HTMLElement} root - contenedor que esta vista posee por completo
 * @param {import('../store.js').createStore<any>} store
 * @param {(state: any) => any} selectFn - porción de estado observada
 * @param {(slice: any, state: any) => DocumentFragment} render
 * @param {(action: string, dataset: DOMStringMap, event: Event, target: HTMLElement) => void} [onAction]
 * @returns {() => void} unmount
 */
export function mount(root, store, selectFn, render, onAction) {
  function renderNow() {
    const state = store.getState();
    const slice = selectFn(state);
    root.replaceChildren(render(slice, state));
  }

  function dispatchFromEvent(event) {
    const target = event.target.closest ? event.target.closest('[data-action]') : null;
    if (!target || !root.contains(target)) return;
    if (typeof onAction === 'function') {
      onAction(target.dataset.action, target.dataset, event, target);
    }
  }

  const unsubscribe = select(store, selectFn, renderNow);
  renderNow();
  root.addEventListener('click', dispatchFromEvent);
  root.addEventListener('input', dispatchFromEvent);
  root.addEventListener('submit', dispatchFromEvent);

  return function unmount() {
    unsubscribe();
    root.removeEventListener('click', dispatchFromEvent);
    root.removeEventListener('input', dispatchFromEvent);
    root.removeEventListener('submit', dispatchFromEvent);
  };
}
