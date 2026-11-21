import React from 'react';
import axios from 'axios';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import PortfolioBreakdown, { calculateLeveragedProductsFitScale } from '../PortfolioBreakdown';
import PersistentSurface from '../../common/PersistentSurface';
import { formatDelayedDataTimestamp } from '../DelayedDataMarker';
import { MarketDataService } from '../../../services/api/marketDataService';
import { getLeveragedProducts } from '../../../constants/leveragedProductCatalog';
import { expectedSizingSession } from '../../../utils/volatilitySizingBand.cjs';
import { isTradingDay } from '../../../utils/marketHolidays';
import useHedgaiTickResearch from '../../../hooks/useHedgaiTickResearch';

jest.mock('../../../hooks/useHedgaiTickResearch', () => ({ __esModule: true, default: jest.fn() }));

const {
  buildSecurityIntelligence,
  manifestChecksumForArtifacts,
} = require('../../../utils/securityIntelligence.cjs');

jest.mock('../../../services/api/marketDataService', () => ({
  MarketDataService: {
    getSecurityIntelligence: jest.fn(),
    getLeveragedProductOverlap: jest.fn(),
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
  while (!isTradingDay(cursor)) {
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return cursor.toISOString().slice(0, 10);
};

const priorDate = () => {
  const value = new Date(`${marketDate()}T12:00:00Z`);
  do {
    value.setUTCDate(value.getUTCDate() - 1);
  } while (!isTradingDay(value));
  return value.toISOString().slice(0, 10);
};

const indexedResearchManifest = (productKey, date, eventCount = 0) => {
  const artifacts = [{
    artifactId: `${productKey}-${date}`,
    stage: 'indexed',
    eventCount,
    parserVersion: 'portfolio-breakdown-test',
  }];
  return {
    marketDate: date,
    productKey,
    schemaVersion: 1,
    state: 'indexed',
    parserVersion: 'portfolio-breakdown-test',
    artifactCount: 1,
    receivedCount: 1,
    parsedCount: 1,
    validatedCount: 1,
    indexedCount: 1,
    entityEventCount: eventCount,
    manifestChecksum: manifestChecksumForArtifacts(artifacts),
    artifacts,
  };
};

const expectCellProvenance = (cell, expected) => {
  const accessibleProvenance = [
    cell?.getAttribute('title'),
    cell?.getAttribute('aria-label'),
  ].filter(Boolean).join(' · ');
  expect(accessibleProvenance).toEqual(expect.stringMatching(expected));
};

const publishedTradeProvenance = (value) => ({
  field: 'trade', sourceField: 'trade', method: 'explicit-field', sourceText: `Trade ${value}`,
});

test('shrinks a levered-products row only when its rendered width exceeds the fixed cell', () => {
  expect(calculateLeveragedProductsFitScale(220, 180)).toBe(1);
  expect(calculateLeveragedProductsFitScale(200, 250)).toBeCloseTo(196 / 250, 6);
  expect(calculateLeveragedProductsFitScale(0, 250)).toBe(1);
});

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
            signalProvenance: publishedTradeProvenance('BUY'),
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

const clozEnvelope = () => {
  const today = marketDate();
  const envelope = currentEnvelope();
  envelope.products = [
    {
      id: 'risk-ranges',
      label: 'Risk Ranges',
      status: 'indexed',
      marketDate: today,
      eventCount: 2,
    },
    ...envelope.products,
  ];
  envelope.bySymbol = {
    CLOZ: {
      symbol: 'CLOZ',
      state: 'complete',
      decision: {},
      supplementalRange: null,
      exposures: [{ id: 'credit', type: 'factor', label: 'Credit' }],
      directReferences: [],
      inferredReferences: [
        {
          id: 'cloz-risk-ranges-credit-map',
          marketDate: today,
          productId: 'risk-ranges',
          productLabel: 'Risk Ranges',
          kind: 'risk_range',
          excerpt: 'Investment Grade Corporate Bond ETF',
          matchedText: 'Investment Grade',
          matchType: 'inferred_exposure',
          exposureId: 'credit',
          exposureType: 'factor',
          exposureLabel: 'Credit',
          qualityStatus: 'indexed',
          publishedAt: `${today}T11:20:40Z`,
          sourceUrl: '/research/risk-ranges',
        },
        {
          id: 'cloz-early-look-credit-map',
          marketDate: today,
          productId: 'early-look',
          productLabel: 'Early Look',
          kind: 'supplemental_risk_range',
          excerpt: 'High Yield (HYG)',
          matchedText: 'High Yield',
          matchType: 'inferred_exposure',
          exposureId: 'credit',
          exposureType: 'factor',
          exposureLabel: 'Credit',
          qualityStatus: 'indexed',
          publishedAt: `${today}T11:48:26Z`,
          sourceUrl: '/research/early-look',
          decisionEligible: false,
        },
      ],
      history: [
        {
          marketDate: priorDate(),
          directReferences: [],
          inferredReferences: [
            {
              id: 'cloz-prior-credit-map',
              productId: 'the-macro-show',
              productLabel: 'Macro Show',
              kind: 'factor_mention',
              excerpt: 'Credit spreads remain contained.',
              matchedText: 'Credit',
              matchType: 'inferred_exposure',
              exposureId: 'credit',
              exposureType: 'factor',
              exposureLabel: 'Credit',
              qualityStatus: 'validated',
            },
          ],
        },
      ],
      coverage: { state: 'complete', reasons: [] },
    },
  };
  return envelope;
};

const registeredResearchProducts = [
  ['risk-ranges', 'Risk Ranges'],
  ['early-look', 'Early Look'],
  ['bitcoin-trend-tracker', 'Bitcoin Tracker'],
  ['portfolio-solutions', 'Portfolio Solutions'],
  ['signal-strength', 'Signal Strength'],
  ['signal-strength-shorts', 'Signal Strength Shorts'],
  ['real-time-alert', 'Real-Time Alerts'],
  ['the-macro-show', 'Macro Show'],
  ['the-call', 'The Call'],
  ['etf-pro', 'ETF Pro'],
  ['investing-ideas', 'Investing Ideas'],
];

beforeEach(() => {
  useHedgaiTickResearch.mockReturnValue({ readings: {} });
  MarketDataService.getSecurityIntelligence.mockReset();
  MarketDataService.getLeveragedProductOverlap.mockReset();
  MarketDataService.getSecurityRiskMetrics.mockReset();
  MarketDataService.getVolatilitySnapshot.mockReset();
  MarketDataService.getUsdCorrelations.mockReset();
  MarketDataService.getSecurityIntelligence.mockResolvedValue(currentEnvelope());
  MarketDataService.getLeveragedProductOverlap.mockResolvedValue({
    available: false,
    status: 'unavailable',
    weightedOverlapPct: null,
    fromCache: false,
  });
  // GLD sizing: ATR 4.5 on a 200 close = 2.25%; stop = 4.50%.
  // MIN = 0.125 / 0.045 = 2.78 → 3.00; MAX = 0.25 / 0.045 = 5.56 → 5.50.
  MarketDataService.getSecurityRiskMetrics.mockResolvedValue({
    status: 'available',
    source: 'Yahoo Finance chart API',
    historicalOnly: true,
    executable: false,
    generatedAt: new Date().toISOString(),
    rows: {
      GLD: {
        symbol: 'GLD',
        source: 'Yahoo Finance chart API',
        asOf: expectedSizingSession(),
        instrumentType: 'ETF',
        referencePrice: {
          status: 'available',
          value: 200,
          source: 'Yahoo Finance chart API',
          asOf: expectedSizingSession(),
          observations: 1,
          timestamp: Date.parse(`${expectedSizingSession()}T13:30:00.000Z`),
          priceBasis: 'adjusted completed daily close',
          historicalOnly: true,
          executable: false,
        },
        provenance: {
          provider: 'Yahoo Finance', dataset: 'chart', interval: '1d', adjustedCloseRequired: true,
          security: { requestedSymbol: 'GLD', fetchedAt: new Date().toISOString() },
        },
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
          source: 'Yahoo Finance chart API',
          observations: 14,
          asOf: expectedSizingSession(),
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
          asOf: expectedSizingSession(),
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
    'Unavailable',
  );
});

const withFactorCloses = snapshot => ({
  ...snapshot,
  holdings: snapshot.holdings.map(holding => ({
    ...holding,
    referenceClose: holding.price,
    referenceCloseSource: 'ibkr_historical_daily_close',
    referenceCloseSessionDate: expectedSizingSession(),
    referenceCloseObservedAt: new Date().toISOString(),
  })),
});

test('shows a verified factor balance and filters both books from a selected factor', () => {
  const live = liveSizingPortfolio();
  render(<PortfolioBreakdown portfolioData={withFactorCloses({
    ...live,
    holdings: [
      { ...live.holdings[0], symbol: 'QQQ', marketValue: 9000, quantity: 18, price: 500 },
      { ...live.holdings[0], symbol: 'QQQ', accountId: 'U2', marketValue: -3000, quantity: -6, price: 500 },
      { ...live.holdings[0], symbol: 'GLD', accountId: 'U3', marketValue: 1000, quantity: 5 },
    ],
  })} />);

  const panel = screen.getByLabelText('Factor exposure balance');
  expect(within(panel).queryByRole('tablist')).not.toBeInTheDocument();
  expect(within(panel).getByRole('button', { name: /Filter by High Beta/ }))
    .toHaveAttribute('aria-pressed', 'false');
  expect(within(panel).getByLabelText('Net exposure to High Beta: 2.0% of NAV')).toHaveTextContent('+2.0%');
  expect(within(panel).getByLabelText('Net exposure to Gold: 1.0% of NAV')).toHaveTextContent('+1.0%');

  fireEvent.click(within(panel).getByRole('button', { name: /Filter by High Beta/ }));
  expect(screen.queryByText('GLD')).not.toBeInTheDocument();
  expect(screen.getAllByText('QQQ')).toHaveLength(2);
  expect(within(panel).getByRole('button', { name: 'Clear factor filter' })).toBeInTheDocument();

  fireEvent.click(within(panel).getByRole('button', { name: 'Clear factor filter' }));
  expect(screen.getByText('GLD')).toBeInTheDocument();
});

test.each([
  ['cached', snapshot => ({ ...snapshot, fromCache: true })],
  ['offline', snapshot => ({ ...snapshot, connected: false })],
  ['failed refresh', snapshot => ({ ...snapshot, error: 'Portfolio refresh failed' })],
  ['stale', snapshot => ({ ...snapshot, stale: true })],
  ['mock', snapshot => ({ ...snapshot, mock: true })],
  ['seeded', snapshot => ({ ...snapshot, seeded: true })],
  ['expired', snapshot => ({ ...snapshot, fetchedAt: '2020-01-01T00:00:00Z' })],
  ['invalid NAV', snapshot => ({ ...snapshot, accountSummary: { ...snapshot.accountSummary, netLiquidation: null } })],
  ['cached NAV', snapshot => ({ ...snapshot, accountSummary: { ...snapshot.accountSummary, fromCache: true } })],
  ['unverified close', snapshot => ({ ...snapshot, holdings: snapshot.holdings.map(holding => ({ ...holding, referenceCloseSource: 'unknown' })) })],
  ['expired close', snapshot => ({ ...snapshot, holdings: snapshot.holdings.map(holding => ({ ...holding, referenceCloseSessionDate: '2020-01-01' })) })],
  ['mock mark', snapshot => ({ ...snapshot, holdings: snapshot.holdings.map(holding => ({ ...holding, mock: true })) })],
])('clears factor exposure values when the live portfolio snapshot becomes %s', (_label, invalidate) => {
  const baseLive = liveSizingPortfolio();
  const live = withFactorCloses({
    ...baseLive,
    holdings: [{
      ...baseLive.holdings[0],
      symbol: 'QQQ',
      marketValue: 9000,
      quantity: 20,
      price: 450,
    }],
  });
  const view = render(<PortfolioBreakdown portfolioData={live} />);
  const panel = screen.getByLabelText('Factor exposure balance');
  expect(within(panel).getByRole('button', { name: /Filter by High Beta/ })).toBeInTheDocument();

  view.rerender(<PortfolioBreakdown portfolioData={invalidate(live)} />);
  expect(within(panel).getByText('Unavailable')).toBeInTheDocument();
  expect(within(panel).queryByRole('button', { name: /Filter by High Beta/ })).not.toBeInTheDocument();
  expect(within(panel).getByLabelText('High Beta exposure unavailable')).toHaveTextContent('N/A');
  expect(within(panel).getByRole('cell', { name: 'Tech, Quad 2: Best #1' })).toHaveTextContent('1');
});

test('uses broker NAV for the new matrix and preserves the existing ledger layout below it', () => {
  const live = liveSizingPortfolio();
  render(<PortfolioBreakdown portfolioData={withFactorCloses({
    ...live,
    summary: { totalValue: 500000 },
    holdings: [{ ...live.holdings[0], symbol: 'OIH', marketValue: 4500, quantity: 10, price: 450 }],
  })} />);
  const panel = screen.getByLabelText('Factor exposure balance');
  expect(within(panel).getByLabelText('Net exposure to Energy: 4.5% of NAV')).toHaveTextContent('+4.5%');
  const ledger = screen.getByPlaceholderText('Search ticker or name...').closest('.pcv2-ledger-card');
  expect(within(panel.closest('.pcv2-shell')).queryByRole('heading')).not.toBeInTheDocument();
  expect(panel.nextElementSibling).toBe(screen.getByLabelText('Hedgeye quad reference'));
  expect(panel.closest('.pcv2-factor-workspace').nextElementSibling).toBe(ledger);
  expect(ledger.querySelector('.pcv2-ledger-split').children).toHaveLength(2);
  expect(within(getLedgerRowBySymbol('OIH')).getAllByRole('cell')).toHaveLength(11);
});

test('shows a dated factor valuation without enabling trade sizing from closing prices', () => {
  const live = liveSizingPortfolio();
  const session = expectedSizingSession();
  const holding = {
    ...live.holdings[0], symbol: 'OIH', priceState: 'historical_close', marketValueState: 'historical_close',
    priceSource: 'ibkr_historical_daily_close', priceSessionDate: session,
    referenceClose: live.holdings[0].price, referenceCloseSource: 'ibkr_historical_daily_close',
    referenceCloseSessionDate: session, referenceCloseObservedAt: new Date().toISOString(),
  };
  render(<PortfolioBreakdown portfolioData={{ ...live, holdings: [holding], dataQuality: { status: 'stale', markState: 'reference' } }} />);
  const panel = screen.getByLabelText('Factor exposure balance');
  expect(within(panel).getByLabelText('Net exposure to Energy: 10.0% of NAV')).toHaveTextContent('+10.0%');
  expect(within(panel).queryByRole('status')).not.toBeInTheDocument();
  expect(within(panel).getByRole('columnheader', { name: /Net % NAV/ })).toHaveAttribute('title', expect.stringContaining('Reference only'));
  expect(screen.getByLabelText('Target weight unavailable for OIH; verified live mark and NAV required')).toHaveTextContent('—');
  expect(within(getLedgerRowBySymbol('OIH')).getByRole('cell', { name: 'Reference only' })).toHaveTextContent('Ref only');
});

test('keeps factor weights and row order through quote expiry while live sizing expires', () => {
  const live = withFactorCloses(liveSizingPortfolio());
  const view = render(<PortfolioBreakdown portfolioData={live} />);
  const panel = screen.getByLabelText('Factor exposure balance');
  const labels = within(panel).getAllByRole('rowheader').map(row => row.textContent);
  const now = Date.now();
  const clock = jest.spyOn(Date, 'now').mockReturnValue(now + 61_000);
  try {
    view.rerender(<PortfolioBreakdown portfolioData={live} isRefreshing />);
    expect(within(panel).getByLabelText('Net exposure to Gold: 10.0% of NAV')).toHaveTextContent('+10.0%');
    expect(within(panel).getAllByRole('rowheader').map(row => row.textContent)).toEqual(labels);
    expect(within(panel).queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Target weight unavailable for GLD; verified live mark and NAV required')).toHaveTextContent('—');
  } finally {
    clock.mockRestore();
  }
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
  await waitFor(() => expect(within(panel).getAllByText('BULLISH').length).toBeGreaterThanOrEqual(2));
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
    expect(MarketDataService.getSecurityIntelligence).toHaveBeenCalledTimes(2);
    expect(MarketDataService.getSecurityRiskMetrics).toHaveBeenCalledTimes(1);
    expect(MarketDataService.getVolatilitySnapshot).toHaveBeenCalledTimes(1);
    expect(MarketDataService.getUsdCorrelations).toHaveBeenCalledTimes(1);
  });
  expect(within(screen.getByLabelText('Research intelligence for GLD')).getAllByText('BULLISH').length)
    .toBeGreaterThanOrEqual(2);
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

describe('active positions controls', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: Date.parse('2026-09-10T18:00:00.000Z') });
    MarketDataService.getSecurityIntelligence.mockResolvedValue(currentEnvelope());
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const settleSources = async () => { await act(async () => { await Promise.resolve(); }); };
  const targetFor = (row) => within(row).getByRole('textbox', { name: /Target weight for/ });
  const resizeCell = (row) => within(row).getAllByRole('cell')[6];
  const focus = (input) => { act(() => input.focus()); };
  const blur = (input) => { act(() => input.blur()); };

  test('preserves raw drafts and selection, rejects invalid characters, and commits blur and Enter before clear restores the live weight', async () => {
    render(<PortfolioBreakdown portfolioData={liveSizingPortfolio()} />);
    await settleSources();
    const row = getLedgerRowBySymbol('GLD');
    const target = targetFor(row);
    expect(target).toHaveValue('10.00');
    expect(resizeCell(row)).toHaveTextContent(/^0$/);
    expect(within(row).getByRole('cell', { name: 'Hold' })).toBeInTheDocument();
    focus(target);
    expect(target).toHaveFocus();
    expect([target.selectionStart, target.selectionEnd]).toEqual([0, 5]);
    fireEvent.change(target, { target: { value: '12.' } });
    expect(target).toHaveValue('12.');
    expect(resizeCell(row)).toHaveTextContent(/^0$/);
    fireEvent.change(target, { target: { value: '12e3' } });
    expect(target).toHaveValue('12.');
    fireEvent.change(target, { target: { value: '12.346' } });
    blur(target);
    expect(target).toHaveValue('12.35');
    expect(resizeCell(row)).toHaveTextContent(/^\+12$/);
    expect(within(row).getByRole('cell', { name: 'Add 12' })).toHaveTextContent('Add');
    focus(target);
    fireEvent.change(target, { target: { value: '11.20' } });
    fireEvent.keyDown(target, { key: 'Enter' });
    expect(target).not.toHaveFocus();
    expect(target).toHaveValue('11.20');
    expect(resizeCell(row)).toHaveTextContent(/^\+6$/);
    focus(target);
    fireEvent.change(target, { target: { value: '' } });
    expect(target).toHaveValue('');
    blur(target);
    expect(target).toHaveValue('10.00');
    expect(resizeCell(row)).toHaveTextContent(/^0$/);
    expect(within(row).getByRole('cell', { name: 'Hold' })).toBeInTheDocument();
    expect(MarketDataService.getSecurityRiskMetrics).toHaveBeenCalledTimes(1);
    expect(MarketDataService.getSecurityIntelligence).toHaveBeenCalledTimes(1);
  });

  test('preserves the existing Escape blur path that commits the visible draft', async () => {
    render(<PortfolioBreakdown portfolioData={liveSizingPortfolio()} />);
    await settleSources();
    const row = getLedgerRowBySymbol('GLD');
    const target = targetFor(row);
    focus(target);
    fireEvent.change(target, { target: { value: '12.75' } });
    // Existing behavior: Escape clears editing state, then native blur commits
    // the current input value. A future cancellation correction is separate.
    fireEvent.keyDown(target, { key: 'Escape' });
    expect(target).not.toHaveFocus();
    expect(target).toHaveValue('12.75');
    expect(resizeCell(row)).toHaveTextContent(/^\+14$/);
    expect(within(row).getByRole('cell', { name: 'Add 14' })).toBeInTheDocument();
  });

  test('bumps active targets by 0.01 and preserves same-side shared targets separately from an identical short ticker through reorder', async () => {
    const live = liveSizingPortfolio();
    const holdings = [
      live.holdings[0],
      { ...live.holdings[0], accountId: 'U2', marketValue: 5000, quantity: 25 },
      { ...live.holdings[0], accountId: 'U3', marketValue: -4000, quantity: -20 },
    ];
    const { container, rerender } = render(<PortfolioBreakdown portfolioData={{ ...live, holdings }} />);
    await settleSources();
    const longPane = container.querySelector('.pcv2-ledger-pane--long');
    const shortPane = container.querySelector('.pcv2-ledger-pane--short');
    const longRows = [...longPane.querySelectorAll('.pcv2-ledger-row')];
    const shortRow = shortPane.querySelector('.pcv2-ledger-row');
    const longTarget = targetFor(longRows[0]);
    const otherLongTarget = targetFor(longRows[1]);
    const shortTarget = targetFor(shortRow);
    const rowIds = [...longRows, shortRow].map((row) => row.dataset.rowId);
    expect(new Set(rowIds).size).toBe(3);
    expect(otherLongTarget).toHaveValue('5.00');
    expect(shortTarget).toHaveValue('-4.00');
    focus(longTarget);
    expect(fireEvent.keyDown(longTarget, { key: 'ArrowUp' })).toBe(false);
    expect(longTarget).toHaveValue('10.01');
    expect(otherLongTarget).toHaveValue('10.01');
    expect(shortTarget).toHaveValue('-4.00');
    expect(resizeCell(longRows[0])).toHaveTextContent(/^\+1$/);
    expect(within(longRows[0]).getByRole('cell', { name: 'Add 1' })).toBeInTheDocument();
    expect(fireEvent.keyDown(longTarget, { key: 'ArrowDown' })).toBe(false);
    expect(longTarget).toHaveValue('10.00');
    expect(resizeCell(longRows[0])).toHaveTextContent(/^0$/);
    fireEvent.keyDown(longTarget, { key: 'ArrowUp' });
    blur(longTarget);
    focus(shortTarget);
    fireEvent.keyDown(shortTarget, { key: 'ArrowDown' });
    expect(shortTarget).toHaveValue('-4.01');
    expect(resizeCell(shortRow)).toHaveTextContent(/^-1$/);
    expect(within(shortRow).getByRole('cell', { name: 'Short 1' })).toBeInTheDocument();
    blur(shortTarget);
    rerender(<PortfolioBreakdown portfolioData={{ ...live, holdings: [holdings[2], holdings[1], holdings[0]] }} />);
    expect([...longPane.querySelectorAll('.pcv2-ledger-row'), shortPane.querySelector('.pcv2-ledger-row')].map((row) => row.dataset.rowId)).toEqual(rowIds);
    expect(targetFor(longPane.querySelectorAll('.pcv2-ledger-row')[0])).toHaveValue('10.01');
    expect(targetFor(longPane.querySelectorAll('.pcv2-ledger-row')[1])).toHaveValue('10.01');
    expect(targetFor(shortPane.querySelector('.pcv2-ledger-row'))).toHaveValue('-4.01');
    expect(MarketDataService.getSecurityRiskMetrics).toHaveBeenCalledTimes(1);
    expect(MarketDataService.getSecurityIntelligence).toHaveBeenCalledTimes(1);
  });

  test('applies current sort, name search and sleeve filters to both the active ledger and exported CSV', async () => {
    const live = liveSizingPortfolio();
    const holdings = [
      { ...live.holdings[0], description: 'Zulu Gold' },
      { ...live.holdings[0], symbol: 'NEM', conid: '2002', description: 'Alpha Newmont', marketValue: 12000, quantity: 200, price: 60 },
      { ...live.holdings[0], symbol: 'TLT', conid: '3003', description: 'Treasury, "long" duration', marketValue: -3000, quantity: -30, price: 100 },
    ];
    const { container } = render(<PortfolioBreakdown portfolioData={{ ...live, holdings }} />);
    await settleSources();
    const positions = screen.getByRole('region', { name: 'Portfolio positions' });
    const longTickers = () => [...container.querySelectorAll('.pcv2-ledger-pane--long .pcv2-ledger-row')].map((row) => within(row).getByRole('button', { name: /research intelligence for/ }).getAttribute('aria-label'));
    expect(longTickers()).toEqual(['Show research intelligence for NEM', 'Show research intelligence for GLD']);
    fireEvent.change(within(positions).getByRole('combobox', { name: 'Sort:' }), { target: { value: 'ticker' } });
    expect(longTickers()).toEqual(['Show research intelligence for GLD', 'Show research intelligence for NEM']);
    fireEvent.change(within(positions).getByRole('combobox', { name: 'Sort:' }), { target: { value: 'name' } });
    expect(longTickers()).toEqual(['Show research intelligence for NEM', 'Show research intelligence for GLD']);
    const search = within(positions).getByPlaceholderText('Search ticker or name...');
    fireEvent.change(search, { target: { value: ' nEwMoNt ' } });
    expect(longTickers()).toEqual(['Show research intelligence for NEM']);
    expect(within(positions).getByText('No short positions')).toBeInTheDocument();
    fireEvent.change(within(positions).getByRole('combobox', { name: 'Sleeve:' }), { target: { value: 'Defensive' } });
    expect(within(positions).getByText('No long positions')).toBeInTheDocument();
    fireEvent.change(search, { target: { value: '' } });
    expect(within(positions).getByText('LONG (0)')).toBeInTheDocument();
    expect(within(positions).getByText('SHORT (1)')).toBeInTheDocument();
    expect(getLedgerRowBySymbol('TLT')).toBeInTheDocument();

    const originalCreate = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
    const originalRevoke = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');
    const createObjectURL = jest.fn(() => 'blob:portfolio-export-test');
    const revokeObjectURL = jest.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });
    const anchorClick = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const NativeBlob = global.Blob;
    const blobConstructor = jest.spyOn(global, 'Blob').mockImplementation((parts, options) => new NativeBlob(parts, options));
    try {
      fireEvent.click(within(positions).getByRole('button', { name: 'Export CSV' }));
      const [[csv], options] = blobConstructor.mock.calls[0];
      expect(options).toEqual({ type: 'text/csv;charset=utf-8;' });
      const lines = csv.split('\n');
      expect(lines).toHaveLength(2);
      expect(lines[0]).toBe('Rank,Ticker,Name,Side,Weight % (NAV),Target % (NAV),+EV Exposure Labels,Exposure Ctrb,Resize (Shares),Price,Day G/L (%),Action');
      expect(lines[1]).toContain('1,TLT,"Treasury, ""long"" duration",Short,-3.00,-3.00,');
      expect(lines[1]).toMatch(/,0,100\.0000,,Hold$/);
      expect(csv).not.toContain('GLD');
      expect(csv).not.toContain('NEM');
      expect(anchorClick).toHaveBeenCalledTimes(1);
      expect(anchorClick.mock.instances[0]).toHaveAttribute('download', 'portfolio-construction-2026-09-10.csv');
      expect(createObjectURL).toHaveBeenCalledTimes(1);
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:portfolio-export-test');
    } finally {
      blobConstructor.mockRestore();
      anchorClick.mockRestore();
      if (originalCreate) Object.defineProperty(URL, 'createObjectURL', originalCreate);
      else delete URL.createObjectURL;
      if (originalRevoke) Object.defineProperty(URL, 'revokeObjectURL', originalRevoke);
      else delete URL.revokeObjectURL;
    }
    expect(MarketDataService.getSecurityRiskMetrics).toHaveBeenCalledTimes(1);
    expect(MarketDataService.getSecurityIntelligence).toHaveBeenCalledTimes(1);
  });
});

test('keeps Longs and Shorts as sibling panes in the split ledger', async () => {
  const { container } = render(<PortfolioBreakdown portfolioData={portfolioData} />);

  await waitFor(() => expect(MarketDataService.getSecurityIntelligence).toHaveBeenCalledTimes(1));

  const splitLedger = container.querySelector('.pcv2-ledger-split');
  expect(splitLedger).toBeInTheDocument();
  expect([...splitLedger.children]).toHaveLength(2);
  expect(splitLedger.children[0]).toHaveClass('pcv2-ledger-pane', 'pcv2-ledger-pane--long');
  expect(splitLedger.children[1]).toHaveClass('pcv2-ledger-pane', 'pcv2-ledger-pane--short');
  expect(within(splitLedger.children[0]).getByText(/^LONG \(3\)$/)).toBeInTheDocument();
  expect(within(splitLedger.children[1]).getByText(/^SHORT \(0\)$/)).toBeInTheDocument();
  expect(screen.queryByText(/Weights and targets are/)).not.toBeInTheDocument();
});

test('keeps the portfolio ledger mounted during initial live-data loading', () => {
  render(
    <PortfolioBreakdown portfolioData={null} isLoading />
  );

  expect(screen.queryByText('Loading portfolio data...')).not.toBeInTheDocument();
  expect(screen.getByText('Connecting to live portfolio…')).toHaveAttribute('role', 'status');
  expect(screen.getByText(/^LONG \(0\)$/)).toBeInTheDocument();
  expect(screen.getByText(/^SHORT \(0\)$/)).toBeInTheDocument();
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
    'Range',
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
    'Risk Range',
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
    expect(within(positionRow).getAllByRole('cell')).toHaveLength(11);
    expect(viewport).toHaveAttribute('data-layout', 'fit-columns');
    expect(table).toHaveAttribute('data-column-count', '11');
  });
});

test('batch-loads unique symbols and independently expands stable duplicate position rows', async () => {
  const onRefresh = jest.fn().mockResolvedValue(undefined);
  render(<PortfolioBreakdown portfolioData={portfolioData} onRefresh={onRefresh} />);

  await waitFor(() => expect(MarketDataService.getSecurityIntelligence).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(MarketDataService.getSecurityRiskMetrics).toHaveBeenCalledTimes(1));
  expect(MarketDataService.getSecurityIntelligence).toHaveBeenCalledWith(expect.objectContaining({
    symbols: ['GLD', 'NEM'],
    historyDays: 0,
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
    '13%',
    '6%',
    '8%',
    '10%',
    '9%',
    '9%',
    '7%',
    '9%',
    '14%',
    '8%',
    '7%',
  ]);

  fireEvent.click(screen.getByRole('button', { name: 'Refresh portfolio and research' }));
  await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(MarketDataService.getSecurityIntelligence).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(MarketDataService.getSecurityRiskMetrics).toHaveBeenCalledTimes(2));
  expect(MarketDataService.getSecurityIntelligence.mock.calls[1][0]).toEqual(expect.objectContaining({
    symbols: ['GLD', 'NEM'],
    historyDays: 0,
  }));

  const toggles = screen.getAllByRole('button', { name: 'Show research intelligence for GLD' });
  expect(toggles).toHaveLength(2);
  expect(toggles[0]).not.toHaveAttribute('aria-controls', toggles[1].getAttribute('aria-controls'));

  const firstExpandedRow = toggles[0].closest('.pcv2-ledger-row');
  const firstPane = firstExpandedRow.closest('.pcv2-ledger-pane-scroll');
  firstPane.scrollTop = 40;

  fireEvent.click(toggles[0]);
  expect(toggles[0]).toHaveAttribute('aria-expanded', 'true');
  expect(toggles[1]).toHaveAttribute('aria-expanded', 'false');
  expect(firstPane.scrollTop).toBe(40);
  expect(firstPane.querySelector('.pcv2-ledger-bottom-spacer')).not.toBeInTheDocument();

  const firstPanel = screen.getByLabelText('Research intelligence for GLD');
  await waitFor(() => expect(MarketDataService.getSecurityIntelligence).toHaveBeenCalledTimes(3));
  expect(MarketDataService.getSecurityIntelligence.mock.calls[2][0]).toEqual(expect.objectContaining({
    symbols: ['GLD', 'NEM'],
    historyDays: 5,
  }));
  expect(firstExpandedRow).toHaveClass('is-expanded');
  firstPane.scrollTop = 260;
  fireEvent.scroll(firstPane);
  expect(firstPane.scrollTop).toBe(260);

  await waitFor(() => expect(within(firstPanel).getAllByText('BULLISH').length).toBeGreaterThanOrEqual(2));
  expect(within(firstPanel).getAllByText('BULLISH').length).toBeGreaterThanOrEqual(2);
  expect(within(firstPanel).getByText('Levered products')).toBeInTheDocument();
  expect(within(firstPanel).getByRole('button', {
    name: 'View UGLD +2× details for GLD',
  })).toBeInTheDocument();
  expect(within(firstPanel).getByText('ADDED')).toBeInTheDocument();
  expect(within(firstPanel).getByLabelText(/Low price risk range$/)).toHaveTextContent('2,900');
  expect(within(firstPanel).getByLabelText(/High price risk range$/)).toHaveTextContent('3,010');
  expect(within(firstPanel).getByText('0.42')).toBeInTheDocument();
  await waitFor(() => expect(within(firstExpandedRow).getByRole('button', {
    name: 'Verify GLD position size calculation',
  })).toHaveTextContent('3.0–5.5%'));
  expect(within(firstPanel).getByText('+1.25')).toBeInTheDocument();
  expect(within(firstPanel).getByText('GVZ 18.25')).toBeInTheDocument();
  expect(within(firstPanel).getByText('-0.72')).toBeInTheDocument();
  expect(within(firstPanel).getByTitle('A stop reference requires verified IBKR average cost and historical ATR14.')).toHaveTextContent('—');
  expect(firstPanel.querySelector('.pcv2-intel-meta')).not.toBeInTheDocument();

  const decisionValues = within(firstPanel).getByLabelText('GLD decision intelligence');
  const [, tradeCell] = [...decisionValues.children];
  const betaCell = within(firstPanel).getByText('0.42').closest('.pcv2-intel-cell');
  const zScoreCell = within(firstPanel).getByText('+1.25').closest('.pcv2-intel-cell');
  expectCellProvenance(tradeCell, /Momo Tracker · [A-Z][a-z]{2} \d{1,2}/);
  expectCellProvenance(betaCell, /252D vs SPY · [A-Z][a-z]{2} \d{1,2}/);
  expectCellProvenance(zScoreCell, /Completed close · [A-Z][a-z]{2} \d{1,2}/);
  expect(within(betaCell).getByText('0.42')).toHaveClass('is-positive-strong');
  expect(within(zScoreCell).getByText('+1.25')).toHaveClass('is-positive');

  const betaTitle = within(firstPanel).getByRole('button', {
    name: 'Explain GLD beta calculation',
  });
  expect(betaTitle).toHaveTextContent('Beta');
  expect(within(firstPanel).getByLabelText('Decision intelligence headers')).toContainElement(betaTitle);
  expect(within(betaCell).queryByRole('button')).not.toBeInTheDocument();
  fireEvent.click(betaTitle);
  const betaDialog = screen.getByRole('dialog', { name: 'Beta calculation' });
  expect(within(betaDialog).getByText('Beta = covariance of GLD and SPY returns ÷ variance of SPY returns')).toBeInTheDocument();
  expect(within(betaDialog).getByText('0.004200 ÷ 0.01 = 0.42')).toBeInTheDocument();
  expect(within(betaDialog).getByText('252 aligned daily returns')).toBeInTheDocument();
  expect(betaDialog).toHaveTextContent('A 1% move in SPY has been associated with about a 0.42% move in GLD in the same direction, on average.');
  expect(betaDialog).not.toHaveTextContent('Verification only');
  fireEvent.click(within(betaDialog).getByRole('button', { name: 'Close calculation' }));
  expect(screen.queryByRole('dialog', { name: 'Beta calculation' })).not.toBeInTheDocument();

  expect(within(firstPanel).getByLabelText('Quad order 3 → 4 → 1 = 2')).toHaveTextContent('3›4›1=2');
  fireEvent.click(within(firstPanel).getByRole('button', { name: 'Explain GLD quad ranking' }));
  const quadDialog = screen.getByRole('dialog', { name: 'Quad +EV ranking' });
  expect(quadDialog).toHaveTextContent('GLD uses Gold');
  expect(quadDialog).toHaveTextContent('Equal entries share a rank');
  expect(quadDialog).toHaveTextContent('not evidence of a neutral return');
  fireEvent.click(within(quadDialog).getByRole('button', { name: 'Close calculation' }));

  expect(within(firstPanel).queryByText('Direct mention')).not.toBeInTheDocument();
  expect(within(firstPanel).queryByText('Inferred exposure')).not.toBeInTheDocument();
  expect(within(firstPanel).queryByText('Today’s references')).not.toBeInTheDocument();
  const callRow = within(firstPanel).getByText('The Call').closest('.pcv2-intel-reference-row');
  const macroRow = within(firstPanel).getByText('Macro Show').closest('.pcv2-intel-reference-row');
  expect(within(callRow).getByText('Gold remains a preferred long.')).toBeInTheDocument();
  expect(within(macroRow).getByText('N/A')).toBeInTheDocument();
  expect(within(macroRow).queryByRole('button', {
    name: 'View Macro Show context for GLD',
  })).not.toBeInTheDocument();
  expect(within(callRow).getByText(/^\d{2}:\d{2}$/)).toBeInTheDocument();
  expect(within(macroRow).getByText('—')).toBeInTheDocument();

  const primaryDecisionHeaders = within(firstPanel).getByLabelText('Decision intelligence headers');
  expect(within(primaryDecisionHeaders).getAllByText(/.+/).map((node) => node.textContent)).toEqual([
    'Tick',
    'Trade',
    'Trend',
    'Beta',
    'Factor Ctrb',
    'Quad +EV',
  ]);
  expect([...primaryDecisionHeaders.children]).toHaveLength(6);
  [...primaryDecisionHeaders.children].forEach((cell, index) => (
    expect(cell).toHaveClass(`pcv2-intel-span-${index < 4 ? 3 : 4}`)
  ));

  const primaryDecisionValues = within(firstPanel).getByLabelText('GLD decision intelligence');
  expect([...primaryDecisionValues.children]).toHaveLength(6);
  [...primaryDecisionValues.children].forEach((cell, index) => (
    expect(cell).toHaveClass(`pcv2-intel-span-${index < 4 ? 3 : 4}`)
  ));
  expect(within(primaryDecisionValues).getByText('+10.0%')).toBeInTheDocument();
  expect(within(primaryDecisionValues).getByLabelText(
    '+10.0% · Gold · signed % NAV · Current signed position contribution across the displayed +EV exposures.'
  )).toBeInTheDocument();

  const secondaryDecisionHeaders = within(firstPanel)
    .getByLabelText('Decision intelligence secondary headers');
  expect(within(secondaryDecisionHeaders).getAllByText(/.+/).map((node) => node.textContent)).toEqual([
    'Levered products',
    'Signal strength',
    'LRR',
    'HRR',
    'Other exposure',
    'Coverage',
  ]);
  expect([...secondaryDecisionHeaders.children]).toHaveLength(6);
  [...secondaryDecisionHeaders.children].forEach((cell, index) => (
    expect(cell).toHaveClass(`pcv2-intel-span-${[2, 3].includes(index) ? 2 : 4}`)
  ));

  const secondaryDecisionValues = within(firstPanel)
    .getByLabelText('GLD supplemental decision intelligence');
  expect([...secondaryDecisionValues.children]).toHaveLength(6);
  [...secondaryDecisionValues.children].forEach((cell, index) => (
    expect(cell).toHaveClass(`pcv2-intel-span-${[2, 3].includes(index) ? 2 : 4}`)
  ));

  const contextHeaders = within(firstPanel).getByLabelText('Market context headers');
  expect(within(contextHeaders).getAllByText(/.+/).map((node) => node.textContent)).toEqual([
    'Price Z-score · 20D',
    'Sizing ATR',
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
  secondPane.scrollTop = 75;

  fireEvent.click(toggles[1]);
  expect(screen.getAllByLabelText('Research intelligence for GLD')).toHaveLength(2);
  expect(secondPane.scrollTop).toBe(75);

  const scrollTopBeforeCollapse = firstPane.scrollTop;
  fireEvent.click(screen.getAllByRole('button', { name: 'Hide research intelligence for GLD' })[0]);
  expect(screen.getAllByLabelText('Research intelligence for GLD')).toHaveLength(1);
  expect(firstPane.scrollTop).toBe(scrollTopBeforeCollapse);

  fireEvent.click(screen.getByRole('button', { name: 'Hide research intelligence for GLD' }));
  expect(screen.queryByLabelText('Research intelligence for GLD')).not.toBeInTheDocument();
  expect(firstPane.scrollTop).toBe(scrollTopBeforeCollapse);
});

test('keeps research product and detail buttons synchronized without fetching on context toggles', async () => {
  render(<PortfolioBreakdown portfolioData={{
    ...portfolioData,
    holdings: [portfolioData.holdings[0]],
  }} />);
  await waitFor(() => expect(MarketDataService.getSecurityIntelligence).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole('button', { name: 'Show research intelligence for GLD' }));
  const panel = screen.getByLabelText('Research intelligence for GLD');
  await waitFor(() => expect(MarketDataService.getSecurityIntelligence).toHaveBeenCalledTimes(2));
  const productButton = within(panel).getByRole('button', { name: 'View The Call facts for GLD' });
  const detailButton = within(panel).getByRole('button', { name: 'View The Call context for GLD' });
  const contextId = productButton.getAttribute('aria-controls');
  expect(detailButton).toHaveAttribute('aria-controls', contextId);
  expect(productButton).toHaveAttribute('aria-expanded', 'false');
  expect(detailButton).toHaveAttribute('aria-expanded', 'false');

  fireEvent.click(productButton);
  expect(productButton).toHaveAttribute('aria-expanded', 'true');
  expect(detailButton).toHaveAttribute('aria-expanded', 'true');
  expect(productButton).toHaveAccessibleName('Collapse The Call facts for GLD');
  expect(detailButton).toHaveAccessibleName('Collapse The Call context for GLD');
  const context = within(panel).getByRole('region', { name: 'The Call facts for GLD' });
  expect(context).toHaveAttribute('id', contextId);
  const sourceLink = within(context).getByRole('link', { name: 'OPEN SOURCE ↗' });
  expect(sourceLink).toHaveAttribute('href', '/research/the-call/direct-1');
  expect(sourceLink).toHaveAttribute('target', '_blank');
  expect(sourceLink).toHaveAttribute('rel', 'noreferrer');

  fireEvent.click(detailButton);
  expect(productButton).toHaveAttribute('aria-expanded', 'false');
  expect(detailButton).toHaveAttribute('aria-expanded', 'false');
  expect(within(panel).queryByRole('region', { name: 'The Call facts for GLD' })).not.toBeInTheDocument();
  fireEvent.click(detailButton);
  expect(productButton).toHaveAttribute('aria-expanded', 'true');
  fireEvent.click(productButton);
  expect(detailButton).toHaveAttribute('aria-expanded', 'false');
  expect(MarketDataService.getSecurityIntelligence).toHaveBeenCalledTimes(2);
});

test('preserves independent duplicate-position product contexts through reorder, collapse, and filtering', async () => {
  const view = render(<PortfolioBreakdown portfolioData={portfolioData} />);
  await waitFor(() => expect(MarketDataService.getSecurityIntelligence).toHaveBeenCalledTimes(1));
  const toggles = screen.getAllByRole('button', { name: 'Show research intelligence for GLD' });
  const [firstPanelId, secondPanelId] = toggles.map((button) => button.getAttribute('aria-controls'));
  fireEvent.click(toggles[0]);
  await waitFor(() => expect(MarketDataService.getSecurityIntelligence).toHaveBeenCalledTimes(2));
  fireEvent.click(toggles[1]);
  const firstPanel = document.getElementById(firstPanelId);
  const secondPanel = document.getElementById(secondPanelId);
  fireEvent.click(within(firstPanel).getByRole('button', { name: 'View The Call facts for GLD' }));
  expect(within(firstPanel).getByRole('region', { name: 'The Call facts for GLD' })).toBeInTheDocument();
  expect(within(secondPanel).queryByRole('region', { name: 'The Call facts for GLD' })).not.toBeInTheDocument();
  expect(within(firstPanel).getByRole('button', { name: 'Collapse The Call facts for GLD' }))
    .not.toHaveAttribute('aria-controls', within(secondPanel).getByRole('button', {
      name: 'View The Call facts for GLD',
    }).getAttribute('aria-controls'));

  view.rerender(<PortfolioBreakdown portfolioData={{
    ...portfolioData,
    holdings: [...portfolioData.holdings].reverse().map((holding) => (
      holding.accountId === 'U2' ? { ...holding, marketValue: 15000 } : holding
    )),
  }} />);
  expect(screen.getAllByLabelText('Research intelligence for GLD').map((panel) => panel.id))
    .toEqual([secondPanelId, firstPanelId]);
  expect(within(document.getElementById(firstPanelId)).getByRole('region', {
    name: 'The Call facts for GLD',
  })).toBeInTheDocument();
  expect(within(document.getElementById(secondPanelId)).queryByRole('region', {
    name: 'The Call facts for GLD',
  })).not.toBeInTheDocument();

  const firstToggle = screen.getAllByRole('button', { name: 'Hide research intelligence for GLD' })
    .find((button) => button.getAttribute('aria-controls') === firstPanelId);
  fireEvent.click(firstToggle);
  expect(document.getElementById(firstPanelId)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Show research intelligence for GLD' }));
  expect(within(document.getElementById(firstPanelId)).getByRole('region', {
    name: 'The Call facts for GLD',
  })).toBeInTheDocument();

  const search = screen.getByPlaceholderText('Search ticker or name...');
  fireEvent.change(search, { target: { value: 'NEM' } });
  expect(screen.queryByLabelText('Research intelligence for GLD')).not.toBeInTheDocument();
  fireEvent.change(search, { target: { value: '' } });
  expect(within(document.getElementById(firstPanelId)).getByRole('region', {
    name: 'The Call facts for GLD',
  })).toBeInTheDocument();
  expect(within(document.getElementById(secondPanelId)).queryByRole('region', {
    name: 'The Call facts for GLD',
  })).not.toBeInTheDocument();
  expect(MarketDataService.getSecurityIntelligence).toHaveBeenCalledTimes(2);
});

test('hides an expanded product context when a changed research scope is unavailable and restores it on recovery', async () => {
  const view = render(<PortfolioBreakdown portfolioData={{
    ...portfolioData,
    holdings: [portfolioData.holdings[0]],
  }} />);
  await waitFor(() => expect(MarketDataService.getSecurityIntelligence).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole('button', { name: 'Show research intelligence for GLD' }));
  const panel = screen.getByLabelText('Research intelligence for GLD');
  await waitFor(() => expect(MarketDataService.getSecurityIntelligence).toHaveBeenCalledTimes(2));
  fireEvent.click(within(panel).getByRole('button', { name: 'View The Call context for GLD' }));
  const contextId = within(panel).getByRole('region', { name: 'The Call facts for GLD' }).id;

  const unavailableEnvelope = currentEnvelope();
  unavailableEnvelope.products = unavailableEnvelope.products.map((product) => (
    product.id === 'the-call' ? { ...product, status: 'missing' } : product
  ));
  unavailableEnvelope.bySymbol.GLD.directReferences = [];
  MarketDataService.getSecurityIntelligence.mockResolvedValue(unavailableEnvelope);
  view.rerender(<PortfolioBreakdown portfolioData={{
    ...portfolioData,
    holdings: [portfolioData.holdings[0], portfolioData.holdings[2]],
  }} />);
  await waitFor(() => expect(within(panel).getByText('The Call').closest('.pcv2-intel-reference-row'))
    .toHaveTextContent('UNAVAILABLE'));
  const unavailableRow = within(panel).getByText('The Call').closest('.pcv2-intel-reference-row');
  expect(unavailableRow).toHaveClass('is-unavailable');
  expect(within(unavailableRow).queryByRole('button')).not.toBeInTheDocument();
  expect(within(panel).queryByRole('region', { name: 'The Call facts for GLD' })).not.toBeInTheDocument();
  expect(within(panel).queryByRole('link', { name: 'OPEN SOURCE ↗' })).not.toBeInTheDocument();

  MarketDataService.getSecurityIntelligence.mockResolvedValue(currentEnvelope());
  view.rerender(<PortfolioBreakdown portfolioData={{
    ...portfolioData,
    holdings: [portfolioData.holdings[0]],
  }} />);
  const restoredContext = await within(panel).findByRole('region', { name: 'The Call facts for GLD' });
  expect(restoredContext).toHaveAttribute('id', contextId);
  expect(within(panel).getByRole('button', { name: 'Collapse The Call facts for GLD' }))
    .toHaveAttribute('aria-expanded', 'true');
  expect(within(panel).getByRole('button', { name: 'Collapse The Call context for GLD' }))
    .toHaveAttribute('aria-expanded', 'true');
});

describe('decision metrics presentation callbacks', () => {
  let quadRequest;
  const betaEnvelope = (overrides = {}) => ({
    status: 'available',
    historicalOnly: true,
    executable: false,
    generatedAt: '2026-09-10T18:00:00.000Z',
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
          asOf: '2026-09-09',
          calculation: { covarianceSum: 0.0042, benchmarkVarianceSum: 0.01 },
          ...overrides,
        },
      },
      NEM: {
        symbol: 'NEM',
        historicalOnly: true,
        executable: false,
        beta: { status: 'unavailable', value: null },
      },
    },
  });
  const openBeta = (panel, symbol) => {
    fireEvent.click(within(panel).getByRole('button', {
      name: `Explain ${symbol} beta calculation`,
    }));
    return screen.getByRole('dialog', { name: 'Beta calculation' });
  };
  const closeBeta = (dialog) => {
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close calculation' }));
  };

  beforeEach(() => {
    jest.useFakeTimers({
      now: new Date('2026-09-10T18:00:00.000Z'),
      doNotFake: ['nextTick', 'performance', 'queueMicrotask', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    });
    // Deterministic historical-only fixtures; these callbacks do not supply executable quotes.
    quadRequest = jest.spyOn(axios, 'get').mockResolvedValue({ data: {} });
    MarketDataService.getSecurityIntelligence.mockResolvedValue(currentEnvelope());
    MarketDataService.getSecurityRiskMetrics.mockResolvedValue(betaEnvelope());
    MarketDataService.getVolatilitySnapshot.mockResolvedValue({});
    MarketDataService.getUsdCorrelations.mockResolvedValue({});
  });

  afterEach(() => {
    quadRequest.mockRestore();
    jest.useRealTimers();
  });

  test('dispatches the correct symbol from duplicate-position beta headers after rows reorder', async () => {
    const view = render(<PortfolioBreakdown portfolioData={portfolioData} />);
    await waitFor(() => expect(MarketDataService.getSecurityRiskMetrics).toHaveBeenCalledTimes(1));
    const toggles = screen.getAllByRole('button', { name: 'Show research intelligence for GLD' });
    const panelIds = toggles.map((button) => button.getAttribute('aria-controls'));
    fireEvent.click(toggles[0]);
    fireEvent.click(toggles[1]);
    fireEvent.click(screen.getByRole('button', { name: 'Show research intelligence for NEM' }));
    await act(async () => { await Promise.resolve(); });

    view.rerender(<PortfolioBreakdown portfolioData={{
      ...portfolioData,
      holdings: [...portfolioData.holdings].reverse().map((holding) => (
        holding.accountId === 'U2' ? { ...holding, marketValue: 15000 } : holding
      )),
    }} />);
    expect(screen.getAllByLabelText('Research intelligence for GLD').map((panel) => panel.id))
      .toEqual([...panelIds].reverse());

    for (const panelId of panelIds) {
      const panel = document.getElementById(panelId);
      const betaCell = within(panel).getByLabelText('GLD decision intelligence').children[3];
      expect(betaCell).toHaveTextContent('0.42');
      expect(within(betaCell).queryByRole('button')).not.toBeInTheDocument();
      const dialog = openBeta(panel, 'GLD');
      expect(dialog).toHaveTextContent('Beta = covariance of GLD and SPY returns ÷ variance of SPY returns');
      expect(dialog).toHaveTextContent('0.004200 ÷ 0.01 = 0.42');
      closeBeta(dialog);
    }

    const otherDialog = openBeta(screen.getByLabelText('Research intelligence for NEM'), 'NEM');
    expect(otherDialog).toHaveTextContent('Beta = covariance of NEM and SPY returns ÷ variance of SPY returns');
    expect(otherDialog).toHaveTextContent('Not calculated — verified aligned return history is unavailable.');
    expect(otherDialog).not.toHaveTextContent('0.004200');
    expect(otherDialog).not.toHaveTextContent('GLD');
    closeBeta(otherDialog);
  });

  test('reopens the beta explanation with refreshed inputs and the updated cell tone', async () => {
    render(<PortfolioBreakdown portfolioData={{ ...portfolioData, holdings: [portfolioData.holdings[0]] }} />);
    await waitFor(() => expect(MarketDataService.getSecurityRiskMetrics).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'Show research intelligence for GLD' }));
    const panel = screen.getByLabelText('Research intelligence for GLD');
    const betaCell = within(panel).getByLabelText('GLD decision intelligence').children[3];
    await waitFor(() => expect(betaCell).toHaveTextContent('0.42'));
    const initialDialog = openBeta(panel, 'GLD');
    expect(initialDialog).toHaveTextContent('0.004200 ÷ 0.01 = 0.42');
    closeBeta(initialDialog);

    MarketDataService.getSecurityRiskMetrics.mockResolvedValue(betaEnvelope({
      value: 1.75,
      benchmark: 'QQQ',
      windowSessions: 126,
      observations: 126,
      asOf: '2026-09-10',
      calculation: { covarianceSum: 0.0175, benchmarkVarianceSum: 0.01 },
    }));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh portfolio and research' }));
    await waitFor(() => expect(betaCell).toHaveTextContent('1.75'));
    expect(within(betaCell).getByText('1.75')).toHaveClass('is-negative');
    expectCellProvenance(betaCell, /126D vs QQQ · Sep 10/);
    const refreshedDialog = openBeta(panel, 'GLD');
    expect(refreshedDialog).toHaveTextContent('Beta = covariance of GLD and QQQ returns ÷ variance of QQQ returns');
    expect(refreshedDialog).toHaveTextContent('0.0175 ÷ 0.01 = 1.75');
    expect(refreshedDialog).toHaveTextContent('126 aligned daily returns');
    expect(refreshedDialog).toHaveTextContent('As of Sep 10');
    expect(refreshedDialog).toHaveTextContent('1.75% move in GLD in the same direction');
    expect(refreshedDialog).not.toHaveTextContent('0.004200');
    expect(refreshedDialog).not.toHaveTextContent('SPY');
    closeBeta(refreshedDialog);
  });

  test('calculation popup keeps a beta click-time snapshot until it is closed and reopened', async () => {
    render(<PortfolioBreakdown portfolioData={{ ...portfolioData, holdings: [portfolioData.holdings[0]] }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show research intelligence for GLD' }));
    const panel = screen.getByLabelText('Research intelligence for GLD');
    const betaCell = within(panel).getByLabelText('GLD decision intelligence').children[3];
    await waitFor(() => expect(betaCell).toHaveTextContent('0.42'));
    const initialDialog = openBeta(panel, 'GLD');
    const initialExplanation = initialDialog.textContent;
    expect(initialDialog).toHaveTextContent('0.004200 ÷ 0.01 = 0.42');

    MarketDataService.getSecurityRiskMetrics.mockResolvedValue(betaEnvelope({
      value: 1.75,
      benchmark: 'QQQ',
      windowSessions: 126,
      observations: 126,
      asOf: '2026-09-10',
      calculation: { covarianceSum: 0.0175, benchmarkVarianceSum: 0.01 },
    }));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh portfolio and research' }));
    await waitFor(() => expect(betaCell).toHaveTextContent('1.75'));
    expectCellProvenance(betaCell, /126D vs QQQ · Sep 10/);
    expect(screen.getByRole('dialog', { name: 'Beta calculation' })).toBe(initialDialog);
    expect(initialDialog.textContent).toBe(initialExplanation);
    expect(initialDialog).not.toHaveTextContent('QQQ');

    closeBeta(initialDialog);
    const reopenedDialog = openBeta(panel, 'GLD');
    expect(reopenedDialog).toHaveTextContent('0.0175 ÷ 0.01 = 1.75');
    expect(reopenedDialog).toHaveTextContent('126 aligned daily returns');
    expect(reopenedDialog).toHaveTextContent('QQQ');
    expect(reopenedDialog).not.toHaveTextContent('0.004200');
    closeBeta(reopenedDialog);
    await act(async () => { await Promise.resolve(); });
  });

  test('calculation popup hides with its surface and restores its selection after a hidden Escape', async () => {
    const data = { ...portfolioData, holdings: [portfolioData.holdings[0]] };
    const view = render(
      <PersistentSurface active>
        <PortfolioBreakdown portfolioData={data} />
      </PersistentSurface>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Show research intelligence for GLD' }));
    const panel = screen.getByLabelText('Research intelligence for GLD');
    await waitFor(() => expect(within(panel).getByLabelText('GLD decision intelligence').children[3])
      .toHaveTextContent('0.42'));
    const initialDialog = openBeta(panel, 'GLD');
    const initialExplanation = initialDialog.textContent;
    expect(within(initialDialog).getByRole('button', { name: 'Close calculation' })).toHaveFocus();

    view.rerender(
      <PersistentSurface active={false}>
        <PortfolioBreakdown portfolioData={data} />
      </PersistentSurface>,
    );
    expect(screen.queryByRole('dialog', { name: 'Beta calculation' })).not.toBeInTheDocument();
    expect(document.querySelector('.pcv2-verification-backdrop')).not.toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });

    view.rerender(
      <PersistentSurface active>
        <PortfolioBreakdown portfolioData={data} />
      </PersistentSurface>,
    );
    const restoredDialog = screen.getByRole('dialog', { name: 'Beta calculation' });
    expect(restoredDialog.textContent).toBe(initialExplanation);
    expect(within(restoredDialog).getByRole('button', { name: 'Close calculation' })).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Beta calculation' })).not.toBeInTheDocument();
    await act(async () => { await Promise.resolve(); });
  });

  test('calculation popup portals to the body, focuses close, and only dismisses outside mousedown', async () => {
    const { container } = render(<PortfolioBreakdown portfolioData={{
      ...portfolioData,
      holdings: [portfolioData.holdings[0]],
    }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show research intelligence for GLD' }));
    const panel = screen.getByLabelText('Research intelligence for GLD');
    await waitFor(() => expect(within(panel).getByLabelText('GLD decision intelligence').children[3])
      .toHaveTextContent('0.42'));
    await act(async () => { await Promise.resolve(); });
    const providerCalls = () => [
      MarketDataService.getSecurityIntelligence.mock.calls.length,
      MarketDataService.getSecurityRiskMetrics.mock.calls.length,
      MarketDataService.getVolatilitySnapshot.mock.calls.length,
      MarketDataService.getUsdCorrelations.mock.calls.length,
    ];
    const callsBeforeOpening = providerCalls();
    const dialog = openBeta(panel, 'GLD');
    const backdrop = dialog.parentElement;
    expect(backdrop).toHaveClass('pcv2-verification-backdrop');
    expect(backdrop.parentElement).toBe(document.body);
    expect(container).not.toContainElement(dialog);
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(within(dialog).getByRole('button', { name: 'Close calculation' })).toHaveFocus();

    fireEvent.mouseDown(within(dialog).getByRole('heading', { name: 'Beta calculation' }));
    expect(screen.getByRole('dialog', { name: 'Beta calculation' })).toBe(dialog);
    fireEvent.keyDown(document, { key: 'Enter' });
    expect(screen.getByRole('dialog', { name: 'Beta calculation' })).toBe(dialog);
    fireEvent.mouseDown(backdrop);
    expect(screen.queryByRole('dialog', { name: 'Beta calculation' })).not.toBeInTheDocument();
    expect(backdrop).not.toBeInTheDocument();

    const reopenedDialog = openBeta(panel, 'GLD');
    closeBeta(reopenedDialog);
    expect(screen.queryByRole('dialog', { name: 'Beta calculation' })).not.toBeInTheDocument();
    expect(providerCalls()).toEqual(callsBeforeOpening);
  });
});

describe('market context presentation callbacks', () => {
  let quadRequest;
  let riskPayload;
  const fixedNow = '2026-09-10T18:00:00.000Z';
  const singlePosition = { ...portfolioData, holdings: [portfolioData.holdings[0]] };

  beforeEach(async () => {
    jest.useFakeTimers({
      now: new Date(fixedNow),
      doNotFake: ['nextTick', 'performance', 'queueMicrotask', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    });
    quadRequest = jest.spyOn(axios, 'get').mockResolvedValue({ data: {} });
    // Source-attributed historical fixtures remain confined to this test suite.
    riskPayload = await MarketDataService.getSecurityRiskMetrics();
    riskPayload.generatedAt = fixedNow;
    riskPayload.rows.GLD.asOf = expectedSizingSession();
    riskPayload.rows.GLD.provenance.security.fetchedAt = fixedNow;
    riskPayload.rows.GLD.atr14.asOf = expectedSizingSession();
    riskPayload.rows.GLD.referencePrice.asOf = expectedSizingSession();
    riskPayload.rows.GLD.referencePrice.timestamp = Date.parse(`${expectedSizingSession()}T13:30:00.000Z`);
    riskPayload.rows.GLD.realizedVolatility.asOf = expectedSizingSession();
    MarketDataService.getSecurityRiskMetrics.mockClear();
    MarketDataService.getSecurityRiskMetrics.mockResolvedValue(riskPayload);
    MarketDataService.getSecurityIntelligence.mockResolvedValue(currentEnvelope());
    MarketDataService.getVolatilitySnapshot.mockResolvedValue({});
    MarketDataService.getUsdCorrelations.mockResolvedValue({});
  });

  afterEach(() => {
    quadRequest.mockRestore();
    jest.useRealTimers();
  });

  test('shows the Floor badge for an ATR below 1.25% of price and removes its control after refresh failure', async () => {
    // ATR 2 on a 200 close = 1.00% < 1.25%: the band uses the floor (stop 2.50% →
    // MIN 0.125 / 0.025 = 5, MAX 0.25 / 0.025 = 10); the stop uses 2 × 1.00% = 2.00%.
    riskPayload.rows.GLD.atr14 = { ...riskPayload.rows.GLD.atr14, value: 2 };
    render(<PortfolioBreakdown portfolioData={singlePosition} />);
    await waitFor(() => expect(MarketDataService.getSecurityRiskMetrics).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'Show research intelligence for GLD' }));
    const panel = screen.getByLabelText('Research intelligence for GLD');
    const sizingCell = within(panel).getByLabelText('GLD market context').children[1];
    const button = await within(sizingCell).findByRole('button', { name: 'Verify GLD sizing ATR' });
    expect(button).toHaveTextContent('1.00%Floor');
    expect(within(button).getByText('Floor')).toHaveClass('pcv2-vol-badge', 'is-limited');
    expectCellProvenance(sizingCell, /ATR14 ÷ close · Sep 9 · 1\.25% floor/);
    expect(sizingCell).toHaveClass('is-reference');
    expect(screen.getByRole('button', { name: 'Verify GLD position size calculation' })).toHaveTextContent('5.0–10.0%');

    fireEvent.click(button);
    const dialog = screen.getByRole('dialog', { name: 'Sizing ATR calculation' });
    expect(dialog).toHaveTextContent('ATR % = ATR14 ÷ close; stop distance = 2 × ATR %');
    expect(dialog).toHaveTextContent('ATR14 = 2.00 · Close = 200.00 · ATR % = 1.00% · Stop distance = 2.00%');
    expect(dialog).toHaveTextContent('1.00% of price');
    expect(dialog).toHaveTextContent('Below the 1.25% floor: the floor sets MIN / MAX; the stop uses the measured ATR.');
    expect(dialog).toHaveTextContent('Completed daily bars through 2026-09-09.');
    expect(dialog).toHaveTextContent('Reference-only / non-executable.');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close calculation' }));

    MarketDataService.getSecurityRiskMetrics.mockRejectedValue(new Error('Provider disconnected'));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh portfolio and research' }));
    await waitFor(() => expect(sizingCell).toHaveTextContent('Unavailable'));
    expect(within(sizingCell).queryByRole('button')).not.toBeInTheDocument();
    expect(within(sizingCell).queryByText('Floor')).not.toBeInTheDocument();
    expect(sizingCell).not.toHaveClass('is-reference');
  });

  test('keeps a sizing-ATR explanation snapshot through refresh until it is reopened', async () => {
    render(<PortfolioBreakdown portfolioData={singlePosition} />);
    await waitFor(() => expect(MarketDataService.getSecurityRiskMetrics).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'Show research intelligence for GLD' }));
    const panel = screen.getByLabelText('Research intelligence for GLD');
    const sizingCell = within(panel).getByLabelText('GLD market context').children[1];
    const button = await within(sizingCell).findByRole('button', { name: 'Verify GLD sizing ATR' });
    // 4.5 / 200 = 2.25%.
    expect(button).toHaveTextContent('2.25%');
    expect(within(button).queryByText('Floor')).not.toBeInTheDocument();
    expectCellProvenance(sizingCell, /ATR14 ÷ close · Sep 9/);
    await waitFor(() => expect(MarketDataService.getSecurityIntelligence).toHaveBeenCalledTimes(2));
    await act(async () => { await Promise.resolve(); });
    const providerCalls = () => [
      MarketDataService.getSecurityIntelligence.mock.calls.length,
      MarketDataService.getSecurityRiskMetrics.mock.calls.length,
      MarketDataService.getVolatilitySnapshot.mock.calls.length,
      MarketDataService.getUsdCorrelations.mock.calls.length,
    ];
    const callsBeforeOpening = providerCalls();

    fireEvent.click(button);
    const initialDialog = screen.getByRole('dialog', { name: 'Sizing ATR calculation' });
    const initialExplanation = initialDialog.textContent;
    expect(initialDialog).toHaveTextContent('ATR14 = 4.50 · Close = 200.00 · ATR % = 2.25% · Stop distance = 4.50%');
    expect(initialDialog).toHaveTextContent('Reference-only / non-executable.');
    expect(providerCalls()).toEqual(callsBeforeOpening);

    // After the 16:15 New York allowance the Sep 10 session is complete.
    const refreshedAt = '2026-09-10T21:00:00.000Z';
    jest.setSystemTime(new Date(refreshedAt));
    const refreshedSession = expectedSizingSession();
    const refreshedRiskPayload = {
      ...riskPayload,
      generatedAt: refreshedAt,
      rows: {
        ...riskPayload.rows,
        GLD: {
          ...riskPayload.rows.GLD,
          asOf: refreshedSession,
          provenance: {
            ...riskPayload.rows.GLD.provenance,
            security: { ...riskPayload.rows.GLD.provenance.security, fetchedAt: refreshedAt },
          },
          // 7.2 / 240 = 3.00%; stop = 6.00%.
          atr14: { ...riskPayload.rows.GLD.atr14, value: 7.2, asOf: refreshedSession },
          referencePrice: {
            ...riskPayload.rows.GLD.referencePrice,
            value: 240,
            asOf: refreshedSession,
            timestamp: Date.parse(`${refreshedSession}T13:30:00.000Z`),
          },
        },
      },
    };
    MarketDataService.getSecurityRiskMetrics.mockResolvedValue(refreshedRiskPayload);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh portfolio and research' }));
    await waitFor(() => expect(sizingCell).toHaveTextContent('3.00%'));
    expectCellProvenance(sizingCell, /ATR14 ÷ close · Sep 10/);
    expect(screen.getByRole('dialog', { name: 'Sizing ATR calculation' })).toBe(initialDialog);
    expect(initialDialog.textContent).toBe(initialExplanation);
    expect(initialDialog).not.toHaveTextContent('Completed daily bars through 2026-09-10.');
    await waitFor(() => expect(MarketDataService.getSecurityIntelligence).toHaveBeenCalledTimes(4));
    expect(MarketDataService.getSecurityIntelligence.mock.calls[3][0]).toEqual(expect.objectContaining({ historyDays: 5 }));
    await act(async () => { await Promise.resolve(); });
    const callsAfterRefresh = providerCalls();

    fireEvent.click(within(initialDialog).getByRole('button', { name: 'Close calculation' }));
    fireEvent.click(within(sizingCell).getByRole('button', { name: 'Verify GLD sizing ATR' }));
    const reopenedDialog = screen.getByRole('dialog', { name: 'Sizing ATR calculation' });
    expect(reopenedDialog).toHaveTextContent('ATR14 = 7.20 · Close = 240.00 · ATR % = 3.00% · Stop distance = 6.00%');
    expect(reopenedDialog).toHaveTextContent('3.00% of price');
    expect(reopenedDialog).toHaveTextContent('Completed daily bars through 2026-09-10.');
    expect(reopenedDialog).toHaveTextContent('Reference-only / non-executable.');
    expect(reopenedDialog).not.toHaveTextContent('2.25%');
    fireEvent.click(within(reopenedDialog).getByRole('button', { name: 'Close calculation' }));
    expect(screen.queryByRole('dialog', { name: 'Sizing ATR calculation' })).not.toBeInTheDocument();
    expect(providerCalls()).toEqual(callsAfterRefresh);
  });

  test('stop explanation keeps its click-time snapshot through basis and ATR updates until reopened', async () => {
    const positions = {
      ...singlePosition,
      liveSessionVerified: true,
      accountSummary: { netLiquidation: 100000, source: 'ibkr_live_session' },
      holdings: [{
        ...singlePosition.holdings[0],
        avgCost: 200,
        positionSource: 'ibkr_live_session',
        priceState: 'live',
      }],
    };
    const initialRiskPayload = {
      ...riskPayload,
      rows: {
        ...riskPayload.rows,
        GLD: {
          ...riskPayload.rows.GLD,
          atr14: { ...riskPayload.rows.GLD.atr14, asOf: '2026-09-09' },
        },
      },
    };
    MarketDataService.getSecurityRiskMetrics.mockResolvedValue(initialRiskPayload);
    const view = render(<PortfolioBreakdown portfolioData={positions} />);
    await waitFor(() => expect(MarketDataService.getSecurityRiskMetrics).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'Show research intelligence for GLD' }));
    const panel = screen.getByLabelText('Research intelligence for GLD');
    const stopCell = within(panel).getByLabelText('GLD market context').children[4];
    await waitFor(() => expect(stopCell).toHaveTextContent('191.00'));
    await waitFor(() => expect(MarketDataService.getSecurityIntelligence).toHaveBeenCalledTimes(2));
    await act(async () => { await Promise.resolve(); });
    const providerCalls = () => [
      MarketDataService.getSecurityIntelligence.mock.calls.length,
      MarketDataService.getSecurityRiskMetrics.mock.calls.length,
      MarketDataService.getVolatilitySnapshot.mock.calls.length,
      MarketDataService.getUsdCorrelations.mock.calls.length,
    ];
    const callsBeforeOpening = providerCalls();

    fireEvent.click(within(stopCell).getByRole('button', { name: 'Verify GLD stop loss calculation' }));
    const initialDialog = screen.getByRole('dialog', { name: 'Stop loss calculation' });
    const initialExplanation = initialDialog.textContent;
    expect(initialDialog).toHaveTextContent('$200.00 − (2 × $4.50) = $191.00');
    expect(initialDialog).toHaveTextContent('Long position');
    expect(providerCalls()).toEqual(callsBeforeOpening);

    view.rerender(<PortfolioBreakdown portfolioData={{
      ...positions,
      holdings: positions.holdings.map((holding) => ({ ...holding, avgCost: 220 })),
    }} />);
    expect(stopCell).toHaveTextContent('211.00');
    expect(initialDialog.textContent).toBe(initialExplanation);
    expect(providerCalls()).toEqual(callsBeforeOpening);

    MarketDataService.getSecurityRiskMetrics.mockResolvedValue({
      ...initialRiskPayload,
      rows: {
        ...initialRiskPayload.rows,
        GLD: {
          ...initialRiskPayload.rows.GLD,
          atr14: { ...initialRiskPayload.rows.GLD.atr14, value: 6 },
        },
      },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh portfolio and research' }));
    await waitFor(() => expect(stopCell).toHaveTextContent('208.00'));
    expect(stopCell).toHaveClass('is-reference');
    expectCellProvenance(stopCell, /IBKR basis · 2×ATR14 · Sep 9 · reference only/);
    expect(screen.getByRole('dialog', { name: 'Stop loss calculation' })).toBe(initialDialog);
    expect(initialDialog.textContent).toBe(initialExplanation);
    await waitFor(() => expect(MarketDataService.getSecurityIntelligence).toHaveBeenCalledTimes(4));
    await act(async () => { await Promise.resolve(); });
    const callsAfterRefresh = providerCalls();

    fireEvent.click(within(initialDialog).getByRole('button', { name: 'Close calculation' }));
    fireEvent.click(within(stopCell).getByRole('button', { name: 'Verify GLD stop loss calculation' }));
    const reopenedDialog = screen.getByRole('dialog', { name: 'Stop loss calculation' });
    expect(reopenedDialog).toHaveTextContent('$220.00 − (2 × $6.00) = $208.00');
    expect(reopenedDialog).toHaveTextContent('Verified IBKR average cost');
    expect(reopenedDialog).not.toHaveTextContent('$191.00');
    expect(reopenedDialog).not.toHaveTextContent('$4.50');
    fireEvent.click(within(reopenedDialog).getByRole('button', { name: 'Close calculation' }));
    expect(screen.queryByRole('dialog', { name: 'Stop loss calculation' })).not.toBeInTheDocument();
    expect(providerCalls()).toEqual(callsAfterRefresh);
  });

  test('stop explanation keeps an unavailable short reference clickable and distinguishes missing basis from missing ATR', async () => {
    const positions = {
      ...singlePosition,
      liveSessionVerified: true,
      accountSummary: { netLiquidation: 100000, source: 'ibkr_live_session' },
      holdings: [{
        ...singlePosition.holdings[0],
        quantity: -25,
        marketValue: -5000,
        positionSource: 'ibkr_live_session',
        priceState: 'live',
      }],
    };
    const view = render(<PortfolioBreakdown portfolioData={positions} />);
    await waitFor(() => expect(MarketDataService.getSecurityRiskMetrics).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'Show research intelligence for GLD' }));
    const panel = screen.getByLabelText('Research intelligence for GLD');
    const stopCell = within(panel).getByLabelText('GLD market context').children[4];
    await waitFor(() => expectCellProvenance(stopCell, /Verified IBKR average cost required/));
    expect(stopCell).toHaveTextContent('—');
    expect(stopCell).not.toHaveClass('is-reference');
    const missingBasisButton = within(stopCell).getByRole('button', { name: 'Verify GLD stop loss calculation' });
    expect(missingBasisButton).toBeEnabled();
    fireEvent.click(missingBasisButton);
    const missingBasisDialog = screen.getByRole('dialog', { name: 'Stop loss calculation' });
    expect(missingBasisDialog).toHaveTextContent('Stop = average cost + (2 × ATR14)');
    expect(missingBasisDialog).toHaveTextContent('Not calculated — verified IBKR average cost and ATR14 are required.');
    expect(missingBasisDialog).toHaveTextContent('ResultUnavailable');
    expect(missingBasisDialog).toHaveTextContent('No executable stop is created; this is a reference check only.');
    fireEvent.click(within(missingBasisDialog).getByRole('button', { name: 'Close calculation' }));
    await waitFor(() => expect(MarketDataService.getSecurityIntelligence).toHaveBeenCalledTimes(2));
    await act(async () => { await Promise.resolve(); });

    MarketDataService.getSecurityRiskMetrics.mockResolvedValue({
      ...riskPayload,
      rows: {
        ...riskPayload.rows,
        GLD: {
          ...riskPayload.rows.GLD,
          atr14: { status: 'unavailable', value: null },
        },
      },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh portfolio and research' }));
    await waitFor(() => expectCellProvenance(stopCell, /ATR14 reference unavailable/));
    view.rerender(<PortfolioBreakdown portfolioData={{
      ...positions,
      holdings: positions.holdings.map((holding) => ({ ...holding, avgCost: 200 })),
    }} />);
    expectCellProvenance(stopCell, /ATR14 reference unavailable/);
    expect(stopCell).toHaveTextContent('—');
    expect(stopCell).not.toHaveClass('is-reference');
    const missingAtrButton = within(stopCell).getByRole('button', { name: 'Verify GLD stop loss calculation' });
    expect(missingAtrButton).toBeEnabled();
    fireEvent.click(missingAtrButton);
    const missingAtrDialog = screen.getByRole('dialog', { name: 'Stop loss calculation' });
    expect(missingAtrDialog).toHaveTextContent('Stop = average cost + (2 × ATR14)');
    expect(missingAtrDialog).toHaveTextContent('Not calculated — verified IBKR average cost and ATR14 are required.');
    expect(missingAtrDialog).toHaveTextContent('ResultUnavailable');
    expect(missingAtrDialog).not.toHaveTextContent('$200.00');
    expect(missingAtrDialog).toHaveTextContent('No executable stop is created; this is a reference check only.');
    fireEvent.click(within(missingAtrDialog).getByRole('button', { name: 'Close calculation' }));
    await waitFor(() => expect(MarketDataService.getSecurityIntelligence).toHaveBeenCalledTimes(4));
    await act(async () => { await Promise.resolve(); });
  });

  test('keeps duplicate long and short stop explanations attached to their updated basis after holdings reorder', async () => {
    const positions = {
      ...portfolioData,
      liveSessionVerified: true,
      accountSummary: { netLiquidation: 100000, source: 'ibkr_live_session' },
      holdings: portfolioData.holdings.slice(0, 2).map((holding, index) => ({
        ...holding,
        avgCost: index === 0 ? 200 : 240,
        quantity: index === 0 ? 50 : -25,
        marketValue: index === 0 ? 10000 : -5000,
        positionSource: 'ibkr_live_session',
        priceState: 'live',
      })),
    };
    const view = render(<PortfolioBreakdown portfolioData={positions} />);
    await waitFor(() => expect(MarketDataService.getSecurityRiskMetrics).toHaveBeenCalledTimes(1));
    const toggles = screen.getAllByRole('button', { name: 'Show research intelligence for GLD' });
    const panelIds = toggles.map((button) => button.getAttribute('aria-controls'));
    toggles.forEach((button) => fireEvent.click(button));
    await act(async () => { await Promise.resolve(); });
    expect(within(document.getElementById(panelIds[0])).getByRole('button', {
      name: 'Verify GLD stop loss calculation',
    })).toHaveTextContent('191.00');
    expect(within(document.getElementById(panelIds[1])).getByRole('button', {
      name: 'Verify GLD stop loss calculation',
    })).toHaveTextContent('249.00');

    view.rerender(<PortfolioBreakdown portfolioData={{
      ...positions,
      holdings: [...positions.holdings].reverse().map((holding) => ({ ...holding, avgCost: holding.avgCost + 10 })),
    }} />);
    for (const [index, panelId] of panelIds.entries()) {
      const panel = document.getElementById(panelId);
      const button = within(panel).getByRole('button', { name: 'Verify GLD stop loss calculation' });
      expect(button).toHaveTextContent(index === 0 ? '201.00' : '259.00');
      expect(button.closest('.pcv2-intel-cell')).toHaveClass('is-reference');
      fireEvent.click(button);
      const dialog = screen.getByRole('dialog', { name: 'Stop loss calculation' });
      expect(dialog).toHaveTextContent(index === 0
        ? '$210.00 − (2 × $4.50) = $201.00'
        : '$250.00 + (2 × $4.50) = $259.00');
      expect(dialog).toHaveTextContent(index === 0 ? 'Long position' : 'Short position');
      expect(dialog).not.toHaveTextContent(index === 0 ? '$259.00' : '$201.00');
      fireEvent.click(within(dialog).getByRole('button', { name: 'Close calculation' }));
    }
  });

  test('USD correlation keeps mapped signed references separate from unavailable sources and unmapped positions', async () => {
    MarketDataService.getUsdCorrelations.mockResolvedValue({
      sourceStatus: 'current', calculationDate: '2026-09-10', correlations: { GOLD: { '30D': '+0.45', '1M': -0.8 } },
    });
    render(<PortfolioBreakdown portfolioData={{
      ...portfolioData,
      holdings: [portfolioData.holdings[0], { ...portfolioData.holdings[2], symbol: 'TLT' }],
    }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show research intelligence for GLD' }));
    fireEvent.click(screen.getByRole('button', { name: 'Show research intelligence for TLT' }));
    const gold = within(screen.getByLabelText('Research intelligence for GLD')).getByLabelText('GLD market context').children[3];
    const rates = within(screen.getByLabelText('Research intelligence for TLT')).getByLabelText('TLT market context').children[3];
    await waitFor(() => expect(gold).toHaveTextContent('+0.45'));
    expect(within(gold).getByText('+0.45')).toHaveClass('is-positive');
    expectCellProvenance(gold, /DXY vs GOLD · 30D · Sep 10/);
    expect(rates).toHaveTextContent('N/A');
    expectCellProvenance(rates, /No direct USD proxy/);
    MarketDataService.getUsdCorrelations.mockResolvedValue({
      sourceStatus: 'current', calculationDate: '2026-09-09', correlations: { GOLD: { '30D': null, '1M': -0.42 } },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh portfolio and research' }));
    await waitFor(() => expect(gold).toHaveTextContent('-0.42'));
    expect(within(gold).getByText('-0.42')).toHaveClass('is-negative');
    expectCellProvenance(gold, /DXY vs GOLD · 30D · Sep 9/);
    MarketDataService.getUsdCorrelations.mockResolvedValue({
      sourceStatus: 'stale', calculationDate: '2026-09-10', correlations: { GOLD: { '30D': 0.9 } },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh portfolio and research' }));
    await waitFor(() => expect(gold).toHaveTextContent('Unavailable'));
    expectCellProvenance(gold, /DXY vs GOLD unavailable/);
    expect(gold).not.toHaveTextContent('0.90');
    expect(rates).toHaveTextContent('N/A');
  });

  test('preserves the original D-marker time for retained GVZ and historical MOVE without marking an ordinary current observation', async () => {
    const snapshot = {
      lastUpdated: fixedNow,
      GVZ: {
        lastPx: 18.25,
        availability: 'reference',
        freshness: 'refresh-delayed',
        refreshDelayed: true,
        asOf: '2026-09-10T17:57:00.000Z',
        lastVerifiedAt: '2026-09-10T17:58:00.000Z',
        retainedUntil: '2026-09-10T18:28:00.000Z',
        source: 'cboe',
        sourceLabel: 'Cboe delayed',
        quoteMode: 'delayed',
      },
      MOVE: {
        lastPx: 81.5,
        availability: 'historical',
        freshness: 'historical',
        quoteMode: 'end-of-day',
        asOf: '2026-09-09',
      },
    };
    MarketDataService.getVolatilitySnapshot.mockResolvedValue(snapshot);
    MarketDataService.getUsdCorrelations.mockResolvedValue({
      sourceStatus: 'current', calculationDate: '2026-09-10', correlations: { GOLD: { '30D': 0 } },
    });
    render(<PortfolioBreakdown portfolioData={{
      ...portfolioData,
      holdings: [portfolioData.holdings[0], { ...portfolioData.holdings[2], symbol: 'TLT' }],
    }} />);
    await waitFor(() => expect(MarketDataService.getVolatilitySnapshot).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'Show research intelligence for GLD' }));
    fireEvent.click(screen.getByRole('button', { name: 'Show research intelligence for TLT' }));
    const goldCells = within(screen.getByLabelText('Research intelligence for GLD')).getByLabelText('GLD market context').children;
    const marker = await within(goldCells[2]).findByRole('button', { name: /Refresh delayed · last verified/ });
    // The shared D marker shows the original verification time in 24-hour form.
    const originalTime = formatDelayedDataTimestamp('2026-09-10T17:58:00.000Z', 'refresh-delayed');
    expect(originalTime).toMatch(/Sep 10, 2026, \d{2}:58 /);
    expect(marker).toHaveAttribute('data-data-status', 'refresh-delayed');
    expect(marker).toHaveAccessibleName(expect.stringContaining(originalTime));
    expect(within(goldCells[3]).getByText('0.00')).toHaveClass('is-muted');
    const ratesCells = within(screen.getByLabelText('Research intelligence for TLT')).getByLabelText('TLT market context').children;
    expect(ratesCells[2]).toHaveTextContent('MOVE 81.50D');
    expect(within(ratesCells[2]).getByRole('button', { name: /Updated Sep 9, 2026$/ }))
      .toHaveAttribute('data-data-status', 'historical');

    MarketDataService.getVolatilitySnapshot.mockResolvedValue({
      ...snapshot,
      GVZ: { lastPx: 19.5, availability: 'available', freshness: 'current', asOf: fixedNow, sourceLabel: 'Cboe' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh portfolio and research' }));
    await waitFor(() => expect(goldCells[2]).toHaveTextContent('GVZ 19.50'));
    expect(within(goldCells[2]).queryByRole('button')).not.toBeInTheDocument();
    expect(ratesCells[2]).toHaveTextContent('MOVE 81.50D');
  });
});

describe('historical research disclosure presentation', () => {
  const singlePosition = { ...portfolioData, holdings: [portfolioData.holdings[0]] };
  let quadRequest;
  const pendingResponse = () => {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    return { promise, resolve, reject };
  };
  const currentOnlyEnvelope = () => {
    const envelope = currentEnvelope();
    delete envelope.bySymbol.GLD.history;
    return envelope;
  };
  const historyEnvelope = () => {
    const envelope = currentOnlyEnvelope();
    envelope.bySymbol.GLD.history = [{
      marketDate: '2026-09-09',
      directReferences: [{
        id: 'historical-disclosure-note',
        productId: 'early-look',
        productLabel: 'Early Look',
        kind: 'summary',
        direction: 'positive',
        excerpt: 'Dated gold commentary remains reference only.',
        matchType: 'direct',
        qualityStatus: 'validated',
        publishedAt: '2026-09-09T13:42:00Z',
        sourceUrl: '/research/early-look/historical-disclosure-note',
      }],
    }];
    return envelope;
  };
  const openPanel = async () => {
    await waitFor(() => expect(MarketDataService.getSecurityIntelligence).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'Show research intelligence for GLD' }));
    const panel = screen.getByLabelText('Research intelligence for GLD');
    await within(panel).findByRole('button', { name: 'View The Call facts for GLD' });
    await waitFor(() => expect(MarketDataService.getSecurityIntelligence).toHaveBeenCalledTimes(2));
    return panel;
  };

  beforeEach(() => {
    jest.useFakeTimers({
      now: new Date('2026-09-10T18:00:00.000Z'),
      doNotFake: ['nextTick', 'performance', 'queueMicrotask', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    });
    // Research fixtures stay test-only; this disclosure has no executable market data.
    quadRequest = jest.spyOn(axios, 'get').mockResolvedValue({ data: {} });
    MarketDataService.getSecurityRiskMetrics.mockResolvedValue({ status: 'unavailable', rows: {} });
    MarketDataService.getVolatilitySnapshot.mockResolvedValue({});
    MarketDataService.getUsdCorrelations.mockResolvedValue({});
  });

  afterEach(() => {
    quadRequest.mockRestore();
    jest.useRealTimers();
  });

  test('keeps the same open native disclosure through loading, error, and recovery independently of current context', async () => {
    const initialHistory = pendingResponse();
    const recoveredHistory = pendingResponse();
    let historyResponse = initialHistory.promise;
    MarketDataService.getSecurityIntelligence.mockImplementation(({ historyDays }) => (
      historyDays ? historyResponse : Promise.resolve(currentOnlyEnvelope())
    ));
    render(<PortfolioBreakdown portfolioData={singlePosition} />);
    const panel = await openPanel();
    const summary = within(panel).getByText('Previous 5 market days (loading…)');
    const disclosure = summary.closest('details');
    expect(disclosure).not.toHaveAttribute('open');
    expect(within(disclosure).getByText('Loading verified historical references…')).not.toBeVisible();
    fireEvent.click(summary);
    expect(disclosure).toHaveAttribute('open');
    expect(within(disclosure).getByRole('status')).toHaveTextContent('Loading verified historical references…');
    fireEvent.click(within(panel).getByRole('button', { name: 'View The Call facts for GLD' }));
    const currentContext = within(panel).getByRole('region', { name: 'The Call facts for GLD' });
    expect(disclosure).not.toContainElement(currentContext);

    await act(async () => initialHistory.reject(new Error('Test-only historical provider failure')));
    expect(panel.querySelector('details')).toBe(disclosure);
    expect(disclosure).toHaveAttribute('open');
    expect(summary).toHaveTextContent('Previous 5 market days (0 product rows)');
    expect(within(disclosure).getByText('Historical references unavailable.')).toBeVisible();
    expect(within(disclosure).queryByRole('status')).not.toBeInTheDocument();
    expect(currentContext).toBeVisible();

    historyResponse = recoveredHistory.promise;
    fireEvent.click(screen.getByRole('button', { name: 'Refresh portfolio and research' }));
    await waitFor(() => expect(summary).toHaveTextContent('Previous 5 market days (loading…)'));
    expect(panel.querySelector('details')).toBe(disclosure);
    expect(disclosure).toHaveAttribute('open');
    expect(within(disclosure).queryByText('Historical references unavailable.')).not.toBeInTheDocument();
    await act(async () => recoveredHistory.resolve(historyEnvelope()));
    expect(panel.querySelector('details')).toBe(disclosure);
    expect(disclosure).toHaveAttribute('open');
    expect(summary).toHaveTextContent('Previous 5 market days (1 product rows)');
    expect(within(disclosure).getByText('POSITIVE · Dated gold commentary remains reference only.')).toBeVisible();
    expect(within(panel).getByRole('region', { name: 'The Call facts for GLD' })).toBe(currentContext);
    fireEvent.click(summary);
    expect(currentContext).toBeVisible();
    expect(MarketDataService.getSecurityIntelligence).toHaveBeenCalledTimes(4);
  });

  test('retries pending history once after collapse and reopen without replacing fresh current research', async () => {
    const canceledHistory = pendingResponse();
    const retriedHistory = pendingResponse();
    const freshCurrent = currentOnlyEnvelope();
    freshCurrent.bySymbol.GLD.directReferences[0].excerpt = 'Fresh current gold research remains authoritative.';
    freshCurrent.bySymbol.GLD.decision.trade.value = 'SELL';
    freshCurrent.bySymbol.GLD.decision.trend.value = 'BEARISH';
    let historyRequestCount = 0;
    MarketDataService.getSecurityIntelligence.mockImplementation(({ historyDays }) => {
      if (!historyDays) return Promise.resolve(freshCurrent);
      historyRequestCount += 1;
      return historyRequestCount === 1 ? canceledHistory.promise : retriedHistory.promise;
    });
    const expectFreshCurrent = (panel) => {
      expect(panel).toHaveTextContent('Fresh current gold research remains authoritative.');
      expect(panel).not.toHaveTextContent('Gold remains a preferred long.');
      const [, tradeCell, trendCell] = within(panel).getByLabelText('GLD decision intelligence').children;
      expect(tradeCell).toHaveTextContent('BEARISH');
      expect(trendCell).toHaveTextContent('BEARISH');
    };

    render(<PortfolioBreakdown portfolioData={singlePosition} />);
    const initialPanel = await openPanel();
    expectFreshCurrent(initialPanel);
    const canceledSignal = MarketDataService.getSecurityIntelligence.mock.calls[1][0].signal;
    expect(canceledSignal.aborted).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Hide research intelligence for GLD' }));
    expect(canceledSignal.aborted).toBe(true);
    expect(initialPanel).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show research intelligence for GLD' }));
    const reopenedPanel = screen.getByLabelText('Research intelligence for GLD');
    await waitFor(() => expect(MarketDataService.getSecurityIntelligence).toHaveBeenCalledTimes(3));
    expect(historyRequestCount).toBe(2);
    expect(MarketDataService.getSecurityIntelligence.mock.calls
      .filter(([request]) => request.historyDays === 0)).toHaveLength(1);
    expect(MarketDataService.getSecurityIntelligence.mock.calls[2][0].signal.aborted).toBe(false);
    expectFreshCurrent(reopenedPanel);

    await act(async () => retriedHistory.resolve(historyEnvelope()));
    const disclosure = within(reopenedPanel).getByText('Previous 5 market days (1 product rows)').closest('details');
    fireEvent.click(within(disclosure).getByText(/Previous 5 market days/));
    expect(within(disclosure).getByText('POSITIVE · Dated gold commentary remains reference only.')).toBeVisible();
    expectFreshCurrent(reopenedPanel);

    const supersededHistory = historyEnvelope();
    supersededHistory.bySymbol.GLD.history[0].directReferences[0].excerpt = 'Superseded canceled gold history.';
    await act(async () => canceledHistory.resolve(supersededHistory));
    expect(within(disclosure).getByText('POSITIVE · Dated gold commentary remains reference only.')).toBeVisible();
    expect(reopenedPanel).not.toHaveTextContent('Superseded canceled gold history.');
    expectFreshCurrent(reopenedPanel);
    expect(MarketDataService.getSecurityIntelligence).toHaveBeenCalledTimes(3);
  });

  test('keeps pending history active when a second research row is opened', async () => {
    const pendingHistory = pendingResponse();
    MarketDataService.getSecurityIntelligence.mockImplementation(({ historyDays }) => (
      historyDays ? pendingHistory.promise : Promise.resolve(currentOnlyEnvelope())
    ));
    render(<PortfolioBreakdown portfolioData={portfolioData} />);
    await waitFor(() => expect(MarketDataService.getSecurityIntelligence).toHaveBeenCalledTimes(1));
    const toggles = screen.getAllByRole('button', { name: 'Show research intelligence for GLD' });
    const panelIds = toggles.map((button) => button.getAttribute('aria-controls'));
    fireEvent.click(toggles[0]);
    await waitFor(() => expect(MarketDataService.getSecurityIntelligence).toHaveBeenCalledTimes(2));
    const historySignal = MarketDataService.getSecurityIntelligence.mock.calls[1][0].signal;
    expect(historySignal.aborted).toBe(false);

    fireEvent.click(toggles[1]);
    // Flush the independent priority-risk request started on expansion.
    await act(async () => { await Promise.resolve(); });
    expect(historySignal.aborted).toBe(false);
    expect(MarketDataService.getSecurityIntelligence).toHaveBeenCalledTimes(2);
    const panels = panelIds.map((id) => document.getElementById(id));
    panels.forEach((panel) => {
      expect(panel).toHaveTextContent('Gold remains a preferred long.');
      expect(within(panel).getByText('Previous 5 market days (loading…)')).toBeInTheDocument();
    });

    await act(async () => pendingHistory.resolve(historyEnvelope()));
    panels.forEach((panel) => {
      const summary = within(panel).getByText('Previous 5 market days (1 product rows)');
      fireEvent.click(summary);
      expect(within(summary.closest('details')).getByText('POSITIVE · Dated gold commentary remains reference only.')).toBeVisible();
      expect(panel).toHaveTextContent('Gold remains a preferred long.');
    });
    expect(MarketDataService.getSecurityIntelligence).toHaveBeenCalledTimes(2);
  });

  test('keeps duplicate-position historical disclosures independent through reorder and resets only the remounted disclosure', async () => {
    MarketDataService.getSecurityIntelligence.mockImplementation(({ historyDays }) => Promise.resolve(
      historyDays ? historyEnvelope() : currentOnlyEnvelope(),
    ));
    const view = render(<PortfolioBreakdown portfolioData={portfolioData} />);
    await waitFor(() => expect(MarketDataService.getSecurityIntelligence).toHaveBeenCalledTimes(1));
    const toggles = screen.getAllByRole('button', { name: 'Show research intelligence for GLD' });
    const [firstPanelId, secondPanelId] = toggles.map((button) => button.getAttribute('aria-controls'));
    fireEvent.click(toggles[0]);
    await waitFor(() => expect(MarketDataService.getSecurityIntelligence).toHaveBeenCalledTimes(2));
    fireEvent.click(toggles[1]);
    // Flush the independent priority-risk request started on expansion.
    await act(async () => { await Promise.resolve(); });
    const firstPanel = document.getElementById(firstPanelId);
    const secondPanel = document.getElementById(secondPanelId);
    const firstSummary = await within(firstPanel).findByText('Previous 5 market days (1 product rows)');
    const firstDisclosure = firstSummary.closest('details');
    const secondDisclosure = secondPanel.querySelector('details');
    fireEvent.click(firstSummary);
    expect(firstDisclosure).toHaveAttribute('open');
    expect(secondDisclosure).not.toHaveAttribute('open');

    view.rerender(<PortfolioBreakdown portfolioData={{
      ...portfolioData,
      holdings: [...portfolioData.holdings].reverse().map((holding) => (
        holding.accountId === 'U2' ? { ...holding, marketValue: 15000 } : holding
      )),
    }} />);
    expect(screen.getAllByLabelText('Research intelligence for GLD').map((panel) => panel.id))
      .toEqual([secondPanelId, firstPanelId]);
    expect(document.getElementById(firstPanelId).querySelector('details')).toBe(firstDisclosure);
    expect(document.getElementById(secondPanelId).querySelector('details')).toBe(secondDisclosure);
    expect(firstDisclosure).toHaveAttribute('open');
    expect(secondDisclosure).not.toHaveAttribute('open');
    fireEvent.click(within(secondDisclosure).getByText(/Previous 5 market days/));

    const firstToggle = screen.getAllByRole('button', { name: 'Hide research intelligence for GLD' })
      .find((button) => button.getAttribute('aria-controls') === firstPanelId);
    fireEvent.click(firstToggle);
    expect(firstDisclosure).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show research intelligence for GLD' }));
    // Remounting can request the unavailable historical risk metrics again.
    await act(async () => { await Promise.resolve(); });
    const remountedDisclosure = document.getElementById(firstPanelId).querySelector('details');
    expect(remountedDisclosure).not.toBe(firstDisclosure);
    expect(remountedDisclosure).not.toHaveAttribute('open');
    expect(document.getElementById(secondPanelId).querySelector('details')).toBe(secondDisclosure);
    expect(secondDisclosure).toHaveAttribute('open');
    expect(MarketDataService.getSecurityIntelligence).toHaveBeenCalledTimes(2);
  });

  test('renders historical market dates, product labels, and full detail as text without source or trading controls', async () => {
    MarketDataService.getSecurityIntelligence.mockImplementation(({ historyDays }) => Promise.resolve(
      historyDays ? historyEnvelope() : currentOnlyEnvelope(),
    ));
    render(<PortfolioBreakdown portfolioData={singlePosition} />);
    const panel = await openPanel();
    const summary = await within(panel).findByText('Previous 5 market days (1 product rows)');
    const disclosure = summary.closest('details');
    expect(disclosure.firstElementChild).toBe(summary);
    fireEvent.click(summary);
    const note = within(disclosure).getByText('POSITIVE · Dated gold commentary remains reference only.');
    const row = note.closest('.pcv2-intel-reference-row');
    expect([...row.children].map((cell) => cell.textContent)).toEqual([
      'Sep 9', 'Early Look', 'POSITIVE · Dated gold commentary remains reference only.',
    ]);
    expect(row.children[0]).toHaveClass('pcv2-intel-reference-time', 'pcv2-intel-span-2');
    expect(row.children[1]).toHaveClass('pcv2-intel-reference-product', 'pcv2-intel-span-2');
    expect(row.children[2]).toHaveClass('pcv2-intel-reference-note', 'pcv2-intel-span-16');
    expect(note).toHaveAttribute('title', note.textContent);
    expect(within(disclosure).queryByText('09:42')).not.toBeInTheDocument();
    expect(disclosure.querySelectorAll('a, button, input, select, textarea')).toHaveLength(0);
    expect(disclosure.querySelector('[role="region"]')).not.toBeInTheDocument();
    expect(disclosure.querySelector('.pcv2-intel-reference-header')).not.toBeInTheDocument();
    expect(MarketDataService.getSecurityIntelligence).toHaveBeenCalledTimes(2);
  });
});

describe('same-universe research refresh precedence', () => {
  const fixedNow = new Date('2026-09-10T18:00:00.000Z');
  const singlePosition = { ...portfolioData, holdings: [portfolioData.holdings[0]] };
  let quadRequest;
  const pendingResponse = () => {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    return { promise, resolve, reject };
  };
  const refreshEnvelope = (revision = 'old') => {
    const envelope = currentEnvelope();
    const entry = envelope.bySymbol.GLD;
    delete entry.history;
    entry.inferredReferences = [];
    entry.directReferences = [{
      ...entry.directReferences[0],
      id: `refresh-${revision}`,
      excerpt: revision === 'old'
        ? 'Earlier gold thesis remains constructive.'
        : 'Fresh gold thesis turns defensive.',
      direction: revision === 'old' ? 'long' : 'short',
      sourceUrl: `/research/the-call/refresh-${revision}`,
    }];
    if (revision === 'fresh') {
      envelope.generatedAt = `${marketDate()}T17:00:00Z`;
      entry.decision.trade.value = 'SELL';
      entry.decision.trend.value = 'BEARISH';
      entry.decision.riskRange.lrr = 2700;
      entry.decision.riskRange.hrr = 2800;
    }
    return envelope;
  };
  const historyEnvelope = (note = 'Dated gold history remains secondary.') => {
    const envelope = refreshEnvelope();
    envelope.bySymbol.GLD.history = [{
      marketDate: priorDate(),
      directReferences: [{
        id: `history-${note}`,
        productId: 'early-look',
        productLabel: 'Early Look',
        kind: 'summary',
        excerpt: note,
        matchType: 'direct',
        qualityStatus: 'validated',
      }],
    }];
    return envelope;
  };
  const openCurrentContext = async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Show research intelligence for GLD' }));
    const panel = screen.getByLabelText('Research intelligence for GLD');
    fireEvent.click(await within(panel).findByRole('button', { name: 'View The Call facts for GLD' }));
    return panel;
  };
  const expectFreshCurrent = (panel) => {
    expect(within(panel).getAllByText('Fresh gold thesis turns defensive.').length).toBeGreaterThan(0);
    expect(within(panel).queryByText('Earlier gold thesis remains constructive.')).not.toBeInTheDocument();
    const [, tradeCell, trendCell] = within(panel).getByLabelText('GLD decision intelligence').children;
    expect(tradeCell).toHaveTextContent('BEARISH');
    expect(trendCell).toHaveTextContent('BEARISH');
    expect(within(panel).getByLabelText(/Low price risk range$/)).toHaveTextContent('2,700');
    expect(within(panel).getByLabelText(/High price risk range$/)).toHaveTextContent('2,800');
    const context = within(panel).getByRole('region', { name: 'The Call facts for GLD' });
    expect(within(context).getByRole('link', { name: 'OPEN SOURCE ↗' }))
      .toHaveAttribute('href', '/research/the-call/refresh-fresh');
    expect(panel.querySelector('a[href="/research/the-call/refresh-old"]')).not.toBeInTheDocument();
  };
  const expectActiveHistoryRequest = async () => {
    await waitFor(() => {
      const historyRequests = MarketDataService.getSecurityIntelligence.mock.calls
        .map(([request]) => request).filter((request) => request.historyDays === 5);
      expect(historyRequests.length).toBeGreaterThan(0);
      expect(historyRequests[historyRequests.length - 1].signal.aborted).toBe(false);
    });
  };

  beforeEach(() => {
    jest.useFakeTimers({
      now: fixedNow,
      doNotFake: ['nextTick', 'performance', 'queueMicrotask', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    });
    // These cases exercise research only, with no executable market-data fixtures.
    quadRequest = jest.spyOn(axios, 'get').mockResolvedValue({ data: {} });
    MarketDataService.getSecurityRiskMetrics.mockResolvedValue({ status: 'unavailable', rows: {} });
    MarketDataService.getVolatilitySnapshot.mockResolvedValue({});
    MarketDataService.getUsdCorrelations.mockResolvedValue({});
  });

  afterEach(() => {
    quadRequest.mockRestore();
    jest.useRealTimers();
  });

  test('replaces earlier facts, source links, decisions, and ranges on a same-universe manual refresh', async () => {
    let response = refreshEnvelope();
    MarketDataService.getSecurityIntelligence.mockImplementation(() => Promise.resolve(response));
    render(<PortfolioBreakdown portfolioData={singlePosition} />);
    const panel = await openCurrentContext();
    expect(within(panel).getAllByText('Earlier gold thesis remains constructive.').length).toBeGreaterThan(0);

    response = refreshEnvelope('fresh');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh portfolio and research' }));

    await waitFor(() => expectFreshCurrent(panel));
    expect(MarketDataService.getSecurityIntelligence.mock.calls.every(([request]) => (
      request.symbols.join(',') === 'GLD'
    ))).toBe(true);
  });

  test.each(['unavailable', 'omitted current fields', 'omitted symbol'])(
    'clears an expanded old product and decisions when a same-universe refresh returns %s',
    async (variant) => {
      const lateHistory = pendingResponse();
      let response = refreshEnvelope();
      let refreshed = false;
      MarketDataService.getSecurityIntelligence.mockImplementation(({ historyDays }) => (
        refreshed && historyDays ? lateHistory.promise : Promise.resolve(response)
      ));
      render(<PortfolioBreakdown portfolioData={singlePosition} />);
      const panel = await openCurrentContext();
      expect(within(panel).getByRole('region', { name: 'The Call facts for GLD' })).toBeInTheDocument();

      response = refreshEnvelope('fresh');
      response.coverage = { state: 'partial', reasons: [] };
      response.products = response.products.map((product) => ({ ...product, status: 'missing' }));
      response.bySymbol.GLD = variant === 'unavailable' ? {
        symbol: 'GLD',
        state: 'unavailable',
        coverage: { state: 'unavailable', reasons: [] },
        decision: {},
        supplementalRange: null,
        directReferences: [],
        inferredReferences: [],
      } : {
        symbol: 'GLD',
        state: 'no_references',
        coverage: { state: 'no_references', reasons: [] },
      };
      if (variant === 'omitted symbol') response.bySymbol = {};
      refreshed = true;
      fireEvent.click(screen.getByRole('button', { name: 'Refresh portfolio and research' }));

      await waitFor(() => expect(within(panel).queryByRole('region', {
        name: 'The Call facts for GLD',
      })).not.toBeInTheDocument());
      await expectActiveHistoryRequest();
      await act(async () => lateHistory.resolve(historyEnvelope()));

      const row = within(panel).getByText('The Call').closest('.pcv2-intel-reference-row');
      expect(row).toHaveTextContent('UNAVAILABLE');
      expect(within(row).queryByRole('button')).not.toBeInTheDocument();
      expect(within(panel).queryByRole('region', { name: 'The Call facts for GLD' })).not.toBeInTheDocument();
      expect(within(panel).queryByText('Earlier gold thesis remains constructive.')).not.toBeInTheDocument();
      expect(within(panel).queryByRole('link', { name: 'OPEN SOURCE ↗' })).not.toBeInTheDocument();
      const [, tradeCell, trendCell] = within(panel).getByLabelText('GLD decision intelligence').children;
      expect(tradeCell).toHaveTextContent('—');
      expect(trendCell).toHaveTextContent('—');
      expect(within(panel).getByLabelText(/Low price risk range$/)).toHaveTextContent('—');
      expect(within(panel).getByLabelText(/High price risk range$/)).toHaveTextContent('—');
    },
  );

  test('keeps historical evidence in history while a late history response cannot restore older current evidence', async () => {
    const lateHistory = pendingResponse();
    let currentResponse = refreshEnvelope();
    let historyResponse = Promise.resolve(historyEnvelope());
    MarketDataService.getSecurityIntelligence.mockImplementation(({ historyDays }) => (
      historyDays ? historyResponse : Promise.resolve(currentResponse)
    ));
    render(<PortfolioBreakdown portfolioData={singlePosition} />);
    const panel = await openCurrentContext();
    const historyNote = await within(panel).findByText('Dated gold history remains secondary.');
    expect(historyNote.closest('details')).toBeInTheDocument();
    expect(historyNote).not.toBeVisible();

    currentResponse = refreshEnvelope('fresh');
    historyResponse = lateHistory.promise;
    fireEvent.click(screen.getByRole('button', { name: 'Refresh portfolio and research' }));
    await waitFor(() => expectFreshCurrent(panel));
    await expectActiveHistoryRequest();
    // History starts in a separate effect after current research has rendered.
    expect(await within(panel).findByText('Loading verified historical references…')).not.toBeVisible();

    await act(async () => lateHistory.resolve(historyEnvelope('Newly loaded historical gold context.')));
    expectFreshCurrent(panel);
    expect(panel.querySelector('details')).toHaveTextContent('Newly loaded historical gold context.');
    const updatedHistoryNote = within(panel).getByText('Newly loaded historical gold context.');
    expect(updatedHistoryNote.closest('details')).toBeInTheDocument();
    expect(within(panel).queryByText('Dated gold history remains secondary.')).not.toBeInTheDocument();
    fireEvent.click(within(panel).getByText(/Previous 5 market days/));
    expect(updatedHistoryNote).toBeVisible();
  });

  test('does not let a late mismatched-session history response change the current decision date', async () => {
    const lateHistory = pendingResponse();
    MarketDataService.getSecurityIntelligence.mockImplementation(({ historyDays }) => (
      historyDays ? lateHistory.promise : Promise.resolve(refreshEnvelope('fresh'))
    ));
    render(<PortfolioBreakdown portfolioData={singlePosition} />);
    const panel = await openCurrentContext();
    expectFreshCurrent(panel);
    await waitFor(() => expect(MarketDataService.getSecurityIntelligence).toHaveBeenCalledTimes(2));

    const mismatchedHistory = historyEnvelope('History from a different envelope session.');
    mismatchedHistory.marketDate = priorDate();
    await act(async () => lateHistory.resolve(mismatchedHistory));

    expectFreshCurrent(panel);
    expect(within(panel).queryByText('History from a different envelope session.')).not.toBeInTheDocument();
  });

  test('ignores a pre-refresh current request that resolves after the fresh manual response', async () => {
    const oldCurrent = pendingResponse();
    MarketDataService.getSecurityIntelligence
      .mockImplementationOnce(() => oldCurrent.promise)
      .mockImplementation(() => Promise.resolve(refreshEnvelope('fresh')));
    render(<PortfolioBreakdown portfolioData={singlePosition} />);
    await waitFor(() => expect(MarketDataService.getSecurityIntelligence).toHaveBeenCalledTimes(1));
    const oldSignal = MarketDataService.getSecurityIntelligence.mock.calls[0][0].signal;
    fireEvent.click(screen.getByRole('button', { name: 'Refresh portfolio and research' }));
    const panel = await openCurrentContext();
    expect(oldSignal.aborted).toBe(true);
    expectFreshCurrent(panel);

    await act(async () => oldCurrent.resolve(refreshEnvelope()));

    expectFreshCurrent(panel);
  });

  test('renders a wrapped current response using its nested market date', async () => {
    MarketDataService.getSecurityIntelligence.mockImplementation(() => Promise.resolve({
      status: 'ok',
      data: refreshEnvelope('fresh'),
    }));
    render(<PortfolioBreakdown portfolioData={singlePosition} />);
    const panel = await openCurrentContext();

    expectFreshCurrent(panel);
    const [, tradeCell] = within(panel).getByLabelText('GLD decision intelligence').children;
    expect(tradeCell).toHaveAttribute('title', expect.stringContaining('Momo Tracker · Sep 10'));
  });

  test('waits for replacement current before requesting history and retains same-session history after a history failure', async () => {
    const nextCurrent = pendingResponse();
    const nextHistory = pendingResponse();
    let refreshing = false;
    MarketDataService.getSecurityIntelligence.mockImplementation(({ historyDays }) => (
      refreshing
        ? historyDays ? nextHistory.promise : nextCurrent.promise
        : Promise.resolve(historyDays ? historyEnvelope() : refreshEnvelope())
    ));
    render(<PortfolioBreakdown portfolioData={singlePosition} />);
    const panel = await openCurrentContext();
    expect(await within(panel).findByText('Dated gold history remains secondary.')).not.toBeVisible();
    refreshing = true;
    fireEvent.click(screen.getByRole('button', { name: 'Refresh portfolio and research' }));
    await waitFor(() => expect(MarketDataService.getSecurityIntelligence.mock.calls
      .filter(([request]) => request.historyDays === 0)).toHaveLength(2));
    expect(MarketDataService.getSecurityIntelligence.mock.calls
      .filter(([request]) => request.historyDays === 5)).toHaveLength(1);
    expect(within(panel).getByText('Dated gold history remains secondary.')).not.toBeVisible();

    await act(async () => nextCurrent.resolve(refreshEnvelope('fresh')));
    expectFreshCurrent(panel);
    await expectActiveHistoryRequest();
    await act(async () => nextHistory.reject(new Error('History provider unavailable')));

    expectFreshCurrent(panel);
    const retainedHistory = within(panel).getByText('Dated gold history remains secondary.');
    expect(retainedHistory.closest('details')).toBeInTheDocument();
    expect(retainedHistory).not.toBeVisible();
  });

  test('ignores a pre-refresh history request after fresh current and replacement history have loaded', async () => {
    const oldHistory = pendingResponse();
    let refreshing = false;
    MarketDataService.getSecurityIntelligence.mockImplementation(({ historyDays }) => (
      historyDays
        ? refreshing ? Promise.resolve(historyEnvelope('Replacement gold history.')) : oldHistory.promise
        : Promise.resolve(refreshEnvelope(refreshing ? 'fresh' : 'old'))
    ));
    render(<PortfolioBreakdown portfolioData={singlePosition} />);
    const panel = await openCurrentContext();
    await expectActiveHistoryRequest();
    const oldHistorySignal = MarketDataService.getSecurityIntelligence.mock.calls
      .find(([request]) => request.historyDays === 5)[0].signal;
    refreshing = true;
    fireEvent.click(screen.getByRole('button', { name: 'Refresh portfolio and research' }));
    const replacementHistory = await within(panel).findByText('Replacement gold history.');
    expect(oldHistorySignal.aborted).toBe(true);
    expectFreshCurrent(panel);

    await act(async () => oldHistory.resolve(historyEnvelope('Superseded gold history response.')));

    expectFreshCurrent(panel);
    expect(replacementHistory).toBeInTheDocument();
    expect(within(panel).queryByText('Superseded gold history response.')).not.toBeInTheDocument();
  });

  test('reloads the history window when same-symbol polling advances to a new market session', async () => {
    jest.useFakeTimers({ now: fixedNow, doNotFake: ['nextTick', 'performance', 'queueMicrotask'] });
    const nextHistory = pendingResponse();
    let currentResponse = refreshEnvelope();
    let historyResponse = Promise.resolve(historyEnvelope('Previous session history window.'));
    MarketDataService.getSecurityIntelligence.mockImplementation(({ historyDays }) => (
      historyDays ? historyResponse : Promise.resolve(currentResponse)
    ));
    render(<PortfolioBreakdown portfolioData={singlePosition} />);
    const panel = await openCurrentContext();
    expect(await within(panel).findByText('Previous session history window.')).not.toBeVisible();

    jest.setSystemTime(new Date('2026-09-11T18:00:00.000Z'));
    currentResponse = refreshEnvelope('fresh');
    historyResponse = nextHistory.promise;
    await act(async () => { await jest.advanceTimersByTimeAsync(5 * 60 * 1000); });

    expectFreshCurrent(panel);
    expect(within(panel).queryByText('Previous session history window.')).not.toBeInTheDocument();
    await waitFor(() => expect(MarketDataService.getSecurityIntelligence.mock.calls
      .filter(([request]) => request.historyDays === 5)).toHaveLength(2));
    expect(MarketDataService.getSecurityIntelligence.mock.calls
      .filter(([request]) => request.historyDays === 0)).toHaveLength(2);
    const nextHistoryEnvelope = historyEnvelope('New session history window.');
    expect(nextHistoryEnvelope.marketDate).toBe('2026-09-11');
    expect(nextHistoryEnvelope.bySymbol.GLD.history[0].marketDate).toBe('2026-09-10');
    await act(async () => nextHistory.resolve(nextHistoryEnvelope));
    expect(panel.querySelector('details')).toHaveTextContent('New session history window.');
    expect(within(panel).getByText('New session history window.').closest('details')).toBeInTheDocument();
    expectFreshCurrent(panel);
  });
});

test('resumes retained portfolio research without an activation-only request', async () => {
  const view = render(
    <PersistentSurface active>
      <PortfolioBreakdown portfolioData={portfolioData} />
    </PersistentSurface>,
  );

  await waitFor(() => expect(MarketDataService.getSecurityIntelligence).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(MarketDataService.getSecurityRiskMetrics).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(MarketDataService.getVolatilitySnapshot).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(MarketDataService.getUsdCorrelations).toHaveBeenCalledTimes(1));

  view.rerender(
    <PersistentSurface active={false}>
      <PortfolioBreakdown portfolioData={portfolioData} />
    </PersistentSurface>,
  );
  view.rerender(
    <PersistentSurface active>
      <PortfolioBreakdown portfolioData={portfolioData} />
    </PersistentSurface>,
  );
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(MarketDataService.getSecurityIntelligence).toHaveBeenCalledTimes(1);
  expect(MarketDataService.getSecurityRiskMetrics).toHaveBeenCalledTimes(1);
  expect(MarketDataService.getVolatilitySnapshot).toHaveBeenCalledTimes(1);
  expect(MarketDataService.getUsdCorrelations).toHaveBeenCalledTimes(1);
});

test('keeps a retained volatility reference visible with explicit refresh-delayed provenance', async () => {
  const now = Date.now();
  MarketDataService.getVolatilitySnapshot.mockResolvedValue({
    lastUpdated: new Date(now - 2 * 60 * 1000).toISOString(),
    GVZ: {
      lastPx: 18.25,
      availability: 'reference',
      freshness: 'refresh-delayed',
      refreshDelayed: true,
      asOf: new Date(now - 2 * 60 * 1000).toISOString(),
      lastVerifiedAt: new Date(now - 60 * 1000).toISOString(),
      retainedUntil: new Date(now + 29 * 60 * 1000).toISOString(),
      source: 'cboe',
      sourceLabel: 'Cboe delayed',
      quoteMode: 'delayed',
    },
  });
  render(<PortfolioBreakdown portfolioData={portfolioData} />);

  const toggles = await screen.findAllByRole('button', { name: 'Show research intelligence for GLD' });
  fireEvent.click(toggles[0]);
  const panel = screen.getByLabelText('Research intelligence for GLD');
  const volatilityCell = await within(panel).findByLabelText(
    /GVZ 18\.25 · GVZ · Refresh delayed · last verified/i,
  );

  expect(volatilityCell).toHaveTextContent('GVZ 18.25');
  expect(volatilityCell).toHaveAttribute('title', expect.stringMatching(/Refresh delayed · last verified/i));
});

test('shows leveraged product links in the secondary card cell and opens a centered product modal', async () => {
  render(<PortfolioBreakdown portfolioData={portfolioData} />);

  const showResearchButtons = await screen.findAllByRole('button', {
    name: 'Show research intelligence for GLD',
  });
  fireEvent.click(showResearchButtons[0]);

  const researchPanel = await screen.findByLabelText('Research intelligence for GLD');
  expect(within(researchPanel).getByText('Levered products')).toBeInTheDocument();
  const panel = within(researchPanel).getByLabelText('GLD supplemental decision intelligence');
  const fittedProducts = within(panel).getByTestId('leveraged-products-GLD');
  expect(fittedProducts).toContainElement(fittedProducts.querySelector('.pcv2-leveraged-products-content'));
  expect(fittedProducts).toHaveAttribute('data-fit-scale');
  const productLink = within(panel).getByRole('button', {
    name: 'View UGLD +2× details for GLD',
  });
  expect(productLink).toBeInTheDocument();
  expect(productLink).toHaveClass('is-positive');
  expect(productLink).not.toHaveClass('is-proxy');
  expect(within(productLink).getByText('UGLD')).toHaveClass('pcv2-leveraged-product-ticker');

  const proxyProductLink = within(panel).getByRole('button', {
    name: 'View UGL +2× details for GLD',
  });
  expect(proxyProductLink).toHaveClass('is-proxy');
  expect(within(proxyProductLink).getByText('UGL')).toHaveClass('pcv2-leveraged-product-ticker');

  fireEvent.click(productLink);
  const modal = screen.getByTestId('leveraged-product-modal');
  expect(modal).toHaveAttribute('role', 'dialog');
  expect(within(modal).getByRole('heading', { name: 'UGLD' })).toBeInTheDocument();
  expect(within(modal).getByText('Tracks')).toBeInTheDocument();
  expect(within(modal).getByText('GLD fit')).toBeInTheDocument();
  expect(within(modal).getByText('Direct')).toBeInTheDocument();
  expect(within(modal).getByText('Daily reset · Multi-day returns may diverge.')).toBeInTheDocument();
  expect(within(modal).queryByText('Live quote required')).not.toBeInTheDocument();
  const positiveDirection = within(modal).getByTestId('leveraged-product-direction');
  expect(positiveDirection).toHaveClass('is-positive');
  expect(positiveDirection).toHaveTextContent('+2× daily');
  expect(positiveDirection).not.toHaveTextContent(/Long|Inverse/);

  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByTestId('leveraged-product-modal')).not.toBeInTheDocument();

  const inverseProductLink = within(panel).getByRole('button', {
    name: 'View GLL −2× details for GLD',
  });
  expect(inverseProductLink).toHaveClass('is-negative');
  fireEvent.click(inverseProductLink);
  const negativeDirection = screen.getByTestId('leveraged-product-direction');
  expect(negativeDirection).toHaveClass('is-negative');
  expect(negativeDirection).toHaveTextContent('−2× daily');
  expect(negativeDirection).not.toHaveTextContent(/Long|Inverse/);
});

test('labels IAK broad-financial products as loose proxies with exact issuer links', () => {
  const products = getLeveragedProducts('IAK');
  expect(products.map((product) => product.ticker)).toEqual(['UYG', 'FAS', 'FAZ']);

  products.forEach((product) => {
    expect(product).toMatchObject({
      reference: 'Financial Select Sector Index',
      matchType: 'proxy',
      fitLabel: 'Loose proxy',
      fitNote: 'Broad financials; insurance is only a minority of this benchmark.',
      overlapReferenceSymbol: 'XLF',
    });
  });

  expect(products.find((product) => product.ticker === 'UYG')?.issuerUrl)
    .toBe('https://www.proshares.com/our-etfs/leveraged-and-inverse/uyg');
  expect(products.find((product) => product.ticker === 'FAZ')?.issuerUrl)
    .toBe('https://www.direxion.com/product/daily-financial-bull-bear-3x-etfs');
});

test('shows current verified weighted holdings overlap beside an IAK proxy', async () => {
  MarketDataService.getLeveragedProductOverlap.mockResolvedValueOnce({
    available: true,
    status: 'available',
    baseSymbol: 'IAK',
    referenceSymbol: 'XLF',
    weightedOverlapPct: 9.6,
    sharedHoldings: 17,
    baseHoldings: 57,
    referenceHoldings: 77,
    asOf: marketDate(),
    method: 'weighted_constituent_overlap',
    fromCache: false,
    sources: [
      { symbol: 'IAK', provider: 'iShares', asOf: marketDate() },
      { symbol: 'XLF', provider: 'State Street', asOf: marketDate() },
    ],
  });

  render(<PortfolioBreakdown portfolioData={{
    ...portfolioData,
    holdings: [{
      ...portfolioData.holdings[0],
      symbol: 'IAK',
      description: 'iShares U.S. Insurance ETF',
    }],
  }} />);

  fireEvent.click(await screen.findByRole('button', {
    name: 'Show research intelligence for IAK',
  }));
  const panel = await screen.findByLabelText('IAK supplemental decision intelligence');
  fireEvent.click(within(panel).getByRole('button', {
    name: 'View FAZ −3× details for IAK',
  }));

  const modal = screen.getByTestId('leveraged-product-modal');
  expect(await within(modal).findByText('Loose proxy · 10% overlap')).toBeInTheDocument();
  expect(within(modal).getByText(/17 shared holdings/)).toBeInTheDocument();
  expect(MarketDataService.getLeveragedProductOverlap).toHaveBeenCalledWith(expect.objectContaining({
    baseSymbol: 'IAK',
    referenceSymbol: 'XLF',
  }));
});

const leveragedPortfolio = (symbols = ['IAK']) => ({
  ...portfolioData,
  holdings: symbols.map((symbol, index) => ({
    ...portfolioData.holdings[0],
    symbol,
    conid: `leveraged-test-${index}`,
    description: symbol,
  })),
});

const verifiedLeveragedOverlap = (weightedOverlapPct = 9.6) => ({
  available: true,
  status: 'available',
  baseSymbol: 'IAK',
  referenceSymbol: 'XLF',
  weightedOverlapPct,
  sharedHoldings: 17,
  asOf: marketDate(),
  fromCache: false,
  sources: [
    { symbol: 'IAK', provider: 'iShares', asOf: marketDate() },
    { symbol: 'XLF', provider: 'State Street', asOf: marketDate() },
  ],
});

const deferredOverlap = () => {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
};

const expandLeveragedResearch = async (symbol) => {
  fireEvent.click(await screen.findByRole('button', {
    name: `Show research intelligence for ${symbol}`,
  }));
  return screen.findByLabelText(`${symbol} supplemental decision intelligence`);
};

test('keeps inside clicks open, dismisses by close or backdrop, and refetches overlap once on reopening', async () => {
  MarketDataService.getLeveragedProductOverlap.mockResolvedValue(verifiedLeveragedOverlap());
  render(<PortfolioBreakdown portfolioData={leveragedPortfolio()} />);
  const panel = await expandLeveragedResearch('IAK');
  const openProduct = () => fireEvent.click(within(panel).getByRole('button', {
    name: 'View FAZ −3× details for IAK',
  }));

  openProduct();
  const modal = screen.getByTestId('leveraged-product-modal');
  expect(await within(modal).findByText('Loose proxy · 10% overlap')).toBeInTheDocument();
  expect(within(modal).getByRole('link', { name: 'Direxion ↗' })).toHaveAttribute(
    'href',
    'https://www.direxion.com/product/daily-financial-bull-bear-3x-etfs',
  );
  expect(within(modal).getByRole('link', { name: 'Direxion ↗' })).toHaveAttribute('target', '_blank');
  expect(within(modal).getByRole('link', { name: 'Direxion ↗' })).toHaveAttribute('rel', 'noreferrer');
  const firstSignal = MarketDataService.getLeveragedProductOverlap.mock.calls[0][0].signal;

  fireEvent.mouseDown(within(modal).getByText('Tracks'));
  expect(screen.getByTestId('leveraged-product-modal')).toBe(modal);
  expect(firstSignal.aborted).toBe(false);
  fireEvent.click(within(modal).getByRole('button', { name: 'Close leveraged product details' }));
  expect(screen.queryByTestId('leveraged-product-modal')).not.toBeInTheDocument();
  expect(firstSignal.aborted).toBe(true);

  openProduct();
  const reopenedModal = screen.getByTestId('leveraged-product-modal');
  expect(await within(reopenedModal).findByText('Loose proxy · 10% overlap')).toBeInTheDocument();
  expect(MarketDataService.getLeveragedProductOverlap).toHaveBeenCalledTimes(2);
  const secondSignal = MarketDataService.getLeveragedProductOverlap.mock.calls[1][0].signal;
  expect(secondSignal).not.toBe(firstSignal);
  fireEvent.mouseDown(reopenedModal.parentElement);
  expect(screen.queryByTestId('leveraged-product-modal')).not.toBeInTheDocument();
  expect(secondSignal.aborted).toBe(true);
});

test('reuses an overlap request when switching products with the same base and holdings reference', async () => {
  const pending = deferredOverlap();
  MarketDataService.getLeveragedProductOverlap.mockReturnValue(pending.promise);
  render(<PortfolioBreakdown portfolioData={leveragedPortfolio()} />);
  const panel = await expandLeveragedResearch('IAK');
  fireEvent.click(within(panel).getByRole('button', { name: 'View UYG +2× details for IAK' }));
  const signal = MarketDataService.getLeveragedProductOverlap.mock.calls[0][0].signal;
  fireEvent.click(within(panel).getByRole('button', { name: 'View FAZ −3× details for IAK' }));

  expect(MarketDataService.getLeveragedProductOverlap).toHaveBeenCalledTimes(1);
  expect(signal.aborted).toBe(false);
  const modal = screen.getByTestId('leveraged-product-modal');
  expect(within(modal).getByRole('heading', { name: 'FAZ' })).toBeInTheDocument();
  await act(async () => { pending.resolve(verifiedLeveragedOverlap()); });
  expect(within(modal).getByText('Loose proxy · 10% overlap')).toBeInTheDocument();
});

test('aborts overlap while hidden, retains the selection on reactivation, and aborts again on unmount', async () => {
  const initial = deferredOverlap();
  const reactivated = deferredOverlap();
  MarketDataService.getLeveragedProductOverlap
    .mockReturnValueOnce(initial.promise)
    .mockReturnValueOnce(reactivated.promise);
  const data = leveragedPortfolio();
  const view = render(
    <PersistentSurface active>
      <PortfolioBreakdown portfolioData={data} />
    </PersistentSurface>,
  );
  const panel = await expandLeveragedResearch('IAK');
  fireEvent.click(within(panel).getByRole('button', { name: 'View FAZ −3× details for IAK' }));
  const firstSignal = MarketDataService.getLeveragedProductOverlap.mock.calls[0][0].signal;

  view.rerender(
    <PersistentSurface active={false}>
      <PortfolioBreakdown portfolioData={data} />
    </PersistentSurface>,
  );
  expect(screen.queryByTestId('leveraged-product-modal')).not.toBeInTheDocument();
  expect(firstSignal.aborted).toBe(true);
  await act(async () => { initial.resolve(verifiedLeveragedOverlap()); });
  expect(screen.queryByTestId('leveraged-product-modal')).not.toBeInTheDocument();
  // Hidden surfaces must not keep their modal's Escape listener attached.
  fireEvent.keyDown(document, { key: 'Escape' });

  view.rerender(
    <PersistentSurface active>
      <PortfolioBreakdown portfolioData={data} />
    </PersistentSurface>,
  );
  const modal = screen.getByTestId('leveraged-product-modal');
  expect(within(modal).getByRole('heading', { name: 'FAZ' })).toBeInTheDocument();
  expect(within(modal).queryByText(/% overlap/)).not.toBeInTheDocument();
  expect(MarketDataService.getLeveragedProductOverlap).toHaveBeenCalledTimes(2);
  const secondSignal = MarketDataService.getLeveragedProductOverlap.mock.calls[1][0].signal;
  expect(secondSignal.aborted).toBe(false);
  view.unmount();
  expect(secondSignal.aborted).toBe(true);
  await act(async () => { reactivated.resolve(verifiedLeveragedOverlap()); });
  expect(screen.queryByTestId('leveraged-product-modal')).not.toBeInTheDocument();
});

test('does not overwrite the newest overlap with an aborted response after rapid product changes', async () => {
  const oldRequest = deferredOverlap();
  const newRequest = deferredOverlap();
  MarketDataService.getLeveragedProductOverlap
    .mockReturnValueOnce(oldRequest.promise)
    .mockReturnValueOnce(newRequest.promise);
  render(<PortfolioBreakdown portfolioData={leveragedPortfolio(['IAK', 'GLD'])} />);
  const iakPanel = await expandLeveragedResearch('IAK');
  const goldPanel = await expandLeveragedResearch('GLD');
  fireEvent.click(within(iakPanel).getByRole('button', { name: 'View FAZ −3× details for IAK' }));
  const firstSignal = MarketDataService.getLeveragedProductOverlap.mock.calls[0][0].signal;

  fireEvent.click(within(goldPanel).getByRole('button', { name: 'View UGLD +2× details for GLD' }));
  expect(firstSignal.aborted).toBe(true);
  expect(within(screen.getByTestId('leveraged-product-modal')).getByText('Direct')).toBeInTheDocument();
  expect(MarketDataService.getLeveragedProductOverlap).toHaveBeenCalledTimes(1);
  fireEvent.click(within(iakPanel).getByRole('button', { name: 'View UYG +2× details for IAK' }));
  expect(MarketDataService.getLeveragedProductOverlap).toHaveBeenCalledTimes(2);

  await act(async () => { newRequest.resolve(verifiedLeveragedOverlap(20)); });
  const modal = screen.getByTestId('leveraged-product-modal');
  expect(within(modal).getByRole('heading', { name: 'UYG' })).toBeInTheDocument();
  expect(within(modal).getByText('Loose proxy · 20% overlap')).toBeInTheDocument();
  await act(async () => { oldRequest.resolve(verifiedLeveragedOverlap(9.6)); });
  expect(within(modal).getByText('Loose proxy · 20% overlap')).toBeInTheDocument();
  expect(within(modal).queryByText('Loose proxy · 10% overlap')).not.toBeInTheDocument();
});

test('does not request or infer holdings overlap for products without a holdings reference', async () => {
  render(<PortfolioBreakdown portfolioData={leveragedPortfolio(['GLD'])} />);
  const panel = await expandLeveragedResearch('GLD');
  for (const productName of ['View UGLD +2× details for GLD', 'View UGL +2× details for GLD']) {
    fireEvent.click(within(panel).getByRole('button', { name: productName }));
    const modal = screen.getByTestId('leveraged-product-modal');
    expect(within(modal).queryByText(/% overlap/)).not.toBeInTheDocument();
    expect(MarketDataService.getLeveragedProductOverlap).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('leveraged-product-modal')).not.toBeInTheDocument();
  }
});

test('disconnects the leveraged-products resize observer when its research row closes', async () => {
  const previousObserver = window.ResizeObserver;
  const observers = [];
  window.ResizeObserver = jest.fn(function MockResizeObserver(callback) {
    this.callback = callback;
    this.observe = jest.fn();
    this.disconnect = jest.fn();
    observers.push(this);
  });
  let view;
  try {
    view = render(<PortfolioBreakdown portfolioData={leveragedPortfolio(['GLD'])} />);
    const panel = await expandLeveragedResearch('GLD');
    const row = within(panel).getByTestId('leveraged-products-GLD');
    const content = row.querySelector('.pcv2-leveraged-products-content');
    const observer = observers.find((item) => item.observe.mock.calls.some(([target]) => target === row));
    expect(observer).toBeDefined();
    expect(observer.observe).toHaveBeenCalledWith(content);
    Object.defineProperty(row, 'clientWidth', { configurable: true, value: 200 });
    Object.defineProperty(content, 'scrollWidth', { configurable: true, value: 250 });
    act(() => { observer.callback(); });
    expect(row).toHaveAttribute('data-fit-scale', '0.7840');

    fireEvent.click(screen.getByRole('button', { name: 'Hide research intelligence for GLD' }));
    expect(screen.queryByTestId('leveraged-products-GLD')).not.toBeInTheDocument();
    expect(observer.disconnect).toHaveBeenCalledTimes(1);
  } finally {
    view?.unmount();
    window.ResizeObserver = previousObserver;
  }
});

test('removes the leveraged-products resize fallback listener when its research row closes', async () => {
  const previousObserver = window.ResizeObserver;
  window.ResizeObserver = undefined;
  const addListener = jest.spyOn(window, 'addEventListener');
  const removeListener = jest.spyOn(window, 'removeEventListener');
  let view;
  try {
    view = render(<PortfolioBreakdown portfolioData={leveragedPortfolio(['GLD'])} />);
    const callsBeforeExpansion = addListener.mock.calls.length;
    const panel = await expandLeveragedResearch('GLD');
    const row = within(panel).getByTestId('leveraged-products-GLD');
    const content = row.querySelector('.pcv2-leveraged-products-content');
    const listeners = addListener.mock.calls.slice(callsBeforeExpansion).filter(([type]) => type === 'resize');
    expect(listeners).toHaveLength(1);
    Object.defineProperty(row, 'clientWidth', { configurable: true, value: 200 });
    Object.defineProperty(content, 'scrollWidth', { configurable: true, value: 250 });
    fireEvent(window, new Event('resize'));
    expect(row).toHaveAttribute('data-fit-scale', '0.7840');

    fireEvent.click(screen.getByRole('button', { name: 'Hide research intelligence for GLD' }));
    expect(removeListener).toHaveBeenCalledWith('resize', listeners[0][1]);
  } finally {
    view?.unmount();
    addListener.mockRestore();
    removeListener.mockRestore();
    window.ResizeObserver = previousObserver;
  }
});

test('renders indexed products without evidence as N/A with a disabled detail summary', async () => {
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
  expect(within(macroRow).queryByRole('button')).not.toBeInTheDocument();
  expect(within(macroRow).queryByText('VIEW ›')).not.toBeInTheDocument();
  const callRow = within(panel).getByText('The Call').closest('.pcv2-intel-reference-row');
  expect(callRow.children).toHaveLength(3);
  expect(callRow.children[0]).toHaveClass('pcv2-intel-span-2');
  expect(callRow.children[1]).toHaveClass('pcv2-intel-span-2');
  expect(callRow.children[2]).toHaveClass('pcv2-intel-span-16');
});

test('renders the registered product roster once in registry order', async () => {
  const envelope = currentEnvelope();
  const today = marketDate();
  envelope.products = registeredResearchProducts.map(([id, label]) => ({
    id,
    label,
    status: 'indexed',
    marketDate: today,
  })).concat([
    { id: 'cftc-positioning', label: 'CFTC Positioning', status: 'indexed', marketDate: today },
    { id: 'crypto-quant', label: 'Crypto Quant', status: 'indexed', marketDate: today },
    { id: 'market-structure', label: 'Market Situation Report', status: 'indexed', marketDate: today },
    { id: 'momo-tracker', label: 'MOMO Tracker', status: 'indexed', marketDate: today },
    { id: 'volume', label: 'Volume / Market Structure', status: 'indexed', marketDate: today },
  ]);
  MarketDataService.getSecurityIntelligence.mockResolvedValueOnce(envelope);

  render(<PortfolioBreakdown portfolioData={{
    ...portfolioData,
    holdings: [portfolioData.holdings[0]],
  }} />);
  await waitFor(() => expect(MarketDataService.getSecurityIntelligence).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole('button', { name: 'Show research intelligence for GLD' }));

  const panel = screen.getByLabelText('Research intelligence for GLD');
  await within(panel).findByText('FULL');
  const rows = within(panel).getAllByTestId(/research-product-row-/);
  expect(rows).toHaveLength(registeredResearchProducts.length);
  expect(rows.map((row) => row.querySelector('.pcv2-intel-reference-product')?.textContent))
    .toEqual(registeredResearchProducts.map(([, label]) => label));
  registeredResearchProducts.forEach(([, label], index) => {
    expect(within(rows[index]).getByText(label)).toBeInTheDocument();
  });
  expect(rows).toHaveLength(registeredResearchProducts.length);
  expect(within(panel).queryByText('CFTC Positioning')).not.toBeInTheDocument();
  expect(within(panel).queryByText('Crypto Quant')).not.toBeInTheDocument();
  expect(within(panel).queryByText('Market Situation Report')).not.toBeInTheDocument();
  expect(within(panel).queryByText('MOMO Tracker')).not.toBeInTheDocument();
  expect(within(panel).queryByText('Volume / Market Structure')).not.toBeInTheDocument();
  expect(within(panel).queryByText('unknown')).not.toBeInTheDocument();
});

test('shows only structured PM evidence and suppresses timestamp collisions', async () => {
  const today = marketDate();
  const historyDate = priorDate();
  const timestampSnapshots = (date) => [
    {
      date,
      snapshotType: 'signal-strength',
      publishedAt: `${date}T16:29:00Z`,
      article: {
        bodyText: `View it in your browser ${date} 12:29 PM EDT Signal Strength Stocks.`,
      },
      data: { added: ['AFRM'], removed: [] },
    },
    {
      date,
      snapshotType: 'real-time-alert',
      publishedAt: `${date}T19:36:00Z`,
      article: { bodyText: `View it in your browser ${date} 03:36 PM EDT SELL SIGNAL.` },
      data: {},
    },
    {
      date,
      snapshotType: 'etf-pro',
      publishedAt: `${date}T18:05:00Z`,
      article: { bodyText: `View it in your browser ${date} 02:05 PM EDT ETF Pro Plus.` },
      data: {},
    },
  ];
  const envelope = buildSecurityIntelligence({
    symbols: ['PM'],
    marketDate: today,
    historyDays: 1,
    now: new Date(`${today}T22:00:00Z`),
    snapshots: [
      ...timestampSnapshots(today),
      ...timestampSnapshots(historyDate),
      {
        date: today,
        snapshotType: 'investing-ideas',
        publishedAt: `${today}T20:00:00Z`,
        data: {
          positions: [{
            ticker: 'PM',
            side: 'Long',
            prevClose: 189.57,
            lrr: 182,
            hrr: 201,
          }],
        },
      },
    ],
    productManifests: [
      indexedResearchManifest('signal-strength', today),
      indexedResearchManifest('real-time-alert', today),
      indexedResearchManifest('etf-pro', today),
      indexedResearchManifest('investing-ideas', today),
    ],
    riskRangeEnvelope: { status: 'stale', available: false, ranges: {} },
  });
  MarketDataService.getSecurityIntelligence.mockResolvedValueOnce(envelope);

  render(<PortfolioBreakdown portfolioData={{
    ...portfolioData,
    holdings: [{
      ...portfolioData.holdings[0],
      symbol: 'PM',
      conid: 'PM-1',
      description: 'Philip Morris International',
      price: 186,
    }],
  }} />);
  await waitFor(() => expect(MarketDataService.getSecurityIntelligence).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole('button', { name: 'Show research intelligence for PM' }));

  const panel = screen.getByLabelText('Research intelligence for PM');
  await within(panel).findByText('Investing Ideas');
  const rowFor = (productId) => within(panel).getByTestId(
    new RegExp(`research-product-row-.*-${productId}$`),
  );
  ['signal-strength', 'real-time-alert', 'etf-pro'].forEach((productId) => {
    const row = rowFor(productId);
    expect(within(row).getByText('N/A')).toBeInTheDocument();
    expect(within(row).queryByRole('button')).not.toBeInTheDocument();
  });

  const investingRow = rowFor('investing-ideas');
  expect(within(investingRow).getByText('PM Investing Ideas risk range is 182–201.')).toBeInTheDocument();
  fireEvent.click(within(investingRow).getByRole('button', {
    name: 'View Investing Ideas facts for PM',
  }));
  const context = within(panel).getByRole('region', { name: 'Investing Ideas facts for PM' });
  expect(within(context).getByText('PM Investing Ideas position is LONG.')).toBeInTheDocument();
  expect(within(panel).getAllByRole('link', { name: 'OPEN SOURCE ↗' })).toHaveLength(1);
  await waitFor(() => expect(within(panel).getByText(/Previous 5 market days/))
    .toHaveTextContent('Previous 5 market days (0 product rows)'));
});

test('shows MOMO Tracker only for securities with direct MOMO coverage', async () => {
  const today = marketDate();
  const envelope = currentEnvelope();
  envelope.products.push({
    id: 'momo-tracker',
    label: 'MOMO Tracker',
    status: 'indexed',
    marketDate: today,
    eventCount: 1,
  });
  envelope.bySymbol.GOOGL = {
    symbol: 'GOOGL',
    state: 'complete',
    decision: {},
    supplementalRange: null,
    exposures: [],
    directReferences: [{
      id: 'googl-momo-direct',
      marketDate: today,
      productId: 'momo-tracker',
      productLabel: 'MOMO Tracker',
      kind: 'tracker_trade',
      direction: 'BULLISH',
      value: 'BULLISH',
      excerpt: 'Trade BULLISH; Buy Trade 317; Sell Trade 377',
      matchedText: 'GOOGL',
      matchType: 'direct',
      qualityStatus: 'indexed',
      publishedAt: `${today}T11:47:44Z`,
      sourceUrl: '/research/momo-tracker',
    }],
    inferredReferences: [],
    history: [],
    coverage: { state: 'complete', reasons: [] },
  };
  MarketDataService.getSecurityIntelligence.mockResolvedValueOnce(envelope);

  render(<PortfolioBreakdown portfolioData={{
    ...portfolioData,
    holdings: [
      {
        ...portfolioData.holdings[0],
        symbol: 'GOOGL',
        description: 'Alphabet',
      },
      portfolioData.holdings[2],
    ],
  }} />);
  await waitFor(() => expect(MarketDataService.getSecurityIntelligence).toHaveBeenCalledTimes(1));

  fireEvent.click(screen.getByRole('button', { name: 'Show research intelligence for GOOGL' }));
  const googlPanel = screen.getByLabelText('Research intelligence for GOOGL');
  await within(googlPanel).findByText('FULL');
  const momoRow = within(googlPanel).getByText('MOMO Tracker').closest('.pcv2-intel-reference-row');
  expect(within(momoRow).getByText('GOOGL trade signal is BULLISH.')).toBeInTheDocument();
  expect(within(googlPanel).queryByText('Market Situation Report')).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'Show research intelligence for NEM' }));
  const nemPanel = screen.getByLabelText('Research intelligence for NEM');
  await within(nemPanel).findByText('FULL');
  expect(within(nemPanel).queryByText('MOMO Tracker')).not.toBeInTheDocument();
  expect(within(nemPanel).queryByText('Market Situation Report')).not.toBeInTheDocument();
});

test('renders only canonical bias labels when tracker direction conflicts with its structured value', async () => {
  const today = marketDate();
  const envelope = currentEnvelope();
  envelope.products.push(
    {
      id: 'risk-ranges',
      label: 'Risk Ranges',
      status: 'indexed',
      marketDate: today,
      eventCount: 1,
    },
    {
      id: 'momo-tracker',
      label: 'MOMO Tracker',
      status: 'indexed',
      marketDate: today,
      eventCount: 1,
    },
  );
  envelope.bySymbol = {
    AMZN: {
      ...envelope.bySymbol.GLD,
      symbol: 'AMZN',
      decision: {
        ...envelope.bySymbol.GLD.decision,
        trade: {
          status: 'available',
          value: 'BULLISH',
          signalProvenance: publishedTradeProvenance('BULLISH'),
          sourceId: 'momo-tracker',
          sourceLabel: 'MOMO Tracker',
          sourceDate: today,
        },
        trend: {
          status: 'available',
          value: 'BULLISH',
          sourceId: 'risk-ranges',
          sourceLabel: 'Risk Ranges',
          sourceDate: today,
        },
      },
      directReferences: [
        {
          id: 'amzn-momo-negative-narrative',
          marketDate: today,
          productId: 'momo-tracker',
          productLabel: 'MOMO Tracker',
          kind: 'trade_signal',
          direction: 'NEGATIVE',
          value: 'BULLISH',
          matchedText: 'AMZN',
          excerpt: 'AMZN: {"trend":"BULLISH","buyTrade":"258","sellTrade":"300"}',
          matchType: 'direct',
          qualityStatus: 'indexed',
          publishedAt: `${today}T13:00:00Z`,
          sourceUrl: '/research/momo-tracker',
        },
        {
          id: 'amzn-risk-range',
          marketDate: today,
          productId: 'risk-ranges',
          productLabel: 'Risk Ranges',
          kind: 'primary_risk_range',
          direction: 'NEGATIVE',
          value: { lrr: 258, hrr: 300, trend: 'BULLISH' },
          matchedText: 'AMZN',
          excerpt: 'AMZN LRR 258 – HRR 300; Trend BULLISH',
          matchType: 'direct',
          qualityStatus: 'indexed',
          publishedAt: `${today}T12:00:00Z`,
          sourceUrl: '/research/risk-ranges',
        },
      ],
      inferredReferences: [],
      history: [],
    },
  };
  MarketDataService.getSecurityIntelligence.mockResolvedValueOnce(envelope);

  render(<PortfolioBreakdown portfolioData={{
    ...portfolioData,
    holdings: [{
      ...portfolioData.holdings[0],
      symbol: 'AMZN',
      description: 'Amazon',
    }],
  }} />);
  await waitFor(() => expect(MarketDataService.getSecurityIntelligence).toHaveBeenCalledTimes(1));

  fireEvent.click(screen.getByRole('button', { name: 'Show research intelligence for AMZN' }));
  const panel = screen.getByLabelText('Research intelligence for AMZN');
  await waitFor(() => expect(within(panel).getAllByText('BULLISH').length).toBeGreaterThanOrEqual(2));

  const decisionValues = within(panel).getByLabelText('AMZN decision intelligence');
  expect(within(decisionValues.children[1]).getByText('BULLISH')).toBeInTheDocument();
  expect(within(decisionValues.children[2]).getByText('BULLISH')).toBeInTheDocument();
  expect(within(panel).getByText('AMZN trade signal is BULLISH.')).toBeInTheDocument();
  const riskRangeRow = within(panel).getByTestId(
    /research-product-row-.*-risk-ranges$/,
  );
  fireEvent.click(within(riskRangeRow).getByRole('button', {
    name: 'View Risk Ranges facts for AMZN',
  }));
  expect(within(panel).getByText('AMZN trend is BULLISH.')).toBeInTheDocument();
  expect(within(panel).queryByText('NEGATIVE')).not.toBeInTheDocument();
});

test('shows a compact loading state before the expanded research payload arrives', async () => {
  let resolveCurrent;
  const pendingCurrent = new Promise((resolve) => {
    resolveCurrent = resolve;
  });
  MarketDataService.getSecurityIntelligence.mockReturnValueOnce(pendingCurrent);

  render(<PortfolioBreakdown portfolioData={{
    ...portfolioData,
    holdings: [portfolioData.holdings[0]],
  }} />);

  fireEvent.click(screen.getByRole('button', { name: 'Show research intelligence for GLD' }));
  const panel = screen.getByLabelText('Research intelligence for GLD');
  expect(panel).toHaveAttribute('aria-busy', 'true');
  expect(within(panel).getByRole('status')).toHaveTextContent('Loading verified research');
  expect(within(panel).queryByTestId(/research-product-row-/)).not.toBeInTheDocument();

  resolveCurrent(currentEnvelope());
  await waitFor(() => expect(within(panel).getAllByText('BULLISH').length).toBeGreaterThanOrEqual(2));
  await waitFor(() => expect(MarketDataService.getSecurityIntelligence).toHaveBeenCalledTimes(2));
  expect(MarketDataService.getSecurityIntelligence.mock.calls[0][0]).toEqual(expect.objectContaining({
    historyDays: 0,
  }));
  expect(MarketDataService.getSecurityIntelligence.mock.calls[1][0]).toEqual(expect.objectContaining({
    historyDays: 5,
  }));
});

test('fails closed with an unavailable roster when the bulk research request fails', async () => {
  MarketDataService.getSecurityIntelligence.mockRejectedValueOnce(new Error('research unavailable'));

  render(<PortfolioBreakdown portfolioData={{
    ...portfolioData,
    holdings: [portfolioData.holdings[0]],
  }} />);
  await waitFor(() => expect(MarketDataService.getSecurityIntelligence).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole('button', { name: 'Show research intelligence for GLD' }));

  const panel = screen.getByLabelText('Research intelligence for GLD');
  await waitFor(() => expect(within(panel).getAllByTestId(/research-product-row-/))
    .toHaveLength(registeredResearchProducts.length));
  const rows = within(panel).getAllByTestId(/research-product-row-/);
  expect(rows).toHaveLength(registeredResearchProducts.length);
  rows.forEach((row) => {
    expect(within(row).getByText('UNAVAILABLE')).toBeInTheDocument();
    expect(within(row).queryByText('VIEW ›')).not.toBeInTheDocument();
    expect(within(row).queryByRole('button')).not.toBeInTheDocument();
  });
});

test('renders a controlled alias mention while keeping mapped-only products empty', async () => {
  const envelope = currentEnvelope();
  envelope.bySymbol.GLD.directReferences[0] = {
    ...envelope.bySymbol.GLD.directReferences[0],
    matchedText: 'Gold',
    matchType: 'direct_alias',
    excerpt: 'The desk reviewed the macro backdrop. Gold remains a preferred long. Risk stays contained.',
    sourceUrl: 'javascript:alert(1)',
  };
  envelope.bySymbol.GLD.directReferences.push({
    ...envelope.bySymbol.GLD.directReferences[0],
    id: 'direct-nested-duplicate',
    excerpt: 'Gold remains a preferred long.',
  });
  envelope.bySymbol.GLD.inferredReferences[0] = {
    ...envelope.bySymbol.GLD.inferredReferences[0],
    matchedText: 'Gold',
    excerpt: 'Commodity exposure is constructive. Gold exposure remains supported. Keep sizing disciplined.',
  };
  MarketDataService.getSecurityIntelligence.mockResolvedValueOnce(envelope);

  render(<PortfolioBreakdown portfolioData={{
    ...portfolioData,
    holdings: [portfolioData.holdings[0]],
  }} />);
  await waitFor(() => expect(MarketDataService.getSecurityIntelligence).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole('button', { name: 'Show research intelligence for GLD' }));

  const panel = screen.getByLabelText('Research intelligence for GLD');
  await within(panel).findByText('FULL');
  const callRow = within(panel).getByText('The Call').closest('.pcv2-intel-reference-row');
  const macroRow = within(panel).getByText('Macro Show').closest('.pcv2-intel-reference-row');
  fireEvent.click(within(callRow).getByRole('button', { name: 'View The Call context for GLD' }));

  const callContext = within(panel).getByRole('region', { name: 'The Call facts for GLD' });
  expect(callContext).toBeInTheDocument();
  expect(within(callContext).getByText('Gold remains a preferred long.')).toBeInTheDocument();
  expect(within(callContext).getAllByRole('listitem')).toHaveLength(1);
  expect(within(macroRow).getByText('N/A')).toBeInTheDocument();
  expect(within(macroRow).queryByRole('button', {
    name: 'View Macro Show context for GLD',
  })).not.toBeInTheDocument();
  expect(within(macroRow).queryByText('VIEW ›')).not.toBeInTheDocument();
  expect(within(panel).queryByRole('region', { name: 'Macro Show facts for GLD' })).not.toBeInTheDocument();
  expect(within(panel).queryByText(/Mapped from/i)).not.toBeInTheDocument();
  expect(within(callContext).getByText('SOURCE UNAVAILABLE')).toBeInTheDocument();
  expect(within(callContext).queryByRole('link', { name: 'OPEN SOURCE ↗' })).not.toBeInTheDocument();
  expect(within(callRow).getByRole('button', {
    name: 'Collapse The Call context for GLD',
  })).toHaveTextContent('Gold remains a preferred long.');
  expect(MarketDataService.getSecurityIntelligence).toHaveBeenCalledTimes(2);

  fireEvent.click(within(callRow).getByRole('button', { name: 'Collapse The Call context for GLD' }));
  expect(within(panel).queryByRole('region', { name: 'The Call facts for GLD' })).not.toBeInTheDocument();
});

test('rejects CLOZ credit mappings from Risk Ranges, Early Look, and history', async () => {
  MarketDataService.getSecurityIntelligence.mockResolvedValueOnce(clozEnvelope());

  render(<PortfolioBreakdown portfolioData={{
    ...portfolioData,
    holdings: [{
      ...portfolioData.holdings[0],
      symbol: 'CLOZ',
      conid: 'CLOZ-1',
      description: 'Janus Henderson AAA CLO ETF',
    }],
  }} />);
  await waitFor(() => expect(MarketDataService.getSecurityIntelligence).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole('button', { name: 'Show research intelligence for CLOZ' }));

  const panel = screen.getByLabelText('Research intelligence for CLOZ');
  await within(panel).findByText('FULL');
  await waitFor(() => expect(within(panel).getByText('Previous 5 market days (0 product rows)')).toBeInTheDocument());
  const riskRow = within(panel).getByText('Risk Ranges').closest('.pcv2-intel-reference-row');
  const earlyRow = within(panel).getByText('Early Look').closest('.pcv2-intel-reference-row');

  expect(within(riskRow).getByText('N/A')).toBeInTheDocument();
  expect(within(earlyRow).getByText('N/A')).toBeInTheDocument();
  expect(within(riskRow).queryByRole('button', { name: /Risk Ranges context for CLOZ/ })).not.toBeInTheDocument();
  expect(within(earlyRow).queryByRole('button', { name: /Early Look context for CLOZ/ })).not.toBeInTheDocument();
  expect(within(panel).queryByText(/Mapped from Credit/i)).not.toBeInTheDocument();
  expect(within(panel).queryByText(/Investment Grade Corporate Bond ETF|High Yield \(HYG\)/i)).not.toBeInTheDocument();
  expect(within(panel).getByText('Previous 5 market days (0 product rows)')).toBeInTheDocument();
});

test('keeps direct primary and supplemental CLOZ risk ranges', async () => {
  const envelope = clozEnvelope();
  const today = marketDate();
  envelope.bySymbol.CLOZ.directReferences = [
    {
      id: 'cloz-primary-range',
      marketDate: today,
      productId: 'risk-ranges',
      productLabel: 'Risk Ranges',
      kind: 'primary_risk_range',
      direction: 'BULLISH',
      excerpt: 'LRR 26.1 – HRR 26.8; Trend BULLISH',
      matchedText: 'CLOZ',
      matchType: 'direct',
      qualityStatus: 'indexed',
      publishedAt: `${today}T11:20:40Z`,
      sourceUrl: '/research/risk-ranges',
      value: { lrr: 26.1, hrr: 26.8, trend: 'BULLISH' },
      decisionEligible: true,
    },
  ];
  envelope.bySymbol.CLOZ.supplementalRange = {
    status: 'available',
    pipelineStatus: 'indexed',
    lrr: 26,
    hrr: 26.9,
    trend: 'BULLISH',
    sourceId: 'early-look',
    sourceLabel: 'Early Look',
    sourceDate: today,
    publishedAt: `${today}T11:48:26Z`,
    sourceUrl: '/research/early-look',
    decisionEligible: false,
  };
  MarketDataService.getSecurityIntelligence.mockResolvedValueOnce(envelope);

  render(<PortfolioBreakdown portfolioData={{
    ...portfolioData,
    holdings: [{
      ...portfolioData.holdings[0],
      symbol: 'CLOZ',
      conid: 'CLOZ-1',
      description: 'Janus Henderson AAA CLO ETF',
    }],
  }} />);
  await waitFor(() => expect(MarketDataService.getSecurityIntelligence).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole('button', { name: 'Show research intelligence for CLOZ' }));

  const panel = screen.getByLabelText('Research intelligence for CLOZ');
  await within(panel).findByText('FULL');
  const riskRow = within(panel).getByText('Risk Ranges').closest('.pcv2-intel-reference-row');
  const earlyRow = within(panel).getByText('Early Look').closest('.pcv2-intel-reference-row');
  fireEvent.click(within(riskRow).getByRole('button', { name: 'View Risk Ranges context for CLOZ' }));
  fireEvent.click(within(earlyRow).getByRole('button', { name: 'View Early Look context for CLOZ' }));

  expect(within(panel).getByText('CLOZ risk range is 26.1–26.8.')).toBeInTheDocument();
  expect(within(earlyRow).getByText('CLOZ risk range is 26–26.9.')).toBeInTheDocument();
  expect(within(panel).queryByText(/Mapped from Credit/i)).not.toBeInTheDocument();
});

test('caps narrative fallback at four exact source sentences and one source link', async () => {
  const envelope = currentEnvelope();
  envelope.bySymbol.GLD.directReferences = [1, 2, 3, 4, 5].map((number) => ({
    id: `call-fact-${number}`,
    marketDate: marketDate(),
    productId: 'the-call',
    productLabel: 'The Call',
    kind: 'summary_mention',
    excerpt: `GLD fact ${number}.`,
    matchedText: 'GLD',
    matchType: 'direct',
    qualityStatus: 'indexed',
    publishedAt: `${marketDate()}T13:42:00Z`,
    sourceUrl: `/research/the-call/fact-${number}`,
  }));
  MarketDataService.getSecurityIntelligence.mockResolvedValueOnce(envelope);

  render(<PortfolioBreakdown portfolioData={{
    ...portfolioData,
    holdings: [portfolioData.holdings[0]],
  }} />);
  await waitFor(() => expect(MarketDataService.getSecurityIntelligence).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole('button', { name: 'Show research intelligence for GLD' }));

  const panel = screen.getByLabelText('Research intelligence for GLD');
  await within(panel).findByText('FULL');
  const row = within(panel).getByText('The Call').closest('.pcv2-intel-reference-row');
  expect(within(row).getByText('GLD fact 1.')).toBeInTheDocument();
  fireEvent.click(within(row).getByRole('button', { name: 'View The Call context for GLD' }));

  const context = within(panel).getByRole('region', { name: 'The Call facts for GLD' });
  expect(within(context).getAllByRole('listitem')).toHaveLength(3);
  expect(within(context).queryByText('GLD fact 1.')).not.toBeInTheDocument();
  expect(within(context).getByText('GLD fact 2.')).toBeInTheDocument();
  expect(within(context).queryByText('GLD fact 5.')).not.toBeInTheDocument();
  expect(within(context).getAllByRole('link', { name: 'OPEN SOURCE ↗' })).toHaveLength(1);
});

test('renders missing ingestion as UNAVAILABLE instead of N/A', async () => {
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
  expect(within(macroRow).getByText('UNAVAILABLE')).toBeInTheDocument();
  expect(within(macroRow).queryByRole('button')).not.toBeInTheDocument();
  expect(within(macroRow).queryByText('VIEW ›')).not.toBeInTheDocument();
});

test('renders Portfolio Solutions as four deterministic fact sentences and one source link', async () => {
  const envelope = currentEnvelope();
  envelope.products.push({
    id: 'portfolio-solutions',
    label: 'Portfolio Solutions',
    status: 'indexed',
    marketDate: marketDate(),
    publishedAt: `${marketDate()}T14:26:05.000Z`,
  });
  envelope.bySymbol.GLD.directReferences.push(
    {
      id: 'portfolio-rank',
      marketDate: marketDate(),
      productId: 'portfolio-solutions',
      productLabel: 'Portfolio Solutions',
      kind: 'portfolio_solutions_rank',
      excerpt: 'GLD ranked #4; Sizing 2% – 6%; Weekly ▲ 3',
      value: 4,
      matchType: 'direct',
      qualityStatus: 'indexed',
      sourceUrl: '/research/portfolio-solutions',
    },
    {
      id: 'portfolio-weekly',
      marketDate: marketDate(),
      productId: 'portfolio-solutions',
      productLabel: 'Portfolio Solutions',
      kind: 'portfolio_solutions_mover',
      direction: 'UP',
      excerpt: 'GLD weekly rank change 3',
      value: 3,
      matchType: 'direct',
      qualityStatus: 'indexed',
    },
    {
      id: 'portfolio-monthly',
      marketDate: marketDate(),
      productId: 'portfolio-solutions',
      productLabel: 'Portfolio Solutions',
      kind: 'portfolio_solutions_mover',
      direction: 'UP',
      excerpt: 'GLD monthly rank change 7',
      value: 7,
      matchType: 'direct',
      qualityStatus: 'indexed',
    },
    {
      id: 'portfolio-email-body',
      marketDate: marketDate(),
      productId: 'portfolio-solutions',
      productLabel: 'Portfolio Solutions',
      kind: 'summary_mention',
      excerpt: 'HEDGEYE This research was prepared exclusively for a subscriber. Having trouble viewing this email?',
      matchType: 'direct',
      qualityStatus: 'indexed',
    },
  );
  MarketDataService.getSecurityIntelligence.mockResolvedValueOnce(envelope);

  render(<PortfolioBreakdown portfolioData={{
    ...portfolioData,
    holdings: [portfolioData.holdings[0]],
  }} />);
  await waitFor(() => expect(MarketDataService.getSecurityIntelligence).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole('button', { name: 'Show research intelligence for GLD' }));

  const panel = screen.getByLabelText('Research intelligence for GLD');
  await within(panel).findByText('FULL');
  expect(within(panel).getAllByText('Portfolio Solutions')).toHaveLength(1);
  const row = within(panel).getByText('Portfolio Solutions').closest('.pcv2-intel-reference-row');
  expect(within(row).getByText('GLD is ranked #4 today.')).toBeInTheDocument();
  fireEvent.click(within(row).getByRole('button', {
    name: 'View Portfolio Solutions facts for GLD',
  }));
  const context = within(panel).getByRole('region', {
    name: 'Portfolio Solutions facts for GLD',
  });
  expect(within(context).getByText(
    'Recommended position sizing is 2% – 6%.'
  )).toBeInTheDocument();
  expect(within(context).getByText('Weekly rank change is +3.')).toBeInTheDocument();
  expect(within(context).getByText('Monthly rank change is +7.')).toBeInTheDocument();
  expect(within(context).getAllByRole('listitem')).toHaveLength(3);
  expect(within(context).queryByText('GLD is ranked #4 today.')).not.toBeInTheDocument();
  expect(within(context).getByText(/Source: Portfolio Solutions · .+ · (?:09|10):26 ET/)).toBeInTheDocument();
  expect(within(context).getAllByRole('link', { name: 'OPEN SOURCE ↗' })).toHaveLength(1);
  expect(within(context).getByRole('link', { name: 'OPEN SOURCE ↗' })).toHaveAttribute(
    'href',
    '/research/portfolio-solutions',
  );
  expect(within(row).getByRole('button', {
    name: 'Collapse Portfolio Solutions context for GLD',
  })).toHaveTextContent('GLD is ranked #4 today.');
  expect(within(panel).queryByText(/prepared exclusively/i)).not.toBeInTheDocument();
});

test.each([
  ['risk-ranges', 'Risk Ranges', 'explicit-field'],
  ['early-look', 'Early Look', 'explicit-statement'],
  ['the-call', 'The Call', 'explicit-statement'],
])('shows independently published Trade from %s without requiring a tracker product', async (sourceId, sourceLabel, method) => {
  const envelope = currentEnvelope();
  envelope.bySymbol.GLD.decision.trade = {
    status: 'available', qualityStatus: 'indexed', value: 'BEARISH', sourceId, sourceLabel, sourceDate: marketDate(),
    sourceTicker: 'GLD', sourceUrl: 'https://app.hedgeye.com/feed_items/123', matchType: 'direct',
    signalProvenance: { field: 'trade', method, sourceField: method === 'explicit-field' ? 'trade' : 'body', sourceText: 'GLD Trade is Bearish' },
  };
  MarketDataService.getSecurityIntelligence.mockResolvedValue(envelope);
  render(<PortfolioBreakdown portfolioData={{ ...portfolioData, holdings: [portfolioData.holdings[0]] }} />);
  fireEvent.click(screen.getByRole('button', { name: 'Show research intelligence for GLD' }));
  const panel = screen.getByLabelText('Research intelligence for GLD');
  await waitFor(() => expect(within(panel).getByLabelText('GLD decision intelligence').children[1]).toHaveTextContent('BEARISH'));
  const [, tradeCell, trendCell] = within(panel).getByLabelText('GLD decision intelligence').children;
  expect(trendCell).toHaveTextContent('BULLISH');
  expect(tradeCell).not.toHaveClass('is-reference');
  expectCellProvenance(tradeCell, new RegExp(sourceLabel));
});

test.each([
  { status: 'stale', qualityStatus: 'indexed' },
  { status: 'failed', qualityStatus: 'validated' },
  { status: 'indexed', qualityStatus: 'indexed' },
  { status: undefined, qualityStatus: 'indexed' },
  { status: 'available', qualityStatus: 'unvalidated' },
  { status: 'available', qualityStatus: 'indexed', source: { status: 'stale', qualityStatus: 'indexed' } },
  { status: 'available', qualityStatus: 'indexed', source: { qualityStatus: 'invalid' } },
])('keeps decision availability independent of publication validation: %p', async patch => {
  const envelope = currentEnvelope();
  Object.assign(envelope.bySymbol.GLD.decision.trade, patch);
  MarketDataService.getSecurityIntelligence.mockResolvedValue(envelope);
  render(<PortfolioBreakdown portfolioData={{ ...portfolioData, holdings: [portfolioData.holdings[0]] }} />);
  fireEvent.click(screen.getByRole('button', { name: 'Show research intelligence for GLD' }));
  const panel = screen.getByLabelText('Research intelligence for GLD');
  await waitFor(() => expect(within(panel).getByLabelText('GLD decision intelligence').children[2]).toHaveTextContent('BULLISH'));
  expect(within(panel).getByLabelText('GLD decision intelligence').children[1]).toHaveTextContent('—');
});

test.each([
  null,
  { field: 'trend', method: 'explicit-field', sourceField: 'trend', sourceText: 'Bullish' },
  { field: 'trade', method: 'derived', sourceField: 'rank', sourceText: 'Rank 4' },
  { field: 'trade', method: 'explicit-statement', sourceField: 'body', sourceText: '' },
])('withholds Trade without explicit directional source provenance: %p', async signalProvenance => {
  const envelope = currentEnvelope();
  envelope.bySymbol.GLD.decision.trade.signalProvenance = signalProvenance;
  MarketDataService.getSecurityIntelligence.mockResolvedValue(envelope);
  render(<PortfolioBreakdown portfolioData={{ ...portfolioData, holdings: [portfolioData.holdings[0]] }} />);
  fireEvent.click(screen.getByRole('button', { name: 'Show research intelligence for GLD' }));
  const panel = screen.getByLabelText('Research intelligence for GLD');
  await waitFor(() => expect(within(panel).getByLabelText('GLD decision intelligence').children[2]).toHaveTextContent('BULLISH'));
  expect(within(panel).getByLabelText('GLD decision intelligence').children[1]).toHaveTextContent('—');
});

test('keeps Portfolio Solutions listing context separate from an unpublished Trade direction', async () => {
  const envelope = currentEnvelope();
  const today = marketDate();
  envelope.products.push({
    id: 'portfolio-solutions',
    label: 'Portfolio Solutions',
    status: 'indexed',
    marketDate: today,
  });
  envelope.bySymbol.GLD.decision = {};
  envelope.bySymbol.GLD.directReferences = [{
    id: 'portfolio-rank-display',
    marketDate: today,
    productId: 'portfolio-solutions',
    productLabel: 'Portfolio Solutions',
    kind: 'portfolio_solutions_rank',
    excerpt: 'GLD ranked #4',
    value: 4,
    matchType: 'direct',
    qualityStatus: 'indexed',
    publishedAt: `${today}T14:26:05.000Z`,
    sourceUrl: '/research/portfolio-solutions',
  }];
  MarketDataService.getSecurityIntelligence.mockResolvedValueOnce(envelope);

  render(<PortfolioBreakdown portfolioData={{
    ...portfolioData,
    holdings: [portfolioData.holdings[0]],
  }} />);
  await waitFor(() => expect(MarketDataService.getSecurityIntelligence).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole('button', { name: 'Show research intelligence for GLD' }));

  const panel = screen.getByLabelText('Research intelligence for GLD');
  await within(panel).findByText('FULL');
  const decisionValues = within(panel).getByLabelText('GLD decision intelligence');
  const [, tradeCell, trendCell] = [...decisionValues.children];
  expect(tradeCell).toHaveTextContent('—');
  expect(within(trendCell).getByText('BULLISH')).toBeInTheDocument();
  expect(tradeCell).not.toHaveClass('is-reference');
  expect(trendCell).toHaveClass('is-reference');
  expect(tradeCell).not.toHaveAttribute('aria-label', expect.stringContaining('Portfolio Solutions'));
  expect(trendCell).toHaveAttribute('aria-label', expect.stringContaining('Portfolio Solutions'));
});

test('shows published LRR and HRR without aligned Trade and Trend or prior ranges', async () => {
  const envelope = currentEnvelope();
  envelope.bySymbol.GLD.decision.trade = null;
  envelope.bySymbol.GLD.decision.trend = null;
  envelope.bySymbol.GLD.history = [];
  MarketDataService.getSecurityIntelligence.mockResolvedValue(envelope);
  render(<PortfolioBreakdown portfolioData={{ ...portfolioData, holdings: [portfolioData.holdings[0]] }} />);
  fireEvent.click(screen.getByRole('button', { name: 'Show research intelligence for GLD' }));
  const panel = screen.getByLabelText('Research intelligence for GLD');
  await waitFor(() => expect(within(panel).getByLabelText(/Low price risk range$/)).toHaveTextContent('2,900'));
  expect(within(panel).getByLabelText(/High price risk range$/)).toHaveTextContent('3,010');
  expect(within(panel).getByText('LRR')).toHaveAttribute('title', 'Low price risk range');
  expect(within(panel).getByText('HRR')).toHaveAttribute('title', 'High price risk range');
  expect(within(panel).queryByText('RR structure')).not.toBeInTheDocument();
});

test.each([
  ['stale', envelope => { envelope.stale = true; }],
  ['cache-only', envelope => { envelope.cacheOnly = true; }],
  ['mock', envelope => { envelope.bySymbol.GLD.decision.riskRange.mock = true; }],
  ['seeded', envelope => { envelope.bySymbol.GLD.decision.riskRange.seeded = true; }],
  ['offline', envelope => { envelope.connected = false; }],
  ['prior session', envelope => { envelope.bySymbol.GLD.decision.riskRange.sourceDate = priorDate(); }],
  ['supplemental source', envelope => { envelope.bySymbol.GLD.decision.riskRange.sourceId = 'early-look'; }],
  ['missing endpoint', envelope => { envelope.bySymbol.GLD.decision.riskRange.lrr = null; }],
  ['reversed endpoints', envelope => { envelope.bySymbol.GLD.decision.riskRange.lrr = 4000; }],
])('leaves LRR and HRR empty for %s published range inputs', async (_name, mutate) => {
  const envelope = currentEnvelope();
  mutate(envelope);
  MarketDataService.getSecurityIntelligence.mockResolvedValue(envelope);
  render(<PortfolioBreakdown portfolioData={{ ...portfolioData, holdings: [portfolioData.holdings[0]] }} />);
  fireEvent.click(screen.getByRole('button', { name: 'Show research intelligence for GLD' }));
  const panel = screen.getByLabelText('Research intelligence for GLD');
  await waitFor(() => expect(within(panel).getByLabelText(/Low price risk range$/)).toHaveTextContent('—'));
  expect(within(panel).getByLabelText(/High price risk range$/)).toHaveTextContent('—');
});

test('clears LRR and HRR when the research refresh fails', async () => {
  render(<PortfolioBreakdown portfolioData={{ ...portfolioData, holdings: [portfolioData.holdings[0]] }} />);
  fireEvent.click(screen.getByRole('button', { name: 'Show research intelligence for GLD' }));
  const panel = screen.getByLabelText('Research intelligence for GLD');
  await waitFor(() => expect(within(panel).getByLabelText(/Low price risk range$/)).toHaveTextContent('2,900'));
  MarketDataService.getSecurityIntelligence.mockRejectedValue(new Error('Provider disconnected'));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh portfolio and research' }));
  await waitFor(() => expect(within(panel).getByLabelText(/Low price risk range$/)).toHaveTextContent('—'));
  expect(within(panel).getByLabelText(/High price risk range$/)).toHaveTextContent('—');
});

test('shows the ATR operating band and a plain-text PM explanation', async () => {
  render(<PortfolioBreakdown portfolioData={{ ...portfolioData, holdings: [portfolioData.holdings[0]] }} />);
  const sizeButton = await screen.findByRole('button', { name: 'Verify GLD position size calculation' });
  await waitFor(() => expect(sizeButton).toHaveTextContent('3.0–5.5%'));
  expect(sizeButton).toHaveAttribute('title', 'Volatility-based operating range; click for method, inputs, and risk limits.');
  fireEvent.click(sizeButton);
  const dialog = screen.getByRole('dialog', { name: 'Position size calculation' });
  expect(dialog).toHaveTextContent('GLD: 3.0–5.5% of NLV');
  expect(dialog).toHaveTextContent(`Operating range based on completed daily bars through ${expectedSizingSession()}.`);
  expect(dialog).toHaveTextContent('Bigger daily moves mean a smaller position; steadier prices allow a larger one.');
  expect(dialog).toHaveTextContent('ATR % = 14-day ATR ÷ last close, floored at 1.25%. Stop distance = 2 × ATR %.');
  expect(dialog).toHaveTextContent('MIN = 0.125% ÷ stop distance; MAX = 0.25% ÷ stop distance.');
  expect(dialog).toHaveTextContent('there is no beta or asset-class adjustment');
  // 4.5 / 200 = 2.25%; 2 × 2.25% = 4.50%; 0.125 / 4.5% = 2.78 → 3.00; 0.25 / 4.5% = 5.56 → 5.50.
  expect(dialog).toHaveTextContent('ATR 4.50 ÷ close 200.00 = 2.25%.');
  expect(dialog).toHaveTextContent('Stop distance = 2 × 2.25% = 4.50%.');
  expect(dialog).toHaveTextContent('0.125% ÷ 4.50% rounds up to 3.00%; 0.25% ÷ 4.50% rounds down to 5.50%.');
  expect(dialog).toHaveTextContent('The reference stop is 4.50% from the entry price.');
  expect(dialog).not.toHaveTextContent('below the 1.25% floor');
  expect(dialog).toHaveTextContent('At 2% ATR the stop is 4% away and the band is 3.25–6.25%.');
  expect(dialog).toHaveTextContent('At 4% ATR the stop is 8% away and the band is 1.75–3.00%; at 8% it is 1.00–1.50%.');
  expect(dialog).toHaveTextContent('caps every band at 5%–10% in very quiet assets');
  expect(dialog).toHaveTextContent('Method: Position Sizing v2.0 (ATR). Source: Yahoo Finance chart API.');
  expect(dialog.querySelector('table, svg:not(button svg), .pcv2-verification-equation, .pcv2-verification-result')).not.toBeInTheDocument();
  expect(dialog).not.toHaveTextContent('β*');
  expect(dialog).not.toHaveTextContent('volatility = 18.00%');
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByRole('dialog', { name: 'Position size calculation' })).not.toBeInTheDocument();
});

test('explains the 1.25% ATR floor when it sets the band', async () => {
  // 2 / 200 = 1.00% < 1.25%: band stop = 2 × 1.25% = 2.50% → 5.00–10.00%; reference stop 2.00%.
  const payload = await MarketDataService.getSecurityRiskMetrics();
  MarketDataService.getSecurityRiskMetrics.mockClear();
  payload.rows.GLD.atr14.value = 2;
  MarketDataService.getSecurityRiskMetrics.mockResolvedValue(payload);
  render(<PortfolioBreakdown portfolioData={{ ...portfolioData, holdings: [portfolioData.holdings[0]] }} />);
  const sizeButton = await screen.findByRole('button', { name: 'Verify GLD position size calculation' });
  await waitFor(() => expect(sizeButton).toHaveTextContent('5.0–10.0%'));
  fireEvent.click(sizeButton);
  const dialog = screen.getByRole('dialog', { name: 'Position size calculation' });
  expect(dialog).toHaveTextContent('ATR 2.00 ÷ close 200.00 = 1.00%.');
  expect(dialog).toHaveTextContent('That is below the 1.25% floor, so the floor sets the band.');
  expect(dialog).toHaveTextContent('Stop distance = 2 × 1.25% = 2.50%.');
  expect(dialog).toHaveTextContent('0.125% ÷ 2.50% rounds up to 5.00%; 0.25% ÷ 2.50% rounds down to 10.00%.');
  expect(dialog).toHaveTextContent('The reference stop is 2.00% from the entry price.');
});

test('does not substitute beta when ATR provenance is missing', async () => {
  const payload = await MarketDataService.getSecurityRiskMetrics();
  MarketDataService.getSecurityRiskMetrics.mockClear();
  delete payload.rows.GLD.provenance;
  MarketDataService.getSecurityRiskMetrics.mockResolvedValue(payload);
  render(<PortfolioBreakdown portfolioData={{ ...portfolioData, holdings: [portfolioData.holdings[0]] }} />);
  await waitFor(() => expect(MarketDataService.getSecurityRiskMetrics).toHaveBeenCalledTimes(1));
  const sizeButton = screen.getByRole('button', { name: 'Verify GLD position size calculation' });
  await waitFor(() => expect(sizeButton).toHaveTextContent('—'));
  fireEvent.click(sizeButton);
  const dialog = screen.getByRole('dialog', { name: 'Position size calculation' });
  expect(dialog).toHaveTextContent('Size unavailable.');
  expect(dialog).toHaveTextContent('Daily history source needs verification');
  expect(dialog).not.toHaveTextContent('GLD math.');
});

test('does not substitute beta when ATR14 is unavailable', async () => {
  const payload = await MarketDataService.getSecurityRiskMetrics();
  MarketDataService.getSecurityRiskMetrics.mockClear();
  payload.rows.GLD.atr14 = { status: 'unavailable', value: null, source: 'Yahoo Finance chart API', observations: 9, asOf: null };
  MarketDataService.getSecurityRiskMetrics.mockResolvedValue(payload);
  render(<PortfolioBreakdown portfolioData={{ ...portfolioData, holdings: [portfolioData.holdings[0]] }} />);
  await waitFor(() => expect(MarketDataService.getSecurityRiskMetrics).toHaveBeenCalledTimes(1));
  const sizeButton = screen.getByRole('button', { name: 'Verify GLD position size calculation' });
  await waitFor(() => expect(sizeButton).toHaveTextContent('—'));
  fireEvent.click(sizeButton);
  const dialog = screen.getByRole('dialog', { name: 'Position size calculation' });
  expect(dialog).toHaveTextContent('Size unavailable.');
  expect(dialog).toHaveTextContent('ATR needs 14 completed sessions');
  expect(dialog).not.toHaveTextContent('GLD math.');
});

test.each([
  ['stale', payload => { payload._cache = { stale: true }; }],
  ['cache-only', payload => { payload.cacheOnly = true; }],
  ['mock', payload => { payload.rows.GLD.mock = true; }],
  ['seeded', payload => { payload.rows.GLD.atr14.seeded = true; }],
  ['offline', payload => { payload.rows.GLD.provenance.security.connected = false; }],
  ['mock close', payload => { payload.rows.GLD.referencePrice.mock = true; }],
])('keeps the Size cell empty for %s ATR inputs', async (_name, mutate) => {
  const payload = await MarketDataService.getSecurityRiskMetrics();
  MarketDataService.getSecurityRiskMetrics.mockClear();
  mutate(payload);
  MarketDataService.getSecurityRiskMetrics.mockResolvedValue(payload);
  render(<PortfolioBreakdown portfolioData={{ ...portfolioData, holdings: [portfolioData.holdings[0]] }} />);
  const sizeButton = screen.getByRole('button', { name: 'Verify GLD position size calculation' });
  await waitFor(() => expect(sizeButton).toHaveTextContent('—'));
  fireEvent.click(sizeButton);
  expect(screen.getByRole('dialog')).toHaveTextContent('Size unavailable.');
  expect(screen.getByRole('dialog')).not.toHaveTextContent('GLD math.');
});

test('clears the displayed band and an open explanation after refresh fails', async () => {
  render(<PortfolioBreakdown portfolioData={{ ...portfolioData, holdings: [portfolioData.holdings[0]] }} />);
  const sizeButton = screen.getByRole('button', { name: 'Verify GLD position size calculation' });
  await waitFor(() => expect(sizeButton).toHaveTextContent('3.0–5.5%'));
  fireEvent.click(sizeButton);
  expect(screen.getByRole('dialog')).toHaveTextContent('GLD math.');
  MarketDataService.getSecurityRiskMetrics.mockRejectedValue(new Error('Provider disconnected'));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh portfolio and research' }));
  await waitFor(() => expect(sizeButton).toHaveTextContent('—'));
  expect(screen.getByRole('dialog')).toHaveTextContent('Size unavailable.');
  expect(screen.getByRole('dialog')).not.toHaveTextContent('GLD math.');
  expect(screen.getByRole('dialog')).not.toHaveTextContent('GLD: 3.0–5.5%');
});

test('expires the Size cell and its open explanation without a new API response', async () => {
  jest.useFakeTimers();
  try {
    const payload = await MarketDataService.getSecurityRiskMetrics();
    payload.rows.GLD.provenance.security.fetchedAt = new Date(Date.now() - 3_590_000).toISOString();
    MarketDataService.getSecurityRiskMetrics.mockResolvedValue(payload);
    render(<PortfolioBreakdown portfolioData={{ ...portfolioData, holdings: [portfolioData.holdings[0]] }} />);
    const button = screen.getByRole('button', { name: 'Verify GLD position size calculation' });
    await waitFor(() => expect(button).toHaveTextContent('3.0–5.5%'));
    fireEvent.click(button);
    act(() => { jest.advanceTimersByTime(30_000); });
    expect(button).toHaveTextContent('—');
    expect(screen.getByRole('dialog')).toHaveTextContent('Size unavailable.');
    expect(screen.getByRole('dialog')).not.toHaveTextContent('GLD math.');
  } finally {
    jest.useRealTimers();
  }
});

test('requests exchange-session volatility for a crypto ETF', async () => {
  render(<PortfolioBreakdown portfolioData={{
    ...portfolioData, holdings: [{ ...portfolioData.holdings[0], symbol: 'IBIT', assetClass: 'Cryptocurrency' }],
  }} />);
  await waitFor(() => expect(MarketDataService.getSecurityRiskMetrics).toHaveBeenCalledWith(
    ['IBIT'], { assetTypes: { IBIT: 'equity' } },
  ));
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
  await waitFor(() => expect(within(panel).getAllByText('BULLISH').length).toBeGreaterThanOrEqual(2));

  MarketDataService.getSecurityIntelligence.mockRejectedValueOnce(new Error('research offline'));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh portfolio and research' }));

  await waitFor(() => expect(MarketDataService.getSecurityIntelligence).toHaveBeenCalledTimes(3));
  expect(MarketDataService.getSecurityIntelligence.mock.calls.map(([request]) => request.historyDays))
    .toEqual([0, 5, 0]);
  const decisionValues = within(panel).getByLabelText('GLD decision intelligence');
  const [, tradeCell, trendCell] = [...decisionValues.children];
  const signalCell = within(panel).getByText('ADDED').closest('.pcv2-intel-cell');
  await waitFor(() => (
    expectCellProvenance(tradeCell, /Last verified · Momo Tracker · .* · refresh failed/)
  ));
  [tradeCell, trendCell, signalCell].forEach((cell) => (
    expect(cell).toHaveClass('is-reference')
  ));
  expectCellProvenance(trendCell, /Last verified · Risk Ranges · .* · refresh failed/);
  expectCellProvenance(signalCell, /Last verified · Signal Strength · .* · refresh failed/);
  const coverageCell = within(panel).getByText('FULL').closest('.pcv2-intel-cell');
  expectCellProvenance(
    coverageCell,
    /Last verified · [A-Z][a-z]{2} \d{1,2} · refresh failed/,
  );
  expect(panel.querySelector('.pcv2-intel-meta')).not.toBeInTheDocument();
});

test.each([
  ['momo-tracker', 'Momo Tracker'],
  ['early-look', 'Early Look'],
  ['risk-ranges', 'Risk Ranges'],
])('shows explicitly non-executable lastVerifiedDecision fields from %s without promoting them to current', async (sourceId, sourceLabel) => {
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
      signalProvenance: publishedTradeProvenance('SELL'),
      sourceId,
      sourceLabel,
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
  await waitFor(() => expect(within(panel).getAllByText('BEARISH').length).toBeGreaterThanOrEqual(2));
  const decisionValues = within(panel).getByLabelText('GLD decision intelligence');
  const [, tradeCell, trendCell] = [...decisionValues.children];
  await waitFor(() => expect(within(panel).getByText('REMOVED')).toBeInTheDocument());
  const signalCell = within(panel).getByText('REMOVED').closest('.pcv2-intel-cell');
  [tradeCell, trendCell, signalCell].forEach((cell) => {
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
    products: currentEnvelope().products.map((product) => ({
      ...product,
      marketDate: today,
    })),
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
  const callRow = within(screen.getByLabelText('Research intelligence for GLD'))
    .getByText('The Call').closest('.pcv2-intel-reference-row');
  expect(within(callRow).getByText('N/A')).toBeInTheDocument();
  expect(within(callRow).queryByText('VIEW ›')).not.toBeInTheDocument();
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
  await waitFor(() => expect(within(panel).getByText('The Call')).toBeInTheDocument());
  const callRow = within(panel).getByText('The Call').closest('.pcv2-intel-reference-row');
  expect(within(callRow).getByText('UNAVAILABLE')).toBeInTheDocument();
  expect(within(panel).queryByText('BULLISH')).not.toBeInTheDocument();
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
  const priceCell = within(row).getByRole('cell', {
    name: 'Last close $200.00 from 2026-07-24',
  });
  expect(priceCell).toHaveTextContent('$200.00LAST CLOSE · Jul 24');
  expect(priceCell).toHaveAttribute('title', 'Last close · 2026-07-24 · reference only');
  expect(within(row).getByRole('cell', {
    name: 'Day gain/loss +1.01%',
  })).toHaveTextContent('+1.01%');
  expect(within(row).queryByText('$198.00')).not.toBeInTheDocument();
  expect(within(row).getByRole('cell', { name: 'Reference only' })).toHaveTextContent('Ref only');
  expect(within(row).queryByRole('textbox')).not.toBeInTheDocument();
  expect(within(row).queryByLabelText('EOD reference close')).not.toBeInTheDocument();
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
  expect(errorIcon).toHaveClass('pcv2-mark-status--error');
  expect(errorIcon).not.toHaveClass('pcv2-mark-status--reference');
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
  expect(errorIcon).toHaveClass('pcv2-mark-status--error');
  expect(errorIcon).not.toHaveClass('pcv2-mark-status--reference');
  expect(within(row).queryByLabelText('EOD reference close')).not.toBeInTheDocument();
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
  expect(loadingIcon).toHaveClass('pcv2-mark-status--loading');
  expect(loadingIcon).not.toHaveClass('pcv2-mark-status--error');
  expect(within(row).getByRole('cell', { name: 'Unavailable' })).toHaveTextContent('No live');
  expect(within(row).queryByRole('textbox')).not.toBeInTheDocument();
});

test('shows and explains OIH’s Energy quad order from the title even without price or research data', async () => {
  MarketDataService.getSecurityIntelligence.mockResolvedValue({ status: 'unavailable', securities: {} });
  MarketDataService.getSecurityRiskMetrics.mockResolvedValue({ status: 'unavailable', rows: {} });
  render(<PortfolioBreakdown portfolioData={{
    ...portfolioData,
    holdings: [{ ...portfolioData.holdings[0], symbol: 'OIH', conid: 415578515, price: null, priceState: 'unavailable' }],
  }} />);
  await waitFor(() => expect(MarketDataService.getSecurityIntelligence).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole('button', { name: 'Show research intelligence for OIH' }));
  const panel = screen.getByLabelText('Research intelligence for OIH');
  const order = within(panel).getByLabelText('Quad order 3 → 2 → 1 → 4');
  expect(order).toHaveTextContent('3›2›1›4');
  expect(order.closest('.pcv2-intel-cell')).toHaveAttribute('title', 'Energy · chart order');
  expect(within(order).queryByRole('button')).not.toBeInTheDocument();
  fireEvent.click(within(panel).getByRole('button', { name: 'Explain OIH quad ranking' }));
  const dialog = screen.getByRole('dialog', { name: 'Quad +EV ranking' });
  expect(dialog).toHaveTextContent('Equity Sectors → Energy');
  expect(dialog).toHaveTextContent('Quad 1: not listed; Quad 2: Best #4; Quad 3: Best #2; Quad 4: Worst #1');
  expect(dialog).toHaveTextContent('this fund does not hold physical oil');
  expect(within(dialog).getByRole('link', { name: 'vaneck.com' })).toHaveAttribute('href',
    'https://www.vaneck.com/us/en/investments/oil-services-etf-oih/overview/');
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

test.each([
  ['IBIT', 'Cryptocurrency'],
  ['DBMF', 'Managed Futures'],
])('labels %s as classified but not covered by the quad chart', async (symbol, factor) => {
  render(<PortfolioBreakdown portfolioData={{
    ...portfolioData,
    holdings: [{ ...portfolioData.holdings[0], symbol, conid: `quad-${symbol}` }],
  }} />);
  await waitFor(() => expect(MarketDataService.getSecurityIntelligence).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole('button', { name: `Show research intelligence for ${symbol}` }));
  const panel = screen.getByLabelText(`Research intelligence for ${symbol}`);
  expect(within(panel).getByText('Not covered')).toBeInTheDocument();
  expect(within(panel).queryByLabelText(/^Quad order/)).not.toBeInTheDocument();
  fireEvent.click(within(panel).getByRole('button', { name: `Explain ${symbol} quad ranking` }));
  expect(screen.getByRole('dialog', { name: 'Quad +EV ranking' }))
    .toHaveTextContent(`${factor} is not covered by the four-quad +EV chart.`);
});

test('uses economic asset classes for funds reported as equities by the broker', async () => {
  const expected = { YCL: 'FX', UGL: 'FX', ZROZ: 'FI', JOJO: 'FI', SRUUF: 'COM', DBMF: 'MF', OIH: 'EQ' };
  render(<PortfolioBreakdown portfolioData={{
    ...portfolioData,
    holdings: Object.keys(expected).map(symbol => ({
      ...portfolioData.holdings[0], symbol, conid: `class-${symbol}`, assetClass: 'Equities',
    })),
  }} />);
  await waitFor(() => expect(MarketDataService.getSecurityIntelligence).toHaveBeenCalledTimes(1));
  Object.entries(expected).forEach(([symbol, label]) => {
    expect(within(getLedgerRowBySymbol(symbol)).getAllByRole('cell')[1])
      .toHaveTextContent(label);
  });
});


test.each([['BULLISH', 'Buy', 'is-positive'], ['NEUTRAL', 'Wait', 'is-neutral']])('shows published %s Tick left of independent Trade with the original evidence date', async (direction, position, tone) => {
  useHedgaiTickResearch.mockReturnValue({ readings: { GLD: { verified: true, tick: direction, tickEvidence: {
    source: 'HedgAI Signals', sourceTicker: 'GLD', sourceLabel: 'Gold', position, matchType: 'exact',
    date: priorDate(), evidenceText: `Gold: ${position}`,
  } } } });
  render(<PortfolioBreakdown portfolioData={{ ...portfolioData, holdings: [portfolioData.holdings[0]] }} />);
  fireEvent.click(screen.getByRole('button', { name: 'Show research intelligence for GLD' }));
  const panel = screen.getByLabelText('Research intelligence for GLD');
  const values = within(panel).getByLabelText('GLD decision intelligence');
  const [tickCell, tradeCell] = values.children;
  expect(tickCell).toHaveTextContent(position === 'Wait' ? 'Wait' : direction);
  expect(tickCell).not.toHaveTextContent('NEUTRAL');
  expect(tickCell).toHaveAttribute('title', expect.stringContaining(position === 'Wait'
    ? 'Wait and Watch (no directional call)' : `Gold: ${position}`));
  expect(tickCell.firstElementChild).toHaveClass(tone);
  expectCellProvenance(tickCell, /HedgAI Signals/);
  expectCellProvenance(tickCell, new RegExp(`GLD.*Gold.*Gold: ${position}`));
  await waitFor(() => expect(tradeCell).toHaveTextContent('BULLISH'));
  expect(tradeCell).not.toHaveTextContent('HedgAI');
});
