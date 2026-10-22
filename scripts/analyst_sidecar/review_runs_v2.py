"""Durable, bounded, server-owned Analyst review runs.

ReviewRunV2 deliberately keeps review acquisition and rendering outside Hermes.
Trading values are accepted only after the review-kind provider has applied its
verified-live gates.  Raw evidence is content-addressed once; public run
responses expose fingerprints and deterministic reports, never the archive.
"""

from __future__ import annotations

import asyncio
import base64
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from hashlib import sha256
import inspect
from html import escape as html_escape
import json
import logging
import os
from pathlib import Path
import re
import sqlite3
import threading
import time
from typing import Any, Awaitable, Callable, Optional, Union
from uuid import NAMESPACE_URL, UUID, uuid4, uuid5
from zoneinfo import ZoneInfo

from loop_lag import monitor as loop_lag_monitor


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
    "prediction-markets-review": 90,
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
# Parsed evidence is about 2.7x its canonical JSON size in memory. These bounds
# keep Sources polling from re-parsing a capture without retaining more than
# roughly 90 MB, and they never hold a single unusually large payload.
SHARED_EVIDENCE_MAX_ENTRIES = 32
SHARED_EVIDENCE_MAX_BYTES = 32 * 1024 * 1024
SHARED_EVIDENCE_MAX_ENTRY_BYTES = 16 * 1024 * 1024
SOURCES_PROJECTION_MAX_ENTRIES = 64
SOURCES_PROJECTION_MAX_BYTES = 256 * 1024

CheckpointHook = Callable[[str, str, str, str], Any]
# One ordered worker delivers checkpoint notifications. A slow workspace write
# can delay a Sources refresh but never the review acquisition that caused it.
_CHECKPOINT_NOTIFIER = ThreadPoolExecutor(max_workers=1, thread_name_prefix="review-checkpoint-hook")


def _notify_checkpoint(
    hook: CheckpointHook, conversation_id: str, run_id: str, source_name: str, status: str
) -> None:
    def deliver() -> None:
        try:
            hook(conversation_id, run_id, source_name, status)
        except Exception:
            LOGGER.exception("Review checkpoint hook failed for %s/%s", run_id, source_name)

    try:
        _CHECKPOINT_NOTIFIER.submit(deliver)
    except RuntimeError:
        # Interpreter shutdown: the durable checkpoint already committed.
        LOGGER.warning("Review checkpoint hook skipped for %s/%s during shutdown", run_id, source_name)


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
        self._shared_evidence: OrderedDict = OrderedDict()
        self._shared_evidence_bytes = 0
        self._sources_projections: OrderedDict = OrderedDict()
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
            if "report_revision" not in columns:
                connection.execute(
                    "ALTER TABLE analyst_review_runs_v2 ADD COLUMN report_revision TEXT"
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

    def _decode(self, row: sqlite3.Row | None, *, evidence_payloads=None, portfolio_alignment=None, portfolio_comparison=None) -> Optional[dict[str, Any]]:
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
            "report_revision": "reportRevision",
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
        # Share bulky raw payloads only during this decode. Persistent caches
        # contain bounded projections, never the full account/market evidence.
        evidence_payloads = evidence_payloads if evidence_payloads is not None else {}
        self._hydrate_saved_cpi_forecasts(value, evidence_payloads)
        self._hydrate_saved_prediction_research(value, evidence_payloads)
        self._hydrate_saved_portfolio_hedgai(value, evidence_payloads)
        self._hydrate_saved_portfolio_comparison(value, evidence_payloads, comparison=portfolio_comparison)
        alignment = self._hydrate_saved_position_alignment(value, evidence_payloads)
        if portfolio_alignment is not None and alignment is not None:
            portfolio_alignment["value"] = alignment
        return value

    def _hydrate_saved_portfolio_comparison(self, run, evidence_payloads, *, comparison=None):
        """Repair presentation using this capture and its preceding session.

        Neither the saved report nor its evidence is rewritten. Later backfills,
        current broker data and chat visibility cannot change this comparison.
        """
        if run.get("reviewKind") != "portfolio-review" or run.get("state") != "succeeded":
            return
        change = _find_section(run.get("sections") or [], "changes-since-prior")
        if not change:
            return
        if comparison is not None:
            change["comparison"] = deepcopy(comparison)
            return comparison
        dependency = (run.get("dependencies") or {}).get("portfolio") or {}
        if dependency.get("status") not in {"ready", "partial"} or (dependency.get("detail") or {}).get("liveVerified") is not True:
            return
        from portfolio_capture import project_portfolio_context
        from portfolio_review import portfolio_metrics

        def captured(name):
            expected = (run.get("sourceFingerprints") or {}).get(name)
            descriptor = (run.get("dependencies") or {}).get(name) or {}
            if expected and descriptor.get("fingerprint") not in {None, expected}:
                return {}
            _, payload = self._saved_evidence_payload(run, name, evidence_payloads)
            return self._decode_saved_evidence_payload(payload)

        metrics = portfolio_metrics(project_portfolio_context(captured("portfolio")), captured("portfolioBalance"))
        cutoff = ((run.get("dependencies") or {}).get("dailyResearch") or {}).get("asOf") or run.get("createdAt")
        previous = change.get("comparison") or {}
        change["comparison"] = self.portfolio_close_comparison(metrics, cutoff, bound_source=previous.get("baselineSource"))
        return change["comparison"]

    def portfolio_close_comparison(self, metrics, review_as_of, *, bound_source=None):
        """Use surviving immutable accounting, independently of deleted chats."""
        from portfolio_capture import project_portfolio_context
        from portfolio_review import portfolio_metrics
        from portfolio_rollup_metrics import (
            _time, build_review_comparison, comparison_observed_at,
            is_previous_session_close, previous_session_baseline,
        )
        session = previous_session_baseline(review_as_of)
        cutoff = _time(review_as_of)
        unavailable = build_review_comparison(metrics, {}, session_baseline=session)
        if cutoff is None or not session:
            return unavailable
        # This exact historical horizon survives later review volume. A saved
        # bound source is read directly; legacy projections only scan the target
        # session, never the latest global review window or full reports.
        query = (
            "SELECT run_id, created_at, completed_at, dependencies_json, source_fingerprints_json "
            "FROM analyst_review_runs_v2 WHERE review_kind='portfolio-review' AND state='succeeded' "
            "AND julianday(created_at)<julianday(?) AND julianday(completed_at)<=julianday(?)"
        )
        params = [review_as_of, review_as_of]
        if bound_source:
            query += " AND run_id=?"
            params.append(bound_source.get("runId"))
        else:
            from portfolio_rollup_metrics import EASTERN, _holdings_frozen_until
            close = _time(session["baselineSessionCloseAt"])
            end = (_holdings_frozen_until(session["baselineSessionDate"])
                   or close.astimezone(EASTERN).replace(hour=0, minute=0, second=0, microsecond=0) + timedelta(days=1))
            query += " AND julianday(json_extract(dependencies_json, '$.portfolio.asOf'))>=julianday(?) AND julianday(json_extract(dependencies_json, '$.portfolio.asOf'))<julianday(?)"
            params += [session["baselineSessionCloseAt"], end.isoformat()]
        with self.connect() as connection:
            rows = connection.execute(query, params).fetchall()
        runs = [{"runId": row["run_id"], "createdAt": row["created_at"], "completedAt": row["completed_at"],
                 "dependencies": _parse_json(row["dependencies_json"], {}),
                 "sourceFingerprints": _parse_json(row["source_fingerprints_json"], {})} for row in rows]
        candidates = []
        for run in runs:
            created, completed = _time(run.get("createdAt")), _time(run.get("completedAt"))
            if not created or not completed or not created <= completed <= cutoff:
                continue
            dependency = (run.get("dependencies") or {}).get("portfolio") or {}
            if (dependency.get("status") not in {"ready", "partial"}
                    or (dependency.get("detail") or {}).get("liveVerified") is not True
                    or not is_previous_session_close({"observedAt": dependency.get("asOf")}, session)):
                continue

            def original_capture(name):
                fingerprint = ((run.get("sourceFingerprints") or {}).get(name)
                               or ((run.get("dependencies") or {}).get(name) or {}).get("fingerprint"))
                if not fingerprint:
                    return None, None
                if bound_source and fingerprint != bound_source.get("portfolioFingerprint" if name == "portfolio" else "balanceFingerprint"):
                    return None, None
                with self.connect() as connection:
                    row = connection.execute("SELECT created_at FROM analyst_review_evidence_v2 WHERE fingerprint=? AND source_name=?",
                                             (fingerprint, name)).fetchone()
                stored = _time(row[0]) if row else None
                # A later import with an earlier claimed observation is not part
                # of a saved review's original historical evidence horizon.
                if stored is None or stored > cutoff:
                    return None, None
                payload = self.read_evidence(run, name)
                return (payload, fingerprint) if payload else (None, None)

            portfolio, portfolio_fingerprint = original_capture("portfolio")
            if not portfolio:
                continue
            balance, balance_fingerprint = original_capture("portfolioBalance")
            candidate = portfolio_metrics(project_portfolio_context(portfolio), balance)
            if bound_source and candidate.get("exposureBasis") != bound_source.get("exposureBasis"):
                continue
            observed = _time(comparison_observed_at(candidate))
            if not is_previous_session_close(candidate, session) or observed is None or observed > completed:
                continue
            source = {"runId": run["runId"], "source": "ibkr",
                      "portfolioFingerprint": portfolio_fingerprint,
                      "balanceFingerprint": balance_fingerprint,
                      "exposureBasis": candidate.get("exposureBasis")}
            candidates.append((observed, candidate, source))
        # Prefer the first complete post-close observation. Later evening
        # captures can include subsequent trades and are not closer to the close.
        for _, candidate, source in sorted(candidates, key=lambda row: row[0]):
            comparison = build_review_comparison(metrics, candidate, session_baseline=session, baseline_source=source)
            if comparison["status"] == "available":
                return comparison
        return unavailable

    def _hydrate_saved_position_alignment(self, run, evidence_payloads):
        """Present comparisons using only this saved post's verified evidence."""
        if run.get("reviewKind") != "portfolio-review" or run.get("state") != "succeeded":
            return
        review = _find_section(run.get("sections") or [], "portfolio-research-review")
        if not isinstance(review.get("dailyRollup"), dict):
            return

        def verified_payload(name):
            dependency = (run.get("dependencies") or {}).get(name) or {}
            fingerprint = (run.get("sourceFingerprints") or {}).get(name) or dependency.get("fingerprint")
            if not fingerprint or dependency.get("fingerprint") not in {None, fingerprint}:
                return None, None
            verified, payload = self._saved_evidence_payload(run, name, evidence_payloads)
            return (verified, payload) if verified == fingerprint else (None, None)

        from portfolio_brief import with_position_alignment
        from portfolio_capture import project_portfolio_context
        from portfolio_review import portfolio_metrics

        names = ("portfolio", "portfolioReference", "portfolioBalance", "heldResearchEvents", "dailyResearch")
        # Validate immutable payload bytes before every memo hit. Cache only
        # the bounded display projection, never the raw account evidence.
        payloads = {name: verified_payload(name) for name in names}
        if not payloads["portfolio"][1] and not payloads["portfolioReference"][1] and not any(section.get("id") in {"position-confirmations", "position-contradictions"}
                                                      for section in review["dailyRollup"].get("sections") or []):
            return
        cutoff = ((run.get("dependencies") or {}).get("dailyResearch") or {}).get("asOf") or run.get("createdAt")
        key = ("position-alignment-v1", cutoff, *(payloads[name][0] for name in names))
        alignment = self._saved_projection_get(key)
        if alignment is None:
            captured = {name: self._decode_saved_evidence_payload(payloads[name][1]) for name in names}
            reference = captured["portfolioReference"]
            metrics = portfolio_metrics(project_portfolio_context(captured["portfolio"]), captured["portfolioBalance"])
            if not metrics.get("available") and reference.get("verifiedAtCapture") is True:
                metrics = portfolio_metrics(project_portfolio_context(reference.get("portfolio") or {}), reference.get("balance") or {})
            alignment = with_position_alignment({}, metrics, captured["heldResearchEvents"], captured["dailyResearch"], as_of=cutoff)
            self._saved_projection_put(key, alignment)
        rollup = deepcopy(review["dailyRollup"])
        rollup["sections"] = [section for section in rollup.get("sections") or []
                              if section.get("id") not in {"position-confirmations", "position-contradictions"}] + alignment["sections"]
        existing = {source.get("id") for source in rollup.get("citations") or []}
        rollup["citations"] = list(rollup.get("citations") or []) + [source for source in alignment["citations"] if source.get("id") not in existing]
        rollup["securityTickers"] = sorted(set(rollup.get("securityTickers") or []) | set(alignment["securityTickers"]))
        review["dailyRollup"] = rollup
        ids = {source.get("id") for source in run.get("citations") or []}
        run["citations"] = list(run.get("citations") or []) + [source for source in rollup.get("citations") or [] if source.get("id") not in ids]
        return alignment

    def _hydrate_saved_portfolio_hedgai(self, run, evidence_payloads):
        """Use the immutable source and captured display settings for exports."""
        if run.get("reviewKind") != "portfolio-review" or run.get("state") != "succeeded":
            return
        dependency = (run.get("dependencies") or {}).get("dailyResearch") or {}
        fingerprint = (run.get("sourceFingerprints") or {}).get("dailyResearch") or dependency.get("fingerprint")
        cutoff = dependency.get("asOf")
        if not fingerprint or not cutoff or dependency.get("fingerprint") not in {None, fingerprint}:
            return
        verified, payload = self._saved_evidence_payload(run, "dailyResearch", evidence_payloads)
        if verified != fingerprint:
            return
        evidence = self._decode_saved_evidence_payload(payload)
        from hedgai_review import reproject_portfolio_hedgai
        for section in run.get("sections") or []:
            if section.get("id") == "portfolio-research-review" and isinstance(section.get("dailyRollup"), dict):
                rollup = reproject_portfolio_hedgai(section["dailyRollup"], evidence.get("hedgai"), as_of=cutoff)
                section["dailyRollup"] = rollup
                ids = {source.get("id") for source in rollup.get("citations") or []}
                run["citations"] = [source for source in run.get("citations") or [] if source.get("id") not in ids] + rollup.get("citations", [])

    def _saved_evidence_payload(self, run, source_name, memo):
        fingerprint = ((run.get("sourceFingerprints") or {}).get(source_name)
                       or ((run.get("dependencies") or {}).get(source_name) or {}).get("fingerprint"))
        key = (source_name, fingerprint)
        if key not in memo:
            payload = None
            if fingerprint:
                with self.connect() as connection:
                    row = connection.execute(
                        "SELECT payload_json FROM analyst_review_evidence_v2 WHERE fingerprint = ? AND source_name = ?",
                        (fingerprint, source_name),
                    ).fetchone()
                # store_evidence persists these exact canonical UTF-8 bytes.
                # Check them on every read, including warm projection hits.
                if row and sha256(row[0].encode("utf-8")).hexdigest() == fingerprint:
                    payload = row[0]
            memo[key] = (fingerprint, payload) if payload is not None else (None, None)
        return memo[key]

    @staticmethod
    def _decode_saved_evidence_payload(payload):
        try:
            value = json.loads(payload) if payload is not None else {}
        except (ValueError, TypeError):
            return {}
        return value if isinstance(value, dict) else {}

    def _saved_projection_get(self, key):
        with self._lock:
            cache = getattr(self, "_saved_prediction_projections", None)
            if cache is None or key not in cache:
                return None
            cache.move_to_end(key)
            return deepcopy(cache[key])

    def _saved_projection_put(self, key, value):
        # Sixteen entries of at most 512 KiB bound retained report text and
        # citation excerpts to 8 MiB. Oversized reports still render normally.
        if len(canonical_json(value).encode("utf-8")) > 512 * 1024:
            return
        with self._lock:
            cache = getattr(self, "_saved_prediction_projections", None)
            if cache is None:
                cache = self._saved_prediction_projections = OrderedDict()
            cache[key] = deepcopy(value)
            cache.move_to_end(key)
            while len(cache) > 16:
                cache.popitem(last=False)

    def _hydrate_saved_prediction_research(self, run: dict[str, Any], evidence_payloads=None) -> None:
        """Project research from this report's archive without updating its capture."""
        if run.get("reviewKind") != "prediction-markets-review" or run.get("state") != "succeeded":
            return
        dependency = (run.get("dependencies") or {}).get("predictionResearch") or {}
        fingerprint = (run.get("sourceFingerprints") or {}).get("predictionResearch") or dependency.get("fingerprint")
        cutoff = dependency.get("asOf")
        if (not fingerprint or not cutoff or dependency.get("status") in {"failed", "error", "unavailable"}
                or dependency.get("fingerprint") not in {None, fingerprint}):
            return
        markets = [market for section in run.get("sections") or [] if isinstance(section, dict)
                   and section.get("id") == "monitored-markets" for market in section.get("markets") or []
                   if isinstance(market, dict) and market.get("marketId")]
        if not markets:
            return

        from daily_research_rollup import _datetime
        from prediction_research_rollup import build_prediction_research_rollup

        if _datetime(cutoff) is None:
            return
        memo = evidence_payloads if evidence_payloads is not None else {}
        verified_fingerprint, evidence_payload = self._saved_evidence_payload(run, "predictionResearch", memo)
        if verified_fingerprint != fingerprint:
            return
        prediction_fingerprint, prediction_payload = self._saved_evidence_payload(run, "predictionUniverse", memo)
        prediction_cutoff = run.get("completedAt") if _datetime(run.get("completedAt")) else cutoff
        cache_key = ("research", fingerprint, prediction_fingerprint, cutoff, prediction_cutoff)
        rollup = self._saved_projection_get(cache_key)
        if rollup is None:
            evidence = self._decode_saved_evidence_payload(evidence_payload)
            prediction_evidence = self._decode_saved_evidence_payload(prediction_payload)
            rollup = build_prediction_research_rollup(
                evidence, as_of=cutoff, prediction_evidence=prediction_evidence, prediction_as_of=prediction_cutoff
            )
            self._saved_projection_put(cache_key, rollup)

        def referenced_ids(value, *, skip_research=False):
            result = set()
            if isinstance(value, dict):
                for key, child in value.items():
                    if skip_research and key == "research":
                        continue
                    if key == "citationIds" and isinstance(child, list):
                        result.update(cid for cid in child if isinstance(cid, str))
                    elif key == "citationId" and isinstance(child, str):
                        result.add(child)
                    else:
                        result.update(referenced_ids(child, skip_research=skip_research))
            elif isinstance(value, list):
                for child in value:
                    result.update(referenced_ids(child, skip_research=skip_research))
            return result

        old_ids = set()
        new_ids = set()
        for market in markets:
            if market["marketId"] not in rollup["markets"]:
                continue
            old_ids.update(referenced_ids(market.get("research")))
            market["research"] = rollup["markets"][market["marketId"]]
            new_ids.update(referenced_ids(market["research"]))
        retained_ids = referenced_ids(run.get("sections"), skip_research=True)
        preserved = [citation for citation in run.get("citations") or []
                     if not isinstance(citation, dict) or citation.get("id") not in old_ids
                     or citation.get("id") in retained_ids]
        existing_ids = {citation.get("id") for citation in preserved if isinstance(citation, dict)}
        run["citations"] = preserved + [citation for citation in rollup["citations"]
                                       if citation.get("id") in new_ids and citation.get("id") not in existing_ids]

    def _hydrate_saved_cpi_forecasts(self, run: dict[str, Any], evidence_payloads=None) -> None:
        """Restore omitted scenario bounds from this capture, without rewriting it."""
        if run.get("reviewKind") != "prediction-markets-review" or run.get("state") != "succeeded":
            return
        markets = [market for section in run.get("sections") or [] if isinstance(section, dict)
                   and section.get("id") == "monitored-markets" for market in section.get("markets") or []
                   if isinstance(market, dict) and market.get("marketId") == "cpi"]
        if len(markets) != 1:
            return
        market = markets[0]
        recorded = [field for field in market.get("fields") or []
                    if isinstance(field, (list, tuple)) and len(field) == 2 and field[0] == "Hedgeye nowcast"]
        if len(recorded) != 1 or re.search(r"\bLower\b.*\bBase\b.*\bUpper\b", str(recorded[0][1])):
            return

        from prediction_review import _cpi_forecasts, obj, safe, timestamp

        memo = evidence_payloads if evidence_payloads is not None else {}
        fingerprint, payload = self._saved_evidence_payload(run, "predictionUniverse", memo)
        if payload is None:
            return
        cache_key = ("cpi", fingerprint, obj(obj(run.get("dependencies")).get("predictionUniverse")).get("asOf"),
                     run.get("createdAt"), market.get("venue"))
        restored = self._saved_projection_get(cache_key)
        if restored is not None:
            market["fields"] = [type(field)((field[0], restored)) if field is recorded[0] else field
                                for field in market["fields"]]
            return
        evidence = self._decode_saved_evidence_payload(payload)
        raw_markets = [row for row in obj(evidence.get("data")).get("markets") or []
                       if isinstance(row, dict) and row.get("marketId") == "cpi"]
        if len(raw_markets) != 1 or not safe(evidence, raw_markets[0]):
            return
        raw = raw_markets[0]
        snapshot = obj(raw.get("snapshot"))
        venue_id = str(raw.get("requestedVenue") or "").lower()
        selection = obj(snapshot.get("displaySelection"))
        if (venue_id not in {"forecastex", "kalshi"} or not safe(snapshot, selection)
                or str(market.get("venue") or "").lower() != venue_id
                or snapshot.get("marketId", "cpi") != "cpi"
                or (snapshot.get("selectedVenueId") or selection.get("venueId")) != venue_id
                or selection.get("venueId", venue_id) != venue_id):
            return
        catalog = obj(obj(obj(snapshot.get("venues")).get(venue_id)).get("catalog"))
        if catalog.get("status") != "available" or not safe(catalog):
            catalog = obj(snapshot.get("displayContracts"))
        event = obj(catalog.get("event"))
        forecast = obj(obj(snapshot.get("forecastComparison")).get("hedgeye"))
        captured_at = (timestamp(obj(obj(run.get("dependencies")).get("predictionUniverse")).get("asOf"))
                       or timestamp(evidence.get("asOf")) or timestamp(run.get("createdAt")))
        published_at = timestamp(forecast.get("asOf"))
        published_day = None
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(forecast.get("asOf") or "")):
            try:
                published_day = datetime.strptime(forecast["asOf"], "%Y-%m-%d").date()
            except ValueError:
                pass
        within_capture = bool(captured_at and (
            (published_at and published_at <= captured_at)
            or (published_day and published_day <= captured_at.date())
        ))
        if (not safe(catalog, event) or event.get("venueId", venue_id) != venue_id
                or forecast.get("reportMonth", event.get("reportMonth")) != event.get("reportMonth")
                or not within_capture):
            return
        fields, _gaps = _cpi_forecasts(snapshot, event)
        restored = dict(fields).get("Hedgeye nowcast")
        if restored and re.search(r"\bLower\b.*\bBase\b.*\bUpper\b", restored):
            self._saved_projection_put(cache_key, restored)
            market["fields"] = [type(field)((field[0], restored)) if field is recorded[0] else field
                                for field in market["fields"]]

    def _insert_run_locked(
        self,
        connection: sqlite3.Connection,
        *,
        review_kind: str,
        conversation_id: str,
        session_id: str,
        request_id: str,
        deadline_seconds: Optional[int],
        run_id: Optional[str] = None,
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
        run_id = run_id or str(uuid4())
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
        run_id: Optional[str] = None,
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
        supplied_run_id = None
        if run_id is not None:
            try:
                if not isinstance(run_id, str):
                    raise ValueError("runId must be a UUID")
                supplied_run_id = str(UUID(run_id))
            except (ValueError, TypeError, AttributeError) as exc:
                raise ReviewRunError("REVIEW_REQUEST_INVALID", "runId must be a UUID.") from exc
        with self._lock, self.connect() as connection:
            existing = connection.execute(
                "SELECT * FROM analyst_review_runs_v2 WHERE conversation_id = ? AND request_id = ?",
                (clean_conversation, clean_request),
            ).fetchone()
            if existing:
                if (existing["review_kind"] != review_kind
                        or existing["session_id"] != clean_session
                        or (supplied_run_id and existing["run_id"] != supplied_run_id)):
                    raise ReviewRunError(
                        "REVIEW_REQUEST_CONFLICT", "The requestId belongs to a different review attempt.",
                        status_code=409,
                    )
                return self._decode(existing), False
            if supplied_run_id and connection.execute(
                "SELECT 1 FROM analyst_review_runs_v2 WHERE run_id = ?", (supplied_run_id,)
            ).fetchone():
                raise ReviewRunError(
                    "REVIEW_RUN_CONFLICT", "The runId belongs to a different review request.",
                    status_code=409,
                )
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
                run_id=supplied_run_id,
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

    def get_portfolio_brief(self, run_id: str, project_portfolio, *, compact=False):
        """Memoize exact captured presentation after verifying its evidence bytes."""
        with self.connect() as connection:
            row = connection.execute(
                "SELECT * FROM analyst_review_runs_v2 WHERE run_id=?", (str(run_id),)
            ).fetchone()
        from portfolio_brief import presents_capture
        report_available = bool(row and str(row["report_markdown"] or "").strip())
        if (not row or row["review_kind"] != "portfolio-review"
                or not presents_capture({"state": row["state"], "reportAvailable": report_available})):
            return None
        identity = {"runId": row["run_id"], "conversationId": row["conversation_id"],
                    "reviewKind": row["review_kind"], "state": row["state"], "reportAvailable": report_available,
                    "reportRevision": row["report_revision"] or row["updated_at"]}
        captured = {**identity,
                    "dependencies": _parse_json(row["dependencies_json"], {}),
                    "sourceFingerprints": _parse_json(row["source_fingerprints_json"], {})}
        names = ("portfolio", "portfolioBalance", "portfolioReference", "heldResearchEvents",
                 "portfolioSizing", "portfolioOpenOrders", "dailyResearch")
        memo = {}
        payloads = {}
        for name in names:
            fingerprint = captured["sourceFingerprints"].get(name) or (captured["dependencies"].get(name) or {}).get("fingerprint")
            dependency = captured["dependencies"].get(name) or {}
            payloads[name] = self._saved_evidence_payload(captured, name, memo) if dependency.get("fingerprint") in {None, fingerprint} else (None, None)
        comparison_run = {**captured, "createdAt": row["created_at"], "sections": _parse_json(row["sections_json"], [])}
        comparison = self._hydrate_saved_portfolio_comparison(comparison_run, memo)
        # A rejected saved input must invalidate a client's previous full
        # presentation even when the durable report text is unchanged.
        identity["reportRevision"] = canonical_fingerprint({
            "reportRevision": identity["reportRevision"],
            "presentationVersion": "portfolio-brief-v7",
            "verifiedSourceFingerprints": {name: payloads[name][0] for name in names},
            "comparison": comparison,
        })
        digest = sha256()
        for field in row.keys():
            digest.update(field.encode("utf-8") + b"\0" + str(row[field]).encode("utf-8") + b"\0")
        from portfolio_capture import project_portfolio_context
        standard_projector = project_portfolio is project_portfolio_context
        key = ("portfolio-brief-v7", "compact" if compact else "full", standard_projector,
               digest.hexdigest(), canonical_fingerprint(comparison), *(payloads[name][0] for name in names))
        if standard_projector:
            with self._lock:
                cache = getattr(self, "_portfolio_brief_projections", None)
                if cache is not None and key in cache:
                    cache.move_to_end(key)
                    return identity, deepcopy(cache[key])
        alignment = {}
        run = self._decode(row, evidence_payloads=memo, portfolio_alignment=alignment, portfolio_comparison=comparison)
        from portfolio_brief import build_captured_portfolio_brief, compact_portfolio_brief
        brief = build_captured_portfolio_brief(run, {
            name: self._decode_saved_evidence_payload(payloads[name][1]) for name in names
        }, project_portfolio, position_alignment=alignment.get("value") if standard_projector else None)
        brief["reportRevision"] = identity["reportRevision"]
        if compact:
            brief = compact_portfolio_brief(brief)
        # Four bounded display projections retain at most 8 MiB. Raw account
        # and research input payloads are discarded after this read.
        if standard_projector and len(canonical_json(brief).encode("utf-8")) <= 2 * 1024 * 1024:
            with self._lock:
                cache = getattr(self, "_portfolio_brief_projections", None)
                if cache is None:
                    cache = self._portfolio_brief_projections = OrderedDict()
                cache[key] = deepcopy(brief)
                cache.move_to_end(key)
                while len(cache) > 4:
                    cache.popitem(last=False)
        return identity, brief

    def get_compact_portfolio_brief(self, run_id: str, project_portfolio):
        return self.get_portfolio_brief(run_id, project_portfolio, compact=True)

    def _get_metadata(self, run_id: str, *, include_sources: bool = False) -> Optional[dict[str, Any]]:
        columns = """run_id AS runId, schema_version AS schemaVersion,
            review_kind AS reviewKind, conversation_id AS conversationId,
            session_id AS sessionId, state, phase, outcome, deadline_at AS deadlineAt,
            created_at AS createdAt, updated_at AS updatedAt, completed_at AS completedAt,
            error_code AS errorCode, error_message AS errorMessage, error_retryable AS errorRetryable,
            CASE WHEN report_markdown IS NOT NULL AND trim(report_markdown)!='' THEN 1 ELSE 0 END AS reportAvailable,
            coalesce(report_revision,CASE WHEN report_markdown IS NOT NULL AND trim(report_markdown)!=''
                THEN updated_at END) AS reportRevision"""
        if include_sources:
            columns += ", dependencies_json, source_fingerprints_json"
        with self.connect() as connection:
            row = connection.execute(
                f"SELECT {columns} FROM analyst_review_runs_v2 WHERE run_id = ?", (str(run_id),)
            ).fetchone()
        if row is None:
            return None
        value = dict(row)
        value["errorRetryable"] = bool(value["errorRetryable"])
        value["reportAvailable"] = bool(value["reportAvailable"])
        if include_sources:
            value["dependencies"] = _parse_json(value.pop("dependencies_json"), {})
            value["sourceFingerprints"] = _parse_json(value.pop("source_fingerprints_json"), {})
        return value

    def get_status(self, run_id: str) -> Optional[dict[str, Any]]:
        """Read lifecycle and presentation identity without decoding a saved report."""
        return self._get_metadata(run_id)

    def get_source_metadata(self, run_id: str) -> Optional[dict[str, Any]]:
        """Read captured source descriptors; source verification still owns blob reads."""
        return self._get_metadata(run_id, include_sources=True)

    def find_report_run_ids(self, conversation_id: str, reports: list[str]) -> dict[str, list[str]]:
        """Resolve legacy report text without hydrating unrelated saved runs."""
        wanted = {str(report).strip() for report in reports if str(report).strip()}
        if not wanted:
            return {}
        with self.connect() as connection:
            rows = connection.execute(
                "SELECT run_id,report_markdown FROM analyst_review_runs_v2 "
                "WHERE conversation_id=? AND state='succeeded' ORDER BY created_at DESC",
                (str(conversation_id),),
            )
            matches: dict[str, list[str]] = {}
            for row in rows:
                report = str(row["report_markdown"] or "").strip()
                if report in wanted:
                    matches.setdefault(report, []).append(row["run_id"])
        return matches

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

    def list_portfolio_reference_candidates(self, limit: int = 500) -> list[dict[str, Any]]:
        """Read saved portfolio eligibility without hydrating complete reports.

        Keep the same recent-run window as list_recent. Large sections and
        citations, including unrelated prediction evidence, are only needed
        when a selected report is opened.
        """
        with self.connect() as connection:
            rows = connection.execute(
                "SELECT run_id, review_kind, conversation_id, state, outcome, "
                "created_at, completed_at, dependencies_json, source_fingerprints_json, report_markdown FROM "
                "(SELECT run_id, review_kind, conversation_id, state, outcome, "
                "created_at, completed_at, dependencies_json, source_fingerprints_json, report_markdown "
                "FROM analyst_review_runs_v2 ORDER BY updated_at DESC LIMIT ?) "
                "WHERE review_kind = 'portfolio-review'",
                (max(1, min(500, int(limit))),),
            ).fetchall()
        return [{
            "runId": row["run_id"], "reviewKind": row["review_kind"],
            "conversationId": row["conversation_id"], "state": row["state"],
            "outcome": row["outcome"], "createdAt": row["created_at"],
            "completedAt": row["completed_at"],
            "dependencies": _parse_json(row["dependencies_json"], {}),
            "sourceFingerprints": _parse_json(row["source_fingerprints_json"], {}),
            "reportMarkdown": row["report_markdown"],
        } for row in rows]

    def has_conversation(self, conversation_id: str) -> bool:
        with self.connect() as connection:
            return connection.execute(
                "SELECT 1 FROM analyst_review_conversations_v1 "
                "WHERE conversation_id = ? AND archived_at IS NULL",
                (str(conversation_id),),
            ).fetchone() is not None

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
        exclude_conversation_ids: Optional[Any] = None,
    ) -> tuple[list[dict[str, Any]], Optional[str]]:
        bounded_limit = max(1, min(100, int(limit)))
        where = ["c.archived_at IS NULL"]
        params: list[Any] = []
        excluded = sorted({str(value) for value in exclude_conversation_ids or () if value})
        if excluded:
            # Workspace tombstones hide deleted chats on read. Their immutable
            # review runs and shared evidence stay in this store.
            where.append("c.conversation_id NOT IN (SELECT value FROM json_each(?))")
            params.append(json.dumps(excluded))
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

    def active_attempt_count(self, window_seconds: float) -> int:
        """Queued or running attempts updated within the window (read-only)."""
        with self.connect() as connection:
            row = connection.execute(
                "SELECT COUNT(*) FROM analyst_review_runs_v2 WHERE state IN ('queued','running') "
                "AND (julianday('now') - julianday(updated_at)) * 86400 <= ?",
                (window_seconds,),
            ).fetchone()
        return int(row[0])

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
            return self.get(run_id)
        updated_at = utc_now_iso()
        assignments.append("updated_at = ?")
        values.append(updated_at)
        values.append(run_id)
        with self._lock, self.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            current = connection.execute(
                "SELECT state,conversation_id,citations_json,source_fingerprints_json "
                "FROM analyst_review_runs_v2 WHERE run_id=?", (run_id,),
            ).fetchone()
            if current is None:
                raise KeyError(run_id)
            if current["state"] in TERMINAL_STATES and any(key != "baselineAcceptedAt" for key in changes):
                raise ReviewRunError("REVIEW_IMMUTABLE", "Completed review attempts are immutable.", status_code=409)
            if "reportMarkdown" in changes:
                report = changes["reportMarkdown"]
                revision = canonical_fingerprint({
                    "reportMarkdown": report,
                    "citations": changes.get("citations", _parse_json(current["citations_json"], [])),
                    "sourceFingerprints": changes.get("sourceFingerprints", _parse_json(current["source_fingerprints_json"], {})),
                }) if report and str(report).strip() else None
                assignments.append("report_revision = ?")
                values.insert(-1, revision)
            connection.execute(
                f"UPDATE analyst_review_runs_v2 SET {', '.join(assignments)} WHERE run_id = ?",
                values,
            )
            connection.execute(
                "UPDATE analyst_review_conversations_v1 SET updated_at = ? "
                "WHERE conversation_id = ?",
                (updated_at, current["conversation_id"]),
            )
        return self.get(run_id)

    def merge_dependency(
        self, run_id: str, source_name: str, descriptor: dict[str, Any]
    ) -> dict[str, Any]:
        self.commit_dependency(run_id, source_name, descriptor)
        return self.get(run_id)

    def commit_dependency(
        self, run_id: str, source_name: str, descriptor: dict[str, Any]
    ) -> None:
        """Merge one stage descriptor without hydrating the saved run afterwards."""
        # Acquisition stages settle concurrently.  Keep the read/merge/write in
        # one critical section and one SQLite transaction so two checkpoints
        # cannot both read the same old JSON object and erase one another.
        with self._lock, self.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
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

    def store_evidence(self, source_name: str, payload: Any) -> tuple[str, int]:
        serialized = canonical_json(payload)
        encoded = serialized.encode("utf-8")
        # Serialize once: hashing these exact bytes equals canonical_fingerprint(payload).
        fingerprint = sha256(encoded).hexdigest()
        size_bytes = len(encoded)
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

    def read_evidence(self, run: dict[str, Any], source_name: str) -> Any:
        fingerprint = (run.get("sourceFingerprints") or {}).get(source_name)
        if not fingerprint:
            fingerprint = ((run.get("dependencies") or {}).get(source_name) or {}).get("fingerprint")
        if not fingerprint:
            return None
        dependency = ((run.get("dependencies") or {}).get(source_name) or {})
        if dependency.get("fingerprint") not in {None, fingerprint}:
            return None
        with self.connect() as connection:
            row = connection.execute(
                "SELECT payload_json FROM analyst_review_evidence_v2 WHERE fingerprint = ? AND source_name = ?",
                (fingerprint, source_name),
            ).fetchone()
        return json.loads(row[0]) if row and sha256(row[0].encode("utf-8")).hexdigest() == fingerprint else None

    def read_shared_evidence(self, run: dict[str, Any], source_name: str) -> Any:
        """Read verified evidence for Sources projections, sharing parsed values.

        The stored bytes are re-hashed on every read, as in ``read_evidence``.
        Only JSON parsing is shared: the cache is keyed by the content address,
        so it stays valid across checkpoints. Callers must not mutate the value.
        """
        fingerprint = (run.get("sourceFingerprints") or {}).get(source_name)
        if not fingerprint:
            fingerprint = ((run.get("dependencies") or {}).get(source_name) or {}).get("fingerprint")
        if not fingerprint:
            return None
        dependency = ((run.get("dependencies") or {}).get(source_name) or {})
        if dependency.get("fingerprint") not in {None, fingerprint}:
            return None
        with self.connect() as connection:
            row = connection.execute(
                "SELECT payload_json FROM analyst_review_evidence_v2 WHERE fingerprint = ? AND source_name = ?",
                (fingerprint, source_name),
            ).fetchone()
        encoded = row[0].encode("utf-8") if row else None
        if encoded is None or sha256(encoded).hexdigest() != fingerprint:
            return None
        key = (str(source_name), fingerprint)
        with self._lock:
            cached = self._shared_evidence.get(key)
            if cached is not None:
                self._shared_evidence.move_to_end(key)
                return cached[0]
        value = json.loads(row[0])
        size = len(encoded)
        if size <= SHARED_EVIDENCE_MAX_ENTRY_BYTES:
            with self._lock:
                if key not in self._shared_evidence:
                    self._shared_evidence[key] = (value, size)
                    self._shared_evidence_bytes += size
                while self._shared_evidence and (
                    len(self._shared_evidence) > SHARED_EVIDENCE_MAX_ENTRIES
                    or self._shared_evidence_bytes > SHARED_EVIDENCE_MAX_BYTES
                ):
                    _evicted, (_value, evicted_size) = self._shared_evidence.popitem(last=False)
                    self._shared_evidence_bytes -= evicted_size
        return value

    def sources_projection(self, key: Any, build: Callable[[], dict[str, Any]]) -> dict[str, Any]:
        """Memoize a terminal capture's small Sources projection by its exact identity."""
        with self._lock:
            if key in self._sources_projections:
                self._sources_projections.move_to_end(key)
                return deepcopy(self._sources_projections[key])
        value = build()
        if len(canonical_json(value).encode("utf-8")) <= SOURCES_PROJECTION_MAX_BYTES:
            with self._lock:
                self._sources_projections[key] = deepcopy(value)
                self._sources_projections.move_to_end(key)
                while len(self._sources_projections) > SOURCES_PROJECTION_MAX_ENTRIES:
                    self._sources_projections.popitem(last=False)
        return value


@dataclass
class ReviewExecutionContext:
    store: ReviewRunV2Store
    run_id: str
    review_kind: str
    conversation_id: Optional[str] = None
    on_checkpoint: Optional[CheckpointHook] = None

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
        """Persist acquisition state with its content-addressed evidence.

        Evidence is stored first, then the descriptor commits once with its
        fingerprint, so Sources never sees a settled stage without evidence.
        """

        descriptor = {
            "status": status,
            "asOf": as_of,
            "fingerprint": None,
            "sizeBytes": 0,
            "errorCode": error_code,
            "detail": json_copy(detail or {}),
            "updatedAt": utc_now_iso(),
        }

        def commit() -> None:
            if evidence is not None:
                descriptor["fingerprint"], descriptor["sizeBytes"] = self.store.store_evidence(
                    source_name, evidence
                )
            self.store.commit_dependency(self.run_id, source_name, descriptor)
            if self.on_checkpoint is not None and self.conversation_id:
                _notify_checkpoint(
                    self.on_checkpoint, self.conversation_id, self.run_id, str(source_name), str(status)
                )

        await asyncio.to_thread(commit)
        return descriptor

    async def baseline(self) -> Optional[dict[str, Any]]:
        return await asyncio.to_thread(
            self.store.latest_portfolio_baseline,
            before_run_id=self.run_id,
        )

    async def publish_verified_sections(
        self, sections: list[dict[str, Any]], citations: list[dict[str, Any]], *,
        source_names: Optional[list[str]] = None, report_markdown: Optional[str] = None,
    ) -> dict[str, Any]:
        """Publish one captured partial revision without completing the review.

        Callers supply only sections supported by the named acquisition
        checkpoints. Rendering and source fingerprinting finish before the
        atomic state guard, so cancellation cannot resurrect a terminal run.
        """
        run = await asyncio.to_thread(self.store.get_source_metadata, self.run_id)
        if not run:
            raise KeyError(self.run_id)
        if run["state"] not in ACTIVE_STATES:
            raise ReviewRunError("REVIEW_IMMUTABLE", "Completed review attempts are immutable.", status_code=409)
        if not isinstance(sections, list) or not sections or any(
            not isinstance(section, dict) or not isinstance(section.get("id"), str) or not section["id"].strip()
            or section.get("status") in {"pending", "loading", "checking", "failed", "blocked"}
            for section in sections
        ):
            raise ReviewRunError("REVIEW_PROGRESS_INVALID", "Progress requires supported sections.")
        dependencies = run.get("dependencies") or {}
        selected = source_names if source_names is not None else [
            name for name, descriptor in dependencies.items()
            if descriptor.get("status") in {"ready", "partial"} and descriptor.get("fingerprint")
        ]
        if not isinstance(selected, list) or not selected or any(not isinstance(name, str) for name in selected):
            raise ReviewRunError("REVIEW_PROGRESS_UNVERIFIED", "Progress requires captured source evidence.")
        from portfolio_review import _unverified_evidence
        verification_run = {**run, "sourceFingerprints": {
            name: descriptor["fingerprint"] for name, descriptor in dependencies.items() if descriptor.get("fingerprint")
        }}
        for name in dict.fromkeys(selected):
            descriptor = dependencies.get(name) or {}
            evidence = await asyncio.to_thread(self.store.read_evidence, verification_run, name)
            if (descriptor.get("status") not in {"ready", "partial"}
                    or not descriptor.get("fingerprint") or evidence is None or _unverified_evidence(evidence)):
                raise ReviewRunError("REVIEW_PROGRESS_UNVERIFIED", "Progress source evidence could not be verified.")
        if not isinstance(citations, list):
            raise ReviewRunError("REVIEW_PROGRESS_INVALID", "Progress requires captured citations.")

        def prepare_report():
            accepted = _dedupe_citations([
                citation for citation in citations if isinstance(citation, dict)
                and isinstance(citation.get("id"), str) and 0 < len(citation["id"].strip()) <= 200
            ])
            supported = json_copy(sections)
            report = report_markdown if report_markdown is not None else render_review(self.review_kind, supported, "partial", accepted)
            if not isinstance(report, str) or not report.strip():
                raise ReviewRunError("REVIEW_PROGRESS_INVALID", "Progress requires a captured report.")
            # These renderer defaults describe a completed reconciliation. A
            # nonterminal capture cannot turn absence of an exception into an all-clear.
            report = "\n".join(line for line in report.splitlines() if line.strip() not in {
                "No issues detected.",
                "No material conflict or qualifying action-feed change was found in the complete reconciliation.",
            }).strip() + "\n"
            if self.review_kind == "portfolio-review" and not any(section.get("id") == "exposure-risk" for section in supported):
                report = "\n".join(line for line in report.splitlines() if line.strip() != "Portfolio values unavailable.").strip() + "\n"
            return supported, accepted, report

        # Partial captures use the same off-loop rendering boundary as the
        # final report. The atomic update below still owns the active-state guard.
        supported, accepted, report = await asyncio.to_thread(prepare_report)
        fingerprints = {name: descriptor["fingerprint"] for name, descriptor in dependencies.items()
                        if descriptor.get("fingerprint")}
        return await asyncio.to_thread(
            self.store.update, self.run_id, state="running", phase="acquiring", outcome="partial",
            sections=supported, citations=accepted, sourceFingerprints=fingerprints, reportMarkdown=report,
        )


ReviewHandler = Callable[[ReviewExecutionContext], Awaitable[dict[str, Any]]]
SummaryProvider = Callable[..., Union[Awaitable[str], str]]


class _PipelinePhaseLog:
    """Log the coordinator's steps after its handler returns, scalars only."""

    def __init__(self, run_id: str, review_kind: str) -> None:
        self.run_id = run_id
        self.review_kind = review_kind
        self.started = self.last = time.monotonic()

    def mark(self, phase: str) -> None:
        now = time.monotonic()
        LOGGER.info(
            "Review pipeline run=%s kind=%s phase=%s phaseMs=%s elapsedMs=%s loopLagMaxMs=%s",
            self.run_id, self.review_kind, phase, round((now - self.last) * 1000),
            round((now - self.started) * 1000), loop_lag_monitor.max_lag_ms(self.last),
        )
        self.last = now


class ReviewCoordinatorV2:
    def __init__(
        self,
        store: ReviewRunV2Store,
        handlers: dict[str, ReviewHandler],
        *,
        summary_provider: Optional[SummaryProvider] = None,
        deadlines: Optional[dict[str, int]] = None,
        unexpected_failure_hook: Optional[Callable[[str, BaseException], Any]] = None,
        on_checkpoint: Optional[CheckpointHook] = None,
    ) -> None:
        self.store = store
        self.handlers = dict(handlers)
        self.summary_provider = summary_provider
        self.deadlines = {**DEADLINE_SECONDS, **(deadlines or {})}
        self.unexpected_failure_hook = unexpected_failure_hook
        # Called as on_checkpoint(conversationId, runId, source, status) on a
        # worker thread after each stage commit; failures are logged only.
        self.on_checkpoint = on_checkpoint
        self.tasks: dict[str, asyncio.Task] = {}
        self._task_lock = asyncio.Lock()

    async def start(
        self,
        *,
        review_kind: str,
        session_id: str = "",
        conversation_id: Optional[str] = None,
        request_id: str,
        run_id: Optional[str] = None,
        guarded_create: Optional[
            Callable[[Callable[[], tuple[dict[str, Any], bool]]], tuple[dict[str, Any], bool]]
        ] = None,
    ) -> dict[str, Any]:
        if review_kind not in self.handlers:
            raise ReviewRunError(
                "REVIEW_KIND_DISABLED", "That review is not enabled.", status_code=503
            )
        def create_run():
            return self.store.create(
                review_kind=review_kind,
                session_id=session_id,
                conversation_id=conversation_id,
                request_id=request_id,
                deadline_seconds=self.deadlines[review_kind],
                run_id=run_id,
            )

        if guarded_create is None:
            run, created = await asyncio.to_thread(create_run)
        else:
            run, created = await asyncio.to_thread(guarded_create, create_run)
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
        context = ReviewExecutionContext(
            self.store, run_id, run["reviewKind"],
            conversation_id=run.get("conversationId"), on_checkpoint=self.on_checkpoint,
        )
        result = await self.handlers[run["reviewKind"]](context)
        # Continues the handler's own finalization lines up to completion.
        phases = _PipelinePhaseLog(run_id, run["reviewKind"])
        def normalize_result():
            sections = json_copy(result.get("sections") or [])
            outcome = str(result.get("outcome") or "blocked")
            if outcome not in RUN_OUTCOMES:
                raise ReviewRunError(
                    "REVIEW_RESULT_INVALID", "Review provider returned an invalid outcome."
                )
            return sections, outcome, _dedupe_citations(result.get("citations") or [])

        # Normalizing a full captured book is part of report preparation, just
        # like rendering below; it cannot consume another review's preflight.
        sections, outcome, citations = await asyncio.to_thread(normalize_result)
        phases.mark("normalize")
        await asyncio.to_thread(
            self.store.update,
            run_id,
            phase="rendering",
        )

        # Fingerprint normalized, already-persisted dependencies.  A fault
        # here cannot erase their stage checkpoints.
        persisted = await asyncio.to_thread(self.store.get_source_metadata, run_id)
        fingerprints = {
            name: descriptor.get("fingerprint")
            for name, descriptor in (persisted.get("dependencies") or {}).items()
            if descriptor.get("fingerprint")
        }
        report = await asyncio.to_thread(
            render_review, run["reviewKind"], sections, outcome, citations
        )
        phases.mark("render")
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
            phases.mark("summary")

        completed_at = utc_now_iso()
        # Publish the final capture with its terminal state.  Rendering and
        # optional summarization leave the verified partial revision intact.
        updates: dict[str, Any] = {
            "state": "succeeded",
            "phase": "terminal",
            "outcome": outcome,
            "sections": sections,
            "citations": citations,
            "sourceFingerprints": fingerprints,
            "reportMarkdown": report,
            "summaryMarkdown": summary,
            "completedAt": completed_at,
            "diagnostics": summary_diagnostic or {},
        }
        if run["reviewKind"] == "portfolio-review" and outcome == "ready":
            updates["baselineAcceptedAt"] = completed_at
        await asyncio.to_thread(self.store.update, run_id, **updates)
        phases.mark("complete")

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
        try:
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
        except ReviewRunError as exc:
            # Stop or completion may commit after the read above. Its atomic
            # terminal guard wins; cleanup cannot overwrite that capture or
            # replace the original cancellation with an immutability error.
            if exc.code != "REVIEW_IMMUTABLE":
                raise


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
                "productLabel",
                "publicationDate",
                "publishedAt",
                "sourceUri",
                "title",
                "excerpt",
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
    return {"ready": "Ready", "partial": "Partial", "blocked": "Blocked"}.get(
        outcome, "Blocked"
    )


def _find_section(sections: list[dict[str, Any]], section_id: str) -> dict[str, Any]:
    return next((row for row in sections if row.get("id") == section_id), {})


def _review_fields(*fields: tuple[str, Any]) -> list[str]:
    """One labeled fact per paragraph; values arrive from the verified sections."""
    return [
        line
        for label, value in fields
        for line in (
            f"**{label}:** {_cell(str(value) if value is not None else None)}",
            "",
        )
    ]


def _review_section(title: str) -> list[str]:
    return ["", f"## {title}", ""]


def _review_bullets(items: list, empty: str) -> list[str]:
    return [f"- {_cell(item)}" for item in items] or [empty]


def _portfolio_table(columns, rows):
    def cell(value):
        return str(value if value is not None else "—").replace("|", "\\|").replace("\n", " ")
    hidden = {index for index, column in enumerate(columns) if str(column).strip().lower() == "research list"}
    if hidden:
        columns = [column for index, column in enumerate(columns) if index not in hidden]
        rows = [[value for index, value in enumerate(row) if index not in hidden] for row in rows]
    return ["| " + " | ".join(cell(value) for value in columns) + " |",
            "| " + " | ".join("---" for _ in columns) + " |",
            *("| " + " | ".join(cell(value) for value in row) + " |" for row in rows), ""]


def _portfolio_export_rows(block):
    rows, prior_group = [], None
    for row in block.get("rows") or []:
        if block.get("groupRows") and row.get("group") != prior_group:
            prior_group = row.get("group")
            rows.append([f"**{_cell(prior_group)}**", *([""] * (len(block.get("columns") or []) - 1))])
        cells = list(row.get("cells") or [])
        for index, title in enumerate(row.get("cellTitles") or []):
            if index and index < len(cells) and title and str(cells[index]) != title:
                # Preserve source names, dates and sample statistics in portable
                # Markdown while keeping the same compact visible columns.
                escaped = html_escape(str(title), quote=True).replace("\n", "&#10;")
                cells[index] = f'<abbr title="{escaped}">{html_escape(str(cells[index]))}</abbr>'
        rows.append(cells)
    return rows


def _render_portfolio_daily_review(sections):
    """Export the same captured daily rollup used by the structured chat view."""
    review = _find_section(sections, "portfolio-research-review")
    risk = _find_section(sections, "exposure-risk")
    metrics = risk.get("metrics") or {}
    rollup = review.get("dailyRollup") or {}
    lines = ["# Portfolio Review", "", "<!-- analyst-daily-rollup -->", ""]
    if review.get("historicalHoldings"):
        lines += ["Holdings: last verified capture; current holdings unavailable.", ""]
    if metrics.get("available"):
        lines += _review_section("Exposure & risk")
        lines += _portfolio_table(["Exposure", "Value", "Weight"], [
            ["Gross", _fmt_money(metrics.get("grossExposure")), _fmt_percent(metrics.get("grossLeverage"), already_percent=False)],
            ["Long", _fmt_money(metrics.get("longMarketValue")), ""],
            ["Short", _fmt_money(metrics.get("shortMarketValue")), ""],
            ["Net", _fmt_money(metrics.get("netExposure")), _fmt_percent(metrics.get("netExposurePctOfNlv"))],
            *([["Interest", _fmt_money(metrics.get("netAccruedInterest")), ""]]
              if _finite(metrics.get("netAccruedInterest")) is not None else []),
        ])
    else:
        lines += ["Portfolio values unavailable.", ""]
    comparison = _find_section(sections, "changes-since-prior").get("comparison") or {}
    if comparison.get("status") == "available":
        pairs = comparison.get("metrics") or {}
        lines += _review_section("Since previous close")
        if comparison.get("baselineAsOf"):
            lines += [_prediction_manager_date(comparison["baselineAsOf"], include_time=True), ""]
        lines += _portfolio_table(["Exposure", "Previous close snapshot", "Current"], [
            [label, *(_fmt_money((pairs.get(key) or {}).get(period)) + " · "
                      + _fmt_percent((pairs.get(weight) or {}).get(period), already_percent=weight != "grossLeverage")
                      for period in ("previous", "current"))]
            for key, weight, label in (("grossExposure", "grossLeverage", "Gross"), ("netExposure", "netExposurePctOfNlv", "Net"))
        ] + ([["Interest", *(_fmt_money((pairs.get("netAccruedInterest") or {}).get(period)) for period in ("previous", "current"))]]
             if pairs.get("netAccruedInterest") else []))
    factors = risk.get("factorExposure") or {}
    if factors.get("rows"):
        lines += _review_section(factors.get("label") or "Asset exposure")
        lines += _portfolio_table(["Exposure", "Long", "Short", "Net"], [
            [row.get("label"), *(_fmt_percent(row.get(key)) for key in ("longPct", "shortPct", "netPct"))]
            for row in factors["rows"]
        ])
        if factors.get("status") == "partial":
            lines += [f"{_fmt_percent(factors.get('coveragePct'))} of verified gross exposure classified", ""]
    citations = {row["id"]: row for row in rollup.get("citations", []) if row.get("id")}
    for section in rollup.get("sections") or []:
        lines += _review_section(section.get("title") or "Research")
        if section.get("status") == "pending" and not section.get("blocks"):
            # A paused source keeps its section's place with a compact state.
            lines += ["Pending.", ""]
        for block in section.get("blocks") or []:
            if block.get("type") == "paragraph" and block.get("text"):
                lines += [block["text"], ""]
            elif block.get("type") == "table":
                if block.get("title"):
                    lines += [f"**{_cell(block['title'])}**", ""]
                if block.get("disclosure"):
                    lines += ["<details>", f"<summary>{_cell(block['disclosure'])}</summary>", ""]
                lines += _portfolio_table(block.get("columns") or [], _portfolio_export_rows(block))
                if block.get("disclosure"):
                    lines += ["</details>", ""]
        sources = []
        for source_id in dict.fromkeys(section.get("citationIds") or []):
            source = citations.get(source_id) or {}
            label = str(source.get("product") or "Source").replace("-", " ").title()
            url = source.get("sourceUri") or ""
            if re.fullmatch(r"/api/research/hedgai/source/[a-zA-Z0-9-]+", url):
                url = os.environ.get("MARKET_DASHBOARD_API_BASE", "http://127.0.0.1:3001").rstrip("/") + url
            sources.append(f"[{label}]({url})" if re.match(r"^https?://", url) else label)
        if sources:
            lines += [" · ".join(dict.fromkeys(sources)), ""]
    if not any(section.get("status") != "pending" for section in rollup.get("sections") or []):
        lines += ["Daily research unavailable.", ""]
    return "\n".join(lines).strip() + "\n"


def render_portfolio_review(sections: list[dict[str, Any]], outcome: str) -> str:
    if _find_section(sections, "portfolio-research-review").get("dailyRollup") is not None:
        return _render_portfolio_daily_review(sections)
    snapshot = _find_section(sections, "executive-snapshot")
    risk = _find_section(sections, "exposure-risk")
    conflicts = _find_section(sections, "conflicts-changes")
    context = _find_section(sections, "market-macro-context")
    changed = _find_section(sections, "changes-since-prior")
    quality = _find_section(sections, "coverage-data-quality")
    metrics = snapshot.get("metrics") or risk.get("metrics") or {}
    pnl = str(snapshot.get("pnlSummary") or "Unavailable")
    pnl_parts = [
        re.fullmatch(r"(Daily|Unrealized) (\$[\d,.-]+)", part)
        for part in pnl.split(" / ")
    ]
    pnl_fields = (
        [(f"{part[1]} P&L", part[2]) for part in pnl_parts]
        if all(pnl_parts)
        else [("P&L", pnl)]
    )
    lines = ["# Portfolio Review", "", _status_line(outcome), ""]
    research_review = _find_section(sections, "portfolio-research-review")
    if research_review.get("reviewedAt"):
        lines += _review_fields(("Research reviewed", research_review["reviewedAt"]))
    if research_review.get("historicalHoldings"):
        lines += ["Historical holdings reference. Current holdings could not be verified.", ""]
    lines += _review_fields(
        ("Observed", metrics.get("observedAt")),
        ("Net liquidation", _fmt_money(metrics.get("netLiquidation"))),
        *pnl_fields,
        (
            "Position marks",
            f"{metrics.get('valuedCount', 0)} of {metrics.get('positionCount', 0)} verified",
        ),
    )
    lines += _review_section("Exposure & risk")
    lines += _review_fields(
        ("Long market value", _fmt_money(metrics.get("longMarketValue"))),
        ("Short market value", _fmt_money(metrics.get("shortMarketValue"))),
        ("Gross exposure", _fmt_money(metrics.get("grossExposure"))),
        (
            "Gross leverage",
            "Unavailable"
            if _finite(metrics.get("grossLeverage")) is None
            else f"{_fmt_number(metrics.get('grossLeverage'), 3)}×",
        ),
        (
            "Gross exposure as % of NLV",
            _fmt_percent(metrics.get("grossLeverage"), already_percent=False),
        ),
        ("Net exposure", _fmt_money(metrics.get("netExposure"))),
        ("Net exposure as % of NLV", _fmt_percent(metrics.get("netExposurePctOfNlv"))),
    )
    concentrations = (
        risk.get("concentrations") or metrics.get("topConcentrations") or []
    )
    if concentrations:
        lines += _review_section("Largest concentrations")
        for row in concentrations[:10]:
            lines += [f"### {_cell(row.get('symbol'))}", ""]
            lines += _review_fields(
                ("Market value", _fmt_money(row.get("marketValue"))),
                ("Gross weight", _fmt_percent(row.get("grossWeightPct"))),
                ("Mark", row.get("markState")),
            )
    lines += _review_section("Conflicts & lifecycle changes")
    conflict_rows = conflicts.get("conflicts") or []
    action_rows = conflicts.get("unheldActionChanges") or []
    if not conflict_rows and not action_rows and conflicts.get("status") == "ready":
        lines.append(
            "No material conflict or qualifying action-feed change was found in the complete reconciliation."
        )
    for row in conflict_rows:
        lines += [f"### {_cell(row.get('holding'))}", ""]
        lines += _review_fields(
            ("State", row.get("state")),
            ("Conflict", row.get("conflict")),
            ("Process action", row.get("processResponse")),
        )
        citations = ", ".join(
            c["id"] for c in row.get("citations") or [] if c.get("id")
        )
        if citations:
            lines += _review_fields(("Sources", citations))
    for row in action_rows:
        citations = ", ".join(
            c["id"] for c in row.get("citations") or [] if c.get("id")
        )
        suffix = f" ({citations})" if citations else ""
        lines.append(
            f"- **{_cell(row.get('symbol'))}:** {_cell(row.get('change'))}{suffix}"
        )
    lines += _review_section("Market & macro context")
    facts = context.get("facts") or []
    lines += _review_bullets(
        [row.get("text") if isinstance(row, dict) else row for row in facts],
        "No complete, cited portfolio context was available for this run.",
    )
    lines += _review_section("Changes since prior review")
    if changed.get("status") == "no_baseline":
        lines.append("No accepted Portfolio Review baseline exists yet.")
    elif changed.get("changes"):
        for row in changed["changes"]:
            lines.append(
                f"- **{_cell(row.get('field'))}:** {_cell(row.get('before'))} → {_cell(row.get('after'))}"
            )
    else:
        lines.append(
            "No change was found in the fields tracked against the latest accepted baseline."
        )
    lines += _review_section("Coverage & data quality")
    exceptions = list(
        dict.fromkeys(
            [
                *list(quality.get("exceptions") or []),
                *list(risk.get("exceptions") or []),
            ]
        )
    )
    lines += _review_bullets(
        exceptions, "All required live portfolio and reconciliation checks passed."
    )
    gaps = conflicts.get("coverageGaps") or []
    if gaps:
        lines.append(f"- Research coverage needs attention for {len(gaps)} securities.")
    return "\n".join(lines).strip() + "\n"


_PREDICTION_DIAGNOSTIC = re.compile(
    r"\b(?:HTTP(?:S|Error|StatusError)?|[A-Za-z]*(?:ConnectionError|ConnectError|ConnectTimeout|ReadTimeout|TimeoutError|JSONDecodeError)|"
    r"ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|Traceback|stack trace|Unsupported Media Type|"
    r"Internal Server Error|Bad Gateway|Service Unavailable|Gateway Timeout|"
    r"fetch failed|failed to fetch|API (?:session|request|error|failure)|IB Gateway)\b"
    r"|\b(?:client|server) error\s*['\"(: ]*\d{3}\b"
    r"|\b[45]\d{2}\s+(?:Client Error|Server Error|Bad Request|Unauthorized|Forbidden|Not Found|Method Not Allowed)\b"
    r"|\b(?:httpx|requests|urllib3|aiohttp)\."
    r"|\b(?:localhost|127\.0\.0\.1)(?::\d+)?\b"
    r"|(?:^|\n)\s*File [\"'].+?[\"'], line \d+",
    re.I,
)
_PREDICTION_DIAGNOSTIC_URL = re.compile(
    r"https?://(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?(?:[/?#]|$)"
    r"|https?://[^\s/<>]+/(?:internal|api/(?:analyst|prediction-markets|portfolio|ibkr))(?:[/?#]|$)"
    r"|https?://developer\.mozilla\.org/[^\s<>)]*/Web/HTTP/(?:Reference/)?Status/\d{3}\b"
    r"|https?://(?:www\.)?httpstatuses\.(?:com|io)/\d{3}\b"
    r"|https?://(?:www\.)?python-httpx\.org/exceptions(?:[/?#]|$)",
    re.I,
)


def _prediction_report_value(value: Any) -> Any:
    """Hide provider diagnostics only at rendering; retain the source evidence."""
    text = str(value) if value is not None else ""
    if _PREDICTION_DIAGNOSTIC_URL.search(text):
        return "Missing data"
    # Citation URLs remain intact. HTTP protocol wording and exception traces
    # identify diagnostic prose; an ordinary linked source is not an error.
    inspected = re.sub(r"https?://[^\s)<>]+", "", text)
    return "Missing data" if _PREDICTION_DIAGNOSTIC.search(inspected) else value


def _prediction_report_items(items: list, empty: str) -> list[str]:
    values = list(dict.fromkeys(_cell(_prediction_report_value(item)) for item in items))
    return ["Missing data" if value == "Missing data" else f"- {value}" for value in values] or [empty]


def _prediction_manager_text(value: Any) -> str:
    if value is None or not str(value).strip():
        return "—"
    cleaned = _prediction_report_value(value)
    if cleaned == "Missing data" or str(cleaned).strip().lower() in {"unavailable", "withheld", "unknown"}:
        return "—"
    return _cell(cleaned)


def _prediction_manager_number(value: Any, decimals: int = 2) -> str:
    number = None if isinstance(value, bool) else _finite(value)
    return "—" if number is None else f"{number:,.{decimals}f}".rstrip("0").rstrip(".")


def _prediction_manager_date(value: Any, *, include_time: bool = False) -> str:
    if not isinstance(value, str):
        return "—"
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return "—"
    timed = "T" in value and parsed.tzinfo is not None
    if timed:
        # A shown clock uses Pacific time and its Pacific date; a date alone
        # keeps the instant's exchange (Eastern) publication or session day.
        parsed = parsed.astimezone(ZoneInfo("America/Los_Angeles" if include_time else "America/New_York"))
    text = f"{parsed.strftime('%b')} {parsed.day}, {parsed.year}"
    return f"{text} {parsed:%H:%M %Z}" if include_time and timed else text


def _prediction_manager_signal(value: Any) -> str:
    signal = value if isinstance(value, dict) else {}
    direction = {"BULLISH": "Bullish", "BEARISH": "Bearish", "NEUTRAL": "Neutral"}.get(signal.get("direction"))
    if not direction:
        return "—"
    parts = [direction]
    instrument = _prediction_manager_text(signal.get("instrument"))
    if instrument != "—":
        parts.append(instrument + (" (proxy)" if signal.get("fit") in {"proxy", "proxy_context", "strong_proxy", "related_only"} else ""))
    published = _prediction_manager_date(signal.get("publishedAt"))
    if published != "—":
        parts.append(published)
    source_url = str(signal.get("sourceUrl") or "")
    if re.fullmatch(r"https://app\.hedgeye\.com/feed_items/\d+/?", source_url):
        parts.append(f"[Source]({source_url})")
    return " · ".join(parts)


def _prediction_manager_dates_in_text(value: Any, *, include_time: bool = False) -> str:
    text = _prediction_manager_text(value)
    text = re.sub(r"\b\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2}))?",
                  lambda match: _prediction_manager_date(match.group(), include_time=include_time), text)
    def month(match):
        try:
            return datetime.strptime(match.group(), "%Y-%m").strftime("%b %Y")
        except ValueError:
            return "—"
    return re.sub(r"\b\d{4}-\d{2}\b", month, text)


def _prediction_manager_level_cells(value: Any) -> list[str]:
    level = value if isinstance(value, dict) else {}
    threshold = _prediction_manager_number(level.get("threshold"))
    comparator = {">": "Above", "gt": "Above", "above": "Above", "greater_than": "Above",
                  "<": "Below", "lt": "Below", "below": "Below", "less_than": "Below",
                  ">=": "At or above", "<=": "At or below"}.get(level.get("directionalComparator") or level.get("comparator"))
    side = level.get("side")
    if threshold == "—" or not comparator or side not in {"YES", "NO"}:
        return ["—"] * 5
    cells = [f"{comparator} {threshold}", side, "—", "—", "—"]
    ask = None if isinstance(level.get("ask"), bool) else _finite(level.get("ask"))
    if ask is not None and 0 <= ask <= 1:
        cells[2] = f"{_prediction_manager_number(ask * 100)}¢"
        implied = _prediction_manager_number(level.get("marketImpliedPct"))
        payoff = _prediction_manager_number(level.get("grossPayoffRatio"))
        if implied != "—":
            cells[3] = f"{implied}%"
        if payoff != "—":
            cells[4] = f"{payoff}:1"
    return cells


def _prediction_manager_contract_table(view: dict) -> list[str]:
    contracts = view.get("contracts") or {}
    comparisons = contracts.get("comparisons")
    if not isinstance(comparisons, list) or not comparisons:
        comparisons = [
            {**contracts[key], "label": label} for key, label in (
                ("near", "Strike near last close" if contracts.get("referenceState") == "LAST CLOSE" else "Current strike"),
                ("next", "Next strike"),
            ) if isinstance(contracts.get(key), dict) and contracts[key]
        ]
    rows = []
    direction = view.get("direction") or {}
    for index, level in enumerate(comparisons):
        if not isinstance(level, dict):
            continue
        label = re.sub(r"\s*·\s*(?:YES|NO)$", "", _prediction_manager_text(level.get("label"))).replace("\\|", "|")
        cells = _prediction_manager_level_cells(level)
        if index == 0 and cells[0] != "—" and direction.get("basis") == "Trend":
            direction_label = {"BULLISH": "Bullish", "BEARISH": "Bearish"}.get(direction.get("value"))
            if direction_label:
                cells[0] = f"{direction_label} Trend · {cells[0]}"
        rows.append([label, *cells])
    return _portfolio_table(
        ["Level", "Outcome", "Side", "Price", "Market-implied odds", "Gross reward/risk (before fees)"], rows,
    ) if rows else []


def _prediction_manager_contract_context(row: dict, view: dict) -> list[tuple[str, str]]:
    contracts = view.get("contracts") or {}
    parts = [_prediction_manager_text(row.get("venue")),
             _prediction_manager_text(contracts.get("settlementLabel") or contracts.get("settlementSource"))]
    parts = [value for value in parts if value != "—"]
    closes = _prediction_manager_date(contracts.get("closesAt"), include_time=True)
    fields = [("Trading closes", " · ".join([closes, *parts]))] if parts or closes != "—" else []
    expires = _prediction_manager_date(contracts.get("expiresAt"), include_time=True)
    if expires != "—" and expires != closes:
        fields.append(("Expiration", expires))
    return fields


def _prediction_research_table_lines(block):
    """Keep captured research values readable without an additional table."""
    def text(value):
        return str(value).replace("\n", " ").strip() if value is not None and str(value).strip() else "—"

    columns = [text(column) for column in block.get("columns") or []]
    headings = [column.lower() for column in columns]
    lines = []
    for row in block.get("rows") or []:
        if not isinstance(row, dict) or not row.get("cells"):
            continue
        cells = [text(value) for value in row["cells"]]
        cells += ["—"] * max(0, len(columns) - len(cells))
        used = {0, *(index for index, heading in enumerate(headings) if heading == "research list")}
        parts = [cells[0]]
        if headings[:2] == ["ticker", "security"]:
            parts = [" · ".join(value for value in cells[:2] if value != "—") or "—"]
            used.add(1)
        for before, after, label in (("prior trend", "trend", "Trend"),
                                     ("prior range", "published range", "Range"),
                                     ("previous", "current", "")):
            if before in headings and after in headings:
                left, right = headings.index(before), headings.index(after)
                transition = f"{cells[left]} → {cells[right]}"
                if label:
                    parts.append(f"{label}: {transition}")
                else:
                    parts[0] += f": {transition}"
                used.update((left, right))
        if len(cells) == len(headings) == 2 and used == {0} and headings[1] in {"published reading", "reading", "value", "versus prior publication"}:
            parts[0] += f": {cells[1]}"
            used.add(1)
        for index, value in enumerate(cells):
            if index not in used:
                label = columns[index] if index < len(columns) else f"Value {index + 1}"
                parts.append(f"{label}: {value}")
        lines.append(" · ".join(parts) + "  ")
    return [*lines, ""] if lines else []


def _prediction_volume_clock(text, citation_ids, citations):
    """Show a saved intraday SPY volume clock in Pacific from its own captured instant."""
    match = re.match(r"Through (\d{2}:\d{2}) ET,", text)
    if not match:
        return text
    for source_id in citation_ids or []:
        source = citations.get(source_id) or {}
        if source.get("product") != "spy-volume-(etf-proxy)":
            continue
        try:
            observed = datetime.fromisoformat(str(source.get("observedAt")).replace("Z", "+00:00"))
        except ValueError:
            return text
        # Convert only when the stored clock is exactly this capture's instant;
        # anything else stays as recorded rather than being relabeled.
        if observed.tzinfo is None or f"{observed.astimezone(ZoneInfo('America/New_York')):%H:%M}" != match[1]:
            return text
        return f"Through {observed.astimezone(ZoneInfo('America/Los_Angeles')):%H:%M %Z}," + text[match.end():]
    return text


def _prediction_research_lines(research, citations, manager_view=None):
    """Use only the research captured with this report, with local evidence links."""
    from prediction_research_rollup import prediction_research_section_excluded

    lines = []
    for section in research.get("sections") or []:
        if not isinstance(section, dict):
            continue
        if prediction_research_section_excluded(section):
            continue
        body = []
        for block in section.get("blocks") or []:
            if not isinstance(block, dict):
                continue
            if block.get("type") == "paragraph" and block.get("text"):
                body += [_prediction_volume_clock(str(block["text"]), block.get("citationIds"), citations), ""]
            elif block.get("type") == "structure-summary":
                from prediction_structure_review import spx_structure_interpretation

                for paragraph in spx_structure_interpretation(manager_view or {}, block.get("signals") or {}):
                    body += [paragraph, ""]
            elif block.get("type") == "table" and block.get("columns") and block.get("rows"):
                if section.get("id") == "market-structure" and block.get("columns") == ["Signal", "Reading", "As of"]:
                    body += _portfolio_table(block["columns"], [row["cells"] for row in block["rows"] if row.get("cells")])
                else:
                    body += _prediction_research_table_lines(block)
        if not body:
            continue
        lines += [f"#### {section.get('title') or 'Research'}", "", *body]
        sources = []
        for source_id in dict.fromkeys(section.get("citationIds") or []):
            source = citations.get(source_id) or {}
            if not source:
                continue
            label = str(source.get("productLabel") or source.get("product") or "Source").replace("-", " ").title()
            sources.append(f"[{label}](citation://{source_id})")
        if sources:
            lines += ["Sources: " + ", ".join(sources), ""]
    return lines


def _prediction_alpha_codes(row, citations):
    """Show cited, dated publication levels independently of current signals."""
    from decimal import Decimal

    research = row.get("research") if isinstance(row.get("research"), dict) else {}
    alpha = research.get("alphaCode") if isinstance(research.get("alphaCode"), dict) else {}
    published = alpha.get("publicationDate")
    if (alpha.get("marketId") != row.get("marketId") or not isinstance(alpha.get("instrument"), str)
            or not alpha["instrument"].strip() or not isinstance(published, str)
            or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", published)):
        return "—"
    date_label = _prediction_manager_date(published)
    if date_label == "—":
        return "—"
    links = []
    seen = set()
    source_ids = alpha.get("citationIds")
    if not isinstance(source_ids, list):
        return "—"
    for source_id in source_ids:
        if not isinstance(source_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]+", source_id) or source_id in seen:
            continue
        source = citations.get(source_id)
        if not isinstance(source, dict):
            continue
        label = re.sub(r"[^A-Za-z0-9 &/.,'-]", "", str(source.get("productLabel") or source.get("product") or "Source"))
        label = label.replace("-", " ").strip().title() or "Source"
        links.append(f"[{label}](citation://{source_id})")
        seen.add(source_id)
    if not links:
        return "—"

    def level(value):
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return "—"
        number = Decimal(str(value))
        if not number.is_finite() or number <= 0:
            return "—"
        formatted = format(number, ",f")
        if "." in formatted:
            formatted = formatted.rstrip("0").rstrip(".")
        return ("≈" if alpha.get("approximate") is True else "") + formatted

    trade, trend = level(alpha.get("tradeLevel")), level(alpha.get("trendLevel"))
    if "—" in (trade, trend):
        return "—"
    return f"Trade {trade} · Trend {trend} · {date_label} · Sources: " + ", ".join(links)


def render_prediction_review(sections: list[dict[str, Any]], outcome: str, citations=None) -> str:
    """Render verified manager facts; retain operational detail only in sections."""
    board = _find_section(sections, "setup-board").get("board")
    if isinstance(board, dict):
        from prediction_setup_board import render_setup_board
        return render_setup_board(board)
    # Captures before the setup board keep their original layout.
    from hedgai_review import prediction_hedgai_text, prediction_hedgai_comparison
    markets = _find_section(sections, "monitored-markets").get("markets") or []
    sources = {row["id"]: row for row in citations or [] if isinstance(row, dict) and row.get("id")}
    lines = ["<!-- analyst-prediction-research-rollup -->", ""] if any((row.get("research") or {}).get("sections") for row in markets) else []

    def venue_group(row):
        venue = str(row.get("venue") or row.get("requestedVenue") or "").lower()
        return "forecastex" if venue in {"forecastex", "interactive brokers"} else "kalshi" if venue == "kalshi" else ""

    # Historical captures keep their recorded venue and roster. Only the
    # presentation order changes; no quote or research is reacquired here.
    ordered = [row for venue in ("forecastex", "kalshi", "") for row in markets if venue_group(row) == venue]
    previous_venue = None
    for row in ordered:
        venue = venue_group(row)
        if venue != previous_venue:
            if venue:
                lines += [f"## {'Interactive Brokers' if venue == 'forecastex' else 'Kalshi'}", ""]
            previous_venue = venue
        view = row.get("managerView") if isinstance(row.get("managerView"), dict) else {}
        if view.get("version") != 1:
            view = {}
        lines += [f"### {_prediction_manager_text(row.get('asset'))}", ""]
        if row.get("marketId") == "cpi":
            recorded = dict(row.get("fields") or [])
            fields = [(label, _prediction_manager_dates_in_text(recorded.get(label), include_time=label == "CPI release"))
                      for label in ("Hedgeye nowcast", "Cleveland Fed nowcast", "Previous CPI release", "CPI release")
                      if label in recorded or label in {"Hedgeye nowcast", "Cleveland Fed nowcast"}]
            fields.append(("Alpha codes", _prediction_alpha_codes(row, sources)))
            lines += [f"**{label}:** {value}  " for label, value in fields]
            lines.append("")
            if (view.get("contracts") or {}).get("comparisons"):
                lines += _prediction_manager_contract_table(view)
                lines += [f"**{label}:** {value}  " for label, value in _prediction_manager_contract_context(row, view)]
                lines.append("")
            lines += _prediction_research_lines(row.get("research") or {}, sources, view)
            continue
        hedgai = (row.get("research") or {}).get("hedgai") or {}
        hedgai_text, hedgai_comparison = prediction_hedgai_text(hedgai, view)
        fields = [("Tick", hedgai_text)] if hedgai_text else []
        fields += [("Trade", _prediction_manager_signal(view.get("trade"))),
                  ("Trend", _prediction_manager_signal(view.get("trend")))]
        underlying = view.get("underlying") or {}
        risk_range = view.get("riskRange") or {}
        contracts = view.get("contracts") or {}
        if any(view.get(key) for key in ("trade", "trend", "underlying", "riskRange")) or contracts.get("near") or contracts.get("next") or contracts.get("comparisons"):
            price = _prediction_manager_number(underlying.get("value"))
            if price != "—":
                label = re.sub(r"\s+LAST CLOSE$", "", _prediction_manager_text(underlying.get("label")), flags=re.I)
                price = f"{label} {price}" if label != "—" else price
                if underlying.get("fit") == "proxy":
                    price += " (proxy)"
                if underlying.get("state") == "LAST CLOSE":
                    date = _prediction_manager_date(underlying.get("sessionDate") or underlying.get("asOf"))
                    price += " · Last close" + (f" {date}" if date != "—" else "")
            fields.append(("Underlying", price))
            low, high = (_prediction_manager_number(risk_range.get(key)) for key in ("low", "high"))
            bounds = f"{low}–{high}" if low != "—" and high != "—" else "—"
            if bounds != "—":
                instrument = _prediction_manager_text(risk_range.get("instrument"))
                if instrument != "—":
                    bounds += f" · {instrument}"
                if risk_range.get("fit") in {"proxy", "proxy_context", "strong_proxy", "related_only"}:
                    bounds += " (proxy)"
                published = _prediction_manager_date(risk_range.get("publishedAt"))
                if published != "—":
                    bounds += f" · {published}"
            fields.append(("Risk Range", bounds))
            fields.append(("Alpha codes", _prediction_alpha_codes(row, sources)))
            reward_risk = risk_range.get("rewardRisk") or {}
            ratio = _prediction_manager_number(reward_risk.get("ratio"))
            if ratio != "—":
                direction = {"BULLISH": "Bullish", "BEARISH": "Bearish"}.get(reward_risk.get("direction"))
                basis = re.sub(r"\s+LAST CLOSE$", "", _prediction_manager_text(reward_risk.get("basisLabel")), flags=re.I)
                basis_price = _prediction_manager_number(reward_risk.get("referenceValue"))
                if basis != "—" and basis_price != "—":
                    basis += f" {basis_price}"
                comparison = ([basis] if basis != "—" else []) + ([direction] if direction else []) + [f"{ratio}:1"]
                for key, label in (("rewardPct", "reward"), ("riskPct", "risk")):
                    percent = _prediction_manager_number(reward_risk.get(key))
                    if percent != "—":
                        comparison.append(f"{label} {percent}%")
                if reward_risk.get("state") == "LAST CLOSE":
                    comparison.append("Last close " + _prediction_manager_date(reward_risk.get("asOf")))
                fields.append(("Underlying reward/risk", " · ".join(comparison)))
        if not any(label == "Alpha codes" for label, _value in fields):
            fields.append(("Alpha codes", _prediction_alpha_codes(row, sources)))
        lines += [f"**{label}:** {value}  " for label, value in fields]
        lines.append("")
        if hedgai_comparison:
            lines += [hedgai_comparison, ""]
        hedgai_ids = [cid for cid in hedgai.get("citationIds") or [] if cid in sources]
        if hedgai_ids:
            lines += ["Sources: " + ", ".join(f"[HedgAI Signals](citation://{cid})" for cid in hedgai_ids), ""]
        contract_table = _prediction_manager_contract_table(view)
        if contract_table:
            lines += contract_table
            lines += [f"**{label}:** {value}  " for label, value in _prediction_manager_contract_context(row, view)]
            lines.append("")
        lines += _prediction_research_lines(row.get("research") or {}, sources, view)
    hedgai_comparison = prediction_hedgai_comparison(ordered)
    if hedgai_comparison["rows"]:
        lines += ['<details data-analyst-hedgai>', f"<summary>{hedgai_comparison['title']}</summary>", ""]
        lines += _portfolio_table(hedgai_comparison["columns"], hedgai_comparison["rows"])
        ids = [cid for cid in hedgai_comparison["citationIds"] if cid in sources]
        if ids:
            lines += ["Sources: " + ", ".join(f"[HedgAI Signals](citation://{cid})" for cid in ids), ""]
        lines += ["</details>", ""]
    return "\n".join(lines).strip() + "\n"


def render_balance_review(sections: list[dict[str, Any]], outcome: str) -> str:
    summary = _find_section(sections, "account-summary")
    capacity = _find_section(sections, "margin-capacity")
    interest = _find_section(sections, "interest-ledger")
    exceptions = _find_section(sections, "exceptions")
    current = summary.get("current") or {}
    exposure, margin = current.get("exposure") or {}, current.get("margin") or {}
    cash, settlement = current.get("cash") or {}, current.get("settlement") or {}
    activity, buffer = current.get("activity") or {}, current.get("buffer") or {}
    portfolio_metrics = capacity.get("portfolioMetrics") or {}
    gross_percent = _finite(exposure.get("grossPercent"))
    leverage = (
        "Unavailable"
        if gross_percent is None
        else f"{_fmt_number(gross_percent / 100, 3)}×"
    )
    lines = [
        "# Balance Review",
        "",
        f"{_status_line(outcome)} · {_cell(current.get('currency'))}",
        "",
    ]
    lines += _review_fields(
        ("Account", current.get("accountId")),
        ("Observed", current.get("observedAt")),
        (
            "Net liquidation",
            _fmt_money(
                margin.get("netLiquidation")
                if margin.get("netLiquidation") is not None
                else exposure.get("netLiquidation")
            ),
        ),
        ("Available funds", _fmt_money(margin.get("availableFunds"))),
        ("Buying power", _fmt_money(margin.get("buyingPower"))),
        ("Excess liquidity", _fmt_money(margin.get("excessLiquidity"))),
        ("Margin health", margin.get("health")),
    )
    lines += _review_section("Cash & funding")
    lines += _review_fields(
        ("Securities cash floor", _fmt_money(cash.get("securitiesCashFloor"))),
        ("Commodity cash floor", _fmt_money(cash.get("commodityCashFloor"))),
        ("Borrowing balance", _fmt_money(buffer.get("borrowedAmount"))),
        ("Liquidity buffer", _fmt_money(buffer.get("liquidBuffer"))),
        ("Add-long room", _fmt_money(cash.get("addLongRoom"))),
        ("Trim requirement", _fmt_money(cash.get("trimRequired"))),
        ("Policy buffer", _fmt_money(buffer.get("totalReserve"))),
        ("Buffered room", _fmt_money(buffer.get("addLongRoom"))),
    )
    lines += _review_section("Exposure & settlement")
    lines += _review_fields(
        ("Long market value", _fmt_money(exposure.get("longMarketValue"))),
        ("Short market value", _fmt_money(exposure.get("shortMarketValue"))),
        ("Gross exposure", _fmt_money(exposure.get("grossMarketValue"))),
        ("Net exposure", _fmt_money(exposure.get("netMarketValue"))),
        ("Gross leverage", leverage),
        ("Settlement date", settlement.get("date")),
        ("Settlement status", settlement.get("state")),
        ("Open orders", _fmt_number(activity.get("openOrderCount"), 0)),
        ("Same-day executions", _fmt_number(activity.get("sameDayExecutionCount"), 0)),
        (
            "Independent position cross-check",
            "verified" if portfolio_metrics.get("available") else "unavailable",
        ),
    )
    status, history = (
        interest.get("interestStatus") or {},
        interest.get("history") or {},
    )
    mtd, forecast = status.get("mtd") or {}, status.get("forecast") or {}
    latest, stock_borrow = (
        status.get("latest") or {},
        status.get("stockBorrowFees") or {},
    )
    postings = history.get("postings") or []
    posting = postings[-1] if postings else {}
    posting_date = (
        posting.get("posted_date") or posting.get("postedDate") or posting.get("date")
    )
    posting_value = (
        posting.get("amount")
        if posting.get("amount") is not None
        else posting.get("debitAmount")
        if posting.get("debitAmount") is not None
        else posting.get("value")
    )
    lines += _review_section("Interest, forecasts & postings")
    lines += _review_fields(
        ("MTD net accrued", _fmt_money(mtd.get("liveNetAccrued"))),
        ("Verified debit", _fmt_money(mtd.get("verifiedDebit"))),
        ("Interest observed", status.get("generatedAt") or history.get("generatedAt")),
        ("Forecast status", forecast.get("status")),
        ("Forecast lower bound", _fmt_money(forecast.get("lower"))),
        ("Forecast estimate", _fmt_money(forecast.get("point"))),
        ("Forecast upper bound", _fmt_money(forecast.get("upper"))),
        ("Latest actual", _fmt_money(latest.get("actual"))),
        ("Residual", _fmt_money(latest.get("residual"))),
        ("Forecast rows", str(len(history.get("forecasts") or []))),
        ("Daily actual rows", str(len(history.get("daily") or []))),
        ("Postings", str(len(postings))),
        ("Latest posting date", posting_date),
        ("Latest posting amount", _fmt_money(posting_value)),
        ("Stock-borrow status", stock_borrow.get("status")),
    )
    lines += _review_section("Exceptions & Data Status")
    items = list(
        dict.fromkeys(
            [
                *list(exceptions.get("items") or []),
                *[
                    reason
                    for section in sections
                    for reason in section.get("exceptions") or []
                    if isinstance(reason, str)
                ],
            ]
        )
    )
    lines += _review_bullets(
        items,
        "No issues detected.",
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
    if review_kind == "prediction-markets-review":
        return renderer(sections, outcome, _citations)
    # Render each review's compact body once without duplicating its context.
    lines = [renderer(sections, outcome)]
    prediction = review_kind == "prediction-markets-review"
    def display(value: Any) -> str:
        return _cell(_prediction_report_value(value) if prediction else value)
    recommendations = _find_section(sections, "process-recommendations")
    if recommendations:
        lines += _review_section("Process recommendations")
    for market in (recommendations.get("analysis") or {}).get("markets", []):
        lines += [f"### {display(market.get('label'))}", ""]
        lines += _review_fields(("Status", _prediction_report_value(market.get("status")) if prediction else market.get("status")))
        lines += [f"- {display(reason)}" for reason in market.get("reasons") or []]
        for candidate in market.get("candidates") or []:
            size = candidate.get("sizing") or {}
            lines += ["", f"### {display(candidate.get('contractId'))}", ""]
            lines += _review_fields(
                ("Side", _prediction_report_value(candidate.get("side")) if prediction else candidate.get("side")),
                ("Native price", _prediction_report_value(candidate.get("nativePrice")) if prediction else candidate.get("nativePrice")),
            )
            if size.get("allowed"):
                lines += _review_fields(
                    ("Maximum contracts", str(size.get("contracts"))),
                    (
                        "Combined setup maximum loss",
                        _fmt_money(size.get("combinedLoss")),
                    ),
                )
            else:
                lines += ["- Sizing withheld.", ""]
    if recommendations.get("error"):
        lines.append("Missing data" if review_kind == "prediction-markets-review" else f"- {_cell(recommendations['error'])}")
    return "\n".join(lines).strip() + "\n"


def attach_prediction_reports(conversation, store):
    """Re-render workspace report posts from their own saved capture only."""
    if conversation.get("kind") != "prediction-markets-review" or not conversation.get("id"):
        return conversation
    messages = conversation.get("messages") or []
    projected = None
    runs = {}
    for index, message in enumerate(messages):
        if (not isinstance(message, dict) or message.get("role") != "assistant"
                or not message.get("reviewRunId") or message.get("reviewNarrative")
                or message.get("reviewUnchanged")
                or message.get("state") in {"failed", "cancelled", "error"}
                or message.get("reviewState") in {"failed", "cancelled", "error"}):
            continue
        run_id = message["reviewRunId"]
        if run_id not in runs:
            runs[run_id] = store.get(run_id)
        run = runs[run_id]
        if (not run or run.get("conversationId") != conversation["id"]
                or run.get("reviewKind") != "prediction-markets-review" or run.get("state") != "succeeded"
                or not _find_section(run.get("sections") or [], "monitored-markets").get("markets")):
            continue
        report = _saved_review_markdown(run)
        from prediction_research_rollup import ALIASES, PRODUCTS

        citations = list(run.get("citations") or [])
        citation_ids = {citation.get("id") for citation in citations if isinstance(citation, dict)}
        for citation in message.get("citations") or []:
            if not isinstance(citation, dict) or citation.get("id") in citation_ids:
                continue
            product = citation.get("product")
            if ALIASES.get(product, product) not in PRODUCTS:
                citations.append(citation)
                citation_ids.add(citation.get("id"))
        if report and (report != message.get("text") or citations != (message.get("citations") or [])):
            if projected is None:
                projected = list(messages)
            projected[index] = {**message, "text": report, "citations": citations}
    return {**conversation, "messages": projected} if projected is not None else conversation


def _saved_review_markdown(run):
    if run.get("state") in ACTIVE_STATES:
        # A progress digest identifies the exact persisted supported report.
        # Legacy presentation upgrades belong to terminal captures only.
        return run.get("reportMarkdown")
    if run.get("reviewKind") == "prediction-markets-review" and (
            _find_section(run.get("sections") or [], "monitored-markets").get("markets")
            or _find_section(run.get("sections") or [], "setup-board").get("board")):
        return render_prediction_review(run["sections"], run.get("outcome") or "partial", run.get("citations") or [])
    if run.get("reviewKind") == "portfolio-review":
        rollup = _find_section(run.get("sections") or [], "portfolio-research-review").get("dailyRollup") or {}
        if any((section.get("id") == "hedgai-signals" and (section.get("metadata") or {}).get("presentationCatalog"))
               or section.get("id") in {"position-confirmations", "position-contradictions"}
               for section in rollup.get("sections") or []):
            return render_portfolio_review(run["sections"], run.get("outcome") or "partial")
    return run.get("reportMarkdown")


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
        "reportMarkdown": _saved_review_markdown(run),
        "reportAvailable": bool(run.get("reportAvailable") or str(run.get("reportMarkdown") or "").strip()),
        "reportRevision": run.get("reportRevision") or (run.get("updatedAt") if str(run.get("reportMarkdown") or "").strip() else None),
        "summaryMarkdown": run.get("summaryMarkdown"),
        "error": error,
        "retryable": bool(error and error.get("retryable")),
    }
    if run.get("reviewKind") == "prediction-markets-review":
        setup_rows = (_find_section(run.get("sections") or [], "setup-board").get("board") or {}).get("rows") or []
        board = _find_section(run.get("sections") or [], "monitored-markets")
        output["marketIds"] = [
            row["id"] for row in setup_rows if isinstance(row, dict) and isinstance(row.get("id"), str)
        ] or [
            row["marketId"] for row in board.get("markets") or []
            if isinstance(row, dict) and isinstance(row.get("marketId"), str)
            and row["marketId"].strip()
        ]
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
        "reportAvailable": bool(run.get("reportAvailable") or str(run.get("reportMarkdown") or "").strip()),
        "reportRevision": run.get("reportRevision") or (run.get("updatedAt") if str(run.get("reportMarkdown") or "").strip() else None),
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
                    "text": _saved_review_markdown(run)
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


def _portfolio_refresh_context(section: dict[str, Any], *, limit: int = 12) -> dict[str, Any]:
    """Keep captured refresh conclusions useful without copying source bodies."""
    report = section.get("report") or {}
    holdings = [row for row in report.get("holdings") or [] if isinstance(row, dict)]
    priorities = {"realignment": 0, "watch": 1, "unavailable": 2, "aligned": 3}
    selected = sorted(holdings, key=lambda row: priorities.get(row.get("classification"), 2))[:limit]
    rows = []
    for row in selected:
        item = {
            key: _bounded_text(row.get(key), 240)
            for key in ("ticker", "security", "heldSide", "classification", "proposedAction", "reviewAction", "publishedAt")
            if row.get(key) is not None
        }
        item["citationIds"] = [_bounded_text(value, 50) for value in (row.get("citationIds") or [])[:4]]
        item["evidence"] = [
            {key: _bounded_text(evidence.get(key), 200)
             for key in ("kind", "product", "date", "reading", "direction", "effect")
             if evidence.get(key) is not None}
            for evidence in (row.get("evidence") or [])[:2] if isinstance(evidence, dict)
        ]
        rows.append(item)
    return {
        "id": "portfolio-refresh", "title": "Portfolio Refresh", "status": section.get("status"),
        "templateVersion": report.get("templateVersion"), "asOf": report.get("asOf"),
        "complete": report.get("complete") is True, "positionCount": report.get("positionCount"),
        "checkedTickers": [_bounded_text(row.get("ticker"), 40) for row in holdings[:100]],
        "holdings": rows, "omittedHoldings": max(0, len(holdings) - len(rows)),
        "productCoverage": [
            {key: _bounded_text(row.get(key), 100) for key in ("id", "status", "currentStatus", "currentPublicationDate")
             if row.get(key) is not None}
            for row in (report.get("productCoverage") or [])[:40] if isinstance(row, dict)
        ],
    }


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
    refresh_citation_ids = {cid for section in run.get("sections") or [] if isinstance(section, dict) and section.get("id") == "portfolio-refresh"
                            for row in (section.get("report") or {}).get("holdings") or [] if isinstance(row, dict)
                            for cid in row.get("citationIds") or []}
    source_citations = sorted([row for row in run.get("citations") or [] if isinstance(row, dict) and row.get("id")],
                              key=lambda row: row.get("id") not in refresh_citation_ids)
    citations = [
        {
            key: _bounded_text(row.get(key), 2_000 if key == "sourceUri" else 200)
            for key in ("id", "documentId", "product", "publicationDate", "publishedAt", "title", "sourceUri", "contentHash")
            if row.get(key) is not None
        }
        for row in source_citations[:100]
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
            _portfolio_refresh_context(row) if row.get("id") == "portfolio-refresh" else _review_context_value(row)
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
            _portfolio_refresh_context(row, limit=8) if row.get("id") == "portfolio-refresh" else {
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
        refresh_ids = {cid for row in context["sections"] if row.get("id") == "portfolio-refresh"
                       for holding in row.get("holdings") or [] for cid in holding.get("citationIds") or []}
        context["citations"] = [row for row in citations if row.get("id") in refresh_ids][:12]
        context["optionalNarrative"] = None
    if len(canonical_json(context).encode("utf-8")) > MAX_REVIEW_CONTEXT_BYTES:
        context["sections"] = [
            _portfolio_refresh_context(row, limit=4) if row.get("id") == "portfolio-refresh" else {
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
