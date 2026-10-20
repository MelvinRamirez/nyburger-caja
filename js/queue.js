import { parseServerStamp } from './time.js';

/**
 * @param {import('./payment.js').PendingPayment[]} pending
 * @returns {Set<string>} every pending-Pagada order_id, confirmed or not.
 */
export function hiddenIds(pending) {
  const ids = new Set();
  for (const entry of pending) {
    if (entry && typeof entry.order_id === 'string') ids.add(entry.order_id);
  }
  return ids;
}

/**
 * Filters hidden (pending-Pagada) orders out of the server list, preserving
 * the server's array order exactly (never re-sorted). Implements
 * `caja-payment-queue` "Pending-Pagada Filtering of Poll Results".
 *
 * @param {object[]} orders
 * @param {import('./payment.js').PendingPayment[]} pending
 * @returns {object[]}
 */
export function visibleOrders(orders, pending) {
  const hidden = hiddenIds(pending);
  return orders.filter((order) => !hidden.has(order.order_id));
}

function isWellFormedItem(item) {
  return (
    item !== null &&
    typeof item === 'object' &&
    typeof item.name === 'string' &&
    item.name.length > 0 &&
    typeof item.quantity === 'number' &&
    Number.isFinite(item.quantity)
  );
}

function toFiniteNumber(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

/**
 * @param {object} order
 * @returns {{ id: string, table: string, updatedAtMs: number|null,
 *   items: {name: string, quantity: number}[]|null, summaryText: string|null,
 *   notes: string|null, totalAmount: number|null }}
 */
export function toCardModel(order) {
  // Caja cards show elapsed time since `updated_at` (the moment an order
  // became Completado), not `created_at` — see design.md "js/time.js".
  const updatedAtMs = parseServerStamp(order.updated_at);

  let items = null;
  if (
    Array.isArray(order.order_details) &&
    order.order_details.length > 0 &&
    order.order_details.every(isWellFormedItem)
  ) {
    items = order.order_details.map((it) => ({ name: it.name, quantity: it.quantity }));
  }

  // `caja-payment-queue` "order_details null falls back to items_summary
  // verbatim": whenever order_details is not a usable list, fall back to
  // items_summary verbatim rather than attempting to repair/partially read it.
  const summaryText = items === null && typeof order.items_summary === 'string' ? order.items_summary : null;

  const rawNotes = typeof order.customer_notes === 'string' ? order.customer_notes.trim() : '';
  const notes = rawNotes.length > 0 ? rawNotes : null;

  const totalAmount = toFiniteNumber(order.total_amount);

  return {
    id: order.order_id,
    table: String(order.table_number),
    updatedAtMs,
    items,
    summaryText,
    notes,
    totalAmount,
  };
}
