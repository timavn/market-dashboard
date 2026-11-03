const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSecurityIdentitiesHandler } = require('./securityIdentities.cjs');
const {
  createExposureLabSecurityIdentityResolver,
  SEC_NAME_SOURCE,
  YAHOO_NAME_SOURCE,
} = require('../services/exposureLabSecurityIdentity.cjs');

const response = () => ({
  headers: {}, code: 200, body: null,
  set(key, value) { this.headers[key] = value; return this; },
  status(code) { this.code = code; return this; },
  json(body) { this.body = body; return this; },
});

test('returns only verified descriptive names for exact normalized tickers outside the research roster', async () => {
  let received;
  const handler = createSecurityIdentitiesHandler({ resolver: { resolve: async universe => {
    received = universe;
    return { rows: [{ ticker: 'YCL', name: 'ProShares Ultra Yen', nameVerified: true, nameSource: YAHOO_NAME_SOURCE, price: 99, signal: 'BULLISH' }] };
  } } });
  const res = response();
  await handler({ query: { symbols: ' ycl, YCL' } }, res);
  assert.deepEqual(received.rows, [{ ticker: 'YCL', discoveryState: 'structured', confidenceKinds: ['structured_list'], existingUniverse: false }]);
  assert.equal(res.code, 200);
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.deepEqual(res.body, { historicalOnly: true, executable: false, status: 'available', rows: [
    { ticker: 'YCL', name: 'ProShares Ultra Yen', nameVerified: true, nameSource: YAHOO_NAME_SOURCE, displayName: 'ProShares Ultra Yen', displayNameSource: YAHOO_NAME_SOURCE },
  ] });
});

test('uses the existing SEC/Yahoo resolver for requested names absent from the SEC directory', async () => {
  const resolver = createExposureLabSecurityIdentityResolver({ httpClient: { get: async url => {
    if (url.includes('sec.gov')) return { data: { fields: ['ticker', 'name'], data: [['RH', 'RH']] } };
    const ticker = url.endsWith('/YCL') ? 'YCL' : 'RXL';
    return { data: { chart: { result: [{ meta: { symbol: ticker, instrumentType: 'ETF', longName: ticker === 'YCL' ? 'ProShares Ultra Yen' : 'ProShares Ultra Health Care' } }] } } };
  } } });
  const res = response();
  await createSecurityIdentitiesHandler({ resolver })({ query: { symbols: 'YCL,RXL,RH' } }, res);
  assert.equal(res.body.status, 'available');
  assert.deepEqual(res.body.rows.map(row => [row.ticker, row.nameSource]), [['YCL', YAHOO_NAME_SOURCE], ['RXL', YAHOO_NAME_SOURCE], ['RH', SEC_NAME_SOURCE]]);
});

test('rejects malformed, absent, repeated-query and oversized symbol requests before provider access', async () => {
  let reads = 0;
  const handler = createSecurityIdentitiesHandler({ resolver: { resolve: async () => { reads += 1; } } });
  for (const symbols of [undefined, '', 'DBMF,,YCL', 'DBMF;bad', ['DBMF'], {}, 'A'.repeat(33), Array.from({ length: 51 }, (_, index) => `S${index}`).join(',')]) {
    const res = response();
    await handler({ query: { symbols } }, res);
    assert.equal(res.code, 400);
    assert.deepEqual(res.body.rows, []);
  }
  assert.equal(reads, 0);
});

test('prefers an exact ETF or mutual-fund name over a SEC trust registrant and retains SEC when refinement is unsupported', async () => {
  const tickers = ['YCL', 'FUND', 'BANK', 'FAILED', 'MISMATCH'];
  const resolver = {
    resolve: async () => ({ rows: tickers.map(ticker => ({ ticker, name: `${ticker} Trust`, nameVerified: true, nameSource: SEC_NAME_SOURCE })) }),
    loadYahooIdentity: async ticker => {
      if (ticker === 'FAILED') throw new Error('private provider error');
      return { status: 'available', identity: { ticker: ticker === 'MISMATCH' ? 'OTHER' : ticker,
        name: ticker === 'YCL' ? 'ProShares Ultra Yen' : `${ticker} Provider Name`, nameSource: YAHOO_NAME_SOURCE,
        instrumentType: ticker === 'BANK' ? 'EQUITY' : ticker === 'FUND' ? 'MUTUALFUND' : 'ETF' } };
    },
  };
  const res = response();
  await createSecurityIdentitiesHandler({ resolver })({ query: { symbols: tickers.join(',') } }, res);
  assert.deepEqual(res.body.rows.map(row => [row.ticker, row.name, row.nameSource]), [
    ['YCL', 'ProShares Ultra Yen', YAHOO_NAME_SOURCE], ['FUND', 'FUND Provider Name', YAHOO_NAME_SOURCE],
    ['BANK', 'BANK Trust', SEC_NAME_SOURCE], ['FAILED', 'FAILED Trust', SEC_NAME_SOURCE], ['MISMATCH', 'MISMATCH Trust', SEC_NAME_SOURCE],
  ]);
});

test('partial results omit catalog, unverified, malformed, unrequested and flagged names', async () => {
  const verified = { ticker: 'DBMF', name: 'iMGP DBi Managed Futures Strategy ETF', nameVerified: true, nameSource: YAHOO_NAME_SOURCE };
  const res = response();
  const rows = [verified, { ...verified, ticker: 'YCL', nameVerified: false },
    { ...verified, ticker: 'RXL', nameSource: 'Dashboard security catalog' },
    { ...verified, ticker: 'FAKE', mock: true }, { ...verified, ticker: 'NOTREQUESTED' },
    { ...verified, ticker: 'EMPTY', name: null }];
  await createSecurityIdentitiesHandler({ resolver: { resolve: async () => ({ rows, identityDirectory: { status: 'partial' } }) } })({ query: { symbols: 'DBMF,YCL,RXL,FAKE,EMPTY' } }, res);
  assert.equal(res.code, 200);
  assert.equal(res.body.status, 'partial');
  assert.deepEqual(res.body.rows, [{ ...verified, displayName: verified.name, displayNameSource: verified.nameSource }]);
});

test('fund identity uses the exact held ticker independently of research futures aliases and caches', async () => {
  const calls = [];
  const resolver = createExposureLabSecurityIdentityResolver({ resolveYahooSymbol: () => 'ZC=F', httpClient: { get: async url => {
    calls.push(url);
    if (url.includes('sec.gov')) return { data: { fields: ['ticker', 'name'], data: [['CORN', 'Teucrium Commodity Trust']] } };
    const exact = url.endsWith('/CORN');
    return { data: { chart: { result: [{ meta: { symbol: exact ? 'CORN' : 'ZC=F', instrumentType: exact ? 'ETF' : 'FUTURE',
      longName: exact ? 'Teucrium Corn Fund' : 'Corn Futures' } }] } } };
  } } });
  const alias = await resolver.loadYahooIdentity('CORN');
  assert.equal(alias.identity.name, 'Corn Futures');
  const handler = createSecurityIdentitiesHandler({ resolver });
  const res = response();
  await handler({ query: { symbols: 'CORN' } }, res);
  assert.deepEqual(res.body.rows, [{ ticker: 'CORN', name: 'Teucrium Corn Fund', nameVerified: true, nameSource: YAHOO_NAME_SOURCE, displayName: 'Teucrium Corn Fund', displayNameSource: YAHOO_NAME_SOURCE }]);
  assert.equal(calls.filter(url => url.endsWith('/CORN')).length, 1);
  assert.equal((await resolver.loadYahooIdentity('CORN')).identity.name, 'Corn Futures');
  const second = response();
  await handler({ query: { symbols: 'CORN' } }, second);
  assert.deepEqual(second.body, res.body);
  assert.equal(calls.filter(url => url.endsWith('/CORN')).length, 1);
});

test('unavailable identity providers and rejected reads return quiet empty results', async () => {
  for (const resolve of [async () => { throw new Error('private provider details'); },
    async () => ({ rows: [], identityDirectory: { status: 'unavailable', reason: 'private provider details' } }),
    async () => ({ rows: [{ ticker: 'YCL', name: 'ProShares Ultra Yen', nameVerified: true, nameSource: YAHOO_NAME_SOURCE }], offline: true })]) {
    const res = response();
    await createSecurityIdentitiesHandler({ resolver: { resolve } })({ query: { symbols: 'YCL' } }, res);
    assert.equal(res.code, 503);
    assert.deepEqual(res.body, { historicalOnly: true, executable: false, status: 'unavailable', rows: [] });
  }
});

test('a readable display name is cited to its own source, not to the SEC directory', async () => {
  const resolver = {
    resolve: async () => ({ rows: [{ ticker: 'COST', name: 'COSTCO WHOLESALE CORP /NEW', nameVerified: true, nameSource: SEC_NAME_SOURCE },
      { ticker: 'GS', name: 'GOLDMAN SACHS GROUP INC', nameVerified: true, nameSource: SEC_NAME_SOURCE }] }),
    loadYahooIdentity: async ticker => (ticker === 'COST'
      ? { status: 'available', identity: { ticker, name: 'Costco Wholesale Corporation', nameSource: YAHOO_NAME_SOURCE, instrumentType: 'EQUITY' } }
      : { status: 'unavailable', identity: null }),
  };
  const res = response();
  await createSecurityIdentitiesHandler({ resolver })({ query: { symbols: 'COST,GS' } }, res);
  assert.deepEqual(res.body.rows.map(row => [row.ticker, row.name, row.nameSource, row.displayName, row.displayNameSource]), [
    ['COST', 'COSTCO WHOLESALE CORP /NEW', SEC_NAME_SOURCE, 'Costco Wholesale Corporation', YAHOO_NAME_SOURCE],
    ['GS', 'GOLDMAN SACHS GROUP INC', SEC_NAME_SOURCE, 'Goldman Sachs Group Inc', SEC_NAME_SOURCE],
  ]);
});
