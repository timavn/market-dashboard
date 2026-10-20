import tempfile
import unittest
from pathlib import Path
from workspace import WorkspaceStore


def finding(fingerprint='same'):
    return {'attentionVersion': 1, 'id': 'attention:portfolio:SPY', 'sourceId': 'rule:SPY',
            'symbol': 'SPY', 'action': 'reduce', 'state': 'open', 'kind': 'portfolio',
            'fingerprint': fingerprint, 'publicationTime': '2026-09-22T14:00:00Z',
            'presentation': {'subject': 'SPY', 'date': '2026-09-22', 'rows': []}}


class AttentionWorkspaceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = WorkspaceStore(Path(self.temp.name) / 'workspace.db')

    def tearDown(self):
        self.temp.cleanup()

    def publish(self, rows=None, complete=None, reset=False):
        return self.store.dispatch('attention-publish', {'findings': rows or [], 'completeKinds': complete or [], 'reset': reset})

    def row(self):
        return self.store.dispatch('findings', {})['findings'][0]

    def test_reset_retains_evidence_and_conversations_and_supersedes_legacy(self):
        self.store.dispatch('accept', {'requestId': 'chat', 'text': 'Keep this conversation'})
        old = finding()
        old.pop('attentionVersion')
        old['id'] = 'old'
        self.store.dispatch('finding', {'finding': old})
        result = self.publish([finding()], ['portfolio'], True)
        self.assertEqual(result['cleared'], 1)
        with self.store.connect() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM conversations').fetchone()[0], 1)
            self.assertEqual(db.execute('SELECT count(*) FROM messages').fetchone()[0], 2)
            self.assertEqual(db.execute("SELECT state FROM findings WHERE id='old'").fetchone()[0], 'superseded')
            self.assertEqual(db.execute('SELECT count(*) FROM finding_revisions').fetchone()[0], 1)

    def test_acknowledgment_survives_rechecks_and_outage(self):
        self.publish([finding()], ['portfolio'])
        self.store.dispatch('finding-read', {'id': finding()['id'], 'acknowledge': True, 'fingerprint': 'same'})
        self.publish([], [])
        self.assertEqual(self.row()['state'], 'unavailable')
        self.publish([finding()], ['portfolio'])
        self.assertEqual(self.row()['unread'], 0)
        self.assertEqual(self.row()['payload']['materialRevision'], 1)

    def test_legacy_monitor_finishing_after_cutover_cannot_restore_old_queue(self):
        old = finding()
        old.pop('attentionVersion')
        self.store.dispatch('finding', {'finding': old})
        self.publish([], ['portfolio'], True)
        result = self.store.dispatch('finding', {'finding': old})
        self.assertTrue(result['ignored'])
        self.assertEqual(self.row()['state'], 'superseded')
        self.assertEqual(self.publish([], ['portfolio'])['cleared'], 0)
        with self.store.connect() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM finding_revisions').fetchone()[0], 1)

    def test_material_change_and_verified_recurrence_reopen_once(self):
        self.publish([finding()], ['portfolio'])
        self.store.dispatch('finding-read', {'id': finding()['id'], 'acknowledge': True, 'fingerprint': 'same'})
        self.publish([finding('changed')], ['portfolio'])
        self.assertEqual(self.row()['unread'], 1)
        self.store.dispatch('finding-read', {'id': finding()['id'], 'acknowledge': True, 'fingerprint': 'changed'})
        self.publish([], ['portfolio'])
        self.assertEqual(self.row()['state'], 'resolved')
        self.publish([finding('changed')], ['portfolio'])
        self.assertEqual(self.row()['unread'], 1)
        self.assertEqual(self.row()['payload']['materialRevision'], 3)

    def test_ack_of_old_revision_cannot_hide_newer_issue(self):
        self.publish([finding()], ['portfolio'])
        self.publish([finding('changed')], ['portfolio'])
        result = self.store.dispatch('finding-read', {'id': finding()['id'], 'acknowledge': True, 'fingerprint': 'same'})
        self.assertFalse(result['acknowledged'])
        self.assertEqual(self.row()['unread'], 1)

    def test_delayed_ack_cannot_hide_recurrence_with_same_fingerprint(self):
        self.publish([finding()], ['portfolio'])
        self.publish([], ['portfolio'])
        self.publish([finding()], ['portfolio'])
        result = self.store.dispatch('finding-read', {'id': finding()['id'], 'acknowledge': True,
                                                    'fingerprint': 'same', 'materialRevision': 1})
        self.assertFalse(result['acknowledged'])
        self.assertEqual(self.row()['unread'], 1)

    def test_research_assessment_cannot_resolve_from_operational_health(self):
        item = {**finding(), 'kind': 'operational', 'assessmentChannel': 'research'}
        self.publish([item], ['operational'])
        self.publish([], ['operational'])
        self.assertEqual(self.row()['state'], 'unavailable')
        self.store.dispatch('attention-publish', {'findings': [], 'completeAssessments': ['research']})
        self.assertEqual(self.row()['state'], 'resolved')

    def test_invalid_batch_never_clears_previous_inbox(self):
        self.publish([finding()], ['portfolio'])
        with self.assertRaises(ValueError):
            self.publish([finding(), finding()], ['portfolio'], True)
        self.assertEqual(self.row()['state'], 'open')
        self.assertEqual(self.row()['unread'], 1)

    def test_unchanged_publication_keeps_original_date(self):
        self.publish([finding()], ['portfolio'])
        update = finding()
        update['publicationTime'] = '2026-09-23T14:00:00Z'
        update['presentation']['date'] = '2026-09-23'
        self.publish([update], ['portfolio'])
        self.assertEqual(self.row()['payload']['publicationTime'], finding()['publicationTime'])
        self.assertEqual(self.row()['payload']['presentation']['date'], '2026-09-22')

    def test_independent_review_source_findings_keep_their_own_lifecycle(self):
        value = {**finding(), 'kind': 'operational', 'managedBy': 'review-sources'}
        self.store.dispatch('finding', {'finding': value})
        self.publish([], ['operational'])
        self.assertEqual(self.row()['state'], 'open')
        self.assertEqual(self.row()['unread'], 1)

    def test_a_quiet_research_day_does_not_invent_a_resolved_thesis(self):
        item = {**finding(), 'kind': 'opportunity'}
        self.publish([item], ['opportunity'])
        self.store.dispatch('finding-read', {'id': item['id'], 'acknowledge': True})
        self.publish([], ['opportunity'])
        self.assertEqual(self.row()['state'], 'unavailable')
        self.publish([item], ['opportunity'])
        self.assertEqual(self.row()['unread'], 0)

    def test_successful_import_or_new_edition_does_not_resolve_source_discrepancy(self):
        item = {**finding(), 'kind': 'operational', 'sourceDiscrepancy': True}
        self.publish([item], ['operational'])
        self.publish([], ['operational'])
        self.assertEqual(self.row()['state'], 'open')
        self.store.dispatch('finding-read', {'id': item['id'], 'acknowledge': True})
        self.publish([], ['operational'])
        self.assertEqual(self.row()['state'], 'open')
        self.assertEqual(self.row()['unread'], 0)


    def source_issue(self, identity='attention:operations:early-look'):
        return {**finding('source-discrepancy'), 'id': identity, 'sourceId': identity,
                'kind': 'operational', 'symbol': 'Early Look', 'sourceDiscrepancy': True,
                'incidentKey': 'research-product:early-look:2026-09-22',
                'sourceQuality': {'status': 'discrepancy', 'issues': [{'id': 'rut-bounds', 'observed': {'lrr': 2834, 'hrr': 2825}}]},
                'presentation': {'subject': 'Early Look', 'date': '2026-09-22',
                                 'rows': [{'label': 'Issue', 'text': 'Original RUT bounds are reversed; remaining research imported.'}]}}

    def review_issue(self, identity, date='2026-09-22T12:00:00Z'):
        return {**finding('processing-failed'), 'id': identity, 'sourceId': identity,
                'managedBy': 'review-sources', 'kind': 'operational', 'symbol': 'Early Look',
                'incidentKey': 'research-product:early-look:2026-09-22',
                'conversationId': 'deleted-conversation-' + identity, 'reviewRunId': 'captured-' + identity,
                'capturedAt': date, 'publicationTime': date, 'sourceKey': 'early-look',
                'diagnosisStage': 'processing-failed'}

    def test_scan_replaces_stale_review_source_diagnosis_without_loading_deleted_review(self):
        first, second = self.review_issue('old-one'), self.review_issue('old-two', '2026-09-22T13:00:00Z')
        self.store.dispatch('finding', {'finding': first})
        self.store.dispatch('finding', {'finding': second})
        self.publish([self.source_issue()], ['operational'])
        rows = self.store.dispatch('findings', {})['findings']
        active = [row for row in rows if row['state'] == 'open']
        self.assertEqual(len(active), 1)
        self.assertEqual(active[0]['id'], self.source_issue()['id'])
        self.assertEqual(active[0]['payload']['firstReportedAt'], first['publicationTime'])
        self.assertEqual(active[0]['payload']['presentation']['date'], '2026-09-22')
        self.assertEqual(len(active[0]['payload']['affectedReviews']), 2)
        self.assertEqual(active[0]['payload']['sourceQuality'], self.source_issue()['sourceQuality'])
        self.assertTrue(all(row['state'] == 'superseded' and not row['unread'] for row in rows if row['id'].startswith('old-')))
        with self.store.connect() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM finding_revisions').fetchone()[0], 2)
            self.assertEqual(db.execute('SELECT count(*) FROM conversations').fetchone()[0], 0)

    def test_source_incident_acknowledgment_survives_consolidation_and_repeat_scans(self):
        old = self.review_issue('old-one')
        self.store.dispatch('finding', {'finding': old})
        self.store.dispatch('finding-read', {'id': old['id'], 'acknowledge': True})
        self.store.dispatch('finding', {'finding': self.review_issue('old-two')})
        self.publish([self.source_issue()], ['operational'])
        self.publish([self.source_issue()], ['operational'])
        active = next(row for row in self.store.dispatch('findings', {})['findings'] if row['state'] == 'open')
        self.assertEqual(active['unread'], 0)
        self.assertTrue(active['acknowledged_at'])
        self.assertEqual(active['payload']['materialRevision'], 1)
        self.assertEqual(len(active['payload']['affectedReviews']), 2)
        self.publish([], ['operational'])
        self.assertEqual(next(row for row in self.store.dispatch('findings', {})['findings'] if row['id'] == active['id'])['state'], 'open')

    def test_old_review_callback_cannot_resurrect_consolidated_incident(self):
        old = self.review_issue('old-one')
        self.store.dispatch('finding', {'finding': old})
        self.publish([self.source_issue()], ['operational'])
        result = self.store.dispatch('finding', {'finding': old})
        self.assertTrue(result['ignored'])
        self.assertEqual(result['supersededBy'], self.source_issue()['id'])
        new_review = self.review_issue('old-new-review')
        self.assertTrue(self.store.dispatch('finding', {'finding': new_review})['ignored'])
        self.assertEqual(sum(row['state'] == 'open' for row in self.store.dispatch('findings', {})['findings']), 1)

    def test_explicit_report_date_corrects_display_without_reopening_acknowledgment(self):
        old = self.source_issue()
        old['presentation']['date'] = '2026-09-21'
        self.publish([old], ['operational'])
        self.store.dispatch('finding-read', {'id': old['id'], 'acknowledge': True})
        corrected = {**self.source_issue(), 'sourceReportDate': '2026-09-22'}
        self.publish([corrected], ['operational'])
        row = self.row()
        self.assertEqual(row['payload']['presentation']['date'], '2026-09-22')
        self.assertEqual(row['unread'], 0)
        self.assertTrue(row['acknowledged_at'])
        self.assertEqual(row['payload']['materialRevision'], 1)

    def test_new_edition_does_not_replace_prior_publication_incident(self):
        old = self.review_issue('old-one')
        self.store.dispatch('finding', {'finding': old})
        later = {**self.source_issue(), 'incidentKey': 'research-product:early-look:2026-09-23'}
        self.publish([later], ['operational'])
        rows = self.store.dispatch('findings', {})['findings']
        self.assertEqual(sum(row['state'] == 'open' for row in rows), 2)
        self.assertFalse(any(row['payload'].get('affectedReviews') for row in rows))

    def test_processing_failure_without_quality_evidence_does_not_take_over_review(self):
        old = self.review_issue('old-one')
        self.store.dispatch('finding', {'finding': old})
        current = self.source_issue()
        current.pop('sourceDiscrepancy')
        current.pop('sourceQuality')
        self.publish([current], ['operational'])
        self.assertEqual(len(self.store.dispatch('findings', {})['findings']), 1)
        self.assertEqual(self.row()['id'], old['id'])


    def test_action_required_dismisses_without_a_reason_and_survives_holdings_outage(self):
        urgent = {**finding(), 'severity': 'action-required'}
        self.publish([urgent], ['portfolio'])
        # Reading alone never clears an urgent instruction.
        self.assertEqual(self.store.dispatch('finding-read', {'id': urgent['id']})['acknowledged'], False)
        self.assertEqual(self.row()['unread'], 1)
        # An incomplete scan (holdings unavailable) does not hide the instruction.
        self.publish([], [])
        self.assertEqual(self.row()['state'], 'open')
        self.assertEqual(self.row()['unread'], 1)
        dismissed = self.store.dispatch('finding-read', {'id': urgent['id'], 'acknowledge': True, 'fingerprint': 'same'})
        self.assertTrue(dismissed['acknowledged'])
        self.publish([urgent], ['portfolio'])
        self.assertEqual(self.row()['unread'], 0)
        self.assertNotIn('reason', self.row()['payload']['kept'])
        # A complete scan without the instruction (position closed) resolves it.
        self.publish([], ['portfolio'])
        self.assertEqual(self.row()['state'], 'resolved')


if __name__ == '__main__':
    unittest.main()
