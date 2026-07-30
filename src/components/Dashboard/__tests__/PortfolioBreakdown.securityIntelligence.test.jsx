import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import PortfolioBreakdown from '../PortfolioBreakdown';
import { MarketDataService } from '../../../services/api/marketDataService';

jest.mock('../../../services/api/marketDataService', () => ({
  MarketDataService: {
    getSecurityIntelligence: jest.fn(),
    getSecurityRiskMetrics: jest.fn(),
    getVolatilitySnapshot: jest.fn(),
    getUsdCorrelations: jest.fn(),
  },
}));

const getLedgerRowBySymbol = (symbol) => {
  const row = screen
    .getAllByRole('row')
    .find((candidate) => (
      candidate.classList.contains('pcv2-ledger-row')
      && within(candidate).queryByText(symbol)
    ));
  if (!row) {
    throw new Error(`Ledger row for ${symbol} not found`);
  }
  return row;
};

const getLedgerTables = () => screen
  .getAllByRole('table')
  .filter((table) => table.classList.contains('pcv2-ledger-table'));

const marketDate = () => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const read = (type) => parts.find((part) => part.type === type)?.value;
  const cursor = new Date(`${read('year')}-${read('month')}-${read('day')}T12:00:00Z`);
  while ([0, 6].includes(cursor.getUTCDay())) {
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return cursor.toISOString().slice(0, 10);
};

const priorDate = () => {
  const value = new Date(`${marketDate()}T12:00:00Z`);
  do {
    value.setUTCDate(value.getUTCDate() - 1);
  } while ([0, 6].includes(value.getUTCDay()));
  return value.toISOString().slice(0, 10);
};

const expectCellProvenance = (cell, expected) => {
  const accessibleProvenance = [
    cell?.getAttribute('title'),
    cell?.getAttribute('aria-label'),
  ].filter(Boolean).join(' · ');
  expect(accessibleProvenance).toEqual(expect.stringMatching(expected));
};

const portfolioData = {
  summary: { totalValue: 100000 },
  lastUpdated: 'first',
  holdings: [
    {
      symbol: 'GLD',
      accountId: 'U1',
      conid: '1001',
      description: 'Gold',
      marketValue: 10000,
      quantity: 50,
      price: 200,
    },
    {
      symbol: 'GLD',
      accountId: 'U2',
      conid: '1001',
      description: 'Gold',
      marketValue: 5000,
      quantity: 25,
      price: 200,
    },
    {
      symbol: 'NEM',
      accountId: 'U1',
      conid: '2002',
      description: 'Newmont',
      marketValue: 3000,
      quantity: 50,
      price: 60,
    },
  ],
  accountSummary: { netLiquidation: 100000 },
};

const liveSizingPortfolio = (overrides = {}) => {
  const observedAt = new Date().toISOString();
  const baseHolding = {
    ...portfolioData.holdings[0],
    positionSource: 'ibkr_live_session',
    priceSource: 'ibkr_live_last',
    priceState: 'live',
    marketValueState: 'live',
    priceObservedAt: observedAt,
    markPending: false,
    markFailure: null,
  };
  return {
    ...portfolioData,
    dataSource: 'ibkr_api',
    fromCache: false,
    liveSessionVerified: true,
    fetchedAt: observedAt,
    socketVerifiedAt: observedAt,
    dataQuality: {
      status: 'ok',
      markState: 'live',
    },
    accountSummary: {
      netLiquidation: 100000,
      source: 'ibkr_live_session',
      lastUpdated: observedAt,
      socketVerifiedAt: observedAt,
    },
    holdings: [baseHolding],
    ...overrides,
  };
};

const currentEnvelope = () => {
  const today = marketDate();
  return {
    schemaVersion: 1,
    marketDate: today,
    generatedAt: `${today}T15:00:00Z`,
    coverage: { state: 'complete', reasons: [] },
    products: [
      {
        id: 'the-call',
        label: 'The Call',
        status: 'indexed',
        marketDate: today,
        eventCount: 1,
      },
      {
        id: 'the-macro-show',
        label: 'Macro Show',
        status: 'indexed',
        marketDate: today,
        eventCount: 1,
      },
      {
        id: 'early-look',
        label: 'Early Look',
        status: 'indexed',
        marketDate: today,
        eventCount: 1,
      },
    ],
    bySymbol: {
      GLD: {
        symbol: 'GLD',
        state: 'complete',
        decision: {
          trade: {
            status: 'available',
            value: 'BUY',
            sourceId: 'momo-tracker',
            sourceLabel: 'Momo Tracker',
            sourceDate: today,
          },
          trend: {
            status: 'available',
            value: 'BULLISH',
            sourceId: 'risk-ranges',
            sourceLabel: 'Risk Ranges',
            sourceDate: today,
          },
          riskRange: {
            status: 'available',
            lrr: 2900,
            hrr: 3010,
            sourceId: 'risk-ranges',
            sourceLabel: 'Risk Ranges',
            sourceDate: today,
            decisionEligible: true,
          },
          signalStrength: {
            status: 'available',
            value: 'ADDED',
            sourceId: 'signal-strength',
            sourceLabel: 'Signal Strength',
            sourceDate: today,
          },
        },
        supplementalRange: {
          status: 'available',
          lrr: 2890,
          hrr: 3020,
          sourceId: 'early-look',
          sourceLabel: 'Early Look',
          sourceDate: today,
          decisionEligible: false,
        },
        exposures: [
          { id: 'growth', type: 'factor', label: 'Growth' },
          { id: 'gold', type: 'commodity', label: 'Gold' },
        ],
        directReferences: [
          {
            id: 'direct-1',
            marketDate: today,
            productId: 'the-call',
            productLabel: 'The Call',
            kind: 'mention',
            direction: 'long',
            excerpt: 'Gold remains a preferred long.',
            matchType: 'direct',
            qualityStatus: 'indexed',
            publishedAt: `${today}T13:42:00Z`,
            sourceUrl: '/research/the-call/direct-1',
          },
        ],
        inferredReferences: [
          {
            id: 'inferred-1',
            marketDate: today,
            productId: 'the-macro-show',
            productLabel: 'The Macro Show',
            kind: 'commodity_mention',
            direction: 'positive',
            excerpt: 'Gold exposure remains supported.',
            matchType: 'inferred_exposure',
            exposure: 'gold',
            exposureId: 'gold',
            exposureType: 'commodity',
            exposureLabel: 'Gold',
            qualityStatus: 'indexed',
            publishedAt: `${today}T12:17:00Z`,
          },
        ],
        history: [
          {
            marketDate: priorDate(),
            directReferences: [
              {
                id: 'history-1',
                productId: 'early-look',
                productLabel: 'Early Look',
                kind: 'summary',
                excerpt: 'Prior market-day gold note.',
                matchType: 'direct',
                qualityStatus: 'validated',
              },
              {
                id: 'history-range-1',
                productId: 'risk-ranges',
                productLabel: 'Risk Ranges',
                kind: 'primary_risk_range',
                excerpt: 'LRR 2,880 – HRR 3,000',
                value: { lrr: 2880, hrr: 3000 },
                decisionEligible: true,
                matchType: 'direct',
                qualityStatus: 'validated',
              },
            ],
            inferredReferences: [],
          },
        ],
        coverage: { state: 'complete', reasons: [] },
      },
      NEM: {
        symbol: 'NEM',
        state: 'no_references',
        decision: {},
        directReferences: [],
        inferredReferences: [],
        history: [],
        exposures: [],
        coverage: { state: 'no_references', reasons: [] },
      },
    },
  };
};

beforeEach(() => {
  MarketDataService.getSecurityIntelligence.mockReset();
  MarketDataService.getSecurityRiskMetrics.mockReset();
  MarketDataService.getVolatilitySnapshot.mockReset();
  MarketDataService.getUsdCorrelations.mockReset();
  MarketDataService.getSecurityIntelligence.mockResolvedValue(currentEnvelope());
  MarketDataService.getSecurityRiskMetrics.mockResolvedValue({
    status: 'available',
    historicalOnly: true,
    executable: false,
    rows: {
      GLD: {
        symbol: 'GLD',
        historicalOnly: true,
        executable: false,
        beta: {
          status: 'available',
          value: 0.42,
          benchmark: 'SPY',
          windowSessions: 252,
          observations: 252,
          source: 'Yahoo Finance chart API',
          returnBasis: 'adjusted-close simple daily returns over adjacent common dates',
          asOf: marketDate(),
          calculation: {
            covarianceSum: 0.0042,
            benchmarkVarianceSum: 0.01,
          },
        },
        atr14: {
          status: 'available',
          value: 4.5,
          asOf: marketDate(),
        },
        zScore20: {
          status: 'available',
          value: 1.25,
          asOf: marketDate(),
        },
        realizedVolatility: {
          status: 'available',
          rv63: 0.18,
          rv252: 0.15,
          rv3y: 0.16,
          rv5y: 0.17,
          rv10y: 0.19,
          sizingVol: 0.18,
          annualizationFactor: 252,
          observationCount: 500,
          limitedHistory: false,
          spikeWarning: false,
          asOf: marketDate(),
          warnings: [],
        },
      },
      NEM: {
        symbol: 'NEM',
        historicalOnly: true,
        executable: false,
        beta: { status: 'unavailable', value: null },
        atr14: { status: 'unavailable', value: null },
        zScore20: { status: 'unavailable', value: null },
        realizedVolatility: {
          status: 'unavailable',
          rv63: null,
          rv252: null,
          sizingVol: null,
          annualizationFactor: null,
          observationCount: 0,
          limitedHistory: true,
          spikeWarning: false,
          asOf: null,
          warnings: ['Insufficient price history for a volatility estimate (need at least 63 returns).'],
        },
      },
    },
  });
  MarketDataService.getVolatilitySnapshot.mockResolvedValue({
    lastUpdated: `${marketDate()}T14:00:00Z`,
    GVZ: {
      lastPx: 18.25,
      availability: 'available',
      freshness: 'current',
      asOf: `${marketDate()}T14:00:00Z`,
      sourceLabel: 'Cboe delayed',
      quoteMode: 'delayed',
    },
  });
  MarketDataService.getUsdCorrelations.mockResolvedValue({
    sourceStatus: 'current',
    calculationDate: marketDate(),
    timestamp: `${marketDate()}T14:00:00Z`,
    correlations: {
      GOLD: { '30D': -0.72 },
    },
    rollingStats: {
      GOLD: { high: 0.5, low: -0.8, percentPositive: 20, percentNegative: 80 },
    },
  });
});

/* Removed with the Volatility Position Sizing workspace.
test('keeps volatility sizing null for a completed-session reference mark', async () => {
  render(<PortfolioBreakdown portfolioData={{
    ...portfolioData,
    dataSource: 'ibkr_api',
    fromCache: false,
    liveSessionVerified: true,
    accountSummary: {
      netLiquidation: 100000,
      source: 'ibkr_live_session',
    },
    holdings: [{
      ...portfolioData.holdings[0],
      priceState: 'historical_close',
      marketValueState: 'historical_close',
      priceSource: 'ibkr_historical_daily_close',
    }],
  }} />);

  await waitFor(() => expect(MarketDataService.getSecurityRiskMetrics).toHaveBeenCalledTimes(1));
  const table = screen.getByRole('table', {
    name: 'Volatility position sizing suggestions',
  });
  const row = within(table).getByRole('button', { name: 'GLD' }).closest('tr');
  const cells = within(row).getAllByRole('cell');

  expect(cells[7]).toHaveTextContent('—');
  expect(cells[8]).toHaveTextContent('—');
  expect(cells[9]).toHaveTextContent('—');
  expect(cells[10]).toHaveTextContent('—');
  expect(cells[11]).toHaveTextContent('Unverified mark');
});

test('disables volatility sizing controls when live portfolio provenance is cached', async () => {
  render(<PortfolioBreakdown portfolioData={{
    ...portfolioData,
    dataSource: 'ibkr_api',
    fromCache: true,
    liveSessionVerified: true,
    accountSummary: {
      netLiquidation: 100000,
      source: 'ibkr_live_session',
    },
    holdings: [{
      ...portfolioData.holdings[0],
      priceState: 'live',
      marketValueState: 'live',
    }],
  }} />);

  await waitFor(() => expect(MarketDataService.getSecurityRiskMetrics).toHaveBeenCalledTimes(1));
  [
    'Portfolio value',
    'Total allocation %',
    'Risk budget % / name',
    'Max weight %',
    'Max $ notional',
    'Mode',
    'Include 63d',
    'Asset type',
  ].forEach((label) => {
    expect(screen.getByLabelText(label)).toBeDisabled();
  });

  const table = screen.getByRole('table', {
    name: 'Volatility position sizing suggestions',
  });
  const row = within(table).getByRole('button', { name: 'GLD' }).closest('tr');
  const cells = within(row).getAllByRole('cell');
  expect(cells[7]).toHaveTextContent('—');
  expect(cells[8]).toHaveTextContent('—');
});

test('enables volatility sizing only for a fully fresh live IBKR universe', async () => {
  render(<PortfolioBreakdown portfolioData={liveSizingPortfolio()} />);

  await waitFor(() => expect(MarketDataService.getSecurityRiskMetrics).toHaveBeenCalledTimes(1));
  expect(screen.getByLabelText('Portfolio value')).toBeEnabled();
  expect(screen.getByLabelText('Mode')).toBeEnabled();

  const table = screen.getByRole('table', {
    name: 'Volatility position sizing suggestions',
  });
  const row = within(table).getByRole('button', { name: 'GLD' }).closest('tr');
  const cells = within(row).getAllByRole('cell');
  await waitFor(() => expect(cells[7]).toHaveTextContent('50.00%'));
  expect(cells[8]).toHaveTextContent('$50,000');
  expect(cells[9]).toHaveTextContent('$10,000');
});

test('fails the whole sizing universe closed for mixed duplicate-symbol provenance', async () => {
  const live = liveSizingPortfolio();
  render(<PortfolioBreakdown portfolioData={{
    ...live,
    holdings: [
      live.holdings[0],
      {
        ...live.holdings[0],
        accountId: 'U2',
        marketValue: 5000,
        priceState: 'historical_close',
        marketValueState: 'historical_close',
        priceSource: 'ibkr_historical_daily_close',
      },
    ],
  }} />);

  await waitFor(() => expect(MarketDataService.getSecurityRiskMetrics).toHaveBeenCalledTimes(1));
  expect(screen.getByLabelText('Portfolio value')).toBeDisabled();
  const table = screen.getByRole('table', {
    name: 'Volatility position sizing suggestions',
  });
  expect(within(table).getAllByRole('button', { name: 'GLD' })).toHaveLength(1);
  const row = within(table).getByRole('button', { name: 'GLD' }).closest('tr');
  const cells = within(row).getAllByRole('cell');
  expect(cells[7]).toHaveTextContent('—');
  expect(cells[8]).toHaveTextContent('—');
  expect(cells[11]).toHaveTextContent('Unverified mark');
});

test.each([
  ['stale portfolio socket', (data) => ({
    ...data,
    socketVerifiedAt: new Date(Date.now() - (6 * 60 * 1000)).toISOString(),
  })],
  ['stale live mark', (data) => ({
    ...data,
    holdings: [{
      ...data.holdings[0],
      priceObservedAt: new Date(Date.now() - 61_000).toISOString(),
    }],
  })],
  ['wrong live price source', (data) => ({
    ...data,
    holdings: [{
      ...data.holdings[0],
      priceSource: 'portfolio_derived',
    }],
  })],
  ['pending mark', (data) => ({
    ...data,
    holdings: [{
      ...data.holdings[0],
      markPending: true,
    }],
  })],
  ['failed mark', (data) => ({
    ...data,
    holdings: [{
      ...data.holdings[0],
      markFailure: { errorCode: 'REFERENCE_MARK_INVALID' },
    }],
  })],
])('keeps sizing unavailable for %s', async (_label, mutate) => {
  render(<PortfolioBreakdown portfolioData={mutate(liveSizingPortfolio())} />);

  await waitFor(() => expect(MarketDataService.getSecurityRiskMetrics).toHaveBeenCalledTimes(1));
  expect(screen.getByLabelText('Portfolio value')).toBeDisabled();
  const table = screen.getByRole('table', {
    name: 'Volatility position sizing suggestions',
  });
  const row = within(table).getByRole('button', { name: 'GLD' }).closest('tr');
  const cells = within(row).getAllByRole('cell');
  expect(cells[7]).toHaveTextContent('—');
  expect(cells[8]).toHaveTextContent('—');
});

test('retains a manual value but disables it when live NAV becomes unavailable', async () => {
  const live = liveSizingPortfolio();
  const view = render(<PortfolioBreakdown portfolioData={live} />);

  await waitFor(() => expect(MarketDataService.getSecurityRiskMetrics).toHaveBeenCalledTimes(1));
  const portfolioValue = screen.getByLabelText('Portfolio value');
  await waitFor(() => expect(portfolioValue).toHaveValue(100000));
  fireEvent.change(portfolioValue, { target: { value: '250000' } });
  expect(portfolioValue).toHaveValue(250000);

  view.rerender(<PortfolioBreakdown portfolioData={{ ...live, fromCache: true }} />);

  expect(screen.getByLabelText('Portfolio value')).toBeDisabled();
  expect(screen.getByLabelText('Portfolio value')).toHaveValue(250000);
  const table = screen.getByRole('table', {
    name: 'Volatility position sizing suggestions',
  });
  const row = within(table).getByRole('button', { name: 'GLD' }).closest('tr');
  expect(within(row).getAllByRole('cell')[8]).toHaveTextContent('—');
});

test('expires sizing locally when a live mark ages out without a portfolio refresh', async () => {
  const live = liveSizingPortfolio();
  render(<PortfolioBreakdown portfolioData={{
    ...live,
    holdings: [{
      ...live.holdings[0],
      priceObservedAt: new Date(Date.now() - 59_500).toISOString(),
    }],
  }} />);

  await waitFor(() => expect(MarketDataService.getSecurityRiskMetrics).toHaveBeenCalledTimes(1));
  expect(screen.getByLabelText('Portfolio value')).toBeEnabled();
  await waitFor(
    () => expect(screen.getByLabelText('Portfolio value')).toBeDisabled(),
    { timeout: 1_500 },
  );

  const table = screen.getByRole('table', {
    name: 'Volatility position sizing suggestions',
  });
  const row = within(table).getByRole('button', { name: 'GLD' }).closest('tr');
  expect(within(row).getAllByRole('cell')[8]).toHaveTextContent('—');
});

*/

test('does not render the removed volatility position sizing workspace', () => {
  render(<PortfolioBreakdown portfolioData={portfolioData} />);

  expect(screen.queryByLabelText('Volatility position sizing')).not.toBeInTheDocument();
  expect(screen.queryByRole('table', { name: 'Volatility position sizing suggestions' })).not.toBeInTheDocument();
  expect(screen.getByLabelText('Factor exposure balance')).toHaveTextContent(
    'Factor exposure unavailable — verified IBKR live NAV and marks are required.',
  );
});

test('shows a verified factor balance and filters both books from a selected factor', () => {
  const live = liveSizingPortfolio();
  render(<PortfolioBreakdown portfolioData={{
    ...live,
    holdings: [
      { ...live.holdings[0], symbol: 'QQQ', marketValue: 9000, quantity: 20 },
      { ...live.holdings[0], symbol: 'QQQ', accountId: 'U2', marketValue: -3000, quantity: -6 },
      { ...live.holdings[0], symbol: 'GLD', accountId: 'U3', marketValue: 1000, quantity: 5 },
    ],
  }} />);

  const panel = screen.getByLabelText('Factor exposure balance');
  expect(within(panel).getByRole('tab', { name: 'Equity Style' })).toHaveAttribute('aria-selected', 'true');
  expect(within(panel).getByRole('button', { name: /Filter by High Beta/ }))
    .toHaveAttribute('aria-pressed', 'false');
  expect(within(panel).getByText(/Reviewed classification:/)).toHaveTextContent(
    'Reviewed classification: 13.0% gross NAV',
  );

  fireEvent.click(within(panel).getByRole('button', { name: /Filter by High Beta/ }));
  expect(screen.queryByText('GLD')).not.toBeInTheDocument();
  expect(screen.getAllByText('QQQ')).toHaveLength(2);
  expect(within(panel).getByRole('button', { name: 'Clear factor filter' })).toBeInTheDocument();

  fireEvent.click(within(panel).getByRole('button', { name: 'Clear factor filter' }));
  expect(screen.getByText('GLD')).toBeInTheDocument();
  fireEvent.click(within(panel).getByRole('tab', { name: 'Asset Class' }));
  expect(within(panel).getByRole('tab', { name: 'Asset Class' })).toHaveAttribute('aria-selected', 'true');
});

test('clears factor exposure values when the live portfolio snapshot becomes cached', () => {
  const baseLive = liveSizingPortfolio();
  const live = {
    ...baseLive,
    holdings: [{
      ...baseLive.holdings[0],
      symbol: 'QQQ',
      marketValue: 9000,
      quantity: 20,
    }],
  };
  const view = render(<PortfolioBreakdown portfolioData={live} />);
  const panel = screen.getByLabelText('Factor exposure balance');
  expect(within(panel).getByRole('button', { name: /Filter by High Beta/ })).toBeInTheDocument();

  view.rerender(<PortfolioBreakdown portfolioData={{ ...live, fromCache: true }} />);
  expect(within(panel).getByText(/Factor exposure unavailable/)).toBeInTheDocument();
  expect(within(panel).queryByRole('button', { name: /Filter by High Beta/ })).not.toBeInTheDocument();
});

test('does not refetch bulk intelligence when only portfolio snapshot timestamps change', async () => {
  const view = render(<PortfolioBreakdown portfolioData={portfolioData} />);

  await waitFor(() => {
    expect(MarketDataService.getSecurityIntelligence).toHaveBeenCalledTimes(1);
    expect(MarketDataService.getSecurityRiskMetrics).toHaveBeenCalledTimes(1);
    expect(MarketDataService.getVolatilitySnapshot).toHaveBeenCalledTimes(1);
    expect(MarketDataService.getUsdCorrelations).toHaveBeenCalledTimes(1);
  });
  fireEvent.click(screen.getAllByRole('button', { name: 'Show research intelligence for GLD' })[0]);
  const panel = screen.getByLabelText('Research intelligence for GLD');
  await waitFor(() => expect(within(panel).getByText('BUY')).toBeInTheDocument());
  await waitFor(() => expect(within(panel).getByText('0.42')).toBeInTheDocument());

  view.rerender(
    <PortfolioBreakdown
      portfolioData={{
        ...portfolioData,
        snapshotId: 'portfolio-snapshot-2',
        lastUpdated: '2026-07-25T18:01:00.000Z',
        socketVerifiedAt: '2026-07-25T18:01:01.000Z',
        accountSummary: {
          ...portfolioData.accountSummary,
          lastUpdated: '2026-07-25T18:01:02.000Z',
        },
        holdings: portfolioData.holdings.map((holding, index) => ({
          ...holding,
          priceObservedAt: `2026-07-25T18:01:0${index + 3}.000Z`,
          snapshotTimestamp: `2026-07-25T18:01:1${index}.000Z`,
        })),
      }}
    />
  );

  await waitFor(() => {
    expect(MarketDataService.getSecurityIntelligence).toHaveBeenCalledTimes(1);
    expect(MarketDataService.getSecurityRiskMetrics).toHaveBeenCalledTimes(1);
    expect(MarketDataService.getVolatilitySnapshot).toHaveBeenCalledTimes(1);
    expect(MarketDataService.getUsdCorrelations).toHaveBeenCalledTimes(1);
  });
  expect(within(screen.getByLabelText('Research intelligence for GLD')).getByText('BUY')).toBeInTheDocument();
  expect(MarketDataService.getSecurityIntelligence).toHaveBeenCalledWith(expect.objectContaining({
    symbols: ['GLD', 'NEM'],
    historyDays: 5,
  }));
  expect(MarketDataService.getSecurityRiskMetrics).toHaveBeenCalledWith(
    ['GLD', 'NEM'],
    {
      assetTypes: {
        GLD: 'equity',
        NEM: 'equity',
      },
    },
  );
});

test('keeps Longs and Shorts as sibling panes in the split ledger', async () => {
  const { container } = render(<PortfolioBreakdown portfolioData={portfolioData} />);

  await waitFor(() => expect(MarketDataService.getSecurityIntelligence).toHaveBeenCalledTimes(1));

  const splitLedger = container.querySelector('.pcv2-ledger-split');
  expect(splitLedger).toBeInTheDocument();
  expect([...splitLedger.children]).toHaveLength(2);
  expect(splitLedger.children[0]).toHaveClass('pcv2-ledger-pane', 'pcv2-ledger-pane--long');
  expect(splitLedger.children[1]).toHaveClass('pcv2-ledger-pane', 'pcv2-ledger-pane--short');
  expect(within(splitLedger.children[0]).getByText('Longs')).toBeInTheDocument();
  expect(within(splitLedger.children[1]).getByText('Shorts')).toBeInTheDocument();
});

test('keeps the portfolio ledger mounted during initial live-data loading', () => {
  render(
    <PortfolioBreakdown portfolioData={null} isLoading />
  );

  expect(screen.queryByText('Loading portfolio data...')).not.toBeInTheDocument();
  expect(screen.getByRole('status')).toHaveTextContent('Connecting to live portfolio');
  expect(screen.getByText('Longs')).toBeInTheDocument();
  expect(screen.getByText('Shorts')).toBeInTheDocument();
  expect(getLedgerTables()).toHaveLength(2);
});

test('fits every compact ledger column in both Longs and Shorts panes', async () => {
  const mixedPortfolio = {
    ...portfolioData,
    holdings: [
      portfolioData.holdings[0],
      {
        ...portfolioData.holdings[2],
        marketValue: -3000,
        quantity: -50,
      },
    ],
  };
  const { container } = render(<PortfolioBreakdown portfolioData={mixedPortfolio} />);

  await waitFor(() => expect(MarketDataService.getSecurityIntelligence).toHaveBeenCalledTimes(1));

  const expectedVisibleHeaders = [
    'Ticker',
    'Asset / Class',
    'Weight / % NAV',
    'Size',
    'Target / % NAV',
    'Factors',
    'Resize / Sh',
    'Price',
    'Day G/L / %',
    'Action',
  ];
  const expectedAccessibleHeaders = [
    'Ticker',
    'Asset class',
    'Weight % (NAV)',
    'Position size',
    'Target % (NAV)',
    'Factor exposures',
    'Resize (Shares)',
    'Price',
    'Day G/L (%)',
    'Action',
  ];
  const panes = [
    container.querySelector('.pcv2-ledger-pane--long'),
    container.querySelector('.pcv2-ledger-pane--short'),
  ];

  panes.forEach((pane) => {
    expect(pane).toBeInTheDocument();
    const viewport = pane.querySelector('.pcv2-ledger-pane-scroll');
    const table = within(pane).getByRole('table');
    const positionRow = pane.querySelector('.pcv2-ledger-row');

    const headers = within(table).getAllByRole('columnheader');
    expect(headers.map((header) => [...header.childNodes]
      .map((node) => node.textContent.trim())
      .filter(Boolean)
      .join(' / '))).toEqual(expectedVisibleHeaders);
    expectedAccessibleHeaders.forEach((name) => {
      expect(within(table).getByRole('columnheader', { name })).toBeInTheDocument();
    });
    expect(positionRow).toBeInTheDocument();
    expect(within(positionRow).getAllByRole('cell')).toHaveLength(10);
    expect(viewport).toHaveAttribute('data-layout', 'fit-columns');
    expect(table).toHaveAttribute('data-column-count', '10');
  });
});

test('batch-loads unique symbols and independently expands stable duplicate position rows', async () => {
  const onRefresh = jest.fn().mockResolvedValue(undefined);
  render(<PortfolioBreakdown portfolioData={portfolioData} onRefresh={onRefresh} />);

  await waitFor(() => expect(MarketDataService.getSecurityIntelligence).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(MarketDataService.getSecurityRiskMetrics).toHaveBeenCalledTimes(1));
  expect(MarketDataService.getSecurityIntelligence).toHaveBeenCalledWith(expect.objectContaining({
    symbols: ['GLD', 'NEM'],
    historyDays: 5,
  }));
  expect(MarketDataService.getSecurityRiskMetrics).toHaveBeenCalledWith(
    ['GLD', 'NEM'],
    {
      assetTypes: {
        GLD: 'equity',
        NEM: 'equity',
      },
    },
  );
  expect(MarketDataService.getVolatilitySnapshot).toHaveBeenCalledTimes(1);
  expect(MarketDataService.getUsdCorrelations).toHaveBeenCalledTimes(1);
  expect(MarketDataService.getSecurityIntelligence.mock.calls[0][0]).not.toHaveProperty('date');

  expect(screen.queryByText('Portfolio Construction')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Export CSV' })).toBeInTheDocument();
  expect(screen.getAllByRole('columnheader', { name: 'Factor exposures' }).length).toBeGreaterThan(0);
  const ledgerColumns = getLedgerTables()[0].querySelectorAll('col');
  expect([...ledgerColumns].map((column) => column.style.width)).toEqual([
    '17%',
    '7%',
    '9%',
    '11%',
    '10%',
    '10%',
    '8%',
    '10%',
    '10%',
    '8%',
  ]);

  fireEvent.click(screen.getByRole('button', { name: 'Refresh portfolio and research' }));
  await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(MarketDataService.getSecurityIntelligence).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(MarketDataService.getSecurityRiskMetrics).toHaveBeenCalledTimes(2));
  expect(MarketDataService.getSecurityIntelligence.mock.calls[1][0]).toEqual(expect.objectContaining({
    symbols: ['GLD', 'NEM'],
    historyDays: 5,
  }));

  const toggles = screen.getAllByRole('button', { name: 'Show research intelligence for GLD' });
  expect(toggles).toHaveLength(2);
  expect(toggles[0]).not.toHaveAttribute('aria-controls', toggles[1].getAttribute('aria-controls'));

  const firstExpandedRow = toggles[0].closest('.pcv2-ledger-row');
  const firstPane = firstExpandedRow.closest('.pcv2-ledger-pane-scroll');
  const firstLedgerHead = firstPane.querySelector('thead');
  const firstBottomSpacer = firstPane.querySelector('.pcv2-ledger-bottom-spacer');
  Object.defineProperty(firstPane, 'scrollHeight', { configurable: true, value: 360 });
  Object.defineProperty(firstPane, 'clientHeight', { configurable: true, value: 300 });
  firstPane.scrollTop = 40;
  firstPane.getBoundingClientRect = jest.fn(() => ({ top: 100 }));
  firstLedgerHead.getBoundingClientRect = jest.fn(() => ({ height: 28 }));
  firstExpandedRow.getBoundingClientRect = jest.fn(() => ({ top: 300 }));

  fireEvent.click(toggles[0]);
  expect(toggles[0]).toHaveAttribute('aria-expanded', 'true');
  expect(toggles[1]).toHaveAttribute('aria-expanded', 'false');
  expect(firstPane.scrollTop).toBe(212);
  expect(firstBottomSpacer).toHaveStyle({ height: '152px' });

  const firstPanel = screen.getByLabelText('Research intelligence for GLD');
  expect(firstExpandedRow).toHaveClass('is-expanded');
  firstPane.scrollTop = 260;
  fireEvent.scroll(firstPane);
  expect(firstPane.scrollTop).toBe(260);

  await waitFor(() => expect(within(firstPanel).getByText('BUY')).toBeInTheDocument());
  expect(within(firstPanel).getByText('BULLISH')).toBeInTheDocument();
  expect(within(firstPanel).getByText('2,900–3,010')).toBeInTheDocument();
  expect(within(firstPanel).getByText('ADDED')).toBeInTheDocument();
  expect(within(firstPanel).getByText('+3 · ATH')).toBeInTheDocument();
  expect(within(firstPanel).getByText('0.42')).toBeInTheDocument();
  await waitFor(() => expect(within(firstExpandedRow).getByRole('button', {
    name: 'Verify GLD position size calculation',
  })).toHaveTextContent('4.0–12.0%'));
  expect(within(firstPanel).getByText('+1.25')).toBeInTheDocument();
  expect(within(firstPanel).getByText('GVZ 18.25')).toBeInTheDocument();
  expect(within(firstPanel).getByText('-0.72')).toBeInTheDocument();
  expect(within(firstPanel).getByTitle('A stop reference requires verified IBKR average cost and historical ATR14.')).toHaveTextContent('—');
  expect(firstPanel.querySelector('.pcv2-intel-meta')).not.toBeInTheDocument();

  const tradeCell = within(firstPanel).getByText('BUY').closest('.pcv2-intel-cell');
  const betaCell = within(firstPanel).getByText('0.42').closest('.pcv2-intel-cell');
  const zScoreCell = within(firstPanel).getByText('+1.25').closest('.pcv2-intel-cell');
  expectCellProvenance(tradeCell, /Momo Tracker · [A-Z][a-z]{2} \d{1,2}/);
  expectCellProvenance(betaCell, /252D vs SPY · [A-Z][a-z]{2} \d{1,2}/);
  expectCellProvenance(zScoreCell, /Completed close · [A-Z][a-z]{2} \d{1,2}/);
  expect(within(betaCell).getByText('0.42')).toHaveClass('is-positive-strong');
  expect(within(zScoreCell).getByText('+1.25')).toHaveClass('is-positive');

  fireEvent.click(within(firstPanel).getByRole('button', {
    name: 'Verify GLD beta calculation',
  }));
  const betaDialog = screen.getByRole('dialog', { name: 'Beta calculation' });
  expect(within(betaDialog).getByText('Beta = covariance of GLD and SPY returns ÷ variance of SPY returns')).toBeInTheDocument();
  expect(within(betaDialog).getByText('0.004200 ÷ 0.01 = 0.42')).toBeInTheDocument();
  expect(within(betaDialog).getByText('252 aligned daily returns')).toBeInTheDocument();
  fireEvent.click(within(betaDialog).getByRole('button', { name: 'Close calculation' }));
  expect(screen.queryByRole('dialog', { name: 'Beta calculation' })).not.toBeInTheDocument();

  expect(within(firstPanel).getByText('LONG · Gold remains a preferred long.')).toBeInTheDocument();
  expect(within(firstPanel).getByText('POSITIVE · Gold exposure remains supported.')).toBeInTheDocument();
  expect(within(firstPanel).queryByText('Direct mention')).not.toBeInTheDocument();
  expect(within(firstPanel).queryByText('Inferred exposure')).not.toBeInTheDocument();
  expect(within(firstPanel).queryByText('Today’s references')).not.toBeInTheDocument();
  const callRow = within(firstPanel).getByText('The Call').closest('.pcv2-intel-reference-row');
  const macroRow = within(firstPanel).getByText('Macro Show').closest('.pcv2-intel-reference-row');
  expect(within(callRow).getByText(/^\d{2}:\d{2}$/)).toBeInTheDocument();
  expect(within(macroRow).getByText(/^\d{2}:\d{2}$/)).toBeInTheDocument();

  const primaryDecisionHeaders = within(firstPanel).getByLabelText('Decision intelligence headers');
  expect(within(primaryDecisionHeaders).getAllByText(/.+/).map((node) => node.textContent)).toEqual([
    'Trade',
    'Trend',
    'Beta',
    'Factor Ctrb',
    'Quad +EV',
  ]);
  expect([...primaryDecisionHeaders.children]).toHaveLength(5);
  [...primaryDecisionHeaders.children].forEach((cell) => (
    expect(cell).toHaveClass('pcv2-intel-span-4')
  ));

  const primaryDecisionValues = within(firstPanel).getByLabelText('GLD decision intelligence');
  expect([...primaryDecisionValues.children]).toHaveLength(5);
  [...primaryDecisionValues.children].forEach((cell) => (
    expect(cell).toHaveClass('pcv2-intel-span-4')
  ));
  expect(within(primaryDecisionValues).getByText('+10.0%')).toBeInTheDocument();
  expect(within(primaryDecisionValues).getByLabelText(
    '+10.0% · Gold · signed % NAV · Current signed position contribution across the displayed +EV exposures.'
  )).toBeInTheDocument();

  const secondaryDecisionHeaders = within(firstPanel)
    .getByLabelText('Decision intelligence secondary headers');
  expect(within(secondaryDecisionHeaders).getAllByText(/.+/).map((node) => node.textContent)).toEqual([
    'Primary range',
    'Signal strength',
    'RR structure',
    'Other exposure',
    'Coverage',
  ]);
  expect([...secondaryDecisionHeaders.children]).toHaveLength(5);
  [...secondaryDecisionHeaders.children].forEach((cell) => (
    expect(cell).toHaveClass('pcv2-intel-span-4')
  ));

  const secondaryDecisionValues = within(firstPanel)
    .getByLabelText('GLD supplemental decision intelligence');
  expect([...secondaryDecisionValues.children]).toHaveLength(5);
  [...secondaryDecisionValues.children].forEach((cell) => (
    expect(cell).toHaveClass('pcv2-intel-span-4')
  ));

  const contextHeaders = within(firstPanel).getByLabelText('Market context headers');
  expect(within(contextHeaders).getAllByText(/.+/).map((node) => node.textContent)).toEqual([
    'Price Z-score · 20D',
    'Sizing vol',
    'Relevant vol index',
    'USD correlation',
    'Stop loss',
  ]);
  expect([...contextHeaders.children]).toHaveLength(5);
  [...contextHeaders.children].forEach((cell) => expect(cell).toHaveClass('pcv2-intel-span-4'));
  const contextValues = within(firstPanel).getByLabelText('GLD market context');
  expect([...contextValues.children]).toHaveLength(5);
  [...contextValues.children].forEach((cell) => expect(cell).toHaveClass('pcv2-intel-span-4'));
  expect(within(firstPanel).getAllByText('The Call')).toHaveLength(1);
  expect(within(firstPanel).getAllByText('Macro Show')).toHaveLength(1);

  const historicalNote = within(firstPanel).getByText('Prior market-day gold note.');
  expect(historicalNote).not.toBeVisible();
  fireEvent.click(within(firstPanel).getByText(/Previous 5 market days/));
  expect(historicalNote).toBeVisible();

  const secondExpandedRow = toggles[1].closest('.pcv2-ledger-row');
  const secondPane = secondExpandedRow.closest('.pcv2-ledger-pane-scroll');
  const secondLedgerHead = secondPane.querySelector('thead');
  const secondBottomSpacer = secondPane.querySelector('.pcv2-ledger-bottom-spacer');
  Object.defineProperty(secondPane, 'scrollHeight', { configurable: true, value: 500 });
  Object.defineProperty(secondPane, 'clientHeight', { configurable: true, value: 300 });
  secondPane.scrollTop = 75;
  secondPane.getBoundingClientRect = jest.fn(() => ({ top: 100 }));
  secondLedgerHead.getBoundingClientRect = jest.fn(() => ({ height: 28 }));
  secondExpandedRow.getBoundingClientRect = jest.fn(() => ({ top: 340 }));

  fireEvent.click(toggles[1]);
  expect(screen.getAllByLabelText('Research intelligence for GLD')).toHaveLength(2);
  expect(secondPane.scrollTop).toBe(287);
  expect(secondBottomSpacer).toHaveStyle({ height: '87px' });

  const scrollTopBeforeCollapse = firstPane.scrollTop;
  fireEvent.click(screen.getAllByRole('button', { name: 'Hide research intelligence for GLD' })[0]);
  expect(screen.getAllByLabelText('Research intelligence for GLD')).toHaveLength(1);
  expect(firstPane.scrollTop).toBe(scrollTopBeforeCollapse);

  fireEvent.click(screen.getByRole('button', { name: 'Hide research intelligence for GLD' }));
  expect(screen.queryByLabelText('Research intelligence for GLD')).not.toBeInTheDocument();
  expect(secondBottomSpacer).toHaveStyle({ height: '0px' });
  expect(firstPane.scrollTop).toBe(scrollTopBeforeCollapse);
});

test('uses N/A only for an indexed Call or Macro product with zero matching references', async () => {
  const envelope = currentEnvelope();
  envelope.bySymbol.GLD.inferredReferences = [];
  MarketDataService.getSecurityIntelligence.mockResolvedValueOnce(envelope);

  render(<PortfolioBreakdown portfolioData={{
    ...portfolioData,
    holdings: [portfolioData.holdings[0]],
  }} />);
  await waitFor(() => expect(MarketDataService.getSecurityIntelligence).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole('button', { name: 'Show research intelligence for GLD' }));

  const panel = screen.getByLabelText('Research intelligence for GLD');
  await within(panel).findByText('FULL');
  const macroRow = within(panel).getByText('Macro Show').closest('.pcv2-intel-reference-row');
  expect(within(macroRow).getByText('N/A')).toBeInTheDocument();
  expect(within(macroRow).getByText('INDEXED ✓')).toBeInTheDocument();
  expect(macroRow.children).toHaveLength(4);
  expect(macroRow.children[0]).toHaveClass('pcv2-intel-span-2');
  expect(macroRow.children[1]).toHaveClass('pcv2-intel-span-2');
  expect(macroRow.children[2]).toHaveClass('pcv2-intel-span-14');
  expect(macroRow.children[3]).toHaveClass('pcv2-intel-span-2');
});

test('renders an incomplete Macro product as unavailable instead of a verified empty mention', async () => {
  const envelope = currentEnvelope();
  envelope.bySymbol.GLD.inferredReferences = [];
  envelope.products = envelope.products.map((product) => (
    product.id === 'the-macro-show' ? { ...product, status: 'missing' } : product
  ));
  MarketDataService.getSecurityIntelligence.mockResolvedValueOnce(envelope);

  render(<PortfolioBreakdown portfolioData={{
    ...portfolioData,
    holdings: [portfolioData.holdings[0]],
  }} />);
  await waitFor(() => expect(MarketDataService.getSecurityIntelligence).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole('button', { name: 'Show research intelligence for GLD' }));

  const panel = screen.getByLabelText('Research intelligence for GLD');
  await within(panel).findByText('FULL');
  const macroRow = within(panel).getByText('Macro Show').closest('.pcv2-intel-reference-row');
  expect(within(macroRow).getByText('Unavailable')).toBeInTheDocument();
  expect(within(macroRow).getByText('MISSING')).toBeInTheDocument();
  expect(within(macroRow).queryByText('N/A')).not.toBeInTheDocument();
});

test('shows the canonical beta-derived position-size band and calculation', async () => {
  MarketDataService.getSecurityRiskMetrics.mockResolvedValueOnce({
    status: 'available',
    historicalOnly: true,
    executable: false,
    rows: {
      GLD: {
        symbol: 'GLD',
        historicalOnly: true,
        executable: false,
        beta: {
          status: 'available',
          value: 1.68,
          benchmark: 'SPY',
          windowSessions: 252,
          observations: 252,
          source: 'Yahoo Finance chart API',
          returnBasis: 'adjusted-close simple daily returns over adjacent common dates',
          asOf: marketDate(),
        },
        atr14: { status: 'unavailable', value: null },
        zScore20: { status: 'unavailable', value: null },
      },
    },
  });

  render(<PortfolioBreakdown portfolioData={{
    ...portfolioData,
    holdings: [portfolioData.holdings[0]],
  }} />);
  await waitFor(() => expect(MarketDataService.getSecurityRiskMetrics).toHaveBeenCalledTimes(1));
  const sizeButton = await screen.findByRole('button', {
    name: 'Verify GLD position size calculation',
  });
  await waitFor(() => expect(sizeButton).toHaveTextContent('1.5–3.5%'));
  expect(sizeButton.closest('.pcv2-ledger-size-reference')).toBeInTheDocument();
  expect(sizeButton).toHaveAttribute(
    'title',
    'Historical beta position-size reference band; not a target or executable sizing instruction.',
  );

  fireEvent.click(sizeButton);
  const sizeDialog = screen.getByRole('dialog', { name: 'Position size calculation' });
  expect(within(sizeDialog).getByText(
    'β* = clamp(|β|, 0.50, 2.00); MIN = 2.00% ÷ β*; MAX = 6.00% ÷ β*',
  )).toBeInTheDocument();
  expect(within(sizeDialog).getByText(
    '|β| 1.68 → β* 1.68; raw 1.19%–3.57% → rounded 1.5–3.5%',
  )).toBeInTheDocument();
  expect(within(sizeDialog).getByText('1.5–3.5%')).toBeInTheDocument();
  expect(within(sizeDialog).getByText('252 aligned completed-session returns')).toBeInTheDocument();
  expect(within(sizeDialog).getByText('ATR may reduce MAX')).toBeInTheDocument();
  expect(within(sizeDialog).getByText('Beta alone does not select a final target')).toBeInTheDocument();
  fireEvent.click(within(sizeDialog).getByRole('button', { name: 'Close calculation' }));
});

test('does not calculate Size from insufficient beta provenance', async () => {
  MarketDataService.getSecurityRiskMetrics.mockResolvedValueOnce({
    status: 'available',
    historicalOnly: true,
    executable: false,
    rows: {
      GLD: {
        symbol: 'GLD',
        historicalOnly: true,
        executable: false,
        beta: {
          status: 'available',
          value: 1.68,
          benchmark: 'SPY',
          windowSessions: 252,
          observations: 125,
          source: 'Yahoo Finance chart API',
          returnBasis: 'adjusted-close simple daily returns over adjacent common dates',
          asOf: marketDate(),
        },
        atr14: { status: 'unavailable', value: null },
        zScore20: { status: 'unavailable', value: null },
      },
    },
  });

  render(<PortfolioBreakdown portfolioData={{
    ...portfolioData,
    holdings: [portfolioData.holdings[0]],
  }} />);
  await waitFor(() => expect(MarketDataService.getSecurityRiskMetrics).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole('button', { name: 'Show research intelligence for GLD' }));

  const panel = screen.getByLabelText('Research intelligence for GLD');
  const sizeButton = await screen.findByRole('button', {
    name: 'Verify GLD position size calculation',
  });
  await waitFor(() => expect(sizeButton).toHaveTextContent('—'));
  expect(sizeButton).toHaveAttribute(
    'title',
    'A size reference requires verified completed-session beta provenance.',
  );
  expect(within(panel).queryByText('1.5–3.5%')).not.toBeInTheDocument();

  fireEvent.click(sizeButton);
  const sizeDialog = screen.getByRole('dialog', { name: 'Position size calculation' });
  expect(within(sizeDialog).getByText('Unavailable')).toBeInTheDocument();
  expect(within(sizeDialog).getByText(
    'Not calculated — verified completed-session beta provenance is required.',
  )).toBeInTheDocument();
});

test('calculates a non-executable 2x ATR14 stop reference only from verified IBKR average cost', async () => {
  render(<PortfolioBreakdown portfolioData={{
    ...portfolioData,
    dataSource: 'ibkr_api',
    fromCache: false,
    liveSessionVerified: true,
    accountSummary: {
      netLiquidation: 100000,
      source: 'ibkr_live_session',
    },
    holdings: [{
      ...portfolioData.holdings[0],
      avgCost: 200,
      positionSource: 'ibkr_live_session',
      priceState: 'live',
      marketValueState: 'live',
    }],
  }} />);
  await waitFor(() => expect(MarketDataService.getSecurityRiskMetrics).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole('button', { name: 'Show research intelligence for GLD' }));

  const panel = screen.getByLabelText('Research intelligence for GLD');
  const stopValue = await within(panel).findByText('191.00');
  const stopCell = stopValue.closest('.pcv2-intel-cell');
  expect(within(panel).getByLabelText('GLD market context')).toContainElement(stopCell);
  expect(within(panel).getByLabelText('GLD decision intelligence')).not.toContainElement(stopCell);
  expect(stopCell).toHaveClass('is-reference');
  expect(stopValue).toHaveClass('is-positive-strong');
  fireEvent.click(within(panel).getByRole('button', {
    name: 'Verify GLD stop loss calculation',
  }));
  const stopDialog = screen.getByRole('dialog', { name: 'Stop loss calculation' });
  expect(within(stopDialog).getByText('Stop = average cost − (2 × ATR14)')).toBeInTheDocument();
  expect(within(stopDialog).getByText('$200.00 − (2 × $4.50) = $191.00')).toBeInTheDocument();
  fireEvent.click(within(stopDialog).getByRole('button', { name: 'Close calculation' }));
  expectCellProvenance(stopCell, /IBKR basis · 2×ATR14 · .* · reference only/);
  expect(stopCell).toHaveAttribute(
    'title',
    'Non-executable reference: IBKR average cost adjusted by two historical ATR14 values.',
  );
});

test('calculates a reference-only 2x ATR14 stop from a verified completed-session IBKR basis', async () => {
  render(<PortfolioBreakdown portfolioData={{
    ...portfolioData,
    liveSessionVerified: true,
    accountSummary: {
      netLiquidation: 100000,
      source: 'ibkr_completed_session_reference',
    },
    holdings: [{
      ...portfolioData.holdings[0],
      avgCost: 200,
      positionSource: 'ibkr_api',
      priceState: 'historical_close',
      marketValueState: 'historical_close',
      priceSource: 'ibkr_historical_daily_close',
      priceSessionDate: priorDate(),
    }],
  }} />);
  await waitFor(() => expect(MarketDataService.getSecurityRiskMetrics).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole('button', { name: 'Show research intelligence for GLD' }));

  const panel = screen.getByLabelText('Research intelligence for GLD');
  const stopValue = await within(panel).findByText('191.00');
  const stopCell = stopValue.closest('.pcv2-intel-cell');
  expect(stopCell).toHaveClass('is-reference');
  expect(stopValue).toHaveClass('is-positive-strong');
  expectCellProvenance(stopCell, /IBKR basis · 2×ATR14 · .* · reference only/);
  expect(stopCell).toHaveAttribute(
    'title',
    'Non-executable reference: IBKR average cost adjusted by two historical ATR14 values.',
  );

  const holdingRow = screen
    .getByRole('button', { name: 'Hide research intelligence for GLD' })
    .closest('.pcv2-ledger-row');
  expect(within(holdingRow).queryByRole('textbox')).not.toBeInTheDocument();
  expect(within(holdingRow).getByRole('cell', { name: 'Reference only' })).toHaveTextContent('Ref only');
});

test('retains last-verified decisions as reference-only context after a refresh error', async () => {
  render(<PortfolioBreakdown portfolioData={portfolioData} />);
  await waitFor(() => expect(MarketDataService.getSecurityIntelligence).toHaveBeenCalledTimes(1));

  fireEvent.click(screen.getAllByRole('button', { name: 'Show research intelligence for GLD' })[0]);
  const panel = screen.getByLabelText('Research intelligence for GLD');
  expect(await within(panel).findByText('BUY')).toBeInTheDocument();

  MarketDataService.getSecurityIntelligence.mockRejectedValueOnce(new Error('research offline'));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh portfolio and research' }));

  await waitFor(() => expect(MarketDataService.getSecurityIntelligence).toHaveBeenCalledTimes(2));
  const tradeCell = within(panel).getByText('BUY').closest('.pcv2-intel-cell');
  const trendCell = within(panel).getByText('BULLISH').closest('.pcv2-intel-cell');
  const rangeCell = within(panel).getByText('2,900–3,010').closest('.pcv2-intel-cell');
  const signalCell = within(panel).getByText('ADDED').closest('.pcv2-intel-cell');
  await waitFor(() => (
    expectCellProvenance(tradeCell, /Last verified · Momo Tracker · .* · refresh failed/)
  ));
  [tradeCell, trendCell, rangeCell, signalCell].forEach((cell) => (
    expect(cell).toHaveClass('is-reference')
  ));
  expectCellProvenance(trendCell, /Last verified · Risk Ranges · .* · refresh failed/);
  expectCellProvenance(rangeCell, /Last verified · Risk Ranges · .* · refresh failed/);
  expectCellProvenance(signalCell, /Last verified · Signal Strength · .* · refresh failed/);
  const coverageCell = within(panel).getByText('FULL').closest('.pcv2-intel-cell');
  expectCellProvenance(
    coverageCell,
    /Last verified · [A-Z][a-z]{2} \d{1,2} · refresh failed/,
  );
  expect(panel.querySelector('.pcv2-intel-meta')).not.toBeInTheDocument();
});

test('shows explicitly non-executable lastVerifiedDecision fields without promoting them to current', async () => {
  const envelope = currentEnvelope();
  const historicalDate = priorDate();
  envelope.coverage = { state: 'partial', reasons: ['Current trackers not yet indexed'] };
  envelope.bySymbol.GLD.state = 'partial';
  envelope.bySymbol.GLD.coverage = {
    state: 'partial',
    reasons: ['Current trackers not yet indexed'],
  };
  envelope.bySymbol.GLD.decision = {};
  envelope.bySymbol.GLD.lastVerifiedDecision = {
    trade: {
      status: 'historical',
      qualityStatus: 'validated',
      value: 'SELL',
      sourceId: 'momo-tracker',
      sourceLabel: 'Momo Tracker',
      sourceDate: historicalDate,
      referenceOnly: true,
      executable: false,
    },
    trend: {
      status: 'historical',
      qualityStatus: 'validated',
      value: 'BEARISH',
      sourceId: 'risk-ranges',
      sourceLabel: 'Risk Ranges',
      sourceDate: historicalDate,
      referenceOnly: true,
      executable: false,
    },
    riskRange: {
      status: 'historical',
      qualityStatus: 'validated',
      lrr: 2880,
      hrr: 3000,
      sourceId: 'risk-ranges',
      sourceLabel: 'Risk Ranges',
      sourceDate: historicalDate,
      referenceOnly: true,
      executable: false,
      publicationDecisionEligible: true,
      currentDecisionEligible: false,
      decisionEligible: false,
    },
    signalStrength: {
      status: 'historical',
      qualityStatus: 'validated',
      value: 'REMOVED',
      sourceId: 'signal-strength',
      sourceLabel: 'Signal Strength',
      sourceDate: historicalDate,
      referenceOnly: true,
      executable: false,
    },
  };
  MarketDataService.getSecurityIntelligence.mockResolvedValueOnce(envelope);

  render(<PortfolioBreakdown portfolioData={{
    ...portfolioData,
    holdings: [portfolioData.holdings[0]],
  }} />);
  await waitFor(() => expect(MarketDataService.getSecurityIntelligence).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole('button', { name: 'Show research intelligence for GLD' }));

  const panel = screen.getByLabelText('Research intelligence for GLD');
  const tradeCell = (await within(panel).findByText('SELL')).closest('.pcv2-intel-cell');
  const trendCell = within(panel).getByText('BEARISH').closest('.pcv2-intel-cell');
  const rangeCell = within(panel).getByText('2,880–3,000').closest('.pcv2-intel-cell');
  const signalCell = within(panel).getByText('REMOVED').closest('.pcv2-intel-cell');
  [tradeCell, trendCell, rangeCell, signalCell].forEach((cell) => {
    expect(cell).toHaveClass('is-reference');
    expectCellProvenance(cell, /Last verified · .* · reference only/);
  });
  const coverageCell = within(panel).getByText('PARTIAL').closest('.pcv2-intel-cell');
  expectCellProvenance(coverageCell, /Current trackers not yet indexed/);
  expect(within(panel).queryByText('Current trackers not yet indexed')).not.toBeInTheDocument();
});

test('does not promote stale or unauthorized products into current decision fields', async () => {
  const today = marketDate();
  MarketDataService.getSecurityIntelligence.mockResolvedValueOnce({
    schemaVersion: 1,
    marketDate: today,
    coverage: { state: 'partial', reasons: ['Risk Ranges missing'] },
    bySymbol: {
      GLD: {
        symbol: 'GLD',
        state: 'partial',
        decision: {
          trade: {
            status: 'available',
            value: 'SHOULD_NOT_RENDER',
            sourceId: 'risk-ranges',
            sourceDate: today,
          },
          trend: {
            status: 'stale',
            value: 'STALE_TREND',
            sourceId: 'risk-ranges',
            sourceDate: priorDate(),
          },
          riskRange: {
            status: 'available',
            lrr: 1,
            hrr: 2,
            sourceId: 'early-look',
            sourceDate: today,
            decisionEligible: false,
          },
        },
        directReferences: [],
        inferredReferences: [],
        history: [],
        coverage: { state: 'partial', reasons: ['Risk Ranges missing'] },
      },
    },
  });

  render(<PortfolioBreakdown portfolioData={{
    ...portfolioData,
    holdings: [portfolioData.holdings[0]],
  }} />);
  await waitFor(() => expect(MarketDataService.getSecurityIntelligence).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole('button', { name: 'Show research intelligence for GLD' }));

  await screen.findByText('PARTIAL');
  expect(screen.queryByText('SHOULD_NOT_RENDER')).not.toBeInTheDocument();
  expect(screen.queryByText('STALE_TREND')).not.toBeInTheDocument();
  expect(screen.queryByText('1 – 2')).not.toBeInTheDocument();
  expect(screen.getAllByText('Unavailable').length).toBeGreaterThanOrEqual(2);
  const coverageCell = screen.getByText('PARTIAL').closest('.pcv2-intel-cell');
  expectCellProvenance(coverageCell, /Risk Ranges missing/);
  expect(screen.queryByText('Risk Ranges missing')).not.toBeInTheDocument();
});

test('does not treat an entire prior-market-day envelope as current research', async () => {
  const envelope = currentEnvelope();
  const staleDate = priorDate();
  envelope.marketDate = staleDate;
  envelope.products = envelope.products.map((product) => ({
    ...product,
    marketDate: staleDate,
  }));
  Object.values(envelope.bySymbol.GLD.decision).forEach((datum) => {
    datum.sourceDate = staleDate;
  });
  envelope.bySymbol.GLD.directReferences = envelope.bySymbol.GLD.directReferences.map((reference) => ({
    ...reference,
    marketDate: staleDate,
  }));
  envelope.bySymbol.GLD.inferredReferences = envelope.bySymbol.GLD.inferredReferences.map((reference) => ({
    ...reference,
    marketDate: staleDate,
  }));
  MarketDataService.getSecurityIntelligence.mockResolvedValueOnce(envelope);

  render(<PortfolioBreakdown portfolioData={{
    ...portfolioData,
    holdings: [portfolioData.holdings[0]],
  }} />);
  await waitFor(() => expect(MarketDataService.getSecurityIntelligence).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole('button', { name: 'Show research intelligence for GLD' }));

  const panel = screen.getByLabelText('Research intelligence for GLD');
  expect(within(panel).queryByText('BUY')).not.toBeInTheDocument();
  expect(within(panel).queryByText('BULLISH')).not.toBeInTheDocument();
  expect(within(panel).getAllByText('UNAVAILABLE').length).toBeGreaterThanOrEqual(1);
});

test('shows completed IBKR closes as reference values without enabling sizing or a top banner', async () => {
  render(<PortfolioBreakdown portfolioData={{
    ...portfolioData,
    dataSource: 'ibkr_api',
    fromCache: false,
    liveSessionVerified: true,
    accountSummary: {
      netLiquidation: 100000,
      source: 'ibkr_live_session',
    },
    reconciliationWarnings: ['IBKR reference closes in use for GLD'],
    dataQuality: {
      status: 'stale',
      markState: 'reference',
      historicalMarkCount: 1,
      warnings: ['IBKR reference closes in use for GLD'],
    },
    holdings: [{
      ...portfolioData.holdings[0],
      price: 200,
      marketValue: 10000,
      priceState: 'historical_close',
      marketValueState: 'historical_close',
      priceSource: 'ibkr_historical_daily_close',
      priceSessionDate: '2026-07-24',
      priceObservedAt: '2026-07-25T00:05:00.000Z',
      referenceClose: 200,
      referenceCloseSource: 'ibkr_historical_daily_close',
      referenceCloseSessionDate: '2026-07-24',
      referenceCloseObservedAt: '2026-07-25T00:05:00.000Z',
      previousClose: 198,
      previousCloseSessionDate: '2026-07-23',
      dayChangePercent: 1.01,
      dayChangeState: 'historical_session',
      dayChangeSessionDate: '2026-07-24',
    }],
  }} />);

  await waitFor(() => expect(MarketDataService.getSecurityIntelligence).toHaveBeenCalledTimes(1));
  expect(screen.queryByText('IBKR reference closes in use for GLD')).not.toBeInTheDocument();

  const row = getLedgerRowBySymbol('GLD');
  expect(within(row).getByText('10.00%')).toBeInTheDocument();
  expect(within(row).getByRole('cell', {
    name: 'Prior close $200.00 from 2026-07-24',
  })).toHaveTextContent('$200.00');
  expect(within(row).getByRole('cell', {
    name: 'Day gain/loss +1.01%',
  })).toHaveTextContent('+1.01%');
  expect(within(row).queryByText('$198.00')).not.toBeInTheDocument();
  expect(within(row).getByRole('cell', { name: 'Reference only' })).toHaveTextContent('Ref only');
  expect(within(row).queryByRole('textbox')).not.toBeInTheDocument();
  const referenceIcon = within(row).getByLabelText('Reference close');
  expect(referenceIcon).toHaveClass('pcv2-warning-icon--reference');
  expect(referenceIcon).not.toHaveClass('pcv2-warning-icon--error');
  expect(referenceIcon).toHaveAttribute(
    'title',
    'Reference close from 2026-07-24; not a live executable mark',
  );
});

test('shows a verified IBKR live last and signed Day G/L percentage', async () => {
  render(<PortfolioBreakdown portfolioData={{
    ...portfolioData,
    dataSource: 'ibkr_api',
    fromCache: false,
    liveSessionVerified: true,
    holdings: [{
      ...portfolioData.holdings[0],
      price: 201.5,
      marketValue: 10075,
      priceState: 'live',
      marketValueState: 'live',
      priceSource: 'ibkr_live_last',
      priceObservedAt: new Date().toISOString(),
      referenceClose: 200,
      referenceCloseSource: 'ibkr_historical_daily_close',
      referenceCloseSessionDate: '2026-07-24',
      referenceCloseObservedAt: '2026-07-25T00:05:00.000Z',
      dayChangePercent: 0.75,
      dayChangeState: 'live_vs_reference_close',
      dayChangeSessionDate: '2026-07-24',
    }],
  }} />);

  await waitFor(() => expect(MarketDataService.getSecurityIntelligence).toHaveBeenCalledTimes(1));
  const row = getLedgerRowBySymbol('GLD');
  expect(within(row).getByRole('cell', {
    name: 'Live price $201.50',
  })).toHaveTextContent('$201.50');
  expect(within(row).getByRole('cell', {
    name: 'Day gain/loss +0.75%',
  })).toHaveTextContent('+0.75%');
});

test('does not expose portfolio-derived or unverified values as price or Day G/L', async () => {
  render(<PortfolioBreakdown portfolioData={{
    ...portfolioData,
    dataSource: 'ibkr_api',
    fromCache: false,
    liveSessionVerified: true,
    holdings: [{
      ...portfolioData.holdings[0],
      price: 999,
      priceState: 'unavailable',
      marketValueState: 'unavailable',
      priceSource: 'ibkr_portfolio',
      dayGainLoss: 500,
      dayChangePercent: 5,
    }],
  }} />);

  await waitFor(() => expect(MarketDataService.getSecurityIntelligence).toHaveBeenCalledTimes(1));
  const row = getLedgerRowBySymbol('GLD');
  expect(within(row).getByRole('cell', { name: 'Price unavailable' })).toHaveTextContent('—');
  expect(within(row).getByRole('cell', {
    name: 'Day gain/loss percentage unavailable',
  })).toHaveTextContent('—');
  expect(within(row).queryByText('$999.00')).not.toBeInTheDocument();
  expect(within(row).queryByText('+5.00%')).not.toBeInTheDocument();
});

test('reserves the red warning state for unavailable or invalid marks', async () => {
  render(<PortfolioBreakdown portfolioData={{
    ...portfolioData,
    holdings: [{
      ...portfolioData.holdings[0],
      price: null,
      marketValue: null,
      priceState: 'unavailable',
      marketValueState: 'unavailable',
      markWarmState: 'degraded',
      warning: 'missing_market_value',
    }],
  }} />);

  await waitFor(() => expect(MarketDataService.getSecurityIntelligence).toHaveBeenCalledTimes(1));
  const row = getLedgerRowBySymbol('GLD');
  const errorIcon = within(row).getByLabelText('Bad data warning');
  expect(errorIcon).toHaveClass('pcv2-warning-icon--error');
  expect(errorIcon).not.toHaveClass('pcv2-warning-icon--reference');
  expect(errorIcon).toHaveAttribute('title', 'missing_market_value');
});

test('lets a hard mark failure override an otherwise valid reference-close warning', async () => {
  render(<PortfolioBreakdown portfolioData={{
    ...portfolioData,
    holdings: [{
      ...portfolioData.holdings[0],
      price: 200,
      marketValue: 10000,
      priceState: 'historical_close',
      marketValueState: 'historical_close',
      priceSource: 'ibkr_historical_daily_close',
      priceSessionDate: '2026-07-24',
      referenceCloseSessionDate: '2026-07-24',
      markFailure: {
        errorCode: 'REFERENCE_MARK_INVALID',
        stage: 'reference_marks_validation',
      },
    }],
  }} />);

  await waitFor(() => expect(MarketDataService.getSecurityIntelligence).toHaveBeenCalledTimes(1));
  const row = getLedgerRowBySymbol('GLD');
  const errorIcon = within(row).getByLabelText('Bad data warning');
  expect(errorIcon).toHaveClass('pcv2-warning-icon--error');
  expect(errorIcon).not.toHaveClass('pcv2-warning-icon--reference');
  expect(within(row).queryByLabelText('Reference close')).not.toBeInTheDocument();
});

test('shows a warming-only market mark as yellow while keeping sizing unavailable', async () => {
  render(<PortfolioBreakdown portfolioData={{
    ...portfolioData,
    holdings: [{
      ...portfolioData.holdings[0],
      price: null,
      marketValue: null,
      priceState: 'unavailable',
      marketValueState: 'unavailable',
      markPending: true,
      markWarmState: 'warming',
      warning: 'reference_mark_warming',
    }],
  }} />);

  await waitFor(() => expect(MarketDataService.getSecurityIntelligence).toHaveBeenCalledTimes(1));
  const row = getLedgerRowBySymbol('GLD');
  const loadingIcon = within(row).getByLabelText('Market mark loading');
  expect(loadingIcon).toHaveClass('pcv2-warning-icon--reference');
  expect(loadingIcon).not.toHaveClass('pcv2-warning-icon--error');
  expect(within(row).getByRole('cell', { name: 'Unavailable' })).toHaveTextContent('No live');
  expect(within(row).queryByRole('textbox')).not.toBeInTheDocument();
});
