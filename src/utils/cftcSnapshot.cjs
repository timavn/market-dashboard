const OFFICIAL_CFTC_SOURCE = 'cftc-public-reporting-environment';
const CFTC_VERSION_PAIRS = Object.freeze({
  'cftc-positioning-v2': 'cftc-combined-net-sample-z-v1',
  'cftc-positioning-v3': 'cftc-combined-net-sample-z-v2',
});
const SERIES_DATASETS = Object.freeze({
  'legacy-noncommercial-combined': ['legacy', 'srt6-5q2f'],
  'disaggregated-managed-money-combined': ['disaggregated', 'rxbv-e226'],
});
const INVALID_PROVENANCE = /mock|seed|synthetic|inferred|derived|portfolio|fallback|cache|offline|disconnected|failed|error|unverified/i;
const NONCURRENT_PROVENANCE = /stale|historical|delayed|frozen/i;

function supportsCftcSnapshotVersion(snapshot) {
  return Object.hasOwn(CFTC_VERSION_PAIRS, snapshot?.schemaVersion)
    && CFTC_VERSION_PAIRS[snapshot.schemaVersion] === snapshot.calculationVersion;
}

function hasInvalidCftcProvenance(value, { allowHistorical = false } = {}) {
  const flags = ['mock', 'isMock', 'seed', 'isSeed', 'seeded', 'synthetic', 'inferred', 'cacheOnly', 'cachedOnly', 'fromCache'];
  const provenance = [
    value?.source, value?.provider, value?.status, value?.sourceStatus,
    value?.cacheState, value?.provenance, value?.warning, value?.error,
  ].filter(Boolean).join(' ');
  return flags.some((key) => value?.[key] === true)
    || value?.sourceVerified === false
    || INVALID_PROVENANCE.test(provenance)
    || (!allowHistorical && NONCURRENT_PROVENANCE.test(provenance));
}

function isVerifiedCftcSnapshot(snapshot) {
  const date = snapshot?.reportDate;
  const dateMs = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)
    ? Date.parse(`${date}T00:00:00Z`) : NaN;
  return snapshot?.snapshotType === 'cftc-positioning'
    && snapshot.source === OFFICIAL_CFTC_SOURCE
    && supportsCftcSnapshotVersion(snapshot)
    && snapshot.decisionEligible === true
    && snapshot.date === date
    && Number.isFinite(dateMs)
    && new Date(dateMs).toISOString().slice(0, 10) === date
    && snapshot.datasetIds?.legacy === 'srt6-5q2f'
    && /^[a-f0-9]{64}$/i.test(String(snapshot.sourceContentHash || ''))
    && !hasInvalidCftcProvenance(snapshot);
}

function seriesCandidates(snapshot, { code, seriesType }) {
  const rows = Array.isArray(snapshot?.data) ? snapshot.data
    : Array.isArray(snapshot?.data?.rows) ? snapshot.data.rows : [];
  return rows.flatMap((parent) => {
    const alternatives = snapshot?.schemaVersion === 'cftc-positioning-v3' && Array.isArray(parent?.alternateSeries)
      ? parent.alternateSeries.map((row) => ({ row, parent })) : [];
    return [{ row: parent, parent: null }, ...alternatives];
  }).filter(({ row }) => row?.cftcContractMarketCode === code && row?.seriesType === seriesType);
}

function findCftcSeriesRows(snapshot, series) {
  return seriesCandidates(snapshot, series).map(({ row }) => row);
}

function hasVerifiedRowProvenance(row, snapshot, code) {
  const dataset = SERIES_DATASETS[row?.seriesType];
  return row?.cftcContractMarketCode === code
    && (!Object.hasOwn(row, 'seriesId') || row.seriesId === `${code}:${row.seriesType}`)
    && row.asOf === snapshot.reportDate
    && (!row.source || row.source === OFFICIAL_CFTC_SOURCE)
    && dataset && snapshot.datasetIds?.[dataset[0]] === dataset[1]
    && (!row.datasetId || row.datasetId === dataset[1])
    && !hasInvalidCftcProvenance(row);
}

// Cohorts are independent series. A missing or duplicate exact cohort must not
// silently select another cohort, even when its contract code is the same.
function selectCftcSeriesRow(snapshot, series) {
  if (!isVerifiedCftcSnapshot(snapshot)) return null;
  const candidates = seriesCandidates(snapshot, series);
  if (candidates.length !== 1) return null;
  const { row, parent } = candidates[0];
  if (parent && !hasVerifiedRowProvenance(parent, snapshot, series.code)) return null;
  if (!hasVerifiedRowProvenance(row, snapshot, series.code)
    || row.status !== 'current' || row.decisionEligible !== true) return null;
  return row;
}

module.exports = {
  OFFICIAL_CFTC_SOURCE,
  SERIES_DATASETS,
  supportsCftcSnapshotVersion,
  hasInvalidCftcProvenance,
  isVerifiedCftcSnapshot,
  findCftcSeriesRows,
  selectCftcSeriesRow,
};
