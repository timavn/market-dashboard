const MODEL_VERSION = 'exposure-lab-ridge-v2';
const DEFAULT_REGRESSION_SESSIONS = 252;
const SAMPLE_SIZE_TIERS = Object.freeze([30, 60, 90, 120]);
const DEFAULT_MIN_OBSERVATIONS = SAMPLE_SIZE_TIERS[0];
const DEFAULT_SEASONED_OBSERVATIONS = SAMPLE_SIZE_TIERS.at(-1);
const DEFAULT_FACTOR_MIN_OBSERVATIONS = DEFAULT_SEASONED_OBSERVATIONS;
const DEFAULT_HALF_LIFE = 63;
const DEFAULT_RIDGE_LAMBDA = 0.1;
const DEFAULT_COVARIANCE_WINDOW = 90;
const DEFAULT_COVARIANCE_SHRINKAGE = 0.2;
const DEFAULT_CORRELATION_WINDOWS = Object.freeze([30, 90, 180]);

const FACTOR_DEFINITIONS = Object.freeze([
  Object.freeze({ id: 'market', label: 'Market', family: 'Market', longSymbol: 'SPY' }),
  Object.freeze({ id: 'sector-communication', label: 'Communication', family: 'Sector', longSymbol: 'XLC', shortSymbol: 'SPY' }),
  Object.freeze({ id: 'sector-consumer-discretionary', label: 'Consumer Disc.', family: 'Sector', longSymbol: 'XLY', shortSymbol: 'SPY' }),
  Object.freeze({ id: 'sector-consumer-staples', label: 'Consumer Staples', family: 'Sector', longSymbol: 'XLP', shortSymbol: 'SPY' }),
  Object.freeze({ id: 'sector-energy', label: 'Energy', family: 'Sector', longSymbol: 'XLE', shortSymbol: 'SPY' }),
  Object.freeze({ id: 'sector-financials', label: 'Financials', family: 'Sector', longSymbol: 'XLF', shortSymbol: 'SPY' }),
  Object.freeze({ id: 'sector-health-care', label: 'Health Care', family: 'Sector', longSymbol: 'XLV', shortSymbol: 'SPY' }),
  Object.freeze({ id: 'sector-industrials', label: 'Industrials', family: 'Sector', longSymbol: 'XLI', shortSymbol: 'SPY' }),
  Object.freeze({ id: 'sector-technology', label: 'Technology', family: 'Sector', longSymbol: 'XLK', shortSymbol: 'SPY' }),
  Object.freeze({ id: 'sector-materials', label: 'Materials', family: 'Sector', longSymbol: 'XLB', shortSymbol: 'SPY' }),
  Object.freeze({ id: 'sector-real-estate', label: 'Real Estate', family: 'Sector', longSymbol: 'XLRE', shortSymbol: 'SPY' }),
  Object.freeze({ id: 'sector-utilities', label: 'Utilities', family: 'Sector', longSymbol: 'XLU', shortSymbol: 'SPY' }),
  Object.freeze({ id: 'style-value', label: 'Value', family: 'Style', longSymbol: 'IWD', shortSymbol: 'IWF' }),
  Object.freeze({ id: 'style-momentum', label: 'Momentum', family: 'Style', longSymbol: 'MTUM', shortSymbol: 'SPY' }),
  Object.freeze({ id: 'style-quality', label: 'Quality', family: 'Style', longSymbol: 'QUAL', shortSymbol: 'SPY' }),
  Object.freeze({ id: 'style-size', label: 'Small vs Large', family: 'Style', longSymbol: 'IWM', shortSymbol: 'OEF' }),
  Object.freeze({ id: 'style-beta', label: 'High vs Low Beta', family: 'Style', longSymbol: 'SPHB', shortSymbol: 'SPLV' }),
  Object.freeze({ id: 'style-dividend', label: 'Dividend', family: 'Style', longSymbol: 'SDY', shortSymbol: 'SPY' }),
  Object.freeze({ id: 'style-secular-growth', label: 'Secular Growth', family: 'Style', longSymbol: 'QQQ', shortSymbol: 'SPY' }),
  Object.freeze({ id: 'macro-credit', label: 'Credit', family: 'Macro', longSymbol: 'HYG', shortSymbol: 'LQD' }),
  Object.freeze({ id: 'macro-duration', label: 'Duration', family: 'Macro', longSymbol: 'TLT', shortSymbol: 'SHY' }),
  Object.freeze({ id: 'macro-usd', label: 'USD', family: 'Macro', longSymbol: 'UUP' }),
  Object.freeze({ id: 'macro-commodities', label: 'Commodities', family: 'Macro', longSymbol: 'DBC' }),
  Object.freeze({ id: 'macro-gold', label: 'Gold', family: 'Macro', longSymbol: 'GLD' }),
  Object.freeze({ id: 'macro-em-fx', label: 'EM FX', family: 'Macro', longSymbol: 'CEW', shortSymbol: 'UUP' }),
]);

function factorFormula(definition = {}) {
  const longSymbol = String(definition.longSymbol || '').trim().toUpperCase();
  const shortSymbol = String(definition.shortSymbol || '').trim().toUpperCase();
  if (!longSymbol) return '';
  return shortSymbol ? `${longSymbol} - ${shortSymbol}` : longSymbol;
}

module.exports = {
  DEFAULT_CORRELATION_WINDOWS,
  DEFAULT_COVARIANCE_SHRINKAGE,
  DEFAULT_COVARIANCE_WINDOW,
  DEFAULT_FACTOR_MIN_OBSERVATIONS,
  DEFAULT_HALF_LIFE,
  DEFAULT_MIN_OBSERVATIONS,
  DEFAULT_REGRESSION_SESSIONS,
  DEFAULT_RIDGE_LAMBDA,
  DEFAULT_SEASONED_OBSERVATIONS,
  FACTOR_DEFINITIONS,
  MODEL_VERSION,
  SAMPLE_SIZE_TIERS,
  factorFormula,
};
