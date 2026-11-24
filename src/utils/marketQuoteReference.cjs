// Shared provenance checks for the dashboard's dated, non-executable readings.
const ALLOWED_SOURCES = new Set(['ibkr', 'yahoo', 'fred', 'stooq', 'derived', 'trading_economics',
  'bundesbank', 'japan_mof', 'bank_of_england', 'us_treasury', 'cnbc']);
const VERIFIED_AVAILABILITIES = new Set(['current', 'delayed', 'historical']);
const SYNTHETIC_EVIDENCE = /mock|seed|synthetic|inferred|portfolio-derived|cost-basis/i;
const FAILED_EVIDENCE = /stale|expired|offline|disconnected|cache|not[_ -]?entitled|unentitled/i;

// The widest bid/ask, as a share of its midpoint, that still prices a stock or ETF with no last trade.
const MAX_UNTRADED_SPREAD = 0.01;
// With the market shut a stock or ETF often has no last trade and only a token book
// (UUP 29.60 x 34.41 on 2026-11-23, shown as up 7.47% on the day): its midpoint is not a price.
const pricedOffWideBook = (quote) => {
  const positive = (value) => value != null && value !== '' && Number.isFinite(Number(value)) && Number(value) > 0;
  if (String(quote?.source || '').toLowerCase() !== 'ibkr' && quote?.source != null) return false;
  if (!['STK', 'ETF'].includes(String(quote?.secType || '').toUpperCase())) return false;
  // `price` on a served row is the mark; only a raw quote's `price` is a trade.
  const traded = positive(quote.last) || (!('mark' in quote) && !('mid' in quote) && positive(quote.price));
  if (traded || !positive(quote.bid) || !positive(quote.ask)) return false;
  const bid = Number(quote.bid), ask = Number(quote.ask);
  return (ask - bid) / ((ask + bid) / 2) > MAX_UNTRADED_SPREAD;
};

const rowTimestamp = (row) => (
  (row?.availability === 'reference' ? row.lastVerifiedAt : null)
    || row?.quoteAsOf || row?.timestamp || row?.asOf || null
);

const hasVerifiedOrigin = (row, now) => {
  const source = String(row?.source || row?.provider || '').trim().toLowerCase();
  const timestamp = Date.parse(String(rowTimestamp(row) || ''));
  const evidence = [row?.source, row?.provider, row?.dataType, row?.quoteMode,
    row?.warning, row?.error, row?.provenance, row?.sourceStatus, row?.freshness].filter(Boolean).join(' ');
  return Boolean(
    row && String(row.symbol || row.ticker || '').trim()
      && row.price !== '' && row.price != null && Number.isFinite(Number(row.price))
      && Number.isFinite(timestamp) && timestamp <= Number(now) + 5 * 60 * 1000
      && ALLOWED_SOURCES.has(source) && !SYNTHETIC_EVIDENCE.test(evidence)
      && !['mock', 'isMock', 'seeded', 'synthetic', 'inferred', 'cacheOnly', 'fromCache']
        .some((key) => row[key] === true || row.meta?.[key] === true)
      && row._cache?.stale !== true && row._cache?.hit !== true
      && !pricedOffWideBook(row)
  );
};

const hasFailedEvidence = (row) => {
  // Preserve the rejected IBKR attempt when Yahoo supplied a verified quote.
  const rejectedProviderWarning = String(row.source || row.provider || '').toLowerCase() === 'yahoo'
    && /^ibkr\s*:/i.test(String(row.warning || ''));
  return ['stale', 'isStale', 'providerOffline', 'disconnected'].some((key) => row[key] === true)
    || row.connected === false
    || FAILED_EVIDENCE.test([row.dataType, row.error, row.sourceStatus, row.entitlementStatus,
      rejectedProviderWarning ? null : row.warning].filter(Boolean).join(' '));
};

const isVerifiedProviderRow = (row, now = Date.now()) => (
  hasVerifiedOrigin(row, now)
    && VERIFIED_AVAILABILITIES.has(row.availability)
    && !FAILED_EVIDENCE.test(String(row.freshness || ''))
    && !hasFailedEvidence(row)
);

const isRetainedQuoteReference = (row, now = Date.now()) => (
  hasVerifiedOrigin(row, now)
    && row.availability === 'reference'
    && row.displayOnly === true && row.executable === false && row.displayDelayed === true
    && Number.isFinite(Date.parse(String(row.lastVerifiedAt || '')))
    && !hasFailedEvidence(row)
);

const markRetainedReference = (row, reason, now = Date.now()) => {
  if (!isVerifiedProviderRow(row, now) && !isRetainedQuoteReference(row, now)) return null;
  const lastVerifiedAt = rowTimestamp(row);
  return {
    ...row,
    timestamp: lastVerifiedAt,
    quoteAsOf: lastVerifiedAt,
    lastVerifiedAt,
    availability: 'reference',
    freshness: 'refresh-delayed',
    quoteMode: 'last-verified-reference',
    refreshDelayed: true,
    displayDelayed: true,
    displayOnly: true,
    executable: false,
    directNative: false,
    retentionReason: reason || 'provider_refresh_unavailable',
  };
};

module.exports = { isVerifiedProviderRow, isRetainedQuoteReference, markRetainedReference, rowTimestamp, pricedOffWideBook };
