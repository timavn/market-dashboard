#!/usr/bin/env python3
"""
Simple Hedgeye Scraper - Uses Playwright with cookies
Run after: python3 extract_hedgeye_cookies.py
"""

import json
import sys
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path

from playwright.sync_api import sync_playwright
from bs4 import BeautifulSoup

try:
    import boto3
    BOTO3_AVAILABLE = True
except:
    BOTO3_AVAILABLE = False

SCRIPT_DIR = Path(__file__).parent
COOKIE_FILE = SCRIPT_DIR / "hedgeye_cookies.json"
URL = "https://app.hedgeye.com/feed_items/all?page=1&with_category=33-risk-range-signals"

TICKER_MAP = {
    'UST30Y': 'UST30Y', 'UST10Y': 'UST10Y', 'UST2Y': 'UST2Y',
    'HYG': 'HYG', 'LQD': 'LQD', 'SPX': 'SPX', 'COMPQ': 'COMPQ',
    'RUT': 'RUT', 'NDX': 'NDX', 'DXY': 'DXY', 'GOLD': 'GLD',
    'OIL': 'USO', 'VIX': 'VIX',
}

print("\n" + "="*70)
print("🔍 HEDGEYE SCRAPER")
print("="*70 + "\n")

# Load cookies
if not COOKIE_FILE.exists():
    print("❌ No cookies found! Run: python3 extract_hedgeye_cookies.py")
    sys.exit(1)

with open(COOKIE_FILE) as f:
    raw_cookies = json.load(f)

# Convert cookies to Playwright format
cookies = []
for c in raw_cookies:
    # Extract domain from URL
    if 'url' in c:
        domain = c['url'].replace('https://', '').replace('http://', '').split('/')[0]
    else:
        domain = c.get('domain', '.hedgeye.com')

    cookie = {
        'name': c['name'],
        'value': c['value'],
        'domain': domain,
        'path': c.get('path', '/'),
        'httpOnly': c.get('httpOnly', False),
        'secure': c.get('secure', False),
        'sameSite': c.get('sameSite', 'Lax')
    }

    # Handle expires - must be float (Unix timestamp)
    if 'expires' in c and c['expires']:
        if isinstance(c['expires'], (int, float)):
            cookie['expires'] = float(c['expires'])

    cookies.append(cookie)

print(f"✅ Loaded {len(cookies)} cookies\n")

risk_data = {}

with sync_playwright() as p:
    print("🚀 Launching browser...")
    browser = p.chromium.launch(headless=False)
    context = browser.new_context(viewport={'width': 1920, 'height': 1080})
    page = context.new_page()

    try:
        # Navigate to homepage first (required to set cookies on correct domain)
        print("🌐 Navigating to Hedgeye homepage...")
        page.goto("https://app.hedgeye.com", timeout=60000)
        page.wait_for_timeout(2000)

        # Set cookies
        print("🍪 Setting cookies...")
        context.add_cookies(cookies)

        # Reload to apply cookies
        page.reload(wait_until='domcontentloaded')
        page.wait_for_timeout(2000)

        # Navigate to risk ranges
        print(f"🌐 Navigating to Risk Range Signals...\n")
        page.goto(URL, timeout=60000, wait_until='domcontentloaded')

        # Wait for content
        page.wait_for_timeout(5000)

        # Check login
        if "sign_in" in page.url:
            print("❌ Not logged in - cookies may have expired")
            sys.exit(1)

        # Check Cloudflare
        content = page.content()
        if "Just a moment" in content:
            print("⏳ Cloudflare detected - waiting...")
            for i in range(30):
                page.wait_for_timeout(3000)
                if "Just a moment" not in page.content() and "feed_items" in page.url:
                    print(f"✅ Cloudflare passed ({i*3}s)\n")
                    break
                if i % 5 == 0 and i > 0:
                    print(f"   ...{i*3}s")

        # Wait for table
        print("📊 Looking for data table...")
        try:
            page.wait_for_selector('table', timeout=15000)
            print("✅ Table found\n")
        except:
            print("⚠️  No table found\n")

        # Screenshot
        timestamp = datetime.now(timezone.utc)
        date_str = timestamp.strftime('%Y-%m-%d')
        time_str = timestamp.strftime('%H%M%S')
        screenshot = SCRIPT_DIR / f"hedgeye_screenshot_{date_str}_{time_str}.png"

        print("📸 Taking screenshot...")
        page.screenshot(path=str(screenshot), full_page=True)
        print(f"✅ Saved: {screenshot.name}\n")

        # Extract HTML
        print("📄 Extracting data...")
        html = page.content()
        soup = BeautifulSoup(html, 'html.parser')

        # Parse table
        for table in soup.find_all('table'):
            headers = [h.get_text(strip=True).upper() for h in table.find_all('th')]

            if 'BUY TRADE' in headers and 'SELL TRADE' in headers:
                print("✅ Found Risk Range table!\n")

                idx_col = headers.index('INDEX')
                buy_col = headers.index('BUY TRADE')
                sell_col = headers.index('SELL TRADE')

                for row in table.find_all('tr')[1:]:
                    cells = row.find_all(['td', 'th'])
                    if len(cells) <= max(idx_col, buy_col, sell_col):
                        continue

                    try:
                        index = cells[idx_col].get_text(strip=True)
                        buy = cells[buy_col].get_text(strip=True).replace(',', '').replace('$', '').replace('%', '')
                        sell = cells[sell_col].get_text(strip=True).replace(',', '').replace('$', '').replace('%', '')

                        if not index or not buy or not sell:
                            continue

                        ticker = TICKER_MAP.get(index, index)
                        risk_data[ticker] = {
                            'lrr': float(buy),
                            'hrr': float(sell),
                            'original_name': index,
                            'timestamp': timestamp.isoformat()
                        }
                        print(f"   ✅ {ticker}: LRR={buy}, HRR={sell}")
                    except:
                        continue

                break

    finally:
        browser.close()

print(f"\n✅ Scraped {len(risk_data)} securities!\n")

if not risk_data:
    print("⚠️  No data extracted")
    sys.exit(1)

# Save JSON
json_file = SCRIPT_DIR / "hedgeye_risk_ranges.json"
with open(json_file, 'w') as f:
    json.dump({'scraped_at': timestamp.isoformat(), 'data': risk_data}, f, indent=2)
print(f"💾 Saved: {json_file.name}")

# Save CSV
csv_file = SCRIPT_DIR / f"hedgeye_risk_ranges_{date_str}.csv"
with open(csv_file, 'w') as f:
    f.write("ticker,lrr,hrr,original_name,timestamp\n")
    for ticker, data in risk_data.items():
        f.write(f"{ticker},{data['lrr']},{data['hrr']},{data['original_name']},{data['timestamp']}\n")
print(f"💾 Saved: {csv_file.name}")

# Upload to AWS
if BOTO3_AVAILABLE:
    print("\n☁️  Uploading to AWS...")
    try:
        s3 = boto3.client('s3', region_name='us-west-1')

        # Upload screenshot
        s3_screenshot = f"hedgeye-screenshots/{date_str}/risk-ranges-{date_str}-{time_str}.png"
        s3.upload_file(str(screenshot), 'market-dashboard-csv-data', s3_screenshot,
                      ExtraArgs={'ContentType': 'image/png'})
        print(f"   ✅ Screenshot uploaded")

        # Upload CSV
        s3_csv = f"hedgeye-exports/risk-ranges-{date_str}.csv"
        s3.upload_file(str(csv_file), 'market-dashboard-csv-data', s3_csv,
                      ExtraArgs={'ContentType': 'text/csv'})
        print(f"   ✅ CSV uploaded")

        # DynamoDB
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
        print(f"   ✅ {len(risk_data)} records saved to DynamoDB")

        # Snapshot
        snapshot_table = dynamodb.Table('HedgeyeDailySnapshot')
        snapshot_table.put_item(Item={
            'date': date_str,
            'snapshotType': 'risk-ranges',
            'riskRangeCount': len(risk_data),
            'data': {ticker: {'lrr': float(data['lrr']), 'hrr': float(data['hrr']),
                             'timestamp': data['timestamp']} for ticker, data in risk_data.items()},
            'scrapedAt': timestamp.isoformat(),
            'screenshotS3Key': s3_screenshot,
            'csvS3Key': s3_csv,
            'ttl': int(timestamp.timestamp() + (730 * 24 * 60 * 60))
        })
        print(f"   ✅ Snapshot saved")

        print("\n🎉 ALL DONE! Check your dashboard.")

    except Exception as e:
        print(f"\n⚠️  AWS error: {e}")
        print("   Data saved locally only")
else:
    print("\n⚠️  boto3 not available - data saved locally only")

print("\n" + "="*70 + "\n")
