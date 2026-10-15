import importlib.util
import json
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'infra/lambdas/gmail_ingestor'))
from analyst_change_journal import emit_change
from analyst_cost_guard import projection, check_fast_polling
from datetime import datetime, timezone
from decimal import Decimal

class FakeTable:
    def __init__(self): self.items = {}
    def get_item(self, Key, **kwargs): return {'Item': self.items.get(tuple(Key.values()))} if tuple(Key.values()) in self.items else {}
    def put_item(self, Item): self.items[(Item['productKey'], Item['eventKey'])] = Item
    def Table(self, name): return self

class IngestionGuardTests(unittest.TestCase):
    def test_publication_retry_deduplicates_and_correction_appends(self):
        table = FakeTable()
        snapshot = {'snapshotType': 'real-time-alert', 'gmailMessageId': 'message', 'date': '2026-09-04', 'data': {'alerts': [{'ticker': 'MSFT', 'action': 'SELL-SOME'}]}}
        with patch.dict(os.environ, {'ANALYST_CHANGE_JOURNAL_ENABLED': '1'}):
            emit_change(snapshot, table, {}, [], 'hash1')
            emit_change(snapshot, table, {}, [], 'hash1')
            changes = [v for k,v in table.items.items() if k[0] == 'analyst-change']
            self.assertEqual(len(changes), 1)
            self.assertEqual(changes[0]['entityEvents'][0]['action'], 'SELL-SOME')
            emit_change(snapshot, table, {}, [], 'hash2')
            self.assertEqual(len([k for k in table.items if k[0] == 'analyst-change']), 2)
    def test_parsed_correction_with_same_source_hash_and_events_is_journaled_once(self):
        table = FakeTable()
        snapshot = {
            'snapshotType': 'market-structure', 'schemaVersion': 'market-structure-v4',
            'gmailMessageId': 'original-message', 'date': '2026-09-16',
            'publishedAt': '2026-09-16T06:30:00-04:00',
            'scrapedAt': '2026-09-16T10:30:38+00:00', 'ttl': 123,
            'data': {'signals': [], 'chartMetrics': {'gammaThrottle': Decimal('-4.72')}},
        }
        events = []  # Index-only repair must not create a new trading alert.
        with patch.dict(os.environ, {'ANALYST_CHANGE_JOURNAL_ENABLED': '1'}):
            emit_change(snapshot, table, {}, events, 'original-artifact-hash')
            corrected = {**snapshot, 'data': {
                **snapshot['data'], 'signals': [{'id': 'spxGammaExposure', 'value': 'Negative'}],
            }}
            emit_change(corrected, table, {}, events, 'original-artifact-hash')
            emit_change(corrected, table, {}, events, 'original-artifact-hash')
            replayed = {**corrected, 'ttl': 456, 'capturedAt': '2026-09-17T12:00:00Z',
                        'updatedAt': '2026-09-17T12:00:00Z'}
            emit_change(replayed, table, {}, events, 'original-artifact-hash')
        changes = [value for key, value in table.items.items() if key[0] == 'analyst-change']
        self.assertEqual(len(changes), 2)
        self.assertEqual(json.dumps(changes[-1]['snapshot'], sort_keys=True, default=str),
                         json.dumps(corrected, sort_keys=True, default=str))
        self.assertEqual(changes[-1]['snapshot']['publishedAt'], snapshot['publishedAt'])
        self.assertEqual(changes[-1]['snapshot']['scrapedAt'], snapshot['scrapedAt'])
        self.assertEqual(changes[-1]['entityEvents'], events)
        self.assertNotEqual(changes[0]['eventKey'], changes[-1]['eventKey'])

    def test_missing_usage_and_cost_threshold_slow_down(self):
        self.assertEqual(projection([], {}, days=30, elapsed_days=5)['cadenceMinutes'], 15)
        result = projection([{'Average': 50000, 'Sum': 50000, 'SampleCount': 1}], {}, days=30, elapsed_days=5)
        self.assertGreater(result['projectedMonthly'], 15)
        self.assertEqual(result['cadenceMinutes'], 15)
        table = FakeTable()
        with patch.dict(os.environ, {'ANALYST_FAST_POLLING_ENABLED': '1'}), patch('analyst_cost_guard.measure', return_value=result), patch('analyst_cost_guard.set_cadence', return_value=False) as cadence:
            self.assertFalse(check_fast_polling({'source': 'aws-scheduler'}, table, datetime(2026,9,5,17,1,tzinfo=timezone.utc)))
            cadence.assert_called_with(15)
    def test_guard_failure_never_runs_fast(self):
        with patch.dict(os.environ, {'ANALYST_FAST_POLLING_ENABLED': '1'}), patch('analyst_cost_guard.measure', side_effect=RuntimeError()), patch('analyst_cost_guard.set_cadence', return_value=False) as cadence:
            self.assertFalse(check_fast_polling({'source':'aws-scheduler'}, FakeTable(), datetime(2026,9,5,17,2,tzinfo=timezone.utc)))
            cadence.assert_called_once_with(15)

    def test_confirmed_slow_schedule_is_eligible_without_requiring_a_quarter_hour_phase(self):
        result = {'complete': False, 'cadenceMinutes': 15, 'reason': 'Usage evidence unavailable'}
        with patch.dict(os.environ, {'ANALYST_FAST_POLLING_ENABLED': '1'}), patch('analyst_cost_guard.measure', return_value=result), patch('analyst_cost_guard.set_cadence', return_value=True) as cadence:
            self.assertTrue(check_fast_polling({'source': 'aws-scheduler'}, FakeTable(), datetime(2026,9,5,17,2,tzinfo=timezone.utc)))
            cadence.assert_called_once_with(15)
