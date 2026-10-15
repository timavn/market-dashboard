#!/usr/bin/env python3
"""Publish compact, allowlisted matrix inputs from the audited BTC observation exports.

No providers are fetched and no missing feature is substituted. Existing study
exports remain unchanged. Run from any directory; output is beside those exports.
"""
import argparse
import csv
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PUBLIC = ROOT / 'public/research/bitcoin'
FIELDS = ['startAt', 'endAt', 'day', 'hour', 'cohort', 'zone', 'direction', 'returnPct',
          'filters', 'volume', 'volumeAvailableAt', 'quad', 'quadQuarter', 'signalAvailableAt',
          'indicatorReferenceAt', 'usdObservedAt', 'usdAvailableAt', 'corrAvailableAt',
          'corr120ReturnAvailableAt', 'usdReferenceAvailableAt', 'corr15Level', 'corr30Level',
          'corr120Return', 'usdSessionMoveBp', 'usdHourMoveBp', 'open', 'close', 'lowerRange',
          'upperRange', 'volumeDate', 'volumeUsd', 'volumeAverage15']
FLOATS = ['returnPct', 'corr15Level', 'corr30Level', 'corr120Return', 'usdSessionMoveBp',
          'usdHourMoveBp', 'open', 'close', 'lowerRange', 'upperRange', 'volumeUsd', 'volumeAverage15']
FLAGS = ['mock', 'isMock', 'seed', 'seeded', 'synthetic', 'inferred', 'portfolioDerived',
         'stale', 'cacheOnly', 'offline', 'disconnected', 'fallback']


def reject_flags(value):
    if not isinstance(value, dict):
        return
    if any(str(value.get(key, '')).lower() in ('true', '1') for key in FLAGS):
        raise ValueError('Unverified historical evidence flag')
    if value.get('providerStatus') in ('offline', 'disconnected', 'error', 'unavailable'):
        raise ValueError('Unverified historical provider state')
    for child in value.values():
        if isinstance(child, dict):
            reject_flags(child)


def build_payload(interval, source_path):
    reject_flags(interval)
    source_bytes = source_path.read_bytes()
    with source_path.open(newline='') as stream:
        originals = list(csv.DictReader(stream))
    rows = []
    for original in originals:
        reject_flags(original)
        if original['entryEligible'] != 'True':
            continue
        if original['source'] != 'Coinbase BTC-USD' or original['historical'] != 'True' or original['executable'] != 'False':
            raise ValueError('Unverified historical price source')
        if original.get('volumeClass') and (original['volumeSource'] != 'Coin Metrics'
                or original['volumeMetric'] != 'volume_reported_spot_usd_1d'
                or original['volumeVintage'] != 'latest_retrieved'):
            raise ValueError('Unverified volume source')
        if original.get('quad') and (original['quadBasis'] != 'retrospective_actual'
                or original['quadKind'] != 'actual' or original['quadSource'] != 'hedgeye-published-global-quads'):
            raise ValueError('Unverified Quad source')
        row = {key: original.get(key) or None for key in FIELDS}
        row.update(startAt=original['hourStart'], day=original['newYorkDay'],
                   hour=int(original['newYorkStart'][11:13]), cohort=original['trend'].lower(),
                   zone=original['entryZone'], filters=json.loads(original['qualifyingFilters']),
                   volume=original.get('volumeClass') or None,
                   quad=int(original['quad']) if original.get('quad') else None)
        for field in FLOATS:
            row[field] = float(original[field]) if original.get(field) else None
        rows.append([row[key] for key in FIELDS])
    if len(rows) != interval['coverage']['eligibleEntryIntervals']:
        raise ValueError('Eligible observation count does not match the audited study')
    return {
        'schemaVersion': 1, 'status': 'historical', 'historicalOnly': True, 'executable': False,
        'intervalId': interval['id'], 'source': 'Coinbase BTC-USD',
        'timeZone': 'America/New_York', 'priceBasis': 'open_to_close',
        'studyAsOf': interval['asOf'], 'startAt': interval['startAt'], 'endAt': interval['endAt'],
        'sourceExport': source_path.name, 'sourceSha256': hashlib.sha256(source_bytes).hexdigest(),
        'volume': {'source': 'Coin Metrics', 'metric': 'volume_reported_spot_usd_1d',
                   'vintage': 'latest_retrieved', 'availabilityLagHours': 1, 'lookbackDays': 15},
        'quad': {'source': 'hedgeye-published-global-quads', 'basis': 'retrospective_actual'},
        'volatility': {'status': 'unavailable', 'reason': 'No historical BTC volatility regime rule is defined.'},
        'fields': FIELDS, 'rows': rows,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--public', type=Path, default=PUBLIC)
    args = parser.parse_args()
    study = json.loads((args.public / 'study.json').read_text())
    for interval in study['intervals']:
        payload = build_payload(interval, args.public / f"{interval['id']}-observations.csv")
        output = args.public / f"{interval['id']}-matrix-observations.json"
        output.write_text(json.dumps(payload, separators=(',', ':'), allow_nan=False) + '\n')
        print(f"{output.name}: {len(payload['rows']):,} verified eligible observations")


if __name__ == '__main__':
    main()
