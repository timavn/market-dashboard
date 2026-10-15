const { createHash } = require('node:crypto');
const { fetchYahooAdjustedHistoryData } = require('../providers/yahooAdjustedHistory.cjs');
const { parseCboeHistoryCsv } = require('../volatilitySnapshotService.cjs');
const { expectedSizingSession } = require('../../utils/volatilitySizingBand.cjs');
const { isTradingDateKey, previousTradingDateKey } = require('../../utils/usEquityMarketCalendar.cjs');
const { CATALOG_VERSION, PCA_REFERENCES } = require('./pcaCatalog.cjs');
const { pcaOutOfScopeReason } = require('./pcaScope.cjs');

const ACCOUNT_MAX_AGE_MS = 300000;
const HISTORY_CACHE_MS = 15 * 60000;
const REQUEST_TIMEOUT_MS = 6000;
const MAX_HOLDINGS = 100;
const MAX_CANDIDATES = 20;
const BAD_FLAGS = ['stale', 'cacheOnly', 'cached', 'fromCache', 'mock', 'isMock', 'seed', 'seeded', 'isSeed', 'isSeeded', 'synthetic', 'inferred', 'fallback', 'offline', 'disconnected'];
const number = value => value != null && !(typeof value === 'string' && value.trim() === '') && typeof value !== 'boolean' && Number.isFinite(Number(value)) ? Number(value) : null;
const symbolOf = value => String(value || '').trim().toUpperCase();
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const validSymbol = symbol => /^[A-Z][A-Z0-9]{0,9}(?:[.-][A-Z])?$/.test(symbol);
const yahooSymbol = symbol => symbol.replace(/\.([AB])$/, '-$1');
const sessionFormatters = new Map();

class PcaDataError extends Error {
  constructor(code, message) { super(message); this.name = 'PcaDataError'; this.code = code; }
}
function rejected(value, ignoreStatus = false) {
  return Boolean(value && (BAD_FLAGS.some(key => value[key] === true)
    || value.connected === false || value.liveSessionVerified === false || value.available === false
    || value.ok === false || value.success === false || value.error
    || (!ignoreStatus && /^(offline|disconnected|error|failed|unavailable|stale|cached|cache-only|mock|seeded)$/i.test(String(value.status || value.state || '')))
    || ['source', 'dataSource', 'provider'].some(key => /(?:^|[_ -])(mock|seeded|synthetic|inferred|fallback|offline|disconnected)(?:$|[_ -])/i.test(String(value[key] || '')))));
}
function assertWindow(window = 126) {
  if (!Number.isInteger(window) || window < 63 || window > 504) {
    throw new PcaDataError('invalid_window', 'Choose a PCA window from 63 to 504 trading sessions.');
  }
  return window;
}
function sessionDates(sessionDate, window) {
  assertWindow(window);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(sessionDate || '')) || !isTradingDateKey(sessionDate)) {
    throw new PcaDataError('invalid_session', 'A completed US trading session is required.');
  }
  const dates = [sessionDate];
  while (dates.length <= window) dates.unshift(previousTradingDateKey(dates[0]));
  return dates;
}
function transformPair(previous, current, transform) {
  const a = number(previous); const b = number(current);
  if (a === null || b === null) return null;
  if (['yield_change_bp', 'spread_change_bp'].includes(transform)) return (b - a) * 100;
  if (transform === 'volatility_change') return a > 0 && b > 0 ? b - a : null;
  if (!(a > 0 && b > 0)) return null;
  if (transform === 'fx_inverse_return') return a / b - 1;
  if (['adjusted_return', 'fx_return'].includes(transform)) return b / a - 1;
  return null;
}
function alignedValues(levels, priceDates, transform) {
  const byDate = new Map(levels.map(row => [row.date, row.value]));
  return priceDates.slice(1).map((date, index) => transformPair(byDate.get(priceDates[index]), byDate.get(date), transform));
}
function providerSessionDate(timestamp, timeZone) {
  try {
    if (!timeZone) throw new Error('Missing provider timezone');
    if (!sessionFormatters.has(timeZone)) {
      sessionFormatters.set(timeZone, new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }));
      if (sessionFormatters.size > 16) sessionFormatters.delete(sessionFormatters.keys().next().value);
    }
    return sessionFormatters.get(timeZone).format(new Date(timestamp * 1000));
  } catch { throw new PcaDataError('history_timezone_unverified', 'Daily history session timezone could not be verified.'); }
}
async function mapLimit(items, limit, fn) {
  const output = new Array(items.length); let index = 0;
  await Promise.all(Array.from({ length: Math.min(items.length, limit) }, async () => {
    while (index < items.length) { const current = index++; output[current] = await fn(items[current], current); }
  }));
  return output;
}
function verifiedPortfolio(portfolio, account, sessionDate, nowMs) {
  const nav = portfolio?.accountSummary;
  const fresh = value => {
    const age = nowMs - Date.parse(String(value || ''));
    return Number.isFinite(age) && age >= -5000 && age <= ACCOUNT_MAX_AGE_MS;
  };
  if (!portfolio || portfolio.dataSource !== 'ibkr_api' || portfolio.liveSessionVerified !== true
    || portfolio.fromCache !== false || !Array.isArray(portfolio.holdings)
    || [portfolio, portfolio._cache, nav].some(value => rejected(value))) {
    throw new PcaDataError('portfolio_unverified', 'Current verified broker positions and NAV are unavailable.');
  }
  const accountId = String(portfolio.accountId || nav?.accountId || '');
  if (!accountId || (account && accountId !== account)
    || (nav?.accountId && nav.accountId !== accountId)) {
    throw new PcaDataError('account_mismatch', 'Broker portfolio account identity could not be verified.');
  }
  const times = [portfolio.fetchedAt, portfolio.socketVerifiedAt, nav?.lastUpdated, nav?.socketVerifiedAt];
  if (nav?.source !== 'ibkr_live_session' || !(number(nav.netLiquidation) > 0) || !times.every(fresh)) {
    throw new PcaDataError('portfolio_stale', 'Refresh broker positions and NAV before capturing PCA risk.');
  }
  if (symbolOf(nav.currency || nav.baseCurrency) !== 'USD') {
    throw new PcaDataError('unsupported_account_currency', 'PCA currently requires a verified USD account valuation.');
  }
  const quality = portfolio.dataQuality;
  const datedQuality = ['reference', 'mixed', 'warming'].includes(quality?.markState)
    && ['stale', 'partial'].includes(quality?.status);
  if (rejected(quality, datedQuality)) throw new PcaDataError('portfolio_unverified', 'Current broker valuation is unavailable.');
  if (sessionDate !== expectedSizingSession(nowMs)) {
    throw new PcaDataError('session_mismatch', 'Use the latest completed session with the current verified positions.');
  }
  return { accountId, nav: number(nav.netLiquidation), times };
}
function holdingIssue(holding, sessionDate, nowMs, accountId) {
  if (holding.accountId && holding.accountId !== accountId) return 'account_mismatch';
  const type = symbolOf(holding.secType || holding.securityType || holding.assetType);
  if (!['STK', 'STOCK', 'EQUITY', 'ETF', 'ETP'].includes(type)) return 'unsupported_instrument';
  if (symbolOf(holding.currency) !== 'USD') return 'base_currency_conversion_unavailable';
  if (!validSymbol(symbolOf(holding.symbol))) return 'security_identity_unverified';
  if (holding.positionSource !== 'ibkr_live_session' || [holding, holding._cache, holding.dataQuality].some(value => rejected(value))
    || number(holding.quantity) === null) return 'position_unverified';
  const observed = Date.parse(String(holding.referenceCloseObservedAt || ''));
  if (!(number(holding.referenceClose) > 0) || holding.referenceCloseSource !== 'ibkr_historical_daily_close'
    || holding.referenceCloseSessionDate !== sessionDate || !Number.isFinite(observed)
    || observed < Date.parse(`${sessionDate}T00:00:00Z`) || observed > nowMs + 5000) return 'official_close_unavailable';
  return null;
}

function createPcaDataSource({ getPortfolioSnapshot, httpClient = require('axios'), now = () => new Date(), fredApiKey = process.env.FRED_API_KEY } = {}) {
  if (typeof getPortfolioSnapshot !== 'function') throw new TypeError('getPortfolioSnapshot is required');
  const cache = new Map(); const inFlight = new Map(); const circuits = new Map();
  const get = async (url, options) => httpClient.get(url, { ...options, timeout: REQUEST_TIMEOUT_MS, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  const transport = { get };

  async function loadHistory(definition, priceDates) {
    const sessionDate = priceDates.at(-1);
    const key = `${definition.provider}:${definition.symbol}:${definition.transform}:${priceDates[0]}:${sessionDate}`;
    const currentMs = now().getTime();
    const stored = cache.get(key);
    if (stored && currentMs - stored.savedAt < HISTORY_CACHE_MS) return stored.history;
    cache.delete(key);
    if (inFlight.has(key)) return inFlight.get(key);
    const circuit = circuits.get(definition.provider);
    if (circuit?.failures >= 3 && currentMs - circuit.at < 30000) {
      throw new PcaDataError('history_unavailable', 'Daily history provider is unavailable.');
    }
    const pending = (async () => {
      try {
        const history = await fetchHistory(definition, priceDates);
        circuits.delete(definition.provider);
        cache.set(key, { savedAt: now().getTime(), history });
        while (cache.size > 300) cache.delete(cache.keys().next().value);
        return history;
      } catch (error) {
        // Invalid instrument-specific data must not suppress other securities.
        if (!(error instanceof PcaDataError) && (error.isAxiosError || ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ERR_CANCELED', 'ENOTFOUND'].includes(error.code))) {
          const previous = circuits.get(definition.provider);
          circuits.set(definition.provider, { failures: (previous?.failures || 0) + 1, at: now().getTime() });
        }
        throw error instanceof PcaDataError ? error : new PcaDataError('history_unavailable', 'Verified daily history is unavailable.');
      }
    })().finally(() => inFlight.delete(key));
    inFlight.set(key, pending);
    return pending;
  }

  async function fetchHistory(definition, priceDates) {
    const first = priceDates[0]; const last = priceDates.at(-1);
    const period1 = String(Math.floor(Date.parse(`${first}T00:00:00Z`) / 1000));
    const period2 = String(Math.floor((Date.parse(`${last}T00:00:00Z`) + 86400000) / 1000));
    let levels; let raw; let metadata = {}; let events = {}; let sourceUrl;
    if (definition.provider === 'yahoo' && definition.transform === 'adjusted_return') {
      const history = await fetchYahooAdjustedHistoryData({ symbol: definition.symbol, httpClient: transport, period1, period2, now: now().getTime() });
      metadata = history.metadata;
      raw = history.rawResponse;
      validateYahoo(raw, metadata, definition, true);
      levels = history.bars.map(row => ({ date: row.date, value: row.adjustedClose }));
      events = history.events;
      sourceUrl = history.sourceUrl;
    } else if (definition.provider === 'yahoo') {
      sourceUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(definition.symbol)}`;
      // Include the UTC evening before the first local FX session as well.
      const response = await get(sourceUrl, { params: { period1: String(Number(period1) - 86400), period2, interval: '1d', includePrePost: 'false' } });
      raw = response.data;
      const result = raw?.chart?.result?.[0]; metadata = result?.meta || {};
      validateYahoo(raw, metadata, definition, false);
      const closes = result.indicators?.quote?.[0]?.close || [];
      // FX midnight bars use the vendor's local session date. In British
      // Summer Time their UTC timestamp is 23:00 on the preceding date.
      levels = (result.timestamp || []).map((timestamp, i) => ({ date: providerSessionDate(timestamp, metadata.exchangeTimezoneName), value: number(closes[i]) }));
      const end = number(metadata.currentTradingPeriod?.regular?.end);
      const start = number(metadata.currentTradingPeriod?.regular?.start);
      if (end && now().getTime() / 1000 < end && start) {
        levels = levels.filter((_, i) => result.timestamp[i] < start);
      }
    } else if (definition.provider === 'fred') {
      const apiKey = fredApiKey;
      if (apiKey) {
        sourceUrl = 'https://api.stlouisfed.org/fred/series/observations';
        const response = await get(sourceUrl, { params: { series_id: definition.symbol, api_key: apiKey, file_type: 'json', observation_start: first, observation_end: last, sort_order: 'asc' } });
        raw = response.data;
        if (rejected(raw) || !Array.isArray(raw?.observations)) throw new PcaDataError('history_unverified', 'Daily reference history is unavailable.');
        levels = raw.observations.map(row => ({ date: row.date, value: number(row.value) }));
      } else {
        sourceUrl = 'https://fred.stlouisfed.org/graph/fredgraph.csv';
        const response = await get(sourceUrl, { params: { id: definition.symbol, cosd: first, coed: last }, responseType: 'text' });
        raw = response.data;
        const lines = String(raw || '').trim().split(/\r?\n/);
        const headers = lines.shift()?.replace(/^\uFEFF/, '').split(',');
        if (!headers || !['DATE', 'observation_date'].includes(headers[0]) || headers[1] !== definition.symbol) {
          throw new PcaDataError('history_unverified', 'Daily reference history is unavailable.');
        }
        levels = lines.map(line => { const [date, value] = line.split(','); return { date, value: number(value) }; });
      }
      // The API key is deliberately absent from sourceUrl and stored evidence.
      sourceUrl += `?${new URLSearchParams({ series_id: definition.symbol, observation_start: first, observation_end: last })}`;
      metadata = { units: definition.units, frequency: 'daily' };
    } else if (definition.provider === 'cboe') {
      sourceUrl = `https://cdn.cboe.com/api/global/us_indices/daily_prices/${definition.symbol}_History.csv`;
      const response = await get(sourceUrl, { responseType: 'text' }); raw = response.data;
      if (!/^\s*(?:\uFEFF)?DATE,OPEN,HIGH,LOW,CLOSE\s*$/im.test(String(raw))) {
        throw new PcaDataError('history_unverified', 'Daily volatility history is unavailable.');
      }
      levels = parseCboeHistoryCsv(raw).map(row => ({ date: row.date, value: row.close }));
    }
    const selected = (levels || []).filter(row => /^\d{4}-\d{2}-\d{2}$/.test(row.date) && row.date >= first && row.date <= last);
    const seen = new Set();
    for (const row of selected) {
      if (seen.has(row.date)) throw new PcaDataError('history_duplicate_dates', 'Daily history contains conflicting session observations.');
      seen.add(row.date);
    }
    if (!selected.some(row => number(row.value) !== null)) throw new PcaDataError('history_unavailable', 'Verified daily history is unavailable.');
    return {
      levels: selected.sort((a, b) => a.date.localeCompare(b.date)),
      provider: definition.provider, sourceUrl, fetchedAt: now().toISOString(),
      sourceHash: hash(raw), symbol: definition.symbol, transform: definition.transform,
      metadata: { symbol: metadata.symbol || definition.symbol, currency: metadata.currency || null, instrumentType: metadata.instrumentType || null, exchangeTimezone: metadata.exchangeTimezoneName || null, units: definition.units || null },
      corporateActions: events,
    };
  }

  function validateYahoo(raw, metadata, definition, adjusted) {
    const result = raw?.chart?.result?.[0];
    if ([raw, raw?.chart, result, metadata].some(value => rejected(value))
      || raw?.chart?.error || !result || metadata.dataGranularity !== '1d'
      || symbolOf(metadata.symbol) !== symbolOf(definition.symbol)
      || symbolOf(metadata.currency) !== definition.currency
      || (adjusted && (!['EQUITY', 'ETF'].includes(metadata.instrumentType) || metadata.exchangeTimezoneName !== 'America/New_York'))
      || (!adjusted && metadata.instrumentType !== 'CURRENCY')) {
      throw new PcaDataError('security_identity_unverified', 'Daily history identity, currency, or source could not be verified.');
    }
    const timestamps = result.timestamp;
    if (!Array.isArray(timestamps) || timestamps.some(value => !Number.isFinite(value) || !Number.isFinite(new Date(value * 1000).getTime()))
      // Raw FX feeds can append a second mark in the unfinished current session.
      // Its bars are removed above; completed FX dates still must be unique in
      // fetchHistory's selected-level validation before any return is calculated.
      || (adjusted && new Set(timestamps.map(value => providerSessionDate(value, metadata.exchangeTimezoneName))).size !== timestamps.length)) {
      throw new PcaDataError('history_unverified', 'Daily history contains invalid session observations.');
    }
  }

  const securityDefinition = symbol => ({ symbol: yahooSymbol(symbol), provider: 'yahoo', currency: 'USD', transform: 'adjusted_return' });
  async function securityHistory(symbol, priceDates) {
    const history = await loadHistory(securityDefinition(symbol), priceDates);
    const returns = alignedValues(history.levels, priceDates, 'adjusted_return');
    if (returns.some(value => value === null || !Number.isFinite(value))) {
      throw new PcaDataError('history_gap', 'A full consecutive window of adjusted daily closes is required.');
    }
    return { history, returns };
  }

  async function capture({ account, window = 126, sessionDate = expectedSizingSession(now().getTime()) } = {}) {
    const priceDates = sessionDates(sessionDate, window);
    let portfolio;
    try { portfolio = await getPortfolioSnapshot(account); }
    catch { throw new PcaDataError('portfolio_unavailable', 'Current verified broker positions and NAV are unavailable.'); }
    const capturedAt = now();
    const verified = verifiedPortfolio(portfolio, account, sessionDate, capturedAt.getTime());
    const allRows = portfolio.holdings.map(row => row || {});
    // Classify the instrument before testing equity data coverage. Event contracts
    // and other non-equities do not belong in the PCA universe or its denominator.
    const outOfScope = [...new Map(allRows.filter(row => number(row.quantity) !== 0).flatMap(row => {
      const reason = pcaOutOfScopeReason(row);
      if (!reason) return [];
      const id = String(row.conid ?? row.conId ?? row.positionId ?? row.localSymbol ?? row.symbol ?? 'unknown');
      return [[`${reason}:${id}`, { id, symbol: symbolOf(row.symbol), reason }]];
    })).values()];
    const equityRows = allRows.filter(row => !pcaOutOfScopeReason(row));
    const activeRows = equityRows.filter(row => number(row.quantity) !== 0);
    const activeSymbols = new Set(activeRows.map(row => symbolOf(row.symbol)).filter(Boolean));
    const activeConids = new Set(activeRows.filter(row => row.conid != null).map(row => String(row.conid)));
    // A zero row can contradict an active aggregate position. Keep it for
    // identity checks, while omitting genuinely closed, all-zero securities.
    const source = equityRows.filter(row => number(row.quantity) !== 0
      || activeSymbols.has(symbolOf(row.symbol))
      || (row.conid != null && activeConids.has(String(row.conid))));
    if (source.length > MAX_HOLDINGS) throw new PcaDataError('portfolio_limit', `PCA supports up to ${MAX_HOLDINGS} holding rows per capture.`);
    const excluded = []; const groups = new Map(); const holdingEvidence = [];
    let knownGross = 0; let fullGrossKnown = true;
    for (const [index, holding] of source.entries()) {
      const symbol = symbolOf(holding.symbol);
      const id = symbol || String(holding.positionId || holding.conid || `unknown-${index}`);
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id).push(holding);
    }
    const inputs = [];
    // IBKR position rows are aggregate positions, not tax lots. Repeated rows
    // must never be added together: duplicate delivery otherwise doubles risk.
    const symbolsByConid = new Map();
    for (const holding of source) {
      if (holding.conid == null) continue;
      const conid = String(holding.conid);
      if (!symbolsByConid.has(conid)) symbolsByConid.set(conid, new Set());
      symbolsByConid.get(conid).add(symbolOf(holding.symbol));
    }
    for (const [id, rows] of groups) {
      const holding = rows[0]; const symbol = symbolOf(holding.symbol);
      const reason = rows.map(row => holdingIssue(row, sessionDate, capturedAt.getTime(), verified.accountId)).find(Boolean);
      if (reason) { excluded.push({ id, symbol, reason }); fullGrossKnown = false; continue; }
      const conids = new Set(rows.map(row => row.conid == null ? null : String(row.conid)));
      if (conids.size > 1 || [...conids].some(conid => conid != null && symbolsByConid.get(conid).size > 1)
        || rows.some(row => number(row.referenceClose) !== number(holding.referenceClose))) {
        excluded.push({ id, symbol, reason: 'security_identity_collision' }); fullGrossKnown = false; continue;
      }
      if (rows.some(row => number(row.quantity) !== number(holding.quantity))) {
        excluded.push({ id, symbol, reason: 'position_unverified' }); fullGrossKnown = false; continue;
      }
      const quantity = number(holding.quantity); const close = number(holding.referenceClose);
      const weight = quantity * close / verified.nav;
      knownGross += Math.abs(weight);
      holdingEvidence.push({ id, symbol, conid: holding.conid || null, quantity, referenceClose: close, referenceCloseSource: holding.referenceCloseSource, referenceCloseSessionDate: sessionDate, referenceCloseObservedAt: holding.referenceCloseObservedAt, currency: 'USD', sourceRowCount: rows.length });
      inputs.push({ id, symbol, name: String(holding.description || holding.name || symbol), weight });
    }
    const evidence = [];
    const results = await mapLimit(inputs, 6, async input => {
      try {
        const data = await securityHistory(input.symbol, priceDates);
        evidence.push(data.history);
        if (data.returns.every(value => value === data.returns[0])) throw new PcaDataError('zero_variance_history', 'Daily return variation is required to standardize a holding.');
        return { ...input, returns: data.returns };
      }
      catch (error) { excluded.push({ id: input.id, symbol: input.symbol, reason: error.code || 'history_unavailable' }); return null; }
    });
    const assets = results.filter(Boolean);
    const references = await mapLimit(PCA_REFERENCES, 6, async definition => {
      try {
        const history = await loadHistory(definition, priceDates);
        evidence.push(history);
        return { id: definition.id, label: definition.label, group: definition.group, transform: definition.transform,
          asOf: history.levels.filter(row => number(row.value) !== null).at(-1)?.date || null,
          values: alignedValues(history.levels, priceDates, definition.transform), source: definition.provider };
      } catch (error) {
        return { id: definition.id, label: definition.label, group: definition.group, transform: definition.transform,
          asOf: null, values: priceDates.slice(1).map(() => null), source: definition.provider, reason: error.code || 'history_unavailable' };
      }
    });
    const uniqueEvidence = [...new Map(evidence.map(row => [`${row.provider}:${row.symbol}:${row.transform}`, row])).values()]
      .sort((a, b) => `${a.provider}:${a.symbol}`.localeCompare(`${b.provider}:${b.symbol}`));
    holdingEvidence.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    const provenance = {
      holdingsObservedAt: portfolio.fetchedAt, navObservedAt: portfolio.accountSummary.lastUpdated,
      socketVerifiedAt: portfolio.socketVerifiedAt, capturedAt: capturedAt.toISOString(), sessionDate,
      currency: 'USD', valuationBasis: 'current signed broker quantities × official session close / current broker NAV',
      historicalOnly: true, executable: false, catalogVersion: CATALOG_VERSION,
      historyCount: uniqueEvidence.length, sources: [...new Set(uniqueEvidence.map(row => row.provider))],
      inputHash: hash({ holdings: holdingEvidence, nav: verified.nav, window, sessionDate, histories: uniqueEvidence.map(row => ({ provider: row.provider, symbol: row.symbol, transform: row.transform, sourceHash: row.sourceHash })) }),
    };
    return { assets, dates: priceDates.slice(1), references, accountId: verified.accountId, provenance,
      evidence: { holdings: holdingEvidence, nav: verified.nav, histories: uniqueEvidence },
      coverage: { scope: 'equities-etfs', holdingCount: groups.size, modeledCount: assets.length, excluded, outOfScope,
        modeledGrossWeight: assets.reduce((sum, row) => sum + Math.abs(row.weight), 0),
        ...(fullGrossKnown ? { totalGrossWeight: knownGross } : {}), complete: excluded.length === 0 } };
  }

  async function candidates({ symbols, dates, sessionDate, window = 126 } = {}) {
    if (!Array.isArray(symbols) || symbols.length === 0 || symbols.length > MAX_CANDIDATES) {
      throw new PcaDataError('candidate_limit', `Compare between 1 and ${MAX_CANDIDATES} candidate securities.`);
    }
    const normalized = [...new Set(symbols.map(symbolOf))];
    if (normalized.some(symbol => !validSymbol(symbol))) throw new PcaDataError('invalid_candidate', 'Enter a valid US stock or ETF ticker.');
    const priceDates = sessionDates(sessionDate, window);
    if (sessionDate > expectedSizingSession(now().getTime()) || !Array.isArray(dates)
      || JSON.stringify(dates) !== JSON.stringify(priceDates.slice(1))) {
      throw new PcaDataError('candidate_dates_mismatch', 'Candidates must use the saved PCA session and exact observation window.');
    }
    return mapLimit(normalized, 6, async symbol => {
      try {
        const data = await securityHistory(symbol, priceDates);
        return { id: symbol, symbol, name: symbol, returns: data.returns,
          provenance: { provider: data.history.provider, symbol: data.history.symbol, sourceHash: data.history.sourceHash, fetchedAt: data.history.fetchedAt, sessionDate },
          evidence: data.history };
      } catch (error) {
        throw new PcaDataError(error.code || 'candidate_unavailable', `${symbol}: verified USD stock/ETF history is unavailable for this PCA window.`);
      }
    });
  }
  return { capture, candidates };
}

module.exports = { createPcaDataSource, PcaDataError, ACCOUNT_MAX_AGE_MS, sessionDates, transformPair, alignedValues };
