#!/usr/bin/env python3
"""
THE REAL SOLUTION: Control your ACTUAL Chrome browser via AppleScript
Prerequisites: You must be logged into Hedgeye in Chrome
"""

import subprocess
import time
from datetime import datetime, timezone
from decimal import Decimal

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
print("🚀 HEDGEYE SCRAPER - Using YOUR Chrome")
print("="*70 + "\n")

# Navigate Chrome to the page
print("🌐 Navigating YOUR Chrome to Risk Range Signals...")
script = f'''
tell application "Google Chrome"
    activate
    set URL of active tab of first window to "{URL}"
end tell
'''
subprocess.run(['osascript', '-e', script])

print("⏳ Waiting 10 seconds for page to load...")
time.sleep(10)

# Get the HTML from the page using JavaScript and clipboard
print("📄 Extracting HTML from Chrome...")
copy_html_script = '''
tell application "Google Chrome"
    execute active tab of first window javascript "
        var html = document.documentElement.outerHTML;
        var textarea = document.createElement('textarea');
        textarea.value = html;
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
    "
end tell
'''
subprocess.run(['osascript', '-e', copy_html_script])
time.sleep(1)

# Get HTML from clipboard
get_clipboard = 'osascript -e "the clipboard"'
result = subprocess.run(get_clipboard, shell=True, capture_output=True, text=True)
html = result.stdout.strip()

if not html or len(html) < 1000:
    print(f"❌ Failed to get HTML (got {len(html)} chars)")
    print("Make sure you're logged into Hedgeye in Chrome!")
    exit(1)

print(f"✅ Got {len(html)} characters\n")

# Parse
print("📊 Parsing data...")
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
            except Exception as e:
                continue
        break

if not data:
    print("\n❌ No data extracted")
    # Save HTML for debugging
    from pathlib import Path
    debug_file = Path(__file__).parent / "hedgeye_debug.html"
    with open(debug_file, 'w', encoding='utf-8') as f:
        f.write(html)
    print(f"   Saved HTML to: {debug_file}")
    print("   Check if you're logged into Hedgeye and on the risk range page")
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
