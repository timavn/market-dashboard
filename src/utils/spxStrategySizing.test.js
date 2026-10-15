import {
  buildSpxStrategyCandidates,
  defaultSpxStrategyMix,
  resolveVerifiedPortfolioSizingBase,
  sizeSpxStrategy,
} from './spxStrategySizing';

const NOW = Date.parse('2026-08-17T15:00:00.000Z');

const livePortfolio = (overrides = {}) => ({
  accountId: 'U1234567',
  dataSource: 'ibkr_api',
  liveSessionVerified: true,
  fromCache: false,
  fetchedAt: '2026-08-17T14:59:40.000Z',
  socketVerifiedAt: '2026-08-17T14:59:42.000Z',
  summary: { totalValue: 250000 },
  accountSummary: {
    accountId: 'U1234567',
    netLiquidation: 250000,
    currency: 'USD',
    source: 'ibkr_live_session',
    lastUpdated: '2026-08-17T14:59:40.000Z',
    socketVerifiedAt: '2026-08-17T14:59:42.000Z',
  },
  ...overrides,
});

const contracts = {
  status: 'available',
  source: 'kalshi_trade_api_v2',
  asOf: '2026-08-17T14:59:45.000Z',
  expiresAt: '2026-08-17T15:01:15.000Z',
  event: { closeTime: '2026-08-17T20:00:00.000Z' },
};

const analysis = ({ ticker, threshold, side = 'YES', score = 7, ...book }) => ({
  line: {
    ticker,
    threshold,
    source: 'kalshi_trade_api_v2',
    derivedFields: [],
    volume24h: 100,
    openInterest: 80,
    ...book,
  },
  confluence: {
    side,
    score,
    maxScore: 8,
    eligibilityPassed: true,
    scoreReady: true,
  },
});

describe('SPX strategy live-data gates', () => {
  test('accepts only a fresh direct IBKR USD net-liquidation value', () => {
    expect(resolveVerifiedPortfolioSizingBase(livePortfolio(), 'U1234567', NOW)).toMatchObject({
      available: true,
      accountId: 'U1234567',
      currency: 'USD',
      netLiquidation: 250000,
    });

    expect(resolveVerifiedPortfolioSizingBase(livePortfolio({ fromCache: true }), 'U1234567', NOW))
      .toMatchObject({ available: false, reason: 'LIVE IBKR PORTFOLIO REQUIRED' });
    expect(resolveVerifiedPortfolioSizingBase(livePortfolio({
      fetchedAt: '2026-08-17T14:58:00.000Z',
    }), 'U1234567', NOW)).toMatchObject({ available: false, reason: 'PORTFOLIO STALE' });
    expect(resolveVerifiedPortfolioSizingBase(livePortfolio(), 'U7654321', NOW))
      .toMatchObject({ available: false, reason: 'ACCOUNT MISMATCH' });
  });

  test('uses only the model side direct ask/depth and never complements the other book', () => {
    const analyses = [
      analysis({
        ticker: 'YES-A', threshold: 7725, score: 7,
        yesBid: 0.40, yesAsk: 0.44, yesAskSize: 30,
        noBid: 0.56, noAsk: 0.60, noAskSize: 30,
      }),
      analysis({
        ticker: 'YES-B', threshold: 7730, score: 7,
        yesBid: 0.50, yesAsk: 0.52, yesAskSize: 20,
        noBid: 0.48, noAsk: 0.50, noAskSize: 20,
      }),
      analysis({
        ticker: 'NO-DIRECT', threshold: 7775, side: 'NO', score: 8,
        yesBid: 0.75, yesAsk: 0.80, yesAskSize: 90,
        noBid: 0.20, noAsk: 0.24, noAskSize: 40,
      }),
      analysis({
        ticker: 'NO-MISSING', threshold: 7780, side: 'NO', score: 8,
        yesBid: 0.70, yesAsk: 0.74, yesAskSize: 100,
        noBid: null, noAsk: null, noAskSize: null,
      }),
    ];

    const result = buildSpxStrategyCandidates({ analyses, contracts, nowMs: NOW });

    expect(result.map(({ ticker }) => ticker)).toEqual(['NO-DIRECT', 'YES-B', 'YES-A']);
    expect(result[0]).toMatchObject({ side: 'NO', ask: 0.24, askSize: 40 });
    expect(result.find(({ ticker }) => ticker === 'NO-MISSING')).toBeUndefined();
  });

  test('withholds every strategy when the Kalshi section expires or the event closes', () => {
    const analyses = [analysis({
      ticker: 'YES-A', threshold: 7725, yesBid: 0.40, yesAsk: 0.44, yesAskSize: 30,
    })];
    expect(buildSpxStrategyCandidates({
      analyses,
      contracts: { ...contracts, expiresAt: '2026-08-17T14:59:59.000Z' },
      nowMs: NOW,
    })).toEqual([]);
    expect(buildSpxStrategyCandidates({
      analyses,
      contracts: { ...contracts, event: { closeTime: '2026-08-17T14:59:59.000Z' } },
      nowMs: NOW,
    })).toEqual([]);
  });
});

describe('SPX strategy sizing', () => {
  const candidates = [
    { ticker: 'A', threshold: 7725, side: 'YES', ask: 0.50, askSize: 100, score: 8, maxScore: 8 },
    { ticker: 'B', threshold: 7730, side: 'YES', ask: 0.25, askSize: 1000, score: 7, maxScore: 8 },
    { ticker: 'C', threshold: 7735, side: 'YES', ask: 0.40, askSize: 1000, score: 6, maxScore: 8 },
  ];

  test('creates a complete neutral mix for one to three legs', () => {
    expect(defaultSpxStrategyMix(candidates)).toEqual({ A: 34, B: 33, C: 33 });
    expect(Object.values(defaultSpxStrategyMix(candidates)).reduce((sum, value) => sum + value, 0)).toBe(100);
  });

  test('sizes from portfolio percentage and caps each leg at visible direct ask depth', () => {
    const result = sizeSpxStrategy({
      candidates: candidates.slice(0, 2),
      netLiquidation: 100000,
      portfolioPercent: 1,
      legMix: { A: 50, B: 50 },
    });

    expect(result).toMatchObject({
      ready: true,
      budget: 1000,
      totalCost: 300,
      unusedBudget: 700,
      mixTotal: 100,
    });
    expect(result.legs[0]).toMatchObject({ quantity: 100, cost: 50, depthCapped: true });
    expect(result.legs[1]).toMatchObject({ quantity: 1000, cost: 250, depthCapped: true });
  });

  test('rejects an over-allocated leg mix instead of silently normalizing it', () => {
    expect(sizeSpxStrategy({
      candidates: candidates.slice(0, 2),
      netLiquidation: 100000,
      portfolioPercent: 2,
      legMix: { A: 60, B: 50 },
    })).toMatchObject({ ready: false, reason: 'MIX EXCEEDS 100%' });
  });
});
