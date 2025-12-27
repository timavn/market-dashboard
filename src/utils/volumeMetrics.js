/**
 * Volume Metrics Utilities
 * Functions to calculate and format volume-related metrics for securities analysis
 * 
 * Key Use Case: Identify "price down on decreasing volume" patterns
 * - Negative Volume ROC = Volume is decreasing (bullish accumulation signal)
 * - Positive Volume ROC = Volume is increasing
 */

/**
 * Calculate Volume Rate of Change (ROC) for multiple periods
 * Volume ROC = ((Current Volume - Volume N days ago) / Volume N days ago) * 100
 * 
 * @param {Array} volumeHistory - Array of {date, volume} objects sorted by date (oldest first)
 * @param {Array} periods - Array of day periods to calculate [1, 5, 15]
 * @returns {Object} ROC values for each period { '1D': -12.5, '5D': -25.3, '15D': -8.7 }
 */
export const calculateVolumeROC = (volumeHistory, periods = [1, 5, 15]) => {
  const result = {};
  
  // Initialize all periods with null
  periods.forEach(period => {
    const key = `${period}D`;
    result[key] = null;
  });

  if (!volumeHistory || !Array.isArray(volumeHistory) || volumeHistory.length === 0) {
    return result;
  }

  // Sort by date if not already (most recent last)
  const sorted = [...volumeHistory].sort((a, b) => {
    const dateA = new Date(a.date || a.dateValue || 0);
    const dateB = new Date(b.date || b.dateValue || 0);
    return dateA - dateB;
  });

  const len = sorted.length;
  
  // Get current volume (most recent)
  const currentVolume = parseFloat(sorted[len - 1]?.volume || 0);
  
  if (currentVolume <= 0) {
    return result;
  }

  // Calculate ROC for each period
  periods.forEach(period => {
    const key = `${period}D`;
    
    // We need at least (period + 1) data points to calculate ROC
    if (len >= period + 1) {
      const pastIndex = len - 1 - period;
      const pastVolume = parseFloat(sorted[pastIndex]?.volume || 0);
      
      if (pastVolume > 0) {
        const roc = ((currentVolume - pastVolume) / pastVolume) * 100;
        result[key] = roc;
      }
    }
  });

  return result;
};

/**
 * Calculate average volume over a period
 * @param {Array} volumeHistory - Array of {date, volume} objects
 * @param {number} period - Number of days to average
 * @returns {number|null} Average volume or null if insufficient data
 */
export const calculateAverageVolume = (volumeHistory, period = 20) => {
  if (!volumeHistory || !Array.isArray(volumeHistory) || volumeHistory.length < period) {
    return null;
  }

  // Sort by date (most recent last)
  const sorted = [...volumeHistory].sort((a, b) => {
    const dateA = new Date(a.date || a.dateValue || 0);
    const dateB = new Date(b.date || b.dateValue || 0);
    return dateA - dateB;
  });

  // Get last N days
  const recentVolumes = sorted.slice(-period);
  
  const sum = recentVolumes.reduce((acc, item) => {
    const vol = parseFloat(item.volume || 0);
    return acc + (vol > 0 ? vol : 0);
  }, 0);

  return sum / recentVolumes.length;
};

/**
 * Calculate Relative Volume (RVOL) - current volume vs average
 * @param {number} currentVolume - Current day's volume
 * @param {number} averageVolume - Average volume over a period
 * @returns {number|null} RVOL ratio (1.0 = average, <1 = below average, >1 = above average)
 */
export const calculateRVOL = (currentVolume, averageVolume) => {
  if (!currentVolume || !averageVolume || averageVolume <= 0) {
    return null;
  }
  return currentVolume / averageVolume;
};

/**
 * Format Volume ROC for display
 * @param {number|null} roc - Volume ROC percentage
 * @returns {string} Formatted string
 */
export const formatVolumeROC = (roc) => {
  if (roc === null || roc === undefined || isNaN(roc)) {
    return '--';
  }
  const num = parseFloat(roc);
  if (num >= 0) {
    return `+${num.toFixed(1)}%`;
  } else {
    return `${num.toFixed(1)}%`;
  }
};

/**
 * Get color for Volume ROC
 * Simple red/green interpretation:
 * - Positive ROC = increasing volume = green
 * - Negative ROC = decreasing volume = red
 * 
 * @param {number|null} roc - Volume ROC percentage
 * @returns {string} Color name for styling
 */
export const getVolumeROCColor = (roc) => {
  if (roc === null || roc === undefined || isNaN(roc)) {
    return 'gray';
  }
  
  const num = parseFloat(roc);
  
  if (num > 0) {
    return 'emerald'; // Volume increasing
  } else if (num < 0) {
    return 'red'; // Volume decreasing
  }
  return 'gray';
};

/**
 * Format volume number for display (with K, M, B suffixes)
 * @param {number|null} volume - Volume value
 * @returns {string} Formatted string
 */
export const formatVolume = (volume) => {
  if (volume === null || volume === undefined || isNaN(volume)) {
    return '--';
  }
  
  const num = parseFloat(volume);
  
  if (num >= 1000000000) {
    return `${(num / 1000000000).toFixed(1)}B`;
  } else if (num >= 1000000) {
    return `${(num / 1000000).toFixed(1)}M`;
  } else if (num >= 1000) {
    return `${(num / 1000).toFixed(1)}K`;
  }
  return num.toFixed(0);
};

/**
 * Extract volume data from historical price data
 * @param {Array} priceHistory - Array of price history objects {date, close, volume, ...}
 * @returns {Array} Array of {date, volume} objects
 */
export const extractVolumeHistory = (priceHistory) => {
  if (!priceHistory || !Array.isArray(priceHistory)) {
    return [];
  }
  
  return priceHistory
    .filter(item => item.volume !== undefined && item.volume !== null)
    .map(item => ({
      date: item.date || item.dateValue,
      volume: parseFloat(item.volume || 0)
    }));
};

/**
 * Determine if volume pattern is favorable for buying
 * "Price down on decreasing volume" pattern detection
 * 
 * @param {Object} volumeROC - Volume ROC values { '1D': x, '5D': y, '15D': z }
 * @param {Object} priceChange - Price change values { '1D': x, '1W': y, '1M': z }
 * @returns {Object} { isFavorable: boolean, reason: string }
 */
export const isVolumePatternFavorable = (volumeROC, priceChange) => {
  if (!volumeROC || !priceChange) {
    return { isFavorable: false, reason: 'Insufficient data' };
  }
  
  const vol5D = volumeROC['5D'];
  const price1D = priceChange['1D'];
  const price1W = priceChange['1W'];
  
  // Check for "price down on decreasing volume" pattern
  const isPriceDown = (price1D !== null && price1D < 0) || (price1W !== null && price1W < 0);
  const isVolumeDecreasing = vol5D !== null && vol5D < 0;
  
  if (isPriceDown && isVolumeDecreasing) {
    return {
      isFavorable: true,
      reason: 'Price down on decreasing volume - potential accumulation'
    };
  }
  
  return {
    isFavorable: false,
    reason: ''
  };
};

