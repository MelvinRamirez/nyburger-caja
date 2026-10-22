import { messages } from '../messages.js';
import { visibleOrders, toCardModel, activeTables, groupOrdersByTable, tableTotal } from '../queue.js';
import { select } from '../store.js';
import { el } from './dom.js';
import { createCardNode, updateCardNode } from './order-card-view.js';

/**
 * Status/empty text for the queue area itself (`caja-payment-queue`
 * "Distinct Empty Queue, Outage, and PIN-Rejected States"). The "empty
 * queue" text is rendered ONLY when `sync.status === 'ok'` AND zero orders
 * are visible — a successful `[]` is the only thing that proves there is
 * nothing pending; `stale` has its own distinct empty text. `connecting`
 * (unlocked, no successful poll yet) shows a neutral placeholder instead.
 *
 * @param {{ status: string }} sync
 * @param {number} visibleCount
 * @returns {string|null} null when cards should render instead.
 */
function emptyOrConnectingText(sync, visibleCount) {
  if (sync.status === 'connecting') return messages.sync.connecting;
  if (visibleCount === 0 && sync.status === 'ok') return messages.sync.emptyQueueOk;
  if (visibleCount === 0 && sync.status === 'stale') return messages.sync.emptyQueueStale;
  // retrying/contract/not_configured with zero KNOWN orders yet: the
  // status bar already carries the full explanatory banner for these; no
  // dedicated empty-area copy is specified for them here (judgment call,
  // same posture as `foodc-kds/js/views/queue-view.js`).
  return null;
}

/**
 * The "datos sin confirmar" ribbon shown above the grid whenever the last
 * known cards might not be current: `stale`, `contract`, and
 * `not_configured` all share the same ribbon text.
 *
 * @param {{ status: string }} sync
 * @returns {string|null}
 */
function ribbonText(sync) {
  if (sync.status === 'stale' || sync.status === 'contract' || sync.status === 'not_configured') {
    return messages.sync.staleRibbon;
  }
  return null;
}

/**
 * Mounts the payment queue: a grid of `Completado` cards keyed by
 * `order_id`, reusing DOM nodes across polls (no rebuild/flicker when a poll
 * returns the same orders), plus the distinct connectivity/empty texts.
 *
 * @param {HTMLElement} root
 * @param {import('../store.js').createStore<any>} store
 * @param {{ onMarkPaid: (orderId: string) => void }} handlers
 * @returns {() => void} unmount
 */
export function mountQueueView(root, store, handlers) {
  /** @type {Map<string, HTMLElement>} */
  const cardNodes = new Map();
  // Ephemeral UI-only state (which table button is active): not part of the
  // domain store, never persisted, reset on remount — same posture as not
  // having a dedicated reducer for it.
  let selectedTable = null;

  function buildFilterRow(tables) {
    const row = el('div', { class: 'queue-view__filters flex flex-wrap gap-2', role: 'group' });

    const buttonClass = (active) =>
      `queue-view__filter-button min-h-11 rounded-full px-4 py-2 text-sm font-bold ${
        active ? 'bg-emerald-700 text-white' : 'bg-slate-200 text-slate-700'
      }`;

    row.appendChild(
      el(
        'button',
        {
          type: 'button',
          class: buttonClass(selectedTable === null),
          'data-action': 'filter-table',
          'data-table': '',
        },
        [messages.queue.allTables],
      ),
    );

    for (const table of tables) {
      row.appendChild(
        el(
          'button',
          {
            type: 'button',
            class: buttonClass(selectedTable === table),
            'data-action': 'filter-table',
            'data-table': table,
          },
          [messages.queue.tableButton(table)],
        ),
      );
    }

    return row;
  }

  function renderNow() {
    const state = store.getState();
    const nowMs = Date.now();
    const visible = visibleOrders(state.queue.orders, state.payment.pending);
    const tables = activeTables(visible);

    if (selectedTable !== null && !tables.includes(selectedTable)) {
      selectedTable = null;
    }

    const ordered = selectedTable === null
      ? groupOrdersByTable(visible)
      : visible.filter((order) => String(order.table_number) === selectedTable);

    const cardModels = ordered.map((order) => toCardModel(order));
    const visibleIds = new Set(cardModels.map((m) => m.id));

    for (const [id, node] of cardNodes) {
      if (!visibleIds.has(id)) {
        node.remove();
        cardNodes.delete(id);
      }
    }

    const statusText = emptyOrConnectingText(state.sync, cardModels.length);

    root.replaceChildren();

    const ribbon = ribbonText(state.sync);
    if (ribbon) {
      root.appendChild(
        el(
          'p',
          { class: 'queue-view__ribbon rounded-lg bg-red-100 px-3 py-1 text-xs font-bold text-red-800', role: 'status' },
          [ribbon],
        ),
      );
    }

    if (statusText !== null) {
      root.appendChild(
        el(
          'p',
          { class: 'queue-view__status text-center text-lg font-semibold text-slate-500', role: 'status' },
          [statusText],
        ),
      );
      return;
    }

    if (tables.length > 0) {
      root.appendChild(buildFilterRow(tables));
    }

    if (selectedTable !== null) {
      const { total, isComplete } = tableTotal(ordered);
      root.appendChild(
        el(
          'p',
          { class: 'queue-view__table-total text-lg font-bold text-slate-900', role: 'status' },
          [messages.queue.tableTotal(total)],
        ),
      );
      if (!isComplete) {
        root.appendChild(
          el(
            'p',
            { class: 'queue-view__table-total-warning text-xs font-semibold text-amber-700', role: 'status' },
            [messages.queue.tableTotalIncomplete],
          ),
        );
      }
    }

    const grid = el('div', {
      class: 'queue-view__grid grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4',
    });

    for (const cardModel of cardModels) {
      let node = cardNodes.get(cardModel.id);
      if (!node) {
        node = createCardNode(cardModel, nowMs);
        cardNodes.set(cardModel.id, node);
      } else {
        updateCardNode(node, cardModel, nowMs);
      }
      grid.appendChild(node); // reorders an existing child in place, no rebuild.
    }
    root.appendChild(grid);
  }

  function dispatchFromEvent(event) {
    const payTarget = event.target.closest ? event.target.closest('[data-action="pay"]') : null;
    if (payTarget && root.contains(payTarget)) {
      const orderId = payTarget.dataset.orderId;
      if (orderId) handlers.onMarkPaid(orderId);
      return;
    }

    const filterTarget = event.target.closest ? event.target.closest('[data-action="filter-table"]') : null;
    if (filterTarget && root.contains(filterTarget)) {
      const table = filterTarget.dataset.table;
      selectedTable = table === '' ? null : table;
      renderNow();
    }
  }

  renderNow();
  root.addEventListener('click', dispatchFromEvent);
  const unsubQueue = select(store, (state) => state.queue, renderNow);
  const unsubPayment = select(store, (state) => state.payment, renderNow);
  const unsubSync = select(store, (state) => state.sync, renderNow);

  return function unmount() {
    unsubQueue();
    unsubPayment();
    unsubSync();
    root.removeEventListener('click', dispatchFromEvent);
    cardNodes.clear();
  };
}
