import {
  describeWtiGeometry,
  filterWtiPositionsForEvent,
  findWtiRiskRangeForEvent,
  hasCompleteNativeWtiBook,
  normalizeOvxReference,
  normalizeSettledWtiSession,
  normalizeWtiMarket,
  normalizeWtiWorkbench,
  resolveWtiMarketAtValue,
} from './wtiPredictionMarket';

const NOW = Date.parse('2026-07-21T18:31:00.000Z');

function dailyMarket(overrides = {}) {
  return {
    ticker: 'KXWTI-26JUL2114-T83.99',
    eventTicker: 'KXWTI-26JUL2114',
    geometry: {
      kind: 'above',
      strikeType: 'greater',
      threshold: 83.99,
      lowerBound: 83.99,
      upperBound: null,
      lowerInclusive: false,
      upperInclusive: false,
    },
    yesBid: 0.64,
    yesAsk: 0.66,
    yesBidSize: 400,
    yesAskSize: 300,
    noBid: 0.33,
    noAsk: 0.35,
    noBidSize: null,
    noAskSize: null,
    nativeBook: {
      yesPrices: true,
      noPrices: true,
      yesDepth: true,
      noDepth: false,
      complete: true,
      derivedFields: [],
    },
    volume24h: 12000,
    openInterest: 4500,
    ...overrides,
  };
}

function livePayload(overrides = {}) {
  return {
    ok: true,
    marketType: 'daily',
    seriesTicker: 'KXWTI',
    fetchedAt: '2026-07-21T18:30:30.000Z',
    historicalOnly: false,
    executable: false,
    provider: { status: 'live', source: 'direct_venue_snapshot' },
    event: {
      ticker: 'KXWTI-26JUL2114',
      seriesTicker: 'KXWTI',
      title: 'WTI price today',
      status: 'active',
      closeTime: '2026-07-21T18:30:00.000Z',
      strikeDate: '2026-07-21',
      settlementSource: { name: 'ICE WTI settlement' },
    },
    settlementMapping: {
      status: 'verified',
      contractLabel: 'CLU26',
      contractMonth: '2026-09',
      observation: 'ICE settlement',
      unit: 'USD per barrel',
      precision: 2,
      rollConvention: 'Venue front month',
      proxyCalibrationAvailable: false,
    },
    markets: [dailyMarket()],
    policy: { researchOnly: true },
    ...overrides,
  };
}

describe('WTI live ladder normalization', () => {
  test('accepts exact-series fresh Daily data and preserves every native side', () => {
    const result = normalizeWtiWorkbench(livePayload(), 'daily', NOW);

    expect(result.ok).toBe(true);
    expect(result.data.seriesTicker).toBe('KXWTI');
    expect(result.data.markets[0]).toEqual(expect.objectContaining({
      operator: '>',
      threshold: 83.99,
      yesBid: 0.64,
      yesAsk: 0.66,
      noBid: 0.33,
      noAsk: 0.35,
      yesBidSize: 400,
      noAskSize: null,
    }));
    expect(result.data.policy).toEqual(expect.objectContaining({
      researchOnly: true,
      recommendationAvailable: false,
      orderEntryAvailable: false,
    }));
  });

  test('keeps a directly quoted ladder visible when every row lacks complete depth', () => {
    const incomplete = dailyMarket({
      yesBidSize: 0,
      yesAskSize: 0,
      nativeBook: {
        yesPrices: true,
        noPrices: true,
        yesDepth: false,
        noDepth: false,
        complete: false,
        derivedFields: [],
      },
    });
    const result = normalizeWtiWorkbench(livePayload({ markets: [incomplete] }), 'daily', NOW);

    expect(result.ok).toBe(true);
    expect(result.data.markets[0]).toEqual(expect.objectContaining({
      yesBid: 0.64,
      noAsk: 0.35,
    }));
    expect(hasCompleteNativeWtiBook(result.data.markets[0])).toBe(false);
  });

  test('falls back only when no direct native side is available anywhere in the ladder', () => {
    const unavailable = dailyMarket({
      yesBid: null,
      yesAsk: null,
      noBid: null,
      noAsk: null,
      nativeBook: { complete: false, derivedFields: [] },
    });

    expect(normalizeWtiWorkbench(livePayload({ markets: [unavailable] }), 'daily', NOW))
      .toEqual(expect.objectContaining({ ok: false, reason: 'no_direct_native_book' }));
  });

  test('rejects a weekly series on the Daily endpoint and vice versa', () => {
    const wrongDaily = normalizeWtiWorkbench(livePayload({
      seriesTicker: 'KXWTIW',
      event: {
        ...livePayload().event,
        ticker: 'KXWTIW-26JUL2414',
        seriesTicker: 'KXWTIW',
      },
    }), 'daily', NOW);
    const wrongWeekly = normalizeWtiWorkbench(livePayload(), 'weekly', NOW);

    expect(wrongDaily).toEqual(expect.objectContaining({ ok: false, reason: 'wrong_series' }));
    expect(wrongWeekly).toEqual(expect.objectContaining({ ok: false, reason: 'wrong_series' }));
  });

  test.each([
    ['stale timestamp', livePayload({ fetchedAt: '2026-07-21T18:20:00.000Z' })],
    ['cache-only source', livePayload({ source: 'cache_only' })],
    ['mock provider', livePayload({ provider: { status: 'live', source: 'mock' } })],
    ['disconnected provider', livePayload({ provider: { status: 'disconnected', source: 'direct_venue_snapshot' } })],
  ])('rejects %s as active trading data', (_label, payload) => {
    expect(normalizeWtiWorkbench(payload, 'daily', NOW).ok).toBe(false);
  });

  test('never infers a missing NO quote from YES and keeps the row incomplete', () => {
    const result = normalizeWtiMarket(dailyMarket({ noAsk: null }), 'daily');

    expect(result.noAsk).toBeNull();
    expect(result.yesBid).toBe(0.64);
    expect(hasCompleteNativeWtiBook(result)).toBe(false);
  });

  test('accepts absent NO depth without deriving it but requires positive native YES depth', () => {
    const complete = normalizeWtiMarket(dailyMarket(), 'daily');
    const zeroYesDepth = normalizeWtiMarket(dailyMarket({ yesAskSize: 0 }), 'daily');

    expect(complete.noBidSize).toBeNull();
    expect(complete.noAskSize).toBeNull();
    expect(hasCompleteNativeWtiBook(complete)).toBe(true);
    expect(hasCompleteNativeWtiBook(zeroYesDepth)).toBe(false);
  });

  test('honors an authoritative incomplete nativeBook flag and rejects derived fields', () => {
    const flagged = normalizeWtiMarket(dailyMarket({ nativeBook: { complete: false, derivedFields: [] } }), 'daily');
    const derived = normalizeWtiMarket(dailyMarket({ nativeBook: { complete: true, derivedFields: ['noAsk'] } }), 'daily');

    expect(hasCompleteNativeWtiBook(flagged)).toBe(false);
    expect(hasCompleteNativeWtiBook(derived)).toBe(false);
  });
});

describe('WTI Daily and Weekly settlement geometry', () => {
  test('Daily KXWTI is strict above, so equality resolves NO', () => {
    const market = normalizeWtiMarket(dailyMarket(), 'daily');

    expect(resolveWtiMarketAtValue(market, 83.99)).toBe('no');
    expect(resolveWtiMarketAtValue(market, 84)).toBe('yes');
    expect(describeWtiGeometry(market)).toBe('WTI > $83.99');
  });

  test('Weekly lower tail, bounded bucket, and upper tail honor explicit boundaries', () => {
    const lowerTail = normalizeWtiMarket({
      ticker: 'KXWTIW-26JUL2414-B80', eventTicker: 'KXWTIW-26JUL2414', geometry: 'below', upper: 80,
      upperInclusive: false,
    }, 'weekly', { historical: true });
    const bucket = normalizeWtiMarket({
      ticker: 'KXWTIW-26JUL2414-B84.50', eventTicker: 'KXWTIW-26JUL2414', geometry: 'between', lower: 84.5, upper: 84.99,
      lowerInclusive: true, upperInclusive: true,
    }, 'weekly', { historical: true });
    const upperTail = normalizeWtiMarket({
      ticker: 'KXWTIW-26JUL2414-B90', eventTicker: 'KXWTIW-26JUL2414', geometry: 'above', lower: 90,
      lowerInclusive: true,
    }, 'weekly', { historical: true });

    expect(resolveWtiMarketAtValue(lowerTail, 80)).toBe('no');
    expect(resolveWtiMarketAtValue(lowerTail, 79.99)).toBe('yes');
    expect(resolveWtiMarketAtValue(bucket, 84.5)).toBe('yes');
    expect(resolveWtiMarketAtValue(bucket, 84.99)).toBe('yes');
    expect(resolveWtiMarketAtValue(upperTail, 90)).toBe('yes');
    expect(describeWtiGeometry(bucket)).toBe('WTI [$84.50 – $84.99]');
  });

  test('withholds a boundary resolution when Weekly inclusivity is absent', () => {
    const bucket = normalizeWtiMarket({
      ticker: 'KXWTIW-26JUL2414-B84.50', geometry: 'between', lower: 84.5, upper: 84.99,
    }, 'weekly', { historical: true });

    expect(resolveWtiMarketAtValue(bucket, 84.5)).toBeNull();
    expect(resolveWtiMarketAtValue(bucket, 84.75)).toBe('yes');
  });
});

describe('settled WTI safety', () => {
  test('accepts a verified Daily settlement and strips every live quote field', () => {
    const settled = normalizeSettledWtiSession({
      historicalOnly: true,
      executable: false,
      seriesTicker: 'KXWTI',
      event: { ...livePayload().event, status: 'settled' },
      settlementValue: 84,
      settlementTime: '2026-07-21T18:31:00.000Z',
      settlementMapping: livePayload().settlementMapping,
      markets: [dailyMarket({ result: 'yes', settlementPayout: 1 })],
    }, 'daily');

    expect(settled).not.toBeNull();
    expect(settled.markets[0]).toEqual(expect.objectContaining({ result: 'yes', settlementPayout: 1 }));
    expect(settled.markets[0]).not.toHaveProperty('yesBid');
    expect(settled.markets[0]).not.toHaveProperty('noAsk');
    expect(settled.policy).toEqual(expect.objectContaining({ quotesAvailable: false, executable: false }));
  });

  test('rejects a contradictory payout, duplicate geometry, non-final event, or missing mapping', () => {
    const base = {
      historicalOnly: true,
      executable: false,
      seriesTicker: 'KXWTI',
      event: { ...livePayload().event, status: 'settled' },
      settlementValue: 84,
      settlementMapping: livePayload().settlementMapping,
      markets: [dailyMarket({ result: 'yes', settlementPayout: 1 })],
    };
    expect(normalizeSettledWtiSession({ ...base, markets: [dailyMarket({ result: 'no', settlementPayout: 0 })] }, 'daily')).toBeNull();
    expect(normalizeSettledWtiSession({ ...base, markets: [base.markets[0], { ...base.markets[0], ticker: 'DUPLICATE' }] }, 'daily')).toBeNull();
    expect(normalizeSettledWtiSession({ ...base, event: { ...base.event, status: 'active' } }, 'daily')).toBeNull();
    expect(normalizeSettledWtiSession({ ...base, settlementMapping: { status: 'unavailable' } }, 'daily')).toBeNull();
  });
});

describe('localized WTI reference inputs and positions', () => {
  test('matches only a finite exact-date WTIC range', () => {
    const event = { closeTime: '2026-07-21T18:30:00.000Z' };
    const history = [
      { ticker: 'WTIC', date: '2026-07-18', lrr: 70, hrr: 85 },
      { ticker: 'WTIC', date: '2026-07-21', lrr: 71.25, hrr: 84.5, trend: 'BEARISH' },
    ];

    expect(findWtiRiskRangeForEvent(history, event)).toEqual(expect.objectContaining({ date: '2026-07-21', lrr: 71.25, hrr: 84.5 }));
    expect(findWtiRiskRangeForEvent([{ ticker: 'WTIC', date: '2026-07-21', lrr: 85, hrr: 70 }], event)).toBeNull();
  });

  test('accepts only current-session OVX context and never exposes it as executable', () => {
    const snapshot = {
      lastUpdated: '2026-07-21T18:25:00.000Z',
      OVX: {
        lastPx: 64.45,
        asOf: '2026-07-21T18:25:00.000Z',
        availability: 'available',
        freshness: 'current',
        source: 'Cboe Global Indices',
        quoteMode: 'delayed',
      },
    };

    expect(normalizeOvxReference(snapshot, { now: NOW })).toEqual(expect.objectContaining({
      status: 'available', value: 64.45, quoteMode: 'delayed', executable: false,
    }));
    expect(normalizeOvxReference({ ...snapshot, OVX: { ...snapshot.OVX, freshness: 'stale' } }, { now: NOW }).status).toBe('unavailable');
    expect(normalizeOvxReference(snapshot, { now: NOW, historical: true }).status).toBe('unavailable');
  });

  test('shows positions only from a verified state and exact selected event', () => {
    const positions = [
      { localSymbol: 'KXWTI-26JUL2114-T83.99_YES', quantity: 4 },
      { localSymbol: 'KXWTIW-26JUL2414-B84.50_YES', quantity: 7 },
      { marketFamily: 'wti_daily', localSymbol: 'KXWTI-OTHER-T83.99_YES', quantity: 8 },
    ];

    expect(filterWtiPositionsForEvent({ status: 'live', positions }, 'KXWTI-26JUL2114')).toEqual([positions[0]]);
    expect(filterWtiPositionsForEvent({ status: 'unavailable', positions }, 'KXWTI-26JUL2114')).toEqual([]);
  });
});
