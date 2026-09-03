const { CONTRACT_BY_ID } = require('./registry.cjs');
const {
  createPredictionMarketTestService,
  cryptoTrackerObservation,
  exactFeedProvidersAreLive,
  markFromCoinbase,
  markFromIbkr,
  selectSummaryLine,
  settlementFromKalshi,
} = require('./snapshotService.cjs');

const verifiedDefinition = (symbol) => ({
  rawSymbol: symbol,
  validation: { valid: true, code: 'VERIFIED_DATED_FUTURE' },
});

describe('Resolver Test snapshot semantics', () => {
  test('uses an exact live IBKR future only as a mark, never an official settlement', () => {
    const observation = markFromIbkr(CONTRACT_BY_ID.sp500, {
      provider: { status: 'live' },
      symbols: {
        ESU6: {
          status: 'live',
          definition: verifiedDefinition('ESU6'),
          quote: { bid: 7802, ask: 7803, asOf: '2026-08-14T19:59:55.000Z' },
          trade: { price: 7802.5, asOf: '2026-08-14T19:59:55.000Z' },
        },
      },
    }, new Date('2026-08-14T19:59:59.000Z'));

    expect(observation).toMatchObject({
      role: 'resolver',
      availability: 'live_exact',
      mark: 7802.5,
      symbol: 'ESU26',
    });
    expect(observation).not.toHaveProperty('final');
    expect(observation).not.toHaveProperty('tradingDate');
  });

  test('never promotes the CME WTI proxy to an exact resolver observation', () => {
    const observation = markFromIbkr(CONTRACT_BY_ID.wti, {
      provider: { status: 'live' },
      symbols: {
        CLU6: {
          status: 'live',
          definition: verifiedDefinition('CLU6'),
          quote: { bid: 80, ask: 80.02, asOf: '2026-08-14T18:29:59.000Z' },
          trade: null,
        },
      },
    }, new Date('2026-08-14T18:29:59.500Z'));

    expect(observation).toMatchObject({
      role: 'proxy',
      availability: 'live_proxy',
      symbol: 'CLU26',
      warning: 'CME PROXY — DOES NOT RESOLVE CONTRACT',
    });
  });

  test('drops disconnected feed values instead of retaining them as live', () => {
    const observation = markFromIbkr(CONTRACT_BY_ID.sp500, {
      provider: { status: 'unavailable' },
      symbols: {
        ESU6: {
          status: 'live',
          definition: verifiedDefinition('ESU6'),
          quote: { bid: 7799, ask: 7800, asOf: '2026-08-14T19:59:59.000Z' },
        },
      },
    }, new Date('2026-08-14T20:00:00.000Z'));

    expect(observation).toMatchObject({ availability: 'unavailable', bid: null, ask: null, mark: null });
  });

  test('clears stale and post-event IBKR marks', () => {
    const feed = {
      provider: { status: 'live' },
      symbols: {
        ESU6: {
          status: 'live',
          definition: verifiedDefinition('ESU6'),
          quote: { bid: 7799, ask: 7800, asOf: '2026-08-14T19:59:40.000Z' },
          trade: null,
        },
      },
    };
    expect(markFromIbkr(CONTRACT_BY_ID.sp500, feed, new Date('2026-08-14T19:59:59.000Z')))
      .toMatchObject({ availability: 'stale', bid: null, ask: null, mark: null });
    expect(markFromIbkr(CONTRACT_BY_ID.sp500, feed, new Date('2026-08-14T20:00:01.000Z')))
      .toMatchObject({ availability: 'market_closed', bid: null, ask: null, mark: null });
  });

  test('chooses factual nearest strikes without producing a directional signal', () => {
    const selected = selectSummaryLine([
      { venue: 'ForecastEx', ticker: 'LOW', strike: 7775, lastYes: 0.7 },
      { venue: 'ForecastEx', ticker: 'NEAR', strike: 7800, lastYes: 0.55 },
    ], { referenceValue: 7798 });
    expect(selected).toMatchObject({
      ticker: 'NEAR',
      selectionMethod: 'closest_strike_to_reference',
      distance: { points: -2, method: 'reference_minus_strike' },
    });
    expect(selected).not.toHaveProperty('signal');
    expect(selected).not.toHaveProperty('probabilityModel');
  });

  test('selects CPI by last/mid price nearest 50 cents', () => {
    expect(selectSummaryLine([
      { venue: 'ForecastEx', ticker: 'CPI-32', strike: 3.2, lastYes: 0.62 },
      { venue: 'Kalshi', ticker: 'CPI-33', strike: 3.3, yesBid: 0.47, yesAsk: 0.51 },
    ], { cpi: true })).toMatchObject({
      ticker: 'CPI-33',
      selectionMethod: 'closest_yes_price_to_50c',
      probabilityReference: { value: 0.49, method: 'calculated_yes_bbo_midpoint' },
    });
  });

  test('selects the crypto range containing the live reference', () => {
    expect(selectSummaryLine([
      { venue: 'Kalshi', ticker: 'LOW', strike: 60_000, strikeType: 'less', lowerBound: null, upperBound: 60_000 },
      { venue: 'Kalshi', ticker: 'MID', strike: 60_000, strikeType: 'between', lowerBound: 60_000, upperBound: 60_499.99 },
      { venue: 'Kalshi', ticker: 'HIGH', strike: 60_500, strikeType: 'greater', lowerBound: 60_500, upperBound: null },
    ], { referenceValue: 60_220, range: true })).toMatchObject({
      ticker: 'MID',
      selectionMethod: 'range_containing_or_nearest_reference',
      distance: { kind: 'range', contains: true, points: 220 },
    });
  });

  test('uses Coinbase only as a non-resolving crypto proxy', () => {
    expect(CONTRACT_BY_ID.bitcoin.feed).toBeUndefined();
    expect(markFromCoinbase(CONTRACT_BY_ID.bitcoin, { value: {
      bid: 62_790,
      ask: 62_810,
      price: 62_805,
      sourceTimestamp: '2026-08-14T20:59:55.000Z',
    } }, new Date('2026-08-14T20:59:59.000Z'))).toMatchObject({
      role: 'proxy', availability: 'live_proxy', mark: 62_800,
      warning: 'COINBASE SPOT PROXY — DOES NOT RESOLVE CONTRACT',
    });
  });

  test('accepts only the required-day Hedgeye crypto tracker publication', () => {
    const current = cryptoTrackerObservation(CONTRACT_BY_ID.ethereum, [{
      snapshotType: 'bitcoin-trend-tracker',
      date: '2026-08-14',
      scrapedAt: '2026-08-14T11:03:09.000Z',
      data: { cryptos: { ETH: { price: 1874, buyTrade: 1828, sellTrade: 1916, trend: 'BEARISH' } } },
    }]);
    expect(current).toMatchObject({
      publicationStatus: 'current',
      ticker: 'ETH',
      levels: { price: 1874, buyTrade: 1828, sellTrade: 1916, trend: 'BEARISH' },
    });
    expect(cryptoTrackerObservation(CONTRACT_BY_ID.ethereum, [{
      snapshotType: 'bitcoin-trend-tracker',
      date: '2026-08-13',
      data: { cryptos: { ETH: { price: 1800 } } },
    }])).toMatchObject({ publicationStatus: 'unavailable', levels: null });
  });

  test('requires every registry-declared exact feed before reporting aggregate live status', () => {
    expect(exactFeedProvidersAreLive({
      ibkrFutures: {
        status: 'degraded',
        symbols: {
          GCQ6: { status: 'live' }, ESU6: { status: 'live' }, NQU6: { status: 'unavailable' },
        },
      },
    })).toBe(false);
    expect(exactFeedProvidersAreLive({
      ibkrFutures: {
        status: 'degraded',
        symbols: {
          GCQ6: { status: 'live' }, ESU6: { status: 'live' }, NQU6: { status: 'live' }, CLU6: { status: 'unavailable' },
        },
      },
    })).toBe(true);
  });

  test('promotes Kalshi expiration values only with a final market result', () => {
    const unresolved = {
      settlementValue: 62_850.12,
      settlementConflict: false,
      fetchedAt: '2026-08-14T21:00:05.000Z',
      lines: [{ result: null }],
    };
    expect(settlementFromKalshi(CONTRACT_BY_ID.bitcoin, unresolved)).toBeNull();
    expect(settlementFromKalshi(CONTRACT_BY_ID.bitcoin, {
      ...unresolved,
      lines: [{ result: 'yes' }, { result: 'no' }],
    })).toMatchObject({
      availability: 'official_final',
      value: 62_850.12,
      source: 'kalshi_published_expiration_value',
    });
  });

  test('stamps and validates a snapshot when slow upstream work completes', async () => {
    let clock = new Date('2026-08-14T19:59:50.000Z');
    let releaseKalshi;
    const delayedKalshi = new Promise((resolve) => {
      releaseKalshi = resolve;
    });
    const feed = {
      getSnapshot: jest.fn(() => ({
        provider: { status: 'live' },
        symbols: {
          ESU6: {
            status: 'live',
            definition: verifiedDefinition('ESU6'),
            quote: { bid: 7799, ask: 7800, asOf: '2026-08-14T19:59:45.000Z' },
            trade: null,
          },
        },
      })),
      getHealth: jest.fn(() => ({ status: 'degraded', symbols: {} })),
      start: jest.fn(),
      stop: jest.fn(),
    };
    const publicSources = {
      getKalshiEvent: jest.fn()
        .mockImplementationOnce(() => delayedKalshi)
        .mockResolvedValue(null),
      getCoinbaseSpot: jest.fn(async () => null),
      getForecastExContracts: jest.fn(async () => null),
      getForecastExPairs: jest.fn(async () => null),
      getBlsCpi: jest.fn(async () => null),
      getHealth: jest.fn(() => ({})),
    };
    const service = createPredictionMarketTestService({
      feed,
      publicSources,
      now: () => new Date(clock),
    });

    const pendingSnapshot = service.getSnapshot();
    clock = new Date('2026-08-14T19:59:56.000Z');
    releaseKalshi(null);
    const result = await pendingSnapshot;
    const sp500 = result.products.find((product) => product.id === 'sp500');

    expect(result.generatedAt).toBe('2026-08-14T19:59:56.000Z');
    expect(sp500.resolverObservation).toMatchObject({
      availability: 'stale',
      bid: null,
      ask: null,
      mark: null,
    });
  });
});
