const test = require('node:test');
const assert = require('node:assert/strict');
const { pcaOutOfScopeReason, scopeCoverage } = require('./pcaScope.cjs');

test('classifies prediction contracts from explicit broker metadata regardless of product familiarity', () => {
  for (const holding of [
    { symbol: 'UNFAMILIAR', secType: 'FOP', exchange: 'FORECASTX' },
    { symbol: 'UNFAMILIAR', primaryExchange: 'forecastex' },
    { symbol: 'UNFAMILIAR', venue: ' kalshi ' },
    { symbol: 'UNFAMILIAR', securityType: 'event' },
    { symbol: 'UNFAMILIAR', isPredictionMarket: true },
    { symbol: 'ES', secType: 'FOP', localSymbol: 'FES_082126_7700_YES' },
    { symbol: 'COMCO', secType: 'FOP', localSymbol: 'COMCO_081326_82_NO' },
    { symbol: 'CPIY', secType: 'FOP' },
    { symbol: 'KXCPIYOY-26JUN-T4.2_YES' },
    { symbol: 'KXINXU-26JUL21H1600-T7450_YES' },
    { symbol: 'KXWTIW-26JUL2414-B84.50_YES' },
    { symbol: 'KXFEDDECISION-26JUL_YES' },
  ]) assert.equal(pcaOutOfScopeReason(holding), 'prediction_contract', JSON.stringify(holding));
});

test('retains equities, ADRs, and ETFs without treating ticker or description resemblance as evidence', () => {
  for (const holding of [
    { symbol: 'EXPGY', secType: 'STK', exchange: 'PINK' },
    { symbol: 'KXI', secType: 'ETF' },
    { symbol: 'KXI', secType: 'STK' },
    { symbol: 'NO', securityType: 'EQUITY' },
    { symbol: 'YES', assetType: 'STOCK' },
    { symbol: 'SPY', secType: 'STK', description: 'YES NO CPIY KXNOTACONTRACT' },
    { symbol: 'SPY', description: 'YES NO CPIY KXNOTACONTRACT' },
    { symbol: 'KXI' },
    { symbol: 'NO' },
    { symbol: 'YES' },
  ]) assert.equal(pcaOutOfScopeReason(holding), null, JSON.stringify(holding));
});

test('ordinary derivatives and other explicit non-equities are outside scope but unknown types remain gaps', () => {
  for (const secType of ['OPT', 'FOP', 'FUT', 'CONTFUT', 'CASH', 'BOND', 'BILL', 'IND', 'CFD', 'FUND', 'CRYPTO']) {
    assert.equal(pcaOutOfScopeReason({ symbol: 'ES', secType }), 'non_equity_instrument');
  }
  assert.equal(pcaOutOfScopeReason({ symbol: 'EXPGY' }), null);
  assert.equal(pcaOutOfScopeReason({ symbol: 'EXPGY', secType: 'UNKNOWN' }), null);
});

test('projects legacy coverage without erasing genuine equity or unclassified gaps or changing weights', () => {
  const coverage = {
    holdingCount: 8, modeledCount: 4, modeledGrossWeight: 1.27, totalGrossWeight: 1.49, complete: false,
    excluded: [
      { id: 'EVENT', symbol: 'ES', reason: 'prediction_contract_unmodeled' },
      { id: 'OPT', symbol: 'SPY', secType: 'OPT', reason: 'unsupported_instrument' },
      { id: 'UNKNOWN', symbol: 'UNKNOWN', reason: 'unsupported_instrument' },
      { id: 'EXPGY', symbol: 'EXPGY', reason: 'official_close_unavailable' },
    ],
  };
  const before = JSON.stringify(coverage);
  const scoped = scopeCoverage(coverage);
  assert.equal(JSON.stringify(coverage), before);
  assert.equal(scoped.scope, 'equities-etfs');
  assert.equal(scoped.holdingCount, 6);
  assert.equal(scoped.modeledCount, 4);
  assert.equal(scoped.modeledGrossWeight, 1.27);
  assert.equal(scoped.complete, false);
  assert.equal(Object.hasOwn(scoped, 'totalGrossWeight'), false);
  assert.deepEqual(scoped.excluded.map(row => row.id), ['UNKNOWN', 'EXPGY']);
  assert.deepEqual(scoped.outOfScope.map(row => row.reason), ['prediction_contract', 'non_equity_instrument']);
  assert.deepEqual(scopeCoverage(scoped), scoped);
});

test('complete equity coverage is restored when the only missing rows were known prediction contracts', () => {
  const scoped = scopeCoverage({ holdingCount: 6, modeledCount: 5, modeledGrossWeight: 1.2,
    complete: false, excluded: [{ id: 'EVENT', reason: 'prediction_contract_unmodeled' }] });
  assert.equal(scoped.holdingCount, 5);
  assert.equal(scoped.complete, true);
  assert.equal(scoped.modeledGrossWeight, 1.2);
});

test('preserves current scoped counts, gross weight, and ignored rows without double subtraction', () => {
  const coverage = { scope: 'equities-etfs', holdingCount: 5, modeledCount: 5, modeledGrossWeight: 0.8,
    totalGrossWeight: 0.8, complete: true, excluded: [],
    outOfScope: [{ id: 'EVENT', symbol: 'ES', reason: 'prediction_contract' }] };
  assert.deepEqual(scopeCoverage(coverage), coverage);
  assert.notEqual(scopeCoverage(coverage).outOfScope[0], coverage.outOfScope[0]);
});
