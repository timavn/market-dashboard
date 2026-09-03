import {
  activePredictionMarketNavIndicators,
  normalizePredictionMarketNavIndicators,
} from './predictionMarketNavIndicators';

const NOW = Date.parse('2026-08-20T13:30:00.000Z');
const AS_OF = '2026-08-20T13:29:30.000Z';
const EXPIRES = '2026-08-20T13:31:00.000Z';
const MARKET_IDS = ['sp500', 'wti', 'nasdaq100', 'gold'];
const TICKERS = {
  sp500: { riskRange: 'SPX', trade: 'SPX' },
  wti: { riskRange: 'WTIC', trade: 'USO' },
  nasdaq100: { riskRange: 'COMPQ', trade: 'COMPQ' },
  gold: { riskRange: 'GLD', trade: 'GLD' },
};

function unavailableMarket(marketId) {
  return { marketId };
}

function validMarket(marketId, {
  signal = 'BULLISH',
  price = signal === 'BULLISH' ? 101 : 129,
  fit = 'calibration',
  setupEligible = true,
} = {}) {
  const bullish = signal === 'BULLISH';
  return {
    marketId,
    riskRange: {
      status: 'available', lrr: 100, hrr: 130, trend: signal, date: '2026-08-20',
      ticker: TICKERS[marketId].riskRange, fit, setupEligible, source: 'risk_ranges',
      asOf: AS_OF, expiresAt: EXPIRES, reason: null,
    },
    trade: {
      status: 'available', direction: signal, date: '2026-08-20',
      ticker: TICKERS[marketId].trade, source: 'momo-tracker', asOf: AS_OF,
      expiresAt: EXPIRES, reason: null,
    },
    reference: {
      status: 'available', availability: 'live', fit: 'exact', value: price,
      source: 'ibkr_live', asOf: AS_OF, expiresAt: EXPIRES, reason: null,
    },
    bias: { status: 'aligned', trade: signal, trend: signal, aligned: true },
    rangeLocation: {
      status: 'available', zone: bullish ? 'LRR' : 'HRR', value: price, reason: null,
    },
    directBook: { status: 'unavailable' },
    strategy: { status: 'unavailable' },
    setup: {
      status: 'matched',
      pattern: bullish ? 'BULLISH_AT_LRR' : 'BEARISH_AT_HRR',
      tradeTrendAligned: true,
      researchQualified: true,
      rankEligible: false,
      recommendationAllowed: false,
      reasons: ['No verified direct native book is available.', 'No validated strategy is available.'],
    },
  };
}

function reportWith(...markets) {
  const byId = Object.fromEntries(markets.map((market) => [market.marketId, market]));
  return {
    schemaVersion: 1,
    reportType: 'four_market_morning',
    generatedAt: new Date(NOW).toISOString(),
    status: 'unavailable',
    marketOrder: [...MARKET_IDS],
    markets: MARKET_IDS.map((marketId) => byId[marketId] || unavailableMarket(marketId)),
    policy: { recommendationAllowed: false },
  };
}

describe('prediction-market navigation indicator guard', () => {
  test('accepts inclusive lower/upper third boundaries without requiring a book or strategy', () => {
    const normalized = normalizePredictionMarketNavIndicators(reportWith(
      validMarket('sp500', { signal: 'BULLISH', price: 110 }),
      validMarket('wti', { signal: 'BEARISH', price: 120 }),
    ), { now: NOW });

    expect(normalized.indicators).toEqual({
      sp500: {
        tone: 'bullish',
        description: 'Aligned bullish Trade and Trend in the lower Risk Range third.',
        expiresAt: EXPIRES,
      },
      wti: {
        tone: 'bearish',
        description: 'Aligned bearish Trade and Trend in the upper Risk Range third.',
        expiresAt: EXPIRES,
      },
    });
  });

  test.each([
    ['middle price', (market) => ({
      ...market,
      reference: { ...market.reference, value: 115 },
      rangeLocation: { ...market.rangeLocation, zone: 'MIDDLE', value: 115 },
    })],
    ['outside-RR price', (market) => ({
      ...market,
      reference: { ...market.reference, value: 99 },
      rangeLocation: { ...market.rangeLocation, zone: 'BELOW_LRR', value: 99 },
    })],
    ['missing Trade', (market) => ({ ...market, trade: { status: 'unavailable' } })],
    ['neutral Trade', (market) => ({ ...market, trade: { ...market.trade, direction: 'NEUTRAL' } })],
    ['misaligned bias', (market) => ({
      ...market,
      riskRange: { ...market.riskRange, trend: 'BEARISH' },
      bias: { status: 'misaligned', trade: 'BULLISH', trend: 'BEARISH', aligned: false },
    })],
    ['proxy range', (market) => ({
      ...market,
      riskRange: { ...market.riskRange, fit: 'strong_proxy', setupEligible: false },
    })],
    ['expired Trade', (market) => ({
      ...market,
      trade: { ...market.trade, expiresAt: '2026-08-20T13:29:59.000Z' },
    })],
    ['refresh failure metadata', (market) => ({
      ...market,
      reference: { ...market.reference, error: 'latest refresh failed' },
    })],
    ['wrong exact Trade ticker', (market) => ({
      ...market,
      trade: { ...market.trade, ticker: 'OIL' },
    })],
    ['wrong Trade date', (market) => ({
      ...market,
      trade: { ...market.trade, date: '2026-08-19' },
    })],
    ['server/client zone disagreement', (market) => ({
      ...market,
      rangeLocation: { ...market.rangeLocation, zone: 'HRR' },
    })],
  ])('fails closed for %s', (_label, mutate) => {
    const normalized = normalizePredictionMarketNavIndicators(
      reportWith(mutate(validMarket('wti'))),
      { now: NOW },
    );
    expect(normalized.indicators).toEqual({});
  });

  test.each([
    null,
    {},
    { schemaVersion: 1, reportType: 'four_market_morning', generatedAt: AS_OF },
    { ...reportWith(), schemaVersion: 2 },
    { ...reportWith(), generatedAt: '2026-08-20T13:28:00.000Z' },
    { ...reportWith(), markets: [unavailableMarket('sp500')] },
  ])('rejects a malformed or stale whole report', (value) => {
    expect(() => normalizePredictionMarketNavIndicators(value, { now: NOW })).toThrow(
      'Prediction-market morning report is malformed, stale, or incomplete.',
    );
  });

  test('removes a normalized indicator once its required source expires', () => {
    const normalized = normalizePredictionMarketNavIndicators(
      reportWith(validMarket('sp500')),
      { now: NOW },
    );
    expect(activePredictionMarketNavIndicators(normalized, { now: NOW })).toHaveProperty('sp500');
    expect(activePredictionMarketNavIndicators(normalized, {
      now: Date.parse(EXPIRES),
    })).toEqual({});
  });
});

