import { DASHBOARD_PANEL_STATE_KEY, CONTRACT_PNL_PANEL_DEFAULT_WIDTH, CONTRACT_PNL_PANEL_MIN_WIDTH, CONTRACT_PNL_PANEL_MAX_WIDTH, ANALYST_PANEL_DEFAULT_WIDTH, ANALYST_PANEL_MIN_WIDTH, ANALYST_PANEL_MAX_WIDTH, ANALYST_PANEL_POSITIONS, ANALYST_PANEL_DEFAULT_POSITION, PERSISTED_SIDEBAR_PANELS, PREDICTION_MONITOR_MARKETS } from '../constants/dashboardWorkspace';

export const readDashboardPanelState = () => {
  if (typeof window === 'undefined') return {};
  try {
    const parsed = JSON.parse(window.localStorage.getItem(DASHBOARD_PANEL_STATE_KEY) || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
};

export const writeDashboardPanelState = (state) => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(DASHBOARD_PANEL_STATE_KEY, JSON.stringify(state));
  } catch {
    // localStorage can be unavailable in private contexts; panel state can still run in memory.
  }
};

export const readPersistedBoolean = (state, key) => state?.[key] === true;

export const clampAnalystPanelWidth = (
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

export const clampContractPnlPanelWidth = (
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

export const normalizeAnalystPanelPosition = (value) => (
  ANALYST_PANEL_POSITIONS.has(value) ? value : ANALYST_PANEL_DEFAULT_POSITION
);

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

export const readPersistedSidebarStack = (state) => (
  Array.isArray(state?.sidebarPanelStack)
    ? [...new Set(state.sidebarPanelStack.filter((key) => PERSISTED_SIDEBAR_PANELS.has(key)))]
    : []
);
