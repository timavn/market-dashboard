import { useCallback, useEffect, useMemo, useState } from 'react';
import { SIDEBAR_PANEL_Z_INDEX_BASE, ANALYST_PANEL_POSITIONS, ANALYST_PANEL_DEFAULT_POSITION } from '../constants/dashboardWorkspace';
import { readDashboardPanelState, writeDashboardPanelState, readPersistedBoolean, clampAnalystPanelWidth, normalizeAnalystPanelPosition, migrateLegacyPanelState, readPersistedSidebarStack } from '../utils/dashboardWorkspaceState';

export function useDashboardWorkspaceState({ isProcessOpen }) {
  const persistedPanelState = useMemo(
    () => migrateLegacyPanelState(readDashboardPanelState()),
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

  const [showPortfolioBalance, setShowPortfolioBalance] = useState(false);

  const [showMorningTldr, setShowMorningTldr] = useState(() => readPersistedBoolean(persistedPanelState, 'showMorningTldr'));

  const [showAnalyst, setShowAnalyst] = useState(() => readPersistedBoolean(persistedPanelState, 'showAnalyst'));

  const [showWorkflowStatus, setShowWorkflowStatus] = useState(() => readPersistedBoolean(persistedPanelState, 'showWorkflowStatus'));

  const [showSystemReadiness, setShowSystemReadiness] = useState(() => readPersistedBoolean(persistedPanelState, 'showSystemReadiness'));

  const [showPerformanceTracking, setShowPerformanceTracking] = useState(() => readPersistedBoolean(persistedPanelState, 'showPerformanceTracking'));

  const [showSignalStrength, setShowSignalStrength] = useState(() => readPersistedBoolean(persistedPanelState, 'showSignalStrength'));

  const [showEtfPro, setShowEtfPro] = useState(() => readPersistedBoolean(persistedPanelState, 'showEtfPro'));

  const [showMacroShow, setShowMacroShow] = useState(() => readPersistedBoolean(persistedPanelState, 'showMacroShow'));

  const [showCall, setShowCall] = useState(() => readPersistedBoolean(persistedPanelState, 'showCall'));

  const [showPortfolioBreakdown, setShowPortfolioBreakdown] = useState(() => readPersistedBoolean(persistedPanelState, 'showPortfolioBreakdown'));

  // PCA has no navigation entry, so a window saved open would have no way back.
  const [showExposureLab, setShowExposureLab] = useState(false);

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
      showSystemReadiness,
      showWorkflowStatus,
      showPerformanceTracking,
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
    showMorningTldr,
    showSystemReadiness,
    showWorkflowStatus,
    showPerformanceTracking,
    showSignalStrength,
    showEtfPro,
    showMacroShow,
    showCall,
    showPortfolioBreakdown,
    showExposureLab,
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
    setSidebarPanelStack,
    bringSidebarPanelToFront,
    removeSidebarPanelFromStack,
    getSidebarPanelZIndex
  };
}

export default useDashboardWorkspaceState;
