const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { unavailableRetryMs } = require('../../../utils/unavailableRetryWindow.cjs');

// The three market-history caches live in server.js. Run the real functions
// against a clock this file controls and sources it can switch off.
const server = fs.readFileSync(path.resolve(__dirname, '../../../../server.js'), 'utf8');
const SECOND = 1_000;
const MINUTE = 60 * SECOND;

function startClock() {
  let now = Date.parse('2026-11-10T15:00:00Z');
  class ClockDate extends Date { static now() { return now; } }
  return { Date: ClockDate, advance(ms) { now += ms; } };
}

function load(clock, overrides = {}) {
  const names = ['getPeriodReturnsCached', 'getPublishedDailyClosesCached', 'getIntradayData'];
  const context = {
    Date: clock.Date,
    console: { log() {}, warn() {}, error() {} },
    setTimeout: () => ({ unref() {} }),
    unavailableRetryMs,
    instrumentCacheKey: (value) => (typeof value === 'string' ? value : value.symbol),
    periodReturnsCache: new Map(), PERIOD_RETURNS_CACHE_KEY_VERSION: 'test', PERIOD_RETURNS_CACHE_TTL: 15 * MINUTE,
    dailyClosesCache: new Map(), DAILY_CLOSES_CACHE_TTL: 60 * MINUTE,
    intradayCache: new Map(), intradayUnavailable: new Map(), INTRADAY_CACHE_TTL: 5 * MINUTE,
    getTickerMapping: () => ({ source: 'yahoo', ticker: '^TEST' }),
    symbolIsYahooRateProxy: () => false,
    normalizeCboeTreasuryYield: (value) => value,
    fetchTreasuryParDailyCloses: async () => null,
    fetchFredDailyClosesSeries: async () => null,
    ...overrides,
  };
  const functions = names.map((name) => server.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`))[0]);
  vm.runInNewContext(functions.join('\n'), context);
  return context;
}

// Advances to one second before `waitMs` has passed, checks that nothing was
// asked, then steps past it and checks that exactly one read was made.
async function expectNextReadAfter(clock, waitMs, read, reads) {
  const before = reads();
  clock.advance(waitMs - SECOND);
  await read();
  assert.equal(reads(), before, `asked again before ${waitMs / MINUTE} min had passed`);
  clock.advance(2 * SECOND);
  await read();
  assert.equal(reads(), before + 1, `not asked again after ${waitMs / MINUTE} min`);
}

test('an empty period result is asked for again after a minute, then less often, up to the normal cache time', async () => {
  const clock = startClock();
  let answer = null;
  let reads = 0;
  const context = load(clock, { computePeriodReturnsForSymbol: async () => { reads += 1; return answer; } });
  const read = () => context.getPeriodReturnsCached('SPX');

  assert.equal(await read(), null);
  assert.equal(reads, 1);
  for (const minutes of [1, 2, 4, 8, 15, 15]) {
    await expectNextReadAfter(clock, minutes * MINUTE, read, () => reads);
  }

  // A good answer is kept for the full cache time and ends the run of misses.
  answer = { weekChangePct: 1.25 };
  await expectNextReadAfter(clock, 15 * MINUTE, read, () => reads);
  assert.equal(await read(), answer);
  answer = null;
  await expectNextReadAfter(clock, 15 * MINUTE, read, () => reads);
  assert.equal(await read(), null);
  await expectNextReadAfter(clock, 1 * MINUTE, read, () => reads);
});

test('a failed daily-closes read is retried after a minute, and the series is then kept for the hour', async () => {
  const clock = startClock();
  const series = [{ t: 1, close: 100 }, { t: 2, close: 101 }];
  let failing = true;
  let reads = 0;
  const context = load(clock, {
    fetchYahooDailyClosesSeries: async () => {
      reads += 1;
      if (failing) throw new Error('getaddrinfo ENOTFOUND query1.finance.yahoo.com');
      return series;
    },
  });
  const read = () => context.getPublishedDailyClosesCached('SPX');

  assert.equal(await read(), null);
  clock.advance(59 * SECOND);
  assert.equal(await read(), null);
  assert.equal(reads, 1);

  failing = false;
  clock.advance(2 * SECOND);
  assert.equal(await read(), series);
  assert.equal(reads, 2);
  await expectNextReadAfter(clock, 60 * MINUTE, read, () => reads);
});

test('a source with no daily series is asked less and less often, and no more than once an hour', async () => {
  const clock = startClock();
  let reads = 0;
  const context = load(clock, { fetchYahooDailyClosesSeries: async () => { reads += 1; return null; } });
  const read = () => context.getPublishedDailyClosesCached('NOSERIES');

  assert.equal(await read(), null);
  for (const minutes of [1, 2, 4, 8, 16, 32, 60, 60]) {
    await expectNextReadAfter(clock, minutes * MINUTE, read, () => reads);
  }
});

test('a symbol with no intraday series is not requested on every poll', async () => {
  const clock = startClock();
  let requests = 0;
  let payload = { chart: { result: [{}] } };
  const context = load(clock, {
    axios: { get: async () => { requests += 1; return { data: payload }; } },
  });

  // Thirteen minutes of polls, one every 30 seconds.
  for (let poll = 0; poll <= 26; poll += 1) {
    assert.equal((await context.getIntradayData('CRB')).length, 0);
    clock.advance(30 * SECOND);
  }
  // Asked at 0, 1, 3, 7 and 12 minutes: the wait doubles and stops at the
  // five minutes a good series is kept. Before, every poll made a request.
  assert.equal(requests, 5);

  // Once the symbol has a series it is cached and the misses are forgotten.
  payload = { chart: { result: [{ timestamp: [1, 2, 3], indicators: { quote: [{ close: [10, null, 10.126] }] } }] } };
  clock.advance(5 * MINUTE);
  assert.deepEqual([...await context.getIntradayData('CRB')], [10, 10.13]);
  assert.equal(requests, 6);
  assert.equal(context.intradayUnavailable.size, 0);
  assert.deepEqual([...await context.getIntradayData('CRB')], [10, 10.13]);
  assert.equal(requests, 6);
});

test('an intraday request that times out is not repeated on the next poll', async () => {
  const clock = startClock();
  let requests = 0;
  const context = load(clock, {
    axios: { get: async () => { requests += 1; throw new Error('timeout of 5000ms exceeded'); } },
  });

  assert.equal((await context.getIntradayData('LINK')).length, 0);
  clock.advance(30 * SECOND);
  assert.equal((await context.getIntradayData('LINK')).length, 0);
  assert.equal(requests, 1);
  clock.advance(31 * SECOND);
  assert.equal((await context.getIntradayData('LINK')).length, 0);
  assert.equal(requests, 2);
  // Another symbol is unaffected.
  assert.equal((await context.getIntradayData('SPX')).length, 0);
  assert.equal(requests, 3);
});
