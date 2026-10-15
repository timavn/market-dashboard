"""Let legacy dashboard Analyst chats inherit the profile model on future resume."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import sqlite3
import tempfile

from sync_profile_assets import checked_roots


LEGACY_MODEL_IDS = frozenset({'openai/gpt-5.6-luna', 'gpt-5.6-luna'})
ANALYST_SOURCE = 'market-dashboard-analyst'


def private_backup(path: Path, backup_root: Path) -> Path:
    """Snapshot committed SQLite/WAL content before changing any metadata."""
    backup_root.mkdir(parents=True, exist_ok=True)
    backup_root.chmod(0o700)
    prefix = datetime.now(timezone.utc).strftime('analyst-session-models-%Y%m%dT%H%M%SZ-')
    directory = Path(tempfile.mkdtemp(prefix=prefix, dir=backup_root))
    directory.chmod(0o700)
    descriptor, name = tempfile.mkstemp(prefix='state-', suffix='.db', dir=directory)
    os.close(descriptor)
    backup = Path(name)
    backup.chmod(0o600)
    # A separate reader can copy the committed snapshot while the migration
    # holds BEGIN IMMEDIATE. Backing up the writer's own transaction can block.
    with sqlite3.connect(path.as_uri() + '?mode=ro', uri=True) as source:
        with sqlite3.connect(backup) as destination:
            source.backup(destination)
    return backup


def migrate_session_models(profile_home: Path, backup_root: Path, session_ids=None, *, dry_run=False) -> dict:
    profile_home, backup_root = checked_roots(profile_home, backup_root)
    if profile_home.name != 'analyst':
        raise ValueError('Only the Analyst profile may be migrated')
    if backup_root.is_relative_to(profile_home) or profile_home.is_relative_to(backup_root):
        raise ValueError('The private backup root must be outside the Analyst profile')
    path = profile_home / 'state.db'
    if path.is_symlink():
        raise ValueError('The Analyst state database must not be a symlink')
    if not path.exists():
        return {'updated': 0, 'eligible': 0, 'skippedMalformed': 0, 'backupPath': None, 'sessionIds': []}
    requested = list(dict.fromkeys(session_ids or []))
    if any(not isinstance(identifier, str) or not identifier.strip() or len(identifier) > 200 for identifier in requested):
        raise ValueError('Session IDs must be nonempty strings of at most 200 characters')
    mode = 'ro' if dry_run else 'rw'
    with sqlite3.connect(path.as_uri() + '?mode=' + mode, uri=True, timeout=15) as db:
        db.row_factory = sqlite3.Row
        if not dry_run:
            db.execute('BEGIN IMMEDIATE')
        required = {'id', 'source', 'model', 'model_config'}
        if not required.issubset({row['name'] for row in db.execute('PRAGMA table_info(sessions)')}):
            raise ValueError('The Analyst sessions schema is unavailable')
        rows = db.execute('SELECT id,model,model_config FROM sessions WHERE source=?', (ANALYST_SOURCE,))
        changes, malformed = [], 0
        for row in rows:
            if requested and row['id'] not in requested:
                continue
            try:
                config = json.loads(row['model_config'])
            except (TypeError, ValueError):
                malformed += 1
                continue
            if not isinstance(config, dict):
                malformed += 1
                continue
            model = str(row['model'] or config.get('model') or '').strip()
            if model not in LEGACY_MODEL_IDS or config.get('follow_profile_config'):
                continue
            merged = {**config, 'follow_profile_config': True}
            changes.append((json.dumps(merged, ensure_ascii=False), row['id'], row['model_config']))
        backup = private_backup(path, backup_root) if changes and not dry_run else None
        if changes and not dry_run:
            db.executemany('UPDATE sessions SET model_config=? WHERE id=? AND model_config=?', changes)
        return {'updated': len(changes) if not dry_run else 0, 'eligible': len(changes),
                'skippedMalformed': malformed, 'backupPath': str(backup) if backup else None,
                'sessionIds': [change[1] for change in changes]}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--profile-home', type=Path, required=True)
    parser.add_argument('--backup-root', type=Path, required=True)
    parser.add_argument('--session-id', action='append', default=[], help='Optional exact saved session to migrate; may be repeated')
    parser.add_argument('--dry-run', action='store_true', help='Inspect eligible metadata without making a backup or writing')
    arguments = parser.parse_args()
    result = migrate_session_models(arguments.profile_home, arguments.backup_root, arguments.session_id,
                                    dry_run=arguments.dry_run)
    print(json.dumps(result))
