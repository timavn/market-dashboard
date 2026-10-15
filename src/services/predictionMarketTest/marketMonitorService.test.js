const {
  MARKET_CONFIGS,
  buildBookQuality,
  buildCpiForecastComparison,
  buildEquivalenceFingerprint,
  buildForecastSettlementBasis,
  buildKalshiSettlementBasis,
  buildSourceHealth,
  chunkKalshiTickers,
  createMarketMonitorService,
  mergeExactVenueContracts,
  mergeVenueDisplayContracts,
  selectAutoVenue,
  selectCftcRow,
  selectDisplayVenue,
  selectForecastContractUniverse,
  selectForecastGeneration,
  selectExactCpiKalshiEvent,
  selectKalshiEvent,
} = require('./marketMonitorService.cjs');

const NOW = Date.parse('2026-08-19T16:00:00.000Z');
const AS_OF = '2026-08-19T16:00:00.000Z';
const EXPIRES = '2026-08-19T16:01:30.000Z';
const CLOSE = '2026-08-19T20:00:00.000Z';

function publishedTradePayload(ticker, fields = {}, retained = false) {
  const trade = {
    status: retained ? 'historical' : 'available', value: 'BULLISH', sourceId: 'early-look',
    sourceDate: '2026-08-19', sourceTicker: ticker, publishedAt: AS_OF,
    sourceUrl: 'https://app.hedgeye.com/feed_items/123',
    signalProvenance: { field: 'trade', sourceField: 'article.bodyText', method: 'explicit-statement', sourceText: `${ticker} is BULLISH on TRADE.` },
    ...fields,
  };
  return { schemaVersion: 2, marketDate: '2026-08-19', bySymbol: { [ticker]: {
    decision: { trade: retained ? { status: 'unavailable' } : trade },
    lastVerifiedDecision: { trade: retained ? trade : null },
  } } };
}

describe('market monitor CFTC cohort selection', () => {
  const managed = {
    metric: 'SILVER', cftcContractMarketCode: '084691', seriesType: 'disaggregated-managed-money-combined',
    asOf: '2026-08-11', status: 'current', decisionEligible: true,
    latest: 14176, wwChg: 2006, zScore1Y: -0.13, zScore3Y: -0.68,
  };
  const primary = {
    ...managed, seriesType: 'legacy-noncommercial-combined',
    latest: 24736, wwChg: -500, zScore1Y: -0.41, zScore3Y: -0.89, alternateSeries: [managed],
  };
  const official = (overrides = {}) => ({
    snapshotType: 'cftc-positioning', schemaVersion: 'cftc-positioning-v3',
    calculationVersion: 'cftc-combined-net-sample-z-v2', source: 'cftc-public-reporting-environment',
    sourceContentHash: 'a'.repeat(64), datasetIds: { legacy: 'srt6-5q2f', disaggregated: 'rxbv-e226' },
    date: '2026-08-11', reportDate: '2026-08-11', decisionEligible: true, data: [primary], ...overrides,
  });

  test('keeps Silver monitor managed money when the v3 main row becomes non-commercial', () => {
    expect(selectCftcRow(official(), MARKET_CONFIGS.silver, NOW)).toMatchObject({
      status: 'available', latest: 14176, weeklyChange: 2006, zScore1Y: -0.13, zScore3Y: -0.68,
      seriesType: 'disaggregated-managed-money-combined', calculationVersion: 'cftc-combined-net-sample-z-v2',
    });
    expect(selectCftcRow(official({
      schemaVersion: 'cftc-positioning-v2', calculationVersion: 'cftc-combined-net-sample-z-v1', data: [managed],
    }), MARKET_CONFIGS.silver, NOW)).toMatchObject({ status: 'available', latest: 14176 });
  });

  test('omits the factor when its exact cohort is missing, ambiguous, stale or unverified', () => {
    const invalid = [
      official({ data: [{ ...primary, alternateSeries: [] }] }),
      official({ data: [{ ...primary, alternateSeries: [managed, managed] }] }),
      official({ data: [primary, managed] }),
      official({ data: [{ ...primary, alternateSeries: [{ ...managed, source: 'manual' }] }] }),
      official({ data: [{ ...primary, alternateSeries: [{ ...managed, asOf: '2026-08-04' }] }] }),
      official({ data: [{ ...primary, alternateSeries: [{ ...managed, zScore1Y: null }] }] }),
      official({ data: [{ ...primary, alternateSeries: [{ ...managed, cacheOnly: true }] }] }),
      official({ data: [{ ...primary, alternateSeries: [{ ...managed, mock: true }] }] }),
      official({ sourceStatus: 'offline' }), official({ cacheState: 'stale' }), official({ seeded: true }),
      official({ calculationVersion: 'cftc-combined-net-sample-z-v1' }),
    ];
    invalid.forEach((snapshot) => {
      expect(selectCftcRow(snapshot, MARKET_CONFIGS.silver, NOW)).toMatchObject({ status: 'unavailable', zScore1Y: null });
    });
    expect(selectCftcRow(official(), MARKET_CONFIGS.silver, Date.parse('2026-09-01T16:00:00Z')).status).toBe('unavailable');
  });
});

test('reports verified completed-session resolver data as closed instead of unavailable', () => {
  const sourceHealth = buildSourceHealth({
    config: { forecastExProduct: null },
    venues: {},
    reference: {
      spot: { status: 'historical', source: 'ibkr_historical_daily_close', asOf: AS_OF },
      chart: { status: 'historical', source: 'ibkr_historical_bars', asOf: AS_OF },
    },
    riskRange: { status: 'available', source: 'risk_range', asOf: AS_OF },
  });

  expect(sourceHealth).toEqual(expect.arrayContaining([
    expect.objectContaining({
      id: 'resolver_spot', status: 'closed', lastSuccessAt: AS_OF,
    }),
    expect.objectContaining({
      id: 'resolver_chart', status: 'closed', lastSuccessAt: AS_OF,
    }),
  ]));
});

function line(overrides = {}) {
  return {
    ticker: 'LINE-100',
    threshold: 100,
    lowerBound: 100,
    upperBound: null,
    comparator: '>',
    status: 'available',
    yesBid: 0.40,
    yesAsk: 0.42,
    noBid: 0.58,
    noAsk: 0.60,
    yesBidSize: 10,
    yesAskSize: 10,
    noBidSize: 10,
    noAskSize: 10,
    updatedAt: AS_OF,
    directNative: true,
    derivedFields: [],
    ...overrides,
  };
}

function identity(overrides = {}) {
  return {
    resolver: 'official_close',
    underlying: 'cash_index',
    observationTime: CLOSE,
    geometry: 'threshold',
    strikeGeometry: [{ comparator: '>', lowerBound: 100, upperBound: null, threshold: 100 }],
    payout: 1,
    unit: 'index_points',
    currency: 'USD',
    ...overrides,
  };
}

function venue(id, overrides = {}) {
  const lines = overrides.lines || [line({ ticker: `${id}-100` })];
  const contracts = {
    status: 'available',
    source: 'native_live_api',
    asOf: AS_OF,
    expiresAt: EXPIRES,
    event: { ticker: `${id}-EVENT`, status: 'open', closeTime: CLOSE },
    lines,
    ...overrides.contracts,
  };
  return {
    id,
    label: id,
    brokerRoutable: true,
    equivalenceFingerprint: overrides.fingerprint || buildEquivalenceFingerprint(identity()),
    contracts,
    bookQuality: buildBookQuality(lines),
  };
}

function kalshiMarket(eventTicker, threshold, closeTime = CLOSE, overrides = {}) {
  return {
    ticker: `${eventTicker}-T${threshold}`,
    event_ticker: eventTicker,
    status: 'open',
    close_time: closeTime,
    floor_strike: threshold,
    strike_type: 'greater',
    yes_bid_dollars: '0.40',
    yes_ask_dollars: '0.42',
    no_bid_dollars: '0.58',
    no_ask_dollars: '0.60',
    yes_bid_size_fp: '10',
    yes_ask_size_fp: '10',
    no_bid_size_fp: '10',
    no_ask_size_fp: '10',
    ...overrides,
  };
}

function kalshiEvent(config, ticker, closeTime = CLOSE, overrides = {}) {
  return {
    event_ticker: ticker,
    series_ticker: config.seriesTicker,
    status: 'open',
    available_on_brokers: true,
    strike_date: closeTime,
    markets: [kalshiMarket(ticker, 100, closeTime), kalshiMarket(ticker, 110, closeTime)],
    ...overrides,
  };
}

function cpiMarket(threshold, overrides = {}) {
  const eventTicker = 'KXCPIYOY-26AUG';
  const closeTime = '2026-09-11T12:29:00.000Z';
  return kalshiMarket(eventTicker, threshold, closeTime, {
    ticker: `${eventTicker}-T${threshold}`,
    rules_primary: `If the Consumer Price Index (CPI) increases by more than ${threshold}% in the twelve months ending August 2026 (as represented by the one-decimal place value reported by the Bureau of Labor Statistics), then the market resolves to Yes.`,
    rules_secondary: 'The initial one-decimal BLS release is the authoritative outcome.',
    ...overrides,
  });
}

function cpiEvent(overrides = {}) {
  return {
    event_ticker: 'KXCPIYOY-26AUG',
    series_ticker: 'KXCPIYOY',
    status: 'active',
    title: 'Inflation in August 2026 (CPI YoY)',
    available_on_brokers: false,
    settlement_sources: [{
      name: 'Bureau of Labor Statistics',
      url: 'https://www.bls.gov/cpi/',
    }],
    markets: [cpiMarket(2.5), cpiMarket(2.6)],
    ...overrides,
  };
}

describe('authoritative settlement-basis metadata', () => {
  const pythEvent = (name, url) => ({
    strike_date: CLOSE,
    settlement_sources: [{ name, url }],
  });
  const pythLine = (asset, overrides = {}) => ({
    ticker: `KX-${asset}-100`,
    rulesPrimary: `If the close price of the 1-minute candlestick for ${asset} is above 100, the market resolves Yes.`,
    rulesSecondary: 'The immediately preceding one-minute interval closes at the observation time.',
    customStrike: { strike_date: CLOSE },
    ...overrides,
  });

  test('exposes the exact Kalshi ICE WBS contract by reusing the settlement mapping', () => {
    const event = {
      strike_date: CLOSE,
      settlement_sources: [{ name: 'ICE', url: 'https://www.theice.com/products/213/WTI-Crude-Futures' }],
    };
    const lines = [100, 110].map((threshold) => ({
      ticker: `KXWTI-${threshold}`,
      rules_primary: `If the daily settlement price for WTI crude oil (October 2026 contract) is above ${threshold} USD/Bbl, the market resolves Yes.`,
      rules_secondary: 'The settlement value is rounded to the nearest 2 decimal places.',
      custom_strike: { front_month_contract: 'WBS 26V-ICE', strike_date: CLOSE },
    }));

    expect(buildKalshiSettlementBasis(MARKET_CONFIGS.wti, event, lines)).toEqual({
      status: 'verified',
      instrument: 'WBS 26V-ICE',
      instrumentScope: 'exact',
      method: 'Official daily settlement',
      observationAt: CLOSE,
      sourceName: 'ICE',
      sourceUrl: 'https://www.theice.com/products/213/WTI-Crude-Futures',
      rulesUrl: null,
      reason: null,
    });
  });

  test('verifies the exact KXCPIYOY BLS initial one-decimal resolver', () => {
    const event = cpiEvent();
    expect(buildKalshiSettlementBasis(MARKET_CONFIGS.cpi, event, event.markets)).toEqual({
      status: 'verified',
      instrument: 'All Items CPI-U YoY',
      instrumentScope: 'exact',
      method: 'Initial one-decimal year-over-year release',
      observationAt: '2026-09-11T12:29:00.000Z',
      sourceName: 'Bureau of Labor Statistics',
      sourceUrl: 'https://www.bls.gov/cpi/',
      rulesUrl: null,
      reason: null,
    });
  });

  test('rejects CPI settlement metadata from a non-BLS host', () => {
    const event = cpiEvent({
      settlement_sources: [{ name: 'Bureau of Labor Statistics', url: 'https://example.com/cpi' }],
    });
    expect(buildKalshiSettlementBasis(MARKET_CONFIGS.cpi, event, event.markets))
      .toMatchObject({ status: 'unavailable', instrument: null, sourceUrl: null });
  });

  test.each([
    ['gold', 'gold', 'Pyth - Gold', 'https://app.pyth.com/explore/Metal.Index.GOLD%2FUSD?cluster=pythnet', 'Metal.Index.GOLD/USD'],
    ['gold', 'gold', 'Pyth - Gold', 'https://app.pyth.com/explore/Metal.Index.1OZGOLD%2FUSD?returnUrl=%2Fexplore%2Fall%3Fsearch%3D3712%26state%3Dstable', 'Metal.Index.1OZGOLD/USD'],
    ['silver', 'silver', 'Pyth - Silver', 'https://app.pyth.com/explore/Metal.Index.SILVER%2FUSD?cluster=pythnet', 'Metal.Index.SILVER/USD'],
  ])('verifies the event-specific Kalshi Pyth basis for %s', (marketId, asset, sourceName, sourceUrl, instrument) => {
    expect(buildKalshiSettlementBasis(
      MARKET_CONFIGS[marketId],
      pythEvent(sourceName, sourceUrl),
      [pythLine(asset), pythLine(asset, { ticker: `KX-${asset}-110` })],
    )).toMatchObject({
      status: 'verified', instrument, method: '1-minute close', observationAt: CLOSE,
      sourceName: 'Pyth', sourceUrl,
    });
  });

  test.each([
    ['gold', 'gold', 'https://pythdata.app/explore/Metal.XAU%2FUSD'],
    ['gold', 'gold', 'https://app.pyth.com/explore/Metal.Index.SILVER%2FUSD'],
    ['gold', 'gold', 'https://example.com/explore/Metal.Index.1OZGOLD%2FUSD'],
    ['silver', 'silver', 'https://pythdata.app/explore/Metal.XAG%2FUSD'],
  ])('rejects the legacy %s Pyth mapping as the wrong resolver generation', (marketId, asset, sourceUrl) => {
    expect(buildKalshiSettlementBasis(
      MARKET_CONFIGS[marketId],
      pythEvent(`Pyth - ${asset}`, sourceUrl),
      [pythLine(asset), pythLine(asset, { ticker: `KX-${asset}-110` })],
    )).toMatchObject({ status: 'unavailable', instrument: null });
  });

  test('verifies the exact event-specific Kalshi Brent Pyth symbol', () => {
    const lines = [100, 110].map((threshold) => ({
      ticker: `KXBRENT-${threshold}`,
      rulesPrimary: `If the close price of the 1-minute candlestick for brent using the BRENTX6 contract is above ${threshold}, the market resolves Yes.`,
      rulesSecondary: 'The settlement candlestick is published by the Pyth feed.',
      customStrike: { front_month_contract: 'BRENTX6', strike_date: CLOSE },
    }));
    expect(buildKalshiSettlementBasis(
      MARKET_CONFIGS.brent,
      pythEvent('Pyth', 'https://pythdata.app/explore'),
      lines,
    )).toMatchObject({
      status: 'verified',
      instrument: 'Commodities.BRENTX6/USD',
      method: '1-minute close',
      sourceName: 'Pyth',
    });
  });

  test('verifies the current index-style Brent generation with a published N/A front month', () => {
    const lines = [100, 110].map((threshold) => ({
      ticker: `KXBRENT-${threshold}`,
      rulesPrimary: `If the close price of the 1-minute candlestick for Brent crude oil is above ${threshold}, the market resolves Yes.`,
      rulesSecondary: 'The settlement candlestick is published by the Pyth feed.',
      customStrike: { front_month_contract: 'N/A', strike_date: CLOSE },
    }));
    expect(buildKalshiSettlementBasis(
      MARKET_CONFIGS.brent,
      pythEvent('Pyth Network', 'https://app.pyth.com/explore/Commodities.Index.BRENT%2FUSD'),
      lines,
    )).toMatchObject({
      status: 'verified',
      instrument: 'Commodities.Index.BRENT/USD',
      instrumentScope: 'exact',
      method: '1-minute close',
    });
  });

  test('verifies the Kalshi CF Benchmarks BRTI final-minute sampling method', () => {
    const lines = [100000, 110000].map((threshold) => ({
      ticker: `KXBTC-${threshold}`,
      rulesPrimary: `The market uses the average of 60 BRTI observations sampled in the final minute before expiration above ${threshold}.`,
      rulesSecondary: 'BRTI is the CF Benchmarks Bitcoin Real-Time Index.',
      customStrike: { strike_date: CLOSE },
    }));
    expect(buildKalshiSettlementBasis(
      MARKET_CONFIGS.bitcoin,
      pythEvent('CF Benchmarks', 'https://www.cfbenchmarks.com/data/indices/BRTI'),
      lines,
    )).toMatchObject({
      status: 'verified', instrument: 'BRTI', method: 'Final-minute 60-sample average',
      sourceName: 'CF Benchmarks', observationAt: CLOSE,
    });
  });

  test.each([
    ['bitcoin', 'BRTI', 'Bitcoin', 'BRTI'],
    ['ethereum', 'ERTI', 'Ethereum', 'ETHUSD_RTI'],
  ])('accepts the current %s sixty-second and 60 RTI-prices wording', (marketId, resolverIndex, label, sourcePath) => {
    const lines = [100000, 110000].map((threshold) => ({
      ticker: `${MARKET_CONFIGS[marketId].seriesTicker}-${threshold}`,
      rulesPrimary: `If the simple average of the sixty seconds of CF Benchmarks' ${label} Real-Time Index (${resolverIndex}) before 8 PM EDT is above ${threshold} at 8 PM EDT, then the market resolves to Yes.`,
      rulesSecondary: 'At the last minute before expiration, 60 RTI prices are collected. The official and final value is the average of these prices.',
      closeAt: CLOSE,
      customStrike: null,
    }));
    const event = {
      observationTime: CLOSE,
      settlementSources: [{
        name: 'CF Benchmarks',
        url: `https://www.cfbenchmarks.com/data/indices/${sourcePath}?ref=blog.cfbenchmarks.com`,
      }],
    };
    expect(buildKalshiSettlementBasis(
      MARKET_CONFIGS[marketId],
      event,
      lines,
    )).toMatchObject({
      status: 'verified', instrument: resolverIndex, instrumentScope: 'exact',
      method: 'Final-minute 60-sample average', observationAt: CLOSE,
    });
  });

  test.each([
    ['Bitcoin source', 'https://www.cfbenchmarks.com/data/indices/BRTI', 'Ethereum Real-Time Index (ERTI)'],
    ['Bitcoin rules', 'https://www.cfbenchmarks.com/data/indices/ETHUSD_RTI', 'Bitcoin Real-Time Index (BRTI)'],
    ['untrusted source', 'https://example.com/data/indices/ETHUSD_RTI', 'Ethereum Real-Time Index (ERTI)'],
    ['malformed source', 'not-a-url', 'Ethereum Real-Time Index (ERTI)'],
  ])('rejects Ethereum settlement with %s', (_label, sourceUrl, indexName) => {
    const lines = [{
      rulesPrimary: `The average of 60 ${indexName} observations in the final minute before expiration is above 3200.`,
      closeAt: CLOSE,
    }];
    expect(buildKalshiSettlementBasis(
      MARKET_CONFIGS.ethereum,
      pythEvent('CF Benchmarks', sourceUrl),
      lines,
    ).status).toBe('unavailable');
  });

  function forecastLine(productId, strike, question, overrides = {}) {
    return {
      productId,
      contractId: `${productId}_081926_${strike}`,
      strike,
      question,
      rulesUrl: `https://data.forecastex.com/regulatory/${productId}TermsandConditions.pdf`,
      lastTradeDate: CLOSE,
      expirationDate: '2026-08-20T15:00:00.000Z',
      payoutDate: '2026-08-20T17:00:00.000Z',
      ...overrides,
    };
  }

  test.each([
    ['sp500', 'FES', 'ESU26', 'CME', (strike) => `Will Sep-26 S&P 500 Index Futures settle above $${strike} on August 19 2026?`],
    ['nasdaq100', 'FNQ', 'NQU26', 'CME', (strike) => `Will Sep-26 Nasdaq-100 Index Futures settle above $${strike} on August 19 2026?`],
    ['gold', 'METLG', 'GCU26', 'COMEX', (strike) => `Will September 2026 COMEX Gold Futures settle above $${strike} on August 19 2026?`],
    ['silver', 'METLS', 'SIU26', 'COMEX', (strike) => `Will September 2026 COMEX Silver Futures settle above $${strike} on August 19 2026?`],
  ])('verifies the exact dated ForecastEx resolver for %s', (marketId, productId, instrument, sourceName, question) => {
    const lines = [100, 110].map((strike) => forecastLine(productId, strike, question(strike)));
    expect(buildForecastSettlementBasis({
      generationId: `${productId}_081926`, generationKey: `${productId}_081926`, closeAt: CLOSE, lines,
    }, MARKET_CONFIGS[marketId])).toMatchObject({
      status: 'verified', instrument, method: 'Official daily settlement', sourceName, observationAt: CLOSE,
    });
  });

  test('represents official generic ForecastEx COMCO terms without inventing a futures month', () => {
    const lines = [80, 82].map((strike) => forecastLine(
      'COMCO',
      strike,
      `Will CME front-month WTI futures settle above $${strike} on August 19 2026?`,
    ));
    expect(buildForecastSettlementBasis({ closeAt: CLOSE, lines }, MARKET_CONFIGS.wti)).toMatchObject({
      status: 'verified',
      instrument: 'WTI Crude Oil Futures',
      method: 'Official front-month daily settlement',
      sourceName: 'CME',
    });
  });

  test.each([
    ['gold', 'METLG', 'Gold', 'COMEX Gold Futures'],
    ['silver', 'METLS', 'Silver', 'COMEX Silver Futures'],
  ])('represents generic ForecastEx %s terms as a product-level partial basis', (marketId, productId, asset, instrument) => {
    const lines = [100, 110].map((strike) => forecastLine(
      productId,
      strike,
      `Will ${asset} futures settle above $${strike} on August 19 2026?`,
    ));
    expect(buildForecastSettlementBasis({ closeAt: CLOSE, lines }, MARKET_CONFIGS[marketId])).toMatchObject({
      status: 'partial',
      instrument,
      instrumentScope: 'product',
      method: 'Official front-month daily settlement',
      sourceName: 'COMEX',
      reason: expect.stringMatching(/exact (?:futures )?contract month/i),
    });
  });

  test.each([
    ['conflicting observations', () => buildKalshiSettlementBasis(
      MARKET_CONFIGS.gold,
      pythEvent('Pyth - Gold', 'https://pythdata.app/explore/Metal.XAU%2FUSD'),
      [pythLine('gold'), pythLine('gold', { customStrike: { strike_date: '2026-08-19T21:00:00.000Z' } })],
    )],
    ['missing official source', () => buildKalshiSettlementBasis(
      MARKET_CONFIGS.silver,
      { strike_date: CLOSE, settlement_sources: [] },
      [pythLine('silver')],
    )],
    ['unknown WTI contract month', () => buildKalshiSettlementBasis(
      MARKET_CONFIGS.wti,
      { strike_date: CLOSE, settlement_sources: [{ name: 'ICE', url: 'https://www.theice.com/products/213/WTI-Crude-Futures' }] },
      [{
        ticker: 'KXWTI-100',
        rules_primary: 'The daily settlement price for WTI crude oil (unknown contract) is used in USD/Bbl.',
        rules_secondary: 'Rounded to the nearest 2 decimal places.',
        custom_strike: { front_month_contract: 'WBS UNKNOWN-ICE', strike_date: CLOSE },
      }],
    )],
    ['attempted chart-proxy fallback', () => buildKalshiSettlementBasis(
      { ...MARKET_CONFIGS.brent, kalshiResolver: { underlying: 'BZ', observationTime: CLOSE } },
      { strike_date: CLOSE, settlement_sources: [{ name: 'Proxy chart', url: 'https://example.com/bz' }] },
      [{ ticker: 'BZ', customStrike: { strike_date: CLOSE }, rulesPrimary: 'Use the chart price.' }],
    )],
  ])('fails closed for %s', (_label, build) => {
    expect(build()).toMatchObject({ status: 'unavailable', instrument: null, method: null });
  });
});

describe('market monitor event discovery', () => {
  test('selects only the unique nearest open 4 PM Kalshi generation', () => {
    const config = MARKET_CONFIGS.nasdaq100;
    const nearestTicker = 'KXNASDAQ100U-26AUG19H1600';
    const laterTicker = 'KXNASDAQ100U-26AUG20H1600';
    const events = [
      kalshiEvent(config, 'KXNASDAQ100U-26AUG18H1600', '2026-08-18T20:00:00.000Z'),
      kalshiEvent(config, 'KXNASDAQ100U-26AUG19H1500', CLOSE),
      kalshiEvent(config, 'KXINXU-26AUG19H1600', CLOSE, { series_ticker: 'KXINXU' }),
      kalshiEvent(config, nearestTicker, CLOSE),
      kalshiEvent(config, laterTicker, '2026-08-20T20:00:00.000Z'),
    ];

    expect(selectKalshiEvent(events, config, NOW)?.event.event_ticker).toBe(nearestTicker);
  });

  test.each([
    ['closed event', (event) => ({ ...event, status: 'closed' })],
    ['expired markets', (event) => ({
      ...event,
      markets: event.markets.map((market) => ({ ...market, close_time: '2026-08-18T20:00:00.000Z' })),
    })],
    ['mixed observation times', (event) => ({
      ...event,
      markets: [event.markets[0], { ...event.markets[1], close_time: '2026-08-19T21:00:00.000Z' }],
    })],
  ])('rejects a %s', (_label, mutate) => {
    const config = MARKET_CONFIGS.nasdaq100;
    const candidate = kalshiEvent(config, 'KXNASDAQ100U-26AUG19H1600');
    expect(selectKalshiEvent([mutate(candidate)], config, NOW)).toBeNull();
  });

  test('fails closed when two Kalshi events are ambiguous at the same observation time', () => {
    const config = MARKET_CONFIGS.wti;
    expect(selectKalshiEvent([
      kalshiEvent(config, 'KXWTI-26AUG19-A'),
      kalshiEvent(config, 'KXWTI-26AUG19-B'),
    ], config, NOW)).toBeNull();
  });

  test('pins the standard WTI card to the daily family and never rolls it to weekly', () => {
    const config = MARKET_CONFIGS.wti;
    const daily = kalshiEvent(config, 'KXWTI-26AUG19', CLOSE);
    const weekly = kalshiEvent(config, 'KXWTIW-26AUG19', CLOSE, { series_ticker: 'KXWTIW' });

    expect(selectKalshiEvent([weekly, daily], config, NOW)).toMatchObject({
      seriesTicker: 'KXWTI',
      event: { event_ticker: 'KXWTI-26AUG19' },
    });
    expect(selectKalshiEvent([weekly], config, NOW)).toBeNull();
  });

  test('classifies Brent daily and weekly families without reading PM clock text as monthly', () => {
    const config = MARKET_CONFIGS.brent;
    const daily = kalshiEvent(config, 'KXBRENTD-26AUG1917', CLOSE, {
      series_ticker: 'KXBRENTD',
      title: 'Brent crude oil price on August 19, 2026 at 5:00 PM EDT?',
    });
    const weekly = kalshiEvent(config, 'KXBRENTW-26AUG2117', CLOSE, {
      series_ticker: 'KXBRENTW',
      title: 'Brent crude oil price on August 21, 2026 at 5:00 PM EDT?',
    });

    expect(selectKalshiEvent([daily], config, NOW, daily.event_ticker)).toMatchObject({
      cadence: 'daily',
      seriesTicker: 'KXBRENTD',
    });
    expect(selectKalshiEvent([weekly], config, NOW, weekly.event_ticker)).toBeNull();
  });

  test('keeps a current public Kalshi catalog even when it is not broker routable', () => {
    const config = MARKET_CONFIGS.wti;
    const event = kalshiEvent(config, 'KXWTI-26AUG19', CLOSE, { available_on_brokers: false });
    expect(selectKalshiEvent([event], config, NOW)).toMatchObject({
      event: { event_ticker: 'KXWTI-26AUG19', available_on_brokers: false },
      markets: expect.any(Array),
    });
  });

  test('selects a unique current ForecastEx product generation and rejects prior, wrong, mixed, or ambiguous generations', () => {
    const valid = {
      productId: 'FNQ', contractId: 'FNQ_081926_100', strike: 100, lastTradeDate: CLOSE,
    };
    expect(selectForecastGeneration([
      { ...valid, productId: 'FES' },
      { ...valid, contractId: 'FNQ_081826_100', lastTradeDate: '2026-08-18T20:00:00.000Z' },
      valid,
      { ...valid, contractId: 'FNQ_081926_110', strike: 110 },
      { ...valid, contractId: 'FNQ_082026_100', lastTradeDate: '2026-08-20T20:00:00.000Z' },
    ], 'FNQ', NOW)?.generationKey).toBe('FNQ_081926');

    expect(selectForecastGeneration([
      valid,
      { ...valid, contractId: 'FNQ_081926_110', lastTradeDate: '2026-08-19T21:00:00.000Z' },
    ], 'FNQ', NOW)).toBeNull();
    expect(selectForecastGeneration([
      valid,
      { ...valid, contractId: 'FNQ_082026_100' },
    ], 'FNQ', NOW)?.generationKey).toBe('FNQ_081926');
    expect(selectForecastGeneration([
      { ...valid, contractId: 'FNQ_081426_100', lastTradeDate: CLOSE },
    ], 'FNQ', NOW)).toBeNull();
    expect(selectForecastGeneration([{
      ...valid,
      contractId: 'FNQ_081926_100',
      lastTradeDate: '2026-08-20T01:00:00.000Z',
    }], 'FNQ', NOW)?.generationKey).toBe('FNQ_081926');
  });

  test('requires every FES strike to agree on the exact futures month and official schedule', () => {
    const base = {
      productId: 'FES',
      contractId: 'FES_082026_7375',
      strike: 7375,
      question: 'Will Sep-26 S&P 500 Index Futures settle above $7,375 on August 20 2026?',
      lastTradeDate: '2026-08-20T20:00:00.000Z',
      expirationDate: '2026-08-21T15:00:00.000Z',
      payoutDate: '2026-08-21T17:00:00.000Z',
      rulesUrl: 'https://data.forecastex.com/regulatory/FESTermsandConditions.pdf',
    };
    const second = {
      ...base,
      contractId: 'FES_082026_7400',
      strike: 7400,
      question: 'Will Sep-26 S&P 500 Index Futures settle above $7,400 on August 20 2026?',
    };
    expect(selectForecastGeneration([base, second], 'FES', Date.parse('2026-08-20T17:00:00Z'))).toMatchObject({
      generationKey: 'FES_082026', resolverSymbol: 'ESU26', underlyingContractMonth: '202609',
    });
    expect(selectForecastGeneration([base, { ...second, question: 'Will Dec-26 S&P 500 Index Futures settle above $7,400 on August 20 2026?' }], 'FES', Date.parse('2026-08-20T17:00:00Z'))).toBeNull();
    expect(selectForecastGeneration([base, { ...second, payoutDate: '2026-08-21T18:00:00.000Z' }], 'FES', Date.parse('2026-08-20T17:00:00Z'))).toBeNull();
    expect(selectForecastGeneration([base, { ...second, lastTradeDate: '2026-08-19T20:00:00.000Z' }], 'FES', Date.parse('2026-08-20T17:00:00Z'))).toBeNull();
    expect(selectForecastGeneration([base, { ...second, rulesUrl: 'https://example.com/FESTermsandConditions.pdf' }], 'FES', Date.parse('2026-08-20T17:00:00Z'))).toBeNull();
  });
});

describe('FES spot-centered contract universe', () => {
  test('selects five strikes per side, includes the exact strike, and caps liquid outliers at two per side', () => {
    const contracts = Array.from({ length: 21 }, (_, index) => ({
      contractId: `FES_081926_${index * 25}`,
      strike: index * 25,
      volume24h: 0,
      openInterest: 0,
    }));
    contracts[0].volume24h = 800;
    contracts[1].openInterest = 900;
    contracts[18].volume24h = 800;
    contracts[20].openInterest = 900;

    const selected = selectForecastContractUniverse(contracts, 250);

    expect(selected.map(({ strike }) => strike)).toEqual([
      0, 25,
      125, 150, 175, 200, 225,
      250,
      275, 300, 325, 350, 375,
      450, 500,
    ]);
    expect(selected).toHaveLength(15);
  });

  test('uses at most ten current-generation high-activity rows before spot is verified', () => {
    const contracts = Array.from({ length: 20 }, (_, index) => ({
      contractId: `FES_081926_${index * 25}`,
      strike: index * 25,
      volume24h: index * 100,
      openInterest: 0,
    }));

    const selected = selectForecastContractUniverse(contracts, null);

    expect(selected).toHaveLength(10);
    expect(selected.map(({ strike }) => strike)).toEqual([
      250, 275, 300, 325, 350, 375, 400, 425, 450, 475,
    ]);
    expect(selectForecastContractUniverse(
      contracts.map((contract) => ({ ...contract, volume24h: 499 })),
      null,
    )).toEqual([]);
  });
});

describe('market monitor equivalence and Auto venue policy', () => {
  test('fingerprints the resolver, dated observation, comparator geometry, payout, unit, and currency', () => {
    const base = buildEquivalenceFingerprint(identity());
    expect(base).toMatch(/^[a-f0-9]{64}$/);
    [
      identity({ resolver: 'other_close' }),
      identity({ observationTime: '2026-08-20T20:00:00.000Z' }),
      identity({ strikeGeometry: [{ comparator: '<', lowerBound: 100, upperBound: null, threshold: 100 }] }),
      identity({ payout: 100 }),
      identity({ unit: 'usd_per_barrel' }),
      identity({ currency: 'CAD' }),
    ].forEach((changed) => expect(buildEquivalenceFingerprint(changed)).not.toBe(base));
    expect(buildEquivalenceFingerprint({ ...identity(), strikeGeometry: [] })).toBeNull();
  });

  test('requires complete two-sided native books and positive displayed size on every side', () => {
    expect(buildBookQuality([line()])).toMatchObject({
      eligible: true,
      executableLineCount: 1,
      displayedDepth: 40,
    });
    expect(buildBookQuality([line({ noBidSize: 0 })])).toMatchObject({
      eligible: false,
      executableLineCount: 0,
    });
    expect(buildBookQuality([line({ noAsk: null })]).eligible).toBe(false);
    expect(buildBookQuality([line({ directNative: false })]).eligible).toBe(false);
  });

  test('shows fresh partial native quotes even when the execution gate stays closed', () => {
    const partialLine = line({ noAskSize: null });
    const partialVenue = venue('kalshi', {
      lines: [partialLine],
      contracts: { status: 'partial' },
    });
    partialVenue.book = partialVenue.contracts;
    partialVenue.catalog = {
      ...partialVenue.contracts,
      status: 'available',
      source: 'kalshi_trade_api_v2_catalog',
      lines: [{ ...partialLine, yesBid: null, yesAsk: null, noBid: null, noAsk: null, directNative: false }],
    };

    const autoSelection = selectAutoVenue({ kalshi: partialVenue }, NOW);
    const displaySelection = selectDisplayVenue({ kalshi: partialVenue }, autoSelection);
    const displayContracts = mergeVenueDisplayContracts(partialVenue);

    expect(autoSelection).toMatchObject({ status: 'unavailable', venueId: null });
    expect(displaySelection).toMatchObject({
      status: 'available', mode: 'live_quotes', venueId: 'kalshi', label: 'kalshi live quotes',
    });
    expect(displayContracts).toMatchObject({
      status: 'available', scheduleOnly: false, bookStatus: 'partial',
      lines: [expect.objectContaining({ yesBid: 0.40, yesAsk: 0.42, noBid: 0.58, noAsk: 0.60, directNative: true })],
    });
  });

  test('prefers fresh native partial quotes over a nearer catalog-only generation', () => {
    const partialLine = line({ ticker: 'PARTIAL-100', noAskSize: null });
    const partialVenue = venue('forecastex', {
      lines: [partialLine],
      contracts: { status: 'partial', event: { ticker: 'FARTHER', status: 'open', closeTime: '2026-08-19T21:00:00.000Z' } },
    });
    partialVenue.book = partialVenue.contracts;
    partialVenue.catalog = {
      ...partialVenue.contracts,
      status: 'available',
      source: 'forecastex_official_schedule',
      lines: [{ ...partialLine, yesBid: null, yesAsk: null, noBid: null, noAsk: null, directNative: false }],
    };
    const catalogVenue = venue('kalshi');
    catalogVenue.book = { ...catalogVenue.contracts, status: 'unavailable', lines: [] };
    catalogVenue.catalog = {
      ...catalogVenue.contracts,
      status: 'available',
      source: 'kalshi_trade_api_v2_catalog',
      event: { ticker: 'NEARER', status: 'open', closeTime: '2026-08-19T20:01:00.000Z' },
      lines: [line({ ticker: 'CATALOG-100', directNative: false, yesBid: null, yesAsk: null, noBid: null, noAsk: null })],
    };

    const display = selectDisplayVenue(
      { kalshi: catalogVenue, forecastex: partialVenue },
      { status: 'unavailable' },
    );

    expect(display).toMatchObject({
      status: 'available', mode: 'live_quotes', venueId: 'forecastex',
      contracts: { scheduleOnly: false, bookStatus: 'partial' },
    });
  });

  test('selects the highest verified 24-hour volume among open daily display venues', () => {
    const dailyVenue = (id, volume24h, openInterest) => {
      const candidate = venue(id);
      const event = { ...candidate.contracts.event, cadence: 'daily' };
      candidate.contracts = { ...candidate.contracts, event };
      candidate.book = candidate.contracts;
      candidate.catalog = { ...candidate.contracts, status: 'available', event };
      candidate.settlementBasis = { status: 'verified', instrumentScope: 'exact' };
      candidate.reference = {
        fit: 'exact',
        spot: { status: 'available' },
      };
      candidate.activity = {
        volume24h: { value: volume24h },
        selectedGenerationOpenInterest: { value: openInterest },
      };
      return candidate;
    };
    const kalshi = dailyVenue('kalshi', 24_000, 18_000);
    const forecastex = dailyVenue('forecastex', 0, 40_000);

    expect(selectDisplayVenue(
      { kalshi, forecastex },
      { status: 'available', venueId: 'forecastex' },
      { standardCadence: 'daily', preferVerifiedVolume: true },
    )).toMatchObject({
      venueId: 'kalshi',
      reason: expect.stringMatching(/strongest verified 24-hour volume/i),
    });

    forecastex.activity.volume24h.value = null;
    expect(selectDisplayVenue(
      { kalshi, forecastex },
      { status: 'available', venueId: 'forecastex' },
      { standardCadence: 'daily', preferVerifiedVolume: true },
    )).toMatchObject({ venueId: 'kalshi' });
  });

  test.each([
    { refreshing: true, refreshFailed: false },
    { refreshing: false, refreshFailed: true },
  ])('clears live fields while a native book is unsafe: %p', (unsafeState) => {
    const liveLine = line();
    const unsafeVenue = venue('kalshi', { lines: [liveLine] });
    unsafeVenue.book = { ...unsafeVenue.contracts, ...unsafeState };
    unsafeVenue.catalog = {
      ...unsafeVenue.contracts,
      status: 'available',
      source: 'kalshi_trade_api_v2_catalog',
      lines: [{ ...liveLine, yesBid: null, yesAsk: null, noBid: null, noAsk: null, directNative: false }],
    };

    const displayContracts = mergeVenueDisplayContracts(unsafeVenue);
    const autoSelection = selectAutoVenue({ kalshi: unsafeVenue }, NOW);

    expect(displayContracts).toMatchObject({
      status: 'available', scheduleOnly: true,
      lines: [expect.objectContaining({
        yesBid: null, yesAsk: null, noBid: null, noAsk: null, directNative: false,
      })],
    });
    expect(autoSelection).toMatchObject({ status: 'unavailable', venueId: null });
  });

  test('merges only exact fingerprints and chooses price ties by size, spread, then freshness', () => {
    const first = venue('kalshi', {
      lines: [line({
        ticker: 'K-100', yesAsk: 0.42, yesAskSize: 20, yesBid: 0.40,
        noAsk: 0.60, noAskSize: 10, noBid: 0.58,
      })],
    });
    const second = venue('forecastex', {
      lines: [line({
        ticker: 'F-100', yesAsk: 0.42, yesAskSize: 20, yesBid: 0.41,
        noAsk: 0.59, noAskSize: 10, noBid: 0.57,
        updatedAt: '2026-08-19T16:00:01.000Z',
      })],
    });
    const merged = mergeExactVenueContracts([first, second], NOW);
    expect(merged).not.toBeNull();
    expect(merged.lines[0]).toMatchObject({
      yesAsk: 0.42,
      yesBid: 0.41,
      noAsk: 0.59,
      quoteSources: expect.objectContaining({ yesAsk: 'forecastex', yesBid: 'forecastex', noAsk: 'forecastex' }),
    });

    second.equivalenceFingerprint = buildEquivalenceFingerprint(identity({ resolver: 'different' }));
    expect(mergeExactVenueContracts([first, second], NOW)).toBeNull();
  });

  test('ranks complete non-equivalent books by close time, exact-generation OI, then stable identity', () => {
    const shallowTwoLines = venue('kalshi', {
      fingerprint: buildEquivalenceFingerprint(identity({ resolver: 'kalshi' })),
      lines: [line({ ticker: 'K-100', threshold: 100 }), line({ ticker: 'K-110', threshold: 110, lowerBound: 110 })],
    });
    const deepOneLine = venue('forecastex', {
      fingerprint: buildEquivalenceFingerprint(identity({ resolver: 'forecastex' })),
      lines: [line({ ticker: 'F-100', yesBidSize: 1000, yesAskSize: 1000, noBidSize: 1000, noAskSize: 1000 })],
    });
    expect(selectAutoVenue({ forecastex: deepOneLine, kalshi: shallowTwoLines }, NOW)).toMatchObject({
      mode: 'most_executable',
      venueId: 'forecastex',
    });

    shallowTwoLines.contracts.expiresAt = '2026-08-19T15:59:59.000Z';
    expect(selectAutoVenue({ forecastex: deepOneLine, kalshi: shallowTwoLines }, NOW).venueId).toBe('forecastex');
    deepOneLine.contracts.source = 'cached_disconnected_snapshot';
    expect(selectAutoVenue({ forecastex: deepOneLine, kalshi: shallowTwoLines }, NOW)).toMatchObject({
      status: 'unavailable',
      venueId: null,
    });

    const unroutable = venue('kalshi');
    unroutable.brokerRoutable = false;
    expect(selectAutoVenue({ kalshi: unroutable }, NOW)).toMatchObject({
      status: 'unavailable',
      venueId: null,
    });
  });
});

describe('Kalshi batch orderbook boundaries', () => {
  test.each([
    [1, [1]],
    [100, [100]],
    [101, [100, 1]],
    [400, [100, 100, 100, 100]],
  ])('chunks %i tickers into documented batches no larger than 100', (count, expected) => {
    const chunks = chunkKalshiTickers(Array.from({ length: count }, (_, index) => `TICKER-${index}`));
    expect(chunks.map((chunk) => chunk.length)).toEqual(expected);
    expect(chunks.flat()).toHaveLength(count);
  });
});

describe('CPI prediction monitor snapshot', () => {
  const CPI_NOW = Date.parse('2026-09-02T16:00:00.000Z');
  const CPI_RELEASE_AT = '2026-09-11T12:30:00.000Z';
  const currentRelease = (overrides = {}) => ({
    ok: true,
    series: 'KXCPIYOY',
    releaseKey: 'KXCPIYOY#2026-08',
    reportMonth: '2026-08',
    forecastMonth: 'August 2026',
    releaseDate: '2026-09-11',
    releaseAt: CPI_RELEASE_AT,
    eventTicker: 'KXCPIYOY-26AUG',
    targetStrikes: [2.5, 2.6],
    scenarios: [
      { key: 'upside', label: 'Upside', value: 2.8 },
      { key: 'base', label: 'Base Case', value: 2.6 },
      { key: 'downside', label: 'Downside', value: 2.4 },
    ],
    source: {
      type: 'hedgeye-inflation-nowcast',
      asOf: '2026-08-28T14:00:00.000Z',
      reportMonth: '2026-08',
    },
    ...overrides,
  });
  const clevelandPayload = () => ({
    status: 'available',
    requiredMonth: '2026-08',
    sourceMonth: '2026-08',
    source: 'cleveland_fed_inflation_nowcasting',
    sourceUrl: 'https://www.clevelandfed.org/indicators-and-data/inflation-nowcasting',
    datasetAsOf: '2026-09-02T15:00:00.000Z',
    points: [
      { timestamp: Date.parse('2026-08-25T15:00:00.000Z'), value: 2.5 },
      { timestamp: Date.parse('2026-09-02T15:00:00.000Z'), value: 2.6 },
    ],
  });
  const blsPayload = () => ({
    source: 'bls_public_data_api',
    seriesId: 'CUUR0000SA0',
    fetchedAt: '2026-09-02T15:30:00.000Z',
    finals: [{
      id: '2026-07',
      value: 2.7,
      source: 'bls_public_data_api',
      seriesId: 'CUUR0000SA0',
      sourceUrl: 'https://www.bls.gov/cpi/',
    }],
  });

  function createCpiSubject({
    event = cpiEvent(),
    release = currentRelease(),
    orderbookImplementation = null,
    cleveland = clevelandPayload(),
    bls = blsPayload(),
  } = {}) {
    const kalshiFetch = jest.fn(async (path, query) => {
      if (path === '/events/KXCPIYOY-26AUG') {
        expect(query).toEqual({ with_nested_markets: true });
        return { event };
      }
      throw new Error(`Unexpected Kalshi request ${path}`);
    });
    const defaultOrderbooks = async (tickers) => new Map(tickers.map((ticker) => [ticker, {
      market_ticker: ticker,
      orderbook_fp: {
        yes_dollars: [['0.40', '12']],
        no_dollars: [['0.58', '15']],
      },
    }]));
    const loadKalshiOrderbooks = jest.fn(orderbookImplementation || defaultOrderbooks);
    const loadCurrentCpiRelease = jest.fn(async () => release);
    const loadClevelandCpi = jest.fn(async () => cleveland);
    const loadCpiFinals = jest.fn(async () => bls);
    const service = createMarketMonitorService({
      now: () => new Date(CPI_NOW),
      publicSources: {},
      spxMonitorService: { getSnapshot: jest.fn() },
      kalshiFetch,
      loadKalshiOrderbooks,
      loadCurrentCpiRelease,
      loadClevelandCpi,
      loadCpiFinals,
      refreshBudgetMs: 5_000,
    });
    return {
      service,
      kalshiFetch,
      loadKalshiOrderbooks,
      loadCurrentCpiRelease,
      loadClevelandCpi,
      loadCpiFinals,
    };
  }

  test('forced CPI acquisition rereads release identity and both reference sources', async () => {
    const clock = jest.spyOn(Date, 'now').mockReturnValue(1000);
    try {
      const subject = createCpiSubject();
      await subject.service.getSnapshot('cpi', { venue: 'kalshi' });
      await subject.service.getSnapshot('cpi', { venue: 'kalshi' });
      expect(subject.loadCurrentCpiRelease).toHaveBeenCalledTimes(1);
      clock.mockReturnValue(2000);
      await subject.service.getSnapshot('cpi', { venue: 'kalshi', forceRefresh: true, refreshAfter: 2000 });
      for (const loader of [subject.loadCurrentCpiRelease, subject.loadClevelandCpi, subject.loadCpiFinals]) {
        expect(loader).toHaveBeenCalledTimes(2);
        expect(loader).toHaveBeenLastCalledWith(expect.objectContaining({ useCache: false }));
      }
    } finally { clock.mockRestore(); }
  });

  test('selects the actual monthly KXCPIYOY title only for the exact active release', () => {
    expect(selectExactCpiKalshiEvent(
      { event: cpiEvent() },
      MARKET_CONFIGS.cpi,
      currentRelease(),
      CPI_NOW,
    )).toMatchObject({
      generationId: 'KXCPIYOY-26AUG',
      seriesTicker: 'KXCPIYOY',
      cadence: 'monthly',
      closeTime: '2026-09-11T12:29:00.000Z',
    });
    expect(selectExactCpiKalshiEvent(
      { event: cpiEvent({ event_ticker: 'KXCPIYOY-26JUL' }) },
      MARKET_CONFIGS.cpi,
      currentRelease(),
      CPI_NOW,
    )).toBeNull();
  });

  test('builds exact-month Hedgeye, Cleveland Fed, and prior BLS comparison sources', () => {
    expect(buildCpiForecastComparison(
      currentRelease(),
      clevelandPayload(),
      blsPayload(),
      CPI_NOW,
    )).toMatchObject({
      status: 'available',
      releaseKey: 'KXCPIYOY#2026-08',
      reportMonth: '2026-08',
      hedgeye: { status: 'available', baseValue: 2.6 },
      clevelandFed: { status: 'available', value: 2.6 },
      bls: { status: 'available', latestFinal: { reportMonth: '2026-07', value: 2.7 } },
    });
  });

  test('does not label an older BLS checkpoint as the latest prior actual', () => {
    const comparison = buildCpiForecastComparison(
      currentRelease(),
      clevelandPayload(),
      {
        ...blsPayload(),
        finals: [{
          id: '2026-06',
          value: 3.5,
          source: 'bls_release',
          sourceUrl: 'https://www.bls.gov/cpi/',
        }],
      },
      CPI_NOW,
    );

    expect(comparison).toMatchObject({
      status: 'partial',
      bls: {
        status: 'unavailable',
        expectedPriorMonth: '2026-07',
        latestFinal: null,
      },
    });
  });

  test('publishes a display-only live Kalshi CPI ladder with verified research context', async () => {
    const subject = createCpiSubject();
    const snapshot = await subject.service.getSnapshot('cpi', { venue: 'kalshi' });

    expect(snapshot).toMatchObject({
      schemaVersion: 2,
      marketId: 'cpi',
      status: 'available',
      selectedVenueId: 'kalshi',
      selectedGenerationId: 'KXCPIYOY-26AUG',
      spot: { status: 'unavailable', value: null, availability: 'not_applicable' },
      riskRange: { status: 'unavailable', lrr: null, hrr: null, fit: 'not_applicable' },
      venues: {
        kalshi: {
          brokerRoutable: false,
          settlementBasis: {
            status: 'verified',
            instrument: 'All Items CPI-U YoY',
            observationAt: CPI_RELEASE_AT,
            sourceName: 'Bureau of Labor Statistics',
          },
          catalog: {
            status: 'available',
            event: {
              eventTicker: 'KXCPIYOY-26AUG',
              releaseKey: 'KXCPIYOY#2026-08',
              reportMonth: '2026-08',
              releaseAt: CPI_RELEASE_AT,
            },
          },
          book: { status: 'available' },
        },
      },
      forecastComparison: {
        status: 'available',
        hedgeye: { status: 'available', baseValue: 2.6 },
        clevelandFed: { status: 'available', value: 2.6 },
        bls: { status: 'available', latestFinal: { reportMonth: '2026-07', value: 2.7 } },
      },
      ladderReference: {
        status: 'available', kind: 'hedgeye_base', value: 2.6,
        reportMonth: '2026-08', executable: false,
      },
      strategy: { status: 'unavailable', model: null, eligibleVenueId: null },
    });
    expect(snapshot.venues.kalshi.book.lines).toHaveLength(2);
    snapshot.venues.kalshi.book.lines.forEach((bookLine) => {
      expect(bookLine).toMatchObject({ directNative: true, yesBid: 0.4, yesAsk: 0.42 });
    });
    expect(snapshot.executionContracts.lines).toHaveLength(0);
    expect(subject.kalshiFetch).toHaveBeenCalledTimes(1);
    expect(subject.loadKalshiOrderbooks).toHaveBeenCalledWith([
      'KXCPIYOY-26AUG-T2.5',
      'KXCPIYOY-26AUG-T2.6',
    ]);
    expect(subject.loadCpiFinals).toHaveBeenCalledWith(expect.objectContaining({
      awaitRemote: true,
    }));
    expect(subject.loadClevelandCpi).toHaveBeenCalledWith(expect.objectContaining({
      useCache: true,
    }));
  });

  test('fails closed when the targeted endpoint returns a different CPI release', async () => {
    const wrongEvent = cpiEvent({
      event_ticker: 'KXCPIYOY-26JUL',
      markets: cpiEvent().markets.map((market) => ({
        ...market,
        event_ticker: 'KXCPIYOY-26JUL',
        ticker: market.ticker.replace('26AUG', '26JUL'),
      })),
    });
    const subject = createCpiSubject({ event: wrongEvent });
    const snapshot = await subject.service.getSnapshot('cpi');

    expect(snapshot.venues.kalshi.catalog).toMatchObject({ status: 'unavailable', lines: [] });
    expect(snapshot.venues.kalshi.book).toMatchObject({ status: 'unavailable', lines: [] });
    expect(subject.loadKalshiOrderbooks).not.toHaveBeenCalled();
    expect(snapshot.status).toBe('partial');
  });

  test('keeps catalog geometry but clears quotes when BLS settlement identity is not verified', async () => {
    const subject = createCpiSubject({
      event: cpiEvent({
        settlement_sources: [{ name: 'Bureau of Labor Statistics', url: 'https://example.com/cpi' }],
      }),
    });
    const snapshot = await subject.service.getSnapshot('cpi');

    expect(snapshot.venues.kalshi.settlementBasis.status).toBe('unavailable');
    expect(snapshot.venues.kalshi.catalog.lines).toHaveLength(2);
    expect(snapshot.venues.kalshi.book).toMatchObject({
      status: 'unavailable', lines: [], scheduleOnly: true,
    });
    snapshot.displayContracts.lines.forEach((bookLine) => {
      expect(bookLine).toMatchObject({
        directNative: false,
        yesBid: null,
        yesAsk: null,
        noBid: null,
        noAsk: null,
      });
    });
    expect(snapshot.executionContracts.lines).toHaveLength(0);
  });

  test('does not retain a previously live CPI book after an orderbook refresh failure', async () => {
    let orderbookCall = 0;
    const subject = createCpiSubject({
      orderbookImplementation: async (tickers) => {
        orderbookCall += 1;
        if (orderbookCall > 1) throw Object.assign(new Error('Kalshi CPI book offline'), { code: 'CPI_BOOK_OFFLINE' });
        return new Map(tickers.map((ticker) => [ticker, {
          market_ticker: ticker,
          orderbook_fp: { yes_dollars: [['0.40', '12']], no_dollars: [['0.58', '15']] },
        }]));
      },
    });
    const live = await subject.service.getSnapshot('cpi');
    const failed = await subject.service.getSnapshot('cpi');

    expect(live.venues.kalshi.book.lines).toEqual(expect.arrayContaining([
      expect.objectContaining({ directNative: true, yesBid: 0.4 }),
    ]));
    expect(failed.venues.kalshi.book).toMatchObject({
      status: 'unavailable', refreshFailed: true, asOf: null, expiresAt: null,
    });
    failed.venues.kalshi.book.lines.forEach((bookLine) => {
      expect(bookLine).toMatchObject({
        directNative: false,
        yesBid: null,
        yesAsk: null,
        noBid: null,
        noAsk: null,
      });
    });
    expect(failed.executionContracts.lines).toHaveLength(0);
  });
});

describe('normalized multi-market snapshots', () => {
  function createSubject({
    spxSnapshot = null,
    forecastLive = null,
    forecastLiveError = null,
    marketReference = null,
    riskRanges = null,
    cryptoTrackerSnapshots = [],
    tradeSnapshots = [],
    usdSnapshot = null,
    volatilitySnapshot = null,
    tradeError = null,
    orderbookError = null,
    forecastContracts = null,
    refreshBudgetMs = undefined,
    kalshiEventOverrides = null,
    now = () => new Date(NOW),
  } = {}) {
    const publicSources = {
      getForecastExContracts: jest.fn(async (productId) => {
        if (typeof forecastContracts === 'function') return forecastContracts(productId);
        if (forecastContracts) return forecastContracts;
        return ({
        productId,
        fetchedAt: AS_OF,
        lines: [{
          productId,
          contractId: `${productId}_081926_100`,
          strike: 100,
          lastTradeDate: CLOSE,
          ...(productId === 'FES' ? {
            question: 'Will Sep-26 S&P 500 Index Futures settle above $100 on August 19 2026?',
            expirationDate: '2026-08-20T15:00:00.000Z',
            payoutDate: '2026-08-20T17:00:00.000Z',
            resolverSymbol: 'ESU26',
            underlyingContractMonth: '202609',
            rulesUrl: 'https://data.forecastex.com/regulatory/FESTermsandConditions.pdf',
          } : {}),
          openInterest: 500,
        }],
        });
      }),
    };
    const kalshiFetch = jest.fn(async (_path, query) => {
      const config = Object.values(MARKET_CONFIGS).find((entry) => (
        entry.seriesTicker === query.series_ticker || entry.seriesTickers?.includes(query.series_ticker)
      ));
      const ticker = `${query.series_ticker}-26AUG19${config.eventSuffix || ''}`;
      const overrides = typeof kalshiEventOverrides === 'function'
        ? kalshiEventOverrides(config, ticker)
        : kalshiEventOverrides;
      return { events: [kalshiEvent(config, ticker, CLOSE, {
        series_ticker: query.series_ticker,
        ...(overrides || {}),
      })] };
    });
    const loadRiskRanges = jest.fn(async () => riskRanges);
    const loadCryptoTracker = jest.fn(async () => cryptoTrackerSnapshots);
    const loadTradeSnapshots = jest.fn(async () => {
      if (tradeError) throw tradeError;
      return tradeSnapshots;
    });
    const loadMarketReference = jest.fn(async (...args) => (
      typeof marketReference === 'function' ? marketReference(...args) : marketReference
    ));
    const loadForecastExLive = jest.fn(async (...args) => {
      if (forecastLiveError) throw forecastLiveError;
      return (typeof forecastLive === 'function' ? forecastLive(...args) : forecastLive)
        || { status: 'unavailable', fetchedAt: null, lines: [] };
    });
    const spxMonitorService = {
      getSnapshot: jest.fn(async () => spxSnapshot || { schemaVersion: 1, status: 'unavailable', contracts: { status: 'unavailable', lines: [] } }),
    };
    const loadKalshiOrderbooks = jest.fn(async (tickers) => {
      if (orderbookError) throw orderbookError;
      return new Map(tickers.map((ticker) => [ticker, {
        ticker,
        orderbook_fp: {
          yes_dollars: [['0.40', '10']],
          no_dollars: [['0.58', '10']],
        },
      }]));
    });
    const service = createMarketMonitorService({
      now,
      publicSources,
      kalshiFetch,
      spxMonitorService,
      loadForecastExLive,
      refreshBudgetMs,
      loadKalshiOrderbooks,
      loadRiskRanges,
      loadCryptoTracker,
      loadTradeSnapshots,
      loadVolatilitySnapshot: jest.fn(async () => volatilitySnapshot),
      loadCftcSnapshots: jest.fn(async () => []),
      loadUsdSnapshot: jest.fn(async () => usdSnapshot),
      loadMarketReference,
    });
    return {
      service,
      publicSources,
      kalshiFetch,
      loadKalshiOrderbooks,
      loadRiskRanges,
      loadCryptoTracker,
      loadTradeSnapshots,
      loadMarketReference,
      spxMonitorService,
      loadForecastExLive,
    };
  }

  test.each([['silver', 'METLS'], ['nasdaq100', 'FNQ']])(
    '%s starts its native acquisition before unrelated references or activity finish and preserves the pending generation',
    async (marketId, productId) => {
      let finishReference; let finishNative; let finishActivity;
      const reference = new Promise(resolve => { finishReference = resolve; });
      const native = new Promise(resolve => { finishNative = resolve; });
      const activity = new Promise(resolve => { finishActivity = resolve; });
      const subject = createSubject({
        refreshBudgetMs: 250, marketReference: () => reference, forecastLive: () => native,
      });
      subject.publicSources.getForecastExPairs = jest.fn(() => activity);
      try {
        const first = subject.service.getSnapshot(marketId, { venue: 'forecastex' });
        await new Promise(resolve => setTimeout(resolve, 5));
        expect(subject.loadForecastExLive).toHaveBeenCalledTimes(1);
        const pending = await first;
        expect(pending.venues.forecastex).toMatchObject({
          generationId: `${productId}_081926`,
          catalog: { status: 'available', asOf: AS_OF, event: { ticker: `${productId}_081926` } },
          book: { refreshing: true, event: { ticker: `${productId}_081926` } },
          generations: [expect.objectContaining({ generationId: `${productId}_081926` })],
        });
        expect(pending.venues.forecastex.book.lines.every(row => row.yesBid == null && row.noAsk == null)).toBe(true);
        finishNative({
          status: 'available', fetchedAt: AS_OF, brokerRoutable: true,
          lines: [{
            contractId: `${productId}_081926_100`, directNative: true, dataType: 'live',
            provenance: 'ibkr_tws_forecastex_live', updatedAt: AS_OF,
            yesBid: 0.40, yesAsk: 0.42, noBid: 0.58, noAsk: 0.60,
            yesBidSize: 10, yesAskSize: 12, noBidSize: 14, noAskSize: 16,
          }],
        });
        const withBook = await subject.service.getSnapshot(marketId, { venue: 'forecastex' });
        expect(withBook.sourceRefreshPending).toBe(true);
        expect(withBook.venues.forecastex.book).toMatchObject({
          status: 'available', asOf: AS_OF, refreshing: false,
          lines: [expect.objectContaining({ yesBid: 0.40, noAsk: 0.60, directNative: true })],
        });
        expect(subject.loadForecastExLive).toHaveBeenCalledTimes(1);
        expect(subject.publicSources.getForecastExContracts).toHaveBeenCalledTimes(1);
        finishReference(null); finishActivity({ fetchedAt: AS_OF, lines: [] });
        const completed = await subject.service.getSnapshot(marketId, { venue: 'forecastex' });
        expect(completed.venues.forecastex.book.status).toBe('available');
        expect(subject.loadForecastExLive).toHaveBeenCalledTimes(1);
      } finally { finishReference(null); finishNative(null); finishActivity(null); }
    },
  );

  test('a new forced acquisition cannot publish the previous pending catalog or native book', async () => {
    const clock = jest.spyOn(Date, 'now').mockReturnValue(1000);
    let finishNative; let finishCatalog;
    const native = new Promise(resolve => { finishNative = resolve; });
    const catalog = new Promise(resolve => { finishCatalog = resolve; });
    const subject = createSubject({ refreshBudgetMs: 250, forecastLive: () => native });
    try {
      const old = await subject.service.getSnapshot('silver', { venue: 'forecastex' });
      expect(old.venues.forecastex.generationId).toBe('METLS_081926');
      clock.mockReturnValue(2000);
      subject.publicSources.getForecastExContracts.mockImplementationOnce(() => catalog);
      const fresh = await subject.service.getSnapshot('silver', {
        venue: 'forecastex', forceRefresh: true, refreshAfter: 2000,
      });
      expect(fresh.venues.forecastex.catalog).toMatchObject({ status: 'refreshing', event: null });
      expect(fresh.venues.forecastex.book.lines).toEqual([]);
      finishNative(null);
      await new Promise(resolve => setTimeout(resolve, 5));
      expect(subject.publicSources.getForecastExContracts).toHaveBeenCalledTimes(2);
      finishCatalog({ fetchedAt: AS_OF, lines: [] });
      const unavailable = await subject.service.getSnapshot('silver', {
        venue: 'forecastex', forceRefresh: true, refreshAfter: 2000,
      });
      expect(unavailable.venues.forecastex.catalog).toMatchObject({ status: 'unavailable', event: null });
      expect(unavailable.venues.forecastex.book.lines).toEqual([]);
    } finally { finishNative(null); finishCatalog(null); clock.mockRestore(); }
  });

  test('a failed native acquisition preserves only its verified catalog while references are pending', async () => {
    let finishReference;
    const reference = new Promise(resolve => { finishReference = resolve; });
    const subject = createSubject({
      refreshBudgetMs: 250, marketReference: () => reference,
      forecastLiveError: Object.assign(new Error('Broker disconnected'), { code: 'IBKR_DISCONNECTED' }),
    });
    try {
      const snapshot = await subject.service.getSnapshot('silver', { venue: 'forecastex' });
      expect(snapshot.venues.forecastex.catalog.status).toBe('available');
      expect(snapshot.venues.forecastex.book).toMatchObject({ status: 'unavailable', refreshFailed: true });
      expect(snapshot.venues.forecastex.book.lines.every(row => row.yesBid == null && row.noAsk == null)).toBe(true);
      expect(snapshot.executionContracts.lines.some(row => row.source === 'ibkr_tws_forecastex_live')).toBe(false);
    } finally { finishReference(null); }
  });

  test('forced acquisition rereads requested dependencies while preserving other catalogs and shared fresh reads', async () => {
    const clock = jest.spyOn(Date, 'now').mockReturnValue(1000);
    try {
      const subject = createSubject();
      await subject.service.getSnapshot('gold', { venue: 'kalshi' });
      await subject.service.getSnapshot('wti', { venue: 'kalshi' });
      await subject.service.getSnapshot('wti', { venue: 'kalshi' });
      expect(subject.loadRiskRanges).toHaveBeenCalledTimes(1);
      const catalogCount = series => subject.kalshiFetch.mock.calls.filter(([, query]) => query.series_ticker === series).length;
      expect(catalogCount('KXWTI')).toBe(1);
      expect(catalogCount('KXGOLDD')).toBe(1);
      clock.mockReturnValue(2000);
      await subject.service.getSnapshot('wti', { venue: 'kalshi', forceRefresh: true, refreshAfter: 2000 });
      expect(subject.loadRiskRanges).toHaveBeenCalledTimes(2);
      expect(catalogCount('KXWTI')).toBe(2);
      expect(catalogCount('KXGOLDD')).toBe(1);
      await subject.service.getSnapshot('gold', { venue: 'kalshi', forceRefresh: true, refreshAfter: 2000 });
      expect(subject.loadRiskRanges).toHaveBeenCalledTimes(2);
      expect(catalogCount('KXGOLDD')).toBe(2);
    } finally { clock.mockRestore(); }
  });

  test('forced acquisition waits for pre-boundary in-flight dependencies then rereads them', async () => {
    const clock = jest.spyOn(Date, 'now').mockReturnValue(1000);
    try {
      const subject = createSubject();
      let finishRisk; let finishReference;
      subject.loadRiskRanges.mockImplementationOnce(() => new Promise(resolve => { finishRisk = resolve; }));
      subject.loadMarketReference.mockImplementationOnce(() => new Promise(resolve => { finishReference = resolve; }));
      const earlier = subject.service.getSnapshot('gold', { venue: 'kalshi' });
      await new Promise(resolve => setTimeout(resolve, 5));
      expect(finishRisk).toEqual(expect.any(Function));
      expect(finishReference).toEqual(expect.any(Function));
      clock.mockReturnValue(2000);
      const fresh = subject.service.getSnapshot('gold', { venue: 'kalshi', forceRefresh: true, refreshAfter: 2000 });
      await new Promise(resolve => setTimeout(resolve, 5));
      finishRisk(null); finishReference(null);
      await Promise.all([earlier, fresh]);
      expect(subject.loadRiskRanges).toHaveBeenCalledTimes(2);
      expect(subject.loadMarketReference).toHaveBeenCalledTimes(2);
      expect(subject.loadMarketReference).toHaveBeenLastCalledWith(expect.objectContaining({ forceRefresh: true, refreshAfter: 2000 }));
    } finally { clock.mockRestore(); }
  });

  test('forced continuation cannot reuse an old value while its newer dependency is pending', async () => {
    const clock = jest.spyOn(Date, 'now').mockReturnValue(1000);
    try {
      const subject = createSubject();
      await subject.service.getSnapshot('wti', { venue: 'kalshi' });
      let finishRisk;
      subject.loadRiskRanges.mockImplementationOnce(() => new Promise(resolve => { finishRisk = resolve; }));
      clock.mockReturnValue(2000);
      const first = subject.service.getSnapshot('wti', { venue: 'kalshi', forceRefresh: true, refreshAfter: 2000 });
      await new Promise(resolve => setTimeout(resolve, 5));
      let completed = false;
      const continuation = subject.service.getSnapshot('wti', { venue: 'kalshi', forceRefresh: true, refreshAfter: 2000 }).then(value => { completed = true; return value; });
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(completed).toBe(false);
      finishRisk(null);
      await Promise.all([first, continuation]);
      expect(subject.loadRiskRanges).toHaveBeenCalledTimes(2);
    } finally { clock.mockRestore(); }
  });

  test.each([
    ['wti', 'KXWTI', 'COMCO'],
    ['nasdaq100', 'KXNASDAQ100U', 'FNQ'],
    ['silver', 'KXSILVERW', 'METLS'],
  ])('constructs a v2 %s snapshot from the current dynamic generations with sizing disabled', async (marketId, seriesTicker, productId) => {
    const subject = createSubject();
    const snapshot = await subject.service.getSnapshot(marketId);

    expect(snapshot).toMatchObject({
      schemaVersion: 2,
      marketId,
      strategy: { status: 'unavailable', eligibleVenueId: null },
      venues: {
        kalshi: {
          brokerRoutable: true,
          catalog: { status: 'available', seriesTicker },
          book: { status: 'available', seriesTicker },
        },
        forecastex: { catalog: { status: 'available', scheduleOnly: true }, book: { status: 'unavailable' } },
      },
      autoSelection: { status: 'available', venueId: 'kalshi', mode: 'most_executable' },
      displaySelection: { status: 'available', venueId: 'kalshi' },
      chart: {
        range: '1d',
        variants: {
          '1d': { range: '1d', points: [] },
          '5d': { range: '5d', points: [] },
          '10d': { range: '10d', points: [] },
        },
      },
    });
    expect(snapshot.venues.forecastex.catalog.lines).toHaveLength(1);
    expect(snapshot.venues.forecastex.catalog.lines[0]).toMatchObject({
      yesBid: null,
      yesAsk: null,
      directNative: false,
      source: 'forecastex_official_schedule',
    });
    Object.values(snapshot.venues).forEach((venueSnapshot) => {
      expect(venueSnapshot.settlementBasis).toMatchObject({
        status: expect.stringMatching(/^(verified|unavailable)$/),
      });
      expect(Object.keys(venueSnapshot.settlementBasis)).toEqual(expect.arrayContaining([
        'instrument', 'method', 'observationAt', 'sourceName', 'sourceUrl', 'rulesUrl', 'reason',
      ]));
    });
    expect(subject.publicSources.getForecastExContracts).toHaveBeenCalledWith(productId);
    expect(subject.publicSources.getForecastExContracts).toHaveBeenCalledTimes(1);
    expect(subject.kalshiFetch).toHaveBeenCalledWith('/events', expect.objectContaining({
      series_ticker: seriesTicker,
      status: 'open',
      with_nested_markets: true,
    }));
  });

  test('pins Gold to the daily Kalshi KXGOLDD generation even when ForecastEx is requested', async () => {
    const referenceFor = (value, label) => ({
      resolver: `${label} exact resolver`,
      fit: 'exact',
      instrument: { displaySymbol: label },
      spot: {
        status: 'available', availability: 'live', fit: 'exact', value, label,
        source: `verified_${label.toLowerCase()}_reference`, asOf: AS_OF, expiresAt: EXPIRES,
        executable: false,
      },
      chart: {
        status: 'available', availability: 'live', fit: 'exact', points: [],
        source: `verified_${label.toLowerCase()}_chart`, asOf: AS_OF, expiresAt: EXPIRES,
        executable: false,
      },
      goldMarketReferences: [
        {
          key: 'selectedResolver', label: `${label} DIRECT`, symbol: label, role: 'direct',
          status: 'live', price: value, previousClose: value - 10, changePercent: 0.2,
          unit: 'USD/ozt', source: `verified_${label.toLowerCase()}_reference`,
          instrument: { displaySymbol: label }, asOf: AS_OF, reason: null,
        },
        {
          key: 'xauusd', label: 'SPOT GOLD', symbol: 'XAUUSD', role: 'proxy',
          status: 'live', price: value + 1, previousClose: value - 9, changePercent: 0.2,
          unit: 'USD/ozt', source: 'ibkr', instrument: { displaySymbol: 'XAUUSD' },
          asOf: AS_OF, reason: null,
        },
        {
          key: 'activeComex', label: 'COMEX GOLD', symbol: 'GCZ26',
          role: label === 'GCZ26' ? 'direct' : 'proxy', status: 'live',
          price: value + 2, previousClose: value - 8, changePercent: 0.2,
          unit: 'USD/ozt', source: 'ibkr', instrument: { displaySymbol: 'GCZ26' },
          asOf: AS_OF, reason: null,
        },
      ],
    });
    const subject = createSubject({
      kalshiEventOverrides: (_config, ticker) => ({
        settlement_sources: [{
          name: 'Pyth - Gold',
          url: 'https://app.pyth.com/explore/Metal.Index.GOLD%2FUSD?cluster=pythnet',
        }],
        markets: [100, 110].map((threshold) => kalshiMarket(ticker, threshold, CLOSE, {
          rules_primary: `If the close price of the 1-minute candlestick for gold is above ${threshold}, the market resolves Yes.`,
          rules_secondary: 'The immediately preceding one-minute interval closes at the observation time.',
          custom_strike: { strike_date: CLOSE },
        })),
      }),
      marketReference: () => referenceFor(4_300, 'PYTH GOLD'),
    });

    const snapshot = await subject.service.getSnapshot('gold', { venue: 'forecastex' });

    expect(subject.loadMarketReference).toHaveBeenCalledTimes(1);
    expect(snapshot.venues.kalshi.reference).toMatchObject({
      resolver: 'PYTH GOLD exact resolver',
      spot: { value: 4_300, source: 'verified_pyth gold_reference' },
    });
    expect(snapshot.venues.forecastex).toBeUndefined();
    expect(snapshot.venues.kalshi.brokerRoutable).toBe(false);
    expect(subject.publicSources.getForecastExContracts).not.toHaveBeenCalled();
    expect(subject.kalshiFetch.mock.calls.map(([, query]) => query.series_ticker)).toEqual(['KXGOLDD']);
    expect(snapshot.selectedVenueId).toBe('kalshi');
    expect(snapshot.spot).toEqual(snapshot.venues.kalshi.reference.spot);
    expect(snapshot.chart).toEqual(snapshot.venues.kalshi.reference.chart);
    expect(snapshot.resolverReference).toEqual(snapshot.venues.kalshi.reference);
    expect(snapshot.goldMarketReferences).toEqual(snapshot.venues.kalshi.reference.goldMarketReferences);
    expect(snapshot.goldMarketReferences.map((reference) => reference.role)).toEqual([
      'direct', 'proxy', 'proxy',
    ]);
    expect(snapshot.venues.kalshi.catalog.seriesTicker).toBe('KXGOLDD');
  });

  test('does not cache a retained chart envelope while its display spot is still refreshing', async () => {
    let wallNow = NOW;
    const dateNow = jest.spyOn(Date, 'now').mockImplementation(() => wallNow);
    let referenceCall = 0;
    const chart = {
      status: 'available', availability: 'live', fit: 'proxy',
      source: 'coinbase_exchange_public_candles', asOf: AS_OF, expiresAt: EXPIRES,
      latestAt: AS_OF, latestValue: 118_500, executable: false,
      points: [{ timestamp: Date.parse(AS_OF) - 60_000, value: 118_400 }, { timestamp: Date.parse(AS_OF), value: 118_500 }],
    };
    const subject = createSubject({
      marketReference: () => {
        referenceCall += 1;
        if (referenceCall === 1) {
          return {
            backgroundRefresh: true,
            fit: 'proxy',
            resolver: 'CF Benchmarks BRTI final-minute average · Coinbase BTC-USD proxy shown',
            spot: {
              status: 'refreshing', availability: 'unavailable', fit: 'proxy',
              value: null, source: null, asOf: null, expiresAt: null,
              refreshing: true, executable: false,
            },
            chart: { ...chart, refreshPending: true, refreshRetained: true },
          };
        }
        return {
          fit: 'proxy',
          resolver: 'CF Benchmarks BRTI final-minute average · Coinbase BTC-USD proxy shown',
          spot: {
            status: 'available', availability: 'live', fit: 'proxy', value: 118_500,
            label: 'PROXY · COINBASE BTC-USD · NOT RESOLVER / NOT EXECUTABLE',
            source: 'coinbase_exchange_public_ticker', asOf: AS_OF, expiresAt: EXPIRES,
            executable: false,
          },
          chart,
        };
      },
    });

    try {
      const first = await subject.service.getSnapshot('bitcoin');
      expect(first.spot).toMatchObject({ status: 'refreshing', value: null });

      const second = await subject.service.getSnapshot('bitcoin');
      expect(subject.loadMarketReference).toHaveBeenCalledTimes(2);
      expect(second.spot).toMatchObject({
        status: 'available', availability: 'live', value: 118_500,
        source: 'coinbase_exchange_public_ticker', fit: 'proxy', executable: false,
      });

      await subject.service.getSnapshot('bitcoin');
      expect(subject.loadMarketReference).toHaveBeenCalledTimes(2);

      wallNow += 5_001;
      await subject.service.getSnapshot('bitcoin');
      expect(subject.loadMarketReference).toHaveBeenCalledTimes(3);
    } finally {
      dateNow.mockRestore();
    }
  });

  test.each([
    ['silver', [
      'DXY · LAST CLOSE',
      'SILVER/DXY 30D CORRELATION',
      'CFTC SILVER MANAGED MONEY · 1Y / 3Y Z',
      '21D ANNUALIZED SILVER REALIZED VOLATILITY',
      'TRADE / TREND GATE',
      'CONTRACT / RR GEOMETRY',
    ]],
    ['gold', [
      'DXY · LAST CLOSE',
      'GOLD/DXY 30D CORRELATION',
      'CFTC GOLD MANAGED MONEY · 1Y / 3Y Z',
      'GVZ',
      'TRADE / TREND GATE',
      'CONTRACT / RR GEOMETRY',
    ]],
    ['wti', [
      'DXY · LAST CLOSE',
      'WTI/DXY 30D CORRELATION',
      'CFTC CRUDE-OIL NON-COMMERCIAL · 1Y / 3Y Z',
      'OVX',
      'TRADE / TREND GATE',
      'CONTRACT / RR GEOMETRY',
    ]],
    ['brent', [
      'DXY · LAST CLOSE',
      'BRENT/DXY 30D CORRELATION',
      'BRENT–WTI FRONT-MONTH SPREAD',
      'OVX · WTI PROXY',
      'TRADE / TREND GATE',
      'CONTRACT / RR GEOMETRY',
    ]],
    ['ethereum', [
      'DXY · 1D / 15D / 30D',
      'ETH/DXY · 15D / 30D CORRELATION',
      'CFTC CME ETHEREUM · 1Y / 3Y Z',
      'ETH · 21D REALIZED VOL',
      'TRADE / TREND',
      'CONTRACT RISK RANGE',
    ]],
    ['bitcoin', [
      'DXY · 1D / 15D / 30D',
      'BTC/DXY · 15D / 30D CORRELATION',
      'CFTC CME BITCOIN · 1Y / 3Y Z',
      'BITVX · IBIT PROXY',
      'TRADE / TREND',
      'CONTRACT RISK RANGE',
    ]],
  ])('publishes the exact ordered %s context-only factor contract with DXY first', async (marketId, labels) => {
    const snapshot = await createSubject().service.getSnapshot(marketId);

    expect(snapshot.factorRows.map((row) => row.label)).toEqual(labels);
    expect(snapshot.factorRows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'gate', role: 'gate', fit: 'context_only', decisionEligible: false,
        displayState: 'WAIT', value: null,
      }),
      expect.objectContaining({
        id: 'geometry', role: 'context', decisionEligible: false,
      }),
    ]));
    snapshot.factorRows.forEach((row) => expect(row.decisionEligible).toBe(false));
  });

  function verifiedCryptoContext(overrides = {}) {
    return {
      sourceStatus: 'current', source: 'Yahoo Finance daily bars',
      timestamp: AS_OF, calculationDate: '2026-08-18',
      correlations: { BTC: { '15D': 0.26, '30D': -0.71 }, ETH: { '15D': -0.34, '30D': -0.65 } },
      assetContext: {
        dxy: {
          status: 'historical', availability: 'historical', decisionEligible: false,
          value: 99.65, previousClose: 99.4, changePercent: 0.25,
          fifteenDayChangePercent: -1.5, thirtyDayChangePercent: 2.5,
          asOf: '2026-08-18', source: 'Yahoo Finance completed DXY daily bars',
        },
        ethereumRealizedVolatility: {
          status: 'historical', availability: 'historical', decisionEligible: false,
          value: 0.6, annualized: true, annualizationFactor: 365, window: 21,
          asOf: '2026-08-18', source: 'Yahoo Finance completed ETH-USD daily bars',
        },
      },
      ...overrides,
    };
  }

  test.each([
    ['bitcoin', [0.26, -0.71], 'BITVX', '43.83% annualized', '≈ ±2.76% / session · implied'],
    ['ethereum', [-0.34, -0.65], 'ethereumRealizedVolatility', '60.00% annualized', '≈ ±3.14% / day · realized'],
  ])('publishes verified %s dollar horizons and interpreted volatility without assigning regime bands', async (marketId, correlations, volatilityId, displayValue, detail) => {
    const snapshot = await createSubject({
      usdSnapshot: verifiedCryptoContext(),
      volatilitySnapshot: { BITVX: {
        availability: 'available', freshness: 'current', lastPx: 43.83,
        asOf: AS_OF, source: 'CBOE',
      } },
    }).service.getSnapshot(marketId);
    const dxy = snapshot.factorRows.find((row) => row.id === 'dxy');
    expect(dxy).toMatchObject({
      status: 'historical', displayValue: '+0.25% / -1.50% / +2.50%',
      metrics: [
        { label: '1D', value: 0.25, format: 'percent' },
        { label: '15D', value: -1.5, format: 'percent' },
        { label: '30D', value: 2.5, format: 'percent' },
      ],
    });
    expect(snapshot.factorRows.find((row) => row.id === 'usd').metrics).toEqual([
      { label: '15D', value: correlations[0], format: 'correlation' },
      { label: '30D', value: correlations[1], format: 'correlation' },
    ]);
    expect(snapshot.factorRows.find((row) => row.id === volatilityId)).toMatchObject({
      status: 'historical', displayValue, detail, decisionEligible: false,
    });
    expect(snapshot.factorRows.find((row) => row.id === 'cftc')).toMatchObject({ status: 'unavailable', value: null });
  });

  test('keeps missing crypto horizons empty instead of substituting another timeframe', async () => {
    const context = verifiedCryptoContext();
    delete context.correlations.BTC['30D'];
    delete context.assetContext.dxy.fifteenDayChangePercent;
    const snapshot = await createSubject({ usdSnapshot: context }).service.getSnapshot('bitcoin');
    expect(snapshot.factorRows.find((row) => row.id === 'usd')).toMatchObject({
      status: 'available', metrics: [{ value: 0.26 }, { value: null }],
    });
    expect(snapshot.factorRows.find((row) => row.id === 'dxy').metrics[1].value).toBeNull();
  });

  test.each([
    ['offline', { sourceStatus: 'offline' }],
    ['stale', { timestamp: '2026-08-01T16:00:00.000Z', calculationDate: '2026-08-01' }],
    ['cache-only', { cachedOnly: true }],
    ['failed refresh', { refreshFailed: true }],
    ['seed', { provenance: 'seed' }],
    ['mock', { source: 'mock' }],
  ])('clears crypto dollar and realized-volatility context for %s evidence', async (_name, overrides) => {
    const snapshot = await createSubject({ usdSnapshot: verifiedCryptoContext(overrides) })
      .service.getSnapshot('ethereum');
    for (const id of ['dxy', 'usd', 'ethereumRealizedVolatility']) {
      const row = snapshot.factorRows.find((candidate) => candidate.id === id);
      expect(row.status).toBe('unavailable');
      expect(row.value).toBeNull();
      row.metrics?.forEach((metric) => expect(metric.value).toBeNull());
      expect(row.detail).toBeFalsy();
    }
  });

  test.each([
    { availability: 'offline' }, { freshness: 'stale' }, { cachedOnly: true },
    { refreshFailed: true }, { source: 'seed' }, { source: 'mock' },
  ])('clears BITVX and its daily approximation when evidence is blocked: %j', async (overrides) => {
    const snapshot = await createSubject({ volatilitySnapshot: { BITVX: {
      availability: 'available', freshness: 'current', lastPx: 43.83,
      asOf: AS_OF, source: 'CBOE', ...overrides,
    } } }).service.getSnapshot('bitcoin');
    expect(snapshot.factorRows.find((row) => row.id === 'BITVX')).toMatchObject({
      status: 'unavailable', value: null, displayValue: null, detail: null,
    });
  });

  test.each([
    ['brent', 'KXBRENTD', ['KXBRENTD', 'KXBRENTW']],
    ['bitcoin', 'KXBTCD', ['KXBTCD']],
    ['ethereum', 'KXETHD', ['KXETHD']],
  ])('constructs an IBKR-listed Kalshi-only %s snapshot without inventing a ForecastEx venue', async (marketId, seriesTicker, expectedFamilies) => {
    const subject = createSubject();
    const snapshot = await subject.service.getSnapshot(marketId);

    expect(snapshot).toMatchObject({
      schemaVersion: 2,
      marketId,
      venues: {
        kalshi: {
          brokerRoutable: true,
          catalog: { status: 'available', seriesTicker },
          book: { status: 'available', seriesTicker },
        },
      },
      autoSelection: { status: 'available', venueId: 'kalshi' },
    });
    expect(snapshot.venues.forecastex).toBeUndefined();
    expect(subject.publicSources.getForecastExContracts).not.toHaveBeenCalled();
    expect(subject.kalshiFetch.mock.calls.map(([, query]) => query.series_ticker)).toEqual(expectedFamilies);
  });

  test('binds the Brent card to the event-specific Pyth contract only when Kalshi rules verify it', async () => {
    const subject = createSubject();
    subject.kalshiFetch.mockImplementation(async (_path, query) => {
      const config = MARKET_CONFIGS.brent;
      const ticker = `${query.series_ticker}-26AUG19`;
      const contractSymbol = 'BRENTX6';
      return {
        events: [kalshiEvent(config, ticker, CLOSE, {
          series_ticker: query.series_ticker,
          title: 'Brent crude oil price on August 19, 2026 at 5:00 PM EDT?',
          settlement_sources: [{ name: 'Pyth', url: 'https://pythdata.app/explore' }],
          markets: [100, 110].map((threshold) => kalshiMarket(ticker, threshold, CLOSE, {
            rules_primary: `If the close price of the 1-minute Brent candlestick using ${contractSymbol} is above ${threshold}, the market resolves Yes.`,
            rules_secondary: 'The settlement candlestick is published by Pyth.',
            custom_strike: { front_month_contract: contractSymbol, strike_date: CLOSE },
          })),
        })],
      };
    });

    const snapshot = await subject.service.getSnapshot('brent');

    expect(snapshot.selectedGeneration).toMatchObject({
      seriesTicker: 'KXBRENTD',
      cadence: 'daily',
      resolverSymbol: 'Commodities.BRENTX6/USD',
      resolverContractMonth: 'BRENTX6',
    });
    expect(snapshot.generationOptions).toEqual(expect.arrayContaining([
      expect.objectContaining({ seriesTicker: 'KXBRENTD', cadence: 'daily' }),
      expect.objectContaining({ seriesTicker: 'KXBRENTW', cadence: 'weekly' }),
    ]));
    expect(snapshot.venues.kalshi).toMatchObject({
      resolver: {
        underlying: 'Commodities.BRENTX6/USD',
        pythSymbol: 'Commodities.BRENTX6/USD',
        contractSymbol: 'BRENTX6',
      },
      settlementBasis: {
        status: 'verified',
        instrument: 'Commodities.BRENTX6/USD',
        method: '1-minute close',
        observationAt: CLOSE,
        sourceName: 'Pyth',
      },
      catalog: {
        event: {
          cadence: 'daily',
          resolverSymbol: 'Commodities.BRENTX6/USD',
          resolverContractMonth: 'BRENTX6',
        },
      },
    });
    expect(snapshot.resolverMetadata.kalshi).toMatchObject({
      pythSymbol: 'Commodities.BRENTX6/USD',
      contractSymbol: 'BRENTX6',
    });
  });

  test('does not invent an exact Brent Pyth symbol when the event rules do not verify Pyth', async () => {
    const subject = createSubject();
    subject.kalshiFetch.mockImplementation(async (_path, query) => {
      const config = MARKET_CONFIGS.brent;
      const ticker = `${query.series_ticker}-26AUG19`;
      return {
        events: [kalshiEvent(config, ticker, CLOSE, {
          series_ticker: query.series_ticker,
          markets: [kalshiMarket(ticker, 100, CLOSE, {
            rules_primary: 'Settlement source is not specified in this fixture.',
            custom_strike: { front_month_contract: 'BRENTX6', strike_date: CLOSE },
          })],
        })],
      };
    });

    const snapshot = await subject.service.getSnapshot('brent');

    expect(snapshot.venues.kalshi.resolver).toEqual(MARKET_CONFIGS.brent.kalshiResolver);
    expect(snapshot.venues.kalshi.catalog.event).toMatchObject({
      resolverSymbol: null,
      resolverContractMonth: null,
    });
  });

  test('fails the standard WTI catalog closed when the daily family refresh fails', async () => {
    const subject = createSubject();
    subject.kalshiFetch.mockRejectedValueOnce(new Error('daily catalog offline'));
    const snapshot = await subject.service.getSnapshot('wti');

    expect(snapshot.venues.kalshi.catalog).toMatchObject({ status: 'unavailable' });
    expect(snapshot.errors).toContain('KXWTI: daily catalog offline');
  });

  test.each(['historical', 'unavailable'])('keeps the independent Brent basis %s without an open venue generation', async (status) => {
    const points = status === 'historical'
      ? [{ timestamp: NOW - 120_000, value: 90 }, { timestamp: NOW - 60_000, value: 91 }]
      : [];
    const variant = {
      status, availability: status, source: status === 'historical' ? 'ibkr_historical_bars' : null,
      asOf: AS_OF, fit: 'proxy', executable: false, points,
      reason: status === 'unavailable' ? 'IBKR history refresh failed.' : 'Verified completed history.',
    };
    const basis = {
      role: 'risk_range_basis', symbol: 'BRENT', riskRangeTicker: 'BRENT', exact: false,
      spot: { status, availability: status, value: status === 'historical' ? 91 : null, executable: false },
      chart: { ...variant, variants: Object.fromEntries(['1d', '5d', '10d'].map((range) => [range, { ...variant, range }])) },
    };
    const subject = createSubject({ marketReference: {
      chartReferences: {
        basis,
        // An unbound resolver must never leak into the contract role.
        contract: { ...basis, symbol: 'OLD-CONTRACT' },
      },
    } });
    subject.kalshiFetch.mockResolvedValue({ events: [] });

    const snapshot = await subject.service.getSnapshot('brent');

    expect(subject.loadMarketReference).toHaveBeenCalledWith(expect.objectContaining({ selected: null }));
    expect(snapshot.displaySelection.venueId).toBeNull();
    for (const range of ['1d', '5d', '10d']) {
      expect(snapshot.chart.variants[range]).toMatchObject({ status, points, executable: false });
    }
    expect(snapshot.chartReferences.basis.symbol).toBe('BRENT');
    expect(snapshot.chartReferences.contract.chart.points).toEqual([]);
    expect(snapshot.chartReferences.contract.spot.value).toBeNull();
    expect(snapshot.resolverReference.resolverIdentity.eventTicker).toBeNull();
    expect(snapshot.contracts.lines).toEqual([]);
    expect(snapshot.executionContracts.lines).toEqual([]);
    expect(snapshot.strategy.status).toBe('unavailable');
  });

  test('publishes only the injected exact resolver reference and its direct chart', async () => {
    const subject = createSubject({
      marketReference: {
        resolver: 'cash Nasdaq-100 index',
        spot: { status: 'available', value: 27_850, source: 'ibkr_live_native_quote', asOf: AS_OF, expiresAt: EXPIRES },
        chart: {
          status: 'available', source: 'ibkr_historical_bars', asOf: AS_OF, expiresAt: EXPIRES,
          points: [{ timestamp: NOW - 60_000, value: 27_840 }, { timestamp: NOW, value: 27_850 }],
        },
      },
    });
    const snapshot = await subject.service.getSnapshot('nasdaq100');
    expect(snapshot.resolverMetadata.reference).toBe('cash Nasdaq-100 index');
    expect(snapshot.spot).toMatchObject({ status: 'available', value: 27_850, source: 'ibkr_live_native_quote' });
    expect(snapshot.chart).toMatchObject({ status: 'available', source: 'ibkr_historical_bars' });
    expect(snapshot.chart.points).toEqual(snapshot.chart.variants['1d'].points);
    expect(snapshot.chart.variants).toMatchObject({
      '5d': { status: 'unavailable', points: [] },
      '10d': { status: 'unavailable', points: [] },
    });
  });

  test('reuses a completed live reference only until its provider-stamped expiry', async () => {
    let wallNow = Date.now();
    const dateNow = jest.spyOn(Date, 'now').mockImplementation(() => wallNow);
    const liveExpiry = new Date(wallNow + 1_000).toISOString();
    const subject = createSubject({
      marketReference: {
        resolver: 'Pyth Metal.Index.GOLD/USD',
        spot: {
          status: 'available', availability: 'live', value: 4_350,
          source: 'pyth_pro_metal_index_gold_usd', asOf: new Date(wallNow).toISOString(),
          expiresAt: liveExpiry, fit: 'exact', executable: false,
        },
        chart: {
          status: 'available', availability: 'live', points: [],
          source: 'pyth_pro_history_metal_index_gold_usd', asOf: new Date(wallNow).toISOString(),
          expiresAt: liveExpiry, fit: 'exact', executable: false,
        },
      },
    });

    await subject.service.getSnapshot('gold');
    wallNow += 1_001;
    await subject.service.getSnapshot('gold');

    expect(subject.loadMarketReference).toHaveBeenCalledTimes(2);
    dateNow.mockRestore();
  });

  test.each([
    ['wti', 'WTIC', 'WTIC'],
    ['nasdaq100', 'COMPQ', 'COMPQ'],
    ['gold', 'GLD', 'GLD'],
    ['silver', 'SILVER', 'SILVER'],
    ['brent', 'BRENT', 'BRENT'],
    ['bitcoin', 'BITCOIN', 'BITCOIN'],
  ])('distributes independently published Trade to the exact %s research instrument', async (marketId, rangeTicker, tradeTicker) => {
    const subject = createSubject({
      riskRanges: {
        available: true,
        status: 'current',
        manifest: {
          publicationDate: '2026-08-19',
          expectedDate: '2026-08-19',
          latestUpdatedAt: AS_OF,
        },
        ranges: {
          [rangeTicker]: {
            lrr: 90,
            hrr: 110,
            previousClose: 101,
            trend: 'BULLISH',
            timestamp: AS_OF,
            source: 'hedgeye_risk_ranges',
          },
        },
      },
      tradeSnapshots: publishedTradePayload(tradeTicker),
    });

    const snapshot = await subject.service.getSnapshot(marketId);

    expect(snapshot.riskRange).toMatchObject({
      status: 'available', ticker: rangeTicker, date: '2026-08-19', previousClose: 101,
    });
    expect(snapshot.factors.trade).toMatchObject({
      status: 'available', direction: 'BULLISH', ticker: tradeTicker,
      date: '2026-08-19', source: 'early-look',
    });
    expect(snapshot.publishedResearch).toMatchObject({
      riskRange: {
        status: 'available', ticker: rangeTicker, trend: 'BULLISH', date: '2026-08-19',
        source: 'hedgeye_risk_ranges', decisionEligible: false, executable: false,
      },
      trade: {
        status: 'available', direction: 'BULLISH', ticker: tradeTicker,
        date: '2026-08-19', source: 'early-look', decisionEligible: false, executable: false,
      },
    });
    expect(snapshot.factorRows).toContainEqual(expect.objectContaining(
      marketId === 'nasdaq100'
        ? { id: 'trade', status: 'available', value: 'BULLISH' }
        : {
            id: 'gate', status: 'available', role: 'gate',
            displayValue: 'BULLISH / BULLISH', displayState: 'CONTEXT ALIGNED',
            decisionEligible: false,
          },
    ));
    expect(subject.loadTradeSnapshots).toHaveBeenCalledWith({ now: new Date(NOW) });
  });

  test('retains a dated explicit Bitcoin Trade for the report when a newer publication omits it', async () => {
    const subject = createSubject({
      tradeSnapshots: publishedTradePayload('BITCOIN', {
        sourceDate: '2026-07-08', publishedAt: '2026-07-08T11:30:00Z', sourceId: 'the-call',
      }, true),
    });
    const snapshot = await subject.service.getSnapshot('bitcoin');
    expect(snapshot.publishedResearch.trade).toMatchObject({
      status: 'available', direction: 'BULLISH', date: '2026-07-08', source: 'the-call',
      asOf: '2026-07-08T11:30:00Z', sourceUrl: 'https://app.hedgeye.com/feed_items/123',
      retainedPublication: true, decisionEligible: false, executable: false,
    });
    expect(snapshot.factors.trade).toMatchObject({ status: 'unavailable', direction: null });
    expect(snapshot.scoreInputs.trade.direction).toBeNull();
  });

  test('does not reuse a USO directional Trade as WTIC research', async () => {
    const subject = createSubject({ tradeSnapshots: publishedTradePayload('USO') });
    const snapshot = await subject.service.getSnapshot('wti');
    expect(snapshot.publishedResearch.trade).toMatchObject({ status: 'unavailable', direction: null, ticker: 'WTIC' });
  });

  test('loads Ethereum RR from the exact tracker publication even when the primary Risk Range release is unavailable', async () => {
    const subject = createSubject({
      riskRanges: null,
      cryptoTrackerSnapshots: [{
        snapshotType: 'bitcoin-trend-tracker', date: '2026-08-19',
        scrapedAt: AS_OF, source: 'gmail-html', sourceMessageId: 'published-eth-report',
        data: { cryptos: { ETH: { lrr: 2400, hrr: 2600, price: 2500, trend: 'BULLISH' } } },
      }],
    });
    const snapshot = await subject.service.getSnapshot('ethereum');
    expect(snapshot.riskRange).toMatchObject({
      status: 'available', ticker: 'ETH', date: '2026-08-19',
      lrr: 2400, hrr: 2600, previousClose: null, asOf: AS_OF,
      source: 'hedgeye_bitcoin_trend_tracker', sourceProvider: 'gmail-html',
      sourceMessageId: 'published-eth-report',
    });
    expect(subject.loadCryptoTracker).toHaveBeenCalledWith({ dates: ['2026-08-19'], limit: 2 });
    expect(subject.loadRiskRanges).not.toHaveBeenCalled();
  });

  test('requests both publication dates before the deadline and accepts Ethereum tracker already published today', async () => {
    const early = new Date('2026-08-19T11:30:00.000Z');
    const subject = createSubject({
      now: () => early,
      cryptoTrackerSnapshots: [{
        snapshotType: 'bitcoin-trend-tracker', date: '2026-08-19',
        scrapedAt: '2026-08-19T11:19:00.000Z', source: 'gmail-html',
        data: { cryptos: { ETH: { lrr: 2400, hrr: 2600, trend: 'BULLISH' } } },
      }],
    });
    const snapshot = await subject.service.getSnapshot('ethereum');
    expect(subject.loadCryptoTracker).toHaveBeenCalledWith({ dates: ['2026-08-19', '2026-08-18'], limit: 2 });
    expect(snapshot.riskRange).toMatchObject({ status: 'available', date: '2026-08-19', asOf: '2026-08-19T11:19:00.000Z' });
  });

  test('does not compare a same-date directional close with the prior-session Risk Range basis', async () => {
    const dailyRange = {
      date: '2026-08-19', status: 'available',
      references: [
        { status: 'available', label: 'LRR', value: 90, source: 'RiskRangeData', asOf: '2026-08-19' },
        { status: 'available', label: 'HRR', value: 110, source: 'RiskRangeData', asOf: '2026-08-19' },
      ],
    };
    const variant = (range) => ({
      status: 'available', availability: 'live', range, source: 'ibkr_historical_bars',
      asOf: AS_OF, expiresAt: EXPIRES, points: [], dailyRanges: [dailyRange],
      riskRangeStatus: 'available', riskRangeMissingDates: [], fit: 'proxy', executable: false,
    });
    const oneDay = variant('1d');
    const subject = createSubject({
      riskRanges: {
        available: true, status: 'current',
        manifest: { publicationDate: '2026-08-19', expectedDate: '2026-08-19', latestUpdatedAt: AS_OF },
        ranges: {
          WTIC: {
            lrr: 90, hrr: 110, previousClose: 101, trend: 'BULLISH',
            timestamp: AS_OF, source: 'hedgeye_risk_ranges',
          },
        },
      },
      marketReference: {
        resolver: 'NYMEX CL basis', fit: 'proxy',
        directionalFeed: { marketId: 'wti', provider: 'ibkr', conId: 1002 },
        spot: {
          status: 'available', availability: 'live', value: 120, previousClose: 120,
          previousCloseAsOf: '2026-08-19T18:00:00.000Z', source: 'ibkr_historical_bars',
          asOf: AS_OF, expiresAt: EXPIRES, fit: 'proxy', executable: false,
        },
        chart: { ...oneDay, variants: { '1d': oneDay, '5d': variant('5d'), '10d': variant('10d') } },
      },
    });

    const snapshot = await subject.service.getSnapshot('wti');

    expect(snapshot.basisValidation).toBeNull();
    expect(snapshot.riskRange).toMatchObject({ status: 'available', date: '2026-08-19' });
    expect(snapshot.chart.variants['5d'].dailyRanges[0]).toMatchObject({
      date: '2026-08-19', status: 'available',
    });
  });

  test('limits a genuine basis mismatch to the matching Risk Range publication date', async () => {
    const dailyRange = (date) => ({
      date, status: 'available',
      references: [
        { status: 'available', label: 'LRR', value: 90, source: 'RiskRangeData', asOf: date },
        { status: 'available', label: 'HRR', value: 110, source: 'RiskRangeData', asOf: date },
      ],
    });
    const variant = (range) => ({
      status: 'available', availability: 'live', range, source: 'ibkr_historical_bars',
      asOf: AS_OF, expiresAt: EXPIRES, points: [],
      dailyRanges: [dailyRange('2026-08-18'), dailyRange('2026-08-19')],
      riskRangeStatus: 'available', riskRangeMissingDates: [], fit: 'proxy', executable: false,
    });
    const oneDay = variant('1d');
    const subject = createSubject({
      riskRanges: {
        available: true, status: 'current',
        manifest: { publicationDate: '2026-08-19', expectedDate: '2026-08-19', latestUpdatedAt: AS_OF },
        ranges: {
          WTIC: {
            lrr: 90, hrr: 110, previousClose: 101, trend: 'BULLISH',
            timestamp: AS_OF, source: 'hedgeye_risk_ranges',
          },
        },
      },
      marketReference: {
        resolver: 'NYMEX CL basis', fit: 'proxy',
        directionalFeed: { marketId: 'wti', provider: 'ibkr', conId: 1002 },
        spot: {
          status: 'available', availability: 'live', value: 120, previousClose: 120,
          previousCloseAsOf: '2026-08-18T18:00:00.000Z', source: 'ibkr_historical_bars',
          asOf: AS_OF, expiresAt: EXPIRES, fit: 'proxy', executable: false,
        },
        chart: { ...oneDay, variants: { '1d': oneDay, '5d': variant('5d'), '10d': variant('10d') } },
      },
    });

    const snapshot = await subject.service.getSnapshot('wti');
    const ranges = snapshot.chart.variants['5d'].dailyRanges;

    expect(snapshot.riskRange).toMatchObject({ status: 'unavailable', hiddenByBasisGate: true });
    expect(snapshot.publishedResearch.riskRange).toMatchObject({
      status: 'available', lrr: 90, hrr: 110, trend: 'BULLISH',
      date: '2026-08-19', ticker: 'WTIC', source: 'hedgeye_risk_ranges',
      fit: 'calibration', contextOnly: true, decisionEligible: false, executable: false,
    });
    expect(snapshot.publishedResearch.trade).toMatchObject({ status: 'unavailable', direction: null });
    expect(ranges.find((range) => range.date === '2026-08-18')).toMatchObject({ status: 'available' });
    expect(ranges.find((range) => range.date === '2026-08-19')).toMatchObject({
      status: 'unavailable', references: [], fit: 'mismatched',
    });
    expect(snapshot.chart.variants['5d']).toMatchObject({ riskRangeStatus: 'partial' });
  });

  test('keeps the independently published Silver Trend when broker quotes are disconnected', async () => {
    const subject = createSubject({
      forecastLiveError: new Error('IBKR disconnected'),
      orderbookError: new Error('Venue book offline'),
      riskRanges: {
        available: true, status: 'current',
        manifest: { publicationDate: '2026-08-19', expectedDate: '2026-08-19', latestUpdatedAt: AS_OF },
        ranges: { SILVER: { lrr: 63, hrr: 69, trend: 'NEUTRAL', timestamp: AS_OF, source: 'hedgeye-risk-ranges-email' } },
      },
    });
    const snapshot = await subject.service.getSnapshot('silver');
    expect(snapshot.publishedResearch.riskRange).toMatchObject({
      status: 'available', ticker: 'SILVER', trend: 'NEUTRAL', date: '2026-08-19',
      source: 'hedgeye-risk-ranges-email', contextOnly: true, decisionEligible: false, executable: false,
    });
    expect(snapshot.publishedResearch.trade).toMatchObject({ status: 'unavailable', direction: null });
    expect(snapshot.executionContracts.lines).toHaveLength(0);
  });

  test('preserves Gold Spot Price as the published range identity without changing its basis gate', async () => {
    const subject = createSubject({
      riskRanges: {
        available: true, status: 'current',
        manifest: { publicationDate: '2026-08-19', expectedDate: '2026-08-19', latestUpdatedAt: AS_OF },
        ranges: { GLD: {
          originalName: 'Gold Spot Price', lrr: 4250, hrr: 4424, previousClose: 4421,
          trend: 'NEUTRAL', timestamp: AS_OF, source: 'hedgeye-risk-ranges-email',
        } },
      },
    });
    const snapshot = await subject.service.getSnapshot('gold');
    expect(snapshot.publishedResearch.riskRange).toMatchObject({
      ticker: 'GLD', originalName: 'Gold Spot Price', instrumentLabel: 'Gold Spot Price',
      trend: 'NEUTRAL', lrr: 4250, hrr: 4424, fit: 'strong_proxy',
      contextOnly: true, decisionEligible: false, executable: false,
    });
    expect(snapshot.riskRange.fit).toBe('strong_proxy');
    expect(snapshot.strategy.status).toBe('unavailable');
  });

  test.each([
    ['stale', { stale: true }], ['cache only', { cacheOnly: true }],
    ['seeded', { seeded: true }], ['mock', { mock: true }],
    ['disconnected', { connected: false }], ['offline source', { sourceStatus: 'offline' }],
    ['failed refresh', { refreshFailed: true }],
  ])('does not elevate %s research into published review evidence', async (_label, unsafe) => {
    for (const location of ['envelope', 'range']) {
      const subject = createSubject({
        riskRanges: {
          available: true, status: 'current', ...(location === 'envelope' ? unsafe : {}),
          manifest: { publicationDate: '2026-08-19', expectedDate: '2026-08-19', latestUpdatedAt: AS_OF },
          ranges: { SILVER: {
            lrr: 63, hrr: 69, trend: 'NEUTRAL', timestamp: AS_OF, source: 'hedgeye-risk-ranges-email',
            ...(location === 'range' ? unsafe : {}),
          } },
        },
      });
      const snapshot = await subject.service.getSnapshot('silver');
      expect(snapshot.publishedResearch.riskRange).toMatchObject({
        status: 'unavailable', lrr: null, hrr: null, trend: null,
      });
    }
  });

  test.each([
    ['2026-08-16', '2026-08-14', ['2026-08-15', '2026-08-16']],
    ['2026-09-07', '2026-09-04', ['2026-09-05', '2026-09-06', '2026-09-07']],
    ['2026-07-05', '2026-07-02', ['2026-07-03', '2026-07-04', '2026-07-05']],
  ])('carries the exact Bitcoin publication for non-publication chart sessions on %s', async (currentDate, publicationDate, dates) => {
    const weekendNow = Date.parse(`${currentDate}T16:00:00.000Z`);
    const weekendAsOf = new Date(weekendNow).toISOString();
    const weekendExpiry = new Date(weekendNow + 60_000).toISOString();
    const unavailableRanges = dates.map((date) => ({
      date,
      status: 'unavailable',
      references: [],
      reason: `Exact-date Risk Range data is unavailable for ${date}.`,
    }));
    const chartVariant = (range, dailyRanges) => ({
      status: 'available', availability: 'live', range,
      source: 'coinbase_exchange_public_candles', asOf: weekendAsOf, expiresAt: weekendExpiry,
      points: [
        { timestamp: weekendNow - 60_000, value: 118_400 },
        { timestamp: weekendNow, value: 118_500 },
      ],
      rangeDates: dailyRanges.map((entry) => entry.date),
      dailyRanges,
      riskRangeStatus: 'partial',
      riskRangeMissingDates: dailyRanges.map((entry) => entry.date),
      riskRangeRefreshPending: true,
      carryRiskRangeAcrossNonPublicationSessions: true,
      executable: false,
    });
    const oneDay = chartVariant('1d', unavailableRanges.slice(-1));
    const fiveDay = chartVariant('5d', unavailableRanges);
    const tenDay = chartVariant('10d', unavailableRanges);
    const subject = createSubject({
      now: () => new Date(weekendNow),
      kalshiEventOverrides: (config, ticker) => kalshiEvent(config, ticker, new Date(weekendNow + 3_600_000).toISOString()),
      riskRanges: {
        available: true,
        status: 'current',
        manifest: {
          publicationDate,
          expectedDate: publicationDate,
          latestUpdatedAt: `${publicationDate}T11:00:00.000Z`,
        },
        ranges: {
          BITCOIN: {
            lrr: 110_000,
            hrr: 125_000,
            previousClose: 118_000,
            trend: 'BULLISH',
            timestamp: `${publicationDate}T11:00:00.000Z`,
            source: 'hedgeye-risk-ranges-email',
          },
        },
      },
      marketReference: {
        status: 'available',
        resolver: 'CF Benchmarks BRTI final-minute average · Coinbase BTC-USD proxy shown',
        spot: {
          status: 'available', availability: 'live', fit: 'proxy', value: 118_500,
          label: 'PROXY · COINBASE BTC-USD · NOT RESOLVER / NOT EXECUTABLE',
          source: 'coinbase_exchange_public_ticker', asOf: weekendAsOf,
          expiresAt: weekendExpiry, executable: false,
        },
        chart: { ...oneDay, variants: { '1d': oneDay, '5d': fiveDay, '10d': tenDay } },
      },
    });

    const snapshot = await subject.service.getSnapshot('bitcoin');

    expect(snapshot.riskRange).toMatchObject({ status: 'available', date: publicationDate });
    expect(snapshot.chart.variants['1d']).toMatchObject({
      riskRangeStatus: 'available', riskRangeMissingDates: [], riskRangeRefreshPending: false,
    });
    expect(snapshot.chart.variants['5d'].dailyRanges).toEqual(expect.arrayContaining(dates.map((date) => (
      expect.objectContaining({
        date,
        status: 'available',
        riskRangePublicationDate: publicationDate,
        riskRangeCarryForward: 'last_published_non_publication_session',
        references: expect.arrayContaining([
          expect.objectContaining({ label: 'LRR', asOf: `${publicationDate}T11:00:00.000Z`, carriedForward: true }),
          expect.objectContaining({ label: 'HRR', asOf: `${publicationDate}T11:00:00.000Z`, carriedForward: true }),
        ]),
      })
    ))));
  });

  test.each(['bitcoin', 'ethereum'].flatMap((marketId) => [
    [marketId, '2026-09-07', '2026-09-04', 'exact', true],
    [marketId, '2026-09-07', '2026-09-03', 'exact', false],
    [marketId, '2026-09-05', '2026-09-03', 'exact', false],
    [marketId, '2026-09-07', '2026-09-04', 'carried', true],
    [marketId, '2026-09-07', '2026-09-03', 'carried', false],
    [marketId, '2026-09-08', '2026-09-04', 'exact', false],
    [marketId, '2026-09-07', '2026-09-04', 'priorCarry', true],
  ]))('requires the exact %s publication for %s from %s (%s)', async (marketId, sessionDate, publicationDate, mode, expectedAvailable) => {
    const nowMs = Date.parse('2026-09-14T16:00:00.000Z');
    const sourceTime = `${publicationDate}T11:42:54.000Z`;
    const usesCarry = mode !== 'exact';
    const sourceDate = mode === 'priorCarry' ? '2026-09-05' : (usesCarry ? sessionDate : publicationDate);
    const sourceRange = {
      date: sourceDate, status: 'available',
      ...(usesCarry ? {
        riskRangePublicationDate: publicationDate,
        riskRangeCarryForward: 'last_published_non_publication_session',
      } : {}),
      references: [
        { label: 'LRR', value: 2362 },
        { label: 'HRR', value: 2567 },
      ].map((reference) => ({
        ...reference, status: 'available', source: 'hedgeye-risk-ranges-email', asOf: sourceTime,
        ...(usesCarry ? { publicationDate, effectiveDate: sourceDate, carriedForward: true } : {}),
      })),
    };
    const dailyRanges = mode === 'carried' ? [sourceRange] : [sourceRange, {
      date: sessionDate, status: 'unavailable', references: [],
    }];
    const variant = (range) => ({
      range, status: 'available', availability: 'live', source: 'coinbase_exchange_public_candles',
      asOf: new Date(nowMs).toISOString(), expiresAt: new Date(nowMs + 60_000).toISOString(),
      points: [{ timestamp: nowMs - 60_000, value: 2500 }, { timestamp: nowMs, value: 2510 }],
      rangeDates: dailyRanges.map((row) => row.date), dailyRanges,
      carryRiskRangeAcrossNonPublicationSessions: true,
      riskRangeStatus: 'partial', riskRangeMissingDates: [sessionDate], executable: false,
    });
    const oneDay = variant('1d');
    const subject = createSubject({
      now: () => new Date(nowMs),
      kalshiEventOverrides: (config, ticker) => kalshiEvent(config, ticker, new Date(nowMs + 3_600_000).toISOString()),
      marketReference: {
        status: 'available',
        spot: {
          status: 'available', availability: 'live', fit: 'proxy', value: 2510,
          source: 'coinbase_exchange_public_ticker', asOf: oneDay.asOf,
          expiresAt: oneDay.expiresAt, executable: false,
        },
        chart: { ...oneDay, variants: { '1d': oneDay, '5d': variant('5d'), '10d': variant('10d') } },
      },
    });

    const snapshot = await subject.service.getSnapshot(marketId);
    const chart = snapshot.chart.variants['10d'];
    const actual = chart.dailyRanges.find((row) => row.date === sessionDate);

    const expectedRange = expectedAvailable ? {
      status: 'available', riskRangePublicationDate: publicationDate,
      riskRangeCarryForward: 'last_published_non_publication_session',
      references: [
        { label: 'LRR', value: 2362, asOf: sourceTime, carriedForward: true },
        { label: 'HRR', value: 2567, asOf: sourceTime, carriedForward: true },
      ],
    } : { status: 'unavailable', references: [] };
    expect(actual).toMatchObject(expectedRange);
    expect(chart.riskRangeMissingDates.includes(sessionDate)).toBe(!expectedAvailable);
  });

  test.each([
    ['Trend-as-Trade fallback', { stocks: { USO: { ticker: 'USO', trend: 'BULLISH' } } }, '2026-08-19'],
    ['related ticker', { stocks: { OIL: { ticker: 'OIL', trade: 'BULLISH' } } }, '2026-08-19'],
    ['prior-session Trade', { stocks: { USO: { ticker: 'USO', trade: 'BULLISH' } } }, '2026-08-18'],
  ])('rejects %s for WTI', async (_label, data, date) => {
    const subject = createSubject({
      riskRanges: {
        available: true,
        status: 'current',
        manifest: {
          publicationDate: '2026-08-19', expectedDate: '2026-08-19', latestUpdatedAt: AS_OF,
        },
        ranges: { WTIC: { lrr: 90, hrr: 110, trend: 'BULLISH', timestamp: AS_OF } },
      },
      tradeSnapshots: [{ snapshotType: 'momo-tracker', date, scrapedAt: AS_OF, data }],
    });

    const snapshot = await subject.service.getSnapshot('wti');
    expect(snapshot.factors.trade).toMatchObject({
      status: 'unavailable', direction: null, ticker: 'WTIC',
    });
  });

  test('marks a rejected MOMO refresh so Trade cannot be retained as current', async () => {
    const subject = createSubject({ tradeError: new Error('MOMO refresh failed') });
    const snapshot = await subject.service.getSnapshot('wti');
    expect(snapshot.factors.trade).toMatchObject({
      status: 'unavailable', refreshFailed: true, direction: null,
    });
  });

  test('localizes venue refresh failures so only a still-fresh same-market selection may be retained', async () => {
    const subject = createSubject();
    subject.kalshiFetch.mockRejectedValue(new Error('Kalshi network failed'));
    subject.publicSources.getForecastExContracts.mockRejectedValueOnce(new Error('ForecastEx network failed'));
    const snapshot = await subject.service.getSnapshot('wti');
    expect(snapshot.venues.kalshi.catalog).toMatchObject({ status: 'unavailable', refreshFailed: true });
    expect(snapshot.venues.forecastex.catalog).toMatchObject({ status: 'unavailable', refreshFailed: true });
    expect(snapshot.autoSelection).toMatchObject({
      status: 'unavailable',
      refreshFailedVenueIds: expect.arrayContaining(['kalshi', 'forecastex']),
      contracts: { refreshFailed: true },
    });
  });

  test('clears every native book price and size when venue book refreshes fail', async () => {
    const subject = createSubject({
      orderbookError: Object.assign(new Error('Kalshi orderbook timed out'), { code: 'KALSHI_BOOK_TIMEOUT' }),
      forecastLiveError: Object.assign(new Error('Prediction Markets permission missing'), {
        sidecarCode: 'FORECASTEX_ENTITLEMENT_REQUIRED',
      }),
    });

    const snapshot = await subject.service.getSnapshot('wti');
    for (const venueId of ['kalshi', 'forecastex']) {
      expect(snapshot.venues[venueId].book).toMatchObject({
        status: 'unavailable', refreshFailed: true, asOf: null, expiresAt: null,
      });
      snapshot.venues[venueId].book.lines.forEach((bookLine) => {
        expect(bookLine).toMatchObject({
          yesBid: null, yesAsk: null, yesBidSize: null, yesAskSize: null,
          noBid: null, noAsk: null, noBidSize: null, noAskSize: null,
          directNative: false,
        });
      });
    }
    expect(snapshot.venues.forecastex.book.errorCode).toBe('FORECASTEX_ENTITLEMENT_REQUIRED');
    expect(snapshot.sourceHealth).toContainEqual(expect.objectContaining({
      id: 'kalshi_book', status: 'refresh_failed', errorCode: 'KALSHI_BOOK_TIMEOUT',
    }));
    expect(snapshot.sourceHealth).toContainEqual(expect.objectContaining({
      id: 'forecastex_book', status: 'entitlement_required', errorCode: 'FORECASTEX_ENTITLEMENT_REQUIRED',
    }));
    expect(snapshot.executionContracts.lines).toHaveLength(0);
  });

  test('builds SP500 exclusively from the current ForecastEx FES generation without loading Kalshi', async () => {
    const subject = createSubject({
      spxSnapshot: {
        schemaVersion: 1,
        status: 'partial',
        generatedAt: AS_OF,
        contracts: {
          status: 'available',
          source: 'kalshi_trade_api_v2',
          asOf: AS_OF,
          expiresAt: EXPIRES,
          seriesTicker: 'WRONG',
          event: { ticker: 'WRONG-26AUG19H1600', closeTime: CLOSE },
          lines: [line({ source: 'kalshi_trade_api_v2' })],
        },
      },
    });
    const snapshot = await subject.service.getSnapshot('sp500');

    expect(Object.keys(snapshot.venues)).toEqual(['forecastex']);
    expect(snapshot.venues.forecastex.catalog).toMatchObject({
      status: 'available', seriesTicker: 'FES', event: { productCode: 'FES', payoutAmount: 1 },
    });
    expect(snapshot.selection).toMatchObject({
      requestedVenue: 'forecastex', requestedGenerationId: null, venueId: 'forecastex',
    });
    expect(snapshot.generationOptions).toEqual([]);
    expect(snapshot.strategy.status).toBe('unavailable');
    expect(snapshot.strategy.eligibleVenueId).toBeNull();
    expect(subject.spxMonitorService.getSnapshot).toHaveBeenCalledWith({ includeContracts: false });
    expect(subject.kalshiFetch).not.toHaveBeenCalled();
    expect(subject.loadKalshiOrderbooks).not.toHaveBeenCalled();
  });

  test('loads the exact FES spot while the primary SPX ten-session history is still refreshing', async () => {
    const subject = createSubject({
      spxSnapshot: {
        schemaVersion: 1,
        status: 'partial',
        generatedAt: AS_OF,
        sourceRefreshPending: true,
        chart: {
          status: 'historical',
          variants: {
            '10d': { status: 'refreshing', refreshing: true, points: [] },
          },
        },
        contracts: { status: 'unavailable', event: null, lines: [] },
      },
      marketReference: {
        status: 'partial',
        resolver: 'ESU26',
        instrument: { symbol: 'ES', displaySymbol: 'ESU26' },
        spot: {
          status: 'available', availability: 'live', fit: 'exact', value: 6420,
          label: 'ESU26', source: 'ibkr_live_native_quote', asOf: AS_OF,
          expiresAt: EXPIRES, executable: false,
        },
        chart: {
          status: 'refreshing', availability: 'unavailable', fit: 'exact',
          points: [], source: null, asOf: null, expiresAt: null, executable: false,
        },
      },
    });

    const snapshot = await subject.service.getSnapshot('sp500');

    expect(subject.loadMarketReference).toHaveBeenCalledTimes(1);
    expect(snapshot.sourceRefreshPending).toBe(true);
    expect(snapshot.resolverReference).toMatchObject({
      status: 'partial',
      spot: { status: 'available', value: 6420, fit: 'exact', executable: false },
    });
  });

  test('publishes a direct fresh IBKR ForecastEx FES book without changing its provenance', async () => {
    const subject = createSubject({
      forecastLive: {
        status: 'available',
        fetchedAt: AS_OF,
        brokerRoutable: true,
        lines: [{
          contractId: 'FES_081926_100',
          directNative: true,
          dataType: 'live',
          provenance: 'ibkr_tws_forecastex_live',
          updatedAt: AS_OF,
          yesBid: 0.40,
          yesAsk: 0.42,
          noBid: 0.58,
          noAsk: 0.60,
          yesBidSize: 10,
          yesAskSize: 12,
          noBidSize: 14,
          noAskSize: 16,
        }],
      },
    });

    const snapshot = await subject.service.getSnapshot('sp500');

    expect(snapshot.venues.forecastex.book).toMatchObject({
      status: 'available', source: 'ibkr_tws_forecastex_live', scheduleOnly: false,
    });
    expect(snapshot.venues.forecastex.book.lines).toEqual([
      expect.objectContaining({
        ticker: 'FES_081926_100', source: 'ibkr_tws_forecastex_live',
        directNative: true, yesBid: 0.40, yesAsk: 0.42, noBid: 0.58, noAsk: 0.60,
      }),
    ]);
    expect(snapshot.displaySelection).toMatchObject({
      status: 'available', mode: 'live_quotes', venueId: 'forecastex',
    });
    expect(subject.kalshiFetch).not.toHaveBeenCalled();
  });

  test.each([
    'cached_disconnected_snapshot',
    'mock_fixture',
    'seeded_fallback',
  ])('fails the FES native book closed for forbidden %s provenance', async (provenance) => {
    const subject = createSubject({
      forecastLive: {
        status: 'available',
        fetchedAt: AS_OF,
        brokerRoutable: true,
        lines: [{
          contractId: 'FES_081926_100',
          directNative: true,
          dataType: 'live',
          provenance,
          updatedAt: AS_OF,
          yesBid: 0.40,
          yesAsk: 0.42,
          noBid: 0.58,
          noAsk: 0.60,
          yesBidSize: 10,
          yesAskSize: 10,
          noBidSize: 10,
          noAskSize: 10,
        }],
      },
    });

    const snapshot = await subject.service.getSnapshot('sp500');
    const [bookLine] = snapshot.venues.forecastex.book.lines;

    expect(snapshot.venues.forecastex.book).toMatchObject({
      status: 'unavailable', source: 'forecastex_official_schedule', scheduleOnly: true,
    });
    expect(bookLine).toMatchObject({
      source: 'forecastex_official_schedule', directNative: false,
      yesBid: null, yesAsk: null, noBid: null, noAsk: null,
      yesBidSize: null, yesAskSize: null, noBidSize: null, noAskSize: null,
    });
    expect(snapshot.displaySelection).toMatchObject({
      status: 'available', mode: 'catalog', venueId: 'forecastex',
    });
    expect(snapshot.executionContracts.status).toBe('unavailable');
  });

  test('requests and publishes the exact FES-named ES resolver reference without making it executable', async () => {
    const subject = createSubject({
      marketReference: {
        resolver: 'CME ESU26 dated E-mini S&P 500 future',
        instrument: { symbol: 'ES', displaySymbol: 'ESU26', lastTradeDateOrContractMonth: '202609' },
        spot: { status: 'available', availability: 'live', value: 6420, source: 'ibkr_live_native_quote', priceType: 'direct_last_trade', asOf: AS_OF, expiresAt: EXPIRES, executable: false },
        chart: { status: 'available', availability: 'live', points: [], source: 'ibkr_historical_bars', asOf: AS_OF, expiresAt: EXPIRES, executable: false },
      },
    });
    const result = await subject.service.getSnapshot('sp500');
    expect(subject.loadMarketReference).toHaveBeenCalledWith(expect.objectContaining({
      marketId: 'sp500',
      selected: expect.objectContaining({
        resolverIdentity: expect.objectContaining({ resolverSymbol: 'ESU26', underlyingContractMonth: '202609' }),
      }),
    }));
    expect(result.resolverReference).toMatchObject({
      resolver: 'CME ESU26 dated E-mini S&P 500 future',
      instrument: { displaySymbol: 'ESU26', lastTradeDateOrContractMonth: '202609' },
      spot: { status: 'available', value: 6420, executable: false },
    });
    expect(result.strategy.eligibleVenueId).toBeNull();
    expect(result.venues.kalshi).toBeUndefined();
  });

  test('transitions expired live spot to a display-only last-verified value and removes it on FES rollover', async () => {
    let currentNow = NOW;
    let generation = 'FES_081926';
    let referenceCall = 0;
    const unavailableReference = (resolver) => ({
      status: 'unavailable',
      resolver,
      instrument: { symbol: 'ES', displaySymbol: resolver },
      spot: {
        status: 'unavailable', availability: 'unavailable', fit: 'exact',
        value: null, source: null, asOf: null, expiresAt: null, executable: false,
      },
      chart: {
        status: 'unavailable', availability: 'unavailable', fit: 'exact',
        points: [], source: null, asOf: null, expiresAt: null, executable: false,
      },
    });
    const subject = createSubject({
      now: () => new Date(currentNow),
      forecastContracts: (productId) => {
        const rolled = generation === 'FES_082026';
        const close = rolled ? '2026-08-20T20:00:00.000Z' : CLOSE;
        return {
          productId,
          fetchedAt: new Date(currentNow).toISOString(),
          lines: [{
            productId,
            contractId: `${generation}_6400`,
            strike: 6400,
            lastTradeDate: close,
            question: `Will Sep-26 S&P 500 Index Futures settle above $6,400 on August ${rolled ? 20 : 19} 2026?`,
            expirationDate: rolled ? '2026-08-21T15:00:00.000Z' : '2026-08-20T15:00:00.000Z',
            payoutDate: rolled ? '2026-08-21T17:00:00.000Z' : '2026-08-20T17:00:00.000Z',
            rulesUrl: 'https://data.forecastex.com/regulatory/FESTermsandConditions.pdf',
            openInterest: 500,
          }],
        };
      },
      marketReference: () => {
        referenceCall += 1;
        if (referenceCall > 1) return unavailableReference(generation === 'FES_082026' ? 'ESU26' : 'ESU26');
        return {
          status: 'available',
          resolver: 'ESU26',
          instrument: { symbol: 'ES', displaySymbol: 'ESU26' },
          spot: {
            status: 'available', availability: 'live', fit: 'exact', value: 6420,
            label: 'ESU26', source: 'ibkr_live_native_quote', asOf: AS_OF,
            expiresAt: new Date(NOW + 60_000).toISOString(), executable: false,
          },
          chart: {
            status: 'available', availability: 'live', fit: 'exact', points: [],
            source: 'ibkr_historical_bars', asOf: AS_OF,
            expiresAt: new Date(NOW + 60_000).toISOString(), executable: false,
          },
        };
      },
    });

    const live = await subject.service.getSnapshot('sp500');
    expect(live.resolverReference).toMatchObject({
      spot: { status: 'available', value: 6420 },
      lastVerifiedSpot: {
        status: 'last_verified', value: 6420, generationKey: 'FES_081926',
        displayOnly: true, executable: false,
      },
    });

    currentNow = NOW + 61_000;
    const expired = await subject.service.getSnapshot('sp500');
    expect(expired.resolverReference).toMatchObject({
      spot: { status: 'unavailable', value: null },
      lastVerifiedSpot: {
        status: 'last_verified', value: 6420, generationKey: 'FES_081926',
        displayOnly: true, executable: false,
      },
    });
    expect(expired.strategy.eligibleVenueId).toBeNull();

    generation = 'FES_082026';
    currentNow = Date.parse('2026-08-20T16:00:00.000Z');
    const rolled = await subject.service.getSnapshot('sp500');
    expect(rolled.resolverReference.lastVerifiedSpot).toBeNull();
  });

  test('uses cash SPX as the Risk Range basis while preserving raw ESU26 as the contract reference', async () => {
    const fiveDayDates = ['2026-08-13', '2026-08-14', '2026-08-17', '2026-08-18', '2026-08-19'];
    const tenDayDates = ['2026-08-06', '2026-08-07', '2026-08-10', '2026-08-11', '2026-08-12', ...fiveDayDates];
    const vixCloses = (dates) => ({
      status: 'available', availability: 'historical', source: 'ibkr_historical_daily_close',
      asOf: AS_OF, values: dates.map((date, index) => ({ date, value: 15 + index })),
      missingDates: [], reason: null,
    });
    const verifiedRanges = (dates) => dates.map((date, index) => ({
      date,
      status: 'available',
      references: [
        { status: 'available', label: 'LRR', value: 7600 + index, source: 'hedgeye-risk-ranges-email', asOf: date },
        { status: 'available', label: 'HRR', value: 7800 + index, source: 'hedgeye-risk-ranges-email', asOf: date },
      ],
    }));
    const missingRanges = (dates) => dates.map((date) => ({
      date,
      status: 'unavailable',
      references: [],
      reason: `Exact-date Risk Range data is unavailable for ${date}.`,
    }));
    const completedSessionRanges = (dates) => verifiedRanges(dates).map((range, index) => (
      index === dates.length - 1 ? missingRanges([range.date])[0] : range
    ));
    const oneDay = {
      status: 'available', availability: 'current', range: '1d', source: 'ibkr_historical_bars',
      asOf: AS_OF, expiresAt: EXPIRES, fit: 'exact', executable: false,
      points: [{ timestamp: NOW - 60_000, value: 7700 }, { timestamp: NOW, value: 7710 }],
      references: [],
    };
    const fiveDay = {
      status: 'historical', availability: 'historical', range: '5d', source: 'ibkr_historical_bars',
      asOf: AS_OF, expiresAt: null,
      points: [{ timestamp: NOW - 60_000, value: 7700 }, { timestamp: NOW, value: 7710 }],
      references: [], rangeDates: fiveDayDates, dailyRanges: completedSessionRanges(fiveDayDates),
      riskRangeStatus: 'partial', riskRangeMissingDates: ['2026-08-19'], vixCloses: vixCloses(fiveDayDates),
    };
    const tenDay = {
      ...fiveDay,
      range: '10d',
      rangeDates: tenDayDates,
      dailyRanges: completedSessionRanges(tenDayDates),
      vixCloses: vixCloses(tenDayDates),
    };
    const subject = createSubject({
      spxSnapshot: {
        schemaVersion: 1,
        status: 'partial',
        generatedAt: AS_OF,
        riskRange: {
          status: 'available', lrr: 7604, hrr: 7804, previousClose: 7700,
          date: '2026-08-19', source: 'hedgeye-risk-ranges-email', asOf: '2026-08-19',
        },
        spot: {
          status: 'available', availability: 'live', fit: 'exact', value: 7710,
          label: 'SPX', source: 'ibkr_live_native_quote', asOf: AS_OF,
          expiresAt: EXPIRES, executable: false, previousClose: 7700,
        },
        chart: { ...oneDay, variants: { '1d': { ...oneDay }, '5d': fiveDay, '10d': tenDay } },
        contracts: { status: 'unavailable', event: null, lines: [] },
      },
      marketReference: {
        status: 'available',
        fit: 'proxy',
        resolver: 'ESU26',
        directionalFeed: { marketId: 'sp500', root: 'ES', selectedConId: 12345, localSymbol: 'ESU26' },
        instrument: { symbol: 'ES', displaySymbol: 'ESU26', localSymbol: 'ESU26', conId: 12345 },
        spot: {
          status: 'available', availability: 'live', fit: 'proxy', value: 7722,
          label: 'PROXY · ESU26', source: 'ibkr_live_native_quote', asOf: AS_OF,
          expiresAt: EXPIRES, executable: false, previousClose: 7700,
        },
        chart: {
          ...oneDay,
          fit: 'proxy',
          points: oneDay.points.map((point) => ({ ...point, value: point.value + 12 })),
          variants: {
            '1d': {
              ...oneDay,
              fit: 'proxy',
              points: oneDay.points.map((point) => ({ ...point, value: point.value + 12 })),
            },
            '5d': {
              ...fiveDay, fit: 'proxy', vixCloses: undefined,
              dailyRanges: missingRanges(fiveDayDates), riskRangeStatus: 'partial',
              riskRangeMissingDates: fiveDayDates, riskRangeRefreshPending: true,
            },
            '10d': {
              ...tenDay, fit: 'proxy', vixCloses: undefined,
              dailyRanges: missingRanges(tenDayDates), riskRangeStatus: 'partial',
              riskRangeMissingDates: tenDayDates, riskRangeRefreshPending: true,
            },
          },
        },
      },
    });

    const snapshot = await subject.service.getSnapshot('sp500');

    expect(snapshot.chart).toMatchObject({
      status: 'available',
      range: '1d',
      fit: 'exact',
      executable: false,
      points: oneDay.points,
      variants: {
        '1d': { status: 'available', range: '1d', fit: 'exact', executable: false },
        '5d': {
          status: 'historical', range: '5d',
          riskRangeStatus: 'partial', riskRangeMissingDates: ['2026-08-19'],
        },
        '10d': {
          status: 'historical', range: '10d',
          riskRangeStatus: 'partial', riskRangeMissingDates: ['2026-08-19'],
          vixCloses: {
            status: 'available', availability: 'historical',
            source: 'ibkr_historical_daily_close', values: expect.arrayContaining([
              { date: '2026-08-19', value: 24 },
            ]),
          },
        },
      },
    });
    expect(snapshot.chart.variants['10d'].dailyRanges).toHaveLength(10);
    expect(snapshot.chartReferences).toMatchObject({
      basis: {
        role: 'risk_range_basis', symbol: 'SPX', riskRangeTicker: 'SPX', exact: true,
        spot: { value: 7710 }, chart: { fit: 'exact', points: oneDay.points },
      },
      contract: {
        role: 'contract_reference', symbol: 'ESU26', riskRangeTicker: 'SPX', exact: true,
        spot: { value: 7722 },
        chart: { fit: 'proxy', points: oneDay.points.map((point) => ({ ...point, value: point.value + 12 })) },
      },
    });
    expect(snapshot.resolverReference.spot.value).toBe(7722);
  });

  test('does not reintroduce legacy cash-SPX contracts when the SP500 research core fails', async () => {
    const subject = createSubject({
      spxSnapshot: {
        schemaVersion: 1,
        status: 'partial',
        generatedAt: AS_OF,
        contracts: {
          status: 'unavailable',
          source: null,
          asOf: null,
          expiresAt: null,
          event: null,
          lines: [],
          reason: 'Kalshi refresh failed.',
          refreshFailed: true,
          refreshIssue: 'Kalshi timeout',
        },
      },
    });
    const snapshot = await subject.service.getSnapshot('sp500');
    expect(snapshot.venues.kalshi).toBeUndefined();
    expect(snapshot.venues.forecastex.catalog).toMatchObject({ status: 'available' });
    expect(snapshot.displaySelection).toMatchObject({ status: 'available', venueId: 'forecastex' });
    expect(subject.kalshiFetch).not.toHaveBeenCalled();
    expect(snapshot.strategy.status).toBe('unavailable');
  });
});
