const { test } = require('node:test');
const assert = require('node:assert/strict');
const { foldRiskRangeWatch, rangeHistory, rangeZone, sizeNotesFromEvents } = require('./riskRangeWatch.cjs');

const NOW = new Date('2026-11-09T16:00:00Z');
const range = { symbol: 'DRAM', low: 35.12, high: 46.65, source: 'ETF Pro', sourceId: 'etf-pro', asOf: '2026-11-08', cadence: 'weekly' };
const fold = (stored, price, positions = null, extra = {}) => foldRiskRangeWatch(stored, { marketDate: '2026-11-09', ranges: [range], prices: { DRAM: { price, asOf: NOW.toISOString() } }, positions, now: NOW, ...extra });

test('reads thirds as the Predictive Markets bar does, and outside the range', () => {
  assert.equal(rangeZone(36, 35.12, 46.65).zone, 'bottom');
  assert.equal(rangeZone(41.75, 35.12, 46.65).zone, 'middle');
  assert.equal(rangeZone(43, 35.12, 46.65).zone, 'top');
  assert.equal(rangeZone(34, 35.12, 46.65).zone, 'below');
  assert.equal(rangeZone(47, 35.12, 46.65).zone, 'above');
});

test('the first reading sets the zone and raises nothing', () => {
  const { watch } = fold(null, 36);
  assert.equal(watch.lines.DRAM.zone, 'bottom');
  assert.deepEqual(watch.lines.DRAM.entries, []);
});

test('a zone entry is recorded once the price clears the line', () => {
  const first = fold(null, 41).watch;
  const entered = fold(first, 43).watch;
  assert.equal(entered.lines.DRAM.zone, 'top');
  assert.equal(entered.lines.DRAM.entries.at(-1).from, 'middle');
});

test('a price sitting on a line does not flip the zone', () => {
  const top = fold(null, 43).watch;
  // 42.74 reads middle, but is within 2% of the width of the 66% line.
  const near = fold(top, 42.6).watch;
  assert.equal(rangeZone(42.6, 35.12, 46.65).zone, 'middle');
  assert.equal(near.lines.DRAM.zone, 'top');
  assert.deepEqual(near.lines.DRAM.entries, []);
});

test('a short added at the low end is recorded; one added mid-range is not', () => {
  const start = fold(null, 36, { DRAM: -21.25 }).watch;
  const seen = fold(start, 36.1, { DRAM: -138.25 }).watch;
  assert.deepEqual(seen.lines.DRAM.adds, []);
  const added = fold(seen, 36.1, { DRAM: -138.25 }).watch;
  assert.deepEqual(added.lines.DRAM.adds.map(add => [add.from, add.to, add.zone]), [[-21.25, -138.25, 'bottom']]);
  assert.equal(fold(added, 36.1, { DRAM: -138.25 }).watch.lines.DRAM.adds.length, 1);
  const middle = fold(null, 41, { DRAM: -21.25 }).watch;
  const midSeen = fold(middle, 41, { DRAM: -138.25 }).watch;
  assert.deepEqual(fold(midSeen, 41, { DRAM: -138.25 }).watch.lines.DRAM.adds, []);
});

test('an add goes once the book no longer shows that size; an unverified book keeps it', () => {
  const add = { date: '2026-11-09', from: -100, to: -200, price: 36, pct: 7.6, zone: 'bottom', at: NOW.toISOString() };
  const stored = { ...fold(null, 36, { DRAM: -100 }).watch };
  stored.lines = { DRAM: { ...stored.lines.DRAM, adds: [add] } };
  assert.deepEqual(fold(stored, 36, null).watch.lines.DRAM.adds, [add]);
  assert.deepEqual(fold(stored, 36, { DRAM: -100 }).watch.lines.DRAM.adds, []);
});

test('one scan reading a position at double is not an add', () => {
  const start = fold(null, 36, { DRAM: -100 }).watch;
  const doubled = fold(start, 36, { DRAM: -200 });
  assert.equal(doubled.changed, true);
  assert.deepEqual(doubled.watch.quantities, { DRAM: -100 });
  const back = fold(doubled.watch, 36, { DRAM: -100 }).watch;
  const after = fold(back, 36, { DRAM: -100 }).watch;
  assert.deepEqual(after.lines.DRAM.adds, []);
  assert.deepEqual(after.quantities, { DRAM: -100 });
});

test('covering at the low end and an unverified book are not adds', () => {
  const start = fold(null, 36, { DRAM: -138.25 }).watch;
  assert.deepEqual(fold(start, 36, { DRAM: -21.25 }).watch.lines.DRAM.adds, []);
  const blind = fold(start, 36, null).watch;
  assert.deepEqual(blind.lines.DRAM.adds, []);
  assert.deepEqual(blind.quantities, { DRAM: -138.25 });
});

test('a position opened in the wrong zone counts, once the book is known', () => {
  const start = fold(null, 36, { AAPL: 10 }).watch;
  const seen = fold(start, 36, { AAPL: 10, DRAM: -50 }).watch;
  assert.equal(fold(seen, 36, { AAPL: 10, DRAM: -50 }).watch.lines.DRAM.adds.length, 1);
});

test('a partial read keeps the lines it missed; price-only moves do not rewrite the store', () => {
  const start = fold(null, 41).watch;
  assert.ok(foldRiskRangeWatch(start, { marketDate: '2026-11-09', ranges: [], complete: false, now: NOW }).watch.lines.DRAM);
  assert.equal(fold(start, 41.5).changed, false);
});

const alert = (entityId, excerpt, extra = {}) => ({ productKey: 'real-time-alert', qualityStatus: 'validated', marketDate: '2026-11-09', entityId, excerpt, sourceMessageId: '1a1c0f0dd5950feb', ...extra });

test('reads Keith stating his own size for the ticker the row is indexed under', () => {
  const excerpt = 'Coaching Notes: Covered my DRAM down to its MIN position SIZE on Friday "Oh right you did" -New User';
  const notes = sizeNotesFromEvents([alert('DRAM', excerpt), alert('MIN', excerpt), alert('DRAM', excerpt)], { now: NOW });
  assert.deepEqual(notes.map(note => [note.symbol, note.size, note.verb, note.side]), [['DRAM', 'MIN', 'covered', 'SHORT']]);
});

test('leaves hypothetical, lowercase or other-product statements alone', () => {
  for (const event of [alert('DRAM', 'I would have covered my DRAM down to its MIN size'), alert('POSITION', 'Covered my position down to its MIN size'),
    alert('DRAM', 'Covered my DRAM down to its MIN size', { productKey: 'the-call' }), alert('DRAM', 'Covered my DRAM down to its MIN size', { marketDate: '2026-10-01' })]) {
    assert.deepEqual(sizeNotesFromEvents([event], { now: NOW }), []);
  }
});

test('the daily range wins a session; a weekly edition carries forward from its date', () => {
  const rows = rangeHistory({ bars: [{ date: '2026-11-06', close: 39.29 }, { date: '2026-11-09', close: 41.74 }, { date: '2026-10-30', close: 48 }],
    daily: [{ date: '2026-11-06', low: 38, high: 42 }], weekly: [{ date: '2026-11-01', low: 44.06, high: 54.11 }, { date: '2026-11-08', low: 35.12, high: 46.65 }] });
  assert.deepEqual(rows.map(row => [row.date, row.low, row.cadence]), [['2026-10-30', null, null], ['2026-11-06', 38, 'daily'], ['2026-11-09', 35.12, 'weekly']]);
});
