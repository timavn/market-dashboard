const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createStancePiece } = require('./stance.cjs');

const NOW = Date.parse('2026-10-31T15:00:00Z');
const at = date => `${date}T13:00:00.000Z`;
const book = {
  version: 2,
  rosters: { 'signal-strength:long': '2026-10-30' },
  tickers: {
    DRAM: {
      'etf-pro:long': { stance: 'EXIT_LONG', label: 'Removed Long', date: '2026-10-28', at: at('2026-10-28'), since: '2026-10-28', product: 'etf-pro', sourceUri: 'gmail://message/etf' },
      'real-time-alert': { stance: 'REDUCE_LONG', action: 'SELL-SOME', label: 'Sell-SOME', date: '2026-10-29', at: at('2026-10-29'), since: '2026-10-29', product: 'real-time-alert', sourceUri: 'gmail://message/rta' },
    },
    JPM: { 'signal-strength:short': { stance: 'SHORT', label: 'Added', date: '2026-10-29', at: at('2026-10-29'), since: '2026-10-29', product: 'signal-strength-shorts', sourceUri: 'gmail://message/ss' } },
    // Dropped off the latest roster without a removal: unknown, not a stance.
    KO: { 'signal-strength:long': { stance: 'LONG', label: 'Listed', roster: true, date: '2026-10-20', seen: '2026-10-20', since: '2026-09-01', at: at('2026-10-20'), product: 'signal-strength' } },
  },
  history: {
    DRAM: [
      { slot: 'etf-pro:long', stance: 'EXIT_LONG', label: 'Removed Long', date: '2026-10-28', at: at('2026-10-28'), product: 'etf-pro', sourceUri: 'gmail://message/etf-copy' },
      { slot: 'etf-pro:long', stance: 'LONG', label: 'Added Long', date: '2026-09-02', at: at('2026-09-02'), product: 'etf-pro', sourceUri: 'gmail://message/add' },
    ],
  },
};

test('reads every product call from the scored book, standing first, one per product, action and day', async () => {
  const piece = createStancePiece({ now: () => NOW, getScoredStanceBook: () => ({ book, scoredAt: '2026-10-31T14:59:30.000Z' }) });
  const stances = await piece.loadMany(['DRAM', 'JPM', 'KO', 'COST']);
  const dram = stances.get('DRAM').calls;
  assert.equal(dram.asOf, '2026-10-31T14:59:30.000Z');
  assert.deepEqual(dram.value.map(call => [call.product, call.action, call.date, call.bias, call.standing]), [
    ['Real-Time Alert', 'SELL SOME', '2026-10-29', 'BULLISH', true],
    ['ETF Pro', 'REMOVE', '2026-10-28', 'NEUTRAL', true],
    ['ETF Pro', 'LONG', '2026-09-02', 'BULLISH', false],
  ]);
  assert.equal(dram.value[1].sourceUri, 'gmail://message/etf', 'the standing entry wins over its history copy');
  assert.equal(dram.value[0].partial, true);
  assert.deepEqual(stances.get('JPM').calls.value, [], 'a stored Signal Strength Shorts entry is never a call');
  assert.deepEqual(stances.get('KO').calls.value, []);
  assert.deepEqual([stances.get('COST').status, stances.get('COST').calls.value], ['available', []]);
});

test('a book that has not been scored, or not recently, is unavailable', async () => {
  for (const [scored, reason] of [[null, 'stance-book-not-scored'], [{ book, scoredAt: 'never' }, 'stance-book-not-scored'],
    [{ book, scoredAt: '2026-10-31T14:50:00.000Z' }, 'stance-book-not-scored-recently']]) {
    const stances = await createStancePiece({ now: () => NOW, getScoredStanceBook: () => scored }).loadMany(['DRAM']);
    assert.deepEqual([stances.get('DRAM').status, stances.get('DRAM').calls.reason], ['unavailable', reason]);
  }
});
