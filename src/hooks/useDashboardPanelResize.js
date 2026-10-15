import { useCallback, useEffect, useRef, useState } from 'react';
import { CONTRACT_PNL_PANEL_MIN_WIDTH, CONTRACT_PNL_PANEL_MAX_WIDTH, CONTRACT_PNL_PANEL_EDGE_INSET, CONTRACT_PNL_PANEL_RESIZE_STEP, ANALYST_PANEL_MIN_WIDTH, ANALYST_PANEL_MAX_WIDTH, ANALYST_PANEL_EDGE_INSET, ANALYST_PANEL_RESIZE_STEP } from '../constants/dashboardWorkspace';
import { clampAnalystPanelWidth, clampContractPnlPanelWidth } from '../utils/dashboardWorkspaceState';

function getCenteredResizeLimits(surface, storedWidth, minimum, maximum, inset, extension = 0) {
  const bounds = surface?.getBoundingClientRect();
  const availableWidth = typeof window === 'undefined'
    ? maximum
    : Math.max(0, window.innerWidth - (2 * inset) - extension);
  const maxWidth = Math.min(maximum, availableWidth);
  return {
    currentWidth: Number.isFinite(bounds?.width) && bounds.width > 0
      ? Math.max(0, bounds.width - extension)
      : Math.min(storedWidth, maxWidth),
    minWidth: Math.min(minimum, maxWidth),
    maxWidth,
  };
}

export function useDashboardPanelResize({ analyst, contractPnl }) {
  const { analystPanelWidth, analystPanelResizeEdge, setAnalystPanelWidth } = analyst;
  const { contractPnlPanelDisplayedWidth, setContractPnlPanelWidth, setContractPnlPanelRightExtension, setContractPnlSizeCustomized, showContractPnl, contractPnlOverlay } = contractPnl;

  const [analystPanelResizing, setAnalystPanelResizing] = useState(false);

  const analystPanelSurfaceRef = useRef(null);

  const analystPanelResizeCleanupRef = useRef(null);

  const [contractPnlPanelResizing, setContractPnlPanelResizing] = useState(false);

  const contractPnlPanelSurfaceRef = useRef(null);

  const contractPnlPanelResizeCleanupRef = useRef(null);

  const getAnalystPanelResizeLimits = useCallback(() => {
    const surface = analystPanelSurfaceRef.current;
    // The Inbox expands the outer window; its width is not part of the saved chat width.
    const extension = surface?.querySelector?.('.analyst-inbox-drawer')
      ? Number.parseFloat(window.getComputedStyle(surface).getPropertyValue('--analyst-inbox-width')) || 0
      : 0;
    return getCenteredResizeLimits(
      surface,
      analystPanelWidth,
      ANALYST_PANEL_MIN_WIDTH,
      ANALYST_PANEL_MAX_WIDTH,
      ANALYST_PANEL_EDGE_INSET,
      Math.max(0, extension),
    );
  }, [analystPanelWidth]);

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
        currentWidth + (2 * widthDelta),
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
  }, [analystPanelResizeEdge, getAnalystPanelResizeLimits, setAnalystPanelWidth]);

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
  }, [analystPanelResizeEdge, getAnalystPanelResizeLimits, setAnalystPanelWidth]);

  const getContractPnlPanelResizeLimits = useCallback(() => getCenteredResizeLimits(
    contractPnlPanelSurfaceRef.current,
    contractPnlPanelDisplayedWidth,
    CONTRACT_PNL_PANEL_MIN_WIDTH,
    CONTRACT_PNL_PANEL_MAX_WIDTH,
    CONTRACT_PNL_PANEL_EDGE_INSET,
  ), [contractPnlPanelDisplayedWidth]);

  const beginContractPnlPanelResize = useCallback((event, resizeEdge = 'left') => {
    if (event.button != null && event.button !== 0) return;
    const startX = Number(event.clientX);
    if (!Number.isFinite(startX)) return;

    event.preventDefault();
    setContractPnlSizeCustomized(true);
    contractPnlPanelResizeCleanupRef.current?.();

    const resizeFromRightEdge = resizeEdge === 'right';
    const { currentWidth, minWidth, maxWidth } = getContractPnlPanelResizeLimits();
    setContractPnlPanelRightExtension(0);
    const move = (moveEvent) => {
      const clientX = Number(moveEvent.clientX);
      if (!Number.isFinite(clientX)) return;
      const requestedWidth = currentWidth + (2 * (resizeFromRightEdge
        ? clientX - startX
        : startX - clientX));
      const nextWidth = clampContractPnlPanelWidth(
        requestedWidth,
        minWidth,
        maxWidth,
      );
      setContractPnlPanelWidth(nextWidth);
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
  }, [getContractPnlPanelResizeLimits, setContractPnlPanelRightExtension, setContractPnlPanelWidth, setContractPnlSizeCustomized]);

  const handleContractPnlPanelResizeKeyDown = useCallback((event, resizeEdge = 'left') => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    setContractPnlSizeCustomized(true);
    const resizeFromRightEdge = resizeEdge === 'right';
    const { currentWidth, minWidth, maxWidth } = getContractPnlPanelResizeLimits();
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
    setContractPnlPanelRightExtension(0);
    setContractPnlPanelWidth(nextWidth);
  }, [getContractPnlPanelResizeLimits, setContractPnlPanelRightExtension, setContractPnlPanelWidth, setContractPnlSizeCustomized]);

  const resetContractPnlPanelSize = useCallback(() => {
    setContractPnlPanelWidth(contractPnlOverlay.defaultWidth);
    setContractPnlPanelRightExtension(0);
    setContractPnlSizeCustomized(false);
  }, [contractPnlOverlay.defaultWidth, setContractPnlPanelRightExtension, setContractPnlPanelWidth, setContractPnlSizeCustomized]);

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

  return { analystPanelResizing, analystPanelSurfaceRef, contractPnlPanelResizing, contractPnlPanelSurfaceRef, beginAnalystPanelResize, handleAnalystPanelResizeKeyDown, beginContractPnlPanelResize, handleContractPnlPanelResizeKeyDown, resetContractPnlPanelSize };
}

export default useDashboardPanelResize;
