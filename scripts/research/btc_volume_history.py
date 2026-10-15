#!/usr/bin/env python3
"""Archived reported spot volume and lagged, complete-day Bitcoin features."""
from __future__ import annotations

import argparse
from collections import defaultdict
from datetime import datetime, timedelta, timezone
import gzip
import hashlib
import json
import math
import re
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from btc_price_history import Downloader, write_json
from btc_usd_features import instant, iso, rejected_provenance

ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / 'artifacts/btc-five-year-study/source-volume'
BASE_URL = 'https://community-api.coinmetrics.io'
METRIC = 'volume_reported_spot_usd_1d'
FILTERS = [{'id': 'all', 'label': 'All volume'},
           {'id': 'below_15d', 'label': 'Below 15-day average'},
           {'id': 'at_or_above_15d', 'label': 'At or above 15-day average'}]
DAY = timedelta(days=1)
METHOD = [
    'Volume is Coin Metrics exchange-reported Bitcoin spot turnover in USD across covered markets; it is not total market activity or perpetual/ETF volume.',
    'Below average means the latest completed UTC day is strictly below the average of its preceding 15 completed UTC days, including weekends. The evaluated day is excluded from its own average.',
    'A UTC volume day becomes usable one hour after its following midnight. Missing days or lookback inputs remain unavailable; no older observation is carried forward.',
    'Historical volumes are the latest retrieved vintage. Original publication and revision timestamps are unavailable, so this proxy does not reproduce an exact historical live feed.',
    'Sensitivity checks use one additional day of lag and Coinbase BTC-USD spot volume in BTC with the same complete UTC-day rule. These checks keep the fixed 15-day threshold.',
]


def valid_volume(value):
    return not isinstance(value, bool) and isinstance(value, (int, float)) and math.isfinite(value) and value >= 0


def unverified(row):
    return (rejected_provenance(row)
            or any(str(row.get(k, '')).lower() == 'true' for k in ('mock', 'isMock', 'seeded', 'synthetic', 'inferred', 'portfolioDerived', 'stale', 'isStale', 'cacheOnly', 'cache_only'))
            or row.get('connected') is False or row.get('providerConnected') is False
            or any(str(row.get(k, '')).lower() in ('offline', 'disconnected', 'error', 'failed', 'stale', 'cache-only', 'cache_only') for k in ('providerStatus', 'status')))


def normalize(records, source='Coin Metrics', metric=METRIC, unit='USD'):
    candidates, rejected = defaultdict(list), []
    for item in records:
        try:
            timestamp = item.get('time') or item['startAt']
            # Provider uses nanosecond formatting; only zero fractional UTC midnight is valid.
            timestamp = re.sub(r'\.0+Z$', 'Z', timestamp)
            at = instant(timestamp)
            if at != at.replace(hour=0, minute=0, second=0, microsecond=0):
                raise ValueError('Volume day must start at UTC midnight')
            if item.get('asset', 'btc') != 'btc' or unverified(item):
                raise ValueError('Unverified Bitcoin volume')
            value = item.get(metric, item.get('volume'))
            if isinstance(value, bool) or value is None:
                raise ValueError('Missing volume')
            value = float(value)
            if not valid_volume(value) or not item.get('rawResponses'):
                raise ValueError('Invalid volume or missing original source')
            candidates[iso(at)].append({'startAt': iso(at), 'endAt': iso(at + DAY), 'date': at.date().isoformat(),
                'volume': value, 'source': source, 'metric': metric, 'unit': unit,
                'rawResponses': item['rawResponses'], 'historical': True, 'executable': False})
        except (ValueError, KeyError, TypeError) as error:
            rejected.append({'time': item.get('time') or item.get('startAt'), 'reason': str(error)})
    accepted = []
    for at, rows in sorted(candidates.items()):
        if len(rows) != 1:
            rejected.append({'time': at, 'reason': 'Duplicate volume day'})
        else:
            accepted.append(rows[0])
    return accepted, rejected


def verify_archive(archive):
    """Rebuild the normalized series from immutable, hashed original responses."""
    manifest = json.loads((archive / 'fetch-manifest.json').read_text())
    records = []
    for meta in manifest['requests']:
        if meta['provider'] != 'coinmetrics' or meta['httpStatus'] != 200:
            raise ValueError('Unverified volume response')
        parsed = urlparse(meta['url'])
        query = parse_qs(parsed.query)
        if (parsed.scheme != 'https' or parsed.netloc != 'community-api.coinmetrics.io'
                or parsed.path != '/v4/timeseries/asset-metrics'
                or query.get('assets') != ['btc'] or query.get('metrics') != [METRIC]
                or query.get('frequency') != ['1d']):
            raise ValueError('Wrong volume endpoint')
        path = (archive / meta['rawResponse']).resolve()
        if not path.is_relative_to(archive.resolve()):
            raise ValueError('Invalid volume archive path')
        body = gzip.decompress(path.read_bytes())
        saved_metadata = json.loads(path.with_suffix('.metadata.json').read_text())
        if (hashlib.sha256(body).hexdigest() != meta['sha256']
                or any(saved_metadata.get(k) != meta.get(k) for k in ('sha256', 'url', 'httpStatus', 'provider', 'retrievedAt', 'rawResponse'))):
            raise ValueError('Volume archive hash mismatch')
        records += [{**r, 'rawResponses': [meta['rawResponse']]} for r in json.loads(body)['data']]
    rows, rejected = normalize(records)
    recorded = json.loads((archive / 'daily.json').read_text())
    rows = [r for r in rows if instant(r['endAt']) <= instant(recorded['endAt'])]
    if rows != recorded['rows'] or rejected != recorded['rejected']:
        raise ValueError('Normalized volume differs from original response')
    return recorded


def coinbase_days(candles):
    """Require all 96 verified 15-minute observations for each UTC day."""
    groups = defaultdict(list)
    for candle in candles:
        groups[instant(candle['startAt']).date().isoformat()].append(candle)
    output = []
    for day, rows in sorted(groups.items()):
        rows = sorted(rows, key=lambda r: r['startAt'])
        start = instant(day + 'T00:00:00Z')
        if len(rows) != 96:
            continue
        if any(instant(r['startAt']) != start + timedelta(minutes=15*i)
               or instant(r['endAt']) != start + timedelta(minutes=15*(i+1))
               or unverified(r) or not valid_volume(r.get('volume'))
               or not (r.get('rawResponse') or r.get('rawResponses')) for i, r in enumerate(rows)):
            continue
        output.append({'startAt': iso(start), 'volume': math.fsum(r['volume'] for r in rows),
                       'rawResponses': sorted({p for r in rows for p in (r.get('rawResponses') or [r['rawResponse']])})})
    return normalize(output, 'Coinbase BTC-USD', 'spot_volume_btc_1d', 'BTC')[0]


class VolumeTimeline:
    def __init__(self, document):
        rows = document if isinstance(document, list) else document['rows']
        dates = [r['date'] for r in rows]
        if len(dates) != len(set(dates)):
            raise ValueError('Duplicate normalized volume day')
        self.rows = {r['date']: r for r in rows}

    def at(self, entry, lag_hours=1):
        if lag_hours not in (1, 25):
            raise ValueError('Only prespecified lag sensitivities are supported')
        at = instant(entry)
        evaluated = (at - timedelta(hours=lag_hours)).replace(hour=0, minute=0, second=0, microsecond=0) - DAY
        dates = [(evaluated - DAY*i).date().isoformat() for i in range(16)]
        rows = [self.rows.get(day) for day in dates]
        base = {'volumeClass': None, 'volumeDate': dates[0], 'volumeAvailableAt': iso(evaluated + DAY + timedelta(hours=lag_hours)),
                'volumeUsd': None, 'volumeAverage15': None, 'volumeRatio15': None,
                'volumeLookbackStart': dates[-1], 'volumeLookbackEnd': dates[1], 'volumeLagHours': lag_hours,
                'volumeExclusionReason': 'Incomplete volume day or preceding 15-day lookback'}
        if any(r is None or not valid_volume(r.get('volume')) or unverified(r) for r in rows):
            return base
        mean = math.fsum(r['volume'] for r in rows[1:]) / 15
        value = rows[0]['volume']
        return {**base, 'volumeClass': 'below_15d' if value < mean else 'at_or_above_15d',
                'volumeUsd': value, 'volumeAverage15': mean, 'volumeRatio15': value/mean if mean > 0 else None,
                'volumeExclusionReason': None, 'volumeSource': rows[0]['source'], 'volumeMetric': rows[0]['metric'],
                'volumeUnit': rows[0]['unit'], 'volumeVintage': 'latest_retrieved'}


def add_features(observations, primary, coinbase):
    output = []
    for row in observations:
        at = row['hourStart']
        base, delayed, venue = primary.at(at), primary.at(at, 25), coinbase.at(at)
        output.append({**row, **base, 'volumeAdditionalLagClass': delayed['volumeClass'],
                       'volumeCoinbaseClass': venue['volumeClass'], 'volumeCoinbaseBtc': venue['volumeUsd'],
                       'volumeCoinbaseAverage15': venue['volumeAverage15'],
                       'volumeCoinbaseDate': venue['volumeDate'], 'volumeAdditionalLagDate': delayed['volumeDate']})
    return output


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=OUTPUT)
    parser.add_argument('--start', default='2021-07-17')
    parser.add_argument('--end', default='2026-09-15')
    args = parser.parse_args()
    downloader = Downloader(args.output)
    params = {'assets': 'btc', 'metrics': METRIC, 'frequency': '1d', 'start_time': args.start,
              'end_time': args.end, 'page_size': 10000}
    records = []
    while True:
        doc, relative = downloader.get('coinmetrics', BASE_URL, '/v4/timeseries/asset-metrics', params)
        records += [{**r, 'rawResponses': [relative]} for r in doc['data']]
        if not doc.get('next_page_token'):
            break
        params['next_page_token'] = doc['next_page_token']
    rows, rejected = normalize(records)
    cutoff = instant(args.end + 'T00:00:00Z')
    # A response can include the still-forming last day. Preserve it raw, never classify it.
    rows = [r for r in rows if instant(r['endAt']) <= cutoff]
    document = {'source': 'Coin Metrics', 'metric': METRIC, 'unit': 'USD', 'dayTimeZone': 'UTC',
                'vintage': 'latest_retrieved', 'historicalPublicationTimes': None,
                'endAt': iso(cutoff), 'rows': rows, 'rejected': rejected, 'methodology': METHOD}
    write_json(args.output / 'daily.json', document)
    write_json(args.output / 'fetch-manifest.json', {'requests': downloader.requests, 'start': args.start, 'end': args.end})
    print(json.dumps({'days': len(rows), 'first': rows[0]['date'], 'last': rows[-1]['date'], 'rejected': rejected}))


if __name__ == '__main__':
    main()
