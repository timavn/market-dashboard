const { createReviewView } = require('./reviewView.cjs');
const { normalizeMarket } = require('./morningReport.cjs');

const NOW = Date.parse('2026-09-29T14:35:00Z');
function snapshot() {
  const event = { ticker: 'EVENT', venueId: 'kalshi', status: 'open', closeTime: '2026-09-30T20:00:00Z', expirationTime: '2026-09-30T21:00:00Z' };
  const lines = Array.from({ length: 300 }, (_, index) => ({
    ticker: `CONTRACT-${index}`, threshold: 100 + index, comparator: '>',
    yesBid: .4, yesAsk: .42, noBid: .58, noAsk: .6, directNative: true,
    updatedAt: '2026-09-29T14:34:50Z', source: 'kalshi_trade_api_v2',
    evidence: { quotes: { source: 'kalshi_batch_orderbooks_v2', asOf: '2026-09-29T14:34:50Z', fit: 'exact' } },
    nativeOrderbook: { yesBids: [[.4, 10]], noBids: [[.58, 10]], asOf: '2026-09-29T14:34:50Z', metadata: { provider: 'kalshi' } },
  }));
  const contracts = { status: 'available', asOf: '2026-09-29T14:34:50Z', expiresAt: '2026-09-29T14:36:00Z', event, lines };
  const reference = { instrument: 'TEST', fit: 'exact', spot: { status: 'available', value: 100, asOf: contracts.asOf }, chart: { points: Array(1000).fill({ price: 100 }) } };
  return {
    marketId: 'sp500', selectedVenueId: 'kalshi', status: 'available', generatedAt: contracts.asOf,
    displayContracts: contracts, contracts, executionContracts: contracts,
    displaySelection: { status: 'available', venueId: 'kalshi', contracts },
    selectedGeneration: { generationId: 'EVENT', ...event, lines }, generationOptions: [{ ...event, lines }],
    venues: { kalshi: { book: contracts, catalog: contracts, contracts, generations: [{ ...event, lines }], reference, brokerRoutable: true, bookQuality: { eligible: true } } },
    chart: reference.chart, chartReferences: { contract: reference }, resolverReference: { ...reference, proxyReference: reference }, perpetualReference: reference,
    factors: { usd: { points: [{ value: .4 }], provenance: { source: 'published' } }, move: { rows: [{ value: 100 }] } },
    sourceHealth: { kalshi_book: { status: 'available', lastSuccessAt: contracts.asOf } },
    refresh: { state: 'idle', startedAt: contracts.asOf, completedAt: contracts.asOf },
    acquisition: { status: 'complete', requestedAt: contracts.asOf, completedAt: contracts.asOf, revision: 10 },
  };
}

test('review view keeps the entire native ladder, selected identity, source gates and research without mutating the full monitor', () => {
  const full = snapshot();
  const before = JSON.stringify(full);
  const review = createReviewView(full);
  expect(normalizeMarket('sp500', review, NOW)).toEqual(normalizeMarket('sp500', full, NOW));
  expect(review.displayContracts.lines).toHaveLength(300);
  expect(review.venues.kalshi.book.lines).toHaveLength(300);
  expect(review.venues.kalshi.catalog.lines).toHaveLength(300);
  expect(review.selectedGeneration).toEqual(expect.objectContaining({ generationId: 'EVENT', closeTime: full.selectedGeneration.closeTime, expirationTime: full.selectedGeneration.expirationTime, linesFrom: 'displayContracts' }));
  expect(review.contracts.linesFrom).toBe('displayContracts');
  expect(review.displaySelection).not.toHaveProperty('contracts');
  expect(review.chartReferences.contract.spot).toEqual(full.chartReferences.contract.spot);
  expect(review.resolverReference.proxyReference).not.toHaveProperty('chart');
  expect(review.perpetualReference).not.toHaveProperty('chart');
  for (const key of ['factors', 'sourceHealth', 'acquisition', 'refresh']) expect(review[key]).toEqual(full[key]);
  expect(JSON.stringify(review).length).toBeLessThan(before.length * .6);
  expect(JSON.stringify(full)).toBe(before);
});

test.each(['stale', 'cachedOnly', 'mock', 'seeded', 'disconnected', 'refreshFailed'])('preserves %s even when it appears only inside native orderbook metadata', flag => {
  const full = snapshot();
  full.displayContracts.lines[0].nativeOrderbook[flag] = true;
  full.displayContracts.lines[0].nativeOrderbook.metadata.provenance = { [flag]: true, asOf: '2026-09-29T14:00:00Z' };
  const review = createReviewView(full);
  expect(review.displayContracts.lines[0].nativeOrderbook).toEqual({
    asOf: '2026-09-29T14:34:50Z', [flag]: true,
    metadata: { provider: 'kalshi', provenance: { [flag]: true, asOf: '2026-09-29T14:00:00Z' } },
  });
  expect(normalizeMarket('sp500', review, NOW)).toEqual(normalizeMarket('sp500', full, NOW));
});

test.each(['stale', 'cachedOnly', 'mock', 'seeded', 'disconnected', 'refreshFailed'])('keeps an independent %s selection and its failure in the report', flag => {
  const full = snapshot();
  full.displaySelection.contracts = { ...full.displayContracts, [flag]: true };
  const review = createReviewView(full);
  expect(review.displaySelection.contracts[flag]).toBe(true);
  expect(normalizeMarket('sp500', review, NOW)).toEqual(normalizeMarket('sp500', full, NOW));
});

test('does not discard independent generation, execution or venue contract levels', () => {
  const full = snapshot();
  const extra = { ticker: 'UNIQUE', threshold: 900, comparator: '>' };
  full.selectedGeneration.lines = [extra];
  full.executionContracts = { ...full.executionContracts, lines: [extra] };
  full.venues.kalshi.contracts = { ...full.venues.kalshi.contracts, lines: [extra] };
  const review = createReviewView(full);
  expect(review.selectedGeneration.lines).toEqual([extra]);
  expect(review.executionContracts.lines).toEqual([extra]);
  expect(review.venues.kalshi.contracts.lines).toEqual([extra]);
});
