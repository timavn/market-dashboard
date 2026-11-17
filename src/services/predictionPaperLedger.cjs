// Paper record of the setup board's sized tickets: the first split shown for each event on a market day,
// scored after Kalshi settles it. It measures whether the sizing inputs and the line zones pay; no order is placed.

const TABLE = 'PredictionMarketPerformanceLedger';
const ACCOUNT = 'paper';
const PREFIX = 'ticket#';
const PRICE_BUCKETS = [[0, 0.2, 'under 20¢'], [0.2, 0.5, '20–50¢'], [0.5, 0.8, '50–80¢'], [0.8, 1.01, '80¢ and up']];

// DynamoDB stores no undefined values; a ticket is plain JSON.
const plain = (value) => JSON.parse(JSON.stringify(value));

function ticketOf(row, marketDate, duration = 'daily') {
  const sizing = duration === 'weekly' ? row.sizing?.weekly : row.sizing;
  if (!sizing?.event || !Array.isArray(sizing.lines) || !sizing.lines.length || !marketDate) return null;
  return plain({
    accountId: ACCOUNT, recordKey: `${PREFIX}${marketDate}#${sizing.event}`, kind: 'paper-ticket', status: 'open', duration,
    marketDate, market: row.id, label: row.label, event: sizing.event, side: row.sizing.side, pct: row.sizing.pct, spentPct: sizing.spentPct,
    wide: Boolean(sizing.wide), volBand: row.sizing.volBand || null, ladder: sizing.ladder || null, rangeLimit: sizing.rangeLimit ?? null,
    quotedAt: sizing.quotedAt || null,
    components: (row.sizing.components || []).map(({ key, weight, points, missing }) => ({ key, weight, points, ...(missing ? { missing: true } : {}) })),
    lines: sizing.lines.map(({ ticker, strike, buy, ask, fee, moves, zone, pct }) => ({ ticker, strike, buy, ask, fee, moves, zone, pct })),
  });
}

/** Both tickets of a sized row: its daily event and, when listed, its weekly event. */
const ticketsOf = (row, marketDate) => ['daily', 'weekly'].map((duration) => ticketOf(row, marketDate, duration)).filter(Boolean);

/** P&L of a ticket in % of the account once every line has a result; null while any is still open. */
function scoreTicket(ticket, results) {
  const lines = ticket.lines.map((line) => {
    const result = results.get(line.ticker);
    if (result !== 'yes' && result !== 'no') return null;
    const won = result === (line.buy === 'YES' ? 'yes' : 'no');
    return { ...line, result, won, pnlPct: line.pct * ((won ? 1 : 0) / (line.ask + line.fee) - 1) };
  });
  if (lines.some((line) => !line)) return null;
  return { lines, pnlPct: lines.reduce((sum, line) => sum + line.pnlPct, 0) };
}

function summarize(tickets) {
  const settled = tickets.filter((ticket) => ticket.status === 'settled');
  const tally = (lines) => {
    const staked = lines.reduce((sum, line) => sum + line.pct, 0);
    const pnl = lines.reduce((sum, line) => sum + line.pnlPct, 0);
    return { lines: lines.length, won: lines.filter((line) => line.won).length, stakedPct: staked, pnlPct: pnl,
      returnOnStake: staked > 0 ? pnl / staked : null };
  };
  const linesOf = (list) => list.flatMap((ticket) => ticket.lines);
  const group = (keyOf) => {
    const groups = new Map();
    for (const ticket of settled) for (const key of [].concat(keyOf(ticket))) groups.set(key, [...(groups.get(key) || []), ticket]);
    return Object.fromEntries([...groups].map(([key, list]) => [key, { tickets: list.length, ...tally(linesOf(list)) }]));
  };
  const all = linesOf(settled);
  return {
    tickets: tickets.length, open: tickets.length - settled.length, settled: settled.length,
    wonTickets: settled.filter((ticket) => ticket.pnlPct > 0).length, ...tally(all),
    byMarket: group((ticket) => ticket.market),
    bySide: group((ticket) => ticket.side),
    byDuration: group((ticket) => ticket.duration || 'daily'),
    byZone: Object.fromEntries(['target', 'far', 'near'].map((zone) => [zone, tally(all.filter((line) => line.zone === zone))])
      .filter(([, bucket]) => bucket.lines)),
    byPrice: Object.fromEntries(PRICE_BUCKETS.map(([from, to, label]) => [label, tally(all.filter((line) => line.ask >= from && line.ask < to))])
      .filter(([, bucket]) => bucket.lines)),
    // Each size input, split by what it did to the ticket's size.
    byInput: group((ticket) => (ticket.components || []).map((item) => `${item.key}:${item.missing ? 'missing'
      : item.points >= 0.75 * item.weight ? 'added' : item.points < 0 ? 'subtracted' : item.points > 0 ? 'part' : 'nothing'}`)),
  };
}

function createPaperLedger({ dynamodb, loadKalshiMarkets, tableName = TABLE, settleEveryMs = 15 * 60_000 }) {
  const recorded = new Set();
  let settledAt = 0;
  let cached = null;

  async function all() {
    const items = [];
    let start;
    do {
      const page = await dynamodb.query({ TableName: tableName, KeyConditionExpression: 'accountId = :account AND begins_with(recordKey, :prefix)',
        ExpressionAttributeValues: { ':account': ACCOUNT, ':prefix': PREFIX }, ExclusiveStartKey: start }).promise();
      items.push(...(page.Items || []));
      start = page.LastEvaluatedKey;
    } while (start);
    return items;
  }

  /** Save the first split shown for each event on its market day; later boards leave it as it was. */
  async function record(board) {
    const tickets = (board?.rows || []).flatMap((row) => ticketsOf(row, board.marketDate)).filter((ticket) => !recorded.has(ticket.recordKey));
    await Promise.all(tickets.map(async (ticket) => {
      try {
        await dynamodb.put({ TableName: tableName, Item: { ...ticket, recordedAt: new Date().toISOString() },
          ConditionExpression: 'attribute_not_exists(recordKey)' }).promise();
        cached = null;
      } catch (error) {
        if (error?.code !== 'ConditionalCheckFailedException') throw error;
      }
      recorded.add(ticket.recordKey);
    }));
    return tickets.length;
  }

  /** Score every open ticket whose lines Kalshi has settled. */
  async function settle({ now = Date.now(), force = false } = {}) {
    if (!force && now - settledAt < settleEveryMs) return 0;
    settledAt = now;
    const open = (await all()).filter((ticket) => ticket.status === 'open');
    let count = 0;
    for (const ticket of open) {
      const markets = await Promise.resolve().then(() => loadKalshiMarkets(ticket.event)).catch(() => null);
      if (!Array.isArray(markets)) continue;
      const scored = scoreTicket(ticket, new Map(markets.map((market) => [market.ticker, market.result])));
      if (!scored) continue;
      await dynamodb.update({ TableName: tableName, Key: { accountId: ACCOUNT, recordKey: ticket.recordKey },
        UpdateExpression: 'SET #status = :settled, #lines = :lines, pnlPct = :pnl, settledAt = :at',
        ConditionExpression: '#status = :open',
        ExpressionAttributeNames: { '#status': 'status', '#lines': 'lines' },
        ExpressionAttributeValues: { ':settled': 'settled', ':open': 'open', ':lines': plain(scored.lines), ':pnl': scored.pnlPct,
          ':at': new Date(now).toISOString() } }).promise();
      count += 1;
    }
    if (count) cached = null;
    return count;
  }

  async function summary({ tickets = false } = {}) {
    if (!cached) { const items = await all(); cached = { items, summary: summarize(items) }; }
    return tickets ? { ...cached.summary, list: cached.items } : cached.summary;
  }

  return { record, settle, summary };
}

module.exports = { createPaperLedger, scoreTicket, summarize, ticketOf, ticketsOf };
