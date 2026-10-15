"""Dashboard-owned Analyst history. All visible mutations and replay events commit together."""
from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timezone
import json
import logging
from pathlib import Path
import re
import sqlite3
import time
from uuid import uuid4, uuid5, NAMESPACE_URL

LOGGER = logging.getLogger('market_dashboard.analyst.workspace')
MANUAL_METADATA_COLUMNS = 'capture_id,conversation_id,turn_id,state,created_at,updated_at,completed_at,error_code'
FINDING_STATES = frozenset({'open', 'resolved', 'superseded', 'unavailable'})
SLOW_DELETE_SECONDS = 1.0


class ConversationNotFound(KeyError):
    """No conversation, live or deleted, has this id. The client may forget it."""
    code = 'ANALYST_CONVERSATION_NOT_FOUND'
    status_code = 404

    def __str__(self):
        return str(self.args[0]) if self.args else 'Conversation not found'


class ConversationDeleted(KeyError):
    """The conversation was explicitly deleted; its tombstone is the verification."""
    code = 'ANALYST_CONVERSATION_DELETED'
    status_code = 410

    def __str__(self):
        return str(self.args[0]) if self.args else 'Conversation was deleted'


LEGACY_UNCHANGED_REVIEW = re.compile(
    r'Fresh inputs checked at \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\. '
    r'No material changes to the preceding review\.'
)
RESPONSE_TIMEOUT_ERROR = 'The response exceeded its time limit. Retry is available.'


def now():
    return datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')


def stable(value):
    return str(uuid5(NAMESPACE_URL, 'analyst-workspace:' + str(value)))


def finding_source_revision(finding):
    event = finding.get('event')
    if not isinstance(event, dict) or not event:
        return None
    # Source corrections can notify again; refreshed holdings and workflow
    # state do not make an acknowledged research observation new.
    fields = ('productKey', 'entityId', 'eventType', 'fieldPath', 'publishedAt',
              'marketDate', 'contentSha256', 'excerpt', 'signalValue', 'value',
              'trade', 'trend', 'action', 'actionType', 'targetQuantity')
    return {
        'sourceId': finding.get('sourceId'), 'symbol': finding.get('symbol'),
        'action': finding.get('action'),
        'event': {field: event.get(field) for field in fields},
    }


def imported_citations(messages):
    found = {}
    def visit(value):
        if isinstance(value, str):
            start = value.find('{')
            if start >= 0:
                try:
                    parsed, _ = json.JSONDecoder().raw_decode(value[start:])
                    visit(parsed)
                except (ValueError, RecursionError):
                    pass
        elif isinstance(value, dict):
            if str(value.get('id', '')).startswith('cite_') and value.get('sourceUri'):
                found[value['id']] = value
            # Compact manual verification retains the same citation evidence
            # as a columnar table; accept only complete, identified rows.
            columns, rows = value.get('columns'), value.get('rows')
            citation_columns = ['id', 'documentId', 'product', 'publicationDate', 'publishedAt', 'sourceUri']
            if (columns == citation_columns and isinstance(rows, list)
                    and value.get('rowCount') == len(rows)
                    and all(isinstance(row, list) and len(row) == len(columns) for row in rows)):
                for row in rows:
                    visit(dict(zip(columns, row)))
            for child in value.values():
                if isinstance(child, (dict, list)) or isinstance(child, str) and child.lstrip().startswith(('{', '[')):
                    visit(child)
        elif isinstance(value, list):
            for child in value:
                visit(child)
    for message in messages:
        if message['role'] == 'tool':
            visit(message.get('content'))
    return found


def source_timestamp(value):
    """Normalize the source observation without substituting reconciliation time."""
    try:
        observed = (datetime.fromtimestamp(float(value), timezone.utc)
                    if isinstance(value, (int, float)) else datetime.fromisoformat(str(value).replace('Z', '+00:00')))
        if observed.tzinfo is None:
            return None
        return observed.astimezone(timezone.utc)
    except (TypeError, ValueError, OverflowError, OSError):
        return None


def has_tool_calls(message):
    calls = message.get('tool_calls')
    if isinstance(calls, str):
        try:
            calls = json.loads(calls)
        except ValueError:
            return True
    return bool(calls)


def response_history_message(message):
    """Expose only response-gate fields, leaving Hermes reasoning blobs private."""
    result = {key: message[key] for key in (
        'id', 'session_id', 'role', 'content', 'timestamp', 'name', 'tool_name', 'toolName', 'tool_call_id', 'tool_calls',
    ) if key in message}
    calls = result.get('tool_calls')
    if isinstance(calls, str):
        try:
            result['tool_calls'] = json.loads(calls)
        except ValueError:
            pass
    return result


class WorkspaceStore:
    def __init__(self, path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as db:
            db.executescript('''
              PRAGMA journal_mode=WAL;
              CREATE TABLE IF NOT EXISTS conversations (
                id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL,
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                archived INTEGER NOT NULL DEFAULT 0, hermes_id TEXT,
                trading_date TEXT, UNIQUE(kind,trading_date));
              CREATE TABLE IF NOT EXISTS turns (
                id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id),
                request_id TEXT NOT NULL UNIQUE, state TEXT NOT NULL, error TEXT,
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL, review_post_id TEXT);
              CREATE UNIQUE INDEX IF NOT EXISTS one_running_turn ON turns(conversation_id)
                WHERE state IN ('accepted','running');
              CREATE TABLE IF NOT EXISTS messages (
                id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id),
                turn_id TEXT REFERENCES turns(id), role TEXT NOT NULL, text TEXT NOT NULL,
                citations TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL,
                state TEXT NOT NULL DEFAULT 'complete', source_id TEXT UNIQUE);
              CREATE INDEX IF NOT EXISTS message_history ON messages(conversation_id,created_at);
              CREATE TABLE IF NOT EXISTS events (
                seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
                conversation_id TEXT, turn_id TEXT, message_id TEXT,
                type TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);
              CREATE INDEX IF NOT EXISTS events_conversation ON events(conversation_id, seq);
              CREATE TABLE IF NOT EXISTS deleted_conversations (id TEXT PRIMARY KEY, hermes_id TEXT, kind TEXT, trading_date TEXT, deleted_at TEXT NOT NULL);
              CREATE TABLE IF NOT EXISTS deleted_requests (request_id TEXT PRIMARY KEY);
              CREATE TABLE IF NOT EXISTS manual_verifications (
                capture_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL,
                turn_id TEXT NOT NULL UNIQUE, state TEXT NOT NULL,
                sources TEXT NOT NULL, result TEXT, pages TEXT,
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT,
                error_code TEXT);
              CREATE INDEX IF NOT EXISTS manual_verification_history ON manual_verifications(conversation_id,created_at);
              CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
              CREATE TABLE IF NOT EXISTS upstream_events (turn_id TEXT NOT NULL, event_id TEXT NOT NULL, PRIMARY KEY(turn_id,event_id));
              CREATE TABLE IF NOT EXISTS process_versions (
                id TEXT PRIMARY KEY, document_id TEXT NOT NULL, author TEXT NOT NULL,
                version TEXT NOT NULL, saved_at TEXT NOT NULL, document TEXT NOT NULL);
              CREATE TABLE IF NOT EXISTS findings (
                id TEXT PRIMARY KEY, source_id TEXT NOT NULL, symbol TEXT NOT NULL,
                action TEXT NOT NULL, state TEXT NOT NULL, unread INTEGER NOT NULL DEFAULT 1,
                acknowledged_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                fingerprint TEXT NOT NULL, payload TEXT NOT NULL);
              CREATE TABLE IF NOT EXISTS finding_revisions (
                id TEXT PRIMARY KEY, finding_id TEXT NOT NULL, recorded_at TEXT NOT NULL,
                reason TEXT NOT NULL, record TEXT NOT NULL);
            ''')
            if 'internal' not in {row['name'] for row in db.execute('PRAGMA table_info(messages)')}:
                db.execute('ALTER TABLE messages ADD COLUMN internal INTEGER NOT NULL DEFAULT 0')
            if 'review_post_id' not in {row['name'] for row in db.execute('PRAGMA table_info(turns)')}:
                db.execute('ALTER TABLE turns ADD COLUMN review_post_id TEXT')
            if not db.execute("SELECT 1 FROM settings WHERE key='visible-history-v1'").fetchone():
                # Retain operational history in SQLite, but never attribute automation to the user.
                changed = db.execute("""UPDATE messages SET internal=1 WHERE role='user' AND (source_id LIKE 'review-message:%' OR turn_id IN
                  (SELECT id FROM turns WHERE request_id LIKE 'daily-turn:%' OR request_id LIKE 'daily-narrative:%'))""").rowcount
                changed += db.execute("""UPDATE messages SET internal=1 WHERE EXISTS
                  (SELECT 1 FROM turns t WHERE t.conversation_id=messages.conversation_id
                   AND t.request_id LIKE 'daily-turn:%' AND messages.source_id IN
                   ('review-message:' || substr(t.request_id,12) || ':user',
                    'review-message:' || substr(t.request_id,12) || ':assistant'))""").rowcount
                db.execute("INSERT INTO settings VALUES('visible-history-v1','true')")
                if changed:
                    self.event(db, 'history-updated')

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=15)
        db.row_factory = sqlite3.Row
        db.execute('PRAGMA foreign_keys=ON')
        try:
            with db:
                yield db
        finally:
            db.close()

    def event(self, db, event_type, conversation_id=None, turn_id=None, message_id=None, **payload):
        db.execute('INSERT INTO events(id,conversation_id,turn_id,message_id,type,payload,created_at) VALUES(?,?,?,?,?,?,?)',
                   (str(uuid4()), conversation_id, turn_id, message_id, event_type, json.dumps(payload), now()))

    @staticmethod
    def event_payload(row):
        payload = json.loads(row['payload'])
        if row['type'] == 'deleted' and isinstance(payload, dict):
            # The durable audit row keeps the removed title and requester;
            # subscribers learn only that the conversation was deleted.
            return {key: payload[key] for key in ('kind', 'tradingDate', 'messageCount') if key in payload}
        return payload

    def publish_attention(self, db, params):
        findings = params.get('findings')
        if not isinstance(findings, list):
            raise ValueError('Attention findings required')
        identities = set()
        for finding in findings:
            if (not isinstance(finding, dict) or finding.get('attentionVersion') != 1
                    or not all(isinstance(finding.get(key), str) and finding[key]
                               for key in ('id', 'sourceId', 'symbol', 'action', 'fingerprint'))
                    or finding.get('state') != 'open'
                    or finding.get('kind') not in ('portfolio', 'opportunity', 'market', 'operational', 'account')
                    or not isinstance(finding.get('presentation'), dict)
                    or finding['id'] in identities):
                raise ValueError('Invalid attention finding')
            identities.add(finding['id'])
        observed = now()
        reset = params.get('reset') is True
        complete = set(params.get('completeKinds') or [])
        previous = {row['id']: dict(row) for row in db.execute('SELECT * FROM findings')}
        changed = reset
        cleared = 0

        def archive(row, reason):
            db.execute('INSERT INTO finding_revisions VALUES(?,?,?,?,?)',
                       (str(uuid4()), row['id'], observed, reason, json.dumps(row)))

        # Current publication evidence updates the incident even when its
        # original saved review was deleted or never opened again. A successful
        # import is not a correction to the disputed publisher values.
        promotions = {}
        superseded = set()
        for incoming in findings:
            incident = incoming.get('incidentKey')
            if (not incident or incoming.get('sourceDiscrepancy') is not True
                    or not (incoming.get('sourceQuality') or {}).get('issues')):
                continue
            related = [(row, json.loads(row['payload'])) for row in previous.values()
                       if row['state'] not in ('superseded', 'resolved')
                       and json.loads(row['payload']).get('incidentKey') == incident]
            managed = [(row, payload) for row, payload in related if payload.get('managedBy') == 'review-sources']
            if not managed:
                continue
            dates = [payload.get('firstReportedAt') or payload.get('publicationTime') or row['created_at']
                     for row, payload in related]
            reviews = [review for _, payload in related for review in payload.get('affectedReviews', [])]
            reviews.extend({key: payload.get(key) for key in ('conversationId', 'reviewRunId', 'capturedAt', 'sourceKey')}
                           | {'findingId': row['id']} for row, payload in managed)
            promotions[incoming['id']] = {
                'unread': min(row['unread'] for row, _ in related),
                'firstReportedAt': min(dates),
                'materialRevision': max(payload.get('materialRevision') or 1 for _, payload in related),
                'createdAt': min(row['created_at'] for row, _ in related),
                'acknowledgedAt': next((row['acknowledged_at'] for row, _ in related if row['acknowledged_at']), None),
                'affectedReviews': list({json.dumps(review, sort_keys=True): review for review in reviews}.values()),
            }
            for row, payload in related:
                if row['id'] == incoming['id']:
                    continue
                archive(row, 'source-incident-consolidated')
                payload = {**payload, 'state': 'superseded', 'supersededBy': incoming['id']}
                db.execute("UPDATE findings SET state='superseded',unread=0,updated_at=?,payload=? WHERE id=?",
                           (observed, json.dumps(payload), row['id']))
                superseded.add(row['id'])
                changed = True
        managed_incidents = {json.loads(row['payload']).get('incidentKey') for row in previous.values()
                             if row['id'] not in superseded and row['state'] == 'open'
                             and json.loads(row['payload']).get('managedBy') == 'review-sources'} - {None}
        findings = [finding for finding in findings if finding['id'] in promotions
                    or not finding.get('incidentKey') or finding['incidentKey'] not in managed_incidents]
        identities = {finding['id'] for finding in findings}

        for identity, row in previous.items():
            if identity in superseded:
                continue
            payload = json.loads(row['payload'])
            # Review-source investigations have their own verified lifecycle.
            # A broad scan does not prove their captured delivery failure resolved.
            if payload.get('attentionVersion') == 1 and payload.get('managedBy') == 'review-sources':
                continue
            if payload.get('attentionVersion') != 1:
                if row['state'] != 'superseded' or row['unread']:
                    archive(row, 'attention-migration')
                    db.execute("UPDATE findings SET state='superseded',unread=0,updated_at=? WHERE id=?", (observed, identity))
                    cleared += 1
                    changed = True
                continue
            if reset:
                archive(row, 'requested-inbox-reset')
                cleared += int(bool(row['unread']))
            if identity not in identities:
                # Import success, a new edition, or missing scan coverage does
                # not correct a discrepancy in an immutable publication.
                if payload.get('sourceDiscrepancy') is True:
                    continue
                verified = (payload['assessmentChannel'] in (params.get('completeAssessments') or [])
                            if payload.get('assessmentChannel') else payload.get('kind') in complete)
                # Absence from today's shortlist is not a verified thesis reversal.
                if payload.get('kind') in ('opportunity', 'market'):
                    verified = False
                state = 'resolved' if verified else 'unavailable'
                # Loss of evidence cannot turn an already-resolved issue back into an outage.
                if row['state'] == 'resolved' and state == 'unavailable':
                    continue
                if row['state'] != state:
                    if not reset:
                        archive(row, state)
                    payload['state'] = state
                    db.execute('UPDATE findings SET state=?,updated_at=?,payload=? WHERE id=?',
                               (state, observed, json.dumps(payload), identity))
                    changed = True

        for incoming in findings:
            finding = dict(incoming)
            old = previous.get(finding['id'])
            old_payload = json.loads(old['payload']) if old else {}
            promotion = promotions.get(finding['id'])
            material = not old or old['fingerprint'] != finding['fingerprint'] or old['state'] == 'resolved'
            if promotion:
                material = False  # Same source incident; ownership/copy migration is not a new alert.
            finding['firstReportedAt'] = (promotion or {}).get('firstReportedAt') or old_payload.get('firstReportedAt') or finding.get('publicationTime') or observed
            finding['lastEvaluatedAt'] = observed
            finding['materialRevision'] = (promotion or {}).get('materialRevision') or ((old_payload.get('materialRevision') or 0) + int(material))
            affected_reviews = (promotion or {}).get('affectedReviews') or old_payload.get('affectedReviews')
            if affected_reviews:
                finding['affectedReviews'] = affected_reviews
            if old and not material:
                finding['publicationTime'] = old_payload.get('publicationTime') or finding.get('publicationTime')
                finding['presentation'] = dict(finding['presentation'])
                finding['presentation']['date'] = finding.get('sourceReportDate') or (old_payload.get('presentation') or {}).get('date') or finding['presentation'].get('date')
            if old and (material or old['state'] != 'open') and not reset:
                archive(old, 'material-change' if material else 'verification-restored')
            unread = promotion['unread'] if promotion else (1 if reset or material else old['unread'])
            db.execute('''INSERT INTO findings(id,source_id,symbol,action,state,unread,created_at,updated_at,fingerprint,payload)
              VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET source_id=excluded.source_id,
              symbol=excluded.symbol,action=excluded.action,state=excluded.state,unread=excluded.unread,
              updated_at=excluded.updated_at,fingerprint=excluded.fingerprint,payload=excluded.payload''',
                       (finding['id'], finding['sourceId'], finding['symbol'], finding['action'], 'open', unread,
                        (promotion or {}).get('createdAt') or observed, observed, finding['fingerprint'], json.dumps(finding)))
            if promotion and promotion['acknowledgedAt']:
                db.execute('UPDATE findings SET acknowledged_at=? WHERE id=?', (promotion['acknowledgedAt'], finding['id']))
            changed = True  # Fresh holdings/provenance also reaches the UI without becoming unread.
        db.execute("INSERT INTO settings VALUES('pm-attention-v1',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                   (json.dumps({'enabled': True, 'version': 1}),))
        if changed:
            self.event(db, 'inbox')
        return {'ok': True, 'count': len(findings), 'cleared': cleared}

    def review_record(self, db, cid, turn, kind):
        """Read only the dispatch binding belonging to this exact review turn."""
        if kind not in {'portfolio-review', 'balance-review', 'prediction-markets-review'} or not turn:
            return None
        row = db.execute('SELECT value FROM settings WHERE key=?', ('daily-run:' + cid,)).fetchone()
        try:
            record = json.loads(row['value']) if row else None
        except (ValueError, TypeError):
            return None
        if (not isinstance(record, dict) or not isinstance(record.get('runId'), str) or not record['runId']
                or record.get('kind') not in (None, kind)):
            return None
        acquisition = record.get('turnId') == turn['id'] and turn['request_id'] == 'daily-turn:' + record['runId']
        narrative = record.get('narrativeTurnId') == turn['id'] and turn['request_id'] == 'daily-narrative:' + record['runId']
        if not acquisition and not narrative:
            return None
        return record

    def review_progress(self, db, cid, turn, kind):
        record = self.review_record(db, cid, turn, kind)
        if not record:
            return {}
        phase = 'summarizing' if record.get('narrativeTurnId') == turn['id'] else record.get('reviewPhase')
        if turn['state'] not in ('accepted', 'running'):
            phase = 'terminal'
        if phase not in {'queued', 'acquiring', 'rendering', 'summarizing', 'terminal'}:
            return {}
        progress = {'reviewPhase': phase, 'reviewRunId': record['runId']}
        request_id = record.get('reviewRequestId')
        if isinstance(request_id, str) and request_id.strip() and len(request_id) <= 200:
            progress['reviewRequestId'] = request_id
        return progress

    @staticmethod
    def missing_conversation(db, cid):
        """Only a tombstone verifies deletion; other misses stay plain not-found."""
        if db.execute('SELECT 1 FROM deleted_conversations WHERE id=?', (cid,)).fetchone():
            return ConversationDeleted('Conversation was deleted')
        return ConversationNotFound('Conversation not found')

    def deleted_conversation_ids(self):
        """Tombstoned ids, for hiding deleted chats from other stores on read."""
        with self.connect() as db:
            return {row['id'] for row in db.execute('SELECT id FROM deleted_conversations')}

    def activity(self, window_seconds):
        """Turns and manual captures in progress and updated within the window.

        Read-only. Stack restarts defer while any are reported; an orphaned
        row stops counting once it has not been updated for the window.
        """
        age = "(julianday('now')-julianday(updated_at))*86400<=?"
        with self.connect() as db:
            turns = db.execute(f"SELECT COUNT(*) FROM turns WHERE state IN ('accepted','running') AND {age}",
                               (window_seconds,)).fetchone()[0]
            manual = db.execute(f"SELECT COUNT(*) FROM manual_verifications WHERE state IN ('queued','acquiring') AND {age}",
                                (window_seconds,)).fetchone()[0]
        return {'turns': turns, 'manualCaptures': manual}

    def conversation(self, db, cid):
        row = db.execute('SELECT * FROM conversations WHERE id=?', (cid,)).fetchone()
        if not row:
            raise self.missing_conversation(db, cid)
        result = dict(row)
        result['revision'] = db.execute('SELECT coalesce(max(seq),0) FROM events WHERE conversation_id=?', (cid,)).fetchone()[0]
        result['activeTurn'] = next((dict(t) for t in db.execute("SELECT * FROM turns WHERE conversation_id=? AND state IN ('accepted','running')", (cid,))), None)
        active_review = self.review_record(db, cid, result['activeTurn'], result['kind'])
        visible_review_turn = (result['activeTurn']['id'] if active_review
                              and active_review.get('turnId') == result['activeTurn']['id']
                              and active_review.get('reviewPostId') == (result['activeTurn'].get('review_post_id') or 'base')
                              and active_review.get('reviewPhase') in {'queued', 'acquiring', 'rendering', 'summarizing'}
                              and active_review.get('reviewState') in {'queued', 'running'}
                              and not active_review.get('completedAt') and not active_review.get('error') else None)
        # The accepted capture must own Sources before its first report frame.
        # Ordinary response placeholders and terminal empty reports stay hidden.
        result['messages'] = [dict(m) for m in db.execute("""SELECT * FROM messages WHERE conversation_id=? AND internal=0
            AND (role!='assistant' OR trim(text)!='' OR (turn_id=? AND state='running'))
            ORDER BY created_at,rowid""", (cid, visible_review_turn))]
        for message in result['messages']:
            message['citations'] = json.loads(message['citations'])
        turns = {r['id']: dict(r) for r in db.execute('SELECT * FROM turns WHERE conversation_id=? ORDER BY created_at,rowid', (cid,))}
        internal_turns = {r['turn_id'] for r in db.execute("SELECT turn_id FROM messages WHERE conversation_id=? AND role='user' AND internal=1", (cid,))}
        runs_by_post = {}
        turn_runs = {}
        for turn_id, turn in turns.items():
            request_id = turn.get('request_id') or ''
            post_id = turn.get('review_post_id') or 'base'
            if request_id.startswith(('daily-turn:', 'daily-narrative:')):
                runs_by_post[post_id] = request_id.split(':', 1)[1]
            if turn_id in internal_turns:
                turn_runs[turn_id] = runs_by_post.get(post_id)
            elif request_id.startswith('daily-turn:') and turn.get('review_post_id'):
                binding = db.execute('SELECT value FROM settings WHERE key=?', (f'review-post:{cid}:{post_id}',)).fetchone()
                captured_run = json.loads(binding['value']).get('runId') if binding else None
                if captured_run == request_id.split(':', 1)[1]:
                    turn_runs[turn_id] = captured_run
        review = result['kind'] in ('portfolio-review', 'balance-review', 'prediction-markets-review')
        for message in result['messages']:
            turn = turns.get(message.get('turn_id'), {})
            request_id = turn.get('request_id') or ''
            source_id = message.get('source_id') or ''
            message['reviewNarrative'] = review and message['role'] == 'assistant' and (request_id.startswith(('daily-narrative:', 'narrative-retry:')) or bool(turn.get('review_post_id')) and message.get('turn_id') in internal_turns and not request_id.startswith('daily-turn:'))
            if review and message['role'] == 'assistant' and (turn.get('review_post_id') or request_id.startswith(('daily-turn:', 'daily-narrative:', 'narrative-retry:')) or source_id.startswith(('daily-report:', 'review-message:'))):
                message['reviewPostId'] = turn.get('review_post_id') or 'base'
                message['reviewState'] = turn.get('state') or message.get('state')
                # Older automatic runs sometimes saved only this generated
                # notice. Identify its trusted origin as well as exact text;
                # user dialogue and unfamiliar report wording remain visible.
                generated_report = (request_id.startswith('daily-turn:') and message.get('turn_id') in internal_turns) or source_id.startswith('daily-report:')
                message['reviewUnchanged'] = bool(generated_report and LEGACY_UNCHANGED_REVIEW.fullmatch(message['text']))
                if turn_runs.get(message.get('turn_id')):
                    message['reviewRunId'] = turn_runs[message['turn_id']]
                elif source_id.startswith(('daily-report:', 'review-message:')):
                    message['reviewRunId'] = source_id.split(':', 2)[1]
        result['lastTurn'] = next((dict(t) for t in db.execute('SELECT * FROM turns WHERE conversation_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1', (cid,))), None)
        result.update(self.review_progress(db, cid, result['lastTurn'], result['kind']))
        reference = db.execute('SELECT value FROM settings WHERE key=?', ('portfolio-reference:' + cid,)).fetchone()
        result['referenceReview'] = json.loads(reference['value']) if reference else None
        manual = db.execute(f'SELECT {MANUAL_METADATA_COLUMNS} FROM manual_verifications WHERE conversation_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1', (cid,)).fetchone()
        if manual:
            result['manualVerification'] = self.manual_metadata(manual)
        return result

    @staticmethod
    def manual_metadata(row):
        return {'operation': 'portfolio-cross-verification', 'captureId': row['capture_id'],
                'conversationId': row['conversation_id'], 'turnId': row['turn_id'], 'state': row['state'],
                'checkedAt': row['updated_at'], 'capturedAt': row['completed_at'], 'errorCode': row['error_code']}

    def manual_binding(self, db, params, *, active=False, include_capture=False):
        cid = params.get('conversationId')
        if not isinstance(cid, str) or not cid:
            raise ValueError('An exact manual conversation reference is required')
        conversation = db.execute('SELECT id,kind FROM conversations WHERE id=?', (cid,)).fetchone()
        if not conversation or db.execute('SELECT 1 FROM deleted_conversations WHERE id=?', (cid,)).fetchone():
            raise self.missing_conversation(db, cid)
        tid, capture_id = params.get('turnId'), params.get('captureId')
        columns = '*' if include_capture else MANUAL_METADATA_COLUMNS + ',sources'
        row = db.execute(f'''SELECT {columns} FROM manual_verifications WHERE conversation_id=?
            AND (? IS NULL OR turn_id=?) AND (? IS NULL OR capture_id=?)
            ORDER BY created_at DESC,rowid DESC LIMIT 1''', (cid, tid, tid, capture_id, capture_id)).fetchone()
        if not row:
            raise KeyError('Manual verification not found')
        turn = db.execute('SELECT id,state FROM turns WHERE id=? AND conversation_id=?', (row['turn_id'], cid)).fetchone()
        latest = db.execute('SELECT id FROM turns WHERE conversation_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1', (cid,)).fetchone()
        if not turn or active and (not tid or not capture_id or turn['state'] not in {'accepted', 'running'} or latest['id'] != tid):
            raise ValueError('Manual verification no longer owns its accepted turn')
        metadata = self.manual_metadata(row)
        return row, {**metadata, 'turnState': turn['state'], 'items': json.loads(row['sources'])}

    def settle_manual(self, db, tid, state, code, gateway_verdict=None):
        """Settle unfinished manual checks without implying a Gateway disconnect.

        ``gateway_verdict`` is the acquisition's classification of its Gateway
        check: ``disconnected`` (verified), ``unverified`` or ``connected``.
        Without one, only a captured disconnected Gateway row is a verified one.
        """
        from manual_portfolio_verification import sanitize_manual_sources
        row = db.execute(f'SELECT {MANUAL_METADATA_COLUMNS},sources FROM manual_verifications WHERE turn_id=?', (tid,)).fetchone()
        if not row or row['state'] not in {'queued', 'acquiring'}:
            return False
        sources = json.loads(row['sources'])
        gateway = next((item for item in sources if isinstance(item, dict) and item.get('id') == 'ibGateway'), {})
        if gateway_verdict not in {'disconnected', 'unverified', 'connected'}:
            gateway_verdict = 'disconnected' if gateway.get('connectionState') == 'disconnected' else None
        gateway_code = (gateway.get('diagnostic') or {}).get('code') or code
        for item in sources:
            if item.get('status') != 'checking':
                continue
            if gateway_verdict == 'disconnected' and item.get('requiresIbGateway') is True:
                # A verified disconnect settles broker-dependent checks as unavailable.
                item.update(status='unavailable', observedAt=None, diagnostic={'code': gateway_code})
            else:
                item.update(status='missing', observedAt=None, diagnostic={'code': 'SOURCE_NOT_ATTEMPTED'})
        db.execute('UPDATE manual_verifications SET state=?,sources=?,updated_at=?,completed_at=?,error_code=? WHERE turn_id=?',
                   (state, json.dumps(sanitize_manual_sources(sources)), now(), now(), code, tid))
        self.event(db, 'revision', row['conversation_id'], tid)
        return True

    def settle_orphaned_manual_verifications(self):
        """Close captures left queued/acquiring by a previous sidecar process.

        Call once at startup, before any new capture can start: those rows
        have no owning acquisition task. Their chats and turns are kept.
        """
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            turns = [row['turn_id'] for row in db.execute(
                "SELECT turn_id FROM manual_verifications WHERE state IN ('queued','acquiring')")]
            return sum(bool(self.settle_manual(db, tid, 'interrupted', 'MANUAL_VERIFICATION_RESTARTED')) for tid in turns)

    def record_source_progress(self, conversation_id, run_id, source, status):
        """Record one committed review checkpoint so Sources can revalidate."""
        values = (conversation_id, run_id, source, status)
        if any(not isinstance(value, str) or not value or len(value) > 200 for value in values):
            return False
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            # Deleted chats stay deleted; late checkpoints never revive them.
            if (db.execute('SELECT 1 FROM deleted_conversations WHERE id=?', (conversation_id,)).fetchone()
                    or not db.execute('SELECT 1 FROM conversations WHERE id=?', (conversation_id,)).fetchone()):
                return False
            self.event(db, 'source-progress', conversation_id, runId=run_id, source=source, status=status)
            return True

    def manual_page(self, capture_id, cursor=None, symbols=None):
        from manual_portfolio_verification import (
            PAGE_BUDGET, decode_cursor, detail_pages, encode_cursor, normalize_symbols,
            summary_pages_fit, summary_transport_pages, wrapped_size,
        )
        if not isinstance(capture_id, str) or not capture_id or len(capture_id) > 200:
            raise ValueError('An issued manual capture reference is required')
        symbols = normalize_symbols(symbols)
        scope = 'detail' if symbols else 'summary'
        with self.connect() as db:
            db.execute('BEGIN')
            row = db.execute('''SELECT m.capture_id,m.state,m.pages,m.result IS NOT NULL AS has_result,
                CASE WHEN ? THEN m.result ELSE NULL END AS result
                FROM manual_verifications m JOIN conversations c ON c.id=m.conversation_id
                WHERE m.capture_id=? AND NOT EXISTS(SELECT 1 FROM deleted_conversations d WHERE d.id=c.id)''', (int(bool(symbols)), capture_id)).fetchone()
            if not row or row['state'] not in {'ready', 'partial'} or not row['has_result']:
                raise KeyError('Captured manual evidence not found')
            secret_row = db.execute("SELECT value FROM settings WHERE key='manual-verification-cursor-key'").fetchone()
            secret = json.loads(secret_row['value'])
            if symbols:
                result = json.loads(row['result'])
                if not set(symbols).issubset({holding.get('ticker') for holding in result.get('allHoldingsChecked') or []}):
                    raise ValueError('Choose symbols present in this capture')
                pages = detail_pages(capture_id, result, symbols)
            else:
                pages = json.loads(row['pages'])
                if not summary_pages_fit(pages):
                    captured = db.execute('SELECT result FROM manual_verifications WHERE capture_id=?', (capture_id,)).fetchone()
                    pages = summary_transport_pages(capture_id, json.loads(captured['result']), pages)
            index = decode_cursor(cursor, capture_id, scope, symbols, secret) if cursor is not None else 0
            if index >= len(pages):
                raise ValueError('Captured evidence page is unavailable')
            page = pages[index]
            page['nextCursor'] = encode_cursor(capture_id, scope, symbols, index + 1, secret) if index + 1 < len(pages) else None
            if wrapped_size(page) >= PAGE_BUDGET:
                raise ValueError('Captured evidence page exceeds its transport budget')
            return page

    def _response_source(self, path, cid, tid, db):
        """Read a late final answer from the exact linked, latest timed-out turn.

        The caller still verifies the wrapped user prompt and same-turn live
        tools before committing. This read never imports or reopens history.
        """
        conversation = db.execute('SELECT * FROM conversations WHERE id=?', (cid,)).fetchone()
        if not conversation or not conversation['hermes_id']:
            return None
        hid = conversation['hermes_id']
        if db.execute('SELECT 1 FROM deleted_conversations WHERE id=? OR hermes_id=?', (cid, hid)).fetchone():
            return None
        turn = db.execute('SELECT * FROM turns WHERE conversation_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1', (cid,)).fetchone()
        if (not turn or turn['id'] != tid or turn['state'] != 'failed'
                or turn['error'] != RESPONSE_TIMEOUT_ERROR
                or db.execute("SELECT 1 FROM turns WHERE conversation_id=? AND state IN ('accepted','running')", (cid,)).fetchone()):
            return None
        prompt = db.execute("SELECT * FROM messages WHERE turn_id=? AND role='user'", (tid,)).fetchone()
        created, failed = source_timestamp(turn['created_at']), source_timestamp(turn['updated_at'])
        if not prompt or not created or not failed or not Path(path).exists():
            return None
        source = None
        try:
            source = sqlite3.connect(Path(path).resolve().as_uri() + '?mode=ro', uri=True)
            source.row_factory = sqlite3.Row
            session = source.execute('SELECT * FROM sessions WHERE id=? AND source=?', (hid, 'market-dashboard-analyst')).fetchone()
            if not session:
                return None
            marker = re.search(r'\[workspace:([^]]+)\]', str(dict(session).get('title') or ''))
            if marker and marker.group(1) != cid:
                return None
            raw = [dict(row) for row in source.execute('SELECT * FROM messages WHERE session_id=? ORDER BY timestamp,id', (hid,))]
        except sqlite3.Error:
            return None
        finally:
            if source:
                source.close()
        users = [index for index, message in enumerate(raw) if message['role'] == 'user']
        if not users:
            return None
        current = raw[users[-1]:]
        user = current[0]
        submitted = source_timestamp(user.get('timestamp'))
        if not submitted or submitted < created:
            return None
        assistants = [message for message in current if message['role'] == 'assistant' and str(message.get('content') or '').strip()]
        if not assistants:
            return None
        final = assistants[-1]
        completed = source_timestamp(final.get('timestamp'))
        if (has_tool_calls(final) or not completed or completed <= failed
                or completed < submitted or completed > datetime.now(timezone.utc)):
            return None
        # A final answer followed by additional tool work is not a completion.
        final_index = current.index(final)
        if any(message['role'] in ('tool', 'assistant', 'user') for message in current[final_index + 1:]):
            return None
        evidence = imported_citations(current)
        return {
            'conversationId': cid, 'turnId': tid, 'hermesId': hid,
            'text': prompt['text'], 'expectedTurnCreatedAt': turn['created_at'],
            'expectedTurnUpdatedAt': turn['updated_at'],
            'sourceMessageId': 'hermes-message:' + str(final['id']),
            'sourceUserMessageId': user['id'], 'sourceUserTimestamp': user['timestamp'],
            'completedAt': completed.isoformat().replace('+00:00', 'Z'),
            'completedText': str(final['content']), 'messages': [response_history_message(message) for message in current],
            'citations': [citation for identifier, citation in evidence.items() if identifier in str(final['content'])],
        }

    def response_source(self, path, conversation_id, turn_id):
        with self.connect() as db:
            return self._response_source(path, conversation_id, turn_id, db)

    def source_binding(self, db, cid):
        """Resolve a captured review without reading message bodies or citations."""
        row = db.execute('SELECT id,kind FROM conversations WHERE id=?', (cid,)).fetchone()
        if not row:
            raise self.missing_conversation(db, cid)
        active = db.execute("SELECT id,state,request_id FROM turns WHERE conversation_id=? AND state IN ('accepted','running')", (cid,)).fetchone()
        revision = db.execute('SELECT coalesce(max(seq),0) FROM events WHERE conversation_id=?', (cid,)).fetchone()[0]

        def setting(key):
            value = db.execute('SELECT value FROM settings WHERE key=?', (key,)).fetchone()
            parsed = json.loads(value['value']) if value else {}
            return parsed if isinstance(parsed, dict) else {}

        run_id = setting('daily-run:' + cid).get('runId') or setting('portfolio-reference:' + cid).get('runId')
        if not run_id and row['kind'] in {'portfolio-review', 'prediction-markets-review', 'balance-review'}:
            candidates = db.execute('''SELECT m.source_id,t.id AS turn_id,t.request_id,t.review_post_id,
                EXISTS(SELECT 1 FROM messages u WHERE u.turn_id=t.id AND u.role='user' AND u.internal=1) AS internal_turn
                FROM messages m LEFT JOIN turns t ON t.id=m.turn_id
                WHERE m.conversation_id=? AND m.internal=0 AND m.role='assistant' AND trim(m.text)!=''
                ORDER BY m.created_at DESC,m.rowid DESC''', (cid,))
            for message in candidates:
                request_id = message['request_id'] or ''
                post_id = message['review_post_id'] or 'base'
                if message['internal_turn']:
                    latest = db.execute('''SELECT request_id FROM turns WHERE conversation_id=?
                        AND coalesce(nullif(review_post_id,''),'base')=?
                        AND (request_id LIKE 'daily-turn:%' OR request_id LIKE 'daily-narrative:%')
                        ORDER BY created_at DESC,rowid DESC LIMIT 1''', (cid, post_id)).fetchone()
                    if latest:
                        run_id = latest['request_id'].split(':', 1)[1]
                elif request_id.startswith('daily-turn:') and message['review_post_id']:
                    captured = setting(f'review-post:{cid}:{post_id}').get('runId')
                    if captured == request_id.split(':', 1)[1]:
                        run_id = captured
                if not run_id and (message['source_id'] or '').startswith(('daily-report:', 'review-message:')):
                    run_id = message['source_id'].split(':', 2)[1]
                if run_id:
                    break
        conversation = {**dict(row), 'activeTurn': {key: active[key] for key in ('id', 'state')} if active else None}
        manual = db.execute(f'SELECT {MANUAL_METADATA_COLUMNS} FROM manual_verifications WHERE conversation_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1', (cid,)).fetchone()
        if manual:
            conversation['manualVerification'] = self.manual_metadata(manual)
        dispatch = self.review_record(db, cid, active, row['kind'])
        if dispatch and dispatch.get('startPending') is True:
            conversation['reviewStartPending'] = True
        return {'conversation': conversation,
                'runId': run_id or None, 'revision': revision,
                'cursor': db.execute('SELECT coalesce(max(seq),0) FROM events').fetchone()[0]}

    def with_review_start_owner(self, conversation_id, workspace_turn_id, review_kind,
                                run_id, request_id, create_run):
        """Create an accepted review while Stop/delete/replacement cannot change its owner.

        The callback only creates the local run record. Provider work must start
        after this method returns, when the workspace transaction has committed.
        No conversation history or captured evidence is hydrated under this lock.
        """
        from review_runs_v2 import ReviewRunError

        def rejected(status_code=409):
            raise ReviewRunError(
                'REVIEW_START_OWNER_REJECTED',
                'Review dispatch no longer owns the accepted turn.',
                status_code=status_code,
            )

        if (not isinstance(review_kind, str)
                or review_kind not in {'portfolio-review', 'balance-review', 'prediction-markets-review'}
                or any(not isinstance(value, str) or not value or len(value) > 200
                       for value in (conversation_id, workspace_turn_id, run_id, request_id))):
            rejected()
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            if (db.execute('SELECT 1 FROM deleted_conversations WHERE id=?', (conversation_id,)).fetchone()
                    or db.execute('SELECT 1 FROM deleted_requests WHERE request_id IN (?,?)',
                                  ('daily-turn:' + run_id, request_id)).fetchone()):
                rejected(403)
            conversation = db.execute('SELECT kind FROM conversations WHERE id=?', (conversation_id,)).fetchone()
            if not conversation:
                rejected(403)
            turn = db.execute("""SELECT id,request_id,state,error FROM turns WHERE conversation_id=?
                AND state IN ('accepted','running')""", (conversation_id,)).fetchone()
            saved = db.execute('SELECT value FROM settings WHERE key=?', ('daily-run:' + conversation_id,)).fetchone()
            try:
                record = json.loads(saved['value']) if saved else None
            except (ValueError, TypeError):
                record = None
            start = record.get('startRequest') if isinstance(record, dict) else None
            if (conversation['kind'] != review_kind or not turn
                    or turn['id'] != workspace_turn_id or turn['request_id'] != 'daily-turn:' + run_id
                    or turn['error'] or not isinstance(record, dict) or not isinstance(start, dict)
                    or record.get('kind') != review_kind or record.get('runId') != run_id
                    or record.get('turnId') != workspace_turn_id or record.get('completedAt') or record.get('error')
                    or record.get('reviewPhase') == 'terminal'
                    or record.get('reviewState') in ('succeeded', 'failed', 'cancelled', 'interrupted', 'complete')
                    or start.get('reviewKind') != review_kind or start.get('conversationId') != conversation_id
                    or start.get('runId') != run_id or start.get('requestId') != request_id):
                rejected()
            result = create_run()
        return result

    @staticmethod
    def requested_by(value):
        """Bounded browser request metadata for the delete audit record only."""
        if not isinstance(value, dict):
            return None
        result = {}
        for key in ('userAgent', 'origin'):
            text = value.get(key)
            if isinstance(text, str) and text.strip():
                result[key] = re.sub(r'[\x00-\x1f\x7f]', ' ', text).strip()[:300]
        return result or None

    def delete_conversation(self, p):
        cid = p['conversationId']
        requested_by = self.requested_by(p.get('requestedBy'))
        timings = []
        started = time.perf_counter()
        try:
            with self.connect() as db:
                def timed(label, sql, parameters=()):
                    began = time.perf_counter()
                    cursor = db.execute(sql, parameters)
                    timings.append((label, time.perf_counter() - began))
                    return cursor
                # Serialize retries with the tombstone write. Two simultaneous
                # deletes must both succeed, including after a lost response.
                timed('begin', 'BEGIN IMMEDIATE')
                if timed('tombstone-check', 'SELECT 1 FROM deleted_conversations WHERE id=?', (cid,)).fetchone():
                    return {'ok': True}
                conversation = timed('conversation', 'SELECT * FROM conversations WHERE id=?', (cid,)).fetchone()
                if not conversation:
                    raise self.missing_conversation(db, cid)
                active = timed('active-turn', "SELECT id FROM turns WHERE conversation_id=? AND state IN ('accepted','running')", (cid,)).fetchone()
                saved_run = timed('daily-run', 'SELECT value FROM settings WHERE key=?', ('daily-run:' + cid,)).fetchone()
                record = json.loads(saved_run['value']) if saved_run else None
                manual = timed('manual', "SELECT capture_id FROM manual_verifications WHERE conversation_id=? AND state IN ('queued','acquiring') ORDER BY created_at DESC,rowid DESC LIMIT 1", (cid,)).fetchone()
                message_count = timed('message-count', 'SELECT count(*) FROM messages WHERE conversation_id=? AND internal=0', (cid,)).fetchone()[0]
                timed('tombstone', 'INSERT INTO deleted_conversations VALUES(?,?,?,?,?)', (cid, conversation['hermes_id'], conversation['kind'], conversation['trading_date'], now()))
                timed('deleted-requests', 'INSERT OR IGNORE INTO deleted_requests SELECT request_id FROM turns WHERE conversation_id=?', (cid,))
                timed('upstream-events', 'DELETE FROM upstream_events WHERE turn_id IN (SELECT id FROM turns WHERE conversation_id=?)', (cid,))
                timed('messages', 'DELETE FROM messages WHERE conversation_id=?', (cid,))
                timed('manual-verifications', 'DELETE FROM manual_verifications WHERE conversation_id=?', (cid,))
                timed('turns', 'DELETE FROM turns WHERE conversation_id=?', (cid,))
                timed('events', 'DELETE FROM events WHERE conversation_id=?', (cid,))
                timed('conversation-row', 'DELETE FROM conversations WHERE id=?', (cid,))
                timed('reference', 'DELETE FROM settings WHERE key=?', ('portfolio-reference:' + cid,))
                began = time.perf_counter()
                # The audit record names what was removed and which client asked.
                self.event(db, 'deleted', cid, kind=conversation['kind'], title=conversation['title'],
                           tradingDate=conversation['trading_date'], messageCount=message_count,
                           **({'requestedBy': requested_by} if requested_by else {}))
                timings.append(('deleted-event', time.perf_counter() - began))
                return {'ok': True, 'turnId': active['id'] if active else None,
                        'cancelRunId': record.get('runId') if record and not record.get('completedAt') else None,
                        **({'cancelManualCaptureId': manual['capture_id']} if manual else {})}
        finally:
            elapsed = time.perf_counter() - started
            if elapsed > SLOW_DELETE_SECONDS:
                # The remainder after the timed statements is the commit (and close).
                remainder = elapsed - sum(seconds for _label, seconds in timings)
                LOGGER.warning('Workspace delete of %s held its write transaction for %.0f ms: %s', cid, elapsed * 1000,
                               ', '.join(f'{label}={seconds * 1000:.0f}ms' for label, seconds in [*timings, ('commit', remainder)]))

    def dispatch(self, operation, p):
        if operation == 'delete':
            return self.delete_conversation(p)
        with self.connect() as db:
            if operation in {'list', 'get', 'source-binding', 'request', 'manual-binding', 'manual-status', 'manual-sources', 'manual-generation'}:
                # sqlite's connection context manager does not begin a read
                # transaction. Keep returned rows and their event cursor in
                # one short WAL snapshot, before any report projection occurs.
                db.execute('BEGIN')
            if operation == 'request':
                request_id = p.get('requestId')
                if not isinstance(request_id, str) or not request_id.strip() or len(request_id) > 200:
                    raise ValueError('An exact accepted request reference is required')
                turn = db.execute('SELECT * FROM turns WHERE request_id=?', (request_id,)).fetchone()
                deleted = bool(db.execute('SELECT 1 FROM deleted_requests WHERE request_id=?', (request_id,)).fetchone())
                return {'status': 'deleted' if deleted else 'accepted' if turn else 'missing',
                        'conversation': self.conversation(db, turn['conversation_id']) if turn and not deleted else None,
                        'turn': dict(turn) if turn and not deleted else None, 'requestId': request_id, 'deleted': deleted}
            if operation in {'manual-binding', 'manual-status', 'manual-sources', 'manual-generation'}:
                row, metadata = self.manual_binding(db, p, active=operation == 'manual-generation', include_capture=operation == 'manual-generation')
                if operation == 'manual-sources':
                    # startedAt anchors the header clock; it is not a source observation.
                    return {**metadata, 'reviewKind': 'portfolio-cross-verification', 'runId': row['capture_id'], 'basis': 'manual',
                            'startedAt': row['created_at']}
                if operation == 'manual-generation':
                    if row['state'] not in {'ready', 'partial'} or not row['result'] or not row['pages']:
                        raise ValueError('Manual verification capture is not ready')
                    captured, pages = json.loads(row['result']), json.loads(row['pages'])
                    from manual_portfolio_verification import summary_transport_pages
                    pages = summary_transport_pages(row['capture_id'], captured, pages)
                    hermes = db.execute('SELECT hermes_id FROM conversations WHERE id=?', (row['conversation_id'],)).fetchone()
                    return {'context': {**self.manual_metadata(row), 'asOf': captured['asOf'],
                        'hermesSessionId': hermes['hermes_id'],
                        'marketDate': captured.get('marketDate'), 'scope': captured['scope'],
                        'complete': captured['complete'], 'positionCount': captured['holdings']['positionCount'],
                        'summaryPageCount': len(pages), 'summaryPages': [
                            {'pageIndex': page['pageIndex'], 'pageHash': page['pageHash']} for page in pages]},
                        'citations': captured.get('citations') or []}
                return metadata
            if operation in {'manual-mark-start', 'manual-checkpoint', 'manual-complete', 'manual-fail', 'manual-cancel'}:
                from manual_portfolio_verification import sanitize_manual_sources
                db.execute('BEGIN IMMEDIATE')
                try:
                    row, metadata = self.manual_binding(db, p, active=operation != 'manual-cancel')
                except (KeyError, ValueError):
                    if operation in {'manual-checkpoint', 'manual-complete', 'manual-fail'}:
                        return {'ignored': True}
                    raise
                tid, cid = row['turn_id'], row['conversation_id']
                if operation == 'manual-cancel' and (p.get('turnId') != tid or p.get('captureId') != row['capture_id']):
                    raise ValueError('An exact manual turn and capture reference is required')
                if operation == 'manual-mark-start':
                    if row['state'] == 'queued':
                        db.execute("UPDATE manual_verifications SET state='acquiring',updated_at=? WHERE capture_id=?", (now(), row['capture_id']))
                        self.event(db, 'revision', cid, tid)
                    return self.manual_binding(db, p)[1]
                if operation in {'manual-fail', 'manual-cancel'}:
                    if p.get('items') is not None and row['state'] in {'queued', 'acquiring'}:
                        db.execute('UPDATE manual_verifications SET sources=? WHERE capture_id=?',
                                   (json.dumps(sanitize_manual_sources(p['items'])), row['capture_id']))
                    self.settle_manual(db, tid, p.get('state') if p.get('state') in {'interrupted', 'cancelled'} else
                                       'cancelled' if operation == 'manual-cancel' else 'failed',
                                       p.get('errorCode') or 'MANUAL_VERIFICATION_FAILED',
                                       gateway_verdict=p.get('gatewayVerdict'))
                    return self.manual_binding(db, p)[1]
                if row['state'] not in {'queued', 'acquiring'}:
                    return {'ignored': True, **metadata}
                sources = sanitize_manual_sources(p.get('items') or [])
                if operation == 'manual-checkpoint':
                    db.execute('UPDATE manual_verifications SET sources=?,updated_at=? WHERE capture_id=?',
                               (json.dumps(sources), now(), row['capture_id']))
                else:
                    captured, pages = p.get('result'), p.get('pages')
                    if (not isinstance(captured, dict) or captured.get('schemaVersion') != 1
                            or captured.get('scope') != 'available-source-archive'
                            or captured.get('holdings', {}).get('liveVerified') is not True
                            or not isinstance(captured.get('allHoldingsChecked'), list)
                            or not isinstance(pages, list) or not pages
                            or any(page.get('captureId') != row['capture_id'] for page in pages)):
                        raise ValueError('A complete identified manual capture is required')
                    state = 'ready' if captured.get('complete') is True else 'partial'
                    for source in sources:
                        if source['status'] == 'checking':
                            source.update(status='unavailable', observedAt=None)
                    db.execute('UPDATE manual_verifications SET state=?,sources=?,result=?,pages=?,updated_at=?,completed_at=? WHERE capture_id=?',
                               (state, json.dumps(sources), json.dumps(captured), json.dumps(pages), now(), now(), row['capture_id']))
                self.event(db, 'revision', cid, tid)
                return self.manual_binding(db, p)[1]
            if operation == 'source-binding':
                return self.source_binding(db, p['conversationId'])
            if operation == 'reconcile-response':
                db.execute('BEGIN IMMEDIATE')
                cid, tid = p.get('conversationId'), p.get('turnId')
                if not p.get('trustedHermesPath'):
                    return {'ignored': True}
                source = self._response_source(p['trustedHermesPath'], cid, tid, db)
                if not source or any(p.get(key) != source[key] for key in (
                        'hermesId', 'sourceMessageId', 'completedAt', 'expectedTurnCreatedAt', 'expectedTurnUpdatedAt')):
                    return {'ignored': True}
                text, citations = p.get('text'), p.get('citations')
                if not isinstance(text, str) or not text.strip() or not isinstance(citations, list):
                    raise ValueError('A verified final response and citations are required')
                # A citation can only survive from the same final source turn;
                # its sanitized presentation is supplied by the response gate.
                source_ids = {citation['id'] for citation in source['citations']}
                if any(not isinstance(citation, dict) or citation.get('id') not in source_ids for citation in citations):
                    raise ValueError('Response citations must belong to the same source turn')
                conflict = db.execute('SELECT turn_id FROM messages WHERE source_id=?', (source['sourceMessageId'],)).fetchone()
                if conflict and conflict['turn_id'] != tid:
                    return {'ignored': True}
                message = db.execute("SELECT * FROM messages WHERE conversation_id=? AND turn_id=? AND role='assistant'", (cid, tid)).fetchone()
                if not message:
                    return {'ignored': True}
                db.execute("UPDATE messages SET text=?,citations=?,state='complete',source_id=?,created_at=? WHERE id=?",
                           (text, json.dumps(citations), source['sourceMessageId'], source['completedAt'], message['id']))
                db.execute("UPDATE turns SET state='complete',error=NULL,updated_at=? WHERE id=?", (source['completedAt'], tid))
                db.execute('UPDATE conversations SET updated_at=max(updated_at,?) WHERE id=?', (source['completedAt'], cid))
                self.event(db, 'complete', cid, tid, message['id'], recovered=True, completedAt=source['completedAt'])
                return {'reconciled': True, 'conversation': self.conversation(db, cid)}
            if operation == 'list':
                archived = int(bool(p.get('archived')))
                query = '%' + str(p.get('query') or '') + '%'
                # Publication revisions and their generated explanations are one
                # review post. Keep every saved row, but count actual dialogue
                # separately; older reviews all belong to their base post.
                rows = db.execute('''SELECT c.*, (SELECT count(DISTINCT CASE
                    WHEN c.kind IN ('portfolio-review','prediction-markets-review','balance-review')
                      AND m.role='assistant' AND (
                        t.review_post_id IS NOT NULL OR t.request_id LIKE 'daily-turn:%' OR t.request_id LIKE 'daily-narrative:%'
                        OR t.request_id LIKE 'narrative-retry:%' OR m.source_id LIKE 'daily-report:%'
                        OR m.source_id LIKE 'review-message:%')
                    THEN 'review:' || coalesce(nullif(t.review_post_id,''),'base')
                    ELSE 'message:' || m.id END)
                  FROM messages m LEFT JOIN turns t ON t.id=m.turn_id
                  WHERE m.conversation_id=c.id AND m.internal=0 AND (m.role!='assistant' OR trim(m.text)!='')) AS message_count,
                  (SELECT state FROM turns t WHERE t.conversation_id=c.id ORDER BY created_at DESC,rowid DESC LIMIT 1) AS state,
                  (SELECT id FROM turns t WHERE t.conversation_id=c.id ORDER BY created_at DESC,rowid DESC LIMIT 1) AS latest_turn_id,
                  (SELECT request_id FROM turns t WHERE t.conversation_id=c.id ORDER BY created_at DESC,rowid DESC LIMIT 1) AS latest_request_id
                  FROM conversations c WHERE archived=? AND (title LIKE ? OR EXISTS
                  (SELECT 1 FROM messages m WHERE m.conversation_id=c.id AND m.internal=0 AND text LIKE ?))
                  ORDER BY created_at DESC,id DESC''', (archived, query, query)).fetchall()
                projected = []
                for row in rows:
                    item = dict(row)
                    turn = {'id': item.pop('latest_turn_id'), 'request_id': item.pop('latest_request_id'), 'state': item['state']}
                    item.update(self.review_progress(db, item['id'], turn, item['kind']))
                    manual = db.execute(f'SELECT {MANUAL_METADATA_COLUMNS} FROM manual_verifications WHERE conversation_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1', (item['id'],)).fetchone()
                    if manual:
                        item['manualVerification'] = self.manual_metadata(manual)
                    projected.append(item)
                return {'conversations': projected, 'cursor': db.execute('SELECT coalesce(max(seq),0) FROM events').fetchone()[0]}
            if operation == 'get':
                return {'conversation': self.conversation(db, p['conversationId']), 'cursor': db.execute('SELECT coalesce(max(seq),0) FROM events').fetchone()[0]}
            if operation == 'retry-data':
                conversation = self.conversation(db, p['conversationId'])
                turn = conversation['lastTurn']
                if not turn or turn['id'] != p['turnId'] or turn['state'] not in ('failed', 'interrupted') or conversation['activeTurn']:
                    raise ValueError('Only the latest interrupted response can be retried.')
                prompt = db.execute("SELECT text,internal FROM messages WHERE turn_id=? AND role='user'", (turn['id'],)).fetchone()
                if not prompt:
                    raise ValueError('The saved prompt is unavailable.')
                report = next((m['text'] for m in reversed(conversation['messages']) if m['role'] == 'assistant' and m['turn_id'] != turn['id']), '')
                review_post_id = turn['review_post_id']
                if not review_post_id and prompt['internal'] and conversation['kind'] in ('portfolio-review', 'prediction-markets-review', 'balance-review'):
                    review_post_id = 'base'
                return {'text': prompt['text'], 'internalPrompt': bool(prompt['internal']), 'report': report,
                        'reviewPostId': review_post_id,
                        'operation': 'portfolio-cross-verification' if db.execute('SELECT 1 FROM manual_verifications WHERE turn_id=?', (turn['id'],)).fetchone() else None}
            if operation == 'events':
                rows = db.execute('SELECT * FROM events WHERE seq>? ORDER BY seq LIMIT 500', (int(p.get('after') or 0),)).fetchall()
                return {'events': [{**dict(r), 'payload': self.event_payload(r)} for r in rows]}
            if operation == 'event-cursor':
                # A live subscription can start without hydrating conversation
                # history or replaying events from before the connection.
                return {'cursor': db.execute('SELECT coalesce(max(seq),0) FROM events').fetchone()[0]}
            if operation == 'accept':
                request = str(p.get('requestId') or '')
                text = str(p.get('text') or '').strip()
                if not request or not text or len(text) > 20000:
                    raise ValueError('A stable request ID and 1–20,000 character message are required')
                manual_operation = p.get('operation')
                if manual_operation not in (None, 'portfolio-cross-verification'):
                    raise ValueError('Unknown chat operation')
                db.execute('BEGIN IMMEDIATE')
                if db.execute('SELECT 1 FROM deleted_requests WHERE request_id=?', (request,)).fetchone():
                    raise ValueError('This conversation was deleted. Start a new chat.')
                prior = db.execute('SELECT * FROM turns WHERE request_id=?', (request,)).fetchone()
                if prior:
                    if (p.get('conversationId') and p['conversationId'] != prior['conversation_id']) or db.execute("SELECT text FROM messages WHERE turn_id=? AND role='user'", (prior['id'],)).fetchone()[0] != text:
                        raise ValueError('Request ID belongs to a different message')
                    has_manual = bool(db.execute('SELECT 1 FROM manual_verifications WHERE turn_id=?', (prior['id'],)).fetchone())
                    if has_manual != (manual_operation == 'portfolio-cross-verification'):
                        raise ValueError('Request ID belongs to a different operation')
                    return {'created': False, 'turn': dict(prior), 'conversation': self.conversation(db, prior['conversation_id'])}
                cid = p.get('conversationId') or str(uuid4())
                if not p.get('conversationId'):
                    db.execute('INSERT INTO conversations(id,kind,title,created_at,updated_at) VALUES(?,?,?,?,?)', (cid, 'chat', text[:80], now(), now()))
                conv = self.conversation(db, cid)
                if p.get('expectedLastTurnId') is not None and (conv['lastTurn'] or {}).get('id') != p['expectedLastTurnId']:
                    raise ValueError('The review was replaced before its summary started')
                if conv['activeTurn']:
                    raise ValueError('A response is already running in this conversation')
                tid, uid, aid = (str(uuid4()) for _ in range(3))
                db.execute('INSERT INTO turns(id,conversation_id,request_id,state,error,created_at,updated_at,review_post_id) VALUES(?,?,?,?,?,?,?,?)',
                           (tid, cid, request, 'accepted', None, now(), now(), str(p.get('reviewPostId') or '').strip() or None))
                db.execute('INSERT INTO messages(id,conversation_id,turn_id,role,text,created_at,state,internal) VALUES(?,?,?,?,?,?,?,?)', (uid, cid, tid, 'user', text, now(), 'complete', int(bool(p.get('internalPrompt')))))
                db.execute('INSERT INTO messages(id,conversation_id,turn_id,role,text,created_at,state) VALUES(?,?,?,?,?,?,?)', (aid, cid, tid, 'assistant', '', now(), 'running'))
                if manual_operation:
                    from manual_portfolio_verification import pending_manual_sources
                    if conv['kind'] != 'chat':
                        raise ValueError('Manual verification belongs to a normal chat')
                    capture_id = str(uuid4())
                    db.execute('INSERT INTO manual_verifications(capture_id,conversation_id,turn_id,state,sources,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',
                               (capture_id, cid, tid, 'queued', json.dumps(pending_manual_sources()), now(), now()))
                    db.execute("INSERT OR IGNORE INTO settings(key,value) VALUES('manual-verification-cursor-key',?)", (json.dumps(str(uuid4())),))
                if not p.get('internalPrompt') or request.startswith('daily-turn:'):
                    db.execute('DELETE FROM settings WHERE key=?', ('portfolio-reference:' + cid,))
                if p.get('internalPrompt') and request.startswith('daily-turn:'):
                    # A started review supersedes its publication-wait notice.
                    # Retain the notice in storage without showing it as current.
                    db.execute("UPDATE messages SET internal=1 WHERE conversation_id=? AND role='assistant' AND source_id LIKE 'waiting:%'", (cid,))
                if p.get('reviewRecord') is not None:
                    record = p['reviewRecord']
                    post_id = str(p.get('reviewPostId') or '').strip() or 'base'
                    if (not isinstance(record, dict) or record.get('kind') != conv['kind']
                            or conv['kind'] not in {'portfolio-review', 'balance-review', 'prediction-markets-review'}
                            or not isinstance(record.get('runId'), str) or not record['runId']
                            or request != 'daily-turn:' + record['runId']
                            or record.get('reviewPostId') != post_id):
                        raise ValueError('Review dispatch must belong to the accepted turn')
                    bound = {**record, 'turnId': tid}
                    db.execute('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
                               ('daily-run:' + cid, json.dumps(bound)))
                    db.execute('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
                               (f'review-post:{cid}:{post_id}', json.dumps({'runId': record['runId'], 'kind': record['kind'],
                                                                        'startedAt': record.get('startedAt')})))
                    binding = p.get('reviewRequestBinding')
                    if binding is not None:
                        if (not isinstance(binding, dict) or not isinstance(binding.get('key'), str)
                                or not binding['key'].startswith(('daily-request:', 'daily-refresh:'))
                                or not isinstance(binding.get('value'), dict)
                                or binding['value'].get('conversationId') != cid
                                or binding['value'].get('runId') != record['runId']):
                            raise ValueError('Review request binding must belong to the accepted dispatch')
                        db.execute('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
                                   (binding['key'], json.dumps({**binding['value'], 'turnId': tid})))
                db.execute('UPDATE conversations SET updated_at=?, archived=0 WHERE id=?', (now(), cid))
                self.event(db, 'accepted', cid, tid, aid)
                return {'created': True, 'turn': dict(db.execute('SELECT * FROM turns WHERE id=?', (tid,)).fetchone()), 'conversation': self.conversation(db, cid)}
            if operation == 'frame':
                db.execute('BEGIN IMMEDIATE')
                turn = db.execute('SELECT * FROM turns WHERE id=?', (p['turnId'],)).fetchone()
                if not turn:
                    return {'ignored': True}
                if turn['state'] not in ('accepted', 'running'):
                    return {'ignored': True}
                cid, tid = turn['conversation_id'], turn['id']
                if p.get('eventId') is not None and p.get('eventId') != '':
                    if not db.execute('INSERT OR IGNORE INTO upstream_events VALUES(?,?)', (tid, str(p['eventId']))).rowcount:
                        return {'ignored': True}
                message = db.execute("SELECT * FROM messages WHERE turn_id=? AND role='assistant'", (tid,)).fetchone()
                kind = p['type']
                if kind == 'session':
                    db.execute('UPDATE conversations SET hermes_id=? WHERE id=?', (p['sessionId'], cid))
                elif kind in ('delta', 'delta_batch'):
                    text = str(p.get('text') or '')
                    if kind == 'delta_batch':
                        entries = p.get('entries')
                        if not isinstance(entries, list) or any(not isinstance(entry, dict) for entry in entries):
                            raise ValueError('Delta batch entries must be a list of frames')
                        pieces = []
                        for entry in entries:
                            if entry.get('eventId') is not None and entry.get('eventId') != '' and not db.execute('INSERT OR IGNORE INTO upstream_events VALUES(?,?)', (tid, str(entry['eventId']))).rowcount:
                                continue
                            pieces.append(str(entry.get('text') or ''))
                        if not pieces:
                            return {'ignored': True}
                        text = ''.join(pieces)
                    db.execute('UPDATE messages SET text=text||? WHERE id=?', (text, message['id']))
                    db.execute("UPDATE turns SET state='running',updated_at=? WHERE id=?", (now(), tid))
                elif kind == 'progress':
                    run_id = p.get('runId')
                    post_id = turn['review_post_id'] or 'base'
                    bindings = {}
                    for key in ('daily-run:' + cid, f'review-post:{cid}:{post_id}'):
                        saved = db.execute('SELECT value FROM settings WHERE key=?', (key,)).fetchone()
                        parsed = json.loads(saved['value']) if saved else {}
                        bindings[key] = parsed if isinstance(parsed, dict) else {}
                    daily = bindings['daily-run:' + cid]
                    post = bindings[f'review-post:{cid}:{post_id}']
                    if (not isinstance(run_id, str) or not run_id
                            or turn['request_id'] != 'daily-turn:' + run_id
                            or not (daily.get('runId') == run_id and daily.get('turnId') == tid
                                    or post.get('runId') == run_id)):
                        raise ValueError('Review progress does not belong to this captured turn')
                    if not isinstance(p.get('text'), str) or not p['text'].strip() or not isinstance(p.get('citations'), list):
                        raise ValueError('Review progress requires a report and captured citations')
                    db.execute("UPDATE messages SET text=?,citations=?,state='reviewing' WHERE id=?",
                               (p['text'], json.dumps(p['citations']), message['id']))
                    db.execute("UPDATE turns SET state='running',updated_at=? WHERE id=?", (now(), tid))
                elif kind in ('complete', 'failed', 'interrupted'):
                    content = p.get('text')
                    citations = json.loads(message['citations']) if p.get('citations') is None else p['citations']
                    status = p.get('partialStatus')
                    if (kind == 'failed' and isinstance(status, str) and status.strip()
                            and message['state'] == 'reviewing' and message['text'].strip()):
                        # A failure after a published progressive revision keeps
                        # that report and its citations, then one status line.
                        content = message['text'].rstrip() + '\n\n' + ' '.join(status.split())
                        citations = json.loads(message['citations'])
                    if not isinstance(citations, list):
                        raise ValueError('Captured citations must be a list')
                    db.execute('UPDATE messages SET text=?,citations=?,state=? WHERE id=?', (message['text'] if content is None else str(content), json.dumps(citations), kind, message['id']))
                    db.execute('UPDATE turns SET state=?,error=?,updated_at=? WHERE id=?', (kind, p.get('error'), now(), tid))
                    if kind in ('failed', 'interrupted'):
                        self.settle_manual(db, tid, kind, 'MANUAL_VERIFICATION_' + kind.upper())
                else:
                    raise ValueError('Unknown frame type')
                db.execute('UPDATE conversations SET updated_at=? WHERE id=?', (now(), cid))
                self.event(db, 'delta' if kind == 'delta_batch' else kind, cid, tid, message['id'],
                           **({'runId': p['runId'], 'reportRevision': p.get('reportRevision')} if kind == 'progress' else {}))
                if p.get('includeConversation') is False:
                    return {'ok': True}
                return {'conversation': self.conversation(db, cid)}
            if operation == 'recover':
                active_turn_ids = set(p.get('activeTurnIds') or [])
                turns = db.execute("SELECT * FROM turns WHERE state IN ('accepted','running') AND (? IS NULL OR (julianday('now')-julianday(updated_at))*86400>?)", (p.get('staleAfterSeconds'), p.get('staleAfterSeconds'))).fetchall()
                turns = [turn for turn in turns if turn['id'] not in active_turn_ids]
                if p.get('resumeReviews') is True:
                    recoverable = []
                    for turn in turns:
                        conversation = db.execute('SELECT kind FROM conversations WHERE id=?', (turn['conversation_id'],)).fetchone()
                        record = self.review_record(db, turn['conversation_id'], turn, conversation['kind']) if conversation else None
                        if (record and record.get('turnId') == turn['id'] and not record.get('completedAt') and not record.get('error')
                                and record.get('reviewPhase') != 'terminal'):
                            continue
                        recoverable.append(turn)
                    turns = recoverable
                for t in turns:
                    db.execute("UPDATE turns SET state='interrupted',error=?,updated_at=? WHERE id=?", ('Dashboard restarted before this response completed. Retry is available.', now(), t['id']))
                    db.execute("UPDATE messages SET state='interrupted' WHERE turn_id=? AND role='assistant'", (t['id'],))
                    self.settle_manual(db, t['id'], 'interrupted', 'MANUAL_VERIFICATION_RESTARTED')
                    self.event(db, 'interrupted', t['conversation_id'], t['id'])
                return {'recovered': len(turns)}
            if operation == 'deleted':
                if 'conversationIds' in p:
                    identifiers = p['conversationIds']
                    if not isinstance(identifiers, list) or len(identifiers) > 500 or any(not isinstance(cid, str) for cid in identifiers):
                        raise ValueError('At most 500 conversation IDs are required')
                    identifiers = list(dict.fromkeys(identifiers))
                    if not identifiers:
                        return {'deletedConversationIds': []}
                    placeholders = ','.join('?' for _ in identifiers)
                    rows = db.execute(f'SELECT id FROM deleted_conversations WHERE id IN ({placeholders})', identifiers)
                    return {'deletedConversationIds': [row['id'] for row in rows]}
                return {'deleted': bool(db.execute('SELECT 1 FROM deleted_conversations WHERE id=?', (p['conversationId'],)).fetchone())}
            if operation == 'archive':
                self.conversation(db, p['conversationId'])
                db.execute('UPDATE conversations SET archived=? WHERE id=?', (int(bool(p.get('archived', True))), p['conversationId']))
                self.event(db, 'archive', p['conversationId'])
                return {'ok': True}
            if operation == 'daily':
                existing = db.execute('SELECT id FROM conversations WHERE kind=? AND trading_date=?', (p['kind'], p['date'])).fetchone()
                removed = db.execute('SELECT 1 FROM deleted_conversations WHERE kind=? AND trading_date=?', (p['kind'], p['date'])).fetchone()
                if removed and not existing and not p.get('reopen'):
                    return {'conversation': None}
                cid = existing['id'] if existing else str(uuid4()) if removed else stable(p['kind'] + ':' + p['date'])
                changed = db.execute('INSERT OR IGNORE INTO conversations(id,kind,title,created_at,updated_at,trading_date) VALUES(?,?,?,?,?,?)', (cid, p['kind'], p['title'], now(), now(), p['date'])).rowcount
                if changed:
                    self.event(db, 'created', cid)
                return {'conversation': self.conversation(db, cid)}
            if operation == 'append':
                cid, sid = p['conversationId'], p['sourceId']
                self.conversation(db, cid)
                changed = db.execute('INSERT OR IGNORE INTO messages(id,conversation_id,role,text,citations,created_at,source_id) VALUES(?,?,?,?,?,?,?)', (stable(sid), cid, 'assistant', p['text'], json.dumps(p.get('citations') or []), p.get('createdAt') or now(), sid)).rowcount
                if changed:
                    self.event(db, 'revision', cid, message_id=stable(sid))
                return {'created': bool(changed)}
            if operation == 'setting':
                if 'value' in p:
                    if 'expectedRunId' in p or 'expectedTurnId' in p:
                        if not p['key'].startswith('daily-run:'):
                            raise ValueError('Conditional review writes require a dispatch binding')
                        db.execute('BEGIN IMMEDIATE')
                        current = db.execute('SELECT value FROM settings WHERE key=?', (p['key'],)).fetchone()
                        try:
                            bound = json.loads(current['value']) if current else {}
                        except (ValueError, TypeError):
                            bound = {}
                        bound = bound if isinstance(bound, dict) else {}
                        proposed = p['value'] if isinstance(p['value'], dict) else {}
                        if (not p.get('expectedRunId') or not p.get('expectedTurnId')
                                or bound.get('runId') != p['expectedRunId'] or bound.get('turnId') != p['expectedTurnId']
                                or bound.get('completedAt') and (bound.get('error') or not proposed.get('completedAt'))):
                            return {'value': bound or None, 'ignored': True}
                    previous = db.execute('SELECT value FROM settings WHERE key=?', (p['key'],)).fetchone()
                    value = json.dumps(p['value'])
                    db.execute('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', (p['key'], value))
                    if p['key'].startswith('portfolio-reference:') and (not previous or previous['value'] != value):
                        self.event(db, 'revision', p['key'].split(':', 1)[1])
                    if p['key'].startswith('daily-run:'):
                        try:
                            before = json.loads(previous['value']) if previous else {}
                        except (ValueError, TypeError):
                            before = {}
                        after = p['value'] if isinstance(p['value'], dict) else {}
                        before = before if isinstance(before, dict) else {}
                        fields = ('turnId', 'narrativeTurnId', 'runId', 'reviewPhase', 'reviewState', 'startPending')
                        if any(before.get(key) != after.get(key) for key in fields):
                            self.event(db, 'revision', p['key'].split(':', 1)[1])
                row = db.execute('SELECT value FROM settings WHERE key=?', (p['key'],)).fetchone()
                return {'value': json.loads(row[0]) if row else None}
            if operation == 'process':
                if p.get('document'):
                    d = p['document']
                    if not d.get('documentId') or not d.get('updatedAt'):
                        raise ValueError('Versioned Process document required')
                    db.execute('INSERT OR IGNORE INTO process_versions VALUES(?,?,?,?,?,?)', (stable(json.dumps(d, sort_keys=True)), d['documentId'], 'Tim (dashboard)', str(d.get('baseVersion') or '1'), d['updatedAt'], json.dumps(d)))
                return {'versions': [dict(r) | {'document': json.loads(r['document'])} for r in db.execute('SELECT * FROM process_versions ORDER BY saved_at DESC')]}
            if operation == 'findings':
                excluded = p.get('excludeStates') or []
                if (not isinstance(excluded, list) or len(excluded) > len(FINDING_STATES)
                        or any(not isinstance(state, str) or state not in FINDING_STATES for state in excluded)):
                    raise ValueError('excludeStates must list known finding states')
                # An inbox reader can skip retired rows; the unread count stays global.
                placeholders = ','.join('?' for _ in excluded)
                rows = db.execute('SELECT * FROM findings' + (f' WHERE state NOT IN ({placeholders})' if excluded else '')
                                  + ' ORDER BY updated_at DESC', excluded).fetchall()
                mode = db.execute("SELECT value FROM settings WHERE key='pm-attention-v1'").fetchone()
                return {'findings': [dict(r) | {'payload': json.loads(r['payload'])} for r in rows], 'unread': db.execute('SELECT count(*) FROM findings WHERE unread=1').fetchone()[0],
                        'attentionVersion': 1 if mode and json.loads(mode['value']).get('enabled') else None}
            if operation == 'attention-publish':
                return self.publish_attention(db, p)
            if operation == 'finding-read':
                if p.get('materialRevision') is not None:
                    current = db.execute('SELECT payload FROM findings WHERE id=?', (p['id'],)).fetchone()
                    if not current or json.loads(current['payload']).get('materialRevision') != p['materialRevision']:
                        return {'ok': True, 'acknowledged': False}
                changed = db.execute('UPDATE findings SET unread=0,acknowledged_at=CASE WHEN ? THEN ? ELSE acknowledged_at END WHERE id=? AND (? IS NULL OR fingerprint=?)',
                                     (bool(p.get('acknowledge')), now(), p['id'], p.get('fingerprint'), p.get('fingerprint'))).rowcount
                self.event(db, 'inbox')
                return {'ok': True, 'acknowledged': bool(changed)}
            if operation == 'finding':
                f = p['finding']
                if f.get('managedBy') == 'review-sources' and f.get('incidentKey'):
                    for row in db.execute("SELECT id,payload FROM findings WHERE state='open'"):
                        current = json.loads(row['payload'])
                        if (row['id'] != f['id'] and current.get('sourceDiscrepancy') is True
                                and current.get('managedBy') != 'review-sources'
                                and current.get('incidentKey') == f['incidentKey']):
                            # Opening an old captured review cannot recreate a
                            # second, stale diagnosis of the same publication.
                            return {'material': False, 'ignored': True, 'supersededBy': row['id']}
                if f.get('attentionVersion') != 1:
                    mode = db.execute("SELECT value FROM settings WHERE key='pm-attention-v1'").fetchone()
                    if mode and json.loads(mode['value']).get('enabled'):
                        # A legacy monitor already in flight at cutover cannot
                        # restore archived observations into the attention queue.
                        return {'material': False, 'ignored': True}
                old = db.execute('SELECT * FROM findings WHERE id=?', (f['id'],)).fetchone()
                previous_source = finding_source_revision(json.loads(old['payload'])) if old else None
                source = finding_source_revision(f)
                material = not old or (previous_source != source if previous_source is not None and source is not None
                                       else old['fingerprint'] != f['fingerprint'])
                updated = material or old['fingerprint'] != f['fingerprint'] or old['state'] != f['state']
                db.execute('''INSERT INTO findings(id,source_id,symbol,action,state,created_at,updated_at,fingerprint,payload) VALUES(?,?,?,?,?,?,?,?,?)
                  ON CONFLICT(id) DO UPDATE SET action=excluded.action,state=excluded.state,updated_at=excluded.updated_at,fingerprint=excluded.fingerprint,payload=excluded.payload,
                  unread=CASE WHEN ? THEN 1 ELSE findings.unread END''', (f['id'], f['sourceId'], f['symbol'], f['action'], f['state'], now(), now(), f['fingerprint'], json.dumps(f), material))
                if updated:
                    self.event(db, 'inbox')
                return {'material': bool(material)}
            raise ValueError('Unknown workspace operation')

    def import_hermes(self, path):
        """Repeatable import: leave Hermes untouched, suppress tools and automation prompts."""
        if not Path(path).exists():
            return 0
        source = sqlite3.connect(f'file:{path}?mode=ro', uri=True)
        source.row_factory = sqlite3.Row
        count = 0
        try:
            with self.connect() as db:
                for row in source.execute("SELECT * FROM sessions WHERE source='market-dashboard-analyst'"):
                    s = dict(row)
                    workspace_marker = re.search(r'\[workspace:([^]]+)\]', str(s.get('title') or ''))
                    if workspace_marker and db.execute('SELECT 1 FROM deleted_conversations WHERE id=?', (workspace_marker.group(1),)).fetchone():
                        continue
                    if db.execute('SELECT 1 FROM deleted_conversations WHERE id=? OR hermes_id=?', (stable('hermes:' + s['id']), s['id'])).fetchone():
                        continue
                    if s.get('hidden'):
                        continue
                    linked = db.execute('SELECT id,kind FROM conversations WHERE hermes_id=?', (s['id'],)).fetchone()
                    linked_review = linked and linked['kind'] in {'portfolio-review', 'prediction-markets-review', 'balance-review'} and str(s.get('title') or '').startswith('[market-dashboard-analyst-review:')
                    if linked and linked[0] != stable('hermes:' + s['id']) and not linked_review:
                        continue
                    raw = [dict(r) for r in source.execute('SELECT * FROM messages WHERE session_id=? ORDER BY timestamp,id', (s['id'],))]
                    audit = any('Perform a read-only portfolio-product reconciliation for Tim.' in str(m.get('content')) or 'analyst_portfolio_reconciliation' in str(m.get('content')) or 'Portfolio Reconciliation' in str(m.get('content')) or 'closing review' in str(m.get('content')).lower() and len(str(m.get('content'))) > 3000 for m in raw if m['role'] == 'user')
                    citations = imported_citations(raw)
                    cid = linked[0] if linked_review else stable('hermes:' + s['id'])
                    created = datetime.fromtimestamp(float(s['started_at']), timezone.utc).isoformat().replace('+00:00', 'Z')
                    title = 'Portfolio audit' if audit else re.sub(r'^\[market-dashboard-analyst:[^]]+\]\s*', '', s.get('title') or '')
                    if not title:
                        title = next((str(m['content'])[:80] for m in raw if m['role'] == 'user'), 'Saved conversation')
                    # The first source read/citation parse happens before this
                    # import owns a write lock. Honor deletes committed during
                    # that work before the first restored row can be written.
                    if not db.in_transaction:
                        db.execute('BEGIN IMMEDIATE')
                    if workspace_marker and db.execute('SELECT 1 FROM deleted_conversations WHERE id=?', (workspace_marker.group(1),)).fetchone():
                        continue
                    if db.execute('SELECT 1 FROM deleted_conversations WHERE id=? OR hermes_id=?', (cid, s['id'])).fetchone():
                        continue
                    count += db.execute('INSERT OR IGNORE INTO conversations(id,kind,title,created_at,updated_at,archived,hermes_id) VALUES(?,?,?,?,?,?,?)', (cid, 'audit' if audit else 'chat', title, created, created, int(bool(s.get('archived'))), s['id'])).rowcount
                    if audit:
                        db.execute("UPDATE conversations SET kind='audit',title='Portfolio audit' WHERE id=?", (cid,))
                        db.execute("DELETE FROM messages WHERE conversation_id=? AND role='user' AND source_id LIKE 'hermes-message:%'", (cid,))
                    for m in raw:
                        if m['role'] not in ('user', 'assistant') or not m.get('content') or (audit and m['role'] == 'user') or m.get('tool_calls'):
                            continue
                        if linked_review and m['role'] == 'user' and len(str(m['content'])) > 3000 and ('ReviewRunV2' in str(m['content']) or 'deterministic report' in str(m['content'])):
                            continue
                        if linked_review and db.execute('SELECT 1 FROM messages WHERE conversation_id=? AND text=?', (cid, str(m['content']))).fetchone():
                            continue
                        sid = 'hermes-message:' + str(m['id'])
                        timestamp = datetime.fromtimestamp(float(m['timestamp']), timezone.utc).isoformat().replace('+00:00', 'Z')
                        evidence = [c for identifier, c in citations.items() if identifier in str(m['content'])]
                        db.execute('INSERT INTO messages(id,conversation_id,role,text,citations,created_at,source_id) VALUES(?,?,?,?,?,?,?) ON CONFLICT(source_id) DO UPDATE SET citations=excluded.citations', (stable(sid), cid, m['role'], str(m['content']), json.dumps(evidence), timestamp, sid))
        finally:
            source.close()
        return count

    def import_reviews(self, store):
        from review_runs_v2 import public_review_conversation_detail
        with store.connect() as source:
            ids = [r[0] for r in source.execute('SELECT conversation_id FROM analyst_review_conversations_v1')]
        for cid in ids:
            with self.connect() as db:
                if db.execute('SELECT 1 FROM deleted_conversations WHERE id=?', (cid,)).fetchone():
                    continue
            with store.connect() as source:
                original = store._decode_conversation(source.execute('SELECT * FROM analyst_review_conversations_v1 WHERE conversation_id=?', (cid,)).fetchone())
                original['runs'] = [store._decode(r) for r in source.execute('SELECT * FROM analyst_review_runs_v2 WHERE conversation_id=? ORDER BY created_at', (cid,))]
            detail = public_review_conversation_detail(original)
            with self.connect() as db:
                # A delete may have committed while the source was being read.
                # Check again under the write lock before restoring any rows.
                db.execute('BEGIN IMMEDIATE')
                if db.execute('SELECT 1 FROM deleted_conversations WHERE id=?', (cid,)).fetchone():
                    continue
                db.execute('INSERT OR IGNORE INTO conversations(id,kind,title,created_at,updated_at,archived,hermes_id) VALUES(?,?,?,?,?,?,?)', (cid, detail['reviewKind'], detail.get('title') or detail['reviewKind'], detail['createdAt'], detail.get('updatedAt') or detail['createdAt'], int(bool(original.get('archivedAt'))), detail.get('hermesSessionId')))
                for m in detail['messages']:
                    sid = 'review-message:' + m['id']
                    if db.execute('SELECT 1 FROM turns WHERE conversation_id=? AND request_id=?', (cid, 'daily-turn:' + str(m.get('runId')))).fetchone():
                        continue
                    db.execute('INSERT OR IGNORE INTO messages(id,conversation_id,role,text,citations,created_at,source_id,internal) VALUES(?,?,?,?,?,?,?,?)', (stable(sid), cid, m['role'], m['text'], json.dumps(m.get('citations') or []), m.get('createdAt') or detail['createdAt'], sid, int(m['role'] == 'user')))
        return len(ids)
