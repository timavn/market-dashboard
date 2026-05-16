const {
  WIDE_SPREAD_THRESHOLD,
  THIN_LIQUIDITY_THRESHOLD,
  STALE_QUOTE_MS_DEFAULT,
  STATUS_OPEN,
} = require('../constants');

function mid(bid, ask) {
  if (bid != null && ask != null) return (bid + ask) / 2;
  return null;
}

/**
 * @param {object} event
 * @param {object} [opts]
 * @param {number} [opts.staleMs]
 * @param {number|null} [opts.fairProbability]
 */
function enrichEvent(event, opts = {}) {
  const staleMs = opts.staleMs ?? STALE_QUOTE_MS_DEFAULT;
  const flags = [...(event.data_quality_flags || [])];

  const yes_mid = mid(event.yes_bid, event.yes_ask);
  const no_mid = mid(event.no_bid, event.no_ask);
  const spread =
    event.yes_bid != null && event.yes_ask != null ? event.yes_ask - event.yes_bid : null;
  const implied_probability_mid = yes_mid;

  if (spread != null && spread > WIDE_SPREAD_THRESHOLD && !flags.includes('wide_spread')) {
    flags.push('wide_spread');
  }
  if (
    (event.volume == null || event.volume < THIN_LIQUIDITY_THRESHOLD) &&
    (event.liquidity == null || event.liquidity < THIN_LIQUIDITY_THRESHOLD) &&
    STATUS_OPEN.has(event.status) &&
    !flags.includes('thin_liquidity')
  ) {
    flags.push('thin_liquidity');
  }
  if (!event.settlement_source && !flags.includes('missing_settlement_source')) {
    flags.push('missing_settlement_source');
  }
  if (event.tradable_in_ibkr === false && !flags.includes('not_tradable_in_ibkr')) {
    flags.push('not_tradable_in_ibkr');
  }

  const updatedAt = event.updated_at ? new Date(event.updated_at).getTime() : 0;
  if (updatedAt && Date.now() - updatedAt > staleMs && !flags.includes('stale_quote')) {
    flags.push('stale_quote');
  }

  let fee_adjusted_edge = event.fee_adjusted_edge ?? null;
  if (opts.fairProbability != null && implied_probability_mid != null) {
    const fee = event.fee_per_contract ?? 0;
    fee_adjusted_edge = opts.fairProbability - implied_probability_mid - fee;
  }

  const enriched = {
    ...event,
    yes_mid,
    no_mid,
    implied_probability_mid,
    spread,
    data_quality_flags: flags,
    fee_adjusted_edge,
  };

  delete enriched._tags;
  delete enriched._seriesCategory;
  delete enriched._contractSide;

  return enriched;
}

module.exports = { enrichEvent, mid };
