const VOLATILITY_NUMERIC_FIELDS = Object.freeze([
  'lastPx',
  'day1Ago',
  'day15Ago',
  'week1Ago',
  'week4Ago',
  'month3Ago',
  'month6Ago',
  'priorYearClose',
  'dayChangePct',
  'fifteenDayChangePct',
  'weekChangePct',
  'monthChangePct',
  'threeMonthChangePct',
  'sixMonthChangePct',
  'ytdChangePct',
]);

const timestampMs = (value) => {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : null;
};

export const isCurrentVolatilityRow = (row) => (
  row?.availability === 'available' && row?.freshness === 'current'
);

export const isHistoricalVolatilityRow = (seriesName, row) => (
  seriesName === 'MOVE'
  && row?.availability === 'historical'
  && row?.freshness === 'historical'
  && row?.quoteMode === 'end-of-day'
);

export const isRefreshDelayedVolatilityRow = (row, nowMs = Date.now()) => {
  if (
    row?.availability !== 'reference'
    || row?.freshness !== 'refresh-delayed'
    || row?.refreshDelayed !== true
  ) return false;

  const verifiedAtMs = timestampMs(row.lastVerifiedAt);
  const retainedUntilMs = timestampMs(row.retainedUntil);
  return Number.isFinite(verifiedAtMs)
    && Number.isFinite(retainedUntilMs)
    && nowMs - verifiedAtMs >= -5000
    && nowMs <= retainedUntilMs;
};

export const isDisplayableVolatilityRow = (seriesName, row, nowMs = Date.now()) => (
  isCurrentVolatilityRow(row)
  || isHistoricalVolatilityRow(seriesName, row)
  || isRefreshDelayedVolatilityRow(row, nowMs)
);

export function sanitizeExpiredVolatilityReferences(snapshot, nowMs = Date.now()) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  let changed = false;
  const next = { ...snapshot };

  Object.entries(snapshot).forEach(([name, row]) => {
    const looksRetained = row?.availability === 'reference'
      || row?.freshness === 'refresh-delayed'
      || row?.refreshDelayed === true;
    if (!looksRetained || isRefreshDelayedVolatilityRow(row, nowMs)) return;
    changed = true;
    next[name] = {
      ...row,
      ...Object.fromEntries(VOLATILITY_NUMERIC_FIELDS.map((field) => [field, null])),
      availability: 'unavailable',
      freshness: 'stale',
      refreshDelayed: false,
      error: 'reference_expired',
    };
  });

  return changed ? next : snapshot;
}

