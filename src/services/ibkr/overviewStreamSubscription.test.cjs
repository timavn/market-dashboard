'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createOverviewStreamSubscription } = require('./overviewStreamSubscription.cjs');

const SECTOR = (symbol) => ({ symbol, name: symbol, yahooSymbol: symbol });
const SPX = { symbol: 'SPX', provider: 'auto', ibkrSymbol: 'SPX', yahooSymbol: '^GSPC', conId: 416904, secType: 'IND', exchange: 'CBOE', currency: 'USD' };
const DJI = { symbol: 'DJI', provider: 'auto', ibkrSymbol: 'INDU', yahooSymbol: '^DJI', conId: 1935181, secType: 'IND', exchange: 'CME', currency: 'USD' };
const IXIC = { symbol: 'IXIC', provider: 'auto', ibkrSymbol: 'COMP', yahooSymbol: '^IXIC', conId: 18342287, secType: 'IND', exchange: 'NASDAQ', currency: 'USD' };
const ROWS = [
  SPX, DJI, IXIC,
  { symbol: 'NDX', provider: 'yahoo', yahooSymbol: '^NDX', secType: 'IND' },
  { symbol: 'XLK', provider: 'yahoo', yahooSymbol: 'XLK', secType: 'ETF' },
  SECTOR('XLK'), SECTOR('XLV'), SECTOR('XLV'),
  { symbol: 'CL', provider: 'yahoo', yahooSymbol: 'CL=F', secType: 'FUT' },
  { symbol: 'UST2Y', provider: 'fred', secType: 'ECONOMIC' },
];

function harness({ active = 70, max = 100, unavailable = new Set(), capacity } = {}) {
  const state = { now: 1_000_000, active, max, applied: [], timers: [], capacityReads: 0, unavailable };
  const subscription = createOverviewStreamSubscription({
    rows: () => ROWS,
    setDesiredInstruments: (instruments) => { state.applied.push(instruments.map((row) => row.symbol)); },
    readStreamCapacity: capacity || (async () => { state.capacityReads += 1; return { active: state.active, max: state.max }; }),
    isUnavailable: (row) => state.unavailable.has(row.symbol),
    now: () => state.now,
    setTimer: (callback, delay) => { const timer = { callback, delay, cleared: false }; state.timers.push(timer); return timer; },
    clearTimer: (timer) => { if (timer) timer.cleared = true; },
  });
  return { state, subscription };
}

test('subscribes the rows IBKR serves first, each once, and nothing that goes to Yahoo or FRED', async () => {
  const { state, subscription } = harness();
  await subscription.touch();
  assert.deepEqual(state.applied, [['SPX', 'DJI', 'IXIC', 'XLK', 'XLV']]);
  assert.equal(subscription.heldLines(), 5);
});

test('leaves out a row IBKR cannot quote right now, and takes it back when it can', async () => {
  const { state, subscription } = harness({ unavailable: new Set(['IXIC']) });
  await subscription.touch();
  assert.deepEqual(state.applied.at(-1), ['SPX', 'DJI', 'XLK', 'XLV']);

  // Overnight nothing ticks: every row is unavailable and no line is held.
  state.unavailable = new Set(['SPX', 'DJI', 'IXIC', 'XLK', 'XLV']);
  state.now += 60_000;
  await subscription.touch();
  assert.deepEqual(state.applied.at(-1), []);
  assert.equal(subscription.heldLines(), 0);

  state.unavailable = new Set(['IXIC']);
  state.now += 60_000;
  await subscription.touch();
  assert.deepEqual(state.applied.at(-1), ['SPX', 'DJI', 'XLK', 'XLV']);
});

test('checks the line budget at most once a minute', async () => {
  const { state, subscription } = harness();
  await subscription.touch();
  state.now += 59_000;
  await subscription.touch();
  assert.equal(state.capacityReads, 1);
  state.now += 1_000;
  await subscription.touch();
  assert.equal(state.capacityReads, 2);
});

test('the portfolio comes first: no lines are taken, or kept, without the reserve', async () => {
  // 92 lines in use by the portfolio: five more would leave three, under the reserve of five.
  const full = harness({ active: 92 });
  await full.subscription.touch();
  assert.deepEqual(full.state.applied, [[]]);
  assert.equal(full.subscription.heldLines(), 0);

  // Room at first (70 + 5), then the portfolio grows to 91 lines of its own.
  const { state, subscription } = harness({ active: 70 });
  await subscription.touch();
  assert.equal(subscription.heldLines(), 5);
  state.active = 96; // 91 portfolio lines + the 5 held here
  state.now += 60_000;
  await subscription.touch();
  assert.deepEqual(state.applied.at(-1), []);
  assert.equal(subscription.heldLines(), 0);

  // Its own five lines are not counted against it: 90 others + 5 = 95 of 100.
  const steady = harness({ active: 90 });
  await steady.subscription.touch();
  steady.state.active = 95;
  steady.state.now += 60_000;
  await steady.subscription.touch();
  assert.equal(steady.subscription.heldLines(), 5);
});

test('a missing or failed capacity reading changes nothing', async () => {
  const unknown = harness({ capacity: async () => ({}) });
  await unknown.subscription.touch();
  assert.deepEqual(unknown.state.applied, []);

  const failing = harness({ capacity: async () => { throw new Error('sidecar offline'); } });
  await failing.subscription.touch();
  assert.deepEqual(failing.state.applied, []);
  // The next request may look again after a minute.
  failing.state.now += 60_000;
  await failing.subscription.touch();
  assert.deepEqual(failing.state.applied, []);
});

test('releases the lines once the overview has not been asked for in five minutes', async () => {
  const { state, subscription } = harness();
  await subscription.touch();
  const first = state.timers.at(-1);
  assert.equal(first.delay, 5 * 60_000);

  // Each request pushes the release back.
  state.now += 30_000;
  await subscription.touch();
  assert.equal(first.cleared, true);
  const latest = state.timers.at(-1);
  assert.equal(latest.cleared, false);

  latest.callback();
  assert.deepEqual(state.applied.at(-1), []);
  assert.equal(subscription.heldLines(), 0);

  // Asked for again: subscribed again at once, without waiting out the minute.
  state.now += 1_000;
  await subscription.touch();
  assert.deepEqual(state.applied.at(-1), ['SPX', 'DJI', 'IXIC', 'XLK', 'XLV']);
});
