import json
import sys
import tempfile
import unittest
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import import_global_quads_screenshots as importer
import global_quads as q


class ScreenshotImportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        image = Path(self.temp.name) / 'source.png'
        image.write_bytes(b'\x89PNG\r\n\x1a\nsource fixture for hash verification')
        self.table = {'group': 'global', 'asOf': '2026-08-12', 'image': str(image), 'imageSha256': q.sha(image.read_bytes()),
                      'columns': ['2Q26', '3Q26E', '4Q26E', '1Q27E'], 'rows': [
                          {'country': 'United States', 'aggregate': False, 'values': [3, 4, 2, 4]},
                          {'country': 'Eurozone', 'aggregate': False, 'values': [None, 4, 4, 1]},
                          {'country': 'MODE/MEAN', 'aggregate': True, 'values': [3, 4, 3, 4]}]}
        columns = [{'id': '2026-Q2', 'label': '2Q26', 'kind': 'actual'},
                   {'id': '2026-Q3', 'label': '3Q26E', 'kind': 'estimate'},
                   {'id': '2026-Q4', 'label': '4Q26E', 'kind': 'estimate'},
                   {'id': '2027-Q1', 'label': '1Q27E', 'kind': 'estimate'}]
        rows = [{**row, 'values': {c['id']: {'quad': v, 'kind': c['kind']} for c, v in zip(columns, row['values'])}} for row in self.table['rows']]
        self.table['review'] = {'method': importer.METHOD, 'reviewedBy': 'Codex', 'reviewedAt': datetime.now(timezone.utc).isoformat(),
                                'contentHash': q.sha({'group': 'global', 'columns': columns, 'rows': rows})}
        self.manifest = {'schemaVersion': 1, 'sourceTitle': 'Publisher screenshot', 'tables': [self.table]}

    def test_review_retains_labels_missing_cells_and_unknown_publication_time(self):
        candidate, source, _ = importer.prepare_table(self.table, 'Publisher screenshot')
        self.assertEqual(candidate['rows'][-1]['country'], 'MODE/MEAN')
        self.assertEqual(candidate['rows'][0]['values']['2026-Q3']['kind'], 'estimate')
        self.assertIsNone(candidate['rows'][1]['values']['2026-Q2']['quad'])
        self.assertEqual(source['asOf'], '2026-08-12')
        self.assertIsNone(source['publishedAt'])
        self.assertNotIn('gmailMessageId', source)
        self.assertNotIn('confidence', json.dumps(source))

    def test_rejects_changed_image_transcription_or_unreviewed_input(self):
        for modify in [lambda t: t.update(imageSha256='a'*64), lambda t: t['rows'][0]['values'].__setitem__(1, 1),
                       lambda t: t.pop('review'), lambda t: t['review'].update(method='unverified-ocr')]:
            table = deepcopy(self.table); modify(table)
            with self.assertRaises(q.QuadValidationError): importer.prepare_table(table, 'Source')

    def test_rejects_invalid_or_misaligned_values(self):
        for bad in [5, True, '4', 2.5]:
            table = deepcopy(self.table);table['rows'][0]['values'][0] = bad
            with self.assertRaises(q.QuadValidationError): importer.prepare_table(table, 'Source')
        table = deepcopy(self.table);table['rows'][0]['values'].pop()
        with self.assertRaises(q.QuadValidationError): importer.prepare_table(table, 'Source')

    def test_import_is_dated_idempotent_and_keeps_inactive_email_issues(self):
        records = {('LATEST', 'global-quads-health'): {**q.HEALTH_KEY, 'dataVersion': 'old', 'issues': {'email': {'detail': 'held'}}}}
        store = q.QuadStore(Mock(), Mock(), None, enabled=True);store.archive = Mock()
        store.table.get_item.side_effect = lambda Key, **_: {'Item': deepcopy(records.get((Key['date'], Key['snapshotType'])))}
        def put(Item, **_): records[(Item['date'], Item['snapshotType'])] = deepcopy(Item)
        store.table.put_item.side_effect = put
        self.assertEqual(importer.import_reviewed(self.manifest, store)[0]['status'], 'preview')
        store.archive.assert_not_called();store.table.put_item.assert_not_called()
        self.assertEqual(importer.import_reviewed(self.manifest, store, True)[0]['status'], 'published')
        first = deepcopy(records[('LATEST', 'global-quads')])
        self.assertEqual(importer.import_reviewed(self.manifest, store, True)[0]['status'], 'unchanged')
        self.assertEqual(records[('LATEST', 'global-quads')], first)
        self.assertEqual(first['reportDate'], '2026-08-12')
        self.assertIsNone(first['publishedAt'])
        health = records[('LATEST', 'global-quads-health')]
        self.assertEqual(health['mode'], 'reviewed-screenshot')
        self.assertIn('email', health['issues'])


if __name__ == '__main__': unittest.main()
