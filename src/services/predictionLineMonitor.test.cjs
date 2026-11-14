const test = require('node:test');
const assert = require('node:assert/strict');
const { phi } = require('./predictionSizing.cjs');
const { applyLineMonitor, gradeLines, kalshiCentre, ladderLines, marketMonitor, shadeOf, sideBook, heldDirection, heldPositions, heldState, kalshiBook,
  marketIdForTicker, strength } = require('./predictionLineMonitor.cjs');

const NOW = new Date('2026-11-13T18:00:00Z');
const CLOSE = '2026-11-13T22:00:00Z';
// A Kalshi "above" ladder priced off a normal curve, quoted in dollars like the API: centre 50, one-sigma 1.
const ladder = ({ event = 'KXSILVERD-26NOV1317', centre = 50, sigma = 1, half = 0.01, close = CLOSE } = {}) =>
  Array.from({ length: 9 }, (_, index) => {
    const strike = centre + (index - 4) * 0.5;
    const above = 1 - phi((strike - centre) / sigma);
    const cents = (value) => Math.min(0.99, Math.max(0.01, value)).toFixed(4);
    return { ticker: `${event}-T${strike}`, event_ticker: event, strike_type: 'greater', floor_strike: strike, close_time: close,
      yes_bid_dollars: cents(above - half), yes_ask_dollars: cents(above + half),
      no_bid_dollars: cents(1 - above - half), no_ask_dollars: cents(1 - above + half), yes_sub_title: `$${strike} or above` };
  });

const shortRow = { id: 'silver', label: 'Silver', group: 'metals', events: [{ eventTicker: 'KXSILVERD-26NOV1317' }],
  tick: { direction: 'BEARISH' }, trade: { direction: 'BEARISH' }, trend: 'BEARISH', position: 0.95, setup: { side: 'SHORT', reason: null } };

test('edge tiers', () => {
  assert.equal(strength(0.06), 'STRONG');
  assert.equal(strength(0.035), 'GOOD');
  assert.equal(strength(0.012), 'WATCH');
  assert.equal(strength(0.005), 'PASS');
  assert.equal(strength(-0.02), 'PASS');
});

test('shading: Trade and Trend agree and price sits in the matching third of the Risk Range', () => {
  const row = (trade, trend, position) => ({ trade: trade && { direction: trade }, trend, position, tick: { direction: 'NEUTRAL' } });
  // Tick plays no part.
  assert.deepEqual(shadeOf(row('BEARISH', 'BEARISH', 0.7)), { side: 'SHORT' });
  assert.deepEqual(shadeOf(row('BEARISH', 'BEARISH', 1)), { side: 'SHORT' });
  assert.deepEqual(shadeOf(row('BULLISH', 'BULLISH', 0.3)), { side: 'LONG' });
  assert.deepEqual(shadeOf(row('BULLISH', 'BULLISH', 0)), { side: 'LONG' });
  assert.deepEqual(shadeOf(row('BEARISH', 'BEARISH', 0.6)), { side: null, reason: 'Price not in the top third' });
  assert.deepEqual(shadeOf(row('BULLISH', 'BULLISH', 0.5)), { side: null, reason: 'Price not in the bottom third' });
  assert.deepEqual(shadeOf(row('BULLISH', 'BEARISH', 0.9)), { side: null, reason: 'Trade Bullish, Trend Bearish' });
  assert.deepEqual(shadeOf(row(null, 'BEARISH', 0.9)), { side: null, reason: 'No Trade' });
  assert.deepEqual(shadeOf(row('BEARISH', 'NEUTRAL', 0.9)), { side: null, reason: 'Trend Neutral' });
  // Outside the range is never shaded.
  assert.deepEqual(shadeOf(row('BEARISH', 'BEARISH', 1.05)), { side: null, reason: 'Above range' });
  assert.deepEqual(shadeOf(row('BULLISH', 'BULLISH', -0.1)), { side: null, reason: 'Below range' });
  assert.deepEqual(shadeOf(row('BULLISH', 'BULLISH', null)), { side: null, reason: 'No range position' });
});

test("Kalshi's centre is the strike interpolated where YES crosses 50%", () => {
  assert.equal(kalshiCentre([{ strike: 10, kalshiOdds: 0.6 }, { strike: 12, kalshiOdds: 0.4 }, { strike: 14, kalshiOdds: 0.2 }]), 11);
  assert.equal(kalshiCentre([{ strike: 10, kalshiOdds: 0.3 }]), null);
});

test('held direction follows strike type and side', () => {
  assert.equal(heldDirection('greater', 'YES'), 'LONG');
  assert.equal(heldDirection('greater', 'NO'), 'SHORT');
  assert.equal(heldDirection('less', 'YES'), 'SHORT');
  assert.equal(heldDirection('between', 'YES'), null);
});

test('positions map to markets through their own or held series', () => {
  assert.equal(marketIdForTicker('KXSILVERW-26NOV1317-T50.99'), 'silver');
  assert.equal(marketIdForTicker('KXBTCD-26NOV1317-T72999.99'), 'bitcoin');
  assert.equal(marketIdForTicker('KXUST10A-26NOV13-T4.92'), 'ust10y');
  assert.equal(marketIdForTicker('KXSOMETHING-26NOV13-T1'), null);
  const held = heldPositions({ market_positions: [
    { ticker: 'KXSILVERW-26NOV1317-T50.99', position_fp: '-778.53', market_exposure_dollars: '214.3757' },
    { ticker: 'KXGOLDW-26NOV1317-T4108.99', position_fp: '0.00', market_exposure_dollars: '0' },
    { ticker: 'KXCPIYOY-26NOV-T3.6', position_fp: '1000.00', market_exposure_dollars: '719.579' }] });
  assert.deepEqual(held.map((line) => [line.side, line.contracts, line.event]),
    [['NO', 778.53, 'KXSILVERW-26NOV1317'], ['YES', 1000, 'KXCPIYOY-26NOV']]);
});

test('lines are graded by edge for the setup side, best first, with held and new marks', () => {
  const markets = ladder();
  // Widen the NO asks below the centre so those lines carry edge, and leave one line one-sided.
  markets[3].no_ask_dollars = (Number(markets[3].no_ask_dollars) - 0.12).toFixed(4);
  markets[5].no_ask_dollars = (Number(markets[5].no_ask_dollars) - 0.04).toFixed(4);
  markets[8].yes_bid_dollars = '0.0000';
  // 10 contracts behind the NO ask on one line: under $50, so it grades Illiquid whatever its edge.
  markets[2].yes_bid_size_fp = '10.00';
  const held = [{ ticker: markets[5].ticker, side: 'NO', contracts: 300 }];
  const seen = new Map();
  const graded = gradeLines(shortRow, markets, { held, seen, now: NOW });
  assert.equal(graded.buy, 'NO');
  assert.equal(graded.lines[0].ticker, markets[3].ticker);
  assert.equal(graded.lines[0].strength, 'STRONG');
  assert.equal(graded.lines[0].isNew, true);
  const heldLine = graded.lines.find((line) => line.ticker === markets[5].ticker);
  assert.deepEqual(heldLine.held, { side: 'NO', contracts: 300 });
  const thin = graded.lines.find((line) => line.ticker === markets[2].ticker);
  assert.equal(thin.strength, 'ILLIQUID');
  assert.equal(thin.no.illiquid, true);
  assert.ok(thin.no.depth < 50);
  assert.equal(graded.illiquid, 1);
  assert.equal(graded.counts.ILLIQUID, 1);
  // Both sides are shown: the other side's edge is our complementary odds against its own ask.
  const top = graded.lines[0];
  assert.ok(Math.abs(top.no.edge - top.edge) < 1e-9);
  assert.ok(top.yes.ask > 0 && top.yes.edge < top.no.edge);
  // The one-sided line (no YES bid) is not priced at all.
  assert.equal(graded.lines.some((line) => line.ticker === markets[8].ticker), false);
  assert.equal(graded.closeTime, CLOSE);
  // Still Strong 40 minutes later: no longer new.
  const later = gradeLines(shortRow, markets, { held, seen, now: new Date(NOW.getTime() + 40 * 60_000) });
  assert.equal(later.lines[0].isNew, undefined);
});

test('no setup grades no lines', () => {
  assert.equal(gradeLines({ ...shortRow, setup: { side: null } }, ladder()), null);
});

test('held states: first match wins', () => {
  const markets = ladder();
  const line = (index, side = 'NO') => ({ ticker: markets[index].ticker, event: 'KXSILVERD-26NOV1317', side, contracts: 100, cost: 50 });
  const long = { ...shortRow, setup: { side: 'LONG' } };
  assert.equal(heldState(line(4), long, markets[4], { now: NOW }).state, 'CONTRADICTS');
  // Held NO on a line Kalshi has above 50%: through the line.
  const through = heldState(line(2), shortRow, markets[2], { now: NOW });
  assert.equal(through.state, 'THROUGH_LINE');
  assert.match(through.why, /^Kalshi has the held side at \d+%$/);
  // A bid above our odds: selling beats holding.
  const rich = { ...markets[6], no_bid_dollars: '0.9500' };
  assert.equal(heldState(line(6), shortRow, rich, { now: NOW }).state, 'EDGE_GONE');
  const lapsed = { ...shortRow, setup: { side: null, reason: 'Price not in the top third' }, position: 0.6 };
  const unshaded = heldState(line(6), lapsed, markets[6], { now: NOW });
  assert.deepEqual([unshaded.state, unshaded.why], ['SETUP_LAPSED', 'Price not in the top third']);
  const soon = { ...markets[6], close_time: '2026-11-13T19:00:00Z' };
  const closing = heldState(line(6), shortRow, soon, { now: NOW });
  assert.equal(closing.state, 'CLOSING');
  assert.equal(closing.why, 'Closes in 1.0 h');
  assert.equal(heldState(line(6), shortRow, markets[6], { now: NOW }).state, 'HOLD');
  // A one-sided book (98¢ YES bid, no offer) is still read: the held NO is all but lost.
  const decided = { ...markets[6], yes_bid_dollars: '0.9800', yes_ask_dollars: '1.0000', no_bid_dollars: '0.0000', no_ask_dollars: '0.0200' };
  const lost = heldState(line(6), { ...shortRow, setup: { side: null, reason: null } }, decided, { now: NOW });
  assert.equal(lost.state, 'THROUGH_LINE');
  assert.equal(lost.why, 'Kalshi has the held side at 1%');
  assert.equal(lost.bid, 0);
  // A line its event no longer lists as open is closed, whatever the gate says.
  const done = heldState(line(4), long, null, { now: NOW, closed: true });
  assert.deepEqual([done.state, done.tone, done.why], ['CLOSED', 'blue', 'Closed; awaiting settlement']);
  // CPI has no setup rule and never lapses.
  const cpi = { id: 'cpi', label: 'CPI YoY', group: 'inflation' };
  assert.equal(heldState({ ...line(6), side: 'NO' }, cpi, markets[6], { now: NOW }).state, 'HOLD');
});

test('book: at risk, sections, flags, and the board blocks', () => {
  const silver = ladder();
  const btc = ladder({ event: 'KXBTCD-26NOV1317', centre: 73000, sigma: 400 }).map((market, index) => ({
    ...market, ticker: `KXBTCD-26NOV1317-T${73000 + (index - 4) * 200}`, floor_strike: 73000 + (index - 4) * 200 }));
  const board = { rows: [
    shortRow,
    { id: 'bitcoin', label: 'Bitcoin', group: 'crypto', events: [{ eventTicker: 'KXBTCD-26NOV1317' }], tick: { direction: 'NEUTRAL' },
      trend: 'BULLISH', position: 0.2, trade: { direction: 'BULLISH' }, setup: { side: null, reason: null } },
    { id: 'gold', label: 'Gold', group: 'metals', events: [{ eventTicker: 'KXGOLDD-26NOV1317' }], tick: { direction: 'NEUTRAL' },
      trend: 'BULLISH', position: 0.44, setup: { side: null, reason: null } },
    { id: 'wti', label: 'WTI', group: 'oil', events: [], setup: { side: null, reason: null }, position: null },
    { id: 'cpi', label: 'CPI YoY', group: 'inflation', events: [] },
  ] };
  const positions = {
    market_positions: [
      { ticker: silver[6].ticker, position_fp: '-300', market_exposure_dollars: '90' },
      { ticker: btc[4].ticker, position_fp: '-200', market_exposure_dollars: '100' },
      { ticker: 'KXOTHER-26NOV13-T1', position_fp: '10', market_exposure_dollars: '5' },
    ],
    event_positions: [{ event_ticker: 'KXGOLDW-26NOV1317', realized_pnl_dollars: '147.53' }, { realized_pnl_dollars: '-95.09' }],
  };
  const marketsByEvent = new Map([['KXSILVERD-26NOV1317', silver], ['KXBTCD-26NOV1317', btc]]);
  applyLineMonitor(board, { balance: { balance_dollars: '1000', portfolio_value: 50000 }, positions, marketsByEvent,
    seen: new Map(), now: NOW });
  const [silverRow, btcRow, goldRow, wtiRow, cpiRow] = board.rows;
  // Shading, not the board's setup rule: Bitcoin's board setup is none but Trade and Trend are Bullish in the bottom third.
  assert.equal(silverRow.kalshiLines.shade, 'SHORT');
  assert.equal(silverRow.kalshiLines.lines.buy, 'NO');
  assert.equal(silverRow.kalshiLines.held.length, 1);
  assert.equal(btcRow.kalshiLines.shade, 'LONG');
  assert.equal(btcRow.kalshiLines.worst.state, 'CONTRADICTS');
  // The board row itself is untouched.
  assert.equal(btcRow.setup.side, null);
  assert.equal(goldRow.kalshiLines.shade, null);
  assert.equal(goldRow.kalshiLines.shadeReason, 'No Trade');
  // Summary: price, Kalshi's centre (from the ladder), best line, fillable lines, close.
  const summary = silverRow.kalshiLines.summary;
  assert.ok(Math.abs(summary.centre - 50) < 0.01);
  assert.equal(summary.position, 0.95);
  // Price is the market's own, never the instrument its range is read against.
  const composite = { ...shortRow, id: 'nasdaq100', price: { value: 27943 }, rangePrice: { value: 25136 } };
  assert.equal(marketMonitor(composite, {}).summary.price, 27943);
  assert.equal(summary.closeTime, CLOSE);
  assert.equal(summary.total, silverRow.kalshiLines.lines.total);
  assert.ok(summary.best === null || summary.best.side === 'NO');
  assert.equal(goldRow.kalshiLines.open, false);
  // Gold has no setup and no event read here: no lines, but the row is still listed with its reason.
  assert.equal(goldRow.kalshiLines.lines, undefined);
  assert.equal(wtiRow.kalshiLines.shadeReason, 'No range position');
  assert.equal(cpiRow.kalshiLines, undefined);
  const book = board.kalshiBook;
  assert.equal(book.account, 1500);
  assert.equal(book.atRisk, 195);
  assert.equal(book.maxPayout, 510);
  assert.equal(book.openLines, 3);
  assert.equal(book.flagged.red, 1);
  assert.equal(Math.round(book.realized * 100), 5244);
  assert.equal(book.unmapped.length, 1);
  assert.equal(book.sections.find((section) => section.id === 'other').atRisk, 5);
  assert.equal(book.sections.find((section) => section.id === 'metals').direction, 'SHORT');
  assert.match(book.flags[0].text, /^Bitcoin: Shaded long; line is held No; 1 line \(\$100\)\.$/);
  assert.equal(book.flags[0].tone, 'red');
  assert.ok(book.flags.some((flag) => /^Fri, Nov 13 closes hold 97% of risk \(\$190\)\.$/.test(flag.text)));
});

test('caps flag only once set', () => {
  const held = [{ ticker: 'KXSILVERW-1-T1', event: 'KXSILVERW-1', marketId: 'silver', market: 'Silver', side: 'NO', contracts: 10,
    cost: 400, direction: 'SHORT', state: 'HOLD', tone: 'none', closeTime: null }];
  const balance = { balance_dollars: '500', portfolio_value: 50000 };
  assert.equal(kalshiBook({ balance, positions: {}, held, monitors: [] }).flags.length, 0);
  const capped = kalshiBook({ balance, positions: {}, held, monitors: [],
    config: { edgeTiers: { strong: 5, good: 3, watch: 1 }, expirySharePct: 50, sectionCapPct: 25, bookCapPct: 30 } });
  assert.deepEqual(capped.flags.map((flag) => flag.text),
    ['At risk 40.0% of the account, over the 30% book cap.', 'Metals at 40.0% of the account, over the 25% section cap.']);
});

test('a market without a setup still lists its ladder, ungraded', () => {
  const markets = ladder();
  markets[0].yes_bid_dollars = '0.0000';
  const lines = ladderLines(markets);
  assert.equal(lines.side, null);
  assert.equal(lines.lines.length, 9);
  assert.deepEqual(lines.lines.map((line) => line.strike), [...lines.lines.map((line) => line.strike)].sort((a, b) => a - b));
  const centre = lines.lines[4];
  assert.equal(centre.subtitle, '$50 or above');
  assert.ok(Math.abs(centre.kalshiOdds - 0.5) < 1e-9);
  assert.ok(Math.abs(centre.sigmas) < 0.05);
  assert.equal(centre.strength, undefined);
  // No YES bid: no mid, so no odds and no edge on either side; nothing to take.
  assert.equal(lines.lines[0].better, null);
  assert.equal(lines.lines[0].illiquid, true);
  assert.equal(lines.illiquid, 1);
  assert.equal(lines.total, 9);
  assert.equal(ladderLines(null), null);
  // A long ladder keeps its 60 lines nearest even odds, in strike order.
  const long = ladderLines(Array.from({ length: 200 }, (_, index) => ({ ...markets[4], ticker: `L${index}`, floor_strike: index,
    yes_bid_dollars: (Math.max(0.01, 1 - index / 200) - 0.005).toFixed(4), yes_ask_dollars: (Math.max(0.01, 1 - index / 200) + 0.005).toFixed(4) })));
  assert.equal(long.lines.length, 60);
  assert.equal(long.total, 200);
  assert.ok(long.lines.every((line) => line.strike >= 70 && line.strike <= 130));
  // Through the board: a no-setup row with a read event gets its ladder and stays folded.
  const board = { rows: [{ ...shortRow, setup: { side: null, reason: null }, position: 0.5 }] };
  applyLineMonitor(board, { balance: null, positions: null, marketsByEvent: new Map([['KXSILVERD-26NOV1317', markets]]), seen: new Map(), now: NOW });
  assert.equal(board.rows[0].kalshiLines.lines.lines.length, 9);
  assert.equal(board.rows[0].kalshiLines.summary.fillable, 8);
  assert.ok(Math.abs(board.rows[0].kalshiLines.summary.centre - 50) < 0.01);
  assert.equal(board.rows[0].kalshiLines.open, false);
  assert.equal(board.kalshiBook, undefined);
});

test('side books: dollars at the ask decide liquidity; an unknown size is not held against a side', () => {
  const line = { yesAsk: 0.48, noAsk: 0.54, yesAskSize: 40, noAskSize: 500 };
  const yes = sideBook(line, 'YES', 0.5);
  assert.ok(Math.abs(yes.depth - 19.2) < 1e-9);
  assert.equal(yes.illiquid, true);
  const no = sideBook(line, 'NO', 0.5);
  assert.equal(no.depth, 270);
  assert.equal(no.illiquid, undefined);
  assert.ok(Math.abs(no.edge - (0.5 - 0.54 - 0.07 * 0.54 * 0.46)) < 1e-9);
  assert.equal(sideBook({ ...line, yesAskSize: null }, 'YES', 0.5).illiquid, undefined);
  assert.deepEqual(sideBook({ ...line, noAsk: null }, 'NO', 0.5), { ask: null, depth: null, edge: null, illiquid: true });
});

test('a ladder line marks the side with the better edge, illiquid when that side is thin', () => {
  const markets = ladder();
  // A wide NO ask makes YES the better side on two lines; the second has only 20 contracts at its YES ask.
  markets[4].no_ask_dollars = '0.6000';
  markets[4].yes_ask_size_fp = '200.00';
  markets[5].no_ask_dollars = '0.8000';
  markets[5].yes_ask_size_fp = '20.00';
  const lines = ladderLines(markets).lines;
  const even = lines.find((line) => line.ticker === markets[4].ticker);
  assert.equal(even.better, 'YES');
  assert.ok(even.yes.edge > even.no.edge);
  assert.equal(even.illiquid, undefined);
  const thin = lines.find((line) => line.ticker === markets[5].ticker);
  assert.equal(thin.better, 'YES');
  assert.equal(thin.illiquid, true);
});
