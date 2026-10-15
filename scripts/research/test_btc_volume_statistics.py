from datetime import timedelta
import unittest
import numpy as np

from btc_usd_experiment import bootstrap_sums, seed_for
from btc_volume_statistics import calculate, sample, validate, weekly
from btc_usd_features import instant, iso


def observations():
    start = instant('2025-01-01T05:00:00Z')
    rows=[]
    for i in range(40):
        at=start+timedelta(hours=12*i)
        rows.append({'hourStart':iso(at),'newYorkDay':at.date().isoformat(),'entryEligible':True,
                     'trend':'BULLISH','currentBullishRun':False,'entryZone':'bottom','qualifyingFilters':['none'],
                     'direction':'UP' if i%3 else 'DOWN','returnPct':1 if i%3 else -1,
                     'volumeClass': None if i<2 else 'below_15d' if i%2 else 'at_or_above_15d',
                     'volumeAdditionalLagClass':'below_15d','volumeCoinbaseClass':'at_or_above_15d'})
    return rows


class StatisticsTests(unittest.TestCase):
    def test_batched_bootstrap_exactly_preserves_seeded_draws(self):
        values=np.array([[3,1,2],[4,3,1],[2,1,1]],dtype=float)
        expected=values[np.random.default_rng(seed_for('test')).integers(0,3,size=(1000,3))].sum(axis=1)
        actual=np.concatenate(list(bootstrap_sums(values,'test',1000)))
        np.testing.assert_array_equal(actual,expected)

    def test_complete_coverage_baseline_volume_partition_and_years(self):
        source=observations();modes=[{'id':'all_hours'}]
        result=calculate(source,'hourly',modes,20)
        self.assertTrue(validate(source,result,modes)['volumePartitionReconciled'])
        by_volume={r['volumeFilter']:r for r in result if r['cohort']=='bullish' and r['zone']=='bottom' and r['filter']=='none'}
        self.assertEqual(by_volume['all']['observations'],40)
        low=by_volume['below_15d']
        self.assertEqual(low['volumeComparison']['baseline']['observations'],38)
        self.assertEqual(low['observations'],19)
        self.assertEqual(sum(r['observations'] for r in low['stability']['byYear']),19)
        self.assertEqual(low['stability']['byYear'][0]['observations'],0)
        self.assertIsNone(by_volume['all']['volumeComparison'])

    def test_sampling_applies_volume_before_first_hour(self):
        source=observations();result=calculate(source,'hourly',[{'id':'first_per_day'}],5)
        row=next(r for r in result if (r['cohort'],r['zone'],r['filter'],r['volumeFilter'])==('bullish','bottom','none','below_15d'))
        self.assertEqual(row['observations'],row['days'])
        self.assertEqual(row['observations'],len(sample([r for r in source if r['volumeClass']=='below_15d'],'first_per_day')))

    def test_week_blocks_cross_year_use_monday(self):
        rows=[{'newYorkDay':'2021-01-01'},{'newYorkDay':'2021-01-03'},{'newYorkDay':'2021-01-04'}]
        self.assertEqual([r['pacificDay'] for r in weekly(rows)],['2020-12-28','2020-12-28','2021-01-04'])


if __name__ == '__main__':
    unittest.main()
