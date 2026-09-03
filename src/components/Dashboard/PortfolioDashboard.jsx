import React, { Suspense, lazy, useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { Text, Grid, Title, Button } from '@tremor/react';
import {
  FileText,
  Monitor,
  MessageSquare,
  PieChart,
  Scale,
  Share2,
  Table2,
  Target,
} from 'lucide-react';
import { MarketDataService } from '../../services/api/marketDataService';
import predictionMarketTestService from '../../services/api/predictionMarketTestService';
import { useTheme } from '../../context/ThemeContext';
import USDMacroDashboard from './USDMacroDashboard';
import RefreshButton from '../common/RefreshButton';
import LoadingIndicator from '../common/LoadingIndicator';
import PersistentSurface, { useSurfaceActivity } from '../common/PersistentSurface';
import { useDashboardResource } from '../../hooks/useDashboardResource';
import DashboardNavigationRail from './DashboardNavigationRail';
import PortfolioBalanceScenarioPlanner from './portfolio/PortfolioBalanceScenarioPlanner';
import PredictionMarketPerformanceCard from './PredictionMarketPerformanceCard';
import { loadSelectedAccount, saveSelectedAccount, saveIbkrAccounts } from '../../constants/ibkrAccountStorage';
import { getIbkrConnectionDisplay, getPreferredIbkrAccount } from '../../utils/ibkrConnectionStatus';
import { startVisibilityAwarePolling } from '../../utils/visibilityAwarePolling';
import { isExplicitlySafeResearchComparison } from '../../utils/researchComparisonContract';
import {
  activePredictionMarketNavIndicators,
  normalizePredictionMarketNavIndicators,
  PREDICTION_MARKET_INDICATOR_MAX_AGE_MS,
  PREDICTION_MARKET_INDICATOR_POLL_MS,
} from '../../utils/predictionMarketNavIndicators';
import {
  markMarketQuotePayloadRefreshDelayed,
  MARKET_QUOTE_FUTURE_TOLERANCE_MS,
  marketPayloadObservedAt,
  reconcileMarketQuotePayload,
  validateMarketQuotePayload,
  validatePeriodReturnPayload,
} from '../../utils/marketQuoteFreshness';
import {
  createUnknownDashboardCardStatuses,
  mergeDashboardCardStatuses,
} from './dashboardStatus';
import { getProcessDocument } from '../../constants/processDocuments';
import { isDashboardSessionRetentionEnabled } from '../../config/dashboardSessionRetention';
import { createDashboardWarmupQueue } from '../../utils/dashboardWarmupQueue';
import { warmDashboardResource } from '../../utils/dashboardResourceWarmup';
import { canonicalPredictionMonitorContext } from '../../utils/predictionMonitorIdentity';
import AnalystSurfaceBoundary from './AnalystSurfaceBoundary';

const loadReactMarkdownModule = () => import('react-markdown');
const loadSystemReadinessModule = () => import('./SystemReadinessPanel');
const loadWorkflowStatusModule = () => import('./WorkflowStatus');
const loadPerformanceTrackingModule = () => import('./PerformanceTracking');
const loadPortfolioBreakdownModule = () => import('./PortfolioBreakdown');
const loadExposureLabModule = () => import('./ExposureLab');
const loadPredictionMonitorModule = () => import('./PredictionMarketResolverTest');
const loadSignalStrengthModule = () => import('./SignalStrengthPanel');
const loadEtfProModule = () => import('./EtfProPanel');
const loadHedgeyeShowModule = () => import('./HedgeyeShowPanel');
const loadMorningTldrModule = () => import('./MorningTldrOverlay');
const loadAnalystModule = () => import('./AnalystPanel');
const loadProcessModule = () => import('../Process/ProcessOverlay');

const ReactMarkdown = lazy(loadReactMarkdownModule);
const SystemReadinessPanel = lazy(loadSystemReadinessModule);
const WorkflowStatus = lazy(loadWorkflowStatusModule);
const PerformanceTracking = lazy(loadPerformanceTrackingModule);
const PortfolioBreakdown = lazy(loadPortfolioBreakdownModule);
const ExposureLab = lazy(loadExposureLabModule);
const PredictionMarketResolverTestPanel = lazy(loadPredictionMonitorModule);
const SignalStrengthPanel = lazy(loadSignalStrengthModule);
const EtfProPanel = lazy(loadEtfProModule);
const HedgeyeShowPanel = lazy(loadHedgeyeShowModule);
const MorningTldrOverlay = lazy(loadMorningTldrModule);
const AnalystPanel = lazy(loadAnalystModule);
const ProcessOverlay = lazy(loadProcessModule);

const DASHBOARD_LAZY_WARMUPS = Object.freeze([
  Object.freeze({ key: 'chunk:system-readiness', run: loadSystemReadinessModule }),
  Object.freeze({ key: 'chunk:workflow', run: loadWorkflowStatusModule }),
  Object.freeze({ key: 'chunk:performance', run: loadPerformanceTrackingModule }),
  Object.freeze({ key: 'chunk:portfolio', run: loadPortfolioBreakdownModule }),
  Object.freeze({ key: 'chunk:exposure-lab', run: loadExposureLabModule }),
  Object.freeze({ key: 'chunk:prediction-monitor', run: loadPredictionMonitorModule }),
  Object.freeze({ key: 'chunk:signal-strength', run: loadSignalStrengthModule }),
  Object.freeze({ key: 'chunk:etf-pro', run: loadEtfProModule }),
  Object.freeze({ key: 'chunk:hedgeye-show', run: loadHedgeyeShowModule }),
  Object.freeze({ key: 'chunk:morning-tldr', run: loadMorningTldrModule }),
  Object.freeze({ key: 'chunk:analyst', run: loadAnalystModule }),
  Object.freeze({ key: 'chunk:process', run: loadProcessModule }),
]);

const PANEL_WARMUP_TASK_KEYS = Object.freeze({
  system: Object.freeze(['chunk:system-readiness']),
  analytics: Object.freeze(['chunk:workflow']),
  performance: Object.freeze(['chunk:performance']),
  portfolio: Object.freeze(['chunk:portfolio']),
  exposureLab: Object.freeze(['chunk:exposure-lab', 'resource:exposure-lab-universe']),
  predictionMonitor: Object.freeze(['chunk:prediction-monitor']),
  ss: Object.freeze(['chunk:signal-strength']),
  etfPro: Object.freeze(['chunk:etf-pro', 'resource:etf-pro']),
  macroShow: Object.freeze(['chunk:hedgeye-show']),
  call: Object.freeze(['chunk:hedgeye-show']),
  tldr: Object.freeze(['chunk:morning-tldr']),
  analyst: Object.freeze(['chunk:analyst']),
});

// The funding guard may need fresh IBKR daily bars for symbols whose live
// stream omits the prior-close tick. Keep the full portfolio/funding refresh
// below IBKR historical-data pacing while remaining inside the guard's
// freshness window.
const PORTFOLIO_POLL_MS = 50000;
const REFERENCE_DATA_POLL_MS = 5 * 60 * 1000;
const PROVIDER_STATUS_POLL_MS = 5000;
const PROVIDER_STATUS_POLL_OFFLINE_MS = 15000;
const PROVIDER_STATUS_TIMEOUT_MS = 3500;
const PORTFOLIO_REQUEST_TIMEOUT_MS = 60 * 1000;
const PORTFOLIO_LIVE_MAX_AGE_MS = 5 * 60 * 1000;
const MARKET_QUOTES_MAX_AGE_MS = 4 * 24 * 60 * 60 * 1000;
const MARKET_PERIOD_RETURNS_POLL_MS = 15 * 60 * 1000;
const SIDEBAR_PANEL_Z_INDEX_BASE = 1300;
const DASHBOARD_PANEL_STATE_KEY = 'marketDashboard.panelState.v1';
const DASHBOARD_RAIL_COLLAPSED_WIDTH = 'min(88px, calc(100vw - 32px))';
const CONTRACT_PNL_PANEL_DEFAULT_WIDTH = 295;
const CONTRACT_PNL_PANEL_MIN_WIDTH = 295;
const CONTRACT_PNL_PANEL_MAX_WIDTH = 1400;
const CONTRACT_PNL_PANEL_EDGE_INSET = 8;
const CONTRACT_PNL_PANEL_RESIZE_STEP = 24;
const ANALYST_PANEL_DEFAULT_WIDTH = 440;
const ANALYST_PANEL_MIN_WIDTH = 280;
const ANALYST_PANEL_MAX_WIDTH = 1400;
const ANALYST_PANEL_EDGE_INSET = 8;
const ANALYST_PANEL_RESIZE_STEP = 24;
const ANALYST_PANEL_POSITIONS = new Set(['left', 'center', 'right']);
const ANALYST_PANEL_DEFAULT_POSITION = 'auto';
const ETF_PRO_STALE_WARNING = 'The API is serving a last-good cached ETF Pro response.';
const ANALYST_SHADOW_MODE = process.env.REACT_APP_ANALYST_SHADOW_MODE !== 'false';
export function analystNavigationState(shadowMode = ANALYST_SHADOW_MODE) {
  return {
    systemsEntry: shadowMode ? 'tldr' : 'analyst',
    showLegacyTldr: shadowMode,
    showResearchAnalyst: shadowMode,
  };
}
const ANALYST_NAVIGATION = analystNavigationState();
const PROCESS_ROUTE = getProcessDocument('the-process').route;
const EXPOSURE_GUIDE_DOCUMENT_ID = 'exposure-lab-guide';
const EXPOSURE_GUIDE_ROUTE = getProcessDocument(EXPOSURE_GUIDE_DOCUMENT_ID).route;
const PERSISTED_SIDEBAR_PANELS = new Set([
  'system',
  'analytics',
  'performance',
  'portfolio',
  'exposureLab',
  'predictionMonitor',
  // Accepted only so persisted legacy state can migrate to predictionMonitor.
  'resolverTest',
  'tldr',
  'analyst',
  'ss',
  'etfPro',
  'macroShow',
  'call',
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

const appendUniqueWarning = (warnings, warning) => (
  [...new Set([...(Array.isArray(warnings) ? warnings : []), warning].filter(Boolean))]
);

const getReferenceDataQuality = (snapshot) => (
  snapshot?.dataQuality || snapshot?.meta?.dataQuality || null
);

const prepareReferenceComparisonSnapshot = (snapshot, {
  requireAvailable = false,
  staleWarning,
} = {}) => {
  if (!snapshot || typeof snapshot !== 'object') {
    return {
      available: false,
      comparisonAvailable: false,
      dataQuality: { status: 'error', warnings: ['Reference response was unavailable.'] },
    };
  }

  const cacheIsStale = snapshot?._cache?.stale === true;
  const quality = getReferenceDataQuality(snapshot);
  const qualityStatus = quality?.status;
  const available = requireAvailable ? snapshot?.available === true : snapshot?.available !== false;
  const comparisonAvailable = available
    && !cacheIsStale
    && qualityStatus === 'ok'
    && isExplicitlySafeResearchComparison(snapshot);
  const prepared = {
    ...snapshot,
    _cache: snapshot?._cache,
    comparisonAvailable,
  };

  if (cacheIsStale) {
    prepared.dataQuality = {
      ...(quality || {}),
      status: qualityStatus && qualityStatus !== 'ok' ? qualityStatus : 'warning',
      warnings: appendUniqueWarning(quality?.warnings, staleWarning),
    };
  }

  return prepared;
};

const markReferenceRefreshFailed = (current, {
  warning,
  error,
  emptyState,
} = {}) => {
  const previous = current && typeof current === 'object' ? current : emptyState;
  const quality = getReferenceDataQuality(previous);
  return {
    ...(previous || {}),
    _cache: previous?._cache,
    available: false,
    comparisonAvailable: false,
    dataQuality: {
      ...(quality || {}),
      status: 'error',
      warnings: appendUniqueWarning(quality?.warnings, warning),
    },
    refreshError: error || warning,
  };
};

const isRejectedPortfolioResponse = (snapshot) => (
  snapshot?.dataSource === 'ibkr_offline'
  || (
    snapshot?.dataSource === 'ibkr_api'
    && snapshot?.liveSessionVerified !== true
  )
  || snapshot?.dataSource !== 'ibkr_api'
  || snapshot?.fromCache !== false
  || snapshot?._cache?.stale === true
);

const validateLivePortfolioSnapshot = (snapshot, expectedAccount) => {
  const reportedAccount = String(snapshot?.accountId || '').trim();
  if (
    !snapshot
    || typeof snapshot !== 'object'
    || isRejectedPortfolioResponse(snapshot)
    || (expectedAccount && reportedAccount !== expectedAccount)
    || !snapshot.fetchedAt
    || !snapshot.socketVerifiedAt
  ) {
    throw Object.assign(
      new Error(
        snapshot?.dataSource === 'ibkr_offline'
          ? 'IBKR is disconnected; the live portfolio is unavailable.'
          : 'The portfolio response was not verified live account data.',
      ),
      {
        code: snapshot?.dataSource === 'ibkr_offline'
          ? 'PORTFOLIO_GATEWAY_OFFLINE'
          : expectedAccount && reportedAccount && reportedAccount !== expectedAccount
            ? 'PORTFOLIO_ACCOUNT_MISMATCH'
            : 'PORTFOLIO_RESPONSE_UNVERIFIED',
        liveInvalidation: true,
      },
    );
  }
  return snapshot;
};

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

const clampAnalystPanelWidth = (
  value,
  minWidth = ANALYST_PANEL_MIN_WIDTH,
  maxWidth = ANALYST_PANEL_MAX_WIDTH,
) => {
  const minimum = Math.min(minWidth, maxWidth);
  const maximum = Math.max(minWidth, maxWidth);
  const parsed = Number(value);
  const width = Number.isFinite(parsed) ? parsed : ANALYST_PANEL_DEFAULT_WIDTH;
  return Math.round(Math.min(maximum, Math.max(minimum, width)));
};

const clampContractPnlPanelWidth = (
  value,
  minWidth = CONTRACT_PNL_PANEL_MIN_WIDTH,
  maxWidth = CONTRACT_PNL_PANEL_MAX_WIDTH,
) => {
  const minimum = Math.min(minWidth, maxWidth);
  const maximum = Math.max(minWidth, maxWidth);
  const parsed = Number(value);
  const width = Number.isFinite(parsed) ? parsed : CONTRACT_PNL_PANEL_DEFAULT_WIDTH;
  return Math.round(Math.min(maximum, Math.max(minimum, width)));
};

const normalizeAnalystPanelPosition = (value) => (
  ANALYST_PANEL_POSITIONS.has(value) ? value : ANALYST_PANEL_DEFAULT_POSITION
);

const PREDICTION_MONITOR_MARKETS = new Set(['silver', 'gold', 'wti', 'brent', 'bitcoin', 'sp500', 'cpi']);
// IBKR catalog review 2026-08-20: each button has at least one listed contract
// family above 10,000 aggregate open interest; repeated cadences share one card.
const PREDICTION_MONITOR_NAV_ITEMS = Object.freeze([
  Object.freeze({ marketId: 'silver', label: 'Silver', tier: 'T1', description: 'IBKR Silver futures and weekly threshold contracts' }),
  Object.freeze({ marketId: 'gold', label: 'Gold', tier: 'T1', indicatorMarketId: 'gold', description: 'IBKR Gold daily, weekly, and futures threshold contracts' }),
  Object.freeze({ marketId: 'wti', label: 'WTI', tier: 'T1', indicatorMarketId: 'wti', description: 'Kalshi/IBKR WTI daily, weekly, and futures threshold contracts' }),
  Object.freeze({ marketId: 'brent', label: 'Brent', tier: 'T1', description: 'Kalshi/IBKR Brent daily and weekly threshold contracts' }),
  Object.freeze({ marketId: 'bitcoin', label: 'Bitcoin', tier: 'T1', description: 'IBKR Bitcoin range contracts' }),
  Object.freeze({ marketId: 'sp500', label: 'SP500', tier: 'T2', indicatorMarketId: 'sp500', description: 'IBKR S&P 500 futures threshold contracts' }),
  Object.freeze({ marketId: 'cpi', label: 'CPI', tier: 'T2', description: 'Kalshi headline CPI YoY contracts with Hedgeye, Cleveland Fed, and BLS context' }),
]);

export const migratePredictionMarketsPanelState = (state = {}) => {
  const stack = Array.isArray(state?.sidebarPanelStack) ? state.sidebarPanelStack : [];
  const legacyMonitorVisible = state?.showResolverTest === true;
  const currentMonitorVisible = state?.showPredictionMonitor === true;
  const monitorVisible = currentMonitorVisible || legacyMonitorVisible;

  const migratedStack = [];
  const pushLast = (key) => {
    const withoutKey = migratedStack.filter((entry) => entry !== key);
    migratedStack.splice(0, migratedStack.length, ...withoutKey, key);
  };

  stack.forEach((key) => {
    if (key === 'resolverTest') {
      if (legacyMonitorVisible) pushLast('predictionMonitor');
      return;
    }
    if (key === 'predictionMonitor') {
      if (monitorVisible) pushLast('predictionMonitor');
      return;
    }
    if (key === 'cpi' || key === 'predMkts' || key === 'predictionMarkets') return;
    if (PERSISTED_SIDEBAR_PANELS.has(key) && !migratedStack.includes(key)) migratedStack.push(key);
  });

  if (monitorVisible && !migratedStack.includes('predictionMonitor')) migratedStack.push('predictionMonitor');

  return {
    ...state,
    showPredictionMonitor: monitorVisible,
    activePredictionMonitorMarket: currentMonitorVisible
      && PREDICTION_MONITOR_MARKETS.has(state?.activePredictionMonitorMarket)
      ? state.activePredictionMonitorMarket
      : 'sp500',
    sidebarPanelStack: migratedStack,
  };
};

const readPersistedSidebarStack = (state) => (
  Array.isArray(state?.sidebarPanelStack)
    ? [...new Set(state.sidebarPanelStack.filter((key) => PERSISTED_SIDEBAR_PANELS.has(key)))]
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
  'oneYearChangePct',
];

const PERIOD_RETURN_METADATA_FIELDS = [
  'periodReturnsAsOf',
  'periodReturnsStatus',
  'periodReturnsSource',
];

const QUOTE_VISUAL_FIELDS = ['sparklineData'];

const mergeRowsPreservingPeriods = (
  previousRows = [],
  nextRows = [],
  { preservePeriods = true } = {},
) => {
  if (!Array.isArray(previousRows) || !Array.isArray(nextRows)) return nextRows;
  const previousBySymbol = new Map(previousRows.map((row) => [row?.symbol, row]));
  return nextRows.map((row) => {
    const previous = previousBySymbol.get(row?.symbol);
    if (!previous) return row;
    const merged = { ...previous, ...row };
    PERIOD_RETURN_FIELDS.forEach((field) => {
      if (preservePeriods && row[field] == null && previous[field] != null) {
        merged[field] = previous[field];
      }
    });
    PERIOD_RETURN_METADATA_FIELDS.forEach((field) => {
      if (preservePeriods && previous[field] != null) {
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

const mergeMarketDataPreservingPeriods = (previous = {}, next = {}, options = {}) => {
  const merged = { ...previous, ...next };
  Object.entries(next || {}).forEach(([regionKey, regionValue]) => {
    if (Array.isArray(regionValue)) {
      merged[regionKey] = mergeRowsPreservingPeriods(previous?.[regionKey], regionValue, options);
      return;
    }
    if (regionValue && typeof regionValue === 'object') {
      merged[regionKey] = Object.fromEntries(
        Object.entries(regionValue).map(([tabKey, rows]) => [
          tabKey,
          mergeRowsPreservingPeriods(previous?.[regionKey]?.[tabKey], rows, options),
        ])
      );
    }
  });
  return merged;
};

const PortfolioDashboard = ({
  processDocumentId = null,
  onOpenProcess,
  onNavigateProcess,
  onCloseProcess,
  onOpenWhitePaper,
}) => {
  const surfaceActive = useSurfaceActivity();
  const dashboardWarmupQueueRef = useRef(null);
  const warmupsEnqueuedQueueRef = useRef(null);
  useEffect(() => {
    if (!isDashboardSessionRetentionEnabled()) return undefined;
    const queue = createDashboardWarmupQueue({ concurrency: 2 });
    dashboardWarmupQueueRef.current = queue;
    return () => {
      if (dashboardWarmupQueueRef.current === queue) dashboardWarmupQueueRef.current = null;
      queue.dispose();
    };
  }, []);
  const promoteDashboardWarmups = useCallback((keys = []) => {
    const queue = dashboardWarmupQueueRef.current;
    if (!queue) return;
    keys.forEach((key) => {
      const promoted = queue.promote(key);
      if (promoted) promoted.catch(() => {});
    });
  }, []);
  const openProcess = useCallback(() => {
    if (onOpenProcess) return onOpenProcess();
    if (onOpenWhitePaper) return onOpenWhitePaper();
    window.location.hash = '/process';
    return undefined;
  }, [onOpenProcess, onOpenWhitePaper]);
  const isProcessOpen = Boolean(processDocumentId);
  const isExposureGuideOpen = processDocumentId === EXPOSURE_GUIDE_DOCUMENT_ID;
  const { theme } = useTheme();
  const [hedgeyeChangelog, setHedgeyeChangelog] = useState(null);
  const [hedgeyeChangelogLoading, setHedgeyeChangelogLoading] = useState(true);
  const [hedgeyeChangelogError, setHedgeyeChangelogError] = useState(null);
  const [selectedAccount, setSelectedAccount] = useState(() => loadSelectedAccount());
  const loadPortfolio = useCallback(() => withTimeout(
    MarketDataService.getPortfolio({ account: selectedAccount || undefined }),
    PORTFOLIO_REQUEST_TIMEOUT_MS,
    'Portfolio refresh',
  ), [selectedAccount]);
  const validatePortfolio = useCallback(
    (snapshot) => validateLivePortfolioSnapshot(snapshot, selectedAccount),
    [selectedAccount],
  );
  const portfolioResource = useDashboardResource('portfolio', {
    accountId: selectedAccount,
  }, {
    fetcher: loadPortfolio,
    validate: validatePortfolio,
    getObservedAt: (snapshot) => snapshot.fetchedAt,
    maxAgeMs: PORTFOLIO_LIVE_MAX_AGE_MS,
    pollIntervalMs: PORTFOLIO_POLL_MS,
    enabled: Boolean(selectedAccount),
    active: true,
    pollWhenHidden: true,
    pollWhenDocumentHidden: true,
    invalidateOnScopeChange: true,
    core: true,
    expectedScope: selectedAccount,
    getScope: (snapshot) => snapshot.accountId,
    expiredCode: 'PORTFOLIO_SNAPSHOT_EXPIRED',
    expiredMessage: 'The last verified live portfolio snapshot expired.',
  });
  const portfolioData = selectedAccount ? portfolioResource.data : null;
  const portfolioLoading = Boolean(
    selectedAccount && portfolioResource.initialLoading && !portfolioData
  );
  const portfolioRefreshing = Boolean(selectedAccount && portfolioResource.refreshing);
  const refreshPortfolioResource = portfolioResource.refresh;
  const ibkrAccountsRef = useRef([]);
  const selectedAccountRef = useRef(loadSelectedAccount());
  const [ibkrConnection, setIbkrConnection] = useState(null);
  const [providerStatus, setProviderStatus] = useState(null);
  const ibkrConnectionRef = useRef(null);
  const lastGoodProviderStatusRef = useRef(null);
  const providerStatusInFlightRef = useRef(null);
  const changelogInFlightRef = useRef(null);
  const changelogRefreshCompletedAtRef = useRef(0);
  const persistedPanelState = useMemo(
    () => migratePredictionMarketsPanelState(readDashboardPanelState()),
    [],
  );
  const [analystPanelWidth, setAnalystPanelWidth] = useState(() => (
    clampAnalystPanelWidth(persistedPanelState.analystPanelWidth)
  ));
  const [analystPanelPosition, setAnalystPanelPosition] = useState(() => (
    normalizeAnalystPanelPosition(persistedPanelState.analystPanelPosition)
  ));
  const selectedAnalystPanelPosition = ANALYST_PANEL_POSITIONS.has(analystPanelPosition)
    ? analystPanelPosition
    : null;
  const analystPanelResizeEdge = ['left', 'center'].includes(analystPanelPosition)
    ? 'right'
    : 'left';
  const [analystPanelResizing, setAnalystPanelResizing] = useState(false);
  const analystPanelSurfaceRef = useRef(null);
  const analystPanelResizeCleanupRef = useRef(null);
  const [contractPnlPanelWidth, setContractPnlPanelWidth] = useState(() => (
    clampContractPnlPanelWidth(persistedPanelState.contractPnlPanelWidth)
  ));
  const [contractPnlPanelRightExtension, setContractPnlPanelRightExtension] = useState(0);
  const contractPnlPanelDisplayedWidth = Math.min(
    CONTRACT_PNL_PANEL_MAX_WIDTH,
    contractPnlPanelWidth + contractPnlPanelRightExtension,
  );
  const [contractPnlPanelResizing, setContractPnlPanelResizing] = useState(false);
  const contractPnlPanelSurfaceRef = useRef(null);
  const contractPnlPanelResizeCleanupRef = useRef(null);
  const [showPortfolioBalance, setShowPortfolioBalance] = useState(false);
  const [showContractPnl, setShowContractPnl] = useState(false);
  const [showMorningTldr, setShowMorningTldr] = useState(() => readPersistedBoolean(persistedPanelState, 'showMorningTldr'));
  const [showAnalyst, setShowAnalyst] = useState(() => readPersistedBoolean(persistedPanelState, 'showAnalyst'));
  const [showBookMenu, setShowBookMenu] = useState(false);
  const [showBookModal, setShowBookModal] = useState(false);
  const [selectedBookContent, setSelectedBookContent] = useState(null);
  const [selectedBookTitle, setSelectedBookTitle] = useState('');
  const [bookMenuPosition, setBookMenuPosition] = useState({ top: 0, right: 0 });
  const bookMenuRef = useRef(null);
  const bookPopoverRef = useRef(null);
  const processButtonRef = useRef(null);
  const exposureGuideButtonRef = useRef(null);
  const processReturnFocusTargetRef = useRef(null);
  const lastProcessDocumentIdRef = useRef(processDocumentId);
  const dashboardCanvasRef = useRef(null);
  const restoreProcessFocusRef = useRef(true);
  const [showWorkflowStatus, setShowWorkflowStatus] = useState(() => readPersistedBoolean(persistedPanelState, 'showWorkflowStatus'));
  const [showSystemReadiness, setShowSystemReadiness] = useState(() => readPersistedBoolean(persistedPanelState, 'showSystemReadiness'));
  const [systemReadinessStatus, setSystemReadinessStatus] = useState('unknown');
  const [dashboardCardStatuses, setDashboardCardStatuses] = useState(
    createUnknownDashboardCardStatuses,
  );
  const [analyticsRefreshKey, setAnalyticsRefreshKey] = useState(0);
  const [showPerformanceTracking, setShowPerformanceTracking] = useState(() => readPersistedBoolean(persistedPanelState, 'showPerformanceTracking'));
  const [showPredictionMonitor, setShowPredictionMonitor] = useState(() => (
    readPersistedBoolean(persistedPanelState, 'showPredictionMonitor')
  ));
  const [activePredictionMonitorMarket, setActivePredictionMonitorMarket] = useState(() => (
    PREDICTION_MONITOR_MARKETS.has(persistedPanelState.activePredictionMonitorMarket)
      ? persistedPanelState.activePredictionMonitorMarket
      : 'sp500'
  ));
  const [showSignalStrength, setShowSignalStrength] = useState(() => readPersistedBoolean(persistedPanelState, 'showSignalStrength'));
  const [showEtfPro, setShowEtfPro] = useState(() => readPersistedBoolean(persistedPanelState, 'showEtfPro'));
  const [showMacroShow, setShowMacroShow] = useState(() => readPersistedBoolean(persistedPanelState, 'showMacroShow'));
  const [showCall, setShowCall] = useState(() => readPersistedBoolean(persistedPanelState, 'showCall'));
  const [showPortfolioBreakdown, setShowPortfolioBreakdown] = useState(() => readPersistedBoolean(persistedPanelState, 'showPortfolioBreakdown'));
  const [showExposureLab, setShowExposureLab] = useState(() => readPersistedBoolean(persistedPanelState, 'showExposureLab'));
  const [sidebarPanelStack, setSidebarPanelStack] = useState(() => readPersistedSidebarStack(persistedPanelState));
  const [periodHydrationEnabled, setPeriodHydrationEnabled] = useState(false);
  const loadEtfProSnapshot = useCallback(
    () => MarketDataService.getHedgeyeEtfPro(),
    [],
  );
  const etfProResource = useDashboardResource('etf-pro', {}, {
    fetcher: loadEtfProSnapshot,
    validate: (value) => (
      value
      && typeof value === 'object'
      && Array.isArray(value.rows)
      && value.mock !== true
      && value.seeded !== true
        ? value
        : null
    ),
    getObservedAt: (value) => value?.meta?.snapshotDate || value?.generatedAt,
    pollIntervalMs: REFERENCE_DATA_POLL_MS,
    active: surfaceActive && showEtfPro,
    refreshOnActivate: false,
  });
  const etfProSnapshot = useMemo(() => {
    if (!etfProResource.data) return null;
    const prepared = prepareReferenceComparisonSnapshot(etfProResource.data, {
      staleWarning: ETF_PRO_STALE_WARNING,
    });
    if (!etfProResource.error) return prepared;
    return markReferenceRefreshFailed(prepared, {
      warning: 'The latest ETF Pro refresh failed; retained rows are a prior dated reference.',
      error: etfProResource.error.message,
      emptyState: { rows: [], longCount: null, shortCount: null },
    });
  }, [etfProResource.data, etfProResource.error]);
  const etfProLoading = etfProResource.initialLoading && !etfProResource.data;
  const etfProRefreshing = etfProResource.refreshing;
  const etfProError = etfProResource.error?.message || null;
  const refreshEtfProResource = etfProResource.refresh;
  const fetchEtfProSnapshot = useCallback(
    () => refreshEtfProResource(),
    [refreshEtfProResource],
  );
  const [predictionIndicatorNow, setPredictionIndicatorNow] = useState(() => Date.now());
  const loadPredictionMarketIndicators = useCallback(async () => {
    const report = await predictionMarketTestService.getMorningReport();
    return normalizePredictionMarketNavIndicators(report);
  }, []);
  const predictionIndicatorResource = useDashboardResource('prediction-nav', {}, {
    fetcher: loadPredictionMarketIndicators,
    getObservedAt: (snapshot) => snapshot.generatedAt,
    maxAgeMs: PREDICTION_MARKET_INDICATOR_MAX_AGE_MS,
    pollIntervalMs: PREDICTION_MARKET_INDICATOR_POLL_MS,
    active: true,
    pollWhenHidden: true,
    pollWhenDocumentHidden: true,
    isExplicitInvalidation: () => true,
    expiredCode: 'PREDICTION_MARKET_INDICATORS_EXPIRED',
    expiredMessage: 'Prediction-market alignment indicators expired.',
  });
  const predictionMarketIndicators = useMemo(() => (
    activePredictionMarketNavIndicators(predictionIndicatorResource.data, {
      now: Math.max(predictionIndicatorNow, Date.now()),
    })
  ), [predictionIndicatorNow, predictionIndicatorResource.data]);
  useEffect(() => {
    const futureExpiries = Object.values(predictionIndicatorResource.data?.indicators || {})
      .map((indicator) => Date.parse(String(indicator?.expiresAt || '')))
      .filter((expiresAt) => Number.isFinite(expiresAt) && expiresAt > Date.now());
    if (!futureExpiries.length) return undefined;
    const timer = setTimeout(() => {
      setPredictionIndicatorNow(Date.now());
    }, Math.max(0, Math.min(...futureExpiries) - Date.now() + 1));
    return () => clearTimeout(timer);
  }, [predictionIndicatorNow, predictionIndicatorResource.data]);
  const loadCurrentMarketQuotes = useCallback(
    () => MarketDataService.getMultiRegionQuotes(null, true, false),
    [],
  );
  const loadMarketPeriodReturns = useCallback(
    () => MarketDataService.getMultiRegionQuotes(null, false, true),
    [],
  );
  const currentMarketResource = useDashboardResource('market-quotes', {}, {
    fetcher: loadCurrentMarketQuotes,
    validate: validateMarketQuotePayload,
    getObservedAt: marketPayloadObservedAt,
    maxAgeMs: MARKET_QUOTES_MAX_AGE_MS,
    futureToleranceMs: MARKET_QUOTE_FUTURE_TOLERANCE_MS,
    pollIntervalMs: 30_000,
    active: true,
    pollWhenHidden: true,
    pollWhenDocumentHidden: true,
    // This resource is visual market context only. Retained values are
    // explicitly demoted to a dated reference and never feed order controls.
    isExplicitInvalidation: () => true,
    reconcileIncoming: reconcileMarketQuotePayload,
    core: true,
    expiredCode: 'MARKET_QUOTES_EXPIRED',
    expiredMessage: 'The last verified market quote observations expired.',
  });
  const periodReturnsResource = useDashboardResource('market-period-returns', {}, {
    fetcher: loadMarketPeriodReturns,
    validate: validatePeriodReturnPayload,
    getObservedAt: (payload) => marketPayloadObservedAt(payload, { periodOnly: true }),
    pollIntervalMs: MARKET_PERIOD_RETURNS_POLL_MS,
    enabled: periodHydrationEnabled,
    active: surfaceActive,
    refreshOnActivate: false,
    pollWhenHidden: false,
    core: true,
  });
  const currentMarketDataForDisplay = useMemo(() => {
    if (!currentMarketResource.data) return null;
    if (['refresh-delayed', 'delayed-reference'].includes(currentMarketResource.availability)) {
      return markMarketQuotePayloadRefreshDelayed(
        currentMarketResource.data,
        currentMarketResource.error?.code || 'market_quote_refresh_delayed',
      );
    }
    return currentMarketResource.data;
  }, [
    currentMarketResource.availability,
    currentMarketResource.data,
    currentMarketResource.error?.code,
  ]);
  const multiRegionMarketData = useMemo(() => (
    currentMarketDataForDisplay
      ? mergeMarketDataPreservingPeriods(
        periodReturnsResource.data || {},
        currentMarketDataForDisplay,
        { preservePeriods: true },
      )
      : {}
  ), [currentMarketDataForDisplay, periodReturnsResource.data]);
  const multiRegionLoading = Boolean(
    currentMarketResource.initialLoading && !currentMarketResource.data
  );
  const multiRegionError = currentMarketResource.error?.message
    || (periodReturnsResource.error && currentMarketResource.data
      ? `Period-return refresh delayed: ${periodReturnsResource.error.message}`
      : null);
  const dashboardInitialSettled = !multiRegionLoading
    && (!selectedAccount || !portfolioLoading);

  useEffect(() => {
    const queue = dashboardWarmupQueueRef.current;
    if (
      !isDashboardSessionRetentionEnabled()
      || !surfaceActive
      || !dashboardInitialSettled
      || !queue
      || warmupsEnqueuedQueueRef.current === queue
    ) return;
    warmupsEnqueuedQueueRef.current = queue;

    const resourceWarmups = [
      {
        key: 'resource:etf-pro',
        run: () => warmDashboardResource('etf-pro', {}, {
          fetcher: () => MarketDataService.getHedgeyeEtfPro(),
        }),
      },
      {
        key: 'resource:exposure-lab-universe',
        run: ({ signal }) => warmDashboardResource('exposure-lab-universe', {}, {
          fetcher: () => MarketDataService.getExposureLabUniverse({ forceRefresh: false, signal }),
        }),
      },
      ...PREDICTION_MONITOR_NAV_ITEMS.map(({ marketId }) => {
        const monitorContext = canonicalPredictionMonitorContext({
          marketId,
          venue: 'auto',
          generationId: null,
        });
        return {
          key: `resource:prediction-monitor:${marketId}`,
          run: ({ signal }) => warmDashboardResource('prediction-monitor', monitorContext, {
            fetcher: () => predictionMarketTestService.getMonitor(marketId, {
              signal,
              venue: monitorContext.venue,
              generationId: monitorContext.generationId,
            }),
          }),
        };
      }),
    ];

    [...DASHBOARD_LAZY_WARMUPS, ...resourceWarmups].forEach((task, index) => {
      queue.enqueue({ ...task, priority: -index }).catch(() => {
        // Warmup is opportunistic. The mounted panel owns user-visible errors
        // and will retry through the same keyed resource if it is opened.
      });
    });
  }, [dashboardInitialSettled, surfaceActive]);
  const [bookContentMap, setBookContentMap] = useState(null);
  const [bookContentLoading, setBookContentLoading] = useState(false);
  if (processDocumentId) lastProcessDocumentIdRef.current = processDocumentId;

  useEffect(() => {
    if (dashboardCanvasRef.current) {
      dashboardCanvasRef.current.inert = isProcessOpen;
    }
  }, [isProcessOpen]);

  useEffect(() => {
    if (!isProcessOpen) return undefined;

    restoreProcessFocusRef.current = true;
    setShowPortfolioBalance(false);
    setShowContractPnl(false);
    setShowBookMenu(false);
    setShowBookModal(false);
    setShowWorkflowStatus(false);
    setShowSystemReadiness(false);
    setShowPerformanceTracking(false);
    setShowPredictionMonitor(false);
    setShowMorningTldr(false);
    setShowAnalyst(false);
    setShowSignalStrength(false);
    setShowEtfPro(false);
    setShowMacroShow(false);
    setShowCall(false);
    setShowPortfolioBreakdown(false);
    setShowExposureLab(false);
    setSidebarPanelStack([]);

    return undefined;
  }, [isProcessOpen]);

  useEffect(() => {
    if (isProcessOpen || !restoreProcessFocusRef.current) return;

    (processReturnFocusTargetRef.current || processButtonRef.current)?.focus();
    processReturnFocusTargetRef.current = null;
    restoreProcessFocusRef.current = false;
  }, [isProcessOpen]);

  // Reading popups should never be hidden behind the compact utility panels.
  useEffect(() => {
    if (isProcessOpen || (!showAnalyst && !showMorningTldr)) return;
    setShowPortfolioBalance(false);
    setShowContractPnl(false);
  }, [isProcessOpen, showAnalyst, showMorningTldr]);

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
    promoteDashboardWarmups(PANEL_WARMUP_TASK_KEYS[panelKey] || []);
    setPanelVisible((isVisible) => {
      const nextVisible = !isVisible;

      if (nextVisible) {
        setShowPortfolioBalance(false);
        setShowContractPnl(false);
        bringSidebarPanelToFront(panelKey);
      } else {
        removeSidebarPanelFromStack(panelKey);
      }

      return nextVisible;
    });
  }, [bringSidebarPanelToFront, promoteDashboardWarmups, removeSidebarPanelFromStack]);

  const setAnalystPanelDock = useCallback((position) => {
    const nextPosition = normalizeAnalystPanelPosition(position);
    if (nextPosition === ANALYST_PANEL_DEFAULT_POSITION) return;
    setAnalystPanelPosition(nextPosition);
    if (showAnalyst) bringSidebarPanelToFront('analyst');
  }, [bringSidebarPanelToFront, showAnalyst]);

  const closeSidebarPanel = useCallback((panelKey, setPanelVisible) => {
    setPanelVisible(false);
    removeSidebarPanelFromStack(panelKey);
  }, [removeSidebarPanelFromStack]);

  const closeExposureLab = useCallback(() => {
    closeSidebarPanel('exposureLab', setShowExposureLab);
  }, [closeSidebarPanel]);

  const closePredictionMonitor = useCallback(() => {
    setShowPredictionMonitor(false);
    removeSidebarPanelFromStack('predictionMonitor');
  }, [removeSidebarPanelFromStack]);

  const togglePredictionMonitor = useCallback((marketId) => {
    if (!PREDICTION_MONITOR_MARKETS.has(marketId)) return;
    promoteDashboardWarmups([
      'chunk:prediction-monitor',
      `resource:prediction-monitor:${marketId}`,
    ]);
    if (showPredictionMonitor && activePredictionMonitorMarket === marketId) {
      closePredictionMonitor();
      return;
    }
    setShowPortfolioBalance(false);
    setShowContractPnl(false);
    setActivePredictionMonitorMarket(marketId);
    setShowPredictionMonitor(true);
    bringSidebarPanelToFront('predictionMonitor');
  }, [
    activePredictionMonitorMarket,
    bringSidebarPanelToFront,
    closePredictionMonitor,
    promoteDashboardWarmups,
    showPredictionMonitor,
  ]);

  const getSidebarPanelZIndex = useCallback((panelKey, isVisible) => {
    if (!isVisible) return -1;

    const stackIndex = sidebarPanelStack.indexOf(panelKey);
    return SIDEBAR_PANEL_Z_INDEX_BASE + Math.max(stackIndex, 0);
  }, [sidebarPanelStack]);

  const togglePortfolioBalance = useCallback(() => {
    if (isProcessOpen) return;
    setShowContractPnl(false);
    setShowPortfolioBalance((isVisible) => !isVisible);
  }, [isProcessOpen]);

  const toggleContractPnl = useCallback(() => {
    if (isProcessOpen) return;
    setShowPortfolioBalance(false);
    setShowContractPnl((isVisible) => !isVisible);
  }, [isProcessOpen]);

  const getAnalystPanelResizeLimits = useCallback(() => {
    const bounds = analystPanelSurfaceRef.current?.getBoundingClientRect();
    if (!bounds || !Number.isFinite(bounds.width) || bounds.width <= 0) {
      return {
        currentWidth: analystPanelWidth,
        minWidth: ANALYST_PANEL_MIN_WIDTH,
        maxWidth: ANALYST_PANEL_MAX_WIDTH,
      };
    }

    const viewportWidth = typeof window === 'undefined'
      ? bounds.right + ANALYST_PANEL_EDGE_INSET
      : window.innerWidth;
    const availableWidth = analystPanelPosition === 'left'
      ? bounds.width + Math.max(0, viewportWidth - bounds.right - ANALYST_PANEL_EDGE_INSET)
      : analystPanelPosition === 'center'
        ? bounds.width + (2 * Math.max(0, Math.min(
          bounds.left - ANALYST_PANEL_EDGE_INSET,
          viewportWidth - bounds.right - ANALYST_PANEL_EDGE_INSET,
        )))
        : bounds.width + Math.max(0, bounds.left - ANALYST_PANEL_EDGE_INSET);
    const maxWidth = Math.max(
      Math.min(ANALYST_PANEL_MIN_WIDTH, bounds.width),
      Math.min(ANALYST_PANEL_MAX_WIDTH, availableWidth),
    );
    return {
      currentWidth: bounds.width,
      minWidth: Math.min(ANALYST_PANEL_MIN_WIDTH, maxWidth),
      maxWidth,
    };
  }, [analystPanelPosition, analystPanelWidth]);

  const beginAnalystPanelResize = useCallback((event) => {
    if (event.button != null && event.button !== 0) return;
    const startX = Number(event.clientX);
    if (!Number.isFinite(startX)) return;

    event.preventDefault();
    analystPanelResizeCleanupRef.current?.();

    const { currentWidth, minWidth, maxWidth } = getAnalystPanelResizeLimits();
    const move = (moveEvent) => {
      const clientX = Number(moveEvent.clientX);
      if (!Number.isFinite(clientX)) return;
      const widthDelta = analystPanelResizeEdge === 'right'
        ? clientX - startX
        : startX - clientX;
      setAnalystPanelWidth(clampAnalystPanelWidth(
        currentWidth + widthDelta,
        minWidth,
        maxWidth,
      ));
    };
    const cleanup = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      document.body.classList.remove('dashboard-is-resizing-analyst');
    };
    const finish = () => {
      cleanup();
      analystPanelResizeCleanupRef.current = null;
      setAnalystPanelResizing(false);
    };

    analystPanelResizeCleanupRef.current = cleanup;
    setAnalystPanelResizing(true);
    document.body.classList.add('dashboard-is-resizing-analyst');
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
  }, [analystPanelResizeEdge, getAnalystPanelResizeLimits]);

  const handleAnalystPanelResizeKeyDown = useCallback((event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const { currentWidth, minWidth, maxWidth } = getAnalystPanelResizeLimits();
    const step = event.shiftKey ? ANALYST_PANEL_RESIZE_STEP * 4 : ANALYST_PANEL_RESIZE_STEP;
    const resizeFromRightEdge = analystPanelResizeEdge === 'right';
    const requestedWidth = event.key === 'Home'
      ? minWidth
      : event.key === 'End'
        ? maxWidth
        : currentWidth + (event.key === 'ArrowLeft'
          ? (resizeFromRightEdge ? -step : step)
          : (resizeFromRightEdge ? step : -step));
    setAnalystPanelWidth(clampAnalystPanelWidth(requestedWidth, minWidth, maxWidth));
  }, [analystPanelResizeEdge, getAnalystPanelResizeLimits]);

  const getContractPnlPanelResizeLimits = useCallback((resizeEdge = 'left') => {
    const bounds = contractPnlPanelSurfaceRef.current?.getBoundingClientRect();
    const resizeFromRightEdge = resizeEdge === 'right';
    if (!bounds || !Number.isFinite(bounds.width) || bounds.width <= 0) {
      return {
        currentWidth: contractPnlPanelDisplayedWidth,
        minWidth: resizeFromRightEdge
          ? Math.max(
            CONTRACT_PNL_PANEL_MIN_WIDTH,
            contractPnlPanelDisplayedWidth - contractPnlPanelRightExtension,
          )
          : Math.min(
            CONTRACT_PNL_PANEL_MAX_WIDTH,
            CONTRACT_PNL_PANEL_MIN_WIDTH + contractPnlPanelRightExtension,
          ),
        maxWidth: CONTRACT_PNL_PANEL_MAX_WIDTH,
      };
    }

    const viewportWidth = typeof window === 'undefined' ? bounds.right : window.innerWidth;
    const availableWidth = bounds.width + Math.max(0, resizeFromRightEdge
      ? viewportWidth - CONTRACT_PNL_PANEL_EDGE_INSET - bounds.right
      : bounds.left - CONTRACT_PNL_PANEL_EDGE_INSET);
    const requestedMinWidth = resizeFromRightEdge
      ? Math.max(
        Math.min(CONTRACT_PNL_PANEL_MIN_WIDTH, bounds.width),
        bounds.width - contractPnlPanelRightExtension,
      )
      : Math.min(
        CONTRACT_PNL_PANEL_MAX_WIDTH,
        CONTRACT_PNL_PANEL_MIN_WIDTH + contractPnlPanelRightExtension,
      );
    const maxWidth = Math.max(
      Math.min(requestedMinWidth, bounds.width),
      Math.min(CONTRACT_PNL_PANEL_MAX_WIDTH, availableWidth),
    );
    return {
      currentWidth: bounds.width,
      minWidth: Math.min(requestedMinWidth, maxWidth),
      maxWidth,
    };
  }, [contractPnlPanelDisplayedWidth, contractPnlPanelRightExtension]);

  const beginContractPnlPanelResize = useCallback((event, resizeEdge = 'left') => {
    if (event.button != null && event.button !== 0) return;
    const startX = Number(event.clientX);
    if (!Number.isFinite(startX)) return;

    event.preventDefault();
    contractPnlPanelResizeCleanupRef.current?.();

    const resizeFromRightEdge = resizeEdge === 'right';
    const startingPanelWidth = contractPnlPanelWidth;
    const startingRightExtension = contractPnlPanelRightExtension;
    const { currentWidth, minWidth, maxWidth } = getContractPnlPanelResizeLimits(resizeEdge);
    const move = (moveEvent) => {
      const clientX = Number(moveEvent.clientX);
      if (!Number.isFinite(clientX)) return;
      const requestedWidth = currentWidth + (resizeFromRightEdge
        ? clientX - startX
        : startX - clientX);
      const nextWidth = clampContractPnlPanelWidth(
        requestedWidth,
        minWidth,
        maxWidth,
      );
      const widthDelta = nextWidth - currentWidth;
      if (resizeFromRightEdge) {
        setContractPnlPanelRightExtension(Math.max(
          0,
          Math.min(
            CONTRACT_PNL_PANEL_MAX_WIDTH - startingPanelWidth,
            startingRightExtension + widthDelta,
          ),
        ));
      } else {
        setContractPnlPanelWidth(clampContractPnlPanelWidth(
          startingPanelWidth + widthDelta,
          CONTRACT_PNL_PANEL_MIN_WIDTH,
          CONTRACT_PNL_PANEL_MAX_WIDTH - startingRightExtension,
        ));
      }
    };
    const cleanup = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      document.body.classList.remove('dashboard-is-resizing-contract-pnl');
    };
    const finish = () => {
      cleanup();
      contractPnlPanelResizeCleanupRef.current = null;
      setContractPnlPanelResizing(false);
    };

    contractPnlPanelResizeCleanupRef.current = cleanup;
    setContractPnlPanelResizing(true);
    document.body.classList.add('dashboard-is-resizing-contract-pnl');
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
  }, [
    contractPnlPanelRightExtension,
    contractPnlPanelWidth,
    getContractPnlPanelResizeLimits,
  ]);

  const handleContractPnlPanelResizeKeyDown = useCallback((event, resizeEdge = 'left') => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const resizeFromRightEdge = resizeEdge === 'right';
    const { currentWidth, minWidth, maxWidth } = getContractPnlPanelResizeLimits(resizeEdge);
    const step = event.shiftKey
      ? CONTRACT_PNL_PANEL_RESIZE_STEP * 4
      : CONTRACT_PNL_PANEL_RESIZE_STEP;
    const requestedWidth = event.key === 'Home'
      ? minWidth
      : event.key === 'End'
        ? maxWidth
        : currentWidth + (event.key === 'ArrowLeft'
          ? (resizeFromRightEdge ? -step : step)
          : (resizeFromRightEdge ? step : -step));
    const nextWidth = clampContractPnlPanelWidth(
      requestedWidth,
      minWidth,
      maxWidth,
    );
    const widthDelta = nextWidth - currentWidth;
    if (resizeFromRightEdge) {
      setContractPnlPanelRightExtension((current) => Math.max(
        0,
        Math.min(CONTRACT_PNL_PANEL_MAX_WIDTH - contractPnlPanelWidth, current + widthDelta),
      ));
    } else {
      setContractPnlPanelWidth((current) => clampContractPnlPanelWidth(
        current + widthDelta,
        CONTRACT_PNL_PANEL_MIN_WIDTH,
        CONTRACT_PNL_PANEL_MAX_WIDTH - contractPnlPanelRightExtension,
      ));
    }
  }, [
    contractPnlPanelRightExtension,
    contractPnlPanelWidth,
    getContractPnlPanelResizeLimits,
  ]);

  const resetContractPnlPanelSize = useCallback(() => {
    setContractPnlPanelWidth(CONTRACT_PNL_PANEL_DEFAULT_WIDTH);
    setContractPnlPanelRightExtension(0);
  }, []);

  useEffect(() => () => {
    analystPanelResizeCleanupRef.current?.();
    document.body.classList.remove('dashboard-is-resizing-analyst');
    contractPnlPanelResizeCleanupRef.current?.();
    document.body.classList.remove('dashboard-is-resizing-contract-pnl');
  }, []);

  useEffect(() => {
    if (showContractPnl) return;
    contractPnlPanelResizeCleanupRef.current?.();
    contractPnlPanelResizeCleanupRef.current = null;
    document.body.classList.remove('dashboard-is-resizing-contract-pnl');
    setContractPnlPanelResizing(false);
  }, [showContractPnl]);

  const activeNavigationItemIds = useMemo(() => {
    if (isProcessOpen) return [isExposureGuideOpen ? 'exposureGuide' : 'process'];

    return [
      showSystemReadiness && 'system',
      showMorningTldr && 'tldr',
      showAnalyst && 'analyst',
      showPortfolioBreakdown && 'portfolio',
      showExposureLab && 'exposureLab',
      showPortfolioBalance && 'balance',
      showContractPnl && 'contractPnl',
      showPredictionMonitor && `predictionMonitor-${activePredictionMonitorMarket}`,
    ].filter(Boolean);
  }, [
    isProcessOpen,
    isExposureGuideOpen,
    showAnalyst,
    showMorningTldr,
    showContractPnl,
    showPortfolioBalance,
    showPortfolioBreakdown,
    showExposureLab,
    showPredictionMonitor,
    activePredictionMonitorMarket,
    showSystemReadiness,
  ]);

  const activeNavigationItemId = useMemo(() => {
    if (isProcessOpen) return isExposureGuideOpen ? 'exposureGuide' : 'process';
    if (showContractPnl) return 'contractPnl';
    if (showPortfolioBalance) return 'balance';

    return [...sidebarPanelStack]
      .reverse()
      .map((panelKey) => panelKey === 'predictionMonitor'
        ? `predictionMonitor-${activePredictionMonitorMarket}`
        : panelKey)
      .find((panelKey) => activeNavigationItemIds.includes(panelKey))
      || activeNavigationItemIds[activeNavigationItemIds.length - 1]
      || null;
  }, [
    activeNavigationItemIds,
    activePredictionMonitorMarket,
    isProcessOpen,
    isExposureGuideOpen,
    showContractPnl,
    showPortfolioBalance,
    sidebarPanelStack,
  ]);

  const navigationItems = useMemo(() => [
    {
      id: 'system',
      group: 'utility',
      icon: Monitor,
      label: 'Systems',
      description: 'Core system status and health',
      title: 'Systems',
      onSelect: () => toggleSidebarPanel('system', setShowSystemReadiness),
    },
    {
      id: 'x',
      group: 'primary',
      icon: 'x',
      label: 'X.com',
      description: 'Monitor X.com activity',
      title: 'Open X (Twitter) List',
      external: true,
      onSelect: () => window.open('https://x.com/i/lists/1986465259113357401', '_blank', 'noopener,noreferrer'),
    },
    ANALYST_NAVIGATION.showLegacyTldr
      ? {
          id: 'tldr',
          group: 'primary',
          icon: FileText,
          label: 'TL;DR',
          description: 'Morning research summary and changes',
          title: 'Open TL;DR',
          onSelect: () => toggleSidebarPanel('tldr', setShowMorningTldr),
        }
      : {
          id: 'analyst',
          group: 'utility',
          icon: MessageSquare,
          label: 'The Analyst',
          description: 'Cited research and live portfolio context',
          title: 'Open The Analyst',
          onSelect: () => toggleSidebarPanel('analyst', setShowAnalyst),
          analystPanelPosition: selectedAnalystPanelPosition,
          onAnalystPanelPositionChange: setAnalystPanelDock,
        },
    {
      id: 'process',
      group: 'primary',
      icon: Share2,
      label: 'Process',
      description: 'Workflows and automation',
      title: 'Process',
      buttonRef: processButtonRef,
      isProcessToggle: true,
      onSelect: () => {
        setShowPortfolioBalance(false);
        setShowContractPnl(false);
        setShowBookMenu(false);
        processReturnFocusTargetRef.current = processButtonRef.current;
        if (isExposureGuideOpen) {
          restoreProcessFocusRef.current = true;
          if (onNavigateProcess) onNavigateProcess(PROCESS_ROUTE);
          else window.location.hash = PROCESS_ROUTE.slice(1);
          return;
        }
        if (isProcessOpen) {
          restoreProcessFocusRef.current = true;
          onCloseProcess?.();
          return;
        }
        openProcess();
      },
    },
    {
      id: 'exposureGuide',
      group: 'primary',
      icon: FileText,
      label: 'Exposure Guide',
      description: 'How to operate Exposure Lab and interpret its risk model',
      title: 'Exposure Lab Guide',
      buttonRef: exposureGuideButtonRef,
      isProcessToggle: true,
      onSelect: () => {
        setShowPortfolioBalance(false);
        setShowContractPnl(false);
        setShowBookMenu(false);
        processReturnFocusTargetRef.current = exposureGuideButtonRef.current;
        if (isExposureGuideOpen) {
          restoreProcessFocusRef.current = true;
          onCloseProcess?.();
          return;
        }
        restoreProcessFocusRef.current = true;
        if (onNavigateProcess) onNavigateProcess(EXPOSURE_GUIDE_ROUTE);
        else window.location.hash = EXPOSURE_GUIDE_ROUTE.slice(1);
      },
    },
    ANALYST_NAVIGATION.showResearchAnalyst && {
      id: 'analyst',
      group: 'utility',
      icon: MessageSquare,
      label: 'The Analyst',
      description: 'Cited research and live portfolio context',
      title: 'Open The Analyst',
      onSelect: () => toggleSidebarPanel('analyst', setShowAnalyst),
      analystPanelPosition: selectedAnalystPanelPosition,
      onAnalystPanelPositionChange: setAnalystPanelDock,
    },
    {
      id: 'portfolio',
      group: 'primary',
      icon: PieChart,
      label: 'Portfolio',
      description: 'Track performance and exposure',
      title: 'Portfolio Breakdown',
      onSelect: () => toggleSidebarPanel('portfolio', setShowPortfolioBreakdown),
    },
    {
      id: 'exposureLab',
      group: 'primary',
      icon: Table2,
      label: 'Exposure Lab',
      description: 'Factor exposures, correlations, and universe QA',
      title: 'Exposure Lab',
      onSelect: () => toggleSidebarPanel('exposureLab', setShowExposureLab),
    },
    {
      id: 'balance',
      group: 'primary',
      icon: Scale,
      label: 'Balance',
      description: 'Live cash and capacity',
      title: 'Portfolio balance',
      onSelect: togglePortfolioBalance,
    },
    {
      id: 'contractPnl',
      group: 'primary',
      icon: FileText,
      label: 'Contract P&L',
      description: 'Prediction-market contract profit and loss',
      title: 'Contract P&L',
      onSelect: toggleContractPnl,
    },
    ...PREDICTION_MONITOR_NAV_ITEMS.map(({ marketId, label, tier, indicatorMarketId, description }) => {
      const indicator = indicatorMarketId ? predictionMarketIndicators[indicatorMarketId] : null;
      return {
        id: `predictionMonitor-${marketId}`,
        group: 'primary',
        sectionLabel: tier,
        icon: Target,
        label,
        description,
        title: `${label} Prediction Monitor`,
        indicatorTone: indicator?.tone,
        indicatorDescription: indicator?.description,
        onSelect: () => togglePredictionMonitor(marketId),
      };
    }),
  ].filter(Boolean), [
    isProcessOpen,
    isExposureGuideOpen,
    onCloseProcess,
    onNavigateProcess,
    openProcess,
    predictionMarketIndicators,
    togglePredictionMonitor,
    toggleContractPnl,
    togglePortfolioBalance,
    toggleSidebarPanel,
    selectedAnalystPanelPosition,
    setAnalystPanelDock,
  ]);

  useEffect(() => {
    const nextPanelState = {
      showMorningTldr,
      showAnalyst,
      analystPanelWidth,
      contractPnlPanelWidth,
      showSystemReadiness,
      showWorkflowStatus,
      showPerformanceTracking,
      showPredictionMonitor,
      activePredictionMonitorMarket,
      showSignalStrength,
      showEtfPro,
      showMacroShow,
      showCall,
      showPortfolioBreakdown,
      showExposureLab,
      sidebarPanelStack,
    };
    if (analystPanelPosition !== ANALYST_PANEL_DEFAULT_POSITION) {
      nextPanelState.analystPanelPosition = analystPanelPosition;
    }
    writeDashboardPanelState(nextPanelState);
  }, [
    isProcessOpen,
    showAnalyst,
    analystPanelWidth,
    analystPanelPosition,
    contractPnlPanelWidth,
    showMorningTldr,
    showSystemReadiness,
    showWorkflowStatus,
    showPerformanceTracking,
    showPredictionMonitor,
    activePredictionMonitorMarket,
    showSignalStrength,
    showEtfPro,
    showMacroShow,
    showCall,
    showPortfolioBreakdown,
    showExposureLab,
    sidebarPanelStack,
  ]);

  const handleSystemReadinessStatus = useCallback((status) => {
    const normalized = String(status || '').trim().toLowerCase();
    const nextStatus = ['online', 'attention', 'offline', 'unknown'].includes(normalized)
      ? normalized
      : 'unknown';
    setSystemReadinessStatus(nextStatus);
  }, []);

  const handleDashboardStatusChange = useCallback((updates) => {
    setDashboardCardStatuses((current) => mergeDashboardCardStatuses(current, updates));
  }, []);

  useEffect(() => {
    const cancelBackgroundHydration = scheduleBackgroundTask(
      () => setPeriodHydrationEnabled(true),
      1500,
    );
    return () => cancelBackgroundHydration?.();
  }, []);

  useEffect(() => {
    if (
      process.env.NODE_ENV !== 'development'
      || !Array.isArray(multiRegionMarketData?.currencies)
      || multiRegionMarketData.currencies.length === 0
    ) return;
    const row = multiRegionMarketData.currencies[0];
    const hasPeriodRolling =
      Object.prototype.hasOwnProperty.call(row, 'thirtyDayChangePct')
      && Object.prototype.hasOwnProperty.call(row, 'ninetyDayChangePct');
    const hasSomePeriodTail =
      row?.ytdChangePct != null || row?.weekChangePct != null || row?.monthChangePct != null;
    if (!hasPeriodRolling && hasSomePeriodTail) {
      console.warn(
        '[market-dashboard] Currencies API is missing thirtyDayChangePct/ninetyDayChangePct — the Node server is probably an old build. Restart from this repo (`npm run server` or `node server.js`). API base:',
        process.env.REACT_APP_BACKEND_URL || 'http://localhost:3001'
      );
    }
  }, [multiRegionMarketData]);

  // Tag navigation state
  const [selectedTag, setSelectedTag] = useState(null);
  const bookContentRef = useRef(null);

  const fetchPortfolio = useCallback((accountId) => {
    const requestedAccount = String(accountId || '').trim();
    if (
      requestedAccount
      && selectedAccountRef.current
      && requestedAccount !== selectedAccountRef.current
    ) {
      return Promise.resolve(null);
    }
    return refreshPortfolioResource();
  }, [refreshPortfolioResource]);

  const fetchHedgeyeChangelog = useCallback(async (silent = false) => {
    if (changelogInFlightRef.current) return changelogInFlightRef.current;
    const request = (async () => {
      try {
        if (!silent) {
          setHedgeyeChangelogLoading(true);
        }
        setHedgeyeChangelogError(null);
        const data = await MarketDataService.getHedgeyeChangelog();
        setHedgeyeChangelog(data);
        changelogRefreshCompletedAtRef.current = Date.now();
        const cacheAgeSeconds = Number(data?._cache?.ageSeconds);
        if (data?._cache?.stale) {
          const ageLabel = Number.isFinite(cacheAgeSeconds)
            ? ` (${Math.max(1, Math.round(cacheAgeSeconds / 60))} minutes old)`
            : '';
          setHedgeyeChangelogError(`Showing a stale cached changelog response${ageLabel}.`);
        }
        return data;
      } catch (e) {
        console.error('Failed to load Hedgeye changelog:', e);
        setHedgeyeChangelogError(e.message || 'Failed to load latest updates');
        setHedgeyeChangelog((current) => current || {});
        return null;
      } finally {
        setHedgeyeChangelogLoading(false);
      }
    })().finally(() => {
      if (changelogInFlightRef.current === request) changelogInFlightRef.current = null;
    });
    changelogInFlightRef.current = request;
    return request;
  }, []);

  const handleAccountChange = useCallback((accountId) => {
    saveSelectedAccount(accountId);
    selectedAccountRef.current = accountId || '';
    setSelectedAccount(accountId);
    // The account-scoped resource key changes on the next render, so the old
    // account snapshot can never be exposed while the new read is in flight.
    return Promise.resolve(null);
  }, []);

  const refreshProviderStatus = useCallback(async () => {
    if (providerStatusInFlightRef.current) return providerStatusInFlightRef.current;
    const request = (async () => {
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
          saveIbkrAccounts(list);
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
          return delayedStatus;
        }
        setProviderStatus({
          unavailable: true,
          error: err.message || 'Provider status unavailable',
          responseTimestamp: new Date().toISOString(),
          ibkr: { connected: false, status: 'offline' },
        });
        setIbkrConnection(getIbkrConnectionDisplay({ status: null, error: err.message }));
        throw err;
      }
    })().finally(() => {
      if (providerStatusInFlightRef.current === request) providerStatusInFlightRef.current = null;
    });
    providerStatusInFlightRef.current = request;
    return request;
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
    handleAccountChange,
    refreshProviderStatus,
    resolvePortfolioAccount,
  };

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const status = await pollingFnsRef.current.refreshProviderStatus();
        if (cancelled) return;
        const acct = pollingFnsRef.current.resolvePortfolioAccount(status);
        if (acct && acct !== selectedAccountRef.current) {
          await pollingFnsRef.current.handleAccountChange(acct);
        }
      } catch {
        // Provider health decorates connection state. The independently keyed
        // portfolio resource owns its own availability and refresh lifecycle.
      }
    };

    load();

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
      clearTimeout(statusTimeout);
    };
    // Polling callbacks are read from pollingFnsRef so UI state changes do not
    // tear down and recreate the dashboard's background refresh loops.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!surfaceActive || (!showMorningTldr && !showSignalStrength)) return undefined;
    const poll = () => fetchHedgeyeChangelog(true);
    const elapsedMs = Date.now() - changelogRefreshCompletedAtRef.current;
    const initialDelayMs = changelogRefreshCompletedAtRef.current > 0
      ? Math.max(0, REFERENCE_DATA_POLL_MS - elapsedMs)
      : 0;
    if (initialDelayMs <= 0 && (typeof document === 'undefined' || !document.hidden)) poll();
    return startVisibilityAwarePolling({
      intervalMs: REFERENCE_DATA_POLL_MS,
      poll,
      initialDelayMs: initialDelayMs <= 0 ? REFERENCE_DATA_POLL_MS : initialDelayMs,
    });
  }, [fetchHedgeyeChangelog, showMorningTldr, showSignalStrength, surfaceActive]);

  useEffect(() => {
    const handler = () => {
      fetchPortfolio(resolvePortfolioAccount(), true).catch(() => {});
      if (showEtfPro) fetchEtfProSnapshot(true).catch(() => {});
      if (showMorningTldr || showSignalStrength) fetchHedgeyeChangelog(true).catch(() => {});
    };
    window.addEventListener('portfolioRefresh', handler);
    return () => window.removeEventListener('portfolioRefresh', handler);
  }, [
    fetchPortfolio,
    fetchEtfProSnapshot,
    fetchHedgeyeChangelog,
    resolvePortfolioAccount,
    showEtfPro,
    showMorningTldr,
    showSignalStrength,
  ]);

  const handlePortfolioRefresh = useCallback(async () => {
    const account = resolvePortfolioAccount();
    await Promise.allSettled([
      fetchPortfolio(account || undefined, true),
      showEtfPro ? fetchEtfProSnapshot(true) : Promise.resolve(null),
      showMorningTldr || showSignalStrength
        ? fetchHedgeyeChangelog(true)
        : Promise.resolve(null),
    ]);
    try {
      await refreshProviderStatus();
    } catch {
      // Provider status has its own display state; keep manual refresh from surfacing
      // as an unhandled promise in the React development overlay.
    }
  }, [
    fetchPortfolio,
    fetchEtfProSnapshot,
    fetchHedgeyeChangelog,
    refreshProviderStatus,
    resolvePortfolioAccount,
    showEtfPro,
    showMorningTldr,
    showSignalStrength,
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
    { name: 'The Coach — Source Notes', contentKey: 'The Coach', path: 'main/The Coach.md' },
    { name: 'The Playbook — Legacy', contentKey: 'The Playbook', path: 'main/The Playbook.md' },
    { name: 'Stop Losses — Legacy', contentKey: 'Stop Losses', path: 'main/Stop Losses.md' }
  ];

  const openBookFile = async (file) => {
    const fileName = file.contentKey || file.name;
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
      setSelectedBookTitle(file.name);
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

  const isRightWorkspaceOpen = showPortfolioBreakdown || showExposureLab || showPredictionMonitor;
  const isDashboardBackdropVisible = isRightWorkspaceOpen;

  return (
    <div
      data-testid="dashboard-shell"
      className="dashboard-shell min-h-screen p-2 bg-[#eef6fb] dark:bg-gray-900"
      style={{
        '--dashboard-rail-collapsed-width': DASHBOARD_RAIL_COLLAPSED_WIDTH,
        '--dashboard-rail-visible-width': DASHBOARD_RAIL_COLLAPSED_WIDTH,
        '--dashboard-active-rail-width': 'var(--dashboard-rail-visible-width)',
        '--dashboard-rail-panel-offset': 'var(--dashboard-rail-visible-width)',
        '--dashboard-content-inset': 'var(--dashboard-rail-visible-width)',
        '--dashboard-standard-panel-width': 'calc((100vw - 16px) * (9/12) - var(--dashboard-rail-visible-width))',
        '--dashboard-workflow-panel-width': 'calc((100vw - 16px) * (5/12))',
        paddingBottom: '8px',
        paddingRight: 'var(--dashboard-content-inset)',
        transition: 'padding-right 0.3s ease-in-out',
      }}
    >
      <div
        ref={dashboardCanvasRef}
        data-testid="dashboard-main-canvas"
        aria-hidden={isProcessOpen ? 'true' : undefined}
      >
        <Grid numItems={12} className="gap-1.5">
          <div
            className="col-span-12"
            style={{
              marginRight: '8px',
              minWidth: 0,
            }}
          >
            <USDMacroDashboard
              multiRegionMarketData={multiRegionMarketData}
              multiRegionLoading={multiRegionLoading}
              multiRegionError={multiRegionError}
              providerStatus={providerStatus}
              ibkrConnection={ibkrConnection}
              onDashboardStatusChange={handleDashboardStatusChange}
            />
          </div>

          {/* Right Sidebar - Portfolio Metrics (removed from grid, now in vertical bar) */}
        </Grid>
      </div>

      <div
        data-testid="dashboard-panel-backdrop"
        className="dashboard-panel-backdrop"
        aria-hidden={!isDashboardBackdropVisible}
        hidden={!isDashboardBackdropVisible}
      />

      <PersistentSurface
        as="section"
        active={showPortfolioBalance}
        className={[
          'dashboard-navigation-rail__balance-panel',
          isRightWorkspaceOpen && 'dashboard-navigation-rail__balance-panel--workspace-left',
          showPortfolioBreakdown && 'dashboard-navigation-rail__balance-panel--portfolio-left',
        ].filter(Boolean).join(' ')}
        style={{
          zIndex: SIDEBAR_PANEL_Z_INDEX_BASE + sidebarPanelStack.length + 1,
          '--dashboard-balance-panel-width': `${CONTRACT_PNL_PANEL_DEFAULT_WIDTH}px`,
          '--dashboard-contract-pnl-right-extension': '0px',
        }}
        data-testid="portfolio-balance-planner-slot"
        aria-label="Balance"
      >
        <header className="dashboard-navigation-rail__balance-header">
          <h2 className="dashboard-navigation-rail__panel-title">Balance</h2>
          <button
            type="button"
            className="dashboard-navigation-rail__balance-close"
            aria-label="Close Balance"
            title="Close Balance"
            onClick={() => setShowPortfolioBalance(false)}
          >
            <span aria-hidden="true">×</span>
          </button>
        </header>
        <div className="dashboard-navigation-rail__balance-body">
          <div className="dashboard-navigation-rail__balance-surface">
            <PortfolioBalanceScenarioPlanner accountId={selectedAccount} />
          </div>
        </div>
      </PersistentSurface>

      <PersistentSurface
        as="section"
        active={showContractPnl}
        ref={contractPnlPanelSurfaceRef}
        className={[
          'dashboard-navigation-rail__balance-panel',
          'dashboard-navigation-rail__balance-panel--contract-pnl',
          contractPnlPanelResizing
            && 'dashboard-navigation-rail__balance-panel--contract-pnl-resizing',
          isRightWorkspaceOpen && 'dashboard-navigation-rail__balance-panel--workspace-left',
          showPortfolioBreakdown && 'dashboard-navigation-rail__balance-panel--portfolio-left',
        ].filter(Boolean).join(' ')}
        style={{
          zIndex: SIDEBAR_PANEL_Z_INDEX_BASE + sidebarPanelStack.length + 1,
          '--dashboard-balance-panel-width': `${contractPnlPanelDisplayedWidth}px`,
          '--dashboard-contract-pnl-right-extension': `${contractPnlPanelRightExtension}px`,
        }}
        data-testid="contract-pnl-panel-slot"
        aria-label="Contract P&L"
      >
        <div
          className="dashboard-navigation-rail__contract-pnl-resize-handle dashboard-navigation-rail__contract-pnl-resize-handle--left"
          data-testid="contract-pnl-panel-resize-handle"
          role="separator"
          aria-label="Resize Contract P&L from the left edge"
          aria-orientation="vertical"
          aria-valuemin={CONTRACT_PNL_PANEL_MIN_WIDTH}
          aria-valuemax={CONTRACT_PNL_PANEL_MAX_WIDTH}
          aria-valuenow={contractPnlPanelDisplayedWidth}
          aria-valuetext={`${contractPnlPanelDisplayedWidth} pixels wide`}
          tabIndex={0}
          title="Drag the left edge to resize · double-click to reset"
          onPointerDown={(event) => beginContractPnlPanelResize(event, 'left')}
          onKeyDown={(event) => handleContractPnlPanelResizeKeyDown(event, 'left')}
          onDoubleClick={resetContractPnlPanelSize}
        />
        <div
          className="dashboard-navigation-rail__contract-pnl-resize-handle dashboard-navigation-rail__contract-pnl-resize-handle--right"
          data-testid="contract-pnl-panel-resize-handle-right"
          role="separator"
          aria-label="Resize Contract P&L from the right edge"
          aria-orientation="vertical"
          aria-valuemin={CONTRACT_PNL_PANEL_MIN_WIDTH}
          aria-valuemax={CONTRACT_PNL_PANEL_MAX_WIDTH}
          aria-valuenow={contractPnlPanelDisplayedWidth}
          aria-valuetext={`${contractPnlPanelDisplayedWidth} pixels wide`}
          tabIndex={0}
          title="Drag the right edge to resize · double-click to reset"
          onPointerDown={(event) => beginContractPnlPanelResize(event, 'right')}
          onKeyDown={(event) => handleContractPnlPanelResizeKeyDown(event, 'right')}
          onDoubleClick={resetContractPnlPanelSize}
        />
        <header className="dashboard-navigation-rail__balance-header">
          <h2 className="dashboard-navigation-rail__panel-title">Contract P&amp;L</h2>
          <button
            type="button"
            className="dashboard-navigation-rail__balance-close"
            aria-label="Close Contract P&L"
            title="Close Contract P&L"
            onClick={() => setShowContractPnl(false)}
          >
            <span aria-hidden="true">×</span>
          </button>
        </header>
        <div className="dashboard-navigation-rail__balance-body">
          <div
            className="dashboard-navigation-rail__balance-surface"
            data-testid="contract-pnl-surface"
          >
            <PredictionMarketPerformanceCard accountId={selectedAccount} />
          </div>
        </div>
      </PersistentSurface>

      {/* Compact navigation rail */}
      <div
        data-testid="dashboard-right-rail"
        onClickCapture={(event) => {
          if (!isProcessOpen) return;
          const button = event.target.closest?.('button');
          if (!button || button.dataset.processToggle === 'true') return;
          restoreProcessFocusRef.current = false;
          onCloseProcess?.({ replace: true });
        }}
        style={{
          position: 'fixed',
          top: '8px',
          right: '8px',
          bottom: '8px',
          width: 'var(--dashboard-rail-visible-width)',
          height: 'auto',
          zIndex: isProcessOpen || showAnalyst || showMorningTldr ? 1250 : 1000,
          backgroundColor: '#ffffff',
          color: '#12203a',
          border: '1px solid #d8e2ea',
          borderRadius: '8px',
          boxShadow: '0 1px 3px rgba(15, 23, 42, 0.055)',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          fontFamily: 'var(--font-ui)',
        }}
        className="dashboard-navigation-rail"
      >
        <DashboardNavigationRail
          items={navigationItems}
          activeItemId={activeNavigationItemId}
          activeItemIds={activeNavigationItemIds}
          systemReadinessStatus={systemReadinessStatus}
        />

        {showBookMenu && (
          <div
            ref={bookPopoverRef}
            style={{
              position: 'fixed',
              top: bookMenuPosition.top,
              right: bookMenuPosition.right,
              minWidth: '220px',
              backgroundColor: '#ffffff',
              border: '1px solid #dbe3ee',
              borderRadius: '12px',
              boxShadow: '0 14px 30px rgba(15, 23, 42, 0.14)',
              zIndex: 1400,
              padding: '5px 0',
              fontFamily: 'var(--font-ui)',
            }}
          >
            {bookFiles.map((file) => (
              <button
                key={file.path}
                type="button"
                onClick={() => openBookFile(file)}
                disabled={bookContentLoading}
                style={{
                  width: '100%',
                  textAlign: 'left',
                  padding: '10px 14px',
                  fontSize: '14px',
                  color: '#17233a',
                  backgroundColor: 'transparent',
                  border: 'none',
                  cursor: bookContentLoading ? 'wait' : 'pointer',
                  opacity: bookContentLoading ? 0.7 : 1,
                }}
                onMouseEnter={(event) => {
                  event.currentTarget.style.backgroundColor = '#f3f7fc';
                }}
                onMouseLeave={(event) => {
                  event.currentTarget.style.backgroundColor = 'transparent';
                }}
              >
                {bookContentLoading ? 'Loading...' : file.name}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Book/Notes Modal */}
      <PersistentSurface
          active={showBookModal && Boolean(selectedBookContent)}
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
      </PersistentSurface>

      {/* Securities A–Z list panel */}
      <PersistentSurface
        active={showPerformanceTracking}
        style={{
          position: 'fixed',
          top: 0,
          right: 'var(--dashboard-rail-panel-offset)',
          width: showPerformanceTracking ? 'var(--dashboard-standard-panel-width)' : '0px',
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
      </PersistentSurface>

      {/* Portfolio Breakdown Panel */}
      <PersistentSurface
        active={showPortfolioBreakdown}
        data-testid="portfolio-breakdown-panel"
        className="dashboard-side-panel dashboard-side-panel--portfolio-card dark:bg-gray-900 dark:border-gray-700"
        style={{
          position: 'fixed',
          top: 0,
          right: 'var(--dashboard-rail-panel-offset)',
          width: showPortfolioBreakdown ? 'var(--dashboard-standard-panel-width)' : '0px',
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
      >
            <div
              className="dashboard-portfolio-panel__content"
              style={{
                flex: 1,
                overflowY: 'auto',
                padding: '8px',
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
      </PersistentSurface>

      {/* Dense factor-risk and archive-universe workspace. */}
      <PersistentSurface
        active={showExposureLab}
        data-testid="exposure-lab-panel"
        data-layout="left-workspace-card"
        className="dashboard-side-panel dashboard-side-panel--exposure-card dark:bg-gray-900 dark:border-gray-700"
        style={{
          position: 'fixed',
          top: '8px',
          right: 'calc(var(--dashboard-rail-panel-offset) + 16px)',
          bottom: '8px',
          left: showExposureLab ? '8px' : 'auto',
          width: showExposureLab ? 'auto' : '0px',
          height: 'calc(100vh - 16px)',
          backgroundColor: '#ffffff',
          zIndex: getSidebarPanelZIndex('exposureLab', showExposureLab),
          border: showExposureLab ? '1px solid #d8e2ea' : 'none',
          borderRadius: showExposureLab ? '10px' : '0',
          boxShadow: showExposureLab ? '0 10px 26px rgba(15, 23, 42, 0.12)' : 'none',
          transition: 'width 0.2s ease-in-out, right 0.2s ease-in-out',
          display: showExposureLab ? 'flex' : 'none',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
          <Suspense fallback={<LazyPanelFallback label="Loading Exposure Lab..." />}>
            <ExposureLab
              portfolioData={portfolioData}
              isLoading={portfolioLoading}
              isRefreshing={portfolioRefreshing}
              connection={ibkrConnection}
              onRefresh={handlePortfolioRefresh}
              onClose={closeExposureLab}
            />
          </Suspense>
        </div>
      </PersistentSurface>

      {/* Each market owns a persistent instance so switching markets never
          mutates and clears a shared monitor component. */}
      <PersistentSurface
        active={showPredictionMonitor}
        preserveLayoutWhenInactive
        data-testid="prediction-market-resolver-test-panel"
        className="dashboard-side-panel dashboard-side-panel--resolver-test dark:bg-gray-900 dark:border-gray-700"
        style={{
          position: 'fixed',
          top: 0,
          right: 'var(--dashboard-rail-panel-offset)',
          width: undefined,
          height: '100vh',
          backgroundColor: '#ffffff',
          zIndex: getSidebarPanelZIndex('predictionMonitor', showPredictionMonitor),
          borderLeft: showPredictionMonitor ? '1px solid #e5e7eb' : 'none',
          borderRight: showPredictionMonitor ? '1px solid #e5e7eb' : 'none',
          borderRadius: '0',
          boxShadow: showPredictionMonitor
            ? '-2px 0 8px rgba(0, 0, 0, 0.08), 2px 0 8px rgba(0, 0, 0, 0.08)'
            : 'none',
          transition: 'width 0.3s ease-in-out, right 0.3s ease-in-out, border-radius 0.3s ease-in-out',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <div style={{ position: 'relative', flex: 1, overflow: 'hidden' }}>
          <Suspense fallback={<LazyPanelFallback label="Loading prediction monitor..." />}>
            {PREDICTION_MONITOR_NAV_ITEMS.map(({ marketId }) => (
              <PersistentSurface
                key={marketId}
                active={showPredictionMonitor && activePredictionMonitorMarket === marketId}
                preserveLayoutWhenInactive
                data-testid={`prediction-market-surface-${marketId}`}
                style={{
                  position: 'absolute',
                  inset: 0,
                  display: 'flex',
                  flexDirection: 'column',
                  minHeight: 0,
                  overflow: 'hidden',
                }}
              >
                <PredictionMarketResolverTestPanel
                  marketId={marketId}
                  onClose={closePredictionMonitor}
                  portfolioData={portfolioData}
                  selectedAccount={selectedAccount}
                />
              </PersistentSurface>
            ))}
          </Suspense>
        </div>
      </PersistentSurface>

      {/* Morning TL;DR - indexed dated research brief */}
      <PersistentSurface active={showMorningTldr}>
        <Suspense fallback={<LazyPanelFallback label="Loading morning TL;DR..." />}>
          <MorningTldrOverlay
            onClose={() => closeSidebarPanel('tldr', setShowMorningTldr)}
          />
        </Suspense>
      </PersistentSurface>

      {/* The Analyst remains mounted after its first open so chats and streams survive closing the panel. */}
      <PersistentSurface
        as="section"
        active={showAnalyst}
        ref={analystPanelSurfaceRef}
        data-testid="analyst-panel-surface"
        className={[
          'dashboard-navigation-rail__balance-panel',
          'dashboard-navigation-rail__analyst-panel',
          analystPanelResizing && 'dashboard-navigation-rail__analyst-panel--resizing',
          analystPanelPosition !== ANALYST_PANEL_DEFAULT_POSITION
            && `dashboard-navigation-rail__analyst-panel--${analystPanelPosition}`,
          analystPanelPosition === ANALYST_PANEL_DEFAULT_POSITION
            && isRightWorkspaceOpen
            && 'dashboard-navigation-rail__balance-panel--workspace-left',
          analystPanelPosition === ANALYST_PANEL_DEFAULT_POSITION
            && showPortfolioBreakdown
            && 'dashboard-navigation-rail__balance-panel--portfolio-left',
          'dark:bg-gray-900 dark:border-gray-700',
        ].filter(Boolean).join(' ')}
        style={{
          zIndex: getSidebarPanelZIndex('analyst', showAnalyst),
          '--analyst-panel-width': `${analystPanelWidth}px`,
        }}
        aria-label="The Analyst"
      >
        <div
          className="dashboard-navigation-rail__analyst-resize-handle"
          data-testid="analyst-panel-resize-handle"
          role="separator"
          aria-label={`Resize The Analyst from the ${analystPanelResizeEdge} edge`}
          aria-orientation="vertical"
          aria-valuemin={ANALYST_PANEL_MIN_WIDTH}
          aria-valuemax={ANALYST_PANEL_MAX_WIDTH}
          aria-valuenow={analystPanelWidth}
          aria-valuetext={`${analystPanelWidth} pixels wide`}
          tabIndex={0}
          title={`Drag the ${analystPanelResizeEdge} edge to resize · double-click to reset`}
          onPointerDown={beginAnalystPanelResize}
          onKeyDown={handleAnalystPanelResizeKeyDown}
          onDoubleClick={() => setAnalystPanelWidth(ANALYST_PANEL_DEFAULT_WIDTH)}
        />
        <div className="dashboard-navigation-rail__balance-body dashboard-navigation-rail__analyst-body">
          <AnalystSurfaceBoundary onClose={() => closeSidebarPanel('analyst', setShowAnalyst)}>
            <Suspense fallback={<LazyPanelFallback label="Loading The Analyst..." />}>
              <AnalystPanel onClose={() => closeSidebarPanel('analyst', setShowAnalyst)} />
            </Suspense>
          </AnalystSurfaceBoundary>
        </div>
      </PersistentSurface>

      {/* Signal Strength Reference Panel */}
      <PersistentSurface
        active={showSignalStrength}
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 'var(--dashboard-rail-panel-offset)',
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
          <Suspense fallback={<LazyPanelFallback label="Loading SS..." />}>
            <SignalStrengthPanel
              onClose={() => closeSidebarPanel('ss', setShowSignalStrength)}
              changelog={hedgeyeChangelog}
              changelogLoading={hedgeyeChangelogLoading}
              changelogError={hedgeyeChangelogError}
              onRefreshChangelog={fetchHedgeyeChangelog}
            />
          </Suspense>
      </PersistentSurface>

      {/* ETF Pro Reference Panel */}
      <PersistentSurface
        active={showEtfPro}
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 'var(--dashboard-rail-panel-offset)',
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
      </PersistentSurface>

      {/* Macro Show Reference Panel */}
      <PersistentSurface
        active={showMacroShow}
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 'var(--dashboard-rail-panel-offset)',
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
          <Suspense fallback={<LazyPanelFallback label="Loading Macro Show..." />}>
            <HedgeyeShowPanel
              snapshotType="the-macro-show"
              title="Macro Show"
              onClose={() => closeSidebarPanel('macroShow', setShowMacroShow)}
            />
          </Suspense>
      </PersistentSurface>

      {/* Call Reference Panel */}
      <PersistentSurface
        active={showCall}
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 'var(--dashboard-rail-panel-offset)',
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
          <Suspense fallback={<LazyPanelFallback label="Loading Call..." />}>
            <HedgeyeShowPanel
              snapshotType="the-call"
              title="Call"
              onClose={() => closeSidebarPanel('call', setShowCall)}
            />
          </Suspense>
      </PersistentSurface>

      {/* Lightweight Systems flyout */}
      <PersistentSurface
        active={showSystemReadiness}
        style={{
          position: 'fixed',
          top: '50%',
          left: '50%',
          right: 'auto',
          width: showSystemReadiness
            ? 'min(500px, calc(100vw - 20px))'
            : '0px',
          maxHeight: 'calc(100vh - 20px)',
          backgroundColor: theme === 'dark' ? '#182230' : '#ffffff',
          zIndex: getSidebarPanelZIndex('system', showSystemReadiness),
          border: showSystemReadiness
            ? `1px solid ${theme === 'dark' ? '#2d3a4b' : '#e5e7eb'}`
            : 'none',
          boxShadow: showSystemReadiness
            ? '0 18px 50px rgba(15, 23, 42, 0.24)'
            : 'none',
          display: showSystemReadiness ? 'block' : 'none',
          visibility: showSystemReadiness ? 'visible' : 'hidden',
          overflow: 'hidden',
          borderRadius: showSystemReadiness ? '0.75rem' : '0',
          transform: 'translate(-50%, -50%)',
        }}
        className="system-status-flyout"
        data-testid="system-readiness-sheet"
      >
          <Suspense fallback={<LazyPanelFallback label="Loading systems..." />}>
            <SystemReadinessPanel
              open={showSystemReadiness}
              onClose={() => closeSidebarPanel('system', setShowSystemReadiness)}
              onStatusChange={handleSystemReadinessStatus}
              dashboardCards={dashboardCardStatuses}
              resolverMarketId={showPredictionMonitor ? activePredictionMonitorMarket : null}
            />
          </Suspense>
      </PersistentSurface>

      {/* Workflow Status Panel */}
      <PersistentSurface
        active={showWorkflowStatus}
        style={{
          position: 'fixed',
          top: 0,
          right: 'var(--dashboard-rail-panel-offset)',
          width: showWorkflowStatus ? 'var(--dashboard-workflow-panel-width)' : '0px',
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
                <WorkflowStatus
                  portfolioData={portfolioData}
                  connection={ibkrConnection}
                  refreshToken={analyticsRefreshKey}
                />
              </Suspense>
            </div>
      </PersistentSurface>

      <PersistentSurface active={isProcessOpen}>
        <Suspense fallback={<LazyPanelFallback label="Loading Process..." />}>
          <ProcessOverlay
            documentId={processDocumentId || lastProcessDocumentIdRef.current}
            onClose={() => {
              restoreProcessFocusRef.current = true;
              onCloseProcess?.();
            }}
            onNavigate={onNavigateProcess}
          />
        </Suspense>
      </PersistentSurface>

    </div >
  );
};

export default PortfolioDashboard;
