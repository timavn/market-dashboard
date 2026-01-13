#!/usr/bin/env python3
"""
FINAL SOLUTION: Uses Chrome's "Save Page" feature
"""

import subprocess
import time
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path

from bs4 import BeautifulSoup
import boto3

URL = "https://app.hedgeye.com/feed_items/all?page=1&with_category=33-risk-range-signals"

TICKERS = {
    'UST30Y': 'UST30Y', 'UST10Y': 'UST10Y', 'UST2Y': 'UST2Y',
    'HYG': 'HYG', 'LQD': 'LQD', 'SPX': 'SPX', 'COMPQ': 'COMPQ',
    'RUT': 'RUT', 'NDX': 'NDX', 'DXY': 'DXY', 'GOLD': 'GLD',
    'OIL': 'USO', 'VIX': 'VIX',
}

print("\n" + "="*70)
print("🚀 HEDGEYE SCRAPER - Chrome Save Page Method")
print("="*70 + "\n")

# Navigate to page
print("🌐 Navigating YOUR Chrome to Risk Range Signals...")
nav_script = f'''
tell application "Google Chrome"
    activate
    set URL of active tab of first window to "{URL}"
end tell
'''
subprocess.run(['osascript', '-e', nav_script])

print("⏳ Waiting 10 seconds for page to load...")
time.sleep(10)

# Save page using Cmd+S
print("💾 Saving page...")
save_script = '''
tell application "System Events"
    tell process "Google Chrome"
        keystroke "s" using command down
        delay 1
        keystroke return
        delay 2
    end tell
end tell
'''
subprocess.run(['osascript', '-e', save_script])

# Wait for file to be saved
time.sleep(3)

# Find the downloaded file (should be in ~/Downloads)
downloads = Path.home() / "Downloads"
files = list(downloads.glob("*Risk Range Signals*.html")) + list(downloads.glob("feed_items*.html"))

if not files:
    print("❌ Could not find saved HTML file in Downloads")
    print(f"   Check {downloads} for the file")
    exit(1)

# Get most recent file
html_file = max(files, key=lambda p: p.stat().st_mtime)
print(f"✅ Found: {html_file.name}\n")

# Read HTML
with open(html_file, 'r', encoding='utf-8') as f:
    html = f.read()

print(f"📊 Parsing {len(html)} characters...")
soup = BeautifulSoup(html, 'html.parser')
ts = datetime.now(timezone.utc)
date = ts.strftime('%Y-%m-%d')
data = {}

for table in soup.find_all('table'):
    hdrs = [h.get_text(strip=True).upper() for h in table.find_all('th')]

    if 'BUY TRADE' in hdrs and 'SELL TRADE' in hdrs:
        print("✅ Found Risk Range table!\n")

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
                print(f"   {ticker}: {lrr} - {hrr}")
            except:
                continue
        break

# Clean up downloaded file
html_file.unlink()

if not data:
    print("\n❌ No data extracted")
    exit(1)

print(f"\n✅ Extracted {len(data)} securities\n")

# Save to DynamoDB
print("☁️  Saving to DynamoDB...")
db = boto3.resource('dynamodb', region_name='us-west-1')

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

snap = db.Table('HedgeyeDailySnapshot')
snap.put_item(Item={
    'date': date,
    'snapshotType': 'risk-ranges',
    'riskRangeCount': len(data),
    'data': {t: {'lrr': float(d['lrr']), 'hrr': float(d['hrr']),
                'timestamp': d['ts']} for t, d in data.items()},
    'scrapedAt': ts.isoformat(),
    'ttl': int(ts.timestamp() + (730 * 24 * 60 * 60))
})

print(f"✅ Saved {len(data)} records")
print("\n🎉 SUCCESS! Check your dashboard.\n")
print("="*70 + "\n")
