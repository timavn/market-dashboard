# Hedgeye Data Warehouse - AWS Architecture

## Overview

Professional data warehouse for storing all Hedgeye scraped data in an organized, queryable format.

## Design Philosophy

**Date-First Organization**: Each trading day is the primary partition
- Easy to query "What did Hedgeye say on Dec 22, 2025?"
- Natural alignment with market data (daily snapshots)
- Supports time-series analysis and historical lookups

**Multi-Source Storage**: Separate tables for different data types
- Prevents schema conflicts
- Allows independent scraping schedules
- Optimized queries for each data type

**Cost-Effective**: DynamoDB with intelligent TTLs
- Recent data: Kept forever
- Historical data: 2-year retention by default
- Archive to S3 for long-term storage (pennies per GB)

---

## Database Schema

### Table 1: `HedgeyeRiskRanges`
**Purpose:** Daily risk range signals (LRR/HRR) for all securities

**Partition Key:** `date` (YYYY-MM-DD)
**Sort Key:** `ticker` (e.g., "SPY", "UST10Y")

**Schema:**
```json
{
  "date": "2025-12-22",           // Partition key
  "ticker": "SPY",                // Sort key
  "lrr": 580.50,                  // Low Risk Range (buy signal)
  "hrr": 605.25,                  // High Risk Range (sell signal)
  "previousClose": 595.30,
  "signal": "BULLISH",            // Derived: price vs risk range
  "updatedAt": "2025-12-22T22:15:00Z",
  "source": "hedgeye",
  "ttl": 1735862400               // Auto-delete after 2 years
}
```

**Query Examples:**
- Get all tickers for Dec 22: `query(date="2025-12-22")`
- Get SPY history: `query(ticker="SPY", date between "2025-01-01" and "2025-12-31")` (needs GSI)

---

### Table 2: `HedgeyeSignalStrength`
**Purpose:** Daily ranked list of securities by signal strength

**Partition Key:** `date` (YYYY-MM-DD)
**Sort Key:** `rank` (1, 2, 3, ...)

**Schema:**
```json
{
  "date": "2025-12-22",           // Partition key
  "rank": 1,                      // Sort key (1 = strongest signal)
  "ticker": "NVDA",
  "signalStrength": 95,           // -100 to +100 score
  "signalLevel": "Very Strong",   // Text description
  "trendSignal": "BULLISH",
  "trendLevel": 450.00,
  "tailLevel": 425.00,
  "currentPrice": 475.25,
  "upside": 25.50,
  "downside": -15.75,
  "assetClass": "Technology",
  "updatedAt": "2025-12-22T22:15:00Z",
  "ttl": 1735862400
}
```

**Query Examples:**
- Get top 10 signals for Dec 22: `query(date="2025-12-22", limit=10)`
- Get historical rank for NVDA: (needs GSI on ticker)

---

### Table 3: `HedgeyeMacroNotes`
**Purpose:** Daily macro show summaries and key takeaways

**Partition Key:** `date` (YYYY-MM-DD)
**Sort Key:** `noteType` ("summary" | "transcript" | "keypoints")

**Schema:**
```json
{
  "date": "2025-12-22",           // Partition key
  "noteType": "summary",          // Sort key
  "title": "Macro Show - Dec 22, 2025",
  "host": "Keith McCullough",
  "duration": "45min",
  "summary": "Fed likely to hold rates...",  // Claude-generated summary
  "keyPoints": [
    "Fed holding steady through Q1 2026",
    "Dollar strength continues",
    "Energy sector showing weakness"
  ],
  "marketOutlook": {
    "equities": "NEUTRAL",
    "bonds": "BULLISH",
    "commodities": "BEARISH",
    "dollar": "BULLISH"
  },
  "mentionedTickers": ["SPY", "QQQ", "DXY", "UST10Y"],
  "videoUrl": "https://app.hedgeye.com/...",
  "scrapedAt": "2025-12-22T22:30:00Z",
  "ttl": 1735862400
}
```

---

### Table 4: `HedgeyeCallNotes`
**Purpose:** Individual research call summaries

**Partition Key:** `date` (YYYY-MM-DD)
**Sort Key:** `callId` (timestamp or unique ID)

**Schema:**
```json
{
  "date": "2025-12-22",           // Partition key
  "callId": "20251222-143000",    // Sort key (YYYYMMDD-HHMMSS)
  "title": "Tech Sector Deep Dive",
  "analyst": "Jay Van Sciver",
  "sector": "Technology",
  "tickers": ["NVDA", "AMD", "INTC"],
  "summary": "NVDA showing strong momentum...",
  "keyTakeaways": [
    "NVDA raised price target to $500",
    "AMD facing margin pressure",
    "Semi sector remains bullish"
  ],
  "recommendations": {
    "NVDA": "BUY",
    "AMD": "HOLD",
    "INTC": "SELL"
  },
  "callType": "earnings" | "sector" | "macro" | "special",
  "videoUrl": "https://app.hedgeye.com/...",
  "transcriptUrl": "s3://hedgeye-transcripts/2025-12-22/...",
  "scrapedAt": "2025-12-22T14:45:00Z",
  "ttl": 1735862400
}
```

---

### Table 5: `HedgeyeDailySnapshot`
**Purpose:** Daily rollup of all data (for quick dashboard queries)

**Partition Key:** `date` (YYYY-MM-DD)
**Sort Key:** `snapshotType` ("full")

**Schema:**
```json
{
  "date": "2025-12-22",           // Partition key
  "snapshotType": "full",         // Sort key
  "riskRangeCount": 45,           // How many securities have risk ranges
  "signalStrengthCount": 120,     // How many in signal strength list
  "macroNotesCount": 1,           // Macro shows today
  "callNotesCount": 3,            // Research calls today
  "topBullishSignals": [          // Quick access to top signals
    {"ticker": "NVDA", "strength": 95},
    {"ticker": "AMD", "strength": 88}
  ],
  "topBearishSignals": [
    {"ticker": "TSLA", "strength": -75},
    {"ticker": "XLE", "strength": -65}
  ],
  "marketSummary": {
    "equitiesOutlook": "BULLISH",
    "bondsOutlook": "NEUTRAL",
    "commoditiesOutlook": "BEARISH"
  },
  "dataCompleteness": {
    "riskRanges": true,
    "signalStrength": true,
    "macroNotes": true,
    "callNotes": true
  },
  "scrapedAt": "2025-12-22T23:00:00Z",
  "ttl": 1735862400
}
```

---

## Global Secondary Indexes (GSIs)

### GSI 1: `TickerIndex`
**Purpose:** Query all data for a specific ticker across dates

**Partition Key:** `ticker`
**Sort Key:** `date`

**Use Cases:**
- "Show me all SPY risk ranges for the past 6 months"
- "What has Hedgeye said about NVDA this quarter?"

### GSI 2: `SourceIndex`
**Purpose:** Query by data source (for auditing/debugging)

**Partition Key:** `source`
**Sort Key:** `scrapedAt`

**Use Cases:**
- "Show me all data scraped from Hedgeye vs Bloomberg"
- "Find failed scrapes in the last week"

---

## S3 Archive Layer

### Bucket: `hedgeye-data-archive`
**Purpose:** Long-term storage for large content (transcripts, videos, PDFs)

**Folder Structure:**
```
s3://hedgeye-data-archive/
├── transcripts/
│   ├── 2025/
│   │   ├── 12/
│   │   │   ├── 22/
│   │   │   │   ├── macro-show-20251222.txt
│   │   │   │   ├── tech-call-20251222-143000.txt
│   │   │   │   └── earnings-call-20251222-160000.txt
├── videos/
│   ├── 2025/12/22/
│   │   ├── macro-show.mp4
│   │   └── tech-call.mp4
├── pdfs/
│   ├── 2025/12/22/
│   │   ├── daily-report.pdf
│   │   └── sector-analysis.pdf
└── raw-html/
    ├── 2025/12/22/
        ├── risk-range-page.html
        └── signal-strength-page.html
```

**Lifecycle Rules:**
- Transition to Glacier after 90 days (99% cost reduction)
- Transition to Deep Archive after 1 year (99.9% cost reduction)

---

## Cost Analysis

### DynamoDB Costs (On-Demand Pricing)

**Assumptions:**
- 150 securities with risk ranges daily
- 120 securities in signal strength list
- 1 macro show + 3 calls per day
- 250 trading days per year

**Writes per day:**
- Risk ranges: 150 items × 1KB = 150 WCU
- Signal strength: 120 items × 1KB = 120 WCU
- Notes: 5 items × 5KB = 25 WCU
- **Total: ~300 WCU/day**

**Cost:**
- $1.25 per million write requests
- 300 × 250 days = 75,000 writes/year
- **$0.09/year for writes**

**Storage:**
- 250 days × 300 items × 1KB = 75 MB/year
- $0.25/GB/month = $0.02/month
- **$0.24/year for storage**

**Reads:** (Assume 1,000 queries/day)
- 1,000 × 365 = 365,000 reads/year
- $0.25 per million reads
- **$0.09/year for reads**

**Total DynamoDB Cost: ~$0.50/year** (essentially free!)

### S3 Costs

**Storage:**
- 100MB transcripts/day × 250 days = 25 GB/year
- $0.023/GB/month in Standard → $0.004/GB in Glacier
- **~$1.20/year in Glacier**

**Total AWS Cost: ~$2/year** 🎉

---

## Data Flow Architecture

```
┌─────────────────────────────────────────────────────┐
│ DAILY SCRAPING (5:15 PM ET)                         │
└────────────────┬────────────────────────────────────┘
                 │
    ┌────────────┼────────────┬────────────────┬──────────────┐
    │            │            │                │              │
    ▼            ▼            ▼                ▼              ▼
┌─────────┐ ┌─────────┐ ┌──────────┐ ┌──────────────┐ ┌─────────────┐
│Risk     │ │Signal   │ │Macro     │ │Research      │ │Daily        │
│Ranges   │ │Strength │ │Show      │ │Calls         │ │Snapshot     │
│Scraper  │ │Scraper  │ │Scraper   │ │Scraper       │ │Generator    │
└────┬────┘ └────┬────┘ └────┬─────┘ └──────┬───────┘ └──────┬──────┘
     │           │           │               │                │
     ▼           ▼           ▼               ▼                ▼
┌─────────────────────────────────────────────────────────────────┐
│                     DynamoDB Tables                              │
│  • HedgeyeRiskRanges     • HedgeyeSignalStrength               │
│  • HedgeyeMacroNotes     • HedgeyeCallNotes                    │
│  • HedgeyeDailySnapshot                                         │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│                  Express API Endpoints                           │
│  • GET /api/hedgeye/risk-ranges?date=2025-12-22                │
│  • GET /api/hedgeye/signals?date=2025-12-22&limit=10           │
│  • GET /api/hedgeye/macro-notes?date=2025-12-22                │
│  • GET /api/hedgeye/calls?date=2025-12-22                      │
│  • GET /api/hedgeye/snapshot?date=2025-12-22                   │
│  • GET /api/hedgeye/ticker/:ticker?startDate&endDate           │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│                   React Dashboard                                │
│  • Daily Notes Panel (macro + call summaries)                   │
│  • Risk Range Panel (with historical charts)                    │
│  • Signal Strength Rankings                                      │
│  • Historical Ticker View                                        │
└─────────────────────────────────────────────────────────────────┘
```

---

## Implementation Priority

### Phase 1: Core Infrastructure (Today)
- [x] Create DynamoDB tables
- [ ] Migrate existing risk range scraper to new schema
- [ ] Add date-based partitioning
- [ ] Create daily snapshot table

### Phase 2: Additional Scrapers (This Week)
- [ ] Signal strength scraper
- [ ] Macro show scraper (with Claude summarization)
- [ ] Research calls scraper
- [ ] Unified orchestrator script

### Phase 3: API Layer (Next Week)
- [ ] Express endpoints for all data types
- [ ] Historical query support
- [ ] Ticker-specific endpoints
- [ ] Date range queries

### Phase 4: Dashboard Integration (Next Week)
- [ ] Daily notes panel
- [ ] Historical risk range charts
- [ ] Signal strength rankings
- [ ] Search by ticker across all notes

---

## Query Examples

### Get all data for today
```javascript
// GET /api/hedgeye/snapshot?date=2025-12-22
{
  "date": "2025-12-22",
  "riskRanges": [...],      // 150 securities
  "signals": [...],         // Top 20 bullish + bearish
  "macroNotes": {...},      // Today's macro show
  "calls": [...]            // All research calls
}
```

### Get SPY historical risk ranges
```javascript
// GET /api/hedgeye/ticker/SPY?startDate=2025-01-01&endDate=2025-12-22
{
  "ticker": "SPY",
  "data": [
    {
      "date": "2025-12-22",
      "lrr": 580.50,
      "hrr": 605.25,
      "close": 595.30
    },
    // ... historical data
  ],
  "mentions": [             // All macro/call mentions
    {
      "date": "2025-12-20",
      "source": "macro-show",
      "note": "SPY showing strength..."
    }
  ]
}
```

### Search for "inflation" mentions
```javascript
// GET /api/hedgeye/search?q=inflation&startDate=2025-12-01
{
  "query": "inflation",
  "results": [
    {
      "date": "2025-12-22",
      "type": "macro-show",
      "snippet": "...inflation cooling faster than expected...",
      "context": "full summary"
    },
    {
      "date": "2025-12-20",
      "type": "research-call",
      "ticker": "TLT",
      "snippet": "...bond market pricing in lower inflation..."
    }
  ]
}
```

---

**Next Steps:** Ready to implement Phase 1?
