import { SECURITIES_LIST } from '../constants/securitiesList';
import { SECURITY_CATEGORY_MAPPING } from '../constants/securityCategoryMapping';

const array = value => Array.isArray(value) ? value : [];
const symbol = value => typeof value === 'string' && /^\^?[A-Z][A-Z0-9]*(?:[./-][A-Z0-9]+)*(?:=F)?$/.test(value.trim()) ? value.trim() : null;
// These can occur in security names or ordinary research prose. Blue is an
// identity cue, not an instruction to treat every capitalized acronym as a ticker.
const AMBIGUOUS = new Set('A I AN AS AT BE BY FOR IN IS IT OF ON OR SO TO US ALL ARE HAS NOW OUT SEE THE AI GDP CPI EPS ETF ETFS NLV PCA MAX MIN ATR CEO'.split(' '));
const catalog = [...SECURITIES_LIST.map(row => row.ticker), ...Object.keys(SECURITY_CATEGORY_MAPPING)];
// Currency typography is independent of the research/holdings ticker roster.
// CNH is the offshore renminbi code; XXX supports generic currency-pair text.
const CURRENCY_CODES = new Set([...Intl.supportedValuesOf('currency'), 'CNH', 'XXX']);
const isCurrencyIdentity = value => {
  if (CURRENCY_CODES.has(value)) return true;
  const pair = /^([A-Z]{3})[./-]?([A-Z]{3})$/.exec(value);
  return Boolean(pair && CURRENCY_CODES.has(pair[1]) && CURRENCY_CODES.has(pair[2]));
};

const protectedTextRanges = text => [...text.matchAll(/(?:[a-z][a-z\d+.-]*:\/\/|www\.)[^\s<>]+|`+[^`]*`+/gi)]
  .map(match => ({ start: match.index, end: match.index + match[0].length }));
const overlaps = (range, ranges) => ranges.some(other => range.start < other.end && range.end > other.start);
const SOURCE_CONTEXT = /^(?:sources?|citation|publisher|product|research source)$/i;
const COMPANY_SUFFIX = /^(?:inc\.?|incorporated|corp\.?|corporation|ltd\.?|limited|plc|ag|se|llc|l\.p\.?|co\.?|company|holdings?|group|trust|fund|etf)$/i;
const COMPANY_CONNECTOR = /^(?:of|the|and|for|to|de|von|&)$/;
const companyName = (value, ticker = '') => {
  if (typeof value !== 'string') return '';
  let name = value.trim();
  if (ticker && name.endsWith(` (${ticker})`)) name = name.slice(0, -ticker.length - 3).trim();
  if (name.length < 2 || name.length > 180 || !/\p{L}/u.test(name) || name === ticker
    || /^(?:n\/?a|unknown|unavailable|neutral|bullish|bearish|long|short|wait|none|—|-)$/i.test(name)
    || /\b(?:name unavailable|name unknown|not supplied|not verified)\b/i.test(name)) return '';
  return name;
};

// A name immediately followed by its explicit ticker is captured typography,
// not an issuer lookup. Walk back only through a bounded name-shaped phrase,
// keeping ordinary narrative, source labels, URLs and code out of the identity.
export function portfolioNamedSecurityMentions(value) {
  const text = String(value ?? '');
  if (/^\s*Sources?:/i.test(text)) return [];
  const protectedRanges = protectedTextRanges(text);
  return [...text.matchAll(/\(\s*(\$?\^?[A-Z][A-Z0-9]*(?:[./-][A-Z0-9]+)*(?:=F)?)\s*\)/g)].flatMap(match => {
    const ticker = match[1].replace(/^\$/, '');
    if (AMBIGUOUS.has(ticker) || overlaps({ start: match.index, end: match.index + match[0].length }, protectedRanges)) return [];
    const prefixStart = Math.max(0, match.index - 180);
    const prefix = text.slice(prefixStart, match.index).trimEnd();
    const tokens = [...prefix.matchAll(/[\p{L}\p{N}][\p{L}\p{N}’'&./-]*,?|&/gu)];
    if (!tokens.length || tokens.at(-1).index + tokens.at(-1)[0].length !== prefix.length) return [];
    let first = tokens.length;
    let cursor = prefix.length;
    for (let index = tokens.length - 1; index >= 0 && tokens.length - index <= 16; index -= 1) {
      const token = tokens[index];
      if (!/^[\s,]*$/.test(prefix.slice(token.index + token[0].length, cursor))) break;
      const word = token[0].replace(/,$/, '');
      if (word.endsWith('.') && !COMPANY_SUFFIX.test(word) && !/^(?:[A-Z]\.){1,4}$/.test(word)) break;
      const leadingBrand = index === tokens.length - 2 && COMPANY_SUFFIX.test(tokens.at(-1)[0].replace(/,$/, ''));
      if (!/^[\p{Lu}\p{N}]/u.test(word) && !/[\p{Lu}]/u.test(word) && !COMPANY_CONNECTOR.test(word) && !leadingBrand) break;
      first = index;
      cursor = token.index;
    }
    while (first < tokens.length && COMPANY_CONNECTOR.test(tokens[first][0])) first += 1;
    if (first === tokens.length) return [];
    const start = prefixStart + tokens[first].index;
    const end = prefixStart + prefix.length;
    const name = companyName(text.slice(start, end), ticker);
    if (!name || overlaps({ start, end }, protectedRanges)) return [];
    return [{ name, ticker, start, end }];
  });
}

export function portfolioReviewCompanyNames({ brief, rollup = brief?.dailyRollup } = {}) {
  const names = new Set();
  const add = (value, ticker) => { const name = companyName(value, ticker); if (name) names.add(name); };
  array(brief?.holdings).forEach(row => add(row?.securityName, row?.holding));
  array(brief?.opportunities).forEach(row => add(row?.securityName, row?.symbol));
  array(rollup?.securityNames).forEach(row => add(typeof row === 'string' ? row : row?.name, row?.ticker));
  array(rollup?.sections).forEach(section => array(section?.blocks).forEach(block => {
    if (block?.type === 'table') {
      const columns = array(block.columns);
      const nameIndex = columns.findIndex(column => /^(?:security|company|issuer)(?: name)?$/i.test(column));
      const tickerIndex = columns.findIndex(column => /^(?:ticker|symbol|holding)$/i.test(column));
      if (nameIndex >= 0) array(block.rows).forEach(row => add(row?.cells?.[nameIndex], tickerIndex >= 0 ? row?.cells?.[tickerIndex] : ''));
    }
    portfolioNamedSecurityMentions(block?.text).forEach(mention => names.add(mention.name));
  }));
  return names;
}

export function portfolioCompanyNameRanges(value, names = new Set(), context = '') {
  const text = String(value ?? '');
  if (SOURCE_CONTEXT.test(context.trim()) || /^\s*Sources?:/i.test(text)) return [];
  const protectedRanges = protectedTextRanges(text);
  const ranges = [];
  const identities = new Set([...names].map(name => companyName(name)).filter(Boolean));
  portfolioNamedSecurityMentions(text).forEach(mention => identities.add(mention.name));
  if (/^(?:security|company|issuer)(?: name)?$/i.test(context.trim())) {
    const name = companyName(text);
    if (name) identities.add(name);
  }
  for (const name of [...identities].sort((a, b) => b.length - a.length)) {
    let start = text.indexOf(name);
    while (start >= 0) {
      const end = start + name.length;
      if (!/[\p{L}\p{N}_]/u.test(text[start - 1] || '') && !/[\p{L}\p{N}_]/u.test(text[end] || '')
        && !overlaps({ start, end }, [...protectedRanges, ...ranges])) ranges.push({ start, end, tone: 'ticker', name });
      start = text.indexOf(name, end);
    }
  }
  return ranges.sort((a, b) => a.start - b.start);
}

export function portfolioReviewTickers({ brief, rollup = brief?.dailyRollup } = {}) {
  const tickers = new Set(catalog.map(symbol).filter(Boolean));
  array(brief?.holdings).forEach(row => { if (symbol(row?.holding)) tickers.add(row.holding); });
  array(brief?.opportunities).forEach(row => { if (symbol(row?.symbol)) tickers.add(row.symbol); });
  array(rollup?.securityTickers).forEach(value => { if (symbol(value)) tickers.add(value); });
  array(rollup?.sections).forEach(section => array(section?.blocks).forEach(block => {
    if (block?.type === 'table') {
      const index = array(block.columns).findIndex(column => /^(?:ticker|symbol)$/i.test(column));
      if (index >= 0) array(block.rows).forEach(row => { const value = row?.cells?.[index]; if (symbol(value)) tickers.add(value); });
    }
    // Explicit source mentions supply typography only, never quotes, signals,
    // names, portfolio membership or a security mapping.
    for (const match of String(block?.text || '').matchAll(/\$([A-Z][A-Z0-9]*(?:[./-][A-Z0-9]+)*)\b/g)) {
      const value = match[1];
      if (!AMBIGUOUS.has(value)) tickers.add(value);
    }
    portfolioNamedSecurityMentions(block?.text).forEach(mention => tickers.add(mention.ticker));
  }));
  return tickers;
}

const DEFAULT_TICKERS = portfolioReviewTickers();

export function portfolioTickerRanges(value, tickers = DEFAULT_TICKERS, context = '') {
  const text = String(value ?? '');
  const explicit = /^(?:ticker|symbol|holding)$/i.test(context);
  const protectedRanges = protectedTextRanges(text);
  return [...text.matchAll(/\$?\^?[A-Z][A-Z0-9]*(?:[./-][A-Z0-9]+)*(?:=F)?/g)].flatMap(match => {
    const start = match.index, end = start + match[0].length;
    const ticker = match[0].replace(/^\$/, '');
    const currency = isCurrencyIdentity(ticker);
    if (/[\w]/.test(text[start - 1] || '') || /[\w]/.test(text[end] || '')
      || protectedRanges.some(range => start < range.end && end > range.start)) return [];
    // A currency pair is one identity. Research ratios such as
    // SPY/VIX contain two separate tickers and retain their own offsets.
    if (!currency && !tickers.has(ticker) && ticker.includes('/')) {
      return [...match[0].matchAll(/[^/]+/g)].flatMap(part =>
        portfolioTickerRanges(part[0], tickers, context).map(range => ({
          ...range, start: start + part.index + range.start, end: start + part.index + range.end,
        })));
    }
    const marked = match[0].startsWith('$') || (text[start - 1] === '(' && text[end] === ')');
    if (!explicit && ((!currency && !tickers.has(ticker)) || (!marked && (ticker.length === 1 || AMBIGUOUS.has(ticker))))) return [];
    return [{ start, end, tone: 'ticker' }];
  });
}

export function portfolioTopicTitle(value, explicitTitle) {
  const text = typeof value === 'string' ? value : '';
  if (typeof explicitTitle === 'string' && explicitTitle.trim()
      && text.startsWith(`${explicitTitle.trim()} — `)) return explicitTitle.trim();
  // Legacy rollups joined source subheads to their first paragraph. Keep this
  // fallback bounded so a long sentence containing an em dash isn't a title.
  const prefix = text.split(' — ')[0];
  return prefix !== text && prefix.length <= 110 && !/[.!?;\n]/.test(prefix) && prefix.split(/\s+/).length <= 16 ? prefix : '';
}
