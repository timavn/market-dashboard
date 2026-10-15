const GOLD_CORRELATION_DAILY_MAX_AGE_MS = 5 * 24 * 60 * 60_000;

export const isFiniteGoldContextValue = (value) => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));

export const FORBIDDEN_GOLD_CONTEXT_PROVENANCE = /(?:mock|seed|fixture|fallback|cache(?:d|[_ -]?only)?|portfolio|delayed|frozen|stale|offline|disconnected|synthetic|inferred|derived)/i;

export const freshDatedObservation = (value, nowMs, maxAgeMs = GOLD_CORRELATION_DAILY_MAX_AGE_MS) => {
  const token = String(value || '').slice(0, 10);
  const asOfMs = /^\d{4}-\d{2}-\d{2}$/.test(token)
    ? Date.parse(`${token}T23:59:59.999Z`)
    : Date.parse(value || '');
  const ageMs = Number(nowMs) - asOfMs;
  return Number.isFinite(asOfMs) && ageMs >= -24 * 60 * 60_000 && ageMs <= maxAgeMs;
};
