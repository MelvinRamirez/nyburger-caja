import { elapsedMs, formatElapsed } from '../time.js';
import { messages } from '../messages.js';
import { el } from './dom.js';

const BASE_CARD_CLASS =
  'order-card flex flex-col gap-2 rounded-2xl border-2 border-slate-200 bg-white p-3 shadow-sm';

/**
 * @param {number|null} totalAmount
 * @returns {string} `'--'` when the amount is missing/non-finite.
 */
function formatTotal(totalAmount) {
  return typeof totalAmount === 'number' && Number.isFinite(totalAmount) ? totalAmount.toFixed(2) : '--';
}

function renderItems(cardModel) {
  if (Array.isArray(cardModel.items)) {
    return el(
      'ul',
      { class: 'order-card__items flex flex-col gap-0.5 text-sm text-slate-800', 'data-role': 'items' },
      cardModel.items.map((item) => el('li', {}, [`${item.quantity}x ${item.name}`])),
    );
  }
  // `caja-payment-queue` "order_details null falls back to items_summary
  // verbatim": rendered as plain text via `textContent`, never HTML.
  return el('p', { class: 'order-card__summary text-sm text-slate-800', 'data-role': 'items' }, [
    cardModel.summaryText || '',
  ]);
}

function renderNotes(cardModel) {
  if (cardModel.notes === null) return null;
  return el(
    'p',
    {
      class: 'order-card__notes rounded-lg bg-amber-100 px-2 py-1 text-xs font-semibold text-amber-900',
      'data-role': 'notes',
    },
    [cardModel.notes],
  );
}

/**
 * Builds a new card DOM node from scratch for `cardModel`. Used by
 * `queue-view` the first time a given `order_id` becomes visible; every
 * subsequent poll that still contains the same `order_id` reuses this exact
 * node (`updateCardNode`) instead of rebuilding it, so there is no flicker
 * and the "Pagada" touch target never moves under the cashier's thumb.
 *
 * @param {{ id: string, table: string, updatedAtMs: number|null,
 *   items: {name: string, quantity: number}[]|null, summaryText: string|null,
 *   notes: string|null, totalAmount: number|null }} cardModel
 * @param {number} nowMs
 * @returns {HTMLElement}
 */
export function createCardNode(cardModel, nowMs) {
  const elapsed = elapsedMs(cardModel.updatedAtMs, nowMs);

  return el(
    'article',
    { class: BASE_CARD_CLASS, 'data-order-id': cardModel.id, 'data-role': 'card' },
    [
      el('header', { class: 'order-card__header flex items-center justify-between gap-2' }, [
        el('span', { class: 'order-card__table text-4xl font-black text-slate-900', 'data-role': 'table' }, [
          cardModel.table,
        ]),
        el('span', { class: 'order-card__timer text-sm font-mono text-slate-500', 'data-role': 'timer' }, [
          formatElapsed(elapsed),
        ]),
      ]),
      renderItems(cardModel),
      renderNotes(cardModel),
      el('p', { class: 'order-card__total text-right text-xl font-bold text-slate-900', 'data-role': 'total' }, [
        formatTotal(cardModel.totalAmount),
      ]),
      el(
        'button',
        {
          type: 'button',
          class:
            'order-card__pay min-h-16 w-full rounded-xl bg-emerald-600 font-bold text-lg text-white active:bg-emerald-700',
          'data-action': 'pay',
          'data-order-id': cardModel.id,
        },
        [messages.payment.payButton],
      ),
    ].filter(Boolean),
  );
}

/**
 * Recomputes only the live elapsed-time text, in place. Caja cards have no
 * urgency-tier coloring (unlike the KDS); `queue-view` recomputes this once
 * per poll (~10 s cadence), which is sufficient granularity for a cashier
 * screen — there is no dedicated ticker module for `foodc-caja` (see
 * design.md's "File Changes" table for the new repo, which lists no
 * `ticker.js`).
 *
 * @param {HTMLElement} node
 * @param {{ updatedAtMs: number|null }} cardModel
 * @param {number} nowMs
 */
export function updateTimer(node, cardModel, nowMs) {
  const elapsed = elapsedMs(cardModel.updatedAtMs, nowMs);
  const timerEl = node.querySelector('[data-role="timer"]');
  if (timerEl) timerEl.textContent = formatElapsed(elapsed);
}

/**
 * Refreshes a REUSED card node's full content (table, items/summary, notes,
 * total) against a possibly-updated `cardModel` for the same `order_id`,
 * plus the elapsed timer. Called by `queue-view` once per poll for every
 * still-visible `order_id`, instead of replacing the node.
 *
 * @param {HTMLElement} node
 * @param {{ id: string, table: string, updatedAtMs: number|null,
 *   items: {name: string, quantity: number}[]|null, summaryText: string|null,
 *   notes: string|null, totalAmount: number|null }} cardModel
 * @param {number} nowMs
 */
export function updateCardNode(node, cardModel, nowMs) {
  const tableEl = node.querySelector('[data-role="table"]');
  if (tableEl) tableEl.textContent = cardModel.table;

  const itemsEl = node.querySelector('[data-role="items"]');
  const replacementItems = renderItems(cardModel);
  if (itemsEl) itemsEl.replaceWith(replacementItems);

  const notesEl = node.querySelector('[data-role="notes"]');
  const nextNotes = renderNotes(cardModel);
  if (notesEl && nextNotes) {
    notesEl.replaceWith(nextNotes);
  } else if (notesEl && !nextNotes) {
    notesEl.remove();
  } else if (!notesEl && nextNotes) {
    const totalEl = node.querySelector('[data-role="total"]');
    node.insertBefore(nextNotes, totalEl);
  }

  const totalEl = node.querySelector('[data-role="total"]');
  if (totalEl) totalEl.textContent = formatTotal(cardModel.totalAmount);

  updateTimer(node, cardModel, nowMs);
}
