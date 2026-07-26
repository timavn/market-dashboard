const {
  calculateIbkrCashBorrowing,
  calculateIbkrCashBorrowingReference,
  projectIbkrCashBorrowingScenario,
} = require('./ibkrCashBorrowing');

function fundingPayload(overrides = {}) {
  const payload = {
    currency: 'USD',
    baseCurrency: 'USD',
    positionScope: 'stocks_only',
    netLiquidation: 195000,
    totalCashValueSecurities: 115000,
    totalCashValueCommodities: 0,
    commodityMaintenanceMargin: 0,
    grossPositionValue: 295000,
    stockMarketValue: 95000,
    accruedCashSecurities: 0,
    settledCashByDateSecurities: {
      20260723: 115000,
      20260724: 114000,
    },
    settledCashByDateCommodities: {
      20260723: 0,
      20260724: 0,
    },
    shortPositions: [
      {
        conId: 756733,
        symbol: 'MACRO',
        quantity: -1000,
        priorClose: 100,
        currentPrice: 100,
        directBid: 100,
        directAsk: 100,
        directLast: 100,
        currentPriceSource: 'ibkr_ticker_direct_max',
        priorCloseSource: 'ibkr_live_tick_close',
        currency: 'USD',
      },
    ],
    accountReady: true,
    settledShortPositionsVerified: true,
    settlementStatus: 'settled',
    noSameDayExecutionsVerified: true,
    sameDayExecutionCount: 0,
    openOrderCount: 0,
    ...overrides,
  };

  return {
    ...payload,
    shortPositions: Array.isArray(payload.shortPositions)
      ? payload.shortPositions.map((position) => ({
        directBid: position.currentPrice,
        directAsk: position.currentPrice,
        directLast: position.currentPrice,
        currentPriceSource: 'ibkr_ticker_direct_max',
        priorCloseSource: 'ibkr_live_tick_close',
        ...position,
      }))
      : payload.shortPositions,
  };
}

function fundingReferencePayload(overrides = {}) {
  const observedAt = new Date().toISOString();
  const payload = {
    schemaVersion: 1,
    referenceOnly: true,
    actionable: false,
    referenceKind:
      'completed_market_session_with_current_settlement_ladder',
    accountId: 'U1',
    status: 'reference',
    source: 'ibkr_completed_session_reference',
    fromCache: false,
    observedAt,
    socketVerifiedAt: observedAt,
    accountValuesObservedAt: observedAt,
    referenceSessionDate: '2026-07-24',
    cashLedgerObservedDate: '2026-07-25',
    settlementHorizonDate: '2026-07-27',
    settlementVerification: 'reference_segment_ladders_double_snapshot',
    currency: 'USD',
    baseCurrency: 'USD',
    positionScope: 'stocks_only',
    netLiquidation: 195000,
    totalCashValueSecurities: 114000,
    totalCashValueCommodities: 0,
    commodityMaintenanceMargin: 0,
    grossPositionValue: 295000,
    stockMarketValue: 95000,
    accruedCashSecurities: 0,
    settledCashByDateSecurities:
      '20260725:115000;20260727:114000',
    settledCashByDateCommodities: '20260725:0;20260727:0',
    shortPositionReferences: [{
      conId: 756733,
      symbol: 'MACRO',
      quantity: -1000,
      referenceClose: 100,
      referenceCloseSource: 'ibkr_historical_daily_close',
      referenceCloseSessionDate: '2026-07-24',
      referenceCloseObservedAt: observedAt,
      currency: 'USD',
    }],
    shortStockReferenceCloseValue: 100000,
    accountReady: true,
    openPositionCount: 2,
    shortPositionCount: 1,
    openOrderCount: 0,
    executionCountObserved: 0,
    ...overrides,
  };
  return payload;
}

describe('calculateIbkrCashBorrowing', () => {
  test('calculates representative USD stock-only cash debit headroom', () => {
    const result = calculateIbkrCashBorrowing(fundingPayload());

    expect(result.available).toBe(true);
    expect(result.longMV).toBe(195000);
    expect(result.shortMV).toBe(100000);
    expect(result.grossMV).toBe(295000);
    expect(result.netMV).toBe(95000);
    expect(result.securitiesCashFloor).toBe(114000);
    expect(result.worstSettlementDate).toBe('20260724');
    expect(result.worstSettlementBalance).toBe(114000);
    expect(result.commodityResidual).toBe(0);
    expect(result.adjustmentForSecuritiesDeficit).toBe(0);
    expect(result.eligibleProjectedCash).toBe(114000);
    expect(result.collateral).toBe(102000);
    expect(result.brokerAdjustedCash).toBe(12000);
    expect(result.adjustedCashSecurities).toBe(12000);
    expect(result.rawHeadroom).toBe(12000);
    expect(result.policyBuffer).toEqual(
      expect.objectContaining({
        base: 2000,
        shortShock: 6000,
        total: 8000,
      }),
    );
    expect(result.guardedHeadroom).toBe(4000);
    expect(result.addLongAllowed).toBe(4000);
    expect(result.longTrimNeeded).toBe(0);
  });

  test('reports the long trim needed when settled cash is already in debit', () => {
    const result = calculateIbkrCashBorrowing(
      fundingPayload({
        totalCashValueSecurities: 99000,
        settledCashByDateSecurities: '20260723:99000;20260724:98000',
      }),
    );

    expect(result.available).toBe(true);
    expect(result.rawHeadroom).toBe(-4000);
    expect(result.guardedHeadroom).toBe(-12000);
    expect(result.addLongAllowed).toBe(0);
    expect(result.longTrimNeeded).toBe(12000);
  });

  test('does not add positive commodity residual to positive securities cash', () => {
    const result = calculateIbkrCashBorrowing(
      fundingPayload({
        netLiquidation: 195000,
        totalCashValueSecurities: 66701.99,
        totalCashValueCommodities: 22959.27,
        commodityMaintenanceMargin: 0,
        grossPositionValue: 278629.664,
        stockMarketValue: 111370.336,
        accruedCashSecurities: -313.16,
        settledCashByDateSecurities: {
          20260723: 76701.99,
          20260724: 66701.99,
        },
        settledCashByDateCommodities: {
          20260724: 22959.27,
        },
        shortPositions: [
          {
            quantity: -2459.696,
            priorClose: 34,
            currentPrice: 34,
            currency: 'USD',
          },
        ],
      }),
    );

    expect(result.available).toBe(true);
    expect(result.worstSettlementDate).toBe('20260724');
    expect(result.commodityResidual).toBeCloseTo(22959.27, 8);
    expect(result.adjustmentForSecuritiesDeficit).toBe(0);
    expect(result.commodityCashExcluded).toBeCloseTo(22959.27, 8);
    expect(result.collateral).toBeCloseTo(86089.36, 8);
    expect(result.brokerAdjustedCash).toBeCloseTo(-19387.37, 8);
    expect(result.adjustedCashSecurities).toBeCloseTo(-19387.37, 8);
    expect(result.negativeAccruedCashReserve).toBeCloseTo(313.16, 8);
    expect(result.rawHeadroom).toBeCloseTo(-19700.53, 8);
    expect(result.policyBuffer.shortShock).toBeCloseTo(4919.392, 8);
    expect(result.guardedHeadroom).toBeCloseTo(-26619.922, 8);
    expect(result.longTrimNeeded).toBeCloseTo(26619.922, 8);
  });

  test('uses commodity residual only to offset an actual securities deficit', () => {
    const result = calculateIbkrCashBorrowing(
      fundingPayload({
        totalCashValueSecurities: -10000,
        totalCashValueCommodities: 25000,
        commodityMaintenanceMargin: 5000,
        grossPositionValue: 195000,
        stockMarketValue: 195000,
        settledCashByDateSecurities: {
          20260723: -9000,
          20260724: -10000,
        },
        settledCashByDateCommodities: {
          20260724: 25000,
        },
        shortPositions: [],
      }),
    );

    expect(result.securitiesCashDeficit).toBe(10000);
    expect(result.commodityResidual).toBe(20000);
    expect(result.adjustmentForSecuritiesDeficit).toBe(10000);
    expect(result.commodityResidualAfterAdjustment).toBe(10000);
    expect(result.eligibleProjectedCash).toBe(0);
    expect(result.brokerAdjustedCash).toBe(0);
    expect(result.rawHeadroom).toBe(0);
    expect(result.guardedHeadroom).toBe(-2000);
    expect(result.requiredSecuritiesCashForGuard).toBe(2000);
    expect(result.longTrimNeeded).toBe(12000);
  });

  test('uses settled rather than trade-date commodity cash', () => {
    const result = calculateIbkrCashBorrowing(
      fundingPayload({
        totalCashValueSecurities: -5000,
        settledCashByDateSecurities: {
          20260724: -5000,
        },
        totalCashValueCommodities: 10000,
        settledCashByDateCommodities: {
          20260724: -2000,
        },
        commodityMaintenanceMargin: 1000,
        grossPositionValue: 195000,
        stockMarketValue: 195000,
        shortPositions: [],
      }),
    );

    expect(result.available).toBe(true);
    expect(result.commodityCashFloor).toBe(-2000);
    expect(result.commodityResidual).toBe(-3000);
    expect(result.adjustmentForSecuritiesDeficit).toBe(-3000);
  });

  test('fails closed without settled commodity cash evidence', () => {
    const result = calculateIbkrCashBorrowing(
      fundingPayload({
        settledCashByDateCommodities: null,
      }),
    );

    expect(result.available).toBe(false);
    expect(result.reasons).toContain('invalid_commodity_settled_cash_by_date');
  });

  test('supports a user-selected short shock at or above the 5% floor', () => {
    const defaultResult = calculateIbkrCashBorrowing(fundingPayload());
    const stressedResult = calculateIbkrCashBorrowing(
      fundingPayload({
        policyShortAdverseMoveRate: 0.2,
      }),
    );

    expect(defaultResult.policyBuffer.shortAdverseMoveRate).toBe(0.05);
    expect(stressedResult.policyBuffer.shortAdverseMoveRate).toBe(0.2);
    expect(stressedResult.policyBuffer.shortShock)
      .toBeGreaterThan(defaultResult.policyBuffer.shortShock);
    expect(stressedResult.guardedHeadroom)
      .toBeLessThan(defaultResult.guardedHeadroom);
  });

  test.each([0, 0.049, 2.01, 'not-a-number'])(
    'rejects unsafe or invalid policy short shock %p',
    (policyShortAdverseMoveRate) => {
      const result = calculateIbkrCashBorrowing(
        fundingPayload({ policyShortAdverseMoveRate }),
      );

      expect(result.available).toBe(false);
      expect(result.reasons).toContain(
        'invalid_policy_short_adverse_move_rate',
      );
    },
  );

  test('uses IBKR per-share ceiling for low-priced short collateral', () => {
    const result = calculateIbkrCashBorrowing(
      fundingPayload({
        grossPositionValue: 196010,
        stockMarketValue: 193990,
        shortPositions: [
          {
            quantity: -1000,
            priorClose: 1.01,
            currentPrice: 1.01,
            currency: 'USD',
          },
        ],
      }),
    );

    expect(result.collateralBreakdown.positions[0]).toEqual(
      expect.objectContaining({
        roundedCollateralPrice: 2,
        stressedRoundedPrice: 2,
        collateral: 2000,
        stressDelta: 0,
      }),
    );
    expect(result.collateral).toBe(2000);
  });

  test('uses the higher of prior close and current price for short stress', () => {
    const result = calculateIbkrCashBorrowing(
      fundingPayload({
        grossPositionValue: 196100,
        stockMarketValue: 193900,
        shortPositions: [
          {
            quantity: -10,
            priorClose: 100,
            currentPrice: 110,
            currency: 'USD',
          },
        ],
      }),
    );

    expect(result.collateralBreakdown.positions[0]).toEqual(
      expect.objectContaining({
        stressReferencePrice: 110,
        roundedCollateralPrice: 102,
        stressedRoundedPrice: 118,
        stressDelta: 160,
      }),
    );
    expect(result.policyBuffer.shortShock).toBe(160);
  });

  test('uses the lowest settlement-date balance, not just TotalCashValue-S', () => {
    const result = calculateIbkrCashBorrowing(
      fundingPayload({
        totalCashValueSecurities: 130000,
        settledCashByDateSecurities: {
          20260723: 128000,
          20260724: 106000,
          20260727: 110000,
        },
      }),
    );

    expect(result.securitiesCashFloor).toBe(106000);
    expect(result.rawHeadroom).toBe(4000);
  });

  test('reserves negative accrued securities cash', () => {
    const result = calculateIbkrCashBorrowing(
      fundingPayload({
        accruedCashSecurities: -750,
      }),
    );

    expect(result.negativeAccruedCashReserve).toBe(750);
    expect(result.rawHeadroom).toBe(11250);
    expect(result.guardedHeadroom).toBe(3250);
  });

  test('fails closed when there are open orders', () => {
    const result = calculateIbkrCashBorrowing(
      fundingPayload({ openOrderCount: 1 }),
    );

    expect(result.available).toBe(false);
    expect(result.reasons).toContain('open_orders_present');
    expect(result.addLongAllowed).toBeNull();
    expect(result.longTrimNeeded).toBeNull();
  });

  test.each([
    ['non-USD account', { baseCurrency: 'EUR' }, 'unsupported_currency'],
    [
      'missing settlement verification',
      { settledShortPositionsVerified: undefined },
      'settlement_unverified',
    ],
    [
      'unsettled securities activity',
      { settlementStatus: 'pending' },
      'unsettled_securities_activity',
    ],
    [
      'missing same-day execution verification',
      { noSameDayExecutionsVerified: undefined },
      'execution_unverified',
    ],
    [
      'nonzero same-day executions',
      { sameDayExecutionCount: 1 },
      'execution_unverified',
    ],
    [
      'non-numeric same-day execution attestation',
      { sameDayExecutionCount: '0' },
      'execution_unverified',
    ],
    [
      'multi-currency shorts',
      {
        shortPositions: [
          {
            quantity: -100,
            priorClose: 100,
            currentPrice: 100,
            currency: 'USD',
          },
          {
            quantity: -100,
            priorClose: 100,
            currentPrice: 100,
            currency: 'EUR',
          },
        ],
      },
      'unsupported_short_position_currency',
    ],
    [
      'non-stock positions',
      { positionScope: 'stocks_and_options' },
      'unsupported_position_scope',
    ],
    [
      'positive quantity in normalized short positions',
      {
        shortPositions: [
          {
            quantity: 100,
            priorClose: 100,
            currentPrice: 100,
            currency: 'USD',
          },
        ],
      },
      'invalid_short_position',
    ],
    [
      'missing current price for a short',
      {
        shortPositions: [
          {
            quantity: -100,
            priorClose: 100,
            currency: 'USD',
          },
        ],
      },
      'invalid_short_position',
    ],
    [
      'missing direct bid for a short',
      {
        shortPositions: [
          {
            conId: 756733,
            quantity: -1000,
            priorClose: 100,
            currentPrice: 100,
            directBid: undefined,
            currency: 'USD',
          },
        ],
      },
      'invalid_short_position',
    ],
    [
      'synthetic current-price source',
      {
        shortPositions: [
          {
            conId: 756733,
            quantity: -1000,
            priorClose: 100,
            currentPrice: 100,
            currentPriceSource: 'ibkr_ticker_market_price',
            currency: 'USD',
          },
        ],
      },
      'short_position_current_price_source_unverified',
    ],
    [
      'unknown prior-close source',
      {
        shortPositions: [
          {
            conId: 756733,
            quantity: -1000,
            priorClose: 100,
            priorCloseSource: 'unknown',
            currentPrice: 100,
            currency: 'USD',
          },
        ],
      },
      'short_position_prior_close_source_unverified',
    ],
    [
      'inconsistent stock exposure',
      { grossPositionValue: 90000, stockMarketValue: 95000 },
      'inconsistent_stock_exposure',
    ],
    [
      'short count mismatch',
      { shortPositionCount: 0 },
      'short_position_count_mismatch',
    ],
    [
      'open position count below short count',
      { openPositionCount: 0 },
      'invalid_open_position_count',
    ],
    [
      'non-live short market data',
      {
        shortPositions: [
          {
            quantity: -1000,
            priorClose: 100,
            currentPrice: 100,
            currency: 'USD',
            marketDataType: 3,
          },
        ],
      },
      'short_position_market_data_not_live',
    ],
    [
      'stale short snapshot relative to funding observation',
      {
        observedAt: '2026-07-23T12:02:00.000Z',
        shortPositions: [
          {
            quantity: -1000,
            priorClose: 100,
            currentPrice: 100,
            currency: 'USD',
            marketDataType: 1,
            snapshotTimestamp: '2026-07-23T12:00:00.000Z',
          },
        ],
      },
      'stale_short_position_timestamp',
    ],
  ])('fails closed for %s', (_label, overrides, expectedReason) => {
    const result = calculateIbkrCashBorrowing(fundingPayload(overrides));

    expect(result.available).toBe(false);
    expect(result.reasons).toContain(expectedReason);
    expect(result.rawHeadroom).toBeNull();
  });

  test('fails closed when aggregate shorts have no position evidence', () => {
    const result = calculateIbkrCashBorrowing(
      fundingPayload({
        shortPositions: [],
      }),
    );

    expect(result.available).toBe(false);
    expect(result.reasons).toContain('short_exposure_evidence_mismatch');
  });

  test('fails closed when direct short evidence understates aggregate shorts by $5k', () => {
    const result = calculateIbkrCashBorrowing(
      fundingPayload({
        shortPositions: [
          {
            conId: 756733,
            symbol: 'MACRO',
            quantity: -950,
            priorClose: 100,
            currentPrice: 100,
            currency: 'USD',
          },
        ],
      }),
    );

    expect(result.available).toBe(false);
    expect(result.reasons).toContain('short_exposure_evidence_mismatch');
  });

  test('accepts conservative direct-max marks within max($1k, 5%) surplus tolerance', () => {
    const result = calculateIbkrCashBorrowing(
      fundingPayload({
        shortPositions: [
          {
            conId: 756733,
            symbol: 'MACRO',
            quantity: -1040,
            priorClose: 100,
            currentPrice: 100,
            currency: 'USD',
          },
        ],
      }),
    );

    expect(result.available).toBe(true);
    expect(result.shortEvidenceMarketValue).toBe(104000);
    expect(result.shortExposureEvidenceTolerance).toBe(5000);
    expect(result.shortExposureEvidenceDeficitTolerance).toBe(100);
    expect(result.shortExposureEvidenceSurplusTolerance).toBe(5000);
  });
});

describe('calculateIbkrCashBorrowingReference', () => {
  test('calculates a non-actionable Friday-close reference across the full ladder', () => {
    const result = calculateIbkrCashBorrowingReference(
      fundingReferencePayload(),
    );

    expect(result.available).toBe(true);
    expect(result.status).toBe('reference');
    expect(result.referenceOnly).toBe(true);
    expect(result.actionable).toBe(false);
    expect(result.referenceSessionDate).toBe('2026-07-24');
    expect(result.cashLedgerObservedDate).toBe('2026-07-25');
    expect(result.settlementHorizonDate).toBe('2026-07-27');
    expect(result.securitiesCashFloor).toBe(114000);
    expect(result.worstSettlementDate).toBe('20260727');
    expect(result.shortCollateral).toBe(102000);
    expect(result.policyBuffer).toEqual(expect.objectContaining({
      shortAdverseMoveRate: 0.05,
      shortShock: 6000,
      total: 8000,
    }));
    expect(result.guardedHeadroom).toBe(4000);
    expect(result.projectScenario({ type: 'add_long', amount: 1000 }))
      .toMatchObject({
        available: false,
        reason: 'reference_not_actionable',
      });
    expect(projectIbkrCashBorrowingScenario(
      result,
      { type: 'add_long', amount: 1000 },
    )).toMatchObject({
      available: false,
      reason: 'reference_not_actionable',
    });
  });

  test('rejects live quote fields in historical reference evidence', () => {
    const payload = fundingReferencePayload();
    payload.shortPositionReferences[0].currentPrice = 100;

    const result = calculateIbkrCashBorrowingReference(payload);

    expect(result.available).toBe(false);
    expect(result.reasons).toContain('invalid_short_position_reference');
  });

  test('rejects unverified provenance and open orders', () => {
    const result = calculateIbkrCashBorrowingReference(
      fundingReferencePayload({
        source: 'ibkr_live_session',
        openOrderCount: 1,
      }),
    );

    expect(result.available).toBe(false);
    expect(result.reasons).toEqual(expect.arrayContaining([
      'reference_provenance_unverified',
      'open_orders_present',
    ]));
  });

  test('rejects a settlement horizon or terminal balance that does not reconcile', () => {
    const result = calculateIbkrCashBorrowingReference(
      fundingReferencePayload({
        settlementHorizonDate: '2026-07-28',
        totalCashValueSecurities: 115000,
      }),
    );

    expect(result.available).toBe(false);
    expect(result.reasons).toEqual(expect.arrayContaining([
      'reference_settlement_horizon_mismatch',
      'reference_securities_ladder_unreconciled',
    ]));
  });
});

describe('planned-trade scenarios', () => {
  test('add/trim long move guarded headroom in opposite directions', () => {
    const baseline = calculateIbkrCashBorrowing(fundingPayload());
    const add = baseline.scenario({ type: 'add_long', amount: 1000 });
    const trim = baseline.scenario({ type: 'trim_long', amount: 1000 });

    expect(add.guardedHeadroom).toBe(baseline.guardedHeadroom - 1000);
    expect(trim.guardedHeadroom).toBe(baseline.guardedHeadroom + 1000);
    expect(add).toEqual(
      expect.objectContaining({
        timing: 'post_settlement',
        projectionTiming: 'post_settlement',
        improvesOnlyAfterSettlement: false,
        settledCashChange: -1000,
      }),
    );
    expect(trim).toEqual(
      expect.objectContaining({
        timing: 'post_settlement',
        projectionTiming: 'post_settlement',
        improvesOnlyAfterSettlement: true,
        settledCashChange: 1000,
      }),
    );
    expect(add).toEqual(
      expect.objectContaining({
        longMV: 196000,
        shortMV: 100000,
        grossMV: 296000,
        netMV: 96000,
      }),
    );
    expect(trim).toEqual(
      expect.objectContaining({
        longMV: 194000,
        shortMV: 100000,
        grossMV: 294000,
        netMV: 94000,
      }),
    );
  });

  test('recomputes the deficit-only commodity adjustment after settlement', () => {
    const baseline = calculateIbkrCashBorrowing(
      fundingPayload({
        totalCashValueSecurities: 1000,
        totalCashValueCommodities: 5000,
        commodityMaintenanceMargin: 0,
        grossPositionValue: 195000,
        stockMarketValue: 195000,
        settledCashByDateSecurities: {
          20260723: 1000,
        },
        settledCashByDateCommodities: {
          20260723: 5000,
        },
        shortPositions: [],
      }),
    );
    const add = baseline.scenario({ type: 'add_long', amount: 2000 });

    expect(baseline.adjustmentForSecuritiesDeficit).toBe(0);
    expect(add).toEqual(
      expect.objectContaining({
        timing: 'post_settlement',
        securitiesCashFloor: -1000,
        adjustmentForSecuritiesDeficit: 1000,
        eligibleProjectedCash: 0,
        brokerAdjustedCash: 0,
        deltaRawHeadroom: -1000,
        requiredSecuritiesCashForGuard: 2000,
        longTrimNeeded: 3000,
      }),
    );
  });

  test('rejects the old manual-price short path', () => {
    const baseline = calculateIbkrCashBorrowing(fundingPayload());
    const unavailable = baseline.scenario({
      type: 'add_short',
      quantity: 100,
      conId: 756733,
      limitPrice: 100,
      priorClose: 50,
      currentPrice: 50,
      currency: 'USD',
    });

    expect(unavailable).toEqual(
      expect.objectContaining({
        available: false,
        reason: 'short_trade_manual_pricing_not_allowed',
      }),
    );
    expect(baseline.addShortAllowed).toBeUndefined();
  });

  test('add/cover short derive prices, collateral, and shock from the exact conId', () => {
    const baseline = calculateIbkrCashBorrowing(fundingPayload());
    const trade = {
      conId: 756733,
      quantity: 100,
    };
    const add = projectIbkrCashBorrowingScenario(baseline, {
      type: 'add_short',
      limitPrice: 100,
      ...trade,
    });
    const cover = baseline.projectScenario({
      type: 'cover_short',
      limitPrice: 105,
      ...trade,
    });

    expect(add.deltaRawHeadroom).toBe(-200);
    expect(add.deltaPolicyBuffer).toBe(600);
    expect(add.guardedHeadroom).toBe(baseline.guardedHeadroom - 800);
    expect(add.collateral).toBe(baseline.collateral + 10200);
    expect(add).toEqual(
      expect.objectContaining({
        timing: 'post_settlement',
        derivedFromVerifiedPosition: true,
        conId: '756733',
        limitPrice: 100,
        orderType: 'limit',
        conditionalOnFill: true,
        fillCondition: 'limit_price_or_better',
        marketOrderSupported: false,
        priorClose: 100,
        currentPrice: 100,
        settledCashChange: 10000,
        longMV: 195000,
        shortMV: 110000,
        grossMV: 305000,
        netMV: 85000,
      }),
    );

    expect(cover.deltaRawHeadroom).toBe(-300);
    expect(cover.deltaPolicyBuffer).toBe(-600);
    expect(cover.guardedHeadroom).toBe(baseline.guardedHeadroom + 300);
    expect(cover.collateral).toBe(baseline.collateral - 10200);
    expect(cover).toEqual(
      expect.objectContaining({
        timing: 'post_settlement',
        improvesOnlyAfterSettlement: true,
        derivedFromVerifiedPosition: true,
        conId: '756733',
        limitPrice: 105,
        orderType: 'limit',
        conditionalOnFill: true,
        priorClose: 100,
        currentPrice: 100,
        settledCashChange: -10500,
        coverCost: 10500,
        longMV: 195000,
        shortMV: 90000,
        grossMV: 285000,
        netMV: 105000,
      }),
    );
  });

  test(
    'add-to-short uses a marketable sell limit at or below the verified live bid',
    () => {
    const baseline = calculateIbkrCashBorrowing(
      fundingPayload({
        grossPositionValue: 305000,
        stockMarketValue: 85000,
        shortPositions: [
          {
            conId: 756733,
            symbol: 'WIDE',
            quantity: -1000,
            priorClose: 100,
            currentPrice: 110,
            directBid: 90,
            directAsk: 110,
            directLast: 100,
            currency: 'USD',
          },
        ],
      }),
    );
    const add = baseline.projectScenario({
      type: 'add_short',
      conId: 756733,
      quantity: 100,
      limitPrice: 85,
    });

    expect(add).toEqual(
      expect.objectContaining({
        available: true,
        limitPrice: 85,
        orderType: 'limit',
        conditionalOnFill: true,
        fillCondition: 'limit_price_or_better',
        submissionTiming: 'immediate_live_snapshot',
        marketOrderSupported: false,
        settledCashChange: 8500,
        shortSaleProceeds: 8500,
        shortMarketValueChange: 11000,
        shortMV: 121000,
        grossMV: 316000,
        netMV: 74000,
      }),
    );
    expect(add.deltaRawHeadroom).toBe(-1700);
    expect(add.deltaPolicyBuffer).toBe(1600);
    expect(add.deltaGuardedHeadroom).toBe(-3300);
    },
  );

  test('rejects an add-to-short sell limit above the verified live bid', () => {
    const baseline = calculateIbkrCashBorrowing(
      fundingPayload({
        grossPositionValue: 305000,
        stockMarketValue: 85000,
        shortPositions: [
          {
            conId: 756733,
            symbol: 'WIDE',
            quantity: -1000,
            priorClose: 100,
            currentPrice: 110,
            directBid: 90,
            directAsk: 110,
            directLast: 100,
            currency: 'USD',
          },
        ],
      }),
    );

    expect(
      baseline.projectScenario({
        type: 'add_short',
        conId: 756733,
        quantity: 100,
        limitPrice: 95,
      }),
    ).toEqual(
      expect.objectContaining({
        available: false,
        reason: 'add_short_limit_above_live_bid',
      }),
    );
  });

  test('rejects a cover buy limit below the verified live ask', () => {
    const baseline = calculateIbkrCashBorrowing(
      fundingPayload({
        grossPositionValue: 305000,
        stockMarketValue: 85000,
        shortPositions: [
          {
            conId: 756733,
            symbol: 'WIDE',
            quantity: -1000,
            priorClose: 100,
            currentPrice: 110,
            directBid: 90,
            directAsk: 110,
            directLast: 100,
            currency: 'USD',
          },
        ],
      }),
    );

    expect(
      baseline.projectScenario({
        type: 'cover_short',
        conId: 756733,
        quantity: 100,
        limitPrice: 105,
      }),
    ).toEqual(
      expect.objectContaining({
        available: false,
        reason: 'cover_short_limit_below_live_ask',
      }),
    );
  });

  test.each([
    ['add_short', 'currentPrice'],
    ['add_short', 'priorClose'],
    ['cover_short', 'currentPrice'],
    ['cover_short', 'priorClose'],
  ])(
    '%s rejects caller-supplied %s even when conId and limit are valid',
    (type, evidenceField) => {
      const baseline = calculateIbkrCashBorrowing(fundingPayload());
      const projection = baseline.projectScenario({
        type,
        conId: 756733,
        quantity: 1,
        limitPrice: 100,
        [evidenceField]: 0.01,
      });

      expect(projection).toEqual(
        expect.objectContaining({
          available: false,
          reason: 'short_trade_manual_pricing_not_allowed',
        }),
      );
    },
  );

  test.each(['add_short', 'cover_short'])(
    '%s requires a positive finite limit price',
    (type) => {
      const baseline = calculateIbkrCashBorrowing(fundingPayload());
      const scenarios = [
        { type, conId: 756733, quantity: 1 },
        { type, conId: 756733, quantity: 1, limitPrice: '' },
        { type, conId: 756733, quantity: 1, limitPrice: 0 },
        { type, conId: 756733, quantity: 1, limitPrice: -1 },
        { type, conId: 756733, quantity: 1, limitPrice: Number.NaN },
        { type, conId: 756733, quantity: 1, limitPrice: Number.POSITIVE_INFINITY },
      ];

      scenarios.forEach((scenario) => {
        expect(baseline.projectScenario(scenario)).toEqual(
          expect.objectContaining({
            available: false,
            reason: 'short_trade_requires_limit_price',
          }),
        );
      });
    },
  );

  test('fails closed when the selected conId is missing or unknown', () => {
    const missingIdentity = calculateIbkrCashBorrowing(
      fundingPayload({
        shortPositions: [
          {
            quantity: -1000,
            priorClose: 100,
            currentPrice: 100,
            currency: 'USD',
          },
        ],
      }),
    );

    expect(
      missingIdentity.projectScenario({
        type: 'add_short',
        conId: 756733,
        quantity: 10,
        limitPrice: 100,
      }),
    ).toEqual(
      expect.objectContaining({
        available: false,
        reason: 'short_trade_position_not_found',
      }),
    );
    expect(
      missingIdentity.projectScenario({
        type: 'cover_short',
        quantity: 10,
        limitPrice: 100,
      }),
    ).toEqual(
      expect.objectContaining({
        available: false,
        reason: 'short_trade_requires_verified_conid',
      }),
    );
  });

  test('fails closed when a conId is ambiguous across baseline shorts', () => {
    const baseline = calculateIbkrCashBorrowing(
      fundingPayload({
        shortPositions: [
          {
            conId: 756733,
            symbol: 'MACRO-A',
            quantity: -500,
            priorClose: 100,
            currentPrice: 100,
            currency: 'USD',
          },
          {
            conId: '756733',
            symbol: 'MACRO-B',
            quantity: -500,
            priorClose: 100,
            currentPrice: 100,
            currency: 'USD',
          },
        ],
      }),
    );

    expect(baseline.available).toBe(true);
    expect(
      baseline.projectScenario({
        type: 'add_short',
        conId: 756733,
        quantity: 10,
        limitPrice: 100,
      }),
    ).toEqual(
      expect.objectContaining({
        available: false,
        reason: 'short_trade_position_ambiguous',
      }),
    );
  });

  test('cover quantity cannot exceed the exact verified short', () => {
    const baseline = calculateIbkrCashBorrowing(fundingPayload());
    const projection = baseline.projectScenario({
      type: 'cover_short',
      conId: 756733,
      quantity: 1000.01,
      limitPrice: 100,
    });

    expect(projection).toEqual(
      expect.objectContaining({
        available: false,
        reason: 'cover_short_quantity_exceeds_verified_position',
      }),
    );
  });
});
