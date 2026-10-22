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



  test.each([
    ['Balance', 'portfolio-balance-planner-slot'],
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

  test.each(['Balance', ])('opens %s from its menu while leaving Process', async (label) => {
    const onCloseProcess = jest.fn();
    const view = render(<PortfolioDashboard processDocumentId="the-process" onCloseProcess={onCloseProcess} />);
    expect(await screen.findByTestId('process-overlay')).toBeVisible();
    fireEvent.click(getDockItem(undefined, label));
    expect(onCloseProcess).toHaveBeenCalledWith({ replace: true });
    view.rerender(<PortfolioDashboard onCloseProcess={onCloseProcess} />);
    expect(await screen.findByRole('dialog', { name: label, exact: true })).toBeVisible();
  });



  test('removes the left product rail and hides the legacy reference buttons', async () => {
    render(<PortfolioDashboard />);

    expect(screen.queryByText('Securities List')).not.toBeInTheDocument();
    expect(screen.queryByText('Sectors Compact Rail')).not.toBeInTheDocument();

    const navigation = await screen.findByTestId('dashboard-top-navigation');
    ['Signal Strength', 'ETF Pro', 'Macro Show', 'Call']
      .forEach((label) => expect(within(navigation).queryByRole('button', { name: label })).not.toBeInTheDocument());
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
