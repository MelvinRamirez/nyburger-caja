import { messages } from '../messages.js';
import { isValidPinInput } from '../pin.js';
import { PIN_MAX } from '../config.js';
import { select } from '../store.js';
import { el } from './dom.js';

/**
 * @param {number} n
 * @returns {string} '--' when `n` is not a finite number.
 */
function formatTotal(n) {
  return typeof n === 'number' && Number.isFinite(n) ? n.toFixed(2) : '--';
}

/**
 * Reduces a `getCajaOrders(status:"Pagada")` ApiResult into the count/total
 * preview shown on the "¿Seguro?" step. Returns `null` on anything other
 * than a clean success (definitive error, ambiguous/network failure) — the
 * caller falls back to `messages.close.confirmSummaryUnavailable` rather
 * than blocking the close on this preview-only read.
 *
 * @param {import('../api.js').ApiResult} apiResult
 * @returns {{ count: number, total: number }|null}
 */
export function summarizePagadaPreview(apiResult) {
  if (!apiResult || apiResult.kind !== 'success' || !Array.isArray(apiResult.data)) return null;
  let total = 0;
  for (const order of apiResult.data) {
    const amount = typeof order.total_amount === 'number' ? order.total_amount : Number(order.total_amount);
    if (Number.isFinite(amount)) total += amount;
  }
  return { count: apiResult.data.length, total };
}

function renderPinStep(close) {
  const message = close.error === 'wrong_pin' ? messages.pin.wrongPin : null;

  const input = el('input', {
    type: 'text',
    name: 'close-pin',
    inputmode: 'numeric',
    autocomplete: 'off',
    maxlength: String(PIN_MAX),
    'aria-label': messages.close.pinTitle,
    class:
      'close-view__input min-h-11 min-w-11 w-full rounded-xl border border-slate-300 px-4 py-3 text-center text-2xl tracking-[0.3em] font-mono',
  });

  const submit = el(
    'button',
    {
      type: 'submit',
      class:
        'close-view__submit min-h-11 min-w-11 w-full rounded-xl bg-red-700 py-3 font-bold text-white disabled:bg-slate-300 disabled:text-slate-500',
      disabled: true,
      'data-action': 'close-pin-submit',
    },
    [messages.close.pinSubmit],
  );

  const cancel = el(
    'button',
    {
      type: 'button',
      class:
        'close-view__cancel min-h-11 min-w-11 w-full rounded-xl border border-slate-300 py-2 font-semibold text-slate-700',
      'data-action': 'close-cancel',
    },
    [messages.close.confirmCancel],
  );

  const children = [
    el('h2', { class: 'close-view__title text-lg font-black text-slate-900 text-center' }, [messages.close.pinTitle]),
  ];
  if (message) {
    children.push(
      el('p', { class: 'close-view__error text-center text-sm font-semibold text-red-600', role: 'alert' }, [message]),
    );
  }
  children.push(input, submit, cancel);

  return el(
    'form',
    { class: 'close-view__form flex flex-col gap-3 w-full max-w-xs mx-auto', 'data-step': 'pin' },
    children,
  );
}

function renderConfirmStep(preview) {
  let summaryText;
  if (preview.status === 'loading') summaryText = messages.close.confirmSummaryLoading;
  else if (preview.status === 'unavailable') summaryText = messages.close.confirmSummaryUnavailable;
  else summaryText = messages.close.confirmSummary(preview.count, formatTotal(preview.total));

  return el(
    'div',
    { class: 'close-view__confirm flex flex-col gap-3 w-full max-w-xs mx-auto', 'data-step': 'confirm' },
    [
      el('h2', { class: 'close-view__title text-lg font-black text-slate-900 text-center' }, [
        messages.close.confirmTitle,
      ]),
      el('p', { class: 'close-view__body text-center text-sm text-slate-700' }, [messages.close.confirmBody]),
      el(
        'p',
        { class: 'close-view__summary text-center text-sm font-semibold text-slate-900', role: 'status' },
        [summaryText],
      ),
      el(
        'button',
        {
          type: 'button',
          class: 'close-view__accept min-h-11 min-w-11 w-full rounded-xl bg-red-700 py-3 font-bold text-white',
          'data-action': 'close-confirm-accept',
        },
        [messages.close.confirmAccept],
      ),
      el(
        'button',
        {
          type: 'button',
          class:
            'close-view__cancel min-h-11 min-w-11 w-full rounded-xl border border-slate-300 py-2 font-semibold text-slate-700',
          'data-action': 'close-confirm-cancel',
        },
        [messages.close.confirmCancel],
      ),
    ],
  );
}

function renderRunningStep() {
  return el(
    'div',
    { class: 'close-view__running flex flex-col gap-3 w-full max-w-xs mx-auto', 'data-step': 'running' },
    [
      el('p', { class: 'close-view__running-text text-center text-sm font-semibold text-slate-700', role: 'status' }, [
        messages.close.running,
      ]),
    ],
  );
}

// `close.status` -> result text, for every terminal classifyCloseResult
// state. Keyed by status so each renders distinctly (`caja-day-close-flow`).
const RESULT_MESSAGE = {
  done: (close) => messages.close.done(close.summary?.archived_count ?? 0, formatTotal(close.summary?.total_amount)),
  already_closed: () => messages.close.alreadyClosed,
  nothing: () => messages.close.nothing,
  in_progress: () => messages.close.inProgress,
  failed: (close) => messages.close.failed(close.step),
  unknown: () => messages.close.unknown,
  blocked: () => messages.close.blocked,
  contract: () => messages.close.contract,
};

// Statuses offering "Reintentar", which restarts the FULL PIN + confirmation
// sequence (`caja-day-close-flow` "Retrying after a partial failure reuses
// double confirmation") — never resubmits the same request silently.
const RETRYABLE_STATUSES = new Set(['in_progress', 'failed', 'unknown']);

function renderResultStep(close) {
  const text = RESULT_MESSAGE[close.status](close);
  const buttons = [];
  if (RETRYABLE_STATUSES.has(close.status)) {
    buttons.push(
      el(
        'button',
        {
          type: 'button',
          class: 'close-view__retry min-h-11 min-w-11 w-full rounded-xl bg-red-700 py-3 font-bold text-white',
          'data-action': 'close-retry',
        },
        [messages.close.retry],
      ),
    );
  }
  buttons.push(
    el(
      'button',
      {
        type: 'button',
        class:
          'close-view__dismiss min-h-11 min-w-11 w-full rounded-xl border border-slate-300 py-2 font-semibold text-slate-700',
        'data-action': 'close-dismiss',
      },
      [messages.close.dismiss],
    ),
  );

  return el(
    'div',
    { class: 'close-view__result flex flex-col gap-3 w-full max-w-xs mx-auto', 'data-step': close.status, role: 'status' },
    [el('p', { class: 'close-view__result-text text-center text-sm font-semibold text-slate-900' }, [text]), ...buttons],
  );
}

function render(close, preview) {
  const fragment = document.createDocumentFragment();
  if (close.status === 'idle') return fragment;

  let stepNode;
  if (close.status === 'pin') stepNode = renderPinStep(close);
  else if (close.status === 'confirm') stepNode = renderConfirmStep(preview);
  else if (close.status === 'running') stepNode = renderRunningStep();
  else stepNode = renderResultStep(close);

  fragment.appendChild(
    el(
      'div',
      {
        class: 'close-view__overlay fixed inset-0 z-40 flex items-center justify-center bg-slate-900/60 p-4',
        role: 'dialog',
        'aria-modal': 'true',
      },
      [el('div', { class: 'close-view__panel w-full max-w-sm rounded-2xl bg-white p-4 shadow-xl' }, [stepNode])],
    ),
  );
  return fragment;
}

/**
 * Mounts the day-close dialog: the PIN re-prompt step (always required even
 * when the screen is already unlocked, C12), the explicit "¿Seguro?"
 * confirmation (showing the Pagada count/total preview), the in-flight
 * "running" step, and every distinct `classifyCloseResult` terminal state.
 * Cancelling at the PIN or confirm step sends zero requests
 * (`caja-day-close-flow` "Cancelling the confirmation step sends no
 * request").
 *
 * The Pagada count/total preview is fetched directly via
 * `handlers.fetchPagadaSummary()` (a thin wrapper over
 * `ctx.api.getCajaOrders('Pagada')`, wired in `main.js`) each time the
 * dialog enters the `confirm` step; it is purely a presentational preview
 * (design.md Decision 3: "optional for the client") and its failure never
 * blocks the close itself — see `confirmSummaryUnavailable`.
 *
 * @param {HTMLElement} root
 * @param {import('../store.js').createStore<any>} store
 * @param {{
 *   onClosePinEntered: (pin: string) => void,
 *   onCloseCancelled: () => void,
 *   onCloseConfirmed: (pin: string) => void,
 *   onCloseRetry: () => void,
 *   onCloseDismiss: () => void,
 *   fetchPagadaSummary: () => Promise<import('../api.js').ApiResult>,
 * }} handlers
 * @returns {() => void} unmount
 */
export function mountCloseView(root, store, handlers) {
  let preview = { status: 'loading', count: 0, total: 0 };
  let lastStatus = store.getState().close.status;

  function renderNow() {
    root.replaceChildren(render(store.getState().close, preview));
    wireInteractivity();
  }

  function wireInteractivity() {
    const form = root.querySelector('form[data-step="pin"]');
    if (!form) return;
    const input = form.querySelector('input[name="close-pin"]');
    const submit = form.querySelector('[data-action="close-pin-submit"]');
    if (!input || !submit) return;

    function syncEnabled() {
      submit.disabled = !isValidPinInput(input.value);
    }
    syncEnabled();

    input.addEventListener('input', () => {
      const digitsOnly = input.value.replace(/[^0-9]/g, '');
      if (digitsOnly !== input.value) input.value = digitsOnly;
      syncEnabled();
    });

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (!isValidPinInput(input.value)) return;
      handlers.onClosePinEntered(input.value);
    });
  }

  function dispatchFromEvent(event) {
    const target = event.target.closest ? event.target.closest('[data-action]') : null;
    if (!target || !root.contains(target)) return;
    const action = target.dataset.action;
    if (action === 'close-cancel' || action === 'close-confirm-cancel') {
      handlers.onCloseCancelled();
    } else if (action === 'close-confirm-accept') {
      const pin = store.getState().close.pin;
      handlers.onCloseConfirmed(pin);
    } else if (action === 'close-retry') {
      handlers.onCloseRetry();
    } else if (action === 'close-dismiss') {
      handlers.onCloseDismiss();
    }
  }

  function onCloseChange(close) {
    const enteringConfirm = close.status === 'confirm' && lastStatus !== 'confirm';
    if (close.status !== 'confirm') {
      preview = { status: 'loading', count: 0, total: 0 };
    }
    lastStatus = close.status;
    renderNow();

    if (enteringConfirm) {
      handlers.fetchPagadaSummary().then((apiResult) => {
        // Ignore a stale response if the dialog moved on (cancelled/retried)
        // while this preview-only read was in flight.
        if (store.getState().close.status !== 'confirm') return;
        const summary = summarizePagadaPreview(apiResult);
        preview = summary ? { status: 'ready', ...summary } : { status: 'unavailable', count: 0, total: 0 };
        renderNow();
      });
    }
  }

  renderNow();
  root.addEventListener('click', dispatchFromEvent);
  const unsubscribe = select(store, (state) => state.close, onCloseChange);

  return function unmount() {
    unsubscribe();
    root.removeEventListener('click', dispatchFromEvent);
  };
}
