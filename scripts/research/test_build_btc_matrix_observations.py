"""The matrix publisher only repackages public verified observations."""
import csv
import json
from pathlib import Path
import tempfile
import unittest

from build_btc_matrix_observations import build_payload, FIELDS, PUBLIC


class MatrixPublisherTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.interval = next(item for item in json.loads((PUBLIC / 'study.json').read_text())['intervals'] if item['id'] == 'daily')
        with (PUBLIC / 'daily-observations.csv').open(newline='') as stream:
            cls.originals = list(csv.DictReader(stream))

    def export(self, rows, interval=None):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'daily-observations.csv'
            with path.open('w', newline='') as stream:
                writer = csv.DictWriter(stream, fieldnames=list(rows[0]))
                writer.writeheader()
                writer.writerows(rows)
            return build_payload(interval or self.interval, path)

    def test_uses_only_eligible_allowlisted_rows_and_real_sources(self):
        payload = build_payload(self.interval, PUBLIC / 'daily-observations.csv')
        self.assertEqual(payload['fields'], FIELDS)
        self.assertEqual(len(payload['rows']), 649)
        self.assertTrue(payload['historicalOnly'])
        self.assertFalse(payload['executable'])
        self.assertEqual(payload['volatility']['status'], 'unavailable')
        self.assertEqual(payload['quad']['basis'], 'retrospective_actual')
        self.assertEqual(len(payload['sourceSha256']), 64)

    def test_rejects_deleted_entries(self):
        with self.assertRaisesRegex(ValueError, 'count'):
            self.export(self.originals[1:])

    def test_rejects_flagged_csv_evidence_before_dropping_extra_fields(self):
        for flag in ['mock', 'seeded', 'stale', 'cacheOnly', 'inferred']:
            with self.subTest(flag=flag), self.assertRaisesRegex(ValueError, 'flag'):
                self.export([{**row, flag: 'True'} for row in self.originals])

    def test_rejects_wrong_provider_and_quad_basis(self):
        for field, value in [('source', 'fixture'), ('volumeSource', 'Unknown'), ('quadBasis', 'forecast')]:
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, 'Unverified'):
                self.export([{**row, field: value} for row in self.originals])

    def test_rejects_nested_provider_state(self):
        with self.assertRaisesRegex(ValueError, 'provider'):
            self.export(self.originals, {**self.interval, 'volume': {'providerStatus': 'offline'}})


if __name__ == '__main__':
    unittest.main()
