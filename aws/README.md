# AWS Infrastructure Directory

## 🚀 **Current Deployment Status** (As of January 10, 2026)

### ✅ **ACTIVELY DEPLOYED - Production Services**

#### **S3 Bucket: `market-dashboard-csv-data`**
- ✅ **ACTIVE** - Primary data storage for CSVs, PDFs, screenshots
- Frontend uploads Schwab CSVs via presigned URLs
- Hedgeye PDFs stored for historical reference
- Lambda trigger configured for `uploads/*.csv`

#### **DynamoDB Tables (15 Active Tables)**
All tables use **PAY_PER_REQUEST** billing mode:

**Portfolio Data:**
- ✅ `PortfolioSnapshots` - Daily portfolio summaries
- ✅ `Holdings` - Individual holdings per snapshot
- ✅ `PerformanceHistory` - Daily performance metrics
- ✅ `PositionPerformance` - Per-position tracking
- ✅ `ProcessingLogs` - CSV processing audit trail

**Hedgeye Data:**
- ✅ `HedgeyeDailySnapshot` - Daily Hedgeye report snapshots (NEW - Jan 2026)
- ✅ `HedgeyeRiskRanges` - Risk range signals
- ✅ `RiskRangeData` - Latest risk range data

**Market Data:**
- ✅ `MarketPriceHistory` - Historical prices with GSI
- ✅ `MarketData` - Daily market snapshots
- ✅ `USDCorrelations` - USD correlation analytics

**User Data:**
- ✅ `DailyNotes` - User daily notes
- ✅ `CalendarNotes` - Calendar event notes

**Performance Tracking:**
- ✅ `PerformanceMetrics` - Pre-calculated performance metrics

#### **Lambda Functions**
- ✅ `csv_processor.py` - **DEPLOYED & ACTIVE**
  - Runtime: Python 3.9
  - Memory: 512 MB, Timeout: 30 seconds
  - Handler: `csv_processor.lambda_handler`
  - Trigger: S3 PUT events on `uploads/*.csv`
  - Purpose: Parse Schwab CSVs → DynamoDB

#### **Express Backend (localhost:3001)**
- ✅ **ACTIVE** - Primary AWS integration layer
- Endpoints: `/api/portfolio`, `/api/quotes`, `/api/risk-ranges`, `/api/hedgeye/*`, `/api/notes`, `/api/presigned-url`
- AWS SDK: `AWS.S3()`, `AWS.DynamoDB.DocumentClient()`
- Credentials: Environment variables or `~/.aws/credentials`

#### **IAM Role & Policies**
- ✅ Role: `lambda-execution-role`
- ✅ Policy: `CSVProcessorPolicy`
  - S3: GetObject, ListBucket
  - DynamoDB: PutItem, BatchWriteItem, GetItem, Query, Scan, DeleteItem
  - CloudWatch: CreateLogGroup, CreateLogStream, PutLogEvents

#### **AWS Textract**
- ✅ **ACTIVELY USED** (as of Jan 10, 2026)
- Purpose: PDF table extraction for Hedgeye reports
- Usage: 5 pages/PDF × 5 PDFs/day = 150 pages/month
- Cost: ~$0.015/page × 150 pages = **$2.25/month**
- Integration: Called via boto3 from local Python scripts

---

### ⚠️ **CONFIGURED BUT NOT DEPLOYED**

#### **EventBridge Schedules**
- 📝 **DOCUMENTED** (deployment status unclear)
- `cron(30 21 * * ? *)` - Market data collection (4:30 PM ET)
- `cron(0 22 * * ? *)` - Hedgeye scraping (5:00 PM ET)
- See: `eventbridge/DAILY_MARKET_DATA_SCHEDULE.md`, `eventbridge/HEDGEYE_RISK_RANGE_SCHEDULE.md`

#### **API Gateway**
- ❌ **NOT DEPLOYED**
- Reason: Express backend (port 3001) fulfills all API needs
- No current benefit to adding API Gateway complexity

#### **Hedgeye Automation Lambda**
- ⚠️ **LOCAL SCRIPTS ONLY** (not deployed as Lambda)
- Current Process: Manual execution of `process_hedgeye_batch.py` locally
- Data Flow: Local script → AWS Textract API → S3 → DynamoDB

---

### ❌ **NOT DEPLOYED / NOT USED**

- ❌ CloudWatch Alarms - No automated monitoring configured
- ❌ AWS Secrets Manager - API keys in .env files (should migrate)
- ❌ Step Functions - No orchestration needs currently
- ❌ SNS/SQS - No messaging needs
- ❌ Cognito - No user authentication (local development only)

---

## 📊 **Architecture Overview**

### **Hybrid Cloud + Local Data Flow**

```
┌─────────────────────────────────────────────────────────┐
│  React Frontend (localhost:3000)                         │
│  - CSVUpload component                                   │
│  - Dashboard displays                                    │
└─────────────────┬───────────────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────────────────┐
│  Express Backend (localhost:3001)                        │
│  - AWS.S3() for presigned URLs                           │
│  - AWS.DynamoDB.DocumentClient() for queries             │
└───────┬──────────────────────────┬──────────────────────┘
        │                          │
        ▼                          ▼
┌───────────────┐         ┌────────────────────┐
│  S3 BUCKET    │         │  DynamoDB Tables   │
│  uploads/     │ ──────▶ │  15 Active Tables  │
│  hedgeye/     │ Lambda  │  PAY_PER_REQUEST   │
│  screenshots/ │         └────────────────────┘
└───────────────┘

┌─────────────────────────────────────────────────────────┐
│  LOCAL HEDGEYE PROCESSING (Manual)                       │
│  process_hedgeye_batch.py (local script)                 │
│  ├─> AWS Textract API (table extraction)                │
│  ├─> S3 (PDF upload)                                     │
│  └─> DynamoDB (HedgeyeDailySnapshot)                     │
└─────────────────────────────────────────────────────────┘
```

---

## 🎯 **Recommended Next Steps**

### **Phase 1: Cleanup** (Immediate)
1. ✅ Archive unused Hedgeye scraper implementations ✓ COMPLETED
2. ✅ Consolidate DynamoDB documentation ✓ COMPLETED
3. ✅ Update README.md with actual deployment status ✓ COMPLETED

### **Phase 2: Automation** (High Priority)
1. 🚀 Deploy Hedgeye PDF processor to Lambda
   - Package with dependencies (pdfplumber, pdf2image, poppler)
   - S3 trigger on `hedgeye/*.pdf` uploads
   - Or: EventBridge schedule + local folder sync
2. 🚀 Create EventBridge schedules
   - Market data collection (4:30 PM ET)
   - Hedgeye PDF processing (6:30 AM EST)
3. 🚀 Add basic CloudWatch alarms
   - Lambda errors > 0
   - DynamoDB throttling
   - S3 upload failures

### **Phase 3: Security & Optimization** (Medium Priority)
1. 🔒 Move API keys to Secrets Manager
2. 💰 Implement S3 lifecycle policies
   - After 90 days: Transition to S3 Infrequent Access
   - After 1 year: Transition to Glacier
3. 📊 Set up CloudWatch dashboard for monitoring

### **Phase 4: Consider Later** (Low Priority)
1. 📝 Infrastructure-as-Code (Terraform or AWS SAM)
2. 🔐 Cognito authentication (if multi-user access needed)
3. 🌐 API Gateway (if exposing APIs publicly)

---

## 💰 **Cost Analysis**

### **Current Monthly Costs** (Actual)
| Service | Usage | Cost |
|---|---|---|
| DynamoDB | 15 tables × PAY_PER_REQUEST, minimal reads/writes | ~$0.30/month |
| S3 | 5-10GB storage + <100 requests/month | ~$0.20/month |
| Lambda | csv_processor (30 invocations × 100ms) | FREE (Free Tier) |
| AWS Textract | 5 pages/PDF × 5 PDFs/day × 30 days = 150 pages | **$2.25/month** |
| CloudWatch Logs | <100MB logs/month | FREE (Free Tier) |
| Data Transfer | <1GB/month | FREE (within region) |
| **TOTAL** | | **~$2.75/month** |

### **After Phase 2 Automation**
| Service | Cost |
|---|---|
| Current infrastructure | $2.75/month |
| Lambda (Hedgeye automation + market data) | FREE (free tier) |
| CloudWatch Alarms (3 alarms) | $0.30/month |
| S3 (additional PDF storage) | +$0.25/month |
| **TOTAL AFTER PHASE 2** | **~$3.30/month** |

---

## 📁 **Directory Structure**

See [DYNAMODB_SCHEMA.md](dynamodb/DYNAMODB_SCHEMA.md) for complete table schemas.

```
aws/
├── README.md (this file)
├── dynamodb/
│   ├── DYNAMODB_SCHEMA.md          # ✅ Consolidated schema reference
│   └── archive/                    # Old individual docs (archived)
├── eventbridge/
│   ├── DAILY_MARKET_DATA_SCHEDULE.md
│   └── HEDGEYE_RISK_RANGE_SCHEDULE.md
├── iam/
│   ├── IAM_SETUP_GUIDE.md
│   └── QUICK_START.md
└── lambda/
    ├── csv_processor.py            # ✅ DEPLOYED
    ├── process_hedgeye_batch.py    # ⚠️  LOCAL ONLY
    ├── parse_bitcoin_tracker.py    # ⚠️  LOCAL ONLY
    ├── parse_early_look.py         # ⚠️  LOCAL ONLY
    ├── parse_portfolio_solutions.py # ⚠️ LOCAL ONLY
    ├── parse_momo_tracker.py       # ⚠️  LOCAL ONLY
    ├── parse_signal_strength.py    # ⚠️  LOCAL ONLY
    ├── date_utils.py
    ├── verify_pdf_dates.py
    └── archive/
        └── scrapers/               # Archived unused scrapers
```

---

## 🔧 **Quick Links**

- **DynamoDB Schema**: [dynamodb/DYNAMODB_SCHEMA.md](dynamodb/DYNAMODB_SCHEMA.md)
- **IAM Setup**: [iam/IAM_SETUP_GUIDE.md](iam/IAM_SETUP_GUIDE.md)
- **Hedgeye Textract**: [lambda/TEXTRACT_SOLUTION.md](lambda/TEXTRACT_SOLUTION.md)
- **Date Extraction**: [lambda/DATE_EXTRACTION_SUMMARY.md](lambda/DATE_EXTRACTION_SUMMARY.md)

---

**Last Updated**: January 10, 2026
