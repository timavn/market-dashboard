const test = require('node:test');
const assert = require('node:assert/strict');

const {
  assertLoopbackBase,
  buildBridgeResult,
  bridgePartitions,
  buildDegradedSnapshot,
  buildOperationsSnapshot,
  buildReadySnapshot,
  captureAndPublish,
  getJson,
  hermesBridgeEnabled,
  publishBridgeSnapshot,
  publishErrorCode,
  runBridge,
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
      positions_observed_at: now,
      position_source: 'ibkr_req_positions',
      from_cache: false,
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

test('sidecar 503 becomes a typed blocked portfolio snapshot without stale positions', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: false,
    status: 503,
    json: async () => ({
      status: 'gateway_unavailable',
      message: 'IB Gateway is not authenticated.',
    }),
  });

  try {
    let failure;
    await assert.rejects(
      () => getJson('http://127.0.0.1:8765/portfolio/live-positions'),
      error => {
        failure = error;
        assert.equal(error.code, 'IBKR_GATEWAY_NOT_AUTHENTICATED');
        assert.equal(error.blockedBy, 'portfolio.live');
        assert.equal(error.upstreamStatus, 'gateway_unavailable');
        return true;
      },
    );

    const snapshot = buildDegradedSnapshot(
      failure,
      '2026-07-30T18:00:00.000Z',
    );
    assert.equal(snapshot.bridgeStatus, 'blocked');
    assert.equal(snapshot.blockedBy, 'portfolio.live');
    assert.equal(snapshot.errorCode, 'IBKR_GATEWAY_NOT_AUTHENTICATED');
    assert.equal(snapshot.portfolio.verified, false);
    assert.deepEqual(snapshot.portfolio.positions, []);
  } finally {
    global.fetch = originalFetch;
  }
});

test('sidecar preserves a typed positions-client failure code', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: false,
    status: 503,
    json: async () => ({
      status: 'tws_offline',
      error_code: 'IBKR_POSITIONS_CLIENT_UNAVAILABLE',
      message: 'Dedicated positions client could not reach the IBKR socket.',
    }),
  });

  try {
    await assert.rejects(
      () => getJson('http://127.0.0.1:8765/portfolio/live-positions'),
      error => {
        assert.equal(error.code, 'IBKR_POSITIONS_CLIENT_UNAVAILABLE');
        assert.equal(error.upstreamStatus, 'tws_offline');
        assert.equal(error.upstreamErrorCode, 'IBKR_POSITIONS_CLIENT_UNAVAILABLE');
        return true;
      },
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('readiness aborts become a typed bridge input timeout', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => {
    const error = new Error('This operation was aborted');
    error.name = 'AbortError';
    error.code = 20;
    throw error;
  };

  try {
    await assert.rejects(
      () => getJson('http://127.0.0.1:3001/api/system-readiness'),
      error => {
        assert.equal(error.code, 'SYSTEM_READINESS_REQUEST_TIMEOUT');
        assert.equal(error.upstreamStatus, 'timeout');
        assert.match(error.message, /bridge input budget/);
        return true;
      },
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('bridge entrypoint is default-disabled and performs no capture or AWS writes', async () => {
  let captures = 0;
  const writes = [];
  const client = {
    put(params) {
      writes.push(params);
      return { promise: async () => ({}) };
    },
  };
  const capture = async () => {
    captures += 1;
    const snapshot = buildReadySnapshot(inputs());
    const published = await publishBridgeSnapshot(snapshot, new Date().toISOString(), { client });
    return { result: buildBridgeResult(snapshot, published) };
  };
  const results = [];

  assert.equal(hermesBridgeEnabled({}), false);
  assert.equal(hermesBridgeEnabled({ HERMES_BRIDGE_ENABLED: 'false' }), false);
  assert.deepEqual(bridgePartitions({}), {
    operations: false,
    portfolio: false,
  });
  const result = await runBridge({
    env: {},
    onceMode: true,
    capture,
    writeResult: value => results.push(value),
    installSignalHandlers: false,
  });

  assert.equal(result.status, 'disabled');
  assert.equal(result.publish.snapshotPublished, false);
  assert.equal(result.publish.heartbeatPublished, false);
  assert.equal(captures, 0);
  assert.equal(writes.length, 0);
  assert.equal(results.length, 1);
});

test('operations can publish before portfolio without touching the sidecar', async () => {
  const candidate = inputs();
  const reads = [];
  const writes = [];
  const client = {
    put(params) {
      writes.push(params);
      return { promise: async () => ({}) };
    },
  };
  const outcome = await captureAndPublish({
    env: {
      HERMES_OPERATIONS_BRIDGE_ENABLED: 'true',
      HERMES_PORTFOLIO_BRIDGE_ENABLED: 'false',
    },
    client,
    readJson: async (url) => {
      reads.push(url);
      assert.equal(url, 'http://127.0.0.1:3001/api/system-readiness');
      assert.equal(new URL(url).search, '');
      return candidate.readiness;
    },
  });

  assert.equal(reads.length, 1);
  assert.equal(reads.some((url) => /live-positions/.test(url)), false);
  assert.equal(outcome.result.status, 'ready');
  assert.equal(outcome.result.operations.status, 'ready');
  assert.equal(outcome.result.operations.published, true);
  assert.equal(outcome.result.portfolio.status, 'disabled');
  assert.equal(outcome.result.portfolio.published, false);
  assert.deepEqual(
    writes
      .filter((item) => item.TableName === 'HermesInputSnapshots')
      .map((item) => item.Item.snapshotType),
    ['operations'],
  );
});

test('bridge entrypoint preserves capture and publication after explicit opt-in', async () => {
  let captures = 0;
  const results = [];
  const expected = { status: 'ready' };

  assert.equal(hermesBridgeEnabled({ HERMES_BRIDGE_ENABLED: 'true' }), true);
  assert.equal(hermesBridgeEnabled({
    HERMES_OPERATIONS_BRIDGE_ENABLED: 'true',
    HERMES_PORTFOLIO_BRIDGE_ENABLED: 'false',
  }), true);
  assert.deepEqual(bridgePartitions({ HERMES_BRIDGE_ENABLED: 'true' }), {
    operations: true,
    portfolio: true,
  });
  const result = await runBridge({
    env: { HERMES_BRIDGE_ENABLED: 'true' },
    onceMode: true,
    capture: async () => {
      captures += 1;
      return { result: expected };
    },
    writeResult: value => results.push(value),
    installSignalHandlers: false,
  });

  assert.equal(result, expected);
  assert.equal(captures, 1);
  assert.deepEqual(results, [expected]);
});

test('ready snapshot strips account identifiers and all display pricing', () => {
  const snapshot = buildReadySnapshot(inputs());
  const serialized = JSON.stringify(snapshot);

  assert.equal(snapshot.bridgeStatus, 'ready');
  assert.equal(snapshot.schemaVersion, 2);
  assert.equal(snapshot.snapshotType, 'portfolio');
  assert.match(snapshot.hostId, /#portfolio$/);
  assert.equal(snapshot.portfolio.source, 'ibkr_live');
  assert.equal(snapshot.portfolio.positions[0].positionSource, 'ibkr_req_positions');
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

test('cached or unverified position provenance fails closed', () => {
  const cached = inputs();
  cached.portfolio.from_cache = true;
  assert.throws(
    () => verifyPortfolio(cached),
    error => error.code === 'PORTFOLIO_POSITION_PROVENANCE_UNVERIFIED',
  );

  const stampedCache = inputs();
  stampedCache.portfolio.position_source = 'ibkr_api';
  assert.throws(
    () => verifyPortfolio(stampedCache),
    error => error.code === 'PORTFOLIO_POSITION_PROVENANCE_UNVERIFIED',
  );

  const accountUpdates = inputs();
  accountUpdates.portfolio.position_source = 'ibkr_req_account_updates';
  assert.throws(
    () => verifyPortfolio(accountUpdates),
    error => error.code === 'PORTFOLIO_POSITION_PROVENANCE_UNVERIFIED',
  );

  const mismatchedObservation = inputs();
  mismatchedObservation.portfolio.positions_observed_at = new Date(
    Date.now() - 1_000,
  ).toISOString();
  assert.throws(
    () => verifyPortfolio(mismatchedObservation),
    error => error.code === 'PORTFOLIO_POSITION_PROVENANCE_UNVERIFIED',
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

  const futurePositions = inputs();
  const future = new Date(Date.now() + 5 * 60_000).toISOString();
  futurePositions.portfolio.observed_at = future;
  futurePositions.portfolio.positions_observed_at = future;
  assert.throws(
    () => verifyPortfolio(futurePositions),
    error => error.code === 'PORTFOLIO_SNAPSHOT_STALE',
  );
});

test('AWS publish denial is reported with a stable typed error', () => {
  assert.equal(publishErrorCode({
    code: 'AccessDeniedException',
    message: 'not authorized to perform dynamodb:PutItem',
  }), 'HERMES_BRIDGE_AWS_ACCESS_DENIED');
});

test('missing dedicated profile credentials have a distinct actionable code', () => {
  assert.equal(publishErrorCode({
    code: 'CredentialsError',
    message: 'Could not load credentials from any providers',
  }), 'HERMES_BRIDGE_AWS_PROFILE_UNAVAILABLE');
  assert.equal(publishErrorCode({
    code: 'ExpiredTokenException',
    message: 'The security token included in the request is expired',
  }), 'HERMES_BRIDGE_AWS_PROFILE_UNAVAILABLE');
  assert.equal(publishErrorCode({
    code: 'NetworkingError',
    message: 'getaddrinfo ENOTFOUND dynamodb.us-west-1.amazonaws.com',
  }), 'HERMES_BRIDGE_AWS_UNREACHABLE');
});

test('operations snapshots carry bounded readiness root causes without portfolio data', () => {
  const candidate = inputs();
  candidate.readiness.rootCauses = [{
    id: 'research-projections',
    errorCode: 'RTA_PROJECTION_UNAVAILABLE',
    summary: 'RTA projection unavailable.',
    owner: 'automation-operations',
    affectedCheckIds: ['research.rta', 'research.current'],
    credentials: 'must-not-be-copied',
  }];
  const snapshot = buildOperationsSnapshot(candidate);

  assert.deepEqual(snapshot.rootCauses, [{
    id: 'research-projections',
    errorCode: 'RTA_PROJECTION_UNAVAILABLE',
    summary: 'RTA projection unavailable.',
    owner: 'automation-operations',
    affectedCheckIds: ['research.rta', 'research.current'],
    suppressionReason: null,
    nextRetryAt: null,
  }]);
  assert.equal(snapshot.schemaVersion, 2);
  assert.equal(snapshot.snapshotType, 'operations');
  assert.match(snapshot.hostId, /#operations$/);
  assert.equal(snapshot.portfolio, undefined);
  assert.equal(JSON.stringify(snapshot).includes('must-not-be-copied'), false);
  assert.equal(JSON.stringify(snapshot).includes('positions'), false);
});

test('publish diagnostics retain an independent input error when the snapshot write is denied', async () => {
  const inputError = new Error('Portfolio input is stale.');
  inputError.code = 'PORTFOLIO_SNAPSHOT_STALE';
  const snapshot = buildDegradedSnapshot(inputError, '2026-07-25T15:00:00.000Z');
  const calls = [];
  const client = {
    put(params) {
      calls.push(params);
      return {
        async promise() {
          if (params.TableName === 'HermesInputSnapshots') {
            const error = new Error('not authorized to perform dynamodb:PutItem');
            error.code = 'AccessDeniedException';
            throw error;
          }
          return {};
        },
      };
    },
  };

  const published = await publishBridgeSnapshot(
    snapshot,
    '2026-07-25T15:00:00.000Z',
    { client },
  );
  const result = buildBridgeResult(snapshot, published);

  assert.equal(result.status, 'error');
  assert.equal(result.inputErrorCode, 'PORTFOLIO_SNAPSHOT_STALE');
  assert.equal(result.publishErrorCode, 'HERMES_BRIDGE_AWS_ACCESS_DENIED');
  assert.equal(result.publishStage, 'snapshot');
  assert.equal(result.publish.snapshotPublished, false);
  assert.equal(result.publish.heartbeatPublished, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].Item.inputErrorCode, 'PORTFOLIO_SNAPSHOT_STALE');
  assert.equal(calls[1].Item.publishErrorCode, 'HERMES_BRIDGE_AWS_ACCESS_DENIED');
  assert.equal(calls[1].Item.publishStage, 'snapshot');
});

test('a healthy input remains distinct when only heartbeat publication fails', async () => {
  const candidate = inputs();
  const snapshot = buildReadySnapshot({
    ...candidate,
    capturedAt: '2026-07-25T15:00:00.000Z',
  });
  const calls = [];
  const client = {
    put(params) {
      calls.push(params);
      return {
        async promise() {
          if (params.TableName === 'MarketDashboardServiceHeartbeats') {
            const error = new Error('heartbeat table is unavailable');
            error.code = 'ResourceNotFoundException';
            throw error;
          }
          return {};
        },
      };
    },
  };

  const published = await publishBridgeSnapshot(
    snapshot,
    '2026-07-25T15:00:00.000Z',
    { client },
  );
  const result = buildBridgeResult(snapshot, published);

  assert.equal(result.input.status, 'ready');
  assert.equal(result.inputErrorCode, null);
  assert.equal(result.publishErrorCode, 'HERMES_BRIDGE_TABLE_MISSING');
  assert.equal(result.publishStage, 'heartbeat');
  assert.equal(result.publish.snapshotPublished, true);
  assert.equal(result.publish.heartbeatPublished, false);
});
