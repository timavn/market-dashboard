"""Fixed-rule volume comparisons with paired day/week block uncertainty."""
from collections import defaultdict
from datetime import date, timedelta

from btc_range_entry_experiment import COHORTS, FILTERS, ZONES, in_cohort, preferred_direction
from btc_usd_experiment import relative_to_baseline, summarize
from btc_volume_history import FILTERS as VOLUME_FILTERS


def sample(rows, mode):
    if mode != 'first_per_day':
        return rows
    first = {}
    for row in rows:
        first.setdefault(row['newYorkDay'], row)
    return list(first.values())


def weekly(rows):
    output = []
    for row in rows:
        day = date.fromisoformat(row['newYorkDay'])
        output.append({**row, 'pacificDay': (day - timedelta(days=day.weekday())).isoformat()})
    return output


def description(rows, name):
    stats = summarize(rows, name, 1)
    return {key: stats[key] for key in ('days', 'upPct', 'downPct', 'meanReturnPct', 'medianReturnPct')} | {'observations': len(rows)}


def comparison(selected, baseline, direction, name, iterations):
    paired = relative_to_baseline(selected, baseline, direction, name, iterations)
    week = relative_to_baseline(weekly(selected), weekly(baseline), direction, name + '|weekly', iterations)
    base = description(baseline, name)
    current = description(selected, name)
    return {'baseline': base, 'targetDirection': direction,
            'directionDifferencePp': paired['targetLiftPp'], 'directionDifference95': paired['targetLift95'],
            'weeklyDifference95': week['targetLift95'],
            'meanReturnDifferencePct': current['meanReturnPct'] - base['meanReturnPct'] if selected and baseline else None,
            'medianReturnDifferencePct': current['medianReturnPct'] - base['medianReturnPct'] if selected and baseline else None}


def sensitivity(pool, field, filter_id, mode, direction, name):
    covered = [r for r in pool if r.get(field) is not None]
    chosen = sample([r for r in covered if r[field] == filter_id], mode)
    baseline = sample(covered, mode)
    result = description(chosen, name)
    paired = relative_to_baseline(chosen, baseline, direction, name, 1)
    return {**result, 'targetPct': result['upPct'] if direction == 'UP' else result['downPct'],
            'baselineTargetPct': paired['baselineTargetPct'], 'directionDifferencePp': paired['targetLiftPp']}


def stability(pool, selected, baseline, volume_filter, mode, direction, name, iterations, years):
    by_year = []
    for year in years:
        chosen = [r for r in selected if r['newYorkDay'].startswith(str(year))]
        base = [r for r in baseline if r['newYorkDay'].startswith(str(year))]
        stats = description(chosen, name)
        paired = relative_to_baseline(chosen, base, direction, name, 1)
        by_year.append({'year': year, **stats, 'targetPct': stats['upPct'] if direction == 'UP' else stats['downPct'],
                        'baselineTargetPct': paired['baselineTargetPct'], 'directionDifferencePp': paired['targetLiftPp']})
    stats = summarize(weekly(selected), name + '|weekly', iterations)
    return {'byYear': by_year, 'weeklyPct95': stats['upPct95'] if direction == 'UP' else stats['downPct95'],
            'additionalDayLag': sensitivity(pool, 'volumeAdditionalLagClass', volume_filter, mode, direction, name),
            'coinbaseVolume': sensitivity(pool, 'volumeCoinbaseClass', volume_filter, mode, direction, name)}


def calculate(observations, interval_id, modes, iterations, sample_name=None, years=range(2021, 2027)):
    # Form eligible buckets once; changing filters in the UI reads only these results.
    buckets = defaultdict(list)
    for row in sorted(observations, key=lambda r: r['hourStart']):
        if not row['entryEligible']:
            continue
        item = {**row, 'pacificDay': row['newYorkDay']}
        for cohort in COHORTS:
            if in_cohort(item, cohort['id']):
                for dollar_filter in row['qualifyingFilters']:
                    buckets[(cohort['id'], row['entryZone'], dollar_filter)].append(item)
    output = []
    for cohort in COHORTS:
        for zone in ZONES:
            preferred = preferred_direction(cohort['id'], zone['id'])
            for dollar in FILTERS:
                pool = buckets[(cohort['id'], zone['id'], dollar['id'])]
                covered = [r for r in pool if r.get('volumeClass') is not None]
                for mode in modes:
                    baseline = sample(covered, mode['id'])
                    for volume in VOLUME_FILTERS:
                        keys = {'cohort': cohort['id'], 'zone': zone['id'], 'filter': dollar['id'],
                                'entryMode': mode['id'], 'volumeFilter': volume['id']}
                        name = 'five-year|' + (sample_name or interval_id) + '|' + '|'.join(keys.values())
                        selected = sample(pool if volume['id'] == 'all' else [r for r in covered if r['volumeClass'] == volume['id']], mode['id'])
                        stats = summarize(selected, name, iterations)
                        stats['observations'] = stats.pop('hours')
                        if interval_id == 'hourly':
                            stats['hours'] = stats['observations']
                        compare = details = None
                        if volume['id'] != 'all':
                            compare = comparison(selected, baseline, preferred or 'UP', name, iterations)
                            if preferred:
                                details = stability(pool, selected, baseline, volume['id'], mode['id'], preferred, name, iterations, years)
                        output.append({**keys, **stats, 'preferredDirection': preferred,
                            'preferredPct': stats['upPct'] if preferred == 'UP' else stats['downPct'] if preferred == 'DOWN' else None,
                            'preferredPct95': stats['upPct95'] if preferred == 'UP' else stats['downPct95'] if preferred == 'DOWN' else None,
                            'volumeComparison': compare, 'stability': details})
    return output


def validate(observations, results, modes, single_day=False):
    assert len(results) == len(COHORTS)*len(ZONES)*len(FILTERS)*len(modes)*len(VOLUME_FILTERS)
    lookup = {(r['cohort'], r['zone'], r['filter'], r['entryMode'], r['volumeFilter']): r for r in results}
    assert len(lookup) == len(results)
    for row in results:
        assert row['observations'] == row['up'] + row['down'] + row['unchanged']
        if row['observations']:
            assert abs(row['upPct'] + row['downPct'] + row['unchangedPct'] - 100) < 1e-9
        if single_day or row['entryMode'] == 'first_per_day':
            assert row['observations'] == row['days']
        if row['volumeComparison']:
            assert row['observations'] <= row['volumeComparison']['baseline']['observations']
    mode = modes[0]['id']
    total = lambda vol: sum(lookup[('all', z['id'], 'none', mode, vol)]['observations'] for z in ZONES)
    assert total('all') == sum(r['entryEligible'] for r in observations)
    assert total('below_15d') + total('at_or_above_15d') == sum(r['entryEligible'] and r.get('volumeClass') is not None for r in observations)
    for z in ZONES:
        for dollar in FILTERS:
            for volume in VOLUME_FILTERS:
                for metric in ('observations', 'up', 'down', 'unchanged'):
                    assert lookup[('all', z['id'], dollar['id'], mode, volume['id'])][metric] == sum(lookup[(c, z['id'], dollar['id'], mode, volume['id'])][metric] for c in ('bullish', 'bearish', 'neutral'))
    return {'comparisonGroups': len(results), 'countsReconciled': True, 'percentagesReconciled': True,
            'allRegimesPartitionReconciled': True, 'volumePartitionReconciled': True, 'newYorkDayGrouping': True}
