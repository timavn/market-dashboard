# Hedgeye Risk Range Scraper - Production Setup

Professional automated scraper that runs daily at 5:15 PM ET (after market close) to collect Hedgeye risk range data.

## Quick Start

### 1. First-Time Setup (One Time Only)

```bash
cd /Users/timsmith/Desktop/cursor/market-dashboard/aws/lambda

# Install required Python packages
pip3 install playwright playwright-stealth beautifulsoup4 boto3

# Install Playwright browsers
playwright install chromium

# Test your credentials are configured
cat hedgeye_config.json
# Should show: {"email": "your@email.com", "password": "yourpassword"}
```

### 2. Initial Login (Manual - Solve CAPTCHA Once)

**Option A: Using existing scraper**
```bash
# Opens browser window - you solve CAPTCHA manually
./hedgeye_local_scraper.py --login --chrome

# Wait for login to complete, then press Enter
```

**Option B: Using Claude Desktop (Recommended)**
```
1. Open Claude Desktop app
2. Ask: "Please log into Hedgeye at https://accounts.hedgeye.com/users/sign_in
   using credentials from hedgeye_config.json and save cookies"
3. Claude will:
   - Open browser
   - Fill credentials
   - Solve CAPTCHA
   - Save authenticated session
```

### 3. Test Scraper Works

```bash
# Run scraper manually to verify everything works
./manage_scraper.sh test

# You should see:
# ✓ Cookie file exists
# ✓ Successfully scraped N securities
# ✓ Output file created
# ✓ Stored to DynamoDB
```

### 4. Install Automated Schedule

```bash
# Install LaunchAgent to run daily at 5:15 PM
./manage_scraper.sh install

# Verify it's installed
./manage_scraper.sh status
```

**Done!** The scraper will now run automatically every weekday at 5:15 PM.

---

## Daily Operations

### Monitor Scraper

```bash
# Check if scraper is running
./manage_scraper.sh status

# View recent logs
./manage_scraper.sh logs

# View only errors
./manage_scraper.sh logs error
```

### Manual Runs

```bash
# Test scraper without waiting for scheduled time
./manage_scraper.sh test

# Or trigger the LaunchAgent directly
./manage_scraper.sh run
```

### Troubleshooting

#### Session Expired (Need to Login Again)

**Symptoms:**
- Logs show "redirected to login page"
- "sign_in" appears in logs
- Desktop notification: "Hedgeye Login Required"

**Solution:**
```bash
# Option 1: Ask Claude Desktop
# "Please log into Hedgeye and extract cookies"

# Option 2: Manual login
python3 hedgeye_local_scraper.py --login --chrome
# (Solve CAPTCHA in browser window)
```

#### Scraper Not Running

```bash
# Check LaunchAgent status
./manage_scraper.sh status

# If not loaded, reinstall
./manage_scraper.sh uninstall
./manage_scraper.sh install

# Check system logs
./manage_scraper.sh logs launchd
```

#### No Data in Dashboard

```bash
# Check if data was scraped
cat hedgeye_risk_ranges.json

# Check if data was uploaded to DynamoDB
aws dynamodb get-item \
  --table-name RiskRangeData \
  --key '{"ticker": {"S": "LATEST"}, "date": {"S": "latest"}}'

# Restart backend server
cd /Users/timsmith/Desktop/cursor/market-dashboard
npm run dev
```

---

## Files Overview

### Core Files
- **`hedgeye_local_scraper.py`** - Main scraper (uses Playwright + Chrome)
- **`run_hedgeye_scraper.sh`** - Wrapper with retries and error handling
- **`manage_scraper.sh`** - Management tool (install, test, monitor)

### Configuration
- **`hedgeye_config.json`** - Your credentials (not committed to git)
- **`hedgeye_cookies.json`** - Saved session (auto-generated)
- **`com.hedgeye.riskrange.scraper.production.plist`** - LaunchAgent config

### Logs
- **`logs/scraper_YYYY-MM-DD.log`** - Daily scraper logs
- **`logs/scraper_error_YYYY-MM-DD.log`** - Errors only
- **`logs/launchd_stdout.log`** - LaunchAgent system output
- **`logs/launchd_stderr.log`** - LaunchAgent system errors

### Output
- **`hedgeye_risk_ranges.json`** - Latest scraped data
- **DynamoDB `RiskRangeData` table** - Persistent storage

---

## Management Commands

```bash
# Installation
./manage_scraper.sh install      # Install and start scheduled runs
./manage_scraper.sh uninstall    # Stop and remove

# Testing
./manage_scraper.sh test         # Run manually (test before scheduling)
./manage_scraper.sh run          # Trigger scheduled job immediately

# Monitoring
./manage_scraper.sh status       # Check if running
./manage_scraper.sh logs         # Show all logs
./manage_scraper.sh logs error   # Show errors only
./manage_scraper.sh logs launchd # Show system logs

# Maintenance
./manage_scraper.sh restart      # Restart LaunchAgent
```

---

## Schedule Details

**When:** Every weekday (Monday-Friday) at 5:15 PM ET
**Why:** After market close, Hedgeye updates risk ranges
**Duration:** ~30-60 seconds per run
**Retries:** Up to 2 retries with 5-minute delays

---

## Architecture

```
LaunchAgent (macOS scheduler)
    ↓ triggers at 5:15 PM ET
run_hedgeye_scraper.sh (wrapper with error handling)
    ↓ executes
hedgeye_local_scraper.py (Playwright scraper)
    ↓ uses Chrome profile + cookies
Hedgeye Website (authenticated session)
    ↓ scrapes risk ranges
hedgeye_risk_ranges.json (local output)
    ↓ uploads to
DynamoDB RiskRangeData table
    ↓ queried by
Express /api/risk-ranges endpoint
    ↓ consumed by
React Dashboard (Securities Universe panel)
```

---

## Security Notes

1. **Credentials:** Stored in `hedgeye_config.json` (not committed to git)
2. **Cookies:** Stored in `hedgeye_cookies.json` (expires after ~7 days)
3. **AWS:** Uses credentials from `~/.aws/credentials` or environment variables
4. **Chrome Profile:** Uses real Chrome profile for authentication (bypasses bot detection)

---

## Maintenance Schedule

**Weekly:** Check logs for any errors
```bash
./manage_scraper.sh logs error
```

**Monthly:** Verify data is flowing to dashboard
```bash
# Check DynamoDB
aws dynamodb scan --table-name RiskRangeData --limit 5

# Check dashboard
open http://localhost:3000
```

**As Needed:** Re-login when session expires (notification will alert you)

---

## Getting Help

If scraper fails:
1. Check logs: `./manage_scraper.sh logs error`
2. Test manually: `./manage_scraper.sh test`
3. Verify login: `python3 hedgeye_local_scraper.py --check`
4. Ask Claude Desktop to handle re-login if needed

---

## Production Checklist

- [ ] Python packages installed (`playwright`, `playwright-stealth`, `boto3`, `beautifulsoup4`)
- [ ] Playwright browsers installed (`playwright install chromium`)
- [ ] Credentials configured in `hedgeye_config.json`
- [ ] Initial login completed (cookies saved)
- [ ] Test scraper works: `./manage_scraper.sh test`
- [ ] LaunchAgent installed: `./manage_scraper.sh install`
- [ ] DynamoDB table `RiskRangeData` exists
- [ ] Express server configured to query DynamoDB
- [ ] Dashboard displays risk range data

---

**Status:** Production Ready ✓
**Last Updated:** 2025-12-22
**Maintainer:** Claude Code
