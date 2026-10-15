import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import PortfolioDashboard, {
  analystNavigationState,
  mergeMarketDataPreservingPeriods,
} from '../PortfolioDashboard';
import { MarketDataService } from '../../../services/api/marketDataService';
import predictionMarketTestService from '../../../services/api/predictionMarketTestService';
import { loadSelectedAccount } from '../../../constants/ibkrAccountStorage';
import {
  getIbkrConnectionDisplay,
  getPreferredIbkrAccount,
} from '../../../utils/ibkrConnectionStatus';
import { resetSessionResourceStore } from '../../../utils/sessionResourceStore';
import { warmDashboardResource } from '../../../utils/dashboardResourceWarmup';
import { clearContractPerformanceHistory } from '../../../hooks/useContractPerformance';
import { installSplitPerformanceFixtureMocks } from '../../../hooks/__fixtures__/contractPerformanceFixtures';

jest.mock('../../../utils/dashboardResourceWarmup', () => ({
  warmDashboardResource: jest.fn().mockResolvedValue(null),
}));
jest.mock('../../../hooks/useMarketEvents', () => ({
  ...jest.requireActual('../../../hooks/useMarketEvents'),
  useMarketEvents: () => ({ availability: 'unavailable', data: null, refresh: jest.fn() }),
}));

test('consolidated navigation replaces TL;DR with one Analyst entry', () => {
  expect(analystNavigationState()).toEqual({
    systemsEntry: 'analyst',
    showLegacyTldr: false,
    showResearchAnalyst: false,
  });
  expect(analystNavigationState(false)).toEqual({
    systemsEntry: 'analyst',
    showLegacyTldr: false,
    showResearchAnalyst: false,
  });
});

test('current quote refreshes preserve calendar-based basis-point horizons', () => {
  const previous = {
    rates: {
      eu_sovereigns: [{
        symbol: 'BUND10Y',
        price: '2.97',
        fifteenDayChangeBps: -7.6,
        monthChangeBps: -7.6,
        threeMonthChangeBps: 6,
        latestObservationChange: { value: -2.51, interval: 'monthly', asOf: '2026-06-01T00:00:00Z' },
        backdropPercentageReturns: { monthChangePct: -2.51 },
        periodReturnsAsOf: '2026-06-01T00:00:00.000Z',
        periodReturnsStatus: 'historical',
      }],
    },
  };
  const current = {
    rates: {
      eu_sovereigns: [{
        symbol: 'BUND10Y',
        price: '2.98',
        dayChangeBps: null,
        fifteenDayChangeBps: null,
        monthChangeBps: null,
        threeMonthChangeBps: null,
        latestObservationChange: null,
        backdropPercentageReturns: null,
      }],
    },
  };

  expect(mergeMarketDataPreservingPeriods(previous, current).rates.eu_sovereigns[0])
    .toEqual(expect.objectContaining({
      price: '2.98',
      dayChangeBps: null,
      fifteenDayChangeBps: -7.6,
      monthChangeBps: -7.6,
      threeMonthChangeBps: 6,
      latestObservationChange: previous.rates.eu_sovereigns[0].latestObservationChange,
      backdropPercentageReturns: { monthChangePct: -2.51 },
      periodReturnsAsOf: '2026-06-01T00:00:00.000Z',
      periodReturnsStatus: 'historical',
    }));
  expect(mergeMarketDataPreservingPeriods(previous, current, { preservePeriods: false })
    .rates.eu_sovereigns[0].latestObservationChange).toBeNull();
});

test('a recovered current quote does not inherit retained flags from the period snapshot', () => {
  const previous = { us: [{ symbol: 'SPX', availability: 'reference', displayDelayed: true,
    displayOnly: true, executable: false, freshness: 'refresh-delayed', lastVerifiedAt: '2026-09-01',
    monthChangePct: 2, periodReturnsStatus: 'historical', periodReturnsAsOf: '2026-09-01' }] };
  const current = { us: [{ symbol: 'SPX', price: 7515.34, availability: 'current', source: 'ibkr',
    quoteAsOf: '2026-09-10T17:00:00Z' }] };
  const row = mergeMarketDataPreservingPeriods(previous, current).us[0];
  expect(row).toMatchObject({ ...current.us[0], monthChangePct: 2, periodReturnsAsOf: '2026-09-01' });
  expect(row).not.toHaveProperty('displayDelayed');
  expect(row).not.toHaveProperty('lastVerifiedAt');
  expect(row).not.toHaveProperty('freshness');
});

jest.mock('../../../services/api/marketDataService', () => ({
  MarketDataService: {
    getMultiRegionQuotes: jest.fn(),
    getPortfolio: jest.fn(),
    getPortfolioBalance: jest.fn(),
    previewPortfolioBalance: jest.fn(),
    getPortfolioAccounts: jest.fn(),
    getPortfolioExposureReconciliation: jest.fn(),
    getIbkrInterestValidationStatus: jest.fn(),
    getRealTimeAlertPositions: jest.fn(),
    getHedgeyeEtfPro: jest.fn(),
    getHedgeyeChangelog: jest.fn(),
    getHedgeyeSnapshot: jest.fn(),
    getProviderStatus: jest.fn(),
    getPredictionMarketPerformance: jest.fn(),
    getPredictionMarketPerformanceHistory: jest.fn(),
    getPredictionMarketPerformanceCurrent: jest.fn(),
    getPredictionMarketPerformanceExecutions: jest.fn(),
    getPredictionMarketSp500Research: jest.fn(),
  },
}));

jest.mock('../../../services/api/predictionMarketsIngestService', () => ({
  __esModule: true,
  default: { getProviderStatus: jest.fn().mockResolvedValue({}) },
}));

jest.mock('../../../services/api/predictionMarketTestService', () => ({
  __esModule: true,
  default: { getMorningReport: jest.fn() },
}));

jest.mock('../../../context/ThemeContext', () => ({
  useTheme: () => ({
    theme: 'light',
    toggleTheme: jest.fn(),
  }),
}));

jest.mock('../../../constants/ibkrAccountStorage', () => ({
  loadSelectedAccount: jest.fn(() => 'U25779973'),
  saveSelectedAccount: jest.fn(),
  saveIbkrAccounts: jest.fn(),
}));

jest.mock('../../../utils/ibkrConnectionStatus', () => ({
  getIbkrConnectionDisplay: jest.fn(() => 'Connected'),
  getPreferredIbkrAccount: jest.fn(() => 'U25779973'),
}));

jest.mock('../../../utils/dateFreshness', () => ({
  isFreshForToday: jest.fn(() => true),
}));

const mockUsdMacroDashboard = jest.fn();
const mockPortfolioBreakdown = jest.fn();
jest.mock('../USDMacroDashboard', () => (props) => {
  mockUsdMacroDashboard(props);
  return <div>USD Macro Dashboard</div>;
});
jest.mock('../WorkflowStatus', () => () => <div>Workflow Status</div>);
jest.mock('../SystemReadinessPanel', () => ({ onClose, onStatusChange }) => (
  <div>
    Systems Panel
    <button type="button" onClick={() => onStatusChange('attention')}>Report peripheral issue</button>
    <button type="button" onClick={onClose}>Close Systems</button>
  </div>
));
jest.mock('../PerformanceTracking', () => () => <div>Performance Tracking</div>);
jest.mock('../BitcoinResearch', () => ({ onClose }) => <div>
  Bitcoin historical entry study
  <button type="button" onClick={onClose}>Close Bitcoin Research</button>
</div>);
jest.mock('../PortfolioBreakdown', () => (props) => {
  mockPortfolioBreakdown(props);
  return <div>Portfolio Breakdown</div>;
});
const mockExposureLab = jest.fn();
jest.mock('../PcaRiskWorkspace', () => (props) => {
  mockExposureLab(props);
  return (
    <div>
      PCA Workspace
      <button type="button" onClick={props.onClose}>Close PCA</button>
    </div>
  );
});
const mockPredictionMonitor = jest.fn();
jest.mock('../PredictionMarketResolverTest', () => {
  const mockReact = jest.requireActual('react');
  const switchTargets = {
    bitcoin: { marketId: 'ethereum', label: 'Ethereum' },
    ethereum: { marketId: 'bitcoin', label: 'Bitcoin' },
    gold: { marketId: 'silver', label: 'Silver' },
    silver: { marketId: 'gold', label: 'Gold' },
  };
  return (props) => {
    mockPredictionMonitor(props);
    const [draft, setDraft] = mockReact.useState('');
    const switchTarget = switchTargets[props.marketId];
    return (
      <div>
        Prediction Monitor
        <div>Active monitor: {props.marketId}</div>
        <label>
          {props.marketId} monitor draft
          <input
            aria-label={`${props.marketId} monitor draft`}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
        </label>
        <button type="button" onClick={props.onClose}>Close Prediction Monitor</button>
        {switchTarget && (
          <button
            type="button"
            onClick={() => props.onMarketChange(switchTarget.marketId)}
          >
            Switch to {switchTarget.label}
          </button>
        )}
      </div>
    );
  };
});
jest.mock('../SignalStrengthPanel', () => ({ onClose }) => <div>SS Reference Panel<button onClick={onClose}>Close SS</button></div>);
const mockEtfProPanel = jest.fn();
jest.mock('../EtfProPanel', () => (props) => {
  mockEtfProPanel(props);
  return <div>ETF Pro Reference Panel<button onClick={props.onClose}>Close ETF Pro</button></div>;
});
jest.mock('../HedgeyeShowPanel', () => ({ title, onClose }) => <div>{title} Reference Panel<button onClick={onClose}>Close {title}</button></div>);
jest.mock('../MorningTldrOverlay', () => ({ onClose }) => (
  <div data-testid="mock-morning-tldr">
    Morning TL;DR
    <button type="button" onClick={onClose}>Close TL;DR</button>
  </div>
));
jest.mock('../AnalystPanel', () => ({ onClose }) => (
  <div data-testid="mock-analyst-panel">
    The Analyst workspace
    <button type="button" onClick={onClose}>Close The Analyst</button>
  </div>
));
jest.mock('react-markdown', () => () => <div>Markdown</div>);

const originalDocumentHidden = Object.getOwnPropertyDescriptor(document, 'hidden');

const VERIFIED_COMPARISON = {
  current: true,
  comparisonSafe: true,
  referenceOnly: false,
  dataAvailability: {
    structuralStatus: 'verified',
    canonicalSourceVerified: true,
    current: true,
    comparisonSafe: true,
    referenceOnly: false,
  },
};

const PREDICTION_MARKET_IDS = ['sp500', 'wti', 'nasdaq100', 'gold'];
const PREDICTION_MARKET_TICKERS = {
  sp500: { riskRange: 'SPX', trade: 'SPX' },
  wti: { riskRange: 'WTIC', trade: 'USO' },
  nasdaq100: { riskRange: 'COMPQ', trade: 'COMPQ' },
  gold: { riskRange: 'GLD', trade: 'GLD' },
};

function unavailableMorningReport() {
  return {
    schemaVersion: 1,
    reportType: 'four_market_morning',
    generatedAt: new Date().toISOString(),
    status: 'unavailable',
    marketOrder: [...PREDICTION_MARKET_IDS],
    markets: PREDICTION_MARKET_IDS.map((marketId) => ({ marketId })),
    policy: { recommendationAllowed: false },
  };
}

function alignedMorningMarket(marketId, signal, price, {
  fit = 'calibration',
  setupEligible = true,
} = {}) {
  const now = Date.now();
  const asOf = new Date(now - 1_000).toISOString();
  const expiresAt = new Date(now + 60_000).toISOString();
  const date = new Date(now).toISOString().slice(0, 10);
  const bullish = signal === 'BULLISH';
  return {
    marketId,
    riskRange: {
      status: 'available', lrr: 100, hrr: 130, trend: signal, date,
      ticker: PREDICTION_MARKET_TICKERS[marketId].riskRange, fit, setupEligible,
      source: 'risk_ranges', asOf, expiresAt, reason: null,
    },
    trade: {
      status: 'available', direction: signal, date,
      ticker: PREDICTION_MARKET_TICKERS[marketId].trade,
      source: 'momo-tracker', asOf, expiresAt, reason: null,
    },
    reference: {
      status: 'available', availability: 'live', fit: 'exact', value: price,
      source: 'ibkr_live', asOf, expiresAt, reason: null,
    },
    bias: { status: 'aligned', trade: signal, trend: signal, aligned: true },
    rangeLocation: { status: 'available', zone: bullish ? 'LRR' : 'HRR', value: price },
    setup: {
      status: 'matched', pattern: bullish ? 'BULLISH_AT_LRR' : 'BEARISH_AT_HRR',
      tradeTrendAligned: true, researchQualified: true, rankEligible: false,
      recommendationAllowed: false,
    },
  };
}

function alignedMorningReport() {
  const report = unavailableMorningReport();
  const markets = {
    sp500: alignedMorningMarket('sp500', 'BULLISH', 101),
    wti: alignedMorningMarket('wti', 'BEARISH', 129),
    nasdaq100: alignedMorningMarket('nasdaq100', 'BULLISH', 101, {
      fit: 'related_only', setupEligible: false,
    }),
    gold: { marketId: 'gold' },
  };
  return { ...report, markets: PREDICTION_MARKET_IDS.map((marketId) => markets[marketId]) };
}

function livePortfolioBalance(accountId = 'U25779973') {
  const observedAt = new Date().toISOString();
  return {
    available: true,
    status: 'live',
    source: 'ibkr_live_session',
    accountId,
    snapshotId: 'dashboard-balance-1',
    observedAt,
    socketVerifiedAt: observedAt,
    accountValuesObservedAt: observedAt,
    fromCache: false,
    currency: 'USD',
    exposure: {
      netLiquidation: 200000,
      longMarketValue: 120000,
      shortMarketValue: 40000,
      grossMarketValue: 160000,
      netMarketValue: 80000,
      longPercent: 60,
      shortPercent: 20,
      grossPercent: 80,
      netPercent: 40,
    },
    activity: { openOrderCount: 0, sameDayExecutionCount: 0 },
    margin: {
      available: true,
      status: 'live',
      source: 'ibkr_live_session',
      health: 'healthy',
      availableFunds: 110000,
      excessLiquidity: 115000,
      buyingPower: 380000,
      initialDeficit: 0,
      maintenanceDeficit: 0,
    },
    settlement: { state: 'settled', pending: false },
    cash: { securitiesCashFloor: 50000, shortCollateral: 40000 },
    buffer: { totalReserve: 5000 },
    interestExposure: {
      available: true,
      status: 'live',
      source: 'ibkr_live_session',
      actionable: false,
      current: { estimatedDebitPrincipal: 0 },
      projected: { effectiveDate: '2026-08-31', securitiesCash: 50000, shortCollateral: 40000, estimatedDebitPrincipal: 0 },
      policy: { totalReserve: 5000, estimatedDebitPrincipalAfterReserve: 0 },
    },
    capacity: { available: true, status: 'live' },
  };
}

function seedDashboardApis() {
  const observedAt = new Date().toISOString();
  MarketDataService.getMultiRegionQuotes.mockResolvedValue({
    currencies: [],
    sectors: [],
    commodities: [],
    rates: [],
    crypto: [],
    global: [],
  });
  MarketDataService.getPortfolio.mockResolvedValue({
    accountId: 'U25779973',
    accountSummary: { netLiquidation: 100000, totalCashValue: 5000, currency: 'USD' },
    summary: { totalValue: 100000 },
    holdings: [],
    dataSource: 'ibkr_api',
    liveSessionVerified: true,
    fetchedAt: observedAt,
    socketVerifiedAt: observedAt,
    fromCache: false,
  });
  MarketDataService.getPortfolioBalance.mockRejectedValue({
    response: {
      data: {
        errorCode: 'GATEWAY_UNAVAILABLE',
        message: 'Live balance unavailable in dashboard test.',
      },
    },
  });
  MarketDataService.getPortfolioAccounts.mockResolvedValue([]);
  MarketDataService.getPortfolioExposureReconciliation.mockResolvedValue({ status: 'unavailable' });
  MarketDataService.getIbkrInterestValidationStatus.mockResolvedValue({
    status: 'unavailable',
    source: 'ibkr_interest_validation',
    available: false,
    guard: { available: false, appliedReserve: null },
  });
  MarketDataService.getRealTimeAlertPositions.mockResolvedValue({
    available: false,
    longCount: null,
    shortCount: null,
    dataQuality: { status: 'ok' },
  });
  MarketDataService.getHedgeyeEtfPro.mockResolvedValue({
    available: false,
    rows: [],
    longCount: null,
    shortCount: null,
    dataQuality: { status: 'ok' },
  });
  MarketDataService.getHedgeyeChangelog.mockResolvedValue(null);
  MarketDataService.getHedgeyeSnapshot.mockResolvedValue(null);
  MarketDataService.getProviderStatus.mockResolvedValue({});
  MarketDataService.getPredictionMarketPerformance.mockResolvedValue({
    rows: [],
    review: [],
    summary: {
      count: 0,
      openCount: 0,
      openPnl: 0,
      realizedCount: 0,
      realizedPnl: 0,
    },
    tracker: { status: 'ready', health: 'capturing' },
    availableAccounts: [],
    accountCoverage: null,
  });
  MarketDataService.getPredictionMarketPerformanceExecutions.mockResolvedValue({
    executions: [],
  });
  MarketDataService.getPredictionMarketSp500Research.mockResolvedValue({
    rows: [],
  });
  predictionMarketTestService.getMorningReport.mockImplementation(async () => (
    unavailableMorningReport()
  ));
}

function openPredictionMarketsMenu(navigation = screen.getByTestId('dashboard-top-navigation')) {
  const trigger = within(navigation).getByRole('button', { name: 'Prediction Markets', exact: true });
  if (trigger.getAttribute('aria-expanded') !== 'true') fireEvent.click(trigger);
  return screen.getByRole('menu', { name: 'Prediction Markets' });
}

function getPredictionMarketItem(navigation, label) {
  return within(openPredictionMarketsMenu(navigation)).getByRole('menuitemcheckbox', { name: label });
}

function openPerpetualFuturesMenu(navigation = screen.getByTestId('dashboard-top-navigation')) {
  const trigger = within(navigation).getByRole('button', { name: 'Perpetual Futures', exact: true });
  if (trigger.getAttribute('aria-expanded') !== 'true') fireEvent.click(trigger);
  return screen.getByRole('menu', { name: 'Perpetual Futures' });
}

function getPerpetualFuturesItem(navigation, label) {
  return within(openPerpetualFuturesMenu(navigation)).getByRole('menuitemcheckbox', { name: label });
}

function getDockItem(navigation = screen.getByTestId('dashboard-top-navigation'), label) {
  const research = ['X.com', 'Process', 'Dashboard Guide', 'PCA Guide', 'Bitcoin Research'];
  const portfolio = ['Portfolio', 'PCA', 'Balance', 'Contract P&L'];
  const group = research.includes(label) ? 'Research' : portfolio.includes(label) ? 'Portfolio' : null;
  if (!group) return within(navigation).getByRole('button', { name: label, exact: true });
  const trigger = within(navigation).getByRole('button', { name: group, exact: true });
  if (trigger.getAttribute('aria-expanded') !== 'true') fireEvent.click(trigger);
  return within(screen.getByRole('menu', { name: group }))
    .getByRole(group === 'Research' ? 'menuitem' : 'menuitemcheckbox', { name: label, exact: true });
}

function expectCenteredWorkspaceWindow(panel) {
  expect(panel).toHaveClass('dashboard-workspace-window');
  expect(panel).toHaveAttribute('role', 'dialog');
  expect(panel).not.toHaveClass('dashboard-navigation-rail__balance-panel--workspace-left');
  expect(panel).not.toHaveClass('dashboard-navigation-rail__balance-panel--portfolio-left');
  for (const property of ['top', 'right', 'bottom', 'left', 'transform', 'borderRadius']) {
    expect(panel.style[property]).toBe('');
  }
}

describe('PortfolioDashboard workspace navigation', () => {
  test('opens Bitcoin Research from Research in the shared persistent workspace', async () => {
    render(<PortfolioDashboard />);
    fireEvent.click(getDockItem(undefined, 'Bitcoin Research'));
    expect(await screen.findByText('Bitcoin historical entry study')).toBeVisible();
    const panel = screen.getByTestId('bitcoin-research-panel');
    expectCenteredWorkspaceWindow(panel);
    expect(screen.getByRole('button', { name: 'Research', exact: true })).toHaveTextContent(/^Research$/);
    expect(screen.getByTestId('dashboard-panel-backdrop')).toBeVisible();
    await waitFor(() => expect(JSON.parse(window.localStorage.getItem('marketDashboard.panelState.v1')).showBitcoinResearch).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'Close Bitcoin Research' }));
    expect(panel).not.toBeVisible();
  });
  beforeEach(() => {
    resetSessionResourceStore();
    clearContractPerformanceHistory();
    installSplitPerformanceFixtureMocks(MarketDataService);
    loadSelectedAccount.mockReturnValue('U25779973');
    getIbkrConnectionDisplay.mockReturnValue({ connected: true, kind: 'connected' });
    getPreferredIbkrAccount.mockImplementation((_status, explicit) => (
      explicit || 'U25779973'
    ));
    seedDashboardApis();
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  afterEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
    window.localStorage.clear();
    window.sessionStorage.clear();
    if (originalDocumentHidden) {
      Object.defineProperty(document, 'hidden', originalDocumentHidden);
    } else {
      delete document.hidden;
    }
  });

  test('opens GDP and CPI from the prediction menu as separate persistent monitors', async () => {
    render(<PortfolioDashboard />);
    const navigation = await screen.findByTestId('dashboard-top-navigation');
    const menu = openPredictionMarketsMenu(navigation);
    expect(within(menu).getAllByRole('menuitemcheckbox').map((item) => item.getAttribute('aria-label')))
      .toEqual(['WTI', 'Brent', 'SP500', 'CPI', 'GDP']);
    fireEvent.click(getPredictionMarketItem(navigation, 'GDP'));
    expect(await screen.findByText('Active monitor: gdp')).toBeVisible();
    expect(within(navigation).getByRole('button', { name: 'Prediction Markets', exact: true }))
      .toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(getPredictionMarketItem(navigation, 'CPI'));
    expect(await screen.findByText('Active monitor: cpi')).toBeVisible();
    expect(screen.getByTestId('prediction-market-surface-gdp')).not.toBeVisible();
  });

  test('opens the existing Gold and Silver monitors from Perpetual Futures and retains each page state', async () => {
    render(<PortfolioDashboard />);
    const navigation = await screen.findByTestId('dashboard-top-navigation');
    const perpetualToggle = within(navigation).getByRole('button', { name: 'Perpetual Futures', exact: true });
    const predictionToggle = within(navigation).getByRole('button', { name: 'Prediction Markets', exact: true });

    fireEvent.click(getPerpetualFuturesItem(navigation, 'Gold'));
    expect(await screen.findByText('Active monitor: gold')).toBeVisible();
    expect(mockPredictionMonitor).toHaveBeenCalledWith(expect.objectContaining({
      marketId: 'gold', selectedAccount: 'U25779973',
    }));
    expect(screen.getByTestId('prediction-market-surface-gold')).toBeVisible();
    expect(perpetualToggle).toHaveAttribute('aria-pressed', 'true');
    expect(predictionToggle).toHaveAttribute('aria-pressed', 'false');
    fireEvent.change(screen.getByLabelText('gold monitor draft'), { target: { value: 'retain Gold page state' } });

    fireEvent.click(getPerpetualFuturesItem(navigation, 'Silver'));
    expect(await screen.findByText('Active monitor: silver')).toBeVisible();
    expect(mockPredictionMonitor).toHaveBeenCalledWith(expect.objectContaining({
      marketId: 'silver', selectedAccount: 'U25779973',
    }));
    expect(screen.getByTestId('prediction-market-surface-gold')).not.toBeVisible();
    expect(screen.getByTestId('prediction-market-surface-silver')).toBeVisible();
    expect(getPerpetualFuturesItem(navigation, 'Silver')).toHaveAttribute('aria-checked', 'true');
    expect(getPerpetualFuturesItem(navigation, 'Gold')).toHaveAttribute('aria-checked', 'false');
    fireEvent.change(screen.getByLabelText('silver monitor draft'), { target: { value: 'retain Silver page state' } });

    fireEvent.click(getPerpetualFuturesItem(navigation, 'Gold'));
    expect(screen.getByDisplayValue('retain Gold page state')).toBeVisible();
    expect(screen.getByDisplayValue('retain Silver page state')).not.toBeVisible();
    expect(screen.getAllByText('Prediction Monitor')).toHaveLength(2);
    expect(perpetualToggle).toHaveTextContent(/^Perpetual Futures$/);
    expect(predictionToggle).toHaveTextContent(/^Prediction Markets$/);
  });

  test('opens BTC and ETH from Perpetual Futures and retains their separate card state', async () => {
    render(<PortfolioDashboard />);
    const navigation = await screen.findByTestId('dashboard-top-navigation');
    const perpetualToggle = within(navigation).getByRole('button', { name: 'Perpetual Futures', exact: true });
    const predictionToggle = within(navigation).getByRole('button', { name: 'Prediction Markets', exact: true });

    for (const [label, marketId] of [['BTC', 'bitcoin'], ['ETH', 'ethereum']]) {
      fireEvent.click(getPerpetualFuturesItem(navigation, label));
      expect(await screen.findByText(`Active monitor: ${marketId}`)).toBeVisible();
      expect(mockPredictionMonitor).toHaveBeenCalledWith(expect.objectContaining({
        marketId, selectedAccount: 'U25779973',
      }));
      expect(perpetualToggle).toHaveAttribute('aria-pressed', 'true');
      expect(predictionToggle).toHaveAttribute('aria-pressed', 'false');
      fireEvent.change(screen.getByLabelText(`${marketId} monitor draft`), {
        target: { value: `${label} saved card state` },
      });
    }

    expect(getPerpetualFuturesItem(navigation, 'ETH')).toHaveAttribute('aria-checked', 'true');
    expect(getPerpetualFuturesItem(navigation, 'BTC')).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByTestId('prediction-market-surface-bitcoin')).not.toBeVisible();
    expect(screen.getByTestId('prediction-market-surface-ethereum')).toBeVisible();
    fireEvent.click(getPerpetualFuturesItem(navigation, 'BTC'));
    expect(screen.getByDisplayValue('BTC saved card state')).toBeVisible();
    expect(screen.getByDisplayValue('ETH saved card state')).not.toBeVisible();
    fireEvent.click(getPerpetualFuturesItem(navigation, 'ETH'));
    expect(screen.getByDisplayValue('ETH saved card state')).toBeVisible();
    expect(perpetualToggle).toHaveTextContent(/^Perpetual Futures$/);

    fireEvent.click(perpetualToggle);
    expect(screen.getByRole('menu', { name: 'Perpetual Futures' })).toBeVisible();
    expect(screen.getByTestId('prediction-market-surface-ethereum')).toBeVisible();
    expect(perpetualToggle).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(getPerpetualFuturesItem(navigation, 'ETH'));
    expect(screen.getByTestId('prediction-market-surface-ethereum')).not.toBeVisible();
    expect(perpetualToggle).toHaveAttribute('aria-pressed', 'false');
  });

  test.each([
    ['BTC', 'ETH', 'bitcoin', 'ethereum', 'Bitcoin', 'Ethereum'],
    ['Gold', 'Silver', 'gold', 'silver', 'Gold', 'Silver'],
  ])('switches between %s and %s from their cards while preserving each page', async (
    firstLabel, secondLabel, firstMarketId, secondMarketId, firstButtonLabel, secondButtonLabel,
  ) => {
    render(<PortfolioDashboard />);
    const navigation = await screen.findByTestId('dashboard-top-navigation');
    fireEvent.click(getPerpetualFuturesItem(navigation, firstLabel));
    expect(await screen.findByText(`Active monitor: ${firstMarketId}`)).toBeVisible();
    fireEvent.change(screen.getByLabelText(`${firstMarketId} monitor draft`), {
      target: { value: `${firstLabel} chart selection` },
    });

    fireEvent.click(screen.getByRole('button', { name: `Switch to ${secondButtonLabel}` }));
    expect(await screen.findByText(`Active monitor: ${secondMarketId}`)).toBeVisible();
    expect(screen.getByDisplayValue(`${firstLabel} chart selection`)).not.toBeVisible();
    fireEvent.change(screen.getByLabelText(`${secondMarketId} monitor draft`), {
      target: { value: `${secondLabel} chart selection` },
    });

    fireEvent.click(screen.getByRole('button', { name: `Switch to ${firstButtonLabel}` }));
    expect(screen.getByDisplayValue(`${firstLabel} chart selection`)).toBeVisible();
    expect(screen.getByDisplayValue(`${secondLabel} chart selection`)).not.toBeVisible();
    expect(within(navigation).getByRole('button', { name: 'Perpetual Futures', exact: true })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('prediction-market-resolver-test-panel')).toBeVisible();
  });

  test('pauses provider, account, and reference polls while hidden and refreshes once when visible', async () => {
    jest.useFakeTimers();
    window.localStorage.setItem('marketDashboard.panelState.v1', JSON.stringify({
      showEtfPro: true,
      showSignalStrength: true,
    }));
    let hidden = false;
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => hidden,
    });

    render(<PortfolioDashboard />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      jest.advanceTimersByTime(1300);
      await Promise.resolve();
    });

    MarketDataService.getPortfolio.mockClear();
    MarketDataService.getProviderStatus.mockClear();
    MarketDataService.getMultiRegionQuotes.mockClear();
    MarketDataService.getHedgeyeEtfPro.mockClear();
    MarketDataService.getHedgeyeChangelog.mockClear();

    hidden = true;
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      jest.advanceTimersByTime(5 * 60 * 1000);
      await Promise.resolve();
    });

    expect(MarketDataService.getPortfolio).not.toHaveBeenCalled();
    expect(MarketDataService.getProviderStatus).not.toHaveBeenCalled();
    expect(MarketDataService.getMultiRegionQuotes).not.toHaveBeenCalled();
    expect(MarketDataService.getHedgeyeEtfPro).not.toHaveBeenCalled();
    expect(MarketDataService.getHedgeyeChangelog).not.toHaveBeenCalled();

    hidden = false;
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(MarketDataService.getHedgeyeEtfPro).toHaveBeenCalledTimes(1);
    expect(MarketDataService.getHedgeyeChangelog).toHaveBeenCalledTimes(1);
    expect(MarketDataService.getProviderStatus).toHaveBeenCalledTimes(1);
    expect(MarketDataService.getPortfolio).toHaveBeenCalledTimes(1);
    expect(MarketDataService.getMultiRegionQuotes).toHaveBeenCalledTimes(2);
    expect(MarketDataService.getMultiRegionQuotes).toHaveBeenCalledWith(null, true, false);
    expect(MarketDataService.getMultiRegionQuotes).toHaveBeenCalledWith(null, false, true);

    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await Promise.resolve();
    });
    expect(MarketDataService.getHedgeyeEtfPro).toHaveBeenCalledTimes(1);

    await act(async () => {
      jest.advanceTimersByTime(5 * 60 * 1000);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(MarketDataService.getHedgeyeEtfPro).toHaveBeenCalledTimes(2);
    expect(MarketDataService.getHedgeyeChangelog).toHaveBeenCalledTimes(2);
  });

  test('warms only the intended monitor after startup, including keyboard intent', async () => {
    jest.useFakeTimers();
    render(<PortfolioDashboard />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      jest.advanceTimersByTime(20_000);
      await Promise.resolve();
    });
    expect(warmDashboardResource).not.toHaveBeenCalled();

    fireEvent.focus(getPerpetualFuturesItem(screen.getByTestId('dashboard-top-navigation'), 'Gold'));
    await act(async () => {
      jest.advanceTimersByTime(2000);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(warmDashboardResource).toHaveBeenCalledTimes(1);
    expect(warmDashboardResource).toHaveBeenCalledWith(
      'prediction-monitor',
      expect.objectContaining({ marketId: 'gold', venue: 'kalshi' }),
      expect.objectContaining({ fetcher: expect.any(Function) }),
    );
    fireEvent.pointerEnter(getPerpetualFuturesItem(screen.getByTestId('dashboard-top-navigation'), 'Gold'));
    await act(async () => {
      jest.advanceTimersByTime(2000);
      await Promise.resolve();
    });
    expect(warmDashboardResource).toHaveBeenCalledTimes(1);
  });

  test('passes the complete provider snapshot to the macro dashboard', async () => {
    const status = {
      ibkr: { connected: true, status: 'connected', lastQuoteAt: '2026-07-13T20:00:00.000Z' },
      yahoo: { available: true },
    };
    MarketDataService.getProviderStatus.mockResolvedValue(status);

    render(<PortfolioDashboard />);

    await waitFor(() => expect(mockUsdMacroDashboard).toHaveBeenCalledWith(
      expect.objectContaining({ providerStatus: status })
    ));
  });

  test('hydrates the last verified market numbers while replacement reads are in flight', async () => {
    jest.useFakeTimers();
    const quoteAsOf = new Date().toISOString();
    const currentPayload = {
      us: [{
        symbol: 'SPX',
        price: '7515.34',
        changePercent: 0.25,
        availability: 'delayed',
        source: 'yahoo',
        dataType: 'delayed',
        freshness: 'current',
        quoteAsOf,
        periodReturnsStatus: 'unavailable',
      }],
      currencies: [],
    };
    const periodPayload = {
      us: [{
        ...currentPayload.us[0],
        fifteenDayChangePct: -0.82,
        monthChangePct: 3.51,
        threeMonthChangePct: 2.05,
        sixMonthChangePct: 11.36,
        ytdChangePct: 11.88,
        oneYearChangePct: 19.16,
        periodReturnsStatus: 'historical',
        periodReturnsAsOf: quoteAsOf,
      }],
      currencies: [],
    };
    MarketDataService.getMultiRegionQuotes
      .mockResolvedValueOnce(currentPayload)
      .mockResolvedValueOnce(periodPayload);

    const { unmount: unmountFirst } = render(<PortfolioDashboard />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      jest.advanceTimersByTime(1600);
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => expect(mockUsdMacroDashboard).toHaveBeenLastCalledWith(
      expect.objectContaining({
        multiRegionMarketData: expect.objectContaining({
          us: [expect.objectContaining({
            symbol: 'SPX',
            price: '7515.34',
            fifteenDayChangePct: -0.82,
            oneYearChangePct: 19.16,
          })],
        }),
      }),
    ));
    expect(window.sessionStorage.getItem('market-dashboard.reference.multi-region-quotes.v1'))
      .not.toBeNull();
    expect(window.sessionStorage.getItem('market-dashboard.reference.multi-region-period-returns.v1'))
      .not.toBeNull();

    unmountFirst();
    resetSessionResourceStore();
    mockUsdMacroDashboard.mockClear();
    let resolveReplacement;
    MarketDataService.getMultiRegionQuotes.mockImplementationOnce(() => (
      new Promise((resolve) => { resolveReplacement = resolve; })
    ));

    const { unmount: unmountSecond } = render(<PortfolioDashboard />);
    expect(mockUsdMacroDashboard).toHaveBeenLastCalledWith(
      expect.objectContaining({
        multiRegionMarketData: expect.objectContaining({
          us: [expect.objectContaining({
            symbol: 'SPX',
            price: '7515.34',
            fifteenDayChangePct: -0.82,
            oneYearChangePct: 19.16,
            availability: 'reference',
            displayDelayed: true,
            executable: false,
            lastVerifiedAt: quoteAsOf,
          })],
        }),
      }),
    );

    await act(async () => {
      await Promise.resolve();
      resolveReplacement(currentPayload);
      await Promise.resolve();
    });
    unmountSecond();
  });

  test('starts portfolio and an opened ETF Pro surface without waiting for provider status', async () => {
    let resolveProviderStatus;
    window.localStorage.setItem('marketDashboard.panelState.v1', JSON.stringify({
      showEtfPro: true,
    }));
    MarketDataService.getProviderStatus.mockImplementationOnce(() => (
      new Promise((resolve) => {
        resolveProviderStatus = resolve;
      })
    ));

    render(<PortfolioDashboard />);

    await waitFor(() => expect(MarketDataService.getPortfolio).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(MarketDataService.getHedgeyeEtfPro).toHaveBeenCalledTimes(1));

    await act(async () => {
      resolveProviderStatus({});
      await Promise.resolve();
    });
  });

  test('clears the verified portfolio panel after a transient refresh failure', async () => {
    window.localStorage.setItem('marketDashboard.panelState.v1', JSON.stringify({
      showPortfolioBreakdown: true,
    }));
    const livePortfolio = {
      accountId: 'U25779973',
      accountSummary: { netLiquidation: 100000, totalCashValue: 5000, currency: 'USD' },
      summary: { totalValue: 100000 },
      holdings: [{ symbol: 'SPY', quantity: 10, marketValue: 7000, price: 700 }],
      dataSource: 'ibkr_api',
      liveSessionVerified: true,
      fetchedAt: new Date().toISOString(),
      socketVerifiedAt: new Date().toISOString(),
      fromCache: false,
    };
    let rejectRefresh;
    MarketDataService.getPortfolio
      .mockResolvedValueOnce(livePortfolio)
      .mockImplementationOnce(() => new Promise((_resolve, reject) => {
        rejectRefresh = reject;
      }));

    render(<PortfolioDashboard />);
    await waitFor(() => expect(mockPortfolioBreakdown).toHaveBeenLastCalledWith(
      expect.objectContaining({
        portfolioData: livePortfolio,
        isLoading: false,
      })
    ));

    act(() => {
      window.dispatchEvent(new Event('portfolioRefresh'));
    });
    await waitFor(() => expect(mockPortfolioBreakdown).toHaveBeenLastCalledWith(
      expect.objectContaining({
        portfolioData: livePortfolio,
        isRefreshing: true,
      })
    ));

    await act(async () => {
      rejectRefresh(new Error('IBKR refresh failed'));
      await Promise.resolve();
    });

    await waitFor(() => expect(mockPortfolioBreakdown).toHaveBeenLastCalledWith(
      expect.objectContaining({
        portfolioData: null,
        isRefreshing: false,
      })
    ));
  });

  test('clears the prior verified portfolio panel when refresh reports IBKR offline', async () => {
    window.localStorage.setItem('marketDashboard.panelState.v1', JSON.stringify({
      showPortfolioBreakdown: true,
    }));
    const livePortfolio = {
      accountId: 'U25779973',
      accountSummary: { netLiquidation: 100000, totalCashValue: 5000, currency: 'USD' },
      summary: { totalValue: 100000 },
      holdings: [{ symbol: 'SPY', quantity: 10, marketValue: 7000, price: 700 }],
      dataSource: 'ibkr_api',
      liveSessionVerified: true,
      fetchedAt: new Date().toISOString(),
      socketVerifiedAt: new Date().toISOString(),
      fromCache: false,
    };
    const offlinePortfolio = {
      dataSource: 'ibkr_offline',
      liveSessionVerified: false,
      holdings: [],
      accountSummary: null,
      summary: { totalValue: 0 },
      empty: true,
    };
    MarketDataService.getPortfolio
      .mockResolvedValueOnce(livePortfolio)
      .mockResolvedValue(offlinePortfolio);

    render(<PortfolioDashboard />);
    await waitFor(() => expect(mockPortfolioBreakdown).toHaveBeenLastCalledWith(
      expect.objectContaining({ portfolioData: livePortfolio })
    ));

    act(() => {
      window.dispatchEvent(new Event('portfolioRefresh'));
    });

    await waitFor(() => expect(mockPortfolioBreakdown).toHaveBeenLastCalledWith(
      expect.objectContaining({
        portfolioData: null,
        isRefreshing: false,
      })
    ));
  });

  test('deduplicates a background refresh while the initial portfolio read is in flight', async () => {
    let resolveInitialPortfolio;
    const livePortfolio = {
      accountId: 'U25779973',
      accountSummary: { netLiquidation: 100000, totalCashValue: 5000, currency: 'USD' },
      summary: { totalValue: 100000 },
      holdings: [{ symbol: 'SPY', quantity: 10, marketValue: 7000, price: 700 }],
      dataSource: 'ibkr_api',
      liveSessionVerified: true,
      fetchedAt: new Date().toISOString(),
      socketVerifiedAt: new Date().toISOString(),
      fromCache: false,
    };
    MarketDataService.getPortfolio
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveInitialPortfolio = resolve;
      }));
    window.localStorage.setItem('marketDashboard.panelState.v1', JSON.stringify({
      showPortfolioBreakdown: true,
    }));

    render(<PortfolioDashboard />);
    await waitFor(() => expect(MarketDataService.getPortfolio).toHaveBeenCalledTimes(1));

    act(() => {
      window.dispatchEvent(new Event('portfolioRefresh'));
    });
    expect(MarketDataService.getPortfolio).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveInitialPortfolio(livePortfolio);
      await Promise.resolve();
    });

    await waitFor(() => expect(mockPortfolioBreakdown).toHaveBeenLastCalledWith(
      expect.objectContaining({
        portfolioData: livePortfolio,
        isLoading: false,
      })
    ));

  });

  test('marks ETF Pro reference data unavailable after refresh failures while retaining dated rows', async () => {
    window.localStorage.setItem('marketDashboard.panelState.v1', JSON.stringify({
      showEtfPro: true,
    }));
    const etfRows = [
      { ticker: 'GLD', call: 'Long' },
      { ticker: 'SQQQ', call: 'Short' },
    ];
    MarketDataService.getRealTimeAlertPositions
      .mockResolvedValueOnce({
        ...VERIFIED_COMPARISON,
        available: true,
        longCount: 3,
        shortCount: 2,
        dataQuality: { status: 'ok', warnings: [] },
      })
      .mockRejectedValueOnce(new Error('RTA refresh offline'));
    MarketDataService.getHedgeyeEtfPro
      .mockResolvedValueOnce({
        ...VERIFIED_COMPARISON,
        available: true,
        longCount: 1,
        shortCount: 1,
        rows: etfRows,
        dataQuality: { status: 'ok', warnings: [] },
      })
      .mockRejectedValueOnce(new Error('ETF Pro refresh offline'));

    render(<PortfolioDashboard />);

    await waitFor(() => expect(mockEtfProPanel).toHaveBeenLastCalledWith(
      expect.objectContaining({
        snapshot: expect.objectContaining({
          available: true,
          comparisonAvailable: true,
          rows: etfRows,
        }),
      })
    ));

    await act(async () => {
      window.dispatchEvent(new Event('portfolioRefresh'));
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => expect(mockEtfProPanel).toHaveBeenLastCalledWith(
      expect.objectContaining({
        snapshot: expect.objectContaining({
          available: false,
          comparisonAvailable: false,
          rows: etfRows,
          dataQuality: expect.objectContaining({ status: 'error' }),
        }),
      })
    ));
  });

  test('marks stale cached ETF Pro responses unavailable for comparison', async () => {
    window.localStorage.setItem('marketDashboard.panelState.v1', JSON.stringify({
      showEtfPro: true,
    }));
    MarketDataService.getRealTimeAlertPositions.mockResolvedValueOnce({
      available: true,
      longCount: 1,
      shortCount: 22,
      dataQuality: { status: 'ok', warnings: [] },
      _cache: { stale: true, ageSeconds: 600 },
    });
    MarketDataService.getHedgeyeEtfPro.mockResolvedValueOnce({
      available: true,
      rows: [{ ticker: 'GLD', call: 'Long' }],
      dataQuality: { status: 'ok', warnings: [] },
      _cache: { stale: true, ageSeconds: 600 },
    });

    render(<PortfolioDashboard />);

    await waitFor(() => expect(mockEtfProPanel).toHaveBeenLastCalledWith(
      expect.objectContaining({
        snapshot: expect.objectContaining({
          available: true,
          comparisonAvailable: false,
          dataQuality: expect.objectContaining({ status: 'warning' }),
        }),
      })
    ));
  });

  test('does not mark ETF Pro responses with inconsistent safety metadata comparison-available', async () => {
    window.localStorage.setItem('marketDashboard.panelState.v1', JSON.stringify({
      showEtfPro: true,
    }));
    MarketDataService.getRealTimeAlertPositions.mockResolvedValueOnce({
      available: true,
      longCount: 3,
      shortCount: 2,
      dataQuality: { status: 'ok', warnings: [] },
    });
    MarketDataService.getHedgeyeEtfPro.mockResolvedValueOnce({
      ...VERIFIED_COMPARISON,
      dataAvailability: {
        ...VERIFIED_COMPARISON.dataAvailability,
        canonicalSourceVerified: false,
      },
      available: true,
      rows: [{ ticker: 'GLD', call: 'Long' }],
      dataQuality: { status: 'ok', warnings: [] },
    });

    render(<PortfolioDashboard />);

    await waitFor(() => expect(mockEtfProPanel).toHaveBeenLastCalledWith(
      expect.objectContaining({
        snapshot: expect.objectContaining({ comparisonAvailable: false }),
      })
    ));
  });

  test('keeps the overview reference during recovery independently of the daily strip', async () => {
    jest.useFakeTimers();
    const currentPayload = {
      us: [{
        symbol: 'SPX',
        price: '7515.34',
        availability: 'delayed',
        source: 'yahoo',
        dataType: 'delayed',
        freshness: 'current',
        quoteAsOf: new Date().toISOString(),
      }],
    };
    MarketDataService.getMultiRegionQuotes.mockResolvedValue(currentPayload);
    const { unmount } = render(<PortfolioDashboard />);
    await act(async () => Promise.resolve());
    expect(mockUsdMacroDashboard.mock.calls.at(-1)[0].multiRegionMarketData.us[0]).toMatchObject(currentPayload.us[0]);
    expect(mockUsdMacroDashboard.mock.calls.at(-1)[0]).not.toHaveProperty('pulseMarketData');
    unmount();
    resetSessionResourceStore();
    MarketDataService.getMultiRegionQuotes.mockImplementation(() => new Promise(() => {}));

    render(<PortfolioDashboard />);
    await act(async () => Promise.resolve());
    expect(mockUsdMacroDashboard).toHaveBeenLastCalledWith(expect.objectContaining({
      multiRegionError: null,
      multiRegionMarketData: expect.objectContaining({
        us: [expect.objectContaining({
          symbol: 'SPX',
          availability: 'reference',
          displayDelayed: true,
          quoteAsOf: currentPayload.us[0].quoteAsOf,
        })],
      }),
    }));
  });

  test('retains current market rows as reference context when a quote refresh fails', async () => {
    jest.useFakeTimers();
    const currentPayload = {
      us: [{
        symbol: 'SPX',
        price: '7515.34',
        availability: 'delayed',
        source: 'yahoo',
        dataType: 'delayed',
        freshness: 'current',
        quoteAsOf: new Date().toISOString(),
      }],
      currencies: [],
    };
    MarketDataService.getMultiRegionQuotes
      .mockResolvedValueOnce(currentPayload)
      .mockRejectedValue(new Error('quote provider offline'));

    render(<PortfolioDashboard />);

    await act(async () => Promise.resolve());
    expect(mockUsdMacroDashboard).toHaveBeenLastCalledWith(
      expect.objectContaining({ multiRegionMarketData: currentPayload })
    );

    await act(async () => {
      jest.advanceTimersByTime(1600);
      await Promise.resolve();
    });

    // The first failure is the independent historical period-return hydrate;
    // it cannot erase a still-verified current quote.
    expect(mockUsdMacroDashboard).toHaveBeenLastCalledWith(
      expect.objectContaining({ multiRegionMarketData: currentPayload })
    );

    await act(async () => {
      jest.advanceTimersByTime(30_000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockUsdMacroDashboard).toHaveBeenLastCalledWith(
      expect.objectContaining({
        multiRegionMarketData: expect.objectContaining({
          us: expect.arrayContaining([expect.objectContaining({ symbol: 'SPX', availability: 'reference',
            displayDelayed: true, executable: false, quoteAsOf: currentPayload.us[0].quoteAsOf })]),
        }),
        multiRegionError: 'quote provider offline',
        })
    );
  });

  test('retains current market rows during a transient quote refresh timeout', async () => {
    jest.useFakeTimers();
    const currentPayload = {
      us: [{
        symbol: 'SPX',
        price: '7515.34',
        availability: 'delayed',
        source: 'yahoo',
        dataType: 'delayed',
        freshness: 'current',
        quoteAsOf: new Date().toISOString(),
      }],
      currencies: [],
    };
    MarketDataService.getMultiRegionQuotes
      .mockResolvedValueOnce(currentPayload)
      .mockRejectedValue(new Error('quote refresh timed out'));

    render(<PortfolioDashboard />);

    await act(async () => Promise.resolve());
    expect(mockUsdMacroDashboard).toHaveBeenLastCalledWith(
      expect.objectContaining({ multiRegionMarketData: currentPayload })
    );

    await act(async () => {
      jest.advanceTimersByTime(1600);
      await Promise.resolve();
    });

    await act(async () => {
      jest.advanceTimersByTime(30_000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockUsdMacroDashboard).toHaveBeenLastCalledWith(
      expect.objectContaining({
        multiRegionMarketData: expect.objectContaining({
          us: expect.arrayContaining([expect.objectContaining({ symbol: 'SPX', availability: 'reference',
            displayDelayed: true, executable: false, quoteAsOf: currentPayload.us[0].quoteAsOf })]),
        }),
        multiRegionError: 'quote refresh timed out',
        })
    );
  });

  test('replaces the retired Prediction Markets hub with five prediction monitors and a separate perpetual menu', async () => {
    window.localStorage.setItem('marketDashboard.panelState.v1', JSON.stringify({
      showPredictionMarketsHub: true,
      activePredictionMarket: 'spx',
      activeWtiCadence: 'weekly',
      sidebarPanelStack: ['predictionMarkets'],
    }));

    render(<PortfolioDashboard />);

    const navigation = await screen.findByTestId('dashboard-top-navigation');
    expect(within(navigation).getByRole('button', { name: 'Prediction Markets', exact: true }))
      .toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('menu', { name: 'Prediction Markets' })).not.toBeInTheDocument();
    const menu = openPredictionMarketsMenu(navigation);
    expect(within(menu).getAllByRole('menuitemcheckbox').map((item) => item.getAttribute('aria-label')))
      .toEqual(['WTI', 'Brent', 'SP500', 'CPI', 'GDP']);
    expect(within(menu).queryByRole('menuitemcheckbox', { name: 'Nasdaq' })).not.toBeInTheDocument();
    expect(within(openPerpetualFuturesMenu(navigation)).getAllByRole('menuitemcheckbox')
      .map((item) => item.getAttribute('aria-label'))).toEqual(['Silver', 'Gold', 'BTC', 'ETH']);
    expect(screen.queryByTestId('prediction-markets-panel')).not.toBeInTheDocument();

    await waitFor(() => expect(JSON.parse(
      window.localStorage.getItem('marketDashboard.panelState.v1'),
    ).showPredictionMarketsHub).toBeUndefined());
    const stored = JSON.parse(window.localStorage.getItem('marketDashboard.panelState.v1'));
    expect(stored.activePredictionMarket).toBeUndefined();
    expect(stored.activeWtiCadence).toBeUndefined();
    expect(stored.sidebarPanelStack).not.toContain('predictionMarkets');
  });

  test('opens CPI as its own persistent T2 monitor surface', async () => {
    render(<PortfolioDashboard />);

    const navigation = await screen.findByTestId('dashboard-top-navigation');
    const cpi = getPredictionMarketItem(navigation, 'CPI');
    fireEvent.click(cpi);

    expect(await screen.findByText('Active monitor: cpi')).toBeInTheDocument();
    expect(screen.getByTestId('prediction-market-surface-cpi')).toBeVisible();
    expect(getPredictionMarketItem(navigation, 'CPI')).toHaveAttribute('aria-checked', 'true');
    expect(getPredictionMarketItem(navigation, 'SP500')).toHaveAttribute('aria-checked', 'false');
    expect(mockPredictionMonitor).toHaveBeenCalledWith(expect.objectContaining({ marketId: 'cpi' }));
  });

  test('decorates only research-aligned RR monitor buttons and keeps the active state', async () => {
    predictionMarketTestService.getMorningReport.mockResolvedValueOnce(alignedMorningReport());
    render(<PortfolioDashboard />);

    const navigation = await screen.findByTestId('dashboard-top-navigation');
    const sp500 = getPredictionMarketItem(navigation, 'SP500');
    const wti = getPredictionMarketItem(navigation, 'WTI');
    const brent = getPredictionMarketItem(navigation, 'Brent');

    await waitFor(() => expect(sp500).toHaveAttribute('data-indicator-tone', 'bullish'));
    expect(sp500).toHaveAccessibleDescription(
      'Aligned bullish Trade and Trend in the lower Risk Range third.',
    );
    expect(wti).toHaveAttribute('data-indicator-tone', 'bearish');
    expect(wti).toHaveAccessibleDescription(
      'Aligned bearish Trade and Trend in the upper Risk Range third.',
    );
    expect(brent).not.toHaveAttribute('data-indicator-tone');

    fireEvent.click(wti);
    expect(getPredictionMarketItem(navigation, 'WTI')).toHaveAttribute('aria-checked', 'true');
    expect(getPredictionMarketItem(navigation, 'WTI')).toHaveAttribute('data-indicator-tone', 'bearish');
    expect(getPerpetualFuturesItem(navigation, 'Silver')).not.toHaveAttribute('data-indicator-tone');
    expect(getPerpetualFuturesItem(navigation, 'Gold')).not.toHaveAttribute('data-indicator-tone');
    expect(getPerpetualFuturesItem(navigation, 'BTC')).not.toHaveAttribute('data-indicator-tone');
    expect(getPerpetualFuturesItem(navigation, 'ETH')).not.toHaveAttribute('data-indicator-tone');
  });

  test('removes a prior border immediately when the 30-second report refresh fails', async () => {
    jest.useFakeTimers();
    predictionMarketTestService.getMorningReport
      .mockReset()
      .mockResolvedValueOnce(alignedMorningReport())
      .mockRejectedValue(new Error('morning report transport failed'));

    render(<PortfolioDashboard />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    const navigation = screen.getByTestId('dashboard-top-navigation');
    const sp500 = getPredictionMarketItem(navigation, 'SP500');
    expect(sp500).toHaveAttribute('data-indicator-tone', 'bullish');

    await act(async () => {
      jest.advanceTimersByTime(30_000);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(sp500).not.toHaveAttribute('data-indicator-tone');
  });

  test('opens Balance alone as a centered window with the shared blurred backdrop', async () => {
    render(<PortfolioDashboard />);
    const navigation = await screen.findByTestId('dashboard-top-navigation');
    expect(screen.getByTestId('dashboard-panel-backdrop')).not.toBeVisible();
    fireEvent.click(getDockItem(navigation, 'Balance'));
    const panel = await screen.findByRole('dialog', { name: 'Balance' });
    expectCenteredWorkspaceWindow(panel);
    expect(screen.getByTestId('dashboard-panel-backdrop')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Close Balance' }));
    expect(panel).not.toBeVisible();
    expect(screen.getByTestId('dashboard-panel-backdrop')).not.toBeVisible();
  });

  test.each([
    ['Portfolio', 'portfolio-breakdown-panel'],
    ['PCA', 'exposure-lab-panel'],
    ['Balance', 'portfolio-balance-planner-slot'],
    ['Contract P&L', 'contract-pnl-panel-slot'],
    ['The Analyst', 'analyst-panel-surface'],
    ['Systems', 'system-readiness-sheet'],
  ])('dismisses %s on an outside click while keeping inside clicks open', async (label, testId) => {
    render(<PortfolioDashboard />);
    await act(async () => { await Promise.resolve(); });
    const navigation = await screen.findByTestId('dashboard-top-navigation');
    const menuItem = getDockItem(navigation, label);
    fireEvent.click(menuItem);
    await act(async () => { await Promise.resolve(); });
    const panel = await screen.findByTestId(testId);
    const backdrop = screen.getByTestId('dashboard-panel-backdrop');
    expect(panel).toBeVisible();
    expect(backdrop).toBeVisible();

    fireEvent.click(panel);
    expect(panel).toBeVisible();
    fireEvent.click(backdrop);
    expect(panel).not.toBeVisible();
    expect(backdrop).not.toBeVisible();
    expect(getDockItem(navigation, label)).not.toHaveClass('is-active');

    const reopenItem = getDockItem(navigation, label);
    fireEvent.click(reopenItem);
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByTestId(testId)).toBe(panel);
    expect(panel).toBeVisible();
  });

  test('dismisses every perpetual and prediction monitor on an outside click and retains each draft', async () => {
    render(<PortfolioDashboard />);
    await act(async () => { await Promise.resolve(); });
    const navigation = await screen.findByTestId('dashboard-top-navigation');
    const backdrop = screen.getByTestId('dashboard-panel-backdrop');
    const markets = [
      [getPerpetualFuturesItem, 'BTC', 'bitcoin'],
      [getPerpetualFuturesItem, 'ETH', 'ethereum'],
      [getPerpetualFuturesItem, 'Gold', 'gold'],
      [getPerpetualFuturesItem, 'Silver', 'silver'],
      [getPredictionMarketItem, 'WTI', 'wti'],
      [getPredictionMarketItem, 'Brent', 'brent'],
      [getPredictionMarketItem, 'SP500', 'sp500'],
      [getPredictionMarketItem, 'CPI', 'cpi'],
      [getPredictionMarketItem, 'GDP', 'gdp'],
    ];

    for (const [getMenuItem, label, marketId] of markets) {
      fireEvent.click(getMenuItem(navigation, label));
      const draft = await screen.findByLabelText(`${marketId} monitor draft`);
      const panel = screen.getByTestId('prediction-market-resolver-test-panel');
      fireEvent.change(draft, { target: { value: `${label} retained draft` } });
      fireEvent.click(draft);
      expect(panel).toBeVisible();

      fireEvent.click(backdrop);
      expect(panel).not.toBeVisible();
      expect(backdrop).not.toBeVisible();
      expect(getMenuItem(navigation, label)).toHaveAttribute('aria-checked', 'false');

      fireEvent.click(getMenuItem(navigation, label));
      expect(screen.getByLabelText(`${marketId} monitor draft`)).toBe(draft);
      expect(draft).toBeVisible();
      expect(draft).toHaveValue(`${label} retained draft`);
      fireEvent.click(backdrop);
    }
    expect(screen.getAllByText('Prediction Monitor')).toHaveLength(markets.length);
  });

  test('outside clicks close only the frontmost stacked workspace and reveal retained windows in order', async () => {
    render(<PortfolioDashboard />);
    await act(async () => { await Promise.resolve(); });
    const navigation = await screen.findByTestId('dashboard-top-navigation');
    const backdrop = screen.getByTestId('dashboard-panel-backdrop');
    fireEvent.click(getPredictionMarketItem(navigation, 'CPI'));
    const draft = await screen.findByLabelText('cpi monitor draft');
    fireEvent.change(draft, { target: { value: 'underlying CPI draft' } });
    const monitor = screen.getByTestId('prediction-market-resolver-test-panel');
    monitor.scrollTop = 120;
    fireEvent.click(getDockItem(navigation, 'Portfolio'));
    const portfolio = await screen.findByTestId('portfolio-breakdown-panel');
    fireEvent.click(getDockItem(navigation, 'Systems'));
    const systems = await screen.findByTestId('system-readiness-sheet');

    fireEvent.click(await within(systems).findByRole('button', { name: 'Report peripheral issue' }));
    expect(systems).toBeVisible();
    fireEvent.click(backdrop);
    expect(systems).not.toBeVisible();
    expect(portfolio).toBeVisible();
    expect(monitor).toBeVisible();
    expect(backdrop).toBeVisible();

    fireEvent.click(backdrop);
    expect(portfolio).not.toBeVisible();
    expect(monitor).toBeVisible();
    expect(draft).toHaveValue('underlying CPI draft');
    expect(monitor.scrollTop).toBe(120);
    expect(backdrop).toBeVisible();

    fireEvent.click(backdrop);
    expect(monitor).not.toBeVisible();
    expect(backdrop).not.toBeVisible();
  });

  test.each([
    ['Balance', 'portfolio-balance-planner-slot'],
    ['Contract P&L', 'contract-pnl-panel-slot'],
  ])('outside clicks dismiss %s before the retained workspaces below its layer', async (label, testId) => {
    render(<PortfolioDashboard />);
    await act(async () => { await Promise.resolve(); });
    const navigation = await screen.findByTestId('dashboard-top-navigation');
    fireEvent.click(getDockItem(navigation, 'Portfolio'));
    const portfolio = await screen.findByTestId('portfolio-breakdown-panel');
    portfolio.scrollTop = 150;
    fireEvent.click(getDockItem(navigation, 'Systems'));
    const systems = await screen.findByTestId('system-readiness-sheet');
    const menuItem = getDockItem(navigation, label);
    fireEvent.click(menuItem);
    await act(async () => { await Promise.resolve(); });
    const panel = await screen.findByTestId(testId);
    expect(panel).toBeVisible();
    expect(Number(panel.style.zIndex)).toBeGreaterThan(Number(systems.style.zIndex));

    const backdrop = screen.getByTestId('dashboard-panel-backdrop');
    fireEvent.click(backdrop);
    expect(panel).not.toBeVisible();
    expect(systems).toBeVisible();
    expect(portfolio).toBeVisible();
    expect(portfolio.scrollTop).toBe(150);
    expect(backdrop).toBeVisible();

    fireEvent.click(backdrop);
    expect(systems).not.toBeVisible();
    expect(portfolio).toBeVisible();
  });

  test('centers Balance above an open market monitor without repositioning either window', async () => {
    render(<PortfolioDashboard />);

    const navigation = await screen.findByTestId('dashboard-top-navigation');
    fireEvent.click(getPredictionMarketItem(navigation, 'SP500'));
    expect(await screen.findByText('Active monitor: sp500')).toBeInTheDocument();

    fireEvent.click(getDockItem(navigation, 'Balance'));

    const balancePanel = await screen.findByTestId('portfolio-balance-planner-slot');
    expect(balancePanel).toBeVisible();
    expectCenteredWorkspaceWindow(balancePanel);
    const predictionMonitorPanel = screen.getByTestId('prediction-market-resolver-test-panel');
    expect(predictionMonitorPanel).toBeVisible();
    expect(Number(balancePanel.style.zIndex))
      .toBeGreaterThan(Number(predictionMonitorPanel.style.zIndex));
    expect(screen.getByTestId('dashboard-panel-backdrop')).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Close Balance' }));
    await waitFor(() => expect(balancePanel).not.toBeVisible());
    expect(screen.getByTestId('prediction-market-resolver-test-panel')).toBeVisible();
  });

  test('opens The Analyst in the centered shared frame with a blurred dashboard backdrop', async () => {
    render(<PortfolioDashboard />);

    const navigation = await screen.findByTestId('dashboard-top-navigation');
    fireEvent.click(within(navigation).getByRole('button', { name: 'The Analyst' }));

    expect(await screen.findByTestId('mock-analyst-panel')).toBeInTheDocument();
    const analystPanel = screen.getByTestId('analyst-panel-surface');
    expect(analystPanel).toBeVisible();
    expect(analystPanel).toHaveClass(
      'dashboard-navigation-rail__balance-panel',
      'dashboard-navigation-rail__analyst-panel',
    );
    expectCenteredWorkspaceWindow(analystPanel);
    expect(analystPanel).not.toHaveClass('dashboard-side-panel--analyst-card');
    expect(screen.getByRole('separator', { name: 'Resize The Analyst from the right edge' }))
      .toBeInTheDocument();
    expect(screen.getByTestId('dashboard-panel-backdrop')).toBeVisible();
    expect(screen.getByTestId('dashboard-panel-backdrop')).toHaveAttribute('aria-hidden', 'false');
    expect(screen.getByTestId('dashboard-main-canvas')).not.toHaveAttribute('aria-hidden');
    expect(screen.getByTestId('dashboard-main-canvas').inert).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Close The Analyst' }));
    await waitFor(() => expect(analystPanel).not.toBeVisible());
  });

  test('resizes The Analyst symmetrically and persists the chosen width', async () => {
    render(<PortfolioDashboard />);

    const navigation = await screen.findByTestId('dashboard-top-navigation');
    fireEvent.click(within(navigation).getByRole('button', { name: 'The Analyst' }));

    const analystPanel = await screen.findByTestId('analyst-panel-surface');
    const resizeHandle = screen.getByRole('separator', { name: 'Resize The Analyst from the right edge' });
    jest.spyOn(analystPanel, 'getBoundingClientRect').mockImplementation(() => {
      const width = Number.parseFloat(
        analystPanel.style.getPropertyValue('--analyst-panel-width'),
      ) || 440;
      const left = (window.innerWidth - width) / 2;
      return {
        bottom: 712,
        height: 704,
        left,
        right: left + width,
        top: 8,
        width,
        x: left,
        y: 8,
        toJSON: () => ({}),
      };
    });

    fireEvent(resizeHandle, new MouseEvent('pointerdown', {
      bubbles: true,
      button: 0,
      clientX: 700,
    }));
    expect(document.body).toHaveClass('dashboard-is-resizing-analyst');
    fireEvent(window, new MouseEvent('pointermove', { clientX: 800 }));
    expect(analystPanel.style.getPropertyValue('--analyst-panel-width')).toBe('640px');
    expectCenteredWorkspaceWindow(analystPanel);
    fireEvent(window, new MouseEvent('pointerup', { clientX: 800 }));
    expect(document.body).not.toHaveClass('dashboard-is-resizing-analyst');

    await waitFor(() => expect(
      JSON.parse(window.localStorage.getItem('marketDashboard.panelState.v1')).analystPanelWidth,
    ).toBe(640));

    fireEvent.keyDown(resizeHandle, { key: 'ArrowLeft' });
    expect(analystPanel.style.getPropertyValue('--analyst-panel-width')).toBe('616px');
    fireEvent.doubleClick(resizeHandle);
    expect(analystPanel.style.getPropertyValue('--analyst-panel-width')).toBe('440px');
  });

  test('resizes a restored Analyst width around the center after migrating its left dock', async () => {
    window.localStorage.setItem('marketDashboard.panelState.v1', JSON.stringify({
      analystPanelPosition: 'left',
      analystPanelWidth: 540,
    }));
    render(<PortfolioDashboard />);

    const navigation = await screen.findByTestId('dashboard-top-navigation');
    fireEvent.click(within(navigation).getByRole('button', { name: 'The Analyst' }));

    const analystPanel = await screen.findByTestId('analyst-panel-surface');
    expect(analystPanel).toHaveClass('dashboard-navigation-rail__analyst-panel--center');
    expectCenteredWorkspaceWindow(analystPanel);
    expect(analystPanel.style.getPropertyValue('--analyst-panel-width')).toBe('540px');

    const resizeHandle = screen.getByRole('separator', {
      name: 'Resize The Analyst from the right edge',
    });
    expect(resizeHandle).toHaveAttribute(
      'title',
      'Drag the right edge to resize · double-click to reset',
    );
    jest.spyOn(analystPanel, 'getBoundingClientRect').mockImplementation(() => {
      const width = Number.parseFloat(
        analystPanel.style.getPropertyValue('--analyst-panel-width'),
      );
      const left = (window.innerWidth - width) / 2;
      return {
        bottom: 712,
        height: 704,
        left,
        right: left + width,
        top: 8,
        width,
        x: left,
        y: 8,
        toJSON: () => ({}),
      };
    });

    fireEvent(resizeHandle, new MouseEvent('pointerdown', {
      bubbles: true,
      button: 0,
      clientX: 700,
    }));
    fireEvent(window, new MouseEvent('pointermove', { clientX: 800 }));
    expect(analystPanel.style.getPropertyValue('--analyst-panel-width')).toBe('740px');
    fireEvent(window, new MouseEvent('pointerup', { clientX: 800 }));

    fireEvent.keyDown(resizeHandle, { key: 'ArrowRight' });
    expect(analystPanel.style.getPropertyValue('--analyst-panel-width')).toBe('764px');
  });

test('opens and closes The Analyst from its label without positioning dots', async () => {
  render(<PortfolioDashboard />);

  const navigation = await screen.findByTestId('dashboard-top-navigation');
  expect(within(navigation).queryByRole('group', { name: 'Position The Analyst' })).not.toBeInTheDocument();
  expect(within(navigation).queryByRole('button', { name: /Move The Analyst/ })).not.toBeInTheDocument();
  expect(within(navigation).queryByTestId('analyst-position-controls')).not.toBeInTheDocument();
  const analyst = within(navigation).getByRole('button', { name: 'The Analyst', exact: true });
  expect(analyst).toHaveAttribute('aria-pressed', 'false');
  fireEvent.click(analyst);
  const analystPanel = await screen.findByTestId('analyst-panel-surface');
  expect(analystPanel).toBeVisible();
  expect(analyst).toHaveAttribute('aria-pressed', 'true');
  await waitFor(() => expect(
    JSON.parse(window.localStorage.getItem('marketDashboard.panelState.v1')).showAnalyst,
  ).toBe(true));
  fireEvent.click(analyst);
  await waitFor(() => expect(analystPanel).not.toBeVisible());
  expect(analyst).toHaveAttribute('aria-pressed', 'false');
  await waitFor(() => expect(
    JSON.parse(window.localStorage.getItem('marketDashboard.panelState.v1')).showAnalyst,
  ).toBe(false));
});

test.each(['left', 'center', 'right'])('restores a saved Analyst %s position as a centered window without navigation shortcuts', async (position) => {
  window.localStorage.setItem('marketDashboard.panelState.v1', JSON.stringify({
    showAnalyst: true,
    analystPanelPosition: position,
    sidebarPanelStack: ['analyst'],
  }));

  render(<PortfolioDashboard />);

  const analystPanel = await screen.findByTestId('analyst-panel-surface');
  expect(analystPanel).toHaveClass('dashboard-navigation-rail__analyst-panel--center');
  expectCenteredWorkspaceWindow(analystPanel);
  expect(analystPanel).not.toHaveClass('dashboard-navigation-rail__analyst-panel--left');
  expect(analystPanel).not.toHaveClass('dashboard-navigation-rail__analyst-panel--right');
  await waitFor(() => expect(
    JSON.parse(window.localStorage.getItem('marketDashboard.panelState.v1')).analystPanelPosition,
  ).toBeUndefined());

  const navigation = await screen.findByTestId('dashboard-top-navigation');
  expect(within(navigation).getByRole('button', { name: 'The Analyst', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect(within(navigation).queryByRole('group', { name: 'Position The Analyst' })).not.toBeInTheDocument();
});

test('centers The Analyst while an individual market monitor stays open', async () => {
    render(<PortfolioDashboard />);

    const navigation = await screen.findByTestId('dashboard-top-navigation');
    fireEvent.click(getPredictionMarketItem(navigation, 'SP500'));
    expect(await screen.findByText('Active monitor: sp500')).toBeInTheDocument();
    fireEvent.click(within(navigation).getByRole('button', { name: 'The Analyst' }));

    const analystPanel = await screen.findByTestId('analyst-panel-surface');
    expect(analystPanel).toBeVisible();
    expectCenteredWorkspaceWindow(analystPanel);
    const predictionMonitorPanel = screen.getByTestId('prediction-market-resolver-test-panel');
    expect(predictionMonitorPanel).toBeVisible();
    expect(predictionMonitorPanel)
      .toHaveAttribute('data-surface-active', 'true');
  });

  test('centers The Analyst while Portfolio stays open', async () => {
    render(<PortfolioDashboard />);

    const navigation = await screen.findByTestId('dashboard-top-navigation');
    fireEvent.click(getDockItem(navigation, 'Portfolio'));
    expect(await screen.findByText('Portfolio Breakdown')).toBeInTheDocument();
    fireEvent.click(within(navigation).getByRole('button', { name: 'The Analyst' }));

    const analystPanel = await screen.findByTestId('analyst-panel-surface');
    expect(analystPanel).toBeVisible();
    expectCenteredWorkspaceWindow(analystPanel);
    const portfolioPanel = screen.getByTestId('portfolio-breakdown-panel');
    expect(portfolioPanel).toBeVisible();
    expect(portfolioPanel)
      .toHaveAttribute('data-surface-active', 'true');
  });

  test('opens PCA as a centered wide workspace from the bottom dock', async () => {
    render(<PortfolioDashboard />);

    const navigation = await screen.findByTestId('dashboard-top-navigation');
    const exposureButton = () => getDockItem(navigation, 'PCA');
    fireEvent.click(exposureButton());

    expect(await screen.findByText('PCA Workspace')).toBeInTheDocument();
    const panel = screen.getByTestId('exposure-lab-panel');
    expect(panel).toBeVisible();
    expect(panel).toHaveAttribute('data-layout', 'centered-workspace');
    expect(panel).toHaveClass('dashboard-side-panel--exposure-card', 'dashboard-workspace-window--wide');
    expectCenteredWorkspaceWindow(panel);
    expect(panel.style.width).toBe('');
    expect(panel.style.height).toBe('');
    expect(screen.getByTestId('dashboard-panel-backdrop')).toBeVisible();
    expect(exposureButton()).toHaveClass('is-active');
    expect(mockExposureLab).toHaveBeenLastCalledWith(expect.objectContaining({
      portfolioData: expect.objectContaining({ dataSource: 'ibkr_api' }),
    }));

    await waitFor(() => {
      const stored = JSON.parse(window.localStorage.getItem('marketDashboard.panelState.v1'));
      expect(stored.showExposureLab).toBe(true);
      expect(stored.sidebarPanelStack).toContain('exposureLab');
    });
  });

  test('puts every existing workspace destination in the bottom dock and groups prediction markets', async () => {
    render(<PortfolioDashboard />);

    const shell = screen.getByTestId('dashboard-shell');
    const navigation = await screen.findByTestId('dashboard-top-navigation');
    const processButton = () => getDockItem(navigation, 'Process');

    expect(shell).toHaveStyle({
      '--dashboard-rail-collapsed-width': '0px',
      '--dashboard-rail-visible-width': '0px',
    });
    expect(navigation).toHaveClass('dashboard-top-navigation');
    expect(screen.queryByRole('textbox', { name: 'Search navigation' })).not.toBeInTheDocument();
    expect(screen.queryByText('⌘ K')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Expand' })).not.toBeInTheDocument();
    expect(processButton()).toHaveClass('dashboard-top-navigation__item');
    expect(within(navigation).queryByText('PRIMARY')).not.toBeInTheDocument();
    expect(within(navigation).queryByText('UTILITY')).not.toBeInTheDocument();
    expect(screen.queryByTestId('dashboard-rail-navigation')).not.toBeInTheDocument();
    ['X.com', 'Process', 'Dashboard Guide', 'PCA Guide', 'Portfolio', 'PCA',
      'Balance', 'Contract P&L', 'Prediction Markets', 'Perpetual Futures', 'Systems', 'The Analyst']
      .forEach((label) => expect(getDockItem(navigation, label))
        .toBeInTheDocument());
    ['Silver', 'Gold', 'BTC', 'ETH', 'WTI', 'Brent', 'SP500', 'CPI', 'GDP']
      .forEach((label) => expect(within(navigation).queryByRole('button', { name: label }))
        .not.toBeInTheDocument());
    expect(within(openPredictionMarketsMenu(navigation)).getAllByRole('menuitemcheckbox')).toHaveLength(5);
    expect(within(openPerpetualFuturesMenu(navigation)).getAllByRole('menuitemcheckbox')).toHaveLength(4);
    expect(navigation.querySelector('.dashboard-top-navigation__chevron')).toBeNull();
    expect(navigation.querySelector('.dashboard-navigation-rail__card-status')).toBeNull();
    expect(screen.queryByTitle('Switch to Dark Mode')).not.toBeInTheDocument();
  });

  test('omits retired EV Data, Pods, and Securities Universe destinations', async () => {
    window.localStorage.setItem('marketDashboard.panelState.v1', JSON.stringify({
      showPeaPodWindow: true,
      showEVWindow: true,
      showSecuritiesUniverse: true,
      sidebarPanelStack: ['pods', 'ev', 'securities'],
    }));
    render(<PortfolioDashboard />);

    const navigation = await screen.findByTestId('dashboard-top-navigation');
    expect(within(navigation).getByRole('button', { name: /^Systems/ })).toBeInTheDocument();
    ['The Analyst', 'Process', 'Dashboard Guide', 'PCA Guide', 'Portfolio', 'Balance', 'Prediction Markets', 'Perpetual Futures']
      .forEach((label) => expect(getDockItem(navigation, label)).toBeInTheDocument());
    expect(within(navigation).queryByRole('button', { name: 'Market Structure' }))
      .not.toBeInTheDocument();
    expect(within(navigation).queryByRole('button', { name: 'PODS' })).not.toBeInTheDocument();
    expect(within(navigation).queryByRole('button', { name: 'EV Data' })).not.toBeInTheDocument();
    expect(within(navigation).queryByRole('button', { name: 'Securities Universe' }))
      .not.toBeInTheDocument();
    expect(screen.queryByText('POD Calculations')).not.toBeInTheDocument();
    expect(screen.queryByText('Expected Values')).not.toBeInTheDocument();
    const processButton = () => getDockItem(navigation, 'Process');
    expect(within(navigation).getByRole('button', { name: 'Prediction Markets', exact: true }))
      .toHaveAttribute('aria-haspopup', 'menu');
    expect(within(navigation).queryByRole('button', { name: 'SPX Close' })).not.toBeInTheDocument();
    expect(screen.queryByTitle('Performance Tracking')).not.toBeInTheDocument();
    expect(within(navigation).queryByRole('button', { name: 'Analytics' })).not.toBeInTheDocument();
    expect(within(navigation).getByTitle('Systems')).toBeInTheDocument();
    expect(getDockItem(undefined, 'X.com')).toBeInTheDocument();
    expect(processButton()).toHaveAttribute('data-process-toggle', 'true');
    await waitFor(() => {
      const stored = JSON.parse(window.localStorage.getItem('marketDashboard.panelState.v1'));
      expect({
        showPeaPodWindow: stored.showPeaPodWindow,
        showEVWindow: stored.showEVWindow,
        showSecuritiesUniverse: stored.showSecuritiesUniverse,
        sidebarPanelStack: stored.sidebarPanelStack,
      }).toEqual({
        showPeaPodWindow: undefined,
        showEVWindow: undefined,
        showSecuritiesUniverse: undefined,
        sidebarPanelStack: expect.not.arrayContaining(['pods', 'ev', 'securities']),
      });
    });
  });

  test('discards the retired Market Structure workspace state and destination', async () => {
    window.localStorage.setItem('marketDashboard.panelState.v1', JSON.stringify({
      showMarketStructure: true,
      sidebarPanelStack: ['marketStructure'],
    }));
    render(<PortfolioDashboard />);

    const navigation = await screen.findByTestId('dashboard-top-navigation');
    expect(within(navigation).queryByRole('button', { name: 'Market Structure' }))
      .not.toBeInTheDocument();
    expect(screen.queryByTestId('market-structure-panel')).not.toBeInTheDocument();
    await waitFor(() => {
      const stored = JSON.parse(window.localStorage.getItem('marketDashboard.panelState.v1'));
      expect({
        showMarketStructure: stored.showMarketStructure,
        sidebarPanelStack: stored.sidebarPanelStack,
      }).toEqual({
        showMarketStructure: undefined,
        sidebarPanelStack: expect.not.arrayContaining(['marketStructure']),
      });
    });
  });

  test('keeps every workspace destination in the bottom navigation and opens Balance separately', async () => {
    MarketDataService.getPortfolioBalance.mockResolvedValue(livePortfolioBalance());
    render(<PortfolioDashboard />);

    const shell = screen.getByTestId('dashboard-shell');
    const navigation = await screen.findByTestId('dashboard-top-navigation');
    expect(shell).toHaveStyle({
      '--dashboard-rail-visible-width': '0px',
    });
    expect(navigation).toHaveClass('dashboard-top-navigation');
    expect(screen.queryByRole('heading', { name: 'Workspace' })).not.toBeInTheDocument();
    expect(within(navigation).queryByText('SYSTEMS')).not.toBeInTheDocument();
    expect(within(navigation).queryByText('MARKET INTELLIGENCE')).not.toBeInTheDocument();
    ['Signal Strength', 'ETF Pro', 'Macro Show', 'Call']
      .forEach((label) => expect(within(navigation).queryByTitle(label)).not.toBeInTheDocument());
    expect(within(navigation).getByTitle('Systems')).toBeInTheDocument();
    expect(getDockItem(navigation, 'Balance')).toHaveClass('dashboard-top-navigation__item');
    expect(getDockItem(navigation, 'Contract P&L')).toHaveClass('dashboard-top-navigation__item');
    expect(screen.queryByTitle('Expand')).not.toBeInTheDocument();
    expect(within(navigation).queryByRole('button', { name: 'Analytics' })).not.toBeInTheDocument();
    expect(screen.queryByText('Portfolio Sidebar Snapshot')).not.toBeInTheDocument();

    fireEvent.click(getDockItem(navigation, 'Portfolio'));
    expect(await screen.findByText('Portfolio Breakdown')).toBeInTheDocument();
    expect(screen.getByTestId('portfolio-breakdown-panel')).toBeVisible();
    expect(screen.getByTestId('portfolio-breakdown-panel'))
      .toHaveClass('dashboard-side-panel--portfolio-card');
    expect(screen.getByTestId('dashboard-panel-backdrop')).toBeVisible();

    fireEvent.click(getDockItem(navigation, 'Balance'));
    expect(await screen.findByRole('dialog', { name: 'Balance' })).toBeInTheDocument();
    expect(screen.queryByRole('tablist', { name: 'Balance panel view' })).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Portfolio balance scenario planner' }))
      .toBeInTheDocument();
    expectCenteredWorkspaceWindow(screen.getByTestId('portfolio-balance-planner-slot'));
    expect(screen.getByText('Portfolio Breakdown')).toBeInTheDocument();
    expect(shell).toHaveStyle({
      '--dashboard-rail-visible-width': '0px',
    });

    fireEvent.click(screen.getByRole('button', { name: 'Close Balance' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Balance' }))
      .not.toBeInTheDocument());

    const balanceReadsAfterFirstOpen = MarketDataService.getPortfolioBalance.mock.calls.length;
    fireEvent.click(getDockItem(navigation, 'Balance'));
    expect(await screen.findByRole('dialog', { name: 'Balance' })).toBeInTheDocument();
    expect(MarketDataService.getPortfolioBalance.mock.calls.length)
      .toBe(balanceReadsAfterFirstOpen);
  });

  test('opens the single-account Contract P&L ledger from its own navigation destination', async () => {
    MarketDataService.getPredictionMarketPerformance.mockResolvedValue({
      rows: [{
        id: 'ledger-1',
        resolvedDate: '2026-08-13',
        market: 'wti',
        contractLabel: 'WTI $81.49 YES',
        risked: 4,
        paid: 10,
        currentValue: 10,
        pnl: 6,
        roi: 1.5,
        status: 'verified',
      }],
      review: [],
      summary: { count: 1, openCount: 0, openPnl: 0, realizedCount: 1, realizedPnl: 6, risked: 4, paid: 10, pnl: 6, roi: 1.5 },
      tracker: { status: 'ready', health: 'capturing' },
    });
    render(<PortfolioDashboard />);

    const navigation = await screen.findByTestId('dashboard-top-navigation');
    const balanceButton = () => getDockItem(navigation, 'Balance');
    const contractPnlButton = () => getDockItem(navigation, 'Contract P&L');
    expect(balanceButton()).not.toBe(contractPnlButton());
    await waitFor(() => expect(MarketDataService.getPredictionMarketPerformanceHistory).toHaveBeenCalledWith({ account: 'U25779973' }));
    expect(MarketDataService.getPredictionMarketPerformanceCurrent).not.toHaveBeenCalled();
    fireEvent.click(contractPnlButton());
    expect(await screen.findByRole('dialog', { name: 'Contract P&L' })).toBeVisible();
    expect(screen.queryByRole('dialog', { name: 'Balance' })).not.toBeInTheDocument();
    expect(contractPnlButton()).toHaveClass('is-active');
    expect(balanceButton()).not.toHaveClass('is-active');
    expect(screen.queryByRole('tablist', { name: 'Balance panel view' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tablist', { name: 'Contract P&L account' })).not.toBeInTheDocument();
    await waitFor(() => expect(MarketDataService.getPredictionMarketPerformance).toHaveBeenCalled());
    expect(await screen.findByText('81.49')).toBeInTheDocument();
    expect(screen.getByTestId('contract-pnl-surface'))
      .toHaveClass('dashboard-navigation-rail__balance-surface');
    expect(screen.queryByText('Prediction performance')).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Overview' })).toBeInTheDocument();
    expect(MarketDataService.getPredictionMarketPerformance).toHaveBeenCalledWith(expect.objectContaining({
      account: 'U25779973',
      scope: 'account',
    }));
    expect(MarketDataService.getPredictionMarketPerformanceHistory).toHaveBeenCalledTimes(1);
  });

  test('centers Contract P&L independently of the covered Portfolio and restores its retained state', async () => {
    window.localStorage.setItem('marketDashboard.panelState.v1', JSON.stringify({
      showPortfolioBreakdown: true, sidebarPanelStack: ['portfolio'], contractPnlPanelWidth: 295,
    }));
    MarketDataService.getPredictionMarketPerformance.mockResolvedValue({ rows: [], tracker: { status: 'ready' } });
    render(<PortfolioDashboard />);
    const covered = await screen.findByTestId('portfolio-breakdown-panel');
    covered.scrollTop = 150;
    jest.spyOn(covered, 'getBoundingClientRect').mockReturnValue({
      left: 100, right: 960, top: 8, bottom: 712, width: 860, height: 704,
    });
    const navigation = screen.getByTestId('dashboard-top-navigation');
    fireEvent.click(getDockItem(navigation, 'Contract P&L'));
    const panel = await screen.findByTestId('contract-pnl-panel-slot');
    expectCenteredWorkspaceWindow(panel);
    expect(panel.style.getPropertyValue('--dashboard-balance-panel-width')).toBe('720px');
    expect(panel.style.getPropertyValue('--dashboard-balance-panel-base-right')).toBe('');
    expect(screen.getByTestId('dashboard-panel-backdrop')).toBeVisible();
    expect(covered).not.toBeVisible();
    expect(covered).toHaveAttribute('data-surface-occluded', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Close Contract P&L' }));
    expect(covered).toBeVisible();
    expect(covered.scrollTop).toBe(150);
    expect(screen.getByTestId('portfolio-breakdown-panel')).toBe(covered);
  });

  test('resizes Contract P&L symmetrically from either edge and persists its complete width', async () => {
    MarketDataService.getPredictionMarketPerformance.mockResolvedValue({
      rows: [],
      review: [],
      summary: { count: 0, openCount: 0, openPnl: 0, realizedCount: 0, realizedPnl: 0 },
      tracker: { status: 'ready', health: 'capturing' },
    });
    render(<PortfolioDashboard />);

    const navigation = await screen.findByTestId('dashboard-top-navigation');
    fireEvent.click(getDockItem(navigation, 'Contract P&L'));

    const panel = screen.getByTestId('contract-pnl-panel-slot');
    const resizeHandle = screen.getByRole('separator', {
      name: 'Resize Contract P&L from the left edge',
    });
    const rightResizeHandle = screen.getByRole('separator', {
      name: 'Resize Contract P&L from the right edge',
    });
    expect(panel).toHaveClass('dashboard-navigation-rail__balance-panel--contract-pnl');
    expect(screen.getByTestId('dashboard-panel-backdrop')).toBeVisible();
    expect(screen.getByTestId('dashboard-panel-backdrop')).toHaveAttribute('aria-hidden', 'false');
    expect(resizeHandle).toHaveAttribute(
      'title',
      'Drag the left edge to resize · double-click to reset',
    );
    expect(rightResizeHandle).toHaveAttribute(
      'title',
      'Drag the right edge to resize · double-click to reset',
    );
    jest.spyOn(panel, 'getBoundingClientRect').mockImplementation(() => {
      const width = Number.parseFloat(
        panel.style.getPropertyValue('--dashboard-balance-panel-width'),
      ) || 720;
      const left = (window.innerWidth - width) / 2;
      const right = left + width;
      return {
        bottom: 712,
        height: 704,
        left,
        right,
        top: 8,
        width,
        x: left,
        y: 8,
        toJSON: () => ({}),
      };
    });

    fireEvent(resizeHandle, new MouseEvent('pointerdown', {
      bubbles: true,
      button: 0,
      clientX: 605,
    }));
    expect(document.body).toHaveClass('dashboard-is-resizing-contract-pnl');
    fireEvent(window, new MouseEvent('pointermove', { clientX: 505 }));
    expect(panel.style.getPropertyValue('--dashboard-balance-panel-width')).toBe('920px');
    fireEvent(window, new MouseEvent('pointerup', { clientX: 505 }));
    expect(document.body).not.toHaveClass('dashboard-is-resizing-contract-pnl');

    await waitFor(() => expect(
      JSON.parse(window.localStorage.getItem('marketDashboard.panelState.v1')).contractPnlPanelWidth,
    ).toBe(920));

    fireEvent.keyDown(resizeHandle, { key: 'ArrowRight' });
    expect(panel.style.getPropertyValue('--dashboard-balance-panel-width')).toBe('896px');

    fireEvent(rightResizeHandle, new MouseEvent('pointerdown', {
      bubbles: true,
      button: 0,
      clientX: 900,
    }));
    fireEvent(window, new MouseEvent('pointermove', { clientX: 940 }));
    expect(panel.style.getPropertyValue('--dashboard-balance-panel-width')).toBe('976px');
    expect(panel.style.getPropertyValue('--dashboard-contract-pnl-right-extension')).toBe('');
    fireEvent(window, new MouseEvent('pointerup', { clientX: 940 }));

    expectCenteredWorkspaceWindow(panel);
    await waitFor(() => expect(
      JSON.parse(window.localStorage.getItem('marketDashboard.panelState.v1')),
    ).toMatchObject({
      contractPnlPanelWidth: 976,
      contractPnlPanelRightExtension: 0,
      contractPnlGeometryVersion: 3,
    }));

    fireEvent.click(getDockItem(navigation, 'Balance'));
    expect(panel).not.toBeVisible();
    expect(screen.queryByRole('separator', {
      name: 'Resize Contract P&L from the left edge',
    })).not.toBeInTheDocument();
    expect(screen.getByTestId('portfolio-balance-planner-slot').style
      .getPropertyValue('--dashboard-balance-panel-width')).toBe('295px');

    fireEvent.click(getDockItem(navigation, 'Contract P&L'));
    expect(panel).toBeVisible();
    expect(panel.style.getPropertyValue('--dashboard-balance-panel-width')).toBe('976px');
    fireEvent.doubleClick(screen.getByRole('separator', {
      name: 'Resize Contract P&L from the right edge',
    }));
    expect(panel.style.getPropertyValue('--dashboard-balance-panel-width')).toBe('720px');
    expect(panel.style.getPropertyValue('--dashboard-contract-pnl-right-extension')).toBe('');
  });

  test('switches the Contract P&L surface to Overview market sections', async () => {
    MarketDataService.getPredictionMarketPerformance.mockResolvedValue({
      rows: [{
        id: 'ledger-1',
        resolvedDate: '2026-08-13',
        market: 'wti',
        contractLabel: 'WTI $81.49 YES',
        risked: 4,
        paid: 10,
        currentValue: 10,
        pnl: 6,
        roi: 1.5,
        status: 'verified',
      }],
      review: [],
      summary: { count: 1, openCount: 0, openPnl: 0, realizedCount: 1, realizedPnl: 6, risked: 4, paid: 10, pnl: 6, roi: 1.5 },
      tracker: { status: 'ready', health: 'capturing' },
    });
    render(<PortfolioDashboard />);

    const navigation = await screen.findByTestId('dashboard-top-navigation');
    fireEvent.click(getDockItem(navigation, 'Contract P&L'));
    fireEvent.click(await screen.findByRole('tab', { name: 'Overview' }));
    expect(await screen.findByRole('article', { name: 'WTI overview' })).toBeInTheDocument();
    expect(within(screen.getByRole('article', { name: 'WTI overview' })).getAllByText('+$6.00').length).toBeGreaterThan(0);
    expect(screen.getByRole('article', { name: 'Gold overview' })).toBeInTheDocument();
  });

  test('raises the blurred backdrop over retained windows below Systems and restores it on close', async () => {
    render(<PortfolioDashboard />);
    const navigation = await screen.findByTestId('dashboard-top-navigation');
    fireEvent.click(getDockItem(navigation, 'Portfolio'));
    const portfolioPanel = await screen.findByTestId('portfolio-breakdown-panel');
    const backdrop = screen.getByTestId('dashboard-panel-backdrop');
    expect(backdrop).toBeVisible();
    expect(Number(backdrop.style.zIndex)).toBe(Number(portfolioPanel.style.zIndex));

    fireEvent.click(within(navigation).getByRole('button', { name: 'Systems', exact: true }));
    const systemsPanel = await screen.findByTestId('system-readiness-sheet');
    const closeSystems = await within(systemsPanel).findByRole('button', { name: 'Close Systems' });
    expect(systemsPanel).toBeVisible();
    expect(portfolioPanel).toBeVisible();
    expect(backdrop).toBeVisible();
    expect(Number(backdrop.style.zIndex)).toBeGreaterThan(Number(portfolioPanel.style.zIndex));
    expect(Number(backdrop.style.zIndex)).toBe(Number(systemsPanel.style.zIndex));
    expect(backdrop.compareDocumentPosition(systemsPanel) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBe(Node.DOCUMENT_POSITION_FOLLOWING);

    fireEvent.click(closeSystems);
    expect(systemsPanel).not.toBeVisible();
    expect(screen.getByTestId('portfolio-breakdown-panel')).toBe(portfolioPanel);
    expect(portfolioPanel).toBeVisible();
    expect(backdrop).toBeVisible();
    expect(Number(backdrop.style.zIndex)).toBe(Number(portfolioPanel.style.zIndex));
  });

  test('opens and persists the lightweight Systems panel', async () => {
    render(<PortfolioDashboard />);

    const systemButton = await screen.findByTitle('Systems');
    expect(systemButton).toHaveAttribute('data-readiness-status', 'unknown');
    expect(within(systemButton).getByText('System status: unknown')).toHaveClass('sr-only');
    fireEvent.click(systemButton);

    expect(await screen.findByText('Systems Panel')).toBeInTheDocument();
    await waitFor(() => expect(JSON.parse(window.localStorage.getItem('marketDashboard.panelState.v1')).showSystemReadiness).toBe(true));
    const stored = JSON.parse(window.localStorage.getItem('marketDashboard.panelState.v1'));
    expect(stored.sidebarPanelStack).toContain('system');
    const systemsPanel = screen.getByTestId('system-readiness-sheet');
    expect(systemsPanel).toBeVisible();
    expectCenteredWorkspaceWindow(systemsPanel);
    expect(systemsPanel).toHaveClass('dashboard-workspace-window--compact');
    expect(screen.getByTestId('dashboard-panel-backdrop')).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Report peripheral issue' }));
    expect(systemButton).toHaveAttribute('data-readiness-status', 'attention');
    expect(within(systemButton).getByText('System status: attention')).toHaveClass('sr-only');
    expect(systemButton).toHaveStyle({ borderColor: 'var(--dashboard-attention)' });

    fireEvent.click(screen.getByRole('button', { name: 'Close Systems' }));
    expect(screen.getByTestId('system-readiness-sheet')).toHaveStyle({ display: 'none' });
  });

  test('places Dashboard Guide and PCA Guide directly after Process and opens their routes', async () => {
    const onOpenProcess = jest.fn();
    const onNavigateProcess = jest.fn();
    render(
      <PortfolioDashboard
        onOpenProcess={onOpenProcess}
        onNavigateProcess={onNavigateProcess}
      />,
    );

    const xButton = () => getDockItem(undefined, 'X.com');
    const processButton = () => getDockItem(undefined, 'Process');
    const dashboardGuideButton = () => getDockItem(undefined, 'Dashboard Guide');
    const exposureGuideButton = () => getDockItem(undefined, 'PCA Guide');
    const navigation = screen.getByTestId('dashboard-top-navigation');
    getDockItem(navigation, 'Process');
    const buttons = within(screen.getByRole('menu', { name: 'Research' })).getAllByRole('menuitem');

    expect(buttons.map((button) => button.getAttribute('aria-label'))).not.toContain('TL;DR');
    expect(buttons[buttons.indexOf(xButton()) + 1]).toBe(processButton());
    expect(buttons[buttons.indexOf(processButton()) + 1]).toBe(dashboardGuideButton());
    expect(buttons[buttons.indexOf(dashboardGuideButton()) + 1]).toBe(exposureGuideButton());
    expect(within(navigation).queryByRole('button', { name: 'Market Structure' }))
      .not.toBeInTheDocument();
    fireEvent.click(processButton());
    expect(onOpenProcess).toHaveBeenCalledTimes(1);
    fireEvent.click(dashboardGuideButton());
    expect(onNavigateProcess).toHaveBeenCalledWith('#/process/dashboard-guide');
    fireEvent.click(exposureGuideButton());
    expect(onNavigateProcess).toHaveBeenCalledWith('#/process/exposure-lab');
  });

  test('switches between Process, Dashboard Guide, and PCA Guide without closing the reader', async () => {
    const onNavigateProcess = jest.fn();
    const onCloseProcess = jest.fn();
    const view = render(
      <PortfolioDashboard
        processDocumentId="the-process"
        onCloseProcess={onCloseProcess}
        onNavigateProcess={onNavigateProcess}
      />,
    );

    await screen.findByTestId('process-overlay');
    const dashboardGuideButton = () => getDockItem(undefined, 'Dashboard Guide');
    const exposureGuideButton = () => getDockItem(undefined, 'PCA Guide');
    expect(getDockItem(undefined, 'Process')).toHaveClass('is-active');
    expect(dashboardGuideButton()).not.toHaveClass('is-active');
    expect(exposureGuideButton()).not.toHaveClass('is-active');

    fireEvent.click(dashboardGuideButton());
    expect(onNavigateProcess).toHaveBeenCalledWith('#/process/dashboard-guide');
    expect(onCloseProcess).not.toHaveBeenCalled();

    view.rerender(
      <PortfolioDashboard
        processDocumentId="dashboard-guide"
        onCloseProcess={onCloseProcess}
        onNavigateProcess={onNavigateProcess}
      />,
    );
    expect(getDockItem(undefined, 'Dashboard Guide')).toHaveClass('is-active');
    expect(getDockItem(undefined, 'Process')).not.toHaveClass('is-active');

    fireEvent.click(getDockItem(undefined, 'PCA Guide'));
    expect(onNavigateProcess).toHaveBeenLastCalledWith('#/process/exposure-lab');
    expect(onCloseProcess).not.toHaveBeenCalled();

    view.rerender(
      <PortfolioDashboard
        processDocumentId="exposure-lab-guide"
        onCloseProcess={onCloseProcess}
        onNavigateProcess={onNavigateProcess}
      />,
    );
    expect(getDockItem(undefined, 'PCA Guide')).toHaveClass('is-active');
    expect(getDockItem(undefined, 'Dashboard Guide')).not.toHaveClass('is-active');

    fireEvent.click(getDockItem(undefined, 'Process'));
    expect(onNavigateProcess).toHaveBeenLastCalledWith('#/process');
    expect(onCloseProcess).not.toHaveBeenCalled();
  });

  test('closes an active Dashboard Guide and restores focus to its navigation button', async () => {
    const onCloseProcess = jest.fn();
    const onNavigateProcess = jest.fn();
    const view = render(
      <PortfolioDashboard
        processDocumentId="dashboard-guide"
        onCloseProcess={onCloseProcess}
        onNavigateProcess={onNavigateProcess}
      />,
    );

    await screen.findByTestId('process-overlay');
    fireEvent.click(getDockItem(undefined, 'Dashboard Guide'));
    expect(onCloseProcess).toHaveBeenCalledTimes(1);

    view.rerender(
      <PortfolioDashboard
        processDocumentId={null}
        onCloseProcess={onCloseProcess}
        onNavigateProcess={onNavigateProcess}
      />,
    );
    await waitFor(() => expect(screen.getByRole('button', { name: 'Research', exact: true })).toHaveFocus());
  });

  test('closes an active PCA Guide and restores focus to its navigation button', async () => {
    const onCloseProcess = jest.fn();
    const onNavigateProcess = jest.fn();
    const view = render(
      <PortfolioDashboard
        processDocumentId="exposure-lab-guide"
        onCloseProcess={onCloseProcess}
        onNavigateProcess={onNavigateProcess}
      />,
    );

    await screen.findByTestId('process-overlay');
    fireEvent.click(getDockItem(undefined, 'PCA Guide'));
    expect(onCloseProcess).toHaveBeenCalledTimes(1);

    view.rerender(
      <PortfolioDashboard
        processDocumentId={null}
        onCloseProcess={onCloseProcess}
        onNavigateProcess={onNavigateProcess}
      />,
    );
    await waitFor(() => expect(screen.getByRole('button', { name: 'Research', exact: true })).toHaveFocus());
  });

  test('keeps the dashboard mounted and inert while Process is open, then restores the bottom navigation', async () => {
    const onCloseProcess = jest.fn();
    const { rerender } = render(
      <PortfolioDashboard
        processDocumentId="the-process"
        onCloseProcess={onCloseProcess}
        onNavigateProcess={jest.fn()}
      />,
    );

    expect(await screen.findByTestId('process-overlay')).toBeInTheDocument();
    expect(screen.getByText('USD Macro Dashboard')).toBeInTheDocument();
    expect(screen.getByTestId('dashboard-main-canvas')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByTestId('dashboard-main-canvas').inert).toBe(true);
    expect(getDockItem(undefined, 'Process')).toHaveClass('is-active');
    await waitFor(() => expect(screen.getByTestId('dashboard-shell')).toHaveStyle({
      '--dashboard-rail-visible-width': '0px',
    }));
    fireEvent.pointerDown(screen.getByTestId('process-overlay-backdrop'));
    fireEvent.click(screen.getByTestId('process-overlay-backdrop'));
    expect(onCloseProcess).toHaveBeenCalledTimes(1);

    rerender(
      <PortfolioDashboard
        processDocumentId={null}
        onCloseProcess={onCloseProcess}
        onNavigateProcess={jest.fn()}
      />,
    );

    await waitFor(() => expect(screen.getByTestId('process-overlay').closest('[data-surface-active]'))
      .toHaveAttribute('data-surface-active', 'false'));
    expect(screen.getByTestId('dashboard-main-canvas')).not.toHaveAttribute('aria-hidden');
    expect(screen.getByTestId('dashboard-main-canvas').inert).toBe(false);
    await waitFor(() => expect(screen.getByTestId('dashboard-shell')).toHaveStyle({
      '--dashboard-rail-visible-width': '0px',
    }));
    expect(screen.getByRole('button', { name: 'Research', exact: true })).toHaveFocus();
  });

  test('closes Process before another navigation control performs its normal action', async () => {
    const onCloseProcess = jest.fn();
    const { rerender } = render(
      <PortfolioDashboard
        processDocumentId="the-process"
        onCloseProcess={onCloseProcess}
        onNavigateProcess={jest.fn()}
      />,
    );
    await screen.findByTestId('process-overlay');

    const systemControl = screen.getByTitle('Systems');
    systemControl.focus();
    fireEvent.click(systemControl);

    expect(onCloseProcess).toHaveBeenCalledWith({ replace: true });
    expect(await screen.findByText('Systems Panel')).toBeInTheDocument();
    rerender(
      <PortfolioDashboard
        processDocumentId={null}
        onCloseProcess={onCloseProcess}
        onNavigateProcess={jest.fn()}
      />,
    );
    expect(screen.getByTestId('system-readiness-sheet')).toHaveFocus();
    const closeSystems = screen.getByRole('button', { name: 'Close Systems' });
    closeSystems.focus();
    fireEvent.click(closeSystems);
    expect(systemControl).toHaveFocus();
  });

  test.each([
    { input: 'pointer', selectionKey: null },
    { input: 'Enter', selectionKey: 'Enter' },
    { input: 'Space', selectionKey: ' ' },
  ])('opens GDP using $input while dismissing the Process reader', async ({ selectionKey }) => {
    const onCloseProcess = jest.fn();
    const onNavigateProcess = jest.fn();
    const view = render(
      <PortfolioDashboard
        processDocumentId="the-process"
        onCloseProcess={onCloseProcess}
        onNavigateProcess={onNavigateProcess}
      />,
    );
    expect(await screen.findByTestId('process-overlay')).toBeVisible();
    const navigation = screen.getByTestId('dashboard-top-navigation');
    const trigger = within(navigation).getByRole('button', { name: 'Prediction Markets', exact: true });
    if (selectionKey) {
      fireEvent.keyDown(trigger, { key: 'ArrowDown' });
      const menu = screen.getByRole('menu', { name: 'Prediction Markets' });
      fireEvent.keyDown(menu, { key: 'End' });
      const gdp = within(menu).getByRole('menuitemcheckbox', { name: 'GDP' });
      fireEvent.keyDown(gdp, { key: selectionKey });
    } else {
      fireEvent.click(getPredictionMarketItem(navigation, 'GDP'));
    }
    expect(onCloseProcess).toHaveBeenCalledTimes(1);
    expect(onCloseProcess).toHaveBeenCalledWith({ replace: true });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    view.rerender(
      <PortfolioDashboard
        processDocumentId={null}
        onCloseProcess={onCloseProcess}
        onNavigateProcess={onNavigateProcess}
      />,
    );
    expect(await screen.findByText('Active monitor: gdp')).toBeVisible();
    expect(screen.getByTestId('process-overlay').closest('[data-surface-active]'))
      .toHaveAttribute('data-surface-active', 'false');
    expect(screen.getByTestId('dashboard-main-canvas')).not.toHaveAttribute('aria-hidden');
  });

  test('opens the Process explainer and The Analyst that replaced the TL;DR reader', async () => {
    const onOpenWhitePaper = jest.fn();
    render(<PortfolioDashboard onOpenWhitePaper={onOpenWhitePaper} />);

    fireEvent.click(getDockItem(undefined, 'Process'));
    expect(onOpenWhitePaper).toHaveBeenCalledTimes(1);

    getDockItem(undefined, 'Process');
    expect(within(screen.getByRole('menu', { name: 'Research' }))
      .queryByRole('menuitem', { name: 'TL;DR' })).not.toBeInTheDocument();
    fireEvent.click(getDockItem(undefined, 'The Analyst'));
    expect(await screen.findByTestId('mock-analyst-panel')).toBeInTheDocument();
    expect(screen.queryByTestId('mock-morning-tldr')).not.toBeInTheDocument();
    expect(screen.queryByTitle('Open Notes')).not.toBeInTheDocument();
  });

  test('keeps the bottom dock while The Analyst is open', async () => {
    render(<PortfolioDashboard />);

    fireEvent.click(getDockItem(undefined, 'The Analyst'));
    expect(await screen.findByTestId('mock-analyst-panel')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('dashboard-shell')).toHaveStyle({
      '--dashboard-rail-visible-width': '0px',
    }));

    fireEvent.click(screen.getByRole('button', { name: 'Close The Analyst' }));
    await waitFor(() => expect(screen.getByTestId('dashboard-shell')).toHaveStyle({
      '--dashboard-rail-visible-width': '0px',
    }));
  });

  test('illuminates every open panel button in the bottom navigation', async () => {
    render(<PortfolioDashboard />);

    const navigation = await screen.findByTestId('dashboard-top-navigation');
    const portfolioButton = () => getDockItem(navigation, 'Portfolio');
    const bitcoinResearchButton = () => getDockItem(navigation, 'Bitcoin Research');

    fireEvent.click(portfolioButton());
    expect(await screen.findByText('Portfolio Breakdown')).toBeInTheDocument();
    expect(portfolioButton()).toHaveClass('is-active');

    fireEvent.click(bitcoinResearchButton());
    expect(await screen.findByText('Bitcoin historical entry study')).toBeInTheDocument();
    expect(portfolioButton()).toHaveClass('is-active');
    expect(bitcoinResearchButton()).toHaveClass('is-active');
  });

  test('keeps Portfolio and Prediction Markets open through Process visits until their menu selections close them', async () => {
    const onCloseProcess = jest.fn();
    const view = render(<PortfolioDashboard onCloseProcess={onCloseProcess} />);
    const navigation = screen.getByTestId('dashboard-top-navigation');
    const portfolioToggle = () => within(navigation).getByRole('button', { name: 'Portfolio', exact: true });
    const predictionToggle = () => within(navigation).getByRole('button', { name: 'Prediction Markets', exact: true });

    fireEvent.click(getDockItem(navigation, 'Portfolio'));
    expect(await screen.findByText('Portfolio Breakdown')).toBeVisible();
    fireEvent.click(getPredictionMarketItem(navigation, 'CPI'));
    expect(await screen.findByText('Active monitor: cpi')).toBeVisible();
    fireEvent.change(screen.getByLabelText('cpi monitor draft'), { target: { value: 'CPI working draft' } });

    view.rerender(<PortfolioDashboard processDocumentId="the-process" onCloseProcess={onCloseProcess} />);
    expect(await screen.findByTestId('process-overlay')).toBeVisible();
    expect(screen.getByTestId('dashboard-workspace-windows')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByTestId('dashboard-workspace-windows').inert).toBe(true);
    expect(screen.getByTestId('portfolio-breakdown-panel')).not.toBeVisible();
    expect(screen.getByTestId('prediction-market-resolver-test-panel')).not.toBeVisible();
    expect(portfolioToggle()).toHaveAttribute('aria-pressed', 'true');
    expect(predictionToggle()).toHaveAttribute('aria-pressed', 'true');
    expect(JSON.parse(window.localStorage.getItem('marketDashboard.panelState.v1'))).toMatchObject({
      showPortfolioBreakdown: true,
      showPredictionMonitor: true,
      sidebarPanelStack: ['portfolio', 'predictionMonitor'],
    });

    fireEvent.click(getDockItem(navigation, 'Process'));
    expect(onCloseProcess).toHaveBeenCalledTimes(1);
    view.rerender(<PortfolioDashboard onCloseProcess={onCloseProcess} />);
    expect(screen.getByTestId('portfolio-breakdown-panel')).toBeVisible();
    expect(screen.getByTestId('prediction-market-resolver-test-panel')).toBeVisible();
    expect(screen.getByDisplayValue('CPI working draft')).toBeVisible();

    fireEvent.click(portfolioToggle());
    expect(screen.getByRole('menu', { name: 'Portfolio' })).toBeVisible();
    expect(screen.getByTestId('portfolio-breakdown-panel')).toBeVisible();
    expect(portfolioToggle()).toHaveAttribute('aria-pressed', 'true');
    expect(portfolioToggle()).not.toHaveAttribute('data-navigation-item-id');
    fireEvent.click(getDockItem(navigation, 'Portfolio'));
    expect(screen.getByTestId('portfolio-breakdown-panel')).not.toBeVisible();
    expect(screen.getByTestId('prediction-market-resolver-test-panel')).toBeVisible();
    fireEvent.click(getPerpetualFuturesItem(navigation, 'Gold'));
    expect(await screen.findByText('Active monitor: gold')).toBeVisible();
    expect(predictionToggle()).toHaveTextContent(/^Prediction Markets$/);
    expect(predictionToggle()).toHaveAttribute('aria-pressed', 'false');
    const perpetualToggle = within(navigation).getByRole('button', { name: 'Perpetual Futures', exact: true });
    expect(perpetualToggle).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(getPerpetualFuturesItem(navigation, 'Gold'));
    expect(screen.getByTestId('prediction-market-resolver-test-panel')).not.toBeVisible();
    expect(perpetualToggle).toHaveAttribute('aria-pressed', 'false');
    expect(predictionToggle()).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(getPredictionMarketItem(navigation, 'CPI'));
    expect(screen.getByDisplayValue('CPI working draft')).toBeVisible();
    expect(screen.getByTestId('prediction-market-surface-gold')).not.toBeVisible();
    expect(predictionToggle()).toHaveTextContent(/^Prediction Markets$/);
  });

  test('opens the Prediction Markets menu without reopening the saved market or choosing CPI', async () => {
    window.localStorage.setItem('marketDashboard.panelState.v1', JSON.stringify({
      showPredictionMonitor: false,
      activePredictionMonitorMarket: 'gold',
    }));
    render(<PortfolioDashboard />);
    const toggle = within(screen.getByTestId('dashboard-top-navigation'))
      .getByRole('button', { name: 'Prediction Markets', exact: true });

    fireEvent.click(toggle);
    expect(screen.getByRole('menu', { name: 'Prediction Markets' })).toBeVisible();
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(toggle).not.toHaveAttribute('data-navigation-item-id');
    expect(toggle).toHaveTextContent(/^Prediction Markets$/);
    expect(screen.queryByText('Active monitor: cpi')).not.toBeInTheDocument();
    expect(screen.queryByText('Active monitor: gold')).not.toBeInTheDocument();
    fireEvent.click(getPredictionMarketItem(undefined, 'CPI'));
    expect(await screen.findByText('Active monitor: cpi')).toBeVisible();
  });

  test('opens grouped market menus without changing the active metal until a market is selected', async () => {
    render(<PortfolioDashboard />);
    const navigation = await screen.findByTestId('dashboard-top-navigation');
    const perpetualToggle = within(navigation).getByRole('button', { name: 'Perpetual Futures', exact: true });
    const predictionToggle = within(navigation).getByRole('button', { name: 'Prediction Markets', exact: true });

    fireEvent.click(getPerpetualFuturesItem(navigation, 'Silver'));
    expect(await screen.findByText('Active monitor: silver')).toBeVisible();
    expect(perpetualToggle).toHaveAttribute('aria-pressed', 'true');
    expect(perpetualToggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(perpetualToggle);
    expect(screen.getByRole('menu', { name: 'Perpetual Futures' })).toBeVisible();
    expect(screen.getByTestId('prediction-market-surface-silver')).toBeVisible();
    expect(perpetualToggle).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(perpetualToggle);
    expect(screen.queryByRole('menu', { name: 'Perpetual Futures' })).not.toBeInTheDocument();
    expect(screen.getByTestId('prediction-market-surface-silver')).toBeVisible();
    expect(perpetualToggle).toHaveAttribute('aria-pressed', 'true');
    expect(predictionToggle).toHaveAttribute('aria-pressed', 'false');
    expect(perpetualToggle).toHaveAttribute('aria-expanded', 'false');
    expect(perpetualToggle).toHaveTextContent(/^Perpetual Futures$/);
    expect(perpetualToggle).not.toHaveAttribute('data-navigation-item-id');

    fireEvent.click(predictionToggle);
    expect(screen.getByRole('menu', { name: 'Prediction Markets' })).toBeVisible();
    expect(screen.getByTestId('prediction-market-surface-silver')).toBeVisible();
    expect(predictionToggle).toHaveAttribute('aria-pressed', 'false');
    expect(perpetualToggle).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(getPredictionMarketItem(navigation, 'CPI'));
    expect(await screen.findByText('Active monitor: cpi')).toBeVisible();
    expect(predictionToggle).toHaveAttribute('aria-pressed', 'true');
    expect(perpetualToggle).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('prediction-market-surface-silver')).not.toBeVisible();
  });

  test('uses the Research label for its menu and preserves the reader until Bitcoin Research is selected', async () => {
    render(<PortfolioDashboard />);
    const navigation = screen.getByTestId('dashboard-top-navigation');
    const researchToggle = within(navigation).getByRole('button', { name: 'Research', exact: true });

    fireEvent.click(researchToggle);
    expect(screen.getByRole('menu', { name: 'Research' })).toBeVisible();
    expect(screen.queryByText('Bitcoin historical entry study')).not.toBeInTheDocument();
    expect(researchToggle).toHaveAttribute('aria-pressed', 'false');
    expect(researchToggle).not.toHaveAttribute('data-navigation-item-id');
    fireEvent.click(getDockItem(navigation, 'Bitcoin Research'));
    expect(await screen.findByText('Bitcoin historical entry study')).toBeVisible();
    expect(researchToggle).toHaveAttribute('aria-pressed', 'true');
    expect(researchToggle).toHaveTextContent(/^Research$/);
    expect(screen.queryByRole('menu', { name: 'Research' })).not.toBeInTheDocument();

    fireEvent.click(researchToggle);
    expect(screen.getByRole('menu', { name: 'Research' })).toBeVisible();
    expect(screen.getByText('Bitcoin historical entry study')).toBeVisible();
    fireEvent.click(researchToggle);
    expect(screen.queryByRole('menu', { name: 'Research' })).not.toBeInTheDocument();
    expect(screen.getByText('Bitcoin historical entry study')).toBeVisible();

    fireEvent.click(getDockItem(navigation, 'Bitcoin Research'));
    expect(screen.getByText('Bitcoin historical entry study')).not.toBeVisible();
    expect(researchToggle).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(getDockItem(navigation, 'Bitcoin Research'));
    expect(screen.getByText('Bitcoin historical entry study')).toBeVisible();
  });

  test('keeps Process open when grouped dock labels only open their menus', async () => {
    const onCloseProcess = jest.fn();
    render(<PortfolioDashboard processDocumentId="the-process" onCloseProcess={onCloseProcess} />);
    const process = await screen.findByTestId('process-overlay');
    const navigation = screen.getByTestId('dashboard-top-navigation');

    for (const label of ['Research', 'Portfolio', 'Prediction Markets', 'Perpetual Futures']) {
      const trigger = within(navigation).getByRole('button', { name: label, exact: true });
      fireEvent.click(trigger);
      expect(screen.getByRole('menu', { name: label })).toBeVisible();
      expect(trigger).toHaveAttribute('aria-expanded', 'true');
      expect(trigger).not.toHaveAttribute('data-navigation-item-id');
      expect(process).toBeVisible();
      expect(onCloseProcess).not.toHaveBeenCalled();
    }
    expect(screen.queryByText('Portfolio Breakdown')).not.toBeInTheDocument();
    expect(screen.queryByText(/^Active monitor:/)).not.toBeInTheDocument();
    expect(screen.queryByTestId('mock-morning-tldr')).not.toBeInTheDocument();
  });

  test.each(['dashboard-guide', 'exposure-lab-guide'])('preserves open windows while reading %s', async (processDocumentId) => {
    window.localStorage.setItem('marketDashboard.panelState.v1', JSON.stringify({
      showPortfolioBreakdown: true,
      showPredictionMonitor: true,
      activePredictionMonitorMarket: 'gold',
      sidebarPanelStack: ['portfolio', 'predictionMonitor'],
    }));
    const view = render(<PortfolioDashboard />);
    expect(await screen.findByText('Active monitor: gold')).toBeVisible();

    view.rerender(<PortfolioDashboard processDocumentId={processDocumentId} />);
    expect(await screen.findByTestId('process-overlay')).toBeVisible();
    expect(screen.getByTestId('dashboard-workspace-windows').inert).toBe(true);
    view.rerender(<PortfolioDashboard />);

    expect(screen.getByTestId('portfolio-breakdown-panel')).toBeVisible();
    expect(screen.getByTestId('prediction-market-resolver-test-panel')).toBeVisible();
    expect(screen.getByText('Active monitor: gold')).toBeVisible();
  });

  test.each(['Balance', 'Contract P&L'])('opens %s from its menu while leaving Process', async (label) => {
    const onCloseProcess = jest.fn();
    const view = render(<PortfolioDashboard processDocumentId="the-process" onCloseProcess={onCloseProcess} />);
    expect(await screen.findByTestId('process-overlay')).toBeVisible();
    fireEvent.click(getDockItem(undefined, label));
    expect(onCloseProcess).toHaveBeenCalledWith({ replace: true });
    view.rerender(<PortfolioDashboard onCloseProcess={onCloseProcess} />);
    expect(await screen.findByRole('dialog', { name: label, exact: true })).toBeVisible();
  });

  test('keeps the dashboard as the default background while closing windows individually and retaining monitor state', async () => {
    render(<PortfolioDashboard />);
    const navigation = await screen.findByTestId('dashboard-top-navigation');
    const dashboardCanvas = screen.getByTestId('dashboard-main-canvas');
    expect(within(navigation).queryByRole('button', { name: 'Dashboard', exact: true })).not.toBeInTheDocument();
    expect(within(dashboardCanvas).getByText('USD Macro Dashboard')).toBeVisible();
    fireEvent.click(getPredictionMarketItem(navigation, 'CPI'));
    expect(await screen.findByText('Active monitor: cpi')).toBeVisible();
    const monitorPanel = screen.getByTestId('prediction-market-resolver-test-panel');
    const monitorDraft = screen.getByLabelText('cpi monitor draft');
    monitorPanel.scrollTop = 120;
    expectCenteredWorkspaceWindow(monitorPanel);
    fireEvent.change(monitorDraft, {
      target: { value: 'retain CPI state' },
    });
    fireEvent.click(getDockItem(navigation, 'Portfolio'));
    expect(await screen.findByText('Portfolio Breakdown')).toBeVisible();
    fireEvent.click(getDockItem(navigation, 'Balance'));
    expect(await screen.findByRole('dialog', { name: 'Balance' })).toBeVisible();

    expect(dashboardCanvas).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Close Balance' }));
    expect(screen.getByTestId('portfolio-balance-planner-slot')).not.toBeVisible();
    expect(screen.getByTestId('portfolio-breakdown-panel')).toBeVisible();
    expect(screen.getByTestId('prediction-market-resolver-test-panel')).toBeVisible();
    fireEvent.click(getDockItem(navigation, 'Portfolio'));
    expect(screen.getByTestId('portfolio-breakdown-panel')).not.toBeVisible();
    expect(screen.getByTestId('prediction-market-resolver-test-panel')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Close Prediction Monitor' }));
    await waitFor(() => {
      expect(screen.getByTestId('prediction-market-resolver-test-panel')).not.toBeVisible();
      expect(screen.getByTestId('portfolio-breakdown-panel')).not.toBeVisible();
      expect(screen.getByTestId('portfolio-balance-planner-slot')).not.toBeVisible();
    });
    expect(screen.getByTestId('dashboard-main-canvas')).toBe(dashboardCanvas);
    expect(dashboardCanvas).toBeVisible();
    fireEvent.click(getPredictionMarketItem(navigation, 'CPI'));
    expect(await screen.findByDisplayValue('retain CPI state')).toBeVisible();
    expect(screen.getByLabelText('cpi monitor draft')).toBe(monitorDraft);
    expect(screen.getByTestId('prediction-market-resolver-test-panel')).toBe(monitorPanel);
    expect(monitorPanel.scrollTop).toBe(120);
  });

  test('discards persisted state for every retired Prediction Markets hub alias', async () => {
    window.localStorage.setItem('marketDashboard.panelState.v1', JSON.stringify({
      showPredictionMarkets: true,
      showPredictionMarketsHub: true,
      showCpiModel: true,
      showPredictionMarketsSandbox: true,
      activePredictionMarket: 'spx',
      activeWtiCadence: 'weekly',
      showSystemReadiness: true,
      showEtfPro: true,
      sidebarPanelStack: ['system', 'predMkts', 'cpi', 'predictionMarkets', 'etfPro'],
    }));

    render(<PortfolioDashboard />);

    const navigation = await screen.findByTestId('dashboard-top-navigation');
    expect(within(navigation).getByRole('button', { name: 'Prediction Markets', exact: true }))
      .toHaveAttribute('aria-haspopup', 'menu');
    expect(screen.queryByTestId('prediction-markets-panel')).not.toBeInTheDocument();
    await waitFor(() => expect(JSON.parse(
      window.localStorage.getItem('marketDashboard.panelState.v1'),
    ).sidebarPanelStack).toEqual(['system', 'etfPro']));
    const stored = JSON.parse(window.localStorage.getItem('marketDashboard.panelState.v1'));
    expect(stored.showPredictionMarkets).toBeUndefined();
    expect(stored.showPredictionMarketsHub).toBeUndefined();
    expect(stored.showCpiModel).toBeUndefined();
    expect(stored.showPredictionMarketsSandbox).toBeUndefined();
    expect(stored.activePredictionMarket).toBeUndefined();
    expect(stored.activeWtiCadence).toBeUndefined();
  });

  test('removes the left product rail and hides the legacy reference buttons', async () => {
    render(<PortfolioDashboard />);

    expect(screen.queryByText('Securities List')).not.toBeInTheDocument();
    expect(screen.queryByText('Sectors Compact Rail')).not.toBeInTheDocument();

    const navigation = await screen.findByTestId('dashboard-top-navigation');
    ['Signal Strength', 'ETF Pro', 'Macro Show', 'Call']
      .forEach((label) => expect(within(navigation).queryByRole('button', { name: label })).not.toBeInTheDocument());
  });

  test('keeps one persistent monitor instance per visited market', async () => {
    render(<PortfolioDashboard />);

    const navigation = await screen.findByTestId('dashboard-top-navigation');
    fireEvent.click(getPredictionMarketItem(navigation, 'SP500'));

    expect(await screen.findByText('Active monitor: sp500')).toBeInTheDocument();
    const resolverTestPanel = screen.getByTestId('prediction-market-resolver-test-panel');
    expect(resolverTestPanel).toBeVisible();
    expect(resolverTestPanel).toHaveClass('dashboard-side-panel--resolver-test');
    expect(resolverTestPanel.style.width).toBe('');
    expect(screen.queryByText('Prediction Markets Hub')).not.toBeInTheDocument();
    expect(getPredictionMarketItem(navigation, 'SP500')).toHaveClass('is-active');
    expect(getPredictionMarketItem(navigation, 'WTI')).not.toHaveClass('is-active');
    fireEvent.change(screen.getByLabelText('sp500 monitor draft'), {
      target: { value: 'retain SP500 state' },
    });

    fireEvent.click(getPredictionMarketItem(navigation, 'WTI'));
    expect(await screen.findByText('Active monitor: wti')).toBeInTheDocument();
    expect(screen.getAllByText('Prediction Monitor')).toHaveLength(2);
    expect(screen.getByTestId('prediction-market-surface-sp500')).not.toBeVisible();
    expect(screen.getByTestId('prediction-market-surface-wti')).toBeVisible();
    expect(resolverTestPanel).toBeVisible();
    expect(getPredictionMarketItem(navigation, 'WTI')).toHaveClass('is-active');
    expect(getPredictionMarketItem(navigation, 'SP500')).not.toHaveClass('is-active');

    fireEvent.click(getPredictionMarketItem(navigation, 'Brent'));
    expect(await screen.findByText('Active monitor: brent')).toBeInTheDocument();
    expect(screen.getAllByText('Prediction Monitor')).toHaveLength(3);
    expect(getPredictionMarketItem(navigation, 'Brent')).toHaveClass('is-active');
    expect(getPredictionMarketItem(navigation, 'WTI')).not.toHaveClass('is-active');

    fireEvent.click(getPredictionMarketItem(navigation, 'SP500'));
    expect(await screen.findByDisplayValue('retain SP500 state')).toBeVisible();
    expect(screen.getByTestId('prediction-market-surface-sp500')).toBeVisible();
    expect(screen.getByTestId('prediction-market-surface-wti')).not.toBeVisible();

    fireEvent.click(getPredictionMarketItem(navigation, 'SP500'));
    await waitFor(() => expect(resolverTestPanel).not.toBeVisible());
  });

  test('closes from the shared monitor control and persists the selected market across reloads', async () => {
    const view = render(<PortfolioDashboard />);
    let navigation = await screen.findByTestId('dashboard-top-navigation');
    fireEvent.click(getPerpetualFuturesItem(navigation, 'Gold'));

    expect(await screen.findByText('Active monitor: gold')).toBeInTheDocument();
    await waitFor(() => expect(JSON.parse(
      window.localStorage.getItem('marketDashboard.panelState.v1'),
    )).toMatchObject({
      showPredictionMonitor: true,
      activePredictionMonitorMarket: 'gold',
      sidebarPanelStack: expect.arrayContaining(['predictionMonitor']),
    }));

    view.unmount();
    render(<PortfolioDashboard />);
    navigation = await screen.findByTestId('dashboard-top-navigation');
    expect(await screen.findByText('Active monitor: gold')).toBeInTheDocument();
    expect(getPerpetualFuturesItem(navigation, 'Gold')).toHaveClass('is-active');

    fireEvent.click(screen.getByRole('button', { name: 'Close Prediction Monitor' }));
    await waitFor(() => expect(screen.getByTestId('prediction-market-resolver-test-panel')).not.toBeVisible());
  });

  test('migrates the legacy Test monitor to an open SP500 monitor', async () => {
    window.localStorage.setItem('marketDashboard.panelState.v1', JSON.stringify({
      showResolverTest: true,
      sidebarPanelStack: ['portfolio', 'resolverTest'],
    }));

    render(<PortfolioDashboard />);

    expect(await screen.findByText('Active monitor: sp500')).toBeInTheDocument();
    await waitFor(() => expect(JSON.parse(
      window.localStorage.getItem('marketDashboard.panelState.v1'),
    )).toMatchObject({
      showPredictionMonitor: true,
      activePredictionMonitorMarket: 'sp500',
      sidebarPanelStack: ['portfolio', 'predictionMonitor'],
    }));
    const stored = JSON.parse(window.localStorage.getItem('marketDashboard.panelState.v1'));
    expect(stored.showResolverTest).toBeUndefined();
    expect(stored.sidebarPanelStack).not.toContain('resolverTest');
  });
});
