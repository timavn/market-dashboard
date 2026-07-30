const { buildWorkerSnapshot } = require('./hermesManagingDirector.cjs');

describe('Hermes Managing Director heartbeat authority', () => {
  const worker = {
    key: 'quant-developer',
    name: 'Quant Developer',
    description: 'Operations monitor',
    schedule: 'Every 15 minutes',
    triggerType: 'schedule',
    readinessMaxAgeMinutes: 45,
    scheduleId: 'market-dashboard-hermes-quant-developer-v2',
    heartbeatServiceId: 'hermes:quant-developer',
  };
  const now = new Date('2026-07-27T20:00:00.000Z');

  test('displays an expired successful run as stale history', () => {
    const snapshot = buildWorkerSnapshot(
      worker,
      {
        status: 'succeeded',
        summary: 'Old run succeeded.',
        startedAt: '2026-07-15T20:00:00.000Z',
        finishedAt: '2026-07-15T20:01:00.000Z',
      },
      {},
      [],
      null,
      now,
    );

    expect(snapshot).toMatchObject({
      status: 'warning',
      heartbeatFresh: false,
      heartbeatScheduled: false,
      historicalLastRun: '2026-07-15T20:00:00.000Z',
    });
    expect(snapshot.summary).toMatch(/historical/i);
  });

  test('accepts only a fresh heartbeat from the exact owned schedule', () => {
    const snapshot = buildWorkerSnapshot(
      worker,
      null,
      {},
      [],
      {
        status: 'success',
        source: 'aws-lambda',
        triggerSource: 'aws-scheduler',
        scheduled: true,
        scheduleId: worker.scheduleId,
        observedAt: '2026-07-27T19:55:00.000Z',
        detail: 'Scheduled diagnostic completed.',
      },
      now,
    );

    expect(snapshot).toMatchObject({
      status: 'succeeded',
      heartbeatFresh: true,
      heartbeatScheduled: true,
      heartbeatAt: '2026-07-27T19:55:00.000Z',
    });
  });

  test('rejects a scheduled heartbeat more than thirty seconds in the future', () => {
    const snapshot = buildWorkerSnapshot(
      worker,
      null,
      {},
      [],
      {
        status: 'success',
        source: 'aws-lambda',
        triggerSource: 'aws-scheduler',
        scheduled: true,
        scheduleId: worker.scheduleId,
        observedAt: '2026-07-27T20:00:31.000Z',
        detail: 'Future-dated diagnostic.',
      },
      now,
    );

    expect(snapshot).toMatchObject({
      status: 'warning',
      heartbeatFresh: false,
      heartbeatScheduled: true,
      heartbeatAt: '2026-07-27T20:00:31.000Z',
    });
    expect(snapshot.summary).toMatch(/ahead of the dashboard clock/i);
  });

  test('allows at most thirty seconds of worker heartbeat clock skew', () => {
    const snapshot = buildWorkerSnapshot(
      worker,
      null,
      {},
      [],
      {
        status: 'success',
        source: 'aws-lambda',
        triggerSource: 'aws-scheduler',
        scheduled: true,
        scheduleId: worker.scheduleId,
        observedAt: '2026-07-27T20:00:30.000Z',
        detail: 'Within tolerated clock skew.',
      },
      now,
    );

    expect(snapshot).toMatchObject({
      status: 'succeeded',
      heartbeatFresh: true,
      heartbeatScheduled: true,
    });
  });
});
