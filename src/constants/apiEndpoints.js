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
  POSITIONS: '/api/positions',
  PERFORMANCE: '/api/performance',
  
  // Performance tracking
  PERFORMANCE_HISTORY: '/api/performance/history',
  PERFORMANCE_METRICS: '/api/performance/metrics',
  PERFORMANCE_POSITIONS: '/api/performance/positions',
  PERFORMANCE_BENCHMARK: '/api/performance/benchmark-comparison',
  PERFORMANCE_EQUITY_CURVE: '/api/performance/equity-curve',
  
  // Economic indicators
  VIX: '/api/indicators/vix',
  VOLATILITY: '/api/indicators/volatility',
  VOLUME: '/api/indicators/volume',
  
  // Risk ranges
  RISK_RANGES: '/api/risk-ranges',
  
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