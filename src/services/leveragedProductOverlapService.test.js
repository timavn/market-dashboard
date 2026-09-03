const {
  computeWeightedHoldingsOverlap,
  createLeveragedProductOverlapService,
  parseIsharesHoldingsCsv,
  parseSsgaHoldingsRows,
} = require('./leveragedProductOverlapService.cjs');

const ISHARES_FIXTURE = `iShares Test ETF
Fund Holdings as of,"Aug 11, 2026"
Ticker,Name,Type,Sector,Asset Class,Market Value,Weight (%),Notional Value
"A","Alpha, Inc.","EQUITY","Financials","Equity","60","60","60"
"B","Beta Inc.","EQUITY","Financials","Equity","40","40","40"
"USD","USD CASH","CASH","Cash","Cash","1","1","1"`;

const SSGA_FIXTURE = [
  ['Fund Name:', 'Reference ETF'],
  ['Ticker Symbol:', 'XLF'],
  ['Holdings:', 'As of 11-Aug-2026'],
  [],
  ['Name', 'Ticker', 'Identifier', 'SEDOL', 'Weight', 'Sector'],
  ['Alpha Inc.', 'A', '000000001', 'A', 30, '-'],
  ['Charlie Inc.', 'C', '000000002', 'C', 70, '-'],
  ['INDEX FUTURE SEP26', 'TEST6', '000000003', '-', 1, '-'],
];

test('computes weighted overlap from normalized shared holding weights', () => {
  const base = parseIsharesHoldingsCsv(ISHARES_FIXTURE);
  const reference = parseSsgaHoldingsRows(SSGA_FIXTURE);
  const overlap = computeWeightedHoldingsOverlap(base.holdings, reference.holdings);

  expect(base.asOf).toBe('2026-08-11');
  expect(reference.asOf).toBe('2026-08-11');
  expect(overlap).toMatchObject({
    weightedOverlapPct: 30,
    sharedHoldings: 1,
    baseHoldings: 2,
    referenceHoldings: 2,
    baseCoveragePct: 60,
    referenceCoveragePct: 30,
  });
});

test('returns current issuer-published overlap without a cache fallback', async () => {
  const fetchImpl = jest.fn(async (url) => (
    url.includes('ishares')
      ? { ok: true, status: 200, text: async () => ISHARES_FIXTURE }
      : { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(1) }
  ));
  const service = createLeveragedProductOverlapService({
    fetchImpl,
    xlsxReader: async () => SSGA_FIXTURE,
    now: () => new Date('2026-08-12T12:00:00Z'),
  });

  await expect(service.getOverlap({ baseSymbol: 'IAK', referenceSymbol: 'XLF' }))
    .resolves.toMatchObject({
      available: true,
      status: 'available',
      weightedOverlapPct: 30,
      sharedHoldings: 1,
      asOf: '2026-08-11',
      method: 'weighted_constituent_overlap',
      fromCache: false,
    });
  expect(fetchImpl).toHaveBeenCalledTimes(2);
});

test('fails closed when published holdings are stale or unavailable', async () => {
  const validFetch = async (url) => (
    url.includes('ishares')
      ? { ok: true, status: 200, text: async () => ISHARES_FIXTURE }
      : { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(1) }
  );
  const staleService = createLeveragedProductOverlapService({
    fetchImpl: validFetch,
    xlsxReader: async () => SSGA_FIXTURE,
    now: () => new Date('2026-09-01T12:00:00Z'),
  });
  await expect(staleService.getOverlap({ baseSymbol: 'IAK', referenceSymbol: 'XLF' }))
    .resolves.toMatchObject({
      available: false,
      status: 'unavailable',
      weightedOverlapPct: null,
      fromCache: false,
    });

  const offlineService = createLeveragedProductOverlapService({
    fetchImpl: async () => ({ ok: false, status: 503 }),
    now: () => new Date('2026-08-12T12:00:00Z'),
  });
  await expect(offlineService.getOverlap({ baseSymbol: 'IAK', referenceSymbol: 'XLF' }))
    .resolves.toMatchObject({
      available: false,
      status: 'unavailable',
      weightedOverlapPct: null,
      fromCache: false,
    });
});
