import {
  ATR_FLOOR,
  SIZING_CONSTANTS,
  calculateConviction,
  calculateDirectionalStreaks,
  calculateRangePosition,
  calculateRecordSignal,
  calculateSizingBand,
  calculateSizingDecision,
  calculateStopPrice,
  calculateTargetWeight,
  stopLossPctNlv,
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

describe('ATR sizing bands (weights are percentage points)', () => {
  test.each([
    // atr14, spot, MIN, MAX, floorApplied
    [2, 100, 3.25, 6.25, false],
    [20, 1000, 3.25, 6.25, false],
    [3, 100, 2.25, 4, false],
    [6.6, 100, 1, 1.75, false],
    [1, 100, 5, 10, true],
    [0.5, 100, 5, 10, true],
  ])('sizes ATR %p on spot %p to MIN %p / MAX %p', (atr14, spot, min, max, floorApplied) => {
    expect(calculateSizingBand({ atr14, spot })).toMatchObject({
      available: true,
      minWeight: min,
      maxWeight: max,
      floorApplied,
      riskBlocked: false,
      unit: 'percentage-points',
    });
  });

  test('sets MIN and MAX so a two-ATR stop costs 12.5bp and 25bp of NLV before 0.25 rounding', () => {
    expect(SIZING_CONSTANTS).toMatchObject({
      STOP_ATR_MULTIPLE: 2, MIN_STOP_LOSS_PCT_NLV: 0.125, MAX_STOP_LOSS_PCT_NLV: 0.25,
      MAX_POSITION_WEIGHT: 10, WEIGHT_INCREMENT: 0.25,
    });
    expect(ATR_FLOOR).toBeCloseTo(0.0125);
    const band = calculateSizingBand({ atr14: { value: 3, observations: 14 }, spot: 100 });
    expect(band.relativeAtr).toBeCloseTo(0.03);
    expect(band.stopDistance).toBeCloseTo(0.06);
    expect(band.rawMinWeight).toBeCloseTo(2.0833, 4);
    expect(band.rawMaxWeight).toBeCloseTo(4.1667, 4);
    expect(band).toMatchObject({ minWeight: 2.25, maxWeight: 4 });
    expect(band.minWeight % 0.25).toBe(0);
    expect(band.maxWeight % 0.25).toBe(0);
  });

  test('the ATR floor caps MAX at 10% while the stop keeps the measured ATR', () => {
    const band = calculateSizingBand({ atr14: 0.5, spot: 100 });
    expect(band.relativeAtr).toBeCloseTo(0.005);
    expect(band.effectiveRelativeAtr).toBeCloseTo(0.0125);
    expect(band.stopDistance).toBeCloseTo(0.01);
    expect(band).toMatchObject({ floorApplied: true, minWeight: 5, maxWeight: 10 });
  });

  test('blocks sizing only when MAX rounds below MIN at an extreme ATR', () => {
    expect(calculateSizingBand({ atr14: 50, spot: 100 })).toMatchObject({ minWeight: 0.25, maxWeight: 0.25, riskBlocked: false });
    expect(calculateSizingBand({ atr14: 60, spot: 100 })).toMatchObject({ minWeight: 0.25, maxWeight: 0, riskBlocked: true });
  });

  test('requires a positive ATR and spot, and no beta', () => {
    expect(calculateSizingBand({ atr14: null, spot: 100 })).toMatchObject({ available: false, reason: 'ATR_UNAVAILABLE', minWeight: null, maxWeight: null });
    expect(calculateSizingBand({ atr14: 0, spot: 100 }).reason).toBe('ATR_UNAVAILABLE');
    expect(calculateSizingBand({ atr14: 2, spot: null })).toMatchObject({ available: false, reason: 'SPOT_UNAVAILABLE' });
    expect(calculateSizingBand({ atr14: 2, spot: -1 }).reason).toBe('SPOT_UNAVAILABLE');
    expect(calculateSizingBand({ atr14: 2, spot: 100, beta: null }).available).toBe(true);
  });

  test('places the stop two ATRs against the side and prices the stop-out in NLV points', () => {
    expect(calculateStopPrice({ basis: 100, atr14: 2, side: 'LONG' })).toBe(96);
    expect(calculateStopPrice({ basis: 100, atr14: { value: 2 }, side: 'BEARISH' })).toBe(104);
    expect(calculateStopPrice({ basis: 100, atr14: 2, side: null })).toBeNull();
    expect(calculateStopPrice({ basis: 100, atr14: null, side: 'LONG' })).toBeNull();
    expect(calculateStopPrice({ basis: 10, atr14: 6, side: 'LONG' })).toBeNull();
    expect(stopLossPctNlv(3.25, 0.04)).toBeCloseTo(0.13);
    expect(stopLossPctNlv(-6.25, 0.04)).toBeCloseTo(0.25);
    expect(stopLossPctNlv(null, 0.04)).toBeNull();
  });

  test('reports the decision stop for longs and shorts', () => {
    const long = calculateSizingDecision(baseInput());
    expect(long).toMatchObject({ minWeight: 3.25, maxWeight: 6.25, riskBlocked: false });
    expect(long.stop).toMatchObject({ atrMultiple: 2, price: 96, unit: 'percentage-points' });
    expect(long.stop.distance).toBeCloseTo(0.04);
    expect(long.stop.lossAtMinPctNlv).toBeCloseTo(0.13);
    expect(long.stop.lossAtMaxPctNlv).toBeCloseTo(0.25);
    expect(long).not.toHaveProperty('effectiveBeta');
    expect(long).not.toHaveProperty('atrRiskCap');

    const short = calculateSizingDecision(baseInput({ bias: 'SHORT', tradeSignal: 'BEAR', trendSignal: 'SHORT' }));
    expect(short.stop.price).toBe(104);
  });

  test('an extreme ATR exits a held position and keeps a candidate on WATCH', () => {
    const held = calculateSizingDecision(baseInput({ atr14: 60, position: { exists: true, side: 'LONG', weight: 2 } }));
    expect(held).toMatchObject({ riskBlocked: true, lifecycleState: 'EXIT', targetWeight: null });
    expect(held.research).toMatchObject({ action: 'EXIT', recommendedWeight: 0 });
    expect(held.research.reasons).toContain('VOLATILITY_TOO_HIGH_TO_SIZE');
    expect(held.stop.price).toBeNull();

    const candidate = calculateSizingDecision(baseInput({ atr14: 60 }));
    expect(candidate.research).toMatchObject({ lifecycleState: 'WATCH', action: 'WATCH', recommendedWeight: null });
    expect(candidate.actionable).toMatchObject({ available: false, action: null });
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
    // ATR 2 / spot 94 → MIN 3; ATR 2 / spot 106 → MIN 3.5.
    ['LONG', 'BULLISH', 'LONG', 'SHORT', 94, 3],
    ['SHORT', 'BEARISH', 'SHORT', 'LONG', 106, 3.5],
  ])('covers the complete %s lifecycle truth table', (side, trade, trend, opposite, spot, min) => {
    const common = { bias: side, tradeSignal: trade, trendSignal: trend, spot };

    expect(calculateSizingDecision(baseInput(common)).research).toMatchObject({
      lifecycleState: 'ACTIVE', action: 'OPEN', recommendedWeight: min,
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
      lifecycleState: 'BENCH', action: 'REDUCE_TO_BENCH', recommendedWeight: min,
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
    expect(result).toMatchObject({ lifecycleState: 'ACTIVE', action: 'OPEN', minWeight: 3.25 });
    expect(result.research).toMatchObject({ action: 'OPEN', recommendedWeight: 3.25 });
    expect(result.actionable).toMatchObject({
      available: true,
      action: 'OPEN',
      recommendedWeight: 3.25,
      targetNotional: 32500,
      targetShares: 325,
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
    expect(oneSignal.research).toMatchObject({ referenceMinWeight: 3.25, recommendedWeight: null });
  });

  test('takes an existing position directly to BENCH or EXIT as signals deteriorate', () => {
    const bench = calculateSizingDecision(baseInput({
      trendSignal: 'SHORT', position: { exists: true, side: 'LONG', weight: 4 },
    }));
    expect(bench).toMatchObject({ lifecycleState: 'BENCH', action: 'REDUCE_TO_BENCH' });
    expect(bench.research.recommendedWeight).toBe(3.25);

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
      lifecycleState: 'BENCH', action: 'HOLD', recommendedWeight: 1, referenceMinWeight: 3.25,
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
      lifecycleState: 'WATCH', referenceMinWeight: 3.25, recommendedWeight: null,
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

  test('rounds a non-boundary ATR MAX down to 0.25 for operational trims', () => {
    // ATR 3 / spot 100: raw MAX 0.25 / 0.06 = 4.17 → 4; raw MIN 2.08 → 2.25.
    const result = calculateSizingDecision(baseInput({
      atr14: 3,
      position: { exists: true, side: 'LONG', weight: 4.5 },
    }));
    expect(result.rawMaxWeight).toBeCloseTo(4.1667, 4);
    expect(result).toMatchObject({ minWeight: 2.25, maxWeight: 4, operationalMaxWeight: 4 });
    expect(result.research).toMatchObject({ action: 'TRIM', recommendedWeight: 4 });
    expect(result.research.reasons).toContain('ABOVE_EFFECTIVE_MAX');
    expect(result.research.recommendedWeight % 0.25).toBe(0);
    expect(result.research.recommendedWeight).toBeLessThanOrEqual(result.rawMaxWeight);
  });

  test('returns signed short notional and share targets while keeping weights positive', () => {
    const result = calculateSizingDecision(baseInput({
      bias: 'SHORT', tradeSignal: 'BEAR', trendSignal: 'SHORT', spot: 100,
      lrr: 90, hrr: 110, priorAtl: 95, priorAth: 150,
      riskRangeHistory: [{ hrr: 115, lrr: 95 }, { hrr: 110, lrr: 90 }],
    }));
    expect(result.minWeight).toBe(3.25);
    expect(result.actionable).toMatchObject({ signedWeight: -3.25, targetNotional: -32500, targetShares: -325 });
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
    expect(missing.research).toMatchObject({ action: 'OPEN', recommendedWeight: 3.25 });
    expect(missing.actionable).toMatchObject({ available: false, action: null, targetShares: null });
    expect(missing.actionable.blockers).toEqual(expect.arrayContaining([
      'TRADE_PROVENANCE_UNAVAILABLE',
      'TREND_PROVENANCE_UNAVAILABLE',
      'RANGE_PROVENANCE_UNAVAILABLE',
      'RECORDS_PROVENANCE_UNAVAILABLE',
    ]));

    const bareMetrics = calculateSizingDecision(baseInput({ atr14: 2 }));
    expect(bareMetrics.research).toMatchObject({ action: 'OPEN', recommendedWeight: 3.25 });
    expect(bareMetrics.actionable.blockers).toContain('ATR_PROVENANCE_UNAVAILABLE');
    expect(bareMetrics.actionable.blockers.some(blocker => blocker.startsWith('BETA_'))).toBe(false);

    const fewSessions = calculateSizingDecision(baseInput({
      atr14: { value: 2, observations: 13, source: 'completed-daily-bars', asOf: '2026-07-16' },
    }));
    expect(fewSessions.actionable.blockers).toContain('ATR_OBSERVATIONS_UNAVAILABLE');
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
    expect(lotSized.actionable).toMatchObject({ available: true, targetNotional: 32500, targetShares: 30 });
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
    expect(result.research).toMatchObject({ action: 'OPEN', recommendedWeight: 3.25 });
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

  test('has no band, research size, or action when ATR is missing', () => {
    const result = calculateSizingDecision(baseInput({ atr14: null }));
    expect(result).toMatchObject({ minWeight: null, maxWeight: null, riskBlocked: false, targetWeight: null });
    expect(result.stop).toMatchObject({ price: null, distance: null, lossAtMinPctNlv: null });
    expect(result.research).toMatchObject({ lifecycleState: 'WATCH', action: 'WATCH', recommendedWeight: null });
    expect(result.research.reasons).toContain('ATR_UNAVAILABLE');
    expect(result.actionable).toMatchObject({ available: false, action: null });
    expect(result.actionable.blockers).toContain('ATR_SIZING_UNAVAILABLE');
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
    expect(result.provenance.atr).toMatchObject({ source: 'completed-daily-bars', asOf: '2026-07-16', observations: 14 });
    expect(result.provenance).not.toHaveProperty('beta');
    expect(result.provenance.range).toEqual({ source: 'hedgeye', asOf: '2026-07-17' });
    expect(result.provenance.nlv).toMatchObject({ source: 'ibkr', asOf: '2026-07-17T18:59:30.000Z', ageSeconds: 30 });
  });
});
