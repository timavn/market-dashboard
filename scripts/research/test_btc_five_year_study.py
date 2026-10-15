from datetime import timedelta
import unittest

from btc_five_year_study import enrich, public_rows
from btc_hourly_bias import SignalTimeline
from btc_usd_features import instant, iso
from btc_volume_history import METRIC, VolumeTimeline, normalize


class StudyIntegrationTests(unittest.TestCase):
    def test_entry_joins_use_only_known_signal_dollar_and_volume_and_export_no_private_sources(self):
        report={'reportDate':'2025-01-20','publicationAt':'2025-01-20T13:15:00Z','receivedAt':'2025-01-20T13:20:00Z',
                'availableAt':'2025-01-20T13:20:00Z','directionEligible':True,'trend':'BULLISH','lrr':100,'hrr':160,
                'sourceMessageId':'private-id','sourceUrl':'https://mail.google.com/private'}
        timeline=SignalTimeline({'records':[report]})
        def price(at):
            start=instant(at)
            return {'startAt':at,'endAt':iso(start+timedelta(hours=1)), 'open':110,'close':111,'low':105,'high':115,
                    'durationHours':1,'newYorkDay':'2025-01-20','rawResponses':['private-source'],'source':'Coinbase'}
        start=instant('2024-12-20T00:00:00Z')
        volume=VolumeTimeline(normalize([{'time':iso(start+timedelta(days=i)),METRIC:'100','rawResponses':['private-volume']} for i in range(40)])[0])
        old={'indicatorEligible':True, 'usdObservedAt':'2025-01-20T12:00:00Z','usdAvailableAt':'2025-01-20T13:00:00Z',
             'usdSessionMoveBp':-20,'corr30Level':-.8,'corrAvailableAt':'2025-01-20T06:00:00Z'}
        future={**old,'usdSessionMoveBp':999,'usdAvailableAt':'2025-01-20T14:00:00Z'}
        rows,_=enrich([price('2025-01-20T13:00:00Z'),price('2025-01-20T13:30:00Z')], 'daily',timeline,None,
                      {'2025-01-20T13:00:00Z':old,'2025-01-20T14:00:00Z':future},volume,volume)
        self.assertFalse(rows[0]['entryEligible'])
        self.assertTrue(rows[1]['entryEligible'])
        self.assertEqual(rows[1]['usdSessionMoveBp'],-20)
        self.assertEqual(rows[1]['volumeDate'],'2025-01-19')
        public=public_rows(rows)[1]
        self.assertEqual(public['volumeClass'],'at_or_above_15d')
        self.assertFalse(public['executable'])
        self.assertFalse(set(public)&{'rawResponses','signalMessageId','signalSourceUrl','sourceMessageId'})
        self.assertNotIn('private',str(public))


if __name__ == '__main__':
    unittest.main()
