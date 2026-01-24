#!/bin/bash

# Test script to verify Cloudflare bypass with Chrome profile

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "🔍 Testing Cloudflare Bypass"
echo "============================"
echo ""

# Check if Chrome is running
echo "1️⃣  Checking Chrome status..."
if pgrep -f "Google Chrome" > /dev/null; then
    echo "⚠️  Chrome is currently running"
    echo ""
    echo "To use Chrome profile (bypass Cloudflare), you need to:"
    echo "  Option A: Close Chrome completely, then run:"
    echo "    python3 hedgeye_local_scraper.py --scrape --chrome"
    echo ""
    echo "  Option B: Run in headless mode (may still hit Cloudflare):"
    echo "    python3 hedgeye_local_scraper.py --scrape --chrome --headless"
    echo ""
    read -p "Close Chrome now and continue? (y/n) " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        echo "Closing Chrome..."
        killall "Google Chrome" 2>/dev/null || true
        sleep 3
        echo "✓ Chrome closed"
    else
        echo "⚠️  Continuing with Chrome running (may cause issues)"
    fi
else
    echo "✓ Chrome is not running - good to go!"
fi

echo ""
echo "2️⃣  Checking cookies..."
if [ -f "hedgeye_cookies.json" ]; then
    COOKIE_AGE=$(($(date +%s) - $(stat -f%m hedgeye_cookies.json)))
    COOKIE_DAYS=$((COOKIE_AGE / 86400))
    echo "✓ Cookie file exists (${COOKIE_DAYS} days old)"
    if [ $COOKIE_DAYS -gt 7 ]; then
        echo "  ⚠️  Cookies are old - may need refresh"
    fi
else
    echo "⚠️  No cookie file found"
fi

echo ""
echo "3️⃣  Testing scraper with Chrome profile..."
echo "   This will:"
echo "   - Use your real Chrome profile (logged in state)"
echo "   - Navigate to Hedgeye risk range page"
echo "   - Wait for Cloudflare challenge to pass"
echo "   - Capture screenshot"
echo "   - Extract data"
echo ""

read -p "Run test now? (y/n) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    echo ""
    echo "Running scraper..."
    python3 hedgeye_local_scraper.py --scrape --chrome --headless
    echo ""
    echo "✅ Test complete!"
    echo ""
    echo "Check the output above for:"
    echo "  ✓ 'Cloudflare challenge passed!'"
    echo "  ✓ 'Successfully scraped X securities'"
    echo "  ✓ Screenshot saved"
    echo ""
    echo "If you see Cloudflare in the screenshot, the challenge didn't pass."
    echo "This usually means:"
    echo "  - Chrome profile doesn't have valid session"
    echo "  - Need to login manually in Chrome first"
    echo "  - Cookies expired"
else
    echo "Test cancelled"
fi


