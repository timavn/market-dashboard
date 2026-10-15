import {
  FORBIDDEN_SPX_HEADER_REFERENCE_SOURCE,
  isVerifiedDelayedSpxHeaderReference,
  isVerifiedDisplayReference,
} from './contractReferenceValidation';
import { FORBIDDEN_GOLD_CONTEXT_PROVENANCE, freshDatedObservation } from './goldContextValidation';
import { finite } from './monitorNumbers';

const HEADER_QUOTE_MAX_AGE_MS = 60_000;

const HEADER_CURRENT_BAR_MAX_AGE_MS = 10 * 60_000;

const resolveDayChangePercent = (value, previousClose) => {
  if (!finite(value) || !finite(previousClose) || Number(previousClose) <= 0) return null;
  return Number((((Number(value) - Number(previousClose)) / Number(previousClose)) * 100).toFixed(2));
};

const isVerifiedLiveCashHeaderQuote = (section, nowMs = Date.now()) => {
  const source = String(section?.source || '').trim();
  const asOf = Date.parse(section?.asOf || '');
  const expiresAt = Date.parse(section?.expiresAt || '');
  return section?.status === 'available'
    && section?.availability === 'live'
    && finite(section?.value)
    && source.length > 0
    && !/(?:mock|seed|fixture|fallback|cache|portfolio|delayed|frozen|stale|offline|disconnected|historical|synthetic|inferred|derived)/i.test(source)
    && section?.refreshing !== true
    && section?.refreshFailed !== true
    && section?.fromCache !== true
    && Number.isFinite(asOf)
    && asOf <= nowMs + 5_000
    && Number.isFinite(expiresAt)
    && nowMs <= expiresAt;
};

const isVerifiedHistoricalCashHeaderQuote = (section, nowMs = Date.now()) => {
  const source = String(section?.source || '').trim();
  const asOf = Date.parse(section?.asOf || '');
  const historicalThroughDate = String(section?.historicalThroughDate || '');
  const asOfDate = Number.isFinite(asOf) ? new Date(asOf).toISOString().slice(0, 10) : null;
  return section?.status === 'historical'
    && section?.availability === 'last_close'
    && finite(section?.value)
    && /^(?:ibkr_historical_daily_close|ibkr_historical_intraday_session_close)$/.test(source)
    && /^\d{4}-\d{2}-\d{2}$/.test(historicalThroughDate)
    && asOfDate === historicalThroughDate
    && Number.isFinite(asOf)
    && asOf <= nowMs + 5_000
    && section?.refreshing !== true
    && section?.refreshFailed !== true
    && section?.fromCache !== true
    && section?.cachedOnly !== true
    && section?.stale !== true;
};

const isRetainableSpxHeaderReference = (section, nowMs = Date.now()) => {
  if (isVerifiedLiveCashHeaderQuote(section, nowMs)
    || isVerifiedDisplayReference(section, nowMs)
    || isVerifiedDelayedSpxHeaderReference(section, nowMs)) return true;
  const status = String(section?.status || '').toLowerCase();
  const availability = String(section?.availability || '').toLowerCase();
  const source = String(section?.source || '').trim();
  const asOf = Date.parse(section?.asOf || '');
  return status === 'available'
    && ['live', 'current'].includes(availability)
    && section?.clientVerified === true
    && finite(section?.value)
    && source.length > 0
    && !FORBIDDEN_SPX_HEADER_REFERENCE_SOURCE.test(source)
    && section?.refreshFailed !== true
    && section?.fromCache !== true
    && section?.cachedOnly !== true
    && section?.cacheOnly !== true
    && section?.seeded !== true
    && section?.mock !== true
    && section?.stale !== true
    && Number.isFinite(asOf)
    && asOf <= nowMs + 5_000;
};

const normalizeGoldHeaderMarketReference = (reference, nowMs) => {
  const role = reference?.role === 'direct' ? 'direct' : 'proxy';
  const rawStatus = String(reference?.status || '').toLowerCase();
  const retainedStatus = String(reference?.retainedStatus || '').toLowerCase();
  const source = String(reference?.source || '');
  const price = finite(reference?.price) && Number(reference.price) > 0 ? Number(reference.price) : null;
  const previousClose = finite(reference?.previousClose) && Number(reference.previousClose) > 0
    ? Number(reference.previousClose)
    : null;
  const changePercent = previousClose != null && price != null
    ? resolveDayChangePercent(price, previousClose)
    : null;
  const asOfMs = Date.parse(reference?.asOf || '');
  const expiresAtMs = Date.parse(reference?.expiresAt || '');
  const ageMs = Number(nowMs) - asOfMs;
  const provenance = [
    source,
    reference?.warning,
    reference?.provenance,
    reference?.cacheState,
    reference?.fromCache ? 'cached' : null,
    reference?.cachedOnly ? 'cached-only' : null,
    reference?.mock ? 'mock' : null,
    reference?.seeded ? 'seed' : null,
  ].filter(Boolean).join(' ');
  const sourceValid = /^(?:ibkr|pyth)(?:\b|_)/i.test(source)
    && !FORBIDDEN_GOLD_CONTEXT_PROVENANCE.test(provenance);
  const currentIbkrBar = source.toLowerCase() === 'ibkr_historical_bars';
  const liveMaxAgeMs = currentIbkrBar
    ? HEADER_CURRENT_BAR_MAX_AGE_MS
    : HEADER_QUOTE_MAX_AGE_MS;
  const liveEvidence = price != null
    && sourceValid
    && Number.isFinite(asOfMs)
    && ageMs >= -5_000
    && ageMs <= liveMaxAgeMs
    && Number.isFinite(expiresAtMs)
    && expiresAtMs >= Number(nowMs);
  const historicalEvidence = price != null
    && sourceValid
    && freshDatedObservation(reference?.asOf, nowMs);
  const live = rawStatus === 'live'
    && liveEvidence;
  const historical = rawStatus === 'historical'
    && historicalEvidence;
  const delayed = rawStatus === 'delayed'
    && ['live', 'historical'].includes(retainedStatus)
    && reference?.displayOnly === true
    && reference?.refreshRetained === true
    && reference?.refreshFailed !== true
    && (retainedStatus === 'live' ? liveEvidence : historicalEvidence);
  const loading = rawStatus === 'loading' || rawStatus === 'refreshing';
  const available = live || historical || delayed;
  return {
    key: reference?.key || null,
    label: reference?.label || 'GOLD REFERENCE',
    symbol: reference?.symbol || 'GOLD',
    role,
    status: live ? 'live' : historical ? 'historical' : delayed ? 'delayed' : loading ? 'loading' : 'unavailable',
    retainedStatus: delayed ? retainedStatus : null,
    price: available ? price : null,
    previousClose: available ? previousClose : null,
    changePercent: available ? changePercent : null,
    source: available ? source : null,
    asOf: available ? reference.asOf : null,
    expiresAt: available ? reference?.expiresAt || null : null,
    instrument: reference?.instrument || null,
    reason: available
      ? reference?.reason || null
      : reference?.reason || 'Verified Gold reference is unavailable.',
  };
};

export { HEADER_QUOTE_MAX_AGE_MS, isRetainableSpxHeaderReference, isVerifiedHistoricalCashHeaderQuote, isVerifiedLiveCashHeaderQuote, normalizeGoldHeaderMarketReference, resolveDayChangePercent };
