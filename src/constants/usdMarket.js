// USD Market Data Constants

export const USD_METRICS = [
  { symbol: 'FXVL', name: 'G5 FX CVOL Index', provider: 'CME Group' },
  { symbol: 'SPX', name: 'S&P 500', yahooTicker: '^GSPC' },
  { symbol: 'BRENT', name: 'Brent', yahooTicker: 'BZ=F' },
  { symbol: 'CRB', name: 'CRB Index', yahooTicker: '^TRCCRB' },
  { symbol: 'GOLD', name: 'Gold', yahooTicker: 'GC=F' },
  { symbol: 'BTC', name: 'Bitcoin', yahooTicker: 'BTC-USD' }
];

export const CURRENCY_PAIRS = [
  { pair: 'USDEUR', name: 'USD/EUR', yahooTicker: 'USDEUR=X' },
  { pair: 'USDJPY', name: 'USD/JPY', yahooTicker: 'USDJPY=X' },
  { pair: 'USDGBP', name: 'USD/GBP', yahooTicker: 'USDGBP=X' },
  { pair: 'USDCHF', name: 'USD/CHF', yahooTicker: 'USDCHF=X' },
  { pair: 'USDCAD', name: 'USD/CAD', yahooTicker: 'USDCAD=X' },
  { pair: 'USDCNY', name: 'USD/CNY', yahooTicker: 'USDCNY=X' },
  { pair: 'USDAUD', name: 'USD/AUD', yahooTicker: 'USDAUD=X' }
];

export const CORRELATION_PERIODS = [15, 30, 90, 120, 180];

export const CORRELATION_COLORS = {
  'positive-strong': '#10B981', // Green-500
  'positive-weak': '#34D399',   // Green-400
  'neutral': '#6B7280',         // Gray-500
  'negative-weak': '#F59E0B',   // Amber-500
  'negative-medium': '#EF4444', // Red-500
  'negative-strong': '#DC2626'  // Red-600
};

export const CHANGE_COLORS = {
  'positive': '#10B981', // Green-500
  'negative': '#EF4444', // Red-500
  'neutral': '#6B7280'   // Gray-500
};

// API Endpoints
export const USD_API_ENDPOINTS = {
  DXY: '/api/usd/dxy',
  CURRENCY_PAIRS: '/api/usd/currency-pairs',
  CORRELATIONS: '/api/usd/correlations',
  HISTORICAL: (symbol) => `/api/usd/historical/${symbol}`
};

// Refresh intervals (in milliseconds)
export const REFRESH_INTERVALS = {
  DXY: 5 * 60 * 1000,        // 5 minutes
  CURRENCY_PAIRS: 5 * 60 * 1000, // 5 minutes
  CORRELATIONS: 60 * 60 * 1000, // 1 hour; API result is cached for the same duration
  DASHBOARD: 15 * 60 * 1000  // 15 minutes
};

// Market hours (EST)
export const MARKET_HOURS = {
  OPEN: 9,  // 9:00 AM EST
  CLOSE: 16 // 4:00 PM EST
};

// Data source configurations
export const DATA_SOURCES = {
  FRED: {
    name: 'Federal Reserve Economic Data',
    baseUrl: 'https://api.stlouisfed.org/fred',
    rateLimit: 'No limit for basic usage'
  },
  YAHOO_FINANCE: {
    name: 'Yahoo Finance',
    baseUrl: 'https://query1.finance.yahoo.com/v8/finance/chart',
    rateLimit: 'No official limit'
  }
};

// Error messages
export const ERROR_MESSAGES = {
  NO_DATA: 'No data available',
  API_ERROR: 'Failed to fetch data from server',
  NETWORK_ERROR: 'Network connection error',
  INVALID_SYMBOL: 'Invalid symbol provided',
  CORRELATION_CALCULATION_ERROR: 'Failed to calculate correlations'
};

// Default values for display
export const DEFAULT_VALUES = {
  DXY: { value: '--', change: '0.00', changePercent: '0.00%' },
  CORRELATION: '--',
  PERCENTAGE: '--%',
  CURRENCY_RATE: '--'
};
