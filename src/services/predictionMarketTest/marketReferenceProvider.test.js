const {
  GOLD_SPOT_PROXY_INSTRUMENT,
  NDX_INSTRUMENT,
  brentIbkrInstrument,
  createMarketReferenceProvider,
  goldReferenceItem,
  loadPythReference,
  normalizeLiveQuote,
  pythReferenceConfig,
  retainVerifiedChartWhileRefreshing,
} = require('./marketReferenceProvider.cjs');

const NOW = Date.parse('2026-08-19T16:00:00.000Z');
const AS_OF = '2026-08-19T15:59:40.000Z';
const TEN_EXCHANGE_DATES = ['2026-08-06', '2026-08-07', '2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13', '2026-08-14', '2026-08-17', '2026-08-18', '2026-08-19'];

function sessionBars(dates = TEN_EXCHANGE_DATES, base = 100) {
  return dates.flatMap((date, index) => [
    { date: Date.parse(`${date}T14:30:00.000Z`), close: base + index },
    { date: date === dates[dates.length - 1] ? NOW - 60_000 : Date.parse(`${date}T17:20:00.000Z`), close: base + index + 0.5 },
  ]);
}

function completedSessionBars(dates, base = 100) {
  return dates.flatMap((date, index) => [
    { date: Date.parse(`${date}T14:30:00.000Z`), close: base + index },
    { date: Date.parse(`${date}T17:20:00.000Z`), close: base + index + 0.5 },
  ]);
}

function goldHourlySessionBars(dates, base = 4_390) {
  return dates.flatMap((date, index) => {
    const priorDate = new Date(Date.parse(`${date}T12:00:00.000Z`) - (24 * 60 * 60_000))
      .toISOString().slice(0, 10);
    return [
      ...[22, 23].map((hour, offset) => ({
        date: Date.parse(`${priorDate}T${hour}:00:00.000Z`),
        close: base + index + (offset * 0.01),
      })),
      ...Array.from({ length: 21 }, (_, hour) => ({
        date: Date.parse(`${date}T${String(hour).padStart(2, '0')}:00:00.000Z`),
        close: base + index + 0.02 + (hour * 0.01),
      })),
    ];
  });
}

function recentWeekdays(count, throughDate = '2026-08-19') {
  const dates = [];
  let cursor = Date.parse(`${throughDate}T12:00:00.000Z`);
  while (dates.length < count) {
    const date = new Date(cursor);
    const weekday = date.getUTCDay();
    if (weekday > 0 && weekday < 6) dates.push(date.toISOString().slice(0, 10));
    cursor -= 24 * 60 * 60_000;
  }
  return dates.reverse();
}

function proxyFitRiskRanges(ticker, dates, proxyBase = 101) {
  return {
    status: 'available',
    source: 'RiskRangeData',
    ticker,
    ranges: Object.fromEntries(dates.map((date, index) => {
      const priorProxyClose = proxyBase + Math.max(0, index - 1);
      return [date, {
        ticker,
        date,
        lrr: priorProxyClose * 0.9,
        hrr: priorProxyClose * 1.1,
        previousClose: priorProxyClose / 1.01,
        source: 'RiskRangeData',
        asOf: date,
      }];
    })),
    missingDates: [],
    reason: null,
  };
}

function exactRiskRanges(ticker, dates) {
  return {
    status: 'available',
    source: 'RiskRangeData',
    ticker,
    ranges: Object.fromEntries(dates.map((date, index) => [date, {
      ticker, date, lrr: 80 + index, hrr: 120 + index, source: 'RiskRangeData', asOf: date,
    }])),
    missingDates: [],
    reason: null,
  };
}

function canonicalQuote(overrides = {}) {
  return {
    canonical: {
      valid: true,
      source: 'ibkr',
      dataType: 'live',
      timestamp: AS_OF,
      mark: 27_850.25,
      last: 27_850.25,
      warning: null,
      ...overrides,
    },
  };
}

function history(overrides = {}) {
  return {
    source: 'ibkr',
    bars: [
      { date: NOW - 5 * 60_000, close: 27_840 },
      { date: NOW - 60_000, close: 27_850 },
    ],
    ...overrides,
  };
}

function ibkr(overrides = {}) {
  const historicalImpl = overrides.getHistoricalBars || (async () => history());
  const { getHistoricalBars: _ignoredHistorical, ...rest } = overrides;
  return {
    getProviderStatus: jest.fn(async () => ({ connected: true, status: 'connected' })),
    getQuote: jest.fn(async () => canonicalQuote()),
    getHistoricalRecord: jest.fn(async (_instrument, throughDate) => ({
      status: 'available',
      source: 'ibkr',
      dataset: 'historical_record',
      asOf: AS_OF,
      throughDate,
      recordHigh: 29_000,
      recordDate: '2026-08-10',
      coverage: {
        complete: true,
        startDate: '2000-01-03',
        endDate: throughDate,
        headDate: '2000-01-03',
        chunks: 12,
        observations: 5_000,
      },
      reason: null,
    })),
    getHistoricalBars: jest.fn(async (...args) => {
      const [instrument] = args;
      const result = await historicalImpl(...args);
      if (!['FUT', 'CMDTY'].includes(instrument?.secType) || result?.source !== 'ibkr') return result;
      const exactWti = instrument.symbol === 'WTI'
        && (instrument.contractMonth === '202610'
          || instrument.lastTradeDateOrContractMonth === '202610'
          || instrument.localSymbol === 'WTIV6');
      return {
        ...result,
        contract: result.contract || {
          conId: instrument.conId || (exactWti ? 2001 : undefined),
          symbol: instrument.symbol,
          localSymbol: exactWti ? 'WTIV6' : instrument.localSymbol || instrument.displaySymbol,
          lastTradeDateOrContractMonth: exactWti
            ? '20260921' : instrument.lastTradeDateOrContractMonth,
          exchange: instrument.exchange,
          currency: instrument.currency,
          multiplier: instrument.multiplier,
          tradingClass: instrument.tradingClass || instrument.symbol,
          secType: instrument.secType,
          provider: 'ibkr',
        },
      };
    }),
    ...rest,
  };
}

const TEST_DIRECTIONAL_INSTRUMENTS = Object.freeze({
  sp500: Object.freeze({ symbol: 'ES', ibkrSymbol: 'ES', displaySymbol: 'ESU26', localSymbol: 'ESU26', conId: 1001, secType: 'FUT', exchange: 'CME', currency: 'USD', multiplier: '50', lastTradeDateOrContractMonth: '20260918', provider: 'ibkr' }),
  wti: Object.freeze({ symbol: 'CL', ibkrSymbol: 'CL', displaySymbol: 'CLV26', localSymbol: 'CLV6', conId: 1002, secType: 'FUT', exchange: 'NYMEX', currency: 'USD', multiplier: '1000', contractMonth: '202610', lastTradeDate: '20260922', lastTradeDateOrContractMonth: '20260922', provider: 'ibkr' }),
  gold: Object.freeze({ symbol: 'GC', ibkrSymbol: 'GC', displaySymbol: 'GCZ26', localSymbol: 'GCZ26', conId: 1003, secType: 'FUT', exchange: 'COMEX', currency: 'USD', multiplier: '100', lastTradeDateOrContractMonth: '20261125', provider: 'ibkr' }),
  silver: Object.freeze({ symbol: 'SI', ibkrSymbol: 'SI', displaySymbol: 'SIZ26', localSymbol: 'SIZ26', conId: 1004, secType: 'FUT', exchange: 'COMEX', currency: 'USD', multiplier: '5000', lastTradeDateOrContractMonth: '20261229', provider: 'ibkr' }),
  brent: Object.freeze({ symbol: 'BZ', ibkrSymbol: 'BZ', displaySymbol: 'BZX26', localSymbol: 'BZX6', conId: 1005, secType: 'FUT', exchange: 'NYMEX', currency: 'USD', multiplier: '1000', contractMonth: '202611', lastTradeDate: '20260930', lastTradeDateOrContractMonth: '20260930', provider: 'ibkr' }),
});

function createReferenceProvider(options = {}) {
  return createMarketReferenceProvider({
    loadRiskRangeHistory: async ({ ticker, dates }) => ({
      status: 'unavailable',
      source: 'RiskRangeData',
      ticker,
      ranges: {},
      missingDates: dates,
      reason: 'Test Risk Range history is unavailable.',
    }),
    loadDirectionalSelection: async (marketId) => ({
      instrument: TEST_DIRECTIONAL_INSTRUMENTS[marketId],
      rollReason: 'test_verified_selection',
      refreshPending: false,
    }),
    ...options,
  });
}

function wtiSelection() {
  const rulesSecondary = 'Settlement is based on the nearest listed contract month, rolling forward. The settlement value is rounded to the nearest 2 decimal places.';
  const market = (strike) => ({
    ticker: `KXWTI-26AUG2014-T${strike}`,
    event_ticker: 'KXWTI-26AUG2014',
    custom_strike: {
      front_month_contract: 'WBS 26V-ICE',
      strike_date: '2026-08-20T14:30:00-04:00',
    },
    rules_primary: `If the daily settlement price for WTI crude oil(October 2026 contract) is above ${strike} USD/Bbl, then Yes.`,
    rules_secondary: rulesSecondary,
  });
  return {
    event: {
      event_ticker: 'KXWTI-26AUG2014',
      settlement_sources: [{ name: 'ICE', url: 'https://www.theice.com/products/213/WTI-Crude-Futures' }],
    },
    markets: [market(75), market(76)],
  };
}

describe('strict resolver reference provider', () => {
  const originalPythKey = process.env.PYTH_API_KEY;
  const originalHermesKey = process.env.HERMES_API_KEY;

  beforeEach(() => {
    delete process.env.PYTH_API_KEY;
    delete process.env.HERMES_API_KEY;
  });

  afterEach(() => {
    if (originalPythKey == null) delete process.env.PYTH_API_KEY;
    else process.env.PYTH_API_KEY = originalPythKey;
    if (originalHermesKey == null) delete process.env.HERMES_API_KEY;
    else process.env.HERMES_API_KEY = originalHermesKey;
  });

  test('keeps only an unexpired verified current Gold bar live through its bar window', () => {
    const reference = (overrides = {}) => goldReferenceItem({
      key: 'xauusd',
      label: 'SPOT GOLD',
      symbol: 'XAUUSD',
      role: 'proxy',
      reference: {
        spot: {
          status: 'available',
          availability: 'live',
          value: 4_418.6,
          source: 'ibkr_historical_bars',
          asOf: new Date(NOW - (9 * 60_000)).toISOString(),
          expiresAt: new Date(NOW + 60_000).toISOString(),
          ...overrides,
        },
      },
      instrument: GOLD_SPOT_PROXY_INSTRUMENT,
      nowMs: NOW,
    });

    expect(reference()).toMatchObject({
      status: 'live',
      price: 4_418.6,
      source: 'ibkr_historical_bars',
      expiresAt: new Date(NOW + 60_000).toISOString(),
    });
    expect(reference({ expiresAt: new Date(NOW - 1).toISOString() })).toMatchObject({
      status: 'unavailable', price: null, source: null, expiresAt: null,
    });
    expect(reference({
      asOf: new Date(NOW - (11 * 60_000)).toISOString(),
      expiresAt: new Date(NOW + 60_000).toISOString(),
    })).toMatchObject({ status: 'unavailable', price: null });
    expect(reference({ fromCache: true })).toMatchObject({ status: 'unavailable', price: null });
  });

  test('loads a fresh native NDX quote and verified current IBKR chart', async () => {
    const providerApi = ibkr();
    const provider = createReferenceProvider({ ibkr: providerApi, now: () => NOW });

    const snapshot = await provider.getSnapshot({ marketId: 'nasdaq100', selected: null });

    expect(snapshot).toMatchObject({
      resolver: 'cash Nasdaq-100 index',
      spot: {
        status: 'available',
        value: 27_850.25,
        source: 'ibkr_live_native_quote',
      },
      chart: {
        status: 'available',
        source: 'ibkr_historical_bars',
        latestValue: 27_850.25,
      },
    });
    expect(providerApi.getQuote).toHaveBeenCalledWith(NDX_INSTRUMENT);
    expect(providerApi.getHistoricalBars).toHaveBeenCalledWith(NDX_INSTRUMENT, '1d', '5m');
    expect(providerApi.getHistoricalBars).toHaveBeenCalledWith(NDX_INSTRUMENT, '1mo', '1h');
    ['1d', '5d', '10d'].forEach((range) => {
      expect(snapshot.chart.variants[range].ath).toMatchObject({
        status: 'available', source: 'ibkr_historical_record', value: 29_000,
      });
    });
  });

  test('loads the coarse multi-session IBKR history before the finer 1D upgrade and reuses both caches', async () => {
    let clock = NOW;
    let releaseOneDay;
    const oneDay = new Promise((resolve) => {
      releaseOneDay = resolve;
    });
    const ranges = [];
    const providerApi = ibkr({
      getHistoricalBars: jest.fn((_instrument, range) => {
        ranges.push(range);
        return range === '1d' ? oneDay : Promise.resolve(history());
      }),
    });
    const provider = createReferenceProvider({ ibkr: providerApi, now: () => clock });

    const firstRequest = provider.getSnapshot({ marketId: 'nasdaq100', selected: null });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ranges[0]).toBe('1mo');
    expect(ranges).toEqual(['1mo', '1d']);
    releaseOneDay(history());
    await firstRequest;
    expect(ranges).toEqual(['1mo', '1d', '6mo']);

    clock += 5_001;
    await provider.getSnapshot({ marketId: 'nasdaq100', selected: null });
    expect(ranges).toEqual(['1mo', '1d', '6mo']);
  });

  test('derives 5D and 10D from one verified IBKR multi-session request and one Risk Range query', async () => {
    const riskHistory = jest.fn(async ({ ticker, dates }) => exactRiskRanges(ticker, dates));
    const providerApi = ibkr({
      getHistoricalBars: jest.fn(async (_instrument, range) => history({
        bars: range === '1d'
          ? sessionBars(TEN_EXCHANGE_DATES.slice(-1), 79)
          : sessionBars(TEN_EXCHANGE_DATES, 70),
      })),
    });
    const provider = createReferenceProvider({
      ibkr: providerApi,
      now: () => NOW,
      loadRiskRangeHistory: riskHistory,
    });

    const snapshot = await provider.getSnapshot({ marketId: 'wti', selected: wtiSelection() });

    expect(snapshot.chart.points).toEqual(snapshot.chart.variants['1d'].points);
    expect(snapshot.chart.variants).toMatchObject({
      '1d': { status: 'available', range: '1d', rangeDates: ['2026-08-19'] },
      '5d': { status: 'available', range: '5d' },
      '10d': { status: 'available', range: '10d' },
    });
    expect(snapshot.chart.variants['5d'].rangeDates).toEqual(TEN_EXCHANGE_DATES.slice(-5));
    expect(snapshot.chart.variants['10d'].rangeDates).toEqual(TEN_EXCHANGE_DATES);
    expect(snapshot.chart.variants['10d'].dailyRanges).toHaveLength(10);
    expect(providerApi.getHistoricalBars).toHaveBeenCalledTimes(6);
    const exactIceWtiRequest = expect.objectContaining({
      symbol: 'WTI', exchange: 'IPE', tradingClass: 'WTI', lastTradeDateOrContractMonth: '202610',
    });
    const qualifiedIceWti = expect.objectContaining({
      symbol: 'WTI', exchange: 'IPE', tradingClass: 'WTI', displaySymbol: 'WBSV26',
      localSymbol: 'WTIV6', conId: 2001, contractMonth: '202610',
      lastTradeDateOrContractMonth: '20260921',
    });
    expect(providerApi.getHistoricalBars).toHaveBeenCalledWith(exactIceWtiRequest, '1d', '5m', { useRth: false });
    expect(providerApi.getHistoricalBars).toHaveBeenCalledWith(qualifiedIceWti, '1mo', '1h', { useRth: false });
    expect(providerApi.getHistoricalBars).toHaveBeenCalledWith(qualifiedIceWti, '6mo', '1d', { useRth: false });
    const liquidNymexWti = expect.objectContaining({
      symbol: 'CL', displaySymbol: 'CLV26', exchange: 'NYMEX', conId: 1002,
    });
    expect(providerApi.getHistoricalBars).toHaveBeenCalledWith(liquidNymexWti, '1d', '5m', { useRth: false });
    expect(providerApi.getHistoricalBars).toHaveBeenCalledWith(liquidNymexWti, '1mo', '1h', { useRth: false });
    expect(providerApi.getHistoricalBars).toHaveBeenCalledWith(liquidNymexWti, '6mo', '1d', { useRth: false });
    expect(snapshot.chartReferences).toMatchObject({
      basis: { role: 'risk_range_basis', symbol: 'WTIC', instrument: { displaySymbol: 'CLV26' } },
      contract: {
        role: 'contract_reference', symbol: 'WBSV26',
        instrument: { symbol: 'WTI', exchange: 'IPE', localSymbol: 'WTIV6', conId: 2001 },
      },
    });
    expect(riskHistory).toHaveBeenCalledTimes(1);
    expect(riskHistory).toHaveBeenCalledWith({ ticker: 'WTIC', dates: TEN_EXCHANGE_DATES });
  });

  test('publishes a completed proxy-fit calculation after its non-blocking historical load finishes', async () => {
    const fitDates = recentWeekdays(130);
    let releaseFitHistory;
    const fitHistory = new Promise((resolve) => {
      releaseFitHistory = resolve;
    });
    const riskHistory = jest.fn(({ ticker, dates }) => (
      dates.length > 20 ? fitHistory : Promise.resolve(exactRiskRanges(ticker, dates))
    ));
    const providerApi = ibkr({
      getHistoricalBars: jest.fn(async (_instrument, range) => history({
        bars: range === '6mo'
          ? fitDates.map((date, index) => ({ date: date.replaceAll('-', ''), close: 101 + index }))
          : range === '1d'
            ? sessionBars(TEN_EXCHANGE_DATES.slice(-1), 79)
            : sessionBars(TEN_EXCHANGE_DATES, 70),
      })),
    });
    const provider = createReferenceProvider({
      ibkr: providerApi,
      now: () => NOW,
      loadRiskRangeHistory: riskHistory,
    });

    const first = await provider.getSnapshot({ marketId: 'wti', selected: wtiSelection() });
    expect(first.proxyFit).toMatchObject({
      status: 'loading', proxyLabel: 'WBSV26', underlyingLabel: 'WTIC',
    });

    releaseFitHistory(proxyFitRiskRanges('WTIC', fitDates));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const completed = await provider.getSnapshot({ marketId: 'wti', selected: wtiSelection() });

    expect(completed.proxyFit).toMatchObject({
      status: 'available',
      proxyLabel: 'WBSV26',
      underlyingLabel: 'WTIC',
      alignedThroughDate: '2026-08-19',
      alignedObservations: 129,
    });
    expect(completed.proxyFit.rows.map((row) => [row.window, row.status])).toEqual([
      [5, 'available'],
      [20, 'available'],
      [60, 'available'],
      [120, 'available'],
    ]);
  });

  test('attaches one verified current ATH to 1D, 5D, and 10D charts', async () => {
    const providerApi = ibkr({
      getQuote: jest.fn(async () => canonicalQuote({ mark: 130, last: 130 })),
      getHistoricalBars: jest.fn(async (_instrument, range) => history({
        bars: range === '1d'
          ? sessionBars(TEN_EXCHANGE_DATES.slice(-1), 119)
          : sessionBars(TEN_EXCHANGE_DATES, 110),
      })),
      getHistoricalRecord: jest.fn(async (_instrument, throughDate) => ({
        status: 'available',
        source: 'ibkr',
        dataset: 'historical_record',
        asOf: AS_OF,
        throughDate,
        recordHigh: 125,
        recordDate: '2026-08-10',
        coverage: {
          complete: true,
          startDate: '1983-03-30',
          endDate: throughDate,
          headDate: '1983-03-30',
          chunks: 20,
          observations: 9_000,
        },
        reason: null,
      })),
    });
    const provider = createReferenceProvider({ ibkr: providerApi, now: () => NOW });

    const snapshot = await provider.getSnapshot({ marketId: 'wti', selected: wtiSelection() });

    for (const range of ['1d', '5d', '10d']) {
      expect(snapshot.chart.variants[range].ath).toMatchObject({
        status: 'available',
        source: 'ibkr_historical_record',
        value: 130,
        date: '2026-08-19',
        baseline: {
          value: 125,
          date: '2026-08-10',
          throughDate: '2026-08-18',
          coverageComplete: true,
        },
      });
    }
    expect(providerApi.getHistoricalRecord).toHaveBeenCalledTimes(2);
    expect(providerApi.getHistoricalRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        symbol: 'WTI', exchange: 'IPE', localSymbol: 'WTIV6', conId: 2001,
        contractMonth: '202610', lastTradeDateOrContractMonth: '20260921',
      }),
      '2026-08-18',
    );
    expect(providerApi.getHistoricalRecord).toHaveBeenCalledWith(
      expect.objectContaining({ symbol: 'CL', exchange: 'NYMEX', conId: 1002 }),
      '2026-08-18',
    );
  });

  test('keeps a verified ATH on every fresh provider chart while only ATH history is pending', () => {
    const ath = {
      status: 'available',
      source: 'ibkr_historical_record',
      asOf: AS_OF,
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
    const variant = (range, value, chartAth) => ({
      status: 'available', availability: 'current', source: 'ibkr_historical_bars', range,
      asOf: AS_OF, latestAt: AS_OF, latestValue: value,
      expiresAt: new Date(NOW + 60_000).toISOString(),
      points: [{ timestamp: NOW - 60_000, value: value - 1 }, { timestamp: NOW, value }],
      ath: chartAth,
    });
    const chart = (value, chartAth) => {
      const oneDay = variant('1d', value, chartAth);
      return {
        ...oneDay,
        variants: {
          '1d': oneDay,
          '5d': variant('5d', value, chartAth),
          '10d': variant('10d', value, chartAth),
        },
      };
    };

    const result = retainVerifiedChartWhileRefreshing(
      chart(7_700, ath),
      chart(7_710, loadingAth),
      NOW,
    );

    expect(result.retained).toBe(true);
    expect(result.chart.latestValue).toBe(7_710);
    ['1d', '5d', '10d'].forEach((range) => {
      expect(result.chart.variants[range].ath).toMatchObject({
        status: 'available', value: 7_816.7, refreshPending: true, refreshRetained: true,
      });
    });
    expect(result.chart.ath).toEqual(result.chart.variants['1d'].ath);
  });

  test('fails ATH closed across every duration when historical-record provenance is forbidden', async () => {
    const providerApi = ibkr({
      getHistoricalBars: jest.fn(async (_instrument, range) => history({
        bars: range === '1d'
          ? sessionBars(TEN_EXCHANGE_DATES.slice(-1), 119)
          : sessionBars(TEN_EXCHANGE_DATES, 110),
      })),
      getHistoricalRecord: jest.fn(async (_instrument, throughDate) => ({
        status: 'available',
        source: 'ibkr',
        dataset: 'historical_record',
        throughDate,
        recordHigh: 125,
        recordDate: '2026-08-10',
        cached: true,
        coverage: {
          complete: true,
          startDate: '1983-03-30',
          endDate: throughDate,
          headDate: '1983-03-30',
          chunks: 20,
          observations: 9_000,
        },
      })),
    });
    const provider = createReferenceProvider({ ibkr: providerApi, now: () => NOW });

    const snapshot = await provider.getSnapshot({ marketId: 'wti', selected: wtiSelection() });

    for (const range of ['1d', '5d', '10d']) {
      expect(snapshot.chart.variants[range].ath).toMatchObject({
        status: 'unavailable',
        value: null,
      });
    }
  });

  test('marks only Risk Range overlays pending when verified price history wins the bounded wait', async () => {
    const providerApi = ibkr({
      getHistoricalBars: jest.fn(async (_instrument, range) => history({
        bars: range === '1d'
          ? sessionBars(TEN_EXCHANGE_DATES.slice(-1), 79)
          : sessionBars(TEN_EXCHANGE_DATES, 70),
      })),
    });
    const provider = createReferenceProvider({
      ibkr: providerApi,
      now: () => NOW,
      loadRiskRangeHistory: jest.fn(() => new Promise(() => {})),
    });

    const snapshot = await provider.getSnapshot({ marketId: 'wti', selected: wtiSelection() });

    expect(snapshot.backgroundRefresh).toBe(true);
    expect(snapshot.chart.variants).toMatchObject({
      '1d': {
        status: 'available', riskRangeStatus: 'partial', riskRangeRefreshPending: true,
      },
      '5d': {
        status: 'available', riskRangeStatus: 'partial', riskRangeRefreshPending: true,
      },
      '10d': {
        status: 'available', riskRangeStatus: 'partial', riskRangeRefreshPending: true,
      },
    });
    expect(snapshot.chart.variants['10d'].points.length).toBeGreaterThanOrEqual(2);
    expect(snapshot.chart.variants['10d'].dailyRanges.every((range) => range.status === 'unavailable')).toBe(true);
  });

  test('publishes a slow exact-date Risk Range result on the next refresh instead of discarding it', async () => {
    let clock = NOW;
    let resolveRiskHistory;
    let requestedContext = null;
    const riskHistory = jest.fn((context) => {
      requestedContext = context;
      return new Promise((resolve) => {
        resolveRiskHistory = resolve;
      });
    });
    const providerApi = ibkr({
      getHistoricalBars: jest.fn(async (_instrument, range) => history({
        bars: range === '1d'
          ? sessionBars(TEN_EXCHANGE_DATES.slice(-1), 79)
          : sessionBars(TEN_EXCHANGE_DATES, 70),
      })),
    });
    const provider = createReferenceProvider({
      ibkr: providerApi,
      now: () => clock,
      loadRiskRangeHistory: riskHistory,
    });

    const pending = await provider.getSnapshot({ marketId: 'wti', selected: wtiSelection() });
    expect(pending.chart.variants['10d']).toMatchObject({
      riskRangeStatus: 'partial',
      riskRangeRefreshPending: true,
    });

    resolveRiskHistory(exactRiskRanges(requestedContext.ticker, requestedContext.dates));
    await Promise.resolve();
    await Promise.resolve();
    clock += 5_001;
    const recovered = await provider.getSnapshot({ marketId: 'wti', selected: wtiSelection() });

    expect(recovered.chart.variants['10d']).toMatchObject({
      riskRangeStatus: 'available',
      riskRangeMissingDates: [],
    });
    expect(recovered.chart.variants['10d'].dailyRanges.every((range) => range.status === 'available')).toBe(true);
    expect(riskHistory).toHaveBeenCalledTimes(1);
  });

  test('retries a slow verified partial Risk Range result when an expected weekday is missing', async () => {
    let clock = NOW;
    let resolveRiskHistory;
    let requestedContext = null;
    let riskRequest = 0;
    const riskHistory = jest.fn((context) => {
      requestedContext = context;
      riskRequest += 1;
      if (riskRequest > 1) return Promise.resolve(exactRiskRanges(context.ticker, context.dates));
      return new Promise((resolve) => { resolveRiskHistory = resolve; });
    });
    const providerApi = ibkr({
      getHistoricalBars: jest.fn(async (_instrument, range) => history({
        bars: range === '1d'
          ? sessionBars(TEN_EXCHANGE_DATES.slice(-1), 79)
          : sessionBars(TEN_EXCHANGE_DATES, 70),
      })),
    });
    const provider = createReferenceProvider({
      ibkr: providerApi,
      now: () => clock,
      loadRiskRangeHistory: riskHistory,
    });

    await provider.getSnapshot({ marketId: 'wti', selected: wtiSelection() });
    const missingDate = requestedContext.dates[0];
    const availableDates = requestedContext.dates.slice(1);
    resolveRiskHistory({
      ...exactRiskRanges(requestedContext.ticker, availableDates),
      status: 'unavailable',
      missingDates: [missingDate],
      reason: `Exact-date Risk Range data is unavailable for ${missingDate}.`,
    });
    await Promise.resolve();
    await Promise.resolve();
    clock += 5_001;

    const recovered = await provider.getSnapshot({ marketId: 'wti', selected: wtiSelection() });

    expect(recovered.chart.variants['10d']).toMatchObject({
      riskRangeStatus: 'available',
      riskRangeMissingDates: [],
    });
    expect(recovered.chart.variants['10d'].dailyRanges.filter((range) => range.status === 'available'))
      .toHaveLength(10);
    expect(riskHistory).toHaveBeenCalledTimes(2);
  });

  test('retains prior verified same-date overlays after a later Risk Range lookup exceeds the bounded wait', async () => {
    let clock = NOW;
    let riskRequest = 0;
    const riskHistory = jest.fn(({ ticker, dates }) => {
      riskRequest += 1;
      return riskRequest === 1 ? exactRiskRanges(ticker, dates) : new Promise(() => {});
    });
    const providerApi = ibkr({
      getHistoricalBars: jest.fn(async (_instrument, range) => history({
        bars: range === '1d'
          ? sessionBars(TEN_EXCHANGE_DATES.slice(-1), 79)
          : sessionBars(TEN_EXCHANGE_DATES, 70),
      })),
    });
    const provider = createReferenceProvider({
      ibkr: providerApi,
      now: () => clock,
      loadRiskRangeHistory: riskHistory,
      riskRangeHistoryCacheMs: 0,
    });
    const first = await provider.getSnapshot({ marketId: 'wti', selected: wtiSelection() });
    expect(first.chart.variants['10d'].riskRangeStatus).toBe('available');

    clock += 5_001;
    await provider.getSnapshot({ marketId: 'wti', selected: wtiSelection() });
    await new Promise((resolve) => setTimeout(resolve, 550));
    const retained = await provider.getSnapshot({ marketId: 'wti', selected: wtiSelection() });

    expect(retained.chart.variants['10d']).toMatchObject({
      riskRangeStatus: 'available',
      riskRangeRefreshPending: true,
      riskRangeRefreshRetained: true,
    });
    expect(retained.chart.variants['10d'].dailyRanges.every((range) => range.status === 'available')).toBe(true);
  });

  test('keeps 5D and 10D on completed sessions until the current session has two verified points', async () => {
    const priorDates = recentWeekdays(10, '2026-08-18');
    const riskHistory = jest.fn(async ({ ticker, dates }) => exactRiskRanges(ticker, dates));
    const providerApi = ibkr({
      getQuote: jest.fn(async () => canonicalQuote({ mark: 76.25, last: 76.25 })),
      getHistoricalBars: jest.fn(async (_instrument, range) => history({
        bars: range === '1d' ? [] : completedSessionBars(priorDates, 70),
      })),
    });
    const provider = createReferenceProvider({
      ibkr: providerApi,
      now: () => NOW,
      loadRiskRangeHistory: riskHistory,
    });

    const snapshot = await provider.getSnapshot({ marketId: 'wti', selected: wtiSelection() });

    expect(snapshot.chart.variants['1d']).toMatchObject({
      status: 'historical',
      rangeDates: ['2026-08-18'],
      resolutionState: 'coarser_verified',
      sessionMode: 'last_complete',
      sessionDate: '2026-08-18',
    });
    expect(snapshot.chart.variants['5d']).toMatchObject({
      status: 'historical',
      rangeDates: priorDates.slice(-5),
    });
    expect(snapshot.chart.variants['10d']).toMatchObject({
      status: 'historical',
      rangeDates: priorDates,
    });
    expect(snapshot.chart.variants['10d'].points.at(-1)).not.toMatchObject({
      source: 'ibkr_live_native_quote',
    });
    expect(riskHistory).toHaveBeenCalledWith({ ticker: 'WTIC', dates: priorDates });
  });

  test('does not anchor multi-day ranges to today with a stale same-contract quote', async () => {
    const priorDates = TEN_EXCHANGE_DATES.slice(0, -1);
    const providerApi = ibkr({
      getQuote: jest.fn(async () => canonicalQuote({
        mark: 76.25,
        last: 76.25,
        timestamp: '2026-08-19T15:58:00.000Z',
      })),
      getHistoricalBars: jest.fn(async (_instrument, range) => history({
        bars: range === '1d' ? [] : completedSessionBars(priorDates, 70),
      })),
    });
    const provider = createReferenceProvider({ ibkr: providerApi, now: () => NOW });

    const snapshot = await provider.getSnapshot({ marketId: 'wti', selected: wtiSelection() });

    expect(snapshot.spot).toMatchObject({ status: 'historical', value: 78.5 });
    expect(snapshot.chart.variants['5d']).toMatchObject({
      status: 'historical',
      rangeDates: priorDates.slice(-5),
    });
    expect(snapshot.chart.variants['10d']).toMatchObject({
      status: 'unavailable',
      points: [],
    });
  });

  test('keeps 1D visible with verified 1-hour bars when preferred 5-minute history fails', async () => {
    const providerApi = ibkr({
      getHistoricalBars: jest.fn(async (_instrument, range) => {
        if (range === '1d') throw new Error('5-minute history temporarily unavailable');
        return history({ bars: sessionBars(TEN_EXCHANGE_DATES, 70) });
      }),
    });
    const provider = createReferenceProvider({ ibkr: providerApi, now: () => NOW });

    const snapshot = await provider.getSnapshot({ marketId: 'wti', selected: wtiSelection() });

    expect(snapshot.chart).toMatchObject({
      status: 'available',
      range: '1d',
      interval: '1h',
      resolutionState: 'coarser_verified',
      refreshFailed: false,
    });
    expect(snapshot.chart.points.length).toBeGreaterThanOrEqual(2);
    expect(snapshot.chart.preferredResolutionRefreshIssue).toMatch(/5-minute history temporarily unavailable/);
    expect(snapshot.chart.variants['5d']).toMatchObject({ status: 'available', interval: '1h' });
    expect(snapshot.chart.variants['10d']).toMatchObject({ status: 'available', interval: '1h' });
  });

  test('uses the exact dated ICE WTI contract published by the Kalshi resolver generation', async () => {
    const providerApi = ibkr({
      getQuote: jest.fn(async () => canonicalQuote({ mark: 76.25, last: 76.25 })),
      getHistoricalBars: jest.fn(async () => history({
        bars: [{ date: NOW - 5 * 60_000, close: 76.1 }, { date: NOW - 60_000, close: 76.2 }],
      })),
    });
    const provider = createReferenceProvider({ ibkr: providerApi, now: () => NOW });

    const snapshot = await provider.getSnapshot({ marketId: 'wti', selected: wtiSelection() });

    expect(snapshot.spot).toMatchObject({ status: 'available', value: 76.25 });
    expect(snapshot.chartReferences.contract).toMatchObject({
      symbol: 'WBSV26',
      chart: { status: 'available' },
      instrument: {
        symbol: 'WTI', displaySymbol: 'WBSV26', localSymbol: 'WTIV6', conId: 2001,
        contractMonth: '202610', lastTradeDate: '20260921',
        lastTradeDateOrContractMonth: '20260921',
      },
    });
    expect(providerApi.getQuote).toHaveBeenCalledWith(expect.objectContaining({
      symbol: 'WTI',
      secType: 'FUT',
      exchange: 'IPE',
      tradingClass: 'WTI',
      conId: 2001,
      localSymbol: 'WTIV6',
      contractMonth: '202610',
      lastTradeDateOrContractMonth: '20260921',
    }));
  });

  test('normalizes a restored IBKR one-digit WTI local symbol without changing its provenance', async () => {
    const restored = {
      ...TEST_DIRECTIONAL_INSTRUMENTS.wti,
      displaySymbol: 'CLV6',
      contractMonth: undefined,
    };
    const providerApi = ibkr();
    const provider = createReferenceProvider({
      ibkr: providerApi,
      now: () => NOW,
      loadDirectionalSelection: async () => ({
        instrument: restored,
        rollReason: 'restored_verified_identity',
        refreshPending: false,
      }),
    });

    const snapshot = await provider.getSnapshot({ marketId: 'wti', selected: wtiSelection() });

    expect(snapshot.chartReferences.basis.instrument).toMatchObject({
      displaySymbol: 'CLV26',
      localSymbol: 'CLV6',
      contractMonth: '202610',
      lastTradeDate: '20260922',
      lastTradeDateOrContractMonth: '20260922',
    });
  });

  test('rejects ICE WTI history whose qualified local symbol is the wrong delivery month', async () => {
    const providerApi = ibkr({
      getHistoricalBars: jest.fn(async (instrument) => {
        const payload = history({
          bars: [{ date: NOW - 5 * 60_000, close: 76.1 }, { date: NOW - 60_000, close: 76.2 }],
        });
        if (instrument?.symbol !== 'WTI') return payload;
        return {
          ...payload,
          contract: {
            symbol: 'WTI', localSymbol: 'WTIX6', secType: 'FUT', exchange: 'IPE',
            currency: 'USD', multiplier: '1000', tradingClass: 'WTI',
            lastTradeDateOrContractMonth: '20261020', provider: 'ibkr',
          },
        };
      }),
    });
    const provider = createReferenceProvider({ ibkr: providerApi, now: () => NOW });

    const snapshot = await provider.getSnapshot({ marketId: 'wti', selected: wtiSelection() });

    expect(snapshot.chartReferences.basis.chart).toMatchObject({ status: 'available' });
    expect(snapshot.chartReferences.contract.chart.variants).toMatchObject({
      '1d': { status: 'unavailable', points: [] },
      '5d': { status: 'unavailable', points: [] },
      '10d': { status: 'unavailable', points: [] },
    });
  });

  test.each([
    ['gold', 'METLG', {
      resolverSymbol: 'GCZ26',
      underlyingContractMonth: '202612',
      instrument: {
        symbol: 'GC', displaySymbol: 'GCZ26', ibkrSymbol: 'GC', secType: 'FUT',
        exchange: 'COMEX', currency: 'USD', lastTradeDateOrContractMonth: '202612',
        tradingClass: 'GC', multiplier: '100', provider: 'ibkr',
      },
    }],
    ['silver', 'METLS', {
      resolverSymbol: 'SIH27',
      underlyingContractMonth: '202703',
      instrument: {
        symbol: 'SI', displaySymbol: 'SIH27', ibkrSymbol: 'SI', secType: 'FUT',
        exchange: 'COMEX', currency: 'USD', lastTradeDateOrContractMonth: '202703',
        tradingClass: 'SI', multiplier: '5000', provider: 'ibkr',
      },
    }],
  ])('uses the exact dated ForecastEx %s settlement identity when it is complete', async (marketId, productCode, resolverIdentity) => {
    const providerApi = ibkr();
    const pythClient = { get: jest.fn(), post: jest.fn() };
    const provider = createReferenceProvider({ ibkr: providerApi, client: pythClient, now: () => NOW });
    const selected = {
      id: 'forecastex',
      resolverIdentity,
      catalog: { event: { ticker: `${productCode}_082126`, productCode, venueId: 'forecastex' } },
    };

    const snapshot = await provider.getSnapshot({ marketId, selected });

    expect(snapshot).toMatchObject({
      fit: 'exact',
      resolver: expect.stringMatching(/exact dated .* settlement reference/i),
      instrument: resolverIdentity.instrument,
      spot: { status: 'available', fit: 'exact', executable: false },
    });
    expect(snapshot.directionalFeed).toBeUndefined();
    expect(providerApi.getQuote).toHaveBeenCalledWith(expect.objectContaining({
      symbol: resolverIdentity.instrument.symbol,
      displaySymbol: resolverIdentity.instrument.displaySymbol,
      lastTradeDateOrContractMonth: resolverIdentity.instrument.lastTradeDateOrContractMonth,
    }));
    expect(providerApi.getHistoricalBars).toHaveBeenCalledWith(
      expect.objectContaining({ displaySymbol: resolverIdentity.instrument.displaySymbol }),
      '1d', '5m', { useRth: false },
    );
    if (marketId === 'gold') {
      expect(snapshot.chartReferences).toMatchObject({
        basis: {
          role: 'risk_range_basis', symbol: 'XAUUSD', riskRangeTicker: 'GLD',
          instrument: GOLD_SPOT_PROXY_INSTRUMENT,
        },
        contract: {
          role: 'proxy_reference', symbol: 'GCZ26', exact: false,
          instrument: { symbol: 'GC', displaySymbol: 'GCZ26', conId: 1003 },
        },
      });
      expect(snapshot.goldMarketReferences.map((reference) => reference.role)).toEqual([
        'direct', 'proxy', 'proxy',
      ]);
      expect(snapshot.goldMarketReferences[0]).toMatchObject({
        key: 'selectedResolver', symbol: 'GCZ26', role: 'direct', status: 'live',
      });
      expect(snapshot.goldMarketReferences[2]).toMatchObject({
        key: 'activeComex', symbol: 'GCZ26', role: 'proxy',
      });
    } else {
      expect(snapshot.chartReferences).toMatchObject({
        basis: {
          role: 'risk_range_basis', symbol: 'SILVER', riskRangeTicker: 'SILVER',
          instrument: { symbol: 'SI', displaySymbol: 'SIZ26', conId: 1004 },
        },
        contract: {
          role: 'contract_reference', symbol: 'SIH27', exact: true,
          instrument: { symbol: 'SI', displaySymbol: 'SIH27' },
        },
      });
    }
    expect(pythClient.get).not.toHaveBeenCalled();
    expect(pythClient.post).not.toHaveBeenCalled();
  });

  test('deduplicates both chart roles when they use the same verified IBKR conId', async () => {
    const providerApi = ibkr();
    const provider = createReferenceProvider({ ibkr: providerApi, now: () => NOW });
    const instrument = {
      ...TEST_DIRECTIONAL_INSTRUMENTS.silver,
      lastTradeDateOrContractMonth: '202612',
    };
    const selected = {
      id: 'forecastex',
      resolverIdentity: {
        resolverSymbol: instrument.displaySymbol,
        underlyingContractMonth: '202612',
        instrument,
      },
      catalog: { event: { ticker: 'METLS_082126', productCode: 'METLS', venueId: 'forecastex' } },
    };

    const snapshot = await provider.getSnapshot({ marketId: 'silver', selected });

    expect(snapshot.chartReferences).toMatchObject({
      basis: { symbol: 'SILVER', instrument: { conId: 1004, displaySymbol: 'SIZ26' } },
      contract: { symbol: 'SIZ26', instrument: { conId: 1004, displaySymbol: 'SIZ26' } },
    });
    expect(providerApi.getQuote).toHaveBeenCalledTimes(1);
    expect(providerApi.getHistoricalBars).toHaveBeenCalledTimes(3);
    expect(providerApi.getHistoricalRecord).toHaveBeenCalledTimes(1);
  });

  test('publishes a verified non-executable COMEX proxy when ForecastEx omits the exact metal month', async () => {
    const providerApi = ibkr();
    const provider = createReferenceProvider({ ibkr: providerApi, now: () => NOW });
    const selected = {
      id: 'forecastex',
      catalog: { event: { ticker: 'METLG_082126', productCode: 'METLG', venueId: 'forecastex' } },
    };

    const snapshot = await provider.getSnapshot({ marketId: 'gold', selected });

    expect(snapshot).toMatchObject({
      fit: 'proxy',
      resolver: expect.stringMatching(/did not publish the exact resolver month/i),
      spot: {
        status: 'available', fit: 'proxy', executable: false,
        label: expect.stringMatching(/^PROXY · GC/),
      },
      chart: { status: 'available', fit: 'proxy', executable: false },
    });
    expect(snapshot.goldMarketReferences[0]).toMatchObject({
      key: 'selectedResolver', role: 'direct', status: 'unavailable', price: null,
    });
    expect(snapshot.goldMarketReferences[1]).toMatchObject({
      key: 'xauusd', role: 'proxy', symbol: 'XAUUSD',
    });
    expect(snapshot.goldMarketReferences[2]).toMatchObject({
      key: 'activeComex', role: 'proxy', symbol: 'GCZ26',
    });
    expect(providerApi.getQuote).toHaveBeenCalledWith(expect.objectContaining({ symbol: 'GC', exchange: 'COMEX' }));
    expect(providerApi.getHistoricalBars).toHaveBeenCalledWith(
      expect.objectContaining({ symbol: 'GC', exchange: 'COMEX' }),
      '1mo',
      '1h',
      { useRth: false },
    );
  });

  test('publishes a verified XAUUSD current bar beside a ForecastEx Gold resolver without waiting for daily history', async () => {
    const providerApi = ibkr({
      getQuote: jest.fn(async (instrument) => (
        instrument?.symbol === 'XAUUSD'
          ? canonicalQuote({ mark: 4_418.7, mid: 4_418.7, last: null })
          : canonicalQuote()
      )),
      getHistoricalBars: jest.fn(async (instrument, _range, interval) => {
        if (instrument?.symbol === 'XAUUSD' && interval === '1d') {
          return new Promise(() => {});
        }
        if (instrument?.symbol === 'XAUUSD' && interval === '5m') {
          return history({
            bars: [
              { date: NOW - (5 * 60_000), close: 4_417.9 },
              { date: NOW - 60_000, close: 4_418.6 },
            ],
          });
        }
        return history();
      }),
    });
    const provider = createReferenceProvider({ ibkr: providerApi, now: () => NOW });
    const selected = {
      id: 'forecastex',
      resolverIdentity: {
        resolverSymbol: 'GCZ26',
        underlyingContractMonth: '202612',
        instrument: {
          symbol: 'GC', displaySymbol: 'GCZ26', ibkrSymbol: 'GC', secType: 'FUT',
          exchange: 'COMEX', currency: 'USD', lastTradeDateOrContractMonth: '202612',
          tradingClass: 'GC', multiplier: '100', provider: 'ibkr',
        },
      },
      catalog: { event: { ticker: 'METLG_082126', productCode: 'METLG', venueId: 'forecastex' } },
    };

    const snapshot = await provider.getSnapshot({ marketId: 'gold', selected });

    expect(snapshot.goldMarketReferences[1]).toMatchObject({
      key: 'xauusd',
      symbol: 'XAUUSD',
      status: 'live',
      price: 4_418.6,
      source: 'ibkr_historical_bars',
      expiresAt: new Date(NOW + (9 * 60_000)).toISOString(),
    });
  });

  test('uses the exact dated ForecastEx ES resolver contract as a non-executable reference', async () => {
    let clock = NOW;
    const providerApi = ibkr({
      getQuote: jest.fn(async () => canonicalQuote({ mark: 6420.5, last: 6420.25 })),
      getHistoricalBars: jest.fn(async () => history({
        bars: [{ date: NOW - 5 * 60_000, close: 6418 }, { date: NOW - 60_000, close: 6420 }],
      })),
    });
    const provider = createReferenceProvider({ ibkr: providerApi, now: () => clock });
    const selected = {
      resolverIdentity: {
        resolverSymbol: 'ESU26',
        underlyingContractMonth: '202609',
      },
    };
    const snapshot = await provider.getSnapshot({ marketId: 'sp500', selected });
    expect(snapshot).toMatchObject({
      resolver: 'CME ESU26 dated E-mini S&P 500 future',
      instrument: { displaySymbol: 'ESU26', lastTradeDateOrContractMonth: '202609' },
      spot: { status: 'available', value: 6420.25, fit: 'exact', executable: false },
    });
    expect(providerApi.getQuote).toHaveBeenCalledWith(expect.objectContaining({
      symbol: 'ES', secType: 'FUT', exchange: 'CME', multiplier: '50',
      displaySymbol: 'ESU26', lastTradeDateOrContractMonth: '202609',
    }));

    providerApi.getQuote.mockResolvedValueOnce(canonicalQuote({ last: null, mark: 6421 }));
    clock += 5_001;
    const next = await provider.getSnapshot({ marketId: 'sp500', selected });
    expect(next.spot).toMatchObject({ status: 'unavailable', value: null });
  });

  test('uses a verified completed exact ES session as a last-close marker when live quote is unavailable', async () => {
    const selected = {
      resolverIdentity: {
        resolverSymbol: 'ESU26',
        underlyingContractMonth: '202609',
      },
    };
    const providerApi = ibkr({
      getQuote: jest.fn(async () => canonicalQuote({ valid: false, last: null, mark: null })),
      getHistoricalBars: jest.fn(async (_instrument, range) => history({
        bars: range === '1d'
          ? completedSessionBars(['2026-08-18'], 6410)
          : completedSessionBars(TEN_EXCHANGE_DATES.slice(0, -1), 6400),
      })),
    });
    const provider = createReferenceProvider({ ibkr: providerApi, now: () => NOW });

    const snapshot = await provider.getSnapshot({ marketId: 'sp500', selected });

    expect(snapshot.spot).toMatchObject({
      status: 'historical', availability: 'historical', fit: 'exact',
      label: 'ESU26 LAST CLOSE', source: 'ibkr_historical_bars',
      historicalThroughDate: '2026-08-18', executable: false,
    });
    expect(snapshot.spot.value).toBe(snapshot.chart.latestValue);
  });

  test.each([
    ['delayed', canonicalQuote({ dataType: 'delayed' })],
    ['stale', canonicalQuote({ timestamp: '2026-08-19T15:58:00.000Z' })],
    ['derived', canonicalQuote({ warning: 'derived fallback' })],
    ['invalid', canonicalQuote({ valid: false })],
  ])('does not expose a %s IBKR quote as live', (_label, quote) => {
    expect(normalizeLiveQuote(quote, 'NDX', NOW)).toMatchObject({
      status: 'unavailable',
      value: null,
    });
  });

  test('rejects otherwise fresh quote/history payloads when IBKR is disconnected', async () => {
    const provider = createReferenceProvider({
      ibkr: ibkr({ getProviderStatus: jest.fn(async () => ({ connected: false, status: 'disconnected' })) }),
      now: () => NOW,
    });
    const snapshot = await provider.getSnapshot({ marketId: 'nasdaq100', selected: null });
    expect(snapshot.spot.status).toBe('unavailable');
    expect(snapshot.chart.status).toBe('unavailable');
  });

  test('does not enqueue directional contract discovery while IBKR is disconnected', async () => {
    const providerApi = ibkr({
      getProviderStatus: jest.fn(async () => ({ connected: false, status: 'disconnected' })),
    });
    const provider = createMarketReferenceProvider({
      ibkr: providerApi,
      now: () => NOW,
      loadRiskRangeHistory: async ({ ticker, dates }) => ({
        status: 'unavailable', source: 'RiskRangeData', ticker, ranges: {}, missingDates: dates,
        reason: 'Test Risk Range history is unavailable.',
      }),
    });

    const snapshot = await provider.getSnapshot({ marketId: 'gold', selected: null });

    expect(snapshot.spot).toMatchObject({ status: 'unavailable', value: null });
    expect(snapshot.chart).toMatchObject({ status: 'unavailable', points: [] });
    // A negative broker probe is confirmed once before the provider publishes
    // a disconnected state.
    expect(providerApi.getProviderStatus).toHaveBeenCalledTimes(2);
    expect(providerApi.getHistoricalBars).not.toHaveBeenCalled();
    expect(providerApi.getQuote).not.toHaveBeenCalled();
  });

  test('classifies repeated health timeouts as transient without leaving a cold card loading forever', async () => {
    const providerApi = ibkr({
      getProviderStatus: jest.fn(async () => { throw new Error('sidecar health timeout'); }),
    });
    const provider = createReferenceProvider({ ibkr: providerApi, now: () => NOW });

    const snapshot = await provider.getSnapshot({ marketId: 'gold', selected: null });

    expect(snapshot).toMatchObject({
      backgroundRefresh: true,
      spot: {
        status: 'unavailable', refreshing: false, refreshPending: true,
        errorCode: 'IBKR_STATUS_UNRESPONSIVE', value: null,
      },
      chart: {
        status: 'unavailable', refreshing: false, refreshPending: true,
        variants: {
          '5d': { status: 'unavailable', refreshing: false, refreshPending: true },
          '10d': { status: 'unavailable', refreshing: false, refreshPending: true },
        },
      },
      proxyFit: {
        status: 'unavailable', refreshPending: true,
        errorCode: 'IBKR_STATUS_UNRESPONSIVE',
      },
    });
    expect(providerApi.getProviderStatus).toHaveBeenCalledTimes(2);
    expect(providerApi.getHistoricalBars).not.toHaveBeenCalled();
    expect(providerApi.getQuote).not.toHaveBeenCalled();
  });

  test('recovers a transient IBKR health miss before building the Gold header references', async () => {
    const providerApi = ibkr({
      getProviderStatus: jest.fn()
        .mockResolvedValueOnce({ connected: false, status: 'disconnected' })
        .mockResolvedValue({ connected: true, status: 'connected' }),
    });
    const provider = createReferenceProvider({ ibkr: providerApi, now: () => NOW });
    const selected = {
      id: 'forecastex',
      resolverIdentity: {
        resolverSymbol: 'GCZ26',
        underlyingContractMonth: '202612',
        instrument: {
          symbol: 'GC', displaySymbol: 'GCZ26', ibkrSymbol: 'GC', secType: 'FUT',
          exchange: 'COMEX', currency: 'USD', lastTradeDateOrContractMonth: '202612',
          tradingClass: 'GC', multiplier: '100', provider: 'ibkr',
        },
      },
      catalog: { event: { ticker: 'METLG_082126', productCode: 'METLG', venueId: 'forecastex' } },
    };

    const snapshot = await provider.getSnapshot({ marketId: 'gold', selected });

    expect(providerApi.getProviderStatus).toHaveBeenCalledTimes(2);
    expect(snapshot.goldMarketReferences).toEqual([
      expect.objectContaining({ key: 'selectedResolver', status: 'live', price: expect.any(Number) }),
      expect.objectContaining({ key: 'xauusd', status: 'live', price: expect.any(Number) }),
      expect.objectContaining({ key: 'activeComex', status: 'live', price: expect.any(Number) }),
    ]);
    expect(providerApi.getQuote).toHaveBeenCalled();
  });

  test('does not relabel daily GC bars as a valid intraday directional chart', async () => {
    delete process.env.PYTH_API_KEY;
    delete process.env.HERMES_API_KEY;
    const client = { get: jest.fn() };
    const providerApi = ibkr({
      getQuote: jest.fn(async () => canonicalQuote({ valid: false })),
      getHistoricalBars: jest.fn(async () => history({
        bars: [{ date: '20260817', close: 4190 }, { date: '20260818', close: 4200 }],
      })),
    });
    const provider = createReferenceProvider({ client, ibkr: providerApi, now: () => NOW });
    const snapshot = await provider.getSnapshot({ marketId: 'gold', selected: null });
    expect(snapshot.spot).toMatchObject({
      status: 'unavailable', value: null, fit: 'proxy', executable: false,
    });
    expect(snapshot.chart).toMatchObject({
      status: 'unavailable', fit: 'proxy', range: '1d', points: [], executable: false,
      variants: {
        '1d': { status: 'unavailable', points: [] },
        '5d': { status: 'unavailable', points: [] },
        '10d': { status: 'unavailable', points: [] },
      },
    });
    expect(providerApi.getHistoricalBars).toHaveBeenCalledTimes(5);
    expect(client.get).not.toHaveBeenCalled();
  });

  test('fails WTI chart ranges closed when verified intraday history is empty', async () => {
    const providerApi = ibkr({
      getQuote: jest.fn(async () => canonicalQuote({ valid: false })),
      getHistoricalBars: jest.fn(async () => history({ bars: [] })),
    });
    const provider = createReferenceProvider({ ibkr: providerApi, now: () => NOW });
    const snapshot = await provider.getSnapshot({ marketId: 'wti', selected: wtiSelection() });
    expect(snapshot.spot).toMatchObject({ status: 'unavailable', value: null });
    expect(snapshot.chart).toMatchObject({ status: 'unavailable', range: '1d', points: [] });
    const instruments = providerApi.getHistoricalBars.mock.calls.map(([instrument]) => instrument);
    expect(new Set(instruments.map((instrument) => instrument.lastTradeDateOrContractMonth)))
      .toEqual(new Set(['202610', '20260921', '20260922']));
    expect(providerApi.getHistoricalBars).toHaveBeenCalledWith(expect.objectContaining({ exchange: 'IPE', symbol: 'WTI' }), '1mo', '1h', { useRth: false });
  });

  test('does not let a slow WTI intraday subscription block an explicit refreshing state', async () => {
    const never = new Promise(() => {});
    const providerApi = ibkr({
      getQuote: jest.fn(() => never),
      getHistoricalBars: jest.fn(() => never),
    });
    const provider = createReferenceProvider({ ibkr: providerApi, now: () => NOW });
    const started = performance.now();
    const snapshot = await provider.getSnapshot({ marketId: 'wti', selected: wtiSelection() });
    expect(performance.now() - started).toBeLessThan(3_200);
    expect(snapshot.spot).toMatchObject({ status: 'refreshing', value: null });
    expect(snapshot.chart).toMatchObject({ status: 'refreshing', range: '1d', points: [] });
    expect(snapshot.backgroundRefresh).toBe(true);
  });

  test('publishes an IBKR worker result that completes after the initial poll window', async () => {
    const delayed = (value, delayMs = 850) => new Promise((resolve) => setTimeout(() => resolve(value), delayMs));
    const providerApi = ibkr({
      getQuote: jest.fn(() => delayed(canonicalQuote({ mark: 76.25, last: 76.25 }))),
      getHistoricalBars: jest.fn(() => delayed(history(), 425)),
    });
    const provider = createReferenceProvider({ ibkr: providerApi, now: () => NOW });

    const first = await provider.getSnapshot({ marketId: 'wti', selected: wtiSelection() });
    expect(first.backgroundRefresh).toBe(true);
    expect(first.chartReferences.basis.spot).toMatchObject({
      status: 'available', availability: 'live', value: 76.25,
      label: 'PROXY · CLV26',
    });
    expect(first.chartReferences.contract.spot).toMatchObject({ status: 'refreshing', value: null });

    await new Promise((resolve) => setTimeout(resolve, 800));
    const completed = await provider.getSnapshot({ marketId: 'wti', selected: wtiSelection() });
    expect(completed.spot).toMatchObject({ status: 'available', value: 76.25 });
    expect(providerApi.getQuote).toHaveBeenCalledTimes(2);
    expect(providerApi.getHistoricalBars.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(new Set(providerApi.getHistoricalBars.mock.calls.map(([instrument]) => instrument.displaySymbol)))
      .toEqual(new Set(['WBSV26', 'CLV26']));
  });

  test('returns a still-fresh verified chart immediately while its next provider refresh is slow', async () => {
    let clock = NOW;
    let slowRefresh = false;
    const delayed = (value, delayMs = 850) => new Promise((resolve) => setTimeout(() => resolve(value), delayMs));
    const providerApi = ibkr({
      getQuote: jest.fn(() => slowRefresh
        ? delayed(canonicalQuote({ mark: 76.25, last: 76.25 }))
        : Promise.resolve(canonicalQuote({ mark: 76.25, last: 76.25 }))),
      getHistoricalBars: jest.fn(async (_instrument, range) => history({
        bars: range === '1d'
          ? sessionBars(TEN_EXCHANGE_DATES.slice(-1), 79)
          : sessionBars(TEN_EXCHANGE_DATES, 70),
      })),
    });
    const provider = createReferenceProvider({ ibkr: providerApi, now: () => clock });
    const first = await provider.getSnapshot({ marketId: 'wti', selected: wtiSelection() });
    expect(first.chart.variants['10d']).toMatchObject({ status: 'available' });

    clock += 5_001;
    slowRefresh = true;
    const started = performance.now();
    const retained = await provider.getSnapshot({ marketId: 'wti', selected: wtiSelection() });

    expect(performance.now() - started).toBeLessThan(250);
    expect(retained.backgroundRefresh).toBe(true);
    expect(retained.spot).toMatchObject({
      status: 'available', value: 76.25, refreshing: false, refreshPending: true,
      refreshRetained: true, refreshFailed: false,
    });
    expect(retained.chart.variants).toMatchObject({
      '1d': { status: 'available', refreshing: false, refreshPending: true, refreshRetained: true },
      '5d': { status: 'available', refreshing: false, refreshPending: true, refreshRetained: true },
      '10d': { status: 'available', refreshing: false, refreshPending: true, refreshRetained: true },
    });

    await new Promise((resolve) => setTimeout(resolve, 900));
  });

  test('accepts only a fresh authenticated exact Pyth Pro Metal.Index.GOLD/USD observation', async () => {
    process.env.PYTH_API_KEY = 'test-key';
    const hourlyBars = sessionBars(TEN_EXCHANGE_DATES, 4100);
    const client = {
      get: jest.fn(async (url, options = {}) => url.endsWith('/symbols')
        ? { data: [{
          symbol: 'Metal.Index.GOLD/USD',
          state: 'stable',
          asset_type: 'metal',
          pyth_lazer_id: 346,
          min_channel: 'fixed_rate@200ms',
        }] }
        : options.params?.resolution === '60' ? {
          data: {
            s: 'ok',
            t: hourlyBars.map((bar) => Number(bar.date) / 1000),
            c: hourlyBars.map((bar) => bar.close),
          },
        } : {
          data: {
            s: 'ok',
            t: [NOW / 1000 - 300, NOW / 1000 - 60],
            c: [4198.5, 4200.1],
          },
        }),
      post: jest.fn(async () => ({
        data: {
          parsed: {
            timestampUs: String(NOW * 1000),
            priceFeeds: [{
              priceFeedId: 346,
              price: '420025',
              exponent: -2,
              feedUpdateTimestamp: String((NOW - 10_000) * 1000),
            }],
          },
        },
      })),
    };
    const riskHistory = jest.fn(async ({ ticker, dates }) => exactRiskRanges(ticker, dates));
    const providerApi = ibkr({ getProviderStatus: jest.fn(async () => ({ connected: false })) });
    const snapshot = await loadPythReference({
      marketId: 'gold',
      selected: {
        event: { settlement_sources: [{
          name: 'Pyth Network',
          url: 'https://app.pyth.com/explore/Metal.Index.GOLD%2FUSD?cluster=pythnet',
        }] },
        markets: [{ rules_primary: 'Settlement uses Pyth Metal.Index.GOLD/USD.' }],
      },
      client,
      nowMs: NOW,
      loadRiskRangeHistory: riskHistory,
    });
    expect(snapshot.spot).toMatchObject({
      status: 'available',
      value: 4200.25,
      source: 'pyth_pro_metal_index_gold_usd',
    });
    expect(client.get).toHaveBeenCalledWith(
      expect.stringMatching(/\/v1\/symbols$/),
      expect.objectContaining({
        params: { query: 'Metal.Index.GOLD/USD' },
      }),
    );
    expect(client.post).toHaveBeenCalledWith(
      expect.stringMatching(/\/v1\/latest_price$/),
      expect.objectContaining({
        priceFeedIds: [346],
        properties: ['price', 'exponent', 'feedUpdateTimestamp'],
        formats: [],
        channel: 'fixed_rate@200ms',
      }),
      expect.objectContaining({ headers: { Authorization: 'Bearer test-key' } }),
    );
    expect(client.get).toHaveBeenCalledWith(
      expect.stringMatching(/\/v1\/fixed_rate@200ms\/history$/),
      expect.objectContaining({
        params: expect.objectContaining({
          symbol: 'Metal.Index.GOLD/USD',
          resolution: '5',
        }),
        headers: { Authorization: 'Bearer test-key' },
      }),
    );
    expect(client.get).toHaveBeenCalledWith(
      expect.stringMatching(/\/v1\/fixed_rate@200ms\/history$/),
      expect.objectContaining({
        params: expect.objectContaining({
          symbol: 'Metal.Index.GOLD/USD',
          resolution: '60',
        }),
        headers: { Authorization: 'Bearer test-key' },
      }),
    );
    expect(snapshot.chart).toMatchObject({
      status: 'available',
      source: 'pyth_pro_history_metal_index_gold_usd',
      latestValue: 4200.25,
      variants: {
        '1d': { status: 'available', interval: '5m', fit: 'exact' },
        '5d': { status: 'available', interval: '1h', fit: 'exact' },
        '10d': { status: 'available', interval: '1h', fit: 'exact' },
      },
    });
    expect(snapshot.chart.variants['10d'].rangeDates).toEqual(TEN_EXCHANGE_DATES);
    expect(riskHistory).toHaveBeenCalledTimes(1);
    expect(providerApi.getHistoricalBars).not.toHaveBeenCalled();
  });

  test('uses live IBKR XAUUSD spot history when exact Kalshi Pyth access fails', async () => {
    process.env.PYTH_API_KEY = 'test-key';
    const rejected = Object.assign(new Error('HTTP 403'), { response: { status: 403 } });
    const client = { get: jest.fn(async () => { throw rejected; }) };
    const historicalQueue = {
      enqueue: jest.fn((_key, factory) => Promise.resolve().then(factory)),
      getHealth: jest.fn(() => ({ status: 'idle' })),
    };
    const providerApi = ibkr({
      getQuote: jest.fn(async () => canonicalQuote({ mark: 4_418.7, mid: 4_418.7, last: null })),
      getHistoricalBars: jest.fn(async (_instrument, _range, interval) => history({
        bars: interval === '1h'
          ? sessionBars(TEN_EXCHANGE_DATES, 4_390)
          : [
              { date: NOW - 5 * 60_000, close: 4_417.9 },
              { date: NOW - 60_000, close: 4_418.6 },
            ],
      })),
    });
    const provider = createReferenceProvider({
      client,
      ibkr: providerApi,
      historicalQueue,
      now: () => NOW,
    });
    const selected = {
      event: { settlement_sources: [{
        name: 'Pyth Network',
        url: 'https://app.pyth.com/explore/Metal.Index.GOLD%2FUSD',
      }] },
      markets: [{ rules_primary: 'Settlement uses Pyth Metal.Index.GOLD/USD.' }],
    };
    const snapshot = await provider.getSnapshot({ marketId: 'gold', selected });
    expect(snapshot.spot).toMatchObject({
      status: 'available', value: 4_418.6, fit: 'proxy', executable: false,
      label: 'PROXY · XAUUSD CURRENT BAR',
      reason: expect.stringMatching(/spot-gold proxy/i),
    });
    expect(snapshot.chart).toMatchObject({
      status: 'available', fit: 'proxy', executable: false,
      variants: {
        '5d': { status: 'available', interval: '1h' },
        '10d': { status: 'available', interval: '1h' },
      },
    });
    expect(snapshot.instrument).toEqual(GOLD_SPOT_PROXY_INSTRUMENT);
    expect(snapshot.directionalFeed).toBeUndefined();
    expect(snapshot.exactReference.spot).toMatchObject({
      status: 'unavailable', errorCode: 'PYTH_ENTITLEMENT_REQUIRED',
    });
    expect(snapshot.goldMarketReferences[1]).toMatchObject({
      key: 'xauusd', status: 'live', previousClose: expect.any(Number),
      changePercent: expect.any(Number),
    });
    expect(providerApi.getQuote).toHaveBeenCalledWith(GOLD_SPOT_PROXY_INSTRUMENT);
    expect(providerApi.getHistoricalBars).toHaveBeenNthCalledWith(
      1,
      GOLD_SPOT_PROXY_INSTRUMENT, '1d', '5m', { useRth: false },
    );
    expect(providerApi.getHistoricalBars).toHaveBeenNthCalledWith(
      2,
      GOLD_SPOT_PROXY_INSTRUMENT, '1mo', '1h', { useRth: false },
    );
    expect(historicalQueue.enqueue.mock.calls[0][0]).toContain(':1mo:1h:');
    expect(historicalQueue.enqueue.mock.calls.some(([key]) => (
      key.includes(':XAUUSD:') && key.includes(':1d:5m:')
    ))).toBe(false);
    expect(providerApi.getHistoricalBars.mock.calls.some(([instrument, range]) => (
      instrument?.symbol === 'XAUUSD' && range === '6mo'
    ))).toBe(false);
    expect(client.get).toHaveBeenCalled();
  });

  test('attaches one verified XAUUSD midpoint ATH to every Gold chart range', async () => {
    const providerApi = ibkr({
      getQuote: jest.fn(async () => canonicalQuote({ mark: 4_418.7, mid: 4_418.7, last: null })),
      getHistoricalBars: jest.fn(async (_instrument, _range, interval) => history({
        bars: interval === '1h'
          ? goldHourlySessionBars(TEN_EXCHANGE_DATES, 4_390)
          : [
              { date: NOW - 5 * 60_000, close: 4_417.9 },
              { date: NOW - 60_000, close: 4_418.6 },
            ],
      })),
      getHistoricalRecord: jest.fn(async (_instrument, throughDate) => ({
        status: 'available',
        source: 'ibkr',
        dataset: 'historical_record',
        asOf: AS_OF,
        throughDate,
        recordHigh: 4_550.25,
        recordDate: '2026-08-14',
        coverage: {
          complete: true,
          startDate: '2000-01-03',
          endDate: throughDate,
          headDate: '2000-01-03',
          chunks: 3,
          observations: 6_500,
        },
        reason: null,
      })),
    });
    const provider = createReferenceProvider({
      ibkr: providerApi,
      client: { get: jest.fn(), post: jest.fn() },
      loadKalshiGoldSettlements: async () => ({ events: [] }),
      now: () => NOW,
    });

    const snapshot = await provider.getSnapshot({ marketId: 'gold', selected: null });

    for (const range of ['1d', '5d', '10d']) {
      expect(snapshot.chart.variants[range].ath).toMatchObject({
        status: 'available',
        source: 'ibkr_historical_record',
        value: 4_550.25,
        date: '2026-08-14',
        baseline: {
          value: 4_550.25,
          date: '2026-08-14',
          coverageComplete: true,
        },
      });
    }
    expect(providerApi.getHistoricalRecord).toHaveBeenCalledTimes(2);
    expect(providerApi.getHistoricalRecord).toHaveBeenCalledWith(
      GOLD_SPOT_PROXY_INSTRUMENT,
      '2026-08-18',
    );
    expect(providerApi.getHistoricalRecord).toHaveBeenCalledWith(
      expect.objectContaining({ symbol: 'GC', displaySymbol: 'GCZ26', conId: 1003 }),
      '2026-08-18',
    );
  });

  test('builds Gold 5D and 10D from hourly resolver sessions and skips a one-point session after the maintenance break', async () => {
    const currentTime = Date.parse('2026-08-18T22:30:00.000Z');
    const completedDates = recentWeekdays(10, '2026-08-18');
    const currentHourlyPoint = {
      date: Date.parse('2026-08-18T22:00:00.000Z'),
      close: 4_410,
    };
    const providerApi = ibkr({
      getQuote: jest.fn(async () => canonicalQuote({ valid: false, mark: null, last: null })),
      getHistoricalBars: jest.fn(async (instrument, _range, interval) => history({
        bars: interval === '5m' && instrument?.symbol === 'XAUUSD'
          ? [
              { date: Date.parse('2026-08-18T22:20:00.000Z'), close: 4_410.1 },
              { date: Date.parse('2026-08-18T22:25:00.000Z'), close: 4_410.2 },
            ]
          : interval === '1h'
            ? [...goldHourlySessionBars(completedDates), currentHourlyPoint]
            : goldHourlySessionBars(completedDates),
      })),
    });
    const provider = createReferenceProvider({
      ibkr: providerApi,
      client: { get: jest.fn(), post: jest.fn() },
      loadKalshiGoldSettlements: async () => ({ events: [] }),
      now: () => currentTime,
    });
    const selected = {
      id: 'kalshi',
      event: {
        event_ticker: 'KXGOLDD-26AUG1917',
        closeTime: '2026-08-19T21:00:00.000Z',
        settlement_sources: [{
          name: 'Pyth Network',
          url: 'https://app.pyth.com/explore/Metal.Index.GOLD%2FUSD',
        }],
      },
      markets: [{ rules_primary: 'Settlement uses Pyth Metal.Index.GOLD/USD.' }],
    };

    const snapshot = await provider.getSnapshot({ marketId: 'gold', selected });
    expect(snapshot.chart.variants['1d']).toMatchObject({
      status: 'available', interval: '5m', rangeDates: ['2026-08-19'],
      sessionWindow: {
        startAt: '2026-08-18T21:00:00.000Z',
        endAt: '2026-08-19T21:00:00.000Z',
      },
    });
    expect(snapshot.chart.variants['1d'].points[0].timestamp)
      .toBeGreaterThanOrEqual(Date.parse('2026-08-18T22:00:00.000Z'));
    expect(snapshot.chart.variants['5d']).toMatchObject({
      status: 'historical', interval: '1h', rangeDates: completedDates.slice(-5),
    });
    expect(snapshot.chart.variants['10d']).toMatchObject({
      status: 'historical', interval: '1h', rangeDates: completedDates,
    });
    expect(snapshot.chart.variants['10d'].rangeDates).not.toContain('2026-08-19');
    expect(providerApi.getHistoricalBars).toHaveBeenCalledWith(
      GOLD_SPOT_PROXY_INSTRUMENT, '1mo', '1h', { useRth: false },
    );
  });

  test('keeps Gold 1D rendered from verified hourly XAUUSD while five-minute history refreshes', async () => {
    const providerApi = ibkr({
      getQuote: jest.fn(async () => canonicalQuote({ valid: false, mark: null, last: null })),
      getHistoricalBars: jest.fn(async (instrument, _range, interval) => history({
        bars: instrument?.symbol === 'XAUUSD' && interval === '5m'
          ? []
          : goldHourlySessionBars(TEN_EXCHANGE_DATES).filter((bar) => bar.date <= NOW),
      })),
    });
    const provider = createReferenceProvider({
      ibkr: providerApi,
      client: { get: jest.fn(), post: jest.fn() },
      loadKalshiGoldSettlements: async () => ({ events: [] }),
      now: () => NOW,
    });

    const result = await provider.getSnapshot({ marketId: 'gold', selected: null });

    expect(result.chart.variants['1d']).toMatchObject({
      status: 'available',
      interval: '1h',
      resolutionState: 'coarser_verified',
      source: 'ibkr_historical_bars',
      rangeDates: ['2026-08-19'],
    });
    expect(result.chart.variants['1d'].points.length).toBeGreaterThan(1);
    expect(result.goldMarketReferences.find((reference) => reference.key === 'xauusd'))
      .toMatchObject({ status: 'live', source: 'ibkr_historical_bars', price: expect.any(Number) });
  });

  test('releases a wedged priority XAUUSD request and upgrades the retained hourly 1D chart on retry', async () => {
    let clock = NOW;
    let fiveMinuteCalls = 0;
    const providerApi = ibkr({
      getQuote: jest.fn(async () => canonicalQuote({ valid: false, mark: null, last: null })),
      getHistoricalBars: jest.fn((instrument, _range, interval) => {
        if (instrument?.symbol === 'XAUUSD' && interval === '5m') {
          fiveMinuteCalls += 1;
          if (fiveMinuteCalls === 1) return new Promise(() => {});
          return Promise.resolve(history({ bars: sessionBars(['2026-08-19'], 4_430) }));
        }
        return Promise.resolve(history({
          bars: goldHourlySessionBars(TEN_EXCHANGE_DATES).filter((bar) => bar.date <= clock),
        }));
      }),
    });
    const provider = createReferenceProvider({
      ibkr: providerApi,
      client: { get: jest.fn(), post: jest.fn() },
      loadKalshiGoldSettlements: async () => ({ events: [] }),
      now: () => clock,
      priorityIbkrHistoryTimeoutMs: 50,
    });

    const retained = await provider.getSnapshot({ marketId: 'gold', selected: null });
    expect(retained.chart.variants['1d']).toMatchObject({
      status: 'available', interval: '1h', resolutionState: 'coarser_verified',
    });

    clock += 5_001;
    const upgraded = await provider.getSnapshot({ marketId: 'gold', selected: null });
    expect(fiveMinuteCalls).toBe(2);
    expect(upgraded.chart.variants['1d']).toMatchObject({
      status: 'available', interval: '5m',
    });
    expect(upgraded.chart.variants['1d'].resolutionState).not.toBe('coarser_verified');
  });

  test('rejects mismatched XAUUSD history so it cannot supply a prior close or percentage', async () => {
    const providerApi = ibkr({
      getQuote: jest.fn(async (instrument) => (
        instrument?.symbol === 'XAUUSD'
          ? canonicalQuote({ mark: 4_418.7, mid: 4_418.7, last: 4_418.7 })
          : canonicalQuote()
      )),
      getHistoricalBars: jest.fn(async (instrument, _range, interval) => {
        if (instrument?.symbol !== 'XAUUSD') return history();
        return history({
          bars: interval === '1h'
            ? goldHourlySessionBars(TEN_EXCHANGE_DATES)
            : sessionBars(TEN_EXCHANGE_DATES.slice(-1), 4_400),
          contract: {
            conId: GOLD_SPOT_PROXY_INSTRUMENT.conId + 1,
            symbol: 'XAUUSD',
            secType: 'CMDTY',
            exchange: 'SMART',
            currency: 'USD',
          },
        });
      }),
    });
    const provider = createReferenceProvider({ ibkr: providerApi, now: () => NOW });

    const snapshot = await provider.getSnapshot({ marketId: 'gold', selected: null });
    const spotGold = snapshot.goldMarketReferences.find((reference) => reference.key === 'xauusd');

    expect(spotGold).toMatchObject({
      status: 'live', price: 4_418.7, previousClose: null, changePercent: null,
    });
    expect(snapshot.chart.variants['5d']).toMatchObject({ status: 'unavailable', points: [] });
    expect(snapshot.chart.variants['10d']).toMatchObject({ status: 'unavailable', points: [] });
  });

  test('publishes the verified active COMEX quote when IBKR needs longer than the first-paint probe', async () => {
    const providerApi = ibkr({
      getQuote: jest.fn(async (instrument) => {
        if (instrument?.symbol === 'GC') {
          await new Promise((resolve) => setTimeout(resolve, 150));
          return canonicalQuote({ mark: 4_481.8, last: 4_481.8 });
        }
        return canonicalQuote({ mark: 4_432.7, last: 4_432.7 });
      }),
      getHistoricalBars: jest.fn(async (instrument, range, interval) => {
        if (instrument?.symbol === 'GC' && range === '1mo' && interval === '1h') {
          return history({ bars: goldHourlySessionBars(TEN_EXCHANGE_DATES, 4_450) });
        }
        return history();
      }),
    });
    const provider = createReferenceProvider({
      ibkr: providerApi,
      client: { get: jest.fn(), post: jest.fn() },
      now: () => NOW,
    });

    const snapshot = await provider.getSnapshot({ marketId: 'gold', selected: null });

    expect(snapshot.goldMarketReferences[2]).toMatchObject({
      key: 'activeComex',
      symbol: 'GCZ26',
      status: 'live',
      price: 4_481.8,
      source: 'ibkr_live_native_quote',
      previousClose: expect.any(Number),
      changePercent: expect.any(Number),
    });
  });

  test('returns a terminal Pyth entitlement result for settlement diagnostics without changing the card feed', async () => {
    process.env.PYTH_API_KEY = 'test-key';
    const rejected = Object.assign(new Error('HTTP 403'), { response: { status: 403, data: {} } });
    const client = {
      get: jest.fn(() => Promise.reject(rejected)),
      post: jest.fn(),
    };
    const selected = {
      event: { settlement_sources: [{
        name: 'Pyth Network',
        url: 'https://app.pyth.com/explore/Metal.Index.GOLD%2FUSD',
      }] },
      markets: [{ rules_primary: 'Settlement uses Pyth Metal.Index.GOLD/USD.' }],
    };
    const terminal = await loadPythReference({
      marketId: 'gold', selected, client, nowMs: NOW,
      loadRiskRangeHistory: async () => ({ status: 'unavailable', ranges: {}, missingDates: [] }),
    });
    expect(terminal.spot).toMatchObject({
      status: 'unavailable', errorCode: 'PYTH_ENTITLEMENT_REQUIRED', refreshFailed: true,
    });
    expect(terminal.chart.variants).toMatchObject({
      '1d': { status: 'unavailable', points: [] },
      '5d': { status: 'unavailable', points: [] },
      '10d': { status: 'unavailable', points: [] },
    });
  });

  test('releases and retries a wedged Gold reference refresh', async () => {
    process.env.PYTH_API_KEY = 'test-key';
    let symbolCalls = 0;
    const rejected = Object.assign(new Error('HTTP 403'), { response: { status: 403, data: {} } });
    const client = {
      get: jest.fn(() => {
        symbolCalls += 1;
        if (symbolCalls === 1) return new Promise(() => {});
        return Promise.reject(rejected);
      }),
      post: jest.fn(),
    };
    const providerApi = ibkr({
      getQuote: jest.fn(async () => canonicalQuote({ mark: 4_418.7, last: null })),
      getHistoricalBars: jest.fn(async (instrument, _range, interval) => history({
        bars: interval === '1h'
          ? goldHourlySessionBars(TEN_EXCHANGE_DATES)
          : sessionBars(['2026-08-19'], 4_410),
      })),
    });
    const provider = createReferenceProvider({
      client,
      ibkr: providerApi,
      now: () => NOW,
      goldReferenceRefreshTimeoutMs: 100,
      loadKalshiGoldSettlements: async () => ({ events: [] }),
    });
    const selected = {
      id: 'kalshi',
      event: {
        event_ticker: 'KXGOLDD-26AUG1917',
        closeTime: '2026-08-19T21:00:00.000Z',
        settlement_sources: [{
          name: 'Pyth Network',
          url: 'https://app.pyth.com/explore/Metal.Index.GOLD%2FUSD',
        }],
      },
      markets: [{ rules_primary: 'Settlement uses Pyth Metal.Index.GOLD/USD.' }],
    };

    await expect(provider.getSnapshot({ marketId: 'gold', selected })).rejects.toMatchObject({
      code: 'GOLD_REFERENCE_REFRESH_TIMEOUT',
    });

    const recovered = await provider.getSnapshot({ marketId: 'gold', selected });
    expect(symbolCalls).toBe(2);
    expect(recovered.chart.variants['1d']).toMatchObject({
      status: 'available', source: 'ibkr_historical_bars',
    });
    expect(recovered.goldMarketReferences.find((reference) => reference.key === 'xauusd'))
      .toMatchObject({ status: 'live', price: expect.any(Number) });
  });

  test('keeps the Pyth Silver resolver closed while publishing SIZ26 in both chart roles', async () => {
    delete process.env.PYTH_API_KEY;
    delete process.env.HERMES_API_KEY;
    const providerApi = ibkr({
      getQuote: jest.fn(async () => canonicalQuote({ mark: 74.25, last: 74.25 })),
      getHistoricalBars: jest.fn(async () => history({
        bars: [{ date: NOW - 5 * 60_000, close: 74.1 }, { date: NOW - 60_000, close: 74.2 }],
      })),
    });
    const nativeSilverInstrument = {
      ...TEST_DIRECTIONAL_INSTRUMENTS.silver,
      displaySymbol: 'SIZ6',
      localSymbol: 'SIZ6',
    };
    const provider = createReferenceProvider({
      ibkr: providerApi,
      now: () => NOW,
      loadDirectionalSelection: async () => ({
        instrument: nativeSilverInstrument,
        rollReason: 'test_verified_selection',
        refreshPending: false,
      }),
    });
    const snapshot = await provider.getSnapshot({ marketId: 'silver', selected: null });

    expect(snapshot.spot).toMatchObject({
      status: 'unavailable', value: null, fit: 'exact', executable: false,
    });
    expect(snapshot.chart).toMatchObject({ status: 'unavailable', fit: 'exact', executable: false });
    expect(snapshot.directionalFeed).toBeUndefined();
    expect(snapshot.chartReferences).toMatchObject({
      basis: {
        role: 'risk_range_basis', symbol: 'SILVER', riskRangeTicker: 'SILVER',
        instrument: { displaySymbol: 'SIZ26', localSymbol: 'SIZ6', conId: 1004 },
      },
      contract: {
        role: 'proxy_reference', symbol: 'SIZ26', exact: false,
        instrument: { displaySymbol: 'SIZ26', localSymbol: 'SIZ6', conId: 1004 },
        spot: { status: 'available', value: 74.25 },
        disclosure: expect.stringMatching(/not the Pyth resolver/i),
      },
    });
    expect(providerApi.getQuote).toHaveBeenCalledWith(expect.objectContaining({
      displaySymbol: 'SIZ26', localSymbol: 'SIZ6', conId: 1004,
    }));
    expect(providerApi.getHistoricalBars).toHaveBeenCalledTimes(3);
  });

  test('keeps the active BZ directional contract independent from an event-specific Pyth month', async () => {
    const selected = {
      markets: [
        { custom_strike: { front_month_contract: 'BRENTV6' } },
        { custom_strike: { front_month_contract: 'BRENTV6' } },
      ],
    };
    expect(brentIbkrInstrument(selected)).toMatchObject({
      displaySymbol: 'BZV26', lastTradeDateOrContractMonth: '202610', exchange: 'NYMEX',
    });
    expect(brentIbkrInstrument({ markets: [
      { custom_strike: { front_month_contract: 'BRENTV6' } },
      { custom_strike: { front_month_contract: 'BRENTX6' } },
    ] })).toBeNull();

    const providerApi = ibkr();
    const provider = createReferenceProvider({ ibkr: providerApi, now: () => NOW });
    const snapshot = await provider.getSnapshot({ marketId: 'brent', selected });
    expect(snapshot.spot).toMatchObject({ status: 'available', fit: 'proxy', executable: false });
    expect(snapshot.chartReferences).toMatchObject({
      basis: {
        role: 'risk_range_basis', symbol: 'BRENT', riskRangeTicker: 'BRENT',
        instrument: { displaySymbol: 'BZX26', conId: 1005 },
      },
      contract: {
        role: 'proxy_reference', symbol: 'BZV26', exact: false,
        instrument: { displaySymbol: 'BZV26', lastTradeDateOrContractMonth: '202610' },
      },
    });
    expect(providerApi.getQuote).toHaveBeenCalledWith(expect.objectContaining({
      symbol: 'BZ', displaySymbol: 'BZV26', lastTradeDateOrContractMonth: '202610', exchange: 'NYMEX',
    }));
  });

  test('maps the current N/A Brent contract to the stable Pyth index and a labeled independent BZ proxy', async () => {
    const selected = {
      event: {
        settlement_sources: [{ name: 'Pyth Network', url: 'https://pyth.network/price-feeds' }],
      },
      markets: [100, 110].map((threshold) => ({
        rules_primary: `The close price of the 1-minute Brent crude oil candlestick must be above ${threshold}.`,
        custom_strike: { front_month_contract: 'N/A' },
      })),
    };
    expect(pythReferenceConfig('brent', selected)).toMatchObject({
      symbol: 'Commodities.Index.BRENT/USD',
      label: 'BRENT',
      assetType: 'commodity',
    });
    expect(brentIbkrInstrument(selected, NOW)).toBeNull();

    delete process.env.PYTH_API_KEY;
    delete process.env.HERMES_API_KEY;
    const providerApi = ibkr();
    const provider = createReferenceProvider({ ibkr: providerApi, now: () => NOW });
    const snapshot = await provider.getSnapshot({ marketId: 'brent', selected });
    expect(snapshot.spot).toMatchObject({
      status: 'available', fit: 'proxy', executable: false,
      label: 'PROXY · BZX26',
    });
    expect(snapshot.chart).toMatchObject({ status: 'available' });
    expect(snapshot.proxyFit).toMatchObject({
      exactResolverSymbol: 'Commodities.Index.BRENT/USD',
      exactResolverUrl: 'https://pyth.dourolabs.app/v1/symbols?query=BRENT',
      exactResolverEntitlement: 'authenticated_history_unavailable',
    });
    expect(snapshot.chartReferences).toMatchObject({
      basis: {
        role: 'risk_range_basis', symbol: 'BRENT', riskRangeTicker: 'BRENT',
        instrument: {
          displaySymbol: 'BZX26', localSymbol: 'BZX6', conId: 1005,
          contractMonth: '202611', lastTradeDate: '20260930',
        },
      },
      contract: {
        role: 'proxy_reference', symbol: 'BZX26', exact: false,
        instrument: { displaySymbol: 'BZX26', conId: 1005 },
        disclosure: expect.stringMatching(/does not compare against Pyth history/i),
      },
    });
    expect(snapshot.exactReference).toMatchObject({
      resolver: 'Pyth Commodities.Index.BRENT/USD',
      spot: {
        status: 'unavailable',
        errorCode: 'PYTH_ENTITLEMENT_REQUIRED',
        reason: expect.stringMatching(/authenticated entitlement/i),
      },
    });
    expect(providerApi.getQuote).toHaveBeenCalledWith(expect.objectContaining({
      symbol: 'BZ', displaySymbol: 'BZX26', conId: 1005, exchange: 'NYMEX',
    }));
  });

  test.each([
    ['wrong local delivery month', { conId: 1005, localSymbol: 'BZZ6' }],
    ['wrong conId', { conId: 9999, localSymbol: 'BZX6' }],
  ])('rejects active Brent history with a %s', async (_label, contractOverride) => {
    const selected = {
      event: {
        settlement_sources: [{ name: 'Pyth Network', url: 'https://pyth.network/price-feeds' }],
      },
      markets: [100, 110].map((threshold) => ({
        rules_primary: `The close price of the 1-minute Brent crude oil candlestick must be above ${threshold}.`,
        rules_secondary: 'The settlement candlestick is published by Pyth.',
        custom_strike: { front_month_contract: 'N/A' },
      })),
    };
    const providerApi = ibkr({
      getHistoricalBars: jest.fn(async (instrument) => ({
        ...history({
          bars: [{ date: NOW - 5 * 60_000, close: 86.1 }, { date: NOW - 60_000, close: 86.2 }],
        }),
        contract: {
          symbol: instrument.symbol,
          localSymbol: contractOverride.localSymbol,
          conId: contractOverride.conId,
          secType: 'FUT', exchange: 'NYMEX', currency: 'USD', multiplier: '1000',
          tradingClass: 'BZ', lastTradeDateOrContractMonth: '20260930', provider: 'ibkr',
        },
      })),
    });
    const provider = createReferenceProvider({ ibkr: providerApi, now: () => NOW });

    const snapshot = await provider.getSnapshot({ marketId: 'brent', selected });

    expect(snapshot.chartReferences.basis.chart.variants).toMatchObject({
      '1d': { status: 'unavailable', points: [] },
      '5d': { status: 'unavailable', points: [] },
      '10d': { status: 'unavailable', points: [] },
    });
    expect(snapshot.chartReferences.contract.chart.variants['1d']).toMatchObject({
      status: 'unavailable', points: [],
    });
  });

  test('uses fresh Coinbase BTC only as a BRTI proxy and rejects a stale ticker', async () => {
    let clock = NOW;
    let dailyRecordCalls = 0;
    const calendarDates = ['2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13', '2026-08-14', '2026-08-15', '2026-08-16', '2026-08-17', '2026-08-18', '2026-08-19'];
    const hourlyCandles = calendarDates.flatMap((date, index) => [
      [Date.parse(`${date}T05:00:00.000Z`) / 1000, 118000, 119000, 118100, 118200 + index, 20],
      [date === calendarDates[calendarDates.length - 1] ? NOW / 1000 - 60 : Date.parse(`${date}T06:00:00.000Z`) / 1000, 118000, 119000, 118100, 118250 + index, 20],
    ]);
    const client = {
      get: jest.fn(async (url, options = {}) => url.endsWith('/ticker')
        ? { data: { price: '118500.25', time: new Date(NOW - 10_000).toISOString() } }
        : options.params?.granularity === 86400
          ? (() => {
              dailyRecordCalls += 1;
              return dailyRecordCalls === 1 ? { data: [
                [Date.parse('2026-08-18T00:00:00.000Z') / 1000, 100000, 130000, 110000, 118000, 100],
                [Date.parse('2026-01-01T00:00:00.000Z') / 1000, 40000, 90000, 50000, 80000, 100],
              ] } : { data: [] };
            })()
          : options.params?.granularity === 3600 ? { data: hourlyCandles } : { data: [
            [NOW / 1000 - 60, 118400, 118600, 118450, 118500, 20],
            [NOW / 1000 - 300, 118200, 118500, 118300, 118450, 25],
          ] }),
    };
    const riskHistory = jest.fn(async ({ ticker, dates }) => {
      const publicationDates = dates.filter((date) => {
        const weekday = new Date(`${date}T12:00:00.000Z`).getUTCDay();
        return weekday !== 0 && weekday !== 6;
      });
      const missingDates = dates.filter((date) => !publicationDates.includes(date));
      return {
        ...exactRiskRanges(ticker, publicationDates),
        status: missingDates.length ? 'unavailable' : 'available',
        missingDates,
        reason: missingDates.length
          ? `Exact-date Risk Range data is unavailable for ${missingDates.join(', ')}.`
          : null,
      };
    });
    const provider = createReferenceProvider({ client, now: () => clock, loadRiskRangeHistory: riskHistory });
    const snapshot = await provider.getSnapshot({ marketId: 'bitcoin', selected: null });
    expect(snapshot.spot).toMatchObject({
      status: 'available', value: 118500.25, fit: 'proxy', executable: false,
      source: 'coinbase_exchange_public_ticker',
    });
    expect(snapshot.chart).toMatchObject({
      status: 'available', fit: 'proxy', executable: false,
      source: 'coinbase_exchange_public_candles',
      variants: {
        '1d': { status: 'available', interval: '5m' },
        '5d': { status: 'available', interval: '1h' },
        '10d': { status: 'available', interval: '1h' },
      },
    });
    expect(snapshot.chartReferences).toMatchObject({
      basis: {
        role: 'risk_range_basis', symbol: 'BITCOIN', riskRangeTicker: 'BITCOIN',
        exact: true, spot: { value: 118500.25 },
      },
      contract: {
        role: 'proxy_reference', symbol: 'BTC-USD', exact: false,
        spot: { value: 118500.25 },
        disclosure: expect.stringMatching(/not the CF Benchmarks BRTI resolver/i),
      },
    });
    expect(snapshot.chart.variants['10d'].rangeDates).toEqual(calendarDates);
    expect(snapshot.chart.variants).toMatchObject({
      '1d': {
        ath: { status: 'available', value: 130000, date: '2026-08-18' },
        previousCloseSource: 'coinbase_exchange_public_candles',
      },
      '5d': {
        ath: { status: 'available', value: 130000, date: '2026-08-18' },
        previousCloseSource: 'coinbase_exchange_public_candles',
      },
      '10d': {
        ath: { status: 'available', value: 130000, date: '2026-08-18' },
        previousCloseSource: 'coinbase_exchange_public_candles',
      },
    });
    expect(snapshot.chart.variants['10d']).toMatchObject({
      riskRangeStatus: 'available',
      riskRangeMissingDates: [],
    });
    expect(snapshot.chart.variants['10d'].dailyRanges.find((range) => range.date === '2026-08-15'))
      .toMatchObject({
        status: 'available',
        riskRangePublicationDate: '2026-08-14',
        riskRangeCarryForward: 'last_published_non_publication_session',
        references: [
          expect.objectContaining({ label: 'LRR', asOf: '2026-08-14', carriedForward: true }),
          expect.objectContaining({ label: 'HRR', asOf: '2026-08-14', carriedForward: true }),
        ],
      });
    expect(snapshot.chart.variants['10d'].dailyRanges.find((range) => range.date === '2026-08-16'))
      .toMatchObject({
        status: 'available',
        riskRangePublicationDate: '2026-08-14',
        riskRangeCarryForward: 'last_published_non_publication_session',
      });
    expect(snapshot.chart.variants['10d'].points.some((point) => (
      new Date(point.timestamp).toISOString().slice(0, 10) === '2026-08-15'
    ))).toBe(true);
    expect(client.get).toHaveBeenCalledWith(
      expect.stringMatching(/\/products\/BTC-USD\/candles$/),
      expect.objectContaining({ params: expect.objectContaining({ granularity: 300 }) }),
    );
    expect(client.get).toHaveBeenCalledWith(
      expect.stringMatching(/\/products\/BTC-USD\/candles$/),
      expect.objectContaining({ params: expect.objectContaining({ granularity: 3600 }) }),
    );
    expect(riskHistory).toHaveBeenCalledTimes(1);

    client.get.mockImplementation(async (url) => url.endsWith('/ticker')
      ? { data: { price: '118500.25', time: new Date(NOW - 120_000).toISOString() } }
      : { data: [] });
    clock += 5_001;
    const stale = await provider.getSnapshot({ marketId: 'bitcoin', selected: null });
    expect(stale.spot).toMatchObject({ status: 'unavailable', value: null });
    expect(stale.chart).toMatchObject({ status: 'unavailable', points: [] });
  });

  test('publishes verified BTC spot and 1D candles without waiting for a slow Risk Range overlay', async () => {
    let dailyRecordCalls = 0;
    const calendarDates = [
      '2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13', '2026-08-14',
      '2026-08-15', '2026-08-16', '2026-08-17', '2026-08-18', '2026-08-19',
    ];
    const hourlyCandles = calendarDates.flatMap((date, index) => [
      [Date.parse(`${date}T05:00:00.000Z`) / 1000, 118000, 119000, 118100, 118200 + index, 20],
      [date === calendarDates.at(-1) ? NOW / 1000 - 60 : Date.parse(`${date}T23:00:00.000Z`) / 1000,
        118000, 119000, 118100, 118250 + index, 20],
    ]);
    const client = {
      get: jest.fn(async (url, options = {}) => url.endsWith('/ticker')
        ? { data: { price: '118500.25', time: new Date(NOW - 10_000).toISOString() } }
        : options.params?.granularity === 86400
          ? (() => {
              dailyRecordCalls += 1;
              return dailyRecordCalls === 1 ? { data: [
                [Date.parse('2026-08-18T00:00:00.000Z') / 1000, 100000, 130000, 110000, 118000, 100],
                [Date.parse('2026-01-01T00:00:00.000Z') / 1000, 40000, 90000, 50000, 80000, 100],
              ] } : { data: [] };
            })()
          : options.params?.granularity === 3600 ? { data: hourlyCandles } : { data: [
            [NOW / 1000 - 60, 118400, 118600, 118450, 118500, 20],
            [NOW / 1000 - 300, 118200, 118500, 118300, 118450, 25],
          ] }),
    };
    const riskHistory = jest.fn(() => new Promise(() => {}));
    const provider = createReferenceProvider({ client, now: () => NOW, loadRiskRangeHistory: riskHistory });

    const started = performance.now();
    const snapshot = await provider.getSnapshot({ marketId: 'bitcoin', selected: null });

    expect(performance.now() - started).toBeLessThan(700);
    expect(snapshot.spot).toMatchObject({
      status: 'available', availability: 'live', value: 118500.25,
      source: 'coinbase_exchange_public_ticker', fit: 'proxy',
    });
    expect(snapshot.chart.variants).toMatchObject({
      '1d': {
        status: 'available', interval: '5m', riskRangeRefreshPending: true,
        source: 'coinbase_exchange_public_candles',
      },
      '5d': { status: 'available', interval: '1h', riskRangeRefreshPending: true },
      '10d': { status: 'available', interval: '1h', riskRangeRefreshPending: true },
    });
    expect(snapshot.backgroundRefresh).toBe(false);
    expect(snapshot.secondaryContextRefreshPending).toBe(true);
    expect(riskHistory).toHaveBeenCalledTimes(1);
  });

  test('trims Bitcoin 1D to the selected hourly contract instead of a calendar day', async () => {
    const openAt = '2026-08-19T15:00:00.000Z';
    const closeAt = '2026-08-19T17:00:00.000Z';
    const hourlyDates = TEN_EXCHANGE_DATES.map((date, index) => [
      Date.parse(`${date}T05:00:00.000Z`) / 1000, 100, 110, 90, 100 + index, 10,
    ]);
    const client = {
      get: jest.fn(async (url, options = {}) => {
        if (url.endsWith('/ticker')) {
          return { data: { price: '118500.25', time: new Date(NOW - 10_000).toISOString() } };
        }
        if (options.params?.granularity === 86400) return { data: [] };
        if (options.params?.granularity === 3600) return { data: hourlyDates };
        return { data: [
          [Date.parse('2026-08-19T14:55:00.000Z') / 1000, 1, 1, 1, 117900, 10],
          [Date.parse('2026-08-19T15:05:00.000Z') / 1000, 1, 1, 1, 118100, 10],
          [Date.parse('2026-08-19T15:55:00.000Z') / 1000, 1, 1, 1, 118400, 10],
        ] };
      }),
    };
    const selected = {
      event: { event_ticker: 'KXBTCD-26AUG1913' },
      markets: [{ open_time: openAt }],
      closeTime: closeAt,
    };
    const provider = createReferenceProvider({ client, now: () => NOW });

    const snapshot = await provider.getSnapshot({ marketId: 'bitcoin', selected });

    expect(snapshot.chart).toMatchObject({
      status: 'available',
      sessionWindow: {
        profileId: 'event_window', startAt: openAt, endAt: closeAt,
      },
    });
    expect(snapshot.chart.points.map((point) => point.timestamp)).toEqual([
      Date.parse('2026-08-19T15:05:00.000Z'),
      Date.parse('2026-08-19T15:55:00.000Z'),
      NOW - 10_000,
    ]);
  });

  test('releases and retries a wedged Coinbase reference refresh', async () => {
    let tickerCalls = 0;
    const client = {
      get: jest.fn((url, options = {}) => {
        if (url.endsWith('/ticker')) {
          tickerCalls += 1;
          if (tickerCalls === 1) return new Promise(() => {});
          return Promise.resolve({
            data: { price: '118500.25', time: new Date(NOW - 10_000).toISOString() },
          });
        }
        if (options.params?.granularity === 86400) return new Promise(() => {});
        if (options.params?.granularity === 3600) {
          return Promise.resolve({ data: [
            [NOW / 1000 - 60, 118400, 118600, 118450, 118500, 20],
            [NOW / 1000 - 3_600, 118200, 118500, 118300, 118450, 25],
          ] });
        }
        return Promise.resolve({ data: [
          [NOW / 1000 - 60, 118400, 118600, 118450, 118500, 20],
          [NOW / 1000 - 300, 118200, 118500, 118300, 118450, 25],
        ] });
      }),
    };
    const provider = createReferenceProvider({
      client,
      now: () => NOW,
      coinbaseReferenceRefreshTimeoutMs: 250,
    });

    await expect(provider.getSnapshot({ marketId: 'bitcoin', selected: null })).rejects.toMatchObject({
      code: 'COINBASE_REFERENCE_REFRESH_TIMEOUT',
    });

    const recovered = await provider.getSnapshot({ marketId: 'bitcoin', selected: null });

    expect(tickerCalls).toBe(2);
    expect(recovered.spot).toMatchObject({
      status: 'available', availability: 'live', value: 118500.25,
      source: 'coinbase_exchange_public_ticker', fit: 'proxy',
    });
    expect(recovered.chart.variants['1d']).toMatchObject({
      status: 'available', interval: '5m', source: 'coinbase_exchange_public_candles',
    });
  });

  test('retries unexpected Bitcoin weekday Risk Range gaps instead of caching them', async () => {
    let clock = NOW;
    let dailyRecordCalls = 0;
    let riskRangeCalls = 0;
    const calendarDates = [
      '2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13', '2026-08-14',
      '2026-08-15', '2026-08-16', '2026-08-17', '2026-08-18', '2026-08-19',
    ];
    const hourlyCandles = calendarDates.flatMap((date, index) => [
      [Date.parse(`${date}T05:00:00.000Z`) / 1000, 118000, 119000, 118100, 118200 + index, 20],
      [date === calendarDates.at(-1) ? NOW / 1000 - 60 : Date.parse(`${date}T23:00:00.000Z`) / 1000,
        118000, 119000, 118100, 118250 + index, 20],
    ]);
    const client = {
      get: jest.fn(async (url, options = {}) => url.endsWith('/ticker')
        ? { data: { price: '118500.25', time: new Date(clock - 10_000).toISOString() } }
        : options.params?.granularity === 86400
          ? (() => {
              dailyRecordCalls += 1;
              return dailyRecordCalls === 1 ? { data: [
                [Date.parse('2026-08-18T00:00:00.000Z') / 1000, 100000, 130000, 110000, 118000, 100],
                [Date.parse('2026-01-01T00:00:00.000Z') / 1000, 40000, 90000, 50000, 80000, 100],
              ] } : { data: [] };
            })()
          : options.params?.granularity === 3600 ? { data: hourlyCandles } : { data: [
            [clock / 1000 - 60, 118400, 118600, 118450, 118500, 20],
            [clock / 1000 - 300, 118200, 118500, 118300, 118450, 25],
          ] }),
    };
    const riskHistory = jest.fn(async ({ ticker, dates }) => {
      riskRangeCalls += 1;
      const unexpectedFirstPassGaps = new Set(riskRangeCalls === 1
        ? ['2026-08-12', '2026-08-13']
        : []);
      const publicationDates = dates.filter((date) => {
        const weekday = new Date(`${date}T12:00:00.000Z`).getUTCDay();
        return weekday !== 0 && weekday !== 6 && !unexpectedFirstPassGaps.has(date);
      });
      const missingDates = dates.filter((date) => !publicationDates.includes(date));
      return {
        ...exactRiskRanges(ticker, publicationDates),
        status: missingDates.length ? 'unavailable' : 'available',
        missingDates,
        reason: missingDates.length
          ? `Exact-date Risk Range data is unavailable for ${missingDates.join(', ')}.`
          : null,
      };
    });
    const provider = createReferenceProvider({ client, now: () => clock, loadRiskRangeHistory: riskHistory });

    const partial = await provider.getSnapshot({ marketId: 'bitcoin', selected: null });
    expect(partial.chart.variants['10d'].riskRangeMissingDates).toEqual([
      '2026-08-12', '2026-08-13',
    ]);

    clock += 5_001;
    const recovered = await provider.getSnapshot({ marketId: 'bitcoin', selected: null });

    expect(recovered.chart.variants['10d']).toMatchObject({
      riskRangeStatus: 'available',
      riskRangeMissingDates: [],
    });
    expect(recovered.chart.variants['10d'].dailyRanges.every((range) => range.status === 'available')).toBe(true);
    expect(riskHistory).toHaveBeenCalledTimes(2);
  });
});
