import { act, renderHook } from '@testing-library/react';
import { useDashboardWorkspaceState } from './useDashboardWorkspaceState';
import { useDashboardPanelResize } from './useDashboardPanelResize';
import useContractPnlOverlay from './useContractPnlOverlay';
import { DASHBOARD_PANEL_STATE_KEY } from '../constants/dashboardWorkspace';

jest.mock('react-dom/test-utils', () => ({
  ...jest.requireActual('react-dom/test-utils'),
  act: jest.requireActual('react').act,
}));

const saved = () => JSON.parse(localStorage.getItem(DASHBOARD_PANEL_STATE_KEY) || '{}');
const useWorkspaceWithResize = ({ isProcessOpen = false } = {}) => {
  const workspace = useDashboardWorkspaceState({ isProcessOpen });
  const resize = useDashboardPanelResize({
    analyst: {
      analystPanelWidth: workspace.analystPanelWidth,
      analystPanelPosition: workspace.analystPanelPosition,
      analystPanelResizeEdge: workspace.analystPanelResizeEdge,
      setAnalystPanelWidth: workspace.setAnalystPanelWidth,
    },
    contractPnl: {
      contractPnlPanelWidth: workspace.contractPnlPanelWidth,
      contractPnlPanelRightExtension: workspace.contractPnlPanelRightExtension,
      contractPnlPanelDisplayedWidth: workspace.contractPnlPanelDisplayedWidth,
      setContractPnlPanelWidth: workspace.setContractPnlPanelWidth,
      setContractPnlPanelRightExtension: workspace.setContractPnlPanelRightExtension,
      setContractPnlSizeCustomized: workspace.setContractPnlSizeCustomized,
      showContractPnl: workspace.showContractPnl,
      contractPnlOverlay: { defaultWidth: 840 },
    },
  });
  return { workspace, resize };
};
const pointer = (clientX, button = 0) => ({ clientX, button, preventDefault: jest.fn() });
const key = (name, shiftKey = false) => ({ key: name, shiftKey, preventDefault: jest.fn() });
const analystSurfaceWithInbox = (readBaseWidth) => {
  const surface = document.createElement('section');
  const drawer = document.createElement('aside');
  drawer.className = 'analyst-inbox-drawer';
  surface.style.setProperty('--analyst-inbox-width', '380px');
  surface.append(drawer);
  const width = () => Math.min(readBaseWidth() + (drawer.parentElement ? 380 : 0), window.innerWidth - 32);
  surface.getBoundingClientRect = () => ({ width: width() });
  drawer.getBoundingClientRect = () => ({ width: Math.min(380, width() * 0.38) });
  return { surface, drawer };
};

const originalViewportWidth = window.innerWidth;
beforeEach(() => {
  localStorage.clear();
  window.innerWidth = 1280;
});
afterEach(() => {
  window.innerWidth = originalViewportWidth;
  document.body.classList.remove('dashboard-is-resizing-analyst', 'dashboard-is-resizing-contract-pnl');
});

describe('dashboard workspace state owner', () => {
  it.each(['bitcoin', 'ethereum'])('restores the %s perpetual card after reload', (marketId) => {
    localStorage.setItem(DASHBOARD_PANEL_STATE_KEY, JSON.stringify({
      showPredictionMonitor: true,
      activePredictionMonitorMarket: marketId,
      sidebarPanelStack: ['predictionMonitor'],
    }));
    const { result, unmount } = renderHook(() => useDashboardWorkspaceState({ isProcessOpen: false }));
    expect(result.current.showPredictionMonitor).toBe(true);
    expect(result.current.activePredictionMonitorMarket).toBe(marketId);
    expect(result.current.sidebarPanelStack).toEqual(['predictionMonitor']);
    expect(saved().activePredictionMonitorMarket).toBe(marketId);
    unmount();
  });

  it('migrates the legacy monitor, filters retired panels, and preserves the initial saved snapshot', () => {
    localStorage.setItem(DASHBOARD_PANEL_STATE_KEY, JSON.stringify({
      showResolverTest: true, showSystemReadiness: true,
      sidebarPanelStack: ['system', 'predictionMarkets', 'resolverTest', 'system'],
      analystPanelWidth: 520, activePredictionMonitorMarket: 'cpi',
    }));
    const { result, unmount } = renderHook(() => useDashboardWorkspaceState({ isProcessOpen: false }));
    const initial = result.current.persistedPanelState;
    expect(result.current.showPredictionMonitor).toBe(true);
    expect(result.current.activePredictionMonitorMarket).toBe('sp500');
    expect(result.current.sidebarPanelStack).toEqual(['system', 'predictionMonitor']);
    expect(result.current.analystPanelWidth).toBe(520);
    act(() => { result.current.setActivePredictionMonitorMarket('cpi'); });
    expect(result.current.persistedPanelState).toBe(initial);
    expect(saved().activePredictionMonitorMarket).toBe('cpi');
    expect(saved()).not.toHaveProperty('showResolverTest');
    unmount();
  });

  it('keeps unique front/back stack ordering and hidden-panel z-index behavior', () => {
    const { result, unmount } = renderHook(() => useDashboardWorkspaceState({ isProcessOpen: false }));
    act(() => {
      result.current.bringSidebarPanelToFront('portfolio');
      result.current.bringSidebarPanelToFront('analyst');
      result.current.bringSidebarPanelToFront('portfolio');
    });
    expect(result.current.sidebarPanelStack).toEqual(['analyst', 'portfolio']);
    expect(result.current.getSidebarPanelZIndex('portfolio', true)).toBe(1301);
    expect(result.current.getSidebarPanelZIndex('portfolio', false)).toBe(-1);
    act(() => { result.current.removeSidebarPanelFromStack('analyst'); });
    expect(saved().sidebarPanelStack).toEqual(['portfolio']);
    unmount();
  });

  it('centers legacy Analyst positions and persists the current width geometry', () => {
    localStorage.setItem(DASHBOARD_PANEL_STATE_KEY, JSON.stringify({ contractPnlPanelWidth: 295 }));
    const { result, unmount } = renderHook(() => useDashboardWorkspaceState({ isProcessOpen: false }));
    expect(result.current.contractPnlPanelWidth).toBe(720);
    expect(result.current.analystPanelPosition).toBe('center');
    expect(saved()).not.toHaveProperty('analystPanelPosition');
    act(() => {
      result.current.setAnalystPanelPosition('left');
      result.current.setContractPnlPanelWidth(810);
      result.current.setContractPnlSizeCustomized(true);
      result.current.setShowContractPnl(true);
    });
    expect(result.current.analystPanelPosition).toBe('center');
    expect(saved()).not.toHaveProperty('analystPanelPosition');
    expect(saved()).toMatchObject({ contractPnlPanelWidth: 810, contractPnlPanelRightExtension: 0, contractPnlSizeCustomized: true, contractPnlGeometryVersion: 3 });
    expect(saved()).not.toHaveProperty('showContractPnl');
    unmount();
  });

  it.each(['left', 'right', 'auto', 'center'])('migrates the saved %s Analyst position without losing its session', (position) => {
    localStorage.setItem(DASHBOARD_PANEL_STATE_KEY, JSON.stringify({
      showAnalyst: true, analystPanelWidth: 620, analystPanelPosition: position,
      sidebarPanelStack: ['portfolio', 'analyst'],
    }));
    const { result } = renderHook(() => useDashboardWorkspaceState({ isProcessOpen: false }));
    expect(result.current.analystPanelPosition).toBe('center');
    expect(result.current.analystPanelResizeEdge).toBe('right');
    expect(result.current.analystPanelWidth).toBe(620);
    expect(result.current.showAnalyst).toBe(true);
    expect(result.current.sidebarPanelStack).toEqual(['portfolio', 'analyst']);
  });

  it('migrates a customized P&L extension into total width and preserves it on another reload', () => {
    localStorage.setItem(DASHBOARD_PANEL_STATE_KEY, JSON.stringify({
      contractPnlGeometryVersion: 2, contractPnlPanelWidth: 810,
      contractPnlPanelRightExtension: 40, contractPnlSizeCustomized: true,
    }));
    const { result, unmount } = renderHook(() => useDashboardWorkspaceState({ isProcessOpen: false }));
    expect(result.current.contractPnlPanelDisplayedWidth).toBe(850);
    expect(saved()).toMatchObject({
      contractPnlGeometryVersion: 3, contractPnlPanelWidth: 850,
      contractPnlPanelRightExtension: 0, contractPnlSizeCustomized: true,
    });
    unmount();
    const { result: restored } = renderHook(() => useDashboardWorkspaceState({ isProcessOpen: false }));
    expect(restored.current.contractPnlPanelDisplayedWidth).toBe(850);
    expect(restored.current.contractPnlSizeCustomized).toBe(true);
  });

  it('keeps setters and resize callbacks stable across unrelated workspace changes', () => {
    const { result, rerender, unmount } = renderHook(useWorkspaceWithResize, { initialProps: { isProcessOpen: false } });
    const setWidth = result.current.workspace.setAnalystPanelWidth;
    const resize = result.current.resize.beginAnalystPanelResize;
    const closeResize = result.current.resize.resetContractPnlPanelSize;
    act(() => { result.current.workspace.setShowSystemReadiness(true); });
    rerender({ isProcessOpen: true });
    expect(result.current.workspace.setAnalystPanelWidth).toBe(setWidth);
    expect(result.current.resize.beginAnalystPanelResize).toBe(resize);
    expect(result.current.resize.resetContractPnlPanelSize).toBe(closeResize);
    expect(result.current.workspace.showSystemReadiness).toBe(true);
    unmount();
  });
});

describe('dashboard resize owner', () => {
  it('resizes Analyst symmetrically from its centered position and preserves keyboard steps', () => {
    const { result, unmount } = renderHook(useWorkspaceWithResize);
    result.current.resize.analystPanelSurfaceRef.current = {
      getBoundingClientRect: () => ({
        width: result.current.workspace.analystPanelWidth,
        left: (window.innerWidth - result.current.workspace.analystPanelWidth) / 2,
        right: (window.innerWidth + result.current.workspace.analystPanelWidth) / 2,
      }),
    };
    act(() => { result.current.resize.beginAnalystPanelResize(pointer(448)); });
    expect(document.body.classList.contains('dashboard-is-resizing-analyst')).toBe(true);
    act(() => { window.dispatchEvent(new MouseEvent('pointermove', { clientX: 548 })); });
    expect(result.current.workspace.analystPanelWidth).toBe(640);
    act(() => { window.dispatchEvent(new MouseEvent('pointerup')); });
    expect(document.body.classList.contains('dashboard-is-resizing-analyst')).toBe(false);
    act(() => { result.current.resize.handleAnalystPanelResizeKeyDown(key('ArrowLeft', true)); });
    expect(result.current.workspace.analystPanelWidth).toBe(544);
    expect(saved().analystPanelWidth).toBe(544);
    act(() => { result.current.resize.handleAnalystPanelResizeKeyDown(key('Home')); });
    expect(result.current.workspace.analystPanelWidth).toBe(280);
    unmount();
  });

  it('resizes the Analyst chat width without saving its open Inbox extension', () => {
    const { result } = renderHook(useWorkspaceWithResize);
    const { surface, drawer } = analystSurfaceWithInbox(() => result.current.workspace.analystPanelWidth);
    result.current.resize.analystPanelSurfaceRef.current = surface;

    act(() => { result.current.resize.beginAnalystPanelResize(pointer(1050)); });
    act(() => { window.dispatchEvent(new MouseEvent('pointermove', { clientX: 1100 })); });
    expect(result.current.workspace.analystPanelWidth).toBe(540);
    expect(surface.getBoundingClientRect().width).toBe(920);
    act(() => { window.dispatchEvent(new MouseEvent('pointerup')); });
    act(() => { result.current.resize.handleAnalystPanelResizeKeyDown(key('ArrowRight')); });
    expect(result.current.workspace.analystPanelWidth).toBe(564);
    expect(saved().analystPanelWidth).toBe(564);

    drawer.remove();
    expect(surface.getBoundingClientRect().width).toBe(564);
    act(() => { result.current.resize.handleAnalystPanelResizeKeyDown(key('ArrowLeft')); });
    expect(result.current.workspace.analystPanelWidth).toBe(540);
  });

  it('keeps pointer and keyboard resizing within the viewport while Inbox is open', () => {
    window.innerWidth = 980;
    const { result } = renderHook(useWorkspaceWithResize);
    act(() => { result.current.workspace.setAnalystPanelWidth(900); });
    const { surface } = analystSurfaceWithInbox(() => result.current.workspace.analystPanelWidth);
    result.current.resize.analystPanelSurfaceRef.current = surface;
    expect(surface.getBoundingClientRect().width).toBe(948);

    act(() => { result.current.resize.beginAnalystPanelResize(pointer(940)); });
    act(() => { window.dispatchEvent(new MouseEvent('pointermove', { clientX: 920 })); });
    expect(result.current.workspace.analystPanelWidth).toBe(528);
    expect(surface.getBoundingClientRect().width).toBe(908);
    act(() => { window.dispatchEvent(new MouseEvent('pointerup')); });
    act(() => { result.current.resize.handleAnalystPanelResizeKeyDown(key('End')); });
    expect(result.current.workspace.analystPanelWidth).toBe(568);
    expect(surface.getBoundingClientRect().width).toBe(948);
    act(() => { result.current.resize.handleAnalystPanelResizeKeyDown(key('ArrowLeft', true)); });
    expect(result.current.workspace.analystPanelWidth).toBe(472);
    act(() => { result.current.resize.handleAnalystPanelResizeKeyDown(key('Home')); });
    expect(result.current.workspace.analystPanelWidth).toBe(280);
    expect(saved().analystPanelWidth).toBe(280);
  });

  it('resizes centered Contract P&L from either edge and cleans an active drag on close', () => {
    const { result, unmount } = renderHook(useWorkspaceWithResize);
    act(() => { result.current.workspace.setShowContractPnl(true); });
    act(() => { result.current.resize.beginContractPnlPanelResize(pointer(600), 'left'); });
    act(() => { window.dispatchEvent(new MouseEvent('pointermove', { clientX: 500 })); });
    expect(result.current.workspace.contractPnlPanelWidth).toBe(920);
    act(() => { window.dispatchEvent(new MouseEvent('pointerup')); });
    act(() => { result.current.resize.beginContractPnlPanelResize(pointer(900), 'right'); });
    act(() => { window.dispatchEvent(new MouseEvent('pointermove', { clientX: 950 })); });
    expect(result.current.workspace.contractPnlPanelWidth).toBe(1020);
    expect(result.current.workspace.contractPnlPanelRightExtension).toBe(0);
    expect(result.current.workspace.contractPnlPanelDisplayedWidth).toBe(1020);
    expect(saved().contractPnlPanelWidth).toBe(1020);
    act(() => { result.current.workspace.setShowContractPnl(false); });
    expect(result.current.resize.contractPnlPanelResizing).toBe(false);
    expect(document.body.classList.contains('dashboard-is-resizing-contract-pnl')).toBe(false);
    act(() => { window.dispatchEvent(new MouseEvent('pointermove', { clientX: 1000 })); });
    expect(result.current.workspace.contractPnlPanelDisplayedWidth).toBe(1020);
    act(() => { result.current.resize.resetContractPnlPanelSize(); });
    expect(result.current.workspace.contractPnlPanelDisplayedWidth).toBe(840);
    expect(result.current.workspace.contractPnlSizeCustomized).toBe(false);
    unmount();
  });

  it.each([1280, 250])('keeps both resize controls inside a %spx viewport', (viewportWidth) => {
    window.innerWidth = viewportWidth;
    const { result } = renderHook(useWorkspaceWithResize);
    act(() => { result.current.resize.handleAnalystPanelResizeKeyDown(key('End')); });
    act(() => { result.current.resize.handleContractPnlPanelResizeKeyDown(key('End'), 'right'); });
    expect(result.current.workspace.analystPanelWidth).toBe(viewportWidth - 32);
    expect(result.current.workspace.contractPnlPanelDisplayedWidth).toBe(viewportWidth - 32);
    act(() => { result.current.resize.handleContractPnlPanelResizeKeyDown(key('Home'), 'left'); });
    expect(result.current.workspace.contractPnlPanelDisplayedWidth).toBe(Math.min(295, viewportWidth - 32));
  });

  it('rejects non-primary drags and releases active Analyst listeners on unmount', () => {
    const removeListener = jest.spyOn(window, 'removeEventListener');
    const { result, unmount } = renderHook(useWorkspaceWithResize);
    const ignored = pointer(400, 1);
    act(() => { result.current.resize.beginAnalystPanelResize(ignored); });
    expect(ignored.preventDefault).not.toHaveBeenCalled();
    act(() => { result.current.resize.beginAnalystPanelResize(pointer(400)); });
    expect(result.current.resize.analystPanelResizing).toBe(true);
    unmount();
    expect(document.body.classList.contains('dashboard-is-resizing-analyst')).toBe(false);
    expect(removeListener).toHaveBeenCalledWith('pointermove', expect.any(Function));
    expect(removeListener).toHaveBeenCalledWith('pointerup', expect.any(Function));
    expect(removeListener).toHaveBeenCalledWith('pointercancel', expect.any(Function));
  });
});

it('opens Contract P&L without inheriting a covered window or legacy rail geometry', () => {
  const query = jest.spyOn(document, 'querySelectorAll');
  const { result, rerender } = renderHook(({ active }) => useContractPnlOverlay(active), {
    initialProps: { active: false },
  });
  const overlay = result.current;
  expect(overlay.prepare()).toBe(720);
  rerender({ active: true });
  expect(result.current).toBe(overlay);
  expect(result.current.style).toEqual({});
  expect(query).not.toHaveBeenCalled();
  query.mockRestore();
});
