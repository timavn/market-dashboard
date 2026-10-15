import { formatInTimeZone } from 'date-fns-tz';
import { CFTC_SERIES_LABELS } from '../constants/cftcPositioning';
import {
  supportsCftcSnapshotVersion,
  hasInvalidCftcProvenance,
  SERIES_DATASETS,
  OFFICIAL_CFTC_SOURCE,
} from './cftcSnapshot.cjs';

export const cftcNumber = value => typeof value === 'number' && Number.isFinite(value) ? value : null;

export const formatCftcNumber = (value, { score = false, signed = false } = {}) => {
  const number = cftcNumber(value);
  if (number === null) return '—';
  const formatted = score
    ? number.toFixed(2)
    : number.toLocaleString('en-US', { maximumFractionDigits: 0 });
  return signed && number > 0 ? `+${formatted}` : formatted;
};

export const formatCftcReportNumber = (value, { score = false } = {}) => {
  const number = cftcNumber(value);
  if (number === null) return '—';
  if (score) return `${formatCftcNumber(number, { score: true })}X`;
  const formatted = formatCftcNumber(Math.abs(number));
  return number < 0 ? `(${formatted})` : formatted;
};

export const cftcDirectionClass = (value, threshold = 0) => {
  const number = cftcNumber(value);
  return number > threshold ? 'is-positive' : number < -threshold ? 'is-negative' : '';
};

export const cftcValueClass = (value, { score = false } = {}) => {
  const number = cftcNumber(value);
  if (number === null) return 'is-unavailable';
  return [
    number < 0 ? 'is-negative' : score && number > 0 ? 'is-positive' : '',
    score && Math.abs(number) > 2 ? 'is-extreme' : '',
  ].filter(Boolean).join(' ');
};

export const isCftcReportDate = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};

export const formatCftcDate = (value, { compact = false } = {}) => isCftcReportDate(value)
  ? formatInTimeZone(new Date(`${value}T12:00:00Z`), 'UTC', compact ? 'M/d/yy' : 'MMM d, yyyy')
  : 'UNAVAILABLE';

export const formatCftcRetrieval = value => {
  if (isCftcReportDate(value)) return formatCftcDate(value);
  if (typeof value !== 'string' || !/T.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) return 'UNAVAILABLE';
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime())
    ? `${formatInTimeZone(parsed, 'America/Los_Angeles', 'MMM d, yyyy HH:mm')} PT`
    : 'UNAVAILABLE';
};

export const isCftcResearchSnapshot = snapshot => snapshot?.source === OFFICIAL_CFTC_SOURCE
  && snapshot.sourceVerified !== false
  && snapshot.snapshotType === 'cftc-positioning'
  && supportsCftcSnapshotVersion(snapshot)
  && !hasInvalidCftcProvenance(snapshot, { allowHistorical: true })
  && isCftcReportDate(snapshot.reportDate)
  && snapshot.date === snapshot.reportDate
  && snapshot.reportDate <= new Date(Date.now()).toISOString().slice(0, 10)
  && snapshot.datasetIds?.legacy === SERIES_DATASETS['legacy-noncommercial-combined'][1]
  && /^[a-f0-9]{64}$/i.test(String(snapshot.sourceContentHash || ''));

export const isCftcResearchRow = (row, snapshot = null) => {
  const dataset = SERIES_DATASETS[row?.seriesType];
  return Boolean(row
    && dataset
    && typeof row.cftcContractMarketCode === 'string' && row.cftcContractMarketCode.length > 0
    && (!row.source || row.source === OFFICIAL_CFTC_SOURCE)
    && row.sourceVerified !== false
    && isCftcReportDate(row.asOf)
    && row.asOf <= new Date(Date.now()).toISOString().slice(0, 10)
    && (!row.seriesId || row.seriesId === `${row.cftcContractMarketCode}:${row.seriesType}`)
    && (!row.datasetId || row.datasetId === dataset[1])
    && !hasInvalidCftcProvenance(row, { allowHistorical: true })
    && ['current', 'partial', 'discontinued'].includes(row.status)
    && (!snapshot || (snapshot.datasetIds?.[dataset[0]] === dataset[1]
      && (row.asOf === snapshot.reportDate
        || (row.status === 'discontinued' && row.asOf < snapshot.reportDate)))));
};

export const getCftcRowKey = row => row.seriesId
  || `${row.cftcContractMarketCode || row.metric}:${row.seriesType}`;

export const getCftcDisplayRow = (row, snapshot) => {
  if (isCftcResearchRow(row, snapshot)) return row;
  return {
    ...row,
    status: 'unavailable',
    latest: null,
    wwChg: null,
    zScore1Y: null,
    zScore3Y: null,
    historyStatistics: null,
    alternateSeries: [],
  };
};

export const getCftcSourceUrl = (row, snapshot) => {
  const sourceKey = CFTC_SERIES_LABELS[row?.seriesType]?.sourceKey;
  const value = row?.sourceUrl || snapshot?.sourceUrls?.[sourceKey];
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'publicreporting.cftc.gov'
      ? url.href : null;
  } catch {
    return null;
  }
};

export const getCftcMethodologyNote = rows => {
  const series = [...new Set(rows.filter(row => isCftcResearchRow(row)).map(row => row.seriesType))];
  if (!series.length) return 'Weekly CFTC positioning. Informational only.';
  const descriptions = series.map(type => {
    const label = CFTC_SERIES_LABELS[type].label;
    const contracts = rows.filter(row => row.seriesType === type && isCftcResearchRow(row)).map(row => row.metric);
    return series.length > 1 && contracts.length <= 3 ? `${label} (${contracts.join(', ')})` : label;
  });
  return `Official Combined futures + options: ${descriptions.join('; ')}. Weekly, informational only.`;
};
