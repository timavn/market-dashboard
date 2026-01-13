#!/usr/bin/env python3
"""
SIMPLE: Extract data from the CURRENTLY OPEN Chrome page
You manually navigate to the risk range page, then run this.
"""

import json
import sqlite3
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path

from bs4 import BeautifulSoup
import boto3

# Chrome history database path
CHROME_PROFILE = Path.home() / "Library/Application Support/Google/Chrome/Profile 2"
HISTORY_DB = CHROME_PROFILE / "History"

DIR = Path(__file__).parent

TICKERS = {
    'UST30Y': 'UST30Y', 'UST10Y': 'UST10Y', 'UST2Y': 'UST2Y',
    'HYG': 'HYG', 'LQD': 'LQD', 'SPX': 'SPX', 'COMPQ': 'COMPQ',
    'RUT': 'RUT', 'NDX': 'NDX', 'DXY': 'DXY', 'GOLD': 'GLD',
    'OIL': 'USO', 'VIX': 'VIX',
}

print("\n" + "="*70)
print("📋 COPY-PASTE THE PAGE HTML")
print("="*70)
print("\nIn Chrome:")
print("1. Navigate to: https://app.hedgeye.com/feed_items/all?page=1&with_category=33-risk-range-signals")
print("2. Right-click → Inspect")
print("3. In DevTools, right-click <html> → Copy → Copy outerHTML")
print("4. Paste below and press Ctrl+D")
print("\n" + "="*70 + "\n")

print("Paste HTML and press Ctrl+D when done:")
lines = []
try:
    while True:
        lines.append(input())
except EOFError:
    pass

html = '\n'.join(lines)

if not html or len(html) < 100:
    print("\n❌ No HTML provided")
    exit(1)

print(f"\n✅ Got {len(html)} characters\n")

# Parse
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

if not data:
    print("\n❌ No data found")
    exit(1)

print(f"\n✅ Extracted {len(data)} securities\n")

# Save to DynamoDB
print("☁️  Saving to AWS...")
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

print(f"✅ Saved {len(data)} records to DynamoDB")
print("\n🎉 DONE! Check your dashboard.\n")
