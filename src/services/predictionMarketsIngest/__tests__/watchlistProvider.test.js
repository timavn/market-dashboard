const {
  attachIbkrVerification,
  clampRecentSpxHistoryLimit,
  getLastSettledSpxCloseSession,
  getPredictionMarketWatchlist,
  getRecentSettledSpxCloseSessions,
  getSpxCloseWorkbench,
  isStrictLiveIbkrEvent,
  nearestEventMarkets,
  normalizeSettledSpxCloseMarket,
  normalizeSpxCloseMarket,
  rowFromMarkets,
  selectLastSettledSpxCloseEvent,
  selectSpxCloseEvent,
} = require('../watchlistProvider');

const NOW = Date.parse('2026-07-16T20:00:00.000Z');
const SETTLED_NOW = Date.parse('2026-07-18T17:00:00.000Z');

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

  test('selects the nearest broker-enabled 4 p.m. cash-SPX event and excludes hourly events', () => {
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
    expect(normalizeSpxCloseMarket(spxMarket({ yes_ask_size_fp: '0.00' }))).toBeNull();
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

    const sidecarRequest = jest.fn().mockResolvedValue({
      events: [{
        api_raw_symbol: 'KXCPIYOY-26JUN-T4.2_NO',
        source_api: 'IBKR_TWS_API',
        data_quality_flags: ['portfolio_discovered', 'no_live_quote'],
      }],
    });
    const result = await getPredictionMarketWatchlist({
      kalshiFetch,
      checkGatewayHealth: jest.fn().mockResolvedValue({ ok: true, authenticated: true }),
      sidecarRequest,
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
      status: 'connected_no_verified_contracts',
      verifiedContractCount: 0,
    }));
    expect(sidecarRequest).toHaveBeenCalledWith('/refresh', {
      method: 'POST',
      timeoutMs: 5000,
    });
    expect(result.policy.venueRowsAreResearchOnly).toBe(true);
  });
});
