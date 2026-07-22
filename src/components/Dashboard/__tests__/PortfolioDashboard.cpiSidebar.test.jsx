import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import PortfolioDashboard from '../PortfolioDashboard';
import { MarketDataService } from '../../../services/api/marketDataService';

jest.mock('../../../services/api/marketDataService', () => ({
  MarketDataService: {
    getMultiRegionQuotes: jest.fn(),
    getPortfolio: jest.fn(),
    getPortfolioAccounts: jest.fn(),
    getPortfolioExposureReconciliation: jest.fn(),
    getRealTimeAlertPositions: jest.fn(),
    getHedgeyeEtfPro: jest.fn(),
    getHedgeyeChangelog: jest.fn(),
    getHedgeyeSnapshot: jest.fn(),
    getProviderStatus: jest.fn(),
  },
}));

jest.mock('../../../services/api/predictionMarketsIngestService', () => ({
  __esModule: true,
  default: { getProviderStatus: jest.fn().mockResolvedValue({}) },
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
const mockPortfolioSidebarSnapshot = jest.fn();
jest.mock('../USDMacroDashboard', () => (props) => {
  mockUsdMacroDashboard(props);
  return <div>USD Macro Dashboard</div>;
});
jest.mock('../portfolio/PortfolioSidebarSnapshot', () => (props) => {
  mockPortfolioSidebarSnapshot(props);
  return <div>Portfolio Sidebar Snapshot</div>;
});
jest.mock('../WorkflowStatus', () => () => <div>Workflow Status</div>);
jest.mock('../SystemReadinessPanel', () => ({ onClose }) => (
  <div>
    System Readiness Panel
    <button type="button" onClick={onClose}>Close System Readiness</button>
  </div>
));
jest.mock('../SecuritiesUniverse', () => () => <div>Securities Universe</div>);
jest.mock('../PerformanceTracking', () => () => <div>Performance Tracking</div>);
jest.mock('../PortfolioBreakdown', () => () => <div>Portfolio Breakdown</div>);
jest.mock('../ExpectedValuesWindow', () => () => <div>Expected Values</div>);
const mockPredictionMarketsHub = jest.fn();
jest.mock('../PredictionMarketsHub', () => (props) => {
  mockPredictionMarketsHub(props);
  return (
    <div>
      <div>Prediction Markets Hub</div>
      <div>Active market: {props.activeMarket}</div>
      <button type="button" onClick={() => props.onActiveMarketChange('wti')}>Select WTI</button>
      <button type="button" onClick={() => props.onActiveMarketChange('spx')}>Select SPX</button>
      <button type="button" onClick={() => props.onActiveMarketChange('cpi')}>Select CPI</button>
      <button type="button" onClick={props.onClose}>Close Prediction Markets</button>
    </div>
  );
});
jest.mock('../SignalStrengthPanel', () => ({ onClose }) => <div>SS Reference Panel<button onClick={onClose}>Close SS</button></div>);
jest.mock('../EtfProPanel', () => ({ onClose }) => <div>ETF Pro Reference Panel<button onClick={onClose}>Close ETF Pro</button></div>);
jest.mock('../HedgeyeShowPanel', () => ({ title, onClose }) => <div>{title} Reference Panel<button onClick={onClose}>Close {title}</button></div>);
jest.mock('react-markdown', () => () => <div>Markdown</div>);

const originalDocumentHidden = Object.getOwnPropertyDescriptor(document, 'hidden');

function seedDashboardApis() {
  MarketDataService.getMultiRegionQuotes.mockResolvedValue({
    currencies: [],
    sectors: [],
    commodities: [],
    rates: [],
    crypto: [],
    global: [],
  });
  MarketDataService.getPortfolio.mockResolvedValue({
    accountSummary: { netLiquidation: 100000, totalCashValue: 5000, currency: 'USD' },
    summary: { totalValue: 100000 },
    holdings: [],
  });
  MarketDataService.getPortfolioAccounts.mockResolvedValue([]);
  MarketDataService.getPortfolioExposureReconciliation.mockResolvedValue({ status: 'unavailable' });
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
}

describe('PortfolioDashboard prediction-markets sidebar', () => {
  beforeEach(() => {
    seedDashboardApis();
    window.localStorage.clear();
  });

  afterEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
    window.localStorage.clear();
    if (originalDocumentHidden) {
      Object.defineProperty(document, 'hidden', originalDocumentHidden);
    } else {
      delete document.hidden;
    }
  });

  test('pauses only reference polls while hidden and refreshes them once when visible', async () => {
    jest.useFakeTimers();
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
    MarketDataService.getRealTimeAlertPositions.mockClear();
    MarketDataService.getHedgeyeEtfPro.mockClear();
    MarketDataService.getHedgeyeChangelog.mockClear();

    hidden = true;
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      jest.advanceTimersByTime(5 * 60 * 1000);
      await Promise.resolve();
    });

    expect(MarketDataService.getPortfolio).toHaveBeenCalled();
    expect(MarketDataService.getRealTimeAlertPositions).not.toHaveBeenCalled();
    expect(MarketDataService.getHedgeyeEtfPro).not.toHaveBeenCalled();
    expect(MarketDataService.getHedgeyeChangelog).not.toHaveBeenCalled();

    hidden = false;
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(MarketDataService.getRealTimeAlertPositions).toHaveBeenCalledTimes(1);
    expect(MarketDataService.getHedgeyeEtfPro).toHaveBeenCalledTimes(1);
    expect(MarketDataService.getHedgeyeChangelog).toHaveBeenCalledTimes(1);

    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await Promise.resolve();
    });
    expect(MarketDataService.getRealTimeAlertPositions).toHaveBeenCalledTimes(1);

    await act(async () => {
      jest.advanceTimersByTime(5 * 60 * 1000);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(MarketDataService.getRealTimeAlertPositions).toHaveBeenCalledTimes(2);
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

  test('invalidates sidebar comparisons after refresh failures while retaining dated ETF Pro rows', async () => {
    window.localStorage.setItem('marketDashboard.panelState.v1', JSON.stringify({
      showPortfolioMetrics: true,
    }));
    const etfRows = [
      { ticker: 'GLD', call: 'Long' },
      { ticker: 'SQQQ', call: 'Short' },
    ];
    MarketDataService.getRealTimeAlertPositions
      .mockResolvedValueOnce({
        available: true,
        longCount: 3,
        shortCount: 2,
        dataQuality: { status: 'ok', warnings: [] },
      })
      .mockRejectedValueOnce(new Error('RTA refresh offline'));
    MarketDataService.getHedgeyeEtfPro
      .mockResolvedValueOnce({
        available: true,
        longCount: 1,
        shortCount: 1,
        rows: etfRows,
        dataQuality: { status: 'ok', warnings: [] },
      })
      .mockRejectedValueOnce(new Error('ETF Pro refresh offline'));

    render(<PortfolioDashboard />);

    await act(async () => {
      window.dispatchEvent(new Event('portfolioRefresh'));
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => expect(mockPortfolioSidebarSnapshot).toHaveBeenLastCalledWith(
      expect.objectContaining({
        rtaPositions: expect.objectContaining({
          available: true,
          comparisonAvailable: true,
          longCount: 3,
          shortCount: 2,
        }),
        etfProSnapshot: expect.objectContaining({
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

    await waitFor(() => expect(mockPortfolioSidebarSnapshot).toHaveBeenLastCalledWith(
      expect.objectContaining({
        rtaPositions: expect.objectContaining({
          available: false,
          comparisonAvailable: false,
          dataQuality: expect.objectContaining({ status: 'error' }),
        }),
        etfProSnapshot: expect.objectContaining({
          available: false,
          comparisonAvailable: false,
          rows: etfRows,
          dataQuality: expect.objectContaining({ status: 'error' }),
        }),
      })
    ));
  });

  test('marks stale cached sidebar responses unavailable for comparison', async () => {
    window.localStorage.setItem('marketDashboard.panelState.v1', JSON.stringify({
      showPortfolioMetrics: true,
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
    await act(async () => {
      window.dispatchEvent(new Event('portfolioRefresh'));
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => expect(mockPortfolioSidebarSnapshot).toHaveBeenLastCalledWith(
      expect.objectContaining({
        rtaPositions: expect.objectContaining({
          available: true,
          comparisonAvailable: false,
          dataQuality: expect.objectContaining({ status: 'warning' }),
        }),
        etfProSnapshot: expect.objectContaining({
          available: true,
          comparisonAvailable: false,
          dataQuality: expect.objectContaining({ status: 'warning' }),
        }),
      })
    ));
  });

  test('clears current market rows when a quote refresh fails', async () => {
    jest.useFakeTimers();
    const currentPayload = {
      us: [{ symbol: 'SPX', price: '7515.34', availability: 'delayed' }],
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

    expect(mockUsdMacroDashboard).toHaveBeenLastCalledWith(
      expect.objectContaining({
        multiRegionMarketData: {},
        multiRegionError: 'quote provider offline',
      })
    );
  });

  test('renders one Prediction Markets button, opens Overview, persists one panel key, and resets on close', async () => {
    render(<PortfolioDashboard />);

    const predictionMarketsButton = await screen.findByRole('button', { name: 'Prediction Markets' });
    expect(predictionMarketsButton).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'SPX Close' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'CPI' })).not.toBeInTheDocument();

    fireEvent.click(predictionMarketsButton);

    expect(await screen.findByText('Prediction Markets Hub')).toBeInTheDocument();
    expect(screen.getByText('Active market: overview')).toBeInTheDocument();

    await waitFor(() => expect(JSON.parse(window.localStorage.getItem('marketDashboard.panelState.v1')).showPredictionMarketsHub).toBe(true));
    const stored = JSON.parse(window.localStorage.getItem('marketDashboard.panelState.v1'));
    expect(stored.sidebarPanelStack).toContain('predictionMarkets');
    expect(stored.sidebarPanelStack).not.toContain('cpi');
    expect(stored.sidebarPanelStack).not.toContain('predMkts');
    expect(stored.showCpiModel).toBeUndefined();
    expect(stored.showPredictionMarketsSandbox).toBeUndefined();
    expect(stored.showPredictionMarkets).toBeUndefined();
    fireEvent.click(screen.getByRole('button', { name: 'Select CPI' }));
    expect(screen.getByText('Active market: cpi')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close Prediction Markets' }));
    expect(screen.queryByText('Prediction Markets Hub')).not.toBeInTheDocument();

    await waitFor(() => expect(JSON.parse(window.localStorage.getItem('marketDashboard.panelState.v1')).showPredictionMarketsHub).toBe(false));
    const closed = JSON.parse(window.localStorage.getItem('marketDashboard.panelState.v1'));
    expect(closed.activePredictionMarket).toBe('overview');

    fireEvent.click(predictionMarketsButton);
    expect(await screen.findByText('Active market: overview')).toBeInTheDocument();
  });

  test('preserves the active workbench when reloading an already-open hub', async () => {
    window.localStorage.setItem('marketDashboard.panelState.v1', JSON.stringify({
      showPredictionMarketsHub: true,
      activePredictionMarket: 'spx',
      activeWtiCadence: 'weekly',
      sidebarPanelStack: ['predictionMarkets'],
    }));

    render(<PortfolioDashboard />);

    expect(await screen.findByText('Active market: spx')).toBeInTheDocument();
    expect(mockPredictionMarketsHub).toHaveBeenLastCalledWith(expect.objectContaining({
      activeMarket: 'spx',
      activeWtiCadence: 'weekly',
    }));
  });

  test('uses the enlarged right-rail dimensions and scaled controls', async () => {
    render(<PortfolioDashboard />);

    const shell = screen.getByTestId('dashboard-shell');
    const podsButton = await screen.findByRole('button', { name: 'PODS' });

    expect(shell).toHaveStyle({
      '--dashboard-rail-collapsed-width': '76px',
      '--dashboard-rail-control-width': '56px',
      '--dashboard-rail-control-height': '44px',
      '--dashboard-rail-icon-size': '26px',
    });
    expect(podsButton).toHaveStyle({ minWidth: '56px', height: 'var(--dashboard-rail-control-height)' });
    expect(podsButton).toHaveClass('rounded-lg');
    expect(screen.queryByTitle('Switch to Dark Mode')).not.toBeInTheDocument();
  });

  test('uses text labels for named rail controls and retains icon-only utility controls', async () => {
    render(<PortfolioDashboard />);

    const navigation = await screen.findByTestId('dashboard-rail-navigation');
    ['PODS', '+EV', 'NOTES', 'PORTFOLIO', 'SECURITIES', 'PRED', 'MKTS', 'ETF Pro', 'Call']
      .forEach((label) => expect(screen.getByText(label)).toBeInTheDocument());
    const processButton = within(navigation).getByRole('button', { name: 'The Process' });
    expect(processButton).toHaveTextContent('THE/PROCESS');
    expect(within(navigation).getByRole('button', { name: 'Prediction Markets' })).toBeInTheDocument();
    expect(within(navigation).queryByRole('button', { name: 'SPX Close' })).not.toBeInTheDocument();
    expect(navigation).toHaveTextContent('SignalStrength');
    expect(navigation).toHaveTextContent('MacroShow');
    expect(screen.queryByTitle('Performance Tracking')).not.toBeInTheDocument();
    expect(within(navigation).queryAllByRole('img')).toHaveLength(0);
    expect(screen.getByText('ANALYTICS')).toBeInTheDocument();
    expect(within(navigation).getByTitle('System Readiness')).toBeInTheDocument();
    expect(screen.getByTitle('Open X (Twitter) List')).toBeInTheDocument();
  });

  test('fits every shortcut in the expanded rail and hides the expanded Analytics footer', async () => {
    render(<PortfolioDashboard />);

    fireEvent.click(await screen.findByTitle('Expand Portfolio'));

    const shell = screen.getByTestId('dashboard-shell');
    const navigation = screen.getByTestId('dashboard-rail-navigation');
    expect(shell).toHaveStyle({ '--dashboard-rail-control-height': '30px' });
    expect(navigation).toHaveStyle({
      flex: '0 0 auto',
      maxHeight: 'none',
      overflowY: 'hidden',
    });
    expect(within(navigation).getByTitle('Signal Strength')).toBeInTheDocument();
    expect(within(navigation).getByTitle('ETF Pro')).toBeInTheDocument();
    expect(within(navigation).getByTitle('Macro Show')).toBeInTheDocument();
    expect(within(navigation).getByTitle('Call')).toBeInTheDocument();
    expect(within(navigation).getByTitle('System Readiness')).toBeInTheDocument();
    expect(within(navigation).getByRole('button', { name: 'The Process' })).toHaveTextContent('THE PROCESS');
    expect(screen.queryByTitle('Analytics')).not.toBeInTheDocument();
  });

  test('opens and persists the permanent System Readiness panel', async () => {
    render(<PortfolioDashboard />);

    const systemButton = await screen.findByTitle('System Readiness');
    expect(systemButton).toHaveAttribute('data-readiness-status', 'checking');
    fireEvent.click(systemButton);

    expect(await screen.findByText('System Readiness Panel')).toBeInTheDocument();
    await waitFor(() => expect(JSON.parse(window.localStorage.getItem('marketDashboard.panelState.v1')).showSystemReadiness).toBe(true));
    const stored = JSON.parse(window.localStorage.getItem('marketDashboard.panelState.v1'));
    expect(stored.sidebarPanelStack).toContain('system');

    fireEvent.click(screen.getByRole('button', { name: 'Close System Readiness' }));
    expect(screen.getByTestId('system-readiness-sheet')).toHaveStyle({ display: 'none' });
  });

  test('places The Process directly after Notes and delegates navigation', async () => {
    const onOpenProcess = jest.fn();
    render(<PortfolioDashboard onOpenProcess={onOpenProcess} />);

    const notesButton = await screen.findByTitle('Open Notes');
    const processButton = screen.getByRole('button', { name: 'The Process' });
    const navigation = screen.getByTestId('dashboard-rail-navigation');
    const buttons = within(navigation).getAllByRole('button');

    expect(buttons[buttons.indexOf(notesButton) + 1]).toBe(processButton);
    fireEvent.click(processButton);
    expect(onOpenProcess).toHaveBeenCalledTimes(1);
  });

  test('retains the legacy process callback and clearly labels the source notes', async () => {
    const onOpenWhitePaper = jest.fn();
    render(<PortfolioDashboard onOpenWhitePaper={onOpenWhitePaper} />);

    fireEvent.click(await screen.findByRole('button', { name: 'The Process' }));
    expect(onOpenWhitePaper).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTitle('Open Notes'));
    const legacyNotes = await screen.findByRole('button', { name: 'Process Source Notes — Legacy' });
    expect(screen.getByRole('button', { name: 'The Coach — Source Notes' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'The Playbook — Legacy' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Stop Losses — Legacy' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'The Process' })).toBeInTheDocument();
    fireEvent.click(legacyNotes);

    expect(await screen.findByText('Process Source Notes — Legacy')).toBeInTheDocument();
    expect(await screen.findByText('Markdown')).toBeInTheDocument();
  });

  test('migrates the oldest predictionMarkets state to the unified hub on CPI', async () => {
    window.localStorage.setItem('marketDashboard.panelState.v1', JSON.stringify({
      showPredictionMarkets: true,
      sidebarPanelStack: ['predictionMarkets'],
    }));

    render(<PortfolioDashboard />);

    expect(await screen.findByText('Active market: cpi')).toBeInTheDocument();

    await waitFor(() => expect(JSON.parse(window.localStorage.getItem('marketDashboard.panelState.v1')).showPredictionMarketsHub).toBe(true));
    const stored = JSON.parse(window.localStorage.getItem('marketDashboard.panelState.v1'));
    expect(stored.sidebarPanelStack).toEqual(expect.arrayContaining(['predictionMarkets']));
    expect(stored.sidebarPanelStack).not.toContain('cpi');
    expect(stored.showPredictionMarkets).toBeUndefined();
  });

  test('collapses visible legacy CPI and SPX aliases at the last applicable stack position', async () => {
    window.localStorage.setItem('marketDashboard.panelState.v1', JSON.stringify({
      showCpiModel: true,
      showPredictionMarketsSandbox: true,
      showEtfPro: true,
      sidebarPanelStack: ['system', 'predMkts', 'cpi', 'etfPro'],
    }));

    render(<PortfolioDashboard />);

    expect(await screen.findByText('Active market: cpi')).toBeInTheDocument();
    await waitFor(() => expect(JSON.parse(window.localStorage.getItem('marketDashboard.panelState.v1')).sidebarPanelStack).toEqual(['system', 'predictionMarkets', 'etfPro']));
    const stored = JSON.parse(window.localStorage.getItem('marketDashboard.panelState.v1'));
    expect(stored.showCpiModel).toBeUndefined();
    expect(stored.showPredictionMarketsSandbox).toBeUndefined();
  });

  test('uses SPX when both legacy panels were visible without stack evidence and ignores false aliases', async () => {
    window.localStorage.setItem('marketDashboard.panelState.v1', JSON.stringify({
      showCpiModel: true,
      showPredictionMarketsSandbox: true,
      sidebarPanelStack: ['cpi', 'predMkts'],
    }));
    const { unmount } = render(<PortfolioDashboard />);
    expect(await screen.findByText('Active market: spx')).toBeInTheDocument();
    unmount();

    window.localStorage.setItem('marketDashboard.panelState.v1', JSON.stringify({
      showCpiModel: false,
      showPredictionMarketsSandbox: true,
      sidebarPanelStack: ['cpi', 'portfolio', 'predMkts'],
    }));
    render(<PortfolioDashboard />);
    expect(await screen.findByText('Active market: spx')).toBeInTheDocument();
    await waitFor(() => expect(JSON.parse(window.localStorage.getItem('marketDashboard.panelState.v1')).sidebarPanelStack).toEqual(['portfolio', 'predictionMarkets']));
  });

  test('removes the left product rail and opens persistent SS and ETF Pro panels', async () => {
    render(<PortfolioDashboard />);

    expect(screen.queryByText('Securities List')).not.toBeInTheDocument();
    expect(screen.queryByText('Sectors Compact Rail')).not.toBeInTheDocument();

    const ssButton = await screen.findByRole('button', { name: 'Signal Strength' });
    const etfProButton = await screen.findByRole('button', { name: 'ETF Pro' });
    fireEvent.click(ssButton);
    expect(await screen.findByText('SS Reference Panel')).toBeInTheDocument();

    fireEvent.click(etfProButton);
    expect(await screen.findByText('ETF Pro Reference Panel')).toBeInTheDocument();

    await waitFor(() => expect(JSON.parse(window.localStorage.getItem('marketDashboard.panelState.v1')).showEtfPro).toBe(true));
    const stored = JSON.parse(window.localStorage.getItem('marketDashboard.panelState.v1'));
    expect(stored.showSignalStrength).toBe(true);
    expect(stored.sidebarPanelStack.slice(-2)).toEqual(['ss', 'etfPro']);

    fireEvent.click(screen.getByRole('button', { name: 'Close ETF Pro' }));
    expect(screen.queryByText('ETF Pro Reference Panel')).not.toBeInTheDocument();
  });

  test('opens persistent Macro Show and Call panels from the right rail', async () => {
    render(<PortfolioDashboard />);

    const macroButton = await screen.findByRole('button', { name: 'Macro Show' });
    const callButton = await screen.findByRole('button', { name: 'Call' });
    fireEvent.click(macroButton);
    expect(await screen.findByText('Macro Show Reference Panel')).toBeInTheDocument();

    fireEvent.click(callButton);
    expect(await screen.findByText('Call Reference Panel')).toBeInTheDocument();

    await waitFor(() => expect(JSON.parse(window.localStorage.getItem('marketDashboard.panelState.v1')).showCall).toBe(true));
    const stored = JSON.parse(window.localStorage.getItem('marketDashboard.panelState.v1'));
    expect(stored.showMacroShow).toBe(true);
    expect(stored.sidebarPanelStack.slice(-2)).toEqual(['macroShow', 'call']);

    fireEvent.click(screen.getByRole('button', { name: 'Close Call' }));
    expect(screen.queryByText('Call Reference Panel')).not.toBeInTheDocument();
  });
});
