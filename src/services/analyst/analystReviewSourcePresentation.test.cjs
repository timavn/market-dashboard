const test = require('node:test');
const assert = require('node:assert/strict');
const { pendingReviewSourceItems } = require('./analystReviewSourceCatalog.cjs');
const { reviewSourceDisplayItems } = require('./analystReviewSourcePresentation.cjs');

const at = '2026-10-08T16:05:00Z';
const ready = (id, label = id, changes = {}) => ({ id, label, status: 'ready', observedAt: at, ...changes });

test('all review rosters reserve one broker connection while retaining independent sources', () => {
  // Predictive Markets Review reads only research, prices and Kalshi: no broker row.
  assert.ok(!reviewSourceDisplayItems(pendingReviewSourceItems('prediction-markets-review')).some(row => row.id === 'ibGateway'));
  for (const kind of ['portfolio-review', 'balance-review']) {
    const roster = pendingReviewSourceItems(kind);
    const original = JSON.stringify(roster);
    const rows = reviewSourceDisplayItems(roster);
    assert.equal(rows.filter(row => row.id === 'ibGateway').length, 1);
    assert.equal(rows[0].label, 'IB Gateway');
    assert.equal(rows[0].status, 'checking');
    assert.ok(!rows.some(row => /^IBKR /.test(row.label)));
    assert.equal(JSON.stringify(roster), original);
  }
});

test('explicit captured Gateway status wins over account success and failure', () => {
  const rows = [ready('portfolio', 'IBKR holdings'),
    { id: 'balance', label: 'IBKR balances', status: 'unavailable', diagnostic: { code: 'IBKR_BALANCE_TIMEOUT' } },
    ready('ibGateway', 'IB Gateway', { observedAt: '2026-10-08T16:00:00Z' })];
  const original = JSON.stringify(rows);
  const [gateway] = reviewSourceDisplayItems(rows);
  assert.equal(gateway.status, 'ready');
  assert.equal(gateway.observedAt, '2026-10-08T16:00:00Z');
  assert.equal(JSON.stringify(rows), original);
  const [failed] = reviewSourceDisplayItems([...rows.slice(0, 2), { id: 'ibGateway', label: 'IB Gateway', status: 'unavailable',
    diagnostic: { code: 'IBKR_GATEWAY_NOT_CONNECTED' } }]);
  assert.equal(failed.status, 'unavailable');
  assert.equal(failed.connectionState, 'disconnected');
  assert.equal(failed.observedAt, null);
});

test('the explicit Gateway check keeps its own settled duration; account timings never become it', () => {
  const [connected] = reviewSourceDisplayItems([ready('portfolio', 'IBKR holdings', { elapsedMs: 900 }),
    ready('ibGateway', 'IB Gateway', { elapsedMs: 420 })]);
  assert.equal(connected.elapsedMs, 420);
  const [unverified] = reviewSourceDisplayItems([{ id: 'ibGateway', label: 'IB Gateway', status: 'unavailable',
    elapsedMs: 1012, diagnostic: { code: 'IBKR_GATEWAY_READINESS_TIMEOUT' } }]);
  assert.equal(unverified.connectionState, 'unverified');
  assert.equal(unverified.elapsedMs, 1012);
  for (const explicit of [{ status: 'checking', elapsedMs: 5 }, { status: 'ready', elapsedMs: 600_001 },
    { status: 'ready', elapsedMs: -1 }, { status: 'ready', elapsedMs: 1.5 }]) {
    const [gateway] = reviewSourceDisplayItems([{ id: 'ibGateway', label: 'IB Gateway', observedAt: at, ...explicit }]);
    assert.ok(!('elapsedMs' in gateway), JSON.stringify(explicit));
  }
  const [derived] = reviewSourceDisplayItems([ready('portfolio', 'IBKR holdings', { elapsedMs: 900 })]);
  assert.equal(derived.status, 'ready');
  assert.ok(!('elapsedMs' in derived));
});

test('legacy successful account acquisition proves the captured connection despite another request timeout', () => {
  const rows = reviewSourceDisplayItems([ready('holdings', 'IBKR holdings'),
    { id: 'portfolioOpenOrders', label: 'IBKR open orders', status: 'unavailable', diagnostic: { code: 'OPEN_ORDERS_TIMEOUT' } },
    ready('forecastex-gold', 'Gold · ForecastEx', { requiresIbGateway: true }),
    ready('portfolioFactors', 'Factor model', { requiresIbGateway: true })]);
  assert.deepEqual(rows.map(row => row.id), ['ibGateway', 'forecastex-gold', 'portfolioFactors']);
  assert.equal(rows[0].status, 'ready');
  assert.equal(rows[0].observedAt, at);
});

// Contract change: an unavailable check without a verified disconnect is now
// labelled Unverified (connectionState 'unverified') instead of carrying none.
test('account failures and invalid observations cannot imply a disconnected or connected Gateway', () => {
  for (const changes of [{ status: 'unavailable', diagnostic: { code: 'IBKR_HOLDINGS_TIMEOUT' } },
    { status: 'unavailable', diagnostic: { code: 'IBKR_HOLDINGS_SERVICE_UNAVAILABLE' } },
    { status: 'missing', diagnostic: { code: 'IBKR_CONNECTION_UNVERIFIED_NOT_ATTEMPTED' } },
    { observedAt: null }, { observedAt: '2026-10-08T09:05:00' },
    { stale: true }, { cached: true }, { mock: true }, { seed: true }, { connected: false }]) {
    const [gateway] = reviewSourceDisplayItems([ready('portfolio', 'IBKR holdings', changes)]);
    assert.equal(gateway.status, 'unavailable');
    assert.equal(gateway.connectionState, 'unverified');
    assert.equal(gateway.diagnostic.code, 'IBKR_GATEWAY_CONNECTION_UNVERIFIED');
    assert.doesNotMatch(gateway.diagnostic.reason, /was disconnected/);
    assert.equal(gateway.observedAt, null);
  }
  for (const code of ['IBKR_GATEWAY_READINESS_TIMEOUT', 'IBKR_SERVICE_UNAVAILABLE', 'IBKR_GATEWAY_NOT_VERIFIED',
    'IBKR_GATEWAY_RECONNECTING', 'IBKR_GATEWAY_API_UNRESPONSIVE', 'IBKR_CLIENT_ID_IN_USE', 'IBKR_GATEWAY_CONNECTION_UNVERIFIED']) {
    const reason = `Captured ${code} explanation.`;
    const [gateway] = reviewSourceDisplayItems([{ id: 'ibGateway', label: 'IB Gateway', status: 'unavailable', diagnostic: { code, reason } }]);
    assert.equal(gateway.status, 'unavailable');
    assert.equal(gateway.connectionState, 'unverified');
    assert.equal(gateway.diagnostic.code, code);
    // Producer classifications keep their own explanation instead of the generic one.
    assert.equal(gateway.diagnostic.reason, reason);
  }
  for (const code of ['IBKR_GATEWAY_NOT_CONNECTED', 'IBKR_GATEWAY_NOT_AUTHENTICATED', 'GATEWAY_UNAVAILABLE']) {
    const [gateway] = reviewSourceDisplayItems([{ id: 'ibGateway', label: 'IB Gateway', status: 'unavailable', diagnostic: { code } }]);
    assert.equal(gateway.connectionState, 'disconnected');
  }
});

test('a legacy reconnecting account code collapses into one unverified Gateway row', () => {
  const [gateway, ...rest] = reviewSourceDisplayItems([
    { id: 'portfolio', label: 'IBKR holdings', status: 'unavailable', diagnostic: { code: 'IBKR_GATEWAY_RECONNECTING', reason: 'Reconnecting.' } },
    { id: 'portfolioBalance', label: 'IBKR account exposure', status: 'missing' },
    ready('risk-ranges', 'Risk Ranges')]);
  assert.equal(gateway.connectionState, 'unverified');
  assert.equal(gateway.diagnostic.code, 'IBKR_GATEWAY_RECONNECTING');
  assert.equal(gateway.diagnostic.reason, 'Reconnecting.');
  assert.deepEqual(rest.map(row => row.id), ['risk-ranges']);
});

test('a settled capture that never checked the connection shows the Gateway as not checked, never Unavailable', () => {
  for (const kind of ['portfolio-review', 'balance-review']) {
    // A settled run's rows carry why they were not checked.
    const settledRoster = pendingReviewSourceItems(kind, 'missing').map(item => ({ ...item, diagnostic: { code: 'SOURCE_NOT_ATTEMPTED' } }));
    const [gateway] = reviewSourceDisplayItems(settledRoster);
    assert.equal(gateway.status, 'missing');
    assert.equal(gateway.connectionState, undefined);
    assert.equal(gateway.observedAt, null);
    assert.equal(gateway.diagnostic.code, 'SOURCE_NOT_ATTEMPTED');
    assert.match(gateway.detail, /settled before checking/);
    assert.match(gateway.diagnostic.reason, /not checked before this review settled/);
    assert.match(gateway.diagnostic.reason, /does not establish a disconnect/);
    // Readiness rows before any run carry no code: nothing has settled yet.
    const [unchecked] = reviewSourceDisplayItems(pendingReviewSourceItems(kind, 'missing'));
    assert.equal(unchecked.status, 'missing');
    assert.equal(unchecked.connectionState, undefined);
    assert.equal(unchecked.diagnostic.code, 'SOURCE_NOT_ATTEMPTED');
    assert.doesNotMatch(`${unchecked.detail} ${unchecked.diagnostic.reason}`, /settled/);
    assert.match(unchecked.diagnostic.reason, /has not been checked for this review\. This does not establish a disconnect\.$/);
  }
  const [explicit] = reviewSourceDisplayItems([{ id: 'ibGateway', label: 'IB Gateway', status: 'missing',
    diagnostic: { code: 'SOURCE_CHECK_INCOMPLETE', reason: 'Still checking when the review settled.' } }, ready('portfolio', 'IBKR holdings')]);
  assert.equal(explicit.status, 'missing');
  assert.equal(explicit.diagnostic.code, 'SOURCE_CHECK_INCOMPLETE');
  assert.equal(explicit.diagnostic.reason, 'Still checking when the review settled.');
  const [settled] = reviewSourceDisplayItems([{ id: 'portfolio', label: 'IBKR holdings', status: 'missing',
    diagnostic: { code: 'SOURCE_NOT_ATTEMPTED' } }, { id: 'balance', label: 'IBKR balances', status: 'checking' }]);
  assert.equal(settled.status, 'checking', 'an unfinished account check keeps the Gateway checking');
});

test('a captured disconnect collapses legacy account failures without copying raw request details', () => {
  const [gateway] = reviewSourceDisplayItems([{ id: 'portfolio', label: 'IBKR holdings', status: 'unavailable',
    observedAt: at, diagnostic: { code: 'GATEWAY_UNAVAILABLE' } },
  { id: 'portfolioBalance', label: 'IBKR account exposure', status: 'unavailable', detail: 'Private account data' }]);
  assert.equal(gateway.connectionState, 'disconnected');
  assert.equal(gateway.observedAt, null);
  assert.doesNotMatch(JSON.stringify(gateway), /Private account/);
});

test('ordinary holdings, research and empty captures remain unchanged', () => {
  const rows = [ready('holdings', 'Portfolio holdings'), ready('orders', 'Open orders'), ready('risk', 'Risk Ranges')];
  assert.deepEqual(reviewSourceDisplayItems(rows), rows);
  assert.deepEqual(reviewSourceDisplayItems([]), []);
});
