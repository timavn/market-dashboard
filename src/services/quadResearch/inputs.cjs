const { createHash } = require('node:crypto');
const { GROUPS } = require('./catalog.cjs');
const { validateIndependentSources } = require('./sourceValidation.cjs');
const { fetchYahooAdjustedHistoryData } = require('../providers/yahooAdjustedHistory.cjs');
const { parseYahooChartBars } = require('../../utils/securityRiskMetrics.cjs');
const { isTradingDateKey, previousTradingDateKey, addCalendarDays } = require('../../utils/usEquityMarketCalendar.cjs');

const FRED_URL = 'https://api.stlouisfed.org/fred/series/observations';
const MACRO_START = '2005-01-01';
const FLAT_ACCELERATION_PP = 0;
const ADJUSTMENT_TOLERANCE = 0.0001; // One basis point for vendor rounding.
const QUARTER_RECONCILIATION_TOLERANCE = 0.0002;

function quarterOrdinal(quarter) {
  const match = /^(\d{4})-Q([1-4])$/.exec(String(quarter));
  if (!match) throw new Error('Invalid research quarter');
  return Number(match[1]) * 4 + Number(match[2]) - 1;
}
function ordinalQuarter(ordinal) { return `${Math.floor(ordinal / 4)}-Q${ordinal % 4 + 1}`; }
function shiftQuarter(quarter, amount) { return ordinalQuarter(quarterOrdinal(quarter) + amount); }
function quarterStart(quarter) {
  const ordinal = quarterOrdinal(quarter);
  return `${Math.floor(ordinal / 4)}-${String((ordinal % 4) * 3 + 1).padStart(2, '0')}-01`;
}
function quarterEnd(quarter) { return addCalendarDays(quarterStart(shiftQuarter(quarter, 1)), -1); }
function dateQuarter(date) { return `${date.slice(0, 4)}-Q${Math.floor((Number(date.slice(5, 7)) - 1) / 3) + 1}`; }
function completeQuarter(now = new Date()) { return shiftQuarter(dateQuarter(new Date(now).toISOString().slice(0, 10)), -1); }
function quarterRange(start, end) {
  return Array.from({ length: Math.max(0, quarterOrdinal(end) - quarterOrdinal(start) + 1) }, (_, i) => ordinalQuarter(quarterOrdinal(start) + i));
}
function finitePositive(value) {
  if (value === '.' || value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}
function sha(payload) { return createHash('sha256').update(JSON.stringify(payload)).digest('hex'); }
function canonicalUrl(url, params) {
  return `${url}?${new URLSearchParams(Object.entries(params).filter(([key]) => key !== 'api_key').sort(([a], [b]) => a.localeCompare(b)))}`;
}
function validateFredPayload(payload) {
  if (!Array.isArray(payload?.observations) || payload.count !== payload.observations.length
    || (Number(payload.offset) || 0) !== 0) throw new Error('fred_response_incomplete');
  if (payload.observations.some((row, index) => !/^\d{4}-\d{2}-\d{2}$/.test(row.date || '')
    || (index > 0 && row.date <= payload.observations[index - 1].date))) throw new Error('fred_duplicate_or_invalid_dates');
  for (const row of payload.observations) {
    for (const [key, value] of Object.entries(row)) {
      if (key !== 'value' && !/^(GDPC1|CPIAUCNS)_\d{8}$/.test(key)) continue;
      if (value !== '.' && finitePositive(value) == null) throw new Error('fred_invalid_observation_value');
    }
  }
  return payload;
}
function inputError(code, context = {}) { return { code, ...context }; }
function marketSessionOnOrBefore(date) { return isTradingDateKey(date) ? date : previousTradingDateKey(date); }
function classifyQuad(growth, inflation) {
  if (!Number.isFinite(growth) || !Number.isFinite(inflation)
    || Math.abs(growth) <= FLAT_ACCELERATION_PP || Math.abs(inflation) <= FLAT_ACCELERATION_PP) return null;
  return growth > 0 ? (inflation > 0 ? 2 : 1) : (inflation > 0 ? 3 : 4);
}

function macroAcceleration(gdpLevels, cpiLevels, quarter) {
  const keys = [quarter, shiftQuarter(quarter, -1), shiftQuarter(quarter, -4), shiftQuarter(quarter, -5)];
  const gdp = keys.map(key => finitePositive(gdpLevels[quarterStart(key)]));
  const cpiMonths = keys.map(key => {
    const start = new Date(`${quarterStart(key)}T12:00:00Z`);
    const months = [0, 1, 2].map(offset => {
      const date = new Date(start); date.setUTCMonth(date.getUTCMonth() + offset);
      return finitePositive(cpiLevels[date.toISOString().slice(0, 10)]);
    });
    return months;
  });
  const growthAcceleration = gdp.some(value => value == null) ? null : 100 * ((gdp[0] / gdp[2]) - (gdp[1] / gdp[3]));
  const inflationAcceleration = cpiMonths.flat().some(value => value == null) ? null : cpiMonths[0].reduce((sum, value, month) => sum
    + 100 * ((value / cpiMonths[2][month]) - (cpiMonths[1][month] / cpiMonths[3][month])), 0) / 3;
  const quad = classifyQuad(growthAcceleration, inflationAcceleration);
  return { quad, growthAcceleration, inflationAcceleration,
    reason: growthAcceleration == null || inflationAcceleration == null ? 'macro_levels_missing' : quad == null ? 'flat_macro_acceleration' : null };
}

function levelsForVintage(payload, seriesId, vintage) {
  const column = `${seriesId}_${vintage.replace(/-/g, '')}`;
  return Object.fromEntries((payload?.observations || []).map(row => [row.date, row[column]]));
}
function latestLevels(payload) { return Object.fromEntries((payload?.observations || []).map(row => [row.date, row.value])); }
function comparisonSourceValues(gdp, cpi, quarter) {
  const dates = [0, -1, -4, -5].map(offset => quarterStart(shiftQuarter(quarter, offset)));
  const months = dates.flatMap(date => [0, 1, 2].map(offset => {
    const value = new Date(`${date}T12:00:00Z`); value.setUTCMonth(value.getUTCMonth() + offset);
    return value.toISOString().slice(0, 10);
  }));
  return { gdp: Object.fromEntries(dates.map(date => [date, finitePositive(gdp[date])])),
    cpi: Object.fromEntries(months.map(date => [date, finitePositive(cpi[date])])) };
}

function buildMacroRows({ firstReleases, gdpVintages, cpiVintages, latestGdp, latestCpi, cutoff, asOf }) {
  const issues = [];
  const rows = [];
  const releases = new Map();
  for (const row of firstReleases?.observations || []) {
    const quarter = dateQuarter(row.date || '');
    if (!/^\d{4}-Q[1-4]$/.test(quarter) || row.date !== quarterStart(quarter)) {
      issues.push(inputError('invalid_gdp_observation_date')); continue;
    }
    if (quarter > cutoff) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row.realtime_start || '') || row.realtime_start > asOf
      || row.realtime_start <= quarterEnd(quarter) || finitePositive(row.value) == null || releases.has(quarter)) {
      issues.push(inputError('invalid_gdp_first_release', { quarter })); continue;
    }
    releases.set(quarter, row);
  }
  const revisedGdp = latestLevels(latestGdp);
  const revisedCpi = latestLevels(latestCpi);
  for (const quarter of quarterRange('2007-Q2', cutoff)) {
    const release = releases.get(quarter);
    const vintage = release?.realtime_start || null;
    const gdp = vintage ? levelsForVintage(gdpVintages, 'GDPC1', vintage) : {};
    const cpi = vintage ? levelsForVintage(cpiVintages, 'CPIAUCNS', vintage) : {};
    if (release && finitePositive(gdp[quarterStart(quarter)]) !== finitePositive(release.value)) {
      issues.push(inputError('first_release_value_mismatch', { quarter })); continue;
    }
    const original = macroAcceleration(gdp, cpi, quarter);
    const latest = macroAcceleration(revisedGdp, revisedCpi, quarter);
    rows.push({ quarter, quad: original.quad, latestQuad: latest.quad,
      growthAcceleration: original.growthAcceleration, inflationAcceleration: original.inflationAcceleration,
      latestGrowthAcceleration: latest.growthAcceleration, latestInflationAcceleration: latest.inflationAcceleration,
      releaseDate: vintage, availableAt: vintage, reason: release ? original.reason : 'gdp_first_release_missing', latestReason: latest.reason,
      sourceValues: comparisonSourceValues(gdp, cpi, quarter),
      latestSourceValues: comparisonSourceValues(revisedGdp, revisedCpi, quarter),
      retrospective: true });
  }
  return { rows, issues, vintagePolicy: 'Each quarter uses all comparison levels available on its first GDP release date.',
    growthSeries: 'GDPC1', inflationSeries: 'CPIAUCNS', inflationAggregation: 'Arithmetic mean of the three monthly year-over-year inflation rates in each quarter.',
    interpretation: 'Retrospective same-quarter conditional returns, not a prediction or an executable signal.',
    flatAccelerationThresholdPp: FLAT_ACCELERATION_PP };
}

function eventDate(event) {
  return Number.isFinite(Number(event?.date)) ? new Date(Number(event.date) * 1000).toISOString().slice(0, 10) : null;
}
function validatePriceHistory(history, benchmark, startQuarter, cutoff) {
  const issues = [];
  const result = history?.rawResponse?.chart?.result?.[0];
  const metadata = history?.metadata || result?.meta || {};
  const timestamps = result?.timestamp;
  if (!Array.isArray(timestamps) || !timestamps.length || timestamps.some((value, index) =>
    !Number.isFinite(value) || value <= 0 || (index > 0 && value <= timestamps[index - 1]))) {
    issues.push(inputError('invalid_raw_price_timestamps', { symbol: benchmark.symbol }));
  } else if (new Set(timestamps.map(value => new Date(value * 1000).toISOString().slice(0, 10))).size !== timestamps.length) {
    issues.push(inputError('duplicate_raw_price_dates', { symbol: benchmark.symbol }));
  }
  if (metadata.symbol !== benchmark.symbol || metadata.currency !== 'USD' || metadata.dataGranularity !== '1d'
    || metadata.instrumentType !== 'ETF') issues.push(inputError('benchmark_identity_unverified', { symbol: benchmark.symbol }));
  if (history?.stale || history?.mock || history?.seed || history?.cacheOnly || history?.providerStatus === 'offline') {
    issues.push(inputError('unverified_price_input', { symbol: benchmark.symbol }));
  }
  const start = previousTradingDateKey(quarterStart(startQuarter));
  const end = marketSessionOnOrBefore(quarterEnd(cutoff));
  const bars = new Map();
  for (const row of history?.bars || []) {
    if (row.date < start || row.date > end) continue;
    if (bars.has(row.date) || !isTradingDateKey(row.date) || finitePositive(row.rawClose) == null || finitePositive(row.adjustedClose) == null) {
      issues.push(inputError('invalid_or_duplicate_price_bar', { symbol: benchmark.symbol, date: row.date }));
    }
    bars.set(row.date, row);
  }
  const expectedDates = [];
  for (let date = start; date <= end; date = addCalendarDays(date, 1)) {
    if (!isTradingDateKey(date)) continue;
    expectedDates.push(date);
    if (!bars.has(date)) issues.push(inputError('missing_price_session', { symbol: benchmark.symbol, date }));
  }
  const dividends = new Map();
  for (const event of Object.values(history?.events?.dividends || {})) {
    const date = eventDate(event);
    if (!date || !Number.isFinite(Number(event.amount)) || Number(event.amount) < 0) {
      issues.push(inputError('invalid_dividend_event', { symbol: benchmark.symbol })); continue;
    }
    if (date <= start || date > end) continue;
    if (!isTradingDateKey(date) || dividends.has(date)) issues.push(inputError('unaligned_dividend_event', { symbol: benchmark.symbol, date }));
    dividends.set(date, Number(event.amount));
  }
  const splits = [];
  for (const event of Object.values(history?.events?.splits || {})) {
    const date = eventDate(event);
    if (!date || date <= start || date > end) continue;
    if (finitePositive(event.numerator) == null || finitePositive(event.denominator) == null || !isTradingDateKey(date)) {
      issues.push(inputError('invalid_split_event', { symbol: benchmark.symbol, date }));
    }
    if (event.splitRatio) {
      const match = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(event.splitRatio);
      if (!match || Math.abs(Number(match[1]) / Number(match[2]) - Number(event.numerator) / Number(event.denominator)) > 1e-10) {
        issues.push(inputError('inconsistent_split_ratio', { symbol: benchmark.symbol, date }));
      }
    }
    splits.push({ date, numerator: event.numerator, denominator: event.denominator });
  }
  // Yahoo's OHLC and dividend history is already split-adjusted. Its dividend
  // adjustment removes D / previous close backwards. Applying a split again
  // would double-count it. Reconstruct that explicitly documented convention,
  // independently from adjclose, and require agreement on every session.
  const reconstructed = new Map();
  let value = 1;
  if (expectedDates.length) reconstructed.set(expectedDates[0], value);
  let largestAdjustmentError = 0;
  for (let i = 1; i < expectedDates.length; i += 1) {
    const previous = bars.get(expectedDates[i - 1]);
    const current = bars.get(expectedDates[i]);
    if (!previous || !current || !finitePositive(previous.rawClose) || !finitePositive(current.rawClose)
      || !finitePositive(previous.adjustedClose) || !finitePositive(current.adjustedClose)) continue;
    const dividend = dividends.get(current.date) || 0;
    const dividendFactor = 1 - dividend / previous.rawClose;
    if (dividendFactor <= 0) { issues.push(inputError('invalid_dividend_adjustment', { symbol: benchmark.symbol, date: current.date })); continue; }
    const reconstructedRatio = (current.rawClose / previous.rawClose) / dividendFactor;
    const adjustedRatio = current.adjustedClose / previous.adjustedClose;
    const error = Math.abs(reconstructedRatio - adjustedRatio);
    largestAdjustmentError = Math.max(largestAdjustmentError, error);
    if (!Number.isFinite(error) || error > ADJUSTMENT_TOLERANCE) {
      issues.push(inputError('corporate_action_reconciliation_failed', { symbol: benchmark.symbol, date: current.date, difference: error }));
    }
    value *= reconstructedRatio;
    reconstructed.set(current.date, value);
  }
  const returns = {};
  let largestQuarterError = 0;
  for (const quarter of quarterRange(startQuarter, cutoff)) {
    const startDate = previousTradingDateKey(quarterStart(quarter));
    const endDate = marketSessionOnOrBefore(quarterEnd(quarter));
    const first = bars.get(startDate); const last = bars.get(endDate);
    if (!first || !last || !reconstructed.has(startDate) || !reconstructed.has(endDate)) continue;
    const adjustedReturn = last.adjustedClose / first.adjustedClose - 1;
    const reconstructedReturn = reconstructed.get(endDate) / reconstructed.get(startDate) - 1;
    const difference = Math.abs(adjustedReturn - reconstructedReturn);
    largestQuarterError = Math.max(largestQuarterError, difference);
    if (!Number.isFinite(difference) || difference > QUARTER_RECONCILIATION_TOLERANCE) {
      issues.push(inputError('quarter_return_reconciliation_failed', { symbol: benchmark.symbol, quarter, difference }));
    }
    if (Number.isFinite(adjustedReturn)) returns[quarter] = adjustedReturn;
  }
  return { symbol: benchmark.symbol, returns: issues.length ? {} : returns, issues,
    validation: { expectedSessions: expectedDates.length, observedSessions: bars.size,
      dividendCount: dividends.size, splitCount: splits.length, splits,
      largestAdjustmentError, largestQuarterError, startDate: start, endDate: end,
      reconciliationSource: 'same_vendor_corporate_actions',
      independentIssuerReconciliation: { status: 'not_performed' },
      adjustmentConvention: 'Vendor OHLC is split-adjusted; reconstruct backward dividend adjustment without applying splits twice.' } };
}

async function mapConcurrent(items, concurrency, mapper) {
  const output = new Array(items.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) { const index = next++; output[index] = await mapper(items[index], index); }
  }));
  return output;
}

async function loadQuadResearchInputs({ archiveRaw, loadCachedRaw, now = new Date(), cutoff,
  httpClient = require('axios'), groups = GROUPS, fredApiKey = process.env.FRED_API_KEY,
  fetchHistory = fetchYahooAdjustedHistoryData } = {}) {
  const generatedAt = new Date(now).toISOString();
  // ALFRED rejects future vintage dates relative to St. Louis, even when UTC
  // has already rolled into the next day. Freeze the source-local build date.
  const asOf = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago',
    year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
  const chosenCutoff = cutoff || completeQuarter(now);
  if (quarterOrdinal(chosenCutoff) > quarterOrdinal(completeQuarter(now))) throw new Error('Research cutoff must be a completed quarter');
  const sources = [];
  const errors = [];
  async function archive(source, url, payload, retrievedAt = generatedAt) {
    const hash = archiveRaw ? await archiveRaw({ source, url, payload, retrievedAt }) : sha(payload);
    sources.push({ source, url, hash, retrievedAt });
    return hash;
  }
  async function fred(params) {
    const allParams = { file_type: 'json', observation_start: MACRO_START, observation_end: quarterEnd(chosenCutoff), limit: 100000, ...params };
    const url = canonicalUrl(FRED_URL, allParams);
    const cached = loadCachedRaw ? await loadCachedRaw({ source: 'FRED/ALFRED', url }) : null;
    if (cached) {
      sources.push({ source: 'FRED/ALFRED', url, hash: cached.hash, retrievedAt: cached.retrievedAt });
      return validateFredPayload(cached.payload);
    }
    if (!fredApiKey) throw new Error('fred_api_key_missing');
    let response;
    try { response = await httpClient.get(FRED_URL, { params: { ...allParams, api_key: fredApiKey }, timeout: 30000 }); }
    catch (error) { throw new Error(`fred_request_failed_${Number(error.response?.status) || 'network'}`); }
    const payload = validateFredPayload(response.data);
    await archive('FRED/ALFRED', url, payload);
    return payload;
  }

  let macro = { rows: [], issues: [] };
  try {
    const firstReleases = await fred({ series_id: 'GDPC1', observation_start: '2007-04-01',
      realtime_start: '1776-07-04', realtime_end: asOf, output_type: 4 });
    const vintageDates = [...new Set(firstReleases.observations.map(row => row.realtime_start))].sort().join(',');
    if (!vintageDates) throw new Error('gdp_first_releases_missing');
    const [gdpVintages, cpiVintages, latestGdp, latestCpi] = await Promise.all([
      fred({ series_id: 'GDPC1', vintage_dates: vintageDates, output_type: 2 }),
      fred({ series_id: 'CPIAUCNS', vintage_dates: vintageDates, output_type: 2 }),
      fred({ series_id: 'GDPC1', realtime_start: asOf, realtime_end: asOf, output_type: 1 }),
      fred({ series_id: 'CPIAUCNS', realtime_start: asOf, realtime_end: asOf, output_type: 1 }),
    ]);
    macro = buildMacroRows({ firstReleases, gdpVintages, cpiVintages, latestGdp, latestCpi, cutoff: chosenCutoff, asOf });
  } catch (error) {
    macro.issues.push(inputError('macro_input_unavailable', { reason: /^[a-z0-9_]+$/.test(error.message) ? error.message : 'macro_verification_failed' }));
  }
  const benchmarkPairs = groups.flatMap(group => group.benchmarks.map(benchmark => ({ group, benchmark })));
  const histories = await mapConcurrent(benchmarkPairs, 4, async ({ group, benchmark }) => {
    try {
      const params = { period1: '-2208988800', period2: String(Math.floor(new Date(`${asOf}T00:00:00Z`).getTime() / 1000)),
        interval: '1d', includePrePost: 'false', includeAdjustedClose: 'true', events: 'div,splits' };
      const url = canonicalUrl(`https://query1.finance.yahoo.com/v8/finance/chart/${benchmark.symbol}`, params);
      const cached = loadCachedRaw ? await loadCachedRaw({ source: 'Yahoo Finance chart', url }) : null;
      let history;
      if (cached) {
        const result = cached.payload?.chart?.result?.[0];
        history = { bars: parseYahooChartBars(result, { now: new Date(now).getTime() }), events: result?.events || {},
          metadata: result?.meta || {}, rawResponse: cached.payload };
        sources.push({ source: 'Yahoo Finance chart', url, hash: cached.hash, retrievedAt: cached.retrievedAt });
      } else {
        history = await fetchHistory({ symbol: benchmark.symbol, httpClient, period1: params.period1,
          period2: params.period2, now: new Date(now).getTime() });
        await archive('Yahoo Finance chart', url, history.rawResponse, history.fetchedAt || generatedAt);
      }
      return { groupId: group.id, ...validatePriceHistory(history, benchmark, group.startQuarter, chosenCutoff) };
    } catch (error) {
      return { groupId: group.id, symbol: benchmark.symbol, returns: {},
        issues: [inputError('price_input_unavailable', { symbol: benchmark.symbol })], validation: null };
    }
  });
  let independentSourceValidation;
  try {
    if (macro.issues.length) throw new Error('Macro ingestion failed before independent validation.');
    const result = await validateIndependentSources({ archiveRaw, loadCachedRaw, httpClient, now,
      cutoff: chosenCutoff, quarterlyReturns: Object.fromEntries(histories.map(history => [history.symbol, history.returns])),
      macroRows: macro.rows });
    // Both gates are required. An issuer-only interim result must never enable
    // production ranks while original macro-release checks are still absent.
    const status = result.status === 'verified' && result.issuer?.status === 'verified'
      && result.macro?.status === 'verified' ? 'verified' : 'failed';
    independentSourceValidation = { ...result, status };
    sources.push(...(result.sources || []));
  } catch {
    independentSourceValidation = { status: 'failed', issuer: { status: 'failed' }, macro: { status: 'failed' },
      issues: [inputError('independent_source_validation_unavailable')], sourceHashes: [], sources: [] };
  }
  const outputGroups = groups.map(group => {
    const groupHistories = histories.filter(history => history.groupId === group.id);
    const issues = [...macro.issues.filter(issue => !issue.quarter || issue.quarter >= group.startQuarter), ...groupHistories.flatMap(history => history.issues)];
    const rows = [];
    if (!issues.length) for (const quarter of quarterRange(group.startQuarter, chosenCutoff)) {
      const macroRow = macro.rows.find(row => row.quarter === quarter);
      if (!macroRow) { issues.push(inputError('macro_quarter_missing', { quarter })); continue; }
      const returns = Object.fromEntries(groupHistories.map(history => [history.symbol, history.returns[quarter]]));
      if (Object.values(returns).some(value => !Number.isFinite(value))) { issues.push(inputError('peer_quarter_missing', { quarter })); continue; }
      rows.push({ ...macroRow, returns });
    }
    errors.push(...issues.map(issue => ({ ...issue, groupId: group.id })));
    return { groupId: group.id, rows: issues.length ? [] : rows, inputIssues: issues,
      issues: issues.map(issue => [issue.code, issue.symbol, issue.quarter, issue.date].filter(Boolean).join(': ')),
      excludedQuarters: macro.rows.filter(row => row.quarter >= group.startQuarter && (row.quad == null || row.latestQuad == null))
        .map(row => ({ quarter: row.quarter, reason: row.reason || row.latestReason })),
      priceValidation: groupHistories.map(({ symbol, validation }) => ({ symbol, ...validation })) };
  });
  const valid = errors.length === 0 && independentSourceValidation.status === 'verified';
  return { cutoff: chosenCutoff, macro, groups: outputGroups,
    sourceHashes: [...new Set([...sources.map(source => source.hash), ...(independentSourceValidation.sourceHashes || [])])], sources, generatedAt,
    validation: { valid, status: valid ? 'verified' : 'failed', issues: [...errors, ...(independentSourceValidation.issues || [])],
      globalIngestionFailure: macro.issues.length > 0,
      ingestionFailed: histories.some(history => history.issues.some(issue => issue.code === 'price_input_unavailable')),
      independentIssuerReconciliation: independentSourceValidation.issuer || { status: 'not_performed' },
      independentSourceValidation,
      sourceCount: sources.length, modeledBenchmarkCount: benchmarkPairs.length,
      adjustmentTolerance: ADJUSTMENT_TOLERANCE, quarterReconciliationTolerance: QUARTER_RECONCILIATION_TOLERANCE } };
}

module.exports = { loadQuadResearchInputs, validatePriceHistory, buildMacroRows, macroAcceleration,
  classifyQuad, quarterStart, quarterEnd, quarterRange, completeQuarter, shiftQuarter, canonicalUrl,
  FLAT_ACCELERATION_PP, ADJUSTMENT_TOLERANCE, QUARTER_RECONCILIATION_TOLERANCE };
