// Legacy display components consume dated observations; they never generate
// prices or infer one instrument's quote from another instrument.
const forbidden = (value) => !value || ['mock', 'seed', 'seeded', 'synthetic', 'inferred', 'fallback']
  .some((key) => value[key] === true)
  || /mock|seed|synthetic|inferred|portfolio-derived/i.test(
    [value.source, value.provider, value.provenance, value.warning].filter(Boolean).join(' '),
  );

export const finiteDisplayNumber = (value) => !['number', 'string'].includes(typeof value)
  || (typeof value === 'string' && !value.trim()) || !Number.isFinite(Number(value))
  ? null : Number(value);

export function verifiedReferenceQuote(quote, symbol) {
  if (forbidden(quote) || quote.stale === true || quote.fromCache === true || quote.cacheOnly === true
    || quote.liveSessionVerified === false
    || /unavailable|offline|disconnected|stale|error/i.test(
      `${quote.status || ''} ${quote.availability || ''} ${quote.freshness || ''} ${quote.quoteMode || ''}`,
    )) return null;
  const source = String(quote.source || quote.provider || '').toLowerCase();
  if (!['ibkr', 'yahoo', 'fred', 'stooq', 'cboe'].includes(source)) return null;
  if (symbol && String(quote.symbol || quote.pair || '').toUpperCase() !== String(symbol).toUpperCase()) return null;
  const asOf = quote.quoteAsOf || quote.timestamp || quote.asOf;
  const observedAt = Date.parse(asOf || '');
  const value = finiteDisplayNumber(quote.price ?? quote.value ?? quote.rate);
  if (!Number.isFinite(observedAt) || observedAt > Date.now() + 300_000 || value == null || value <= 0) return null;
  return { value, change: finiteDisplayNumber(quote.change), changePercent: finiteDisplayNumber(quote.changePercent), asOf, source };
}

export function verifiedHistoricalRecords(payload, symbol) {
  if (forbidden(payload) || !Array.isArray(payload.data)
    || /unavailable|offline|disconnected|error/i.test(`${payload.status || ''} ${payload.availability || ''}`)
    || String(payload.symbol || '').toUpperCase() !== String(symbol || '').toUpperCase()) return [];
  const byDate = new Map();
  payload.data.forEach((row) => {
    const timestamp = Date.parse(row?.date || '');
    const close = finiteDisplayNumber(row?.close);
    if (forbidden(row) || !Number.isFinite(timestamp) || timestamp > Date.now() || close == null || close <= 0) return;
    byDate.set(row.date, { ...row, close, dateObj: new Date(timestamp) });
  });
  return [...byDate.values()].sort((left, right) => left.dateObj - right.dateObj);
}
