import researchCatalog from '../constants/dashboardResearchCatalog.json';
import backdropCatalog from '../constants/marketBackdropCatalog.json';
import { todayInNewYork } from './morningTldr';

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const identity = (value) => typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').toUpperCase() : '';
const validDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value || '')
  && Number.isFinite(Date.parse(`${value}T12:00:00Z`))
  && new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value;
const directions = new Set(['BULLISH', 'BEARISH', 'NEUTRAL']);
const products = { 'bitcoin-trend-tracker': 'Bitcoin Tracker', 'crypto-quant': 'Crypto Quant' };
const cryptoSymbols = new Set(backdropCatalog.find((group) => group.id === 'crypto').rows.map((row) => row.symbol));
const cryptoIdentities = researchCatalog.filter((entry) => cryptoSymbols.has(entry.symbol)).map((entry) => ({
  symbol: entry.symbol,
  values: new Set([...entry.aliases, ...entry.names,
    ...entry.names.flatMap((name) => entry.aliases.map((alias) => `${name} (${alias})`))].map(identity)),
}));
const rejectedFlags = [
  'mock', 'isMock', 'seed', 'seeded', 'isSeed', 'isSeeded', 'fixture', 'synthetic', 'inferred',
  'cacheOnly', 'cache_only', 'cachedOnly', 'fromCache', 'stale', 'isStale', 'offline', 'disconnected', 'fallback',
];
const rejectedState = /(?:^|[\s_-])(?:unavailable|unverified|offline|disconnected|stale|expired|mock|seed|seeded|fixture|synthetic|inferred|cache|cached|cache-only|fallback|error|failed|portfolio|cost-basis|model)(?:$|[\s_-])/i;

function invalidEvidence(record) {
  if (!isRecord(record)) return false;
  return rejectedFlags.some((flag) => record[flag] === true)
    || ['sourceVerified', 'verified', 'success', 'connected', 'available'].some((field) => record[field] === false)
    || ['status', 'sourceStatus', 'freshness', 'availability', 'cacheState', 'cacheStatus', 'source', 'provider']
      .some((field) => rejectedState.test(String(record[field] || '')))
    || ['metadata', 'meta', 'provenance', 'quality', 'flags', 'providerStatus'].some((field) => invalidEvidence(record[field]));
}

function cryptoSymbol(key, row = {}) {
  const fields = [key, row.ticker, row.symbol, row.name, row.originalName].map(identity).filter(Boolean);
  const matches = cryptoIdentities.filter((entry) => fields.every((value) => entry.values.has(value)));
  return fields.length && matches.length === 1 ? matches[0].symbol : null;
}

function sourceEvidence(payload, date) {
  const product = payload.reportType || payload.snapshotType;
  if (!products[product] || !products[payload.snapshotType]
    || (payload.snapshotType === 'crypto-quant' && product !== 'crypto-quant')) return null;
  let sourceUrl = null;
  if (payload.source === 'gmail-html') {
    const prefix = `hedgeye-email/messages/${date}/${product}/`;
    if (typeof payload.htmlSource !== 'string' || !payload.htmlSource.startsWith(prefix)
      || !/^[^/]+\.html$/.test(payload.htmlSource.slice(prefix.length))) return null;
    try {
      const url = new URL(payload.article?.feedUrl);
      if (url.protocol !== 'https:' || url.hostname !== 'app.hedgeye.com'
        || url.username || url.password || url.port || !/^\/feed_items\/\d+\/?$/.test(url.pathname)) return null;
      sourceUrl = url.href;
    } catch {
      return null;
    }
  } else if (payload.source === 'textract' && product === 'bitcoin-trend-tracker') {
    const prefix = `hedgeye-pdfs/${date}/bitcoin-tracker-${date}-`;
    if (typeof payload.pdfSource !== 'string' || !payload.pdfSource.startsWith(prefix)
      || !/^\d{6}\.pdf$/.test(payload.pdfSource.slice(prefix.length))) return null;
    sourceUrl = `/api/hedgeye/screenshot/${date}/content?type=bitcoin-trend-tracker`;
  } else return null;
  return { date, source: products[product], sourceUrl, sourceType: 'supplemental', reportType: product };
}

const finite = (value) => typeof value === 'number' && Number.isFinite(value);

function publishedRange(row, affected) {
  if (['riskRange', 'lrr', 'hrr', 'buyTrade', 'sellTrade', 'trackerRange'].some((field) => affected.has(field))) return null;
  // Buy/Sell Trade are the source table's lower/upper range. Trend thresholds
  // and its indicative Price column must never be substituted for these bounds.
  const pairs = [
    [row.buyTrade, row.sellTrade],
    [row.lrr, row.hrr],
    [row.trackerRange?.lrr, row.trackerRange?.hrr],
  ].filter((pair) => pair.some((value) => value != null));
  if (!pairs.length || invalidEvidence(row.trackerRange)
    || pairs.some(([lrr, hrr]) => !finite(lrr) || !finite(hrr) || lrr <= 0 || lrr >= hrr)) return null;
  const [lrr, hrr] = pairs[0];
  return pairs.every((pair) => pair[0] === lrr && pair[1] === hrr) ? { lrr, hrr } : null;
}

/** Latest dated publication, independent of the front dashboard's quote state. */
export function normalizeDashboardCryptoResearch(payload, { date = todayInNewYork() } = {}) {
  if (!validDate(date) || !isRecord(payload) || invalidEvidence(payload)
    || !validDate(payload.date) || payload.date > date || !isRecord(payload.data)
    || invalidEvidence(payload.data) || !isRecord(payload.data.cryptos) || invalidEvidence(payload.data.cryptos)) return {};
  const evidence = sourceEvidence(payload, payload.date);
  if (!evidence) return {};
  const matches = new Map();
  Object.entries(payload.data.cryptos).forEach(([key, row]) => {
    if (!isRecord(row)) return;
    const symbol = cryptoSymbol(key, row);
    if (!symbol) return;
    const entries = matches.get(symbol) || [];
    matches.set(symbol, entries);
    if (invalidEvidence(row) || row.decisionEligible === false
      || (row.date != null && row.date !== payload.date)) {
      entries.push(null);
      return;
    }
    const issues = [
      ...(Array.isArray(payload.sourceQuality?.issues) ? payload.sourceQuality.issues : [])
        .filter((issue) => cryptoSymbol(issue.ticker) === symbol),
      ...(Array.isArray(row.sourceQuality?.issues) ? row.sourceQuality.issues : []),
    ];
    const affected = new Set(issues.flatMap((issue) => [issue.field, ...(issue.affectedFields || [])]));
    const trend = !affected.has('trend') && directions.has(identity(row.trend)) ? identity(row.trend) : null;
    const range = publishedRange(row, affected);
    const rowEvidence = { ...evidence, sourceTicker: key };
    entries.push(trend || range ? {
      ...rowEvidence, verified: true, trend, lrr: range?.lrr ?? null, hrr: range?.hrr ?? null,
      trendEvidence: trend ? rowEvidence : null,
      rangeEvidence: range ? rowEvidence : null,
    } : null);
  });
  return Object.fromEntries([...matches]
    .filter(([, entries]) => entries.length === 1 && entries[0])
    .map(([symbol, entries]) => [symbol, entries[0]]));
}
