"""Exact local dispatch ownership, using isolated stores and no provider requests."""
import asyncio
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import sqlite3
import tempfile
import threading
import unittest
from unittest.mock import Mock, patch
from uuid import uuid4

from review_runs_v2 import ReviewCoordinatorV2, ReviewRunError, ReviewRunV2Store, utc_now_iso
from workspace import WorkspaceStore


class OwnerFixture:
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.workspace = WorkspaceStore(Path(self.temp.name) / 'workspace.sqlite3')
        self.runs = ReviewRunV2Store(Path(self.temp.name) / 'reviews.sqlite3')
        self.kind = 'portfolio-review'
        self.run_id = str(uuid4())
        self.request_id = 'exact-start-request'
        self.cid = self.workspace.dispatch('daily', {
            'kind': self.kind, 'date': '2026-10-06', 'title': 'Portfolio Review',
        })['conversation']['id']
        self.record = {
            'runId': self.run_id, 'kind': self.kind, 'reviewPostId': 'base',
            'reviewPhase': 'queued', 'reviewState': 'queued', 'startPending': True,
            'startRequest': {'reviewKind': self.kind, 'conversationId': self.cid,
                             'runId': self.run_id, 'requestId': self.request_id},
        }
        accepted = self.workspace.dispatch('accept', {
            'conversationId': self.cid, 'requestId': 'daily-turn:' + self.run_id,
            'text': 'Prepare Portfolio Review', 'internalPrompt': True,
            'reviewPostId': 'base', 'reviewRecord': self.record,
        })
        self.tid = accepted['turn']['id']
        self.record['turnId'] = self.tid

    def tearDown(self):
        self.temp.cleanup()

    def guard(self, callback, **changed):
        return self.workspace.with_review_start_owner(**{
            'conversation_id': self.cid, 'workspace_turn_id': self.tid,
            'review_kind': self.kind, 'run_id': self.run_id,
            'request_id': self.request_id, 'create_run': callback, **changed,
        })

    def create(self):
        return self.runs.create(review_kind=self.kind, conversation_id=self.cid,
                                request_id=self.request_id, run_id=self.run_id)

    def save_record(self, record):
        self.workspace.dispatch('setting', {'key': 'daily-run:' + self.cid, 'value': record})

    def assert_rejected(self, callback, status=409, **changed):
        with self.assertRaises(ReviewRunError) as rejected:
            self.guard(callback, **changed)
        self.assertEqual(rejected.exception.code, 'REVIEW_START_OWNER_REJECTED')
        self.assertEqual(rejected.exception.status_code, status)
        callback.assert_not_called()


class ReviewStartOwnerTests(OwnerFixture, unittest.TestCase):
    def test_exact_accepted_and_running_owner_without_history_hydration(self):
        with patch.object(self.workspace, 'conversation', side_effect=AssertionError('History read')):
            run, created = self.guard(self.create)
            self.assertTrue(created)
            self.assertEqual(run['runId'], self.run_id)
            self.workspace.dispatch('frame', {'turnId': self.tid, 'type': 'delta',
                                              'text': 'Progress', 'includeConversation': False})
            self.save_record({**self.record, 'startPending': False, 'reviewState': 'running',
                              'reviewPhase': 'acquiring'})
            replay, created = self.guard(self.create)
        self.assertFalse(created)
        self.assertEqual(replay['runId'], run['runId'])
        self.assertEqual(len(self.runs.list_recent()), 1)

    def test_stopped_turn_and_terminal_dispatch_cannot_start(self):
        self.workspace.dispatch('frame', {'turnId': self.tid, 'type': 'interrupted'})
        self.assert_rejected(Mock())
        with self.workspace.connect() as db:
            db.execute("UPDATE turns SET state='accepted' WHERE id=?", (self.tid,))
        for terminal in ({'completedAt': utc_now_iso()}, {'error': True},
                         {'reviewPhase': 'terminal'}, {'reviewState': 'cancelled'},
                         {'reviewState': 'failed'}, {'reviewState': 'succeeded'}):
            with self.subTest(terminal=terminal):
                self.save_record({**self.record, **terminal})
                self.assert_rejected(Mock())

    def test_deleted_missing_and_request_tombstones_cannot_start(self):
        self.assert_rejected(Mock(), status=403, conversation_id='absent')
        for request in (self.request_id, 'daily-turn:' + self.run_id):
            with self.workspace.connect() as db:
                db.execute('INSERT INTO deleted_requests VALUES(?)', (request,))
            self.assert_rejected(Mock(), status=403)
            with self.workspace.connect() as db:
                db.execute('DELETE FROM deleted_requests WHERE request_id=?', (request,))
        self.workspace.dispatch('delete', {'conversationId': self.cid})
        self.assert_rejected(Mock(), status=403)
        self.assertEqual(self.runs.list_recent(), [])

    def test_replaced_turn_does_not_authorize_old_run(self):
        self.workspace.dispatch('frame', {'turnId': self.tid, 'type': 'interrupted'})
        next_id = str(uuid4())
        replacement = {**self.record, 'runId': next_id, 'startRequest': {
            **self.record['startRequest'], 'runId': next_id, 'requestId': 'replacement',
        }}
        self.workspace.dispatch('accept', {
            'conversationId': self.cid, 'requestId': 'daily-turn:' + next_id,
            'text': 'Replacement', 'internalPrompt': True, 'reviewPostId': 'base',
            'reviewRecord': replacement,
        })
        self.assert_rejected(Mock())

    def test_wrong_tuple_and_unbound_narrative_or_chat_are_rejected(self):
        for field in ('kind', 'runId', 'turnId'):
            with self.subTest(record_field=field):
                self.save_record({**self.record, field: 'other'})
                self.assert_rejected(Mock())
        for field in ('reviewKind', 'conversationId', 'runId', 'requestId'):
            with self.subTest(start_field=field):
                self.save_record({**self.record, 'startRequest': {
                    **self.record['startRequest'], field: 'other',
                }})
                self.assert_rejected(Mock())
        for record in ({}, {**self.record, 'startRequest': None}, [self.record]):
            self.save_record(record)
            self.assert_rejected(Mock())
        self.save_record(self.record)
        with self.workspace.connect() as db:
            db.execute('UPDATE turns SET request_id=? WHERE id=?',
                       ('daily-narrative:' + self.run_id, self.tid))
        self.assert_rejected(Mock())
        with self.workspace.connect() as db:
            db.execute('UPDATE turns SET request_id=? WHERE id=?', ('daily-turn:' + self.run_id, self.tid))
            db.execute("UPDATE conversations SET kind='chat' WHERE id=?", (self.cid,))
        self.assert_rejected(Mock())

    def test_malformed_saved_binding_and_invalid_identity_fail_closed(self):
        for saved in ('{broken', 'null', '42'):
            with self.workspace.connect() as db:
                db.execute('UPDATE settings SET value=? WHERE key=?', (saved, 'daily-run:' + self.cid))
            self.assert_rejected(Mock())
        self.save_record(self.record)
        for changed in ({'workspace_turn_id': ''}, {'run_id': None}, {'request_id': 42},
                        {'review_kind': 'chat'}, {'review_kind': []},
                        {'request_id': 'wrong'}, {'run_id': str(uuid4())}):
            self.assert_rejected(Mock(), **changed)

    def test_failed_creation_rolls_back_and_releases_owner_lock_for_retry(self):
        with patch.object(self.runs, '_insert_run_locked', side_effect=RuntimeError('Local creation failed')):
            with self.assertRaisesRegex(RuntimeError, 'Local creation failed'):
                self.guard(self.create)
        self.assertEqual(self.runs.list_recent(), [])
        with self.runs.connect() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM analyst_review_conversations_v1').fetchone()[0], 0)
        self.assertEqual(self.workspace.dispatch('setting', {'key': 'daily-run:' + self.cid})['value'], self.record)
        self.assertTrue(self.guard(self.create)[1])

    def test_stop_is_serialized_with_creation_and_prevents_later_replay(self):
        creating, release, stopping = threading.Event(), threading.Event(), threading.Event()

        def slow_create():
            creating.set()
            if not release.wait(3):
                raise AssertionError('Creation release missing')
            return self.create()

        def stop():
            stopping.set()
            return self.workspace.dispatch('frame', {'turnId': self.tid, 'type': 'interrupted'})

        with ThreadPoolExecutor(max_workers=2) as executor:
            creation = executor.submit(self.guard, slow_create)
            try:
                self.assertTrue(creating.wait(3))
                with sqlite3.connect(self.workspace.path, timeout=0) as writer:
                    with self.assertRaisesRegex(sqlite3.OperationalError, 'locked'):
                        writer.execute('BEGIN IMMEDIATE')
                stopped = executor.submit(stop)
                self.assertTrue(stopping.wait(3))
                self.assertFalse(stopped.done())
            finally:
                release.set()
            self.assertTrue(creation.result(3)[1])
            stopped.result(3)
        self.assert_rejected(Mock())


class GuardedCoordinatorTests(OwnerFixture, unittest.IsolatedAsyncioTestCase):
    async def test_guard_runs_off_loop_and_provider_starts_after_commit_once(self):
        calls, threads = [], []
        release = asyncio.Event()

        async def handler(context):
            # Provider execution can acquire the workspace write lock itself:
            # guarded creation has already returned and committed.
            with sqlite3.connect(self.workspace.path, timeout=0) as db:
                db.execute('BEGIN IMMEDIATE')
                self.assertEqual(db.execute('SELECT state FROM turns WHERE id=?', (self.tid,)).fetchone()[0], 'accepted')
            calls.append(context.run_id)
            await release.wait()
            return {'outcome': 'blocked', 'sections': [], 'citations': []}

        coordinator = ReviewCoordinatorV2(self.runs, {self.kind: handler})

        def guarded(callback):
            threads.append(threading.get_ident())
            return self.guard(callback)

        args = {'review_kind': self.kind, 'conversation_id': self.cid,
                'request_id': self.request_id, 'run_id': self.run_id, 'guarded_create': guarded}
        try:
            first = await coordinator.start(**args)
            replay = await coordinator.start(**args)
            self.assertEqual(first['runId'], replay['runId'])
            self.assertEqual(len(coordinator.tasks), 1)
            for _ in range(100):
                if calls:
                    break
                await asyncio.sleep(.001)
            self.assertEqual(calls, [self.run_id])
            self.assertTrue(all(identifier != threading.get_ident() for identifier in threads))
        finally:
            release.set()
            await asyncio.gather(*coordinator.tasks.values())

    async def test_guard_rejection_or_creation_failure_never_launches_provider(self):
        handler = Mock()
        coordinator = ReviewCoordinatorV2(self.runs, {self.kind: handler})
        args = {'review_kind': self.kind, 'conversation_id': self.cid,
                'request_id': self.request_id, 'run_id': self.run_id, 'guarded_create': self.guard}
        with patch.object(self.runs, 'create', side_effect=RuntimeError('Creation failed')):
            with self.assertRaisesRegex(RuntimeError, 'Creation failed'):
                await coordinator.start(**args)
        self.workspace.dispatch('frame', {'turnId': self.tid, 'type': 'interrupted'})
        with self.assertRaises(ReviewRunError):
            await coordinator.start(**args)
        self.assertEqual(coordinator.tasks, {})
        self.assertEqual(self.runs.list_recent(), [])
        handler.assert_not_called()

    async def test_stop_after_guard_commit_before_launch_does_not_acquire_sources(self):
        calls = []

        async def handler(context):
            calls.append(context.run_id)
            return {'outcome': 'blocked', 'sections': [], 'citations': []}

        coordinator = ReviewCoordinatorV2(self.runs, {self.kind: handler})
        await coordinator._task_lock.acquire()
        starting = asyncio.create_task(coordinator.start(
            review_kind=self.kind, conversation_id=self.cid, request_id=self.request_id,
            run_id=self.run_id, guarded_create=self.guard,
        ))
        try:
            for _ in range(100):
                if self.runs.get(self.run_id):
                    break
                await asyncio.sleep(.001)
            self.assertIsNotNone(self.runs.get(self.run_id))
            self.assertEqual(coordinator.tasks, {})
            self.workspace.dispatch('frame', {'turnId': self.tid, 'type': 'interrupted'})
            self.runs.update(self.run_id, state='cancelled', phase='terminal', completedAt=utc_now_iso())
        finally:
            coordinator._task_lock.release()
        await starting
        await asyncio.gather(*coordinator.tasks.values())
        self.assertEqual(calls, [])
        self.assertEqual(self.runs.get(self.run_id)['state'], 'cancelled')


if __name__ == '__main__':
    unittest.main()
