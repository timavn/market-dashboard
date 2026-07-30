const {
  assertRuntimeConfiguration,
  compareProjections,
  parseArgs,
  queryResearchEvents,
  run,
  validateCallerIdentity,
} = require('../../scripts/rebuild_rta_materializations');
const {
  RESEARCH_EVENT_VERIFICATION_HASH_VERSION,
  computeResearchEventVerificationHash,
} = require('./researchEventLedger.cjs');
const SANITIZED_RTA_CHECKPOINT = require('./__fixtures__/rta-checkpoint.sanitized.json');

describe('RTA rebuild tooling', () => {
  test('is dry-run by default and requires an explicit apply flag', () => {
    expect(parseArgs([])).toMatchObject({ apply: false, json: false, windowDays: 90 });
    expect(parseArgs(['--apply', '--window-days=120'])).toMatchObject({ apply: true, windowDays: 120 });
  });

  test('rejects ambiguous or unsafe arguments', () => {
    expect(() => parseArgs(['--write'])).toThrow(/Unknown argument/);
    expect(() => parseArgs(['--window-days=0'])).toThrow(/between 1 and 730/);
    expect(() => parseArgs(['--since=07-01-2026'])).toThrow(/YYYY-MM-DD/);
  });

  test('pins apply tooling to the least-privilege API profile and exact AWS resources', () => {
    expect(() => assertRuntimeConfiguration({
      AWS_PROFILE: 'market-dashboard-local',
      AWS_REGION: 'us-west-1',
      HERMES_LEDGER_TABLE: 'HermesEmailIngestLedger',
      RESEARCH_EVENT_LEDGER_TABLE: 'ResearchEventLedgerV2',
      HEDGEYE_SNAPSHOT_TABLE: 'HedgeyeDailySnapshot',
      HEDGEYE_BUCKET: 'market-dashboard-csv-data',
    })).not.toThrow();
    expect(() => assertRuntimeConfiguration({
      AWS_PROFILE: 'market-dashboard-admin',
      AWS_REGION: 'us-west-1',
    })).toThrow(/AWS_PROFILE=market-dashboard-local/);
    expect(() => assertRuntimeConfiguration({
      AWS_PROFILE: 'market-dashboard-local',
      AWS_REGION: 'us-east-1',
    })).toThrow(/expected us-west-1/);
    expect(() => assertRuntimeConfiguration({
      AWS_PROFILE: 'market-dashboard-local',
      AWS_REGION: 'us-west-1',
      HEDGEYE_BUCKET: 'other-bucket',
    })).toThrow(/HEDGEYE_BUCKET/);
  });

  test('requires the exact-account least-privilege IAM principal', () => {
    expect(validateCallerIdentity({
      Account: '915328198276',
      Arn: 'arn:aws:iam::915328198276:user/market-dashboard-local',
    })).toMatchObject({ Account: '915328198276' });
    expect(() => validateCallerIdentity({
      Account: '000000000000',
      Arn: 'arn:aws:iam::000000000000:user/market-dashboard-local',
    })).toThrow(/expected 915328198276/);
    expect(() => validateCallerIdentity({
      Account: '915328198276',
      Arn: 'arn:aws:sts::915328198276:assumed-role/AWSReservedSSO_AdministratorAccess/test',
    })).toThrow(/least-privilege market-dashboard-local/);
  });

  test('does not rewrite an idempotent projection with the same canonical version', () => {
    const desired = [{
      date: '2026-07-02',
      dataVersion: 'gmail-ledger-v2:abc',
      itemCount: 2,
      data: { alerts: [{ ticker: 'PALL' }, { ticker: 'VIK' }] },
    }];
    const existing = [{
      date: '2026-07-02',
      dataVersion: 'gmail-ledger-v2:abc',
      itemCount: 2,
    }];

    expect(compareProjections(existing, desired)).toEqual([
      expect.objectContaining({ date: '2026-07-02', status: 'unchanged' }),
    ]);
  });

  test('identifies only missing or version-changed dates for a rebuild', () => {
    const desired = [
      { date: '2026-07-02', dataVersion: 'v2', itemCount: 2 },
      { date: '2026-07-08', dataVersion: 'v3', itemCount: 2 },
    ];
    const existing = [{ date: '2026-07-02', dataVersion: 'v1', itemCount: 1 }];

    expect(compareProjections(existing, desired).map(({ date, status }) => ({ date, status }))).toEqual([
      { date: '2026-07-02', status: 'update' },
      { date: '2026-07-08', status: 'create' },
    ]);
  });

  test('reads every V2 event-ledger page in canonical key order', async () => {
    const responses = [
      { Items: [{ eventKey: 'a' }], LastEvaluatedKey: { productKey: 'real-time-alert', eventKey: 'a' } },
      { Items: [{ eventKey: 'b' }] },
    ];
    const query = jest.fn(() => ({ promise: async () => responses.shift() }));

    await expect(queryResearchEvents({ query }, 'real-time-alert')).resolves.toEqual({
      items: [{ eventKey: 'a' }, { eventKey: 'b' }],
      error: null,
    });
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0][0]).toMatchObject({
      TableName: 'ResearchEventLedgerV2',
      ScanIndexForward: true,
      ConsistentRead: true,
    });
  });

  test('reports a V2 read failure so callers can identify legacy fallback mode', async () => {
    const query = jest.fn(() => ({ promise: async () => {
      const error = new Error('missing table');
      error.code = 'ResourceNotFoundException';
      throw error;
    } }));

    await expect(queryResearchEvents({ query }, 'real-time-alert')).resolves.toEqual({
      items: [],
      error: 'ResourceNotFoundException',
    });
  });

  test('performs no projection writes when canonical replay fails structural validation', async () => {
    const requiredEnvironment = {
      AWS_PROFILE: 'market-dashboard-local',
      AWS_DEFAULT_PROFILE: 'market-dashboard-local',
      AWS_REGION: 'us-west-1',
      AWS_DEFAULT_REGION: 'us-west-1',
      HERMES_LEDGER_TABLE: 'HermesEmailIngestLedger',
      RESEARCH_EVENT_LEDGER_TABLE: 'ResearchEventLedgerV2',
      HEDGEYE_SNAPSHOT_TABLE: 'HedgeyeDailySnapshot',
      HEDGEYE_BUCKET: 'market-dashboard-csv-data',
    };
    const previousEnvironment = Object.fromEntries(
      Object.keys(requiredEnvironment).map((key) => [key, process.env[key]]),
    );
    Object.assign(process.env, requiredEnvironment);

    const eventTime = new Date().toISOString();
    const unmatchedRemove = {
      productKey: 'real-time-alert',
      eventKey: `${eventTime}#unmatched-remove#0000`,
      eventType: 'POSITION_ACTION',
      eventTime,
      sourceMessageId: 'unmatched-remove-message',
      sequence: 0,
      sourceEventCount: 1,
      payload: {
        ticker: 'ZZZZ',
        action: 'REMOVE',
        side: 'long',
      },
      parserVersion: 'research-event-ledger-v2:test',
      eventHash: '0'.repeat(64),
      verificationHashVersion: RESEARCH_EVENT_VERIFICATION_HASH_VERSION,
    };
    unmatchedRemove.verificationHash = computeResearchEventVerificationHash(unmatchedRemove);

    const put = jest.fn(() => ({ promise: async () => ({}) }));
    const dynamodb = {
      scan: jest.fn(() => ({ promise: async () => ({ Items: [] }) })),
      query: jest.fn(() => ({
        promise: async () => ({
          Items: [unmatchedRemove],
        }),
      })),
      put,
    };
    const sts = {
      getCallerIdentity: jest.fn(() => ({
        promise: async () => ({
          Account: '915328198276',
          Arn: 'arn:aws:iam::915328198276:user/market-dashboard-local',
        }),
      })),
    };

    try {
      await expect(run(
        { apply: true, json: true, windowDays: 90 },
        {
          baseline: SANITIZED_RTA_CHECKPOINT,
          dynamodb,
          s3: { getObject: jest.fn() },
          sts,
        },
      )).rejects.toThrow(/failed structural validation.*unmatched-remove/);
      expect(put).not.toHaveBeenCalled();
    } finally {
      for (const [key, value] of Object.entries(previousEnvironment)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test('performs no projection writes when a source message has incomplete canonical coverage', async () => {
    const requiredEnvironment = {
      AWS_PROFILE: 'market-dashboard-local',
      AWS_DEFAULT_PROFILE: 'market-dashboard-local',
      AWS_REGION: 'us-west-1',
      AWS_DEFAULT_REGION: 'us-west-1',
      HERMES_LEDGER_TABLE: 'HermesEmailIngestLedger',
      RESEARCH_EVENT_LEDGER_TABLE: 'ResearchEventLedgerV2',
      HEDGEYE_SNAPSHOT_TABLE: 'HedgeyeDailySnapshot',
      HEDGEYE_BUCKET: 'market-dashboard-csv-data',
    };
    const previousEnvironment = Object.fromEntries(
      Object.keys(requiredEnvironment).map((key) => [key, process.env[key]]),
    );
    Object.assign(process.env, requiredEnvironment);

    const eventTime = new Date().toISOString();
    const canonicalEvent = {
      productKey: 'real-time-alert',
      eventKey: `${eventTime}#partial-message#0000`,
      eventType: 'POSITION_ACTION',
      eventTime,
      sourceMessageId: 'partial-message',
      sequence: 0,
      sourceEventCount: 1,
      payload: {
        ticker: 'PALL',
        action: 'SELL',
        intent: 'open-short',
        side: 'short',
      },
      parserVersion: 'research-event-ledger-v2:test',
      eventHash: '1'.repeat(64),
      verificationHashVersion: RESEARCH_EVENT_VERIFICATION_HASH_VERSION,
    };
    canonicalEvent.verificationHash = computeResearchEventVerificationHash(canonicalEvent);
    const legacyItem = {
      messageId: 'partial-message',
      attachmentId: 'message-body-html-0',
      status: 'STORED',
      subject: '**Real-Time Alert: Buy Signal: Apple (AAPL)',
      receivedAt: eventTime,
      snapshotDate: eventTime.slice(0, 10),
      reportType: 'real-time-alert',
      snapshotType: 'real-time-alert',
    };

    const put = jest.fn(() => ({ promise: async () => ({}) }));
    const dynamodb = {
      scan: jest.fn((request) => ({
        promise: async () => ({
          Items: request.TableName === 'HermesEmailIngestLedger' ? [legacyItem] : [],
        }),
      })),
      query: jest.fn(() => ({
        promise: async () => ({
          Items: [canonicalEvent],
        }),
      })),
      put,
    };
    const sts = {
      getCallerIdentity: jest.fn(() => ({
        promise: async () => ({
          Account: '915328198276',
          Arn: 'arn:aws:iam::915328198276:user/market-dashboard-local',
        }),
      })),
    };

    try {
      const dryRunReport = await run(
        { apply: false, json: true, windowDays: 90 },
        {
          baseline: SANITIZED_RTA_CHECKPOINT,
          dynamodb,
          s3: { getObject: jest.fn() },
          sts,
        },
      );
      expect(dryRunReport.canonicalCoverageGaps).toEqual([
        expect.objectContaining({
          sourceMessageId: 'partial-message',
          canonicalEventCount: 1,
          legacyEventCount: 1,
        }),
      ]);
      expect(dryRunReport.currentBoard.available).toBe(false);
      expect(put).not.toHaveBeenCalled();

      await expect(run(
        { apply: true, json: true, windowDays: 90 },
        {
          baseline: SANITIZED_RTA_CHECKPOINT,
          dynamodb,
          s3: { getObject: jest.fn() },
          sts,
        },
      )).rejects.toThrow(/incomplete event coverage/);
      expect(put).not.toHaveBeenCalled();
    } finally {
      for (const [key, value] of Object.entries(previousEnvironment)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
