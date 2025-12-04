# Hedgeye Local Scraper - Quick Start

## Overview

This scraper uses Playwright with persistent browser sessions to pull Risk Range data from Hedgeye after you login manually once.

## Prerequisites

- Python 3.9+
- Playwright: `pip install playwright && playwright install chromium`
- boto3 (for DynamoDB): `pip install boto3`
- AWS CLI configured: `aws configure`

## Files

- `hedgeye_local_scraper.py` - Main scraper script
- `hedgeye_config.json` - Your Hedgeye credentials (already configured)
- `hedgeye_session.json` - Saved browser session (created after login)
- `hedgeye_risk_ranges.json` - Latest scraped data (local backup)
- `hedgeye_debug.html` - Debug HTML from last scrape

## Usage

### Step 1: Login (One-Time Setup)

Run this in your terminal (not an IDE - needs GUI):

```bash
cd /Users/timsmith/Desktop/cursor/market-dashboard/aws/lambda
python3 hedgeye_local_scraper.py --login
```

A browser window will open with credentials pre-filled:
1. Click "Log In"
2. Solve CAPTCHA if prompted
3. Wait for redirect to dashboard
4. Session auto-saves when login detected

### Step 2: Verify Session

```bash
python3 hedgeye_local_scraper.py --check
```

Should show "✓ Session is valid!"

### Step 3: Run Scrape

```bash
# Scrape and store to DynamoDB
python3 hedgeye_local_scraper.py --scrape

# Scrape to local file only
python3 hedgeye_local_scraper.py --scrape --no-dynamodb
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

## Session Expiration

Hedgeye sessions typically last 1-4 weeks. When expired:
1. Run `--check` to verify
2. Run `--login` to re-authenticate
3. Continue with `--scrape`

## Data Storage

- **DynamoDB Table**: `RiskRangeData`
  - Individual records: `ticker=SPX, date=2025-12-03`
  - Latest snapshot: `ticker=LATEST, date=latest`
- **Local JSON**: `hedgeye_risk_ranges.json`

## Troubleshooting

**"Session expired"**: Run `--login` again

**"No data scraped"**: Check `hedgeye_debug.html` for page content

**Timeout errors**: Session may be expired, or Hedgeye may be slow

**DynamoDB errors**: Check AWS credentials with `aws sts get-caller-identity`

## Command Reference

```bash
# Login and save session
python3 hedgeye_local_scraper.py --login

# Login with longer wait
python3 hedgeye_local_scraper.py --login --wait 180

# Check session validity
python3 hedgeye_local_scraper.py --check

# Scrape (with DynamoDB)
python3 hedgeye_local_scraper.py --scrape

# Scrape (local only)
python3 hedgeye_local_scraper.py --scrape --no-dynamodb

# Show help
python3 hedgeye_local_scraper.py --help
```

