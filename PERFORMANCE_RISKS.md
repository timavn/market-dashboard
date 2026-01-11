# Performance Optimization Risks & Breaking Changes

## Critical Risks to Consider

### 1. ⚠️ Parallelizing Quote Processing - HIGH RISK

**Current Protection**: Sequential processing with 100ms delays between symbols and 200ms between batches to avoid Yahoo Finance rate limiting.

**Risk if Changed**:
- **Yahoo Finance Rate Limiting**: Yahoo Finance has no official rate limit but can:
  - Block IP addresses for excessive requests
  - Return 429 (Too Many Requests) errors
  - Temporarily ban the server IP
  - **Impact**: Complete failure of quote fetching, breaking the entire dashboard

- **Server Resource Exhaustion**: 
  - 111+ parallel requests could exhaust:
    - Node.js event loop (too many concurrent promises)
    - Memory (each request holds promise state)
    - Network connections (connection pool limits)
  - **Impact**: Server crashes or becomes unresponsive

- **Cache Mechanism Breakage**:
  - Current cache (8-second TTL) assumes sequential access pattern
  - Parallel requests might bypass cache or cause race conditions
  - **Impact**: Cache becomes ineffective, more API calls than before

**Recommendation**: 
- **DO NOT** fully parallelize all 111 symbols at once
- **DO** parallelize in controlled batches (e.g., 10-15 concurrent requests max)
- **DO** implement exponential backoff on rate limit errors
- **DO** monitor for 429 errors and automatically reduce concurrency
- **DO** add circuit breaker pattern to stop requests if rate limited

**Safe Implementation**:
```javascript
// Safe: Controlled parallelization
const MAX_CONCURRENT = 10; // Limit concurrent requests
const symbols = [...]; // 111 symbols
const batches = chunk(symbols, MAX_CONCURRENT);

for (const batch of batches) {
  const results = await Promise.all(
    batch.map(symbol => getQuote(symbol))
  );
  // Small delay between batches
  await delay(200);
}
```

### 2. ⚠️ Request Deduplication - MEDIUM RISK

**Risk if Implemented Incorrectly**:
- **Stale Data**: If deduplication cache doesn't expire correctly, users see old data
- **Race Conditions**: Multiple components requesting same data simultaneously
  - First request starts, second request waits
  - If first fails, second might not retry
  - **Impact**: Some components never get data

- **Memory Leaks**: 
  - In-flight request cache could grow unbounded
  - If requests never complete (network issues), cache never clears
  - **Impact**: Server memory exhaustion over time

- **Cache Invalidation Issues**:
  - If cache key is wrong, different requests get wrong data
  - If cache doesn't clear on errors, errors persist
  - **Impact**: Wrong data shown to users

**Recommendation**:
- **DO** implement with TTL (time-to-live) for in-flight requests
- **DO** clear cache on errors (don't cache failures)
- **DO** add cache size limits (LRU eviction)
- **DO** log cache hits/misses for monitoring
- **DON'T** deduplicate requests with different parameters (e.g., different date ranges)

### 3. ⚠️ Response Caching - MEDIUM RISK

**Risk if Implemented Incorrectly**:
- **Stale Data**: 
  - Historical data cached too long shows outdated prices
  - Risk ranges cached when new data arrives
  - **Impact**: Users make decisions on stale data

- **Cache Invalidation Complexity**:
  - When to invalidate? (time-based, event-based, manual?)
  - What if invalidation fails?
  - **Impact**: Stale data persists

- **Memory Growth**:
  - Historical data can be large (365 days × multiple symbols)
  - Cache grows unbounded without limits
  - **Impact**: Server memory exhaustion

- **Cache Stampede**:
  - If cache expires for popular data, all requests hit API simultaneously
  - **Impact**: Overwhelms external APIs, causes rate limiting

**Recommendation**:
- **DO** use different TTLs for different data types:
  - Quotes: 8 seconds (already implemented)
  - Historical data: 1 hour (changes daily)
  - Risk ranges: 1 hour (changes daily)
  - Portfolio data: 5 minutes (changes on CSV upload)
- **DO** implement cache size limits (max items, max memory)
- **DO** use cache warming for frequently accessed data
- **DO** add manual cache invalidation endpoint for testing
- **DON'T** cache error responses

### 4. ⚠️ DynamoDB Index Creation - MEDIUM-HIGH RISK

**Risk if Implemented Incorrectly**:
- **Index Creation Downtime**:
  - GSI creation can take minutes to hours for large tables
  - During creation, queries might be slower
  - **Impact**: Temporary performance degradation

- **Index Creation Failure**:
  - If index creation fails partway, table might be in inconsistent state
  - Need to clean up failed index
  - **Impact**: Wasted costs, need manual intervention

- **Cost Increase**:
  - GSIs consume read/write capacity units
  - On-demand billing still charges for GSI operations
  - **Impact**: Higher AWS costs

- **Breaking Existing Queries**:
  - If code switches to GSI but index doesn't exist yet
  - If index name is wrong
  - **Impact**: Queries fail, application breaks

- **Data Consistency**:
  - GSIs are eventually consistent (not strongly consistent)
  - New data might not appear in GSI immediately
  - **Impact**: Race conditions, missing data

**Recommendation**:
- **DO** create indexes during low-traffic periods
- **DO** test index creation on staging first
- **DO** implement fallback to scan if GSI query fails
- **DO** monitor index status and creation progress
- **DO** use feature flags to toggle between scan and query
- **DON'T** delete old scan code until GSI is verified working

**Safe Migration Path**:
```javascript
// Safe: Fallback pattern
try {
  // Try GSI query first
  const result = await dynamodb.query({
    TableName: 'PortfolioSnapshots',
    IndexName: 'timestamp-index',
    ScanIndexForward: false,
    Limit: 1
  }).promise();
  return result.Items[0];
} catch (error) {
  if (error.code === 'ResourceNotFoundException') {
    // Index doesn't exist yet, fallback to scan
    console.warn('GSI not found, falling back to scan');
    return await fallbackToScan();
  }
  throw error;
}
```

### 5. ⚠️ Reducing Polling Frequency - LOW-MEDIUM RISK

**Current**: SecuritiesList polls every 8 seconds

**Risk if Changed**:
- **User Expectation**: Users might expect near-real-time updates
- **Stale Data Perception**: If data is 30+ seconds old, users might think app is broken
- **Component Dependencies**: Other components might depend on frequent updates
- **WebSocket Alternative**: If switching to WebSockets:
  - Connection drops cause data gaps
  - Reconnection logic needed
  - More complex error handling

**Recommendation**:
- **DO** increase gradually (8s → 15s → 30s) and monitor user feedback
- **DO** show "last updated" timestamp so users know data freshness
- **DO** implement WebSocket with fallback to polling
- **DON'T** reduce below 30 seconds without user notification
- **DON'T** remove polling entirely without WebSocket alternative

### 6. ⚠️ Lazy Loading Historical Data - LOW RISK

**Risk if Implemented Incorrectly**:
- **UX Issues**: 
  - Charts show loading state when user expects data
  - User clicks ticker, sees spinner, thinks it's broken
  - **Impact**: Poor user experience

- **Race Conditions**:
  - User quickly switches tickers, multiple requests in flight
  - Wrong data might display for selected ticker
  - **Impact**: Confusing data display

**Recommendation**:
- **DO** show loading indicators clearly
- **DO** cancel in-flight requests when ticker changes
- **DO** preload data for likely-to-be-selected tickers
- **DON'T** lazy load critical data (e.g., current prices)

### 7. ⚠️ React Memoization - LOW-MEDIUM RISK

**Risk if Implemented Incorrectly**:
- **Stale Closures**: 
  - `useMemo`/`useCallback` with wrong dependencies
  - Component uses old data/props
  - **Impact**: UI shows wrong data, bugs

- **Missing Updates**:
  - Over-aggressive memoization prevents necessary re-renders
  - State changes don't reflect in UI
  - **Impact**: UI doesn't update when it should

- **Memory Leaks**:
  - Memoized values hold references to large objects
  - Prevents garbage collection
  - **Impact**: Memory growth over time

**Recommendation**:
- **DO** carefully track all dependencies in `useMemo`/`useCallback`
- **DO** use React DevTools Profiler to verify memoization helps
- **DO** test that memoization doesn't break updates
- **DON'T** memoize everything blindly
- **DON'T** memoize small computations (overhead > benefit)

### 8. ⚠️ Fetching Only Required Data - LOW RISK

**Current**: Always fetches 365 days, filters client-side

**Risk if Changed**:
- **Missing Data for Calculations**:
  - Some metrics need full year (Y/Y calculations)
  - If we only fetch 30 days, Y/Y metrics break
  - **Impact**: Incorrect metrics displayed

- **Multiple API Calls**:
  - If user switches timeframes, need new API call each time
  - More network requests than current approach
  - **Impact**: More API load, slower UX

**Recommendation**:
- **DO** fetch max needed data once (365 days for Y/Y)
- **DO** filter client-side for display
- **DON'T** fetch less than needed for calculations
- **DON'T** refetch on every timeframe change

## Implementation Priority (Safest First)

### Phase 1: Safe Optimizations (Low Risk)
1. ✅ **Add timing logs** - Already done, no risk
2. **Add React memoization** - Low risk, easy to revert
3. **Optimize DynamoDB queries** (where indexes already exist) - Low risk
4. **Add response caching** (with proper TTLs) - Medium risk, manageable

### Phase 2: Medium Risk Optimizations
5. **Create DynamoDB indexes** - Medium risk, needs careful migration
6. **Implement request deduplication** - Medium risk, needs proper cache management
7. **Reduce polling frequency** - Low-medium risk, needs user communication

### Phase 3: High Risk Optimizations (Requires Careful Testing)
8. **Parallelize quote processing** - HIGH RISK, needs:
   - Controlled concurrency limits
   - Rate limit detection and backoff
   - Circuit breaker pattern
   - Extensive testing with Yahoo Finance
   - Fallback to sequential if rate limited

## Testing Requirements Before Implementation

### For Parallel Quote Processing:
- [ ] Test with 111 symbols in parallel (10-15 concurrent max)
- [ ] Monitor for 429 errors from Yahoo Finance
- [ ] Test rate limit recovery (exponential backoff)
- [ ] Test circuit breaker (stop requests if rate limited)
- [ ] Load test server with concurrent requests
- [ ] Verify cache still works correctly
- [ ] Test error handling (some symbols fail)

### For DynamoDB Indexes:
- [ ] Create indexes in staging environment first
- [ ] Test query performance vs scan
- [ ] Verify data consistency (eventual consistency)
- [ ] Test fallback to scan if index missing
- [ ] Monitor AWS costs before/after
- [ ] Test index creation failure scenarios

### For Caching:
- [ ] Test cache expiration (TTL)
- [ ] Test cache invalidation
- [ ] Test cache size limits (memory)
- [ ] Test cache stampede prevention
- [ ] Test error response handling (don't cache errors)

## Rollback Plan

For each optimization, maintain ability to rollback:

1. **Feature Flags**: Use environment variables to toggle optimizations
2. **Version Control**: Keep old code commented/available
3. **Monitoring**: Add metrics to compare old vs new performance
4. **Gradual Rollout**: Enable for small percentage of requests first

## Monitoring Requirements

After implementing optimizations, monitor:

1. **Error Rates**: 429 errors, timeouts, failures
2. **Response Times**: P50, P95, P99 percentiles
3. **Cache Hit Rates**: Should be >80% for cached endpoints
4. **Memory Usage**: Should not grow unbounded
5. **API Rate Limits**: Track Yahoo Finance/FRED rate limit hits
6. **DynamoDB Costs**: Compare before/after index creation
7. **User Complaints**: Data freshness, missing data, errors
