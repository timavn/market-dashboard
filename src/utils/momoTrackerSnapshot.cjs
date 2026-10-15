'use strict';

const finite = (value) => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
const MOMO_TRACKER_LEGACY_ROW_COUNT = 9;
const MOMO_TRACKER_MIN_ROW_COUNT = 8;
const MOMO_TRACKER_MAX_ROW_COUNT = 25;
const MOMO_TRACKER_TRENDS = new Set(['BULLISH', 'BEARISH', 'NEUTRAL']);
const MOMO_TRACKER_TICKER_ORDER = new Map([
  'MSFT', 'AAPL', 'AMZN', 'META', 'GOOGL', 'NFLX', 'TSLA', 'NVDA', 'SNDK', 'ORCL',
].map((ticker, index) => [ticker, index]));

const unavailableMomoTrackerSnapshot = (reason) => ({
  status: 'unavailable',
  rows: [],
  publicationDate: null,
  publishedAt: null,
  reason,
});

const newYorkDateKey = (nowMs = Date.now()) => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(nowMs));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return values.year && values.month && values.day
    ? `${values.year}-${values.month}-${values.day}`
    : null;
};

const unavailableMomoValue = (value) => value === null || value === undefined || value === '';

function unverifiedSnapshotData(value) {
  if (!value || typeof value !== 'object') return false;
  const flags = ['mock', 'isMock', 'seed', 'seeded', 'isSeed', 'stale', 'isStale', 'cacheOnly', 'isCacheOnly',
    'fromCache', 'refreshFailed', 'offline', 'disconnected', 'synthetic', 'fallback', 'isFallback',
    'modelOnly', 'portfolioDerived', 'inferred', 'costBasisDerived'];
  if (flags.some(key => value[key] === true) || value.connected === false || value.available === false
    || /^(unavailable|error|offline|disconnected|stale|mock|seeded|cache-only)$/i.test(String(value.status || ''))) return true;
  return Object.values(value).some(child => child && typeof child === 'object' && unverifiedSnapshotData(child));
}

function normalizeMomoTrackerSnapshot(payload = {}, nowMs = Date.now()) {
  const evidence = [
    payload?.warning,
    payload?.error,
    payload?.reason,
    payload?.freshness,
    payload?.cacheState,
    payload?.fromCache ? 'cache' : null,
    payload?.cacheOnly ? 'cache-only' : null,
    payload?.stale ? 'stale' : null,
    payload?.mock ? 'mock' : null,
    payload?.seeded ? 'seed' : null,
    payload?.fallback ? 'fallback' : null,
    payload?.offline ? 'offline' : null,
    payload?.disconnected ? 'disconnected' : null,
    payload?.refreshFailed ? 'refresh-failed' : null,
  ].filter(Boolean).join(' ');
  const publicationDate = String(payload?.date || '');
  const currentDate = newYorkDateKey(nowMs);
  const data = payload?.data && typeof payload.data === 'object' && !Array.isArray(payload.data)
    ? payload.data
    : {};
  const rows = Object.entries(data).map(([ticker, rawRow], sourceIndex) => {
    const row = rawRow && typeof rawRow === 'object' ? rawRow : {};
    const normalizedTicker = String(ticker || '').trim().toUpperCase();
    const rangeStatus = String(row.rangeStatus || '').trim().toLowerCase();
    return {
      ticker: normalizedTicker,
      buyTrade: finite(row.buyTrade) ? Number(row.buyTrade) : null,
      sellTrade: finite(row.sellTrade) ? Number(row.sellTrade) : null,
      upside: finite(row.upside) ? Number(row.upside) : null,
      downside: finite(row.downside) ? Number(row.downside) : null,
      trend: String(row.trend || '').trim().toUpperCase(),
      rangeStatus,
      rangeStatusDate: row.rangeStatusDate == null ? null : String(row.rangeStatusDate).trim(),
      index: finite(row.index) ? Number(row.index) : null,
      displayIndex: finite(row.index)
        ? Number(row.index)
        : MOMO_TRACKER_TICKER_ORDER.get(normalizedTicker) ?? (MOMO_TRACKER_TICKER_ORDER.size + sourceIndex),
      sourceIndex,
      rawRow: row,
    };
  });
  const hasDeclaredStockCount = payload?.meta?.stockCount !== null
    && payload?.meta?.stockCount !== undefined
    && payload?.meta?.stockCount !== '';
  const declaredStockCount = hasDeclaredStockCount && Number.isInteger(Number(payload.meta.stockCount))
    ? Number(payload.meta.stockCount)
    : null;
  const validDeclaredStockCount = !hasDeclaredStockCount || (
    declaredStockCount >= MOMO_TRACKER_MIN_ROW_COUNT
    && declaredStockCount <= MOMO_TRACKER_MAX_ROW_COUNT
  );
  const expectedStockCount = hasDeclaredStockCount
    ? declaredStockCount
    : MOMO_TRACKER_LEGACY_ROW_COUNT;
  const validRows = validDeclaredStockCount
    && rows.length === expectedStockCount
    && rows.every((row) => {
      const availableRange = row.rangeStatus === 'available'
        && finite(row.buyTrade)
        && finite(row.sellTrade)
        && finite(row.upside)
        && finite(row.downside)
        && row.buyTrade > 0
        && row.sellTrade > row.buyTrade;
      const outbucketRange = row.rangeStatus === 'outbucket'
        && unavailableMomoValue(row.rawRow.buyTrade)
        && unavailableMomoValue(row.rawRow.sellTrade)
        && unavailableMomoValue(row.rawRow.upside)
        && unavailableMomoValue(row.rawRow.downside)
        && (!row.rangeStatusDate || /^\d{2}\/\d{2}$/.test(row.rangeStatusDate));
      return /^[A-Z][A-Z0-9.]{0,9}$/.test(row.ticker)
        && (row.index === null || (
          Number.isInteger(row.index)
          && row.index >= 0
          && row.index < expectedStockCount
        ))
        && MOMO_TRACKER_TRENDS.has(row.trend)
        && (availableRange || outbucketRange);
    })
    && new Set(rows.map((row) => row.ticker)).size === rows.length
    && new Set(rows.filter((row) => row.index !== null).map((row) => row.index)).size
      === rows.filter((row) => row.index !== null).length;
  const verified = payload?.snapshotType === 'momo-tracker'
    && (!payload?.reportType || payload.reportType === 'momo-tracker')
    && /^\d{4}-\d{2}-\d{2}$/.test(publicationDate)
    && publicationDate === currentDate
    && payload?.contentComplete !== false
    && payload?.decisionEligible !== false
    && payload?.refreshFailed !== true
    && !unverifiedSnapshotData(payload)
    && validRows
    && !/(?:stale|cache|mock|seed|fallback|offline|disconnected|synthetic|inferred|derived)/i.test(evidence);

  if (!verified) {
    const datedReason = publicationDate && publicationDate !== currentDate
      ? `Today's Hedgeye MOMO Tracker is not published yet. Latest publication: ${publicationDate}.`
      : null;
    return unavailableMomoTrackerSnapshot(
      payload?.reason || datedReason || "Today's complete Hedgeye MOMO Tracker table is unavailable.",
    );
  }

  return {
    status: 'available',
    rows: rows
      .sort((left, right) => left.displayIndex - right.displayIndex || left.sourceIndex - right.sourceIndex)
      .map(({ displayIndex, sourceIndex, rawRow, ...row }) => row),
    publicationDate,
    publishedAt: payload.publishedAt || payload.scrapedAt || payload.retrievedAt || null,
    reason: null,
  };
}


module.exports = { normalizeMomoTrackerSnapshot, newYorkDateKey };
