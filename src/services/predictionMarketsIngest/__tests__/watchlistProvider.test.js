const {
  applySpxRtaRiskRange,
  attachHistoricalOverviewChart,
  attachIbkrVerification,
  attachUnderlyingOverviewChart,
  clampRecentSpxHistoryLimit,
  getLastSettledSpxCloseQuoteSnapshot,
  getLastSettledSpxCloseSession,
  getPredictionMarketWatchlist,
  getRecentSettledSpxCloseSessions,
  getSpxCoverSnapshot,
  getSpxCloseWorkbench,
  historicalBarDateKey,
  historicalBarTimestamp,
  overviewSummaryFromHistoricalSpxSession,
  isStrictLiveIbkrEvent,
  nearestEventMarkets,
  normalizeSettledSpxCloseMarket,
  normalizeSpxCloseMarket,
  normalizeUnderlyingBars,
  rowFromMarkets,
  selectLastSettledSpxCloseEvent,
  selectSpxCloseEvent,
  spxCashSessionState,
} = require('../watchlistProvider');

const NOW = Date.parse('2026-07-16T20:00:00.000Z');
const SETTLED_NOW = Date.parse('2026-07-18T17:00:00.000Z');

test('reuses fixed time-zone formatters across naive broker bars and numeric session-date grouping', () => {
  const inputs = [
    ['20260306 16:00:07', '2026-03-06T21:00:07.000Z'],
    ['2026-03-09 16:00:07', '2026-03-09T20:00:07.000Z'],
    ['20261030 09:30:05', '2026-10-30T13:30:05.000Z'],
    ['2026-11-02 09:30:05', '2026-11-02T14:30:05.000Z'],
  ];
  const constructor = jest.spyOn(Intl, 'DateTimeFormat');
  try {
    expect(inputs.map(([raw]) => new Date(historicalBarTimestamp(raw)).toISOString()))
      .toEqual(inputs.map(([, expected]) => expected));
    const points = normalizeUnderlyingBars(inputs.map(([date], index) => ({ date, close: 100 + index })), Date.parse('2026-12-01T00:00:00Z'));
    expect(points.map((point) => historicalBarDateKey(point.timestamp)))
      .toEqual(['2026-03-06', '2026-03-09', '2026-10-30', '2026-11-02']);
    expect(historicalBarTimestamp('2026-03-09T20:00:07Z')).toBe(Date.parse('2026-03-09T20:00:07Z'));
    expect(historicalBarTimestamp('1773086407')).toBe(Date.parse('2026-03-09T20:00:07Z'));
    expect(historicalBarTimestamp('not-a-date')).toBeNull();
    expect(constructor).not.toHaveBeenCalled();
  } finally {
    constructor.mockRestore();
  }
});

test('retains New York midnight and SPX session boundaries across both daylight-saving changes', () => {
  expect([
    '2026-03-09T03:59:59Z', '2026-03-09T04:00:00Z',
    '2026-11-02T04:59:59Z', '2026-11-02T05:00:00Z',
  ].map((value) => historicalBarDateKey(Date.parse(value))))
    .toEqual(['2026-03-08', '2026-03-09', '2026-11-01', '2026-11-02']);
  expect([
    '2026-03-06T14:29:00Z', '2026-03-06T14:30:00Z',
    '2026-03-09T13:30:00Z', '2026-03-09T20:00:00Z',
    '2026-11-02T14:30:00Z', '2026-11-02T21:00:00Z',
    '2026-03-08T15:00:00Z', '2026-07-03T15:00:00Z',
  ].map((value) => spxCashSessionState(Date.parse(value))))
    .toEqual(['closed', 'open', 'open', 'closed', 'open', 'closed', 'closed', 'closed']);
});

test('uses a verified current RTA range over the morning SPX RiskRangeData baseline', () => {
  const result = applySpxRtaRiskRange({
    name: 'SPX Risk Range',
    status: 'available',
    source: 'RiskRangeData',
    asOf: '2026-08-03',
    details: { ticker: 'SPX', date: '2026-08-03', lrr: 7328, hrr: 7567 },
  }, {
    status: 'available',
    source: 'Hedgeye Real-Time Alert',
    asOf: '2026-08-03T14:23:00.000Z',
    low: 7344,
    high: 7585,
    sourceMessageId: 'rta-1',
  });

  expect(result).toMatchObject({
    status: 'available',
    source: 'Hedgeye Real-Time Alert',
    asOf: '2026-08-03T14:23:00.000Z',
    details: {
      lrr: 7344,
      hrr: 7585,
      match: 'rta_refreshed',
      baselineRiskRange: { lrr: 7328, hrr: 7567, source: 'RiskRangeData' },
    },
  });
});

function market(overrides = {}) {
  return {
    ticker: 'KXCPIYOY-26JUL-T2.9',
    event_ticker: 'KXCPIYOY-26JUL',
    status: 'active',
    title: 'Will CPI be above 2.9%?',
    close_time: '2026-07-17T20:00:00.000Z',
    updated_time: '2026-07-16T19:59:50.000Z',
    yes_bid_dollars: '0.4500',
    yes_ask_dollars: '0.4800',
    yes_bid_size_fp: '120.00',
    yes_ask_size_fp: '90.00',
    no_bid_dollars: '0.5100',
    no_ask_dollars: '0.5400',
    no_bid_size_fp: '80.00',
    no_ask_size_fp: '70.00',
    volume_24h_fp: '1000.50',
    volume_fp: '4000.75',
    open_interest_fp: '800.25',
    ...overrides,
  };
}

function spxMarket(overrides = {}) {
  return market({
    ticker: 'KXINXU-26JUL17H1600-T7449.9999',
    event_ticker: 'KXINXU-26JUL17H1600',
    floor_strike: 7450,
    title: 'Will the S&P 500 be above 7449.9999 at 4pm EDT?',
    rules_primary: 'If the end-of-day S&P 500 index value is above 7449.9999, the market resolves Yes.',
    no_bid_dollars: '0.5000',
    no_ask_dollars: '0.5300',
    ...overrides,
  });
}

function settledSpxMarket(overrides = {}) {
  return spxMarket({
    status: 'finalized',
    close_time: '2026-07-17T20:00:00.000Z',
    settlement_ts: '2026-07-17T20:02:02.607345Z',
    expiration_value: '7457.6700',
    result: 'yes',
    settlement_value_dollars: '1.0000',
    yes_bid_dollars: '0.0000',
    yes_ask_dollars: '1.0000',
    yes_bid_size_fp: '0.00',
    yes_ask_size_fp: '0.00',
    last_price_dollars: '0.5000',
    volume_24h_fp: '100.25',
    volume_fp: '200.50',
    open_interest_fp: '150.75',
    ...overrides,
  });
}

const exactConfig = {
  seriesTicker: 'KXCPIYOY',
  label: 'Headline CPI YoY',
  assetClass: 'Inflation',
  hedgeyeSignal: 'Hedgeye Inflation Nowcast',
  matchType: 'exact',
  matchLabel: 'Exact signal',
  matchReason: 'Same release.',
  cadence: 'Monthly',
  occurrencesPerMonth: 1,
};

describe('prediction-market watchlist provider', () => {
  test('selects only the nearest still-open event', () => {
    const nearest = nearestEventMarkets([
      market(),
      market({ ticker: 'SECOND-STRIKE' }),
      market({ event_ticker: 'NEXT-EVENT', ticker: 'NEXT', close_time: '2026-07-18T20:00:00.000Z' }),
      market({ event_ticker: 'EXPIRED', ticker: 'OLD', close_time: '2026-07-15T20:00:00.000Z' }),
    ], NOW);

    expect(nearest).toHaveLength(2);
    expect(nearest.every((item) => item.event_ticker === 'KXCPIYOY-26JUL')).toBe(true);
  });

  test('selects the nearest 4 p.m. cash-SPX event and excludes hourly events', () => {
    const selected = selectSpxCloseEvent([
      {
        event_ticker: 'KXINXU-26JUL17H1000',
        available_on_brokers: true,
        markets: [spxMarket({ event_ticker: 'KXINXU-26JUL17H1000', close_time: '2026-07-17T14:00:00.000Z' })],
      },
      {
        event_ticker: 'KXINXU-26JUL17H1600',
        available_on_brokers: true,
        markets: [spxMarket()],
      },
    ], NOW);

    expect(selected.event.event_ticker).toBe('KXINXU-26JUL17H1600');
  });

  test('keeps a complete direct event when Kalshi has not broker-enabled it', () => {
    const selected = selectSpxCloseEvent([
      {
        event_ticker: 'KXINXU-26JUL17H1600',
        available_on_brokers: false,
        markets: [spxMarket({ available_on_brokers: false })],
      },
    ], NOW);

    expect(selected.event.event_ticker).toBe('KXINXU-26JUL17H1600');
    expect(selected.event.available_on_brokers).toBe(false);
  });

  test('preserves native Yes and No books independently and rejects incomplete books', () => {
    expect(normalizeSpxCloseMarket(spxMarket())).toEqual(expect.objectContaining({
      threshold: 7450,
      yesBid: 0.45,
      yesAsk: 0.48,
      yesBidSize: 120,
      yesAskSize: 90,
      noBid: 0.5,
      noAsk: 0.53,
    }));
    expect(normalizeSpxCloseMarket(spxMarket({ no_ask_dollars: null }))).toBeNull();
    expect(normalizeSpxCloseMarket(spxMarket({ no_bid_dollars: null }))).toBeNull();
    expect(normalizeSpxCloseMarket(spxMarket({ yes_ask_size_fp: '0.00' }))).toEqual(expect.objectContaining({
      threshold: 7450,
      yesAsk: 0.48,
    }));
    expect(normalizeSpxCloseMarket(spxMarket({
      volume_24h_fp: null,
      volume_fp: null,
      open_interest_fp: null,
    }))).toEqual(expect.objectContaining({
      volume24h: null,
      volumeTotal: null,
      openInterest: null,
    }));
  });

  test('returns the complete sorted H1600 ladder as research-only direct venue data', async () => {
    const result = await getSpxCloseWorkbench({
      kalshiFetch: jest.fn().mockResolvedValue({
        events: [{
          event_ticker: 'KXINXU-26JUL17H1600',
          title: 'S&P price on Jul 17, 2026 at 4pm EDT?',
          available_on_brokers: true,
          settlement_sources: [{ name: 'Index source', url: 'https://example.com/index' }],
          markets: [
            spxMarket({ ticker: 'HIGH', floor_strike: 7475 }),
            spxMarket({ ticker: 'LOW', floor_strike: 7450 }),
          ],
        }],
      }),
      checkGatewayHealth: jest.fn().mockResolvedValue({ ok: false, reason: 'tws_offline' }),
      now: () => NOW,
    });

    expect(result.event.ticker).toBe('KXINXU-26JUL17H1600');
    expect(result.markets.map((row) => row.threshold)).toEqual([7450, 7475]);
    expect(result.policy).toEqual(expect.objectContaining({
      researchOnly: true,
      recommendationAvailable: false,
      exactUnderlying: 'S&P 500 cash index',
    }));
    expect(result.ibkr.executionVerified).toBe(false);
  });

  test('returns the newest complete non-broker direct event as the live cover snapshot', async () => {
    const result = await getSpxCoverSnapshot({
      kalshiFetch: jest.fn().mockResolvedValue({
        events: [{
          event_ticker: 'KXINXU-26JUL17H1600',
          title: 'S&P price on Jul 17, 2026 at 4pm EDT?',
          available_on_brokers: false,
          markets: [
            spxMarket({ ticker: 'HIGH', floor_strike: 7475 }),
            spxMarket({ ticker: 'LOW', floor_strike: 7450 }),
          ],
        }],
      }),
      checkGatewayHealth: jest.fn().mockResolvedValue({ ok: false, reason: 'tws_offline' }),
      now: () => NOW,
    });

    expect(result).toEqual(expect.objectContaining({ ok: true, mode: 'live', executable: false }));
    expect(result.event).toEqual(expect.objectContaining({
      ticker: 'KXINXU-26JUL17H1600',
      availableOnBrokers: false,
      totalMarketCount: 2,
      quotedMarketCount: 2,
    }));
    expect(result.markets.every((market) => market.nativeBook.derivedFields.length === 0)).toBe(true);
  });

  test('skips an incomplete nearest event and uses the next complete exact 4 p.m. event', async () => {
    const incompleteEvent = {
      event_ticker: 'KXINXU-26JUL17H1600',
      available_on_brokers: false,
      markets: [
        spxMarket({ ticker: 'INCOMPLETE', no_ask_dollars: null }),
      ],
    };
    const completeEvent = {
      event_ticker: 'KXINXU-26JUL20H1600',
      available_on_brokers: false,
      markets: [
        spxMarket({ ticker: 'COMPLETE', event_ticker: 'KXINXU-26JUL20H1600', close_time: '2026-07-20T20:00:00.000Z' }),
      ],
    };
    const result = await getSpxCloseWorkbench({
      kalshiFetch: jest.fn().mockResolvedValue({ events: [incompleteEvent, completeEvent] }),
      checkGatewayHealth: jest.fn().mockResolvedValue({ ok: false, reason: 'tws_offline' }),
      now: () => NOW,
    });

    expect(result.event.ticker).toBe('KXINXU-26JUL20H1600');
    expect(result.markets.map((row) => row.ticker)).toEqual(['COMPLETE']);
  });

  test('keeps every nearest-event strike when the monitor explicitly allows incomplete books', async () => {
    const result = await getSpxCloseWorkbench({
      kalshiFetch: jest.fn().mockResolvedValue({
        events: [{
          event_ticker: 'KXINXU-26JUL17H1600',
          available_on_brokers: false,
          markets: [
            spxMarket({ ticker: 'COMPLETE', floor_strike: 7450 }),
            spxMarket({ ticker: 'INCOMPLETE', floor_strike: 7455, no_ask_dollars: null }),
          ],
        }],
      }),
      checkGatewayHealth: jest.fn().mockResolvedValue({ ok: true, authenticated: true }),
      now: () => NOW,
      allowIncompleteBooks: true,
    });

    expect(result.markets.map((row) => row.ticker)).toEqual(['COMPLETE', 'INCOMPLETE']);
    expect(result.markets[1]).toEqual(expect.objectContaining({
      noBid: null,
      noAsk: null,
      bookStatus: 'incomplete',
      nativeBook: expect.objectContaining({ complete: false, derivedFields: [] }),
    }));
    expect(result.event).toEqual(expect.objectContaining({
      totalMarketCount: 2,
      quotedMarketCount: 1,
    }));
  });

  test('builds the closed cover ladder from exact event-close candles', async () => {
    const closeSeconds = Date.parse('2026-07-17T20:00:00.000Z') / 1000;
    const kalshiFetch = jest.fn(async (path, params = {}) => {
      if (path === '/events' && params.status === 'open') return { events: [] };
      if (path === '/events' && params.status === 'settled') {
        return { events: [{
          event_ticker: 'KXINXU-26JUL17H1600',
          strike_date: '2026-07-17T20:00:00Z',
          available_on_brokers: false,
        }] };
      }
      if (path === '/events/KXINXU-26JUL17H1600') {
        return { event: {
          event_ticker: 'KXINXU-26JUL17H1600',
          title: 'S&P price on Jul 17, 2026 at 4pm EDT?',
          strike_date: '2026-07-17T20:00:00Z',
          available_on_brokers: false,
          markets: [
            settledSpxMarket({ ticker: 'YES', floor_strike: 7455 }),
            settledSpxMarket({ ticker: 'NO', floor_strike: 7460, result: 'no', settlement_value_dollars: '0.0000' }),
          ],
        } };
      }
      if (path.includes('/events/KXINXU-26JUL17H1600/candlesticks')) {
        return {
          market_tickers: ['YES', 'NO'],
          market_candlesticks: [
            [{ end_period_ts: closeSeconds, yes_bid: { close_dollars: '0.6100' }, yes_ask: { close_dollars: '0.6500' }, volume_fp: '1000.00' }],
            [{ end_period_ts: closeSeconds, yes_bid: { close_dollars: '0.2700' }, yes_ask: { close_dollars: '0.3100' }, volume_fp: '2000.00' }],
          ],
        };
      }
      throw new Error(`Unexpected Kalshi path: ${path}`);
    });

    const result = await getSpxCoverSnapshot({
      kalshiFetch,
      checkGatewayHealth: jest.fn().mockResolvedValue({ ok: false, reason: 'tws_offline' }),
      now: () => SETTLED_NOW,
    });

    expect(result).toEqual(expect.objectContaining({ ok: true, mode: 'closed', historicalOnly: true, executable: false }));
    expect(result.venue).toEqual(expect.objectContaining({ snapshotType: 'historical_quote_close', quoteAsOf: '2026-07-17T20:00:00.000Z' }));
    expect(result.markets.map((market) => [market.yesBid, market.yesAsk, market.noBid, market.noAsk])).toEqual([
      [0.61, 0.65, 0.35, 0.39],
      [0.27, 0.31, 0.69, 0.73],
    ]);
    expect(result.markets.every((market) => market.nativeBook.derivedFields.includes('noBid'))).toBe(true);
    expect(kalshiFetch).toHaveBeenCalledWith(
      '/series/KXINXU/events/KXINXU-26JUL17H1600/candlesticks',
      expect.objectContaining({ start_ts: closeSeconds - 86400, end_ts: closeSeconds, period_interval: 60 }),
    );
  });

  test('does not turn an earlier candle into a closing quote', async () => {
    const closeSeconds = Date.parse('2026-07-17T20:00:00.000Z') / 1000;
    const kalshiFetch = jest.fn(async (path, params = {}) => {
      if (path === '/events' && params.status === 'settled') {
        return { events: [{ event_ticker: 'KXINXU-26JUL17H1600', strike_date: '2026-07-17T20:00:00Z', available_on_brokers: true }] };
      }
      if (path === '/events/KXINXU-26JUL17H1600') {
        return { event: {
          event_ticker: 'KXINXU-26JUL17H1600',
          strike_date: '2026-07-17T20:00:00Z',
          available_on_brokers: true,
          markets: [settledSpxMarket({ ticker: 'YES', floor_strike: 7455 })],
        } };
      }
      if (path.includes('/candlesticks')) {
        return { market_tickers: ['YES'], market_candlesticks: [[{ end_period_ts: closeSeconds - 60, yes_bid: { close_dollars: '0.60' }, yes_ask: { close_dollars: '0.64' } }]] };
      }
      return { events: [] };
    });

    await expect(getLastSettledSpxCloseQuoteSnapshot({ kalshiFetch, now: () => SETTLED_NOW }))
      .rejects.toMatchObject({ code: 'SPX_CLOSE_QUOTES_UNAVAILABLE' });
  });

  test('normalizes finalized SPX outcomes separately from terminal quote placeholders', () => {
    const settled = normalizeSettledSpxCloseMarket(settledSpxMarket({
      ticker: 'KXINXU-26JUL17H1600-T7459.9999',
      floor_strike: 7460,
      result: 'no',
      settlement_value_dollars: '0.0000',
    }));

    expect(settled).toEqual(expect.objectContaining({
      threshold: 7460,
      closeValue: 7457.67,
      result: 'no',
      settlementPayout: 0,
      volumeTotal: 200.5,
    }));
    expect(settled).not.toHaveProperty('yesBid');
    expect(settled).not.toHaveProperty('yesAsk');
    expect(settled).not.toHaveProperty('lastPrice');
  });

  test('selects the latest broker-enabled settled H1600 metadata and excludes hourly events', () => {
    const selected = selectLastSettledSpxCloseEvent([
      { event_ticker: 'KXINXU-26JUL17H1500', strike_date: '2026-07-17T19:00:00Z', available_on_brokers: true },
      { event_ticker: 'KXINXU-26JUL16H1600', strike_date: '2026-07-16T20:00:00Z', available_on_brokers: true },
      { event_ticker: 'KXINXU-26JUL17H1600', strike_date: '2026-07-17T20:00:00Z', available_on_brokers: true },
      { event_ticker: 'KXINXU-26JUL20H1600', strike_date: '2026-07-20T20:00:00Z', available_on_brokers: true },
    ], SETTLED_NOW);

    expect(selected.event.event_ticker).toBe('KXINXU-26JUL17H1600');
  });

  test('returns a historical-only settled session without executable books', async () => {
    const kalshiFetch = jest.fn(async (path) => {
      if (path === '/events') {
        return { events: [{
          event_ticker: 'KXINXU-26JUL17H1600',
          strike_date: '2026-07-17T20:00:00Z',
          available_on_brokers: true,
        }] };
      }
      return { event: {
        event_ticker: 'KXINXU-26JUL17H1600',
        title: 'S&P price on Jul 17, 2026 at 4pm EDT?',
        strike_date: '2026-07-17T20:00:00Z',
        available_on_brokers: true,
        settlement_sources: [{ name: 'Index source', url: 'https://example.com/index' }],
        markets: [
          settledSpxMarket({ ticker: 'YES', floor_strike: 7455 }),
          settledSpxMarket({
            ticker: 'NO',
            floor_strike: 7460,
            result: 'no',
            settlement_value_dollars: '0.0000',
          }),
        ],
      } };
    });

    const result = await getLastSettledSpxCloseSession({ kalshiFetch, now: () => SETTLED_NOW });
    expect(result).toEqual(expect.objectContaining({
      ok: true,
      historicalOnly: true,
      executable: false,
      closeValue: 7457.67,
    }));
    expect(result.event).toEqual(expect.objectContaining({
      ticker: 'KXINXU-26JUL17H1600',
      marketCount: 2,
    }));
    expect(result.markets.map((row) => [row.threshold, row.result])).toEqual([[7455, 'yes'], [7460, 'no']]);
    expect(result.policy).toEqual(expect.objectContaining({
      historicalOnly: true,
      executable: false,
      quotesAvailable: false,
    }));
    expect(kalshiFetch).toHaveBeenCalledTimes(2);
  });

  test('builds a clearly historical overview ladder from the previous SPX contract', () => {
    const summary = overviewSummaryFromHistoricalSpxSession({
      seriesTicker: 'KXINXU',
      fetchedAt: '2026-07-18T17:01:00.000Z',
      closeValue: 7490.12,
      event: {
        ticker: 'KXINXU-26JUL17H1600',
        title: 'S&P price on Jul 17, 2026 at 4pm EDT?',
        closeTime: '2026-07-17T20:00:00.000Z',
        settlementTime: '2026-07-17T20:02:02.607345Z',
      },
      markets: [
        { ticker: 'LOW', threshold: 7485, result: 'yes', volume24h: 100 },
        { ticker: 'HIGH', threshold: 7490, result: 'no', volume24h: 200 },
      ],
    });

    expect(summary).toEqual(expect.objectContaining({
      historicalOnly: true,
      historicalLabel: 'Previous contract · settled',
      executable: false,
      settlementValue: 7490.12,
      freshness: expect.objectContaining({
        status: 'historical',
        snapshotType: 'settled_outcome',
      }),
      reference: expect.objectContaining({
        label: 'Previous S&P 500 close',
        value: 7490.12,
        source: 'kalshi_settlement',
        historicalOnly: true,
      }),
    }));
    expect(summary.lines).toEqual([
      expect.objectContaining({ label: 'Above 7,485', settlementResult: 'YES' }),
      expect.objectContaining({ label: 'Above 7,490', settlementResult: 'NO' }),
    ]);
    expect(JSON.stringify(summary.lines)).not.toMatch(/yesBid|yesAsk|noBid|noAsk/);
  });

  test('attaches direct Kalshi history for the settled SPX line nearest the close', async () => {
    const summary = overviewSummaryFromHistoricalSpxSession({
      seriesTicker: 'KXINXU',
      fetchedAt: '2026-07-18T17:01:00.000Z',
      closeValue: 7490.12,
      event: {
        ticker: 'KXINXU-26JUL17H1600',
        closeTime: '2026-07-17T20:00:00.000Z',
        settlementTime: '2026-07-17T20:02:02.607345Z',
      },
      markets: [
        { ticker: 'LOW', threshold: 7485, result: 'yes', volume24h: 500 },
        { ticker: 'AT-CLOSE', threshold: 7490, result: 'no', volume24h: 200 },
      ],
    });
    const kalshiFetch = jest.fn().mockResolvedValue({
      candlesticks: [
        { end_period_ts: Date.parse('2026-07-17T19:00:00.000Z') / 1000, price: { close_dollars: '0.5200' } },
        { end_period_ts: Date.parse('2026-07-17T20:00:00.000Z') / 1000, price: { close_dollars: '0.4900' } },
      ],
    });

    const result = await attachHistoricalOverviewChart(summary, { kalshiFetch });

    expect(kalshiFetch).toHaveBeenCalledWith(
      '/series/KXINXU/markets/AT-CLOSE/candlesticks',
      expect.objectContaining({
        start_ts: Date.parse('2026-07-16T20:00:00.000Z') / 1000,
        end_ts: Date.parse('2026-07-17T20:00:00.000Z') / 1000,
        period_interval: 60,
      }),
    );
    expect(result.chart).toEqual(expect.objectContaining({
      status: 'available',
      source: 'kalshi_trade_api_v2',
      availability: 'historical',
      historicalOnly: true,
      ticker: 'AT-CLOSE',
      label: 'Above 7,490',
    }));
    expect(result.chart.points).toHaveLength(2);
  });

  test('attaches source-matched LRR and HRR to a verified underlying chart', async () => {
    const summary = {
      signal: {
        status: 'available',
        source: 'RiskRangeData',
        asOf: '2026-07-21',
        details: { ticker: 'SPX', date: '2026-07-21', lrr: 7280, hrr: 7340 },
      },
    };
    const getHistoricalBars = jest.fn().mockResolvedValue({
      source: 'ibkr',
      bars: [
        { timestamp: Date.parse('2026-07-21T19:50:00.000Z'), close: 7310 },
        { timestamp: Date.parse('2026-07-21T19:55:00.000Z'), close: 7315 },
      ],
    });

    const result = await attachUnderlyingOverviewChart(
      summary,
      { getHistoricalBars },
      { instrument: { symbol: 'SPX' }, label: 'S&P 500 index', unit: 'index' },
      Date.parse('2026-07-21T20:00:00.000Z'),
    );

    expect(result.chart.references).toEqual([
      expect.objectContaining({ label: 'LRR', tone: 'low', value: 7280, source: 'RiskRangeData' }),
      expect.objectContaining({ label: 'HRR', tone: 'high', value: 7340, source: 'RiskRangeData' }),
    ]);
  });

  test('builds a continuous five-session SPX chart with exact daily Risk Ranges', async () => {
    const sessionDates = ['2026-07-15', '2026-07-16', '2026-07-17', '2026-07-20', '2026-07-21'];
    const bars = sessionDates.flatMap((date, index) => [
      { timestamp: Date.parse(`${date}T18:00:00.000Z`), close: 7280 + (index * 10) },
      { timestamp: Date.parse(`${date}T19:00:00.000Z`), close: 7290 + (index * 10) },
    ]);
    const getHistoricalBars = jest.fn(async (_instrument, range) => ({
      source: 'ibkr',
      bars: range === '1d' ? bars.slice(-2) : bars,
    }));
    const getRiskRangeHistory = jest.fn(async ({ ticker, dates }) => ({
      status: 'available',
      source: 'RiskRangeData',
      ticker,
      ranges: Object.fromEntries(dates.map((date, index) => [date, {
        ticker,
        date,
        lrr: 7260 + (index * 10),
        hrr: 7330 + (index * 10),
      }])),
      missingDates: [],
    }));

    const result = await attachUnderlyingOverviewChart(
      {
        signal: {
          status: 'available',
          source: 'RiskRangeData',
          asOf: '2026-07-21',
          details: { ticker: 'SPX', date: '2026-07-21', lrr: 7300, hrr: 7370 },
        },
      },
      { getHistoricalBars, getRiskRangeHistory },
      {
        instrument: { symbol: 'SPX' },
        label: 'S&P 500 index',
        unit: 'index',
        enableMultiDayChart: true,
        riskRangeTicker: 'SPX',
        isSessionOpen: () => false,
      },
      Date.parse('2026-07-21T20:00:00.000Z'),
    );

    expect(getHistoricalBars).toHaveBeenNthCalledWith(1, { symbol: 'SPX' }, '1d', '5m');
    expect(getHistoricalBars).toHaveBeenNthCalledWith(2, { symbol: 'SPX' }, '10d', '5m');
    expect(getRiskRangeHistory).toHaveBeenCalledWith({ ticker: 'SPX', dates: sessionDates });
    expect(result.chart.variants['5d']).toEqual(expect.objectContaining({
      status: 'available',
      availability: 'historical',
      range: '5d',
      rangeDates: sessionDates,
      riskRangeStatus: 'available',
      riskRangeMissingDates: [],
      points: expect.any(Array),
      dailyRanges: expect.any(Array),
    }));
    expect(result.chart.variants['5d'].points).toHaveLength(10);
    expect(result.chart.variants['5d'].dailyRanges).toHaveLength(5);
    expect(result.chart.variants['5d'].dailyRanges[0].references).toEqual([
      expect.objectContaining({ label: 'LRR', value: 7260 }),
      expect.objectContaining({ label: 'HRR', value: 7330 }),
    ]);
  });

  test('builds the same five-session WTI chart with exact WTIC Risk Ranges', async () => {
    const sessionDates = ['2026-07-15', '2026-07-16', '2026-07-17', '2026-07-20', '2026-07-21'];
    const bars = sessionDates.flatMap((date, index) => [
      { timestamp: Date.parse(`${date}T18:00:00.000Z`), close: 81.5 + (index * 0.4) },
      { timestamp: Date.parse(`${date}T19:00:00.000Z`), close: 81.8 + (index * 0.4) },
    ]);
    const getHistoricalBars = jest.fn(async (_instrument, range) => ({
      source: 'ibkr',
      bars: range === '1d' ? bars.slice(-2) : bars,
    }));
    const getRiskRangeHistory = jest.fn(async ({ ticker, dates }) => ({
      status: 'available',
      source: 'RiskRangeData',
      ticker,
      ranges: Object.fromEntries(dates.map((date, index) => [date, {
        ticker,
        date,
        lrr: 80.5 + (index * 0.4),
        hrr: 83.5 + (index * 0.4),
      }])),
      missingDates: [],
    }));

    const result = await attachUnderlyingOverviewChart(
      { signal: { status: 'unavailable' } },
      { getHistoricalBars, getRiskRangeHistory },
      {
        instrument: { symbol: 'WTI', secType: 'FUT', exchange: 'IPE' },
        label: 'WTI front-month price',
        unit: 'usd',
        enableMultiDayChart: true,
        riskRangeTicker: 'WTIC',
        isSessionOpen: () => false,
      },
      Date.parse('2026-07-21T20:00:00.000Z'),
    );

    expect(getHistoricalBars).toHaveBeenNthCalledWith(1, { symbol: 'WTI', secType: 'FUT', exchange: 'IPE' }, '1d', '5m');
    expect(getHistoricalBars).toHaveBeenNthCalledWith(2, { symbol: 'WTI', secType: 'FUT', exchange: 'IPE' }, '10d', '5m');
    expect(getRiskRangeHistory).toHaveBeenCalledWith({ ticker: 'WTIC', dates: sessionDates });
    expect(result.chart.variants['5d']).toEqual(expect.objectContaining({
      status: 'available',
      availability: 'historical',
      range: '5d',
      rangeDates: sessionDates,
      riskRangeStatus: 'available',
      riskRangeMissingDates: [],
      points: expect.any(Array),
      dailyRanges: expect.any(Array),
    }));
    expect(result.chart.variants['5d'].dailyRanges).toHaveLength(5);
    expect(result.chart.variants['5d'].dailyRanges[4].references).toEqual([
      expect.objectContaining({ label: 'LRR', value: 82.1 }),
      expect.objectContaining({ label: 'HRR', value: 85.1 }),
    ]);
  });

  test('clamps the recent settled history limit to a small safe range', () => {
    expect(clampRecentSpxHistoryLimit(undefined)).toBe(13);
    expect(clampRecentSpxHistoryLimit('0')).toBe(1);
    expect(clampRecentSpxHistoryLimit('500')).toBe(15);
    expect(clampRecentSpxHistoryLimit('7')).toBe(7);
  });

  test('returns recent verified settled H1600 sessions as compact non-executable outcomes', async () => {
    const dates = [
      { ticker: 'KXINXU-26JUL17H1600', closeTime: '2026-07-17T20:00:00Z', closeValue: 7457.67 },
      { ticker: 'KXINXU-26JUL16H1600', closeTime: '2026-07-16T20:00:00Z', closeValue: 7448.25 },
      { ticker: 'KXINXU-26JUL15H1600', closeTime: '2026-07-15T20:00:00Z', closeValue: 7432.10 },
    ];
    const kalshiFetch = jest.fn(async (path) => {
      if (path === '/events') {
        return {
          events: [
            { event_ticker: 'KXINXU-26JUL17H1500', strike_date: '2026-07-17T19:00:00Z', available_on_brokers: true },
            { event_ticker: 'KXINXU-26JUL17H1600', strike_date: dates[0].closeTime, available_on_brokers: true },
            { event_ticker: 'KXINXU-26JUL16H1600', strike_date: dates[1].closeTime, available_on_brokers: true },
            { event_ticker: 'KXINXU-26JUL15H1600', strike_date: dates[2].closeTime, available_on_brokers: true },
            { event_ticker: 'KXINXU-26JUL14H1600', strike_date: '2026-07-14T20:00:00Z', available_on_brokers: false },
          ],
        };
      }
      const date = dates.find((candidate) => path === `/events/${candidate.ticker}`);
      const lowerStrike = Math.floor(date.closeValue / 5) * 5;
      return { event: {
        event_ticker: date.ticker,
        strike_date: date.closeTime,
        available_on_brokers: true,
        markets: [
          settledSpxMarket({
            ticker: `${date.ticker}-YES`,
            event_ticker: date.ticker,
            floor_strike: lowerStrike,
            close_time: date.closeTime,
            settlement_ts: date.closeTime,
            expiration_value: String(date.closeValue),
            result: 'yes',
            settlement_value_dollars: '1.0000',
            volume_fp: '200.50',
            open_interest_fp: '150.75',
          }),
          settledSpxMarket({
            ticker: `${date.ticker}-NO`,
            event_ticker: date.ticker,
            floor_strike: lowerStrike + 5,
            close_time: date.closeTime,
            settlement_ts: date.closeTime,
            expiration_value: String(date.closeValue),
            result: 'no',
            settlement_value_dollars: '0.0000',
            volume_fp: '300.25',
            open_interest_fp: '100.50',
          }),
        ],
      } };
    });

    const result = await getRecentSettledSpxCloseSessions({
      kalshiFetch,
      now: () => SETTLED_NOW,
      limit: 2,
    });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      historicalOnly: true,
      executable: false,
      snapshotType: 'settled_outcome',
      requestedLimit: 2,
      returnedCount: 2,
    }));
    expect(result.sessions.map((session) => session.eventTicker)).toEqual([
      'KXINXU-26JUL17H1600',
      'KXINXU-26JUL16H1600',
    ]);
    expect(result.sessions[0]).toEqual(expect.objectContaining({
      closeValue: 7457.67,
      marketCount: 2,
      historicalOnly: true,
      executable: false,
      venue: expect.objectContaining({
        snapshotType: 'settled_outcome',
        volumeTotal: 500.75,
        openInterest: 251.25,
      }),
    }));
    const serialized = JSON.stringify(result.sessions);
    expect(serialized).not.toMatch(/yesBid|yesAsk|noBid|noAsk|depth|lastPrice/i);
  });

  test('skips a settled event whose outcomes do not match the authoritative close', async () => {
    const kalshiFetch = jest.fn(async (path) => {
      if (path === '/events') {
        return { events: [
          { event_ticker: 'KXINXU-26JUL17H1600', strike_date: '2026-07-17T20:00:00Z', available_on_brokers: true },
          { event_ticker: 'KXINXU-26JUL16H1600', strike_date: '2026-07-16T20:00:00Z', available_on_brokers: true },
        ] };
      }
      const isInvalid = path.endsWith('26JUL17H1600');
      const ticker = isInvalid ? 'KXINXU-26JUL17H1600' : 'KXINXU-26JUL16H1600';
      const closeTime = isInvalid ? '2026-07-17T20:00:00Z' : '2026-07-16T20:00:00Z';
      return { event: {
        event_ticker: ticker,
        strike_date: closeTime,
        available_on_brokers: true,
        markets: [settledSpxMarket({
          event_ticker: ticker,
          close_time: closeTime,
          settlement_ts: closeTime,
          floor_strike: 7455,
          expiration_value: '7457.67',
          result: isInvalid ? 'no' : 'yes',
          settlement_value_dollars: isInvalid ? '0.0000' : '1.0000',
        })],
      } };
    });

    const result = await getRecentSettledSpxCloseSessions({
      kalshiFetch,
      now: () => SETTLED_NOW,
      limit: 1,
    });
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].eventTicker).toBe('KXINXU-26JUL16H1600');
  });

  test('aggregates direct venue liquidity without making the row executable', () => {
    const row = rowFromMarkets(
      exactConfig,
      [market(), market({ ticker: 'SECOND', volume_24h_fp: '25.50', volume_fp: '100.25' })],
      { title: 'CPI in July?', available_on_brokers: true, settlement_sources: [{ name: 'BLS', url: 'https://www.bls.gov/cpi/' }] },
      '2026-07-16T20:00:00.000Z',
    );

    expect(row.lane).toBe('exact');
    expect(row.venue.volume24h).toBe(1026);
    expect(row.venue.volumeTotal).toBe(4101);
    expect(row.venue.snapshotType).toBe('direct_venue');
    expect(row.venue).toEqual(expect.objectContaining({
      yesBid: 0.45,
      yesAsk: 0.48,
      yesBidSize: 120,
      yesAskSize: 90,
      noBid: 0.51,
      noAsk: 0.54,
      noBidSize: 80,
      noAskSize: 70,
    }));
    expect(row.executable).toBe(false);
    expect(row.ibkr.verified).toBe(false);
  });

  test('does not call lifetime volume current liquidity when the live book has no size or recent trades', () => {
    const row = rowFromMarkets(
      { ...exactConfig, matchType: 'calibration' },
      [market({
        volume_24h_fp: '0.00',
        volume_fp: '50000.00',
        yes_bid_size_fp: '0.00',
        yes_ask_size_fp: '0.00',
      })],
      {},
      '2026-07-16T20:00:00.000Z',
    );

    expect(row.venue.volumeTotal).toBe(50000);
    expect(row.venue.liquidityStatus).toBe('thin');
    expect(row.lane).toBe('blocked');
  });

  test('requires native live IBKR data type, fresh timestamp, conId, sizes, and clean flags', () => {
    const valid = {
      source_api: 'IBKR_TWS_API',
      conId: 123,
      dataType: 'live',
      quote_timestamp: '2026-07-16T19:59:40.000Z',
      quote_native_bid: 0.45,
      quote_native_ask: 0.48,
      quote_native_bid_size: 10,
      quote_native_ask_size: 12,
      data_quality_flags: [],
    };

    expect(isStrictLiveIbkrEvent(valid, NOW)).toBe(true);
    expect(isStrictLiveIbkrEvent({ ...valid, dataType: 'delayed' }, NOW)).toBe(false);
    expect(isStrictLiveIbkrEvent({ ...valid, conId: null }, NOW)).toBe(false);
    expect(isStrictLiveIbkrEvent({ ...valid, quote_timestamp: '2026-07-16T19:55:00.000Z' }, NOW)).toBe(false);
    expect(isStrictLiveIbkrEvent({ ...valid, data_quality_flags: ['portfolio_discovered'] }, NOW)).toBe(false);
    expect(isStrictLiveIbkrEvent({ ...valid, quote_native_ask: 1.48 }, NOW)).toBe(false);
    expect(isStrictLiveIbkrEvent({ ...valid, from_cache: true }, NOW)).toBe(false);
  });

  test('never promotes an expired portfolio seed to executable', () => {
    const row = rowFromMarkets(exactConfig, [market()], {}, '2026-07-16T20:00:00.000Z');
    const [verified] = attachIbkrVerification([row], [{
      api_raw_symbol: 'KXCPIYOY-26JUN-T4.2_NO',
      source_api: 'IBKR_TWS_API',
      updated_at: '2026-07-16T20:00:00.000Z',
      data_quality_flags: ['portfolio_discovered', 'no_live_quote'],
    }], NOW);

    expect(verified.executable).toBe(false);
    expect(verified.ibkr.verified).toBe(false);
  });

  test('verifies the representative native contract, not merely a matching series', () => {
    const row = rowFromMarkets(exactConfig, [market()], {}, '2026-07-16T20:00:00.000Z');
    const liveEvent = {
      api_raw_symbol: 'KXCPIYOY-26JUL-T3.1_YES',
      source_api: 'IBKR_TWS_API',
      conId: 321,
      dataType: 'live',
      quote_timestamp: '2026-07-16T19:59:40.000Z',
      quote_native_bid: 0.45,
      quote_native_ask: 0.48,
      quote_native_bid_size: 10,
      quote_native_ask_size: 12,
      data_quality_flags: [],
    };

    expect(attachIbkrVerification([row], [liveEvent], NOW)[0].executable).toBe(false);
    expect(attachIbkrVerification([row], [{
      ...liveEvent,
      api_raw_symbol: `${row.marketTicker}_YES`,
    }], NOW)[0].executable).toBe(true);
  });

  test('builds the complete allowlisted venue scan and reports Gateway verification separately', async () => {
    const kalshiFetch = jest.fn(async (path, query) => {
      const eventTicker = query.series_ticker === 'KXINXU'
        ? 'KXINXU-26JUL17H1600'
        : `${query.series_ticker}-CURRENT`;
      const events = [{
        event_ticker: eventTicker,
        title: `${query.series_ticker} current event`,
        available_on_brokers: true,
        markets: [market({
          ticker: `${eventTicker}-T50`,
          event_ticker: eventTicker,
        })],
      }];
      if (query.series_ticker === 'KXINXU') {
        events.unshift({
          event_ticker: 'KXINXU-26JUL17H1000',
          title: 'Earlier hourly event',
          available_on_brokers: true,
          markets: [market({
            ticker: 'KXINXU-26JUL17H1000-T50',
            event_ticker: 'KXINXU-26JUL17H1000',
            close_time: '2026-07-17T14:00:00.000Z',
          })],
        });
      }
      return { events };
    });

    const fetchIbkrSnapshot = jest.fn().mockResolvedValue({
      health: { ok: true, authenticated: true },
      provider: {
        status: 'unsupported_or_not_entitled',
        errorCode: 'UNSUPPORTED_OR_NOT_ENTITLED',
        message: 'No entitled contracts',
      },
      events: [],
    });
    const result = await getPredictionMarketWatchlist({
      kalshiFetch,
      checkGatewayHealth: jest.fn().mockResolvedValue({ ok: true, authenticated: true }),
      fetchIbkrSnapshot,
      now: () => NOW,
      wait: jest.fn().mockResolvedValue(undefined),
      requestSpacingMs: 0,
    });

    expect(result.rows).toHaveLength(11);
    expect(result.rows.find((row) => row.seriesTicker === 'KXINXU')).toEqual(expect.objectContaining({
      label: 'S&P 500 daily threshold',
      screeningLabel: 'Primary daily study',
      researchPriority: 1,
      eventTicker: 'KXINXU-26JUL17H1600',
    }));
    expect(result.rows.every((row) => row.executable === false)).toBe(true);
    expect(result.providers.ibkr).toEqual(expect.objectContaining({
      connected: true,
      status: 'unsupported_or_not_entitled',
      errorCode: 'UNSUPPORTED_OR_NOT_ENTITLED',
      verifiedContractCount: 0,
    }));
    expect(fetchIbkrSnapshot).toHaveBeenCalledTimes(1);
    expect(result.policy.venueRowsAreResearchOnly).toBe(true);
  });

  test('keeps valid Kalshi research rows when the IBKR verification read fails', async () => {
    const kalshiFetch = jest.fn(async (_path, query) => {
      const eventTicker = query.series_ticker === 'KXINXU'
        ? 'KXINXU-26JUL17H1600'
        : `${query.series_ticker}-CURRENT`;
      return {
        events: [{
          event_ticker: eventTicker,
          title: `${query.series_ticker} current event`,
          markets: [market({
            ticker: `${eventTicker}-T50`,
            event_ticker: eventTicker,
          })],
        }],
      };
    });
    const result = await getPredictionMarketWatchlist({
      kalshiFetch,
      fetchIbkrSnapshot: jest.fn().mockRejectedValue(
        Object.assign(new Error('IBKR read failed'), { code: 'IBKR_TEST_FAILURE' }),
      ),
      now: () => NOW,
      wait: jest.fn().mockResolvedValue(undefined),
      requestSpacingMs: 0,
    });

    expect(result.rows).toHaveLength(11);
    expect(result.rows.every((row) => row.executable === false)).toBe(true);
    expect(result.providers.ibkr).toMatchObject({
      connected: false,
      status: 'error',
      errorCode: 'IBKR_TEST_FAILURE',
      verifiedContractCount: 0,
    });
  });

  test('forced watchlist refresh retries only missing venue series and exposes both venue ledgers', async () => {
    const attempts = new Map();
    const kalshiFetch = jest.fn(async (_path, query) => {
      const count = (attempts.get(query.series_ticker) || 0) + 1;
      attempts.set(query.series_ticker, count);
      if (query.series_ticker === 'KXGDP' && count === 1) return { events: [] };
      const eventTicker = query.series_ticker === 'KXINXU'
        ? 'KXINXU-26JUL17H1600'
        : `${query.series_ticker}-CURRENT`;
      return {
        events: [{
          event_ticker: eventTicker,
          title: `${query.series_ticker} current event`,
          markets: [market({
            ticker: `${eventTicker}-T50`,
            event_ticker: eventTicker,
          })],
        }],
      };
    });
    const fetchIbkrSnapshot = jest.fn().mockResolvedValue({
      health: { ok: true, authenticated: true },
      release: { releaseKey: 'KXCPIYOY#2026-08' },
      provider: {
        status: 'catalog_unavailable',
        errorCode: 'CATALOG_NOT_PROMOTED',
        refreshEvidence: {
          mode: 'on_demand_prediction_fanout',
          requestedContractCount: 0,
          brokerSnapshotRequestedCount: 0,
          brokerSnapshotRetryCount: 0,
          verifiedContractCount: 0,
          missingContractCount: 0,
          coverageComplete: false,
          blockedBy: 'CATALOG_NOT_PROMOTED',
          fromCache: false,
        },
      },
      events: [],
    });

    const result = await getPredictionMarketWatchlist({
      kalshiFetch,
      fetchIbkrSnapshot,
      forceRefresh: true,
      retryMissing: true,
      now: () => NOW,
      wait: jest.fn().mockResolvedValue(undefined),
      requestSpacingMs: 0,
    });

    expect(fetchIbkrSnapshot).toHaveBeenCalledWith({ forceRefresh: true, retryMissing: true });
    expect(result.rows).toHaveLength(11);
    expect(attempts.get('KXGDP')).toBe(2);
    expect(result.refreshEvidence).toMatchObject({
      mode: 'on_demand_prediction_fanout',
      fromCache: false,
      kalshi: {
        requestedSeriesCount: 11,
        initialVerifiedSeriesCount: 10,
        venueRequestCount: 12,
        retryCount: 1,
        recoveredSeriesCount: 1,
        verifiedSeriesCount: 11,
        missingSeriesCount: 0,
        coverageComplete: true,
      },
      ibkr: {
        blockedBy: 'CATALOG_NOT_PROMOTED',
        brokerSnapshotRequestedCount: 0,
      },
    });
  });
});
