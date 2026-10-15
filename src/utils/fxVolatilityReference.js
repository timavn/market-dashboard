// FX volatility is a dated overview reading. A failed optional refresh must
// not remove an independently verified observation from the volatility table.
const HISTORY_FIELDS = [
  'lastPx', 'day1Ago', 'day15Ago', 'week4Ago', 'month3Ago', 'month6Ago',
  'dayChangePct', 'fifteenDayChangePct', 'monthChangePct',
  'threeMonthChangePct', 'sixMonthChangePct', 'week1Ago', 'weekChangePct',
  'priorYearClose', 'ytdChangePct',
];

const forbiddenEvidence = /mock|seed|synthetic|inferred|portfolio|cost.basis|cache|stale|offline|disconnected/i;
const finiteNumber = (value) => value !== '' && value != null && Number.isFinite(Number(value));
const observedAtMs = (row) => Date.parse(String(row?.asOf || ''));
export const isAttributedFxVolatility = (row) => /^(?:cme|yahoo)(?:\b|[-_])/i.test(String(row?.source || '').trim());

const hasVerifiedFxObservation = (row, nowMs = Date.now()) => {
  const evidence = [row?.source, row?.provider, row?.providerStatus, row?.sourceStatus,
    row?.dataType, row?.error, row?.warning, row?.meta?.source, row?.meta?.providerStatus]
    .filter(Boolean).join(' ');
  return Boolean(row
    && isAttributedFxVolatility(row)
    && !forbiddenEvidence.test(evidence)
    && !['mock', 'isMock', 'seeded', 'synthetic', 'inferred', 'cacheOnly', 'fromCache',
      'stale', 'isStale', 'providerOffline', 'disconnected'].some((key) => row[key] === true || row.meta?.[key] === true)
    && row.connected !== false
    && row._cache?.hit !== true && row._cache?.stale !== true
    && ![row.providerStatus, row.sourceStatus].some((value) => (
      ['error', 'unavailable', 'failed'].includes(String(value || '').toLowerCase())
    ))
    && Number.isFinite(observedAtMs(row)) && observedAtMs(row) <= nowMs + 5 * 60_000
    && finiteNumber(row.lastPx) && Number(row.lastPx) > 0);
};

export const isCurrentFxVolatility = (row, nowMs) => (
  row?.availability === 'available' && row?.freshness === 'current'
  && ['live', 'real-time', 'realtime', 'delayed'].includes(String(row?.quoteMode || '').toLowerCase())
  && hasVerifiedFxObservation(row, nowMs)
);

export const isHistoricalFxVolatility = (row, nowMs) => (
  row?.availability === 'historical' && row?.freshness === 'historical'
  && row?.quoteMode === 'end-of-day' && hasVerifiedFxObservation(row, nowMs)
);

export const isRetainedFxVolatility = (row, nowMs) => (
  row?.availability === 'reference' && row?.freshness === 'refresh-delayed'
  && row?.refreshDelayed === true && row?.displayOnly === true && row?.executable === false
  && row?.lastVerifiedAt === row?.asOf && hasVerifiedFxObservation(row, nowMs)
);

export const isDisplayableFxVolatility = (row, nowMs) => (
  isCurrentFxVolatility(row, nowMs) || isHistoricalFxVolatility(row, nowMs)
  || isRetainedFxVolatility(row, nowMs)
);

export const retainFxVolatility = (row, nowMs) => {
  if (!isDisplayableFxVolatility(row, nowMs)) return null;
  if (isRetainedFxVolatility(row, nowMs)) return row;
  return {
    ...row,
    availability: 'reference',
    freshness: 'refresh-delayed',
    quoteMode: 'last-verified-reference',
    refreshDelayed: true,
    displayDelayed: true,
    displayOnly: true,
    executable: false,
    directNative: false,
    lastVerifiedAt: row.asOf,
  };
};

export const reconcileFxVolatility = (previous, incoming, nowMs = Date.now()) => {
  const previousValid = isDisplayableFxVolatility(previous, nowMs);
  const incomingValid = isDisplayableFxVolatility(incoming, nowMs);
  if (incomingValid && (!previousValid || observedAtMs(incoming) >= observedAtMs(previous))) {
    // Missing history from the same exact observation can be restored without
    // attaching a return calculated for a different level, provider or date.
    const sameObservation = previousValid
      && observedAtMs(incoming) === observedAtMs(previous)
      && Number(incoming.lastPx) === Number(previous.lastPx)
      && String(incoming.source).toLowerCase() === String(previous.source).toLowerCase();
    if (!sameObservation) return incoming;
    const omittedHistory = Object.fromEntries(HISTORY_FIELDS
      .filter((key) => !finiteNumber(incoming[key]) && finiteNumber(previous[key]))
      .map((key) => [key, previous[key]]));
    return Object.keys(omittedHistory).length ? { ...incoming, ...omittedHistory } : incoming;
  }
  return previousValid ? retainFxVolatility(previous, nowMs) : null;
};
