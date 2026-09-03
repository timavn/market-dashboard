const FORBIDDEN_ATH_PROVENANCE = /(?:mock|seed|fixture|fallback|cache(?:d|[_ -]?only)?|delayed|frozen|stale|offline|disconnected|synthetic|inferred|derived)/i;
const VERIFIED_ATH_SOURCES = new Set([
  'ibkr_historical_record',
  'coinbase_exchange_historical_record',
]);

function finitePositive(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function dateKey(value) {
  const match = String(value || '').match(/^(\d{4}-\d{2}-\d{2})/);
  return match?.[1] || null;
}

function unsafeProvenance(value) {
  return FORBIDDEN_ATH_PROVENANCE.test([
    value?.warning,
    value?.error,
    value?.provenance,
    value?.cacheStatus,
    value?.cacheState,
    value?.sourceStatus,
    value?.fromCache ? 'cached' : null,
    value?.cached ? 'cached' : null,
    value?.cachedOnly ? 'cached-only' : null,
    value?.cacheOnly ? 'cache-only' : null,
    value?.cacheHit ? 'cache-hit' : null,
    value?.mock ? 'mock' : null,
    value?.seeded ? 'seed' : null,
    value?.fallback ? 'fallback' : null,
    value?.stale ? 'stale' : null,
  ].filter(Boolean).join(' '));
}

/**
 * ATH overlays are accepted only when backed by a complete, independently
 * verified historical record. This deliberately excludes rolling-window
 * maxima and cached/offline substitutes.
 */
function isVerifiedPredictionMarketAth(ath) {
  const source = String(ath?.source || '').toLowerCase();
  const expectedBaselineSource = source === 'ibkr_historical_record'
    ? 'ibkr'
    : source === 'coinbase_exchange_historical_record'
      ? 'coinbase_exchange'
      : null;
  const value = finitePositive(ath?.value);
  const recordDate = dateKey(ath?.date);
  const baseline = ath?.baseline;
  const baselineValue = finitePositive(baseline?.value);
  const baselineDate = dateKey(baseline?.date);
  const throughDate = dateKey(baseline?.throughDate);
  const coverageEnd = dateKey(baseline?.coverageEnd);
  const markers = Array.isArray(ath?.markers) ? ath.markers : [];
  const markersValid = markers.every((marker) => (
    finitePositive(marker?.value) != null
    && finitePositive(marker.value) <= value
    && dateKey(marker?.date)
  ));

  return Boolean(
    ath?.status === 'available'
    && VERIFIED_ATH_SOURCES.has(source)
    && expectedBaselineSource
    && value != null
    && recordDate
    && baselineValue != null
    && baselineValue <= value
    && baselineDate
    && throughDate
    && baselineDate <= throughDate
    && baseline?.source === expectedBaselineSource
    && String(baseline?.dataset || '') === 'historical_record'
    && baseline?.coverageComplete === true
    && (!coverageEnd || coverageEnd === throughDate)
    && markersValid
    && ath?.refreshFailed !== true
    && baseline?.refreshFailed !== true
    && !unsafeProvenance(ath)
    && !unsafeProvenance(baseline)
  );
}

function athRefreshPending(chart) {
  const ath = chart?.ath;
  const status = String(ath?.status || '').toLowerCase();
  return ['loading', 'refreshing', 'pending'].includes(status)
    || ath?.refreshPending === true
    || (!ath && (chart?.refreshing === true || chart?.refreshPending === true));
}

function chartAllowsAthRetention(chart) {
  if (!chart || chart?.refreshFailed === true || chart?.fromCache === true
    || chart?.cachedOnly === true || chart?.seeded === true || chart?.stale === true) return false;
  return !FORBIDDEN_ATH_PROVENANCE.test([
    chart?.source,
    chart?.warning,
    chart?.provenance,
    chart?.cacheState,
    chart?.errorCode,
    chart?.refreshIssue,
    chart?.reason,
  ].filter(Boolean).join(' '));
}

/**
 * Keep a verified historical ATH attached while only its next source request
 * is in flight. Confirmed failures and forbidden provenance still fail closed.
 */
function retainVerifiedAthWhilePending(previousChart, nextChart) {
  if (!nextChart || isVerifiedPredictionMarketAth(nextChart?.ath)) return nextChart;
  if (!athRefreshPending(nextChart)
    || !chartAllowsAthRetention(nextChart)
    || !isVerifiedPredictionMarketAth(previousChart?.ath)) return nextChart;
  return {
    ...nextChart,
    ath: {
      ...previousChart.ath,
      refreshPending: true,
      refreshRetained: true,
      refreshFailed: false,
      reason: null,
    },
  };
}

/**
 * All timeframe variants describe the same chart instrument, so one verified
 * record reference is canonical across 1D, 5D, and 10D. This also repairs a
 * partial payload in which a variant omitted the already-verified overlay.
 */
function synchronizeVerifiedAthAcrossChartRanges(chart) {
  if (!chart) return chart;
  const variants = chart?.variants || {};
  const candidates = [chart, ...Object.values(variants)]
    .filter((variant) => chartAllowsAthRetention(variant))
    .map((variant) => variant?.ath)
    .filter(isVerifiedPredictionMarketAth)
    .sort((left, right) => (
      Number(right.value) - Number(left.value)
      || String(right.asOf || '').localeCompare(String(left.asOf || ''))
    ));
  const canonical = candidates[0];
  if (!canonical) return chart;
  const synchronizeVariant = (variant) => {
    if (!variant || !chartAllowsAthRetention(variant)) return variant;
    const status = String(variant?.ath?.status || '').toLowerCase();
    const mayReceiveCanonical = !variant?.ath
      || isVerifiedPredictionMarketAth(variant.ath)
      || ['loading', 'refreshing', 'pending'].includes(status);
    return mayReceiveCanonical ? { ...variant, ath: canonical } : variant;
  };
  const synchronizedVariants = Object.fromEntries(Object.entries(variants).map(([range, variant]) => [
    range,
    synchronizeVariant(variant),
  ]));
  const synchronizedRoot = synchronizeVariant(chart);
  return {
    ...synchronizedRoot,
    ...(chart?.variants ? { variants: synchronizedVariants } : {}),
  };
}

module.exports = {
  isVerifiedPredictionMarketAth,
  retainVerifiedAthWhilePending,
  synchronizeVerifiedAthAcrossChartRanges,
};
