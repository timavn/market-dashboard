const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPublishedTradeArchive } = require('./publishedTradeArchive.cjs');
const products = [{ id: 'early-look', label: 'Early Look', snapshotTypes: ['early-look'] },
  { id: 'the-call', label: 'The Call', snapshotTypes: ['the-call'] }];
const publication = (date = '2026-08-10', bodyText = 'SPX is BEARISH TRADE.', snapshotType = 'early-look', extra = {}) => ({
  date, snapshotType, source: 'gmail-html',
  htmlSource: `hedgeye-email/messages/${date}/${snapshotType}/original.html`,
  article: { feedUrl: 'https://app.hedgeye.com/feed_items/180000', bodyText }, ...extra,
});

test('archives independent Trade across products without a five-day cutoff, date rewriting, or omission deletion', async () => {
  let reads = 0;
  let snapshots = [publication()];
  const archive = createPublishedTradeArchive({ referencePath: null, products, ttlMs: 0,
    querySnapshotsByType: async (type) => { reads++; return type === 'early-look' ? snapshots : [publication('2026-09-25', 'VIX is NEUTRAL TRADE.', 'the-call')]; },
  });
  const first = await archive.load({ date: '2026-09-25', waitForRefresh: true });
  assert.equal(reads, 2);
  assert.deepEqual(first.map((r) => [r.ticker, r.value, r.date]), [['SPX', 'BEARISH', '2026-08-10'], ['VIX', 'NEUTRAL', '2026-09-25']]);
  snapshots = [publication('2026-09-25', 'SPX is BULLISH TREND.')];
  const after = await archive.load({ date: '2026-09-25', waitForRefresh: true });
  assert.deepEqual(after, first);
  assert.equal((await archive.load({ date: '2026-08-01' })).length, 0);
});

test('preserves original evidence across errors, restarts, and a query window rolling past the publication', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'trade-publications-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const referencePath = path.join(directory, 'archive.json');
  const oneProduct = [products[0]];
  const first = createPublishedTradeArchive({ referencePath, products: oneProduct, querySnapshotsByType: async () => [publication()] });
  const expected = await first.load({ date: '2026-09-25' });
  const restarted = createPublishedTradeArchive({ referencePath, products: oneProduct, querySnapshotsByType: async () => { throw new Error('offline'); } });
  assert.deepEqual(await restarted.load({ date: '2027-09-25' }), expected);
  await restarted.load({ date: '2027-09-25', waitForRefresh: true });
});

test('an exact publication revision revokes its old extraction without erasing other sources', async () => {
  let revise = false;
  const archive = createPublishedTradeArchive({ referencePath: null, products, ttlMs: 0,
    querySnapshotsByType: async (type) => type === 'early-look'
      ? [publication('2026-08-10', revise ? 'SPX is BEARISH TREND.' : 'SPX is BEARISH TRADE.')]
      : [publication('2026-09-25', 'VIX is BULLISH TRADE.', type)],
  });
  assert.equal((await archive.load({ waitForRefresh: true })).length, 2);
  revise = true;
  assert.deepEqual((await archive.load({ waitForRefresh: true })).map((row) => row.ticker), ['VIX']);
});

test('rejects fabricated or disconnected source evidence and never derives Trade from numerical ranges', async () => {
  const invalid = [{ mock: true }, { seed: true }, { cacheOnly: true }, { stale: true }, { offline: true }, { verified: false }];
  const archive = createPublishedTradeArchive({ referencePath: null, products: [products[0]], querySnapshotsByType: async () => [
    ...invalid.map((extra, index) => publication(`2026-09-${String(index + 1).padStart(2, '0')}`, 'SPX is BULLISH TRADE.', 'early-look', extra)),
    publication('2026-09-10', 'SPX is BULLISH TREND.', 'early-look', { data: { SPX: { buyTrade: 7500, sellTrade: 7700, trend: 'BULLISH' } } }),
  ] });
  assert.deepEqual(await archive.load({ waitForRefresh: true }), []);
});

test('a different report on the same day is an omission, not a revision of the earlier source', async () => {
  let snapshots = [publication()];
  const archive = createPublishedTradeArchive({ referencePath: null, products: [products[0]], ttlMs: 0,
    querySnapshotsByType: async () => snapshots });
  const original = await archive.load({ waitForRefresh: true });
  snapshots = [publication('2026-08-10', '', 'early-look', {
    article: { feedUrl: 'https://app.hedgeye.com/feed_items/180001', bodyText: 'SPX is BULLISH TREND.' },
  })];
  assert.deepEqual(await archive.load({ waitForRefresh: true }), original);
  snapshots = [publication('2026-08-10', 'SPX is BULLISH TRADE.', 'early-look', { stale: true })];
  assert.deepEqual(await archive.load({ waitForRefresh: true }), original);
});

test('serves persisted research immediately while the archive refresh is still pending', { timeout: 2000 }, async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'trade-background-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const referencePath = path.join(directory, 'archive.json');
  const first = createPublishedTradeArchive({ referencePath, products: [products[0]], querySnapshotsByType: async () => [publication()] });
  const expected = await first.load();
  let resolve;
  const waiting = new Promise((done) => { resolve = done; });
  const restarted = createPublishedTradeArchive({ referencePath, products: [products[0]], querySnapshotsByType: () => waiting });
  assert.deepEqual(await restarted.load(), expected);
  resolve([]);
  assert.deepEqual(await restarted.load({ waitForRefresh: true }), expected);
});

test('a refresh counts as verified only when every snapshot query succeeded', async () => {
  let failing = 'the-call';
  let clock = 1_000;
  const archive = createPublishedTradeArchive({ referencePath: null, products, ttlMs: 0, now: () => clock,
    querySnapshotsByType: async (type) => { if (type === failing) throw new Error('ExpiredTokenException'); return [publication()]; } });
  await archive.load({ waitForRefresh: true });
  assert.equal(archive.status().verifiedAt, null);
  failing = null;
  clock = 2_000;
  await archive.load({ waitForRefresh: true });
  assert.equal(archive.status().verifiedAt, 2_000);
  failing = 'early-look';
  clock = 3_000;
  await archive.load({ waitForRefresh: true });
  assert.equal(archive.status().verifiedAt, 2_000, 'a later partial failure keeps the last verified read');
});

test('keeps a publication that states only references, Trend or Alpha Codes, and drops a tampered statement on reload', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'trade-publications-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const referencePath = path.join(directory, 'archive.json');
  const body = 'Gold remains Bearish TRADE and TREND\nOil’s (WTI) Alpha Code = 9791 (TRADE = $97, TREND = $91)';
  const archive = createPublishedTradeArchive({ referencePath, products: [products[0]], querySnapshotsByType: async () => [publication('2026-11-02', body)] });
  assert.deepEqual(await archive.load({ waitForRefresh: true }), [], 'spot gold is not security Trade');
  const statements = archive.statements();
  assert.deepEqual(statements.references.map((row) => [row.sourceTicker, row.value, row.instrumentKey]), [['GOLD', 'BEARISH', 'reference:GOLD']]);
  assert.deepEqual(statements.trends.map((row) => [row.sourceTicker, row.value]), [['GOLD', 'BEARISH']]);
  assert.deepEqual(statements.alphaCodes.map((row) => [row.sourceTicker, row.levels.trade, row.levels.trend]), [['CL', 97, 91]]);
  assert.deepEqual(archive.statements({ date: '2026-11-01' }).references, []);
  const stored = JSON.parse(fs.readFileSync(referencePath, 'utf8'));
  Object.values(stored.publications)[0].alphaCodes[0].levels.trade = 98;
  fs.writeFileSync(referencePath, JSON.stringify(stored));
  const restarted = createPublishedTradeArchive({ referencePath, products: [products[0]], querySnapshotsByType: async () => { throw new Error('offline'); } });
  await restarted.load({ date: '2026-11-02' });
  // Only the altered statement is dropped; the publication's other statements stand.
  const kept = restarted.statements();
  assert.deepEqual(kept.alphaCodes, []);
  assert.deepEqual([kept.references.length, kept.trends.length], [1, 1]);
});
