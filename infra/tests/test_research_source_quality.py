"""A source discrepancy isolates fields, never discards the publication."""
from copy import deepcopy
import hashlib
from datetime import datetime, timezone
from decimal import Decimal
from boto3.dynamodb.types import TypeSerializer
import unittest
from unittest.mock import MagicMock, patch

from infra.tests.test_hermes_gmail_ingestor import (
    FakeEventDynamoDb, FakeLedgerTable, FakeRiskRangeDynamoDb,
    ingestor, email_parser,
)
from infra.tests.test_research_intelligence import FakeDynamoDb, intelligence


def publication(product='early-look'):
    return {
        'date': '2026-09-22', 'snapshotType': product, 'reportType': product,
        'source': 'gmail-html', 'scrapedAt': '2026-09-22T11:27:04+00:00',
        'publishedAt': '2026-09-22', 'gmailMessageId': 'source-quality-example',
        'htmlSource': 'hedgeye-email/original.html',
        'article': {'feedUrl': 'https://app.hedgeye.com/feed_items/187503',
                    'bodyText': 'Complete research. Russell 2000 (RUT) 2834-2825 (bearish)'},
        'data': {
            'SPX': {'lrr': 7532, 'hrr': 7797, 'trend': 'BULLISH'},
            'RUT': {'lrr': 2834, 'hrr': 2825, 'trend': 'BEARISH'},
        },
    }


class SourceQualityTests(unittest.TestCase):
    def test_field_quarantine_is_idempotent_preserves_raw_and_valid_same_row_signal(self):
        raw = publication()
        untouched = deepcopy(raw)
        parsed = email_parser.validate_research_ranges(raw)
        repeated = email_parser.validate_research_ranges(parsed)
        self.assertEqual(raw, untouched)
        self.assertEqual(parsed, repeated)
        self.assertEqual(parsed['article'], raw['article'])
        self.assertEqual(parsed['data']['SPX'], raw['data']['SPX'])
        self.assertEqual(parsed['data']['RUT']['trend'], 'BEARISH')
        self.assertNotIn('lrr', parsed['data']['RUT'])
        self.assertNotIn('hrr', parsed['data']['RUT'])
        self.assertEqual(parsed['sourceQuality']['issues'][0]['observed'], raw['data']['RUT'])
        self.assertEqual(parsed['sourceQuality']['issues'][0]['source']['url'], raw['article']['feedUrl'])
        self.assertEqual(parsed['riskRangeCount'], 1)

    def test_early_look_narrative_survives_without_a_range_table(self):
        parsed = ingestor.parse_html_snapshot(report_type='early-look',
            html_body='<p>Early Look</p><p>Growth observations remain useful without a levels table.</p>',
            received_at=datetime(2026, 9, 22, 11, 27, 4, tzinfo=timezone.utc),
            s3_key='original.html', message_id='narrative-only')
        self.assertIsNotNone(parsed)
        self.assertIn('Growth observations', parsed['article']['bodyText'])
        self.assertEqual(parsed['riskRangeCount'], 0)
        ingestor.save_snapshot_to_dynamodb(parsed, FakeRiskRangeDynamoDb())

    def test_quality_revision_survives_dynamodb_numeric_roundtrip(self):
        raw = publication()
        raw['data']['RUT']['lrr'] = 2834.0
        parsed = email_parser.validate_research_ranges(raw)
        restored = email_parser.validate_research_ranges(email_parser._decimalize(parsed))
        self.assertEqual(parsed['sourceQuality']['revision'], restored['sourceQuality']['revision'])
        self.assertEqual(len(restored['sourceQuality']['issues']), 1)

    def test_primary_import_verifies_valid_rows_and_retains_the_discrepancy(self):
        raw = publication('risk-ranges')
        database = FakeRiskRangeDynamoDb()
        ingestor.save_snapshot_to_dynamodb(raw, database)
        saved = database.tables['HedgeyeDailySnapshot'].get_item(Key={'date': raw['date'], 'snapshotType': 'risk-ranges'})['Item']
        manifest = database.tables['RiskRangePublicationManifestsV2'].existing
        self.assertEqual(saved['article'], raw['article'])
        self.assertEqual(saved['data']['RUT']['trend'], 'BEARISH')
        self.assertEqual(manifest['completionState'], 'complete')
        self.assertEqual(manifest['count'], 1)
        self.assertEqual(manifest['expectedProjectionCount'], manifest['verifiedProjectionCount'])
        self.assertEqual(manifest['sourceQuality']['status'], 'discrepancy')
        current = database.tables['HedgeyeRiskRanges'].items.values()
        self.assertEqual([row['ticker'] for row in current], ['SPX'])

    def test_primary_transaction_identity_covers_quality_revision(self):
        raw = publication('risk-ranges')
        first, repeated, revised = (FakeRiskRangeDynamoDb() for _ in range(3))
        ingestor.save_snapshot_to_dynamodb(raw, first)
        ingestor.save_snapshot_to_dynamodb(raw, repeated)
        other = deepcopy(raw)
        other['data']['RUT']['lrr'] = 2840
        ingestor.save_snapshot_to_dynamodb(other, revised)
        self.assertEqual(first.meta.client.client_request_tokens, repeated.meta.client.client_request_tokens)
        self.assertNotEqual(first.meta.client.client_request_tokens, revised.meta.client.client_request_tokens)
        # The valid numeric subset is identical; only discrepancy evidence changed.
        self.assertEqual(first.tables['RiskRangePublicationManifestsV2'].existing['checksum'],
                         revised.tables['RiskRangePublicationManifestsV2'].existing['checksum'])

    def test_bad_previous_close_keeps_valid_range(self):
        raw = publication()
        raw['data'] = {'SPX': {**raw['data']['SPX'], 'prevClose': float('nan')}}
        parsed = email_parser.validate_research_ranges(raw)
        self.assertEqual(parsed['riskRangeCount'], 1)
        self.assertEqual(parsed['data']['SPX']['lrr'], 7532)
        self.assertNotIn('prevClose', parsed['data']['SPX'])
        self.assertEqual(parsed['sourceQuality']['issues'][0]['observed']['prevClose'], 'nan')
        ingestor.save_snapshot_to_dynamodb(parsed, FakeRiskRangeDynamoDb())

    def test_partial_replay_writes_an_immutable_revision_without_overwriting_original(self):
        raw = publication()
        db = FakeEventDynamoDb()
        with patch.object(ingestor, 'validate_research_ranges', side_effect=lambda value: value):
            ingestor.persist_research_event_ledger(raw, db, content_sha256='original-hash')
        original = deepcopy(db.table.items)
        parsed = email_parser.validate_research_ranges(raw)
        self.assertEqual(ingestor.persist_research_event_ledger(parsed, db, content_sha256='original-hash'), 1)
        self.assertEqual(ingestor.persist_research_event_ledger(parsed, db, content_sha256='original-hash'), 0)
        self.assertEqual(len(db.table.items), 2)
        for key, value in original.items():
            self.assertEqual(db.table.items[key], value)
        revised = next(row for row in db.table.items.values() if row.get('sourceQualityRevision'))
        self.assertEqual(revised['sourceQualityRevision'], parsed['sourceQuality']['revision'])
        self.assertEqual(revised['sourceMessageId'], raw['gmailMessageId'])
        self.assertNotIn('lrr', revised['payload']['RUT'])
        self.assertEqual(revised['payload']['RUT']['trend'], 'BEARISH')

    def test_entity_revision_and_indexed_manifest_keep_warning_after_success(self):
        raw = publication()
        parsed = email_parser.validate_research_ranges(raw)
        db = FakeDynamoDb()
        old_events = intelligence.build_entity_events(raw, content_sha256='original-hash')
        intelligence.persist_entity_events(old_events, db)
        original_keys = set(db.events.items)
        new_events = intelligence.build_entity_events(parsed, content_sha256='original-hash')
        intelligence.persist_snapshot_intelligence(parsed, db, content_sha256='original-hash')
        self.assertTrue(original_keys <= set(db.events.items))
        self.assertTrue(all(event['sourceQualityRevision'] == parsed['sourceQuality']['revision'] for event in new_events))
        self.assertFalse(any(event['eventKey'] in {old['eventKey'] for old in old_events} for event in new_events))
        self.assertTrue(all(event['sourceMessageId'] == raw['gmailMessageId'] and event['sourceEventId'] == 'original-hash' for event in new_events))
        self.assertFalse(any(event['fieldPath'].endswith('withheldFields[0]') for event in new_events))
        manifest = db.manifests.get_item(Key={'marketDate': raw['date'], 'productKey': 'early-look'})['Item']
        self.assertEqual(manifest['state'], 'indexed')
        self.assertEqual(manifest['entityEventCount'], len(new_events))
        self.assertEqual(manifest['sourceQuality']['status'], 'discrepancy')
        self.assertEqual(manifest['artifacts'][0]['sourceQuality']['revision'], parsed['sourceQuality']['revision'])
        # A later clean publication is not evidence correcting this source.
        clean = publication()
        clean['gmailMessageId'] = 'later-source'
        clean['data'] = {'SPX': clean['data']['SPX']}
        intelligence.persist_snapshot_intelligence(email_parser.validate_research_ranges(clean), db, content_sha256='other-hash')
        manifest = db.manifests.get_item(Key={'marketDate': raw['date'], 'productKey': 'early-look'})['Item']
        self.assertEqual(manifest['sourceQuality']['status'], 'discrepancy')
        self.assertEqual(len(manifest['sourceQuality']['issues']), 1)

    def test_manifest_write_serializes_float_observations_at_dynamodb_boundary(self):
        raw = publication()
        raw['data']['RUT']['lrr'] = 2834.0
        raw['data']['RUT']['hrr'] = 2825.0
        parsed = email_parser.validate_research_ranges(raw)
        quality_before = deepcopy(parsed['sourceQuality'])
        db = FakeDynamoDb()
        persist = db.manifests.put_item
        def strict_put(**kwargs):
            TypeSerializer().serialize(kwargs['Item'])
            return persist(**kwargs)
        with patch.object(db.manifests, 'put_item', side_effect=strict_put):
            intelligence.persist_snapshot_intelligence(parsed, db, content_sha256='original-hash')
        saved = db.manifests.get_item(Key={'marketDate': raw['date'], 'productKey': 'early-look'})['Item']
        observed = saved['sourceQuality']['issues'][0]['observed']
        self.assertIsInstance(observed['lrr'], Decimal)
        self.assertEqual(observed['lrr'], Decimal('2834.0'))
        self.assertEqual(parsed['sourceQuality'], quality_before)
        self.assertIsInstance(parsed['sourceQuality']['issues'][0]['observed']['lrr'], float)
        self.assertEqual(saved['artifacts'][0]['sourceQuality']['revision'], quality_before['revision'])

    def test_ledger_update_serializes_float_observations_at_dynamodb_boundary(self):
        raw = publication()
        raw['data']['RUT']['lrr'] = 2834.0
        parsed = email_parser.validate_research_ranges(raw)
        ledger = MagicMock()
        def strict_update(**kwargs):
            TypeSerializer().serialize(kwargs['ExpressionAttributeValues'])
            return {}
        ledger.update_item.side_effect = strict_update
        ingestor.mark_attachment(ledger, message_id=raw['gmailMessageId'], attachment_id='message-body-html-0',
                                 status='INDEXED', extra={'sourceQuality': parsed['sourceQuality']})
        values = ledger.update_item.call_args.kwargs['ExpressionAttributeValues']
        quality = next(value for value in values.values() if isinstance(value, dict) and value.get('revision'))
        self.assertIsInstance(quality['issues'][0]['observed']['lrr'], Decimal)
        self.assertEqual(quality['revision'], parsed['sourceQuality']['revision'])
        self.assertIsInstance(parsed['sourceQuality']['issues'][0]['observed']['lrr'], float)

    def test_successful_backfill_keeps_quality_on_artifact_ledger(self):
        parsed = email_parser.validate_research_ranges(publication())
        archived_html = b'<p>source publication</p>'
        record = {'messageId': parsed['gmailMessageId'], 'attachmentId': 'message-body-html-0',
                  'status': 'ERROR', 's3Bucket': 'research', 's3Key': parsed['htmlSource'],
                  'subject': 'Early Look', 'contentSha256': hashlib.sha256(archived_html).hexdigest()}
        ledger = FakeLedgerTable([record])
        s3 = MagicMock()
        s3.get_object.return_value['Body'].read.return_value = archived_html
        with patch.object(ingestor, 's3', s3), patch.object(ingestor, 'parse_email_with_global_quads', return_value=parsed), \
             patch.object(ingestor, 'persist_research_event_ledger', return_value=1), \
             patch.object(ingestor, 'persist_snapshot_intelligence', return_value=1), \
             patch.object(ingestor, 'materialize_email_snapshot', return_value=(parsed, True)), \
             patch.object(ingestor, 'finalize_snapshot_intelligence'):
            self.assertTrue(ingestor.backfill_html_snapshot(table=ledger, message_id=record['messageId'],
                attachment_id=record['attachmentId'], report_type='early-look', mime_type='text/html',
                received_at=datetime(2026, 9, 22, 11, 27, 4, tzinfo=timezone.utc), ledger_item=record))
        saved = ledger.items[(record['messageId'], record['attachmentId'])]
        self.assertEqual(saved['status'], 'INDEXED')
        self.assertEqual(saved['sourceQuality'], parsed['sourceQuality'])
        self.assertIsNone(saved.get('parseError'))


if __name__ == '__main__':
    unittest.main()
