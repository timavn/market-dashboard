#!/usr/bin/env python3
"""Independent Decimal-based audit of BTC research entry-zone thirds.

Rebuilds filters from the previously verified observation export, verifies its
signals against original report records, and reconciles the produced study.
No imports from the research calculation or UI modules.
"""
from __future__ import annotations
import argparse
from collections import Counter
import csv
from datetime import datetime, timedelta
from decimal import Decimal
import hashlib
import json
import math
from pathlib import Path
import statistics
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[2]
INPUT = ROOT / 'artifacts/btc-hourly-usd-experiment/hourly-observations.csv'
SIGNALS = ROOT / 'artifacts/btc-hourly-bias-experiment/source-signals/signals.json'
OUTPUT = ROOT / 'artifacts/btc-range-entry-experiment/verification'
ZONES = ('below', 'bottom', 'middle', 'top', 'above')
COHORTS = ('bullish', 'bearish', 'neutral', 'all', 'current_bullish')
VARIATIONS = {
    'main': ('corr30Level', -.5, 'usdSessionMoveBp', 10),
    'short_window': ('corr15Level', -.5, 'usdSessionMoveBp', 10),
    'stronger_corr': ('corr30Level', -.75, 'usdSessionMoveBp', 10),
    'smaller_move': ('corr30Level', -.5, 'usdSessionMoveBp', 5),
    'larger_move': ('corr30Level', -.5, 'usdSessionMoveBp', 20),
    'return_corr': ('corr120Return', -.5, 'usdSessionMoveBp', 10),
    'hour_move': ('corr30Level', -.5, 'usdHourMoveBp', 10),
}
FILTERS = ['none'] + [key + '_' + direction for key in VARIATIONS for direction in ('down', 'up')]


def timestamp(value):
    return datetime.fromisoformat(value.replace('Z', '+00:00'))


def zone(opening, lower, upper):
    opening, lower, upper = [Decimal(str(v)) for v in (opening, lower, upper)]
    if not all(v.is_finite() for v in (opening, lower, upper)) or lower <= 0 or upper <= lower:
        raise ValueError('Invalid original range')
    if opening < lower:
        return 'below'
    if opening > upper:
        return 'above'
    offset_times_three, width = (opening - lower) * 3, upper - lower
    if offset_times_three < width:
        return 'bottom'
    if offset_times_three < width * 2:
        return 'middle'
    return 'top'


def in_cohort(row, cohort):
    return row['trend'] != 'UNKNOWN' if cohort == 'all' else (
        row['currentBullishRun'] == 'True' if cohort == 'current_bullish' else row['trend'].lower() == cohort)


def qualifying(row, filter_id):
    if filter_id == 'none':
        return True
    name, side = filter_id.rsplit('_', 1)
    correlation, maximum, movement, threshold = VARIATIONS[name]
    if row['indicatorEligible'] != 'True' or row[correlation] == '' or row[movement] == '':
        return False
    rho, change = float(row[correlation]), float(row[movement])
    if not math.isfinite(rho) or not math.isfinite(change) or rho > maximum + 1e-12:
        return False
    return change >= threshold - 1e-9 if side == 'up' else change <= -threshold + 1e-9


def summary(rows):
    n = len(rows)
    counts = Counter(row['direction'] for row in rows)
    returns = [float(row['returnPct']) for row in rows]
    return {'hours': n, 'days': len({row['pacificDay'] for row in rows}),
            'up': counts['UP'], 'down': counts['DOWN'], 'unchanged': counts['UNCHANGED'],
            'upPct': 100 * counts['UP'] / n if n else None,
            'downPct': 100 * counts['DOWN'] / n if n else None,
            'meanReturnPct': statistics.mean(returns) if n else None,
            'medianReturnPct': statistics.median(returns) if n else None}


def independent_rows(source_rows):
    result = []
    selected_hours = {}
    for cohort in COHORTS:
        for entry_zone in ZONES:
            available = [r for r in source_rows if in_cohort(r, cohort) and r['entryZone'] == entry_zone]
            for filter_id in FILTERS:
                qualifying_hours = [r for r in available if qualifying(r, filter_id)]
                for mode in ('all_hours', 'first_per_day'):
                    selected = qualifying_hours
                    if mode == 'first_per_day':
                        by_day = {}
                        for row in sorted(qualifying_hours, key=lambda r: r['hourStart']):
                            by_day.setdefault(row['pacificDay'], row)
                        selected = list(by_day.values())
                        assert len(selected) == len({r['pacificDay'] for r in qualifying_hours})
                    key = (cohort, entry_zone, filter_id, mode)
                    selected_hours[key] = [r['hourStart'] for r in selected]
                    preferred = (cohort in ('bullish', 'current_bullish') and entry_zone == 'bottom') or (cohort == 'bearish' and entry_zone == 'top')
                    result.append({'cohort': cohort, 'zone': entry_zone, 'filter': filter_id,
                                   'entryMode': mode, 'preferred': preferred, **summary(selected)})
    return result, selected_hours


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--study', type=Path, default=ROOT / 'artifacts/btc-range-entry-experiment/study.json')
    parser.add_argument('--require-study', action='store_true')
    args = parser.parse_args()
    # Boundary requirements are checked with exactly representable Decimal values.
    assert [zone(p, 90, 120) for p in (89, 90, 99, 100, 109, 110, 120, 121)] == [
        'below', 'bottom', 'bottom', 'middle', 'middle', 'top', 'top', 'above']
    source = list(csv.DictReader(INPUT.open()))
    signal_doc = json.loads(SIGNALS.read_text())
    signals = {r['sourceMessageId']: r for r in signal_doc['records']}
    known = []
    for row in source:
        when = timestamp(row['hourStart'])
        assert when.astimezone(ZoneInfo('America/Los_Angeles')).strftime('%Y-%m-%d') == row['pacificDay']
        assert timestamp(row['endAt']) - when == timedelta(hours=1)
        opening, closing = Decimal(row['open']), Decimal(row['close'])
        expected_direction = 'UP' if closing > opening else 'DOWN' if closing < opening else 'UNCHANGED'
        assert row['direction'] == expected_direction
        assert math.isclose(float((closing / opening - 1) * 100), float(row['returnPct']), abs_tol=1e-10)
        for key in ('usdAvailableAt', 'corrAvailableAt', 'corr120ReturnAvailableAt', 'usdReferenceAvailableAt'):
            assert not row[key] or timestamp(row[key]) <= when
        if row['trend'] == 'UNKNOWN':
            continue
        record = signals[row['signalMessageId']]
        assert record['directionEligible'] and record['trend'] == row['trend']
        assert timestamp(record['publicationAt']) <= timestamp(record['receivedAt']) <= timestamp(record['availableAt']) <= when
        assert timestamp(record['availableAt']) == timestamp(row['signalAvailableAt'])
        assert not record.get('validUntil') or when < timestamp(record['validUntil'])
        assert all(not timestamp(g['startAt']) <= when < timestamp(g['endAt']) for g in signal_doc['interruptions'])
        assert Decimal(str(record['lrr'])) == Decimal(row['lowerRange'])
        assert Decimal(str(record['hrr'])) == Decimal(row['upperRange'])
        row['entryZone'] = zone(row['open'], row['lowerRange'], row['upperRange'])
        known.append(row)
    expected, selected_hours = independent_rows(known)
    errors, checked, settlement_checked = [], 0, 0
    if args.study.exists():
        study = json.loads(args.study.read_text())
        actual_rows = study['rows']
        actual_by_key = {(r['cohort'], r['zone'], r['filter'], r['entryMode']): r for r in actual_rows}
        assert len(actual_rows) == len(actual_by_key) == len(expected) == 750
        for exp in expected:
            key = tuple(exp[k] for k in ('cohort', 'zone', 'filter', 'entryMode'))
            actual = actual_by_key[key]
            desired = 'UP' if exp['cohort'] in ('bullish', 'current_bullish') and exp['zone'] == 'bottom' else 'DOWN' if exp['cohort'] == 'bearish' and exp['zone'] == 'top' else None
            assert actual['preferredDirection'] == desired
            assert actual['limitedSample'] == (exp['hours'] < 30 or exp['days'] < 10)
            if exp['days'] < 2:
                assert actual['upPct95'] is None and actual['downPct95'] is None
            for field in ('hours', 'days', 'up', 'down', 'unchanged', 'upPct', 'downPct', 'meanReturnPct', 'medianReturnPct'):
                value = exp[field]
                found = actual[field]
                same = value is None and found is None or value is not None and found is not None and math.isclose(value, found, rel_tol=1e-10, abs_tol=1e-10)
                if not same:
                    errors.append({'row': key, 'field': field, 'expected': value, 'actual': found})
            checked += 1
        public_study = ROOT / 'public/research/bitcoin/study.json'
        assert public_study.read_bytes() == args.study.read_bytes()
        exported = list(csv.DictReader((args.study.parent / 'hourly-observations.csv').open()))
        known_by_hour = {r['hourStart']: r for r in known}
        assert len(exported) == len(source)
        for row in exported:
            original = known_by_hour.get(row['hourStart'])
            expected_zone = original['entryZone'] if original else ''
            expected_filters = [f for f in FILTERS if qualifying(original, f)] if original else []
            assert row['entryZone'] == expected_zone
            assert json.loads(row['qualifyingFilters']) == expected_filters
        settlement_path = ROOT / 'artifacts/btc-hourly-bias-experiment/settlement-changes.csv'
        settlements = {r['hourStart']: r for r in csv.DictReader(settlement_path.open())}
        for actual in study['settlementChecks']:
            key = tuple(actual[k] for k in ('cohort', 'zone', 'filter', 'entryMode'))
            selected = selected_hours[key]
            official = [settlements[hour] for hour in selected if hour in settlements]
            expected_official = summary(official)
            assert actual['coinbaseQualifyingHours'] == len(selected)
            assert actual['missingSettlementHours'] == len(selected) - len(official)
            for field, value in expected_official.items():
                found = actual[field]
                assert value is None and found is None or value is not None and found is not None and math.isclose(value, found, rel_tol=1e-10, abs_tol=1e-10), (key, field)
            settlement_checked += 1
    elif args.require_study:
        raise FileNotFoundError(args.study)
    OUTPUT.mkdir(parents=True, exist_ok=True)
    inputs = [INPUT, SIGNALS] + ([args.study] if args.study.exists() else [])
    report = {'method': 'Independent Decimal boundaries and direct source-row grouping. No imports of study calculation code.',
              'sourceHours': len(source), 'knownSignalAndRangeHours': len(known),
              'excludedUnknownSignalHours': len(source) - len(known),
              'studyRowsChecked': checked, 'officialSettlementGroupsChecked': settlement_checked, 'mismatches': errors,
              'sourceSignalAndTimingAudit': 'Every known hourly range/direction agrees with its archived report; publication, receipt and availability precede the hour; validity and interruption windows enforced. All USD availability fields precede outcome hour.',
              'definition': 'BTC hour opening price versus report-known thirds. Outside-range observations remain distinct. First-per-day is earliest qualifying hour within each cohort×zone×filter×Pacific date.',
              'interpretation': 'Preferred is a user-specified research filter, not a trading recommendation. BTC hour close/open direction is not a fixed-strike ABOVE/BELOW contract win rate. Candle open is retrospective, not an archived executable quote received exactly at the hour boundary.',
              'baseline': [r for r in expected if r['filter'] == 'none'],
              'allExpectedRows': expected,
              'inputs': [{'path': str(p.relative_to(ROOT)), 'sha256': hashlib.sha256(p.read_bytes()).hexdigest()} for p in inputs]}
    (OUTPUT / 'independent-range-audit.json').write_text(json.dumps(report, indent=2) + '\n')
    (OUTPUT / 'independent-selected-hours.json').write_text(json.dumps([
        {'cohort': c, 'zone': z, 'filter': f, 'entryMode': m, 'hourStarts': v}
        for (c, z, f, m), v in selected_hours.items()], indent=2) + '\n')
    assert not errors, errors[:10]
    print(json.dumps({'knownHours': len(known), 'rowsChecked': checked, 'mismatches': len(errors),
                      'preferredBaselines': [r for r in expected if r['filter'] == 'none' and r['preferred']]}, indent=2))


if __name__ == '__main__':
    main()
