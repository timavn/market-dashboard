const {
  assertArchiveDate,
  batchGetTldrSnapshots,
  buildMorningTldrArchive,
  buildMorningTldrDay,
  buildMorningTldrStatus,
  marketDateCandidates,
  parseArchiveDate,
} = require('./morningTldrArchive.cjs');

const productIds = ['top-3-things', 'risk-ranges', 'early-look', 'the-call', 'the-macro-show', 'signal-strength'];

const makeClient = (items, { retry = false } = {}) => {
  let calls = 0;
  return {
    batchGet: jest.fn(({ RequestItems }) => {
      calls += 1;
      const request = RequestItems.HedgeyeDailySnapshot;
      const requestedKeys = request.Keys;
      const found = requestedKeys
        .map((key) => items.find((item) => item.date === key.date && item.snapshotType === key.snapshotType))
        .filter(Boolean);
      if (retry && calls === 1) {
        return { promise: async () => ({ Responses: { HedgeyeDailySnapshot: found.slice(0, -1) }, UnprocessedKeys: { HedgeyeDailySnapshot: { Keys: [requestedKeys[requestedKeys.length - 1]] } } }) };
      }
      return { promise: async () => ({ Responses: { HedgeyeDailySnapshot: found }, UnprocessedKeys: {} }) };
    }),
  };
};

const makeStatusClient = ({ snapshots = [], manifests = [] } = {}) => ({
  batchGet: jest.fn(({ RequestItems }) => ({
    promise: async () => ({
      Responses: {
        HedgeyeDailySnapshot: (RequestItems.HedgeyeDailySnapshot?.Keys || [])
          .map((key) => snapshots.find((item) => (
            item.date === key.date && item.snapshotType === key.snapshotType
          )))
          .filter(Boolean),
        ResearchProductManifestsV1: (RequestItems.ResearchProductManifestsV1?.Keys || [])
          .map((key) => manifests.find((item) => (
            item.marketDate === key.marketDate && item.productKey === key.productKey
          )))
          .filter(Boolean),
      },
      UnprocessedKeys: {},
    }),
  })),
});

describe('morningTldrArchive', () => {
  test('generates New York market dates and excludes weekends and holidays', () => {
    expect(marketDateCandidates(new Date('2026-07-06T14:00:00Z'), 3)).toEqual([
      '2026-07-06',
      '2026-07-02',
      '2026-07-01',
    ]);
    expect(marketDateCandidates(new Date('2026-08-08T14:00:00Z'), 2)).toEqual([
      '2026-08-07',
      '2026-08-06',
    ]);
  });

  test('validates exact dates', () => {
    expect(parseArchiveDate('2026-02-30')).toBeNull();
    expect(() => assertArchiveDate('not-a-date')).toThrow(/YYYY-MM-DD/);
    expect(() => assertArchiveDate('2026-02-30')).toThrow(/YYYY-MM-DD/);
  });

  test('retries unprocessed BatchGet keys', async () => {
    const client = makeClient([{ date: '2026-08-06', snapshotType: 'risk-ranges' }], { retry: true });
    const items = await batchGetTldrSnapshots(client, ['2026-08-06'], { snapshotTypes: ['risk-ranges'] });
    expect(items).toHaveLength(1);
    expect(client.batchGet).toHaveBeenCalledTimes(2);
  });

  test('returns ten saved dates and keeps expired snapshots unavailable', async () => {
    const dates = ['2026-08-06', '2026-08-05', '2026-08-04'];
    const items = dates.flatMap((date) => productIds.map((snapshotType) => ({ date, snapshotType, data: {} })));
    items.push({ date: '2026-08-03', snapshotType: 'risk-ranges', ttl: 1, data: {} });
    const client = makeClient(items);
    const archive = await buildMorningTldrArchive(client, {
      now: new Date('2026-08-06T16:00:00Z'),
      visibleDays: 10,
      lookbackMarketDays: 10,
    });
    expect(archive.dates.map((entry) => entry.date)).toEqual(dates);
    expect(archive.dates[0].availableProducts).toEqual(productIds);
    expect(archive.retentionDays).toBe(730);
  });

  test('returns exact snapshots and previous same-product publications', async () => {
    const items = [
      { date: '2026-08-06', snapshotType: 'risk-ranges', data: { now: true } },
      { date: '2026-08-05', snapshotType: 'risk-ranges', data: { prior: true } },
      { date: '2026-08-06', snapshotType: 'early-look', data: { now: true } },
    ];
    const client = makeClient(items);
    const day = await buildMorningTldrDay(client, '2026-08-06', {
      now: new Date('2026-08-06T16:00:00Z'),
      lookbackMarketDays: 10,
    });
    expect(day.snapshots['risk-ranges'].data).toEqual({ now: true });
    expect(day.previousSnapshots['risk-ranges'].data).toEqual({ prior: true });
    expect(day.snapshots['the-call']).toBeNull();
    expect(day.missingProducts).toContain('the-call');
    expect(day.historical).toBe(false);
  });

  test('reports awaiting when no exact-date source artifacts exist', async () => {
    const client = makeStatusClient();
    const status = await buildMorningTldrStatus(client, '2026-08-06', {
      now: new Date('2026-08-06T16:00:00.000Z'),
    });

    expect(Object.values(status.products)).toEqual(productIds.map(() => ({
      state: 'awaiting',
      observedAt: null,
    })));
    expect(status.contentRevision).toMatch(/^[a-f0-9]{64}$/);
    expect(client.batchGet).toHaveBeenCalledTimes(1);
    const request = client.batchGet.mock.calls[0][0].RequestItems;
    expect(request.HedgeyeDailySnapshot.Keys).toHaveLength(productIds.length);
    expect(request.ResearchProductManifestsV1.Keys).toHaveLength(productIds.length);
    expect(request.HedgeyeDailySnapshot.ConsistentRead).toBe(true);
    expect(request.ResearchProductManifestsV1.ConsistentRead).toBe(true);
    expect(Object.values(request.HedgeyeDailySnapshot.ExpressionAttributeNames))
      .not.toEqual(expect.arrayContaining(['data', 'article']));
    expect(Object.values(request.ResearchProductManifestsV1.ExpressionAttributeNames))
      .not.toEqual(expect.arrayContaining(['artifacts']));
  });

  test('derives processing, saved, failed, and saved-update-failed without exposing source ids', async () => {
    const date = '2026-08-06';
    const client = makeStatusClient({
      snapshots: [
        {
          date,
          snapshotType: 'the-macro-show',
          scrapedAt: '2026-08-06T15:18:00.000Z',
          gmailMessageId: 'raw-gmail-id',
          htmlSource: 'private/source/key.html',
        },
        {
          date,
          snapshotType: 'signal-strength',
          scrapedAt: '2026-08-06T16:30:00.000Z',
          sourceEventId: 'raw-source-event-id',
        },
        {
          date,
          snapshotType: 'risk-ranges',
          scrapedAt: '2026-08-06T12:00:00.000Z',
          ttl: 1,
        },
      ],
      manifests: [
        { marketDate: date, productKey: 'the-call', state: 'received', updatedAt: '2026-08-06T15:00:00.000Z' },
        { marketDate: date, productKey: 'the-macro-show', state: 'indexed', indexedCount: 1 },
        { marketDate: date, productKey: 'signal-strength', state: 'failed', failedCount: 1 },
        { marketDate: date, productKey: 'risk-ranges', state: 'indexed', indexedCount: 1 },
        { marketDate: date, productKey: 'early-look', state: 'failed', failedCount: 1 },
      ],
    });

    const status = await buildMorningTldrStatus(client, date, {
      now: new Date('2026-08-06T17:00:00.000Z'),
    });

    expect(status.products['top-3-things'].state).toBe('awaiting');
    expect(status.products['the-call'].state).toBe('processing');
    expect(status.products['the-macro-show'].state).toBe('saved');
    expect(status.products['signal-strength'].state).toBe('saved_update_failed');
    expect(status.products['risk-ranges'].state).toBe('failed');
    expect(status.products['early-look'].state).toBe('failed');
    expect(JSON.stringify(status)).not.toContain('raw-gmail-id');
    expect(JSON.stringify(status)).not.toContain('raw-source-event-id');
    expect(JSON.stringify(status)).not.toContain('private/source/key.html');
  });

  test('changes contentRevision for a second same-day Signal Strength edition, not manifest-only changes', async () => {
    const date = '2026-08-06';
    const firstSnapshot = {
      date,
      snapshotType: 'signal-strength',
      scrapedAt: '2026-08-06T15:00:00.000Z',
      htmlSource: 'source/first.html',
    };
    const first = await buildMorningTldrStatus(makeStatusClient({
      snapshots: [firstSnapshot],
      manifests: [{ marketDate: date, productKey: 'signal-strength', state: 'received' }],
    }), date);
    const manifestOnlyUpdate = await buildMorningTldrStatus(makeStatusClient({
      snapshots: [firstSnapshot],
      manifests: [{ marketDate: date, productKey: 'signal-strength', state: 'indexed' }],
    }), date);
    const secondEdition = await buildMorningTldrStatus(makeStatusClient({
      snapshots: [{
        ...firstSnapshot,
        scrapedAt: '2026-08-06T18:00:00.000Z',
        htmlSource: 'source/second.html',
      }],
      manifests: [{ marketDate: date, productKey: 'signal-strength', state: 'indexed' }],
    }), date);

    expect(manifestOnlyUpdate.contentRevision).toBe(first.contentRevision);
    expect(secondEdition.contentRevision).not.toBe(first.contentRevision);
  });
});
