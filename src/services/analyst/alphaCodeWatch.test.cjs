const test = require('node:test');
const assert = require('node:assert/strict');
const { alphaCodeLines, alphaCodeVerdict, brokenAlphaCodeLine, foldAlphaCodeWatch } = require('./alphaCodeWatch.cjs');

const board = {
  marketDate: '2026-11-02',
  research: { products: [{ key: 'early-look', label: 'Early Look', publishedAt: '2026-11-02T10:31:00Z', messageId: '1a18c949d0c80bdd' }] },
  rows: [
    { id: 'wti', research: { alphaCode: { trade: 97, trend: 91, product: 'early-look', productLabel: 'Early Look', excerpt: 'Oil’s (WTI) Alpha Code = 9791 (TRADE = $97, TREND = $91)' },
      findings: [{ kind: 'alphaCode', fit: 'proxy', instrument: 'USO', trade: 88, trend: 85, product: 'early-look', productLabel: 'Early Look', excerpt: 'USO Alpha Code = 88/85' }] } },
    { id: 'gold', research: { alphaCode: { trade: 4180, trend: 4120, product: 'early-look', productLabel: 'Early Look' }, findings: [] } },
    { id: 'ust10y', research: { alphaCode: { trade: 4.2, trend: 4.1, product: 'early-look', productLabel: 'Early Look' }, findings: [] } },
  ],
};
const at = time => new Date(`2026-11-02T${time}:00Z`);
const quote = (price, time) => ({ price, asOf: `2026-11-02T${time}:00Z` });

test('a market day’s lines are each Alpha Code’s Trade and Trend on the symbol quoted for it', () => {
  const lines = alphaCodeLines(board);
  assert.deepEqual(lines.map(line => [line.id, line.label, line.level]), [
    ['CL=F|trade', 'WTI', 97], ['CL=F|trend', 'WTI', 91], ['USO|trade', 'USO', 88], ['USO|trend', 'USO', 85]]);
  // Futures stand in for gold spot and yields have no intraday quote, so neither is watched.
  assert.equal(lines.some(line => ['gold', 'ust10y'].includes(line.market)), false);
  assert.deepEqual({ ...lines[0], excerpt: undefined }, { id: 'CL=F|trade', symbol: 'CL=F', label: 'WTI', market: 'wti', duration: 'trade', level: 97,
    approximate: false, product: 'early-look', productLabel: 'Early Look', publishedAt: '2026-11-02T10:31:00Z', messageId: '1a18c949d0c80bdd',
    excerpt: undefined, marketDate: '2026-11-02', reading: null });
});

test('each market line carries the call it was published with, even where the board already reads it Neutral', () => {
  const published = { ...board, rows: [{ ...board.rows[0], trade: { direction: 'NEUTRAL', date: '2026-11-02', source: 'Alpha Code 97' }, trend: 'BULLISH',
    range: { date: '2026-11-02' }, alphaBreaks: { trade: { published: { value: 'BULLISH', date: '2026-10-21', source: 'The Call' } } } }] };
  const lines = alphaCodeLines(published).filter(line => line.symbol === 'CL=F');
  assert.deepEqual(lines.map(line => line.reading), [{ value: 'BULLISH', date: '2026-10-21', source: 'The Call' },
    { value: 'BULLISH', date: '2026-11-02', source: 'Risk Ranges' }]);
  // ETF proxies carry no market call of their own here.
  assert.equal(alphaCodeLines(published).find(line => line.symbol === 'USO').reading, null);
});

test('a published call reads Neutral once the price crosses its line after it, and again holds once reclaimed', () => {
  const line = { id: 'CL=F|trade', symbol: 'CL=F', duration: 'trade', level: 97, side: 'below', since: '2026-11-02T16:22:35Z', breaks: [] };
  const watch = { lines: { [line.id]: line } };
  const call = { value: 'BULLISH', date: '2026-10-21' };
  assert.equal(brokenAlphaCodeLine(watch, 'CL=F', 'trade', call), line);
  assert.equal(alphaCodeVerdict(line, call), 'NEUTRAL');
  // A call published after the cross, or on the price's own side, stands.
  assert.equal(brokenAlphaCodeLine(watch, 'CL=F', 'trade', { value: 'BULLISH', at: Date.parse('2026-11-03T12:00:00Z') }), null);
  assert.equal(alphaCodeVerdict(line, { value: 'BEARISH', date: '2026-10-21' }), 'BEARISH');
  assert.equal(alphaCodeVerdict({ ...line, side: 'above' }, call), 'BULLISH');
  // Neutral or missing calls have nothing to break; a cross alone reads Neutral.
  assert.equal(brokenAlphaCodeLine(watch, 'CL=F', 'trade', { value: 'NEUTRAL', date: '2026-10-21' }), null);
  assert.equal(alphaCodeVerdict(line, null), null);
  assert.equal(alphaCodeVerdict({ ...line, breaks: [{ to: 'below' }] }, null), 'NEUTRAL');
});

test('the first clear price sets each line’s side; a cross past the band is a break, a touch is not', () => {
  const lines = alphaCodeLines(board).filter(line => line.symbol === 'CL=F');
  let { watch, changed } = foldAlphaCodeWatch(null, { marketDate: '2026-11-02', lines, prices: { 'CL=F': quote(97.7, '13:54') }, now: at('14:04') });
  assert.equal(changed, true);
  assert.deepEqual(Object.values(watch.lines).map(line => [line.duration, line.side, line.breaks.length]), [['trade', 'above', 0], ['trend', 'above', 0]]);
  // 96.95 sits inside the tenth-of-a-percent band around 97: not yet broken.
  ({ watch, changed } = foldAlphaCodeWatch(watch, { marketDate: '2026-11-02', lines, prices: { 'CL=F': quote(96.95, '14:20') }, now: at('14:30') }));
  assert.equal(changed, false);
  assert.equal(watch.lines['CL=F|trade'].side, 'above');
  ({ watch, changed } = foldAlphaCodeWatch(watch, { marketDate: '2026-11-02', lines, prices: { 'CL=F': quote(96.85, '14:40') }, now: at('14:50') }));
  assert.equal(changed, true);
  assert.deepEqual(watch.lines['CL=F|trade'].breaks, [{ from: 'above', to: 'below', price: 96.85, at: '2026-11-02T14:40:00Z' }]);
  assert.equal(watch.lines['CL=F|trade'].side, 'below');
  assert.equal(watch.lines['CL=F|trend'].breaks.length, 0);
  // Reclaiming the line is a second break the other way.
  ({ watch } = foldAlphaCodeWatch(watch, { marketDate: '2026-11-02', lines, prices: { 'CL=F': quote(97.3, '15:10') }, now: at('15:20') }));
  assert.deepEqual(watch.lines['CL=F|trade'].breaks.map(item => item.to), ['below', 'above']);
});

test('no price leaves the watch as it was, and a missing quote never sets a side', () => {
  const lines = alphaCodeLines(board);
  const { watch } = foldAlphaCodeWatch(null, { marketDate: '2026-11-02', lines, prices: { 'CL=F': quote(95, '14:00') }, now: at('14:00') });
  assert.equal(watch.lines['USO|trade'].side, null);
  assert.equal(watch.lines['CL=F|trade'].side, 'below');
  assert.equal(foldAlphaCodeWatch(watch, { marketDate: '2026-11-02', lines, prices: {}, now: at('14:30') }).changed, false);
});

test('a new morning carries an unreplaced line one more session, resets a reprinted line’s breaks, and restarts a moved one', () => {
  const lines = alphaCodeLines(board);
  let { watch } = foldAlphaCodeWatch(null, { marketDate: '2026-11-02', lines, prices: { 'CL=F': quote(98, '14:00'), USO: quote(90, '14:00') }, now: at('14:00') });
  ({ watch } = foldAlphaCodeWatch(watch, { marketDate: '2026-11-02', lines, prices: { 'CL=F': quote(96, '15:00') }, now: at('15:00') }));
  const next = [{ ...lines[0], marketDate: '2026-11-03' }, { ...lines[1], level: 93, marketDate: '2026-11-03' }];
  ({ watch } = foldAlphaCodeWatch(watch, { marketDate: '2026-11-03', lines: next, prices: {}, now: new Date('2026-11-03T11:00:00Z') }));
  assert.deepEqual([watch.lines['CL=F|trade'].side, watch.lines['CL=F|trade'].breaks.length], ['below', 0]);
  assert.deepEqual([watch.lines['CL=F|trend'].level, watch.lines['CL=F|trend'].side], [93, null]);
  assert.equal(watch.lines['USO|trade'].marketDate, '2026-11-02');
  // A day later the carried line is dropped.
  ({ watch } = foldAlphaCodeWatch(watch, { marketDate: '2026-11-04', lines: [], prices: {}, now: new Date('2026-11-04T11:00:00Z') }));
  assert.deepEqual(Object.keys(watch.lines).sort(), ['CL=F|trade', 'CL=F|trend']);
});

test('a line can carry its own band, and a transient line is not kept into the next session', () => {
  const vix = { id: '^VIX|19', symbol: '^VIX', duration: 'vix', level: 19, band: 0.01, marketDate: '2026-11-04', retain: false };
  let { watch } = foldAlphaCodeWatch(null, { marketDate: '2026-11-04', lines: [vix], prices: { '^VIX': { price: 18.5 } } });
  // 19.1 is within the 1% band, so the line holds; 19.3 clears it.
  ({ watch } = foldAlphaCodeWatch(watch, { marketDate: '2026-11-04', lines: [vix], prices: { '^VIX': { price: 19.1 } } }));
  assert.equal(watch.lines['^VIX|19'].side, 'below');
  ({ watch } = foldAlphaCodeWatch(watch, { marketDate: '2026-11-04', lines: [vix], prices: { '^VIX': { price: 19.3 } } }));
  assert.equal(watch.lines['^VIX|19'].breaks.length, 1);
  assert.equal(foldAlphaCodeWatch(watch, { marketDate: '2026-11-05', lines: [], prices: {} }).watch.lines['^VIX|19'], undefined);
});

test('the regime is part of what makes a watch worth saving', () => {
  const { watch } = foldAlphaCodeWatch(null, { marketDate: '2026-11-04', lines: [], regime: { date: '2026-11-04', changes: [] } });
  assert.equal(foldAlphaCodeWatch(watch, { marketDate: '2026-11-04', lines: [], regime: { date: '2026-11-04', changes: [] } }).changed, false);
  assert.equal(foldAlphaCodeWatch(watch, { marketDate: '2026-11-04', lines: [], regime: { date: '2026-11-05', changes: [] } }).changed, true);
});
