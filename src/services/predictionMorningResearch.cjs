// What this morning's Hedgeye products say about each tracked Kalshi market:
// Alpha Codes (TRADE/TREND signal levels), single TRADE or TREND levels, Risk
// Ranges and TRADE/TREND directions written in the prose, published positions,
// and the structured ranges some products carry. Every finding keeps the
// sentence it came from. Nothing is inferred from quotes or models: a level is
// kept only when the publication prints it for that market's own instrument,
// and shorthand (81/75, 8183) is expanded only when exactly one scale puts it
// near the market's live reference price.

const PRODUCTS = [
  { key: 'top-3-things', label: 'Top 3 Things' },
  { key: 'early-look', label: 'Early Look' },
  { key: 'the-macro-show', label: 'The Macro Show' },
  { key: 'the-call', label: 'The Call' },
  { key: 'real-time-alert', label: 'Real-Time Alerts' },
  { key: 'etf-pro', label: 'ETF Pro' },
  { key: 'crypto-quant', label: 'Crypto Quant' },
  { key: 'market-structure', label: 'Market Structure' },
  { key: 'risk-ranges', label: 'Risk Ranges' },
];
// Keith's own morning notes outrank show summaries ("enhanced by AI") when two
// products print different Alpha Codes for the same market.
const PRIORITY = Object.fromEntries(PRODUCTS.map((product, index) => [product.key, index]));
const LABELS = Object.fromEntries(PRODUCTS.map((product) => [product.key, product.label]));

// Each tracked market's names in Hedgeye prose. `instrument` is the price the
// levels refer to; a related instrument (Nasdaq Composite) is checked against
// its own reference and labelled, never presented as the Kalshi underlying.
const MARKETS = {
  gold: { names: ['Gold', 'XAU', 'XAUUSD', 'Gold Spot Price'], instrument: 'gold' },
  silver: { names: ['Silver', 'XAG', 'XAGUSD', 'Silver Spot Price'], instrument: 'silver' },
  copper: { names: ['Copper', 'Dr\\. Copper', 'Copper Spot Price'], instrument: 'copper' },
  wti: { names: ['WTI', 'WTIC', 'Crude Oil', 'Crude', 'Oil'], instrument: 'wti' },
  bitcoin: { names: ['Bitcoin', 'BTC', '₿TC', 'BTC-USD', 'BTCUSD'], instrument: 'bitcoin' },
  ethereum: { names: ['Ethereum', 'Ether', 'ETH', 'ETH-USD', 'ETHUSD'], instrument: 'ethereum' },
  sp500: { names: ['SPX', 'S&P 500', 'S&P500', 'SP500', 'S&P'], instrument: 'sp500' },
  nasdaq100: { names: ['NDX', 'Nasdaq-100', 'Nasdaq 100', 'NASDAQ-100'], instrument: 'nasdaq100' },
  ust2y: { names: ['UST 2yr', 'UST 2-year', 'UST2Y', '2yr', '2-year', 'two-year', '2-Year Treasury'], instrument: 'ust2y', yield: true },
  ust10y: { names: ['UST 10yr', 'UST 10-year', 'UST10Y', '10yr', '10-year', 'ten-year', '10-Year Treasury'], instrument: 'ust10y', yield: true },
  ust30y: { names: ['UST 30yr', 'UST 30-year', 'UST30Y', '30yr', '30-year', 'thirty-year', 'Long Bond'], instrument: 'ust30y', yield: true },
  usd: { names: ['US Dollar Index', 'U\\.S\\. Dollar Index', 'US Dollar', 'U\\.S\\. Dollar', 'USD', 'DXY', 'Dollar'], instrument: 'usd' },
};
const RELATED = {
  COMPQ: { market: 'nasdaq100', names: ['COMPQ', 'Nasdaq Composite', 'Nasdaq'], instrument: 'compq', label: 'Nasdaq Composite' },
};
// ETFs that track a market. Their levels are in ETF dollars, so they are kept
// with the ticker and never compared with the market's own price.
const PROXIES = {
  GLD: 'gold', IAU: 'gold', SLV: 'silver', CPER: 'copper', USO: 'wti', IBIT: 'bitcoin', BITO: 'bitcoin',
  ETHA: 'ethereum', ETHE: 'ethereum', SPY: 'sp500', QQQ: 'nasdaq100', SHY: 'ust2y', IEF: 'ust10y', TLT: 'ust30y', UUP: 'usd',
};
// Price-ETF positions move opposite to the yield the market settles on.
const INVERSE_PROXIES = new Set(['SHY', 'IEF', 'TLT']);
// Named instruments that end the previous market's scope in a sentence.
const OTHER_NAMES = ['Brent', 'BNO', 'KOSPI', 'Nikkei', 'VIX', 'VXN', 'MOVE', 'Russell', 'IWM', 'RUT', 'Natural Gas', 'NATGAS',
  'UNG', 'Yen', 'Euro', 'Pound', 'Swiss', 'Semis', 'Semiconductors', 'Software', 'Shipping', 'Gold Miners', 'Silver Miners',
  'Copper Miners', 'Oil Services', 'Refiners', 'Treasury Yield', 'Treasury Yields', 'Bond Yields', 'Yield Curve', 'curve', 'HYG', 'LQD',
  'PFIX'];
// Capitalised words that are vocabulary, not instruments.
const CAPS_VOCABULARY = new Set(['TRADE', 'TREND', 'LRR', 'TRR', 'HRR', 'ATH', 'ATHS', 'AI', 'US', 'ETF', 'ETFS', 'EDT', 'EST', 'PDT',
  'PST', 'ET', 'PT', 'PM', 'AM', 'KM', 'MIN', 'MINS', 'MAX', 'BPS', 'BP', 'YOY', 'EPS', 'HAM', 'PMS', 'MOAB', 'BLH', 'BLHS', 'CEO',
  'TL', 'DR', 'I', 'A', 'OK', 'TV', 'VIEW', 'LINK', 'CPI', 'PCE', 'GDP', 'FOMC', 'FED', 'BLS', 'QE', 'QT', 'RE', 'NOT', 'AND',
  'THE', 'OF', 'IN', 'ON', 'TO', 'IS', 'IT', 'AT', 'OR', 'NO', 'SO', 'ALL', 'NEW', 'BUY', 'SELL', 'LONG', 'SHORT', 'WAIT', 'HOLD',
  'SIGNAL', 'SIGNALS', 'RISK', 'RANGE', 'UPDATE', 'NOW', 'MY', 'WE', 'OUR', 'UST', 'YIELD', 'YIELDS']);

const NUMBER = String.raw`\$?\s?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:\s?[kK]\b)?%?`;
const LEVEL_WORDS = String.raw`(?:immediate-term\s+|intermediate-term\s+|@Hedgeye\s+)?`;
const LABEL_AFTER = new RegExp(String.raw`\b(TRADE|TREND)\b(?:\s+(?:Momentum|Signal|Support|Supports|Resistance|Level|Levels|level|line|reference|threshold))*` +
  String.raw`\s*(?:(?:=|:|is|was|of|at|near|around|approximately|roughly|cited|now|down|all|the|way|remains|remained|sits|stays|still|currently|substantially|lower|higher)\s*)*(?<number>${NUMBER})`, 'gi');
// "TRADE and TREND at $83": both levels at one price.
const LABEL_BOTH = new RegExp(String.raw`\bTRADE\s+and\s+TREND\s*(?:=|at|are|of|both\s+at)\s*(?<number>${NUMBER})`, 'gi');
const LABEL_BEFORE = new RegExp(String.raw`(?<number>${NUMBER})(?:\s+(?:WTI|BTC|Bitcoin|Gold|Silver|Copper|SPX))?` +
  String.raw`(?:\s+(?:identified|cited|given))?(?:\s*=\s*|\s+(?:as|on)\s+|\s+)(?:the\s+)?${LEVEL_WORDS}(TRADE|TREND)\b(?!\s+(?:breakout|breakdown))`, 'gi');
const LABELED_PAIR = new RegExp(String.raw`\b(TRADE|TREND)\s*/\s*(TRADE|TREND)\b(?:\s+(?:reference|signal|support|supports|levels?|reading))*` +
  String.raw`\s*(?:were|are|is|was|=|:|of|at)?\s*(?:approximately\s+|roughly\s+|around\s+)?(?<a>${NUMBER})\s*/\s*(?<b>${NUMBER})`, 'gi');
const ALPHA = /\balpha\s+codes?\b/i;
const ALPHA_VALUE = new RegExp(String.raw`^\s*(?:for\s+\S+\s+)?(?:\(|=|:|is|was|of|now|remains|this\s+morning|given\s+as|discussed\s+around|` +
  String.raw`approximately|roughly|around|an?|\s)*?(?:(?<a>${NUMBER})\s*/\s*(?<b>${NUMBER})|(?<run>\d{4,10})\b(?![.,]\d))`, 'i');
const RANGE = new RegExp(String.raw`(?<a>${NUMBER})\s*(?:[-–]|to)\s*(?<b>${NUMBER})`, 'i');
const RISK_RANGE = new RegExp(String.raw`risk\s+range(?:™|\(tm\))?(?:\s+signal)?\s*(?:=|:|is|was|of|at)?\s*(?<a>${NUMBER})\s*[-–]\s*(?<b>${NUMBER})`, 'i');
const RANGE_THEN_LABEL = new RegExp(String.raw`(?<a>${NUMBER})\s*(?:[-–]|to)\s*(?<b>${NUMBER})\s+risk\s+range`, 'i');
const DIRECTION = /\b(bullish|bearish|neutral)\s+(?:on\s+both\s+(trade)\s+and\s+(trend)|(trade|trend)(?:\s*(?:and|&|\/)\s*(trade|trend))?)\b/gi;
const BROKE = new RegExp(String.raw`\b(?:broke|broken|breaking|lost|failed\s+at)\s+(?:its\s+|my\s+|our\s+|the\s+)?${LEVEL_WORDS}(TRADE|TREND)\b`, 'gi');
const HISTORICAL = /\b(?:previous|prior|former(?:ly)?|old|last\s+(?:week|month|year)|used\s+to\s+be|was\s+originally)\b/i;
const HYPOTHETICAL = /\b(?:hypothetical(?:ly)?|would\s+need\s+to|if\s+it\s+(?:broke|breaks))\b/i;
const APPROXIMATE = /\b(?:approximately|approx|roughly|around|about|near)\b|~|≈/i;

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const nameEntries = [
  ...Object.entries(MARKETS).flatMap(([market, spec]) => spec.names.map((name) => ({ name, market, instrument: spec.instrument, fit: 'exact' }))),
  ...Object.entries(RELATED).flatMap(([ticker, spec]) => spec.names.map((name) => ({ name, market: spec.market, instrument: spec.instrument,
    fit: 'related', label: spec.label, ticker }))),
  ...Object.entries(PROXIES).map(([ticker, market]) => ({ name: ticker, market, instrument: ticker, fit: 'proxy', ticker, caseSensitive: true })),
  ...OTHER_NAMES.map((name) => ({ name, market: null })),
].sort((left, right) => right.name.replace(/\\/g, '').length - left.name.replace(/\\/g, '').length);
const MENTION = new RegExp(String.raw`(?<![\w$])(?:${nameEntries.map((entry) => entry.name.includes('\\') ? entry.name : escape(entry.name)).join('|')})(?![\w])`, 'gi');
const lookup = new Map(nameEntries.map((entry) => [entry.name.replace(/\\/g, '').toLowerCase(), entry]));
const CAPS = /(?<![\w$#@])\(?([A-Z][A-Z0-9]{1,5})\)?(?![\w])/g;

/** Instrument and non-instrument mentions in one statement, in order. */
function mentions(statement) {
  const found = [];
  for (const match of statement.matchAll(MENTION)) {
    const entry = lookup.get(match[0].toLowerCase());
    if (!entry) continue;
    if (entry.caseSensitive && match[0] !== entry.name) continue;
    const before = statement.slice(Math.max(0, match.index - 16), match.index);
    const after = statement.slice(match.index + match[0].length, match.index + match[0].length + 24);
    // Brent Oil, Oil Services and Gold Miners are other instruments; GBP/USD and USD/YEN are currency pairs.
    if (entry.market === 'wti' && /^oil$/i.test(match[0]) && (/brent\s*$/i.test(before) || /^\s*(?:services|refiners|stocks|equities|majors|&|and\s+gas)/i.test(after))) {
      found.push({ index: match.index, end: match.index + match[0].length, market: null, text: match[0] });
      continue;
    }
    if (['gold', 'silver', 'copper'].includes(entry.market) && /^\s*miners?\b/i.test(after)) {
      found.push({ index: match.index, end: match.index + match[0].length, market: null, text: match[0] });
      continue;
    }
    if (entry.market === 'usd' && (/\/\s*$/.test(before) || /^\s*\//.test(after))) {
      found.push({ index: match.index, end: match.index + match[0].length, market: null, text: match[0] });
      continue;
    }
    if (entry.market === 'sp500' && (/equal[\s-]weight\s*$/i.test(before) || /^\s*(?:500\s+)?equal[\s-]weight/i.test(after))) {
      found.push({ index: match.index, end: match.index + match[0].length, market: null, text: match[0] });
      continue;
    }
    // "2-year high" and "10-year view" are durations, not Treasuries.
    if (entry.fit === 'exact' && /^(?:2|10|30|two|ten|thirty)-year$/i.test(match[0]) && !/^\s*(?:U\.?S\.?\s+)?(?:treasury|yield|bond|note)/i.test(after)
      && !/(?:UST|treasury|the)\s*$/i.test(before)) {
      continue;
    }
    found.push({ index: match.index, end: match.index + match[0].length, ...entry, text: match[0] });
  }
  for (const match of statement.matchAll(CAPS)) {
    const word = match[1];
    if (CAPS_VOCABULARY.has(word) || lookup.has(word.toLowerCase()) || /^\d/.test(word)) continue;
    if (found.some((item) => match.index >= item.index && match.index < item.end)) continue;
    found.push({ index: match.index, end: match.index + match[0].length, market: null, text: word });
  }
  return found.sort((left, right) => left.index - right.index);
}

function parseNumber(text) {
  const raw = String(text || '');
  const thousands = /\d\s?[kK]\b/.test(raw);
  const digits = raw.replace(/[\s$,%kK]/g, '');
  const value = Number(digits);
  if (!Number.isFinite(value) || value <= 0) return null;
  return { value: thousands ? value * 1000 : value, percent: raw.includes('%'), full: thousands || raw.includes(',') || raw.includes('$')
    || raw.includes('.') || raw.includes('%') || digits.length >= 3 };
}

/**
 * Expand a printed level against the instrument's reference price. Explicit
 * full numbers are kept as printed; shorthand needs exactly one fitting scale.
 */
function resolveLevel(parsed, reference, { isYield }) {
  if (!parsed) return null;
  if (isYield) {
    const value = parsed.value;
    if (!(value > 0 && value < 25)) return null;
    return reference === null || Math.abs(value - reference) <= 1.25 ? value : null;
  }
  if (parsed.percent) return null;
  if (reference === null) return parsed.full ? parsed.value : null;
  const fits = (value) => value >= reference * 0.75 && value <= reference * 1.25;
  if (parsed.full && fits(parsed.value)) return parsed.value;
  const scales = [1, 10, 100, 1000].map((scale) => parsed.value * scale).filter(fits);
  return scales.length === 1 ? scales[0] : null;
}

/** Split a run-together Alpha Code (8183, 43554204) into its two halves. */
function splitRun(run) {
  if (run.length % 2) return null;
  const half = run.length / 2;
  return [run.slice(0, half), run.slice(half)];
}

/** Sentences and lines, keeping U.S. and decimals intact. */
function statements(text) {
  return String(text || '')
    .replace(/\r/g, '')
    .split(/\n+|(?<=[a-z0-9%)\]"'’]\.|[!?])\s+(?=[A-Z•(@#])|\s+•\s+/)
    .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim())
    .filter((line) => line.length > 2);
}

const excerptOf = (statement) => (statement.length > 320 ? `${statement.slice(0, 317)}…` : statement);
const titleCase = (word) => word ? word[0].toUpperCase() + word.slice(1).toLowerCase() : word;

/**
 * Findings for every tracked market in one product's text.
 * references: { [instrument]: number } live prices (yields in percent).
 */
function extractFromText(text, { product, references = {} } = {}) {
  const findings = [];
  const lines = statements(text);
  let carry = null;
  let rosterUntil = -1;
  lines.forEach((statement, lineIndex) => {
    // "The Code = TRADE first, then TREND …" or "this morning's Alpha Codes" opens a roster of "SPX = 7651/7501" lines.
    if (/\bTRADE\s+first\b|\balpha\s+codes\b/i.test(statement)) rosterUntil = lineIndex + 12;
    const found = mentions(statement);
    const tracked = found.filter((item) => item.market);
    // A statement that prints levels without naming the market continues the
    // previous statement's only market ("…as trade support and … as trend support").
    const scopes = [];
    const opening = found.length ? statement.slice(0, found[0].index) : statement;
    if (carry && /\b(?:trade|trend|alpha\s+codes?)\b/i.test(opening)) {
      scopes.push({ ...carry, start: 0, end: opening.length, prefix: '' });
    }
    found.forEach((item, index) => {
      // A repeated name ("Oil … WTI") continues the scope its first mention opened.
      const previous = found[index - 1];
      if (!item.market || (previous && previous.market === item.market && previous.instrument === item.instrument)) return;
      const next = found.slice(index + 1).find((other) => other.market !== item.market || other.instrument !== item.instrument);
      scopes.push({ ...item, start: item.end, end: next ? next.index : statement.length,
        prefix: statement.slice(Math.max(0, item.index - 30), item.index) });
    });
    const distinct = [...new Set(tracked.map((item) => `${item.market}:${item.instrument}`))];
    // Carry reaches only the next statement.
    carry = distinct.length === 1 && found[found.length - 1]?.market ? found[found.length - 1] : null;
    for (const scope of scopes) {
      const body = statement.slice(scope.start, scope.end);
      const spec = MARKETS[scope.market] || {};
      const isYield = Boolean(spec.yield) && scope.fit !== 'proxy';
      const reference = Number.isFinite(references[scope.instrument]) ? references[scope.instrument] : null;
      // An ETF's levels are checked against that ETF's own price; without one they are not kept.
      const level = (raw) => scope.fit === 'proxy' && reference === null ? null
        : resolveLevel(parseNumber(raw), reference, { isYield });
      const base = { market: scope.market, fit: scope.fit, instrument: scope.fit === 'exact' ? null : (scope.ticker || scope.instrument),
        instrumentLabel: scope.label || (scope.fit === 'proxy' ? scope.ticker : null), product, excerpt: excerptOf(statement) };
      // Qualifiers may precede the market's name ("Last week the Gold Alpha Code …"), so read the statement around the match.
      const clean = (start, end) => {
        const at = scope.start + start;
        const clause = Math.max(...[';', '. ', '!', '?'].map((mark) => statement.lastIndexOf(mark, at - 1) + 1));
        const from = Math.max(clause, at - 60);
        const after = statement.slice(scope.start + end, scope.start + end + 40).split(/[;!?]|\.\s/)[0];
        return !HISTORICAL.test(statement.slice(from, scope.start + end) + after)
          && !HYPOTHETICAL.test(statement.slice(from, scope.start + end));
      };
      const approximate = (start, end) => APPROXIMATE.test(body.slice(Math.max(0, start - 30), end))
        || APPROXIMATE.test(scope.prefix.slice(-20));

      // Labelled TRADE and TREND levels in this scope.
      const labelled = [];
      for (const pattern of [LABEL_AFTER, LABEL_BEFORE]) {
        for (const match of body.matchAll(pattern)) {
          // The named number group is numbered too: the label is group 1 after, group 2 before.
          const kind = (pattern === LABEL_AFTER ? match[1] : match[2]).toLowerCase();
          const value = level(match.groups.number);
          if (value === null || !clean(match.index, match.index + match[0].length)) continue;
          const numberAt = match.index + match[0].indexOf(match.groups.number.trim());
          if (labelled.some((item) => item.numberAt === numberAt)) continue;
          labelled.push({ kind, value, numberAt, start: match.index, end: match.index + match[0].length });
        }
      }
      let pair = null;
      for (const match of body.matchAll(LABEL_BOTH)) {
        const value = level(match.groups.number);
        if (value !== null && clean(match.index, match.index + match[0].length)) {
          pair = { trade: value, trend: value, explicit: false, approximate: approximate(match.index, match.index + match[0].length) };
          break;
        }
      }
      for (const match of body.matchAll(LABELED_PAIR)) {
        if (match[1].toLowerCase() === match[2].toLowerCase()) continue;
        const values = { [match[1].toLowerCase()]: level(match.groups.a), [match[2].toLowerCase()]: level(match.groups.b) };
        if (values.trade !== null && values.trend !== null && clean(match.index, match.index + match[0].length)) {
          pair = { trade: values.trade, trend: values.trend, explicit: false, approximate: approximate(match.index, match.index + match[0].length) };
          break;
        }
      }
      // An Alpha Code printed as A/B or run together (8183), after the phrase
      // or with the phrase just before the market's name ("Alpha Code for QQQ = …").
      const alphaAt = body.search(ALPHA);
      const alphaBefore = ALPHA.test(scope.prefix.slice(-24)) && /alpha\s+codes?\s*(?:for|of)?\s*$/i.test(scope.prefix);
      const roster = lineIndex <= rosterUntil && /^\s*(?:’s|'s)?\s*(?:Yield\s*)?(?:=|:)\s*/.test(body);
      if (alphaAt >= 0 || alphaBefore || roster) {
        const tail = alphaAt >= 0 ? body.slice(alphaAt).replace(ALPHA, '') : body;
        const match = tail.match(ALPHA_VALUE);
        if (match && clean(alphaAt >= 0 ? alphaAt : 0, (alphaAt >= 0 ? alphaAt : 0) + match[0].length + 20)) {
          const [rawTrade, rawTrend] = match.groups.run ? splitRun(match.groups.run) || [] : [match.groups.a, match.groups.b];
          const trade = rawTrade ? level(rawTrade) : null;
          const trend = rawTrend ? level(rawTrend) : null;
          if (trade !== null && trend !== null) {
            pair = { trade, trend, explicit: true,
              approximate: APPROXIMATE.test(match[0]) || APPROXIMATE.test(body.slice(Math.max(0, alphaAt - 30), Math.max(0, alphaAt))) };
          }
        }
      }
      // Printed TRADE and TREND values beside a shorthand code are its expansion.
      const trades = [...new Set(labelled.filter((item) => item.kind === 'trade').map((item) => item.value))];
      const trends = [...new Set(labelled.filter((item) => item.kind === 'trend').map((item) => item.value))];
      if (trades.length === 1 && trends.length === 1) {
        const first = labelled.find((item) => item.kind === 'trade');
        const expanded = { trade: trades[0], trend: trends[0], approximate: approximate(first.start, first.end) };
        pair = pair ? { ...pair, ...expanded, approximate: pair.approximate || expanded.approximate } : { ...expanded, explicit: false };
      }
      if (pair) {
        findings.push({ ...base, kind: 'alphaCode', trade: pair.trade, trend: pair.trend, explicit: pair.explicit, approximate: pair.approximate,
          unit: isYield ? '%' : null });
      } else {
        for (const item of labelled) {
          if (findings.some((other) => other.kind === 'alphaCode' && other.market === scope.market && other.instrument === base.instrument
            && other[item.kind] === item.value)) continue;
          findings.push({ ...base, kind: item.kind === 'trade' ? 'tradeLevel' : 'trendLevel', level: item.value,
            approximate: approximate(item.start, item.end), unit: isYield ? '%' : null });
        }
      }

      // Risk Ranges written in the prose ("Risk Range™ Signal = 4229-4399", "SP500 = 7652-7850").
      if (scope.fit !== 'proxy') {
        const inRiskContext = /risk\s+ranges?/i.test(statement);
        const range = body.match(RISK_RANGE) || body.match(RANGE_THEN_LABEL)
          || (inRiskContext && /^\s*(?:’s|'s)?\s*(?:Yield\s*)?(?:=|:)\s*/.test(body) ? body.match(RANGE) : null);
        if (range) {
          const low = level(range.groups.a);
          const high = level(range.groups.b);
          if (low !== null && high !== null && low < high && clean(range.index, range.index + range[0].length)) {
            findings.push({ ...base, kind: 'riskRange', low, high, unit: isYield ? '%' : null });
          }
        }
      }

      // TRADE/TREND directions stated for this market.
      const directions = {};
      for (const match of body.matchAll(DIRECTION)) {
        if (!clean(match.index, match.index + match[0].length)) continue;
        const word = titleCase(match[1]);
        for (const key of [match[2], match[3], match[4], match[5]].filter(Boolean)) directions[key.toLowerCase()] ||= word;
      }
      for (const match of body.matchAll(BROKE)) {
        if (clean(match.index, match.index + match[0].length)) directions[match[1].toLowerCase()] ||= 'Bearish';
      }
      if (directions.trade || directions.trend) {
        const inverse = scope.fit === 'proxy' && INVERSE_PROXIES.has(scope.ticker);
        const flip = (word) => (inverse ? { Bullish: 'Bearish', Bearish: 'Bullish' }[word] || word : word);
        findings.push({ ...base, kind: 'signal', trade: flip(directions.trade) || null, trend: flip(directions.trend) || null });
      }
    }
    // "Both are Bullish TRADE and TREND" after two markets applies to each.
    const both = statement.match(/\bboth\s+(?:are|remain|signal(?:ing)?)\s+(bullish|bearish)\s+trade\s+and\s+trend\b/i);
    if (both && distinct.length >= 2) {
      const before = [...new Set(tracked.filter((item) => item.index < both.index).map((item) => `${item.market}:${item.instrument}`))];
      for (const key of before.slice(-2)) {
        const [market, instrument] = key.split(':');
        const item = tracked.find((entry) => entry.market === market && entry.instrument === instrument);
        if (item.fit === 'proxy' || findings.some((finding) => finding.kind === 'signal' && finding.market === market && finding.excerpt === excerptOf(statement))) continue;
        findings.push({ market, fit: item.fit, instrument: item.fit === 'exact' ? null : (item.ticker || item.instrument),
          instrumentLabel: item.label || null, product, excerpt: excerptOf(statement), kind: 'signal',
          trade: titleCase(both[1]), trend: titleCase(both[1]) });
      }
    }
  });
  return findings;
}

/** Map a published position name ("Bitcoin (BTC)", "QQQ") to a tracked market; anything else named in it disqualifies it. */
function positionMarket(name) {
  const text = String(name || '').trim();
  const ticker = (text.match(/\(([A-Z0-9/.-]{1,10})\)\s*$/) || [])[1] || (/^[A-Z0-9.-]{1,6}$/.test(text) ? text : null);
  if (ticker && PROXIES[ticker]) return { market: PROXIES[ticker], fit: 'proxy', instrument: ticker, inverse: INVERSE_PROXIES.has(ticker) };
  const found = mentions(text);
  const markets = new Set(found.map((item) => item.market));
  if (markets.size !== 1 || markets.has(null) || found[0].fit === 'proxy') return null;
  return { market: found[0].market, fit: found[0].fit, instrument: found[0].fit === 'exact' ? null : found[0].ticker, inverse: false };
}

const SIDE = { long: 'Long', longs: 'Long', short: 'Short', shorts: 'Short', neutral: 'Neutral', neutrals: 'Neutral' };

function positionFindings(snapshot, product) {
  const data = snapshot?.data || {};
  const findings = [];
  const add = (name, side, extra = {}) => {
    const hit = positionMarket(name);
    if (!hit || !side) return;
    findings.push({ market: hit.market, fit: hit.fit, instrument: hit.instrument, instrumentLabel: hit.fit === 'proxy' ? hit.instrument : null,
      product, kind: 'position', side, inverse: hit.inverse, name: String(name), ...extra });
  };
  if (product === 'the-macro-show' || product === 'the-call') {
    for (const key of ['longs', 'shorts', 'neutrals']) {
      for (const name of Array.isArray(data[key]) ? data[key] : []) add(typeof name === 'string' ? name : name?.ticker || name?.name, SIDE[key]);
    }
  }
  if (product === 'etf-pro') {
    for (const change of Array.isArray(data.changes) ? data.changes : []) {
      add(change?.ticker, SIDE[String(change?.side || change?.call || '').toLowerCase()],
        { action: change?.action === 'REMOVE' ? 'Removed' : change?.action === 'ADD' ? 'Added' : null });
    }
    for (const [key, side] of [['fullBookLongs', 'Long'], ['fullBookShorts', 'Short']]) {
      for (const ticker of Array.isArray(data[key]) ? data[key] : []) {
        if (!findings.some((item) => item.name === ticker)) add(ticker, side);
      }
    }
  }
  if (product === 'real-time-alert') {
    for (const alert of Array.isArray(data.alerts) ? data.alerts : [data.alert].filter(Boolean)) {
      const action = String(alert?.action || '').toUpperCase();
      const side = { BUY: 'Long', SHORT: 'Short', SELL: 'Sold', COVER: 'Covered' }[action];
      add(alert?.ticker || alert?.name, side, { action: titleCase(action), eventTime: alert?.eventTime || null });
    }
  }
  return findings;
}

/** Structured ranges and signals that products publish as data. */
function structuredFindings(snapshot, product, { riskRangeTickers = {} } = {}) {
  const data = snapshot?.data || {};
  const findings = [];
  if (product === 'early-look') {
    // "Our Levels": immediate-term Risk Ranges with the TREND in brackets.
    const tickers = { UST10Y: 'ust10y', UST2Y: 'ust2y', UST30Y: 'ust30y', GOLD: 'gold', SILVER: 'silver', COPPER: 'copper', WTIC: 'wti',
      SPX: 'sp500', COMPQ: 'nasdaq100', NDX: 'nasdaq100', USD: 'usd', BTC: 'bitcoin', BITCOIN: 'bitcoin', ETH: 'ethereum' };
    for (const [name, row] of Object.entries(data)) {
      const ticker = (name.match(/\(([A-Z0-9/]+)\)\s*$/) || [])[1] || name.trim();
      const market = tickers[ticker];
      const low = Number(row?.lrr);
      const high = Number(row?.hrr);
      if (!market || !Number.isFinite(low) || !Number.isFinite(high) || low >= high) continue;
      findings.push({ market, product, kind: 'riskRange', low, high, trend: titleCase(row.trend) || null,
        fit: ticker === 'COMPQ' ? 'related' : 'exact', instrument: ticker === 'COMPQ' ? 'COMPQ' : null,
        instrumentLabel: ticker === 'COMPQ' ? 'Nasdaq Composite' : (/SPOT PRICE/i.test(name) ? 'spot' : null),
        unit: MARKETS[market]?.yield ? '%' : null, source: 'Our Levels' });
    }
  }
  if (product === 'crypto-quant') {
    for (const [ticker, market] of [['BTC', 'bitcoin'], ['ETH', 'ethereum']]) {
      const row = data.cryptos?.[ticker];
      const low = Number(row?.buyTrade);
      const high = Number(row?.sellTrade);
      if (!row || !Number.isFinite(low) || !Number.isFinite(high) || low >= high) continue;
      findings.push({ market, product, kind: 'riskRange', low, high, trend: titleCase(row.trend) || null, fit: 'exact', instrument: null,
        instrumentLabel: null, unit: null, source: 'Buy/Sell Trade' });
    }
  }
  if (product === 'risk-ranges') {
    for (const change of Array.isArray(snapshot?.trendChanges) ? snapshot.trendChanges : []) {
      const market = riskRangeTickers[String(change?.ticker || '').toUpperCase()];
      if (!market) continue;
      findings.push({ market, product, kind: 'trendChange', from: titleCase(change.oldTrend) || null, to: titleCase(change.newTrend) || null,
        fit: 'exact', instrument: null, instrumentLabel: null });
    }
  }
  if (product === 'market-structure') {
    const signals = (Array.isArray(data.signals) ? data.signals : []).filter((row) => row?.label && row?.value)
      .map((row) => ({ label: String(row.label), value: String(row.value), tone: row.tone || null }));
    if (signals.length) findings.push({ market: 'sp500', product, kind: 'structure', signals, fit: 'exact', instrument: null, instrumentLabel: null });
  }
  return findings;
}

const sameCode = (left, right) => left.trade === right.trade && left.trend === right.trend;

function compare(price, levelValue) {
  if (!Number.isFinite(price) || !Number.isFinite(levelValue)) return null;
  return price > levelValue ? 'above' : price < levelValue ? 'below' : 'at';
}

/**
 * Morning research for the setup board.
 * snapshots: { [productKey]: snapshot } for the market date.
 * references: { [instrument]: number } live prices (yields in percent) for checking printed levels.
 * prices: { [marketId]: number } the price each Alpha Code is compared with.
 */
function buildMorningResearch({ snapshots = {}, marketDate = null, references = {}, prices = {}, riskRangeTickers = {},
  publishedAt = () => null } = {}) {
  const products = PRODUCTS.map(({ key, label }) => {
    const snapshot = snapshots[key];
    const current = snapshot && (!marketDate || snapshot.date === marketDate);
    return { key, label, date: snapshot?.date || null, publishedAt: current ? publishedAt(snapshot) : null, status: current ? 'read' : 'missing' };
  });
  const findings = [];
  for (const product of products) {
    if (product.status !== 'read') continue;
    const snapshot = snapshots[product.key];
    const text = snapshot?.article?.bodyText || snapshot?.article?.summary || '';
    const textFindings = product.key === 'risk-ranges' || product.key === 'market-structure' ? []
      : extractFromText(text, { product: product.key, references });
    findings.push(...textFindings, ...positionFindings(snapshot, product.key),
      ...structuredFindings(snapshot, product.key, { riskRangeTickers }));
  }
  const markets = {};
  for (const finding of findings) {
    const entry = markets[finding.market] ||= { findings: [] };
    const duplicate = entry.findings.find((item) => item.product === finding.product && item.kind === finding.kind
      && item.instrument === finding.instrument && ['trade', 'trend', 'level', 'low', 'high', 'side', 'from', 'to']
        .every((key) => item[key] === finding[key]));
    if (duplicate) continue;
    const { market, ...rest } = finding;
    entry.findings.push({ ...rest, productLabel: LABELS[finding.product] });
  }
  for (const [market, entry] of Object.entries(markets)) {
    // A single TRADE or TREND level that a product's own Alpha Code already prints adds nothing.
    entry.findings = entry.findings.filter((item) => !['tradeLevel', 'trendLevel'].includes(item.kind)
      || !entry.findings.some((other) => other.kind === 'alphaCode' && other.product === item.product
        && other.instrument === item.instrument && other[item.kind === 'tradeLevel' ? 'trade' : 'trend'] === item.level));
    // The Alpha Code for the Kalshi underlying itself: the highest-priority
    // product's explicit code, else its stated TRADE and TREND levels.
    const codes = entry.findings.filter((item) => item.kind === 'alphaCode' && item.fit === 'exact')
      .sort((left, right) => (PRIORITY[left.product] - PRIORITY[right.product]) || (Number(right.explicit) - Number(left.explicit)));
    const primary = codes[0];
    if (primary) {
      const price = prices[market];
      const agreeing = codes.filter((item) => sameCode(item, primary)).map((item) => item.productLabel);
      entry.alphaCode = { trade: primary.trade, trend: primary.trend, unit: primary.unit || null, approximate: primary.approximate,
        explicit: primary.explicit, product: primary.product, productLabel: primary.productLabel, confirmedBy: [...new Set(agreeing)].filter((label) => label !== primary.productLabel),
        publishedAt: products.find((item) => item.key === primary.product)?.publishedAt || null,
        priceVsTrade: compare(price, primary.trade), priceVsTrend: compare(price, primary.trend), excerpt: primary.excerpt,
        conflicts: codes.filter((item) => !sameCode(item, primary)).map((item) => ({ trade: item.trade, trend: item.trend, product: item.product, productLabel: item.productLabel })) };
    }
    entry.findings.sort((left, right) => (PRIORITY[left.product] - PRIORITY[right.product]));
  }
  return { version: 1, marketDate, products, markets };
}

const PROXY_TICKERS = Object.keys(PROXIES);

module.exports = { PRODUCTS, PROXY_TICKERS, buildMorningResearch, extractFromText, positionFindings, structuredFindings, statements };
