const test = require('node:test');
const assert = require('node:assert/strict');
const { zonedTimeToUtc } = require('date-fns-tz');
const { previousTradingDateKey } = require('../utils/usEquityMarketCalendar.cjs');
const { parseDailyChart, parseIntradayChart, mergeIntradayHistory, buildMarketDailySnapshot } = require('./marketDailyMetrics.cjs');

const DAY = '2026-09-22';
const NOW = Date.parse('2026-09-22T16:11:00Z');
const SECTORS = ['XLB', 'XLC', 'XLE', 'XLF', 'XLI', 'XLK', 'XLP', 'XLRE', 'XLU', 'XLV', 'XLY'];
const at = (date, time) => zonedTimeToUtc(`${date}T${time}`, 'America/New_York').getTime();
const options = (ticker = 'AAA', nowMs = NOW) => ({ ticker, nowMs });

function datesBefore(date, count) {
  const dates = [];
  let next = date;
  for (let i = 0; i < count; i += 1) { next = previousTradingDateKey(next); dates.unshift(next); }
  return dates;
}

function period(date, end = '16:00:00') {
  return { start: at(date, '09:30:00') / 1000, end: at(date, end) / 1000, timezone: 'EDT', gmtoffset: -14400 };
}

function dailyPayload({ ticker = 'AAA', date = DAY, price = 120, history = 270, observed = at(date, '12:10:00'), end = '16:00:00', open = 100 } = {}) {
  const dates = [...datesBefore(date, history), date];
  return { chart: { error: null, result: [{
    meta: { symbol: ticker, currency: 'USD', instrumentType: SECTORS.includes(ticker) ? 'ETF' : 'EQUITY',
      exchangeTimezoneName: 'America/New_York', regularMarketTime: observed / 1000, regularMarketPrice: price,
      dataGranularity: '1d', currentTradingPeriod: { regular: period(date, end) } },
    timestamp: dates.map(day => at(day, '09:30:00') / 1000),
    indicators: { quote: [{
      open: dates.map(day => day === date ? open : 100),
      high: dates.map(day => day === date ? Math.max(price, open) + 1 : 102),
      low: dates.map(day => day === date ? Math.min(price, open) - 1 : 98),
      close: dates.map(day => day === date ? price : 100),
      volume: dates.map(() => 10000),
    }] },
  }] } };
}

function intradayPayload({ ticker = 'AAA', date = DAY, price = 120, history = 45, observed = at(date, '12:10:00'), ratio = 3 } = {}) {
  const dates = [...datesBefore(date, history), date];
  const rows = dates.flatMap(day => Array.from({ length: 13 }, (_, i) => ({
    timestamp: (at(day, '09:30:00') + i * 30 * 60_000) / 1000,
    close: day === date ? price : 101,
    // The current unfinished bar has huge volume and must be excluded.
    volume: day === date ? i === 5 ? 99999 : 10 * ratio : 10,
  })));
  return { chart: { error: null, result: [{
    meta: { symbol: ticker, currency: 'USD', instrumentType: 'EQUITY', exchangeTimezoneName: 'America/New_York',
      regularMarketTime: observed / 1000, regularMarketPrice: price, dataGranularity: '30m',
      currentTradingPeriod: { regular: period(date) }, tradingPeriods: dates.map(day => [period(day)]) },
    timestamp: rows.map(row => row.timestamp),
    indicators: { quote: [{ open: rows.map(() => 100), high: rows.map(row => row.close + 1), low: rows.map(() => 99),
      close: rows.map(row => row.close), volume: rows.map(row => row.volume) }] },
  }] } };
}

function snapshotInput() {
  const members = [{ ticker: 'AAA', name: 'Alpha', weightPct: 60 }, { ticker: 'BBB', name: 'Beta', weightPct: 40 }];
  const dailyByTicker = new Map(members.map(member => [member.ticker, parseDailyChart(dailyPayload({ ticker: member.ticker, price: member.ticker === 'AAA' ? 120 : 98 }), options(member.ticker))]));
  const sectorDailyByTicker = new Map(SECTORS.map((ticker, i) => [ticker, {
    ...parseDailyChart(dailyPayload({ ticker, price: 95 + i }), options(ticker)), name: `${ticker} sector`,
  }]));
  return { members, dailyByTicker, sectorDailyByTicker, membershipAsOf: DAY, nowMs: NOW };
}

function rankedOutlierInput() {
  // Reverse ticker order makes tied rankings independent of membership order.
  const observations = [
    { ticker: 'EEE', price: 100.4, open: 100, ratio: 1.5 },
    { ticker: 'DDD', price: 104, open: 90, ratio: 3 },
    { ticker: 'CCC', price: 108, open: 95, ratio: 4 },
    { ticker: 'BBB', price: 110, open: 99, ratio: 5 },
    { ticker: 'AAA', price: 108, open: 98, ratio: 4 },
  ];
  return {
    ...snapshotInput(),
    members: observations.map(({ ticker }) => ({ ticker, name: `${ticker} security`, weightPct: 20 })),
    dailyByTicker: new Map(observations.map(row => [row.ticker, parseDailyChart(dailyPayload(row), options(row.ticker))])),
    intradayByTicker: new Map(observations.map(row => [row.ticker, parseIntradayChart(intradayPayload(row), options(row.ticker))])),
    sectorByTicker: new Map(observations.map(({ ticker }) => [ticker, { ticker: 'XLB', name: 'Materials' }])),
  };
}

function detailInput(returns) {
  const members = returns.map((changePercent, i) => ({ ticker: `A${String(i).padStart(2, '0')}`, name: `Security ${i}`, weightPct: 100 / returns.length }));
  return {
    ...snapshotInput(), members,
    dailyByTicker: new Map(members.map((member, i) => [member.ticker,
      parseDailyChart(dailyPayload({ ticker: member.ticker, price: 100 + returns[i] }), options(member.ticker))])),
  };
}

test('validates current Yahoo symbol, provenance, session and expiry without coercing nulls', () => {
  const payload = dailyPayload();
  const row = parseDailyChart(payload, options());
  assert.equal(row.status, 'delayed');
  assert.equal(row.previousClose, 100);
  assert.ok(Math.abs(row.changePercent - 20) < 1e-9);
  assert.equal(row.expiresAt, '2026-09-22T16:30:00.000Z');
  assert.equal(parseDailyChart(payload, options('BBB')), null);
  assert.equal(parseDailyChart(payload, { ...options(), sourceUrl: 'https://example.com/quote/AAA' }), null);
  assert.equal(parseDailyChart(payload, options('AAA', NOW + 21 * 60_000)), null);
  assert.equal(parseDailyChart(payload, options('AAA', NOW - 2 * 60_000)), null);
  for (const value of [null, 0, '', '120', NaN]) {
    const invalid = structuredClone(payload);
    invalid.chart.result[0].meta.regularMarketPrice = value;
    assert.equal(parseDailyChart(invalid, options()), null);
  }
});

test('rejects failed, disconnected, cached, mocked and seeded data anywhere in the response', () => {
  const patches = [{ offline: true }, { connected: false }, { refreshFailed: true }, { stale: true },
    { cacheOnly: true }, { cache_only: true }, { cached: true }, { fromCache: true }, { mock: true }, { seeded: true },
    { status: 'unavailable' }, { source: 'portfolio-derived' }, { provider: 'mock' }, { availability: 'offline' }, { dataType: 'seeded' }];
  for (const patch of patches) {
    const payload = dailyPayload();
    Object.assign(payload.chart.result[0].meta, patch);
    assert.equal(parseDailyChart(payload, options()), null, JSON.stringify(patch));
    const intraday = intradayPayload();
    Object.assign(intraday, patch);
    assert.equal(parseIntradayChart(intraday, options()), null, JSON.stringify(patch));
  }
  const payload = dailyPayload();
  payload.chart.error = { description: 'Failure' };
  assert.equal(parseDailyChart(payload, options()), null);
});

test('last close requires the correct completed session and the provider close evidence', () => {
  const nowMs = Date.parse('2026-09-22T21:00:00Z');
  const payload = dailyPayload({ observed: at(DAY, '16:00:00') });
  const row = parseDailyChart(payload, options('AAA', nowMs));
  assert.equal(row.status, 'last-close');
  assert.equal(row.marketDate, DAY);
  assert.equal(row.expiresAt, '2026-09-23T13:30:00.000Z');
  assert.equal(parseDailyChart(dailyPayload(), options('AAA', nowMs)), null);
  payload.chart.result[0].indicators.quote[0].close[payload.chart.result[0].timestamp.length - 1] = 110;
  assert.equal(parseDailyChart(payload, options('AAA', nowMs)), null);
});

test('uses an independently published regular close when Yahoo has not filled the final daily-bar close', () => {
  const nowMs = Date.parse('2026-09-23T02:45:00Z');
  const observed = at(DAY, '16:00:01');
  const payload = dailyPayload({ observed });
  const result = payload.chart.result[0];
  result.indicators.quote[0].close[result.timestamp.length - 1] = null;
  result.meta.fulldayPrice = 130;
  result.meta.postMarketPrice = 140;
  const row = parseDailyChart(payload, options('AAA', nowMs));
  assert.equal(row.status, 'last-close');
  assert.equal(row.price, 120);
  assert.equal(row.previousClose, 100);
  assert.equal(row.asOf, '2026-09-22T20:00:01.000Z');
  assert.equal(row.marketDate, DAY);
  assert.equal(row.source, 'Yahoo Finance');
  assert.equal(row.expiresAt, '2026-09-23T13:30:00.000Z');
  assert.equal(row.bars.at(-1).close, null);
  assert.ok(Math.abs(row.changePercent - 20) < 1e-9);
});

test('missing daily-bar close never promotes a pre-close quote or an invalid close to official last close', () => {
  const nowMs = Date.parse('2026-09-23T02:45:00Z');
  const beforeClose = dailyPayload({ observed: at(DAY, '15:59:45') });
  const result = beforeClose.chart.result[0];
  result.indicators.quote[0].close[result.timestamp.length - 1] = null;
  assert.equal(parseDailyChart(beforeClose, options('AAA', nowMs)), null);
  for (const invalidClose of [0, -1, '120', NaN]) {
    const payload = dailyPayload({ observed: at(DAY, '16:00:00') });
    const row = payload.chart.result[0];
    row.indicators.quote[0].close[row.timestamp.length - 1] = invalidClose;
    assert.equal(parseDailyChart(payload, options('AAA', nowMs)), null);
  }
});

test('nightly, preopen, weekend and holiday snapshots preserve missing daily cells and independently published regular-session fields', () => {
  const cases = [
    { date: DAY, now: '2026-09-23T02:45:00Z', expectedOpen: '2026-09-23T13:30:00.000Z' },
    { date: DAY, now: '2026-09-23T11:00:00Z', upcoming: '2026-09-23', expectedOpen: '2026-09-23T13:30:00.000Z' },
    { date: '2026-09-25', now: '2026-09-26T16:00:00Z', upcoming: '2026-09-28', expectedOpen: '2026-09-28T13:30:00.000Z' },
    { date: '2026-09-04', now: '2026-09-07T16:00:00Z', upcoming: '2026-09-08', expectedOpen: '2026-09-08T13:30:00.000Z' },
  ];
  for (const item of cases) {
    const payload = dailyPayload({ date: item.date, observed: at(item.date, '16:00:01') });
    const result = payload.chart.result[0];
    for (const field of ['open', 'high', 'low', 'close']) result.indicators.quote[0][field][result.timestamp.length - 1] = null;
    result.meta.regularMarketDayHigh = 125;
    result.meta.regularMarketDayLow = 97;
    if (item.upcoming) result.meta.currentTradingPeriod.regular = period(item.upcoming);
    const row = parseDailyChart(payload, options('AAA', Date.parse(item.now)));
    assert.equal(row.status, 'last-close', item.now);
    assert.equal(row.marketDate, item.date);
    assert.equal(row.price, 120);
    assert.equal(row.open, null);
    assert.equal(row.high, 125);
    assert.equal(row.low, 97);
    assert.equal(row.fieldSources.high, 'meta.regularMarketDayHigh');
    assert.equal(row.fieldSources.low, 'meta.regularMarketDayLow');
    assert.equal(row.bars.at(-1).high, null);
    assert.equal(row.bars.at(-1).low, null);
    assert.equal(row.expiresAt, item.expectedOpen);
  }
});

test('invalid or conflicting daily fields are withheld instead of silently replaced by metadata', () => {
  const payload = dailyPayload({ observed: at(DAY, '16:00:00') });
  const result = payload.chart.result[0];
  result.indicators.quote[0].high[result.timestamp.length - 1] = 0;
  result.meta.regularMarketDayHigh = 125;
  result.meta.regularMarketDayLow = 90;
  const row = parseDailyChart(payload, options('AAA', Date.parse('2026-09-23T02:45:00Z')));
  assert.equal(row.high, null);
  assert.equal(row.low, null);
  assert.equal(row.price, 120);
});

test('holiday and early-close handling use the shared calendar and provider period', () => {
  const holidayNow = Date.parse('2026-09-07T16:00:00Z');
  const friday = dailyPayload({ date: '2026-09-04', observed: at('2026-09-04', '16:00:00') });
  const holiday = parseDailyChart(friday, options('AAA', holidayNow));
  assert.equal(holiday.status, 'last-close');
  assert.equal(holiday.expiresAt, '2026-09-08T13:30:00.000Z');
  const invalidHoliday = dailyPayload({ date: '2026-09-07', observed: at('2026-09-07', '12:00:00') });
  assert.equal(parseDailyChart(invalidHoliday, options('AAA', holidayNow)), null);
  const earlyDate = '2026-11-27';
  const earlyNow = at(earlyDate, '13:30:00');
  const early = parseDailyChart(dailyPayload({ date: earlyDate, end: '13:00:00', observed: at(earlyDate, '13:00:00') }), options('AAA', earlyNow));
  assert.equal(early.status, 'last-close');
  assert.equal(early.sessionEnd, at(earlyDate, '13:00:00'));
  assert.equal(parseDailyChart(dailyPayload({ date: earlyDate, observed: at(earlyDate, '13:00:00') }), options('AAA', earlyNow)), null);
});

test('full coverage produces accurate breadth, ranked moves, sectors and explicitly labelled SPY contribution', () => {
  const snapshot = buildMarketDailySnapshot(snapshotInput());
  assert.equal(snapshot.status, 'available');
  assert.deepEqual(snapshot.coverage, { quotes: 2, total: 2, history50: 2, history200: 2, year: 2, intraday: 0, intradayVolume: 0, intradayGain: 0, sectorComparisons: 0, reversalComparisons: 2 });
  assert.equal(snapshot.breadth.advancing, 1);
  assert.equal(snapshot.breadth.declining, 1);
  assert.equal(snapshot.breadth.unchanged, 0);
  assert.equal(snapshot.breadth.above50Pct, 50);
  assert.equal(snapshot.breadth.above200Pct, 50);
  assert.equal(snapshot.breadth.newHighs, 1);
  assert.equal(snapshot.breadth.newLows, 1);
  assert.equal(snapshot.winners[0].ticker, 'AAA');
  assert.equal(snapshot.losers[0].ticker, 'BBB');
  assert.equal(snapshot.leadership.leadingSector.ticker, 'XLY');
  assert.equal(snapshot.leadership.laggingSector.ticker, 'XLB');
  assert.ok(Math.abs(snapshot.leadership.lift.contributionPp - 12) < 1e-9);
  assert.match(snapshot.leadership.lift.detail, /SPY holdings-weight contribution estimate/);
});

test('a single absent or failed quote never changes the breadth or movers denominator', () => {
  for (const replacement of [null, { ...snapshotInput().dailyByTicker.get('BBB'), offline: true }]) {
    const input = snapshotInput();
    input.dailyByTicker.set('BBB', replacement);
    const snapshot = buildMarketDailySnapshot(input);
    assert.equal(snapshot.status, 'partial');
    assert.equal(snapshot.coverage.total, 2);
    assert.equal(snapshot.coverage.quotes, 1);
    assert.equal(snapshot.breadth.advancing, null);
    assert.equal(snapshot.breadth.above50Pct, null);
    assert.deepEqual(snapshot.winners, []);
    assert.deepEqual(snapshot.losers, []);
    assert.equal(snapshot.leadership.lift, null);
    assert.ok(snapshot.leadership.leadingSector);
  }
});

test('expanded breadth shows inclusive one-percent moves and linearly interpolated quartiles of the complete roster', () => {
  const snapshot = buildMarketDailySnapshot(detailInput([-5, -2, -1, 0, 1, 2, 4, 8]));
  assert.equal(snapshot.breadth.upOnePercent, 4);
  assert.equal(snapshot.breadth.downOnePercent, 3);
  // Linear percentile position is (n - 1) * p: 1.75 and 5.25 here.
  assert.equal(snapshot.breadth.lowerQuartileReturn, -1.25);
  assert.equal(snapshot.breadth.upperQuartileReturn, 2.5);
  assert.equal(snapshot.breadth.medianReturn, 0.5);
  const one = buildMarketDailySnapshot(detailInput([2]));
  assert.equal(one.breadth.lowerQuartileReturn, 2);
  assert.equal(one.breadth.upperQuartileReturn, 2);
});

test('expanded movers and contributions rank both sides with bounded counts and deterministic ties', () => {
  const input = detailInput([6, 5, 4, 3, 2, 1, 0, -1, -2, -3, -4, -5, -6, 6, -6]);
  // Reverse the input order so ties cannot accidentally depend on membership order.
  input.members.reverse();
  const snapshot = buildMarketDailySnapshot(input);
  assert.deepEqual(snapshot.moverDetails.winners.map(row => row.ticker), ['A00', 'A13', 'A01', 'A02', 'A03']);
  assert.deepEqual(snapshot.moverDetails.losers.map(row => row.ticker), ['A12', 'A14', 'A11', 'A10', 'A09']);
  assert.deepEqual(snapshot.winners, snapshot.moverDetails.winners.slice(0, 3));
  assert.deepEqual(snapshot.losers, snapshot.moverDetails.losers.slice(0, 3));
  assert.deepEqual(snapshot.leadershipDetails.lifts.map(row => row.ticker), ['A00', 'A13']);
  assert.deepEqual(snapshot.leadershipDetails.drags.map(row => row.ticker), ['A12', 'A14']);
  assert.deepEqual(snapshot.leadership.lift, snapshot.leadershipDetails.lifts[0]);
  assert.deepEqual(snapshot.leadership.drag, snapshot.leadershipDetails.drags[0]);
  for (const row of [...snapshot.moverDetails.winners, ...snapshot.moverDetails.losers,
    ...snapshot.leadershipDetails.lifts, ...snapshot.leadershipDetails.drags]) {
    const quote = input.dailyByTicker.get(row.ticker);
    assert.equal(row.changePercent, quote.changePercent);
    for (const key of ['asOf', 'expiresAt', 'status', 'marketDate', 'source', 'sourceUrl']) assert.equal(row[key], quote[key]);
    assert.equal(row.delayedSource, true);
  }
  const onlyPositive = buildMarketDailySnapshot(detailInput([0, 2]));
  assert.equal(onlyPositive.moverDetails.winners.length, 1);
  assert.deepEqual(onlyPositive.moverDetails.losers, []);
  assert.equal(onlyPositive.leadershipDetails.lifts.length, 1);
  assert.deepEqual(onlyPositive.leadershipDetails.drags, []);
});

test('expanded leadership uses all eleven sectors and preserves each observation', () => {
  const input = snapshotInput();
  const snapshot = buildMarketDailySnapshot(input);
  assert.deepEqual(snapshot.leadershipDetails.leadingSectors.map(row => row.ticker), ['XLY', 'XLV']);
  assert.deepEqual(snapshot.leadershipDetails.laggingSectors.map(row => row.ticker), ['XLB', 'XLC']);
  assert.deepEqual(snapshot.leadershipDetails.sectorParticipation, { advancing: 5, declining: 5, unchanged: 1, total: 11 });
  assert.deepEqual(snapshot.leadership.leadingSector, snapshot.leadershipDetails.leadingSectors[0]);
  assert.deepEqual(snapshot.leadership.laggingSector, snapshot.leadershipDetails.laggingSectors[0]);
  for (const row of [...snapshot.leadershipDetails.leadingSectors, ...snapshot.leadershipDetails.laggingSectors]) {
    const quote = input.sectorDailyByTicker.get(row.ticker);
    assert.equal(row.name, quote.name);
    assert.equal(row.changePercent, quote.changePercent);
    for (const key of ['asOf', 'expiresAt', 'status', 'marketDate', 'source', 'sourceUrl']) assert.equal(row[key], quote[key]);
    assert.match(row.detail, /11-sector comparison/);
  }
  input.sectorDailyByTicker.get('XLY').changePercent = 4;
  input.sectorDailyByTicker.get('XLB').changePercent = -4;
  const tied = buildMarketDailySnapshot(input);
  assert.deepEqual(tied.leadershipDetails.leadingSectors.map(row => row.ticker), ['XLV', 'XLY']);
  assert.deepEqual(tied.leadershipDetails.laggingSectors.map(row => row.ticker), ['XLB', 'XLC']);
});

test('expanded details withhold incomplete, stale, offline, cached, mock and seeded evidence independently', () => {
  const patches = [null, { offline: true }, { stale: true }, { cacheOnly: true }, { mock: true }, { seeded: true },
    { expiresAt: new Date(NOW).toISOString() }];
  for (const patch of patches) {
    const input = snapshotInput();
    if (patch) Object.assign(input.dailyByTicker.get('BBB'), patch);
    else input.dailyByTicker.delete('BBB');
    const snapshot = buildMarketDailySnapshot(input);
    for (const key of ['upOnePercent', 'downOnePercent', 'lowerQuartileReturn', 'upperQuartileReturn']) assert.equal(snapshot.breadth[key], null);
    assert.deepEqual(snapshot.moverDetails, { winners: [], losers: [] });
    assert.deepEqual(snapshot.leadershipDetails.lifts, []);
    assert.deepEqual(snapshot.leadershipDetails.drags, []);
    assert.equal(snapshot.leadershipDetails.leadingSectors.length, 2);
    assert.equal(snapshot.leadershipDetails.sectorParticipation.total, 11);

    const sectorInput = snapshotInput();
    if (patch) Object.assign(sectorInput.sectorDailyByTicker.get('XLB'), patch);
    else sectorInput.sectorDailyByTicker.delete('XLB');
    const sectorSnapshot = buildMarketDailySnapshot(sectorInput);
    assert.deepEqual(sectorSnapshot.leadershipDetails.leadingSectors, []);
    assert.deepEqual(sectorSnapshot.leadershipDetails.laggingSectors, []);
    assert.equal(sectorSnapshot.leadershipDetails.sectorParticipation, null);
    assert.equal(sectorSnapshot.moverDetails.winners.length, 1);
    assert.equal(sectorSnapshot.leadershipDetails.lifts.length, 1);
  }
  const incoherent = snapshotInput();
  incoherent.sectorDailyByTicker.get('XLB').marketDate = '2026-09-21';
  const mixed = buildMarketDailySnapshot(incoherent);
  assert.deepEqual(mixed.leadershipDetails.leadingSectors, []);
  assert.deepEqual(mixed.leadershipDetails.laggingSectors, []);
  assert.equal(mixed.leadershipDetails.sectorParticipation, null);

  const invalidWeights = snapshotInput();
  invalidWeights.members[0].weightPct = null;
  const noContribution = buildMarketDailySnapshot(invalidWeights);
  assert.deepEqual(noContribution.leadershipDetails.lifts, []);
  assert.deepEqual(noContribution.leadershipDetails.drags, []);
  assert.equal(noContribution.moverDetails.winners.length, 1);
  for (const unavailable of [{}, { ...snapshotInput(), membershipAsOf: '2026-09-23' }, { ...snapshotInput(), nowMs: NOW + 20 * 60_000 }]) {
    const empty = buildMarketDailySnapshot(unavailable);
    assert.deepEqual(empty.moverDetails, { winners: [], losers: [] });
    assert.deepEqual(empty.leadershipDetails, { leadingSectors: [], laggingSectors: [], lifts: [], drags: [], sectorParticipation: null });
    for (const key of ['upOnePercent', 'downOnePercent', 'lowerQuartileReturn', 'upperQuartileReturn']) assert.equal(empty.breadth[key], null);
  }
});

test('short history preserves explicitly counted eligibility; genuine zero remains unchanged', () => {
  const input = snapshotInput();
  input.dailyByTicker.set('BBB', parseDailyChart(dailyPayload({ ticker: 'BBB', price: 100, history: 60 }), options('BBB')));
  const snapshot = buildMarketDailySnapshot(input);
  assert.equal(snapshot.coverage.quotes, 2);
  assert.equal(snapshot.breadth.unchanged, 1);
  assert.equal(snapshot.breadth.above50Pct, 50);
  assert.equal(snapshot.coverage.history200, 1);
  assert.equal(snapshot.breadth.above200Pct, 100);
  assert.equal(snapshot.coverage.year, 1);
  assert.equal(snapshot.breadth.newHighs, 1);
  assert.equal(snapshot.winners.length, 1);
  assert.equal(snapshot.losers.length, 0);
  const missing = dailyPayload({ ticker: 'BBB' });
  missing.chart.result[0].indicators.quote[0].close[missing.chart.result[0].timestamp.length - 2] = null;
  assert.equal(parseDailyChart(missing, options('BBB')), null);
  const gapInput = snapshotInput();
  const quote = gapInput.dailyByTicker.get('BBB');
  quote.bars.splice(quote.bars.length - 15, 1);
  const gapped = buildMarketDailySnapshot(gapInput);
  assert.equal(gapped.coverage.history50, 1);
  assert.equal(gapped.coverage.history200, 1);
  assert.equal(gapped.breadth.above50Pct, 100);
  assert.equal(gapped.breadth.above200Pct, 100);
});

test('future membership, duplicate identities and expired quotes are withheld', () => {
  assert.equal(buildMarketDailySnapshot({ ...snapshotInput(), membershipAsOf: '2026-09-23' }).status, 'unavailable');
  const duplicate = snapshotInput();
  duplicate.members.push({ ...duplicate.members[0] });
  assert.equal(buildMarketDailySnapshot(duplicate).status, 'unavailable');
  const expired = buildMarketDailySnapshot({ ...snapshotInput(), nowMs: NOW + 20 * 60_000 });
  assert.equal(expired.status, 'unavailable');
  assert.deepEqual(expired.winners, []);
});

test('dated issuer membership remains usable without changing the quote date, status or coverage', () => {
  const input = snapshotInput();
  input.membershipAsOf = '2026-09-18';
  const snapshot = buildMarketDailySnapshot(input);
  assert.equal(snapshot.status, 'available');
  assert.equal(snapshot.universe.asOf, '2026-09-18');
  assert.equal(snapshot.universe.count, 2);
  assert.equal(snapshot.coverage.quotes, 2);
  assert.equal(snapshot.marketDate, DAY);
  assert.equal(snapshot.quoteStatus, 'delayed');
  assert.equal(snapshot.asOf, '2026-09-22T16:10:00.000Z');
  assert.match(snapshot.leadership.lift.detail, /weights 2026-09-18/);
});

test('Thursday membership supports verified Friday closing observations over the weekend', () => {
  const date = '2026-09-25';
  const nowMs = Date.parse('2026-09-26T15:00:00Z');
  const input = snapshotInput();
  const quote = ticker => parseDailyChart(dailyPayload({ ticker, date, observed: at(date, '16:00:00') }), options(ticker, nowMs));
  input.dailyByTicker = new Map(input.members.map(({ ticker }) => [ticker, quote(ticker)]));
  input.sectorDailyByTicker = new Map(SECTORS.map(ticker => [ticker, quote(ticker)]));
  const snapshot = buildMarketDailySnapshot({ ...input, membershipAsOf: '2026-09-24', nowMs });
  assert.equal(snapshot.status, 'available');
  assert.equal(snapshot.universe.asOf, '2026-09-24');
  assert.equal(snapshot.marketDate, date);
  assert.equal(snapshot.quoteStatus, 'last-close');
  assert.equal(snapshot.asOf, '2026-09-25T20:00:00.000Z');
  assert.equal(snapshot.breadth.advancing, input.members.length);
});

test('same-time outliers use only completed 30-minute bars and explicitly disclose partial coverage', () => {
  const input = snapshotInput();
  input.intradayByTicker = new Map([['AAA', parseIntradayChart(intradayPayload(), options())]]);
  const snapshot = buildMarketDailySnapshot(input);
  assert.equal(snapshot.coverage.intraday, 1);
  assert.equal(snapshot.outliers.relativeVolume.ratio, 3);
  assert.equal(snapshot.outliers.relativeVolume.cutoff, '2026-09-22T16:00:00.000Z');
  assert.match(snapshot.outliers.relativeVolume.detail, /completed 30-minute bars/);
  assert.match(snapshot.outliers.relativeVolume.detail, /among 1 verified of 2 members/);
  assert.equal(snapshot.outliers.unusualGain.sessions, 40);
  assert.ok(Math.abs(snapshot.outliers.unusualGain.comparisonReturn - 20) < 1e-9);
  assert.equal(snapshot.outliers.unusualGain.changePercent, snapshot.outliers.unusualGain.comparisonReturn);
  assert.equal(snapshot.coverage.intradayVolume, 1);
  assert.equal(snapshot.coverage.intradayGain, 1);
  assert.deepEqual(snapshot.outlierDetails.relativeVolume, [snapshot.outliers.relativeVolume]);
  assert.deepEqual(snapshot.outlierDetails.unusualGain, [snapshot.outliers.unusualGain]);
  assert.deepEqual(snapshot.outlierDetails.reversal, []);
  assert.deepEqual(snapshot.outlierDetails.againstSector, []);
});

test('expanded outliers rank up to three qualifying observations per category with deterministic ties', () => {
  const snapshot = buildMarketDailySnapshot(rankedOutlierInput());
  const expected = {
    relativeVolume: ['BBB', 'AAA', 'CCC'],
    unusualGain: ['BBB', 'AAA', 'CCC'],
    reversal: ['DDD', 'CCC', 'BBB'],
    againstSector: ['BBB', 'AAA', 'CCC'],
  };
  for (const [key, tickers] of Object.entries(expected)) {
    const rows = snapshot.outlierDetails[key];
    assert.deepEqual(rows.map(row => row.ticker), tickers, key);
    assert.deepEqual(snapshot.outliers[key], rows[0], `${key} preserves the compact winner`);
    for (const row of rows) {
      assert.equal(row.source, 'Yahoo Finance');
      assert.equal(row.sourceUrl, `https://finance.yahoo.com/quote/${row.ticker}/history/`);
      assert.equal(row.asOf, '2026-09-22T16:10:00.000Z');
      assert.equal(row.marketDate, DAY);
      assert.equal(row.status, 'delayed');
      assert.equal(row.delayedSource, true);
      assert.match(row.detail, /among 5 verified of 5 members/);
    }
  }
  assert.deepEqual(snapshot.outlierDetails.relativeVolume.map(row => row.ratio), [5, 4, 4]);
  assert.equal(snapshot.outlierDetails.unusualGain[1].sessions, 40);
  assert.equal(snapshot.outlierDetails.unusualGain[1].cutoff, '2026-09-22T16:00:00.000Z');
  assert.equal(snapshot.outlierDetails.reversal[1].openingEvidence.field, 'daily.open');
  assert.equal(snapshot.outlierDetails.againstSector[1].sectorName, 'Materials');
});

test('expanded outliers do not fill missing qualifications or unavailable snapshots', () => {
  const input = rankedOutlierInput();
  input.members = input.members.filter(member => ['AAA', 'EEE'].includes(member.ticker));
  const snapshot = buildMarketDailySnapshot(input);
  for (const key of Object.keys(snapshot.outlierDetails)) {
    assert.deepEqual(snapshot.outlierDetails[key].map(row => row.ticker), ['AAA']);
    assert.match(snapshot.outlierDetails[key][0].detail, /among 2 verified of 2 members/);
  }
  for (const unavailable of [
    { ...input, membershipAsOf: '2026-09-23' },
    { ...input, nowMs: NOW + 20 * 60_000 },
  ]) {
    const empty = buildMarketDailySnapshot(unavailable);
    for (const key of Object.keys(empty.outlierDetails)) {
      assert.deepEqual(empty.outlierDetails[key], []);
      assert.equal(empty.outliers[key], null);
    }
  }
});

test('expanded outliers exclude rejected daily or comparison evidence without weakening quote validation', () => {
  const original = rankedOutlierInput();
  original.members = original.members.filter(member => ['AAA', 'EEE'].includes(member.ticker));
  const patches = [{ offline: true }, { stale: true }, { cacheOnly: true }, { mock: true }, { seeded: true },
    { expiresAt: new Date(NOW).toISOString() }];
  for (const patch of patches) {
    const dailyInput = structuredClone(original);
    Object.assign(dailyInput.dailyByTicker.get('AAA'), patch);
    const daily = buildMarketDailySnapshot(dailyInput);
    assert.equal(daily.coverage.quotes, 1);
    for (const key of Object.keys(daily.outlierDetails)) {
      assert.deepEqual(daily.outlierDetails[key], [], `${key}: ${JSON.stringify(patch)}`);
      assert.equal(daily.outliers[key], null);
    }
    const intradayInput = structuredClone(original);
    Object.assign(intradayInput.intradayByTicker.get('AAA'), patch);
    const intraday = buildMarketDailySnapshot(intradayInput);
    assert.deepEqual(intraday.outlierDetails.relativeVolume, []);
    assert.deepEqual(intraday.outlierDetails.unusualGain, []);
    assert.equal(intraday.outlierDetails.reversal[0].ticker, 'AAA');
    assert.equal(intraday.outlierDetails.againstSector[0].ticker, 'AAA');
  }
});

test('outliers withhold incomplete volume baselines, missing buckets and corporate-action reversals', () => {
  const input = snapshotInput();
  const intraday = parseIntradayChart(intradayPayload({ history: 19 }), options());
  input.intradayByTicker = new Map([['AAA', intraday]]);
  let snapshot = buildMarketDailySnapshot(input);
  assert.equal(snapshot.outliers.relativeVolume, null);
  assert.equal(snapshot.outliers.unusualGain, null);
  assert.equal(snapshot.coverage.intradayVolume, 0);
  assert.equal(snapshot.coverage.intradayGain, 0);
  const complete = parseIntradayChart(intradayPayload(), options());
  complete.bars = complete.bars.filter(bar => bar.timestamp !== at(DAY, '10:00:00'));
  input.intradayByTicker.set('AAA', complete);
  snapshot = buildMarketDailySnapshot(input);
  assert.equal(snapshot.coverage.intraday, 0);
  assert.equal(snapshot.outliers.relativeVolume, null);
  const reversal = dailyPayload({ open: 98 });
  reversal.chart.result[0].events = { dividends: { today: { date: at(DAY, '09:30:00') / 1000, amount: 1 } } };
  input.dailyByTicker.set('AAA', parseDailyChart(reversal, options()));
  input.intradayByTicker.set('AAA', parseIntradayChart(intradayPayload(), options()));
  snapshot = buildMarketDailySnapshot(input);
  assert.equal(snapshot.outliers.relativeVolume, null);
  assert.equal(snapshot.outliers.reversal, null);
});

test('gap reversals and opposite-sector moves are direct comparisons with their observed references', () => {
  const input = snapshotInput();
  input.dailyByTicker.set('AAA', parseDailyChart(dailyPayload({ open: 98 }), options()));
  input.sectorByTicker = new Map([['AAA', { ticker: 'XLB', name: 'Materials' }]]);
  const snapshot = buildMarketDailySnapshot(input);
  assert.equal(snapshot.outliers.reversal.ticker, 'AAA');
  assert.ok(Math.abs(snapshot.outliers.reversal.gapPercent + 2) < 1e-9);
  assert.equal(snapshot.outliers.againstSector.sectorName, 'Materials');
  assert.ok(Math.abs(snapshot.outliers.againstSector.sectorChangePercent + 5) < 1e-9);
});

test('merging retains historical evidence but cannot revive a failed or stale current response', () => {
  const history = parseIntradayChart(intradayPayload(), options());
  const current = parseIntradayChart(intradayPayload({ history: 0, price: 121 }), options());
  const merged = mergeIntradayHistory(history, current);
  assert.equal(merged.price, 121);
  assert.equal(merged.bars.filter(bar => bar.date === DAY).length, current.bars.length);
  assert.ok(merged.bars.some(bar => bar.date < DAY));
  assert.equal(mergeIntradayHistory(history, null), null);
  assert.equal(mergeIntradayHistory(history, { ...current, stale: true }), null);
});

test('used intraday evidence shortens the snapshot expiry and its return matches the compared bucket', () => {
  const input = snapshotInput();
  const payload = intradayPayload({ observed: at(DAY, '12:00:00'), price: 110 });
  input.intradayByTicker = new Map([['AAA', parseIntradayChart(payload, options())]]);
  const snapshot = buildMarketDailySnapshot(input);
  assert.equal(snapshot.expiresAt, '2026-09-22T16:20:00.000Z');
  assert.ok(Math.abs(snapshot.outliers.unusualGain.changePercent - 10) < 1e-9);
  assert.notEqual(snapshot.outliers.unusualGain.changePercent, snapshot.winners[0].changePercent);
});

test('merged intraday history is bounded to 61 sessions', () => {
  const history = parseIntradayChart(intradayPayload({ history: 80 }), options());
  const current = parseIntradayChart(intradayPayload({ history: 0 }), options());
  const merged = mergeIntradayHistory(history, current);
  assert.equal(new Set(merged.bars.map(bar => bar.date)).size, 61);
  assert.equal(merged.periods.length, 61);
});

test('a missing historical period is not silently replaced by an older session', () => {
  const input = snapshotInput();
  const intraday = parseIntradayChart(intradayPayload(), options());
  const missingDate = datesBefore(DAY, 10)[0];
  intraday.periods = intraday.periods.filter(item => item.date !== missingDate);
  input.intradayByTicker = new Map([['AAA', intraday]]);
  const snapshot = buildMarketDailySnapshot(input);
  assert.equal(snapshot.coverage.intradayVolume, 0);
  assert.equal(snapshot.coverage.intradayGain, 0);
  assert.equal(snapshot.outliers.relativeVolume, null);
  assert.equal(snapshot.outliers.unusualGain, null);
});

test('recent splits withhold comparisons with potentially incomparable intraday history', () => {
  const input = snapshotInput();
  const payload = dailyPayload();
  payload.chart.result[0].events = { splits: { recent: { date: at(datesBefore(DAY, 10)[0], '09:30:00') / 1000, numerator: 2, denominator: 1 } } };
  input.dailyByTicker.set('AAA', parseDailyChart(payload, options()));
  input.intradayByTicker = new Map([['AAA', parseIntradayChart(intradayPayload(), options())]]);
  const snapshot = buildMarketDailySnapshot(input);
  assert.equal(snapshot.coverage.quotes, 2);
  assert.equal(snapshot.winners[0].ticker, 'AAA');
  assert.equal(snapshot.coverage.intradayVolume, 0);
  assert.equal(snapshot.coverage.intradayGain, 0);
  assert.equal(snapshot.outliers.relativeVolume, null);
  assert.equal(snapshot.outliers.unusualGain, null);
});

test('sector and reversal coverage count only members with verified applicable comparison evidence', () => {
  const input = snapshotInput();
  input.dailyByTicker.set('AAA', parseDailyChart(dailyPayload({ open: 98 }), options()));
  input.dailyByTicker.get('BBB').open = null;
  input.sectorByTicker = new Map([['AAA', { ticker: 'XLB', name: 'Materials' }]]);
  let snapshot = buildMarketDailySnapshot(input);
  assert.equal(snapshot.coverage.quotes, 2);
  assert.equal(snapshot.coverage.sectorComparisons, 1);
  assert.equal(snapshot.coverage.reversalComparisons, 1);
  assert.match(snapshot.outliers.againstSector.detail, /among 1 verified of 2 members/);
  assert.match(snapshot.outliers.reversal.detail, /among 1 verified of 2 members/);
  input.sectorByTicker.set('BBB', 'XLF');
  input.sectorDailyByTicker.get('XLF').stale = true;
  snapshot = buildMarketDailySnapshot(input);
  assert.equal(snapshot.coverage.sectorComparisons, 1);
  input.dailyByTicker.get('AAA').corporateActionToday = true;
  snapshot = buildMarketDailySnapshot(input);
  assert.equal(snapshot.coverage.sectorComparisons, 0);
  assert.equal(snapshot.coverage.reversalComparisons, 0);
  assert.equal(snapshot.outliers.againstSector, null);
  assert.equal(snapshot.outliers.reversal, null);
});

test('a missing daily open can use the fresh first regular intraday bar with its original provenance', () => {
  const nowMs = Date.parse('2026-09-23T02:45:00Z');
  const input = snapshotInput();
  input.nowMs = nowMs;
  input.sectorDailyByTicker = new Map();
  for (const member of input.members) {
    const payload = dailyPayload({ ticker: member.ticker, price: member.ticker === 'AAA' ? 120 : 98, observed: at(DAY, '16:00:00') });
    const result = payload.chart.result[0];
    result.indicators.quote[0].open[result.timestamp.length - 1] = null;
    input.dailyByTicker.set(member.ticker, parseDailyChart(payload, options(member.ticker, nowMs)));
  }
  const payload = intradayPayload({ observed: at(DAY, '16:00:00') });
  const result = payload.chart.result[0];
  const firstIndex = result.timestamp.indexOf(at(DAY, '09:30:00') / 1000);
  result.indicators.quote[0].open[firstIndex] = 98;
  input.intradayByTicker = new Map([['AAA', parseIntradayChart(payload, options('AAA', nowMs))]]);
  let snapshot = buildMarketDailySnapshot(input);
  assert.equal(snapshot.coverage.reversalComparisons, 1);
  assert.equal(snapshot.outliers.reversal.ticker, 'AAA');
  assert.ok(Math.abs(snapshot.outliers.reversal.gapPercent + 2) < 1e-9);
  assert.equal(snapshot.outliers.reversal.openingEvidence.field, 'first regular-session bar.open');
  assert.equal(snapshot.outliers.reversal.openingEvidence.asOf, '2026-09-22T13:30:00.000Z');
  assert.match(snapshot.outliers.reversal.detail, /Opening evidence: first regular-session bar.open · Yahoo Finance/);
  assert.ok(snapshot.outliers.reversal.detail.includes(snapshot.outliers.reversal.openingEvidence.sourceUrl));
  assert.equal(input.dailyByTicker.get('AAA').open, null);
  input.intradayByTicker.get('AAA').stale = true;
  snapshot = buildMarketDailySnapshot(input);
  assert.equal(snapshot.coverage.reversalComparisons, 0);
  assert.equal(snapshot.outliers.reversal, null);
});

test('float32 historical-close noise does not create a false advance or decline', () => {
  const payload = dailyPayload({ price: 105.02 });
  const chart = payload.chart.result[0];
  chart.indicators.quote[0].close[chart.timestamp.length - 2] = 105.0199966430664;
  const flat = parseDailyChart(payload, options());
  assert.equal(flat.changePercent, 0);
  assert.equal(flat.previousClose, 105.0199966430664);
  chart.meta.regularMarketPrice = 105.03;
  assert.ok(parseDailyChart(payload, options()).changePercent > 0);
  chart.meta.regularMarketPrice = 105.01;
  assert.ok(parseDailyChart(payload, options()).changePercent < 0);
});
