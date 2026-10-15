/** @jest-environment node */
const { withSettlementBenchmark, verifiedSettlementBenchmarkSpot } = require('./settlementBenchmarkReference.cjs');
const { createCardView } = require('./cardView.cjs');

const NOW = Date.parse('2026-09-15T16:00:00Z');
function reference(marketId = 'bitcoin') {
  const symbols = { bitcoin: ['BRTI', 'BRTI'], ethereum: ['ERTI', 'ETHUSD_RTI'],
    gold: ['Metal.Index.GOLD/USD', 'Metal.Index.GOLD/USD'], silver: ['Metal.Index.SILVER/USD', 'Metal.Index.SILVER/USD'] };
  const [displaySymbol, symbol] = symbols[marketId];
  const spot = { status: 'available', availability: 'live', fit: 'exact', value: 76000,
    source: 'official_benchmark', indexId: symbol, asOf: new Date(NOW - 1_000).toISOString(),
    expiresAt: new Date(NOW + 59_000).toISOString(), executable: false };
  const venue = { id: 'kalshi', settlementBasis: { status: 'verified', instrumentScope: 'exact',
    instrument: displaySymbol, sourceName: 'Official source', sourceUrl: 'https://example.com', method: 'Contract-specific method' },
  catalog: { status: 'available', expiresAt: new Date(NOW + 60_000).toISOString(), event: { ticker: 'EVENT' } } };
  return withSettlementBenchmark({ fit: 'proxy', spot: { ...spot, fit: 'proxy', value: 90000 },
    exactReference: { fit: 'exact', spot } }, venue, { id: marketId });
}

test.each(['bitcoin', 'ethereum', 'gold', 'silver'])('uses the selected %s exact benchmark independently of its chart', (marketId) => {
  const ref = reference(marketId);
  expect(verifiedSettlementBenchmarkSpot(ref, NOW)).toMatchObject({ value: 76000, fit: 'exact', executable: false });
  expect(ref.spot.value).toBe(90000);
  expect(ref.settlementBenchmark.identityVerified).toBe(true);
});

test.each(['stale', 'isStale', 'fromCache', 'cached', 'cachedOnly', 'cacheOnly', 'seeded', 'mock', 'isMock',
  'synthetic', 'refreshFailed', 'offline', 'disconnected', 'referenceOnly'])('rejects %s benchmark data without using the chart price', (flag) => {
  const ref = reference();
  ref.exactReference.spot[flag] = true;
  expect(verifiedSettlementBenchmarkSpot(ref, NOW)).toBeNull();
});

test.each([
  (ref) => { ref.exactReference.spot.connected = false; },
  (ref) => { ref.exactReference.spot.availability = 'delayed'; },
  (ref) => { ref.exactReference.spot.indexId = 'BTC-USD'; },
  (ref) => { ref.exactReference.spot.asOf = new Date(NOW - 61_000).toISOString(); },
  (ref) => { ref.exactReference.spot.expiresAt = new Date(NOW).toISOString(); },
  (ref) => { ref.settlementBenchmark.expiresAt = new Date(NOW).toISOString(); },
  (ref) => { ref.settlementBenchmark.identityVerified = false; },
  (ref) => { delete ref.exactReference; },
  (ref) => { ref.exactReference.spot.source = 'fixture'; },
  (ref) => { ref.exactReference.spot.source = 'portfolio_mark'; },
  (ref) => { ref.exactReference.spot.source = 'derived'; },
])('fails closed for invalid quote or contract identity %#', (invalidate) => {
  const ref = reference();
  invalidate(ref);
  expect(verifiedSettlementBenchmarkSpot(ref, NOW)).toBeNull();
});

test('preserves the exact sibling in compact cards and selects strikes around only its verified price', () => {
  const ref = reference('ethereum');
  ref.exactReference.chart = { points: Array(200).fill({ value: 76000, timestamp: NOW }) };
  const snapshot = { marketId: 'ethereum', generatedAt: new Date(NOW).toISOString(), resolverReference: ref,
    spot: ref.spot, contracts: { event: { ticker: 'EVENT' }, lines: [75000, 76000, 77000, 90000].map((threshold) => ({ threshold })) } };
  const card = createCardView(snapshot);
  expect(card.resolverReference.exactReference.spot.indexId).toBe('ETHUSD_RTI');
  expect(card.resolverReference.exactReference.chart).toBeUndefined();
  expect(card.resolverReference.settlementBenchmark).toEqual(ref.settlementBenchmark);
  expect(card.contracts.ladderSelection.referenceValue).toBe(76000);
  ref.exactReference.spot.refreshFailed = true;
  expect(createCardView(snapshot).contracts.ladderSelection.referenceValue).toBeNull();
});
