'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createClassificationPiece } = require('./classification.cjs');

const table = { source: 'Reviewed', reviewedAt: '2026-11-22', securities: { TLT: ['Fixed income', 'Rates', 'US'], BAD: ['Equity', '', 'US'] } };

test('a reviewed security carries its three labels with source and date', async () => {
  const row = (await createClassificationPiece({ table }).loadMany(['TLT'])).get('TLT');
  assert.equal(row.status, 'available');
  assert.deepEqual([row.assetClass.value, row.group.value, row.region.value], ['Fixed income', 'Rates', 'US']);
  assert.equal(row.group.asOf, '2026-11-22');
});

test('an unlabelled or half-labelled security is unavailable, never guessed', async () => {
  const rows = await createClassificationPiece({ table }).loadMany(['ZZZ', 'BAD']);
  for (const symbol of ['ZZZ', 'BAD']) {
    assert.equal(rows.get(symbol).status, 'unavailable');
    assert.equal(rows.get(symbol).assetClass.reason, 'not-labelled');
  }
});

test('every bundled label is complete', async () => {
  const { securities } = require('../../../constants/securityClassifications.json');
  const rows = await createClassificationPiece().loadMany(Object.keys(securities));
  assert.deepEqual([...rows].filter(([, row]) => row.status !== 'available').map(([symbol]) => symbol), []);
});
