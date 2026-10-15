// A filtered DynamoDB page can be empty and still have a continuation key.
async function readAllDynamoItems(client, operation, params) {
  if (!['scan', 'query'].includes(operation)) throw new Error('Unsupported paginated read');
  const Items = [];
  const seen = new Set();
  let cursor = params.ExclusiveStartKey;
  do {
    const result = await client[operation]({ ...params, ...(cursor ? { ExclusiveStartKey: cursor } : {}) }).promise();
    Items.push(...(result.Items || []));
    cursor = result.LastEvaluatedKey;
    if (cursor && Object.keys(cursor).length === 0) cursor = undefined;
    if (cursor) {
      const key = JSON.stringify(cursor, Object.keys(cursor).sort());
      if (seen.has(key)) throw new Error('DynamoDB returned a repeated pagination cursor');
      seen.add(key);
    }
  } while (cursor);
  return { Items };
}
module.exports = { readAllDynamoItems };
