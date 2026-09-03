const readExcelFileModule = require('read-excel-file/node');

const readExcelFile = readExcelFileModule.default || readExcelFileModule;

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_AGE_DAYS = 7;
const DEFAULT_TIMEOUT_MS = 8_000;

const HOLDINGS_SOURCES = Object.freeze({
  IAK: Object.freeze({
    provider: 'iShares',
    format: 'ishares-csv',
    url: 'https://www.ishares.com/us/products/239515/ishares-u-s-insurance-etf/latest-holdings.csv',
  }),
  XLF: Object.freeze({
    provider: 'State Street',
    format: 'ssga-xlsx',
    url: 'https://www.ssga.com/library-content/products/fund-data/etfs/us/holdings-daily-us-en-xlf.xlsx',
  }),
});

const normalizeTicker = (value) => String(value || '')
  .trim()
  .toUpperCase()
  .replace(/\//g, '.')
  .replace(/-/g, '.');

const normalizeDate = (value) => {
  const text = String(value || '').trim().replace(/^As of\s+/i, '');
  if (!text) return null;
  const isoMatch = text.match(/^(\d{4}-\d{2}-\d{2})/);
  if (isoMatch) return isoMatch[1];
  const parsed = new Date(`${text} 12:00:00 UTC`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
};

const parseCsvLine = (line) => {
  const values = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === ',' && !quoted) {
      values.push(value);
      value = '';
    } else {
      value += character;
    }
  }
  values.push(value);
  return values;
};

const aggregateHoldings = (rows) => {
  const holdings = new Map();
  rows.forEach(({ ticker, weight }) => {
    const normalizedTicker = normalizeTicker(ticker);
    const normalizedWeight = Number(weight);
    if (!normalizedTicker || !Number.isFinite(normalizedWeight) || normalizedWeight <= 0) return;
    holdings.set(normalizedTicker, (holdings.get(normalizedTicker) || 0) + normalizedWeight);
  });
  return holdings;
};

const parseIsharesHoldingsCsv = (text) => {
  const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/);
  const asOfLine = lines.find((line) => /^Fund Holdings as of,/i.test(line));
  const asOf = normalizeDate(asOfLine ? parseCsvLine(asOfLine)[1] : null);
  const headerIndex = lines.findIndex((line) => /^Ticker,Name,Type,/i.test(line));
  if (headerIndex < 0) throw new Error('The iShares holdings header is unavailable.');

  const headers = parseCsvLine(lines[headerIndex]);
  const column = (name) => headers.indexOf(name);
  const tickerIndex = column('Ticker');
  const typeIndex = column('Type');
  const assetClassIndex = column('Asset Class');
  const weightIndex = column('Weight (%)');
  const holdings = aggregateHoldings(lines.slice(headerIndex + 1).map(parseCsvLine).map((row) => ({
    ticker: row[tickerIndex],
    weight: row[weightIndex],
    type: row[typeIndex],
    assetClass: row[assetClassIndex],
  })).filter((row) => (
    String(row.type || '').trim().toUpperCase() === 'EQUITY'
    && String(row.assetClass || '').trim().toLowerCase() === 'equity'
  )));

  if (!asOf || holdings.size === 0) throw new Error('The iShares holdings snapshot is incomplete.');
  return { asOf, holdings };
};

const unwrapWorkbookRows = (value) => {
  if (Array.isArray(value) && Array.isArray(value[0]?.data)) return value[0].data;
  return Array.isArray(value) ? value : [];
};

const looksLikeDerivative = (name, ticker) => {
  const description = String(name || '').toUpperCase();
  const symbol = String(ticker || '').toUpperCase();
  return (
    /\b(CASH|COLLATERAL|FUTURE|SWAP)\b/.test(description)
    || /\b(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\d{2}\b/.test(description)
    || /\d$/.test(symbol)
  );
};

const parseSsgaHoldingsRows = (workbookRows) => {
  const rows = unwrapWorkbookRows(workbookRows);
  const asOfRow = rows.find((row) => String(row?.[0] || '').trim() === 'Holdings:');
  const asOf = normalizeDate(asOfRow?.[1]);
  const headerIndex = rows.findIndex((row) => row?.[0] === 'Name' && row?.[1] === 'Ticker');
  if (headerIndex < 0) throw new Error('The State Street holdings header is unavailable.');

  const headers = rows[headerIndex];
  const nameIndex = headers.indexOf('Name');
  const tickerIndex = headers.indexOf('Ticker');
  const weightIndex = headers.indexOf('Weight');
  const holdings = aggregateHoldings(rows.slice(headerIndex + 1).map((row) => ({
    name: row?.[nameIndex],
    ticker: row?.[tickerIndex],
    weight: row?.[weightIndex],
  })).filter((row) => !looksLikeDerivative(row.name, row.ticker)));

  if (!asOf || holdings.size === 0) throw new Error('The State Street holdings snapshot is incomplete.');
  return { asOf, holdings };
};

const computeWeightedHoldingsOverlap = (baseHoldings, referenceHoldings) => {
  const baseTotal = [...baseHoldings.values()].reduce((sum, weight) => sum + weight, 0);
  const referenceTotal = [...referenceHoldings.values()].reduce((sum, weight) => sum + weight, 0);
  if (!(baseTotal > 0) || !(referenceTotal > 0)) {
    throw new Error('Holdings weights are unavailable.');
  }

  const sharedTickers = [...baseHoldings.keys()].filter((ticker) => referenceHoldings.has(ticker));
  const weightedOverlap = sharedTickers.reduce((sum, ticker) => (
    sum + Math.min(
      baseHoldings.get(ticker) / baseTotal,
      referenceHoldings.get(ticker) / referenceTotal,
    )
  ), 0);
  const baseCoverage = sharedTickers.reduce(
    (sum, ticker) => sum + (baseHoldings.get(ticker) / baseTotal),
    0,
  );
  const referenceCoverage = sharedTickers.reduce(
    (sum, ticker) => sum + (referenceHoldings.get(ticker) / referenceTotal),
    0,
  );

  return {
    weightedOverlapPct: weightedOverlap * 100,
    sharedHoldings: sharedTickers.length,
    baseHoldings: baseHoldings.size,
    referenceHoldings: referenceHoldings.size,
    baseCoveragePct: baseCoverage * 100,
    referenceCoveragePct: referenceCoverage * 100,
  };
};

const isFreshPublishedHoldings = (asOf, now, maxAgeDays) => {
  const timestamp = Date.parse(`${asOf}T12:00:00Z`);
  if (!Number.isFinite(timestamp)) return false;
  const age = now.getTime() - timestamp;
  return age >= -DAY_MS && age <= maxAgeDays * DAY_MS;
};

const createLeveragedProductOverlapService = ({
  fetchImpl = global.fetch,
  xlsxReader = readExcelFile,
  now = () => new Date(),
  maxAgeDays = DEFAULT_MAX_AGE_DAYS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) => {
  const fetchSource = async (symbol) => {
    const source = HOLDINGS_SOURCES[symbol];
    if (!source) throw new Error(`No verified holdings source is configured for ${symbol}.`);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(source.url, {
        headers: { Accept: source.format === 'ssga-xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'text/csv' },
        signal: controller.signal,
      });
      if (!response?.ok) throw new Error(`${source.provider} returned HTTP ${response?.status || 'error'}.`);
      const parsed = source.format === 'ishares-csv'
        ? parseIsharesHoldingsCsv(await response.text())
        : parseSsgaHoldingsRows(await xlsxReader(Buffer.from(await response.arrayBuffer())));
      return { ...parsed, source };
    } finally {
      clearTimeout(timeout);
    }
  };

  const getOverlap = async ({ baseSymbol, referenceSymbol }) => {
    const base = normalizeTicker(baseSymbol);
    const reference = normalizeTicker(referenceSymbol);
    const unavailable = (reason) => ({
      available: false,
      status: 'unavailable',
      baseSymbol: base,
      referenceSymbol: reference,
      weightedOverlapPct: null,
      reason,
      fromCache: false,
    });

    if (!HOLDINGS_SOURCES[base] || !HOLDINGS_SOURCES[reference]) {
      return unavailable('Verified published holdings are not configured for this pair.');
    }

    try {
      const [baseSnapshot, referenceSnapshot] = await Promise.all([
        fetchSource(base),
        fetchSource(reference),
      ]);
      const observedNow = now();
      if (
        !isFreshPublishedHoldings(baseSnapshot.asOf, observedNow, maxAgeDays)
        || !isFreshPublishedHoldings(referenceSnapshot.asOf, observedNow, maxAgeDays)
      ) {
        return unavailable('One or more published holdings snapshots are out of date.');
      }

      const overlap = computeWeightedHoldingsOverlap(
        baseSnapshot.holdings,
        referenceSnapshot.holdings,
      );
      const asOf = [baseSnapshot.asOf, referenceSnapshot.asOf].sort()[0];
      return {
        available: true,
        status: 'available',
        baseSymbol: base,
        referenceSymbol: reference,
        ...overlap,
        asOf,
        method: 'weighted_constituent_overlap',
        fromCache: false,
        sources: [baseSnapshot, referenceSnapshot].map((snapshot, index) => ({
          symbol: index === 0 ? base : reference,
          provider: snapshot.source.provider,
          asOf: snapshot.asOf,
          url: snapshot.source.url,
        })),
      };
    } catch (error) {
      return unavailable(error?.name === 'AbortError'
        ? 'Published holdings request timed out.'
        : (error?.message || 'Published holdings are unavailable.'));
    }
  };

  return { getOverlap };
};

module.exports = {
  HOLDINGS_SOURCES,
  computeWeightedHoldingsOverlap,
  createLeveragedProductOverlapService,
  normalizeTicker,
  parseIsharesHoldingsCsv,
  parseSsgaHoldingsRows,
};
