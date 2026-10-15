import { finite } from './monitorNumbers';

export const formatIndex = (value, decimals = 2) => finite(value)
  ? Number(value).toLocaleString('en-US', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    })
  : '—';

export const formatCount = (value) => finite(value)
  ? Number(value).toLocaleString('en-US', { maximumFractionDigits: 0 })
  : '—';

export const formatCents = (value) => finite(value) ? `${Math.round(Number(value) * 100)}¢` : '—';

export const formatFactorAsOf = (value) => {
  if (!value) return '—';
  const raw = String(value).trim();
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(raw);
  const parsed = Date.parse(dateOnly ? `${raw}T12:00:00Z` : raw);
  if (!Number.isFinite(parsed)) return '—';
  const parts = new Intl.DateTimeFormat('en-US', {
    day: 'numeric',
    month: 'short',
    ...(dateOnly
      ? { timeZone: 'UTC' }
      : { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short' }),
  }).formatToParts(new Date(parsed));
  const part = (type) => parts.find((entry) => entry.type === type)?.value;
  const date = `${part('day')} ${part('month')}`;
  // A source calendar date has no verified clock time or time zone.
  return dateOnly ? `${date} —` : `${date} ${part('hour')}:${part('minute')} ${part('timeZoneName')}`;
};

export const formatAsOf = (value, refreshDelayed = false) => {
  if (!value) return refreshDelayed ? 'REFRESH DELAYED' : '—';
  const raw = String(value);
  const dateOnly = raw.match(/^\d{4}-\d{2}-\d{2}$/);
  const parsed = Date.parse(dateOnly ? `${raw}T12:00:00Z` : raw);
  if (!Number.isFinite(parsed)) return raw;
  const label = dateOnly
    ? new Date(parsed).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
    : new Date(parsed).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
  return refreshDelayed ? `${label} · REFRESH DELAYED` : label;
};
