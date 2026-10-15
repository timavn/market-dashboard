import { securitySizingReference, sizingUniverse } from './securitySizingReference';

const now = Date.parse('2026-09-07T22:00:00Z');
const source = 'Yahoo Finance chart API';
const metric = (value, observations) => ({ value, observations, source, status: 'available', asOf: '2026-09-04' });
const payload = () => ({ source, status: 'available', historicalOnly: true, executable: false, rows: { IGV: {
  symbol: 'IGV', source, status: 'available', historicalOnly: true, executable: false, instrumentType: 'ETF', asOf: '2026-09-04',
  beta: metric(1.2, 252), atr14: metric(1, 14), referencePrice: metric(100, 1),
  provenance: { provider: 'Yahoo Finance', dataset: 'chart', interval: '1d', adjustedCloseRequired: true,
    security: { requestedSymbol: 'IGV', fetchedAt: '2026-09-07T21:59:00Z' },
    benchmark: { symbol: 'SPY', fetchedAt: '2026-09-07T21:59:00Z' } },
} } });

test('holiday planning uses the completed close and shared beta/ATR rules without a Trade/Trend dependency', () => {
  const data = payload();
  expect(securitySizingReference(data, 'IGV', { now })).toMatchObject({ available: true, minWeight: 2, maxWeight: 5, asOf: '2026-09-04', executable: false });
  data.rows.IGV.atr14.value = 10;
  expect(securitySizingReference(data, 'IGV', { now })).toMatchObject({ minWeight: 2, maxWeight: 2.5, riskBlocked: false });
  data.rows.IGV.atr14.value = 30;
  expect(securitySizingReference(data, 'IGV', { now })).toMatchObject({ minWeight: 2, maxWeight: 0.5, riskBlocked: true });
  data.rows.IGV.beta.value = -2;
  expect(securitySizingReference(data, 'IGV', { now }).minWeight).toBe(1);
});

test('IBIT planning uses its commodity policy while retaining verified completed-session ATR and price', () => {
  const data = payload();
  const row = data.rows.IGV;
  data.rows = { IBIT: { ...row, symbol: 'IBIT', beta: null,
    provenance: { ...row.provenance, benchmark: null,
      security: { ...row.provenance.security, requestedSymbol: 'IBIT' } },
  } };
  expect(securitySizingReference(data, 'IBIT', { now })).toMatchObject({
    available: true, minWeight: 1, maxWeight: 4, executable: false, reason: null,
    sizingPolicy: { id: 'commodity' },
  });
  data.rows.IBIT.atr14.value = 10;
  expect(securitySizingReference(data, 'IBIT', { now })).toMatchObject({ minWeight: 1, maxWeight: 2.5 });
  data.rows.IBIT.referencePrice = null;
  expect(securitySizingReference(data, 'IBIT', { now })).toMatchObject({ available: false, minWeight: 1, maxWeight: null });
  data.rows.IBIT.fromCache = true;
  expect(securitySizingReference(data, 'IBIT', { now })).toMatchObject({ available: false, minWeight: null, maxWeight: null });
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
  data.rows.IGV.beta.observations = 90;
  expect(securitySizingReference(data, 'IGV', { now })).toMatchObject({ available: false, minWeight: null, reason: 'Beta needs 126 aligned sessions (90 available)' });
  data.rows.IGV.beta.observations = 252;
  data.rows.IGV.referencePrice = null;
  expect(securitySizingReference(data, 'IGV', { now })).toMatchObject({ available: false, minWeight: 2, maxWeight: null });
  data.rows.IGV.referencePrice = { ...metric(100, 1), asOf: '2026-09-03' };
  expect(securitySizingReference(data, 'IGV', { now }).maxWeight).toBeNull();
  data.rows.IGV.provenance.benchmark.disconnected = true;
  expect(securitySizingReference(data, 'IGV', { now }).minWeight).toBeNull();
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
