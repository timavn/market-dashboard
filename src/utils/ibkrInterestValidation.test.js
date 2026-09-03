const {
  CALIBRATION_WINDOW,
  INTEREST_DAY_COUNT,
  buildIbkrInterestDecision,
  calculateForecastCushion,
  calculateInterestGuardReserve,
  calculateOneSidedQ95,
  calculateSegmentTransfer,
  calculateTieredUsdInterest,
  calculateUsdShortCollateral,
  calibrateProspectiveInterest,
  forecastIbkrDebitInterest,
  validateInterestForecastInput,
} = require("./ibkrInterestValidation.cjs");

const usdTiers = [
  { label: "first_100k", upTo: 100000, annualRate: 0.072 },
  { label: "above_100k", upTo: null, annualRate: 0.062 },
];

function matchedPeriod(overrides = {}) {
  return {
    id: "match-1",
    matched: true,
    prospective: true,
    verified: true,
    accrualDays: 1,
    rawForecast: 10,
    issuedPointForecast: 10,
    actualInterest: 10,
    ...overrides,
  };
}

function forecastInput(overrides = {}) {
  const input = {
    currency: "USD",
    positionScope: "stocks_only",
    accountInputsVerified: true,
    tiers: [{ label: "all", upTo: null, annualRate: 0.06 }],
    tiersVerified: true,
    accrualPeriods: [
      {
        id: "weekend",
        accrualDays: 3,
        securitiesCash: -100000,
        ibuklCash: 0,
        commoditiesCash: 30000,
        commodityMaintenanceMargin: 10000,
        shortPositions: [
          {
            conId: 123,
            symbol: "SHORT",
            currency: "USD",
            quantity: -100,
            priorClose: 50.1,
          },
        ],
      },
    ],
    calibration: {
      matches: [],
      chronologicalOrderVerified: true,
      monthlyReconciled: false,
    },
    ...overrides,
  };

  return input;
}

describe("IBKR interest segment and collateral model", () => {
  test("uses commodity excess only to cure the securities plus IBUKL deficit", () => {
    const result = calculateSegmentTransfer({
      securitiesCash: -30000,
      ibuklCash: 5000,
      commoditiesCash: 50000,
      commodityMaintenanceMargin: 10000,
    });

    expect(result.available).toBe(true);
    expect(result.combinedSecuritiesCash).toBe(-25000);
    expect(result.securitiesDeficit).toBe(25000);
    expect(result.commodityExcess).toBe(40000);
    expect(result.commodityTransfer).toBe(25000);
    expect(result.commodityExcessAfterTransfer).toBe(15000);
    expect(result.eligibleCashBeforeCollateral).toBe(0);
  });

  test("does not transfer commodity excess into a positive securities balance", () => {
    const result = calculateSegmentTransfer({
      securitiesCash: 1000,
      ibuklCash: 0,
      commoditiesCash: 50000,
      commodityMaintenanceMargin: 10000,
    });

    expect(result.commodityTransfer).toBe(0);
    expect(result.eligibleCashBeforeCollateral).toBe(1000);
  });

  test("does not treat a commodity deficit as a negative transfer", () => {
    const result = calculateSegmentTransfer({
      securitiesCash: -10000,
      commoditiesCash: 3000,
      commodityMaintenanceMargin: 5000,
    });

    expect(result.commodityExcess).toBe(0);
    expect(result.commodityTransfer).toBe(0);
    expect(result.eligibleCashBeforeCollateral).toBe(-10000);
  });

  test("adds verified event-contract value before subtracting matching commodity margin", () => {
    const result = calculateSegmentTransfer({
      securitiesCash: -2000,
      commoditiesCash: 1000,
      eventMarketValue: 1490,
      commodityMaintenanceMargin: 1490,
    });

    expect(result.available).toBe(true);
    expect(result.commodityExcess).toBe(1000);
    expect(result.commodityTransfer).toBe(1000);
    expect(result.eligibleCashBeforeCollateral).toBe(-1000);
  });

  test("accepts the legacy Kalshi market-value alias", () => {
    const result = calculateSegmentTransfer({
      securitiesCash: -2000,
      commoditiesCash: 1000,
      kalshiMarketValue: 1490,
      commodityMaintenanceMargin: 1490,
      commodityAvailableFunds: 728,
    });

    expect(result.available).toBe(true);
    expect(result.eventMarketValue).toBe(1490);
    expect(result.commodityExcessBeforeBrokerHoldback).toBe(1000);
    expect(result.commodityExcess).toBe(728);
    expect(result.commodityTransfer).toBe(728);
    expect(result.eligibleCashBeforeCollateral).toBe(-1272);
  });

  test("fails closed when nonzero commodities cash lacks maintenance margin", () => {
    const result = calculateSegmentTransfer({
      securitiesCash: -10000,
      commoditiesCash: 3000,
    });

    expect(result.available).toBe(false);
    expect(result.reasons).toContain(
      "commodity_margin_required_for_nonzero_commodities",
    );
    expect(result.commodityTransfer).toBeNull();
  });

  test("permits omitted commodity margin only for an explicit zero balance", () => {
    const result = calculateSegmentTransfer({
      securitiesCash: -10000,
      commoditiesCash: 0,
    });

    expect(result.available).toBe(true);
    expect(result.commodityMaintenanceMargin).toBe(0);
  });

  test("applies the 1.02 whole-dollar ceiling per share before multiplication", () => {
    const result = calculateUsdShortCollateral({
      currency: "USD",
      shortPositions: [
        {
          currency: "USD",
          quantity: -1000,
          priorClose: 1.01,
        },
        {
          currency: "USD",
          quantity: -10,
          priorClose: 100,
        },
      ],
    });

    expect(result.available).toBe(true);
    expect(result.positions[0]).toEqual(
      expect.objectContaining({
        collateralPrice: 2,
        collateral: 2000,
      }),
    );
    expect(result.positions[1]).toEqual(
      expect.objectContaining({
        collateralPrice: 102,
        collateral: 1020,
      }),
    );
    expect(result.collateral).toBe(3020);
  });

  test.each([
    [
      { currency: "EUR", shortPositions: [] },
      "unsupported_short_collateral_currency",
    ],
    [
      {
        currency: "USD",
        shortPositions: [{ currency: "USD", quantity: 10, priorClose: 20 }],
      },
      "invalid_short_position_0",
    ],
    [
      {
        currency: "USD",
        shortPositions: [{ currency: "USD", quantity: -10, priorClose: 0 }],
      },
      "invalid_short_position_0",
    ],
  ])("fails closed for invalid short collateral evidence", (input, reason) => {
    const result = calculateUsdShortCollateral(input);

    expect(result.available).toBe(false);
    expect(result.reasons).toContain(reason);
    expect(result.collateral).toBeNull();
  });
});

describe("tiered USD/360 interest", () => {
  test("rounds each tier once for the supplied multi-day accrual period", () => {
    const result = calculateTieredUsdInterest({
      currency: "USD",
      principal: 150000,
      accrualDays: 3,
      tiers: usdTiers,
      tiersVerified: true,
    });

    expect(result.available).toBe(true);
    expect(result.dayCount).toBe(INTEREST_DAY_COUNT);
    expect(result.tiers[0]).toEqual(
      expect.objectContaining({
        principal: 100000,
        interest: 60,
      }),
    );
    expect(result.tiers[1]).toEqual(
      expect.objectContaining({
        principal: 50000,
        interest: 25.83,
      }),
    );
    expect(result.interest).toBe(85.83);
  });

  test("sums independently rounded tiers instead of rounding only the total", () => {
    const result = calculateTieredUsdInterest({
      currency: "USD",
      principal: 36,
      accrualDays: 1,
      tiers: [
        { upTo: 18, annualRate: 0.1 },
        { upTo: null, annualRate: 0.1 },
      ],
      tiersVerified: true,
    });

    expect(result.tiers.map((tier) => tier.interest)).toEqual([0.01, 0.01]);
    expect(result.interest).toBe(0.02);
  });

  test.each([
    [{ tiersVerified: false }, "interest_tiers_not_verified"],
    [
      {
        tiers: [{ upTo: 100000, annualRate: 0.06 }],
      },
      "uncapped_terminal_interest_tier_required",
    ],
    [
      {
        tiers: [{ upTo: null, annualRate: 6 }],
      },
      "invalid_interest_tier_0",
    ],
    [{ accrualDays: 0 }, "invalid_accrual_days"],
  ])("fails closed on invalid tier inputs", (overrides, reason) => {
    const result = calculateTieredUsdInterest({
      currency: "USD",
      principal: 1000,
      accrualDays: 1,
      tiers: usdTiers,
      tiersVerified: true,
      ...overrides,
    });

    expect(result.available).toBe(false);
    expect(result.reasons).toContain(reason);
    expect(result.interest).toBeNull();
  });
});

describe("prospective calibration", () => {
  test("uses actual-minus-raw for median bias and actual-minus-issued-point for q95", () => {
    const result = calibrateProspectiveInterest({
      chronologicalOrderVerified: true,
      matches: [
        matchedPeriod({
          id: "a",
          accrualDays: 2,
          rawForecast: 10,
          issuedPointForecast: 11,
          actualInterest: 12,
        }),
        matchedPeriod({
          id: "b",
          accrualDays: 2,
          rawForecast: 10,
          issuedPointForecast: 13,
          actualInterest: 14,
        }),
      ],
    });

    expect(result.available).toBe(true);
    expect(result.biasPerDay).toBe(1.5);
    expect(result.q95UnderpredictionPerDay).toBe(0.5);
    expect(result.q95Rank).toBe(2);
  });

  test("underprediction errors are one-sided and never use overprediction as a credit", () => {
    const result = calibrateProspectiveInterest({
      chronologicalOrderVerified: true,
      matches: [
        matchedPeriod({
          issuedPointForecast: 12,
          actualInterest: 10,
        }),
      ],
    });

    expect(result.q95UnderpredictionPerDay).toBe(0);
  });

  test("caps calibration at the latest 90 matched prospective periods", () => {
    const oldOutliers = Array.from({ length: 5 }, (_, index) =>
      matchedPeriod({
        id: `old-${index}`,
        rawForecast: 0,
        issuedPointForecast: 0,
        actualInterest: 100,
      }),
    );
    const recent = Array.from({ length: 90 }, (_, index) =>
      matchedPeriod({
        id: `recent-${index}`,
        rawForecast: 0,
        issuedPointForecast: 0,
        actualInterest: 1,
      }),
    );

    const result = calibrateProspectiveInterest({
      chronologicalOrderVerified: true,
      matches: [...oldOutliers, ...recent],
    });

    expect(result.windowSize).toBe(CALIBRATION_WINDOW);
    expect(result.totalMatchCount).toBe(95);
    expect(result.sampleCount).toBe(90);
    expect(result.biasPerDay).toBe(1);
    expect(result.q95UnderpredictionPerDay).toBe(1);
    expect(result.matches[0].id).toBe("recent-0");
  });

  test("finite-sample q95 uses ceil((n+1)*.95), capped at n", () => {
    const twenty = calculateOneSidedQ95(
      Array.from({ length: 20 }, (_, index) => index + 1),
    );
    const forty = calculateOneSidedQ95(
      Array.from({ length: 40 }, (_, index) => index + 1),
    );

    expect(twenty.rank).toBe(20);
    expect(twenty.q95).toBe(20);
    expect(forty.rank).toBe(39);
    expect(forty.q95).toBe(39);
  });

  test.each([
    [{ prospective: false }, "invalid_calibration_match_0"],
    [{ verified: false }, "invalid_calibration_match_0"],
    [{ reconstructed: true }, "calibration_match_0_reconstructed"],
    [{ backfilled: true }, "calibration_match_0_backfilled"],
  ])(
    "rejects non-prospective or unsafe calibration history",
    (overrides, reason) => {
      const result = calibrateProspectiveInterest({
        chronologicalOrderVerified: true,
        matches: [matchedPeriod(overrides)],
      });

      expect(result.available).toBe(false);
      expect(result.reasons).toContain(reason);
    },
  );

  test("does not guess which matches are most recent", () => {
    const result = calibrateProspectiveInterest({
      matches: [matchedPeriod()],
    });

    expect(result.available).toBe(false);
    expect(result.reason).toBe("calibration_order_not_verified");
  });
});

describe("graduated cushion and validation status", () => {
  test.each([
    {
      name: "0-4 provisional",
      input: {
        point: 2,
        accrualDays: 2,
        sampleCount: 0,
        q95UnderpredictionPerDay: null,
        monthlyReconciled: false,
      },
      status: "Provisional",
      band: "0-4",
      cushion: 1,
    },
    {
      name: "0-4 learning",
      input: {
        point: 8,
        accrualDays: 2,
        sampleCount: 4,
        q95UnderpredictionPerDay: 0.2,
        monthlyReconciled: false,
      },
      status: "Learning",
      band: "0-4",
      cushion: 2,
    },
    {
      name: "5-14 learning",
      input: {
        point: 10,
        accrualDays: 2,
        sampleCount: 5,
        q95UnderpredictionPerDay: 0.2,
        monthlyReconciled: false,
      },
      status: "Learning",
      band: "5-14",
      cushion: 1.5,
    },
    {
      name: "15-29 learning",
      input: {
        point: 10,
        accrualDays: 2,
        sampleCount: 15,
        q95UnderpredictionPerDay: 0.2,
        monthlyReconciled: false,
      },
      status: "Learning",
      band: "15-29",
      cushion: 0.5,
    },
    {
      name: "30+ remains learning before reconciliation",
      input: {
        point: 10,
        accrualDays: 2,
        sampleCount: 30,
        q95UnderpredictionPerDay: 0.2,
        monthlyReconciled: false,
      },
      status: "Learning",
      band: "learning_30_plus",
      cushion: 0.5,
    },
    {
      name: "validated",
      input: {
        point: 10,
        accrualDays: 2,
        sampleCount: 30,
        q95UnderpredictionPerDay: 0.2,
        monthlyReconciled: true,
      },
      status: "Validated",
      band: "validated",
      cushion: 0.4,
    },
  ])("$name", ({ input, status, band, cushion }) => {
    const result = calculateForecastCushion(input);

    expect(result.available).toBe(true);
    expect(result.validationStatus).toBe(status);
    expect(result.band).toBe(band);
    expect(result.cushion).toBe(cushion);
  });

  test("rounds a selected cushion upward to avoid understating the bracket", () => {
    const result = calculateForecastCushion({
      point: 0,
      accrualDays: 3,
      sampleCount: 30,
      q95UnderpredictionPerDay: 0.011,
      monthlyReconciled: true,
    });

    expect(result.cushion).toBe(0.04);
  });
});

describe("end-to-end interest forecast", () => {
  test("keeps fully margined event-contract value at zero incremental capacity", () => {
    const result = forecastIbkrDebitInterest(forecastInput({
      positionScope: "stocks_and_event_contracts",
      accrualPeriods: [{
        id: "event-mixed",
        accrualDays: 1,
        securitiesCash: -15000,
        commoditiesCash: 1000,
        eventMarketValue: 1490,
        commodityMaintenanceMargin: 1490,
        eventAccountingVerified: true,
        shortPositions: [],
      }],
    }));

    expect(result.available).toBe(true);
    expect(result.positionScope).toBe("stocks_and_event_contracts");
    expect(result.principal).toBe(14000);
    expect(result.segmentDetails[0]).toEqual(expect.objectContaining({
      eventMarketValue: 1490,
      commodityExcess: 1000,
      commodityTransfer: 1000,
    }));
  });

  test("fails mixed-scope forecasts without reconciled event accounting", () => {
    const result = forecastIbkrDebitInterest(forecastInput({
      positionScope: "stocks_and_event_contracts",
    }));

    expect(result.available).toBe(false);
    expect(result.reasons).toContain("event_accounting_not_verified");
  });

  test("normalizes the legacy Kalshi scope and market-value input", () => {
    const result = forecastIbkrDebitInterest(forecastInput({
      positionScope: "stocks_and_kalshi",
      accrualPeriods: [{
        id: "legacy-kalshi",
        accrualDays: 1,
        securitiesCash: -15000,
        commoditiesCash: 1000,
        kalshiMarketValue: 1490,
        commodityMaintenanceMargin: 1490,
        eventAccountingVerified: true,
        shortPositions: [],
      }],
    }));

    expect(result.available).toBe(true);
    expect(result.positionScope).toBe("stocks_and_event_contracts");
    expect(result.segmentDetails[0]).toEqual(expect.objectContaining({
      eventMarketValue: 1490,
      kalshiMarketValue: 1490,
    }));
  });

  test("returns decision-complete raw, point, upper, principal, collateral, and segment details", () => {
    const result = forecastIbkrDebitInterest(forecastInput());

    expect(result.available).toBe(true);
    expect(result.status).toBe("Provisional");
    expect(result.principal).toBe(85200);
    expect(result.collateral).toBe(5200);
    expect(result.accrualDays).toBe(3);
    expect(result.raw).toBe(42.6);
    expect(result.point).toBe(42.6);
    expect(result.cushion).toBe(10.65);
    expect(result.upper).toBe(53.25);
    expect(result.sampleCount).toBe(0);
    expect(result.segmentDetails).toHaveLength(1);
    expect(result.segmentDetails[0]).toEqual(
      expect.objectContaining({
        combinedSecuritiesCash: -100000,
        commodityExcess: 20000,
        commodityTransfer: 20000,
        eligibleCashBeforeCollateral: -80000,
        collateral: 5200,
        adjustedCash: -85200,
        principal: 85200,
        rawInterest: 42.6,
      }),
    );
  });

  test("adds rolling median per-day bias to the raw forecast before the upper cushion", () => {
    const result = forecastIbkrDebitInterest(
      forecastInput({
        calibration: {
          chronologicalOrderVerified: true,
          monthlyReconciled: false,
          matches: [
            matchedPeriod({
              id: "a",
              accrualDays: 2,
              rawForecast: 10,
              issuedPointForecast: 11,
              actualInterest: 12,
            }),
            matchedPeriod({
              id: "b",
              accrualDays: 2,
              rawForecast: 10,
              issuedPointForecast: 13,
              actualInterest: 14,
            }),
          ],
        },
      }),
    );

    expect(result.raw).toBe(42.6);
    expect(result.biasPerDay).toBe(1.5);
    expect(result.point).toBe(47.1);
    expect(result.q95UnderpredictionPerDay).toBe(0.5);
    expect(result.status).toBe("Learning");
    expect(result.cushion).toBe(11.78);
    expect(result.upper).toBe(58.88);
  });

  test("sums separately rounded periods and supports a verified rate change", () => {
    const result = forecastIbkrDebitInterest(
      forecastInput({
        tiers: [{ upTo: null, annualRate: 0.06 }],
        accrualPeriods: [
          {
            id: "day-one",
            accrualDays: 1,
            securitiesCash: -36000,
            commoditiesCash: 0,
            shortPositions: [],
          },
          {
            id: "days-two-three",
            accrualDays: 2,
            securitiesCash: -72000,
            commoditiesCash: 0,
            shortPositions: [],
            tiers: [{ upTo: null, annualRate: 0.05 }],
            tiersVerified: true,
          },
        ],
      }),
    );

    expect(result.available).toBe(true);
    expect(result.segmentDetails.map((period) => period.rawInterest)).toEqual([
      6, 20,
    ]);
    expect(result.raw).toBe(26);
    expect(result.accrualDays).toBe(3);
    expect(result.principal).toBe(72000);
    expect(result.collateral).toBe(0);
  });

  test("never lets a negative learned bias create a negative point forecast", () => {
    const result = forecastIbkrDebitInterest(
      forecastInput({
        accrualPeriods: [
          {
            accrualDays: 1,
            securitiesCash: -60,
            commoditiesCash: 0,
            shortPositions: [],
          },
        ],
        calibration: {
          chronologicalOrderVerified: true,
          monthlyReconciled: false,
          matches: [
            matchedPeriod({
              rawForecast: 10,
              issuedPointForecast: 10,
              actualInterest: 0,
            }),
          ],
        },
      }),
    );

    expect(result.raw).toBe(0.01);
    expect(result.biasPerDay).toBe(-10);
    expect(result.point).toBe(0);
    expect(result.upper).toBe(1);
  });

  test.each([
    [{ accountInputsVerified: false }, "account_inputs_not_verified"],
    [{ stale: true }, "account_inputs_stale"],
    [{ fromCache: true }, "account_inputs_fromCache"],
    [{ mock: true }, "account_inputs_mock"],
    [{ tiersVerified: false }, "interest_tiers_not_verified"],
  ])("fails closed for unavailable or unsafe evidence", (overrides, reason) => {
    const input = forecastInput(overrides);
    const validation = validateInterestForecastInput(input);
    const result = forecastIbkrDebitInterest(input);

    expect(validation.valid).toBe(false);
    expect(validation.reasons).toContain(reason);
    expect(result.available).toBe(false);
    expect(result.reasons).toContain(reason);
    expect(result.raw).toBeNull();
    expect(result.point).toBeNull();
    expect(result.upper).toBeNull();
    expect(result.segmentDetails).toEqual([]);
  });

  test("fails the entire forecast instead of silently dropping an invalid period", () => {
    const input = forecastInput({
      accrualPeriods: [
        forecastInput().accrualPeriods[0],
        {
          accrualDays: 1,
          securitiesCash: -100,
          commoditiesCash: 10,
          shortPositions: [],
        },
      ],
    });
    const result = forecastIbkrDebitInterest(input);
    const validation = validateInterestForecastInput(input);

    expect(result.available).toBe(false);
    expect(result.reasons).toContain(
      "accrual_period_1_commodity_margin_required_for_nonzero_commodities",
    );
    expect(result.raw).toBeNull();
    expect(validation.valid).toBe(false);
    expect(validation.reasons).toContain(
      "accrual_period_1_commodity_margin_required_for_nonzero_commodities",
    );
  });
});

describe("interest guard reserve", () => {
  function guardInput(overrides = {}) {
    return {
      liveAccruedCash: -15,
      liveAccruedVerified: true,
      verifiedUnpaidDebit: 9,
      unpaidDebitVerified: true,
      unreportedUpper: 4,
      unreportedUpperVerified: true,
      ...overrides,
    };
  }

  test("uses the larger live debit without adding it to the ledger candidate", () => {
    const result = calculateInterestGuardReserve(guardInput());

    expect(result.reserve).toBe(15);
    expect(result.liveNegativeAccrued).toBe(15);
    expect(result.unpaidPlusUnreportedUpper).toBe(13);
    expect(result.selectedCandidate).toBe("live_negative_accrued");
    expect(result.doubleCountedLiveAccrued).toBe(0);
  });

  test("uses verified unpaid debit plus unreported upper when larger", () => {
    const result = calculateInterestGuardReserve(
      guardInput({
        liveAccruedCash: -10,
      }),
    );

    expect(result.reserve).toBe(13);
    expect(result.selectedCandidate).toBe(
      "verified_unpaid_plus_unreported_upper",
    );
  });

  test("excludes a positive live credit instead of netting it against debits", () => {
    const result = calculateInterestGuardReserve(
      guardInput({
        liveAccruedCash: 8,
      }),
    );

    expect(result.liveNegativeAccrued).toBe(0);
    expect(result.positiveAccruedCreditExcluded).toBe(8);
    expect(result.reserve).toBe(13);
    expect(result.positiveCreditsApplied).toBe(0);
  });

  test.each([
    [{ liveAccruedVerified: false }, "live_accrued_not_verified"],
    [{ unpaidDebitVerified: false }, "unpaid_debit_not_verified"],
    [{ unreportedUpperVerified: false }, "unreported_upper_not_verified"],
    [{ verifiedUnpaidDebit: -1 }, "invalid_verified_unpaid_debit"],
  ])(
    "fails closed without verified nonnegative reserve inputs",
    (overrides, reason) => {
      const result = calculateInterestGuardReserve(guardInput(overrides));

      expect(result.available).toBe(false);
      expect(result.reasons).toContain(reason);
      expect(result.reserve).toBeNull();
    },
  );

  test("composes the forecast upper directly into the guard decision", () => {
    const result = buildIbkrInterestDecision({
      forecast: forecastInput(),
      guard: {
        liveAccruedCash: -60,
        liveAccruedVerified: true,
        verifiedUnpaidDebit: 10,
        unpaidDebitVerified: true,
      },
    });

    expect(result.available).toBe(true);
    expect(result.forecast.upper).toBe(53.25);
    expect(result.guard.unreportedUpper).toBe(53.25);
    expect(result.guardReserve).toBe(63.25);
  });

  test("does not allow callers to override the forecast upper in composition", () => {
    const result = buildIbkrInterestDecision({
      forecast: forecastInput(),
      guard: {
        liveAccruedCash: -60,
        liveAccruedVerified: true,
        verifiedUnpaidDebit: 10,
        unpaidDebitVerified: true,
        unreportedUpper: 0,
      },
    });

    expect(result.available).toBe(false);
    expect(result.reason).toBe(
      "guard_unreported_upper_must_come_from_forecast",
    );
  });
});
