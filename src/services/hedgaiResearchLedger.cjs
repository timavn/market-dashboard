'use strict';

const { createAsyncTtlCache } = require('../utils/serverResponseCache.cjs');

// The HedgAI worker keeps the API's existing full-product query and cache
// policy. Published editions, repairs and reviewed checkpoints stay intact.
function createHedgaiLedgerLoader({ dynamodb, tableName, now = Date.now,
  onDiagnostic = () => {} } = {}) {
  const cache = createAsyncTtlCache({ ttlMs: 5 * 60_000, maxEntries: 10, now });
  return async ({ sinceEventTime = null, limit = 20_000, forceRefresh = false, refreshAfter = null } = {}) => {
    try {
      const cacheKey = `hedgai-signals:${sinceEventTime || 'all'}:${limit}`;
      const cached = cache.peek(cacheKey);
      if (forceRefresh && cached && (!refreshAfter || cached.storedAt < Number(refreshAfter))) cache.delete(cacheKey);
      let pages = 0;
      const result = await cache.get(cacheKey, async () => {
        const items = [];
        let exclusiveStartKey;
        do {
          const names = { '#productKey': 'productKey' };
          const values = { ':productKey': 'hedgai-signals' };
          let expression = '#productKey = :productKey';
          if (sinceEventTime) {
            names['#eventKey'] = 'eventKey';
            values[':startEventKey'] = String(sinceEventTime);
            expression += ' AND #eventKey >= :startEventKey';
          }
          const page = await dynamodb.query({
            TableName: tableName, KeyConditionExpression: expression,
            ExpressionAttributeNames: names, ExpressionAttributeValues: values,
            ScanIndexForward: true, ConsistentRead: false,
            Limit: Math.max(1, Math.min(1_000, Number(limit) || 20_000)),
            ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
          }).promise();
          pages += 1;
          items.push(...(page.Items || []));
          if (items.length >= limit) break;
          exclusiveStartKey = page.LastEvaluatedKey;
        } while (exclusiveStartKey);
        return items.slice(0, limit);
      });
      try { onDiagnostic({ stage: 'ledger', itemCount: result.value?.length || 0, pages, cacheStatus: result.status }); }
      catch { /* Diagnostics cannot change captured evidence. */ }
      if (result.status === 'stale') return { items: [], error: 'RESEARCH_EVENT_LEDGER_CACHE_STALE' };
      return { items: result.value || [], error: null };
    } catch (error) {
      return { items: [], error: error.code || error.message || 'research-event-ledger-unavailable' };
    }
  };
}

module.exports = { createHedgaiLedgerLoader };
