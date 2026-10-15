const DXY_CONTEXT_MAX_AGE_MS = 5 * 24 * 60 * 60_000;

const FORBIDDEN_PROVENANCE = /delayed|frozen|stale|cache(?:d|_only|-only)?|mock|seed|fallback|offline|disconnected|synthetic|inferred|derived/i;

function finiteNumber(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function dateKey(value) {
  const match = String(value || '').match(/^(\d{4}-\d{2}-\d{2})/);
  return match?.[1] || null;
}

function unavailableDxy(reason) {
  return {
    status: 'unavailable',
    availability: 'unavailable',
    value: null,
    previousClose: null,
    changePercent: null,
    fifteenDayChangePercent: null,
    thirtyDayChangePercent: null,
    source: null,
    asOf: null,
    historicalThroughDate: null,
    expiresAt: null,
    decisionEligible: false,
    reason,
  };
}

function normalizeDxyContext(snapshot, nowMs = Date.now()) {
  const context = snapshot?.assetContext?.dxy;
  const value = finiteNumber(context?.value);
  const previousClose = finiteNumber(context?.previousClose);
  const changePercent = finiteNumber(context?.changePercent);
  const asOf = dateKey(context?.asOf);
  const calculationDate = dateKey(snapshot?.calculationDate);
  const source = String(context?.source || '').trim();
  const asOfEndMs = asOf ? Date.parse(`${asOf}T23:59:59.999Z`) : NaN;
  const ageMs = Number(nowMs) - asOfEndMs;
  const provenance = [
    snapshot?.sourceStatus,
    snapshot?.source,
    snapshot?.provenance,
    snapshot?.warning,
    context?.provenance,
    context?.warning,
    context?.error,
    context?.reason,
  ].filter(Boolean).join(' ');
  const blocked = snapshot?.refreshFailed === true
    || snapshot?.fromCache === true
    || snapshot?.cachedOnly === true
    || context?.refreshFailed === true
    || context?.fromCache === true
    || context?.cachedOnly === true
    || FORBIDDEN_PROVENANCE.test(provenance);

  if (snapshot?.sourceStatus !== 'current'
    || context?.status !== 'historical'
    || context?.availability !== 'historical'
    || context?.decisionEligible !== false
    || value == null
    || value <= 0
    || !asOf
    || asOf !== calculationDate
    || !Number.isFinite(asOfEndMs)
    || ageMs < -24 * 60 * 60_000
    || ageMs > DXY_CONTEXT_MAX_AGE_MS
    || !/^Yahoo Finance completed DXY daily bars$/i.test(source)
    || blocked) {
    return unavailableDxy('Verified completed-session DXY context is unavailable.');
  }

  return {
    status: 'historical',
    availability: 'historical',
    value,
    previousClose: previousClose != null && previousClose > 0 ? previousClose : null,
    changePercent,
    fifteenDayChangePercent: finiteNumber(context?.fifteenDayChangePercent),
    thirtyDayChangePercent: finiteNumber(context?.thirtyDayChangePercent),
    source,
    asOf,
    historicalThroughDate: asOf,
    expiresAt: new Date(asOfEndMs + DXY_CONTEXT_MAX_AGE_MS).toISOString(),
    decisionEligible: false,
    reason: 'Completed-session DXY close; dollar-strength context only, not an executable price or scoring input.',
  };
}

module.exports = {
  DXY_CONTEXT_MAX_AGE_MS,
  normalizeDxyContext,
};
