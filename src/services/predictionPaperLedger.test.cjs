const test = require('node:test');
const assert = require('node:assert/strict');
const { createPaperLedger, scoreTicket, summarize, ticketOf, ticketsOf } = require('./predictionPaperLedger.cjs');

// The slice of DocumentClient the ledger uses, over a Map.
function fakeTable() {
  const items = new Map();
  const reply = (run) => ({ promise: async () => run() });
  return { items,
    put: ({ Item, ConditionExpression }) => reply(() => {
      if (ConditionExpression && items.has(Item.recordKey)) throw Object.assign(new Error('exists'), { code: 'ConditionalCheckFailedException' });
      items.set(Item.recordKey, structuredClone(Item)); return {};
    }),
    query: () => reply(() => ({ Items: [...items.values()].map((item) => structuredClone(item)) })),
    update: ({ Key, ExpressionAttributeValues: values }) => reply(() => {
      Object.assign(items.get(Key.recordKey), { status: values[':settled'], lines: values[':lines'], pnlPct: values[':pnl'], settledAt: values[':at'] });
      return {};
    }) };
}

const line = (strike, ask, pct, zone = 'target') => ({ ticker: `G-T${strike}`, strike, buy: 'NO', ask, fee: 0.07 * ask * (1 - ask), moves: 0.7, zone, pct });
const board = (lines = [line(4000, 0.5, 2, 'near'), line(4040, 0.85, 4)]) => ({ marketDate: '2026-11-11', rows: [
  { id: 'gold', label: 'Gold', sizing: { side: 'SHORT', pct: 4.5, spentPct: 6, event: 'KXGOLDD-26NOV1117', wide: false, volBand: 'Moderate',
    quotedAt: '2026-11-11T16:00:00Z',
    components: [{ key: 'usd', label: 'Dollar', weight: 1, points: 1 }, { key: 'tick', label: 'Tick', weight: 0.5, points: -0.5 },
      { key: 'volume', label: 'Volume', weight: 0.5, points: 0, missing: true }], lines } },
  { id: 'silver', label: 'Silver', sizing: { side: 'LONG', pct: 3, event: 'KXSILVERD-26NOV1117', lines: [], reason: 'No liquid line' } },
  { id: 'copper', label: 'Copper' }] });

test('only a setup with funded lines becomes a ticket, one per duration', () => {
  const tickets = board().rows.map((row) => ticketOf(row, '2026-11-11')).filter(Boolean);
  assert.equal(tickets.length, 1);
  assert.equal(tickets[0].recordKey, 'ticket#2026-11-11#KXGOLDD-26NOV1117');
  assert.deepEqual([tickets[0].duration, tickets[0].pct, tickets[0].lines[0].zone], ['daily', 4.5, 'near']);
  assert.deepEqual(tickets[0].components[2], { key: 'volume', weight: 0.5, points: 0, missing: true });
  // A weekly ticket is its own record under the weekly event, sized like the daily one.
  const gold = board().rows[0];
  gold.sizing.weekly = { event: 'KXGOLDW-26NOV1317', spentPct: 4.5, lines: [line(3900, 0.3, 4.5)] };
  assert.deepEqual(ticketsOf(gold, '2026-11-11').map((ticket) => [ticket.duration, ticket.recordKey, ticket.side, ticket.pct]),
    [['daily', 'ticket#2026-11-11#KXGOLDD-26NOV1117', 'SHORT', 4.5], ['weekly', 'ticket#2026-11-11#KXGOLDW-26NOV1317', 'SHORT', 4.5]]);
});

test('a ticket scores only when every line has settled', () => {
  const ticket = ticketOf(board().rows[0], '2026-11-11');
  assert.equal(scoreTicket(ticket, new Map([['G-T4000', 'no']])), null);
  const scored = scoreTicket(ticket, new Map([['G-T4000', 'yes'], ['G-T4040', 'no']]));
  // NO at 50¢ lost its 2%; NO at 85¢ paid 1 on 0.85 + fee.
  assert.equal(scored.lines[0].pnlPct, -2);
  assert.ok(Math.abs(scored.lines[1].pnlPct - 4 * (1 / (0.85 + 0.07 * 0.85 * 0.15) - 1)) < 1e-9);
  assert.ok(Math.abs(scored.pnlPct - (scored.lines[0].pnlPct + scored.lines[1].pnlPct)) < 1e-12);
});

test('the first split of the day is kept, then settled once and summarised', async () => {
  const table = fakeTable();
  let results = [{ ticker: 'G-T4000', result: '' }, { ticker: 'G-T4040', result: '' }];
  const ledger = createPaperLedger({ dynamodb: table, loadKalshiMarkets: async () => results });
  assert.equal(await ledger.record(board()), 1);
  // A later board for the same event changes nothing, in this process or another.
  assert.equal(await ledger.record(board([line(4000, 0.4, 8)])), 0);
  await createPaperLedger({ dynamodb: table, loadKalshiMarkets: async () => results }).record(board([line(4000, 0.4, 8)]));
  assert.equal(table.items.get('ticket#2026-11-11#KXGOLDD-26NOV1117').lines.length, 2);
  assert.equal(await ledger.settle({ now: 1 }), 0);
  assert.equal((await ledger.summary()).open, 1);
  results = [{ ticker: 'G-T4000', result: 'no' }, { ticker: 'G-T4040', result: 'no' }];
  // Settlement is checked at most once per interval.
  assert.equal(await ledger.settle({ now: 2 }), 0);
  assert.equal(await ledger.settle({ now: 2, force: true }), 1);
  assert.equal(await ledger.settle({ now: 3, force: true }), 0);
  const summary = await ledger.summary();
  assert.deepEqual([summary.tickets, summary.settled, summary.open, summary.wonTickets, summary.lines, summary.won], [1, 1, 0, 1, 2, 2]);
  assert.equal(summary.stakedPct, 6);
  assert.ok(summary.returnOnStake > 0);
  assert.equal(summary.byMarket.gold.tickets, 1);
  assert.deepEqual(Object.keys(summary.byPrice), ['50–80¢', '80¢ and up']);
  assert.deepEqual(Object.keys(summary.byInput).sort(), ['tick:subtracted', 'usd:added', 'volume:missing']);
  assert.deepEqual([Object.keys(summary.byZone), Object.keys(summary.byDuration)], [['target', 'near'], ['daily']]);
  assert.equal((await ledger.summary({ tickets: true })).list.length, 1);
});

test('an empty ledger summarises to zeros', () => {
  const summary = summarize([]);
  assert.deepEqual([summary.tickets, summary.settled, summary.returnOnStake], [0, 0, null]);
});
