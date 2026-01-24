# Cloudflare Bypass Fix

## Problem Identified

The screenshot showed Cloudflare challenge page because:
1. **Chrome was running** - When Chrome is open, Playwright can't use the Chrome profile (profile is locked)
2. **Cloudflare detection wasn't robust** - Only checked for 2 indicators, waited only 60 seconds
3. **Screenshot taken too early** - Captured before verifying challenge passed

## Fixes Applied

### 1. Improved Cloudflare Detection
- Now checks for 7 different Cloudflare indicators:
  - "Just a moment"
  - "challenge-platform"
  - "cf-browser-verification"
  - "cf-challenge"
  - "Verify you are human"
  - "Checking your browser"
  - "Ray ID"

### 2. Longer Wait Time
- Increased wait from 60 seconds to **90 seconds**
- Checks every 3 seconds
- Verifies we're on actual page (not Cloudflare) before proceeding

### 3. Better Verification
- Checks URL contains `feed_items` and `risk-range`
- Double-checks content doesn't have Cloudflare indicators
- Only takes screenshot AFTER verifying challenge passed

### 4. Chrome Profile Improvements
- Warns if Chrome is running when using `--chrome` flag
- Adds automation flags to help bypass detection
- Sets proper user agent

### 5. Final Check Before Screenshot
- Verifies we're not still on Cloudflare page
- Warns if Cloudflare detected at screenshot time
- Takes screenshot anyway for manual review

## How to Test

### Option 1: Close Chrome and Test (Recommended)
```bash
cd /Users/timsmith/Desktop/cursor/market-dashboard/aws/lambda

# Close Chrome first
killall "Google Chrome" 2>/dev/null
sleep 3

# Run with Chrome profile
python3 hedgeye_local_scraper.py --scrape --chrome --headless
```

### Option 2: Use Test Script
```bash
cd /Users/timsmith/Desktop/cursor/market-dashboard/aws/lambda
./test_cloudflare_bypass.sh
```

This script will:
- Check if Chrome is running
- Offer to close it
- Run the scraper with proper flags
- Show you what to look for

## Expected Behavior

**If Cloudflare bypasses successfully:**
```
✓ No Cloudflare challenge detected
✓ Successfully navigated to risk range page
✓ Found table element
✓ Screenshot saved: hedgeye_screenshot_*.png
✓ Successfully scraped X securities
```

**If Cloudflare still blocks:**
```
⚠ Cloudflare challenge detected - waiting for it to complete...
  Still waiting... (0s)
  Still waiting... (9s)
  ...
⚠ Cloudflare challenge may still be active
⚠ WARNING: Still appears to be on Cloudflare challenge page
```

## Why It Works "Last Time"

You mentioned "we got through that last time" - this likely worked because:
1. Chrome was closed (profile available)
2. Chrome profile had valid logged-in session
3. Cloudflare recognized the real Chrome profile as legitimate

## Scheduled Runs

The scheduled runs (8:00 AM EST) should work because:
- Chrome is typically closed at that time
- Uses `--chrome` flag (real Chrome profile)
- Has valid session from previous login

## If Cloudflare Still Blocks

If you still see Cloudflare after these fixes:

1. **Check Chrome Profile Session**
   - Open Chrome manually
   - Navigate to: https://app.hedgeye.com/feed_items/all?page=1&with_category=33-risk-range-signals
   - Make sure you're logged in and can see the risk range table
   - Close Chrome completely

2. **Refresh Cookies**
   ```bash
   cd /Users/timsmith/Desktop/cursor/market-dashboard/aws/lambda
   python3 extract_hedgeye_cookies.py
   ```

3. **Run Scraper**
   ```bash
   python3 hedgeye_local_scraper.py --scrape --chrome --headless
   ```

## Next Steps

1. Close Chrome
2. Run test: `./test_cloudflare_bypass.sh`
3. Check screenshot - should show actual Hedgeye page (not Cloudflare)
4. Verify data extraction works
5. Check Preview tab in dashboard


