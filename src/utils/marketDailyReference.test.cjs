'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mergeMarketDailyReference, retainMarketDailyReference, validateMarketDailyReference } = require('./marketDailyReference.cjs');
const NOW = Date.parse('2026-09-22T17:00:00Z');

function snapshot(at = NOW) {
  const evidence = { asOf: new Date(at).toISOString(), expiresAt: new Date(at + 1_200_000).toISOString(),
    status: 'delayed', marketDate: '2026-09-22', source: 'Yahoo Finance', sourceUrl: 'https://finance.yahoo.com/quote/AAPL/' };
  const winner = { ...evidence, ticker: 'AAPL', name: 'Apple', changePercent: 1 };
  return { ...evidence, status: 'available', quoteStatus: 'delayed',
    universe: { count: 503, asOf: '2026-09-21' },
    coverage: { quotes: 503, total: 503, history50: 503, history200: 500, year: 495, intradayVolume: 400, intradayGain: 400, reversalComparisons: 503, sectorComparisons: 490 },
    breadth: { advancing: 300, declining: 200, unchanged: 3, medianReturn: 0.2, above50Pct: 60, above200Pct: 65, newHighs: 3, newLows: 2 },
    winners: [winner], losers: [], leadership: { lift: { ...winner, contributionPp: 0.2 } },
    outliers: { relativeVolume: { ...winner, ratio: 2.2 } },
    outlierDetails: { relativeVolume: [{ ...winner, ratio: 2.2 }], unusualGain: [], reversal: [], againstSector: [] },
  };
}

test('expired, failed, and long-aged references preserve values, source date and denominator', () => {
  const first = snapshot();
  const future = NOW + 180 * 86_400_000;
  for (const result of [validateMarketDailyReference(first, future), retainMarketDailyReference(first, NOW), mergeMarketDailyReference(first, null, future)]) {
    assert.equal(result.retained, true);
    assert.equal(result.asOf, first.asOf);
    assert.equal(result.expiresAt, first.expiresAt);
    assert.equal(result.marketDate, first.marketDate);
    assert.equal(result.breadth.advancing, 300);
    assert.equal(result.referenceObservations.breadth.coverage.total, 503);
    assert.equal(result.referenceObservations.breadth.universe.asOf, '2026-09-21');
    assert.equal(result.winners[0].retained, true);
    assert.equal(result.executable, false);
  }
});

test('partial refresh merges independent complete calculations with their own dated evidence', () => {
  const previous = snapshot();
  const next = snapshot(NOW + 60_000);
  next.status = 'partial';
  next.coverage.quotes = 502;
  next.coverage.intradayVolume = 0;
  next.breadth = { advancing: null, declining: null, medianReturn: null, above50Pct: null, above200Pct: null, newHighs: null, newLows: null };
  next.winners = [];
  next.leadership = {};
  next.outliers = { relativeVolume: null };
  next.outlierDetails.relativeVolume = [];
  const result = mergeMarketDailyReference(previous, next, NOW + 60_000);
  assert.equal(result.breadth.advancing, 300);
  assert.equal(result.winners[0].ticker, 'AAPL');
  assert.equal(result.outliers.relativeVolume.ratio, 2.2);
  assert.equal(result.referenceObservations.breadth.asOf, previous.asOf);
  assert.equal(result.referenceObservations.breadth.coverage.quotes, 503);
  assert.equal(result.referenceObservations.reversal.asOf, next.asOf);
  assert.equal(result.referenceObservations.reversal.retained, false);
});

test('newer verified values replace references while an identical or older observation does not relabel them fresh', () => {
  const retained = retainMarketDailyReference(snapshot(), NOW);
  assert.equal(mergeMarketDailyReference(retained, snapshot(), NOW).retained, true);
  const older = snapshot(NOW - 60_000);
  older.breadth.advancing = 1;
  assert.equal(mergeMarketDailyReference(retained, older, NOW).breadth.advancing, 300);
  const next = snapshot(NOW + 60_000);
  next.breadth.advancing = 301;
  const result = mergeMarketDailyReference(retained, next, NOW + 60_000);
  assert.equal(result.breadth.advancing, 301);
  assert.equal(result.retained, false);
  assert.equal(result.referenceObservations.breadth.asOf, next.asOf);
});

test('complete empty rankings replace old candidates but uncovered empty lists cannot erase them', () => {
  const next = snapshot(NOW + 60_000);
  next.winners = [];
  next.outliers.relativeVolume = null;
  next.outlierDetails.relativeVolume = [];
  const result = mergeMarketDailyReference(snapshot(), next, NOW + 60_000);
  assert.deepEqual(result.winners, []);
  assert.equal(result.outliers.relativeVolume, null);
  assert.equal(result.referenceObservations.relativeVolume.asOf, next.asOf);
});

test('each ranked group retains its own expired observations when another group remains current', () => {
  const next = snapshot();
  next.expiresAt = new Date(NOW + 3_600_000).toISOString();
  const result = validateMarketDailyReference(next, NOW + 1_200_000);
  assert.equal(result.referenceObservations.movers.retained, true);
  assert.equal(result.referenceObservations.breadth.retained, false);
  assert.equal(result.winners[0].retained, true);
});

test('an old retained metric does not mark a newer independently verified group retained', () => {
  const previous = snapshot(NOW - 1_200_000);
  const next = snapshot();
  next.breadth.above50Pct = null;
  const result = mergeMarketDailyReference(previous, next, NOW);
  assert.equal(result.retained, true);
  assert.equal(result.referenceObservations.above50.retained, true);
  assert.equal(result.referenceObservations.movers.retained, false);
  assert.equal(result.winners[0].retained, undefined);
});

test('unverified, corrupted and flagged incoming observations never replace a verified reference', () => {
  const previous = snapshot();
  for (const flag of ['mock', 'seeded', 'stale', 'cacheOnly', 'offline', 'disconnected', 'portfolioDerived', 'modelOnly', 'inferred']) {
    const incoming = snapshot(NOW + 60_000);
    incoming.winners[0][flag] = true;
    assert.equal(validateMarketDailyReference(incoming, NOW + 60_000).winners[0], null, flag);
    const merged = mergeMarketDailyReference(previous, incoming, NOW + 60_000);
    assert.equal(merged.winners[0].asOf, previous.asOf, flag);
    assert.equal(merged.referenceObservations.breadth.asOf, incoming.asOf, flag);
    assert.equal(validateMarketDailyReference({ ...incoming, [flag]: true }, NOW + 60_000), null, flag);
  }
  for (const field of ['source', 'sourceUrl', 'status', 'marketDate', 'asOf']) {
    const incoming = snapshot();
    delete incoming.winners[0][field];
    const validated = validateMarketDailyReference(incoming, NOW);
    assert.equal(validated.winners[0], null, field);
    assert.equal(validated.breadth.advancing, 300, field);
  }
});

test('invalid rank evidence preserves its slot and independently sourced following securities', () => {
  const incoming = snapshot();
  incoming.winners.push({ ...incoming.winners[0], ticker: 'MSFT', name: 'Microsoft' });
  incoming.winners[0].sourceUrl = null;
  const validated = validateMarketDailyReference(incoming, NOW);
  assert.equal(validated.winners[0], null);
  assert.equal(validated.winners[1].ticker, 'MSFT');
  assert.equal(validated.referenceObservations.movers, undefined);
});
