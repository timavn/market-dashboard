// Securities Universe for Trading Dashboard
// Complete list of tradeable ETFs and securities

export const SECURITIES_LIST = [
  // Fixed Income (Treasury + Corporate Bonds)
  { ticker: 'UST30Y', name: '30-Year U.S. Treasury Yield', assetClass: 'fixedIncome', bias: 'BEARISH' },
  { ticker: 'UST10Y', name: '10-Year U.S. Treasury Yield', assetClass: 'fixedIncome', bias: 'BEARISH' },
  { ticker: 'UST2Y', name: '2-Year U.S. Treasury Yield', assetClass: 'fixedIncome', bias: 'BEARISH' },
  { ticker: 'HYG', name: 'High Yield Corporate Bond ETF', assetClass: 'fixedIncome', bias: 'BULLISH' },
  { ticker: 'LQD', name: 'Investment Grade Corporate Bond ETF', assetClass: 'fixedIncome', bias: 'BULLISH' },
  
  // Equities (Indices + Sectors + Individual Stocks)
  { ticker: 'SPX', name: 'S&P 500', assetClass: 'equity', bias: 'BULLISH' },
  { ticker: 'COMPQ', name: 'NASDAQ Composite', assetClass: 'equity', bias: 'BULLISH' },
  { ticker: 'RUT', name: 'Russell 2000', assetClass: 'equity', bias: 'BULLISH' },
  { ticker: 'SSEC', name: 'Shanghai Composite', assetClass: 'equity', bias: 'BULLISH' },
  { ticker: 'NIKK', name: 'Nikkei 225 Index', assetClass: 'equity', bias: 'BULLISH' },
  { ticker: 'DAX', name: 'German DAX Composite', assetClass: 'equity', bias: 'BULLISH' },
  { ticker: 'VIX', name: 'Volatility Index', assetClass: 'equity', bias: 'BEARISH' },
  { ticker: 'XLK', name: 'Technology Select Sector SPDR Fund', assetClass: 'equity', bias: 'BULLISH' },
  { ticker: 'GDX', name: 'VanEck Gold Miners ETF', assetClass: 'equity', bias: 'BULLISH' },
  { ticker: 'XLI', name: 'Industrial Select Sector SPDR Fund', assetClass: 'equity', bias: 'BULLISH' },
  { ticker: 'MSFT', name: 'Microsoft Corp.', assetClass: 'equity', bias: 'BULLISH' },
  { ticker: 'AAPL', name: 'Apple Inc.', assetClass: 'equity', bias: 'BULLISH' },
  { ticker: 'AMZN', name: 'Amazon Inc.', assetClass: 'equity', bias: 'BEARISH' },
  { ticker: 'META', name: 'Meta Platforms Inc.', assetClass: 'equity', bias: 'BEARISH' },
  { ticker: 'GOOGL', name: 'Alphabet Inc.', assetClass: 'equity', bias: 'BULLISH' },
  { ticker: 'NFLX', name: 'Netflix Inc.', assetClass: 'equity', bias: 'BULLISH' },
  { ticker: 'TSLA', name: 'Tesla Inc.', assetClass: 'equity', bias: 'BULLISH' },
  { ticker: 'NVDA', name: 'NVIDIA Corporation', assetClass: 'equity', bias: 'BULLISH' },
  { ticker: 'ORCL', name: 'Oracle Corporation', assetClass: 'equity', bias: 'BULLISH' },
  
  // Currencies / FX (including Gold)
  { ticker: 'USD', name: 'U.S. Dollar Index', assetClass: 'currency', bias: 'BULLISH' },
  { ticker: 'EUR/USD', name: 'Euro to U.S. Dollar', assetClass: 'currency', bias: 'BEARISH' },
  { ticker: 'USD/YEN', name: 'U.S. Dollar to Japanese Yen', assetClass: 'currency', bias: 'BULLISH' },
  { ticker: 'GBP/USD', name: 'British Pound to U.S. Dollar', assetClass: 'currency', bias: 'BEARISH' },
  { ticker: 'CAD/USD', name: 'Canadian Dollar to U.S. Dollar', assetClass: 'currency', bias: 'BEARISH' },
  { ticker: 'GOLD', name: 'Gold Spot Price', assetClass: 'currency', bias: 'BULLISH' },
  
  // Commodities
  { ticker: 'WTIC', name: 'Light Crude Oil Continuous Contract', assetClass: 'commodity', bias: 'BEARISH' },
  { ticker: 'BRENT', name: 'Brent Crude Oil Continuous Contract', assetClass: 'commodity', bias: 'BEARISH' },
  { ticker: 'NATGAS', name: 'Natural Gas Continuous Contract', assetClass: 'commodity', bias: 'NEUTRAL' },
  { ticker: 'COPPER', name: 'Copper Continuous Contract', assetClass: 'commodity', bias: 'BULLISH' },
  { ticker: 'SILVER', name: 'Silver Spot Price', assetClass: 'commodity', bias: 'BULLISH' },
  
  // Crypto
  { ticker: 'BITCOIN', name: 'Bitcoin Spot Price', assetClass: 'crypto', bias: 'NEUTRAL' },
  { ticker: 'IBIT', name: 'iShares Bitcoin Trust', assetClass: 'crypto', bias: 'NEUTRAL' },
  { ticker: 'MSTR', name: 'MicroStrategy Inc.', assetClass: 'crypto', bias: 'NEUTRAL' },
  { ticker: 'MARA', name: 'Marathon Digital Holdings', assetClass: 'crypto', bias: 'NEUTRAL' },
  { ticker: 'RIOT', name: 'Riot Platforms Inc.', assetClass: 'crypto', bias: 'NEUTRAL' },
  { ticker: 'ETHA', name: 'Etherea Capital Corp.', assetClass: 'crypto', bias: 'NEUTRAL' },
  { ticker: 'BLOK', name: 'Amplify Transformational Data Sharing ETF', assetClass: 'crypto', bias: 'NEUTRAL' },
  { ticker: 'COIN', name: 'Coinbase Global Inc.', assetClass: 'crypto', bias: 'NEUTRAL' },
  { ticker: 'CRCL', name: 'Crypto Currency Corp.', assetClass: 'crypto', bias: 'NEUTRAL' }
];

// Asset class color mapping
export const ASSET_CLASS_COLORS = {
  fixedIncome: '#E0F2FE',   // Light blue
  equity: '#D1FAE5',        // Light green
  currency: '#E9D5FF',      // Light purple
  commodity: '#FED7AA',     // Light orange
  crypto: '#FDE68A'         // Gold
};

// Asset class display names
export const ASSET_CLASS_NAMES = {
  fixedIncome: 'Fixed Income',
  equity: 'Equity',
  currency: 'Currency/FX',
  commodity: 'Commodity',
  crypto: 'Cryptocurrency'
};

// Placeholder data structure for future ranking algorithm
export const getSecurityWithPlaceholders = (security) => ({
  ...security,
  weekChange: 'N/A',    // Will be populated by ranking algorithm
  monthChange: 'N/A',   // Will be populated by ranking algorithm
  riskRange: '--',      // Will be calculated from price data
  trade: '--',          // Will come from strategy engine
  trend: '--'           // Will be based on technical analysis
});

// Get all securities with placeholder data
export const getSecuritiesWithPlaceholders = () => {
  return SECURITIES_LIST.map(getSecurityWithPlaceholders);
};

