export const formatLastUpdated = (updatedAt) => {
  if (!updatedAt) {
    return {
      localeString: 'Unknown',
      relativeLabel: ''
    };
  }

  const updated =
    updatedAt instanceof Date ? updatedAt : new Date(updatedAt);

  if (Number.isNaN(updated.getTime())) {
    return {
      localeString: 'Invalid date',
      relativeLabel: ''
    };
  }

  const localeString = updated.toLocaleString();

  return {
    localeString,
    relativeLabel: ''
  };
};

/** Default poll intervals (ms) for status-dot freshness. */
export const SOURCE_POLL_INTERVALS = {
  multiRegionQuotes: 30000,
  volatilitySnapshot: 60000,
  currenciesQuotes: 30000,
  chartData: 30000,
  volumeData: 60000
};

/**
 * Returns 'current' | 'stale' | 'defective' based on age vs poll interval.
 * current: within warnMultiplier × interval
 * stale: between warnMultiplier and errorMultiplier × interval
 * defective: beyond errorMultiplier × interval or invalid timestamp
 */
export const getSourceFreshness = (
  updatedAt,
  pollIntervalMs,
  warnMultiplier = 5,
  errorMultiplier = 50
) => {
  if (!updatedAt) return 'defective';
  const date = updatedAt instanceof Date ? updatedAt : new Date(updatedAt);
  if (Number.isNaN(date.getTime())) return 'defective';
  const ageMs = Date.now() - date.getTime();
  const warnThreshold = pollIntervalMs * warnMultiplier;
  const errorThreshold = pollIntervalMs * errorMultiplier;
  if (ageMs <= warnThreshold) return 'current';
  if (ageMs <= errorThreshold) return 'stale';
  return 'defective';
};

export const getMinTimestamp = (timestamps) => {
  if (!Array.isArray(timestamps) || timestamps.length === 0) {
    return null;
  }

  let min = null;

  timestamps.forEach((ts) => {
    if (!ts) return;
    const date = ts instanceof Date ? ts : new Date(ts);
    if (Number.isNaN(date.getTime())) return;

    if (!min || date < min) {
      min = date;
    }
  });

  return min;
};

export const formatLastUpdatedForSources = (sources) => {
  if (!Array.isArray(sources) || sources.length === 0) {
    return {
      overallDate: null,
      overall: formatLastUpdated(null),
      perSource: []
    };
  }

  const dates = sources
    .map((s) => s?.updatedAt)
    .filter((ts) => ts);

  const overallDate = getMinTimestamp(dates);
  const overall = formatLastUpdated(overallDate);

  const perSource = sources.map((s) => {
    const { localeString } = formatLastUpdated(s?.updatedAt || null);
    return {
      id: s.id,
      label: s.label,
      localeString,
      status: s.status || 'current'
    };
  });

  return {
    overallDate,
    overall,
    perSource
  };
};


