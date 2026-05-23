const IBKR_VENUES = new Set(['ForecastEx', 'CME', 'IBKR']);

function isIbkrEvent(event) {
  return event.tradable_in_ibkr === true || IBKR_VENUES.has(event.venue);
}

function isKalshiEvent(event) {
  return event.venue === 'Kalshi';
}

function uniqueVenues(group) {
  return [...new Set(group.map((e) => e.venue).filter(Boolean))];
}

function altQuoteRow(event) {
  return {
    venue: event.venue,
    id: event.id,
    yes_bid: event.yes_bid,
    yes_ask: event.yes_ask,
    volume: event.volume,
    open_interest: event.open_interest,
    updated_at: event.updated_at,
  };
}

function singleEventToCanonical(event) {
  return {
    ...event,
    venues: [event.venue].filter(Boolean),
    quote_source: isIbkrEvent(event) ? event.venue || 'IBKR' : event.venue,
    ibkr_tradable: isIbkrEvent(event),
    kalshi_url: isKalshiEvent(event) ? event.url : null,
    alt_quotes: [],
    is_merged: false,
  };
}

function mergeGroup(group) {
  const ibkr = group.find(isIbkrEvent) || null;
  const kalshi = group.find(isKalshiEvent) || null;
  const primary = ibkr || kalshi || group[0];
  const venues = uniqueVenues(group);
  const quoteSource = ibkr ? ibkr.venue || 'IBKR' : kalshi?.venue || primary.venue;

  const merged = {
    ...primary,
    venues,
    quote_source: quoteSource,
    ibkr_tradable: Boolean(ibkr),
    kalshi_url: kalshi?.url || null,
    alt_quotes: group.map(altQuoteRow),
    is_merged: group.length > 1,
    event_title: kalshi?.event_title || ibkr?.event_title || primary.event_title,
    contract_title: kalshi?.contract_title || ibkr?.contract_title || primary.contract_title,
    question: kalshi?.question || ibkr?.question || primary.question,
    url: kalshi?.url || ibkr?.url || primary.url,
    expiration_time:
      kalshi?.expiration_time || ibkr?.expiration_time || primary.expiration_time,
    close_time: kalshi?.close_time || ibkr?.close_time || primary.close_time,
    category: kalshi?.category || ibkr?.category || primary.category,
    underlying: kalshi?.underlying || ibkr?.underlying || primary.underlying,
    settlement_source:
      kalshi?.settlement_source || ibkr?.settlement_source || primary.settlement_source,
  };

  if (ibkr) {
    merged.yes_bid = ibkr.yes_bid ?? merged.yes_bid;
    merged.yes_ask = ibkr.yes_ask ?? merged.yes_ask;
    merged.yes_mid = ibkr.yes_mid ?? merged.yes_mid;
    merged.no_bid = ibkr.no_bid ?? merged.no_bid;
    merged.no_ask = ibkr.no_ask ?? merged.no_ask;
    merged.no_mid = ibkr.no_mid ?? merged.no_mid;
    merged.last_price = ibkr.last_price ?? merged.last_price;
    merged.spread = ibkr.spread ?? merged.spread;
    merged.volume = ibkr.volume ?? merged.volume;
    merged.implied_probability_mid = ibkr.implied_probability_mid ?? merged.implied_probability_mid;
    merged.updated_at = ibkr.updated_at ?? merged.updated_at;
    merged.tradable_in_ibkr = true;
  } else if (kalshi) {
    merged.yes_bid = kalshi.yes_bid ?? merged.yes_bid;
    merged.yes_ask = kalshi.yes_ask ?? merged.yes_ask;
    merged.last_price = kalshi.last_price ?? merged.last_price;
    merged.spread = kalshi.spread ?? merged.spread;
    merged.volume = kalshi.volume ?? merged.volume;
    merged.updated_at = kalshi.updated_at ?? merged.updated_at;
  }

  if (kalshi) {
    merged.open_interest = kalshi.open_interest ?? merged.open_interest;
    merged.liquidity = kalshi.liquidity ?? merged.liquidity;
    merged.total_volume = kalshi.volume ?? merged.total_volume;
  }

  merged.id = primary.id;
  return merged;
}

/**
 * Collapse cross-venue duplicates (same comparison_group_id) into canonical rows.
 * IBKR quotes take precedence; Kalshi OI/liquidity are retained when present.
 *
 * @param {object[]} events
 * @returns {object[]}
 */
function mergeCrossVenueEvents(events) {
  const groups = new Map();
  for (const event of events) {
    const key = event.comparison_group_id || event.id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(event);
  }

  return [...groups.values()].map((group) =>
    group.length === 1 ? singleEventToCanonical(group[0]) : mergeGroup(group)
  );
}

module.exports = {
  mergeCrossVenueEvents,
  isIbkrEvent,
  isKalshiEvent,
};
