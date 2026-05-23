import { getTradingDaysCount, isTradingDay } from './marketHolidays';

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

export const formatDateOnly = (updatedAt) => {
  if (!updatedAt) return 'Unknown';

  const updated =
    updatedAt instanceof Date ? updatedAt : new Date(updatedAt);

  if (Number.isNaN(updated.getTime())) {
    return 'Invalid date';
  }

  return updated.toLocaleDateString();
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

const normalizeDate = (dateLike) => {
  let date;
  if (dateLike instanceof Date) {
    date = new Date(dateLike);
  } else if (typeof dateLike === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateLike)) {
    const [yearText, monthText, dayText] = dateLike.split('-');
    date = new Date(Number(yearText), Number(monthText) - 1, Number(dayText));
  } else {
    date = new Date(dateLike);
  }
  date.setHours(0, 0, 0, 0);
  return date;
};

export const getMostRecentTradingDay = (referenceDate = new Date()) => {
  const current = normalizeDate(referenceDate);

  while (!isTradingDay(current)) {
    current.setDate(current.getDate() - 1);
  }

  return current;
};

export const getMarketDayFreshness = (updatedAt, referenceDate = new Date()) => {
  if (!updatedAt) return 'defective';

  const updatedDate = normalizeDate(updatedAt);
  if (Number.isNaN(updatedDate.getTime())) return 'defective';

  const expectedTradingDay = getMostRecentTradingDay(referenceDate);
  if (updatedDate >= expectedTradingDay) {
    return 'current';
  }

  const latenessInTradingDays = Math.max(
    getTradingDaysCount(updatedDate, expectedTradingDay) - 1,
    0
  );

  if (latenessInTradingDays === 0) return 'current';
  if (latenessInTradingDays <= 2) return 'stale';
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
      localeString: s.detail ?? localeString,
      status: s.status || 'current',
      action: s.action ?? null,
    };
  });

  return {
    overallDate,
    overall,
    perSource
  };
};
