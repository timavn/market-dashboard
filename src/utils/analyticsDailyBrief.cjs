const MARKET_TIME_ZONE = 'America/New_York';
const newYorkFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: MARKET_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

const SOURCE_DEFINITIONS = [
  { id: 'real-time-alert', label: 'Real-Time Alerts', cadence: 'event_driven' },
  { id: 'risk-ranges', label: 'Risk Ranges', cadence: 'market_day_0800' },
  { id: 'market-structure', label: 'Market Structure', cadence: 'event_driven' },
  { id: 'portfolio-solutions', label: 'Portfolio Solutions', cadence: 'event_driven' },
  { id: 'etf-pro', label: 'ETF Pro', cadence: 'event_driven' },
  { id: 'early-look', label: 'Early Look', cadence: 'event_driven' },
  { id: 'bitcoin-trend-tracker', label: 'Bitcoin Tracker', cadence: 'event_driven' },
  { id: 'momo-tracker', label: 'MOMO Tracker', cadence: 'event_driven' },
  { id: 'signal-strength', label: 'Signal Strength', cadence: 'event_driven' },
  { id: 'the-macro-show', label: 'Macro Show', cadence: 'event_driven' },
  { id: 'the-call', label: 'The Call', cadence: 'event_driven' },
  { id: 'cftc-positioning', label: 'CFTC Positioning', cadence: 'weekly' },
];

const SOURCE_BY_ID = Object.fromEntries(SOURCE_DEFINITIONS.map((source) => [source.id, source]));
const ANALYTICS_SOURCE_IDS = new Set(SOURCE_DEFINITIONS.map((source) => source.id));
const RESERVED_TICKERS = new Set([
  'ADD', 'ADDED', 'BUY', 'CLOSE', 'CLOSED', 'COVER', 'COVERING', 'LONG', 'LONGS',
  'REMOVE', 'REMOVED', 'SELL', 'SHORT', 'SHORTING', 'SHORTS', 'SIGNAL', 'UPDATE',
]);

function asArray(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function nyParts(value = Date.now()) {
  const date = value instanceof Date ? value : new Date(value);
  const parts = newYorkFormatter.formatToParts(date);
  const map = parts.reduce((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {});
  return {
    date: `${map.year}-${map.month}-${map.day}`,
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
  };
}

function dateFromIso(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12));
}

function isoFromDate(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(date, days) {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function observedFixedHoliday(year, monthIndex, day) {
  const date = new Date(Date.UTC(year, monthIndex, day, 12));
  if (date.getUTCDay() === 6) return addDays(date, -1);
  if (date.getUTCDay() === 0) return addDays(date, 1);
  return date;
}

function nthWeekday(year, monthIndex, weekday, occurrence) {
  const first = new Date(Date.UTC(year, monthIndex, 1, 12));
  const offset = (weekday - first.getUTCDay() + 7) % 7;
  return new Date(Date.UTC(year, monthIndex, 1 + offset + (occurrence - 1) * 7, 12));
}

function lastWeekday(year, monthIndex, weekday) {
  const last = new Date(Date.UTC(year, monthIndex + 1, 0, 12));
  const offset = (last.getUTCDay() - weekday + 7) % 7;
  return addDays(last, -offset);
}

function easterSunday(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day, 12));
}

function marketHolidaysForYear(year) {
  return [
    observedFixedHoliday(year, 0, 1),
    nthWeekday(year, 0, 1, 3),
    nthWeekday(year, 1, 1, 3),
    addDays(easterSunday(year), -2),
    lastWeekday(year, 4, 1),
    observedFixedHoliday(year, 5, 19),
    observedFixedHoliday(year, 6, 4),
    nthWeekday(year, 8, 1, 1),
    nthWeekday(year, 10, 4, 4),
    observedFixedHoliday(year, 11, 25),
  ].map(isoFromDate);
}

function isMarketDay(date) {
  const weekday = date.getUTCDay();
  if (weekday === 0 || weekday === 6) return false;
  const iso = isoFromDate(date);
  const year = date.getUTCFullYear();
  const holidays = new Set([
    ...marketHolidaysForYear(year - 1),
    ...marketHolidaysForYear(year),
    ...marketHolidaysForYear(year + 1),
  ]);
  return !holidays.has(iso);
}

function previousMarketDay(date) {
  let cursor = addDays(date, -1);
  while (!isMarketDay(cursor)) cursor = addDays(cursor, -1);
  return cursor;
}

function latestExpectedRiskRangeDate(now) {
  const parts = nyParts(now);
  const current = dateFromIso(parts.date);
  if (!current) return parts.date;
  if (isMarketDay(current) && parts.hour >= 8) return parts.date;
  return isoFromDate(previousMarketDay(current));
}

function daysBetween(fromDate, toDate) {
  const from = dateFromIso(fromDate);
  const to = dateFromIso(toDate);
  if (!from || !to) return Number.POSITIVE_INFINITY;
  return Math.floor((to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000));
}

function extractTicker(value) {
  if (value == null) return '';
  const raw = typeof value === 'object'
    ? value.ticker || value.symbol || value.asset || ''
    : value;
  const text = String(raw || '').trim();
  if (/\.(png|jpe?g|gif|pdf)$/i.test(text)) return '';
  const parenthesized = text.match(/\(([A-Z0-9./-]{1,12})\)/i);
  const candidate = (parenthesized ? parenthesized[1] : text.split(/[\s,;:]+/)[0]).toUpperCase();
  if (!/^[A-Z][A-Z0-9./-]{0,11}$/.test(candidate)) return '';
  if (RESERVED_TICKERS.has(candidate)) return '';
  return candidate;
}

function qualityWarnings(diff) {
  const quality = diff?.dataQuality;
  const warnings = [
    ...asArray(diff?.warnings),
    ...asArray(quality?.warnings),
    ...asArray(quality?.errors),
  ].map((warning) => String(warning));
  const status = String(quality?.status || '').toLowerCase();
  if (status && !['ok', 'good', 'valid', 'verified', 'complete'].includes(status)) {
    warnings.unshift(`Data quality: ${status}`);
  }
  return [...new Set(warnings)];
}

function sourceHealth(source, diff, now) {
  const currentDate = diff?.currentDate || diff?.date || null;
  const warnings = qualityWarnings(diff);
  const base = {
    sourceId: source.id,
    label: source.label,
    cadence: source.cadence,
    snapshotId: currentDate,
    contentDate: currentDate,
    publishedAt: diff?.publishedAt || null,
    ingestedAt: diff?.scrapedAt || null,
    qualityWarnings: warnings,
  };

  if (diff?.error) return { ...base, status: 'error', reason: diff.error };
  if (!diff || diff.available === false || !currentDate) {
    return { ...base, status: 'missing', reason: 'No dated source snapshot is available.' };
  }
  if (warnings.length > 0) {
    return { ...base, status: 'quality_warning', reason: warnings[0] };
  }

  const marketDate = nyParts(now).date;
  if (source.cadence === 'market_day_0800') {
    const expectedDate = latestExpectedRiskRangeDate(now);
    if (currentDate >= expectedDate) {
      return { ...base, status: 'current', reason: `Current for the latest due market date (${expectedDate}).` };
    }
    return { ...base, status: 'late', reason: `Expected ${expectedDate}; latest is ${currentDate}.` };
  }

  if (source.cadence === 'weekly') {
    const ageDays = daysBetween(currentDate, marketDate);
    if (ageDays <= 10) return { ...base, status: 'current', reason: `Weekly publication as of ${currentDate}.` };
    return { ...base, status: 'late', reason: `Weekly source is ${ageDays} days old.` };
  }

  return { ...base, status: 'current', reason: `Latest successful publication: ${currentDate}.` };
}

function directionFromText(value) {
  const text = String(value || '').toUpperCase();
  if (/COVER(ING)?\s+SHORT|BUY|ADD(ED)?\s+TO\s+LONG/.test(text)) return 'bullish';
  if (/SHORTING|SELL|ADD(ED)?\s+TO\s+SHORT/.test(text)) return 'bearish';
  return null;
}

function makeEvent({ sourceId, ticker, kind, description, direction = null, diff, eventAt }) {
  const cleanTicker = extractTicker(ticker);
  const currentDate = diff?.currentDate || diff?.date || null;
  if (!cleanTicker || !currentDate) return null;
  const cleanDescription = String(description || '').trim();
  if (!cleanDescription || /\.(png|jpe?g|gif|pdf)\b/i.test(cleanDescription)) return null;
  const snapshotId = currentDate;
  return {
    id: [sourceId, snapshotId, cleanTicker, kind, cleanDescription].join(':'),
    snapshotId,
    ticker: cleanTicker,
    kind,
    direction,
    description: cleanDescription,
    sourceId,
    sourceLabel: SOURCE_BY_ID[sourceId]?.label || sourceId,
    contentDate: currentDate,
    eventAt: eventAt || diff?.eventTime || diff?.publishedAt || diff?.scrapedAt || currentDate,
  };
}

function mapRealTimeAlerts(changelog) {
  const diff = changelog?.['real-time-alert'];
  return asArray(diff?.alerts).map((alert) => {
    const text = alert?.signalPhrase || alert?.headline || alert?.actionLabel || alert?.action || 'Research action signal';
    return makeEvent({
      sourceId: 'real-time-alert',
      ticker: alert?.ticker || alert?.symbol,
      kind: 'action_signal',
      description: text,
      direction: directionFromText(text),
      diff,
      eventAt: alert?.eventTime || alert?.timestamp || alert?.sentAt || alert?.receivedAt,
    });
  }).filter(Boolean);
}

function mapRiskRanges(changelog) {
  const diff = changelog?.['risk-ranges'];
  if (!diff) return [];
  const trendEvents = asArray(diff.trendChanges).map((change) => {
    const oldTrend = String(change?.oldTrend || change?.oldValue || 'unknown').toUpperCase();
    const newTrend = String(change?.newTrend || change?.newValue || 'unknown').toUpperCase();
    const direction = newTrend === 'BULLISH' ? 'bullish' : newTrend === 'BEARISH' ? 'bearish' : 'neutral';
    return makeEvent({
      sourceId: 'risk-ranges',
      ticker: change?.ticker || change?.symbol,
      kind: 'trend_change',
      description: `${oldTrend} → ${newTrend}`,
      direction,
      diff,
      eventAt: change?.eventTime,
    });
  });
  const membership = [
    ...asArray(diff.added).map((ticker) => ({ ticker, kind: 'added', description: 'Added to Risk Ranges' })),
    ...asArray(diff.removed).map((ticker) => ({ ticker, kind: 'removed', description: 'Removed from Risk Ranges' })),
    ...asArray(diff.outbucketDiff?.added).map((ticker) => ({ ticker, kind: 'added', description: 'Added to OutBucket' })),
    ...asArray(diff.outbucketDiff?.removed).map((ticker) => ({ ticker, kind: 'removed', description: 'Removed from OutBucket' })),
  ].map((event) => makeEvent({ sourceId: 'risk-ranges', diff, ...event }));
  return [...trendEvents, ...membership].filter(Boolean);
}

function mapEtfPro(changelog) {
  const diff = changelog?.['etf-pro'];
  if (!diff || qualityWarnings(diff).length > 0) return [];
  const groups = [
    ['addedLongs', 'added_long', 'Added to ETF Pro long book', 'bullish'],
    ['addedShorts', 'added_short', 'Added to ETF Pro short book', 'bearish'],
    ['removedLongs', 'closed_long', 'Removed from ETF Pro long book', null],
    ['removedShorts', 'closed_short', 'Removed from ETF Pro short book', null],
  ];
  return groups.flatMap(([key, kind, description, direction]) => (
    asArray(diff[key]).map((ticker) => makeEvent({ sourceId: 'etf-pro', ticker, kind, description, direction, diff }))
  )).filter(Boolean);
}

function mapPortfolioSolutions(changelog) {
  const diff = changelog?.['portfolio-solutions'];
  if (!diff) return [];
  const membership = [
    ...asArray(diff.added).map((ticker) => makeEvent({ sourceId: 'portfolio-solutions', ticker, kind: 'added', description: 'Added to Portfolio Solutions', diff })),
    ...asArray(diff.removed).map((ticker) => makeEvent({ sourceId: 'portfolio-solutions', ticker, kind: 'removed', description: 'Removed from Portfolio Solutions', diff })),
  ];
  const rankMoves = asArray(diff.updates)
    .filter((update) => update?.field === 'rank' && Number.isFinite(Number(update.oldValue)) && Number.isFinite(Number(update.newValue)))
    .map((update) => ({ ...update, magnitude: Math.abs(Number(update.newValue) - Number(update.oldValue)) }))
    .filter((update) => update.magnitude >= 3)
    .sort((a, b) => b.magnitude - a.magnitude)
    .slice(0, 5)
    .map((update) => makeEvent({
      sourceId: 'portfolio-solutions',
      ticker: update.ticker,
      kind: 'rank_change',
      description: `Rank ${update.oldValue} → ${update.newValue}`,
      diff,
    }));
  return [...membership, ...rankMoves].filter(Boolean);
}

function buildRawEvents(changelog) {
  const events = [
    ...mapRealTimeAlerts(changelog),
    ...mapRiskRanges(changelog),
    ...mapEtfPro(changelog),
    ...mapPortfolioSolutions(changelog),
  ];
  return [...new Map(events.map((event) => [event.id, event])).values()];
}

function buildAnalyticsDailyBrief({ changelog, now = Date.now(), cacheState = 'miss' } = {}) {
  const safeChangelog = changelog && typeof changelog === 'object' ? changelog : {};
  const marketDate = nyParts(now).date;
  const sourceHealthRows = SOURCE_DEFINITIONS.map((source) => sourceHealth(source, safeChangelog[source.id], now));
  const healthBySource = Object.fromEntries(sourceHealthRows.map((row) => [row.sourceId, row]));
  const staleCache = cacheState === 'stale';
  const events = staleCache
    ? []
    : buildRawEvents(safeChangelog)
        .filter((event) => event.contentDate === marketDate)
        .filter((event) => healthBySource[event.sourceId]?.status === 'current')
        .sort((a, b) => String(b.eventAt || '').localeCompare(String(a.eventAt || '')));

  const issueStatuses = new Set(['late', 'missing', 'error', 'quality_warning']);
  const issues = sourceHealthRows.filter((row) => issueStatuses.has(row.status));
  if (staleCache) {
    issues.unshift({
      sourceId: 'analytics-cache',
      label: 'Analytics refresh',
      cadence: 'on_refresh',
      snapshotId: null,
      contentDate: null,
      publishedAt: null,
      ingestedAt: null,
      qualityWarnings: [],
      status: 'error',
      reason: 'The refresh failed and only a stale cached research response was available.',
    });
  }

  const unavailableCount = sourceHealthRows.filter((row) => issueStatuses.has(row.status)).length;
  const trustStatus = staleCache
    ? 'unavailable'
    : unavailableCount === 0
      ? 'trusted'
      : unavailableCount === sourceHealthRows.length
        ? 'unavailable'
        : 'degraded';

  return {
    marketDate,
    generatedAt: new Date(now).toISOString(),
    cacheState,
    trust: {
      status: trustStatus,
      reason: staleCache
        ? 'Current research could not be verified.'
        : unavailableCount > 0
          ? `${unavailableCount} source${unavailableCount === 1 ? '' : 's'} need attention.`
          : 'All configured research sources are usable.',
    },
    summary: {
      current: sourceHealthRows.filter((row) => row.status === 'current').length,
      notDue: sourceHealthRows.filter((row) => row.status === 'not_due').length,
      issues: issues.length,
      events: events.length,
    },
    events,
    issues,
    sourceHealth: sourceHealthRows,
  };
}

module.exports = {
  ANALYTICS_SOURCE_IDS,
  SOURCE_DEFINITIONS,
  buildAnalyticsDailyBrief,
  extractTicker,
  isMarketDay,
  latestExpectedRiskRangeDate,
};
