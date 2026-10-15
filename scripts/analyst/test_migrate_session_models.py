import importlib.util
import json
from pathlib import Path
import sqlite3
import stat
import sys
import tempfile
import unittest
from unittest.mock import patch


sys.path.insert(0, str(Path(__file__).parent))
spec = importlib.util.spec_from_file_location('migrate_session_models', Path(__file__).with_name('migrate_session_models.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class SessionModelMigrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name)
        self.profile = self.base / 'profiles/analyst'
        self.profile.mkdir(parents=True)
        self.backups = self.base / 'backups/analyst-session-models'
        self.path = self.profile / 'state.db'
        with sqlite3.connect(self.path) as db:
            db.executescript('''
                PRAGMA journal_mode=WAL;
                CREATE TABLE sessions(id TEXT PRIMARY KEY, source TEXT, model TEXT, model_config TEXT, system_prompt TEXT, archived INTEGER, started_at REAL);
                CREATE TABLE messages(id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, timestamp REAL);
            ''')

    def tearDown(self):
        self.temp.cleanup()

    def insert(self, identifier, *, model='openai/gpt-5.6-luna', source='market-dashboard-analyst', config=None):
        if config is None:
            config = json.dumps({'model': model, 'reasoning_config': {'effort': 'high'}, 'service_tier': 'normal', 'max_iterations': 42})
        with sqlite3.connect(self.path) as db:
            db.execute('INSERT INTO sessions VALUES(?,?,?,?,?,?,?)', (identifier, source, model, config, 'Preserve exact system prompt', 1, 1790762400))
            db.execute('INSERT INTO messages(session_id,role,content,timestamp) VALUES(?,?,?,?)', (identifier, 'assistant', 'Original captured report', 1790762401))

    def rows(self, path=None):
        with sqlite3.connect(path or self.path) as db:
            return {'sessions': db.execute('SELECT * FROM sessions ORDER BY id').fetchall(),
                    'messages': db.execute('SELECT * FROM messages ORDER BY id').fetchall()}

    def test_merges_only_follow_flag_preserving_history_and_private_complete_backup(self):
        self.insert('legacy')
        original = self.rows()
        result = module.migrate_session_models(self.profile, self.backups)
        self.assertEqual(result['updated'], 1)
        self.assertEqual(result['sessionIds'], ['legacy'])
        saved = self.rows()
        before, after = original['sessions'][0], saved['sessions'][0]
        self.assertEqual(before[:3], after[:3])
        self.assertEqual(before[4:], after[4:])
        self.assertEqual(json.loads(after[3]), {**json.loads(before[3]), 'follow_profile_config': True})
        self.assertEqual(saved['messages'], original['messages'])
        backup = Path(result['backupPath'])
        self.assertEqual(self.rows(backup), original)
        self.assertEqual(stat.S_IMODE(backup.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(backup.parent.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(self.backups.stat().st_mode), 0o700)
        repeated = module.migrate_session_models(self.profile, self.backups)
        self.assertEqual(repeated['updated'], 0)
        self.assertIsNone(repeated['backupPath'])
        self.assertEqual([path.resolve() for path in self.backups.iterdir()], [backup.parent])
        self.assertEqual(self.rows(), saved)

    def test_scopes_legacy_effective_model_and_source_and_skips_malformed_objects(self):
        self.insert('legacy-bare', model='gpt-5.6-luna')
        self.insert('config-only', model='', config='{"model":"openai/gpt-5.6-luna","extra":"kept"}')
        self.insert('already-follows', config='{"model":"openai/gpt-5.6-luna","follow_profile_config":true}')
        self.insert('current', model='gpt-6.1-sol', config='{"model":"openai/gpt-5.6-luna"}')
        self.insert('other-source', source='hermes-cli')
        for identifier, config in [('malformed', '{'), ('array', '[]'), ('json-null', 'null')]:
            self.insert(identifier, config=config)
        original = self.rows()
        result = module.migrate_session_models(self.profile, self.backups)
        self.assertEqual(set(result['sessionIds']), {'legacy-bare', 'config-only'})
        self.assertEqual(result['skippedMalformed'], 3)
        unchanged = {row[0]: row for row in original['sessions'] if row[0] not in result['sessionIds']}
        self.assertEqual({row[0]: row for row in self.rows()['sessions'] if row[0] in unchanged}, unchanged)

    def test_exact_session_filter_and_dry_run_leave_no_writes_or_backup(self):
        self.insert('requested')
        self.insert('other')
        original = self.rows()
        inspected = module.migrate_session_models(self.profile, self.backups, ['requested'], dry_run=True)
        self.assertEqual(inspected['eligible'], 1)
        self.assertEqual(inspected['updated'], 0)
        self.assertEqual(self.rows(), original)
        self.assertFalse(self.backups.exists())
        migrated = module.migrate_session_models(self.profile, self.backups, ['requested'])
        self.assertEqual(migrated['sessionIds'], ['requested'])
        self.assertEqual([row for row in self.rows()['sessions'] if row[0] == 'other'],
                         [row for row in original['sessions'] if row[0] == 'other'])

    def test_backup_failure_and_update_failure_roll_back_every_metadata_change(self):
        self.insert('first')
        self.insert('second')
        original = self.rows()
        with patch.object(module, 'private_backup', side_effect=OSError('backup unavailable')):
            with self.assertRaises(OSError):
                module.migrate_session_models(self.profile, self.backups)
        self.assertEqual(self.rows(), original)
        with sqlite3.connect(self.path) as db:
            db.execute("CREATE TRIGGER reject_update BEFORE UPDATE ON sessions WHEN NEW.id='second' BEGIN SELECT RAISE(ABORT,'blocked'); END")
        with self.assertRaises(sqlite3.IntegrityError):
            module.migrate_session_models(self.profile, self.backups)
        self.assertEqual(self.rows(), original)

    def test_private_sqlite_backup_includes_latest_committed_wal_messages(self):
        self.insert('legacy')
        writer = sqlite3.connect(self.path)
        try:
            writer.execute('INSERT INTO messages(session_id,role,content,timestamp) VALUES(?,?,?,?)',
                           ('legacy', 'assistant', 'Latest committed WAL report', 1790762402))
            writer.commit()
            self.assertTrue(Path(str(self.path) + '-wal').exists())
            original = self.rows()
            result = module.migrate_session_models(self.profile, self.backups)
            self.assertEqual(self.rows(Path(result['backupPath'])), original)
            self.assertEqual(self.rows()['messages'], original['messages'])
        finally:
            writer.close()

    def test_missing_database_creates_no_state_or_backup(self):
        self.path.unlink()
        result = module.migrate_session_models(self.profile, self.backups)
        self.assertEqual(result['updated'], 0)
        self.assertFalse(self.path.exists())
        self.assertFalse(self.backups.exists())

    def test_rejects_wrong_profile_and_profile_database_or_backup_symlink(self):
        self.insert('legacy')
        original = self.rows()
        for profile, backup in [(self.base / 'profiles/default', self.backups), (self.profile, self.profile / 'backups')]:
            with self.subTest(profile=profile, backup=backup), self.assertRaises(ValueError):
                module.migrate_session_models(profile, backup)
        outside = self.base / 'outside.db'
        outside.write_bytes(self.path.read_bytes())
        self.path.unlink()
        self.path.symlink_to(outside)
        with self.assertRaises(ValueError):
            module.migrate_session_models(self.profile, self.backups)
        self.path.unlink()
        outside.replace(self.path)
        self.backups.parent.mkdir()
        self.backups.symlink_to(self.profile, target_is_directory=True)
        with self.assertRaises(ValueError):
            module.migrate_session_models(self.profile, self.backups)
        self.assertEqual(self.rows(), original)


if __name__ == '__main__':
    unittest.main()
