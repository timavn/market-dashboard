import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import PortfolioDashboard, { analystNavigationState } from '../PortfolioDashboard';
import { MarketDataService } from '../../../services/api/marketDataService';
import predictionMarketTestService from '../../../services/api/predictionMarketTestService';
import { loadSelectedAccount } from '../../../constants/ibkrAccountStorage';
import {
  getIbkrConnectionDisplay,
  getPreferredIbkrAccount,
} from '../../../utils/ibkrConnectionStatus';
import { resetSessionResourceStore } from '../../../utils/sessionResourceStore';

test('consolidated navigation replaces TL;DR with one Analyst entry', () => {
  expect(analystNavigationState(false)).toEqual({
    systemsEntry: 'analyst',
    showLegacyTldr: false,
    showResearchAnalyst: false,
  });
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
jest.mock('../PortfolioBreakdown', () => (props) => {
  mockPortfolioBreakdown(props);
  return <div>Portfolio Breakdown</div>;
});
const mockExposureLab = jest.fn();
jest.mock('../ExposureLab', () => (props) => {
  mockExposureLab(props);
  return (
    <div>
      Exposure Lab Matrix
      <button type="button" onClick={props.onClose}>Close Exposure Lab</button>
    </div>
  );
});
const mockPredictionMonitor = jest.fn();
jest.mock('../PredictionMarketResolverTest', () => {
  const mockReact = jest.requireActual('react');
  return (props) => {
    mockPredictionMonitor(props);
    const [draft, setDraft] = mockReact.useState('');
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

describe('PortfolioDashboard prediction-markets sidebar', () => {
  beforeEach(() => {
    resetSessionResourceStore();
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

  test('pauses only reference polls while hidden and refreshes them once when visible', async () => {
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
    MarketDataService.getHedgeyeEtfPro.mockClear();
    MarketDataService.getHedgeyeChangelog.mockClear();

    hidden = true;
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      jest.advanceTimersByTime(5 * 60 * 1000);
      await Promise.resolve();
    });

    expect(MarketDataService.getPortfolio).toHaveBeenCalled();
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

  test('keeps the verified portfolio panel current during a transient refresh failure', async () => {
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
        portfolioData: livePortfolio,
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
          us: expect.arrayContaining([expect.objectContaining({ symbol: 'SPX' })]),
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
          us: expect.arrayContaining([expect.objectContaining({ symbol: 'SPX' })]),
        }),
        multiRegionError: 'quote refresh timed out',
      })
    );
  });

  test('removes the legacy Prediction Markets button and hub while keeping the market monitors', async () => {
    window.localStorage.setItem('marketDashboard.panelState.v1', JSON.stringify({
      showPredictionMarketsHub: true,
      activePredictionMarket: 'spx',
      activeWtiCadence: 'weekly',
      sidebarPanelStack: ['predictionMarkets'],
    }));

    render(<PortfolioDashboard />);

    const navigation = await screen.findByTestId('dashboard-rail-navigation');
    expect(within(navigation).queryByRole('button', { name: 'Prediction Markets' }))
      .not.toBeInTheDocument();
    ['Silver', 'Gold', 'WTI', 'Brent', 'Bitcoin', 'SP500', 'CPI'].forEach((label) => {
      expect(within(navigation).getByRole('button', { name: label })).toBeInTheDocument();
    });
    expect(within(navigation).getByRole('region', { name: 'T1 prediction markets' })).toBeInTheDocument();
    const t2 = within(navigation).getByRole('region', { name: 'T2 prediction markets' });
    expect(within(t2).getAllByRole('button').map((button) => button.textContent)).toEqual([
      'SP500', 'CPI',
    ]);
    expect(within(navigation).queryByRole('button', { name: 'Nasdaq' })).not.toBeInTheDocument();
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

    const navigation = await screen.findByTestId('dashboard-rail-navigation');
    const cpi = within(navigation).getByRole('button', { name: 'CPI' });
    const sp500 = within(navigation).getByRole('button', { name: 'SP500' });
    fireEvent.click(cpi);

    expect(await screen.findByText('Active monitor: cpi')).toBeInTheDocument();
    expect(screen.getByTestId('prediction-market-surface-cpi')).toBeVisible();
    expect(cpi).toHaveClass('is-active');
    expect(sp500).not.toHaveClass('is-active');
    expect(mockPredictionMonitor).toHaveBeenCalledWith(expect.objectContaining({ marketId: 'cpi' }));
  });

  test('decorates only research-aligned RR monitor buttons and keeps the active state', async () => {
    predictionMarketTestService.getMorningReport.mockResolvedValueOnce(alignedMorningReport());
    render(<PortfolioDashboard />);

    const navigation = await screen.findByTestId('dashboard-rail-navigation');
    const sp500 = within(navigation).getByRole('button', { name: 'SP500' });
    const wti = within(navigation).getByRole('button', { name: 'WTI' });
    const silver = within(navigation).getByRole('button', { name: 'Silver' });
    const brent = within(navigation).getByRole('button', { name: 'Brent' });
    const bitcoin = within(navigation).getByRole('button', { name: 'Bitcoin' });
    const gold = within(navigation).getByRole('button', { name: 'Gold' });

    await waitFor(() => expect(sp500).toHaveAttribute('data-indicator-tone', 'bullish'));
    expect(sp500).toHaveAccessibleDescription(
      'Aligned bullish Trade and Trend in the lower Risk Range third.',
    );
    expect(wti).toHaveAttribute('data-indicator-tone', 'bearish');
    expect(wti).toHaveAccessibleDescription(
      'Aligned bearish Trade and Trend in the upper Risk Range third.',
    );
    expect(silver).not.toHaveAttribute('data-indicator-tone');
    expect(brent).not.toHaveAttribute('data-indicator-tone');
    expect(bitcoin).not.toHaveAttribute('data-indicator-tone');
    expect(gold).not.toHaveAttribute('data-indicator-tone');

    fireEvent.click(wti);
    expect(wti).toHaveClass('is-active');
    expect(wti).toHaveAttribute('data-indicator-tone', 'bearish');
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
    const navigation = screen.getByTestId('dashboard-rail-navigation');
    const sp500 = within(navigation).getByRole('button', { name: 'SP500' });
    expect(sp500).toHaveAttribute('data-indicator-tone', 'bullish');

    await act(async () => {
      jest.advanceTimersByTime(30_000);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(sp500).not.toHaveAttribute('data-indicator-tone');
  });

  test('docks Balance into the left remainder while an individual market monitor stays open', async () => {
    render(<PortfolioDashboard />);

    const navigation = await screen.findByTestId('dashboard-rail-navigation');
    fireEvent.click(within(navigation).getByRole('button', { name: 'SP500' }));
    expect(await screen.findByText('Active monitor: sp500')).toBeInTheDocument();

    fireEvent.click(within(navigation).getByRole('button', { name: 'Balance' }));

    const balancePanel = await screen.findByTestId('portfolio-balance-planner-slot');
    expect(balancePanel).toBeVisible();
    expect(balancePanel)
      .toHaveClass('dashboard-navigation-rail__balance-panel--workspace-left');
    expect(balancePanel)
      .not.toHaveClass('dashboard-navigation-rail__balance-panel--portfolio-left');
    const predictionMonitorPanel = screen.getByTestId('prediction-market-resolver-test-panel');
    expect(predictionMonitorPanel).toBeVisible();
    expect(Number(balancePanel.style.zIndex))
      .toBeGreaterThan(Number(predictionMonitorPanel.style.zIndex));
    expect(screen.getByTestId('dashboard-panel-backdrop')).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Close Balance' }));
    await waitFor(() => expect(balancePanel).not.toBeVisible());
    expect(screen.getByTestId('prediction-market-resolver-test-panel')).toBeVisible();
  });

  test('uses the Balance card shell for The Analyst without blurring or disabling the dashboard', async () => {
    render(<PortfolioDashboard />);

    const navigation = await screen.findByTestId('dashboard-rail-navigation');
    fireEvent.click(within(navigation).getByRole('button', { name: 'The Analyst' }));

    expect(await screen.findByTestId('mock-analyst-panel')).toBeInTheDocument();
    const analystPanel = screen.getByTestId('analyst-panel-surface');
    expect(analystPanel).toBeVisible();
    expect(analystPanel).toHaveClass(
      'dashboard-navigation-rail__balance-panel',
      'dashboard-navigation-rail__analyst-panel',
    );
    expect(analystPanel)
      .not.toHaveClass('dashboard-navigation-rail__balance-panel--workspace-left');
    expect(analystPanel).not.toHaveClass('dashboard-side-panel--analyst-card');
    expect(screen.getByRole('separator', { name: 'Resize The Analyst from the left edge' }))
      .toBeInTheDocument();
    expect(screen.getByTestId('dashboard-panel-backdrop')).not.toBeVisible();
    expect(screen.getByTestId('dashboard-panel-backdrop')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByTestId('dashboard-main-canvas')).not.toHaveAttribute('aria-hidden');
    expect(screen.getByTestId('dashboard-main-canvas').inert).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Close The Analyst' }));
    await waitFor(() => expect(analystPanel).not.toBeVisible());
  });

test('widens The Analyst toward the left and persists the chosen width', async () => {
    render(<PortfolioDashboard />);

    const navigation = await screen.findByTestId('dashboard-rail-navigation');
    fireEvent.click(within(navigation).getByRole('button', { name: 'The Analyst' }));

    const analystPanel = await screen.findByTestId('analyst-panel-surface');
    const resizeHandle = screen.getByRole('separator', { name: 'Resize The Analyst from the left edge' });
    jest.spyOn(analystPanel, 'getBoundingClientRect').mockImplementation(() => {
      const width = Number.parseFloat(
        analystPanel.style.getPropertyValue('--analyst-panel-width'),
      ) || 440;
      const left = 400 - (width - 440);
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
      clientX: 400,
    }));
    expect(document.body).toHaveClass('dashboard-is-resizing-analyst');
    fireEvent(window, new MouseEvent('pointermove', { clientX: 300 }));
    expect(analystPanel.style.getPropertyValue('--analyst-panel-width')).toBe('540px');
    fireEvent(window, new MouseEvent('pointerup', { clientX: 300 }));
    expect(document.body).not.toHaveClass('dashboard-is-resizing-analyst');

    await waitFor(() => expect(
      JSON.parse(window.localStorage.getItem('marketDashboard.panelState.v1')).analystPanelWidth,
    ).toBe(540));

    fireEvent.keyDown(resizeHandle, { key: 'ArrowRight' });
    expect(analystPanel.style.getPropertyValue('--analyst-panel-width')).toBe('516px');
    fireEvent.doubleClick(resizeHandle);
  expect(analystPanel.style.getPropertyValue('--analyst-panel-width')).toBe('440px');
});

test('widens The Analyst toward the right from a left dock', async () => {
  render(<PortfolioDashboard />);

  const navigation = await screen.findByTestId('dashboard-rail-navigation');
  fireEvent.click(within(navigation).getByRole('button', { name: 'The Analyst' }));

  const analystPanel = await screen.findByTestId('analyst-panel-surface');
  fireEvent.click(within(navigation).getByRole('button', {
    name: 'Move The Analyst to the left',
  }));

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
    ) || 440;
    return {
      bottom: 712,
      height: 704,
      left: 8,
      right: 8 + width,
      top: 8,
      width,
      x: 8,
      y: 8,
      toJSON: () => ({}),
    };
  });

  fireEvent(resizeHandle, new MouseEvent('pointerdown', {
    bubbles: true,
    button: 0,
    clientX: 448,
  }));
  fireEvent(window, new MouseEvent('pointermove', { clientX: 548 }));
  expect(analystPanel.style.getPropertyValue('--analyst-panel-width')).toBe('540px');
  fireEvent(window, new MouseEvent('pointerup', { clientX: 548 }));

  fireEvent.keyDown(resizeHandle, { key: 'ArrowRight' });
  expect(analystPanel.style.getPropertyValue('--analyst-panel-width')).toBe('564px');
});

test('opens and positions The Analyst from each three-dot rail control', async () => {
  render(<PortfolioDashboard />);

  const navigation = await screen.findByTestId('dashboard-rail-navigation');
  const dots = within(navigation).getByTestId('analyst-position-controls');
  const left = within(dots).getByRole('button', { name: 'Move The Analyst to the left' });
  const center = within(dots).getByRole('button', { name: 'Move The Analyst to the center' });
  const right = within(dots).getByRole('button', { name: 'Move The Analyst to the right' });

  expect(within(dots).getAllByRole('button')).toHaveLength(3);
  expect(left).toHaveAttribute('aria-pressed', 'false');
  expect(center).toHaveAttribute('aria-pressed', 'false');
  expect(right).toHaveAttribute('aria-pressed', 'false');

  fireEvent.click(left);
  const analystPanel = await screen.findByTestId('analyst-panel-surface');
  expect(analystPanel).toBeVisible();
  expect(analystPanel).toHaveClass('dashboard-navigation-rail__analyst-panel--left');
  expect(analystPanel).not.toHaveClass('dashboard-navigation-rail__balance-panel--workspace-left');
  expect(left).toHaveAttribute('aria-pressed', 'true');
  await waitFor(() => expect(
    JSON.parse(window.localStorage.getItem('marketDashboard.panelState.v1')).analystPanelPosition,
  ).toBe('left'));

  fireEvent.click(left);
  expect(analystPanel).toBeVisible();

  fireEvent.click(center);
  expect(analystPanel).toBeVisible();
  expect(analystPanel).toHaveClass('dashboard-navigation-rail__analyst-panel--center');
  expect(center).toHaveAttribute('aria-pressed', 'true');

  fireEvent.click(right);
  expect(analystPanel).toBeVisible();
  expect(analystPanel).toHaveClass('dashboard-navigation-rail__analyst-panel--right');
  expect(right).toHaveAttribute('aria-pressed', 'true');
  await waitFor(() => expect(
    JSON.parse(window.localStorage.getItem('marketDashboard.panelState.v1')).analystPanelPosition,
  ).toBe('right'));
});

test('restores an explicitly selected Analyst dock position', async () => {
  window.localStorage.setItem('marketDashboard.panelState.v1', JSON.stringify({
    showAnalyst: true,
    analystPanelPosition: 'center',
    sidebarPanelStack: ['analyst'],
  }));

  render(<PortfolioDashboard />);

  const analystPanel = await screen.findByTestId('analyst-panel-surface');
  expect(analystPanel).toHaveClass('dashboard-navigation-rail__analyst-panel--center');

  const navigation = await screen.findByTestId('dashboard-rail-navigation');
  expect(within(navigation).getByRole('button', {
    name: 'Move The Analyst to the center',
  })).toHaveAttribute('aria-pressed', 'true');
});

test('docks The Analyst left while an individual market monitor stays open', async () => {
    render(<PortfolioDashboard />);

    const navigation = await screen.findByTestId('dashboard-rail-navigation');
    fireEvent.click(within(navigation).getByRole('button', { name: 'SP500' }));
    expect(await screen.findByText('Active monitor: sp500')).toBeInTheDocument();
    fireEvent.click(within(navigation).getByRole('button', { name: 'The Analyst' }));

    const analystPanel = await screen.findByTestId('analyst-panel-surface');
    expect(analystPanel).toBeVisible();
    expect(analystPanel)
      .toHaveClass('dashboard-navigation-rail__balance-panel--workspace-left');
    expect(analystPanel)
      .not.toHaveClass('dashboard-navigation-rail__balance-panel--portfolio-left');
    const predictionMonitorPanel = screen.getByTestId('prediction-market-resolver-test-panel');
    expect(predictionMonitorPanel).toBeVisible();
    expect(predictionMonitorPanel)
      .toHaveAttribute('data-surface-active', 'true');
  });

  test('docks The Analyst left while Portfolio stays open', async () => {
    render(<PortfolioDashboard />);

    const navigation = await screen.findByTestId('dashboard-rail-navigation');
    fireEvent.click(within(navigation).getByRole('button', { name: 'Portfolio' }));
    expect(await screen.findByText('Portfolio Breakdown')).toBeInTheDocument();
    fireEvent.click(within(navigation).getByRole('button', { name: 'The Analyst' }));

    const analystPanel = await screen.findByTestId('analyst-panel-surface');
    expect(analystPanel).toBeVisible();
    expect(analystPanel).toHaveClass(
      'dashboard-navigation-rail__balance-panel--workspace-left',
      'dashboard-navigation-rail__balance-panel--portfolio-left',
    );
    const portfolioPanel = screen.getByTestId('portfolio-breakdown-panel');
    expect(portfolioPanel).toBeVisible();
    expect(portfolioPanel)
      .toHaveAttribute('data-surface-active', 'true');
  });

  test('opens Exposure Lab as a full-width workspace card left of the rail', async () => {
    render(<PortfolioDashboard />);

    const navigation = await screen.findByTestId('dashboard-rail-navigation');
    const exposureButton = within(navigation).getByRole('button', { name: 'Exposure Lab' });
    fireEvent.click(exposureButton);

    expect(await screen.findByText('Exposure Lab Matrix')).toBeInTheDocument();
    const panel = screen.getByTestId('exposure-lab-panel');
    expect(panel).toBeVisible();
    expect(panel).toHaveAttribute('data-layout', 'left-workspace-card');
    expect(panel).toHaveClass('dashboard-side-panel--exposure-card');
    expect(panel).toHaveStyle({
      top: '8px',
      left: '8px',
      right: 'calc(var(--dashboard-rail-panel-offset) + 16px)',
      width: 'auto',
      height: 'calc(100vh - 16px)',
      borderRadius: '10px',
      boxShadow: '0 10px 26px rgba(15, 23, 42, 0.12)',
    });
    expect(exposureButton).toHaveClass('is-active');
    expect(mockExposureLab).toHaveBeenLastCalledWith(expect.objectContaining({
      portfolioData: expect.objectContaining({ dataSource: 'ibkr_api' }),
    }));

    await waitFor(() => {
      const stored = JSON.parse(window.localStorage.getItem('marketDashboard.panelState.v1'));
      expect(stored.showExposureLab).toBe(true);
      expect(stored.sidebarPanelStack).toContain('exposureLab');
    });
  });

  test('uses a light, compact 88px text-only rail without search or expand controls', async () => {
    render(<PortfolioDashboard />);

    const shell = screen.getByTestId('dashboard-shell');
    const navigation = await screen.findByTestId('dashboard-rail-navigation');
    const processButton = within(navigation).getByRole('button', { name: 'Process' });

    expect(shell).toHaveStyle({
      '--dashboard-rail-collapsed-width': 'min(88px, calc(100vw - 32px))',
      '--dashboard-rail-visible-width': 'min(88px, calc(100vw - 32px))',
    });
    expect(navigation).toHaveClass('dashboard-navigation-rail__content--collapsed');
    expect(screen.queryByRole('textbox', { name: 'Search navigation' })).not.toBeInTheDocument();
    expect(screen.queryByText('⌘ K')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Expand' })).not.toBeInTheDocument();
    expect(processButton).toHaveClass('dashboard-navigation-rail__card');
    expect(within(navigation).queryByText('PRIMARY')).not.toBeInTheDocument();
    expect(within(navigation).queryByText('UTILITY')).not.toBeInTheDocument();
    const primaryNavigation = within(navigation).getByRole('region', { name: 'PRIMARY navigation' });
    const utilityNavigation = within(navigation).getByRole('region', { name: 'UTILITY navigation' });
    expect(primaryNavigation).toHaveAttribute('data-navigation-group', 'primary');
    expect(primaryNavigation).toHaveAttribute('data-navigation-placement', 'top');
    expect(utilityNavigation).toHaveAttribute('data-navigation-group', 'utility');
    expect(utilityNavigation).toHaveAttribute('data-navigation-placement', 'bottom');
    expect(within(navigation).getAllByRole('region', { name: /navigation/ }))
      .toEqual([primaryNavigation, utilityNavigation]);
    ['X.com', 'TL;DR', 'Process', 'Exposure Guide', 'Portfolio', 'Balance',
      'Silver', 'Gold', 'WTI', 'Brent', 'Bitcoin', 'SP500', 'CPI']
      .forEach((label) => expect(within(primaryNavigation).getByRole('button', { name: label }))
        .toBeInTheDocument());
    ['Systems', 'The Analyst']
      .forEach((label) => expect(within(utilityNavigation).getByRole('button', { name: label }))
        .toBeInTheDocument());
    expect(navigation.querySelector('svg')).toBeNull();
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

    const navigation = await screen.findByTestId('dashboard-rail-navigation');
    expect(within(navigation).getByRole('button', { name: /^Systems/ })).toBeInTheDocument();
    ['TL;DR', 'Process', 'Exposure Guide', 'Portfolio', 'Balance',
      'Silver', 'Gold', 'WTI', 'Brent', 'Bitcoin', 'SP500', 'CPI']
      .forEach((label) => expect(within(navigation).getByRole('button', { name: label })).toBeInTheDocument());
    expect(within(navigation).queryByRole('button', { name: 'Market Structure' }))
      .not.toBeInTheDocument();
    expect(within(navigation).queryByRole('button', { name: 'PODS' })).not.toBeInTheDocument();
    expect(within(navigation).queryByRole('button', { name: 'EV Data' })).not.toBeInTheDocument();
    expect(within(navigation).queryByRole('button', { name: 'Securities Universe' }))
      .not.toBeInTheDocument();
    expect(screen.queryByText('POD Calculations')).not.toBeInTheDocument();
    expect(screen.queryByText('Expected Values')).not.toBeInTheDocument();
    const processButton = within(navigation).getByRole('button', { name: 'Process' });
    expect(within(navigation).queryByRole('button', { name: 'Prediction Markets' }))
      .not.toBeInTheDocument();
    expect(within(navigation).queryByRole('button', { name: 'SPX Close' })).not.toBeInTheDocument();
    expect(screen.queryByTitle('Performance Tracking')).not.toBeInTheDocument();
    expect(within(navigation).queryByRole('button', { name: 'Analytics' })).not.toBeInTheDocument();
    expect(within(navigation).getByTitle('Systems')).toBeInTheDocument();
    expect(screen.getByTitle('Open X (Twitter) List')).toBeInTheDocument();
    expect(processButton).toHaveAttribute('data-process-toggle', 'true');
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

    const navigation = await screen.findByTestId('dashboard-rail-navigation');
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

  test('keeps every workspace destination in the compact card rail and opens Balance separately', async () => {
    MarketDataService.getPortfolioBalance.mockResolvedValue(livePortfolioBalance());
    render(<PortfolioDashboard />);

    const shell = screen.getByTestId('dashboard-shell');
    const navigation = await screen.findByTestId('dashboard-rail-navigation');
    expect(shell).toHaveStyle({
      '--dashboard-rail-visible-width': 'min(88px, calc(100vw - 32px))',
    });
    expect(navigation).toHaveClass('dashboard-navigation-rail__content--collapsed');
    expect(screen.queryByRole('heading', { name: 'Workspace' })).not.toBeInTheDocument();
    expect(within(navigation).queryByText('SYSTEMS')).not.toBeInTheDocument();
    expect(within(navigation).queryByText('MARKET INTELLIGENCE')).not.toBeInTheDocument();
    ['Signal Strength', 'ETF Pro', 'Macro Show', 'Call']
      .forEach((label) => expect(within(navigation).queryByTitle(label)).not.toBeInTheDocument());
    expect(within(navigation).getByTitle('Systems')).toBeInTheDocument();
    expect(within(navigation).getByTitle('Portfolio balance')).toHaveClass('dashboard-navigation-rail__card');
    expect(within(navigation).getByTitle('Contract P&L')).toHaveClass('dashboard-navigation-rail__card');
    expect(screen.queryByTitle('Expand')).not.toBeInTheDocument();
    expect(within(navigation).queryByRole('button', { name: 'Analytics' })).not.toBeInTheDocument();
    expect(screen.queryByText('Portfolio Sidebar Snapshot')).not.toBeInTheDocument();

    fireEvent.click(within(navigation).getByRole('button', { name: 'Portfolio' }));
    expect(await screen.findByText('Portfolio Breakdown')).toBeInTheDocument();
    expect(screen.getByTestId('portfolio-breakdown-panel')).toBeVisible();
    expect(screen.getByTestId('portfolio-breakdown-panel'))
      .toHaveClass('dashboard-side-panel--portfolio-card');
    expect(screen.getByTestId('dashboard-panel-backdrop')).toBeVisible();

    fireEvent.click(within(navigation).getByRole('button', { name: 'Balance' }));
    expect(await screen.findByRole('region', { name: 'Balance' })).toBeInTheDocument();
    expect(screen.queryByRole('tablist', { name: 'Balance panel view' })).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Portfolio balance scenario planner' }))
      .toBeInTheDocument();
    expect(screen.getByTestId('portfolio-balance-planner-slot'))
      .toHaveClass('dashboard-navigation-rail__balance-panel--portfolio-left');
    expect(screen.getByTestId('portfolio-balance-planner-slot'))
      .toHaveClass('dashboard-navigation-rail__balance-panel--workspace-left');
    expect(screen.getByText('Portfolio Breakdown')).toBeInTheDocument();
    expect(shell).toHaveStyle({
      '--dashboard-rail-visible-width': 'min(88px, calc(100vw - 32px))',
    });

    fireEvent.click(screen.getByRole('button', { name: 'Close Balance' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Balance' }))
      .not.toBeInTheDocument());

    const balanceReadsAfterFirstOpen = MarketDataService.getPortfolioBalance.mock.calls.length;
    fireEvent.click(within(navigation).getByRole('button', { name: 'Balance' }));
    expect(await screen.findByRole('region', { name: 'Balance' })).toBeInTheDocument();
    expect(MarketDataService.getPortfolioBalance.mock.calls.length)
      .toBe(balanceReadsAfterFirstOpen);
  });

  test('opens the single-account Contract P&L ledger from its own sidebar destination', async () => {
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

    const navigation = await screen.findByTestId('dashboard-rail-navigation');
    const balanceButton = within(navigation).getByRole('button', { name: 'Balance' });
    const contractPnlButton = within(navigation).getByRole('button', { name: 'Contract P&L' });
    expect(balanceButton).not.toBe(contractPnlButton);
    fireEvent.click(contractPnlButton);
    expect(await screen.findByRole('region', { name: 'Contract P&L' })).toBeVisible();
    expect(screen.queryByRole('region', { name: 'Balance' })).not.toBeInTheDocument();
    expect(contractPnlButton).toHaveAttribute('aria-pressed', 'true');
    expect(balanceButton).toHaveAttribute('aria-pressed', 'false');
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
  });

  test('widens Contract P&L from either edge and persists its base width', async () => {
    MarketDataService.getPredictionMarketPerformance.mockResolvedValue({
      rows: [],
      review: [],
      summary: { count: 0, openCount: 0, openPnl: 0, realizedCount: 0, realizedPnl: 0 },
      tracker: { status: 'ready', health: 'capturing' },
    });
    render(<PortfolioDashboard />);

    const navigation = await screen.findByTestId('dashboard-rail-navigation');
    fireEvent.click(within(navigation).getByRole('button', { name: 'Contract P&L' }));

    const panel = screen.getByTestId('contract-pnl-panel-slot');
    const resizeHandle = screen.getByRole('separator', {
      name: 'Resize Contract P&L from the left edge',
    });
    const rightResizeHandle = screen.getByRole('separator', {
      name: 'Resize Contract P&L from the right edge',
    });
    expect(panel).toHaveClass('dashboard-navigation-rail__balance-panel--contract-pnl');
    expect(screen.getByTestId('dashboard-panel-backdrop')).not.toBeVisible();
    expect(screen.getByTestId('dashboard-panel-backdrop')).toHaveAttribute('aria-hidden', 'true');
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
      ) || 295;
      const right = 900;
      const left = right - width;
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
    expect(panel.style.getPropertyValue('--dashboard-balance-panel-width')).toBe('395px');
    fireEvent(window, new MouseEvent('pointerup', { clientX: 505 }));
    expect(document.body).not.toHaveClass('dashboard-is-resizing-contract-pnl');

    await waitFor(() => expect(
      JSON.parse(window.localStorage.getItem('marketDashboard.panelState.v1')).contractPnlPanelWidth,
    ).toBe(395));

    fireEvent.keyDown(resizeHandle, { key: 'ArrowRight' });
    expect(panel.style.getPropertyValue('--dashboard-balance-panel-width')).toBe('371px');

    fireEvent(rightResizeHandle, new MouseEvent('pointerdown', {
      bubbles: true,
      button: 0,
      clientX: 900,
    }));
    fireEvent(window, new MouseEvent('pointermove', { clientX: 950 }));
    expect(panel.style.getPropertyValue('--dashboard-balance-panel-width')).toBe('421px');
    expect(panel.style.getPropertyValue('--dashboard-contract-pnl-right-extension')).toBe('50px');
    fireEvent(window, new MouseEvent('pointerup', { clientX: 950 }));

    await waitFor(() => expect(
      JSON.parse(window.localStorage.getItem('marketDashboard.panelState.v1')).contractPnlPanelWidth,
    ).toBe(371));

    fireEvent.click(within(navigation).getByRole('button', { name: 'Balance' }));
    expect(panel).not.toBeVisible();
    expect(screen.queryByRole('separator', {
      name: 'Resize Contract P&L from the left edge',
    })).not.toBeInTheDocument();
    expect(screen.getByTestId('portfolio-balance-planner-slot').style
      .getPropertyValue('--dashboard-balance-panel-width')).toBe('295px');

    fireEvent.click(within(navigation).getByRole('button', { name: 'Contract P&L' }));
    expect(panel).toBeVisible();
    expect(panel.style.getPropertyValue('--dashboard-balance-panel-width')).toBe('421px');
    fireEvent.doubleClick(screen.getByRole('separator', {
      name: 'Resize Contract P&L from the right edge',
    }));
    expect(panel.style.getPropertyValue('--dashboard-balance-panel-width')).toBe('295px');
    expect(panel.style.getPropertyValue('--dashboard-contract-pnl-right-extension')).toBe('0px');
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

    const navigation = await screen.findByTestId('dashboard-rail-navigation');
    fireEvent.click(within(navigation).getByRole('button', { name: 'Contract P&L' }));
    fireEvent.click(await screen.findByRole('tab', { name: 'Overview' }));
    expect(await screen.findByRole('article', { name: 'WTI overview' })).toBeInTheDocument();
    expect(within(screen.getByRole('article', { name: 'WTI overview' })).getAllByText('+$6.00').length).toBeGreaterThan(0);
    expect(screen.getByRole('article', { name: 'Gold overview' })).toBeInTheDocument();
  });

  test('opens and persists the lightweight Systems panel', async () => {
    render(<PortfolioDashboard />);

    const systemButton = await screen.findByTitle('Systems');
    expect(systemButton).toHaveAttribute('data-readiness-status', 'unknown');
    fireEvent.click(systemButton);

    expect(await screen.findByText('Systems Panel')).toBeInTheDocument();
    await waitFor(() => expect(JSON.parse(window.localStorage.getItem('marketDashboard.panelState.v1')).showSystemReadiness).toBe(true));
    const stored = JSON.parse(window.localStorage.getItem('marketDashboard.panelState.v1'));
    expect(stored.sidebarPanelStack).toContain('system');
    expect(screen.getByTestId('system-readiness-sheet')).toHaveStyle({
      display: 'block',
      top: '50%',
      left: '50%',
      transform: 'translate(-50%, -50%)',
      maxHeight: 'calc(100vh - 20px)',
      borderRadius: '0.75rem',
    });

    fireEvent.click(screen.getByRole('button', { name: 'Report peripheral issue' }));
    expect(systemButton).toHaveAttribute('data-readiness-status', 'attention');
    expect(systemButton).toHaveStyle({ borderColor: 'var(--dashboard-attention)' });

    fireEvent.click(screen.getByRole('button', { name: 'Close Systems' }));
    expect(screen.getByTestId('system-readiness-sheet')).toHaveStyle({ display: 'none' });
  });

  test('places Exposure Guide directly after Process and opens its Process route', async () => {
    const onOpenProcess = jest.fn();
    const onNavigateProcess = jest.fn();
    render(
      <PortfolioDashboard
        onOpenProcess={onOpenProcess}
        onNavigateProcess={onNavigateProcess}
      />,
    );

    const tldrButton = await screen.findByTitle('Open TL;DR');
    const processButton = screen.getByRole('button', { name: 'Process' });
    const guideButton = screen.getByRole('button', { name: 'Exposure Guide' });
    const navigation = screen.getByTestId('dashboard-rail-navigation');
    const buttons = within(navigation).getAllByRole('button');

    expect(buttons[buttons.indexOf(tldrButton) + 1]).toBe(processButton);
    expect(buttons[buttons.indexOf(processButton) + 1]).toBe(guideButton);
    expect(within(navigation).queryByRole('button', { name: 'Market Structure' }))
      .not.toBeInTheDocument();
    fireEvent.click(processButton);
    expect(onOpenProcess).toHaveBeenCalledTimes(1);
    fireEvent.click(guideButton);
    expect(onNavigateProcess).toHaveBeenCalledWith('#/process/exposure-lab');
  });

  test('switches between Process and Exposure Guide without closing the reader', async () => {
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
    const guideButton = screen.getByRole('button', { name: 'Exposure Guide' });
    expect(screen.getByRole('button', { name: 'Process' })).toHaveAttribute('aria-pressed', 'true');
    expect(guideButton).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(guideButton);
    expect(onNavigateProcess).toHaveBeenCalledWith('#/process/exposure-lab');
    expect(onCloseProcess).not.toHaveBeenCalled();

    view.rerender(
      <PortfolioDashboard
        processDocumentId="exposure-lab-guide"
        onCloseProcess={onCloseProcess}
        onNavigateProcess={onNavigateProcess}
      />,
    );
    expect(screen.getByRole('button', { name: 'Exposure Guide' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Process' })).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(screen.getByRole('button', { name: 'Process' }));
    expect(onNavigateProcess).toHaveBeenLastCalledWith('#/process');
    expect(onCloseProcess).not.toHaveBeenCalled();
  });

  test('closes an active Exposure Guide and restores focus to its rail button', async () => {
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
    fireEvent.click(screen.getByRole('button', { name: 'Exposure Guide' }));
    expect(onCloseProcess).toHaveBeenCalledTimes(1);

    view.rerender(
      <PortfolioDashboard
        processDocumentId={null}
        onCloseProcess={onCloseProcess}
        onNavigateProcess={onNavigateProcess}
      />,
    );
    await waitFor(() => expect(screen.getByRole('button', { name: 'Exposure Guide' })).toHaveFocus());
  });

  test('keeps the dashboard mounted and inert while Process is open, then restores the compact rail', async () => {
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
    expect(screen.getByRole('button', { name: 'Process' })).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() => expect(screen.getByTestId('dashboard-shell')).toHaveStyle({
      '--dashboard-rail-visible-width': 'min(88px, calc(100vw - 32px))',
    }));
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
      '--dashboard-rail-visible-width': 'min(88px, calc(100vw - 32px))',
    }));
    expect(screen.getByTitle('Process')).toHaveFocus();
  });

  test('closes Process before another rail control performs its normal action', async () => {
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
    expect(systemControl).toHaveFocus();
  });

  test('opens the Process explainer and the replacement TL;DR reader', async () => {
    const onOpenWhitePaper = jest.fn();
    render(<PortfolioDashboard onOpenWhitePaper={onOpenWhitePaper} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Process' }));
    expect(onOpenWhitePaper).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTitle('Open TL;DR'));
    expect(await screen.findByTestId('mock-morning-tldr')).toBeInTheDocument();
    expect(screen.getByText('Morning TL;DR')).toBeInTheDocument();
    expect(screen.queryByTitle('Open Notes')).not.toBeInTheDocument();
  });

  test('keeps the compact rail while TL;DR is open', async () => {
    render(<PortfolioDashboard />);

    fireEvent.click(await screen.findByTitle('Open TL;DR'));
    expect(await screen.findByTestId('mock-morning-tldr')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('dashboard-shell')).toHaveStyle({
      '--dashboard-rail-visible-width': 'min(88px, calc(100vw - 32px))',
    }));

    fireEvent.click(screen.getByRole('button', { name: 'Close TL;DR' }));
    await waitFor(() => expect(screen.getByTestId('dashboard-shell')).toHaveStyle({
      '--dashboard-rail-visible-width': 'min(88px, calc(100vw - 32px))',
    }));
  });

  test('illuminates every open panel button in the rail', async () => {
    render(<PortfolioDashboard />);

    const navigation = await screen.findByTestId('dashboard-rail-navigation');
    const portfolioButton = within(navigation).getByRole('button', { name: 'Portfolio' });
    const tldrButton = within(navigation).getByTitle('Open TL;DR');

    fireEvent.click(portfolioButton);
    expect(await screen.findByText('Portfolio Breakdown')).toBeInTheDocument();
    expect(portfolioButton).toHaveClass('is-active');

    fireEvent.click(tldrButton);
    expect(await screen.findByTestId('mock-morning-tldr')).toBeInTheDocument();
    expect(portfolioButton).toHaveClass('is-active');
    expect(tldrButton).toHaveClass('is-active');
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

    const navigation = await screen.findByTestId('dashboard-rail-navigation');
    expect(within(navigation).queryByRole('button', { name: 'Prediction Markets' }))
      .not.toBeInTheDocument();
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

    const navigation = await screen.findByTestId('dashboard-rail-navigation');
    ['Signal Strength', 'ETF Pro', 'Macro Show', 'Call']
      .forEach((label) => expect(within(navigation).queryByRole('button', { name: label })).not.toBeInTheDocument());
  });

  test('keeps one persistent monitor instance per visited market', async () => {
    render(<PortfolioDashboard />);

    const navigation = await screen.findByTestId('dashboard-rail-navigation');
    const sp500Button = within(navigation).getByRole('button', { name: 'SP500' });
    const wtiButton = within(navigation).getByRole('button', { name: 'WTI' });
    const brentButton = within(navigation).getByRole('button', { name: 'Brent' });
    fireEvent.click(sp500Button);

    expect(await screen.findByText('Active monitor: sp500')).toBeInTheDocument();
    const resolverTestPanel = screen.getByTestId('prediction-market-resolver-test-panel');
    expect(resolverTestPanel).toBeVisible();
    expect(resolverTestPanel).toHaveClass('dashboard-side-panel--resolver-test');
    expect(resolverTestPanel.style.width).toBe('');
    expect(screen.queryByText('Prediction Markets Hub')).not.toBeInTheDocument();
    expect(sp500Button).toHaveClass('is-active');
    expect(wtiButton).not.toHaveClass('is-active');
    fireEvent.change(screen.getByLabelText('sp500 monitor draft'), {
      target: { value: 'retain SP500 state' },
    });

    fireEvent.click(wtiButton);
    expect(await screen.findByText('Active monitor: wti')).toBeInTheDocument();
    expect(screen.getAllByText('Prediction Monitor')).toHaveLength(2);
    expect(screen.getByTestId('prediction-market-surface-sp500')).not.toBeVisible();
    expect(screen.getByTestId('prediction-market-surface-wti')).toBeVisible();
    expect(resolverTestPanel).toBeVisible();
    expect(wtiButton).toHaveClass('is-active');
    expect(sp500Button).not.toHaveClass('is-active');

    fireEvent.click(brentButton);
    expect(await screen.findByText('Active monitor: brent')).toBeInTheDocument();
    expect(screen.getAllByText('Prediction Monitor')).toHaveLength(3);
    expect(brentButton).toHaveClass('is-active');
    expect(wtiButton).not.toHaveClass('is-active');

    fireEvent.click(sp500Button);
    expect(await screen.findByDisplayValue('retain SP500 state')).toBeVisible();
    expect(screen.getByTestId('prediction-market-surface-sp500')).toBeVisible();
    expect(screen.getByTestId('prediction-market-surface-wti')).not.toBeVisible();

    fireEvent.click(sp500Button);
    await waitFor(() => expect(resolverTestPanel).not.toBeVisible());
  });

  test('closes from the shared monitor control and persists the selected market across reloads', async () => {
    const view = render(<PortfolioDashboard />);
    let navigation = await screen.findByTestId('dashboard-rail-navigation');
    fireEvent.click(within(navigation).getByRole('button', { name: 'Gold' }));

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
    navigation = await screen.findByTestId('dashboard-rail-navigation');
    expect(await screen.findByText('Active monitor: gold')).toBeInTheDocument();
    expect(within(navigation).getByRole('button', { name: 'Gold' })).toHaveClass('is-active');

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
