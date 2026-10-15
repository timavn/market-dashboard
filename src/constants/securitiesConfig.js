// Securities Configuration - API Source Mappings
// Maps each ticker to its data source and API ticker format

import { SECURITIES_LIST } from './securitiesList';

// API Data Sources
export const DATA_SOURCES = {
  YAHOO: 'yahoo',
  FRED: 'fred',
  CRYPTO: 'crypto'
};

// Treasury Yield FRED Series IDs. Treasury observations are dated daily
// references; they do not advertise intraday chart ranges.
const FRED_SERIES = {
  UST2Y: 'DGS2',
  UST5Y: 'DGS5',
  IG_OAS: 'BAMLC0A0CM',
  HY_OAS: 'BAMLH0A0HYM2',
};

// Yahoo Finance ticker format mappings
// Special cases for indices, currency pairs, commodities, etc.
// This is the single source of truth for all ticker mappings
const YAHOO_TICKER_MAP = {
  // Indices (need ^ prefix)
  'SPX': '^GSPC',
  'DJI': '^DJI',
  'COMPQ': '^IXIC',
  'IXIC': '^IXIC',
  'RUT': '^RUT',
  'NDX': '^NDX',
  'MID': '^MID',
  'VIX': '^VIX',
  'RSP': 'RSP',
  'QQQ': 'QQQ',
  'SMH': 'SMH',
  'DAX': '^GDAXI',
  'FTSE': '^FTSE',
  'CAC': '^FCHI',
  'N100': '^N100',
  'STOXX600': '^STOXX',
  'SX5E': '^STOXX50E',
  'FTSEMIB': 'FTSEMIB.MI',
  'IBEX': '^IBEX',
  'SMI': '^SSMI',
  'NIKK': '^N225',
  'N225': '^N225',
  'HSI': '^HSI',
  'CSI300': '000300.SS',
  'SSEC': '000001.SS',  // Shanghai Composite
  'KOSPI': '^KS11',
  'TAIEX': '^TWII',
  'NIFTY50': '^NSEI',
  'AXJO': '^AXJO',
  'JKSE': '^JKSE',
  'KLSE': '^KLSE',
  
  // Currency pairs (Yahoo format)
  'EUR/USD': 'EURUSD=X',
  'USD/YEN': 'JPY=X',
  'GBP/USD': 'GBPUSD=X',
  'CAD/USD': 'CADUSD=X',
  'USD': 'DX-Y.NYB',  // U.S. Dollar Index (DXY)
  'DXY': 'DX-Y.NYB',  // Dollar Index (alias)
  
  // Currency ETFs
  'UUP': 'UUP',
  'FXE': 'FXE',
  'FXY': 'FXY',
  'FXF': 'FXF',
  'FXB': 'FXB',
  
  // Commodities
  'WTIC': 'CL=F',      // WTI Crude Oil
  'WTI': 'CL=F',       // WTI Crude Oil (alias)
  'BRENT': 'BZ=F',     // Brent Crude Oil
  'BZ': 'BZ=F',
  'NATGAS': 'NG=F',    // Natural Gas
  'NG': 'NG=F',
  'GOLD': 'GC=F',      // Gold Futures
  'GC': 'GC=F',
  'SILVER': 'SI=F',    // Silver Futures
  'SI': 'SI=F',
  'COPPER': 'HG=F',    // Copper Futures
  'HG': 'HG=F',
  'PLATINUM': 'PL=F',  // Platinum Futures
  'PL': 'PL=F',
  'CORN': 'ZC=F',      // Corn Futures
  'ZC': 'ZC=F',
  'PALLADIUM': 'PA=F',
  'PA': 'PA=F',
  'WHEAT': 'ZW=F',
  'ZW': 'ZW=F',
  'SOYBEANS': 'ZS=F',
  'ZS': 'ZS=F',
  'RBOB': 'RB=F',
  'RB': 'RB=F',
  
  // Crypto (Yahoo Finance format)
  'BTC': 'BTC-USD',
  'BITCOIN': 'BTC-USD',
  'ETH': 'ETH-USD',
  'BNB': 'BNB-USD',
  'SOL': 'SOL-USD',
  'AVAX': 'AVAX-USD',
  'XRP': 'XRP-USD',
  
  // Additional indices/commodities
  'CRB': '^TRCCRB',    // Refinitiv/CoreCommodity CRB Index
  // Rates (CBOE Treasury yield indices)
  // Yahoo may quote percent directly (~4.58) or legacy yield×10 (~45.8); see treasuryYieldScale.cjs
  'UST10Y': '^TNX',    // 10-Year Treasury Yield Index
  'UST30Y': '^TYX',    // 30-Year Treasury Yield Index
};

/**
 * Get API configuration for a security ticker
 * @param {string} ticker - Security ticker symbol
 * @returns {Object} Configuration with source, apiTicker, and metadata
 */
export const getSecurityConfig = (ticker) => {
  const upperTicker = ticker.toUpperCase();
  
  // Treasury Yields - use FRED
  if (FRED_SERIES[upperTicker]) {
    return {
      ticker: upperTicker,
      source: DATA_SOURCES.FRED,
      apiTicker: FRED_SERIES[upperTicker],
      name: getSecurityName(upperTicker),
      assetClass: getSecurityAssetClass(upperTicker)
    };
  }
  
  // Check Yahoo Finance special mappings
  if (YAHOO_TICKER_MAP[upperTicker]) {
    return {
      ticker: upperTicker,
      source: DATA_SOURCES.YAHOO,
      apiTicker: YAHOO_TICKER_MAP[upperTicker],
      name: getSecurityName(upperTicker),
      assetClass: getSecurityAssetClass(upperTicker)
    };
  }
  
  // Default: use ticker as-is for Yahoo Finance
  // Most ETFs and stocks work directly
  return {
    ticker: upperTicker,
    source: DATA_SOURCES.YAHOO,
    apiTicker: upperTicker,
    name: getSecurityName(upperTicker),
    assetClass: getSecurityAssetClass(upperTicker)
  };
};

/**
 * Get security name from SECURITIES_LIST
 */
const getSecurityName = (ticker) => {
  const security = SECURITIES_LIST.find(s => s.ticker.toUpperCase() === ticker.toUpperCase());
  return security ? security.name : ticker;
};

/**
 * Get asset class from SECURITIES_LIST
 */
const getSecurityAssetClass = (ticker) => {
  const security = SECURITIES_LIST.find(s => s.ticker.toUpperCase() === ticker.toUpperCase());
  return security ? security.assetClass : 'equity';
};

/**
 * Get all securities configurations
 * @returns {Array} Array of security configurations
 */
export const getAllSecuritiesConfig = () => {
  return SECURITIES_LIST.map(security => getSecurityConfig(security.ticker));
};

/**
 * Get securities by data source
 * @param {string} source - Data source (yahoo, fred, crypto)
 * @returns {Array} Array of security configurations for that source
 */
export const getSecuritiesBySource = (source) => {
  return getAllSecuritiesConfig().filter(config => config.source === source);
};

/**
 * Get all tickers that need to be fetched
 * @returns {Array} Array of ticker strings
 */
export const getAllTickers = () => {
  return SECURITIES_LIST.map(s => s.ticker);
};

/**
 * Get API ticker format for a given ticker
 * This is what should be used when calling external APIs
 */
export const getApiTicker = (ticker) => {
  const config = getSecurityConfig(ticker);
  return config.apiTicker;
};

