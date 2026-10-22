import { messages } from '../messages.js';
import { isValidPinInput } from '../pin.js';
import { PIN_MAX } from '../config.js';
import { select } from '../store.js';
import { el } from './dom.js';

/**
 * `state.auth.error` -> error text per `messages.pin`. Design names four
 * values (`wrong_pin|offline|not_configured|contract`); `'rejected'`
 * (automatic re-lock on a mid-service UNAUTHORIZED) and `'manual'` (the
 * "Bloquear" button) have no dedicated copy either, same posture as
 * `foodc-kds/js/views/pin-view.js`: render the plain locked keypad with no
 * error banner, same as `null`.
 *
 * @param {string|null} error
 * @returns {string|null}
 */
function errorMessage(error) {
  if (error === 'wrong_pin') return messages.pin.wrongPin;
  if (error === 'offline') return messages.pin.offline;
  if (error === 'not_configured') return messages.pin.notConfigured;
  if (error === 'contract') return messages.pin.contract;
  return null;
}

/**
 * Pure given `auth` (`{status, error}`): rebuilt from scratch only when the
 * `auth` slice's reference changes, never on every keystroke (see
 * `mountPinView`'s `wireInteractivity`, which keeps the input node and the
 * cashier's typed digits/focus intact across re-renders triggered by
 * anything other than an auth transition).
 *
 * @param {{ status: 'locked'|'verifying'|'unlocked', error: string|null }} auth
 * @returns {DocumentFragment}
 */
function render(auth) {
  const fragment = document.createDocumentFragment();
  const verifying = auth.status === 'verifying';
  const message = errorMessage(auth.error);

  const input = el('input', {
    type: 'password',
    name: 'pin',
    inputmode: 'numeric',
    autocomplete: 'off',
    maxlength: String(PIN_MAX),
    'aria-label': messages.pin.title,
    class:
      'pin-view__input min-h-11 min-w-11 w-full rounded-xl border border-slate-300 px-4 py-3 text-center text-2xl tracking-[0.3em] font-mono',
    disabled: verifying,
  });

  const submitButton = el(
    'button',
    {
      type: 'submit',
      class:
        'pin-view__submit min-h-11 min-w-11 w-full rounded-xl bg-emerald-700 py-3 font-bold text-white disabled:bg-slate-300 disabled:text-slate-500',
      disabled: true,
      'data-action': 'unlock-submit',
    },
    [verifying ? messages.pin.title : messages.pin.submit],
  );

  const children = [
    el('h1', { class: 'pin-view__title text-xl font-black text-slate-900 text-center' }, [messages.pin.title]),
    input,
    submitButton,
  ];
  if (message) {
    children.push(
      el('p', { class: 'pin-view__error text-center text-sm font-semibold text-red-600', role: 'alert' }, [message]),
    );
  }

  fragment.appendChild(
    el('form', { class: 'pin-view__form flex flex-col gap-3 w-full max-w-xs mx-auto' }, children),
  );
  return fragment;
}

/**
 * Mounts the blocking PIN screen (`caja-access` "Blocking PIN Screen on
 * First Open"). `isValidPinInput` is checked HERE, before `handlers.onUnlock`
 * is ever called — the view never calls `effects.unlock` directly, only
 * emits the `onUnlock(pin)` intent.
 *
 * Visibility (whether this root is shown at all) is `main.js`'s concern,
 * based on `auth.status !== 'unlocked'`; this render is always pure given
 * `auth`.
 *
 * @param {HTMLElement} root
 * @param {import('../store.js').createStore<any>} store
 * @param {{ onUnlock: (pin: string) => void }} handlers
 * @returns {() => void} unmount
 */
export function mountPinView(root, store, handlers) {
  function wireInteractivity() {
    const form = root.querySelector('form');
    const input = root.querySelector('input[name="pin"]');
    const button = root.querySelector('[data-action="unlock-submit"]');
    if (!form || !input || !button) return;

    function syncSubmitEnabled() {
      button.disabled = !isValidPinInput(input.value);
    }
    syncSubmitEnabled();

    input.addEventListener('input', () => {
      const digitsOnly = input.value.replace(/[^0-9]/g, '');
      if (digitsOnly !== input.value) input.value = digitsOnly;
      syncSubmitEnabled();
    });

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (!isValidPinInput(input.value)) return;
      handlers.onUnlock(input.value);
    });
  }

  function renderNow() {
    root.replaceChildren(render(store.getState().auth));
    wireInteractivity();
  }

  renderNow();
  const unsubscribe = select(store, (state) => state.auth, renderNow);

  return function unmount() {
    unsubscribe();
  };
}
