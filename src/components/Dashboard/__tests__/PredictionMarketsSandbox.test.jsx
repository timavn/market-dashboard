import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import predictionMarketsIngestService from '../../../services/api/predictionMarketsIngestService';
import { MarketDataService } from '../../../services/api/marketDataService';
import PredictionMarketsSandbox, { resolveVerifiedLiveSpxQuote } from '../PredictionMarketsSandbox';

jest.mock('../../../services/api/predictionMarketsIngestService', () => ({
  __esModule: true,
  default: {
    getSpxCloseWorkbench: jest.fn(),
    getLastSettledSpxCloseSession: jest.fn(),
    getRecentSettledSpxCloseSessions: jest.fn(),
  },
}));

jest.mock('../../../services/api/marketDataService', () => ({
  MarketDataService: {
    getProviderStatus: jest.fn(),
    getQuotes: jest.fn(),
    getRiskRanges: jest.fn(),
    getRiskRangeHistory: jest.fn(),
    getPortfolioPredictionMarketPositions: jest.fn(),
    getHedgeyeSnapshot: jest.fn(),
    getUsdCorrelations: jest.fn(),
    getVolatilitySnapshot: jest.fn(),
    getSecurityRiskMetrics: jest.fn(),
  },
}));

const eventCloseTime = '2026-07-17T20:00:00.000Z';

const market = ({
  ticker,
  threshold,
  yesBid,
  yesAsk,
  yesBidSize,
  yesAskSize,
  noBid,
  noAsk,
  volume24h,
  openInterest,
}) => ({
  ticker,
  eventTicker: 'KXINXU-26JUL17H1600',
  seriesTicker: 'KXINXU',
  title: `Will the S&P 500 close above ${threshold}?`,
  threshold,
  closeTime: eventCloseTime,
  status: 'active',
  yesBid,
  yesAsk,
  yesBidSize,
  yesAskSize,
  noBid,
  noAsk,
  volume24h,
  openInterest,
});

const liveResponse = {
  ok: true,
  fetchedAt: '2026-07-17T18:30:00.000Z',
  provider: {
    name: 'Kalshi',
    source: 'direct_venue_snapshot',
    status: 'live',
  },
  event: {
    ticker: 'KXINXU-26JUL17H1600',
    seriesTicker: 'KXINXU',
    title: 'S&P 500 closing value at 4 p.m. ET',
    closeTime: eventCloseTime,
  },
  venue: {
    volume24h: 12450,
    openInterest: 8320,
  },
  ibkr: {
    connected: true,
    executionVerified: false,
  },
  policy: {
    researchOnly: true,
    recommendationAvailable: false,
  },
  markets: [
    market({
      ticker: 'KXINXU-26JUL17H1600-T7499.99',
      threshold: 7500,
      yesBid: 0.63,
      yesAsk: 0.66,
      yesBidSize: 240,
      yesAskSize: 180,
      noBid: 0.33,
      noAsk: 0.36,
      volume24h: 3200,
      openInterest: 2100,
    }),
    market({
      ticker: 'KXINXU-26JUL17H1600-T7524.99',
      threshold: 7525,
      yesBid: 0.47,
      yesAsk: 0.5,
      yesBidSize: 130,
      yesAskSize: 145,
      noBid: 0.49,
      noAsk: 0.52,
      volume24h: 2800,
      openInterest: 1900,
    }),
    market({
      ticker: 'KXINXU-26JUL17H1600-T7549.99',
      threshold: 7550,
      yesBid: 0.29,
      yesAsk: 0.32,
      yesBidSize: 95,
      yesAskSize: 110,
      noBid: 0.67,
      noAsk: 0.7,
      volume24h: 1750,
      openInterest: 1260,
    }),
  ],
};

const sameDayRiskRange = {
  SPX: {
    lrr: 7500,
    hrr: 7550,
    trend: 'BULLISH',
    date: '2026-07-17',
    timestamp: '2026-07-17T11:15:00.000Z',
  },
};

const currentMomoWithoutSpxTrade = {
  snapshotType: 'momo-tracker',
  date: '2026-07-17',
  data: {
    stocks: {
      NDX: { trend: 'BULLISH' },
    },
  },
};

const currentUsdCorrelationResponse = {
  calculationDate: '2026-07-17',
  timestamp: '2026-07-17T18:25:00.000Z',
  source: 'DXY / SPX daily log returns',
  sourceStatus: 'current',
  correlations: {
    SPX: {
      '15D': -0.61,
      '30D': -0.72,
      '90D': -0.58,
    },
  },
};

const currentVolatilityResponse = {
  lastUpdated: '2026-07-17T18:26:00.000Z',
  VIX: {
    lastPx: 17.4,
    asOf: '2026-07-17T18:26:00.000Z',
    availability: 'available',
    freshness: 'current',
    source: 'ibkr',
    sourceLabel: 'IBKR live',
    quoteMode: 'live',
  },
};

const spxPriceStructureResponse = ({
  asOf = '2026-07-16',
  fetchedAt = '2026-07-17T18:27:00.000Z',
  score = 5,
  highScore = 3,
  highEvent = 'HH + ATH',
  lowScore = 2,
  lowEvent = 'HL',
} = {}) => ({
  status: 'available',
  source: 'Yahoo Finance chart API',
  asOf,
  generatedAt: fetchedAt,
  requestedSymbols: ['SPX'],
  rows: {
    SPX: {
      symbol: 'SPX',
      status: 'available',
      source: 'Yahoo Finance chart API',
      asOf,
      observations: 24752,
      priceStructure: {
        status: 'available',
        reason: null,
        asOf,
        observations: 24752,
        score,
        highLeg: {
          score: highScore,
          event: highEvent,
          eventCredit: highEvent === 'HH + ATH' ? 2 : highEvent === 'HH' ? 1 : -1,
          appliedCredit: highEvent === 'HH + ATH' ? 2 : highEvent === 'HH' ? 1 : -1,
          reversal: false,
        },
        lowLeg: {
          score: lowScore,
          event: lowEvent,
          eventCredit: lowEvent === 'LL + ATL' ? -2 : lowEvent === 'LL' ? -1 : 1,
          appliedCredit: lowEvent === 'LL + ATL' ? -2 : lowEvent === 'LL' ? -1 : 1,
          reversal: false,
        },
        priceBasis: 'completed SPX cash-index daily high and low',
        ruleVersion: 'spx-structure-run-v1',
      },
      provenance: {
        provider: 'Yahoo Finance',
        security: {
          requestedSymbol: 'SPX',
          yahooSymbol: '^GSPC',
          fetchedAt,
          cacheStatus: 'miss',
          cacheAgeSeconds: 0,
        },
      },
      historicalOnly: true,
      executable: false,
    },
  },
  cache: {
    status: 'miss',
    ageSeconds: 0,
    ttlSeconds: 3600,
  },
  historicalOnly: true,
  executable: false,
});

const priorSessionBullishPriceStructure = spxPriceStructureResponse();
const fridayBearishPriceStructure = spxPriceStructureResponse({
  asOf: '2026-07-17',
  fetchedAt: '2026-07-18T17:00:00.000Z',
  score: -2,
  highScore: -1,
  highEvent: 'LH',
  lowScore: -1,
  lowEvent: 'LL',
});

const bullishSpxTradeSnapshot = {
  snapshotType: 'momo-tracker',
  date: '2026-07-17',
  data: {
    stocks: {
      SPX: {
        trade: 'BULLISH',
        date: '2026-07-17',
      },
    },
  },
};

const bullishMarketStructureSnapshot = {
  snapshotType: 'market-structure',
  date: '2026-07-17',
  scrapedAt: '2026-07-17T12:30:00.000Z',
  data: {
    SPX: {
      date: '2026-07-17',
      gammaExposure: 'Positive',
      gammaThrottle: 4.03,
      realizedVol10d: 9.58,
      systematicFlowRisk: 'Bullish',
      pvBandRiskReward: 'Long',
      strategicAllocation: 'Risk On',
    },
  },
};

const settledResponse = {
  ok: true,
  historicalOnly: true,
  executable: false,
  fetchedAt: '2026-07-18T17:00:00.000Z',
  event: {
    ticker: 'KXINXU-26JUL17H1600',
    title: 'S&P price on Jul 17, 2026 at 4pm EDT?',
    closeTime: eventCloseTime,
    settlementTime: '2026-07-17T20:02:02.607345Z',
    marketCount: 4,
  },
  closeValue: 7457.67,
  venue: {
    snapshotType: 'settled_outcome',
    volumeTotal: 501263.01,
    volume24h: 344325.25,
    openInterest: 300898.55,
  },
  policy: {
    historicalOnly: true,
    executable: false,
    quotesAvailable: false,
  },
  markets: [
    { ticker: 'SETTLED-7445', eventTicker: 'KXINXU-26JUL17H1600', threshold: 7445, closeTime: eventCloseTime, result: 'yes', settlementPayout: 1, closeValue: 7457.67, volumeTotal: 11401.75, openInterest: 7267.1 },
    { ticker: 'SETTLED-7450', eventTicker: 'KXINXU-26JUL17H1600', threshold: 7450, closeTime: eventCloseTime, result: 'yes', settlementPayout: 1, closeValue: 7457.67, volumeTotal: 142743.81, openInterest: 113265.23 },
    { ticker: 'SETTLED-7455', eventTicker: 'KXINXU-26JUL17H1600', threshold: 7455, closeTime: eventCloseTime, result: 'yes', settlementPayout: 1, closeValue: 7457.67, volumeTotal: 30332.46, openInterest: 20308.22 },
    { ticker: 'SETTLED-7460', eventTicker: 'KXINXU-26JUL17H1600', threshold: 7460, closeTime: eventCloseTime, result: 'no', settlementPayout: 0, closeValue: 7457.67, volumeTotal: 44600.75, openInterest: 15732.97 },
  ],
};

const riskRangeHistory = [
  { date: '2026-07-16', lrr: 7464, hrr: 7598, trend: 'BULLISH' },
  { date: '2026-07-17', lrr: 7425, hrr: 7575, trend: 'BULLISH' },
];

const recentSettledResponse = {
  ok: true,
  historicalOnly: true,
  executable: false,
  sessions: [
    {
      eventTicker: 'KXINXU-26JUL17H1600',
      closeTime: eventCloseTime,
      closeValue: 7457.67,
      historicalOnly: true,
      executable: false,
      snapshotType: 'settled_outcome',
      venue: { volumeTotal: 501263.01, openInterest: 300898.55 },
    },
    {
      eventTicker: 'KXINXU-26JUL16H1600',
      closeTime: '2026-07-16T20:00:00.000Z',
      closeValue: 7534.31,
      historicalOnly: true,
      executable: false,
      snapshotType: 'settled_outcome',
      venue: { volumeTotal: 284112, openInterest: 180422 },
    },
  ],
};

function expectedNoLiveEventError() {
  const error = new Error('No broker-enabled live event');
  error.response = {
    status: 503,
    data: { code: 'SPX_EVENT_UNAVAILABLE', error: error.message },
  };
  return error;
}

describe('PredictionMarketsSandbox', () => {
  beforeEach(() => {
    predictionMarketsIngestService.getSpxCloseWorkbench.mockReset();
    predictionMarketsIngestService.getLastSettledSpxCloseSession.mockReset();
    predictionMarketsIngestService.getRecentSettledSpxCloseSessions.mockReset();
    MarketDataService.getProviderStatus.mockReset();
    MarketDataService.getQuotes.mockReset();
    MarketDataService.getRiskRanges.mockReset();
    MarketDataService.getRiskRangeHistory.mockReset();
    MarketDataService.getPortfolioPredictionMarketPositions.mockReset();
    MarketDataService.getHedgeyeSnapshot.mockReset();
    MarketDataService.getUsdCorrelations.mockReset();
    MarketDataService.getVolatilitySnapshot.mockReset();
    MarketDataService.getSecurityRiskMetrics.mockReset();

    predictionMarketsIngestService.getSpxCloseWorkbench.mockResolvedValue(liveResponse);
    predictionMarketsIngestService.getLastSettledSpxCloseSession.mockResolvedValue(settledResponse);
    predictionMarketsIngestService.getRecentSettledSpxCloseSessions.mockResolvedValue(recentSettledResponse);
    MarketDataService.getProviderStatus.mockResolvedValue({
      timestamp: new Date().toISOString(),
      statusRefreshDelayed: false,
      ibkr: { connected: true, status: 'connected' },
    });
    MarketDataService.getQuotes.mockResolvedValue({
      SPX: {
        symbol: 'SPX',
        source: 'ibkr',
        dataType: 'live',
        last: 7540,
        price: '7540.00',
        timestamp: new Date().toISOString(),
        entitlementStatus: 'live',
      },
    });
    MarketDataService.getRiskRanges.mockResolvedValue(sameDayRiskRange);
    MarketDataService.getRiskRangeHistory.mockResolvedValue(riskRangeHistory);
    MarketDataService.getPortfolioPredictionMarketPositions.mockResolvedValue({
      meta: { source: 'ibkr_live' },
      positions: [],
    });
    MarketDataService.getHedgeyeSnapshot.mockImplementation(async (snapshotType) => (
      snapshotType === 'momo-tracker' ? currentMomoWithoutSpxTrade : null
    ));
    MarketDataService.getUsdCorrelations.mockResolvedValue(currentUsdCorrelationResponse);
    MarketDataService.getVolatilitySnapshot.mockResolvedValue(currentVolatilityResponse);
    MarketDataService.getSecurityRiskMetrics.mockResolvedValue(priorSessionBullishPriceStructure);
  });

  test('renders the live cash-SPX close ladder and keeps betting controls fail-closed', async () => {
    render(<PredictionMarketsSandbox onClose={jest.fn()} portfolioData={{ accountId: 'U25779973' }} />);

    const workbench = screen.getByTestId('spx-close-workbench');
    const ladder = await within(workbench).findByRole('table', { name: 'S&P 500 cash close threshold ladder' });
    expect(within(workbench).getByRole('heading', { name: 'S&P 500 Close' })).toBeInTheDocument();
    expect(within(workbench).getByText('Cash S&P 500 Index · Settlement 4:00 PM ET')).toBeInTheDocument();
    expect(within(workbench).getByText('DIRECT VENUE · RESEARCH ONLY')).toBeInTheDocument();
    expect(within(workbench).getByRole('heading', { name: 'Contracts' })).toBeInTheDocument();
    expect(within(workbench).getByRole('heading', { name: 'Payday' })).toBeInTheDocument();
    expect(within(workbench).getByRole('table', { name: 'Selected SPX contract settlement analysis' })).toBeInTheDocument();
    expect(within(workbench).getByLabelText('Daily SPX Risk Ranges and cash closes')).toBeInTheDocument();
    expect(predictionMarketsIngestService.getRecentSettledSpxCloseSessions).toHaveBeenCalledWith(13);

    expect(within(ladder).getByRole('button', { name: 'Inspect SPX above 7,525' })).toBeInTheDocument();
    expect(within(ladder).getByText('47¢')).toBeInTheDocument();
    expect(within(ladder).getByText('52¢')).toBeInTheDocument();
    const marker = within(ladder).getByTestId('spx-live-marker');
    const rows = within(ladder).getAllByRole('row');
    const lowerStrikeRow = within(ladder).getByRole('row', { name: /SPX ≥ 7,525/ });
    const upperStrikeRow = within(ladder).getByRole('row', { name: /SPX ≥ 7,550/ });
    const markerIndex = rows.indexOf(marker);
    expect(marker).toHaveTextContent('LIVE SPX 7,540');
    expect(marker).toHaveAttribute('aria-label', expect.stringMatching(/^Live S&P 500 cash index 7,540, between strikes 7,525 and 7,550, as of /));
    expect(markerIndex).toBe(rows.indexOf(lowerStrikeRow) + 1);
    expect(rows.indexOf(upperStrikeRow)).toBe(markerIndex + 1);

    expect(within(workbench).queryByText(/WTI|ForecastEx/i)).not.toBeInTheDocument();
    expect(within(workbench).queryByRole('button', { name: /trade|buy|sell|edge|kelly|size/i })).not.toBeInTheDocument();
    expect(within(workbench).queryByRole('spinbutton')).not.toBeInTheDocument();
    expect(within(workbench).queryByRole('textbox')).not.toBeInTheDocument();
  });

  test.each([
    ['delayed Yahoo fallback', { source: 'yahoo', dataType: 'delayed' }, 0, ''],
    ['frozen IBKR value', { source: 'ibkr', dataType: 'frozen' }, 0, ''],
    ['stale IBKR timestamp', { source: 'ibkr', dataType: 'live' }, 120000, ''],
    ['cache-only warning', { source: 'ibkr', dataType: 'live' }, 0, 'cache_only'],
    ['mock warning', { source: 'ibkr', dataType: 'live' }, 0, 'mock fixture'],
    ['seed warning', { source: 'ibkr', dataType: 'live' }, 0, 'seed value'],
  ])('rejects a %s for the green marker', (_label, quoteFields, quoteAgeMs, warning) => {
    const now = Date.parse('2026-07-17T18:30:00.000Z');
    const providerStatus = {
      timestamp: new Date(now).toISOString(),
      statusRefreshDelayed: false,
      ibkr: { connected: true, status: 'connected' },
    };
    const result = resolveVerifiedLiveSpxQuote({
      SPX: {
        symbol: 'SPX',
        last: 7540,
        timestamp: new Date(now - quoteAgeMs).toISOString(),
        entitlementStatus: 'live',
        warning,
        ...quoteFields,
      },
    }, providerStatus, now);

    expect(result).toMatchObject({ status: 'unavailable', price: null });
  });

  test('requires current connected provider status and an actual SPX last trade', () => {
    const now = Date.parse('2026-07-17T18:30:00.000Z');
    const quote = {
      SPX: {
        symbol: 'SPX',
        source: 'ibkr',
        dataType: 'live',
        last: 7540,
        timestamp: new Date(now).toISOString(),
        entitlementStatus: 'live',
      },
    };
    const currentStatus = {
      timestamp: new Date(now).toISOString(),
      statusRefreshDelayed: false,
      ibkr: { connected: true, status: 'connected' },
    };

    expect(resolveVerifiedLiveSpxQuote(quote, currentStatus, now)).toMatchObject({ status: 'live', price: 7540 });
    expect(resolveVerifiedLiveSpxQuote(quote, { ...currentStatus, statusRefreshDelayed: true }, now)).toMatchObject({ status: 'unavailable', price: null });
    expect(resolveVerifiedLiveSpxQuote(quote, { ...currentStatus, ibkr: { connected: false } }, now)).toMatchObject({ status: 'unavailable', price: null });
    expect(resolveVerifiedLiveSpxQuote({ SPX: { ...quote.SPX, last: null, price: '7540.00' } }, currentStatus, now)).toMatchObject({ status: 'unavailable', price: null });
  });

  test('blocks the production-like setup when SPX Trade and market structure are missing while preserving current USD and VIX reads', async () => {
    render(<PredictionMarketsSandbox onClose={jest.fn()} />);

    const workbench = screen.getByTestId('spx-close-workbench');
    const ledger = await within(workbench).findByRole('table', { name: 'SPX confluence score ledger' });
    const usdRow = within(ledger).getByRole('row', { name: /USD linkage strength/ });
    const vixRow = within(ledger).getByRole('row', { name: /VIX regime/ });

    expect(within(workbench).getByText('NOT ELIGIBLE')).toBeInTheDocument();
    expect(within(workbench).getAllByText(/—\s*\/\s*8/).length).toBeGreaterThan(0);
    expect(usdRow).toHaveTextContent('30D r −0.720');
    expect(usdRow).toHaveTextContent('2/2');
    expect(vixRow).toHaveTextContent('17.40 · Investable');
    expect(vixRow).toHaveTextContent('—/1');
    expect(within(workbench).getByText(/Published SPX Trade is unavailable/)).toBeInTheDocument();
    expect(within(workbench).getByText(/structure input unavailable or wrong-date/)).toBeInTheDocument();
  });

  test('scores an eligible same-day bullish Trade, Trend, and complete market-structure setup transparently', async () => {
    MarketDataService.getHedgeyeSnapshot.mockImplementation(async (snapshotType) => {
      if (snapshotType === 'momo-tracker') return bullishSpxTradeSnapshot;
      if (snapshotType === 'market-structure') return bullishMarketStructureSnapshot;
      return null;
    });

    render(<PredictionMarketsSandbox onClose={jest.fn()} />);

    const workbench = screen.getByTestId('spx-close-workbench');
    const ledger = await within(workbench).findByRole('table', { name: 'SPX confluence score ledger' });
    const geometryRow = within(ledger).getByRole('row', { name: /Contract geometry/ });
    const usdRow = within(ledger).getByRole('row', { name: /USD linkage strength/ });
    const gammaRow = within(ledger).getByRole('row', { name: /Gamma \/ threshold fit/ });
    const vixRow = within(ledger).getByRole('row', { name: /VIX regime/ });
    const systematicRow = within(ledger).getByRole('row', { name: /Systematic flow/ });
    const pvRow = within(ledger).getByRole('row', { name: /PV Band R\/R/ });
    const allocationRow = within(ledger).getByRole('row', { name: /Strategic allocation/ });
    const structureRow = within(ledger).getByRole('row', { name: /Structure breadth/ });

    expect(within(workbench).getByText('ELIGIBLE')).toBeInTheDocument();
    expect(within(workbench).getAllByText('7 / 8').length).toBeGreaterThan(0);
    expect(within(workbench).getByText('HIGH INDICATOR CONFLUENCE')).toBeInTheDocument();
    expect(within(workbench).getByText('RESEARCH ONLY · IBKR EXECUTION NOT VERIFIED')).toBeInTheDocument();
    expect(within(workbench).getByText(/Price hurdle.*requires a hit rate above 50% before fees/)).toBeInTheDocument();
    expect(geometryRow).toHaveTextContent('K 7,525 · 50% of RR resolves YES');
    expect(geometryRow).toHaveTextContent('1/2');
    expect(usdRow).toHaveTextContent('30D r −0.720 · inverse · 15/30/90 stable');
    expect(usdRow).toHaveTextContent('2/2');
    expect(gammaRow).toHaveTextContent('Positive · throttle +4.03 · 10D rVol 9.58');
    expect(gammaRow).toHaveTextContent('1/1');
    expect(vixRow).toHaveTextContent('17.40 · Investable');
    expect(vixRow).toHaveTextContent('1/1');
    expect(systematicRow).toHaveTextContent('Bullish');
    expect(systematicRow).toHaveTextContent('ALIGNED');
    expect(pvRow).toHaveTextContent('Long');
    expect(pvRow).toHaveTextContent('ALIGNED');
    expect(allocationRow).toHaveTextContent('Risk On');
    expect(allocationRow).toHaveTextContent('ALIGNED');
    expect(structureRow).toHaveTextContent('3 aligned · 0 conflict');
    expect(structureRow).toHaveTextContent('2/2');
  });

  test('shows the completed cash-index HH / HL run as a signed reference without changing the 0–8 confluence total', async () => {
    MarketDataService.getHedgeyeSnapshot.mockImplementation(async (snapshotType) => {
      if (snapshotType === 'momo-tracker') return bullishSpxTradeSnapshot;
      if (snapshotType === 'market-structure') return bullishMarketStructureSnapshot;
      return null;
    });

    render(<PredictionMarketsSandbox onClose={jest.fn()} />);

    const workbench = screen.getByTestId('spx-close-workbench');
    const ledger = await within(workbench).findByRole('table', { name: 'SPX confluence score ledger' });
    const priceStructureRow = within(ledger).getByRole('row', { name: /HH \/ HL accumulator/ });

    await waitFor(() => expect(priceStructureRow).toHaveTextContent('High +3 (HH + ATH) · Low +2 (HL) · Net +5'));
    expect(priceStructureRow).toHaveTextContent('REF +5');
    expect(priceStructureRow).toHaveTextContent('REFERENCE · NOT IN 0–8');
    expect(priceStructureRow).toHaveTextContent('Continuation ±1 · first reversal resets leg · ATH/ATL bonus ±1');
    expect(within(workbench).getAllByText('7 / 8').length).toBeGreaterThan(0);
    expect(within(workbench).queryByText('12 / 8')).not.toBeInTheDocument();
    expect(MarketDataService.getSecurityRiskMetrics).toHaveBeenCalledWith(
      ['SPX'],
      { forceRefresh: true },
    );
  });

  test('never backfills current confluence inputs into a historical session', async () => {
    predictionMarketsIngestService.getSpxCloseWorkbench.mockRejectedValue(expectedNoLiveEventError());
    MarketDataService.getHedgeyeSnapshot.mockImplementation(async (snapshotType) => {
      if (snapshotType === 'momo-tracker') {
        return {
          ...bullishSpxTradeSnapshot,
          date: '2026-07-18',
          data: { stocks: { SPX: { trade: 'BULLISH', date: '2026-07-18' } } },
        };
      }
      if (snapshotType === 'market-structure') {
        return {
          ...bullishMarketStructureSnapshot,
          date: '2026-07-18',
          data: { SPX: { ...bullishMarketStructureSnapshot.data.SPX, date: '2026-07-18' } },
        };
      }
      return null;
    });
    MarketDataService.getUsdCorrelations.mockResolvedValue({
      ...currentUsdCorrelationResponse,
      calculationDate: '2026-07-18',
    });
    MarketDataService.getVolatilitySnapshot.mockResolvedValue({
      ...currentVolatilityResponse,
      lastUpdated: '2026-07-18T18:26:00.000Z',
      VIX: {
        ...currentVolatilityResponse.VIX,
        asOf: '2026-07-18T18:26:00.000Z',
      },
    });

    render(<PredictionMarketsSandbox onClose={jest.fn()} />);

    const workbench = screen.getByTestId('spx-close-workbench');
    const ledger = await within(workbench).findByRole('table', { name: 'SPX confluence score ledger' });
    const usdRow = within(ledger).getByRole('row', { name: /USD linkage strength/ });
    const gammaRow = within(ledger).getByRole('row', { name: /Gamma \/ threshold fit/ });
    const vixRow = within(ledger).getByRole('row', { name: /VIX regime/ });
    const structureRow = within(ledger).getByRole('row', { name: /Structure breadth/ });

    expect(within(workbench).getByText('NOT ELIGIBLE')).toBeInTheDocument();
    expect(within(workbench).getAllByText(/—\s*\/\s*8/).length).toBeGreaterThan(0);
    expect(usdRow).toHaveTextContent('—/2');
    expect(usdRow).not.toHaveTextContent('−0.720');
    expect(usdRow).toHaveTextContent('UNAVAILABLE');
    expect(gammaRow).toHaveTextContent('—/1');
    expect(gammaRow).not.toHaveTextContent('throttle +4.03');
    expect(gammaRow).toHaveTextContent('UNAVAILABLE');
    expect(vixRow).toHaveTextContent('—/1');
    expect(vixRow).not.toHaveTextContent('17.40');
    expect(vixRow).toHaveTextContent('UNAVAILABLE');
    expect(structureRow).toHaveTextContent('—/2');
    expect(structureRow).toHaveTextContent('UNAVAILABLE');
    expect(within(workbench).getByText(/Published SPX Trade is unavailable/)).toBeInTheDocument();
    expect(within(workbench).getByText(/usd input unavailable or wrong-date/)).toBeInTheDocument();
    expect(within(workbench).getByText(/volatility input unavailable or wrong-date/)).toBeInTheDocument();
    expect(within(workbench).getByText(/structure input unavailable or wrong-date/)).toBeInTheDocument();
    expect(within(workbench).getByText(/Historical indicator scoring is withheld/)).toBeInTheDocument();
  });

  test('renders Friday’s settled outcome as unmistakably historical when no live broker event exists', async () => {
    predictionMarketsIngestService.getSpxCloseWorkbench.mockRejectedValue(expectedNoLiveEventError());
    MarketDataService.getSecurityRiskMetrics.mockResolvedValue(fridayBearishPriceStructure);

    render(<PredictionMarketsSandbox onClose={jest.fn()} />);

    const workbench = screen.getByTestId('spx-close-workbench');
    const table = await within(workbench).findByRole('table', { name: 'Settled S&P 500 cash close threshold outcomes' });
    expect(within(workbench).getAllByText(/SETTLED · NOT TRADEABLE/).length).toBeGreaterThan(0);
    expect(within(workbench).getByRole('heading', { name: 'Contracts' })).toBeInTheDocument();
    expect(within(workbench).getByRole('heading', { name: 'Payday' })).toBeInTheDocument();
    expect(within(workbench).getAllByText('7,457.67').length).toBeGreaterThan(0);
    expect(within(workbench).getByRole('table', { name: 'Settled SPX contract payout analysis' })).toBeInTheDocument();
    expect(within(workbench).getByRole('table', { name: 'Recent SPX Risk Range settlement history' })).toBeInTheDocument();
    expect(within(table).getByRole('button', { name: 'Inspect settled SPX above 7,455' })).toBeInTheDocument();
    expect(within(table).getByRole('button', { name: 'Inspect settled SPX above 7,460' })).toBeInTheDocument();
    expect(within(table).getAllByText('YES').length).toBeGreaterThan(0);
    expect(within(table).getAllByText('NO').length).toBeGreaterThan(0);
    expect(within(workbench).getByRole('table', { name: 'Settled SPX contract payout analysis' })).toHaveTextContent('$0.00');

    expect(within(workbench).queryByText('DIRECT VENUE · RESEARCH ONLY')).not.toBeInTheDocument();
    expect(within(table).queryByRole('columnheader', { name: /bid|ask|depth/i })).not.toBeInTheDocument();
    expect(within(table).queryByText(/¢/)).not.toBeInTheDocument();
    expect(within(workbench).queryByRole('button', { name: /trade|buy|sell|edge|kelly|size/i })).not.toBeInTheDocument();
  });

  test('shows Friday’s signed HH / HL reference after settlement without retro-scoring it', async () => {
    predictionMarketsIngestService.getSpxCloseWorkbench.mockRejectedValue(expectedNoLiveEventError());
    MarketDataService.getSecurityRiskMetrics.mockResolvedValue(fridayBearishPriceStructure);

    render(<PredictionMarketsSandbox onClose={jest.fn()} />);

    const workbench = screen.getByTestId('spx-close-workbench');
    const ledger = await within(workbench).findByRole('table', { name: 'SPX confluence score ledger' });
    const priceStructureRow = within(ledger).getByRole('row', { name: /HH \/ HL accumulator/ });

    await waitFor(() => expect(priceStructureRow).toHaveTextContent('High −1 (LH) · Low −1 (LL) · Net −2'));
    expect(priceStructureRow).toHaveTextContent('REF −2');
    expect(priceStructureRow).toHaveTextContent('POST-CLOSE · NOT RETRO-SCORED');
    expect(priceStructureRow).toHaveTextContent('2026-07-17');
    expect(within(workbench).getAllByText(/—\s*\/\s*8/).length).toBeGreaterThan(0);
    expect(within(workbench).queryByText(/−2\s*\/\s*8/)).not.toBeInTheDocument();
  });

  test('clears a displayed HH / HL reference when its forced provider refresh fails', async () => {
    MarketDataService.getSecurityRiskMetrics
      .mockResolvedValueOnce(priorSessionBullishPriceStructure)
      .mockRejectedValueOnce(new Error('completed index history unavailable'));

    render(<PredictionMarketsSandbox onClose={jest.fn()} />);

    const workbench = screen.getByTestId('spx-close-workbench');
    const ledger = await within(workbench).findByRole('table', { name: 'SPX confluence score ledger' });
    const priceStructureRow = within(ledger).getByRole('row', { name: /HH \/ HL accumulator/ });
    await waitFor(() => expect(priceStructureRow).toHaveTextContent('Net +5'));

    fireEvent.click(within(workbench).getByRole('button', { name: 'Refresh SPX close workbench' }));

    await waitFor(() => expect(priceStructureRow).toHaveTextContent('UNAVAILABLE'));
    expect(priceStructureRow).not.toHaveTextContent('Net +5');
    expect(MarketDataService.getSecurityRiskMetrics).toHaveBeenCalledTimes(2);
  });

  test('falls back to the date-matched settled session when the live Risk Range is not ready', async () => {
    MarketDataService.getRiskRanges.mockResolvedValue({
      SPX: { ...sameDayRiskRange.SPX, date: '2026-07-16' },
    });

    render(<PredictionMarketsSandbox onClose={jest.fn()} />);

    expect((await screen.findAllByText(/SETTLED · NOT TRADEABLE/)).length).toBeGreaterThan(0);
    expect(screen.getByRole('table', { name: 'Settled S&P 500 cash close threshold outcomes' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Inspect SPX above 7,525' })).not.toBeInTheDocument();
  });

  test('does not attach a mismatched Risk Range to a historical session', async () => {
    predictionMarketsIngestService.getSpxCloseWorkbench.mockRejectedValue(expectedNoLiveEventError());
    MarketDataService.getRiskRangeHistory.mockResolvedValue([
      { date: '2026-07-16', lrr: 7464, hrr: 7598, trend: 'BULLISH' },
    ]);

    render(<PredictionMarketsSandbox onClose={jest.fn()} />);

    await screen.findByText('Contracts unavailable');
    const workbench = screen.getByTestId('spx-close-workbench');
    const contractsStatus = within(workbench).getByRole('status', { name: 'Contracts availability' });
    const analysisStatus = within(workbench).getByLabelText('Contract-dependent analysis status');

    expect(within(contractsStatus).getByText('Contracts unavailable')).toBeInTheDocument();
    expect(within(contractsStatus).getByText(/No date-matched Hedgeye SPX Risk Range/i)).toBeInTheDocument();
    expect(within(workbench).getByRole('heading', { name: 'Payday' })).toBeInTheDocument();
    expect(within(analysisStatus).getAllByText('Unavailable')).toHaveLength(3);
    expect(within(workbench).getByLabelText('Recent settled SPX Risk Ranges and cash closes')).toBeInTheDocument();
    expect(within(workbench).getByRole('button', { name: 'Refresh SPX close workbench' })).toBeInTheDocument();
    expect(within(workbench).getByRole('button', { name: 'Close SPX Close' })).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(within(workbench).queryByRole('button', { name: /Inspect (settled )?SPX above/i })).not.toBeInTheDocument();
    expect(within(workbench).queryByText('Daily SPX contract unavailable')).not.toBeInTheDocument();
  });

  test('shows no green price when IBKR is disconnected', async () => {
    MarketDataService.getProviderStatus.mockResolvedValue({
      timestamp: new Date().toISOString(),
      statusRefreshDelayed: false,
      ibkr: { connected: false, status: 'disconnected' },
    });

    render(<PredictionMarketsSandbox onClose={jest.fn()} />);

    const ladder = await screen.findByRole('table', { name: 'S&P 500 cash close threshold ladder' });
    expect(screen.getByText('LIVE SPX UNAVAILABLE')).toBeInTheDocument();
    expect(within(ladder).queryByTestId('spx-live-marker')).not.toBeInTheDocument();
    expect(MarketDataService.getQuotes).not.toHaveBeenCalled();
  });

  test('removes the last green marker as soon as a refresh reports IBKR offline', async () => {
    MarketDataService.getProviderStatus
      .mockResolvedValueOnce({
        timestamp: new Date().toISOString(),
        statusRefreshDelayed: false,
        ibkr: { connected: true, status: 'connected' },
      })
      .mockResolvedValueOnce({
        timestamp: new Date().toISOString(),
        statusRefreshDelayed: false,
        ibkr: { connected: false, status: 'disconnected' },
      });

    render(<PredictionMarketsSandbox onClose={jest.fn()} />);
    expect(await screen.findByTestId('spx-live-marker')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Refresh SPX close workbench' }));

    await waitFor(() => expect(screen.queryByTestId('spx-live-marker')).not.toBeInTheDocument());
    expect(await screen.findByText('LIVE SPX UNAVAILABLE')).toBeInTheDocument();
    expect(MarketDataService.getQuotes).toHaveBeenCalledTimes(1);
  });

  test('clears the displayed ladder when a manual live refresh fails', async () => {
    predictionMarketsIngestService.getSpxCloseWorkbench
      .mockResolvedValueOnce(liveResponse)
      .mockRejectedValueOnce(new Error('direct venue offline'));

    render(<PredictionMarketsSandbox onClose={jest.fn()} />);
    expect(await screen.findByRole('table', { name: 'S&P 500 cash close threshold ladder' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Refresh SPX close workbench' }));

    await screen.findByText('Contracts unavailable');
    const workbench = screen.getByTestId('spx-close-workbench');
    const contractsStatus = within(workbench).getByRole('status', { name: 'Contracts availability' });

    expect(within(contractsStatus).getByText('Contracts unavailable')).toBeInTheDocument();
    expect(within(contractsStatus).getByText('direct venue offline')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('table')).not.toBeInTheDocument());
    expect(within(workbench).queryByRole('button', { name: 'Inspect SPX above 7,525' })).not.toBeInTheDocument();
    expect(within(workbench).queryByTestId('spx-live-marker')).not.toBeInTheDocument();
    expect(within(workbench).queryByText('47¢')).not.toBeInTheDocument();
    expect(within(workbench).queryByRole('table', { name: 'Selected SPX contract settlement analysis' })).not.toBeInTheDocument();
    expect(within(workbench).getByRole('heading', { name: 'Payday' })).toBeInTheDocument();
    expect(within(workbench).getByRole('button', { name: 'Retry live scan' })).toBeInTheDocument();
    expect(within(workbench).getByRole('button', { name: 'Close SPX Close' })).toBeInTheDocument();
    expect(within(workbench).getByLabelText('Recent settled SPX Risk Ranges and cash closes')).toBeInTheDocument();
    expect(predictionMarketsIngestService.getSpxCloseWorkbench).toHaveBeenCalledTimes(2);
  });

  test('delegates closing to the dashboard panel owner', async () => {
    const onClose = jest.fn();
    render(<PredictionMarketsSandbox onClose={onClose} />);
    await screen.findByRole('table', { name: 'S&P 500 cash close threshold ladder' });

    fireEvent.click(screen.getByRole('button', { name: 'Close SPX Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
