# Hedgeye Local Scraper - Quick Start

## Overview

This scraper uses Playwright with cookies extracted after manual login to pull Risk Range data from Hedgeye. You manually log in each morning (~7 EST), extract cookies, and the scraper handles the rest.

## Prerequisites

- Python 3.9+
- Playwright: `pip install playwright && playwright install chromium`
- boto3 (for DynamoDB): `pip install boto3`
- AWS CLI configured: `aws configure`

## Files

- `hedgeye_local_scraper.py` - Main scraper script
- `extract_hedgeye_cookies.py` - Cookie extraction script (run after manual login)
- `hedgeye_cookies.json` - Extracted cookies (created after running extract script)
- `hedgeye_risk_ranges.json` - Latest scraped data (local backup)
- `hedgeye_debug.html` - Debug HTML from last scrape

## Usage

### Morning Routine (Manual - ~7 EST)

1. **Log into Hedgeye manually in Chrome** (solve CAPTCHA if needed)
2. **Extract cookies**:
   ```bash
   cd /Users/timsmith/Desktop/cursor/market-dashboard/aws/lambda
   python3 extract_hedgeye_cookies.py
   ```
3. Done! Cookies are saved for the day.

### Automated Scraping

```bash
# Scrape and store to DynamoDB
python3 hedgeye_local_scraper.py --scrape

# Scrape to local file only
python3 hedgeye_local_scraper.py --scrape --no-dynamodb

# Scrape with visible browser (for debugging)
python3 hedgeye_local_scraper.py --scrape --headless=false
```

### Daily Automated Runs

Once logged in, run scrapes automatically via macOS launchd (recommended) or cron.

#### Option A: launchd (Recommended for Mac)

```bash
# Copy the plist file to LaunchAgents
cp /Users/timsmith/Desktop/cursor/market-dashboard/aws/lambda/com.hedgeye.riskrange.scraper.plist ~/Library/LaunchAgents/

# Load the schedule
launchctl load ~/Library/LaunchAgents/com.hedgeye.riskrange.scraper.plist

# Verify it's loaded
launchctl list | grep hedgeye

# To unload/stop:
launchctl unload ~/Library/LaunchAgents/com.hedgeye.riskrange.scraper.plist
```

This runs at 5:15 PM ET every weekday. Logs are in `/tmp/hedgeye_scraper.log`.

#### Option B: cron

```bash
# Edit crontab
crontab -e

# Add line (runs at 5:15 PM ET every weekday)
15 17 * * 1-5 cd /Users/timsmith/Desktop/cursor/market-dashboard/aws/lambda && python3 hedgeye_local_scraper.py --scrape >> /tmp/hedgeye_scrape.log 2>&1
```

## Cookie Expiration

Hedgeye cookies typically last 1-4 weeks. When expired:
1. Log into Hedgeye again in Chrome
2. Run `python3 extract_hedgeye_cookies.py` to refresh cookies
3. Continue with `--scrape`

## Data Storage

- **DynamoDB Table**: `RiskRangeData`
  - Individual records: `ticker=SPX, date=2025-12-03`
  - Latest snapshot: `ticker=LATEST, date=latest`
- **Local JSON**: `hedgeye_risk_ranges.json`

## Troubleshooting

**"No cookies found"**: Log into Hedgeye in Chrome, then run `python3 extract_hedgeye_cookies.py`

**"Redirected to login page"**: Cookies expired - log in again and re-extract cookies

**"No data scraped"**: Check `hedgeye_debug.html` for page content

**Timeout errors**: Hedgeye may be slow, or cookies may have expired

**DynamoDB errors**: Check AWS credentials with `aws sts get-caller-identity`

## Command Reference

```bash
# Extract cookies (after manual login in Chrome)
python3 extract_hedgeye_cookies.py

# Scrape (with DynamoDB)
python3 hedgeye_local_scraper.py --scrape

# Scrape (local only)
python3 hedgeye_local_scraper.py --scrape --no-dynamodb

# Scrape with visible browser
python3 hedgeye_local_scraper.py --scrape --headless=false

# Show help
python3 hedgeye_local_scraper.py --help
```

