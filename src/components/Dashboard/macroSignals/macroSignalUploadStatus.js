import { getMinTimestamp } from '../../../utils/timeUtils';

export const RISK_RANGE_UPLOAD_KEYS = [
  { key: 'risk-ranges', label: 'Risk Ranges' },
  { key: 'bitcoin-trend-tracker', label: 'Bitcoin Tracker' },
  { key: 'momo-tracker', label: 'MOMO Tracker' },
];

const FRESHNESS_STATUS_LABEL = {
  fresh: 'Fresh',
  stale: 'Stale',
  missing: 'Missing',
  error: 'Error',
};

export function mapFreshnessToSourceStatus(status) {
  if (status === 'fresh') return 'current';
  if (status === 'stale') return 'stale';
  return 'defective';
}

export function buildMacroUploadSources(uploadFreshness) {
  return RISK_RANGE_UPLOAD_KEYS.map(({ key, label }) => {
    const data = uploadFreshness?.[key] || { status: 'missing', itemCount: 0 };
    const statusLabel = FRESHNESS_STATUS_LABEL[data.status] || data.status || 'Missing';
    return {
      id: key,
      label,
      updatedAt: data.date || data.scrapedAt || data.lastUpdated || null,
      detail: `${data.itemCount ?? 0} items · ${statusLabel}`,
      status: mapFreshnessToSourceStatus(data.status),
    };
  });
}

export function deriveMacroUploadAggregateStatus(sources) {
  if (sources.some((s) => s.status === 'defective')) return 'inactive';
  if (sources.some((s) => s.status === 'stale')) return 'stale';
  return 'active';
}

export function deriveMacroUploadUpdatedAt(sources) {
  return getMinTimestamp(sources.map((s) => s.updatedAt).filter(Boolean));
}
