const {
  compareProjections,
  parseArgs,
  queryResearchEvents,
} = require('../../scripts/rebuild_rta_materializations');

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
});
