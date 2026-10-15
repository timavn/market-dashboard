import { OFFICIAL_CFTC_SOURCE, supportsCftcSnapshotVersion, hasInvalidCftcProvenance } from './cftcSnapshot.cjs';

export const getCftcReportDate = (snapshot) => {
  const value = snapshot?.reportDate || snapshot?.date || snapshot?.asOf;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const time = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value || time > Date.now()) return null;
  return value;
};

const hasInvalidProvenance = (value) => hasInvalidCftcProvenance(value, { allowHistorical: true });

const hasFiniteScore = (value) => (
  (typeof value === 'number' || (typeof value === 'string' && value.trim() !== ''))
  && Number.isFinite(Number(value))
);

// CFTC is a weekly informational report. Keep dated official evidence eligible
// for reference display as it ages; the caller must disclose report freshness.
export const getCftcHighlightRows = (snapshot) => {
  const reportDate = getCftcReportDate(snapshot);
  if (!reportDate || snapshot?.source !== OFFICIAL_CFTC_SOURCE
    || !supportsCftcSnapshotVersion(snapshot) || hasInvalidProvenance(snapshot)) return [];
  return (Array.isArray(snapshot?.data) ? snapshot.data : [])
    .filter((row) => (
      row && typeof row.metric === 'string' && row.metric.trim() !== ''
      && row.asOf === reportDate
      && ['current', 'partial'].includes(row.status)
      && (!row.source || row.source === OFFICIAL_CFTC_SOURCE)
      && !hasInvalidProvenance(row)
      && hasFiniteScore(row.zScore1Y)
    ))
    .sort((left, right) => (
      Math.abs(Number(right.zScore1Y)) - Math.abs(Number(left.zScore1Y))
      || left.metric.localeCompare(right.metric, 'en')
      || String(left.cftcContractMarketCode || '').localeCompare(String(right.cftcContractMarketCode || ''), 'en')
    ))
    .slice(0, 11);
};
