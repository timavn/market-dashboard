// Metric Definitions from The Process, The Coach, and The Playbook
// Quick reference guide for interpreting metrics in the Securities Universe

export const METRIC_DEFINITIONS = {
  'zScore': {
    name: 'Z-Score',
    definition: 'Measures how many standard deviations the current price is from the mean price over a given period (typically 1-year or TTM).',
    range: '±2x on a 1-year z-score registers as a potential consensus "fade"',
    interpretation: [
      'Greater than +2: Consensus position (fade opportunity - likely overbought)',
      'Less than -2: Consensus position (likely short side extreme - likely oversold)',
      'Any time anything gets north of 2 in TTM category you have to pay attention'
    ],
    source: 'The Process, Section 11: Z-Score Analysis (Contrarian Indicator)',
    calculation: 'Z = (Current Price - Mean Price) / Standard Deviation'
  },

  'beta': {
    name: 'Beta',
    definition: 'Measures volatility relative to the market (typically SPY). Beta indicates how much a security moves relative to market movements.',
    range: '<1 = less volatile than market, 1 = market average, >1 = more volatile than market',
    interpretation: [
      'High Beta: More sensitive to market movements, performs better in bull markets',
      'Low Beta: Less sensitive to market movements, more defensive in bear markets',
      'In a bear market: Short momentum (high beta) as factor exposure',
      'In a bull market: Long momentum (high beta) as factor exposure'
    ],
    source: 'The Process, Section 9: U.S. Equity Style Factors'
  },

  'ttt': {
    name: 'T/T/T (Trade/Trend/Tail)',
    definition: 'Multi-duration signals that dynamically update across three time horizons to guide entries, exits, and positioning.',
    components: [
      {
        name: 'Trade',
        duration: '3 weeks or less',
        use: 'Used for entries and exits, immediate-term timing'
      },
      {
        name: 'Trend',
        duration: '3 months or more',
        use: 'Intermediate-term cycle direction, position management'
      },
      {
        name: 'Tail',
        duration: '3 years or less',
        use: 'Long-term conviction and regime shifts, strategic allocation'
      }
    ],
    interpretation: [
      'Bullish Trade + Bullish Trend: Ideal setup to buy/add near LRR',
      'Bearish Trade + Bearish Trend: Exit completely or short',
      'Trade breaks but Trend holds: Trim position (sell-SOME)',
      'Both Trade and Trend break: Exit completely'
    ],
    source: 'The Process, Section 5: Risk Range Signals (The Core)'
  },

  'ivolPrem': {
    name: 'IVOL Prem % (Implied Volatility Premium)',
    definition: 'The difference between implied volatility (IV) and realized volatility (RV). Shows whether options are expensive or cheap relative to actual price movement.',
    range: 'Positive = expensive (consensus fear), Negative = cheap (consensus complacency)',
    interpretation: [
      'High IV Premium (>5%): Consensus is hedging after the move - contrarian signal of excessive fear',
      'Low IV Premium (<-2%): Consensus is complacent - potential opportunity',
      'Major signal: When asset goes from persistent IV premium to discount (or reverse)',
      'Looking for: Negative implied vol premium to buy'
    ],
    source: 'The Process, Section 7: Volatility Analysis'
  },

  'ttmZScore': {
    name: 'TTM Z-Score (Trailing Twelve Month Realized Volatility Z-Score)',
    definition: 'Z-score of realized volatility over the past 12 months. Measures if current volatility is high or low relative to the 12-month history.',
    range: '< -0.5 = low volatility (green), -0.5 to 0.5 = neutral (yellow), > 0.5 = high volatility (red)',
    interpretation: [
      'Low TTM Z-Score (< -0.5): Current vol is low relative to 12-month history - potentially complacent',
      'High TTM Z-Score (> 0.5): Current vol is high relative to 12-month history - elevated risk',
      'Used to identify volatility regime and position sizing'
    ],
    source: 'The Process, Section 7: Volatility Analysis'
  },

  'iovrPercentile': {
    name: 'IOVR %ile (Implied Vol Over Realized Percentile)',
    definition: 'Percentile rank (0-100) showing where the current implied vol vs realized vol relationship sits in historical context.',
    range: '0-100, <30 = low (green), 30-70 = neutral (yellow), >70 = high (red)',
    interpretation: [
      'Low IOVR (<30): Implied vol is low relative to realized vol historically - options may be cheap',
      'High IOVR (>70): Implied vol is high relative to realized vol historically - options may be expensive',
      'Shows historical context for IV/RV relationship to identify extremes'
    ],
    source: 'The Process, Section 7: Volatility Analysis'
  },

  'quadRanking': {
    name: 'Quad Ranking',
    definition: 'Position in the "Best" list for each Quad regime. Rankings represent position in the "Best" list for each Quad (1 = strongest, higher = weaker).',
    format: 'Displayed as "Quad1/Quad2/Quad3/Quad4" showing ranking in each regime',
    interpretation: [
      'Lower numbers in first or second position = better for longs',
      'Quad 1 ranking: Best assets for Quad 1 regime (Growth Accelerating, Inflation Accelerating)',
      'Quad 2 ranking: Best assets for Quad 2 regime (Growth Accelerating, Inflation Decelerating)',
      'Quad 3 ranking: Best assets for Quad 3 regime (Growth Decelerating, Inflation Accelerating)',
      'Quad 4 ranking: Best assets for Quad 4 regime (Growth Decelerating, Inflation Decelerating)',
      'Best Quad Counts: Those that actually progress (e.g., 3-2-1 on quarterly basis)'
    ],
    source: 'The Process, Section 3: The GIP Model & Quads'
  },

  'riskRange': {
    name: 'Risk Range',
    definition: 'Probable trading range for an asset based on the PVV model (Price, Volume, Volatility). Generated using fractional calculus to predict trading ranges.',
    components: [
      {
        name: 'LRR (Low Risk Range)',
        definition: 'Low-end of the risk range - when you buy/add positions',
        use: 'Entry zone for building positions'
      },
      {
        name: 'TRR (Top Risk Range)',
        definition: 'Top-end of the risk range - when you sell/trim positions',
        use: 'Exit zone for taking profits'
      },
      {
        name: 'HRR (High Risk Range)',
        definition: 'Daily high risk range values showing price action',
        use: 'Track higher highs (green) vs lower highs (red)'
      },
      {
        name: 'LRR Values',
        definition: 'Daily low risk range values showing price action',
        use: 'Track higher lows (green) vs lower lows (red)'
      },
      {
        name: 'ATH (All-Time High)',
        definition: 'All-time high price level',
        use: 'New ATHs shown in blue when HRR exceeds ATH'
      }
    ],
    interpretation: [
      'Buy/add near LRR when Trade and Trend signals are bullish',
      'Sell/trim near TRR to lock in gains',
      'Exit completely when both Trade and Trend signals break',
      'As volatility rises, risk ranges WIDEN',
      'Narrowing risk range = higher probability of getting trades right'
    ],
    source: 'The Process, Section 5: Risk Range Signals (The Core)'
  }
};

