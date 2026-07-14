import React, { Suspense, lazy, useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { Text, Grid, Title, Button, Badge } from '@tremor/react';
import { MarketDataService } from '../../services/api/marketDataService';
import predictionMarketsIngestService from '../../services/api/predictionMarketsIngestService';
import { useTheme } from '../../context/ThemeContext';
import USDMacroDashboard from './USDMacroDashboard';
import { SECURITIES_LIST, ASSET_CLASS_NAMES } from '../../constants/securitiesList';
import './PredictionMarkets.css';
import RefreshButton from '../common/RefreshButton';
import LoadingIndicator from '../common/LoadingIndicator';
import PortfolioSidebarSnapshot from './portfolio/PortfolioSidebarSnapshot';
import { loadSelectedAccount, saveSelectedAccount, saveIbkrAccounts } from '../../constants/ibkrAccountStorage';
import { getIbkrConnectionDisplay, getPreferredIbkrAccount } from '../../utils/ibkrConnectionStatus';

const ReactMarkdown = lazy(() => import('react-markdown'));
const WorkflowStatus = lazy(() => import('./WorkflowStatus'));
const SecuritiesUniverse = lazy(() => import('./SecuritiesUniverse'));
const PerformanceTracking = lazy(() => import('./PerformanceTracking'));
const PortfolioBreakdown = lazy(() => import('./PortfolioBreakdown'));
const ExpectedValuesWindow = lazy(() => import('./ExpectedValuesWindow'));
const CpiModelPanel = lazy(() => import('./PredictionMarkets'));
const SignalStrengthPanel = lazy(() => import('./SignalStrengthPanel'));
const EtfProPanel = lazy(() => import('./EtfProPanel'));
const HedgeyeShowPanel = lazy(() => import('./HedgeyeShowPanel'));

const PORTFOLIO_POLL_MS = 10000;
const PORTFOLIO_ACCOUNTS_POLL_MS = 60000;
const RTA_POLL_MS = 30000;
const ETFPRO_POLL_MS = 60000;
const PROVIDER_STATUS_POLL_MS = 5000;
const PROVIDER_STATUS_POLL_OFFLINE_MS = 15000;
const PROVIDER_STATUS_TIMEOUT_MS = 3500;
const SIDEBAR_PANEL_Z_INDEX_BASE = 1300;
const DASHBOARD_PANEL_STATE_KEY = 'marketDashboard.panelState.v1';
const DASHBOARD_RAIL_COLLAPSED_WIDTH = '76px';
const DASHBOARD_RAIL_EXPANDED_WIDTH = 'calc((100vw - 16px) * (2/12) + 16px + 128px)';
const PERSISTED_SIDEBAR_PANELS = new Set([
  'analytics',
  'securities',
  'performance',
  'portfolio',
  'cpi',
  'ss',
  'etfPro',
  'macroShow',
  'call',
  'pods',
  'ev',
]);

const scheduleBackgroundTask = (callback, timeout = 1) => {
  if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
    const id = window.requestIdleCallback(callback, { timeout: Math.max(timeout, 1000) });
    return () => window.cancelIdleCallback?.(id);
  }
  const setTimer = typeof window !== 'undefined' ? window.setTimeout : setTimeout;
  const clearTimer = typeof window !== 'undefined' ? window.clearTimeout : clearTimeout;
  const id = setTimer(callback, timeout);
  return () => clearTimer(id);
};

const withTimeout = (promise, timeoutMs, label) => new Promise((resolve, reject) => {
  const timeoutId = setTimeout(() => {
    const error = new Error(`${label} timed out after ${timeoutMs}ms`);
    error.code = 'ETIMEDOUT';
    reject(error);
  }, timeoutMs);

  promise.then(
    (value) => {
      clearTimeout(timeoutId);
      resolve(value);
    },
    (error) => {
      clearTimeout(timeoutId);
      reject(error);
    },
  );
});

const isConnectedProviderStatus = (status) => Boolean(
  status?.ibkr?.connected ||
  status?.ibkr?.status === 'connected' ||
  status?.portfolio?.ibkr?.connected ||
  status?.portfolio?.ibkr?.status === 'connected',
);

const LazyPanelFallback = ({ label = 'Loading...' }) => (
  <div
    className="flex h-full items-center justify-center p-4"
    style={{
      minHeight: 'min(720px, calc(100vh - 24px))',
      width: '100%',
    }}
  >
    <LoadingIndicator label={label} size="sm" />
  </div>
);

const readDashboardPanelState = () => {
  if (typeof window === 'undefined') return {};
  try {
    const parsed = JSON.parse(window.localStorage.getItem(DASHBOARD_PANEL_STATE_KEY) || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
};

const writeDashboardPanelState = (state) => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(DASHBOARD_PANEL_STATE_KEY, JSON.stringify(state));
  } catch {
    // localStorage can be unavailable in private contexts; panel state can still run in memory.
  }
};

const readPersistedBoolean = (state, key) => state?.[key] === true;

const normalizePersistedSidebarPanelKey = (key) => {
  if (key === 'predictionMarkets') return 'cpi';
  return key;
};

const readPersistedSidebarStack = (state) => (
  Array.isArray(state?.sidebarPanelStack)
    ? [...new Set(
      state.sidebarPanelStack
        .map(normalizePersistedSidebarPanelKey)
        .filter((key) => PERSISTED_SIDEBAR_PANELS.has(key))
    )]
    : []
);

const PERIOD_RETURN_FIELDS = [
  'weekChangePct',
  'fifteenDayChangePct',
  'thirtyDayChangePct',
  'ninetyDayChangePct',
  'monthChangePct',
  'threeMonthChangePct',
  'sixMonthChangePct',
  'mtdChangePct',
  'qtdChangePct',
  'ytdChangePct',
];

const PERIOD_RETURN_METADATA_FIELDS = [
  'periodReturnsAsOf',
  'periodReturnsStatus',
  'periodReturnsSource',
];

const QUOTE_VISUAL_FIELDS = ['sparklineData'];

const mergeRowsPreservingPeriods = (previousRows = [], nextRows = []) => {
  if (!Array.isArray(previousRows) || !Array.isArray(nextRows)) return nextRows;
  const previousBySymbol = new Map(previousRows.map((row) => [row?.symbol, row]));
  return nextRows.map((row) => {
    const previous = previousBySymbol.get(row?.symbol);
    if (!previous) return row;
    const merged = { ...previous, ...row };
    PERIOD_RETURN_FIELDS.forEach((field) => {
      if (row[field] == null && previous[field] != null) {
        merged[field] = previous[field];
      }
    });
    PERIOD_RETURN_METADATA_FIELDS.forEach((field) => {
      if (row[field] == null && previous[field] != null) {
        merged[field] = previous[field];
      }
    });
    QUOTE_VISUAL_FIELDS.forEach((field) => {
      if ((!Array.isArray(row[field]) || row[field].length === 0) && Array.isArray(previous[field]) && previous[field].length > 0) {
        merged[field] = previous[field];
      }
    });
    return merged;
  });
};

const mergeMarketDataPreservingPeriods = (previous = {}, next = {}) => {
  const merged = { ...previous, ...next };
  Object.entries(next || {}).forEach(([regionKey, regionValue]) => {
    if (Array.isArray(regionValue)) {
      merged[regionKey] = mergeRowsPreservingPeriods(previous?.[regionKey], regionValue);
      return;
    }
    if (regionValue && typeof regionValue === 'object') {
      merged[regionKey] = Object.fromEntries(
        Object.entries(regionValue).map(([tabKey, rows]) => [
          tabKey,
          mergeRowsPreservingPeriods(previous?.[regionKey]?.[tabKey], rows),
        ])
      );
    }
  });
  return merged;
};

const DEFAULT_OFFLINE_PORTFOLIO_DATA = {
  summary: {
    totalValue: 0,
    totalDayChange: 0,
    totalDayChangePercent: '0.00',
    totalGainLoss: 0,
    totalGainLossPercent: '0.00',
    positionCount: 0,
  },
  assetAllocation: {},
  topHoldings: [],
  holdings: [],
  lastUpdated: '—',
  dataSource: 'ibkr_offline',
  empty: true,
};

const sidebarTabCenteredLabelStyle = {
  position: 'absolute',
  left: 0,
  right: 0,
  textAlign: 'center',
  pointerEvents: 'none',
  fontSize: '15px',
  fontWeight: 400,
  lineHeight: 1,
  letterSpacing: 0,
};

const sidebarRailControlStyle = {
  minWidth: '56px',
  height: '44px',
  flexShrink: 0,
};

const sidebarRailIconStyle = {
  width: '26px',
  height: '26px',
  flexShrink: 0,
};

const sidebarRailTextStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: '100%',
  height: '100%',
  color: 'inherit',
  fontSize: '9px',
  fontWeight: 400,
  lineHeight: 1,
  letterSpacing: 0,
  textTransform: 'uppercase',
  whiteSpace: 'nowrap',
};

const PortfolioDashboard = ({ onOpenHowItWorks = () => { window.location.hash = '/how-it-works'; } }) => {
  const { theme } = useTheme();
  const [portfolioData, setPortfolioData] = useState(null);
  const [portfolioAccountsData, setPortfolioAccountsData] = useState([]);
  const [portfolioLoading, setPortfolioLoading] = useState(true);
  const [portfolioRefreshing, setPortfolioRefreshing] = useState(false);
  const [portfolioError, setPortfolioError] = useState(null);
  const [portfolioExposureReconciliation, setPortfolioExposureReconciliation] = useState(null);
  const [portfolioExposureReconciliationLoading, setPortfolioExposureReconciliationLoading] = useState(false);
  const [rtaPositions, setRtaPositions] = useState(null);
  const [etfProSnapshot, setEtfProSnapshot] = useState(null);
  const [etfProLoading, setEtfProLoading] = useState(true);
  const [etfProRefreshing, setEtfProRefreshing] = useState(false);
  const [etfProError, setEtfProError] = useState(null);
  const [predictionMarketProviderStatus, setPredictionMarketProviderStatus] = useState(null);
  const [hedgeyeChangelog, setHedgeyeChangelog] = useState(null);
  const [hedgeyeChangelogLoading, setHedgeyeChangelogLoading] = useState(true);
  const [hedgeyeChangelogError, setHedgeyeChangelogError] = useState(null);
  const [hedgeyeChangelogLastSuccessAt, setHedgeyeChangelogLastSuccessAt] = useState(null);
  const [selectedAccount, setSelectedAccount] = useState(() => loadSelectedAccount());
  const [ibkrAccounts, setIbkrAccounts] = useState([]);
  const ibkrAccountsRef = useRef([]);
  const selectedAccountRef = useRef(loadSelectedAccount());
  const [ibkrConnection, setIbkrConnection] = useState(null);
  const [providerStatus, setProviderStatus] = useState(null);
  const ibkrConnectionRef = useRef(null);
  const lastGoodProviderStatusRef = useRef(null);
  const portfolioDataRef = useRef(null);
  const persistedPanelState = useMemo(readDashboardPanelState, []);
  const [showPortfolioMetrics, setShowPortfolioMetrics] = useState(() => readPersistedBoolean(persistedPanelState, 'showPortfolioMetrics'));
  const [showPeaPodWindow, setShowPeaPodWindow] = useState(() => readPersistedBoolean(persistedPanelState, 'showPeaPodWindow'));
  const [showEVWindow, setShowEVWindow] = useState(() => readPersistedBoolean(persistedPanelState, 'showEVWindow'));
  const [showBookMenu, setShowBookMenu] = useState(false);
  const [showBookModal, setShowBookModal] = useState(false);
  const [selectedBookContent, setSelectedBookContent] = useState(null);
  const [selectedBookTitle, setSelectedBookTitle] = useState('');
  const [bookMenuPosition, setBookMenuPosition] = useState({ top: 0, right: 0 });
  const bookMenuRef = useRef(null);
  const bookPopoverRef = useRef(null);
  const [showWorkflowStatus, setShowWorkflowStatus] = useState(() => readPersistedBoolean(persistedPanelState, 'showWorkflowStatus'));
  const [analyticsRefreshKey, setAnalyticsRefreshKey] = useState(0);
  const [showSecuritiesUniverse, setShowSecuritiesUniverse] = useState(() => readPersistedBoolean(persistedPanelState, 'showSecuritiesUniverse'));
  const [showPerformanceTracking, setShowPerformanceTracking] = useState(() => readPersistedBoolean(persistedPanelState, 'showPerformanceTracking'));
  const [showCpiModel, setShowCpiModel] = useState(() => (
    readPersistedBoolean(persistedPanelState, 'showCpiModel') ||
    readPersistedBoolean(persistedPanelState, 'showPredictionMarkets')
  ));
  const [showSignalStrength, setShowSignalStrength] = useState(() => readPersistedBoolean(persistedPanelState, 'showSignalStrength'));
  const [showEtfPro, setShowEtfPro] = useState(() => readPersistedBoolean(persistedPanelState, 'showEtfPro'));
  const [showMacroShow, setShowMacroShow] = useState(() => readPersistedBoolean(persistedPanelState, 'showMacroShow'));
  const [showCall, setShowCall] = useState(() => readPersistedBoolean(persistedPanelState, 'showCall'));
  const [showPortfolioBreakdown, setShowPortfolioBreakdown] = useState(() => readPersistedBoolean(persistedPanelState, 'showPortfolioBreakdown'));
  const [sidebarPanelStack, setSidebarPanelStack] = useState(() => readPersistedSidebarStack(persistedPanelState));
  const [portfolioExpandedUp, setPortfolioExpandedUp] = useState(() => readPersistedBoolean(persistedPanelState, 'portfolioExpandedUp'));
  const [multiRegionMarketData, setMultiRegionMarketData] = useState({});
  const [multiRegionLoading, setMultiRegionLoading] = useState(true);
  const [multiRegionError, setMultiRegionError] = useState(null);
  const [bookContentMap, setBookContentMap] = useState(null);
  const [bookContentLoading, setBookContentLoading] = useState(false);

  const bringSidebarPanelToFront = useCallback((panelKey) => {
    setSidebarPanelStack((current) => [
      ...current.filter((key) => key !== panelKey),
      panelKey,
    ]);
  }, []);

  const removeSidebarPanelFromStack = useCallback((panelKey) => {
    setSidebarPanelStack((current) => current.filter((key) => key !== panelKey));
  }, []);

  const toggleSidebarPanel = useCallback((panelKey, setPanelVisible) => {
    setPanelVisible((isVisible) => {
      const nextVisible = !isVisible;

      if (nextVisible) {
        bringSidebarPanelToFront(panelKey);
      } else {
        removeSidebarPanelFromStack(panelKey);
      }

      return nextVisible;
    });
  }, [bringSidebarPanelToFront, removeSidebarPanelFromStack]);

  const closeSidebarPanel = useCallback((panelKey, setPanelVisible) => {
    setPanelVisible(false);
    removeSidebarPanelFromStack(panelKey);
  }, [removeSidebarPanelFromStack]);

  const getSidebarPanelZIndex = useCallback((panelKey, isVisible) => {
    if (!isVisible) return -1;

    const stackIndex = sidebarPanelStack.indexOf(panelKey);
    return SIDEBAR_PANEL_Z_INDEX_BASE + Math.max(stackIndex, 0);
  }, [sidebarPanelStack]);

  useEffect(() => {
    writeDashboardPanelState({
      showPortfolioMetrics,
      showPeaPodWindow,
      showEVWindow,
      showWorkflowStatus,
      showSecuritiesUniverse,
      showPerformanceTracking,
      showCpiModel,
      showSignalStrength,
      showEtfPro,
      showMacroShow,
      showCall,
      showPortfolioBreakdown,
      sidebarPanelStack,
      portfolioExpandedUp,
    });
  }, [
    showPortfolioMetrics,
    showPeaPodWindow,
    showEVWindow,
    showWorkflowStatus,
    showSecuritiesUniverse,
    showPerformanceTracking,
    showCpiModel,
    showSignalStrength,
    showEtfPro,
    showMacroShow,
    showCall,
    showPortfolioBreakdown,
    sidebarPanelStack,
    portfolioExpandedUp,
  ]);

  const fetchMultiRegionQuotes = useCallback(async ({ includePeriodReturns = false } = {}) => {
    try {
      const data = await MarketDataService.getMultiRegionQuotes(
        null,
        !includePeriodReturns,
        includePeriodReturns,
      );
      setMultiRegionMarketData((current) => mergeMarketDataPreservingPeriods(current, data));
      setMultiRegionLoading(false);
      setMultiRegionError(null);

      if (
        process.env.NODE_ENV === 'development' &&
        Array.isArray(data?.currencies) &&
        data.currencies.length > 0
      ) {
        const row = data.currencies[0];
        const hasPeriodRolling =
          Object.prototype.hasOwnProperty.call(row, 'thirtyDayChangePct') &&
          Object.prototype.hasOwnProperty.call(row, 'ninetyDayChangePct');
        const hasSomePeriodTail =
          row?.ytdChangePct != null || row?.weekChangePct != null || row?.monthChangePct != null;
        if (!hasPeriodRolling && hasSomePeriodTail) {
          console.warn(
            '[market-dashboard] Currencies API is missing thirtyDayChangePct/ninetyDayChangePct — the Node server is probably an old build. Restart from this repo (`npm run server` or `node server.js`). API base:',
            process.env.REACT_APP_BACKEND_URL || 'http://localhost:3001'
          );
        }
      }
    } catch (err) {
      console.error('Failed to fetch multi-region quotes:', err);
      // Quote rows influence interpretation and must not survive a failed
      // refresh as if they were still current. Historical return metadata is
      // rehydrated on the next successful response.
      setMultiRegionMarketData({});
      setMultiRegionError(err.message);
      setMultiRegionLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchMultiRegionQuotes({ includePeriodReturns: false });
    const cancelBackgroundHydration = scheduleBackgroundTask(() => {
      if (!cancelled) {
        fetchMultiRegionQuotes({ includePeriodReturns: true });
      }
    }, 1500);
    const currentQuotesInterval = setInterval(() => {
      fetchMultiRegionQuotes({ includePeriodReturns: false });
    }, 30000);
    const periodReturnsInterval = setInterval(() => {
      fetchMultiRegionQuotes({ includePeriodReturns: true });
    }, 15 * 60 * 1000);
    return () => {
      cancelled = true;
      cancelBackgroundHydration?.();
      clearInterval(currentQuotesInterval);
      clearInterval(periodReturnsInterval);
    };
  }, [fetchMultiRegionQuotes]);

  // Tag navigation state
  const [selectedTag, setSelectedTag] = useState(null);
  const bookContentRef = useRef(null);

  // The Pods search state
  const [podsSearchQuery, setPodsSearchQuery] = useState('');
  const [podsShowSearchResults, setPodsShowSearchResults] = useState(false);
  const [podsHighlightedIndex, setPodsHighlightedIndex] = useState(-1);
  const [podsSelectedSecurity, setPodsSelectedSecurity] = useState(null);
  const podsSearchInputRef = useRef(null);

  // Filter securities based on search query - searches entire universe
  const podsFilteredSecurities = useMemo(() => {
    if (!podsSearchQuery.trim()) {
      return [];
    }
    const query = podsSearchQuery.toLowerCase().trim();
    // Search across ALL securities in the universe
    return SECURITIES_LIST.filter(security =>
      security.ticker.toLowerCase().includes(query) ||
      security.name.toLowerCase().includes(query)
    ).slice(0, 15); // Limit to 15 results
  }, [podsSearchQuery]);

  // Handle security selection from search
  const handlePodsSecuritySelect = (security) => {
    setPodsSelectedSecurity(security);
    setPodsSearchQuery(`${security.ticker} - ${security.name}`);
    setPodsShowSearchResults(false);
    setPodsHighlightedIndex(-1);
    podsSearchInputRef.current?.blur();
  };

  const fetchPortfolio = useCallback(async (accountId, silent = false) => {
    const hasExistingPortfolio = Boolean(portfolioDataRef.current);
    const shouldShowInitialLoading = !silent && !hasExistingPortfolio;
    try {
      if (shouldShowInitialLoading) {
        setPortfolioLoading(true);
      } else {
        setPortfolioRefreshing(true);
      }
      setPortfolioError(null);
      const data = await MarketDataService.getPortfolio({ account: accountId || undefined });
      setPortfolioData(data);
      portfolioDataRef.current = data;
      return data;
    } catch (e) {
      if (!silent || !hasExistingPortfolio) {
        setPortfolioError(e.message || 'Failed to load portfolio');
      }
      throw e;
    } finally {
      if (shouldShowInitialLoading) {
        setPortfolioLoading(false);
      }
      setPortfolioRefreshing(false);
    }
  }, []);

  const fetchPortfolioAccounts = useCallback(async () => {
    try {
      const data = await MarketDataService.getPortfolioAccounts();
      setPortfolioAccountsData(Array.isArray(data) ? data : []);
      return data;
    } catch (e) {
      console.error('Failed to load portfolio account snapshots:', e);
      setPortfolioAccountsData((current) => current || []);
      return null;
    }
  }, []);

  const fetchPortfolioExposureReconciliation = useCallback(async () => {
    try {
      setPortfolioExposureReconciliationLoading(true);
      const data = await MarketDataService.getPortfolioExposureReconciliation();
      setPortfolioExposureReconciliation(data);
      return data;
    } catch (e) {
      console.error('Failed to load portfolio exposure reconciliation:', e);
      const unavailable = {
        status: 'error',
        source: 'ibkr_flex_web_service',
        error: e.message || 'Failed to load IBKR Flex reconciliation',
      };
      setPortfolioExposureReconciliation(unavailable);
      return unavailable;
    } finally {
      setPortfolioExposureReconciliationLoading(false);
    }
  }, []);

  const fetchRtaPositions = useCallback(async () => {
    try {
      const data = await MarketDataService.getRealTimeAlertPositions();
      setRtaPositions(data);
      return data;
    } catch (e) {
      console.error('Failed to load real-time alert positions:', e);
      setRtaPositions((current) => current || { available: false });
      return null;
    }
  }, []);

  const fetchEtfProSnapshot = useCallback(async (silent = false) => {
    if (silent) setEtfProRefreshing(true);
    else setEtfProLoading(true);
    setEtfProError(null);
    try {
      const data = await MarketDataService.getHedgeyeEtfPro();
      setEtfProSnapshot(data);
      return data;
    } catch (e) {
      console.error('Failed to load ETF Pro snapshot:', e);
      setEtfProError(e.message || 'Failed to load ETF Pro snapshot');
      setEtfProSnapshot((current) => current || { available: false, rows: [] });
      return null;
    } finally {
      setEtfProLoading(false);
      setEtfProRefreshing(false);
    }
  }, []);

  const fetchPredictionMarketProviderStatus = useCallback(async () => {
    try {
      const data = await predictionMarketsIngestService.getProviderStatus();
      setPredictionMarketProviderStatus(data);
      return data;
    } catch (e) {
      console.error('Failed to load prediction market provider status:', e);
      const errorStatus = { error: e.message || 'Failed to load prediction market provider status' };
      setPredictionMarketProviderStatus(errorStatus);
      return errorStatus;
    }
  }, []);

  const fetchHedgeyeChangelog = useCallback(async (silent = false) => {
    try {
      if (!silent) {
        setHedgeyeChangelogLoading(true);
      }
      setHedgeyeChangelogError(null);
      const data = await MarketDataService.getHedgeyeChangelog();
      setHedgeyeChangelog(data);
      setHedgeyeChangelogLastSuccessAt(new Date().toISOString());
      return data;
    } catch (e) {
      console.error('Failed to load Hedgeye changelog:', e);
      setHedgeyeChangelogError(e.message || 'Failed to load latest updates');
      setHedgeyeChangelog((current) => current || {});
      return null;
    } finally {
      if (!silent) {
        setHedgeyeChangelogLoading(false);
      }
    }
  }, []);

  const handleAccountChange = useCallback((accountId) => {
    saveSelectedAccount(accountId);
    selectedAccountRef.current = accountId || '';
    setSelectedAccount(accountId);
  }, []);

  const refreshProviderStatus = useCallback(async () => {
    try {
      const status = await withTimeout(
        MarketDataService.getProviderStatus(),
        PROVIDER_STATUS_TIMEOUT_MS,
        'Provider status',
      );
      if (isConnectedProviderStatus(status)) {
        lastGoodProviderStatusRef.current = status;
      }
      setProviderStatus(status);
      const list = status?.ibkr?.accounts || status?.portfolio?.ibkr?.accounts || [];
      if (Array.isArray(list) && list.length > 0) {
        ibkrAccountsRef.current = list;
        setIbkrAccounts(list);
        saveIbkrAccounts(list);
      } else if (portfolioDataRef.current?.dataSource === 'ibkr_offline') {
        ibkrAccountsRef.current = [];
        setIbkrAccounts([]);
      } else {
        setIbkrAccounts(ibkrAccountsRef.current);
      }
      setIbkrConnection(getIbkrConnectionDisplay({ status, error: null }));
      return status;
    } catch (err) {
      const lastGoodStatus = lastGoodProviderStatusRef.current;
      if (lastGoodStatus && (err?.code === 'ETIMEDOUT' || /timed out/i.test(err?.message || ''))) {
        const delayedStatus = {
          ...lastGoodStatus,
          statusRefreshDelayed: true,
          statusRefreshError: err.message,
          statusRefreshDelayedAt: new Date().toISOString(),
        };
        setProviderStatus(delayedStatus);
        const delayedConnection = getIbkrConnectionDisplay({ status: delayedStatus, error: null });
        setIbkrConnection({
          ...delayedConnection,
          statusRefreshDelayed: true,
          statusRefreshError: err.message,
          statusRefreshDelayedAt: delayedStatus.statusRefreshDelayedAt,
        });
        setIbkrAccounts(ibkrAccountsRef.current);
        return delayedStatus;
      }
      setProviderStatus({
        unavailable: true,
        error: err.message || 'Provider status unavailable',
        responseTimestamp: new Date().toISOString(),
        ibkr: { connected: false, status: 'offline' },
      });
      setIbkrConnection(getIbkrConnectionDisplay({ status: null, error: err.message }));
      if (portfolioDataRef.current?.dataSource === 'ibkr_offline') {
        ibkrAccountsRef.current = [];
        setIbkrAccounts([]);
      } else {
        setIbkrAccounts(ibkrAccountsRef.current);
      }
      throw err;
    }
  }, []);

  const resolvePortfolioAccount = useCallback((status = null) => {
    const explicit = selectedAccountRef.current || selectedAccount || '';
    if (status) {
      return getPreferredIbkrAccount(status, explicit) || undefined;
    }
    if (explicit) {
      return explicit;
    }
    return ibkrAccountsRef.current[0] || undefined;
  }, [selectedAccount]);

  useEffect(() => {
    ibkrConnectionRef.current = ibkrConnection;
  }, [ibkrConnection]);

  useEffect(() => {
    selectedAccountRef.current = selectedAccount || '';
  }, [selectedAccount]);

  const pollingFnsRef = useRef({});
  pollingFnsRef.current = {
    fetchPortfolio,
    fetchPortfolioAccounts,
    fetchPortfolioExposureReconciliation,
    fetchRtaPositions,
    fetchEtfProSnapshot,
    fetchPredictionMarketProviderStatus,
    fetchHedgeyeChangelog,
    handleAccountChange,
    refreshProviderStatus,
    resolvePortfolioAccount,
  };

  useEffect(() => {
    let cancelled = false;
    let cancelDeferredSecondary = null;

    const load = async () => {
      try {
        const status = await pollingFnsRef.current.refreshProviderStatus();
        if (cancelled) return;
        const acct = pollingFnsRef.current.resolvePortfolioAccount(status);
        if (acct && acct !== selectedAccountRef.current) {
          pollingFnsRef.current.handleAccountChange(acct);
        }
        try {
          await pollingFnsRef.current.fetchPortfolio(acct);
        } catch (err) {
          if (!cancelled) {
            setPortfolioError(err.message || 'Failed to load portfolio');
          }
        }
        cancelDeferredSecondary = scheduleBackgroundTask(() => {
          if (cancelled) return;
          Promise.allSettled([
            pollingFnsRef.current.fetchPortfolioAccounts(),
            pollingFnsRef.current.fetchPortfolioExposureReconciliation(),
            pollingFnsRef.current.fetchRtaPositions(),
            pollingFnsRef.current.fetchEtfProSnapshot(),
            pollingFnsRef.current.fetchPredictionMarketProviderStatus(),
            pollingFnsRef.current.fetchHedgeyeChangelog(),
          ]).catch(() => {});
        }, 1200);
      } catch (err) {
        if (!cancelled) {
          setPortfolioError(err.message || 'Failed to load portfolio');
          setPortfolioLoading(false);
        }
      }
    };

    load();

    const portfolioInterval = setInterval(() => {
      pollingFnsRef.current
        .fetchPortfolio(pollingFnsRef.current.resolvePortfolioAccount(), true)
        .catch(() => {});
    }, PORTFOLIO_POLL_MS);

    const portfolioAccountsInterval = setInterval(() => {
      pollingFnsRef.current.fetchPortfolioAccounts().catch(() => {});
    }, PORTFOLIO_ACCOUNTS_POLL_MS);

    const rtaInterval = setInterval(() => {
      pollingFnsRef.current.fetchRtaPositions().catch(() => {});
      pollingFnsRef.current.fetchPredictionMarketProviderStatus().catch(() => {});
      pollingFnsRef.current.fetchHedgeyeChangelog(true).catch(() => {});
    }, RTA_POLL_MS);

    const etfProInterval = setInterval(() => {
      pollingFnsRef.current.fetchEtfProSnapshot(true).catch(() => {});
    }, ETFPRO_POLL_MS);

    let statusTimeout;
    const scheduleStatusPoll = () => {
      const delay = ibkrConnectionRef.current?.connected
        ? PROVIDER_STATUS_POLL_MS
        : PROVIDER_STATUS_POLL_OFFLINE_MS;
      statusTimeout = setTimeout(async () => {
        try { await pollingFnsRef.current.refreshProviderStatus(); } catch {}
        if (!cancelled) scheduleStatusPoll();
      }, delay);
    };
    scheduleStatusPoll();

    return () => {
      cancelled = true;
      cancelDeferredSecondary?.();
      clearInterval(portfolioInterval);
      clearInterval(portfolioAccountsInterval);
      clearInterval(rtaInterval);
      clearInterval(etfProInterval);
      clearTimeout(statusTimeout);
    };
    // Polling callbacks are read from pollingFnsRef so UI state changes do not
    // tear down and recreate the dashboard's background refresh loops.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const handler = () => {
      fetchPortfolio(resolvePortfolioAccount(), true).catch(() => {});
      fetchPortfolioAccounts().catch(() => {});
      fetchPortfolioExposureReconciliation().catch(() => {});
      fetchRtaPositions().catch(() => {});
      fetchEtfProSnapshot(true).catch(() => {});
      fetchPredictionMarketProviderStatus().catch(() => {});
      fetchHedgeyeChangelog(true).catch(() => {});
    };
    window.addEventListener('portfolioRefresh', handler);
    return () => window.removeEventListener('portfolioRefresh', handler);
  }, [fetchPortfolio, fetchPortfolioAccounts, fetchPortfolioExposureReconciliation, fetchRtaPositions, fetchEtfProSnapshot, fetchPredictionMarketProviderStatus, fetchHedgeyeChangelog, resolvePortfolioAccount]);

  const handlePortfolioRefresh = useCallback(async () => {
    const account = resolvePortfolioAccount();
    const results = await Promise.allSettled([
      fetchPortfolio(account || undefined, true),
      fetchPortfolioAccounts(),
      fetchPortfolioExposureReconciliation(),
      fetchRtaPositions(),
      fetchEtfProSnapshot(true),
      fetchPredictionMarketProviderStatus(),
      fetchHedgeyeChangelog(),
    ]);
    const portfolioResult = results[0];
    if (portfolioResult.status === 'rejected') {
      setPortfolioError(portfolioResult.reason?.message || 'Failed to load portfolio');
    }
    try {
      await refreshProviderStatus();
    } catch {
      // Provider status has its own display state; keep manual refresh from surfacing
      // as an unhandled promise in the React development overlay.
    }
  }, [fetchPortfolio, fetchPortfolioAccounts, fetchPortfolioExposureReconciliation, fetchRtaPositions, fetchEtfProSnapshot, fetchPredictionMarketProviderStatus, fetchHedgeyeChangelog, refreshProviderStatus, resolvePortfolioAccount]);

  useEffect(() => {
    if (
      ibkrConnection?.connected &&
      portfolioData?.dataSource === 'ibkr_offline' &&
      !portfolioLoading
    ) {
      fetchPortfolio(resolvePortfolioAccount(), true).catch(
        () => {},
      );
    }
  }, [
    ibkrConnection?.connected,
    portfolioData?.dataSource,
    portfolioLoading,
    fetchPortfolio,
    resolvePortfolioAccount,
  ]);

  // Handle clicks outside book menu
  useEffect(() => {
    const handleClickOutside = (e) => {
      const clickedButton = bookMenuRef.current && bookMenuRef.current.contains(e.target);
      const clickedPopover = bookPopoverRef.current && bookPopoverRef.current.contains(e.target);
      if (!clickedButton && !clickedPopover) {
        setShowBookMenu(false);
      }
    };
    if (showBookMenu) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [showBookMenu]);

  // Calculate popover position when menu opens
  useEffect(() => {
    if (showBookMenu && bookMenuRef.current) {
      const buttonRect = bookMenuRef.current.getBoundingClientRect();
      setBookMenuPosition({
        top: buttonRect.top,
        right: window.innerWidth - buttonRect.left + 8, // Position to the left with 8px margin
      });
    }
  }, [showBookMenu]);

  // Book/Notes file configuration
  const bookFiles = [
    { name: 'The Coach', path: 'main/The Coach.md' },
    { name: 'The Process', path: 'main/The Process.md' },
    { name: 'The Playbook', path: 'main/The Playbook.md' },
    { name: 'Stop Losses', path: 'main/Stop Losses.md' }
  ];

  const openBookFile = async (fileName) => {
    let contentMap = bookContentMap;
    if (!contentMap) {
      setBookContentLoading(true);
      try {
        const module = await import('../../constants/bookContent');
        contentMap = module.bookContent || module.default || {};
        setBookContentMap(contentMap);
      } catch (err) {
        console.error('Failed to load book content:', err);
        setBookContentLoading(false);
        return;
      } finally {
        setBookContentLoading(false);
      }
    }

    const content = contentMap[fileName];
    if (content) {
      setSelectedBookContent(content);
      setSelectedBookTitle(fileName);
      setShowBookModal(true);
      setShowBookMenu(false);
      setSelectedTag(null); // Reset selected tag when opening new file
    } else {
      console.error('Book content not found:', fileName);
    }
  };

  // Extract all unique tags from content
  const extractTags = (content) => {
    if (!content) return [];
    const tagRegex = /#(\w+)/g;
    const matches = content.match(tagRegex);
    if (!matches) return [];
    const uniqueTags = [...new Set(matches.map(tag => tag.substring(1)))]; // Remove # prefix
    return uniqueTags.sort();
  };

  // Parse content into sections and map tags to sections
  const parseContentSections = (content) => {
    if (!content) return { sections: [], tagMap: {} };

    const lines = content.split('\n');
    const sections = [];
    const tagMap = {};
    let currentSection = null;
    let currentSectionIndex = 0;

    lines.forEach((line, index) => {
      // Check if line is a heading
      const h2Match = line.match(/^## (.+)$/);
      const h3Match = line.match(/^### (.+)$/);
      const h4Match = line.match(/^#### (.+)$/);

      if (h2Match || h3Match || h4Match) {
        // Save previous section if exists
        if (currentSection) {
          sections.push(currentSection);
        }

        // Start new section
        const title = h2Match ? h2Match[1] : (h3Match ? h3Match[1] : h4Match[1]);
        const sectionId = `section-${currentSectionIndex}`;
        currentSection = {
          id: sectionId,
          title: title.trim(),
          level: h2Match ? 2 : (h3Match ? 3 : 4),
          startLine: index,
          content: line + '\n',
          tags: []
        };
        currentSectionIndex++;
      } else if (currentSection) {
        // Add line to current section
        currentSection.content += line + '\n';

        // Extract tags from this line
        const tagRegex = /#(\w+)/g;
        const matches = line.match(tagRegex);
        if (matches) {
          matches.forEach(tag => {
            const tagName = tag.substring(1);
            if (!currentSection.tags.includes(tagName)) {
              currentSection.tags.push(tagName);
            }
            if (!tagMap[tagName]) {
              tagMap[tagName] = [];
            }
            if (!tagMap[tagName].find(s => s.id === currentSection.id)) {
              tagMap[tagName].push({
                id: currentSection.id,
                title: currentSection.title,
                level: currentSection.level,
                snippet: line.substring(0, 100).trim() // First 100 chars as snippet
              });
            }
          });
        }
      }
    });

    // Add last section
    if (currentSection) {
      sections.push(currentSection);
    }

    return { sections, tagMap };
  };

  // Count total occurrences of each tag
  const countTagOccurrences = (content, tagName) => {
    if (!content) return 0;
    const tagRegex = new RegExp(`#${tagName}\\b`, 'g');
    const matches = content.match(tagRegex);
    return matches ? matches.length : 0;
  };

  // Memoize tags and sections parsing
  const { tags, sections, tagSectionsMap, tagCounts } = useMemo(() => {
    if (!selectedBookContent) {
      return { tags: [], sections: [], tagSectionsMap: {}, tagCounts: {} };
    }
    const extractedTags = extractTags(selectedBookContent);
    const { sections: parsedSections, tagMap } = parseContentSections(selectedBookContent);

    // Count total occurrences for each tag
    const counts = {};
    extractedTags.forEach(tag => {
      counts[tag] = countTagOccurrences(selectedBookContent, tag);
    });

    return {
      tags: extractedTags,
      sections: parsedSections,
      tagSectionsMap: tagMap,
      tagCounts: counts
    };
  }, [selectedBookContent]);

  // Scroll to section
  const scrollToSection = (sectionId) => {
    if (bookContentRef.current) {
      const element = bookContentRef.current.querySelector(`#${sectionId}`);
      if (element) {
        element.scrollIntoView({ behavior: 'smooth', block: 'start' });
        // Highlight briefly
        element.style.backgroundColor = theme === 'dark' ? 'rgba(59, 130, 246, 0.3)' : 'rgba(59, 130, 246, 0.1)';
        setTimeout(() => {
          element.style.backgroundColor = 'transparent';
        }, 2000);
      }
    }
  };

  const displayData = portfolioData || DEFAULT_OFFLINE_PORTFOLIO_DATA;
  return (
    <div
      data-testid="dashboard-shell"
      className="dashboard-shell min-h-screen p-2 bg-[#eef6fb] dark:bg-gray-900"
      style={{
        '--dashboard-rail-collapsed-width': DASHBOARD_RAIL_COLLAPSED_WIDTH,
        '--dashboard-rail-expanded-width': DASHBOARD_RAIL_EXPANDED_WIDTH,
        '--dashboard-rail-control-width': '56px',
        '--dashboard-rail-control-height': '44px',
        '--dashboard-rail-icon-size': '26px',
        '--dashboard-active-rail-width': showPortfolioMetrics
          ? DASHBOARD_RAIL_EXPANDED_WIDTH
          : DASHBOARD_RAIL_COLLAPSED_WIDTH,
        paddingBottom: '8px',
        paddingRight: showPortfolioMetrics ? '0px' : 'var(--dashboard-rail-collapsed-width)',
        transition: 'padding-right 0.3s ease-in-out',
      }}
    >
      <Grid numItems={12} className="gap-1.5">
        <div
          className="col-span-12"
          style={{
            marginRight: showPortfolioMetrics ? '0px' : '8px',
            transition: 'all 0.3s ease-in-out',
            minWidth: 0,
          }}
        >
          <USDMacroDashboard
            multiRegionMarketData={multiRegionMarketData}
            multiRegionLoading={multiRegionLoading}
            multiRegionError={multiRegionError}
            providerStatus={providerStatus}
            ibkrConnection={ibkrConnection}
          />
        </div>

        {/* Right Sidebar - Portfolio Metrics (removed from grid, now in vertical bar) */}
      </Grid>

      {/* Vertical Portfolio Bar - Always Visible */}
      <div
        data-testid="dashboard-right-rail"
        style={{
          position: 'fixed',
          top: 0,
          right: 0,
          width: 'var(--dashboard-active-rail-width)',
          height: '100vh',
          zIndex: showPortfolioMetrics ? 1100 : 1000,
          backgroundColor: theme === 'dark' ? '#111827' : '#ffffff',
          color: theme === 'dark' ? '#e5e7eb' : '#333333',
          borderLeft: `1px solid ${theme === 'dark' ? '#374151' : '#e5e7eb'}`,
          borderRight: 'none',
          borderTop: 'none',
          borderBottom: 'none',
          borderRadius: '1rem 0 0 1rem',
          boxShadow: showPortfolioMetrics
            ? `-2px 0 10px ${theme === 'dark' ? 'rgba(0, 0, 0, 0.28)' : 'rgba(0, 0, 0, 0.08)'}`
            : `-2px 0 10px ${theme === 'dark' ? 'rgba(0, 0, 0, 0.28)' : 'rgba(0, 0, 0, 0.08)'}`,
          transition: 'width 0.3s ease-in-out, border-radius 0.3s ease-in-out',
          display: 'flex',
          flexDirection: 'column',
          fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "Roboto", "Oxygen", "Ubuntu", "Cantarell", "Fira Sans", "Droid Sans", "Helvetica Neue", sans-serif',
        }}
        className="dark:bg-gray-900 dark:border-gray-700"
      >
        {/* Top Section - Dashboard Navigation */}
        <div
          data-testid="dashboard-rail-navigation"
          style={{
            padding: '12px 10px',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            borderBottom: `1px solid ${theme === 'dark' ? '#374151' : '#e5e7eb'}`,
            minHeight: '120px',
            flex: showPortfolioMetrics ? '0 1 54vh' : '1 1 auto',
            maxHeight: showPortfolioMetrics ? '560px' : 'none',
            overflowY: 'auto',
            overflowX: 'hidden',
            scrollbarWidth: 'thin',
          }}
          className="dark:border-gray-700"
        >
          {/* X/Twitter Logo Button */}
          <button
            onClick={() => window.open('https://x.com/i/lists/1986465259113357401', '_blank', 'noopener,noreferrer')}
            className="rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors w-full"
            style={{
              ...sidebarRailControlStyle,
              padding: showPortfolioMetrics ? '0 14px' : '0',
              display: 'flex',
              alignItems: 'center',
              justifyContent: showPortfolioMetrics ? 'flex-start' : 'center',
              position: showPortfolioMetrics ? 'relative' : undefined,
            }}
            title="Open X (Twitter) List"
          >
            <div style={{ ...sidebarRailIconStyle, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" className="text-gray-700 dark:text-gray-300 shrink-0">
                <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
              </svg>
            </div>
            {showPortfolioMetrics && (
              <span className="text-gray-700 dark:text-gray-200 whitespace-nowrap" style={sidebarTabCenteredLabelStyle}>
                X.com
              </span>
            )}
          </button>

          {/* The Pods Button */}
          <button
            onClick={() => toggleSidebarPanel('pods', setShowPeaPodWindow)}
            className={`rounded-lg border transition-colors w-full mt-2 ${showPeaPodWindow
              ? 'bg-gray-100 border-gray-300 dark:bg-blue-600 hover:bg-gray-200 dark:hover:bg-blue-700 text-[#111]'
              : 'bg-white border-gray-200 dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700 dark:border-gray-600'
              }`}
            style={{
              ...sidebarRailControlStyle,
              padding: showPortfolioMetrics ? '0 14px' : '0',
              display: 'flex',
              alignItems: 'center',
              justifyContent: showPortfolioMetrics ? 'flex-start' : 'center',
              position: showPortfolioMetrics ? 'relative' : undefined,
              overflow: 'hidden',
            }}
            title="The Pods"
          >
            <div className="shrink-0 flex items-center justify-center" style={sidebarRailIconStyle}>
              <span style={sidebarRailTextStyle}>PODS</span>
            </div>
            {showPortfolioMetrics && (
              <span className={`whitespace-nowrap ${showPeaPodWindow ? 'text-[#111]' : 'text-gray-700 dark:text-gray-200'}`} style={sidebarTabCenteredLabelStyle}>
                PODS
              </span>
            )}
          </button>

          {/* +EV Button */}
          <button
            onClick={() => toggleSidebarPanel('ev', setShowEVWindow)}
            className={`rounded-lg border transition-colors w-full mt-2 ${showEVWindow
              ? 'bg-gray-100 border-gray-300 dark:bg-blue-600 hover:bg-gray-200 dark:hover:bg-blue-700 text-[#111]'
              : 'bg-white border-gray-200 dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700 dark:border-gray-600'
              }`}
            style={{
              ...sidebarRailControlStyle,
              padding: showPortfolioMetrics ? '0 14px' : '0',
              display: 'flex',
              alignItems: 'center',
              justifyContent: showPortfolioMetrics ? 'flex-start' : 'center',
              position: showPortfolioMetrics ? 'relative' : undefined,
              overflow: 'hidden',
            }}
            title="Expected Values"
          >
            <div className="shrink-0 flex items-center justify-center" style={sidebarRailIconStyle}>
              <span className={showEVWindow ? 'text-[#111]' : 'text-black dark:text-white'} style={sidebarRailTextStyle}>+EV</span>
            </div>
            {showPortfolioMetrics && (
              <span className={`whitespace-nowrap ${showEVWindow ? 'text-[#111]' : 'text-gray-700 dark:text-gray-200'}`} style={sidebarTabCenteredLabelStyle}>
                +EV Data
              </span>
            )}
          </button>

          {/* Book/Notes Button */}
          <button
            ref={bookMenuRef}
            onClick={() => setShowBookMenu(!showBookMenu)}
            className="rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors w-full mt-2"
            style={{
              ...sidebarRailControlStyle,
              padding: showPortfolioMetrics ? '0 14px' : '0',
              display: 'flex',
              alignItems: 'center',
              justifyContent: showPortfolioMetrics ? 'flex-start' : 'center',
              position: showPortfolioMetrics ? 'relative' : undefined,
              overflow: 'hidden',
            }}
            title="Open Notes"
          >
            <div className="shrink-0 flex items-center justify-center" style={sidebarRailIconStyle}>
              <span style={sidebarRailTextStyle}>NOTES</span>
            </div>
            {showPortfolioMetrics && (
              <span className="text-gray-700 dark:text-gray-200 whitespace-nowrap" style={sidebarTabCenteredLabelStyle}>
                NOTES
              </span>
            )}
          </button>

          {/* How It Works Button */}
          <button
            type="button"
            onClick={() => {
              setShowBookMenu(false);
              onOpenHowItWorks();
            }}
            className="rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors w-full mt-2"
            style={{
              ...sidebarRailControlStyle,
              padding: showPortfolioMetrics ? '0 14px' : '0',
              display: 'flex',
              alignItems: 'center',
              justifyContent: showPortfolioMetrics ? 'flex-start' : 'center',
              position: showPortfolioMetrics ? 'relative' : undefined,
              overflow: 'hidden',
            }}
            title="How It Works"
            aria-label="How It Works"
          >
            <div className="shrink-0 flex items-center justify-center" style={sidebarRailIconStyle}>
              <svg
                width="25"
                height="25"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <circle cx="6" cy="6" r="2.25" />
                <circle cx="18" cy="6" r="2.25" />
                <circle cx="12" cy="18" r="2.25" />
                <path d="M8.2 6h7.6M7.5 8l3.2 7.8M16.5 8l-3.2 7.8" />
              </svg>
            </div>
            {showPortfolioMetrics && (
              <span className="text-[15px] font-medium text-gray-700 dark:text-gray-200 whitespace-nowrap" style={sidebarTabCenteredLabelStyle}>
                How It Works
              </span>
            )}
          </button>

          {/* Popover Menu */}
          {showBookMenu && (
            <div
              ref={bookPopoverRef}
              style={{
                position: 'fixed',
                top: `${bookMenuPosition.top}px`,
                right: `${bookMenuPosition.right}px`,
                minWidth: '180px',
                backgroundColor: theme === 'dark' ? '#1f2937' : '#ffffff',
                border: `1px solid ${theme === 'dark' ? '#374151' : '#e5e7eb'}`,
                borderRadius: '0.375rem',
                boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.08), 0 2px 4px -1px rgba(0, 0, 0, 0.04)',
                zIndex: 1000,
                padding: '4px 0',
                fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "Roboto", "Oxygen", "Ubuntu", "Cantarell", "Fira Sans", "Droid Sans", "Helvetica Neue", sans-serif',
              }}
            >
              {bookFiles.map((file, index) => (
                <button
                  key={index}
                  onClick={() => openBookFile(file.name)}
                  disabled={bookContentLoading}
                  style={{
                    width: '100%',
                    textAlign: 'left',
                    padding: '8px 12px',
                    fontSize: '14px',
                    color: theme === 'dark' ? '#f3f4f6' : '#111',
                    backgroundColor: 'transparent',
                    border: 'none',
                    cursor: bookContentLoading ? 'wait' : 'pointer',
                    opacity: bookContentLoading ? 0.7 : 1,
                  }}
                  className="hover:bg-gray-100 dark:hover:bg-gray-700"
                  onMouseEnter={(e) => {
                    e.target.style.backgroundColor = theme === 'dark' ? '#374151' : '#f3f4f6';
                  }}
                  onMouseLeave={(e) => {
                    e.target.style.backgroundColor = 'transparent';
                  }}
                >
                  {bookContentLoading ? 'Loading...' : file.name}
                </button>
              ))}
            </div>
          )}

          {/* Separator for Main Navigation Buttons */}
          <div style={{
            width: '100%',
            height: '1px',
            backgroundColor: theme === 'dark' ? '#374151' : '#e5e7eb',
            margin: '12px 0 8px 0'
          }} />

          {/* Portfolio Breakdown Button */}
          <button
            onClick={() => toggleSidebarPanel('portfolio', setShowPortfolioBreakdown)}
            className={`rounded-lg border transition-colors w-full ${showPortfolioBreakdown
              ? 'bg-gray-100 border-gray-300 dark:bg-blue-600 hover:bg-gray-200 dark:hover:bg-blue-700 text-[#111]'
              : 'bg-white border-gray-200 dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700 dark:border-gray-600'
              }`}
            style={{
              ...sidebarRailControlStyle,
              padding: showPortfolioMetrics ? '0 14px' : '0',
              display: 'flex',
              alignItems: 'center',
              justifyContent: showPortfolioMetrics ? 'flex-start' : 'center',
              position: showPortfolioMetrics ? 'relative' : undefined,
              overflow: 'hidden',
              marginTop: '4px',
            }}
            title="Portfolio Breakdown"
          >
            <div className="shrink-0 flex items-center justify-center" style={sidebarRailIconStyle}>
              <span style={sidebarRailTextStyle}>PORTFOLIO</span>
            </div>
            {showPortfolioMetrics && (
              <span className={`whitespace-nowrap ${showPortfolioBreakdown ? 'text-[#111]' : 'text-[#333] dark:text-gray-200'}`} style={sidebarTabCenteredLabelStyle}>
                Portfolio
              </span>
            )}
          </button>

          {/* Securities Universe Button */}
          <button
            onClick={() => toggleSidebarPanel('securities', setShowSecuritiesUniverse)}
            className={`rounded-lg border transition-colors w-full ${showSecuritiesUniverse
              ? 'bg-gray-100 border-gray-300 dark:bg-blue-600 hover:bg-gray-200 dark:hover:bg-blue-700 text-[#111]'
              : 'bg-white border-gray-200 dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700 dark:border-gray-600'
              }`}
            style={{
              ...sidebarRailControlStyle,
              padding: showPortfolioMetrics ? '0 14px' : '0',
              display: 'flex',
              alignItems: 'center',
              justifyContent: showPortfolioMetrics ? 'flex-start' : 'center',
              position: showPortfolioMetrics ? 'relative' : undefined,
              overflow: 'hidden',
              marginTop: '4px',
            }}
            title="Securities Universe"
          >
            <div className="shrink-0 flex items-center justify-center" style={sidebarRailIconStyle}>
              <span style={sidebarRailTextStyle}>SECURITIES</span>
            </div>
            {showPortfolioMetrics && (
              <span className={`whitespace-nowrap ${showSecuritiesUniverse ? 'text-[#111]' : 'text-[#333] dark:text-gray-200'}`} style={sidebarTabCenteredLabelStyle}>
                Securities Universe
              </span>
            )}
          </button>

          {/* CPI Button */}
          <button
            onClick={() => toggleSidebarPanel('cpi', setShowCpiModel)}
            className={`rounded-lg border transition-colors w-full ${showCpiModel
              ? 'bg-gray-100 border-gray-300 dark:bg-blue-600 hover:bg-gray-200 dark:hover:bg-blue-700 text-[#111] dark:text-white'
              : 'bg-white border-gray-200 dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700 dark:border-gray-600 text-[#333] dark:text-gray-200'
              }`}
            style={{
              ...sidebarRailControlStyle,
              padding: showPortfolioMetrics ? '0 14px' : '0',
              display: 'flex',
              alignItems: 'center',
              justifyContent: showPortfolioMetrics ? 'flex-start' : 'center',
              position: showPortfolioMetrics ? 'relative' : undefined,
              overflow: 'hidden',
              marginTop: '4px',
            }}
            title="CPI"
          >
            <div className="shrink-0 flex items-center justify-center" style={sidebarRailIconStyle}>
              <span style={sidebarRailTextStyle} aria-hidden="true">
                CPI
              </span>
            </div>
            {showPortfolioMetrics && (
              <span className={`whitespace-nowrap ${showCpiModel ? 'text-[#111]' : 'text-[#333] dark:text-gray-200'}`} style={sidebarTabCenteredLabelStyle}>
                CPI
              </span>
            )}
          </button>

          {/* Signal Strength Button */}
          <button
            onClick={() => toggleSidebarPanel('ss', setShowSignalStrength)}
            className={`rounded-lg border transition-colors w-full ${showSignalStrength
              ? 'bg-gray-100 border-gray-300 dark:bg-blue-600 hover:bg-gray-200 dark:hover:bg-blue-700 text-[#111] dark:text-white'
              : 'bg-white border-gray-200 dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700 dark:border-gray-600 text-[#333] dark:text-gray-200'
              }`}
            style={{
              ...sidebarRailControlStyle,
              padding: showPortfolioMetrics ? '0 14px' : '0',
              display: 'flex',
              alignItems: 'center',
              justifyContent: showPortfolioMetrics ? 'flex-start' : 'center',
              position: showPortfolioMetrics ? 'relative' : undefined,
              overflow: 'hidden',
              marginTop: '4px',
            }}
            title="Signal Strength"
          >
            <div className="shrink-0 flex items-center justify-center" style={sidebarRailIconStyle}>
              <span style={{ ...sidebarRailTextStyle, flexDirection: 'column' }} aria-hidden="true">
                <span>Signal</span>
                <span>Strength</span>
              </span>
            </div>
            {showPortfolioMetrics && (
              <span className={`whitespace-nowrap ${showSignalStrength ? 'text-[#111]' : 'text-[#333] dark:text-gray-200'}`} style={sidebarTabCenteredLabelStyle}>Signal Strength</span>
            )}
          </button>

          {/* ETF Pro Button */}
          <button
            onClick={() => toggleSidebarPanel('etfPro', setShowEtfPro)}
            className={`rounded-lg border transition-colors w-full ${showEtfPro
              ? 'bg-gray-100 border-gray-300 dark:bg-blue-600 hover:bg-gray-200 dark:hover:bg-blue-700 text-[#111] dark:text-white'
              : 'bg-white border-gray-200 dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700 dark:border-gray-600 text-[#333] dark:text-gray-200'
              }`}
            style={{
              ...sidebarRailControlStyle,
              padding: showPortfolioMetrics ? '0 14px' : '0',
              display: 'flex',
              alignItems: 'center',
              justifyContent: showPortfolioMetrics ? 'flex-start' : 'center',
              position: showPortfolioMetrics ? 'relative' : undefined,
              overflow: 'hidden',
              marginTop: '4px',
            }}
            title="ETF Pro"
          >
            <div className="shrink-0 flex items-center justify-center" style={sidebarRailIconStyle}>
              <span style={sidebarRailTextStyle} aria-hidden="true">ETF Pro</span>
            </div>
            {showPortfolioMetrics && (
              <span className={`whitespace-nowrap ${showEtfPro ? 'text-[#111]' : 'text-[#333] dark:text-gray-200'}`} style={sidebarTabCenteredLabelStyle}>ETF Pro</span>
            )}
          </button>

          {/* Macro Show Button */}
          <button
            onClick={() => toggleSidebarPanel('macroShow', setShowMacroShow)}
            className={`rounded-lg border transition-colors w-full ${showMacroShow
              ? 'bg-gray-100 border-gray-300 dark:bg-blue-600 hover:bg-gray-200 dark:hover:bg-blue-700 text-[#111] dark:text-white'
              : 'bg-white border-gray-200 dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700 dark:border-gray-600 text-[#333] dark:text-gray-200'
              }`}
            style={{
              ...sidebarRailControlStyle,
              padding: showPortfolioMetrics ? '0 14px' : '0',
              display: 'flex',
              alignItems: 'center',
              justifyContent: showPortfolioMetrics ? 'flex-start' : 'center',
              position: showPortfolioMetrics ? 'relative' : undefined,
              overflow: 'hidden',
              marginTop: '4px',
            }}
            title="Macro Show"
          >
            <div className="shrink-0 flex items-center justify-center" style={sidebarRailIconStyle} aria-hidden="true">
              <span style={{ ...sidebarRailTextStyle, flexDirection: 'column' }}>
                <span>Macro</span>
                <span>Show</span>
              </span>
            </div>
            {showPortfolioMetrics && (
              <span className={`whitespace-nowrap ${showMacroShow ? 'text-[#111]' : 'text-[#333] dark:text-gray-200'}`} style={sidebarTabCenteredLabelStyle}>Macro Show</span>
            )}
          </button>

          {/* Call Button */}
          <button
            onClick={() => toggleSidebarPanel('call', setShowCall)}
            className={`rounded-lg border transition-colors w-full ${showCall
              ? 'bg-gray-100 border-gray-300 dark:bg-blue-600 hover:bg-gray-200 dark:hover:bg-blue-700 text-[#111] dark:text-white'
              : 'bg-white border-gray-200 dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700 dark:border-gray-600 text-[#333] dark:text-gray-200'
              }`}
            style={{
              ...sidebarRailControlStyle,
              padding: showPortfolioMetrics ? '0 14px' : '0',
              display: 'flex',
              alignItems: 'center',
              justifyContent: showPortfolioMetrics ? 'flex-start' : 'center',
              position: showPortfolioMetrics ? 'relative' : undefined,
              overflow: 'hidden',
              marginTop: '4px',
            }}
            title="Call"
          >
            <div className="shrink-0 flex items-center justify-center" style={sidebarRailIconStyle}>
              <span style={sidebarRailTextStyle} aria-hidden="true">Call</span>
            </div>
            {showPortfolioMetrics && (
              <span className={`whitespace-nowrap ${showCall ? 'text-[#111]' : 'text-[#333] dark:text-gray-200'}`} style={sidebarTabCenteredLabelStyle}>Call</span>
            )}
          </button>

          {/* Expand/Collapse Portfolio Bar Button */}
          <button
            onClick={() => setShowPortfolioMetrics(!showPortfolioMetrics)}
            className="rounded-lg border border-blue-500 dark:border-blue-400 bg-white dark:bg-gray-800 hover:bg-blue-50 dark:hover:bg-gray-700 transition-colors mt-2"
            title={showPortfolioMetrics ? "Collapse Portfolio" : "Expand Portfolio"}
            style={{
              width: '48px',
              height: '40px',
              padding: '0',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              marginTop: '8px',
              alignSelf: 'center',
              flexShrink: 0,
            }}
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 16 16"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
              className="text-blue-600 dark:text-blue-400"
            >
              <path
                d={showPortfolioMetrics ? "M6 12L10 8L6 4" : "M10 12L6 8L10 4"}
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>

        {/* Expanded Content Area */}
        {showPortfolioMetrics && (
          <div
            className={`portfolio-sidebar-panel dashboard-stable-panel${portfolioExpandedUp ? ' bg-white dark:bg-gray-900' : ''}`}
            style={portfolioExpandedUp ? {
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              bottom: '58px',
              zIndex: 10,
              overflowY: 'hidden',
            } : { flex: 1, minHeight: 0 }}
          >
            <div className="portfolio-metrics-panel">
              {portfolioError && (
                <Text className="text-xs text-blue-600 dark:text-blue-400 mb-2">{portfolioError}</Text>
              )}
              <PortfolioSidebarSnapshot
                portfolioData={displayData}
                portfolioAccountsData={portfolioAccountsData}
                loading={portfolioLoading}
                refreshing={portfolioRefreshing}
                rtaPositions={rtaPositions}
                etfProSnapshot={etfProSnapshot}
                exposureReconciliation={portfolioExposureReconciliation}
                exposureReconciliationLoading={portfolioExposureReconciliationLoading}
                predictionMarketProviderStatus={predictionMarketProviderStatus}
                hedgeyeChangelog={hedgeyeChangelog}
                hedgeyeChangelogLoading={hedgeyeChangelogLoading}
                hedgeyeChangelogError={hedgeyeChangelogError}
                hedgeyeChangelogLastSuccessAt={hedgeyeChangelogLastSuccessAt}
                accounts={ibkrAccounts}
                connection={ibkrConnection}
                selectedAccount={selectedAccount}
                onAccountChange={handleAccountChange}
                onRefresh={handlePortfolioRefresh}
                expandedUp={portfolioExpandedUp}
                onToggleExpandUp={() => setPortfolioExpandedUp(v => !v)}
              />
            </div>
          </div>
        )}

        {/* Analytics Button - Docked at Bottom of Portfolio Bar */}
        <div
          style={{
            marginTop: 'auto',
            padding: '10px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderTop: `1px solid ${theme === 'dark' ? '#374151' : '#e5e7eb'}`,
          }}
          className="dark:border-gray-700"
        >
          <button
            onClick={() => toggleSidebarPanel('analytics', setShowWorkflowStatus)}
            className={`rounded-lg border transition-colors w-full ${showWorkflowStatus
              ? 'bg-gray-100 border-gray-300 dark:bg-blue-600 hover:bg-gray-200 dark:hover:bg-blue-700 text-[#111]'
              : 'bg-white border-gray-200 dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700 dark:border-gray-600'
              }`}
            style={{
              ...sidebarRailControlStyle,
              padding: showPortfolioMetrics ? '0 14px' : '0',
              display: 'flex',
              alignItems: 'center',
              justifyContent: showPortfolioMetrics ? 'flex-start' : 'center',
              position: showPortfolioMetrics ? 'relative' : undefined,
              overflow: 'hidden',
            }}
            title="Analytics"
          >
            <div className="shrink-0 flex items-center justify-center" style={sidebarRailIconStyle}>
              <span style={sidebarRailTextStyle}>ANALYTICS</span>
            </div>
            {showPortfolioMetrics && (
              <span className={`whitespace-nowrap ${showWorkflowStatus ? 'text-[#111]' : 'text-[#333] dark:text-gray-200'}`} style={sidebarTabCenteredLabelStyle}>
                Analytics
              </span>
            )}
          </button>
        </div>
      </div>

      {/* Expected Values Window */}
      {showEVWindow && (
        <Suspense fallback={<LazyPanelFallback label="Loading +EV..." />}>
          <ExpectedValuesWindow
            show={showEVWindow}
            onClose={() => closeSidebarPanel('ev', setShowEVWindow)}
            top={0}
            right="var(--dashboard-active-rail-width)"
            width="calc(100vw - var(--dashboard-active-rail-width))"
            theme={theme}
            zIndex={getSidebarPanelZIndex('ev', showEVWindow)}
            showPortfolioMetrics={showPortfolioMetrics}
          />
        </Suspense>
      )}

      {/* The Pods Window - Separate Pop-out Panel */}
      <div
        style={{
          position: 'fixed',
          top: 0,
          right: 'var(--dashboard-active-rail-width)',
          width: showPeaPodWindow
            ? 'var(--dashboard-rail-expanded-width)'
            : '0px',
          height: '100vh',
          zIndex: getSidebarPanelZIndex('pods', showPeaPodWindow),
          backgroundColor: '#ffffff',
          borderLeft: showPeaPodWindow ? '1px solid #e5e7eb' : 'none',
          borderRight: showPeaPodWindow ? '1px solid #e5e7eb' : 'none',
          borderRadius: showPeaPodWindow ? '0.75rem 0 0 0' : '0',
          boxShadow: showPeaPodWindow
            ? '-2px 0 8px rgba(0, 0, 0, 0.08), 2px 0 8px rgba(0, 0, 0, 0.08)'
            : 'none',
          transition: 'width 0.3s ease-in-out, right 0.3s ease-in-out, border-radius 0.3s ease-in-out',
          display: showPeaPodWindow ? 'flex' : 'none',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
        className="dark:bg-gray-900 dark:border-gray-700"
      >
        {showPeaPodWindow && (
          <>
            {/* Header with Centered Title (Clickable to Close) */}
            <div
              style={{
                padding: '12px 16px',
                display: 'flex',
                justifyContent: 'center',
                alignItems: 'center',
                borderBottom: '1px solid #e5e7eb',
                backgroundColor: '#f9fafb',
                cursor: 'pointer',
              }}
              className="dark:border-gray-700"
              onClick={() => closeSidebarPanel('pods', setShowPeaPodWindow)}
            >
              <Title
                className="dark:text-white"
                style={{
                  fontSize: '18px',
                  fontWeight: 700,
                  color: '#000',
                  margin: 0,
                  userSelect: 'none',
                  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "Roboto", "Oxygen", "Ubuntu", "Cantarell", "Fira Sans", "Droid Sans", "Helvetica Neue", sans-serif',
                }}
              >
                The Pods
              </Title>
            </div>

            {/* Scrollable Content */}
            <div
              style={{
                flex: 1,
                overflowY: 'auto',
                padding: '16px',
              }}
            >
              {/* Securities Search Box */}
              <div className="relative mb-4" style={{ width: '100%', maxWidth: '400px' }}>
                <input
                  ref={podsSearchInputRef}
                  type="text"
                  value={podsSearchQuery}
                  placeholder="Search securities..."
                  onChange={(e) => {
                    setPodsSearchQuery(e.target.value);
                    setPodsShowSearchResults(true);
                    setPodsHighlightedIndex(-1);
                  }}
                  onFocus={() => {
                    if (podsSearchQuery.trim()) {
                      setPodsShowSearchResults(true);
                    }
                  }}
                  onBlur={() => {
                    // Delay hiding to allow click on results
                    setTimeout(() => {
                      setPodsShowSearchResults(false);
                      setPodsHighlightedIndex(-1);
                    }, 200);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'ArrowDown') {
                      e.preventDefault();
                      setPodsHighlightedIndex(prev =>
                        prev < podsFilteredSecurities.length - 1 ? prev + 1 : prev
                      );
                      setPodsShowSearchResults(true);
                    } else if (e.key === 'ArrowUp') {
                      e.preventDefault();
                      setPodsHighlightedIndex(prev => prev > 0 ? prev - 1 : -1);
                    } else if (e.key === 'Enter' && podsHighlightedIndex >= 0) {
                      e.preventDefault();
                      const selected = podsFilteredSecurities[podsHighlightedIndex];
                      if (selected) {
                        handlePodsSecuritySelect(selected);
                      }
                    } else if (e.key === 'Escape') {
                      setPodsShowSearchResults(false);
                      setPodsSearchQuery('');
                      podsSearchInputRef.current?.blur();
                    }
                  }}
                  className="px-3 py-2 text-sm border border-[#e5e7eb] rounded-md bg-white dark:bg-gray-700 dark:border-gray-600 dark:text-white focus:outline-none focus:ring-2 focus:ring-[#d1d5db] min-w-0 w-full"
                />
                {podsShowSearchResults && podsFilteredSecurities.length > 0 && (
                  <div
                    className="absolute z-50 w-full mt-1 bg-white dark:bg-gray-800 border border-[#e5e7eb] dark:border-gray-600 shadow-lg max-h-60 overflow-y-auto"
                    style={{ top: '100%' }}
                  >
                    {podsFilteredSecurities.map((security, index) => (
                      <div
                        key={security.ticker}
                        onClick={() => handlePodsSecuritySelect(security)}
                        className={`px-3 py-2 cursor-pointer text-sm ${index === podsHighlightedIndex
                          ? 'bg-[#f3f4f6] dark:bg-blue-900/30'
                          : 'hover:bg-[#f3f4f6] dark:hover:bg-gray-700'
                          }`}
                        onMouseEnter={() => setPodsHighlightedIndex(index)}
                      >
                        <div className="flex items-center justify-between">
                          <div className="font-semibold dark:text-white">{security.ticker}</div>
                          <div className="text-xs text-gray-500 dark:text-gray-500 ml-2">
                            {ASSET_CLASS_NAMES[security.assetClass] || security.assetClass}
                          </div>
                        </div>
                        <div className="text-xs text-gray-600 dark:text-gray-400 truncate">
                          {security.name}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* POD Calculations */}
              <div
                className="mt-6 p-4 bg-[#f9fafb] dark:bg-gray-800 rounded-lg border border-[#e5e7eb] dark:border-gray-700"
                style={{ width: '100%', maxWidth: '400px' }}
              >
                <Text className="text-sm font-semibold dark:text-white mb-4">
                  POD Calculations
                </Text>

                <div className="space-y-4">
                  {/* POD1 */}
                  <div className="p-3 bg-white dark:bg-gray-700 rounded-md border border-[#e5e7eb] dark:border-gray-600">
                    <div className="flex items-center justify-between mb-2">
                      <Text className="text-sm font-semibold dark:text-white">
                        POD1
                      </Text>
                      <Badge color="blue" size="sm">
                        Revenue
                      </Badge>
                    </div>
                    <Text className="text-xs text-gray-600 dark:text-gray-400">
                      #roc of REVENUE Growth
                    </Text>
                    <div className="mt-2">
                      <Text className="text-lg font-bold dark:text-white">
                        {podsSelectedSecurity ? '--' : '--'}
                      </Text>
                    </div>
                  </div>

                  {/* POD2 */}
                  <div className="p-3 bg-white dark:bg-gray-700 rounded-md border border-[#e5e7eb] dark:border-gray-600">
                    <div className="flex items-center justify-between mb-2">
                      <Text className="text-sm font-semibold dark:text-white">
                        POD2
                      </Text>
                      <Badge color="emerald" size="sm">
                        EBITDA/EPS
                      </Badge>
                    </div>
                    <Text className="text-xs text-gray-600 dark:text-gray-400">
                      #roc of EBITDA or EPS Growth
                    </Text>
                    <div className="mt-2">
                      <Text className="text-lg font-bold dark:text-white">
                        {podsSelectedSecurity ? '--' : '--'}
                      </Text>
                    </div>
                  </div>

                  {/* POD3 */}
                  <div className="p-3 bg-white dark:bg-gray-700 rounded-md border border-[#e5e7eb] dark:border-gray-600">
                    <div className="flex items-center justify-between mb-2">
                      <Text className="text-sm font-semibold dark:text-white">
                        POD3
                      </Text>
                      <Badge color="purple" size="sm">
                        FCF
                      </Badge>
                    </div>
                    <Text className="text-xs text-gray-600 dark:text-gray-400">
                      #roc of FCF (Free Cash Flow) Growth
                    </Text>
                    <div className="mt-2">
                      <Text className="text-lg font-bold dark:text-white">
                        {podsSelectedSecurity ? '--' : '--'}
                      </Text>
                    </div>
                  </div>
                </div>
              </div>

              {/* Selected Security Display (Placeholder for future calculation) */}
              {podsSelectedSecurity && (
                <div className="mt-4 p-4 bg-[#f9fafb] dark:bg-gray-800 rounded-lg border border-[#e5e7eb] dark:border-gray-700">
                  <Text className="text-sm font-semibold dark:text-white mb-2">
                    Selected Security
                  </Text>
                  <Text className="text-sm dark:text-gray-300">
                    <strong>Ticker:</strong> {podsSelectedSecurity.ticker}
                  </Text>
                  <Text className="text-sm dark:text-gray-300">
                    <strong>Name:</strong> {podsSelectedSecurity.name}
                  </Text>
                  <Text className="text-sm dark:text-gray-300">
                    <strong>Asset Class:</strong> {ASSET_CLASS_NAMES[podsSelectedSecurity.assetClass] || podsSelectedSecurity.assetClass}
                  </Text>
                  <Text className="text-sm dark:text-gray-400 mt-2 italic">
                    Calculation will appear here based on 3 factors
                  </Text>
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {/* Book/Notes Modal */}
      {showBookModal && selectedBookContent && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(0, 0, 0, 0.5)',
            zIndex: 2000,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '20px',
          }}
          onClick={() => {
            setShowBookModal(false);
            setSelectedTag(null);
          }}
        >
          <div
            style={{
              backgroundColor: theme === 'dark' ? '#1f2937' : '#ffffff',
              borderRadius: '0.75rem',
              width: '90%',
              maxWidth: selectedTag ? '1400px' : '1200px',
              maxHeight: '90vh',
              display: 'flex',
              flexDirection: 'row',
              boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.08), 0 10px 10px -5px rgba(0, 0, 0, 0.04)',
              transition: 'max-width 0.3s ease-in-out',
              border: theme === 'dark' ? 'none' : '1px solid #e5e7eb',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Left Sidebar - Tag Navigation */}
            {selectedTag && tagSectionsMap[selectedTag] && (
              <div
                style={{
                  width: '250px',
                  borderRight: `1px solid ${theme === 'dark' ? '#374151' : '#e5e7eb'}`,
                  display: 'flex',
                  flexDirection: 'column',
                  backgroundColor: theme === 'dark' ? '#111827' : '#f9fafb',
                  transition: 'width 0.3s ease-in-out',
                }}
              >
                {/* Sidebar Header */}
                <div
                  style={{
                    padding: '16px',
                    borderBottom: `1px solid ${theme === 'dark' ? '#374151' : '#e5e7eb'}`,
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                  }}
                >
                  <Text
                    style={{
                      fontSize: '14px',
                      fontWeight: 600,
                      color: theme === 'dark' ? '#f3f4f6' : '#111827',
                      margin: 0,
                    }}
                  >
                    #{selectedTag}
                  </Text>
                  <Button
                    onClick={() => setSelectedTag(null)}
                    variant="secondary"
                    size="sm"
                    style={{ minWidth: '24px', height: '24px', padding: '0', fontSize: '14px' }}
                  >
                    ✕
                  </Button>
                </div>

                {/* Sections List */}
                <div
                  style={{
                    flex: 1,
                    overflowY: 'auto',
                    padding: '8px',
                  }}
                >
                  {tagSectionsMap[selectedTag].map((section, index) => (
                    <div
                      key={section.id}
                      onClick={() => scrollToSection(section.id)}
                      style={{
                        padding: '12px',
                        marginBottom: '8px',
                        borderRadius: '0.375rem',
                        cursor: 'pointer',
                        backgroundColor: theme === 'dark' ? '#1f2937' : '#ffffff',
                        border: `1px solid ${theme === 'dark' ? '#374151' : '#e5e7eb'}`,
                        transition: 'all 0.2s ease-in-out',
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.backgroundColor = theme === 'dark' ? '#374151' : '#f3f4f6';
                        e.currentTarget.style.borderColor = theme === 'dark' ? '#4b5563' : '#d1d5db';
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.backgroundColor = theme === 'dark' ? '#1f2937' : '#ffffff';
                        e.currentTarget.style.borderColor = theme === 'dark' ? '#374151' : '#e5e7eb';
                      }}
                    >
                      <div
                        style={{
                          fontSize: section.level === 2 ? '14px' : '13px',
                          fontWeight: section.level === 2 ? 600 : 500,
                          color: theme === 'dark' ? '#f3f4f6' : '#111827',
                          marginBottom: '4px',
                        }}
                      >
                        {section.title}
                      </div>
                      {section.snippet && (
                        <div
                          style={{
                            fontSize: '11px',
                            color: theme === 'dark' ? '#9ca3af' : '#6b7280',
                            lineHeight: '1.4',
                            marginTop: '4px',
                          }}
                        >
                          {section.snippet}...
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Main Content Area */}
            <div
              style={{
                flex: 1,
                display: 'flex',
                flexDirection: 'column',
                minWidth: 0, // Allow flexbox to shrink
              }}
            >
              {/* Modal Header */}
              <div
                style={{
                  padding: '20px',
                  borderBottom: `1px solid ${theme === 'dark' ? '#374151' : '#e5e7eb'}`,
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                }}
              >
                <Title
                  style={{
                    fontSize: '24px',
                    fontWeight: 700,
                    margin: 0,
                    color: theme === 'dark' ? '#f3f4f6' : '#000',
                    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "Roboto", "Oxygen", "Ubuntu", "Cantarell", "Fira Sans", "Droid Sans", "Helvetica Neue", sans-serif',
                  }}
                >
                  {selectedBookTitle}
                </Title>
                <Button
                  onClick={() => {
                    setShowBookModal(false);
                    setSelectedTag(null);
                  }}
                  variant="secondary"
                  size="sm"
                  style={{ minWidth: '32px', height: '32px', padding: '0' }}
                >
                  ✕
                </Button>
              </div>

              {/* Tag Bar */}
              {tags.length > 0 && (
                <div
                  style={{
                    padding: '12px 20px',
                    borderBottom: `1px solid ${theme === 'dark' ? '#374151' : '#e5e7eb'}`,
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: '8px',
                    backgroundColor: theme === 'dark' ? '#111827' : '#f9fafb',
                  }}
                >
                  {tags.map((tag) => {
                    const count = tagCounts[tag] || 0;
                    const isActive = selectedTag === tag;
                    return (
                      <button
                        key={tag}
                        onClick={() => setSelectedTag(isActive ? null : tag)}
                        style={{
                          padding: '6px 12px',
                          fontSize: '12px',
                          fontWeight: 500,
                          borderRadius: '0.375rem',
                          border: `1px solid ${isActive
                            ? (theme === 'dark' ? '#3b82f6' : '#c7d2fe')
                            : (theme === 'dark' ? '#374151' : '#e5e7eb')
                            }`,
                          backgroundColor: isActive
                            ? (theme === 'dark' ? '#1e3a8a' : '#f3f4f6')
                            : (theme === 'dark' ? '#1f2937' : '#ffffff'),
                          color: isActive
                            ? (theme === 'dark' ? '#93c5fd' : '#111')
                            : (theme === 'dark' ? '#f3f4f6' : '#111'),
                          cursor: 'pointer',
                          transition: 'all 0.2s ease-in-out',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '6px',
                        }}
                        onMouseEnter={(e) => {
                          if (!isActive) {
                            e.currentTarget.style.backgroundColor = theme === 'dark' ? '#374151' : '#f3f4f6';
                            e.currentTarget.style.borderColor = theme === 'dark' ? '#4b5563' : '#d1d5db';
                          }
                        }}
                        onMouseLeave={(e) => {
                          if (!isActive) {
                            e.currentTarget.style.backgroundColor = theme === 'dark' ? '#1f2937' : '#ffffff';
                            e.currentTarget.style.borderColor = theme === 'dark' ? '#374151' : '#e5e7eb';
                          }
                        }}
                      >
                        <span>#{tag}</span>
                        <span
                          style={{
                            fontSize: '10px',
                            opacity: 0.7,
                            padding: '2px 6px',
                            borderRadius: '0.25rem',
                            backgroundColor: isActive
                              ? (theme === 'dark' ? 'rgba(147, 197, 253, 0.2)' : 'rgba(30, 64, 175, 0.2)')
                              : (theme === 'dark' ? 'rgba(156, 163, 175, 0.2)' : 'rgba(107, 114, 128, 0.2)'),
                          }}
                        >
                          {count}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}

              {/* Modal Content */}
              <div
                ref={bookContentRef}
                style={{
                  padding: '24px',
                  overflowY: 'auto',
                  flex: 1,
                  color: theme === 'dark' ? '#f3f4f6' : '#111',
                  lineHeight: '1.6',
                  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "Roboto", "Oxygen", "Ubuntu", "Cantarell", "Fira Sans", "Droid Sans", "Helvetica Neue", sans-serif',
                }}
              >
                <Suspense fallback={<LazyPanelFallback label="Loading notes..." />}>
                  <ReactMarkdown
                    components={{
                    h2: ({ node, children, ...props }) => {
                      const text = String(children);
                      const section = sections.find(s => s.title === text.trim() && s.level === 2);
                      return (
                        <h2
                          id={section?.id || undefined}
                          style={{
                            fontSize: '1.5rem',
                            fontWeight: 700,
                            marginTop: '2rem',
                            marginBottom: '1rem',
                            borderBottom: `1px solid ${theme === 'dark' ? '#374151' : '#e5e7eb'}`,
                            paddingBottom: '0.5rem',
                            color: theme === 'dark' ? '#f3f4f6' : '#000',
                          }}
                          {...props}
                        >
                          {children}
                        </h2>
                      );
                    },
                    h3: ({ node, children, ...props }) => {
                      const text = String(children);
                      const section = sections.find(s => s.title === text.trim() && s.level === 3);
                      return (
                        <h3
                          id={section?.id || undefined}
                          style={{
                            fontSize: '1.25rem',
                            fontWeight: 600,
                            marginTop: '1.5rem',
                            marginBottom: '0.75rem',
                            color: theme === 'dark' ? '#f3f4f6' : '#111827',
                          }}
                          {...props}
                        >
                          {children}
                        </h3>
                      );
                    },
                    h4: ({ node, children, ...props }) => {
                      const text = String(children);
                      const section = sections.find(s => s.title === text.trim() && s.level === 4);
                      return (
                        <h4
                          id={section?.id || undefined}
                          style={{
                            fontSize: '1.1rem',
                            fontWeight: 600,
                            marginTop: '1.25rem',
                            marginBottom: '0.75rem',
                            color: theme === 'dark' ? '#f3f4f6' : '#111827',
                          }}
                          {...props}
                        >
                          {children}
                        </h4>
                      );
                    },
                    p: ({ node, children, ...props }) => (
                      <p
                        style={{
                          marginBottom: '1rem',
                          color: theme === 'dark' ? '#f3f4f6' : '#111827',
                        }}
                        {...props}
                      >
                        {children}
                      </p>
                    ),
                    strong: ({ node, children, ...props }) => (
                      <strong style={{ fontWeight: 700 }} {...props}>
                        {children}
                      </strong>
                    ),
                    em: ({ node, children, ...props }) => (
                      <em style={{ fontStyle: 'italic' }} {...props}>
                        {children}
                      </em>
                    ),
                    hr: ({ node, ...props }) => (
                      <hr
                        style={{
                          margin: '1.5rem 0',
                          border: 'none',
                          borderTop: `1px solid ${theme === 'dark' ? '#374151' : '#e5e7eb'}`,
                        }}
                        {...props}
                      />
                    ),
                    ul: ({ node, children, ...props }) => (
                      <ul
                        style={{
                          marginBottom: '1rem',
                          paddingLeft: '1.5rem',
                          listStyleType: 'disc',
                        }}
                        {...props}
                      >
                        {children}
                      </ul>
                    ),
                    ol: ({ node, children, ...props }) => (
                      <ol
                        style={{
                          marginBottom: '1rem',
                          paddingLeft: '1.5rem',
                          listStyleType: 'decimal',
                        }}
                        {...props}
                      >
                        {children}
                      </ol>
                    ),
                    li: ({ node, children, ...props }) => (
                      <li
                        style={{
                          marginBottom: '0.5rem',
                          color: theme === 'dark' ? '#f3f4f6' : '#111827',
                        }}
                        {...props}
                      >
                        {children}
                      </li>
                    ),
                    }}
                  >
                    {selectedBookContent}
                  </ReactMarkdown>
                </Suspense>
              </div>
            </div>

            {/* Right Sidebar - Table of Contents */}
            {sections.length > 0 && (
              <div
                style={{
                  width: '220px',
                  borderLeft: `1px solid ${theme === 'dark' ? '#374151' : '#e5e7eb'}`,
                  display: 'flex',
                  flexDirection: 'column',
                  backgroundColor: theme === 'dark' ? '#111827' : '#f9fafb',
                  transition: 'width 0.3s ease-in-out',
                }}
              >
                {/* TOC Header */}
                <div
                  style={{
                    padding: '16px',
                    borderBottom: `1px solid ${theme === 'dark' ? '#374151' : '#e5e7eb'}`,
                  }}
                >
                  <Text
                    style={{
                      fontSize: '14px',
                      fontWeight: 600,
                      color: theme === 'dark' ? '#f3f4f6' : '#111827',
                      margin: 0,
                    }}
                  >
                    Table of Contents
                  </Text>
                </div>

                {/* TOC List */}
                <div
                  style={{
                    flex: 1,
                    overflowY: 'auto',
                    padding: '12px 8px',
                  }}
                >
                  {sections.map((section, index) => {
                    const indent = section.level === 2 ? 0 : section.level === 3 ? 16 : 32;
                    return (
                      <div
                        key={section.id}
                        onClick={() => scrollToSection(section.id)}
                        style={{
                          padding: '8px 12px',
                          paddingLeft: `${12 + indent}px`,
                          marginBottom: '4px',
                          borderRadius: '0.375rem',
                          cursor: 'pointer',
                          backgroundColor: 'transparent',
                          transition: 'all 0.2s ease-in-out',
                          fontSize: section.level === 2 ? '13px' : section.level === 3 ? '12px' : '11px',
                          fontWeight: section.level === 2 ? 600 : section.level === 3 ? 500 : 400,
                          color: theme === 'dark' ? '#f3f4f6' : '#111827',
                          borderLeft: section.level === 2
                            ? `2px solid ${theme === 'dark' ? '#374151' : '#e5e7eb'}`
                            : 'none',
                        }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.backgroundColor = theme === 'dark' ? '#374151' : '#f3f4f6';
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.backgroundColor = 'transparent';
                        }}
                      >
                        {section.title}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Securities Universe Panel */}
      <div
        style={{
          position: 'fixed',
          top: 0,
          right: 'var(--dashboard-active-rail-width)',
          width: showSecuritiesUniverse
            ? (showPortfolioMetrics
              ? 'calc((100vw - 16px) * (10/12) - 128px)'
              : 'calc((100vw - 16px) * (10/12) - var(--dashboard-rail-collapsed-width))')
            : '0px',
          height: '100vh',
          backgroundColor: '#ffffff',
          zIndex: getSidebarPanelZIndex('securities', showSecuritiesUniverse),
          borderLeft: showSecuritiesUniverse ? '1px solid #e5e7eb' : 'none',
          borderRight: showSecuritiesUniverse ? '1px solid #e5e7eb' : 'none',
          borderRadius: showSecuritiesUniverse ? '0.75rem 0 0 0' : '0',
          boxShadow: showSecuritiesUniverse
            ? '-2px 0 8px rgba(0, 0, 0, 0.08), 2px 0 8px rgba(0, 0, 0, 0.08)'
            : 'none',
          transition: 'width 0.3s ease-in-out, right 0.3s ease-in-out, border-radius 0.3s ease-in-out',
          display: showSecuritiesUniverse ? 'flex' : 'none',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
        className="dashboard-side-panel dashboard-side-panel--portfolio dark:bg-gray-900 dark:border-gray-700"
      >
        {showSecuritiesUniverse && (
          <>
            <div
              style={{
                padding: '12px 16px',
                display: 'flex',
                justifyContent: 'center',
                alignItems: 'center',
                borderBottom: '1px solid #e5e7eb',
                backgroundColor: '#f9fafb',
                cursor: 'pointer',
              }}
              className="dark:border-gray-700"
              onClick={() => closeSidebarPanel('securities', setShowSecuritiesUniverse)}
            >
              <Title
                className="dark:text-white"
                style={{
                  fontSize: '18px',
                  fontWeight: 700,
                  color: '#000',
                  margin: 0,
                  userSelect: 'none',
                  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "Roboto", "Oxygen", "Ubuntu", "Cantarell", "Fira Sans", "Droid Sans", "Helvetica Neue", sans-serif',
                }}
              >
                Securities Universe
              </Title>
            </div>
            <div
              style={{
                flex: 1,
                overflowY: 'auto',
                padding: 0,
              }}
            >
              <Suspense fallback={<LazyPanelFallback label="Loading securities universe..." />}>
                <SecuritiesUniverse />
              </Suspense>
            </div>
          </>
        )}
      </div>

      {/* Securities A–Z list panel */}
      <div
        style={{
          position: 'fixed',
          top: 0,
          right: 'var(--dashboard-active-rail-width)',
          width: showPerformanceTracking
            ? (showPortfolioMetrics
              ? 'calc((100vw - 16px) * (10/12) - 128px)'
              : 'calc((100vw - 16px) * (9/12) - var(--dashboard-rail-collapsed-width))')
            : '0px',
          height: '100vh',
          backgroundColor: '#ffffff',
          zIndex: getSidebarPanelZIndex('performance', showPerformanceTracking),
          borderLeft: showPerformanceTracking ? '1px solid #e5e7eb' : 'none',
          borderRight: showPerformanceTracking ? '1px solid #e5e7eb' : 'none',
          borderRadius: showPerformanceTracking ? '0.75rem 0 0 0' : '0',
          boxShadow: showPerformanceTracking
            ? '-2px 0 8px rgba(0, 0, 0, 0.08), 2px 0 8px rgba(0, 0, 0, 0.08)'
            : 'none',
          transition: 'width 0.3s ease-in-out, right 0.3s ease-in-out, border-radius 0.3s ease-in-out',
          display: showPerformanceTracking ? 'flex' : 'none',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
        className="dashboard-side-panel dashboard-side-panel--cpi dark:bg-gray-900 dark:border-gray-700"
      >
        {showPerformanceTracking && (
          <>
            <div
              style={{
                padding: '12px 16px',
                display: 'flex',
                justifyContent: 'center',
                alignItems: 'center',
                borderBottom: '1px solid #e5e7eb',
                backgroundColor: '#f9fafb',
                cursor: 'pointer',
              }}
              className="dark:border-gray-700"
              onClick={() => closeSidebarPanel('performance', setShowPerformanceTracking)}
            >
              <Title
                className="dark:text-white"
                style={{
                  fontSize: '18px',
                  fontWeight: 700,
                  color: '#000',
                  margin: 0,
                  userSelect: 'none',
                  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "Roboto", "Oxygen", "Ubuntu", "Cantarell", "Fira Sans", "Droid Sans", "Helvetica Neue", sans-serif',
                }}
              >
                Performance
              </Title>
            </div>
            <div
              style={{
                flex: 1,
                overflowY: 'auto',
                padding: 0,
              }}
            >
              <Suspense fallback={<LazyPanelFallback label="Loading performance..." />}>
                <PerformanceTracking />
              </Suspense>
            </div>
          </>
        )}
      </div>

      {/* Portfolio Breakdown Panel */}
      <div
        style={{
          position: 'fixed',
          top: 0,
          right: 'var(--dashboard-active-rail-width)',
          width: showPortfolioBreakdown
            ? (showPortfolioMetrics
              ? 'calc((100vw - 16px) * (10/12) - 128px)'
              : 'calc((100vw - 16px) * (9/12) - var(--dashboard-rail-collapsed-width))')
            : '0px',
          height: '100vh',
          backgroundColor: '#ffffff',
          zIndex: getSidebarPanelZIndex('portfolio', showPortfolioBreakdown),
          borderLeft: showPortfolioBreakdown ? '1px solid #e5e7eb' : 'none',
          borderRight: showPortfolioBreakdown ? '1px solid #e5e7eb' : 'none',
          borderRadius: showPortfolioBreakdown ? '0.75rem 0 0 0' : '0',
          boxShadow: showPortfolioBreakdown
            ? '-2px 0 8px rgba(0, 0, 0, 0.08), 2px 0 8px rgba(0, 0, 0, 0.08)'
            : 'none',
          transition: 'width 0.3s ease-in-out, right 0.3s ease-in-out, border-radius 0.3s ease-in-out',
          display: showPortfolioBreakdown ? 'flex' : 'none',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
        className="dark:bg-gray-900 dark:border-gray-700"
      >
        {showPortfolioBreakdown && (
          <>
            <div
              style={{
                flex: 1,
                overflowY: 'auto',
                padding: '4px 16px 16px 16px',
              }}
            >
              <Suspense fallback={<LazyPanelFallback label="Loading portfolio breakdown..." />}>
                <PortfolioBreakdown
                  portfolioData={portfolioData}
                  isLoading={portfolioLoading}
                  isRefreshing={portfolioRefreshing}
                  connection={ibkrConnection}
                  onRefresh={handlePortfolioRefresh}
                />
              </Suspense>
            </div>
          </>
        )}
      </div>

      {/* Prediction Markets Panel */}
      <div
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 'var(--dashboard-active-rail-width)',
          width: showCpiModel ? undefined : '0px',
          boxSizing: 'border-box',
          height: '100vh',
          backgroundColor: '#ffffff',
          zIndex: getSidebarPanelZIndex('cpi', showCpiModel),
          borderLeft: showCpiModel ? '1px solid #e5e7eb' : 'none',
          borderRight: showCpiModel ? '1px solid #e5e7eb' : 'none',
          borderRadius: '0',
          boxShadow: showCpiModel
            ? '-2px 0 8px rgba(0, 0, 0, 0.08), 2px 0 8px rgba(0, 0, 0, 0.08)'
            : 'none',
          transition: 'width 0.3s ease-in-out, right 0.3s ease-in-out, border-radius 0.3s ease-in-out',
          display: showCpiModel ? 'flex' : 'none',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
        className="dark:bg-gray-900 dark:border-gray-700"
      >
        {showCpiModel && (
          <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
            <Suspense fallback={<LazyPanelFallback label="Loading CPI..." />}>
              <CpiModelPanel
                onClose={() => closeSidebarPanel('cpi', setShowCpiModel)}
                portfolioData={portfolioData}
              />
            </Suspense>
          </div>
        )}
      </div>

      {/* Signal Strength Reference Panel */}
      <div
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 'var(--dashboard-active-rail-width)',
          height: '100vh',
          backgroundColor: '#ffffff',
          zIndex: getSidebarPanelZIndex('ss', showSignalStrength),
          borderRight: showSignalStrength ? '1px solid #e5e7eb' : 'none',
          boxShadow: showSignalStrength ? '-2px 0 8px rgba(0, 0, 0, 0.08), 2px 0 8px rgba(0, 0, 0, 0.08)' : 'none',
          display: showSignalStrength ? 'flex' : 'none',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
        className="dark:bg-gray-900 dark:border-gray-700"
      >
        {showSignalStrength && (
          <Suspense fallback={<LazyPanelFallback label="Loading SS..." />}>
            <SignalStrengthPanel
              onClose={() => closeSidebarPanel('ss', setShowSignalStrength)}
              changelog={hedgeyeChangelog}
              changelogLoading={hedgeyeChangelogLoading}
              changelogError={hedgeyeChangelogError}
              onRefreshChangelog={fetchHedgeyeChangelog}
            />
          </Suspense>
        )}
      </div>

      {/* ETF Pro Reference Panel */}
      <div
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 'var(--dashboard-active-rail-width)',
          height: '100vh',
          backgroundColor: '#ffffff',
          zIndex: getSidebarPanelZIndex('etfPro', showEtfPro),
          borderRight: showEtfPro ? '1px solid #e5e7eb' : 'none',
          boxShadow: showEtfPro ? '-2px 0 8px rgba(0, 0, 0, 0.08), 2px 0 8px rgba(0, 0, 0, 0.08)' : 'none',
          display: showEtfPro ? 'flex' : 'none',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
        className="dark:bg-gray-900 dark:border-gray-700"
      >
        {showEtfPro && (
          <Suspense fallback={<LazyPanelFallback label="Loading ETF Pro..." />}>
            <EtfProPanel
              snapshot={etfProSnapshot}
              loading={etfProLoading}
              refreshing={etfProRefreshing}
              error={etfProError}
              onRefresh={() => fetchEtfProSnapshot(true)}
              onClose={() => closeSidebarPanel('etfPro', setShowEtfPro)}
            />
          </Suspense>
        )}
      </div>

      {/* Macro Show Reference Panel */}
      <div
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 'var(--dashboard-active-rail-width)',
          height: '100vh',
          backgroundColor: '#ffffff',
          zIndex: getSidebarPanelZIndex('macroShow', showMacroShow),
          borderRight: showMacroShow ? '1px solid #e5e7eb' : 'none',
          boxShadow: showMacroShow ? '-2px 0 8px rgba(0, 0, 0, 0.08), 2px 0 8px rgba(0, 0, 0, 0.08)' : 'none',
          display: showMacroShow ? 'flex' : 'none',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
        className="dark:bg-gray-900 dark:border-gray-700"
      >
        {showMacroShow && (
          <Suspense fallback={<LazyPanelFallback label="Loading Macro Show..." />}>
            <HedgeyeShowPanel
              snapshotType="the-macro-show"
              title="Macro Show"
              onClose={() => closeSidebarPanel('macroShow', setShowMacroShow)}
            />
          </Suspense>
        )}
      </div>

      {/* Call Reference Panel */}
      <div
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 'var(--dashboard-active-rail-width)',
          height: '100vh',
          backgroundColor: '#ffffff',
          zIndex: getSidebarPanelZIndex('call', showCall),
          borderRight: showCall ? '1px solid #e5e7eb' : 'none',
          boxShadow: showCall ? '-2px 0 8px rgba(0, 0, 0, 0.08), 2px 0 8px rgba(0, 0, 0, 0.08)' : 'none',
          display: showCall ? 'flex' : 'none',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
        className="dark:bg-gray-900 dark:border-gray-700"
      >
        {showCall && (
          <Suspense fallback={<LazyPanelFallback label="Loading Call..." />}>
            <HedgeyeShowPanel
              snapshotType="the-call"
              title="Call"
              onClose={() => closeSidebarPanel('call', setShowCall)}
            />
          </Suspense>
        )}
      </div>

      {/* Workflow Status Panel */}
      <div
        style={{
          position: 'fixed',
          top: 0,
          right: 0,
          width: showWorkflowStatus
            ? 'calc((100vw - 16px) * (5/12))'
            : '0px',
          height: '100vh',
          backgroundColor: '#ffffff',
          zIndex: getSidebarPanelZIndex('analytics', showWorkflowStatus),
          borderLeft: showWorkflowStatus ? '1px solid #e5e7eb' : 'none',
          borderTop: showWorkflowStatus ? '1px solid #e5e7eb' : 'none',
          borderBottom: showWorkflowStatus ? '1px solid #e5e7eb' : 'none',
          boxShadow: showWorkflowStatus
            ? '-2px 0 8px rgba(0, 0, 0, 0.08)'
            : 'none',
          transition: 'width 0.3s ease-in-out',
          display: showWorkflowStatus ? 'flex' : 'none',
          visibility: showWorkflowStatus ? 'visible' : 'hidden',
          flexDirection: 'column',
          overflow: 'hidden',
          borderRadius: showWorkflowStatus ? '0.75rem 0 0 0' : '0', // Rounded top-left corner
        }}
        className="dark:bg-gray-900/95 dark:border-gray-700 backdrop-blur-sm"
      >
        {showWorkflowStatus && (
          <>
            {/* Header with Centered Title (Clickable to Close) */}
            <div
              style={{
                padding: '8px 12px',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                borderBottom: '1px solid #e5e7eb',
                background: 'linear-gradient(to bottom, rgba(249, 250, 251, 0.9), rgba(255, 255, 255, 0.6))',
              }}
              className="dark:border-gray-700 dark:bg-gradient-to-b dark:from-gray-800/80 dark:to-gray-700/50"
            >
              {/* Empty spacer for centering */}
              <div style={{ width: '28px' }} />

              <Title
                className="dark:text-white"
                style={{
                  fontSize: '14px',
                  fontWeight: 700,
                  color: '#000',
                  margin: 0,
                  userSelect: 'none',
                  cursor: 'pointer',
                  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "Roboto", "Oxygen", "Ubuntu", "Cantarell", "Fira Sans", "Droid Sans", "Helvetica Neue", sans-serif',
                }}
                onClick={() => closeSidebarPanel('analytics', setShowWorkflowStatus)}
              >
                Analytics
              </Title>

              <RefreshButton
                iconOnly
                title="Refresh Analytics"
                label="Refresh Analytics"
                onClick={(e) => {
                  e.stopPropagation();
                  setAnalyticsRefreshKey(prev => prev + 1);
                }}
              />
            </div>

            {/* Scrollable Content */}
            <div
              style={{
                flex: 1,
                overflowY: 'auto',
                padding: 0,
              }}
            >
              <Suspense fallback={<LazyPanelFallback label="Loading analytics..." />}>
                <WorkflowStatus key={analyticsRefreshKey} />
              </Suspense>
            </div>
          </>
        )}
      </div>

    </div >
  );
};

export default PortfolioDashboard;
