import { messages } from '../messages.js';
import { select } from '../store.js';
import { el } from './dom.js';

function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * Formats an epoch-ms timestamp as a wall-clock `HH:MM:SS` using the
 * tablet's local time. Deliberately not in `time.js`, same reasoning as
 * `foodc-kds/js/views/status-bar-view.js`: that module is about elapsed-time
 * math against the fixed server UTC offset, never wall-clock "now" display.
 *
 * @param {number|null} epochMs
 * @returns {string} '--:--:--' when `epochMs` is not a finite number.
 */
export function formatWallClock(epochMs) {
  if (typeof epochMs !== 'number' || !Number.isFinite(epochMs)) return '--:--:--';
  const d = new Date(epochMs);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/**
 * `state.sync` -> status-bar text.
 *
 * @param {{ status: string }} sync
 * @param {number|null} lastSyncAt
 * @returns {string}
 */
export function syncStatusText(sync, lastSyncAt) {
  const time = formatWallClock(lastSyncAt);
  if (sync.status === 'idle') return '';
  if (sync.status === 'connecting') return messages.sync.connecting;
  if (sync.status === 'ok') return messages.sync.ok(time);
  if (sync.status === 'retrying') return messages.sync.retrying(time);
  if (sync.status === 'stale') return messages.sync.stale(time);
  if (sync.status === 'contract') return messages.sync.contract;
  if (sync.status === 'not_configured') return messages.sync.notConfigured;
  return '';
}

const STATUS_DOT_CLASS = {
  idle: 'bg-slate-400',
  connecting: 'bg-slate-400',
  ok: 'bg-emerald-500',
  retrying: 'bg-amber-500',
  stale: 'bg-red-600',
  contract: 'bg-red-600',
  not_configured: 'bg-red-600',
};

const STATUS_BANNER_CLASS = {
  stale: 'bg-red-600 text-white',
  contract: 'bg-red-600 text-white',
  not_configured: 'bg-red-600 text-white',
};

function render({ sync, lastSyncAt }) {
  const fragment = document.createDocumentFragment();
  const isBanner = sync.status === 'stale' || sync.status === 'contract' || sync.status === 'not_configured';
  const text = syncStatusText(sync, lastSyncAt);

  const bar = el(
    'div',
    {
      class: isBanner
        ? `status-bar flex flex-wrap items-center justify-between gap-3 px-3 py-2 rounded-lg ${STATUS_BANNER_CLASS[sync.status]}`
        : 'status-bar flex flex-wrap items-center justify-between gap-3 px-3 py-2 rounded-lg bg-white',
      role: isBanner ? 'alert' : 'status',
    },
    [
      el('div', { class: 'status-bar__sync flex min-w-0 items-center gap-2' }, [
        el('span', {
          class: `status-bar__dot h-2.5 w-2.5 shrink-0 rounded-full ${STATUS_DOT_CLASS[sync.status] || 'bg-slate-400'}`,
          'aria-hidden': 'true',
        }),
        el('span', { class: 'status-bar__text min-w-0 text-sm font-semibold' }, [text]),
      ]),
      el('div', { class: 'status-bar__actions flex shrink-0 items-center gap-2' }, [
        el(
          'button',
          {
            type: 'button',
            class:
              'status-bar__close min-h-11 min-w-11 whitespace-nowrap rounded-lg bg-red-700 px-3 py-1 text-sm font-bold text-white',
            'data-action': 'open-close',
          },
          [messages.close.openButton],
        ),
        el(
          'button',
          {
            type: 'button',
            class:
              'status-bar__lock min-h-11 min-w-11 whitespace-nowrap rounded-lg border border-slate-300 px-3 py-1 text-sm font-bold text-slate-700',
            'data-action': 'lock',
          },
          [messages.pin.lockButton],
        ),
      ]),
    ],
  );
  fragment.appendChild(bar);
  return fragment;
}

/**
 * Mounts the status bar: sync status + last-sync time, the manual
 * "Bloquear" button (`data-action="lock"`), and the "Cerrar día" entry point
 * (`data-action="open-close"`).
 *
 * @param {HTMLElement} root
 * @param {import('../store.js').createStore<any>} store
 * @param {{ onLock: () => void, onOpenClose: () => void }} handlers
 * @returns {() => void} unmount
 */
export function mountStatusBarView(root, store, handlers) {
  function renderNow() {
    const state = store.getState();
    root.replaceChildren(render({ sync: state.sync, lastSyncAt: state.queue.lastSyncAt }));
  }

  function dispatchFromEvent(event) {
    const target = event.target.closest ? event.target.closest('[data-action]') : null;
    if (!target || !root.contains(target)) return;
    if (target.dataset.action === 'lock') handlers.onLock();
    else if (target.dataset.action === 'open-close') handlers.onOpenClose();
  }

  renderNow();
  root.addEventListener('click', dispatchFromEvent);
  const unsubSync = select(store, (state) => state.sync, renderNow);
  const unsubQueue = select(store, (state) => state.queue.lastSyncAt, renderNow);

  return function unmount() {
    unsubSync();
    unsubQueue();
    root.removeEventListener('click', dispatchFromEvent);
  };
}
