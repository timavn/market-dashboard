import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import predictionMarketsIngestService from '../../../services/api/predictionMarketsIngestService';
import { MarketDataService } from '../../../services/api/marketDataService';
import WtiWorkbench from '../WtiWorkbench';
import { resetSessionResourceStore } from '../../../utils/sessionResourceStore';

jest.mock('../../../services/api/predictionMarketsIngestService', () => ({
  __esModule: true,
  default: {
    getWtiWorkbench: jest.fn(),
    getLastSettledWtiSession: jest.fn(),
    getRecentSettledWtiSessions: jest.fn(),
  },
}));

jest.mock('../../../services/api/marketDataService', () => ({
  MarketDataService: {
    getRiskRangeHistory: jest.fn(),
    getVolatilitySnapshot: jest.fn(),
  },
}));

jest.mock('../../../utils/visibilityAwarePolling', () => ({
  startVisibilityAwarePolling: jest.fn(() => jest.fn()),
}));

const NOW = Date.parse('2026-07-21T18:31:00.000Z');
const EVENT_TICKER = 'KXWTI-26JUL2114';

function market(threshold, overrides = {}) {
  return {
    ticker: `${EVENT_TICKER}-T${threshold}`,
    eventTicker: EVENT_TICKER,
    geometry: {
      kind: 'above',
      strikeType: 'greater',
      threshold,
      lowerBound: threshold,
      upperBound: null,
      lowerInclusive: false,
      upperInclusive: false,
    },
    yesBid: 0.64,
    yesAsk: 0.66,
    yesBidSize: 400,
    yesAskSize: 300,
    noBid: 0.33,
    noAsk: 0.35,
    noBidSize: null,
    noAskSize: null,
    nativeBook: {
      yesPrices: true,
      noPrices: true,
      yesDepth: true,
      noDepth: false,
      complete: true,
      derivedFields: [],
    },
    volume24h: 12000,
    volumeTotal: 18000,
    openInterest: 4500,
    rulesPrimary: `The ICE WTI settlement must be strictly above ${threshold}.`,
    rulesSecondary: 'Venue settlement precision applies.',
    ...overrides,
  };
}

const settlementMapping = {
  status: 'consistent_unverified',
  frontMonthContract: 'CLU26',
  contractMonth: '2026-09',
  observationTime: '2026-07-21T18:30:00.000Z',
  units: 'USD/Bbl',
  precisionDecimals: 2,
  rollConvention: 'Venue front month',
  calibrationAvailable: false,
};

const event = {
  ticker: EVENT_TICKER,
  title: 'WTI price today',
  eventDate: '2026-07-21',
  closeTime: '2026-07-21T18:30:00.000Z',
  observationTime: '2026-07-21T18:30:00.000Z',
  expectedExpirationTime: '2026-07-21T18:35:00.000Z',
  settlementSource: { name: 'ICE WTI settlement' },
  mutuallyExclusive: false,
  availableOnBrokers: true,
  totalMarketCount: 2,
  quotedMarketCount: 2,
  completeBookCount: 2,
};

const liveResponse = {
  ok: true,
  cadence: 'daily',
  seriesTicker: 'KXWTI',
  fetchedAt: '2026-07-21T18:30:30.000Z',
  historicalOnly: false,
  executable: false,
  event,
  settlementMapping,
  markets: [
    market(83.99),
    market(84.99, {
      yesBid: 0.43,
      yesAsk: 0.45,
      noBid: 0.54,
      noAsk: 0.56,
      volume24h: 18000,
    }),
  ],
  venue: { name: 'Kalshi', source: 'kalshi_trade_api_v2', snapshotType: 'direct_venue', volume24h: 30000, openInterest: 9000 },
  policy: { researchOnly: true },
};

const riskHistory = [
  { ticker: 'WTIC', date: '2026-07-18', lrr: 70, hrr: 85, trend: 'BEARISH' },
  { ticker: 'WTIC', date: '2026-07-21', lrr: 71.25, hrr: 84.5, trend: 'BEARISH' },
];

const currentOvx = {
  lastUpdated: '2026-07-21T18:25:00.000Z',
  OVX: {
    lastPx: 64.45,
    asOf: '2026-07-21T18:25:00.000Z',
    availability: 'available',
    freshness: 'current',
    source: 'Cboe Global Indices',
    sourceLabel: 'Cboe delayed',
    quoteMode: 'delayed',
  },
};

const settledResponse = {
  ok: true,
  historicalOnly: true,
  executable: false,
  seriesTicker: 'KXWTI',
  event,
  settlementValue: 84.25,
  settlementTime: '2026-07-21T18:31:00.000Z',
  settlementMapping,
  markets: [
    market(83.99, { result: 'yes', settlementPayout: 1 }),
    market(84.99, { result: 'no', settlementPayout: 0 }),
  ],
};

const recentResponse = {
  ok: true,
  cadence: 'daily',
  seriesTicker: 'KXWTI',
  historicalOnly: true,
  executable: false,
  sessions: [{
    eventTicker: EVENT_TICKER,
    eventDate: '2026-07-21',
    closeTime: '2026-07-21T18:30:00.000Z',
    settlementTime: '2026-07-21T18:31:00.000Z',
    settlementValue: 84.25,
    frontMonthContract: 'CLU26',
    contractMonth: '2026-09',
    marketCount: 2,
    historicalOnly: true,
    executable: false,
    snapshotType: 'settled_outcome',
    venue: { name: 'Kalshi', source: 'kalshi_trade_api_v2', snapshotType: 'settled_outcome' },
  }],
};

function arrange({ live = liveResponse, settled = settledResponse, recent = recentResponse, history = riskHistory, volatility = currentOvx } = {}) {
  if (live instanceof Error) predictionMarketsIngestService.getWtiWorkbench.mockRejectedValue(live);
  else predictionMarketsIngestService.getWtiWorkbench.mockResolvedValue(live);
  if (settled instanceof Error) predictionMarketsIngestService.getLastSettledWtiSession.mockRejectedValue(settled);
  else predictionMarketsIngestService.getLastSettledWtiSession.mockResolvedValue(settled);
  if (recent instanceof Error) predictionMarketsIngestService.getRecentSettledWtiSessions.mockRejectedValue(recent);
  else predictionMarketsIngestService.getRecentSettledWtiSessions.mockResolvedValue(recent);
  if (history instanceof Error) MarketDataService.getRiskRangeHistory.mockRejectedValue(history);
  else MarketDataService.getRiskRangeHistory.mockResolvedValue(history);
  if (volatility instanceof Error) MarketDataService.getVolatilitySnapshot.mockRejectedValue(volatility);
  else MarketDataService.getVolatilitySnapshot.mockResolvedValue(volatility);
}

describe('WtiWorkbench', () => {
  let nowSpy;

  beforeEach(() => {
    jest.clearAllMocks();
    resetSessionResourceStore();
    window.sessionStorage.clear();
    nowSpy = jest.spyOn(Date, 'now').mockReturnValue(NOW);
    arrange();
  });

  afterEach(() => {
    nowSpy.mockRestore();
  });

  test('renders a complete native Daily ladder, factual context, payout arithmetic, and exact-event positions', async () => {
    const sharedPositionsState = {
      status: 'live',
      positions: [
        { accountId: 'U123', localSymbol: `${EVENT_TICKER}-T84.99_YES`, quantity: 7, avgCost: 0.42, costBasis: 2.94 },
        { accountId: 'U123', localSymbol: 'KXWTIW-26JUL2414-B84.50_YES', quantity: 3, avgCost: 0.5 },
      ],
    };
    render(<WtiWorkbench cadence="daily" sharedPositionsState={sharedPositionsState} />);

    const ladder = await screen.findByRole('table', { name: 'daily WTI contract ladder' });
    expect(within(ladder).getByRole('columnheader', { name: 'Above threshold' })).toBeInTheDocument();
    expect(within(ladder).getByText('Above $83.99')).toBeInTheDocument();
    expect(within(ladder).getByText('Above $84.99')).toBeInTheDocument();
    expect(screen.getByText(/KXWTI · daily “Above \$X” contracts/i)).toBeInTheDocument();
    expect(within(ladder).getAllByText('64¢').length).toBeGreaterThan(0);
    expect(within(ladder).getAllByText('35¢').length).toBeGreaterThan(0);
    expect(screen.getByText('$71.25')).toBeInTheDocument();
    expect(screen.getByText('$84.50')).toBeInTheDocument();
    expect(screen.getByText('64.45')).toBeInTheDocument();
    expect(screen.getByText('Cboe delayed · delayed')).toBeInTheDocument();
    expect(screen.getByText(`${EVENT_TICKER}-T84.99_YES`)).toBeInTheDocument();
    expect(screen.queryByText('KXWTIW-26JUL2414-B84.50_YES')).not.toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Selected WTI contract payout arithmetic' })).toBeInTheDocument();
    expect(screen.getByText(/no fair odds, model edge, sizing, recommendation, or order entry/i)).toBeInTheDocument();
    expect(screen.getByText(/no WTI\/CL equity substitute/i)).toBeInTheDocument();
  });

  test('requests a cadence change from the embedded Daily/Weekly switch', async () => {
    const onCadenceChange = jest.fn();
    render(<WtiWorkbench cadence="daily" onCadenceChange={onCadenceChange} />);
    await screen.findByRole('table', { name: 'daily WTI contract ladder' });

    fireEvent.click(screen.getByRole('button', { name: 'Weekly' }));

    expect(onCadenceChange).toHaveBeenCalledWith('weekly');
    expect(predictionMarketsIngestService.getWtiWorkbench).toHaveBeenCalledWith('daily');
  });

  test('offers a back button that returns to the prediction-markets overview', async () => {
    const onBack = jest.fn();
    render(<WtiWorkbench cadence="daily" onBack={onBack} />);
    await screen.findByRole('table', { name: 'daily WTI contract ladder' });

    fireEvent.click(screen.getByRole('button', { name: 'Back to prediction markets overview' }));

    expect(onBack).toHaveBeenCalledTimes(1);
  });

  test('keeps the header, switch, Contracts card, and Details card usable when all WTI sources fail', async () => {
    arrange({
      live: new Error('Daily event unavailable'),
      settled: new Error('Settled archive unavailable'),
      recent: new Error('Recent archive unavailable'),
      history: new Error('Risk Range history offline'),
      volatility: new Error('OVX provider offline'),
    });
    render(<WtiWorkbench cadence="daily" />);

    expect(await screen.findByText('WTI contracts unavailable')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'WTI Prediction Markets' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Daily' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Weekly' })).toBeEnabled();
    expect(screen.getByRole('heading', { name: 'Contracts' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Exposure & settlement details' })).toBeInTheDocument();
    expect(screen.getByText('WTI details unavailable')).toBeInTheDocument();
    expect(screen.getAllByText(/Daily event unavailable|No verified live or settled/i).length).toBeGreaterThan(0);
  });

  test('uses a verified settled fallback without leaking quote fields or current OVX into history', async () => {
    arrange({ live: new Error('No active Daily books') });
    render(<WtiWorkbench cadence="daily" sharedPositionsState={{ status: 'live', positions: [] }} />);

    const settledTable = await screen.findByRole('table', { name: 'Settled daily WTI outcomes' });
    expect(screen.getByText(/Showing the most recent fully verified settlement/i)).toBeInTheDocument();
    expect(within(settledTable).getByText('YES')).toBeInTheDocument();
    expect(within(settledTable).getByText('NO')).toBeInTheDocument();
    expect(within(settledTable).queryByText('64¢')).not.toBeInTheDocument();
    expect(screen.getByText('Historical OVX snapshots are not available.')).toBeInTheDocument();
    expect(screen.getByText('Historical outcome only. Live bids, asks, depth, recommendations, and execution are intentionally absent.')).toBeInTheDocument();
  });

  test('keeps live contracts visible when exact-date WTIC and current OVX are independently unavailable', async () => {
    arrange({
      settled: null,
      recent: { historicalOnly: true, sessions: [] },
      history: [{ ticker: 'WTIC', date: '2026-07-18', lrr: 70, hrr: 85 }],
      volatility: { OVX: { ...currentOvx.OVX, freshness: 'stale' } },
    });
    render(<WtiWorkbench cadence="daily" />);

    expect(await screen.findByRole('table', { name: 'daily WTI contract ladder' })).toBeInTheDocument();
    expect(screen.getByText(/No date-matched WTIC Risk Range is available for 2026-07-21/)).toBeInTheDocument();
    expect(screen.getByText('A fresh current-session OVX reference is unavailable.')).toBeInTheDocument();
    expect(screen.queryByText(/Showing the most recent fully verified settlement/i)).not.toBeInTheDocument();
  });

  test('keeps a one-minute-old OVX reference visible without D yet', async () => {
    arrange({
      volatility: {
        OVX: {
          ...currentOvx.OVX,
          availability: 'reference',
          freshness: 'refresh-delayed',
          refreshDelayed: true,
          lastVerifiedAt: '2026-07-21T18:30:00.000Z',
          retainedUntil: '2026-07-21T19:00:00.000Z',
        },
      },
    });
    render(<WtiWorkbench cadence="daily" />);

    expect(await screen.findByRole('table', { name: 'daily WTI contract ladder' })).toBeInTheDocument();
    const value = screen.getByText('64.45');
    expect(value).toBeInTheDocument();
    expect(screen.queryByRole('button', {
      name: /Refresh delayed · last verified 2026-07-21T18:30:00.000Z/,
    })).not.toBeInTheDocument();
    expect(screen.queryByText('REFRESH DELAYED')).not.toBeInTheDocument();
    expect(screen.getByText(/Cboe delayed · delayed · last verified/)).toBeInTheDocument();
  });

  test('marks zero native depth incomplete without hiding direct per-side payout arithmetic', async () => {
    arrange({
      live: {
        ...liveResponse,
        markets: [
          market(83.99, { yesAskSize: 0, nativeBook: { yesPrices: true, noPrices: true, yesDepth: false, noDepth: false, complete: false, derivedFields: [] }, volume24h: 30000 }),
          market(84.99, { yesBidSize: 0, nativeBook: { yesPrices: true, noPrices: true, yesDepth: false, noDepth: false, complete: false, derivedFields: [] } }),
        ],
      },
    });
    render(<WtiWorkbench cadence="daily" />);
    const ladder = await screen.findByRole('table', { name: 'daily WTI contract ladder' });

    fireEvent.click(within(ladder).getByRole('button', { name: 'Inspect Above $83.99' }));

    expect(within(ladder).getAllByText('INCOMPLETE')).toHaveLength(2);
    const payoutTable = screen.getByRole('table', { name: 'Selected WTI contract payout arithmetic' });
    expect(within(payoutTable).getByText('66¢')).toBeInTheDocument();
    expect(within(payoutTable).getByText('35¢')).toBeInTheDocument();
    expect(within(payoutTable).getByText('$0.34')).toBeInTheDocument();
    expect(within(payoutTable).getByText('$0.65')).toBeInTheDocument();
  });
});
