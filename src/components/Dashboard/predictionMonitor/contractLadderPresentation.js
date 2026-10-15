import { finite } from './monitorNumbers';
import { formatIndex } from './monitorFormatting';

export const formatMarkerDate = (value) => {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toLocaleDateString('en-US', {
    month: 'numeric',
    day: 'numeric',
    timeZone: 'America/New_York',
  });
};

export const formatSpotMarker = (spot) => {
  const historicalClose = spot?.status === 'historical' || ['last_close', 'historical'].includes(spot?.availability);
  const delayed = spot?.status === 'last_verified'
    || ['last_verified', 'delayed'].includes(String(spot?.availability || '').toLowerCase());
  const proxy = spot?.fit === 'proxy';
  const fromBar = /historical[_ -]?bars|current[_ -]?bar/i.test(`${spot?.source || ''} ${spot?.label || ''}`);
  const mode = delayed
    ? 'DELAYED'
    : historicalClose
      ? 'LAST CLOSE'
      : fromBar || spot?.availability === 'current' ? null : 'LIVE';
  const rawLabel = String(spot?.label || '').trim()
    .replace(/^PROXY\s*·\s*/i, '')
    .replace(/^EXACT\s*·\s*/i, '')
    .replace(/^LAST VERIFIED\s+/i, '')
    .replace(/^DELAYED\s+/i, '')
    .replace(/^LIVE\s+/i, '')
    .replace(/\s*·\s*NOT RESOLVER\s*\/\s*NOT EXECUTABLE$/i, '')
    .replace(/\s+(?:LAST CLOSE|CURRENT BAR|LIVE|DELAYED)$/i, '')
    || 'REFERENCE';
  const provenance = proxy ? 'PROXY' : 'EXACT';
  const closeDate = historicalClose ? formatMarkerDate(spot?.asOf) : null;
  return `${provenance} · ${rawLabel}${mode ? ` · ${mode}` : ''} ${formatIndex(spot?.value)}${closeDate ? ` (${closeDate})` : ''}`;
};

export const formatSpread = (bid, ask) => finite(bid) && finite(ask) && Number(ask) >= Number(bid)
  ? `${Math.round((Number(ask) - Number(bid)) * 100)}¢`
  : '—';

export const formatSignedDistance = (strike, spot) => {
  if (!finite(strike) || !finite(spot) || Number(spot) === 0) return '—';
  const points = Number(strike) - Number(spot);
  const percent = (points / Number(spot)) * 100;
  const sign = points > 0 ? '+' : points < 0 ? '−' : '';
  return `${sign}${Math.abs(points).toFixed(2)} (${sign}${Math.abs(percent).toFixed(2)}%)`;
};
