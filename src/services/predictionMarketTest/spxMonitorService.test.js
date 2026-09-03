const {
  createSpxMonitorService,
  normalizeMarketStructure,
  normalizeSpyVolume,
  resolveVerifiedIbkrClose,
  resolveVerifiedIbkrSessionClose,
  resolveVerifiedIbkrQuote,
  selectCftcEminiRow,
} = require('./spxMonitorService.cjs');

const NOW = new Date('2026-08-17T15:00:00.000Z');

function businessDatesBefore(target, count) {
  const dates = [];
  const cursor = new Date(`${target}T12:00:00.000Z`);
  while (dates.length < count) {
    cursor.setUTCDate(cursor.getUTCDate() - 1);
    const day = cursor.getUTCDay();
    if (day !== 0 && day !== 6) dates.unshift(cursor.toISOString().slice(0, 10));
  }
  return dates;
}

function spyBars(targetDate = '2026-08-17') {
  const prior = businessDatesBefore(targetDate, 20);
  return [
    ...prior.flatMap((date) => [
      { date: `${date} 09:30:00`, close: 100, volume: 100 },
      { date: `${date} 10:55:00`, close: 101, volume: 200 },
    ]),
    { date: `${targetDate} 09:30:00`, close: 102, volume: 150 },
    { date: `${targetDate} 10:55:00`, close: 103, volume: 300 },
  ];
}

function liveQuote(symbol, value, overrides = {}) {
  return {
    canonical: {
      valid: true,
      symbol,
      source: 'ibkr',
      dataType: 'live',
      last: value,
      timestamp: '2026-08-17T14:59:45.000Z',
      entitlementStatus: 'entitled',
      warning: null,
      ...overrides,
    },
  };
}

function officialCftcSnapshot(overrides = {}) {
  return {
    snapshotType: 'cftc-positioning',
    schemaVersion: 'cftc-positioning-v2',
    calculationVersion: 'cftc-combined-net-sample-z-v1',
    source: 'cftc-public-reporting-environment',
    sourceContentHash: 'a'.repeat(64),
    datasetIds: { legacy: 'srt6-5q2f', disaggregated: 'rxbv-e226' },
    date: '2026-08-11',
    reportDate: '2026-08-11',
    decisionEligible: true,
    data: [{
      metric: 'SPX (Index + E-mini)',
      cftcContractMarketCode: '13874A',
      seriesType: 'legacy-noncommercial-combined',
      asOf: '2026-08-11',
      status: 'current',
      decisionEligible: true,
      latest: 123456,
      wwChg: 2300,
      zScore1Y: 1.62,
      zScore3Y: 0.42,
    }],
    ...overrides,
  };
}

function spxCashBars(dates, base = 7700) {
  return dates.flatMap((date, index) => [
    {
      timestamp: Date.parse(`${date}T14:50:00.000Z`),
      close: base + (index * 10),
      high: base + (index * 10) + 4,
    },
    {
      timestamp: Date.parse(`${date}T14:55:00.000Z`),
      close: base + (index * 10) + 2,
      high: base + (index * 10) + 6,
    },
  ]);
}

function spxHourlyBars(dates, base = 7700) {
  const startsUtc = ['13:30', '14:00', '15:00', '16:00', '17:00', '18:00', '19:00'];
  return dates.flatMap((date, dateIndex) => startsUtc.map((time, barIndex) => ({
    timestamp: Date.parse(`${date}T${time}:00.000Z`),
    close: base + (dateIndex * 10) + barIndex,
    high: base + (dateIndex * 10) + barIndex + 2,
  })));
}

function vixDailyBars(dates, base = 15) {
  return dates.map((date, index) => ({
    date,
    close: Number((base + (index * 0.25)).toFixed(2)),
  }));
}

function newYorkDateKey(value) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(value));
  const fields = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${fields.year}-${fields.month}-${fields.day}`;
}

function exactRiskHistory(dates, missingDates = []) {
  const missing = new Set(missingDates);
  const ranges = Object.fromEntries(dates.filter((date) => !missing.has(date)).map((date, index) => [date, {
    ticker: 'SPX',
    date,
    lrr: 7600 + (index * 10),
    hrr: 7800 + (index * 10),
    source: 'RiskRangeData',
    asOf: date,
  }]));
  return {
    status: missing.size ? 'unavailable' : 'available',
    source: 'RiskRangeData',
    ticker: 'SPX',
    ranges,
    missingDates: [...missing],
    reason: missing.size ? `Exact-date Risk Range data is unavailable for ${[...missing].join(', ')}.` : null,
  };
}

function exactRiskHistoryFromRows(rows) {
  return {
    status: 'available',
    source: 'RiskRangeData',
    ticker: 'SPX',
    ranges: Object.fromEntries(rows.map(({ date, lrr, hrr }) => [date, {
      ticker: 'SPX', date, lrr, hrr, source: 'RiskRangeData', asOf: date,
    }])),
    missingDates: [],
    reason: null,
  };
}

function createFiveDayChartService({
  requestNow = NOW,
  sessionDates = ['2026-08-11', '2026-08-12', '2026-08-13', '2026-08-14', '2026-08-17'],
  comparisonDate = '2026-08-10',
  multiHistory,
  riskHistory,
  historicalRecord = { status: 'unavailable', source: null, reason: 'test record unavailable' },
  providerStatus = { connected: true, authenticated: true },
  rtaRange = { status: 'unavailable' },
  rtaRangeLoader = null,
  riskRangeDate = null,
  vixHistory = null,
  vvixHistory = null,
  loadHistoricalBars = null,
  refreshBudgetMs = undefined,
} = {}) {
  const requestDate = new Date(requestNow);
  const tenSessionDates = comparisonDate
    ? [...businessDatesBefore(sessionDates[0], Math.max(0, 10 - sessionDates.length)), ...sessionDates].slice(-10)
    : sessionDates;
  const tenDayComparisonDate = tenSessionDates.length
    ? businessDatesBefore(tenSessionDates[0], 1)[0]
    : null;
  const bars = spxCashBars(tenDayComparisonDate ? [tenDayComparisonDate, ...tenSessionDates] : tenSessionDates);
  const currentDate = newYorkDateKey(requestDate);
  const publishedRiskRangeDate = riskRangeDate || currentDate;
  return createSpxMonitorService({
    now: () => new Date(requestDate),
    refreshBudgetMs,
    getContracts: jest.fn(async () => ({
      ok: true,
      fetchedAt: requestDate.toISOString(),
      seriesTicker: 'KXINXU',
      event: { ticker: 'KXINXU-TEST', closeTime: `${currentDate}T20:00:00.000Z` },
      markets: [{
        ticker: 'KXINXU-TEST-T7700', threshold: 7700,
        yesBid: 0.49, yesAsk: 0.51, noBid: 0.49, noAsk: 0.51,
        yesBidSize: 10, yesAskSize: 10, noBidSize: 10, noAskSize: 10,
        volume24h: 100, openInterest: 100, nativeBook: { complete: true },
      }],
    })),
    getProviderStatus: jest.fn(async () => providerStatus),
    getQuote: jest.fn(async (instrument) => ({
      SPX: liveQuote('SPX', 7746.25),
      SPY: liveQuote('SPY', 774.2, { close: 770 }),
      VIX: liveQuote('VIX', 17.4),
      VVIX: liveQuote('VVIX', 92.1),
    }[instrument.symbol])),
    getHistoricalRecord: jest.fn(async () => historicalRecord),
    getHistoricalBars: loadHistoricalBars || jest.fn(async (instrument, range, interval) => {
      if (instrument.symbol === 'SPX' && range === '11d' && interval === '1h') {
        return multiHistory || { source: 'ibkr', bars };
      }
      if (instrument.symbol === 'SPX' && range === '1d' && interval === '5m') {
        const sameDayBars = bars.filter((bar) => String(bar.timestamp).length > 0
          && newYorkDateKey(bar.timestamp) === currentDate);
        return { source: 'ibkr', bars: sameDayBars.length >= 2 ? sameDayBars : bars.slice(-2) };
      }
      if (instrument.symbol === 'SPX' && range === '5d' && interval === '1d') {
        return { source: 'ibkr', bars: [{ date: sessionDates[sessionDates.length - 1], close: bars[bars.length - 1]?.close }] };
      }
      if (instrument.symbol === 'VIX' && range === '11d' && interval === '1d') {
        return vixHistory || {
          source: 'ibkr',
          asOf: requestDate.toISOString(),
          bars: vixDailyBars(tenSessionDates),
        };
      }
      if (instrument.symbol === 'VVIX' && range === '11d' && interval === '1d') {
        return vvixHistory || { source: 'ibkr', asOf: requestDate.toISOString(), bars: [] };
      }
      return { source: 'ibkr', bars: [] };
    }),
    loadRiskRangeSignal: jest.fn(async () => ({
      name: 'SPX Risk Range', status: 'available', source: 'RiskRangeData', asOf: publishedRiskRangeDate,
      details: {
        ticker: 'SPX', date: publishedRiskRangeDate, lrr: 7674, hrr: 7824,
        previousClose: 7710, trend: 'BULLISH',
      },
    })),
    loadRiskRangeHistory: jest.fn(async ({ ticker, dates }) => ({
      ...(riskHistory || exactRiskHistory(dates)),
      ticker,
    })),
    loadRtaRiskRange: rtaRangeLoader || jest.fn(async () => rtaRange),
  });
}

describe('SPX monitor strict normalizers', () => {
  test('accepts only fresh entitled IBKR live trades', () => {
    expect(resolveVerifiedIbkrQuote(
      liveQuote('SPX', 7746.25, { close: 7700 }),
      { connected: true },
      'SPX',
      NOW.getTime(),
    )).toMatchObject({
      status: 'available', value: 7746.25, previousClose: 7700,
      previousCloseSource: 'ibkr_live_tick_close', source: 'ibkr_live',
    });

    expect(resolveVerifiedIbkrQuote(
      { ...liveQuote('SPX', 7746.25), fromCache: true },
      { connected: true },
      'SPX',
      NOW.getTime(),
    ).status).toBe('unavailable');
    expect(resolveVerifiedIbkrQuote(
      liveQuote('SPX', 7746.25, { dataType: 'delayed' }),
      { connected: true },
      'SPX',
      NOW.getTime(),
    ).status).toBe('unavailable');
    expect(resolveVerifiedIbkrQuote(
      liveQuote('SPX', 7746.25),
      { connected: false },
      'SPX',
      NOW.getTime(),
    ).status).toBe('unavailable');
    expect(resolveVerifiedIbkrQuote(
      liveQuote('SPX', 7746.25, { entitlementStatus: null }),
      { connected: true },
      'SPX',
      NOW.getTime(),
    ).status).toBe('unavailable');
  });

  test('labels a verified daily close at the actual New York cash-close time', () => {
    expect(resolveVerifiedIbkrClose({
      source: 'ibkr',
      bars: [
        { date: '2026-08-14', close: 7700 },
        { date: '2026-08-17', close: 7746.14 },
      ],
    }, '2026-08-17', 'SPX', { connected: true })).toMatchObject({
      status: 'historical',
      value: 7746.14,
      previousClose: 7700,
      previousCloseSource: 'ibkr_historical_daily_close',
      previousCloseAsOf: '2026-08-14',
      asOf: '2026-08-17T20:00:00.000Z',
    });
    expect(resolveVerifiedIbkrClose({
      source: 'ibkr',
      bars: [{ date: '2026-08-17', close: 7746.14 }],
    }, '2026-08-17', 'SPX', { connected: false }).status).toBe('unavailable');
    expect(resolveVerifiedIbkrClose({
      source: 'ibkr',
      fromCache: true,
      bars: [{ date: '2026-08-17', close: 7746.14 }],
    }, '2026-08-17', 'SPX', { connected: true }).status).toBe('unavailable');
  });

  test('selects the unique E-mini S&P row and its 1Y Z-score', () => {
    const result = selectCftcEminiRow(officialCftcSnapshot({
      data: [
        { metric: 'Nasdaq 100', cftcContractMarketCode: '209742', zScore1Y: 0.5 },
        ...officialCftcSnapshot().data,
      ],
    }), NOW.getTime());

    expect(result).toMatchObject({
      status: 'available',
      metric: 'SPX (Index + E-mini)',
      zScore1Y: 1.62,
      zScore3Y: 0.42,
      latest: 123456,
      contractCode: '13874A',
      source: 'cftc-public-reporting-environment',
      contextOnly: true,
    });
  });

  test('explains when only the old unverified CFTC artifact exists', () => {
    expect(selectCftcEminiRow({
      snapshotType: 'cftc-positioning',
      source: 'textract',
      date: '2026-05-06',
      data: [],
    }, NOW.getTime())).toMatchObject({
      status: 'unavailable',
      date: '2026-05-06',
      contextOnly: true,
      reason: expect.stringMatching(/only stored CFTC snapshot.*textract/i),
    });
  });

  test('fails CFTC closed when the exact row is ambiguous or stale', () => {
    const row = officialCftcSnapshot().data[0];
    expect(selectCftcEminiRow(officialCftcSnapshot({
      data: [row, { ...row, metric: 'Duplicate SPX' }],
    }), NOW.getTime()).status).toBe('unavailable');

    expect(selectCftcEminiRow(officialCftcSnapshot({
      date: '2026-07-01', reportDate: '2026-07-01',
      data: [{ ...row, asOf: '2026-07-01' }],
    }), NOW.getTime()).status).toBe('unavailable');
  });

  test('rejects PDF, manual, cached-only, wrong-contract, and invalid official snapshots', () => {
    const row = officialCftcSnapshot().data[0];
    const invalid = [
      officialCftcSnapshot({ source: 'hedgeye-pdf-textract' }),
      officialCftcSnapshot({ source: 'manual' }),
      officialCftcSnapshot({ cacheState: 'stale' }),
      officialCftcSnapshot({ cachedOnly: true }),
      officialCftcSnapshot({ calculationVersion: 'legacy-calculation' }),
      officialCftcSnapshot({ reportDate: '2026-08-04' }),
      officialCftcSnapshot({ data: [{ ...row, cftcContractMarketCode: '138741' }] }),
      officialCftcSnapshot({ data: [{ ...row, status: 'partial', decisionEligible: false }] }),
      officialCftcSnapshot({ data: [{ ...row, asOf: '2026-08-04' }] }),
    ];
    invalid.forEach((snapshot) => {
      expect(selectCftcEminiRow(snapshot, NOW.getTime()).status).toBe('unavailable');
    });
  });

  test('computes time-matched SPY RTH volume against 20 prior sessions', () => {
    const result = normalizeSpyVolume(
      { source: 'ibkr', bars: spyBars() },
      NOW.getTime(),
      'open',
      { connected: true },
    );
    expect(result.status).toBe('available');
    expect(result.comparisonSessions).toBe(20);
    expect(result.currentVolume).toBe(450);
    expect(result.average20).toBe(300);
    expect(result.ratio).toBe(1.5);

    expect(normalizeSpyVolume(
      { source: 'yahoo', bars: spyBars() },
      NOW.getTime(),
      'open',
      { connected: true },
    ).status)
      .toBe('unavailable');
    expect(normalizeSpyVolume(
      { source: 'ibkr', bars: spyBars() },
      NOW.getTime(),
      'open',
      { connected: false },
    ).status).toBe('unavailable');
  });

  test('publishes only a completed, source-dated SPY session close and volume ratio after hours', () => {
    const targetDate = '2026-08-14';
    const priorDates = businessDatesBefore(targetDate, 20);
    const bars = [
      ...spyBars(targetDate),
      ...priorDates.map((date, index) => ({
        date: `${date} 15:55:00`, close: 100 + index, volume: 0,
      })),
      { date: `${targetDate} 15:55:00`, close: 123.45, volume: 0 },
    ];
    const beforeMondayOpen = Date.parse('2026-08-17T12:00:00.000Z');

    expect(normalizeSpyVolume(
      { source: 'ibkr', bars },
      beforeMondayOpen,
      'closed',
      { connected: true },
    )).toMatchObject({
      status: 'historical',
      availability: 'historical',
      historicalThroughDate: targetDate,
      comparisonSessions: 20,
      source: 'ibkr_historical_bars',
    });
    expect(resolveVerifiedIbkrSessionClose(
      { source: 'ibkr', bars },
      targetDate,
      'SPY',
      { connected: true },
    )).toMatchObject({
      status: 'historical',
      availability: 'last_close',
      value: 123.45,
      previousClose: 119,
      source: 'ibkr_historical_intraday_session_close',
      historicalThroughDate: targetDate,
    });
  });

  test('uses verified completed-session VIX and VVIX closes as unscored historical context', async () => {
    const requestNow = new Date('2026-08-17T12:00:00.000Z');
    const sessionDates = ['2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13', '2026-08-14'];
    const history = (previousClose, close) => ({
      source: 'ibkr', asOf: requestNow.toISOString(),
      bars: [
        { date: '2026-08-13', close: previousClose },
        { date: '2026-08-14', close },
      ],
    });
    const service = createFiveDayChartService({
      requestNow,
      sessionDates,
      vixHistory: history(15.2, 14.9),
      vvixHistory: history(91.4, 89.7),
    });

    const snapshot = await service.getSnapshot();

    expect(snapshot.factors.vix).toMatchObject({
      status: 'historical', availability: 'last_close', value: 14.9,
      previousClose: 15.2, historicalThroughDate: '2026-08-14',
      bucket: 'investable', current: false, date: '2026-08-14',
    });
    expect(snapshot.factors.vvix).toMatchObject({
      status: 'historical', availability: 'last_close', value: 89.7,
      previousClose: 91.4, historicalThroughDate: '2026-08-14',
      bucket: null, current: false, date: '2026-08-14',
    });
    expect(snapshot.scoreInputs.vix).toMatchObject({ value: 14.9, current: false });
  });

  test('reads current weekly gamma and breadth from the persisted Market Situation report', () => {
    const report = {
      snapshotType: 'market-structure',
      schemaVersion: 'market-structure-v4',
      contentComplete: true,
      date: '2026-08-17',
      scrapedAt: '2026-08-17T10:30:31.000Z',
      article: { bodyText: 'Dealer positioning remains positive.' },
      data: {
        signals: [
          { id: 'spxGammaExposure', label: 'SPX Gamma Exposure', value: 'Positive' },
          { id: 'systematicFlowRisk', label: 'Systematic Flow Risk', value: 'Neutral' },
          { id: 'pvBandRiskReward', label: 'PV Band Risk/Reward', value: 'Neutral' },
          { id: 'strategicAllocation', label: 'Strategic Allocation', value: 'Risk On' },
        ],
        chartMetrics: {
          spxGammaVolatilityThrottle: {
            gammaThrottle: 12.63,
            tenDayRealizedVolatility: 9.58,
            chartDate: '2026-08-17',
            chartId: 'a'.repeat(64),
            extractionBasis: 'labeled-chart-ocr',
            parserVersion: 'market-structure-chart-metrics-v2',
            source: 'Tier1Alpha.com',
          },
          spxProbableVolatilityGamma: {
            zeroGamma: 7646,
            lowerPvBand: 7573,
            upperPvBand: 7798,
            strikesInPlay: [7600, 7650, 7675, 7700, 7750],
            chartDate: '2026-08-17',
            chartId: 'b'.repeat(64),
            extractionBasis: 'labeled-chart-ocr',
            parserVersion: 'market-structure-chart-metrics-v2',
            source: 'Tier1Alpha.com',
          },
        },
        blocks: [{ type: 'heading', text: 'WEEKLY GAME PLAN: August 17th- 21st' }],
      },
    };

    const result = normalizeMarketStructure(report, '2026-08-18', NOW.getTime());

    expect(result.input).toMatchObject({
      date: '2026-08-17',
      validFrom: '2026-08-17',
      validThrough: '2026-08-21',
      validForDate: '2026-08-18',
      source: 'Market Situation Report',
      gammaExposure: 'positive',
      gammaThrottle: 12.63,
      realizedVol10d: 9.58,
      gammaThrottleDate: '2026-08-17',
      zeroGamma: 7646,
      lowerPvBand: 7573,
      upperPvBand: 7798,
      strikesInPlay: [7600, 7650, 7675, 7700, 7750],
      systematicFlow: 'neutral',
      pvBand: 'neutral',
      strategicAllocation: 'risk_on',
    });
    expect(result.gamma).toMatchObject({
      status: 'available',
      value: 'positive',
      throttle: 12.63,
      realizedVol10d: 9.58,
      metricAsOf: '2026-08-17',
      source: 'Market Situation Report',
    });
    expect(result.breadth).toMatchObject({
      status: 'available',
      systematicFlow: 'neutral',
      pvBand: 'neutral',
      strategicAllocation: 'risk_on',
    });
    expect(result.levels).toMatchObject({
      status: 'available',
      zeroGamma: 7646,
      lowerPvBand: 7573,
      upperPvBand: 7798,
      strikesInPlay: [7600, 7650, 7675, 7700, 7750],
      asOf: '2026-08-17',
      contextOnly: true,
    });
  });

  test('extracts explicitly labeled GVT and 10-day realized volatility from the report narrative', () => {
    const report = {
      snapshotType: 'market-structure',
      schemaVersion: 'market-structure-v4',
      contentComplete: true,
      date: '2026-08-17',
      scrapedAt: '2026-08-17T10:30:31.000Z',
      article: {
        bodyText: 'Our GVT index has risen to 7.04, with a corresponding 10-day realized volatility of 8.71.',
      },
      data: {
        signals: [{ id: 'spxGammaExposure', label: 'SPX Gamma Exposure', value: 'Positive' }],
        blocks: [{ type: 'heading', text: 'WEEKLY GAME PLAN: August 17th- 21st' }],
      },
    };

    const result = normalizeMarketStructure(report, '2026-08-18', NOW.getTime());

    expect(result.input).toMatchObject({
      gammaThrottle: 7.04,
      realizedVol10d: 8.71,
      gammaThrottleDate: '2026-08-17',
      gammaThrottleSource: 'Market Situation Report narrative',
      gammaThrottleExtraction: 'narrative',
    });
    expect(result.gamma).toMatchObject({
      status: 'available',
      throttle: 7.04,
      realizedVol10d: 8.71,
      metricAsOf: '2026-08-17',
      metricSource: 'Market Situation Report narrative',
    });
  });

  test('rejects incomplete or out-of-window Market Situation signals', () => {
    const report = {
      snapshotType: 'market-structure',
      contentComplete: true,
      date: '2026-08-17',
      article: { bodyText: 'GVT index at 12.63.' },
      data: {
        signals: [{ id: 'spxGammaExposure', value: 'Positive' }],
        blocks: [{ type: 'heading', text: 'WEEKLY GAME PLAN: August 17th- 21st' }],
      },
    };

    expect(normalizeMarketStructure(report, '2026-08-24', NOW.getTime())).toMatchObject({
      gamma: { status: 'unavailable' },
      breadth: { status: 'unavailable' },
      input: { validForDate: null, gammaExposure: null, gammaThrottle: null },
    });
    expect(normalizeMarketStructure({ ...report, contentComplete: false }, '2026-08-17', NOW.getTime()))
      .toMatchObject({
        gamma: { status: 'unavailable' },
        breadth: { status: 'unavailable' },
      });
    expect(normalizeMarketStructure({
      ...report,
      schemaVersion: 'market-structure-v2',
    }, '2026-08-17', NOW.getTime())).toMatchObject({
      levels: { status: 'unavailable', contextOnly: true },
      input: { zeroGamma: null, upperPvBand: null, lowerPvBand: null },
    });
  });
});

describe('SPX monitor snapshot', () => {
  test('keeps the current daily Risk Range when the optional RTA overlay fails', async () => {
    const service = createFiveDayChartService({
      rtaRangeLoader: jest.fn(async () => {
        throw new Error('RTA feed unavailable');
      }),
    });

    const snapshot = await service.getSnapshot();

    expect(snapshot.riskRange).toMatchObject({
      status: 'available', lrr: 7674, hrr: 7824, previousClose: 7710,
    });
    expect(snapshot.riskRange.refreshFailed).not.toBe(true);
    expect(snapshot.factors.trade).toMatchObject({ status: 'unavailable', date: null });
    expect(snapshot.scoreInputs.trade.date).toBeNull();
  });

  test('shares a slow ten-session chart load across bounded refresh attempts', async () => {
    const sessionDates = ['2026-08-11', '2026-08-12', '2026-08-13', '2026-08-14', '2026-08-17'];
    const tenSessionDates = [
      ...businessDatesBefore(sessionDates[0], 10 - sessionDates.length),
      ...sessionDates,
    ].slice(-10);
    const comparisonDate = businessDatesBefore(tenSessionDates[0], 1)[0];
    const multiBars = spxCashBars([comparisonDate, ...tenSessionDates]);
    let releaseMultiHistory;
    const multiHistory = new Promise((resolve) => {
      releaseMultiHistory = resolve;
    });
    const loadHistoricalBars = jest.fn((instrument, range, interval) => {
      if (instrument.symbol === 'SPX' && range === '11d' && interval === '1h') {
        return multiHistory;
      }
      if (instrument.symbol === 'SPX' && range === '1d' && interval === '5m') {
        return Promise.resolve({ source: 'ibkr', bars: multiBars.slice(-2) });
      }
      return Promise.resolve({ source: 'ibkr', bars: [] });
    });
    const service = createFiveDayChartService({
      sessionDates,
      loadHistoricalBars,
      refreshBudgetMs: 250,
    });

    const first = await service.getSnapshot();

    expect(first.sourceRefreshPending).toBe(true);
    expect(first.chart.status).toBe('available');
    expect(loadHistoricalBars.mock.calls.filter(([, range, interval]) => (
      range === '11d' && interval === '1h'
    ))).toHaveLength(1);

    releaseMultiHistory({ source: 'ibkr', bars: multiBars });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = await service.getSnapshot();

    expect(second.sourceRefreshPending).toBe(false);
    expect(second.chart.variants['10d']).toMatchObject({ status: 'available', range: '10d' });
    expect(loadHistoricalBars.mock.calls.filter(([, range, interval]) => (
      range === '11d' && interval === '1h'
    ))).toHaveLength(1);
  });

  test('returns independent verified sections and preserves incomplete direct books as blank fields', async () => {
    const service = createSpxMonitorService({
      now: () => new Date(NOW),
      getContracts: jest.fn(async () => ({
        ok: true,
        fetchedAt: NOW.toISOString(),
        seriesTicker: 'KXINXU',
        event: {
          ticker: 'KXINXU-26AUG17H1600',
          // ForecastEx resolves the next day; factor research still belongs to
          // the Aug 17 SPX cash session.
          closeTime: '2026-08-18T15:00:00.000Z',
        },
        markets: [
          {
            ticker: 'HIGH', threshold: 7775, yesBid: 0.66, yesAsk: 0.68,
            noBid: 0.32, noAsk: 0.34, yesBidSize: 40, yesAskSize: 50,
            noBidSize: 60, noAskSize: 70, volume24h: 1200, openInterest: 800,
            nativeBook: { complete: true },
          },
          {
            ticker: 'LOW', threshold: 7725, yesBid: 0.85, yesAsk: 0.87,
            noBid: null, noAsk: null, yesBidSize: 20, yesAskSize: 30,
            noBidSize: null, noAskSize: null, volume24h: 900, openInterest: 600,
            nativeBook: { complete: false },
          },
        ],
      })),
      getProviderStatus: jest.fn(async () => ({ connected: true, authenticated: true })),
      getQuote: jest.fn(async (instrument) => ({
        SPX: liveQuote('SPX', 7746.25),
        SPY: liveQuote('SPY', 774.2, { close: 770 }),
        VIX: liveQuote('VIX', 17.4),
        VVIX: liveQuote('VVIX', 92.1),
      }[instrument.symbol])),
      getHistoricalBars: jest.fn(async (instrument, range, interval) => {
        if (instrument.symbol === 'SPX' && range === '1d' && interval === '5m') {
          return {
            source: 'ibkr',
            bars: [
              { date: '2026-08-17 10:50:00', close: 7747 },
              { date: '2026-08-17 10:55:00', close: 7746.5 },
            ],
          };
        }
        if (instrument.symbol === 'SPY') return { source: 'ibkr', bars: spyBars() };
        return { source: 'ibkr', bars: [] };
      }),
      loadRiskRangeSignal: jest.fn(async () => ({
        name: 'SPX Risk Range', status: 'available', source: 'RiskRangeData', asOf: '2026-08-17',
        details: {
          date: '2026-08-17', lrr: 7674, hrr: 7824, previousClose: 7710, trend: 'BULLISH',
        },
      })),
      loadRtaRiskRange: jest.fn(async () => ({ status: 'unavailable' })),
      loadTradeSnapshots: jest.fn(async () => [{
        snapshotType: 'momo-tracker', date: '2026-08-17', scrapedAt: NOW.toISOString(),
        data: { stocks: { SPX: { trade: 'BULLISH' } } },
      }]),
      loadCftcSnapshots: jest.fn(async () => [officialCftcSnapshot({
        data: [{ ...officialCftcSnapshot().data[0], zScore1Y: 1.4 }],
      })]),
      loadMarketStructureSnapshots: jest.fn(async () => [{
        snapshotType: 'market-structure', schemaVersion: 'market-structure-v4',
        contentComplete: true, date: '2026-08-17', scrapedAt: NOW.toISOString(),
        data: {
          SPX: {
            gammaExposure: 'positive', gammaThrottle: 0.72,
            systematicFlowRisk: 'bullish', pvBandRiskReward: 'long', strategicAllocation: 'risk_on',
          },
          chartMetrics: {
            spxGammaVolatilityThrottle: {
              gammaThrottle: 0.72, tenDayRealizedVolatility: 9.58, chartDate: '2026-08-14',
              chartId: 'a'.repeat(64), extractionBasis: 'labeled-chart-ocr',
              parserVersion: 'market-structure-chart-metrics-v2', source: 'Tier1Alpha.com',
            },
            spxProbableVolatilityGamma: {
              zeroGamma: 7646, lowerPvBand: 7573, upperPvBand: 7798,
              strikesInPlay: [7600, 7650, 7675, 7700, 7750], chartDate: '2026-08-14',
              chartId: 'b'.repeat(64), extractionBasis: 'labeled-chart-ocr',
              parserVersion: 'market-structure-chart-metrics-v2', source: 'Tier1Alpha.com',
            },
          },
        },
      }]),
      loadUsdSnapshot: jest.fn(async () => ({
        sourceStatus: 'current', calculationDate: '2026-08-17', timestamp: NOW.toISOString(),
        source: 'DXY / SPX daily log returns',
        correlations: { SPX: { '15D': -0.6, '30D': -0.72, '90D': -0.55 } },
      })),
    });

    const snapshot = await service.getSnapshot();

    expect(snapshot).toMatchObject({
      schemaVersion: 1,
      session: {
        state: 'open',
        date: '2026-08-17',
        openTime: '2026-08-17T13:30:00.000Z',
        closeTime: '2026-08-17T20:00:00.000Z',
        timezone: 'America/New_York',
      },
      spot: { status: 'available', value: 7746.25 },
      riskRange: {
        status: 'available', lrr: 7674, hrr: 7824, previousClose: 7710, trend: 'bullish',
      },
      chart: { status: 'available', source: 'ibkr_historical_bars' },
      factors: {
        cftc: { status: 'available', zScore1Y: 1.4 },
        gamma: {
          status: 'available', value: 'positive', throttle: 0.72,
          realizedVol10d: 9.58, metricAsOf: '2026-08-14',
        },
        gammaLevels: {
          status: 'available', zeroGamma: 7646, lowerPvBand: 7573, upperPvBand: 7798,
          strikesInPlay: [7600, 7650, 7675, 7700, 7750], contextOnly: true,
        },
        spyVolume: { status: 'available', ratio: 1.5 },
        vix: { status: 'available', value: 17.4 },
        vvix: { status: 'available', value: 92.1 },
      },
      contracts: { status: 'available', seriesTicker: 'KXINXU' },
    });
    expect(snapshot.contracts.lines.map((line) => line.ticker)).toEqual(['LOW', 'HIGH']);
    expect(snapshot.contracts.lines[0]).toMatchObject({
      status: 'incomplete',
      yesBid: 0.85,
      noBid: null,
      derivedFields: [],
    });
  });

  test('adds an open-session five-day variant while keeping the top-level 1D contract unchanged', async () => {
    const sessionDates = ['2026-08-11', '2026-08-12', '2026-08-13', '2026-08-14', '2026-08-17'];
    const riskHistory = exactRiskHistory(sessionDates);
    const service = createFiveDayChartService({
      sessionDates,
      riskHistory,
      rtaRange: {
        status: 'available',
        source: 'Hedgeye Real-Time Alert',
        asOf: '2026-08-17T14:45:00.000Z',
        low: 7688,
        high: 7842,
      },
    });

    const snapshot = await service.getSnapshot();
    const fiveDay = snapshot.chart.variants['5d'];

    expect(snapshot.chart).toMatchObject({
      status: 'available',
      range: '1d',
      source: 'ibkr_historical_bars',
      points: expect.any(Array),
      variants: {
        '1d': { status: 'available', range: '1d', source: 'ibkr_historical_bars' },
        '5d': { status: 'available', range: '5d', availability: 'current' },
        '10d': { status: 'available', range: '10d', availability: 'current' },
      },
    });
    expect(snapshot.chart.variants['1d'].points).toEqual(snapshot.chart.points);
    expect(fiveDay.rangeDates).toEqual(sessionDates);
    expect(fiveDay.points).toHaveLength(10);
    expect(fiveDay.dailyRanges.map((range) => range.date)).toEqual(sessionDates);
    expect(fiveDay.dailyRanges[0].references).toEqual([
      expect.objectContaining({ label: 'LRR', value: 7600, source: 'RiskRangeData' }),
      expect.objectContaining({ label: 'HRR', value: 7800, source: 'RiskRangeData' }),
    ]);
    expect(fiveDay.dailyRanges[4].references).toEqual([
      expect.objectContaining({ label: 'LRR', value: 7688, source: 'Hedgeye Real-Time Alert' }),
      expect.objectContaining({ label: 'HRR', value: 7842, source: 'Hedgeye Real-Time Alert' }),
    ]);
    expect(fiveDay.dailyRanges[4].structure).toMatchObject({
      status: 'available', comparisonDate: '2026-08-14', highEvent: 'HH', lowEvent: 'HL',
    });
    expect(snapshot.chart.variants['10d'].rangeDates).toHaveLength(10);
    expect(snapshot.chart.variants['10d'].points).toHaveLength(20);
  });

  test('rolls verified current-session bars into 5D and restores the independent ATH baseline', async () => {
    const currentDate = '2026-08-17';
    const completedDates = businessDatesBefore(currentDate, 10);
    const comparisonDate = completedDates[0];
    const service = createFiveDayChartService({
      multiHistory: { source: 'ibkr', bars: spxCashBars(completedDates) },
      historicalRecord: {
        status: 'available',
        source: 'ibkr',
        asOf: '2026-08-17T15:00:00.000Z',
        throughDate: comparisonDate,
        recordHigh: 7706,
        recordDate: comparisonDate,
        coverage: {
          complete: true,
          startDate: '1957-03-04',
          endDate: comparisonDate,
          headDate: '1957-03-04',
          chunks: 7,
          observations: 17480,
        },
      },
    });

    const snapshot = await service.getSnapshot();
    const fiveDay = snapshot.chart.variants['5d'];
    const tenDay = snapshot.chart.variants['10d'];

    expect(tenDay.rangeDates).toEqual([...completedDates.slice(1), currentDate]);
    expect(tenDay.comparisonDate).toBe(comparisonDate);
    expect(fiveDay).toMatchObject({
      status: 'available',
      availability: 'current',
      rangeDates: ['2026-08-11', '2026-08-12', '2026-08-13', '2026-08-14', currentDate],
    });
    expect(fiveDay.dailyRanges.at(-1)).toMatchObject({
      date: currentDate,
      status: 'available',
      endAt: Date.parse('2026-08-17T20:00:00.000Z'),
    });
    expect(newYorkDateKey(fiveDay.points.at(-1).timestamp)).toBe(currentDate);
    expect(fiveDay.points.at(-1).timestamp).toBeLessThan(fiveDay.dailyRanges.at(-1).endAt);
    expect(fiveDay.ath).toMatchObject({
      status: 'available',
      source: 'ibkr_historical_record',
      baseline: { throughDate: comparisonDate },
    });
  });

  test('places verified completed hourly closes at 4 PM while preserving the 9:30 AM session boundary', async () => {
    const sessionDates = ['2026-08-11', '2026-08-12', '2026-08-13', '2026-08-14', '2026-08-17'];
    const tenSessionDates = [
      ...businessDatesBefore(sessionDates[0], 5),
      ...sessionDates,
    ].slice(-10);
    const comparisonDate = businessDatesBefore(tenSessionDates[0], 1)[0];
    const service = createFiveDayChartService({
      requestNow: new Date('2026-08-18T12:00:00.000Z'),
      sessionDates,
      multiHistory: {
        source: 'ibkr',
        bars: spxHourlyBars([comparisonDate, ...tenSessionDates]),
      },
    });

    const fiveDay = (await service.getSnapshot()).chart.variants['5d'];

    expect(fiveDay.status).toBe('historical');
    fiveDay.dailyRanges.forEach((range) => {
      const sessionPoints = fiveDay.points.filter((point) => newYorkDateKey(point.timestamp) === range.date);
      expect(range.startAt).toBe(Date.parse(`${range.date}T13:30:00.000Z`));
      expect(range.endAt).toBe(Date.parse(`${range.date}T20:00:00.000Z`));
      expect(sessionPoints[0].timestamp).toBe(Date.parse(`${range.date}T14:00:00.000Z`));
      expect(sessionPoints.at(-1).timestamp).toBe(Date.parse(`${range.date}T20:00:00.000Z`));
    });
  });

  test('does not add the current session to 5D from an unverified intraday source', async () => {
    const currentDate = '2026-08-17';
    const completedDates = businessDatesBefore(currentDate, 10);
    const service = createFiveDayChartService({
      loadHistoricalBars: jest.fn(async (instrument, range, interval) => {
        if (instrument.symbol === 'SPX' && range === '11d' && interval === '1h') {
          return { source: 'ibkr', bars: spxCashBars(completedDates) };
        }
        if (instrument.symbol === 'SPX' && range === '1d' && interval === '5m') {
          return { source: 'yahoo', bars: spxCashBars([currentDate]) };
        }
        return { source: 'ibkr', bars: [] };
      }),
    });

    const fiveDay = (await service.getSnapshot()).chart.variants['5d'];

    expect(fiveDay).toMatchObject({
      status: 'historical',
      availability: 'historical',
      rangeDates: completedDates.slice(-5),
    });
    expect(fiveDay.rangeDates).not.toContain(currentDate);
  });

  test('attaches exact-date verified IBKR VIX closes to the ten- and five-session charts', async () => {
    const sessionDates = ['2026-08-11', '2026-08-12', '2026-08-13', '2026-08-14', '2026-08-17'];
    const service = createFiveDayChartService({
      sessionDates,
      riskHistory: exactRiskHistory(sessionDates),
    });

    const snapshot = await service.getSnapshot();
    const fiveDay = snapshot.chart.variants['5d'];
    const tenDay = snapshot.chart.variants['10d'];

    expect(fiveDay.vixCloses).toMatchObject({
      status: 'available',
      availability: 'historical',
      source: 'ibkr_historical_daily_close',
      missingDates: [],
    });
    expect(fiveDay.vixCloses.values.map((row) => row.date)).toEqual(sessionDates);
    expect(fiveDay.vixCloses.values).toHaveLength(5);
    expect(tenDay.vixCloses.values).toHaveLength(10);
  });

  test('keeps exact VIX closes and leaves a missing session explicitly blank', async () => {
    const sessionDates = ['2026-08-11', '2026-08-12', '2026-08-13', '2026-08-14', '2026-08-17'];
    const missingDate = '2026-08-13';
    const service = createFiveDayChartService({
      sessionDates,
      riskHistory: exactRiskHistory(sessionDates),
      vixHistory: {
        source: 'ibkr',
        bars: vixDailyBars(sessionDates).filter((bar) => bar.date !== missingDate),
      },
    });

    const fiveDay = (await service.getSnapshot()).chart.variants['5d'];

    expect(fiveDay.status).toBe('available');
    expect(fiveDay.vixCloses).toMatchObject({
      status: 'partial',
      source: 'ibkr_historical_daily_close',
      missingDates: [missingDate],
    });
    expect(fiveDay.vixCloses.values).toHaveLength(4);
    expect(fiveDay.vixCloses.values).not.toContainEqual(expect.objectContaining({ date: missingDate }));
  });

  test.each([
    ['non-IBKR', { source: 'yahoo' }],
    ['cache-only', { source: 'ibkr', fromCache: true }],
    ['stale', { source: 'ibkr', warning: 'stale response' }],
    ['mock', { source: 'ibkr', provenance: 'mock fixture' }],
    ['seeded', { source: 'ibkr', cacheState: 'seeded' }],
    ['fallback', { source: 'ibkr', error: 'fallback response' }],
    ['offline', { source: 'ibkr', sourceStatus: 'offline' }],
  ])('keeps the SPX chart but returns no VIX closes for %s VIX history', async (_label, metadata) => {
    const sessionDates = ['2026-08-11', '2026-08-12', '2026-08-13', '2026-08-14', '2026-08-17'];
    const service = createFiveDayChartService({
      sessionDates,
      riskHistory: exactRiskHistory(sessionDates),
      vixHistory: { ...metadata, bars: vixDailyBars(sessionDates) },
    });

    const fiveDay = (await service.getSnapshot()).chart.variants['5d'];

    expect(fiveDay.status).toBe('available');
    expect(fiveDay.vixCloses).toMatchObject({
      status: 'unavailable',
      source: null,
      values: [],
    });
  });

  test('classifies each displayed Risk Range against the exact prior session, including a hidden comparison day', async () => {
    const comparisonDate = '2026-08-10';
    const sessionDates = ['2026-08-11', '2026-08-12', '2026-08-13', '2026-08-14', '2026-08-17'];
    const riskHistory = exactRiskHistoryFromRows([
      { date: comparisonDate, lrr: 7600, hrr: 7800 },
      { date: sessionDates[0], lrr: 7610, hrr: 7810 },
      { date: sessionDates[1], lrr: 7600, hrr: 7805 },
      { date: sessionDates[2], lrr: 7600, hrr: 7805 },
      { date: sessionDates[3], lrr: 7590, hrr: 7815 },
      { date: sessionDates[4], lrr: 7605, hrr: 7800 },
    ]);
    const service = createFiveDayChartService({
      requestNow: new Date('2026-08-18T12:00:00.000Z'),
      comparisonDate,
      sessionDates,
      riskHistory,
    });

    const snapshot = await service.getSnapshot();
    const fiveDay = snapshot.chart.variants['5d'];

    expect(fiveDay.comparisonDate).toBe(comparisonDate);
    expect(fiveDay.rangeDates).toEqual(sessionDates);
    expect(fiveDay.dailyRanges.map((range) => range.structure)).toEqual([
      expect.objectContaining({ status: 'available', comparisonDate, highEvent: 'HH', lowEvent: 'HL' }),
      expect.objectContaining({ highEvent: 'LH', lowEvent: 'LL' }),
      expect.objectContaining({ highEvent: 'EH', lowEvent: 'EL' }),
      expect.objectContaining({ highEvent: 'HH', lowEvent: 'LL' }),
      expect.objectContaining({ highEvent: 'LH', lowEvent: 'HL' }),
    ]);
  });

  test('adds strict per-session ATH markers from a complete independent IBKR record baseline', async () => {
    const comparisonDate = '2026-08-10';
    const tenDayComparisonDate = '2026-08-03';
    const sessionDates = ['2026-08-11', '2026-08-12', '2026-08-13', '2026-08-14', '2026-08-17'];
    const allDates = [comparisonDate, ...sessionDates];
    const service = createFiveDayChartService({
      comparisonDate,
      sessionDates,
      riskHistory: exactRiskHistory(allDates),
      historicalRecord: {
        status: 'available',
        source: 'ibkr',
        asOf: '2026-08-17T15:00:00.000Z',
        throughDate: tenDayComparisonDate,
        recordHigh: 7706,
        recordDate: tenDayComparisonDate,
        coverage: {
          complete: true,
          startDate: '1957-03-04',
          endDate: tenDayComparisonDate,
          headDate: '1957-03-04',
          chunks: 7,
          observations: 17480,
        },
      },
    });

    const snapshot = await service.getSnapshot();
    const fiveDay = snapshot.chart.variants['5d'];

    expect(fiveDay.ath).toMatchObject({
      status: 'available',
      source: 'ibkr_historical_record',
      value: 7806,
      date: '2026-08-17',
      baseline: {
        value: 7706,
        date: tenDayComparisonDate,
        throughDate: tenDayComparisonDate,
        source: 'ibkr',
        dataset: 'historical_record',
        coverageComplete: true,
        coverageStart: '1957-03-04',
        coverageEnd: tenDayComparisonDate,
        coverageHead: '1957-03-04',
        chunks: 7,
        observations: 17480,
      },
    });
    expect(fiveDay.ath.markers.map(({ date, value }) => ({ date, value }))).toEqual([
      { date: '2026-08-11', value: 7766 },
      { date: '2026-08-12', value: 7776 },
      { date: '2026-08-13', value: 7786 },
      { date: '2026-08-14', value: 7796 },
      { date: '2026-08-17', value: 7806 },
    ]);
    expect(snapshot.chart.variants['10d'].ath.markers).toHaveLength(10);
    expect(snapshot.chart.variants['10d'].ath.markers.slice(-5)).toEqual(fiveDay.ath.markers);
    expect(snapshot.chart.variants['10d'].ath.value).toBe(7806);
    expect(snapshot.chart.variants['10d'].ath.date).toBe('2026-08-17');
    expect(snapshot.chart.variants['1d'].ath).toMatchObject({
      status: 'available',
      source: 'ibkr_historical_record',
      value: 7806,
    });
  });

  test.each([
    ['cache-only record', { fromCache: true }],
    ['mock record', { provenance: 'mock fixture' }],
    ['stale record', { warning: 'stale response' }],
  ])('keeps verified five-day prices but withholds a %s', async (_label, forbidden) => {
    const comparisonDate = '2026-08-10';
    const sessionDates = ['2026-08-11', '2026-08-12', '2026-08-13', '2026-08-14', '2026-08-17'];
    const service = createFiveDayChartService({
      comparisonDate,
      sessionDates,
      riskHistory: exactRiskHistory([comparisonDate, ...sessionDates]),
      historicalRecord: {
        status: 'available', source: 'ibkr', throughDate: comparisonDate,
        recordHigh: 7706, recordDate: comparisonDate,
        coverage: {
          complete: true, startDate: '1957-03-04', endDate: comparisonDate,
          headDate: '1957-03-04', chunks: 7, observations: 17480,
        },
        ...forbidden,
      },
    });

    const fiveDay = (await service.getSnapshot()).chart.variants['5d'];

    expect(fiveDay.status).toBe('available');
    expect(fiveDay.points).toHaveLength(10);
    expect(fiveDay.ath).toMatchObject({ status: 'unavailable', markers: [] });
  });

  test('uses the five latest completed bar dates before the session and skips absent holiday dates', async () => {
    const sessionDates = ['2026-08-07', '2026-08-10', '2026-08-11', '2026-08-13', '2026-08-14'];
    const service = createFiveDayChartService({
      requestNow: new Date('2026-08-17T12:00:00.000Z'),
      sessionDates,
      riskHistory: exactRiskHistory(sessionDates),
    });

    const snapshot = await service.getSnapshot();

    expect(snapshot.session.state).toBe('closed');
    expect(snapshot.chart.variants['5d']).toMatchObject({
      status: 'historical',
      availability: 'historical',
      rangeDates: sessionDates,
    });
    expect(snapshot.chart.variants['5d'].dailyRanges.map((range) => range.date)).toEqual(sessionDates);
    expect(snapshot.chart.variants['5d'].rangeDates).not.toContain('2026-08-12');
  });

  test('fills the latest completed-session overlay from the exact-date daily Risk Range on a weekend', async () => {
    const sessionDates = ['2026-08-24', '2026-08-25', '2026-08-26', '2026-08-27', '2026-08-28'];
    const service = createFiveDayChartService({
      requestNow: new Date('2026-08-30T18:00:00.000Z'),
      sessionDates,
      riskRangeDate: '2026-08-28',
      riskHistory: exactRiskHistory(sessionDates, ['2026-08-28']),
    });

    const snapshot = await service.getSnapshot();
    const fiveDay = snapshot.chart.variants['5d'];
    const latestRange = fiveDay.dailyRanges.at(-1);

    expect(snapshot.session.state).toBe('closed');
    expect(fiveDay).toMatchObject({
      status: 'historical',
      historicalThroughDate: '2026-08-28',
      riskRangeStatus: 'available',
      riskRangeMissingDates: [],
    });
    expect(latestRange).toMatchObject({ date: '2026-08-28', status: 'available' });
    expect(latestRange.references).toEqual([
      expect.objectContaining({ label: 'LRR', value: 7674, source: 'RiskRangeData', asOf: '2026-08-28' }),
      expect.objectContaining({ label: 'HRR', value: 7824, source: 'RiskRangeData', asOf: '2026-08-28' }),
    ]);
  });

  test('does not impose an RTA range on a five-day section when its published date is not today', async () => {
    const sessionDates = ['2026-08-11', '2026-08-12', '2026-08-13', '2026-08-14', '2026-08-17'];
    const service = createFiveDayChartService({
      sessionDates,
      riskHistory: exactRiskHistory(sessionDates),
      riskRangeDate: '2026-08-14',
      rtaRange: {
        status: 'available', source: 'Hedgeye Real-Time Alert',
        asOf: '2026-08-14T19:00:00.000Z', low: 7688, high: 7842,
      },
    });

    const todayRange = (await service.getSnapshot()).chart.variants['5d'].dailyRanges[4];

    expect(todayRange.references).toEqual([
      expect.objectContaining({ label: 'LRR', value: 7640, source: 'RiskRangeData' }),
      expect.objectContaining({ label: 'HRR', value: 7840, source: 'RiskRangeData' }),
    ]);
  });

  test('keeps verified five-day prices when one exact-date Risk Range is unavailable', async () => {
    const sessionDates = ['2026-08-11', '2026-08-12', '2026-08-13', '2026-08-14', '2026-08-17'];
    const missingDate = '2026-08-13';
    const service = createFiveDayChartService({
      sessionDates,
      riskHistory: exactRiskHistory(sessionDates, [missingDate]),
    });

    const fiveDay = (await service.getSnapshot()).chart.variants['5d'];

    expect(fiveDay).toMatchObject({
      status: 'available',
      riskRangeStatus: 'partial',
      riskRangeMissingDates: [missingDate],
    });
    expect(fiveDay.points).toHaveLength(10);
    expect(fiveDay.dailyRanges.find((range) => range.date === missingDate)).toMatchObject({
      status: 'unavailable',
      references: [],
    });
  });

  test.each([
    ['non-IBKR', { source: 'yahoo' }],
    ['cache-only', { source: 'ibkr', fromCache: true }],
    ['stale', { source: 'ibkr', warning: 'stale response' }],
    ['mock', { source: 'ibkr', provenance: 'mock fixture' }],
    ['seeded', { source: 'ibkr', cacheState: 'seeded' }],
    ['fallback', { source: 'ibkr', error: 'fallback response' }],
    ['offline', { source: 'ibkr', error: 'IBKR offline' }],
  ])('returns an empty 5D variant for %s history without clearing valid 1D bars', async (_label, metadata) => {
    const sessionDates = ['2026-08-11', '2026-08-12', '2026-08-13', '2026-08-14', '2026-08-17'];
    const service = createFiveDayChartService({
      sessionDates,
      multiHistory: { ...metadata, bars: spxCashBars(sessionDates) },
      riskHistory: exactRiskHistory(sessionDates),
    });

    const snapshot = await service.getSnapshot();

    expect(snapshot.chart.status).toBe('available');
    expect(snapshot.chart.points.length).toBeGreaterThanOrEqual(2);
    expect(snapshot.chart.variants['5d']).toMatchObject({ status: 'unavailable', points: [] });
  });

  test('rejects an otherwise valid open-session five-day series when its latest bar is stale', async () => {
    const sessionDates = [...businessDatesBefore('2026-08-17', 9), '2026-08-17'];
    const staleBars = spxCashBars(sessionDates);
    staleBars[staleBars.length - 2] = { timestamp: Date.parse('2026-08-17T13:30:00.000Z'), close: 7740 };
    staleBars[staleBars.length - 1] = { timestamp: Date.parse('2026-08-17T13:35:00.000Z'), close: 7742 };
    const service = createFiveDayChartService({
      sessionDates,
      loadHistoricalBars: jest.fn(async (instrument, range, interval) => {
        if (instrument.symbol === 'SPX' && range === '11d' && interval === '1h') {
          return { source: 'ibkr', bars: staleBars };
        }
        if (instrument.symbol === 'SPX' && range === '1d' && interval === '5m') {
          return { source: 'ibkr', bars: staleBars.slice(-2) };
        }
        return { source: 'ibkr', bars: [] };
      }),
      riskHistory: exactRiskHistory(sessionDates),
    });

    expect((await service.getSnapshot()).chart.variants['5d']).toMatchObject({
      status: 'unavailable',
      points: [],
      reason: 'Current-session IBKR SPX history is stale.',
    });
  });

  test('clears 5D for a disconnected provider or fewer than five usable sessions', async () => {
    const completeDates = ['2026-08-11', '2026-08-12', '2026-08-13', '2026-08-14', '2026-08-17'];
    const disconnected = createFiveDayChartService({
      sessionDates: completeDates,
      providerStatus: { connected: false },
      riskHistory: exactRiskHistory(completeDates),
    });
    const insufficientDates = completeDates.slice(1);
    const insufficient = createFiveDayChartService({
      sessionDates: insufficientDates,
      comparisonDate: null,
      riskHistory: exactRiskHistory(insufficientDates),
    });

    const [disconnectedSnapshot, insufficientSnapshot] = await Promise.all([
      disconnected.getSnapshot(),
      insufficient.getSnapshot(),
    ]);

    expect(disconnectedSnapshot.chart.variants['5d']).toMatchObject({ status: 'unavailable', points: [] });
    expect(insufficientSnapshot.chart.variants['5d']).toMatchObject({ status: 'unavailable', points: [] });
  });
});
