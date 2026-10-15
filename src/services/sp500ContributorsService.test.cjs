const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SOURCES, createSp500ContributorsService, parseIndexTopHoldings, parseHoldingIdentities,
  parseNasdaqMarketCap, parseNasdaqScreener, parseNasdaqQuote, parseNasdaqTime, publishedDateIsCurrent,
} = require('./sp500ContributorsService.cjs');

const NOW = Date.parse('2026-09-14T21:45:00Z');
const constituents = [
  ['NVIDIA Corporation', 'NVIDIA CORP', 'NVDA', 8.03],
  ['Apple Inc.', 'APPLE INC', 'AAPL', 7.41],
  ['Microsoft Corporation', 'MICROSOFT CORP', 'MSFT', 5.59],
  ['Amazon.com Inc.', 'AMAZON.COM INC', 'AMZN', 3.82],
  ['Alphabet Inc. Class A', 'ALPHABET INC CL A', 'GOOGL', 3.01],
  ['Broadcom Inc.', 'BROADCOM INC', 'AVGO', 2.60],
  ['Alphabet Inc. Class C', 'ALPHABET INC CL C', 'GOOG', 2.41],
  ['Meta Platforms Inc Class A', 'META PLATFORMS INC CLASS A', 'META', 2.16],
  ['Micron Technology Inc.', 'MICRON TECHNOLOGY INC', 'MU', 1.67],
  ['Tesla Inc.', 'TESLA INC', 'TSLA', 1.56],
];
const indexHtml = (rows = constituents, asOf = 'Sep 11 2026') => `
  <h3>Fund Top Holdings <span class="date">as of ${asOf}</span></h3>
  <table><tr><td>Not an index weight</td><td>99.99%</td></tr></table>
  <h3>Index Top Holdings <span class="date">as of ${asOf}</span></h3>
  <table><thead><tr><th>Name</th><th>Weight</th></tr></thead><tbody>
  ${rows.map(row => `<tr><td>${row[0]}</td><td>${row[3]}%</td></tr>`).join('')}
  </tbody></table>`;
const additionalMembers = [
  ['Berkshire Hathaway Inc. Class B', 'BERKSHIRE HATHAWAY INC CL B', 'BRK.B', 1.4],
  ['Eli Lilly and Company', 'ELI LILLY AND CO', 'LLY', 1.2],
  ['Netflix Inc.', 'NETFLIX INC', 'NFLX', 0.4],
];
const allMembers = (rows = constituents) => {
  const seen = new Set(rows.map(row => row[2]));
  const combined = [...rows, ...additionalMembers.filter(row => !seen.has(row[2]))];
  for (let i = combined.length; i < 503; i += 1) combined.push([`Test Member ${i}`, `TEST MEMBER ${i}`, `TST${i}`, 0.01]);
  return combined;
};
const workbook = (rows = constituents, asOf = '11-Sep-2026') => [{ sheet: 'holdings', data: [
  ['Holdings:', `As of ${asOf}`], ['Name', 'Ticker', 'Weight'],
  ...allMembers(rows).map(row => [row[1], row[2], 99]),
] }];
const caps = { NVDA: 5084136000000, AAPL: 4.8e12, GOOGL: 4.2e12, GOOG: 4.1e12, MSFT: 3.7e12, AMZN: 2.7e12,
  META: 1.7e12, AVGO: 1.6e12, TSLA: 1.4e12, 'BRK.B': 1.15e12, LLY: 1.07e12, MU: 1.05e12, NFLX: 4.5e11, SNOW: 1.17e11 };
const expectedTickers = ['NVDA', 'AAPL', 'GOOGL', 'MSFT', 'AMZN', 'META', 'AVGO', 'TSLA', 'BRK.B', 'LLY'];
const expectedWeights = [8.03, 7.41, 3.01, 5.59, 3.82, 2.16, 2.60, 1.56, null, null];
const screener = (rows = allMembers()) => ({ status: { rCode: 200 }, data: { rows: [
  ...rows.map(row => ({ symbol: row[2], name: row[0], marketCap: String(caps[row[2]] || 1e9) })),
  { symbol: 'SNOW', name: 'Snowflake', marketCap: String(caps.SNOW) },
] } });
const momoSnapshot = (tickers = ['NFLX', 'MSFT', 'AMZN', 'NVDA', 'SNOW', 'AAPL', 'GOOGL', 'TSLA', 'META']) => ({
  snapshotType: 'momo-tracker', date: '2026-09-14', meta: { stockCount: tickers.length },
  data: Object.fromEntries(tickers.map((ticker, index) => [ticker, { index, rangeStatus: 'available', buyTrade: 100, sellTrade: 120, upside: 10, downside: -10, trend: 'BULLISH' }])),
});
const summary = (ticker = 'NVDA') => ({
  status: { rCode: 200 }, data: { symbol: ticker, assetClass: 'STOCKS', summaryData: { MarketCap: { value: '5,084,136,000,000' } } },
});
const info = (ticker = 'NVDA') => ({
  status: { rCode: 200 }, data: { symbol: ticker, assetClass: 'STOCKS', marketStatus: 'After-Hours',
    primaryData: { lastSalePrice: '$212.26', percentageChange: '+0.62%', lastTradeTimestamp: 'Sep 14, 2026 5:44 PM ET', isRealTime: true },
    secondaryData: { lastSalePrice: '$210.96', percentageChange: '-3.36%', lastTradeTimestamp: 'Closed at Sep 14, 2026 4:00 PM ET', isRealTime: false },
  },
});
function response(value, type = 'json') {
  return { ok: true, status: 200, json: async () => value, text: async () => value, arrayBuffer: async () => new ArrayBuffer(type === 'xlsx' ? 1 : 0) };
}
function createHarness({ html = indexHtml(), identities = workbook(), universe = screener(), override, serviceOptions = {} } = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    const overridden = override && override(url);
    if (overridden) return overridden;
    if (url === SOURCES.index) return response(html, 'html');
    if (url === SOURCES.identities) return response(null, 'xlsx');
    if (url === SOURCES.screener) return response(universe);
    const ticker = url.match(/\/quote\/([^/]+)\//)?.[1];
    return response(url.includes('/summary?') ? summary(ticker) : info(ticker));
  };
  return { calls, service: createSp500ContributorsService({ fetchImpl, xlsxReader: async () => identities, now: () => NOW, onDiagnostic: () => {}, ...serviceOptions }) };
}

test('reads only published index weights, independently sorts, and preserves separate share classes', () => {
  const parsed = parseIndexTopHoldings(indexHtml([...constituents].reverse()));
  assert.equal(parsed.asOf, '2026-09-11');
  assert.deepEqual(parsed.rows.map(row => row.weightPct), constituents.map(row => row[3]));
  assert.equal(parsed.rows.filter(row => /Alphabet/.test(row.name)).length, 2);
  assert.equal(parseHoldingIdentities(workbook()).identities.get('ALPHABETCLASSC'), 'GOOG');
});

test('refuses fund-only, incomplete, duplicate, and malformed top ten data', () => {
  assert.throws(() => parseIndexTopHoldings(indexHtml().replace('Index Top Holdings', 'Fund Top Holdings')));
  assert.throws(() => parseIndexTopHoldings(indexHtml(constituents.slice(0, 9))));
  assert.throws(() => parseIndexTopHoldings(indexHtml([...constituents.slice(0, 9), constituents[0]])));
  assert.throws(() => parseIndexTopHoldings(indexHtml().replace('8.03%', 'unknown')));
  assert.throws(() => parseIndexTopHoldings(indexHtml().replace('8.03%', '0%')));
});

test('publication freshness permits one session of publication lag and uses holiday calendar', () => {
  assert.equal(publishedDateIsCurrent('2026-09-11', NOW), true);
  assert.equal(publishedDateIsCurrent('2026-09-14', NOW), true);
  assert.equal(publishedDateIsCurrent('2026-09-10', NOW), false);
  assert.equal(publishedDateIsCurrent('2026-09-15', NOW), false);
  assert.equal(publishedDateIsCurrent('2026-09-12', NOW), false);
  assert.equal(publishedDateIsCurrent('2026-09-04', Date.parse('2026-09-08T13:00:00Z')), true);
  assert.equal(publishedDateIsCurrent('2026-09-03', Date.parse('2026-09-08T13:00:00Z')), false);
  assert.equal(publishedDateIsCurrent('2026-09-10', Date.parse('2026-09-14T16:00:00Z')), false);
  assert.equal(publishedDateIsCurrent('2026-09-11', Date.parse('2026-09-14T16:00:00Z')), true);
});

test('Nasdaq ET timestamps use actual New York daylight-saving offsets', () => {
  assert.equal(parseNasdaqTime('Closed at Sep 14, 2026 4:00 PM ET'), '2026-09-14T20:00:00.000Z');
  assert.equal(parseNasdaqTime('Closed at Jan 12, 2026 4:00 PM ET'), '2026-01-12T21:00:00.000Z');
  assert.equal(parseNasdaqTime('Sep 14, 2026 99:00 PM ET'), null);
  assert.equal(parseNasdaqTime('unknown'), null);
});

test('keeps current-session official close and daily performance separate from after-hours moves', () => {
  const quote = parseNasdaqQuote(info(), 'NVDA', NOW);
  assert.deepEqual({ price: quote.price, changePercent: quote.changePercent, status: quote.status, asOf: quote.asOf, marketDate: quote.marketDate },
    { price: 210.96, changePercent: -3.36, status: 'last-close', asOf: '2026-09-14T20:00:00.000Z', marketDate: '2026-09-14' });
  const noOfficialClose = info();
  noOfficialClose.data.secondaryData.lastTradeTimestamp = 'Sep 14, 2026 4:00 PM ET';
  assert.equal(parseNasdaqQuote(noOfficialClose, 'NVDA', NOW), null);
});

test('rejects previous-day close when today has closed, and allows Friday close on weekend', () => {
  const old = info();
  old.data.secondaryData.lastTradeTimestamp = 'Closed at Sep 11, 2026 4:00 PM ET';
  assert.equal(parseNasdaqQuote(old, 'NVDA', NOW), null);
  old.data.marketStatus = 'Closed';
  assert.equal(parseNasdaqQuote(old, 'NVDA', Date.parse('2026-09-13T17:00:00Z')).marketDate, '2026-09-11');
});

test('accepts independently fresh intraday quotes and rejects old, future, and wrong-symbol quotes', () => {
  const opened = info();
  opened.data.marketStatus = 'Open';
  opened.data.primaryData.lastTradeTimestamp = 'Sep 14, 2026 12:00 PM ET';
  const current = Date.parse('2026-09-14T16:00:30Z');
  assert.equal(parseNasdaqQuote(opened, 'NVDA', current).status, 'live');
  assert.equal(parseNasdaqQuote(opened, 'NVDA', current + 30_000).status, 'live');
  assert.equal(parseNasdaqQuote(opened, 'NVDA', current + 30_001).status, 'delayed');
  assert.equal(parseNasdaqQuote(opened, 'NVDA', current + 2 * 60_000).status, 'delayed');
  assert.equal(parseNasdaqQuote(opened, 'NVDA', current + 21 * 60_000), null);
  assert.equal(parseNasdaqQuote(opened, 'NVDA', current - 2 * 60_000), null);
  assert.equal(parseNasdaqQuote(opened, 'NVDA', current - 35_000).status, 'live');
  assert.equal(parseNasdaqQuote(opened, 'NVDA', current - 35_001), null);
  assert.equal(parseNasdaqQuote(opened, 'AAPL', current), null);
});

test('company market cap carries retrieval provenance without inventing an observation time', () => {
  const cap = parseNasdaqMarketCap(summary(), 'NVDA', new Date(NOW).toISOString());
  assert.equal(cap.value, 5084136000000);
  assert.equal(cap.scope, 'company');
  assert.equal(cap.timestampKind, 'retrieved');
  assert.equal(cap.fetchedAt, '2026-09-14T21:45:00.000Z');
  assert.equal(cap.asOf, undefined);
  assert.equal(parseNasdaqMarketCap(summary(), 'AAPL', cap.fetchedAt), null);
  const missing = summary();
  missing.data.summaryData.MarketCap.value = 'N/A';
  assert.equal(parseNasdaqMarketCap(missing, 'NVDA', cap.fetchedAt), null);
});

for (const flag of ['mock', 'seeded', 'stale', 'cacheOnly', 'fromCache', 'refreshFailed', 'offline', 'disconnected', 'synthetic', 'fallback', 'modelOnly', 'portfolioDerived', 'inferred', 'costBasisDerived']) {
  test(`rejects ${flag} provider fundamentals and quotes`, () => {
    const cap = summary();
    cap.data[flag] = true;
    const quote = info();
    quote.data[flag] = true;
    assert.equal(parseNasdaqMarketCap(cap, 'NVDA', new Date(NOW).toISOString()), null);
    assert.equal(parseNasdaqQuote(quote, 'NVDA', NOW), null);
  });
}

test('rejects unusable provenance and freshness markers independently of provider success', () => {
  for (const [key, value] of [['warning', 'provider_offline'], ['freshness', 'stale'], ['provenance', 'synthetic'], ['source', 'fallback'], ['dataStatus', 'cache-only']]) {
    const cap = summary();
    cap.data[key] = value;
    const quote = info();
    quote.data[key] = value;
    assert.equal(parseNasdaqMarketCap(cap, 'NVDA', new Date(NOW).toISOString()), null);
    assert.equal(parseNasdaqQuote(quote, 'NVDA', NOW), null);
  }
});

test('ranks the entire verified S&P universe by company cap, preserving only independently published index weights', async () => {
  const { service, calls } = createHarness({ html: indexHtml([...constituents].reverse()) });
  const snapshot = await service.getSnapshot();
  assert.equal(snapshot.status, 'available');
  assert.deepEqual(snapshot.rows.map(row => row.ticker), expectedTickers);
  assert.deepEqual(snapshot.rows.map(row => row.weightPct), expectedWeights);
  assert.equal(snapshot.rows[0].marketCap.value, 5084136000000);
  assert.equal(snapshot.rows[0].quote.changePercent, -3.36);
  assert.equal(snapshot.rows[9].rank, 10);
  assert.equal(snapshot.ranking, 'company-market-cap');
  assert.equal(snapshot.membershipSourceUrl, SOURCES.identities);
  assert.equal(snapshot.membershipAsOf, '2026-09-11');
  assert.equal(calls.length, 13);
  assert.equal(calls.every(call => call.options.cache === 'no-store'), true);
  assert.equal(calls.every(call => call.options.headers['Accept-Encoding'] === 'identity'), true);
});

test('automatically appends every current MOMO addition in cap order with no fabricated index rank or weight', async () => {
  const { service, calls } = createHarness();
  const publication = momoSnapshot();
  const snapshot = await service.getSnapshot({ momoSnapshot: publication });
  assert.deepEqual(snapshot.supplementalRows.map(row => row.ticker), ['NFLX', 'SNOW']);
  const row = snapshot.supplementalRows[1];
  assert.equal(row.name, 'Snowflake');
  assert.equal(row.rank, undefined);
  assert.equal(row.weightPct, undefined);
  assert.equal(row.marketCap.value, caps.SNOW);
  assert.equal(row.marketCap.sourceUrl, 'https://www.nasdaq.com/market-activity/stocks/snow');
  assert.equal(row.quote.sourceUrl, 'https://www.nasdaq.com/market-activity/stocks/snow');
  assert.equal(row.quote.status, 'last-close');
  assert.equal(calls.filter(call => call.url.includes('/SNOW/')).length, 1);
  assert.equal(snapshot.momoPublicationDate, '2026-09-14');
  assert.equal(snapshot.momoSnapshot, publication);
  assert.equal(snapshot.momoStatus, 'available');
});

test('a new MOMO ticker appears and a removed one disappears on the next publication fetch', async () => {
  const { service } = createHarness();
  const first = await service.getSnapshot({ momoSnapshot: momoSnapshot() });
  assert.deepEqual(first.supplementalRows.map(row => row.ticker), ['NFLX', 'SNOW']);
  const changed = momoSnapshot(['MU', 'MSFT', 'AMZN', 'NVDA', 'AAPL', 'GOOGL', 'TSLA', 'META']);
  const second = await service.getSnapshot({ momoSnapshot: changed });
  assert.deepEqual(second.supplementalRows.map(row => row.ticker), ['MU']);
});

test('does not duplicate company aliases or supplemental symbols already in the largest ten', async () => {
  const { service } = createHarness();
  const snapshot = await service.getSnapshot({ momoSnapshot: momoSnapshot(['GOOG', 'MSFT', 'AMZN', 'NVDA', 'BRK.B', 'AAPL', 'GOOGL', 'TSLA', 'META']) });
  assert.deepEqual(snapshot.supplementalRows, []);
  assert.equal(snapshot.rows.filter(row => row.ticker === 'GOOGL').length, 1);
  assert.equal(snapshot.rows.some(row => row.ticker === 'GOOG'), false);
});

test('an uncovered MOMO share class keeps its own ticker and quote instead of inheriting a preferred class', async () => {
  const { service } = createHarness();
  const snapshot = await service.getSnapshot({ momoSnapshot: momoSnapshot(['FOX', 'MSFT', 'AMZN', 'NVDA', 'BRK.A', 'AAPL', 'GOOGL', 'TSLA', 'META']) });
  assert.deepEqual(snapshot.supplementalRows.map(row => row.ticker), ['FOX']);
  assert.equal(snapshot.supplementalRows[0].quote.sourceUrl, 'https://www.nasdaq.com/market-activity/stocks/fox');
});

test('missing, old, malformed or flagged MOMO reports cannot retain additions or leak raw evidence', async () => {
  const { service } = createHarness();
  await service.getSnapshot({ momoSnapshot: momoSnapshot() });
  for (const publication of [null, { ...momoSnapshot(), date: '2026-09-11' },
    { ...momoSnapshot(), contentComplete: false }, ...['offline', 'stale', 'mock', 'seeded', 'cacheOnly', 'fromCache', 'refreshFailed', 'synthetic', 'inferred', 'modelOnly', 'portfolioDerived'].map(flag => ({ ...momoSnapshot(), [flag]: true }))]) {
    const snapshot = await service.getSnapshot({ momoSnapshot: publication });
    assert.equal(snapshot.rows.length, 10);
    assert.deepEqual(snapshot.supplementalRows, []);
    assert.equal(snapshot.momoSnapshot, undefined);
    assert.equal(snapshot.momoPublicationDate, null);
  }
});

test('supplemental quote failure clears the quote without invalidating independently verified cap and top ten', async () => {
  let fail = false;
  const { service } = createHarness({ override: url => fail && url.includes('/SNOW/') ? { ok: false, status: 503 } : null });
  assert.equal((await service.getSnapshot({ momoSnapshot: momoSnapshot() })).supplementalRows[1].quote.price, 210.96);
  fail = true;
  const snapshot = await service.getSnapshot({ momoSnapshot: momoSnapshot() });
  assert.equal(snapshot.rows.length, 10);
  assert.equal(snapshot.supplementalRows[1].quote, null);
  assert.equal(snapshot.supplementalRows[1].marketCap.value, caps.SNOW);
});

test('newly larger company enters even when it is absent from published top ten index weights', async () => {
  const universe = screener();
  universe.data.rows.find(row => row.symbol === 'MU').marketCap = '2000000000000';
  const { service } = createHarness({ universe });
  const snapshot = await service.getSnapshot();
  assert.equal(snapshot.rows[5].ticker, 'MU');
  assert.equal(snapshot.rows.some(row => row.ticker === 'LLY'), false);
});

test('fills missing screener fundamentals from direct same-symbol Nasdaq summary without inventing values', async () => {
  const universe = screener();
  universe.data.rows.find(row => row.symbol === 'NVDA').marketCap = '';
  const { service, calls } = createHarness({ universe });
  const snapshot = await service.getSnapshot();
  assert.equal(snapshot.rows[0].marketCap.value, 5084136000000);
  assert.equal(calls.filter(call => call.url.includes('/summary?')).length, 1);
});

test('cannot claim top ten if any company fundamental is still unverified', async () => {
  const universe = screener();
  universe.data.rows.find(row => row.symbol === 'NVDA').marketCap = '';
  const { service } = createHarness({ universe, override: url => url.includes('/NVDA/summary?') ? response({ status: { rCode: 500 }, data: null }) : null });
  assert.equal((await service.getSnapshot()).status, 'unavailable');
});

test('source failure after success returns unavailable with no retained index rows', async () => {
  let fail = false;
  const { service } = createHarness({ override: url => fail && url === SOURCES.index ? { ok: false, status: 503 } : null });
  assert.equal((await service.getSnapshot()).status, 'available');
  fail = true;
  const unavailable = await service.getSnapshot();
  assert.equal(unavailable.status, 'unavailable');
  assert.deepEqual(unavailable.rows, []);
  assert.deepEqual(unavailable.supplementalRows, []);
});

test('stale publications and incomplete, unmapped or ambiguous membership produce no ranked rows', async () => {
  const stale = createHarness({ html: indexHtml(constituents, 'Sep 09 2026') });
  assert.deepEqual((await stale.service.getSnapshot()).rows, []);
  const missing = createHarness({ identities: workbook(constituents.slice(1)) });
  assert.deepEqual((await missing.service.getSnapshot()).rows, []);
  const incomplete = workbook();
  incomplete[0].data = incomplete[0].data.slice(0, 20);
  assert.deepEqual((await createHarness({ identities: incomplete }).service.getSnapshot()).rows, []);
  const ambiguous = workbook();
  ambiguous[0].data.push(['NVIDIA CORPORATION', 'NOTNVDA', 0]);
  assert.deepEqual((await createHarness({ identities: ambiguous }).service.getSnapshot()).rows, []);
});

test('concurrent equivalent publications share only active work; later requests fetch sources again', async () => {
  const { service, calls } = createHarness();
  const first = service.getSnapshot();
  assert.equal(first, service.getSnapshot());
  await first;
  assert.equal(calls.length, 13);
  await service.getSnapshot();
  assert.equal(calls.length, 26);
});

test('a publication arriving during an earlier request receives its own current roster', async () => {
  const { service } = createHarness();
  const first = service.getSnapshot();
  const second = service.getSnapshot({ momoSnapshot: momoSnapshot() });
  assert.notEqual(first, second);
  assert.deepEqual((await first).supplementalRows, []);
  assert.deepEqual((await second).supplementalRows.map(row => row.ticker), ['NFLX', 'SNOW']);
});

test('source timeout remains active while the response body is being read', async () => {
  let bodyAborted = false;
  const service = createSp500ContributorsService({
    now: () => NOW,
    timeoutMs: 10,
    onDiagnostic: () => {},
    xlsxReader: async () => workbook(),
    fetchImpl: async (url, { signal }) => url === SOURCES.index ? {
      ok: true,
      text: () => new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => { bodyAborted = true; reject(new Error('Aborted')); }, { once: true });
      }),
    } : response(null, 'xlsx'),
  });
  const snapshot = await service.getSnapshot();
  assert.equal(bodyAborted, true);
  assert.equal(snapshot.status, 'unavailable');
  assert.deepEqual(snapshot.rows, []);
});

test('fetch that ignores abort is bounded, reports its stage, and releases a later successful attempt', async () => {
  let hung = true;
  const diagnostics = [];
  const { service } = createHarness({
    override: url => hung && url === SOURCES.index ? new Promise(() => {}) : null,
    serviceOptions: { timeoutMs: 15, overallTimeoutMs: 100, onDiagnostic: diagnostic => diagnostics.push(diagnostic) },
  });
  const first = service.getSnapshot();
  assert.equal(service.getSnapshot(), first);
  assert.deepEqual((await first).rows, []);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].stage, 'index:fetch');
  assert.equal(diagnostics[0].code, 'SOURCE_TIMEOUT');
  assert.equal(diagnostics[0].sourceUrl, SOURCES.index);
  assert.ok(diagnostics[0].elapsedMs >= 10);
  hung = false;
  assert.equal((await service.getSnapshot()).status, 'available');
  assert.equal(diagnostics.length, 1);
});

test('hung workbook parsing is bounded even when it never observes an abort signal', async () => {
  const diagnostics = [];
  const { service } = createHarness({ serviceOptions: {
    timeoutMs: 15, overallTimeoutMs: 100,
    xlsxReader: async () => new Promise(() => {}),
    onDiagnostic: diagnostic => diagnostics.push(diagnostic),
  } });
  assert.equal((await service.getSnapshot()).status, 'unavailable');
  assert.equal(diagnostics[0].stage, 'identities:parse');
  assert.equal(diagnostics[0].code, 'SOURCE_TIMEOUT');
});

test('overall snapshot deadline releases inFlight and cancels unfinished source work', async () => {
  let hung = true;
  const diagnostics = [];
  const { service, calls } = createHarness({
    override: url => hung && url === SOURCES.index ? new Promise(() => {}) : null,
    serviceOptions: { timeoutMs: 1000, overallTimeoutMs: 15, onDiagnostic: diagnostic => diagnostics.push(diagnostic) },
  });
  assert.deepEqual((await service.getSnapshot()).rows, []);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].stage, 'snapshot:deadline');
  assert.equal(diagnostics[0].code, 'SNAPSHOT_TIMEOUT');
  assert.equal(calls[0].options.signal.aborted, true);
  hung = false;
  assert.equal((await service.getSnapshot()).status, 'available');
});

test('diagnostics distinguish HTTP, parsing, identity, and stale publication failures without source bodies', async () => {
  for (const [options, stage, code] of [
    [{ override: url => url === SOURCES.index ? { ok: false, status: 503 } : null }, 'index:fetch', 'HTTP_503'],
    [{ html: '<title>PRIVATE_UPSTREAM_BODY</title>' }, 'index:parse', 'INDEX_WEIGHTS_INVALID'],
    [{ html: indexHtml(constituents, 'Sep 09 2026') }, 'index:freshness', 'PUBLICATION_OUTDATED'],
    [{ identities: workbook(constituents.slice(1)) }, 'identities:match', 'CONSTITUENT_IDENTITY_UNVERIFIED'],
    [{ override: url => { if (url === SOURCES.index) throw new Error('PRIVATE_UPSTREAM_BODY'); return null; } }, 'index:fetch', 'SOURCE_READ_FAILED'],
  ]) {
    const diagnostics = [];
    const { service } = createHarness({ ...options, serviceOptions: { onDiagnostic: diagnostic => diagnostics.push(diagnostic) } });
    assert.equal((await service.getSnapshot()).status, 'unavailable');
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].stage, stage);
    assert.equal(diagnostics[0].code, code);
    assert.equal(JSON.stringify(diagnostics).includes('PRIVATE_UPSTREAM_BODY'), false);
  }
});

test('diagnostic callback errors cannot break an unavailable response', async () => {
  const { service } = createHarness({ html: 'invalid', serviceOptions: { onDiagnostic: () => { throw new Error('Logger unavailable'); } } });
  assert.equal((await service.getSnapshot()).status, 'unavailable');
});

test('one timed-out critical fetch retries with a new controller and keeps verified source provenance', async () => {
  let attempts = 0;
  const diagnostics = [];
  const { service, calls } = createHarness({
    override: url => url === SOURCES.index && ++attempts === 1 ? new Promise(() => {}) : null,
    serviceOptions: { timeoutMs: 15, overallTimeoutMs: 100, onDiagnostic: value => diagnostics.push(value) },
  });
  const result = await service.getSnapshot();
  const indexCalls = calls.filter(call => call.url === SOURCES.index);
  assert.equal(result.status, 'available');
  assert.equal(indexCalls.length, 2);
  assert.notEqual(indexCalls[0].options.signal, indexCalls[1].options.signal);
  assert.equal(indexCalls[0].options.signal.aborted, true);
  assert.equal(indexCalls[1].options.signal.aborted, false);
  assert.equal(result.sourceUrl, SOURCES.index);
  assert.equal(result.asOf, '2026-09-11');
  assert.deepEqual(result.rows.map(row => row.weightPct), expectedWeights);
  assert.deepEqual(diagnostics, []);
});

test('critical HTML body and identity fetch failures each get at most one transport retry', async () => {
  for (const target of [SOURCES.index, SOURCES.identities]) {
    let attempts = 0;
    const { service, calls } = createHarness({ override: url => {
      if (url !== target || ++attempts !== 1) return null;
      if (target === SOURCES.index) return { ok: true, text: async () => { throw new Error('Temporary body failure'); } };
      throw new Error('Temporary transport failure');
    } });
    assert.equal((await service.getSnapshot()).status, 'available');
    assert.equal(calls.filter(call => call.url === target).length, 2);
  }
});

test('persistent transport failure stops after two attempts and leaves no retained rows', async () => {
  const diagnostics = [];
  const { service, calls } = createHarness({
    override: url => { if (url === SOURCES.index) throw new Error('Transport failed'); return null; },
    serviceOptions: { onDiagnostic: value => diagnostics.push(value) },
  });
  assert.deepEqual((await service.getSnapshot()).rows, []);
  assert.equal(calls.filter(call => call.url === SOURCES.index).length, 2);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].code, 'SOURCE_READ_FAILED');
});

test('HTTP failures and invalid or outdated publications are final without retry', async () => {
  for (const options of [
    { override: url => url === SOURCES.index ? { ok: false, status: 404 } : null },
    { override: url => url === SOURCES.index ? { ok: false, status: 429 } : null },
    { override: url => url === SOURCES.index ? { ok: false, status: 503 } : null },
    { html: 'invalid provider HTML' },
    { html: indexHtml(constituents, 'Sep 09 2026') },
    { identities: workbook(constituents.slice(1)) },
  ]) {
    const { service, calls } = createHarness(options);
    assert.equal((await service.getSnapshot()).status, 'unavailable');
    assert.equal(calls.filter(call => call.url === SOURCES.index).length, 1);
    assert.equal(calls.filter(call => call.url === SOURCES.identities).length, 1);
  }
});

test('workbook parse errors are not mistaken for retryable transport failures', async () => {
  let parseAttempts = 0;
  const { service, calls } = createHarness({ serviceOptions: { xlsxReader: async () => {
    parseAttempts += 1;
    throw new Error('Invalid workbook');
  } } });
  assert.equal((await service.getSnapshot()).status, 'unavailable');
  assert.equal(parseAttempts, 1);
  assert.equal(calls.filter(call => call.url === SOURCES.identities).length, 1);
});

test('optional Nasdaq quote failures do not discard independently verified market cap ranks', async () => {
  const { service, calls } = createHarness({ override: url => {
    if (url.includes('/NVDA/info?')) throw new Error('Optional detail failed');
    return null;
  } });
  const result = await service.getSnapshot();
  assert.equal(result.status, 'available');
  assert.equal(result.rows[0].marketCap.value, caps.NVDA);
  assert.equal(result.rows[0].quote, null);
  assert.equal(calls.filter(call => call.url.includes('/NVDA/info?')).length, 1);
});

test('screener validation rejects duplicate symbols and stale, cached, mock or derived data', async () => {
  for (const flag of ['offline', 'disconnected', 'stale', 'seeded', 'mock', 'cacheOnly', 'fromCache', 'refreshFailed', 'modelOnly', 'portfolioDerived']) {
    const universe = screener();
    universe.data[flag] = true;
    assert.throws(() => parseNasdaqScreener(universe, new Date(NOW).toISOString()), flag);
    assert.deepEqual((await createHarness({ universe }).service.getSnapshot()).rows, [], flag);
  }
  const duplicate = screener();
  duplicate.data.rows.push(duplicate.data.rows[0]);
  assert.throws(() => parseNasdaqScreener(duplicate, new Date(NOW).toISOString()));
});

test('Nasdaq Berkshire slash alias identifies the same share class but class A cannot price class B', () => {
  assert.ok(parseNasdaqMarketCap(summary('BRK/B'), 'BRK.B', new Date(NOW).toISOString()));
  assert.ok(parseNasdaqQuote(info('BRK/B'), 'BRK.B', NOW));
  assert.equal(parseNasdaqMarketCap(summary('BRK/A'), 'BRK.B', new Date(NOW).toISOString()), null);
});


test('a fabricated MOMO row cannot enter the verified roster despite an otherwise complete publication', async () => {
  const publication = momoSnapshot();
  publication.data.SNOW.mock = true;
  const snapshot = await createHarness().service.getSnapshot({ momoSnapshot: publication });
  assert.equal(snapshot.momoStatus, 'unavailable');
  assert.deepEqual(snapshot.supplementalRows, []);
  assert.equal(snapshot.momoSnapshot, undefined);
});
