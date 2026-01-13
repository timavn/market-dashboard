# Date Extraction Implementation Summary

## Problem Solved

PDFs were being archived with the processing date (when you run the script) instead of the publication date (the actual date on the PDF). This made historical data tracking inaccurate.

## Solution

Implemented automatic date extraction from PDF filenames and content using multiple detection strategies.

## How It Works

### 1. Date Detection Strategies (in order of priority)

**Strategy 1: Filename Pattern - Month Name**
- Pattern: `JANUARY 9, 2026`
- Example: "Hedgeye - JANUARY 9, 2026.pdf" → `2026-01-09`

**Strategy 2: Filename Pattern - Numeric**
- Pattern: `(01_02_2026)` or `01_02_2026`
- Example: "Weekly ETF Re-Rank (01_02_2026).pdf" → `2026-01-02`

**Strategy 3: PDF Content - Numeric Date**
- Pattern: `1/9/26` or `01/09/2026`
- Extracts from first page text
- Example: First page contains "1/9/26" → `2026-01-09`

**Strategy 4: PDF Content - Month Name**
- Pattern: `January 9, 2026`
- Extracts from first page text

**Fallback:** Uses today's date if no pattern matches

### 2. AWS Textract Explanation

**What is Textract?**
- AWS service for extracting text and tables from PDFs/images
- It's an API (like Alpha Vantage or Polygon) - no infrastructure to manage
- You send it a PDF, it returns structured data

**How Textract Works:**

It doesn't just return "one long string" - it returns a **structured hierarchy**:

```
PAGE
 └─ TABLE (detects table boundaries)
     ├─ CELL (row=1, col=1) → "TICKER"
     ├─ CELL (row=1, col=2) → "Buy TRADE"
     ├─ CELL (row=2, col=1) → "MSFT"
     └─ CELL (row=2, col=2) → "$468"
```

**Key Features:**
1. Identifies table boundaries automatically
2. Detects rows and columns with indexes (RowIndex, ColumnIndex)
3. Extracts text from each cell with confidence scores
4. Preserves spatial relationships (bounding boxes)
5. Links relationships (TABLE → CELL → WORD)

**Why We Need It:**
- Hedgeye PDFs are HTML-to-PDF print outputs
- Tables are rendered as images, not selectable text
- Textract uses computer vision + AI to detect table structures
- Enables extraction of data from image-based tables

**Cost:**
- ~$0.015 per page analyzed
- Processing 6 PDFs (avg 10 pages each) = ~$0.90/day
- Monthly cost: ~$27
- Minimal compared to manual data entry time saved

**Where to Find It:**
1. AWS Console → Search "Textract" → View usage/metrics
2. CloudWatch → Logs → See API calls (if logging enabled)
3. Billing → Cost Explorer → Search "Textract" charges

## Verification

Run the verification script to ensure dates are correct:

```bash
python3 verify_pdf_dates.py
```

**Expected Output:**
```
✅ Date extraction working correctly!
   • 6 PDFs processed
   • 2 unique dates: 2026-01-02, 2026-01-09
   • 6 snapshots in DynamoDB

📋 Snapshot types by date:
   2026-01-02: portfolio-solutions
   2026-01-09: bitcoin-trend-tracker, early-look, momo-tracker, risk-ranges, signal-strength
```

## Files Modified

1. **date_utils.py** - New utility for date extraction
2. **parse_signal_strength.py** - Added date extraction
3. **parse_bitcoin_tracker.py** - Added date extraction
4. **parse_momo_tracker.py** - Added date extraction
5. **parse_portfolio_solutions.py** - Added date extraction
6. **parse_early_look.py** - Added date extraction
7. **parse_hedgeye_pdf.py** - Added date extraction
8. **process_hedgeye_batch.py** - Extracts and passes dates to all parsers

## DynamoDB Structure

Each snapshot is now stored with the correct publication date:

```python
{
    'date': '2026-01-09',  # ← Publication date from PDF, not today!
    'snapshotType': 'signal-strength',
    'stockCount': 66,
    'data': {...},
    'scrapedAt': '2026-01-10T16:36:00Z',  # Processing timestamp
    'pdfSource': 's3://.../signal-strength-2026-01-10-163557.pdf'
}
```

## Benefits

1. **Historical Accuracy** - Data is archived with correct publication dates
2. **Time Travel** - Can query DynamoDB for any past date
3. **Audit Trail** - Separate `scrapedAt` tracks when processing occurred
4. **Flexibility** - Can reprocess old PDFs without date confusion

## Testing

The demo script shows Textract's actual response structure:

```bash
python3 demo_textract_output.py
```

This displays:
- Total blocks returned (PAGE, TABLE, CELL, WORD, LINE)
- Example of each block type with metadata
- How tables are hierarchically structured
- Confidence scores for OCR accuracy

## Next Steps

When you download new Hedgeye PDFs:

```bash
cd /Users/timsmith/Desktop/cursor/market-dashboard/aws/lambda
export PATH="/opt/homebrew/bin:$PATH" && python3 process_hedgeye_batch.py
```

The processor will:
1. Auto-detect PDF types
2. Extract publication dates from PDFs
3. Upload to S3 with organized folders
4. Process with AWS Textract
5. Save to DynamoDB with **correct publication dates**
6. Display summary with date verification

All PDFs are now automatically parsed and archived with accurate dates!
