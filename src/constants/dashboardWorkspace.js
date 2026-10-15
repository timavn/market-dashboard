export const SIDEBAR_PANEL_Z_INDEX_BASE = 1300;

export const DASHBOARD_PANEL_STATE_KEY = 'marketDashboard.panelState.v1';

export const CONTRACT_PNL_PANEL_DEFAULT_WIDTH = 720;

export const CONTRACT_PNL_PANEL_MIN_WIDTH = 295;

export const CONTRACT_PNL_PANEL_MAX_WIDTH = 1400;

export const CONTRACT_PNL_PANEL_EDGE_INSET = 16;

export const CONTRACT_PNL_PANEL_RESIZE_STEP = 24;

export const ANALYST_PANEL_DEFAULT_WIDTH = 440;

export const ANALYST_PANEL_MIN_WIDTH = 280;

export const ANALYST_PANEL_MAX_WIDTH = 1400;

export const ANALYST_PANEL_EDGE_INSET = 16;

export const ANALYST_PANEL_RESIZE_STEP = 24;

export const ANALYST_PANEL_POSITIONS = new Set(['center']);

export const ANALYST_PANEL_DEFAULT_POSITION = 'center';

export const PERSISTED_SIDEBAR_PANELS = new Set([
  'system',
  'analytics',
  'performance',
  'portfolio',
  'exposureLab',
  'bitcoinResearch',
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

export const PREDICTION_MONITOR_MARKETS = new Set(['silver', 'gold', 'wti', 'brent', 'bitcoin', 'ethereum', 'sp500', 'cpi', 'gdp']);
