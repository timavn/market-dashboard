# Hedgeye Data Processing - Technical Documentation

## Executive Summary

**Current State:**
- ✅ 2/6 reports fully automated (Risk Ranges, Early Look)
- ⚠️  4/6 reports require manual data entry (Bitcoin Tracker, Momo Tracker, Portfolio Solutions, Signal Strength)
- ✅ All PDFs upload to S3 automatically for audit trail
- ✅ DynamoDB stores all data with links to source PDFs

## Why Only 2 Reports Are Automated

### Root Cause: PDFs Contain Images, Not Text

When you "Save as PDF" from the Hedgeye website, the browser converts the HTML tables to **embedded images** in the PDF. This is confirmed by:

```bash
# Page 3 of Bitcoin Tracker PDF contains:
Images: 2       # The crypto and stock tables are images
Rects: 0        # No table structures
Curves: 0       # No vector graphics
Text lines: 2   # Only header/footer text
```

**This means:**
- `pdfplumber.extract_text()` - Only gets header/footer, NOT table data
- `pdfplumber.extract_tables()` - Returns empty, tables don't exist as structures
- **Data is visually there but not machine-readable without OCR**

### Why Risk Ranges & Early Look Work

These 2 parsers succeed because they use **pattern matching on text that survives PDF conversion:**

**Risk Ranges:**
```python
# Pattern: TICKER (TREND)
# Example: UST10Y (BEARISH)
# This text pattern is preserved even in HTML-to-PDF conversion
match = re.match(r'^([A-Z0-9/]+)\s+\((BULLISH|BEARISH|NEUTRAL)\)', line)
```

**Early Look:**
```python
# Pattern: Name range% (trend)
# Example: UST 10yr Yield 4.10-4.22% (bearish)
# Simple format that survives text extraction
match = re.match(r'^(.+?)\s+([\d,\.]+)-([\d,\.]+)%?\s*\((bullish|bearish|neutral)\)', line)
```

### Why Bitcoin/Momo/Portfolio/Signal Fail

These parsers expect **tabular data on a single line:**

```python
# Bitcoin Tracker expects:
BTC 90,303 88,104 104,978 NEUTRAL

# But the PDF only contains:
# (images with the table data)
# No extractable text
```

## Solutions Evaluated

### ❌ Option 1: Fix PDF Parsing with Table Extraction
**Result:** Tables don't exist in PDFs, they're embedded as images.

### ❌ Option 2: OCR (Optical Character Recognition)
**Challenges:**
- Complex setup (tesseract, pytesseract dependencies)
- Error-prone (misreads numbers, symbols)
- Requires image preprocessing
- Would need manual verification anyway

### ❌ Option 3: Web Scraping
**Blocker:** CAPTCHA protection prevents automated scraping

### ✅ Option 4: Manual Data Entry (Current Solution)
**Pros:**
- Reliable (you verify the data yourself)
- Fast (2-3 minutes per day)
- Auditable (PDFs stored in S3)
- Simple (no complex dependencies)

**Cons:**
- Requires manual work each morning

## Daily Workflow

### Step 1: Download PDFs (5 minutes)
1. Log into Hedgeye website
2. Navigate to each of the 6 reports
3. Click "Print" or "Save as PDF"
4. Save all 6 PDFs to `~/Desktop/hedgeye/`

### Step 2: Upload PDFs to S3 (automated)
```bash
cd ~/Desktop/cursor/market-dashboard/aws/lambda
python3 process_hedgeye_batch.py
```

**This will:**
- ✅ Detect all 6 PDF types automatically
- ✅ Upload to S3 in organized folders
- ✅ Auto-parse Risk Ranges (35 securities)
- ✅ Auto-parse Early Look (13 risk ranges)
- ⚠️  Skip Bitcoin/Momo/Portfolio/Signal (no extractable data)

### Step 3: Manual Data Entry (2-3 minutes)
```bash
# Edit manual_data_entry.py with today's numbers
nano manual_data_entry.py

# Update these sections:
# - BITCOIN_TRACKER_DATA (6 cryptos, 8 stocks)
# - MOMO_TRACKER_DATA (9 stocks)
# - PORTFOLIO_SOLUTIONS_DATA (movers + rankings)
# - SIGNAL_STRENGTH_DATA (added/removed/full list)

# Save and run:
python3 manual_data_entry.py
```

### Step 4: Verify Data
```bash
# Check DynamoDB
python3 -c "
import boto3
from datetime import datetime

db = boto3.resource('dynamodb', region_name='us-west-1')
table = db.Table('HedgeyeDailySnapshot')
date = datetime.now().strftime('%Y-%m-%d')

response = table.query(
    KeyConditionExpression='#d = :date',
    ExpressionAttributeNames={'#d': 'date'},
    ExpressionAttributeValues={':date': date}
)

for item in response['Items']:
    print(f'{item[\"snapshotType\"]}: ✅')
"
```

**Expected output:**
```
bitcoin-trend-tracker: ✅
early-look: ✅
momo-tracker: ✅
portfolio-solutions: ✅
risk-ranges: ✅
signal-strength: ✅ (if implemented)
```

## File Organization

### Automated Parsers (Working)
- `parse_hedgeye_pdf.py` - Risk Ranges (35 securities)
- `parse_early_look.py` - Early Look (13 risk ranges)

### Manual Entry Helper
- `manual_data_entry.py` - Enter data from other 4 reports

### Batch Processor
- `process_hedgeye_batch.py` - Main script (runs all parsers)

### S3 Storage Structure
```
s3://market-dashboard-csv-data/hedgeye/
├── risk-ranges/2026-01-09/risk-ranges-2026-01-09-HHMMSS.pdf
├── early-look/2026-01-09/early-look-2026-01-09-HHMMSS.pdf
├── bitcoin-trend-tracker/2026-01-09/bitcoin-trend-tracker-2026-01-09-HHMMSS.pdf
├── momo-tracker/2026-01-09/momo-tracker-2026-01-09-HHMMSS.pdf
├── portfolio-solutions/2026-01-09/portfolio-solutions-2026-01-09-HHMMSS.pdf
└── signal-strength/2026-01-09/signal-strength-2026-01-09-HHMMSS.pdf
```

## DynamoDB Schema

### HedgeyeDailySnapshot Table
```json
{
  "date": "2026-01-09",
  "snapshotType": "bitcoin-trend-tracker",
  "cryptoCount": 6,
  "stockCount": 8,
  "data": {
    "cryptos": {...},
    "stocks": {...}
  },
  "scrapedAt": "2026-01-09T22:00:00Z",
  "source": "manual",
  "pdfSource": "hedgeye/bitcoin-trend-tracker/2026-01-09/bitcoin-trend-tracker-2026-01-09-220632.pdf",
  "ttl": 1767110400
}
```

## Future Automation Options

### Option A: Hedgeye API
**Best solution:** If Hedgeye offers an API, use it.
- Contact Hedgeye support
- Request API access for institutional clients

### Option B: OCR Implementation
**Complexity:** High
**Accuracy:** 95-98% (requires manual verification)
**Dependencies:**
```bash
brew install tesseract
pip install pytesseract pillow pdf2image
```

### Option C: Browser Automation with Login
**Challenge:** CAPTCHA blocks automation
**Possible workaround:**
- Use Selenium with manual CAPTCHA solving
- Store authenticated session cookies
- Refresh cookies monthly

## Troubleshooting

### "No PDFs found from today"
- Check PDFs are in `~/Desktop/hedgeye/`
- Verify file modification date is today

### "Upload failed: No credentials"
- Check AWS credentials: `aws configure list`
- Verify region: `us-west-1`

### "Parser extracted 0 records"
- Expected for Bitcoin/Momo/Portfolio/Signal (images in PDF)
- Use manual_data_entry.py instead

### Duplicate PDFs in S3
```bash
# Clean up duplicates
python3 -c "
import boto3

s3 = boto3.client('s3', region_name='us-west-1')
folders = ['bitcoin-trend-tracker', 'early-look', 'momo-tracker',
           'portfolio-solutions', 'risk-ranges', 'signal-strength']

for folder in folders:
    response = s3.list_objects_v2(
        Bucket='market-dashboard-csv-data',
        Prefix=f'hedgeye/{folder}/2026-01-09/'
    )
    if 'Contents' in response:
        files = sorted(response['Contents'], key=lambda x: x['LastModified'], reverse=True)
        # Delete all except most recent
        for obj in files[1:]:
            s3.delete_object(Bucket='market-dashboard-csv-data', Key=obj['Key'])
"
```

## Questions?

Contact: [Your email/slack]
Documentation: This file
Code: `aws/lambda/process_hedgeye_batch.py`
