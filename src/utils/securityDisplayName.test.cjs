const { test } = require('node:test');
const assert = require('node:assert/strict');
const { securityDisplayName, continuousInstrumentName } = require('./securityDisplayName.cjs');

test('re-cases SEC directory names without rewording them', () => {
  assert.equal(securityDisplayName('COSTCO WHOLESALE CORP /NEW'), 'Costco Wholesale Corp');
  assert.equal(securityDisplayName('GOLDMAN SACHS GROUP INC'), 'Goldman Sachs Group Inc');
  assert.equal(securityDisplayName('JPMORGAN CHASE & CO'), 'Jpmorgan Chase & Co');
  assert.equal(securityDisplayName('SPDR S&P 500 ETF TRUST'), 'SPDR S&P 500 ETF Trust');
  assert.equal(securityDisplayName('BANK OF AMERICA CORP /DE/'), 'Bank of America Corp');
  assert.equal(securityDisplayName('MCDONALDS CORP'), 'McDonalds Corp');
  assert.equal(securityDisplayName('3M CO'), '3M Co');
  assert.equal(securityDisplayName('BP PLC'), 'BP PLC');
  assert.equal(securityDisplayName('COCA-COLA CO'), 'Coca-Cola Co');
});

test('keeps provider names that already carry case', () => {
  assert.equal(securityDisplayName('Roundhill Memory ETF'), 'Roundhill Memory ETF');
  assert.equal(securityDisplayName('AST SpaceMobile, Inc.'), 'AST SpaceMobile, Inc.');
  assert.equal(securityDisplayName('  The Goldman  Sachs Group, Inc. '), 'The Goldman Sachs Group, Inc.');
});

test('rejects empty names', () => {
  for (const value of [null, undefined, '', '   ', 42]) assert.equal(securityDisplayName(value), null);
});

test('names a futures instrument without its rolling contract month', () => {
  assert.equal(continuousInstrumentName('Gold Dec 26'), 'Gold');
  assert.equal(continuousInstrumentName('Corn Futures,Dec-2026'), 'Corn Futures');
  assert.equal(continuousInstrumentName('Bitcoin USD'), 'Bitcoin USD');
});
