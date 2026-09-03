const {
  applySpxRtaRiskRange,
  buildUnderlyingMultiDayChart,
  getSpxCloseWorkbench,
  historicalBarDateKey,
  historicalBarTimestamp,
  latestCompletedSpxSessionDate,
  normalizeUnderlyingBars,
  spxCashSessionState,
} = require('../predictionMarketsIngest/watchlistProvider');
const {
  getOverviewSignalAvailability,
  getRiskRangeHistoryAvailability,
} = require('../predictionMarketsIngest/signalAvailabilityProvider');
const {
  getLatestSpxRtaRiskRange,
} = require('../predictionMarketsIngest/rtaRiskRangeProvider');
const ibkrMarketDataProvider = require('../providers/ibkr/ibkrMarketDataProvider');
const { normalizeDxyContext } = require('./usdContext.cjs');

const LIVE_QUOTE_MAX_AGE_MS = 60_000;
const LIVE_BAR_MAX_AGE_MS = 10 * 60_000;
const CONTRACT_MAX_AGE_MS = 90_000;
const INITIAL_REFRESH_BUDGET_MS = 4_000;
const HISTORICAL_BARS_TTL_MS = 30_000;
const HOURLY_CHART_TTL_MS = 5 * 60_000;
const DAILY_BARS_TTL_MS = 30 * 60_000;
const CFTC_MAX_AGE_MS = 10 * 24 * 60 * 60_000;
const ATH_RECORD_TTL_MS = 24 * 60 * 60_000;
const CFTC_OFFICIAL_SOURCE = 'cftc-public-reporting-environment';
const CFTC_SCHEMA_VERSION = 'cftc-positioning-v2';
const CFTC_CALCULATION_VERSION = 'cftc-combined-net-sample-z-v1';
const CFTC_SPX_CONTRACT_CODE = '13874A';
const MARKET_STRUCTURE_SCHEMA_VERSION = 'market-structure-v4';
const MARKET_STRUCTURE_CHART_METRICS_VERSION = 'market-structure-chart-metrics-v2';
const MARKET_STRUCTURE_CHART_MAX_AGE_DAYS = 4;
const FORBIDDEN_PROVENANCE = /delayed|frozen|stale|cache(?:d|_only|-only)?|mock|seed|fallback|offline|disconnected|historical|synthetic|inferred|derived/i;
const REFRESH_FAILURE = /refresh(?:[_ -]?(?:failed|failure|error|issue|timeout|timed out))|(?:failed|failure|error).*refresh/i;
const DENIED_ENTITLEMENT = /denied|unavailable|not[_ -]?subscribed|no[_ -]?permission/i;

const SPX_INSTRUMENT = Object.freeze({
  symbol: 'SPX',
  displaySymbol: 'SPX',
  secType: 'IND',
  exchange: 'CBOE',
  currency: 'USD',
  provider: 'ibkr',
});
const SPY_INSTRUMENT = Object.freeze({
  symbol: 'SPY',
  displaySymbol: 'SPY',
  secType: 'STK',
  exchange: 'SMART',
  currency: 'USD',
  provider: 'ibkr',
});
const VIX_INSTRUMENT = Object.freeze({
  symbol: 'VIX',
  displaySymbol: 'VIX',
  secType: 'IND',
  exchange: 'CBOE',
  currency: 'USD',
  provider: 'ibkr',
});
const VVIX_INSTRUMENT = Object.freeze({
  symbol: 'VVIX',
  displaySymbol: 'VVIX',
  secType: 'IND',
  exchange: 'CBOE',
  currency: 'USD',
  provider: 'ibkr',
});

function finiteNumber(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function isoTimestamp(value) {
  const timestamp = value instanceof Date ? value.getTime() : Date.parse(String(value || ''));
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function isoAfter(value, durationMs) {
  const timestamp = value instanceof Date ? value.getTime() : Date.parse(String(value || ''));
  return Number.isFinite(timestamp) ? new Date(timestamp + durationMs).toISOString() : null;
}

function newYorkParts(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const hour = Number(values.hour);
  const minute = Number(values.minute);
  if (!values.year || !values.month || !values.day || !Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    minutes: hour * 60 + minute,
  };
}

function dateKey(value) {
  if (value == null || value === '') return null;
  const exact = String(value || '').match(/^(\d{4}-\d{2}-\d{2})/);
  return exact?.[1] || newYorkParts(value)?.date || null;
}

function newYorkLocalTimestamp(date, minutes) {
  const match = String(date || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match || !Number.isFinite(minutes)) return null;
  const [, year, month, day] = match;
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  const desiredLocal = Date.UTC(Number(year), Number(month) - 1, Number(day), hour, minute);
  let timestamp = desiredLocal;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const rendered = newYorkParts(timestamp);
    const renderedDate = String(rendered?.date || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!renderedDate) return null;
    const renderedLocal = Date.UTC(
      Number(renderedDate[1]),
      Number(renderedDate[2]) - 1,
      Number(renderedDate[3]),
      Math.floor(rendered.minutes / 60),
      rendered.minutes % 60,
    );
    timestamp += desiredLocal - renderedLocal;
  }
  return new Date(timestamp).toISOString();
}

function unavailable(reason, extras = {}) {
  return {
    status: 'unavailable',
    source: null,
    asOf: null,
    expiresAt: null,
    reason,
    ...extras,
  };
}

function settledValue(result, fallback = null) {
  return result?.status === 'fulfilled' ? result.value : fallback;
}

function invoke(loader, ...args) {
  return Promise.resolve().then(() => loader(...args));
}

function errorMessage(result, fallback) {
  if (result?.status !== 'rejected') return null;
  return String(result.reason?.message || result.reason || fallback).slice(0, 240);
}

function markRefreshFailure(section, results, fallback) {
  const pending = (Array.isArray(results) ? results : [results])
    .find((result) => result?.status === 'pending');
  if (pending) {
    return {
      ...section,
      status: section?.status === 'unavailable' ? 'refreshing' : section?.status,
      refreshing: true,
      refreshFailed: false,
      refreshIssue: null,
      reason: section?.reason || fallback || 'This section is refreshing.',
    };
  }
  const rejected = (Array.isArray(results) ? results : [results])
    .find((result) => result?.status === 'rejected');
  if (!rejected) return section;
  return {
    ...section,
    refreshFailed: true,
    refreshIssue: errorMessage(rejected, fallback) || fallback,
  };
}

function settleByDeadline(promise, deadlineMs, source) {
  return new Promise((resolve) => {
    let finished = false;
    let timer = null;
    const complete = (result) => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    const remainingMs = Math.max(0, deadlineMs - Date.now());
    timer = setTimeout(() => {
      const reason = new Error(`${source} is still refreshing.`);
      reason.code = 'PM_MONITOR_SECTION_REFRESHING';
      reason.refreshing = true;
      complete({ status: 'pending', reason });
    }, remainingMs);
    Promise.resolve(promise).then(
      (value) => complete({ status: 'fulfilled', value }),
      (reason) => complete({ status: 'rejected', reason }),
    );
  });
}

function isVerifiedIbkrHistory(history, providerStatus) {
  const forbidden = [
    history?.warning,
    history?.error,
    history?.provenance,
    history?.cacheStatus,
    history?.cacheState,
    history?.sourceStatus,
    history?.fromCache ? 'cached' : '',
    history?.cached ? 'cached' : '',
    history?.cachedOnly ? 'cached-only' : '',
    history?.cacheOnly ? 'cache-only' : '',
    history?.cacheHit ? 'cached' : '',
    history?.mock ? 'mock' : '',
    history?.seeded ? 'seeded' : '',
    history?.fallback ? 'fallback' : '',
  ].filter(Boolean).join(' ');
  return Boolean(
    providerStatus?.connected === true &&
    String(history?.source || '').toLowerCase() === 'ibkr' &&
    !FORBIDDEN_PROVENANCE.test(forbidden)
  );
}

function mergeVerifiedCurrentSessionHistory(multiDayHistory, intradayHistory, nowMs) {
  const providerStatus = { connected: true };
  if (
    !isVerifiedIbkrHistory(multiDayHistory, providerStatus)
    || !isVerifiedIbkrHistory(intradayHistory, providerStatus)
  ) return multiDayHistory;

  const today = newYorkParts(nowMs)?.date;
  if (!today) return multiDayHistory;
  const currentSessionPoints = normalizeUnderlyingBars(intradayHistory?.bars || [], nowMs)
    .filter((point) => (
      point.timestamp <= nowMs + 60_000
      && historicalBarDateKey(point.timestamp) === today
      && isSpxCashPoint(point)
    ));
  if (currentSessionPoints.length < 2) return multiDayHistory;

  const pointsByTimestamp = new Map(
    normalizeUnderlyingBars(multiDayHistory?.bars || [], nowMs)
      .map((point) => [point.timestamp, point]),
  );
  currentSessionPoints.forEach((point) => pointsByTimestamp.set(point.timestamp, point));
  const mergedPoints = [...pointsByTimestamp.values()]
    .sort((left, right) => left.timestamp - right.timestamp);
  const latestPoint = mergedPoints[mergedPoints.length - 1] || null;
  return {
    ...multiDayHistory,
    source: 'ibkr',
    asOf: latestPoint ? new Date(latestPoint.timestamp).toISOString() : multiDayHistory?.asOf || null,
    bars: mergedPoints.map((point) => ({
      timestamp: point.timestamp,
      close: point.value,
      ...(finiteNumber(point.high) != null && point.high > 0 ? { high: point.high } : {}),
    })),
  };
}

function latestSnapshot(value) {
  const rows = Array.isArray(value) ? value : value ? [value] : [];
  return [...rows].sort((left, right) => {
    const leftTime = Date.parse(left?.scrapedAt || left?.publishedAt || left?.updatedAt || left?.date || '') || 0;
    const rightTime = Date.parse(right?.scrapedAt || right?.publishedAt || right?.updatedAt || right?.date || '') || 0;
    return rightTime - leftTime || String(right?.date || '').localeCompare(String(left?.date || ''));
  })[0] || null;
}

function normalizeDirection(value) {
  const token = String(value || '').trim().toUpperCase().replace(/[_-]+/g, ' ');
  if (['BULL', 'BULLISH', 'BUY', 'LONG', 'RISK ON'].includes(token)) return 'bullish';
  if (['BEAR', 'BEARISH', 'SELL', 'SHORT', 'RISK OFF'].includes(token)) return 'bearish';
  if (['NEUTRAL', 'FLAT', 'MIXED'].includes(token)) return 'neutral';
  return null;
}

function normalizeGammaExposure(value) {
  const token = String(value || '').trim().toUpperCase();
  if (token.includes('POSITIVE') || token === 'LONG') return 'positive';
  if (token.includes('NEGATIVE') || token === 'SHORT') return 'negative';
  if (token.includes('NEUTRAL')) return 'neutral';
  return null;
}

function normalizeStructureToken(value, kind) {
  const token = String(value || '').trim().toUpperCase().replace(/[_-]+/g, ' ');
  if (!token) return null;
  if (token.includes('NEUTRAL')) return 'neutral';
  if (kind === 'allocation') {
    if (token.includes('RISK ON')) return 'risk_on';
    if (token.includes('RISK OFF')) return 'risk_off';
  }
  if (kind === 'pv') {
    if (token.includes('LONG')) return 'long';
    if (token.includes('SHORT')) return 'short';
  }
  if (token.includes('BULLISH') || token === 'LONG') return 'bullish';
  if (token.includes('BEARISH') || token === 'SHORT') return 'bearish';
  return null;
}

const MONTH_NUMBER = Object.freeze({
  JANUARY: 1,
  FEBRUARY: 2,
  MARCH: 3,
  APRIL: 4,
  MAY: 5,
  JUNE: 6,
  JULY: 7,
  AUGUST: 8,
  SEPTEMBER: 9,
  OCTOBER: 10,
  NOVEMBER: 11,
  DECEMBER: 12,
});

function marketStructureSignalValue(data, id, label) {
  const normalizedId = String(id || '').trim().toLowerCase();
  const normalizedLabel = String(label || '').trim().toLowerCase();
  const signal = (Array.isArray(data?.signals) ? data.signals : []).find((candidate) => (
    String(candidate?.id || '').trim().toLowerCase() === normalizedId
    || String(candidate?.label || '').trim().toLowerCase() === normalizedLabel
  ));
  const value = signal?.value;
  return value == null || String(value).trim() === '' ? null : value;
}

function marketStructureNarrative(snapshot) {
  const blocks = Array.isArray(snapshot?.data?.blocks) ? snapshot.data.blocks : [];
  return [
    snapshot?.article?.reportHeading,
    snapshot?.article?.bodyText,
    ...blocks.map((block) => block?.text),
  ].filter((value) => typeof value === 'string' && value.trim()).join('\n');
}

function explicitMarketStructureNumber(snapshot, patterns) {
  const narrative = marketStructureNarrative(snapshot);
  for (const pattern of patterns) {
    const match = narrative.match(pattern);
    const value = finiteNumber(match?.[1]);
    if (value != null) return value;
  }
  return null;
}

function isoCalendarDate(year, month, day) {
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (
    !Number.isInteger(Number(year))
    || !Number.isInteger(Number(month))
    || !Number.isInteger(Number(day))
    || date.getUTCFullYear() !== Number(year)
    || date.getUTCMonth() + 1 !== Number(month)
    || date.getUTCDate() !== Number(day)
  ) return null;
  return date.toISOString().slice(0, 10);
}

function marketStructureCoverage(snapshot, sourceDate) {
  if (snapshot?.contentComplete !== true || !sourceDate) return null;
  const match = marketStructureNarrative(snapshot).match(
    /\bWEEKLY\s+GAME\s+PLAN\b\s*:?\s*(JANUARY|FEBRUARY|MARCH|APRIL|MAY|JUNE|JULY|AUGUST|SEPTEMBER|OCTOBER|NOVEMBER|DECEMBER)\s+(\d{1,2})(?:ST|ND|RD|TH)?\s*(?:-|–|—|TO)\s*(?:(JANUARY|FEBRUARY|MARCH|APRIL|MAY|JUNE|JULY|AUGUST|SEPTEMBER|OCTOBER|NOVEMBER|DECEMBER)\s+)?(\d{1,2})(?:ST|ND|RD|TH)?(?:\s*,?\s*(\d{4}))?/i,
  );
  if (!match) return null;

  const sourceYear = Number(String(sourceDate).slice(0, 4));
  const startMonth = MONTH_NUMBER[String(match[1]).toUpperCase()];
  const endMonth = MONTH_NUMBER[String(match[3] || match[1]).toUpperCase()];
  const startYear = Number(match[5] || sourceYear);
  const endYear = endMonth < startMonth ? startYear + 1 : startYear;
  const validFrom = isoCalendarDate(startYear, startMonth, Number(match[2]));
  const validThrough = isoCalendarDate(endYear, endMonth, Number(match[4]));
  if (!validFrom || !validThrough) return null;

  const sourceMs = Date.parse(`${sourceDate}T12:00:00.000Z`);
  const startMs = Date.parse(`${validFrom}T12:00:00.000Z`);
  const endMs = Date.parse(`${validThrough}T12:00:00.000Z`);
  if (
    !Number.isFinite(sourceMs)
    || !Number.isFinite(startMs)
    || !Number.isFinite(endMs)
    || endMs < startMs
    || sourceMs < startMs - 24 * 60 * 60_000
    || sourceMs > endMs
  ) return null;
  return { validFrom, validThrough };
}

function dateFallsWithin(date, range) {
  const target = dateKey(date);
  return Boolean(target && range?.validFrom && range?.validThrough
    && target >= range.validFrom && target <= range.validThrough);
}

function verifiedMarketStructureChartMetric(snapshot, metricId, targetDate, validator) {
  const metric = snapshot?.data?.chartMetrics?.[metricId];
  const chartDate = dateKey(metric?.chartDate);
  const target = dateKey(targetDate);
  const chartMs = chartDate ? Date.parse(`${chartDate}T12:00:00.000Z`) : NaN;
  const targetMs = target ? Date.parse(`${target}T12:00:00.000Z`) : NaN;
  const ageDays = (targetMs - chartMs) / (24 * 60 * 60_000);
  const evidence = [
    snapshot?.cacheState,
    snapshot?.freshness,
    snapshot?.warning,
    snapshot?.error,
    snapshot?.refreshIssue,
    snapshot?.cachedOnly && 'cached-only',
    snapshot?.fromCache && 'cached',
  ].filter(Boolean).join(' ');
  const verified = Boolean(
    snapshot?.snapshotType === 'market-structure'
    && snapshot?.schemaVersion === MARKET_STRUCTURE_SCHEMA_VERSION
    && snapshot?.contentComplete === true
    && metric
    && metric?.extractionBasis === 'labeled-chart-ocr'
    && metric?.parserVersion === MARKET_STRUCTURE_CHART_METRICS_VERSION
    && /^[a-f0-9]{64}$/i.test(String(metric?.chartId || ''))
    && Number.isFinite(chartMs)
    && Number.isFinite(targetMs)
    && ageDays >= 0
    && ageDays <= MARKET_STRUCTURE_CHART_MAX_AGE_DAYS
    && !FORBIDDEN_PROVENANCE.test(evidence)
    && !REFRESH_FAILURE.test(evidence)
    && validator(metric)
  );
  return verified ? { ...metric, chartDate } : null;
}

function findExactTickerSlot(data, ticker) {
  if (!data || typeof data !== 'object') return null;
  const upper = String(ticker || '').trim().toUpperCase();
  if (!upper) return null;
  if (String(data.ticker ?? data.symbol ?? '').trim().toUpperCase() === upper) return data;
  for (const collection of [data.stocks, data.securities, data]) {
    if (!collection || typeof collection !== 'object' || Array.isArray(collection)) continue;
    const key = Object.keys(collection).find((candidate) => String(candidate).trim().toUpperCase() === upper);
    if (!key) continue;
    const slot = collection[key];
    if (!slot || typeof slot !== 'object' || Array.isArray(slot)) return null;
    const declaredTicker = slot.ticker ?? slot.symbol;
    return declaredTicker && String(declaredTicker).trim().toUpperCase() !== upper ? null : slot;
  }
  for (const rows of [data.rows, data.stocks, data.securities]) {
    if (!Array.isArray(rows)) continue;
    const matches = rows.filter((row) => (
      row
      && typeof row === 'object'
      && String(row.ticker ?? row.symbol ?? '').trim().toUpperCase() === upper
    ));
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) return null;
  }
  return null;
}

function resolveVerifiedIbkrQuote(result, providerStatus, symbol, nowMs) {
  if (providerStatus?.connected !== true) {
    return unavailable('IBKR is disconnected.');
  }
  const quote = result?.canonical || null;
  const timestamp = quote?.timestamp || null;
  const timestampMs = Date.parse(String(timestamp || ''));
  const ageMs = nowMs - timestampMs;
  const value = finiteNumber(quote?.last);
  const previousCloseValue = finiteNumber(quote?.close);
  const previousClose = previousCloseValue != null && previousCloseValue > 0
    ? previousCloseValue
    : null;
  const entitlement = String(quote?.entitlementStatus || '').trim().toLowerCase();
  const entitlementVerified = ['entitled', 'live', 'real_time', 'realtime', 'tick_by_tick']
    .includes(entitlement);
  const blocked = FORBIDDEN_PROVENANCE.test([
    quote?.source,
    quote?.warning,
    result?.fromCache ? 'cached' : '',
    result?.error,
  ].filter(Boolean).join(' '));
  const verified = Boolean(
    quote?.valid === true &&
    String(quote?.symbol || '').toUpperCase() === String(symbol || '').toUpperCase() &&
    String(quote?.source || '').toLowerCase() === 'ibkr' &&
    String(quote?.dataType || '').toLowerCase() === 'live' &&
    value != null && value > 0 &&
    Number.isFinite(timestampMs) &&
    ageMs >= -5_000 && ageMs <= LIVE_QUOTE_MAX_AGE_MS &&
    !blocked &&
    entitlementVerified &&
    !DENIED_ENTITLEMENT.test(entitlement)
  );
  if (!verified) return unavailable(`A fresh entitled live IBKR ${symbol} trade is unavailable.`);
  return {
    status: 'available',
    availability: 'live',
    value,
    previousClose,
    previousCloseSource: previousClose != null ? 'ibkr_live_tick_close' : null,
    source: result?.fromStreamCache ? 'ibkr_live_stream' : 'ibkr_live',
    asOf: new Date(timestampMs).toISOString(),
    expiresAt: new Date(timestampMs + LIVE_QUOTE_MAX_AGE_MS).toISOString(),
    reason: null,
  };
}

function resolveVerifiedIbkrClose(history, expectedDate, label = 'SPX', providerStatus = null) {
  if (!isVerifiedIbkrHistory(history, providerStatus) || !expectedDate) {
    return unavailable(`The latest completed IBKR ${label} close is unavailable.`);
  }
  const bars = (Array.isArray(history?.bars) ? history.bars : [])
    .map((candidate) => {
      const date = historicalBarDateKey(candidate?.date ?? candidate?.timestamp);
      const value = finiteNumber(candidate?.close);
      return date && value != null && value > 0 ? { date, value } : null;
    })
    .filter(Boolean);
  const matches = bars.filter((candidate) => candidate.date === expectedDate);
  if (matches.length !== 1) {
    return unavailable(`The latest completed IBKR ${label} close is unavailable.`);
  }
  const previousDate = [...new Set(
    bars.filter((candidate) => candidate.date < expectedDate).map((candidate) => candidate.date),
  )].sort().at(-1) || null;
  const previousMatches = previousDate
    ? bars.filter((candidate) => candidate.date === previousDate)
    : [];
  const previousClose = previousMatches.length === 1 ? previousMatches[0].value : null;
  return {
    status: 'historical',
    availability: 'last_close',
    value: matches[0].value,
    previousClose,
    previousCloseSource: previousClose != null ? 'ibkr_historical_daily_close' : null,
    previousCloseAsOf: previousClose != null ? previousDate : null,
    source: 'ibkr_historical_daily_close',
    asOf: newYorkLocalTimestamp(expectedDate, 16 * 60) || expectedDate,
    historicalThroughDate: expectedDate,
    expiresAt: null,
    reason: null,
  };
}

function resolveVerifiedIbkrSessionClose(history, expectedDate, label = 'SPY', providerStatus = null) {
  if (!isVerifiedIbkrHistory(history, providerStatus) || !expectedDate) {
    return unavailable(`The latest completed IBKR ${label} close is unavailable.`);
  }
  const bars = (Array.isArray(history?.bars) ? history.bars : [])
    .map((candidate) => {
      const timestamp = historicalBarTimestamp(candidate?.date ?? candidate?.timestamp ?? candidate?.time);
      const parts = newYorkParts(timestamp);
      const value = finiteNumber(candidate?.close);
      return timestamp != null && parts && value != null && value > 0
        ? { timestamp, date: parts.date, minutes: parts.minutes, value }
        : null;
    })
    .filter(Boolean)
    .sort((left, right) => left.timestamp - right.timestamp);
  const completedClose = (date) => {
    const matches = bars.filter((candidate) => (
      candidate.date === date
      && candidate.minutes >= (15 * 60 + 50)
      && candidate.minutes <= (16 * 60 + 5)
    ));
    return matches.at(-1) || null;
  };
  const latest = completedClose(expectedDate);
  if (!latest) return unavailable(`The latest completed IBKR ${label} close is unavailable.`);
  const previousDate = [...new Set(bars
    .filter((candidate) => candidate.date < expectedDate)
    .map((candidate) => candidate.date))]
    .sort()
    .reverse()
    .find((date) => completedClose(date)) || null;
  const previous = previousDate ? completedClose(previousDate) : null;
  return {
    status: 'historical',
    availability: 'last_close',
    value: latest.value,
    previousClose: previous?.value ?? null,
    previousCloseSource: previous ? 'ibkr_historical_intraday_session_close' : null,
    previousCloseAsOf: previous ? new Date(previous.timestamp).toISOString() : null,
    source: 'ibkr_historical_intraday_session_close',
    asOf: new Date(latest.timestamp).toISOString(),
    historicalThroughDate: expectedDate,
    expiresAt: null,
    reason: null,
  };
}

function normalizeRiskRange(signal, nowMs = Date.now()) {
  const details = signal?.details || {};
  const lrr = finiteNumber(details.lrr);
  const hrr = finiteNumber(details.hrr);
  const rangeDate = dateKey(details.date || signal?.requiredDate || signal?.asOf);
  if (signal?.status !== 'available' || lrr == null || hrr == null || !(lrr < hrr) || !rangeDate) {
    return unavailable(signal?.reason || 'The current SPX Risk Range is unavailable.', {
      lrr: null,
      hrr: null,
      previousClose: null,
      trend: null,
      date: rangeDate,
      ticker: 'SPX',
      fit: 'calibration',
    });
  }
  return {
    status: 'available',
    lrr,
    hrr,
    previousClose: finiteNumber(details.previousClose ?? details.prevClose),
    trend: normalizeDirection(details.trend),
    trendRaw: details.trend || null,
    date: rangeDate,
    ticker: 'SPX',
    fit: 'calibration',
    source: signal.source || 'RiskRangeData',
    asOf: signal.asOf || details.date || rangeDate,
    expiresAt: isoAfter(new Date(nowMs), 30 * 60_000),
    reason: null,
  };
}

function normalizeTrade(snapshotValue, riskRange, targetDate, nowMs = Date.now()) {
  const target = dateKey(targetDate || riskRange?.date);
  const snapshots = (Array.isArray(snapshotValue) ? snapshotValue : snapshotValue ? [snapshotValue] : [])
    .filter((snapshot) => snapshot?.snapshotType === 'momo-tracker' && dateKey(snapshot.date) === target)
    .sort((left, right) => String(
      right?.retrievedAt || right?.scrapedAt || right?.publishedAt || right?.updatedAt || ''
    ).localeCompare(String(
      left?.retrievedAt || left?.scrapedAt || left?.publishedAt || left?.updatedAt || ''
    )));
  const snapshot = snapshots[0] || null;
  const snapshotEvidence = [
    snapshot?.source, snapshot?.provenance, snapshot?.cacheState, snapshot?.freshness,
    snapshot?.availability, snapshot?.warning, snapshot?.error, snapshot?.reason,
    snapshot?.refreshIssue, snapshot?.fromCache && 'cached', snapshot?.cachedOnly && 'cached-only',
  ].filter(Boolean).join(' ');
  const snapshotUnsafe = snapshot?.refreshFailed === true
    || Boolean(snapshot?.refreshIssue)
    || FORBIDDEN_PROVENANCE.test(snapshotEvidence)
    || REFRESH_FAILURE.test(snapshotEvidence);
  const slot = snapshot && !snapshotUnsafe ? findExactTickerSlot(snapshot.data, 'SPX') : null;
  const slotEvidence = [
    slot?.source, slot?.provenance, slot?.cacheState, slot?.freshness, slot?.availability,
    slot?.warning, slot?.error, slot?.reason, slot?.refreshIssue,
    slot?.fromCache && 'cached', slot?.cachedOnly && 'cached-only',
  ].filter(Boolean).join(' ');
  const slotUnsafe = slot?.refreshFailed === true
    || Boolean(slot?.refreshIssue)
    || FORBIDDEN_PROVENANCE.test(slotEvidence)
    || REFRESH_FAILURE.test(slotEvidence);
  const raw = slot?.trade ?? slot?.tradeSignal ?? null;
  const sourceDate = slot?.date || snapshot?.date || null;
  const source = slot ? 'momo-tracker' : null;
  const asOf = snapshot?.retrievedAt || snapshot?.scrapedAt || snapshot?.publishedAt || snapshot?.updatedAt || sourceDate;
  const direction = normalizeDirection(raw);
  const exact = Boolean(direction && !slotUnsafe && target && dateKey(sourceDate) === target);
  return exact ? {
    status: 'available',
    direction,
    raw,
    date: dateKey(sourceDate),
    ticker: 'SPX',
    source,
    asOf: isoTimestamp(asOf) || dateKey(sourceDate),
    expiresAt: isoAfter(new Date(nowMs), 30 * 60_000),
    reason: null,
  } : unavailable('A same-session published SPX Trade signal is unavailable.', {
    direction: null,
    raw: null,
    date: dateKey(sourceDate),
    ticker: 'SPX',
  });
}

function normalizeUsdCorrelation(snapshot, nowMs = Date.now()) {
  const correlations = snapshot?.correlations?.SPX || {};
  const r15 = finiteNumber(correlations['15D']);
  const r30 = finiteNumber(correlations['30D']);
  const r90 = finiteNumber(correlations['90D']);
  const date = dateKey(snapshot?.calculationDate);
  if (snapshot?.sourceStatus !== 'current' || r30 == null || !date) {
    return unavailable('Current SPX/DXY correlation is unavailable.', {
      r15: null,
      r30: null,
      r90: null,
      date,
      sourceStatus: snapshot?.sourceStatus || 'unavailable',
    });
  }
  return {
    status: 'available',
    value: r30,
    r15,
    r30,
    r90,
    date,
    timestamp: isoTimestamp(snapshot?.timestamp),
    source: snapshot?.source || 'DXY / SPX daily log returns',
    sourceStatus: 'current',
    asOf: isoTimestamp(snapshot?.timestamp) || date,
    expiresAt: isoAfter(new Date(nowMs), 6 * 60 * 60_000),
    reason: null,
  };
}

function normalizeMarketStructure(snapshotValue, targetDate, nowMs = Date.now()) {
  const snapshot = latestSnapshot(snapshotValue);
  const data = snapshot?.data && typeof snapshot.data === 'object' ? snapshot.data : {};
  const spx = data.SPX || data.spx || data.marketStructure || data.market_structure || {};
  const sourceDate = dateKey(spx.date || data.date || snapshot?.date);
  const completeReport = snapshot?.snapshotType === 'market-structure' && snapshot?.contentComplete === true;
  const reportSignals = completeReport ? data : null;
  const coverage = marketStructureCoverage(snapshot, sourceDate);
  const targetDateKey = dateKey(targetDate);
  const current = Boolean(
    completeReport
    &&
    sourceDate
    && targetDateKey
    && (sourceDate === targetDateKey || dateFallsWithin(targetDateKey, coverage))
  );
  const throttleMetric = current ? verifiedMarketStructureChartMetric(
    snapshot,
    'spxGammaVolatilityThrottle',
    targetDateKey,
    (metric) => {
      const throttle = finiteNumber(metric?.gammaThrottle);
      const realizedVolatility = finiteNumber(metric?.tenDayRealizedVolatility);
      return throttle != null && throttle >= -250 && throttle <= 250
        && realizedVolatility != null && realizedVolatility >= 0 && realizedVolatility <= 250;
    },
  ) : null;
  const gammaMapMetric = current ? verifiedMarketStructureChartMetric(
    snapshot,
    'spxProbableVolatilityGamma',
    targetDateKey,
    (metric) => {
      const zeroGamma = finiteNumber(metric?.zeroGamma);
      const upperPvBand = finiteNumber(metric?.upperPvBand);
      const lowerPvBand = finiteNumber(metric?.lowerPvBand);
      const strikesInPlay = Array.isArray(metric?.strikesInPlay)
        ? metric.strikesInPlay.map(finiteNumber)
        : [];
      return zeroGamma != null && zeroGamma >= 100 && zeroGamma <= 100_000
        && upperPvBand != null && upperPvBand >= 100 && upperPvBand <= 100_000
        && lowerPvBand != null && lowerPvBand >= 100 && lowerPvBand <= 100_000
        && lowerPvBand < upperPvBand
        && strikesInPlay.length > 0 && strikesInPlay.length <= 20
        && strikesInPlay.every((value) => value != null && value >= 100 && value <= 100_000);
    },
  ) : null;
  const gammaExposureRaw = spx.gammaExposure
    ?? spx.spxGammaExposure
    ?? data.gammaExposure
    ?? data.spxGammaExposure
    ?? marketStructureSignalValue(reportSignals, 'spxGammaExposure', 'SPX Gamma Exposure');
  const systematicRaw = spx.systematicFlowRisk
    ?? spx.systematicFlow
    ?? data.systematicFlowRisk
    ?? data.systematicFlow
    ?? marketStructureSignalValue(reportSignals, 'systematicFlowRisk', 'Systematic Flow Risk');
  const pvRaw = spx.pvBandRiskReward
    ?? spx.pvBand
    ?? data.pvBandRiskReward
    ?? data.pvBand
    ?? marketStructureSignalValue(reportSignals, 'pvBandRiskReward', 'PV Band Risk/Reward');
  const allocationRaw = spx.strategicAllocation
    ?? data.strategicAllocation
    ?? marketStructureSignalValue(reportSignals, 'strategicAllocation', 'Strategic Allocation');
  const narrativeGammaThrottle = completeReport ? explicitMarketStructureNumber(snapshot, [
      /\b(?:SPX\s+)?GAMMA(?:\s+VOLATILITY)?\s+THROTTLE\b\s*(?::|=|AT|IS|OF)\s*([+-]?\d+(?:\.\d+)?)/i,
      /\bGVT(?:\s+INDEX)?\b\s*(?::|=|AT|IS|OF)\s*([+-]?\d+(?:\.\d+)?)/i,
      /\bGVT(?:\s+INDEX)?\b\s*(?:(?:HAS\s+)?(?:RISEN|FALLEN|INCREASED|DECREASED|MOVED)\s+)?(?:TO|AT|IS|OF|=|:)\s*([+-]?\d+(?:\.\d+)?)/i,
    ]) : null;
  const narrativeRealizedVol10d = completeReport ? explicitMarketStructureNumber(snapshot, [
    /\b(?:CORRESPONDING\s+)?10\s*[-–— ]?\s*DAY\s+REALIZED\s+VOLATILITY\b\s*(?:OF|AT|IS|TO|=|:)\s*([+-]?\d+(?:\.\d+)?)/i,
    /\b10D\s+REALIZED\s+VOLATILITY\b\s*(?:OF|AT|IS|TO|=|:)\s*([+-]?\d+(?:\.\d+)?)/i,
  ]) : null;
  const structuredGammaThrottle = spx.gammaThrottle
    ?? spx.gammaVolatilityThrottle
    ?? data.gammaThrottle
    ?? data.gammaVolatilityThrottle;
  const structuredRealizedVol10d = spx.realizedVol10d
    ?? spx.tenDayRealizedVolatility
    ?? data.realizedVol10d
    ?? data.tenDayRealizedVolatility;
  const gammaThrottleRaw = throttleMetric?.gammaThrottle
    ?? structuredGammaThrottle
    ?? narrativeGammaThrottle;
  const realizedVol10dRaw = throttleMetric?.tenDayRealizedVolatility
    ?? structuredRealizedVol10d
    ?? narrativeRealizedVol10d;
  const hasPublishedGammaMetric = current
    && (finiteNumber(gammaThrottleRaw) != null || finiteNumber(realizedVol10dRaw) != null);
  const gammaMetricSource = throttleMetric?.source
    || (narrativeGammaThrottle != null || narrativeRealizedVol10d != null
      ? 'Market Situation Report narrative'
      : hasPublishedGammaMetric ? 'Market Situation Report structured data' : null);
  const normalized = {
    date: sourceDate,
    validFrom: coverage?.validFrom || null,
    validThrough: coverage?.validThrough || null,
    validForDate: current ? targetDateKey : null,
    scrapedAt: isoTimestamp(snapshot?.scrapedAt || snapshot?.publishedAt || snapshot?.updatedAt),
    source: snapshot
      ? (snapshot.snapshotType === 'market-structure' ? 'Market Situation Report' : snapshot.snapshotType)
      : null,
    gammaExposure: current ? normalizeGammaExposure(gammaExposureRaw) : null,
    gammaExposureRaw: current ? gammaExposureRaw : null,
    gammaThrottle: current ? finiteNumber(gammaThrottleRaw) : null,
    realizedVol10d: current ? finiteNumber(realizedVol10dRaw) : null,
    systematicFlow: current ? normalizeStructureToken(systematicRaw, 'flow') : null,
    systematicFlowRaw: current ? systematicRaw : null,
    pvBand: current ? normalizeStructureToken(pvRaw, 'pv') : null,
    pvBandRaw: current ? pvRaw : null,
    strategicAllocation: current ? normalizeStructureToken(allocationRaw, 'allocation') : null,
    strategicAllocationRaw: current ? allocationRaw : null,
    gammaThrottleDate: throttleMetric?.chartDate || (hasPublishedGammaMetric ? sourceDate : null),
    gammaThrottleSource: gammaMetricSource,
    gammaThrottleExtraction: throttleMetric ? 'chart_ocr'
      : narrativeGammaThrottle != null || narrativeRealizedVol10d != null ? 'narrative' : 'structured',
    zeroGamma: gammaMapMetric ? finiteNumber(gammaMapMetric.zeroGamma) : null,
    upperPvBand: gammaMapMetric ? finiteNumber(gammaMapMetric.upperPvBand) : null,
    lowerPvBand: gammaMapMetric ? finiteNumber(gammaMapMetric.lowerPvBand) : null,
    strikesInPlay: gammaMapMetric
      ? gammaMapMetric.strikesInPlay.map(finiteNumber).filter((value) => value != null)
      : [],
    gammaMapDate: gammaMapMetric?.chartDate || null,
    gammaMapSource: gammaMapMetric?.source || null,
  };
  const asOf = normalized.scrapedAt || sourceDate;
  const expiresAt = current ? isoAfter(new Date(nowMs), 30 * 60_000) : null;
  const sessionReason = sourceDate && !current
    ? 'The latest Market Situation Report does not cover this contract session.'
    : null;
  return {
    input: normalized,
    gamma: normalized.gammaExposure ? {
      status: 'available',
      value: normalized.gammaExposure,
      throttle: normalized.gammaThrottle,
      realizedVol10d: normalized.realizedVol10d,
      metricAsOf: normalized.gammaThrottleDate,
      metricSource: normalized.gammaThrottleDate
        ? normalized.gammaThrottleExtraction === 'chart_ocr'
          ? ['Market Situation Report chart OCR', normalized.gammaThrottleSource].filter(Boolean).join(' · ')
          : normalized.gammaThrottleSource
        : null,
      contextOnly: false,
      source: normalized.source,
      asOf,
      expiresAt,
      reason: null,
    } : unavailable(sessionReason || 'Current SPX gamma exposure is unavailable.', {
      throttle: normalized.gammaThrottle,
      realizedVol10d: normalized.realizedVol10d,
      metricAsOf: normalized.gammaThrottleDate,
      metricSource: null,
      contextOnly: false,
    }),
    breadth: normalized.systematicFlow && normalized.pvBand && normalized.strategicAllocation ? {
      status: 'available',
      systematicFlow: normalized.systematicFlow,
      pvBand: normalized.pvBand,
      strategicAllocation: normalized.strategicAllocation,
      source: normalized.source,
      asOf,
      expiresAt,
      reason: null,
    } : unavailable(sessionReason || 'Current Hedgeye structure breadth is unavailable.'),
    levels: gammaMapMetric ? {
      status: 'available',
      zeroGamma: normalized.zeroGamma,
      upperPvBand: normalized.upperPvBand,
      lowerPvBand: normalized.lowerPvBand,
      strikesInPlay: normalized.strikesInPlay,
      source: ['Market Situation Report chart OCR', normalized.gammaMapSource].filter(Boolean).join(' · '),
      asOf: normalized.gammaMapDate,
      expiresAt,
      contextOnly: true,
      reason: null,
    } : unavailable(
      sessionReason || (
        snapshot?.schemaVersion === MARKET_STRUCTURE_SCHEMA_VERSION
          ? 'The current Market Situation Report did not publish a verified SPX gamma-level chart.'
          : 'The current Market Situation Report was ingested without verified SPX chart metrics.'
      ),
      {
        zeroGamma: null,
        upperPvBand: null,
        lowerPvBand: null,
        strikesInPlay: [],
        contextOnly: true,
      },
    ),
  };
}

function selectCftcEminiRow(snapshotValue, nowMs) {
  const allSnapshots = Array.isArray(snapshotValue) ? snapshotValue : snapshotValue ? [snapshotValue] : [];
  const latestCandidate = latestSnapshot(allSnapshots);
  const snapshots = allSnapshots
    .filter((candidate) => (
      candidate?.snapshotType === 'cftc-positioning'
      && candidate?.source === CFTC_OFFICIAL_SOURCE
    ))
    .sort((left, right) => (
      String(right?.date || '').localeCompare(String(left?.date || ''))
      || String(right?.retrievedAt || right?.scrapedAt || '').localeCompare(
        String(left?.retrievedAt || left?.scrapedAt || ''),
      )
    ));
  const snapshot = snapshots[0] || null;
  const sourceDate = dateKey(snapshot?.date);
  const sourceMs = sourceDate ? Date.parse(`${sourceDate}T23:59:59.000Z`) : NaN;
  const ageMs = nowMs - sourceMs;
  const forbiddenCache = [
    snapshot?.cacheState === 'stale' ? 'stale' : '',
    snapshot?.cachedOnly ? 'cached-only' : '',
    snapshot?.fromCache ? 'cached' : '',
    snapshot?.provenance,
    snapshot?.sourceStatus,
  ].filter(Boolean).join(' ');
  const officialContract = (
    snapshot?.schemaVersion === CFTC_SCHEMA_VERSION
    && snapshot?.calculationVersion === CFTC_CALCULATION_VERSION
    && snapshot?.decisionEligible === true
    && snapshot?.reportDate === sourceDate
    && snapshot?.datasetIds?.legacy === 'srt6-5q2f'
    && /^[a-f0-9]{64}$/i.test(String(snapshot?.sourceContentHash || ''))
    && !FORBIDDEN_PROVENANCE.test(forbiddenCache)
  );
  if (!Number.isFinite(sourceMs) || ageMs < -24 * 60 * 60_000 || ageMs > CFTC_MAX_AGE_MS) {
    const candidateDate = dateKey(latestCandidate?.date);
    const candidateSource = String(latestCandidate?.source || '').trim();
    return unavailable(
      candidateDate
        ? `The only stored CFTC snapshot is ${candidateDate} from ${candidateSource || 'an unverified source'}; current official positioning is unavailable.`
        : 'The official CFTC publisher has not produced a current positioning snapshot.',
      { date: candidateDate, zScore1Y: null, zScore3Y: null, contextOnly: true },
    );
  }
  if (!officialContract) {
    return unavailable('Verified official CFTC provenance is unavailable.', {
      date: sourceDate,
      zScore1Y: null,
      zScore3Y: null,
      contextOnly: true,
    });
  }
  const rows = Array.isArray(snapshot?.data)
    ? snapshot.data
    : Array.isArray(snapshot?.data?.rows)
      ? snapshot.data.rows
      : [];
  const exactRows = rows.filter((row) => row?.cftcContractMarketCode === CFTC_SPX_CONTRACT_CODE);
  const row = exactRows.length === 1 ? exactRows[0] : null;
  const zScore1Y = finiteNumber(row?.zScore1Y);
  const zScore3Y = finiteNumber(row?.zScore3Y);
  const latest = finiteNumber(row?.latest);
  const weeklyChange = finiteNumber(row?.wwChg);
  const validRow = (
    row?.status === 'current'
    && row?.decisionEligible === true
    && row?.asOf === sourceDate
    && row?.seriesType === 'legacy-noncommercial-combined'
    && zScore1Y != null
    && zScore3Y != null
    && latest != null
    && weeklyChange != null
  );
  if (!row || !validRow) {
    return unavailable(exactRows.length > 1
      ? 'Official CFTC SPX 13874A row is ambiguous.'
      : 'Official CFTC SPX 13874A row is unavailable.', {
        date: sourceDate,
        zScore1Y: null,
        zScore3Y: null,
        contextOnly: true,
      });
  }
  return {
    status: 'available',
    metric: row.metric,
    value: zScore1Y,
    zScore1Y,
    zScore3Y,
    latest,
    weeklyChange,
    date: sourceDate,
    source: CFTC_OFFICIAL_SOURCE,
    contractCode: CFTC_SPX_CONTRACT_CODE,
    calculationVersion: CFTC_CALCULATION_VERSION,
    contextOnly: true,
    asOf: sourceDate,
    expiresAt: new Date(sourceMs + CFTC_MAX_AGE_MS).toISOString(),
    reason: null,
  };
}

function normalizeSpyVolume(history, nowMs, sessionState, providerStatus = null) {
  if (!isVerifiedIbkrHistory(history, providerStatus)) {
    return unavailable('Verified IBKR SPY volume history is unavailable.', { ratio: null });
  }
  const bars = (Array.isArray(history?.bars) ? history.bars : [])
    .map((bar) => {
      const timestamp = historicalBarTimestamp(bar?.date ?? bar?.timestamp ?? bar?.time);
      const volume = finiteNumber(bar?.volume);
      const parts = newYorkParts(timestamp);
      if (timestamp == null || volume == null || volume < 0 || !parts || timestamp > nowMs + 60_000) return null;
      return { timestamp, volume, date: parts.date, minutes: parts.minutes };
    })
    .filter(Boolean)
    .sort((left, right) => left.timestamp - right.timestamp);
  const targetDate = sessionState === 'open'
    ? newYorkParts(nowMs)?.date
    : latestCompletedSpxSessionDate(nowMs);
  const targetBars = bars.filter((bar) => bar.date === targetDate);
  const latest = targetBars[targetBars.length - 1] || null;
  const completedSession = sessionState !== 'open';
  const completeHistoricalCoverage = !completedSession || latest?.minutes >= (15 * 60 + 50);
  if (!latest || !completeHistoricalCoverage || (sessionState === 'open' && nowMs - latest.timestamp > LIVE_BAR_MAX_AGE_MS)) {
    return unavailable('Current IBKR SPY RTH volume is unavailable.', { ratio: null });
  }
  const cutoffMinutes = sessionState === 'open' ? latest.minutes : Number.POSITIVE_INFINITY;
  const sessionTotals = new Map();
  bars.forEach((bar) => {
    if (bar.date >= targetDate || bar.minutes > cutoffMinutes) return;
    sessionTotals.set(bar.date, (sessionTotals.get(bar.date) || 0) + bar.volume);
  });
  const comparisonDates = [...sessionTotals.keys()].sort().slice(-20);
  if (comparisonDates.length < 20) {
    return unavailable('Twenty completed IBKR SPY comparison sessions are unavailable.', { ratio: null });
  }
  const currentVolume = targetBars
    .filter((bar) => bar.minutes <= cutoffMinutes)
    .reduce((sum, bar) => sum + bar.volume, 0);
  const average20 = comparisonDates.reduce((sum, date) => sum + sessionTotals.get(date), 0) / comparisonDates.length;
  if (!(currentVolume >= 0) || !(average20 > 0)) {
    return unavailable('Verified SPY volume ratio is unavailable.', { ratio: null });
  }
  return {
    status: sessionState === 'open' ? 'available' : 'historical',
    availability: sessionState === 'open' ? 'live' : 'historical',
    value: currentVolume / average20,
    ratio: currentVolume / average20,
    currentVolume,
    average20,
    comparisonSessions: comparisonDates.length,
    source: 'ibkr_historical_bars',
    asOf: new Date(latest.timestamp).toISOString(),
    latestAt: new Date(latest.timestamp).toISOString(),
    historicalThroughDate: completedSession ? targetDate : null,
    expiresAt: sessionState === 'open' ? new Date(latest.timestamp + LIVE_BAR_MAX_AGE_MS).toISOString() : null,
    reason: null,
  };
}

function normalizeContracts(workbench) {
  if (!workbench?.ok || !Array.isArray(workbench.markets) || workbench.markets.length === 0) {
    return unavailable('No verified active KXINXU lines are available.', { event: null, lines: [] });
  }
  const lines = workbench.markets
    .map((market) => ({
      ticker: market.ticker,
      threshold: finiteNumber(market.threshold),
      status: market.nativeBook?.complete ? 'available' : 'incomplete',
      yesBid: finiteNumber(market.yesBid),
      yesAsk: finiteNumber(market.yesAsk),
      yesBidSize: finiteNumber(market.yesBidSize),
      yesAskSize: finiteNumber(market.yesAskSize),
      noBid: finiteNumber(market.noBid),
      noAsk: finiteNumber(market.noAsk),
      noBidSize: finiteNumber(market.noBidSize),
      noAskSize: finiteNumber(market.noAskSize),
      volume24h: finiteNumber(market.volume24h),
      openInterest: finiteNumber(market.openInterest),
      updatedAt: isoTimestamp(market.updatedAt),
      source: 'kalshi_trade_api_v2',
      derivedFields: [],
    }))
    .filter((market) => market.ticker && market.threshold != null)
    .sort((left, right) => left.threshold - right.threshold);
  if (!lines.length) return unavailable('No verified active KXINXU lines are available.', { event: null, lines: [] });
  const asOf = isoTimestamp(workbench.fetchedAt);
  return {
    status: 'available',
    seriesTicker: workbench.seriesTicker,
    event: workbench.event,
    source: 'kalshi_trade_api_v2',
    asOf,
    expiresAt: isoAfter(asOf, CONTRACT_MAX_AGE_MS),
    lines,
    reason: null,
  };
}

function normalizeChart(history, nowMs, sessionState, riskRange, spot, providerStatus = null) {
  if (!isVerifiedIbkrHistory(history, providerStatus)) {
    return unavailable('Verified IBKR SPX intraday history is unavailable.', { points: [], references: [] });
  }
  const targetDate = sessionState === 'open'
    ? newYorkParts(nowMs)?.date
    : latestCompletedSpxSessionDate(nowMs);
  let points = normalizeUnderlyingBars(history?.bars || [], nowMs)
    .filter((point) => historicalBarDateKey(point.timestamp) === targetDate && point.timestamp <= nowMs + 60_000);
  const latest = points[points.length - 1] || null;
  if (!latest || points.length < 2 || (sessionState === 'open' && nowMs - latest.timestamp > LIVE_BAR_MAX_AGE_MS)) {
    return unavailable('Verified current-session IBKR SPX history is unavailable.', { points: [], references: [] });
  }
  if (sessionState === 'open' && spot?.status === 'available') {
    const quoteTime = Date.parse(spot.asOf || '');
    if (Number.isFinite(quoteTime) && quoteTime >= latest.timestamp) {
      points = [...points.filter((point) => point.timestamp < quoteTime), { timestamp: quoteTime, value: spot.value }];
    }
  }
  const chartLatest = points[points.length - 1];
  const references = riskRange?.status === 'available' ? [
    { status: 'available', kind: 'underlying', label: 'LRR', tone: 'low', value: riskRange.lrr, source: riskRange.source, asOf: riskRange.asOf },
    { status: 'available', kind: 'underlying', label: 'HRR', tone: 'high', value: riskRange.hrr, source: riskRange.source, asOf: riskRange.asOf },
  ] : [];
  return {
    status: sessionState === 'open' ? 'available' : 'historical',
    availability: sessionState === 'open' ? 'current' : 'historical',
    range: '1d',
    source: 'ibkr_historical_bars',
    asOf: new Date(chartLatest.timestamp).toISOString(),
    latestAt: new Date(chartLatest.timestamp).toISOString(),
    latestValue: chartLatest.value,
    historicalThroughDate: sessionState === 'open' ? null : targetDate,
    expiresAt: sessionState === 'open' ? new Date(chartLatest.timestamp + LIVE_BAR_MAX_AGE_MS).toISOString() : null,
    points,
    references,
    reason: null,
  };
}

function unavailableMultiDayChart(
  range = '5d',
  reason = `Verified IBKR ${range === '10d' ? 'ten' : 'five'}-session SPX history is unavailable.`,
) {
  return unavailable(reason, {
    range,
    availability: 'unavailable',
    source: null,
    latestAt: null,
    latestValue: null,
    points: [],
    references: [],
    rangeDates: [],
    dailyRanges: [],
    comparisonDate: null,
    comparisonRange: null,
    riskRangeStatus: 'unavailable',
    riskRangeMissingDates: [],
    vixCloses: {
      status: 'unavailable',
      availability: 'unavailable',
      source: null,
      asOf: null,
      values: [],
      missingDates: [],
      reason: 'Verified IBKR VIX daily closes are unavailable.',
    },
    ath: {
      status: 'unavailable',
      source: null,
      asOf: null,
      value: null,
      baseline: null,
      markers: [],
      reason: 'Verified IBKR all-time-high history is unavailable.',
    },
  });
}

function unavailableFiveDayChart(reason) {
  return unavailableMultiDayChart('5d', reason);
}

function isSpxCashPoint(point) {
  const parts = newYorkParts(point?.timestamp);
  return Boolean(parts && parts.minutes >= (9 * 60 + 30) && parts.minutes <= (16 * 60));
}

function riskRangeEndpointValues(range) {
  if (range?.status !== 'available' || !Array.isArray(range?.references)) return null;
  const lrr = finiteNumber(range.references.find((reference) => (
    String(reference?.label || '').toUpperCase() === 'LRR'
  ))?.value);
  const hrr = finiteNumber(range.references.find((reference) => (
    String(reference?.label || '').toUpperCase() === 'HRR'
  ))?.value);
  return lrr != null && hrr != null && lrr < hrr ? { lrr, hrr } : null;
}

function classifyRiskRangeStructure(previousRange, currentRange) {
  const previous = riskRangeEndpointValues(previousRange);
  const current = riskRangeEndpointValues(currentRange);
  if (!previous || !current) {
    return {
      status: 'unavailable',
      basis: 'risk_range_endpoints',
      comparisonDate: previousRange?.date || null,
      highEvent: null,
      lowEvent: null,
      reason: 'Exact adjacent-session Risk Range endpoints are unavailable.',
    };
  }
  return {
    status: 'available',
    basis: 'risk_range_endpoints',
    comparisonDate: previousRange.date,
    highEvent: current.hrr > previous.hrr ? 'HH' : current.hrr < previous.hrr ? 'LH' : 'EH',
    lowEvent: current.lrr > previous.lrr ? 'HL' : current.lrr < previous.lrr ? 'LL' : 'EL',
    reason: null,
  };
}

function attachRiskRangeStructure(ranges, comparisonRange) {
  let previousRange = comparisonRange;
  return ranges.map((range) => {
    const structure = classifyRiskRangeStructure(previousRange, range);
    previousRange = range;
    return { ...range, structure };
  });
}

function unavailableAth(reason = 'Verified IBKR all-time-high history is unavailable.') {
  return {
    status: 'unavailable',
    source: null,
    asOf: null,
    value: null,
    baseline: null,
    markers: [],
    reason,
  };
}

function loadingAth() {
  return {
    status: 'loading',
    source: null,
    asOf: null,
    value: null,
    baseline: null,
    markers: [],
    reason: 'Verified IBKR all-time-high history is still loading.',
  };
}

function unavailableVixCloses(reason = 'Verified IBKR VIX daily closes are unavailable.', missingDates = []) {
  return {
    status: 'unavailable',
    availability: 'unavailable',
    source: null,
    asOf: null,
    values: [],
    missingDates,
    reason,
  };
}

function loadingVixCloses(rangeDates = []) {
  return {
    status: 'loading',
    availability: 'loading',
    source: null,
    asOf: null,
    values: [],
    missingDates: [...rangeDates],
    reason: 'Verified IBKR VIX daily closes are still loading.',
  };
}

function normalizeVixCloses(history, settlement, rangeDates, providerStatus) {
  const dates = Array.isArray(rangeDates) ? rangeDates : [];
  if (settlement?.status === 'pending') return loadingVixCloses(dates);
  if (settlement?.status === 'rejected') {
    return unavailableVixCloses(
      String(settlement.reason?.message || settlement.reason || 'Verified IBKR VIX daily-close refresh failed.'),
      dates,
    );
  }
  if (!isVerifiedIbkrHistory(history, providerStatus)) {
    return unavailableVixCloses('Verified IBKR VIX daily-close history is unavailable.', dates);
  }

  const requestedDates = new Set(dates);
  const barsByDate = new Map(dates.map((date) => [date, []]));
  (Array.isArray(history?.bars) ? history.bars : []).forEach((bar) => {
    const date = historicalBarDateKey(bar?.date ?? bar?.timestamp);
    if (!requestedDates.has(date)) return;
    const value = finiteNumber(bar?.close);
    if (value != null && value > 0) barsByDate.get(date).push(value);
  });
  const values = dates.flatMap((date) => {
    const matches = barsByDate.get(date) || [];
    return matches.length === 1 ? [{ date, value: matches[0] }] : [];
  });
  const availableDates = new Set(values.map((row) => row.date));
  const missingDates = dates.filter((date) => !availableDates.has(date));
  if (!values.length) {
    return unavailableVixCloses('No exact-date verified IBKR VIX daily closes are available.', missingDates);
  }
  return {
    status: missingDates.length ? 'partial' : 'available',
    availability: 'historical',
    source: 'ibkr_historical_daily_close',
    asOf: isoTimestamp(history?.asOf),
    values,
    missingDates,
    reason: missingDates.length
      ? `Verified IBKR VIX daily closes are unavailable for ${missingDates.join(', ')}.`
      : null,
  };
}

function verifiedAthRecord(record, comparisonDate, providerStatus) {
  const forbidden = [
    record?.warning,
    record?.error,
    record?.provenance,
    record?.cacheStatus,
    record?.cacheState,
    record?.sourceStatus,
    record?.fromCache ? 'cached' : '',
    record?.cached ? 'cached' : '',
    record?.cachedOnly ? 'cached-only' : '',
    record?.cacheOnly ? 'cache-only' : '',
    record?.cacheHit ? 'cache-hit' : '',
  ].filter(Boolean).join(' ');
  const recordHigh = finiteNumber(record?.recordHigh);
  const coverageStart = String(record?.coverage?.startDate || '');
  const coverageHead = String(record?.coverage?.headDate || '');
  const observations = Number(record?.coverage?.observations);
  const chunks = Number(record?.coverage?.chunks);
  return Boolean(
    providerStatus?.connected === true
    && record?.status === 'available'
    && String(record?.source || '').toLowerCase() === 'ibkr'
    && record?.coverage?.complete === true
    && record?.throughDate === comparisonDate
    && record?.coverage?.endDate === comparisonDate
    && /^\d{4}-\d{2}-\d{2}$/.test(coverageStart)
    && coverageHead === coverageStart
    && Number.isInteger(observations)
    && observations >= 2
    && Number.isInteger(chunks)
    && chunks >= 1
    && /^\d{4}-\d{2}-\d{2}$/.test(String(record?.recordDate || ''))
    && record.recordDate >= coverageStart
    && record.recordDate <= comparisonDate
    && recordHigh != null
    && recordHigh > 0
    && !FORBIDDEN_PROVENANCE.test(forbidden)
  );
}

function normalizeFiveDayAth(recordResult, recordSettlement, points, rangeDates, comparisonDate, providerStatus) {
  if (recordSettlement?.status === 'pending') return loadingAth();
  if (recordSettlement?.status === 'rejected') {
    return unavailableAth(String(recordSettlement.reason?.message || recordSettlement.reason || 'Verified IBKR ATH refresh failed.'));
  }
  if (!comparisonDate) {
    return unavailableAth('A verified prior SPX comparison session is unavailable.');
  }
  if (!verifiedAthRecord(recordResult, comparisonDate, providerStatus)) {
    return unavailableAth(recordResult?.reason || recordResult?.error || 'Verified complete IBKR all-time-high history is unavailable.');
  }

  const byDate = new Map(rangeDates.map((date) => [date, []]));
  points.forEach((point) => {
    const date = historicalBarDateKey(point.timestamp);
    if (byDate.has(date)) byDate.get(date).push(point);
  });
  const incompleteDate = rangeDates.find((date) => {
    const sessionPoints = byDate.get(date) || [];
    return sessionPoints.length < 2 || sessionPoints.some((point) => finiteNumber(point.high) == null || point.high <= 0);
  });
  if (incompleteDate) {
    return unavailableAth(`Verified IBKR intraday highs are incomplete for ${incompleteDate}.`);
  }

  let runningHigh = Number(recordResult.recordHigh);
  const markers = [];
  rangeDates.forEach((date) => {
    const sessionHighPoint = (byDate.get(date) || []).reduce((highest, point) => (
      !highest || Number(point.high) > Number(highest.high) ? point : highest
    ), null);
    if (sessionHighPoint && Number(sessionHighPoint.high) > runningHigh) {
      runningHigh = Number(sessionHighPoint.high);
      markers.push({
        date,
        timestamp: Number(sessionHighPoint.timestamp),
        value: runningHigh,
        label: 'ATH',
      });
    }
  });

  return {
    status: 'available',
    source: 'ibkr_historical_record',
    asOf: recordResult.asOf || null,
    value: runningHigh,
    date: markers[markers.length - 1]?.date || recordResult.recordDate,
    baseline: {
      value: Number(recordResult.recordHigh),
      date: recordResult.recordDate,
      throughDate: comparisonDate,
      source: 'ibkr',
      dataset: recordResult.dataset || 'historical_record',
      coverageComplete: true,
      coverageStart: recordResult.coverage.startDate,
      coverageEnd: recordResult.coverage.endDate,
      coverageHead: recordResult.coverage.headDate,
      chunks: recordResult.coverage.chunks,
      observations: recordResult.coverage.observations,
    },
    markers,
    reason: null,
  };
}

function alignCompletedSpxHourlyBarCloses(points, today, sessionState) {
  const pointsByDate = new Map();
  points.forEach((point) => {
    const date = historicalBarDateKey(point.timestamp);
    if (!date) return;
    if (!pointsByDate.has(date)) pointsByDate.set(date, []);
    pointsByDate.get(date).push(point);
  });

  return [...pointsByDate.entries()].flatMap(([date, sessionPoints]) => {
    const completedSession = sessionState !== 'open' || date !== today;
    const minuteOffsets = sessionPoints.map((point) => newYorkParts(point.timestamp)?.minutes);
    const verifiedHourlyCadence = completedSession
      && sessionPoints.length >= 4
      && minuteOffsets[0] === (9 * 60 + 30)
      && minuteOffsets.slice(1).every((minutes) => (
        Number.isFinite(minutes)
        && minutes >= (10 * 60)
        && minutes <= (15 * 60)
        && minutes % 60 === 0
      ));
    if (!verifiedHourlyCadence) return sessionPoints;

    return sessionPoints.map((point, index) => {
      const nextTimestamp = Number(sessionPoints[index + 1]?.timestamp);
      const closeTimestamp = Number.isFinite(nextTimestamp)
        ? nextTimestamp
        : Number(point.timestamp) + 60 * 60_000;
      const closeParts = newYorkParts(closeTimestamp);
      if (closeParts?.date !== date || closeParts.minutes > 16 * 60) return point;
      return { ...point, timestamp: closeTimestamp };
    });
  }).sort((left, right) => left.timestamp - right.timestamp);
}

function normalizeMultiDayChart(
  chart,
  nowMs,
  sessionState,
  providerStatus,
  currentRiskRange,
  athRecordResult,
  athRecordSettlement,
  vixHistoryResult,
  vixHistorySettlement,
  expectedSessionCount = 5,
) {
  const range = `${expectedSessionCount}d`;
  const sessionLabel = expectedSessionCount === 10 ? 'ten' : 'five';
  if (providerStatus?.connected !== true) {
    return unavailableMultiDayChart(range, `IBKR is disconnected; verified ${sessionLabel}-session SPX history is unavailable.`);
  }
  if (chart?.status !== 'available') {
    return unavailableMultiDayChart(range, chart?.reason || `Verified IBKR ${sessionLabel}-session SPX history is unavailable.`);
  }

  const rangeDates = Array.isArray(chart.rangeDates) ? chart.rangeDates : [];
  const dailyRanges = Array.isArray(chart.dailyRanges) ? chart.dailyRanges : [];
  const today = newYorkParts(nowMs)?.date;
  const sourcePoints = (Array.isArray(chart.points) ? chart.points : [])
    .map((point) => ({
      timestamp: Number(point?.timestamp),
      value: Number(point?.value),
      ...(finiteNumber(point?.high) != null && Number(point.high) > 0 ? { high: Number(point.high) } : {}),
    }))
    .filter((point) => Number.isFinite(point.timestamp)
      && Number.isFinite(point.value)
      && point.value > 0
      && point.timestamp <= nowMs + 60_000
      && isSpxCashPoint(point));
  const points = chart.interval === '1h'
    ? alignCompletedSpxHourlyBarCloses(sourcePoints, today, sessionState)
    : sourcePoints;
  const exactSessions = rangeDates.length === expectedSessionCount
    && dailyRanges.length === expectedSessionCount
    && rangeDates.every((date, index) => date === dailyRanges[index]?.date)
    && rangeDates.every((date) => points.filter((point) => historicalBarDateKey(point.timestamp) === date).length >= 2);
  if (!exactSessions) {
    return unavailableMultiDayChart(range, `Verified IBKR history does not contain ${expectedSessionCount} complete SPX cash sessions.`);
  }

  const currentRangeDate = dateKey(currentRiskRange?.date);
  const normalizedRanges = dailyRanges.map((range) => {
    const sessionPoints = points.filter((point) => historicalBarDateKey(point.timestamp) === range.date);
    const sourceSessionPoints = sourcePoints.filter((point) => historicalBarDateKey(point.timestamp) === range.date);
    const scheduledCloseAt = Date.parse(newYorkLocalTimestamp(range.date, 16 * 60) || '');
    const openCurrentSession = sessionState === 'open' && range.date === today;
    const endAt = openCurrentSession && Number.isFinite(scheduledCloseAt)
      ? scheduledCloseAt
      : sessionPoints[sessionPoints.length - 1].timestamp;
    const startAt = sourceSessionPoints[0]?.timestamp || sessionPoints[0].timestamp;
    if (range.date !== currentRangeDate || currentRiskRange?.status !== 'available') {
      return {
        ...range,
        startAt,
        endAt,
      };
    }
    return {
      ...range,
      status: 'available',
      startAt,
      endAt,
      references: [
        {
          status: 'available', kind: 'underlying', label: 'LRR', tone: 'low',
          value: currentRiskRange.lrr, source: currentRiskRange.source, asOf: currentRiskRange.asOf,
        },
        {
          status: 'available', kind: 'underlying', label: 'HRR', tone: 'high',
          value: currentRiskRange.hrr, source: currentRiskRange.source, asOf: currentRiskRange.asOf,
        },
      ],
      reason: null,
    };
  });
  const ranges = attachRiskRangeStructure(normalizedRanges, chart.comparisonRange || null);
  const latestPoint = points[points.length - 1];
  const includesToday = rangeDates.includes(today);
  const chartMaxAgeMs = chart.interval === '1h' ? 75 * 60_000 : LIVE_BAR_MAX_AGE_MS;
  if (
    sessionState === 'open'
    && includesToday
    && (!latestPoint || nowMs - latestPoint.timestamp > chartMaxAgeMs)
  ) {
    return unavailableMultiDayChart(range, 'Current-session IBKR SPX history is stale.');
  }
  const missingDates = ranges.filter((range) => range.status !== 'available').map((range) => range.date);
  const current = sessionState === 'open' && includesToday;
  return {
    ...chart,
    status: current ? 'available' : 'historical',
    availability: current ? 'current' : 'historical',
    source: 'ibkr_historical_bars',
    asOf: new Date(latestPoint.timestamp).toISOString(),
    latestAt: new Date(latestPoint.timestamp).toISOString(),
    latestValue: latestPoint.value,
    historicalThroughDate: current ? null : rangeDates[rangeDates.length - 1],
    expiresAt: current ? new Date(latestPoint.timestamp + chartMaxAgeMs).toISOString() : null,
    points,
    dailyRanges: ranges,
    comparisonDate: chart.comparisonDate || null,
    comparisonRange: chart.comparisonRange || null,
    riskRangeStatus: missingDates.length ? 'partial' : 'available',
    riskRangeMissingDates: missingDates,
    vixCloses: normalizeVixCloses(
      vixHistoryResult,
      vixHistorySettlement,
      rangeDates,
      providerStatus,
    ),
    ath: normalizeFiveDayAth(
      athRecordResult,
      athRecordSettlement,
      points,
      rangeDates,
      chart.comparisonDate || null,
      providerStatus,
    ),
    reason: null,
  };
}

function deriveMultiDayChart(chart, sessionCount) {
  const range = `${sessionCount}d`;
  if (!['available', 'historical'].includes(chart?.status)) {
    return unavailableMultiDayChart(range, chart?.reason);
  }
  const rangeDates = (chart.rangeDates || []).slice(-sessionCount);
  if (rangeDates.length !== sessionCount) {
    return unavailableMultiDayChart(range, `Verified IBKR history does not contain ${sessionCount} complete SPX cash sessions.`);
  }
  const dateSet = new Set(rangeDates);
  const firstDateIndex = (chart.dailyRanges || []).findIndex((dailyRange) => dailyRange.date === rangeDates[0]);
  const comparisonRange = firstDateIndex > 0 ? chart.dailyRanges[firstDateIndex - 1] : chart.comparisonRange || null;
  const dailyRanges = (chart.dailyRanges || []).filter((dailyRange) => dateSet.has(dailyRange.date));
  const points = (chart.points || []).filter((point) => dateSet.has(historicalBarDateKey(point.timestamp)));
  const vixValues = (chart.vixCloses?.values || []).filter((row) => dateSet.has(row.date));
  const vixValueDates = new Set(vixValues.map((row) => row.date));
  const vixMissingDates = rangeDates.filter((date) => !vixValueDates.has(date));
  const vixCloses = ['available', 'partial'].includes(chart.vixCloses?.status)
    ? {
      ...chart.vixCloses,
      status: vixValues.length ? (vixMissingDates.length ? 'partial' : 'available') : 'unavailable',
      availability: vixValues.length ? 'historical' : 'unavailable',
      source: vixValues.length ? chart.vixCloses.source : null,
      values: vixValues,
      missingDates: vixMissingDates,
      reason: vixMissingDates.length
        ? `Verified IBKR VIX daily closes are unavailable for ${vixMissingDates.join(', ')}.`
        : null,
    }
    : { ...chart.vixCloses, missingDates: rangeDates };
  const ath = chart.ath?.status === 'available'
    ? { ...chart.ath, markers: (chart.ath.markers || []).filter((marker) => dateSet.has(marker.date)) }
    : chart.ath;
  const riskRangeMissingDates = dailyRanges
    .filter((dailyRange) => dailyRange.status !== 'available')
    .map((dailyRange) => dailyRange.date);
  return {
    ...chart,
    range,
    rangeDates,
    dailyRanges,
    points,
    comparisonDate: comparisonRange?.date || null,
    comparisonRange,
    riskRangeStatus: riskRangeMissingDates.length ? 'partial' : 'available',
    riskRangeMissingDates,
    vixCloses,
    ath,
  };
}

function vixBucket(value) {
  if (value >= 9 && value < 20) return 'investable';
  if (value >= 20 && value < 29) return 'chop';
  if (value >= 29) return 'uninvestable';
  return null;
}

function normalizeVolatilityQuote(quote, ticker) {
  if (!['available', 'historical'].includes(quote?.status)) {
    return { ...quote, bucket: null, current: false, date: null };
  }
  return {
    ...quote,
    bucket: ticker === 'VIX' ? vixBucket(quote.value) : null,
    current: quote.status === 'available',
    date: quote.historicalThroughDate || dateKey(quote.asOf),
  };
}

function createSpxMonitorService(options = {}) {
  const now = options.now || (() => new Date());
  const getContracts = options.getContracts || (() => getSpxCloseWorkbench({
    allowIncompleteBooks: true,
    now: () => now().getTime(),
  }));
  const getProviderStatus = options.getProviderStatus || (() => ibkrMarketDataProvider.getProviderStatus());
  const getQuote = options.getQuote || ((instrument) => ibkrMarketDataProvider.getQuote(instrument));
  const getHistoricalBars = options.getHistoricalBars || ((instrument, range, interval) => (
    ibkrMarketDataProvider.getHistoricalBars(instrument, range, interval)
  ));
  const getHistoricalRecord = options.getHistoricalRecord || ((instrument, throughDate) => (
    ibkrMarketDataProvider.getHistoricalRecord(instrument, throughDate)
  ));
  const loadRiskRangeSignal = options.loadRiskRangeSignal || ((context, requestNow) => (
    getOverviewSignalAvailability(context, { now: requestNow, useCache: false })
  ));
  const loadRiskRangeHistory = options.loadRiskRangeHistory || ((context) => (
    getRiskRangeHistoryAvailability(context, { useCache: false })
  ));
  const loadRtaRiskRange = options.loadRtaRiskRange || ((context) => getLatestSpxRtaRiskRange(context));
  const loadTradeSnapshots = options.loadTradeSnapshots || (async () => []);
  const loadCftcSnapshots = options.loadCftcSnapshots || (async () => []);
  const loadMarketStructureSnapshots = options.loadMarketStructureSnapshots || (async () => []);
  const loadUsdSnapshot = options.loadUsdSnapshot || (async () => null);
  const refreshBudgetMs = Math.max(250, Number(options.refreshBudgetMs) || INITIAL_REFRESH_BUDGET_MS);
  const sharedResearch = new Map();

  function sharedLoad(key, loader, ttlMs = 30_000, shouldCache = () => true) {
    const requestNow = now();
    const nowMs = requestNow instanceof Date ? requestNow.getTime() : Number(requestNow);
    const cached = sharedResearch.get(key);
    if (cached?.value !== undefined && nowMs < cached.expiresAt) return Promise.resolve(cached.value);
    if (cached?.inFlight) return cached.inFlight;
    const entry = cached || { value: undefined, expiresAt: 0, inFlight: null };
    entry.inFlight = Promise.resolve().then(loader).then((value) => {
      const completedNow = now();
      const completedMs = completedNow instanceof Date ? completedNow.getTime() : Number(completedNow);
      if (shouldCache(value)) {
        entry.value = value;
        entry.expiresAt = completedMs + ttlMs;
      } else {
        entry.value = undefined;
        entry.expiresAt = 0;
      }
      return value;
    }).finally(() => {
      entry.inFlight = null;
    });
    sharedResearch.set(key, entry);
    return entry.inFlight;
  }

  function sharedHistoricalBars(instrument, range, interval) {
    const ttlMs = interval === '1h'
      ? HOURLY_CHART_TTL_MS
      : interval === '1d' ? DAILY_BARS_TTL_MS : HISTORICAL_BARS_TTL_MS;
    const key = [
      'ibkr-history',
      instrument?.symbol,
      instrument?.secType,
      instrument?.exchange,
      range,
      interval,
    ].join(':');
    return sharedLoad(
      key,
      () => getHistoricalBars(instrument, range, interval),
      ttlMs,
      (value) => isVerifiedIbkrHistory(value, { connected: true })
        && Array.isArray(value?.bars)
        && value.bars.length > 0,
    );
  }

  async function getSnapshot({ includeContracts = true, targetClose: requestedTargetClose = null } = {}) {
    const requestDate = now();
    const nowMs = requestDate.getTime();
    const deadlineMs = Date.now() + refreshBudgetMs;
    const sessionState = spxCashSessionState(nowMs);
    const contractsPromise = includeContracts ? invoke(getContracts) : Promise.resolve(null);
    const oneDayChartPromise = sharedHistoricalBars(SPX_INSTRUMENT, '1d', '5m');
    const dailyClosePromise = sessionState === 'closed'
      ? oneDayChartPromise.then(() => sharedHistoricalBars(SPX_INSTRUMENT, '5d', '1d'))
      : Promise.resolve(null);
    // IBKR historical requests are intentionally sequenced. Concurrent history
    // requests can be paced or serialized by the gateway and take much longer
    // than the same requests run in order. Load the chart before the secondary
    // VIX-close and SPY-volume histories, while allowing a failed fast section
    // to fail closed without preventing the ten-session request from starting.
    const tenDayHistoryPromise = (sessionState === 'closed' ? dailyClosePromise : oneDayChartPromise)
      .catch(() => null)
      .then(async (sequencedHistory) => {
        const multiDayHistory = await sharedHistoricalBars(SPX_INSTRUMENT, '11d', '1h');
        return sessionState === 'open'
          ? mergeVerifiedCurrentSessionHistory(multiDayHistory, sequencedHistory, nowMs)
          : multiDayHistory;
      });
    const chartDate = newYorkParts(nowMs)?.date || requestDate.toISOString().slice(0, 10);
    const tenDayChartPromise = sharedLoad(
      `spx-chart:10d:${chartDate}:${sessionState}`,
      () => buildUnderlyingMultiDayChart(
        {
          kind: 'underlying',
          ticker: 'SPX',
          label: 'S&P 500 index',
          unit: 'index',
          source: 'ibkr_historical_bars',
          points: [],
          references: [],
        },
        {
          getHistoricalBars: (instrument, range, interval) => (
            instrument?.symbol === 'SPX' && range === '11d' && interval === '1h'
              ? tenDayHistoryPromise
              : sharedHistoricalBars(instrument, range, interval)
          ),
          getRiskRangeHistory: loadRiskRangeHistory,
        },
        {
          label: 'SPX',
          riskRangeTicker: 'SPX',
          multiDaySessionCount: 10,
          multiDayHistoryRange: '11d',
          multiDayHistoryInterval: '1h',
          historyRetryAttempts: 1,
          includeRiskRangeComparison: true,
          isSessionOpen: (value) => spxCashSessionState(value) === 'open',
          pointFilter: isSpxCashPoint,
        },
        SPX_INSTRUMENT,
        nowMs,
      ),
      HOURLY_CHART_TTL_MS,
      (value) => value?.status === 'available'
        && Array.isArray(value?.points)
        && value.points.length > 0
        && value?.riskRangeStatus === 'available',
    );
    const vixDailyHistoryPromise = tenDayChartPromise
      .then(() => sharedHistoricalBars(VIX_INSTRUMENT, '11d', '1d'));
    const vvixDailyHistoryPromise = sessionState === 'closed'
      ? vixDailyHistoryPromise
        .catch(() => null)
        .then(() => sharedHistoricalBars(VVIX_INSTRUMENT, '11d', '1d'))
      : Promise.resolve(null);
    const spyVolumePromise = (sessionState === 'closed' ? vvixDailyHistoryPromise : vixDailyHistoryPromise)
      .catch(() => null)
      .then(() => sharedHistoricalBars(SPY_INSTRUMENT, '1mo', '5m'));
    const athRecordPromise = tenDayChartPromise.then((tenDayChart) => {
      const comparisonDate = tenDayChart?.comparisonDate;
      if (tenDayChart?.status !== 'available' || !comparisonDate) {
        return {
          status: 'unavailable',
          source: null,
          recordHigh: null,
          recordDate: null,
          throughDate: comparisonDate || null,
          coverage: null,
          reason: 'A verified prior SPX comparison session is unavailable.',
        };
      }
      return sharedLoad(
        `spx-ath:${comparisonDate}`,
        () => getHistoricalRecord(SPX_INSTRUMENT, comparisonDate),
        ATH_RECORD_TTL_MS,
        (value) => value?.status === 'available',
      );
    });
    const independentPromise = Promise.all([
      settleByDeadline(invoke(getProviderStatus), deadlineMs, 'IBKR provider status'),
      settleByDeadline(sessionState === 'open' ? invoke(getQuote, SPX_INSTRUMENT) : Promise.resolve(null), deadlineMs, 'SPX quote'),
      settleByDeadline(sessionState === 'open' ? invoke(getQuote, SPY_INSTRUMENT) : Promise.resolve(null), deadlineMs, 'SPY quote'),
      settleByDeadline(sessionState === 'open' ? invoke(getQuote, VIX_INSTRUMENT) : Promise.resolve(null), deadlineMs, 'VIX quote'),
      settleByDeadline(sessionState === 'open' ? invoke(getQuote, VVIX_INSTRUMENT) : Promise.resolve(null), deadlineMs, 'VVIX quote'),
      settleByDeadline(oneDayChartPromise, deadlineMs, 'SPX intraday chart'),
      settleByDeadline(tenDayChartPromise, deadlineMs, 'SPX ten-session chart'),
      settleByDeadline(athRecordPromise, deadlineMs, 'SPX all-time-high history'),
      settleByDeadline(vixDailyHistoryPromise, deadlineMs, 'VIX daily-close history'),
      settleByDeadline(vvixDailyHistoryPromise, deadlineMs, 'VVIX daily-close history'),
      settleByDeadline(dailyClosePromise, deadlineMs, 'SPX daily chart'),
      settleByDeadline(spyVolumePromise, deadlineMs, 'SPY volume history'),
      settleByDeadline(sharedLoad('trade', () => loadTradeSnapshots({ limit: 2 })), deadlineMs, 'trade context'),
      settleByDeadline(sharedLoad('cftc', () => loadCftcSnapshots({ limit: 2 })), deadlineMs, 'CFTC positioning'),
      settleByDeadline(sharedLoad('market-structure', () => loadMarketStructureSnapshots({ limit: 2 })), deadlineMs, 'market structure'),
      settleByDeadline(sharedLoad('usd', () => loadUsdSnapshot()), deadlineMs, 'USD correlation'),
    ]);
    const contractsResult = await settleByDeadline(contractsPromise, deadlineMs, 'Kalshi contracts');
    const workbench = settledValue(contractsResult);
    const targetClose = workbench?.event?.closeTime || requestedTargetClose || requestDate.toISOString();
    const researchResultsPromise = Promise.all([
      settleByDeadline(sharedLoad(
        `risk-range:${targetClose}`,
        () => loadRiskRangeSignal({ market: 'spx', event: { closeTime: targetClose } }, nowMs),
      ), deadlineMs, 'SPX Risk Range'),
      settleByDeadline(sharedLoad('rta-risk-range', () => loadRtaRiskRange({ now: nowMs })), deadlineMs, 'RTA Risk Range'),
    ]);
    const [independent, researchResults] = await Promise.all([independentPromise, researchResultsPromise]);
    const [
      providerStatusResult,
      spxQuoteResult,
      spyQuoteResult,
      vixQuoteResult,
      vvixQuoteResult,
      spxChartResult,
      spxTenDayChartResult,
      spxAthRecordResult,
      vixDailyHistoryResult,
      vvixDailyHistoryResult,
      spxDailyResult,
      spyVolumeResult,
      tradeResult,
      cftcResult,
      structureResult,
      usdResult,
    ] = independent;
    const [riskSignalResult, rtaRangeResult] = researchResults;

    const providerStatus = settledValue(providerStatusResult, { connected: false });
    const contracts = includeContracts
      ? markRefreshFailure(
          normalizeContracts(workbench),
          contractsResult,
          'Kalshi contract refresh failed',
        )
      : unavailable('Cash-SPX contracts are outside the ForecastEx FES monitor.', { event: null, lines: [] });
    const baselineSignal = settledValue(riskSignalResult, { status: 'unavailable' });
    const riskSignal = applySpxRtaRiskRange(baselineSignal, settledValue(rtaRangeResult));
    const riskRange = markRefreshFailure(
      normalizeRiskRange(riskSignal, nowMs),
      // The Real-Time Alert is an optional intraday overlay. Its failure must
      // not invalidate a verified current daily Risk Range baseline.
      riskSignalResult,
      'Hedgeye Risk Range refresh failed',
    );
    const targetDate = dateKey(contracts.event?.closeTime || targetClose);
    const cashSessionDate = sessionState === 'open'
      ? newYorkParts(nowMs)?.date
      : latestCompletedSpxSessionDate(nowMs);
    // ForecastEx contracts can close on the following calendar day. Hedgeye's
    // daily research is keyed to the underlying SPX cash session instead, so
    // using the contract close date here incorrectly rejects today's report.
    const researchDate = dateKey(riskRange.date) || cashSessionDate || targetDate;
    const liveSpot = sessionState === 'open'
      ? resolveVerifiedIbkrQuote(settledValue(spxQuoteResult), providerStatus, 'SPX', nowMs)
      : resolveVerifiedIbkrClose(
        settledValue(spxDailyResult),
        latestCompletedSpxSessionDate(nowMs),
        'SPX',
        providerStatus,
      );
    const spot = markRefreshFailure({
      ...liveSpot,
      label: sessionState === 'open' ? 'LIVE SPX' : 'LAST CLOSE',
    }, [providerStatusResult, sessionState === 'open' ? spxQuoteResult : spxDailyResult], 'IBKR SPX refresh failed');
    const spySpot = sessionState === 'open'
      ? markRefreshFailure(
          resolveVerifiedIbkrQuote(settledValue(spyQuoteResult), providerStatus, 'SPY', nowMs),
          [providerStatusResult, spyQuoteResult],
          'IBKR SPY quote refresh failed',
        )
      : markRefreshFailure({
          ...resolveVerifiedIbkrSessionClose(
            settledValue(spyVolumeResult),
            latestCompletedSpxSessionDate(nowMs),
            'SPY',
            providerStatus,
          ),
          label: 'LAST CLOSE',
        }, [providerStatusResult, spyVolumeResult], 'IBKR SPY close refresh failed');
    const vixReference = sessionState === 'open'
      ? resolveVerifiedIbkrQuote(settledValue(vixQuoteResult), providerStatus, 'VIX', nowMs)
      : resolveVerifiedIbkrClose(
        settledValue(vixDailyHistoryResult),
        latestCompletedSpxSessionDate(nowMs),
        'VIX',
        providerStatus,
      );
    const vvixReference = sessionState === 'open'
      ? resolveVerifiedIbkrQuote(settledValue(vvixQuoteResult), providerStatus, 'VVIX', nowMs)
      : resolveVerifiedIbkrClose(
        settledValue(vvixDailyHistoryResult),
        latestCompletedSpxSessionDate(nowMs),
        'VVIX',
        providerStatus,
      );
    const vix = markRefreshFailure(normalizeVolatilityQuote(
      vixReference,
      'VIX',
    ), [providerStatusResult, sessionState === 'open' ? vixQuoteResult : vixDailyHistoryResult], 'IBKR VIX refresh failed');
    const vvix = markRefreshFailure(normalizeVolatilityQuote(
      vvixReference,
      'VVIX',
    ), [providerStatusResult, sessionState === 'open' ? vvixQuoteResult : vvixDailyHistoryResult], 'IBKR VVIX refresh failed');
    const usd = markRefreshFailure(
      normalizeUsdCorrelation(settledValue(usdResult), nowMs),
      usdResult,
      'USD correlation refresh failed',
    );
    const dxy = markRefreshFailure(
      normalizeDxyContext(settledValue(usdResult), nowMs),
      usdResult,
      'DXY context refresh failed',
    );
    const trade = markRefreshFailure(
      normalizeTrade(settledValue(tradeResult), riskRange, researchDate, nowMs),
      tradeResult,
      'Hedgeye Trade refresh failed',
    );
    const structure = normalizeMarketStructure(settledValue(structureResult), researchDate, nowMs);
    structure.gamma = markRefreshFailure(
      structure.gamma,
      structureResult,
      'Hedgeye gamma refresh failed',
    );
    structure.breadth = markRefreshFailure(
      structure.breadth,
      structureResult,
      'Hedgeye structure refresh failed',
    );
    const cftc = markRefreshFailure(
      selectCftcEminiRow(settledValue(cftcResult), nowMs),
      cftcResult,
      'CFTC positioning refresh failed',
    );
    const spyVolume = markRefreshFailure(
      normalizeSpyVolume(settledValue(spyVolumeResult), nowMs, sessionState, providerStatus),
      [providerStatusResult, spyVolumeResult],
      'IBKR SPY volume refresh failed',
    );
    const oneDayChart = markRefreshFailure(normalizeChart(
      settledValue(spxChartResult),
      nowMs,
      sessionState,
      riskRange,
      spot,
      providerStatus,
    ), [providerStatusResult, spxChartResult], 'IBKR SPX chart refresh failed');
    const tenDayChart = markRefreshFailure(normalizeMultiDayChart(
      settledValue(spxTenDayChartResult),
      nowMs,
      sessionState,
      providerStatus,
      riskRange,
      settledValue(spxAthRecordResult),
      spxAthRecordResult,
      settledValue(vixDailyHistoryResult),
      vixDailyHistoryResult,
      10,
    ), [providerStatusResult, spxTenDayChartResult], 'IBKR SPX ten-session chart refresh failed');
    const fiveDayChart = deriveMultiDayChart(tenDayChart, 5);
    const oneDayChartWithAth = {
      ...oneDayChart,
      ath: tenDayChart.ath || unavailableAth(),
    };
    const chart = {
      ...oneDayChartWithAth,
      variants: {
        '1d': { ...oneDayChartWithAth },
        '5d': fiveDayChart,
        '10d': tenDayChart,
      },
    };

    const factors = {
      dxy,
      usd,
      cftc,
      gamma: structure.gamma,
      gammaLevels: structure.levels,
      spyVolume,
      vix,
      vvix,
      structure: structure.breadth,
      trade,
    };
    const unavailableFactorCount = Object.values(factors)
      .filter((factor) => factor?.contextOnly !== true && factor?.status === 'unavailable').length;
    const anyCore = (includeContracts && contracts.status === 'available') || ['available', 'historical'].includes(chart.status);
    const allCore = (!includeContracts || contracts.status === 'available') && ['available', 'historical'].includes(chart.status);
    const errors = [
      includeContracts ? errorMessage(contractsResult, 'Kalshi contracts unavailable') : null,
      errorMessage(providerStatusResult, 'IBKR status unavailable'),
      errorMessage(spxChartResult, 'IBKR SPX history unavailable'),
      errorMessage(spxTenDayChartResult, 'IBKR SPX ten-session history unavailable'),
      errorMessage(spxAthRecordResult, 'IBKR SPX all-time-high history unavailable'),
      errorMessage(vixDailyHistoryResult, 'IBKR VIX daily-close history unavailable'),
      errorMessage(vvixDailyHistoryResult, 'IBKR VVIX daily-close history unavailable'),
      errorMessage(riskSignalResult, 'Risk Range unavailable'),
      errorMessage(rtaRangeResult, 'RTA Risk Range unavailable'),
      errorMessage(tradeResult, 'Trade signal unavailable'),
      errorMessage(cftcResult, 'CFTC positioning unavailable'),
      errorMessage(structureResult, 'Market structure unavailable'),
      errorMessage(usdResult, 'USD correlation unavailable'),
      errorMessage(vixQuoteResult, 'VIX unavailable'),
      errorMessage(vvixQuoteResult, 'VVIX unavailable'),
      errorMessage(spyQuoteResult, 'SPY quote unavailable'),
      errorMessage(spyVolumeResult, 'SPY volume unavailable'),
    ].filter(Boolean);

    return {
      schemaVersion: 1,
      generatedAt: requestDate.toISOString(),
      status: allCore && unavailableFactorCount === 0 ? 'available' : anyCore ? 'partial' : 'unavailable',
      session: {
        state: sessionState,
        asOf: requestDate.toISOString(),
        date: cashSessionDate,
        openTime: newYorkLocalTimestamp(cashSessionDate, (9 * 60) + 30),
        closeTime: newYorkLocalTimestamp(cashSessionDate, 16 * 60),
        timezone: 'America/New_York',
      },
      spot,
      spySpot,
      chart,
      riskRange,
      factors,
      scoreInputs: {
        targetDate,
        riskRange: {
          lrr: riskRange.lrr,
          hrr: riskRange.hrr,
          trend: riskRange.trend,
          date: riskRange.date,
        },
        trade: {
          direction: trade.direction,
          raw: trade.raw,
          date: trade.date,
          source: trade.source,
        },
        usd: {
          date: usd.date,
          timestamp: usd.timestamp,
          source: usd.source,
          sourceStatus: usd.sourceStatus,
          r15: usd.r15,
          r30: usd.r30,
          r90: usd.r90,
        },
        vix: {
          value: vix.value,
          bucket: vix.bucket,
          date: vix.date,
          asOf: vix.asOf,
          source: vix.source,
          current: vix.current,
        },
        marketStructure: structure.input,
      },
      contracts,
      sourceRefreshPending: [...(includeContracts ? [contractsResult] : []), ...independent, ...researchResults]
        .some((result) => result?.status === 'pending'),
      errors,
    };
  }

  return { getSnapshot };
}

module.exports = {
  CFTC_MAX_AGE_MS,
  LIVE_BAR_MAX_AGE_MS,
  LIVE_QUOTE_MAX_AGE_MS,
  createSpxMonitorService,
  normalizeMarketStructure,
  normalizeSpyVolume,
  resolveVerifiedIbkrClose,
  resolveVerifiedIbkrSessionClose,
  resolveVerifiedIbkrQuote,
  selectCftcEminiRow,
};
