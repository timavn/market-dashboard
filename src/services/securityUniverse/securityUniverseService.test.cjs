const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSecurityUniverseService } = require('./securityUniverseService.cjs');
const { available, unavailable, withStatus } = require('./fields.cjs');

function fakePieces({ identityName = symbol => `${symbol} Corp`, identityFails = () => false } = {}) {
  const calls = { identity: [], research: [], stance: [], risk: [], activity: [] };
  const map = (symbols, build) => new Map(symbols.map(symbol => [symbol, build(symbol)]));
  return {
    calls,
    identity: { loadMany: async symbols => {
      calls.identity.push(symbols);
      if (identityFails()) return map(symbols, () => withStatus({ name: unavailable('identity-directory-unavailable'), displayName: unavailable('identity-directory-unavailable'), priced: null }));
      return map(symbols, symbol => withStatus({ name: available(identityName(symbol), { source: 'SEC', asOf: '2026-10-31' }),
        displayName: available(identityName(symbol), { source: 'SEC', asOf: '2026-10-31' }), priced: null }));
    } },
    research: { loadMany: async symbols => { calls.research.push(symbols); throw new Error('security intelligence offline'); } },
    stance: { loadMany: async symbols => { calls.stance.push(symbols); return map(symbols, () => withStatus({ calls: available([], { asOf: '2026-10-31T14:59:00Z' }) })); } },
    marketHistory: {
      risk: async symbols => { calls.risk.push(symbols); return map(symbols, () => withStatus({ atr14: available(2, { asOf: '2026-10-30' }), sizing: unavailable('Refresh daily history') })); },
      activity: async symbols => { calls.activity.push(symbols); return map(symbols, () => withStatus({ zScore20: available(1.2, { asOf: '2026-10-30' }) })); },
    },
  };
}

test('composes every piece per ticker; a failed piece is unavailable and never blocks the others', async () => {
  const pieces = fakePieces();
  const universe = createSecurityUniverseService({ ...pieces, resolveInstrument: symbol => ({ yahooSymbol: symbol, listingSymbol: symbol }) });
  const record = await universe.load(['dram', 'LULU', 'DRAM', 'bad symbol!']);
  assert.deepEqual(Object.keys(record.rows), ['DRAM', 'LULU']);
  const dram = record.rows.DRAM;
  assert.equal(dram.identity.name.value, 'DRAM Corp');
  assert.deepEqual([dram.research.status, dram.research.trade.reason], ['unavailable', 'piece-unavailable']);
  assert.equal(dram.research.tail.reason, 'no-published-tail-source');
  assert.equal(dram.stance.status, 'available');
  assert.equal(dram.risk.status, 'partial');
  assert.equal(dram.activity.zScore20.value, 1.2);
  assert.deepEqual(dram.instrument, { yahooSymbol: 'DRAM', listingSymbol: 'DRAM' });
  assert.equal(record.status, 'partial');
  assert.deepEqual([record.historicalOnly, record.executable, record.schemaVersion], [true, false, 1]);
  assert.deepEqual(record.fields, ['identity', 'classification', 'research', 'stance', 'risk', 'activity']);
});

test('fields load only the pieces asked for, at most 50 tickers', async () => {
  const pieces = fakePieces();
  const universe = createSecurityUniverseService(pieces);
  const symbols = Array.from({ length: 60 }, (_, index) => `S${index}`);
  const record = await universe.load(symbols, { fields: ['identity'] });
  assert.equal(Object.keys(record.rows).length, 50);
  assert.deepEqual(Object.keys(record.rows.S0), ['symbol', 'instrument', 'identity']);
  assert.deepEqual([pieces.calls.research.length, pieces.calls.stance.length, pieces.calls.risk.length, pieces.calls.activity.length], [0, 0, 0, 0]);
  assert.equal(record.status, 'available');
});

test('identity is cached a day, a failure five minutes, and an expired value is never served', async () => {
  let clock = Date.parse('2026-10-31T15:00:00Z');
  let failing = false;
  const pieces = fakePieces({ identityFails: () => failing });
  const universe = createSecurityUniverseService({ ...pieces, now: () => clock });
  await universe.load(['COST'], { fields: ['identity'] });
  clock += 23 * 3600_000;
  assert.equal((await universe.load(['COST'], { fields: ['identity'] })).rows.COST.identity.name.value, 'COST Corp');
  assert.equal(pieces.calls.identity.length, 1, 'served from the cache within a day');
  clock += 2 * 3600_000;
  failing = true;
  const expired = await universe.load(['COST'], { fields: ['identity'] });
  assert.equal(expired.rows.COST.identity.status, 'unavailable', 'a failed refresh is unavailable, not the old name');
  assert.equal(expired.status, 'unavailable');
  failing = false;
  clock += 60_000;
  await universe.load(['COST'], { fields: ['identity'] });
  assert.equal(pieces.calls.identity.length, 2, 'the failure is held for five minutes');
  clock += 5 * 60_000;
  assert.equal((await universe.load(['COST'], { fields: ['identity'] })).rows.COST.identity.name.value, 'COST Corp');
  assert.equal(pieces.calls.identity.length, 3);
});

test('concurrent readers share one identity load, and the identities view reads the same cache', async () => {
  const pieces = fakePieces();
  const universe = createSecurityUniverseService(pieces);
  await Promise.all([universe.load(['GS', 'ASTS'], { fields: ['identity'] }), universe.load(['GS'], { fields: ['identity'] }), universe.identities(['ASTS'])]);
  assert.deepEqual(pieces.calls.identity, [['GS', 'ASTS']]);
  assert.equal((await universe.identities(['GS'])).get('GS').name.value, 'GS Corp');
  assert.equal(pieces.calls.identity.length, 1);
});

test('a partial identity is retried on the failure cadence, not kept for a day', async () => {
  let clock = Date.parse('2026-10-31T15:00:00Z');
  let yahooDown = true;
  const calls = [];
  const universe = createSecurityUniverseService({ now: () => clock, identity: { loadMany: async symbols => {
    calls.push(symbols);
    return new Map(symbols.map(symbol => [symbol, withStatus({
      name: available(yahooDown ? 'SELECT SECTOR SPDR TRUST' : 'The Energy Select Sector SPDR Fund', { source: yahooDown ? 'SEC' : 'Yahoo' }),
      instrumentType: yahooDown ? unavailable('listing-instrument-type-unverified') : available('ETF', { source: 'Yahoo' }), priced: null,
    })]));
  } } });
  assert.equal((await universe.identities(['XLE'])).get('XLE').status, 'partial');
  yahooDown = false;
  clock += 4 * 60_000;
  await universe.identities(['XLE']);
  assert.equal(calls.length, 1);
  clock += 2 * 60_000;
  assert.equal((await universe.identities(['XLE'])).get('XLE').name.value, 'The Energy Select Sector SPDR Fund');
  assert.equal(calls.length, 2);
});
