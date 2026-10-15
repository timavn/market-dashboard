#!/usr/bin/env python3
"""Archive genuine Yahoo DXY index bars for the separate BTC research experiment.

Only read-only public HTTP requests. No live dashboard imports or state changes.
Cached responses are immutable and content-hash verified on replay.
"""
from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, timedelta, timezone
import gzip
import hashlib
import json
import math
from pathlib import Path
import urllib.parse
import urllib.request
from zoneinfo import ZoneInfo


ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUT = ROOT / 'artifacts/btc-hourly-usd-experiment/source-usd'
DEFAULT_AS_OF = '2026-09-15T18:00:00Z'
DEFAULT_START = '2025-07-01T00:00:00Z'
DEFAULT_DAILY_START = '2024-07-01T00:00:00Z'
UTC = timezone.utc
ET = ZoneInfo('America/New_York')
SOURCE = 'yahoo_finance_chart_historical'


def dt(value):
    return datetime.fromisoformat(value.replace('Z', '+00:00')).astimezone(UTC)


def iso(value):
    return value.astimezone(UTC).isoformat(timespec='seconds').replace('+00:00', 'Z')


def finite_positive(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value > 0


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, allow_nan=False) + '\n')


def retrieve(symbol, interval, start, cutoff, out):
    params = urllib.parse.urlencode({
        'interval': interval, 'period1': int(start.timestamp()),
        'period2': int(cutoff.timestamp()), 'includePrePost': 'false',
    })
    url = f'https://query1.finance.yahoo.com/v8/finance/chart/{urllib.parse.quote(symbol)}?{params}'
    key = hashlib.sha256(url.encode()).hexdigest()[:20]
    raw_path = out / 'raw' / f'{symbol}-{interval}-{key}.json.gz'
    meta_path = raw_path.with_suffix('').with_suffix('.metadata.json')
    if raw_path.exists() or meta_path.exists():
        if not (raw_path.exists() and meta_path.exists()):
            raise RuntimeError(f'Incomplete cached response: {raw_path}')
        raw = gzip.decompress(raw_path.read_bytes())
        metadata = json.loads(meta_path.read_text())
        if metadata['url'] != url or metadata['sha256'] != hashlib.sha256(raw).hexdigest():
            raise RuntimeError(f'Cached response hash mismatch: {raw_path}')
    else:
        request = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(request, timeout=45) as response:
            raw = response.read()
            metadata = {
                'url': url, 'retrievedAt': iso(datetime.now(UTC)),
                'httpDate': response.headers.get('Date'), 'httpStatus': response.status,
                'contentType': response.headers.get('Content-Type'),
                'sha256': hashlib.sha256(raw).hexdigest(),
                'bytes': len(raw),
            }
        payload = json.loads(raw)
        if payload.get('chart', {}).get('error'):
            raise RuntimeError(payload['chart']['error'])
        raw_path.parent.mkdir(parents=True, exist_ok=True)
        raw_path.write_bytes(gzip.compress(raw, mtime=0))
        write_json(meta_path, metadata)
    return json.loads(raw), str(raw_path.relative_to(ROOT)), metadata


def retrieve_methodology(out, url, filename):
    path = out / 'raw' / filename
    meta_path = path.with_suffix('.metadata.json')
    if path.exists() or meta_path.exists():
        if not (path.exists() and meta_path.exists()):
            raise RuntimeError('Incomplete cached ICE methodology')
        metadata = json.loads(meta_path.read_text())
        if metadata['sha256'] != hashlib.sha256(path.read_bytes()).hexdigest():
            raise RuntimeError('Cached ICE methodology hash mismatch')
    else:
        with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'}), timeout=45) as response:
            raw = response.read()
            if not raw.startswith(b'%PDF'):
                raise RuntimeError('Expected official ICE methodology PDF')
            metadata = {'url': url, 'retrievedAt': iso(datetime.now(UTC)), 'httpDate': response.headers.get('Date'),
                        'httpStatus': response.status, 'sha256': hashlib.sha256(raw).hexdigest(), 'bytes': len(raw)}
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(raw)
        write_json(meta_path, metadata)
    return {'path': str(path.relative_to(ROOT)), **metadata}


def normalize(payload, symbol, interval, start, cutoff, raw_path):
    chart = payload.get('chart', {})
    if chart.get('error'):
        raise ValueError(chart['error'])
    results = chart.get('result') or []
    if len(results) != 1:
        raise ValueError('Expected exactly one provider series')
    result = results[0]
    metadata = result.get('meta', {})
    if metadata.get('symbol') != symbol:
        raise ValueError('Provider symbol mismatch')
    if symbol == 'DX-Y.NYB' and metadata.get('instrumentType') != 'INDEX':
        raise ValueError('DXY must be the index, not a futures or ETF proxy')
    expected_granularity = '1h' if interval == '60m' else '1d'
    if metadata.get('dataGranularity') != expected_granularity:
        raise ValueError('Provider granularity mismatch')
    quote = (result.get('indicators', {}).get('quote') or [{}])[0]
    tz = ZoneInfo(metadata['exchangeTimezoneName'])
    by_key, rejected, conflicts = {}, [], set()
    for index, timestamp in enumerate(result.get('timestamp') or []):
        if not isinstance(timestamp, (int, float)) or not math.isfinite(timestamp):
            rejected.append({'index': index, 'reason': 'invalid_timestamp'})
            continue
        when = datetime.fromtimestamp(timestamp, UTC)
        prices = {key: quote.get(key, [])[index] if index < len(quote.get(key, [])) else None
                  for key in ('open', 'high', 'low', 'close', 'volume')}
        common = {
            'symbol': symbol, 'providerTimestamp': timestamp,
            'source': SOURCE, 'rawResponse': raw_path, 'rawIndex': index,
            **prices,
        }
        if interval == '60m':
            end = when + timedelta(hours=1)
            if when.minute or when.second or when.microsecond:
                rejected.append({'index': index, 'startAt': iso(when), 'reason': 'non_hour_aligned'})
                continue
            if when < start or end > cutoff:
                rejected.append({'index': index, 'startAt': iso(when), 'reason': 'outside_completed_window'})
                continue
            if not all(finite_positive(prices[key]) for key in ('open', 'high', 'low', 'close')):
                rejected.append({'index': index, 'startAt': iso(when), 'reason': 'missing_or_invalid_ohlc'})
                continue
            if not prices['low'] <= min(prices['open'], prices['close']) <= max(prices['open'], prices['close']) <= prices['high']:
                rejected.append({'index': index, 'startAt': iso(when), 'reason': 'inconsistent_ohlc'})
                continue
            row = {'startAt': iso(when), 'endAt': iso(end), 'availableAt': iso(end), **common}
            key = row['startAt']
        else:
            day = when.astimezone(tz).date()
            # Yahoo timestamps label a daily bar's beginning, not when its close was known.
            # A conservative calendar-day end prevents including that day's future close.
            end = datetime.combine(day + timedelta(days=1), datetime.min.time(), tz)
            if when < start or end.astimezone(UTC) > cutoff:
                rejected.append({'index': index, 'date': str(day), 'reason': 'outside_completed_window'})
                continue
            if not finite_positive(prices['close']):
                rejected.append({'index': index, 'date': str(day), 'reason': 'missing_or_invalid_close'})
                continue
            row = {'date': str(day), 'startAt': iso(when), 'endAt': iso(end),
                   'availableAt': iso(end), **common}
            key = row['date']
        if key in by_key:
            if any(by_key[key][field] != row[field] for field in ('open', 'high', 'low', 'close', 'volume')):
                conflicts.add(key)
                rejected.append({'index': index, 'key': key, 'reason': 'conflicting_duplicate'})
            else:
                rejected.append({'index': index, 'key': key, 'reason': 'identical_duplicate'})
        else:
            by_key[key] = row
    rows = [by_key[key] for key in sorted(by_key) if key not in conflicts]
    coverage = {
        'providerRows': len(result.get('timestamp') or []), 'acceptedRows': len(rows),
        'rejectedRowsByReason': dict(Counter(row['reason'] for row in rejected)),
        'conflictingBucketsRemoved': len(conflicts),
        'first': rows[0]['startAt'] if rows else None, 'last': rows[-1]['startAt'] if rows else None,
    }
    if interval == '60m':
        accepted = {row['startAt'] for row in rows}
        missing = []
        cursor = start
        while cursor + timedelta(hours=1) <= cutoff:
            if iso(cursor) not in accepted:
                missing.append(iso(cursor))
            cursor += timedelta(hours=1)
        coverage.update({'calendarHours': int((cutoff - start).total_seconds() // 3600),
                         'absentCalendarHours': len(missing), 'absentStarts': missing,
                         'absenceMeaning': 'Calendar gaps include closed sessions and provider omissions; no values are filled.'})
    return {
        'schemaVersion': 1, 'asOf': iso(cutoff), 'historical': True, 'executable': False,
        'source': SOURCE, 'symbol': symbol, 'interval': interval,
        'startInclusive': iso(start), 'endExclusive': iso(cutoff),
        'exchangeTimezoneName': metadata['exchangeTimezoneName'],
        'instrumentType': metadata.get('instrumentType'),
        'providerIdentity': {key: metadata.get(key) for key in (
            'symbol', 'longName', 'shortName', 'exchangeName', 'fullExchangeName',
            'instrumentType', 'currency', 'dataGranularity', 'exchangeTimezoneName')},
        'timingConvention': (
            'Hourly bar timestamps identify the start. availableAt is nominal bar end; historical provider arrival latency is not archived.'
            if interval == '60m' else
            'Daily close is made available only at next calendar midnight in the provider exchange timezone. This conservative research convention is later than the dashboard 17:00 ET date gate; historical provider arrival latency is not archived.'
        ),
        'rows': rows, 'coverage': coverage, 'rejected': rejected,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', type=Path, default=DEFAULT_OUT)
    parser.add_argument('--as-of', default=DEFAULT_AS_OF)
    parser.add_argument('--hourly-start', default=DEFAULT_START)
    parser.add_argument('--daily-start', default=DEFAULT_DAILY_START)
    args = parser.parse_args()
    cutoff = dt(args.as_of)
    if cutoff.minute or cutoff.second or cutoff.microsecond:
        raise ValueError('--as-of must be an exact completed UTC hour boundary')
    manifest = {'asOf': iso(cutoff), 'datasets': {}, 'sources': [
        {'title': 'Yahoo Finance US Dollar Index historical prices', 'url': 'https://finance.yahoo.com/quote/DX-Y.NYB/history/'},
        {'title': 'Yahoo Finance US Dollar Index chart', 'url': 'https://finance.yahoo.com/chart/DX-Y.NYB/'},
        {'title': 'ICE currency index definition', 'url': 'https://www.ice.com/fixed-income-data-services/index-solutions/currency-indices'},
        {'title': 'ICE DXY calculation-hours update effective April 2, 2021', 'url': 'https://www.ice.com/publicdocs/equity_indices/notices/DXY_ICE_FX_Indices_Methodology_Updates_20210311.pdf'},
        {'title': 'ICE FX Indexes methodology: closing-level definition (earlier version; hours updated in 2021 notice)', 'url': 'https://www.nyse.com/publicdocs/nyse/indices/ICE_FX_Indexes_Methodology.pdf'},
    ], 'notes': [
        'DXY is the same actual index and Yahoo symbol used by the dashboard. No futures, ETF, FX-pair proxy or inferred index was substituted.',
        'Yahoo chart is a public provider endpoint without a versioned research API guarantee. Full raw responses and request metadata are archived for offline replay.',
        'Daily closes use raw close, not adjusted close, matching dashboard daily price-level correlation inputs.',
        'No prices are interpolated or filled. Missing hourly observations remain absent.',
        'ICE spot DXY calculation continues until 19:15 ET Monday–Thursday and 17:00 ET Friday. The daily closing level is the last calculated level. The app 17:00 ET gate is therefore not used as historical final-close availability; the study conservatively uses next New York midnight.',
    ]}
    normalized_inputs = {}
    for filename, symbol, interval, start in [
        ('hourly.json', 'DX-Y.NYB', '60m', dt(args.hourly_start)),
        ('daily-dxy.json', 'DX-Y.NYB', '1d', dt(args.daily_start)),
        ('daily-btc.json', 'BTC-USD', '1d', dt(args.daily_start)),
    ]:
        payload, raw_path, metadata = retrieve(symbol, interval, start, cutoff, args.out)
        normalized = normalize(payload, symbol, interval, start, cutoff, raw_path)
        normalized_inputs[filename] = normalized
        write_json(args.out / filename, normalized)
        manifest['datasets'][filename] = {'rawResponse': raw_path, **metadata,
                                         'coverage': {key: value for key, value in normalized['coverage'].items() if key != 'absentStarts'},
                                         'normalizedSha256': hashlib.sha256((args.out / filename).read_bytes()).hexdigest()}
    # A second independent request shape checks representative beginning, DST, and
    # current-bullish-run observations against the archived full-range response.
    verification = []
    main_rows = {row['startAt']: row for row in normalized_inputs['hourly.json']['rows']}
    for day in ('2025-07-28', '2025-11-03', '2026-08-20'):
        beginning = dt(day + 'T00:00:00Z')
        end = beginning + timedelta(days=1)
        if beginning < dt(args.hourly_start) or end > cutoff:
            continue
        payload, raw_path, metadata = retrieve('DX-Y.NYB', '60m', beginning, end, args.out)
        check = normalize(payload, 'DX-Y.NYB', '60m', beginning, end, raw_path)
        differences = []
        for row in check['rows']:
            original = main_rows.get(row['startAt'])
            if original is None or any(original[key] != row[key] for key in ('open', 'high', 'low', 'close')):
                differences.append(row['startAt'])
        missing_from_check = sorted(key for key in main_rows if beginning <= dt(key) < end
                                    and key not in {row['startAt'] for row in check['rows']})
        verification.append({'date': day, 'comparedRows': len(check['rows']),
                             'ohlcDisagreements': differences, 'missingFromTargetedRequest': missing_from_check,
                             'rawResponse': raw_path, **metadata})
        if differences or missing_from_check:
            raise RuntimeError(f'Provider request shapes disagree for {day}; inspect saved raw responses')
    manifest['overlapVerification'] = verification
    manifest['officialMethodology'] = [
        retrieve_methodology(args.out, 'https://www.ice.com/publicdocs/equity_indices/notices/DXY_ICE_FX_Indices_Methodology_Updates_20210311.pdf', 'DXY_Methodology_Updates_20210311.pdf'),
        retrieve_methodology(args.out, 'https://www.nyse.com/publicdocs/nyse/indices/ICE_FX_Indexes_Methodology.pdf', 'ICE_FX_Indexes_Methodology_2018.pdf'),
    ]
    manifest['timingEvidence'] = {
        'source': 'DXY_Methodology_Updates_20210311.pdf, page 1, item 1',
        'excerpt': 'the index will stop calculating and publishing at 5 PM ET on the Friday of each week.',
        'summary': 'The March 11, 2021 notice retains 19:15 ET on other weekdays and changes Friday to 17:00 ET, effective April 2, 2021.',
        'closingDefinitionSource': 'ICE_FX_Indexes_Methodology_2018.pdf, Publication section: the daily closing level is the last calculated index level.',
        'application': 'Next New York midnight plus any additional analysis latency is a conservative research availability convention, not a claim of verified historical Yahoo receipt time.',
    }
    manifest['scriptSha256'] = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    write_json(args.out / 'manifest.json', manifest)
    print(json.dumps({key: value['coverage'] for key, value in manifest['datasets'].items()}, indent=2))


if __name__ == '__main__':
    main()
