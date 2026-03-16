// Pure helpers for the Volume card (Market Share Volume & Total Value Traded).
// Kept in utils so tests can run without loading the component or API layer.

/**
 * Given an array of daily volumes (newest first), compute prior-day volume
 * and % differences vs prior day and trailing averages.
 */
export function calculateVolumeMetrics(volumeHistory) {
  if (!Array.isArray(volumeHistory) || volumeHistory.length < 2) {
    return {
      priorDay: null,
      avg1M: null,
      avg3M: null,
      avg1Y: null,
      pctPriorDay: null,
      pct1M: null,
      pct3M: null,
      pct1Y: null
    };
  }

  const priorDayVol = volumeHistory[0];
  const slice1M = volumeHistory.slice(1, 22);
  const slice3M = volumeHistory.slice(1, 64);
  const slice1Y = volumeHistory.slice(1, 253);

  const avg = (arr) => {
    if (!arr.length) return 0;
    return arr.reduce((a, b) => a + b, 0) / arr.length;
  };

  const avg1M = avg(slice1M);
  const avg3M = avg(slice3M);
  const avg1Y = avg(slice1Y);

  const calcPctDiff = (current, baseline) => {
    if (!baseline || baseline === 0) return 0;
    return ((current - baseline) / baseline) * 100;
  };

  const yesterday = volumeHistory[1];

  return {
    priorDay: priorDayVol,
    avg1M,
    avg3M,
    avg1Y,
    pctPriorDay: yesterday ? calcPctDiff(priorDayVol, yesterday) : null,
    pct1M: calcPctDiff(priorDayVol, avg1M),
    pct3M: calcPctDiff(priorDayVol, avg3M),
    pct1Y: calcPctDiff(priorDayVol, avg1Y)
  };
}

/**
 * Returns formatted header date (e.g. "3/9") for the Volume card from API response.
 * Uses asOf (last closed trading day) or first date in totalMarket/totalExchange.
 */
export function getVolumeCardHeaderDate(response) {
  const asOfDate =
    response?.asOf ||
    (response?.totalMarket?.[0]?.date ?? response?.totalExchange?.[0]?.date);
  if (!asOfDate) return '';
  // Parse YYYY-MM-DD as calendar date to avoid timezone shifting (e.g. 2026-03-09 -> 3/9)
  const parts = String(asOfDate).split('-');
  if (parts.length < 3) return '';
  const month = parseInt(parts[1], 10);
  const day = parseInt(parts[2], 10);
  if (Number.isNaN(month) || Number.isNaN(day)) return '';
  return `${month}/${day}`;
}
