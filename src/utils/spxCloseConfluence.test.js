import {
  buildSpxCloseConfluence,
  extractSpxTradeSignal,
  normalizeMarketStructureSnapshot,
  normalizeVixSnapshot,
  SPX_CONFLUENCE_MAX_SCORE,
  USD_CORRELATION_BASE_TIER,
  USD_CORRELATION_STRONG_TIER,
} from './spxCloseConfluence';

const TARGET_DATE = '2026-07-20';

const alignedStructure = (direction = 'bullish', overrides = {}) => ({
  date: TARGET_DATE,
  gammaExposure: 'positive',
  systematicFlow: direction,
  pvBand: direction === 'bullish' ? 'long' : 'short',
  strategicAllocation: direction === 'bullish' ? 'risk_on' : 'risk_off',
  ...overrides,
});

const readyInputs = (direction = 'bullish', overrides = {}) => ({
  targetDate: TARGET_DATE,
  historical: true,
  riskRange: {
    date: TARGET_DATE,
    lrr: 7400,
    hrr: 7500,
    trend: direction,
  },
  trade: {
    date: TARGET_DATE,
    direction,
  },
  selectedMarket: {
    threshold: 7450,
  },
  usd: {
    date: TARGET_DATE,
    sourceStatus: 'current',
    r15: -0.6,
    r30: -0.6,
    r90: -0.6,
  },
  vix: {
    date: TARGET_DATE,
    current: true,
    bucket: direction === 'bullish' ? 'investable' : 'uninvestable',
  },
  marketStructure: alignedStructure(direction),
  ...overrides,
});

describe('buildSpxCloseConfluence eligibility gate', () => {
  test('Bullish Trade plus Bullish Trend makes the eligible contract side YES', () => {
    const result = buildSpxCloseConfluence(readyInputs('bullish'));

    expect(result).toEqual(expect.objectContaining({
      direction: 'bullish',
      side: 'YES',
      eligibilityPassed: true,
      scoreReady: true,
      status: 'scored',
      maxScore: SPX_CONFLUENCE_MAX_SCORE,
    }));
    expect(result.blockers).toEqual([]);
    expect(result.score).toBeGreaterThan(0);
  });

  test('Bearish Trade plus Bearish Trend makes the eligible contract side NO', () => {
    const result = buildSpxCloseConfluence(readyInputs('bearish'));

    expect(result).toEqual(expect.objectContaining({
      direction: 'bearish',
      side: 'NO',
      eligibilityPassed: true,
      scoreReady: true,
      status: 'scored',
    }));
    expect(result.blockers).toEqual([]);
    expect(result.score).toBeGreaterThan(0);
  });

  test.each([
    {
      label: 'missing Trade',
      change: { trade: null },
      blocker: 'Published SPX Trade is unavailable',
    },
    {
      label: 'missing Trend',
      change: {
        riskRange: { date: TARGET_DATE, lrr: 7400, hrr: 7500, trend: null },
      },
      blocker: 'Published SPX Trend is unavailable',
    },
    {
      label: 'misaligned Trade and Trend',
      change: { trade: { date: TARGET_DATE, direction: 'bearish' } },
      blocker: 'SPX Trade and Trend are not aligned',
    },
    {
      label: 'wrong-date Trade',
      change: { trade: { date: '2026-07-17', direction: 'bullish' } },
      blocker: 'SPX Trade is not dated for this contract session',
    },
    {
      label: 'wrong-date Trend',
      change: {
        riskRange: { date: '2026-07-17', lrr: 7400, hrr: 7500, trend: 'bullish' },
      },
      blocker: 'SPX Trend is not dated for this contract session',
    },
  ])('$label blocks the setup and withholds a score', ({ change, blocker }) => {
    const result = buildSpxCloseConfluence(readyInputs('bullish', change));

    expect(result.eligibilityPassed).toBe(false);
    expect(result.status).toBe('blocked');
    expect(result.direction).toBeNull();
    expect(result.side).toBeNull();
    expect(result.scoreReady).toBe(false);
    expect(result.score).toBeNull();
    expect(result.blockers).toContain(blocker);
  });

  test('Trend is never silently reused as the independent Trade signal', () => {
    const trade = extractSpxTradeSignal(null, {
      date: TARGET_DATE,
      lrr: 7400,
      hrr: 7500,
      trend: 'Bullish',
    });

    expect(trade.direction).toBeNull();
    expect(trade.raw).toBeNull();
  });

  test('a selected strike outside the Risk Range blocks the setup', () => {
    const result = buildSpxCloseConfluence(readyInputs('bullish', {
      selectedMarket: { threshold: 7510 },
    }));

    expect(result.geometry.strikeInside).toBe(false);
    expect(result.geometry.available).toBe(false);
    expect(result.gamma.available).toBe(false);
    expect(result.gamma.points).toBeNull();
    expect(result.eligibilityPassed).toBe(false);
    expect(result.score).toBeNull();
    expect(result.blockers).toContain('Selected strike is outside the Hedgeye Risk Range');
  });
});

describe('SPX close confluence point domains', () => {
  test.each([
    ['bullish', 7450, 0.5, 1],
    ['bullish', 7425, 0.75, 2],
    ['bearish', 7450, 0.5, 1],
    ['bearish', 7475, 0.75, 2],
  ])(
    '%s geometry at strike %d awards the inclusive %p coverage boundary',
    (direction, threshold, coverage, points) => {
      const result = buildSpxCloseConfluence(readyInputs(direction, {
        selectedMarket: { threshold },
      }));

      expect(result.geometry.available).toBe(true);
      expect(result.geometry.coverage).toBeCloseTo(coverage, 8);
      expect(result.geometry.points).toBe(points);
    },
  );

  test.each([
    [-(USD_CORRELATION_BASE_TIER - 0.01), -0.49, -0.49, 0, true],
    [-USD_CORRELATION_BASE_TIER, -0.5, -0.5, 1, true],
    [-USD_CORRELATION_STRONG_TIER, -0.7, -0.7, 2, true],
    [-USD_CORRELATION_STRONG_TIER, -0.7, 0.7, 1, false],
  ])(
    'USD r30=%p with r15=%p and r90=%p awards %d point(s)',
    (r30, r15, r90, points, stableSign) => {
      const result = buildSpxCloseConfluence(readyInputs('bullish', {
        usd: {
          date: TARGET_DATE,
          sourceStatus: 'current',
          r15,
          r30,
          r90,
        },
      }));

      expect(result.correlation.available).toBe(true);
      expect(result.correlation.points).toBe(points);
      expect(result.correlation.stableSign).toBe(stableSign);
    },
  );

  test.each([
    ['positive', 7425, 1],
    ['negative', 7425, 0],
    ['positive', 7475, 0],
    ['negative', 7475, 1],
    ['neutral', 7425, 0],
  ])(
    '%s gamma at bullish strike %d awards %d point(s)',
    (gammaExposure, threshold, points) => {
      const result = buildSpxCloseConfluence(readyInputs('bullish', {
        selectedMarket: { threshold },
        marketStructure: alignedStructure('bullish', { gammaExposure }),
      }));

      expect(result.gamma.available).toBe(true);
      expect(result.gamma.points).toBe(points);
    },
  );

  test.each([
    [8.99, null],
    [9, 'investable'],
    [19.99, 'investable'],
    [20, 'chop'],
    [28.99, 'chop'],
    [29, 'uninvestable'],
  ])('VIX %p maps to the %p bucket', (lastPx, bucket) => {
    const normalized = normalizeVixSnapshot({
      lastUpdated: `${TARGET_DATE}T15:00:00-04:00`,
      VIX: {
        lastPx,
        asOf: `${TARGET_DATE}T15:00:00-04:00`,
        availability: 'available',
        freshness: 'current',
      },
    });

    expect(normalized.bucket).toBe(bucket);
  });

  test.each([
    ['bullish', 'investable', 1],
    ['bullish', 'chop', 0],
    ['bullish', 'uninvestable', 0],
    ['bearish', 'uninvestable', 1],
    ['bearish', 'chop', 0],
    ['bearish', 'investable', 0],
  ])(
    '%s setup with VIX %s awards %d volatility point',
    (direction, bucket, points) => {
      const result = buildSpxCloseConfluence(readyInputs(direction, {
        vix: { date: TARGET_DATE, current: true, bucket },
      }));

      expect(result.volatility.available).toBe(true);
      expect(result.volatility.points).toBe(points);
    },
  );

  test.each([
    [
      { systematicFlow: 'bullish', pvBand: 'long', strategicAllocation: 'risk_on' },
      3,
      0,
      2,
    ],
    [
      { systematicFlow: 'bullish', pvBand: 'long', strategicAllocation: 'risk_off' },
      2,
      1,
      1,
    ],
    [
      { systematicFlow: 'bullish', pvBand: 'neutral', strategicAllocation: 'risk_off' },
      1,
      1,
      0,
    ],
  ])(
    'structure breadth (%p) records %d aligned and %d conflicting inputs',
    (structureSignals, alignedCount, conflictCount, points) => {
      const result = buildSpxCloseConfluence(readyInputs('bullish', {
        marketStructure: alignedStructure('bullish', structureSignals),
      }));

      expect(result.structure).toEqual(expect.objectContaining({
        available: true,
        alignedCount,
        conflictCount,
        points,
      }));
    },
  );

  test.each([
    ['USD correlation', { usd: null }, 'usd'],
    ['VIX', { vix: null }, 'volatility'],
    [
      'gamma',
      { marketStructure: alignedStructure('bullish', { gammaExposure: null }) },
      'volatility',
    ],
    ['market structure', { marketStructure: null }, 'structure'],
  ])('missing %s produces no numeric score', (_label, change, missingDomain) => {
    const result = buildSpxCloseConfluence(readyInputs('bullish', change));

    expect(result.eligibilityPassed).toBe(true);
    expect(result.scoreReady).toBe(false);
    expect(result.status).toBe('incomplete');
    expect(result.score).toBeNull();
    expect(result.band).toBeNull();
    expect(result.missing).toContain(missingDomain);
  });
});

describe('normalizeMarketStructureSnapshot', () => {
  test('parses the proposed nested SPX daily-email snapshot', () => {
    const normalized = normalizeMarketStructureSnapshot({
      snapshotType: 'hedgeye-market-structure',
      date: TARGET_DATE,
      scrapedAt: `${TARGET_DATE}T12:05:00.000Z`,
      data: {
        SPX: {
          gammaExposure: 'Positive',
          gammaVolatilityThrottle: '4.03',
          tenDayRealizedVolatility: '9.58',
          systematicFlowRisk: 'Neutral',
          pvBandRiskReward: 'Neutral',
          strategicAllocation: 'Risk On',
        },
      },
    });

    expect(normalized).toEqual({
      date: TARGET_DATE,
      scrapedAt: `${TARGET_DATE}T12:05:00.000Z`,
      source: 'hedgeye-market-structure',
      gammaExposure: 'positive',
      gammaExposureRaw: 'Positive',
      gammaThrottle: 4.03,
      realizedVol10d: 9.58,
      systematicFlow: 'neutral',
      systematicFlowRaw: 'Neutral',
      pvBand: 'neutral',
      pvBandRaw: 'Neutral',
      strategicAllocation: 'risk_on',
      strategicAllocationRaw: 'Risk On',
    });
  });
});
