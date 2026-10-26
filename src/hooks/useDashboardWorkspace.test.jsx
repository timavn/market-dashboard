import { act, renderHook } from '@testing-library/react';
import { useDashboardWorkspaceState } from './useDashboardWorkspaceState';
import { useDashboardPanelResize } from './useDashboardPanelResize';
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
  document.body.classList.remove('dashboard-is-resizing-analyst');
});

describe('dashboard workspace state owner', () => {
  it('drops retired prediction-monitor and Contract P&L panel state while keeping live panels', () => {
    localStorage.setItem(DASHBOARD_PANEL_STATE_KEY, JSON.stringify({
      showResolverTest: true, showPredictionMonitor: true, showSystemReadiness: true,
      activePredictionMonitorMarket: 'cpi',
      sidebarPanelStack: ['system', 'predictionMarkets', 'resolverTest', 'predictionMonitor', 'cpi', 'system'],
      analystPanelWidth: 520,
      contractPnlPanelWidth: 810, contractPnlPanelRightExtension: 40,
      contractPnlSizeCustomized: true, contractPnlGeometryVersion: 3,
    }));
    const { result, unmount } = renderHook(() => useDashboardWorkspaceState({ isProcessOpen: false }));
    const initial = result.current.persistedPanelState;
    expect(result.current).not.toHaveProperty('showPredictionMonitor');
    expect(result.current).not.toHaveProperty('showContractPnl');
    expect(result.current.showSystemReadiness).toBe(true);
    expect(result.current.sidebarPanelStack).toEqual(['system']);
    expect(result.current.analystPanelWidth).toBe(520);
    expect(initial).not.toHaveProperty('showPredictionMonitor');
    expect(initial).not.toHaveProperty('contractPnlPanelWidth');
    act(() => { result.current.bringSidebarPanelToFront('portfolio'); });
    expect(result.current.persistedPanelState).toBe(initial);
    const stored = saved();
    expect(stored.sidebarPanelStack).toEqual(['system', 'portfolio']);
    ['showResolverTest', 'showPredictionMonitor', 'activePredictionMonitorMarket',
      'contractPnlPanelWidth', 'contractPnlPanelRightExtension', 'contractPnlSizeCustomized',
      'contractPnlGeometryVersion'].forEach((key) => expect(stored).not.toHaveProperty(key));
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
    const { result, unmount } = renderHook(() => useDashboardWorkspaceState({ isProcessOpen: false }));
    expect(result.current.analystPanelPosition).toBe('center');
    expect(saved()).not.toHaveProperty('analystPanelPosition');
    act(() => {
      result.current.setAnalystPanelPosition('left');
      result.current.setAnalystPanelWidth(610);
    });
    expect(result.current.analystPanelPosition).toBe('center');
    expect(saved()).not.toHaveProperty('analystPanelPosition');
    expect(saved()).toMatchObject({ analystPanelWidth: 610 });
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

  it('keeps setters and resize callbacks stable across unrelated workspace changes', () => {
    const { result, rerender, unmount } = renderHook(useWorkspaceWithResize, { initialProps: { isProcessOpen: false } });
    const setWidth = result.current.workspace.setAnalystPanelWidth;
    const resize = result.current.resize.beginAnalystPanelResize;
    act(() => { result.current.workspace.setShowSystemReadiness(true); });
    rerender({ isProcessOpen: true });
    expect(result.current.workspace.setAnalystPanelWidth).toBe(setWidth);
    expect(result.current.resize.beginAnalystPanelResize).toBe(resize);
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

  it.each([1280, 250])('keeps the Analyst resize control inside a %spx viewport', (viewportWidth) => {
    window.innerWidth = viewportWidth;
    const { result } = renderHook(useWorkspaceWithResize);
    act(() => { result.current.resize.handleAnalystPanelResizeKeyDown(key('End')); });
    expect(result.current.workspace.analystPanelWidth).toBe(viewportWidth - 32);
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
