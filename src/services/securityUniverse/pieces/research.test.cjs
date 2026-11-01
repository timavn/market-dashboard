const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createResearchPiece } = require('./research.cjs');

const NOW = Date.parse('2026-10-31T15:00:00Z');
const descriptor = (value, extra = {}) => ({ status: 'available', value, sourceId: 'risk-ranges', sourceLabel: 'Risk Ranges',
  sourceDate: '2026-10-30', publishedAt: '2026-10-30T11:31:46+00:00', reason: null, ...extra });
const missing = reason => ({ status: 'unavailable', value: null, sourceId: null, sourceLabel: null, sourceDate: null, publishedAt: null, reason });
const range = (lrr, hrr) => descriptor({ lrr, hrr }, { lrr, hrr, trend: 'BULLISH', decisionEligible: true });
const reference = (matchedText, lrr, hrr, extra = {}) => ({ productId: 'risk-ranges', kind: 'primary_risk_range', marketDate: '2026-10-30',
  matchType: 'direct_alias', matchedText, value: { lrr, hrr, trend: 'BULLISH' }, decisionEligible: true, ...extra });
const entry = (riskRange, references, extra = {}) => ({ decision: {
  trade: missing('no-verified-published-trade-signal'), trend: descriptor('BULLISH'), riskRange,
  signalStrength: missing('no-explicit-signal-strength-event'), signalStrengthShorts: missing('no-explicit-signal-strength-shorts-event'), ...extra,
}, directReferences: references });
const intelligence = bySymbol => async () => ({ schemaVersion: 2, bySymbol });
const freshArchive = () => ({ refreshedAt: '2026-10-31T14:58:00Z' });

test('a range routed through a research alias is a labelled proxy; the same instrument is direct', async () => {
  const piece = createResearchPiece({ now: () => NOW, tradeArchiveStatus: freshArchive, loadSecurityIntelligence: intelligence({
    SPY: entry(range(7612, 7779), [reference('SPX', 7612, 7779), reference('SPX', 7612, 7779, { kind: 'risk_range', matchType: 'direct' }),
      reference('SPX', 7612, 7779, { productId: 'early-look', decisionEligible: false })]),
    BTC: entry(range(76366, 81319), [reference('BITCOIN', 76366, 81319)]),
    AAPL: entry(range(339, 353), [reference('AAPL', 339, 353, { matchType: 'direct' })]),
    XLV: entry(range(178, 186), [reference('XLV', 178, 186), reference('HEALTH CARE', 178, 186, { kind: 'risk_range' })]),
  }) });
  const research = await piece.loadMany(['SPY', 'BTC', 'AAPL', 'XLV']);
  assert.deepEqual(research.get('SPY').riskRange.value, { lrr: 7612, hrr: 7779 });
  assert.deepEqual([research.get('SPY').riskRange.sourceInstrument, research.get('SPY').riskRange.match], ['SPX', 'proxy']);
  assert.equal(research.get('SPY').trend.match, 'proxy', 'a Trend from the same publication carries the same instrument');
  assert.equal(research.get('SPY').riskRange.asOf, '2026-10-30');
  assert.deepEqual([research.get('BTC').riskRange.sourceInstrument, research.get('BTC').riskRange.match], ['BITCOIN', 'direct']);
  assert.equal(research.get('AAPL').riskRange.match, 'direct');
  // Two instruments behind one range cannot be attributed.
  assert.deepEqual([research.get('XLV').riskRange.sourceInstrument, research.get('XLV').riskRange.match], [null, 'unverified']);
});

test('a key rewritten at ingest or a range far from the close is a proxy, whatever the key says', async () => {
  const piece = createResearchPiece({ now: () => NOW, tradeArchiveStatus: freshArchive,
    loadReferencePrices: async () => new Map([['GLD', 371.2], ['AAPL', 348], ['QQQX', 25], ['BTC', 78000], ['SPY', 681]]),
    loadSecurityIntelligence: intelligence({
      GLD: entry(range(3923, 4125), [reference('GLD', 3923, 4125, { matchType: 'direct' })]),
      AAPL: entry(range(339, 353), [reference('AAPL', 339, 353, { matchType: 'direct' })]),
      QQQX: entry(range(500, 520), [reference('QQQX', 500, 520, { matchType: 'direct' })]),
      BTC: entry(range(76366, 81319), [reference('BITCOIN', 76366, 81319)]),
      SPY: entry(range(7612, 7779), [reference('SPX', 7612, 7779)]),
    }) });
  const research = await piece.loadMany(['GLD', 'AAPL', 'QQQX', 'BTC', 'SPY']);
  assert.deepEqual([research.get('SPY').riskRange.match, research.get('SPY').riskRange.scaleCheck], ['proxy', 'range-scale-differs-from-price']);
  assert.equal(research.get('GLD').riskRange.scaleCheck, 'range-scale-differs-from-price');
  assert.deepEqual([research.get('GLD').riskRange.sourceInstrument, research.get('GLD').riskRange.match], ['GOLD', 'proxy']);
  assert.deepEqual([research.get('AAPL').riskRange.match, research.get('AAPL').riskRange.scaleCheck], ['direct', 'consistent']);
  assert.deepEqual([research.get('QQQX').riskRange.match, research.get('QQQX').riskRange.scaleCheck], ['proxy', 'range-scale-differs-from-price']);
  assert.deepEqual([research.get('BTC').riskRange.match, research.get('BTC').riskRange.scaleCheck], ['direct', 'consistent']);
  // Without a verified close the key decides, and says it was not checked.
  const unchecked = await createResearchPiece({ now: () => NOW, tradeArchiveStatus: freshArchive, loadReferencePrices: async () => { throw new Error('offline'); },
    loadSecurityIntelligence: intelligence({ AAPL: entry(range(339, 353), [reference('AAPL', 339, 353)]) }) }).loadMany(['AAPL']);
  assert.deepEqual([unchecked.get('AAPL').riskRange.match, unchecked.get('AAPL').riskRange.scaleCheck], ['direct', 'not-checked']);
});

test('unpublished readings keep their reason, Tail says it has no source, and a missing symbol is unavailable', async () => {
  const piece = createResearchPiece({ now: () => NOW, tradeArchiveStatus: freshArchive, loadSecurityIntelligence: intelligence({
    COST: entry(missing('symbol-not-in-verified-primary-publication'), [], { trend: missing('symbol-not-in-verified-primary-publication') }),
  }) });
  const research = await piece.loadMany(['COST', 'ZZZZ']);
  const cost = research.get('COST');
  assert.equal(cost.status, 'unavailable');
  assert.equal(cost.riskRange.reason, 'symbol-not-in-verified-primary-publication');
  assert.equal(cost.tail.reason, 'no-published-tail-source');
  assert.equal(cost.trade.reason, 'no-verified-published-trade-signal');
  assert.equal(research.get('ZZZZ').trend.reason, 'symbol-not-in-security-intelligence');
});

test('a trade archive that has not refreshed recently marks Trade partial instead of current', async () => {
  const bySymbol = { NVDA: entry(range(170, 190), [reference('NVDA', 170, 190)], { trade: descriptor('BULLISH', { sourceId: 'real-time-alert', sourceLabel: 'Real-Time Alerts' }) }) };
  for (const archive of [() => null, () => ({ refreshedAt: null }), () => ({ refreshedAt: '2026-10-31T14:00:00Z' })]) {
    const research = await createResearchPiece({ now: () => NOW, tradeArchiveStatus: archive, loadSecurityIntelligence: intelligence(bySymbol) }).loadMany(['NVDA']);
    assert.deepEqual([research.get('NVDA').trade.status, research.get('NVDA').trade.reason], ['partial', 'published-trade-archive-unavailable']);
  }
  const current = await createResearchPiece({ now: () => NOW, tradeArchiveStatus: freshArchive, loadSecurityIntelligence: intelligence(bySymbol) }).loadMany(['NVDA']);
  assert.deepEqual([current.get('NVDA').trade.status, current.get('NVDA').trade.value], ['available', 'BULLISH']);
});

test('flagged or malformed research is rejected', async () => {
  const flagged = await createResearchPiece({ now: () => NOW, tradeArchiveStatus: freshArchive, loadSecurityIntelligence: intelligence({
    MOCK: entry({ ...range(1, 2), mock: true }, [reference('MOCK', 1, 2)]),
    SEED: { ...entry(range(1, 2), []), seeded: true },
  }) }).loadMany(['MOCK', 'SEED']);
  assert.equal(flagged.get('MOCK').riskRange.reason, 'research-reading-unverified');
  assert.equal(flagged.get('SEED').status, 'unavailable');
  for (const response of [null, { schemaVersion: 1, bySymbol: {} }, { schemaVersion: 2, bySymbol: {}, stale: true }]) {
    await assert.rejects(createResearchPiece({ loadSecurityIntelligence: async () => response }).loadMany(['SPY']));
  }
});
