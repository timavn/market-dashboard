# Installing Poppler for Hedgeye PDF Automation

## Why Poppler is Needed

The 4 failing Hedgeye parsers (Bitcoin Tracker, Momo Tracker, Portfolio Solutions, Signal Strength) use **AWS Textract** to extract table data from PDF images. To send images to Textract, we need to convert PDF pages to PNG format using `pdf2image`, which requires **poppler** as a system dependency.

## Installation Steps

### Option 1: Install Homebrew + Poppler (Recommended)

1. **Install Homebrew** (if not already installed):
   ```bash
   /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
   ```

   This will prompt for your password (requires admin access).

2. **Add Homebrew to PATH** (if needed):
   ```bash
   echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> ~/.zprofile
   eval "$(/opt/homebrew/bin/brew shellenv)"
   ```

3. **Install Poppler**:
   ```bash
   brew install poppler
   ```

4. **Verify Installation**:
   ```bash
   which pdftoppm
   # Should output: /opt/homebrew/bin/pdftoppm or /usr/local/bin/pdftoppm
   ```

### Option 2: Download Pre-built Poppler (No Homebrew)

If you don't have admin access or prefer not to use Homebrew:

1. Download poppler binaries for macOS from: https://github.com/oschwartz10612/poppler-windows/releases

2. Extract to a local directory (e.g., `~/poppler`)

3. Add to PATH in your shell config:
   ```bash
   echo 'export PATH="$HOME/poppler/bin:$PATH"' >> ~/.zprofile
   source ~/.zprofile
   ```

## Testing the Installation

Once poppler is installed, test the parsers:

```bash
cd ~/Desktop/cursor/market-dashboard/aws/lambda

# Test Bitcoin Tracker parser
python3 parse_bitcoin_tracker.py ~/Desktop/hedgeye/"Hedgeye - CRYPTO QUANT "*.pdf

# Test batch processor (all 6 PDFs)
python3 process_hedgeye_batch.py
```

**Expected output:**
```
======================================================================
📊 SUMMARY
======================================================================
   ✅ Processed: 6
   ❌ Failed: 0
```

## Verification

After successful processing, verify data in DynamoDB:

```bash
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

print('\\n✅ Data in DynamoDB:\\n')
for item in response['Items']:
    snapshot_type = item['snapshotType']
    count = item.get('cryptoCount', item.get('stockCount', len(item.get('data', {}).get('stocks', []))))
    source = item.get('source', 'unknown')
    print(f'  {snapshot_type}: {count} records (source: {source})')
"
```

**Expected output:**
```
✅ Data in DynamoDB:

  bitcoin-trend-tracker: 6 cryptos + 8 stocks (source: textract)
  early-look: 13 records (source: pdf)
  momo-tracker: 9 records (source: textract)
  portfolio-solutions: X rankings (source: textract)
  risk-ranges: 35 records (source: pdf)
  signal-strength: 79 records (source: textract)
```

## Troubleshooting

### Error: "pdftoppm not found"
- Poppler is not installed or not in PATH
- Run `which pdftoppm` to check
- If installed via Homebrew, ensure PATH includes `/opt/homebrew/bin` or `/usr/local/bin`

### Error: "UnsupportedDocumentException"
- This was the old error when trying to send PDF directly to Textract
- Should be resolved by converting to PNG first
- If still seeing this, check that `pdf2image` and `Pillow` are installed:
  ```bash
  pip3 install --user pdf2image Pillow
  ```

### Parser returns 0 records
- Check that the PDF is the correct type (batch processor auto-detects)
- Verify AWS credentials are configured: `aws configure list`
- Check CloudWatch logs for Textract API errors

## Alternative: Manual Entry (Temporary)

Until poppler is installed, continue using manual entry:

```bash
cd ~/Desktop/cursor/market-dashboard/aws/lambda
nano manual_data_entry.py  # Update with today's data
python3 manual_data_entry.py
```

This takes 2-3 minutes per day and ensures data accuracy.

## Cost Estimate

AWS Textract pricing:
- **6 PDFs/day = ~180 pages/month**
- **First 1M pages**: $1.50 per 1,000 pages
- **Monthly cost**: ~$0.27

Well within AWS free tier if available.

## Next Steps

1. ✅ Install poppler using one of the options above
2. ✅ Run `python3 process_hedgeye_batch.py`
3. ✅ Verify all 6 snapshot types appear in DynamoDB
4. ✅ Archive `manual_data_entry.py` (no longer needed)
5. ✅ Set up daily cron job or reminder to run batch processor before 7am EST

## Files Reference

- [TEXTRACT_SOLUTION.md](TEXTRACT_SOLUTION.md) - Technical implementation details
- [HEDGEYE_README.md](HEDGEYE_README.md) - Overall workflow documentation
- [process_hedgeye_batch.py](process_hedgeye_batch.py) - Main batch processor
