import { useCallback, useEffect, useRef, useState } from 'react';
import { ANALYST_PANEL_MIN_WIDTH, ANALYST_PANEL_MAX_WIDTH, ANALYST_PANEL_EDGE_INSET, ANALYST_PANEL_RESIZE_STEP } from '../constants/dashboardWorkspace';
import { clampAnalystPanelWidth } from '../utils/dashboardWorkspaceState';

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

export function useDashboardPanelResize({ analyst }) {
  const { analystPanelWidth, analystPanelResizeEdge, setAnalystPanelWidth } = analyst;

  const [analystPanelResizing, setAnalystPanelResizing] = useState(false);

  const analystPanelSurfaceRef = useRef(null);

  const analystPanelResizeCleanupRef = useRef(null);

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

  useEffect(() => () => {
    analystPanelResizeCleanupRef.current?.();
    document.body.classList.remove('dashboard-is-resizing-analyst');
  }, []);

  return { analystPanelResizing, analystPanelSurfaceRef, beginAnalystPanelResize, handleAnalystPanelResizeKeyDown };
}

export default useDashboardPanelResize;
