const {
  flattenSnapshotForecasts,
  normalizeCpiMonthId,
} = require('../../utils/cpiNowcastHistory.cjs');

function nowMillis(value) {
  const millis = value instanceof Date
    ? value.getTime()
    : typeof value === 'string'
      ? Date.parse(value)
      : Number(value ?? Date.now());
  return Number.isFinite(millis) ? millis : Date.now();
}

function isHeadlineCpiYoy(candidate = {}) {
  const sourceMetric = candidate.snapshot?.data?.metric || candidate.snapshot?.metric;
  if (!sourceMetric) return false;
  return /\bYOY\b|\bY\/Y\b|YEAR[\s-]*OVER[\s-]*YEAR/i.test(
    String(sourceMetric),
  );
}

function isUserConfirmed(candidate = {}) {
  return candidate.selected === true
    || /^user[_-]confirmed/i.test(String(candidate.selectionBasis || ''))
    || /^user[_-]confirmed/i.test(String(candidate.source?.kind || ''));
}

function candidatePublishedAt(candidate = {}) {
  const value = Date.parse(candidate.publishedAt || '');
  return Number.isFinite(value) ? value : null;
}

function candidateReleaseAt(candidate = {}) {
  const value = Date.parse(candidate.releaseAt || '');
  return Number.isFinite(value) ? value : null;
}

function isEligibleForecast(candidate, now) {
  const releaseAt = candidateReleaseAt(candidate);
  const publishedAt = candidatePublishedAt(candidate);
  if (!Number.isFinite(releaseAt)) return false;
  if (isUserConfirmed(candidate)) {
    return !Number.isFinite(publishedAt) || publishedAt <= now;
  }
  return Number.isFinite(publishedAt) && publishedAt < releaseAt && publishedAt <= now;
}

function compareCandidates(left, right) {
  const leftRelease = candidateReleaseAt(left) || Number.POSITIVE_INFINITY;
  const rightRelease = candidateReleaseAt(right) || Number.POSITIVE_INFINITY;
  if (leftRelease !== rightRelease) return leftRelease - rightRelease;
  const leftPublished = candidatePublishedAt(left) || 0;
  const rightPublished = candidatePublishedAt(right) || 0;
  if (leftPublished !== rightPublished) return rightPublished - leftPublished;
  const leftPriority = Number(left?.source?.priority || 0);
  const rightPriority = Number(right?.source?.priority || 0);
  return rightPriority - leftPriority;
}

function flattenCpiNowcastCandidates(snapshots = []) {
  const list = Array.isArray(snapshots) ? snapshots : [snapshots];
  return list.flatMap((snapshot) => flattenSnapshotForecasts(snapshot)
    .map((candidate) => ({ ...candidate, snapshot })));
}

function selectCpiForecast(snapshots, {
  now = Date.now(),
  requiredMonth = null,
  current = false,
} = {}) {
  const nowValue = nowMillis(now);
  const normalizedRequiredMonth = normalizeCpiMonthId(requiredMonth);
  const candidates = flattenCpiNowcastCandidates(snapshots)
    .filter((candidate) => isHeadlineCpiYoy(candidate))
    .filter((candidate) => !normalizedRequiredMonth || candidate.monthId === normalizedRequiredMonth)
    .filter((candidate) => isEligibleForecast(candidate, nowValue));

  const future = current
    ? candidates.filter((candidate) => (candidateReleaseAt(candidate) || 0) > nowValue)
    : candidates;
  return future.sort(compareCandidates)[0] || null;
}

function cpiSignalDetailsFromForecast(candidate = {}) {
  const scenarios = candidate.scenarios || {};
  return {
    forecastMonth: candidate.forecastMonth || null,
    metric: candidate.metric || null,
    outlook: null,
    releaseDate: candidate.releaseAt ? String(candidate.releaseAt).slice(0, 10) : null,
    releaseAt: candidate.releaseAt || null,
    scenarios: [
      { key: 'upside', label: 'Upside', value: scenarios.upper },
      { key: 'base', label: 'Base Case', value: scenarios.base },
      { key: 'downside', label: 'Downside', value: scenarios.lower },
    ].filter((scenario) => Number.isFinite(Number(scenario.value))),
  };
}

module.exports = {
  cpiSignalDetailsFromForecast,
  flattenCpiNowcastCandidates,
  isEligibleForecast,
  isHeadlineCpiYoy,
  selectCpiForecast,
};
