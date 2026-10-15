const test = require('node:test');
const assert = require('node:assert/strict');
const { createPcaDataSource, sessionDates, alignedValues, transformPair } = require('./pcaData.cjs');
const { ETF_REFERENCES, PCA_REFERENCES } = require('./pcaCatalog.cjs');

const NOW = new Date('2026-09-15T22:30:00Z');
const SESSION = '2026-09-15';
const WINDOW = 63;
const PRICE_DATES = sessionDates(SESSION, WINDOW);
const DATES = PRICE_DATES.slice(1);
function holding(symbol = 'AAA', overrides = {}) {
  return { symbol, conid: symbol === 'AAA' ? 100 : 200, description: `${symbol} security`, accountId: 'U1',
    secType: 'STK', currency: 'USD', quantity: 10, positionSource: 'ibkr_live_session',
    referenceClose: 100, referenceCloseSource: 'ibkr_historical_daily_close',
    referenceCloseSessionDate: SESSION, referenceCloseObservedAt: `${SESSION}T20:16:00Z`,
    ...overrides };
}
function portfolio(overrides = {}) {
  return { dataSource: 'ibkr_api', liveSessionVerified: true, fromCache: false, accountId: 'U1',
    fetchedAt: NOW.toISOString(), socketVerifiedAt: NOW.toISOString(),
    accountSummary: { accountId: 'U1', source: 'ibkr_live_session', currency: 'USD', netLiquidation: 100000,
      lastUpdated: NOW.toISOString(), socketVerifiedAt: NOW.toISOString() },
    dataQuality: { status: 'stale', markState: 'reference' }, holdings: [holding()], ...overrides };
}
function yahoo(symbol, overrides = {}) {
  const fx = symbol.endsWith('=X');
  const rows = PRICE_DATES.map((date, i) => ({ date, adjusted: 100 + i + (i % 3), raw: 1000 + i }));
  return { chart: { result: [{ meta: { symbol, currency: symbol === 'JPY=X' ? 'JPY' : 'USD',
    instrumentType: fx ? 'CURRENCY' : 'ETF', dataGranularity: '1d', exchangeTimezoneName: 'America/New_York',
    currentTradingPeriod: { regular: { start: Date.parse(`${SESSION}T13:30:00Z`) / 1000, end: Date.parse(`${SESSION}T20:00:00Z`) / 1000 } } },
    timestamp: rows.map(row => Date.parse(`${row.date}T20:00:00Z`) / 1000),
    indicators: { quote: [{ close: rows.map(row => row.raw) }], adjclose: [{ adjclose: rows.map(row => row.adjusted) }] },
    events: { dividends: { old: { date: 1, amount: 0.2 } } }, ...overrides }] } };
}
function client({ mutateYahoo, fail, fredMissing = false } = {}) {
  const calls = [];
  return { calls, async get(url, options) {
    calls.push({ url, options });
    if (fail?.(url)) { const error = new Error('secret upstream error'); error.code = 'ECONNRESET'; throw error; }
    if (url.includes('finance.yahoo.com')) {
      const symbol = decodeURIComponent(url.split('/').at(-1));
      const data = yahoo(symbol); mutateYahoo?.(data, symbol);
      return { data };
    }
    if (url.includes('fredgraph.csv')) {
      return { data: `observation_date,${options.params.id}\n${PRICE_DATES.map((date, i) => `${date},${fredMissing && i === 2 ? '.' : 4 + i / 100}`).join('\n')}` };
    }
    if (url.includes('/fred/series/observations')) {
      return { data: { observations: PRICE_DATES.map((date, i) => ({ date, value: String(4 + i / 100) })) } };
    }
    if (url.includes('cboe.com')) {
      return { data: `DATE,OPEN,HIGH,LOW,CLOSE\n${PRICE_DATES.map((date, i) => `${date.slice(5, 7)}/${date.slice(8)}/${date.slice(0, 4)},1,1,1,${20 + i}`).join('\n')}` };
    }
    throw new Error('Unexpected HTTP request');
  } };
}
function source(book = portfolio(), http = client(), options = {}) {
  return createPcaDataSource({ getPortfolioSnapshot: async () => book, httpClient: http, now: () => NOW, fredApiKey: '', ...options });
}
const capture = data => data.capture({ account: 'U1', window: WINDOW, sessionDate: SESSION });

test('catalog provides 35 distinct traded references and nine typed interpretation series', () => {
  assert.equal(ETF_REFERENCES.length, 35);
  assert.equal(PCA_REFERENCES.length, 44);
  assert.equal(new Set(PCA_REFERENCES.map(row => row.id)).size, 44);
  assert.deepEqual([...new Set(PCA_REFERENCES.map(row => row.group))].sort(), ['Commodities', 'Credit', 'Equities', 'FX', 'Rates', 'Sectors', 'Volatility']);
});

test('captures signed official-close weights and own adjusted histories with reproducible evidence', async () => {
  const book = portfolio({ holdings: [holding('AAA'), holding('BBB', { quantity: -5, referenceClose: 200, price: 9999, marketValue: 800000, avgCost: 3 })] });
  const before = JSON.stringify(book); const http = client();
  const result = await capture(source(book, http));
  assert.deepEqual(result.assets.map(row => [row.id, row.weight]), [['AAA', 0.01], ['BBB', -0.01]]);
  assert.equal(result.assets[0].returns[0], 102 / 100 - 1);
  assert.deepEqual(result.dates, DATES);
  assert.equal(result.references.length, 44);
  assert.deepEqual(result.coverage, { scope: 'equities-etfs', holdingCount: 2, modeledCount: 2, excluded: [], outOfScope: [], modeledGrossWeight: 0.02, totalGrossWeight: 0.02, complete: true });
  assert.equal(result.provenance.executable, false);
  assert.match(result.provenance.inputHash, /^[a-f0-9]{64}$/);
  const evidence = result.evidence.histories.find(row => row.symbol === 'AAA');
  assert.equal(evidence.corporateActions.dividends.old.amount, 0.2);
  assert.equal(evidence.levels.length, 64);
  assert.equal(evidence.fetchedAt, NOW.toISOString());
  assert.equal(JSON.stringify(book), before);
  assert(http.calls.every(call => call.options.timeout === 6000));
});

for (const [label, mutate] of [
  ['offline', p => { p.connected = false; }],
  ['cached', p => { p.fromCache = true; }],
  ['cache-only', p => { p.cacheOnly = true; }],
  ['mock', p => { p.mock = true; }],
  ['seeded', p => { p.seeded = true; }],
  ['stale', p => { p.stale = true; }],
  ['unverified session', p => { p.liveSessionVerified = false; }],
  ['failed refresh', p => { p.error = 'failed'; }],
  ['stale positions', p => { p.fetchedAt = '2020-01-01'; }],
  ['stale NAV', p => { p.accountSummary.lastUpdated = '2020-01-01'; }],
  ['unverified NAV', p => { p.accountSummary.source = 'uploaded_statement'; }],
  ['missing NAV', p => { p.accountSummary.netLiquidation = null; }],
  ['account mismatch', p => { p.accountSummary.accountId = 'U2'; }],
  ['non-USD account', p => { p.accountSummary.currency = 'EUR'; }],
]) test(`rejects ${label} without fetching history`, async () => {
  const book = portfolio(); mutate(book); const http = client();
  await assert.rejects(capture(source(book, http)), error => error.name === 'PcaDataError');
  assert.equal(http.calls.length, 0);
});

for (const [label, overrides, expected] of [
  ['stale quantity', { stale: true }, 'position_unverified'],
  ['cached quantity', { fromCache: true }, 'position_unverified'],
  ['seed holding', { seed: true }, 'position_unverified'],
  ['mock holding', { mock: true }, 'position_unverified'],
  ['quantity missing', { quantity: null }, 'position_unverified'],
  ['cost-basis-only', { referenceClose: null, price: 100, avgCost: 100 }, 'official_close_unavailable'],
  ['wrong close date', { referenceCloseSessionDate: PRICE_DATES.at(-2) }, 'official_close_unavailable'],
  ['wrong close source', { referenceCloseSource: 'portfolio_mark' }, 'official_close_unavailable'],
  ['missing provenance', { referenceCloseObservedAt: null }, 'official_close_unavailable'],
  ['foreign currency', { currency: 'EUR' }, 'base_currency_conversion_unavailable'],
  ['unknown instrument', { secType: '' }, 'unsupported_instrument'],
]) test(`excludes ${label} while preserving coverage of other holdings`, async () => {
  const result = await capture(source(portfolio({ holdings: [holding('AAA', overrides), holding('BBB')] })));
  assert.deepEqual(result.assets.map(row => row.symbol), ['BBB']);
  assert.equal(result.coverage.complete, false);
  assert.equal(result.coverage.excluded[0].reason, expected);
  assert.equal(result.coverage.totalGrossWeight, undefined);
});

test('event contracts and other non-equities never enter equity coverage, weights or history requests', async () => {
  const http = client();
  const result = await capture(source(portfolio({ holdings: [
    holding('AAA'), holding('BBB', { quantity: -5 }),
    holding('CPIY', { conid: 301, secType: 'OPT', exchange: 'FORECASTX', markFailure: {}, referenceClose: null }),
    holding('UNFAMILIAR', { conid: 302, secType: 'EVENT', exchange: 'KALSHI', referenceClose: null }),
    holding('XYZ', { conid: 303, isPredictionMarket: true, referenceClose: null }),
    holding('OPTION', { conid: 304, secType: 'OPT', referenceClose: null }),
    holding('CASH', { conid: 305, secType: 'CASH', referenceClose: null }),
  ] }), http));
  assert.deepEqual(result.assets.map(row => row.symbol), ['AAA', 'BBB']);
  assert.equal(result.coverage.holdingCount, 2);
  assert.equal(result.coverage.modeledCount, 2);
  assert.equal(result.coverage.complete, true);
  assert.deepEqual(result.coverage.excluded, []);
  assert.equal(result.coverage.outOfScope.filter(row => row.reason === 'prediction_contract').length, 3);
  assert.equal(result.coverage.outOfScope.filter(row => row.reason === 'non_equity_instrument').length, 2);
  assert.equal(result.coverage.totalGrossWeight, 0.015);
  assert(!http.calls.some(call => /\/(CPIY|UNFAMILIAR|XYZ|OPTION|CASH)$/.test(call.url)));
});

test('a genuine equity remains in coverage and reports missing official close separately from its position', async () => {
  const result = await capture(source(portfolio({ holdings: [holding('AAA'), holding('EXPGY', {
    exchange: 'PINK', isPredictionMarket: false, markFailure: { errorCode: 'REFERENCE_MARK_NO_TRADE_IN_LOOKBACK' },
    referenceClose: null, referenceCloseSource: null,
  })] })));
  assert.equal(result.coverage.holdingCount, 2);
  assert.equal(result.coverage.complete, false);
  assert.deepEqual(result.coverage.excluded, [{ id: 'EXPGY', symbol: 'EXPGY', reason: 'official_close_unavailable' }]);
  assert.deepEqual(result.coverage.outOfScope, []);
});

test('an unavailable current quote does not invalidate independently verified post-close equity weights', async () => {
  const result = await capture(source(portfolio({ holdings: [holding('AAA', {
    markPending: true, markFailure: { errorCode: 'LIVE_QUOTE_UNAVAILABLE' }, price: null,
  })] })));
  assert.equal(result.coverage.complete, true);
  assert.equal(result.assets[0].weight, 0.01);
});

test('deduplicates aggregate broker positions without doubling signed exposure or coverage counts', async () => {
  const result = await capture(source(portfolio({ holdings: [holding('AAA', { quantity: -3 }), holding('AAA', { quantity: -3 })] })));
  assert.equal(result.assets.length, 1);
  assert.equal(result.assets[0].weight, -0.003);
  assert.equal(result.coverage.holdingCount, 1);
  assert.equal(result.coverage.modeledCount, 1);
  assert.equal(result.coverage.totalGrossWeight, 0.003);
  assert.equal(result.coverage.complete, true);
  assert.equal(result.evidence.holdings.length, 1);
  assert.equal(result.evidence.holdings[0].sourceRowCount, 2);
});

test('conflicting aggregate positions and security identities are excluded instead of summed', async () => {
  const inconsistent = await capture(source(portfolio({ holdings: [holding('AAA', { quantity: 3 }), holding('AAA', { quantity: -1 }), holding('BBB')] })));
  assert.deepEqual(inconsistent.assets.map(row => row.symbol), ['BBB']);
  assert.equal(inconsistent.coverage.holdingCount, 2);
  assert.equal(inconsistent.coverage.excluded[0].reason, 'position_unverified');
  assert.equal(inconsistent.coverage.totalGrossWeight, undefined);
  const collision = await capture(source(portfolio({ holdings: [holding('AAA'), holding('AAA', { conid: 999 })] })));
  assert.deepEqual(collision.assets, []);
  assert.equal(collision.coverage.excluded[0].reason, 'security_identity_collision');
  assert.equal(collision.coverage.totalGrossWeight, undefined);
  const alias = await capture(source(portfolio({ holdings: [holding('AAA'), holding('BBB', { conid: 100 })] })));
  assert.deepEqual(alias.assets, []);
  assert(alias.coverage.excluded.every(row => row.reason === 'security_identity_collision'));
});

test('a duplicate with invalid broker provenance cannot be hidden by its verified counterpart', async () => {
  const result = await capture(source(portfolio({ holdings: [holding('AAA'), holding('AAA', { stale: true }), holding('BBB')] })));
  assert.deepEqual(result.assets.map(row => row.symbol), ['BBB']);
  assert.equal(result.coverage.holdingCount, 2);
  assert.equal(result.coverage.excluded.length, 1);
  assert.equal(result.coverage.excluded[0].reason, 'position_unverified');
});

test('zero and nonzero rows for the same broker position conflict instead of preserving the active row', async () => {
  const result = await capture(source(portfolio({ holdings: [holding('AAA'), holding('AAA', { quantity: 0 }), holding('BBB')] })));
  assert.deepEqual(result.assets.map(row => row.symbol), ['BBB']);
  assert.equal(result.coverage.holdingCount, 2);
  assert.equal(result.coverage.excluded[0].reason, 'position_unverified');
  assert.equal(result.coverage.totalGrossWeight, undefined);
  const alias = await capture(source(portfolio({ holdings: [holding('AAA'), holding('BBB', { conid: 100, quantity: 0 })] })));
  assert.deepEqual(alias.assets, []);
  assert(alias.coverage.excluded.every(row => row.reason === 'security_identity_collision'));
});

test('all-zero closed securities are omitted from coverage and holding-history requests', async () => {
  const http = client();
  const result = await capture(source(portfolio({ holdings: [holding('AAA', { quantity: 0 }), holding('AAA', { quantity: 0, stale: true }), holding('BBB')] }), http));
  assert.deepEqual(result.assets.map(row => row.symbol), ['BBB']);
  assert.equal(result.coverage.holdingCount, 1);
  assert.equal(result.coverage.modeledCount, 1);
  assert.deepEqual(result.coverage.excluded, []);
  assert.equal(result.coverage.complete, true);
  assert(!http.calls.some(call => call.url.endsWith('/AAA')));
});

test('missing weekday price excludes holding and never creates a multiday daily return', async () => {
  const http = client({ mutateYahoo(data, symbol) {
    if (symbol !== 'AAA') return;
    const row = data.chart.result[0]; row.timestamp.splice(5, 1);
    row.indicators.quote[0].close.splice(5, 1); row.indicators.adjclose[0].adjclose.splice(5, 1);
  } });
  const result = await capture(source(portfolio(), http));
  assert.deepEqual(result.assets, []);
  assert.equal(result.coverage.excluded[0].reason, 'history_gap');
  assert.equal(result.coverage.totalGrossWeight, 0.01);
});

for (const [label, mutate] of [
  ['wrong currency', row => { row.meta.currency = 'EUR'; }],
  ['wrong security', row => { row.meta.symbol = 'IMPOSTOR'; }],
  ['unadjusted', row => { delete row.indicators.adjclose; }],
  ['non-daily', row => { row.meta.dataGranularity = '1mo'; }],
  ['foreign session', row => { row.meta.exchangeTimezoneName = 'Europe/London'; }],
  ['future contract', row => { row.meta.instrumentType = 'FUTURE'; }],
  ['mock metadata', row => { row.meta.mock = true; }],
]) test(`historical ${label} cannot enter holdings PCA`, async () => {
  const http = client({ mutateYahoo(data, symbol) { if (symbol === 'AAA') mutate(data.chart.result[0]); } });
  const result = await capture(source(portfolio({ holdings: [holding('AAA'), holding('BBB')] }), http));
  assert.deepEqual(result.assets.map(row => row.symbol), ['BBB']);
  assert.equal(result.coverage.complete, false);
});

test('transforms yields/spreads as bp differences, normalizes FX direction, and uses VIX point changes', () => {
  assert(Math.abs(transformPair(4.2, 4.3, 'yield_change_bp') - 10) < 1e-10);
  assert(Math.abs(transformPair(2.5, 2.4, 'spread_change_bp') + 10) < 1e-10);
  assert(Math.abs(transformPair(1.1, 1.21, 'fx_return') - 0.1) < 1e-10);
  assert(Math.abs(transformPair(150, 140, 'fx_inverse_return') - (150 / 140 - 1)) < 1e-10);
  assert.equal(transformPair(15, 20, 'volatility_change'), 5);
  assert.equal(transformPair(0, 1, 'adjusted_return'), null);
  assert.equal(transformPair(-0.2, -0.1, 'yield_change_bp'), 10);
  assert.equal(transformPair(null, 1, 'yield_change_bp'), null);
});

test('references use the same endpoints with null gaps and do not become PCA assets', async () => {
  const result = await capture(source(portfolio(), client({ fredMissing: true })));
  const reference = result.references.find(row => row.id === 'DGS2');
  assert.equal(reference.values[1], null);
  assert.equal(reference.values[2], null);
  assert(Math.abs(reference.values[3] - 1) < 1e-10);
  assert.equal(reference.asOf, SESSION);
  assert.deepEqual(result.assets.map(row => row.symbol), ['AAA']);
  assert.equal(result.coverage.complete, true);
  assert.equal(result.references.find(row => row.id === 'VIX').values[0], 1);
});

test('FX British Summer Time midnight uses the provider session date instead of the previous UTC date', async () => {
  const http = client({ mutateYahoo(data, symbol) {
    if (!symbol.endsWith('=X')) return;
    const row = data.chart.result[0];
    row.meta.exchangeTimezoneName = 'Europe/London';
    row.timestamp = PRICE_DATES.map(date => Date.parse(`${date}T00:00:00+01:00`) / 1000);
  } });
  const result = await capture(source(portfolio(), http));
  for (const id of ['EURUSD', 'JPYUSD', 'GBPUSD']) {
    const row = result.references.find(reference => reference.id === id);
    assert.equal(row.values.filter(Number.isFinite).length, WINDOW);
    assert.equal(row.asOf, SESSION);
  }
});

test('FX duplicate unfinished-session marks are removed before completed-session uniqueness checks', async () => {
  const http = client({ mutateYahoo(data, symbol) {
    if (!symbol.endsWith('=X')) return;
    const row = data.chart.result[0];
    row.meta.exchangeTimezoneName = 'Europe/London';
    row.meta.currentTradingPeriod.regular = {
      start: Date.parse(`${SESSION}T00:00:00+01:00`) / 1000,
      end: Date.parse(`${SESSION}T23:59:00+01:00`) / 1000,
    };
    row.timestamp = PRICE_DATES.map(date => Date.parse(`${date}T00:00:00+01:00`) / 1000);
    row.timestamp.push(Date.parse(`${SESSION}T22:00:00+01:00`) / 1000);
    row.indicators.quote[0].close.push(2000);
  } });
  const result = await capture(source(portfolio(), http));
  for (const id of ['EURUSD', 'JPYUSD', 'GBPUSD']) {
    const row = result.references.find(reference => reference.id === id);
    assert.equal(row.values.filter(Number.isFinite).length, WINDOW - 1);
    assert.equal(row.values.at(-1), null);
    assert.equal(row.asOf, PRICE_DATES.at(-2));
  }
});

test('FX conflicting completed-session observations remain unavailable', async () => {
  const http = client({ mutateYahoo(data, symbol) {
    if (!symbol.endsWith('=X')) return;
    const row = data.chart.result[0];
    row.timestamp.push(row.timestamp[5] + 60);
    row.indicators.quote[0].close.push(2000);
  } });
  const result = await capture(source(portfolio(), http));
  for (const id of ['EURUSD', 'JPYUSD', 'GBPUSD']) {
    const row = result.references.find(reference => reference.id === id);
    assert.equal(row.reason, 'history_duplicate_dates');
    assert(row.values.every(value => value === null));
    assert.equal(row.asOf, null);
  }
});

test('zero-variance holding history is excluded without blocking other holdings or constant-risk candidates', async () => {
  const http = client({ mutateYahoo(data, symbol) {
    if (symbol === 'AAA') data.chart.result[0].indicators.adjclose[0].adjclose.fill(100);
  } });
  const data = source(portfolio({ holdings: [holding('AAA'), holding('BBB')] }), http);
  const result = await capture(data);
  assert.deepEqual(result.assets.map(row => row.symbol), ['BBB']);
  assert.equal(result.coverage.excluded[0].reason, 'zero_variance_history');
  assert.equal(result.coverage.complete, false);
  const candidates = await data.candidates({ symbols: ['AAA'], dates: DATES, sessionDate: SESSION, window: WINDOW });
  assert(candidates[0].returns.every(value => value === 0));
});

test('FRED API authentication is never persisted in source provenance or errors', async () => {
  const secret = 'test-credential-never-persist'; const http = client();
  const result = await capture(source(portfolio(), http, { fredApiKey: secret }));
  assert(http.calls.some(call => call.options.params?.api_key === secret));
  assert(!JSON.stringify(result).includes(secret));
  assert(result.evidence.histories.some(row => row.provider === 'fred'));
});

test('reference-provider failure leaves holding risk usable and every missing reference visibly unavailable', async () => {
  const result = await capture(source(portfolio(), client({ fail: url => !url.includes('finance.yahoo.com') })));
  assert.equal(result.assets.length, 1);
  assert.equal(result.coverage.complete, true);
  assert(result.references.filter(row => ['fred', 'cboe'].includes(row.source)).every(row => row.asOf === null && row.values.every(value => value === null)));
  assert(!JSON.stringify(result).includes('secret upstream error'));
});

test('provider outage is bounded and cached history never rescues invalid current broker evidence', async () => {
  const http = client({ fail: () => true });
  const result = await capture(source(portfolio(), http));
  assert.deepEqual(result.assets, []);
  assert.equal(result.references.length, 44);
  assert(http.calls.length <= 18, `Unexpected outage fan-out: ${http.calls.length}`);
  const book = portfolio(); const usable = client(); const data = source(book, usable);
  await capture(data); const count = usable.calls.length;
  await capture(data); assert.equal(usable.calls.length, count);
  book.fromCache = true;
  await assert.rejects(capture(data), error => error.code === 'portfolio_unverified');
});

test('candidate projection uses only same-window own history with no broker or quote fetch', async () => {
  let brokerCalled = false;
  const data = source(null, client(), { getPortfolioSnapshot: async () => { brokerCalled = true; throw new Error('offline'); } });
  const rows = await data.candidates({ symbols: ['aaa', 'BRK.B'], dates: DATES, sessionDate: SESSION, window: WINDOW });
  assert.deepEqual(rows.map(row => row.id), ['AAA', 'BRK.B']);
  assert.equal(rows[1].provenance.symbol, 'BRK-B');
  assert.equal(rows[0].returns.length, WINDOW);
  assert.equal(brokerCalled, false);
  await assert.rejects(data.candidates({ symbols: ['AAA'], dates: DATES.slice(1), sessionDate: SESSION, window: WINDOW }), error => error.code === 'candidate_dates_mismatch');
  await assert.rejects(data.candidates({ symbols: ['AAA;DROP'], dates: DATES, sessionDate: SESSION, window: WINDOW }), error => error.code === 'invalid_candidate');
});

test('holidays are skipped while absent valid-session endpoints remain missing', () => {
  assert(!PRICE_DATES.includes('2026-09-07'));
  const values = alignedValues([{ date: '2026-09-04', value: 100 }, { date: '2026-09-09', value: 110 }], ['2026-09-04', '2026-09-08', '2026-09-09'], 'adjusted_return');
  assert.deepEqual(values, [null, null]);
});
