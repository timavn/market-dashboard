# Hedgeye Scraper Test Script

## Purpose

The `test_hedgeye_scraper.py` script inspects the actual Hedgeye Risk Range Signals page structure to:
1. Verify login works with your credentials
2. Capture the HTML structure of the page
3. Analyze the table structure and column positions
4. Extract sample data to verify parsing logic
5. Generate ticker mapping suggestions

## Prerequisites

1. Install Playwright:
   ```bash
   pip install playwright
   playwright install chromium
   ```

2. Create config file (already done):
   - `hedgeye_config.json` exists with your credentials
   - Or set `HEDGEYE_EMAIL` and `HEDGEYE_PASSWORD` environment variables

## Running the Test

```bash
cd aws/lambda
python test_hedgeye_scraper.py
```

## What It Does

1. **Logs in** to Hedgeye using credentials from `hedgeye_config.json`
2. **Navigates** to the Risk Range Signals page
3. **Captures** the full HTML and saves it to `test_output/hedgeye_page.html`
4. **Analyzes** the table structure:
   - Finds all tables on the page
   - Identifies the Risk Range Signals table
   - Extracts column positions (INDEX, BUY TRADE, SELL TRADE)
   - Parses sample rows
5. **Generates** output files:
   - `test_output/hedgeye_page.html` - Full page HTML
   - `test_output/extracted_securities.json` - All extracted securities
   - `test_output/analysis_summary.json` - Analysis summary

## Output

The script will:
- Print detailed analysis to console
- Show ticker mapping suggestions
- Keep browser open for 30 seconds for manual inspection
- Save all findings to `test_output/` directory

## Next Steps

After running the test:

1. **Review the output** to see:
   - Which securities are available on Hedgeye
   - The exact column structure
   - Sample extracted data

2. **Update TICKER_MAPPING** in `hedgeye_risk_range_scraper.py`:
   - Add all securities found on the page
   - Map Hedgeye INDEX names to your ticker symbols

3. **Verify parsing logic** matches the actual page structure

4. **Test the scraper** locally before deploying to Lambda

## Troubleshooting

- **Login fails**: Check credentials in `hedgeye_config.json`
- **Table not found**: The page structure may have changed - check the saved HTML
- **Playwright errors**: Make sure Playwright is installed: `playwright install chromium`

