#!/usr/bin/env python3
"""Offline schema3 Bitcoin research: verified history, volume and three intervals."""
from __future__ import annotations

import argparse
from collections import Counter
import csv
from datetime import datetime, timezone
import gzip
import hashlib
import json
from pathlib import Path
import platform
import shutil
import time

import numpy as np

from btc_hourly_bias import SignalTimeline, direction_return, dump, signal_fields, write_csv
from btc_interval_study import (FEATURE_FIELDS, HOURLY_MODES, QUAD_ARCHIVE, coverage, methodology,
                                past_features, public_rows as original_public_rows, quad_gap_coverage)
from btc_multiyear_prices import derive, verify_archive
from btc_quad_overlay import assign_quads, normalize_history
from btc_quad_recovery import merge_supplemental_history
from btc_signal_history import verify_source_archive
from btc_range_entry_experiment import BASE, COHORTS, FILTERS, PUBLIC, ZONES, prepare_observations
from btc_usd_features import build_features, instant, iso
from btc_volume_history import (FILTERS as VOLUME_FILTERS, METHOD as VOLUME_METHOD, METRIC,
                                 VolumeTimeline, add_features, coinbase_days, verify_archive as verify_volume)
from btc_volume_statistics import calculate, validate
from build_btc_matrix_observations import build_payload as build_matrix_payload

ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / 'artifacts/btc-five-year-study'
START = '2021-09-15T04:00:00Z'
CUTOFF = '2026-09-15T18:00:00Z'
INTERVALS = [('hourly', 'hourly', 'Hourly', '24h', HOURLY_MODES),
             ('calendar_day', 'calendar', '24 hours', 'calendar_day', [{'id': 'all_days', 'label': 'Every New York calendar day'}]),
             ('daily', 'nyse', 'NYSE session', 'nyse', [{'id': 'all_days', 'label': 'Every NYSE session'}])]


def verify_usd(archive):
    manifest = json.loads((archive / 'manifest.json').read_text())
    docs = {}
    for name, meta in manifest['datasets'].items():
        path = archive / name
        if hashlib.sha256(path.read_bytes()).hexdigest() != meta['normalizedSha256']:
            raise ValueError('Dollar normalized archive hash mismatch')
        raw = gzip.decompress((ROOT / meta['rawResponse']).read_bytes())
        if hashlib.sha256(raw).hexdigest() != meta['sha256'] or meta['httpStatus'] != 200:
            raise ValueError('Dollar raw archive hash mismatch')
        docs[name] = json.loads(path.read_text())
    return docs, manifest


def enrich(prices, interval_id, timeline, current_start, hourly_features, volume, venue):
    output = []
    for price in prices:
        opening = instant(price['startAt'])
        features = (hourly_features.get(price['startAt'], {}) if interval_id == 'hourly'
                    else past_features(opening, hourly_features))
        row = {**price, **signal_fields(timeline, opening, current_start),
               **{k: features.get(k) for k in FEATURE_FIELDS}, 'interval': interval_id,
               'indicatorReferenceAt': features.get('indicatorReferenceAt', price['startAt'])}
        row['direction'], row['returnPct'] = direction_return(row['open'], row['close'])
        output.append(row)
    prepared, reasons = prepare_observations(output)
    return add_features(prepared, volume, venue), reasons


def volume_metadata(observations):
    available = sum(r.get('volumeClass') is not None for r in observations)
    return {'source': 'Coin Metrics', 'metric': METRIC, 'unit': 'USD', 'dayTimeZone': 'UTC',
            'lookbackDays': 15, 'availabilityLagHours': 1, 'vintage': 'latest_retrieved',
            'coveredIntervals': available, 'unavailableIntervals': len(observations)-available,
            'coveredEligibleEntries': sum(r['entryEligible'] and r.get('volumeClass') is not None for r in observations),
            'methodology': VOLUME_METHOD}


def methods(interval_id, iterations):
    content = methodology(interval_id, iterations)
    if interval_id == 'calendar_day':
        content[0] = '24-hour observations run midnight to midnight in America/New_York, including weekends. Daylight-saving changes create actual 23-hour and 25-hour calendar days. These are single calendar-day open-to-close outcomes, not rolling returns after hourly entries.'
        content[5] = 'There is exactly one entry at New York midnight per completed calendar day. Every constituent 15-minute Coinbase candle must be present; missing observations are never filled.'
        content[6] = 'At New York midnight, dollar conditions use only the exact entry-hour snapshot, with the prior DXY hour conservatively lagged one additional hour; no subsequent data is used.'
    content = [c.replace('within each regime, zone and dollar filter', 'within each regime, zone, dollar and volume filter') for c in content]
    return content + VOLUME_METHOD + [
        'The volume baseline uses the same overall study date window, regime, range zone, dollar and Quad restrictions, retaining only entries with complete volume inputs and removing the below/above-average restriction. First-per-day sampling is applied after these restrictions in each sample. It includes both low- and high-volume dates, rather than only dates selected by the volume rule.',
        f'Volume comparison differences use paired resampling of the same New York date blocks for selected and baseline samples. Weekly sensitivity resamples Monday-start calendar-week blocks; yearly results are descriptive. Both retain unchanged closes in the denominator. All confidence intervals use {iterations:,} replicates batched 256 at a time.',
        'Dollar-filtered observations are unavailable before the recovered hourly DXY series beginning September 17, 2024. Earlier daily DXY closes alone cannot establish the required hourly condition. Quad groups use only separately verified actual-quarter evidence; missing optional evidence does not remove unfiltered observations.',
        'The original 2025–2026 study and its scripts are archived separately. Recovered report periods are included only after verified source and availability review. Reports never extend across unverified source gaps.',
    ]


def build_interval(interval_id, label, session, modes, observations, reasons, price_coverage, current_start, iterations, as_of):
    stats = calculate(observations, interval_id, modes, iterations)
    validation = validate(observations, stats, modes, interval_id != 'hourly')
    c = coverage(observations, reasons, price_coverage['expectedIntervals'], price_coverage['missingIntervals'],
                 price_coverage['incompleteIntervalDetails'], current_start)
    study = {'id': interval_id, 'interval': interval_id, 'label': label, 'schemaVersion': 3, 'status': 'historical',
             'title': 'Bitcoin: entry within the published range', 'asOf': as_of, 'timeZone': 'America/New_York',
             'priceBasis': 'open_to_close', 'session': session, 'source': 'Coinbase BTC-USD',
             'startAt': min(r['hourStart'] for r in observations), 'endAt': max(r['endAt'] for r in observations),
             'entryModes': modes, 'cohorts': COHORTS, 'zones': ZONES, 'filters': FILTERS, 'volumeFilters': VOLUME_FILTERS,
             'volume': volume_metadata(observations), 'rows': stats, 'coverage': c,
             'preferredSummary': [r for r in stats if r['preferredDirection'] and r['filter'] == 'none' and r['entryMode'] == modes[0]['id'] and r['volumeFilter'] == 'all'],
             'methodology': methods(interval_id, iterations), 'settlementChecks': [],
             'downloads': [{'label': label + ' observations', 'href': f'/research/bitcoin/{interval_id}-observations.csv'},
                 {'label': 'All comparison results', 'href': f'/research/bitcoin/{interval_id}-statistics.csv'},
                 {'label': 'Quad cohort results', 'href': f'/research/bitcoin/{interval_id}-quad-statistics.csv'},
                 {'label': 'Source and coverage manifest', 'href': '/research/bitcoin/manifest.json'},
                 {'label': 'Method and reproduction', 'href': '/research/bitcoin/README.md'},
                 {'label': 'Original study', 'href': '/research/bitcoin/original-study.json'}]}
    return study, validation


def add_quads(study, observations, source, iterations):
    classified = assign_quads(observations, source, 'retrospective_actual')
    relevant = [r for r in source['quarters'] if instant(r['periodStart']) < instant(study['endAt']) and instant(r['periodEnd']) > instant(study['startAt'])]
    meta = {'basis': 'retrospective_actual', 'country': source['country'], 'source': source['source'],
            'sourceAsOf': source['sourceAsOf'], 'publishedAt': None, 'availableAt': source['availableAt'],
            'quarterAssignments': [r for r in relevant if r['kind'] == 'actual'],
            'excludedQuarters': [r for r in relevant if r['kind'] != 'actual'],
            'classifiedIntervals': sum(r['quad'] is not None for r in classified),
            'unclassifiedIntervals': sum(r['quad'] is None for r in classified),
            'classifiedEligibleEntries': sum(r['quad'] is not None and r['entryEligible'] for r in classified),
            'unclassifiedEligibleEntries': sum(r['quad'] is None and r['entryEligible'] for r in classified)}
    method = ['Historical US Quads are retrospective published actual-quarter classifications, not forecasts known at entry. Estimates and quarters without independently verified classifications are excluded only when a Quad is selected.',
              f"The verified source is the G20 and Global tables dated {source['sourceAsOf']}, archived/reviewed {source['availableAt']}; original publication time is unknown."]
    supplements = source.get('supplementalEvidence', [])
    meta['supplementalSources'] = [{key:s[key] for key in ('sourceAsOf','publishedAt','receivedAt','availableAt','reviewedAt','addedQuarters','matchedQuarters')} for s in supplements]
    for supplement in supplements:
        method.append(f"Earlier actual Quads are recovered from the original {supplement['sourceAsOf']} G20 table, published {supplement['publishedAt']} and received {supplement['receivedAt']}; reviewed retrospectively {supplement['reviewedAt']}. The overlap agrees with the newer source. Newly covered quarters: {', '.join(supplement['addedQuarters'])}. No 2021–2022 classifications were established.")
    overlays, checks = [], {}
    for quad in range(1, 5):
        selected = [r for r in classified if r['quad'] == quad]
        reasons = dict(Counter(r['entryExclusionReason'] for r in selected if not r['entryEligible']))
        missing, missing_count = quad_gap_coverage(study['coverage']['missingIntervals'], study['id'], source, quad)
        incomplete, _ = quad_gap_coverage(study['coverage']['incompleteIntervalDetails'], study['id'], source, quad)
        stats = calculate(selected, study['id'], study['entryModes'], iterations, sample_name=study['id'] + '|q' + str(quad))
        checks[f'q{quad}'] = validate(selected, stats, study['entryModes'], study['id'] != 'hourly')
        overlays.append({'id': f'q{quad}', 'quad': quad, 'label': f'Quad {quad}', 'basis': 'retrospective_actual',
                         'rows': stats, 'volume': volume_metadata(selected),
                         'coverage': coverage(selected, reasons, len(selected)+missing_count, missing, incomplete, instant(study['coverage']['currentBullishStart'])),
                         'methodology': method})
    assert sum(o['coverage']['observedIntervals'] for o in overlays) == meta['classifiedIntervals']
    assert sum(o['coverage']['eligibleEntryIntervals'] for o in overlays) == meta['classifiedEligibleEntries']
    study['quadOverlay'], study['quadOverlays'] = meta, overlays
    study['methodology'] += method
    return classified, checks


VOLUME_PUBLIC = ['volumeClass', 'volumeDate', 'volumeAvailableAt', 'volumeUsd', 'volumeAverage15', 'volumeRatio15',
                'volumeLookbackStart', 'volumeLookbackEnd', 'volumeLagHours', 'volumeExclusionReason',
                'volumeSource', 'volumeMetric', 'volumeUnit', 'volumeVintage', 'volumeAdditionalLagClass',
                'volumeAdditionalLagDate', 'volumeCoinbaseClass', 'volumeCoinbaseBtc', 'volumeCoinbaseAverage15', 'volumeCoinbaseDate',
                'quadPublishedAt', 'quadReceivedAt', 'quadReviewedAt']


def public_rows(observations):
    return [{**row, **{key: original.get(key) for key in VOLUME_PUBLIC}, 'durationHours': original['durationHours']}
            for row, original in zip(original_public_rows(observations), observations)]


def coverage_by_year(observations):
    return [{'year': year, 'prices': sum(r['newYorkDay'].startswith(str(year)) for r in observations),
             **{label: sum(r['newYorkDay'].startswith(str(year)) and bool(predicate(r)) for r in observations)
                for label, predicate in [('signalsAndRanges', lambda r:r['entryEligible']), ('volume', lambda r:r['volumeClass'] is not None),
                                         ('dollar', lambda r:r.get('indicatorEligible')), ('quads', lambda r:r['quad'] is not None)]}}
            for year in range(2021, 2027)]


def original_comparison(original_path, observations):
    original = json.loads((original_path/'study.json').read_text())
    with (original_path/'hourly-observations.csv').open() as stream:
        before = {r['hourStart']:r for r in csv.DictReader(stream)}
    after = {r['hourStart']:r for r in observations if original['startAt'] <= r['hourStart'] < original['endAt']}
    missing = sorted(before.keys()-after.keys())
    disagreements = [at for at in before.keys() & after.keys()
                     if any(float(before[at][k]) != after[at][k] for k in ('open','close'))]
    return {'startAt': original['startAt'], 'endAt':original['endAt'], 'originalHourlyObservations':len(before),
            'expandedHourlyObservationsInOriginalWindow':len(after), 'excludedHours':missing,
            'addedHours':sorted(after.keys()-before.keys()), 'overlappingOpenCloseDisagreements':len(disagreements),
            'explanation':'The expanded study requires all four constituent 15-minute candles per hour. An original native hourly candle is excluded here when a constituent is missing; no prices are filled. The original study remains separately reproducible.'}


def readme(study, manifest):
    lines = ['# Bitcoin five-year research', '', f"Historical open-to-close research. Target {START} through frozen cutoff {CUTOFF}.", '',
             '## Reproduce offline', '', '```sh', 'python3 scripts/research/btc_five_year_study.py',
             "python3 -m unittest discover -s scripts/research -p 'test_btc*py' -q", '```', '',
             'Original study: `artifacts/btc-five-year-study/original-study/` contains its public exports, source scripts and hash manifest. Original source archives remain in their original artifact locations. Current and original data can be compared without overwriting their evidence.', '',
             'Reproduce the original frozen exports without network or source changes: `python3 scripts/research/btc_reproduce_original.py`.', '',
             'Collection scripts: `btc_multiyear_prices.py`, `btc_volume_history.py`, `btc_usd_history.py`; recovered report artifacts are private under `source-signals/`. Raw source requests and hashes are verified before offline computation.', '']
    if study.get('sourceCoverage'):
        lines += ['## Recovered report coverage', '', study['sourceCoverage']['description'], '']
    lines += ['## Primary hypothesis: bullish, bottom third, below-average volume', '',
              '| Interval | Qualifying observations / days | Up closes | Comparable baseline | Difference, pp | 95% difference interval, pp | Mean / median return |',
              '|---|---:|---:|---:|---:|---:|---:|']
    differences = []
    for item in study['intervals']:
        r = next(r for r in item['rows'] if (r['cohort'],r['zone'],r['filter'],r['entryMode'],r['volumeFilter']) == ('bullish','bottom','none',item['entryModes'][0]['id'],'below_15d'))
        c = r['volumeComparison']; bounds = c['directionDifference95']; differences.append(bounds)
        n = lambda x: '—' if x is None else f'{x:.2f}'
        ci = '—' if bounds is None else f'{bounds[0]:.2f} to {bounds[1]:.2f}'
        lines.append(f"| {item['label']} | {r['observations']} / {r['days']} | {n(r['upPct'])}% | {n(c['baseline']['upPct'])}% | {n(c['directionDifferencePp'])} | {ci} | {n(r['meanReturnPct'])}% / {n(r['medianReturnPct'])}% |")
    if all(ci and ci[0] <= 0 <= ci[1] for ci in differences):
        lines += ['', 'All three difference intervals include zero. The recovered sample does not establish improvement from the volume restriction. Yearly and alternate-lag/venue results are included in the dashboard; they are descriptive checks of the fixed rule, not threshold optimization.', '']
    compare = manifest['originalPeriodComparison']
    lines += ['## Original-window comparison', '', f"The original hourly study contains {compare['originalHourlyObservations']} price observations; {compare['expandedHourlyObservationsInOriginalWindow']} remain under the expanded requirement for complete 15-minute constituents. Overlapping open/close disagreements: {compare['overlappingOpenCloseDisagreements']}. {len(compare['excludedHours'])} original hours lack complete constituent candles and are excluded; the original exports are unchanged.", '']
    for interval in study['intervals']:
        c = interval['coverage']
        lines += ['## ' + interval['label'], '', f"{c['observedIntervals']:,} completed prices; {c['eligibleEntryIntervals']:,} eligible signal/range entries; {c['missingIntervalCount']:,} missing complete price intervals.", '',
                  '| Year | Prices | Signals/ranges | Volume | Dollar | Actual Quads |', '|---|---:|---:|---:|---:|---:|']
        lines += [f"| {r['year']} | {r['prices']} | {r['signalsAndRanges']} | {r['volume']} | {r['dollar']} | {r['quads']} |" for r in manifest['coverageByYear'][interval['id']]]
        lines += [''] + ['- '+item for item in interval['methodology']] + ['']
    lines += ['Public exports contain allowlisted derived values and provenance only. Original subscriber reports, message identifiers, images, links and raw provider bodies remain private.', '']
    return '\n'.join(lines)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=OUTPUT)
    parser.add_argument('--public-output', type=Path, default=PUBLIC)
    parser.add_argument('--bootstrap', type=int, default=10000)
    args = parser.parse_args()
    if args.bootstrap < 1:
        raise ValueError('Bootstrap repetitions must be positive')
    begun = time.monotonic()
    slots, price_metadata = verify_archive(args.output / 'source-prices')
    volume_doc = verify_volume(args.output / 'source-volume')
    volume, venue = VolumeTimeline(volume_doc), VolumeTimeline(coinbase_days(list(slots.values())))
    usd, usd_manifest = verify_usd(args.output / 'source-usd')
    signal_path = args.output / 'source-signals/signals.json'
    signal_audit = verify_source_archive(args.output / 'source-signals')
    signal_doc = json.loads(signal_path.read_text())
    publisher_path = args.output/'publisher-timing-review.json'
    publisher_review = json.loads(publisher_path.read_text())
    publisher_summary = {key:publisher_review[key] for key in ('originalReportsAvailable','historicalReceiptVerified','sampleDate','reconstructedSignalsIncluded','reason')}
    timeline = SignalTimeline(signal_doc)
    current_start = instant(json.loads((BASE/'manifest.json').read_text())['currentRegime']['startedAt'])
    warmup, _ = derive(slots, price_metadata['startInclusive'], CUTOFF, 'hourly')
    features, dollar_coverage = build_features({'rows': warmup, 'cutoff': CUTOFF}, usd['hourly.json'], usd['daily-dxy.json'], usd['daily-btc.json'])
    hourly_features = {r['startAt']:r for r in features}
    source = normalize_history(json.loads((QUAD_ARCHIVE/'global-quads-history.json').read_text()), QUAD_ARCHIVE, CUTOFF)
    source = merge_supplemental_history(source, args.output/'source-signals/older-us-quad-checkpoint.json', args.output/'source-signals', CUTOFF)
    as_of = iso(datetime.now(timezone.utc))
    intervals, validation, quad_checks, by_year, observations_by_id = [], {}, {}, {}, {}
    for interval_id, source_id, label, session, modes in INTERVALS:
        prices, price_coverage = derive(slots, START, CUTOFF, source_id)
        observations, reasons = enrich(prices, interval_id, timeline, current_start, hourly_features, volume, venue)
        study, validation[interval_id] = build_interval(interval_id, label, session, modes, observations, reasons, price_coverage, current_start, args.bootstrap, as_of)
        long_gaps = [g for g in signal_doc['interruptions'] if (instant(g['endAt'])-instant(g['startAt'])).days >= 14]
        gaps_description = '; '.join(g['startAt'][:10] + ' to ' + g['endAt'][:10] for g in long_gaps)
        study['methodology'].append('Report history is discontinuous. Source gaps longer than two weeks: ' + gaps_description + '. Shorter unavailable periods are also excluded and counted.')
        study['methodology'].append('Authenticated publisher archives contain additional reports in the mailbox gap. A January 2023 original was recovered, but historical receipt evidence was not established. Its publication time and image version alone do not satisfy the agreed entry-timing rule, so publisher-only observations remain excluded.')
        observations, quad_checks[interval_id] = add_quads(study, observations, source, args.bootstrap)
        intervals.append(study)
        observations_by_id[interval_id] = observations
        by_year[interval_id] = coverage_by_year(observations)
        print(json.dumps({'interval': interval_id, 'prices': len(observations), 'eligible': study['coverage']['eligibleEntryIntervals'], 'elapsedSeconds': round(time.monotonic()-begun, 1)}), flush=True)
    document = {'schemaVersion': 3, 'status': 'historical', 'title': intervals[0]['title'], 'asOf': as_of,
                'startAt': START, 'endAt': CUTOFF, 'intervals': intervals}
    document['sourceCoverage'] = {'reports': signal_doc['coverage']['reportVersions'],
        'verifiedReports': signal_doc['coverage']['rangeEligibleReports'],
        'description': f"{signal_doc['coverage']['rangeEligibleReports']} reports have verified Trend and range evidence. Source history is discontinuous; gaps longer than two weeks: {gaps_description}. Publisher reports exist within the mailbox gap, but the worked January 2023 recovery did not establish historical receipt evidence. These observations remain excluded under the agreed timing rule. Price and volume coverage remains separately visible.",
        'longGaps': [{'startAt':g['startAt'],'endAt':g['endAt']} for g in long_gaps]}
    inputs = [signal_path, publisher_path, args.output/'source-prices/fetch-manifest.json', args.output/'source-volume/daily.json',
              args.output/'source-volume/fetch-manifest.json', args.output/'source-usd/manifest.json',
              args.output/'source-signals/source-manifest.json',
              args.output/'original-study/archive-manifest.json', QUAD_ARCHIVE/'global-quads-history.json']
    inputs += list((ROOT/'scripts/research').glob('btc_*.py')) + [ROOT/'src/utils/usEquityMarketCalendar.cjs', ROOT/'src/services/bitcoinResearchService.js',
              ROOT/'scripts/research/build_btc_matrix_observations.py', ROOT/'src/services/bitcoinResearchMatrix.js']
    manifest = {'schemaVersion': 3, 'historicalResearchOnly': True, 'study': document['title'], 'asOf': as_of,
                'startAt': START, 'endAt': CUTOFF, 'timeZone': 'America/New_York', 'priceBasis': 'open_to_close',
                'bootstrapReplicates': args.bootstrap, 'bootstrapBatchSize': 256, 'seed': 20260915,
                'runtime': {'python':platform.python_version(), 'numpy':np.__version__, 'system':platform.system()},
                'bootstrapUnit': 'New York calendar day', 'sensitivityBootstrapUnit': 'Monday-start calendar week',
                'calendarSources': price_metadata['calendarSources'], 'validation': validation, 'quadOverlayValidation': quad_checks,
                'coverage': {s['id']:s['coverage'] for s in intervals}, 'coverageByYear': by_year,
                'sourceCoverage': document['sourceCoverage'], 'sourceRecoveryAudit': signal_audit,
                'publisherArchiveFollowup': publisher_summary,
                'originalPeriodComparison': original_comparison(args.output/'original-study/public', observations_by_id['hourly']),
                'volume': {s['id']:s['volume'] for s in intervals}, 'quadOverlay': {s['id']:s['quadOverlay'] for s in intervals},
                'dollarCoverage': {k:v for k,v in dollar_coverage.items() if k not in ('btcHourly','usdHourly','usdDaily','btcDaily')},
                'dollarHourlyStart': usd['hourly.json']['startInclusive'],
                'inputsAndScripts': [{'path':str(p.relative_to(ROOT)), 'sha256':hashlib.sha256(p.read_bytes()).hexdigest()} for p in inputs],
                'publicPrivacy': 'No original subscriber report content, message IDs, mail links, source images or raw provider bodies exported.',
                'elapsedSeconds': round(time.monotonic()-begun, 3)}
    args.public_output.mkdir(parents=True, exist_ok=True)
    dump(args.output/'study.json', document)
    dump(args.output/'manifest.json', manifest)
    (args.output/'README.md').write_text(readme(document, manifest))
    names = ['study.json','manifest.json','README.md']
    for study in intervals:
        id_ = study['id']
        exports = {f'{id_}-observations.csv': public_rows(observations_by_id[id_]),
                   f'{id_}-statistics.csv': study['rows'],
                   f'{id_}-quad-statistics.csv': [{'quad':q['quad'], 'quadBasis':q['basis'], **row} for q in study['quadOverlays'] for row in q['rows']]}
        for name, rows in exports.items():
            write_csv(args.output/name, rows)
            names.append(name)
        matrix_name = f'{id_}-matrix-observations.json'
        matrix_payload = build_matrix_payload(study, args.output/f'{id_}-observations.csv')
        (args.output/matrix_name).write_text(json.dumps(matrix_payload, separators=(',', ':'), allow_nan=False) + '\n')
        names.append(matrix_name)
    shutil.copyfile(args.output/'hourly-statistics.csv', args.output/'statistics.csv')
    names.append('statistics.csv')
    shutil.copyfile(args.output/'original-study/public/study.json', args.output/'original-study.json')
    names.append('original-study.json')
    for name in sorted(names, key=lambda name:name == 'study.json'):
        temporary = args.public_output/(name+'.tmp')
        shutil.copyfile(args.output/name, temporary)
        temporary.replace(args.public_output/name)
    print(json.dumps({'elapsedSeconds': manifest['elapsedSeconds'], 'coverageByYear': by_year}), flush=True)


if __name__ == '__main__':
    main()
