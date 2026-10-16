import copy
import unittest

from btc_usd_history import dt, normalize


def payload(timestamps, quotes=None, symbol='DX-Y.NYB', interval='1h', timezone='America/New_York'):
    count = len(timestamps)
    return {'chart': {'error': None, 'result': [{
        'meta': {'symbol': symbol, 'instrumentType': 'INDEX' if symbol == 'DX-Y.NYB' else 'CRYPTOCURRENCY',
                 'dataGranularity': interval, 'exchangeTimezoneName': timezone},
        'timestamp': [int(dt(value).timestamp()) for value in timestamps],
        'indicators': {'quote': [quotes or {'open': [100.] * count, 'high': [101.] * count,
                                           'low': [99.] * count, 'close': [100.5] * count,
                                           'volume': [0] * count}]},
    }]}}


class UsdHistoryTests(unittest.TestCase):
    def hourly(self, data, start='2026-09-14T00:00:00Z', cutoff='2026-09-15T18:00:00Z'):
        return normalize(data, 'DX-Y.NYB', '60m', dt(start), dt(cutoff), 'raw/test.json.gz')

    def test_rejects_partial_and_unaligned_bars(self):
        result = self.hourly(payload(['2026-09-15T16:30:00Z', '2026-09-15T17:00:00Z', '2026-09-15T18:00:00Z']))
        self.assertEqual([row['startAt'] for row in result['rows']], ['2026-09-15T17:00:00Z'])
        self.assertEqual(result['rows'][0]['availableAt'], '2026-09-15T18:00:00Z')

    def test_never_fills_missing_ohlc(self):
        data = payload(['2026-09-15T16:00:00Z', '2026-09-15T17:00:00Z'])
        data['chart']['result'][0]['indicators']['quote'][0]['close'][1] = None
        result = self.hourly(data, '2026-09-15T16:00:00Z')
        self.assertEqual(len(result['rows']), 1)
        self.assertEqual(result['coverage']['absentStarts'], ['2026-09-15T17:00:00Z'])

    def test_conflicting_duplicates_remove_entire_bucket(self):
        data = payload(['2026-09-15T17:00:00Z'] * 2)
        data['chart']['result'][0]['indicators']['quote'][0]['close'][1] = 100.7
        self.assertEqual(self.hourly(data)['rows'], [])

    def test_identical_duplicates_collapse(self):
        result = self.hourly(payload(['2026-09-15T17:00:00Z'] * 2))
        self.assertEqual(len(result['rows']), 1)

    def test_index_identity_and_interval_are_required(self):
        data = payload(['2026-09-15T17:00:00Z'])
        for key, value in [('instrumentType', 'FUTURE'), ('symbol', 'UUP'), ('dataGranularity', '1d')]:
            changed = copy.deepcopy(data)
            changed['chart']['result'][0]['meta'][key] = value
            with self.assertRaises(ValueError):
                self.hourly(changed)

    def test_daily_ny_midnight_observes_dst(self):
        data = payload(['2026-03-06T05:00:00Z', '2026-03-09T04:00:00Z'], interval='1d')
        result = normalize(data, 'DX-Y.NYB', '1d', dt('2026-03-01T00:00:00Z'),
                           dt('2026-03-12T00:00:00Z'), 'raw/test.json.gz')
        self.assertEqual([row['availableAt'] for row in result['rows']],
                         ['2026-03-07T05:00:00Z', '2026-03-10T04:00:00Z'])

    def test_daily_btc_utc_end_and_incomplete_day_exclusion(self):
        data = payload(['2026-09-14T00:00:00Z', '2026-09-15T00:00:00Z'],
                       symbol='BTC-USD', interval='1d', timezone='UTC')
        result = normalize(data, 'BTC-USD', '1d', dt('2026-09-01T00:00:00Z'),
                           dt('2026-09-15T18:00:00Z'), 'raw/test.json.gz')
        self.assertEqual([row['date'] for row in result['rows']], ['2026-09-14'])
        self.assertEqual(result['rows'][0]['availableAt'], '2026-09-15T00:00:00Z')

    def test_nonpositive_and_inconsistent_prices_are_excluded(self):
        data = payload(['2026-09-15T16:00:00Z', '2026-09-15T17:00:00Z'])
        quote = data['chart']['result'][0]['indicators']['quote'][0]
        quote['low'][0] = 0
        quote['close'][1] = 102
        self.assertEqual(self.hourly(data)['rows'], [])


if __name__ == '__main__':
    unittest.main()
