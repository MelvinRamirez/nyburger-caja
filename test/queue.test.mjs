import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hiddenIds, visibleOrders, toCardModel, activeTables, groupOrdersByTable, tableTotal } from '../js/queue.js';

function order(overrides = {}) {
  return {
    order_id: 'ORD-1',
    created_at: '2026-10-13 12:00:00',
    table_number: '05',
    items_summary: '2x Baleada, 1x Soda',
    order_details: null,
    customer_notes: '',
    total_amount: 100,
    status: 'Completado',
    updated_at: '2026-10-13 12:05:00',
    ...overrides,
  };
}

// --- hiddenIds ---

test('hiddenIds: collects every pending-Pagada order_id, confirmed or not', () => {
  const pending = [
    { order_id: 'A', confirmedAtSeq: null },
    { order_id: 'B', confirmedAtSeq: 7 },
  ];
  assert.deepStrictEqual(hiddenIds(pending), new Set(['A', 'B']));
});

test('hiddenIds: empty pending yields an empty set', () => {
  assert.deepStrictEqual(hiddenIds([]), new Set());
});

// --- visibleOrders ---

test('visibleOrders: preserves server order exactly, never re-sorted or reversed (FIFO Card Rendering)', () => {
  const orders = [order({ order_id: 'C' }), order({ order_id: 'A' }), order({ order_id: 'B' })];
  const result = visibleOrders(orders, []);
  assert.deepStrictEqual(
    result.map((o) => o.order_id),
    ['C', 'A', 'B'],
  );
});

test('visibleOrders: filters out orders whose id is in the pending-Pagada set', () => {
  const orders = [order({ order_id: 'A' }), order({ order_id: 'B' }), order({ order_id: 'C' })];
  const pending = [{ order_id: 'B', confirmedAtSeq: null }];
  const result = visibleOrders(orders, pending);
  assert.deepStrictEqual(
    result.map((o) => o.order_id),
    ['A', 'C'],
  );
});

test('visibleOrders: a confirmed-but-not-yet-purged pending entry still hides the order', () => {
  const orders = [order({ order_id: 'A' })];
  const pending = [{ order_id: 'A', confirmedAtSeq: 5 }];
  assert.deepStrictEqual(visibleOrders(orders, pending), []);
});

// --- activeTables ---

test('activeTables: distinct table_number values, ascending numerically', () => {
  const orders = [
    order({ order_id: 'A', table_number: '10' }),
    order({ order_id: 'B', table_number: '2' }),
    order({ order_id: 'C', table_number: '10' }),
    order({ order_id: 'D', table_number: '5' }),
  ];
  assert.deepStrictEqual(activeTables(orders), ['2', '5', '10']);
});

test('activeTables: empty orders yields empty list', () => {
  assert.deepStrictEqual(activeTables([]), []);
});

test('activeTables: falls back to alphabetical compare for non-numeric table identifiers', () => {
  const orders = [order({ order_id: 'A', table_number: 'B1' }), order({ order_id: 'B', table_number: 'A1' })];
  assert.deepStrictEqual(activeTables(orders), ['A1', 'B1']);
});

// --- groupOrdersByTable ---

test('groupOrdersByTable: groups by table_number, groups ascending, FIFO preserved within a group', () => {
  const orders = [
    order({ order_id: 'A', table_number: '5' }),
    order({ order_id: 'B', table_number: '2' }),
    order({ order_id: 'C', table_number: '5' }),
    order({ order_id: 'D', table_number: '2' }),
  ];
  const result = groupOrdersByTable(orders);
  assert.deepStrictEqual(
    result.map((o) => o.order_id),
    ['B', 'D', 'A', 'C'],
  );
});

test('groupOrdersByTable: does not mutate the input array', () => {
  const orders = [order({ order_id: 'A', table_number: '5' }), order({ order_id: 'B', table_number: '2' })];
  const copy = [...orders];
  groupOrdersByTable(orders);
  assert.deepStrictEqual(orders, copy);
});

test('groupOrdersByTable: empty orders yields empty list', () => {
  assert.deepStrictEqual(groupOrdersByTable([]), []);
});

// --- tableTotal ---

test('tableTotal: sums total_amount across orders and reports complete', () => {
  const orders = [
    order({ order_id: 'A', total_amount: 100 }),
    order({ order_id: 'B', total_amount: 50.5 }),
  ];
  assert.deepStrictEqual(tableTotal(orders), { total: 150.5, isComplete: true });
});

test('tableTotal: empty orders yields a zero complete total', () => {
  assert.deepStrictEqual(tableTotal([]), { total: 0, isComplete: true });
});

test('tableTotal: excludes an order with a non-finite total_amount and flags incomplete', () => {
  const orders = [
    order({ order_id: 'A', total_amount: 100 }),
    order({ order_id: 'B', total_amount: 'not-a-number' }),
  ];
  assert.deepStrictEqual(tableTotal(orders), { total: 100, isComplete: false });
});

test('tableTotal: a numeric string total_amount is parsed and included', () => {
  const orders = [order({ order_id: 'A', total_amount: '75.25' })];
  assert.deepStrictEqual(tableTotal(orders), { total: 75.25, isComplete: true });
});

// --- toCardModel: Payment Card Content ---

test('toCardModel: card shows table, items, notes and total', () => {
  const model = toCardModel(
    order({
      table_number: '03',
      order_details: [
        { item_id: 'I1', name: 'Milanesa', quantity: 2 },
        { item_id: 'I2', name: 'Coca-Cola', quantity: 1 },
      ],
      customer_notes: 'sin cebolla',
      total_amount: 245.0,
    }),
  );
  assert.equal(model.table, '03');
  assert.deepStrictEqual(model.items, [
    { name: 'Milanesa', quantity: 2 },
    { name: 'Coca-Cola', quantity: 1 },
  ]);
  assert.equal(model.notes, 'sin cebolla');
  assert.equal(model.totalAmount, 245.0);
});

test('toCardModel: order_details null falls back to items_summary verbatim', () => {
  const model = toCardModel(order({ order_details: null, items_summary: '2x Milanesa, 1x Coca-Cola' }));
  assert.equal(model.items, null);
  assert.equal(model.summaryText, '2x Milanesa, 1x Coca-Cola');
});

test('toCardModel: order_details empty array falls back to items_summary', () => {
  const model = toCardModel(order({ order_details: [] }));
  assert.equal(model.items, null);
  assert.equal(model.summaryText, '2x Baleada, 1x Soda');
});

test('toCardModel: order_details with a malformed entry (missing quantity) falls back entirely', () => {
  const model = toCardModel(order({ order_details: [{ item_id: 'I1', name: 'Baleada' }] }));
  assert.equal(model.items, null);
  assert.equal(model.summaryText, '2x Baleada, 1x Soda');
});

test('toCardModel: order_details with a non-array value falls back to items_summary', () => {
  const model = toCardModel(order({ order_details: 'not-an-array' }));
  assert.equal(model.items, null);
  assert.equal(model.summaryText, '2x Baleada, 1x Soda');
});

test('toCardModel: order_details with a malformed entry among well-formed ones still falls back entirely', () => {
  const model = toCardModel(
    order({
      order_details: [
        { item_id: 'I1', name: 'Baleada', quantity: 2 },
        { item_id: 'I2', name: '', quantity: 1 }, // empty name: malformed
      ],
    }),
  );
  assert.equal(model.items, null);
});

test('toCardModel: items_summary itself missing/non-string yields summaryText null too', () => {
  const model = toCardModel(order({ order_details: null, items_summary: undefined }));
  assert.equal(model.items, null);
  assert.equal(model.summaryText, null);
});

// --- toCardModel: notes ---

test('toCardModel: trims customer_notes', () => {
  const model = toCardModel(order({ customer_notes: '  sin cebolla  ' }));
  assert.equal(model.notes, 'sin cebolla');
});

test('toCardModel: blank/whitespace-only notes become null', () => {
  assert.equal(toCardModel(order({ customer_notes: '' })).notes, null);
  assert.equal(toCardModel(order({ customer_notes: '   ' })).notes, null);
});

test('toCardModel: non-string customer_notes becomes null', () => {
  assert.equal(toCardModel(order({ customer_notes: null })).notes, null);
});

// --- toCardModel: never rendered as HTML (this module only carries plain strings) ---

test('toCardModel: notes and item text are carried as plain strings, never markup/HTML', () => {
  const model = toCardModel(
    order({
      customer_notes: '<img src=x onerror=alert(1)>',
      items_summary: '<i>2x Baleada</i>',
      order_details: null,
    }),
  );
  assert.equal(typeof model.notes, 'string');
  assert.equal(model.notes, '<img src=x onerror=alert(1)>');
  assert.equal(model.summaryText, '<i>2x Baleada</i>');
});

test('toCardModel: carries id, table (as string) and updatedAtMs', () => {
  const model = toCardModel(order({ order_id: 'ORD-9', table_number: 7, updated_at: '2026-10-13 12:05:00' }));
  assert.equal(model.id, 'ORD-9');
  assert.equal(model.table, '7');
  assert.equal(typeof model.updatedAtMs, 'number');
});

test('toCardModel: unparseable updated_at yields updatedAtMs null', () => {
  const model = toCardModel(order({ updated_at: 'garbage' }));
  assert.equal(model.updatedAtMs, null);
});

// --- toCardModel: total_amount ---

test('toCardModel: total_amount as a numeric string is parsed to a finite number', () => {
  const model = toCardModel(order({ total_amount: '245.50' }));
  assert.equal(model.totalAmount, 245.5);
});

test('toCardModel: non-numeric total_amount yields totalAmount null', () => {
  const model = toCardModel(order({ total_amount: 'not-a-number' }));
  assert.equal(model.totalAmount, null);
});
