const UNIVERSE = require('../constants/predictionMarketUniverse.json');
const { marketIdForTicker } = require('./predictionLineMonitor.cjs');

// Today's Kalshi activity for the Analyst's Daily Review: what was bought and sold, and what settled.
// Read-only: two account reads, summed. Nothing here sizes or places an order.

const finite = (value) => (value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? null : Number(value));
const marketLabel = (ticker) => {
  const id = marketIdForTicker(ticker);
  return UNIVERSE.markets.find((market) => market.id === id)?.label || String(ticker || '').split('-')[0];
};

/**
 * Fills since `since`, one row per market, side and action. Dollars are contracts times the price paid on the
 * fill's own side. A fill without a count or price makes the whole read unusable rather than understating the day.
 */
function summarizeFills(fills) {
  const groups = new Map();
  let fees = 0;
  for (const fill of fills) {
    const side = String(fill.side || '').toLowerCase();
    const action = String(fill.action || '').toLowerCase();
    const contracts = finite(fill.count_fp ?? fill.count);
    const price = finite(fill[`${side}_price_dollars`]) ?? (finite(fill[`${side}_price`]) === null ? null : finite(fill[`${side}_price`]) / 100);
    if (!['yes', 'no'].includes(side) || !['buy', 'sell'].includes(action) || !contracts || price === null) return null;
    const market = marketLabel(fill.ticker);
    const key = `${market}|${side}|${action}`;
    const group = groups.get(key) || { market, side: side.toUpperCase(), action, contracts: 0, dollars: 0, fills: 0, lastAt: null };
    group.contracts += contracts;
    group.dollars += contracts * price;
    group.fills += 1;
    if (fill.created_time && (!group.lastAt || fill.created_time > group.lastAt)) group.lastAt = fill.created_time;
    groups.set(key, group);
    fees += finite(fill.fee_cost) || 0;
  }
  const rows = [...groups.values()].map((row) => ({ ...row, avgPrice: row.dollars / row.contracts }))
    .sort((left, right) => right.dollars - left.dollars);
  const total = (action) => rows.filter((row) => row.action === action).reduce((sum, row) => sum + row.dollars, 0);
  return { count: fills.length, bought: total('buy'), sold: total('sell'), fees, rows };
}

/** Settlements since `since`: what each settled line cost, what it paid, and the difference after fees. */
function summarizeSettlements(settlements) {
  const rows = [];
  for (const item of settlements) {
    const cost = (finite(item.yes_total_cost_dollars) ?? 0) + (finite(item.no_total_cost_dollars) ?? 0);
    const revenue = finite(item.revenue);
    if (revenue === null) return null;
    const fees = finite(item.fee_cost) || 0;
    rows.push({ market: marketLabel(item.ticker), ticker: item.ticker, result: String(item.market_result || '').toUpperCase() || null,
      cost, revenue: revenue / 100, fees, pnl: revenue / 100 - cost - fees, settledAt: item.settled_time || null });
  }
  const sum = (key) => rows.reduce((total, row) => total + row[key], 0);
  return { count: rows.length, cost: sum('cost'), revenue: sum('revenue'), fees: sum('fees'), pnl: sum('pnl'),
    rows: rows.sort((left, right) => Math.abs(right.pnl) - Math.abs(left.pnl)) };
}

/** `loadFills` and `loadSettlements` take a unix-seconds floor and return every row at or after it. */
function createDayActivityLoader({ loadFills, loadSettlements }) {
  return async function loadDayActivity({ since, now = new Date() }) {
    const start = new Date(since);
    if (!Number.isFinite(start.getTime()) || start > now || now - start > 7 * 86_400_000) {
      throw Object.assign(new Error('since must be a time within the last week'), { statusCode: 400 });
    }
    const floor = Math.floor(start.getTime() / 1000);
    const [fills, settlements] = await Promise.all([loadFills(floor), loadSettlements(floor)]);
    // Kalshi's floor is trusted, but a row outside it never counts as today's.
    const within = (value) => { const time = Date.parse(value); return Number.isFinite(time) && time >= start.getTime(); };
    const fillSummary = summarizeFills((fills || []).filter((fill) => within(fill.created_time)));
    const settlementSummary = summarizeSettlements((settlements || []).filter((item) => within(item.settled_time)));
    if (!fillSummary || !settlementSummary) throw new Error('Kalshi activity could not be read');
    return { ok: true, since: start.toISOString(), asOf: now.toISOString(), fills: fillSummary, settlements: settlementSummary };
  };
}

module.exports = { createDayActivityLoader, summarizeFills, summarizeSettlements };
