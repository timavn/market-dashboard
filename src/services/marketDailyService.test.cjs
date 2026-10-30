const test = require('node:test');
const assert = require('node:assert/strict');
const { createMarketDailyService, parseHoldingsWorkbook, chartUrl, holdingsUrl, SECTORS } = require('./marketDailyService.cjs');

const NOW = Date.parse('2026-09-22T17:00:00Z');
const members = Array.from({ length: 503 }, (_, index) => ({ ticker: `TST${index}`, name: `Security ${index}`, weightPct: 100 / 503 }));
const workbook = (ticker = 'SPY', asOf = '21-Sep-2026') => [{ sheet: 'holdings', data: [
  ['Holdings:', `As of ${asOf}`],
  ['Name', 'Ticker', 'Identifier', 'Weight'],
  ...(ticker === 'SPY' ? members : members.filter((row, index) => index % 11 === SECTORS.findIndex(sector => sector.ticker === ticker)))
    .map(row => [row.name, row.ticker, '123456789', row.weightPct]),
] }];

function harness(options = {}) {
  let clock = NOW;
  let fail = false;
  let invalidFlag = null;
  let marketDate = '2026-09-22';
  let active = 0;
  let maximum = 0;
  const calls = [];
  const built = [];
  const metrics = {
    parseDailyChart: (payload, { ticker }) => payload ? ({ ticker, marketDate, asOf: new Date(clock).toISOString(), expiresAt: new Date(clock + 20 * 60_000).toISOString() }) : null,
    parseIntradayChart: (payload, { ticker }) => payload ? ({ ticker, marketDate, value: payload.value }) : null,
    mergeIntradayHistory: (history, current) => current ? ({ ...current, merged: true }) : null,
    buildMarketDailySnapshot: input => {
      built.push(input);
      return { status: input.dailyByTicker.size === 503 ? 'available' : 'partial',
        count: input.dailyByTicker.size, intradayCount: input.intradayByTicker.size,
        asOf: new Date(clock).toISOString(), marketDate, source: 'State Street / Yahoo Finance', sourceUrl: holdingsUrl('SPY'),
        universe: { count: 503, asOf: input.membershipAsOf }, coverage: { quotes: input.dailyByTicker.size, total: 503 },
        breadth: { advancing: input.dailyByTicker.size === 503 ? 300 : null, declining: input.dailyByTicker.size === 503 ? 203 : null },
        winners: [], losers: [], leadership: {}, outliers: {},
        expiresAt: new Date(clock + 20 * 60_000).toISOString() };
    },
  };
  const fetchImpl = async (url, requestOptions) => {
    calls.push({ url, requestOptions });
    active += 1;
    maximum = Math.max(maximum, active);
    if (options.gate) await options.gate;
    if (options.firstChartGate && url.includes('/chart/') && calls.filter(call => call.url.includes('/chart/')).length === 1) await options.firstChartGate;
    await new Promise(resolve => setImmediate(resolve));
    active -= 1;
    if (fail && url.includes('/chart/')) throw new Error('Internal provider failure');
    const ticker = /holdings-daily-us-en-(\w+)\.xlsx/.exec(url)?.[1]?.toUpperCase();
    const payload = invalidFlag && url.includes('/chart/') ? { [invalidFlag]: true } : { value: calls.length };
    return { ok: true, arrayBuffer: async () => ticker, json: async () => payload };
  };
  const service = createMarketDailyService({ fetchImpl, xlsxReader: async ticker => workbook(ticker, marketDate === '2026-09-23' ? '22-Sep-2026' : '21-Sep-2026'),
    now: () => clock, concurrency: 3, metrics, referencePath: null, ...options.serviceOptions });
  return { service, calls, built, setClock: value => { clock = value; }, setFail: value => { fail = value; },
    setMarketDate: value => { marketDate = value; },
    setFlag: value => { invalidFlag = value; }, maximum: () => maximum };
}

test('uses the dated full equity roster, validates coverage, and excludes cash', () => {
  const book = workbook();
  book[0].data.push(['Cash', 'USD', '-', 0.01]);
  const parsed = parseHoldingsWorkbook(book, { ticker: 'SPY', nowMs: NOW });
  assert.equal(parsed.members.length, 503);
  assert.equal(parsed.asOf, '2026-09-21');
  assert.equal(parsed.sourceUrl, holdingsUrl('SPY'));
  assert.throws(() => parseHoldingsWorkbook(workbook('SPY', '23-Sep-2026'), { ticker: 'SPY', nowMs: NOW }));
  assert.equal(parseHoldingsWorkbook(workbook('SPY', '24-Sep-2026'), { ticker: 'SPY', nowMs: Date.parse('2026-09-26T17:00:00Z') }).asOf, '2026-09-24');
  const incomplete = workbook();
  incomplete[0].data.splice(-4);
  assert.throws(() => parseHoldingsWorkbook(incomplete, { ticker: 'SPY', nowMs: NOW }));
  const invalidWeight = workbook();
  invalidWeight[0].data[2][3] = 101;
  assert.throws(() => parseHoldingsWorkbook(invalidWeight, { ticker: 'SPY', nowMs: NOW }));
});

test('does not accept flagged or duplicate published memberships', () => {
  const duplicate = workbook();
  duplicate[0].data.push(duplicate[0].data[2]);
  assert.throws(() => parseHoldingsWorkbook(duplicate, { ticker: 'SPY', nowMs: NOW }));
  for (const flag of ['mock', 'seeded', 'stale', 'cacheOnly', 'offline']) {
    const book = workbook();
    book[0][flag] = true;
    assert.throws(() => parseHoldingsWorkbook(book, { ticker: 'SPY', nowMs: NOW }));
  }
});

test('sector mapping permits independently current publications and excludes short futures overlays', async () => {
  const h = harness({ serviceOptions: { xlsxReader: async ticker => {
    const book = workbook(ticker, ticker === 'XLF' ? '22-Sep-2026' : '21-Sep-2026');
    if (ticker !== 'SPY') book[0].data.push(['Sector future', 'IXAZ6', 'ADI394XV5', -0.00266]);
    return book;
  } } });
  await h.service.waitForRefresh();
  const mapping = h.built[0].sectorByTicker;
  assert.equal(mapping.size, 503);
  assert.equal(mapping.has('IXAZ6'), false);
  assert.equal(mapping.get('TST1').asOf, '2026-09-22');
  assert.equal(mapping.get('TST0').asOf, '2026-09-21');
  h.service.dispose();
});

test('returns immediately, coalesces refreshes, and bounds provider concurrency', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const h = harness({ gate });
  assert.deepEqual(h.service.getSnapshot(), { status: 'unavailable', loading: true });
  assert.deepEqual(h.service.getSnapshot(), { status: 'unavailable', loading: true });
  release();
  const snapshot = await h.service.waitForRefresh();
  assert.equal(snapshot.status, 'available');
  assert.equal(snapshot.count, 503);
  assert.equal(snapshot.intradayCount, 503);
  assert.equal(h.built.length, 1);
  assert.equal(h.built[0].sectorByTicker.size, 503);
  assert.ok(h.maximum() <= 3);
  assert.equal(h.calls.filter(call => call.url.includes('.xlsx')).length, 12);
  assert.ok(h.calls.every(call => call.requestOptions.cache === 'no-store'));
  h.service.dispose();
});

test('caches completed history only and requests new current bars for every refresh', async () => {
  const h = harness();
  await h.service.waitForRefresh();
  const firstCount = h.calls.length;
  h.setClock(NOW + 5 * 60_000);
  h.service.getSnapshot();
  const second = await h.service.waitForRefresh();
  const refreshedCalls = h.calls.slice(firstCount);
  assert.equal(second.count, 503);
  assert.equal(refreshedCalls.filter(call => call.url.includes('range=60d')).length, 0);
  assert.equal(refreshedCalls.filter(call => call.url.includes('range=1d&interval=30m')).length, 503);
  assert.equal(refreshedCalls.filter(call => call.url.includes('.xlsx')).length, 0);
  assert.ok([...h.built.at(-1).intradayByTicker.values()].every(value => value.merged));
  h.service.dispose();
});

test('failed provider reads preserve completed informational metrics without mixing cached constituent history', async () => {
  const h = harness();
  await h.service.waitForRefresh();
  h.setFail(true);
  h.setClock(NOW + 5 * 60_000);
  h.service.getSnapshot();
  const failed = await h.service.waitForRefresh();
  assert.equal(failed.count, 0);
  assert.equal(failed.intradayCount, 0);
  assert.equal(failed.breadth.advancing, 300);
  assert.equal(failed.retained, true);
  assert.equal(failed.asOf, new Date(NOW).toISOString());
  assert.equal(h.built.at(-1).sectorDailyByTicker.size, 0);
  h.service.dispose();
});

test('backfills complete prior-session bars when the market date changes', async () => {
  const h = harness();
  await h.service.waitForRefresh();
  const count = h.calls.length;
  h.setClock(Date.parse('2026-09-23T17:00:00Z'));
  h.setMarketDate('2026-09-23');
  h.service.getSnapshot();
  const next = await h.service.waitForRefresh();
  const requests = h.calls.slice(count);
  assert.equal(next.count, 503);
  assert.equal(requests.filter(call => call.url.includes('range=60d')).length, 503);
  assert.equal(requests.filter(call => call.url.includes('range=1d&interval=30m')).length, 0);
  assert.ok([...h.built.at(-1).intradayByTicker.values()].every(value => !value.merged));
  h.service.dispose();
});

test('a cancelled provider job cannot publish over a newer completed snapshot', async () => {
  let release;
  const firstChartGate = new Promise(resolve => { release = resolve; });
  const h = harness({ firstChartGate, serviceOptions: { concurrency: 1, overallTimeoutMs: 2_000, requestTimeoutMs: 10_000 } });
  const first = await h.service.waitForRefresh();
  assert.equal(first.status, 'unavailable');
  h.setClock(NOW + 5 * 60_000);
  h.service.getSnapshot();
  const second = await h.service.waitForRefresh();
  assert.equal(second.count, 503);
  assert.equal(h.built.length, 1);
  release();
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.built.length, 1);
  assert.deepEqual(h.service.getSnapshot(), second);
  h.service.dispose();
});

test('mock, stale, cache-only, seeded and offline chart inputs never enter a snapshot', async () => {
  for (const flag of ['mock', 'stale', 'cacheOnly', 'seeded', 'offline']) {
    const h = harness();
    h.setFlag(flag);
    const snapshot = await h.service.waitForRefresh();
    assert.equal(snapshot.count, 0, flag);
    assert.equal(snapshot.intradayCount, 0, flag);
    h.service.dispose();
  }
});

test('expiry marks the informational reading retained without changing its observation timestamp', async () => {
  const h = harness({ serviceOptions: { refreshMs: 60 * 60_000 } });
  const first = await h.service.waitForRefresh();
  const expiry = first.expiresAt;
  h.setClock(Date.parse(expiry));
  const retained = h.service.getSnapshot();
  assert.equal(retained.retained, true);
  assert.equal(retained.breadth.advancing, 300);
  assert.equal(retained.asOf, first.asOf);
  assert.equal(first.expiresAt, expiry);
  h.service.dispose();
});

test('bounds a stalled job, aborts requests, and hides transport details', async () => {
  const seenSignals = [];
  const service = createMarketDailyService({
    fetchImpl: async (url, { signal }) => { seenSignals.push(signal); return new Promise(() => {}); },
    metrics: {}, requestTimeoutMs: 10, overallTimeoutMs: 15,
    referencePath: null,
  });
  const result = await service.waitForRefresh();
  assert.equal(result.status, 'unavailable');
  assert.ok(seenSignals.every(signal => signal.aborted));
  service.dispose();
});

test('encodes share classes and keeps historical interval parameters explicit', () => {
  const url = new URL(chartUrl('BRK.B', '60d', '30m'));
  assert.equal(url.pathname, '/v8/finance/chart/BRK-B');
  assert.equal(url.searchParams.get('interval'), '30m');
  assert.equal(url.searchParams.get('includePrePost'), 'false');
  assert.equal(url.searchParams.get('events'), 'div,splits');
});
