async function scanAllPages(documentClient, baseParams) {
  const items = [];
  let exclusiveStartKey;

  do {
    const result = await documentClient.scan({
      ...baseParams,
      ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
    }).promise();
    items.push(...(result.Items || []));
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);

  return items;
}

module.exports = { scanAllPages };
