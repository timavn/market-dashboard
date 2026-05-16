const crypto = require('crypto');
const { fromKalshiCents, fromCmeSnapshot, fromForecastEx, deriveNoFromYes, toNum } = require('./priceScaling');

const CATEGORY_MAP = {
  economics: 'Other Macro',
  financials: 'Index',
  finance: 'Index',
  fed: 'Rates',
  inflation: 'Inflation',
  employment: 'Labor',
  gdp: 'Growth',
  crypto: 'Crypto',
  commodities: 'Commodities',
};

function inferCategory(text, seriesCategory) {
  const t = (text || '').toLowerCase();
  if (seriesCategory && CATEGORY_MAP[seriesCategory.toLowerCase()]) {
    return CATEGORY_MAP[seriesCategory.toLowerCase()];
  }
  if (/cpi|pce|ppi|inflation/.test(t)) return 'Inflation';
  if (/payroll|jobs|unemployment|nfp|labor/.test(t)) return 'Labor';
  if (/fed|fomc|rate|yield|treasury/.test(t)) return 'Rates';
  if (/gdp|growth|recession|retail sales/.test(t)) return 'Growth';
  if (/spx|spy|nasdaq|qqq|dow|s&p|index|russell|iwm/.test(t)) return 'Index';
  if (/oil|gold|silver|wti|brent|natural gas/.test(t)) return 'Commodities';
  if (/eur|usd|dxy|fx|dollar|yen/.test(t)) return 'FX';
  if (/bitcoin|btc|eth|crypto/.test(t)) return 'Crypto';
  if (/credit|spread|hyg|ig/.test(t)) return 'Credit';
  return 'Other Macro';
}

function mapStatus(raw) {
  const s = String(raw || '').toLowerCase();
  if (['open', 'active', 'unopened'].includes(s)) return 'open';
  if (s === 'closed') return 'closed';
  if (s === 'settled') return 'settled';
  if (s === 'paused') return 'paused';
  return 'unknown';
}

function normalizeKalshi(raw, ctx = {}) {
  const m = raw.market || raw;
  const event = raw.event || ctx.event || {};
  const series = raw.series || ctx.series || {};
  const yesBid = fromKalshiCents(m.yes_bid ?? m.yes_bid_dollars);
  const yesAsk = fromKalshiCents(m.yes_ask ?? m.yes_ask_dollars);
  const last = fromKalshiCents(m.last_price ?? m.last_price_dollars);
  const noDerived = deriveNoFromYes(yesBid, yesAsk);
  const title = event.title || series.title || m.title || '';
  const question = m.subtitle || m.yes_sub_title || title || m.ticker;
  const settlementSources = series.settlement_sources || m.settlement_sources || [];
  const settlementSource = settlementSources[0]?.name || settlementSources[0] || null;
  const rules = m.rules_primary || m.rules_secondary || series.contract_terms_url || '';

  return {
    id: `kalshi:${m.ticker}`,
    venue: 'Kalshi',
    source_api: 'kalshi_trade_api_v2',
    tradable_in_ibkr: null,
    category: inferCategory(`${title} ${question}`, series.category),
    underlying: series.ticker || event.event_ticker || m.event_ticker || '',
    event_title: title,
    contract_title: m.subtitle || question,
    question,
    settlement_rules_summary: typeof rules === 'string' ? rules.slice(0, 500) : '',
    settlement_source: settlementSource,
    event_date: (m.close_time || event.strike_date || '').slice(0, 10) || null,
    close_time: m.close_time || event.close_time || null,
    expiration_time: m.expiration_time || m.expected_expiration_time || m.close_time || null,
    status: mapStatus(m.status),
    yes_bid: yesBid,
    yes_ask: yesAsk,
    yes_mid: null,
    no_bid: noDerived.no_bid,
    no_ask: noDerived.no_ask,
    no_mid: null,
    last_price: last,
    implied_probability_mid: null,
    spread: null,
    volume: toNum(m.volume ?? m.volume_fp),
    open_interest: toNum(m.open_interest ?? m.open_interest_fp),
    liquidity: toNum(m.liquidity ?? m.liquidity_dollars),
    min_tick: 0.01,
    fee_per_contract: null,
    max_payout_per_contract: 1,
    url: m.ticker ? `https://kalshi.com/markets/${m.ticker}` : null,
    api_raw_symbol: m.ticker,
    api_raw_id: m.ticker,
    updated_at: new Date().toISOString(),
    comparison_group_id: null,
    data_quality_flags: [],
    fee_adjusted_edge: null,
    _tags: series.tags || [],
    _seriesCategory: series.category,
  };
}

function normalizeIbkrForecastEx(raw, ctx = {}) {
  const snap = ctx.snapshot || {};
  const yesBid = fromForecastEx(snap['84']);
  const yesAsk = fromForecastEx(snap['86']);
  const last = fromForecastEx(snap['31']);
  const noDerived = deriveNoFromYes(yesBid, yesAsk);
  const question = raw.desc2 || raw.description || ctx.marketName || '';
  const right = raw.right === 'C' ? 'Yes' : 'No';

  return {
    id: `forecastex:${raw.conid}`,
    venue: 'ForecastEx',
    source_api: 'IBKR_CPAPI',
    tradable_in_ibkr: true,
    category: inferCategory(`${ctx.eventTitle || ''} ${question}`, 'economics'),
    underlying: raw.symbol || ctx.underlying || '',
    event_title: ctx.eventTitle || raw.desc1 || raw.symbol,
    contract_title: question,
    question: ctx.question || question,
    settlement_rules_summary: ctx.settlementRules || '',
    settlement_source: ctx.settlementSource || 'ForecastEx',
    event_date: raw.maturityDate ? `${raw.maturityDate.slice(0, 4)}-${raw.maturityDate.slice(4, 6)}-${raw.maturityDate.slice(6, 8)}` : null,
    close_time: null,
    expiration_time: raw.maturityDate || null,
    status: 'open',
    yes_bid: right === 'Yes' ? yesBid : noDerived.no_bid,
    yes_ask: right === 'Yes' ? yesAsk : noDerived.no_ask,
    yes_mid: null,
    no_bid: right === 'No' ? yesBid : noDerived.no_bid,
    no_ask: right === 'No' ? yesAsk : noDerived.no_ask,
    no_mid: null,
    last_price: last,
    implied_probability_mid: null,
    spread: null,
    volume: toNum(snap['7059']),
    open_interest: null,
    liquidity: null,
    min_tick: 0.01,
    fee_per_contract: null,
    max_payout_per_contract: 1,
    url: 'https://forecasttrader.interactivebrokers.com/eventtrader/#/markets',
    api_raw_symbol: raw.desc2 || String(raw.conid),
    api_raw_id: String(raw.conid),
    updated_at: new Date().toISOString(),
    comparison_group_id: null,
    data_quality_flags: [],
    fee_adjusted_edge: null,
    _contractSide: right,
  };
}

function normalizeIbkrCme(raw, ctx = {}) {
  const snap = ctx.snapshot || {};
  const yesBid = fromCmeSnapshot(snap['84']);
  const yesAsk = fromCmeSnapshot(snap['86']);
  const last = fromCmeSnapshot(snap['31']);
  const noDerived = deriveNoFromYes(yesBid, yesAsk);
  const question = raw.desc2 || ctx.question || '';

  return {
    id: `cme:${raw.conid}`,
    venue: 'CME',
    source_api: 'IBKR_CPAPI',
    tradable_in_ibkr: true,
    category: inferCategory(question, null),
    underlying: raw.symbol || '',
    event_title: ctx.eventTitle || raw.desc1 || raw.symbol,
    contract_title: question,
    question,
    settlement_rules_summary: ctx.settlementRules || '',
    settlement_source: ctx.settlementSource || 'CME',
    event_date: raw.maturityDate ? `${raw.maturityDate.slice(0, 4)}-${raw.maturityDate.slice(4, 6)}-${raw.maturityDate.slice(6, 8)}` : null,
    close_time: null,
    expiration_time: raw.maturityDate || null,
    status: 'open',
    yes_bid: yesBid,
    yes_ask: yesAsk,
    yes_mid: null,
    no_bid: noDerived.no_bid,
    no_ask: noDerived.no_ask,
    no_mid: null,
    last_price: last,
    implied_probability_mid: null,
    spread: null,
    volume: toNum(snap['7059']),
    open_interest: null,
    liquidity: null,
    min_tick: 1,
    fee_per_contract: null,
    max_payout_per_contract: 100,
    url: 'https://www.cmegroup.com/activetrader/event-contracts.html',
    api_raw_symbol: raw.desc2 || String(raw.conid),
    api_raw_id: String(raw.conid),
    updated_at: new Date().toISOString(),
    comparison_group_id: null,
    data_quality_flags: [],
    fee_adjusted_edge: null,
  };
}

/**
 * @param {object} rawEvent
 * @param {'kalshi'|'ibkr_forecastex'|'ibkr_cme'|'ibkr'|'forecastex'|'cme'} provider
 * @param {object} [ctx]
 */
function normalizeEvent(rawEvent, provider, ctx = {}) {
  switch (provider) {
    case 'kalshi':
      return normalizeKalshi(rawEvent, ctx);
    case 'ibkr_forecastex':
    case 'forecastex':
      return normalizeIbkrForecastEx(rawEvent, ctx);
    case 'ibkr_cme':
    case 'cme':
      return normalizeIbkrCme(rawEvent, ctx);
    default:
      return normalizeKalshi(rawEvent, ctx);
  }
}

function buildEventId(venue, apiRawId) {
  return `${venue}#${apiRawId}`;
}

function comparisonFingerprint(event) {
  const payload = [
    (event.question || '').toLowerCase().replace(/\s+/g, ' ').trim(),
    (event.underlying || '').toLowerCase(),
    event.event_date || '',
    (event.settlement_source || '').toLowerCase(),
  ].join('|');
  return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

module.exports = {
  normalizeEvent,
  normalizeKalshi,
  normalizeIbkrForecastEx,
  normalizeIbkrCme,
  inferCategory,
  mapStatus,
  buildEventId,
  comparisonFingerprint,
};
