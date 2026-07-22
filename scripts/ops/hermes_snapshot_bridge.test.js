const test = require('node:test');
const assert = require('node:assert/strict');

const {
  assertLoopbackBase,
  buildReadySnapshot,
  publishErrorCode,
  verifyPortfolio,
} = require('./hermes_snapshot_bridge');

function inputs(overrides = {}) {
  const now = new Date().toISOString();
  return {
    portfolio: {
      ok: true,
      connected: true,
      status: 'live',
      source: 'ibkr_live_session',
      observed_at: now,
      socket_verified_at: now,
      accounts: ['U123'],
      positions: [{
        account: 'U123',
        symbol: 'SPY',
        localSymbol: 'SPY',
        conId: 756733,
        secType: 'STK',
        exchange: 'NASDAQ',
        currency: 'USD',
        position: 10,
      }],
    },
    readiness: {
      version: 1,
      checkedAt: now,
      capabilities: {
        'automation.hermes': { status: 'degraded', ready: false },
        'dashboard.core': { status: 'ready', ready: true },
        'portfolio.live': { status: 'pass', ready: true },
        'prediction.display': { status: 'degraded', ready: false },
        'prediction.ibkrExecution': { status: 'degraded', ready: false },
        'research.current': { status: 'degraded', ready: false },
      },
      rootCauses: [],
      manualActions: [],
    },
    ...overrides,
  };
}

test('bridge only permits loopback dashboard and sidecar URLs', () => {
  assert.equal(assertLoopbackBase('http://127.0.0.1:3001', 'test'), 'http://127.0.0.1:3001');
  assert.throws(() => assertLoopbackBase('https://dashboard.example.com', 'test'), /loopback/);
  assert.throws(() => assertLoopbackBase('http://192.168.1.10:3001', 'test'), /loopback/);
});

test('ready snapshot strips account identifiers and all display pricing', () => {
  const snapshot = buildReadySnapshot(inputs());
  const serialized = JSON.stringify(snapshot);

  assert.equal(snapshot.bridgeStatus, 'ready');
  assert.equal(snapshot.portfolio.source, 'ibkr_live');
  assert.equal(snapshot.portfolio.positions[0].positionSource, 'ibkr_api');
  assert.equal(snapshot.portfolio.positions[0].price, undefined);
  assert.equal(snapshot.portfolio.positions[0].accountId, undefined);
  assert.equal(serialized.includes('U123'), false);
});

test('a non-live sidecar source fails closed', () => {
  const candidate = inputs();
  candidate.portfolio.source = 'stream_cache';
  assert.throws(
    () => verifyPortfolio(candidate),
    error => error.code === 'IBKR_GATEWAY_DISCONNECTED',
  );
});

test('an empty verified live account is valid and stays explicit', () => {
  const candidate = inputs();
  candidate.portfolio.positions = [];
  const snapshot = buildReadySnapshot(candidate);
  assert.equal(snapshot.portfolio.verified, true);
  assert.equal(snapshot.portfolio.positionCount, 0);
  assert.deepEqual(snapshot.portfolio.positions, []);
});

test('portfolio capability failure prevents publication as ready', () => {
  const candidate = inputs();
  candidate.readiness.capabilities['portfolio.live'] = {
    status: 'fail',
    ready: false,
    errorCode: 'IBKR_PORTFOLIO_UNAVAILABLE',
  };
  assert.throws(
    () => verifyPortfolio(candidate),
    error => error.code === 'IBKR_PORTFOLIO_UNAVAILABLE',
  );
});

test('missing portfolio capability fails closed', () => {
  const candidate = inputs();
  candidate.readiness.capabilities = {};
  assert.throws(
    () => verifyPortfolio(candidate),
    error => error.code === 'SYSTEM_READINESS_CAPABILITY_CONTRACT_INVALID',
  );
});

test('an incomplete capability contract fails closed even when portfolio is ready', () => {
  const candidate = inputs();
  delete candidate.readiness.capabilities['research.current'];
  assert.throws(
    () => verifyPortfolio(candidate),
    error => error.code === 'SYSTEM_READINESS_CAPABILITY_CONTRACT_INVALID',
  );
});

test('stale readiness or socket proof fails closed', () => {
  const staleReadiness = inputs();
  staleReadiness.readiness.checkedAt = '2026-07-01T00:00:00.000Z';
  assert.throws(
    () => verifyPortfolio(staleReadiness),
    error => error.code === 'SYSTEM_READINESS_UNVERIFIED',
  );

  const staleSocket = inputs();
  staleSocket.portfolio.socket_verified_at = '2026-07-01T00:00:00.000Z';
  assert.throws(
    () => verifyPortfolio(staleSocket),
    error => error.code === 'PORTFOLIO_SNAPSHOT_STALE',
  );
});

test('AWS publish denial is reported with a stable typed error', () => {
  assert.equal(publishErrorCode({
    code: 'AccessDeniedException',
    message: 'not authorized to perform dynamodb:PutItem',
  }), 'HERMES_BRIDGE_AWS_ACCESS_DENIED');
});
