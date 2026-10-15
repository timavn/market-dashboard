from datetime import timedelta
import unittest

from btc_usd_features import instant, iso
from btc_volume_history import METRIC, VolumeTimeline, add_features, coinbase_days, normalize


def days(count=40):
    start = instant('2021-08-01T00:00:00Z')
    return normalize([{'asset':'btc', 'time':iso(start+timedelta(days=i)), METRIC:'100',
                       'rawResponses':['raw/provider.json.gz']} for i in range(count)])[0]


class VolumeTests(unittest.TestCase):
    def test_provider_nanosecond_midnight_and_wrong_boundaries(self):
        rows, bad = normalize([{'asset':'btc','time':'2021-08-01T00:00:00.000000000Z',METRIC:'1','rawResponses':['raw']},
                               {'asset':'btc','time':'2021-08-02T00:01:00Z',METRIC:'1','rawResponses':['raw']}])
        self.assertEqual(len(rows),1)
        self.assertEqual(len(bad),1)

    def test_excludes_day_from_its_own_average_equality_is_high(self):
        source = days()
        source[15]['volume'] = 50
        timeline = VolumeTimeline(source)
        row = timeline.at('2021-08-17T01:00:00Z')
        self.assertEqual((row['volumeDate'],row['volumeUsd'],row['volumeAverage15']), ('2021-08-16',50,100))
        self.assertEqual(row['volumeClass'],'below_15d')
        self.assertEqual(VolumeTimeline(days()).at('2021-08-17T01:00:00Z')['volumeClass'],'at_or_above_15d')

    def test_one_hour_lag_and_extra_day_boundary(self):
        timeline=VolumeTimeline(days())
        self.assertEqual(timeline.at('2021-08-18T00:59:59Z')['volumeDate'],'2021-08-16')
        self.assertEqual(timeline.at('2021-08-18T01:00:00Z')['volumeDate'],'2021-08-17')
        self.assertEqual(timeline.at('2021-08-18T01:00:00Z',25)['volumeDate'],'2021-08-16')
        self.assertIsNone(timeline.at('2021-08-16T01:00:00Z')['volumeClass'])

    def test_missing_current_or_lookback_never_carries_forward(self):
        for absent in (1,15):
            source=days();del source[absent]
            self.assertIsNone(VolumeTimeline(source).at('2021-08-17T01:00:00Z')['volumeClass'])
        for invalid in (None, float('nan'), -1, True):
            source=days();source[15]['volume']=invalid
            self.assertIsNone(VolumeTimeline(source).at('2021-08-17T01:00:00Z')['volumeClass'])

    def test_duplicate_and_unverified_inputs(self):
        source={'time':'2021-08-01T00:00:00Z',METRIC:'1','rawResponses':['raw']}
        self.assertEqual(normalize([source,source])[0],[])
        for patch in ({'asset':'eth'},{'rawResponses':[]},{'mock':True},{'stale':True},{'cacheOnly':True},
                      {'stale':'True'},{'seeded':'True'},{'connected':False},
                      {'providerStatus':'offline'},{'providerStatus':'error'},{METRIC:'NaN'},{METRIC:None}):
            self.assertEqual(normalize([{**source,**patch}])[0],[])

    def test_coinbase_requires_every_quarter_hour_and_preserves_btc_units(self):
        start=instant('2021-08-01T00:00:00Z')
        candles=[{'startAt':iso(start+timedelta(minutes=15*i)), 'endAt':iso(start+timedelta(minutes=15*(i+1))),
                  'volume':2,'rawResponse':'raw/coinbase.json.gz'} for i in range(96)]
        result=coinbase_days(candles)
        self.assertEqual((result[0]['volume'],result[0]['unit']),(192,'BTC'))
        self.assertEqual(coinbase_days(candles[:-1]),[])
        candles[-1]['startAt']=candles[-2]['startAt']
        self.assertEqual(coinbase_days(candles),[])


if __name__ == '__main__':
    unittest.main()
