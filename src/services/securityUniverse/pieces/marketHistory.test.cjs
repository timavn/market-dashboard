const { test } = require('node:test');
const assert = require('node:assert/strict');
const { securitySizingReference } = require('../../../utils/securitySizingReference.js');
const { horizonStats } = require('../../../utils/securityHorizonStats.cjs');
const { createMarketHistoryPiece } = require('./marketHistory.cjs');

// A US holiday Monday: the latest completed session is Friday 2026-09-04.
const NOW = Date.parse('2026-09-07T22:00:00Z');
const source = 'Yahoo Finance chart API';
const metric = (value, observations, asOf = '2026-09-04') => ({ value, observations, source, status: 'available', asOf });
const row = (symbol, { instrumentType = 'ETF', asOf = '2026-09-04', fetchedAt = '2026-09-07T21:59:00Z' } = {}) => ({
  symbol, source, status: 'available', historicalOnly: true, executable: false, instrumentType, asOf,
  atr14: metric(2, 14, asOf), referencePrice: metric(100, 1, asOf), beta: metric(1.1, 252, asOf),
  provenance: { provider: 'Yahoo Finance', dataset: 'chart', interval: '1d', adjustedCloseRequired: true,
    security: { requestedSymbol: symbol, yahooSymbol: symbol === 'GOLD' ? 'GC=F' : symbol, fetchedAt } },
});
const payload = { source, status: 'partial', historicalOnly: true, executable: false, rows: {
  IGV: row('IGV'), GOLD: row('GOLD', { instrumentType: 'FUTURE' }), OLD: row('OLD', { instrumentType: 'EQUITY', asOf: '2026-09-03' }),
  GONE: { symbol: 'GONE', status: 'unavailable', reason: 'history_unavailable' },
} };

test('risk carries each metric with its own date and sizes only through the Positions table gate', async () => {
  const piece = createMarketHistoryPiece({ now: () => NOW, loadRiskMetrics: async () => payload, sizingReference: securitySizingReference });
  const risk = await piece.risk(['IGV', 'GOLD', 'OLD', 'GONE']);
  const igv = risk.get('IGV');
  assert.deepEqual(igv.sizing.value, { version: '2.0', minPct: 3.25, maxPct: 6.25, stopDistancePct: 4, floorApplied: false });
  assert.deepEqual([igv.atr14.value, igv.atr14.asOf, igv.atr14.fetchedAt], [2, '2026-09-04', '2026-09-07T21:59:00Z']);
  assert.equal(igv.atrPct.value, 2);
  assert.equal(igv.beta.value, 1.1);
  assert.equal(igv.status, 'available');
  // A futures contract is sized per contract, not by this band.
  assert.deepEqual([risk.get('GOLD').sizing.status, risk.get('GOLD').sizing.reason], ['unavailable', 'Contract-specific sizing required']);
  assert.equal(risk.get('GOLD').instrumentType.yahooSymbol, 'GC=F');
  assert.match(risk.get('OLD').sizing.reason, /Latest completed daily history needed/);
  assert.equal(risk.get('GONE').status, 'unavailable');
  assert.equal(risk.get('GONE').atr14.reason, 'history_unavailable');
});

test('history older than an hour is not sized, and a failed load leaves risk unavailable', async () => {
  const old = { ...payload, rows: { IGV: row('IGV', { fetchedAt: '2026-09-07T20:00:00Z' }) } };
  const stale = await createMarketHistoryPiece({ now: () => NOW, loadRiskMetrics: async () => old, sizingReference: securitySizingReference }).risk(['IGV']);
  assert.deepEqual([stale.get('IGV').sizing.status, stale.get('IGV').sizing.reason], ['unavailable', 'Refresh daily history']);
  const failed = await createMarketHistoryPiece({ loadRiskMetrics: async () => { throw new Error('Yahoo offline'); }, sizingReference: securitySizingReference }).risk(['IGV']);
  assert.deepEqual([failed.get('IGV').status, failed.get('IGV').sizing.reason], ['unavailable', 'daily-history-unavailable']);
  const flagged = await createMarketHistoryPiece({ loadRiskMetrics: async () => ({ ...payload, cacheOnly: true }), sizingReference: securitySizingReference }).risk(['IGV']);
  assert.equal(flagged.get('IGV').status, 'unavailable');
});

test('activity reads the same bars as Inbox horizon stats, plus a 20-session Z-score and close-to-close vol', async () => {
  const bars = Array.from({ length: 300 }, (_, index) => {
    const close = 100 + Math.sin(index / 7) * 5 + index * 0.05;
    const date = new Date(Date.UTC(2025, 6, 1) + index * 86400000).toISOString().slice(0, 10);
    return { date, timestamp: Date.parse(`${date}T20:00:00Z`) / 1000, open: close, high: close * 1.01, low: close * 0.99, close, adjClose: close, volume: 1000 + index };
  });
  const piece = createMarketHistoryPiece({ loadSizingHistory: async symbol => {
    if (symbol === 'BAD') throw new Error('offline');
    if (symbol === 'MOCK') return { bars, mock: true };
    return { bars, fetchedAt: '2026-09-07T21:59:00Z', instrumentType: 'ETF' };
  } });
  const activity = await piece.activity(['IGV', 'BAD', 'MOCK']);
  const young = await createMarketHistoryPiece({ loadSizingHistory: async () => ({ bars: bars.slice(-120), fetchedAt: '2026-09-07T21:59:00Z' }) }).activity(['NEW']);
  assert.equal(young.get('NEW').realizedVol.value.rv252Pct, null, 'a one-year window without a year of sessions is null, never 0');
  assert.equal(young.get('NEW').realizedVol.limitedHistory, true);
  const igv = activity.get('IGV');
  assert.deepEqual(igv.horizons.value, horizonStats(bars));
  assert.equal(igv.horizons.fetchedAt, '2026-09-07T21:59:00Z');
  assert.equal(igv.zScore20.status, 'available');
  assert.equal(typeof igv.zScore20.value, 'number');
  assert.equal(igv.realizedVol.status, 'available');
  assert.deepEqual(Object.keys(igv.realizedVol.value), ['rv21Pct', 'rv63Pct', 'rv252Pct']);
  assert.equal(activity.get('BAD').status, 'unavailable');
  assert.equal(activity.get('MOCK').horizons.reason, 'daily-history-unavailable');
});
