const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const catalog = require('../constants/marketRotationCatalog.json');
const { parseDailyChart } = require('./marketDailyMetrics.cjs');
const { buildMarketRotationSnapshot, createMarketRotationService } = require('./marketRotationService.cjs');

const DAY = '2026-09-24';
const NOW = Date.parse(`${DAY}T16:11:00Z`);
const OBSERVED = Date.parse(`${DAY}T16:10:00Z`);
const TICKERS = [...new Set([...catalog.themes, ...catalog.instruments].map(row => row.ticker))];
const PRICES = { IGV: 104, SMH: 101, XBI: 105, TAN: 92, IWF: 104, IWD: 101, MTUM: 103, SPY: 102, SPHB: 99, SPLV: 100.5, IWM: 100 };

function payload(ticker, { observed = OBSERVED, price = PRICES[ticker] ?? 100 } = {}) {
  return { chart: { error: null, result: [{
    meta: { symbol: ticker, currency: 'USD', instrumentType: 'ETF', exchangeTimezoneName: 'America/New_York',
      regularMarketPrice: price, regularMarketTime: observed / 1000, dataGranularity: '1d',
      currentTradingPeriod: { regular: { start: Date.parse(`${DAY}T13:30:00Z`) / 1000, end: Date.parse(`${DAY}T20:00:00Z`) / 1000 } } },
    timestamp: ['2026-09-23T13:30:00Z', `${DAY}T13:30:00Z`].map(date => Date.parse(date) / 1000),
    indicators: { quote: [{ open: [100, 100], close: [100, price], high: [101, Math.max(101, price)],
      low: [99, Math.min(99, price)], volume: [10000, 10000] }] },
  }] } };
}

function parsedQuotes(nowMs = NOW, options = {}) {
  return new Map(TICKERS.map(ticker => [ticker, parseDailyChart(payload(ticker, options), { ticker, nowMs })]));
}

function fixtureFetch(options = {}) {
  return async url => {
    const ticker = new URL(url).pathname.split('/').at(-1);
    return { ok: true, json: async () => payload(ticker, options) };
  };
}

test('reports ETF theme price returns and correctly signed paired return spreads', () => {
  const snapshot = buildMarketRotationSnapshot({ dailyByTicker: parsedQuotes(), nowMs: NOW });
  assert.equal(snapshot.status, 'available');
  assert.equal(snapshot.source, 'Yahoo Finance');
  assert.equal(snapshot.themes.software.changePercent, 4);
  assert.equal(snapshot.themes.semiconductors.changePercent, 1);
  assert.equal(snapshot.themes.leader.ticker, 'XBI');
  assert.equal(snapshot.themes.laggard.ticker, 'TAN');
  assert.deepEqual(snapshot.themes.ranked.map(row => row.ticker),
    ['XBI', 'IGV', 'SMH', 'CIBR', 'ITB', 'KRE', 'SKYY', 'URA', 'XRT', 'TAN']);
  assert.equal(snapshot.themes.ranked[0], snapshot.themes.leader);
  assert.equal(snapshot.themes.ranked.at(-1), snapshot.themes.laggard);
  assert.ok(snapshot.themes.ranked.every(row => row.sourceUrl && row.issuerUrl && row.asOf && row.expiresAt));
  assert.deepEqual(snapshot.themes.coverage, { verified: 10, total: 10, comparable: true, expiresAt: `${DAY}T16:30:00.000Z` });
  assert.deepEqual(snapshot.factors.map(row => row.spreadPp), [3, 1, -1.5, -2]);
  assert.equal(snapshot.factors[3].left.changePercent, 0);
  assert.equal(snapshot.factors[0].left.issuerUrl, catalog.instruments.find(row => row.ticker === 'IWF').issuerUrl);
  assert.equal(snapshot.asOf, new Date(OBSERVED).toISOString());
  assert.equal(snapshot.expiresAt, `${DAY}T16:30:00.000Z`);
});

test('missing quotes never shrink the ranking universe or erase independent observations', () => {
  const quotes = parsedQuotes();
  quotes.delete('TAN');
  quotes.delete('IWD');
  const snapshot = buildMarketRotationSnapshot({ dailyByTicker: quotes, nowMs: NOW });
  assert.equal(snapshot.status, 'partial');
  assert.equal(snapshot.themes.software.changePercent, 4);
  assert.equal(snapshot.themes.leader, null);
  assert.equal(snapshot.themes.laggard, null);
  assert.deepEqual(snapshot.themes.ranked, []);
  assert.deepEqual(snapshot.themes.coverage, { verified: 9, total: 10, comparable: false, expiresAt: `${DAY}T16:30:00.000Z` });
  assert.equal(snapshot.factors[0].left.changePercent, 4);
  assert.equal(snapshot.factors[0].right, null);
  assert.equal(snapshot.factors[0].spreadPp, null);
  assert.equal(snapshot.factors[0].status, 'unavailable');
  assert.equal(snapshot.factors[1].spreadPp, 1);
});

test('rejects mixed market dates and mixed session status in comparisons', () => {
  for (const patch of [{ marketDate: '2026-09-23' }, { status: 'last-close' }]) {
    const quotes = parsedQuotes();
    Object.assign(quotes.get('IWD'), patch);
    Object.assign(quotes.get('URA'), patch);
    const snapshot = buildMarketRotationSnapshot({ dailyByTicker: quotes, nowMs: NOW });
    assert.equal(snapshot.factors[0].spreadPp, null, JSON.stringify(patch));
    assert.equal(snapshot.factors[0].status, 'unavailable');
    assert.equal(snapshot.factors[1].spreadPp, 1);
    assert.equal(snapshot.themes.leader, null);
    assert.deepEqual(snapshot.themes.ranked, []);
    assert.equal(snapshot.themes.coverage.comparable, false);
  }
});

test('requires closely timed factor legs while ranking the full roster of fresh daily theme readings', () => {
  const quotes = parsedQuotes();
  for (const ticker of ['IWD', 'URA']) {
    quotes.set(ticker, parseDailyChart(payload(ticker, { observed: Date.parse(`${DAY}T16:04:00Z`) }), { ticker, nowMs: NOW }));
  }
  const snapshot = buildMarketRotationSnapshot({ dailyByTicker: quotes, nowMs: NOW });
  assert.equal(snapshot.factors[0].spreadPp, null);
  assert.equal(snapshot.factors[1].spreadPp, 1);
  assert.equal(snapshot.themes.coverage.comparable, true);
  assert.equal(snapshot.themes.leader.ticker, 'XBI');
  assert.equal(snapshot.themes.laggard.ticker, 'TAN');
});

test('an early quote expiry limits its dependent comparison without expiring independent rows', () => {
  const quotes = parsedQuotes();
  quotes.set('URA', parseDailyChart(payload('URA', { observed: Date.parse(`${DAY}T16:00:00Z`) }), { ticker: 'URA', nowMs: NOW }));
  quotes.set('IWD', parseDailyChart(payload('IWD', { observed: Date.parse(`${DAY}T16:06:00Z`) }), { ticker: 'IWD', nowMs: NOW }));
  const snapshot = buildMarketRotationSnapshot({ dailyByTicker: quotes, nowMs: NOW });
  assert.equal(snapshot.expiresAt, `${DAY}T16:30:00.000Z`);
  assert.equal(snapshot.themes.coverage.expiresAt, `${DAY}T16:20:00.000Z`);
  assert.equal(snapshot.factors[0].expiresAt, `${DAY}T16:26:00.000Z`);
  assert.equal(snapshot.factors[1].expiresAt, `${DAY}T16:30:00.000Z`);
  const afterFirstExpiry = buildMarketRotationSnapshot({ dailyByTicker: quotes, nowMs: Date.parse(`${DAY}T16:20:00Z`) });
  assert.equal(afterFirstExpiry.themes.leader, null);
  assert.deepEqual(afterFirstExpiry.themes.ranked, []);
  assert.equal(afterFirstExpiry.themes.software.changePercent, 4);
  assert.equal(afterFirstExpiry.factors[0].spreadPp, 3);
  assert.equal(afterFirstExpiry.factors[1].spreadPp, 1);
  assert.equal(afterFirstExpiry.expiresAt, `${DAY}T16:30:00.000Z`);
  const unavailable = buildMarketRotationSnapshot({ nowMs: NOW });
  assert.equal(unavailable.expiresAt, null);
  assert.equal(unavailable.themes.coverage.expiresAt, null);
});

test('withholds returns affected by a current dividend or split without erasing other ETFs', () => {
  for (const type of ['dividends', 'splits', 'capitalGains']) {
    const quotes = parsedQuotes();
    const raw = payload('IWF');
    raw.chart.result[0].events = { [type]: { today: { date: OBSERVED / 1000, amount: 1 } } };
    quotes.set('IWF', parseDailyChart(raw, { ticker: 'IWF', nowMs: NOW }));
    const snapshot = buildMarketRotationSnapshot({ dailyByTicker: quotes, nowMs: NOW });
    assert.equal(snapshot.factors[0].left, null);
    assert.equal(snapshot.factors[0].spreadPp, null);
    assert.equal(snapshot.factors[1].spreadPp, 1);
    assert.equal(snapshot.themes.leader.ticker, 'XBI');
  }
});

test('retains official last-close dates, source and expiry without claiming current trading', () => {
  const nowMs = Date.parse(`${DAY}T21:00:00Z`);
  const quotes = parsedQuotes(nowMs, { observed: Date.parse(`${DAY}T20:00:00Z`) });
  const snapshot = buildMarketRotationSnapshot({ dailyByTicker: quotes, nowMs });
  assert.equal(snapshot.status, 'available');
  assert.equal(snapshot.themes.software.status, 'last-close');
  assert.equal(snapshot.themes.software.marketDate, DAY);
  assert.equal(snapshot.factors[0].status, 'last-close');
  assert.equal(snapshot.expiresAt, '2026-09-25T13:30:00.000Z');
  const expired = buildMarketRotationSnapshot({ dailyByTicker: quotes, nowMs: Date.parse(snapshot.expiresAt) });
  assert.equal(expired.status, 'unavailable');
  assert.equal(expired.themes.software, null);
  assert.ok(expired.factors.every(row => row.spreadPp === null));
});

test('rejects offline, stale, cache-only, mock, seed and synthetic inputs in parsed evidence', () => {
  for (const patch of [{ offline: true }, { connected: false }, { stale: true }, { refreshFailed: true },
    { cacheOnly: true }, { cached: true }, { mock: true }, { seeded: true }, { synthetic: true },
    { source: 'portfolio-derived' }, { provider: 'mock' }]) {
    const quotes = parsedQuotes();
    for (const row of quotes.values()) Object.assign(row, patch);
    const snapshot = buildMarketRotationSnapshot({ dailyByTicker: quotes, nowMs: NOW });
    assert.equal(snapshot.status, 'unavailable', JSON.stringify(patch));
    assert.equal(snapshot.themes.software, null);
    assert.equal(snapshot.themes.coverage.verified, 0);
    assert.deepEqual(snapshot.themes.ranked, []);
    assert.ok(snapshot.factors.every(row => row.left === null && row.right === null && row.spreadPp === null));
  }
});

test('one contaminated theme withholds the complete ranked roster but keeps independent themes and factors', () => {
  for (const patch of [{ stale: true }, { cacheOnly: true }, { mock: true }, { seeded: true }, { offline: true }]) {
    const quotes = parsedQuotes();
    Object.assign(quotes.get('XRT'), patch);
    const snapshot = buildMarketRotationSnapshot({ dailyByTicker: quotes, nowMs: NOW });
    assert.deepEqual(snapshot.themes.ranked, [], JSON.stringify(patch));
    assert.equal(snapshot.themes.leader, null);
    assert.equal(snapshot.themes.software.changePercent, 4);
    assert.equal(snapshot.factors[0].spreadPp, 3);
  }
});

test('deduplicates in-flight requests and fetches each unique ticker once with bounded concurrency', async () => {
  let calls = 0;
  let active = 0;
  let maximum = 0;
  const service = createMarketRotationService({ now: () => NOW, concurrency: 3, fetchImpl: async (url, options) => {
    calls += 1;
    active += 1;
    maximum = Math.max(maximum, active);
    assert.equal(options.cache, 'no-store');
    assert.equal(new URL(url).searchParams.get('range'), '1mo');
    await new Promise(resolve => setImmediate(resolve));
    active -= 1;
    return fixtureFetch()(url);
  } });
  const snapshots = await Promise.all([service.getSnapshot(), service.getSnapshot(), service.getSnapshot()]);
  assert.equal(calls, TICKERS.length);
  assert.ok(maximum <= 3);
  assert.ok(snapshots.every(snapshot => snapshot.status === 'available'));
  assert.deepEqual(snapshots[0], snapshots[1]);
  await service.getSnapshot();
  assert.equal(calls, TICKERS.length);
  service.dispose();
});

test('failed refreshes retain complete factor comparisons and independent observations', async () => {
  let nowMs = NOW;
  let failure = null;
  const service = createMarketRotationService({ now: () => nowMs, fetchImpl: async url => {
    if (failure === 'all' || (failure === 'one' && url.includes('/IWD?'))) throw new Error('Provider offline');
    return fixtureFetch()(url);
  } });
  assert.equal((await service.getSnapshot()).status, 'available');
  nowMs += 61_000;
  failure = 'one';
  let snapshot = await service.getSnapshot();
  assert.equal(snapshot.status, 'available');
  assert.equal(snapshot.factors[0].right.changePercent, 1);
  assert.equal(snapshot.factors[0].retained, true);
  assert.equal(snapshot.factors[1].spreadPp, 1);
  nowMs += 61_000;
  failure = 'all';
  snapshot = await service.getSnapshot();
  assert.equal(snapshot.status, 'available');
  assert.equal(snapshot.themes.software.changePercent, 4);
  assert.equal(snapshot.themes.software.retained, true);
  assert.equal(snapshot.themes.software.asOf, new Date(OBSERVED).toISOString());
  assert.ok(snapshot.factors.every(row => row.retained && row.left && row.right));
  service.dispose();
});

test('observation expiry forces refresh and retains verified readings when fresh data is absent', async () => {
  let nowMs = NOW;
  let calls = 0;
  const service = createMarketRotationService({ now: () => nowMs, refreshMs: 60 * 60_000,
    fetchImpl: async url => { calls += 1; return fixtureFetch()(url); } });
  assert.equal((await service.getSnapshot()).status, 'available');
  nowMs += 21 * 60_000;
  assert.equal((await service.getSnapshot()).retained, true);
  assert.equal(calls, TICKERS.length * 2);
  service.dispose();
});

test('rejects flagged transport and payload responses', async () => {
  for (const patch of [{ offline: true }, { stale: true }, { cacheOnly: true }, { mock: true }, { seeded: true }]) {
    for (const target of ['transport', 'payload']) {
      const service = createMarketRotationService({ now: () => NOW, fetchImpl: async url => {
        const ticker = new URL(url).pathname.split('/').at(-1);
        return { ok: true, ...(target === 'transport' ? patch : {}), json: async () => ({
          ...payload(ticker), ...(target === 'payload' ? patch : {}),
        }) };
      } });
      assert.equal((await service.getSnapshot()).status, 'unavailable', `${target} ${JSON.stringify(patch)}`);
      service.dispose();
    }
  }
});

test('per-request and overall deadlines bound hung providers and dispose clears data', async () => {
  for (const timing of [{ requestTimeoutMs: 5, overallTimeoutMs: 100 }, { requestTimeoutMs: 100, overallTimeoutMs: 5 }]) {
    let aborted = 0;
    const service = createMarketRotationService({ now: () => NOW, ...timing,
      fetchImpl: async (url, { signal }) => {
        signal.addEventListener('abort', () => { aborted += 1; });
        return new Promise(() => {});
      } });
    const snapshot = await service.getSnapshot();
    assert.equal(snapshot.status, 'unavailable');
    assert.ok(aborted > 0);
    service.dispose();
    assert.equal((await service.getSnapshot()).status, 'unavailable');
  }
});


test('persists merged observations and restores them through an API restart with no age deadline', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rotation-reference-'));
  const referenceFilePath = path.join(directory, 'snapshot.json');
  let nowMs = NOW;
  let partial = false;
  const service = createMarketRotationService({ referenceFilePath, now: () => nowMs, fetchImpl: async url => {
    const ticker = new URL(url).pathname.split('/').at(-1);
    if (partial && ['IWD', 'TAN'].includes(ticker)) throw new Error('Offline');
    return { ok: true, json: async () => payload(ticker, partial
      ? { observed: NOW, price: ticker === 'IGV' || ticker === 'IWF' ? 110 : PRICES[ticker] ?? 100 } : {}) };
  } });
  try {
    await service.getSnapshot();
    partial = true;
    nowMs += 61_000;
    const merged = await service.getSnapshot();
    assert.equal(merged.themes.software.changePercent, 10);
    assert.equal(merged.themes.leader.retained, true);
    assert.equal(merged.themes.ranked.find(row => row.ticker === 'IGV').changePercent, 4);
    assert.equal(merged.factors[0].spreadPp, 3);
    assert.equal(merged.factors[0].left.changePercent, 4);
    assert.equal(merged.factors[0].retained, true);
    const saved = JSON.parse(fs.readFileSync(referenceFilePath, 'utf8'));
    assert.equal(saved.snapshot.themes.software.changePercent, 10);
    assert.equal(saved.snapshot.factors[0].spreadPp, 3);
    service.dispose();
    nowMs += 90 * 24 * 60 * 60_000;
    const restarted = createMarketRotationService({ referenceFilePath, now: () => nowMs,
      fetchImpl: async () => { throw new Error('Offline'); } });
    const restored = await restarted.getSnapshot();
    assert.equal(restored.status, 'available');
    assert.equal(restored.retained, true);
    assert.equal(restored.themes.software.changePercent, 10);
    assert.equal(restored.themes.software.asOf, new Date(NOW).toISOString());
    assert.equal(restored.themes.ranked.length, catalog.themes.length);
    assert.equal(restored.themes.leader.asOf, new Date(OBSERVED).toISOString());
    assert.equal(restored.factors[0].spreadPp, 3);
    assert.equal(restored.factors[0].marketDate, DAY);
    restarted.dispose();
  } finally {
    service.dispose();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});


test('flagged refreshes cannot overwrite earlier verified observations', async () => {
  for (const patch of [{ offline: true }, { stale: true }, { cacheOnly: true }, { mock: true }, { seeded: true }, { inferred: true }]) {
    let contaminated = false;
    let nowMs = NOW;
    const service = createMarketRotationService({ now: () => nowMs, fetchImpl: async url => {
      const ticker = new URL(url).pathname.split('/').at(-1);
      return { ok: true, json: async () => ({ ...payload(ticker, contaminated ? { price: 999 } : {}),
        ...(contaminated ? patch : {}) }) };
    } });
    const verified = await service.getSnapshot();
    contaminated = true;
    nowMs += 61_000;
    const retained = await service.getSnapshot();
    assert.equal(retained.themes.software.changePercent, verified.themes.software.changePercent, JSON.stringify(patch));
    assert.equal(retained.themes.software.asOf, verified.themes.software.asOf);
    assert.equal(retained.themes.software.retained, true);
    assert.equal(retained.factors[0].spreadPp, verified.factors[0].spreadPp);
    service.dispose();
  }
});


test('an unchanged observation after failure preserves retained state and original acceptance evidence', async () => {
  let nowMs = NOW;
  let offline = false;
  let observed = OBSERVED;
  const service = createMarketRotationService({ now: () => nowMs, fetchImpl: async url => {
    if (offline) throw new Error('Offline');
    return fixtureFetch({ observed })(url);
  } });
  try {
    const accepted = await service.getSnapshot();
    offline = true;
    nowMs += 61_000;
    assert.equal((await service.getSnapshot()).retained, true);
    offline = false;
    nowMs += 61_000;
    const repeated = await service.getSnapshot();
    assert.equal(repeated.retained, true);
    assert.equal(repeated.themes.software.retained, true);
    assert.equal(repeated.themes.software.verifiedAt, accepted.themes.software.verifiedAt);
    assert.equal(repeated.themes.coverage.retained, true);
    assert.equal(repeated.themes.coverage.verifiedAt, accepted.themes.coverage.verifiedAt);
    assert.deepEqual(repeated.themes.ranked, accepted.themes.ranked.map(row => ({ ...row, retained: true })));
    assert.equal(repeated.factors[0].retained, true);
    assert.equal(repeated.factors[0].verifiedAt, accepted.factors[0].verifiedAt);
    assert.equal(repeated.factors[0].left.verifiedAt, accepted.factors[0].left.verifiedAt);
    assert.equal(repeated.factors[0].right.verifiedAt, accepted.factors[0].right.verifiedAt);
    nowMs += 61_000;
    observed += 60_000;
    const newer = await service.getSnapshot();
    assert.equal(newer.retained, false);
    assert.equal(newer.themes.software.asOf, new Date(observed).toISOString());
    assert.equal(newer.themes.coverage.retained, undefined);
    assert.equal(newer.factors[0].retained, undefined);
  } finally { service.dispose(); }
});
