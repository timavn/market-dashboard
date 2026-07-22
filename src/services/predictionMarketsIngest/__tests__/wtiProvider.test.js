const {
  buildWtiSettlementMapping,
  getLastSettledWtiSession,
  getPredictionMarketsOverview,
  getRecentSettledWtiSessions,
  getWtiWorkbench,
  normalizeWtiCadence,
  normalizeWtiMarket,
  selectWtiEvent,
  validateWtiGeometry,
  verifySettledWtiEvent,
} = require('../watchlistProvider');

const NOW = Date.parse('2026-07-21T17:00:00.000Z');
const DAILY_EVENT = 'KXWTI-26JUL2214';
const WEEKLY_EVENT = 'KXWTIW-26JUL2414';
const RULES_SECONDARY = 'Settlement is based on the nearest listed contract month, rolling forward to the next contract 2 business days before the current contract\'s last trading day. The settlement value is rounded to the nearest 2 decimal places.';
const WEEKLY_RULES_SECONDARY = 'The settlement value is rounded to the nearest 2 decimal places.';

function directBook(overrides = {}) {
  return {
    yes_bid_dollars: '0.4200',
    yes_ask_dollars: '0.4500',
    yes_bid_size_fp: '25.00',
    yes_ask_size_fp: '30.00',
    no_bid_dollars: '0.5500',
    no_ask_dollars: '0.5800',
    volume_24h_fp: '100.25',
    volume_fp: '500.50',
    open_interest_fp: '250.75',
    ...overrides,
  };
}

function dailyMarket(threshold, overrides = {}) {
  return {
    ticker: `${DAILY_EVENT}-T${threshold.toFixed(2)}`,
    event_ticker: DAILY_EVENT,
    status: 'active',
    strike_type: 'greater',
    floor_strike: threshold,
    close_time: '2026-07-22T18:30:00.000Z',
    expected_expiration_time: '2026-07-22T18:30:00.000Z',
    updated_time: '2026-07-21T16:59:50.000Z',
    custom_strike: {
      front_month_contract: 'WBS 26U-ICE',
      strike_date: '2026-07-22T14:30:00-04:00',
    },
    rules_primary: `If the daily settlement price for WTI crude oil(September 2026 contract) on July 22, 2026 is above ${threshold.toFixed(2)} USD/Bbl, then the market resolves to Yes.`,
    rules_secondary: RULES_SECONDARY,
    ...directBook(),
    ...overrides,
  };
}

function weeklyMarket(kind, overrides = {}) {
  const shapes = {
    lower: {
      ticker: `${WEEKLY_EVENT}-T70.00`,
      strike_type: 'less',
      cap_strike: 70,
      rules_primary: 'If the daily settlement price for WTI crude oil(September 2026 contract) on July 24, 2026 is below 70.00 USD/Bbl, then the market resolves to Yes.',
    },
    bucket: {
      ticker: `${WEEKLY_EVENT}-B70.50`,
      strike_type: 'between',
      floor_strike: 70,
      cap_strike: 70.99,
      rules_primary: 'If the daily settlement price for WTI crude oil(September 2026 contract) on July 24, 2026 is between 70.00-70.99 USD/Bbl, then the market resolves to Yes.',
    },
    upper: {
      ticker: `${WEEKLY_EVENT}-T70.99`,
      strike_type: 'greater',
      floor_strike: 70.99,
      rules_primary: 'If the daily settlement price for WTI crude oil(September 2026 contract) on July 24, 2026 is above 70.99 USD/Bbl, then the market resolves to Yes.',
    },
  };
  return {
    event_ticker: WEEKLY_EVENT,
    status: 'active',
    close_time: '2026-07-24T18:30:00.000Z',
    expected_expiration_time: '2026-07-24T18:30:00.000Z',
    updated_time: '2026-07-21T16:59:50.000Z',
    custom_strike: {
      front_month_contract: 'WBS 26U-ICE',
      strike_date: '2026-07-24T14:30:00-04:00',
    },
    rules_secondary: WEEKLY_RULES_SECONDARY,
    ...directBook(),
    ...shapes[kind],
    ...overrides,
  };
}

function event(cadence, markets, overrides = {}) {
  const daily = cadence === 'daily';
  return {
    event_ticker: daily ? DAILY_EVENT : WEEKLY_EVENT,
    series_ticker: daily ? 'KXWTI' : 'KXWTIW',
    title: daily ? 'Oil Price (WTI) on Jul 22, 2026?' : 'Oil Price (WTI) on Jul 24, 2026?',
    strike_date: daily ? '2026-07-22T18:30:00.000Z' : '2026-07-24T18:30:00.000Z',
    mutually_exclusive: !daily,
    available_on_brokers: true,
    settlement_sources: [{ name: 'ICE', url: 'https://www.theice.com/products/213/WTI-Crude-Futures' }],
    markets,
    ...overrides,
  };
}

function settle(raw, settlementValue, result) {
  return {
    ...raw,
    status: 'finalized',
    close_time: raw.close_time,
    settlement_ts: '2026-07-25T02:30:00.000Z',
    expiration_value: String(settlementValue),
    result,
    settlement_value_dollars: result === 'yes' ? '1.0000' : '0.0000',
    yes_bid_dollars: '0.0000',
    yes_ask_dollars: '1.0000',
    yes_bid_size_fp: '0.00',
    yes_ask_size_fp: '0.00',
    last_price_dollars: '0.9900',
  };
}

describe('WTI prediction-market provider', () => {
  test('accepts only explicit daily/weekly cadences and exact WTI series', () => {
    expect(normalizeWtiCadence()).toBe('daily');
    expect(normalizeWtiCadence('WEEKLY')).toBe('weekly');
    expect(() => normalizeWtiCadence('monthly')).toThrow(expect.objectContaining({ code: 'WTI_INVALID_CADENCE' }));

    const selected = selectWtiEvent([
      event('weekly', [weeklyMarket('lower'), weeklyMarket('bucket'), weeklyMarket('upper')]),
      event('daily', [dailyMarket(80)]),
      event('daily', [dailyMarket(79)], { event_ticker: 'KXWTI-26JUL2114', available_on_brokers: false }),
    ], 'daily', NOW);
    expect(selected.event.event_ticker).toBe(DAILY_EVENT);
  });

  test('keeps native Yes and No fields independent and marks missing depth incomplete', () => {
    const normalized = normalizeWtiMarket(dailyMarket(80, {
      no_bid_dollars: null,
      no_ask_dollars: null,
      yes_bid_size_fp: '0.00',
    }), 'daily');

    expect(normalized).toEqual(expect.objectContaining({
      yesBid: 0.42,
      yesAsk: 0.45,
      noBid: null,
      noAsk: null,
      yesBidSize: 0,
      bookStatus: 'incomplete',
    }));
    expect(normalized.nativeBook).toEqual(expect.objectContaining({
      yesPrices: true,
      noPrices: false,
      yesDepth: false,
      complete: false,
      derivedFields: [],
    }));
  });

  test('validates daily thresholds separately from weekly tails and contiguous buckets', () => {
    const daily = [dailyMarket(80), dailyMarket(80.5)].map((row) => normalizeWtiMarket(row, 'daily'));
    const weekly = ['lower', 'bucket', 'upper'].map((kind) => normalizeWtiMarket(weeklyMarket(kind), 'weekly'));
    expect(validateWtiGeometry(daily, 'daily')).toBe(true);
    expect(validateWtiGeometry(weekly, 'weekly')).toBe(true);

    const gap = weekly.map((row) => ({ ...row, geometry: { ...row.geometry } }));
    gap[1].geometry.lowerBound = 70.01;
    expect(validateWtiGeometry(gap, 'weekly')).toBe(false);
  });

  test('returns the full daily ladder with direct books and research-only settlement metadata', async () => {
    const result = await getWtiWorkbench({
      cadence: 'daily',
      now: () => NOW,
      checkGatewayHealth: jest.fn().mockResolvedValue({ ok: true, authenticated: true }),
      kalshiFetch: jest.fn().mockResolvedValue({
        events: [event('daily', [
          dailyMarket(80.5, { volume_24h_fp: '25.00' }),
          dailyMarket(80, { volume_24h_fp: '200.00' }),
          dailyMarket(81, { yes_bid_size_fp: '0.00' }),
        ])],
      }),
    });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      cadence: 'daily',
      seriesTicker: 'KXWTI',
      historicalOnly: false,
      executable: false,
    }));
    expect(result.markets.map((row) => row.geometry.threshold)).toEqual([80, 80.5, 81]);
    expect(result.event).toEqual(expect.objectContaining({ totalMarketCount: 3, completeBookCount: 2 }));
    expect(result.settlementMapping).toEqual(expect.objectContaining({
      status: 'consistent_unverified',
      frontMonthContract: 'WBS 26U-ICE',
      contractMonth: 'September 2026',
      units: 'USD/Bbl',
      precisionDecimals: 2,
      calibrationAvailable: false,
    }));
    expect(result.ibkr).toEqual(expect.objectContaining({ connected: true, executionVerified: false }));
    expect(result.policy).toEqual(expect.objectContaining({
      researchOnly: true,
      fairProbabilityAvailable: false,
      sizingAvailable: false,
      directVenuePricesOnly: true,
    }));
    expect(result.riskRange.status).toBe('unavailable');
    expect(result.ovx.status).toBe('unavailable');
  });

  test('keeps direct WTI prices visible when every native book lacks depth', async () => {
    const result = await getWtiWorkbench({
      cadence: 'daily',
      now: () => NOW,
      checkGatewayHealth: jest.fn().mockResolvedValue({ ok: false }),
      kalshiFetch: jest.fn().mockResolvedValue({
        events: [event('daily', [dailyMarket(80, { yes_bid_size_fp: '0.00' })])],
      }),
    });

    expect(result.event).toEqual(expect.objectContaining({ completeBookCount: 0 }));
    expect(result.markets[0]).toEqual(expect.objectContaining({
      yesBid: 0.42,
      yesAsk: 0.45,
      bookStatus: 'incomplete',
    }));
  });

  test('keeps valid parsed contracts visible when another row has malformed geometry', async () => {
    const result = await getWtiWorkbench({
      cadence: 'daily',
      now: () => NOW,
      checkGatewayHealth: jest.fn().mockResolvedValue({ ok: false }),
      kalshiFetch: jest.fn().mockResolvedValue({
        events: [event('daily', [
          dailyMarket(80),
          dailyMarket(81, { strike_type: 'between', cap_strike: 82 }),
        ])],
      }),
    });

    expect(result.event).toEqual(expect.objectContaining({
      geometryStatus: 'partial',
      parsedMarketCount: 1,
      rejectedMarketCount: 1,
    }));
    expect(result.markets).toHaveLength(1);
  });

  test('leaves direct books visible when settlement mapping is inconsistent', async () => {
    const result = await getWtiWorkbench({
      cadence: 'daily',
      now: () => NOW,
      checkGatewayHealth: jest.fn().mockResolvedValue({ ok: false }),
      kalshiFetch: jest.fn().mockResolvedValue({
        events: [event('daily', [
          dailyMarket(80),
          dailyMarket(80.5, { custom_strike: { front_month_contract: 'WBS 26V-ICE', strike_date: '2026-07-22T14:30:00-04:00' } }),
        ])],
      }),
    });

    expect(result.markets).toHaveLength(2);
    expect(result.settlementMapping).toEqual(expect.objectContaining({
      status: 'inconsistent',
      calibrationAvailable: false,
    }));
  });

  test('uses strict greater-than semantics for settled daily thresholds', () => {
    const raw = dailyMarket(80, { close_time: '2026-07-20T18:30:00.000Z' });
    const settledEvent = event('daily', [settle(raw, 80, 'no')], {
      event_ticker: 'KXWTI-26JUL2014',
      strike_date: '2026-07-20T18:30:00.000Z',
    });
    settledEvent.markets[0].event_ticker = settledEvent.event_ticker;
    settledEvent.markets[0].ticker = `${settledEvent.event_ticker}-T80.00`;
    const metadata = { event: { ...settledEvent, markets: undefined }, closeTime: settledEvent.strike_date };

    expect(verifySettledWtiEvent({ event: settledEvent }, metadata, 'daily', Date.parse('2026-07-25T12:00:00Z')))
      .toEqual(expect.objectContaining({ settlementValue: 80 }));
    settledEvent.markets[0] = settle(settledEvent.markets[0], 80, 'yes');
    expect(verifySettledWtiEvent({ event: settledEvent }, metadata, 'daily', Date.parse('2026-07-25T12:00:00Z')))
      .toBeNull();
  });

  test('verifies mutually exclusive weekly boundary outcomes', () => {
    const settledMarkets = [
      settle(weeklyMarket('lower', { close_time: '2026-07-17T18:30:00.000Z' }), 70, 'no'),
      settle(weeklyMarket('bucket', { close_time: '2026-07-17T18:30:00.000Z' }), 70, 'yes'),
      settle(weeklyMarket('upper', { close_time: '2026-07-17T18:30:00.000Z' }), 70, 'no'),
    ];
    const settledEvent = event('weekly', settledMarkets, {
      event_ticker: 'KXWTIW-26JUL1714',
      strike_date: '2026-07-17T18:30:00.000Z',
    });
    settledEvent.markets.forEach((market, index) => {
      market.event_ticker = settledEvent.event_ticker;
      market.ticker = `${settledEvent.event_ticker}-${index}`;
    });
    const metadata = { event: { ...settledEvent, markets: undefined }, closeTime: settledEvent.strike_date };

    expect(verifySettledWtiEvent({ event: settledEvent }, metadata, 'weekly', Date.parse('2026-07-25T12:00:00Z')))
      .toEqual(expect.objectContaining({ settlementValue: 70 }));
  });

  test('returns settled history without any quote or execution fields', async () => {
    const ticker = 'KXWTI-26JUL2014';
    const settledMarkets = [79.5, 80].map((threshold) => {
      const market = settle(dailyMarket(threshold, { close_time: '2026-07-20T18:30:00.000Z' }), 79.75, threshold < 79.75 ? 'yes' : 'no');
      market.event_ticker = ticker;
      market.ticker = `${ticker}-T${threshold.toFixed(2)}`;
      return market;
    });
    const detailEvent = event('daily', settledMarkets, {
      event_ticker: ticker,
      strike_date: '2026-07-20T18:30:00.000Z',
    });
    const invalidMetadata = Array.from({ length: 6 }, (_, index) => {
      const day = 19 - index;
      return {
        event_ticker: `KXWTI-26JUL${String(day).padStart(2, '0')}14`,
        series_ticker: 'KXWTI',
        strike_date: `2026-07-${String(day).padStart(2, '0')}T18:30:00.000Z`,
        mutually_exclusive: false,
        available_on_brokers: true,
      };
    });
    const kalshiFetch = jest.fn(async (path) => {
      if (path === '/events') {
        return { events: [...invalidMetadata, {
          event_ticker: ticker,
          series_ticker: 'KXWTI',
          strike_date: detailEvent.strike_date,
          mutually_exclusive: false,
          available_on_brokers: true,
        }] };
      }
      if (invalidMetadata.some((row) => path === `/events/${row.event_ticker}`)) return { event: { markets: [] } };
      return { event: detailEvent };
    });

    const last = await getLastSettledWtiSession({ cadence: 'daily', kalshiFetch, now: () => Date.parse('2026-07-25T12:00:00Z') });
    expect(last).toEqual(expect.objectContaining({
      historicalOnly: true,
      executable: false,
      settlementValue: 79.75,
    }));
    expect(last.markets.map((market) => market.result)).toEqual(['yes', 'no']);
    const serializedLast = JSON.stringify(last.markets);
    expect(serializedLast).not.toMatch(/yesBid|yesAsk|noBid|noAsk|bidSize|askSize|lastPrice/i);

    const recent = await getRecentSettledWtiSessions({ cadence: 'daily', limit: 1, kalshiFetch, now: () => Date.parse('2026-07-25T12:00:00Z') });
    expect(recent).toEqual(expect.objectContaining({
      requestedLimit: 1,
      returnedCount: 1,
      historicalOnly: true,
      executable: false,
    }));
    expect(JSON.stringify(recent.sessions)).not.toMatch(/yesBid|yesAsk|noBid|noAsk|depth|lastPrice/i);
  });

  test('rejects historical sessions with mixed front-month contracts', () => {
    const markets = [
      settle(dailyMarket(79.5, { close_time: '2026-07-20T18:30:00.000Z' }), 79.75, 'yes'),
      settle(dailyMarket(80, {
        close_time: '2026-07-20T18:30:00.000Z',
        custom_strike: { front_month_contract: 'WBS 26V-ICE', strike_date: '2026-07-20T14:30:00-04:00' },
      }), 79.75, 'no'),
    ];
    const settledEvent = event('daily', markets, {
      event_ticker: 'KXWTI-26JUL2014',
      strike_date: '2026-07-20T18:30:00.000Z',
    });
    settledEvent.markets.forEach((market, index) => {
      market.event_ticker = settledEvent.event_ticker;
      market.ticker = `${settledEvent.event_ticker}-${index}`;
    });
    const metadata = { event: { ...settledEvent, markets: undefined }, closeTime: settledEvent.strike_date };
    expect(buildWtiSettlementMapping(settledEvent, markets).status).toBe('inconsistent');
    expect(verifySettledWtiEvent({ event: settledEvent }, metadata, 'daily', Date.parse('2026-07-25T12:00:00Z'))).toBeNull();
  });

  test('overview isolates an unavailable SPX market from CPI and WTI', async () => {
    const kalshiFetch = jest.fn(async (path, params) => {
      if (params.series_ticker === 'KXINXU') throw Object.assign(new Error('SPX unavailable'), { code: 'SPX_EVENT_UNAVAILABLE' });
      if (params.series_ticker === 'KXCPIYOY') {
        return { events: [{
          event_ticker: 'KXCPIYOY-26JUL',
          series_ticker: 'KXCPIYOY',
          title: 'CPI in July?',
          markets: [{
            ...directBook(),
            ticker: 'KXCPIYOY-26JUL-T2.9',
            event_ticker: 'KXCPIYOY-26JUL',
            title: 'Will CPI be above 2.9%?',
            status: 'active',
            close_time: '2026-08-12T12:30:00.000Z',
            updated_time: '2026-07-21T16:59:50.000Z',
          }],
        }] };
      }
      if (params.series_ticker === 'KXWTI') return { events: [event('daily', [dailyMarket(80)])] };
      if (params.series_ticker === 'KXWTIW') return { events: [event('weekly', [weeklyMarket('lower'), weeklyMarket('bucket'), weeklyMarket('upper')])] };
      throw new Error(`Unexpected series ${params.series_ticker}`);
    });

    const result = await getPredictionMarketsOverview({
      kalshiFetch,
      checkGatewayHealth: jest.fn().mockResolvedValue({ ok: false }),
      now: () => NOW,
    });

    expect(result.ok).toBe(true);
    expect(result.markets.cpi.status).toBe('available');
    expect(result.markets.spx).toEqual(expect.objectContaining({ status: 'unavailable', summary: null }));
    expect(result.markets.wti.daily.status).toBe('available');
    expect(result.markets.wti.weekly.status).toBe('available');
    expect(result.policy).toEqual(expect.objectContaining({
      factualComparisonOnly: true,
      automaticRankingAvailable: false,
    }));
  });
});
