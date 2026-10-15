import { finite } from './monitorNumbers';

export const FORBIDDEN_SPX_HEADER_REFERENCE_SOURCE = /(?:mock|seed|fixture|fallback|cache|portfolio|delayed|frozen|stale|offline|disconnected|synthetic|inferred|derived)/i;

export const isLastVerifiedContractReference = (section, generationKey, nowMs = Date.now()) => {
  const retainedUntil = Date.parse(section?.retainedUntil || '');
  const asOf = Date.parse(section?.asOf || '');
  const source = String(section?.source || '').trim();
  const retainedAvailability = String(section?.retainedAvailability || 'live').toLowerCase();
  return section?.status === 'last_verified'
    && section?.availability === 'last_verified'
    && section?.fit === 'exact'
    && section?.displayOnly === true
    && section?.executable === false
    && ['live', 'current'].includes(retainedAvailability)
    && finite(section?.value)
    && source.length > 0
    && !/(?:mock|seed|fixture|fallback|cache|portfolio|delayed|frozen|offline|disconnected|historical|synthetic|inferred|derived)/i.test(source)
    && section?.fromCache !== true
    && section?.cachedOnly !== true
    && section?.cacheOnly !== true
    && section?.seeded !== true
    && section?.mock !== true
    && (!generationKey || section?.generationKey === generationKey)
    && Number.isFinite(asOf)
    && asOf <= nowMs + 5_000
    && Number.isFinite(retainedUntil)
    && nowMs < retainedUntil;
};

export const isVerifiedDisplayReference = (section, nowMs = Date.now()) => {
  const status = String(section?.status || '').toLowerCase();
  const availability = String(section?.availability || '').toLowerCase();
  const source = String(section?.source || '').trim();
  const asOf = Date.parse(section?.asOf || '');
  const expiresAt = Date.parse(section?.expiresAt || '');
  const historicalThroughDate = String(section?.historicalThroughDate || '');
  const datedHistorical = status === 'historical' || availability === 'historical';
  const historicalDateMatches = datedHistorical
    && Number.isFinite(asOf)
    && /^\d{4}-\d{2}-\d{2}$/.test(historicalThroughDate)
    && new Date(asOf).toISOString().slice(0, 10) === historicalThroughDate;
  const retainedRefresh = section?.refreshRetained === true
    && (section?.refreshPending === true || section?.refreshing === true);
  return ['available', 'historical'].includes(status)
    && ['live', 'current', 'historical'].includes(availability || (datedHistorical ? 'historical' : ''))
    && ['exact', 'proxy'].includes(String(section?.fit || 'exact').toLowerCase())
    && finite(section?.value)
    && source.length > 0
    && !/(?:mock|seed|fixture|fallback|cache|portfolio|delayed|frozen|stale|offline|disconnected|synthetic|inferred|derived)/i.test(source)
    && (section?.refreshing !== true || retainedRefresh)
    && (section?.refreshPending !== true || retainedRefresh)
    && section?.refreshFailed !== true
    && section?.fromCache !== true
    && section?.cachedOnly !== true
    && section?.seeded !== true
    && Number.isFinite(asOf)
    && asOf <= nowMs + 5_000
    && (historicalDateMatches || (!datedHistorical && Number.isFinite(expiresAt) && nowMs <= expiresAt));
};

export const isVerifiedDelayedSpxHeaderReference = (section, nowMs = Date.now()) => {
  const asOf = Date.parse(section?.asOf || '');
  const source = String(section?.source || '').trim();
  const retainedAvailability = String(section?.retainedAvailability || '').toLowerCase();
  return section?.status === 'delayed'
    && section?.availability === 'delayed'
    && section?.displayDelayed === true
    && section?.displayOnly === true
    && section?.executable === false
    && section?.clientVerified === true
    && ['live', 'current'].includes(retainedAvailability)
    && finite(section?.value)
    && source.length > 0
    && !FORBIDDEN_SPX_HEADER_REFERENCE_SOURCE.test(source)
    && section?.fromCache !== true
    && section?.cachedOnly !== true
    && section?.cacheOnly !== true
    && section?.seeded !== true
    && section?.mock !== true
    && section?.stale !== true
    && Number.isFinite(asOf)
    && asOf <= nowMs + 5_000;
};

export const isVerifiedDelayedContractReference = (section, expectedSymbol, nowMs = Date.now()) => {
  const label = String(section?.label || '').trim().toUpperCase();
  const symbol = String(expectedSymbol || '').trim().toUpperCase();
  const fit = String(section?.fit || '').trim().toLowerCase();
  return ['exact', 'proxy'].includes(fit)
    && isVerifiedDelayedSpxHeaderReference(section, nowMs)
    && (fit === 'proxy' || !symbol || label === symbol);
};
