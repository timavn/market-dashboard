const { expectedRiskRangePublication } = require('../../utils/riskRangePublication.cjs');

const SOURCE = 'hedgeye_bitcoin_trend_tracker';
const REJECTED = /mock|seed|fixture|synthetic|inferred|portfolio|cost.basis|cache|stale|offline|disconnected|fallback|unavailable|error|failed/i;

function finite(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function timestamp(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function trusted(value) {
  if (!value || typeof value !== 'object') return false;
  return !['mock', 'isMock', 'seeded', 'seed', 'fixture', 'synthetic', 'inferred', 'cacheOnly', 'cachedOnly', 'cached', 'fromCache', 'stale', 'isStale', 'offline', 'disconnected', 'refreshFailed']
    .some((key) => value[key] === true)
    && value.connected !== false
    && value.available !== false
    && !value.error
    && !REJECTED.test([value.source, value.warning, value.provenance, value.status, value.availability, value.cacheState].filter(Boolean).join(' '));
}

function trackerPublicationDates(now = new Date()) {
  const expectation = expectedRiskRangePublication(now, {
    deadlineHour: Number(process.env.RISK_RANGE_DEADLINE_HOUR_ET || 8),
    deadlineMinute: Number(process.env.RISK_RANGE_DEADLINE_MINUTE_ET || 15),
  });
  return [...new Set([expectation.pendingDate, expectation.expectedDate].filter(Boolean))];
}

function cryptoTrackerRiskRangeHistory(snapshots, { ticker, dates = [], nowMs = Date.now() } = {}) {
  const dateKeys = [...new Set(dates.filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(String(date))))].sort();
  const rows = (Array.isArray(snapshots) ? snapshots : [])
    .filter((row) => row?.snapshotType === 'bitcoin-trend-tracker' && dateKeys.includes(row.date))
    .sort((left, right) => Date.parse(right.scrapedAt || right.publishedAt || '') - Date.parse(left.scrapedAt || left.publishedAt || ''));
  const ranges = {};
  for (const date of dateKeys) {
    const snapshot = rows.find((row) => row.date === date);
    const slot = snapshot?.data?.cryptos?.[ticker];
    if (!trusted(snapshot) || !trusted(snapshot.data) || !trusted(slot)) continue;
    if (slot.trackerRange && !trusted(slot.trackerRange)) continue;
    if (snapshot.meta && !trusted(snapshot.meta)) continue;
    const asOf = timestamp(snapshot.scrapedAt || snapshot.publishedAt || slot.timestamp);
    if (!asOf || Date.parse(asOf) > nowMs + 5_000) continue;
    // The tracker parser defines Buy/Sell Trade as its lower/upper range.
    // Its separately published price is not a verified previous session close.
    const lrr = finite(slot.lrr ?? slot.trackerRange?.lrr ?? slot.buyTrade);
    const hrr = finite(slot.hrr ?? slot.trackerRange?.hrr ?? slot.sellTrade);
    if (lrr === null || hrr === null || lrr <= 0 || lrr >= hrr) continue;
    ranges[date] = {
      ticker, date, lrr, hrr, previousClose: null,
      trend: slot.trend || slot.trade || null,
      source: SOURCE, asOf, timestamp: asOf,
      sourceType: snapshot.snapshotType,
      sourceDate: snapshot.date,
      sourcePublishedAt: timestamp(snapshot.publishedAt),
      sourceMessageId: snapshot.sourceMessageId || null,
      sourceProvider: snapshot.source || null,
    };
  }
  const missingDates = dateKeys.filter((date) => !ranges[date]);
  return {
    status: dateKeys.length && missingDates.length === 0 ? 'available' : 'unavailable',
    source: SOURCE, ticker, ranges, missingDates,
    reason: missingDates.length ? `Verified ${ticker} tracker Risk Range is unavailable for ${missingDates.join(', ')}.` : null,
  };
}

function cryptoTrackerRiskRangeEnvelope(snapshots, { ticker, now = new Date() } = {}) {
  const dates = trackerPublicationDates(now);
  const history = cryptoTrackerRiskRangeHistory(snapshots, { ticker, dates, nowMs: now.getTime() });
  const publicationDate = dates.find((date) => history.ranges[date]) || dates.at(-1);
  const range = history.ranges[publicationDate];
  return {
    available: Boolean(range),
    status: range ? 'current' : 'unavailable',
    ranges: range ? { [ticker]: range } : {},
    manifest: { publicationDate, expectedDate: publicationDate, latestUpdatedAt: range?.asOf || null },
    source: SOURCE,
  };
}

module.exports = { cryptoTrackerRiskRangeEnvelope, cryptoTrackerRiskRangeHistory, trackerPublicationDates };
