/** @jest-environment node */
/* eslint jest/expect-expect: ["warn", { "assertFunctionNames": ["expect", "expectUnavailable"] }] */
const { createExUsVolumeService } = require('./exUsVolumeService.cjs');
const { EX_US_VOLUME_PROXY } = require('../constants/volumeMarkets.cjs');
const { expectedVolumeTradingDate, EXCHANGE_VOLUME_WINDOWS } = require('../utils/exchangeVolume.cjs');
const { requiredExUsVolumeDates, isVerifiedExUsVolumeResponse } = require('../utils/exUsVolume.cjs');

const NOW = new Date('2026-09-14T13:00:00Z');
const TARGET = '2026-09-11';
const FETCHED_AT = '2026-09-14T12:59:00Z';

function historyFixture() {
  return {
    source: 'ibkr',
    asOf: FETCHED_AT,
    useRth: true,
    contract: {
      conId: 49954149, symbol: 'ACWX', secType: 'STK', exchange: 'SMART', currency: 'USD', provider: 'ibkr',
    },
    bars: requiredExUsVolumeDates(TARGET).map((date, index) => ({ date, volume: index === 0 ? 200 : 100 })),
  };
}

function providerFixture(history = historyFixture()) {
  return {
    getProviderStatus: jest.fn(async () => ({ connected: true, connectionIdentity: 'test-session' })),
    getHistoricalBars: jest.fn(async () => history),
  };
}

function makeService(provider = providerFixture(), now = () => NOW) {
  return createExUsVolumeService({ provider, now });
}

function expectUnavailable(response) {
  expect(response.asOf).toBeNull();
  expect(response.totalExchange).toEqual([]);
  expect(response.totalMarket).toEqual([]);
  expect(Object.values(response.metrics.exchange).every(value => value === null)).toBe(true);
  expect(response.meta).toMatchObject({ status: 'unavailable', verified: false, providerConnected: false, asOfTradingDate: null });
  expect(isVerifiedExUsVolumeResponse(response, NOW)).toBe(false);
}

describe('ex-US ETF volume service', () => {
  test('uses qualified ACWX daily RTH volume with the original observation time and full comparison windows', async () => {
    const provider = providerFixture();
    const result = await makeService(provider).fetchSnapshot({ days: 365 });

    expect(provider.getHistoricalBars).toHaveBeenCalledWith(EX_US_VOLUME_PROXY.instrument, '2y', '1d', { useRth: true });
    expect(provider.getProviderStatus).toHaveBeenCalledTimes(2);
    expect(result.totalExchange).toHaveLength(251);
    expect(result.asOf).toBe(TARGET);
    expect(result.metrics.exchange).toEqual({
      priorDay: 200, avg1M: 100, avg3M: 100, avg1Y: 100,
      pctPriorDay: 100, pct1M: 100, pct3M: 100, pct1Y: 100,
    });
    expect(result.meta).toMatchObject({
      fetchedAt: FETCHED_AT, comparisonWindows: EXCHANGE_VOLUME_WINDOWS,
      sourceBreakdown: [expect.objectContaining({ symbol: 'ACWX', issuerUrl: EX_US_VOLUME_PROXY.issuerUrl })],
    });
    expect(isVerifiedExUsVolumeResponse(result, NOW)).toBe(true);
  });

  test('deduplicates concurrent calls but re-verifies the next refresh', async () => {
    const provider = providerFixture();
    const service = makeService(provider);
    const first = service.fetchSnapshot();
    const second = service.fetchSnapshot({ days: 2 });
    expect(second).toBe(first);
    await first;
    expect(provider.getHistoricalBars).toHaveBeenCalledTimes(1);
    await service.fetchSnapshot();
    expect(provider.getHistoricalBars).toHaveBeenCalledTimes(2);
  });

  test('excludes the in-progress trading session even when its bar is returned', async () => {
    const history = historyFixture();
    history.bars.unshift({ date: '2026-09-14', volume: 999999 });
    const result = await makeService(providerFixture(history)).fetchSnapshot();
    expect(result.totalExchange[0]).toEqual({ date: TARGET, volume: 200 });
    expect(result.metrics.exchange.pct1Y).toBe(100);
  });

  test('keeps missing calendar slots rather than pulling older bars into the average', async () => {
    const history = historyFixture();
    const missingDate = history.bars[45].date;
    history.bars.splice(45, 1);
    const result = await makeService(providerFixture(history)).fetchSnapshot();
    expect(result.totalExchange[45]).toEqual({ date: missingDate, volume: null });
    expect(result.metrics.exchange).toMatchObject({ pctPriorDay: 100, pct1M: 100, pct3M: null, pct1Y: null });
    expect(isVerifiedExUsVolumeResponse(result, NOW)).toBe(true);
  });

  test.each([0, 1])('withholds the row when required recent session %s is absent', async index => {
    const history = historyFixture();
    history.bars.splice(index, 1);
    expectUnavailable(await makeService(providerFixture(history)).fetchSnapshot());
  });

  test.each([
    ['source', history => { history.source = 'yahoo'; }],
    ['provider error', history => { history.error = 'Permission denied'; }],
    ['string delayed flag', history => { history.delayed = 'true'; }],
    ['missing RTH evidence', history => { delete history.useRth; }],
    ['extended hours', history => { history.useRth = false; }],
    ['missing fetch time', history => { delete history.asOf; }],
    ['old fetch time', history => { history.asOf = '2026-09-14T12:39:59Z'; }],
    ['future fetch time', history => { history.asOf = '2026-09-14T13:02:00Z'; }],
    ['wrong security', history => { history.contract.symbol = 'SPY'; }],
    ['missing conId', history => { delete history.contract.conId; }],
    ['wrong currency', history => { history.contract.currency = 'EUR'; }],
    ['wrong type', history => { history.contract.secType = 'IND'; }],
    ['wrong exchange', history => { history.contract.exchange = 'CBOE'; }],
    ['unqualified identity', history => { history.contract.provider = 'yahoo'; }],
    ['duplicate date', history => { history.bars.push(history.bars[0]); }],
    ['intraday bars', history => { history.bars[0].date = '2026-09-11T16:00:00Z'; }],
    ['future date', history => { history.bars[0].date = '2026-09-15'; }],
    ['holiday date', history => { history.bars[0].date = '2026-09-07'; }],
    ['invalid volume', history => { history.bars[0].volume = -1; }],
    ['zero current volume', history => { history.bars[0].volume = 0; }],
    ['text volume', history => { history.bars[0].volume = '200'; }],
  ])('rejects %s', async (_label, mutate) => {
    const history = historyFixture();
    mutate(history);
    expectUnavailable(await makeService(providerFixture(history)).fetchSnapshot());
  });

  test.each(['stale', 'isStale', 'cacheOnly', 'fromCache', 'cached', 'seed', 'seeded', 'mock', 'isMock', 'synthetic', 'inferred', 'fallback', 'offline', 'delayed', 'frozen'])('rejects %s flags on history and individual bars', async flag => {
    for (const target of ['history', 'bar', 'meta']) {
      const history = historyFixture();
      if (target === 'history') history[flag] = true;
      else if (target === 'bar') history.bars[30][flag] = true;
      else history.meta = { [flag]: true };
      expectUnavailable(await makeService(providerFixture(history)).fetchSnapshot());
    }
  });

  test('does not use old data after a refresh failure', async () => {
    const provider = providerFixture();
    const service = makeService(provider);
    expect(isVerifiedExUsVolumeResponse(await service.fetchSnapshot(), NOW)).toBe(true);
    provider.getHistoricalBars.mockRejectedValue(new Error('offline'));
    expectUnavailable(await service.fetchSnapshot());
  });

  test.each(['before', 'after'])('rejects a disconnect %s the history request', async phase => {
    const provider = providerFixture();
    if (phase === 'before') provider.getProviderStatus.mockResolvedValue({ connected: false });
    else provider.getProviderStatus.mockResolvedValueOnce({ connected: true }).mockResolvedValue({ connected: false });
    expectUnavailable(await makeService(provider).fetchSnapshot());
    expect(provider.getHistoricalBars).toHaveBeenCalledTimes(phase === 'before' ? 0 : 1);
  });

  test('rejects a changed connection and a session boundary crossed during a request', async () => {
    const provider = providerFixture();
    provider.getProviderStatus.mockResolvedValueOnce({ connected: true, connectionIdentity: 'one' })
      .mockResolvedValueOnce({ connected: true, connectionIdentity: 'two' });
    expectUnavailable(await makeService(provider).fetchSnapshot());

    const boundaryProvider = providerFixture();
    let now = NOW;
    boundaryProvider.getHistoricalBars.mockImplementation(async () => {
      now = new Date('2026-09-15T13:00:00Z');
      return historyFixture();
    });
    expectUnavailable(await makeService(boundaryProvider, () => now).fetchSnapshot());
  });
});

describe('ex-US browser response validation', () => {
  test.each([
    ['stale observation', value => { value.meta.fetchedAt = '2026-09-14T12:00:00Z'; }],
    ['disconnected provider', value => { value.meta.providerConnected = false; }],
    ['cache only', value => { value.meta.cacheOnly = true; }],
    ['mock', value => { value.mock = true; }],
    ['seeded source', value => { value.meta.sourceBreakdown = [{ ...value.meta.sourceBreakdown[0], seeded: true }]; }],
    ['wrong source date', value => { value.meta.asOfTradingDate = '2026-09-10'; }],
    ['wrong methodology', value => { value.meta.methodologyVersion = 'other'; }],
    ['changed comparison', value => { value.meta.comparisonWindows = { ...EXCHANGE_VOLUME_WINDOWS, avg1M: 20 }; }],
    ['wrong provider', value => { value.meta.provider = 'Cboe'; }],
    ['missing contract', value => { delete value.meta.contract; }],
    ['shifted calendar', value => { value.totalExchange.splice(45, 1); }],
    ['manufactured ratio', value => { value.metrics.exchange.pct1M = 999; }],
  ])('rejects %s', async (_label, mutate) => {
    const value = await makeService().fetchSnapshot();
    mutate(value);
    expect(isVerifiedExUsVolumeResponse(value, NOW)).toBe(false);
  });

  test('the proxy uses the same prior New York session as the US row', () => {
    expect(requiredExUsVolumeDates(expectedVolumeTradingDate(NOW))[0]).toBe(TARGET);
    expect(EX_US_VOLUME_PROXY.description).toMatch(/not total overseas-exchange volume/);
  });
});
