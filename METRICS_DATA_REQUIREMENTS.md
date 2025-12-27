# Metrics Data Requirements Breakdown

## Current Issues

### 1. Missing 3M, 6M, 1Yr Metrics
**Symptom**: These metrics show "--" (null) in the performance table.

**Root Cause Analysis**:
- The `findDataPointDaysAgo()` function requires `sortedData.length >= days + 1`
- For 3M (90 days): Need at least **91 data points**
- For 6M (180 days): Need at least **181 data points**
- For 1Yr (365 days): Need at least **366 data points**

**Current Behavior**:
```javascript
const findDataPointDaysAgo = (days) => {
  if (sortedData.length < days + 1) {
    return null; // Not enough data
  }
  const targetIndex = Math.max(0, sortedData.length - 1 - days);
  return sortedData[targetIndex];
};
```

**Likely Issues**:
1. **Insufficient Historical Data**: DynamoDB `MarketPriceHistory` table may not have enough data points
2. **Data Collection Gap**: Data collection may not have been running long enough
3. **Weekend/Holiday Gaps**: Missing trading days could reduce effective data points
4. **Data Fetching Issue**: API might not be returning all available data

### 2. Z-Score Not Calculated
**Symptom**: Z-Score always shows `0.00`

**Current State**: Z-score is hardcoded in state but never calculated:
```javascript
zScore: 0.00 // Z-score
```

**What Z-Score Should Be**:
Z-score measures how many standard deviations the current price is from the mean price over a given period.

**Formula**: `Z = (Current Price - Mean Price) / Standard Deviation`

**Typical Periods**:
- 20-day Z-score (short-term)
- 60-day Z-score (medium-term)
- 252-day Z-score (1 year, trading days)

## Data Requirements by Metric

### Time Period Metrics

| Metric | Days Required | Data Points Needed | Calculation |
|--------|--------------|-------------------|-------------|
| **1D % Chg** | 1 | 2+ | Current vs. Previous day |
| **5D % Chg** | 5 | 6+ | Current vs. 5 days ago |
| **1M % Chg** | 30 | 31+ | Current vs. 30 days ago |
| **3M % Chg** | 90 | 91+ | Current vs. 90 days ago |
| **6M % Chg** | 180 | 181+ | Current vs. 180 days ago |
| **1Yr % Chg** | 365 | 366+ | Current vs. 365 days ago |
| **QTD % Chg** | Variable | Variable | Current vs. Quarter start |
| **YTD % Chg** | Variable | Variable | Current vs. Year start |
| **vs. 52-Wk High** | 365 | All points | Current vs. Max(365 days) |
| **vs. 52-Wk Low** | 365 | All points | Current vs. Min(365 days) |

### Statistical Metrics

| Metric | Days Required | Data Points Needed | Calculation |
|--------|--------------|-------------------|-------------|
| **Z-Score (20-day)** | 20 | 21+ | (Current - Mean20) / StdDev20 |
| **Z-Score (60-day)** | 60 | 61+ | (Current - Mean60) / StdDev60 |
| **Z-Score (252-day)** | 252 | 253+ | (Current - Mean252) / StdDev252 |

## Implementation Plan

### Phase 1: Diagnose Data Availability

1. **Check Historical Data Count**
   - Query DynamoDB to see how many data points exist for each security
   - Log the actual data count vs. required count
   - Identify securities with insufficient data

2. **Verify Data Collection**
   - Check if `market_data_collector.py` Lambda is running
   - Verify data is being written to DynamoDB
   - Check for gaps in date ranges

3. **Improve Error Handling**
   - Add logging to show why metrics are null
   - Display data availability status in UI
   - Show "Insufficient data" message instead of "--"

### Phase 2: Fix Data Collection

1. **Backfill Historical Data**
   - Run `backfill_market_data.py` for all securities
   - Ensure at least 365 days of data for each security
   - Handle weekends/holidays (only trading days needed)

2. **Verify Data Quality**
   - Check for missing dates
   - Verify price data is valid (not 0, not null)
   - Ensure dates are in correct format

### Phase 3: Implement Z-Score Calculation

1. **Add Z-Score Calculation Function**
   ```javascript
   const calculateZScore = (currentPrice, prices, period = 20) => {
     if (prices.length < period) return null;
     
     const recentPrices = prices.slice(-period);
     const mean = recentPrices.reduce((a, b) => a + b, 0) / recentPrices.length;
     const variance = recentPrices.reduce((sum, price) => {
       return sum + Math.pow(price - mean, 2);
     }, 0) / recentPrices.length;
     const stdDev = Math.sqrt(variance);
     
     if (stdDev === 0) return 0;
     return (currentPrice - mean) / stdDev;
   };
   ```

2. **Add to Metrics Calculation**
   - Calculate 20-day, 60-day, and 252-day Z-scores
   - Store in metrics state
   - Display in UI (probably use 20-day or 60-day as default)

### Phase 4: Improve User Experience

1. **Data Availability Indicator**
   - Show how many days of data are available
   - Indicate which metrics can be calculated
   - Suggest when backfill is needed

2. **Graceful Degradation**
   - Show available metrics even if some are missing
   - Use shorter periods if longer ones aren't available
   - Display "N/A" with tooltip explaining why

## Immediate Actions

### 1. Add Diagnostic Logging
Add to `calculateMetrics()`:
```javascript
console.log(`[SecuritiesPanel] Data availability:`, {
  totalDataPoints: sortedData.length,
  requiredFor3M: 91,
  requiredFor6M: 181,
  requiredFor1Yr: 366,
  has3M: sortedData.length >= 91,
  has6M: sortedData.length >= 181,
  has1Yr: sortedData.length >= 366,
  dateRange: {
    first: sortedData[0]?.dateValue,
    last: sortedData[sortedData.length - 1]?.dateValue
  }
});
```

### 2. Check Database
Query DynamoDB to see actual data counts:
```javascript
// In server.js or separate diagnostic script
const params = {
  TableName: 'MarketPriceHistory',
  KeyConditionExpression: 'symbol = :symbol',
  ExpressionAttributeValues: {
    ':symbol': 'SPY'
  }
};
const result = await dynamodb.query(params).promise();
console.log(`SPY has ${result.Items.length} data points`);
```

### 3. Implement Z-Score
Add Z-score calculation to `calculateMetrics()` function.

## Expected Outcomes

After implementation:
- **3M, 6M, 1Yr metrics** will populate when sufficient data exists
- **Z-Score** will show meaningful values (typically -3 to +3 range)
- **Data availability** will be transparent to users
- **Error messages** will explain why metrics are missing

## Testing Checklist

- [ ] Verify 365+ days of data exist in DynamoDB for test security (e.g., SPY)
- [ ] Confirm 3M, 6M, 1Yr metrics calculate correctly
- [ ] Verify Z-score calculation produces reasonable values
- [ ] Test with securities that have limited data (should show N/A gracefully)
- [ ] Check console logs for diagnostic information
- [ ] Verify UI displays metrics correctly












