"""Durable, bounded, server-owned Analyst review runs.

ReviewRunV2 deliberately keeps review acquisition and rendering outside Hermes.
Trading values are accepted only after the review-kind provider has applied its
verified-live gates.  Raw evidence is content-addressed once; public run
responses expose fingerprints and deterministic reports, never the archive.
"""

from __future__ import annotations

import asyncio
import base64
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from hashlib import sha256
import inspect
import json
import logging
from pathlib import Path
import re
import sqlite3
import threading
from typing import Any, Awaitable, Callable, Optional, Union
from uuid import NAMESPACE_URL, UUID, uuid4, uuid5


LOGGER = logging.getLogger("market_dashboard.analyst.review_runs_v2")

SCHEMA_VERSION = 2
REVIEW_KINDS = (
    "portfolio-review",
    "prediction-markets-review",
    "balance-review",
)
REVIEW_TITLES = {
    "portfolio-review": "Portfolio Review",
    "prediction-markets-review": "Predictive Markets Review",
    "balance-review": "Balance Review",
}
REVIEW_VISIBLE_MESSAGES = {
    "portfolio-review": "Run Portfolio Review",
    "prediction-markets-review": "Run Predictive Markets Review",
    "balance-review": "Run Balance Review",
}
REVIEW_CONVERSATION_IDS = {
    review_kind: f"review:{review_kind}" for review_kind in REVIEW_KINDS
}
DEADLINE_SECONDS = {
    "portfolio-review": 75,
    "prediction-markets-review": 30,
    "balance-review": 20,
}
ACTIVE_STATES = frozenset({"queued", "running"})
TERMINAL_STATES = frozenset({"succeeded", "failed", "cancelled"})
RUN_STATES = ACTIVE_STATES | TERMINAL_STATES
RUN_PHASES = frozenset({"acquiring", "rendering", "summarizing", "terminal"})
RUN_OUTCOMES = frozenset({"ready", "partial", "blocked"})
MAX_SUMMARY_INPUT_BYTES = 32_000
MAX_SUMMARY_OUTPUT_TOKENS = 1_200
SUMMARY_TIMEOUT_SECONDS = 12
MAX_REVIEW_CONTEXT_BYTES = 24_000


def _legacy_run_conversation_id(run_id: str) -> str:
    """Return the stable UUID used when one fixed-shell run becomes one row."""

    return str(uuid5(NAMESPACE_URL, f"market-dashboard:analyst-review:{run_id}"))


def _namespaced_uuid(value: str) -> Optional[str]:
    """Normalize the short-lived ``review:<uuid>`` development format."""

    candidate = str(value or "").removeprefix("review:")
    try:
        return str(UUID(candidate))
    except (TypeError, ValueError, AttributeError):
        return None


def review_conversation_id(review_kind: str) -> str:
    """Return the single durable shell conversation for a review kind."""

    try:
        return REVIEW_CONVERSATION_IDS[review_kind]
    except KeyError as exc:
        raise ReviewRunError("REVIEW_KIND_INVALID", "Unknown review kind.") from exc


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def canonical_json(value: Any) -> str:
    return json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str
    )


def canonical_fingerprint(value: Any) -> str:
    """The sole ReviewRunV2 hashing implementation.

    Keeping the import and call together makes an undefined ``sha256`` symbol
    impossible in coordinator finalization and gives the startup canary a
    direct target.
    """

    return sha256(canonical_json(value).encode("utf-8")).hexdigest()


def json_copy(value: Any) -> Any:
    return json.loads(json.dumps(value, ensure_ascii=False, default=str))


def _parse_json(value: Any, fallback: Any) -> Any:
    try:
        return json.loads(value) if value else json_copy(fallback)
    except (TypeError, ValueError, json.JSONDecodeError):
        return json_copy(fallback)


def _bounded_text(value: Any, limit: int = 500) -> str:
    return str(value or "").replace("\x00", " ").strip()[:limit]


def _finite(value: Any) -> Optional[float]:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return (
        number
        if number == number and number not in {float("inf"), float("-inf")}
        else None
    )


def _fmt_number(value: Any, decimals: int = 2) -> str:
    number = _finite(value)
    return "Unavailable" if number is None else f"{number:,.{decimals}f}"


def _fmt_money(value: Any) -> str:
    number = _finite(value)
    return "Unavailable" if number is None else f"${number:,.2f}"


def _fmt_percent(value: Any, *, already_percent: bool = True) -> str:
    number = _finite(value)
    if number is None:
        return "Unavailable"
    if not already_percent:
        number *= 100
    return f"{number:,.2f}%"


def _cell(value: Any) -> str:
    text = _bounded_text(value, 600) or "Unavailable"
    return text.replace("|", "\\|").replace("\n", " ")


class ReviewRunError(RuntimeError):
    def __init__(
        self,
        code: str,
        message: str,
        *,
        status_code: int = 400,
        retryable: bool = False,
    ):
        super().__init__(message)
        self.code = code
        self.status_code = status_code
        self.retryable = retryable


def normalized_failure(exc: BaseException) -> dict[str, Any]:
    if isinstance(exc, ReviewRunError):
        return {
            "code": exc.code,
            "message": str(exc),
            "retryable": exc.retryable,
        }
    if isinstance(exc, asyncio.TimeoutError):
        return {
            "code": "REVIEW_DEADLINE_EXCEEDED",
            "message": "The review did not finish within its server deadline.",
            "retryable": True,
        }
    return {
        "code": "REVIEW_COORDINATOR_FAILED",
        "message": "The review service encountered an internal error.",
        "retryable": True,
    }


class ReviewRunV2Store:
    """SQLite persistence for immutable review attempts and evidence blobs."""

    def __init__(self, db_path: Path | str) -> None:
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._initialize()

    def connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.db_path, timeout=30)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA busy_timeout=30000")
        return connection

    def _initialize(self) -> None:
        with self.connect() as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS analyst_review_conversations_v1 (
                    conversation_id TEXT PRIMARY KEY,
                    review_kind TEXT NOT NULL,
                    title TEXT NOT NULL,
                    initial_request_id TEXT NOT NULL UNIQUE,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    hermes_session_id TEXT UNIQUE,
                    archived_at TEXT
                );
                CREATE INDEX IF NOT EXISTS analyst_review_conversations_v1_created
                    ON analyst_review_conversations_v1(created_at DESC, conversation_id DESC);
                CREATE INDEX IF NOT EXISTS analyst_review_conversations_v1_kind
                    ON analyst_review_conversations_v1(review_kind, archived_at);

                CREATE TABLE IF NOT EXISTS analyst_review_runs_v2 (
                    run_id TEXT PRIMARY KEY,
                    schema_version INTEGER NOT NULL,
                    review_kind TEXT NOT NULL,
                    conversation_id TEXT,
                    session_id TEXT NOT NULL,
                    request_id TEXT NOT NULL,
                    attempt INTEGER NOT NULL,
                    previous_run_id TEXT,
                    state TEXT NOT NULL,
                    phase TEXT NOT NULL,
                    outcome TEXT,
                    deadline_at TEXT NOT NULL,
                    dependencies_json TEXT NOT NULL,
                    sections_json TEXT NOT NULL,
                    source_fingerprints_json TEXT NOT NULL,
                    citations_json TEXT NOT NULL,
                    report_markdown TEXT,
                    summary_markdown TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    completed_at TEXT,
                    baseline_accepted_at TEXT,
                    error_code TEXT,
                    error_message TEXT,
                    error_retryable INTEGER NOT NULL DEFAULT 0,
                    diagnostics_json TEXT NOT NULL,
                    UNIQUE(session_id, request_id)
                );
                CREATE INDEX IF NOT EXISTS analyst_review_v2_session_updated
                    ON analyst_review_runs_v2(session_id, updated_at DESC);
                CREATE INDEX IF NOT EXISTS analyst_review_v2_kind_updated
                    ON analyst_review_runs_v2(review_kind, updated_at DESC);
                CREATE INDEX IF NOT EXISTS analyst_review_v2_baseline
                    ON analyst_review_runs_v2(review_kind, baseline_accepted_at DESC);

                CREATE TABLE IF NOT EXISTS analyst_review_evidence_v2 (
                    fingerprint TEXT PRIMARY KEY,
                    source_name TEXT NOT NULL,
                    payload_json TEXT NOT NULL,
                    size_bytes INTEGER NOT NULL,
                    created_at TEXT NOT NULL
                );
                """
            )
            columns = {
                str(row["name"])
                for row in connection.execute(
                    "PRAGMA table_info(analyst_review_runs_v2)"
                ).fetchall()
            }
            if "conversation_id" not in columns:
                connection.execute(
                    "ALTER TABLE analyst_review_runs_v2 ADD COLUMN conversation_id TEXT"
                )
            # The previous UI stored every attempt for a review kind in one
            # synthetic ``review:<kind>`` shell.  Migrate each immutable run to
            # its own durable conversation, in place, so its evidence/report
            # and original timestamps remain untouched.  INSERT OR IGNORE and
            # the deterministic migrated id make this safe on every startup.
            legacy_rows = connection.execute(
                "SELECT run_id, review_kind, conversation_id, request_id, created_at, updated_at "
                "FROM analyst_review_runs_v2 ORDER BY created_at ASC"
            ).fetchall()
            requires_migration = any(
                not str(row["conversation_id"] or "")
                or str(row["conversation_id"] or "")
                == REVIEW_CONVERSATION_IDS.get(str(row["review_kind"] or ""))
                or str(row["conversation_id"] or "").startswith("review:migrated:")
                or _namespaced_uuid(str(row["conversation_id"] or "")) is not None
                for row in legacy_rows
            )
            backup_path = self.db_path.with_name(
                f"{self.db_path.stem}.pre-conversation-v1.bak{self.db_path.suffix}"
            )
            if requires_migration and not backup_path.exists():
                with sqlite3.connect(backup_path) as backup:
                    connection.backup(backup)
            replaced_conversation_ids: set[str] = set()
            for row in legacy_rows:
                review_kind = str(row["review_kind"] or "")
                old_conversation_id = str(row["conversation_id"] or "")
                fixed_id = REVIEW_CONVERSATION_IDS.get(review_kind)
                normalized_uuid = _namespaced_uuid(old_conversation_id)
                if (
                    not old_conversation_id
                    or old_conversation_id == fixed_id
                    or old_conversation_id.startswith("review:migrated:")
                ):
                    conversation_id = _legacy_run_conversation_id(str(row["run_id"]))
                    connection.execute(
                        "UPDATE analyst_review_runs_v2 SET conversation_id = ? WHERE run_id = ?",
                        (conversation_id, row["run_id"]),
                    )
                    initial_request_id = f"legacy:{row['run_id']}"
                    if old_conversation_id:
                        replaced_conversation_ids.add(old_conversation_id)
                elif normalized_uuid:
                    conversation_id = normalized_uuid
                    connection.execute(
                        "UPDATE analyst_review_runs_v2 SET conversation_id = ? WHERE conversation_id = ?",
                        (conversation_id, old_conversation_id),
                    )
                    initial_request_id = f"imported:{row['run_id']}"
                    replaced_conversation_ids.add(old_conversation_id)
                else:
                    conversation_id = old_conversation_id
                    initial_request_id = f"imported:{row['run_id']}"
                connection.execute(
                    """
                    INSERT OR IGNORE INTO analyst_review_conversations_v1 (
                        conversation_id, review_kind, title, initial_request_id,
                        created_at, updated_at, hermes_session_id, archived_at
                    ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)
                    """,
                    (
                        conversation_id,
                        review_kind,
                        REVIEW_TITLES.get(review_kind, "Review"),
                        initial_request_id,
                        row["created_at"],
                        row["updated_at"],
                    ),
                )
            for replaced_id in replaced_conversation_ids:
                connection.execute(
                    "DELETE FROM analyst_review_conversations_v1 "
                    "WHERE conversation_id = ? AND NOT EXISTS ("
                    "SELECT 1 FROM analyst_review_runs_v2 "
                    "WHERE conversation_id = analyst_review_conversations_v1.conversation_id)",
                    (replaced_id,),
                )
            connection.executescript(
                """
                CREATE INDEX IF NOT EXISTS analyst_review_v2_conversation_updated
                    ON analyst_review_runs_v2(conversation_id, updated_at DESC);
                CREATE INDEX IF NOT EXISTS analyst_review_v2_active
                    ON analyst_review_runs_v2(review_kind, state);
                CREATE UNIQUE INDEX IF NOT EXISTS analyst_review_v2_conversation_request
                    ON analyst_review_runs_v2(conversation_id, request_id);
                """
            )

    @staticmethod
    def _decode_conversation(row: sqlite3.Row | None) -> Optional[dict[str, Any]]:
        if row is None:
            return None
        value = dict(row)
        mapping = {
            "conversation_id": "conversationId",
            "review_kind": "reviewKind",
            "initial_request_id": "initialRequestId",
            "created_at": "createdAt",
            "updated_at": "updatedAt",
            "hermes_session_id": "hermesSessionId",
            "archived_at": "archivedAt",
        }
        for source, target in mapping.items():
            value[target] = value.pop(source)
        return value

    @staticmethod
    def _encode_cursor(created_at: str, conversation_id: str) -> str:
        payload = canonical_json(
            {"createdAt": str(created_at), "conversationId": str(conversation_id)}
        ).encode("utf-8")
        return base64.urlsafe_b64encode(payload).decode("ascii").rstrip("=")

    @staticmethod
    def _decode_cursor(cursor: str) -> tuple[str, str]:
        try:
            encoded = str(cursor or "")
            encoded += "=" * (-len(encoded) % 4)
            payload = json.loads(base64.urlsafe_b64decode(encoded).decode("utf-8"))
            created_at = str(payload.get("createdAt") or "")
            conversation_id = str(payload.get("conversationId") or "")
            if not created_at or not conversation_id:
                raise ValueError("missing cursor fields")
            return created_at, conversation_id
        except Exception as exc:
            raise ReviewRunError(
                "REVIEW_CURSOR_INVALID", "The conversation cursor is invalid."
            ) from exc

    @staticmethod
    def _decode(row: sqlite3.Row | None) -> Optional[dict[str, Any]]:
        if row is None:
            return None
        value = dict(row)
        mapping = {
            "run_id": "runId",
            "schema_version": "schemaVersion",
            "review_kind": "reviewKind",
            "conversation_id": "conversationId",
            "session_id": "sessionId",
            "request_id": "requestId",
            "previous_run_id": "previousRunId",
            "deadline_at": "deadlineAt",
            "report_markdown": "reportMarkdown",
            "summary_markdown": "summaryMarkdown",
            "created_at": "createdAt",
            "updated_at": "updatedAt",
            "completed_at": "completedAt",
            "baseline_accepted_at": "baselineAcceptedAt",
            "error_code": "errorCode",
            "error_message": "errorMessage",
            "error_retryable": "errorRetryable",
        }
        for source, target in mapping.items():
            value[target] = value.pop(source)
        value["dependencies"] = _parse_json(value.pop("dependencies_json"), {})
        value["sections"] = _parse_json(value.pop("sections_json"), [])
        value["sourceFingerprints"] = _parse_json(
            value.pop("source_fingerprints_json"), {}
        )
        value["citations"] = _parse_json(value.pop("citations_json"), [])
        value["diagnostics"] = _parse_json(value.pop("diagnostics_json"), {})
        value["errorRetryable"] = bool(value["errorRetryable"])
        return value

    def _insert_run_locked(
        self,
        connection: sqlite3.Connection,
        *,
        review_kind: str,
        conversation_id: str,
        session_id: str,
        request_id: str,
        deadline_seconds: Optional[int],
    ) -> dict[str, Any]:
        now = datetime.now(timezone.utc)
        created_at = now.isoformat().replace("+00:00", "Z")
        deadline = now + timedelta(
            seconds=int(deadline_seconds or DEADLINE_SECONDS[review_kind])
        )
        deadline_at = deadline.isoformat().replace("+00:00", "Z")
        latest = connection.execute(
            "SELECT run_id, attempt FROM analyst_review_runs_v2 "
            "WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 1",
            (conversation_id,),
        ).fetchone()
        attempt = int(latest["attempt"] if latest else 0) + 1
        previous_run_id = latest["run_id"] if latest else None
        run_id = str(uuid4())
        connection.execute(
            """
            INSERT INTO analyst_review_runs_v2 (
                run_id, schema_version, review_kind, conversation_id, session_id, request_id,
                attempt, previous_run_id, state, phase, outcome, deadline_at,
                dependencies_json, sections_json, source_fingerprints_json,
                citations_json, report_markdown, summary_markdown, created_at,
                updated_at, completed_at, baseline_accepted_at, error_code,
                error_message, error_retryable, diagnostics_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', 'acquiring', NULL, ?, '{}',
                '[]', '{}', '[]', NULL, NULL, ?, ?, NULL, NULL, NULL, NULL, 0, '{}')
            """,
            (
                run_id,
                SCHEMA_VERSION,
                review_kind,
                conversation_id,
                session_id,
                request_id,
                attempt,
                previous_run_id,
                deadline_at,
                created_at,
                created_at,
            ),
        )
        row = connection.execute(
            "SELECT * FROM analyst_review_runs_v2 WHERE run_id = ?", (run_id,)
        ).fetchone()
        return self._decode(row)

    def create_conversation(
        self,
        *,
        review_kind: str,
        request_id: str,
        deadline_seconds: Optional[int] = None,
    ) -> tuple[dict[str, Any], dict[str, Any], bool, bool]:
        """Create one review conversation, or return the active same-kind one.

        The request id owns idempotency.  A different request while the same
        review kind is active reuses that active conversation so multiple
        windows cannot accidentally duplicate live-data acquisition.
        """

        if review_kind not in REVIEW_KINDS:
            raise ReviewRunError("REVIEW_KIND_INVALID", "Unknown review kind.")
        clean_request = _bounded_text(request_id, 200)
        if not clean_request:
            raise ReviewRunError(
                "REVIEW_REQUEST_INVALID", "requestId is required."
            )
        with self._lock, self.connect() as connection:
            existing_conversation = connection.execute(
                "SELECT * FROM analyst_review_conversations_v1 "
                "WHERE initial_request_id = ? LIMIT 1",
                (clean_request,),
            ).fetchone()
            if existing_conversation:
                conversation_id = str(existing_conversation["conversation_id"])
                existing_run = connection.execute(
                    "SELECT * FROM analyst_review_runs_v2 WHERE conversation_id = ? "
                    "ORDER BY created_at DESC LIMIT 1",
                    (conversation_id,),
                ).fetchone()
                return (
                    self._decode_conversation(existing_conversation),
                    self._decode(existing_run),
                    False,
                    False,
                )

            active_run = connection.execute(
                "SELECT * FROM analyst_review_runs_v2 "
                "WHERE review_kind = ? AND state IN ('queued','running') "
                "ORDER BY created_at DESC LIMIT 1",
                (review_kind,),
            ).fetchone()
            if active_run:
                active_conversation = connection.execute(
                    "SELECT * FROM analyst_review_conversations_v1 "
                    "WHERE conversation_id = ?",
                    (active_run["conversation_id"],),
                ).fetchone()
                return (
                    self._decode_conversation(active_conversation),
                    self._decode(active_run),
                    False,
                    True,
                )

            now = utc_now_iso()
            conversation_id = str(uuid4())
            connection.execute(
                """
                INSERT INTO analyst_review_conversations_v1 (
                    conversation_id, review_kind, title, initial_request_id,
                    created_at, updated_at, hermes_session_id, archived_at
                ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)
                """,
                (
                    conversation_id,
                    review_kind,
                    REVIEW_TITLES[review_kind],
                    clean_request,
                    now,
                    now,
                ),
            )
            run = self._insert_run_locked(
                connection,
                review_kind=review_kind,
                conversation_id=conversation_id,
                session_id=conversation_id,
                request_id=clean_request,
                deadline_seconds=deadline_seconds,
            )
            conversation = connection.execute(
                "SELECT * FROM analyst_review_conversations_v1 WHERE conversation_id = ?",
                (conversation_id,),
            ).fetchone()
            return self._decode_conversation(conversation), run, True, False

    def create(
        self,
        *,
        review_kind: str,
        session_id: str = "",
        conversation_id: Optional[str] = None,
        request_id: str,
        deadline_seconds: Optional[int] = None,
    ) -> tuple[dict[str, Any], bool]:
        if review_kind not in REVIEW_KINDS:
            raise ReviewRunError("REVIEW_KIND_INVALID", "Unknown review kind.")
        clean_conversation = _bounded_text(
            conversation_id or review_conversation_id(review_kind), 200
        )
        clean_session = _bounded_text(session_id, 200) or clean_conversation
        clean_request = _bounded_text(request_id, 200)
        if not clean_conversation or not clean_request:
            raise ReviewRunError(
                "REVIEW_REQUEST_INVALID", "conversationId and requestId are required."
            )
        with self._lock, self.connect() as connection:
            existing = connection.execute(
                "SELECT * FROM analyst_review_runs_v2 WHERE conversation_id = ? AND request_id = ?",
                (clean_conversation, clean_request),
            ).fetchone()
            if existing:
                return self._decode(existing), False
            active = connection.execute(
                "SELECT * FROM analyst_review_runs_v2 WHERE review_kind = ? "
                "AND state IN ('queued','running') ORDER BY created_at DESC LIMIT 1",
                (review_kind,),
            ).fetchone()
            if active:
                raise ReviewRunError(
                    "REVIEW_ALREADY_RUNNING",
                    "A review of this type is already running.",
                    status_code=409,
                    retryable=False,
                )
            conversation = connection.execute(
                "SELECT conversation_id FROM analyst_review_conversations_v1 "
                "WHERE conversation_id = ?",
                (clean_conversation,),
            ).fetchone()
            if not conversation:
                now = utc_now_iso()
                connection.execute(
                    """
                    INSERT INTO analyst_review_conversations_v1 (
                        conversation_id, review_kind, title, initial_request_id,
                        created_at, updated_at, hermes_session_id, archived_at
                    ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)
                    """,
                    (
                        clean_conversation,
                        review_kind,
                        REVIEW_TITLES[review_kind],
                        f"compat:{uuid4()}",
                        now,
                        now,
                    ),
                )
            created = self._insert_run_locked(
                connection,
                review_kind=review_kind,
                conversation_id=clean_conversation,
                session_id=clean_session,
                request_id=clean_request,
                deadline_seconds=deadline_seconds,
            )
            return created, True

    def get(self, run_id: str) -> Optional[dict[str, Any]]:
        with self.connect() as connection:
            return self._decode(
                connection.execute(
                    "SELECT * FROM analyst_review_runs_v2 WHERE run_id = ?",
                    (str(run_id),),
                ).fetchone()
            )

    def latest_for_session(self, session_id: str) -> Optional[dict[str, Any]]:
        with self.connect() as connection:
            return self._decode(
                connection.execute(
                    "SELECT * FROM analyst_review_runs_v2 WHERE session_id = ? ORDER BY created_at DESC LIMIT 1",
                    (str(session_id),),
                ).fetchone()
            )

    def latest_for_conversation(
        self, conversation_id: str
    ) -> Optional[dict[str, Any]]:
        with self.connect() as connection:
            return self._decode(
                connection.execute(
                    "SELECT * FROM analyst_review_runs_v2 WHERE conversation_id = ? "
                    "ORDER BY created_at DESC LIMIT 1",
                    (str(conversation_id),),
                ).fetchone()
            )

    def list_for_conversation(
        self, conversation_id: str, limit: int = 100
    ) -> list[dict[str, Any]]:
        with self.connect() as connection:
            rows = connection.execute(
                "SELECT * FROM analyst_review_runs_v2 WHERE conversation_id = ? "
                "ORDER BY created_at DESC LIMIT ?",
                (str(conversation_id), max(1, min(500, int(limit)))),
            ).fetchall()
        return [self._decode(row) for row in rows]

    def list_recent(self, limit: int = 100) -> list[dict[str, Any]]:
        with self.connect() as connection:
            rows = connection.execute(
                "SELECT * FROM analyst_review_runs_v2 ORDER BY updated_at DESC LIMIT ?",
                (max(1, min(500, int(limit))),),
            ).fetchall()
        return [self._decode(row) for row in rows]

    def get_conversation(
        self, conversation_id: str
    ) -> Optional[dict[str, Any]]:
        with self.connect() as connection:
            row = connection.execute(
                "SELECT * FROM analyst_review_conversations_v1 "
                "WHERE conversation_id = ? AND archived_at IS NULL",
                (str(conversation_id),),
            ).fetchone()
            if not row:
                return None
            runs = connection.execute(
                "SELECT * FROM analyst_review_runs_v2 WHERE conversation_id = ? "
                "ORDER BY created_at ASC",
                (str(conversation_id),),
            ).fetchall()
        conversation = self._decode_conversation(row)
        conversation["runs"] = [self._decode(run) for run in runs]
        return conversation

    def list_conversations(
        self,
        *,
        limit: int = 50,
        cursor: str = "",
        query: str = "",
    ) -> tuple[list[dict[str, Any]], Optional[str]]:
        bounded_limit = max(1, min(100, int(limit)))
        where = ["c.archived_at IS NULL"]
        params: list[Any] = []
        if cursor:
            created_at, conversation_id = self._decode_cursor(cursor)
            where.append(
                "(c.created_at < ? OR (c.created_at = ? AND c.conversation_id < ?))"
            )
            params.extend((created_at, created_at, conversation_id))
        clean_query = _bounded_text(query, 100).lower()
        if clean_query:
            where.append("LOWER(c.title) LIKE ?")
            params.append(f"%{clean_query}%")
        params.append(bounded_limit + 1)
        sql = f"""
            SELECT c.*,
                r.run_id AS latest_run_id,
                r.state AS latest_state,
                r.phase AS latest_phase,
                r.outcome AS latest_outcome,
                r.error_retryable AS latest_retryable,
                r.error_code AS latest_error_code,
                r.error_message AS latest_error_message,
                r.created_at AS latest_run_created_at,
                r.updated_at AS latest_run_updated_at
            FROM analyst_review_conversations_v1 c
            LEFT JOIN analyst_review_runs_v2 r ON r.run_id = (
                SELECT latest.run_id FROM analyst_review_runs_v2 latest
                WHERE latest.conversation_id = c.conversation_id
                ORDER BY latest.created_at DESC LIMIT 1
            )
            WHERE {' AND '.join(where)}
            ORDER BY c.created_at DESC, c.conversation_id DESC
            LIMIT ?
        """
        with self.connect() as connection:
            rows = connection.execute(sql, params).fetchall()
        has_more = len(rows) > bounded_limit
        rows = rows[:bounded_limit]
        conversations: list[dict[str, Any]] = []
        for row in rows:
            value = dict(row)
            conversation = {
                "conversationId": value["conversation_id"],
                "reviewKind": value["review_kind"],
                "title": value["title"],
                "initialRequestId": value["initial_request_id"],
                "createdAt": value["created_at"],
                "updatedAt": value["updated_at"],
                "hermesSessionId": value["hermes_session_id"],
                "archivedAt": value["archived_at"],
            }
            conversation["latestRun"] = {
                "runId": value.get("latest_run_id"),
                "state": value.get("latest_state"),
                "phase": value.get("latest_phase"),
                "outcome": value.get("latest_outcome"),
                "retryable": bool(value.get("latest_retryable")),
                "error": (
                    {
                        "code": value.get("latest_error_code"),
                        "message": value.get("latest_error_message")
                        or "The review could not finish.",
                        "retryable": bool(value.get("latest_retryable")),
                    }
                    if value.get("latest_error_code")
                    else None
                ),
                "createdAt": value.get("latest_run_created_at"),
                "updatedAt": value.get("latest_run_updated_at"),
            }
            conversations.append(conversation)
        next_cursor = None
        if has_more and rows:
            last = rows[-1]
            next_cursor = self._encode_cursor(
                str(last["created_at"]), str(last["conversation_id"])
            )
        return conversations, next_cursor

    def archive_conversation(self, conversation_id: str) -> dict[str, Any]:
        clean_id = _bounded_text(conversation_id, 200)
        with self._lock, self.connect() as connection:
            row = connection.execute(
                "SELECT * FROM analyst_review_conversations_v1 "
                "WHERE conversation_id = ? AND archived_at IS NULL",
                (clean_id,),
            ).fetchone()
            if not row:
                raise ReviewRunError(
                    "REVIEW_CONVERSATION_NOT_FOUND",
                    "Review conversation was not found.",
                    status_code=404,
                )
            active = connection.execute(
                "SELECT 1 FROM analyst_review_runs_v2 WHERE conversation_id = ? "
                "AND state IN ('queued','running') LIMIT 1",
                (clean_id,),
            ).fetchone()
            if active:
                raise ReviewRunError(
                    "REVIEW_CONVERSATION_RUNNING",
                    "A running review cannot be archived.",
                    status_code=409,
                )
            now = utc_now_iso()
            connection.execute(
                "UPDATE analyst_review_conversations_v1 "
                "SET archived_at = ?, updated_at = ? WHERE conversation_id = ?",
                (now, now, clean_id),
            )
            archived = connection.execute(
                "SELECT * FROM analyst_review_conversations_v1 WHERE conversation_id = ?",
                (clean_id,),
            ).fetchone()
        return self._decode_conversation(archived)

    def link_hermes_session(
        self,
        conversation_id: str,
        hermes_session_id: str,
        previous_session_id: str = "",
    ) -> dict[str, Any]:
        clean_id = _bounded_text(conversation_id, 200)
        clean_session = _bounded_text(hermes_session_id, 200)
        if not clean_session:
            raise ReviewRunError(
                "REVIEW_HERMES_SESSION_INVALID", "hermesSessionId is required."
            )
        with self._lock, self.connect() as connection:
            row = connection.execute(
                "SELECT * FROM analyst_review_conversations_v1 "
                "WHERE conversation_id = ? AND archived_at IS NULL",
                (clean_id,),
            ).fetchone()
            if not row:
                raise ReviewRunError(
                    "REVIEW_CONVERSATION_NOT_FOUND",
                    "Review conversation was not found.",
                    status_code=404,
                )
            linked = str(row["hermes_session_id"] or "")
            if linked and linked != clean_session:
                if not previous_session_id or linked != str(previous_session_id):
                    raise ReviewRunError(
                        "REVIEW_HERMES_SESSION_CONFLICT",
                        "This conversation is already linked to another Hermes session.",
                        status_code=409,
                    )
            if not linked or linked != clean_session:
                connection.execute(
                    "UPDATE analyst_review_conversations_v1 "
                    "SET hermes_session_id = ?, updated_at = ? WHERE conversation_id = ?",
                    (clean_session, utc_now_iso(), clean_id),
                )
            updated = connection.execute(
                "SELECT * FROM analyst_review_conversations_v1 WHERE conversation_id = ?",
                (clean_id,),
            ).fetchone()
        return self._decode_conversation(updated)

    def interrupt_active_attempts(self) -> int:
        """Close attempts orphaned by a sidecar restart without losing checkpoints."""
        with self.connect() as connection:
            rows = connection.execute(
                "SELECT run_id, diagnostics_json FROM analyst_review_runs_v2 "
                "WHERE state IN ('queued','running')"
            ).fetchall()
        for row in rows:
            diagnostics = _parse_json(row["diagnostics_json"], {})
            diagnostics["interruptedByRestart"] = True
            self.update(
                row["run_id"],
                state="failed",
                phase="terminal",
                outcome="blocked",
                completedAt=utc_now_iso(),
                errorCode="REVIEW_PROCESS_RESTARTED",
                errorMessage="The review was interrupted when the review service restarted.",
                errorRetryable=True,
                diagnostics=diagnostics,
            )
        return len(rows)

    def latest_portfolio_baseline(
        self, *, before_run_id: Optional[str] = None
    ) -> Optional[dict[str, Any]]:
        query = (
            "SELECT * FROM analyst_review_runs_v2 "
            "WHERE review_kind = 'portfolio-review' AND baseline_accepted_at IS NOT NULL"
        )
        params: list[Any] = []
        if before_run_id:
            query += " AND run_id != ?"
            params.append(before_run_id)
        query += " ORDER BY baseline_accepted_at DESC LIMIT 1"
        with self.connect() as connection:
            return self._decode(connection.execute(query, params).fetchone())

    def update(self, run_id: str, **changes: Any) -> dict[str, Any]:
        allowed = {
            "state": "state",
            "phase": "phase",
            "outcome": "outcome",
            "dependencies": "dependencies_json",
            "sections": "sections_json",
            "sourceFingerprints": "source_fingerprints_json",
            "citations": "citations_json",
            "reportMarkdown": "report_markdown",
            "summaryMarkdown": "summary_markdown",
            "completedAt": "completed_at",
            "baselineAcceptedAt": "baseline_accepted_at",
            "errorCode": "error_code",
            "errorMessage": "error_message",
            "errorRetryable": "error_retryable",
            "diagnostics": "diagnostics_json",
        }
        current = self.get(run_id)
        if not current:
            raise KeyError(run_id)
        if current["state"] in TERMINAL_STATES and any(
            key not in {"baselineAcceptedAt"} for key in changes
        ):
            raise ReviewRunError(
                "REVIEW_IMMUTABLE",
                "Completed review attempts are immutable.",
                status_code=409,
            )
        assignments = []
        values: list[Any] = []
        for key, raw in changes.items():
            column = allowed.get(key)
            if not column:
                continue
            if key == "state" and raw not in RUN_STATES:
                raise ValueError(f"Invalid review state: {raw}")
            if key == "phase" and raw not in RUN_PHASES:
                raise ValueError(f"Invalid review phase: {raw}")
            if key == "outcome" and raw is not None and raw not in RUN_OUTCOMES:
                raise ValueError(f"Invalid review outcome: {raw}")
            if key in {
                "dependencies",
                "sections",
                "sourceFingerprints",
                "citations",
                "diagnostics",
            }:
                raw = canonical_json(raw)
            if key == "errorRetryable":
                raw = 1 if raw else 0
            assignments.append(f"{column} = ?")
            values.append(raw)
        if not assignments:
            return current
        updated_at = utc_now_iso()
        assignments.append("updated_at = ?")
        values.append(updated_at)
        values.append(run_id)
        with self._lock, self.connect() as connection:
            connection.execute(
                f"UPDATE analyst_review_runs_v2 SET {', '.join(assignments)} WHERE run_id = ?",
                values,
            )
            connection.execute(
                "UPDATE analyst_review_conversations_v1 SET updated_at = ? "
                "WHERE conversation_id = ?",
                (updated_at, current.get("conversationId")),
            )
        return self.get(run_id)

    def merge_dependency(
        self, run_id: str, source_name: str, descriptor: dict[str, Any]
    ) -> dict[str, Any]:
        # Acquisition stages settle concurrently.  Keep the read/merge/write in
        # one critical section and one SQLite transaction so two checkpoints
        # cannot both read the same old JSON object and erase one another.
        with self._lock, self.connect() as connection:
            row = connection.execute(
                "SELECT state, dependencies_json FROM analyst_review_runs_v2 WHERE run_id = ?",
                (run_id,),
            ).fetchone()
            if not row:
                raise KeyError(run_id)
            if row["state"] in TERMINAL_STATES:
                raise ReviewRunError(
                    "REVIEW_IMMUTABLE",
                    "Completed review attempts are immutable.",
                    status_code=409,
                )
            dependencies = _parse_json(row["dependencies_json"], {})
            dependencies[str(source_name)] = json_copy(descriptor)
            connection.execute(
                """
                UPDATE analyst_review_runs_v2
                SET dependencies_json = ?, updated_at = ?
                WHERE run_id = ?
                """,
                (canonical_json(dependencies), utc_now_iso(), run_id),
            )
        return self.get(run_id)

    def store_evidence(self, source_name: str, payload: Any) -> tuple[str, int]:
        serialized = canonical_json(payload)
        fingerprint = canonical_fingerprint(payload)
        size_bytes = len(serialized.encode("utf-8"))
        with self._lock, self.connect() as connection:
            connection.execute(
                """
                INSERT OR IGNORE INTO analyst_review_evidence_v2
                    (fingerprint, source_name, payload_json, size_bytes, created_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (fingerprint, str(source_name), serialized, size_bytes, utc_now_iso()),
            )
        return fingerprint, size_bytes


@dataclass
class ReviewExecutionContext:
    store: ReviewRunV2Store
    run_id: str
    review_kind: str

    async def checkpoint(
        self,
        source_name: str,
        *,
        status: str,
        evidence: Any = None,
        as_of: Optional[str] = None,
        error_code: Optional[str] = None,
        detail: Optional[dict[str, Any]] = None,
    ) -> dict[str, Any]:
        """Persist acquisition state before content-addressing its evidence."""

        descriptor = {
            "status": status,
            "asOf": as_of,
            "fingerprint": None,
            "sizeBytes": 0,
            "errorCode": error_code,
            "detail": json_copy(detail or {}),
            "updatedAt": utc_now_iso(),
        }
        await asyncio.to_thread(
            self.store.merge_dependency, self.run_id, source_name, descriptor
        )
        if evidence is not None:
            fingerprint, size_bytes = await asyncio.to_thread(
                self.store.store_evidence,
                source_name,
                evidence,
            )
            descriptor["fingerprint"] = fingerprint
            descriptor["sizeBytes"] = size_bytes
            await asyncio.to_thread(
                self.store.merge_dependency, self.run_id, source_name, descriptor
            )
        return descriptor

    async def baseline(self) -> Optional[dict[str, Any]]:
        return await asyncio.to_thread(
            self.store.latest_portfolio_baseline,
            before_run_id=self.run_id,
        )


ReviewHandler = Callable[[ReviewExecutionContext], Awaitable[dict[str, Any]]]
SummaryProvider = Callable[..., Union[Awaitable[str], str]]


class ReviewCoordinatorV2:
    def __init__(
        self,
        store: ReviewRunV2Store,
        handlers: dict[str, ReviewHandler],
        *,
        summary_provider: Optional[SummaryProvider] = None,
        deadlines: Optional[dict[str, int]] = None,
        unexpected_failure_hook: Optional[Callable[[str, BaseException], Any]] = None,
    ) -> None:
        self.store = store
        self.handlers = dict(handlers)
        self.summary_provider = summary_provider
        self.deadlines = {**DEADLINE_SECONDS, **(deadlines or {})}
        self.unexpected_failure_hook = unexpected_failure_hook
        self.tasks: dict[str, asyncio.Task] = {}
        self._task_lock = asyncio.Lock()

    async def start(
        self,
        *,
        review_kind: str,
        session_id: str = "",
        conversation_id: Optional[str] = None,
        request_id: str,
    ) -> dict[str, Any]:
        if review_kind not in self.handlers:
            raise ReviewRunError(
                "REVIEW_KIND_DISABLED", "That review is not enabled.", status_code=503
            )
        run, created = await asyncio.to_thread(
            self.store.create,
            review_kind=review_kind,
            session_id=session_id,
            conversation_id=conversation_id,
            request_id=request_id,
            deadline_seconds=self.deadlines[review_kind],
        )
        if created:
            async with self._task_lock:
                task = asyncio.create_task(self._execute(run["runId"]))
                self.tasks[run["runId"]] = task
                task.add_done_callback(
                    lambda _task, identifier=run["runId"]: self.tasks.pop(
                        identifier, None
                    )
                )
        return public_review_run(run)

    async def start_conversation(
        self, *, review_kind: str, request_id: str
    ) -> dict[str, Any]:
        if review_kind not in self.handlers:
            raise ReviewRunError(
                "REVIEW_KIND_DISABLED", "That review is not enabled.", status_code=503
            )
        conversation, run, created, reused_active = await asyncio.to_thread(
            self.store.create_conversation,
            review_kind=review_kind,
            request_id=request_id,
            deadline_seconds=self.deadlines[review_kind],
        )
        if created:
            async with self._task_lock:
                task = asyncio.create_task(self._execute(run["runId"]))
                self.tasks[run["runId"]] = task
                task.add_done_callback(
                    lambda _task, identifier=run["runId"]: self.tasks.pop(
                        identifier, None
                    )
                )
        conversation = {**conversation, "latestRun": run}
        return {
            "created": created,
            "reusedActive": reused_active,
            "conversation": public_review_conversation_summary(conversation),
            "run": public_review_run_status(run),
        }

    async def retry(
        self, run_id: str, *, request_id: Optional[str] = None
    ) -> dict[str, Any]:
        prior = await asyncio.to_thread(self.store.get, run_id)
        if not prior:
            raise ReviewRunError(
                "REVIEW_NOT_FOUND", "Review run was not found.", status_code=404
            )
        if prior["state"] not in TERMINAL_STATES:
            raise ReviewRunError(
                "REVIEW_ALREADY_RUNNING",
                "The review is still running.",
                status_code=409,
            )
        next_request = _bounded_text(request_id, 200) or f"retry:{run_id}:{uuid4()}"
        return await self.start(
            review_kind=prior["reviewKind"],
            session_id=prior["sessionId"],
            conversation_id=prior.get("conversationId"),
            request_id=next_request,
        )

    async def _execute(self, run_id: str) -> None:
        run = await asyncio.to_thread(self.store.get, run_id)
        if not run or run["state"] in TERMINAL_STATES:
            return
        deadline_seconds = float(self.deadlines[run["reviewKind"]])
        started_at = asyncio.get_running_loop().time()
        try:
            await asyncio.wait_for(
                self._execute_pipeline(run_id, run, started_at, deadline_seconds),
                timeout=deadline_seconds,
            )
        except asyncio.CancelledError:
            failure = {
                "code": "REVIEW_CANCELLED",
                "message": "The review was cancelled.",
                "retryable": True,
            }
            await self._fail(
                run_id,
                failure,
                diagnostics={"type": "CancelledError"},
                state="cancelled",
            )
            raise
        except Exception as exc:
            if isinstance(exc, (ReviewRunError, asyncio.TimeoutError)):
                LOGGER.warning(
                    "ReviewRunV2 coordinator stopped for %s: %s", run_id, exc
                )
            else:
                LOGGER.exception("ReviewRunV2 coordinator failed for %s", run_id)
            if (
                not isinstance(exc, (ReviewRunError, asyncio.TimeoutError))
                and self.unexpected_failure_hook
            ):
                try:
                    self.unexpected_failure_hook(run_id, exc)
                except Exception:
                    LOGGER.exception("ReviewRunV2 unexpected-failure hook failed")
            await self._fail(
                run_id,
                normalized_failure(exc),
                diagnostics={
                    "type": type(exc).__name__,
                    "raw": _bounded_text(exc, 4_000),
                },
            )

    async def _execute_pipeline(
        self,
        run_id: str,
        run: dict[str, Any],
        started_at: float,
        deadline_seconds: float,
    ) -> None:
        await asyncio.to_thread(
            self.store.update, run_id, state="running", phase="acquiring"
        )
        context = ReviewExecutionContext(self.store, run_id, run["reviewKind"])
        result = await self.handlers[run["reviewKind"]](context)
        sections = json_copy(result.get("sections") or [])
        outcome = str(result.get("outcome") or "blocked")
        if outcome not in RUN_OUTCOMES:
            raise ReviewRunError(
                "REVIEW_RESULT_INVALID", "Review provider returned an invalid outcome."
            )
        citations = _dedupe_citations(result.get("citations") or [])
        await asyncio.to_thread(
            self.store.update,
            run_id,
            phase="rendering",
            sections=sections,
            citations=citations,
        )

        # Fingerprint normalized, already-persisted dependencies.  A fault
        # here cannot erase their stage checkpoints.
        persisted = await asyncio.to_thread(self.store.get, run_id)
        fingerprints = {
            name: descriptor.get("fingerprint")
            for name, descriptor in (persisted.get("dependencies") or {}).items()
            if descriptor.get("fingerprint")
        }
        report = render_review(run["reviewKind"], sections, outcome, citations)
        await asyncio.to_thread(
            self.store.update,
            run_id,
            sourceFingerprints=fingerprints,
            reportMarkdown=report,
        )

        summary = None
        summary_diagnostic = None
        if self.summary_provider:
            await asyncio.to_thread(self.store.update, run_id, phase="summarizing")
            try:
                summary_input = bounded_summary_input(
                    run["reviewKind"], outcome, sections, citations
                )
                elapsed = asyncio.get_running_loop().time() - started_at
                remaining = max(0.0, deadline_seconds - elapsed - 0.25)
                if remaining <= 0:
                    raise asyncio.TimeoutError(
                        "No total-deadline budget remains for summary"
                    )
                candidate = await asyncio.wait_for(
                    self._invoke_summary_provider(summary_input),
                    timeout=min(SUMMARY_TIMEOUT_SECONDS, remaining),
                )
                summary = _bounded_text(candidate, 8_000) or None
            except Exception as exc:  # summary is intentionally non-fatal
                LOGGER.warning(
                    "Optional review summary omitted for %s: %s", run_id, exc
                )
                summary_diagnostic = {"summaryError": type(exc).__name__}

        completed_at = utc_now_iso()
        updates: dict[str, Any] = {
            "state": "succeeded",
            "phase": "terminal",
            "outcome": outcome,
            "summaryMarkdown": summary,
            "completedAt": completed_at,
            "diagnostics": summary_diagnostic or {},
        }
        if run["reviewKind"] == "portfolio-review" and outcome == "ready":
            updates["baselineAcceptedAt"] = completed_at
        await asyncio.to_thread(self.store.update, run_id, **updates)

    async def _invoke_summary_provider(self, summary_input: str) -> Any:
        options = {
            "max_output_tokens": MAX_SUMMARY_OUTPUT_TOKENS,
            "allow_tools": False,
        }
        if inspect.iscoroutinefunction(self.summary_provider):
            return await self.summary_provider(summary_input, **options)
        candidate = await asyncio.to_thread(
            self.summary_provider, summary_input, **options
        )
        if inspect.isawaitable(candidate):
            return await candidate
        return candidate

    async def _fail(
        self,
        run_id: str,
        failure: dict[str, Any],
        *,
        diagnostics: dict[str, Any],
        state: str = "failed",
    ) -> None:
        current = await asyncio.to_thread(self.store.get, run_id)
        if not current or current["state"] in TERMINAL_STATES:
            return
        await asyncio.to_thread(
            self.store.update,
            run_id,
            state=state,
            phase="terminal",
            outcome="blocked",
            completedAt=utc_now_iso(),
            errorCode=failure["code"],
            errorMessage=failure["message"],
            errorRetryable=failure.get("retryable") is True,
            diagnostics=diagnostics,
        )


def _dedupe_citations(rows: list[Any]) -> list[dict[str, Any]]:
    selected: dict[str, dict[str, Any]] = {}
    for raw in rows:
        if not isinstance(raw, dict):
            continue
        identifier = _bounded_text(raw.get("id"), 200)
        if not identifier:
            continue
        selected[identifier] = {
            key: raw.get(key)
            for key in (
                "id",
                "documentId",
                "product",
                "publicationDate",
                "sourceUri",
                "title",
            )
            if raw.get(key) is not None
        }
    return [selected[key] for key in sorted(selected)]


def bounded_summary_input(
    review_kind: str,
    outcome: str,
    sections: list[dict[str, Any]],
    citations: list[dict[str, Any]],
) -> str:
    payload = canonical_json(
        {
            "schemaVersion": SCHEMA_VERSION,
            "reviewKind": review_kind,
            "outcome": outcome,
            "sections": sections,
            "citations": citations,
            "rules": {
                "mayAlterNumbers": False,
                "mayAlterStatuses": False,
                "mayAddFindings": False,
                "toolCallsAllowed": False,
            },
        }
    )
    encoded = payload.encode("utf-8")
    if len(encoded) <= MAX_SUMMARY_INPUT_BYTES:
        return payload
    # Truncate only optional prose-like detail.  The deterministic report is
    # authoritative; a summary is safely omitted if the bounded projection
    # still cannot fit.
    projection = {
        "schemaVersion": SCHEMA_VERSION,
        "reviewKind": review_kind,
        "outcome": outcome,
        "sections": [
            {
                "id": row.get("id"),
                "title": row.get("title"),
                "status": row.get("status"),
                "reasonCode": row.get("reasonCode"),
                "facts": (row.get("facts") or [])[:20],
                "exceptions": (row.get("exceptions") or [])[:20],
            }
            for row in sections
        ],
        "citationIds": [row.get("id") for row in citations],
    }
    bounded = canonical_json(projection)
    if len(bounded.encode("utf-8")) > MAX_SUMMARY_INPUT_BYTES:
        raise ReviewRunError(
            "REVIEW_SUMMARY_INPUT_TOO_LARGE",
            "Optional review summary input exceeded its hard limit.",
        )
    return bounded


def _status_line(outcome: str) -> str:
    labels = {"ready": "Ready", "partial": "Partial", "blocked": "Blocked"}
    return f"**Outcome:** {labels.get(outcome, 'Blocked')}"


def _find_section(sections: list[dict[str, Any]], section_id: str) -> dict[str, Any]:
    return next((row for row in sections if row.get("id") == section_id), {})


def render_portfolio_review(sections: list[dict[str, Any]], outcome: str) -> str:
    snapshot = _find_section(sections, "executive-snapshot")
    risk = _find_section(sections, "exposure-risk")
    conflicts = _find_section(sections, "conflicts-changes")
    context = _find_section(sections, "market-macro-context")
    changed = _find_section(sections, "changes-since-prior")
    quality = _find_section(sections, "coverage-data-quality")
    metrics = snapshot.get("metrics") or risk.get("metrics") or {}
    lines = [
        "# Portfolio Review",
        "",
        _status_line(outcome),
        "",
        "## Executive Portfolio Snapshot",
        "",
    ]
    lines.extend(
        [
            f"- As of: **{_cell(metrics.get('observedAt'))}**",
            f"- Net liquidation value: **{_fmt_money(metrics.get('netLiquidation'))}**",
            f"- Daily / unrealized P&L: **{_cell(snapshot.get('pnlSummary'))}**",
            f"- Position marks: **{metrics.get('valuedCount', 0)} of {metrics.get('positionCount', 0)} verified**",
        ]
    )
    lines.extend(["", "## Exposure & Risk", ""])
    lines.extend(
        [
            f"- Gross exposure: **{_fmt_money(metrics.get('grossExposure'))}** ({_fmt_percent(metrics.get('grossLeverage'), already_percent=False)} of NLV)",
            f"- Net exposure: **{_fmt_money(metrics.get('netExposure'))}** ({_fmt_percent(metrics.get('netExposurePctOfNlv'))} of NLV)",
            f"- Long / short market value: **{_fmt_money(metrics.get('longMarketValue'))}** / **{_fmt_money(metrics.get('shortMarketValue'))}**",
        ]
    )
    concentrations = (
        risk.get("concentrations") or metrics.get("topConcentrations") or []
    )
    if concentrations:
        lines.extend(
            [
                "",
                "| Holding | Market value | Gross weight | Mark |",
                "|---|---:|---:|:---:|",
            ]
        )
        for row in concentrations[:10]:
            lines.append(
                f"| {_cell(row.get('symbol'))} | {_fmt_money(row.get('marketValue'))} | "
                f"{_fmt_percent(row.get('grossWeightPct'))} | {_cell(row.get('markState'))} |"
            )
    exceptions = list(risk.get("exceptions") or [])
    lines.extend(["", "## Conflicts & Lifecycle Changes", ""])
    conflict_rows = conflicts.get("conflicts") or []
    action_rows = conflicts.get("unheldActionChanges") or []
    if not conflict_rows and not action_rows and conflicts.get("status") == "ready":
        lines.append(
            "No material held-position conflict or qualifying action-feed change was found in the complete typed reconciliation."
        )
    else:
        for row in conflict_rows:
            citation_ids = ", ".join(
                c.get("id") for c in row.get("citations") or [] if c.get("id")
            )
            suffix = f" ({citation_ids})" if citation_ids else ""
            lines.append(
                f"- **{_cell(row.get('holding'))}** — {_cell(row.get('state'))}: "
                f"{_cell(row.get('conflict'))}; {_cell(row.get('processResponse'))}{suffix}"
            )
        for row in action_rows:
            citation_ids = ", ".join(
                c.get("id") for c in row.get("citations") or [] if c.get("id")
            )
            suffix = f" ({citation_ids})" if citation_ids else ""
            lines.append(
                f"- **{_cell(row.get('symbol'))}** — {_cell(row.get('change'))}{suffix}"
            )
    lines.extend(["", "## Portfolio-Relevant Market & Macro Context", ""])
    facts = context.get("facts") or []
    if facts:
        lines.extend(
            f"- {_cell(row.get('text') if isinstance(row, dict) else row)}"
            for row in facts
        )
    else:
        lines.append(
            "No complete, cited portfolio-relevant context was available for this run."
        )
    lines.extend(["", "## Changes Since Prior Review", ""])
    if changed.get("status") == "no_baseline":
        lines.append("No accepted v2 Portfolio Review baseline exists yet.")
    elif changed.get("changes"):
        for row in changed["changes"]:
            lines.append(
                f"- **{_cell(row.get('field'))}**: {_cell(row.get('before'))} → {_cell(row.get('after'))}"
            )
    else:
        lines.append(
            "No deterministic change was found in the fields tracked against the latest accepted v2 baseline."
        )
    lines.extend(["", "## Coverage & Data Quality", ""])
    quality_exceptions = list(
        dict.fromkeys(
            [
                *list(quality.get("exceptions") or []),
                *exceptions,
            ]
        )
    )
    if quality_exceptions:
        lines.extend(f"- {_cell(row)}" for row in quality_exceptions)
    else:
        lines.append(
            "All required live portfolio and typed reconciliation gates passed."
        )
    return "\n".join(lines).strip() + "\n"


def render_prediction_review(sections: list[dict[str, Any]], outcome: str) -> str:
    board = _find_section(sections, "monitored-markets")
    exposure = _find_section(sections, "held-event-contracts")
    exceptions = _find_section(sections, "exceptions")
    quality = _find_section(sections, "data-status")
    lines = [
        "# Predictive Markets Review",
        "",
        _status_line(outcome),
        "",
        "## Monitored Markets",
        "",
        "| Asset | Venue | Event / contract | Expiration | Resolver | Threshold | Native book | Settlement | Reference | Risk Range / Trade / Trend |",
        "|---|:---:|---|:---:|---|---:|---|:---:|---|---|",
    ]
    for row in board.get("markets") or []:
        lines.append(
            "| {asset} | {venue} | {identity} | {expiration} | {resolver} | {threshold} | "
            "{book} | {settlement} | {reference} | {research} |".format(
                asset=_cell(row.get("asset")),
                venue=_cell(row.get("venue")),
                identity=_cell(row.get("identity")),
                expiration=_cell(row.get("expiration")),
                resolver=_cell(row.get("resolver")),
                threshold=_cell(row.get("threshold")),
                book=_cell(row.get("nativeBook")),
                settlement=_cell(row.get("settlementState")),
                reference=_cell(row.get("liveReference")),
                research=_cell(row.get("researchState")),
            )
        )
    lines.extend(["", "## Held Event-Contract Exposure", ""])
    held = exposure.get("positions") or []
    if held:
        lines.extend(
            [
                "| Contract | Quantity | Expiration | Side | Mark / settlement | Value |",
                "|---|---:|:---:|:---:|---|---:|",
            ]
        )
        for row in held:
            mark = (
                row.get("valuationPrice")
                if row.get("markState") in {"live", "settled", "resolver"}
                else "Unavailable"
            )
            value = (
                _fmt_money(row.get("marketValue"))
                if row.get("markState") in {"live", "settled", "resolver"}
                else "Unavailable"
            )
            lines.append(
                f"| {_cell(row.get('contract') or row.get('symbol'))} | {_fmt_number(row.get('quantity'), 0)} | "
                f"{_cell(row.get('expiration'))} | {_cell(row.get('eventSide'))} | "
                f"{_cell(row.get('markState'))} {_cell(mark)} | {value} |"
            )
    else:
        lines.append("No open IBKR event-contract exposure was returned.")
    lines.extend(["", "## Exceptions", ""])
    exception_rows = exceptions.get("items") or []
    lines.extend(
        [f"- {_cell(item)}" for item in exception_rows]
        or ["No material monitored-market exception was found."]
    )
    lines.extend(["", "## Data Status", ""])
    lines.extend(
        [f"- {_cell(item)}" for item in quality.get("items") or []]
        or ["No data-status detail was returned."]
    )
    return "\n".join(lines).strip() + "\n"


def render_balance_review(sections: list[dict[str, Any]], outcome: str) -> str:
    summary = _find_section(sections, "account-summary")
    capacity = _find_section(sections, "margin-capacity")
    interest = _find_section(sections, "interest-ledger")
    exceptions = _find_section(sections, "exceptions")
    current = summary.get("current") or {}
    exposure = current.get("exposure") or {}
    margin = current.get("margin") or {}
    cash = current.get("cash") or {}
    settlement = current.get("settlement") or {}
    activity = current.get("activity") or {}
    buffer = current.get("buffer") or {}
    portfolio_metrics = capacity.get("portfolioMetrics") or {}
    gross_percent = _finite(exposure.get("grossPercent"))
    gross_leverage = gross_percent / 100 if gross_percent is not None else None
    lines = [
        "# Balance Review",
        "",
        _status_line(outcome),
        "",
        "## Account Summary",
        "",
    ]
    lines.extend(
        [
            f"- Account / currency: **{_cell(current.get('accountId'))} / {_cell(current.get('currency'))}**",
            f"- Observed: **{_cell(current.get('observedAt'))}**",
            f"- Net liquidation value: **{_fmt_money(margin.get('netLiquidation') or exposure.get('netLiquidation'))}**",
            f"- Available funds / buying power / excess liquidity: **{_fmt_money(margin.get('availableFunds'))} / {_fmt_money(margin.get('buyingPower'))} / {_fmt_money(margin.get('excessLiquidity'))}**",
            f"- Broker margin health: **{_cell(margin.get('health'))}**",
        ]
    )
    lines.extend(["", "## Exposure, Margin & Capacity", ""])
    lines.extend(
        [
            f"- Long / short / gross / net exposure: **{_fmt_money(exposure.get('longMarketValue'))} / {_fmt_money(exposure.get('shortMarketValue'))} / {_fmt_money(exposure.get('grossMarketValue'))} / {_fmt_money(exposure.get('netMarketValue'))}**",
            f"- Gross leverage: **{_fmt_number(gross_leverage, 3)}×**",
            f"- Settlement date / state: **{_cell(settlement.get('date'))} / {_cell(settlement.get('state'))}**",
            f"- Securities / commodity cash floors: **{_fmt_money(cash.get('securitiesCashFloor'))} / {_fmt_money(cash.get('commodityCashFloor'))}**",
            f"- Add-long room / trim requirement: **{_fmt_money(cash.get('addLongRoom'))} / {_fmt_money(cash.get('trimRequired'))}**",
            f"- Policy buffer / buffered room: **{_fmt_money(buffer.get('totalReserve'))} / {_fmt_money(buffer.get('addLongRoom'))}**",
            f"- Open orders / same-day executions: **{_fmt_number(activity.get('openOrderCount'), 0)} / {_fmt_number(activity.get('sameDayExecutionCount'), 0)}**",
            f"- Independent marked-position cross-check: **{'verified' if portfolio_metrics.get('available') else 'unavailable'}**",
        ]
    )
    lines.extend(["", "## Interest, Forecasts & Postings", ""])
    interest_status = interest.get("interestStatus") or {}
    history = interest.get("history") or {}
    mtd = interest_status.get("mtd") or {}
    forecast = interest_status.get("forecast") or {}
    latest = interest_status.get("latest") or {}
    stock_borrow = interest_status.get("stockBorrowFees") or {}
    postings = history.get("postings") or []
    latest_posting = postings[-1] if postings else {}
    posting_date = (
        latest_posting.get("posted_date")
        or latest_posting.get("postedDate")
        or latest_posting.get("date")
    )
    posting_value = (
        latest_posting.get("amount")
        if latest_posting.get("amount") is not None
        else latest_posting.get("debitAmount")
        if latest_posting.get("debitAmount") is not None
        else latest_posting.get("value")
    )
    lines.extend(
        [
            f"- Live MTD net accrued / verified debit: **{_fmt_money(mtd.get('liveNetAccrued'))} / {_fmt_money(mtd.get('verifiedDebit'))}**",
            f"- Interest evidence generated: **{_cell(interest_status.get('generatedAt') or history.get('generatedAt'))}**",
            f"- Active forecast: **{_cell(forecast.get('status'))} · {_fmt_money(forecast.get('lower'))} / {_fmt_money(forecast.get('point'))} / {_fmt_money(forecast.get('upper'))}**",
            f"- Latest actual / residual: **{_fmt_money(latest.get('actual'))} / {_fmt_money(latest.get('residual'))}**",
            f"- Forecast rows / daily actual rows / postings: **{len(history.get('forecasts') or [])} / {len(history.get('daily') or [])} / {len(history.get('postings') or [])}**",
            f"- Latest posting: **{_cell(posting_date)} / {_fmt_money(posting_value)}**",
            f"- Stock-borrow status: **{_cell(stock_borrow.get('status'))}**",
        ]
    )
    lines.extend(["", "## Exceptions & Data Status", ""])
    items = exceptions.get("items") or []
    lines.extend(
        [f"- {_cell(item)}" for item in items]
        or [
            "All required Balance Review dependencies passed their verified-live gates."
        ]
    )
    return "\n".join(lines).strip() + "\n"


def render_review(
    review_kind: str,
    sections: list[dict[str, Any]],
    outcome: str,
    _citations: list[dict[str, Any]],
) -> str:
    renderers = {
        "portfolio-review": render_portfolio_review,
        "prediction-markets-review": render_prediction_review,
        "balance-review": render_balance_review,
    }
    renderer = renderers.get(review_kind)
    if not renderer:
        raise ReviewRunError("REVIEW_KIND_INVALID", "Unknown review renderer.")
    return renderer(sections, outcome)


def public_review_run(
    run: dict[str, Any], *, include_diagnostics: bool = False
) -> dict[str, Any]:
    error = None
    if run.get("errorCode"):
        error = {
            "code": run.get("errorCode"),
            "message": run.get("errorMessage") or "The review could not finish.",
            "retryable": run.get("errorRetryable") is True,
        }
    output = {
        "schemaVersion": SCHEMA_VERSION,
        "runId": run.get("runId"),
        "reviewKind": run.get("reviewKind"),
        "conversationId": run.get("conversationId")
        or review_conversation_id(str(run.get("reviewKind") or "")),
        "displayTitle": REVIEW_TITLES.get(run.get("reviewKind"), "Review"),
        "visibleUserMessage": REVIEW_VISIBLE_MESSAGES.get(
            run.get("reviewKind"), "Run review"
        ),
        "sessionId": run.get("sessionId"),
        "requestId": run.get("requestId"),
        "attempt": run.get("attempt"),
        "previousRunId": run.get("previousRunId"),
        "state": run.get("state"),
        "phase": run.get("phase"),
        "outcome": run.get("outcome"),
        "deadlineAt": run.get("deadlineAt"),
        "createdAt": run.get("createdAt"),
        "updatedAt": run.get("updatedAt"),
        "completedAt": run.get("completedAt"),
        "dependencies": run.get("dependencies") or {},
        "sourceFingerprints": run.get("sourceFingerprints") or {},
        "citations": run.get("citations") or [],
        "reportMarkdown": run.get("reportMarkdown"),
        "summaryMarkdown": run.get("summaryMarkdown"),
        "error": error,
        "retryable": bool(error and error.get("retryable")),
    }
    if include_diagnostics:
        output["sections"] = run.get("sections") or []
        output["diagnostics"] = run.get("diagnostics") or {}
    return output


def public_review_run_status(run: dict[str, Any]) -> dict[str, Any]:
    """Return the small polling contract; never include report/evidence payloads."""

    error = None
    if run.get("errorCode") or isinstance(run.get("error"), dict):
        source = run.get("error") if isinstance(run.get("error"), dict) else {}
        error = {
            "code": source.get("code") or run.get("errorCode"),
            "message": source.get("message")
            or run.get("errorMessage")
            or "The review could not finish.",
            "retryable": bool(
                source.get("retryable") or run.get("errorRetryable")
            ),
        }
    state = run.get("state")
    return {
        "schemaVersion": SCHEMA_VERSION,
        "runId": run.get("runId"),
        "conversationId": run.get("conversationId"),
        "reviewKind": run.get("reviewKind"),
        "state": state,
        "phase": run.get("phase"),
        "outcome": run.get("outcome"),
        "deadlineAt": run.get("deadlineAt"),
        "createdAt": run.get("createdAt"),
        "updatedAt": run.get("updatedAt"),
        "completedAt": run.get("completedAt"),
        "active": state in ACTIVE_STATES,
        "retryable": bool(error and error.get("retryable")),
        "error": error,
    }


def public_review_conversation_summary(
    conversation: dict[str, Any]
) -> dict[str, Any]:
    latest = conversation.get("latestRun") or {}
    status = public_review_run_status(latest) if latest else {}
    state = status.get("state") or "ready"
    return {
        "schemaVersion": 1,
        "type": "review",
        "conversationId": conversation.get("conversationId"),
        "reviewKind": conversation.get("reviewKind"),
        "title": conversation.get("title")
        or REVIEW_TITLES.get(conversation.get("reviewKind"), "Review"),
        "createdAt": conversation.get("createdAt"),
        "updatedAt": conversation.get("updatedAt"),
        "state": state,
        "phase": status.get("phase"),
        "outcome": status.get("outcome"),
        "activeRunId": status.get("runId") if state in ACTIVE_STATES else None,
        "latestRunId": status.get("runId"),
        "retryable": bool(status.get("retryable")),
        "error": status.get("error"),
        "hermesSessionId": conversation.get("hermesSessionId"),
    }


def public_review_conversation_detail(
    conversation: dict[str, Any]
) -> dict[str, Any]:
    runs = list(conversation.get("runs") or [])
    messages: list[dict[str, Any]] = []
    for index, run in enumerate(runs):
        review_kind = str(run.get("reviewKind") or conversation.get("reviewKind") or "")
        visible_message = REVIEW_VISIBLE_MESSAGES.get(review_kind, "Run review")
        if index > 0:
            visible_message = f"Retry {REVIEW_TITLES.get(review_kind, 'Review')}"
        messages.append(
            {
                "id": f"{run.get('runId')}:user",
                "role": "user",
                "text": visible_message,
                "createdAt": run.get("createdAt"),
                "runId": run.get("runId"),
            }
        )
        if run.get("state") == "succeeded":
            messages.append(
                {
                    "id": f"{run.get('runId')}:assistant",
                    "role": "assistant",
                    "text": run.get("reportMarkdown")
                    or run.get("summaryMarkdown")
                    or "The review completed without a displayable report.",
                    "createdAt": run.get("completedAt") or run.get("updatedAt"),
                    "runId": run.get("runId"),
                    "citations": run.get("citations") or [],
                    "historical": True,
                }
            )
        elif run.get("state") in {"failed", "cancelled"}:
            messages.append(
                {
                    "id": f"{run.get('runId')}:assistant",
                    "role": "assistant",
                    "text": run.get("errorMessage")
                    or "The review could not finish.",
                    "createdAt": run.get("completedAt") or run.get("updatedAt"),
                    "runId": run.get("runId"),
                    "error": {
                        "code": run.get("errorCode"),
                        "message": run.get("errorMessage")
                        or "The review could not finish.",
                        "retryable": bool(run.get("errorRetryable")),
                    },
                }
            )
    latest = runs[-1] if runs else None
    summary = public_review_conversation_summary(
        {**conversation, "latestRun": latest}
    )
    return {
        **summary,
        "messages": messages,
        "latestRun": public_review_run_status(latest) if latest else None,
        "runCount": len(runs),
    }


def public_review_conversation(
    review_kind: str, runs: list[dict[str, Any]]
) -> dict[str, Any]:
    """Project one fixed review shell and its immutable attempt index."""

    conversation_id = review_conversation_id(review_kind)
    ordered = sorted(
        (run for run in runs if run.get("reviewKind") == review_kind),
        key=lambda run: str(run.get("createdAt") or ""),
        reverse=True,
    )
    latest = public_review_run(ordered[0]) if ordered else None
    attempts = []
    for run in ordered:
        public = public_review_run(run)
        attempts.append(
            {
                key: public.get(key)
                for key in (
                    "runId",
                    "conversationId",
                    "attempt",
                    "state",
                    "phase",
                    "outcome",
                    "createdAt",
                    "updatedAt",
                    "completedAt",
                    "retryable",
                    "error",
                )
            }
        )
    return {
        "conversationId": conversation_id,
        "reviewKind": review_kind,
        "displayTitle": REVIEW_TITLES[review_kind],
        "visibleUserMessage": REVIEW_VISIBLE_MESSAGES[review_kind],
        "latestRun": latest,
        "attempts": attempts,
    }


def _review_context_value(value: Any, *, depth: int = 0) -> Any:
    """Project normalized results without copying evidence or an entire report."""

    if depth >= 5:
        return _bounded_text(value, 300)
    if isinstance(value, dict):
        return {
            _bounded_text(key, 100): _review_context_value(item, depth=depth + 1)
            for key, item in list(sorted(value.items(), key=lambda row: str(row[0])))[
                :40
            ]
            if key not in {"raw", "diagnostics", "evidence", "reportMarkdown"}
        }
    if isinstance(value, list):
        return [_review_context_value(item, depth=depth + 1) for item in value[:20]]
    if isinstance(value, str):
        return _bounded_text(value, 500)
    if value is None or isinstance(value, (bool, int, float)):
        return value
    return _bounded_text(value, 300)


def review_context_v2(run: dict[str, Any]) -> dict[str, Any]:
    """Return the bounded, hidden context allowed for a normal chat follow-up."""

    if int(run.get("schemaVersion") or 0) != SCHEMA_VERSION:
        raise ReviewRunError(
            "REVIEW_CONTEXT_UNAVAILABLE", "A v2 review context is unavailable."
        )
    if run.get("state") != "succeeded":
        raise ReviewRunError(
            "REVIEW_CONTEXT_UNAVAILABLE",
            "Only a completed review can provide follow-up context.",
            status_code=409,
        )
    citations = [
        {
            key: row.get(key)
            for key in ("id", "product", "publicationDate", "title")
            if row.get(key) is not None
        }
        for row in (run.get("citations") or [])[:100]
        if isinstance(row, dict) and row.get("id")
    ]
    context = {
        "schema": "ReviewContextV2",
        "runId": run.get("runId"),
        "conversationId": run.get("conversationId")
        or review_conversation_id(str(run.get("reviewKind") or "")),
        "sessionId": run.get("sessionId"),
        "reviewKind": run.get("reviewKind"),
        "outcome": run.get("outcome"),
        "completedAt": run.get("completedAt"),
        "sections": [
            _review_context_value(row)
            for row in (run.get("sections") or [])
            if isinstance(row, dict)
        ],
        "citations": citations,
        "optionalNarrative": _bounded_text(run.get("summaryMarkdown"), 4_000) or None,
        "rules": {
            "historicalContextOnly": True,
            "maySatisfyCurrentLiveRead": False,
            "mayAlterDeterministicReport": False,
        },
    }
    if len(canonical_json(context).encode("utf-8")) > MAX_REVIEW_CONTEXT_BYTES:
        context["sections"] = [
            {
                key: _review_context_value(row.get(key))
                for key in (
                    "id",
                    "title",
                    "status",
                    "reasonCode",
                    "facts",
                    "exceptions",
                    "items",
                )
                if row.get(key) is not None
            }
            for row in (run.get("sections") or [])
            if isinstance(row, dict)
        ]
        context["citations"] = [row.get("id") for row in citations]
        context["optionalNarrative"] = None
    if len(canonical_json(context).encode("utf-8")) > MAX_REVIEW_CONTEXT_BYTES:
        context["sections"] = [
            {
                key: _bounded_text(row.get(key), 200)
                for key in ("id", "title", "status", "reasonCode")
                if row.get(key) is not None
            }
            for row in (run.get("sections") or [])
            if isinstance(row, dict)
        ]
        context["citations"] = []
    if len(canonical_json(context).encode("utf-8")) > MAX_REVIEW_CONTEXT_BYTES:
        raise ReviewRunError(
            "REVIEW_CONTEXT_TOO_LARGE",
            "The bounded follow-up context could not be created.",
        )
    return context


def coordinator_canary() -> dict[str, Any]:
    fingerprint = canonical_fingerprint(
        {"schemaVersion": SCHEMA_VERSION, "canary": True}
    )
    sections = [
        {
            "id": "account-summary",
            "title": "Account Summary",
            "status": "ready",
            "current": {},
        }
    ]
    report = render_review("balance-review", sections, "partial", [])
    if not re.fullmatch(r"[a-f0-9]{64}", fingerprint):
        raise RuntimeError("ReviewRunV2 hashing canary failed")
    if (
        not report.startswith("# Balance Review")
        or "## Exceptions & Data Status" not in report
    ):
        raise RuntimeError("ReviewRunV2 rendering canary failed")
    return {
        "ready": True,
        "schemaVersion": SCHEMA_VERSION,
        "fingerprint": fingerprint,
        "renderedBytes": len(report.encode("utf-8")),
    }


__all__ = [
    "ACTIVE_STATES",
    "DEADLINE_SECONDS",
    "MAX_REVIEW_CONTEXT_BYTES",
    "MAX_SUMMARY_INPUT_BYTES",
    "REVIEW_KINDS",
    "REVIEW_TITLES",
    "ReviewCoordinatorV2",
    "ReviewExecutionContext",
    "ReviewRunError",
    "ReviewRunV2Store",
    "bounded_summary_input",
    "canonical_fingerprint",
    "coordinator_canary",
    "public_review_run",
    "review_context_v2",
    "render_review",
]
