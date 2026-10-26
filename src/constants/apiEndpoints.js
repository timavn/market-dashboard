// API Configuration
export const API_BASE_URL = process.env.REACT_APP_API_BASE_URL || 'http://localhost:3000';

// Market Data APIs
export const ENDPOINTS = {
  // Real-time market data
  MARKET_DATA: '/api/market',
  QUOTES: '/api/quotes',
  OPTIONS_CHAIN: '/api/options',

  // Portfolio data
  PORTFOLIO: '/api/portfolio',
  PORTFOLIO_BALANCE: '/api/portfolio/balance',
  PORTFOLIO_BALANCE_PREVIEW: '/api/portfolio/balance/preview',
  PORTFOLIO_ACCOUNTS: '/api/portfolio/accounts',
  PORTFOLIO_EXPOSURE_RECONCILIATION: '/api/portfolio/exposure/reconciliation',
  PROVIDERS_STATUS: '/api/providers/status',
  IBKR_FLEX_STATUS: '/api/ibkr/flex/status',
  IBKR_FLEX_SYNC: '/api/ibkr/flex/sync',
  IBKR_INTEREST_VALIDATION_STATUS: '/api/ibkr/interest-validation/status',
  IBKR_INTEREST_VALIDATION_HISTORY: '/api/ibkr/interest-validation/history',
  IBKR_INTEREST_VALIDATION_LEDGER: '/api/ibkr/interest-validation/ledger',
  IBKR_INTEREST_VALIDATION_RUN: '/api/ibkr/interest-validation/run',
  POSITIONS: '/api/positions',
  PERFORMANCE: '/api/performance',
  PERFORMANCE_HISTORY: '/api/performance/history',
  PERFORMANCE_METRICS: '/api/performance/metrics',
  PERFORMANCE_POSITIONS: '/api/performance/positions',
  PERFORMANCE_BENCHMARK: '/api/performance/benchmark',
  PERFORMANCE_EQUITY_CURVE: '/api/performance/equity-curve',
  PERFORMANCE_STATEMENTS: '/api/performance/statements',
  PERFORMANCE_STATEMENT: '/api/performance/statement',
  PERFORMANCE_REALIZED_GAIN_LOSS: '/api/performance/realized-gain-loss',

  // Economic indicators
  VIX: '/api/indicators/vix',
  VOLATILITY: '/api/indicators/volatility',
  VOLUME: '/api/indicators/volume',
  MARKET_SHARE_VOLUME: '/api/volume/market-share',

  // Risk ranges
  RISK_RANGES: '/api/risk-ranges',
  EXPOSURE_LAB_UNIVERSE: '/api/risk/exposure-lab/universe',
  EXPOSURE_LAB_SNAPSHOT: '/api/risk/exposure-lab/snapshot',
  EXPOSURE_LAB_SECURITY_MASTER: '/api/risk/exposure-lab/security-master',

  // Workflow status
  LOGIN_STATUS: '/api/login-status',
  SYSTEM_STATUS: '/api/system-status',
  SYSTEM_READINESS: '/api/system-readiness',
  WORKFLOW_STATUS: '/api/workflow-status',
  HERMES_DIRECTOR_STATUS: '/api/hermes/director/status',
  HERMES_DIRECTOR_COMMAND: '/api/hermes/director/command',

  // WebSocket endpoints
  WS_MARKET_DATA: '/ws/market',
  WS_OPTIONS: '/ws/options',
  WS_PORTFOLIO: '/ws/portfolio'
};

// External API configurations (for real data providers)
export const EXTERNAL_APIS = {
  ALPHA_VANTAGE: {
    baseUrl: 'https://www.alphavantage.co/query',
    apiKey: process.env.REACT_APP_ALPHA_VANTAGE_KEY
  },
  FINNHUB: {
    baseUrl: 'https://finnhub.io/api/v1',
    apiKey: process.env.REACT_APP_FINNHUB_KEY
  },
  POLYGON: {
    baseUrl: 'https://api.polygon.io/v2',
    apiKey: process.env.REACT_APP_POLYGON_KEY
  }
};
