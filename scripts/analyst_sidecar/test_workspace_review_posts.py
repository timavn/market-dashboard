from pathlib import Path
import tempfile
import unittest

from workspace import WorkspaceStore


class WorkspaceReviewPostTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = WorkspaceStore(Path(self.temp.name) / 'workspace.sqlite3')

    def tearDown(self):
        self.temp.cleanup()

    def daily(self, kind='portfolio-review'):
        return self.store.dispatch('daily', {
            'kind': kind, 'date': '2026-09-18', 'title': kind,
        })['conversation']['id']

    def complete(self, cid, request, post=None, internal=True, state='complete', text=None):
        accepted = self.store.dispatch('accept', {
            'conversationId': cid, 'requestId': request, 'text': 'Review request',
            'internalPrompt': internal, 'reviewPostId': post,
        })
        self.store.dispatch('frame', {
            'turnId': accepted['turn']['id'], 'type': state, 'text': request if text is None else text,
        })
        return self.store.dispatch('get', {'conversationId': cid})['conversation']['messages'][-1]

    def managed_accept(self, cid, run='fresh-capture', post='fresh-post', kind='portfolio-review', **record_changes):
        record = {'runId': run, 'kind': kind, 'reviewPostId': post,
                  'reviewPhase': 'queued', 'reviewState': 'queued', 'startPending': True,
                  **record_changes}
        return self.store.dispatch('accept', {
            'conversationId': cid, 'requestId': 'daily-turn:' + run,
            'text': 'Prepare Portfolio Review', 'internalPrompt': True,
            'reviewPostId': post, 'reviewRecord': record,
        })

    def test_active_managed_portfolio_placeholder_owns_new_capture_before_first_frame(self):
        cid = self.daily()
        old = self.complete(cid, 'daily-turn:older-capture', post='older-post')
        accepted = self.managed_accept(cid)
        messages = accepted['conversation']['messages']
        self.assertEqual(len(messages), 2)
        self.assertEqual(messages[0]['id'], old['id'])
        self.assertEqual(messages[0]['reviewRunId'], 'older-capture')
        placeholder = messages[1]
        with self.store.connect() as db:
            stored = dict(db.execute("SELECT * FROM messages WHERE turn_id=? AND role='assistant'",
                                     (accepted['turn']['id'],)).fetchone())
            counts = [db.execute('SELECT count(*) FROM ' + table).fetchone()[0]
                      for table in ('conversations', 'turns', 'messages')]
        self.assertEqual(placeholder['id'], stored['id'])
        self.assertEqual(placeholder['turn_id'], accepted['conversation']['activeTurn']['id'])
        self.assertEqual(placeholder['text'], '')
        self.assertEqual(placeholder['state'], stored['state'])
        self.assertEqual(placeholder['reviewRunId'], 'fresh-capture')
        self.assertEqual(placeholder['reviewPostId'], 'fresh-post')
        self.assertEqual(placeholder['reviewState'], 'accepted')
        self.assertFalse(placeholder['reviewNarrative'])
        restarted = WorkspaceStore(self.store.path)
        self.assertEqual(restarted.dispatch('get', {'conversationId': cid})['conversation']['messages'], messages)
        with self.store.connect() as db:
            self.assertEqual([db.execute('SELECT count(*) FROM ' + table).fetchone()[0]
                              for table in ('conversations', 'turns', 'messages')], counts)

    def test_unbound_chat_and_other_review_placeholders_stay_hidden(self):
        ordinary = self.store.dispatch('accept', {'requestId': 'ordinary-chat', 'text': 'Hello'})
        self.assertEqual([m['role'] for m in ordinary['conversation']['messages']], ['user'])
        for kind in ('portfolio-review', 'balance-review', 'prediction-markets-review'):
            with self.subTest(kind=kind):
                cid = self.daily(kind)
                accepted = self.store.dispatch('accept', {
                    'conversationId': cid, 'requestId': 'daily-turn:unbound-' + kind,
                    'text': 'Prepare review', 'internalPrompt': True,
                })
                self.assertEqual(accepted['conversation']['messages'], [])
                self.store.dispatch('frame', {'turnId': accepted['turn']['id'], 'type': 'complete'})

    def test_active_managed_balance_placeholder_owns_only_its_current_capture(self):
        cid = self.daily('balance-review')
        older = self.complete(cid, 'daily-turn:older-balance', post='older-post')
        accepted = self.managed_accept(cid, kind='balance-review')
        messages = accepted['conversation']['messages']
        self.assertEqual(len(messages), 2)
        self.assertEqual(messages[0]['id'], older['id'])
        primary = messages[-1]
        self.assertEqual(primary['turn_id'], accepted['turn']['id'])
        self.assertEqual(primary['reviewRunId'], 'fresh-capture')
        self.assertEqual(primary['reviewPostId'], 'fresh-post')
        self.assertEqual(primary['text'], '')
        self.assertFalse(primary['reviewNarrative'])
        with self.store.connect() as db:
            counts = [db.execute('SELECT count(*) FROM ' + table).fetchone()[0]
                      for table in ('conversations', 'turns', 'messages')]
        restarted = WorkspaceStore(self.store.path)
        self.assertEqual(restarted.dispatch('get', {'conversationId': cid})['conversation']['messages'], messages)
        with self.store.connect() as db:
            self.assertEqual([db.execute('SELECT count(*) FROM ' + table).fetchone()[0]
                              for table in ('conversations', 'turns', 'messages')], counts)

    def test_predictive_accepted_capture_owns_sources_and_exposes_the_exact_request_receipt(self):
        cid = self.daily('prediction-markets-review')
        older = self.complete(cid, 'daily-turn:older-predictive', post='older-post')
        accepted = self.managed_accept(cid, kind='prediction-markets-review', reviewRequestId='predictive-button-click')
        conversation = accepted['conversation']
        self.assertEqual(conversation['reviewRequestId'], 'predictive-button-click')
        self.assertEqual(conversation['reviewPhase'], 'queued')
        self.assertEqual(len(conversation['messages']), 2)
        self.assertEqual(conversation['messages'][0]['id'], older['id'])
        placeholder = conversation['messages'][-1]
        self.assertEqual(placeholder['text'], '')
        self.assertEqual(placeholder['reviewRunId'], 'fresh-capture')
        self.assertEqual(placeholder['reviewPostId'], 'fresh-post')
        self.assertEqual(placeholder['turn_id'], conversation['activeTurn']['id'])
        listed = next(row for row in self.store.dispatch('list', {})['conversations'] if row['id'] == cid)
        self.assertEqual((listed['reviewRequestId'], listed['reviewRunId']), ('predictive-button-click', 'fresh-capture'))
        reopened = WorkspaceStore(self.store.path).dispatch('get', {'conversationId': cid})['conversation']
        self.assertEqual(reopened['messages'], conversation['messages'])
        self.assertEqual(reopened['reviewRequestId'], 'predictive-button-click')
        self.store.dispatch('frame', {'turnId': accepted['turn']['id'], 'type': 'failed', 'text': 'IB Gateway is unavailable.'})
        settled = self.store.dispatch('get', {'conversationId': cid})['conversation']
        self.assertIsNone(settled['activeTurn'])
        self.assertEqual(settled['reviewPhase'], 'terminal')
        self.assertEqual(settled['reviewRequestId'], 'predictive-button-click')

    def test_predictive_wrong_or_terminal_dispatch_never_owns_an_empty_capture(self):
        cid = self.daily('prediction-markets-review')
        for index, changes in enumerate((
                {'runId': 'wrong'}, {'turnId': 'wrong'}, {'reviewPostId': 'wrong'},
                {'kind': 'portfolio-review'}, {'reviewPhase': 'terminal'}, {'reviewState': 'succeeded'},
                {'completedAt': '2026-10-09T00:00:00Z'}, {'error': True})):
            with self.subTest(changes=changes):
                accepted = self.managed_accept(cid, run=f'predictive-{index}', kind='prediction-markets-review')
                key = 'daily-run:' + cid
                record = self.store.dispatch('setting', {'key': key})['value']
                self.store.dispatch('setting', {'key': key, 'value': {**record, **changes}})
                self.assertEqual(self.store.dispatch('get', {'conversationId': cid})['conversation']['messages'], [])
                self.store.dispatch('frame', {'turnId': accepted['turn']['id'], 'type': 'complete'})

    def test_balance_wrong_terminal_and_cancelled_bindings_hide_the_blank_capture(self):
        cid = self.daily('balance-review')
        for index, changes in enumerate((
                {'runId': 'wrong'}, {'turnId': 'wrong'}, {'reviewPostId': 'wrong'},
                {'kind': 'portfolio-review'}, {'reviewPhase': 'terminal'}, {'reviewState': 'succeeded'},
                {'completedAt': '2026-09-18T20:00:00Z'}, {'error': True})):
            with self.subTest(changes=changes):
                accepted = self.managed_accept(cid, run='balance-' + str(index), kind='balance-review')
                key = 'daily-run:' + cid
                record = self.store.dispatch('setting', {'key': key})['value']
                self.store.dispatch('setting', {'key': key, 'value': {**record, **changes}})
                self.assertEqual(self.store.dispatch('get', {'conversationId': cid})['conversation']['messages'], [])
                self.store.dispatch('frame', {'turnId': accepted['turn']['id'], 'type': 'complete'})
        accepted = self.managed_accept(cid, run='stopped-balance', kind='balance-review')
        self.store.dispatch('frame', {'turnId': accepted['turn']['id'], 'type': 'interrupted'})
        self.assertEqual(self.store.dispatch('get', {'conversationId': cid})['conversation']['messages'], [])
        self.store.dispatch('delete', {'conversationId': cid})
        with self.assertRaises(KeyError):
            self.store.dispatch('get', {'conversationId': cid})

    def test_wrong_or_terminal_dispatch_bindings_do_not_expose_blank_report(self):
        cid = self.daily()
        for index, changes in enumerate((
                {'runId': 'different-run'}, {'turnId': 'different-turn'}, {'reviewPostId': 'different-post'},
                {'reviewPhase': 'terminal'}, {'reviewState': 'succeeded'}, {'completedAt': '2026-09-18T20:00:00Z'},
                {'error': True}, {'reviewPhase': None}, {'reviewState': None})):
            with self.subTest(changes=changes):
                accepted = self.managed_accept(cid, run='binding-' + str(index))
                key = 'daily-run:' + cid
                record = self.store.dispatch('setting', {'key': key})['value']
                self.store.dispatch('setting', {'key': key, 'value': {**record, **changes}})
                self.assertEqual(self.store.dispatch('get', {'conversationId': cid})['conversation']['messages'], [])
                self.store.dispatch('frame', {'turnId': accepted['turn']['id'], 'type': 'complete'})

    def test_terminal_stopped_deleted_and_narrative_blanks_stay_hidden(self):
        cid = self.daily()
        for index, state in enumerate(('complete', 'failed', 'interrupted')):
            accepted = self.managed_accept(cid, run='terminal-' + str(index))
            self.store.dispatch('frame', {'turnId': accepted['turn']['id'], 'type': state})
            self.assertEqual(self.store.dispatch('get', {'conversationId': cid})['conversation']['messages'], [])
        acquired = self.managed_accept(cid, run='narrative-source')
        self.store.dispatch('frame', {'turnId': acquired['turn']['id'], 'type': 'complete', 'text': 'Captured report'})
        narrative = self.store.dispatch('accept', {
            'conversationId': cid, 'requestId': 'daily-narrative:narrative-source',
            'text': 'Explain report', 'internalPrompt': True, 'reviewPostId': 'fresh-post',
        })
        self.store.dispatch('setting', {'key': 'daily-run:' + cid, 'value': {
            'runId': 'narrative-source', 'kind': 'portfolio-review', 'reviewPostId': 'fresh-post',
            'turnId': acquired['turn']['id'], 'narrativeTurnId': narrative['turn']['id'],
            'reviewPhase': 'summarizing', 'reviewState': 'running',
        }})
        messages = self.store.dispatch('get', {'conversationId': cid})['conversation']['messages']
        self.assertEqual([m['text'] for m in messages], ['Captured report'])
        self.store.dispatch('delete', {'conversationId': cid})
        with self.assertRaises(KeyError):
            self.store.dispatch('get', {'conversationId': cid})

    def test_legacy_daily_reports_and_narratives_share_base_post_and_original_run(self):
        for kind in ('portfolio-review', 'balance-review', 'prediction-markets-review'):
            with self.subTest(kind=kind):
                cid = self.daily(kind)
                run_id = f'{kind}-run'
                report = self.complete(cid, 'daily-turn:' + run_id)
                notes = self.complete(cid, 'daily-narrative:' + run_id)
                for message in (report, notes):
                    self.assertEqual(message['reviewPostId'], 'base')
                    self.assertEqual(message['reviewRunId'], run_id)
                    self.assertEqual(message['reviewState'], 'complete')
                self.assertFalse(report['reviewNarrative'])
                self.assertTrue(notes['reviewNarrative'])

    def test_explicit_posts_keep_their_identity_through_automatic_revisions_and_reload(self):
        cid = self.daily()
        expected = []
        for post, run in [('base', 'first'), ('requested-second', 'second'), ('requested-second', 'third')]:
            for prefix in ('daily-turn:', 'daily-narrative:'):
                self.complete(cid, prefix + run, post=post)
                expected.append((post, run, prefix == 'daily-narrative:'))
        self.store = WorkspaceStore(self.store.path)
        messages = self.store.dispatch('get', {'conversationId': cid})['conversation']['messages']
        self.assertEqual([(m['reviewPostId'], m['reviewRunId'], m['reviewNarrative']) for m in messages], expected)
        self.assertEqual(self.store.dispatch('list', {})['conversations'][0]['message_count'], 2)

    def test_retry_narrative_keeps_requested_post_and_original_run(self):
        cid = self.daily('balance-review')
        self.complete(cid, 'daily-turn:run-1', post='requested-post')
        accepted = self.store.dispatch('accept', {
            'conversationId': cid, 'requestId': 'daily-narrative:run-1',
            'text': 'Explain review', 'internalPrompt': True, 'reviewPostId': 'requested-post',
        })
        self.store.dispatch('frame', {
            'turnId': accepted['turn']['id'], 'type': 'failed', 'error': 'Unavailable',
        })
        retry = self.store.dispatch('retry-data', {'conversationId': cid, 'turnId': accepted['turn']['id']})
        self.assertEqual(retry['reviewPostId'], 'requested-post')
        for request in ('narrative-retry:arbitrary-retry-uuid', 'another-retry-uuid'):
            with self.subTest(request=request):
                notes = self.complete(cid, request, post=retry['reviewPostId'], internal=retry['internalPrompt'])
                self.assertEqual(notes['reviewPostId'], 'requested-post')
                self.assertEqual(notes.get('reviewRunId'), 'run-1')
                self.assertTrue(notes['reviewNarrative'])
        self.assertEqual(self.store.dispatch('list', {})['conversations'][0]['message_count'], 1)

    def test_imported_source_reports_get_original_run_metadata_without_a_turn(self):
        cid = self.daily('prediction-markets-review')
        for source in ('daily-report:imported-run', 'review-message:imported-run:assistant'):
            self.store.dispatch('append', {
                'conversationId': cid, 'sourceId': source, 'text': source,
            })
        messages = self.store.dispatch('get', {'conversationId': cid})['conversation']['messages']
        self.assertEqual(len(messages), 2)
        for message in messages:
            self.assertEqual(message['reviewPostId'], 'base')
            self.assertEqual(message['reviewRunId'], 'imported-run')
            self.assertEqual(message['reviewState'], 'complete')
            self.assertFalse(message['reviewNarrative'])

    def test_review_state_comes_from_durable_turns_and_survives_reload(self):
        cid = self.daily('balance-review')
        for state in ('complete', 'failed', 'interrupted'):
            message = self.complete(cid, 'daily-turn:' + state, post='base', state=state)
            self.assertEqual(message['reviewState'], state)
        self.store = WorkspaceStore(self.store.path)
        messages = self.store.dispatch('get', {'conversationId': cid})['conversation']['messages']
        self.assertEqual([message['reviewState'] for message in messages], ['complete', 'failed', 'interrupted'])
        self.assertEqual(self.store.dispatch('list', {})['conversations'][0]['message_count'], 1)

    def test_only_exact_legacy_internal_report_notices_get_unchanged_metadata(self):
        cid = self.daily('balance-review')
        notice = 'Fresh inputs checked at 2026-09-18T18:00:00.000Z. No material changes to the preceding review.'
        report = self.complete(cid, 'daily-turn:unchanged', text=notice)
        self.assertTrue(report['reviewUnchanged'])
        for request, text, internal in [
            ('daily-narrative:unchanged', notice, True),
            ('daily-turn:near-match', notice + ' Funding has changed.', True),
            ('daily-turn:manual', notice, False),
        ]:
            with self.subTest(request=request):
                message = self.complete(cid, request, text=text, internal=internal)
                self.assertFalse(message['reviewUnchanged'])
        for source, unchanged in [('daily-report:imported', True), ('review-message:imported:assistant', False)]:
            self.store.dispatch('append', {'conversationId': cid, 'sourceId': source, 'text': notice})
            message = self.store.dispatch('get', {'conversationId': cid})['conversation']['messages'][-1]
            self.assertEqual(message['reviewUnchanged'], unchanged)

    def test_ordinary_dialogue_with_legacy_notice_text_has_no_review_metadata(self):
        cid = self.daily('balance-review')
        notice = 'Fresh inputs checked at 2026-09-18T18:00:00.000Z. No material changes to the preceding review.'
        self.complete(cid, 'ordinary-followup', internal=False, text=notice)
        messages = self.store.dispatch('get', {'conversationId': cid})['conversation']['messages']
        for message in messages:
            self.assertNotIn('reviewState', message)
            self.assertNotIn('reviewUnchanged', message)

    def test_real_dialogue_is_not_tagged_as_a_review_post_or_narrative(self):
        cid = self.daily()
        self.complete(cid, 'daily-turn:run-1', post='base')
        self.complete(cid, 'real-followup', internal=False)
        messages = self.store.dispatch('get', {'conversationId': cid})['conversation']['messages']
        self.assertEqual([message['role'] for message in messages], ['assistant', 'user', 'assistant'])
        for message in messages[1:]:
            self.assertNotIn('reviewPostId', message)
            self.assertNotIn('reviewRunId', message)
            self.assertNotIn('reviewState', message)
            self.assertNotIn('reviewUnchanged', message)
            self.assertFalse(message['reviewNarrative'])
        self.assertEqual(self.store.dispatch('list', {})['conversations'][0]['message_count'], 3)

    def test_user_role_never_inherits_review_metadata_from_a_tagged_turn(self):
        cid = self.daily()
        self.complete(cid, 'manual-review', post='requested-post', internal=False)
        user = self.store.dispatch('get', {'conversationId': cid})['conversation']['messages'][0]
        self.assertEqual(user['role'], 'user')
        self.assertNotIn('reviewPostId', user)
        self.assertNotIn('reviewRunId', user)
        self.assertFalse(user['reviewNarrative'])


if __name__ == '__main__':
    unittest.main()
