import { holdingSizingReference, securitySizingReference, sizingUniverse } from './securitySizingReference';

const now = Date.parse('2026-09-07T22:00:00Z');
const source = 'Yahoo Finance chart API';
const metric = (value, observations) => ({ value, observations, source, status: 'available', asOf: '2026-09-04' });
const payload = () => ({ source, status: 'available', historicalOnly: true, executable: false, rows: { IGV: {
  symbol: 'IGV', source, status: 'available', historicalOnly: true, executable: false, instrumentType: 'ETF', asOf: '2026-09-04',
  atr14: metric(2, 14), referencePrice: metric(100, 1),
  provenance: { provider: 'Yahoo Finance', dataset: 'chart', interval: '1d', adjustedCloseRequired: true,
    security: { requestedSymbol: 'IGV', fetchedAt: '2026-09-07T21:59:00Z' } },
} } });

test('holiday planning uses the completed close and the shared ATR band without a Trade/Trend or beta dependency', () => {
  const data = payload();
  const reference = securitySizingReference(data, 'IGV', { now });
  expect(reference).toMatchObject({ available: true, minWeight: 3.25, maxWeight: 6.25, floorApplied: false, riskBlocked: false,
    asOf: '2026-09-04', executable: false, reason: null });
  expect(reference.relativeAtr).toBeCloseTo(0.02);
  expect(reference.stopDistance).toBeCloseTo(0.04);
  expect(reference).not.toHaveProperty('beta');
  data.rows.IGV.atr14.value = 6.6;
  expect(securitySizingReference(data, 'IGV', { now })).toMatchObject({ minWeight: 1, maxWeight: 1.75, riskBlocked: false });
  data.rows.IGV.atr14.value = 60;
  expect(securitySizingReference(data, 'IGV', { now })).toMatchObject({ available: true, minWeight: 0.25, maxWeight: 0, riskBlocked: true });
});

test('a quiet security is floored at 5–10% while its stop distance keeps the measured ATR', () => {
  const data = payload();
  data.rows.IGV.atr14.value = 0.5;
  const reference = securitySizingReference(data, 'IGV', { now });
  expect(reference).toMatchObject({ available: true, minWeight: 5, maxWeight: 10, floorApplied: true });
  expect(reference.relativeAtr).toBeCloseTo(0.005);
  expect(reference.stopDistance).toBeCloseTo(0.01);
});

test('ATR is relative to price, so the same band holds at any share price', () => {
  const data = payload();
  data.rows.IGV.atr14.value = 20;
  data.rows.IGV.referencePrice.value = 1000;
  expect(securitySizingReference(data, 'IGV', { now })).toMatchObject({ minWeight: 3.25, maxWeight: 6.25 });
  data.rows.IGV.referencePrice.value = 300;
  // 20 / 300 = 6.67% ATR → raw 0.94 / 1.88 → 1 / 1.75.
  expect(securitySizingReference(data, 'IGV', { now })).toMatchObject({ minWeight: 1, maxWeight: 1.75 });
});

test.each([
  data => { data.source = 'mock'; },
  data => { data.executable = true; },
  data => { data.rows.IGV.symbol = 'OTHER'; },
  data => { data.rows.IGV.fromCache = true; },
  data => { data.rows.IGV.provenance.security.fetchedAt = '2026-09-07T20:00:00Z'; },
  data => { data.rows.IGV.provenance.security.requestedSymbol = 'OTHER'; },
  data => { data.rows.IGV.asOf = '2026-09-03'; },
  data => { data.rows.IGV.asOf = '2026-09-08'; },
  data => { data.rows.IGV.instrumentType = 'FUTURE'; },
  data => { data.rows.IGV.instrumentType = null; },
])('rejects unverified, wrong-date or unsupported inputs (%#)', mutate => {
  const data = payload(); mutate(data);
  expect(securitySizingReference(data, 'IGV', { now })).toMatchObject({ available: false, minWeight: null, maxWeight: null });
});

test('insufficient history and partial metrics remain specific gaps', () => {
  const data = payload();
  data.rows.IGV.atr14.observations = 13;
  expect(securitySizingReference(data, 'IGV', { now })).toMatchObject({ available: false, minWeight: null, maxWeight: null, reason: 'ATR needs 14 completed sessions' });
  data.rows.IGV.atr14.observations = 14;
  data.rows.IGV.referencePrice = null;
  expect(securitySizingReference(data, 'IGV', { now })).toMatchObject({ available: false, minWeight: null, maxWeight: null, reason: 'Verified closing price needed' });
  data.rows.IGV.referencePrice = { ...metric(100, 1), asOf: '2026-09-03' };
  expect(securitySizingReference(data, 'IGV', { now }).maxWeight).toBeNull();
  data.rows.IGV.referencePrice = metric(100, 1);
  data.rows.IGV.atr14.asOf = '2026-09-03';
  expect(securitySizingReference(data, 'IGV', { now }).available).toBe(false);
});

test('a missing or disconnected beta benchmark no longer blocks the band', () => {
  const data = payload();
  data.rows.IGV.beta = { ...metric(1.2, 90), status: 'unavailable' };
  data.rows.IGV.provenance.benchmark = { symbol: 'SPY', disconnected: true };
  expect(securitySizingReference(data, 'IGV', { now })).toMatchObject({ available: true, minWeight: 3.25, maxWeight: 6.25 });
});

test('the Positions table formats the same band and gates on the source and instrument', () => {
  const data = payload();
  expect(holdingSizingReference({ symbol: ' igv ', payload: data, sourceStatus: 'ready', instrumentTypes: ['ETF'], now }))
    .toMatchObject({ available: true, minWeight: 3.25, maxWeight: 6.25, value: '3.25–6.25%' });
  data.rows.IGV.atr14.value = 0.5;
  expect(holdingSizingReference({ symbol: 'IGV', payload: data, sourceStatus: 'partial', now }).value).toBe('5.0–10.0%');
  data.rows.IGV.atr14.value = 60;
  expect(holdingSizingReference({ symbol: 'IGV', payload: data, sourceStatus: 'ready', now }))
    .toMatchObject({ available: false, value: null, riskBlocked: true, reason: 'Too volatile to size: ATR is near half the price.' });
  data.rows.IGV.atr14.value = 0.5;
  expect(holdingSizingReference({ symbol: 'IGV', payload: data, sourceStatus: 'ready', instrumentTypes: ['OPT'], now }))
    .toMatchObject({ available: false, value: null, reason: 'This instrument requires contract-specific risk sizing.' });
  expect(holdingSizingReference({ symbol: 'IGV', payload: data, sourceStatus: 'loading', now }))
    .toMatchObject({ available: false, value: null, reason: 'Refreshing ATR inputs.' });
  expect(holdingSizingReference({ symbol: 'IGV', payload: data, sourceStatus: 'ready', sourceError: new Error('down'), now }))
    .toMatchObject({ available: false, value: null, reason: 'The ATR provider is unavailable.' });
  data.rows.IGV.atr14.observations = 13;
  expect(holdingSizingReference({ symbol: 'IGV', payload: data, sourceStatus: 'ready', now }))
    .toMatchObject({ available: false, value: null, minWeight: null, reason: 'ATR needs 14 completed sessions' });
  data.rows.IGV.atr14.observations = 14;
  data.rows.IGV.atr14.source = 'Other provider';
  expect(holdingSizingReference({ symbol: 'IGV', payload: data, sourceStatus: 'ready', now }).reason).toBe('ATR source needs verification');
});

test('the universe includes verified names beyond the static list and excludes unresolved prose mentions', () => {
  const rows = sizingUniverse([
    { ticker: 'AMZN', existingUniverse: true, name: 'Amazon' },
    { ticker: 'CLOZ', discoveryState: 'structured', nameVerified: true, name: 'CLO ETF', providerInstrumentType: 'ETF' },
    { ticker: 'COLO', discoveryState: 'structured', nameVerified: true, name: 'Colombia ETF' },
    { ticker: 'UNKNOWN', discoveryState: 'candidate', nameVerified: false },
    { ticker: 'TSLL', discoveryState: 'candidate', nameVerified: true, name: 'Verified ETF' },
  ], [{ ticker: 'AMZN', assetClass: 'equity' }]);
  expect(rows.map(row => row.ticker)).toEqual(['AMZN', 'CLOZ', 'COLO', 'TSLL']);
  expect(rows[1].bias).toBeUndefined();
});

test('a verified overseas close may be newer than the US holiday close, but an unfinished daily bar is rejected', () => {
  const data = payload();
  const row = data.rows.IGV;
  row.asOf = '2026-09-07';
  row.atr14.asOf = row.referencePrice.asOf = row.asOf;
  row.referencePrice.timestamp = '2026-09-07T08:00:00Z';
  row.provenance.security.exchangeTimezone = 'Europe/London';
  row.provenance.security.regularSession = { start: Date.parse('2026-09-07T08:00:00Z') / 1000, end: Date.parse('2026-09-07T16:30:00Z') / 1000 };
  expect(securitySizingReference(data, 'IGV', { now }).available).toBe(true);
  row.provenance.security.regularSession.end = now / 1000 + 3600;
  expect(securitySizingReference(data, 'IGV', { now }).available).toBe(false);
});
