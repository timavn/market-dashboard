import React, { act } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import PersistentSurface from '../common/PersistentSurface';
import PredictionMarketResolverTest, {
  ChartTooltip,
  buildContractTradingClock,
  buildFiveDayChartLayout,
  buildGoldLadderProximityLevels,
  buildLadderProximityLevels,
  buildLiveFesPositionMap,
  buildMultiDayChartLayout,
  buildIntradayTimeAxis,
  buildSpxPriceAxis,
  buildSpxContractAnalyses,
  calculateRiskRangeStructureScore,
  clampChartReferenceValue,
  expandSpxPriceAxis,
  formatSpotMarker,
  getMonitorVenueAvailability,
  isGoldCorrelationSnapshotUsable,
  isVerifiedDelayedSpxHeaderReference,
  isSpxMonitorSectionUsable,
  mergeSpxMonitorSnapshots,
  normalizeLivePositionOverlayPayload,
  normalizeGoldCorrelationSnapshot,
  normalizeGoldHeaderMarketReference,
  normalizeMomoTrackerSnapshot,
  normalizeVerifiedMomoTrackerSpots,
  normalizeVerifiedSpxHeaderQuotes,
  parseLiveFesPosition,
  projectOverlayPointsToSessions,
  resolveAthReferenceDate,
  resolveAthReferenceValue,
  resolveChartLabelOffsets,
  resolveVerifiedGoldSettlements,
  resolveVerifiedGoldSettlementTime,
  resolveVerifiedVixCloses,
  SettlementIdentityChips,
  selectContractLinesForReference,
  selectContractLinesAroundSpot,
  stabilizeGoldHeaderMarketReferences,
  stabilizeSpxHeaderMarketReferences,
  withCanonicalGoldCorrelationFactor,
} from './PredictionMarketResolverTest';
import { MarketDataService } from '../../services/api/marketDataService';
import predictionMarketTestService from '../../services/api/predictionMarketTestService';
import { resetSessionResourceStore } from '../../utils/sessionResourceStore';
import { startVisibilityAwarePolling } from '../../utils/visibilityAwarePolling';

// @testing-library/react 13 resolves its compatibility wrapper through the
// deprecated react-dom/test-utils entry point. Bind that wrapper to React 18's
// supported act implementation so this suite exercises the same semantics
// without emitting the framework deprecation warning.
jest.mock('react-dom/test-utils', () => ({
  ...jest.requireActual('react-dom/test-utils'),
  act: jest.requireActual('react').act,
}));

jest.mock('../../services/api/marketDataService', () => ({
  MarketDataService: {
    getPortfolioPredictionMarketPositions: jest.fn(),
    getProviderStatus: jest.fn(),
    getQuotes: jest.fn(),
    getHedgeyeSnapshot: jest.fn(),
    getGoldCorrelations: jest.fn(),
  },
}));

jest.mock('../../services/api/predictionMarketTestService', () => ({
  __esModule: true,
  default: { getMonitor: jest.fn() },
}));

jest.mock('../../utils/visibilityAwarePolling', () => ({
  startVisibilityAwarePolling: jest.fn(() => jest.fn()),
}));

const NOW = Date.parse('2026-08-17T15:00:00.000Z');
const FUTURE = '2026-08-17T15:10:00.000Z';

function goldCorrelationFixture(overrides = {}) {
  const values = { '15D': -0.78, '30D': -0.84, '90D': -0.72, '120D': -0.66, '180D': -0.59 };
  const definitions = [
    ['DXY', 'DXY', 'DXY', 'price_return', 'Yahoo Finance DX-Y.NYB completed daily closes', 'index', 98.42],
    ['UST10Y_REAL', 'U.S. 10Y Real', 'DFII10', 'yield_change_bps', 'FRED DFII10 daily observations', 'percent', 1.82],
    ['UST10Y_NOMINAL', 'U.S. 10Y Nominal', 'DGS10', 'yield_change_bps', 'FRED DGS10 daily observations', 'percent', 4.23],
    ['SPX', 'S&P 500', 'SPX', 'price_return', 'Yahoo Finance ^GSPC completed daily closes', 'index', 6425.12],
    ['SILVER', 'Silver', 'SILVER', 'price_return', 'Yahoo Finance SI=F completed daily closes', 'USD/ozt', 38.44],
    ['CRB', 'CRB', 'CRB', 'price_return', 'Yahoo Finance ^TRCCRB completed daily closes', 'index', 301.17],
    ['WTI', 'WTI', 'WTI', 'price_return', 'Yahoo Finance CL=F completed daily closes', 'USD/bbl', 64.01],
  ];
  return {
    schemaVersion: 1,
    status: 'available',
    method: 'pearson_completed_daily_changes',
    horizons: ['15D', '30D', '90D', '120D', '180D'],
    basis: {
      symbol: 'XAUUSD', label: 'IBKR XAUUSD Spot Gold', role: 'proxy', status: 'available',
      source: 'IBKR completed daily midpoint bars', asOf: '2026-08-14', unit: 'USD/ozt',
    },
    rows: definitions.map(([key, label, symbol, transform, source, unit, latestValue], index) => ({
      key, label, symbol, transform, source, status: 'available', asOf: '2026-08-14',
      observations: 180,
      latest: { value: latestValue, asOf: '2026-08-14', unit },
      values: Object.fromEntries(Object.entries(values).map(([horizon, value]) => [
        horizon, Number((value + index * 0.11).toFixed(2)),
      ])),
      reason: null,
    })),
    timestamp: new Date(NOW).toISOString(),
    calculationDate: '2026-08-14',
    reason: null,
    ...overrides,
  };
}

const nativeResizeObserver = global.ResizeObserver;

class ResizeObserverMock {
  constructor(callback) {
    this.callback = callback;
  }

  observe(target) {
    this.callback([{ target, contentRect: { width: 720, height: 260 } }]);
  }

  unobserve() {}

  disconnect() {}
}

function factor(status, values = {}) {
  return {
    status,
    source: values.source || 'verified-test-source',
    asOf: values.asOf || '2026-08-17T14:59:00.000Z',
    expiresAt: status === 'available' ? FUTURE : null,
    ...values,
  };
}

function verifiedVixCloses(dates, base = 15.1) {
  return {
    status: 'available',
    availability: 'historical',
    source: 'ibkr_historical_daily_close',
    asOf: '2026-08-17T20:05:00.000Z',
    values: dates.map((date, index) => ({
      date,
      value: Number((base + (index * 0.2)).toFixed(2)),
    })),
    missingDates: [],
    reason: null,
  };
}

function fiveDayChartFixture({
  missingDate = null,
  status = 'available',
  ath = null,
  vixCloses = null,
  dates: requestedDates = null,
} = {}) {
  const dates = requestedDates || ['2026-08-11', '2026-08-12', '2026-08-13', '2026-08-14', '2026-08-17'];
  const points = dates.flatMap((date, index) => [
    { timestamp: Date.parse(`${date}T14:50:00.000Z`), value: 7700 + (index * 10), high: 7702 + (index * 10) },
    { timestamp: Date.parse(`${date}T14:55:00.000Z`), value: 7704 + (index * 10), high: 7706 + (index * 10) },
  ]);
  return factor(status, {
    range: '5d',
    availability: status === 'available' ? 'current' : 'unavailable',
    source: status === 'available' ? 'ibkr_historical_bars' : null,
    latestValue: status === 'available' ? 7744 : null,
    latestAt: status === 'available' ? '2026-08-17T14:55:00.000Z' : null,
    points: status === 'available' ? points : [],
    rangeDates: status === 'available' ? dates : [],
    dailyRanges: status === 'available' ? dates.map((date, index) => {
      const dayPoints = points.slice(index * 2, (index * 2) + 2);
      const unavailable = date === missingDate;
      return {
        date,
        startAt: dayPoints[0].timestamp,
        endAt: dayPoints[1].timestamp,
        status: unavailable ? 'unavailable' : 'available',
        references: unavailable ? [] : [
          { status: 'available', label: 'LRR', tone: 'low', value: 7600 + (index * 10), source: 'RiskRangeData', asOf: date },
          { status: 'available', label: 'HRR', tone: 'high', value: 7800 + (index * 10), source: 'RiskRangeData', asOf: date },
        ],
        structure: unavailable ? {
          status: 'unavailable', basis: 'risk_range_endpoints', comparisonDate: null,
          highEvent: null, lowEvent: null,
        } : {
          status: 'available', basis: 'risk_range_endpoints',
          comparisonDate: index === 0 ? '2026-08-10' : dates[index - 1],
          highEvent: 'HH', lowEvent: 'HL',
        },
        reason: unavailable ? `Exact-date Risk Range data is unavailable for ${date}.` : null,
      };
    }) : [],
    riskRangeStatus: missingDate ? 'partial' : status === 'available' ? 'available' : 'unavailable',
    riskRangeMissingDates: missingDate ? [missingDate] : [],
    vixCloses: vixCloses || (status === 'available'
      ? verifiedVixCloses(dates)
      : { status: 'unavailable', availability: 'unavailable', source: null, values: [], missingDates: dates }),
    ath: ath || (status === 'available' ? {
      status: 'available', source: 'ibkr_historical_record', asOf: '2026-08-17T15:00:00.000Z',
      baseline: { value: 7790, date: '2026-08-10', throughDate: '2026-08-10' },
      markers: [], reason: null,
    } : {
      status: 'unavailable', source: null, baseline: null, markers: [], reason: 'Unavailable',
    }),
  });
}

function tenDayChartFixture({
  status = 'available', base = 7650, fit = 'exact', ath = null, vixCloses = null,
  dates: requestedDates = null,
} = {}) {
  const dates = requestedDates || ['2026-08-04', '2026-08-05', '2026-08-06', '2026-08-07', '2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13', '2026-08-14', '2026-08-17'];
  const points = dates.flatMap((date, index) => [
    { timestamp: Date.parse(`${date}T13:30:00.000Z`), value: base + (index * 2) },
    { timestamp: Date.parse(`${date}T19:55:00.000Z`), value: base + (index * 2) + 1 },
  ]);
  return factor(status, {
    range: '10d',
    interval: '1h',
    availability: status === 'available' ? 'current' : 'unavailable',
    source: status === 'available' ? 'ibkr_historical_bars' : null,
    fit,
    latestValue: status === 'available' ? points[points.length - 1].value : null,
    latestAt: status === 'available' ? new Date(points[points.length - 1].timestamp).toISOString() : null,
    points: status === 'available' ? points : [],
    rangeDates: status === 'available' ? dates : [],
    dailyRanges: status === 'available' ? dates.map((date, index) => ({
      date,
      startAt: points[index * 2].timestamp,
      endAt: points[(index * 2) + 1].timestamp,
      status: 'available',
      references: [
        { status: 'available', label: 'LRR', value: base - 10 + index, source: 'RiskRangeData', asOf: date },
        { status: 'available', label: 'HRR', value: base + 30 + index, source: 'RiskRangeData', asOf: date },
      ],
    })) : [],
    riskRangeStatus: status === 'available' ? 'available' : 'unavailable',
    riskRangeMissingDates: [],
    vixCloses: vixCloses || (status === 'available'
      ? verifiedVixCloses(dates, 14.2)
      : { status: 'unavailable', availability: 'unavailable', source: null, values: [], missingDates: dates }),
    ath: ath || (status === 'available'
      ? { status: 'available', source: 'ibkr_historical_record', markers: [], baseline: { value: base + 100 } }
      : { status: 'unavailable', source: null, markers: [], baseline: null }),
  });
}

function chartLayoutFixture(dates) {
  const points = dates.flatMap((date, index) => [
    { timestamp: Date.parse(`${date}T15:00:00.000Z`), value: 7700 + index },
    { timestamp: Date.parse(`${date}T20:00:00.000Z`), value: 7701 + index },
  ]);
  return {
    points,
    dailyRanges: dates.map((date, index) => ({
      date,
      startAt: points[index * 2].timestamp,
      endAt: points[(index * 2) + 1].timestamp,
      status: 'available',
      references: [],
    })),
  };
}

function monitorSnapshot(overrides = {}) {
  const snapshot = {
    schemaVersion: 2,
    marketId: 'sp500',
    generatedAt: '2026-08-17T15:00:00.000Z',
    status: 'available',
    session: {
      state: 'open',
      asOf: '2026-08-17T15:00:00.000Z',
      date: '2026-08-17',
      openTime: '2026-08-17T13:30:00.000Z',
      closeTime: '2026-08-17T20:00:00.000Z',
      timezone: 'America/New_York',
    },
    spot: factor('available', {
      value: 7746.25,
      previousClose: 7700,
      previousCloseSource: 'ibkr_live_tick_close',
      availability: 'live',
      fit: 'exact',
      source: 'ibkr_live',
      label: 'LIVE SPX',
    }),
    spySpot: factor('available', {
      value: 774.2,
      previousClose: 770,
      previousCloseSource: 'ibkr_live_tick_close',
      availability: 'live',
      fit: 'exact',
      source: 'ibkr_live',
      label: 'LIVE SPY',
    }),
    chart: factor('available', {
      source: 'ibkr_historical_bars',
      latestValue: 7746.25,
      latestAt: '2026-08-17T14:59:00.000Z',
      points: [
        { timestamp: Date.parse('2026-08-17T14:50:00.000Z'), value: 7753 },
        { timestamp: Date.parse('2026-08-17T14:55:00.000Z'), value: 7749 },
        { timestamp: Date.parse('2026-08-17T14:59:00.000Z'), value: 7746.25 },
      ],
      references: [],
    }),
    riskRange: factor('available', {
      source: 'RiskRangeData', lrr: 7674, hrr: 7824, trend: 'bullish', date: '2026-08-17',
    }),
    factors: {
      usd: factor('available', { r15: -0.6, r30: -0.72, r90: -0.55, sourceStatus: 'current', date: '2026-08-17' }),
      cftc: factor('available', {
        zScore1Y: 1.4, zScore3Y: 0.8, latest: -407, weeklyChange: -25834, asOf: '2026-08-11',
      }),
      gamma: factor('available', {
        value: 'positive', throttle: 0.72, realizedVol10d: 9.58,
        metricAsOf: '2026-08-14', metricSource: 'Market Situation Report chart OCR · Tier1Alpha.com',
      }),
      gammaLevels: factor('available', {
        zeroGamma: 7646, lowerPvBand: 7573, upperPvBand: 7798,
        strikesInPlay: [7600, 7650, 7675, 7700, 7750],
        source: 'Market Situation Report chart OCR · Tier1Alpha.com', asOf: '2026-08-14', contextOnly: true,
      }),
      spyVolume: factor('available', { ratio: 1.5 }),
      vix: factor('available', { value: 17.4, bucket: 'investable', current: true, date: '2026-08-17' }),
      vvix: factor('available', { value: 92.1, current: true, date: '2026-08-17' }),
      structure: factor('available', { systematicFlow: 'bullish', pvBand: 'long', strategicAllocation: 'risk_on' }),
      trade: factor('available', { direction: 'bullish', raw: 'BULLISH', date: '2026-08-17' }),
    },
    scoreInputs: {
      targetDate: '2026-08-17',
      riskRange: { lrr: 7674, hrr: 7824, trend: 'bullish', date: '2026-08-17' },
      trade: { direction: 'bullish', raw: 'BULLISH', date: '2026-08-17' },
      usd: { date: '2026-08-17', sourceStatus: 'current', r15: -0.6, r30: -0.72, r90: -0.55 },
      vix: { value: 17.4, bucket: 'investable', current: true, date: '2026-08-17' },
      marketStructure: {
        date: '2026-08-17', gammaExposure: 'positive', gammaThrottle: 0.72,
        systematicFlow: 'bullish', pvBand: 'long', strategicAllocation: 'risk_on',
      },
    },
    resolverReference: {
      status: 'available',
      resolver: 'CME ESU26 dated E-mini S&P 500 future',
      instrument: { symbol: 'ES', displaySymbol: 'ESU26', lastTradeDateOrContractMonth: '202609' },
      spot: factor('available', {
        availability: 'live', fit: 'exact', value: 7746.25, label: 'ESU26',
        source: 'ibkr_live_native_quote', executable: false,
      }),
      chart: factor('available', {
        availability: 'live', fit: 'exact', points: [],
        source: 'ibkr_historical_bars', executable: false,
      }),
    },
    contracts: factor('available', {
      source: 'ibkr_tws_forecastex_live',
      seriesTicker: 'FES',
      event: {
        ticker: 'FES_081726', generationId: 'FES_081726', venueId: 'forecastex',
        productCode: 'FES', title: 'S&P 500 Futures Price', status: 'open',
        measurementDate: '2026-08-17', closeTime: '2026-08-17T20:00:00.000Z',
        observationTime: '2026-08-17T20:00:00.000Z', timezone: 'America/Chicago',
        lastTradeAt: '2026-08-17T20:00:00.000Z',
        resolutionAt: '2026-08-20T15:00:00.000Z', payoutAt: '2026-08-20T17:00:00.000Z',
        payoutAmount: 1,
        resolverSymbol: 'ESU26', resolverContractMonth: '202609',
        rulesUrl: 'https://data.forecastex.com/regulatory/FESTermsandConditions.pdf',
      },
      lines: [
        {
          ticker: 'FES_081726_7775', contractId: 'FES_081726_7775', productId: 'FES',
          threshold: 7775, status: 'available',
          source: 'ibkr_tws_forecastex_live', directNative: true, derivedFields: [],
          yesBid: 0.66, yesAsk: 0.68, noBid: 0.32, noAsk: 0.34,
          yesBidSize: 40, yesAskSize: 50, noBidSize: 60, noAskSize: 70,
          volume24h: 1200, openInterest: 800,
        },
        {
          ticker: 'FES_081726_7725', contractId: 'FES_081726_7725', productId: 'FES',
          threshold: 7725, status: 'available',
          source: 'ibkr_tws_forecastex_live', directNative: true, derivedFields: [],
          yesBid: 0.85, yesAsk: 0.87, noBid: 0.13, noAsk: 0.15,
          yesBidSize: 20, yesAskSize: 30, noBidSize: 35, noAskSize: 25,
          volume24h: 900, openInterest: 600,
        },
      ],
    }),
    errors: [],
  };
  snapshot.chart = {
    ...snapshot.chart,
    range: '1d',
    variants: {
      '1d': { ...snapshot.chart, range: '1d' },
      '5d': fiveDayChartFixture(),
      '10d': tenDayChartFixture(),
    },
  };
  const merged = { ...snapshot, ...overrides };
  const forecastContracts = merged.contracts;
  const forecastVenue = {
    id: 'forecastex',
    label: 'ForecastEx',
    status: forecastContracts.status,
    resolver: {
      underlying: 'cme_es_dated_future',
      resolver: 'forecastex_fes_cme_es_daily_settlement',
      observationTime: 'CME official daily settlement',
    },
    settlementBasis: {
      status: 'verified', instrument: 'ESU26', method: 'Official daily settlement',
      observationAt: '2026-08-17T20:00:00.000Z', sourceName: 'CME',
      sourceUrl: 'https://www.cmegroup.com/markets/equities.html',
      rulesUrl: 'https://data.forecastex.com/regulatory/FESTermsandConditions.pdf', reason: null,
    },
    brokerRoutable: true,
    generationId: forecastContracts.event?.generationId || null,
    catalog: forecastContracts,
    book: forecastContracts,
    contracts: forecastContracts,
  };
  return {
    ...merged,
    venues: overrides.venues || { forecastex: forecastVenue },
    generationOptions: [],
    selectedGeneration: null,
    selectedGenerationId: forecastContracts.event?.generationId || null,
    selectedVenueId: 'forecastex',
    autoSelection: overrides.autoSelection || {
      status: forecastContracts.status,
      mode: 'most_executable',
      venueId: 'forecastex',
      label: 'ForecastEx FES live book',
      reason: 'The fixed ForecastEx FES book is verified through IBKR.',
      contracts: forecastContracts,
    },
    displaySelection: overrides.displaySelection || {
      status: 'available', mode: 'executable', venueId: 'forecastex', label: 'ForecastEx FES',
      reason: 'The fixed ForecastEx FES book is verified through IBKR.', contracts: forecastContracts,
    },
    displayContracts: overrides.displayContracts || forecastContracts,
    refresh: overrides.refresh || { state: 'idle', revision: 1, suggestedNextPollMs: 30_000 },
    strategy: overrides.strategy || {
      status: 'unavailable', model: null, eligibleVenueId: null, eligibleSeriesTicker: null,
      reason: 'No validated ForecastEx FES strategy or sizing model is configured.',
    },
  };
}

function genericMonitorSnapshot(marketId, { lineCount = 3, spotValue = null } = {}) {
  const definitions = {
    wti: { label: 'WTI Oil', symbol: 'WTI', seriesTicker: 'KXWTI', start: 75, step: 0.5 },
    nasdaq100: { label: 'Nasdaq-100', symbol: 'NDX', seriesTicker: 'KXNASDAQ100U', start: 27000, step: 50 },
    gold: { label: 'Gold', symbol: 'GOLD', seriesTicker: 'KXGOLDD', start: 4100, step: 10 },
    silver: { label: 'Silver', symbol: 'SILVER', seriesTicker: 'KXSILVERW', start: 70, step: 1 },
    brent: { label: 'Brent Oil', symbol: 'BRENT', seriesTicker: 'KXBRENTD', start: 85, step: 0.5 },
    bitcoin: { label: 'Bitcoin', symbol: 'BTC', seriesTicker: 'KXBTCD', start: 115000, step: 1000 },
  };
  const definition = definitions[marketId];
  const settlementDefinitions = {
    wti: { instrument: 'WBS 26U-ICE', method: 'Official daily settlement', sourceName: 'ICE', sourceUrl: 'https://www.theice.com/products/213/WTI-Crude-Futures' },
    gold: { instrument: 'Metal.Index.GOLD/USD', method: '1-minute close', sourceName: 'Pyth', sourceUrl: 'https://app.pyth.com/explore/Metal.Index.GOLD%2FUSD' },
    silver: { instrument: 'Metal.Index.SILVER/USD', method: '1-minute close', sourceName: 'Pyth', sourceUrl: 'https://app.pyth.com/explore/Metal.Index.SILVER%2FUSD' },
    brent: { instrument: 'Commodities.Index.BRENT/USD', method: '1-minute close', sourceName: 'Pyth', sourceUrl: 'https://app.pyth.com/explore/Commodities.Index.BRENT%2FUSD' },
    bitcoin: { instrument: 'BRTI', method: 'Final-minute 60-sample average', sourceName: 'CF Benchmarks', sourceUrl: 'https://www.cfbenchmarks.com/data/indices/BRTI' },
  };
  const lines = Array.from({ length: lineCount }, (_, index) => ({
    ticker: `${definition.seriesTicker}-${index}`,
    threshold: definition.start + index * definition.step,
    lowerBound: definition.start + index * definition.step,
    upperBound: null,
    comparator: '>',
    status: 'available',
    yesBid: 0.40,
    yesAsk: 0.42,
    noBid: 0.58,
    noAsk: 0.60,
    yesBidSize: 20,
    yesAskSize: 20,
    noBidSize: 20,
    noAskSize: 20,
    volume24h: 100 + index,
    openInterest: 200 + index,
    updatedAt: '2026-08-17T14:59:00.000Z',
    directNative: true,
    derivedFields: [],
  }));
  const contracts = factor('available', {
    source: 'kalshi_trade_api_v2',
    seriesTicker: definition.seriesTicker,
    event: {
      ticker: `${definition.seriesTicker}-26AUG17`,
      generationId: `${definition.seriesTicker}-26AUG17`,
      status: 'open',
      openTime: '2026-08-17T13:00:00.000Z',
      closeTime: '2026-08-17T20:00:00.000Z',
      timezone: 'America/New_York',
    },
    lines,
  });
  const spot = spotValue == null
    ? factor('unavailable', { value: null, label: definition.symbol })
    : factor('available', { value: spotValue, label: `LIVE ${definition.symbol}` });
  const chart = spotValue == null
    ? factor('unavailable', { points: [], references: [] })
    : factor('available', {
      latestValue: spotValue,
      latestAt: '2026-08-17T14:59:00.000Z',
      points: [
        { timestamp: Date.parse('2026-08-17T14:55:00.000Z'), value: spotValue - definition.step },
        { timestamp: Date.parse('2026-08-17T14:59:00.000Z'), value: spotValue },
      ],
      references: [],
    });
  const referenceFit = ['brent', 'bitcoin'].includes(marketId) ? 'proxy' : 'exact';
  const tenDay = tenDayChartFixture({
    status: spotValue == null ? 'unavailable' : 'available',
    base: spotValue || 100,
    fit: referenceFit,
    dates: marketId === 'bitcoin'
      ? ['2026-08-08', '2026-08-09', '2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13', '2026-08-14', '2026-08-15', '2026-08-16', '2026-08-17']
      : null,
  });
  const fiveDates = tenDay.rangeDates.slice(-5);
  const fiveDateSet = new Set(fiveDates);
  const fiveDay = {
    ...tenDay,
    range: '5d',
    rangeDates: fiveDates,
    points: tenDay.points.filter((point) => fiveDateSet.has(new Date(point.timestamp).toISOString().slice(0, 10))),
    dailyRanges: tenDay.dailyRanges.filter((dailyRange) => fiveDateSet.has(dailyRange.date)),
  };
  const chartWithVariants = {
    ...chart,
    range: '1d',
    fit: referenceFit,
    variants: {
      '1d': { ...chart, range: '1d', fit: referenceFit },
      '5d': fiveDay,
      '10d': tenDay,
    },
  };
  const requestedFactorLabels = {
    wti: [
      'WTI/DXY 30D CORRELATION',
      'CFTC CRUDE-OIL MANAGED MONEY · 1Y / 3Y Z',
      'OVX',
      'TRADE / TREND GATE',
      'CONTRACT / RR GEOMETRY',
    ],
    gold: [
      'GOLD/DXY 30D CORRELATION',
      'CFTC GOLD MANAGED MONEY · 1Y / 3Y Z',
      'GVZ',
      'TRADE / TREND GATE',
      'CONTRACT / RR GEOMETRY',
    ],
    silver: [
      'SILVER/DXY 30D CORRELATION',
      'CFTC SILVER MANAGED MONEY · 1Y / 3Y Z',
      '21D ANNUALIZED SILVER REALIZED VOLATILITY',
      'TRADE / TREND GATE',
      'CONTRACT / RR GEOMETRY',
    ],
    brent: [
      'BRENT/DXY 30D CORRELATION',
      'BRENT–WTI FRONT-MONTH SPREAD',
      'OVX · WTI PROXY',
      'TRADE / TREND GATE',
      'CONTRACT / RR GEOMETRY',
    ],
    bitcoin: [
      'BTC/DXY 30D CORRELATION',
      'CFTC CME BITCOIN · 1Y / 3Y Z',
      'BITVX',
      'TRADE / TREND GATE',
      'CONTRACT / RR GEOMETRY',
    ],
  };
  const requestedFactorIds = {
    wti: ['usd', 'cftc', 'OVX', 'gate', 'geometry'],
    gold: ['usd', 'cftc', 'GVZ', 'gate', 'geometry'],
    silver: ['usd', 'cftc', 'silverRealizedVolatility', 'gate', 'geometry'],
    brent: ['usd', 'brentWtiSpread', 'OVX', 'gate', 'geometry'],
    bitcoin: ['usd', 'cftc', 'BITVX', 'gate', 'geometry'],
  };
  const genericFactorRows = requestedFactorLabels[marketId]?.map((label, index) => ({
    id: requestedFactorIds[marketId][index],
    label,
    role: index === 3 ? 'gate' : 'context',
    fit: index === 4 ? 'calibration' : 'context_only',
    decisionEligible: false,
    status: 'available',
    value: index === 0 ? -0.82 : index === 2 ? 22.5 : null,
    displayValue: index === 0 ? '-0.82' : index === 1 ? '+1.20 / +0.80' : index === 2 ? '22.50' : index === 3 ? 'BULLISH / BULLISH' : '70.00 – 80.00',
    displayState: index === 3 ? 'CONTEXT ALIGNED' : null,
    source: 'verified-test-source',
    asOf: '2026-08-17T14:59:00.000Z',
  }));
  return {
    schemaVersion: 2,
    marketId,
    displayName: definition.label,
    symbol: definition.symbol,
    status: 'partial',
    generatedAt: '2026-08-17T15:00:00.000Z',
    session: { state: 'open', asOf: '2026-08-17T15:00:00.000Z' },
    spot,
    chart: chartWithVariants,
    riskRange: factor('unavailable', { lrr: null, hrr: null, trend: null }),
    factors: {},
    factorRows: genericFactorRows || [{
      id: 'volatility', label: 'VXN', status: 'historical', value: 22.5,
      source: 'verified-test-source', asOf: '2026-08-17T14:59:00.000Z',
    }],
    scoreInputs: {},
    venues: {
      kalshi: {
        id: 'kalshi', label: 'Kalshi', status: 'available',
        resolver: {
          resolver: `kalshi_${marketId}_resolver`, underlying: `${definition.symbol.toLowerCase()}_underlying`,
          warning: 'Exact Kalshi resolver.',
        },
        settlementBasis: settlementDefinitions[marketId] ? {
          status: 'verified',
          ...settlementDefinitions[marketId],
          observationAt: '2026-08-17T20:00:00.000Z',
          rulesUrl: null,
          reason: null,
        } : {
          status: 'unavailable', instrument: null, method: null, observationAt: null,
          sourceName: null, sourceUrl: null, rulesUrl: null,
          reason: 'No authoritative cash-index resolver source is present in this fixture.',
        },
        brokerRoutable: true, catalog: contracts, book: contracts, contracts,
      },
      forecastex: {
        id: 'forecastex', label: 'ForecastEx', status: 'unavailable',
        resolver: { resolver: `forecastex_${marketId}_resolver`, underlying: 'dated_futures', warning: 'Different dated-futures resolver.' },
        settlementBasis: {
          status: 'unavailable', instrument: null, method: null, observationAt: null,
          sourceName: null, sourceUrl: null, rulesUrl: null, reason: 'Fixture has no exact dated future.',
        },
        brokerRoutable: false,
        catalog: {
          status: 'available', source: 'forecastex_official_schedule', asOf: '2026-08-17T15:00:00.000Z', expiresAt: '2026-08-17T20:00:00.000Z',
          event: { ticker: `FX-${marketId}`, status: 'open', closeTime: '2026-08-17T20:00:00.000Z' },
          lines: [{ ...lines[0], ticker: `FX-${marketId}-100`, yesBid: null, yesAsk: null, noBid: null, noAsk: null, directNative: false }],
          scheduleOnly: true,
        },
        book: {
          status: 'unavailable', source: 'forecastex_official_schedule', asOf: null, expiresAt: null,
          event: { ticker: `FX-${marketId}`, status: 'open', closeTime: '2026-08-17T20:00:00.000Z' },
          lines: [],
          reason: 'Official schedule only; no verified live IBKR book.', scheduleOnly: true,
        },
        contracts: {
          status: 'unavailable', source: null, asOf: null, expiresAt: null,
          event: { ticker: `FX-${marketId}`, status: 'open', closeTime: '2026-08-17T20:00:00.000Z' },
          lines: [], reason: 'Official schedule only; no verified live IBKR book.',
        },
      },
    },
    autoSelection: {
      status: 'available', mode: 'most_executable', venueId: 'kalshi', label: 'Kalshi live book',
      reason: 'Contracts are not resolver-equivalent.', contracts,
    },
    displaySelection: {
      status: 'available', mode: 'executable', venueId: 'kalshi', label: 'Kalshi live book',
      reason: 'Contracts are not resolver-equivalent.', contracts,
    },
    displayContracts: contracts,
    contracts,
    refresh: { state: 'idle', revision: 1, suggestedNextPollMs: 30_000 },
    strategy: {
      status: 'unavailable', model: null, eligibleVenueId: null,
      reason: `No validated ${definition.label} prediction-contract strategy or sizing model is configured.`,
    },
    errors: [],
  };
}

function cpiMonitorSnapshot() {
  const releaseAt = '2026-09-11T12:30:00.000Z';
  const closeTime = '2026-09-11T12:29:00.000Z';
  const event = {
    ticker: 'KXCPIYOY-26AUG',
    eventTicker: 'KXCPIYOY-26AUG',
    generationId: 'KXCPIYOY-26AUG',
    venueId: 'kalshi',
    seriesTicker: 'KXCPIYOY',
    title: 'Inflation in August 2026 (CPI YoY)',
    status: 'open',
    closeTime,
    releaseKey: 'KXCPIYOY#2026-08',
    reportMonth: '2026-08',
    reportMonthId: '2026-08',
    forecastMonth: 'August 2026',
    releaseAt,
    metric: 'Headline CPI YoY',
    availableOnBrokers: false,
    brokerRoutable: false,
  };
  const lines = [2.4, 2.5, 2.6, 2.7, 2.8].map((threshold, index) => ({
    ticker: `KXCPIYOY-26AUG-T${threshold}`,
    threshold,
    lowerBound: threshold,
    upperBound: null,
    comparator: '>',
    status: 'available',
    yesBid: 0.35 + index * 0.05,
    yesAsk: 0.37 + index * 0.05,
    noBid: 0.63 - index * 0.05,
    noAsk: 0.65 - index * 0.05,
    yesBidSize: 20 + index,
    yesAskSize: 22 + index,
    noBidSize: 24 + index,
    noAskSize: 26 + index,
    volume24h: 100 + index,
    openInterest: 200 + index,
    updatedAt: '2026-08-17T14:59:00.000Z',
    source: 'kalshi_batch_orderbooks_v2',
    directNative: true,
  }));
  const contracts = {
    status: 'available',
    source: 'kalshi_batch_orderbooks_v2',
    asOf: '2026-08-17T14:59:00.000Z',
    expiresAt: FUTURE,
    seriesTicker: 'KXCPIYOY',
    event,
    lines,
    scheduleOnly: false,
  };
  const catalog = {
    ...contracts,
    source: 'kalshi_trade_api_v2_catalog',
    expiresAt: closeTime,
    lines: lines.map((line) => ({
      ...line,
      yesBid: null,
      yesAsk: null,
      noBid: null,
      noAsk: null,
      directNative: false,
      source: 'kalshi_trade_api_v2_catalog',
    })),
    scheduleOnly: true,
  };
  const forecastComparison = {
    status: 'available',
    releaseKey: 'KXCPIYOY#2026-08',
    reportMonth: '2026-08',
    forecastMonth: 'August 2026',
    releaseAt,
    eventTicker: 'KXCPIYOY-26AUG',
    metric: 'Headline CPI YoY',
    unit: 'percent',
    hedgeye: {
      status: 'available',
      reportMonth: '2026-08',
      scenarios: [
        { key: 'downside', label: 'Downside', value: 2.4 },
        { key: 'base', label: 'Base Case', value: 2.6 },
        { key: 'upside', label: 'Upside', value: 2.8 },
      ],
      baseValue: 2.6,
      source: 'hedgeye-inflation-nowcast',
      asOf: '2026-08-15T14:00:00.000Z',
      expiresAt: releaseAt,
      reason: null,
    },
    clevelandFed: {
      status: 'available',
      reportMonth: '2026-08',
      value: 2.5,
      points: [
        { timestamp: Date.parse('2026-08-10T15:00:00.000Z'), value: 2.45 },
        { timestamp: Date.parse('2026-08-17T14:30:00.000Z'), value: 2.5 },
      ],
      source: 'cleveland_fed_inflation_nowcasting',
      sourceUrl: 'https://www.clevelandfed.org/indicators-and-data/inflation-nowcasting',
      asOf: '2026-08-17T14:30:00.000Z',
      expiresAt: releaseAt,
      reason: null,
    },
    bls: {
      status: 'available',
      reportMonth: '2026-08',
      source: 'bls_public_data_api',
      sourceUrl: 'https://www.bls.gov/cpi/',
      fetchedAt: '2026-08-17T14:45:00.000Z',
      latestFinal: {
        reportMonth: '2026-07',
        value: 2.7,
        source: 'bls_public_data_api',
        seriesId: 'CUUR0000SA0',
        sourceUrl: 'https://www.bls.gov/cpi/',
      },
      reason: null,
    },
    reason: null,
  };
  return {
    schemaVersion: 2,
    marketId: 'cpi',
    displayName: 'Headline CPI YoY',
    symbol: 'CPI',
    precision: 1,
    unit: 'percent',
    generatedAt: '2026-08-17T15:00:00.000Z',
    status: 'available',
    session: { state: 'open', asOf: '2026-08-17T15:00:00.000Z', closeTime },
    spot: {
      status: 'unavailable', value: null, availability: 'not_applicable', fit: 'exact',
      source: null, asOf: null, expiresAt: null, executable: false,
    },
    chart: { status: 'unavailable', availability: 'not_applicable', points: [], variants: {} },
    riskRange: { status: 'unavailable', lrr: null, hrr: null, trend: null, fit: 'not_applicable' },
    forecastComparison,
    ladderReference: {
      status: 'available',
      kind: 'hedgeye_base',
      label: 'HEDGEYE BASE',
      value: 2.6,
      reportMonth: '2026-08',
      source: 'hedgeye-inflation-nowcast',
      asOf: '2026-08-15T14:00:00.000Z',
      expiresAt: releaseAt,
      availability: 'dated',
      executable: false,
    },
    factors: {},
    factorRows: [],
    scoreInputs: {},
    venues: {
      kalshi: {
        id: 'kalshi',
        label: 'Kalshi',
        status: 'available',
        generationId: 'KXCPIYOY-26AUG',
        resolver: {
          resolver: 'kalshi_kxcpiyoy_bls_initial_one_decimal_release',
          underlying: 'bls_all_items_cpi_u_yoy',
        },
        settlementBasis: {
          status: 'verified',
          instrument: 'All Items CPI-U YoY',
          instrumentScope: 'exact',
          method: 'Initial one-decimal year-over-year release',
          observationAt: releaseAt,
          sourceName: 'Bureau of Labor Statistics',
          sourceUrl: 'https://www.bls.gov/cpi/',
          rulesUrl: null,
          reason: null,
        },
        brokerRoutable: false,
        catalog,
        book: contracts,
        contracts,
        bookQuality: { eligible: false, lineCount: 5, directLineCount: 5, executableLineCount: 0 },
      },
    },
    generationOptions: [],
    selectedGeneration: null,
    selectedGenerationId: 'KXCPIYOY-26AUG',
    selectedVenueId: 'kalshi',
    selection: {
      requestedVenue: 'kalshi', requestedGenerationId: null,
      venueId: 'kalshi', generationId: 'KXCPIYOY-26AUG',
    },
    autoSelection: {
      status: 'unavailable', mode: 'none', venueId: null,
      label: 'No executable venue',
      contracts: { status: 'unavailable', event: null, lines: [] },
    },
    displaySelection: {
      status: 'available', mode: 'live_quotes', venueId: 'kalshi',
      generationId: 'KXCPIYOY-26AUG', label: 'Kalshi live quotes', contracts,
    },
    displayContracts: contracts,
    contracts,
    executionContracts: { status: 'unavailable', event: null, lines: [] },
    sourceHealth: [
      { id: 'kalshi_book', label: 'Kalshi CPI native book', status: 'live', asOf: contracts.asOf },
      { id: 'hedgeye_cpi', label: 'Hedgeye CPI scenarios', status: 'live', asOf: forecastComparison.hedgeye.asOf },
      { id: 'cleveland_fed_cpi', label: 'Cleveland Fed CPI nowcast', status: 'live', asOf: forecastComparison.clevelandFed.asOf },
      { id: 'bls_cpi', label: 'Official BLS CPI history', status: 'live', asOf: forecastComparison.bls.fetchedAt },
    ],
    refresh: { state: 'idle', revision: 1, suggestedNextPollMs: 30_000 },
    strategy: {
      status: 'unavailable', model: null, eligibleVenueId: null,
      reason: 'No validated CPI strategy, sizing model, or execution route is configured.',
    },
    errors: [],
  };
}

const livePortfolio = {
  accountId: 'U1234567',
  dataSource: 'ibkr_api',
  liveSessionVerified: true,
  fromCache: false,
  fetchedAt: '2026-08-17T14:59:40.000Z',
  socketVerifiedAt: '2026-08-17T14:59:42.000Z',
  summary: { totalValue: 100000 },
  accountSummary: {
    accountId: 'U1234567',
    netLiquidation: 100000,
    currency: 'USD',
    source: 'ibkr_live_session',
    lastUpdated: '2026-08-17T14:59:40.000Z',
    socketVerifiedAt: '2026-08-17T14:59:42.000Z',
  },
};

const renderPanel = (active = true, props = {}) => render(
  <PersistentSurface active={active}>
    <PredictionMarketResolverTest {...props} />
  </PersistentSurface>,
);

function settlementVenueSelection(id, basis, generationId = `${id}-GENERATION`) {
  const event = {
    ticker: generationId,
    generationId,
    closeTime: FUTURE,
  };
  const catalog = {
    status: 'available',
    expiresAt: FUTURE,
    event,
    lines: [],
  };
  return {
    id,
    contracts: { ...catalog, event },
    venue: {
      id,
      label: id === 'kalshi' ? 'Kalshi' : 'ForecastEx',
      settlementBasis: basis,
      catalog,
    },
  };
}

function momoTrackerFixture(overrides = {}) {
  const rows = [
    ['MSFT', 479, 516, 0.48, -6.7, 'BULLISH'],
    ['AAPL', 306, 324, 1.35, -4.3, 'BULLISH'],
    ['AMZN', 256, 270, 1.34, -3.9, 'BULLISH'],
    ['META', 532, 588, 1.73, -8.0, 'BEARISH'],
    ['GOOGL', 337, 350, 0.98, -2.8, 'BEARISH'],
    ['NFLX', 78, 83, 1.57, -4.6, 'BULLISH'],
    ['TSLA', 334, 365, 4.66, -4.2, 'BEARISH'],
    ['NVDA', 209, 229, 5.26, -3.9, 'BULLISH'],
    ['SNDK', 1390, 1640, 10.44, -6.4, 'NEUTRAL'],
  ];
  return {
    date: '2026-08-17',
    snapshotType: 'momo-tracker',
    reportType: 'momo-tracker',
    source: 'gmail-html',
    publishedAt: '2026-08-17T12:15:00.000Z',
    scrapedAt: '2026-08-17T12:16:00.000Z',
    meta: { stockCount: rows.length },
    data: Object.fromEntries(rows.map(([
      ticker, buyTrade, sellTrade, upside, downside, trend,
    ]) => [ticker, {
      buyTrade,
      sellTrade,
      upside,
      downside,
      trend,
      rangeStatus: 'available',
    }])),
    ...overrides,
  };
}

function momoSpotQuotes(overrides = {}) {
  const prices = {
    MSFT: 500.25,
    AAPL: 315.4,
    AMZN: 263.18,
    META: 559.62,
    GOOGL: 343.75,
    NFLX: 80.54,
    TSLA: 351.08,
    NVDA: 220.16,
    SNDK: 1512.5,
  };
  return Object.fromEntries(Object.entries(prices).map(([ticker, last]) => [ticker, {
    symbol: ticker,
    last,
    timestamp: '2026-08-17T14:59:40.000Z',
    source: 'ibkr',
    dataType: 'live',
    entitlementStatus: 'entitled',
    ...(overrides[ticker] || {}),
  }]));
}

describe('PredictionMarketResolverTest SPX monitor', () => {
  let pollSnapshot;

  beforeAll(() => {
    global.ResizeObserver = ResizeObserverMock;
  });

  afterAll(() => {
    if (nativeResizeObserver) global.ResizeObserver = nativeResizeObserver;
    else delete global.ResizeObserver;
  });

  beforeEach(() => {
    act(() => resetSessionResourceStore());
    window.sessionStorage.clear();
    jest.clearAllMocks();
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
    startVisibilityAwarePolling.mockImplementation(({ poll, pollOnStart }) => {
      pollSnapshot = poll;
      if (pollOnStart) void poll();
      return jest.fn();
    });
    predictionMarketTestService.getMonitor.mockResolvedValue(monitorSnapshot());
    MarketDataService.getPortfolioPredictionMarketPositions.mockResolvedValue({
      status: 'live',
      meta: { status: 'live', source: 'ibkr_live', fetchedAt: new Date(NOW).toISOString() },
      accounts: [{ accountId: 'U1234567', status: 'live' }],
      positions: [],
      fetchedAt: new Date(NOW).toISOString(),
    });
    MarketDataService.getProviderStatus.mockResolvedValue({
      ibkr: { connected: true, statusRefreshDelayed: false },
    });
    MarketDataService.getQuotes.mockResolvedValue({
      SPY: {
        symbol: 'SPY',
        price: '774.20',
        last: 774.2,
        previousClose: '770.00',
        changePercent: '0.55',
        timestamp: '2026-08-17T14:59:40.000Z',
        source: 'ibkr',
        dataType: 'live',
        entitlementStatus: 'entitled',
      },
    });
    MarketDataService.getHedgeyeSnapshot.mockReturnValue(new Promise(() => {}));
    MarketDataService.getGoldCorrelations.mockReturnValue(new Promise(() => {}));
  });

  afterEach(() => {
    act(() => resetSessionResourceStore());
    jest.restoreAllMocks();
  });

  test('normalizes only a current verified XAUUSD-basis Gold correlation snapshot', () => {
    const normalized = normalizeGoldCorrelationSnapshot(goldCorrelationFixture(), NOW);
    expect(normalized).toMatchObject({
      status: 'available',
      method: 'pearson_completed_daily_changes',
      basis: { symbol: 'XAUUSD', role: 'proxy', status: 'available', asOf: '2026-08-14' },
    });
    expect(normalized.rows).toHaveLength(7);
    expect(normalized.rows.find((row) => row.key === 'DXY').values['30D']).toBe(-0.84);
    expect(normalized.rows.find((row) => row.key === 'DXY').latest).toEqual({
      value: 98.42, asOf: '2026-08-14', unit: 'index',
    });
    expect(isGoldCorrelationSnapshotUsable(normalized, NOW)).toBe(true);

    expect(normalizeGoldCorrelationSnapshot(goldCorrelationFixture({
      fromCache: true,
    }), NOW)).toMatchObject({ status: 'unavailable', rows: [] });
    expect(normalizeGoldCorrelationSnapshot(goldCorrelationFixture({
      timestamp: new Date(NOW - 2 * 60 * 60_000).toISOString(),
    }), NOW)).toMatchObject({ status: 'unavailable', rows: [] });
    expect(normalizeGoldCorrelationSnapshot(goldCorrelationFixture({
      basis: {
        ...goldCorrelationFixture().basis,
        source: 'IBKR disconnected cache',
      },
    }), NOW)).toMatchObject({ status: 'unavailable', rows: [] });
    expect(normalizeGoldCorrelationSnapshot(goldCorrelationFixture({
      horizons: ['15D', '30D'],
    }), NOW)).toMatchObject({ status: 'unavailable', rows: [] });

    const shortRows = goldCorrelationFixture().rows.map((row) => (
      row.key === 'DXY' ? { ...row, status: 'partial', observations: 15 } : row
    ));
    const short = normalizeGoldCorrelationSnapshot(goldCorrelationFixture({
      status: 'partial', rows: shortRows,
    }), NOW);
    expect(short.rows.find((row) => row.key === 'DXY')).toMatchObject({
      status: 'partial', observations: 15,
      values: { '15D': -0.78, '30D': null, '90D': null, '120D': null, '180D': null },
    });

    const unsafeLatestRows = goldCorrelationFixture().rows.map((row) => (
      row.key === 'DXY' ? { ...row, latest: { ...row.latest, fromCache: true } } : row
    ));
    expect(normalizeGoldCorrelationSnapshot(goldCorrelationFixture({ rows: unsafeLatestRows }), NOW)
      .rows.find((row) => row.key === 'DXY').latest.value).toBeNull();
  });

  test('uses an unexpired verified IBKR current bar for the Gold header and fails unsafe bars closed', () => {
    const reference = (overrides = {}) => normalizeGoldHeaderMarketReference({
      key: 'xauusd',
      label: 'SPOT GOLD',
      symbol: 'XAUUSD',
      role: 'proxy',
      status: 'live',
      price: 4_418.6,
      source: 'ibkr_historical_bars',
      asOf: new Date(NOW - (9 * 60_000)).toISOString(),
      expiresAt: new Date(NOW + 60_000).toISOString(),
      ...overrides,
    }, NOW);

    expect(reference()).toMatchObject({
      status: 'live', price: 4_418.6, source: 'ibkr_historical_bars',
    });
    expect(reference({ expiresAt: new Date(NOW - 1).toISOString() }))
      .toMatchObject({ status: 'unavailable', price: null, source: null });
    expect(reference({ source: 'ibkr_chart_cache', fromCache: true }))
      .toMatchObject({ status: 'unavailable', price: null, source: null });
  });

  test('keeps each verified Gold header value independently while its replacement is loading', () => {
    const references = [
      {
        key: 'selectedResolver', label: 'PYTH GOLD INDEX', symbol: 'GOLD/USD', role: 'direct',
        status: 'live', price: 4_434.3, previousClose: 4_400, source: 'pyth_lazer_http',
        asOf: new Date(NOW - 10_000).toISOString(), expiresAt: new Date(NOW + 60_000).toISOString(),
      },
      {
        key: 'xauusd', label: 'SPOT GOLD', symbol: 'XAUUSD', role: 'proxy',
        status: 'live', price: 4_433.8, previousClose: 4_401, source: 'ibkr_historical_bars',
        instrument: { symbol: 'XAUUSD', displaySymbol: 'XAUUSD', conId: 69067924 },
        asOf: new Date(NOW - 60_000).toISOString(), expiresAt: new Date(NOW + (9 * 60_000)).toISOString(),
      },
      {
        key: 'activeComex', label: 'COMEX GOLD', symbol: 'GCZ26', role: 'proxy',
        status: 'live', price: 4_450.2, previousClose: 4_420, source: 'ibkr',
        instrument: { symbol: 'GC', displaySymbol: 'GCZ26', conId: 12345, contractMonth: '202612' },
        asOf: new Date(NOW - 20_000).toISOString(), expiresAt: new Date(NOW + 60_000).toISOString(),
      },
    ];

    const stabilizePending = (key) => {
      const pending = references.map((reference) => reference.key === key ? {
        ...reference,
        status: 'loading',
        price: null,
        previousClose: null,
        source: null,
        asOf: null,
        expiresAt: null,
        reason: `${reference.symbol} is loading.`,
      } : reference);
      const stabilized = stabilizeGoldHeaderMarketReferences(references, {
        marketId: 'gold', sourceRefreshPending: true, goldMarketReferences: pending,
      }, NOW);
      return stabilized.find((reference) => reference.key === key);
    };
    const retained = Object.fromEntries(['selectedResolver', 'xauusd', 'activeComex']
      .map((key) => [key, stabilizePending(key)]));
    const expectedRetained = (key) => ({
        status: 'delayed',
        price: references.find((reference) => reference.key === key).price,
        displayOnly: true,
        executable: false,
        refreshPending: true,
        refreshRetained: true,
      });
    expect(retained.selectedResolver).toMatchObject(expectedRetained('selectedResolver'));
    expect(retained.xauusd).toMatchObject(expectedRetained('xauusd'));
    expect(retained.activeComex).toMatchObject(expectedRetained('activeComex'));
    expect(Object.values(retained).map((reference) => (
      normalizeGoldHeaderMarketReference(reference, NOW).status
    ))).toEqual(['delayed', 'delayed', 'delayed']);

    const disconnected = stabilizeGoldHeaderMarketReferences(references, {
      marketId: 'gold',
      sourceRefreshPending: false,
      goldMarketReferences: references.map((reference) => reference.key === 'xauusd' ? {
        ...reference,
        status: 'unavailable', price: null, source: null, asOf: null, expiresAt: null,
        reason: 'IBKR disconnected.',
      } : reference),
    }, NOW);
    expect(disconnected.find((reference) => reference.key === 'xauusd')).toMatchObject({
      status: 'unavailable', price: null, reason: 'IBKR disconnected.',
    });

    const expired = stabilizeGoldHeaderMarketReferences(references, {
      marketId: 'gold', sourceRefreshPending: true, goldMarketReferences: [],
    }, NOW + (10 * 60_000));
    expect(expired.every((reference) => reference.status !== 'delayed')).toBe(true);
  });

  test('uses the canonical 30D XAUUSD/DXY return correlation only in the contextual factor row', () => {
    const snapshot = genericMonitorSnapshot('gold', { spotValue: 4_434.3 });
    const normalized = normalizeGoldCorrelationSnapshot(goldCorrelationFixture(), NOW);
    const replaced = withCanonicalGoldCorrelationFactor(snapshot, normalized, NOW);
    const row = replaced.factorRows.find((factorRow) => factorRow.id === 'usd');

    expect(row).toMatchObject({
      label: 'XAUUSD/DXY 30D RETURN CORRELATION',
      status: 'available', value: -0.84, displayValue: '-0.84',
      decisionEligible: false, fit: 'context_only',
      source: 'Yahoo Finance DX-Y.NYB completed daily closes',
      asOf: '2026-08-14',
    });
    expect(snapshot.factorRows.find((factorRow) => factorRow.id === 'usd').label)
      .toBe('GOLD/DXY 30D CORRELATION');

    const unavailable = withCanonicalGoldCorrelationFactor(snapshot, null, NOW);
    expect(unavailable.factorRows.find((factorRow) => factorRow.id === 'usd')).toMatchObject({
      label: 'XAUUSD/DXY 30D RETURN CORRELATION', status: 'unavailable', value: null,
      decisionEligible: false,
    });
  });

  test('normalizes only the complete current-day published MOMO Tracker table', () => {
    const normalized = normalizeMomoTrackerSnapshot(momoTrackerFixture(), NOW);
    expect(normalized).toMatchObject({ status: 'available', publicationDate: '2026-08-17' });
    expect(normalized.rows).toHaveLength(9);
    expect(normalized.rows[0]).toMatchObject({ ticker: 'MSFT', buyTrade: 479, trend: 'BULLISH' });
    expect(normalizeMomoTrackerSnapshot(momoTrackerFixture({ fromCache: true }), NOW)).toMatchObject({
      status: 'unavailable',
      rows: [],
    });
    expect(normalizeMomoTrackerSnapshot(momoTrackerFixture({ date: '2026-08-14' }), NOW)).toMatchObject({
      status: 'unavailable',
      rows: [],
    });
  });

  test('normalizes only fresh direct-live IBKR spots for MOMO Tracker tickers', () => {
    const normalized = normalizeVerifiedMomoTrackerSpots(
      ['MSFT', 'NVDA'],
      momoSpotQuotes(),
      { ibkr: { connected: true } },
      NOW,
    );

    expect(normalized.MSFT).toMatchObject({
      ticker: 'MSFT', status: 'live', price: 500.25, source: 'ibkr',
    });
    expect(normalized.NVDA).toMatchObject({
      ticker: 'NVDA', status: 'live', price: 220.16, source: 'ibkr',
    });
  });

  test.each([
    ['stale', { timestamp: '2026-08-17T14:57:00.000Z' }, true],
    ['delayed', { dataType: 'delayed' }, true],
    ['cached', { fromCache: true }, true],
    ['mock', { mock: true }, true],
    ['seeded', { warning: 'seed quote' }, true],
    ['fallback', { source: 'yahoo', warning: 'IBKR fallback' }, true],
    ['offline', {}, false],
  ])('fails the MOMO spot closed for %s input', (_label, override, connected) => {
    const normalized = normalizeVerifiedMomoTrackerSpots(
      ['MSFT'],
      momoSpotQuotes({ MSFT: override }),
      { ibkr: { connected } },
      NOW,
    );

    expect(normalized.MSFT).toMatchObject({
      ticker: 'MSFT', status: 'unavailable', price: null, source: null,
    });
  });

  test('renders hoverable and keyboard-described venue and exact settlement identity details', () => {
    const venueSelection = settlementVenueSelection('kalshi', {
      status: 'verified', instrument: 'Commodities.BRENTX6/USD', method: '1-minute close',
      observationAt: '2026-08-17T20:00:00.000Z', sourceName: 'Pyth',
      sourceUrl: 'https://pythdata.app/explore',
      rulesUrl: 'https://kalshi.com/official-rules', reason: null,
    }, 'KXBRENTD-26AUG1717');
    render(<SettlementIdentityChips venueSelection={venueSelection} nowMs={NOW} />);

    expect(screen.getByText('KALSHI')).toBeInTheDocument();
    expect(screen.queryByText('SETTLES ON · PYTH Commodities.BRENTX6/USD · 1-MINUTE CLOSE')).not.toBeInTheDocument();
    const identity = screen.getByLabelText(/Prediction venue KALSHI.*Commodities\.BRENTX6\/USD/i);
    const tooltip = screen.getByRole('tooltip');
    expect(identity).toHaveAttribute('tabindex', '0');
    expect(identity).toHaveAttribute('aria-describedby', tooltip.id);
    fireEvent.mouseEnter(identity);
    expect(tooltip).toBeInTheDocument();
    identity.focus();
    expect(identity).toHaveFocus();
    expect(tooltip).toHaveTextContent('EVENT · KXBRENTD-26AUG1717');
    expect(tooltip).toHaveTextContent('METHOD · 1-minute close');
    expect(tooltip).toHaveTextContent('OBSERVATION · 2026-08-17T20:00:00.000Z');
    expect(within(tooltip).getByRole('link', { name: 'Pyth' })).toHaveAttribute('href', 'https://pythdata.app/explore');
    expect(within(tooltip).getByRole('link', { name: 'https://kalshi.com/official-rules' })).toBeInTheDocument();
  });

  test('shows checking and fail-closed expired settlement states explicitly', () => {
    const { rerender } = render(<SettlementIdentityChips venueSelection={null} checking nowMs={NOW} />);
    expect(screen.getByText('VENUE CHECKING')).toBeInTheDocument();
    expect(screen.getByLabelText(/Settlement basis checking/i)).toBeInTheDocument();

    const venueSelection = settlementVenueSelection('forecastex', {
      status: 'verified', instrument: 'ESU26', method: 'Official daily settlement',
      observationAt: '2026-08-17T20:00:00.000Z', sourceName: 'CME',
      sourceUrl: 'https://www.cmegroup.com/markets/equities.html', rulesUrl: null, reason: null,
    });
    rerender(<SettlementIdentityChips venueSelection={venueSelection} nowMs={Date.parse(FUTURE) + 1} />);
    expect(screen.getByText('FORECASTEX')).toBeInTheDocument();
    expect(screen.queryByText('SETTLEMENT BASIS UNAVAILABLE')).not.toBeInTheDocument();
    expect(screen.getByLabelText(/selected catalog generation is missing, changed, or expired/i)).toBeInTheDocument();
  });

  test('updates venue and resolver atomically with the selected generation', () => {
    const kalshi = settlementVenueSelection('kalshi', {
      status: 'verified', instrument: 'Metal.Index.GOLD/USD', instrumentScope: 'exact', method: '1-minute close',
      observationAt: '2026-08-17T20:00:00.000Z', sourceName: 'Pyth',
      sourceUrl: 'https://app.pyth.com/explore/Metal.Index.GOLD%2FUSD', rulesUrl: null, reason: null,
    }, 'KXGOLDD-26AUG17');
    const forecast = settlementVenueSelection('forecastex', {
      status: 'verified', instrument: 'GCU26', method: 'Official daily settlement',
      observationAt: '2026-08-17T20:00:00.000Z', sourceName: 'COMEX',
      sourceUrl: 'https://www.cmegroup.com/markets/metals/precious/gold.html',
      rulesUrl: 'https://data.forecastex.com/regulatory/METLGTermsandConditions.pdf', reason: null,
    }, 'METLG_081726');
    const { rerender } = render(<SettlementIdentityChips venueSelection={kalshi} nowMs={NOW} />);
    expect(screen.getByText('KXGOLDD')).toBeVisible();
    expect(screen.getByLabelText(/Settles on Pyth Metal\.Index\.GOLD\/USD/i)).toBeInTheDocument();

    rerender(<SettlementIdentityChips venueSelection={forecast} nowMs={NOW} />);
    expect(screen.queryByText('KALSHI')).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Settles on Pyth Metal\.Index\.GOLD\/USD/i)).not.toBeInTheDocument();
    expect(screen.getByText('FORECASTEX')).toBeInTheDocument();
    expect(screen.getByLabelText(/Settles on COMEX GCU26/i)).toBeInTheDocument();
  });

  test('shows a terminal product-level ForecastEx metal basis when the exact month is absent', () => {
    const selection = settlementVenueSelection('forecastex', {
      status: 'partial',
      instrument: 'COMEX Silver Futures',
      instrumentScope: 'product',
      method: 'Official front-month daily settlement',
      observationAt: '2026-08-17T20:00:00.000Z',
      sourceName: 'COMEX',
      sourceUrl: 'https://www.cmegroup.com/markets/metals/precious/silver.html',
      rulesUrl: 'https://data.forecastex.com/regulatory/METLSTermsandConditions.pdf',
      reason: 'The active METLS catalog verifies the product method but omits the exact futures month.',
    });
    render(<SettlementIdentityChips venueSelection={selection} nowMs={NOW} />);
    expect(screen.getByText('FORECASTEX')).toBeInTheDocument();
    expect(screen.queryByText('SETTLEMENT VERIFIED')).not.toBeInTheDocument();
    expect(screen.getByLabelText(/Exact futures contract month unavailable/i)).toBeInTheDocument();
    expect(screen.getByText(/LIMITATION · The active METLS catalog verifies the product method but omits the exact futures month/i))
      .toBeInTheDocument();
    expect(screen.queryByText('SETTLEMENT METHOD VERIFIED · CONTRACT MONTH UNAVAILABLE')).not.toBeInTheDocument();
    expect(screen.queryByText('SETTLEMENT CHECKING')).not.toBeInTheDocument();
  });

  test('renders a full-width chart above the factor sheet and clean strike-ordered ladder', async () => {
    renderPanel();

    await waitFor(() => expect(screen.getAllByText('7,746.25').length).toBeGreaterThan(0));
    const chartRegion = screen.getByRole('region', { name: 'SPX Risk Range chart' });
    expect(chartRegion).toBeInTheDocument();
    expect(within(chartRegion).getByRole('tab', { name: '1D' })).toHaveAttribute('aria-selected', 'true');
    expect(within(chartRegion).getByRole('tab', { name: '5D' })).toHaveAttribute('aria-selected', 'false');
    expect(within(chartRegion).getByRole('tab', { name: '10D' })).toHaveAttribute('aria-selected', 'false');
    const oneDayStructureSummary = within(chartRegion).getByTestId('spx-1d-rr-structure-summary');
    expect(oneDayStructureSummary).toHaveTextContent('H+9·L+9');
    expect(oneDayStructureSummary).toHaveAttribute('data-source-range', '10d');
    expect(oneDayStructureSummary).toHaveAttribute(
      'aria-label',
      '1D summary from the ending 10D consecutive Risk Range trends, high plus 9, low plus 9',
    );
    const spxMeasure = within(chartRegion).getByTestId('spx-header-measure-spx');
    expect(within(spxMeasure).getByText('7,746.25')).toHaveClass('pm-spx-chart-price', 'is-positive');
    expect(within(spxMeasure).getByText('(+0.60%)')).toHaveClass('pm-spx-day-change', 'is-positive');
    expect(within(chartRegion).queryByText('CLOSED')).not.toBeInTheDocument();
    expect(within(chartRegion).queryByText('BULLISH')).not.toBeInTheDocument();
    expect(within(chartRegion).getByText('EXACT')).toHaveAccessibleName(
      'Exact reference. CURRENT BAR. Full provenance is labeled on the blue reference marker.',
    );
    const chartCanvas = within(chartRegion).getByTestId('spx-chart-canvas');
    expect(chartCanvas).toHaveAttribute('data-session-open-time', '2026-08-17T13:30:00.000Z');
    expect(chartCanvas).toHaveAttribute('data-session-close-time', '2026-08-17T20:00:00.000Z');
    expect(chartCanvas).toHaveAttribute('data-time-tick-count', '8');

    const factorRegion = screen.getByRole('region', { name: 'SPX factor monitor' });
    expect(factorRegion).toHaveAttribute('data-selected-venue', 'forecastex');
    expect(factorRegion).toHaveAttribute('data-event-ticker', 'FES_081726');
    const factorTable = within(factorRegion).getByRole('table');
    expect(within(factorTable).queryByText('FORECASTEX · FES_081726 · CURRENT')).not.toBeInTheDocument();
    expect(within(factorTable).getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual([
      'FACTOR', 'VALUE', 'MAX PTS', 'POINTS', 'AS OF',
    ]);
    expect(within(factorTable).getByText('CFTC · E-MINI · 1Y / 3Y Z')).toBeInTheDocument();
    expect(within(factorTable).getByText('GAMMA THROTTLE / 10D RVOL')).toBeInTheDocument();
    expect(within(factorTable).getByText('ZERO GAMMA / PV BANDS')).toBeInTheDocument();
    expect(within(factorTable).getByText('+1.40')).toHaveClass('is-positive');
    expect(within(factorTable).getByText('+0.80')).toHaveClass('is-positive');
    expect(within(factorTable).getByText('+0.72')).toHaveClass('is-positive');
    expect(within(factorTable).getByText('9.58')).toHaveClass('is-neutral');
    expect(within(factorTable).getByText('ZG 7,646')).toBeInTheDocument();
    expect(within(factorTable).getByText('PV 7,573–7,798')).toBeInTheDocument();
    expect(within(factorTable).queryByText('STATE')).not.toBeInTheDocument();

    const ladder = within(screen.getByRole('region', { name: 'S&P 500 prediction-market contract ladder' })).getByRole('table');
    await within(ladder).findByText('7,725');
    expect(within(ladder).queryByText(/POSITIONS (?:CHECKING|UNAVAILABLE)/)).not.toBeInTheDocument();
    expect(within(ladder).getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual([
      'ESU26 SETTLES ABOVE', 'YES', 'NO', '24H VOL', 'LINE OI', 'Y / N SPREAD', 'Δ ESU26', 'BID', 'ASK', 'BID', 'ASK',
    ]);
    expect(within(ladder).queryByText('YES DEPTH')).not.toBeInTheDocument();
    expect(within(ladder).queryByText('NO DEPTH')).not.toBeInTheDocument();
    const lineCells = within(ladder).getAllByText(/^7,/, { selector: 'strong[title]' });
    expect(lineCells.map((cell) => cell.textContent)).toEqual(['7,725', '7,775']);
    expect(lineCells.every((cell) => !cell.closest('td')?.hasAttribute('title'))).toBe(true);
    const lowerLineRow = within(ladder).getByRole('row', { name: /^7,725 / });
    const yesBidCell = within(lowerLineRow).getByRole('cell', { name: 'Yes bid: 85¢, displayed size 20 contracts' });
    const yesAskCell = within(lowerLineRow).getByRole('cell', { name: 'Yes ask: 87¢, displayed size 30 contracts' });
    const noBidCell = within(lowerLineRow).getByRole('cell', { name: 'No bid: 13¢, displayed size 35 contracts' });
    const noAskCell = within(lowerLineRow).getByRole('cell', { name: 'No ask: 15¢, displayed size 25 contracts' });
    expect(yesBidCell).toHaveTextContent('85¢× 20');
    expect(yesAskCell).toHaveTextContent('87¢× 30');
    expect(noBidCell).toHaveTextContent('13¢× 35');
    expect(noAskCell).toHaveTextContent('15¢× 25');
    expect(within(ladder).queryByText(/^> 7,/)).not.toBeInTheDocument();
    expect(within(ladder).queryByText(/KXINXU/)).not.toBeInTheDocument();
    expect(within(ladder).queryByText('RR ZONE')).not.toBeInTheDocument();
    expect(within(ladder).queryByText('SCORE')).not.toBeInTheDocument();
    expect(within(ladder).getAllByText('2¢ / 2¢').length).toBeGreaterThan(0);
    expect(within(ladder).queryByRole('button', { name: /details for/i })).not.toBeInTheDocument();
    expect(within(ladder).queryByText('CONTRACT ID')).not.toBeInTheDocument();
    const tradingHours = screen.getByLabelText('Selected contract trading hours');
    expect(within(tradingHours).getByText('OPEN')).toHaveClass('pm-spx-contract-clock-status');
    expect(within(tradingHours).getByText('CLOSES IN 5h 0m')).toHaveClass('pm-spx-contract-clock-timing');
    expect(within(tradingHours).queryByText('·')).not.toBeInTheDocument();
    expect(chartRegion).toContainElement(tradingHours);
    expect(tradingHours.closest('.pm-spx-monitor-toolbar')).toBeNull();
    expect(tradingHours).toHaveAttribute('title', expect.stringContaining('EXCHANGE'));
    expect(within(tradingHours).queryByText(/EXCHANGE|LOCAL/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText('ForecastEx FES fixed contract market')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Prediction monitor data status')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('ForecastEx FES contract terms summary')).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Auto' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Kalshi' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('S&P 500 contract generation')).not.toBeInTheDocument();
    expect(screen.queryByText('SELECTED-GEN OI')).not.toBeInTheDocument();
    expect(screen.queryByText('ALL-OPEN OI')).not.toBeInTheDocument();
    const topLayout = chartRegion.closest('.pm-spx-monitor-top');
    const bottomLayout = ladder.closest('.pm-spx-monitor-bottom');
    expect(topLayout).toHaveClass('pm-spx-monitor-top--chart-only');
    expect(topLayout).toContainElement(chartRegion);
    expect(topLayout).not.toContainElement(factorRegion);
    expect(bottomLayout).toHaveClass('pm-spx-monitor-bottom--factor-layout');
    expect(bottomLayout).toContainElement(factorRegion);
    expect(screen.queryByLabelText('S&P 500 resolver diagnostics and position sizing')).not.toBeInTheDocument();
    expect(screen.queryByText('MEASURED PERIOD')).not.toBeInTheDocument();
    expect(predictionMarketTestService.getMonitor).toHaveBeenCalledWith('sp500', expect.objectContaining({
      venue: 'forecastex', generationId: null,
    }));
    expect(screen.queryByText(/Prediction Market Resolver/i)).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/Find a level/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/ALL ACTIVE S&P 500 LINES/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/MIN LIQ/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/TOP PICK|BEST VALUE|WATCHLIST/i)).not.toBeInTheDocument();
  });

  test('shows only exact current-generation live FES positions in the strike cell', async () => {
    MarketDataService.getPortfolioPredictionMarketPositions.mockResolvedValue({
      status: 'live',
      meta: { status: 'live', source: 'ibkr_live', fetchedAt: new Date(NOW).toISOString() },
      accounts: [{ accountId: 'U1234567', status: 'live' }],
      positions: [
        {
          accountId: 'U1234567', description: 'FES_081726_7725_YES',
          quantity: 2320, avgCost: 0.42, positionSource: 'ibkr_positions',
        },
        {
          accountId: 'U1234567', description: 'FES_081726_7725_NO',
          quantity: 1100, avgCost: 0.62, positionSource: 'ibkr_positions',
        },
        {
          accountId: 'U1234567', description: 'FES_081626_7725_NO',
          quantity: 99, avgCost: 0.2, positionSource: 'ibkr_positions',
        },
        {
          accountId: 'U7654321', description: 'FES_081726_7725_NO',
          quantity: 88, avgCost: 0.3, positionSource: 'ibkr_positions',
        },
      ],
      fetchedAt: new Date(NOW).toISOString(),
    });

    renderPanel(true, { portfolioData: livePortfolio, selectedAccount: 'U1234567' });

    const ladder = await screen.findByRole('table', { name: /All active ForecastEx S&P 500 lines/i });
    const strikeCell = (await within(ladder).findByText('7,725')).closest('td');
    const yesPosition = within(strikeCell).getByLabelText(
      'Live IBKR position: YES, cost $974.40, average price 42¢, quantity 2,320',
    );
    const noPosition = within(strikeCell).getByLabelText(
      'Live IBKR position: NO, cost $682, average price 62¢, quantity 1,100',
    );

    expect(yesPosition).toHaveTextContent('YES - $974.40 (42¢ × 2,320)');
    expect(noPosition).toHaveTextContent('NO - $682 (62¢ × 1,100)');
    expect(within(yesPosition).getByText('YES')).toHaveClass('is-yes');
    expect(within(noPosition).getByText('NO')).toHaveClass('is-no');
    expect(strikeCell.querySelector('.pm-spx-line-content')).toContainElement(yesPosition);
    expect(strikeCell.querySelector('.pm-spx-line-content')).toContainElement(noPosition);
    expect(strikeCell.querySelector('.pm-spx-line-content')).toContainElement(
      within(strikeCell).getByText('7,725'),
    );
    expect(strikeCell).not.toHaveTextContent('99');
    expect(strikeCell).not.toHaveTextContent('88');
    expect(strikeCell).not.toHaveTextContent('MKT');
    expect(strikeCell).not.toHaveTextContent('OPEN');
  });

  test('puts the live SPX index, SPY ETF, and exact dated ES future across the chart header', async () => {
    renderPanel();

    const chartRegion = await screen.findByRole('region', { name: 'SPX Risk Range chart' });
    const strip = within(chartRegion).getByRole('group', { name: 'S&P 500 market measures' });
    const es = await within(strip).findByTestId('spx-header-measure-esu26');
    await waitFor(() => expect(within(strip).getByTestId('spx-header-measure-spy')).toHaveClass('is-live'));
    const spx = within(strip).getByTestId('spx-header-measure-spx');
    const spy = within(strip).getByTestId('spx-header-measure-spy');

    expect(spx).toHaveTextContent('S&P 500 INDEX');
    expect(within(spx).getByText('SPX')).toBeInTheDocument();
    expect(within(spx).getByText('PROXY')).toHaveAccessibleName('Related market proxy; not the contract resolver');
    expect(within(spx).getByText('7,746.25')).toBeInTheDocument();
    expect(within(spx).getByText('(+0.60%)')).toBeInTheDocument();
    expect(spy).toHaveTextContent('SPDR ETF');
    expect(within(spy).getByText('SPY')).toBeInTheDocument();
    expect(within(spy).getByText('PROXY')).toHaveAccessibleName('Related market proxy; not the contract resolver');
    expect(within(spy).getByText('774.20')).toBeInTheDocument();
    expect(within(spy).getByText('(+0.55%)')).toBeInTheDocument();
    expect(es).toHaveTextContent('E-MINI FUTURE');
    expect(es).not.toHaveTextContent('CURRENT BAR');
    expect(within(es).getByText('ESU26')).toBeInTheDocument();
    expect(within(es).getByText('PRIMARY')).toHaveAccessibleName('Primary instrument used by this contract');
    expect(within(es).getByText('7,746.25')).toBeInTheDocument();
    expect(within(es).getByText('(—)')).toBeInTheDocument();
  });

  test('retains all three verified header quotes but withholds D during the first two minutes', async () => {
    const initial = monitorSnapshot();
    initial.resolverReference = {
      ...initial.resolverReference,
      spot: {
        ...initial.resolverReference.spot,
        availability: 'current',
        source: 'ibkr_historical_bars',
      },
    };
    const transientMiss = monitorSnapshot();
    transientMiss.spot = {
      status: 'unavailable', availability: 'unavailable', value: null, source: null,
      asOf: null, expiresAt: null, refreshFailed: true, reason: 'IBKR is disconnected.',
    };
    transientMiss.spySpot = {
      status: 'unavailable', availability: 'unavailable', value: null, source: null,
      asOf: null, expiresAt: null, refreshFailed: true, reason: 'IBKR is disconnected.',
    };
    transientMiss.resolverReference = {
      ...transientMiss.resolverReference,
      spot: {
        status: 'unavailable', availability: 'unavailable', value: null, source: null,
        asOf: null, expiresAt: null, fit: 'exact', executable: false, refreshFailed: true,
        reason: 'IBKR gateway is not connected.',
      },
    };
    predictionMarketTestService.getMonitor
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(transientMiss);

    renderPanel();

    const chartRegion = await screen.findByRole('region', { name: 'SPX Risk Range chart' });
    const strip = within(chartRegion).getByRole('group', { name: 'S&P 500 market measures' });
    expect(await within(strip).findByText('774.20')).toBeInTheDocument();

    await act(async () => {
      await pollSnapshot();
    });

    const spx = within(strip).getByTestId('spx-header-measure-spx');
    const spy = within(strip).getByTestId('spx-header-measure-spy');
    const es = within(strip).getByTestId('spx-header-measure-esu26');
    expect(spx).toHaveClass('is-delayed');
    expect(spy).toHaveClass('is-delayed');
    expect(es).toHaveClass('is-delayed');
    expect(within(spx).getByText('7,746.25')).toBeInTheDocument();
    expect(within(spy).getByText('774.20')).toBeInTheDocument();
    expect(within(es).getByText('7,746.25')).toBeInTheDocument();
    expect(within(spx).queryByRole('button', { name: /SPX delayed quote/ })).not.toBeInTheDocument();
    expect(within(spy).queryByRole('button', { name: /SPY delayed quote/ })).not.toBeInTheDocument();
    expect(within(es).queryByRole('button', { name: /ESU26 delayed quote/ })).not.toBeInTheDocument();
    expect(spx.querySelector('.pm-spx-market-measure-price')).not.toHaveTextContent('—');
    expect(spy.querySelector('.pm-spx-market-measure-price')).not.toHaveTextContent('—');
    expect(es.querySelector('.pm-spx-market-measure-price')).not.toHaveTextContent('—');
  });

  test('keeps the last verified header references delayed across disconnects and quote expiry', () => {
    const initialSnapshot = monitorSnapshot();
    initialSnapshot.resolverReference = {
      ...initialSnapshot.resolverReference,
      spot: {
        ...initialSnapshot.resolverReference.spot,
        availability: 'current',
        source: 'ibkr_historical_bars',
      },
    };
    const initial = stabilizeSpxHeaderMarketReferences(null, initialSnapshot, NOW);
    const missed = monitorSnapshot();
    missed.spot = {
      status: 'unavailable', availability: 'unavailable', value: null, source: null,
      asOf: null, expiresAt: null, reason: 'A fresh entitled live IBKR SPX trade is unavailable.',
    };
    missed.spySpot = {
      status: 'unavailable', availability: 'unavailable', value: null, source: null,
      asOf: null, expiresAt: null, reason: 'A fresh entitled live IBKR SPY trade is unavailable.',
    };
    missed.resolverReference = {
      ...missed.resolverReference,
      spot: {
        status: 'unavailable', availability: 'unavailable', value: null, source: null,
        asOf: null, expiresAt: null, fit: 'exact', executable: false,
        reason: 'The verified ES current bar expired.',
      },
    };
    const delayed = stabilizeSpxHeaderMarketReferences(initial, missed, NOW);

    expect(delayed.cashSpot).toMatchObject({ status: 'delayed', value: 7746.25, displayOnly: true });
    expect(delayed.spySpot).toMatchObject({ status: 'delayed', value: 774.2, displayOnly: true });
    expect(delayed.futuresReference.spot).toMatchObject({ status: 'delayed', value: 7746.25, displayOnly: true });
    expect(isVerifiedDelayedSpxHeaderReference(delayed.cashSpot, NOW)).toBe(true);
    expect(isVerifiedDelayedSpxHeaderReference(delayed.spySpot, NOW)).toBe(true);
    expect(isVerifiedDelayedSpxHeaderReference(delayed.futuresReference.spot, NOW)).toBe(true);

    const missingFuture = stabilizeSpxHeaderMarketReferences(
      initial,
      { ...missed, resolverReference: null },
      NOW,
    );
    expect(missingFuture.futuresReference).toMatchObject({
      instrument: { displaySymbol: 'ESU26' },
      spot: { status: 'delayed', value: 7746.25 },
    });

    const disconnected = {
      ...missed,
      spot: { ...missed.spot, reason: 'IBKR is disconnected.' },
      spySpot: { ...missed.spySpot, reason: 'IBKR is disconnected.' },
      resolverReference: {
        ...missed.resolverReference,
        spot: { ...missed.resolverReference.spot, reason: 'IBKR gateway is not connected.' },
      },
    };
    const disconnectedRetained = stabilizeSpxHeaderMarketReferences(delayed, disconnected, NOW);
    expect(disconnectedRetained.cashSpot).toMatchObject({ status: 'delayed', value: 7746.25, displayOnly: true });
    expect(disconnectedRetained.spySpot).toMatchObject({ status: 'delayed', value: 774.2, displayOnly: true });
    expect(disconnectedRetained.futuresReference.spot).toMatchObject({ status: 'delayed', value: 7746.25, displayOnly: true });
    expect(isVerifiedDelayedSpxHeaderReference(disconnectedRetained.cashSpot, NOW)).toBe(true);
    expect(isVerifiedDelayedSpxHeaderReference(disconnectedRetained.spySpot, NOW)).toBe(true);
    expect(isVerifiedDelayedSpxHeaderReference(disconnectedRetained.futuresReference.spot, NOW)).toBe(true);

    const justDelayed = stabilizeSpxHeaderMarketReferences(initial, missed, Date.parse(FUTURE) + 1);
    expect(justDelayed.cashSpot).toMatchObject({ status: 'delayed', value: 7746.25 });
    expect(justDelayed.spySpot).toMatchObject({ status: 'delayed', value: 774.2 });
    expect(justDelayed.futuresReference.spot).toMatchObject({ status: 'delayed', value: 7746.25 });

    const longDelayed = stabilizeSpxHeaderMarketReferences(initial, missed, Date.parse(FUTURE) + 86_400_000);
    expect(longDelayed.cashSpot).toMatchObject({ status: 'delayed', value: 7746.25, retainedUntil: null });
    expect(longDelayed.spySpot).toMatchObject({ status: 'delayed', value: 774.2, retainedUntil: null });
    expect(longDelayed.futuresReference.spot).toMatchObject({ status: 'delayed', value: 7746.25, retainedUntil: null });
    expect(isVerifiedDelayedSpxHeaderReference(longDelayed.cashSpot, Date.parse(FUTURE) + 86_400_000)).toBe(true);
    expect(isVerifiedDelayedSpxHeaderReference(longDelayed.spySpot, Date.parse(FUTURE) + 86_400_000)).toBe(true);
    expect(isVerifiedDelayedSpxHeaderReference(longDelayed.futuresReference.spot, Date.parse(FUTURE) + 86_400_000)).toBe(true);
  });

  test('labels verified completed-session SPX, SPY, and volume data as historical instead of blanking them', async () => {
    const snapshot = monitorSnapshot({
      session: { state: 'closed', asOf: '2026-08-17T12:00:00.000Z' },
    });
    snapshot.cashSpot = factor('historical', {
      availability: 'last_close', value: 7740, previousClose: 7700,
      source: 'ibkr_historical_daily_close', asOf: '2026-08-14T20:00:00.000Z',
      historicalThroughDate: '2026-08-14', expiresAt: null,
    });
    snapshot.spySpot = factor('historical', {
      availability: 'last_close', value: 774.2, previousClose: 770,
      source: 'ibkr_historical_intraday_session_close', asOf: '2026-08-14T19:55:00.000Z',
      historicalThroughDate: '2026-08-14', expiresAt: null,
    });
    snapshot.factors.spyVolume = factor('historical', {
      availability: 'historical', ratio: 1.02,
      source: 'ibkr_historical_bars', asOf: '2026-08-14T19:55:00.000Z',
      latestAt: '2026-08-14T19:55:00.000Z', historicalThroughDate: '2026-08-14', expiresAt: null,
    });
    snapshot.factors.vix = factor('historical', {
      availability: 'last_close', value: 14.9, bucket: 'investable', current: false,
      source: 'ibkr_historical_daily_close', asOf: '2026-08-14T20:00:00.000Z',
      historicalThroughDate: '2026-08-14', expiresAt: null,
    });
    snapshot.factors.vvix = factor('historical', {
      availability: 'last_close', value: 89.7, current: false,
      source: 'ibkr_historical_daily_close', asOf: '2026-08-14T20:00:00.000Z',
      historicalThroughDate: '2026-08-14', expiresAt: null,
    });
    predictionMarketTestService.getMonitor.mockResolvedValue(snapshot);

    renderPanel();

    const chartRegion = await screen.findByRole('region', { name: 'SPX Risk Range chart' });
    const strip = within(chartRegion).getByRole('group', { name: 'S&P 500 market measures' });
    const spx = within(strip).getByTestId('spx-header-measure-spx');
    const spy = within(strip).getByTestId('spx-header-measure-spy');
    await waitFor(() => expect(spx).toHaveClass('is-historical'));
    expect(spx).toHaveTextContent('S&P 500 INDEX · LAST CLOSE');
    expect(within(spx).getByText('7,740.00')).toBeInTheDocument();
    expect(spy).toHaveClass('is-historical');
    expect(spy).toHaveTextContent('SPDR ETF · LAST CLOSE');
    expect(within(spy).getByText('774.20')).toBeInTheDocument();
    const factorTable = within(screen.getByRole('region', { name: 'SPX factor monitor' })).getByRole('table');
    const volumeRow = within(factorTable).getByText('SPY RTH VOLUME / 20D · LAST SESSION').closest('tr');
    expect(within(volumeRow).getByText('1.02×')).toBeInTheDocument();
    expect(volumeRow).toHaveAttribute('data-availability', 'available');
    const vixRow = within(factorTable).getByText('VIX · LAST CLOSE').closest('tr');
    const vvixRow = within(factorTable).getByText('VVIX · LAST CLOSE').closest('tr');
    expect(within(vixRow).getByText('14.90')).toBeInTheDocument();
    expect(within(vvixRow).getByText('89.70')).toBeInTheDocument();
  });

  test('keeps the cash SPX card distinct when the selected venue chart is bound to ES futures', async () => {
    const snapshot = monitorSnapshot();
    snapshot.spot = { ...snapshot.spot, value: 7740, previousClose: 7700 };
    snapshot.resolverReference = {
      ...snapshot.resolverReference,
      spot: { ...snapshot.resolverReference.spot, value: 7755, label: 'ESU26' },
    };
    snapshot.venues.forecastex.reference = snapshot.resolverReference;
    predictionMarketTestService.getMonitor.mockResolvedValue(snapshot);

    renderPanel();

    const chartRegion = await screen.findByRole('region', { name: 'SPX Risk Range chart' });
    const strip = within(chartRegion).getByRole('group', { name: 'S&P 500 market measures' });
    const es = await within(strip).findByTestId('spx-header-measure-esu26');
    const spx = within(strip).getByTestId('spx-header-measure-spx');

    expect(within(spx).getByText('7,740.00')).toBeInTheDocument();
    expect(within(spx).queryByText('7,755.00')).not.toBeInTheDocument();
    expect(within(es).getByText('7,755.00')).toBeInTheDocument();
  });

  test.each([
    ['stale', { timestamp: '2026-08-17T14:58:00.000Z' }],
    ['delayed', { dataType: 'delayed' }],
    ['cached', { fromCache: true }],
    ['seeded', { warning: 'seed quote' }],
    ['fallback', { source: 'yahoo', warning: 'ibkr_unavailable; yahoo_fallback' }],
  ])('fails the SPY header quote closed for %s input', (_label, override) => {
    const result = normalizeVerifiedSpxHeaderQuotes({
      SPY: {
        symbol: 'SPY', last: 774.2, previousClose: 770, changePercent: 0.55,
        timestamp: '2026-08-17T14:59:40.000Z', source: 'ibkr', dataType: 'live',
        entitlementStatus: 'entitled', ...override,
      },
    }, { ibkr: { connected: true } }, NOW);

    expect(result).toMatchObject({
      status: 'unavailable',
      spy: { status: 'unavailable', price: null, asOf: null },
    });
  });

  test('fails the SPY header quote closed while IBKR is disconnected', () => {
    const result = normalizeVerifiedSpxHeaderQuotes({
      SPY: {
        symbol: 'SPY', last: 774.2, previousClose: 770, changePercent: 0.55,
        timestamp: '2026-08-17T14:59:40.000Z', source: 'ibkr', dataType: 'live',
        entitlementStatus: 'entitled',
      },
    }, { ibkr: { connected: false } }, NOW);

    expect(result.spy).toMatchObject({ status: 'unavailable', price: null });
    expect(result.spy.reason).toMatch(/IBKR is disconnected/i);
  });

  test('fails the position overlay closed when the IBKR position envelope is stale or cached', async () => {
    MarketDataService.getPortfolioPredictionMarketPositions.mockResolvedValue({
      status: 'stale',
      meta: { status: 'stale', source: 'cache', fetchedAt: new Date(NOW).toISOString() },
      positions: [{
        accountId: 'U1234567', description: 'FES_081726_7725_NO', quantity: 1100, avgCost: 0.62,
      }],
      fetchedAt: new Date(NOW).toISOString(),
    });

    renderPanel(true, { portfolioData: livePortfolio, selectedAccount: 'U1234567' });

    const ladder = await screen.findByRole('table', { name: /All active ForecastEx S&P 500 lines/i });
    expect(within(ladder).getByRole('columnheader', { name: 'ESU26 SETTLES ABOVE' })).toBeInTheDocument();
    expect(within(ladder).queryByText(/POSITIONS (?:CHECKING|UNAVAILABLE)/)).not.toBeInTheDocument();
    expect(within(ladder).queryByLabelText(/Live IBKR position:/)).not.toBeInTheDocument();
    expect(within(ladder).queryByText('$682')).not.toBeInTheDocument();
  });

  test('colors the SPX price and verified daily change red together', async () => {
    const snapshot = monitorSnapshot();
    snapshot.spot = { ...snapshot.spot, value: 7650, previousClose: 7700 };
    predictionMarketTestService.getMonitor.mockResolvedValue(snapshot);

    renderPanel();

    const chartRegion = await screen.findByRole('region', { name: 'SPX Risk Range chart' });
    const spxMeasure = within(chartRegion).getByTestId('spx-header-measure-spx');
    expect(await within(spxMeasure).findByText('7,650.00')).toHaveClass('pm-spx-chart-price', 'is-negative');
    expect(within(spxMeasure).getByText('(-0.65%)')).toHaveClass('pm-spx-day-change', 'is-negative');
  });

  test('leaves the daily change unavailable when the verified prior close is missing', async () => {
    const snapshot = monitorSnapshot();
    snapshot.spot = { ...snapshot.spot, previousClose: null, previousCloseSource: null };
    predictionMarketTestService.getMonitor.mockResolvedValue(snapshot);

    renderPanel();

    const chartRegion = await screen.findByRole('region', { name: 'SPX Risk Range chart' });
    const spxMeasure = within(chartRegion).getByTestId('spx-header-measure-spx');
    expect(await within(spxMeasure).findByText('7,746.25')).toHaveClass('pm-spx-chart-price', 'is-neutral');
    expect(within(spxMeasure).getByLabelText('SPX daily change unavailable')).toHaveTextContent('—');
  });

  test('keeps a verified Trend visible when Trade is unavailable and colors factor values like the desktop', async () => {
    const snapshot = monitorSnapshot();
    snapshot.factors.trade = {
      status: 'unavailable', source: null, asOf: null, expiresAt: null,
      direction: null, raw: null, date: null,
      reason: 'A same-session published SPX Trade signal is unavailable.',
    };
    snapshot.scoreInputs.trade = {
      direction: null, raw: null, date: null, source: null,
    };
    predictionMarketTestService.getMonitor.mockResolvedValue(snapshot);

    renderPanel();

    await waitFor(() => {
      const table = within(screen.getByRole('region', { name: 'SPX factor monitor' })).getByRole('table');
      expect(within(table).getByText('-0.72')).toBeInTheDocument();
    });
    const factorTable = within(screen.getByRole('region', { name: 'SPX factor monitor' })).getByRole('table');
    const gateRow = within(factorTable).getByText('TRADE / TREND GATE').closest('tr');
    expect(gateRow).toHaveAttribute('data-availability', 'partial');
    expect(gateRow).not.toHaveClass('is-unavailable');
    expect(gateRow).toHaveTextContent(/—\s*\/\s*BULLISH/);
    expect(within(gateRow).getByText('BULLISH')).toHaveClass('pm-spx-factor-token', 'is-positive');
    expect(within(gateRow).getByText('BLOCKED')).toHaveClass('pm-spx-factor-points', 'is-negative');
    expect(gateRow).toHaveAttribute('title', expect.stringContaining('Trade unavailable'));

    const usdRow = within(factorTable).getByText('USD CORR · SPX/DXY 30D').closest('tr');
    expect(within(usdRow).getByText('-0.72')).toHaveClass('pm-spx-factor-value', 'is-negative');
    const volumeRow = within(factorTable).getByText('SPY RTH VOLUME / 20D').closest('tr');
    expect(within(volumeRow).getByText('1.50×')).toHaveClass('pm-spx-factor-value', 'is-positive');
    const vixRow = within(factorTable).getByText('VIX').closest('tr');
    expect(within(vixRow).getByText('17.40')).toHaveClass('pm-spx-factor-value', 'is-positive');
    const vvixRow = within(factorTable).getByText('VVIX').closest('tr');
    expect(within(vvixRow).getByText('92.10')).toHaveClass('pm-spx-factor-value', 'is-positive');
    const structureRow = within(factorTable).getByText('HEDGEYE STRUCTURE BREADTH').closest('tr');
    expect(within(structureRow).getByText('RISK ON')).toHaveClass('pm-spx-factor-token', 'is-positive');
  });

  test('switches to five equal labeled sessions with each day’s exact Risk Range', async () => {
    renderPanel();
    const chartRegion = await screen.findByRole('region', { name: 'SPX Risk Range chart' });

    fireEvent.click(within(chartRegion).getByRole('tab', { name: '5D' }));

    expect(within(chartRegion).getByRole('tab', { name: '5D' })).toHaveAttribute('aria-selected', 'true');
    const sessionLabels = within(chartRegion).getAllByTestId(/^spx-5d-session-/);
    expect(sessionLabels).toHaveLength(5);
    expect(screen.getByTestId('spx-5d-session-2026-08-11')).toHaveTextContent('TUE · AUG 11');
    expect(screen.getByTestId('spx-5d-lrr-2026-08-11')).toHaveTextContent('LRR 7,600 · HL');
    expect(screen.getByTestId('spx-5d-hrr-2026-08-11')).toHaveTextContent('HRR 7,800 · HH');
    expect(screen.getByTestId('spx-5d-session-2026-08-17')).toHaveTextContent('MON · AUG 17');
    expect(screen.getByTestId('spx-5d-closed-date-2026-08-15')).toHaveTextContent('SAT · AUG 15');
    expect(screen.getByTestId('spx-5d-closed-date-2026-08-16')).toHaveTextContent('SUN · AUG 16');
    const weekendBands = within(chartRegion).getAllByTestId(/^spx-5d-market-closed-2026-08-1[56]$/);
    expect(weekendBands).toHaveLength(2);
    weekendBands.forEach((band) => {
      expect(band).toHaveAttribute('data-closure-type', 'weekend');
      expect(band).toHaveAttribute('fill', 'url(#pm-spx-market-closed-weekend-pattern)');
      expect(band).toHaveAccessibleName(/market closed weekend/);
    });
    expect(screen.getByTestId('spx-5d-market-closed-label-2026-08-15')).toHaveTextContent('MARKET CLOSED WEEKEND');
    expect(screen.getByTestId('spx-5d-market-closed-label-2026-08-16')).toHaveTextContent('MARKET CLOSED WEEKEND');
    expect(within(screen.getByTestId('spx-5d-session-2026-08-11')).getByText('10:50 AM')).toBeInTheDocument();
    expect(within(screen.getByTestId('spx-5d-session-2026-08-11')).getByText('10:55 AM')).toBeInTheDocument();
    const chartCanvas = within(chartRegion).getByTestId('spx-chart-canvas');
    expect(chartCanvas).toHaveAttribute('data-chart-range', '5d');
    expect(chartCanvas).toHaveAttribute('data-session-count', '5');
    expect(chartCanvas).toHaveAttribute('data-rr-overlay-count', '5');
    expect(chartCanvas).toHaveAttribute('data-vix-close-count', '5');
    expect(chartCanvas).toHaveAttribute('data-price-domain-min', '7450');
    expect(chartCanvas).toHaveAttribute('data-price-domain-max', '8000');
    expect(chartCanvas).toHaveAttribute('data-risk-range-structure-score', '8');
    expect(chartCanvas).toHaveAttribute('data-risk-range-high-structure-score', '4');
    expect(chartCanvas).toHaveAttribute('data-risk-range-low-structure-score', '4');
    expect(within(chartRegion).getAllByTestId(/^spx-5d-high-structure-/)).toHaveLength(5);
    expect(within(chartRegion).getAllByTestId(/^spx-5d-low-structure-/)).toHaveLength(5);
    expect(screen.getByTestId('spx-5d-high-structure-2026-08-11')).toHaveTextContent('+0');
    expect(screen.getByTestId('spx-5d-high-structure-2026-08-11')).toHaveAttribute('data-score-tone', 'neutral');
    expect(screen.getByTestId('spx-5d-high-structure-2026-08-11')).toHaveAttribute('data-boundary-placement', 'above');
    expect(screen.getByTestId('spx-5d-high-structure-2026-08-11')).toHaveAttribute('data-boundary-offset', '24');
    expect(screen.getByTestId('spx-5d-high-structure-2026-08-11')).toHaveAccessibleName(/above HRR/);
    expect(screen.getByTestId('spx-5d-hrr-2026-08-11')).toHaveAttribute('data-boundary-placement', 'above');
    expect(within(chartRegion).getAllByTestId(/^spx-5d-vix-close-/)).toHaveLength(5);
    expect(screen.getByTestId('spx-5d-vix-close-2026-08-11')).toHaveTextContent('VIX 15.10');
    expect(screen.getByTestId('spx-5d-vix-close-2026-08-11')).toHaveAttribute('data-state', 'available');
    expect(screen.getByTestId('spx-5d-vix-close-2026-08-11')).toHaveAccessibleName('2026-08-11 VIX close 15.10');
    expect(screen.getByTestId('spx-5d-low-structure-2026-08-17')).toHaveTextContent('+4');
    expect(screen.getByTestId('spx-5d-low-structure-2026-08-17')).toHaveAttribute('data-score-tone', 'positive');
    expect(screen.getByTestId('spx-5d-low-structure-2026-08-17')).toHaveAttribute('data-boundary-placement', 'below');
    expect(screen.getByTestId('spx-5d-low-structure-2026-08-17')).toHaveAttribute('data-boundary-offset', '24');
    expect(screen.getByTestId('spx-5d-low-structure-2026-08-17')).toHaveAccessibleName(/below LRR/);
    expect(screen.getByTestId('spx-5d-lrr-2026-08-17')).toHaveAttribute('data-boundary-placement', 'below');
    expect(within(chartRegion).getByTestId('spx-5d-rr-structure-summary')).toHaveTextContent('H+4·L+4');
    expect(within(chartRegion).getByTestId('spx-5d-rr-structure-summary')).toHaveAttribute(
      'aria-label',
      '5D consecutive Risk Range trends, high plus 4, low plus 4',
    );
  });

  test.each(['aligned', 'proxy_context'])('keeps complete Risk Range structure visible for legacy %s basis labels', async (riskRangeStatus) => {
    const snapshot = monitorSnapshot();
    snapshot.chart.variants['5d'] = {
      ...snapshot.chart.variants['5d'],
      riskRangeStatus,
    };
    predictionMarketTestService.getMonitor.mockResolvedValue(snapshot);
    renderPanel();
    const chartRegion = await screen.findByRole('region', { name: 'SPX Risk Range chart' });

    fireEvent.click(within(chartRegion).getByRole('tab', { name: '5D' }));

    expect(within(chartRegion).getByTestId('spx-chart-canvas')).toHaveAttribute('data-rr-overlay-count', '5');
    expect(within(chartRegion).getByTestId('spx-chart-canvas')).toHaveAttribute('data-risk-range-high-structure-score', '4');
    expect(within(chartRegion).getByTestId('spx-chart-canvas')).toHaveAttribute('data-risk-range-low-structure-score', '4');
    expect(within(chartRegion).getByTestId('spx-5d-rr-structure-summary')).toHaveTextContent('H+4·L+4');
  });

  test('renders a verified holiday as its own generic closed band with its name only in metadata', async () => {
    const snapshot = monitorSnapshot();
    snapshot.chart.variants['5d'] = fiveDayChartFixture({
      dates: ['2026-06-29', '2026-06-30', '2026-07-01', '2026-07-02', '2026-07-06'],
    });
    predictionMarketTestService.getMonitor.mockResolvedValue(snapshot);
    renderPanel();
    const chartRegion = await screen.findByRole('region', { name: 'SPX Risk Range chart' });

    fireEvent.click(within(chartRegion).getByRole('tab', { name: '5D' }));

    const holidayBand = screen.getByTestId('spx-5d-market-closed-2026-07-03');
    expect(holidayBand).toHaveAttribute('data-closure-type', 'holiday');
    expect(holidayBand).toHaveAttribute('data-holiday-name', 'Independence Day');
    expect(holidayBand).toHaveAttribute('fill', 'url(#pm-spx-market-closed-holiday-pattern)');
    expect(holidayBand).toHaveAccessibleName('2026-07-03: market closed holiday — Independence Day');
    const holidayLabel = screen.getByTestId('spx-5d-market-closed-label-2026-07-03');
    expect(within(holidayLabel).getByText('MARKET CLOSED HOLIDAY')).toBeInTheDocument();
    expect(holidayLabel).toHaveAccessibleName('2026-07-03: market closed holiday — Independence Day');
    expect(holidayLabel).toHaveTextContent('Independence Day');
    expect(screen.getByTestId('spx-5d-closed-date-2026-07-03')).toHaveTextContent('FRI · JUL 3');
    expect(screen.getByTestId('spx-5d-closed-date-2026-07-03')).toHaveAttribute('title', 'Independence Day');
    expect(within(chartRegion).getAllByTestId(/^spx-5d-market-closed-\d{4}-\d{2}-\d{2}$/)).toHaveLength(3);
  });

  test('does not infer an ordinary missing weekday to be a market closure', async () => {
    const snapshot = monitorSnapshot();
    snapshot.chart.variants['5d'] = fiveDayChartFixture({
      dates: ['2026-08-10', '2026-08-11', '2026-08-13', '2026-08-14', '2026-08-17'],
    });
    predictionMarketTestService.getMonitor.mockResolvedValue(snapshot);
    renderPanel();
    const chartRegion = await screen.findByRole('region', { name: 'SPX Risk Range chart' });

    fireEvent.click(within(chartRegion).getByRole('tab', { name: '5D' }));

    expect(within(chartRegion).queryByTestId('spx-5d-market-closed-2026-08-12')).not.toBeInTheDocument();
    expect(within(chartRegion).queryByTestId('spx-5d-closed-date-2026-08-12')).not.toBeInTheDocument();
    expect(within(chartRegion).getAllByTestId(/^spx-5d-market-closed-\d{4}-\d{2}-\d{2}$/)).toHaveLength(2);
  });

  test('renders ten compact sessions with boundary bands and short date labels', async () => {
    renderPanel();
    const chartRegion = await screen.findByRole('region', { name: 'SPX Risk Range chart' });

    fireEvent.click(within(chartRegion).getByRole('tab', { name: '10D' }));

    expect(within(chartRegion).getByRole('tab', { name: '10D' })).toHaveAttribute('aria-selected', 'true');
    expect(within(chartRegion).getAllByTestId(/^spx-10d-session-/)).toHaveLength(10);
    expect(screen.getByTestId('spx-10d-session-2026-08-04')).toHaveTextContent('8/4');
    expect(within(chartRegion).queryByTestId(/^spx-10d-hrr-/)).not.toBeInTheDocument();
    const chartCanvas = within(chartRegion).getByTestId('spx-chart-canvas');
    expect(chartCanvas).toHaveAttribute('data-chart-range', '10d');
    expect(chartCanvas).toHaveAttribute('data-session-count', '10');
    expect(chartCanvas).toHaveAttribute('data-rr-overlay-count', '10');
    expect(chartCanvas).toHaveAttribute('data-vix-close-count', '10');
    expect(chartCanvas).toHaveAttribute('data-risk-range-structure-score', '18');
    expect(chartCanvas).toHaveAttribute('data-risk-range-high-structure-score', '9');
    expect(chartCanvas).toHaveAttribute('data-risk-range-low-structure-score', '9');
    const weekendBands = within(chartRegion).getAllByTestId(/^spx-10d-market-closed-\d{4}-\d{2}-\d{2}$/);
    expect(weekendBands).toHaveLength(4);
    expect(weekendBands.map((band) => band.getAttribute('data-testid'))).toEqual([
      'spx-10d-market-closed-2026-08-08',
      'spx-10d-market-closed-2026-08-09',
      'spx-10d-market-closed-2026-08-15',
      'spx-10d-market-closed-2026-08-16',
    ]);
    weekendBands.forEach((band) => {
      expect(band).toHaveAttribute('data-closure-type', 'weekend');
      expect(band).toHaveAttribute('fill', 'url(#pm-spx-market-closed-weekend-pattern)');
      expect(band).toHaveAttribute('stroke', 'none');
    });
    expect(screen.getByTestId('spx-10d-closed-date-2026-08-08')).toHaveTextContent('8/8');
    expect(screen.getByTestId('spx-10d-closed-date-2026-08-09')).toHaveTextContent('8/9');
    expect(within(chartRegion).getAllByText('MARKET CLOSED WEEKEND')).toHaveLength(4);
    expect(within(chartRegion).getAllByTestId(/^spx-10d-high-structure-/)).toHaveLength(10);
    expect(within(chartRegion).getAllByTestId(/^spx-10d-low-structure-/)).toHaveLength(10);
    expect(screen.getByTestId('spx-10d-high-structure-2026-08-04')).toHaveTextContent('+0');
    expect(screen.getByTestId('spx-10d-vix-close-2026-08-04')).toHaveTextContent('VIX 14.2');
    expect(screen.getByTestId('spx-10d-high-structure-2026-08-04')).toHaveAttribute('data-boundary-placement', 'above');
    expect(screen.getByTestId('spx-10d-high-structure-2026-08-04')).toHaveAttribute('data-boundary-offset', '4');
    expect(screen.getByTestId('spx-10d-low-structure-2026-08-17')).toHaveTextContent('+9');
    expect(screen.getByTestId('spx-10d-low-structure-2026-08-17')).toHaveAttribute('data-boundary-placement', 'below');
    expect(screen.getByTestId('spx-10d-low-structure-2026-08-17')).toHaveAttribute('data-boundary-offset', '4');
    expect(within(chartRegion).getByTestId('spx-10d-rr-structure-summary')).toHaveTextContent('H+9·L+9');
    expect(screen.getByTestId('spx-10d-ath-reference')).toHaveTextContent('ATH 7,750');
  });

  test('renders the illustrated independent 10D high and low trend streaks with sign colors', async () => {
    const snapshot = monitorSnapshot();
    const highValues = [7896, 7924, 7899, 7884, 7861, 7824, 7815, 7811, 7815, 7835];
    const lowValues = [7526, 7550, 7560, 7576, 7606, 7674, 7676, 7652, 7652, 7610];
    const tenDay = snapshot.chart.variants['10d'];
    snapshot.chart.variants['10d'] = {
      ...tenDay,
      dailyRanges: tenDay.dailyRanges.map((range, index) => ({
        ...range,
        references: range.references.map((reference) => ({
          ...reference,
          value: reference.label === 'HRR' ? highValues[index] : lowValues[index],
        })),
      })),
    };
    predictionMarketTestService.getMonitor.mockResolvedValue(snapshot);
    renderPanel();
    const chartRegion = await screen.findByRole('region', { name: 'SPX Risk Range chart' });

    fireEvent.click(within(chartRegion).getByRole('tab', { name: '10D' }));

    expect(within(chartRegion).getAllByTestId(/^spx-10d-high-structure-/)
      .map((node) => Number(node.getAttribute('data-score'))))
      .toEqual([0, 1, -1, -2, -3, -4, -5, -6, 1, 2]);
    expect(within(chartRegion).getAllByTestId(/^spx-10d-low-structure-/)
      .map((node) => Number(node.getAttribute('data-score'))))
      .toEqual([0, 1, 2, 3, 4, 5, 6, -1, 0, -1]);
    expect(screen.getByTestId('spx-10d-high-structure-2026-08-17')).toHaveAttribute('data-score-tone', 'positive');
    expect(screen.getByTestId('spx-10d-low-structure-2026-08-17')).toHaveAttribute('data-score-tone', 'negative');
    expect(within(chartRegion).getByTestId('spx-10d-rr-structure-summary')).toHaveTextContent('H+2·L-1');
  });

  test('renders the verified ATH as the only blue chart value without changing five-day price availability', async () => {
    const snapshot = monitorSnapshot();
    snapshot.chart.variants['5d'] = fiveDayChartFixture({
      ath: {
        status: 'available',
        source: 'ibkr_historical_record',
        asOf: '2026-08-17T15:00:00.000Z',
        baseline: { value: 7736, date: '2026-08-14', throughDate: '2026-08-10' },
        markers: [{
          date: '2026-08-17',
          timestamp: Date.parse('2026-08-17T14:55:00.000Z'),
          value: 7746,
          label: 'ATH',
        }],
        reason: null,
      },
    });
    predictionMarketTestService.getMonitor.mockResolvedValue(snapshot);
    renderPanel();
    const chartRegion = await screen.findByRole('region', { name: 'SPX Risk Range chart' });

    fireEvent.click(within(chartRegion).getByRole('tab', { name: '5D' }));

    expect(screen.getByTestId('spx-5d-ath-reference')).toHaveTextContent('ATH 7,746 (8/17/2026)');
    const chartCanvas = within(chartRegion).getByTestId('spx-chart-canvas');
    expect(chartCanvas).toHaveAttribute('data-ath-reference-value', '7746');
    expect(chartCanvas).toHaveAttribute('data-ath-reference-date', '2026-08-17');
    expect(chartCanvas).not.toHaveAttribute('data-ath-reference-clamp');
    const athLine = within(chartRegion).getByTestId('spx-5d-ath-line');
    expect(athLine).toHaveAttribute('stroke', '#2563eb');
    expect(athLine).toHaveAttribute('stroke-width', '1.25');
    expect(athLine).toHaveAttribute('stroke-dasharray', '2 4');
    expect(athLine).toHaveAttribute('stroke-linecap', 'round');
    expect(athLine).not.toHaveAttribute('data-clamp-edge');
    expect(within(chartRegion).getByTestId('spx-5d-ath-reference')).toHaveAttribute('fill', '#2563eb');
    expect(within(chartRegion).getByTestId('spx-5d-price-line')).toHaveAttribute('stroke', '#111827');
    expect(within(chartRegion).getByTestId('spx-5d-latest-reference')).toHaveAttribute('fill', '#111827');
    expect(within(chartRegion).queryByTestId('spx-5d-ath-2026-08-17')).not.toBeInTheDocument();
    expect(within(chartRegion).getAllByTestId(/^spx-5d-session-/)).toHaveLength(5);
  });

  test('keeps one verified current ATH on every chart duration and uses black price lines', async () => {
    const snapshot = monitorSnapshot();
    const ath = {
      status: 'available',
      source: 'ibkr_historical_record',
      asOf: '2026-08-17T15:00:00.000Z',
      value: 8123,
      date: '2026-08-14',
      baseline: { value: 8123, date: '2026-08-14', throughDate: '2026-08-14' },
      markers: [],
      reason: null,
    };
    const variants = Object.fromEntries(['1d', '5d', '10d'].map((range) => [range, {
      ...snapshot.chart.variants[range],
      ath,
    }]));
    snapshot.chart = { ...variants['1d'], variants };
    predictionMarketTestService.getMonitor.mockResolvedValue(snapshot);
    renderPanel();
    const chartRegion = await screen.findByRole('region', { name: 'SPX Risk Range chart' });

    const renderRange = async (range) => {
      fireEvent.click(within(chartRegion).getByRole('tab', { name: range.toUpperCase() }));
      return {
        ath: await within(chartRegion).findByTestId(`spx-${range}-ath-reference`),
        athLine: within(chartRegion).getByTestId(`spx-${range}-ath-line`),
        price: within(chartRegion).getByTestId(`spx-${range}-price-line`),
        latest: within(chartRegion).getByTestId(`spx-${range}-latest-reference`),
      };
    };
    const oneDay = await renderRange('1d');
    const fiveDay = await renderRange('5d');
    const tenDay = await renderRange('10d');

    expect(oneDay.ath).toHaveTextContent('ATH 8,123 (8/14/2026)');
    expect(fiveDay.ath).toHaveTextContent('ATH 8,123 (8/14/2026)');
    expect(tenDay.ath).toHaveTextContent('ATH 8,123 (8/14/2026)');
    expect(oneDay.ath).toHaveAttribute('fill', '#2563eb');
    expect(fiveDay.ath).toHaveAttribute('fill', '#2563eb');
    expect(tenDay.ath).toHaveAttribute('fill', '#2563eb');
    [oneDay.athLine, fiveDay.athLine, tenDay.athLine].forEach((line) => {
      expect(line).toHaveAttribute('stroke', '#2563eb');
      expect(line).toHaveAttribute('stroke-width', '1.25');
      expect(line).toHaveAttribute('stroke-dasharray', '2 4');
      expect(line).toHaveAttribute('stroke-linecap', 'round');
    });
    expect(oneDay.price).toHaveAttribute('stroke', '#111827');
    expect(fiveDay.price).toHaveAttribute('stroke', '#111827');
    expect(tenDay.price).toHaveAttribute('stroke', '#111827');
    expect(oneDay.price).toHaveAttribute('stroke-width', '1.75');
    expect(fiveDay.price).toHaveAttribute('stroke-width', '1.75');
    expect(tenDay.price).toHaveAttribute('stroke-width', '1.75');
    expect(oneDay.latest).toHaveAttribute('fill', '#111827');
    expect(fiveDay.latest).toHaveAttribute('fill', '#111827');
    expect(tenDay.latest).toHaveAttribute('fill', '#111827');
    expect(oneDay.latest).toHaveTextContent('SPOT');
    expect(fiveDay.latest).toHaveTextContent('SPOT');
    expect(tenDay.latest).toHaveTextContent('SPOT');
  });

  test('overlays raw ESU26 in thin solid blue on the black SPX basis across every range', async () => {
    const snapshot = monitorSnapshot();
    const ath = snapshot.chart.variants['5d'].ath;
    const basisVariants = Object.fromEntries(Object.entries(snapshot.chart.variants).map(([range, chart]) => [
      range,
      { ...chart, ath },
    ]));
    snapshot.chart = { ...basisVariants['1d'], variants: basisVariants };
    const shiftedChart = (chart, shift = 3) => ({
      ...chart,
      points: (chart.points || []).map((point) => ({ ...point, value: Number(point.value) + shift })),
      latestValue: Number(chart.latestValue) + shift,
    });
    const contractChart = shiftedChart(snapshot.chart);
    contractChart.variants = Object.fromEntries(Object.entries(snapshot.chart.variants).map(([range, chart]) => [
      range,
      shiftedChart(chart),
    ]));
    const chartReferences = {
      basis: {
        role: 'risk_range_basis', symbol: 'SPX', riskRangeTicker: 'SPX', exact: true,
        instrument: { symbol: 'SPX', displaySymbol: 'SPX', secType: 'IND', provider: 'ibkr' },
        spot: snapshot.spot, chart: snapshot.chart,
        freshness: { status: 'verified_live', asOf: snapshot.spot.asOf, expiresAt: snapshot.spot.expiresAt },
      },
      contract: {
        role: 'contract_reference', symbol: 'ESU26', riskRangeTicker: 'SPX', exact: true,
        instrument: { symbol: 'ES', displaySymbol: 'ESU26', conId: 12345, secType: 'FUT', provider: 'ibkr' },
        spot: { ...snapshot.resolverReference.spot, value: snapshot.spot.value + 3 },
        chart: contractChart,
        freshness: { status: 'verified_live', asOf: snapshot.spot.asOf, expiresAt: snapshot.spot.expiresAt },
      },
    };
    snapshot.chartReferences = chartReferences;
    snapshot.resolverReference = { ...snapshot.resolverReference, chart: contractChart, chartReferences };
    predictionMarketTestService.getMonitor.mockResolvedValue(snapshot);
    renderPanel();

    const chartRegion = await screen.findByRole('region', { name: 'SPX Risk Range chart' });
    for (const range of ['1d', '5d', '10d']) {
      fireEvent.click(within(chartRegion).getByRole('tab', { name: range.toUpperCase() }));
      const basisLine = await within(chartRegion).findByTestId(`spx-${range}-price-line`);
      const contractLine = within(chartRegion).getByTestId(`spx-${range}-contract-line`);
      expect(basisLine).toHaveAttribute('stroke', '#111827');
      expect(basisLine).toHaveAttribute('stroke-width', '1.75');
      expect(contractLine).toHaveAttribute('stroke', '#2563eb');
      expect(contractLine).toHaveAttribute('stroke-width', '1');
      expect(contractLine).not.toHaveAttribute('stroke-dasharray');
      expect(within(chartRegion).getByTestId(`spx-${range}-latest-reference`)).toHaveTextContent('SPX');
      expect(within(chartRegion).getByTestId(`spx-${range}-contract-reference`)).toHaveTextContent('ESU26');
      expect(within(chartRegion).getByTestId(`spx-${range}-ath-line`)).toHaveAttribute('stroke-dasharray', '2 4');
    }
    const canvas = within(chartRegion).getByTestId('spx-chart-canvas');
    expect(canvas).toHaveAttribute('data-basis-series-symbol', 'SPX');
    expect(canvas).toHaveAttribute('data-contract-series-symbol', 'ESU26');
    expect(Number(canvas.getAttribute('data-contract-series-point-count'))).toBeGreaterThan(1);
    expect(Number(canvas.getAttribute('data-label-collision-count'))).toBeGreaterThan(0);
  });

  test('keeps two visible roles when the basis and contract share identical verified points', async () => {
    const snapshot = monitorSnapshot();
    const chartReferences = {
      basis: {
        role: 'risk_range_basis', symbol: 'BITCOIN', riskRangeTicker: 'BITCOIN', exact: true,
        spot: snapshot.spot, chart: snapshot.chart, freshness: { status: 'verified_live' },
      },
      contract: {
        role: 'proxy_reference', symbol: 'BTC-USD', riskRangeTicker: 'BITCOIN', exact: false,
        spot: snapshot.spot, chart: snapshot.chart, freshness: { status: 'verified_live' },
        disclosure: 'Coinbase BTC-USD is not BRTI.',
      },
    };
    snapshot.chartReferences = chartReferences;
    snapshot.resolverReference = { ...snapshot.resolverReference, chart: snapshot.chart, chartReferences };
    predictionMarketTestService.getMonitor.mockResolvedValue(snapshot);
    renderPanel();

    const chartRegion = await screen.findByRole('region', { name: 'SPX Risk Range chart' });
    expect(await within(chartRegion).findByTestId('spx-1d-price-line')).toHaveAttribute('stroke-width', '1.75');
    expect(await within(chartRegion).findByTestId('spx-1d-contract-line')).toHaveAttribute('stroke-width', '1');
    expect(within(chartRegion).getByTestId('spx-1d-latest-reference')).toHaveTextContent('BITCOIN');
    expect(within(chartRegion).getByTestId('spx-1d-contract-reference')).toHaveTextContent('BTC-USD');
    const canvas = within(chartRegion).getByTestId('spx-chart-canvas');
    expect(canvas).toHaveAttribute('data-basis-series-point-count', '3');
    expect(canvas).toHaveAttribute('data-contract-series-point-count', '3');
  });

  test('shows the permanent verified proxy-fit table on 1D and keeps it off the wider duration charts', async () => {
    MarketDataService.getHedgeyeSnapshot.mockResolvedValue(momoTrackerFixture());
    MarketDataService.getQuotes.mockResolvedValue(momoSpotQuotes());
    const snapshot = monitorSnapshot();
    snapshot.proxyFit = {
      status: 'available',
      proxyLabel: 'ESU26',
      underlyingLabel: 'SPX',
      currentBasisPct: 0.42,
      alignedThroughDate: '2026-08-17',
      alignedObservations: 126,
      rows: [
        { window: 5, status: 'available', averageBasisPct: 0.3, deviationZ: 1.25, returnCorrelation: 0.98 },
        { window: 20, status: 'available', averageBasisPct: 0.25, deviationZ: 0.8, returnCorrelation: 0.97 },
        { window: 60, status: 'available', averageBasisPct: 0.2, deviationZ: -0.4, returnCorrelation: 0.96 },
        { window: 120, status: 'available', averageBasisPct: 0.18, deviationZ: 0.1, returnCorrelation: 0.95 },
      ],
    };
    snapshot.resolverReference = {
      ...snapshot.resolverReference,
      proxyFit: snapshot.proxyFit,
    };
    predictionMarketTestService.getMonitor.mockResolvedValue(snapshot);
    renderPanel();
    const chartRegion = await screen.findByRole('region', { name: 'SPX Risk Range chart' });
    await within(chartRegion).findByText('VERIFIED');
    const panel = within(chartRegion).getByTestId('spx-proxy-fit');

    expect(panel).toHaveTextContent('PROXY FIT');
    expect(panel).toHaveTextContent('VERIFIED');
    expect(panel).toHaveTextContent('ESU26');
    expect(panel).toHaveTextContent('SPX');
    expect(panel).toHaveTextContent('+0.42%');
    expect(panel).toHaveTextContent('8/17/2026');
    expect(within(panel).getByText('5D')).toBeInTheDocument();
    expect(within(panel).getByText('20D')).toBeInTheDocument();
    expect(within(panel).getByText('60D')).toBeInTheDocument();
    expect(within(panel).getByText('120D')).toBeInTheDocument();
    expect(panel).toHaveTextContent('+1.25σ');
    expect(panel).toHaveTextContent('0.98');
    const momoPanel = await within(chartRegion).findByTestId('sp500-momo-tracker');
    await within(momoPanel).findByText('NVDA');
    await within(momoPanel).findByText('500.25');
    const momoTable = within(momoPanel).getByRole('table');
    const momoHeaders = within(momoTable).getAllByRole('columnheader');
    expect(momoHeaders).toHaveLength(7);
    expect(momoHeaders[0]).toHaveTextContent('TICKER');
    expect(momoHeaders[1]).toHaveTextContent('BUY TRADE');
    expect(momoHeaders[2]).toHaveTextContent('SPOT');
    expect(momoHeaders[3]).toHaveTextContent('SELL TRADE');
    expect(momoHeaders[4]).toHaveTextContent('UPSIDE');
    expect(momoHeaders[5]).toHaveTextContent('DOWNSIDE');
    expect(momoHeaders[6]).toHaveTextContent('TREND');
    expect(momoPanel).not.toHaveTextContent('HEDGEYE MOMO TRACKER');
    expect(momoPanel).not.toHaveTextContent('VS. PRIOR DAY CLOSE');
    expect(momoPanel).toHaveTextContent('BUY TRADE');
    expect(momoPanel).toHaveTextContent('SPOT');
    expect(momoPanel).toHaveTextContent('SELL TRADE');
    expect(momoPanel).toHaveTextContent('479');
    expect(momoPanel).toHaveTextContent('0.48%');
    expect(momoPanel).toHaveTextContent('-6.70%');
    expect(momoPanel).toHaveTextContent('SNDK');
    expect(momoPanel).toHaveTextContent('NEUTRAL');
    expect(within(momoPanel).getByLabelText('NVDA verified live spot 220.16')).toHaveTextContent('220.16');
    expect(momoPanel).not.toHaveTextContent('PUBLISHED');
    expect(momoPanel).not.toHaveTextContent('DAILY PUBLISHED LEVELS · NOT LIVE QUOTES');
    expect(within(chartRegion).getByTestId('spx-chart-canvas')).toHaveClass('has-sp500-one-day-layout');

    fireEvent.click(within(chartRegion).getByRole('tab', { name: '5D' }));
    expect(within(chartRegion).queryByTestId('spx-proxy-fit')).not.toBeInTheDocument();
    expect(within(chartRegion).queryByTestId('sp500-momo-tracker')).not.toBeInTheDocument();
    expect(within(chartRegion).getByTestId('spx-chart-canvas')).not.toHaveClass('has-sp500-one-day-layout');

    fireEvent.click(within(chartRegion).getByRole('tab', { name: '10D' }));
    expect(within(chartRegion).queryByTestId('spx-proxy-fit')).not.toBeInTheDocument();
    expect(within(chartRegion).queryByTestId('sp500-momo-tracker')).not.toBeInTheDocument();
  });

  test('shows one fixed no-data message while the current MOMO publication is still pending', async () => {
    renderPanel();

    const panel = await screen.findByTestId('sp500-momo-tracker');
    expect(within(panel).getByText('NO NEW DATA')).toBeInTheDocument();
    expect(within(panel).queryByRole('table')).not.toBeInTheDocument();
    expect(panel).not.toHaveTextContent('LOADING');
    expect(panel).not.toHaveTextContent('HEDGEYE MOMO TRACKER');
    expect(panel).not.toHaveTextContent('PUBLISHED');
    expect(MarketDataService.getQuotes).not.toHaveBeenCalled();
  });

  test('keeps an unverified MOMO spot blank without hiding the published table', async () => {
    MarketDataService.getHedgeyeSnapshot.mockResolvedValue(momoTrackerFixture());
    MarketDataService.getQuotes.mockResolvedValue(momoSpotQuotes({
      MSFT: { fromCache: true },
    }));
    renderPanel();

    const panel = await screen.findByTestId('sp500-momo-tracker');
    await within(panel).findByLabelText('AAPL verified live spot 315.4');
    expect(within(panel).getByLabelText('MSFT live spot unavailable')).toHaveTextContent('—');
    expect(within(panel).getByText('NVDA')).toBeInTheDocument();
  });

  test('keeps the verified current MOMO table mounted while its background refresh is pending', async () => {
    let resolveRefresh;
    MarketDataService.getHedgeyeSnapshot
      .mockResolvedValueOnce(momoTrackerFixture())
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveRefresh = resolve;
      }));
    renderPanel();

    const panel = await screen.findByTestId('sp500-momo-tracker');
    await within(panel).findByText('NVDA');
    const refreshMomoTracker = startVisibilityAwarePolling.mock.calls
      .map(([options]) => options)
      .find(({ intervalMs }) => intervalMs === 15 * 60_000)?.poll;
    expect(refreshMomoTracker).toEqual(expect.any(Function));

    act(() => {
      void refreshMomoTracker();
    });
    expect(within(panel).getByText('NVDA')).toBeInTheDocument();
    expect(within(panel).queryByText('NO NEW DATA')).not.toBeInTheDocument();

    await act(async () => {
      resolveRefresh(momoTrackerFixture({ date: '2026-08-14' }));
    });
    await waitFor(() => expect(within(panel).getByText('NVDA')).toBeInTheDocument());
    expect(within(panel).getByRole('table')).toBeInTheDocument();
    expect(within(panel).queryByText('NO NEW DATA')).not.toBeInTheDocument();
  });

  test('fails the proxy-fit display closed instead of rendering retained numbers while unavailable', async () => {
    const snapshot = monitorSnapshot();
    snapshot.proxyFit = {
      status: 'unavailable',
      proxyLabel: 'ESU26',
      underlyingLabel: 'SPX',
      currentBasisPct: 99.99,
      alignedThroughDate: '2026-08-17',
      rows: [{ window: 5, status: 'available', averageBasisPct: 88.88, deviationZ: 7.77, returnCorrelation: 0.66 }],
      reason: 'Verified comparison inputs are unavailable.',
    };
    snapshot.resolverReference = {
      ...snapshot.resolverReference,
      proxyFit: snapshot.proxyFit,
    };
    predictionMarketTestService.getMonitor.mockResolvedValue(snapshot);
    renderPanel();
    const panel = await screen.findByTestId('spx-proxy-fit');
    await within(panel).findByText('ESU26');

    expect(panel).toHaveTextContent('UNAVAILABLE');
    expect(panel).not.toHaveTextContent('99.99');
    expect(panel).not.toHaveTextContent('88.88');
    expect(panel).not.toHaveTextContent('7.77');
    expect(panel).not.toHaveTextContent('0.66');
    expect(panel).not.toHaveTextContent('8/17/2026');
  });

  test.each([
    ['cache-only', { fromCache: true }],
    ['stale', { stale: true }],
    ['mock', { mock: true }],
    ['seeded', { seeded: true }],
    ['offline', { offline: true }],
    ['prior-day', { date: '2026-08-14' }],
    ['incomplete', {
      data: Object.fromEntries(Object.entries(momoTrackerFixture().data).slice(0, 8)),
    }],
  ])('fails the MOMO Tracker panel closed for %s data', async (_label, override) => {
    MarketDataService.getHedgeyeSnapshot.mockResolvedValue(momoTrackerFixture(override));
    renderPanel();

    const panel = await screen.findByTestId('sp500-momo-tracker');
    await within(panel).findByText('NO NEW DATA');
    expect(within(panel).queryByRole('table')).not.toBeInTheDocument();
    expect(within(panel).queryByText('NVDA')).not.toBeInTheDocument();
    expect(panel).not.toHaveTextContent('LOADING');
    expect(panel).not.toHaveTextContent('PUBLISHED');
  });

  test('keeps the MOMO Tracker module exclusive to the SP500 1D card', async () => {
    predictionMarketTestService.getMonitor.mockResolvedValue(genericMonitorSnapshot('wti', { spotValue: 84.3 }));
    renderPanel(true, { marketId: 'wti' });

    await screen.findByRole('region', { name: 'WTI Risk Range chart' });
    expect(screen.queryByTestId('sp500-momo-tracker')).not.toBeInTheDocument();
    expect(MarketDataService.getHedgeyeSnapshot).not.toHaveBeenCalled();
  });

  test('pins an off-chart verified ATH to the top of the one-day chart and keeps its true value', async () => {
    const snapshot = monitorSnapshot();
    const ath = {
      status: 'available',
      source: 'ibkr_historical_record',
      asOf: '2026-08-17T15:00:00.000Z',
      value: 8123,
      baseline: { value: 8123, date: '2026-08-14', throughDate: '2026-08-14' },
      markers: [],
      reason: null,
    };
    snapshot.chart.ath = ath;
    snapshot.chart.variants['1d'] = { ...snapshot.chart.variants['1d'], ath };
    predictionMarketTestService.getMonitor.mockResolvedValue(snapshot);
    renderPanel();
    const chartRegion = await screen.findByRole('region', { name: 'SPX Risk Range chart' });

    const athLabel = await within(chartRegion).findByTestId('spx-1d-ath-reference');
    expect(athLabel).toHaveTextContent('ATH 8,123 (8/14/2026)');
    expect(athLabel).toHaveAttribute('data-clamp-edge', 'top');
    expect(athLabel).toHaveAttribute('aria-label', 'ATH 8,123 (8/14/2026), above visible chart range');
    expect(within(chartRegion).getByTestId('spx-chart-canvas'))
      .toHaveAttribute('data-ath-reference-clamp', 'top');
    const athLine = within(chartRegion).getByTestId('spx-1d-ath-line');
    expect(athLine).toHaveAttribute('stroke', '#2563eb');
    expect(athLine).toHaveAttribute('stroke-dasharray', '2 4');
    expect(athLine).toHaveAttribute('data-clamp-edge', 'top');
  });

  test('separates colliding right-edge labels while keeping ATH above HRR and preserving colors', async () => {
    const snapshot = monitorSnapshot();
    const ath = {
      status: 'available',
      source: 'ibkr_historical_record',
      asOf: '2026-08-17T15:00:00.000Z',
      value: 7817,
      baseline: { value: 7817, date: '2026-08-14', throughDate: '2026-08-14' },
      markers: [],
      reason: null,
    };
    const oneDay = {
      ...snapshot.chart.variants['1d'],
      latestValue: 7642,
      latestAt: '2026-08-17T14:59:00.000Z',
      points: [
        { timestamp: Date.parse('2026-08-17T14:50:00.000Z'), value: 7660 },
        { timestamp: Date.parse('2026-08-17T14:55:00.000Z'), value: 7650 },
        { timestamp: Date.parse('2026-08-17T14:59:00.000Z'), value: 7642 },
      ],
      ath,
    };
    snapshot.chart = {
      ...snapshot.chart,
      ...oneDay,
      variants: { ...snapshot.chart.variants, '1d': oneDay },
    };
    snapshot.spot = { ...snapshot.spot, value: 7642 };
    snapshot.riskRange = { ...snapshot.riskRange, lrr: 7652, hrr: 7815 };
    predictionMarketTestService.getMonitor.mockResolvedValue(snapshot);
    renderPanel();
    const chartRegion = await screen.findByRole('region', { name: 'SPX Risk Range chart' });

    const athLabel = await within(chartRegion).findByTestId('spx-1d-ath-reference');
    const hrrLabel = within(chartRegion).getByTestId('spx-1d-hrr-reference');
    const lrrLabel = within(chartRegion).getByTestId('spx-1d-lrr-reference');
    const latestLabel = within(chartRegion).getByTestId('spx-1d-latest-reference');

    expect(within(chartRegion).getByTestId('spx-chart-canvas')).toHaveAttribute('data-label-collision-count', '4');
    expect(athLabel).toHaveAttribute('fill', '#2563eb');
    expect(athLabel).toHaveTextContent('ATH 7,817 (8/14/2026)');
    expect(hrrLabel).toHaveAttribute('fill', '#059669');
    expect(lrrLabel).toHaveAttribute('fill', '#dc2626');
    expect(latestLabel).toHaveAttribute('fill', '#111827');
    expect(Number(athLabel.getAttribute('data-label-offset'))).toBeLessThan(0);
    expect(Number(hrrLabel.getAttribute('data-label-offset'))).toBeGreaterThan(0);
    expect(Number(lrrLabel.getAttribute('data-label-offset'))).toBeLessThan(0);
    expect(Number(latestLabel.getAttribute('data-label-offset'))).toBeGreaterThan(0);
  });

  test('resolves the latest verified ATH and clamps references without changing the chart domain', () => {
    const ath = {
      status: 'available',
      value: 7796,
      date: '2026-08-18',
      baseline: { value: 7706, date: '2026-08-10' },
      markers: [{ value: 7806, date: '2026-08-17' }],
    };
    expect(resolveAthReferenceValue(ath)).toBe(7806);
    expect(resolveAthReferenceDate(ath)).toBe('2026-08-17');
    expect(resolveAthReferenceValue({ status: 'unavailable', value: 9000 })).toBeNull();
    expect(resolveAthReferenceDate({ status: 'unavailable', value: 9000 })).toBeNull();
    expect(resolveAthReferenceDate({
      status: 'available',
      value: 7816.7,
      date: '2026-08-13',
      baseline: { value: 7793.68, date: '2026-08-05' },
      markers: [],
    })).toBe('2026-08-13');
    expect(clampChartReferenceValue(8123, [7600, 8000])).toEqual({ value: 8000, edge: 'top' });
    expect(clampChartReferenceValue(7806, [7600, 8000])).toEqual({ value: 7806, edge: null });
  });

  test('adds exactly 100 SPX points to both sides of the calculated multi-day axis', () => {
    expect(expandSpxPriceAxis({
      domain: [7550, 7900],
      ticks: [7550, 7600, 7650, 7700, 7750, 7800, 7850, 7900],
      step: 50,
    }, 100)).toEqual({
      domain: [7450, 8000],
      ticks: [7450, 7500, 7550, 7600, 7650, 7700, 7750, 7800, 7850, 7900, 7950, 8000],
      step: 50,
    });
  });

  test('accepts only unique official finalized Gold settlements for visible sessions', () => {
    const official = {
      status: 'available',
      availability: 'official_final',
      final: true,
      eventTicker: 'KXGOLDD-26AUG1417',
      value: 4448.11,
      observationAt: '2026-08-14T21:00:00.000Z',
      finalizedAt: '2026-08-14T22:01:00.000Z',
      source: 'kalshi_finalized_expiration_value',
    };
    const tracking = {
      status: 'available',
      source: 'kalshi_finalized_expiration_value',
      resolverSymbol: 'Metal.Index.GOLD/USD',
      settlements: [official, { ...official, eventTicker: 'KXGOLDD-26AUG1317', fromCache: true }],
    };

    expect(resolveVerifiedGoldSettlements(tracking, ['2026-08-14'])).toEqual([
      expect.objectContaining({
        date: '2026-08-14',
        value: 4448.11,
        timestamp: Date.parse('2026-08-14T21:00:00.000Z'),
      }),
    ]);
    expect(resolveVerifiedGoldSettlements({ ...tracking, settlements: [official, { ...official }] }, ['2026-08-14']))
      .toEqual([]);
    expect(resolveVerifiedGoldSettlements({ ...tracking, fromCache: true }, ['2026-08-14']))
      .toEqual([]);
  });

  test('accepts only the exact verified 5 PM Pyth settlement schedule', () => {
    const selection = settlementVenueSelection('kalshi', {
      status: 'verified',
      instrument: 'Metal.Index.GOLD/USD',
      instrumentScope: 'exact',
      method: '1-minute close',
      observationAt: '2026-08-17T21:00:00.000Z',
      sourceName: 'Pyth',
      sourceUrl: 'https://app.pyth.com/explore/Metal.Index.GOLD%2FUSD',
      rulesUrl: null,
      reason: null,
    }, 'KXGOLDD-26AUG1717');

    expect(resolveVerifiedGoldSettlementTime(selection, '2026-08-17', NOW)).toMatchObject({
      date: '2026-08-17',
      timestamp: Date.parse('2026-08-17T21:00:00.000Z'),
      sourceName: 'Pyth',
    });
    expect(resolveVerifiedGoldSettlementTime({
      ...selection,
      venue: { ...selection.venue, settlementBasis: { ...selection.venue.settlementBasis, instrumentScope: 'product' } },
    }, '2026-08-17', NOW)).toBeNull();
  });

  test.each([
    ['cache-only', { fromCache: true }],
    ['mock', { provenance: 'mock fixture' }],
    ['stale', { warning: 'stale response' }],
    ['seeded', { cacheState: 'seeded' }],
    ['offline', { sourceStatus: 'offline' }],
  ])('renders explicit unavailable VIX-close labels for %s history', async (_label, forbidden) => {
    const snapshot = monitorSnapshot();
    const dates = snapshot.chart.variants['5d'].rangeDates;
    snapshot.chart.variants['5d'] = fiveDayChartFixture({
      vixCloses: { ...verifiedVixCloses(dates), ...forbidden },
    });
    predictionMarketTestService.getMonitor.mockResolvedValue(snapshot);
    renderPanel();
    const chartRegion = await screen.findByRole('region', { name: 'SPX Risk Range chart' });

    fireEvent.click(within(chartRegion).getByRole('tab', { name: '5D' }));

    expect(within(chartRegion).getByTestId('spx-chart-canvas')).toHaveAttribute('data-vix-close-count', '0');
    const vixLabels = within(chartRegion).getAllByTestId(/^spx-5d-vix-close-/);
    expect(vixLabels).toHaveLength(5);
    expect(vixLabels.every((label) => label.getAttribute('data-state') === 'unavailable')).toBe(true);
    vixLabels.forEach((label) => expect(within(label).getByText('VIX —')).toBeInTheDocument());
    expect(resolveVerifiedVixCloses(
      snapshot.chart.variants['5d'].vixCloses,
      dates,
    ).size).toBe(0);
  });

  test.each([
    ['loading', 'ATH CHECKING'],
    ['unavailable', 'ATH UNAVAILABLE'],
  ])('keeps verified prices mounted while ATH is %s', async (athStatus, label) => {
    const snapshot = monitorSnapshot();
    snapshot.chart.variants['5d'] = fiveDayChartFixture({
      ath: { status: athStatus, source: null, baseline: null, markers: [], reason: label },
    });
    predictionMarketTestService.getMonitor.mockResolvedValue(snapshot);
    const view = renderPanel();
    const chartRegion = await screen.findByRole('region', { name: 'SPX Risk Range chart' });

    fireEvent.click(within(chartRegion).getByRole('tab', { name: '5D' }));

    expect(within(chartRegion).getByText(label)).toBeInTheDocument();
    expect(within(chartRegion).getAllByTestId(/^spx-5d-session-/)).toHaveLength(5);
    expect(within(chartRegion).queryByText('SPX 5D DATA UNAVAILABLE')).not.toBeInTheDocument();
    view.unmount();
  });

  test('keeps the five-day price chart visible and labels a missing daily Risk Range', async () => {
    const snapshot = monitorSnapshot();
    snapshot.chart.variants['5d'] = fiveDayChartFixture({ missingDate: '2026-08-13' });
    predictionMarketTestService.getMonitor.mockResolvedValue(snapshot);
    renderPanel();
    const chartRegion = await screen.findByRole('region', { name: 'SPX Risk Range chart' });

    fireEvent.click(within(chartRegion).getByRole('tab', { name: '5D' }));

    expect(screen.getByTestId('spx-5d-rr-unavailable-2026-08-13')).toHaveTextContent('RR unavailable');
    const chartCanvas = within(chartRegion).getByTestId('spx-chart-canvas');
    expect(chartCanvas).toHaveAttribute('data-session-count', '5');
    expect(chartCanvas).toHaveAttribute('data-rr-overlay-count', '4');
    expect(chartCanvas).not.toHaveAttribute('data-risk-range-structure-score');
    expect(chartCanvas).not.toHaveAttribute('data-risk-range-high-structure-score');
    expect(chartCanvas).not.toHaveAttribute('data-risk-range-low-structure-score');
    expect(within(chartRegion).queryByTestId(/^spx-5d-high-structure-/)).not.toBeInTheDocument();
    expect(within(chartRegion).queryByTestId(/^spx-5d-low-structure-/)).not.toBeInTheDocument();
    expect(within(chartRegion).getByTestId('spx-5d-rr-structure-summary')).toHaveTextContent('H—·L—');
    expect(within(chartRegion).getByTestId('spx-5d-rr-structure-summary')).toHaveAttribute(
      'aria-label',
      '5D consecutive Risk Range trends unavailable',
    );
    expect(within(chartRegion).queryByText('SPX 5D DATA UNAVAILABLE')).not.toBeInTheDocument();
  });

  test.each([
    ['cache-only', { fromCache: true }],
    ['seeded', { seeded: true }],
    ['mock', { mock: true }],
    ['disconnected', { connected: false }],
    ['stale', { availability: 'stale' }],
    ['expired', { expiresAt: '2026-08-17T14:00:00.000Z' }],
  ])('withholds the 1D structure summary when its 10D source is %s', async (_state, sourceOverride) => {
    const snapshot = monitorSnapshot();
    snapshot.chart.variants['10d'] = {
      ...snapshot.chart.variants['10d'],
      ...sourceOverride,
    };
    predictionMarketTestService.getMonitor.mockResolvedValue(snapshot);
    renderPanel();
    const chartRegion = await screen.findByRole('region', { name: 'SPX Risk Range chart' });

    expect(within(chartRegion).getByTestId('spx-1d-rr-structure-summary')).toHaveTextContent('H—·L—');
    expect(within(chartRegion).getByTestId('spx-1d-rr-structure-summary')).toHaveAttribute(
      'aria-label',
      '1D summary from the ending 10D consecutive Risk Range trends unavailable',
    );
    expect(within(chartRegion).getByTestId('spx-chart-canvas'))
      .not.toHaveAttribute('data-risk-range-high-structure-score');
  });

  test('keeps 5D selected and distinguishes unavailable data from a verified-history refresh', async () => {
    const unavailableSnapshot = monitorSnapshot();
    unavailableSnapshot.chart.variants['5d'] = fiveDayChartFixture({ status: 'unavailable' });
    predictionMarketTestService.getMonitor.mockResolvedValue(unavailableSnapshot);
    const view = renderPanel();
    const chartRegion = await screen.findByRole('region', { name: 'SPX Risk Range chart' });

    fireEvent.click(within(chartRegion).getByRole('tab', { name: '5D' }));
    expect(within(chartRegion).getByText('SPX 5D DATA UNAVAILABLE')).toBeInTheDocument();
    expect(within(chartRegion).getByRole('tab', { name: '5D' })).toHaveAttribute('aria-selected', 'true');

    const refreshingSnapshot = monitorSnapshot();
    refreshingSnapshot.chart.variants['5d'] = {
      ...fiveDayChartFixture({ status: 'unavailable' }),
      status: 'refreshing',
      refreshing: true,
    };
    predictionMarketTestService.getMonitor.mockResolvedValue(refreshingSnapshot);
    view.unmount();
    act(() => resetSessionResourceStore());
    window.sessionStorage.clear();
    renderPanel();
    const refreshedRegion = await screen.findByRole('region', { name: 'SPX Risk Range chart' });
    fireEvent.click(within(refreshedRegion).getByRole('tab', { name: '5D' }));
    expect(within(refreshedRegion).getByText('LOADING VERIFIED SPX 5D PRICE HISTORY…')).toBeInTheDocument();
    expect(within(refreshedRegion).queryByText('SPX 5D DATA UNAVAILABLE')).not.toBeInTheDocument();
  });

  test('shows a terminal unavailable range instead of a spinner while its provider retry runs', async () => {
    const terminalSnapshot = monitorSnapshot();
    terminalSnapshot.chart.variants['5d'] = {
      ...fiveDayChartFixture({ status: 'unavailable' }),
      status: 'unavailable',
      refreshing: false,
      refreshPending: true,
      refreshFailed: true,
      errorCode: 'PYTH_ENTITLEMENT_REQUIRED',
      reason: 'Exact resolver history requires Pyth entitlement.',
    };
    predictionMarketTestService.getMonitor.mockResolvedValue(terminalSnapshot);
    renderPanel();
    const chartRegion = await screen.findByRole('region', { name: 'SPX Risk Range chart' });

    fireEvent.click(within(chartRegion).getByRole('tab', { name: '5D' }));
    expect(within(chartRegion).getByText('SPX 5D DATA UNAVAILABLE')).toBeInTheDocument();
    expect(within(chartRegion).queryByText('LOADING VERIFIED SPX 5D PRICE HISTORY…')).not.toBeInTheDocument();
  });

  test('keeps the selected verified five-day chart visible while its new source data is refreshing', async () => {
    const refreshingVariant = (range) => ({
      status: 'refreshing',
      refreshing: true,
      availability: 'unavailable',
      source: null,
      expiresAt: null,
      range,
      points: [],
      dailyRanges: [],
      rangeDates: [],
    });
    const retainedFiveDay = fiveDayChartFixture();
    const next = monitorSnapshot({
      spot: factor('available', { value: 7751.5, label: 'LIVE SPX' }),
      chart: {
        ...refreshingVariant('1d'),
        variants: {
          '1d': refreshingVariant('1d'),
          '5d': {
            ...retainedFiveDay,
            refreshPending: true,
            refreshRetained: true,
          },
          '10d': refreshingVariant('10d'),
        },
      },
      refresh: { state: 'refreshing', revision: 2, suggestedNextPollMs: 750 },
    });
    predictionMarketTestService.getMonitor
      .mockResolvedValueOnce(monitorSnapshot())
      .mockResolvedValueOnce(next);
    renderPanel();
    const chartRegion = await screen.findByRole('region', { name: 'SPX Risk Range chart' });
    fireEvent.click(within(chartRegion).getByRole('tab', { name: '5D' }));
    expect(within(chartRegion).getAllByTestId(/^spx-5d-session-/)).toHaveLength(5);
    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      await pollSnapshot();
    });

    const retainedLatest = await within(chartRegion).findByTestId('spx-5d-latest-reference');
    expect(retainedLatest).toHaveTextContent('7,744');
    expect(within(chartRegion).getAllByTestId(/^spx-5d-session-/)).toHaveLength(5);
    expect(within(chartRegion).queryByText('SPX 5D CHART REFRESHING')).not.toBeInTheDocument();
    expect(within(chartRegion).queryByText(/^REFRESHING$/)).not.toBeInTheDocument();
  });

  test('preserves the selected range without an activation-only request when the monitor is reopened', async () => {
    const view = renderPanel();
    const chartRegion = await screen.findByRole('region', { name: 'SPX Risk Range chart' });
    fireEvent.click(within(chartRegion).getByRole('tab', { name: '5D' }));
    expect(within(chartRegion).getByRole('tab', { name: '5D' })).toHaveAttribute('aria-selected', 'true');

    view.rerender(
      <PersistentSurface active={false}>
        <PredictionMarketResolverTest />
      </PersistentSurface>,
    );
    view.rerender(
      <PersistentSurface active>
        <PredictionMarketResolverTest />
      </PersistentSurface>,
    );

    await waitFor(() => expect(screen.getByRole('tab', { name: '5D' })).toHaveAttribute('aria-selected', 'true'));
    expect(predictionMarketTestService.getMonitor).toHaveBeenCalledTimes(1);
  });

  test('keeps a populated Gold chart mounted through network and server-side refresh shells', async () => {
    const initial = genericMonitorSnapshot('gold', { spotValue: 3500 });
    const refreshingVariant = (range) => ({
      status: 'refreshing',
      availability: 'unavailable',
      refreshing: true,
      refreshPending: true,
      refreshFailed: false,
      source: null,
      expiresAt: null,
      range,
      points: [],
      dailyRanges: [],
      rangeDates: [],
    });
    const pending = genericMonitorSnapshot('gold', { spotValue: 3500 });
    pending.chart = {
      ...refreshingVariant('1d'),
      variants: {
        '1d': refreshingVariant('1d'),
        '5d': refreshingVariant('5d'),
        '10d': refreshingVariant('10d'),
      },
    };
    pending.refresh = { state: 'refreshing', revision: 2, suggestedNextPollMs: 750 };
    const replacement = genericMonitorSnapshot('gold', { spotValue: 3502 });
    const replacementPoint = {
      timestamp: Date.parse('2026-08-17T15:00:00.000Z'),
      value: 3502,
    };
    replacement.chart = {
      ...replacement.chart,
      latestAt: '2026-08-17T15:00:00.000Z',
      latestValue: 3502,
      points: [...replacement.chart.points, replacementPoint],
      variants: {
        ...replacement.chart.variants,
        '1d': {
          ...replacement.chart.variants['1d'],
          latestAt: '2026-08-17T15:00:00.000Z',
          latestValue: 3502,
          points: [...replacement.chart.variants['1d'].points, replacementPoint],
        },
      },
    };
    replacement.refresh = { state: 'idle', revision: 3, suggestedNextPollMs: 5_000 };
    const terminal = genericMonitorSnapshot('gold', { spotValue: null });
    const terminalVariant = (range) => ({
      ...refreshingVariant(range),
      status: 'unavailable',
      refreshing: false,
      refreshPending: false,
      refreshFailed: true,
      errorCode: 'PYTH_ENTITLEMENT_REQUIRED',
      reason: 'Exact resolver history is temporarily unavailable.',
    });
    terminal.chart = {
      ...terminalVariant('1d'),
      variants: {
        '1d': terminalVariant('1d'),
        '5d': terminalVariant('5d'),
        '10d': terminalVariant('10d'),
      },
    };
    terminal.refresh = { state: 'idle', revision: 4, suggestedNextPollMs: 5_000 };
    let resolvePending;
    predictionMarketTestService.getMonitor
      .mockResolvedValueOnce(initial)
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolvePending = resolve;
      }))
      .mockResolvedValueOnce(replacement)
      .mockResolvedValueOnce(terminal);

    renderPanel(true, { marketId: 'gold' });
    const chartRegion = await screen.findByRole('region', { name: 'GOLD Risk Range chart' });
    const canvas = within(chartRegion).getByTestId('spx-chart-canvas');
    await waitFor(() => expect(canvas).toHaveAttribute('data-chart-point-count', '2'));
    const initialChartDomCount = chartRegion.querySelectorAll('.pm-spx-chart-frame').length;
    expect(initialChartDomCount).toBeGreaterThan(0);
    const monitorPoll = startVisibilityAwarePolling.mock.calls
      .map(([options]) => options)
      .find(({ intervalMs }) => intervalMs === 5_000)?.poll;
    expect(monitorPoll).toEqual(expect.any(Function));

    let pendingRequest;
    act(() => {
      pendingRequest = monitorPoll();
    });
    expect(canvas).toHaveAttribute('data-chart-point-count', '2');
    expect(canvas).toHaveAttribute('data-chart-display-phase', 'refreshing-with-chart');
    expect(within(chartRegion).queryByText(/^Refreshing$/i)).not.toBeInTheDocument();
    expect(chartRegion.querySelectorAll('.pm-spx-chart-frame').length).toBeGreaterThanOrEqual(initialChartDomCount);
    expect(within(chartRegion).queryByText('LOADING VERIFIED GOLD 1D PRICE HISTORY…')).not.toBeInTheDocument();

    await act(async () => {
      resolvePending(pending);
      await pendingRequest;
    });
    expect(canvas).toHaveAttribute('data-chart-point-count', '2');
    expect(canvas).toHaveAttribute('data-chart-display-phase', 'retained-refresh');
    expect(canvas).toHaveAttribute('data-chart-retained-refresh', 'true');
    expect(within(chartRegion).queryByText(/^Refreshing$/i)).not.toBeInTheDocument();
    expect(chartRegion.querySelectorAll('.pm-spx-chart-frame').length).toBeGreaterThanOrEqual(initialChartDomCount);
    expect(within(chartRegion).queryByText('LOADING VERIFIED GOLD 1D PRICE HISTORY…')).not.toBeInTheDocument();

    await act(async () => {
      await monitorPoll();
    });
    expect(canvas).toHaveAttribute('data-chart-point-count', '3');
    expect(canvas).toHaveAttribute('data-chart-display-phase', 'ready');
    expect(canvas).toHaveAttribute('data-chart-retained-refresh', 'false');
    expect(chartRegion.querySelector('.pm-spx-chart-refresh-indicator')).not.toBeInTheDocument();
    expect(chartRegion.querySelectorAll('.pm-spx-chart-frame').length).toBeGreaterThan(0);

    await act(async () => {
      await monitorPoll();
    });
    expect(canvas).toHaveAttribute('data-chart-point-count', '3');
    expect(canvas).toHaveAttribute('data-chart-display-phase', 'dated-reference');
    expect(chartRegion.querySelector('.pm-spx-chart-refresh-indicator')).not.toBeInTheDocument();
    expect(within(chartRegion).queryByText('LOADING VERIFIED GOLD 1D PRICE HISTORY…')).not.toBeInTheDocument();
  });

  test('hydrates dated Gold history on the first render after a same-tab reload and survives disconnect', async () => {
    const initial = genericMonitorSnapshot('gold', { spotValue: 3500 });
    predictionMarketTestService.getMonitor.mockResolvedValueOnce(initial);
    const firstView = renderPanel(true, { marketId: 'gold' });
    const firstChart = await screen.findByRole('region', { name: 'GOLD Risk Range chart' });
    await waitFor(() => expect(within(firstChart).getByTestId('spx-chart-canvas'))
      .toHaveAttribute('data-chart-point-count', '2'));

    const storageKey = 'market-dashboard.reference.prediction-monitor.gold.kalshi.default.v1';
    const persisted = JSON.parse(window.sessionStorage.getItem(storageKey));
    expect(persisted.data).toMatchObject({
      referenceOnly: true,
      chart: { status: 'historical', points: expect.any(Array) },
      executionAvailable: false,
    });
    expect(persisted.data.goldMarketReferences).toBeUndefined();
    expect(persisted.data.contracts.lines.every((line) => (
      line.yesBid === null && line.yesAsk === null && line.noBid === null && line.noAsk === null
    ))).toBe(true);

    firstView.unmount();
    act(() => resetSessionResourceStore());
    predictionMarketTestService.getMonitor.mockRejectedValue(
      Object.assign(new Error('IBKR provider disconnected.'), { code: 'PROVIDER_DISCONNECTED' }),
    );

    const secondView = renderPanel(true, { marketId: 'gold' });
    const reloadedChart = screen.getByRole('region', { name: 'GOLD Risk Range chart' });
    const reloadedCanvas = within(reloadedChart).getByTestId('spx-chart-canvas');
    expect(reloadedCanvas).toHaveAttribute('data-chart-point-count', '2');
    expect(reloadedCanvas).toHaveAttribute('data-chart-display-phase', 'dated-reference');
    expect(reloadedChart.querySelector('.pm-spx-chart-frame')).toBeInTheDocument();
    expect(within(reloadedChart).queryByText('LOADING VERIFIED GOLD 1D PRICE HISTORY…')).not.toBeInTheDocument();

    await waitFor(() => expect(predictionMarketTestService.getMonitor).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(secondView.container.querySelector('.pm-spx-monitor-shell'))
      .toHaveAttribute('aria-busy', 'false'));
    expect(reloadedCanvas).toHaveAttribute('data-chart-point-count', '2');
    expect(reloadedCanvas).toHaveAttribute('data-chart-display-phase', 'dated-reference');
    expect(within(reloadedChart).queryByText('LOADING VERIFIED GOLD 1D PRICE HISTORY…')).not.toBeInTheDocument();
  });

  test('renders date, price, LRR, and HRR in a five-day tooltip', () => {
    const fiveDay = fiveDayChartFixture();
    const point = {
      timestamp: Date.parse('2026-08-13T14:55:00.000Z'),
      value: 7724,
      sessionDate: '2026-08-13',
    };

    render(<ChartTooltip
      active
      payload={[{ payload: point }]}
      multiDay
      dailyRanges={fiveDay.dailyRanges}
      ath={{
        status: 'available',
        markers: [{ date: '2026-08-13', timestamp: point.timestamp, value: 7726 }],
      }}
    />);

    expect(screen.getByText('SPOT 7,724.00')).toBeInTheDocument();
    expect(screen.getByText(/Thu, Aug 13.*10:55 AM EDT/)).toBeInTheDocument();
    expect(screen.getByText('LRR 7,620 · HL · HRR 7,820 · HH')).toBeInTheDocument();
    expect(screen.getByText('ATH 7,726')).toBeInTheDocument();
  });

  test('shows both raw basis and contract values in the chart tooltip', () => {
    const timestamp = Date.parse('2026-08-17T14:55:00.000Z');
    render(<ChartTooltip
      active
      payload={[
        { dataKey: 'value', payload: { timestamp, value: 7634 } },
        { dataKey: 'contractValue', payload: { timestamp, contractValue: 7648 } },
      ]}
      basisSymbol="SPX"
      contractSymbol="ESU26"
    />);

    expect(screen.getByText('SPX 7,634.00')).toBeInTheDocument();
    expect(screen.getByText('ESU26 7,648.00')).toBeInTheDocument();
  });

  test('does not expose ForecastEx FES sizing controls when a live IBKR account is available', async () => {
    let resolvePositions;
    MarketDataService.getPortfolioPredictionMarketPositions.mockReturnValue(new Promise((resolve) => {
      resolvePositions = resolve;
    }));
    renderPanel(true, { portfolioData: livePortfolio, selectedAccount: 'U1234567' });

    expect(await screen.findByRole('region', { name: 'SPX factor monitor' })).toBeInTheDocument();
    await waitFor(() => expect(MarketDataService.getPortfolioPredictionMarketPositions).toHaveBeenCalled());
    const ladder = screen.getByRole('region', { name: 'S&P 500 prediction-market contract ladder' });
    expect(await within(ladder).findByRole('columnheader', { name: 'ESU26 SETTLES ABOVE' })).toBeInTheDocument();
    expect(within(ladder).queryByText(/POSITIONS (?:CHECKING|UNAVAILABLE)/)).not.toBeInTheDocument();
    await act(async () => {
      resolvePositions({
        status: 'live',
        meta: { status: 'live', source: 'ibkr_live', fetchedAt: new Date(NOW).toISOString() },
        accounts: [{ accountId: 'U1234567', status: 'live' }],
        positions: [],
        fetchedAt: new Date(NOW).toISOString(),
      });
    });
    expect(within(ladder).getByRole('columnheader', { name: 'ESU26 SETTLES ABOVE' })).toBeInTheDocument();
    expect(within(ladder).queryByText(/POSITIONS (?:CHECKING|UNAVAILABLE)/)).not.toBeInTheDocument();
    expect(screen.queryByRole('complementary', { name: 'S&P 500 resolver diagnostics and position sizing' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Portfolio allocation percent')).not.toBeInTheDocument();
    expect(screen.queryByRole('complementary', { name: 'SPX strategy and position sizing' })).not.toBeInTheDocument();
  });

  test('turns a fixed ForecastEx catalog without a verified book into an explicit no-live-book ladder', async () => {
    const snapshot = monitorSnapshot();
    const catalog = {
      ...snapshot.venues.forecastex.catalog,
      scheduleOnly: true,
      lines: snapshot.venues.forecastex.catalog.lines.map((line) => ({
        ...line,
        status: 'catalog',
        directNative: false,
        yesBid: null,
        yesAsk: null,
        noBid: null,
        noAsk: null,
      })),
    };
    const unavailableBook = factor('unavailable', {
      source: null,
      event: catalog.event,
      lines: [],
      reason: 'No verified native ForecastEx book.',
    });
    snapshot.contracts = unavailableBook;
    snapshot.displayContracts = catalog;
    snapshot.venues.forecastex = {
      ...snapshot.venues.forecastex,
      catalog,
      book: unavailableBook,
      contracts: unavailableBook,
    };
    predictionMarketTestService.getMonitor.mockResolvedValue(snapshot);

    renderPanel();

    const ladder = await screen.findByRole('table', { name: /All active ForecastEx S&P 500 lines/i });
    expect(await within(ladder).findByText('7,725')).toBeInTheDocument();
    expect(within(ladder).getAllByText('NO QUOTE')).toHaveLength(8);
    expect(screen.queryByRole('complementary', { name: 'S&P 500 resolver diagnostics and position sizing' })).not.toBeInTheDocument();
  });

  test('uses the top-level selected ladder from a compact card response when venue lines are summarized', async () => {
    const snapshot = monitorSnapshot();
    const catalog = {
      ...snapshot.contracts,
      source: 'forecastex_official_schedule',
      scheduleOnly: true,
      bookStatus: 'unavailable',
      reason: 'Official terms are available without a verified live book.',
      lines: snapshot.contracts.lines.map((line) => ({
        ...line,
        status: 'catalog',
        source: 'forecastex_official_schedule',
        directNative: false,
        yesBid: null,
        yesAsk: null,
        noBid: null,
        noAsk: null,
      })),
    };
    snapshot.cardView = true;
    snapshot.contracts = catalog;
    snapshot.displaySelection = {
      status: 'available', mode: 'catalog', venueId: 'forecastex',
      label: 'ForecastEx catalog', reason: catalog.reason,
      contractSummary: { ...catalog, lines: undefined, lineCount: catalog.lines.length },
    };
    snapshot.autoSelection = {
      status: 'unavailable', mode: 'none', venueId: null,
      reason: 'No executable venue.', contractSummary: { status: 'unavailable', lineCount: 0 },
    };
    snapshot.venues.forecastex = {
      ...snapshot.venues.forecastex,
      status: 'partial',
      catalog: { ...catalog, lines: undefined, lineCount: catalog.lines.length },
      book: {
        status: 'unavailable', source: null, event: catalog.event,
        reason: catalog.reason, lineCount: 0,
      },
      contracts: {
        status: 'unavailable', source: null, event: catalog.event,
        reason: catalog.reason, lineCount: 0,
      },
    };
    predictionMarketTestService.getMonitor.mockResolvedValue(snapshot);

    renderPanel();

    const ladder = await screen.findByRole('table', { name: /Selected display ForecastEx/i });
    expect(await within(ladder).findByText('7,725')).toBeInTheDocument();
    expect(within(ladder).getByText('7,775')).toBeInTheDocument();
    expect(within(ladder).getAllByText('NO QUOTE')).toHaveLength(8);
    expect(screen.queryByText(/Official contract terms are available, but no fresh native/i)).not.toBeInTheDocument();
  });

  test('places the exact live FES futures marker between the surrounding strikes', async () => {
    renderPanel();
    const ladder = await screen.findByRole('table', { name: /All active ForecastEx/i });
    await within(ladder).findByText('7,725');
    const rows = within(ladder).getAllByRole('row');
    const lowRow = within(ladder).getByRole('row', { name: /^7,725 / });
    const highRow = within(ladder).getByRole('row', { name: /^7,775 / });
    const marker = within(ladder).getByRole('row', { name: /EXACT · ESU26 · LIVE 7,746.25/ });

    expect(rows.indexOf(marker)).toBe(rows.indexOf(lowRow) + 1);
    expect(rows.indexOf(highRow)).toBe(rows.indexOf(marker) + 1);
    const markerLine = within(marker).getByTestId('spx-live-marker-line');
    const priceTrack = within(markerLine).getByTestId('spx-live-marker-price-track');
    const contextTrack = within(markerLine).getByTestId('spx-live-marker-context-track');
    expect(within(priceTrack).getByText('7,746.25')).toHaveClass('pm-spx-live-marker-price');
    expect(within(contextTrack).getByText('EXACT · ESU26 · LIVE')).toHaveClass('pm-spx-live-marker-context');
  });

  test('keeps the blue FES resolver marker visible while its still-fresh quote refreshes', async () => {
    const initial = monitorSnapshot();
    const refreshing = monitorSnapshot({
      refresh: { state: 'refreshing', revision: 2, suggestedNextPollMs: 750 },
    });
    refreshing.resolverReference = {
      ...refreshing.resolverReference,
      status: 'refreshing',
      spot: {
        ...refreshing.resolverReference.spot,
        refreshing: false,
        refreshRetained: true,
        refreshPending: true,
      },
    };
    predictionMarketTestService.getMonitor
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(refreshing);

    renderPanel();
    expect(await screen.findByRole('row', { name: /EXACT · ESU26 · LIVE 7,746.25/ })).toBeInTheDocument();

    await act(async () => {
      await pollSnapshot();
    });

    expect(screen.getByRole('row', { name: /EXACT · ESU26 · LIVE 7,746.25/ })).toBeInTheDocument();
  });

  test('keeps a verified proxy marker mounted and relabels it delayed when freshness is lost', async () => {
    const initial = monitorSnapshot();
    initial.resolverReference = {
      ...initial.resolverReference,
      instrument: { ...initial.resolverReference.instrument, displaySymbol: 'ESU6' },
      spot: {
        ...initial.resolverReference.spot,
        fit: 'proxy',
        label: 'ESU6',
        expiresAt: new Date(NOW + 250).toISOString(),
      },
    };
    predictionMarketTestService.getMonitor.mockResolvedValue(initial);

    renderPanel();
    expect(await screen.findByRole('row', { name: /PROXY · ESU6 · LIVE 7,746.25/ })).toBeInTheDocument();

    await act(async () => {
      Date.now.mockReturnValue(NOW + 2_000);
      await new Promise((resolve) => setTimeout(resolve, 1_050));
    });

    expect(screen.getByRole('row', { name: /PROXY · ESU6 · DELAYED 7,746.25/ })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'ESU26 SETTLES ABOVE' })).toBeInTheDocument();
    expect(screen.queryByText(/POSITIONS (?:CHECKING|UNAVAILABLE)/)).not.toBeInTheDocument();
  });

  test('keeps the last verified same-generation FES marker visible as delayed in a compact card snapshot', async () => {
    const snapshot = monitorSnapshot();
    snapshot.cardView = true;
    snapshot.resolverReference = {
      ...snapshot.resolverReference,
      spot: factor('unavailable', {
        availability: 'unavailable', fit: 'exact', value: null,
        source: null, asOf: null, expiresAt: null, executable: false,
      }),
      lastVerifiedSpot: {
        status: 'last_verified', availability: 'last_verified', fit: 'exact',
        value: 7746.25, source: 'ibkr_live_native_quote',
        asOf: new Date(NOW - 65_000).toISOString(),
        generationKey: 'FES_081726', retainedUntil: '2026-08-17T20:00:00.000Z',
        displayOnly: true, executable: false, stale: true,
      },
    };
    predictionMarketTestService.getMonitor.mockResolvedValue(snapshot);

    renderPanel();

    const ladder = await screen.findByRole('table', { name: /ForecastEx S&P 500 lines/i });
    const marker = within(ladder).getByRole('row', { name: /EXACT · ESU26 · DELAYED 7,746.25/ });
    expect(within(marker).getByTestId('spx-live-marker-line')).toBeInTheDocument();
    expect(within(marker).getByText('EXACT · ESU26 · DELAYED')).toHaveClass('pm-spx-live-marker-context');
    expect(within(ladder).getByRole('columnheader', { name: 'Δ ESU26' })).toBeInTheDocument();
    expect(snapshot.resolverReference.lastVerifiedSpot).toMatchObject({
      displayOnly: true, executable: false,
    });
  });

  test('never shows a last-verified FES marker from a prior generation', async () => {
    const snapshot = monitorSnapshot();
    snapshot.resolverReference = {
      ...snapshot.resolverReference,
      spot: factor('unavailable', {
        availability: 'unavailable', fit: 'exact', value: null,
        source: null, asOf: null, expiresAt: null, executable: false,
      }),
      lastVerifiedSpot: {
        status: 'last_verified', availability: 'last_verified', fit: 'exact',
        value: 7746.25, source: 'ibkr_live_native_quote',
        asOf: new Date(NOW - 5_000).toISOString(),
        generationKey: 'FES_081626', retainedUntil: '2026-08-17T20:00:00.000Z',
        displayOnly: true, executable: false, stale: true,
      },
    };
    predictionMarketTestService.getMonitor.mockResolvedValue(snapshot);

    renderPanel();

    const ladder = await screen.findByRole('table', { name: /All active ForecastEx/i });
    await within(ladder).findByText('7,725');
    expect(within(ladder).queryByTestId('spx-live-marker-line')).not.toBeInTheDocument();
  });

  test('applies the shared three-level proximity shading above and below the SPX marker', async () => {
    const snapshot = monitorSnapshot();
    const template = snapshot.contracts.lines[0];
    snapshot.contracts.lines = [7675, 7700, 7725, 7750, 7775, 7800, 7825, 7850]
      .map((threshold) => ({
        ...template,
        ticker: `FES_081726_${threshold}`,
        contractId: `FES_081726_${threshold}`,
        threshold,
      }));
    predictionMarketTestService.getMonitor.mockResolvedValue(snapshot);

    renderPanel();

    const ladder = await screen.findByRole('table', { name: /ForecastEx S&P 500 lines/i });
    const rowFor = (threshold) => within(ladder).getByRole('row', {
      name: new RegExp(`^${threshold.toLocaleString('en-US')} `),
    });
    expect(rowFor(7725)).toHaveAttribute('data-spot-proximity', 'dark');
    expect(rowFor(7750)).toHaveAttribute('data-spot-proximity', 'dark');
    expect(rowFor(7700)).toHaveAttribute('data-spot-proximity', 'medium');
    expect(rowFor(7775)).toHaveAttribute('data-spot-proximity', 'medium');
    expect(rowFor(7675)).toHaveAttribute('data-spot-proximity', 'light');
    expect(rowFor(7800)).toHaveAttribute('data-spot-proximity', 'light');
    expect(within(ladder).getAllByRole('row').filter((row) => row.dataset.spotProximity)).toHaveLength(6);
  });

  test('shows only the five nearest FES contracts on each side of the exact live resolver spot', async () => {
    const base = monitorSnapshot();
    const template = base.contracts.lines[0];
    const contracts = {
      ...base.contracts,
      lines: Array.from({ length: 15 }, (_, index) => {
        const threshold = 7550 + (index * 25);
        return {
          ...template,
          ticker: `FES_081726_${threshold}`,
          contractId: `FES_081726_${threshold}`,
          threshold,
          volume24h: index * 10,
          openInterest: index * 100,
        };
      }),
    };
    predictionMarketTestService.getMonitor.mockResolvedValue(monitorSnapshot({ contracts }));

    renderPanel();
    const ladder = await screen.findByRole('table', { name: /All active ForecastEx/i });
    await within(ladder).findByRole('row', { name: /EXACT · ESU26 · LIVE 7,746.25/ });

    expect(within(ladder).getAllByText(/^7,/, { selector: 'strong[title]' }).map((cell) => cell.textContent)).toEqual([
      '7,625', '7,650', '7,675', '7,700', '7,725',
      '7,750', '7,775', '7,800', '7,825', '7,850',
    ]);
    expect(within(ladder).queryByText('7,600')).not.toBeInTheDocument();
    expect(within(ladder).queryByText('7,875')).not.toBeInTheDocument();
  });

  test('does not use a historical futures close as the active FES ladder reference', async () => {
    const snapshot = monitorSnapshot({
      session: { state: 'closed', asOf: '2026-08-17T20:00:00.000Z' },
      spot: factor('historical', {
        availability: 'last_close',
        value: 7746.25,
        label: 'LAST CLOSE',
        asOf: '2026-08-17T20:00:00.000Z',
      }),
    });
    snapshot.resolverReference = {
      ...snapshot.resolverReference,
      spot: factor('historical', {
        availability: 'historical', fit: 'exact', value: 7746.25, label: 'ESU26',
        source: 'ibkr_historical_daily_close', executable: false,
      }),
    };
    predictionMarketTestService.getMonitor.mockResolvedValue(snapshot);

    renderPanel();
    const ladder = await screen.findByRole('table', { name: /All active ForecastEx/i });
    await within(ladder).findByText('7,725');

    expect(within(ladder).queryByTestId('spx-live-marker-line')).not.toBeInTheDocument();
    expect(within(ladder).queryByRole('row', { name: /CLOSE 8\/17/ })).not.toBeInTheDocument();
  });

  test('renders a verified completed ES bar as an exact last-close FES ladder marker', async () => {
    const completedAsOf = '2026-08-14T20:00:00.000Z';
    const completedReference = factor('historical', {
      availability: 'historical', fit: 'exact', value: 7746.25,
      label: 'ESU26 LAST CLOSE', source: 'ibkr_historical_bars',
      asOf: completedAsOf, historicalThroughDate: '2026-08-14', executable: false,
    });
    const snapshot = monitorSnapshot({
      session: { state: 'closed', asOf: completedAsOf },
      spot: completedReference,
    });
    snapshot.resolverReference = {
      ...snapshot.resolverReference,
      spot: completedReference,
    };
    predictionMarketTestService.getMonitor.mockResolvedValue(snapshot);

    renderPanel();

    const ladder = await screen.findByRole('table', { name: /All active ForecastEx/i });
    expect(await within(ladder).findByRole('row', {
      name: /EXACT · ESU26 · LAST CLOSE 7,746\.25 \(8\/14\)/,
    })).toBeInTheDocument();
  });

  test('fits every contract row into a no-scroll ladder while keeping the blue marker', async () => {
    renderPanel();

    const ladderPanel = await screen.findByRole('region', { name: 'S&P 500 prediction-market contract ladder' });
    await within(ladderPanel).findByText('7,725');
    expect(ladderPanel).toHaveAttribute('data-fit-mode', 'no-scroll');
    expect(ladderPanel).toHaveAttribute('data-contract-row-count', '2');
    expect(ladderPanel.style.getPropertyValue('--pm-spx-ladder-row-share')).toBe('50%');
    expect(within(ladderPanel).getByTestId('spx-live-marker-line')).toBeInTheDocument();
  });

  test('keeps the still-valid atomic server revision across a transient transport timeout', async () => {
    predictionMarketTestService.getMonitor
      .mockResolvedValueOnce(monitorSnapshot())
      .mockRejectedValueOnce(new Error('transport timeout'));
    renderPanel();
    const ladder = await screen.findByRole('table', { name: /All active ForecastEx/i });
    await within(ladder).findByText('7,725');

    await act(async () => {
      await pollSnapshot();
    });

    expect(screen.getByRole('table', { name: /All active ForecastEx/i })).toBe(ladder);
    expect(screen.getByText('7,725')).toBeInTheDocument();
    expect(within(ladder).getByTestId('spx-live-marker-line')).toBeInTheDocument();
    expect(screen.queryByText('NO QUOTE')).not.toBeInTheDocument();
    expect(within(ladder).getByRole('cell', { name: 'Yes bid: 66¢, displayed size 40 contracts' })).toBeInTheDocument();
    expect(within(ladder).getByRole('cell', { name: 'Yes ask: 68¢, displayed size 50 contracts' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getAllByText(/REFRESH DELAYED/).length).toBeGreaterThan(0);
    expect(screen.queryByText('SPX 1D DATA UNAVAILABLE')).not.toBeInTheDocument();
  });

  test('keeps catalog context but fails closed for native FES rows through a localized timeout', async () => {
    const initial = monitorSnapshot();
    initial.resolverReference.lastVerifiedSpot = {
      status: 'last_verified', availability: 'last_verified', fit: 'exact',
      value: 7746.25, label: 'ESU26', source: 'ibkr_live_native_quote',
      asOf: new Date(NOW - 5_000).toISOString(),
      generationKey: 'FES_081726', retainedUntil: '2026-08-17T20:00:00.000Z',
      displayOnly: true, executable: false, stale: true,
    };
    const timedOut = monitorSnapshot({
      status: 'partial',
      spot: factor('unavailable', {
        value: null,
        label: 'LIVE SPX',
        refreshFailed: true,
        refreshIssue: 'IBKR quote refresh timed out',
      }),
      contracts: factor('unavailable', {
        event: null,
        lines: [],
        refreshFailed: true,
        refreshIssue: 'ForecastEx IBKR refresh timed out',
      }),
    });
    const catalog = {
      ...initial.venues.forecastex.catalog,
      source: 'forecastex_official_schedule',
      scheduleOnly: true,
      lines: initial.venues.forecastex.catalog.lines.map((line) => ({
        ...line,
        source: 'forecastex_official_schedule',
        directNative: false,
        yesBid: null,
        yesAsk: null,
        noBid: null,
        noAsk: null,
        yesBidSize: null,
        yesAskSize: null,
        noBidSize: null,
        noAskSize: null,
      })),
    };
    const failedBook = {
      ...timedOut.contracts,
      event: catalog.event,
      reason: 'ForecastEx IBKR refresh timed out',
    };
    timedOut.venues.forecastex = {
      ...initial.venues.forecastex,
      status: 'partial',
      catalog,
      book: failedBook,
      contracts: failedBook,
    };
    timedOut.displaySelection = {
      ...timedOut.displaySelection,
      status: 'available',
      mode: 'catalog',
      contracts: catalog,
    };
    timedOut.displayContracts = catalog;
    timedOut.resolverReference = {
      ...timedOut.resolverReference,
      spot: factor('unavailable', {
        availability: 'unavailable', fit: 'exact', value: null, source: null,
        refreshFailed: true, refreshIssue: 'IBKR quote refresh timed out', executable: false,
      }),
      lastVerifiedSpot: null,
    };
    predictionMarketTestService.getMonitor
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(timedOut);
    renderPanel();
    expect(await screen.findByRole('row', { name: /EXACT · ESU26 · LIVE 7,746.25/ })).toBeInTheDocument();

    await act(async () => {
      await pollSnapshot();
    });

    expect(screen.getByRole('row', { name: /EXACT · ESU26 · DELAYED 7,746.25/ })).toBeInTheDocument();
    expect(screen.getByTestId('spx-live-marker-line')).toBeInTheDocument();
    expect(screen.getByText('7,725')).toBeInTheDocument();
    expect(screen.getAllByText('NO QUOTE')).toHaveLength(8);
    expect(screen.queryByRole('cell', { name: 'Yes bid: 85¢, displayed size 20 contracts' })).not.toBeInTheDocument();
    expect(screen.queryByRole('cell', { name: 'Yes ask: 87¢, displayed size 30 contracts' })).not.toBeInTheDocument();
    expect(screen.getByTestId('spx-chart-canvas')).toBeInTheDocument();
    expect(screen.queryByText('SPX 1D DATA UNAVAILABLE')).not.toBeInTheDocument();
    expect(screen.getAllByText(/REFRESH DELAYED/).length).toBeGreaterThan(0);
  });

  test('clears FES quotes but keeps the prior marker labeled delayed on disconnect', async () => {
    const initial = monitorSnapshot();
    const catalog = {
      ...initial.contracts,
      source: 'forecastex_official_schedule',
      scheduleOnly: true,
      lines: initial.contracts.lines.map((line) => ({
        ...line,
        source: 'forecastex_official_schedule', directNative: false,
        yesBid: null, yesAsk: null, noBid: null, noAsk: null,
        yesBidSize: null, yesAskSize: null, noBidSize: null, noAskSize: null,
      })),
    };
    const disconnectedBook = factor('unavailable', {
      source: null,
      event: initial.contracts.event,
      lines: [],
      reason: 'IBKR disconnected',
      refreshFailed: true,
      refreshIssue: 'IBKR disconnected',
    });
    const disconnected = monitorSnapshot({
      status: 'partial',
      spot: factor('unavailable', { value: null, label: 'LIVE SPX', reason: 'IBKR disconnected' }),
      contracts: disconnectedBook,
      displayContracts: catalog,
    });
    disconnected.venues.forecastex = {
      ...disconnected.venues.forecastex,
      status: 'partial',
      catalog,
      book: disconnectedBook,
      contracts: disconnectedBook,
    };
    disconnected.displaySelection = {
      ...disconnected.displaySelection,
      mode: 'catalog',
      contracts: catalog,
    };
    disconnected.resolverReference = {
      ...disconnected.resolverReference,
      spot: factor('unavailable', {
        availability: 'unavailable', fit: 'exact', value: null,
        source: null, asOf: null, expiresAt: null, executable: false,
        reason: 'IBKR disconnected',
      }),
      lastVerifiedSpot: {
        status: 'last_verified', availability: 'last_verified', fit: 'exact',
        value: 7746.25, source: 'ibkr_live_native_quote',
        asOf: new Date(NOW - 5_000).toISOString(),
        generationKey: 'FES_081726', retainedUntil: '2026-08-17T20:00:00.000Z',
        displayOnly: true, executable: false, stale: true,
      },
    };
    predictionMarketTestService.getMonitor
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(disconnected);
    renderPanel();
    expect(await screen.findByRole('row', { name: /EXACT · ESU26 · LIVE 7,746.25/ })).toBeInTheDocument();

    await act(async () => {
      await pollSnapshot();
    });

    expect(screen.getByRole('row', { name: /EXACT · ESU26 · DELAYED 7,746.25/ })).toBeInTheDocument();
    expect(screen.getByTestId('spx-live-marker-line')).toBeInTheDocument();
    expect(screen.getByText('7,725')).toBeInTheDocument();
    expect(screen.getAllByText('NO QUOTE')).toHaveLength(8);
  });

  test('polls every 30 seconds only while the persistent surface is active', async () => {
    const stop = jest.fn();
    startVisibilityAwarePolling.mockImplementation(({ poll, pollOnStart }) => {
      if (pollOnStart) void poll();
      return stop;
    });
    const view = renderPanel(true);
    await screen.findByText('7,725');
    expect(startVisibilityAwarePolling).toHaveBeenCalledWith(expect.objectContaining({
      intervalMs: 5_000,
    }));
    expect(startVisibilityAwarePolling.mock.calls[0][0].pollOnStart).not.toBe(true);

    view.rerender(
      <PersistentSurface active={false}>
        <PredictionMarketResolverTest />
      </PersistentSurface>,
    );
    expect(stop).toHaveBeenCalled();
  });

  test('aborts an in-flight same-market refresh, clears cross-market content, and loads the selected market', async () => {
    let refreshSignal = null;
    predictionMarketTestService.getMonitor
      .mockResolvedValueOnce(monitorSnapshot())
      .mockImplementationOnce((_marketId, { signal }) => {
        refreshSignal = signal;
        return new Promise(() => {});
      })
      .mockResolvedValueOnce(genericMonitorSnapshot('wti', { spotValue: 76.25 }));
    const view = renderPanel(true, { marketId: 'sp500' });
    expect(await screen.findByText('7,725')).toBeInTheDocument();
    await act(async () => { await Promise.resolve(); });
    const sp500Poll = pollSnapshot;
    await act(async () => {
      void sp500Poll();
      await Promise.resolve();
    });

    view.rerender(
      <PersistentSurface active>
        <PredictionMarketResolverTest marketId="wti" />
      </PersistentSurface>,
    );

    expect(screen.queryByText('7,725')).not.toBeInTheDocument();
    await waitFor(() => expect(refreshSignal?.aborted).toBe(true));
    expect(await screen.findByRole('region', { name: 'Live WTI Oil prediction-market monitor' })).toBeInTheDocument();
    const wtiLine = await screen.findByText('75.00');
    expect(wtiLine).toHaveAttribute('title', 'Settles above 75.00');
    expect(screen.queryByText('> 75.00')).not.toBeInTheDocument();
    expect(predictionMarketTestService.getMonitor).toHaveBeenLastCalledWith(
      'wti',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  test('requests auto and shows an auto-selected schedule-only ForecastEx ladder without controls', async () => {
    const snapshot = genericMonitorSnapshot('silver');
    const catalog = snapshot.venues.forecastex.catalog;
    snapshot.autoSelection = {
      status: 'unavailable', mode: 'none', venueId: null, label: 'No executable venue',
      reason: 'No venue has a verified executable live book.',
      contracts: { status: 'unavailable', event: null, lines: [] },
    };
    snapshot.displaySelection = {
      status: 'available', mode: 'catalog', venueId: 'forecastex', label: 'ForecastEx catalog',
      reason: 'Showing current ForecastEx geometry.', contracts: catalog,
    };
    snapshot.displayContracts = catalog;
    snapshot.contracts = catalog;
    snapshot.selectedVenueId = 'forecastex';
    predictionMarketTestService.getMonitor.mockResolvedValue(snapshot);
    renderPanel(true, { marketId: 'silver' });

    await screen.findByRole('region', { name: 'Live Silver prediction-market monitor' });
    const silverLine = await screen.findByText('70.00');
    expect(silverLine).toHaveAttribute('title', 'Settles above 70.00');
    expect(screen.queryByText('> 70.00')).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'ForecastEx' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Silver contract generation')).not.toBeInTheDocument();
    expect(screen.getAllByText('NO QUOTE')).toHaveLength(4);
    expect(screen.getByRole('region', {
      name: 'Silver factor monitor · FORECASTEX · FX-SILVER · CURRENT',
    })).toHaveAttribute('data-selected-venue', 'forecastex');
    expect(predictionMarketTestService.getMonitor).toHaveBeenCalledWith('silver', expect.objectContaining({
      venue: 'auto', generationId: null,
    }));
  });

  test('renders the auto-selected fresh ForecastEx partial book without exposing a venue selector', async () => {
    const snapshot = genericMonitorSnapshot('silver');
    const catalogLine = snapshot.venues.forecastex.catalog.lines[0];
    const liveLine = {
      ...catalogLine,
      status: 'incomplete',
      source: 'ibkr_tws_forecastex_live',
      directNative: true,
      updatedAt: '2026-08-17T14:59:00.000Z',
      yesBid: 0.42,
      yesAsk: 0.44,
    };
    const liveBook = {
      status: 'partial',
      source: 'ibkr_tws_forecastex_live',
      asOf: '2026-08-17T14:59:00.000Z',
      expiresAt: FUTURE,
      event: snapshot.venues.forecastex.catalog.event,
      lines: [liveLine],
      reason: 'Fresh native ForecastEx quotes are incomplete for execution.',
      scheduleOnly: false,
    };
    snapshot.venues.forecastex = {
      ...snapshot.venues.forecastex,
      status: 'partial',
      book: liveBook,
      contracts: liveBook,
    };
    snapshot.autoSelection = {
      status: 'unavailable', mode: 'none', venueId: null, label: 'No executable venue',
      reason: 'Fresh native quotes are incomplete for execution.',
      contracts: { status: 'unavailable', event: null, lines: [] },
    };
    snapshot.displaySelection = {
      status: 'available', mode: 'live_quotes', venueId: 'forecastex', label: 'ForecastEx live quotes',
      reason: liveBook.reason, contracts: liveBook,
    };
    snapshot.displayContracts = liveBook;
    snapshot.contracts = liveBook;
    snapshot.selectedVenueId = 'forecastex';
    predictionMarketTestService.getMonitor.mockResolvedValue(snapshot);
    renderPanel(true, { marketId: 'silver' });

    await screen.findByRole('region', { name: 'Live Silver prediction-market monitor' });
    const yesBid = await screen.findByRole('cell', { name: 'Yes bid: 42¢, displayed size 20 contracts' });
    expect(screen.queryByRole('tab', { name: 'ForecastEx' })).not.toBeInTheDocument();
    expect(yesBid).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'Yes ask: 44¢, displayed size 20 contracts' })).toBeInTheDocument();
    expect(screen.getByRole('region', {
      name: 'Silver factor monitor · FORECASTEX · FX-SILVER · CURRENT',
    })).toHaveAttribute('data-event-ticker', 'FX-silver');
  });

  test('renders the fixed CPI comparison, source sheet, and source-dated forecast marker without an IBKR position overlay', async () => {
    predictionMarketTestService.getMonitor.mockResolvedValue(cpiMonitorSnapshot());
    renderPanel(true, { marketId: 'cpi' });

    const shell = await screen.findByRole('region', {
      name: 'Live Headline CPI YoY prediction-market monitor',
    });
    const comparison = within(shell).getByTestId('cpi-forecast-comparison');
    expect(comparison).toBeInTheDocument();
    expect(within(comparison).getByText('AUGUST 2026')).toBeInTheDocument();
    expect(within(comparison).getByText('KXCPIYOY-26AUG')).toBeInTheDocument();
    expect(within(comparison).getByText('D 2.4% · B 2.6% · U 2.8%')).toBeInTheDocument();
    expect(within(comparison).getByText('2.5%')).toBeInTheDocument();
    expect(within(comparison).getByText('2.7%')).toBeInTheDocument();
    expect(within(comparison).getByText('BLS RELEASE')).toBeInTheDocument();
    expect(within(comparison).getByText('BLS VERIFIED')).toBeInTheDocument();
    expect(within(comparison).queryByText('CONTRACT CLOSE')).not.toBeInTheDocument();
    const contractClock = within(comparison).getByLabelText('Selected contract trading hours');
    expect(contractClock).toHaveClass('pm-spx-chart-contract-clock', 'is-open');
    expect(within(contractClock).getByText('OPEN')).toHaveClass('pm-spx-contract-clock-status');
    expect(within(contractClock).getByText(/CLOSES IN/)).toHaveClass('pm-spx-contract-clock-timing');
    expect(within(comparison).queryByText(/SETTLES ON · BUREAU OF LABOR STATISTICS/i))
      .not.toBeInTheDocument();
    expect(within(comparison).getByTestId('cpi-forecast-chart-plot')).toBeInTheDocument();
    expect(await within(comparison).findByTestId('cpi-cleveland-endpoint-label'))
      .toHaveTextContent('CLEVELAND FED 2.5%');
    expect(within(comparison).getByTestId('cpi-cleveland-endpoint-label'))
      .toHaveAttribute('font-weight', '400');
    const hedgeyeReferences = await Promise.all(['downside', 'base', 'upside'].map((scenario) => (
      within(comparison).findByTestId(`cpi-hedgeye-${scenario}-reference`)
    )));
    hedgeyeReferences.forEach((referenceLine) => {
      expect(referenceLine)
        .toHaveAttribute('stroke-dasharray', '5 4');
    });

    const sourceMonitor = within(shell).getByTestId('cpi-source-monitor');
    const sourceTable = within(sourceMonitor).getByRole('table');
    expect(within(sourceTable).getAllByRole('columnheader').map((header) => header.textContent)).toEqual([
      'SOURCE', 'VALUE', 'ROLE', 'PERIOD', 'AS OF',
    ]);
    expect(within(sourceTable).getAllByRole('row', { name: /HEDGEYE/ })).toHaveLength(3);
    expect(within(sourceTable).getByRole('row', { name: /CLEVELAND FED 2.5% NOWCAST AUGUST 2026/ }))
      .toBeInTheDocument();
    expect(within(sourceTable).getByRole('row', { name: /BLS 2.7% LATEST ACTUAL JULY 2026/ }))
      .toBeInTheDocument();

    const ladder = within(shell).getByRole('region', {
      name: 'Headline CPI YoY prediction-market contract ladder',
    });
    expect(within(ladder).getByRole('columnheader', { name: 'Δ HYE BASE' })).toBeInTheDocument();
    const hedgeyeReferenceRow = within(ladder).getByRole('row', { name: 'HEDGEYE BASE 8/15/26 2.6%' });
    expect(hedgeyeReferenceRow).toBeInTheDocument();
    expect(within(ladder).getByText('HEDGEYE BASE · 8/15/26')).toBeInTheDocument();
    expect(within(hedgeyeReferenceRow).queryByRole('button')).not.toBeInTheDocument();
    expect(within(ladder).queryByText(/DATED FORECAST/i)).not.toBeInTheDocument();
    expect(within(ladder).getByText('2.4')).toHaveAttribute('title', 'Settles above 2.4');
    expect(within(ladder).queryByLabelText(/Live IBKR position:/)).not.toBeInTheDocument();
    expect(screen.queryByRole('complementary', {
      name: 'Headline CPI YoY resolver diagnostics and position sizing',
    })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Headline CPI YoY contract venue')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Headline CPI YoY contract generation')).not.toBeInTheDocument();
    expect(MarketDataService.getPortfolioPredictionMarketPositions).not.toHaveBeenCalled();
    expect(predictionMarketTestService.getMonitor).toHaveBeenCalledWith('cpi', expect.objectContaining({
      venue: 'kalshi', generationId: null,
    }));
  });

  test.each([
    ['wti', 'WTI Oil'],
    ['gold', 'Gold'],
    ['silver', 'Silver'],
    ['brent', 'Brent Oil'],
    ['bitcoin', 'Bitcoin'],
  ])('uses the simplified S&P structure and removes diagnostics for %s', async (marketId, label) => {
    predictionMarketTestService.getMonitor.mockResolvedValue(genericMonitorSnapshot(marketId));
    renderPanel(true, { marketId });
    const shell = await screen.findByRole('region', { name: `Live ${label} prediction-market monitor` });
    const chart = within(shell).getByRole('region', { name: `${genericMonitorSnapshot(marketId).symbol} Risk Range chart` });
    const ladder = within(shell).getByRole('region', { name: `${label} prediction-market contract ladder` });
    const factors = within(shell).getByRole('region', { name: new RegExp(`^${label} factor monitor`) });
    expect(chart.closest('.pm-spx-monitor-top')).toHaveClass('pm-spx-monitor-top--chart-only');
    expect(ladder.closest('.pm-spx-monitor-bottom')).toContainElement(factors);
    expect(screen.queryByRole('complementary', { name: `${label} resolver diagnostics and position sizing` })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(`${label} contract generation`)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(`${label} contract venue`)).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Prediction monitor data status')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Selected prediction contract generation summary')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: `Close ${marketId === 'wti' ? 'WTI' : label} monitor` })).not.toBeInTheDocument();
  });

  test('keeps the legacy Nasdaq diagnostics because Nasdaq was not part of the remake', async () => {
    predictionMarketTestService.getMonitor.mockResolvedValue(genericMonitorSnapshot('nasdaq100'));
    renderPanel(true, { marketId: 'nasdaq100' });
    const strategy = await screen.findByRole('complementary', { name: 'Nasdaq-100 resolver diagnostics and position sizing' });
    expect(within(strategy).getByText(/NO VALIDATED MODEL \/ SIZING DISABLED/)).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Auto' })).toBeInTheDocument();
  });

  test.each([
    ['silver', 'Silver', [
      'SILVER/DXY 30D CORRELATION',
      'CFTC SILVER MANAGED MONEY · 1Y / 3Y Z',
      '21D ANNUALIZED SILVER REALIZED VOLATILITY',
      'TRADE / TREND GATE',
      'CONTRACT / RR GEOMETRY',
    ]],
    ['gold', 'Gold', [
      'XAUUSD/DXY 30D RETURN CORRELATION',
      'CFTC GOLD MANAGED MONEY · 1Y / 3Y Z',
      'GVZ',
      'TRADE / TREND GATE',
      'CONTRACT / RR GEOMETRY',
    ]],
    ['wti', 'WTI Oil', [
      'WTI/DXY 30D CORRELATION',
      'CFTC CRUDE-OIL MANAGED MONEY · 1Y / 3Y Z',
      'OVX',
      'TRADE / TREND GATE',
      'CONTRACT / RR GEOMETRY',
    ]],
    ['brent', 'Brent Oil', [
      'BRENT/DXY 30D CORRELATION',
      'BRENT–WTI FRONT-MONTH SPREAD',
      'OVX · WTI PROXY',
      'TRADE / TREND GATE',
      'CONTRACT / RR GEOMETRY',
    ]],
    ['bitcoin', 'Bitcoin', [
      'BTC/DXY 30D CORRELATION',
      'CFTC CME BITCOIN · 1Y / 3Y Z',
      'BITVX',
      'TRADE / TREND GATE',
      'CONTRACT / RR GEOMETRY',
    ]],
  ])('renders the exact five-row %s factor monitor as context, not a score', async (marketId, label, expectedLabels) => {
    if (marketId === 'gold') {
      MarketDataService.getGoldCorrelations.mockResolvedValue(goldCorrelationFixture());
    }
    predictionMarketTestService.getMonitor.mockResolvedValue(genericMonitorSnapshot(marketId));
    renderPanel(true, { marketId });
    const factorRegion = await screen.findByRole('region', { name: new RegExp(`^${label} factor monitor`) });
    await within(factorRegion).findByText(expectedLabels[0]);
    const table = within(factorRegion).getByRole('table');
    expect(within(factorRegion).queryByText('FACTOR MONITOR')).not.toBeInTheDocument();
    expect(within(table).getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual([
      'FACTOR', 'VALUE', 'MAX PTS', 'POINTS', 'AS OF',
    ]);
    expect(within(table).getAllByRole('rowheader').map((cell) => cell.textContent)).toEqual(expectedLabels);
    expectedLabels.filter((rowLabel) => rowLabel !== 'TRADE / TREND GATE').forEach((rowLabel) => {
      const row = within(table).getByText(rowLabel).closest('tr');
      expect(row).toHaveTextContent(/CTX/);
      expect(row).toHaveTextContent(/—/);
    });
    const gate = within(table).getByText('TRADE / TREND GATE').closest('tr');
    expect(gate).toHaveTextContent('GATE');
    expect(gate).toHaveTextContent('CONTEXT ALIGNED');
    expect(within(table).queryByText(/PASS|BLOCKED|SCORE|TOP PICK|TRADE SIGNAL/)).not.toBeInTheDocument();
  });

  test.each([
    ['silver', 'Silver'],
    ['gold', 'Gold'],
    ['wti', 'WTI Oil'],
    ['brent', 'Brent Oil'],
    ['bitcoin', 'Bitcoin'],
  ])('color codes correlation and directional gate semantics on the %s card', async (marketId, label) => {
    if (marketId === 'gold') {
      MarketDataService.getGoldCorrelations.mockResolvedValue(goldCorrelationFixture());
    }
    const snapshot = genericMonitorSnapshot(marketId);
    const gate = snapshot.factorRows.find((row) => row.id === 'gate');
    gate.displayValue = 'BULLISH / BEARISH';
    gate.displayState = 'CONFLICT';
    predictionMarketTestService.getMonitor.mockResolvedValue(snapshot);
    renderPanel(true, { marketId });

    const factorRegion = await screen.findByRole('region', { name: new RegExp(`^${label} factor monitor`) });
    const correlationValue = marketId === 'gold' ? '-0.84' : '-0.82';
    const correlationCell = await within(factorRegion).findByRole('cell', { name: correlationValue });
    expect(correlationCell)
      .toHaveClass('pm-spx-factor-value', 'is-negative');
    const gateRow = await within(factorRegion).findByRole('row', { name: /TRADE \/ TREND GATE/ });
    expect(within(gateRow).getByText('BULLISH')).toHaveClass('pm-spx-factor-token', 'is-positive');
    expect(within(gateRow).getByText('BEARISH')).toHaveClass('pm-spx-factor-token', 'is-negative');
    expect(within(gateRow).getByRole('cell', { name: 'CONFLICT' }))
      .toHaveClass('pm-spx-factor-points', 'is-negative');
  });

  test.each([
    ['silver', 'Silver'],
    ['gold', 'Gold'],
    ['wti', 'WTI Oil'],
    ['bitcoin', 'Bitcoin'],
  ])('color codes each CFTC z-score token by sign on the %s card', async (marketId, label) => {
    const snapshot = genericMonitorSnapshot(marketId);
    const cftc = snapshot.factorRows.find((row) => row.id === 'cftc');
    cftc.displayValue = '+1.20 / -0.80';
    predictionMarketTestService.getMonitor.mockResolvedValue(snapshot);
    renderPanel(true, { marketId });

    const factorRegion = await screen.findByRole('region', { name: new RegExp(`^${label} factor monitor`) });
    const cftcRow = await within(factorRegion).findByRole('row', { name: /CFTC/ });
    expect(within(cftcRow).getByText('+1.20')).toHaveClass('pm-spx-factor-token', 'is-positive');
    expect(within(cftcRow).getByText('-0.80')).toHaveClass('pm-spx-factor-token', 'is-negative');
  });

  test.each([
    ['gold', 'Gold', /GVZ/, 22.5, '22.50', 'is-positive'],
    ['wti', 'WTI Oil', /^OVX /, 60, '60.00', 'is-negative'],
    ['brent', 'Brent Oil', /OVX · WTI PROXY/, 45, '45.00', 'is-caution'],
  ])('uses the configured volatility regime color on the %s card', async (
    marketId, label, rowName, value, displayValue, expectedClass,
  ) => {
    const snapshot = genericMonitorSnapshot(marketId);
    const volatility = snapshot.factorRows.find((row) => ['GVZ', 'OVX'].includes(row.id));
    volatility.value = value;
    volatility.displayValue = displayValue;
    predictionMarketTestService.getMonitor.mockResolvedValue(snapshot);
    renderPanel(true, { marketId });

    const factorRegion = await screen.findByRole('region', { name: new RegExp(`^${label} factor monitor`) });
    const volatilityRow = await within(factorRegion).findByRole('row', { name: rowName });
    expect(within(volatilityRow).getByRole('cell', { name: displayValue }))
      .toHaveClass('pm-spx-factor-value', expectedClass);
  });

  test.each([
    ['silver', 'Silver', /21D ANNUALIZED SILVER REALIZED VOLATILITY/],
    ['bitcoin', 'Bitcoin', /BITVX/],
    ['brent', 'Brent Oil', /BRENT–WTI FRONT-MONTH SPREAD/],
  ])('keeps %s context neutral when no validated directional threshold exists', async (marketId, label, rowName) => {
    const snapshot = genericMonitorSnapshot(marketId);
    predictionMarketTestService.getMonitor.mockResolvedValue(snapshot);
    renderPanel(true, { marketId });

    const factorRegion = await screen.findByRole('region', { name: new RegExp(`^${label} factor monitor`) });
    const contextRow = await within(factorRegion).findByRole('row', { name: rowName });
    const valueCell = within(contextRow).getAllByRole('cell')[0];
    expect(valueCell).not.toHaveClass('is-positive');
    expect(valueCell).not.toHaveClass('is-negative');
    expect(valueCell).not.toHaveClass('is-caution');
  });

  test.each([
    ['wti', 'WTI', 84.3],
    ['gold', 'GOLD', 4200.1],
    ['silver', 'SILVER', 74.2],
    ['brent', 'BRENT', 86.4],
    ['bitcoin', 'BTC', 118500],
  ])('offers 1D, 5D, and 10D on the %s card and defaults to 1D', async (marketId, symbol, spotValue) => {
    predictionMarketTestService.getMonitor.mockResolvedValue(genericMonitorSnapshot(marketId, { spotValue }));
    renderPanel(true, { marketId });
    const chartRegion = await screen.findByRole('region', { name: `${symbol} Risk Range chart` });

    expect(within(chartRegion).getByRole('tab', { name: '1D' })).toHaveAttribute('aria-selected', 'true');
    await waitFor(() => expect(within(chartRegion).getByTestId('spx-1d-rr-structure-summary')).toHaveTextContent('H+9·L+9'));
    fireEvent.click(within(chartRegion).getByRole('tab', { name: '5D' }));
    expect(within(chartRegion).getByTestId('spx-chart-canvas')).toHaveAttribute('data-chart-range', '5d');
    expect(within(chartRegion).getByTestId('spx-5d-rr-structure-summary')).toHaveTextContent('H+4·L+4');
    fireEvent.click(within(chartRegion).getByRole('tab', { name: '10D' }));
    expect(within(chartRegion).getByTestId('spx-chart-canvas')).toHaveAttribute('data-chart-range', '10d');
    expect(within(chartRegion).getByTestId('spx-chart-canvas')).toHaveAttribute('data-session-count', '10');
    expect(within(chartRegion).getByTestId('spx-10d-rr-structure-summary')).toHaveTextContent('H+9·L+9');
    const expectedClosedDates = marketId === 'bitcoin'
      ? []
      : ['8/8', '8/9', '8/15', '8/16'];
    expect(within(chartRegion).queryAllByTestId(/^spx-10d-closed-date-/).map((node) => node.textContent))
      .toEqual(expectedClosedDates);
    expect(within(chartRegion).queryAllByText('MARKET CLOSED WEEKEND'))
      .toHaveLength(expectedClosedDates.length);
    expect(within(chartRegion).queryByText('24/7 · WEEKENDS OPEN')).not.toBeInTheDocument();
    expect(within(chartRegion).queryAllByTestId(/^spx-10d-weekend-open-/)).toHaveLength(0);
    expect(within(chartRegion).queryAllByLabelText(/weekend, 24\/7 open session/i)).toHaveLength(0);
    if (marketId === 'bitcoin') {
      expect(within(chartRegion).queryAllByTestId(/^spx-10d-market-closed-/)).toHaveLength(0);
      expect(within(chartRegion).getByTestId('spx-10d-session-2026-08-08')).toBeInTheDocument();
      expect(within(chartRegion).getByTestId('spx-10d-session-2026-08-09')).toBeInTheDocument();
    }
    expect(within(chartRegion).queryByText('PROXY', { selector: '.pm-spx-reference-badge' }))
      .not.toBeInTheDocument();
  });

  test('labels a before-open WTI 1D fallback without delaying local tab changes', async () => {
    const snapshot = genericMonitorSnapshot('wti', { spotValue: 84.3 });
    const fallback = {
      ...snapshot.chart.variants['1d'],
      status: 'historical',
      availability: 'historical',
      sessionMode: 'last_complete',
      sessionDate: '2026-08-17',
      rangeDates: ['2026-08-17'],
      historicalThroughDate: '2026-08-17',
    };
    snapshot.chart = {
      ...fallback,
      variants: { ...snapshot.chart.variants, '1d': fallback },
    };
    predictionMarketTestService.getMonitor.mockResolvedValue(snapshot);
    renderPanel(true, { marketId: 'wti' });

    const chartRegion = await screen.findByRole('region', { name: 'WTI Risk Range chart' });
    expect(within(chartRegion).getByText('LAST COMPLETE SESSION')).toHaveAttribute(
      'title',
      'Verified resolver session 2026-08-17',
    );
    expect(within(chartRegion).getByTestId('spx-chart-canvas')).toHaveAttribute(
      'data-session-mode',
      'last_complete',
    );

    fireEvent.click(within(chartRegion).getByRole('tab', { name: '5D' }));
    expect(within(chartRegion).getByTestId('spx-chart-canvas')).toHaveAttribute('data-chart-range', '5d');
    expect(within(chartRegion).queryByText('LAST COMPLETE SESSION')).not.toBeInTheDocument();
  });

  test.each([
    ['wti', 'WTI', 'CLV26'],
    ['silver', 'SILVER', 'SIZ26'],
    ['brent', 'BRENT', 'BZX26'],
    ['bitcoin', 'BTC', 'COINBASE BTC-USD'],
    ['nasdaq100', 'NDX', 'NDX'],
  ])('keeps the proxy-fit panel on the 1D %s card', async (marketId, symbol, proxyLabel) => {
    const snapshot = genericMonitorSnapshot(marketId, { spotValue: marketId === 'bitcoin' ? 118500 : 100 });
    snapshot.proxyFit = {
      status: 'partial',
      proxyLabel,
      underlyingLabel: symbol,
      currentBasisPct: 0.35,
      alignedThroughDate: '2026-08-17',
      rows: [{ window: 5, status: 'available', averageBasisPct: 0.28, deviationZ: 0.7, returnCorrelation: 0.94 }],
      ...(marketId === 'brent' ? {
        exactResolverSymbol: 'Commodities.Index.BRENT/USD',
        exactResolverUrl: 'https://pyth.dourolabs.app/v1/symbols?query=BRENT',
        exactResolverEntitlement: 'authenticated_history_unavailable',
      } : {}),
    };
    predictionMarketTestService.getMonitor.mockResolvedValue(snapshot);
    renderPanel(true, { marketId });

    const chartRegion = await screen.findByRole('region', { name: `${symbol} Risk Range chart` });
    const panel = await within(chartRegion).findByTestId(`${symbol.toLowerCase()}-proxy-fit`);
    await within(panel).findByText('PARTIAL');
    expect(panel).toHaveTextContent(proxyLabel);
    expect(panel).toHaveTextContent('PARTIAL');
    expect(panel).toHaveTextContent('+0.35%');
    expect(within(panel).getByText('5D')).toBeInTheDocument();
    expect(within(panel).getByText('120D')).toBeInTheDocument();
    if (marketId === 'brent') {
      expect(panel).toHaveTextContent('PYTH INDEX NOT INCLUDED · LIVE HISTORY ENTITLEMENT REQUIRED');
      expect(within(panel).getByRole('link', { name: 'OPEN EXACT PYTH BRENT INDEX' }))
        .toHaveAttribute('href', 'https://pyth.dourolabs.app/v1/symbols?query=BRENT');
    }
  });

  test('replaces Gold proxy fit with finalized Kalshi Pyth tracking', async () => {
    const snapshot = genericMonitorSnapshot('gold', { spotValue: 4_448.3 });
    snapshot.resolverTracking = {
      status: 'available',
      source: 'kalshi_finalized_expiration_value',
      resolverSymbol: 'Metal.Index.GOLD/USD',
      proxySymbol: 'XAUUSD',
      sampleSize: 17,
      meanSignedErrorUsd: -0.85,
      meanAbsoluteErrorUsd: 1.5,
      medianAbsoluteErrorUsd: 0.67,
      p90AbsoluteErrorUsd: 5.01,
      maxAbsoluteErrorUsd: 6.97,
      guardBandUsd: 10,
      latestFinal: {
        eventTicker: 'KXGOLDD-26AUG3117',
        value: 4_448.11,
        observationAt: '2026-08-31T21:00:00.000Z',
        finalizedAt: '2026-08-31T22:01:21.000Z',
      },
      currentEventFinal: null,
      exactUrl: 'https://app.pyth.com/explore/Metal.Index.GOLD%2FUSD',
      entitlement: 'api_entitlement_required',
      methodology: 'Verified comparison.',
      reason: null,
    };
    predictionMarketTestService.getMonitor.mockResolvedValue(snapshot);
    renderPanel(true, { marketId: 'gold' });

    const chartRegion = await screen.findByRole('region', { name: 'GOLD Risk Range chart' });
    const panel = await within(chartRegion).findByTestId('gold-pyth-tracking');
    expect(panel).toHaveTextContent('PYTH TRACKING');
    expect(panel).toHaveTextContent('XAUUSD→PYTH GOLD/USD');
    expect(panel).toHaveTextContent('PYTH 1-MIN CANDLE CLOSE · 4:59–5:00 PM ET');
    expect(panel).toHaveTextContent('±$10.00');
    expect(panel).toHaveTextContent('-$0.85');
    expect(panel).toHaveTextContent('$4,448.11'.replace(',', ''));
    expect(panel).not.toHaveTextContent('EXACT RESOLVER');
    expect(panel).not.toHaveTextContent('RESOLVER UNCERTAINTY BAND');
    expect(within(panel).queryByRole('link', { name: 'OPEN EXACT PYTH' })).not.toBeInTheDocument();
    expect(panel).not.toHaveTextContent('LIVE EXACT UNAVAILABLE');
    expect(within(chartRegion).queryByTestId('gold-proxy-fit')).not.toBeInTheDocument();
  });

  test('marks the exact verified 5 PM Pyth observation time on the current Gold chart', async () => {
    const snapshot = genericMonitorSnapshot('gold', { spotValue: 4_448.3 });
    snapshot.venues.kalshi.settlementBasis = {
      ...snapshot.venues.kalshi.settlementBasis,
      instrumentScope: 'exact',
      observationAt: '2026-08-17T21:00:00.000Z',
    };
    snapshot.chart.variants['1d'] = {
      ...snapshot.chart.variants['1d'],
      sessionWindow: {
        sessionDate: '2026-08-17',
        timeZone: 'America/New_York',
        startAt: '2026-08-17T13:00:00.000Z',
        endAt: '2026-08-17T21:00:00.000Z',
        observationAt: '2026-08-17T21:00:00.000Z',
        source: 'published_resolver_observation',
        closedIntervals: [],
      },
    };
    snapshot.resolverTracking = {
      status: 'partial',
      source: 'kalshi_finalized_expiration_value',
      resolverSymbol: 'Metal.Index.GOLD/USD',
      settlements: [],
    };
    predictionMarketTestService.getMonitor.mockResolvedValue(snapshot);
    renderPanel(true, { marketId: 'gold' });

    const chartRegion = await screen.findByRole('region', { name: 'GOLD Risk Range chart' });
    expect(await within(chartRegion).findByTestId('spx-1d-settlement-time-line')).toHaveAttribute(
      'stroke-dasharray',
      '3 4',
    );
    const timeLabel = within(chartRegion).getByTestId('spx-1d-settlement-time');
    expect(timeLabel).toHaveTextContent('PYTH 5:00 PM ET');
    expect(timeLabel).toHaveAttribute('data-observation-at', '2026-08-17T21:00:00.000Z');
    expect(within(timeLabel).getByText('PYTH 5:00 PM ET')).toHaveAttribute('font-weight', '400');
  });

  test('annotates every available Gold final and keeps GC segmented across multi-day sessions', async () => {
    const snapshot = genericMonitorSnapshot('gold', { spotValue: 4_448.3 });
    const monthCodes = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
    const tenDayDates = snapshot.chart.variants['10d'].rangeDates;
    snapshot.resolverTracking = {
      status: 'available',
      source: 'kalshi_finalized_expiration_value',
      resolverSymbol: 'Metal.Index.GOLD/USD',
      settlements: tenDayDates.map((date, index) => {
        const [year, month, day] = date.split('-');
        return {
          status: 'available',
          availability: 'official_final',
          final: true,
          eventTicker: `KXGOLDD-${year.slice(-2)}${monthCodes[Number(month) - 1]}${day}17`,
          value: 4_420 + index,
          observationAt: `${date}T21:00:00.000Z`,
          finalizedAt: `${date}T22:01:00.000Z`,
          source: 'kalshi_finalized_expiration_value',
        };
      }),
    };
    const shiftedChart = (chart) => ({
      ...chart,
      points: (chart.points || []).map((point) => ({ ...point, value: Number(point.value) + 3 })),
      latestValue: Number(chart.latestValue) + 3,
    });
    const contractChart = shiftedChart(snapshot.chart);
    contractChart.variants = Object.fromEntries(Object.entries(snapshot.chart.variants).map(([range, chart]) => [
      range,
      shiftedChart(chart),
    ]));
    snapshot.chartReferences = {
      basis: {
        role: 'risk_range_basis', symbol: 'XAUUSD', exact: false,
        spot: snapshot.spot, chart: snapshot.chart, freshness: { status: 'verified_live' },
      },
      contract: {
        role: 'contract_reference', symbol: 'GCZ26', exact: false,
        spot: { ...snapshot.spot, value: snapshot.spot.value + 3 },
        chart: contractChart, freshness: { status: 'verified_live' },
      },
    };
    snapshot.resolverReference = { chartReferences: snapshot.chartReferences };
    predictionMarketTestService.getMonitor.mockResolvedValue(snapshot);
    renderPanel(true, { marketId: 'gold' });

    const chartRegion = await screen.findByRole('region', { name: 'GOLD Risk Range chart' });
    for (const range of ['5d', '10d']) {
      fireEvent.click(within(chartRegion).getByRole('tab', { name: range.toUpperCase() }));
      const expectedDates = snapshot.chart.variants[range].rangeDates;
      const labels = await within(chartRegion).findAllByTestId(new RegExp(`^spx-${range}-settlement-\\d`));
      expect(labels).toHaveLength(expectedDates.length);
      labels.forEach((label) => {
        expect(label).toHaveAttribute('data-source', 'kalshi_finalized_expiration_value');
        expect(within(label).getByText(/(?:5:00 PM|5P) · 4,/)).toHaveAttribute('font-weight', '400');
      });
      expect(within(chartRegion).getByTestId('spx-chart-canvas')).toHaveAttribute(
        'data-gold-settlement-count',
        String(expectedDates.length),
      );
      const contractPath = within(chartRegion).getByTestId(`spx-${range}-contract-line`).getAttribute('d') || '';
      expect((contractPath.match(/M/g) || [])).toHaveLength(expectedDates.length);
      expect(within(chartRegion).getByTestId(`spx-${range}-latest-reference`)).toHaveAttribute('font-weight', '400');
      expect(within(chartRegion).getByTestId(`spx-${range}-contract-reference`)).toHaveAttribute('font-weight', '400');
    }
  });

  test('renders the verified XAUUSD ATH as a dotted blue line on every Gold chart range', async () => {
    const snapshot = genericMonitorSnapshot('gold', { spotValue: 4_448.3 });
    const ath = {
      status: 'available',
      source: 'ibkr_historical_record',
      asOf: '2026-08-17T15:00:00.000Z',
      value: 4_550.25,
      date: '2026-08-14',
      baseline: {
        value: 4_550.25,
        date: '2026-08-14',
        throughDate: '2026-08-16',
        source: 'ibkr',
        dataset: 'historical_record',
        coverageComplete: true,
      },
      markers: [],
      reason: null,
    };
    snapshot.chart = {
      ...snapshot.chart,
      ath,
      variants: Object.fromEntries(Object.entries(snapshot.chart.variants).map(([range, chart]) => [
        range,
        { ...chart, ath },
      ])),
    };
    predictionMarketTestService.getMonitor.mockResolvedValue(snapshot);
    renderPanel(true, { marketId: 'gold' });

    const chartRegion = await screen.findByRole('region', { name: 'GOLD Risk Range chart' });
    for (const range of ['1d', '5d', '10d']) {
      if (range !== '1d') fireEvent.click(within(chartRegion).getByRole('tab', { name: range.toUpperCase() }));
      const athLine = await within(chartRegion).findByTestId(`spx-${range}-ath-line`);
      expect(athLine).toHaveAttribute('stroke', '#2563eb');
      expect(athLine).toHaveAttribute('stroke-dasharray', '2 4');
      expect(await within(chartRegion).findByTestId(`spx-${range}-ath-reference`))
        .toHaveTextContent('ATH 4,550.3 (8/14/2026)');
    }
  });

  test('renders Gold 1D with two references, a trailing spacer, the compact matrix, and the shared canonical DXY factor', async () => {
    const correlationFixture = goldCorrelationFixture();
    correlationFixture.rows.find((row) => row.key === 'SPX').values = {
      '15D': 0.25,
      '30D': 0.5,
      '90D': 0.7,
      '120D': -0.25,
      '180D': -0.5,
    };
    MarketDataService.getGoldCorrelations.mockResolvedValue(correlationFixture);
    const snapshot = genericMonitorSnapshot('gold', { spotValue: 4_434.3 });
    snapshot.goldMarketReferences = [
      {
        key: 'selectedResolver', label: 'PYTH GOLD INDEX', symbol: 'GOLD/USD', role: 'direct',
        status: 'live', price: 4_434.3, previousClose: 4_400, changePercent: 0.7795,
        source: 'pyth_lazer_http', instrument: null,
        asOf: '2026-08-17T14:59:40.000Z', expiresAt: '2026-08-17T15:00:40.000Z', reason: null,
      },
      {
        key: 'xauusd', label: 'SPOT GOLD', symbol: 'XAUUSD', role: 'proxy',
        status: 'live', price: 4_433.8, previousClose: 4_401, changePercent: 0.7453,
        source: 'ibkr',
        instrument: { symbol: 'XAUUSD', displaySymbol: 'XAUUSD', conId: 69067924 },
        asOf: '2026-08-17T14:59:35.000Z', expiresAt: '2026-08-17T15:00:35.000Z', reason: null,
      },
      {
        key: 'activeComex', label: 'COMEX GOLD', symbol: 'GCZ26', role: 'proxy',
        status: 'historical', price: 4_450.2, previousClose: 4_420, changePercent: 0.6833,
        source: 'ibkr_historical_bars',
        instrument: { symbol: 'GC', displaySymbol: 'GCZ26', conId: 12345, contractMonth: '202612' },
        asOf: '2026-08-14T20:00:00.000Z', reason: null,
      },
    ];
    predictionMarketTestService.getMonitor.mockResolvedValue(snapshot);

    renderPanel(true, { marketId: 'gold' });

    const chartRegion = await screen.findByRole('region', { name: 'GOLD Risk Range chart' });
    const referenceStrip = await within(chartRegion).findByRole('group', { name: 'Gold market references' });
    await within(referenceStrip).findByText('IBKR · XAUUSD');
    const xauusdMeasure = within(referenceStrip).getByTestId('gold-header-measure-xauusd');
    const comexMeasure = within(referenceStrip).getByTestId('gold-header-measure-gcz26');
    const spacer = within(referenceStrip).getByTestId('gold-header-measure-spacer');
    expect(within(referenceStrip).queryByText('PYTH GOLD INDEX')).not.toBeInTheDocument();
    expect(within(referenceStrip).queryByText('GOLD/USD')).not.toBeInTheDocument();
    expect(within(referenceStrip).queryByText('DIRECT')).not.toBeInTheDocument();
    expect(within(referenceStrip).getAllByText('PROXY')).toHaveLength(2);
    expect(within(referenceStrip).getByText('IBKR · XAUUSD')).toBeVisible();
    expect(within(referenceStrip).getByText('IBKR HISTORY · GCZ26')).toBeVisible();
    expect(within(referenceStrip).getAllByText(/(?:LIVE|HISTORICAL) · AS OF/)).toHaveLength(2);
    expect(within(referenceStrip).getAllByTestId(/^gold-header-measure-/)).toEqual([
      xauusdMeasure,
      comexMeasure,
      spacer,
    ]);
    expect(spacer).toBeEmptyDOMElement();

    const matrix = await within(chartRegion).findByTestId('gold-correlation-panel');
    expect(within(matrix).getByText('XAUUSD PROXY BASIS · COMPLETED DAILY CHANGES')).toBeVisible();
    expect(within(matrix).getByRole('columnheader', { name: 'LAST' })).toBeVisible();
    expect(await within(matrix).findByText('DXY')).toBeVisible();
    expect(within(matrix).getByText('U.S. 10Y Real')).toBeVisible();
    expect(within(matrix).getByText('U.S. 10Y Nominal')).toBeVisible();
    expect(within(matrix).getByRole('cell', {
      name: 'DXY last completed observation: 98.42 as of 2026-08-14',
    })).toHaveTextContent('98.42');
    expect(within(matrix).getByRole('cell', {
      name: 'U.S. 10Y Real last completed observation: 1.82% as of 2026-08-14',
    })).toHaveTextContent('1.82%');
    expect(within(matrix).getByRole('cell', {
      name: 'S&P 500 last completed observation: 6,425.12 as of 2026-08-14',
    })).toHaveTextContent('6,425.12');
    expect(within(matrix).getByRole('cell', {
      name: 'WTI last completed observation: $64.01 as of 2026-08-14',
    })).toHaveTextContent('$64.01');
    const strongNegative = within(matrix).getByRole('cell', {
      name: 'DXY 30D: negative correlation 0.84',
    });
    expect(strongNegative).toHaveTextContent('0.84');
    expect(strongNegative).toHaveClass('is-negative-strong');
    expect(within(matrix).getByRole('cell', {
      name: 'S&P 500 15D: positive correlation 0.25',
    })).toHaveClass('is-positive');
    expect(within(matrix).getByRole('cell', {
      name: 'S&P 500 30D: positive correlation 0.50',
    })).toHaveClass('is-positive-light');
    expect(within(matrix).getByRole('cell', {
      name: 'S&P 500 90D: positive correlation 0.70',
    })).toHaveClass('is-positive-strong');
    expect(within(matrix).getByRole('cell', {
      name: 'S&P 500 120D: negative correlation 0.25',
    })).toHaveClass('is-negative');
    expect(within(matrix).getByRole('cell', {
      name: 'S&P 500 180D: negative correlation 0.50',
    })).toHaveClass('is-negative-light');
    within(matrix).getAllByRole('cell', { name: /correlation/ }).forEach((cell) => {
      expect(cell).not.toHaveTextContent(/^[+-]/);
    });
    expect(within(matrix).queryByText('PEARSON · RETURNS / YIELD CHANGES')).not.toBeInTheDocument();
    expect(within(matrix).queryByText('AS OF 2026-08-14')).not.toBeInTheDocument();
    expect(within(matrix).queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', {
      name: /^(?:LIVE|REFRESHING|LOADING|UNAVAILABLE|AS OF)(?: ·|$)/,
    })).not.toBeInTheDocument();
    expect(await screen.findByText('XAUUSD/DXY 30D RETURN CORRELATION')).toBeVisible();
    expect(MarketDataService.getGoldCorrelations).toHaveBeenCalledTimes(1);

    fireEvent.click(within(chartRegion).getByRole('tab', { name: '5D' }));
    expect(within(chartRegion).queryByTestId('gold-correlation-panel')).not.toBeInTheDocument();
    expect(within(chartRegion).getByTestId('spx-chart-canvas')).toHaveAttribute('data-chart-range', '5d');
    expect(within(chartRegion).getByRole('group', { name: 'Gold market references' })).toBeVisible();
    expect(MarketDataService.getGoldCorrelations).toHaveBeenCalledTimes(1);

    fireEvent.click(within(chartRegion).getByRole('tab', { name: '10D' }));
    expect(within(chartRegion).queryByTestId('gold-correlation-panel')).not.toBeInTheDocument();
    expect(within(chartRegion).getByTestId('spx-chart-canvas')).toHaveAttribute('data-chart-range', '10d');
  });

  test('withholds D for a sub-two-minute Gold reference without hiding its value', async () => {
    const snapshot = genericMonitorSnapshot('gold', { spotValue: 4_433.8 });
    snapshot.goldMarketReferences = [{
      key: 'xauusd', label: 'SPOT GOLD', symbol: 'XAUUSD', role: 'proxy',
      status: 'delayed', retainedStatus: 'live', price: 4_433.8, previousClose: 4_401,
      source: 'ibkr',
      instrument: { symbol: 'XAUUSD', displaySymbol: 'XAUUSD', conId: 69067924 },
      asOf: '2026-08-17T14:59:35.000Z', expiresAt: '2026-08-17T15:00:35.000Z',
      displayOnly: true, executable: false, refreshPending: true, refreshRetained: true,
      reason: 'A fresh XAUUSD quote is loading.',
    }];
    predictionMarketTestService.getMonitor.mockResolvedValue(snapshot);

    renderPanel(true, { marketId: 'gold' });

    const xauusd = await screen.findByTestId('gold-header-measure-xauusd');
    expect(await within(xauusd).findByText('4,433.8')).toBeVisible();
    expect(within(xauusd).queryByRole('button', { name: /XAUUSD delayed quote/ })).not.toBeInTheDocument();
    expect(within(xauusd).getByText(/DELAYED · AS OF/)).toBeVisible();
  });

  test('fails the Gold matrix closed while leaving its identity visible', async () => {
    MarketDataService.getGoldCorrelations.mockRejectedValue(new Error('IBKR XAUUSD disconnected'));
    predictionMarketTestService.getMonitor.mockResolvedValue(
      genericMonitorSnapshot('gold', { spotValue: 4_434.3 }),
    );

    renderPanel(true, { marketId: 'gold' });

    const matrix = await screen.findByTestId('gold-correlation-panel');
    expect(await within(matrix).findByText('CORRELATION DATA UNAVAILABLE')).toBeVisible();
    expect(await within(matrix).findByText('IBKR XAUUSD disconnected')).toBeVisible();
    expect(within(matrix).getByText('XAUUSD PROXY BASIS · COMPLETED DAILY CHANGES')).toBeVisible();
    expect(await screen.findByText('XAUUSD/DXY 30D RETURN CORRELATION')).toBeVisible();
    expect(screen.queryByText('GOLD/DXY 30D CORRELATION')).not.toBeInTheDocument();
  });

  test('retries an initial Gold correlation failure promptly, then returns to hourly polling', async () => {
    MarketDataService.getGoldCorrelations
      .mockRejectedValueOnce(new Error('IBKR XAUUSD history timed out'))
      .mockResolvedValue(goldCorrelationFixture());
    predictionMarketTestService.getMonitor.mockResolvedValue(
      genericMonitorSnapshot('gold', { spotValue: 4_434.3 }),
    );

    renderPanel(true, { marketId: 'gold' });

    const matrix = await screen.findByTestId('gold-correlation-panel');
    expect(await within(matrix).findByText('CORRELATION DATA UNAVAILABLE')).toBeVisible();
    await waitFor(() => expect(startVisibilityAwarePolling).toHaveBeenCalledWith(
      expect.objectContaining({ intervalMs: 10_000 }),
    ));
    const retryPoll = startVisibilityAwarePolling.mock.calls
      .map(([options]) => options)
      .find((options) => options.intervalMs === 10_000)?.poll;
    expect(retryPoll).toEqual(expect.any(Function));

    await act(async () => {
      await retryPoll();
    });

    expect(await within(matrix).findByText('DXY')).toBeVisible();
    await waitFor(() => expect(startVisibilityAwarePolling).toHaveBeenCalledWith(
      expect.objectContaining({ intervalMs: 60 * 60_000 }),
    ));
    expect(MarketDataService.getGoldCorrelations).toHaveBeenCalledTimes(2);
  });

  test('does not request Gold correlations for another market', async () => {
    renderPanel(true, { marketId: 'wti' });
    await screen.findByRole('region', { name: 'WTI Risk Range chart' });
    expect(MarketDataService.getGoldCorrelations).not.toHaveBeenCalled();
  });

  test('labels the Kalshi Gold card and ladder with the XAUUSD spot proxy identity', async () => {
    const snapshot = genericMonitorSnapshot('gold', { spotValue: 4_118.6 });
    const spot = {
      ...snapshot.spot,
      availability: 'current',
      fit: 'proxy',
      label: 'PROXY · XAUUSD CURRENT BAR',
      source: 'ibkr_historical_bars',
      executable: false,
      reason: 'Verified live IBKR XAUUSD spot-gold proxy; not the Pyth resolver and non-executable.',
    };
    const chart = {
      ...snapshot.chart,
      fit: 'proxy',
      label: 'PROXY · XAUUSD',
      variants: Object.fromEntries(Object.entries(snapshot.chart.variants).map(([range, variant]) => [
        range,
        { ...variant, fit: 'proxy', label: 'PROXY · XAUUSD' },
      ])),
    };
    const reference = {
      fit: 'proxy',
      resolver: 'Pyth Metal.Index.GOLD/USD; IBKR XAUUSD spot proxy shown',
      instrument: { displaySymbol: 'XAUUSD' },
      spot,
      chart,
    };
    snapshot.spot = spot;
    snapshot.chart = chart;
    snapshot.resolverReference = reference;
    snapshot.venues.kalshi.reference = reference;
    snapshot.goldMarketReferences = [
      {
        key: 'selectedResolver', label: 'PYTH GOLD INDEX', symbol: 'GOLD/USD', role: 'direct',
        status: 'unavailable', price: null, previousClose: null, changePercent: null,
        source: null, instrument: null, asOf: null, reason: 'Pyth entitlement unavailable.',
      },
      {
        key: 'xauusd', label: 'SPOT GOLD', symbol: 'XAUUSD', role: 'proxy',
        status: 'live', price: 4_118.6, previousClose: 4_100, changePercent: 0.45,
        source: 'ibkr', instrument: { symbol: 'XAUUSD', displaySymbol: 'XAUUSD' },
        asOf: '2026-08-17T14:59:40.000Z', expiresAt: '2026-08-17T15:00:40.000Z', reason: null,
      },
      {
        key: 'activeComex', label: 'COMEX GOLD', symbol: 'GC', role: 'proxy',
        status: 'unavailable', price: null, previousClose: null, changePercent: null,
        source: null, instrument: null, asOf: null, reason: 'Active GC unavailable.',
      },
    ];
    predictionMarketTestService.getMonitor.mockResolvedValue(snapshot);

    renderPanel(true, { marketId: 'gold' });

    const chartRegion = await screen.findByRole('region', { name: 'GOLD Risk Range chart' });
    const xauusd = await within(chartRegion).findByTestId('gold-header-measure-xauusd');
    await within(xauusd).findByText('4,118.6');
    expect(within(xauusd).getByText('PROXY')).toHaveAccessibleName(/not the contract resolver/i);
    expect(within(xauusd).getByText('4,118.6')).toBeVisible();
    const ladder = await screen.findByRole('region', { name: 'Gold prediction-market contract ladder' });
    expect(ladder).toHaveAttribute('data-market-symbol', 'GOLD');
    expect(within(ladder).getByRole('columnheader', { name: 'Δ XAUUSD' })).toBeInTheDocument();
    expect(within(ladder).queryByText(/PYTH ±/i)).not.toBeInTheDocument();
    const marker = within(ladder).getByRole('row', { name: 'PROXY · XAUUSD 4,118.60' });
    expect(within(marker).getByTestId('spx-live-marker-price-track')).toHaveTextContent('4,118.60');
    expect(within(marker).getByTestId('spx-live-marker-context-track')).toHaveTextContent('PROXY · XAUUSD');
  });

  test('centers the Bitcoin ladder on the verified Coinbase spot and draws its blue reference line', async () => {
    const snapshot = genericMonitorSnapshot('bitcoin', { lineCount: 20, spotValue: 118500 });
    snapshot.spot = {
      ...snapshot.spot,
      availability: 'live',
      fit: 'proxy',
      label: 'PROXY · COINBASE BTC-USD · NOT RESOLVER / NOT EXECUTABLE',
      source: 'coinbase_exchange_public_ticker',
    };
    expect(snapshot.displayContracts.lines).toHaveLength(20);
    expect(isSpxMonitorSectionUsable(snapshot.displayContracts, NOW)).toBe(true);
    predictionMarketTestService.getMonitor.mockResolvedValue(snapshot);
    renderPanel(true, { marketId: 'bitcoin' });

    const ladder = await screen.findByRole('region', { name: 'Bitcoin prediction-market contract ladder' });
    const marker = await within(ladder).findByRole('row', {
      name: 'PROXY · COINBASE BTC-USD · LIVE 118,500.00',
    });
    expect(within(marker).getByTestId('spx-live-marker-line')).toBeInTheDocument();
    expect(within(marker).getAllByTestId('spx-live-marker-segment')).toHaveLength(5);
    expect(within(marker).getByTestId('spx-live-marker-label'))
      .toHaveTextContent('PROXY · COINBASE BTC-USD · LIVE');
    expect(within(marker).getByTestId('spx-live-marker-price-track')).toHaveTextContent('118,500.00');
    expect(within(ladder).getByText('118,000')).toBeInTheDocument();
    expect(within(ladder).getByText('119,000')).toBeInTheDocument();
    expect(within(ladder).queryByText('134,000')).not.toBeInTheDocument();
  });

  test('uses Bitcoin verified candle history for the daily change when the live proxy tick is unavailable', async () => {
    const snapshot = genericMonitorSnapshot('bitcoin', { spotValue: 118500 });
    const oneDay = {
      ...snapshot.chart.variants['1d'],
      previousClose: 117000,
      previousCloseAsOf: '2026-08-16T23:00:00.000Z',
      previousCloseSource: 'coinbase_exchange_public_candles',
    };
    snapshot.spot = factor('unavailable', { value: null, label: 'BTC' });
    snapshot.chart = {
      ...oneDay,
      variants: { ...snapshot.chart.variants, '1d': oneDay },
    };
    predictionMarketTestService.getMonitor.mockResolvedValue(snapshot);

    renderPanel(true, { marketId: 'bitcoin' });

    const chartRegion = await screen.findByRole('region', { name: 'BTC Risk Range chart' });
    expect(await within(chartRegion).findByText('118,500.00')).toHaveClass('pm-spx-chart-price', 'is-positive');
    expect(within(chartRegion).getByText('+1.28%')).toHaveClass('pm-spx-day-change', 'is-positive');
  });

  test.each([
    ['same-date', '2026-08-17', '1'],
    ['different-date', '2026-08-16', '0'],
  ])('uses a verified %s snapshot Risk Range only for its matching Silver 1D session', async (_label, riskRangeDate, expectedCount) => {
    const snapshot = genericMonitorSnapshot('silver', { spotValue: 74.2 });
    const date = '2026-08-17';
    const unavailableDailyRange = {
      date,
      startAt: Date.parse(`${date}T14:55:00.000Z`),
      endAt: Date.parse(`${date}T14:59:00.000Z`),
      status: 'unavailable',
      references: [],
      reason: `Exact-date Risk Range data is unavailable for ${date}.`,
    };
    const oneDay = {
      ...snapshot.chart.variants['1d'],
      dailyRanges: [unavailableDailyRange],
      rangeDates: [date],
      riskRangeStatus: 'partial',
      riskRangeMissingDates: [date],
      riskRangeRefreshPending: true,
    };
    snapshot.chart = {
      ...oneDay,
      variants: { ...snapshot.chart.variants, '1d': oneDay },
    };
    snapshot.riskRange = factor('available', {
      source: 'hedgeye-risk-ranges-email',
      lrr: 70,
      hrr: 80,
      trend: 'bullish',
      date: riskRangeDate,
    });
    predictionMarketTestService.getMonitor.mockResolvedValue(snapshot);

    renderPanel(true, { marketId: 'silver' });

    const chartRegion = await screen.findByRole('region', { name: 'SILVER Risk Range chart' });
    await waitFor(() => expect(within(chartRegion).getByTestId('spx-chart-canvas'))
      .toHaveAttribute('data-rr-overlay-count', expectedCount));
  });

  test('shows the exact Brent Pyth resolver while retaining the separate BZ chart proxy warning', async () => {
    const snapshot = genericMonitorSnapshot('brent', { spotValue: 90.38 });
    const event = {
      ...snapshot.venues.kalshi.catalog.event,
      ticker: 'KXBRENTD-26AUG1717',
      generationId: 'KXBRENTD-26AUG1717',
      venueId: 'kalshi',
      seriesTicker: 'KXBRENTD',
      productCode: 'KXBRENTD',
      cadence: 'daily',
      observationTime: '2026-08-17T21:00:00.000Z',
      resolverSymbol: 'Commodities.BRENTX6/USD',
      resolverContractMonth: 'BRENTX6',
    };
    const contracts = { ...snapshot.venues.kalshi.contracts, event };
    snapshot.venues.kalshi = {
      ...snapshot.venues.kalshi,
      resolver: {
        ...snapshot.venues.kalshi.resolver,
        underlying: 'Commodities.BRENTX6/USD',
        pythSymbol: 'Commodities.BRENTX6/USD',
        contractSymbol: 'BRENTX6',
      },
      catalog: { ...snapshot.venues.kalshi.catalog, event },
      book: { ...snapshot.venues.kalshi.book, event },
      contracts,
    };
    snapshot.displayContracts = contracts;
    snapshot.contracts = contracts;
    snapshot.autoSelection = { ...snapshot.autoSelection, contracts };
    snapshot.displaySelection = { ...snapshot.displaySelection, contracts };
    snapshot.generationOptions = [{
      id: 'kalshi:KXBRENTD-26AUG1717', generationId: 'KXBRENTD-26AUG1717', venueId: 'kalshi',
      venueLabel: 'Kalshi', seriesTicker: 'KXBRENTD', cadence: 'daily', closeTime: event.closeTime,
      openInterest: 30500, volume24h: 15200, bookStatus: 'available',
    }, {
      id: 'kalshi:KXBRENTW-26AUG2117', generationId: 'KXBRENTW-26AUG2117', venueId: 'kalshi',
      venueLabel: 'Kalshi', seriesTicker: 'KXBRENTW', cadence: 'weekly', closeTime: '2026-08-21T21:00:00.000Z',
      openInterest: 12000, volume24h: 4100, bookStatus: 'not_loaded',
    }];
    snapshot.selectedGeneration = snapshot.generationOptions[0];
    snapshot.selectedGenerationId = snapshot.selectedGeneration.generationId;
    snapshot.selectedVenueId = 'kalshi';
    predictionMarketTestService.getMonitor.mockResolvedValue(snapshot);

    renderPanel(true, { marketId: 'brent' });

    await screen.findByRole('region', { name: 'Live Brent Oil prediction-market monitor' });
    expect(screen.queryByLabelText('Brent Oil contract generation')).not.toBeInTheDocument();
    expect(screen.queryByRole('complementary', { name: 'Brent Oil resolver diagnostics and position sizing' })).not.toBeInTheDocument();
    const factorRegion = await screen.findByRole('region', {
      name: 'Brent Oil factor monitor · KALSHI · KXBRENTD-26AUG1717 · CURRENT',
    });
    expect(factorRegion).toHaveAttribute('data-selected-venue', 'kalshi');
    expect(factorRegion).toHaveAttribute('data-event-ticker', 'KXBRENTD-26AUG1717');
    const chartRegion = within(screen.getByRole('region', { name: 'BRENT Risk Range chart' }));
    expect(chartRegion.getByText('KALSHI')).toBeInTheDocument();
    expect(chartRegion.queryByText('SETTLES ON · PYTH Commodities.Index.BRENT/USD · 1-MINUTE CLOSE')).not.toBeInTheDocument();
    expect(chartRegion.getByLabelText(/Settles on Pyth Commodities\.Index\.BRENT\/USD/i)).toBeInTheDocument();
    expect(chartRegion.queryByText('PROXY', { selector: '.pm-spx-reference-badge' })).not.toBeInTheDocument();
    expect(chartRegion.queryByText('PROXY · CURRENT BAR · NOT RESOLVER / NOT EXECUTABLE')).not.toBeInTheDocument();
    expect(formatSpotMarker({
      status: 'available',
      availability: 'current',
      fit: 'proxy',
      source: 'ibkr_historical_bars',
      label: 'PROXY · BZX26 · NOT RESOLVER / NOT EXECUTABLE',
      value: 90.38,
    }, NOW)).toBe('PROXY · BZX26 90.38');
    expect(formatSpotMarker({
      status: 'last_verified',
      availability: 'last_verified',
      fit: 'exact',
      label: 'ESU26',
      value: 7746.25,
    }, NOW)).toBe('EXACT · ESU26 · DELAYED 7,746.25');
  });

  test('ignores generation options in the simplified Gold card and always requests daily Kalshi', async () => {
    const snapshot = genericMonitorSnapshot('gold', { spotValue: 4200.1 });
    snapshot.generationOptions = [{
      id: 'kalshi:KXGOLDD-26AUG17', generationId: 'KXGOLDD-26AUG17', venueId: 'kalshi',
      venueLabel: 'Kalshi', cadence: 'daily', closeTime: '2026-08-17T20:00:00.000Z',
      openInterest: 73000, volume24h: 12000, bookStatus: 'available',
    }, {
      id: 'kalshi:KXGOLDW-26AUG21', generationId: 'KXGOLDW-26AUG21', venueId: 'kalshi',
      venueLabel: 'Kalshi', cadence: 'weekly', closeTime: '2026-08-21T21:00:00.000Z',
      openInterest: 28000, volume24h: 4200, bookStatus: 'not_loaded',
    }, {
      id: 'forecastex:METLG_082126', generationId: 'METLG_082126', venueId: 'forecastex',
      venueLabel: 'ForecastEx', cadence: 'daily', closeTime: '2026-08-21T20:00:00.000Z',
      openInterest: 50000, volume24h: 8000, bookStatus: 'unavailable',
    }];
    snapshot.selectedGeneration = snapshot.generationOptions[0];
    snapshot.selectedGenerationId = snapshot.selectedGeneration.generationId;
    snapshot.selectedVenueId = 'kalshi';
    predictionMarketTestService.getMonitor.mockResolvedValue(snapshot);
    renderPanel(true, { marketId: 'gold' });

    const chartRegion = await screen.findByRole('region', { name: 'GOLD Risk Range chart' });
    expect(screen.queryByLabelText('Gold contract generation')).not.toBeInTheDocument();
    fireEvent.click(within(chartRegion).getByRole('tab', { name: '10D' }));
    expect(within(chartRegion).getByRole('tab', { name: '10D' })).toHaveAttribute('aria-selected', 'true');
    expect(predictionMarketTestService.getMonitor).toHaveBeenCalledWith('gold', expect.objectContaining({
      venue: 'kalshi', generationId: null,
    }));
  });

  test.each([
    ['brent', 'Brent Oil'],
    ['bitcoin', 'Bitcoin'],
  ])('does not expose venue tabs for Kalshi-only %s coverage', async (marketId, label) => {
    const snapshot = genericMonitorSnapshot(marketId);
    delete snapshot.venues.forecastex;
    predictionMarketTestService.getMonitor.mockResolvedValue(snapshot);
    renderPanel(true, { marketId });

    await screen.findByRole('region', { name: `Live ${label} prediction-market monitor` });
    expect(screen.queryByRole('tab', { name: 'Auto' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Kalshi' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'ForecastEx' })).not.toBeInTheDocument();
    expect(predictionMarketTestService.getMonitor).toHaveBeenCalledWith(marketId, expect.objectContaining({
      venue: 'auto', generationId: null,
    }));
  });

  test('renders a current contextual catalog with explicit blank live-book cells when Auto has no executable venue', async () => {
    const base = genericMonitorSnapshot('wti', { spotValue: 84.3 });
    const catalog = {
      ...base.venues.kalshi.catalog,
      lines: base.venues.kalshi.catalog.lines.map((line) => ({
        ...line,
        status: 'catalog',
        yesBid: null, yesAsk: null, noBid: null, noAsk: null,
        yesBidSize: null, yesAskSize: null, noBidSize: null, noAskSize: null,
        directNative: false,
      })),
    };
    const unavailableBook = {
      status: 'unavailable', source: null, asOf: null, expiresAt: null,
      event: catalog.event, lines: [], reason: 'No verified native Kalshi book.',
    };
    const contextual = {
      ...base,
      venues: {
        ...base.venues,
        kalshi: {
          ...base.venues.kalshi,
          status: 'partial', catalog, book: unavailableBook, contracts: unavailableBook,
          bookQuality: { eligible: false, executableLineCount: 0 },
        },
      },
      autoSelection: {
        status: 'unavailable', mode: 'none', venueId: null, label: 'No executable venue',
        reason: 'No venue has a fresh complete native book with positive displayed size.',
        contracts: unavailableBook,
      },
      displaySelection: {
        status: 'available', mode: 'catalog', venueId: 'kalshi', label: 'Kalshi catalog',
        reason: 'Showing the current Kalshi contract geometry.', contracts: catalog,
      },
      displayContracts: catalog,
      contracts: unavailableBook,
    };
    predictionMarketTestService.getMonitor.mockResolvedValue(contextual);
    renderPanel(true, { marketId: 'wti' });

    const contextualLine = await screen.findByText('75.00');
    expect(contextualLine).toHaveAttribute('title', 'Settles above 75.00');
    expect(screen.queryByText('> 75.00')).not.toBeInTheDocument();
    expect(screen.getAllByText('NO QUOTE')).toHaveLength(12);
    expect(screen.queryByText('CATALOG ONLY')).not.toBeInTheDocument();
    expect(screen.queryByText('EXECUTION UNAVAILABLE')).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: /^WTI Oil factor monitor/ })).toBeInTheDocument();
  });

  test('renders fresh partial native bid/ask quotes while keeping execution unavailable', async () => {
    const base = genericMonitorSnapshot('wti', { spotValue: 84.3 });
    const liveLines = base.venues.kalshi.book.lines.map((line) => ({
      ...line,
      noAskSize: null,
    }));
    const partialBook = {
      ...base.venues.kalshi.book,
      status: 'partial',
      lines: liveLines,
      reason: 'Fresh native quotes are available, but opposite-side displayed size is incomplete.',
    };
    const displayContracts = {
      ...base.venues.kalshi.catalog,
      source: 'kalshi_trade_api_v2_catalog+native_live_quotes',
      bookStatus: 'partial',
      scheduleOnly: false,
      lines: liveLines,
      reason: partialBook.reason,
    };
    const snapshot = {
      ...base,
      venues: {
        ...base.venues,
        kalshi: {
          ...base.venues.kalshi,
          status: 'partial',
          book: partialBook,
          contracts: partialBook,
          bookQuality: { eligible: false, directLineCount: liveLines.length, executableLineCount: 0 },
        },
      },
      autoSelection: {
        status: 'unavailable', mode: 'none', venueId: null, label: 'No executable venue',
        reason: 'No venue has a fresh complete native book with positive displayed size.',
        contracts: { status: 'unavailable', event: null, lines: [], reason: 'Execution unavailable.' },
      },
      displaySelection: {
        status: 'available', mode: 'live_quotes', venueId: 'kalshi', label: 'Kalshi live quotes',
        reason: 'Showing fresh native Kalshi bid/ask quotes.', contracts: displayContracts,
      },
      displayContracts,
      contracts: partialBook,
    };
    predictionMarketTestService.getMonitor.mockResolvedValue(snapshot);
    renderPanel(true, { marketId: 'wti' });

    await screen.findByRole('region', { name: 'Live WTI Oil prediction-market monitor' });
    await screen.findAllByRole('cell', { name: 'Yes bid: 40¢, displayed size 20 contracts' });
    expect(screen.queryByText('LIVE QUOTES')).not.toBeInTheDocument();
    expect(screen.queryByText('Showing fresh native Kalshi bid/ask quotes.')).not.toBeInTheDocument();
    const tradingHours = screen.getByLabelText('Selected contract trading hours');
    expect(within(tradingHours).getByText('OPEN')).toHaveClass('pm-spx-contract-clock-status');
    expect(within(tradingHours).getByText('CLOSES IN 5h 0m')).toHaveClass('pm-spx-contract-clock-timing');
    expect(within(tradingHours).queryByText('·')).not.toBeInTheDocument();
    expect(tradingHours).toHaveAttribute('title', expect.stringContaining('EXCHANGE'));
    expect(within(tradingHours).queryByText(/EXCHANGE|LOCAL/)).not.toBeInTheDocument();
    expect(screen.getAllByRole('cell', { name: 'Yes bid: 40¢, displayed size 20 contracts' })).toHaveLength(3);
    expect(screen.getAllByRole('cell', { name: 'Yes ask: 42¢, displayed size 20 contracts' })).toHaveLength(3);
    expect(screen.getAllByRole('cell', { name: 'No bid: 58¢, displayed size 20 contracts' })).toHaveLength(3);
    expect(screen.getAllByRole('cell', { name: 'No ask: 60¢, displayed size unavailable' })).toHaveLength(3);
    expect(screen.queryByText('EXECUTION UNAVAILABLE')).not.toBeInTheDocument();
  });

  test('ignores legacy server poll hints and uses the stable five-second open-session poll', async () => {
    predictionMarketTestService.getMonitor.mockResolvedValue(genericMonitorSnapshot('wti', {
      spotValue: 84.3,
    }));
    const refreshing = {
      ...genericMonitorSnapshot('wti', { spotValue: 84.3 }),
      refresh: { state: 'refreshing', revision: 1, suggestedNextPollMs: 750 },
    };
    predictionMarketTestService.getMonitor.mockResolvedValue(refreshing);
    renderPanel(true, { marketId: 'wti' });
    await screen.findByRole('region', { name: 'Live WTI Oil prediction-market monitor' });
    expect(screen.queryByText('REVISION R1')).not.toBeInTheDocument();
    expect(screen.queryByText('REFRESH IN PROGRESS')).not.toBeInTheDocument();
    await waitFor(() => expect(startVisibilityAwarePolling).toHaveBeenCalledWith(expect.objectContaining({
      intervalMs: 5_000,
    })));
    expect(startVisibilityAwarePolling.mock.calls[0][0].pollOnStart).not.toBe(true);
  });

  test('renders every active Nasdaq threshold and places the verified NDX reference inside the ladder', async () => {
    predictionMarketTestService.getMonitor.mockResolvedValue(genericMonitorSnapshot('nasdaq100', {
      lineCount: 40,
      spotValue: 27_975,
    }));
    renderPanel(true, { marketId: 'nasdaq100' });
    const ladder = await screen.findByRole('table', { name: /All active Kalshi Nasdaq-100 lines/i });
    expect(await within(ladder).findByText('27,000')).toHaveAttribute('title', 'Settles above 27,000');
    expect(within(ladder).getByText('28,950')).toHaveAttribute('title', 'Settles above 28,950');
    expect(within(ladder).getByRole('row', { name: /EXACT · NDX · LIVE 27,975.00/ })).toBeInTheDocument();
    expect(within(ladder).getAllByText(/^2[78],/, { selector: 'strong[title]' })).toHaveLength(40);
    expect(within(ladder).queryByText(/^> 2[78],/)).not.toBeInTheDocument();
  });

  test('omits the redundant SP500 wrapper bar and close control', async () => {
    renderPanel();
    await screen.findByText('7,725');
    expect(screen.queryByRole('button', { name: 'Close SP500 monitor' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Selected contract trading hours')).toBeInTheDocument();
    const factorRegion = screen.getByRole('region', { name: 'SPX factor monitor' });
    expect(within(factorRegion).queryByText('FACTOR MONITOR')).not.toBeInTheDocument();
    expect(within(factorRegion).getByRole('columnheader', { name: 'FACTOR' })).toBeInTheDocument();
  });
});

describe('SPX monitor expiry and scoring helpers', () => {
  test('grades the three closest contract lines on both sides of every verified reference', () => {
    const lines = [4_406, 4_416, 4_426, 4_436, 4_446, 4_456, 4_466, 4_476]
      .map((threshold) => ({ threshold, comparator: '>' }));

    expect(Object.fromEntries(buildLadderProximityLevels(lines, 4_441.35))).toEqual({
      1: 'light',
      2: 'medium',
      3: 'dark',
      4: 'dark',
      5: 'medium',
      6: 'light',
    });
    expect(buildGoldLadderProximityLevels).toBe(buildLadderProximityLevels);
  });

  test('keeps three shaded lines on each side when a line contains the reference', () => {
    const lines = [90, 95, 100, 105, 110, 115, 120]
      .map((threshold) => ({ threshold, comparator: '>' }));

    expect(Object.fromEntries(buildLadderProximityLevels(lines, 105))).toEqual({
      0: 'light',
      1: 'medium',
      2: 'dark',
      3: 'dark',
      4: 'dark',
      5: 'medium',
      6: 'light',
    });
  });

  test('counts consecutive endpoint trends, restarts on reversal, and resets equals to zero', () => {
    const dailyRanges = [
      { date: '2026-08-11', status: 'available', references: [
        { label: 'LRR', value: 80 }, { label: 'HRR', value: 100 },
      ] },
      { date: '2026-08-12', status: 'available', references: [
        { label: 'LRR', value: 81 }, { label: 'HRR', value: 101 },
      ] },
      { date: '2026-08-13', status: 'available', references: [
        { label: 'LRR', value: 79 }, { label: 'HRR', value: 99 },
      ] },
      { date: '2026-08-14', status: 'available', references: [
        { label: 'LRR', value: 80 }, { label: 'HRR', value: 99 },
      ] },
    ];

    expect(calculateRiskRangeStructureScore(dailyRanges, 4)).toMatchObject({
      status: 'available',
      score: 1,
      highScore: 0,
      lowScore: 1,
      sessionCount: 4,
      comparisonCount: 3,
      eventCount: 6,
      counts: { HH: 1, HL: 2, LH: 1, LL: 1, EH: 1, EL: 0 },
      events: [
        { date: '2026-08-12', highEvent: 'HH', highCredit: 1, highScore: 1, lowEvent: 'HL', lowCredit: 1, lowScore: 1, cumulativeScore: 2 },
        { date: '2026-08-13', highEvent: 'LH', highCredit: -1, highScore: -1, lowEvent: 'LL', lowCredit: -1, lowScore: -1, cumulativeScore: -2 },
        { date: '2026-08-14', highEvent: 'EH', highCredit: 0, highScore: 0, lowEvent: 'HL', lowCredit: 1, lowScore: 1, cumulativeScore: 1 },
      ],
      sessions: [
        { date: '2026-08-11', highEvent: 'BASE', highScore: 0, lowEvent: 'BASE', lowScore: 0 },
        { date: '2026-08-12', highScore: 1, lowScore: 1 },
        { date: '2026-08-13', highScore: -1, lowScore: -1 },
        { date: '2026-08-14', highScore: 0, lowScore: 1 },
      ],
      ruleVersion: 'visible-window-split-streak-v3',
    });
  });

  test('matches the illustrated independent 10D high and low trend streaks', () => {
    const highValues = [7896, 7924, 7899, 7884, 7861, 7824, 7815, 7811, 7815, 7835];
    const lowValues = [7526, 7550, 7560, 7576, 7606, 7674, 7676, 7652, 7652, 7610];
    const dailyRanges = highValues.map((hrr, index) => ({
      date: `2026-08-${String(index + 10).padStart(2, '0')}`,
      status: 'available',
      references: [
        { label: 'LRR', value: lowValues[index] },
        { label: 'HRR', value: hrr },
      ],
    }));

    const result = calculateRiskRangeStructureScore(dailyRanges, 10);

    expect(result.sessions.map((session) => session.highScore))
      .toEqual([0, 1, -1, -2, -3, -4, -5, -6, 1, 2]);
    expect(result.sessions.map((session) => session.lowScore))
      .toEqual([0, 1, 2, 3, 4, 5, 6, -1, 0, -1]);
    expect(result).toMatchObject({ status: 'available', highScore: 2, lowScore: -1, score: 1 });
  });

  test('does not publish a partial structure score when a session Risk Range is unavailable', () => {
    expect(calculateRiskRangeStructureScore([
      { date: '2026-08-11', status: 'available', references: [
        { label: 'LRR', value: 80 }, { label: 'HRR', value: 100 },
      ] },
      { date: '2026-08-12', status: 'unavailable', references: [] },
    ], 2)).toMatchObject({
      status: 'unavailable',
      score: null,
      highScore: null,
      lowScore: null,
      eventCount: 0,
      events: [],
      sessions: [],
    });
  });

  test('builds verified open, scheduled, and post-close contract clocks without assuming missing hours', () => {
    const schedule = {
      openTime: '2026-08-17T13:00:00.000Z',
      closeTime: '2026-08-17T20:00:00.000Z',
      observationTime: '2026-08-17T21:00:00.000Z',
      resolutionTime: '2026-08-17T22:00:00.000Z',
      timezone: 'America/New_York',
      status: 'open',
    };
    const open = buildContractTradingClock({
      event: schedule,
      nowMs: NOW,
      localTimeZone: 'America/Los_Angeles',
    });
    expect(open).toMatchObject({
      state: 'open',
      headline: 'OPEN · CLOSES IN 5h 0m',
      primarySchedule: 'EXCHANGE · Aug 17, 9:00 AM EDT → Aug 17, 4:00 PM EDT',
      secondarySchedule: 'LOCAL · Aug 17, 6:00 AM PDT → Aug 17, 1:00 PM PDT',
    });

    const scheduled = buildContractTradingClock({
      event: schedule,
      nowMs: Date.parse('2026-08-17T12:00:00.000Z'),
      localTimeZone: 'America/Los_Angeles',
    });
    expect(scheduled).toMatchObject({ state: 'scheduled', headline: 'OPENS IN 1h 0m' });

    const postClose = buildContractTradingClock({
      event: schedule,
      nowMs: Date.parse('2026-08-17T20:30:00.000Z'),
      localTimeZone: 'America/Los_Angeles',
    });
    expect(postClose).toMatchObject({
      state: 'closed',
      headline: 'TRADING CLOSED · OBSERVES IN 30m 0s',
    });

    expect(buildContractTradingClock({ event: { status: 'scheduled' }, nowMs: NOW })).toMatchObject({
      state: 'scheduled',
      headline: 'SCHEDULED · OPEN TIME UNAVAILABLE',
      primarySchedule: 'VERIFIED TRADING WINDOW UNAVAILABLE',
    });
    expect(buildContractTradingClock({ nowMs: NOW })).toMatchObject({
      state: 'unavailable',
      headline: 'CONTRACT HOURS UNAVAILABLE',
      primarySchedule: 'VERIFIED TRADING WINDOW UNAVAILABLE',
    });
  });

  test('fails a venue closed when fresh-looking quotes came from a failed refresh', () => {
    const snapshot = genericMonitorSnapshot('silver');
    snapshot.venues.kalshi.book = {
      ...snapshot.venues.kalshi.book,
      refreshFailed: true,
      refreshIssue: 'Kalshi refresh timed out.',
    };

    expect(getMonitorVenueAvailability(snapshot, 'kalshi', NOW)).toEqual({
      selectable: true,
      reason: 'Kalshi refresh timed out.',
      quotedLineCount: 0,
    });
  });

  test('builds a clean shared SPX price axis with evenly spaced round ticks', () => {
    const axis = buildSpxPriceAxis([7604, 7652, 7684, 7815, 7861]);

    expect(axis.domain).toEqual([7550, 7900]);
    expect(axis.step).toBe(50);
    expect(axis.ticks).toEqual([7550, 7600, 7650, 7700, 7750, 7800, 7850, 7900]);
  });

  test('builds unique hourly ticks for a regular 1D SPX session', () => {
    const start = Date.parse('2026-08-17T13:00:00.000Z');
    const timestamps = Array.from({ length: 79 }, (_, index) => start + (index * 5 * 60_000));
    const axis = buildIntradayTimeAxis(timestamps);

    expect(axis.domain).toEqual([start, start + (78 * 5 * 60_000)]);
    expect(axis.step).toBe(60 * 60_000);
    expect(axis.ticks).toEqual(Array.from({ length: 7 }, (_, index) => start + (index * 60 * 60_000)));
    expect(new Set(axis.ticks).size).toBe(axis.ticks.length);
  });

  test('uses wider nice intervals for a full-day 1D market', () => {
    const start = Date.parse('2026-08-17T00:00:00.000Z');
    const axis = buildIntradayTimeAxis([start, start + (24 * 60 * 60_000)]);

    expect(axis.step).toBe(4 * 60 * 60_000);
    expect(axis.ticks).toHaveLength(7);
  });

  test('anchors an SPX intraday axis to the labeled cash-session open and close', () => {
    const open = Date.parse('2026-08-17T13:30:00.000Z');
    const close = Date.parse('2026-08-17T20:00:00.000Z');
    const timestamps = Array.from({ length: 78 }, (_, index) => open + (index * 5 * 60_000));
    const axis = buildIntradayTimeAxis(timestamps, 8, {
      domain: [open, close],
      includeEndpoints: true,
    });

    expect(axis.domain).toEqual([open, close]);
    expect(axis.hasSessionEndpoints).toBe(true);
    expect(axis.ticks[0]).toBe(open);
    expect(axis.ticks[axis.ticks.length - 1]).toBe(close);
    expect(new Set(axis.ticks).size).toBe(axis.ticks.length);
  });

  test('lays out nearby right-edge values in price order and leaves distant labels untouched', () => {
    const offsets = resolveChartLabelOffsets([
      { id: 'ath', value: 7817 },
      { id: 'hrr', value: 7815 },
      { id: 'lrr', value: 7652 },
      { id: 'latest', value: 7642 },
      { id: 'distant', value: 7720 },
    ], [7600, 7900], { height: 220, minGap: 16, padding: 8 });

    expect(offsets.ath).toBeLessThan(0);
    expect(offsets.hrr).toBeGreaterThan(0);
    expect(offsets.lrr).toBeLessThan(0);
    expect(offsets.latest).toBeGreaterThan(0);
    expect(offsets.distant).toBe(0);
    const exactTie = resolveChartLabelOffsets([
      { id: 'hrr', value: 7815 },
      { id: 'ath', value: 7815 },
    ], [7600, 7900]);
    expect(exactTie.ath).toBeLessThan(exactTie.hrr);
  });

  test('maps five sessions to equal-width slots and inserts line-breaking gaps', () => {
    const chart = fiveDayChartFixture();
    const plotWidth = 800;
    const layout = buildFiveDayChartLayout(chart.points, chart.dailyRanges, plotWidth, {
      calendar: 'us_equity',
      closedDayWidthPx: 44,
    });

    expect(layout.sessions).toHaveLength(5);
    expect(layout.gaps).toHaveLength(4);
    expect(layout.gaps.map(({ previousDate, date, isWeekend }) => ({ previousDate, date, isWeekend }))).toEqual([
      { previousDate: '2026-08-11', date: '2026-08-12', isWeekend: false },
      { previousDate: '2026-08-12', date: '2026-08-13', isWeekend: false },
      { previousDate: '2026-08-13', date: '2026-08-14', isWeekend: false },
      { previousDate: '2026-08-14', date: '2026-08-17', isWeekend: true },
    ]);
    const weekendGap = layout.gaps[3];
    expect(weekendGap.startX).toBe(layout.sessions[3].endX);
    expect(weekendGap.endX).toBe(layout.sessions[4].startX);
    expect(weekendGap.closedDays.map(({ date, type }) => ({ date, type }))).toEqual([
      { date: '2026-08-15', type: 'weekend' },
      { date: '2026-08-16', type: 'weekend' },
    ]);
    expect(weekendGap.width * (plotWidth / layout.maxX)).toBeCloseTo(88, 5);
    weekendGap.closedDays.forEach((closedDay) => {
      expect(closedDay.width * (plotWidth / layout.maxX)).toBeCloseTo(44, 5);
      expect((closedDay.bandEndX - closedDay.bandStartX) * (plotWidth / layout.maxX)).toBeCloseTo(40, 5);
    });
    layout.sessions.forEach((session) => expect(session.endX - session.startX).toBeCloseTo(1, 10));
    expect(layout.points.filter((point) => point.value == null)).toHaveLength(4);
    expect(layout.closedDays).toHaveLength(2);
    expect(layout.axisGridTemplate).toContain(`${weekendGap.closedDays[0].width}fr`);
    expect(layout.latestPoint.plotX).toBe(layout.sessions[4].endX);
    expect(layout.latestPoint.plotX - layout.sessions[4].startX).toBeCloseTo(1, 5);
  });

  test('preserves the legacy neutral gap metadata when no exchange calendar is configured', () => {
    const chart = fiveDayChartFixture();
    const plotWidth = 800;
    const layout = buildFiveDayChartLayout(chart.points, chart.dailyRanges, plotWidth);
    const weekendGap = layout.gaps[3];

    expect(weekendGap.isWeekend).toBe(true);
    expect(weekendGap.calendarAware).toBe(false);
    expect(weekendGap.closedDays).toEqual([]);
    expect(weekendGap.width * (plotWidth / layout.maxX)).toBeCloseTo(19, 5);
    expect((weekendGap.separatorEndX - weekendGap.separatorStartX) * (plotWidth / layout.maxX)).toBeCloseTo(15, 5);
  });

  test('uses S&P-style dated weekend bars for weekday-traded commodity charts', () => {
    const chart = chartLayoutFixture(['2026-09-04', '2026-09-08']);
    const layout = buildMultiDayChartLayout(chart.points, chart.dailyRanges, 2, 800, {
      calendar: 'weekday',
      closedDayWidthPx: 44,
    });

    expect(layout.gaps[0].calendarAware).toBe(true);
    expect(layout.closedDays.map(({ date, type }) => ({ date, type }))).toEqual([
      { date: '2026-09-05', type: 'weekend' },
      { date: '2026-09-06', type: 'weekend' },
    ]);
    expect(layout.gaps[0].unknownDateKeys).toEqual(['2026-09-07']);
  });

  test('uses resolver-session tags for Gold sessions that begin at 5 PM on the prior calendar day', () => {
    const dates = ['2026-08-31', '2026-09-01'];
    const points = [
      { timestamp: Date.parse('2026-08-28T21:00:00.000Z'), value: 4400, sessionDate: dates[0] },
      { timestamp: Date.parse('2026-08-28T22:00:00.000Z'), value: 4401, sessionDate: dates[0] },
      { timestamp: Date.parse('2026-08-31T21:00:00.000Z'), value: 4410, sessionDate: dates[1] },
      { timestamp: Date.parse('2026-08-31T22:00:00.000Z'), value: 4411, sessionDate: dates[1] },
    ];
    const dailyRanges = dates.map((date, index) => ({
      date,
      startAt: points[index * 2].timestamp,
      endAt: points[(index * 2) + 1].timestamp,
      status: 'available',
      references: [],
    }));

    const layout = buildMultiDayChartLayout(points, dailyRanges, 2, 800, {
      calendar: 'weekday',
      closedDayWidthPx: 44,
    });

    expect(layout.sessions.map((session) => session.date)).toEqual(dates);
    expect(layout.sessions.map((session) => session.points)).toEqual([
      points.slice(0, 2),
      points.slice(2, 4),
    ]);
    expect(layout.latestPoint.sessionDate).toBe('2026-09-01');
  });

  test('clips a raw contract overlay to the black basis sessions without shifting its prices', () => {
    const basis = chartLayoutFixture(['2026-08-13', '2026-08-14']);
    const layout = buildMultiDayChartLayout(basis.points, basis.dailyRanges, 2, 800, {
      calendar: 'us_equity',
      closedDayWidthPx: 44,
    });
    const contractPoints = [
      { timestamp: Date.parse('2026-08-13T12:00:00.000Z'), value: 7711 },
      { timestamp: Date.parse('2026-08-13T15:00:00.000Z'), value: 7722 },
      { timestamp: Date.parse('2026-08-14T20:00:00.000Z'), value: 7733 },
      { timestamp: Date.parse('2026-08-14T22:00:00.000Z'), value: 7744 },
    ];

    const projected = projectOverlayPointsToSessions(contractPoints, layout.sessions);

    expect(projected.map((point) => point.value)).toEqual([7722, null, 7733]);
    expect(projected.map((point) => point.contractValue)).toEqual([7722, null, 7733]);
    expect(projected.map((point) => point.sessionDate)).toEqual(['2026-08-13', null, '2026-08-14']);
    expect(projected[0].plotX).toBeGreaterThanOrEqual(layout.sessions[0].startX);
    expect(projected[1]).toMatchObject({ isSessionGap: true, timestamp: null });
    expect(projected[2].plotX).toBeLessThanOrEqual(layout.sessions[1].endX);
  });

  test('expands a holiday weekend into weekend, weekend, and holiday bars', () => {
    const chart = chartLayoutFixture(['2026-09-04', '2026-09-08']);
    const layout = buildMultiDayChartLayout(chart.points, chart.dailyRanges, 2, 800, {
      calendar: 'us_equity',
      closedDayWidthPx: 44,
    });

    expect(layout.closedDays.map(({ date, type, holidayName }) => ({ date, type, holidayName }))).toEqual([
      { date: '2026-09-05', type: 'weekend', holidayName: null },
      { date: '2026-09-06', type: 'weekend', holidayName: null },
      { date: '2026-09-07', type: 'holiday', holidayName: 'Labor Day' },
    ]);
    expect(layout.gaps[0].unknownDateKeys).toEqual([]);
  });

  test('renders Thanksgiving alone and leaves an ordinary missing weekday as a neutral thin gap', () => {
    const thanksgivingChart = chartLayoutFixture(['2026-11-25', '2026-11-27']);
    const thanksgivingLayout = buildMultiDayChartLayout(
      thanksgivingChart.points,
      thanksgivingChart.dailyRanges,
      2,
      800,
      { calendar: 'us_equity', closedDayWidthPx: 44 },
    );
    expect(thanksgivingLayout.closedDays).toEqual([
      expect.objectContaining({
        date: '2026-11-26',
        type: 'holiday',
        holidayName: 'Thanksgiving Day',
      }),
    ]);
    expect(thanksgivingLayout.sessions.map((session) => session.date)).toContain('2026-11-27');

    const missingWeekdayChart = chartLayoutFixture(['2026-08-11', '2026-08-13']);
    const missingWeekdayLayout = buildMultiDayChartLayout(
      missingWeekdayChart.points,
      missingWeekdayChart.dailyRanges,
      2,
      800,
      { calendar: 'us_equity', closedDayWidthPx: 44 },
    );
    expect(missingWeekdayLayout.closedDays).toEqual([]);
    expect(missingWeekdayLayout.gaps[0].unknownDateKeys).toEqual(['2026-08-12']);
    expect(missingWeekdayLayout.gaps[0].segments).toEqual([
      expect.objectContaining({ type: 'neutral', date: '2026-08-12' }),
    ]);
  });

  test('keeps an exact strike in addition to five contracts above and below it', () => {
    const analyses = Array.from({ length: 13 }, (_, index) => ({
      line: { ticker: `LINE-${index}`, threshold: 7600 + (index * 25) },
    }));

    expect(selectContractLinesAroundSpot(analyses, 7750).map(({ line }) => line.threshold)).toEqual([
      7625, 7650, 7675, 7700, 7725, 7750, 7775, 7800, 7825, 7850, 7875,
    ]);
  });

  test('keeps five lines on each side of a verified reference plus its containing range', () => {
    const analyses = [
      ...Array.from({ length: 7 }, (_, index) => ({
        line: { ticker: `BELOW-${index}`, threshold: 60 + index, comparator: '>' },
      })),
      { line: { ticker: 'CONTAINING', lowerBound: 67, upperBound: 69, comparator: 'inclusive_range' } },
      ...Array.from({ length: 7 }, (_, index) => ({
        line: { ticker: `ABOVE-${index}`, threshold: 70 + index, comparator: '>' },
      })),
    ];

    expect(selectContractLinesForReference(analyses, 68).map(({ line }) => line.ticker)).toEqual([
      'BELOW-2', 'BELOW-3', 'BELOW-4', 'BELOW-5', 'BELOW-6',
      'CONTAINING',
      'ABOVE-0', 'ABOVE-1', 'ABOVE-2', 'ABOVE-3', 'ABOVE-4',
    ]);
  });

  test('uses at most ten highest-activity lines sorted by price without a verified reference', () => {
    const analyses = Array.from({ length: 14 }, (_, index) => ({
      line: {
        ticker: `LINE-${index}`,
        threshold: 100 + index,
        openInterest: index,
        volume24h: index * 2,
      },
    }));

    expect(selectContractLinesForReference(analyses, null).map(({ line }) => line.threshold)).toEqual([
      104, 105, 106, 107, 108, 109, 110, 111, 112, 113,
    ]);
  });

  test('withholds expired sections', () => {
    expect(isSpxMonitorSectionUsable({ status: 'available', expiresAt: '2026-08-17T14:59:59.000Z' }, NOW)).toBe(false);
    expect(isSpxMonitorSectionUsable({ status: 'available', expiresAt: FUTURE }, NOW)).toBe(true);
    expect(isSpxMonitorSectionUsable({ status: 'unavailable', expiresAt: FUTURE }, NOW)).toBe(false);
  });

  test('retains verified same-date Risk Range overlays while only the overlay history refresh is pending', () => {
    const previous = genericMonitorSnapshot('silver', { spotValue: 74.2 });
    const tenDay = previous.chart.variants['10d'];
    const latestRange = tenDay.dailyRanges[tenDay.dailyRanges.length - 1];
    const oneDay = {
      ...previous.chart.variants['1d'],
      dailyRanges: [latestRange],
      rangeDates: [latestRange.date],
      riskRangeStatus: 'available',
      riskRangeMissingDates: [],
    };
    previous.chart = {
      ...oneDay,
      variants: { ...previous.chart.variants, '1d': oneDay },
    };
    const pendingOverlay = (variant) => ({
      ...variant,
      dailyRanges: variant.dailyRanges.map((range) => ({
        ...range,
        status: 'unavailable',
        references: [],
        reason: `Exact-date Risk Range data is unavailable for ${range.date}.`,
      })),
      riskRangeStatus: 'partial',
      riskRangeMissingDates: variant.dailyRanges.map((range) => range.date),
      riskRangeRefreshPending: true,
    });
    const nextOneDay = pendingOverlay(oneDay);
    const next = {
      ...previous,
      chart: {
        ...nextOneDay,
        variants: Object.fromEntries(Object.entries(previous.chart.variants).map(([range, variant]) => [
          range,
          pendingOverlay(variant),
        ])),
      },
    };

    const merged = mergeSpxMonitorSnapshots(previous, next, NOW);

    expect(merged.chart).toMatchObject({
      riskRangeStatus: 'available',
      riskRangeRefreshPending: true,
      riskRangeRefreshRetained: true,
      dailyRanges: [expect.objectContaining({
        date: latestRange.date,
        status: 'available',
        refreshPending: true,
        refreshRetained: true,
      })],
    });
    expect(merged.chart.variants['5d'].dailyRanges.filter((range) => range.status === 'available')).toHaveLength(5);
    expect(merged.chart.variants['10d'].dailyRanges.filter((range) => range.status === 'available')).toHaveLength(10);
  });

  test('keeps one verified ATH mounted on 1D, 5D, and 10D while its independent record refresh is pending', () => {
    const ath = {
      status: 'available',
      source: 'ibkr_historical_record',
      asOf: '2026-08-17T15:00:00.000Z',
      value: 124.99,
      date: '2026-08-15',
      baseline: {
        value: 124.99,
        date: '2026-08-15',
        throughDate: '2026-08-17',
        source: 'ibkr',
        dataset: 'historical_record',
        coverageComplete: true,
        coverageStart: '1975-01-01',
        coverageEnd: '2026-08-17',
      },
      markers: [],
      reason: null,
    };
    const previous = genericMonitorSnapshot('silver', { spotValue: 74.2 });
    previous.chart = {
      ...previous.chart,
      ath,
      variants: Object.fromEntries(Object.entries(previous.chart.variants).map(([range, variant]) => [
        range,
        { ...variant, ath },
      ])),
    };
    const pendingAth = {
      status: 'loading', source: null, baseline: null, markers: [], reason: 'Checking verified ATH history.',
    };
    const next = genericMonitorSnapshot('silver', { spotValue: 74.4 });
    next.chart = {
      ...next.chart,
      ath: pendingAth,
      variants: Object.fromEntries(Object.entries(next.chart.variants).map(([range, variant]) => [
        range,
        { ...variant, ath: pendingAth },
      ])),
    };

    const merged = mergeSpxMonitorSnapshots(previous, next, NOW);

    expect(merged.chart.latestValue).toBe(74.4);
    ['1d', '5d', '10d'].forEach((range) => {
      expect(merged.chart.variants[range].ath).toMatchObject({
        status: 'available',
        value: 124.99,
        refreshPending: true,
        refreshRetained: true,
      });
    });
    expect(merged.chart.ath).toEqual(merged.chart.variants['1d'].ath);
  });

  test.each([
    ['terminal provider failure', { refreshFailed: true, refreshIssue: 'Risk Range provider failed.' }],
    ['forbidden cached provenance', { source: 'ibkr_chart_cache', fromCache: true }],
  ])('does not retain Risk Range overlays through a %s', (_label, unsafeFields) => {
    const previous = genericMonitorSnapshot('silver', { spotValue: 74.2 });
    const prior = previous.chart.variants['10d'];
    const nextVariant = {
      ...prior,
      ...unsafeFields,
      riskRangeRefreshPending: true,
      riskRangeStatus: 'partial',
      riskRangeMissingDates: prior.dailyRanges.map((range) => range.date),
      dailyRanges: prior.dailyRanges.map((range) => ({
        ...range, status: 'unavailable', references: [], reason: 'Unavailable during refresh.',
      })),
    };
    const next = {
      ...previous,
      chart: {
        ...previous.chart,
        variants: { ...previous.chart.variants, '10d': nextVariant },
      },
    };

    expect(mergeSpxMonitorSnapshots(previous, next, NOW).chart.variants['10d'].dailyRanges)
      .toEqual(expect.arrayContaining([expect.objectContaining({ status: 'unavailable', references: [] })]));
  });

  test('does not retain an expired or explicitly invalidated section', () => {
    const previous = monitorSnapshot();
    const refreshFailure = monitorSnapshot({
      spot: factor('unavailable', { refreshFailed: true, refreshIssue: 'timeout' }),
      chart: factor('unavailable', {
        range: '1d', points: [], references: [], refreshFailed: true, refreshIssue: 'chart timeout',
      }),
    });
    const mergedFailure = mergeSpxMonitorSnapshots(previous, refreshFailure, NOW);
    expect(mergedFailure.spot).toMatchObject({
      status: 'unavailable',
      refreshIssue: 'timeout',
    });
    expect(mergedFailure.chart).toMatchObject({
      status: 'unavailable',
      points: [],
      refreshIssue: 'chart timeout',
    });
    expect(mergeSpxMonitorSnapshots(previous, refreshFailure, Date.parse(FUTURE) + 1).spot.status)
      .toBe('unavailable');

    const explicitOffline = monitorSnapshot({
      spot: factor('unavailable', { reason: 'IBKR disconnected' }),
    });
    expect(mergeSpxMonitorSnapshots(previous, explicitOffline, NOW).spot.status)
      .toBe('unavailable');
  });

  test.each([
    ['expired', { source: 'ibkr_historical_bars', expiresAt: '2026-08-17T14:59:59.000Z' }],
    ['cache-derived', { source: 'ibkr_chart_cache', expiresAt: FUTURE, fromCache: true }],
  ])('does not retain a %s chart when a refresh begins', (_label, unsafeFields) => {
    const previous = monitorSnapshot();
    const unsafeVariant = (variant) => ({
      ...variant,
      ...unsafeFields,
      status: 'available',
      availability: 'current',
    });
    previous.chart = {
      ...unsafeVariant(previous.chart),
      variants: Object.fromEntries(Object.entries(previous.chart.variants).map(([range, variant]) => [
        range,
        unsafeVariant(variant),
      ])),
    };
    const refreshingVariant = (range) => ({
      status: 'refreshing', refreshing: true, availability: 'unavailable', source: null,
      expiresAt: null, range, points: [], dailyRanges: [], rangeDates: [],
    });
    const next = monitorSnapshot({
      chart: {
        ...refreshingVariant('1d'),
        variants: {
          '1d': refreshingVariant('1d'),
          '5d': refreshingVariant('5d'),
          '10d': refreshingVariant('10d'),
        },
      },
    });

    expect(mergeSpxMonitorSnapshots(previous, next, NOW).chart).toMatchObject({
      status: 'refreshing',
      points: [],
      variants: {
        '1d': { status: 'refreshing', points: [] },
        '5d': { status: 'refreshing', points: [] },
        '10d': { status: 'refreshing', points: [] },
      },
    });
  });

  test('clears a failed native venue while retaining still-fresh generic factor rows', () => {
    const previous = genericMonitorSnapshot('wti', { spotValue: 76.25 });
    previous.factors = { OVX: factor('available', { value: 32.5 }) };
    previous.factorRows = [{ id: 'OVX', label: 'OVX', status: 'available', value: 32.5, asOf: '2026-08-17T14:59:00.000Z' }];
    const next = genericMonitorSnapshot('wti', { spotValue: 76.25 });
    next.venues.kalshi.contracts = factor('unavailable', {
      event: null, lines: [], refreshFailed: true, refreshIssue: 'Kalshi timeout',
    });
    next.factors = { OVX: factor('unavailable', { value: null, refreshFailed: true, refreshIssue: 'OVX timeout' }) };
    next.factorRows = [{ id: 'OVX', label: 'OVX', status: 'unavailable', value: null }];
    next.autoSelection = {
      status: 'unavailable', mode: 'none', venueId: null,
      refreshFailedVenueIds: ['kalshi'],
      contracts: factor('unavailable', {
        event: null, lines: [], refreshFailed: true, refreshIssue: 'Kalshi timeout',
      }),
    };
    next.contracts = next.autoSelection.contracts;

    const retained = mergeSpxMonitorSnapshots(previous, next, NOW);
    expect(retained.contracts.lines).toHaveLength(0);
    expect(retained.contracts.refreshIssue).toBe('Kalshi timeout');
    expect(retained.factors.OVX).toMatchObject({ status: 'available', value: 32.5, refreshFailed: true });
    expect(retained.factorRows[0]).toMatchObject({ id: 'OVX', status: 'available', refreshDelayed: true });

    next.autoSelection.refreshFailedVenueIds = ['forecastex'];
    expect(mergeSpxMonitorSnapshots(previous, next, NOW).contracts.status).toBe('unavailable');
  });

  test('retains a fresh FES book only while refresh is pending and clears provider failures', () => {
    const previous = monitorSnapshot();
    const next = monitorSnapshot();
    const catalog = {
      ...next.contracts,
      source: 'forecastex_official_schedule',
      scheduleOnly: true,
      lines: next.contracts.lines.map((line) => ({
        ...line,
        source: 'forecastex_official_schedule', directNative: false,
        yesBid: null, yesAsk: null, noBid: null, noAsk: null,
        yesBidSize: null, yesAskSize: null, noBidSize: null, noAskSize: null,
      })),
    };
    const timeoutBook = factor('unavailable', {
      source: null,
      event: next.contracts.event,
      lines: [],
      refreshFailed: true,
      refreshIssue: 'ForecastEx native quote refresh timed out.',
      reason: 'ForecastEx native quote refresh timed out.',
    });
    next.contracts = timeoutBook;
    next.displayContracts = catalog;
    next.venues.forecastex = {
      ...next.venues.forecastex,
      catalog,
      book: timeoutBook,
      contracts: timeoutBook,
    };
    next.displaySelection = {
      ...next.displaySelection,
      contracts: catalog,
    };

    const pendingBook = {
      ...timeoutBook,
      status: 'refreshing',
      refreshing: true,
      refreshPending: true,
      refreshFailed: false,
      refreshIssue: null,
      reason: null,
    };
    const pending = {
      ...next,
      contracts: pendingBook,
      venues: {
        forecastex: {
          ...next.venues.forecastex,
          book: pendingBook,
          contracts: pendingBook,
        },
      },
    };
    const retained = mergeSpxMonitorSnapshots(previous, pending, NOW);
    expect(retained.venues.forecastex.book).toMatchObject({
      status: 'available', refreshRetained: true,
      lines: expect.arrayContaining([
        expect.objectContaining({ directNative: true, yesBid: 0.66, noAsk: 0.34 }),
      ]),
    });
    expect(retained.displayContracts.lines).toEqual(expect.arrayContaining([
      expect.objectContaining({ directNative: true, yesBid: 0.66, noAsk: 0.34 }),
    ]));

    const failed = mergeSpxMonitorSnapshots(previous, next, NOW);
    expect(failed.venues.forecastex.book.lines).toEqual([]);
    expect(failed.displayContracts.lines).toEqual(expect.arrayContaining([
      expect.objectContaining({ directNative: false, yesBid: null, noAsk: null }),
    ]));

    const disconnected = {
      ...next,
      contracts: {
        ...timeoutBook,
        refreshIssue: 'IBKR disconnected.',
        reason: 'IBKR disconnected.',
      },
      venues: {
        forecastex: {
          ...next.venues.forecastex,
          book: { ...timeoutBook, refreshIssue: 'IBKR disconnected.', reason: 'IBKR disconnected.' },
          contracts: { ...timeoutBook, refreshIssue: 'IBKR disconnected.', reason: 'IBKR disconnected.' },
        },
      },
    };
    const cleared = mergeSpxMonitorSnapshots(previous, disconnected, NOW);
    expect(cleared.venues.forecastex.book.lines).toEqual([]);
    expect(cleared.contracts.lines).toEqual([]);
  });

  test('accepts only verified-live position envelopes for the FES overlay', () => {
    expect(normalizeLivePositionOverlayPayload({
      status: 'live',
      meta: { source: 'ibkr_live', fetchedAt: new Date(NOW).toISOString() },
      positions: [{ description: 'FES_081726_7725_YES' }],
    })).toMatchObject({ status: 'live', positions: [{ description: 'FES_081726_7725_YES' }] });
    expect(normalizeLivePositionOverlayPayload({
      status: 'live',
      meta: { source: 'cache', fetchedAt: new Date(NOW).toISOString() },
      positions: [{ description: 'FES_081726_7725_YES' }],
    })).toMatchObject({ status: 'unavailable', positions: [] });
    expect(normalizeLivePositionOverlayPayload({
      status: 'live', meta: { source: 'ibkr_live' }, positions: [],
    })).toMatchObject({ status: 'unavailable', positions: [] });
  });

  test('parses and combines positive live FES holdings without crossing generation or account boundaries', () => {
    expect(parseLiveFesPosition({
      accountId: 'U1', description: 'FES_081726_7725_NO', quantity: 10, avgCost: 0.62,
    })).toMatchObject({
      generationKey: 'FES_081726', eventContract: 'FES_081726_7725',
      side: 'NO', quantity: 10, averageCost: 0.62, cost: 6.2, accountId: 'U1',
    });
    expect(parseLiveFesPosition({
      accountId: 'U1', description: 'FES_081726_7725_NO', quantity: -10, avgCost: 0.62,
    })).toBeNull();

    const positionMap = buildLiveFesPositionMap([
      { accountId: 'U1', description: 'FES_081726_7725_YES', quantity: 10, avgCost: 0.4 },
      { accountId: 'U1', description: 'FES_081726_7725_YES', quantity: 10, avgCost: 0.5 },
      { accountId: 'U1', description: 'FES_081626_7725_NO', quantity: 10, avgCost: 0.6 },
      { accountId: 'U2', description: 'FES_081726_7725_NO', quantity: 10, avgCost: 0.7 },
    ], { generationKey: 'FES_081726', accountId: 'U1' });

    expect(positionMap.get('FES_081726_7725')).toEqual([expect.objectContaining({
      side: 'YES', quantity: 20, cost: 9, averageCost: 0.45, accountId: 'U1',
    })]);
  });

  test('scores each line independently while preserving strike order', () => {
    const analyses = buildSpxContractAnalyses(monitorSnapshot(), NOW);
    expect(analyses.map(({ line }) => line.threshold)).toEqual([7725, 7775]);
    expect(analyses.every(({ confluence }) => confluence.maxScore === 8)).toBe(true);
    expect(analyses.map(({ confluence }) => confluence.score)).toEqual([7, 5]);
  });
});
