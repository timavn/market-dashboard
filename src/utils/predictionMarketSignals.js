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

export function getPredictionSignalTickers() {
  return PREDICTION_SIGNAL_UNIVERSE.map(item => item.symbol);
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
  activeCategory = 'all',
  selectedEvent = null,
} = {}) {
  const inferredCategory = inferPredictionSignalCategory(activeCategory, selectedEvent);
  const rows = PREDICTION_SIGNAL_UNIVERSE
    .filter(item => isRelevantForCategory(item, inferredCategory))
    .map(item => buildSignalRow({
      item,
      riskRange: pickRiskRange(riskRanges, item.symbol),
      bitcoinSnapshot,
      momoSnapshot,
      macroSnapshot,
      callSnapshot,
      inferredCategory,
    }))
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
  bitcoinSnapshot,
  momoSnapshot,
  macroSnapshot,
  callSnapshot,
  inferredCategory,
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
    price: toNumber(trackerSlot?.price),
    date: riskRange?.date || bitcoinSnapshot?.date || momoSnapshot?.date || macroSnapshot?.date || callSnapshot?.date || null,
    sources: Array.from(new Set(sourceLabels)),
    score,
  };
}

function sortSignalRows(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  return a.symbol.localeCompare(b.symbol);
}

function pickRiskRange(riskRanges, symbol) {
  return riskRanges?.[symbol] || riskRanges?.[symbol.toUpperCase()] || null;
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
