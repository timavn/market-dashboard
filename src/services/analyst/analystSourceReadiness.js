import { analystWorkspaceApi } from './analystClient';

export const ANALYST_SOURCE_REFRESH_MS = 60_000;
export const ANALYST_SOURCE_MAX_AGE_MS = 120_000;
const FUTURE_TOLERANCE_MS = 30_000;
const easternDay = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
});
const unavailableEvidence = (value) => value?.stale === true || value?.cacheOnly === true
  || value?.mock === true || value?.seeded === true || value?.connected === false
  || ['offline', 'disconnected', 'failed', 'error', 'cached', 'mock', 'seeded'].includes(value?.status);
const observedTimestamp = (value, now) => {
  const timestamp = typeof value === 'string' && value.trim() ? Date.parse(value) : NaN;
  return Number.isFinite(timestamp) && timestamp <= now + FUTURE_TOLERANCE_MS ? value : null;
};

export const analystSourceDay = (now = Date.now()) => easternDay.format(new Date(now));

// Source publication and update times remain distinct from this request's
// freshness. A successful fetch cannot turn yesterday's publication into today's.
export function normalizeAnalystSourceReadiness(payload, now = Date.now()) {
  const date = analystSourceDay(now);
  const checkedAt = observedTimestamp(payload?.checkedAt, now);
  const available = Boolean(checkedAt && now - Date.parse(checkedAt) <= ANALYST_SOURCE_MAX_AGE_MS
    && payload?.date === date && analystSourceDay(Date.parse(checkedAt)) === date
    && !unavailableEvidence(payload) && Array.isArray(payload?.automatedSources));
  const rows = (Array.isArray(payload?.automatedSources) ? payload.automatedSources : [])
    .filter((row) => typeof row?.id === 'string' && typeof row?.label === 'string')
    .map((row) => {
      const provenance = Boolean(row.evidenceHash && (row.sourceUri || row.sourceIds?.length));
      const updatedAt = available && provenance && !unavailableEvidence(row)
        ? observedTimestamp(row.updatedAt, now) : null;
      const usableForDay = Boolean(available && updatedAt && row.usableForDay === true
        && row.status === 'ready' && row.publicationDate?.slice(0, 10) === date
        && observedTimestamp(row.observedAt, now) && observedTimestamp(row.indexedAt, now));
      return {
        id: row.id, label: row.label, updatedAt, usableForDay,
        notReceived: Boolean(available && !usableForDay && row.status === 'not_received'),
        publicationDate: row.publicationDate || null,
        reason: usableForDay ? null : available ? row.reason || 'Unavailable for today.' : 'Source availability is unavailable.',
      };
    });
  return { date, checkedAt: available ? checkedAt : null, available, rows };
}

export async function loadAnalystSourceReadiness() {
  return analystWorkspaceApi.request('/daily');
}

// Refresh at the publication-day boundary, including when the open drawer
// spans midnight. No browser storage is used for daily usability.
export function analystSourceRefreshDelay(now = Date.now(), checkedAt) {
  const expiry = Date.parse(checkedAt) + ANALYST_SOURCE_MAX_AGE_MS - now;
  const refreshWithin = Number.isFinite(expiry)
    ? Math.max(1, Math.min(ANALYST_SOURCE_REFRESH_MS, expiry)) : ANALYST_SOURCE_REFRESH_MS;
  if (analystSourceDay(now) === analystSourceDay(now + refreshWithin)) {
    return refreshWithin;
  }
  let low = now;
  let high = now + refreshWithin;
  const date = analystSourceDay(now);
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (analystSourceDay(middle) === date) low = middle;
    else high = middle;
  }
  return Math.max(1, high - now);
}
