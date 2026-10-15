const test = require('node:test');
const assert = require('node:assert/strict');
const { createCpiForecastExReviewService, cpiIdentity, nativeCpiLines, CPIY_RULES_URL } = require('./cpiForecastExReviewService.cjs');
const NOW = Date.parse('2026-09-19T18:00:00Z');
const AS_OF = '2026-09-19T17:59:50Z';
const RELEASE_AT = '2026-10-14T12:30:00Z';
const release = () => ({ reportMonth: '2026-09', forecastMonth: 'September 2026', releaseKey: 'KXCPIYOY#2026-09', releaseAt: RELEASE_AT });
const catalog = () => ({ fetchedAt: AS_OF, lines: [3, 3.2, 3.4].map(strike => ({
  contractId: `CPIY_0926_${strike}`, productId: 'CPIY', strike,
  question: `Will the year-over-year change in the US Consumer Price Index exceed ${strike}% in September 2026?`,
  rulesUrl: CPIY_RULES_URL, lastTradeDate: RELEASE_AT, expirationDate: RELEASE_AT, payoutDate: '2026-10-14T14:30:00Z',
})) });
const quote = (side, conId, changes = {}) => ({
  publicContractId: 'CPIY_0926_3', releaseKey: 'KXCPIYOY#2026-09', conId, quote_side: side,
  source_api: 'IBKR_TWS_API', venue: 'ForecastEx', exchange: 'FORECASTX', status: 'open',
  dataType: 1, exchange_timestamp: AS_OF, tradable_in_ibkr: true, max_payout_per_contract: 1,
  native_bid: side === 'YES' ? .45 : .52, native_ask: side === 'YES' ? .48 : .55,
  native_bid_size: 10, native_ask_size: 20, ...changes,
});
const evidence = () => ({ health: { ok: true }, provider: { status: 'connected' }, release: release(), events: [quote('YES', 101), quote('NO', 102)] });
function subject(changes = {}) {
  const calls = [];
  const service = createCpiForecastExReviewService({ now: () => new Date(NOW),
    publicSources: { getForecastExContracts: async (...args) => { calls.push(args); return catalog(); } },
    loadCurrentCpiRelease: async () => release(),
    loadNativeSnapshot: async options => { calls.push(options.forceRefresh); assert.deepEqual(await options.getCurrentCpiRelease(), release()); return evidence(); },
    loadComparison: async current => ({ status: 'partial', reportMonth: current.reportMonth, releaseAt: current.releaseAt,
      releaseKey: current.releaseKey, eventTicker: 'KXCPIYOY-26SEP', hedgeye: { status: 'available', baseValue: 3.2 } }),
    ...changes,
  });
  return { service, calls };
}

test('ForecastEx CPI uses its exact official release and direct native sides, retaining unquoted adjacent strikes', async () => {
  const { service, calls } = subject();
  const result = await service.getSnapshot();
  assert.equal(result.selectedVenueId, 'forecastex');
  assert.equal(result.selectedGenerationId, 'CPIY_0926');
  assert.deepEqual(calls, [['CPIY', { forceRefresh: true }], true]);
  assert.equal(result.forecastComparison.reportMonth, '2026-09');
  assert.equal(result.forecastComparison.eventTicker, 'CPIY_0926');
  assert.equal(result.forecastComparison.sourceEventTicker, 'KXCPIYOY-26SEP');
  assert.equal(result.selectedGeneration.payoutAmount, 1);
  assert.equal(result.venues.forecastex.settlementBasis.status, 'verified');
  assert.equal(result.contracts.lines[0].yesAsk, .48);
  assert.equal(result.contracts.lines[0].noAsk, .55);
  assert.deepEqual(result.contracts.lines[0].evidence.quotes, { source: 'ibkr_tws_forecastex_live', asOf: '2026-09-19T17:59:50.000Z', fit: 'exact', executable: false });
  assert.equal(result.displayContracts.bookExpiresAt, '2026-09-19T18:00:50.000Z');
  assert.deepEqual(result.displayContracts.lines.map(row => row.threshold), [3, 3.2, 3.4]);
  assert.equal(result.displayContracts.lines[1].yesAsk, null);
  assert.equal(result.displayContracts.lines[1].directNative, false);
  assert.deepEqual(result.executionContracts.lines, []);
  assert.equal(result.strategy.status, 'unavailable');
  assert.equal(result.venues.kalshi, undefined);
});

test('a one-sided native quote never manufactures the opposite contract price', () => {
  const source = evidence(); source.events = [quote('YES', 101)];
  const lines = nativeCpiLines(cpiIdentity(catalog(), release(), NOW), source, NOW);
  assert.equal(lines[0].yesAsk, .48);
  assert.equal(lines[0].noAsk, null);
  assert.equal(lines[0].noBid, null);
});

for (const change of [{ mock: true }, { seeded: true }, { cacheOnly: true }, { stale: true }, { connected: false }, { source: 'portfolio-derived' }, { status: 'offline' }, { provenance: { cacheOnly: true } }]) {
  test(`ForecastEx CPI rejects ${Object.keys(change)[0]} broker evidence and public catalog`, async () => {
    const native = evidence(); Object.assign(native, change);
    const { service } = subject({ loadNativeSnapshot: async () => native });
    const result = await service.getSnapshot();
    assert.deepEqual(result.contracts.lines, []);
    assert.ok(result.displayContracts.lines.every(row => row.yesAsk === null && row.noAsk === null));
    assert.equal(cpiIdentity({ ...catalog(), ...change }, release(), NOW), null);
  });
}

for (const change of [{ releaseKey: 'KXCPIYOY#2026-08' }, { venue: 'Kalshi' }, { exchange: 'CME' }, { dataType: 3 }, { data_quality_flags: ['portfolio_discovered'] }, { exchange_timestamp: '2026-09-19T17:55:00Z' }, { publicContractId: 'CPIY_0826_3' }, { max_payout_per_contract: null }]) {
  test(`ForecastEx CPI rejects mismatched or unsupported native ${Object.keys(change)[0]}`, () => {
    const source = evidence(); source.events = [quote('YES', 101, change)];
    assert.deepEqual(nativeCpiLines(cpiIdentity(catalog(), release(), NOW), source, NOW), []);
  });
}

test('provider disconnection and failed refresh clear native quotes while dated CPI research remains independent', async () => {
  let reads = 0;
  const { service } = subject({ loadNativeSnapshot: async () => {
    reads += 1;
    if (reads === 1) return evidence();
    if (reads === 2) return { ...evidence(), provider: { status: 'offline' } };
    throw new Error('Gateway refresh failed');
  } });
  assert.equal((await service.getSnapshot()).contracts.lines.length, 1);
  for (let i = 0; i < 2; i += 1) {
    const result = await service.getSnapshot();
    assert.deepEqual(result.contracts.lines, []);
    assert.equal(result.forecastComparison.hedgeye.baseValue, 3.2);
  }
});

test('official contract question, rules, unique strikes and settlement must agree with the captured release', () => {
  for (const change of [{ question: 'Will CPI rise?' }, { rulesUrl: 'https://example.com/rules.pdf' }, { strike: 2.9 }, { lastTradeDate: '2026-10-13T12:30:00Z' }, { expirationDate: '2026-11-14T12:30:00Z' }]) {
    const source = catalog(); Object.assign(source.lines[0], change);
    assert.equal(cpiIdentity(source, release(), NOW), null);
  }
  const duplicate = catalog(); duplicate.lines.push(duplicate.lines[0]);
  assert.equal(cpiIdentity(duplicate, release(), NOW), null);
});

test('the monitor routes an explicitly requested CPI ForecastEx review without calling Kalshi', async () => {
  const { createMarketMonitorService } = require('./marketMonitorService.cjs');
  let nativeReads = 0;
  const monitor = createMarketMonitorService({ now: () => new Date(NOW), spxMonitorService: {},
    publicSources: { getForecastExContracts: async () => catalog() },
    loadCurrentCpiRelease: async () => release(), loadClevelandCpi: async () => ({}), loadCpiFinals: async () => ({}),
    loadIbkrCpiSnapshot: async () => { nativeReads += 1; return evidence(); },
    kalshiFetch: async () => { assert.fail('Pinned CPI ForecastEx must not request Kalshi'); },
  });
  const result = await monitor.getSnapshot('cpi', { venue: 'forecastex', forceRefresh: true });
  assert.equal(nativeReads, 1);
  assert.equal(result.selectedVenueId, 'forecastex');
  assert.equal(result.contracts.lines[0].yesAsk, .48);
});
