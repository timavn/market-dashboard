import concurrent.futures
from contextlib import contextmanager
import sqlite3
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from workspace import WorkspaceStore


class WorkspaceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = WorkspaceStore(Path(self.temp.name) / 'workspace.sqlite3')

    def tearDown(self):
        self.temp.cleanup()

    def accept(self, request='r1', text='Hello', cid=None):
        return self.store.dispatch('accept', {'requestId': request, 'text': text, 'conversationId': cid})

    @contextmanager
    def concurrent_commit_before_cursor(self, callback):
        fired = []
        class InterleavedConnection(sqlite3.Connection):
            def execute(connection, sql, parameters=()):
                if sql == 'SELECT coalesce(max(seq),0) FROM events' and not fired:
                    fired.append(True)
                    callback()
                return super().execute(sql, parameters)

        @contextmanager
        def connect():
            db = sqlite3.connect(self.store.path, timeout=15, factory=InterleavedConnection)
            db.row_factory = sqlite3.Row
            try:
                with db:
                    yield db
            finally:
                db.close()
        with patch.object(self.store, 'connect', connect):
            yield
        self.assertTrue(fired)

    def test_list_rows_and_cursor_share_a_snapshot_during_a_concurrent_commit(self):
        first = self.accept()
        before = self.store.dispatch('list', {})['cursor']
        writer = WorkspaceStore(self.store.path)
        with self.concurrent_commit_before_cursor(lambda: writer.dispatch('accept', {'requestId': 'concurrent', 'text': 'New chat'})):
            result = self.store.dispatch('list', {})
        self.assertEqual(result['cursor'], before)
        self.assertEqual([row['id'] for row in result['conversations']], [first['conversation']['id']])
        replay = self.store.dispatch('events', {'after': result['cursor']})['events']
        self.assertEqual([event['type'] for event in replay], ['accepted'])

    def test_event_cursor_reads_only_the_high_water_mark_and_preserves_later_events(self):
        self.assertEqual(self.store.dispatch('event-cursor', {}), {'cursor': 0})
        accepted = self.accept()
        expected = self.store.dispatch('list', {})['cursor']
        with patch.object(self.store, 'conversation', side_effect=AssertionError('No history hydration')):
            cursor = self.store.dispatch('event-cursor', {})['cursor']
        self.assertEqual(cursor, expected)
        self.assertEqual(self.store.dispatch('events', {'after': cursor})['events'], [])
        self.store.dispatch('frame', {'turnId': accepted['turn']['id'], 'type': 'complete', 'text': 'Saved final'})
        events = self.store.dispatch('events', {'after': cursor})['events']
        self.assertEqual([event['type'] for event in events], ['complete'])
        self.assertGreater(self.store.dispatch('event-cursor', {})['cursor'], cursor)

    def test_detail_and_cursor_share_a_snapshot_during_concurrent_completion(self):
        accepted = self.accept()
        before = self.store.dispatch('list', {})['cursor']
        writer = WorkspaceStore(self.store.path)
        with self.concurrent_commit_before_cursor(lambda: writer.dispatch('frame', {
                'turnId': accepted['turn']['id'], 'type': 'complete', 'text': 'Saved final'})):
            result = self.store.dispatch('get', {'conversationId': accepted['conversation']['id']})
        self.assertEqual(result['cursor'], before)
        self.assertEqual(result['conversation']['lastTurn']['state'], 'accepted')
        self.assertEqual(result['conversation']['messages'][-1]['role'], 'user')
        self.assertEqual([event['type'] for event in self.store.dispatch('events', {'after': before})['events']], ['complete'])

    def test_source_binding_uses_captured_priority_without_message_or_report_projection(self):
        conversation = self.store.dispatch('daily', {'kind': 'portfolio-review', 'date': '2026-10-05', 'title': 'Portfolio Review'})['conversation']
        cid = conversation['id']
        self.store.dispatch('append', {'conversationId': cid, 'sourceId': 'daily-report:original', 'text': 'Large report' * 1000})
        with patch.object(self.store, 'conversation', side_effect=AssertionError('Source binding must not hydrate message history')):
            binding = self.store.dispatch('source-binding', {'conversationId': cid})
            self.assertEqual(binding['runId'], 'original')
            self.assertEqual(binding['conversation'], {'id': cid, 'kind': 'portfolio-review', 'activeTurn': None})
            self.store.dispatch('setting', {'key': 'portfolio-reference:' + cid, 'value': {'runId': 'reference'}})
            self.assertEqual(self.store.dispatch('source-binding', {'conversationId': cid})['runId'], 'reference')
            self.store.dispatch('setting', {'key': 'daily-run:' + cid, 'value': {'runId': 'latest'}})
            self.assertEqual(self.store.dispatch('source-binding', {'conversationId': cid})['runId'], 'latest')
        self.store.dispatch('delete', {'conversationId': cid})
        with self.assertRaises(KeyError):
            self.store.dispatch('source-binding', {'conversationId': cid})

    def review_turn(self, run_id='capture'):
        cid = self.store.dispatch('daily', {'kind': 'portfolio-review', 'date': '2026-10-05', 'title': 'Portfolio Review'})['conversation']['id']
        accepted = self.store.dispatch('accept', {'conversationId': cid, 'requestId': 'daily-turn:' + run_id,
                                                'text': 'Run review', 'internalPrompt': True, 'reviewPostId': run_id})
        self.store.dispatch('setting', {'key': 'daily-run:' + cid, 'value': {'runId': run_id, 'turnId': accepted['turn']['id']}})
        self.store.dispatch('setting', {'key': f'review-post:{cid}:{run_id}', 'value': {'runId': run_id}})
        return accepted

    def test_queued_review_acceptance_commits_dispatch_and_request_binding_together(self):
        cid = self.store.dispatch('daily', {'kind': 'balance-review', 'date': '2026-10-06', 'title': 'Balance Review'})['conversation']['id']
        record = {'runId': 'queued-run', 'kind': 'balance-review', 'reviewPostId': 'base',
                  'reviewPhase': 'queued', 'reviewState': 'queued', 'startPending': True,
                  'startRequest': {'requestId': 'stable-start'}}
        params = {'conversationId': cid, 'requestId': 'daily-turn:queued-run', 'text': 'Prepare Balance Review',
                  'internalPrompt': True, 'reviewPostId': 'base', 'reviewRecord': record,
                  'reviewRequestBinding': {'key': 'daily-request:stable-start',
                      'value': {'conversationId': cid, 'runId': 'queued-run'}}}
        accepted = self.store.dispatch('accept', params)
        self.assertEqual(accepted['conversation']['reviewPhase'], 'queued')
        self.assertEqual(accepted['conversation']['reviewRunId'], 'queued-run')
        saved = self.store.dispatch('setting', {'key': 'daily-run:' + cid})['value']
        self.assertEqual(saved['turnId'], accepted['turn']['id'])
        binding = self.store.dispatch('setting', {'key': 'daily-request:stable-start'})['value']
        self.assertEqual(binding['turnId'], accepted['turn']['id'])
        self.assertTrue(self.store.dispatch('source-binding', {'conversationId': cid})['conversation']['reviewStartPending'])
        self.assertFalse(self.store.dispatch('accept', params)['created'])
        restarted = WorkspaceStore(self.store.path)
        self.assertEqual(restarted.dispatch('recover', {'resumeReviews': True}), {'recovered': 0})
        self.assertEqual(restarted.dispatch('get', {'conversationId': cid})['conversation']['activeTurn']['id'], accepted['turn']['id'])

    def test_review_progress_uses_only_latest_bound_turn_and_metadata_list(self):
        accepted = self.review_turn()
        cid, tid = accepted['conversation']['id'], accepted['turn']['id']
        record = {'runId': 'capture', 'turnId': tid, 'kind': 'portfolio-review', 'reviewPhase': 'acquiring', 'reviewState': 'running'}
        before = self.store.dispatch('list', {})['cursor']
        self.store.dispatch('setting', {'key': 'daily-run:' + cid, 'value': record})
        self.assertEqual([event['type'] for event in self.store.dispatch('events', {'after': before})['events']], ['revision'])
        before = self.store.dispatch('list', {})['cursor']
        self.store.dispatch('setting', {'key': 'daily-run:' + cid, 'value': {**record, 'unrelatedDiagnostic': 2}})
        self.assertEqual(self.store.dispatch('events', {'after': before})['events'], [])
        with patch.object(self.store, 'conversation', side_effect=AssertionError('Sidebar must not hydrate reports')):
            row = self.store.dispatch('list', {})['conversations'][0]
        self.assertEqual(row['reviewPhase'], 'acquiring')
        self.assertEqual(row['reviewRunId'], 'capture')
        self.store.dispatch('frame', {'turnId': tid, 'type': 'complete', 'text': 'Saved review'})
        self.assertEqual(self.store.dispatch('get', {'conversationId': cid})['conversation']['reviewPhase'], 'terminal')
        self.accept('followup', 'Explain the review', cid)
        self.assertNotIn('reviewPhase', self.store.dispatch('get', {'conversationId': cid})['conversation'])

    def test_recovery_does_not_preserve_mismatched_or_completed_review_dispatches(self):
        accepted = self.review_turn()
        cid, tid = accepted['conversation']['id'], accepted['turn']['id']
        for record in ({'runId': 'wrong', 'turnId': tid}, {'runId': 'capture', 'turnId': tid, 'completedAt': '2026-10-06T20:00:00Z'}):
            with self.subTest(record=record):
                with self.store.connect() as db:
                    db.execute("UPDATE turns SET state='accepted' WHERE id=?", (tid,))
                self.store.dispatch('setting', {'key': 'daily-run:' + cid, 'value': record})
                self.assertEqual(self.store.dispatch('recover', {'resumeReviews': True}), {'recovered': 1})

    def test_bound_narrative_phase_does_not_relabel_or_resume_an_unowned_model_turn(self):
        accepted = self.review_turn()
        cid, tid = accepted['conversation']['id'], accepted['turn']['id']
        self.store.dispatch('frame', {'turnId': tid, 'type': 'complete', 'text': 'Verified report'})
        narrative = self.store.dispatch('accept', {'conversationId': cid, 'requestId': 'daily-narrative:capture',
            'text': 'Summarize the capture', 'internalPrompt': True, 'reviewPostId': 'base'})
        record = {'runId': 'capture', 'turnId': tid, 'narrativeTurnId': narrative['turn']['id'],
                  'reviewPhase': 'terminal', 'completedAt': '2026-10-06T20:00:00Z'}
        self.store.dispatch('setting', {'key': 'daily-run:' + cid, 'value': record})
        self.assertEqual(self.store.dispatch('get', {'conversationId': cid})['conversation']['reviewPhase'], 'summarizing')
        self.assertEqual(self.store.dispatch('list', {})['conversations'][0]['reviewPhase'], 'summarizing')
        self.assertEqual(self.store.dispatch('recover', {'resumeReviews': True}), {'recovered': 1})
        self.assertEqual(self.store.dispatch('get', {'conversationId': cid})['conversation']['reviewPhase'], 'terminal')

    def test_invalid_review_dispatch_rolls_back_turn_and_bindings(self):
        cid = self.store.dispatch('daily', {'kind': 'balance-review', 'date': '2026-10-06', 'title': 'Balance Review'})['conversation']['id']
        with self.assertRaisesRegex(ValueError, 'accepted turn'):
            self.store.dispatch('accept', {'conversationId': cid, 'requestId': 'daily-turn:wrong', 'text': 'Prepare review',
                'internalPrompt': True, 'reviewPostId': 'base',
                'reviewRecord': {'runId': 'capture', 'kind': 'balance-review', 'reviewPostId': 'base'}})
        self.assertIsNone(self.store.dispatch('get', {'conversationId': cid})['conversation']['activeTurn'])
        self.assertIsNone(self.store.dispatch('setting', {'key': 'daily-run:' + cid})['value'])

    def test_review_summary_cannot_start_after_its_acquisition_turn_was_replaced(self):
        accepted = self.review_turn()
        cid, tid = accepted['conversation']['id'], accepted['turn']['id']
        self.store.dispatch('frame', {'turnId': tid, 'type': 'complete', 'text': 'Captured review'})
        replacement = self.accept('replacement', 'Refresh review', cid)
        self.store.dispatch('frame', {'turnId': replacement['turn']['id'], 'type': 'complete', 'text': 'New capture'})
        with self.assertRaisesRegex(ValueError, 'replaced before its summary'):
            self.store.dispatch('accept', {'conversationId': cid, 'requestId': 'daily-narrative:capture',
                'text': 'Summarize the original capture', 'internalPrompt': True, 'expectedLastTurnId': tid})
        current = self.store.dispatch('get', {'conversationId': cid})['conversation']
        self.assertEqual(current['lastTurn']['id'], replacement['turn']['id'])
        self.assertIsNone(current['activeTurn'])

    def test_conditional_dispatch_write_cannot_erase_replacement_or_requeue_stopped_run(self):
        accepted = self.review_turn()
        cid, tid = accepted['conversation']['id'], accepted['turn']['id']
        key = 'daily-run:' + cid
        stopped = {'runId': 'capture', 'turnId': tid, 'reviewPhase': 'terminal',
                   'completedAt': '2026-10-06T20:00:00Z', 'error': True}
        self.store.dispatch('setting', {'key': key, 'value': stopped})
        stale = {'key': key, 'expectedRunId': 'capture', 'expectedTurnId': tid,
                 'value': {'runId': 'capture', 'turnId': tid, 'reviewPhase': 'acquiring'}}
        self.assertTrue(self.store.dispatch('setting', stale)['ignored'])
        self.assertEqual(self.store.dispatch('setting', {'key': key})['value'], stopped)
        replacement = {'runId': 'replacement', 'turnId': 'replacement-turn', 'reviewPhase': 'queued'}
        self.store.dispatch('setting', {'key': key, 'value': replacement})
        self.assertTrue(self.store.dispatch('setting', {**stale, 'value': stopped})['ignored'])
        self.assertEqual(self.store.dispatch('setting', {'key': key})['value'], replacement)
        change = self.store.dispatch('setting', {'key': key, 'expectedRunId': 'replacement', 'expectedTurnId': 'replacement-turn',
            'value': {**replacement, 'reviewPhase': 'acquiring'}})
        self.assertEqual(change['value']['reviewPhase'], 'acquiring')

    def test_verified_progress_replaces_one_bound_report_and_finalizes_the_same_message(self):
        accepted = self.review_turn()
        cid, tid = accepted['conversation']['id'], accepted['turn']['id']
        citation = {'id': 'captured', 'publicationDate': '2026-10-05', 'sourceUri': 'gmail://message/original'}
        progress = {'turnId': tid, 'type': 'progress', 'runId': 'capture', 'text': 'Verified first section',
                    'reportRevision': 'first', 'citations': [citation]}
        self.store.dispatch('frame', progress)
        first = self.store.dispatch('get', {'conversationId': cid})['conversation']
        self.assertEqual(first['lastTurn']['state'], 'running')
        self.assertEqual(first['messages'][-1]['state'], 'reviewing')
        self.assertEqual(first['messages'][-1]['reviewRunId'], 'capture')
        self.store.dispatch('frame', {**progress, 'text': 'Verified replacement', 'reportRevision': 'second'})
        second = self.store.dispatch('get', {'conversationId': cid})['conversation']
        self.assertEqual(len(second['messages']), 1)
        self.assertEqual(second['messages'][-1]['text'], 'Verified replacement')
        self.assertEqual(second['messages'][-1]['id'], first['messages'][-1]['id'])
        self.store.dispatch('frame', {'turnId': tid, 'type': 'complete', 'text': 'Complete captured review', 'citations': []})
        final = self.store.dispatch('get', {'conversationId': cid})['conversation']
        self.assertEqual(final['messages'][-1]['id'], first['messages'][-1]['id'])
        self.assertEqual(final['messages'][-1]['citations'], [])
        self.assertEqual(final['lastTurn']['state'], 'complete')
        self.assertIsNone(final['activeTurn'])
        self.assertEqual(self.store.dispatch('frame', progress), {'ignored': True})
        events = self.store.dispatch('events', {})['events']
        self.assertEqual([event['type'] for event in events if event['type'] in {'progress', 'complete'}], ['progress', 'progress', 'complete'])

    def test_failure_after_published_progress_keeps_the_report_and_appends_one_status_line(self):
        status = 'Review interrupted: the server deadline passed before every source finished. Refresh to retry with fresh evidence.'
        one_line = 'Review interrupted: The review did not finish within its server deadline. Open today’s review to retry with fresh evidence.'
        failed = {'type': 'failed', 'text': one_line, 'citations': [{'id': 'newer-unpublished'}],
                  'error': 'The review did not finish within its server deadline.', 'partialStatus': status + '\n'}
        accepted = self.review_turn()
        cid, tid = accepted['conversation']['id'], accepted['turn']['id']
        citation = {'id': 'captured', 'publicationDate': '2026-10-05'}
        self.store.dispatch('frame', {'turnId': tid, 'type': 'progress', 'runId': 'capture', 'text': 'Verified first section\n',
                                      'reportRevision': 'first', 'citations': [citation]})
        self.store.dispatch('frame', {**failed, 'turnId': tid})
        kept = self.store.dispatch('get', {'conversationId': cid})['conversation']
        self.assertEqual(kept['messages'][-1]['text'], 'Verified first section\n\n' + status)
        self.assertEqual(kept['messages'][-1]['citations'], [citation])
        self.assertEqual(kept['messages'][-1]['state'], 'failed')
        self.assertEqual(kept['lastTurn']['state'], 'failed')
        self.assertIsNone(kept['activeTurn'])
        # Without a published revision the failure text replaces the placeholder, as before.
        other = self.review_turn('second-capture')
        self.store.dispatch('frame', {**failed, 'turnId': other['turn']['id']})
        replaced = self.store.dispatch('get', {'conversationId': other['conversation']['id']})['conversation']
        self.assertEqual(replaced['messages'][-1]['text'], one_line)
        self.assertEqual(replaced['messages'][-1]['citations'], [{'id': 'newer-unpublished'}])
        # Streamed chat text is not a published review revision.
        chat = self.accept(request='chat', text='Question')
        self.store.dispatch('frame', {'turnId': chat['turn']['id'], 'type': 'delta', 'text': 'Partial answer'})
        self.store.dispatch('frame', {**failed, 'turnId': chat['turn']['id']})
        answer = self.store.dispatch('get', {'conversationId': chat['conversation']['id']})['conversation']
        self.assertEqual(answer['messages'][-1]['text'], one_line)

    def test_progress_rejects_forged_capture_and_stays_ignored_after_stop_or_delete(self):
        accepted = self.review_turn()
        tid, cid = accepted['turn']['id'], accepted['conversation']['id']
        progress = {'turnId': tid, 'type': 'progress', 'runId': 'capture', 'text': 'Captured report', 'citations': []}
        with self.assertRaises(ValueError):
            self.store.dispatch('frame', {**progress, 'runId': 'another-capture'})
        self.store.dispatch('frame', {'turnId': tid, 'type': 'interrupted'})
        self.assertEqual(self.store.dispatch('frame', progress), {'ignored': True})
        self.store.dispatch('delete', {'conversationId': cid})
        self.assertEqual(self.store.dispatch('frame', progress), {'ignored': True})

    def late_response(self, text='Hello', partial=''):
        with patch('workspace.now', return_value='2026-09-30T10:00:00Z'):
            accepted = self.accept(text=text)
            self.store.dispatch('frame', {'turnId': accepted['turn']['id'], 'type': 'session', 'sessionId': 'linked'})
        with patch('workspace.now', return_value='2026-09-30T10:01:00Z'):
            self.store.dispatch('frame', {'turnId': accepted['turn']['id'], 'type': 'failed', 'text': partial,
                                         'error': 'The response exceeded its time limit. Retry is available.'})
        source = Path(self.temp.name) / 'late-hermes.db'
        citation = {'id': 'cite_late', 'title': 'Captured research', 'sourceUri': 'gmail://message/late', 'publicationDate': '2026-09-29'}
        with sqlite3.connect(source) as db:
            db.executescript('CREATE TABLE sessions(id TEXT,source TEXT,title TEXT); CREATE TABLE messages(id INTEGER,session_id TEXT,role TEXT,content TEXT,timestamp REAL,tool_calls TEXT,tool_name TEXT);')
            db.execute('INSERT INTO sessions VALUES(?,?,?)', ('linked', 'market-dashboard-analyst', '[workspace:' + accepted['conversation']['id'] + ']'))
            for row in [
                (1, 'linked', 'user', 'Earlier prompt', 1790762300, None, None),
                (2, 'linked', 'tool', json.dumps({'citations': [{'id': 'cite_prior', 'sourceUri': 'gmail://message/prior'}]}), 1790762301, None, 'get_research_context'),
                (3, 'linked', 'assistant', 'Earlier final cite_prior', 1790762302, None, None),
                (4, 'linked', 'user', '[live instructions]\n' + text, 1790762401, None, None),
                (5, 'linked', 'assistant', '', 1790762402, '[{"name":"get_portfolio_context"}]', None),
                (6, 'linked', 'tool', json.dumps({'liveVerified': True, 'citations': [citation]}), 1790762403, None, 'get_portfolio_context'),
                (7, 'linked', 'assistant', 'Captured final cite_late cite_prior', 1790762520, '[]', None),
            ]:
                db.execute('INSERT INTO messages VALUES(?,?,?,?,?,?,?)', row)
        return accepted, source, citation

    def recovery_params(self, accepted, source):
        candidate = self.store.response_source(source, accepted['conversation']['id'], accepted['turn']['id'])
        return {**candidate, 'trustedHermesPath': str(source), 'text': candidate['completedText']}

    def test_late_response_source_is_read_only_and_scopes_original_turn_evidence(self):
        accepted, source, citation = self.late_response()
        cursor = self.store.dispatch('list', {})['cursor']
        before = self.store.dispatch('get', {'conversationId': accepted['conversation']['id']})
        candidate = self.store.response_source(source, accepted['conversation']['id'], accepted['turn']['id'])
        self.assertEqual(candidate['text'], 'Hello')
        self.assertEqual(candidate['hermesId'], 'linked')
        self.assertEqual(candidate['sourceMessageId'], 'hermes-message:7')
        self.assertEqual(candidate['sourceUserMessageId'], 4)
        self.assertEqual(candidate['completedAt'], '2026-09-30T10:02:00Z')
        self.assertEqual(candidate['expectedTurnUpdatedAt'], '2026-09-30T10:01:00Z')
        self.assertEqual(candidate['citations'], [citation])
        self.assertEqual([message['id'] for message in candidate['messages']], [4, 5, 6, 7])
        self.assertEqual(candidate['messages'][1]['tool_calls'], [{'name': 'get_portfolio_context'}])
        self.assertEqual(candidate['messages'][2]['tool_name'], 'get_portfolio_context')
        self.assertEqual(self.store.dispatch('get', {'conversationId': accepted['conversation']['id']}), before)
        self.assertEqual(self.store.dispatch('events', {'after': cursor})['events'], [])

    def test_late_response_source_omits_binary_reasoning_and_decodes_tool_calls_for_json_delivery(self):
        accepted, source, _ = self.late_response()
        with sqlite3.connect(source) as db:
            db.execute('ALTER TABLE messages ADD COLUMN reasoning BLOB')
            db.execute('UPDATE messages SET reasoning=?', (b'\x00\xffprivate binary reasoning',))
        candidate = self.store.response_source(source, accepted['conversation']['id'], accepted['turn']['id'])
        delivered = json.loads(json.dumps(candidate))
        self.assertNotIn('reasoning', delivered['messages'][-1])
        self.assertEqual(delivered['messages'][-1]['tool_calls'], [])
        self.assertEqual(delivered['messages'][1]['tool_calls'], [{'name': 'get_portfolio_context'}])
        self.assertEqual(delivered['messages'][2]['tool_name'], 'get_portfolio_context')

    def test_late_response_replaces_partial_in_place_once_and_preserves_archive_and_source_time(self):
        accepted, source, citation = self.late_response(partial='Partial response')
        cid, tid = accepted['conversation']['id'], accepted['turn']['id']
        self.store.dispatch('archive', {'conversationId': cid})
        original = self.store.dispatch('get', {'conversationId': cid})['conversation']
        cursor = self.store.dispatch('list', {})['cursor']
        params = self.recovery_params(accepted, source)
        result = self.store.dispatch('reconcile-response', params)
        saved = result['conversation']
        self.assertTrue(result['reconciled'])
        self.assertEqual(saved['archived'], 1)
        self.assertEqual(saved['id'], cid)
        self.assertEqual(saved['lastTurn']['id'], tid)
        self.assertEqual(saved['lastTurn']['state'], 'complete')
        self.assertIsNone(saved['lastTurn']['error'])
        self.assertIsNone(saved['activeTurn'])
        self.assertEqual(saved['messages'][0], original['messages'][0])
        self.assertEqual(saved['messages'][-1]['id'], original['messages'][-1]['id'])
        self.assertEqual(saved['messages'][-1]['created_at'], '2026-09-30T10:02:00Z')
        self.assertEqual(saved['messages'][-1]['source_id'], 'hermes-message:7')
        self.assertEqual(saved['messages'][-1]['text'], params['completedText'])
        self.assertEqual(saved['messages'][-1]['citations'], [citation])
        self.assertEqual(self.store.dispatch('reconcile-response', params), {'ignored': True})
        events = self.store.dispatch('events', {'after': cursor})['events']
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]['type'], 'complete')
        self.assertEqual(events[0]['payload'], {'recovered': True, 'completedAt': '2026-09-30T10:02:00Z'})
        with self.store.connect() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM turns').fetchone()[0], 1)
            self.assertEqual(db.execute('SELECT count(*) FROM messages').fetchone()[0], 2)

    def test_late_response_requires_post_timeout_final_and_current_source_user(self):
        accepted, source, _ = self.late_response()
        cid, tid = accepted['conversation']['id'], accepted['turn']['id']
        for column, value, row in [('timestamp', 1790762400, 7), ('timestamp', 1790762460, 7),
                                   ('timestamp', 1790762399, 4), ('tool_calls', '[{"name":"pending"}]', 7)]:
            with self.subTest(column=column, value=value):
                with sqlite3.connect(source) as db:
                    original = db.execute(f'SELECT {column} FROM messages WHERE id=?', (row,)).fetchone()[0]
                    db.execute(f'UPDATE messages SET {column}=? WHERE id=?', (value, row))
                self.assertIsNone(self.store.response_source(source, cid, tid))
                with sqlite3.connect(source) as db:
                    db.execute(f'UPDATE messages SET {column}=? WHERE id=?', (original, row))
        with sqlite3.connect(source) as db:
            db.execute('INSERT INTO messages VALUES(?,?,?,?,?,?,?)', (8, 'linked', 'user', 'Newer source question', 1790762521, None, None))
        self.assertIsNone(self.store.response_source(source, cid, tid))

    def test_late_response_rejects_mismatched_session_source_workspace_and_exact_timeout(self):
        accepted, source, _ = self.late_response()
        cid, tid = accepted['conversation']['id'], accepted['turn']['id']
        with sqlite3.connect(source) as db:
            db.execute("UPDATE sessions SET source='other-app'")
        self.assertIsNone(self.store.response_source(source, cid, tid))
        with sqlite3.connect(source) as db:
            db.execute("UPDATE sessions SET source='market-dashboard-analyst',title='[workspace:other-conversation]'")
        self.assertIsNone(self.store.response_source(source, cid, tid))
        with sqlite3.connect(source) as db:
            db.execute("UPDATE sessions SET title='[workspace:' || ? || ']'", (cid,))
        with self.store.connect() as db:
            db.execute("UPDATE turns SET error='Stopped' WHERE id=?", (tid,))
        self.assertIsNone(self.store.response_source(source, cid, tid))
        self.assertIsNone(self.store.response_source(source, cid, 'wrong-turn'))

    def test_late_response_commit_rechecks_original_identity_and_source_under_lock(self):
        accepted, source, _ = self.late_response()
        params = self.recovery_params(accepted, source)
        for field in ('hermesId', 'sourceMessageId', 'completedAt', 'expectedTurnCreatedAt', 'expectedTurnUpdatedAt'):
            with self.subTest(field=field):
                self.assertEqual(self.store.dispatch('reconcile-response', {**params, field: 'mismatched'}), {'ignored': True})
        with sqlite3.connect(source) as db:
            db.execute('UPDATE messages SET timestamp=timestamp+1 WHERE id=7')
        self.assertEqual(self.store.dispatch('reconcile-response', params), {'ignored': True})
        with self.store.connect() as db:
            self.assertEqual(db.execute('SELECT state FROM turns').fetchone()[0], 'failed')

    def test_late_response_cannot_restore_deleted_chat(self):
        accepted, source, _ = self.late_response()
        cid, tid = accepted['conversation']['id'], accepted['turn']['id']
        params = self.recovery_params(accepted, source)
        self.store.dispatch('delete', {'conversationId': cid})
        self.assertIsNone(self.store.response_source(source, cid, tid))
        self.assertEqual(self.store.dispatch('reconcile-response', params), {'ignored': True})
        self.assertEqual(self.store.dispatch('list', {})['conversations'], [])

    def test_late_response_cannot_replace_active_or_completed_newer_retry(self):
        accepted, source, _ = self.late_response()
        cid, tid = accepted['conversation']['id'], accepted['turn']['id']
        params = self.recovery_params(accepted, source)
        retry = self.accept('new-retry', 'Hello', cid)
        self.assertIsNone(self.store.response_source(source, cid, tid))
        self.assertEqual(self.store.dispatch('reconcile-response', params), {'ignored': True})
        self.assertEqual(self.store.dispatch('get', {'conversationId': cid})['conversation']['activeTurn']['request_id'], 'new-retry')
        self.store.dispatch('frame', {'turnId': retry['turn']['id'], 'type': 'complete', 'text': 'The newer response'})
        self.assertIsNone(self.store.response_source(source, cid, tid))
        self.assertEqual(self.store.dispatch('reconcile-response', params), {'ignored': True})
        self.assertEqual(self.store.dispatch('get', {'conversationId': cid})['conversation']['messages'][-1]['text'], 'The newer response')

    def test_late_response_cannot_reuse_prior_turn_citations_or_commit_invalid_output(self):
        accepted, source, _ = self.late_response()
        params = self.recovery_params(accepted, source)
        for invalid in ({'text': ''}, {'citations': [{'id': 'cite_prior'}]}, {'citations': 'not-a-list'}):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                self.store.dispatch('reconcile-response', {**params, **invalid})
        self.assertEqual(self.store.dispatch('get', {'conversationId': accepted['conversation']['id']})['conversation']['lastTurn']['state'], 'failed')

    def test_late_response_preserves_compact_citation_rows_and_rejects_malformed_tables(self):
        accepted, source, citation = self.late_response()
        columns = ['id', 'documentId', 'product', 'publicationDate', 'publishedAt', 'sourceUri']
        row = [citation.get(column) for column in columns]
        table = {'columns': columns, 'rows': [row], 'rowCount': 1}
        with sqlite3.connect(source) as db:
            db.execute('UPDATE messages SET content=? WHERE id=6', (json.dumps({'researchVerification': {'citationTable': table}}),))
        candidate = self.store.response_source(source, accepted['conversation']['id'], accepted['turn']['id'])
        self.assertEqual(candidate['citations'], [dict(zip(columns, row))])
        for malformed in ({**table, 'rowCount': 2}, {**table, 'rows': [row[:-1]]}, {**table, 'columns': list(reversed(columns))}):
            with self.subTest(table=malformed):
                with sqlite3.connect(source) as db:
                    db.execute('UPDATE messages SET content=? WHERE id=6', (json.dumps({'researchVerification': {'citationTable': malformed}}),))
                self.assertEqual(self.store.response_source(source, accepted['conversation']['id'], accepted['turn']['id'])['citations'], [])

    def test_import_repeatable_preserves_dates_citations_and_audit_separation(self):
        source = Path(self.temp.name) / 'hermes.db'
        citation = {'id': 'cite_example', 'title': 'Evidence', 'sourceUri': 'gmail://message/1', 'publicationDate': '2026-09-04'}
        with sqlite3.connect(source) as db:
            db.executescript('CREATE TABLE sessions(id TEXT,source TEXT,title TEXT,started_at REAL,archived INTEGER,hidden INTEGER); CREATE TABLE messages(id INTEGER,session_id TEXT,role TEXT,content TEXT,timestamp REAL,tool_calls TEXT);')
            db.execute('INSERT INTO sessions VALUES(?,?,?,?,?,?)', ('chat', 'market-dashboard-analyst', 'Saved question', 1788537600, 1, 0))
            db.execute('INSERT INTO sessions VALUES(?,?,?,?,?,?)', ('audit', 'market-dashboard-analyst', 'Internal audit', 1788537600, 0, 0))
            for row in [(1,'chat','user','Hello',1788537600,None),(2,'chat','assistant','Saved reply',1788537601,None),(3,'audit','user','Perform a read-only portfolio-product reconciliation for Tim.',1788537600,None),(4,'audit','tool',json.dumps({'citations':[citation]}),1788537601,None),(5,'audit','assistant','Audit finding cite_example',1788537602,None)]:
                db.execute('INSERT INTO messages VALUES(?,?,?,?,?,?)',row)
        self.store.import_hermes(source)
        self.store.import_hermes(source)
        with self.store.connect() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM conversations').fetchone()[0],2)
            self.assertEqual(db.execute('SELECT count(*) FROM messages').fetchone()[0],3)
            audit = db.execute("SELECT * FROM conversations WHERE kind='audit'").fetchone()
            self.assertTrue(audit['created_at'].startswith('2026-09-04'))
            report = db.execute('SELECT * FROM messages WHERE conversation_id=?',(audit['id'],)).fetchone()
            self.assertEqual(json.loads(report['citations'])[0]['id'],'cite_example')
            self.assertEqual(db.execute("SELECT archived FROM conversations WHERE kind='chat'").fetchone()[0],1)
        self.store.dispatch('delete', {'conversationId': audit['id']})
        self.store.import_hermes(source)
        self.assertEqual(self.store.dispatch('list', {})['conversations'], [])

    def test_delete_during_hermes_citation_parse_cannot_restore_conversation(self):
        from workspace import imported_citations
        source = Path(self.temp.name) / 'hermes.db'
        with sqlite3.connect(source) as db:
            db.executescript('CREATE TABLE sessions(id TEXT,source TEXT,title TEXT,started_at REAL,archived INTEGER,hidden INTEGER); CREATE TABLE messages(id INTEGER,session_id TEXT,role TEXT,content TEXT,timestamp REAL,tool_calls TEXT);')
            db.execute('INSERT INTO sessions VALUES(?,?,?,?,?,?)', ('chat', 'market-dashboard-analyst', 'Saved question', 1788537600, 0, 0))
            db.execute('INSERT INTO messages VALUES(?,?,?,?,?,?)', (1, 'chat', 'user', 'Hello', 1788537600, None))
        self.store.import_hermes(source)
        cid = self.store.dispatch('list', {})['conversations'][0]['id']

        def delete_after_read(messages):
            self.store.dispatch('delete', {'conversationId': cid})
            return imported_citations(messages)

        with patch('workspace.imported_citations', side_effect=delete_after_read):
            self.assertEqual(self.store.import_hermes(source), 0)
        restarted = WorkspaceStore(self.store.path)
        restarted.import_hermes(source)
        self.assertEqual(restarted.dispatch('list', {})['conversations'], [])
        with restarted.connect() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM messages').fetchone()[0], 0)
        with sqlite3.connect(source) as db:
            self.assertEqual(db.execute('SELECT count(*) FROM messages').fetchone()[0], 1)

    def test_delete_removes_content_and_daily_background_cannot_recreate_it(self):
        params = {'kind': 'portfolio-review', 'date': '2026-09-04', 'title': 'Portfolio Review'}
        original = self.store.dispatch('daily', params)['conversation']
        self.accept('daily-prompt', 'Private content', original['id'])
        self.store.dispatch('delete', {'conversationId': original['id']})
        with self.store.connect() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM messages').fetchone()[0], 0)
            self.assertEqual(db.execute('SELECT count(*) FROM turns').fetchone()[0], 0)
        self.assertIsNone(self.store.dispatch('daily', params)['conversation'])
        new = self.store.dispatch('daily', {**params, 'reopen': True})['conversation']
        self.assertNotEqual(new['id'], original['id'])
        self.assertEqual(new['messages'], [])
        self.assertEqual(self.store.dispatch('daily', params)['conversation']['id'], new['id'])

    def test_deleted_history_can_be_checked_in_one_bounded_read(self):
        deleted = self.accept()['conversation']['id']
        retained = self.accept('retained')['conversation']['id']
        self.store.dispatch('delete', {'conversationId': deleted})
        result = self.store.dispatch('deleted', {'conversationIds': [deleted, retained, deleted, 'missing']})
        self.assertEqual(result, {'deletedConversationIds': [deleted]})
        self.assertTrue(self.store.dispatch('deleted', {'conversationId': deleted})['deleted'])
        self.assertFalse(self.store.dispatch('deleted', {'conversationId': retained})['deleted'])
        self.assertEqual(self.store.dispatch('deleted', {'conversationIds': []}), {'deletedConversationIds': []})
        for invalid in ['not-a-list', [None], ['id'] * 501]:
            with self.assertRaises(ValueError):
                self.store.dispatch('deleted', {'conversationIds': invalid})

    def test_concurrent_delete_retries_succeed_once_and_survive_restart(self):
        accepted = self.accept()
        cid = accepted['conversation']['id']
        with concurrent.futures.ThreadPoolExecutor(8) as pool:
            results = list(pool.map(lambda _: self.store.dispatch('delete', {'conversationId': cid}), range(8)))
        self.assertTrue(all(result['ok'] for result in results))
        restarted = WorkspaceStore(self.store.path)
        self.assertEqual(restarted.dispatch('list', {})['conversations'], [])
        self.assertEqual([event['type'] for event in restarted.dispatch('events', {})['events']], ['deleted'])
        self.assertTrue(restarted.dispatch('delete', {'conversationId': cid})['ok'])

    def test_delete_does_not_decode_history_and_returns_cancellation_metadata(self):
        accepted = self.accept()
        cid = accepted['conversation']['id']
        self.store.dispatch('setting', {'key': 'daily-run:' + cid, 'value': {'runId': 'pending-run'}})
        # Removing a chat does not require its stored report to be renderable.
        with self.store.connect() as db:
            db.execute("UPDATE messages SET citations='invalid-json' WHERE conversation_id=?", (cid,))
        result = self.store.dispatch('delete', {'conversationId': cid})
        self.assertEqual(result, {'ok': True, 'turnId': accepted['turn']['id'], 'cancelRunId': 'pending-run'})
        self.assertEqual(self.store.dispatch('list', {})['conversations'], [])

    def test_parallel_conversations_replay_and_duplicate_requests(self):
        with concurrent.futures.ThreadPoolExecutor(4) as pool:
            results = list(pool.map(lambda n: self.accept(str(n), f'Question {n}'), range(4)))
        for n, result in enumerate(results):
            self.store.dispatch('frame', {'turnId': result['turn']['id'], 'type': 'delta', 'text': f'Only answer {n}'})
        duplicate = self.accept('0', 'Question 0')
        self.assertFalse(duplicate['created'])
        self.assertEqual(duplicate['conversation']['id'], results[0]['conversation']['id'])
        for n, result in enumerate(results):
            detail = self.store.dispatch('get', {'conversationId': result['conversation']['id']})['conversation']
            self.assertEqual(detail['messages'][-1]['text'], f'Only answer {n}')
        events = self.store.dispatch('events', {'after': 0})['events']
        self.assertEqual(len(events), 8)
        self.assertEqual(len({e['id'] for e in events}), 8)
        replay = self.store.dispatch('events', {'after': events[3]['seq']})['events']
        self.assertEqual(replay, events[4:])

    def test_stop_is_terminal_and_does_not_affect_other_conversation(self):
        a, b = self.accept(), self.accept('r2')
        self.store.dispatch('frame', {'turnId': a['turn']['id'], 'type': 'interrupted', 'error': 'Stopped'})
        self.assertTrue(self.store.dispatch('frame', {'turnId': a['turn']['id'], 'type': 'complete', 'text': 'Late unwanted completion'})['ignored'])
        self.store.dispatch('frame', {'turnId': b['turn']['id'], 'type': 'complete', 'text': 'B completed'})
        self.assertEqual(self.store.dispatch('get', {'conversationId': b['conversation']['id']})['conversation']['messages'][-1]['text'], 'B completed')

    def test_delta_batch_concatenates_exactly_with_one_replay_event_and_compact_reply(self):
        accepted = self.accept()
        tid, cid = accepted['turn']['id'], accepted['conversation']['id']
        cursor = self.store.dispatch('list', {})['cursor']
        with patch.object(self.store, 'conversation', side_effect=AssertionError('Must not serialize history')):
            result = self.store.dispatch('frame', {'turnId': tid, 'type': 'delta_batch', 'includeConversation': False,
                'entries': [{'text': 'First '}, {'text': 'line\n', 'eventId': 'one'}, {'text': 'Second → line'}, {'text': ''}]})
        self.assertEqual(result, {'ok': True})
        saved = self.store.dispatch('get', {'conversationId': cid})['conversation']
        self.assertEqual(saved['messages'][-1]['text'], 'First line\nSecond → line')
        self.assertEqual(saved['activeTurn']['state'], 'running')
        self.assertGreaterEqual(saved['activeTurn']['updated_at'], accepted['turn']['updated_at'])
        events = self.store.dispatch('events', {'after': cursor})['events']
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]['type'], 'delta')
        self.assertEqual(events[0]['turn_id'], tid)
        default_reply = self.store.dispatch('frame', {'turnId': tid, 'type': 'delta_batch', 'entries': [{'text': '!'}]})
        self.assertEqual(default_reply['conversation']['messages'][-1]['text'], 'First line\nSecond → line!')

    def test_delta_batch_deduplicates_within_batches_and_across_single_frames(self):
        accepted = self.accept()
        tid, cid = accepted['turn']['id'], accepted['conversation']['id']
        self.store.dispatch('frame', {'turnId': tid, 'type': 'delta', 'text': 'A', 'eventId': 0})
        batch = {'turnId': tid, 'type': 'delta_batch', 'entries': [
            {'text': 'duplicate A', 'eventId': 0}, {'text': 'B', 'eventId': 'two'},
            {'text': 'duplicate B', 'eventId': 'two'}, {'text': 'C', 'eventId': 'three'},
        ]}
        self.store.dispatch('frame', batch)
        cursor = self.store.dispatch('list', {})['cursor']
        self.assertEqual(self.store.dispatch('frame', batch), {'ignored': True})
        self.assertEqual(self.store.dispatch('frame', {'turnId': tid, 'type': 'delta', 'text': 'duplicate C', 'eventId': 'three'}), {'ignored': True})
        self.assertEqual(self.store.dispatch('events', {'after': cursor})['events'], [])
        self.store.dispatch('frame', {'turnId': tid, 'type': 'delta_batch', 'entries': [
            {'text': 'duplicate B', 'eventId': 'two'}, {'text': 'D', 'eventId': 'four'}, {'text': '!'},
        ]})
        saved = self.store.dispatch('get', {'conversationId': cid})['conversation']
        self.assertEqual(saved['messages'][-1]['text'], 'ABCD!')
        with self.store.connect() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM upstream_events WHERE turn_id=?', (tid,)).fetchone()[0], 4)

    def test_delta_batch_is_ignored_after_terminal_and_empty_batch_has_no_replay(self):
        for state in ('complete', 'failed', 'interrupted'):
            with self.subTest(state=state):
                accepted = self.accept('terminal-' + state)
                tid, cid = accepted['turn']['id'], accepted['conversation']['id']
                cursor = self.store.dispatch('list', {})['cursor']
                self.assertEqual(self.store.dispatch('frame', {'turnId': tid, 'type': 'delta_batch', 'entries': []}), {'ignored': True})
                self.assertEqual(self.store.dispatch('events', {'after': cursor})['events'], [])
                self.store.dispatch('frame', {'turnId': tid, 'type': state, 'text': 'Final'})
                cursor = self.store.dispatch('list', {})['cursor']
                self.assertEqual(self.store.dispatch('frame', {'turnId': tid, 'type': 'delta_batch',
                    'entries': [{'text': 'Late unwanted content', 'eventId': 'late'}]}), {'ignored': True})
                self.assertEqual(self.store.dispatch('events', {'after': cursor})['events'], [])
                saved = self.store.dispatch('get', {'conversationId': cid})['conversation']
                self.assertEqual(saved['messages'][-1]['text'], 'Final')
                self.assertIsNone(saved['activeTurn'])

    def test_invalid_delta_batch_does_not_partially_save_text_or_event_ids(self):
        accepted = self.accept()
        tid = accepted['turn']['id']
        cursor = self.store.dispatch('list', {})['cursor']
        with self.assertRaisesRegex(ValueError, 'list of frames'):
            self.store.dispatch('frame', {'turnId': tid, 'type': 'delta_batch', 'eventId': 'batch',
                'entries': [{'text': 'Partial', 'eventId': 'one'}, 'invalid']})
        self.assertEqual(self.store.dispatch('events', {'after': cursor})['events'], [])
        with self.store.connect() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM upstream_events WHERE turn_id=?', (tid,)).fetchone()[0], 0)
            self.assertEqual(db.execute("SELECT text FROM messages WHERE turn_id=? AND role='assistant'", (tid,)).fetchone()[0], '')

    def test_restart_archive_restore_and_full_text_search(self):
        result = self.accept(text='Needle in complete saved content')
        cid = result['conversation']['id']
        restarted = WorkspaceStore(self.store.path)
        restarted.dispatch('recover', {})
        detail = restarted.dispatch('get', {'conversationId': cid})['conversation']
        self.assertIsNone(detail['activeTurn'])
        self.assertEqual(detail['lastTurn']['state'], 'interrupted')
        restarted.dispatch('archive', {'conversationId': cid})
        self.assertEqual(restarted.dispatch('list', {})['conversations'], [])
        self.assertEqual(len(restarted.dispatch('list', {'archived': True, 'query': 'complete saved'})['conversations']), 1)
        restarted.dispatch('archive', {'conversationId': cid, 'archived': False})
        self.assertEqual(len(restarted.dispatch('list', {})['conversations']), 1)
        retry = self.accept('retry1', 'Needle in complete saved content', cid)
        self.assertEqual(len(retry['conversation']['messages']), 2)

    def test_recovery_preserves_owned_quiet_turns_but_recovers_orphans(self):
        accepted, running, orphan, recent = [self.accept(f'recovery-{i}') for i in range(4)]
        self.store.dispatch('frame', {'turnId': running['turn']['id'], 'type': 'delta', 'text': 'Partial answer'})
        with self.store.connect() as db:
            db.executemany("UPDATE turns SET updated_at=datetime('now','-10 minutes') WHERE id=?",
                           [(entry['turn']['id'],) for entry in (accepted, running, orphan)])
        protected = [accepted['turn']['id'], running['turn']['id']]
        self.assertEqual(self.store.dispatch('recover', {'staleAfterSeconds': 190, 'activeTurnIds': protected}), {'recovered': 1})
        for entry in (accepted, running, recent):
            saved = self.store.dispatch('get', {'conversationId': entry['conversation']['id']})['conversation']
            self.assertEqual(saved['activeTurn']['id'], entry['turn']['id'])
        self.assertEqual(self.store.dispatch('get', {'conversationId': orphan['conversation']['id']})['conversation']['lastTurn']['state'], 'interrupted')
        self.store.dispatch('frame', {'turnId': running['turn']['id'], 'type': 'complete', 'text': 'Final answer'})
        self.assertEqual(self.store.dispatch('get', {'conversationId': running['conversation']['id']})['conversation']['messages'][-1]['text'], 'Final answer')
        # A restarted API has no socket owners; exclusions are never persisted.
        self.assertEqual(WorkspaceStore(self.store.path).dispatch('recover', {'staleAfterSeconds': 190}), {'recovered': 1})

    def test_daily_revisions_idempotent_and_followups_preserved(self):
        payload = {'kind': 'portfolio-review', 'date': '2026-09-04', 'title': 'Portfolio Review'}
        a = self.store.dispatch('daily', payload)['conversation']
        self.assertEqual(a['id'], self.store.dispatch('daily', payload)['conversation']['id'])
        for revision in ('first', 'corrected', 'corrected'):
            self.store.dispatch('append', {'conversationId': a['id'], 'sourceId': revision, 'text': revision, 'citations': [{'id': 'cite_original'}]})
        followup = self.accept('followup', 'Question about first version', a['id'])
        self.assertEqual(len(followup['conversation']['messages']), 3)
        self.assertEqual(followup['conversation']['messages'][0]['citations'][0]['id'], 'cite_original')

    def test_daily_blank_chat_is_created_once_and_remains_archived_or_deleted_after_restart(self):
        params = {'kind': 'daily-chat', 'date': '2026-09-06', 'title': 'Miscellaneous'}
        original = self.store.dispatch('daily', params)['conversation']
        self.assertEqual(original['messages'], [])
        self.assertIsNone(original['activeTurn'])
        self.assertIsNone(original['lastTurn'])
        self.assertIsNone(original['hermes_id'])
        self.store = WorkspaceStore(self.store.path)
        self.assertEqual(self.store.dispatch('daily', params)['conversation'], original)
        with self.store.connect() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM turns').fetchone()[0], 0)
            self.assertEqual(db.execute('SELECT count(*) FROM messages').fetchone()[0], 0)
        events = self.store.dispatch('events', {'after': 0})['events']
        self.assertEqual([(event['type'], event['conversation_id']) for event in events], [('created', original['id'])])
        self.store.dispatch('archive', {'conversationId': original['id']})
        self.store = WorkspaceStore(self.store.path)
        archived = self.store.dispatch('daily', params)['conversation']
        self.assertEqual(archived['id'], original['id'])
        self.assertEqual(archived['archived'], 1)
        self.assertEqual(self.store.dispatch('list', {})['conversations'], [])
        self.assertEqual(len(self.store.dispatch('list', {'archived': True})['conversations']), 1)
        self.store.dispatch('delete', {'conversationId': original['id']})
        self.store = WorkspaceStore(self.store.path)
        self.assertIsNone(self.store.dispatch('daily', params)['conversation'])
        self.assertEqual(self.store.dispatch('list', {})['conversations'], [])
        next_day = self.store.dispatch('daily', {**params, 'date': '2026-09-07'})['conversation']
        self.assertNotEqual(next_day['id'], original['id'])
        self.assertEqual(next_day['messages'], [])

    def test_daily_chat_preserves_user_messages_and_identity_after_restart(self):
        params = {'kind': 'daily-chat', 'date': '2026-09-06', 'title': 'Miscellaneous'}
        original = self.store.dispatch('daily', params)['conversation']
        accepted = self.accept('misc-first', 'A question for today', original['id'])
        self.store.dispatch('frame', {'turnId': accepted['turn']['id'], 'type': 'complete', 'text': 'Saved reply'})
        before = self.store.dispatch('get', {'conversationId': original['id']})['conversation']
        self.store = WorkspaceStore(self.store.path)
        after = self.store.dispatch('daily', {**params, 'title': 'A replacement title'})['conversation']
        self.assertEqual(after, before)
        self.assertEqual(after['title'], 'Miscellaneous')
        self.assertEqual(after['created_at'], original['created_at'])
        self.assertEqual(after['trading_date'], params['date'])
        self.assertEqual([message['text'] for message in after['messages']], ['A question for today', 'Saved reply'])
        self.assertEqual(self.store.dispatch('list', {})['conversations'][0]['message_count'], 2)

    def test_each_review_counts_publication_revisions_and_notes_as_one_post(self):
        for kind in ('portfolio-review', 'balance-review', 'prediction-markets-review'):
            with self.subTest(kind=kind):
                cid = self.store.dispatch('daily', {'kind': kind, 'date': '2026-09-17', 'title': kind})['conversation']['id']
                for index in range(13):
                    accepted = self.store.dispatch('accept', {'conversationId': cid, 'requestId': f'daily-turn:{kind}:{index}',
                                                             'text': 'Prepare review', 'internalPrompt': True})
                    self.store.dispatch('frame', {'turnId': accepted['turn']['id'], 'type': 'complete', 'text': f'Review revision {index}'})
                notes = self.store.dispatch('accept', {'conversationId': cid, 'requestId': f'daily-narrative:{kind}',
                                                       'text': 'Explain review', 'internalPrompt': True})
                self.store.dispatch('frame', {'turnId': notes['turn']['id'], 'type': 'complete', 'text': 'Review notes'})
                for source in ('daily-report:', 'review-message:'):
                    self.store.dispatch('append', {'conversationId': cid, 'sourceId': source + kind, 'text': 'Imported review revision'})
                messages = self.store.dispatch('get', {'conversationId': cid})['conversation']['messages']
                self.assertEqual(len(messages), 16)
                self.store = WorkspaceStore(self.store.path)
                row = next(row for row in self.store.dispatch('list', {})['conversations'] if row['id'] == cid)
                self.assertEqual(row['message_count'], 1)
                self.assertEqual(self.store.dispatch('get', {'conversationId': cid})['conversation']['messages'], messages)

    def test_requested_review_posts_and_real_dialogue_count_separately(self):
        cid = self.store.dispatch('daily', {'kind': 'portfolio-review', 'date': '2026-09-17', 'title': 'Portfolio Review'})['conversation']['id']
        for index, post_id in enumerate(('base', 'requested-second', 'requested-second')):
            for step in ('daily-turn', 'daily-narrative'):
                accepted = self.store.dispatch('accept', {'conversationId': cid, 'requestId': f'{step}:{index}',
                                                         'text': 'Generate review', 'internalPrompt': True, 'reviewPostId': post_id})
                self.store.dispatch('frame', {'turnId': accepted['turn']['id'], 'type': 'complete', 'text': f'{step} {index}'})
            self.assertEqual(self.store.dispatch('list', {})['conversations'][0]['message_count'], min(index + 1, 2))
        followup = self.accept('followup', 'Explain this position', cid)
        self.assertEqual(self.store.dispatch('list', {})['conversations'][0]['message_count'], 3)
        self.store.dispatch('frame', {'turnId': followup['turn']['id'], 'type': 'complete', 'text': 'Here is the explanation'})
        self.store = WorkspaceStore(self.store.path)
        self.assertEqual(self.store.dispatch('list', {})['conversations'][0]['message_count'], 4)
        chat = self.accept('chat', 'A separate question')
        self.store.dispatch('frame', {'turnId': chat['turn']['id'], 'type': 'complete', 'text': 'A separate answer'})
        row = next(row for row in self.store.dispatch('list', {})['conversations'] if row['id'] == chat['conversation']['id'])
        self.assertEqual(row['message_count'], 2)

    def test_review_empty_responses_and_retries_keep_their_post_identity(self):
        cid = self.store.dispatch('daily', {'kind': 'balance-review', 'date': '2026-09-17', 'title': 'Balance Review'})['conversation']['id']
        original = self.store.dispatch('accept', {'conversationId': cid, 'requestId': 'daily-turn:base',
                                                 'text': 'Generate review', 'internalPrompt': True, 'reviewPostId': 'base'})
        self.assertEqual(self.store.dispatch('list', {})['conversations'][0]['message_count'], 0)
        self.store.dispatch('frame', {'turnId': original['turn']['id'], 'type': 'complete', 'text': 'Original report'})
        notes = self.store.dispatch('accept', {'conversationId': cid, 'requestId': 'daily-narrative:base',
                                              'text': 'Explain review', 'internalPrompt': True, 'reviewPostId': 'base'})
        self.store.dispatch('frame', {'turnId': notes['turn']['id'], 'type': 'failed', 'text': '   ', 'error': 'Unavailable'})
        self.assertEqual(self.store.dispatch('list', {})['conversations'][0]['message_count'], 1)
        retry = self.store.dispatch('retry-data', {'conversationId': cid, 'turnId': notes['turn']['id']})
        self.assertEqual(retry['reviewPostId'], 'base')
        retried = self.store.dispatch('accept', {'conversationId': cid, 'requestId': 'retry', 'text': retry['text'],
                                                'internalPrompt': retry['internalPrompt'], 'reviewPostId': retry['reviewPostId']})
        self.store.dispatch('frame', {'turnId': retried['turn']['id'], 'type': 'complete', 'text': 'Completed review notes'})
        self.assertEqual(self.store.dispatch('list', {})['conversations'][0]['message_count'], 1)

    def test_existing_turn_schema_migrates_for_review_post_identity(self):
        path = Path(self.temp.name) / 'old-workspace.sqlite3'
        with sqlite3.connect(path) as db:
            db.execute('''CREATE TABLE turns(id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL,
                          request_id TEXT NOT NULL UNIQUE, state TEXT NOT NULL, error TEXT,
                          created_at TEXT NOT NULL, updated_at TEXT NOT NULL)''')
            db.execute("INSERT INTO turns VALUES('old-turn','old-conversation','old-request','complete',NULL,'2026-09-17','2026-09-17')")
        migrated = WorkspaceStore(path)
        with migrated.connect() as db:
            turn = dict(db.execute("SELECT * FROM turns WHERE id='old-turn'").fetchone())
        self.assertEqual(turn['request_id'], 'old-request')
        self.assertIsNone(turn['review_post_id'])

    def test_request_id_cannot_cross_conversation_or_change_content(self):
        a, b = self.accept(), self.accept('r2')
        with self.assertRaises(ValueError):
            self.accept('r1', 'Different')
        with self.assertRaises(ValueError):
            self.accept('r1', 'Hello', b['conversation']['id'])
        with self.assertRaises(ValueError):
            self.accept('r3', 'Concurrent in same chat', a['conversation']['id'])

    def test_historical_reference_survives_reload_and_clears_for_a_new_response(self):
        for request, internal in [('daily-turn:fresh', True), ('followup', False)]:
            with self.subTest(request=request):
                cid = self.store.dispatch('daily', {'kind': 'portfolio-review', 'date': request, 'title': 'Portfolio Review'})['conversation']['id']
                key = 'portfolio-reference:' + cid
                reference = {'targetDate': '2026-09-04', 'missing': True}
                revision = self.store.dispatch('get', {'conversationId': cid})['conversation']['revision']
                self.store.dispatch('setting', {'key': key, 'value': reference})
                restarted = WorkspaceStore(self.store.path)
                saved = restarted.dispatch('get', {'conversationId': cid})['conversation']
                self.assertEqual(saved['referenceReview'], reference)
                self.assertGreater(saved['revision'], revision)
                self.store.dispatch('setting', {'key': key, 'value': reference})
                self.assertEqual(self.store.dispatch('get', {'conversationId': cid})['conversation']['revision'], saved['revision'])
                accepted = self.store.dispatch('accept', {'requestId': request, 'conversationId': cid, 'text': 'Explain the portfolio', 'internalPrompt': internal})
                self.assertIsNone(accepted['conversation']['referenceReview'])
                self.store.dispatch('setting', {'key': key, 'value': reference})
                self.store.dispatch('delete', {'conversationId': cid})
                self.assertIsNone(self.store.dispatch('setting', {'key': key})['value'])

    def test_review_import_adds_no_chat_for_a_close_capture(self):
        from review_runs_v2 import ReviewRunV2Store
        path = Path(self.temp.name) / 'reviews.sqlite3'
        ReviewRunV2Store(path).create(review_kind='portfolio-review', request_id='portfolio-close:2026-11-05:2026-11-05T21:30:00.000Z')
        self.store.import_reviews(ReviewRunV2Store(path))
        self.assertEqual(self.store.dispatch('list', {})['conversations'], [])

    def test_review_import_skips_runs_already_owned_by_workspace(self):
        from review_runs_v2 import ReviewRunV2Store
        source = ReviewRunV2Store(Path(self.temp.name) / 'reviews.sqlite3')
        cid = self.store.dispatch('daily', {'kind': 'balance-review', 'date': '2026-09-06', 'title': 'Balance Review'})['conversation']['id']
        run, _ = source.create(review_kind='balance-review', conversation_id=cid, request_id='run-1')
        source.update(run['runId'], state='succeeded', reportMarkdown='Original report', outcome='ready')
        accepted = self.store.dispatch('accept', {'conversationId': cid, 'requestId': 'daily-turn:' + run['runId'], 'text': 'Prepare Balance Review', 'internalPrompt': True})
        self.store.dispatch('frame', {'turnId': accepted['turn']['id'], 'type': 'complete', 'text': 'Original report'})
        self.store.import_reviews(source)
        self.store.import_reviews(source)
        messages = self.store.dispatch('get', {'conversationId': cid})['conversation']['messages']
        self.assertEqual([m['text'] for m in messages], ['Original report'])

    def test_delete_during_review_import_cannot_restore_saved_conversation(self):
        from review_runs_v2 import ReviewRunV2Store, public_review_conversation_detail
        source = ReviewRunV2Store(Path(self.temp.name) / 'reviews.sqlite3')
        cid = self.store.dispatch('daily', {'kind': 'balance-review', 'date': '2026-09-06', 'title': 'Balance Review'})['conversation']['id']
        run, _ = source.create(review_kind='balance-review', conversation_id=cid, request_id='run-1')
        source.update(run['runId'], state='succeeded', reportMarkdown='Original report', outcome='ready')

        def delete_after_read(original):
            self.store.dispatch('delete', {'conversationId': cid})
            return public_review_conversation_detail(original)

        with patch('review_runs_v2.public_review_conversation_detail', side_effect=delete_after_read):
            self.store.import_reviews(source)
        restarted = WorkspaceStore(self.store.path)
        restarted.import_reviews(source)
        self.assertEqual(restarted.dispatch('list', {})['conversations'], [])
        with restarted.connect() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM messages').fetchone()[0], 0)
        self.assertTrue(source.get(run['runId']))

    def test_balance_narrative_marker_only_identifies_automatic_assistant_turns(self):
        cid = self.store.dispatch('daily', {'kind': 'balance-review', 'date': '2026-09-06', 'title': 'Balance Review'})['conversation']['id']
        for request, internal in [('daily-turn:run1', True), ('daily-narrative:run1', True), ('narrative-retry:run1', True), ('ordinary-follow-up', False)]:
            accepted = self.store.dispatch('accept', {'conversationId': cid, 'requestId': request, 'text': 'Review notes', 'internalPrompt': internal})
            self.store.dispatch('frame', {'turnId': accepted['turn']['id'], 'type': 'complete', 'text': request})
        messages = self.store.dispatch('get', {'conversationId': cid})['conversation']['messages']
        self.assertEqual([message['text'] for message in messages if message['reviewNarrative']], ['daily-narrative:run1', 'narrative-retry:run1'])
        self.assertFalse(next(message for message in messages if message['role'] == 'user')['reviewNarrative'])
        with self.store.connect() as db:
            self.assertEqual(db.execute("SELECT text FROM messages WHERE turn_id=(SELECT id FROM turns WHERE request_id='daily-narrative:run1') AND role='assistant'").fetchone()[0], 'daily-narrative:run1')

    def test_internal_prompts_empty_failures_and_duplicate_imports_are_not_visible_or_counted(self):
        cid = self.store.dispatch('daily', {'kind': 'balance-review', 'date': '2026-09-06', 'title': 'Balance Review'})['conversation']['id']
        accepted = self.store.dispatch('accept', {'conversationId': cid, 'requestId': 'daily-turn:run1', 'text': 'Prepare Balance Review', 'internalPrompt': True})
        self.assertEqual(accepted['conversation']['messages'], [])
        self.store.dispatch('frame', {'turnId': accepted['turn']['id'], 'type': 'complete', 'text': 'Verified report', 'citations': [{'id': 'cite_original'}]})
        explanation = self.store.dispatch('accept', {'conversationId': cid, 'requestId': 'daily-narrative:run1', 'text': 'Explain this Balance Review', 'internalPrompt': True})
        self.store.dispatch('frame', {'turnId': explanation['turn']['id'], 'type': 'failed', 'error': 'Connecting'})
        with self.store.connect() as db:
            # Simulate the former import and old prompts, then repeat migration.
            db.execute("UPDATE messages SET internal=0")
            db.execute("INSERT INTO messages(id,conversation_id,role,text,created_at,source_id) VALUES('duplicate',?,'assistant','Verified report','2026-09-06','review-message:run1:assistant')", (cid,))
            db.execute("DELETE FROM settings WHERE key='visible-history-v1'")
        for _ in range(2):
            self.store = WorkspaceStore(self.store.path)
            messages = self.store.dispatch('get', {'conversationId': cid})['conversation']['messages']
            self.assertEqual([m['text'] for m in messages], ['Verified report'])
            self.assertEqual(messages[0]['citations'], [{'id': 'cite_original'}])
            self.assertEqual(self.store.dispatch('list', {})['conversations'][0]['message_count'], 1)
            self.assertEqual(self.store.dispatch('list', {'query': 'Explain this'})['conversations'], [])
        with self.store.connect() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM messages').fetchone()[0], 5)
        retry = self.store.dispatch('retry-data', {'conversationId': cid, 'turnId': explanation['turn']['id']})
        self.assertTrue(retry['internalPrompt'])
        self.assertEqual(retry['report'], 'Verified report')
        self.assertEqual(retry['reviewPostId'], 'base')
        with self.assertRaises(ValueError):
            self.store.dispatch('retry-data', {'conversationId': cid, 'turnId': accepted['turn']['id']})
        retried = self.store.dispatch('accept', {'conversationId': cid, 'requestId': 'legacy-retry', 'text': retry['text'],
                                                'internalPrompt': retry['internalPrompt'], 'reviewPostId': retry['reviewPostId']})
        self.store.dispatch('frame', {'turnId': retried['turn']['id'], 'type': 'complete', 'text': 'Completed review notes'})
        self.assertEqual(self.store.dispatch('list', {})['conversations'][0]['message_count'], 1)
        chat = self.accept('chat-retry', 'A separate question')
        self.store.dispatch('frame', {'turnId': chat['turn']['id'], 'type': 'failed', 'error': 'Unavailable'})
        chat_retry = self.store.dispatch('retry-data', {'conversationId': chat['conversation']['id'], 'turnId': chat['turn']['id']})
        self.assertIsNone(chat_retry['reviewPostId'])

    def test_acknowledgment_does_not_resolve_and_material_changes_notify(self):
        finding = {'id': 'f', 'sourceId': 's', 'symbol': 'MSFT', 'action': 'exit', 'state': 'open', 'fingerprint': 'one'}
        self.store.dispatch('finding', {'finding': finding})
        self.store.dispatch('finding-read', {'id': 'f', 'acknowledge': True})
        self.assertFalse(self.store.dispatch('finding', {'finding': finding})['material'])
        self.assertEqual(self.store.dispatch('findings', {})['unread'], 0)
        self.assertEqual(self.store.dispatch('findings', {})['findings'][0]['state'], 'open')
        finding['fingerprint'] = 'corrected'
        self.assertTrue(self.store.dispatch('finding', {'finding': finding})['material'])
        self.assertEqual(self.store.dispatch('findings', {})['unread'], 1)

    def test_acknowledged_source_stays_read_through_holdings_and_workflow_refreshes(self):
        finding = {'id': 'source-f', 'sourceId': 'report', 'symbol': 'AMZN',
                   'action': 'signal change', 'state': 'open', 'fingerprint': 'initial',
                   'quantity': 15, 'holdingsVerified': True,
                   'holdingsVerifiedAt': '2026-09-14T19:08:29Z',
                   'event': {'eventType': 'risk_range', 'productKey': 'risk-ranges',
                             'entityId': 'AMZN', 'fieldPath': 'data.AMZN',
                             'publishedAt': '2026-09-10', 'signalValue': 'BEARISH',
                             'excerpt': 'AMZN Trend BEARISH', 'contentSha256': 'source'},
                   'rule': {'weightPct': 2, 'targetWeight': 1}}
        self.assertTrue(self.store.dispatch('finding', {'finding': finding})['material'])
        self.assertEqual(self.store.dispatch('findings', {})['unread'], 1)
        self.store.dispatch('finding-read', {'id': finding['id'], 'acknowledge': True})
        acknowledged = self.store.dispatch('findings', {})['findings'][0]['acknowledged_at']
        with self.store.connect() as db:
            events_before = db.execute("SELECT count(*) FROM events WHERE type='inbox'").fetchone()[0]
        refreshes = [
            {'state': 'pending verification', 'fingerprint': 'offline', 'quantity': None,
             'holdingsVerified': False, 'rule': None},
            {'state': 'open', 'fingerprint': 'restored', 'quantity': 10,
             'holdingsVerified': True, 'holdingsVerifiedAt': '2026-09-14T19:09:29Z',
             'rule': {'weightPct': 1.8, 'targetWeight': 1}},
            {'state': 'resolved', 'fingerprint': 'closed', 'quantity': 0,
             'rule': {'weightPct': 0, 'targetWeight': 1}},
        ]
        for refresh in refreshes:
            with self.subTest(state=refresh['state']):
                finding.update(refresh)
                self.assertFalse(self.store.dispatch('finding', {'finding': finding})['material'])
                inbox = self.store.dispatch('findings', {})
                stored = inbox['findings'][0]
                self.assertEqual(inbox['unread'], 0)
                self.assertEqual(stored['state'], refresh['state'])
                self.assertEqual(stored['fingerprint'], refresh['fingerprint'])
                self.assertEqual(stored['payload']['quantity'], refresh['quantity'])
                self.assertEqual(stored['acknowledged_at'], acknowledged)
        with self.store.connect() as db:
            self.assertEqual(db.execute("SELECT count(*) FROM events WHERE type='inbox'").fetchone()[0], events_before + 3)
        # Adding presentation/history metadata to an existing saved event is
        # not a revised source observation either.
        finding['event'].update({'signalField': 'trend', 'parserVersion': 'new',
                                 'previousEvent': {'signalValue': 'NEUTRAL'}})
        finding['fingerprint'] = 'enriched'
        self.assertFalse(self.store.dispatch('finding', {'finding': finding})['material'])
        self.assertEqual(self.store.dispatch('findings', {})['unread'], 0)

    def test_source_signal_content_and_action_corrections_notify_again(self):
        finding = {'id': 'source-f', 'sourceId': 'report', 'symbol': 'AMZN',
                   'action': 'signal change', 'state': 'open', 'fingerprint': 'unchanged',
                   'event': {'eventType': 'risk_range', 'productKey': 'risk-ranges',
                             'entityId': 'AMZN', 'fieldPath': 'data.AMZN',
                             'publishedAt': '2026-09-10', 'signalValue': 'BEARISH',
                             'excerpt': 'AMZN Trend BEARISH', 'contentSha256': 'source'}}
        self.store.dispatch('finding', {'finding': finding})
        for field, value in [('signalValue', 'NEUTRAL'), ('excerpt', 'AMZN Trend corrected to NEUTRAL'),
                             ('contentSha256', 'corrected-source'), ('action', 'exit')]:
            with self.subTest(correction=field):
                self.store.dispatch('finding-read', {'id': finding['id'], 'acknowledge': True})
                if field == 'action':
                    finding['action'] = value
                else:
                    finding['event'][field] = value
                self.assertTrue(self.store.dispatch('finding', {'finding': finding})['material'])
                self.assertEqual(self.store.dispatch('findings', {})['unread'], 1)
                self.assertEqual(self.store.dispatch('findings', {})['findings'][0]['state'], 'open')


class ConversationLifecycleTests(unittest.TestCase):
    """Only verified deletions are distinguishable; progress and audits never revive chats."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = WorkspaceStore(Path(self.temp.name) / 'workspace.sqlite3')

    def tearDown(self):
        self.temp.cleanup()

    def accept(self, request='r1', text='Hello', cid=None, **extra):
        return self.store.dispatch('accept', {'requestId': request, 'text': text, 'conversationId': cid, **extra})

    def events(self, after=0):
        return self.store.dispatch('events', {'after': after})['events']

    def test_missing_and_deleted_conversations_raise_distinct_typed_key_errors(self):
        from workspace import ConversationDeleted, ConversationNotFound
        accepted = self.accept()
        cid = accepted['conversation']['id']
        self.store.dispatch('delete', {'conversationId': cid})
        lookups = [('get', {'conversationId': cid}), ('source-binding', {'conversationId': cid}),
                   ('archive', {'conversationId': cid}),
                   ('append', {'conversationId': cid, 'sourceId': 'late', 'text': 'Late'})]
        for operation, payload in lookups:
            with self.subTest(operation=operation, kind='deleted'):
                with self.assertRaises(ConversationDeleted) as raised:
                    self.store.dispatch(operation, payload)
                self.assertIsInstance(raised.exception, KeyError)
                self.assertEqual((raised.exception.code, raised.exception.status_code), ('ANALYST_CONVERSATION_DELETED', 410))
                self.assertEqual(str(raised.exception), 'Conversation was deleted')
            with self.subTest(operation=operation, kind='missing'):
                with self.assertRaises(ConversationNotFound) as raised:
                    self.store.dispatch(operation, {**payload, 'conversationId': 'never-saved'})
                self.assertEqual((raised.exception.code, raised.exception.status_code), ('ANALYST_CONVERSATION_NOT_FOUND', 404))
                self.assertEqual(str(raised.exception), 'Conversation not found')
        with self.assertRaises(ConversationNotFound):
            self.store.dispatch('delete', {'conversationId': 'never-saved'})
        self.assertEqual(self.store.dispatch('delete', {'conversationId': cid}), {'ok': True})
        self.assertEqual(self.store.deleted_conversation_ids(), {cid})

    def test_source_progress_is_a_compact_event_for_live_conversations_only(self):
        accepted = self.accept()
        cid = accepted['conversation']['id']
        cursor = self.store.dispatch('event-cursor', {})['cursor']
        self.assertTrue(self.store.record_source_progress(cid, 'run-1', 'portfolio', 'ready'))
        [event] = self.events(cursor)
        self.assertEqual((event['type'], event['conversation_id'], event['payload']),
                         ('source-progress', cid, {'runId': 'run-1', 'source': 'portfolio', 'status': 'ready'}))
        self.assertGreater(self.store.dispatch('get', {'conversationId': cid})['conversation']['revision'], 0)
        for invalid in ((None, 'run', 'source', 'ready'), (cid, '', 'source', 'ready'), (cid, 'run', 'x' * 201, 'ready'),
                        ('never-saved', 'run', 'source', 'ready')):
            with self.subTest(invalid=invalid):
                self.assertFalse(self.store.record_source_progress(*invalid))
        self.store.dispatch('delete', {'conversationId': cid})
        cursor = self.store.dispatch('event-cursor', {})['cursor']
        self.assertFalse(self.store.record_source_progress(cid, 'run-1', 'balance', 'ready'))
        self.assertEqual(self.events(cursor), [])
        self.assertEqual(self.store.dispatch('list', {})['conversations'], [])

    def test_activity_counts_only_in_progress_work_updated_within_the_window(self):
        self.assertEqual(self.store.activity(1800), {'turns': 0})
        chat = self.accept('chat', 'Hello')
        self.accept('other', 'Another question')
        finished = self.accept('finished', 'Done soon')
        cursor = self.store.dispatch('event-cursor', {})['cursor']
        self.assertEqual(self.store.activity(1800), {'turns': 3})
        # Reading activity writes nothing.
        self.assertEqual(self.events(cursor), [])
        self.store.dispatch('frame', {'turnId': finished['turn']['id'], 'type': 'complete', 'text': 'Saved final'})
        self.assertEqual(self.store.activity(1800), {'turns': 2})
        # A row left in progress but not updated within the window stops counting.
        with sqlite3.connect(self.store.path) as db:
            db.execute("UPDATE turns SET updated_at='2026-01-01T00:00:00Z' WHERE id=?", (chat['turn']['id'],))
        self.assertEqual(self.store.activity(1800), {'turns': 1})

    def test_retired_manual_updates_are_rejected_and_their_saved_chats_load_as_ordinary_chats(self):
        accepted = self.accept('manual', 'Verify my complete portfolio')
        cid = accepted['conversation']['id']
        self.store.dispatch('frame', {'turnId': accepted['turn']['id'], 'type': 'complete', 'text': 'Verified'})
        # A database saved before the retirement still holds the capture table.
        with sqlite3.connect(self.store.path) as db:
            db.executescript('''
              CREATE TABLE manual_verifications (capture_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL,
                turn_id TEXT NOT NULL UNIQUE, state TEXT NOT NULL, sources TEXT NOT NULL, result TEXT, pages TEXT,
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT, error_code TEXT);
              CREATE INDEX manual_verification_history ON manual_verifications(conversation_id,created_at);
              INSERT INTO settings VALUES('manual-verification-cursor-key','"secret"');''')
            db.execute("INSERT INTO manual_verifications VALUES('capture',?,?,'ready','[]',NULL,NULL,'t','t','t',NULL)",
                       (cid, accepted['turn']['id']))
        restarted = WorkspaceStore(self.store.path)
        with sqlite3.connect(self.store.path) as db:
            self.assertIsNone(db.execute("SELECT 1 FROM sqlite_master WHERE name LIKE 'manual_verification%'").fetchone())
            self.assertIsNone(db.execute("SELECT 1 FROM settings WHERE key='manual-verification-cursor-key'").fetchone())
        conversation = restarted.dispatch('get', {'conversationId': cid})['conversation']
        self.assertEqual((conversation['kind'], conversation['messages'][-1]['text']), ('chat', 'Verified'))
        self.assertNotIn('manualVerification', conversation)
        self.assertNotIn('manualVerification', restarted.dispatch('list', {})['conversations'][0])
        with self.assertRaisesRegex(ValueError, 'Unknown chat operation'):
            restarted.dispatch('accept', {'requestId': 'again', 'text': 'Verify my complete portfolio',
                                          'conversationId': cid, 'operation': 'portfolio-cross-verification'})
        self.assertEqual(restarted.activity(1800), {'turns': 0})
        self.assertEqual(restarted.dispatch('delete', {'conversationId': cid}), {'ok': True, 'turnId': None, 'cancelRunId': None})

    def test_delete_audit_event_names_the_removed_chat_and_requesting_client(self):
        accepted = self.accept('first', 'Question about IGV')
        cid = accepted['conversation']['id']
        self.store.dispatch('frame', {'turnId': accepted['turn']['id'], 'type': 'complete', 'text': 'Answer'})
        cursor = self.store.dispatch('event-cursor', {})['cursor']
        self.store.dispatch('delete', {'conversationId': cid, 'requestedBy': {
            'userAgent': 'Mozilla/5.0\nInjected', 'origin': 'http://localhost:3000', 'cookie': 'never-recorded'}})
        [event] = self.events(cursor)
        self.assertEqual((event['type'], event['conversation_id']), ('deleted', cid))
        self.assertEqual(self.audit(event['seq']), {'kind': 'chat', 'title': 'Question about IGV', 'tradingDate': None, 'messageCount': 2,
                                                    'requestedBy': {'userAgent': 'Mozilla/5.0 Injected', 'origin': 'http://localhost:3000'}})
        # Event subscribers never receive the removed chat's text or the requester.
        self.assertEqual(event['payload'], {'kind': 'chat', 'tradingDate': None, 'messageCount': 2})
        daily = self.store.dispatch('daily', {'kind': 'balance-review', 'date': '2026-10-09', 'title': 'Balance Review'})['conversation']
        cursor = self.store.dispatch('event-cursor', {})['cursor']
        self.store.dispatch('delete', {'conversationId': daily['id'], 'requestedBy': 'invalid'})
        [event] = self.events(cursor)
        self.assertEqual(self.audit(event['seq']), {'kind': 'balance-review', 'title': 'Balance Review',
                                                    'tradingDate': '2026-10-09', 'messageCount': 0})
        self.assertEqual(event['payload'], {'kind': 'balance-review', 'tradingDate': '2026-10-09', 'messageCount': 0})

    def audit(self, seq):
        with self.store.connect() as db:
            return json.loads(db.execute('SELECT payload FROM events WHERE seq=?', (seq,)).fetchone()['payload'])

    def test_slow_delete_logs_each_statement_and_fast_delete_is_quiet(self):
        import workspace
        accepted = self.accept()
        with self.assertNoLogs('market_dashboard.analyst.workspace', 'WARNING'):
            self.store.dispatch('delete', {'conversationId': self.accept('fast')['conversation']['id']})
        with patch.object(workspace, 'SLOW_DELETE_SECONDS', -1), \
                self.assertLogs('market_dashboard.analyst.workspace', 'WARNING') as logged:
            self.store.dispatch('delete', {'conversationId': accepted['conversation']['id']})
        line = '\n'.join(logged.output)
        for label in ('begin=', 'messages=', 'events=', 'deleted-event=', 'commit='):
            self.assertIn(label, line)
        self.assertNotIn('Hello', line)

    def test_findings_can_exclude_known_states_without_changing_the_unread_count(self):
        for identifier, state in (('open', 'open'), ('old', 'superseded'), ('done', 'resolved')):
            self.store.dispatch('finding', {'finding': {'id': identifier, 'sourceId': 's', 'symbol': 'MSFT',
                                                        'action': 'exit', 'state': state, 'fingerprint': identifier}})
        everything = self.store.dispatch('findings', {})
        inbox = self.store.dispatch('findings', {'excludeStates': ['superseded', 'resolved']})
        self.assertEqual({row['id'] for row in everything['findings']}, {'open', 'old', 'done'})
        self.assertEqual([row['id'] for row in inbox['findings']], ['open'])
        self.assertEqual(inbox['unread'], everything['unread'])
        self.assertEqual(self.store.dispatch('findings', {'excludeStates': []}), everything)
        for invalid in (['deleted'], 'superseded', [1], ['open'] * 5, ["open') OR 1=1 --"]):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                self.store.dispatch('findings', {'excludeStates': invalid})

    def test_conversation_event_lookups_are_indexed(self):
        with sqlite3.connect(self.store.path) as db:
            indexes = {row[1] for row in db.execute("PRAGMA index_list('events')")}
            plan = ' '.join(str(row[-1]) for row in db.execute(
                'EXPLAIN QUERY PLAN SELECT coalesce(max(seq),0) FROM events WHERE conversation_id=?', ('chat',)))
        self.assertIn('events_conversation', indexes)
        self.assertIn('events_conversation', plan)


if __name__ == '__main__':
    unittest.main()
