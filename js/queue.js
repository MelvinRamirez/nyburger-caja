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

function tableSortKey(tableNumber) {
  const n = Number(tableNumber);
  return Number.isFinite(n) ? n : null;
}

/**
 * Compares two table numbers ascending: numerically when both parse as
 * finite numbers, falling back to a locale-aware alphabetical compare
 * otherwise (mixed numeric/non-numeric table identifiers).
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function compareTables(a, b) {
  const na = tableSortKey(a);
  const nb = tableSortKey(b);
  if (na !== null && nb !== null) return na - nb;
  return a.localeCompare(b);
}

/**
 * Distinct `table_number` values among `orders`, ascending (numeric when
 * possible, alphabetical otherwise). Used to drive the per-table filter
 * buttons, which must only show tables with currently visible orders.
 *
 * @param {object[]} orders usually the result of `visibleOrders`.
 * @returns {string[]}
 */
export function activeTables(orders) {
  const seen = new Set();
  for (const order of orders) {
    seen.add(String(order.table_number));
  }
  return [...seen].sort(compareTables);
}

/**
 * Groups `orders` by `table_number`, with groups ordered ascending (same
 * rule as `activeTables`) and orders preserved in their original relative
 * (FIFO) order within each group. Does not touch `orders` itself.
 *
 * @param {object[]} orders usually the result of `visibleOrders`.
 * @returns {object[]} a new array, grouped by table, FIFO within each group.
 */
export function groupOrdersByTable(orders) {
  const byTable = new Map();
  for (const order of orders) {
    const table = String(order.table_number);
    if (!byTable.has(table)) byTable.set(table, []);
    byTable.get(table).push(order);
  }
  const tables = [...byTable.keys()].sort(compareTables);
  return tables.flatMap((table) => byTable.get(table));
}

/**
 * Sums `total_amount` across the already-filtered orders for one table (the
 * same list rendered as cards when a table filter is active). An order
 * whose `total_amount` isn't a finite number — the same `toCardModel` null
 * case, when `order_details` is malformed and a summary fallback is used
 * instead — is excluded from the sum and flips `isComplete` to false, so
 * the caller can flag the total as possibly incomplete rather than
 * presenting it as exact.
 *
 * @param {object[]} orders orders for a single table, usually
 *   `visible.filter((order) => String(order.table_number) === selectedTable)`.
 * @returns {{ total: number, isComplete: boolean }}
 */
export function tableTotal(orders) {
  let total = 0;
  let isComplete = true;
  for (const order of orders) {
    const amount = toFiniteNumber(order.total_amount);
    if (amount === null) {
      isComplete = false;
      continue;
    }
    total += amount;
  }
  return { total, isComplete };
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
 *   notes: string|null, totalAmount: number|null, paymentStatus: string|null,
 *   kitchenStatus: string|null }}
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
    // Plain passthrough of the two fields the backend now always sends on
    // every order (`caja-order-prepay`): no extra validation here, same
    // posture as the rest of this function's non-shape-critical fields.
    paymentStatus: order.payment_status,
    kitchenStatus: order.status,
  };
}
