import { useCallback, useEffect, useMemo, useState } from 'react';
import { SIDEBAR_PANEL_Z_INDEX_BASE, CONTRACT_PNL_PANEL_MAX_WIDTH, ANALYST_PANEL_POSITIONS, ANALYST_PANEL_DEFAULT_POSITION, PREDICTION_MONITOR_MARKETS } from '../constants/dashboardWorkspace';
import { readDashboardPanelState, writeDashboardPanelState, readPersistedBoolean, clampAnalystPanelWidth, clampContractPnlPanelWidth, normalizeAnalystPanelPosition, migratePredictionMarketsPanelState, readPersistedSidebarStack } from '../utils/dashboardWorkspaceState';

export function useDashboardWorkspaceState({ isProcessOpen }) {
  const persistedPanelState = useMemo(
    () => migratePredictionMarketsPanelState(readDashboardPanelState()),
    [],
  );

  const [analystPanelWidth, setAnalystPanelWidth] = useState(() => (
    clampAnalystPanelWidth(persistedPanelState.analystPanelWidth)
  ));

  const [analystPanelPosition, updateAnalystPanelPosition] = useState(() => (
    normalizeAnalystPanelPosition(persistedPanelState.analystPanelPosition)
  ));
  const setAnalystPanelPosition = useCallback((position) => {
    updateAnalystPanelPosition((current) => normalizeAnalystPanelPosition(
      typeof position === 'function' ? position(current) : position,
    ));
  }, []);

  const selectedAnalystPanelPosition = ANALYST_PANEL_POSITIONS.has(analystPanelPosition)
    ? analystPanelPosition
    : null;

  const analystPanelResizeEdge = 'right';

  const [contractPnlPanelWidth, setContractPnlPanelWidth] = useState(() => {
    const savedWidth = clampContractPnlPanelWidth(persistedPanelState.contractPnlPanelWidth);
    if (persistedPanelState.contractPnlGeometryVersion === 2) {
      // Keep the user's total width while discarding the old one-sided offset.
      const extension = Math.max(0, Number(persistedPanelState.contractPnlPanelRightExtension) || 0);
      return clampContractPnlPanelWidth(savedWidth + extension);
    }
    return persistedPanelState.contractPnlGeometryVersion === 3
      ? savedWidth
      : Math.max(720, savedWidth);
  });

  const [contractPnlPanelRightExtension, setContractPnlPanelRightExtension] = useState(0);

  const [contractPnlSizeCustomized, setContractPnlSizeCustomized] = useState(
    [2, 3].includes(persistedPanelState.contractPnlGeometryVersion) && persistedPanelState.contractPnlSizeCustomized === true,
  );

  const contractPnlPanelDisplayedWidth = Math.min(
    CONTRACT_PNL_PANEL_MAX_WIDTH,
    contractPnlPanelWidth,
  );

  const [showPortfolioBalance, setShowPortfolioBalance] = useState(false);

  const [showContractPnl, setShowContractPnl] = useState(false);

  const [showMorningTldr, setShowMorningTldr] = useState(() => readPersistedBoolean(persistedPanelState, 'showMorningTldr'));

  const [showAnalyst, setShowAnalyst] = useState(() => readPersistedBoolean(persistedPanelState, 'showAnalyst'));

  const [showWorkflowStatus, setShowWorkflowStatus] = useState(() => readPersistedBoolean(persistedPanelState, 'showWorkflowStatus'));

  const [showSystemReadiness, setShowSystemReadiness] = useState(() => readPersistedBoolean(persistedPanelState, 'showSystemReadiness'));

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

  const [showBitcoinResearch, setShowBitcoinResearch] = useState(() => readPersistedBoolean(persistedPanelState, 'showBitcoinResearch'));

  const [sidebarPanelStack, setSidebarPanelStack] = useState(() => readPersistedSidebarStack(persistedPanelState));

  const bringSidebarPanelToFront = useCallback((panelKey) => {
    setSidebarPanelStack((current) => [
      ...current.filter((key) => key !== panelKey),
      panelKey,
    ]);
  }, []);

  const removeSidebarPanelFromStack = useCallback((panelKey) => {
    setSidebarPanelStack((current) => current.filter((key) => key !== panelKey));
  }, []);

  const getSidebarPanelZIndex = useCallback((panelKey, isVisible) => {
    if (!isVisible) return -1;

    const stackIndex = sidebarPanelStack.indexOf(panelKey);
    return SIDEBAR_PANEL_Z_INDEX_BASE + Math.max(stackIndex, 0);
  }, [sidebarPanelStack]);

  useEffect(() => {
    const nextPanelState = {
      showMorningTldr,
      showAnalyst,
      analystPanelWidth,
      contractPnlPanelWidth,
      contractPnlPanelRightExtension,
      contractPnlSizeCustomized,
      contractPnlGeometryVersion: 3,
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
      showBitcoinResearch,
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
    contractPnlPanelRightExtension,
    contractPnlSizeCustomized,
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
    showBitcoinResearch,
    sidebarPanelStack,
  ]);

  return {
    persistedPanelState,
    analystPanelWidth,
    setAnalystPanelWidth,
    analystPanelPosition,
    setAnalystPanelPosition,
    selectedAnalystPanelPosition,
    analystPanelResizeEdge,
    contractPnlPanelWidth,
    setContractPnlPanelWidth,
    contractPnlPanelRightExtension,
    setContractPnlPanelRightExtension,
    contractPnlSizeCustomized,
    setContractPnlSizeCustomized,
    contractPnlPanelDisplayedWidth,
    showPortfolioBalance,
    setShowPortfolioBalance,
    showContractPnl,
    setShowContractPnl,
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
    showPredictionMonitor,
    setShowPredictionMonitor,
    activePredictionMonitorMarket,
    setActivePredictionMonitorMarket,
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
    showBitcoinResearch,
    setShowBitcoinResearch,
    sidebarPanelStack,
    setSidebarPanelStack,
    bringSidebarPanelToFront,
    removeSidebarPanelFromStack,
    getSidebarPanelZIndex
  };
}

export default useDashboardWorkspaceState;
