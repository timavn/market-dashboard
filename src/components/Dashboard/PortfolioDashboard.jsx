import React, { Suspense, lazy, useState, useEffect, useRef, useMemo, useCallback } from 'react';
import {
  FileText,
  Monitor,
  MessageSquare,
  PieChart,
  Share2,
} from 'lucide-react';
import { MarketDataService } from '../../services/api/marketDataService';
import { useTheme } from '../../context/ThemeContext';
import USDMacroDashboard from './USDMacroDashboard';
import LoadingIndicator from '../common/LoadingIndicator';
import AnalystLoading from './AnalystLoading';
import PersistentSurface, { useSurfaceActivity } from '../common/PersistentSurface';
import { useDashboardWorkspaceState } from '../../hooks/useDashboardWorkspaceState';
import { useDashboardPanelResize } from '../../hooks/useDashboardPanelResize';
import useDashboardOverviewFit from '../../hooks/useDashboardOverviewFit';
import { ANALYST_PANEL_DEFAULT_POSITION, SIDEBAR_PANEL_Z_INDEX_BASE } from '../../constants/dashboardWorkspace';
import { normalizeAnalystPanelPosition } from '../../utils/dashboardWorkspaceState';
import { useDashboardPortfolio } from '../../hooks/useDashboardPortfolio';
import { useDashboardOverviewResources } from '../../hooks/useDashboardOverviewResources';
import { useDashboardEtfProResource } from '../../hooks/useDashboardEtfProResource';
import { useDashboardChangelog } from '../../hooks/useDashboardChangelog';
import DashboardTopNavigation from './DashboardTopNavigation';
import './DashboardNavigationRail.css';
import './ModernGridDashboard.css';
import './DashboardDialogs.css';
import { prepareReferenceComparisonSnapshot, markReferenceRefreshFailed } from '../../utils/dashboardReferenceProjection';
import { mergeMarketDataPreservingPeriods } from '../../utils/dashboardMarketPeriods';
import { markMarketPayloadRetained } from '../../utils/marketQuoteFreshness';
import {
  createUnknownDashboardCardStatuses,
  mergeDashboardCardStatuses,
} from './dashboardStatus';
import { getProcessDocument } from '../../constants/processDocuments';
import { isDashboardSessionRetentionEnabled } from '../../config/dashboardSessionRetention';
import { createDashboardWarmupQueue } from '../../utils/dashboardWarmupQueue';
import { warmDashboardResource } from '../../utils/dashboardResourceWarmup';
import DashboardBalancePanel from './workspace/DashboardBalancePanel';
import DashboardBookReader from './workspace/DashboardBookReader';
import DashboardPerformancePanel from './workspace/DashboardPerformancePanel';
import DashboardPortfolioPanel from './workspace/DashboardPortfolioPanel';
import DashboardExposurePanel from './workspace/DashboardExposurePanel';
import DashboardAnalystPanel from './workspace/DashboardAnalystPanel';
import DashboardSignalStrengthPanel from './workspace/DashboardSignalStrengthPanel';
import DashboardEtfProPanel from './workspace/DashboardEtfProPanel';
import DashboardMacroShowPanel from './workspace/DashboardMacroShowPanel';
import DashboardCallPanel from './workspace/DashboardCallPanel';
import DashboardSystemPanel from './workspace/DashboardSystemPanel';
import DashboardWorkflowPanel from './workspace/DashboardWorkflowPanel';

// Long and short position counts for the Analyst status line, by the sign of the quantity.
const holdingSides = holdings => (Array.isArray(holdings) && holdings.length ? {
  long: holdings.filter(holding => Number(holding?.quantity) > 0).length,
  short: holdings.filter(holding => Number(holding?.quantity) < 0).length,
} : null);

const loadReactMarkdownModule = () => import('react-markdown');
const loadSystemReadinessModule = () => import('./SystemReadinessPanel');
const loadWorkflowStatusModule = () => import('./WorkflowStatus');
const loadPerformanceTrackingModule = () => import('./PerformanceTracking');
const loadPortfolioBreakdownModule = () => import('./PortfolioBreakdown');
const loadExposureLabModule = () => import('./PcaRiskWorkspace');
const loadSignalStrengthModule = () => import('./SignalStrengthPanel');
const loadEtfProModule = () => import('./EtfProPanel');
const loadHedgeyeShowModule = () => import('./HedgeyeShowPanel');
const loadMorningTldrModule = () => import('./MorningTldrOverlay');
const loadAnalystModule = () => import('./AnalystPanel');
const loadProcessModule = () => import('../Process/ProcessOverlay');
const loadBalanceModule = () => import('./portfolio/PortfolioBalanceScenarioPlanner');

const ReactMarkdown = lazy(loadReactMarkdownModule);
const SystemReadinessPanel = lazy(loadSystemReadinessModule);
const WorkflowStatus = lazy(loadWorkflowStatusModule);
const PerformanceTracking = lazy(loadPerformanceTrackingModule);
const PortfolioBreakdown = lazy(loadPortfolioBreakdownModule);
const PcaRiskWorkspace = lazy(loadExposureLabModule);
const SignalStrengthPanel = lazy(loadSignalStrengthModule);
const EtfProPanel = lazy(loadEtfProModule);
const HedgeyeShowPanel = lazy(loadHedgeyeShowModule);
const MorningTldrOverlay = lazy(loadMorningTldrModule);
const AnalystPanel = lazy(loadAnalystModule);
const ProcessOverlay = lazy(loadProcessModule);
const PortfolioBalanceScenarioPlanner = lazy(loadBalanceModule);

const DASHBOARD_LAZY_WARMUPS = Object.freeze([
  Object.freeze({ key: 'chunk:system-readiness', run: loadSystemReadinessModule }),
  Object.freeze({ key: 'chunk:workflow', run: loadWorkflowStatusModule }),
  Object.freeze({ key: 'chunk:performance', run: loadPerformanceTrackingModule }),
  Object.freeze({ key: 'chunk:portfolio', run: loadPortfolioBreakdownModule }),
  Object.freeze({ key: 'chunk:exposure-lab', run: loadExposureLabModule }),
  Object.freeze({ key: 'chunk:signal-strength', run: loadSignalStrengthModule }),
  Object.freeze({ key: 'chunk:etf-pro', run: loadEtfProModule }),
  Object.freeze({ key: 'chunk:hedgeye-show', run: loadHedgeyeShowModule }),
  Object.freeze({ key: 'chunk:morning-tldr', run: loadMorningTldrModule }),
  Object.freeze({ key: 'chunk:analyst', run: loadAnalystModule }),
  Object.freeze({ key: 'chunk:process', run: loadProcessModule }),
  Object.freeze({ key: 'chunk:balance', run: loadBalanceModule }),
]);

const PANEL_WARMUP_TASK_KEYS = Object.freeze({
  balance: Object.freeze(['chunk:balance']),
  process: Object.freeze(['chunk:process']),
  dashboardGuide: Object.freeze(['chunk:process']),
  exposureGuide: Object.freeze(['chunk:process']),
  system: Object.freeze(['chunk:system-readiness']),
  analytics: Object.freeze(['chunk:workflow']),
  performance: Object.freeze(['chunk:performance']),
  portfolio: Object.freeze(['chunk:portfolio']),
  exposureLab: Object.freeze(['chunk:exposure-lab']),
  ss: Object.freeze(['chunk:signal-strength']),
  etfPro: Object.freeze(['chunk:etf-pro', 'resource:etf-pro']),
  macroShow: Object.freeze(['chunk:hedgeye-show']),
  call: Object.freeze(['chunk:hedgeye-show']),
  tldr: Object.freeze(['chunk:morning-tldr']),
  analyst: Object.freeze(['chunk:analyst']),
});

const ETF_PRO_STALE_WARNING = 'The API is serving a last-good cached ETF Pro response.';
const ANALYST_SHADOW_MODE = process.env.REACT_APP_ANALYST_SHADOW_MODE === 'true';
export function analystNavigationState(shadowMode = ANALYST_SHADOW_MODE) {
  return {
    systemsEntry: shadowMode ? 'tldr' : 'analyst',
    showLegacyTldr: shadowMode,
    showResearchAnalyst: shadowMode,
  };
}
const ANALYST_NAVIGATION = analystNavigationState();
const PROCESS_ROUTE = getProcessDocument('the-process').route;
const DASHBOARD_GUIDE_DOCUMENT_ID = 'dashboard-guide';
const DASHBOARD_GUIDE_ROUTE = getProcessDocument(DASHBOARD_GUIDE_DOCUMENT_ID).route;
const EXPOSURE_GUIDE_DOCUMENT_ID = 'exposure-lab-guide';
const EXPOSURE_GUIDE_ROUTE = getProcessDocument(EXPOSURE_GUIDE_DOCUMENT_ID).route;







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


export { mergeMarketDataPreservingPeriods };

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
  const dashboardWarmupTasksRef = useRef(new Map());
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
      const task = dashboardWarmupTasksRef.current.get(key);
      if (task) queue.enqueue(task).catch(() => {});
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
  const isDashboardGuideOpen = processDocumentId === DASHBOARD_GUIDE_DOCUMENT_ID;
  const isExposureGuideOpen = processDocumentId === EXPOSURE_GUIDE_DOCUMENT_ID;
  const { theme } = useTheme();
  const {
    selectedAccount, portfolioData, portfolioLoading, portfolioRefreshing,
    ibkrConnection, providerStatus, fetchPortfolio,
    refreshProviderStatus, resolvePortfolioAccount,
  } = useDashboardPortfolio({ surfaceActive });
  const {
    persistedPanelState,
    analystPanelWidth,
    setAnalystPanelWidth,
    analystPanelPosition,
    setAnalystPanelPosition,
    selectedAnalystPanelPosition,
    analystPanelResizeEdge,
    showPortfolioBalance,
    setShowPortfolioBalance,
    showMorningTldr,
    setShowMorningTldr,
    showAnalyst,
    setShowAnalyst,
    showWorkflowStatus,
    setShowWorkflowStatus,
    showSystemReadiness,
    setShowSystemReadiness,
    showPerformanceTracking,
    setShowPerformanceTracking,
    showSignalStrength,
    setShowSignalStrength,
    showEtfPro,
    setShowEtfPro,
    showMacroShow,
    setShowMacroShow,
    showCall,
    setShowCall,
    showPortfolioBreakdown,
    setShowPortfolioBreakdown,
    showExposureLab,
    setShowExposureLab,
    sidebarPanelStack,
    bringSidebarPanelToFront,
    removeSidebarPanelFromStack,
    getSidebarPanelZIndex
  } = useDashboardWorkspaceState({ isProcessOpen });
  const {
    analystPanelResizing,
    analystPanelSurfaceRef,
    beginAnalystPanelResize,
    handleAnalystPanelResizeKeyDown,
  } = useDashboardPanelResize({
    analyst: { analystPanelWidth, analystPanelPosition, analystPanelResizeEdge, setAnalystPanelWidth },
  });
  const [showBookMenu, setShowBookMenu] = useState(false);
  const [showBookModal, setShowBookModal] = useState(false);
  const [selectedBookContent, setSelectedBookContent] = useState(null);
  const [selectedBookTitle, setSelectedBookTitle] = useState('');
  const [bookMenuPosition, setBookMenuPosition] = useState({ top: 0, right: 0 });
  const bookMenuRef = useRef(null);
  const bookPopoverRef = useRef(null);
  const processButtonRef = useRef(null);
  const dashboardGuideButtonRef = useRef(null);
  const exposureGuideButtonRef = useRef(null);
  const processReturnFocusTargetRef = useRef(null);
  const lastProcessDocumentIdRef = useRef(processDocumentId);
  const dashboardCanvasRef = useRef(null);
  const dashboardOverviewRef = useRef(null);
  useDashboardOverviewFit(dashboardCanvasRef, dashboardOverviewRef);
  const restoreProcessFocusRef = useRef(true);
  const [systemReadinessStatus, setSystemReadinessStatus] = useState('unknown');
  const [dashboardCardStatuses, setDashboardCardStatuses] = useState(
    createUnknownDashboardCardStatuses,
  );
  const [analyticsRefreshKey, setAnalyticsRefreshKey] = useState(0);
  const etfProResource = useDashboardEtfProResource({ surfaceActive, showEtfPro });
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
  const { currentMarketResource, periodReturnsResource } = useDashboardOverviewResources({ surfaceActive });
  const multiRegionMarketData = useMemo(() => (
    currentMarketResource.data
      ? mergeMarketDataPreservingPeriods(
        periodReturnsResource.data || {},
        currentMarketResource.availability === 'live'
          ? currentMarketResource.data
          : markMarketPayloadRetained(currentMarketResource.data, currentMarketResource.availability),
        { preservePeriods: true },
      )
      : {}
  ), [currentMarketResource.data, currentMarketResource.availability, periodReturnsResource.data]);
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
    ];

    const tasks = [...DASHBOARD_LAZY_WARMUPS, ...resourceWarmups];
    dashboardWarmupTasksRef.current = new Map(tasks.map((task) => [task.key, task]));
    // Only restored surfaces are warmed automatically. Navigation intent can
    // enqueue any other surface without loading every monitor on each visit.
    const restoredKeys = [...(persistedPanelState.sidebarPanelStack || [])]
      .flatMap((panel) => PANEL_WARMUP_TASK_KEYS[panel] || []);
    tasks.filter((task) => restoredKeys.includes(task.key)).forEach((task) => {
      queue.enqueue(task).catch(() => {});
    });
  }, [dashboardInitialSettled, persistedPanelState, surfaceActive]);
  const warmNavigationItem = useCallback((id) => {
    promoteDashboardWarmups(PANEL_WARMUP_TASK_KEYS[id] || []);
  }, [promoteDashboardWarmups]);

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
    setShowBookMenu(false);

    return undefined;
  }, [isProcessOpen]);

  useEffect(() => {
    if (isProcessOpen || !restoreProcessFocusRef.current) return;

    const returnTarget = processReturnFocusTargetRef.current;
    (returnTarget?.isConnected ? returnTarget : processButtonRef.current)?.focus();
    processReturnFocusTargetRef.current = null;
    restoreProcessFocusRef.current = false;
  }, [isProcessOpen]);

  // Reading popups should never be hidden behind the compact utility panels.
  useEffect(() => {
    if (isProcessOpen || (!showAnalyst && !showMorningTldr)) return;
    setShowPortfolioBalance(false);
  }, [isProcessOpen, setShowPortfolioBalance, showAnalyst, showMorningTldr]);



  const toggleSidebarPanel = useCallback((panelKey, setPanelVisible) => {
    promoteDashboardWarmups(PANEL_WARMUP_TASK_KEYS[panelKey] || []);
    setPanelVisible((isVisible) => {
      const nextVisible = !isVisible;

      if (nextVisible) {
        setShowPortfolioBalance(false);
        bringSidebarPanelToFront(panelKey);
      } else {
        removeSidebarPanelFromStack(panelKey);
      }

      return nextVisible;
    });
  }, [bringSidebarPanelToFront, promoteDashboardWarmups, removeSidebarPanelFromStack, setShowPortfolioBalance]);

  const setAnalystPanelDock = useCallback((position) => {
    const nextPosition = normalizeAnalystPanelPosition(position);
    if (nextPosition === ANALYST_PANEL_DEFAULT_POSITION) return;
    setAnalystPanelPosition(nextPosition);
    if (showAnalyst) bringSidebarPanelToFront('analyst');
  }, [bringSidebarPanelToFront, setAnalystPanelPosition, showAnalyst]);

  const closeSidebarPanel = useCallback((panelKey, setPanelVisible) => {
    setPanelVisible(false);
    removeSidebarPanelFromStack(panelKey);
  }, [removeSidebarPanelFromStack]);

  const closeExposureLab = useCallback(() => {
    closeSidebarPanel('exposureLab', setShowExposureLab);
  }, [closeSidebarPanel, setShowExposureLab]);










  const activeNavigationItemIds = useMemo(() => {
    return [
      isProcessOpen && (isDashboardGuideOpen
        ? 'dashboardGuide'
        : isExposureGuideOpen ? 'exposureGuide' : 'process'),
      showSystemReadiness && 'system',
      showMorningTldr && 'tldr',
      showAnalyst && 'analyst',
      showPortfolioBreakdown && 'portfolio',
      showExposureLab && 'exposureLab',
      showPortfolioBalance && 'balance',
    ].filter(Boolean);
  }, [
    isProcessOpen,
    isDashboardGuideOpen,
    isExposureGuideOpen,
    showAnalyst,
    showMorningTldr,
    showPortfolioBalance,
    showPortfolioBreakdown,
    showExposureLab,
    showSystemReadiness,
  ]);

  const activeNavigationItemId = useMemo(() => {
    if (isProcessOpen) {
      if (isDashboardGuideOpen) return 'dashboardGuide';
      if (isExposureGuideOpen) return 'exposureGuide';
      return 'process';
    }
    if (showPortfolioBalance) return 'balance';

    return [...sidebarPanelStack]
      .reverse()
      .find((panelKey) => activeNavigationItemIds.includes(panelKey))
      || activeNavigationItemIds[activeNavigationItemIds.length - 1]
      || null;
  }, [
    activeNavigationItemIds,
    isProcessOpen,
    isDashboardGuideOpen,
    isExposureGuideOpen,
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
        setShowBookMenu(false);
        processReturnFocusTargetRef.current = processButtonRef.current;
        if (isDashboardGuideOpen || isExposureGuideOpen) {
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
      id: 'dashboardGuide',
      group: 'primary',
      icon: FileText,
      label: 'Dashboard',
      description: 'How to read every front-page card and calculation',
      title: 'Dashboard Guide',
      buttonRef: dashboardGuideButtonRef,
      isProcessToggle: true,
      onSelect: () => {
        setShowBookMenu(false);
        processReturnFocusTargetRef.current = dashboardGuideButtonRef.current;
        if (isDashboardGuideOpen) {
          restoreProcessFocusRef.current = true;
          onCloseProcess?.();
          return;
        }
        restoreProcessFocusRef.current = true;
        if (onNavigateProcess) onNavigateProcess(DASHBOARD_GUIDE_ROUTE);
        else window.location.hash = DASHBOARD_GUIDE_ROUTE.slice(1);
      },
    },
    {
      id: 'exposureGuide',
      group: 'primary',
      icon: FileText,
      label: 'PCA',
      description: 'How to read PCA concentration and compare candidate changes',
      title: 'PCA Guide',
      buttonRef: exposureGuideButtonRef,
      isProcessToggle: true,
      onSelect: () => {
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
  ].filter(Boolean), [selectedAnalystPanelPosition, setAnalystPanelDock, toggleSidebarPanel, setShowSystemReadiness, setShowMorningTldr, setShowAnalyst, isDashboardGuideOpen, isExposureGuideOpen, isProcessOpen, openProcess, onNavigateProcess, onCloseProcess, setShowPortfolioBreakdown]);


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


  const { hedgeyeChangelog, hedgeyeChangelogLoading, hedgeyeChangelogError, fetchHedgeyeChangelog } = useDashboardChangelog({ surfaceActive, showMorningTldr, showSignalStrength });









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

  const dashboardShellRef = useRef(null);
  const dashboardNavigationRef = useRef(null);
  useEffect(() => {
    const navigation = dashboardNavigationRef.current;
    const shell = dashboardShellRef.current;
    if (!navigation || !shell) return undefined;
    const measure = () => {
      const height = Math.ceil(navigation.getBoundingClientRect().height);
      if (height > 0) shell.style.setProperty('--dashboard-navigation-height', `${height}px`);
    };
    measure();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    observer?.observe(navigation);
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);

  // Match window render order so restored panels with equal z-indices dismiss
  // the same front window the browser paints above the shared backdrop.
  const workspaceLayers = [
    ['performance', showPerformanceTracking, setShowPerformanceTracking],
    ['portfolio', showPortfolioBreakdown, setShowPortfolioBreakdown],
    ['exposureLab', showExposureLab, setShowExposureLab],
    ['analyst', showAnalyst, setShowAnalyst],
    ['ss', showSignalStrength, setShowSignalStrength],
    ['etfPro', showEtfPro, setShowEtfPro],
    ['macroShow', showMacroShow, setShowMacroShow],
    ['call', showCall, setShowCall],
    ['system', showSystemReadiness, setShowSystemReadiness],
    ['analytics', showWorkflowStatus, setShowWorkflowStatus],
  ].filter(([, visible]) => visible).map(([key, visible, setVisible]) => ({
    zIndex: getSidebarPanelZIndex(key, visible),
    close: () => closeSidebarPanel(key, setVisible),
  }));
  if (showPortfolioBalance) workspaceLayers.push({
    zIndex: SIDEBAR_PANEL_Z_INDEX_BASE + sidebarPanelStack.length + 1,
    close: () => setShowPortfolioBalance(false),
  });
  const frontWorkspace = workspaceLayers.reduce((front, layer) => (
    !front || layer.zIndex >= front.zIndex ? layer : front
  ), null);
  const isDashboardBackdropVisible = Boolean(frontWorkspace || showMorningTldr || showBookModal);
  // Blur retained windows behind the front window as well as the overview.
  const dashboardBackdropZIndex = frontWorkspace?.zIndex ?? 990;

  return (
    <div
      ref={dashboardShellRef}
      data-testid="dashboard-shell"
      className="dashboard-shell dashboard-shell--modern-grid"
      style={{
        '--dashboard-rail-collapsed-width': '0px',
        '--dashboard-rail-visible-width': '0px',
        '--dashboard-active-rail-width': 'var(--dashboard-rail-visible-width)',
        '--dashboard-rail-panel-offset': 'var(--dashboard-rail-visible-width)',
        '--dashboard-content-inset': 'var(--dashboard-rail-visible-width)',
        '--dashboard-standard-panel-width': 'calc((100vw - 32px) * (9/12))',
        '--dashboard-workflow-panel-width': 'calc((100vw - 32px) * (5/12))',
      }}
    >
      <div
        ref={dashboardNavigationRef}
        data-testid="dashboard-topbar"
        className="dashboard-topbar"
        onClickCapture={(event) => {
          if (!isProcessOpen) return;
          const button = event.target.closest?.('button');
          if (!button?.dataset.navigationItemId || button.dataset.processToggle === 'true') return;
          restoreProcessFocusRef.current = false;
          onCloseProcess?.({ replace: true });
        }}
      >
        <DashboardTopNavigation
          onItemIntent={warmNavigationItem}
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
                {bookContentLoading ? <LoadingIndicator label="Loading..." size="sm" /> : file.name}
              </button>
            ))}
          </div>
        )}
      </div>

      <div
        ref={dashboardCanvasRef}
        className="dashboard-overview-viewport"
        data-testid="dashboard-main-canvas"
        aria-hidden={isProcessOpen ? 'true' : undefined}
      >
        <div ref={dashboardOverviewRef} className="dashboard-overview-content">
          <USDMacroDashboard
            multiRegionMarketData={multiRegionMarketData}
            multiRegionLoading={multiRegionLoading}
            multiRegionError={multiRegionError}
            providerStatus={providerStatus}
            ibkrConnection={ibkrConnection}
            onDashboardStatusChange={handleDashboardStatusChange}
          />
        </div>
      </div>

      <PersistentSurface active occluded={isProcessOpen} data-testid="dashboard-workspace-windows">
      <div
        data-testid="dashboard-panel-backdrop"
        className="dashboard-panel-backdrop"
        style={{ zIndex: dashboardBackdropZIndex }}
        aria-hidden={!isDashboardBackdropVisible}
        hidden={!isDashboardBackdropVisible}
        onClick={(event) => {
          if (event.target === event.currentTarget) frontWorkspace?.close();
        }}
      />

      <DashboardBalancePanel
        showPortfolioBalance={showPortfolioBalance}
        sidebarPanelStack={sidebarPanelStack}
        setShowPortfolioBalance={setShowPortfolioBalance}
      >
        <Suspense fallback={<LazyPanelFallback label="Loading balance..." />}><PortfolioBalanceScenarioPlanner accountId={selectedAccount} /></Suspense>
      </DashboardBalancePanel>

      {/* Book/Notes Modal */}
      <DashboardBookReader
        showBookModal={showBookModal}
        selectedBookContent={selectedBookContent}
        setShowBookModal={setShowBookModal}
        theme={theme}
        selectedTag={selectedTag}
        tagSectionsMap={tagSectionsMap}
        setSelectedTag={setSelectedTag}
        scrollToSection={scrollToSection}
        selectedBookTitle={selectedBookTitle}
        tags={tags}
        tagCounts={tagCounts}
        bookContentRef={bookContentRef}
        LazyPanelFallback={LazyPanelFallback}
        ReactMarkdown={ReactMarkdown}
        sections={sections}
      />

      {/* Securities A–Z list panel */}
      <DashboardPerformancePanel
        showPerformanceTracking={showPerformanceTracking}
        getSidebarPanelZIndex={getSidebarPanelZIndex}
        closeSidebarPanel={closeSidebarPanel}
        setShowPerformanceTracking={setShowPerformanceTracking}
      >
        <Suspense fallback={<LazyPanelFallback label="Loading performance..." />}>
                <PerformanceTracking />
              </Suspense>
      </DashboardPerformancePanel>

      {/* Portfolio Breakdown Panel */}
      <DashboardPortfolioPanel
        showPortfolioBreakdown={showPortfolioBreakdown}
        getSidebarPanelZIndex={getSidebarPanelZIndex}
      >
        <Suspense fallback={<LazyPanelFallback label="Loading portfolio breakdown..." />}>
                <PortfolioBreakdown
                  portfolioData={portfolioData}
                  isLoading={portfolioLoading}
                  isRefreshing={portfolioRefreshing}
                  onRefresh={handlePortfolioRefresh}
                />
              </Suspense>
      </DashboardPortfolioPanel>

      {/* Independent post-close portfolio risk, retaining the saved workspace identity. */}
      <DashboardExposurePanel
        showExposureLab={showExposureLab}
        getSidebarPanelZIndex={getSidebarPanelZIndex}
      >
        <Suspense fallback={<LazyPanelFallback label="Loading PCA..." />}>
            <PcaRiskWorkspace
              accountId={selectedAccount}
              active={showExposureLab}
              portfolioData={portfolioData}
              isLoading={portfolioLoading}
              isRefreshing={portfolioRefreshing}
              connection={ibkrConnection}
              onRefresh={handlePortfolioRefresh}
              onClose={closeExposureLab}
            />
          </Suspense>
      </DashboardExposurePanel>

      {/* Morning TL;DR - indexed dated research brief */}
      <PersistentSurface manageFocus active={showMorningTldr}>
        <Suspense fallback={<LazyPanelFallback label="Loading morning TL;DR..." />}>
          <MorningTldrOverlay
            onClose={() => closeSidebarPanel('tldr', setShowMorningTldr)}
          />
        </Suspense>
      </PersistentSurface>

      {/* The Analyst remains mounted after its first open so chats and streams survive closing the panel. */}
      <DashboardAnalystPanel
        showAnalyst={showAnalyst}
        analystPanelSurfaceRef={analystPanelSurfaceRef}
        analystPanelResizing={analystPanelResizing}
        getSidebarPanelZIndex={getSidebarPanelZIndex}
        analystPanelWidth={analystPanelWidth}
        analystPanelResizeEdge={analystPanelResizeEdge}
        beginAnalystPanelResize={beginAnalystPanelResize}
        handleAnalystPanelResizeKeyDown={handleAnalystPanelResizeKeyDown}
        setAnalystPanelWidth={setAnalystPanelWidth}
        closeSidebarPanel={closeSidebarPanel}
        setShowAnalyst={setShowAnalyst}
      >
        <Suspense fallback={<AnalystLoading />}>
              <AnalystPanel onClose={() => closeSidebarPanel('analyst', setShowAnalyst)} holdingsCount={portfolioData?.holdings?.length}
                holdingsSides={holdingSides(portfolioData?.holdings)} />
            </Suspense>
      </DashboardAnalystPanel>

      {/* Signal Strength Reference Panel */}
      <DashboardSignalStrengthPanel
        showSignalStrength={showSignalStrength}
        getSidebarPanelZIndex={getSidebarPanelZIndex}
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
      </DashboardSignalStrengthPanel>

      {/* ETF Pro Reference Panel */}
      <DashboardEtfProPanel
        showEtfPro={showEtfPro}
        getSidebarPanelZIndex={getSidebarPanelZIndex}
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
      </DashboardEtfProPanel>

      {/* Macro Show Reference Panel */}
      <DashboardMacroShowPanel
        showMacroShow={showMacroShow}
        getSidebarPanelZIndex={getSidebarPanelZIndex}
      >
        <Suspense fallback={<LazyPanelFallback label="Loading Macro Show..." />}>
            <HedgeyeShowPanel
              snapshotType="the-macro-show"
              title="Macro Show"
              onClose={() => closeSidebarPanel('macroShow', setShowMacroShow)}
            />
          </Suspense>
      </DashboardMacroShowPanel>

      {/* Call Reference Panel */}
      <DashboardCallPanel
        showCall={showCall}
        getSidebarPanelZIndex={getSidebarPanelZIndex}
      >
        <Suspense fallback={<LazyPanelFallback label="Loading Call..." />}>
            <HedgeyeShowPanel
              snapshotType="the-call"
              title="Call"
              onClose={() => closeSidebarPanel('call', setShowCall)}
            />
          </Suspense>
      </DashboardCallPanel>

      {/* Lightweight Systems flyout */}
      <DashboardSystemPanel
        showSystemReadiness={showSystemReadiness}
        theme={theme}
        getSidebarPanelZIndex={getSidebarPanelZIndex}
      >
        <Suspense fallback={<LazyPanelFallback label="Loading systems..." />}>
            <SystemReadinessPanel
              open={showSystemReadiness}
              onClose={() => closeSidebarPanel('system', setShowSystemReadiness)}
              onStatusChange={handleSystemReadinessStatus}
              dashboardCards={dashboardCardStatuses}
            />
          </Suspense>
      </DashboardSystemPanel>

      {/* Workflow Status Panel */}
      <DashboardWorkflowPanel
        showWorkflowStatus={showWorkflowStatus}
        getSidebarPanelZIndex={getSidebarPanelZIndex}
        closeSidebarPanel={closeSidebarPanel}
        setShowWorkflowStatus={setShowWorkflowStatus}
        setAnalyticsRefreshKey={setAnalyticsRefreshKey}
      >
        <Suspense fallback={<LazyPanelFallback label="Loading analytics..." />}>
                <WorkflowStatus
                  portfolioData={portfolioData}
                  connection={ibkrConnection}
                  refreshToken={analyticsRefreshKey}
                />
              </Suspense>
      </DashboardWorkflowPanel>
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
