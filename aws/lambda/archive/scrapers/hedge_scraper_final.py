#!/usr/bin/env python3
"""
THE SOLUTION: Manual login once, then automated scraping

1. Run this script
2. Browser opens - YOU log into Hedgeye manually (solve CAPTCHA)
3. Press ENTER in terminal
4. Script scrapes all pages automatically
5. Data saved to DynamoDB/S3
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
    AWS = True
except:
    AWS = False

DIR = Path(__file__).parent
URL = "https://app.hedgeye.com/feed_items/all?page=1&with_category=33-risk-range-signals"

TICKERS = {
    'UST30Y': 'UST30Y', 'UST10Y': 'UST10Y', 'UST2Y': 'UST2Y',
    'HYG': 'HYG', 'LQD': 'LQD', 'SPX': 'SPX', 'COMPQ': 'COMPQ',
    'RUT': 'RUT', 'NDX': 'NDX', 'DXY': 'DXY', 'GOLD': 'GLD',
    'OIL': 'USO', 'VIX': 'VIX',
}

print("\n" + "="*70)
print("🚀 HEDGEYE SCRAPER - Final Solution")
print("="*70)
print("\n📋 Instructions:")
print("   1. Browser will open to Hedgeye")
print("   2. YOU log in manually (solve CAPTCHA)")
print("   3. Navigate to Risk Range Signals page")
print("   4. Script will scrape automatically after 60 seconds")
print("\n" + "="*70 + "\n")

with sync_playwright() as p:
    browser = p.chromium.launch(headless=False, args=['--start-maximized'])
    context = browser.new_context(viewport={'width': 1920, 'height': 1080})
    page = context.new_page()

    # Go to homepage
    print("🌐 Opening Hedgeye...")
    page.goto("https://app.hedgeye.com")

    print("\n⏸️  YOU HAVE 60 SECONDS:")
    print("   1. Log in (solve CAPTCHA)")
    print("   2. Navigate to Risk Range Signals page")
    print("   3. Wait for script to scrape...")

    # Wait 60 seconds for user to log in
    for i in range(12):
        page.wait_for_timeout(5000)
        print(f"   ...{(i+1)*5}s")

    print("\n🔍 Starting scrape...")

    # Now scrape
    print("\n🔍 Scraping Risk Range Signals...")
    page.goto(URL, timeout=60000)
    page.wait_for_timeout(5000)

    # Check if logged in
    if "sign_in" in page.url:
        print("\n❌ Still on login page! Log in first.")
        browser.close()
        sys.exit(1)

    # Screenshot
    ts = datetime.now(timezone.utc)
    date = ts.strftime('%Y-%m-%d')
    time = ts.strftime('%H%M%S')
    screenshot = DIR / f"hedgeye_screenshot_{date}_{time}.png"

    print("📸 Screenshot...")
    page.screenshot(path=str(screenshot), full_page=True)
    print(f"   ✅ {screenshot.name}")

    # Extract
    print("\n📊 Extracting data...")
    html = page.content()
    soup = BeautifulSoup(html, 'html.parser')

    data = {}
    for table in soup.find_all('table'):
        hdrs = [h.get_text(strip=True).upper() for h in table.find_all('th')]

        if 'BUY TRADE' in hdrs and 'SELL TRADE' in hdrs:
            print("   ✅ Found table!")

            ix = hdrs.index('INDEX')
            buy = hdrs.index('BUY TRADE')
            sell = hdrs.index('SELL TRADE')

            for row in table.find_all('tr')[1:]:
                cells = row.find_all(['td', 'th'])
                if len(cells) <= max(ix, buy, sell):
                    continue

                try:
                    name = cells[ix].get_text(strip=True)
                    lrr = cells[buy].get_text(strip=True).replace(',', '').replace('$', '').replace('%', '')
                    hrr = cells[sell].get_text(strip=True).replace(',', '').replace('$', '').replace('%', '')

                    if not name or not lrr or not hrr:
                        continue

                    ticker = TICKERS.get(name, name)
                    data[ticker] = {
                        'lrr': float(lrr),
                        'hrr': float(hrr),
                        'name': name,
                        'ts': ts.isoformat()
                    }
                    print(f"      {ticker}: {lrr} - {hrr}")
                except:
                    continue
            break

    browser.close()

if not data:
    print("\n❌ No data extracted!")
    sys.exit(1)

print(f"\n✅ Extracted {len(data)} securities")

# Save JSON
jfile = DIR / "hedgeye_risk_ranges.json"
with open(jfile, 'w') as f:
    json.dump({'ts': ts.isoformat(), 'data': data}, f, indent=2)
print(f"\n💾 JSON: {jfile.name}")

# Save CSV
cfile = DIR / f"hedgeye_risk_ranges_{date}.csv"
with open(cfile, 'w') as f:
    f.write("ticker,lrr,hrr,name,ts\n")
    for t, d in data.items():
        f.write(f"{t},{d['lrr']},{d['hrr']},{d['name']},{d['ts']}\n")
print(f"💾 CSV: {cfile.name}")

# AWS
if AWS:
    print("\n☁️  Uploading to AWS...")
    try:
        s3 = boto3.client('s3', region_name='us-west-1')

        # Screenshot
        skey = f"hedgeye-screenshots/{date}/risk-ranges-{date}-{time}.png"
        s3.upload_file(str(screenshot), 'market-dashboard-csv-data', skey,
                      ExtraArgs={'ContentType': 'image/png'})
        print("   ✅ Screenshot")

        # CSV
        ckey = f"hedgeye-exports/risk-ranges-{date}.csv"
        s3.upload_file(str(cfile), 'market-dashboard-csv-data', ckey,
                      ExtraArgs={'ContentType': 'text/csv'})
        print("   ✅ CSV")

        # DynamoDB
        db = boto3.resource('dynamodb', region_name='us-west-1')

        # Individual records
        tbl = db.Table('HedgeyeRiskRanges')
        for ticker, d in data.items():
            tbl.put_item(Item={
                'date': date,
                'ticker': ticker,
                'lrr': Decimal(str(d['lrr'])),
                'hrr': Decimal(str(d['hrr'])),
                'updatedAt': ts.isoformat(),
                'source': 'hedgeye',
                'ttl': int(ts.timestamp() + (730 * 24 * 60 * 60))
            })
        print(f"   ✅ {len(data)} records to DynamoDB")

        # Snapshot
        snap = db.Table('HedgeyeDailySnapshot')
        snap.put_item(Item={
            'date': date,
            'snapshotType': 'risk-ranges',
            'riskRangeCount': len(data),
            'data': {t: {'lrr': float(d['lrr']), 'hrr': float(d['hrr']),
                        'timestamp': d['ts']} for t, d in data.items()},
            'scrapedAt': ts.isoformat(),
            'screenshotS3Key': skey,
            'csvS3Key': ckey,
            'ttl': int(ts.timestamp() + (730 * 24 * 60 * 60))
        })
        print("   ✅ Snapshot")

        print("\n🎉 SUCCESS! Check your dashboard.")
    except Exception as e:
        print(f"\n⚠️  AWS error: {e}")
else:
    print("\n⚠️  boto3 not available")

print("\n" + "="*70 + "\n")
