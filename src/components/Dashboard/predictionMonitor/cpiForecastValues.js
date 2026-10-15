import { finite } from './monitorNumbers';

// Shared exact CPI precision, month labeling, and release availability contract.
export const normalizeCpiChartValue = (value) => (
  finite(value) ? Number(Number(value).toFixed(1)) : null
);

export const formatCpiPercent = (value) => {
  const normalized = normalizeCpiChartValue(value);
  return finite(normalized) ? `${normalized.toFixed(1)}%` : '—';
};

export const formatCpiMonth = (value) => {
  const match = String(value || '').match(/^(20\d{2})-(0[1-9]|1[0-2])$/);
  if (!match) return value || 'CURRENT REPORT';
  return new Intl.DateTimeFormat('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1)));
};

export const resolveCpiBlsActualAvailability = ({
  bls,
  reportMonth,
  releaseAt,
  nowMs = Date.now(),
} = {}) => {
  const latestFinal = bls?.latestFinal || null;
  const targetMonth = String(reportMonth || '');
  const actualMonth = String(latestFinal?.reportMonth || '');
  const validTargetMonth = /^(20\d{2})-(0[1-9]|1[0-2])$/.test(targetMonth);
  const validActualMonth = /^(20\d{2})-(0[1-9]|1[0-2])$/.test(actualMonth);
  const sourceAvailable = bls?.status === 'available'
    && finite(latestFinal?.value)
    && validTargetMonth
    && validActualMonth
    && actualMonth <= targetMonth;
  const priorMonthActualAvailable = sourceAvailable && actualMonth < targetMonth;
  const releaseAtMs = Date.parse(releaseAt || '');
  const reportMonthActualAvailable = sourceAvailable
    && actualMonth === targetMonth
    && Number.isFinite(releaseAtMs)
    && releaseAtMs <= Number(nowMs);

  return {
    latestPublishedActualAvailable: priorMonthActualAvailable || reportMonthActualAvailable,
    reportMonthActualAvailable,
  };
};
