import { getProcessRule } from './processDocuments';

// Quick reference for the Securities Universe. Canonical process language is
// sourced from the shared rule registry; unresolved mechanisms remain labeled.

const tradeDurationRule = getProcessRule('signal.trade.duration');
const trendDurationRule = getProcessRule('signal.trend.duration');
const trendBreakRule = getProcessRule('lifecycle.trend_break_trade_holds');
const tradeBreakRule = getProcessRule('lifecycle.trade_break');
const longEntryRule = getProcessRule('entry.long.range_half');
const shortEntryRule = getProcessRule('entry.short.range_half');

export const METRIC_DEFINITIONS = {
  minMax: {
    name: 'MIN / MAX (% of NLV)',
    definition: 'Per-security planning limits using the Portfolio Review’s beta band and ATR risk cap, independent of whether published Trade and Trend are available.',
    calculation: 'Effective beta = clamp(|beta vs SPY|, 0.5, 2). MIN = 2% / effective beta, rounded up to 0.5 percentage points. MAX = the smaller of 6% / effective beta and 0.50% / (2 × ATR14 / closing price), rounded down to 0.5 percentage points.',
    interpretation: [
      'Uses up to 252 aligned daily returns, with at least 126 required for beta, and 14 completed sessions for ATR.',
      'The date is the last completed daily bar. A missing input remains a verification gap.',
      'If MAX is below MIN, the risk cap leaves no positive sizing target.',
      'Trade/Trend, entry rules, and verified live holdings still determine whether an adjustment is eligible.'
    ],
    source: 'Site Position Sizing v1.1; sourced adjusted daily history from Yahoo Finance chart API'
  },
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
        duration: `${tradeDurationRule.parameters.maximumDurationWeeks} weeks or less`,
        use: 'Published tracker direction; used for entries and terminal exits'
      },
      {
        name: 'Trend',
        duration: `${trendDurationRule.parameters.minimumDurationMonths} months or more`,
        use: 'Published risk-range direction; used for intermediate-cycle position management'
      },
      {
        name: 'Tail',
        duration: '3 years or less (research convention)',
        use: 'Research-only until its exact measurement and decision authority are approved'
      }
    ],
    interpretation: [
      'Aligned bullish Trade and Trend: long eligibility, subject to the bottom-half entry rule',
      'Aligned bearish Trade and Trend: short eligibility, subject to the top-half entry rule',
      trendBreakRule.statement,
      tradeBreakRule.statement,
      'A missing Trade or Trend remains unknown and prevents executable output'
    ],
    source: 'The Process v0.1 and Position Sizing v1.1'
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
      'Quad 1 ranking: Best assets for Quad 1 regime (Growth Accelerating, Inflation Decelerating)',
      'Quad 2 ranking: Best assets for Quad 2 regime (Growth Accelerating, Inflation Accelerating)',
      'Quad 3 ranking: Best assets for Quad 3 regime (Growth Decelerating, Inflation Accelerating)',
      'Quad 4 ranking: Best assets for Quad 4 regime (Growth Decelerating, Inflation Decelerating)',
      'Best Quad Counts: Those that actually progress (e.g., 3-2-1 on quarterly basis)'
    ],
    source: 'The Process, Section 3: The GIP Model & Quads'
  },

  'atr': {
    name: 'ATR (Average True Range)',
    definition: 'The 14-day moving average of True Range. True Range is the greatest of: (1) Current High minus Current Low, (2) |Current High minus Previous Close|, (3) |Current Low minus Previous Close|. The ATR % shows ATR as a percentage of the current price.',
    range: 'ATR % < 2% = low volatility (green), 2-5% = moderate (yellow), > 5% = high volatility (red)',
    interpretation: [
      'Position Sizing v1.1 applies ATR as a maximum-position backstop after the beta-derived band',
      'The current risk budget is 0.50% of NLV at a two-ATR adverse distance',
      'If the ATR maximum falls below MIN, the security has no positive sizing target',
      'Hard-stop placement and trailing behavior remain unresolved pending a canonical technical note'
    ],
    source: 'Position Sizing v1.1; hard-stop policy remains research-only',
    calculation: 'ATR = SMA(14, True Range); ATR % = ATR / Close × 100'
  },

  'riskRange': {
    name: 'Risk Range',
    definition: 'Probable trading range for an asset based on the PVV model (Price, Volume, Volatility). Generated using fractional calculus to predict trading ranges.',
    components: [
      {
        name: 'LRR (Low Risk Range)',
        definition: 'The published low endpoint of the current risk range',
        use: 'Defines the lower boundary and contributes to long/short structure'
      },
      {
        name: 'HRR (High Risk Range)',
        definition: 'The published high endpoint of the current risk range',
        use: 'Defines the upper boundary and contributes to long/short structure'
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
      longEntryRule.statement,
      shortEntryRule.statement,
      trendBreakRule.statement,
      tradeBreakRule.statement,
      'A wrong-half or out-of-range price remains visible but cannot authorize an open or add'
    ],
    source: 'The Process v0.1 and Position Sizing v1.1'
  }
};
