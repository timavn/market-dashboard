#!/usr/bin/env python3
"""
HTTP-based scraper using requests + cookies (no browser automation)
Run: python3 extract_hedgeye_cookies.py first
Then: python3 hedgeye_requests_scraper.py
"""

import json
import sys
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path

import requests
from bs4 import BeautifulSoup

try:
    import boto3
    AWS = True
except:
    AWS = False

DIR = Path(__file__).parent
COOKIE_FILE = DIR / "hedgeye_cookies.json"
URL = "https://app.hedgeye.com/feed_items/all?page=1&with_category=33-risk-range-signals"

TICKERS = {
    'UST30Y': 'UST30Y', 'UST10Y': 'UST10Y', 'UST2Y': 'UST2Y',
    'HYG': 'HYG', 'LQD': 'LQD', 'SPX': 'SPX', 'COMPQ': 'COMPQ',
    'RUT': 'RUT', 'NDX': 'NDX', 'DXY': 'DXY', 'GOLD': 'GLD',
    'OIL': 'USO', 'VIX': 'VIX',
}

print("\n" + "="*70)
print("🔍 HEDGEYE SCRAPER (HTTP requests)")
print("="*70 + "\n")

# Load cookies
if not COOKIE_FILE.exists():
    print("❌ No cookies! Run: python3 extract_hedgeye_cookies.py")
    sys.exit(1)

with open(COOKIE_FILE) as f:
    raw_cookies = json.load(f)

# Convert to requests format
cookies = {}
for c in raw_cookies:
    cookies[c['name']] = c['value']

print(f"✅ Loaded {len(cookies)} cookies\n")

# Make request
print(f"🌐 Fetching {URL}...")
headers = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    'Accept': 'text/html,application/xhtml+xml',
}

response = requests.get(URL, cookies=cookies, headers=headers, timeout=30)

if response.status_code != 200:
    print(f"❌ HTTP {response.status_code}")
    sys.exit(1)

if "sign_in" in response.url:
    print("❌ Redirected to login - cookies expired")
    sys.exit(1)

print(f"✅ HTTP 200 ({len(response.text)} bytes)\n")

# Check Cloudflare
if "Just a moment" in response.text or "challenge" in response.text.lower():
    print("❌ Cloudflare blocked the request")
    print("   HTTP requests don't bypass Cloudflare")
    sys.exit(1)

# Parse
print("📊 Parsing HTML...")
soup = BeautifulSoup(response.text, 'html.parser')

ts = datetime.now(timezone.utc)
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
    print("\n❌ No data extracted")
    # Save HTML for debugging
    debug = DIR / "hedgeye_debug.html"
    with open(debug, 'w') as f:
        f.write(response.text)
    print(f"   Saved HTML: {debug}")
    sys.exit(1)

print(f"\n✅ Extracted {len(data)} securities\n")

# Save JSON
jfile = DIR / "hedgeye_risk_ranges.json"
with open(jfile, 'w') as f:
    json.dump({'ts': ts.isoformat(), 'data': data}, f, indent=2)
print(f"💾 JSON: {jfile.name}")

# Save CSV
date = ts.strftime('%Y-%m-%d')
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
            'ttl': int(ts.timestamp() + (730 * 24 * 60 * 60))
        })
        print("   ✅ Snapshot")

        print("\n🎉 SUCCESS! Check your dashboard.")
    except Exception as e:
        print(f"\n⚠️  AWS error: {e}")

print("\n" + "="*70 + "\n")
