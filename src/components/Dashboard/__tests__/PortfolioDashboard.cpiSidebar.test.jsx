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
jest.mock('../USDMacroDashboard', () => (props) => {
  mockUsdMacroDashboard(props);
  return <div>USD Macro Dashboard</div>;
});
jest.mock('../portfolio/PortfolioSidebarSnapshot', () => () => <div>Portfolio Sidebar Snapshot</div>);
jest.mock('../WorkflowStatus', () => () => <div>Workflow Status</div>);
jest.mock('../SecuritiesUniverse', () => () => <div>Securities Universe</div>);
jest.mock('../PerformanceTracking', () => () => <div>Performance Tracking</div>);
jest.mock('../PortfolioBreakdown', () => () => <div>Portfolio Breakdown</div>);
jest.mock('../ExpectedValuesWindow', () => () => <div>Expected Values</div>);
jest.mock('../PredictionMarkets', () => () => <div>CPI Model</div>);
jest.mock('../SignalStrengthPanel', () => ({ onClose }) => <div>SS Reference Panel<button onClick={onClose}>Close SS</button></div>);
jest.mock('../EtfProPanel', () => ({ onClose }) => <div>ETF Pro Reference Panel<button onClick={onClose}>Close ETF Pro</button></div>);
jest.mock('../HedgeyeShowPanel', () => ({ title, onClose }) => <div>{title} Reference Panel<button onClick={onClose}>Close {title}</button></div>);
jest.mock('react-markdown', () => () => <div>Markdown</div>);

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
  MarketDataService.getRealTimeAlertPositions.mockResolvedValue({ available: false, longCount: 0, shortCount: 0 });
  MarketDataService.getHedgeyeEtfPro.mockResolvedValue({ rows: [] });
  MarketDataService.getHedgeyeChangelog.mockResolvedValue(null);
  MarketDataService.getHedgeyeSnapshot.mockResolvedValue(null);
  MarketDataService.getProviderStatus.mockResolvedValue({});
}

describe('PortfolioDashboard CPI sidebar', () => {
  beforeEach(() => {
    seedDashboardApis();
    window.localStorage.clear();
  });

  afterEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
    window.localStorage.clear();
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

  test('renders CPI sidebar button, opens CPI panel, and persists the cpi panel key', async () => {
    render(<PortfolioDashboard />);

    const cpiButton = await screen.findByRole('button', { name: /cpi/i });
    expect(cpiButton).toBeInTheDocument();
    expect(screen.queryByTitle('Prediction Markets')).not.toBeInTheDocument();
    expect(screen.queryByText('Prediction Markets')).not.toBeInTheDocument();

    fireEvent.click(cpiButton);

    expect(await screen.findByText('CPI Model')).toBeInTheDocument();

    await waitFor(() => expect(JSON.parse(window.localStorage.getItem('marketDashboard.panelState.v1')).showCpiModel).toBe(true));
    const stored = JSON.parse(window.localStorage.getItem('marketDashboard.panelState.v1'));
    expect(stored.sidebarPanelStack).toContain('cpi');
    expect(stored.sidebarPanelStack).not.toContain('predictionMarkets');
    expect(stored.showPredictionMarkets).toBeUndefined();
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
    expect(podsButton).toHaveStyle({ minWidth: '56px', height: '44px' });
    expect(podsButton).toHaveClass('rounded-lg');
    expect(screen.queryByTitle('Switch to Dark Mode')).not.toBeInTheDocument();
  });

  test('uses text labels for named rail controls and retains icon-only utility controls', async () => {
    render(<PortfolioDashboard />);

    const navigation = await screen.findByTestId('dashboard-rail-navigation');
    ['PODS', '+EV', 'NOTES', 'PORTFOLIO', 'SECURITIES', 'CPI', 'ETF Pro', 'Call']
      .forEach((label) => expect(screen.getByText(label)).toBeInTheDocument());
    expect(navigation).toHaveTextContent('SignalStrength');
    expect(navigation).toHaveTextContent('MacroShow');
    expect(screen.queryByTitle('Performance Tracking')).not.toBeInTheDocument();
    expect(within(navigation).queryAllByRole('img')).toHaveLength(0);
    expect(screen.getByText('ANALYTICS')).toBeInTheDocument();
    expect(screen.getByTitle('Open X (Twitter) List')).toBeInTheDocument();
  });

  test('places How It Works directly after Notes and delegates navigation', async () => {
    const onOpenHowItWorks = jest.fn();
    render(<PortfolioDashboard onOpenHowItWorks={onOpenHowItWorks} />);

    const notesButton = await screen.findByTitle('Open Notes');
    const howItWorksButton = screen.getByRole('button', { name: 'How It Works' });
    const navigation = screen.getByTestId('dashboard-rail-navigation');
    const buttons = within(navigation).getAllByRole('button');

    expect(buttons[buttons.indexOf(notesButton) + 1]).toBe(howItWorksButton);
    fireEvent.click(howItWorksButton);
    expect(onOpenHowItWorks).toHaveBeenCalledTimes(1);
  });

  test('migrates legacy predictionMarkets localStorage state to the CPI panel', async () => {
    window.localStorage.setItem('marketDashboard.panelState.v1', JSON.stringify({
      showPredictionMarkets: true,
      sidebarPanelStack: ['predictionMarkets'],
    }));

    render(<PortfolioDashboard />);

    expect(await screen.findByText('CPI Model')).toBeInTheDocument();

    await waitFor(() => expect(JSON.parse(window.localStorage.getItem('marketDashboard.panelState.v1')).showCpiModel).toBe(true));
    const stored = JSON.parse(window.localStorage.getItem('marketDashboard.panelState.v1'));
    expect(stored.sidebarPanelStack).toEqual(expect.arrayContaining(['cpi']));
    expect(stored.sidebarPanelStack).not.toContain('predictionMarkets');
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
