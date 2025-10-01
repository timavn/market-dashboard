// CSV Processing utilities for Schwab and other brokerage formats

export const parseSchwabCSV = (csvContent) => {
  try {
    const lines = csvContent.split('\n');
    
    // Find header line (contains "Symbol")
    let headerLineIndex = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes('Symbol') && lines[i].includes('Description')) {
        headerLineIndex = i;
        break;
      }
    }
    
    if (headerLineIndex === -1) {
      throw new Error('Invalid Schwab CSV format');
    }
    
    // Parse CSV data
    const dataLines = lines.slice(headerLineIndex).join('\n');
    const rows = dataLines.split('\n').slice(1); // Skip header
    
    const positions = rows
      .filter(row => row.trim() && !row.includes('Account Total'))
      .map(row => {
        const cols = row.split('","').map(col => col.replace(/^"|"$/g, ''));
        
        return {
          symbol: cols[0],
          description: cols[1],
          marketValue: parseDollar(cols[6]),
          dayChange: parseDollar(cols[7]),
          dayChangePercent: parsePercent(cols[8]),
          totalGainLoss: parseDollar(cols[9]),
          totalGainLossPercent: parsePercent(cols[10]),
          accountPercent: parsePercent(cols[13]),
          securityType: cols[14]
        };
      })
      .filter(pos => pos.symbol && pos.marketValue > 0);
    
    return positions;
  } catch (err) {
    throw new Error(`CSV processing error: ${err.message}`);
  }
};

export const parseDollar = (str) => {
  if (!str || str === 'N/A' || str === '--') return 0;
  return parseFloat(str.replace(/[$,]/g, ''));
};

export const parsePercent = (str) => {
  if (!str || str === 'N/A' || str === '--') return 0;
  return parseFloat(str.replace('%', ''));
};

export const calculatePortfolioSummary = (positions) => {
  const totalValue = positions.reduce((sum, pos) => sum + pos.marketValue, 0);
  const totalDayChange = positions.reduce((sum, pos) => sum + pos.dayChange, 0);
  const totalGainLoss = positions.reduce((sum, pos) => sum + pos.totalGainLoss, 0);
  
  return {
    totalValue,
    totalDayChange,
    totalDayChangePercent: ((totalDayChange / (totalValue - totalDayChange)) * 100).toFixed(2),
    totalGainLoss,
    totalGainLossPercent: ((totalGainLoss / (totalValue - totalGainLoss)) * 100).toFixed(2),
    positionCount: positions.length
  };
};

export const calculateAssetAllocation = (positions) => {
  const assetTypes = {
    'ETFs & Closed End Funds': 'Equities',
    'Equity': 'Equities',
    'Cash and Money Market': 'Cash',
    'Fixed Income': 'Fixed Income',
    'Options': 'Derivatives'
  };
  
  const totalValue = positions.reduce((sum, pos) => sum + pos.marketValue, 0);
  const assetAllocation = {};
  
  positions.forEach(pos => {
    const type = assetTypes[pos.securityType] || 'Other';
    if (!assetAllocation[type]) assetAllocation[type] = 0;
    assetAllocation[type] += pos.marketValue;
  });
  
  // Convert to percentages
  const assetAllocationPercent = {};
  Object.entries(assetAllocation).forEach(([type, value]) => {
    assetAllocationPercent[type] = (value / totalValue * 100).toFixed(1);
  });
  
  return assetAllocationPercent;
};

export const getTopHoldings = (positions, count = 5) => {
  return positions
    .sort((a, b) => b.marketValue - a.marketValue)
    .slice(0, count);
};