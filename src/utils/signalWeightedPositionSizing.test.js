import {
  calculateAtrRiskCap,
  calculateBetaBand,
  calculateConviction,
  calculateDirectionalStreaks,
  calculateRangePosition,
  calculateRecordSignal,
  calculateSizingDecision,
  calculateTargetWeight,
  validateInstrumentContext,
  validateLiveContext,
  validateResearchProvenance,
} from './signalWeightedPositionSizing';

const NOW = '2026-07-17T19:00:00.000Z';

function liveContext(overrides = {}) {
  const { quote: quoteOverrides = {}, accountSummary: accountOverrides = {}, ...contextOverrides } = overrides;
  return {
    connected: true,
    status: 'live',
    quote: {
      source: 'ibkr',
      price: 100,
      asOf: '2026-07-17T18:59:30.000Z',
      dataType: 'live',
      ...quoteOverrides,
    },
    accountSummary: {
      source: 'ibkr',
      netLiquidationValue: 100_000,
      asOf: '2026-07-17T18:59:30.000Z',
      verified: true,
      ...accountOverrides,
    },
    ...contextOverrides,
  };
}

function baseInput(overrides = {}) {
  const spot = overrides.spot ?? 100;
  const netLiquidationValue = overrides.netLiquidationValue ?? 1_000_000;
  const defaultProvenance = {
    signals: {
      trade: { source: 'published-tracker', asOf: '2026-07-17' },
      trend: { source: 'published-risk-range', asOf: '2026-07-17' },
    },
    range: { source: 'published-risk-range', asOf: '2026-07-17', observations: 6 },
    records: { source: 'adjusted-daily-history', asOf: '2026-07-16', observations: 252 },
  };
  const hasProvenanceOverride = Object.prototype.hasOwnProperty.call(overrides, 'provenance');
  const provenance = hasProvenanceOverride && overrides.provenance == null
    ? overrides.provenance
    : {
      ...defaultProvenance,
      ...(overrides.provenance || {}),
      signals: {
        ...defaultProvenance.signals,
        ...(overrides.provenance?.signals || {}),
      },
    };
  const defaultInstrument = {
    source: 'ibkr',
    verified: true,
    tradable: true,
    securityType: 'STK',
    currency: 'USD',
    multiplier: 1,
    lotSize: 1,
  };
  const instrument = Object.prototype.hasOwnProperty.call(overrides, 'instrument')
    ? overrides.instrument
    : defaultInstrument;
  return {
    beta: { value: 1, observations: 252, source: 'adjusted-daily', asOf: '2026-07-16' },
    atr14: { value: 2, observations: 14, source: 'completed-daily-bars', asOf: '2026-07-16' },
    spot,
    netLiquidationValue,
    lrr: 90,
    hrr: 110,
    priorAth: 105,
    priorAtl: 70,
    tradeSignal: 'BULLISH',
    trendSignal: 'LONG',
    bias: 'LONG',
    riskRangeHistory: [
      { hrr: 101, lrr: 81 },
      { hrr: 102, lrr: 82 },
      { hrr: 103, lrr: 83 },
      { hrr: 104, lrr: 84 },
      { hrr: 105, lrr: 85 },
      { hrr: 110, lrr: 90 },
    ],
    liveContext: liveContext({
      quote: { price: spot },
      accountSummary: { netLiquidationValue },
    }),
    now: NOW,
    ...overrides,
    provenance,
    instrument,
  };
}

describe('beta and ATR bands (weights are percentage points)', () => {
  test.each([
    [0.2, 0.5, 4, 12],
    [-1, 1, 2, 6],
    [3, 2, 1, 3],
    [1.3, 1.3, 2, 4.5],
  ])('clamps and rounds beta %p bands for beta %p', (beta, effective, min, max) => {
    expect(calculateBetaBand(beta)).toMatchObject({
      available: true,
      effectiveBeta: effective,
      minWeight: min,
      betaMaxWeight: max,
      unit: 'percentage-points',
    });
  });

  test('rejects missing beta and object metrics below 126 observations', () => {
    expect(calculateBetaBand(null).reason).toBe('BETA_UNAVAILABLE');
    expect(calculateBetaBand({ value: 1, observations: 125 })).toMatchObject({
      available: false,
      reason: 'INSUFFICIENT_BETA_OBSERVATIONS',
    });
  });

  test('applies the 50bp NLV budget at a two-ATR stop distance', () => {
    expect(calculateAtrRiskCap({ atr14: 2, spot: 100, netLiquidationValue: 1_000_000 })).toMatchObject({
      available: true,
      stopDistance: 0.04,
      capWeight: 12.5,
      capNotional: 125000,
    });
  });

  test('lets ATR override beta max and blocks when the cap is below MIN', () => {
    const capped = calculateSizingDecision(baseInput({ atr14: 10 }));
    expect(capped).toMatchObject({ betaMaxWeight: 6, maxWeight: 2.5, riskBlocked: false });

    const blocked = calculateSizingDecision(baseInput({ atr14: 20, position: { exists: true, side: 'LONG', weight: 2 } }));
    expect(blocked).toMatchObject({ riskBlocked: true, lifecycleState: 'EXIT' });
    expect(blocked.research).toMatchObject({ action: 'EXIT', recommendedWeight: 0 });
  });
});

describe('range, structure, record, and conviction', () => {
  test('requires longs in the inclusive bottom half and shorts in the inclusive top half', () => {
    expect(calculateRangePosition({ spot: 100, lrr: 90, hrr: 110, bias: 'LONG' })).toMatchObject({
      position: 0.5, inRange: true, favorableHalf: true, favorableProximity: 0,
    });
    expect(calculateRangePosition({ spot: 100, lrr: 90, hrr: 110, bias: 'SHORT' })).toMatchObject({
      position: 0.5, inRange: true, favorableHalf: true, favorableProximity: 0,
    });
    expect(calculateRangePosition({ spot: 94, lrr: 90, hrr: 110, bias: 'LONG' }).favorableProximity).toBeCloseTo(0.6);
    expect(calculateRangePosition({ spot: 106, lrr: 90, hrr: 110, bias: 'SHORT' }).favorableProximity).toBeCloseTo(0.6);
    expect(calculateRangePosition({ spot: 111, lrr: 90, hrr: 110, bias: 'SHORT' })).toMatchObject({
      inRange: false, favorableHalf: false, favorableProximity: 0,
    });
    expect(calculateRangePosition({ spot: 105, lrr: 90, hrr: 110, bias: 'LONG' }).favorableProximity).toBe(0);
  });

  test('tracks HH/HL and LH/LL separately, caps at five, and resets ties or gaps', () => {
    const rising = Array.from({ length: 8 }, (_, index) => ({ hrr: 100 + index, lrr: 80 + index }));
    expect(calculateDirectionalStreaks(rising)).toMatchObject({ higherHigh: 5, higherLow: 5, lowerHigh: 0, lowerLow: 0 });

    expect(calculateDirectionalStreaks([{ hrr: 100, lrr: 80 }, { hrr: 100, lrr: 79 }])).toMatchObject({
      higherHigh: 0, lowerHigh: 0, lowerLow: 1,
    });
    expect(calculateDirectionalStreaks([{ hrr: 100, lrr: 80 }, { hrr: null, lrr: 81 }, { hrr: 102, lrr: 82 }])).toMatchObject({
      higherHigh: 0, higherLow: 2,
    });
    expect(calculateDirectionalStreaks([
      { date: '2026-07-13', hrr: 100, lrr: 80 },
      { date: '2026-07-15', hrr: 101, lrr: 81 },
    ])).toMatchObject({ higherHigh: 0, higherLow: 0 });
    expect(calculateDirectionalStreaks([
      { hrr: 100, lrr: 80 }, { missing: true }, { hrr: 102, lrr: 82 },
    ])).toMatchObject({ higherHigh: 0, higherLow: 0 });
  });

  test('uses strict prior ATH/ATL extensions and preserves unavailable records', () => {
    expect(calculateRecordSignal({ hrr: 101, priorAth: 100, lrr: 49, priorAtl: 50 })).toEqual({
      long: { available: true, extended: true },
      short: { available: true, extended: true },
    });
    expect(calculateRecordSignal({ hrr: 100, priorAth: 100 })).toMatchObject({
      long: { available: true, extended: false },
      short: { available: false, extended: null },
    });
    expect(calculateRecordSignal({ lrr: -41, priorAtl: -40 })).toMatchObject({
      short: { available: true, extended: true },
    });
  });

  test('weights proximity 20%, two streaks 30%, and record extension 50%', () => {
    const range = calculateRangePosition({ spot: 90, lrr: 90, hrr: 110, bias: 'LONG' });
    const streaks = calculateDirectionalStreaks([
      { hrr: 100, lrr: 80 }, { hrr: 101, lrr: 81 }, { hrr: 102, lrr: 82 },
      { hrr: 103, lrr: 83 }, { hrr: 104, lrr: 84 }, { hrr: 105, lrr: 85 },
    ]);
    const record = calculateRecordSignal({ hrr: 106, lrr: 85, priorAth: 105, priorAtl: 40 });
    expect(calculateConviction({ bias: 'LONG', range, streaks, record }).value).toBe(1);
    expect(calculateTargetWeight({ minWeight: 2, maxWeight: 6, conviction: 0.65 })).toBe(4.5);
  });

  test('missing optional strength inputs contribute zero without becoming negative', () => {
    const conviction = calculateConviction({
      bias: 'LONG',
      range: calculateRangePosition({ spot: 90, lrr: 90, hrr: 110, bias: 'LONG' }),
      streaks: calculateDirectionalStreaks([]),
      record: calculateRecordSignal({}),
    });
    expect(conviction.value).toBe(0.2);
    expect(conviction.components.structure.available).toEqual({ first: false, second: false });
    expect(conviction.components.record).toMatchObject({ available: false, active: null, score: 0 });
  });
});

describe('lifecycle and step decisions', () => {
  test.each([
    ['LONG', 'BULLISH', 'LONG', 'SHORT', 94],
    ['SHORT', 'BEARISH', 'SHORT', 'LONG', 106],
  ])('covers the complete %s lifecycle truth table', (side, trade, trend, opposite, spot) => {
    const common = { bias: side, tradeSignal: trade, trendSignal: trend, spot };

    expect(calculateSizingDecision(baseInput(common)).research).toMatchObject({
      lifecycleState: 'ACTIVE', action: 'OPEN', recommendedWeight: 2,
    });
    expect(calculateSizingDecision(baseInput({
      ...common,
      position: { exists: true, side, weight: 2 },
    })).research).toMatchObject({ lifecycleState: 'ACTIVE', action: 'HOLD' });
    expect(calculateSizingDecision(baseInput({
      ...common,
      trendSignal: opposite,
      position: { exists: true, side, weight: 4 },
    })).research).toMatchObject({
      lifecycleState: 'BENCH', action: 'REDUCE_TO_BENCH', recommendedWeight: 2,
    });
    expect(calculateSizingDecision(baseInput({
      ...common,
      tradeSignal: opposite,
      position: { exists: true, side, weight: 4 },
    })).research).toMatchObject({ lifecycleState: 'EXIT', action: 'EXIT', recommendedWeight: 0 });
    expect(calculateSizingDecision(baseInput({
      ...common,
      tradeSignal: 'NEUTRAL',
      trendSignal: 'NEUTRAL',
      position: { exists: true, side, weight: 4 },
    })).research).toMatchObject({ lifecycleState: 'EXIT', action: 'EXIT', recommendedWeight: 0 });
    expect(calculateSizingDecision(baseInput({
      ...common,
      trendSignal: opposite,
    })).research).toMatchObject({ lifecycleState: 'WATCH', action: 'WATCH', recommendedWeight: null });
  });

  test('opens a fully aligned new long at MIN in the favorable half', () => {
    const result = calculateSizingDecision(baseInput());
    expect(result).toMatchObject({ lifecycleState: 'ACTIVE', action: 'OPEN', minWeight: 2 });
    expect(result.research).toMatchObject({ action: 'OPEN', recommendedWeight: 2 });
    expect(result.actionable).toMatchObject({
      available: true,
      action: 'OPEN',
      recommendedWeight: 2,
      targetNotional: 20000,
      targetShares: 200,
      readOnly: true,
      orderTransmissionAllowed: false,
    });
  });

  test('keeps a candidate on WATCH in the wrong half or with only one signal', () => {
    const wrongHalf = calculateSizingDecision(baseInput({ spot: 105 }));
    expect(wrongHalf).toMatchObject({ lifecycleState: 'WATCH', action: null });
    expect(wrongHalf.research.reasons).toContain('WRONG_RANGE_HALF');

    const oneSignal = calculateSizingDecision(baseInput({ trendSignal: 'SHORT' }));
    expect(oneSignal).toMatchObject({ lifecycleState: 'WATCH', action: null });
    expect(oneSignal.research).toMatchObject({ referenceMinWeight: 2, recommendedWeight: null });
  });

  test('takes an existing position directly to BENCH or EXIT as signals deteriorate', () => {
    const bench = calculateSizingDecision(baseInput({
      trendSignal: 'SHORT', position: { exists: true, side: 'LONG', weight: 4 },
    }));
    expect(bench).toMatchObject({ lifecycleState: 'BENCH', action: 'REDUCE_TO_BENCH' });
    expect(bench.research.recommendedWeight).toBe(2);

    const exit = calculateSizingDecision(baseInput({
      tradeSignal: 'SHORT', trendSignal: 'SHORT', position: { exists: true, side: 'LONG', weight: 4 },
    }));
    expect(exit).toMatchObject({ lifecycleState: 'EXIT', action: 'EXIT' });
    expect(exit.research.reasons).toContain('REVERSAL_EXIT_FIRST');

    const explicitNeutralExit = calculateSizingDecision(baseInput({
      tradeSignal: 'SHORT', trendSignal: 'NEUTRAL', position: { exists: true, side: 'LONG', weight: 4 },
    }));
    expect(explicitNeutralExit.research).toMatchObject({ lifecycleState: 'EXIT', action: 'EXIT', recommendedWeight: 0 });
  });

  test('does not increase a below-MIN position after Trend breaks while Trade holds', () => {
    const result = calculateSizingDecision(baseInput({
      trendSignal: 'SHORT', position: { exists: true, side: 'LONG', weight: 1 },
    }));
    expect(result.research).toMatchObject({
      lifecycleState: 'BENCH', action: 'HOLD', recommendedWeight: 1, referenceMinWeight: 2,
    });
    expect(result.research.reasons).toEqual(expect.arrayContaining([
      'TREND_BREAK_TRADE_ALIGNED',
      'BELOW_MIN_NO_RISK_INCREASE',
    ]));
  });

  test('evaluates existing-position alignment against its actual side, not a conflicting requested bias', () => {
    const result = calculateSizingDecision(baseInput({
      bias: 'SHORT',
      tradeSignal: 'LONG',
      trendSignal: 'LONG',
      position: { exists: true, side: 'LONG', weight: 2 },
    }));
    expect(result).toMatchObject({ bias: 'LONG', alignedSignalCount: 2, lifecycleState: 'ACTIVE' });
    expect(result.research.action).toBe('HOLD');
  });

  test('treats a missing signal as unknown rather than as a verified break', () => {
    const existing = calculateSizingDecision(baseInput({
      trendSignal: null, position: { exists: true, side: 'LONG', weight: 4 },
    }));
    expect(existing.research).toMatchObject({
      lifecycleState: 'WATCH', action: 'WATCH', recommendedWeight: null,
    });
    expect(existing.actionable).toMatchObject({ available: false, action: null });
    expect(existing.actionable.blockers).toContain('SIGNAL_DATA_INCOMPLETE');

    const candidate = calculateSizingDecision(baseInput({ trendSignal: null }));
    expect(candidate.research).toMatchObject({
      lifecycleState: 'WATCH', referenceMinWeight: 2, recommendedWeight: null,
    });
    expect(candidate.action).toBeNull();
  });

  test('moves 50bp per new edition, or 100bp on a record/three-by-three structure', () => {
    const normal = calculateSizingDecision(baseInput({
      spot: 94,
      priorAth: 200,
      riskRangeHistory: [{ hrr: 109, lrr: 89 }, { hrr: 110, lrr: 90 }],
      position: { exists: true, side: 'LONG', weight: 2 },
      newRangeEdition: true,
    }));
    expect(normal.research).toMatchObject({ action: 'ADD', recommendedWeight: 2.5 });

    const accelerated = calculateSizingDecision(baseInput({
      position: { exists: true, side: 'LONG', weight: 2 }, newRangeEdition: true,
    }));
    expect(accelerated.research).toMatchObject({ action: 'ADD', recommendedWeight: 3 });

    const noEdition = calculateSizingDecision(baseInput({
      position: { exists: true, side: 'LONG', weight: 2 }, newRangeEdition: false,
    }));
    expect(noEdition.research).toMatchObject({ action: 'HOLD', recommendedWeight: 2 });
  });

  test('allows risk-reducing trims but blocks adds outside the favorable half', () => {
    const blockedAdd = calculateSizingDecision(baseInput({
      spot: 105,
      position: { exists: true, side: 'LONG', weight: 2 },
      newRangeEdition: true,
    }));
    expect(blockedAdd.research.action).toBe('HOLD');
    expect(blockedAdd.research.reasons).toContain('WRONG_RANGE_HALF');

    const trim = calculateSizingDecision(baseInput({
      spot: 105,
      priorAth: 200,
      riskRangeHistory: [{ hrr: 111, lrr: 91 }, { hrr: 110, lrr: 90 }],
      position: { exists: true, side: 'LONG', weight: 5 },
      newRangeEdition: true,
    }));
    expect(trim.research.action).toBe('TRIM');
    expect(trim.research.recommendedWeight).toBeLessThan(5);
  });

  test('rounds a non-boundary ATR cap down for operational trims', () => {
    const atrForTwoPointThreePctCap = 25 / 2.3;
    const result = calculateSizingDecision(baseInput({
      atr14: atrForTwoPointThreePctCap,
      position: { exists: true, side: 'LONG', weight: 2.5 },
    }));
    expect(result.maxWeight).toBeCloseTo(2.3);
    expect(result.operationalMaxWeight).toBe(2);
    expect(result.research).toMatchObject({ action: 'TRIM', recommendedWeight: 2 });
    expect(result.research.recommendedWeight % 0.5).toBe(0);
    expect(result.research.recommendedWeight).toBeLessThanOrEqual(result.maxWeight);
  });

  test('returns signed short notional and share targets while keeping weights positive', () => {
    const result = calculateSizingDecision(baseInput({
      bias: 'SHORT', tradeSignal: 'BEAR', trendSignal: 'SHORT', spot: 100,
      lrr: 90, hrr: 110, priorAtl: 95, priorAth: 150,
      riskRangeHistory: [{ hrr: 115, lrr: 95 }, { hrr: 110, lrr: 90 }],
    }));
    expect(result.minWeight).toBe(2);
    expect(result.actionable).toMatchObject({ signedWeight: -2, targetNotional: -20000, targetShares: -200 });
  });
});

describe('live-data fail closed behavior', () => {
  test('accepts only a connected, fresh IBKR quote and verified account summary', () => {
    expect(validateLiveContext({
      liveContext: liveContext(), spot: 100, netLiquidationValue: 100000, now: NOW,
    }).available).toBe(true);
    expect(validateLiveContext({
      liveContext: liveContext({ quote: { asOf: '2026-07-17T18:58:59.000Z' } }),
      spot: 100, netLiquidationValue: 100000, now: NOW,
    }).blockers).toContain('QUOTE_STALE');
  });

  test('requires dated research provenance before enabling an executable result', () => {
    expect(validateResearchProvenance(baseInput())).toEqual({ available: true, blockers: [] });

    const missing = calculateSizingDecision(baseInput({ provenance: null }));
    expect(missing.research).toMatchObject({ action: 'OPEN', recommendedWeight: 2 });
    expect(missing.actionable).toMatchObject({ available: false, action: null, targetShares: null });
    expect(missing.actionable.blockers).toEqual(expect.arrayContaining([
      'TRADE_PROVENANCE_UNAVAILABLE',
      'TREND_PROVENANCE_UNAVAILABLE',
      'RANGE_PROVENANCE_UNAVAILABLE',
      'RECORDS_PROVENANCE_UNAVAILABLE',
    ]));

    const bareMetrics = calculateSizingDecision(baseInput({ beta: 1, atr14: 2 }));
    expect(bareMetrics.research).toMatchObject({ action: 'OPEN', recommendedWeight: 2 });
    expect(bareMetrics.actionable.blockers).toEqual(expect.arrayContaining([
      'BETA_PROVENANCE_UNAVAILABLE',
      'ATR_PROVENANCE_UNAVAILABLE',
    ]));
  });

  test('requires verified supported instrument metadata and applies multiplier and lot size', () => {
    expect(validateInstrumentContext(baseInput().instrument)).toMatchObject({
      available: true,
      securityType: 'STK',
      currency: 'USD',
      multiplier: 1,
      lotSize: 1,
    });

    const missing = calculateSizingDecision(baseInput({ instrument: null }));
    expect(missing.research.action).toBe('OPEN');
    expect(missing.actionable).toMatchObject({ available: false, action: null, targetShares: null });
    expect(missing.actionable.blockers).toContain('INSTRUMENT_NOT_VERIFIED_IBKR');

    const unsupported = calculateSizingDecision(baseInput({
      instrument: {
        source: 'ibkr', verified: true, tradable: true, securityType: 'FUT',
        currency: 'USD', multiplier: 50, lotSize: 1,
      },
    }));
    expect(unsupported.actionable.blockers).toContain('UNSUPPORTED_INSTRUMENT');

    const lotSized = calculateSizingDecision(baseInput({
      instrument: {
        source: 'ibkr', verified: true, tradable: true, securityType: 'STK',
        currency: 'USD', multiplier: 10, lotSize: 5,
      },
    }));
    expect(lotSized.actionable).toMatchObject({ available: true, targetNotional: 20000, targetShares: 20 });
  });

  test.each([
    ['offline', { connected: false }],
    ['delayed', { quoteMode: 'delayed' }],
    ['stale', { stale: true }],
    ['cache', { cacheOnly: true }],
    ['mock', { warning: 'mock quote' }],
    ['seed', { seeded: true }],
    ['fallback', { dataSource: 'fallback' }],
    ['inferred', { quote: { warning: 'inferred quote' } }],
  ])('suppresses the actionable %s recommendation but preserves research', (_label, override) => {
    const result = calculateSizingDecision(baseInput({ liveContext: liveContext(override) }));
    expect(result.research).toMatchObject({ action: 'OPEN', recommendedWeight: 2 });
    expect(result).toMatchObject({ action: null });
    expect(result.actionable).toMatchObject({
      available: false,
      action: null,
      recommendedWeight: null,
      targetNotional: null,
      targetShares: null,
    });
    expect(result.actionable.blockers.length).toBeGreaterThan(0);
  });

  test('rejects zero NLV and non-IBKR sources', () => {
    const noNlv = calculateSizingDecision(baseInput({ netLiquidationValue: 0 }));
    expect(noNlv.actionable.blockers).toContain('NLV_UNAVAILABLE');
    const yahoo = calculateSizingDecision(baseInput({ liveContext: liveContext({ quote: { source: 'yahoo' } }) }));
    expect(yahoo.actionable.blockers).toContain('QUOTE_NOT_IBKR');
  });

  test('requires fresh verified IBKR account-summary provenance bound to the calculation NLV', () => {
    const missing = calculateSizingDecision(baseInput({
      liveContext: liveContext({ accountSummary: { source: '', verified: false, netLiquidationValue: null } }),
    }));
    expect(missing.actionable.blockers).toEqual(expect.arrayContaining([
      'NLV_UNAVAILABLE',
      'NLV_NOT_VERIFIED_IBKR',
    ]));

    const stale = calculateSizingDecision(baseInput({
      liveContext: liveContext({ accountSummary: { asOf: '2026-07-17T18:58:59.000Z', netLiquidationValue: 1_000_000 } }),
    }));
    expect(stale.actionable.blockers).toContain('NLV_STALE');

    const mismatch = calculateSizingDecision(baseInput({
      liveContext: liveContext({ accountSummary: { netLiquidationValue: 999_000 } }),
    }));
    expect(mismatch.actionable.blockers).toContain('LIVE_NLV_MISMATCH');
  });

  test('requires an explicit evaluation time so validation remains deterministic', () => {
    const result = calculateSizingDecision(baseInput({ now: null }));
    expect(result.actionable.blockers).toEqual(expect.arrayContaining([
      'VALIDATION_TIME_UNAVAILABLE',
      'QUOTE_STALE',
      'NLV_STALE',
    ]));
  });

  test('keeps a beta-only research band but blocks action when ATR is missing', () => {
    const result = calculateSizingDecision(baseInput({ atr14: null }));
    expect(result).toMatchObject({ minWeight: 2, betaMaxWeight: 6, maxWeight: 6 });
    expect(result.research).toMatchObject({ action: 'OPEN', recommendedWeight: 2 });
    expect(result.actionable).toMatchObject({ available: false, action: null });
    expect(result.actionable.blockers).toContain('ATR_RISK_CAP_UNAVAILABLE');
  });

  test('supports epoch-second quote timestamps and rejects delayed dataType variants', () => {
    const epochSeconds = Date.parse('2026-07-17T18:59:30.000Z') / 1000;
    expect(validateLiveContext({
      liveContext: liveContext({ quote: { asOf: epochSeconds } }),
      spot: 100,
      netLiquidationValue: 100000,
      now: NOW,
    })).toMatchObject({ available: true, quoteAgeSeconds: 30 });

    for (const dataType of ['delayed', 'delayed_frozen']) {
      expect(validateLiveContext({
        liveContext: liveContext({ quote: { dataType } }),
        spot: 100,
        netLiquidationValue: 100000,
        now: NOW,
      })).toMatchObject({ available: false, blockers: ['UNVERIFIED_LIVE_DATA'] });
    }
  });

  test('requires an explicit live dataType and honors nested quote source metadata first', () => {
    for (const dataType of [undefined, 'frozen', 'unknown', 2]) {
      expect(validateLiveContext({
        liveContext: liveContext({ quote: { dataType } }),
        spot: 100,
        netLiquidationValue: 100000,
        now: NOW,
      }).available).toBe(false);
    }

    expect(validateLiveContext({
      liveContext: liveContext({
        provider: 'yahoo',
        quote: { source: 'ibkr', dataType: 1, price: 100 },
      }),
      spot: 100,
      netLiquidationValue: 100000,
      now: NOW,
    })).toMatchObject({ available: true, provider: 'ibkr' });

    expect(validateLiveContext({
      liveContext: liveContext({
        provider: 'ibkr',
        quote: { source: 'yahoo', dataType: 'live', price: 100 },
      }),
      spot: 100,
      netLiquidationValue: 100000,
      now: NOW,
    }).blockers).toContain('QUOTE_NOT_IBKR');
  });

  test('blocks action when the calculation spot conflicts with a supplied live quote', () => {
    const result = calculateSizingDecision(baseInput({
      liveContext: liveContext({ quote: { source: 'ibkr', dataType: 1, price: 101 } }),
    }));
    expect(result.research.action).toBe('OPEN');
    expect(result.actionable).toMatchObject({ available: false, action: null });
    expect(result.actionable.blockers).toContain('LIVE_SPOT_MISMATCH');
  });

  test('preserves metric and supplied provenance', () => {
    const result = calculateSizingDecision(baseInput({
      provenance: { range: { source: 'hedgeye', asOf: '2026-07-17' } },
    }));
    expect(result.provenance.beta).toMatchObject({ source: 'adjusted-daily', asOf: '2026-07-16', observations: 252 });
    expect(result.provenance.range).toEqual({ source: 'hedgeye', asOf: '2026-07-17' });
    expect(result.provenance.nlv).toMatchObject({ source: 'ibkr', asOf: '2026-07-17T18:59:30.000Z', ageSeconds: 30 });
  });
});
