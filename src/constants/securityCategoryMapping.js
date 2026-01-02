// Security Category Mapping for Quad Rankings
// Maps each security ticker to its specific category for Quad regime ranking
// Priority: Most specific category (Sector/Factor) > Asset Class

export const SECURITY_CATEGORY_MAPPING = {
  // Fixed Income Sectors
  'BKLN': { type: 'fixedIncomeSectors', category: 'Leveraged Loans' },
  'CWB': { type: 'fixedIncomeSectors', category: 'Convertibles' },
  'EMB': { type: 'fixedIncomeSectors', category: 'EM $ Debt' },
  'HYG': { type: 'fixedIncomeSectors', category: 'HY Credit' },
  'IEF': { type: 'fixedIncomeSectors', category: 'Treasury Belly' },
  'LQD': { type: 'fixedIncomeSectors', category: 'IG Credit' },
  'MBB': { type: 'fixedIncomeSectors', category: 'MBS' },
  'PFF': { type: 'fixedIncomeSectors', category: 'Preferreds' },
  'SHY': { type: 'fixedIncomeSectors', category: 'Short Duration Treasurys' },
  'TIP': { type: 'fixedIncomeSectors', category: 'TIPS' },
  'TLT': { type: 'fixedIncomeSectors', category: 'Long Bond' },
  'UST10Y': { type: 'fixedIncomeSectors', category: 'Treasury Belly' },
  'UST2Y': { type: 'fixedIncomeSectors', category: 'Short Duration Treasurys' },
  'UST30Y': { type: 'fixedIncomeSectors', category: 'Long Bond' },
  'BNDX': { type: 'assetClasses', category: 'Fixed Income' },
  'IGOV': { type: 'assetClasses', category: 'Fixed Income' },
  'CLOZ': { type: 'fixedIncomeSectors', category: 'HY Credit' },
  'CLOX': { type: 'fixedIncomeSectors', category: 'IG Credit' },
  'HBDC': { type: 'fixedIncomeSectors', category: 'HY Credit' },

  // Equity Sectors
  'XLK': { type: 'equitySectors', category: 'Tech' },
  'XLY': { type: 'equitySectors', category: 'Consumer Discretionary' },
  'XLC': { type: 'equitySectors', category: 'Communication Services' },
  'XLI': { type: 'equitySectors', category: 'Industrials' },
  'XLB': { type: 'equitySectors', category: 'Materials' },
  'XLRE': { type: 'equitySectors', category: 'REITs' },
  'XLU': { type: 'equitySectors', category: 'Utilities' },
  'XLP': { type: 'equitySectors', category: 'Consumer Staples' },
  'XLV': { type: 'equitySectors', category: 'Health Care' },
  'XLE': { type: 'equitySectors', category: 'Energy' },
  'XLF': { type: 'equitySectors', category: 'Financials' },
  'XOP': { type: 'equitySectors', category: 'Energy' },
  'XME': { type: 'equitySectors', category: 'Materials' },
  'MLPX': { type: 'equitySectors', category: 'Energy' },
  'GDX': { type: 'equitySectors', category: 'Materials' },
  'URA': { type: 'equitySectors', category: 'Energy' },
  'ITA': { type: 'equitySectors', category: 'Industrials' },
  'ITB': { type: 'equitySectors', category: 'Industrials' },
  'SMH': { type: 'equitySectors', category: 'Tech' },
  'ROK': { type: 'equitySectors', category: 'Industrials' },
  'EMR': { type: 'equitySectors', category: 'Industrials' },
  'ULS': { type: 'equitySectors', category: 'Industrials' },
  'SHOO': { type: 'equitySectors', category: 'Consumer Discretionary' },
  'WRBY': { type: 'equitySectors', category: 'Consumer Discretionary' },
  'AXP': { type: 'equitySectors', category: 'Financials' },
  'EFIR': { type: 'equitySectors', category: 'Tech' },

  // Tech Sector Individual Stocks
  'AAPL': { type: 'equitySectors', category: 'Tech' },
  'AMZN': { type: 'equitySectors', category: 'Tech' },
  'GOOGL': { type: 'equitySectors', category: 'Tech' },
  'META': { type: 'equitySectors', category: 'Tech' },
  'MSFT': { type: 'equitySectors', category: 'Tech' },
  'NFLX': { type: 'equitySectors', category: 'Tech' },
  'NVDA': { type: 'equitySectors', category: 'Tech' },
  'ORCL': { type: 'equitySectors', category: 'Tech' },
  'TSLA': { type: 'equitySectors', category: 'Tech' },
  'COIN': { type: 'equitySectors', category: 'Tech' },
  'MARA': { type: 'equitySectors', category: 'Tech' },
  'MSTR': { type: 'equitySectors', category: 'Tech' },
  'RIOT': { type: 'equitySectors', category: 'Tech' },

  // Tech Sector Indices
  'QQQ': { type: 'equitySectors', category: 'Tech' },
  'TQQQ': { type: 'equitySectors', category: 'Tech' },
  'COMPQ': { type: 'equitySectors', category: 'Tech' },
  'SPY': { type: 'assetClasses', category: 'Equities' },
  'SPX': { type: 'assetClasses', category: 'Equities' },
  'RSP': { type: 'assetClasses', category: 'Equities' },
  'IWM': { type: 'assetClasses', category: 'Equities' },
  'RUT': { type: 'assetClasses', category: 'Equities' },
  'VT': { type: 'assetClasses', category: 'Equities' },
  'VYMI': { type: 'equityStyleFactors', category: 'Dividend Yield' },
  'HEFA': { type: 'assetClasses', category: 'Equities' },
  
  // Additional ETFs from portfolio
  'JETS': { type: 'equitySectors', category: 'Industrials' },
  'UFO': { type: 'equitySectors', category: 'Industrials' },
  'LIT': { type: 'equitySectors', category: 'Materials' },
  'SLX': { type: 'equitySectors', category: 'Materials' },
  'BTAL': { type: 'assetClasses', category: 'Equities' },
  'DWSH': { type: 'assetClasses', category: 'Equities' },
  'PINK': { type: 'equitySectors', category: 'Health Care' },
  'TUR': { type: 'assetClasses', category: 'Equities' },
  'EIS': { type: 'assetClasses', category: 'Equities' },

  // Equity Style Factors
  'MTUM': { type: 'equityStyleFactors', category: 'Momentum' },
  'USMV': { type: 'equityStyleFactors', category: 'Low Beta' },

  // International Equities (map to Equities asset class)
  'DAX': { type: 'assetClasses', category: 'Equities' },
  'EMXC': { type: 'assetClasses', category: 'Equities' },
  'EWA': { type: 'assetClasses', category: 'Equities' },
  'EWC': { type: 'assetClasses', category: 'Equities' },
  'EWG': { type: 'assetClasses', category: 'Equities' },
  'EWH': { type: 'assetClasses', category: 'Equities' },
  'EWJ': { type: 'assetClasses', category: 'Equities' },
  'EWQ': { type: 'assetClasses', category: 'Equities' },
  'EWS': { type: 'assetClasses', category: 'Equities' },
  'EWU': { type: 'assetClasses', category: 'Equities' },
  'EWW': { type: 'assetClasses', category: 'Equities' },
  'EWY': { type: 'assetClasses', category: 'Equities' },
  'EWZ': { type: 'assetClasses', category: 'Equities' },
  'EZA': { type: 'assetClasses', category: 'Equities' },
  'FXI': { type: 'assetClasses', category: 'Equities' },
  'ILF': { type: 'assetClasses', category: 'Equities' },
  'INDA': { type: 'assetClasses', category: 'Equities' },
  'NIKK': { type: 'assetClasses', category: 'Equities' },
  'SSEC': { type: 'assetClasses', category: 'Equities' },
  'VGK': { type: 'assetClasses', category: 'Equities' },
  'VIX': { type: 'assetClasses', category: 'Equities' },

  // Gold (classified under FX due to volatility characteristics)
  'GLD': { type: 'assetClasses', category: 'FX' },
  'GOLD': { type: 'assetClasses', category: 'FX' },
  'AAAU': { type: 'assetClasses', category: 'FX' },

  // USD (part of FX asset class)
  'USD': { type: 'assetClasses', category: 'FX' },
  'UUP': { type: 'assetClasses', category: 'FX' },
  'USD/YEN': { type: 'assetClasses', category: 'FX' },

  // FX/Currency (Asset Class)
  'CAD/USD': { type: 'assetClasses', category: 'FX' },
  'EUR/USD': { type: 'assetClasses', category: 'FX' },
  'GBP/USD': { type: 'assetClasses', category: 'FX' },
  'FXB': { type: 'assetClasses', category: 'FX' },
  'FXE': { type: 'assetClasses', category: 'FX' },
  'FXF': { type: 'assetClasses', category: 'FX' },
  'FXY': { type: 'assetClasses', category: 'FX' },

  // Commodities (Asset Class)
  'BRENT': { type: 'assetClasses', category: 'Commodities' },
  'CANE': { type: 'assetClasses', category: 'Commodities' },
  'COPPER': { type: 'assetClasses', category: 'Commodities' },
  'CORN': { type: 'assetClasses', category: 'Commodities' },
  'DBA': { type: 'assetClasses', category: 'Commodities' },
  'JO': { type: 'assetClasses', category: 'Commodities' },
  'NATGAS': { type: 'assetClasses', category: 'Commodities' },
  'NIB': { type: 'assetClasses', category: 'Commodities' },
  'PDBC': { type: 'assetClasses', category: 'Commodities' },
  'PPLT': { type: 'assetClasses', category: 'Commodities' },
  'SILVER': { type: 'assetClasses', category: 'Commodities' },
  'SLV': { type: 'assetClasses', category: 'Commodities' },
  'PALL': { type: 'assetClasses', category: 'Commodities' },
  'CPER': { type: 'assetClasses', category: 'Commodities' },
  'WEAT': { type: 'assetClasses', category: 'Commodities' },
  'WTIC': { type: 'assetClasses', category: 'Commodities' },
  'TOKE': { type: 'assetClasses', category: 'Equities' },
  'USO': { type: 'assetClasses', category: 'Commodities' },
  'UNG': { type: 'assetClasses', category: 'Commodities' },
  'SOYB': { type: 'assetClasses', category: 'Commodities' },
  'REM': { type: 'equitySectors', category: 'REITs' },

  // Crypto (map to Equities asset class for now, or could be separate)
  'AVAX': { type: 'assetClasses', category: 'Equities' },
  'BITCOIN': { type: 'assetClasses', category: 'Equities' },
  'BLOK': { type: 'assetClasses', category: 'Equities' },
  'BMNR': { type: 'assetClasses', category: 'Equities' },
  'BTC': { type: 'assetClasses', category: 'Equities' },
  'CRCL': { type: 'assetClasses', category: 'Equities' },
  'ETH': { type: 'assetClasses', category: 'Equities' },
  'ETHA': { type: 'assetClasses', category: 'Equities' },
  'IBIT': { type: 'assetClasses', category: 'Equities' },
  'SOL': { type: 'assetClasses', category: 'Equities' },
  'XRP': { type: 'assetClasses', category: 'Equities' }
};

/**
 * Volatility Metrics - Hardcoded data from volatility analysis
 * IVOL Prem %: Implied Volatility Premium (positive = expensive, negative = cheap)
 * TTM Z-Score: Trailing Twelve Month Realized Volatility Z-Score
 * IOVR %ile: Implied Vol Over Realized Percentile (0-100)
 */
export const VOLATILITY_METRICS = {
  // Sector ETFs
  'XLB': { ivolPrem: 5.2, ttmZScore: -0.3, iovrPercentile: 45 },
  'XLC': { ivolPrem: -2.1, ttmZScore: 0.6, iovrPercentile: 62 },
  'XLE': { ivolPrem: 8.4, ttmZScore: -0.8, iovrPercentile: 28 },
  'XLF': { ivolPrem: 3.7, ttmZScore: 0.2, iovrPercentile: 55 },
  'XLI': { ivolPrem: 1.9, ttmZScore: -0.1, iovrPercentile: 48 },
  'XLK': { ivolPrem: -4.3, ttmZScore: 0.9, iovrPercentile: 75 },
  'XLP': { ivolPrem: 6.1, ttmZScore: -0.5, iovrPercentile: 35 },
  'XLRE': { ivolPrem: 7.8, ttmZScore: -0.7, iovrPercentile: 30 },
  'XLU': { ivolPrem: 9.2, ttmZScore: -1.0, iovrPercentile: 22 },
  'XLV': { ivolPrem: 2.5, ttmZScore: 0.1, iovrPercentile: 52 },
  'XLY': { ivolPrem: -1.8, ttmZScore: 0.7, iovrPercentile: 68 },

  // International Equities
  'EWJ': { ivolPrem: 4.6, ttmZScore: -0.4, iovrPercentile: 38 },

  // Currencies
  'FXB': { ivolPrem: 3.2, ttmZScore: 0.3, iovrPercentile: 58 },
  'FXY': { ivolPrem: 2.8, ttmZScore: 0.4, iovrPercentile: 60 },

  // Commodities
  'USO': { ivolPrem: 12.5, ttmZScore: -1.2, iovrPercentile: 18 },
  'UNG': { ivolPrem: 15.3, ttmZScore: -1.5, iovrPercentile: 12 },
  'CORN': { ivolPrem: 8.7, ttmZScore: -0.6, iovrPercentile: 32 },
  'SOYB': { ivolPrem: 7.9, ttmZScore: -0.5, iovrPercentile: 36 },
  'CPER': { ivolPrem: 6.4, ttmZScore: -0.3, iovrPercentile: 42 },

  // Fixed Income
  'IEF': { ivolPrem: 2.1, ttmZScore: 0.5, iovrPercentile: 65 },
  'LQD': { ivolPrem: 4.3, ttmZScore: -0.2, iovrPercentile: 46 },
  'EMB': { ivolPrem: 6.8, ttmZScore: -0.4, iovrPercentile: 40 },
  'HYG': { ivolPrem: 5.5, ttmZScore: -0.3, iovrPercentile: 44 },

  // Mega Cap Stocks
  'AAPL': { ivolPrem: -3.2, ttmZScore: 1.1, iovrPercentile: 82 },
  'AMZN': { ivolPrem: -2.8, ttmZScore: 0.8, iovrPercentile: 78 },
  'GOOGL': { ivolPrem: -1.9, ttmZScore: 0.9, iovrPercentile: 76 },
  'META': { ivolPrem: -5.1, ttmZScore: 1.3, iovrPercentile: 88 },
  'MSFT': { ivolPrem: -2.5, ttmZScore: 1.0, iovrPercentile: 80 },
  'NVDA': { ivolPrem: -6.4, ttmZScore: 1.5, iovrPercentile: 92 },
  'TSLA': { ivolPrem: -8.2, ttmZScore: 1.8, iovrPercentile: 95 },

  // REITs
  'REM': { ivolPrem: 8.9, ttmZScore: -0.9, iovrPercentile: 25 }
};

/**
 * Get volatility metrics for a security ticker
 * @param {string} ticker - Security ticker symbol
 * @returns {Object|null} Volatility metrics object or null if not available
 */
export const getVolatilityMetrics = (ticker) => {
  return VOLATILITY_METRICS[ticker] || null;
};

/**
 * Get category mapping for a security ticker
 * @param {string} ticker - Security ticker symbol
 * @returns {Object|null} Category mapping object with type and category, or null if not found
 */
export const getSecurityCategory = (ticker) => {
  return SECURITY_CATEGORY_MAPPING[ticker] || null;
};




