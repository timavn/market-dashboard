# Hedgeye Data Warehouse - Implementation Plan

## 🎯 Executive Summary

**Goal:** Build a comprehensive AWS data warehouse that stores ALL Hedgeye data in an organized, date-based structure.

**Current State:**
- ✅ Risk range scraper working (stores to old `RiskRangeData` table)
- ✅ LaunchAgent automation configured
- ✅ Claude Desktop integration for CAPTCHA handling

**Target State:**
- 📊 5 organized DynamoDB tables (date-first partitioning)
- 🤖 4 automated scrapers (risk ranges, signals, macro, calls)
- 🔍 Rich historical API (query by date, ticker, or keyword)
- 📱 Dashboard integration for all data types
- 💰 Cost: ~$2/year

---

## Phase 1: Database Infrastructure (30 minutes)

### Step 1.1: Create New Tables

```bash
cd /Users/timsmith/Desktop/cursor/market-dashboard/aws

# Create all 5 tables
./create_hedgeye_tables.sh us-west-1

# Verify creation
aws dynamodb list-tables --region us-west-1 | grep Hedgeye
```

**Expected Output:**
```
✓ HedgeyeRiskRanges: ACTIVE
✓ HedgeyeSignalStrength: ACTIVE
✓ HedgeyeMacroNotes: ACTIVE
✓ HedgeyeCallNotes: ACTIVE
✓ HedgeyeDailySnapshot: ACTIVE
```

### Step 1.2: Update Risk Range Scraper

**Change:**
```python
# OLD (in hedgeye_local_scraper.py)
RISK_RANGE_TABLE = 'RiskRangeData'
item = {
    'ticker': ticker,
    'date': date_str,
    ...
}

# NEW
RISK_RANGE_TABLE = 'HedgeyeRiskRanges'
item = {
    'date': date_str,       # Partition key FIRST
    'ticker': ticker,       # Sort key SECOND
    ...
}
```

**Files to modify:**
- `aws/lambda/hedgeye_local_scraper.py` (line 69, 588-610)
- `server.js` (line 583 - change table name to `HedgeyeRiskRanges`)

### Step 1.3: Test Migration

```bash
cd /Users/timsmith/Desktop/cursor/market-dashboard/aws/lambda

# Test scraper with new table
python3 hedgeye_local_scraper.py --scrape --chrome --no-dynamodb  # Dry run first
python3 hedgeye_local_scraper.py --scrape --chrome  # Real run

# Verify data in new table
aws dynamodb query \
  --table-name HedgeyeRiskRanges \
  --key-condition-expression "date = :date" \
  --expression-attribute-values '{":date":{"S":"2025-12-22"}}' \
  --region us-west-1
```

**Status:** ✅ Phase 1 Complete

---

## Phase 2: Signal Strength Scraper (2-3 hours)

### What to Scrape
- **URL:** `https://app.hedgeye.com/feed_items/all?page=1&with_category=signal-strength`
- **Data:** Ranked list of securities with bullish/bearish signals
- **Frequency:** Daily at 5:15 PM (same time as risk ranges)

### Scraper Design

Create: `aws/lambda/hedgeye_signal_strength_scraper.py`

```python
#!/usr/bin/env python3
"""
Hedgeye Signal Strength Scraper
Scrapes daily ranked list of bullish/bearish signals
"""

def scrape_signal_strength() -> List[Dict]:
    """
    Returns list of securities ranked by signal strength

    Example output:
    [
        {
            'rank': 1,
            'ticker': 'NVDA',
            'signalStrength': 95,
            'signalLevel': 'Very Strong',
            'trendSignal': 'BULLISH',
            'currentPrice': 475.25,
            'upside': 25.50,
            'downside': -15.75
        },
        ...
    ]
    """
    # Use same Playwright + Chrome approach as risk range scraper
    # Parse table/list from signal strength page
    pass

def store_to_dynamodb(signals: List[Dict], date: str):
    """Store to HedgeyeSignalStrength table"""
    table = dynamodb.Table('HedgeyeSignalStrength')

    for rank, signal in enumerate(signals, start=1):
        item = {
            'date': date,          # Partition key
            'rank': rank,          # Sort key
            'ticker': signal['ticker'],
            'signalStrength': Decimal(str(signal['signalStrength'])),
            'signalLevel': signal['signalLevel'],
            'trendSignal': signal.get('trendSignal', 'NEUTRAL'),
            'currentPrice': Decimal(str(signal['currentPrice'])),
            'updatedAt': datetime.now(timezone.utc).isoformat(),
            'ttl': int((datetime.now(timezone.utc) + timedelta(days=730)).timestamp())
        }
        table.put_item(Item=item)
```

### Claude Desktop Integration

**Prompt for Claude:**
```
Please help me scrape the Hedgeye signal strength page:
1. Navigate to: https://app.hedgeye.com/feed_items/all?page=1&with_category=signal-strength
2. Use saved cookies from hedgeye_cookies.json
3. Extract the ranked list of securities with:
   - Ticker symbol
   - Signal strength score
   - Trend direction (bullish/bearish)
   - Current price
4. Save to hedgeye_signal_strength.json

Expected structure:
[
  {"rank": 1, "ticker": "NVDA", "signalStrength": 95, "trendSignal": "BULLISH"},
  {"rank": 2, "ticker": "AMD", "signalStrength": 88, "trendSignal": "BULLISH"}
]
```

**Status:** 🔧 Phase 2 Pending

---

## Phase 3: Macro Show Scraper (3-4 hours)

### What to Scrape
- **URL:** `https://app.hedgeye.com/feed_items/all?page=1&with_category=macro-show`
- **Data:** Daily macro show video + transcript
- **AI Enhancement:** Use Claude API to summarize transcript

### Scraper Design

Create: `aws/lambda/hedgeye_macro_scraper.py`

```python
#!/usr/bin/env python3
"""
Hedgeye Macro Show Scraper
Scrapes daily macro show and generates AI summary
"""

import anthropic  # pip install anthropic

def scrape_macro_show(date: str) -> Dict:
    """
    Scrape macro show for given date
    Returns: {title, videoUrl, transcript, rawHtml}
    """
    # Use Playwright to:
    # 1. Navigate to macro show page
    # 2. Extract video URL
    # 3. Extract transcript (if available)
    # 4. Download/save video to S3 (optional)
    pass

def summarize_with_claude(transcript: str) -> Dict:
    """Use Claude to generate intelligent summary"""
    client = anthropic.Anthropic(api_key=os.environ['ANTHROPIC_API_KEY'])

    prompt = f"""Analyze this Hedgeye macro show transcript and provide:

1. **Summary** (2-3 sentences): Key takeaways
2. **Market Outlook**: Bullish/Bearish/Neutral for:
   - Equities
   - Bonds
   - Commodities
   - Dollar
3. **Key Points** (bullet list): 5-7 main topics discussed
4. **Mentioned Tickers**: All securities mentioned
5. **Action Items**: Any specific trading recommendations

Transcript:
{transcript}
"""

    response = client.messages.create(
        model="claude-3-5-sonnet-20241022",
        max_tokens=2000,
        messages=[{"role": "user", "content": prompt}]
    )

    # Parse Claude's response into structured data
    return parse_claude_summary(response.content)

def store_to_dynamodb(date: str, summary: Dict):
    """Store to HedgeyeMacroNotes table"""
    table = dynamodb.Table('HedgeyeMacroNotes')

    item = {
        'date': date,
        'noteType': 'summary',
        'title': summary['title'],
        'host': summary.get('host', 'Keith McCullough'),
        'summary': summary['summary'],
        'keyPoints': summary['keyPoints'],
        'marketOutlook': summary['marketOutlook'],
        'mentionedTickers': summary['mentionedTickers'],
        'videoUrl': summary.get('videoUrl'),
        'scrapedAt': datetime.now(timezone.utc).isoformat(),
        'ttl': int((datetime.now(timezone.utc) + timedelta(days=730)).timestamp())
    }
    table.put_item(Item=item)
```

### Claude Desktop Integration

**Prompt:**
```
Please scrape today's Hedgeye macro show:
1. Navigate to: https://app.hedgeye.com/feed_items/all?page=1&with_category=macro-show
2. Find today's video
3. Extract:
   - Title
   - Video URL
   - Transcript (if available)
   - Host name
4. If transcript exists, use Claude API to summarize it with key market insights
5. Save to hedgeye_macro_notes.json
```

**Status:** 🔧 Phase 3 Pending

---

## Phase 4: Research Calls Scraper (3-4 hours)

### What to Scrape
- **URL:** `https://app.hedgeye.com/feed_items/all?page=1&with_category=research-calls`
- **Data:** Individual sector/earnings calls throughout the day
- **AI Enhancement:** Summarize each call with ticker mentions and recommendations

### Similar approach to Macro scraper but handles multiple calls per day

**Status:** 🔧 Phase 4 Pending

---

## Phase 5: Unified Orchestrator (2 hours)

### Master Scraper Script

Create: `aws/lambda/run_all_hedgeye_scrapers.sh`

```bash
#!/bin/bash
# Master orchestrator - runs all scrapers in sequence

DATE=$(date +%Y-%m-%d)
LOG_DIR="logs"

echo "Starting Hedgeye data collection for ${DATE}..."

# 1. Risk Ranges (fastest, always works)
echo "▶ Scraping risk ranges..."
python3 hedgeye_local_scraper.py --scrape --chrome
echo "✓ Risk ranges complete"

# 2. Signal Strength
echo "▶ Scraping signal strength..."
python3 hedgeye_signal_strength_scraper.py --scrape
echo "✓ Signal strength complete"

# 3. Macro Show (may not exist on weekends)
echo "▶ Scraping macro show..."
python3 hedgeye_macro_scraper.py --scrape --date ${DATE}
echo "✓ Macro show complete"

# 4. Research Calls (multiple per day)
echo "▶ Scraping research calls..."
python3 hedgeye_call_scraper.py --scrape --date ${DATE}
echo "✓ Research calls complete"

# 5. Generate daily snapshot
echo "▶ Generating daily snapshot..."
python3 generate_daily_snapshot.py --date ${DATE}
echo "✓ Daily snapshot complete"

echo ""
echo "✅ All Hedgeye data collection complete for ${DATE}"
notify "Hedgeye Scraper" "Collected all data for ${DATE}"
```

### Update LaunchAgent

```xml
<!-- Update com.hedgeye.riskrange.scraper.production.plist -->
<key>ProgramArguments</key>
<array>
    <string>/bin/bash</string>
    <string>/Users/timsmith/Desktop/cursor/market-dashboard/aws/lambda/run_all_hedgeye_scrapers.sh</string>
</array>
```

**Status:** 🔧 Phase 5 Pending

---

## Phase 6: API Endpoints (2-3 hours)

### Add to server.js

```javascript
// GET /api/hedgeye/snapshot?date=2025-12-22
app.get('/api/hedgeye/snapshot', async (req, res) => {
  const { date } = req.query;
  const today = date || new Date().toISOString().split('T')[0];

  const [riskRanges, signals, macroNotes, calls, snapshot] = await Promise.all([
    queryDynamoDB('HedgeyeRiskRanges', { date: today }),
    queryDynamoDB('HedgeyeSignalStrength', { date: today, limit: 20 }),
    queryDynamoDB('HedgeyeMacroNotes', { date: today, noteType: 'summary' }),
    queryDynamoDB('HedgeyeCallNotes', { date: today }),
    queryDynamoDB('HedgeyeDailySnapshot', { date: today, snapshotType: 'full' })
  ]);

  res.json({
    date: today,
    riskRanges,
    signals,
    macroNotes,
    calls,
    snapshot
  });
});

// GET /api/hedgeye/ticker/:ticker?startDate&endDate
app.get('/api/hedgeye/ticker/:ticker', async (req, res) => {
  const { ticker } = req.params;
  const { startDate, endDate } = req.query;

  // Query using TickerIndex GSI
  const data = await dynamodb.query({
    TableName: 'HedgeyeRiskRanges',
    IndexName: 'TickerIndex',
    KeyConditionExpression: 'ticker = :ticker AND #date BETWEEN :start AND :end',
    ExpressionAttributeNames: { '#date': 'date' },
    ExpressionAttributeValues: {
      ':ticker': ticker,
      ':start': startDate,
      ':end': endDate
    }
  }).promise();

  res.json(data.Items);
});
```

**Status:** 🔧 Phase 6 Pending

---

## Phase 7: Dashboard Integration (3-4 hours)

### New React Components

1. **`DailyNotesPanel.jsx`** - Shows macro show + research calls for selected date
2. **`RiskRangeChart.jsx`** - Historical LRR/HRR chart for a ticker
3. **`SignalStrengthRankings.jsx`** - Top bullish/bearish signals
4. **`TickerHistoryModal.jsx`** - All Hedgeye data for a specific ticker

**Status:** 🔧 Phase 7 Pending

---

## Timeline

| Phase | Task | Duration | Priority |
|-------|------|----------|----------|
| 1 | Database Infrastructure | 30 min | 🔴 HIGH |
| 2 | Signal Strength Scraper | 2-3 hrs | 🟡 MEDIUM |
| 3 | Macro Show Scraper | 3-4 hrs | 🟡 MEDIUM |
| 4 | Research Calls Scraper | 3-4 hrs | 🟢 LOW |
| 5 | Unified Orchestrator | 2 hrs | 🟡 MEDIUM |
| 6 | API Endpoints | 2-3 hrs | 🟡 MEDIUM |
| 7 | Dashboard Integration | 3-4 hrs | 🟢 LOW |

**Total:** ~20-25 hours of development

---

## Quick Start (Do This Now)

```bash
# 1. Create tables (5 minutes)
cd /Users/timsmith/Desktop/cursor/market-dashboard/aws
./create_hedgeye_tables.sh

# 2. Update risk range scraper table name (2 minutes)
# Edit hedgeye_local_scraper.py line 69:
# RISK_RANGE_TABLE = 'HedgeyeRiskRanges'

# 3. Test new schema (5 minutes)
cd lambda
python3 hedgeye_local_scraper.py --scrape --chrome

# 4. Update server.js endpoint (2 minutes)
# Change line 583: TableName: 'HedgeyeRiskRanges'

# 5. Restart backend
cd ../..
npm run dev
```

**That's it!** You'll have the foundational infrastructure running in ~15 minutes.

---

## Next Steps

Once Phase 1 is done, I can help you with:

1. **Signal Strength Scraper** - Similar to risk ranges, just different table format
2. **Macro Show Scraper** - Uses Claude API to summarize transcripts
3. **Unified Dashboard** - One view to see all Hedgeye data for any day

**Want to start?** Let's do Phase 1 now!
