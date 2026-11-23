'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPortfolioRiskMatrixHandler } = require('./portfolioRiskMatrix.cjs');
const { createClassificationPiece } = require('../services/securityUniverse/pieces/classification.cjs');

const response = () => ({ code: 200, headers: {}, set(name, value) { this.headers[name] = value; }, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } });
const bars = (scale) => {
  let close = 100;
  return Array.from({ length: 100 }, (_, index) => {
    close *= 1 + Math.sin(index * 1.3) * 0.01 * scale;
    return { date: new Date(Date.UTC(2026, 0, 1 + index)).toISOString().slice(0, 10), adjustedClose: close, close };
  });
};
const handler = (loadHistory) => createPortfolioRiskMatrixHandler({
  classification: createClassificationPiece({ table: { source: 'Reviewed', reviewedAt: '2026-11-22', securities: { TLT: ['Fixed income', 'Rates', 'US'] } } }),
  loadHistory, mapConcurrent: (items, _limit, run) => Promise.all(items.map(run)),
});

test('returns each position with its labels and risk numbers', async () => {
  const res = response();
  await handler(async symbol => ({ bars: bars(symbol === 'SPY' ? 1 : 2) }))({ body: { positions: [{ symbol: 'tlt', weightPct: 3.5 }, { symbol: 'ZZZ', weightPct: -1 }] } }, res);
  assert.equal(res.code, 200);
  assert.equal(res.body.executable, false);
  const [tlt, unlabelled] = res.body.rows;
  assert.deepEqual([tlt.assetClass, tlt.group, tlt.region, tlt.labelledAt], ['Fixed income', 'Rates', 'US', '2026-11-22']);
  assert.ok(Math.abs(tlt.beta - 2) < 0.05);
  assert.deepEqual([unlabelled.assetClass, unlabelled.group, unlabelled.region], [null, null, null]);
});

test('a failed history leaves that position unmeasured and keeps the rest', async () => {
  const res = response();
  await handler(async (symbol) => { if (symbol === 'ZZZ') throw new Error('down'); return { bars: bars(1) }; })({ body: { positions: [{ symbol: 'TLT', weightPct: 3 }, { symbol: 'ZZZ', weightPct: 1 }] } }, res);
  assert.equal(res.body.status, 'partial');
  assert.equal(res.body.rows[1].reason, 'insufficient-history');
});

test('rejects a missing, malformed or oversized book before any read', async () => {
  let reads = 0;
  const run = handler(async () => { reads += 1; return { bars: [] }; });
  for (const body of [undefined, {}, { positions: [] }, { positions: [{ symbol: 'TLT;x', weightPct: 1 }] }, { positions: [{ symbol: 'TLT', weightPct: 'x' }] },
    { positions: Array.from({ length: 151 }, (_, index) => ({ symbol: `S${index}`, weightPct: 1 })) }]) {
    const res = response();
    await run({ body }, res);
    assert.equal(res.code, 400);
  }
  assert.equal(reads, 0);
});
