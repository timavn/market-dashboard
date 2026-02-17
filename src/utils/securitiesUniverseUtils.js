/**
 * Securities Universe Utilities
 * Functions to process and format securities data for the universe interface
 */

import { ASSET_CLASS_NAMES, GICS_SECTOR_MAPPING } from '../constants/securitiesList';

/**
 * Map asset class to primary factor exposure
 * @param {string} assetClass - Asset class name
 * @param {string} ticker - Ticker symbol
 * @param {string} name - Security name
 * @returns {string} Primary factor name
 */
export const mapAssetClassToFactor = (assetClass, ticker = '', name = '') => {
  const lowerTicker = ticker.toLowerCase();
  const lowerName = name.toLowerCase();
  const lowerAssetClass = assetClass?.toLowerCase() || '';

  // Technology/Equities typically map to Growth
  if (lowerTicker.includes('qqq') || lowerTicker.includes('xlk') || 
      lowerTicker.includes('smh') || lowerName.includes('tech') ||
      lowerName.includes('semiconductor') || lowerName.includes('nasdaq')) {
    return 'Growth';
  }

  // Value stocks
  if (lowerTicker.includes('rsp') || lowerTicker.includes('xlf') ||
      lowerName.includes('value') || lowerName.includes('financial')) {
    return 'Value';
  }

  // Quality stocks (healthcare, utilities)
  if (lowerTicker.includes('xlv') || lowerTicker.includes('xlu') ||
      lowerName.includes('healthcare') || lowerName.includes('utility')) {
    return 'Quality';
  }

  // Momentum
  if (lowerTicker.includes('mtum') || lowerName.includes('momentum')) {
    return 'Momentum';
  }

  // Low Volatility
  if (lowerTicker.includes('usmv') || lowerName.includes('low volatility')) {
    return 'Low Volatility';
  }

  // Fixed Income → Quality
  if (lowerAssetClass === 'fixedincome' || lowerAssetClass === 'fixed income') {
    return 'Quality';
  }

  // Currency → Momentum/Quality
  if (lowerAssetClass === 'currency') {
    return 'Momentum';
  }

  // Commodity → Value/Momentum
  if (lowerAssetClass === 'commodity') {
    return 'Value';
  }

  // Crypto → Growth/Momentum
  if (lowerAssetClass === 'crypto') {
    return 'Growth';
  }

  // Default for equities
  if (lowerAssetClass === 'equity') {
    return 'Growth';
  }

  return 'Growth'; // Default
};

/**
 * Get GICS sector for a security from GICS_SECTOR_MAPPING
 * @param {string} ticker - Ticker symbol
 * @returns {string} GICS sector name or 'N/A' if not applicable
 */
export const getGicsSector = (ticker) => {
  return GICS_SECTOR_MAPPING[ticker] ?? 'N/A';
};

/**
 * Determine benchmark for a security based on asset class
 * @param {string} assetClass - Asset class name
 * @param {string} ticker - Ticker symbol
 * @returns {string} Benchmark ticker
 */
export const getBenchmark = (assetClass, ticker = '') => {
  const lowerAssetClass = assetClass?.toLowerCase() || '';
  const lowerTicker = ticker.toLowerCase();

  // US Equities
  if (lowerAssetClass === 'equity') {
    if (lowerTicker.includes('ew') || lowerTicker.includes('fxi') || 
        lowerTicker.includes('inda') || lowerTicker.includes('eza') ||
        lowerTicker.includes('ilf') || lowerTicker.includes('emxc') ||
        lowerTicker.includes('hefa') || lowerTicker.includes('vgk') ||
        lowerTicker.includes('vymi')) {
      return 'VT'; // Global equities
    }
    return 'SPY'; // US equities default
  }

  // Fixed Income
  if (lowerAssetClass === 'fixedincome' || lowerAssetClass === 'fixed income') {
    if (lowerTicker.includes('ust') || lowerTicker.includes('shy') || 
        lowerTicker.includes('ief') || lowerTicker.includes('tlt')) {
      return 'TLT'; // Long-term treasuries
    }
    return 'AGG'; // Aggregate bond index
  }

  // Currency
  if (lowerAssetClass === 'currency') {
    return 'DXY'; // Dollar Index
  }

  // Commodity
  if (lowerAssetClass === 'commodity') {
    if (lowerTicker.includes('gold') || lowerTicker.includes('gld')) {
      return 'GLD';
    }
    if (lowerTicker.includes('oil') || lowerTicker.includes('wti') || lowerTicker.includes('brent')) {
      return 'WTIC';
    }
    return 'GLD'; // Default to gold
  }

  // Crypto
  if (lowerAssetClass === 'crypto') {
    return 'BTC';
  }

  return 'SPY'; // Default
};

/**
 * Calculate Z-score from price history
 * @param {number} currentPrice - Current price
 * @param {Array} priceHistory - Array of price values
 * @param {number} period - Number of days for calculation (default: 20)
 * @returns {number|null} Z-score or null if insufficient data
 */
export const calculateZScore = (currentPrice, priceHistory, period = 20) => {
  if (!currentPrice || !priceHistory || priceHistory.length < period) {
    return null;
  }

  // Get recent prices
  const recentPrices = priceHistory.slice(-period);
  
  // Calculate mean
  const mean = recentPrices.reduce((sum, price) => sum + parseFloat(price), 0) / recentPrices.length;
  
  // Calculate variance
  const variance = recentPrices.reduce((sum, price) => {
    return sum + Math.pow(parseFloat(price) - mean, 2);
  }, 0) / recentPrices.length;
  
  // Calculate standard deviation
  const stdDev = Math.sqrt(variance);
  
  if (stdDev === 0) return 0;
  
  return (currentPrice - mean) / stdDev;
};

/**
 * Calculate price changes for different periods
 * @param {number} currentPrice - Current price
 * @param {Array} priceHistory - Array of {date, close} objects sorted by date
 * @returns {Object} Price changes for 1D, 1W, 1M
 */
export const calculatePriceChanges = (currentPrice, priceHistory) => {
  if (!currentPrice || !priceHistory || priceHistory.length === 0) {
    return {
      '1D': null,
      '1W': null,
      '1M': null
    };
  }

  // Sort by date if not already sorted (most recent last)
  const sorted = [...priceHistory].sort((a, b) => {
    const dateA = new Date(a.date || a.dateValue || 0);
    const dateB = new Date(b.date || b.dateValue || 0);
    return dateA - dateB;
  });

  const changes = {
    '1D': null,
    '1W': null,
    '1M': null
  };

  // Get prices by index (assuming sorted array with most recent last)
  // 1D: second to last item (yesterday)
  // 1W: 7 days ago
  // 1M: 30 days ago
  const len = sorted.length;
  
  if (len >= 2) {
    const price1D = parseFloat(sorted[len - 2]?.close || sorted[len - 2]?.price || 0);
    if (price1D > 0 && currentPrice) {
      changes['1D'] = ((currentPrice - price1D) / price1D) * 100;
    }
  }
  
  if (len >= 8) {
    const price1W = parseFloat(sorted[Math.max(0, len - 8)]?.close || sorted[Math.max(0, len - 8)]?.price || 0);
    if (price1W > 0 && currentPrice) {
      changes['1W'] = ((currentPrice - price1W) / price1W) * 100;
    }
  }
  
  if (len >= 31) {
    const price1M = parseFloat(sorted[Math.max(0, len - 31)]?.close || sorted[Math.max(0, len - 31)]?.price || 0);
    if (price1M > 0 && currentPrice) {
      changes['1M'] = ((currentPrice - price1M) / price1M) * 100;
    }
  }

  return changes;
};

/**
 * Format price change for display
 * @param {number|null} change - Price change percentage
 * @returns {string} Formatted string
 */
export const formatPriceChange = (change) => {
  if (change === null || change === undefined || isNaN(change)) {
    return '--';
  }
  const num = parseFloat(change);
  if (num >= 0) {
    return `+${num.toFixed(2)}%`;
  } else {
    return `${num.toFixed(2)}%`;
  }
};

/**
 * Get color for price change
 * @param {number|null} change - Price change percentage
 * @returns {string} Color class
 */
export const getPriceChangeColor = (change) => {
  if (change === null || change === undefined || isNaN(change)) {
    return 'gray';
  }
  const num = parseFloat(change);
  if (num > 0) {
    return 'emerald'; // Green
  } else if (num < 0) {
    return 'red';
  }
  return 'gray';
};

/**
 * Filter securities by search query
 * @param {Array} securities - Array of security objects
 * @param {string} query - Search query
 * @returns {Array} Filtered securities
 */
export const filterSecurities = (securities, query) => {
  if (!query || query.trim() === '') {
    return securities;
  }

  const lowerQuery = query.toLowerCase().trim();

  return securities.filter(security => {
    const ticker = (security.ticker || '').toLowerCase();
    const name = (security.name || '').toLowerCase();
    const assetClass = (ASSET_CLASS_NAMES[security.assetClass] || security.assetClass || '').toLowerCase();
    const sector = (security.sector || '').toLowerCase();
    const factorExposure = (security.factorExposure || '').toLowerCase();
    const benchmark = (security.benchmark || '').toLowerCase();
    const bias = (security.bias || '').toLowerCase();

    return ticker.includes(lowerQuery) ||
           name.includes(lowerQuery) ||
           assetClass.includes(lowerQuery) ||
           sector.includes(lowerQuery) ||
           factorExposure.includes(lowerQuery) ||
           benchmark.includes(lowerQuery) ||
           bias.includes(lowerQuery);
  });
};

/**
 * Format Z-score for display
 * @param {number|null} zScore - Z-score value
 * @returns {string} Formatted string
 */
export const formatZScore = (zScore) => {
  if (zScore === null || zScore === undefined || isNaN(zScore)) {
    return '--';
  }
  return parseFloat(zScore).toFixed(2);
};

/**
 * Get color for Z-score
 * 0 to 1.0: light green/red
 * 1.01 to 2: bright green/red
 * 2.5+: bright with additional emphasis (border, shadow)
 * @param {number|null} zScore - Z-score value
 * @returns {Object} { color, bgColor, borderColor, emphasis? }
 */
export const getZScoreColor = (zScore) => {
  if (zScore === null || zScore === undefined || isNaN(zScore)) {
    return { color: '#6b7280', bgColor: '#f3f4f6', borderColor: '#d1d5db' }; // Gray
  }
  const num = parseFloat(zScore);
  const abs = Math.abs(num);

  // 2.5+: bright with additional emphasis (white text on solid color, bolder border)
  if (abs >= 2.5) {
    if (num > 0) {
      return {
        color: '#ffffff',
        bgColor: '#059669',
        borderColor: '#047857',
        emphasis: true
      }; // White text on bright green
    } else {
      return {
        color: '#ffffff',
        bgColor: '#dc2626',
        borderColor: '#b91c1c',
        emphasis: true
      }; // White text on bright red
    }
  }

  // 1.01 to 2: bright green/red
  if (abs > 1) {
    if (num > 0) {
      return { color: '#047857', bgColor: '#a7f3d0', borderColor: '#10b981' }; // Bright green
    } else {
      return { color: '#b91c1c', bgColor: '#fecaca', borderColor: '#ef4444' }; // Bright red
    }
  }

  // 0 to 1.0: light green/red
  if (num > 0) {
    return { color: '#059669', bgColor: '#d1fae5', borderColor: '#6ee7b7' }; // Light green
  } else if (num < 0) {
    return { color: '#dc2626', bgColor: '#fee2e2', borderColor: '#fca5a5' }; // Light red
  }

  return { color: '#6b7280', bgColor: '#f3f4f6', borderColor: '#d1d5db' }; // Gray - exactly zero
};




