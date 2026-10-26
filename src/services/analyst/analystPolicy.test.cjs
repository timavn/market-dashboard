const test = require('node:test');
const assert = require('node:assert/strict');
const { REQUIRED_PRODUCTS, dailyReadiness, evaluateFinding, setupCapacity, costDecision, marketSession } = require('./analystPolicy.cjs');
const now = new Date('2026-09-04T15:00:00Z');
const evidence = () => ({ products: REQUIRED_PRODUCTS.map(([product]) => ({ product, latestPublicationDate: '2026-09-04', stages: { received: true, parsed: true, validated: true, indexed: true } })), indexed: REQUIRED_PRODUCTS.map(([product]) => ({ product, publication_date: '2026-09-04', document_id: product, content_hash: 'a' })) });
test('last publication, yesterday, failed stages, corrected publications, and exchange holidays', () => {
  const all = evidence(); const first = dailyReadiness(all, now);
  assert.equal(first.ready, true);
  all.products.at(-1).stages.indexed = false;
  assert.deepEqual(dailyReadiness(all, now).missing.map(p => p.id), ['market-structure']);
  all.products.at(-1).stages.indexed = true;
  all.products[0].latestPublicationDate = '2026-09-03';
  assert.equal(dailyReadiness(all, now).ready, false);
  all.products[0].latestPublicationDate = '2026-09-04';
  all.indexed[0].content_hash = 'correction';
  assert.notEqual(dailyReadiness(all, now).fingerprint, first.fingerprint);
  for (const date of ['2026-09-07T15:00:00Z', '2026-04-03T15:00:00Z', '2026-12-25T15:00:00Z']) assert.equal(dailyReadiness(all, new Date(date)).marketDay, false);
  assert.equal(marketSession(new Date('2026-11-27T18:01:00Z')), 'closed');
});
const event = { entityType: 'security', entityId: 'MSFT', qualityStatus: 'validated', action: 'SELL', productKey: 'real-time-alert', sourceMessageId: 'mail1', fieldPath: 'data.alert.action', publishedAt: now.toISOString(), excerpt: 'Sell Microsoft' };
const tradeEvent = { entityType: 'security', entityId: 'MSFT', qualityStatus: 'validated', eventType: 'trade_signal', signalValue: 'BEARISH', productKey: 'etf-pro', sourceMessageId: 'trade1', fieldPath: 'data.MSFT.trade', publishedAt: now.toISOString(), excerpt: 'MSFT Trade BEARISH' };
const holdings = q => ({ liveVerified: true, complete: true, asOf: now.toISOString(), positions: q === 0 ? [] : [{ symbol: 'MSFT', quantity: q, category: 'other' }] });
test('direct held sell independent of Trade/Trend; unheld, outage, actual exit, acknowledgment', () => {
  const finding = evaluateFinding(event, holdings(10), null, now);
  assert.equal(finding.state, 'open');
  assert.equal(evaluateFinding(event, holdings(0), null, now), null);
  assert.equal(evaluateFinding(event, { ...holdings(10), liveVerified: false }, finding, now).state, 'pending verification');
  assert.equal(evaluateFinding(event, holdings(10), { ...finding, acknowledgedAt: now.toISOString() }, now).state, 'open');
  assert.equal(evaluateFinding(event, holdings(0), finding, now).state, 'resolved');
  assert.equal(evaluateFinding(event, { ...holdings(10), pendingOrders: [{ action: 'SELL', quantity: 10 }] }, finding, now).state, 'open');
  assert.equal(evaluateFinding({ ...event, action: 'SELL-SOME' }, holdings(5), { ...finding, action: 'trim' }, now).state, 'partially addressed');
  assert.equal(evaluateFinding({ ...event, action: 'REMOVE' }, holdings(10), null, now).action, 'roster removal');
  assert.equal(evaluateFinding({ ...event, action: 'COVER' }, holdings(-10), null, now).action, 'cover');
  assert.equal(evaluateFinding(tradeEvent, holdings(10), null, now).action, 'signal change');
});
test('explicit source actions retain their full or partial meaning alongside a typed signal', () => {
  for (const [sourceAction, action, quantity] of [['SELL', 'exit', 10], ['SELL-SOME', 'trim', 10], ['COVER-SOME', 'cover', -10]]) {
    const mixed = { ...event, action: sourceAction, eventType: 'trade_signal', signalValue: 'BEARISH', excerpt: `${sourceAction} Microsoft` };
    const finding = evaluateFinding(mixed, holdings(quantity), null, now);
    assert.equal(finding.action, action);
    assert.equal(finding.event.action, sourceAction);
    assert.equal(finding.signalField, null);
    assert.equal(finding.rule, null);
  }
});
test('every alert carries independently verified current portfolio weight, separate from signal rule sizing', () => {
  const value = { weightPct: 2.5, source: 'ibkr', asOf: now.toISOString(), basis: 'absolute_market_value_over_net_liquidation' };
  const book = { ...holdings(-10), currentHoldings: [{ holding: 'MSFT', heldSide: 'SHORT', quantity: -10, currentHolding: value }] };
  const first = evaluateFinding({ ...event, action: 'COVER' }, book, null, now);
  assert.deepEqual(first.currentHolding, value);
  assert.equal(first.rule, null);
  for (const change of [{ liveVerified: false }, { connected: false }, { status: 'offline' }, { stale: true }, { freshness: 'cache-only' }, { from_cache: true }, { seeded: true }, { mock: true }]) {
    const unavailable = evaluateFinding({ ...event, action: 'COVER' }, { ...book, ...change }, first, now);
    assert.equal(unavailable.holdingsVerified, false);
    assert.equal(unavailable.currentHolding, null);
  }
  for (const change of [{ weightPct: NaN }, { weightPct: -2 }, { source: 'mock' }, { basis: 'cost_basis' }, { asOf: '2026-09-04T14:58:59Z' }, { stale: true }]) {
    const unavailable = evaluateFinding(event, { ...book, currentHoldings: [{ ...book.currentHoldings[0], currentHolding: { ...value, ...change } }] }, first, now);
    assert.equal(unavailable.holdingsVerified, true, 'holding quantity remains independently verified');
    assert.equal(unavailable.currentHolding, null);
  }
  assert.equal(evaluateFinding(event, { ...book, currentHoldings: [{ ...book.currentHoldings[0], quantity: -20 }] }, first, now).currentHolding, null);
  assert.equal(evaluateFinding(event, { ...book, currentHoldings: [], ruleHoldings: [{ holding: 'MSFT', weightPct: 2.5 }] }, first, now).currentHolding, null);
});
test('shared setup loss caps 5%/15%, funding and complete exposure gate', () => {
  const input = { market: 'gold', nlv: 100000, nlvVerified: true, funding: 10000, fundingVerified: true, existingLoss: 4900, exposureVerified: true, unitLoss: 0.5, fees: 0.02 };
  assert.equal(setupCapacity(input).contracts, 192);
  assert.ok(setupCapacity(input).combinedLoss <= 5000);
  assert.equal(setupCapacity({ ...input, market: 'cpi' }).cap, 15000);
  assert.equal(setupCapacity({ ...input, existingLoss: 5001 }).contracts, 0);
  assert.equal(setupCapacity({ ...input, exposureVerified: false }).contracts, null);
  assert.equal(setupCapacity({ ...input, funding: 1 }).contracts, 1);
});
test('cost guard requires complete evidence and slows at $15', () => {
  assert.equal(costDecision({ projectedMonthly: 2, monthToDate: 1, complete: true }).cadenceMinutes, 1);
  assert.equal(costDecision({ projectedMonthly: 15, monthToDate: 1, complete: true }).cadenceMinutes, 15);
  assert.equal(costDecision({ projectedMonthly: 2, monthToDate: 15, complete: true }).cadenceMinutes, 15);
  assert.equal(costDecision({ projectedMonthly: 2, monthToDate: 1 }).cadenceMinutes, 15);
});

// ATR 3.125 on a 100 close: a 6.25% stop, so MIN = 0.125 / 0.0625 = 2% and MAX = 4%.
const atrInputs = {
  atr14: { value: 3.125, observations: 14, status: 'verified_history', source: 'adjusted daily history', asOf: '2026-09-03' },
  referencePrice: { value: 100, observations: 1, status: 'verified_history', source: 'adjusted daily history', asOf: '2026-09-03' },
};

test('typed Trend change reduces to calculated MIN and resolves only from verified position evidence', () => {
  const change = { ...tradeEvent, entityId: 'IGV', productKey: 'risk-ranges', eventType: 'risk_range', signalValue: { trend: 'NEUTRAL', lrr: 100, hrr: 110 }, fieldPath: 'data.ranges.IGV', excerpt: 'IGV Trend NEUTRAL' };
  const book = weight => ({ ...holdings(10), positions: [{ symbol: 'IGV', quantity: 10 }], ruleHoldings: [{ holding: 'IGV', heldSide: 'LONG', trade: 'BULLISH', trend: 'NEUTRAL', weightPct: weight, sizingInputs: atrInputs }] });
  const first = evaluateFinding(change, book(4), null, now);
  assert.equal(first.state, 'open');
  assert.equal(first.rule.targetWeight, 2);
  assert.equal(first.rule.reduction, 2);
  assert.equal(first.event.signalValue, 'NEUTRAL');
  assert.equal(first.signalField, 'trend');
  assert.equal(first.holdingsVerified, true);
  assert.equal(evaluateFinding(change, book(4), { ...first, acknowledgedAt: now.toISOString() }, now).state, 'open');
  assert.equal(evaluateFinding(change, book(2), first, now).state, 'resolved');
  assert.equal(evaluateFinding(change, { ...book(4), liveVerified: false }, first, now).state, 'pending verification');
  assert.equal(evaluateFinding(change, { ...book(4), liveVerified: false }, first, now).holdingsVerified, false);
  assert.equal(evaluateFinding(change, { ...book(4), asOf: '2026-09-03T14:00:00Z' }, first, now).rule, null);
});

test('aligned bearish shorts and superseded signals do not become conflicts', () => {
  const change = tradeEvent;
  const book = { ...holdings(-10), ruleHoldings: [{ holding: 'MSFT', heldSide: 'SHORT', trade: 'BEARISH', trend: 'BULLISH', weightPct: 1, sizingInputs: atrInputs }] };
  assert.equal(evaluateFinding(change, book, null, now), null);
  const revised = { ...book, ruleHoldings: [{ ...book.ruleHoldings[0], trade: 'BULLISH', sources: { trade: { publishedAt: '2026-09-04T15:01:00Z' } } }] };
  assert.equal(evaluateFinding(change, revised, null, now), null);
});

test('finding copy names the typed signal and omits operational state and trade disclaimers', () => {
  const trade = evaluateFinding(tradeEvent, holdings(10), null, now);
  assert.equal(trade.summary, 'MSFT · Trade: Bearish');
  assert.equal(trade.state, 'pending verification');
  const trend = evaluateFinding({ ...tradeEvent, productKey: 'risk-ranges', eventType: 'risk_range', signalValue: { trend: 'NEUTRAL' }, fieldPath: 'data.ranges.MSFT', excerpt: 'MSFT Trend NEUTRAL' }, holdings(10), null, now);
  assert.equal(trend.summary, 'MSFT · Trend: Neutral');
  const offline = evaluateFinding(tradeEvent, { ...holdings(10), liveVerified: false }, trade, now);
  assert.equal(offline.summary, 'MSFT · Trade: Bearish');
  assert.equal(offline.holdingsVerified, false);
  assert.equal(offline.rule, null);
  assert.equal(offline.fingerprint, trade.fingerprint);
  assert.equal(evaluateFinding(event, holdings(10), null, now).summary, 'MSFT · Exit reported');
});
test('chat filing uses the Pacific calendar day while market sessions keep the Eastern exchange date', () => {
  const { easternDate, pacificDate, portfolioCaptureWindow } = require('./analystPolicy.cjs');
  for (const [instant, pacific, eastern, session] of [
    ['2026-10-06T21:00:00Z', '2026-10-06', '2026-10-06', 'closed'], // Tue 14:00 PDT, after the close
    ['2026-10-07T04:30:00Z', '2026-10-06', '2026-10-07', 'pre-market'], // Tue 21:30 PDT, Wed 00:30 ET
    ['2026-10-10T04:30:00Z', '2026-10-09', '2026-10-10', 'closed'], // Fri 21:30 PDT, Sat 00:30 ET
    ['2026-10-07T07:30:00Z', '2026-10-07', '2026-10-07', 'pre-market'], // Wed 00:30 PDT
    ['2026-01-07T05:30:00Z', '2026-01-06', '2026-01-07', 'pre-market'], // Tue 21:30 PST
  ]) {
    const observed = new Date(instant);
    assert.deepEqual([pacificDate(observed), easternDate(observed), marketSession(observed)], [pacific, eastern, session], instant);
    assert.equal(portfolioCaptureWindow(observed).date, eastern);
  }
});
