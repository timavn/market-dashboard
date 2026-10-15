const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readAllDynamoItems } = require('./dynamoPagination.cjs');
for (const operation of ['scan', 'query']) {
  test(`${operation} includes records after an empty filtered page`, async () => {
    const params = [];
    const pages = [
      { Items: [{ id: 'old' }], LastEvaluatedKey: { id: 'a' } },
      { Items: [], LastEvaluatedKey: { id: 'b' } },
      { Items: [{ id: 'new' }] },
    ];
    const client = { [operation]: input => { params.push(input); return { promise: async () => pages.shift() }; } };
    assert.deepEqual(await readAllDynamoItems(client, operation, { TableName: 'Example', FilterExpression: 'x = :x' }), { Items: [{ id: 'old' }, { id: 'new' }] });
    assert.deepEqual(params.map(p => p.ExclusiveStartKey), [undefined, { id: 'a' }, { id: 'b' }]);
    assert.ok(params.every(p => p.FilterExpression === 'x = :x'));
  });
}
test('pagination fails visibly on an impossible repeating cursor', async () => {
  const client = { scan: () => ({ promise: async () => ({ Items: [], LastEvaluatedKey: { id: 'a' } }) }) };
  await assert.rejects(readAllDynamoItems(client, 'scan', {}), /repeated/);
});
