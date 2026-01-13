#!/usr/bin/env python3
"""
Manual data entry helper - extracts data from Hedgeye screenshots
Since PDFs are web-printed and don't have extractable tables,
this script helps manually enter data while keeping PDFs for audit
"""

from datetime import datetime, timezone
from decimal import Decimal
import boto3

# Based on your screenshots from 2026-01-09

BITCOIN_TRACKER_DATA = {
    'cryptos': {
        'BTC': {'price': 90303, 'buyTrade': 88104, 'sellTrade': 104978, 'trend': 'NEUTRAL'},
        'ETH': {'price': 3082, 'buyTrade': 2975, 'sellTrade': 3300, 'trend': 'NEUTRAL'},
        'SOL': {'price': 137.45, 'buyTrade': 126, 'sellTrade': 147, 'trend': 'NEUTRAL'},
        'AVAX': {'price': 13.70, 'buyTrade': 12.91, 'sellTrade': 15.54, 'trend': 'BULLISH'},
        'XRP': {'price': 2.09, 'buyTrade': 1.94, 'sellTrade': 2.33, 'trend': 'BULLISH'},
        'ZEC': {'price': 434.25, 'buyTrade': 400, 'sellTrade': 542, 'trend': 'BULLISH'},
    },
    'stocks': {
        'IBIT': {'price': 51.52, 'buyTrade': 48.43, 'sellTrade': 53.73, 'upside': 4.3, 'downside': -6.0, 'trend': 'NEUTRAL'},
        'MSTR': {'price': 167, 'buyTrade': 148, 'sellTrade': 172, 'upside': 3.0, 'downside': -11.4, 'trend': 'BEARISH'},
        'MARA': {'price': 10.44, 'buyTrade': 8.74, 'sellTrade': 10.93, 'upside': 4.7, 'downside': -16.3, 'trend': 'BEARISH'},
        'ETHA': {'price': 23.45, 'buyTrade': 21.11, 'sellTrade': 25.22, 'upside': 7.5, 'downside': -10.0, 'trend': 'NEUTRAL'},
        'BLOK': {'price': 61.71, 'buyTrade': 56.80, 'sellTrade': 63.99, 'upside': 3.7, 'downside': -8.0, 'trend': 'NEUTRAL'},
        'COIN': {'price': 245.59, 'buyTrade': 222, 'sellTrade': 256, 'upside': 4.2, 'downside': -9.6, 'trend': 'BEARISH'},
        'CRCL': {'price': 81.79, 'buyTrade': 76, 'sellTrade': 88, 'upside': 7.6, 'downside': -7.1, 'trend': 'NEUTRAL'},
        'BMNR': {'price': 31.28, 'buyTrade': 25.81, 'sellTrade': 34.44, 'upside': 10.1, 'downside': -17.5, 'trend': 'BEARISH'},
    }
}

MOMO_TRACKER_DATA = {
    'MSFT': {'buyTrade': 468, 'sellTrade': 488, 'upside': 2.07, 'downside': -2.1, 'trend': 'BEARISH'},
    'AAPL': {'buyTrade': 254, 'sellTrade': 268, 'upside': 3.46, 'downside': -1.9, 'trend': 'BEARISH'},
    'AMZN': {'buyTrade': 234, 'sellTrade': 249, 'upside': 1.10, 'downside': -5.0, 'trend': 'BULLISH'},
    'META': {'buyTrade': 641, 'sellTrade': 660, 'upside': 2.16, 'downside': -0.8, 'trend': 'BEARISH'},
    'GOOGL': {'buyTrade': 311, 'sellTrade': 329, 'upside': 1.09, 'downside': -4.4, 'trend': 'BULLISH'},
    'NFLX': {'buyTrade': 88, 'sellTrade': 95, 'upside': 4.94, 'downside': -2.8, 'trend': 'BEARISH'},
    'TSLA': {'buyTrade': 418, 'sellTrade': 459, 'upside': 5.32, 'downside': -4.1, 'trend': 'BEARISH'},
    'NVDA': {'buyTrade': 183, 'sellTrade': 192, 'upside': 3.76, 'downside': -1.1, 'trend': 'BULLISH'},
    'ORCL': {'buyTrade': 186, 'sellTrade': 198, 'upside': 4.40, 'downside': -1.9, 'trend': 'BEARISH'},
}

PORTFOLIO_SOLUTIONS_DATA = {
    'topMovers': {
        'weekly': [
            {'ticker': 'CPER', 'change': 14},
            {'ticker': 'SLX', 'change': 12},
            {'ticker': 'HYG', 'change': 10},
            {'ticker': 'LIT', 'change': 7},
            {'ticker': 'XLI', 'change': 5},
        ],
        'monthly': [
            {'ticker': 'CPER', 'change': 13},
            {'ticker': 'QQQ', 'change': 11},
            {'ticker': 'SLX', 'change': 11},
            {'ticker': 'HBDC', 'change': 5},
            {'ticker': 'EIS', 'change': 5},
        ]
    },
    'bottomMovers': {
        'weekly': [
            {'ticker': 'PINK', 'change': -13},
            {'ticker': 'KRE', 'change': -10},
            {'ticker': 'IWM', 'change': -8},
            {'ticker': 'XLV', 'change': -5},
            {'ticker': 'UFO', 'change': -5},
        ],
        'monthly': [
            {'ticker': 'PALL', 'change': -16},
            {'ticker': 'XLV', 'change': -13},
            {'ticker': 'PINK', 'change': -13},
            {'ticker': 'PPLT', 'change': -5},
            {'ticker': 'GDX', 'change': -4},
        ]
    },
    'rankings': [
        {'rank': 1, 'ticker': 'FDRXX', 'weekChange': 0, 'monthChange': 0, 'dateAdded': None, 'assetClass': 'Cash', 'minSize': 0, 'maxSize': 100},
        {'rank': 2, 'ticker': 'CLOX', 'weekChange': 0, 'monthChange': 1, 'dateAdded': '3/6/2025', 'assetClass': 'Fixed Income', 'minSize': 3, 'maxSize': 10},
        {'rank': 3, 'ticker': 'BUXX', 'weekChange': 0, 'monthChange': -1, 'dateAdded': '10/16/2023', 'assetClass': 'Fixed Income', 'minSize': 3, 'maxSize': 10},
        # Add more as needed
    ]
}

SIGNAL_STRENGTH_DATA = {
    'added': ['SNAP', 'UBER', 'DASH'],  # Example - update with actual
    'removed': ['BAC', 'WFC', 'JPM', 'GS', 'MS', 'C', 'USB', 'PNC', 'TFC', 'SCHW', 'BK'],  # Example
    'stocks': []  # Full list of 79 stocks
}


def save_bitcoin_tracker():
    """Save Bitcoin Tracker data to DynamoDB"""
    db = boto3.resource('dynamodb', region_name='us-west-1')
    date = datetime.now(timezone.utc).strftime('%Y-%m-%d')
    ts = datetime.now(timezone.utc).isoformat()

    s3_key = f"hedgeye/bitcoin-trend-tracker/{date}/bitcoin-trend-tracker-{date}-manual.pdf"

    snap_table = db.Table('HedgeyeDailySnapshot')
    snapshot_item = {
        'date': date,
        'snapshotType': 'bitcoin-trend-tracker',
        'cryptoCount': len(BITCOIN_TRACKER_DATA['cryptos']),
        'stockCount': len(BITCOIN_TRACKER_DATA['stocks']),
        'data': {
            'cryptos': {k: {
                'price': Decimal(str(v['price'])),
                'buyTrade': Decimal(str(v['buyTrade'])),
                'sellTrade': Decimal(str(v['sellTrade'])),
                'trend': v['trend'],
                'timestamp': ts
            } for k, v in BITCOIN_TRACKER_DATA['cryptos'].items()},
            'stocks': {k: {
                'price': Decimal(str(v['price'])),
                'buyTrade': Decimal(str(v['buyTrade'])),
                'sellTrade': Decimal(str(v['sellTrade'])),
                'upside': Decimal(str(v['upside'])),
                'downside': Decimal(str(v['downside'])),
                'trend': v['trend'],
                'timestamp': ts
            } for k, v in BITCOIN_TRACKER_DATA['stocks'].items()}
        },
        'scrapedAt': ts,
        'source': 'manual',
        'pdfSource': s3_key,
        'ttl': int(datetime.now(timezone.utc).timestamp() + (730 * 24 * 60 * 60))
    }

    snap_table.put_item(Item=snapshot_item)
    print(f"✅ Saved Bitcoin Tracker: {len(BITCOIN_TRACKER_DATA['cryptos'])} cryptos, {len(BITCOIN_TRACKER_DATA['stocks'])} stocks")


def save_momo_tracker():
    """Save Momo Tracker data to DynamoDB"""
    db = boto3.resource('dynamodb', region_name='us-west-1')
    date = datetime.now(timezone.utc).strftime('%Y-%m-%d')
    ts = datetime.now(timezone.utc).isoformat()

    s3_key = f"hedgeye/momo-tracker/{date}/momo-tracker-{date}-manual.pdf"

    snap_table = db.Table('HedgeyeDailySnapshot')
    snapshot_item = {
        'date': date,
        'snapshotType': 'momo-tracker',
        'stockCount': len(MOMO_TRACKER_DATA),
        'data': {t: {
            'buyTrade': Decimal(str(d['buyTrade'])),
            'sellTrade': Decimal(str(d['sellTrade'])),
            'upside': Decimal(str(d['upside'])),
            'downside': Decimal(str(d['downside'])),
            'trend': d['trend'],
            'timestamp': ts
        } for t, d in MOMO_TRACKER_DATA.items()},
        'scrapedAt': ts,
        'source': 'manual',
        'pdfSource': s3_key,
        'ttl': int(datetime.now(timezone.utc).timestamp() + (730 * 24 * 60 * 60))
    }

    snap_table.put_item(Item=snapshot_item)
    print(f"✅ Saved Momo Tracker: {len(MOMO_TRACKER_DATA)} stocks")


def save_portfolio_solutions():
    """Save Portfolio Solutions data to DynamoDB"""
    db = boto3.resource('dynamodb', region_name='us-west-1')
    date = datetime.now(timezone.utc).strftime('%Y-%m-%d')
    ts = datetime.now(timezone.utc).isoformat()

    s3_key = f"hedgeye/portfolio-solutions/{date}/portfolio-solutions-{date}-manual.pdf"

    snap_table = db.Table('HedgeyeDailySnapshot')
    snapshot_item = {
        'date': date,
        'snapshotType': 'portfolio-solutions',
        'rankingCount': len(PORTFOLIO_SOLUTIONS_DATA['rankings']),
        'data': PORTFOLIO_SOLUTIONS_DATA,
        'scrapedAt': ts,
        'source': 'manual',
        'pdfSource': s3_key,
        'ttl': int(datetime.now(timezone.utc).timestamp() + (730 * 24 * 60 * 60))
    }

    snap_table.put_item(Item=snapshot_item)
    print(f"✅ Saved Portfolio Solutions: {len(PORTFOLIO_SOLUTIONS_DATA['rankings'])} rankings")


if __name__ == '__main__':
    print("\n" + "="*70)
    print("🚀 MANUAL DATA ENTRY - Saving screenshot data to DynamoDB")
    print("="*70 + "\n")

    save_bitcoin_tracker()
    save_momo_tracker()
    save_portfolio_solutions()

    print("\n🎉 All data saved!\n")
