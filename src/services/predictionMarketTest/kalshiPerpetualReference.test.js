const { loadKalshiPerpetualReference, withPerpetualChartReference } = require('./kalshiPerpetualReference.cjs');
const { buildResolverChartSession } = require('./resolverChartSessions.cjs');

const NOW = Date.parse('2026-09-15T16:15:30.000Z');
const TICKER = 'KXBTCPERP';

function fixture(overrides = {}, marketId = 'bitcoin') {
  const ticker = marketId === 'ethereum' ? 'KXETHPERP' : TICKER;
  const contractSize = marketId === 'ethereum' ? 0.001 : 0.0001;
  const payloads = {
    market: { market: { ticker, status: 'active', contract_size: String(contractSize), underlying_multiplier: '1.000000',
      price: '9.9999', reference_price: { price: '8.8888', ts_ms: NOW },
      liquidation_mark_price: { price: '8.7777', ts_ms: NOW },
    } },
    trades: { trades: [{ ticker, price: '7.6258', created_time: '2026-09-15T16:15:20.000Z' }] },
    oneDay: { ticker, candlesticks: [
      { volume: '10.00', end_period_ts: (NOW - 90_000) / 1000, price: { close: '7.6100' } },
      { volume: '10.00', end_period_ts: (NOW - 30_000) / 1000, price: { close: '7.6200' } },
    ] },
    multiDay: { ticker, candlesticks: [
      { volume: '10.00', end_period_ts: (NOW - 24 * 60 * 60_000) / 1000, price: { close: '7.5000' } },
      { volume: '10.00', end_period_ts: (NOW - 30 * 60_000) / 1000, price: { close: '7.6000' } },
    ] },
    ...overrides,
  };
  const client = { get: jest.fn(async (url, options) => {
    const key = url.endsWith('/trades') ? 'trades'
      : url.endsWith('/candlesticks') ? options.params.period_interval === 1 ? 'oneDay' : 'multiDay'
        : 'market';
    if (payloads[key] instanceof Error) throw payloads[key];
    return { status: 200, data: payloads[key] };
  }) };
  const buildChartVariants = jest.fn(async ({ oneDayPoints, multiDayPoints, currentPoint, ...context }) => {
    const variants = Object.fromEntries(['1d', '5d', '10d'].map((range) => [range, {
      status: 'available', range, source: context.source,
      points: [...(range === '1d' ? oneDayPoints : multiDayPoints), ...(currentPoint ? [currentPoint] : [])],
      references: [], latestAt: currentPoint ? new Date(currentPoint.timestamp).toISOString() : null,
    }]));
    return { ...variants['1d'], variants };
  });
  const dependencies = {
    marketId, client, nowMs: NOW, buildChartVariants, buildResolverChartSession,
    loadRiskRangeHistory: jest.fn(), previousCalendarSessionDate: jest.fn(),
    previousCompletedClose: jest.fn(() => null),
  };
  return { payloads, dependencies, load: () => loadKalshiPerpetualReference(dependencies) };
}

describe('Kalshi Bitcoin perpetual reference', () => {
  test('uses timestamped trades and contract-size-normalized candles, with one exact line', async () => {
    const subject = fixture();
    const result = await subject.load();
    expect(result).toMatchObject({
      fit: 'exact', referenceKind: 'perpetual_contract', proxyFit: null,
      instrument: { symbol: TICKER, contractSize: 0.0001, perpetual: true },
      spot: { status: 'available', value: 76258, asOf: '2026-09-15T16:15:20.000Z',
        expiresAt: '2026-09-15T16:16:20.000Z', source: 'kalshi_perpetual_public_trades' },
    });
    expect(result.chart.points[0]).toMatchObject({ value: 76100, timestamp: NOW - 90_000 });
    expect(Object.keys(result.chartReferences)).toEqual(['basis']);
    expect(result.chartReferences.basis.spot).toBe(result.spot);
    expect(result.chartReferences.basis.chart).toBe(result.chart);
    expect(result.chart.ath).toBeUndefined();
    expect(subject.dependencies.buildChartVariants).toHaveBeenCalledWith(expect.objectContaining({
      config: expect.objectContaining({ riskRangeTicker: 'BITCOIN',
        chartSession: expect.objectContaining({ currentWindow: null, profile: expect.objectContaining({ kind: 'calendar' }) }),
      }),
      loadRiskRangeHistory: subject.dependencies.loadRiskRangeHistory,
    }));
    expect(subject.dependencies.client.get.mock.calls.every(([url]) => url.startsWith('https://external-api.kalshi.com/trade-api/v2/margin/'))).toBe(true);
  });

  test.each([
    ['offline', { connected: false }], ['stale', { stale: true }], ['cache-only', { cachedOnly: true }],
    ['cached', { fromCache: true }], ['seed', { seeded: true }], ['mock', { mock: true }],
    ['failed refresh', { refreshFailed: true }], ['metadata stale', { freshness: { status: 'stale' } }],
  ])('rejects %s snapshot evidence and clears every price range', async (_label, flags) => {
    const subject = fixture();
    Object.assign(subject.payloads.market, flags);
    const result = await subject.load();
    expect(result.spot).toMatchObject({ status: 'unavailable', value: null });
    expect(Object.values(result.chart.variants).map((variant) => variant.points)).toEqual([[], [], []]);
    expect(subject.dependencies.buildChartVariants).not.toHaveBeenCalled();
  });

  test.each([
    ['wrong ticker', { ticker: 'KXETHPERP' }], ['wrong contract size', { contract_size: '1' }],
    ['inactive', { status: 'inactive' }], ['closed', { schedule: { is_open: false } }],
  ])('rejects %s contract identity', async (_label, flags) => {
    const subject = fixture();
    Object.assign(subject.payloads.market.market, flags);
    expect((await subject.load()).spot.value).toBeNull();
  });

  test.each([
    ['stale', { created_time: '2026-09-15T16:14:00.000Z' }],
    ['future', { created_time: '2026-09-15T16:16:00.000Z' }],
    ['missing timestamp', { created_time: null }],
    ['wrong contract', { ticker: 'KXETHPERP' }],
    ['seeded', { seeded: true }], ['cached', { cachedOnly: true }], ['mock', { mock: true }],
  ])('does not substitute snapshot price or mark for a %s trade', async (_label, overrides) => {
    const subject = fixture();
    Object.assign(subject.payloads.trades.trades[0], overrides);
    const result = await subject.load();
    expect(result.spot).toMatchObject({ status: 'unavailable', value: null, asOf: null });
    expect(result.chart.points.map((point) => point.value)).toEqual([76100, 76200]);
  });

  test('clears failed fine history while independently verified coarse history remains usable', async () => {
    const result = await fixture({ oneDay: new Error('offline') }).load();
    expect(result.chart).toMatchObject({ status: 'unavailable', points: [] });
    expect(result.chart.variants['5d'].points.length).toBeGreaterThan(0);
    expect(result.spot.status).toBe('available');
  });

  test('uses the candle ending exactly at midnight ET for the prior session close', async () => {
    const subject = fixture();
    const boundary = Date.parse('2026-09-15T04:00:00.000Z');
    subject.payloads.multiDay.candlesticks.unshift(
      { volume: '10.00', end_period_ts: (boundary - 60 * 60_000) / 1000, price: { close: '7.4000' } },
      { volume: '10.00', end_period_ts: boundary / 1000, price: { close: '7.5500' } },
    );
    const result = await subject.load();
    expect(result.spot).toMatchObject({ previousClose: 75500,
      previousCloseAsOf: '2026-09-15T04:00:00.000Z', previousCloseSource: 'kalshi_perpetual_public_candles' });
    expect(result.chart.variants['5d']).toMatchObject({ previousClose: 75500,
      previousCloseAsOf: '2026-09-15T04:00:00.000Z' });
    expect(result.chart.variants['5d'].points.find((point) => point.value === 75500)).toMatchObject({ timestamp: boundary });
  });

  test('omits daily change baseline when the exact midnight candle is unavailable', async () => {
    const subject = fixture();
    const boundary = Date.parse('2026-09-15T04:00:00.000Z');
    subject.payloads.multiDay.candlesticks.unshift(
      { volume: '10.00', end_period_ts: (boundary - 60 * 60_000) / 1000, price: { close: '7.4000' } },
    );
    const result = await subject.load();
    expect(result.spot.status).toBe('available');
    expect(result.spot.previousClose).toBeUndefined();
    expect(result.chart.variants['5d'].previousClose).toBeUndefined();
  });

  test('clears a stale coarse response even when a new current trade is available', async () => {
    const subject = fixture();
    subject.payloads.multiDay.candlesticks = [{ volume: '10.00', end_period_ts: (NOW - 2 * 60 * 60_000) / 1000, price: { close: '7.2' } }];
    const result = await subject.load();
    expect(result.chart.variants['5d'].points).toEqual([]);
    expect(result.chart.variants['10d'].points).toEqual([]);
    expect(result.chart.points.length).toBeGreaterThan(0);
  });

  test('rejects marked candles and does not use previous, mid, bid or ask as trade prices', async () => {
    const subject = fixture();
    subject.payloads.oneDay.candlesticks = [
      { volume: '10.00', end_period_ts: (NOW - 60_000) / 1000, price: { close: null, previous: '7.6' }, bid: { close: '7.6' } },
      { volume: '10.00', end_period_ts: (NOW - 30_000) / 1000, price: { close: '7.6' }, seeded: true },
      { volume: '0.00', end_period_ts: (NOW - 20_000) / 1000, price: { close: '7.6' } },
    ];
    const result = await subject.load();
    expect(result.chart.points).toEqual([]);
    expect(result.chart.status).toBe('unavailable');
  });

  test('a later transport failure never keeps the preceding response', async () => {
    const subject = fixture();
    expect((await subject.load()).spot.status).toBe('available');
    subject.payloads.market = new Error('offline');
    const result = await subject.load();
    expect(result.spot.value).toBeNull();
    expect(result.chart.points).toEqual([]);
  });

  test('single-reference wrapper removes legacy Coinbase prices, comparison and ATH context', () => {
    const result = withPerpetualChartReference({
      spot: { status: 'available', source: 'coinbase_exchange_public_ticker', value: 76000 },
      chart: { status: 'available', source: 'coinbase_exchange_public_candles', points: [{ value: 76000 }], ath: { value: 126000 } },
      chartReferences: { basis: {}, contract: {} }, proxyFit: { status: 'available' },
      backgroundRefresh: true,
    });
    expect(result.spot.value).toBeNull();
    expect(result.chart.points).toEqual([]);
    expect(result.chart.ath).toBeUndefined();
    expect(result.proxyFit).toBeNull();
    expect(Object.keys(result.chartReferences)).toEqual(['basis']);
    expect(result.backgroundRefresh).toBe(true);
  });
});

describe('Kalshi Ethereum perpetual reference', () => {
  test('uses the ETH contract and publication ticker without a Bitcoin or Coinbase fallback', async () => {
    const subject = fixture({}, 'ethereum');
    subject.payloads.trades.trades[0].price = '2.3965';
    subject.payloads.oneDay.candlesticks[0].price.close = '2.3940';
    subject.payloads.oneDay.candlesticks[1].price.close = '2.3960';
    const result = await subject.load();
    expect(result).toMatchObject({
      fit: 'exact', referenceKind: 'perpetual_contract', proxyFit: null,
      instrument: { symbol: 'KXETHPERP', underlyingSymbol: 'ETH', contractSize: 0.001, priceUnit: 'USD/ETH' },
      spot: { status: 'available', value: 2396.5, label: 'ETH',
        asOf: '2026-09-15T16:15:20.000Z', expiresAt: '2026-09-15T16:16:20.000Z',
        source: 'kalshi_perpetual_public_trades' },
      chartReferences: { basis: { symbol: 'ETH', riskRangeTicker: 'ETH', exact: true } },
    });
    expect(result.chart.points.map((point) => point.value)).toEqual([2394, 2396, 2396.5]);
    expect(Object.keys(result.chartReferences)).toEqual(['basis']);
    expect(subject.dependencies.buildChartVariants).toHaveBeenCalledWith(expect.objectContaining({
      config: expect.objectContaining({ label: 'Kalshi Ethereum perpetual', riskRangeTicker: 'ETH',
        chartSession: expect.objectContaining({ profile: expect.objectContaining({ kind: 'calendar' }) }),
      }),
    }));
    expect(subject.dependencies.client.get.mock.calls.every(([url, options]) => (
      url.includes('/KXETHPERP') || options.params?.ticker === 'KXETHPERP'
    ))).toBe(true);
  });

  test.each([
    ['offline', { connected: false }], ['stale', { stale: true }], ['cache-only', { cachedOnly: true }],
    ['seed', { seeded: true }], ['mock', { mock: true }], ['fixture', { fixture: true }],
    ['failed refresh', { refreshFailed: true }],
  ])('clears ETH prices and history when %s follows a verified response', async (_label, flags) => {
    const subject = fixture({}, 'ethereum');
    expect((await subject.load()).spot.status).toBe('available');
    Object.assign(subject.payloads.market, flags);
    const result = await subject.load();
    expect(result.spot).toMatchObject({ status: 'unavailable', value: null, label: 'ETH',
      reason: 'Verified Kalshi Ethereum perpetual data is unavailable.' });
    expect(Object.values(result.chart.variants).map((variant) => variant.points)).toEqual([[], [], []]);
  });

  test('rejects Bitcoin trade and candle evidence in an ETH response', async () => {
    const subject = fixture({}, 'ethereum');
    subject.payloads.trades.trades[0].ticker = TICKER;
    subject.payloads.oneDay.ticker = TICKER;
    subject.payloads.multiDay.ticker = TICKER;
    const result = await subject.load();
    expect(result.spot.value).toBeNull();
    expect(Object.values(result.chart.variants).map((variant) => variant.points)).toEqual([[], [], []]);
  });

  test('removes legacy ETH Coinbase references and ATH without relabeling them as a perpetual', () => {
    const result = withPerpetualChartReference({
      spot: { status: 'available', source: 'coinbase_exchange_public_ticker', value: 2400 },
      chart: { status: 'available', source: 'coinbase_exchange_public_candles', points: [{ value: 2400 }], ath: { value: 4900 } },
      chartReferences: { basis: {}, contract: {} }, proxyFit: { status: 'available' },
    }, 'ethereum');
    expect(result.instrument.symbol).toBe('KXETHPERP');
    expect(result.spot.value).toBeNull();
    expect(result.chart.points).toEqual([]);
    expect(result.chart.ath).toBeUndefined();
    expect(Object.keys(result.chartReferences)).toEqual(['basis']);
    expect(result.proxyFit).toBeNull();
  });
});

test('does not issue perpetual requests for an unsupported market', async () => {
  const subject = fixture({}, 'unsupported');
  await expect(subject.load()).rejects.toThrow('Unsupported Kalshi perpetual reference market.');
  expect(subject.dependencies.client.get).not.toHaveBeenCalled();
  const reference = { spot: { value: null } };
  expect(withPerpetualChartReference(reference, 'unsupported')).toBe(reference);
});
