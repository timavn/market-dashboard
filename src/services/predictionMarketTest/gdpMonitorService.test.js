const { createGdpMonitorService, sanitizeGdpSnapshot } = require('./gdpMonitorService.cjs');
const { createCardView } = require('./cardView.cjs');
const { createMarketMonitorCoordinator } = require('./marketMonitorCoordinator.cjs');

const NOW = Date.parse('2026-09-09T19:00:00Z');
const CLOSE = '2026-12-23T13:30:00.000Z';
const RULES = 'https://data.forecastex.com/regulatory/RGDPTermsandConditions.pdf';
const research = { quarter: '2026-Q3', unit: 'percent_qoq_saar',
  forecasts: [{ sourceId: 'hedgeye', value: 4.02, targetStage: null, publishedAt: '2026-08-31T14:21:00Z' }],
  readings: [], schedule: [{ stage: 'third', releaseAt: CLOSE }],
};
const contract = (strike) => ({ productId: 'RGDP', contractId: `RGDP_Q326_${strike}`, strike,
  question: `Will the annualized growth rate in US Real GDP exceed ${strike}% in Q3 2026?`,
  rulesUrl: RULES, lastTradeDate: CLOSE, expirationDate: CLOSE, payoutDate: '2026-12-23T15:30:00Z', openInterest: 200,
});
const native = (strike) => ({ contractId: `RGDP_Q326_${strike}`, dataType: 'live', directNative: true,
  provenance: 'ibkr_tws_native_forecastex', updatedAt: new Date(NOW).toISOString(),
  yesBid: 0.4, yesAsk: 0.42, yesBidSize: 10, yesAskSize: 20, noBid: null, noAsk: null,
});
function setup({ lines = [contract(0), contract(-1)], live = {}, gdp = research } = {}) {
  let clock = NOW;
  const load = jest.fn().mockResolvedValue({ status: 'available', fetchedAt: new Date(NOW).toISOString(),
    lines: lines.map((line) => native(line.strike)), ...live });
  const service = createGdpMonitorService({
    publicSources: { getForecastExContracts: jest.fn().mockResolvedValue({ fetchedAt: new Date(NOW).toISOString(), lines }) },
    loadForecastExLive: load, researchService: { getSnapshot: jest.fn().mockResolvedValue(gdp) },
    now: () => new Date(clock),
  });
  return { service, load, setTime: (ms) => { clock = ms; } };
}

test('pins Q3 third reading independently of forecasts and accepts negative/zero thresholds', async () => {
  const { service, load } = setup({ gdp: { ...research, forecasts: [] } });
  const snapshot = await service.getSnapshot();
  expect(snapshot.contracts.event).toMatchObject({ measuredQuarter: '2026-Q3', settlementStage: 'third', resolutionAt: CLOSE });
  expect(snapshot.contracts.lines.map((line) => line.threshold)).toEqual([-1, 0]);
  expect(snapshot.contracts.lines[0].noBid).toBeNull();
  expect(snapshot.contracts.lines[0].noAsk).toBeNull();
  expect(load).toHaveBeenCalledWith(expect.objectContaining({ measuredQuarter: '2026-Q3', generationKey: 'RGDP_Q326' }));
  expect(snapshot.executionContracts.lines).toEqual([]);
  expect(snapshot.strategy.model).toBeNull();
});

test.each([
  { status: 'unavailable' }, { refreshFailed: true }, { fromCache: true }, { cachedOnly: true },
  { seeded: true }, { mock: true }, { stale: true }, { connected: false },
  { providerStatus: 'offline' }, { fetchedAt: new Date(NOW - 100_000).toISOString() },
])('clears rejected native book %j and preserves research', async (live) => {
  const { service } = setup({ live });
  const snapshot = await service.getSnapshot();
  expect(snapshot.contracts.lines).toEqual([]);
  expect(snapshot.venues.forecastex.book.lines).toEqual([]);
  expect(snapshot.venues.forecastex.catalog.thresholds).toHaveLength(2);
  expect(snapshot.venues.forecastex.catalog.thresholds[0]).toMatchObject({ threshold: -1, openInterest: 200 });
  expect(snapshot.venues.forecastex.catalog.thresholds[0]).not.toHaveProperty('yesBid');
  expect(snapshot.gdp).toEqual(research);
});

test('wrong quarter or deciding stage cannot qualify a native book', async () => {
  const { service, load } = setup({ lines: [{ ...contract(1.5), question: 'Will the annualized growth rate in US Real GDP exceed 1.5% in Q2 2026?' }] });
  expect((await service.getSnapshot()).contracts.lines).toEqual([]);
  expect(load).not.toHaveBeenCalled();
  const mismatched = setup({ gdp: { ...research, schedule: [{ stage: 'third', releaseAt: '2026-10-29T12:30:00Z' }] } });
  expect((await mismatched.service.getSnapshot()).contracts.event).toBeNull();
});

test('rejects derived native sides and boolean prices without losing verified thresholds', async () => {
  const derived = setup({ live: { lines: [ { ...native(0), derivedFields: ['noAsk'], noAsk: 0.6 } ] } });
  expect((await derived.service.getSnapshot()).contracts.lines).toEqual([]);
  const invalid = setup({ live: { lines: [ { ...native(0), yesBid: true, yesAsk: false } ] } });
  expect((await invalid.service.getSnapshot()).contracts.lines).toEqual([]);
  const snapshot = await setup().service.getSnapshot();
  snapshot.contracts.lines.forEach((line) => { line.derivedFields = ['yesBid']; });
  expect(sanitizeGdpSnapshot(snapshot, NOW).contracts.lines).toEqual([]);
});

test.each([{ status: 'unavailable' }, { status: 'error' }, { isStale: true }, { isMock: true },
  { offline: true }, { disconnected: true }, { cacheOnly: true }])('rejects unsafe native line metadata %j', async (flags) => {
  const { service } = setup({ live: { lines: [{ ...native(0), ...flags }] } });
  const snapshot = await service.getSnapshot();
  expect(snapshot.contracts.lines).toEqual([]);
  expect(snapshot.gdp).toEqual(research);
});

test('a failed refresh replaces previous prices, while October never clears research', async () => {
  const { service, load } = setup();
  const before = await service.getSnapshot();
  expect(before.contracts.lines).toHaveLength(2);
  load.mockRejectedValueOnce(new Error('offline'));
  const after = await service.getSnapshot();
  expect(after.contracts.lines).toEqual([]);
  expect(after.gdp.forecasts).toEqual(before.gdp.forecasts);
  const october = sanitizeGdpSnapshot(before, Date.parse('2026-10-29T13:00:00Z'));
  expect(october.gdp).toEqual(before.gdp);
  expect(october.contracts.lines).toEqual([]);
  expect(october.contracts.event.resolutionAt).toBe(CLOSE);
});

test('compact response carries release vintages and every GDP threshold', async () => {
  const lines = Array.from({ length: 18 }, (_, i) => contract(-4 + i * 0.5));
  const { service } = setup({ lines });
  const card = createCardView(await service.getSnapshot());
  expect(card.gdp).toEqual(research);
  expect(card.contracts.lines).toHaveLength(18);
  expect(card.venues.forecastex.catalog.thresholds).toHaveLength(18);
  expect(card.contracts.event).toMatchObject({ measuredQuarter: '2026-Q3', settlementStage: 'third', resolutionAt: CLOSE });
});

test('coordinator failure clears GDP prices even before their timestamps expire', async () => {
  const { service } = setup();
  const snapshot = await service.getSnapshot();
  const getSnapshot = jest.fn().mockResolvedValueOnce(snapshot).mockRejectedValueOnce(new Error('Provider offline'));
  const coordinator = createMarketMonitorCoordinator({ monitorService: { getSnapshot },
    marketIds: ['gdp'], now: () => new Date(NOW), logger: { error: jest.fn() } });
  await coordinator.refresh('gdp');
  expect(coordinator.getSnapshot('gdp', { venue: 'forecastex' }).contracts.lines).toHaveLength(2);
  await coordinator.refresh('gdp');
  const failed = coordinator.getSnapshot('gdp');
  expect(failed.contracts.lines).toEqual([]);
  expect(failed.gdp.forecasts).toEqual(research.forecasts);
  coordinator.stop();
});
