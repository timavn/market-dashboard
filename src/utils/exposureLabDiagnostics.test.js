const {
  buildExposureLabDiagnostics,
  buildGeographyAllocation,
  buildSectorFit,
  buildUnifiedCorrelation,
  classifyExposureLabPortfolioInput,
  correlationCell,
  minimumObservations,
  normalizePortfolioPositions,
} = require('./exposureLabDiagnostics.cjs');

function barsFromReturns(returns, start = '2025-01-01') {
  let price = 100;
  const startTime = new Date(`${start}T00:00:00.000Z`).getTime();
  const bars = [{ date: start, adjustedClose: price, close: price }];
  returns.forEach((value, index) => {
    price *= 1 + value;
    const date = new Date(startTime + (index + 1) * 86_400_000).toISOString().slice(0, 10);
    bars.push({ date, adjustedClose: price, close: price });
  });
  return bars;
}

function wave(length, phase = 0) {
  return Array.from({ length }, (_, index) => (
    Math.sin((index + phase) / 5) * 0.008
    + Math.cos((index + phase) / 13) * 0.003
  ));
}

describe('Exposure Lab unified correlation', () => {
  const base = wave(190);
  const second = base.map((value, index) => value + Math.sin(index / 3) * 0.0002);
  const factorDefinitions = [
    { id: 'market', label: 'Market', family: 'Market', longSymbol: 'SPY' },
    { id: 'spread', label: 'Spread', family: 'Style', longSymbol: 'IWD', shortSymbol: 'IWF' },
  ];
  const histories = {
    AAA: barsFromReturns(base),
    BBB: barsFromReturns(base),
    CCC: barsFromReturns(second),
    SPY: barsFromReturns(base),
    IWD: barsFromReturns(second),
    IWF: barsFromReturns(base.map((value) => value * 0.2)),
  };

  test('uses the 80% observation gate for every supported window', () => {
    expect(minimumObservations(30)).toBe(24);
    expect(minimumObservations(90)).toBe(72);
    expect(minimumObservations(180)).toBe(144);

    const shortSeries = wave(23).map((value, index) => ({
      date: `2025-02-${String(index + 1).padStart(2, '0')}`,
      value,
    }));
    const cell = correlationCell(shortSeries, shortSeries, 30);
    expect(cell).toEqual(expect.objectContaining({
      value: null,
      observations: 23,
      reason: 'insufficient_aligned_observations',
    }));
  });

  test('is symmetric, preserves diagonals, and sign-flips short P&L correlations', () => {
    const snapshot = buildUnifiedCorrelation({
      holdings: [
        { symbol: 'AAA', description: 'Alpha', marketValue: 400_000, quantity: 100 },
        { symbol: 'BBB', description: 'Beta short', marketValue: -300_000, quantity: -50 },
        { symbol: 'CCC', description: 'Charlie', marketValue: 200_000, quantity: 80 },
      ],
      totalValue: 1_000_000,
      histories,
      factorDefinitions,
    });
    const pp = snapshot.modes.positionPosition.matrices['90'];
    const pf = snapshot.modes.positionFactor.matrices['90'];
    const ff = snapshot.modes.factorFactor.matrices['90'];
    const symbols = snapshot.modes.positionPosition.rowAxis.map((row) => row.symbol);
    const aaa = symbols.indexOf('AAA');
    const bbb = symbols.indexOf('BBB');

    expect(pp.values[aaa][aaa]).toBe(1);
    expect(pp.values[bbb][bbb]).toBe(1);
    expect(pp.values[aaa][bbb]).toBe(-1);
    expect(pp.values[aaa][bbb]).toBe(pp.values[bbb][aaa]);
    expect(pp.rawValues[aaa][bbb]).toBe(1);
    expect(pf.values[bbb][0]).toBe(-1);
    expect(pf.rawValues[bbb][0]).toBe(1);
    expect(ff.values[0][0]).toBe(1);
    expect(Object.keys(snapshot.modes.positionPosition.matrices)).toEqual(['30', '90', '180']);
    expect(snapshot.modes.positionPosition.matrices['30'].observations[aaa][aaa]).toBe(30);
    expect(snapshot.modes.positionPosition.matrices['180'].observations[aaa][aaa]).toBe(180);
    expect(snapshot.pairs.offsets[0]).toEqual(expect.objectContaining({
      pnlCorrelation: -1,
      rawCorrelation: 1,
    }));
    const recent = base.slice(-90);
    const mean = recent.reduce((sum, value) => sum + value, 0) / recent.length;
    const sampleVariance = recent.reduce((sum, value) => sum + (value - mean) ** 2, 0)
      / (recent.length - 1);
    const expectedPairRisk = 2 * 0.4 * 0.3 * (-sampleVariance * 0.8 * 252) * 10_000;
    expect(snapshot.pairs.offsets.find((pair) => pair.right.symbol === 'BBB')
      .annualizedVarianceContributionPct2).toBeCloseTo(expectedPairRisk, 4);
    expect(snapshot.pairs.commonRisk.length).toBeGreaterThan(0);
    expect(snapshot.methodology.clustersInferred).toBe(false);
  });

  test('renders missing and zero-variance histories as reasoned empty cells', () => {
    const snapshot = buildUnifiedCorrelation({
      holdings: [
        { symbol: 'AAA', marketValue: 100_000 },
        { symbol: 'ZERO', marketValue: 90_000 },
        { symbol: 'MISS', marketValue: 80_000 },
      ],
      totalValue: 1_000_000,
      histories: {
        ...histories,
        ZERO: barsFromReturns(Array(190).fill(0)),
      },
      factorDefinitions,
    });
    const matrix = snapshot.modes.positionPosition.matrices['90'];
    const symbols = snapshot.modes.positionPosition.rowAxis.map((row) => row.symbol);
    const zero = symbols.indexOf('ZERO');
    const miss = symbols.indexOf('MISS');
    expect(matrix.values[zero][zero]).toBeNull();
    expect(matrix.reasons[zero][zero]).toBe('zero_variance');
    expect(matrix.values[miss][miss]).toBeNull();
    expect(matrix.reasons[miss][miss]).toBe('history_unavailable');
  });

  test('aggregates duplicate symbols deterministically before weighting pairs', () => {
    const rows = normalizePortfolioPositions([
      { symbol: 'BBB', marketValue: -50, quantity: -5 },
      { symbol: 'AAA', marketValue: 100, quantity: 10 },
      { symbol: 'AAA', marketValue: -25, quantity: -2 },
    ], 1_000);
    expect(rows.map((row) => row.symbol)).toEqual(['AAA', 'BBB']);
    expect(rows[0]).toEqual(expect.objectContaining({
      marketValue: 75,
      grossMarketValue: 125,
      signedWeightPct: 7.5,
      grossWeightPct: 12.5,
      holdingCount: 2,
    }));
  });

  test('bounds lifetime histories before building the full 75-position matrix', () => {
    const longBars = barsFromReturns(wave(4_000), '2010-01-01');
    const holdings = Array.from({ length: 75 }, (_, index) => ({
      symbol: `P${String(index).padStart(2, '0')}`,
      marketValue: 10_000 - index,
    }));
    const longHistories = Object.fromEntries([
      ...holdings.map((holding) => [holding.symbol, longBars]),
      ['SPY', longBars],
    ]);

    const snapshot = buildUnifiedCorrelation({
      holdings,
      totalValue: 1_000_000,
      histories: longHistories,
      factorDefinitions: [
        { id: 'market', label: 'Market', family: 'Market', longSymbol: 'SPY' },
      ],
    });

    expect(snapshot.modes.positionPosition.rowAxis).toHaveLength(75);
    expect(snapshot.coverage.positionsWithQualifiedHistory).toBe(75);
    expect(snapshot.modes.positionPosition.matrices['180'].observations[0][74]).toBe(180);
  }, 10_000);

  test.each([
    ['disconnected', { dataSource: 'ibkr_api', liveSessionVerified: false, fromCache: false, summary: { totalValue: 1_000 } }],
    ['cached', { dataSource: 'ibkr_api', liveSessionVerified: true, fromCache: true, summary: { totalValue: 1_000 } }],
    ['mock', { dataSource: 'mock', liveSessionVerified: true, fromCache: false, summary: { totalValue: 1_000 } }],
    ['seed', { dataSource: 'ibkr_api', liveSessionVerified: true, fromCache: false, seeded: true, summary: { totalValue: 1_000 } }],
    ['failed NLV', { dataSource: 'ibkr_api', liveSessionVerified: true, fromCache: false, summary: { totalValue: null } }],
  ])('rejects %s portfolio inputs before any matrix can be retained', (_label, portfolio) => {
    expect(classifyExposureLabPortfolioInput(portfolio).verified).toBe(false);
  });

  test('accepts fresh socket identity/NLV with either live or verified reference marks', () => {
    expect(classifyExposureLabPortfolioInput({
      dataSource: 'ibkr_api',
      liveSessionVerified: true,
      fromCache: false,
      summary: { totalValue: 1_000 },
      dataQuality: { status: 'stale', markState: 'reference' },
    })).toEqual({ verified: true, reason: null });
  });
});

describe('Exposure Lab geography', () => {
  const base = wave(190);
  const market = wave(190, 7);
  const local = wave(190, 19).map((value) => value * 0.25);
  const target = market.map((value, index) => 0.8 * value + local[index]);
  const proxy = market.map((value, index) => 1.2 * value + local[index]);
  const reviews = [
    {
      ticker: 'AAA',
      canonicalSymbol: 'AAA',
      identityStatus: 'verified',
      instrumentType: 'STK',
      geography: {
        basis: 'country_of_risk',
        allocations: [{ countryCode: 'US', weightPct: 100 }],
        sourceName: 'Issuer filing',
        sourceAsOf: '2025-06-30',
        sourceUrl: 'https://example.com/aaa',
      },
    },
    {
      ticker: 'FUND',
      canonicalSymbol: 'FUND',
      identityStatus: 'verified',
      instrumentType: 'ETF',
      geography: {
        basis: 'holdings_lookthrough',
        allocations: [
          { countryCode: 'GB', weightPct: 50 },
          { countryCode: 'JP', weightPct: 50 },
        ],
        sourceName: 'Fund holdings',
        sourceAsOf: '2025-08-01',
      },
    },
  ];

  test('aggregates country and region Net/Long/Short/Gross with Unknown coverage', () => {
    const allocation = buildGeographyAllocation({
      holdings: [
        { symbol: 'AAA', marketValue: 500_000 },
        { symbol: 'FUND', marketValue: -250_000 },
        { symbol: 'NEW', marketValue: 100_000 },
      ],
      totalValue: 1_000_000,
      securityReviews: reviews,
      securityMasterAvailable: true,
      now: new Date('2025-08-15T00:00:00Z'),
    });
    const row = (id) => {
      const index = allocation.country.rowAxis.findIndex((axis) => axis.id === id);
      return allocation.country.values[index];
    };
    expect(row('US')).toEqual([50, 50, 0, 50]);
    expect(row('GB')).toEqual([-12.5, 0, -12.5, 12.5]);
    expect(row('JP')).toEqual([-12.5, 0, -12.5, 12.5]);
    expect(row('Unknown')).toEqual([10, 10, 0, 10]);
    expect(allocation.coverage).toEqual(expect.objectContaining({
      knownGrossNavPct: 75,
      unknownGrossNavPct: 10,
      knownGrossCoveragePct: 88.24,
    }));
    expect(allocation.status).toBe('partial');
  });

  test('expires holdings look-through after 120 days but not country of risk', () => {
    const allocation = buildGeographyAllocation({
      holdings: [
        { symbol: 'AAA', marketValue: 500_000 },
        { symbol: 'FUND', marketValue: -250_000 },
      ],
      totalValue: 1_000_000,
      securityReviews: reviews,
      now: new Date('2025-12-01T00:00:00Z'),
    });
    expect(allocation.positions.find((row) => row.symbol === 'AAA').available).toBe(true);
    expect(allocation.positions.find((row) => row.symbol === 'FUND')).toEqual(expect.objectContaining({
      available: false,
      reason: 'holdings_lookthrough_stale',
    }));
    expect(allocation.country.rowAxis.some((row) => row.id === 'US')).toBe(true);
    expect(allocation.country.rowAxis.some((row) => row.id === 'Unknown')).toBe(true);
  });

  test('preserves leverage and duplicate-symbol long/short arithmetic', () => {
    const allocation = buildGeographyAllocation({
      holdings: [
        { symbol: 'AAA', marketValue: 700_000 },
        { symbol: 'AAA', marketValue: 500_000 },
        { symbol: 'FUND', marketValue: -400_000 },
      ],
      totalValue: 1_000_000,
      securityReviews: reviews,
      now: new Date('2025-08-15T00:00:00Z'),
    });
    const aaa = allocation.positions.find((row) => row.symbol === 'AAA');
    const countryRow = (id) => allocation.country.values[
      allocation.country.rowAxis.findIndex((row) => row.id === id)
    ];
    expect(aaa).toEqual(expect.objectContaining({
      signedWeightPct: 120,
      grossWeightPct: 120,
    }));
    expect(countryRow('US')).toEqual([120, 120, 0, 120]);
    expect(countryRow('GB')).toEqual([-20, 0, -20, 20]);
    expect(countryRow('JP')).toEqual([-20, 0, -20, 20]);
    expect(allocation.coverage.totalGrossNavPct).toBe(160);
  });

  test('clears allocation to Unknown when the security master is unavailable', () => {
    const allocation = buildGeographyAllocation({
      holdings: [{ symbol: 'AAA', marketValue: 500_000 }],
      totalValue: 1_000_000,
      securityReviews: reviews,
      securityMasterAvailable: false,
    });
    expect(allocation.status).toBe('unavailable');
    expect(allocation.reason).toBe('security_master_unavailable');
    expect(allocation.country.values.at(-1)).toEqual([50, 50, 0, 50]);
  });

  test('keeps unsupported instruments visible in allocation Unknown coverage', () => {
    const snapshot = buildExposureLabDiagnostics({
      holdings: [{ symbol: 'AAA', marketValue: 500_000 }],
      allocationHoldings: [
        { symbol: 'AAA', marketValue: 500_000, secType: 'STK' },
        { symbol: 'AAA CALL', marketValue: 50_000, secType: 'OPT' },
        { symbol: 'USD', marketValue: 25_000, secType: 'CASH' },
      ],
      totalValue: 1_000_000,
      securityReviews: reviews,
      histories: {},
      now: new Date('2025-08-15T00:00:00Z'),
    });
    expect(snapshot.geography.allocation.positions.map((row) => row.symbol)).toEqual([
      'AAA', 'AAA CALL', 'USD',
    ]);
    expect(snapshot.geography.allocation.coverage.unknownGrossNavPct).toBe(7.5);
  });

  test('de-markets position and proxy returns against ACWI and includes a portfolio row', () => {
    const histories = {
      AAA: barsFromReturns(target),
      ACWI: barsFromReturns(market),
      SPY: barsFromReturns(proxy),
      EWC: barsFromReturns(base),
      VGK: barsFromReturns(base),
      EWJ: barsFromReturns(base),
      AAXJ: barsFromReturns(base),
      MCHI: barsFromReturns(base),
      INDA: barsFromReturns(base),
      ILF: barsFromReturns(base),
      EEM: barsFromReturns(base),
    };
    const snapshot = buildExposureLabDiagnostics({
      holdings: [{ symbol: 'AAA', marketValue: 500_000 }],
      totalValue: 1_000_000,
      histories,
      securityReviews: reviews,
    });
    const sensitivity = snapshot.geography.sensitivity;
    const matrix = sensitivity.matrices['90'];
    expect(sensitivity.rowAxis[0].id).toBe('portfolio');
    expect(sensitivity.columnAxis[0]).toEqual(expect.objectContaining({ symbol: 'SPY' }));
    expect(matrix.values[0][0]).toBeGreaterThan(0.95);
    expect(matrix.values[1][0]).toBeGreaterThan(0.95);
    expect(sensitivity.coverageByWindow['90']).toEqual(expect.objectContaining({
      modeledGrossNavPct: 50,
      modeledGrossCoveragePct: 100,
    }));
    expect(sensitivity.methodology.interpretation).toContain('non-additive');
  });
});

describe('Exposure Lab sector fit', () => {
  const noise = (length, seed) => Array.from({ length }, (_, index) => Math.sin((index * seed) % 7.3) * 0.004);
  const mix = (left, right, share) => left.map((value, index) => value * share + right[index] * (1 - share));
  const industrials = wave(200, 0);
  const discretionary = wave(200, 40).map((value, index) => value + noise(200, 3.1)[index]);
  const histories = {
    XLI: barsFromReturns(industrials),
    XLY: barsFromReturns(discretionary),
    SAIA: barsFromReturns(mix(industrials, noise(200, 1.7), 0.8)),
    // Filed under industrials but moving with discretionary.
    ODD: barsFromReturns(mix(discretionary, noise(200, 2.3), 0.9)),
    NEW: barsFromReturns(wave(10)),
  };

  it('measures each stock against its assigned sector ETF on every window', () => {
    const fit = buildSectorFit({ assignments: [{ symbol: 'saia', etf: 'XLI' }], histories, sectorEtfs: ['XLI', 'XLY'] });
    const [row] = fit.rows;
    expect(row.symbol).toBe('SAIA');
    expect(Object.keys(row.correlations)).toEqual(['30', '90', '180']);
    expect(row.correlations['90'].value).toBeGreaterThan(0.7);
    expect(row.correlations['90'].observations).toBe(90);
    expect(row.best.etf).toBe('XLI');
    expect(row.review).toBe(false);
  });

  it('reports a better-fitting sector for review without reassigning', () => {
    const [row] = buildSectorFit({ assignments: [{ symbol: 'ODD', etf: 'XLI' }], histories, sectorEtfs: ['XLI', 'XLY'] }).rows;
    expect(row.etf).toBe('XLI');
    expect(row.best.etf).toBe('XLY');
    expect(row.review).toBe(true);
  });

  it('leaves short histories and unknown sector ETFs unmeasured', () => {
    const fit = buildSectorFit({
      assignments: [{ symbol: 'NEW', etf: 'XLI' }, { symbol: 'SAIA', etf: 'SPY' }], histories, sectorEtfs: ['XLI', 'XLY'],
    });
    expect(fit.rows.map((row) => row.symbol)).toEqual(['NEW']);
    expect(fit.rows[0].correlations['90'].value).toBeNull();
    expect(fit.rows[0].best).toBeNull();
    expect(fit.rows[0].review).toBe(false);
  });
});
