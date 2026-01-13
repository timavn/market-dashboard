#!/usr/bin/env python3
"""
Hedgeye Scraper - Uses your Chrome profile to bypass Cloudflare
Usage: Close Chrome, then run: python3 hedgeye_scraper.py
"""

import json
import os
import sys
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path

try:
    from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeout
except ImportError:
    print("❌ Playwright not installed. Run: pip install playwright && playwright install chromium")
    sys.exit(1)

try:
    import boto3
    BOTO3_AVAILABLE = True
except ImportError:
    BOTO3_AVAILABLE = False
    print("⚠️  boto3 not installed - will save locally only")

# Configuration
SCRIPT_DIR = Path(__file__).parent
CHROME_PROFILE = Path.home() / "Library/Application Support/Google/Chrome/Profile 2"

# Hedgeye URLs
RISK_RANGE_URL = "https://app.hedgeye.com/feed_items/all?page=1&with_category=33-risk-range-signals"

# Ticker mapping
TICKER_MAPPING = {
    'UST30Y': 'UST30Y', 'UST10Y': 'UST10Y', 'UST2Y': 'UST2Y',
    'HYG': 'HYG', 'LQD': 'LQD', 'SPX': 'SPX', 'COMPQ': 'COMPQ',
    'RUT': 'RUT', 'NDX': 'NDX', 'DXY': 'DXY', 'GOLD': 'GLD',
    'OIL': 'USO', 'VIX': 'VIX',
}


def check_chrome_closed():
    """Check if Chrome is running"""
    import subprocess
    result = subprocess.run(['pgrep', '-f', 'Google Chrome'], capture_output=True)
    if result.returncode == 0:
        print("\n❌ ERROR: Chrome is currently running!")
        print("   You must close Chrome completely before running this script.")
        print("   This is required to use your Chrome profile.\n")
        response = input("Would you like me to close Chrome for you? (y/n): ")
        if response.lower() == 'y':
            subprocess.run(['killall', 'Google Chrome'])
            print("✅ Chrome closed. Waiting 3 seconds...")
            import time
            time.sleep(3)
        else:
            sys.exit(1)


def scrape_risk_ranges():
    """Main scraping function"""
    print("\n" + "="*70)
    print("🔍 HEDGEYE RISK RANGE SCRAPER")
    print("="*70)
    print(f"📁 Chrome Profile: {CHROME_PROFILE}")
    print(f"🎯 Target: Risk Range Signals")
    print("="*70 + "\n")

    # Check Chrome is closed
    check_chrome_closed()

    risk_data = {}
    screenshot_path = None

    with sync_playwright() as p:
        print("🚀 Launching browser with your Chrome profile...")

        # Launch persistent context (uses your actual Chrome profile)
        context = p.chromium.launch_persistent_context(
            str(CHROME_PROFILE),
            headless=False,  # Visible browser so you can watch
            viewport={'width': 1920, 'height': 1080},
            args=[
                '--disable-blink-features=AutomationControlled',
                '--disable-dev-shm-usage'
            ]
        )

        page = context.pages[0] if context.pages else context.new_page()

        try:
            # Navigate to risk ranges
            print(f"\n🌐 Navigating to Hedgeye...")
            page.goto(RISK_RANGE_URL, wait_until='domcontentloaded', timeout=60000)
            print(f"✅ Loaded: {page.url}")

            # Wait and check for Cloudflare
            page.wait_for_timeout(3000)
            page_content = page.content()

            if "Just a moment" in page_content or "Verify you are human" in page_content:
                print("\n⏳ Cloudflare challenge detected - waiting...")

                for i in range(30):  # 90 seconds max
                    page.wait_for_timeout(3000)
                    new_content = page.content()

                    if "Just a moment" not in new_content and "feed_items" in page.url:
                        print(f"✅ Cloudflare passed after {i*3} seconds!")
                        break

                    if i % 5 == 0 and i > 0:
                        print(f"   Still waiting... ({i*3}s elapsed)")
                else:
                    print("⚠️  Cloudflare challenge didn't resolve - continuing anyway...")
            else:
                print("✅ No Cloudflare challenge")

            # Check if logged in
            if "sign_in" in page.url.lower():
                print("\n❌ ERROR: Not logged in!")
                print("   Please log into Hedgeye in Chrome first, then run this script.")
                sys.exit(1)

            # Wait for content
            print("\n⏳ Waiting for page content...")
            page.wait_for_timeout(5000)

            # Look for table
            try:
                page.wait_for_selector('table', timeout=15000)
                tables = page.locator('table').count()
                print(f"✅ Found {tables} table(s)")
            except PlaywrightTimeout:
                print("⚠️  No table found - page may not have loaded")

            # Take screenshot
            timestamp = datetime.now(timezone.utc)
            date_str = timestamp.strftime('%Y-%m-%d')
            time_str = timestamp.strftime('%H%M%S')
            screenshot_path = SCRIPT_DIR / f"hedgeye_screenshot_{date_str}_{time_str}.png"

            print(f"\n📸 Taking screenshot...")
            page.screenshot(path=str(screenshot_path), full_page=True)
            print(f"✅ Saved: {screenshot_path}")

            # Extract HTML
            print("\n📄 Extracting page content...")
            html_content = page.content()

            # Parse table
            from bs4 import BeautifulSoup
            soup = BeautifulSoup(html_content, 'html.parser')
            risk_data = parse_table(soup, timestamp)

            if risk_data:
                print(f"\n✅ Successfully extracted {len(risk_data)} securities!")
                for ticker, data in risk_data.items():
                    print(f"   {ticker}: LRR={data['lrr']}, HRR={data['hrr']}")
            else:
                print("\n⚠️  No data extracted - saving HTML for review...")
                debug_file = SCRIPT_DIR / "hedgeye_debug.html"
                with open(debug_file, 'w', encoding='utf-8') as f:
                    f.write(html_content)
                print(f"   Saved debug HTML: {debug_file}")

        finally:
            print("\n🔒 Closing browser...")
            context.close()

    # Save results
    if risk_data:
        save_results(risk_data, screenshot_path)

    return risk_data


def parse_table(soup, timestamp):
    """Parse risk range table from HTML"""
    risk_data = {}

    tables = soup.find_all('table')
    print(f"   Parsing {len(tables)} table(s)...")

    for idx, table in enumerate(tables):
        headers = table.find_all('th')
        header_texts = [h.get_text(strip=True).upper() for h in headers]

        if 'BUY TRADE' in header_texts and 'SELL TRADE' in header_texts:
            print(f"   ✅ Found Risk Range table!")

            try:
                index_col = header_texts.index('INDEX')
                buy_col = header_texts.index('BUY TRADE')
                sell_col = header_texts.index('SELL TRADE')
            except ValueError as e:
                print(f"   ❌ Missing columns: {e}")
                continue

            rows = table.find_all('tr')[1:]  # Skip header

            for row in rows:
                cells = row.find_all(['td', 'th'])
                if len(cells) <= max(index_col, buy_col, sell_col):
                    continue

                try:
                    index_name = cells[index_col].get_text(strip=True)
                    buy_trade = cells[buy_col].get_text(strip=True)
                    sell_trade = cells[sell_col].get_text(strip=True)

                    if not index_name or not buy_trade or not sell_trade:
                        continue

                    # Clean values
                    buy_clean = buy_trade.replace(',', '').replace('$', '').replace('%', '').strip()
                    sell_clean = sell_trade.replace(',', '').replace('$', '').replace('%', '').strip()

                    lrr = float(buy_clean)
                    hrr = float(sell_clean)
                    ticker = TICKER_MAPPING.get(index_name, index_name)

                    risk_data[ticker] = {
                        'lrr': lrr,
                        'hrr': hrr,
                        'original_name': index_name,
                        'timestamp': timestamp.isoformat(),
                        'source': 'hedgeye'
                    }

                except (ValueError, IndexError):
                    continue

            break

    return risk_data


def save_results(risk_data, screenshot_path):
    """Save results to JSON, CSV, S3, and DynamoDB"""
    timestamp = datetime.now(timezone.utc)
    date_str = timestamp.strftime('%Y-%m-%d')

    # Save JSON
    json_file = SCRIPT_DIR / "hedgeye_risk_ranges.json"
    with open(json_file, 'w') as f:
        json.dump({
            'scraped_at': timestamp.isoformat(),
            'count': len(risk_data),
            'data': risk_data
        }, f, indent=2)
    print(f"\n💾 Saved JSON: {json_file}")

    # Save CSV
    csv_file = SCRIPT_DIR / f"hedgeye_risk_ranges_{date_str}.csv"
    with open(csv_file, 'w') as f:
        f.write("ticker,lrr,hrr,original_name,timestamp\n")
        for ticker, data in risk_data.items():
            f.write(f"{ticker},{data['lrr']},{data['hrr']},{data['original_name']},{data['timestamp']}\n")
    print(f"💾 Saved CSV: {csv_file}")

    # Upload to S3 and DynamoDB
    if BOTO3_AVAILABLE:
        print("\n☁️  Uploading to AWS...")
        upload_to_aws(risk_data, screenshot_path, csv_file, date_str, timestamp)
    else:
        print("\n⚠️  Skipping AWS upload (boto3 not available)")


def upload_to_aws(risk_data, screenshot_path, csv_file, date_str, timestamp):
    """Upload to S3 and DynamoDB"""
    try:
        s3 = boto3.client('s3', region_name='us-west-1')
        bucket = 'market-dashboard-csv-data'

        # Upload screenshot
        screenshot_s3_key = None
        if screenshot_path and screenshot_path.exists():
            time_str = timestamp.strftime('%H%M%S')
            screenshot_s3_key = f"hedgeye-screenshots/{date_str}/risk-ranges-{date_str}-{time_str}.png"
            s3.upload_file(str(screenshot_path), bucket, screenshot_s3_key,
                          ExtraArgs={'ContentType': 'image/png'})
            print(f"   ✅ Screenshot uploaded to S3")

        # Upload CSV
        csv_s3_key = None
        if csv_file and csv_file.exists():
            csv_s3_key = f"hedgeye-exports/risk-ranges-{date_str}.csv"
            s3.upload_file(str(csv_file), bucket, csv_s3_key,
                          ExtraArgs={'ContentType': 'text/csv'})
            print(f"   ✅ CSV uploaded to S3")

        # Store in DynamoDB
        dynamodb = boto3.resource('dynamodb', region_name='us-west-1')

        # Individual records
        table = dynamodb.Table('HedgeyeRiskRanges')
        for ticker, data in risk_data.items():
            table.put_item(Item={
                'date': date_str,
                'ticker': ticker,
                'lrr': Decimal(str(data['lrr'])),
                'hrr': Decimal(str(data['hrr'])),
                'updatedAt': timestamp.isoformat(),
                'source': 'hedgeye',
                'ttl': int(timestamp.timestamp() + (730 * 24 * 60 * 60))
            })
        print(f"   ✅ Stored {len(risk_data)} records in DynamoDB")

        # Daily snapshot
        snapshot_table = dynamodb.Table('HedgeyeDailySnapshot')
        snapshot_item = {
            'date': date_str,
            'snapshotType': 'risk-ranges',
            'riskRangeCount': len(risk_data),
            'data': {ticker: {
                'lrr': float(data['lrr']),
                'hrr': float(data['hrr']),
                'timestamp': data['timestamp']
            } for ticker, data in risk_data.items()},
            'scrapedAt': timestamp.isoformat(),
            'ttl': int(timestamp.timestamp() + (730 * 24 * 60 * 60))
        }

        if screenshot_s3_key:
            snapshot_item['screenshotS3Key'] = screenshot_s3_key
        if csv_s3_key:
            snapshot_item['csvS3Key'] = csv_s3_key

        snapshot_table.put_item(Item=snapshot_item)
        print(f"   ✅ Snapshot saved to DynamoDB")

        print("\n🎉 All data uploaded successfully!")

    except Exception as e:
        print(f"\n⚠️  AWS upload error: {e}")
        print("   Data saved locally only")


if __name__ == '__main__':
    try:
        data = scrape_risk_ranges()

        print("\n" + "="*70)
        print("✅ SCRAPE COMPLETE!")
        print(f"📊 Securities scraped: {len(data) if data else 0}")
        print("="*70 + "\n")

        if data:
            sys.exit(0)
        else:
            print("⚠️  No data extracted - check the debug HTML file")
            sys.exit(1)

    except KeyboardInterrupt:
        print("\n\n⚠️  Interrupted by user")
        sys.exit(1)
    except Exception as e:
        print(f"\n\n❌ ERROR: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
