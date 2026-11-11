'use strict';

/** Bounded archive reads. The caller owns the worker and AWS client. */
function createPublishedTradeSnapshotReader({ dynamodb, tableName = 'HedgeyeDailySnapshot',
  indexName = 'snapshotType-date-meta-index', concurrency = 2, now = () => new Date() } = {}) {
  const maximum = Math.max(1, Math.min(2, Number(concurrency) || 2));
  let active = 0;
  const queue = [];
  const acquire = async () => {
    if (active >= maximum) await new Promise(resolve => queue.push(resolve));
    else active += 1;
  };
  const release = () => { const next = queue.shift(); if (next) next(); else active -= 1; };

  // `skipKey` receives each index row (date, snapshotType, scrapedAt) and
  // returns true for a document the caller already holds unchanged. A read is
  // billed on the whole document, so skipping is the only way to save one.
  async function query(type, { limit = 60, snapshotProjectionExpression, snapshotAttributeNames = {}, skipKey = null } = {}) {
    if (!String(type || '').trim()) return [];
    const count = Math.max(1, Math.min(200, Number(limit) || 60));
    const skips = typeof skipKey === 'function';
    const projection = snapshotProjectionExpression ? {
      ProjectionExpression: snapshotProjectionExpression,
      ExpressionAttributeNames: snapshotAttributeNames,
    } : {};
    await acquire();
    try {
      let keys;
      try {
        const response = await dynamodb.query({
          TableName: tableName, IndexName: indexName,
          KeyConditionExpression: '#type = :type',
          ExpressionAttributeNames: { '#type': 'snapshotType', '#date': 'date', ...(skips ? { '#scrapedAt': 'scrapedAt' } : {}) },
          ExpressionAttributeValues: { ':type': type },
          ProjectionExpression: skips ? '#type, #date, #scrapedAt' : '#type, #date', ScanIndexForward: false, Limit: count,
        }).promise();
        keys = (response.Items || []).filter(row => !(skips && skipKey(row)))
          .map(row => ({ date: row.date, snapshotType: row.snapshotType }));
      } catch (error) {
        if (!['ResourceNotFoundException', 'ValidationException'].includes(error.code || error.name)) throw error;
        // Preserve the repository's bounded exact-key migration fallback. No
        // table scan or full-document GSI query is permitted here.
        const rows = [];
        const seen = new Set();
        const anchor = new Date(now());
        for (let offset = 0; offset < Math.max(14, count * 7) && rows.length < count; offset += 1) {
          const value = new Date(anchor);
          value.setUTCDate(value.getUTCDate() - offset);
          const date = value.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
          if (seen.has(date)) continue;
          seen.add(date);
          const response = await dynamodb.get({ TableName: tableName,
            Key: { date, snapshotType: type }, ...projection }).promise();
          if (response.Item) rows.push(response.Item);
        }
        return rows;
      }
      const rows = [];
      for (let offset = 0; offset < keys.length; offset += 100) {
        let pending = keys.slice(offset, offset + 100);
        for (let attempt = 0; pending.length && attempt < 4; attempt += 1) {
          const response = await dynamodb.batchGet({ RequestItems: {
            [tableName]: { Keys: pending, ConsistentRead: false, ...projection },
          } }).promise();
          rows.push(...(response.Responses?.[tableName] || []));
          pending = response.UnprocessedKeys?.[tableName]?.Keys || [];
        }
        if (pending.length) throw Object.assign(new Error('Archive snapshot read incomplete'), { code: 'HEDGEYE_SNAPSHOT_BATCH_UNPROCESSED' });
      }
      return rows;
    } finally { release(); }
  }
  return query;
}

module.exports = { createPublishedTradeSnapshotReader };
