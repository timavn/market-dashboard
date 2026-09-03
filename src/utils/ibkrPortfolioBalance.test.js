const {
  calculatePortfolioBalance,
  calculatePortfolioExposure,
  parseCashLadder,
  projectPortfolioBalance,
} = require('./ibkrPortfolioBalance.cjs');

function evidence(overrides = {}) {
  const shortPositions = Object.prototype.hasOwnProperty.call(overrides, 'shortPositions')
    ? overrides.shortPositions
    : [{
      conId: 756733,
      symbol: 'SPY',
      quantity: -1000,
      currency: 'USD',
      priorClose: 100,
      priorCloseSource: 'ibkr_historical_daily_close',
      priorCloseSessionDate: '2026-07-22',
      priorCloseObservedAt: '2026-07-23T15:00:00Z',
    }];
  return {
    accountId: 'U1',
    accountReady: true,
    baseCurrency: 'USD',
    currency: 'USD',
    positionScope: 'stocks_only',
    netLiquidation: 195000,
    totalCashValueSecurities: 114000,
    totalCashValueCommodities: 0,
    commodityMaintenanceMargin: 0,
    grossPositionValue: 295000,
    stockMarketValue: 95000,
    accruedCashSecurities: 0,
    settledCashByDateSecurities: '20260723:115000;20260724:114000',
    settledCashByDateCommodities: '20260723:0;20260724:0',
    settlementLaddersVerified: true,
    activitySnapshotVerified: true,
    settlementState: 'pending',
    settlementDate: '2026-07-23',
    settlementHorizonDate: '2026-07-24',
    openPositionCount: 2,
    shortPositionCount: shortPositions.length,
    openOrderCount: 0,
    sameDayExecutionCount: 0,
    shortPositions,
    observedAt: '2026-07-23T15:00:00Z',
    socketVerifiedAt: '2026-07-23T15:00:00Z',
    accountValuesObservedAt: '2026-07-23T15:00:00Z',
    ...overrides,
    shortPositions,
  };
}

describe('IBKR portfolio balance', () => {
  test('keeps broker-native aggregate exposure available without position evidence', () => {
    const result = calculatePortfolioExposure({
      accountReady: true,
      baseCurrency: 'USD',
      netLiquidation: 184016.42,
      grossPositionValue: 224756.97,
      stockMarketValue: 33092.45,
    });

    expect(result).toMatchObject({
      available: true,
      status: 'live',
      currency: 'USD',
      grossMarketValue: 224756.97,
    });
    expect(result.longMarketValue).toBeCloseTo(128924.71, 2);
    expect(result.shortMarketValue).toBeCloseTo(95832.26, 2);
    expect(result.netMarketValue).toBeCloseTo(33092.45, 2);
  });

  test('parses compact and object cash ladders in date order', () => {
    expect(parseCashLadder('20260724:2;20260723:1')).toEqual([
      { date: '2026-07-23', balance: 1 },
      { date: '2026-07-24', balance: 2 },
    ]);
    expect(parseCashLadder({ '2026-07-23': 1 })).toEqual([
      { date: '2026-07-23', balance: 1 },
    ]);
  });

  test('accepts pending settlements and uses the worst securities cash row', () => {
    const result = calculatePortfolioBalance(evidence());

    expect(result.available).toBe(true);
    expect(result.settlement).toEqual({
      state: 'pending',
      date: '2026-07-23',
      horizonDate: '2026-07-24',
      pending: true,
    });
    expect(result.cash.securitiesCashFloor).toBe(114000);
    expect(result.cash.worstSettlementDate).toBe('2026-07-24');
    expect(result.cash.shortCollateral).toBe(102000);
    expect(result.cash.noBorrowBalance).toBe(12000);
    expect(result.cash.noBorrowLongLimit).toBe(207000);
    expect(result.interestExposure).toMatchObject({
      available: true,
      status: 'live',
      source: 'ibkr_live_session',
      interpretation: 'debit_interest_exposure_only',
      actionable: false,
      current: {
        effectiveDate: '2026-07-23',
        estimatedDebitPrincipal: 0,
        interestFreeRoom: 13000,
      },
      projected: {
        effectiveDate: '2026-07-24',
        estimatedDebitPrincipal: 0,
        interestFreeRoom: 12000,
      },
      policy: {
        totalReserve: 7100,
        estimatedDebitPrincipalAfterReserve: 0,
      },
    });
  });

  test('uses the latest current anchor and ignores older historical ladder rows', () => {
    const result = calculatePortfolioBalance(evidence({
      totalCashValueSecurities: 114000,
      settledCashByDateSecurities:
        '20260721:50000;20260723:115000;20260724:114000',
    }));

    expect(result.available).toBe(true);
    expect(result.cash.securitiesCashFloor).toBe(114000);
    expect(result.cash.worstSettlementDate).toBe('2026-07-24');
  });

  test('keeps exact and policy-buffered balances separate', () => {
    const result = calculatePortfolioBalance(evidence());

    expect(result.buffer.baseReserve).toBe(2000);
    expect(result.buffer.shortShockReserve).toBe(5100);
    expect(result.buffer.totalReserve).toBe(7100);
    expect(result.buffer.balance).toBe(4900);
    expect(result.buffer.bufferedLongLimit).toBe(199900);
  });

  test('subtracts negative accrued securities cash from the exact balance', () => {
    const result = calculatePortfolioBalance(evidence({ accruedCashSecurities: -750 }));

    expect(result.cash.netAccruedInterest).toBe(-750);
    expect(result.cash.accruedDebitReserve).toBe(750);
    expect(result.cash.noBorrowBalance).toBe(11250);
  });

  test('uses IBKR per-share collateral rounding before multiplying shares', () => {
    const result = calculatePortfolioBalance(evidence({
      shortPositions: [{
        conId: 756733,
        symbol: 'SPY',
        quantity: -10,
        currency: 'USD',
        priorClose: 100.01,
        priorCloseSource: 'ibkr_historical_daily_close',
        priorCloseSessionDate: '2026-07-22',
        priorCloseObservedAt: '2026-07-23T15:00:00Z',
      }],
      shortPositionCount: 1,
    }));

    expect(result.shortPositions[0].collateralPerShare).toBe(103);
    expect(result.cash.shortCollateral).toBe(1030);
  });

  test('uses commodity excess only to cure a securities deficit', () => {
    const result = calculatePortfolioBalance(evidence({
      totalCashValueSecurities: -5000,
      settledCashByDateSecurities: '20260723:-5000;20260724:-5000',
      totalCashValueCommodities: 8000,
      settledCashByDateCommodities: '20260723:8000;20260724:8000',
      commodityMaintenanceMargin: 1000,
      grossPositionValue: 100000,
      stockMarketValue: 100000,
      shortPositions: [],
      shortPositionCount: 0,
      openPositionCount: 1,
    }));

    expect(result.available).toBe(true);
    expect(result.cash.commodityResidual).toBe(7000);
    expect(result.cash.commodityAdjustment).toBe(5000);
    expect(result.cash.noBorrowBalance).toBe(0);
    expect(result.cash.commodityResidualAfterAdjustment).toBe(2000);
  });

  test('credits Kalshi mark value against its matching margin without granting stock collateral', () => {
    const result = calculatePortfolioBalance(evidence({
      positionScope: 'stocks_and_kalshi',
      netLiquidation: 149350,
      totalCashValueSecurities: -1000,
      totalCashValueCommodities: 100,
      settledCashByDateSecurities: '20260723:-1000;20260724:-1000',
      settledCashByDateCommodities: '20260723:100;20260724:100',
      commodityMaintenanceMargin: 250,
      grossPositionValue: 100000,
      stockMarketValue: 100000,
      openPositionCount: 2,
      shortPositions: [],
      shortPositionCount: 0,
      kalshiPositionCount: 1,
      kalshiContractQuantity: 25,
      kalshiMarketValue: 250,
      kalshiNetLiquidation: 350,
      kalshiInitialMargin: 250,
      kalshiMaintenanceMargin: 250,
      kalshiAvailableFunds: 100,
      kalshiEquityWithLoanValue: 100,
      kalshiAccountingVerified: true,
      kalshiAccountingVerification: 'ibkr_kalshi_commodity_segment_reconciled',
    }));

    expect(result.available).toBe(true);
    expect(result.cash.commodityResidual).toBe(100);
    expect(result.cash.commodityAdjustment).toBe(100);
    expect(result.cash.noBorrowBalance).toBe(-900);
    expect(result.eventContracts).toMatchObject({
      venues: ['KALSHI'],
      venue: 'KALSHI',
      positionCount: 1,
      contractQuantity: 25,
      marketValue: 250,
      capacityContribution: 0,
    });
  });

  test('accepts canonical mixed event-contract accounting with sorted venues', () => {
    const result = calculatePortfolioBalance(evidence({
      positionScope: 'stocks_and_event_contracts',
      eventVenues: ['FORECASTX', 'KALSHI'],
      netLiquidation: 149350,
      totalCashValueSecurities: -1000,
      totalCashValueCommodities: 100,
      settledCashByDateSecurities: '20260723:-1000;20260724:-1000',
      settledCashByDateCommodities: '20260723:100;20260724:100',
      commodityMaintenanceMargin: 250,
      grossPositionValue: 100000,
      stockMarketValue: 100000,
      openPositionCount: 3,
      shortPositions: [],
      shortPositionCount: 0,
      eventPositionCount: 2,
      eventContractQuantity: 25,
      eventMarketValue: 250,
      eventNetLiquidation: 350,
      eventInitialMargin: 250,
      eventMaintenanceMargin: 250,
      eventAvailableFunds: 100,
      eventEquityWithLoanValue: 100,
      eventAccountingVerified: true,
      eventAccountingVerification:
        'ibkr_event_contract_commodity_segment_reconciled',
    }));

    expect(result.available).toBe(true);
    expect(result.positionScope).toBe('stocks_and_event_contracts');
    expect(result.eventContracts).toMatchObject({
      venues: ['FORECASTX', 'KALSHI'],
      venue: null,
      positionCount: 2,
      contractQuantity: 25,
      marketValue: 250,
      verification: 'ibkr_event_contract_commodity_segment_reconciled',
    });
  });

  test('fails closed for unknown or unsorted canonical event venues', () => {
    const canonical = {
      positionScope: 'stocks_and_event_contracts',
      eventVenues: ['KALSHI', 'FORECASTX'],
      eventPositionCount: 1,
      eventContractQuantity: 1,
      eventMarketValue: 250,
      eventNetLiquidation: 250,
      eventInitialMargin: 250,
      eventMaintenanceMargin: 250,
      eventAvailableFunds: 0,
      eventEquityWithLoanValue: 0,
      eventAccountingVerified: true,
      eventAccountingVerification:
        'ibkr_event_contract_commodity_segment_reconciled',
    };

    expect(calculatePortfolioBalance(evidence(canonical)).reasons)
      .toContain('invalid_event_venues');
    expect(calculatePortfolioBalance(evidence({
      ...canonical,
      eventVenues: ['UNKNOWN'],
    })).reasons).toContain('invalid_event_venues');
  });

  test('fails closed when Kalshi broker accounting does not reconcile', () => {
    const result = calculatePortfolioBalance(evidence({
      positionScope: 'stocks_and_kalshi',
      openPositionCount: 2,
      eventPositionCount: 1,
      kalshiPositionCount: 1,
      kalshiContractQuantity: 1,
      kalshiMarketValue: 250,
      kalshiNetLiquidation: 350,
      kalshiInitialMargin: 250,
      kalshiMaintenanceMargin: 251,
      kalshiAvailableFunds: 100,
      kalshiEquityWithLoanValue: 100,
      kalshiAccountingVerified: true,
      kalshiAccountingVerification: 'ibkr_kalshi_commodity_segment_reconciled',
    }));

    expect(result.available).toBe(false);
    expect(result.reasons).toContain('kalshi_accounting_unreconciled');
  });

  test('honors a lower broker-reported Kalshi available-funds holdback', () => {
    const result = calculatePortfolioBalance(evidence({
      positionScope: 'stocks_and_kalshi',
      netLiquidation: 149350,
      totalCashValueSecurities: -1000,
      totalCashValueCommodities: 100,
      settledCashByDateSecurities: '20260723:-1000;20260724:-1000',
      settledCashByDateCommodities: '20260723:100;20260724:100',
      commodityMaintenanceMargin: 250,
      grossPositionValue: 100000,
      stockMarketValue: 100000,
      openPositionCount: 2,
      shortPositions: [],
      shortPositionCount: 0,
      eventPositionCount: 1,
      kalshiPositionCount: 1,
      kalshiContractQuantity: 25,
      kalshiMarketValue: 250,
      kalshiNetLiquidation: 350,
      kalshiInitialMargin: 250,
      kalshiMaintenanceMargin: 250,
      kalshiAvailableFunds: 72,
      kalshiEquityWithLoanValue: 100,
      kalshiAccountingVerified: true,
      kalshiAccountingVerification: 'ibkr_kalshi_commodity_segment_reconciled',
    }));

    expect(result.available).toBe(true);
    expect(result.cash.commodityResidualBeforeBrokerHoldback).toBe(100);
    expect(result.cash.commodityResidual).toBe(72);
    expect(result.cash.commodityAdjustment).toBe(72);
    expect(result.eventContracts.availableFundsHoldback).toBe(28);
    expect(result.eventContracts.capacityContribution).toBe(0);
  });

  test('fails closed when Kalshi available funds exceed the residual', () => {
    const result = calculatePortfolioBalance(evidence({
      positionScope: 'stocks_and_kalshi',
      openPositionCount: 2,
      eventPositionCount: 1,
      kalshiPositionCount: 1,
      kalshiContractQuantity: 1,
      kalshiMarketValue: 250,
      kalshiNetLiquidation: 350,
      kalshiInitialMargin: 250,
      kalshiMaintenanceMargin: 250,
      kalshiAvailableFunds: 100.02,
      kalshiEquityWithLoanValue: 100,
      kalshiAccountingVerified: true,
      kalshiAccountingVerification: 'ibkr_kalshi_commodity_segment_reconciled',
    }));

    expect(result.available).toBe(false);
    expect(result.reasons).toContain('kalshi_accounting_unreconciled');
  });

  test('returns an explicit trim when exact or buffered balance is negative', () => {
    const result = calculatePortfolioBalance(evidence({
      totalCashValueSecurities: 100000,
      settledCashByDateSecurities: '20260723:100000;20260724:100000',
    }));

    expect(result.cash.noBorrowBalance).toBe(-2000);
    expect(result.cash.addLongRoom).toBe(0);
    expect(result.cash.trimRequired).toBe(2000);
    expect(result.buffer.trimRequired).toBe(9100);
  });

  test('allows stable same-day executions and exposes open orders as a preview gate', () => {
    const result = calculatePortfolioBalance(evidence({
      sameDayExecutionCount: 3,
      openOrderCount: 2,
    }));

    expect(result.available).toBe(true);
    expect(result.activity.sameDayExecutionCount).toBe(3);
    expect(result.activity.previewAvailable).toBe(false);
    expect(result.activity.previewUnavailableReason).toBe('open_orders_present');
  });

  test('accepts a fully settled single-day ladder', () => {
    const result = calculatePortfolioBalance(evidence({
      totalCashValueSecurities: 115000,
      settledCashByDateSecurities: '20260723:115000',
      settledCashByDateCommodities: '20260723:0',
      settlementState: 'settled',
      settlementHorizonDate: '2026-07-23',
    }));

    expect(result.available).toBe(true);
    expect(result.settlement.pending).toBe(false);
  });

  test('fails closed for an unreconciled terminal ladder', () => {
    const result = calculatePortfolioBalance(evidence({
      totalCashValueSecurities: 113999,
    }));

    expect(result.available).toBe(false);
    expect(result.reasons).toContain('securities_cash_ladder_unreconciled');
  });

  test('fails closed when a ladder has no current cash anchor', () => {
    const result = calculatePortfolioBalance(evidence({
      settledCashByDateSecurities: '20260724:114000',
    }));

    expect(result.available).toBe(false);
    expect(result.reasons).toContain('securities_cash_ladder_incomplete');
  });

  test('fails closed for unsupported currencies and position scope', () => {
    expect(calculatePortfolioBalance(evidence({ currency: 'EUR' })).reason)
      .toBe('unsupported_currency');
    expect(calculatePortfolioBalance(evidence({ positionScope: 'mixed' })).reason)
      .toBe('unsupported_position_scope');
  });

  test('supports a stock-only account with no shorts', () => {
    const result = calculatePortfolioBalance(evidence({
      grossPositionValue: 100000,
      stockMarketValue: 100000,
      shortPositions: [],
      shortPositionCount: 0,
      openPositionCount: 1,
    }));

    expect(result.available).toBe(true);
    expect(result.cash.shortCollateral).toBe(0);
    expect(result.exposure.shortMarketValue).toBe(0);
  });

  test('projects a long change without mutating the verified baseline', () => {
    const baseline = {
      ...calculatePortfolioBalance(evidence()),
      snapshotId: 'snapshot-1',
    };
    const projection = projectPortfolioBalance(baseline, {
      action: 'add_long',
      amount: 5000,
    });

    expect(projection.available).toBe(true);
    expect(projection.cash.noBorrowBalance).toBe(7000);
    expect(projection.exposure.longMarketValue).toBe(200000);
    expect(projection.orderSubmitted).toBe(false);
    expect(baseline.cash.noBorrowBalance).toBe(12000);
  });

  test('projects multiple verified long and short legs without submitting orders', () => {
    const baseline = {
      ...calculatePortfolioBalance(evidence()),
      snapshotId: 'snapshot-1',
    };
    const projection = projectPortfolioBalance(
      baseline,
      {
        accountId: 'U1',
        legs: [
          {
            id: 'long-1',
            action: 'buy_long',
            symbol: 'AAPL',
            quantityMode: 'shares',
            quantity: 10,
          },
          {
            id: 'short-1',
            action: 'add_short',
            symbol: 'SPY',
            quantityMode: 'shares',
            quantity: 100,
          },
        ],
      },
      {
        legs: {
          'long-1': {
            available: true,
            conId: 111,
            bid: 199.9,
            ask: 200,
            currentPrice: 200,
            marketDataType: 1,
          },
          'short-1': {
            available: true,
            conId: 756733,
            positionQuantity: -1000,
            bid: 100,
            ask: 100.1,
            currentPrice: 101,
            shortableShares: 1000,
            priorClose: 100,
            collateralPerShare: 102,
            marketDataType: 1,
          },
        },
      },
    );

    expect(projection.available).toBe(true);
    expect(projection.orderSubmitted).toBe(false);
    expect(projection.legs).toHaveLength(2);
    expect(projection.exposure.longMarketValue).toBe(197000);
    expect(projection.exposure.shortMarketValue).toBe(110100);
    expect(projection.cash.shortCollateral).toBe(112200);
  });

  test('reports ticker-specific maximum additional short shares and exposure', () => {
    const baseline = {
      ...calculatePortfolioBalance(evidence()),
      snapshotId: 'snapshot-1',
    };
    const projection = projectPortfolioBalance(
      baseline,
      {
        accountId: 'U1',
        legs: [{
          id: 'short-1',
          action: 'add_short',
          symbol: 'SPY',
          quantityMode: 'shares',
          quantity: 100,
        }],
      },
      {
        legs: {
          'short-1': {
            available: true,
            conId: 756733,
            positionQuantity: -1000,
            bid: 100,
            ask: 100.1,
            currentPrice: 101,
            shortableShares: 10000,
            priorClose: 100,
            collateralPerShare: 102,
            marketDataType: 1,
          },
        },
      },
    );

    expect(projection.available).toBe(true);
    expect(projection.legs[0].shortCapacity).toMatchObject({
      cashConsumedPerShare: 2,
      exactShares: 6000,
      exactNotional: 606000,
      bufferedShares: 2450,
      bufferedNotional: 247450,
    });
  });

  test('requires live quote and borrow evidence to add to an existing short', () => {
    const baseline = calculatePortfolioBalance(evidence());
    const missing = projectPortfolioBalance(baseline, {
      action: 'add_short',
      conId: 756733,
      quantity: 100,
      limitPrice: 99,
    });
    expect(missing.reason).toBe('live_short_evidence_unavailable');

    const projection = projectPortfolioBalance(
      baseline,
      {
        action: 'add_short',
        conId: 756733,
        quantity: 100,
        limitPrice: 99,
      },
      {
        available: true,
        conId: 756733,
        positionQuantity: -1000,
        bid: 100,
        ask: 100.1,
        currentPrice: 101,
        shortableShares: 1000,
        marketDataType: 1,
      },
    );
    expect(projection.available).toBe(true);
    expect(projection.cash.shortCollateral).toBe(112200);
    expect(projection.exposure.shortMarketValue).toBe(110100);
    expect(projection.orderSubmitted).toBe(false);
  });

  test('rejects a preview when the short changes after the balance read', () => {
    const baseline = calculatePortfolioBalance(evidence());
    const projection = projectPortfolioBalance(
      baseline,
      {
        action: 'add_short',
        conId: 756733,
        quantity: 100,
        limitPrice: 99,
      },
      {
        available: true,
        conId: 756733,
        positionQuantity: -900,
        bid: 100,
        ask: 100.1,
        currentPrice: 101,
        shortableShares: 1000,
        marketDataType: 1,
      },
    );

    expect(projection.reason).toBe('live_short_position_changed');
  });

  test('rejects covers above the verified position and previews valid covers', () => {
    const baseline = calculatePortfolioBalance(evidence());
    const quote = {
      available: true,
      conId: 756733,
      positionQuantity: -1000,
      bid: 99.9,
      ask: 100,
      currentPrice: 100,
      marketDataType: 1,
    };
    expect(projectPortfolioBalance(baseline, {
      action: 'cover_short',
      conId: 756733,
      quantity: 1001,
      limitPrice: 100,
    }, quote).reason).toBe('cover_exceeds_verified_short_position');

    const valid = projectPortfolioBalance(baseline, {
      action: 'cover_short',
      conId: 756733,
      quantity: 100,
      limitPrice: 100,
    }, quote);
    expect(valid.available).toBe(true);
    expect(valid.exposure.shortMarketValue).toBe(90000);
  });

  test('disables every preview while open orders exist', () => {
    const baseline = calculatePortfolioBalance(evidence({ openOrderCount: 1 }));
    expect(projectPortfolioBalance(baseline, {
      action: 'add_long',
      amount: 1000,
    }).reason).toBe('open_orders_present');
  });
});
