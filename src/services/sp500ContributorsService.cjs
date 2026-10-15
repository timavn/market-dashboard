// The universal parser uses JavaScript ZIP decoding; the Node stream parser
// stalled while unpacking the source workbook in the busy dashboard process.
const readExcelFileModule = require('read-excel-file/universal');
const { zonedTimeToUtc } = require('date-fns-tz');
const { isTradingDateKey, previousTradingDateKey } = require('../utils/usEquityMarketCalendar.cjs');
const { canonicalMomoCompanyTicker, MOMO_EXCLUDED_TICKERS } = require('../constants/momoTrackerCatalog.cjs');
const { normalizeMomoTrackerSnapshot } = require('./momoTrackerSnapshot.cjs');

const SOURCES = Object.freeze({
  index: 'https://www.ssga.com/us/en/intermediary/etfs/state-street-spdr-sp-500-etf-trust-spy',
  identities: 'https://www.ssga.com/library-content/products/fund-data/etfs/us/holdings-daily-us-en-spy.xlsx',
  nasdaq: 'https://api.nasdaq.com/api/quote/',
  screener: 'https://api.nasdaq.com/api/screener/stocks?tableonly=true&limit=10000&download=true',
});
const readExcelFile = readExcelFileModule.default || readExcelFileModule;
const NY = 'America/New_York';
const SOURCE_FAILURE = Symbol('sp500-contributor-source-failure');
const nyFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: NY, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

function easternParts(nowMs) {
  const parts = Object.fromEntries(nyFormatter.formatToParts(new Date(nowMs)).map(part => [part.type, part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

function latestCompletedDate(nowMs) {
  const parts = easternParts(nowMs);
  return isTradingDateKey(parts.date) && parts.minutes >= 16 * 60
    ? parts.date : previousTradingDateKey(parts.date);
}

function publishedDateIsCurrent(asOf, nowMs) {
  const today = easternParts(nowMs).date;
  // A daily publication may describe today or the immediately prior session.
  return isTradingDateKey(asOf) && [today, previousTradingDateKey(today)].includes(asOf);
}

function cleanText(value) {
  return String(value || '').replace(/<[^>]*>/g, ' ').replace(/&amp;/gi, '&')
    .replace(/&nbsp;|&#160;/gi, ' ').replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"').replace(/\s+/g, ' ').trim();
}

function dateKey(value) {
  const text = cleanText(value).replace(/^as of\s+/i, '');
  const parsed = new Date(`${text} 12:00:00 UTC`);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : null;
}

function identityKey(value) {
  return cleanText(value).toUpperCase().replace(/\bCL\b/g, 'CLASS')
    .replace(/\b(CORPORATION|CORP|INCORPORATED|INC|COMPANY|CO|PLC|LIMITED|LTD|THE|SHARES)\b/g, '')
    .replace(/[^A-Z0-9]/g, '');
}

function positiveNumber(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const text = String(value).trim();
  if (!/^\$?\d[\d,]*(?:\.\d+)?$/.test(text)) return null;
  const parsed = Number(text.replace(/[$,]/g, ''));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function flaggedUnavailable(value) {
  if (!value || typeof value !== 'object') return false;
  const invalidMarker = /unavailable|error|offline|disconnect|stale|mock|seed|synthetic|portfolio|cost.basis|cache.only|fallback|model.only|inferred/i;
  if (['mock', 'isMock', 'seed', 'seeded', 'isSeed', 'stale', 'isStale', 'cacheOnly', 'isCacheOnly', 'fromCache', 'refreshFailed', 'offline', 'disconnected', 'synthetic', 'fallback', 'isFallback', 'modelOnly', 'portfolioDerived', 'inferred', 'costBasisDerived'].some(key => value[key] === true)
    || value.connected === false || value.available === false
    || /^(unavailable|error|offline|disconnected|stale|mock|seeded|cache-only)$/i.test(String(value.status || ''))
    || ['source', 'warning', 'freshness', 'provenance', 'dataStatus'].some(key => typeof value[key] === 'string' && invalidMarker.test(value[key]))) return true;
  return Object.values(value).some(child => child && typeof child === 'object' && flaggedUnavailable(child));
}

function parseIndexTopHoldings(html) {
  const match = String(html || '').match(/<h3\b[^>]*>\s*Index Top Holdings\s*([\s\S]*?)<\/h3>[\s\S]*?<table\b[^>]*>([\s\S]*?)<\/table>/i);
  if (!match) throw new Error('The published index weights are unavailable.');
  const asOf = dateKey(match[1]);
  const rows = [...match[2].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(row => {
    const cells = [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(cell => cleanText(cell[1]));
    if (!cells.length) return null;
    if (cells.length !== 2 || !/^\d+(?:\.\d+)?%$/.test(cells[1])) throw new Error('An index weight is invalid.');
    return { name: cells[0], weightPct: positiveNumber(cells[1].replace('%', '')) };
  }).filter(Boolean);
  if (!asOf || rows.length !== 10 || rows.some(row => !row.name || !row.weightPct || row.weightPct > 100)
    || new Set(rows.map(row => identityKey(row.name))).size !== 10
    || rows.reduce((sum, row) => sum + row.weightPct, 0) > 100) {
    throw new Error('The published top ten index weights are incomplete.');
  }
  return { asOf, rows: rows.sort((a, b) => b.weightPct - a.weightPct || a.name.localeCompare(b.name)) };
}

function parseHoldingIdentities(workbook) {
  const rows = Array.isArray(workbook?.[0]?.data) ? workbook[0].data : workbook;
  if (!Array.isArray(rows)) throw new Error('Constituent identities are unavailable.');
  const asOf = dateKey(rows.find(row => row?.[0] === 'Holdings:')?.[1]);
  const headerIndex = rows.findIndex(row => row?.[0] === 'Name' && row?.[1] === 'Ticker');
  if (!asOf || headerIndex < 0) throw new Error('Constituent identities are incomplete.');
  const identities = new Map();
  const constituents = new Map();
  for (const row of rows.slice(headerIndex + 1)) {
    const ticker = String(row?.[1] || '').trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9]*(?:[.-][A-Z])?$/.test(ticker)) continue;
    const key = identityKey(row[0]);
    if (!key) continue;
    if (identities.has(key) && identities.get(key) !== ticker) identities.set(key, null);
    else if (!identities.has(key)) identities.set(key, ticker);
    if (constituents.has(ticker)) throw new Error('Duplicate constituent identity.');
    constituents.set(ticker, { ticker, name: cleanText(row[0]) });
  }
  return { asOf, identities, constituents };
}

function parseNasdaqTime(value) {
  const match = String(value || '').match(/(?:^|\b)([A-Z][a-z]{2})\s+(\d{1,2}),\s+(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s+(AM|PM)\s+ET\b/);
  if (!match) return null;
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].indexOf(match[1]);
  const hour = Number(match[4]);
  if (month < 0 || hour < 1 || hour > 12 || Number(match[5]) > 59 || Number(match[6] || 0) > 59) return null;
  const local = `${match[3]}-${String(month + 1).padStart(2, '0')}-${match[2].padStart(2, '0')}T${String(hour % 12 + (match[7] === 'PM' ? 12 : 0)).padStart(2, '0')}:${match[5]}:${match[6] || '00'}`;
  const parsed = zonedTimeToUtc(local, NY);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function validNasdaqData(payload, ticker) {
  return !flaggedUnavailable(payload) && payload?.status?.rCode === 200
    && String(payload?.data?.symbol || '').replace('/', '.').replace('-', '.') === ticker
    && String(payload.data.assetClass || '').toUpperCase() === 'STOCKS';
}

function parseNasdaqQuote(payload, ticker, nowMs) {
  if (!validNasdaqData(payload, ticker)) return null;
  const data = payload.data;
  const current = easternParts(nowMs);
  const marketOpen = isTradingDateKey(current.date) && current.minutes >= 570 && current.minutes < 960
    && /^(open|market open)$/i.test(data.marketStatus || '');
  const candidates = marketOpen ? [data.primaryData] : [data.secondaryData, data.primaryData];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const asOf = parseNasdaqTime(candidate.lastTradeTimestamp);
    const observedMs = Date.parse(asOf);
    const age = nowMs - observedMs;
    const price = positiveNumber(candidate.lastSalePrice);
    const changeText = String(candidate.percentageChange || '').trim();
    const changePercent = /^[+-]?\d+(?:\.\d+)?%$/.test(changeText) ? Number(changeText.replace('%', '')) : null;
    if (!asOf || age < -5_000 || price === null || changePercent === null || changePercent < -100) continue;
    const marketDate = easternParts(observedMs).date;
    let status;
    if (marketOpen) {
      if (marketDate !== current.date || age > 20 * 60_000) continue;
      status = candidate.isRealTime === true && age <= 60_000 ? 'live' : 'delayed';
    } else {
      if (!/^Closed at\s+/i.test(candidate.lastTradeTimestamp || '')) continue;
      const expectedDate = /after.hours/i.test(data.marketStatus || '') && isTradingDateKey(current.date)
        ? current.date : latestCompletedDate(nowMs);
      if (marketDate !== expectedDate || !isTradingDateKey(marketDate)) continue;
      status = 'last-close';
    }
    return { price, changePercent, asOf, marketDate, status, source: 'Nasdaq', sourceUrl: `https://www.nasdaq.com/market-activity/stocks/${ticker.toLowerCase()}`, delayedSource: candidate.isRealTime !== true };
  }
  return null;
}

function parseNasdaqMarketCap(payload, ticker, fetchedAt) {
  if (!validNasdaqData(payload, ticker)) return null;
  const value = positiveNumber(payload.data.summaryData?.MarketCap?.value);
  if (!value || !Number.isFinite(Date.parse(fetchedAt))) return null;
  // Nasdaq publishes no timestamp specifically for this fundamental. Preserve
  // its direct retrieval time without relabeling a quote time as a cap time.
  return { status: 'available', value, currency: 'USD', source: 'Nasdaq', sourceUrl: `https://www.nasdaq.com/market-activity/stocks/${ticker.toLowerCase()}`, fetchedAt, timestampKind: 'retrieved', scope: 'company' };
}

function parseNasdaqScreener(payload, fetchedAt) {
  if (flaggedUnavailable(payload) || payload?.status?.rCode !== 200
    || !Array.isArray(payload?.data?.rows) || !Number.isFinite(Date.parse(fetchedAt))) {
    throw new Error('Company market capitalization universe is unavailable.');
  }
  const rows = new Map();
  for (const row of payload.data.rows) {
    const ticker = String(row?.symbol || '').trim().toUpperCase().replace('/', '.').replace('-', '.');
    if (!/^[A-Z][A-Z0-9]*(?:\.[A-Z])?$/.test(ticker)) continue;
    if (rows.has(ticker)) throw new Error('Duplicate market capitalization identity.');
    const value = positiveNumber(row.marketCap);
    rows.set(ticker, { ticker, name: cleanText(row.name), marketCap: value ? {
      status: 'available', value, currency: 'USD', source: 'Nasdaq',
      sourceUrl: `https://www.nasdaq.com/market-activity/stocks/${ticker.toLowerCase()}`,
      fetchedAt, timestampKind: 'retrieved', scope: 'company',
    } : null });
  }
  return rows;
}

function sourceFailure(stage, code, sourceUrl, detail = {}) {
  return Object.assign(new Error(code), { [SOURCE_FAILURE]: true, stage, code, sourceUrl, ...detail });
}

function createSp500ContributorsService({
  fetchImpl = global.fetch,
  xlsxReader = readExcelFile,
  now = Date.now,
  timeoutMs = 8_000,
  overallTimeoutMs = 26_000,
  onDiagnostic = diagnostic => console.warn('[sp500-contributors]', JSON.stringify(diagnostic)),
} = {}) {
  const inFlight = new Map();
  const currentMs = () => Number(now());
  const unavailable = () => ({ status: 'unavailable', asOf: null, fetchedAt: new Date(currentMs()).toISOString(), source: 'State Street / S&P Dow Jones Indices', sourceUrl: SOURCES.index, rows: [], supplementalRows: [] });
  function cancelAttempt(attempt) {
    attempt.cancelled = true;
    attempt.controllers.forEach(controller => controller.abort());
  }
  function reportFailure(error, startedAt) {
    // Only our own fixed codes, configured public source URLs, and publication
    // dates enter diagnostics. Never log upstream error messages or bodies.
    const safe = error?.[SOURCE_FAILURE] === true ? error : sourceFailure('snapshot', 'UNEXPECTED_FAILURE');
    const diagnostic = { status: 'unavailable', stage: safe.stage, code: safe.code, elapsedMs: Math.max(0, Date.now() - startedAt) };
    if (safe.sourceUrl) diagnostic.sourceUrl = safe.sourceUrl;
    if (safe.asOf) diagnostic.asOf = safe.asOf;
    if (safe.currentMarketDate) diagnostic.currentMarketDate = safe.currentMarketDate;
    try { onDiagnostic?.(diagnostic); } catch { /* Diagnostics must not interrupt a market-data response. */ }
  }
  async function requestOnce(url, type, sourceStage, attempt) {
    if (attempt.cancelled) throw sourceFailure(sourceStage, 'ATTEMPT_CANCELLED', url);
    const controller = new AbortController();
    attempt.controllers.add(controller);
    let phase = 'fetch';
    let timeout;
    const deadline = new Promise((resolve, reject) => {
      controller.signal.addEventListener('abort', () => reject(sourceFailure(`${sourceStage}:${phase}`, attempt.cancelled ? 'ATTEMPT_CANCELLED' : 'SOURCE_ABORTED', url)), { once: true });
      timeout = setTimeout(() => {
        // Reject even when a fetch implementation or parser ignores abort.
        reject(sourceFailure(`${sourceStage}:${phase}`, 'SOURCE_TIMEOUT', url));
        controller.abort();
      }, timeoutMs);
    });
    try {
      return await Promise.race([deadline, (async () => {
        // Compressed response streams stalled after headers arrived in the
        // busy API process. These small publications support identity encoding.
        const response = await fetchImpl(url, { signal: controller.signal, cache: 'no-store', headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Encoding': 'identity', Accept: type === 'json' ? 'application/json' : type === 'xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'text/html' } });
        if (!response?.ok) throw sourceFailure(`${sourceStage}:fetch`, Number.isInteger(response?.status) ? `HTTP_${response.status}` : 'SOURCE_UNAVAILABLE', url);
        phase = 'body';
        if (type === 'json') return { payload: await response.json(), fetchedAt: new Date(currentMs()).toISOString() };
        if (type !== 'xlsx') return await response.text();
        const buffer = await response.arrayBuffer();
        phase = 'parse';
        return await xlsxReader(buffer);
      })()]);
    } catch (error) {
      throw error?.[SOURCE_FAILURE] === true ? error : sourceFailure(`${sourceStage}:${phase}`, 'SOURCE_READ_FAILED', url);
    } finally {
      clearTimeout(timeout);
      attempt.controllers.delete(controller);
    }
  }
  async function request(url, type, sourceStage, attempt, retryTransport = false) {
    try {
      return await requestOnce(url, type, sourceStage, attempt);
    } catch (error) {
      const retryable = retryTransport && !attempt.cancelled && error?.[SOURCE_FAILURE] === true
        && ['SOURCE_TIMEOUT', 'SOURCE_READ_FAILED'].includes(error.code)
        && /:(fetch|body)$/.test(error.stage);
      if (!retryable) throw error;
      // Retry one fresh transport request within the same overall deadline.
      // Published-data validation and workbook parse failures are final.
      return requestOnce(url, type, sourceStage, attempt);
    }
  }
  async function loadSnapshot(attempt, momoSnapshot) {
    const sources = await Promise.all([
      request(SOURCES.index, 'html', 'index', attempt, true),
      request(SOURCES.identities, 'xlsx', 'identities', attempt, true),
      request(SOURCES.screener, 'json', 'market-cap-universe', attempt, true),
    ]);
    let index;
    let holdings;
    let universe;
    try { index = parseIndexTopHoldings(sources[0]); } catch { throw sourceFailure('index:parse', 'INDEX_WEIGHTS_INVALID', SOURCES.index); }
    try {
      holdings = parseHoldingIdentities(sources[1]);
      if (holdings.constituents.size < 500 || holdings.constituents.size > 550) throw new Error('Incomplete membership.');
    } catch { throw sourceFailure('identities:parse', 'IDENTITIES_INVALID', SOURCES.identities); }
    try { universe = parseNasdaqScreener(sources[2].payload, sources[2].fetchedAt); }
    catch { throw sourceFailure('market-cap-universe:parse', 'MARKET_CAP_UNIVERSE_INVALID', SOURCES.screener); }
    const nowMs = currentMs();
    for (const [sourceStage, parsed, url] of [['index', index, SOURCES.index], ['identities', holdings, SOURCES.identities]]) {
      if (!publishedDateIsCurrent(parsed.asOf, nowMs)) throw sourceFailure(`${sourceStage}:freshness`, 'PUBLICATION_OUTDATED', url, { asOf: parsed.asOf, currentMarketDate: easternParts(nowMs).date });
    }
    const indexWeights = new Map(index.rows.map(row => {
      const ticker = holdings.identities.get(identityKey(row.name));
      if (!ticker) throw sourceFailure('identities:match', 'CONSTITUENT_IDENTITY_UNVERIFIED', SOURCES.identities);
      return [ticker, row.weightPct];
    }));
    const companyIdentities = new Map();
    for (const row of holdings.constituents.values()) {
      if (MOMO_EXCLUDED_TICKERS.includes(row.ticker)) continue;
      const companyTicker = canonicalMomoCompanyTicker(row.ticker);
      if (!companyIdentities.has(companyTicker) || row.ticker === companyTicker) companyIdentities.set(companyTicker, row);
    }
    const companyMembers = [...companyIdentities.values()];
    const capFor = async row => {
      const screened = universe.get(row.ticker);
      if (screened?.marketCap) return screened.marketCap;
      // A handful of share classes have no screener fundamental. Resolve those
      // directly, never rank an incompletely valued constituent universe.
      const result = await request(`${SOURCES.nasdaq}${encodeURIComponent(row.ticker)}/summary?assetclass=stocks`, 'json', 'market-cap', attempt);
      return parseNasdaqMarketCap(result.payload, row.ticker, result.fetchedAt);
    };
    const members = await Promise.all(companyMembers.map(async row => {
      let marketCap;
      try { marketCap = await capFor(row); } catch { marketCap = null; }
      if (!marketCap) throw sourceFailure('market-cap-universe:coverage', 'CONSTITUENT_MARKET_CAP_UNAVAILABLE', SOURCES.screener);
      return { ...row, weightPct: indexWeights.get(row.ticker) ?? null, marketCap };
    }));
    const byMarketCap = (a, b) => (b.marketCap?.value || 0) - (a.marketCap?.value || 0) || a.ticker.localeCompare(b.ticker);
    const rows = members.sort(byMarketCap).slice(0, 10).map((row, position) => ({ ...row, rank: position + 1 }));
    if (rows.length !== 10) throw sourceFailure('market-cap-universe:coverage', 'TOP_TEN_INCOMPLETE', SOURCES.screener);
    const normalizedMomo = normalizeMomoTrackerSnapshot(momoSnapshot, nowMs);
    const included = new Set(rows.map(row => canonicalMomoCompanyTicker(row.ticker)));
    const supplementalRows = [];
    if (normalizedMomo.status === 'available') {
      for (const momoRow of normalizedMomo.rows) {
        const ticker = momoRow.ticker;
        const companyTicker = canonicalMomoCompanyTicker(ticker);
        if (included.has(companyTicker) || MOMO_EXCLUDED_TICKERS.includes(ticker)) continue;
        included.add(companyTicker);
        const identity = holdings.constituents.get(ticker) || universe.get(ticker);
        supplementalRows.push({ ticker, name: identity?.name || ticker });
      }
    }
    const enriched = await Promise.all([...rows, ...supplementalRows].map(async row => {
      const capPromise = row.marketCap ? Promise.resolve(row.marketCap) : capFor(row);
      const results = await Promise.allSettled([
        capPromise,
        request(`${SOURCES.nasdaq}${encodeURIComponent(row.ticker)}/info?assetclass=stocks`, 'json', 'quote', attempt),
      ]);
      const quoteResult = results[1].status === 'fulfilled' ? results[1].value : null;
      return { ...row,
        marketCap: results[0].status === 'fulfilled' ? results[0].value : null,
        quote: quoteResult ? parseNasdaqQuote(quoteResult.payload, row.ticker, currentMs()) : null,
      };
    }));
    return {
      status: 'available', asOf: index.asOf, fetchedAt: new Date(currentMs()).toISOString(),
      source: 'State Street / S&P Dow Jones Indices', sourceUrl: SOURCES.index,
      weighting: 'float-adjusted-market-cap', ranking: 'company-market-cap',
      rankingSource: 'Nasdaq', rankingSourceUrl: SOURCES.screener,
      membershipAsOf: holdings.asOf, membershipSourceUrl: SOURCES.identities,
      rows: enriched.slice(0, rows.length), supplementalRows: enriched.slice(rows.length).sort(byMarketCap),
      momoStatus: normalizedMomo.status === 'available' ? 'available'
        : !momoSnapshot || (/^\d{4}-\d{2}-\d{2}$/.test(momoSnapshot.date || '') && momoSnapshot.date < easternParts(nowMs).date)
          ? 'pending' : 'unavailable',
      momoPublicationDate: normalizedMomo.status === 'available' ? normalizedMomo.publicationDate : null,
      ...(normalizedMomo.status === 'available' ? { momoSnapshot } : {}),
    };
  }
  function getSnapshot({ momoSnapshot = null } = {}) {
    const key = JSON.stringify(momoSnapshot);
    if (!inFlight.has(key)) {
      const startedAt = Date.now();
      const attempt = { cancelled: false, controllers: new Set() };
      let timeout;
      const deadline = new Promise((resolve, reject) => {
        timeout = setTimeout(() => reject(sourceFailure('snapshot:deadline', 'SNAPSHOT_TIMEOUT')), overallTimeoutMs);
      });
      const promise = Promise.race([deadline, loadSnapshot(attempt, momoSnapshot)]).catch(error => {
        cancelAttempt(attempt);
        reportFailure(error, startedAt);
        return unavailable();
      }).finally(() => {
        clearTimeout(timeout);
        inFlight.delete(key);
      });
      inFlight.set(key, promise);
    }
    return inFlight.get(key);
  }
  return { getSnapshot };
}

module.exports = { SOURCES, createSp500ContributorsService, parseIndexTopHoldings, parseHoldingIdentities, parseNasdaqMarketCap, parseNasdaqScreener, parseNasdaqQuote, parseNasdaqTime, publishedDateIsCurrent };
