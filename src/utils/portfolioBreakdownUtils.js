/**
 * Portfolio Breakdown Utilities
 * Functions to process portfolio data for breakdown visualization
 */

/**
 * Separate holdings into longs and shorts based on quantity
 * @param {Array} holdings - Array of holding objects
 * @returns {Object} { longs: Array, shorts: Array }
 */
export const separateLongsAndShorts = (holdings) => {
  if (!holdings || !Array.isArray(holdings)) {
    return { longs: [], shorts: [] };
  }

  const longs = [];
  const shorts = [];

  holdings.forEach(holding => {
    const quantity = parseFloat(holding.quantity) || 0;
    const marketValue = parseFloat(holding.marketValue) || 0;

    // Use market value as primary determinant (more reliable than quantity parsing)
    // Or if market value is 0, try quantity
    if (marketValue > 0) {
      longs.push(holding);
    } else if (marketValue < 0) {
      shorts.push(holding);
    } else if (quantity > 0) {
      longs.push(holding);
    } else if (quantity < 0) {
      shorts.push(holding);
    }
    // If both are 0, we skip it
  });

  return { longs, shorts };
};

/**
 * Calculate asset class percentages for a group of holdings
 * @param {Array} holdings - Array of holding objects
 * @param {number} totalValue - Total portfolio value
 * @returns {Array} Array of { name, value, percentage } objects for pie chart
 */
export const calculateAssetClassAllocation = (holdings, totalValue) => {
  if (!holdings || holdings.length === 0 || !totalValue || totalValue === 0) {
    return [];
  }

  const allocation = {};
  let groupTotal = 0;

  holdings.forEach(holding => {
    const marketValue = Math.abs(parseFloat(holding.marketValue) || 0);
    const assetClass = mapAssetClassToDisplay(holding.assetClass || holding.assetType);

    if (!allocation[assetClass]) {
      allocation[assetClass] = 0;
    }
    allocation[assetClass] += marketValue;
    groupTotal += marketValue;
  });

  // Convert to percentage and create pie chart data
  // Filter out "Other" category to ensure it never appears
  const pieData = Object.entries(allocation)
    .map(([name, value]) => ({
      name,
      value: parseFloat(value.toFixed(2)),
      percentage: groupTotal > 0 ? parseFloat(((value / groupTotal) * 100).toFixed(1)) : 0
    }))
    .filter(item => item.value > 0 && item.name !== 'Other')
    .sort((a, b) => b.value - a.value);

  return pieData;
};

/**
 * Map asset class to display category
 * @param {string} assetClass - Original asset class from data
 * @returns {string} Display category (never returns "Other")
 */
export const mapAssetClassToDisplay = (assetClass) => {
  if (!assetClass) {
    // Default to Equities instead of "Other"
    return 'Equities';
  }

  const lower = assetClass.toLowerCase();

  // Map to display categories
  if (lower.includes('equity') || lower.includes('stock') || lower.includes('etf') || lower.includes('equities')) {
    // Check if it's international
    if (lower.includes('international') || lower.includes('foreign') || lower.includes('eaf') || lower.includes('eem')) {
      return 'Equities'; // Map international to Equities
    }
    return 'Equities';
  }

  if (lower.includes('bond') || lower.includes('fixed income') || lower.includes('treasury') || lower.includes('credit') || lower.includes('mbs') || lower.includes('tips')) {
    return 'Fixed Income';
  }

  if (lower.includes('currency') || lower.includes('fx') || lower.includes('forex') || lower.includes('usd') || lower.includes('gold') || lower.includes('silver')) {
    return 'Currencies';
  }

  if (lower.includes('commodity') || lower.includes('oil') || lower.includes('metal') || lower.includes('energy') || lower.includes('agriculture') || lower.includes('corn') || lower.includes('wheat')) {
    return 'Commodities';
  }

  if (lower.includes('crypto') || lower.includes('bitcoin') || lower.includes('ethereum')) {
    return 'Equities'; // Crypto mapped to Equities per existing logic
  }

  // Default to Equities instead of "Other" to ensure we never show "Other"
  return 'Equities';
};

/**
 * Map asset class to primary factor exposure
 * @param {string} assetClass - Asset class name
 * @param {Object} factorExposures - Factor exposures object from portfolio data
 * @returns {string} Primary factor name
 */
export const mapAssetClassToFactor = (assetClass, factorExposures) => {
  if (!factorExposures) return 'Growth';

  const lower = assetClass.toLowerCase();

  // Technology/Equities typically map to Growth
  if (lower.includes('tech') || lower.includes('equity') || lower.includes('stock')) {
    return 'Growth';
  }

  // Value stocks map to Value
  if (lower.includes('value')) {
    return 'Value';
  }

  // Quality stocks map to Quality
  if (lower.includes('quality')) {
    return 'Quality';
  }

  // Momentum
  if (lower.includes('momentum')) {
    return 'Momentum';
  }

  // Default to Growth for most equities
  return 'Growth';
};

/**
 * Prepare data for double pie chart
 * Inner ring: Asset classes
 * Outer ring: Factor exposures
 * @param {Array} holdings - Array of holding objects
 * @param {number} totalValue - Total portfolio value
 * @param {Object} factorExposures - Factor exposures from portfolio data
 * @returns {Object} { innerData: Array, outerData: Array }
 */
export const prepareDoublePieData = (holdings, totalValue, factorExposures) => {
  if (!holdings || holdings.length === 0 || !totalValue || totalValue === 0) {
    return { innerData: [], outerData: [] };
  }

  // Calculate asset class allocation (inner ring)
  const assetClassMap = {};
  holdings.forEach(holding => {
    const marketValue = Math.abs(parseFloat(holding.marketValue) || 0);
    const assetClass = mapAssetClassToDisplay(holding.assetClass || holding.assetType);

    if (!assetClassMap[assetClass]) {
      assetClassMap[assetClass] = 0;
    }
    assetClassMap[assetClass] += marketValue;
  });

  const innerData = Object.entries(assetClassMap)
    .map(([name, value]) => ({
      name,
      value: parseFloat(value.toFixed(2))
    }))
    .filter(item => item.value > 0 && item.name !== 'Other')
    .sort((a, b) => b.value - a.value);

  // Calculate factor exposure (outer ring)
  // Use actual factorExposures data if available, otherwise map from asset classes
  const factorMap = {};

  if (factorExposures && factorExposures.sectors) {
    // Use actual sector exposures from portfolio analytics
    const sectors = factorExposures.sectors;
    const totalFactorValue = totalValue;

    // Map sectors to factors and calculate values
    if (sectors.technology) {
      const techValue = (parseFloat(sectors.technology) / 100) * totalFactorValue;
      factorMap['Growth'] = (factorMap['Growth'] || 0) + techValue;
    }
    if (sectors.healthcare) {
      const healthValue = (parseFloat(sectors.healthcare) / 100) * totalFactorValue;
      factorMap['Quality'] = (factorMap['Quality'] || 0) + healthValue;
    }
    if (sectors.financials) {
      const finValue = (parseFloat(sectors.financials) / 100) * totalFactorValue;
      factorMap['Value'] = (factorMap['Value'] || 0) + finValue;
    }
    if (sectors.consumer) {
      const consumerValue = (parseFloat(sectors.consumer) / 100) * totalFactorValue;
      factorMap['Growth'] = (factorMap['Growth'] || 0) + consumerValue * 0.5;
      factorMap['Value'] = (factorMap['Value'] || 0) + consumerValue * 0.5;
    }
    if (sectors.energy) {
      const energyValue = (parseFloat(sectors.energy) / 100) * totalFactorValue;
      factorMap['Value'] = (factorMap['Value'] || 0) + energyValue;
    }

    // Add remaining allocation to Growth if not fully allocated
    const allocated = Object.values(factorMap).reduce((sum, val) => sum + val, 0);
    if (allocated < totalFactorValue * 0.9) {
      factorMap['Growth'] = (factorMap['Growth'] || 0) + (totalFactorValue - allocated);
    }
  } else {
    // Fallback: Map each asset class to its primary factor and aggregate
    holdings.forEach(holding => {
      const marketValue = Math.abs(parseFloat(holding.marketValue) || 0);
      const assetClass = mapAssetClassToDisplay(holding.assetClass || holding.assetType);
      const factor = mapAssetClassToFactor(assetClass, factorExposures);

      if (!factorMap[factor]) {
        factorMap[factor] = 0;
      }
      factorMap[factor] += marketValue;
    });
  }

  const outerData = Object.entries(factorMap)
    .map(([name, value]) => ({
      name,
      value: parseFloat(value.toFixed(2))
    }))
    .filter(item => item.value > 0)
    .sort((a, b) => b.value - a.value);

  return { innerData, outerData };
};

/**
 * Format performance percentage for display
 * @param {number} value - Performance value
 * @returns {string} Formatted string
 */
export const formatPerformance = (value) => {
  if (value === null || value === undefined || isNaN(value)) {
    return '--';
  }
  const num = parseFloat(value);
  if (num >= 0) {
    return `+${num.toFixed(2)}%`;
  } else {
    return `${num.toFixed(2)}%`;
  }
};

/**
 * Get color for performance value
 * @param {number} value - Performance value
 * @returns {string} Color class or hex
 */
export const getPerformanceColor = (value) => {
  if (value === null || value === undefined || isNaN(value)) {
    return 'gray';
  }
  const num = parseFloat(value);
  if (num > 0) {
    return 'emerald'; // Green
  } else if (num < 0) {
    return 'red';
  }
  return 'gray';
};

/**
 * Format date for display
 * @param {string|Date} date - Date string or Date object
 * @returns {string} Formatted date (MM/DD/YYYY)
 */
export const formatDate = (date) => {
  if (!date) return '--';
  try {
    const d = new Date(date);
    if (isNaN(d.getTime())) return '--';
    return d.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });
  } catch (e) {
    return '--';
  }
};





