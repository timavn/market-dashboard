const test = require('node:test');
const assert = require('node:assert/strict');
const { buildLevelWatch, levelSymbols, marketRegime, sessionsBetween } = require('./marketLevels.cjs');

const code = (ticker, date, levels, extra = {}) => ({ ticker, date, field: 'alphaCode', sourceProduct: 'early-look', sourceLabel: 'Early Look', sourceText: `${ticker} code`, publishedAt: `${date}T11:00:00Z`, levels: { raw: null, trade: null, trend: null, unit: null, ...levels }, ...extra });
const flip = (level, date, extra = {}) => ({ date, field: 'flipLine', sourceProduct: 'top-3-things', sourceLabel: 'Top 3 Things', sourceText: 'Flip Line', levels: { level }, ...extra });
const chartId = 'a'.repeat(64);
const edition = (date, tiles, metrics) => ({ date, snapshotType: 'market-structure', schemaVersion: 'market-structure-v4', contentComplete: true, publishedAt: `${date}T11:30:00Z`, data: {
  signals: Object.entries(tiles).map(([id, value]) => ({ id, label: id, value })), charts: [{ id: chartId, sha256: chartId }],
  ...(metrics ? { chartMetrics: { spxProbableVolatilityGamma: { chartId, chartDate: date, extractionBasis: 'labeled-chart-ocr', parserVersion: 'market-structure-chart-metrics-v3', strikesInPlay: [], ...metrics } } } : {}) } });
const line = (result, id) => result.lines.find(item => item.id === id);
const MARKET_DATE = '2026-11-04';
const build = (input) => buildLevelWatch({ marketDate: MARKET_DATE, prices: { '^GSPC': 7700, '^VIX': 20, 'CL=F': 95, NVDA: 220, UST10Y: 4.8 }, ...input });

test('sessions count weekdays only', () => {
  assert.equal(sessionsBetween('2026-11-06', '2026-11-09'), 1);
  assert.equal(sessionsBetween('2026-11-04', '2026-11-04'), 0);
});

test('a code with no print in the window is new; a moved level is a change; an unmoved reprint is neither', () => {
  const first = build({ statements: { alphaCodes: [code('NVDA', MARKET_DATE, { trade: 221, trend: 218 })] } });
  assert.deepEqual([line(first, 'NVDA|trade').isNew, line(first, 'NVDA|trade').change], [true, null]);
  assert.equal(line(first, 'NVDA|trade').scope, 'security');
  const moved = build({ statements: { alphaCodes: [code('CL', '2026-11-03', { trade: 97, trend: 91 }), code('CL', MARKET_DATE, { trade: 97, trend: 92 })] } });
  assert.equal(line(moved, 'CL=F|trade').change, null);
  assert.deepEqual(line(moved, 'CL=F|trend').change, { from: 91, to: 92, fromDate: '2026-11-03', fromRaw: null });
  assert.equal(line(moved, 'CL=F|trend').isNew, false);
  assert.equal(line(moved, 'CL=F|trend').scope, 'market');
  // A print older than the window is no baseline: the next code is new, not a change.
  const stale = build({ statements: { alphaCodes: [code('CL', '2026-10-20', { trade: 80, trend: 75 }), code('CL', MARKET_DATE, { trade: 97, trend: 92 })] } });
  assert.deepEqual([line(stale, 'CL=F|trend').isNew, line(stale, 'CL=F|trend').change], [true, null]);
});

test('a code leaves the watch after the window, and the highest-priority product wins a day', () => {
  const old = build({ statements: { alphaCodes: [code('NVDA', '2026-10-27', { trade: 221, trend: 218 })] } });
  assert.equal(line(old, 'NVDA|trade'), undefined);
  const both = build({ statements: { alphaCodes: [code('CL', MARKET_DATE, { trade: 96, trend: 91 }), code('CL', MARKET_DATE, { trade: 97, trend: 92 }, { sourceProduct: 'top-3-things', sourceLabel: 'Top 3 Things' })] } });
  assert.deepEqual([line(both, 'CL=F|trade').level, line(both, 'CL=F|trade').productLabel], [97, 'Top 3 Things']);
});

test('a run-together code is split only when the live price supports it, and a level far from the price is a gap', () => {
  const split = build({ statements: { alphaCodes: [code('SPX', MARKET_DATE, { raw: '77037639' })] } });
  assert.deepEqual([line(split, '^GSPC|trade').level, line(split, '^GSPC|trend').level], [7703, 7639]);
  const unpriced = buildLevelWatch({ marketDate: MARKET_DATE, prices: {}, statements: { alphaCodes: [code('SPX', MARKET_DATE, { raw: '77037639' })] } });
  assert.equal(line(unpriced, '^GSPC|trade'), undefined);
  const far = build({ statements: { alphaCodes: [code('NVDA', MARKET_DATE, { trade: 900, trend: 218 })] } });
  assert.equal(line(far, 'NVDA|trade'), undefined);
  assert.equal(line(far, 'NVDA|trend').level, 218);
  assert.match(far.coverage.find(gap => gap.id.startsWith('quote:NVDA')).text, /NVDA Trade line 900 unwatched/);
});

test('spot-only references are not watched and read as a Systems gap', () => {
  const result = build({ statements: { alphaCodes: [code('SILVER', MARKET_DATE, { trade: 55, trend: 50 }, { referenceOnly: true })] } });
  assert.equal(result.lines.some(item => item.symbol === 'SILVER'), false);
  assert.deepEqual(result.coverage.map(gap => gap.text), ['SILVER Alpha Code unwatched — no live spot quote.']);
});

test('the board line overrides the archive and keeps its published reading, still annotated from history', () => {
  const boardLine = { id: 'CL=F|trend', symbol: 'CL=F', label: 'WTI', duration: 'trend', level: 92, marketDate: MARKET_DATE, reading: { value: 'BULLISH' } };
  const result = build({ boardLines: [boardLine], statements: { alphaCodes: [code('CL', '2026-11-03', { trade: 97, trend: 91 })] } });
  assert.equal(line(result, 'CL=F|trend').reading.value, 'BULLISH');
  assert.equal(line(result, 'CL=F|trend').printedDate, MARKET_DATE);
  assert.deepEqual(line(result, 'CL=F|trend').change, { from: 91, to: 92, fromDate: '2026-11-03', fromRaw: null });
});

test('the flip line is the newest dated source, the chart first on a tie, and reports what it replaced', () => {
  const statements = { flipLines: [flip(7726, '2026-11-02'), flip(7713, MARKET_DATE)] };
  assert.deepEqual([line(build({ statements }), '^GSPC|flip').level, line(build({ statements }), '^GSPC|flip').change.from], [7713, 7726]);
  const tied = build({ statements, marketStructure: [edition(MARKET_DATE, { spxGammaExposure: 'Negative' }, { zeroGamma: 7720, upperPvBand: 7850, lowerPvBand: 7600 })] });
  assert.deepEqual([line(tied, '^GSPC|flip').level, line(tied, '^GSPC|flip').productLabel], [7720, 'Market Structure']);
  // A level far from SPX is a misread, and a new line has nothing to change from.
  assert.equal(line(build({ statements: { flipLines: [flip(9900, MARKET_DATE)] } }), '^GSPC|flip'), undefined);
  assert.deepEqual([line(build({ statements: { flipLines: [flip(7713, MARKET_DATE)] } }), '^GSPC|flip').isNew, line(build({ statements: { flipLines: [flip(7713, MARKET_DATE)] } }), '^GSPC|flip').change], [true, null]);
});

test('PV bands come from the newest chart, and only within a session of it', () => {
  const metrics = { zeroGamma: 7720, upperPvBand: 7850, lowerPvBand: 7600 };
  const current = build({ marketStructure: [edition('2026-11-03', {}, metrics)] });
  assert.deepEqual([line(current, '^GSPC|pvUpper').level, line(current, '^GSPC|pvLower').level], [7850, 7600]);
  assert.equal(line(build({ marketStructure: [edition('2026-10-30', {}, metrics)] }), '^GSPC|pvUpper'), undefined);
});

test('the VIX lines are the bucket boundaries with the postures on each side', () => {
  const nineteen = line(build({}), '^VIX|19');
  assert.deepEqual([nineteen.band, nineteen.above.name, nineteen.below.name], [0.01, 'Chop', 'Investable']);
  assert.equal(line(build({}), '^VIX|29').above.name, 'F Bucket');
  assert.deepEqual([nineteen.below.regime, nineteen.above.regime, line(build({}), '^VIX|29').above.regime], ['Low', 'Moderate', 'High']);
});

test('the regime reports each tile that moved from the last edition printing it, and when Risk Off began', () => {
  const regimeOf = editions => marketRegime(editions.map(snapshot => ({ snapshot, metrics: {} })));
  const result = regimeOf([edition(MARKET_DATE, { spxGammaExposure: 'Negative', strategicAllocation: 'Risk Off' }),
    edition('2026-11-03', { spxGammaExposure: 'Neutral', strategicAllocation: 'Risk On' })]);
  assert.deepEqual(result.changes.map(change => [change.id, change.from, change.to]), [['spxGammaExposure', 'Neutral', 'Negative'], ['strategicAllocation', 'Risk On', 'Risk Off']]);
  assert.deepEqual(result.riskOff, { since: MARKET_DATE, from: 'Risk On' });
  const standing = regimeOf([edition(MARKET_DATE, { strategicAllocation: 'Risk Off' }), edition('2026-11-03', { strategicAllocation: 'Risk Off' }), edition('2026-11-02', { strategicAllocation: 'Risk On' })]);
  assert.deepEqual(standing.changes, []);
  assert.deepEqual(standing.riskOff, { since: '2026-11-03', from: 'Risk On' });
  assert.equal(regimeOf([edition(MARKET_DATE, { strategicAllocation: 'Risk On' })]).riskOff, null);
});

test('coverage names an unread gamma map and an unread code, for the current session only', () => {
  const result = build({ marketStructure: [edition(MARKET_DATE, { spxGammaExposure: 'Negative' })],
    statements: { unreadAlphaCodes: [{ date: MARKET_DATE, sourceProduct: 'top-3-things', sourceLabel: 'Top 3 Things', statement: 'Alpha Code for KOSPI; 6265' }, { date: '2026-10-20', sourceProduct: 'early-look', statement: 'old' }] } });
  assert.deepEqual(result.coverage.map(gap => gap.text), ['No readable gamma map in the latest Market Structure — flip line from prose only.', 'Top 3 Things: Alpha Code unparsed — "Alpha Code for KOSPI, 6265".']);
  assert.deepEqual(build({ marketStructure: [edition('2026-10-20', {})] }).coverage, []);
});

test('level symbols name every code plus SPX and VIX', () => {
  assert.deepEqual(levelSymbols({ alphaCodes: [code('CL', MARKET_DATE, {})] }), ['CL=F', '^GSPC', '^VIX']);
});
