const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { withQuoteObservation, validateQuoteObservation } = require('./quoteContract.cjs');
const { MAX_AGE_MS } = require('./quoteObservation.cjs');
const { normalizeIbkrRaw } = require('./normalizeQuote');
const { toLegacyQuote } = require('./legacyQuoteAdapter');
const { buildQuoteMetadata } = require('../multiRegionQuoteIntegrity.cjs');
const observed = Date.now() - 1000;
const receipt = observed + 500;
const instrument = { symbol: 'SPY', conId: 123, secType: 'STK', exchange: 'SMART', currency: 'USD', provider: 'ibkr' };
function quote(overrides = {}, context = {}) {
  return withQuoteObservation({
    symbol: 'SPY', providerSymbol: 'SPY', providerRootSymbol: 'SPY', conid: 123,
    secType: 'STK', exchange: 'SMART', currency: 'USD', source: 'ibkr',
    timestamp: new Date(observed).toISOString(), last: 100, mark: 100, bid: 99, ask: 101,
    dataType: 'live', entitlementStatus: 'live', valid: true,
    ...overrides,
  }, { instrument, receivedAt: receipt, connectionGeneration: 7, connected: true, now: receipt, ...context });
}
const validate = (value, context = {}) => validateQuoteObservation(value, { instrument, connectionGeneration: 7, connected: true, now: receipt, ...context });

test('envelope carries original observation time, receipt time, expiry, complete identity, and market scope', () => {
  const value = quote();
  assert.deepEqual(validate(value), { valid: true, rejectionReason: null });
  assert.equal(value.receivedAt, new Date(receipt).toISOString());
  assert.equal(value.expiresAt, new Date(observed + MAX_AGE_MS).toISOString());
  assert.deepEqual(value.observation.scope, { kind: 'market', accountId: null });
  assert.equal(value.observation.identity.conid, 123);
  assert.equal(value.observation.connectionGeneration, 7);
  assert.equal(Object.isFrozen(value.observation), true);
  assert.equal(Object.isFrozen(value.observation.identity), true);
});

test('cache reuse and canonical-to-legacy conversion preserve receipt and original expiry', () => {
  const value = quote();
  const reused = withQuoteObservation(value, { receivedAt: receipt + 30_000, connectionGeneration: 8 });
  assert.equal(reused, value);
  const legacy = toLegacyQuote(value);
  assert.equal(legacy.observation, value.observation);
  assert.equal(legacy.receivedAt, value.receivedAt);
  assert.equal(legacy.expiresAt, value.expiresAt);
  assert.equal(validate(legacy, { now: observed + MAX_AGE_MS + 1 }).rejectionReason, 'observation_expired');
});

test('forging both top-level and envelope expiry cannot extend the observation lifetime', () => {
  const value = quote();
  const expiresAt = new Date(observed + MAX_AGE_MS * 10).toISOString();
  const forged = { ...value, expiresAt, observation: { ...value.observation, expiresAt } };
  assert.equal(validate(forged).rejectionReason, 'observation_expiry_mismatch');
});

test('a rewritten top-level receipt does not replace the immutable envelope receipt', () => {
  assert.equal(validate({ ...quote(), receivedAt: new Date(receipt + 1).toISOString() }).rejectionReason, 'observation_timestamp_mismatch');
});

test('requested identity and returned identity are independently checked', () => {
  const value = quote();
  assert.equal(validate(value, { instrument: { ...instrument, conId: 456 } }).rejectionReason, 'requested_identity_mismatch');
  assert.equal(validate({ ...value, conid: 456 }).rejectionReason, 'observation_identity_mismatch');
  assert.equal(validate(quote({ conid: 456 })).rejectionReason, 'provider_identity_mismatch');
  assert.equal(validate(quote({ providerRootSymbol: 'QQQ' })).rejectionReason, 'provider_identity_mismatch');
  assert.equal(validate(quote({ currency: 'EUR' })).rejectionReason, 'provider_identity_mismatch');
});

test('qualified broker responses cannot infer missing identity from the requested contract', () => {
  const value = quote({ secType: null });
  assert.equal(value.valid, false);
  assert.equal(value.observation.rejectionReason, 'observation_identity_incomplete');
});

test('display aliases preserve the actual broker root and exact contract', () => {
  const descriptor = { symbol: 'DJI', ibkrSymbol: 'INDU', conId: 1935181, secType: 'IND', exchange: 'CME', provider: 'auto' };
  const value = quote({ symbol: 'DJI', providerSymbol: 'INDU', providerRootSymbol: 'INDU', conid: 1935181, secType: 'IND', exchange: 'CME' }, { instrument: descriptor });
  assert.equal(validate(value, { instrument: descriptor }).valid, true);
});

test('dated contracts bind month, trading class and multiplier as well as root', () => {
  const descriptor = { symbol: 'CL', secType: 'FUT', exchange: 'NYMEX', provider: 'ibkr', contractMonth: '202609', tradingClass: 'CL', multiplier: '1000' };
  const fields = { symbol: 'CL', providerRootSymbol: 'CL', providerSymbol: 'CLU6', secType: 'FUT', exchange: 'NYMEX', lastTradeDateOrContractMonth: '20260921', tradingClass: 'CL', multiplier: '1000' };
  assert.equal(validate(quote(fields, { instrument: descriptor }), { instrument: descriptor }).valid, true);
  const wrongMonth = quote({ ...fields, lastTradeDateOrContractMonth: '20261020' }, { instrument: descriptor });
  assert.equal(wrongMonth.observation.rejectionReason, 'provider_identity_mismatch');
});

test('account scopes cannot be reused for another account or for unscoped market data', () => {
  const value = quote({}, { scope: 'account', accountId: 'account-a' });
  assert.equal(validate(value, { scope: 'account', accountId: 'account-a' }).valid, true);
  assert.equal(validate(value, { scope: 'account', accountId: 'account-b' }).rejectionReason, 'observation_account_mismatch');
  assert.equal(validate(value).rejectionReason, 'observation_account_mismatch');
  assert.equal(quote({}, { scope: 'market', accountId: 'account-a' }).observation.valid, false);
  assert.equal(quote({ accountId: 'account-b' }, { scope: 'account', accountId: 'account-a' }).observation.rejectionReason, 'observation_account_mismatch');
});

test('generation mismatch, missing generation and disconnect reject otherwise current prices', () => {
  assert.equal(validate(quote(), { connectionGeneration: 8 }).rejectionReason, 'observation_generation_mismatch');
  assert.equal(validate(quote(), { connected: false }).rejectionReason, 'provider_disconnected');
  assert.equal(quote({}, { connectionGeneration: null }).observation.rejectionReason, 'observation_generation_missing');
});

test('live unknown, frozen, delayed-frozen, mock and crossed observations fail closed', () => {
  for (const fields of [{ dataType: 'unknown' }, { dataType: 'frozen' }, { dataType: 'delayed_frozen' }, { mock: true }, { entitlementStatus: 'unknown' }, { bid: 102, ask: 100 }]) {
    const value = quote(fields);
    assert.equal(value.valid, false, JSON.stringify(fields));
    assert.ok(value.observation.rejectionReason);
  }
});

test('genuine delayed data stays a delayed reference, and cannot be relabeled live', () => {
  const value = quote({ dataType: 'delayed', entitlementStatus: 'delayed' });
  assert.equal(validate(value).valid, true);
  assert.equal(value.observation.classification, 'delayed_reference');
  assert.equal(validate({ ...value, dataType: 'live', entitlementStatus: 'live' }).rejectionReason, 'observation_source_mismatch');
});

test('CNBC session Treasury yields are delayed references that expire, never live', () => {
  const raw = { symbol: 'UST2Y', source: 'cnbc', dataType: 'delayed', timestamp: new Date(observed).toISOString(),
    price: '4.693', sourceSeriesId: 'US2Y', observationFrequency: 'intraday', executable: false, displayOnly: true };
  const value = withQuoteObservation(raw, { instrument: 'UST2Y', receivedAt: receipt });
  assert.equal(validateQuoteObservation(value, { now: receipt }).valid, true);
  assert.equal(value.observation.classification, 'delayed_reference');
  assert.notEqual(value.expiresAt, null);
  assert.equal(buildQuoteMetadata(value).availability, 'delayed');
  assert.equal(withQuoteObservation({ ...raw, dataType: 'live' }, { receivedAt: receipt }).observation.valid, false);
});

test('dated FRED references keep source dates and no executable expiry, including negative rates', () => {
  const value = withQuoteObservation({ symbol: 'RATE', source: 'fred', dataType: 'historical', timestamp: '2020-01-01T00:00:00Z', price: '-0.5' }, { instrument: 'RATE', receivedAt: receipt });
  assert.equal(validateQuoteObservation(value, { now: receipt }).valid, true);
  assert.equal(value.observation.classification, 'historical_reference');
  assert.equal(value.observation.connectionGeneration, null);
  assert.equal(value.expiresAt, null);
});

test('official sovereign publications are historical references only and retain their series provenance', () => {
  for (const source of ['bundesbank', 'japan_mof', 'bank_of_england']) {
    const raw = { symbol: 'RATE', source, dataType: 'historical', timestamp: '2026-09-23T00:00:00Z',
      price: '-0.5', observationFrequency: 'daily', sourceSeriesId: 'official-series',
      sourceInstrument: 'Published 10-year yield', executable: false, displayOnly: true };
    const value = withQuoteObservation(raw, { instrument: 'RATE', receivedAt: receipt });
    assert.equal(validateQuoteObservation(value, { now: receipt }).valid, true);
    assert.equal(value.observation.classification, 'historical_reference');
    assert.equal(value.sourceSeriesId, 'official-series');
    assert.equal(buildQuoteMetadata(value).availability, 'historical');
    for (const bad of [{ dataType: 'live' }, { dataType: 'delayed' }, { mock: true }, { seeded: true }, { cacheOnly: true }]) {
      assert.equal(withQuoteObservation({ ...raw, ...bad }, { receivedAt: receipt }).observation.valid, false);
    }
  }
});

test('new overview crypto observations expire after two hours without extending their original timestamps', () => {
  for (const symbol of ['DOGE', 'LINK', 'DOGE-USD', 'LINK-USD']) {
    const descriptor = { symbol, secType: 'CRYPTO', provider: 'yahoo', yahooSymbol: symbol.endsWith('-USD') ? symbol : `${symbol}-USD` };
    const value = withQuoteObservation({
      symbol, price: 0.08477, source: 'yahoo', dataType: 'delayed',
      timestamp: new Date(observed).toISOString(),
    }, { instrument: descriptor, receivedAt: receipt });
    assert.equal(value.expiresAt, new Date(observed + 2 * 60 * 60_000).toISOString());
    assert.equal(validateQuoteObservation(value, { instrument: descriptor, now: observed + 2 * 60 * 60_000 - 1 }).valid, true);
    assert.equal(validateQuoteObservation(value, { instrument: descriptor, now: observed + 2 * 60 * 60_000 + 1 }).rejectionReason, 'observation_expired');
  }
});

test('overview daily history requests the exact crypto pairs and ETF identities instead of colliding stock symbols', async () => {
  const server = fs.readFileSync(path.resolve(__dirname, '../../../../server.js'), 'utf8');
  const calls = [];
  const context = {
    FRED_SERIES: {},
    INTL_BOND_FRED_FALLBACK: {},
    axios: { get: async (url) => {
      calls.push(url);
      return { data: { chart: { result: [{
        timestamp: [1700000000, 1700086400],
        indicators: { quote: [{ close: [0.08412, 0.08477] }] },
      }] } } };
    } },
  };
  const functions = ['getTickerMapping', 'symbolIsYahooRateProxy', 'scaleRateProxyValue', 'fetchYahooDailyClosesSeries']
    .map((name) => server.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`))[0]);
  const mappings = server.match(/const YAHOO_TICKER_MAP = \{[^]*?\n\};/)[0];
  vm.runInNewContext(`${mappings}\n${functions.join('\n')}\nthis.fetchHistory = fetchYahooDailyClosesSeries;`, context);

  for (const [symbol, providerSymbol] of [['DOGE', 'DOGE-USD'], ['LINK', 'LINK-USD'], ['XLF', 'XLF'], ['VNQ', 'VNQ']]) {
    const history = await context.fetchHistory(symbol);
    assert.equal(calls.at(-1), `https://query1.finance.yahoo.com/v8/finance/chart/${providerSymbol}`);
    assert.equal(history[1].close, 0.08477);
  }
});

test('raw normalization remains context-free, while final API/WS delivery requires an envelope', () => {
  const raw = normalizeIbkrRaw({ symbol: 'SPY', secType: 'STK', exchange: 'SMART', currency: 'USD', timestamp: new Date().toISOString(), last: 100, dataType: 'live', entitlementStatus: 'live' });
  assert.equal(raw.valid, true);
  assert.equal(validateQuoteObservation(raw).rejectionReason, 'observation_envelope_missing');
  const server = fs.readFileSync(path.resolve(__dirname, '../../../../server.js'), 'utf8');
  const functionSource = server.match(/function isQuoteUsableNow\(quote, instrument\) \{[\s\S]*?\n\}/)[0];
  const context = { validateQuoteObservation, buildQuoteMetadata, getProviderStatusSnapshot: () => ({ ibkr: { connected: true, connectionGeneration: 7 } }) };
  vm.runInNewContext(`${functionSource}; this.deliver = isQuoteUsableNow;`, context);
  assert.equal(context.deliver(toLegacyQuote(raw), 'SPY'), false);
  assert.equal(context.deliver(toLegacyQuote(quote()), instrument), true);
  assert.equal(context.deliver(toLegacyQuote(quote()), { ...instrument, conId: 456 }), false);
});

test('invalid validation clocks and noncanonical source spellings cannot bypass broker checks', () => {
  assert.equal(validate(quote(), { now: NaN }).rejectionReason, 'validation_time_invalid');
  assert.equal(quote({ source: 'IBKR', entitlementStatus: 'unknown' }).observation.valid, false);
});

test('prices and contract ids reject coercible nonnumeric inputs', () => {
  for (const invalid of [true, false, [], [123], {}, { valueOf: () => 123 }, '', ' ', '100x', '0x64', '100\n', ' 100']) {
    assert.equal(quote({ mark: invalid }).valid, false);
    assert.equal(quote({ conid: invalid }).valid, false);
    const reference = withQuoteObservation({ symbol: 'RATE', source: 'fred', dataType: 'historical', timestamp: '2020-01-01', price: invalid }, { receivedAt: receipt });
    assert.equal(reference.valid, false);
  }
  assert.equal(validate(quote({ mark: '100.25', conid: '123' })).valid, true);
});

test('raw normalization cannot launder coercible price values into verified numbers', () => {
  for (const invalid of [true, [], [100], { valueOf: () => 100 }, '100x', ' ']) {
    const raw = normalizeIbkrRaw({ symbol: 'SPY', secType: 'STK', exchange: 'SMART', currency: 'USD', timestamp: new Date().toISOString(), last: 100, bid: invalid, ask: 101, dataType: 'live', entitlementStatus: 'live' });
    assert.equal(raw.valid, false);
    assert.match(raw.warning, /invalid_numeric_value/);
  }
});
