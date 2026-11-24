const test = require('node:test');
const assert = require('node:assert/strict');
const { createDayActivityLoader, summarizeFills, summarizeSettlements } = require('./predictionDayActivity.cjs');

const fill = (overrides = {}) => ({ action: 'buy', side: 'no', count_fp: '100.00', no_price_dollars: '0.2000', yes_price_dollars: '0.8000',
  fee_cost: '1.50', created_time: '2026-11-23T17:08:03Z', ticker: 'KXETHD-26NOV2717-T1659.99', ...overrides });
const settlement = (overrides = {}) => ({ ticker: 'KXSILVERD-26NOV2317-T43', market_result: 'yes', revenue: 0, fee_cost: '6.50',
  yes_total_cost_dollars: '0.00', no_total_cost_dollars: '123.50', settled_time: '2026-11-23T23:01:14Z', ...overrides });

test('fills are summed per market, side and action at the price paid on their own side', () => {
  const summary = summarizeFills([fill(), fill({ count_fp: '50.00', no_price_dollars: '0.3000' }),
    fill({ action: 'sell', side: 'yes', count_fp: '10', yes_price_dollars: '0.6000', fee_cost: '0.25' })]);
  assert.equal(summary.count, 3);
  assert.equal(summary.bought, 35);
  assert.equal(summary.sold, 6);
  assert.equal(summary.fees, 3.25);
  const bought = summary.rows.find((row) => row.action === 'buy');
  assert.deepEqual([bought.side, bought.contracts, bought.fills], ['NO', 150, 2]);
  assert.ok(Math.abs(bought.avgPrice - 35 / 150) < 1e-9);
});

test('a fill without a count or price makes the read unusable', () => {
  assert.equal(summarizeFills([fill({ count_fp: undefined })]), null);
  assert.equal(summarizeFills([fill({ no_price_dollars: undefined })]), null);
  assert.equal(summarizeFills([fill({ action: 'hold' })]), null);
});

test('a settlement is what it paid less what it cost and its fees', () => {
  const summary = summarizeSettlements([settlement(), settlement({ revenue: 20000, no_total_cost_dollars: '150.00', fee_cost: '0' })]);
  assert.equal(summary.count, 2);
  assert.equal(summary.revenue, 200);
  assert.equal(summary.cost, 273.5);
  assert.equal(summary.pnl, -130 + 50);
  assert.equal(summary.rows[0].pnl, -130);
  assert.equal(summarizeSettlements([settlement({ revenue: undefined })]), null);
});

test('the loader reads from the floor, drops rows outside it and rejects an unusable window', async () => {
  const floors = [];
  const load = createDayActivityLoader({
    loadFills: async (floor) => { floors.push(floor); return [fill(), fill({ created_time: '2026-11-22T17:00:00Z' })]; },
    loadSettlements: async () => [settlement()],
  });
  const now = new Date('2026-11-24T02:00:00Z');
  const activity = await load({ since: '2026-11-23T05:00:00Z', now });
  assert.equal(floors[0], Date.parse('2026-11-23T05:00:00Z') / 1000);
  assert.deepEqual([activity.ok, activity.fills.count, activity.settlements.count], [true, 1, 1]);
  await assert.rejects(load({ since: 'yesterday', now }), { statusCode: 400 });
  await assert.rejects(load({ since: '2026-11-01T00:00:00Z', now }), { statusCode: 400 });
  const broken = createDayActivityLoader({ loadFills: async () => [fill({ count_fp: undefined })], loadSettlements: async () => [] });
  await assert.rejects(broken({ since: '2026-11-23T05:00:00Z', now }), /could not be read/);
});
