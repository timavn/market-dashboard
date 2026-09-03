const {
  MARKET_ORDER,
  buildMorningReport,
} = require('./morningReport.cjs');

const NOW = new Date('2026-08-20T13:30:00.000Z');
const AS_OF = '2026-08-20T13:29:30.000Z';
const EXPIRES = '2026-08-20T13:31:00.000Z';
const CLOSE = '2026-08-20T20:00:00.000Z';

function directLine(overrides = {}) {
  return {
    ticker: 'LINE-100',
    threshold: 100,
    comparator: '>',
    status: 'available',
    yesBid: 0.40,
    yesAsk: 0.42,
    yesBidSize: 10,
    yesAskSize: 12,
    noBid: 0.58,
    noAsk: 0.60,
    noBidSize: 11,
    noAskSize: 13,
    volume24h: 123,
    openInterest: 45,
    updatedAt: AS_OF,
    source: 'kalshi_trade_api_v2',
    directNative: true,
    ...overrides,
  };
}

function snapshot(marketId, overrides = {}) {
  const line = directLine();
  const event = {
    ticker: `${marketId.toUpperCase()}-EVENT`,
    seriesTicker: `${marketId.toUpperCase()}-SERIES`,
    title: `${marketId} event`,
    status: 'open',
    closeTime: CLOSE,
    availableOnBrokers: true,
    brokerRoutable: true,
  };
  return {
    schemaVersion: 2,
    marketId,
    generatedAt: AS_OF,
    status: 'partial',
    spot: {
      status: 'available', availability: 'live', fit: 'exact', value: 101,
      source: 'resolver', asOf: AS_OF, expiresAt: EXPIRES,
    },
    riskRange: {
      status: 'available', lrr: 100, hrr: 130, previousClose: 105, trend: 'BULLISH', fit: 'calibration',
      ticker: 'TEST', date: '2026-08-20', source: 'risk-ranges', asOf: AS_OF, expiresAt: EXPIRES,
    },
    factors: {
      trade: {
        status: 'available', direction: 'BULLISH', raw: 'BULLISH', date: '2026-08-20',
        ticker: 'TEST', source: 'momo-tracker', asOf: AS_OF, expiresAt: EXPIRES,
      },
      usd: {
        status: 'available', r15: -0.2, r30: -0.5, r90: 0.1,
        source: 'DXY', asOf: AS_OF, expiresAt: EXPIRES,
      },
      cftc: {
        status: 'available', zScore1Y: -1.25, zScore3Y: -0.75,
        source: 'cftc', asOf: '2026-08-14', expiresAt: EXPIRES,
      },
    },
    displayContracts: {
      status: 'available', source: 'kalshi_trade_api_v2_catalog', asOf: AS_OF,
      expiresAt: CLOSE, event, lines: [line, directLine({ ticker: 'LINE-110', threshold: 110 })],
    },
    autoSelection: {
      status: 'available', venueId: 'kalshi', reason: null,
      contracts: {
        status: 'available', source: 'kalshi_trade_api_v2', asOf: AS_OF,
        expiresAt: EXPIRES, event, lines: [line],
      },
    },
    venues: {
      kalshi: {
        brokerRoutable: true,
        bookQuality: { eligible: true },
      },
    },
    strategy: {
      status: 'available', model: 'validated-test-model', eligibleVenueId: 'kalshi', reason: null,
    },
    ...overrides,
  };
}

describe('four-market morning report', () => {
  test('keeps the exact section order and qualifies only a complete LRR + aligned bullish setup', () => {
    const snapshots = Object.fromEntries(MARKET_ORDER.map((marketId) => [marketId, snapshot(marketId)]));
    snapshots.wti.factors = { ...snapshots.wti.factors, trade: null };
    snapshots.nasdaq100.riskRange = {
      ...snapshots.nasdaq100.riskRange,
      trend: 'BEARISH',
    };
    snapshots.gold.spot = {
      status: 'historical', availability: 'historical', fit: 'exact', value: 101,
      source: 'last close', asOf: '2026-08-19T20:00:00.000Z', expiresAt: EXPIRES,
    };

    const report = buildMorningReport(snapshots, { now: NOW });

    expect(report.marketOrder).toEqual(['sp500', 'wti', 'nasdaq100', 'gold']);
    expect(report.markets.map((market) => market.label)).toEqual(['S&P 500', 'WTI', 'Nasdaq 100', 'Gold']);
    expect(report.markets[0]).toMatchObject({
      rangeLocation: { zone: 'LRR' },
      rangePosition: {
        zone: 'LRR', referenceType: 'live', referenceLabel: 'Live', positionPct: 3.3,
        liveVerified: true, researchContextOnly: false,
      },
      bias: { status: 'aligned', trade: 'BULLISH', trend: 'BULLISH' },
      setup: {
        status: 'matched', pattern: 'BULLISH_AT_LRR', researchQualified: true,
        rankEligible: true, recommendationAllowed: false,
      },
    });
    expect(report.markets[1].setup).toMatchObject({ researchQualified: false, rankEligible: false });
    expect(report.markets[1].setup.reasons).toContain('Same-session Trade signal is unavailable.');
    expect(report.markets[2].setup.reasons).toContain('Trade and Trend are not aligned.');
    expect(report.markets[3].setup.reasons).toContain('Current exact resolver reference is unavailable.');
    expect(report.markets[3].rangePosition).toMatchObject({
      status: 'available', zone: 'LRR', referenceType: 'risk_range_previous_close',
      referenceLabel: 'RR close', value: 105, positionPct: 16.7,
      liveVerified: false, researchContextOnly: true,
    });
    expect(report.summary).toMatchObject({ matchedSetupCount: 1, rankEligibleCount: 1 });
    expect(report.policy.archiveUsedForCurrentFields).toBe(false);
    expect(report.policy.recommendationAllowed).toBe(false);
  });

  test('never promotes catalog geometry or event aggregates into a live quote', () => {
    const catalogOnly = snapshot('wti', {
      autoSelection: {
        status: 'unavailable',
        venueId: null,
        reason: 'No venue has a fresh complete native book.',
        contracts: { status: 'unavailable', event: null, lines: [] },
      },
      venues: {},
      strategy: { status: 'unavailable', model: null, eligibleVenueId: null, reason: 'No validated strategy.' },
    });
    catalogOnly.displayContracts.eventVolume24h = 999999;
    catalogOnly.displayContracts.eventOpenInterest = 888888;

    const report = buildMorningReport({ wti: catalogOnly }, { now: NOW });
    const wti = report.markets.find((market) => market.marketId === 'wti');

    expect(wti.catalog).toMatchObject({ status: 'available', contractCount: 2, catalogOnly: true });
    expect(wti.catalog).not.toHaveProperty('volume24h');
    expect(wti.catalog).not.toHaveProperty('openInterest');
    expect(wti.directBook).toMatchObject({ status: 'unavailable', focusLines: [], executionVerified: false });
    expect(wti.setup.researchQualified).toBe(true);
    expect(wti.setup.rankEligible).toBe(false);
  });

  test('fails closed for expired or refresh-failed inputs', () => {
    const stale = snapshot('sp500');
    stale.riskRange = { ...stale.riskRange, refreshFailed: true, refreshIssue: 'refresh failed' };
    stale.autoSelection.contracts = { ...stale.autoSelection.contracts, expiresAt: '2026-08-20T13:29:00.000Z' };

    const report = buildMorningReport({ sp500: stale }, { now: NOW });
    const sp500 = report.markets[0];

    expect(sp500.riskRange).toMatchObject({ status: 'unavailable', lrr: null, hrr: null, trend: null });
    expect(sp500.rangePosition.status).toBe('unavailable');
    expect(sp500.directBook).toMatchObject({ status: 'unavailable', focusLines: [] });
    expect(sp500.setup).toMatchObject({ researchQualified: false, rankEligible: false });
  });

  test.each(['related_only', 'strong_proxy', 'proxy'])(
    'never qualifies a %s Risk Range as a resolver setup',
    (fit) => {
      const related = snapshot('gold');
      related.riskRange = { ...related.riskRange, fit };

      const report = buildMorningReport({ gold: related }, { now: NOW });
      const gold = report.markets.find((market) => market.marketId === 'gold');

      expect(gold.riskRange).toMatchObject({ status: 'available', fit, setupEligible: false });
      expect(gold.setup).toMatchObject({ researchQualified: false, rankEligible: false });
      expect(gold.setup.reasons).toContain(
        'The available Risk Range is proxy or related-index context and is not setup-eligible.',
      );
    },
  );

  test.each([
    ['bullish lower-third boundary', 'BULLISH', 110, 'LRR', 'BULLISH_AT_LRR'],
    ['bearish upper-third boundary', 'BEARISH', 120, 'HRR', 'BEARISH_AT_HRR'],
  ])('includes the %s', (_label, signal, value, zone, pattern) => {
    const current = snapshot('sp500');
    current.spot = { ...current.spot, value };
    current.riskRange = { ...current.riskRange, trend: signal };
    current.factors = {
      ...current.factors,
      trade: { ...current.factors.trade, direction: signal, raw: signal },
    };

    const report = buildMorningReport({ sp500: current }, { now: NOW });
    expect(report.markets[0]).toMatchObject({
      rangeLocation: { zone },
      setup: { researchQualified: true, pattern },
    });
  });

  test.each([
    ['middle', 115, 'MIDDLE'],
    ['below', 99, 'BELOW_LRR'],
    ['above', 131, 'ABOVE_HRR'],
  ])('does not qualify a bullish price in the %s zone', (_label, value, zone) => {
    const current = snapshot('sp500');
    current.spot = { ...current.spot, value };
    const report = buildMorningReport({ sp500: current }, { now: NOW });
    expect(report.markets[0]).toMatchObject({
      rangeLocation: { zone },
      setup: { researchQualified: false, rankEligible: false },
    });
  });

  test('rejects a mismatched Trade date and refresh-failure text even without flags', () => {
    const wrongDate = snapshot('sp500');
    wrongDate.factors.trade = { ...wrongDate.factors.trade, date: '2026-08-19' };
    const failedRefresh = snapshot('wti');
    failedRefresh.spot = { ...failedRefresh.spot, error: 'latest refresh failed' };

    const report = buildMorningReport({ sp500: wrongDate, wti: failedRefresh }, { now: NOW });
    expect(report.markets[0].trade.status).toBe('unavailable');
    expect(report.markets[0].setup.researchQualified).toBe(false);
    expect(report.markets[1].reference.status).toBe('unavailable');
    expect(report.markets[1].setup.researchQualified).toBe(false);
  });

  test('preserves Neutral as the published Trend and exposes Buy/Sell Trade levels', () => {
    const current = snapshot('nasdaq100');
    current.riskRange = { ...current.riskRange, trend: 'NEUTRAL', previousClose: 109 };

    const report = buildMorningReport({ nasdaq100: current }, { now: NOW });
    const nasdaq = report.markets.find((market) => market.marketId === 'nasdaq100');

    expect(nasdaq.riskRange).toMatchObject({
      status: 'available', trend: 'NEUTRAL', buyTrade: 100, sellTrade: 130,
      previousClose: 109,
    });
  });

  test('keeps independently current research fields after a quote refresh failure', () => {
    const retained = snapshot('sp500', {
      refresh: {
        state: 'refreshing',
        lastError: {
          code: 'PM_MONITOR_REFRESH_FAILED',
          message: 'monitor transport failed',
        },
      },
    });

    const report = buildMorningReport({ sp500: retained }, { now: NOW });
    expect(report.markets[0]).toMatchObject({
      riskRange: { status: 'available', buyTrade: 100, sellTrade: 130 },
      trade: { status: 'available' },
      reference: { status: 'unavailable' },
      rangePosition: {
        status: 'available', referenceType: 'risk_range_previous_close', value: 105,
      },
      setup: { researchQualified: false, rankEligible: false },
    });
  });
});
