const {
  OPPORTUNITY_PREFIX,
  actionSequenceSummary,
  buildFesContext,
  buildQuotePath,
  buildResearchResponse,
  collectorWindow,
  collectorHealthView,
  createSpxFesResearchService,
  percentileZone,
} = require('./spxFesResearchService.cjs');

const COMPLETED = '2026-08-20T17:00:00.000Z';
const LAST_TRADE = '2026-08-20T20:00:00.000Z';
const RESOLUTION = '2026-08-21T15:00:00.000Z';
const PAYOUT = '2026-08-21T17:00:00.000Z';

function line(strike = 6400, overrides = {}) {
  return {
    productId: 'FES',
    ticker: `FES_082026_${strike}`,
    contractId: `FES_082026_${strike}`,
    threshold: strike,
    question: `Will Sep-26 S&P 500 Index Futures settle above $${strike.toLocaleString('en-US')} on August 20 2026?`,
    closeAt: LAST_TRADE,
    expirationDate: RESOLUTION,
    payoutDate: PAYOUT,
    rulesUrl: 'https://data.forecastex.com/regulatory/FESTermsandConditions.pdf',
    status: 'available',
    yesBid: 0.44,
    yesAsk: 0.46,
    yesBidSize: 20,
    yesAskSize: 25,
    noBid: 0.53,
    noAsk: 0.55,
    noBidSize: 18,
    noAskSize: 22,
    updatedAt: '2026-08-20T16:59:50.000Z',
    source: 'ibkr_tws_forecastex_live',
    directNative: true,
    ...overrides,
  };
}

function snapshot(overrides = {}) {
  const lines = overrides.lines || [line(6400), line(6450, { yesAsk: 0.22, yesBid: 0.20, noBid: 0.77, noAsk: 0.79 })];
  return {
    schemaVersion: 2,
    marketId: 'sp500',
    generatedAt: COMPLETED,
    refresh: { state: 'idle', completedAt: COMPLETED },
    spot: {
      status: 'available', availability: 'live', value: 6400,
      source: 'ibkr_live', asOf: '2026-08-20T16:59:55.000Z', expiresAt: '2026-08-20T17:00:55.000Z', reason: null,
    },
    resolverReference: {
      resolver: 'CME ESU26 dated E-mini S&P 500 future',
      instrument: { displaySymbol: 'ESU26', lastTradeDateOrContractMonth: '202609' },
      spot: {
        status: 'available', availability: 'live', value: 6420,
        source: 'ibkr_live_native_quote', priceType: 'direct_last_trade',
        asOf: '2026-08-20T16:59:50.000Z', expiresAt: '2026-08-20T17:00:50.000Z', reason: null,
      },
    },
    riskRange: {
      status: 'available', lrr: 6300, hrr: 6450, trend: 'BULLISH', date: '2026-08-20',
      source: 'hedgeye_risk_ranges', asOf: '2026-08-20T13:00:00.000Z', reason: null,
    },
    factors: {
      trade: { status: 'available', direction: 'BULLISH', date: '2026-08-20', source: 'momo-tracker', asOf: '2026-08-20T13:00:00.000Z', reason: null },
      gamma: { status: 'available', value: 'positive', throttle: 0.65, source: 'market-situation-report', asOf: '2026-08-20T13:00:00.000Z', reason: null },
      vix: { status: 'available', value: 18, source: 'ibkr_live', asOf: '2026-08-20T16:59:48.000Z', reason: null },
    },
    venues: {
      forecastex: {
        resolverIdentity: {
          generationKey: 'FES_082026', eventDate: '2026-08-20', resolverSymbol: 'ESU26',
          underlyingContractMonth: '202609', resolverMonthLabel: 'Sep-26',
          lastTradeAt: LAST_TRADE, resolutionAt: RESOLUTION, payoutAt: PAYOUT,
        },
        book: {
          status: 'available', source: 'ibkr_tws_forecastex_live', asOf: COMPLETED,
          expiresAt: '2026-08-20T17:01:30.000Z', reason: null, lines,
        },
      },
    },
    ...overrides,
  };
}

class MemoryStore {
  constructor() { this.items = new Map(); }
  key(accountId, recordKey) { return `${accountId}\u0000${recordKey}`; }
  async get(accountId, recordKey) { return this.items.get(this.key(accountId, recordKey)) || null; }
  async put(item, { expectedVersion } = {}) {
    const key = this.key(item.accountId, item.recordKey);
    const current = this.items.get(key);
    if (expectedVersion != null && Number(current?.version) !== Number(expectedVersion)) throw Object.assign(new Error('conflict'), { code: 'ConditionalCheckFailedException' });
    this.items.set(key, JSON.parse(JSON.stringify(item)));
    return item;
  }
  async transactSave(entries) {
    for (const entry of entries) {
      const item = entry.item || entry;
      const key = this.key(item.accountId, item.recordKey);
      if (entry.createOnly && this.items.has(key)) throw Object.assign(new Error('exists'), { code: 'TransactionCanceledException' });
    }
    entries.forEach((entry) => {
      const item = entry.item || entry;
      this.items.set(this.key(item.accountId, item.recordKey), JSON.parse(JSON.stringify(item)));
    });
  }
  async queryAccount(accountId) { return [...this.items.values()].filter((item) => item.accountId === accountId); }
  async queryAccountPrefix(accountId, prefix) { return (await this.queryAccount(accountId)).filter((item) => item.recordKey.startsWith(prefix)); }
  async listRegisteredManagedAccounts() { return ['U123']; }
}

describe('ForecastEx FES prospective research capture', () => {
  test('calculates unclamped cash and basis-adjusted geometry with exact third boundaries', () => {
    expect(percentileZone(99, 100, 130)).toEqual({ percentile: -1 / 30, zone: 'below' });
    expect(percentileZone(100, 100, 130).zone).toBe('bottom third');
    expect(percentileZone(110, 100, 130).zone).toBe('middle third');
    expect(percentileZone(120, 100, 130).zone).toBe('top third');
    expect(percentileZone(131, 100, 130).zone).toBe('above');

    const built = buildFesContext(snapshot());
    expect(built).toMatchObject({
      ok: true,
      context: {
        generationKey: 'FES_082026', resolverSymbol: 'ESU26', resolverContractMonth: '202609',
        basis: 20, cashRangeZone: 'top third', directionalAlignment: 'aligned bullish', thesisSide: 'YES',
        gammaSign: 'positive', gammaThrottle: 0.65, vixRegime: 'under 20',
        basisAdjustedRange: { low: 6320, high: 6470 },
      },
    });
    expect(built.context.lines.find((row) => row.strike === 6400)).toMatchObject({
      strikeZone: 'middle third', esMoneyness: 20,
      sides: { YES: { bid: 0.44, ask: 0.46, directNative: true } },
    });
  });

  test.each([
    ['stale cash SPX', (value) => ({ ...value, spot: { ...value.spot, asOf: '2026-08-20T16:58:00.000Z' } }), 'live_cash_spx_unavailable'],
    ['cached ES', (value) => ({ ...value, resolverReference: { ...value.resolverReference, spot: { ...value.resolverReference.spot, source: 'cached_fallback' } } }), 'live_exact_es_unavailable'],
    ['quote skew', (value) => ({ ...value, resolverReference: { ...value.resolverReference, spot: { ...value.resolverReference.spot, asOf: '2026-08-20T16:59:00.000Z' } } }), 'spx_es_quote_skew_exceeded'],
    ['mixed FES month', (value) => ({ ...value, venues: { forecastex: { ...value.venues.forecastex, book: { ...value.venues.forecastex.book, lines: [value.venues.forecastex.book.lines[0], line(6450, { question: 'Will Dec-26 S&P 500 Index Futures settle above $6,450 on August 20 2026?' })] } } } }), 'ambiguous_fes_generation'],
  ])('fails closed for %s', (_label, mutate, reason) => {
    expect(buildFesContext(mutate(snapshot()))).toMatchObject({ ok: false, reason });
  });

  test('keeps missing gamma or VIX explicit without turning either into an opportunity gate', () => {
    const value = snapshot();
    value.factors = {
      ...value.factors,
      gamma: { status: 'unavailable', value: null, throttle: null, reason: 'No current report.' },
      vix: { ...value.factors.vix, source: 'cached_fallback' },
    };
    const built = buildFesContext(value);
    expect(built).toMatchObject({ ok: true, context: { gammaSign: 'unavailable', gammaThrottle: null, vix: null, vixRegime: 'unavailable' } });
    const store = new MemoryStore();
    const service = createSpxFesResearchService({ store, now: () => new Date(COMPLETED), logger: { warn: jest.fn() } });
    return service.captureSnapshot(value).then((captured) => {
      expect(captured.opportunities).toHaveLength(2);
      expect(captured.opportunities[0].context.coverage).toMatchObject({ gamma: false, vix: false, riskRange: true, liveBasis: true });
    });
  });

  test('deduplicates opportunities and matches only the latest completed context before a fill', async () => {
    const store = new MemoryStore();
    const service = createSpxFesResearchService({ store, now: () => new Date(COMPLETED), logger: { warn: jest.fn() } });
    await service.captureSnapshot(snapshot());
    await service.captureSnapshot(snapshot());
    const opportunities = (await store.queryAccount('system#prediction-performance')).filter((item) => item.itemType === 'spx_fes_opportunity');
    expect(opportunities).toHaveLength(2);
    expect(opportunities.every((item) => item.thesisSide === 'YES')).toBe(true);

    const execution = {
      accountId: 'U123', recordKey: 'execution#fill-1', itemType: 'execution', execId: 'fill-1',
      direction: 'BUY', executionTime: '2026-08-20T17:00:30.000Z',
      contractKey: 'FES_082026_6400_YES', eventTicker: 'FES_082026_6400',
      symbol: 'FES', secType: 'FOP', tradingClass: 'FES', exchange: 'FORECASTX',
      expiration: '20260820', strike: 6400, contractSide: 'YES',
    };
    const result = { writeEntries: [{ item: execution, createOnly: true }] };
    await service.enrichCaptureResult({ accountId: 'U123', result });
    expect(execution.spxFesEntryContext).toMatchObject({
      status: 'matched', ageMs: 30_000, actionDirection: 'BUY', qualified: true, priorBook: { bid: 0.44, ask: 0.46 },
    });

    const exit = {
      ...execution,
      recordKey: 'execution#exit-1', execId: 'exit-1', direction: 'SELL',
      executionTime: '2026-08-20T17:00:45.000Z', spxFesEntryContext: undefined,
    };
    await service.enrichCaptureResult({ accountId: 'U123', result: { writeEntries: [{ item: exit, createOnly: true }] } });
    expect(exit.spxFesEntryContext).toMatchObject({
      status: 'matched', actionDirection: 'SELL', qualified: false, ageMs: 45_000,
    });

    const earlier = { ...execution, recordKey: 'execution#earlier', execId: 'earlier', executionTime: '2026-08-20T16:59:59.000Z', spxFesEntryContext: undefined };
    await service.enrichCaptureResult({ accountId: 'U123', result: { writeEntries: [{ item: earlier, createOnly: true }] } });
    expect(earlier.spxFesEntryContext).toMatchObject({ status: 'legacy_unmatched', matchedAt: null });
  });

  test('selects direct same-side +5/+15/+30, excursion, and pre-close observations only', () => {
    const entryContext = buildFesContext(snapshot()).context;
    const execution = {
      executionTime: COMPLETED,
      spxFesEntryContext: {
        status: 'matched', strike: 6400, side: 'YES', lastTradeAt: LAST_TRADE,
        priorBook: { bid: 0.44, ask: 0.46 },
      },
    };
    const at = (timestamp, bid, ask) => ({
      ...entryContext,
      completedAt: timestamp,
      lines: [{
        ...entryContext.lines.find((row) => row.strike === 6400),
        sides: {
          ...entryContext.lines.find((row) => row.strike === 6400).sides,
          YES: { bid, ask, bidSize: 20, askSize: 20, updatedAt: timestamp, source: 'ibkr_tws_forecastex_live', directNative: true },
        },
      }],
    });
    const contexts = [
      at('2026-08-20T17:05:30.000Z', 0.47, 0.49),
      at('2026-08-20T17:15:20.000Z', 0.40, 0.43),
      at('2026-08-20T17:31:00.000Z', 0.55, 0.57),
      at('2026-08-20T19:58:00.000Z', 0.51, 0.53),
    ];
    expect(buildQuotePath(execution, contexts, Date.parse('2026-08-20T20:01:00Z'))).toBeNull();
    const path = buildQuotePath(execution, contexts, Date.parse('2026-08-20T20:02:00Z'));
    expect(path).toMatchObject({
      status: 'finalized',
      plus5: { bid: 0.47, bidChange: 0.03 },
      plus15: { bid: 0.40, bidChange: -0.04 },
      plus30: { bid: 0.55, bidChange: 0.11 },
      bestBid: { bid: 0.55, change: 0.11 },
      worstBid: { bid: 0.40, change: -0.04 },
      lastPreClose: { bid: 0.51, bidChange: 0.07 },
      cashSpxClose: { value: 6400, rangeZone: 'top third', publishedRangeContainedClose: true },
    });
    const noSide = buildQuotePath({ ...execution, spxFesEntryContext: { ...execution.spxFesEntryContext, side: 'NO', priorBook: { bid: 0.53, ask: 0.55 } } }, contexts.map((context) => ({ ...context, lines: context.lines.map((row) => ({ ...row, sides: { ...row.sides, NO: null } })) })), Date.parse('2026-08-20T20:02:00Z'));
    expect(noSide.plus5).toMatchObject({ bid: null, reason: expect.stringMatching(/verified direct same-side/i) });
  });

  test('counts a multi-fill lifecycle once for P&L/calibration and keeps pass counterfactuals separate', () => {
    const context = buildFesContext(snapshot()).context;
    const opportunity = {
      accountId: 'system#prediction-performance', recordKey: `${OPPORTUNITY_PREFIX}FES_082026#6400#YES`,
      itemType: 'spx_fes_opportunity', qualified: true, generationKey: 'FES_082026', eventDate: '2026-08-20',
      eventContract: 'FES_082026_6400', strike: 6400, thesisSide: 'YES', firstEligibleAt: COMPLETED,
      firstEligibleBid: 0.44, firstEligibleAsk: 0.46, resolverSymbol: 'ESU26', lastTradeAt: LAST_TRADE,
      context: { cashRangeZone: 'top third', strikeZone: 'middle third', directionalAlignment: 'aligned bullish', gammaSign: 'positive', vixRegime: 'under 20', entryTimeBucket: '10:00–13:00 CT', timeToLastTradeBucket: 'over 90m', contractPriceThird: 'middle third', confluenceBand: 'high' },
      outcome: { payoutForThesisSide: 1, outcome: 'YES' },
    };
    const passed = { ...opportunity, recordKey: `${OPPORTUNITY_PREFIX}FES_082026#6450#YES`, opportunityId: 'pass', eventContract: 'FES_082026_6450', strike: 6450, firstEligibleAsk: 0.22, outcome: { payoutForThesisSide: 0, outcome: 'NO' } };
    const entry = { status: 'matched', opportunityRecordKey: opportunity.recordKey, eventDate: '2026-08-20', qualified: true };
    const executions = [
      { accountId: 'U123', recordKey: 'execution#1', itemType: 'execution', direction: 'BUY', shares: 1, price: 0.3, lifecycleRecordKey: 'lifecycle#1', contractKey: 'FES_082026_6400_YES', expiration: '20260820', strike: 6400, contractSide: 'YES', spxFesEntryContext: entry },
      { accountId: 'U123', recordKey: 'execution#2', itemType: 'execution', direction: 'BUY', shares: 1, price: 0.4, lifecycleRecordKey: 'lifecycle#1', contractKey: 'FES_082026_6400_YES', expiration: '20260820', strike: 6400, contractSide: 'YES', spxFesEntryContext: entry },
    ];
    const lifecycle = {
      accountId: 'U123', recordKey: 'lifecycle#1', itemType: 'lifecycle', status: 'verified', resolutionType: 'expiry',
      resolvedDate: '2026-08-21', contractKey: 'FES_082026_6400_YES', eventTicker: 'FES_082026_6400', expiration: '20260820',
      market: 'sp500', strike: 6400, contractSide: 'YES', risked: 0.72, fees: 0.02, pnl: 1.28,
      settlementSymbol: 'ESU26',
      settlementEvidence: {
        source: 'forecastex_official_prices', payoutPerContract: 1, outcome: 'YES', underlyingSettlementValue: 6425,
        underlyingSettlementSource: 'cme_daily_bulletin_final', underlyingSettlementStatus: 'official_final',
        underlyingSettlementSymbol: 'ESU26',
      },
    };
    const response = buildResearchResponse({
      accountId: 'U123', accountRecords: [...executions, lifecycle], opportunities: [opportunity, passed],
      now: new Date('2026-08-22T12:00:00Z'), startedAt: COMPLETED,
      health: { status: 'capturing', resolverSymbol: 'ESU26', provenance: context.provenance },
    });
    expect(response.counts).toMatchObject({ resolvedContracts: 1, resolvedEventDays: 1, actionOpportunities: 1, qualifiedOpportunities: 2 });
    expect(response.performance.netPnl.value).toBe(1.28);
    expect(response.calibration.sampleContracts).toBe(1);
    expect(response.calibration.averageFillImpliedProbability.value).toBe(0.35);
    expect(response.actionFrequency.qualifiedStrikeActionRate).toMatchObject({ value: 0.5, observations: 2, successes: 1, interval95: { method: 'Wilson' } });
    expect(response.actionFrequency.addOnRate).toMatchObject({ value: 0.5, observations: 2, successes: 1 });
    expect(response.actionFrequency.reEntryRate).toMatchObject({ value: 0, observations: 2, successes: 0 });
    expect(response.passAnalysis).toMatchObject({ resolvedPassedOpportunities: 1, averageCounterfactualPerContract: { value: -0.22 } });
    expect(response.cohorts.tables.cashRangeZone.rows[0]).toMatchObject({ qualifiedOpportunityCount: 2, contractCount: 1, uniqueDays: 1 });
    expect(response.hands[0]).toMatchObject({ actionCount: 2, qualifiedStrikeActionCount: 1 });
    expect(response.outcomeGeometry).toMatchObject({
      sampleContracts: 1,
      officialEsSettlementCoverage: { value: 1, observations: 1 },
      averageDistanceToStrike: { value: 25 },
      averageSideAdjustedSettlementMargin: { value: 25 },
    });
    expect(response.provenance.settlement).toMatchObject({ source: 'cme_daily_bulletin_final', symbol: 'ESU26', status: 'official_final' });
    expect(response.exploratory.status).toBe('exploratory');
  });

  test('finalizes pass outcomes only from the exact official ForecastEx complementary pair', async () => {
    const store = new MemoryStore();
    const opportunity = {
      accountId: 'system#prediction-performance', recordKey: `${OPPORTUNITY_PREFIX}FES_082026#6400#YES`,
      itemType: 'spx_fes_opportunity', qualified: true, version: 1,
      eventDate: '2026-08-20', eventContract: 'FES_082026_6400', thesisSide: 'YES',
      resolutionAt: RESOLUTION,
    };
    await store.put(opportunity);
    const loadOfficialForecastExPrices = jest.fn(async ({ dataDate }) => ({
      ok: true,
      source: 'forecastex_official_prices',
      snapshotType: 'settled_outcome_candidates',
      dataDate,
      fetchedAt: '2026-08-21T17:00:00.000Z',
      url: `https://www.forecastex.com/api/download?type=prices&date=${dataDate.replaceAll('-', '')}`,
      sha256: 'a'.repeat(64),
      rows: [
        { eventContract: 'FES_082026_6400', subtype: 'YES', settlementPrice: 1, expirationDate: RESOLUTION },
        { eventContract: 'FES_082026_6400', subtype: 'NO', settlementPrice: 0, expirationDate: RESOLUTION },
      ],
    }));
    const service = createSpxFesResearchService({
      store, loadOfficialForecastExPrices, now: () => new Date('2026-08-21T18:00:00.000Z'), logger: { warn: jest.fn() },
    });
    await service.finalizeOpportunityOutcomes();
    expect(await store.get(opportunity.accountId, opportunity.recordKey)).toMatchObject({
      outcome: { outcome: 'YES', payoutForThesisSide: 1, source: 'forecastex_official_prices' },
      version: 2,
    });
  });

  test('separates add-on buys from buy-after-flat re-entry actions', () => {
    const records = [
      { recordKey: 'buy-1', executionTime: '2026-08-20T15:00:00Z', direction: 'BUY', shares: 2 },
      { recordKey: 'buy-2', executionTime: '2026-08-20T15:01:00Z', direction: 'BUY', shares: 1 },
      { recordKey: 'sell-1', executionTime: '2026-08-20T15:02:00Z', direction: 'SELL', shares: 3 },
      { recordKey: 'buy-3', executionTime: '2026-08-20T15:03:00Z', direction: 'BUY', shares: 1 },
    ];
    expect(actionSequenceSummary(records, new Set(['buy-1', 'buy-2', 'buy-3'])))
      .toEqual({ addOnCount: 1, reEntryCount: 1 });
  });

  test('recognizes only the configured CT collection session', () => {
    expect(collectorWindow(new Date('2026-08-20T13:29:59Z')).open).toBe(false);
    expect(collectorWindow(new Date('2026-08-20T13:30:00Z'))).toMatchObject({ date: '2026-08-20', open: true });
    expect(collectorWindow(new Date('2026-08-20T20:00:00Z')).open).toBe(true);
    expect(collectorWindow(new Date('2026-08-20T20:00:01Z')).open).toBe(false);
    expect(collectorWindow(new Date('2026-08-22T17:00:00Z')).open).toBe(false);
    expect(collectorHealthView({
      status: 'capturing', lastAttemptAt: '2026-08-20T16:58:00Z', startedAt: '2026-08-20T13:30:00Z',
    }, null, Date.parse('2026-08-20T17:00:00Z'))).toMatchObject({
      status: 'unavailable', sessionOpen: true, reason: expect.stringMatching(/heartbeat is stale/i),
    });
  });
});
