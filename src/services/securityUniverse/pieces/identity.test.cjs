const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createExposureLabSecurityIdentityResolver, SEC_NAME_SOURCE, YAHOO_NAME_SOURCE } = require('../../exposureLabSecurityIdentity.cjs');
const { createIdentityPiece } = require('./identity.cjs');

const SEC = [
  ['COST', 'COSTCO WHOLESALE CORP /NEW'], ['GS', 'GOLDMAN SACHS GROUP INC'], ['LULU', 'LULULEMON ATHLETICA INC.'],
  ['BTC', 'Grayscale Bitcoin Mini Trust (BTC)'], ['GOLD', 'GOLD COM INC'], ['CORN', 'Teucrium Commodity Trust'], ['BRK-B', 'BERKSHIRE HATHAWAY INC'],
];
const YAHOO = {
  COST: ['EQUITY', 'Costco Wholesale Corporation'], LULU: ['EQUITY', 'lululemon athletica inc.'], DRAM: ['ETF', 'Roundhill Memory ETF'],
  'BRK-B': ['EQUITY', 'Berkshire Hathaway Inc.'], '^GSPC': ['INDEX', 'S&P 500'], BTC: ['ETF', 'Grayscale Bitcoin Mini Trust ETF'],
  'BTC-USD': ['CRYPTOCURRENCY', 'Bitcoin USD'], 'GC=F': ['FUTURE', 'Gold Dec 26'], GOLD: ['EQUITY', 'Gold.com, Inc.'],
  CORN: ['ETF', 'Teucrium Corn Fund'], 'ZC=F': ['FUTURE', 'Corn Futures,Dec-2026'],
};
const PRICED = { BTC: 'BTC-USD', GOLD: 'GC=F', SPX: '^GSPC', CORN: 'ZC=F' };
// The server's resolveHistoryInstrument, reduced to these tickers.
const resolveInstrument = symbol => {
  const listingSymbol = /^[A-Z]{1,5}\.[AB]$/.test(symbol) ? symbol.replace('.', '-') : symbol;
  return { yahooSymbol: PRICED[symbol] || listingSymbol, listingSymbol };
};

function resolverWith({ secFails = false, yahooFails = [] } = {}) {
  const calls = [];
  const resolver = createExposureLabSecurityIdentityResolver({
    resolveYahooSymbol: ticker => resolveInstrument(ticker).yahooSymbol,
    now: () => Date.parse('2026-10-31T15:00:00Z'),
    httpClient: { get: async url => {
      calls.push(url);
      if (url.includes('sec.gov')) {
        if (secFails) throw new Error('SEC offline');
        return { data: { fields: ['cik', 'name', 'ticker', 'exchange'], data: SEC.map(([ticker, name], index) => [index + 1, name, ticker, 'NYSE']) } };
      }
      const symbol = decodeURIComponent(url.split('/').pop());
      if (yahooFails.includes(symbol)) throw Object.assign(new Error('Yahoo 500'), { response: { status: 500 } });
      if (!YAHOO[symbol]) throw Object.assign(new Error('Not found'), { response: { status: 404 } });
      const [instrumentType, longName] = YAHOO[symbol];
      return { data: { chart: { result: [{ meta: { symbol, instrumentType, longName, exchangeName: 'NMS' } }] } } };
    } },
  });
  return { resolver, calls };
}

test('names each listed security, with a readable name and its own source and date', async () => {
  const { resolver } = resolverWith({ yahooFails: ['GS'] });
  const piece = createIdentityPiece({ resolver, resolveInstrument });
  const identities = await piece.loadMany(['COST', 'GS', 'LULU', 'DRAM', 'BRK.B']);
  const read = symbol => identities.get(symbol);

  assert.equal(read('COST').name.value, 'COSTCO WHOLESALE CORP /NEW');
  assert.equal(read('COST').name.source, SEC_NAME_SOURCE);
  assert.equal(read('COST').name.asOf, '2026-10-31T15:00:00.000Z');
  assert.equal(read('COST').displayName.value, 'Costco Wholesale Corporation');
  assert.equal(read('COST').displayName.source, YAHOO_NAME_SOURCE);
  assert.equal(read('COST').instrumentType.value, 'EQUITY');
  assert.equal(read('COST').status, 'available');
  // Yahoo unavailable: the SEC name re-cased, never reworded.
  assert.deepEqual([read('GS').displayName.value, read('GS').displayName.source, read('GS').displayName.recased], ['Goldman Sachs Group Inc', SEC_NAME_SOURCE, true]);
  assert.equal(read('GS').instrumentType.status, 'unavailable');
  assert.equal(read('GS').status, 'partial');
  assert.equal(read('LULU').displayName.value, 'lululemon athletica inc.');
  // An ETF Pro / alert ticker SEC does not list.
  assert.deepEqual([read('DRAM').name.value, read('DRAM').name.source, read('DRAM').instrumentType.value], ['Roundhill Memory ETF', YAHOO_NAME_SOURCE, 'ETF']);
  assert.equal(read('BRK.B').displayName.value, 'Berkshire Hathaway Inc.');
  for (const symbol of ['COST', 'GS', 'LULU', 'DRAM', 'BRK.B']) assert.equal(read(symbol).priced, null, symbol);
});

test('a ticker priced as another instrument keeps its listed name and names the priced one separately', async () => {
  const { resolver } = resolverWith();
  const identities = await createIdentityPiece({ resolver, resolveInstrument }).loadMany(['BTC', 'GOLD', 'CORN', 'SPX']);
  const btc = identities.get('BTC');
  assert.equal(btc.name.value, 'Grayscale Bitcoin Mini Trust ETF');
  assert.deepEqual(btc.priced.value, { name: 'Bitcoin USD', yahooSymbol: 'BTC-USD', instrumentType: 'CRYPTOCURRENCY' });
  assert.equal(btc.priced.match, 'different-instrument');
  assert.equal(identities.get('GOLD').name.value, 'GOLD COM INC');
  assert.equal(identities.get('GOLD').displayName.value, 'Gold.com, Inc.');
  assert.deepEqual(identities.get('GOLD').priced.value, { name: 'Gold', yahooSymbol: 'GC=F', instrumentType: 'FUTURE' });
  assert.equal(identities.get('CORN').name.value, 'Teucrium Corn Fund');
  assert.equal(identities.get('CORN').priced.value.name, 'Corn Futures');
  // An index SEC does not list is named by the instrument it is priced as.
  assert.equal(identities.get('SPX').name.value, 'S&P 500');
  assert.equal(identities.get('SPX').priced, null);
});

test('an unavailable SEC directory or a flagged row is unavailable with a reason, never a catalog name', async () => {
  const { resolver } = resolverWith({ secFails: true });
  const identities = await createIdentityPiece({ resolver, resolveInstrument }).loadMany(['COST']);
  assert.equal(identities.get('COST').status, 'unavailable');
  assert.equal(identities.get('COST').name.reason, 'identity-directory-unavailable');

  const flaggedRows = { resolve: async () => ({ rows: [
    { ticker: 'AAA', name: 'Seeded Name', nameVerified: true, nameSource: SEC_NAME_SOURCE, seeded: true },
    { ticker: 'BBB', name: 'Catalog Name', nameVerified: true, nameSource: 'Dashboard security catalog' },
    { ticker: 'CCC', name: 'Unverified', nameVerified: false, nameSource: SEC_NAME_SOURCE },
  ] }) };
  const rejected = await createIdentityPiece({ resolver: flaggedRows }).loadMany(['AAA', 'BBB', 'CCC']);
  for (const symbol of ['AAA', 'BBB', 'CCC']) {
    assert.equal(rejected.get(symbol).name.status, 'unavailable', symbol);
    assert.equal(rejected.get(symbol).name.reason, 'no-verified-provider-identity');
  }
});
