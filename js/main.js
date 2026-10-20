import {
  API_URL,
  POLL_TIMEOUT_MS,
  VERIFY_TIMEOUT_MS,
  PAY_TIMEOUT_MS,
  CLOSE_TIMEOUT_MS,
  STORAGE_KEY,
} from './config.js';
import { createStore, select } from './store.js';
import { initialState, actions } from './actions.js';
import { loadPersisted, attachPersistence } from './persistence.js';
import { createCajaApiClient } from './api.js';
import { loadPin } from './pin.js';
import * as effects from './effects.js';
import { messages } from './messages.js';
import { el } from './views/dom.js';
import { mountPinView } from './views/pin-view.js';
import { mountQueueView } from './views/queue-view.js';
import { mountStatusBarView } from './views/status-bar-view.js';
import { mountCloseView } from './views/close-view.js';

/**
 * Reads `localStorage`/`sessionStorage` defensively: some private-browsing
 * modes throw on accessing these global objects themselves, not only on
 * reading/writing a key. Same pattern as `foodc-kds/js/main.js`.
 *
 * @returns {{ localStorage: Storage|null, sessionStorage: Storage|null }}
 */
function getBrowserStorages() {
  let local = null;
  let session = null;
  try {
    local = window.localStorage;
  } catch {
    local = null;
  }
  try {
    session = window.sessionStorage;
  } catch {
    session = null;
  }
  return { localStorage: local, sessionStorage: session };
}

function main() {
  const { localStorage: localStorageRef, sessionStorage: sessionStorageRef } = getBrowserStorages();

  const pending = loadPersisted(localStorageRef, STORAGE_KEY);
  const storedPin = loadPin(sessionStorageRef);

  const store = createStore(initialState({ pending, hasPin: storedPin !== null }));
  attachPersistence(store, localStorageRef, STORAGE_KEY);

  const ctx = {
    store,
    api: createCajaApiClient({
      baseUrl: API_URL,
      getPin: () => loadPin(sessionStorageRef),
      timeouts: { poll: POLL_TIMEOUT_MS, verify: VERIFY_TIMEOUT_MS, pay: PAY_TIMEOUT_MS, close: CLOSE_TIMEOUT_MS },
    }),
    pinStorage: sessionStorageRef,
    now: Date.now,
    setTimer: (fn, ms) => window.setTimeout(fn, ms),
    clearTimer: (id) => window.clearTimeout(id),
  };

  const handlers = {
    onUnlock: (pin) => effects.unlock(ctx, pin),
    onLock: () => effects.lock(ctx),
    onMarkPaid: (orderId) => effects.markPaid(ctx, orderId),
    onOpenClose: () => store.setState((s) => actions.closeOpened(s)),
    onClosePinEntered: (pin) => store.setState((s) => actions.closePinEntered(s, { pin })),
    onCloseCancelled: () => store.setState((s) => actions.closeCancelled(s)),
    onCloseConfirmed: (pin) => effects.runClose(ctx, pin),
    onCloseRetry: () => store.setState((s) => actions.closeOpened(s)),
    onCloseDismiss: () => store.setState((s) => actions.closeReset(s)),
    // Preview-only read for the close dialog's "confirm" step (design.md
    // Decision 3): never routed through effects.js, which has no contract
    // for it — see js/views/close-view.js's mountCloseView docstring.
    fetchPagadaSummary: () => ctx.api.getCajaOrders('Pagada'),
  };

  const pinRoot = document.getElementById('pin-root');
  const statusBarRoot = document.getElementById('status-bar-root');
  const queueRoot = document.getElementById('queue-root');
  const closeRoot = document.getElementById('close-root');
  const noticeRoot = document.getElementById('notice-root');

  mountPinView(pinRoot, store, handlers);
  mountStatusBarView(statusBarRoot, store, handlers);
  mountQueueView(queueRoot, store, handlers);
  mountCloseView(closeRoot, store, handlers);

  // Visibility of each region is main.js's call (views render
  // unconditionally, pure given state): the PIN screen blocks everything
  // else until unlocked. The close dialog (`closeRoot`) is always mounted;
  // its own render returns an empty fragment while `close.status === 'idle'`.
  function syncVisibility(status) {
    const unlocked = status === 'unlocked';
    pinRoot.hidden = unlocked;
    statusBarRoot.hidden = !unlocked;
    queueRoot.hidden = !unlocked;
  }
  syncVisibility(store.getState().auth.status);
  select(store, (state) => state.auth.status, syncVisibility);

  // "Restored" notice (contract-bug mark-Pagada path): rendered directly
  // here against the notice region `index.html` provides, same posture as
  // `foodc-kds/js/main.js` (no dedicated view file for it).
  function renderNotice(notice) {
    if (!notice) {
      noticeRoot.replaceChildren();
      return;
    }
    noticeRoot.replaceChildren(
      el(
        'div',
        {
          class:
            'notice flex items-center justify-between gap-3 rounded-lg bg-amber-100 px-3 py-2 text-sm text-amber-900 shadow',
          role: 'alert',
        },
        [
          el('span', {}, [messages.payment.restoredNotice(notice.table_number)]),
          el(
            'button',
            {
              type: 'button',
              class: 'notice__dismiss min-h-11 min-w-11 font-bold',
              'data-action': 'dismiss-notice',
            },
            [messages.payment.restoredDismiss],
          ),
        ],
      ),
    );
  }
  renderNotice(store.getState().notice);
  select(store, (state) => state.notice, renderNotice);
  noticeRoot.addEventListener('click', (event) => {
    const target = event.target.closest ? event.target.closest('[data-action="dismiss-notice"]') : null;
    if (!target) return;
    store.setState((state) => actions.dismissNotice(state));
  });

  effects.startPaymentRunner(ctx);

  if (store.getState().auth.status === 'unlocked') {
    // On load, if sessionStorage already holds a PIN, the state goes
    // straight to 'unlocked' (initialState({hasPin:true})) without
    // re-calling verifyCajaPin — the first poll validates it.
    effects.startPolling(ctx);
  }

  window.addEventListener('online', () => effects.pollNow(ctx));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') effects.pollNow(ctx);
  });

  // Registers the app-shell service worker (`caja-pwa-shell`). No automatic
  // reload on update: the new shell applies on the next navigation. The
  // registration failure is swallowed (`catch(() => {})`): without a service
  // worker the app keeps working online, it only loses shell precache.
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(() => {});
  }
}

main();
