const { createCardView } = require('./cardView.cjs');

function points(count, start = Date.parse('2026-08-19T00:00:00.000Z')) {
  return Array.from({ length: count }, (_, index) => ({ timestamp: start + index * 60_000, value: 100 + index / 100 }));
}

describe('compact prediction card view', () => {
  test('preserves direct perpetual identity while keeping the unavailable binary resolver separate', () => {
    const spot = { status: 'available', value: 76500, source: 'kalshi_perpetual_public_trades',
      asOf: '2026-09-15T16:15:00.000Z', expiresAt: '2026-09-15T16:16:00.000Z' };
    const chart = { status: 'available', source: 'kalshi_perpetual_public_candles',
      referenceKind: 'perpetual_contract', points: points(500), fit: 'exact' };
    const perpetualReference = { referenceKind: 'perpetual_contract', fit: 'exact',
      instrument: { ticker: 'KXBTCPERP', priceUnit: 'USD/BTC' }, spot, chart };
    const binarySpot = { status: 'unavailable', value: null, source: null };
    const snapshot = {
      marketId: 'bitcoin', spot, chart, perpetualReference,
      chartReferences: { basis: { ...perpetualReference, role: 'basis', symbol: 'BTC' } },
      resolverReference: { spot: binarySpot, lastVerifiedSpot: { value: 76500 }, fit: 'exact' },
      proxyFit: { status: 'available' },
      contracts: { status: 'available', lines: Array.from({ length: 20 }, (_, index) => ({
        ticker: `BTC-${index}`, threshold: 75000 + index * 100, openInterest: index,
      })) },
    };
    const card = createCardView(snapshot);
    expect(card).toMatchObject({ cardView: true,
      perpetualReference: { referenceKind: 'perpetual_contract', instrument: { ticker: 'KXBTCPERP', priceUnit: 'USD/BTC' }, spot },
      resolverReference: { spot: binarySpot }, proxyFit: null,
    });
    expect(Object.keys(card.chartReferences)).toEqual(['basis']);
    expect(card.chart.points).toHaveLength(220);
    expect(card.chartReferences.basis.chart.points).toHaveLength(220);
    expect(card.contracts.ladderSelection.referenceValue).toBeNull();
    expect(card.contracts.lines.map((line) => line.ticker)).toEqual(
      Array.from({ length: 10 }, (_, index) => `BTC-${index + 10}`),
    );
    expect(createCardView({ ...snapshot, resolverReference: { fit: 'exact' } }).resolverReference.spot).toBeNull();
  });

  test('compacts independent basis and contract references without changing their identities', () => {
    const variant = (range, start) => ({
      status: 'available', availability: 'live', range, source: 'ibkr_historical_bars',
      asOf: '2026-08-29T20:00:00.000Z', expiresAt: '2026-08-29T21:00:00.000Z',
      points: points(12, start), dailyRanges: [], references: [], fit: 'exact', executable: false,
    });
    const basisOneDay = variant('1d', Date.parse('2026-08-29T13:30:00.000Z'));
    basisOneDay.sessionMode = 'last_complete';
    basisOneDay.sessionDate = '2026-08-28';
    const contractOneDay = {
      ...variant('1d', Date.parse('2026-08-29T13:30:00.000Z')),
      points: points(12, Date.parse('2026-08-29T13:30:00.000Z'))
        .map((point) => ({ ...point, value: point.value + 12 })),
    };
    const chartReferences = {
      basis: {
        role: 'risk_range_basis', symbol: 'SPX', riskRangeTicker: 'SPX', exact: true,
        instrument: { symbol: 'SPX', displaySymbol: 'SPX', conId: 416904, provider: 'ibkr' },
        spot: { status: 'available', value: 7634 }, chart: basisOneDay,
        freshness: { status: 'verified_live' },
      },
      contract: {
        role: 'contract_reference', symbol: 'ESU26', riskRangeTicker: 'SPX', exact: true,
        instrument: { symbol: 'ES', displaySymbol: 'ESU26', conId: 12345, provider: 'ibkr' },
        spot: { status: 'available', value: 7648 }, chart: contractOneDay,
        freshness: { status: 'verified_live' }, disclosure: 'Raw dated ES reference.',
      },
    };

    const card = createCardView({
      schemaVersion: 2, marketId: 'sp500', chart: basisOneDay,
      chartReferences, resolverReference: { ...chartReferences.contract, chartReferences },
      contracts: { status: 'unavailable', event: null, lines: [] }, venues: {},
    });

    expect(card.chartReferences).toMatchObject({
      basis: { role: 'risk_range_basis', symbol: 'SPX', spot: { value: 7634 } },
      contract: {
        role: 'contract_reference', symbol: 'ESU26', spot: { value: 7648 },
        disclosure: 'Raw dated ES reference.',
      },
    });
    expect(card.chartReferences.basis.chart.points).toHaveLength(12);
    expect(card.chartReferences.contract.chart.points).toHaveLength(12);
    expect(card.chartReferences.contract.chart.points[0].value
      - card.chartReferences.basis.chart.points[0].value).toBe(12);
    expect(card.chartReferences.basis.chart).toMatchObject({
      sessionMode: 'last_complete', sessionDate: '2026-08-28',
    });
  });

  test('keeps every range display-ready while bounding the uncompressed response below 200 KB', () => {
    const variant = (range, count) => ({
      status: 'available', availability: 'live', range, source: 'ibkr_historical_bars',
      asOf: '2026-08-29T20:00:00.000Z', expiresAt: '2026-08-29T21:00:00.000Z',
      points: points(count), dailyRanges: [], references: [], fit: 'proxy', executable: false,
    });
    const oneDay = variant('1d', 5_000);
    const contracts = {
      status: 'available', event: { ticker: 'TEST', closeTime: '2026-08-30T20:00:00.000Z' },
      lines: Array.from({ length: 200 }, (_, index) => ({
        ticker: `TEST-${index}`,
        threshold: index,
        yesBid: 0.4,
        yesAsk: 0.5,
        openInterest: index,
        evidence: { raw: 'x'.repeat(2_000) },
        nativeOrderbook: { bids: Array.from({ length: 50 }, () => ({ price: 40, size: 100 })) },
        rulesSecondary: 'y'.repeat(2_000),
      })),
    };
    const snapshot = {
      schemaVersion: 2, marketId: 'silver', generatedAt: '2026-08-29T20:00:00.000Z',
      revision: 9, status: 'partial', session: { state: 'open' },
      spot: { status: 'available', availability: 'live', value: 66, fit: 'proxy' },
      cashSpot: { status: 'available', availability: 'live', value: 6500, fit: 'exact' },
      resolverReference: {
        status: 'available', fit: 'proxy', resolver: 'COMEX SIZ26 liquid directional future',
        instrument: { symbol: 'SI', displaySymbol: 'SIZ26', conId: 4242 },
        spot: {
          status: 'available', availability: 'live', value: 66, fit: 'proxy',
          source: 'ibkr_live_native_quote', asOf: '2026-08-29T20:00:00.000Z',
          expiresAt: '2026-08-29T21:00:00.000Z', executable: false,
        },
        proxyFit: {
          status: 'partial', proxyLabel: 'SIZ26', underlyingLabel: 'SILVER',
          currentBasisPct: 0.42, alignedThroughDate: '2026-08-29',
          rows: [{ window: 5, status: 'available', averageBasisPct: 0.3, deviationZ: 0.8, returnCorrelation: 0.98 }],
        },
      },
      chart: { ...oneDay, variants: { '1d': oneDay, '5d': variant('5d', 8_000), '10d': variant('10d', 16_000) } },
      riskRange: { status: 'available', lrr: 64, hrr: 71 },
      publishedResearch: { trade: { status: 'available', direction: 'BEARISH', date: '2026-08-03', source: 'early-look', sourceUrl: 'https://app.hedgeye.com/feed_items/123', contextOnly: true, executable: false } },
      selectedVenueId: 'forecastex',
      venues: { forecastex: { id: 'forecastex', label: 'ForecastEx', status: 'partial', catalog: contracts, book: contracts, reference: { spot: {}, chart: oneDay } } },
      contracts, displayContracts: contracts, executionContracts: contracts,
      autoSelection: { venueId: 'forecastex', contracts },
      displaySelection: { venueId: 'forecastex', contracts },
      generationOptions: [{ venueId: 'forecastex', generationId: 'TEST', lines: contracts.lines }],
      sourceHealth: [], errors: [],
    };
    const card = createCardView(snapshot);
    expect(card.cardView).toBe(true);
    expect(card.publishedResearch).toEqual(snapshot.publishedResearch);
    expect(card.revision).toBe(9);
    expect(card.chart.variants['1d'].points).toHaveLength(220);
    expect(card.chart.variants['5d'].points).toHaveLength(360);
    expect(card.chart.variants['10d'].points).toHaveLength(520);
    expect(card.cashSpot).toMatchObject({ value: 6500, fit: 'exact' });
    expect(card.resolverReference).toMatchObject({
      instrument: { displaySymbol: 'SIZ26', conId: 4242 },
      spot: { value: 66, fit: 'proxy', executable: false },
      proxyFit: { status: 'partial', proxyLabel: 'SIZ26', underlyingLabel: 'SILVER' },
    });
    expect(card.proxyFit).toMatchObject({ currentBasisPct: 0.42, alignedThroughDate: '2026-08-29' });
    // Five strikes on either side plus an exact/containing strike when one exists.
    expect(card.contracts.lines.length).toBeLessThanOrEqual(11);
    expect(card.contracts.lineCount).toBe(200);
    expect(card.contracts.lines[0]).not.toHaveProperty('evidence');
    expect(card.venues.forecastex.catalog).toMatchObject({ lineCount: 200 });
    expect(card.venues.forecastex.catalog).not.toHaveProperty('lines');
    expect(Buffer.byteLength(JSON.stringify(card))).toBeLessThan(200_000);
  });

  test('keeps the ordered Gold reference contract without cross-filling unavailable tiles', () => {
    const references = [
      {
        key: 'selectedResolver', label: 'PYTH GOLD INDEX', symbol: 'GOLD/USD', role: 'direct',
        status: 'unavailable', price: null, previousClose: null, changePercent: null,
        unit: 'USD/ozt', source: null, instrument: null, asOf: null,
        reason: 'Pyth entitlement unavailable.',
      },
      {
        key: 'xauusd', label: 'SPOT GOLD', symbol: 'XAUUSD', role: 'proxy',
        status: 'live', price: 4434.3, previousClose: 4400, changePercent: 0.7795,
        unit: 'USD/ozt', source: 'ibkr',
        instrument: {
          symbol: 'XAUUSD', displaySymbol: 'XAUUSD', conId: 69067924,
          secType: 'CMDTY', exchange: 'SMART', currency: 'USD', contractMonth: null,
        },
        asOf: '2026-08-31T16:59:40.000Z', reason: null,
      },
      {
        key: 'activeComex', label: 'COMEX GOLD', symbol: 'GCZ26', role: 'proxy',
        status: 'historical', price: 4450.2, previousClose: 4420, changePercent: 0.6833,
        unit: 'USD/ozt', source: 'ibkr_historical_bars',
        instrument: {
          symbol: 'GC', displaySymbol: 'GCZ26', conId: 12345,
          secType: 'FUT', exchange: 'COMEX', currency: 'USD', contractMonth: '202612',
        },
        asOf: '2026-08-28T20:00:00.000Z', reason: null,
      },
    ];
    const card = createCardView({
      marketId: 'gold',
      selectedVenueId: 'kalshi',
      goldMarketReferences: references,
      resolverTracking: {
        status: 'available', source: 'kalshi_finalized_expiration_value',
        resolverSymbol: 'Metal.Index.GOLD/USD', proxySymbol: 'XAUUSD', sampleSize: 17,
        meanSignedErrorUsd: -0.85, meanAbsoluteErrorUsd: 1.5,
        medianAbsoluteErrorUsd: 0.67, p90AbsoluteErrorUsd: 5.01, maxAbsoluteErrorUsd: 6.97,
        guardBandUsd: 10,
        settlements: [{
          status: 'available', availability: 'official_final', final: true,
          eventTicker: 'KXGOLDD-26AUG3117', value: 4448.11,
          observationAt: '2026-08-31T21:00:00.000Z', finalizedAt: '2026-08-31T22:01:00.000Z',
          source: 'kalshi_finalized_expiration_value',
        }],
        latestFinal: {
          eventTicker: 'KXGOLDD-26AUG3117', value: 4448.11,
          observationAt: '2026-08-31T21:00:00.000Z', finalizedAt: '2026-08-31T22:01:00.000Z',
          source: 'kalshi_finalized_expiration_value',
        },
        exactUrl: 'https://app.pyth.com/explore/Metal.Index.GOLD%2FUSD',
        entitlement: 'api_entitlement_required',
      },
      venues: {},
      contracts: { status: 'unavailable', event: null, lines: [] },
      factorRows: [],
    });

    expect(card.goldMarketReferences.map((reference) => reference.key)).toEqual([
      'selectedResolver', 'xauusd', 'activeComex',
    ]);
    expect(card.goldMarketReferences[0]).toMatchObject(references[0]);
    expect(card.goldMarketReferences[1]).toMatchObject(references[1]);
    expect(card.goldMarketReferences[2]).toMatchObject(references[2]);
    expect(card.resolverTracking).toMatchObject({
      status: 'available', resolverSymbol: 'Metal.Index.GOLD/USD', proxySymbol: 'XAUUSD',
      sampleSize: 17, guardBandUsd: 10,
      settlements: [{
        status: 'available', availability: 'official_final', final: true,
        eventTicker: 'KXGOLDD-26AUG3117', value: 4448.11,
      }],
      latestFinal: { eventTicker: 'KXGOLDD-26AUG3117', value: 4448.11 },
      entitlement: 'api_entitlement_required',
    });
  });

  test('preserves bounded delayed Gold-reference metadata in compact card responses', () => {
    const expiresAt = '2026-08-31T17:00:40.000Z';
    const card = createCardView({
      marketId: 'gold',
      selectedVenueId: 'kalshi',
      goldMarketReferences: [{
        key: 'xauusd', label: 'SPOT GOLD', symbol: 'XAUUSD', role: 'proxy',
        status: 'delayed', retainedStatus: 'live', price: 4434.3, previousClose: 4400,
        changePercent: 0.7795, unit: 'USD/ozt', source: 'ibkr',
        instrument: { symbol: 'XAUUSD', displaySymbol: 'XAUUSD', conId: 69067924 },
        asOf: '2026-08-31T16:59:40.000Z', expiresAt,
        displayOnly: true, executable: false, refreshPending: true, refreshRetained: true,
        delayedReason: 'A fresh quote is loading.', reason: 'A fresh quote is loading.',
      }],
      venues: {},
      contracts: { status: 'unavailable', event: null, lines: [] },
      factorRows: [],
    });

    expect(card.goldMarketReferences[0]).toMatchObject({
      key: 'xauusd', status: 'delayed', retainedStatus: 'live', price: 4434.3,
      expiresAt, displayOnly: true, executable: false,
      refreshPending: true, refreshRetained: true,
      delayedReason: 'A fresh quote is loading.',
    });
  });

  test('keeps the same-generation last verified resolver spot and centers the compact ladder on it', () => {
    const lines = Array.from({ length: 13 }, (_, index) => ({
      ticker: `FES-${60 + index}`,
      threshold: 60 + index,
      comparator: '>',
      status: 'available',
      yesBid: 0.4,
      yesAsk: 0.42,
      noBid: 0.58,
      noAsk: 0.6,
    }));
    const lastVerifiedSpot = {
      status: 'last_verified', availability: 'last_verified', fit: 'exact',
      value: 66.5, label: 'ESZ26', source: 'ibkr_live_native_quote',
      asOf: '2026-08-31T16:59:40.000Z', generationKey: 'FES_083126',
      retainedUntil: '2026-08-31T20:00:00.000Z',
      displayOnly: true, executable: false, stale: true,
    };
    const card = createCardView({
      schemaVersion: 2,
      marketId: 'sp500',
      selectedVenueId: 'forecastex',
      spot: { status: 'unavailable', availability: 'unavailable', value: null },
      resolverReference: {
        status: 'unavailable', fit: 'exact', resolver: 'CME ESZ26',
        instrument: { symbol: 'ES', displaySymbol: 'ESZ26' },
        spot: { status: 'unavailable', availability: 'unavailable', fit: 'exact', value: null },
        lastVerifiedSpot,
      },
      venues: { forecastex: { id: 'forecastex', label: 'ForecastEx', status: 'available' } },
      contracts: {
        status: 'available',
        event: { ticker: 'FES_083126', resolverSymbol: 'ESZ26' },
        lines,
      },
      factorRows: [],
    });

    expect(card.resolverReference.lastVerifiedSpot).toEqual(lastVerifiedSpot);
    expect(card.contracts.ladderSelection).toMatchObject({
      referenceValue: 66.5,
      displayedLineCount: 10,
    });
    expect(card.contracts.lines.map((line) => line.threshold)).toEqual([
      62, 63, 64, 65, 66, 67, 68, 69, 70, 71,
    ]);
  });

  test('keeps bounded CPI research and centers its ladder on a non-executable dated base forecast', () => {
    const lines = Array.from({ length: 15 }, (_, index) => ({
      ticker: `KXCPIYOY-26AUG-T${(2 + index / 10).toFixed(1)}`,
      threshold: Number((2 + index / 10).toFixed(1)),
      comparator: '>',
      status: 'available',
      yesBid: 0.4,
      yesAsk: 0.42,
      noBid: 0.58,
      noAsk: 0.6,
      directNative: true,
    }));
    const clevelandPoints = Array.from({ length: 150 }, (_, index) => ({
      timestamp: Date.parse('2026-08-01T12:00:00.000Z') + index * 60_000,
      value: 2.4 + index / 1_000,
    }));
    const releaseAt = '2026-09-11T12:30:00.000Z';
    const event = {
      ticker: 'KXCPIYOY-26AUG',
      eventTicker: 'KXCPIYOY-26AUG',
      releaseKey: 'KXCPIYOY#2026-08',
      reportMonth: '2026-08',
      releaseAt,
    };
    const contracts = { status: 'available', event, lines };
    const card = createCardView({
      schemaVersion: 2,
      marketId: 'cpi',
      status: 'available',
      selectedVenueId: 'kalshi',
      contracts,
      displayContracts: contracts,
      executionContracts: { status: 'unavailable', event: null, lines: [] },
      venues: { kalshi: { id: 'kalshi', label: 'Kalshi', catalog: contracts, book: contracts } },
      forecastComparison: {
        status: 'available',
        releaseKey: 'KXCPIYOY#2026-08',
        reportMonth: '2026-08',
        forecastMonth: 'August 2026',
        releaseAt,
        eventTicker: 'KXCPIYOY-26AUG',
        hedgeye: {
          status: 'available', reportMonth: '2026-08', baseValue: 2.6,
          source: 'hedgeye-inflation-nowcast', asOf: '2026-08-28T14:00:00.000Z',
          scenarios: [
            { key: 'downside', label: 'Downside', value: 2.4 },
            { key: 'base', label: 'Base Case', value: 2.6 },
            { key: 'upside', label: 'Upside', value: 2.8 },
          ],
        },
        clevelandFed: {
          status: 'available', reportMonth: '2026-08', value: 2.549,
          source: 'cleveland_fed_inflation_nowcasting', points: clevelandPoints,
        },
        bls: {
          status: 'available', reportMonth: '2026-08', source: 'bls_public_data_api',
          latestFinal: { reportMonth: '2026-07', value: 2.7, source: 'bls_public_data_api' },
        },
      },
      ladderReference: {
        status: 'available', kind: 'hedgeye_base', label: 'HEDGEYE BASE',
        value: 2.6, reportMonth: '2026-08', source: 'hedgeye-inflation-nowcast',
        asOf: '2026-08-28T14:00:00.000Z', expiresAt: releaseAt,
        availability: 'dated', executable: false,
      },
      sourceHealth: [],
      errors: [],
    });

    expect(card.forecastComparison).toMatchObject({
      status: 'available',
      reportMonth: '2026-08',
      hedgeye: { baseValue: 2.6, scenarios: expect.any(Array) },
      clevelandFed: { status: 'available', value: 2.549 },
      bls: { latestFinal: { reportMonth: '2026-07', value: 2.7 } },
    });
    expect(card.forecastComparison.clevelandFed.points).toHaveLength(120);
    expect(card.forecastComparison.clevelandFed.points[0])
      .toEqual(clevelandPoints[30]);
    expect(card.ladderReference).toMatchObject({
      kind: 'hedgeye_base', value: 2.6, reportMonth: '2026-08', executable: false,
    });
    expect(card.contracts.event).toMatchObject(event);
    expect(card.contracts.ladderSelection).toEqual({
      displayedLineCount: 11,
      totalLineCount: 15,
      referenceValue: 2.6,
      referenceKind: 'hedgeye_base',
      referenceLabel: 'HEDGEYE BASE',
      corePerSide: 5,
    });
    expect(card.contracts.lines.map((line) => line.threshold)).toEqual([
      2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9, 3, 3.1,
    ]);
  });
});
