import { DASHBOARD_PANEL_STATE_KEY, ANALYST_PANEL_DEFAULT_WIDTH, ANALYST_PANEL_MIN_WIDTH, ANALYST_PANEL_MAX_WIDTH, ANALYST_PANEL_POSITIONS, ANALYST_PANEL_DEFAULT_POSITION, PERSISTED_SIDEBAR_PANELS } from '../constants/dashboardWorkspace';

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

export const normalizeAnalystPanelPosition = (value) => (
  ANALYST_PANEL_POSITIONS.has(value) ? value : ANALYST_PANEL_DEFAULT_POSITION
);

// Panel state saved before the prediction monitor and Contract P&L windows were
// removed can still name them; drop those keys so restore only sees live panels.
const RETIRED_PANEL_STATE_KEYS = Object.freeze([
  'showPredictionMonitor',
  'activePredictionMonitorMarket',
  'showResolverTest',
  'contractPnlPanelWidth',
  'contractPnlPanelRightExtension',
  'contractPnlSizeCustomized',
  'contractPnlGeometryVersion',
]);

export const migrateLegacyPanelState = (state = {}) => {
  const source = state && typeof state === 'object' ? state : {};
  const migrated = { ...source };
  RETIRED_PANEL_STATE_KEYS.forEach((key) => { delete migrated[key]; });
  const stack = Array.isArray(source.sidebarPanelStack) ? source.sidebarPanelStack : [];
  migrated.sidebarPanelStack = [...new Set(stack.filter((key) => PERSISTED_SIDEBAR_PANELS.has(key)))];
  return migrated;
};

export const readPersistedSidebarStack = (state) => (
  Array.isArray(state?.sidebarPanelStack)
    ? [...new Set(state.sidebarPanelStack.filter((key) => PERSISTED_SIDEBAR_PANELS.has(key)))]
    : []
);
