export const finite = (value) => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));

export const proxyFitSigned = (value, suffix = '') => finite(value)
  ? `${Number(value) > 0 ? '+' : ''}${Number(value).toFixed(2)}${suffix}`
  : '—';

export const proxyFitDeviationTone = (value) => {
  if (!finite(value)) return 'is-unavailable';
  const magnitude = Math.abs(Number(value));
  if (magnitude >= 2) return 'is-danger';
  if (magnitude >= 1) return 'is-caution';
  return 'is-normal';
};

export const formatPythTrackingUsd = (value, { signed = false } = {}) => finite(value)
  ? `${signed ? Number(value) > 0 ? '+' : Number(value) < 0 ? '-' : '' : ''}$${Math.abs(Number(value)).toFixed(2)}`
  : '—';

export const formatAthSessionDate = (date) => {
  const parsed = Date.parse(`${date}T12:00:00.000Z`);
  return Number.isFinite(parsed)
    ? new Date(parsed).toLocaleDateString('en-US', {
        month: 'numeric', day: 'numeric', year: 'numeric', timeZone: 'UTC',
      })
    : String(date || '—');
};
