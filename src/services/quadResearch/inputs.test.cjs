const test = require('node:test');
const assert = require('node:assert/strict');
const { GROUPS, GAPS, EXCLUSIONS } = require('./catalog.cjs');
const { validatePriceHistory, buildMacroRows, classifyQuad, completeQuarter, canonicalUrl,
  loadQuadResearchInputs } = require('./inputs.cjs');
const { isTradingDateKey, addCalendarDays } = require('../../utils/usEquityMarketCalendar.cjs');

test('reviewed catalog has stable peers and source-derived gaps without ambiguous substitutes', () => {
  assert.deepEqual(GROUPS.map(group => group.benchmarks.length), [5, 11, 7, 14]);
  assert.equal(GAPS.length, 39);
  assert.equal(Object.keys(EXCLUSIONS).length, 8);
  const ids = new Set(GROUPS.flatMap(group => group.benchmarks.map(row => row.exposureId)));
  assert.equal(ids.size, 37);
  assert.equal(GAPS.filter(row => ids.has(row.exposureId)).length, 32);
  assert.equal(new Set(GAPS.filter(row => ids.has(row.exposureId)).map(row => row.exposureId)).size, 22);
  assert.equal(GROUPS[2].benchmarks.find(row => row.label === 'Dividend Yield').symbol, 'VYM');
  assert.equal(GROUPS[1].startQuarter, '2018-Q4');
  for (const symbol of ['QUAL', 'MTUM', 'PFF']) {
    assert.ok(GROUPS.flatMap(group => group.benchmarks).find(row => row.symbol === symbol).methodologyChanges.length > 0);
  }
  for (const id of Object.keys(EXCLUSIONS)) assert.equal(ids.has(id), false);
});

test('quarters exclude the open quarter and exact-zero acceleration remains unclassified', () => {
  assert.equal(completeQuarter(new Date('2026-09-08T23:00:00Z')), '2026-Q2');
  assert.equal(completeQuarter(new Date('2026-01-01T00:00:00Z')), '2025-Q4');
  assert.equal(classifyQuad(1, -1), 1);
  assert.equal(classifyQuad(1, 1), 2);
  assert.equal(classifyQuad(-1, 1), 3);
  assert.equal(classifyQuad(-1, -1), 4);
  assert.equal(classifyQuad(0, 1), null);
  assert.equal(classifyQuad(Number.NaN, 1), null);
  assert.equal(classifyQuad(1e-12, 1), 2);
});

function macroFixture() {
  const gdp = { '2006-01-01': 100, '2006-04-01': 100, '2007-01-01': 108, '2007-04-01': 110 };
  const cpi = {};
  for (const [year, month, value] of [[2006, 1, 200], [2006, 4, 200], [2007, 1, 208], [2007, 4, 210]]) {
    for (let offset = 0; offset < 3; offset += 1) cpi[`${year}-${String(month + offset).padStart(2, '0')}-01`] = value;
  }
  return {
    firstReleases: { observations: [{ date: '2007-04-01', value: '110', realtime_start: '2007-07-27' }] },
    gdpVintages: { observations: Object.entries(gdp).map(([date, value]) => ({ date, GDPC1_20070727: String(value) })) },
    cpiVintages: { observations: Object.entries(cpi).map(([date, value]) => ({ date, CPIAUCNS_20070727: String(value) })) },
    latestGdp: { observations: Object.entries({ ...gdp, '2007-04-01': 106 }).map(([date, value]) => ({ date, value: String(value) })) },
    latestCpi: { observations: Object.entries(cpi).map(([date, value]) => ({ date, value: String(value) })) },
    cutoff: '2007-Q2', asOf: '2026-09-08',
  };
}

test('GDP and all CPI comparison levels use the same first-release vintage; later labels stay separate', () => {
  const result = buildMacroRows(macroFixture());
  assert.deepEqual(result.issues, []);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].quad, 2);
  assert.equal(result.rows[0].latestQuad, 3);
  assert.equal(result.rows[0].releaseDate, '2007-07-27');
  assert.equal(result.rows[0].retrospective, true);
  assert.ok(Math.abs(result.rows[0].growthAcceleration - 2) < 1e-10);
  assert.ok(Math.abs(result.rows[0].inflationAcceleration - 1) < 1e-10);
});

test('quarterly inflation averages monthly YoY rates rather than taking a ratio of average levels', () => {
  const fixture = macroFixture();
  const find = date => fixture.cpiVintages.observations.find(row => row.date === date);
  find('2006-04-01').CPIAUCNS_20070727 = '100';
  find('2007-04-01').CPIAUCNS_20070727 = '120';
  // Quarter YoY is mean(20%, 5%, 5%) = 10%, previous quarter is 4%.
  assert.ok(Math.abs(buildMacroRows(fixture).rows[0].inflationAcceleration - 6) < 1e-10);
});

test('missing CPI month retains its calendar row while malformed first-release evidence fails', () => {
  const missingMonth = macroFixture();
  missingMonth.cpiVintages.observations.pop();
  assert.equal(buildMacroRows(missingMonth).rows[0].reason, 'macro_levels_missing');
  assert.equal(buildMacroRows(missingMonth).rows[0].quad, null);
  assert.equal(buildMacroRows(missingMonth).rows[0].latestQuad, 3);
  assert.equal(buildMacroRows(missingMonth).rows[0].inflationAcceleration, null);
  const altered = macroFixture();
  altered.firstReleases.observations[0].value = '111';
  assert.equal(buildMacroRows(altered).issues[0].code, 'first_release_value_mismatch');
  const future = macroFixture();
  future.firstReleases.observations[0].realtime_start = '2007-06-30';
  assert.equal(buildMacroRows(future).issues[0].code, 'invalid_gdp_first_release');
});

function priceFixture() {
  const bars = [];
  for (let date = '2025-12-31'; date <= '2026-03-31'; date = addCalendarDays(date, 1)) {
    if (isTradingDateKey(date)) bars.push({ date, rawClose: date < '2026-01-05' ? 100 : 99, adjustedClose: 99 });
  }
  const timestamp = date => Date.parse(`${date}T14:30:00Z`) / 1000;
  return { bars, rawResponse: { chart: { result: [{ timestamp: bars.map(row => timestamp(row.date)) }] } },
    metadata: { symbol: 'SPY', currency: 'USD', instrumentType: 'ETF', dataGranularity: '1d' },
    events: { dividends: { a: { date: timestamp('2026-01-05'), amount: 1 } },
      splits: { b: { date: timestamp('2026-01-12'), numerator: 2, denominator: 1, splitRatio: '2:1' } } } };
}
const benchmark = { symbol: 'SPY' };

test('complete quarter returns reconcile a distribution and do not double-apply an already adjusted split', () => {
  const result = validatePriceHistory(priceFixture(), benchmark, '2026-Q1', '2026-Q1');
  assert.deepEqual(result.issues, []);
  assert.equal(result.returns['2026-Q1'], 0);
  assert.equal(result.validation.dividendCount, 1);
  assert.equal(result.validation.splitCount, 1);
  assert.equal(result.validation.independentIssuerReconciliation.status, 'not_performed');
});

test('Good Friday quarter ends use March 29 and the next quarter starts from that same verified close', () => {
  const bars = [];
  for (let date = '2017-12-29'; date <= '2018-06-29'; date = addCalendarDays(date, 1)) {
    if (!isTradingDateKey(date)) continue;
    const close = date < '2018-03-29' ? 100 : date < '2018-06-29' ? 110 : 121;
    bars.push({ date, rawClose: close, adjustedClose: close });
  }
  const history = { bars, metadata: { symbol: 'SPY', currency: 'USD', instrumentType: 'ETF', dataGranularity: '1d' },
    rawResponse: { chart: { result: [{ timestamp: bars.map(row => Date.parse(`${row.date}T14:30:00Z`) / 1000) }] } }, events: {} };
  const result = validatePriceHistory(history, benchmark, '2018-Q1', '2018-Q2');
  assert.deepEqual(result.issues, []);
  assert.equal(result.validation.startDate, '2017-12-29');
  assert.equal(result.validation.endDate, '2018-06-29');
  assert.ok(Math.abs(result.returns['2018-Q1'] - 0.1) < 1e-12);
  assert.ok(Math.abs(result.returns['2018-Q2'] - 0.1) < 1e-12);
  assert.equal(bars.some(row => row.date === '2018-03-30'), false);
  const fabricatedFriday = { ...history, bars: [...bars, { date: '2018-03-30', rawClose: 110, adjustedClose: 110 }] };
  assert.ok(validatePriceHistory(fabricatedFriday, benchmark, '2018-Q1', '2018-Q2').issues.some(issue => issue.code === 'invalid_or_duplicate_price_bar'));
});

test('raw-close fallback, missing sessions, duplicate bars and missing actions cannot produce returns', () => {
  const missingAdjusted = priceFixture(); missingAdjusted.bars[2].adjustedClose = null;
  const missingSession = priceFixture(); missingSession.bars.splice(2, 1);
  const duplicate = priceFixture(); duplicate.bars.push(duplicate.bars[2]);
  const missingAction = priceFixture(); missingAction.events.dividends = {};
  const duplicateSource = priceFixture(); duplicateSource.rawResponse.chart.result[0].timestamp[2] = duplicateSource.rawResponse.chart.result[0].timestamp[1];
  for (const history of [missingAdjusted, missingSession, duplicate, missingAction, duplicateSource]) {
    const result = validatePriceHistory(history, benchmark, '2026-Q1', '2026-Q1');
    assert.ok(result.issues.length > 0);
    assert.deepEqual(result.returns, {});
  }
});

test('wrong identity, currency, granularity, offline, seed, mock and cache-only data are rejected', () => {
  for (const transform of [
    history => { history.metadata.symbol = 'OTHER'; },
    history => { history.metadata.currency = 'EUR'; },
    history => { history.metadata.dataGranularity = '1mo'; },
    history => { history.providerStatus = 'offline'; },
    history => { history.seed = true; },
    history => { history.mock = true; },
    history => { history.cacheOnly = true; },
    history => { history.stale = true; },
  ]) {
    const history = priceFixture(); transform(history);
    const result = validatePriceHistory(history, benchmark, '2026-Q1', '2026-Q1');
    assert.ok(result.issues.length > 0);
    assert.deepEqual(result.returns, {});
  }
});

test('canonical archive identity sorts parameters and never contains a FRED API key', () => {
  assert.equal(canonicalUrl('https://example.test', { z: 'last', api_key: 'private', a: 'first' }),
    'https://example.test?a=first&z=last');
});

test('global macro failure and peer fetch failure stay explicit without raw provider error details', async () => {
  const result = await loadQuadResearchInputs({ now: new Date('2026-09-08'), groups: [GROUPS[0]], fredApiKey: 'private',
    httpClient: { get: async () => { throw new Error('must not expose private'); } },
    fetchHistory: async () => { throw new Error('must not expose private'); } });
  assert.equal(result.validation.globalIngestionFailure, true);
  assert.equal(result.validation.valid, false);
  assert.deepEqual(result.groups[0].rows, []);
  assert.ok(result.groups[0].inputIssues.some(issue => issue.code === 'price_input_unavailable'));
  assert.equal(JSON.stringify(result).includes('private'), false);
});

test('a resumed cached malformed FRED response is validated again and fails globally', async () => {
  const fixture = macroFixture();
  const duplicate = fixture.firstReleases.observations[0];
  const result = await loadQuadResearchInputs({ now: new Date('2026-09-09T01:00:00Z'), groups: [],
    loadCachedRaw: async ({ url }) => {
      assert.ok(url.includes('realtime_end=2026-09-08')); // Source date is St. Louis, not UTC.
      return { hash: 'a'.repeat(64), retrievedAt: '2026-09-09T00:00:00Z',
        payload: { count: 2, observations: [duplicate, duplicate] } };
    } });
  assert.equal(result.validation.globalIngestionFailure, true);
  assert.equal(result.macro.issues[0].reason, 'fred_duplicate_or_invalid_dates');
  assert.deepEqual(result.sourceHashes, ['a'.repeat(64)]);
});
