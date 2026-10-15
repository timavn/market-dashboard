const {
  buildMonitorSkeleton,
  clearLiveTradingSnapshot,
  createMarketMonitorCoordinator,
  failStalledRefreshes,
  MAX_CONSECUTIVE_PENDING_REFRESHES,
  mergeProgressiveSnapshot,
  sanitizeCachedSnapshot,
} = require('./marketMonitorCoordinator.cjs');

const NOW = Date.parse('2026-08-19T16:00:00.000Z');
const LAST_COMPLETED_SESSION = '2026-08-18';
const LAST_COMPLETED_AT = Date.parse(`${LAST_COMPLETED_SESSION}T19:55:00.000Z`);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function snapshot(overrides = {}) {
  const event = { ticker: 'KXWTI-26AUG2014', status: 'open', closeTime: '2026-08-20T18:30:00.000Z' };
  const catalog = {
    status: 'available', source: 'kalshi_trade_api_v2_catalog', asOf: new Date(NOW).toISOString(),
    expiresAt: event.closeTime, event,
    lines: [{ ticker: 'WTI-85', threshold: 85, yesBid: null, yesAsk: null }],
  };
  const book = {
    status: 'available', source: 'kalshi_batch_orderbooks_v2', asOf: new Date(NOW).toISOString(),
    expiresAt: new Date(NOW + 90_000).toISOString(), event,
    lines: [{
      ticker: 'WTI-85', threshold: 85, yesBid: 0.4, yesAsk: 0.42, noBid: 0.58, noAsk: 0.6,
      yesBidSize: 10, yesAskSize: 10, noBidSize: 10, noAskSize: 10, directNative: true,
    }],
  };
  return {
    schemaVersion: 2,
    marketId: 'wti',
    generatedAt: new Date(NOW).toISOString(),
    status: 'partial',
    venues: {
      kalshi: {
        id: 'kalshi', label: 'Kalshi', brokerRoutable: true, equivalenceFingerprint: 'test-fingerprint',
        catalog, book, contracts: book,
        bookQuality: { eligible: true, executableLineCount: 1 },
      },
    },
    autoSelection: {
      status: 'available', mode: 'most_executable', venueId: 'kalshi', label: 'Kalshi live book',
      reason: 'Fresh native book.', contracts: book,
    },
    displaySelection: { status: 'available', mode: 'executable', venueId: 'kalshi', contracts: catalog },
    displayContracts: catalog,
    contracts: book,
    strategy: { status: 'unavailable', model: null, eligibleVenueId: null },
    ...overrides,
  };
}

function fesSnapshot(overrides = {}) {
  const event = {
    ticker: 'FES_081926', generationId: 'FES_081926', status: 'open',
    closeTime: '2026-08-19T20:00:00.000Z', productCode: 'FES',
  };
  const catalogLine = {
    ticker: 'FES_081926_7675', contractId: 'FES_081926_7675', threshold: 7675,
    yesBid: null, yesAsk: null, noBid: null, noAsk: null, directNative: false,
  };
  const liveLine = {
    ...catalogLine,
    status: 'available',
    yesBid: 0.68, yesAsk: 0.73, noBid: 0.27, noAsk: 0.32,
    yesBidSize: 5000, yesAskSize: 5000, noBidSize: 5000, noAskSize: 5000,
    source: 'ibkr_tws_forecastex_live',
    updatedAt: new Date(NOW).toISOString(),
    directNative: true,
  };
  const catalog = {
    status: 'available', source: 'forecastex_official_schedule',
    asOf: new Date(NOW).toISOString(), expiresAt: event.closeTime,
    event, lines: [catalogLine], scheduleOnly: true,
  };
  const book = {
    status: 'available', source: 'ibkr_tws_forecastex_live',
    asOf: new Date(NOW).toISOString(), expiresAt: new Date(NOW + 90_000).toISOString(),
    event, lines: [liveLine], scheduleOnly: false,
    ladderSelection: { contractIds: ['FES_081926_7675'] },
  };
  const generation = {
    venueId: 'forecastex', generationId: 'FES_081926', bookStatus: 'available',
    quotedLineCount: 1, executableLineCount: 1, lines: [liveLine],
  };
  return snapshot({
    marketId: 'sp500',
    venues: {
      forecastex: {
        id: 'forecastex', label: 'ForecastEx', status: 'available', generationId: 'FES_081926',
        generationKey: 'FES_081926', brokerRoutable: true, equivalenceFingerprint: 'fes-fingerprint',
        catalog, book, contracts: book, ladderSelection: book.ladderSelection,
        generations: [generation],
        bookQuality: {
          eligible: true, lineCount: 1, directLineCount: 1, executableLineCount: 1,
          displayedDepth: 20_000, displayedAskDepth: 10_000, medianSpread: 0.05,
        },
      },
    },
    generationOptions: [generation],
    selection: { requestedVenue: 'forecastex', requestedGenerationId: null },
    selectedVenueId: 'forecastex',
    selectedGenerationId: 'FES_081926',
    selectedGeneration: generation,
    displaySelection: { status: 'available', mode: 'live_quotes', venueId: 'forecastex', contracts: book },
    displayContracts: book,
    contracts: book,
    resolverReference: {
      status: 'available',
      spot: {
        status: 'available', availability: 'live', fit: 'exact', value: 7666.44,
        source: 'ibkr_live_native_quote', asOf: new Date(NOW).toISOString(),
        expiresAt: new Date(NOW + 60_000).toISOString(), executable: false,
      },
      lastVerifiedSpot: {
        status: 'last_verified', availability: 'last_verified', fit: 'exact', value: 7666.44,
        source: 'ibkr_live_native_quote', asOf: new Date(NOW).toISOString(),
        generationKey: 'FES_081926', retainedUntil: event.closeTime,
        displayOnly: true, executable: false,
      },
    },
    ...overrides,
  });
}

function exactBenchmarkSnapshot() {
  const spot = {
    status: 'available', availability: 'live', fit: 'proxy', value: 76_100,
    source: 'coinbase_exchange_public_ticker', asOf: new Date(NOW).toISOString(),
    expiresAt: new Date(NOW + 90_000).toISOString(), executable: false,
  };
  const reference = {
    status: 'available', fit: 'proxy', spot,
    exactReference: {
      status: 'available', fit: 'exact',
      spot: {
        ...spot, fit: 'exact', value: 76_000, source: 'cfbenchmarks_public_index', indexId: 'BRTI',
        expiresAt: new Date(NOW + 10_000).toISOString(),
      },
    },
  };
  const current = snapshot({ marketId: 'bitcoin', spot, resolverReference: reference });
  current.venues.kalshi.reference = reference;
  return current;
}

function cpiSnapshot({
  releaseKey = 'KXCPIYOY#2026-07',
  reportMonth = '2026-07',
  eventTicker = 'KXCPIYOY-26JUL',
  releaseAt = new Date(NOW + 120_000).toISOString(),
  closeTime = new Date(NOW + 90_000).toISOString(),
  bookStatus = 'available',
} = {}) {
  const event = {
    ticker: eventTicker,
    eventTicker,
    seriesTicker: 'KXCPIYOY',
    status: 'open',
    closeTime,
    releaseKey,
    reportMonth,
    releaseAt,
  };
  const catalogLine = {
    ticker: `${eventTicker}-T2.6`, threshold: 2.6, comparator: '>',
    status: 'catalog', yesBid: null, yesAsk: null, noBid: null, noAsk: null,
    source: 'kalshi_trade_api_v2_catalog', directNative: false,
  };
  const liveLine = {
    ...catalogLine,
    status: 'available', yesBid: 0.4, yesAsk: 0.42, noBid: 0.58, noAsk: 0.6,
    yesBidSize: 10, yesAskSize: 10, noBidSize: 10, noAskSize: 10,
    updatedAt: new Date(NOW).toISOString(), source: 'kalshi_batch_orderbooks_v2', directNative: true,
  };
  const catalog = {
    status: 'available', source: 'kalshi_trade_api_v2_catalog',
    asOf: new Date(NOW).toISOString(), expiresAt: closeTime,
    event, lines: [catalogLine], scheduleOnly: true,
  };
  const book = bookStatus === 'available' ? {
    status: 'available', source: 'kalshi_batch_orderbooks_v2',
    asOf: new Date(NOW).toISOString(), expiresAt: closeTime,
    event, lines: [liveLine], scheduleOnly: false,
  } : {
    status: bookStatus,
    source: null,
    asOf: null,
    expiresAt: null,
    event,
    lines: [],
    scheduleOnly: false,
    refreshing: bookStatus === 'refreshing',
    refreshPending: bookStatus === 'refreshing',
    reason: 'The exact CPI book is refreshing.',
  };
  const comparison = {
    status: 'available', releaseKey, reportMonth, releaseAt, eventTicker,
    hedgeye: {
      status: 'available', reportMonth, baseValue: 2.6,
      scenarios: [{ key: 'base', value: 2.6 }], expiresAt: releaseAt,
    },
    clevelandFed: {
      status: 'available', reportMonth, value: 2.5,
      points: [{ timestamp: NOW, value: 2.5 }], expiresAt: releaseAt,
    },
    bls: {
      status: 'available', reportMonth,
      latestFinal: { reportMonth: '2026-06', value: 2.7 },
    },
  };
  return snapshot({
    marketId: 'cpi',
    status: bookStatus === 'available' ? 'available' : 'partial',
    venues: {
      kalshi: {
        id: 'kalshi', label: 'Kalshi', brokerRoutable: false,
        generationId: eventTicker, equivalenceFingerprint: 'cpi-fingerprint',
        catalog, book, contracts: book,
        bookQuality: {
          eligible: false, lineCount: book.lines.length,
          directLineCount: bookStatus === 'available' ? 1 : 0,
          executableLineCount: 0,
        },
      },
    },
    selection: { requestedVenue: 'kalshi', requestedGenerationId: null },
    selectedVenueId: 'kalshi',
    selectedGenerationId: eventTicker,
    displaySelection: { status: 'available', mode: 'live_quotes', venueId: 'kalshi', contracts: book },
    displayContracts: book,
    contracts: book,
    autoSelection: {
      status: 'unavailable', mode: 'none', venueId: null,
      contracts: { status: 'unavailable', event: null, lines: [] },
    },
    forecastComparison: comparison,
    ladderReference: {
      status: 'available', kind: 'hedgeye_base', label: 'HEDGEYE BASE', value: 2.6,
      reportMonth, expiresAt: releaseAt, availability: 'dated', executable: false,
    },
  });
}

function goldHeaderReferences() {
  return [
    {
      key: 'selectedResolver', label: 'PYTH GOLD INDEX', symbol: 'GOLD/USD', role: 'direct',
      status: 'live', price: 4434.3, previousClose: 4400, changePercent: 0.7795,
      source: 'pyth_lazer_http', instrument: null,
      asOf: new Date(NOW - 10_000).toISOString(), expiresAt: new Date(NOW + 60_000).toISOString(),
      reason: null,
    },
    {
      key: 'xauusd', label: 'SPOT GOLD', symbol: 'XAUUSD', role: 'proxy',
      status: 'live', price: 4433.8, previousClose: 4401, changePercent: 0.7453,
      source: 'ibkr_historical_bars',
      instrument: { symbol: 'XAUUSD', displaySymbol: 'XAUUSD', conId: 69067924 },
      asOf: new Date(NOW - 60_000).toISOString(), expiresAt: new Date(NOW + (9 * 60_000)).toISOString(),
      reason: null,
    },
    {
      key: 'activeComex', label: 'COMEX GOLD', symbol: 'GCZ26', role: 'proxy',
      status: 'historical', price: 4450.2, previousClose: 4420, changePercent: 0.6833,
      source: 'ibkr_historical_bars',
      instrument: { symbol: 'GC', displaySymbol: 'GCZ26', conId: 12345, contractMonth: '202612' },
      asOf: new Date(LAST_COMPLETED_AT).toISOString(), expiresAt: null,
      reason: null,
    },
  ];
}

function chartReference({ role, symbol, conId, value, expiresAt = NOW + 60_000, status = 'available' }) {
  const available = status === 'available';
  const spot = available ? {
    status: 'available', availability: 'live', fit: 'exact', value,
    label: symbol, source: 'ibkr_live_native_quote', asOf: new Date(NOW).toISOString(),
    expiresAt: new Date(expiresAt).toISOString(), executable: false,
  } : {
    status, availability: 'unavailable', fit: 'exact', value: null,
    label: symbol, source: null, asOf: null, expiresAt: null, executable: false,
    refreshing: status === 'refreshing', refreshPending: status === 'refreshing',
    reason: `${symbol} is refreshing.`,
  };
  const chart = available ? {
    status: 'available', availability: 'live', fit: 'exact', source: 'ibkr_historical_bars',
    asOf: new Date(NOW).toISOString(), expiresAt: new Date(expiresAt).toISOString(), executable: false,
    points: [{ timestamp: NOW - 60_000, value: value - 1 }, { timestamp: NOW, value }],
  } : {
    status, availability: 'unavailable', fit: 'exact', source: null, asOf: null, expiresAt: null,
    executable: false, points: [], refreshing: status === 'refreshing', refreshPending: status === 'refreshing',
    reason: `${symbol} chart is refreshing.`,
  };
  return {
    role,
    symbol,
    riskRangeTicker: 'SPX',
    exact: true,
    fit: 'exact',
    instrument: { symbol: symbol === 'SPX' ? 'SPX' : 'ES', displaySymbol: symbol, conId, provider: 'ibkr' },
    spot,
    chart,
    freshness: { status: available ? 'verified_live' : 'loading', asOf: spot.asOf, expiresAt: spot.expiresAt },
  };
}

describe('prediction monitor progressive coordinator', () => {
  test.each([
    ['bitcoin', 'KXBTCPERP', 'BTC'], ['ethereum', 'KXETHPERP', 'ETH'],
  ])('marks the cold %s shell as a direct perpetual before any provider call', (marketId, ticker, symbol) => {
    const monitorService = { getSnapshot: jest.fn() };
    const coordinator = createMarketMonitorCoordinator({
      monitorService, marketIds: [marketId], now: () => new Date(NOW), logger: { error: jest.fn() },
    });
    const skeleton = buildMonitorSkeleton(marketId, () => new Date(NOW));
    expect(Object.keys(skeleton.chartReferences)).toEqual(['basis']);
    for (const cold of [skeleton, coordinator.getSnapshot(marketId)]) {
      expect(cold.perpetualReference).toMatchObject({
        referenceKind: 'perpetual_contract', instrument: { symbol: ticker },
        spot: { value: null, source: null },
      });
      expect(cold.spot.value).toBeNull();
      expect(cold.chartReferences.basis.symbol).toBe(symbol);
      expect(cold.chartReferences.contract).toBeFalsy();
      expect(cold.resolverReference).toBeNull();
      expect(cold.venues.kalshi.reference).toBeNull();
      expect(cold.proxyFit).toBeNull();
      for (const range of ['1d', '5d', '10d']) {
        expect(cold.chart.variants[range].points).toEqual([]);
      }
    }
    expect(monitorService.getSnapshot).not.toHaveBeenCalled();
    expect(buildMonitorSkeleton('gold', () => new Date(NOW)).perpetualReference).toBeUndefined();
  });

  test('returns a structured cold shell while monitor GET reads cause zero upstream calls', async () => {
    const monitorService = { getSnapshot: jest.fn(async () => snapshot()) };
    const coordinator = createMarketMonitorCoordinator({
      monitorService,
      marketIds: ['wti'],
      now: () => new Date(NOW),
      logger: { error: jest.fn() },
    });

    const started = performance.now();
    const first = coordinator.getSnapshot('wti');
    const second = coordinator.getSnapshot('wti');

    expect(performance.now() - started).toBeLessThan(100);
    expect(first).toMatchObject({
      schemaVersion: 2,
      marketId: 'wti',
      status: 'refreshing',
      refresh: { state: 'idle', revision: 0, suggestedNextPollMs: 5_000 },
      chart: {
        range: '1d', points: [],
        variants: {
          '1d': { range: '1d', points: [] },
          '5d': { range: '5d', points: [] },
          '10d': { range: '10d', points: [] },
        },
      },
    });
    expect(second.refresh.state).toBe('idle');
    expect(monitorService.getSnapshot).toHaveBeenCalledTimes(0);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(monitorService.getSnapshot).toHaveBeenCalledTimes(0);
  });

  test('prewarms only markets enabled by the staged pipeline allowlist', async () => {
    const monitorService = {
      getSnapshot: jest.fn(async (marketId) => snapshot({ marketId })),
    };
    const coordinator = createMarketMonitorCoordinator({
      monitorService,
      marketIds: ['gold', 'silver', 'wti'],
      scheduledMarketIds: ['gold', 'silver'],
      now: () => new Date(NOW),
      logger: { error: jest.fn() },
    });

    coordinator.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    coordinator.stop();

    expect(monitorService.getSnapshot.mock.calls.map(([marketId]) => marketId).sort()).toEqual(['gold', 'silver']);
    expect(coordinator.getHealth()).toMatchObject({
      gold: { pipelineEnabled: true },
      silver: { pipelineEnabled: true },
      wti: { pipelineEnabled: false, state: 'not_started' },
    });
    expect(coordinator.getSnapshot('wti')).toMatchObject({ marketId: 'wti', status: 'refreshing' });
  });

  test('serves explicit Kalshi Gold reads from the already-prewarmed Gold state', async () => {
    const monitorService = {
      getSnapshot: jest.fn(async (marketId) => snapshot({ marketId })),
    };
    const coordinator = createMarketMonitorCoordinator({
      monitorService,
      marketIds: ['gold'],
      now: () => new Date(NOW),
      logger: { error: jest.fn() },
    });

    await coordinator.refresh('gold');
    const explicitKalshi = coordinator.getSnapshot('gold', {
      venue: 'kalshi',
      generationId: null,
    });

    expect(explicitKalshi).toMatchObject({
      marketId: 'gold',
      status: 'partial',
      revision: 1,
    });
    expect(monitorService.getSnapshot).toHaveBeenCalledTimes(1);
    expect(coordinator.getHealth().gold).toMatchObject({ selectionCount: 1 });
  });

  test('forced acquisition waits for an existing refresh then forwards the fresh dependency boundary', async () => {
    const pending = deferred();
    const monitorService = { getSnapshot: jest.fn().mockImplementationOnce(() => pending.promise).mockResolvedValue(snapshot()) };
    const coordinator = createMarketMonitorCoordinator({ monitorService, marketIds: ['wti'], now: () => new Date(NOW), logger: { error: jest.fn() } });
    const current = coordinator.refresh('wti', { venue: 'kalshi' });
    const forced = coordinator.refresh('wti', { venue: 'kalshi', forceRefresh: true, refreshAfter: 1234 });
    pending.resolve(snapshot());
    await Promise.all([current, forced]);
    expect(monitorService.getSnapshot).toHaveBeenCalledTimes(2);
    expect(monitorService.getSnapshot).toHaveBeenLastCalledWith('wti', expect.objectContaining({ venue: 'kalshi', forceRefresh: true, refreshAfter: 1234 }));
    expect(coordinator.getSnapshot('wti', { venue: 'kalshi' }).revision).toBe(2);
  });

  test('new explicit capture does not inherit exhausted background retries but its continuations stay bounded', async () => {
    const pending = fesSnapshot({ sourceRefreshPending: true });
    pending.venues.forecastex.book = {
      ...pending.venues.forecastex.book, refreshPending: true, refreshRetained: true,
    };
    pending.venues.forecastex.contracts = pending.venues.forecastex.book;
    const monitorService = { getSnapshot: jest.fn(async () => pending) };
    const coordinator = createMarketMonitorCoordinator({
      monitorService, marketIds: ['sp500'], now: () => new Date(NOW), logger: { error: jest.fn() },
    });
    for (let count = 0; count < MAX_CONSECUTIVE_PENDING_REFRESHES - 1; count += 1) {
      await coordinator.refresh('sp500');
    }
    const selection = { venue: 'forecastex', forceRefresh: true, refreshAfter: NOW };
    await coordinator.refresh('sp500', selection);
    expect(coordinator.getSnapshot('sp500', selection).refresh.state).toBe('refreshing');

    for (let count = 1; count < MAX_CONSECUTIVE_PENDING_REFRESHES; count += 1) {
      await coordinator.refresh('sp500', selection);
    }
    expect(coordinator.getSnapshot('sp500', selection)).toMatchObject({
      refresh: { state: 'idle' },
      venues: { forecastex: { book: { refreshFailed: true, lines: [] } } },
    });
  });

  test('publishes the completed revision on the next poll without another upstream call', async () => {
    const pending = deferred();
    const monitorService = { getSnapshot: jest.fn(() => pending.promise) };
    const coordinator = createMarketMonitorCoordinator({
      monitorService, marketIds: ['wti'], now: () => new Date(NOW), logger: { error: jest.fn() },
    });
    const completion = coordinator.refresh('wti');
    pending.resolve(snapshot());
    await completion;

    expect(coordinator.getSnapshot('wti')).toMatchObject({
      status: 'partial',
      refresh: { state: 'idle', revision: 1, suggestedNextPollMs: 5_000 },
      displaySelection: { venueId: 'kalshi' },
      contracts: { status: 'available' },
    });
    expect(monitorService.getSnapshot).toHaveBeenCalledTimes(1);
  });

  test('applies the progressive merge before publishing a refresh-pending revision', async () => {
    const previous = snapshot({
      riskRange: {
        status: 'available', source: 'RiskRangeData', asOf: '2026-08-19',
        expiresAt: new Date(NOW + 6 * 60 * 60_000).toISOString(), lrr: 80, hrr: 90,
      },
      factors: {
        trade: {
          status: 'available', source: 'momo-tracker', asOf: new Date(NOW).toISOString(),
          expiresAt: new Date(NOW + 6 * 60 * 60_000).toISOString(), direction: 'BULLISH',
        },
      },
      factorRows: [{ id: 'trade', status: 'available', displayValue: 'BULLISH' }],
    });
    const pending = snapshot({
      sourceRefreshPending: true,
      riskRange: {
        status: 'refreshing', refreshing: true, source: null, asOf: null,
        expiresAt: null, lrr: null, hrr: null,
      },
      factors: {
        trade: {
          status: 'refreshing', refreshing: true, source: null, asOf: null,
          expiresAt: null, direction: null,
        },
      },
      factorRows: [{ id: 'trade', status: 'refreshing', displayValue: null }],
    });
    const monitorService = {
      getSnapshot: jest.fn().mockResolvedValueOnce(previous).mockResolvedValueOnce(pending),
    };
    const coordinator = createMarketMonitorCoordinator({
      monitorService, marketIds: ['wti'], now: () => new Date(NOW), logger: { error: jest.fn() },
    });

    await coordinator.refresh('wti');
    await coordinator.refresh('wti');
    const published = coordinator.getSnapshot('wti');

    expect(published.riskRange).toMatchObject({
      status: 'available', lrr: 80, hrr: 90, refreshRetained: true,
    });
    expect(published.factors.trade).toMatchObject({
      status: 'available', direction: 'BULLISH', refreshRetained: true,
    });
    expect(published.factorRows).toContainEqual(expect.objectContaining({
      id: 'trade', displayValue: 'BULLISH', refreshRetained: true,
    }));
  });

  test('expires a live display field without allowing the GET to start provider work', async () => {
    let nowMs = NOW;
    const pending = deferred();
    const current = snapshot({
      spot: {
        status: 'available', availability: 'live', value: 84.4,
        source: 'ibkr_live_native_quote', asOf: new Date(NOW).toISOString(),
        expiresAt: new Date(NOW + 10_000).toISOString(),
      },
      sourceHealth: [{
        id: 'resolver_spot', status: 'live', source: 'ibkr_live_native_quote', applicable: true,
      }],
    });
    const monitorService = {
      getSnapshot: jest.fn()
        .mockResolvedValueOnce(current)
        .mockImplementationOnce(() => pending.promise),
    };
    const coordinator = createMarketMonitorCoordinator({
      monitorService, marketIds: ['wti'], now: () => new Date(nowMs), logger: { error: jest.fn() },
    });

    await coordinator.refresh('wti');
    nowMs += 11_000;
    const displayed = coordinator.getSnapshot('wti');

    expect(displayed.refresh).toMatchObject({ state: 'idle' });
    expect(displayed.spot).toMatchObject({ status: 'unavailable', value: null });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(monitorService.getSnapshot).toHaveBeenCalledTimes(1);
    const completion = coordinator.refresh('wti');
    expect(coordinator.getSnapshot('wti').refresh).toMatchObject({ state: 'refreshing' });
    pending.resolve(current);
    await completion;
  });

  test('expires live books and display quotes while retaining the current catalog geometry', () => {
    const stale = snapshot();
    const sanitized = sanitizeCachedSnapshot(stale, NOW + 91_000);
    expect(sanitized.venues.kalshi.catalog).toMatchObject({ status: 'available' });
    expect(sanitized.venues.kalshi.catalog.lines).toHaveLength(1);
    expect(sanitized.venues.kalshi.book).toMatchObject({ status: 'unavailable', lines: [] });
    expect(sanitized.autoSelection).toMatchObject({ status: 'unavailable', venueId: null });
    expect(sanitized.contracts.lines).toHaveLength(1);
    expect(sanitized.contracts.lines[0]).toMatchObject({ directNative: false, yesBid: null, yesAsk: null });
    expect(sanitized.displaySelection).toMatchObject({ status: 'available', mode: 'catalog', venueId: 'kalshi' });
    expect(sanitized.displayContracts.lines[0]).toMatchObject({ yesBid: null, yesAsk: null });
  });

  test('clears the independently live exact benchmark after a whole-refresh failure', () => {
    const current = exactBenchmarkSnapshot();
    const cleared = clearLiveTradingSnapshot(current, 'Benchmark provider disconnected.', {
      failed: true, nowMs: NOW,
    });

    expect(cleared.resolverReference.exactReference.spot).toMatchObject({
      status: 'refresh_failed', value: null, refreshFailed: true, availability: 'unavailable',
    });
    expect(cleared.venues.kalshi.reference.exactReference.spot)
      .toEqual(cleared.resolverReference.exactReference.spot);
    expect(current.resolverReference.exactReference.spot.value).toBe(76_000);
  });

  test('expires an exact benchmark while its chart proxy and native book remain fresh', () => {
    const current = exactBenchmarkSnapshot();
    const sanitized = sanitizeCachedSnapshot(current, NOW + 11_000);

    expect(sanitized.resolverReference.exactReference.spot).toMatchObject({
      status: 'unavailable', value: null, availability: 'unavailable',
    });
    expect(sanitized.venues.kalshi.reference.exactReference.spot)
      .toEqual(sanitized.resolverReference.exactReference.spot);
    expect(sanitized.resolverReference.spot).toMatchObject({ status: 'available', value: 76_100 });
    expect(sanitized.venues.kalshi.book.status).toBe('available');
  });

  test('the scheduler refreshes an expired exact benchmark before the proxy refresh interval', async () => {
    jest.useFakeTimers();
    let nowMs = NOW;
    const pending = deferred();
    const monitorService = { getSnapshot: jest.fn()
      .mockResolvedValueOnce(exactBenchmarkSnapshot())
      .mockImplementation(() => pending.promise) };
    const coordinator = createMarketMonitorCoordinator({
      monitorService, marketIds: ['bitcoin'], now: () => new Date(nowMs),
      refreshIntervalMs: 60_000, activePollMs: 1_000, logger: { error: jest.fn() },
    });
    try {
      coordinator.start();
      await jest.advanceTimersByTimeAsync(1);
      expect(monitorService.getSnapshot).toHaveBeenCalledTimes(1);
      nowMs += 11_000;
      await jest.advanceTimersByTimeAsync(250);
      expect(monitorService.getSnapshot).toHaveBeenCalledTimes(2);
      pending.resolve(exactBenchmarkSnapshot());
      await jest.advanceTimersByTimeAsync(1);
    } finally {
      coordinator.stop();
      jest.useRealTimers();
    }
  });

  test('clears CPI forecasts, the dated ladder marker, and live quotes at the release boundary', () => {
    const current = cpiSnapshot();
    const releaseAt = Date.parse(current.forecastComparison.releaseAt);
    const sanitized = sanitizeCachedSnapshot(current, releaseAt);

    expect(sanitized.forecastComparison).toMatchObject({
      status: 'unavailable',
      hedgeye: { status: 'unavailable', scenarios: [], baseValue: null },
      clevelandFed: { status: 'unavailable', value: null, points: [] },
      bls: { status: 'unavailable', latestFinal: null },
    });
    expect(sanitized.ladderReference).toBeNull();
    expect(sanitized.venues.kalshi.book).toMatchObject({ status: 'unavailable', lines: [] });
    expect(sanitized.executionContracts.lines).toHaveLength(0);
  });

  test('retains a fresh exact-release CPI book only while its next refresh is pending', () => {
    const previous = cpiSnapshot();
    const pending = cpiSnapshot({ bookStatus: 'refreshing' });
    const merged = mergeProgressiveSnapshot(previous, pending, NOW);

    expect(merged.venues.kalshi.book).toMatchObject({
      status: 'available', refreshPending: true, refreshRetained: true,
      event: { releaseKey: 'KXCPIYOY#2026-07' },
    });
    expect(merged.venues.kalshi.book.lines[0]).toMatchObject({
      directNative: true, yesBid: 0.4, yesAsk: 0.42,
    });
  });

  test('never carries a CPI catalog or book into a different release month', () => {
    const previous = cpiSnapshot();
    const next = cpiSnapshot({
      releaseKey: 'KXCPIYOY#2026-08',
      reportMonth: '2026-08',
      eventTicker: 'KXCPIYOY-26AUG',
      releaseAt: new Date(NOW + 32 * 24 * 60 * 60_000).toISOString(),
      closeTime: new Date(NOW + 32 * 24 * 60 * 60_000 - 60_000).toISOString(),
      bookStatus: 'refreshing',
    });
    const merged = mergeProgressiveSnapshot(previous, next, NOW);

    expect(merged.forecastComparison.releaseKey).toBe('KXCPIYOY#2026-08');
    expect(merged.venues.kalshi.catalog.event.eventTicker).toBe('KXCPIYOY-26AUG');
    expect(merged.venues.kalshi.book).toMatchObject({
      status: 'refreshing', refreshPending: true, lines: [],
      event: { releaseKey: 'KXCPIYOY#2026-08' },
    });
    expect(merged.venues.kalshi.book.refreshRetained).not.toBe(true);
  });

  test('expires and clears venue-bound references together with their top-level mirror', () => {
    const variant = (range) => ({
      status: 'available', availability: 'live', fit: 'exact', range,
      source: 'ibkr_historical_bars', asOf: new Date(NOW).toISOString(),
      expiresAt: new Date(NOW + 60_000).toISOString(),
      points: [{ timestamp: NOW - 1_000, value: 84.3 }, { timestamp: NOW, value: 84.4 }],
      references: [], dailyRanges: [], rangeDates: [], executable: false,
    });
    const reference = {
      status: 'available', resolver: 'exact WTI resolver', fit: 'exact',
      spot: {
        status: 'available', availability: 'live', fit: 'exact', value: 84.4,
        source: 'ibkr_live_native_quote', asOf: new Date(NOW).toISOString(),
        expiresAt: new Date(NOW + 60_000).toISOString(), executable: false,
      },
      chart: {
        ...variant('1d'),
        variants: { '1d': variant('1d'), '5d': variant('5d'), '10d': variant('10d') },
      },
    };
    const current = snapshot({
      selectedVenueId: 'kalshi',
      spot: reference.spot,
      chart: reference.chart,
      resolverReference: reference,
    });
    current.venues.kalshi.reference = reference;

    const expired = sanitizeCachedSnapshot(current, NOW + 60_001);
    expect(expired.venues.kalshi.reference).toMatchObject({
      spot: { status: 'unavailable', value: null },
      chart: { status: 'unavailable', points: [] },
    });
    expect(expired.spot).toEqual(expired.venues.kalshi.reference.spot);
    expect(expired.chart).toEqual(expired.venues.kalshi.reference.chart);
    expect(expired.resolverReference).toEqual(expired.venues.kalshi.reference);

    const disconnected = clearLiveTradingSnapshot(current, 'IBKR disconnected.', {
      failed: true,
      nowMs: NOW,
    });
    expect(disconnected.venues.kalshi.reference).toMatchObject({
      spot: { status: 'refresh_failed', value: null, refreshFailed: true },
      chart: { status: 'unavailable', points: [], refreshFailed: true },
    });
    expect(disconnected.spot).toEqual(disconnected.venues.kalshi.reference.spot);
    expect(disconnected.resolverReference).toEqual(disconnected.venues.kalshi.reference);
  });

  test('retains fresh live references but clears trade-bearing contract data during a whole refresh', () => {
    const chartVariant = (range, status = 'available', availability = 'current') => ({
      status,
      availability,
      source: 'ibkr_historical_bars',
      asOf: new Date(status === 'historical' ? LAST_COMPLETED_AT : NOW).toISOString(),
      latestAt: new Date(status === 'historical' ? LAST_COMPLETED_AT : NOW).toISOString(),
      historicalThroughDate: status === 'historical' ? LAST_COMPLETED_SESSION : null,
      expiresAt: status === 'historical' ? null : new Date(NOW + 60_000).toISOString(),
      range,
      points: status === 'historical'
        ? [{ timestamp: LAST_COMPLETED_AT - 1_000, value: 84.1 }, { timestamp: LAST_COMPLETED_AT, value: 84.4 }]
        : [{ timestamp: NOW - 1_000, value: 84.1 }, { timestamp: NOW, value: 84.4 }],
      dailyRanges: [],
      rangeDates: [],
    });
    const oneDay = chartVariant('1d');
    const current = snapshot({
      spot: {
        status: 'available', availability: 'live', value: 84.4,
        source: 'ibkr_live_native_quote', asOf: new Date(NOW).toISOString(),
        expiresAt: new Date(NOW + 60_000).toISOString(), executable: false,
      },
      chart: {
        ...oneDay,
        fit: 'exact',
        variants: {
          '1d': oneDay,
          '5d': chartVariant('5d', 'historical', 'historical'),
          '10d': chartVariant('10d', 'historical', 'historical'),
        },
      },
      resolverReference: {
        spot: {
          status: 'available', availability: 'live', value: 84.4, fit: 'exact',
          source: 'ibkr_live_native_quote', asOf: new Date(NOW).toISOString(),
          expiresAt: new Date(NOW + 60_000).toISOString(), executable: false,
        },
        chart: oneDay,
      },
      generationOptions: [{
        venueId: 'kalshi', generationId: 'KXWTI-26AUG2014',
        lines: [{ ...snapshot().venues.kalshi.book.lines[0] }],
        bookStatus: 'available', quotedLineCount: 1, executableLineCount: 1,
      }],
      selectedGenerationId: 'KXWTI-26AUG2014',
      sourceHealth: [{ id: 'kalshi_book', status: 'live', applicable: true }],
    });
    current.venues.kalshi.generationId = 'KXWTI-26AUG2014';
    current.venues.kalshi.generations = current.generationOptions;

    const refreshing = clearLiveTradingSnapshot(current, 'Refresh in progress.', { nowMs: NOW });

    expect(refreshing.spot).toMatchObject({
      status: 'available', value: 84.4, refreshRetained: true, refreshPending: true,
    });
    expect(refreshing.chart).toMatchObject({
      status: 'available', refreshing: false, refreshPending: true, refreshRetained: true,
      points: [{ value: 84.1 }, { value: 84.4 }],
      variants: {
        '1d': { status: 'available', refreshing: false, refreshPending: true, refreshRetained: true },
        '5d': { status: 'historical', refreshing: false, refreshPending: true, refreshRetained: true },
        '10d': { status: 'historical', refreshing: false, refreshPending: true, refreshRetained: true },
      },
    });
    expect(refreshing.resolverReference.spot).toMatchObject({
      status: 'available', value: 84.4, fit: 'exact', refreshRetained: true, refreshPending: true,
    });
    expect(refreshing.resolverReference.chart).toMatchObject({
      status: 'available', refreshing: false, refreshPending: true, refreshRetained: true,
      points: [{ value: 84.1 }, { value: 84.4 }],
    });
    expect(refreshing.venues.kalshi.book).toMatchObject({ status: 'refreshing', lines: [] });
    expect(refreshing.generationOptions[0]).toMatchObject({
      bookStatus: 'unavailable', quotedLineCount: 0, executableLineCount: 0,
      lines: [expect.objectContaining({
        yesBid: null, yesAsk: null, noBid: null, noAsk: null,
        yesBidSize: null, yesAskSize: null, noBidSize: null, noAskSize: null,
        directNative: false,
      })],
    });
    expect(refreshing.sourceHealth).toEqual([
      expect.objectContaining({ id: 'kalshi_book', status: 'refreshing', reason: 'Refresh in progress.' }),
    ]);
    expect(refreshing.executionContracts.lines).toHaveLength(0);

    const failed = clearLiveTradingSnapshot(current, 'IBKR disconnected.', { failed: true, nowMs: NOW });
    expect(failed.spot).toMatchObject({ status: 'refresh_failed', value: null });
    expect(failed.resolverReference.spot).toMatchObject({ status: 'refresh_failed', value: null });
  });

  test('keeps a verified FES book during pending refresh and clears it on provider timeout', () => {
    const current = fesSnapshot();
    const refreshing = clearLiveTradingSnapshot(current, 'Refresh in progress.', { nowMs: NOW });

    expect(refreshing.venues.forecastex.book).toMatchObject({
      status: 'available', refreshing: false, refreshPending: true, refreshRetained: true,
      lines: [expect.objectContaining({
        directNative: true, yesBid: 0.68, yesAsk: 0.73, noBid: 0.27, noAsk: 0.32,
      })],
    });
    expect(refreshing.displayContracts).toMatchObject({
      status: 'available', scheduleOnly: false,
      lines: [expect.objectContaining({ yesBid: 0.68, noAsk: 0.32 })],
    });
    expect(refreshing.generationOptions[0].lines[0]).toMatchObject({
      directNative: true, yesBid: 0.68, noAsk: 0.32,
    });

    const timedOut = clearLiveTradingSnapshot(
      current,
      'ForecastEx native quote refresh timed out.',
      { failed: true, nowMs: NOW + 30_000 },
    );
    expect(timedOut.venues.forecastex.book).toMatchObject({
      status: 'refresh_failed', refreshFailed: true, lines: [],
    });
    expect(timedOut.displayContracts.lines[0]).toMatchObject({
      directNative: false, yesBid: null, noAsk: null,
    });
  });

  test('exhausted native refresh clears retained executable quotes while retaining independent catalog terms', () => {
    const current = fesSnapshot({ sourceRefreshPending: true });
    current.venues.forecastex.book = {
      ...current.venues.forecastex.book, refreshPending: true, refreshRetained: true,
    };
    current.venues.forecastex.contracts = current.venues.forecastex.book;
    const failed = failStalledRefreshes(current);

    expect(failed.venues.forecastex.book).toMatchObject({
      status: 'unavailable', refreshFailed: true, refreshRetained: false,
      errorCode: 'PM_SOURCE_REFRESH_TIMEOUT', lines: [], asOf: null,
    });
    expect(failed.venues.forecastex.catalog).toEqual(current.venues.forecastex.catalog);
  });

  test('keeps a verified same-generation commodity chart while its ForecastEx venue shell refreshes', () => {
    const event = {
      ticker: 'METLS_083126', generationId: 'METLS_083126', status: 'open',
      closeTime: '2026-08-31T17:25:00.000Z', productCode: 'METLS',
    };
    const dailyRange = {
      date: LAST_COMPLETED_SESSION,
      startAt: LAST_COMPLETED_AT - 60_000,
      endAt: LAST_COMPLETED_AT,
      status: 'available',
      references: [
        { status: 'available', label: 'LRR', value: 70, source: 'RiskRangeData', asOf: LAST_COMPLETED_SESSION },
        { status: 'available', label: 'HRR', value: 80, source: 'RiskRangeData', asOf: LAST_COMPLETED_SESSION },
      ],
      reason: null,
    };
    const historicalVariant = (range) => ({
      status: 'historical', availability: 'historical', source: 'ibkr_historical_bars', range,
      asOf: new Date(LAST_COMPLETED_AT).toISOString(), latestAt: new Date(LAST_COMPLETED_AT).toISOString(),
      historicalThroughDate: LAST_COMPLETED_SESSION, expiresAt: null,
      points: [{ timestamp: LAST_COMPLETED_AT - 60_000, value: 75 }, { timestamp: LAST_COMPLETED_AT, value: 76 }],
      rangeDates: [LAST_COMPLETED_SESSION], dailyRanges: [dailyRange], riskRangeStatus: 'available',
      fit: 'proxy', executable: false,
    });
    const oneDay = historicalVariant('1d');
    const chart = {
      ...oneDay,
      variants: { '1d': oneDay, '5d': historicalVariant('5d'), '10d': historicalVariant('10d') },
    };
    const pendingVariant = (range, failed = false) => ({
      status: failed ? 'refresh_failed' : 'unavailable', availability: 'unavailable',
      source: null, range, expiresAt: null, points: [], dailyRanges: [], rangeDates: [],
      reason: failed ? 'IBKR disconnected.' : 'Silver ForecastEx reference is refreshing.',
      ...(failed ? { refreshFailed: true, refreshIssue: 'IBKR disconnected.' } : {}),
      fit: 'proxy', executable: false,
    });
    const pendingOneDay = pendingVariant('1d');
    const pendingChart = {
      ...pendingOneDay,
      variants: {
        '1d': pendingOneDay,
        '5d': pendingVariant('5d'),
        '10d': pendingVariant('10d'),
      },
    };
    const base = fesSnapshot();
    const priorVenue = {
      ...base.venues.forecastex,
      generationId: event.generationId,
      generationKey: event.generationId,
      catalog: { ...base.venues.forecastex.catalog, event },
      book: { ...base.venues.forecastex.book, event },
      contracts: { ...base.venues.forecastex.contracts, event },
      reference: {
        status: 'available', fit: 'proxy', backgroundRefresh: false,
        spot: {
          status: 'historical', availability: 'historical', value: 76, fit: 'proxy',
          source: 'ibkr_historical_bars', asOf: new Date(LAST_COMPLETED_AT).toISOString(),
          historicalThroughDate: LAST_COMPLETED_SESSION, expiresAt: null, executable: false,
        },
        chart,
      },
    };
    const previous = fesSnapshot({
      marketId: 'silver',
      venues: { forecastex: priorVenue },
      spot: priorVenue.reference.spot,
      chart,
      resolverReference: priorVenue.reference,
      selectedGenerationId: event.generationId,
    });
    const unavailableReference = {
      status: 'unavailable', fit: 'proxy',
      spot: {
        status: 'unavailable', availability: 'unavailable', value: null, source: null,
        reason: 'Silver ForecastEx reference is refreshing.', fit: 'proxy', executable: false,
      },
      chart: pendingChart,
    };
    const pending = fesSnapshot({
      marketId: 'silver',
      generatedAt: new Date(NOW + 1_000).toISOString(),
      sourceRefreshPending: true,
      venues: {
        forecastex: {
          ...priorVenue,
          generationId: null,
          generationKey: null,
          backgroundRefresh: true,
          catalog: {
            status: 'unavailable', source: null, event: null, lines: [],
            refreshing: true, reason: 'The current ForecastEx schedule is refreshing.',
          },
          reference: unavailableReference,
        },
      },
      spot: unavailableReference.spot,
      chart: pendingChart,
      resolverReference: unavailableReference,
      selectedGenerationId: event.generationId,
    });

    const retained = mergeProgressiveSnapshot(previous, pending, NOW);
    expect(retained.venues.forecastex.reference.spot).toMatchObject({
      status: 'historical', value: 76, refreshPending: true, refreshRetained: true,
    });
    expect(retained.venues.forecastex.reference.chart).toMatchObject({
      status: 'historical', refreshPending: true, refreshRetained: true,
      dailyRanges: [expect.objectContaining({ status: 'available' })],
      variants: {
        '1d': { status: 'historical', refreshPending: true, refreshRetained: true },
        '5d': { status: 'historical', refreshPending: true, refreshRetained: true },
        '10d': { status: 'historical', refreshPending: true, refreshRetained: true },
      },
    });
    expect(retained.chart.variants['1d'].dailyRanges).toHaveLength(1);

    const failedOneDay = pendingVariant('1d', true);
    const failedChart = {
      ...failedOneDay,
      variants: {
        '1d': failedOneDay,
        '5d': pendingVariant('5d', true),
        '10d': pendingVariant('10d', true),
      },
    };
    const failed = mergeProgressiveSnapshot(previous, {
      ...pending,
      sourceRefreshPending: false,
      venues: {
        forecastex: {
          ...priorVenue,
          backgroundRefresh: false,
          reference: {
            ...unavailableReference,
            spot: { ...unavailableReference.spot, refreshFailed: true, reason: 'IBKR disconnected.' },
            chart: failedChart,
          },
        },
      },
    }, NOW);
    expect(failed.venues.forecastex.reference.chart).toMatchObject({
      status: 'refresh_failed', refreshFailed: true, points: [],
    });
  });

  test.each([
    ['disconnect', 'IBKR disconnected.', NOW],
    ['delayed data', 'IBKR returned delayed market data.', NOW],
    ['expired evidence', 'Refresh in progress.', NOW + 90_001],
  ])('clears a FES live book immediately for %s', (_label, reason, nowMs) => {
    const cleared = clearLiveTradingSnapshot(fesSnapshot(), reason, {
      failed: reason !== 'Refresh in progress.',
      nowMs,
    });
    expect(cleared.venues.forecastex.book).toMatchObject({ lines: [] });
    expect(cleared.displayContracts.lines[0]).toMatchObject({
      directNative: false,
      yesBid: null, yesAsk: null, noBid: null, noAsk: null,
    });
  });

  test('does not carry a prior-generation FES book into a newly selected generation', () => {
    const previous = fesSnapshot();
    const nextEvent = {
      ...previous.venues.forecastex.book.event,
      ticker: 'FES_082026', generationId: 'FES_082026',
      closeTime: '2026-08-20T20:00:00.000Z',
    };
    const next = fesSnapshot({
      generatedAt: new Date(NOW + 30_000).toISOString(),
      venues: {
        forecastex: {
          ...previous.venues.forecastex,
          generationId: 'FES_082026', generationKey: 'FES_082026',
          ladderSelection: null,
          catalog: {
            ...previous.venues.forecastex.catalog,
            event: nextEvent,
            lines: [{
              ...previous.venues.forecastex.catalog.lines[0],
              ticker: 'FES_082026_7675', contractId: 'FES_082026_7675',
            }],
          },
          book: {
            status: 'refreshing', refreshing: true, source: null, asOf: null, expiresAt: null,
            event: nextEvent, lines: [], reason: 'New generation is refreshing.',
          },
          contracts: {
            status: 'refreshing', refreshing: true, source: null, asOf: null, expiresAt: null,
            event: nextEvent, lines: [], reason: 'New generation is refreshing.',
          },
        },
      },
      resolverReference: {
        status: 'refreshing',
        spot: { status: 'refreshing', refreshing: true, value: null, fit: 'exact' },
        lastVerifiedSpot: null,
      },
    });

    const merged = mergeProgressiveSnapshot(previous, next, NOW + 30_000);
    expect(merged.venues.forecastex.book.lines).toEqual([]);
    expect(merged.displayContracts.lines[0]).toMatchObject({
      ticker: 'FES_082026_7675', directNative: false, yesBid: null, noAsk: null,
    });
    expect(merged.resolverReference.lastVerifiedSpot).toBeNull();
  });

  test('keeps the exact resolver marker through a localized pending refresh only while it is fresh', () => {
    const liveReference = {
      status: 'available', availability: 'live', fit: 'exact', value: 7746.25,
      source: 'ibkr_live_native_quote', expiresAt: new Date(NOW + 60_000).toISOString(),
    };
    const previous = snapshot({
      marketId: 'sp500',
      resolverReference: { status: 'available', spot: liveReference, chart: null },
    });
    const pending = snapshot({
      marketId: 'sp500',
      sourceRefreshPending: true,
      resolverReference: {
        status: 'refreshing',
        spot: {
          status: 'refreshing', refreshing: true, availability: 'unavailable',
          fit: 'exact', value: null, source: null, expiresAt: null,
        },
        chart: null,
      },
    });

    expect(mergeProgressiveSnapshot(previous, pending, NOW).resolverReference.spot).toMatchObject({
      status: 'available', value: 7746.25, refreshRetained: true, refreshPending: true,
    });
    expect(mergeProgressiveSnapshot(previous, pending, NOW + 60_001).resolverReference.spot).toMatchObject({
      status: 'refreshing', value: null,
    });

    const disconnected = {
      ...pending,
      sourceRefreshPending: false,
      resolverReference: {
        status: 'unavailable',
        spot: {
          status: 'unavailable', availability: 'unavailable', fit: 'exact', value: null,
          source: null, expiresAt: null, reason: 'IBKR disconnected',
        },
        chart: null,
      },
    };
    expect(mergeProgressiveSnapshot(previous, disconnected, NOW).resolverReference.spot).toMatchObject({
      status: 'unavailable', value: null, reason: 'IBKR disconnected',
    });
  });

  test('retains and expires basis and contract chart references independently without changing ladder identity', () => {
    const basis = chartReference({
      role: 'risk_range_basis', symbol: 'SPX', conId: 416904, value: 7634, expiresAt: NOW + 30_000,
    });
    const contract = chartReference({ role: 'contract_reference', symbol: 'ESU26', conId: 12345, value: 7648 });
    const chartReferences = { basis, contract };
    const resolverReference = { ...contract, resolver: 'CME ESU26', chartReferences };
    const previousBase = fesSnapshot({
      spot: basis.spot,
      chart: basis.chart,
      chartReferences,
      resolverReference,
    });
    const previous = {
      ...previousBase,
      venues: {
        forecastex: { ...previousBase.venues.forecastex, reference: resolverReference },
      },
    };

    const pendingBasis = chartReference({
      role: 'risk_range_basis', symbol: 'SPX', conId: 416904, value: null, status: 'refreshing',
    });
    const newerContract = chartReference({
      role: 'contract_reference', symbol: 'ESU26', conId: 12345, value: 7652, expiresAt: NOW + 120_000,
    });
    const nextReferences = { basis: pendingBasis, contract: newerContract };
    const nextResolver = { ...newerContract, resolver: 'CME ESU26', chartReferences: nextReferences };
    const nextBase = fesSnapshot({
      sourceRefreshPending: true,
      spot: pendingBasis.spot,
      chart: pendingBasis.chart,
      chartReferences: nextReferences,
      resolverReference: nextResolver,
    });
    const next = {
      ...nextBase,
      venues: {
        forecastex: {
          ...nextBase.venues.forecastex,
          backgroundRefresh: true,
          reference: nextResolver,
        },
      },
    };

    const merged = mergeProgressiveSnapshot(previous, next, NOW);
    expect(merged.spot).toMatchObject({ value: 7634, refreshRetained: true });
    expect(merged.chartReferences.basis).toMatchObject({
      symbol: 'SPX', freshness: { status: 'delayed' }, spot: { value: 7634 },
    });
    expect(merged.chartReferences.contract).toMatchObject({
      symbol: 'ESU26', freshness: { status: 'verified_live' }, spot: { value: 7652 },
    });
    expect(merged.resolverReference.spot.value).toBe(7652);

    const expired = sanitizeCachedSnapshot(merged, NOW + 30_001);
    expect(expired.chartReferences.basis.spot).toMatchObject({ status: 'unavailable', value: null });
    expect(expired.chartReferences.contract.spot).toMatchObject({ status: 'available', value: 7652 });
  });

  test('clears a rolled contract chart reference immediately while preserving the verified basis', () => {
    const basis = chartReference({ role: 'risk_range_basis', symbol: 'SPX', conId: 416904, value: 7634 });
    const contract = chartReference({ role: 'contract_reference', symbol: 'ESU26', conId: 12345, value: 7648 });
    const previousReferences = { basis, contract };
    const previousResolver = { ...contract, resolver: 'CME ESU26', chartReferences: previousReferences };
    const previousBase = fesSnapshot({
      spot: basis.spot, chart: basis.chart, chartReferences: previousReferences, resolverReference: previousResolver,
    });
    const previous = {
      ...previousBase,
      venues: { forecastex: { ...previousBase.venues.forecastex, reference: previousResolver } },
    };
    const rolledContract = chartReference({
      role: 'contract_reference', symbol: 'ESZ26', conId: 67890, value: null, status: 'refreshing',
    });
    const nextReferences = { basis, contract: rolledContract };
    const nextResolver = { ...rolledContract, resolver: 'CME ESZ26', chartReferences: nextReferences };
    const nextBase = fesSnapshot({
      sourceRefreshPending: true,
      spot: basis.spot,
      chart: basis.chart,
      chartReferences: nextReferences,
      resolverReference: nextResolver,
    });
    const next = {
      ...nextBase,
      venues: {
        forecastex: { ...nextBase.venues.forecastex, backgroundRefresh: true, reference: nextResolver },
      },
    };

    const merged = mergeProgressiveSnapshot(previous, next, NOW);
    expect(merged.chartReferences.basis.spot).toMatchObject({ status: 'available', value: 7634 });
    expect(merged.chartReferences.contract).toMatchObject({
      symbol: 'ESZ26', instrument: { conId: 67890 }, spot: { status: 'refreshing', value: null },
    });
    expect(merged.resolverReference.spot).toMatchObject({ status: 'refreshing', value: null });
  });

  test('retains a dated futures chart through a same-root generic loading shell', () => {
    const basis = chartReference({ role: 'risk_range_basis', symbol: 'SPX', conId: 416904, value: 7634 });
    const contract = {
      ...chartReference({ role: 'proxy_reference', symbol: 'GCZ6', conId: 12345, value: 4344 }),
      riskRangeTicker: 'GLD',
      instrument: { symbol: 'GC', displaySymbol: 'GCZ6', conId: 12345, provider: 'ibkr' },
    };
    const pendingContract = {
      ...chartReference({ role: 'proxy_reference', symbol: 'GC', conId: null, value: null, status: 'refreshing' }),
      riskRangeTicker: 'GLD',
      instrument: null,
    };
    const previousReferences = { basis, contract };
    const nextReferences = { basis, contract: pendingContract };
    const previous = snapshot({
      marketId: 'gold', sourceRefreshPending: false,
      spot: basis.spot, chart: basis.chart, chartReferences: previousReferences,
      resolverReference: { ...contract, chartReferences: previousReferences },
    });
    const next = snapshot({
      marketId: 'gold', sourceRefreshPending: true,
      spot: basis.spot, chart: basis.chart, chartReferences: nextReferences,
      resolverReference: { ...pendingContract, chartReferences: nextReferences },
    });

    const merged = mergeProgressiveSnapshot(previous, next, NOW);
    expect(merged.chartReferences.contract).toMatchObject({
      symbol: 'GCZ6',
      freshness: { status: 'delayed' },
      spot: { status: 'available', value: 4344, refreshRetained: true },
      chart: { status: 'available', refreshRetained: true },
    });
  });

  test('retains qualified WTI history when its earlier last-trade date differs from delivery month', () => {
    const basis = chartReference({ role: 'risk_range_basis', symbol: 'WTIC', conId: 304037496, value: 91.81 });
    const contract = {
      ...chartReference({ role: 'contract_reference', symbol: 'WBSV26', conId: 335874638, value: 92.04 }),
      riskRangeTicker: 'WTIC',
      instrument: {
        symbol: 'WTI',
        localSymbol: 'WTIV6',
        displaySymbol: 'WBSV26',
        conId: 335874638,
        contractMonth: '202610',
        lastTradeDateOrContractMonth: '20260921',
        provider: 'ibkr',
      },
    };
    const pendingContract = {
      ...chartReference({ role: 'contract_reference', symbol: 'WBSV26', conId: null, value: null, status: 'refreshing' }),
      riskRangeTicker: 'WTIC',
      instrument: {
        symbol: 'WTI',
        displaySymbol: 'WBSV26',
        contractMonth: '202610',
        lastTradeDateOrContractMonth: '202610',
        provider: 'ibkr',
      },
    };
    const previousReferences = { basis, contract };
    const nextReferences = { basis, contract: pendingContract };
    const previous = snapshot({
      marketId: 'wti', sourceRefreshPending: false,
      spot: basis.spot, chart: basis.chart, chartReferences: previousReferences,
      resolverReference: { ...contract, chartReferences: previousReferences },
    });
    const next = snapshot({
      marketId: 'wti', sourceRefreshPending: true,
      spot: basis.spot, chart: basis.chart, chartReferences: nextReferences,
      resolverReference: { ...pendingContract, chartReferences: nextReferences },
    });

    const merged = mergeProgressiveSnapshot(previous, next, NOW);
    expect(merged.chartReferences.contract).toMatchObject({
      symbol: 'WBSV26',
      instrument: { localSymbol: 'WTIV6', conId: 335874638, contractMonth: '202610' },
      freshness: { status: 'delayed' },
      spot: { status: 'available', value: 92.04, refreshRetained: true },
      chart: { status: 'available', refreshRetained: true },
    });
  });

  test('keeps each Gold reference visible while only that reference is loading', () => {
    const references = goldHeaderReferences();
    const previous = snapshot({ marketId: 'gold', goldMarketReferences: references });

    for (const key of ['selectedResolver', 'xauusd', 'activeComex']) {
      const pendingReferences = references.map((reference) => reference.key === key ? {
        ...reference,
        status: 'loading',
        price: null,
        previousClose: null,
        changePercent: null,
        source: null,
        asOf: null,
        expiresAt: null,
        reason: `${reference.symbol} is loading.`,
      } : reference);
      const merged = mergeProgressiveSnapshot(previous, snapshot({
        marketId: 'gold', sourceRefreshPending: true, goldMarketReferences: pendingReferences,
      }), NOW);
      expect(merged.goldMarketReferences.find((reference) => reference.key === key)).toMatchObject({
        status: 'delayed',
        retainedStatus: references.find((reference) => reference.key === key).status,
        price: references.find((reference) => reference.key === key).price,
        displayOnly: true,
        executable: false,
        refreshPending: true,
        refreshRetained: true,
      });
      expect(merged.goldMarketReferences.filter((reference) => reference.price != null)).toHaveLength(3);
    }
  });

  test('clears delayed Gold references on expiry, confirmed disconnect, and a COMEX contract roll', () => {
    const references = goldHeaderReferences();
    const previous = snapshot({ marketId: 'gold', goldMarketReferences: references });
    const loadingXau = references.map((reference) => reference.key === 'xauusd' ? {
      ...reference, status: 'loading', price: null, source: null, asOf: null, expiresAt: null,
      reason: 'XAUUSD is loading.',
    } : reference);
    const delayed = mergeProgressiveSnapshot(previous, snapshot({
      marketId: 'gold', sourceRefreshPending: true, goldMarketReferences: loadingXau,
    }), NOW);
    const expired = sanitizeCachedSnapshot(delayed, NOW + (10 * 60_000));
    expect(expired.goldMarketReferences.find((reference) => reference.key === 'xauusd')).toMatchObject({
      status: 'unavailable', price: null, source: null, asOf: null,
    });

    const disconnectedReferences = references.map((reference) => reference.key === 'xauusd' ? {
      ...reference, status: 'unavailable', price: null, source: null, asOf: null, expiresAt: null,
      reason: 'IBKR disconnected.',
    } : reference);
    const disconnected = mergeProgressiveSnapshot(previous, snapshot({
      marketId: 'gold', sourceRefreshPending: false, goldMarketReferences: disconnectedReferences,
    }), NOW);
    expect(disconnected.goldMarketReferences.find((reference) => reference.key === 'xauusd')).toMatchObject({
      status: 'unavailable', price: null, reason: 'IBKR disconnected.',
    });

    const rolledReferences = references.map((reference) => reference.key === 'activeComex' ? {
      ...reference,
      symbol: 'GCG27',
      instrument: { ...reference.instrument, displaySymbol: 'GCG27', conId: 67890, contractMonth: '202702' },
      status: 'loading', price: null, source: null, asOf: null,
      reason: 'The new active COMEX contract is loading.',
    } : reference);
    const rolled = mergeProgressiveSnapshot(previous, snapshot({
      marketId: 'gold', sourceRefreshPending: true, goldMarketReferences: rolledReferences,
    }), NOW);
    expect(rolled.goldMarketReferences.find((reference) => reference.key === 'activeComex')).toMatchObject({
      symbol: 'GCG27', status: 'loading', price: null,
    });
  });

  test('keeps a never-loaded Gold reference labeled loading instead of falsely expiring it', () => {
    const loading = {
      key: 'activeComex', label: 'COMEX GOLD', symbol: 'GC', role: 'proxy',
      status: 'loading', price: null, previousClose: null, source: null,
      asOf: null, expiresAt: null, reason: 'The active COMEX reference is loading.',
    };
    const sanitized = sanitizeCachedSnapshot(snapshot({
      marketId: 'gold', goldMarketReferences: [loading],
    }), NOW);

    expect(sanitized.goldMarketReferences[0]).toEqual(loading);
  });

  test('retains a verified chart while pending but clears it after an explicit source failure', () => {
    const previous = snapshot({
      chart: {
        status: 'historical', availability: 'historical', source: 'ibkr_historical_bars',
        asOf: new Date(LAST_COMPLETED_AT).toISOString(), latestAt: new Date(LAST_COMPLETED_AT).toISOString(),
        historicalThroughDate: LAST_COMPLETED_SESSION, expiresAt: new Date(NOW + 60_000).toISOString(),
        points: [{ timestamp: LAST_COMPLETED_AT - 60_000, value: 84.1 }, { timestamp: LAST_COMPLETED_AT, value: 84.4 }],
      },
    });
    const pending = snapshot({
      chart: {
        status: 'refreshing', availability: 'unavailable', source: null, asOf: null, expiresAt: null,
        points: [], reason: 'WTI chart is refreshing.',
      },
    });
    const retained = mergeProgressiveSnapshot(previous, pending, NOW);
    expect(retained.chart).toMatchObject({
      status: 'historical', refreshing: false, refreshPending: true, refreshRetained: true,
      points: [{ value: 84.1 }, { value: 84.4 }],
    });

    const datedFailure = mergeProgressiveSnapshot(previous, snapshot({
      chart: {
        status: 'unavailable', availability: 'unavailable', source: null, asOf: null, expiresAt: null,
        points: [], refreshFailed: true, refreshIssue: 'IBKR disconnected',
      },
    }), NOW);
    expect(datedFailure.chart).toMatchObject({
      status: 'unavailable', refreshFailed: true, points: [], refreshIssue: 'IBKR disconnected',
    });

    const livePrevious = snapshot({
      chart: {
        status: 'available', availability: 'live', source: 'ibkr_historical_bars',
        asOf: new Date(NOW - 1_000).toISOString(), expiresAt: new Date(NOW + 60_000).toISOString(),
        points: [{ timestamp: NOW - 1_000, value: 84.4 }],
      },
    });
    const liveFailure = mergeProgressiveSnapshot(livePrevious, snapshot({
      chart: {
        status: 'unavailable', availability: 'unavailable', source: null, asOf: null, expiresAt: null,
        points: [], refreshFailed: true, refreshIssue: 'IBKR disconnected',
      },
    }), NOW);
    expect(liveFailure.chart).toMatchObject({ status: 'unavailable', refreshFailed: true, points: [] });
  });

  test('never retains a failed SP500 chart refresh, including dated historical bars', () => {
    const previous = snapshot({
      marketId: 'sp500',
      chart: {
        status: 'historical', availability: 'historical', source: 'ibkr_historical_bars',
        asOf: new Date(LAST_COMPLETED_AT).toISOString(), latestAt: new Date(LAST_COMPLETED_AT).toISOString(),
        historicalThroughDate: LAST_COMPLETED_SESSION, expiresAt: new Date(NOW + 60_000).toISOString(),
        points: [{ timestamp: LAST_COMPLETED_AT - 60_000, value: 7700 }, { timestamp: LAST_COMPLETED_AT, value: 7710 }],
      },
    });
    const failed = snapshot({
      marketId: 'sp500',
      chart: {
        status: 'unavailable', availability: 'unavailable', source: null, asOf: null, expiresAt: null,
        points: [], refreshFailed: true, refreshIssue: 'IBKR history failed',
      },
    });

    expect(mergeProgressiveSnapshot(previous, failed, NOW).chart).toMatchObject({
      status: 'unavailable',
      points: [],
      refreshIssue: 'IBKR history failed',
    });
  });

  test('keeps all verified SP500 chart variants visible while their next refresh is pending', () => {
    const oneDay = {
      status: 'available', availability: 'current', source: 'ibkr_historical_bars', range: '1d',
      asOf: new Date(NOW).toISOString(), expiresAt: new Date(NOW + 60_000).toISOString(),
      points: [{ timestamp: NOW - 60_000, value: 7700 }, { timestamp: NOW, value: 7710 }],
    };
    const fiveDay = {
      status: 'historical', availability: 'historical', source: 'ibkr_historical_bars', range: '5d',
      asOf: new Date(LAST_COMPLETED_AT).toISOString(), latestAt: new Date(LAST_COMPLETED_AT).toISOString(),
      historicalThroughDate: LAST_COMPLETED_SESSION, expiresAt: null,
      points: [{ timestamp: LAST_COMPLETED_AT - 120_000, value: 7680 }, { timestamp: LAST_COMPLETED_AT, value: 7700 }],
      dailyRanges: [], rangeDates: [],
    };
    const tenDay = { ...fiveDay, range: '10d' };
    const pendingVariant = (range) => ({
      status: 'refreshing', refreshing: true, availability: 'unavailable', source: null,
      expiresAt: null, range, points: [], dailyRanges: [], rangeDates: [],
    });
    const previous = snapshot({
      marketId: 'sp500',
      chart: { ...oneDay, variants: { '1d': oneDay, '5d': fiveDay, '10d': tenDay } },
    });
    const pending = snapshot({
      marketId: 'sp500',
      chart: {
        ...pendingVariant('1d'),
        variants: { '1d': pendingVariant('1d'), '5d': pendingVariant('5d'), '10d': pendingVariant('10d') },
      },
    });

    const result = mergeProgressiveSnapshot(previous, pending, NOW);

    expect(result.chart).toMatchObject({
      status: 'available', refreshing: false, refreshPending: true, refreshRetained: true,
      points: [{ value: 7700 }, { value: 7710 }],
      variants: {
        '1d': { status: 'available', refreshing: false, refreshPending: true, refreshRetained: true, points: [{ value: 7700 }, { value: 7710 }] },
        '5d': { status: 'historical', refreshing: false, refreshPending: true, refreshRetained: true, points: [{ value: 7680 }, { value: 7700 }] },
        '10d': { status: 'historical', refreshing: false, refreshPending: true, refreshRetained: true, points: [{ value: 7680 }, { value: 7700 }] },
      },
    });
  });

  test('keeps a verified ATH on every fresh chart variant while only ATH history is pending', () => {
    const ath = {
      status: 'available',
      source: 'ibkr_historical_record',
      asOf: new Date(NOW).toISOString(),
      value: 7_816.7,
      date: '2026-08-13',
      baseline: {
        value: 7_816.7,
        date: '2026-08-13',
        throughDate: '2026-08-19',
        source: 'ibkr',
        dataset: 'historical_record',
        coverageComplete: true,
        coverageStart: '1927-12-30',
        coverageEnd: '2026-08-19',
      },
      markers: [],
      reason: null,
    };
    const loadingAth = {
      status: 'loading', source: null, baseline: null, markers: [], reason: 'Checking verified ATH history.',
    };
    const chart = (value, chartAth) => {
      const variant = (range) => ({
        status: 'available', availability: 'current', source: 'ibkr_historical_bars', range,
        asOf: new Date(NOW).toISOString(), latestAt: new Date(NOW).toISOString(),
        latestValue: value, expiresAt: new Date(NOW + 60_000).toISOString(),
        points: [{ timestamp: NOW - 60_000, value: value - 1 }, { timestamp: NOW, value }],
        ath: chartAth,
      });
      const oneDay = variant('1d');
      return {
        ...oneDay,
        variants: { '1d': oneDay, '5d': variant('5d'), '10d': variant('10d') },
      };
    };
    const previous = snapshot({ marketId: 'sp500', chart: chart(7_700, ath) });
    const pending = snapshot({
      marketId: 'sp500',
      sourceRefreshPending: true,
      chart: chart(7_710, loadingAth),
    });

    const result = mergeProgressiveSnapshot(previous, pending, NOW);

    expect(result.chart.latestValue).toBe(7_710);
    ['1d', '5d', '10d'].forEach((range) => {
      expect(result.chart.variants[range].ath).toMatchObject({
        status: 'available',
        value: 7_816.7,
        refreshPending: true,
        refreshRetained: true,
      });
    });
    expect(result.chart.ath).toEqual(result.chart.variants['1d'].ath);

    const unavailableAth = {
      status: 'unavailable', source: null, baseline: null, markers: [], reason: 'ATH history failed.',
    };
    const failed = mergeProgressiveSnapshot(previous, snapshot({
      marketId: 'sp500',
      sourceRefreshPending: false,
      chart: chart(7_710, unavailableAth),
    }), NOW);
    expect(failed.chart.variants['1d'].ath).toEqual(unavailableAth);
  });

  test.each([['bitcoin', 'KXBTCD'], ['ethereum', 'KXETHD']])('publishes newer verified %s spot and chart data while secondary reference context is pending', (marketId, seriesTicker) => {
    const liveSpot = (value, observedAt) => ({
      status: 'available', availability: 'live', fit: 'proxy', value,
      source: 'coinbase_exchange_public_ticker', asOf: new Date(observedAt).toISOString(),
      expiresAt: new Date(observedAt + 60_000).toISOString(), executable: false,
    });
    const liveChart = (value, observedAt) => {
      const variant = {
        status: 'available', availability: 'live', fit: 'proxy', range: '1d',
        source: 'coinbase_exchange_public_candles', asOf: new Date(observedAt).toISOString(),
        latestAt: new Date(observedAt).toISOString(), latestValue: value,
        expiresAt: new Date(observedAt + 10 * 60_000).toISOString(),
        points: [
          { timestamp: observedAt - 60_000, value: value - 25 },
          { timestamp: observedAt, value },
        ],
      };
      return {
        ...variant,
        variants: {
          '1d': { ...variant },
          '5d': { ...variant, range: '5d' },
          '10d': { ...variant, range: '10d' },
        },
      };
    };
    const priorSpot = liveSpot(78_500, NOW - 20_000);
    const priorChart = liveChart(78_500, NOW - 20_000);
    const nextSpot = liveSpot(78_850, NOW);
    const nextChart = liveChart(78_850, NOW);
    const priorReference = { status: 'available', fit: 'proxy', spot: priorSpot, chart: priorChart };
    const nextReference = {
      status: 'available', fit: 'proxy', spot: nextSpot, chart: nextChart,
      backgroundRefresh: true,
    };
    const base = snapshot();
    const previous = snapshot({
      marketId, spot: priorSpot, chart: priorChart, resolverReference: priorReference,
      selection: { requestedVenue: 'auto', requestedGenerationId: null },
      venues: {
        kalshi: {
          ...base.venues.kalshi,
          generationId: `${seriesTicker}-26AUG1912`,
          generationKey: `${seriesTicker}-26AUG1912`,
          reference: priorReference,
        },
      },
    });
    const next = snapshot({
      marketId, sourceRefreshPending: true,
      spot: nextSpot, chart: nextChart, resolverReference: nextReference,
      selection: { requestedVenue: 'auto', requestedGenerationId: null },
      venues: {
        kalshi: {
          ...base.venues.kalshi,
          generationId: `${seriesTicker}-26AUG1912`,
          generationKey: `${seriesTicker}-26AUG1912`,
          reference: nextReference,
          backgroundRefresh: true,
        },
      },
    });

    const result = mergeProgressiveSnapshot(previous, next, NOW);

    expect(result.spot).toMatchObject({
      status: 'available', value: 78_850, refreshPending: true, refreshRetained: true,
    });
    expect(result.chart).toMatchObject({
      status: 'available', latestValue: 78_850, refreshPending: true, refreshRetained: true,
      points: [{ value: 78_825 }, { value: 78_850 }],
      variants: {
        '1d': { latestValue: 78_850, refreshPending: true, refreshRetained: true },
        '5d': { latestValue: 78_850, refreshPending: true, refreshRetained: true },
        '10d': { latestValue: 78_850, refreshPending: true, refreshRetained: true },
      },
    });
    expect(result.resolverReference.spot.value).toBe(78_850);
  });

  test('keeps verified same-date Risk Range overlays attached during a partial history refresh', () => {
    const range = (date, available = true) => ({
      date,
      startAt: Date.parse(`${date}T14:30:00.000Z`),
      endAt: Date.parse(`${date}T19:55:00.000Z`),
      status: available ? 'available' : 'unavailable',
      references: available ? [
        { status: 'available', label: 'LRR', value: 70, source: 'RiskRangeData', asOf: date },
        { status: 'available', label: 'HRR', value: 80, source: 'RiskRangeData', asOf: date },
      ] : [],
      reason: available ? null : `Exact-date Risk Range data is unavailable for ${date}.`,
    });
    const chartVariant = (chartRange, available = true) => ({
      status: 'historical', availability: 'historical', source: 'ibkr_historical_bars', range: chartRange,
      asOf: new Date(LAST_COMPLETED_AT).toISOString(), latestAt: new Date(LAST_COMPLETED_AT).toISOString(),
      historicalThroughDate: LAST_COMPLETED_SESSION, expiresAt: null,
      points: [{ timestamp: LAST_COMPLETED_AT - 60_000, value: 75 }, { timestamp: LAST_COMPLETED_AT, value: 76 }],
      rangeDates: [LAST_COMPLETED_SESSION],
      dailyRanges: [range(LAST_COMPLETED_SESSION, available)],
      riskRangeStatus: available ? 'available' : 'partial',
      riskRangeMissingDates: available ? [] : [LAST_COMPLETED_SESSION],
      ...(available ? {} : { riskRangeRefreshPending: true }),
    });
    const priorOneDay = chartVariant('1d');
    const previous = snapshot({
      chart: {
        ...priorOneDay,
        variants: {
          '1d': priorOneDay,
          '5d': chartVariant('5d'),
          '10d': chartVariant('10d'),
        },
      },
    });
    const nextOneDay = chartVariant('1d', false);
    const next = snapshot({
      sourceRefreshPending: true,
      chart: {
        ...nextOneDay,
        variants: {
          '1d': nextOneDay,
          '5d': chartVariant('5d', false),
          '10d': chartVariant('10d', false),
        },
      },
    });

    const result = mergeProgressiveSnapshot(previous, next, NOW);

    expect(result.chart).toMatchObject({
      riskRangeStatus: 'available',
      riskRangeRefreshPending: true,
      riskRangeRefreshRetained: true,
      dailyRanges: [expect.objectContaining({
        date: LAST_COMPLETED_SESSION,
        status: 'available',
        refreshPending: true,
        refreshRetained: true,
      })],
      variants: {
        '1d': { riskRangeStatus: 'available' },
        '5d': { riskRangeStatus: 'available' },
        '10d': { riskRangeStatus: 'available' },
      },
    });
  });

  test.each(['bitcoin', 'ethereum'].flatMap((marketId) => [
    [marketId, '2026-08-15', '2026-08-14', true],
    [marketId, '2026-09-07', '2026-09-04', true],
    [marketId, '2026-07-03', '2026-07-02', true],
    [marketId, '2026-09-05', '2026-09-03', false],
    [marketId, '2026-09-07', '2026-09-03', false],
    [marketId, '2026-09-08', '2026-09-04', false],
  ]))('validates %s carry on %s from publication %s during a history refresh', (marketId, weekendDate, publicationDate, expectedAvailable) => {
    const availableRange = {
      date: weekendDate,
      startAt: Date.parse(`${weekendDate}T00:00:00.000Z`),
      endAt: Date.parse(`${weekendDate}T23:00:00.000Z`),
      status: 'available',
      riskRangePublicationDate: publicationDate,
      riskRangeCarryForward: 'last_published_non_publication_session',
      references: [
        {
          status: 'available', label: 'LRR', value: 70000, source: 'RiskRangeData',
          asOf: publicationDate, publicationDate, effectiveDate: weekendDate, carriedForward: true,
        },
        {
          status: 'available', label: 'HRR', value: 82000, source: 'RiskRangeData',
          asOf: publicationDate, publicationDate, effectiveDate: weekendDate, carriedForward: true,
        },
      ],
      reason: null,
    };
    const unavailableRange = {
      date: weekendDate,
      startAt: availableRange.startAt,
      endAt: availableRange.endAt,
      status: 'unavailable',
      references: [],
      reason: `Exact-date Risk Range data is unavailable for ${weekendDate}.`,
    };
    const variant = (range, dailyRange, pending = false) => ({
      status: 'historical', availability: 'historical', source: 'coinbase_exchange_public_candles',
      range, asOf: new Date(LAST_COMPLETED_AT).toISOString(), latestAt: new Date(LAST_COMPLETED_AT).toISOString(),
      historicalThroughDate: LAST_COMPLETED_SESSION, expiresAt: null,
      points: [{ timestamp: LAST_COMPLETED_AT - 60_000, value: 79000 }, { timestamp: LAST_COMPLETED_AT, value: 79100 }],
      rangeDates: [weekendDate], dailyRanges: [dailyRange],
      riskRangeStatus: pending ? 'partial' : 'available',
      riskRangeMissingDates: pending ? [weekendDate] : [],
      ...(pending ? { riskRangeRefreshPending: true } : {}),
    });
    const previousOneDay = variant('1d', availableRange);
    const nextOneDay = variant('1d', unavailableRange, true);
    const previous = snapshot({
      marketId,
      chart: {
        ...previousOneDay,
        variants: {
          '1d': previousOneDay,
          '5d': variant('5d', availableRange),
          '10d': variant('10d', availableRange),
        },
      },
    });
    const next = snapshot({
      marketId,
      sourceRefreshPending: true,
      chart: {
        ...nextOneDay,
        variants: {
          '1d': nextOneDay,
          '5d': variant('5d', unavailableRange, true),
          '10d': variant('10d', unavailableRange, true),
        },
      },
    });

    const result = mergeProgressiveSnapshot(previous, next, NOW);

    const expectedRange = expectedAvailable ? {
      date: weekendDate, status: 'available',
      riskRangePublicationDate: publicationDate,
      riskRangeCarryForward: 'last_published_non_publication_session',
      refreshRetained: true,
    } : { date: weekendDate, status: 'unavailable', references: [] };
    expect(result.chart.variants['10d'].dailyRanges).toEqual([expect.objectContaining(expectedRange)]);
    expect(result.chart.variants['10d'].dailyRanges[0].refreshRetained === true).toBe(expectedAvailable);
    expect(result.chart.variants['10d']).toMatchObject({
      riskRangeStatus: expectedAvailable ? 'available' : 'partial',
      riskRangeMissingDates: expectedAvailable ? [] : [weekendDate],
      riskRangeRefreshPending: true,
      ...(expectedAvailable ? { riskRangeRefreshRetained: true } : {}),
    });
  });

  test('keeps a terminal resolver failure terminal while an unrelated monitor refresh is pending', () => {
    const base = snapshot();
    const terminalVariant = (range) => ({
      status: 'unavailable', availability: 'unavailable', range,
      source: null, asOf: null, expiresAt: null, points: [], references: [],
      rangeDates: [], dailyRanges: [], refreshFailed: true,
      errorCode: 'PYTH_ENTITLEMENT_REQUIRED', reason: 'Exact Pyth history requires entitlement.',
    });
    const oneDay = terminalVariant('1d');
    const terminalChart = {
      ...oneDay,
      variants: {
        '1d': oneDay,
        '5d': terminalVariant('5d'),
        '10d': terminalVariant('10d'),
      },
    };
    const terminalSpot = {
      status: 'unavailable', availability: 'unavailable', value: null,
      source: null, asOf: null, expiresAt: null, refreshFailed: true,
      errorCode: 'PYTH_ENTITLEMENT_REQUIRED', reason: 'Exact Pyth price requires entitlement.',
    };
    const reference = { status: 'unavailable', spot: terminalSpot, chart: terminalChart, fit: 'exact' };
    const current = snapshot({
      spot: terminalSpot,
      chart: terminalChart,
      resolverReference: reference,
      venues: {
        kalshi: { ...base.venues.kalshi, reference },
      },
    });

    const refreshing = clearLiveTradingSnapshot(current, 'Monitor refresh is in progress.', { nowMs: NOW });
    expect(refreshing.spot).toMatchObject({
      status: 'unavailable', errorCode: 'PYTH_ENTITLEMENT_REQUIRED',
    });
    expect(refreshing.spot.refreshing).not.toBe(true);
    expect(refreshing.chart.variants).toMatchObject({
      '1d': { status: 'unavailable', errorCode: 'PYTH_ENTITLEMENT_REQUIRED' },
      '5d': { status: 'unavailable', errorCode: 'PYTH_ENTITLEMENT_REQUIRED' },
      '10d': { status: 'unavailable', errorCode: 'PYTH_ENTITLEMENT_REQUIRED' },
    });
    expect(refreshing.resolverReference.chart).toBe(terminalChart);
  });

  test.each([
    ['expired', {
      status: 'available', availability: 'current', source: 'ibkr_historical_bars',
      expiresAt: new Date(NOW - 1).toISOString(),
    }],
    ['cache-derived', {
      status: 'available', availability: 'current', source: 'ibkr_chart_cache',
      expiresAt: new Date(NOW + 60_000).toISOString(), fromCache: true,
    }],
  ])('does not retain a %s chart during refresh', (_label, unsafeFields) => {
    const previous = snapshot({
      chart: {
        ...unsafeFields,
        points: [{ timestamp: NOW - 60_000, value: 7700 }, { timestamp: NOW, value: 7710 }],
      },
    });
    const pending = snapshot({
      chart: {
        status: 'refreshing', refreshing: true, availability: 'unavailable', source: null,
        expiresAt: null, points: [], reason: 'Chart refresh is pending.',
      },
    });

    expect(mergeProgressiveSnapshot(previous, pending, NOW).chart).toMatchObject({
      status: 'refreshing',
      points: [],
    });
  });

  test('keeps a whole-refresh error visible during retries until one succeeds', async () => {
    const retry = deferred();
    const monitorService = {
      getSnapshot: jest.fn()
        .mockResolvedValueOnce(snapshot())
        .mockRejectedValueOnce(new Error('monitor transport failed'))
        .mockImplementationOnce(() => retry.promise),
    };
    const coordinator = createMarketMonitorCoordinator({
      monitorService, marketIds: ['wti'], now: () => new Date(NOW), logger: { error: jest.fn() },
    });

    await coordinator.refresh('wti');
    await coordinator.refresh('wti');
    expect(coordinator.getSnapshot('wti').refresh).toMatchObject({
      state: 'error', lastError: { message: 'monitor transport failed' },
    });

    const pendingRetry = coordinator.refresh('wti');
    expect(coordinator.getSnapshot('wti').refresh).toMatchObject({
      state: 'refreshing', lastError: { message: 'monitor transport failed' },
    });
    retry.resolve(snapshot());
    await pendingRetry;
    expect(coordinator.getSnapshot('wti').refresh).toMatchObject({ state: 'idle', lastError: null });
  });

  test('retains completed SP500 history when an unrelated whole refresh rejects', async () => {
    const prior = snapshot({
      marketId: 'sp500',
      chart: {
        status: 'available', availability: 'current', source: 'ibkr_historical_bars',
        asOf: new Date(NOW).toISOString(), expiresAt: new Date(NOW + 60_000).toISOString(),
        range: '1d', points: [{ timestamp: NOW - 60_000, value: 7700 }, { timestamp: NOW, value: 7710 }],
      },
    });
    const monitorService = {
      getSnapshot: jest.fn()
        .mockResolvedValueOnce(prior)
        .mockRejectedValueOnce(new Error('SPX refresh transport failure')),
    };
    const coordinator = createMarketMonitorCoordinator({
      monitorService, marketIds: ['sp500'], now: () => new Date(NOW), logger: { error: jest.fn() },
    });

    await coordinator.refresh('sp500');
    await coordinator.refresh('sp500');
    const result = coordinator.getSnapshot('sp500');

    expect(result.chart).toMatchObject({
      status: 'available',
      points: [{ timestamp: NOW - 60_000, value: 7700 }, { timestamp: NOW, value: 7710 }],
      variants: {
        '1d': { status: 'available', points: [{ timestamp: NOW - 60_000, value: 7700 }, { timestamp: NOW, value: 7710 }] },
        '5d': { status: 'unavailable', points: [] },
        '10d': { status: 'unavailable', points: [] },
      },
    });
    expect(result.refresh).toMatchObject({
      state: 'error',
      lastError: { code: 'PM_MONITOR_REFRESH_FAILED', message: 'SPX refresh transport failure' },
    });
  });

  test('retains a still-open public catalog after a localized refresh miss but clears its live book', () => {
    const previous = snapshot();
    const missing = snapshot({
      venues: {
        kalshi: {
          ...previous.venues.kalshi,
          catalog: {
            status: 'unavailable', source: null, asOf: null, expiresAt: null,
            event: null, lines: [], reason: 'Kalshi catalog refresh failed.',
          },
          book: {
            status: 'unavailable', source: null, asOf: null, expiresAt: null,
            event: previous.venues.kalshi.catalog.event, lines: [], reason: 'Kalshi disconnected.',
          },
          contracts: {
            status: 'unavailable', source: null, asOf: null, expiresAt: null,
            event: previous.venues.kalshi.catalog.event, lines: [], reason: 'Kalshi disconnected.',
          },
        },
      },
    });
    const retained = mergeProgressiveSnapshot(previous, missing, NOW);
    expect(retained.venues.kalshi.catalog).toMatchObject({
      status: 'available', refreshRetained: true, refreshFailed: true,
      refreshIssue: 'Kalshi catalog refresh failed.',
    });
    expect(retained.venues.kalshi.catalog.lines).toHaveLength(1);
    expect(retained.venues.kalshi.book).toMatchObject({ status: 'unavailable', lines: [] });
  });
});
