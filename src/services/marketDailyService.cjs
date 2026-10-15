'use strict';

const readExcelFileModule = require('read-excel-file/universal');
const { membershipDateIsUsable } = require('../utils/marketDailyMembership.cjs');
const { mergeMarketDailyReference, retainMarketDailyReference, validateMarketDailyReference } = require('../utils/marketDailyReference.cjs');
const { createMarketDailyReferenceStore } = require('./marketDailyReferenceStore.cjs');

const readExcelFile = readExcelFileModule.default || readExcelFileModule;
const HOLDINGS_ROOT = 'https://www.ssga.com/library-content/products/fund-data/etfs/us';
const SECTORS = Object.freeze([
  ['XLK', 'Technology'], ['XLF', 'Financials'], ['XLV', 'Health Care'],
  ['XLY', 'Consumer Discretionary'], ['XLP', 'Consumer Staples'], ['XLI', 'Industrials'],
  ['XLB', 'Materials'], ['XLE', 'Energy'], ['XLU', 'Utilities'],
  ['XLRE', 'Real Estate'], ['XLC', 'Communication Services'],
].map(([ticker, name]) => Object.freeze({ ticker, name })));

const holdingsUrl = ticker => `${HOLDINGS_ROOT}/holdings-daily-us-en-${ticker.toLowerCase()}.xlsx`;
const unavailable = (loading = false) => ({ status: 'unavailable', loading });

function flaggedUnavailable(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  return Object.entries(value).some(([key, item]) => {
    if (/^(mock|isMock|seed|seeded|isSeed|synthetic|simulated|stale|isStale|cacheOnly|fromCache|cached|offline|disconnected)$/i.test(key) && item === true) return true;
    if (/^(available|connected|valid)$/i.test(key) && item === false) return true;
    if (/^(source|provider|status|availability|freshness|warning)$/i.test(key) && typeof item === 'string'
      && /mock|seed|synthetic|simulat|stale|cache.?only|offline|disconnect|unavailable|error/i.test(item)) return true;
    return item && typeof item === 'object' && flaggedUnavailable(item, seen);
  });
}

function parseHoldingsWorkbook(workbook, { ticker, nowMs }) {
  if (flaggedUnavailable(workbook)) throw new Error('Holdings unavailable');
  const rows = Array.isArray(workbook?.[0]?.data) ? workbook[0].data : workbook;
  if (!Array.isArray(rows)) throw new Error('Holdings unavailable');
  const publication = rows.find(row => Array.isArray(row) && row[0] === 'Holdings:')?.[1];
  const match = /^As of (\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(String(publication || '').trim());
  const parsedDate = match && Date.parse(`${match[2]} ${match[1]}, ${match[3]} 12:00:00 GMT`);
  const asOf = Number.isFinite(parsedDate) ? new Date(parsedDate).toISOString().slice(0, 10) : null;
  if (!asOf || !membershipDateIsUsable(asOf, nowMs)) throw new Error('Holdings publication invalid');
  const headerIndex = rows.findIndex(row => Array.isArray(row) && row[0] === 'Name' && row[1] === 'Ticker');
  if (headerIndex < 0) throw new Error('Holdings header unavailable');
  const header = rows[headerIndex];
  const weightIndex = header.indexOf('Weight');
  const identifierIndex = header.indexOf('Identifier');
  if (weightIndex < 0 || (ticker === 'SPY' && identifierIndex < 0)) throw new Error('Holdings fields unavailable');
  const members = [];
  const seen = new Set();
  for (const row of rows.slice(headerIndex + 1)) {
    const symbol = typeof row?.[1] === 'string' ? row[1].trim() : '';
    if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol) || !row[0]) continue;
    // SPY's cash and derivative rows are not constituent securities.
    if (ticker === 'SPY' && !/^[A-Z0-9]{9}$/.test(String(row[identifierIndex] || ''))) continue;
    const weightPct = row[weightIndex];
    // Sector funds can publish short futures overlays. Membership uses only
    // their positive holdings, then intersects those holdings with SPY equities.
    if (ticker !== 'SPY' && typeof weightPct === 'number' && Number.isFinite(weightPct) && weightPct <= 0) continue;
    if (typeof weightPct !== 'number' || !Number.isFinite(weightPct) || weightPct <= 0 || weightPct > 100) {
      throw new Error('Holdings weight invalid');
    }
    if (seen.has(symbol)) throw new Error('Duplicate holding');
    seen.add(symbol);
    members.push({ ticker: symbol, name: String(row[0]).trim(), weightPct });
  }
  if (ticker === 'SPY') {
    const weight = members.reduce((sum, member) => sum + member.weightPct, 0);
    if (members.length < 500 || members.length > 550 || weight < 90 || weight > 101) throw new Error('Holdings coverage invalid');
  } else if (!members.length) throw new Error('Sector holdings unavailable');
  return { members, asOf, sourceUrl: holdingsUrl(ticker) };
}

function chartUrl(ticker, range, interval) {
  const yahooTicker = ticker.replace(/\.([AB])$/, '-$1');
  const params = new URLSearchParams({ range, interval, includePrePost: 'false', includeAdjustedClose: 'true', events: 'div,splits' });
  return `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooTicker)}?${params}`;
}

function createMarketDailyService({
  fetchImpl = global.fetch,
  xlsxReader = readExcelFile,
  now = Date.now,
  concurrency = 8,
  refreshMs = 5 * 60_000,
  membershipRefreshMs = 30 * 60_000,
  requestTimeoutMs = 8_000,
  overallTimeoutMs = 180_000,
  onDiagnostic = () => {},
  metrics = require('./marketDailyMetrics.cjs'),
  referencePath,
} = {}) {
  const width = Math.max(1, Math.min(16, Math.trunc(concurrency) || 8));
  const referenceStore = createMarketDailyReferenceStore({ referencePath, now });
  let snapshot = referenceStore.read() || unavailable();
  let membership = null;
  let membershipFetchedAt = 0;
  let completedAt = -Infinity;
  let inFlight = null;
  let activeAttempt = null;
  let disposed = false;
  const histories = new Map();
  const currentMs = () => Number(now());
  const yieldToServer = () => new Promise(resolve => setImmediate(resolve));
  function report(attempt, code, values = {}) {
    try { onDiagnostic({ stage: 'collection', code, elapsedMs: Math.max(0, Date.now() - attempt.startedAt),
      requestFailures: attempt.requestFailures, ...values }); } catch { /* Diagnostics do not affect collection. */ }
  }

  async function request(url, type, attempt) {
    if (attempt.cancelled) throw new Error('Refresh cancelled');
    const controller = new AbortController();
    attempt.controllers.add(controller);
    let timer;
    try {
      const deadline = new Promise((resolve, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error('Provider timeout')); }, requestTimeoutMs);
      });
      return await Promise.race([deadline, (async () => {
        const response = await fetchImpl(url, {
          signal: controller.signal, cache: 'no-store',
          headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Encoding': 'identity', Accept: type === 'xlsx'
            ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'application/json' },
        });
        if (!response?.ok || flaggedUnavailable(response)) throw new Error('Provider unavailable');
        const value = type === 'xlsx' ? await xlsxReader(await response.arrayBuffer()) : await response.json();
        if (attempt.cancelled || flaggedUnavailable(value)) throw new Error('Provider unavailable');
        return value;
      })()]);
    } catch (error) {
      attempt.requestFailures += 1;
      throw error;
    } finally {
      clearTimeout(timer);
      attempt.controllers.delete(controller);
    }
  }

  async function bounded(items, operation, attempt) {
    let index = 0;
    await Promise.all(Array.from({ length: Math.min(width, items.length) }, async () => {
      while (!attempt.cancelled && index < items.length) {
        const item = items[index++];
        try { await operation(item); } catch { /* Missing evidence is withheld by the snapshot builder. */ }
        await yieldToServer();
      }
    }));
  }

  async function loadMembership(attempt) {
    const nowMs = currentMs();
    if (membership && nowMs - membershipFetchedAt < membershipRefreshMs
      && membershipDateIsUsable(membership.asOf, nowMs)) return membership;
    const publications = new Map();
    await bounded(['SPY', ...SECTORS.map(row => row.ticker)], async ticker => {
      const book = await request(holdingsUrl(ticker), 'xlsx', attempt);
      publications.set(ticker, parseHoldingsWorkbook(book, { ticker, nowMs: currentMs() }));
    }, attempt);
    if (attempt.cancelled || activeAttempt !== attempt || disposed) throw new Error('Refresh cancelled');
    attempt.membershipPublications = publications.size;
    const spy = publications.get('SPY');
    if (!spy) { membership = null; throw new Error('Membership unavailable'); }
    const memberSet = new Set(spy.members.map(row => row.ticker));
    const sectorByTicker = new Map();
    const conflicts = new Set();
    for (const sector of SECTORS) {
      const publication = publications.get(sector.ticker);
      if (!publication) continue;
      for (const row of publication.members) {
        if (!memberSet.has(row.ticker)) continue;
        if (sectorByTicker.has(row.ticker)) conflicts.add(row.ticker);
        sectorByTicker.set(row.ticker, { ...sector, sourceUrl: publication.sourceUrl, asOf: publication.asOf });
      }
    }
    for (const ticker of conflicts) sectorByTicker.delete(ticker);
    membership = { ...spy, sectorByTicker };
    membershipFetchedAt = currentMs();
    for (const ticker of histories.keys()) if (!memberSet.has(ticker)) histories.delete(ticker);
    return membership;
  }

  async function loadChart(ticker, range, interval, attempt) {
    const url = chartUrl(ticker, range, interval);
    const payload = await request(url, 'json', attempt);
    const parser = interval === '1d' ? metrics.parseDailyChart : metrics.parseIntradayChart;
    return parser(payload, { ticker, nowMs: currentMs(), sourceUrl: url });
  }

  async function refresh(attempt) {
    const roster = await loadMembership(attempt);
    if (attempt.cancelled) return;
    const dailyByTicker = new Map();
    const intradayByTicker = new Map();
    const sectorDailyByTicker = new Map();
    const jobs = [...SECTORS.map(row => ({ ...row, sector: true })), ...roster.members];
    await bounded(jobs, async member => {
      let daily;
      try { daily = await loadChart(member.ticker, '1y', '1d', attempt); } catch { daily = null; }
      if (attempt.cancelled) return;
      const target = member.sector ? sectorDailyByTicker : dailyByTicker;
      if (daily) target.set(member.ticker, { ...daily, name: member.name });
      if (member.sector || !daily) return;
      try {
        const history = histories.get(member.ticker);
        // A new market date requires yesterday's complete session, including its
        // final bars and any corporate-action restatements of earlier history.
        const reuseHistory = history?.marketDate === daily.marketDate;
        const current = await loadChart(member.ticker, reuseHistory ? '1d' : '60d', '30m', attempt);
        if (!current || attempt.cancelled || activeAttempt !== attempt || disposed) return;
        const combined = reuseHistory ? metrics.mergeIntradayHistory(history, current) : current;
        if (!combined) return;
        // These observations are used as history only. Every refresh must verify
        // a new current session response before a cached history enters output.
        histories.set(member.ticker, combined);
        intradayByTicker.set(member.ticker, combined);
      } catch { /* Never substitute a cached current reading after a failed request. */ }
    }, attempt);
    if (disposed || attempt.cancelled || activeAttempt !== attempt) return;
    const incoming = metrics.buildMarketDailySnapshot({
      members: roster.members, dailyByTicker, intradayByTicker,
      sectorByTicker: roster.sectorByTicker, sectorDailyByTicker,
      membershipAsOf: roster.asOf, nowMs: currentMs(),
    });
    snapshot = mergeMarketDailyReference(snapshot, incoming, currentMs()) || unavailable();
    referenceStore.write(snapshot);
    report(attempt, 'SNAPSHOT_COMPLETE', { memberCount: roster.members.length, dailyCount: dailyByTicker.size,
      intradayCount: intradayByTicker.size, sectorCount: sectorDailyByTicker.size,
      mappedSectorCount: roster.sectorByTicker.size });
  }

  function cancel(attempt) {
    attempt.cancelled = true;
    for (const controller of attempt.controllers) controller.abort();
  }

  function startRefresh() {
    if (inFlight || disposed) return;
    const attempt = { cancelled: false, controllers: new Set(), startedAt: Date.now(), requestFailures: 0, membershipPublications: 0 };
    activeAttempt = attempt;
    let timer;
    const deadline = new Promise(resolve => {
      timer = setTimeout(() => { cancel(attempt); resolve(); }, overallTimeoutMs);
    });
    const work = Promise.resolve().then(() => refresh(attempt));
    inFlight = Promise.race([work, deadline]).catch(() => {
      snapshot = retainMarketDailyReference(snapshot, currentMs()) || unavailable();
      report(attempt, 'COLLECTION_UNAVAILABLE', { membershipPublications: attempt.membershipPublications });
    }).then(() => {
      // A timed-out attempt may still have parsers unwinding. Its current data
      // cannot outlive the deadline or publish after a newer attempt starts.
      if (attempt.cancelled) {
        snapshot = retainMarketDailyReference(snapshot, currentMs()) || unavailable();
        report(attempt, 'COLLECTION_TIMEOUT', { membershipPublications: attempt.membershipPublications });
      }
    }).finally(() => {
      cancel(attempt);
      clearTimeout(timer);
      completedAt = currentMs();
      activeAttempt = null;
      inFlight = null;
    });
  }

  function getSnapshot() {
    const nowMs = currentMs();
    if (!disposed && !inFlight && nowMs - completedAt >= refreshMs) startRefresh();
    const visible = validateMarketDailyReference(snapshot, nowMs);
    if (!visible) return unavailable(Boolean(inFlight));
    snapshot = visible;
    return { ...visible, loading: Boolean(inFlight) };
  }

  async function waitForRefresh() {
    if (!inFlight && !disposed) startRefresh();
    await inFlight;
    return getSnapshot();
  }

  function dispose() {
    disposed = true;
    if (activeAttempt) cancel(activeAttempt);
    snapshot = unavailable();
    histories.clear();
  }

  return { getSnapshot, waitForRefresh, dispose };
}

module.exports = { SECTORS, holdingsUrl, chartUrl, parseHoldingsWorkbook, createMarketDailyService };
