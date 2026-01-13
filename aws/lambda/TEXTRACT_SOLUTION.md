# AWS Textract Solution for Hedgeye PDFs

## Summary

I've implemented AWS Textract to extract table data from the 4 failing Hedgeye PDF parsers. However, there's a **dependency requirement** that needs to be installed before the parsers will work.

## Root Cause (Confirmed)

The investigation confirmed that Hedgeye PDFs contain **tables rendered as images**, not extractable text:

```
Page 3 of Bitcoin Tracker PDF:
- Images: 2 (the actual data tables)
- Extractable text: Only 278 chars (header/footer)
- extract_tables(): Returns 0 tables
```

## Solution Implemented

All 4 failing parsers now use **AWS Textract** to extract table data:

1. **parse_bitcoin_tracker.py** - Extracts pages 3 & 10, sends to Textract
2. **parse_momo_tracker.py** - Extracts page 4, sends to Textract
3. **parse_portfolio_solutions.py** - Extracts page 2, sends to Textract
4. **parse_signal_strength.py** - Extracts page 2, sends to Textract

### How It Works

```python
# 1. Convert specific PDF pages to PNG image
image_bytes = convert_pdf_pages_to_image(pdf_path, [3, 10])

# 2. Send image to AWS Textract
response = textract.analyze_document(
    Document={'Bytes': image_bytes},
    FeatureTypes=['TABLES']
)

# 3. Parse table blocks and extract cell data
for table in tables:
    table_data = get_table_data(table, blocks)
    # Extract ticker, price, buy/sell, trend, etc.
```

## Required Dependencies

### System Dependency
**poppler** - Required by pdf2image to convert PDF pages to images

Install on macOS:
```bash
brew install poppler
```

Install on Ubuntu/Debian:
```bash
sudo apt-get install poppler-utils
```

### Python Packages (Already Installed)
- ✅ `boto3` - AWS SDK
- ✅ `PyPDF2` - PDF manipulation
- ✅ `pdf2image` - PDF to image conversion
- ✅ `Pillow` - Image processing

## AWS Textract Costs

Textract pricing (as of 2026):
- **First 1 million pages/month**: $1.50 per 1,000 pages
- Processing 6 PDFs per day = ~180 pages/month
- **Estimated cost**: ~$0.27/month (well within free tier if available)

## Testing the Solution

Once poppler is installed:

```bash
cd /Users/timsmith/Desktop/cursor/market-dashboard/aws/lambda

# Test individual parser
python3 parse_bitcoin_tracker.py ~/Desktop/hedgeye/"Hedgeye - CRYPTO QUANT _.pdf"

# Test all parsers
python3 process_hedgeye_batch.py
```

**Expected output:**
```
======================================================================
📊 SUMMARY
======================================================================
   ✅ Processed: 6
   ❌ Failed: 0

🎉 Done! Check your S3 bucket and dashboard.
```

## Current Workaround (Manual Entry)

Until poppler is installed, use the manual entry script:

```bash
# Edit manual_data_entry.py with today's numbers
nano manual_data_entry.py

# Update data for all 4 reports, then save and run:
python3 manual_data_entry.py
```

This takes 2-3 minutes per day and ensures data accuracy.

## Files Modified

### Textract Parsers (UPDATED)
- [parse_bitcoin_tracker.py](parse_bitcoin_tracker.py:14) - Converts pages 3 & 10 to image
- [parse_momo_tracker.py](parse_momo_tracker.py:14) - Converts page 4 to image
- [parse_portfolio_solutions.py](parse_portfolio_solutions.py:15) - Converts page 2 to image
- [parse_signal_strength.py](parse_signal_strength.py:15) - Converts page 2 to image

### Working Parsers (NO CHANGES NEEDED)
- [parse_hedgeye_pdf.py](parse_hedgeye_pdf.py) - Risk Ranges (text extraction)
- [parse_early_look.py](parse_early_look.py) - Early Look (text extraction)

### Batch Processor (UPDATED)
- [process_hedgeye_batch.py](process_hedgeye_batch.py:150) - Passes s3_key to all parsers

## Verification Steps

After installing poppler and running batch processor:

1. **Check console output** - Should show table extraction for all 6 PDFs
2. **Verify DynamoDB** - Run this command:

```python
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
signal-strength: ✅
```

## Next Steps

1. **Install poppler** (system dependency)
2. **Test batch processor** with all 6 PDFs
3. **Verify data in DynamoDB** matches PDF screenshots
4. **Archive manual_data_entry.py** (no longer needed)

## Questions?

See main documentation: [HEDGEYE_README.md](HEDGEYE_README.md)
