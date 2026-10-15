export const isSpxMonitorSectionUsable = (section, nowMs = Date.now()) => {
  if (!section || !['available', 'partial', 'historical'].includes(section.status)) return false;
  if (section.refreshFailed === true || section.fromCache === true || section.cachedOnly === true
    || section.cacheOnly === true || section.seeded === true || section.mock === true || section.stale === true) return false;
  if ((section.refreshing === true || section.refreshPending === true) && section.refreshRetained !== true) return false;
  const status = String(section.status || '').toLowerCase();
  const availability = String(section.availability || '').toLowerCase();
  if (status === 'historical' || availability === 'historical') {
    const historicalThroughDate = String(section.historicalThroughDate || '');
    const latestAt = Date.parse(section.latestAt || section.asOf || '');
    const latestDate = Number.isFinite(latestAt) ? new Date(latestAt).toISOString().slice(0, 10) : null;
    const source = String(section.source || '');
    return /^\d{4}-\d{2}-\d{2}$/.test(historicalThroughDate)
      && latestDate === historicalThroughDate
      && !/(?:mock|seed|fixture|fallback|cache|portfolio|delayed|frozen|stale|offline|disconnected|synthetic|inferred|derived)/i.test(source);
  }
  if (!section.expiresAt) return true;
  const expiresAt = Date.parse(section.expiresAt);
  return Number.isFinite(expiresAt) && nowMs <= expiresAt;
};
