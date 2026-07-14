const { scanAllPages } = require('./dynamoScanAllPages.cjs');

describe('scanAllPages', () => {
  it('follows LastEvaluatedKey and preserves items from every page', async () => {
    const promise = jest.fn()
      .mockResolvedValueOnce({ Items: [{ date: '2026-07-01' }], LastEvaluatedKey: { pk: 'page-2' } })
      .mockResolvedValueOnce({ Items: [], LastEvaluatedKey: { pk: 'page-3' } })
      .mockResolvedValueOnce({ Items: [{ date: '2026-07-11' }] });
    const scan = jest.fn(() => ({ promise }));

    const items = await scanAllPages({ scan }, {
      TableName: 'HedgeyeDailySnapshot',
      FilterExpression: 'snapshotType = :type',
      ExpressionAttributeValues: { ':type': 'cftc-positioning' },
    });

    expect(items).toEqual([{ date: '2026-07-01' }, { date: '2026-07-11' }]);
    expect(scan).toHaveBeenNthCalledWith(1, expect.not.objectContaining({ ExclusiveStartKey: expect.anything() }));
    expect(scan).toHaveBeenNthCalledWith(2, expect.objectContaining({ ExclusiveStartKey: { pk: 'page-2' } }));
    expect(scan).toHaveBeenNthCalledWith(3, expect.objectContaining({ ExclusiveStartKey: { pk: 'page-3' } }));
  });
});
