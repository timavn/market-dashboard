// Signal Strength Calculation Service
// Calculates signal strength scores for securities ranking

/**
 * Calculate signal strength score for a security
 * Score = Base Score (Trend Signal) + Momentum Score + Support/Resistance Score + Risk/Reward Score
 * 
 * @param {Object} security - Security data with price, trend levels, signals, etc.
 * @returns {number} Signal strength score (-100 to +100)
 */
export const calculateSignalStrength = (security) => {
  let score = 0;
  
  // Base Score: Trend Signal
  // BULLISH = +50, BEARISH = -50, NEUTRAL = 0
  const trendSignal = security.trendSignal || security.bias || 'NEUTRAL';
  switch (trendSignal.toUpperCase()) {
    case 'BULLISH':
      score += 50;
      break;
    case 'BEARISH':
      score -= 50;
      break;
    case 'NEUTRAL':
    default:
      score += 0;
      break;
  }
  
  // Momentum Score: Price vs Trend Level
  // Price above Trend Level = +20, below = -20
  const currentPrice = security.price || security.closingPrice || security.currentPrice;
  const trendLevel = security.trendLevel;
  const trendStatus = security.trendStatus;
  
  if (trendLevel && currentPrice) {
    if (trendStatus === 'Above' || currentPrice > trendLevel) {
      score += 20;
    } else if (trendStatus === 'Below' || currentPrice < trendLevel) {
      score -= 20;
    }
  } else if (trendStatus) {
    // Use status if available but no numeric comparison
    if (trendStatus === 'Above') {
      score += 20;
    } else if (trendStatus === 'Below') {
      score -= 20;
    }
  }
  
  // Support/Resistance Score: Price vs Tail Level
  // Price above Tail Level = +10, below = -10
  const tailLevel = security.tailLevel;
  const tailStatus = security.tailStatus;
  
  if (tailLevel && currentPrice) {
    if (tailStatus === 'Above' || currentPrice > tailLevel) {
      score += 10;
    } else if (tailStatus === 'Below' || currentPrice < tailLevel) {
      score -= 10;
    }
  } else if (tailStatus) {
    if (tailStatus === 'Above') {
      score += 10;
    } else if (tailStatus === 'Below') {
      score -= 10;
    }
  }
  
  // Risk/Reward Score: Upside % - Downside % (normalized to -20 to +20)
  const upside = security.upside || 0;
  const downside = security.downside || 0;
  const riskReward = upside - Math.abs(downside); // downside is typically negative
  
  // Normalize to -20 to +20 range
  // Assuming max upside/downside is around 25%, scale accordingly
  const normalizedRiskReward = Math.max(-20, Math.min(20, riskReward * 0.8));
  score += normalizedRiskReward;
  
  // Clamp score to -100 to +100 range
  return Math.max(-100, Math.min(100, Math.round(score)));
};

/**
 * Get signal strength level (label)
 * @param {number} score - Signal strength score
 * @returns {string} Signal strength level
 */
export const getSignalStrengthLevel = (score) => {
  if (score >= 70) return 'Very Strong';
  if (score >= 40) return 'Strong';
  if (score >= 10) return 'Moderate';
  if (score >= -10) return 'Neutral';
  if (score >= -40) return 'Weak';
  if (score >= -70) return 'Very Weak';
  return 'Extremely Weak';
};

/**
 * Get signal strength color for UI
 * @param {number} score - Signal strength score
 * @returns {string} Color class or hex code
 */
export const getSignalStrengthColor = (score) => {
  if (score >= 40) return 'emerald';  // Green for strong bullish
  if (score >= 10) return 'lime';     // Light green for moderate bullish
  if (score >= -10) return 'gray';    // Gray for neutral
  if (score >= -40) return 'amber';   // Yellow/amber for weak bearish
  return 'red';                       // Red for strong bearish
};

/**
 * Rank securities by signal strength
 * @param {Array} securities - Array of security objects with market data
 * @returns {Array} Sorted array of securities with signal strength scores (highest first)
 */
export const rankSecuritiesBySignalStrength = (securities) => {
  return securities
    .map(security => ({
      ...security,
      signalStrength: calculateSignalStrength(security),
      signalLevel: getSignalStrengthLevel(calculateSignalStrength(security)),
      signalColor: getSignalStrengthColor(calculateSignalStrength(security))
    }))
    .sort((a, b) => b.signalStrength - a.signalStrength); // Sort descending (highest first)
};

/**
 * Get top N securities by signal strength
 * @param {Array} securities - Array of security objects
 * @param {number} topN - Number of top securities to return
 * @returns {Array} Top N securities ranked by signal strength
 */
export const getTopSecuritiesBySignalStrength = (securities, topN = 10) => {
  const ranked = rankSecuritiesBySignalStrength(securities);
  return ranked.slice(0, topN);
};

/**
 * Get bottom N securities by signal strength (weakest signals)
 * @param {Array} securities - Array of security objects
 * @param {number} bottomN - Number of bottom securities to return
 * @returns {Array} Bottom N securities ranked by signal strength
 */
export const getBottomSecuritiesBySignalStrength = (securities, bottomN = 10) => {
  const ranked = rankSecuritiesBySignalStrength(securities);
  return ranked.slice(-bottomN).reverse(); // Reverse to show weakest first
};

/**
 * Filter securities by signal strength range
 * @param {Array} securities - Array of security objects
 * @param {number} minScore - Minimum signal strength score
 * @param {number} maxScore - Maximum signal strength score
 * @returns {Array} Filtered securities within score range
 */
export const filterSecuritiesBySignalStrength = (securities, minScore = -100, maxScore = 100) => {
  const ranked = rankSecuritiesBySignalStrength(securities);
  return ranked.filter(security => 
    security.signalStrength >= minScore && security.signalStrength <= maxScore
  );
};

/**
 * Get signal strength statistics
 * @param {Array} securities - Array of security objects
 * @returns {Object} Statistics about signal strength distribution
 */
export const getSignalStrengthStats = (securities) => {
  const ranked = rankSecuritiesBySignalStrength(securities);
  const scores = ranked.map(s => s.signalStrength);
  
  return {
    total: securities.length,
    average: scores.reduce((a, b) => a + b, 0) / scores.length,
    min: Math.min(...scores),
    max: Math.max(...scores),
    bullish: ranked.filter(s => s.signalStrength > 10).length,
    bearish: ranked.filter(s => s.signalStrength < -10).length,
    neutral: ranked.filter(s => s.signalStrength >= -10 && s.signalStrength <= 10).length
  };
};


