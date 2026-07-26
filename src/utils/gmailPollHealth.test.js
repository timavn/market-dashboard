const { resolveEtfProPayloadFromSources } = require('./etfProResolver.cjs');
const { resolveGmailPollHealth } = require('./gmailPollHealth.cjs');

const NOW = new Date('2026-07-21T17:00:00.000Z');
const ACCOUNT = 'timsmithaviation@gmail.com';
const SERVICE_ID = `gmail:${ACCOUNT}`;
const SCHEDULE_ID = 'market-dashboard-gmail-v2-every-15m';

function heartbeat(overrides = {}) {
  return {
    serviceId: SERVICE_ID,
    observedAt: '2026-07-21T16:59:00.000Z',
    finishedAt: '2026-07-21T16:59:00.000Z',
    status: 'success',
    source: 'aws-lambda',
    triggerSource: 'aws-scheduler',
    scheduled: true,
    scheduleId: SCHEDULE_ID,
    counts: { messages: 0, stored: 0, errors: 0 },
    ...overrides,
  };
}

function heartbeatStore(value) {
  return {
    available: true,
    found: Boolean(value),
    serviceId: SERVICE_ID,
    heartbeat: value || null,
  };
}

const greenLambdaMetrics = {
  functionName: 'market-dashboard-gmail-ingestor-v2',
  invocations: 3,
  errors: 0,
  latestAt: '2026-07-21T16:59:00.000Z',
  windowMinutes: 45,
};

describe('typed Gmail poll health', () => {
  test('accepts a fresh scheduled success heartbeat even when zero messages arrived', () => {
    const result = resolveGmailPollHealth({
      heartbeatStore: heartbeatStore(heartbeat()),
      metrics: { error: 'CloudWatch unavailable' },
      account: ACCOUNT,
      now: NOW,
    });

    expect(result).toMatchObject({
      status: 'healthy',
      healthy: true,
      verified: true,
      source: 'service-heartbeat-table',
      serviceId: SERVICE_ID,
      counts: { messages: 0, stored: 0, errors: 0 },
      cloudwatch: { error: 'CloudWatch unavailable' },
    });
  });

  test('does not let successful Lambda invocation metrics override auth_required', () => {
    const result = resolveGmailPollHealth({
      heartbeatStore: heartbeatStore(heartbeat({
        status: 'auth_required',
        errorCode: 'GMAIL_AUTH_REQUIRED',
        detail: 'OAuth authorization is blocked until the secret changes.',
      })),
      metrics: greenLambdaMetrics,
      account: ACCOUNT,
      now: NOW,
    });

    expect(result).toMatchObject({
      status: 'auth_required',
      healthy: false,
      verified: true,
      errorCode: 'GMAIL_AUTH_REQUIRED',
      cloudwatch: { invocations: 3, errors: 0 },
    });
  });

  test.each([
    [
      'missing',
      heartbeatStore(null),
      'GMAIL_HEARTBEAT_MISSING',
    ],
    [
      'unavailable',
      {
        available: false,
        found: false,
        errorCode: 'SERVICE_HEARTBEAT_QUERY_FAILED',
        error: 'Access denied.',
      },
      'SERVICE_HEARTBEAT_QUERY_FAILED',
    ],
  ])('fails closed when the typed heartbeat is %s despite green metrics', (_label, store, errorCode) => {
    const result = resolveGmailPollHealth({
      heartbeatStore: store,
      metrics: greenLambdaMetrics,
      account: ACCOUNT,
      now: NOW,
    });

    expect(result).toMatchObject({
      status: 'unhealthy',
      healthy: false,
      verified: true,
      errorCode,
      cloudwatch: { invocations: 3, errors: 0 },
    });
  });

  test('fails closed on a stale success heartbeat', () => {
    const result = resolveGmailPollHealth({
      heartbeatStore: heartbeatStore(heartbeat({
        observedAt: '2026-07-21T16:00:00.000Z',
        finishedAt: '2026-07-21T16:00:00.000Z',
      })),
      metrics: greenLambdaMetrics,
      account: ACCOUNT,
      now: NOW,
      maxAgeMinutes: 45,
    });

    expect(result).toMatchObject({
      status: 'stale',
      healthy: false,
      errorCode: 'GMAIL_POLL_STALE',
    });
  });

  test('fails closed on an unknown status or unverified scheduler provenance', () => {
    const unknown = resolveGmailPollHealth({
      heartbeatStore: heartbeatStore(heartbeat({ status: 'idle' })),
      metrics: greenLambdaMetrics,
      account: ACCOUNT,
      now: NOW,
    });
    const manual = resolveGmailPollHealth({
      heartbeatStore: heartbeatStore(heartbeat({
        triggerSource: 'manual',
        scheduled: false,
        scheduleId: null,
      })),
      metrics: greenLambdaMetrics,
      account: ACCOUNT,
      now: NOW,
    });

    expect(unknown).toMatchObject({ healthy: false, errorCode: 'GMAIL_HEARTBEAT_INVALID' });
    expect(manual).toMatchObject({ healthy: false, errorCode: 'GMAIL_SCHEDULER_PROVENANCE_INVALID' });
  });

  test('keeps the structurally valid ETF book archival-only during a handled OAuth failure', () => {
    const ingestionHealth = resolveGmailPollHealth({
      heartbeatStore: heartbeatStore(heartbeat({
        status: 'auth_required',
        errorCode: 'GMAIL_AUTH_REQUIRED',
      })),
      metrics: greenLambdaMetrics,
      account: ACCOUNT,
      now: NOW,
    });
    const payload = resolveEtfProPayloadFromSources({
      localPayload: {
        meta: {
          snapshotDate: '2026-07-17',
          parsedAt: '2026-07-17T12:00:00.000Z',
          source: 'manual-current-open-positions',
          sourceKind: 'active-open-positions',
          rowCount: 2,
        },
        rows: [
          { ticker: 'SPY', etf: 'SPY', call: 'Long', assetClass: 'ETF Pro' },
          { ticker: 'TLT', etf: 'TLT', call: 'Short', assetClass: 'ETF Pro' },
        ],
      },
      hermesPayloads: { actions: [], fullBooks: [] },
      ingestionHealth,
    });

    expect(payload).toMatchObject({
      available: false,
      rows: [],
      longCount: null,
      shortCount: null,
      dataAvailability: {
        ingestionStatus: 'unhealthy',
        current: false,
        comparisonSafe: false,
        referenceOnly: true,
        errorCode: 'GMAIL_AUTH_REQUIRED',
      },
      meta: { blockedByIngestion: true, archivedRowCount: 2 },
    });
    expect(payload.lastKnownGood).toMatchObject({
      available: true,
      current: false,
      comparisonSafe: false,
      referenceOnly: true,
      longCount: 1,
      shortCount: 1,
    });
    expect(payload.lastKnownGood.rows).toHaveLength(2);
  });
});
