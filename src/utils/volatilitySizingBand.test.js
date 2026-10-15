const {
  calculateVolatilityBand, expectedSizingSession, formatVolatilityBand, validateVolatilityBandInputs,
} = require('./volatilitySizingBand.cjs');

const NOW = Date.parse('2026-09-07T22:00:00Z'); // Labor Day: Friday is still the completed session.
const inputs = () => ({
  symbol: 'OIH', sourceStatus: 'ready', now: NOW,
  payload: {
    status: 'available', historicalOnly: true, executable: false,
    generatedAt: new Date(NOW).toISOString(),
    rows: { OIH: {
      symbol: 'OIH', status: 'available', source: 'Yahoo Finance chart API',
      asOf: '2026-09-04', historicalOnly: true, executable: false,
      realizedVolatility: {
        status: 'available', rv63: 0.303452, rv252: 0.295953, sizingVol: 0.303452,
        annualizationFactor: 252, observationCount: 6419, asOf: '2026-09-04', limitedHistory: false,
      },
      provenance: {
        provider: 'Yahoo Finance', dataset: 'chart', interval: '1d', adjustedCloseRequired: true,
        security: { requestedSymbol: 'OIH', fetchedAt: new Date(NOW).toISOString(), cacheStatus: 'miss' },
      },
    } },
  },
});

test.each([[0.1, 4, 12], [0.2, 2, 6], [0.4, 1, 3], [0.8, 0.5, 1.5], [0.05, 4, 12]])(
  '%s volatility produces a %s–%s percent operating band', (volatility, min, max) => {
    const band = calculateVolatilityBand(volatility);
    expect(band.minWeightPct).toBeCloseTo(min);
    expect(band.maxWeightPct).toBeCloseTo(max);
    expect(band.widthPct).toBeCloseTo(max - min);
  },
);

test('equalizes risk at both endpoints, preserves 3:1 room, and never clamps high volatility', () => {
  for (const volatility of [0.1, 0.15, 0.3, 0.6, 0.95, 1.5, 4]) {
    const band = calculateVolatilityBand(volatility);
    expect(band.minWeightPct / 100 * volatility).toBeCloseTo(0.004);
    expect(band.maxWeightPct / 100 * volatility).toBeCloseTo(0.012);
    expect(band.maxWeightPct / band.minWeightPct).toBeCloseTo(3);
    expect(band.maxWeightPct).toBeLessThanOrEqual(12);
  }
  expect(formatVolatilityBand(calculateVolatilityBand(8))).toBe('0.05–0.15%');
});

test.each([null, undefined, 0, -0.3, NaN, Infinity, '0.3'])('rejects invalid volatility %s', value => {
  expect(calculateVolatilityBand(value)).toBeNull();
});

test('OIH uses its own volatility, with no beta or asset-class input', () => {
  const result = validateVolatilityBandInputs(inputs());
  expect(result.available).toBe(true);
  expect(result.value).toBe('1.3–4.0%');
  expect(result.band.minWeightPct).toBeCloseTo(1.31816696);
  expect(result.band.maxWeightPct).toBeCloseTo(3.95450022);
});

test('uses 63 observations only with an explicit limited-history state', () => {
  const input = inputs();
  Object.assign(input.payload.rows.OIH.realizedVolatility, {
    observationCount: 100, rv252: null, limitedHistory: true,
  });
  expect(validateVolatilityBandInputs(input)).toMatchObject({ available: true, limitedHistory: true });
});

test('a still-current history cache hit is accepted as dated research, never as a live quote', () => {
  const input = inputs();
  Object.assign(input.payload.rows.OIH.provenance.security, { cacheStatus: 'hit', cacheAgeSeconds: 300 });
  input.payload.cache = { status: 'hit', ageSeconds: 300 };
  expect(validateVolatilityBandInputs(input).available).toBe(true);
});

test.each([
  ['provider offline', i => { i.sourceStatus = 'error'; }],
  ['option contract', i => { i.instrumentTypes = ['OPT']; }],
  ['mixed stock and option contracts', i => { i.instrumentTypes = ['STK', 'OPT']; }],
  ['refresh failed while old data remains', i => { i.sourceError = 'Refresh failed'; }],
  ['refreshing old data', i => { i.sourceStatus = 'loading'; }],
  ['stale response', i => { i.payload._cache = { stale: true }; }],
  ['cache-only response', i => { i.payload.cache = { status: 'cache-only' }; }],
  ['mock source', i => { i.payload.rows.OIH.source = 'mock'; }],
  ['seeded row', i => { i.payload.rows.OIH.seeded = true; }],
  ['inferred metric', i => { i.payload.rows.OIH.realizedVolatility.inferred = true; }],
  ['disconnected source', i => { i.payload.rows.OIH.provenance.security.connected = false; }],
  ['raw unadjusted history', i => { i.payload.rows.OIH.provenance.adjustedCloseRequired = false; }],
  ['missing source', i => { delete i.payload.rows.OIH.source; }],
  ['different symbol history', i => { i.payload.rows.OIH.provenance.security.requestedSymbol = 'SPY'; }],
  ['63-return minimum', i => { i.payload.rows.OIH.realizedVolatility.observationCount = 62; }],
  ['missing long lookback', i => { i.payload.rows.OIH.realizedVolatility.rv252 = null; }],
  ['invalid annualization', i => { i.payload.rows.OIH.realizedVolatility.annualizationFactor = 12; }],
  ['inconsistent sizing volatility', i => { i.payload.rows.OIH.realizedVolatility.sizingVol = 0.2; }],
  ['stale session', i => { i.payload.rows.OIH.realizedVolatility.asOf = '2026-09-03'; }],
  ['future session', i => { i.payload.rows.OIH.realizedVolatility.asOf = '2026-09-08'; }],
  ['expired history', i => { i.payload.rows.OIH.provenance.security.fetchedAt = '2026-09-07T20:00:00Z'; }],
  ['expired response', i => { i.payload.generatedAt = '2026-09-07T21:00:00Z'; }],
])('suppresses sizing for %s', (_name, mutate) => {
  const input = inputs();
  mutate(input);
  expect(validateVolatilityBandInputs(input)).toMatchObject({ available: false, band: null, value: null });
});

test('expires locally after the next completed session, including holidays and weekends', () => {
  expect(expectedSizingSession(NOW)).toBe('2026-09-04');
  expect(expectedSizingSession(Date.parse('2026-09-08T19:00:00Z'))).toBe('2026-09-04');
  expect(expectedSizingSession(Date.parse('2026-09-08T20:16:00Z'))).toBe('2026-09-08');
  expect(expectedSizingSession(Date.parse('2026-09-12T20:16:00Z'))).toBe('2026-09-11');
  expect(expectedSizingSession(NOW, 365)).toBe('2026-09-06');
});
