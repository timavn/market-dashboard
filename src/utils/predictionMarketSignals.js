import { SECURITIES_LIST } from '../constants/securitiesList';

export const PREDICTION_SIGNAL_UNIVERSE = [
  { symbol: 'BTC', label: 'Bitcoin', group: 'Crypto', categories: ['Crypto'] },
  { symbol: 'ETH', label: 'Ethereum', group: 'Crypto', categories: ['Crypto'] },
  { symbol: 'SOL', label: 'Solana', group: 'Crypto', categories: ['Crypto'] },
  { symbol: 'XRP', label: 'XRP', group: 'Crypto', categories: ['Crypto'] },

  { symbol: 'SPX', label: 'S&P 500', group: 'Index', categories: ['Index', 'Inflation', 'Labor', 'Growth'] },
  { symbol: 'COMPQ', label: 'Nasdaq', group: 'Index', categories: ['Index', 'Growth'] },
  { symbol: 'QQQ', label: 'Nasdaq 100', group: 'Index', categories: ['Index', 'Growth'] },
  { symbol: 'IWM', label: 'Russell 2000', group: 'Index', categories: ['Index', 'Growth'] },
  { symbol: 'VIX', label: 'Volatility', group: 'Index', categories: ['Index'] },

  { symbol: 'UST2Y', label: '2Y Yield', group: 'Rates', categories: ['Rates', 'Inflation', 'Growth'] },
  { symbol: 'UST10Y', label: '10Y Yield', group: 'Rates', categories: ['Rates', 'Inflation', 'Growth'] },
  { symbol: 'UST30Y', label: '30Y Yield', group: 'Rates', categories: ['Rates', 'Inflation', 'Growth'] },
  { symbol: 'TLT', label: '20Y Treasury', group: 'Rates', categories: ['Rates'] },
  { symbol: 'IEF', label: '7-10Y Treasury', group: 'Rates', categories: ['Rates'] },

  { symbol: 'GOLD', label: 'Gold', group: 'Commodities', categories: ['Commodities', 'Inflation'] },
  { symbol: 'SILVER', label: 'Silver', group: 'Commodities', categories: ['Commodities', 'Inflation'] },
  { symbol: 'WTIC', label: 'WTI Crude', group: 'Commodities', categories: ['Commodities', 'Inflation'] },
  { symbol: 'BRENT', label: 'Brent', group: 'Commodities', categories: ['Commodities', 'Inflation'] },
  { symbol: 'NATGAS', label: 'Nat Gas', group: 'Commodities', categories: ['Commodities', 'Inflation'] },
  { symbol: 'COPPER', label: 'Copper', group: 'Commodities', categories: ['Commodities', 'Growth'] },

  { symbol: 'USD', label: 'US Dollar', group: 'FX', categories: ['FX', 'Inflation', 'Rates'] },
  { symbol: 'DXY', label: 'DXY', group: 'FX', categories: ['FX', 'Inflation', 'Rates'] },
  { symbol: 'EUR/USD', label: 'EUR/USD', group: 'FX', categories: ['FX'] },
  { symbol: 'GBP/USD', label: 'GBP/USD', group: 'FX', categories: ['FX'] },
  { symbol: 'USD/YEN', label: 'USD/JPY', group: 'FX', categories: ['FX', 'Rates'] },
];

const CATEGORY_KEYWORDS = [
  { category: 'Crypto', pattern: /\b(bitcoin|btc|ether|ethereum|eth|solana|sol|xrp|crypto)\b/i },
  { category: 'Commodities', pattern: /\b(gold|silver|oil|crude|wti|brent|gas|natgas|copper|metal)\b/i },
  { category: 'Rates', pattern: /\b(rate|rates|yield|treasury|fed|fomc|cut|hike|10y|2y|30y)\b/i },
  { category: 'FX', pattern: /\b(dollar|dxy|euro|yen|pound|fx|currency|usd|eur|jpy|gbp)\b/i },
  { category: 'Index', pattern: /\b(s&p|spx|sp500|nasdaq|qqq|russell|equity|stocks|vix)\b/i },
];

const MACRO_CATEGORIES = new Set(['Inflation', 'Labor', 'Growth']);

const ASSET_CLASS_TO_GROUP = {
  fixedIncome: 'Rates',
  equity: 'Index',
  currency: 'FX',
  commodity: 'Commodities',
  crypto: 'Crypto',
};

/** Prefer universe symbol when risk-range DB key is an alias */
const RISK_RANGE_CANONICAL_SYMBOL = {
  BITCOIN: 'BTC',
  GLD: 'GOLD',
  USO: 'WTIC',
  OIL: 'WTIC',
  RUT: 'IWM',
  NDX: 'QQQ',
};

const UNIVERSE_BY_SYMBOL = Object.fromEntries(
  PREDICTION_SIGNAL_UNIVERSE.map(item => [item.symbol, item]),
);

export function getPredictionSignalTickers() {
  return PREDICTION_SIGNAL_UNIVERSE.map(item => item.symbol);
}

/**
 * Resolve display symbol for a risk-range key (dedupe aliases vs universe).
 * @param {string} symbol
 * @returns {string}
 */
export function canonicalizeRiskRangeSymbol(symbol) {
  const upper = String(symbol || '').toUpperCase();
  if (UNIVERSE_BY_SYMBOL[upper]) return upper;
  if (RISK_RANGE_CANONICAL_SYMBOL[upper]) return RISK_RANGE_CANONICAL_SYMBOL[upper];
  return upper;
}

/**
 * Union of prediction-signal universe + all risk-range tickers (deduped).
 * @param {Record<string, object>} [riskRanges]
 * @returns {string[]}
 */
export function collectMacroSignalSymbols(riskRanges = {}) {
  const symbols = new Set(getPredictionSignalTickers());
  Object.keys(riskRanges || {}).forEach(key => {
    symbols.add(canonicalizeRiskRangeSymbol(key));
  });
  return Array.from(symbols).sort((a, b) => a.localeCompare(b));
}

/** Tickers to request live quotes for (macro signal card). */
export function getMacroSignalQuoteTickers(riskRanges = {}) {
  return collectMacroSignalSymbols(riskRanges);
}

/** Index/ETF pairs where Hedgeye stores ranges under the index key but UI uses ETF symbol. */
const MACRO_QUOTE_INDEX_PAIRS = new Set(['RUT/IWM', 'IWM/RUT', 'NDX/QQQ', 'QQQ/NDX']);

/**
 * Resolve live quote symbol when risk range was stored under an alias key.
 * @param {string} displaySymbol - UI / universe symbol
 * @param {string|null} riskRangeSourceKey - DynamoDB key that matched
 * @returns {string}
 */
export function resolveMacroSignalQuoteSymbol(displaySymbol, riskRangeSourceKey) {
  const display = String(displaySymbol || '').toUpperCase();
  const source = String(riskRangeSourceKey || display).toUpperCase();
  if (source !== display && MACRO_QUOTE_INDEX_PAIRS.has(`${source}/${display}`)) {
    return source;
  }
  return display;
}

/**
 * Quote fetch plan: display symbol → quote symbol (deduped quote list).
 * @param {Record<string, object>} [riskRanges]
 * @returns {Array<{ display: string, quote: string }>}
 */
export function getMacroSignalQuotePlan(riskRanges = {}) {
  const symbols = collectMacroSignalSymbols(riskRanges);
  return symbols.map(display => {
    const { sourceKey } = pickRiskRange(riskRanges, display);
    return {
      display,
      quote: resolveMacroSignalQuoteSymbol(display, sourceKey),
    };
  });
}

/**
 * @param {string} symbol
 * @returns {{ symbol: string, label: string, group: string, categories: string[] } | null}
 */
export function inferSignalGroupFromTicker(symbol) {
  const upper = String(symbol || '').toUpperCase();
  if (!upper) return null;

  const universe = UNIVERSE_BY_SYMBOL[upper];
  if (universe) {
    return {
      symbol: universe.symbol,
      label: universe.label,
      group: universe.group,
      categories: [...universe.categories],
    };
  }

  const security = SECURITIES_LIST.find(s => s.ticker.toUpperCase() === upper);
  if (security) {
    let group = ASSET_CLASS_TO_GROUP[security.assetClass] || 'Index';
    if (security.assetClass === 'fixedIncome' && !/^UST\d+Y$/.test(upper)) {
      group = 'Credit';
    }
    return {
      symbol: security.ticker,
      label: security.name,
      group,
      categories: [group],
    };
  }

  if (/^UST\d+Y$/.test(upper)) {
    return { symbol: upper, label: `${upper.replace('UST', '')} Yield`, group: 'Rates', categories: ['Rates'] };
  }
  if (upper.includes('/')) {
    return { symbol: upper, label: upper, group: 'FX', categories: ['FX'] };
  }
  if (['BTC', 'ETH', 'SOL', 'XRP', 'BITCOIN'].includes(upper)) {
    return { symbol: upper, label: upper === 'BITCOIN' ? 'Bitcoin' : upper, group: 'Crypto', categories: ['Crypto'] };
  }

  return { symbol: upper, label: upper, group: 'Index', categories: ['Index'] };
}

export function inferPredictionSignalCategory(filter, selectedEvent) {
  if (filter && filter !== 'all') return filter;

  const text = [
    selectedEvent?.question,
    selectedEvent?.category,
    selectedEvent?.eventName,
    selectedEvent?.contractQuestion,
  ]
    .filter(Boolean)
    .join(' ');

  const match = CATEGORY_KEYWORDS.find(({ pattern }) => pattern.test(text));
  return match?.category || 'all';
}

export function normalizePredictionMarketSignals({
  riskRanges = {},
  bitcoinSnapshot = null,
  momoSnapshot = null,
  macroSnapshot = null,
  callSnapshot = null,
  spotPrices = {},
  activeCategory = 'all',
  selectedEvent = null,
} = {}) {
  const inferredCategory = inferPredictionSignalCategory(activeCategory, selectedEvent);
  const symbols = collectMacroSignalSymbols(riskRanges);
  const rows = symbols
    .map(sym => inferSignalGroupFromTicker(sym))
    .filter(item => item && isRelevantForCategory(item, inferredCategory))
    .map(item => {
      const { data: riskRange, sourceKey: riskRangeSourceKey } = pickRiskRange(riskRanges, item.symbol);
      return buildSignalRow({
      item,
      riskRange,
      riskRangeSourceKey,
      bitcoinSnapshot,
      momoSnapshot,
      macroSnapshot,
      callSnapshot,
      inferredCategory,
      spotPrices,
    });
    })
    .filter(row => {
      const inUniverse = Boolean(UNIVERSE_BY_SYMBOL[row.symbol]);
      const hasRange = row.lrr != null || row.hrr != null;
      return inUniverse || hasRange;
    })
    .sort(sortSignalRows);

  return {
    category: inferredCategory,
    rows,
    topRows: rows.slice(0, 8),
  };
}

function isRelevantForCategory(item, category) {
  if (!category || category === 'all') return true;
  if (MACRO_CATEGORIES.has(category)) {
    return item.categories.some(cat => cat === category || ['Index', 'Rates', 'Commodities', 'FX'].includes(cat));
  }
  return item.categories.includes(category) || item.group === category;
}

function buildSignalRow({
  item,
  riskRange,
  riskRangeSourceKey = null,
  bitcoinSnapshot,
  momoSnapshot,
  macroSnapshot,
  callSnapshot,
  inferredCategory,
  spotPrices = {},
}) {
  const trackerSlot = pickTrackerSlot(bitcoinSnapshot, item.symbol) || pickMomoSlot(momoSnapshot, item.symbol);
  const macroSide = pickMacroSide(macroSnapshot?.data, item.symbol);
  const callSide = pickMacroSide(callSnapshot?.data, item.symbol);
  const trackerTrend = normalizeTrend(trackerSlot?.trend);
  const riskTrend = normalizeTrend(riskRange?.trend);
  const primaryTrend = trackerTrend || riskTrend || macroSide || callSide || null;
  const sourceLabels = [];

  if (trackerSlot) sourceLabels.push(trackerSlot.sourceLabel);
  if (riskRange) sourceLabels.push('Risk Range');
  if (macroSide) sourceLabels.push('Macro Show');
  if (callSide) sourceLabels.push('The Call');

  const score =
    trendScore(primaryTrend) +
    (trackerSlot?.buyTrade != null || trackerSlot?.sellTrade != null ? 25 : 0) +
    (riskRange?.lrr != null || riskRange?.hrr != null ? 20 : 0) +
    (macroSide || callSide ? 15 : 0) +
    (item.categories.includes(inferredCategory) || item.group === inferredCategory ? 10 : 0);

  return {
    symbol: item.symbol,
    label: item.label,
    group: item.group,
    trend: primaryTrend,
    trackerTrend,
    riskTrend,
    macroSide,
    callSide,
    lrr: toNumber(riskRange?.lrr),
    hrr: toNumber(riskRange?.hrr),
    buyTrade: toNumber(trackerSlot?.buyTrade),
    sellTrade: toNumber(trackerSlot?.sellTrade),
    upside: toNumber(trackerSlot?.upside),
    downside: toNumber(trackerSlot?.downside),
    price: toNumber(trackerSlot?.price) ?? toNumber(spotPrices?.[item.symbol]?.price) ?? toNumber(spotPrices?.[item.symbol]),
    prevClose: toNumber(spotPrices?.[item.symbol]?.previousClose),
    quoteSource: spotPrices?.[item.symbol]?.source ?? null,
    date: riskRange?.date || bitcoinSnapshot?.date || momoSnapshot?.date || macroSnapshot?.date || callSnapshot?.date || null,
    sources: Array.from(new Set(sourceLabels)),
    score,
  };
}

function sortSignalRows(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  return a.symbol.localeCompare(b.symbol);
}

/** Hedgeye PDF tickers that differ from prediction-signal universe symbols */
const RISK_RANGE_SYMBOL_ALIASES = {
  BTC: ['BITCOIN'],
  BITCOIN: ['BTC'],
  GOLD: ['GLD'],
  GLD: ['GOLD'],
  WTIC: ['USO', 'OIL'],
  BRENT: ['USO'],
  OIL: ['USO', 'WTIC'],
  DXY: ['USD'],
  USD: ['DXY'],
  QQQ: ['NDX'],
  NDX: ['QQQ'],
  IWM: ['RUT'],
  RUT: ['IWM'],
};

/**
 * @returns {{ data: object|null, sourceKey: string|null }}
 */
function pickRiskRange(riskRanges, symbol) {
  if (!riskRanges || !symbol) return { data: null, sourceKey: null };
  const upper = String(symbol).toUpperCase();
  if (riskRanges[upper]) return { data: riskRanges[upper], sourceKey: upper };
  if (riskRanges[symbol]) return { data: riskRanges[symbol], sourceKey: symbol };
  for (const alt of RISK_RANGE_SYMBOL_ALIASES[upper] || []) {
    if (riskRanges[alt]) return { data: riskRanges[alt], sourceKey: alt };
  }
  return { data: null, sourceKey: null };
}

function pickTrackerSlot(snapshot, symbol) {
  const data = snapshot?.data || {};
  const slot = data.cryptos?.[symbol] || data.stocks?.[symbol] || null;
  if (!slot) return null;
  return { ...slot, sourceLabel: 'Bitcoin Tracker' };
}

function pickMomoSlot(snapshot, symbol) {
  const data = snapshot?.data || {};
  const stocks = data.stocks && typeof data.stocks === 'object' ? data.stocks : data;
  const slot = stocks?.[symbol] || null;
  if (!slot) return null;
  return { ...slot, sourceLabel: 'MOMO Tracker' };
}

function pickMacroSide(data, symbol) {
  if (!data) return null;
  if (arrayHasSymbol(data.longs || data.long, symbol)) return 'LONG';
  if (arrayHasSymbol(data.shorts || data.short, symbol)) return 'SHORT';
  if (arrayHasSymbol(data.neutrals || data.neutral, symbol)) return 'NEUTRAL';
  return null;
}

function arrayHasSymbol(values, symbol) {
  if (!Array.isArray(values)) return false;
  return values.some(value => {
    if (typeof value === 'string') return value.toUpperCase() === symbol;
    const ticker = value?.ticker || value?.symbol;
    return String(ticker || '').toUpperCase() === symbol;
  });
}

function normalizeTrend(value) {
  if (!value) return null;
  const upper = String(value).trim().toUpperCase();
  if (!upper || upper === 'N/A' || upper === '--') return null;
  if (upper === 'BULL') return 'BULLISH';
  if (upper === 'BEAR') return 'BEARISH';
  return upper;
}

function trendScore(trend) {
  if (!trend) return 0;
  if (['BULLISH', 'BEARISH', 'LONG', 'SHORT'].includes(trend)) return 60;
  if (trend === 'NEUTRAL') return 20;
  return 10;
}

function toNumber(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
