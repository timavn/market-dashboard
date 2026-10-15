import VOLATILITY_FRESHNESS from '../constants/volatilityFreshness.json';

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

const CBOE_SERIES = new Set(['VIX', 'VVIX', 'RVX', 'NazVol', 'VXEEM', 'GVZ', 'OVX', 'BITVX']);
const REJECTED_SOURCE = /(?:^|[\s_-])(mock|seed(?:ed)?|fixture|cache(?:d)?|offline|disconnected|stale|expired|synthetic|inferred|fallback|portfolio|derived)(?:$|[\s_-])/i;
const REJECTED_FLAGS = ['mock', 'isMock', 'seed', 'seeded', 'isSeed', 'isSeeded',
  'synthetic', 'inferred', 'cacheOnly', 'fromCache', 'stale', 'isStale', 'offline', 'disconnected'];
const hasRejectedEvidence = (value) => Boolean(value && (
  [value, value.meta].filter(Boolean).some((metadata) => (
    REJECTED_FLAGS.some((key) => metadata[key] === true)
    || metadata.connected === false
    || REJECTED_SOURCE.test([metadata.source, metadata.status, metadata.freshness,
      metadata.providerStatus, metadata.sourceStatus, metadata.cacheStatus, metadata.dataType].filter(Boolean).join(' '))
    || [metadata.providerStatus, metadata.status, metadata.sourceStatus]
      .some((status) => ['error', 'unavailable', 'failed'].includes(String(status || '').toLowerCase()))
  ))
  || value._cache?.hit === true || value._cache?.stale === true
  || ['cache', 'cached', 'hit', 'stale'].includes(String(value._cache?.status || value.meta?.cacheStatus || '').toLowerCase())
));

const isVerifiedObservation = (row) => (
  typeof row?.source === 'string'
  && Boolean(row.source.trim())
  && !hasRejectedEvidence(row)
  && row.lastPx != null
  && Number.isFinite(Number(row.lastPx))
  && Number(row.lastPx) > 0
  && Number.isFinite(timestampMs(row.asOf))
);

export const isCurrentVolatilityRow = (row) => (
  row?.availability === 'available' && row?.freshness === 'current'
  && isVerifiedObservation(row)
);

export const isHistoricalVolatilityRow = (seriesName, row) => (
  seriesName === 'MOVE'
  && row?.availability === 'historical'
  && row?.freshness === 'historical'
  && row?.quoteMode === 'end-of-day'
  && isVerifiedObservation(row)
);

export const isRefreshDelayedVolatilityRow = (row, nowMs = Date.now()) => {
  if (
    row?.availability !== 'reference'
    || row?.freshness !== 'refresh-delayed'
    || row?.refreshDelayed !== true
    || !isVerifiedObservation(row)
  ) return false;

  const verifiedAtMs = timestampMs(row.lastVerifiedAt);
  return Number.isFinite(verifiedAtMs)
    && nowMs - verifiedAtMs >= -5 * 60 * 1000
    && timestampMs(row.asOf) <= nowMs + 5 * 60 * 1000;
};

// Overview references keep the observation's evidence, never a renewed clock.
// Expiry changes its display state; it does not destroy a verified observation.
export const retainVolatilityRow = (name, row, nowMs = Date.now()) => {
  if (!isDisplayableVolatilityRow(name, row, nowMs)
    || timestampMs(row.asOf) > nowMs + 5 * 60 * 1000) return null;
  return {
    ...row,
    availability: 'reference',
    freshness: 'refresh-delayed',
    refreshDelayed: true,
    displayDelayed: true,
    displayOnly: true,
    executable: false,
    lastVerifiedAt: row.lastVerifiedAt || row.asOf,
  };
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
      error: 'reference_unverified',
    };
  });

  return changed ? next : snapshot;
}

// A valid row from one provider must neither rescue rejected quotes from
// another provider nor disappear because another provider has failed.
export function sanitizeVolatilitySnapshot(snapshot, nowMs = Date.now()) {
  // A dated reference is not permission to ingest an unverified cached payload.
  // Reject the failed envelope; the resource keeps its prior verified snapshot.
  if (hasRejectedEvidence(snapshot)) return null;
  const sanitized = sanitizeExpiredVolatilityReferences(snapshot, nowMs);
  if (!sanitized) return null;
  let changed = false;
  const next = { ...sanitized };
  Object.entries(sanitized).forEach(([name, row]) => {
    if (!CBOE_SERIES.has(name) && name !== 'MOVE') return;
    const current = isCurrentVolatilityRow(row);
    const historical = isHistoricalVolatilityRow(name, row);
    const reference = isRefreshDelayedVolatilityRow(row, nowMs);
    const ageMs = nowMs - timestampMs(row?.asOf);
    const expired = current && (
      ageMs < -5 * 60 * 1000
      || (snapshot.marketSession !== 'closed' && ageMs > Number(VOLATILITY_FRESHNESS.maxAgeMs))
    );
    if ((current && !expired) || historical || reference) return;
    if (current && expired && ageMs >= 0) {
      changed = true;
      next[name] = retainVolatilityRow(name, row, nowMs);
      return;
    }
    if (row?.availability === 'unavailable' && VOLATILITY_NUMERIC_FIELDS.every((field) => row[field] == null)) return;
    changed = true;
    next[name] = {
      ...row,
      ...Object.fromEntries(VOLATILITY_NUMERIC_FIELDS.map((field) => [field, null])),
      availability: 'unavailable',
      freshness: expired ? 'stale' : 'unavailable',
      refreshDelayed: false,
    };
  });
  return changed ? next : sanitized;
}

export function retainVolatilitySnapshot(snapshot, nowMs = Date.now()) {
  const sanitized = sanitizeVolatilitySnapshot(snapshot, nowMs);
  if (!sanitized) return null;
  const next = { ...sanitized };
  [...CBOE_SERIES, 'MOVE'].forEach((name) => {
    const retained = retainVolatilityRow(name, sanitized[name], nowMs);
    if (retained) next[name] = retained;
  });
  return next;
}

// A partial provider response may advance one series without erasing another.
export function reconcileVolatilitySnapshot({ currentData, incomingData, nowMs = Date.now() }) {
  const next = { ...sanitizeVolatilitySnapshot(incomingData, nowMs) };
  const previous = sanitizeVolatilitySnapshot(currentData, nowMs);
  [...CBOE_SERIES, 'MOVE'].forEach((name) => {
    const oldRow = previous?.[name];
    const newRow = next[name];
    if (!isDisplayableVolatilityRow(name, oldRow, nowMs)) return;
    if (!isDisplayableVolatilityRow(name, newRow, nowMs)
      || timestampMs(newRow.asOf) < timestampMs(oldRow.asOf)) {
      next[name] = retainVolatilityRow(name, oldRow, nowMs);
    } else if (newRow.asOf === oldRow.asOf && newRow.source === oldRow.source
      && Number(newRow.lastPx) === Number(oldRow.lastPx)) {
      // The same observation may arrive without all of its historical fields.
      next[name] = { ...newRow };
      VOLATILITY_NUMERIC_FIELDS.forEach((field) => {
        if (next[name][field] == null && oldRow[field] != null) next[name][field] = oldRow[field];
      });
    }
  });
  return next;
}
