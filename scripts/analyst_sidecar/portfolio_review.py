"""Persistent, deterministic Portfolio Review runs.

This module deliberately owns review state outside Hermes chat history.  It
never manufactures current trading values: portfolio arithmetic is permitted
only for a verified live portfolio envelope and every output keeps the mark
state that authorized the arithmetic.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from hashlib import sha256
from functools import lru_cache
import json
from math import isclose
from pathlib import Path
import re
import sqlite3
import threading
from typing import Any, Iterable, Optional
from uuid import UUID, uuid4
from urllib.parse import urlsplit


SCHEMA_VERSION = 1
MAX_PACKET_BYTES = 30_000
PACKET_PAYLOAD_BUDGET = 22_000
SECTION_STATES = frozenset({"pending", "loading", "ready", "partial", "blocked", "failed"})
TERMINAL_RUN_STATES = frozenset({"ready", "partial", "blocked", "failed"})
VALUED_MARK_STATES = frozenset({"live", "settled", "resolver"})
ACCOUNT_EXPOSURE_MAX_CAPTURE_GAP_SECONDS = 300

SECTION_SPECS = (
    ("conflicts-changes", "Conflicts & Changes"),
    ("market-situation", "Market Situation"),
    ("macro-overlay", "Macro Overlay"),
    ("portfolio-overlay", "Portfolio Overlay"),
    ("alpha-codes", "Alpha Codes"),
    ("what-changed", "What Changed"),
    ("risk-snapshot", "Risk Snapshot"),
    ("coverage-data-quality", "Coverage & Data Quality"),
)

MACRO_TOPICS = (
    "usd",
    "fx",
    "rates",
    "growth_inflation_quad",
    "equities_credit_volatility",
    "commodities",
    "crypto",
)


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str)


def canonical_fingerprint(value: Any) -> str:
    return sha256(_canonical_json(value).encode("utf-8")).hexdigest()


def _json_copy(value: Any) -> Any:
    return json.loads(json.dumps(value, ensure_ascii=False, default=str))


def _valid_uuid(value: str) -> str:
    return str(UUID(str(value)))


def section_descriptors(state: str = "pending") -> list[dict[str, Any]]:
    if state not in SECTION_STATES:
        raise ValueError(f"Unsupported Portfolio Review section state: {state}")
    return [
        {
            "sectionId": section_id,
            "title": title,
            "order": index,
            "status": state,
            "reasonCode": "AWAITING_ACQUISITION" if state == "pending" else None,
            "retryable": False,
            "sourceTimestamps": [],
            "evidenceCount": 0,
            "result": None,
        }
        for index, (section_id, title) in enumerate(SECTION_SPECS)
    ]


def set_section(
    sections: list[dict[str, Any]],
    section_id: str,
    *,
    status: str,
    reason_code: Optional[str] = None,
    retryable: bool = False,
    source_timestamps: Optional[Iterable[Any]] = None,
    evidence_count: int = 0,
    result: Any = None,
) -> list[dict[str, Any]]:
    if status not in SECTION_STATES:
        raise ValueError(f"Unsupported Portfolio Review section state: {status}")
    found = False
    output = []
    for descriptor in sections:
        if descriptor.get("sectionId") != section_id:
            output.append(dict(descriptor))
            continue
        found = True
        timestamps = sorted({str(value) for value in (source_timestamps or []) if value})
        output.append({
            **descriptor,
            "status": status,
            "reasonCode": reason_code,
            "retryable": bool(retryable),
            "sourceTimestamps": timestamps,
            "evidenceCount": max(0, int(evidence_count or 0)),
            "result": _json_copy(result),
        })
    if not found:
        raise KeyError(f"Unknown Portfolio Review section: {section_id}")
    return output


def overall_status(sections: Iterable[dict[str, Any]]) -> str:
    states = [str(section.get("status") or "pending") for section in sections]
    if any(state in {"pending", "loading"} for state in states):
        return "running"
    if states and all(state == "failed" for state in states):
        return "failed"
    if any(state == "blocked" for state in states):
        return "blocked"
    if any(state in {"partial", "failed"} for state in states):
        return "partial"
    return "ready"


class PortfolioReviewStore:
    """SQLite store for immutable completed runs and accepted baselines."""

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
                CREATE TABLE IF NOT EXISTS portfolio_review_runs (
                    run_id TEXT PRIMARY KEY,
                    schema_version INTEGER NOT NULL,
                    session_id TEXT NOT NULL,
                    request_id TEXT NOT NULL,
                    attempt INTEGER NOT NULL,
                    previous_run_id TEXT,
                    account_key TEXT,
                    status TEXT NOT NULL,
                    sections_json TEXT NOT NULL,
                    source_fingerprints_json TEXT NOT NULL,
                    packets_json TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    completed_at TEXT,
                    accepted_at TEXT,
                    error TEXT,
                    error_code TEXT,
                    UNIQUE(session_id, request_id)
                );
                CREATE INDEX IF NOT EXISTS portfolio_review_session_updated
                    ON portfolio_review_runs(session_id, updated_at DESC);
                CREATE INDEX IF NOT EXISTS portfolio_review_account_accepted
                    ON portfolio_review_runs(account_key, accepted_at DESC);
                """
            )
            columns = {
                str(row[1])
                for row in connection.execute("PRAGMA table_info(portfolio_review_runs)").fetchall()
            }
            if "error_code" not in columns:
                connection.execute("ALTER TABLE portfolio_review_runs ADD COLUMN error_code TEXT")

    @staticmethod
    def _decode(row: sqlite3.Row | None) -> Optional[dict[str, Any]]:
        if row is None:
            return None
        value = dict(row)
        value["schemaVersion"] = value.pop("schema_version")
        value["runId"] = value.pop("run_id")
        value["sessionId"] = value.pop("session_id")
        value["requestId"] = value.pop("request_id")
        value["previousRunId"] = value.pop("previous_run_id")
        value["accountKey"] = value.pop("account_key")
        value["createdAt"] = value.pop("created_at")
        value["updatedAt"] = value.pop("updated_at")
        value["completedAt"] = value.pop("completed_at")
        value["acceptedAt"] = value.pop("accepted_at")
        value["errorCode"] = value.pop("error_code", None)
        value["sections"] = json.loads(value.pop("sections_json") or "[]")
        value["sourceFingerprints"] = json.loads(value.pop("source_fingerprints_json") or "{}")
        value["packets"] = json.loads(value.pop("packets_json") or "[]")
        return value

    def create(
        self,
        *,
        session_id: str,
        request_id: str,
        run_id: Optional[str] = None,
    ) -> tuple[dict[str, Any], bool]:
        clean_session = str(session_id or "").strip()
        clean_request = str(request_id or "").strip()
        if not clean_session or not clean_request:
            raise ValueError("Portfolio Review requires sessionId and requestId.")
        if len(clean_session) > 200 or len(clean_request) > 200:
            raise ValueError("Portfolio Review identifiers are too long.")
        clean_run = _valid_uuid(run_id) if run_id else str(uuid4())
        created_at = utc_now_iso()
        with self._lock, self.connect() as connection:
            existing = connection.execute(
                "SELECT * FROM portfolio_review_runs WHERE session_id = ? AND request_id = ?",
                (clean_session, clean_request),
            ).fetchone()
            if existing:
                return self._decode(existing), False
            latest = connection.execute(
                "SELECT run_id, attempt FROM portfolio_review_runs WHERE session_id = ? ORDER BY created_at DESC LIMIT 1",
                (clean_session,),
            ).fetchone()
            attempt = int(latest["attempt"] if latest else 0) + 1
            previous_run_id = latest["run_id"] if latest else None
            connection.execute(
                """
                INSERT INTO portfolio_review_runs (
                    run_id, schema_version, session_id, request_id, attempt,
                    previous_run_id, status, sections_json,
                    source_fingerprints_json, packets_json, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, 'starting', ?, '{}', '[]', ?, ?)
                """,
                (
                    clean_run,
                    SCHEMA_VERSION,
                    clean_session,
                    clean_request,
                    attempt,
                    previous_run_id,
                    _canonical_json(section_descriptors()),
                    created_at,
                    created_at,
                ),
            )
            row = connection.execute(
                "SELECT * FROM portfolio_review_runs WHERE run_id = ?",
                (clean_run,),
            ).fetchone()
        return self._decode(row), True

    def get(self, run_id: str) -> Optional[dict[str, Any]]:
        with self.connect() as connection:
            row = connection.execute(
                "SELECT * FROM portfolio_review_runs WHERE run_id = ?",
                (str(run_id),),
            ).fetchone()
        return self._decode(row)

    def latest_for_session(self, session_id: str) -> Optional[dict[str, Any]]:
        with self.connect() as connection:
            row = connection.execute(
                "SELECT * FROM portfolio_review_runs WHERE session_id = ? ORDER BY created_at DESC LIMIT 1",
                (str(session_id),),
            ).fetchone()
        return self._decode(row)

    def accepted_baseline(self, account_key: str, *, before_run_id: Optional[str] = None) -> Optional[dict[str, Any]]:
        params: list[Any] = [str(account_key)]
        clause = ""
        if before_run_id:
            clause = " AND run_id <> ?"
            params.append(str(before_run_id))
        with self.connect() as connection:
            row = connection.execute(
                f"""
                SELECT * FROM portfolio_review_runs
                WHERE account_key = ? AND accepted_at IS NOT NULL{clause}
                ORDER BY accepted_at DESC LIMIT 1
                """,
                params,
            ).fetchone()
        return self._decode(row)

    def update(
        self,
        run_id: str,
        *,
        status: Optional[str] = None,
        sections: Optional[list[dict[str, Any]]] = None,
        source_fingerprints: Optional[dict[str, str]] = None,
        packets: Optional[list[dict[str, Any]]] = None,
        account_key: Optional[str] = None,
        error: Optional[str] = None,
        error_code: Optional[str] = None,
        completed: bool = False,
    ) -> dict[str, Any]:
        with self._lock, self.connect() as connection:
            existing_row = connection.execute(
                "SELECT * FROM portfolio_review_runs WHERE run_id = ?",
                (str(run_id),),
            ).fetchone()
            existing = self._decode(existing_row)
            if not existing:
                raise KeyError("Portfolio Review run was not found.")
            if existing.get("completedAt"):
                # Completed evidence is immutable. Acceptance is the sole later mutation.
                return existing
            next_sections = sections if sections is not None else existing["sections"]
            next_status = status or overall_status(next_sections)
            updated_at = utc_now_iso()
            completed_at = updated_at if completed else None
            connection.execute(
                """
                UPDATE portfolio_review_runs SET
                    status = ?, sections_json = ?, source_fingerprints_json = ?,
                    packets_json = ?, account_key = COALESCE(?, account_key),
                    error = ?, error_code = ?, updated_at = ?, completed_at = ?
                WHERE run_id = ?
                """,
                (
                    next_status,
                    _canonical_json(next_sections),
                    _canonical_json(source_fingerprints if source_fingerprints is not None else existing["sourceFingerprints"]),
                    _canonical_json(packets if packets is not None else existing["packets"]),
                    account_key,
                    error,
                    error_code,
                    updated_at,
                    completed_at,
                    str(run_id),
                ),
            )
            row = connection.execute(
                "SELECT * FROM portfolio_review_runs WHERE run_id = ?",
                (str(run_id),),
            ).fetchone()
        return self._decode(row)

    def accept(self, run_id: str) -> dict[str, Any]:
        with self._lock, self.connect() as connection:
            row = connection.execute(
                "SELECT * FROM portfolio_review_runs WHERE run_id = ?",
                (str(run_id),),
            ).fetchone()
            run = self._decode(row)
            if not run:
                raise KeyError("Portfolio Review run was not found.")
            if run["status"] not in {"ready", "partial"} or not run.get("completedAt"):
                raise ValueError("Only a completed ready or partial Portfolio Review can be accepted.")
            accepted_at = run.get("acceptedAt") or utc_now_iso()
            connection.execute(
                "UPDATE portfolio_review_runs SET accepted_at = ? WHERE run_id = ?",
                (accepted_at, str(run_id)),
            )
            row = connection.execute(
                "SELECT * FROM portfolio_review_runs WHERE run_id = ?",
                (str(run_id),),
            ).fetchone()
        return self._decode(row)


def _unverified_evidence(value: Any) -> bool:
    if not isinstance(value, dict):
        return True
    if any(value.get(flag) is True for flag in (
        "stale", "cacheOnly", "cachedOnly", "cached", "fromCache", "from_cache",
        "mock", "isMock", "seed", "seeded", "isSeeded", "fixture", "synthetic",
        "inferred", "fallback", "refreshFailed", "offline", "disconnected",
    )) or any(value.get(flag) is False for flag in ("connected", "liveVerified", "verifiedAtCapture")):
        return True
    for field in ("status", "freshness", "source", "provider", "provenance"):
        state = str(value.get(field) or "").lower()
        if state in {"stale", "cached", "cache_only", "cache-only", "offline", "disconnected", "error", "failed", "unavailable"} or any(
            token in state for token in ("mock", "seeded", "fixture", "cached_disconnected")
        ):
            return True
    return any(_unverified_evidence(value[key]) for key in ("metadata", "provenance") if isinstance(value.get(key), dict))


def decode_position_table(portfolio: dict[str, Any]) -> tuple[list[dict[str, Any]], Optional[str]]:
    if portfolio.get("liveVerified") is not True or portfolio.get("freshness") != "live" or _unverified_evidence(portfolio):
        return [], "PORTFOLIO_NOT_LIVE_VERIFIED"
    table = (portfolio.get("data") or {}).get("positionTable") or {}
    columns = table.get("columns") if isinstance(table, dict) else None
    rows = table.get("rows") if isinstance(table, dict) else None
    if not isinstance(columns, list) or not isinstance(rows, list):
        return [], "POSITION_TABLE_MISSING"
    if int(table.get("rowCount", -1)) != len(rows):
        return [], "POSITION_ROW_COUNT_MISMATCH"
    decoded = []
    for row in rows:
        if not isinstance(row, list) or len(row) != len(columns):
            return [], "POSITION_ROW_SHAPE_MISMATCH"
        decoded.append(dict(zip(columns, row)))
    return decoded, None


def _number(value: Any) -> Optional[float]:
    if isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if number != number or number in {float("inf"), float("-inf")}:
        return None
    return number


def _account_summary_value(portfolio: dict[str, Any], field: str) -> Optional[float]:
    rows = (portfolio.get("data") or {}).get("accountSummaries") or []
    for row in rows if isinstance(rows, list) else []:
        if not isinstance(row, dict):
            continue
        summary = row.get("summary") if isinstance(row.get("summary"), dict) else row
        candidate = summary.get(field)
        if isinstance(candidate, dict):
            candidate = candidate.get("value")
        number = _number(candidate)
        if number is not None:
            return number
    return None


def _capture_time(value: Any) -> Optional[datetime]:
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return parsed if parsed.tzinfo else None
    except (TypeError, ValueError):
        return None


def _broker_account_exposure(portfolio: dict[str, Any], positions: list, balance: Any) -> Optional[dict[str, Any]]:
    """Accept the same capture's broker accounting totals, never a quote mark.

    Freshness is checked relative to the immutable portfolio capture so opening
    an old review cannot substitute today's balance or invalidate its history.
    """
    if (_unverified_evidence(balance) or balance.get("liveVerified") is not True
            or balance.get("freshness") not in {"live", "live_with_dated_verified_history"}
            or balance.get("status") not in {"available", "partial"}):
        return None
    current = (balance.get("data") or {}).get("current")
    if (_unverified_evidence(current) or current.get("available") is not True
            or current.get("status") != "live" or current.get("source") != "ibkr_live_session"
            or current.get("fromCache") is not False
            or (current.get("freshness") or {}).get("status") != "fresh"):
        return None
    exposure = current.get("exposure")
    if (_unverified_evidence(exposure) or exposure.get("available") is not True
            or exposure.get("status") != "live" or exposure.get("source") != "ibkr_live_session"):
        return None
    source_data = portfolio.get("data") or {}
    summaries = source_data.get("accountSummaries") or []
    account_ids = {str(row.get("account")) for row in positions + summaries if isinstance(row, dict) and row.get("account")}
    account_ids.update(str(account) for account in source_data.get("accounts") or [] if account)
    account_id = str(current.get("accountId") or "").strip()
    if not account_id or account_ids != {account_id}:
        return None
    currency = str(current.get("currency") or "").upper()
    if not re.fullmatch(r"[A-Z]{3}", currency) or exposure.get("currency") != currency:
        return None
    for row in summaries:
        summary = row.get("summary") if isinstance(row.get("summary"), dict) else row
        if summary.get("currency") and str(summary["currency"]).upper() != currency:
            return None
    captured = _capture_time(portfolio.get("asOf"))
    observed = _capture_time(current.get("observedAt"))
    if captured is None or observed is None or _capture_time(balance.get("asOf")) != observed:
        return None
    for field in ("observedAt", "socketVerifiedAt", "accountValuesObservedAt"):
        timestamp = _capture_time(current.get(field))
        if (timestamp is None
                or abs((timestamp - captured).total_seconds()) > ACCOUNT_EXPOSURE_MAX_CAPTURE_GAP_SECONDS
                or not -30 <= (observed - timestamp).total_seconds() <= 45):
            return None
    values = {key: _number(exposure.get(key)) for key in (
        "netLiquidation", "longMarketValue", "shortMarketValue", "grossMarketValue", "netMarketValue",
    )}
    if (any(value is None for value in values.values()) or values["netLiquidation"] <= 0
            or any(values[key] < 0 for key in ("longMarketValue", "shortMarketValue", "grossMarketValue"))
            or not isclose(values["longMarketValue"] + values["shortMarketValue"], values["grossMarketValue"], abs_tol=.01)
            or not isclose(values["longMarketValue"] - values["shortMarketValue"], values["netMarketValue"], abs_tol=.01)):
        return None
    # IBKR AccruedCash-S from the same verified observation: month-to-date net
    # accrued interest (negative is a debit). Never estimated from balances.
    cash = current.get("cash") if isinstance(current.get("cash"), dict) else {}
    return {**values, "accountId": account_id, "currency": currency, "observedAt": current["observedAt"],
            "scope": current.get("positionScope"), "netAccruedInterest": _number(cash.get("netAccruedInterest"))}


def portfolio_metrics(portfolio: dict[str, Any], balance: Optional[dict[str, Any]] = None) -> dict[str, Any]:
    positions, error = decode_position_table(portfolio)
    if error:
        return {"available": False, "reasonCode": error, "positions": []}

    valued = []
    unavailable = []
    for position in positions:
        mark_state = str(position.get("markState") or "unavailable")
        market_value = _number(position.get("marketValue"))
        if mark_state not in VALUED_MARK_STATES or market_value is None or _unverified_evidence(position):
            unavailable.append({
                "symbol": position.get("symbol"),
                "markState": mark_state,
                "reason": position.get("unavailableReason") or "valuation_unavailable",
            })
            continue
        valued.append({**position, "marketValue": market_value})

    valuation_complete = len(unavailable) == 0
    long_value = sum(max(0.0, row["marketValue"]) for row in valued) if valuation_complete else None
    short_value = sum(min(0.0, row["marketValue"]) for row in valued) if valuation_complete else None
    gross = long_value + abs(short_value) if valuation_complete else None
    net = long_value + short_value if valuation_complete else None
    nlv = _account_summary_value(portfolio, "NetLiquidation")
    accounting = _broker_account_exposure(portfolio, positions, balance)
    if accounting:
        long_value, short_value = accounting["longMarketValue"], -accounting["shortMarketValue"]
        gross, net, nlv = accounting["grossMarketValue"], accounting["netMarketValue"], accounting["netLiquidation"]
    concentrations = sorted(
        (
            {
                "symbol": row.get("symbol"),
                "marketValue": row["marketValue"],
                "grossWeightPct": abs(row["marketValue"]) / gross * 100 if gross else None,
                "markState": row.get("markState"),
            }
            for row in valued
        ),
        key=lambda row: abs(row["marketValue"]),
        reverse=True,
    )
    pnl_rows = (portfolio.get("data") or {}).get("pnl") or []
    pnl_available = isinstance(pnl_rows, list) and len(pnl_rows) > 0
    account_keys = sorted({str(row.get("account") or "") for row in positions if row.get("account")})
    return {
        "available": True,
        "observedAt": portfolio.get("asOf"),
        "accountIds": account_keys,
        "accountKey": sha256("|".join(account_keys).encode("utf-8")).hexdigest() if account_keys else None,
        "positionCount": len(positions),
        "valuedCount": len(valued),
        "unavailableCount": len(unavailable),
        "valuationComplete": valuation_complete,
        "exposureComplete": accounting is not None or valuation_complete,
        "exposureBasis": "broker_account" if accounting else "position_marks" if valuation_complete else None,
        "exposureObservedAt": accounting["observedAt"] if accounting else portfolio.get("asOf") if valuation_complete else None,
        "exposureScope": accounting["scope"] if accounting else None,
        "exposureProvenance": {"source": "ibkr_live_session", "verifiedAtCapture": True,
                               "fromCache": False, "accountId": accounting["accountId"],
                               "currency": accounting["currency"], "observedAt": accounting["observedAt"]} if accounting else None,
        "currency": accounting["currency"] if accounting else None,
        "longMarketValue": long_value,
        "shortMarketValue": short_value,
        "grossExposure": gross,
        "netExposure": net,
        "netLiquidation": nlv,
        "netAccruedInterest": accounting.get("netAccruedInterest") if accounting else None,
        "accountSummaryAvailable": nlv is not None,
        "grossLeverage": gross / nlv if gross is not None and nlv not in {None, 0} else None,
        "netExposurePctOfNlv": net / nlv * 100 if net is not None and nlv not in {None, 0} else None,
        "topConcentrations": concentrations[:10],
        "pnlAvailable": pnl_available,
        "pnl": pnl_rows if pnl_available else [],
        "unavailableMarks": unavailable,
        "positions": positions,
    }


def _bias(value: Any) -> Optional[str]:
    candidate = str(value or "").strip().upper()
    aliases = {
        "POSITIVE": "BULLISH",
        "LONG": "BULLISH",
        "NEGATIVE": "BEARISH",
        "SHORT": "BEARISH",
        "FLAT": "NEUTRAL",
    }
    candidate = aliases.get(candidate, candidate)
    return candidate if candidate in {"BULLISH", "BEARISH", "NEUTRAL"} else None


def _field_value(field: Any) -> Optional[str]:
    if isinstance(field, dict):
        return _bias(field.get("value"))
    return _bias(field)


def _holding_side(position: dict[str, Any]) -> Optional[str]:
    quantity = _number(position.get("quantity"))
    if quantity is None or quantity == 0:
        return None
    return "LONG" if quantity > 0 else "SHORT"


def _aligned(side: str, direction: str) -> bool:
    return (side == "LONG" and direction == "BULLISH") or (side == "SHORT" and direction == "BEARISH")


def _reference_bias(reference: dict[str, Any], field: str) -> Optional[str]:
    if field == "trade" and str(reference.get("kind") or "") not in {"trade_signal", "tracker_trade"}:
        return None
    if field == "trend" and str(reference.get("kind") or "") not in {
        "primary_risk_range", "historical_risk_range",
    }:
        return None
    value = reference.get("value")
    if field == "trend" and isinstance(value, dict):
        value = value.get("trend")
    return _bias(value) or _bias(reference.get("direction"))


def _verified_prior_bias(security: dict[str, Any], field: str) -> Optional[str]:
    """Return the newest exact historical typed signal, never current prose."""
    for dated in security.get("history") or []:
        if not isinstance(dated, dict):
            continue
        references = [
            row for row in dated.get("directReferences") or []
            if isinstance(row, dict)
            and str(row.get("qualityStatus") or "") in {"indexed", "validated"}
            and str(row.get("matchType") or "") in {"direct", "direct_alias"}
        ]
        references.sort(
            key=lambda row: str(row.get("publishedAt") or row.get("marketDate") or ""),
            reverse=True,
        )
        for reference in references:
            selected = _reference_bias(reference, field)
            if selected:
                return selected
    return None


def _typed_reference_citation(reference: dict[str, Any]) -> Optional[dict[str, Any]]:
    product = str(reference.get("productId") or "").strip()
    publication_date = str(reference.get("marketDate") or "").strip()
    source_uri = str(
        reference.get("sourceUrl")
        or f"dynamodb://ResearchEntityEventsV1/{reference.get('sourceEventId') or reference.get('id') or ''}"
    ).strip()
    if not product or not publication_date or not source_uri:
        return None
    document_digest = sha256(_canonical_json([
        product,
        publication_date,
        source_uri,
    ]).encode("utf-8")).hexdigest()[:32]
    citation_digest = sha256(_canonical_json([
        document_digest,
        reference.get("sourceEventId"),
        reference.get("id"),
        reference.get("excerpt"),
    ]).encode("utf-8")).hexdigest()[:32]
    return {
        "id": f"cite_{citation_digest}",
        "documentId": f"doc_{document_digest}",
        "product": product,
        "publicationDate": publication_date,
        "sourceUri": source_uri,
        "title": reference.get("productLabel") or product,
        "excerpt": reference.get("excerpt"),
    }


@lru_cache(maxsize=1)
def _trade_instrument_aliases():
    """Reuse exact instrument identities; exposure/proxy mappings do not apply."""
    try:
        catalog = json.loads((Path(__file__).resolve().parents[2] / "src/constants/dashboardResearchCatalog.json").read_text())
        return {alias.upper(): row["symbol"] for row in catalog for alias in row.get("aliases", [])}
    except (OSError, ValueError, KeyError, TypeError):
        return {}


def published_trade_display(security, symbol, as_of):
    """Dated captured research for display, separate from current rule inputs."""
    decision = security.get("decision") or {}
    current = decision.get("trade") or {}
    if current.get("status") == "conflict":
        return None
    aliases = _trade_instrument_aliases()
    for descriptor in (current, (security.get("lastVerifiedDecision") or {}).get("trade") or {}):
        proof = descriptor.get("signalProvenance") or {}
        historical = descriptor.get("status") in {"historical", "reference"}
        if descriptor.get("status") != "available" and not historical:
            continue
        if historical and (descriptor.get("referenceOnly") is not True or descriptor.get("executable") is not False
                           or descriptor.get("currentDecisionEligible") is not False):
            continue
        source_ticker = str(descriptor.get("sourceTicker") or descriptor.get("ticker") or "").upper()
        if not source_ticker or aliases.get(source_ticker, source_ticker) != aliases.get(symbol.upper(), symbol.upper()):
            continue
        if descriptor.get("value") not in {"BULLISH", "BEARISH", "NEUTRAL"} or descriptor.get("qualityStatus") not in {"indexed", "validated"}:
            continue
        if proof.get("field") != "trade" or proof.get("method") not in {"explicit-field", "explicit-statement"} or not all(isinstance(proof.get(key), str) and proof[key].strip() for key in ("sourceField", "sourceText")):
            continue
        if proof["method"] == "explicit-field" and not re.search(r"(?:^|\.)(?:trade|tradeSignal|tradeBias)$", proof["sourceField"], re.I):
            continue
        if proof["method"] == "explicit-statement" and (re.search(r'\b(?:if|unless|could|would|should|may|might|will|expect|forecast|previously|historically|prior|not|never)\b|[?"“”]', proof["sourceText"], re.I)
                or not re.search(r"\b(?:BULLISH|BEARISH|NEUTRAL) (?:on )?TRADE\b|\bTRADE(?: signal)?(?:(?: is| remains|:)\s*|\s+)(?:BULLISH|BEARISH|NEUTRAL)\b", proof["sourceText"], re.I)):
            continue
        if any(descriptor.get(flag) is True for flag in ("stale", "fromCache", "cacheOnly", "offline", "disconnected", "mock", "seed", "seeded", "synthetic", "inferred")) or descriptor.get("verified") is False:
            continue
        date = str(descriptor.get("sourceDate") or "")
        try:
            if datetime.strptime(date, "%Y-%m-%d").strftime("%Y-%m-%d") != date or date > str(as_of or "")[:10]:
                continue
            url = urlsplit(descriptor.get("sourceUrl") or "")
            if url.scheme != "https" or url.netloc != "app.hedgeye.com" or not re.fullmatch(r"/feed_items/\d+/?", url.path):
                continue
        except (ValueError, TypeError):
            continue
        citation = _typed_reference_citation({"productId": descriptor.get("sourceId"), "productLabel": descriptor.get("sourceLabel"),
            "marketDate": date, "sourceUrl": descriptor.get("sourceUrl"), "sourceEventId": descriptor.get("sourceEventId"), "excerpt": proof["sourceText"]})
        if citation:
            return {"status": "historical" if historical else "published", "value": descriptor["value"],
                "sourceTicker": source_ticker, "signalProvenance": proof, "referenceOnly": True, "executable": False,
                "currentDecisionEligible": False, "source": {"publishedAt": descriptor.get("publishedAt") or date, "citation": citation}}
    return None


def reconcile_positions(metrics: dict[str, Any], intelligence: dict[str, Any]) -> dict[str, Any]:
    positions = metrics.get("positions") if metrics.get("available") else []
    by_symbol = intelligence.get("bySymbol") if isinstance(intelligence, dict) else {}
    by_symbol = by_symbol if isinstance(by_symbol, dict) else {}
    outcomes = []
    conflicts = []
    for position in positions:
        if position.get("category") == "event_contract":
            continue
        symbol = str(position.get("symbol") or "").strip().upper()
        side = _holding_side(position)
        if not symbol or not side:
            continue
        security = by_symbol.get(symbol)
        if not isinstance(security, dict):
            outcomes.append({
                "holding": symbol,
                "heldSide": side,
                "status": "incomplete",
                "reasonCode": "SECURITY_INTELLIGENCE_MISSING",
            })
            continue
        decision = security.get("decision") if isinstance(security.get("decision"), dict) else {}
        trade = decision.get("trade") if isinstance(decision.get("trade"), dict) else {}
        trend = decision.get("trend") if isinstance(decision.get("trend"), dict) else {}
        trade_value = _field_value(trade)
        trend_value = _field_value(trend)
        displayed_trade = published_trade_display(security, symbol, intelligence.get("marketDate") or metrics.get("observedAt"))
        process_response = "ALIGNED — no lifecycle exception"
        conflict = None
        reason_code = "RECONCILED"
        if trade.get("status") != "available" or not trade_value:
            process_response = "ACTION BLOCKED — Trade unavailable"
            conflict = "Authoritative Trade unavailable"
            reason_code = "TRADE_UNAVAILABLE"
        elif not _aligned(side, trade_value):
            process_response = "EXIT — target zero"
            conflict = f"{trade_value} Trade opposes held {side.lower()}"
            reason_code = "TRADE_BREAK"
        elif trend.get("status") != "available" or not trend_value:
            process_response = "ACTION BLOCKED — Trend unavailable"
            conflict = "Authoritative Trend unavailable"
            reason_code = "TREND_UNAVAILABLE"
        elif not _aligned(side, trend_value):
            process_response = "BENCH — cap at MIN"
            conflict = f"{trend_value} Trend opposes held {side.lower()}"
            reason_code = "TREND_BREAK"

        direct = security.get("directReferences") if isinstance(security.get("directReferences"), list) else []
        source_dates = sorted({str(row.get("marketDate")) for row in direct if isinstance(row, dict) and row.get("marketDate")})
        decision_sources = {
            str(row.get("sourceId") or "")
            for row in (trade, trend)
            if isinstance(row, dict) and row.get("sourceId")
        }
        citations = [
            citation
            for citation in (
                _typed_reference_citation(reference)
                for reference in direct
                if isinstance(reference, dict)
                and reference.get("productId") in decision_sources
            )
            if citation
        ]
        outcome = {
            "holding": symbol,
            "heldSide": side,
            "matchedResearchEntity": security.get("canonicalSymbol") or symbol,
            "matchRule": "exact_or_approved_alias",
            "products": sorted(source_id for source_id in decision_sources if source_id),
            "status": "conflict" if conflict else "aligned",
            "reasonCode": reason_code,
            "trade": trade_value,
            "researchSignals": {"trade": displayed_trade} if displayed_trade else {},
            "trend": trend_value,
            "processResponse": process_response,
            "sourceDates": source_dates,
            "citations": citations,
        }
        outcomes.append(outcome)
        if conflict and reason_code not in {"TRADE_UNAVAILABLE", "TREND_UNAVAILABLE"}:
            changed_field = "trade" if reason_code == "TRADE_BREAK" else "trend" if reason_code == "TREND_BREAK" else None
            prior_value = _verified_prior_bias(security, changed_field) if changed_field else None
            current_value = trade_value if changed_field == "trade" else trend_value if changed_field == "trend" else None
            conflicts.append({
                **outcome,
                "conflict": conflict,
                "state": "New" if prior_value and current_value and prior_value != current_value else "Open",
                "priorSignal": prior_value,
            })

    expected = len([row for row in positions if row.get("category") != "event_contract" and _holding_side(row) and row.get("symbol")])
    coverage_state = str((intelligence.get("coverage") or {}).get("state") or "unavailable")
    complete = (
        len(outcomes) == expected
        and all(row.get("status") != "incomplete" and row.get("reasonCode") not in {"TRADE_UNAVAILABLE", "TREND_UNAVAILABLE", "SECURITY_INTELLIGENCE_MISSING"} for row in outcomes)
        and coverage_state in {"complete", "no_references"}
    )
    return {
        "complete": complete,
        "coverageState": coverage_state,
        "positionCount": expected,
        "reconciledCount": len(outcomes),
        "coverageGaps": [row for row in outcomes if row.get("reasonCode") in {"TRADE_UNAVAILABLE", "TREND_UNAVAILABLE", "SECURITY_INTELLIGENCE_MISSING"}],
        "conflictCount": len(conflicts),
        "conflicts": conflicts,
        "holdings": outcomes,
    }


def action_feed_changes(intelligence: dict[str, Any], held_symbols: Iterable[str]) -> list[dict[str, Any]]:
    held = {str(symbol).upper() for symbol in held_symbols}
    rows = []
    for symbol, security in sorted((intelligence.get("bySymbol") or {}).items()):
        if str(symbol).upper() in held or not isinstance(security, dict):
            continue
        for reference in security.get("directReferences") or []:
            if not isinstance(reference, dict):
                continue
            kind = str(reference.get("kind") or reference.get("eventType") or "").lower()
            excerpt = str(reference.get("excerpt") or "")
            if not re.search(r"\b(add(?:ed)?|remove(?:d)?|initiat(?:e|ed)|stopped\s+out|new\s+(?:buy|sell)|side\s+change)\b", f"{kind} {excerpt}", re.I):
                continue
            rows.append({
                "symbol": str(symbol).upper(),
                "product": reference.get("productId"),
                "change": excerpt or kind,
                "sourceDate": reference.get("marketDate"),
                "sourceEventId": reference.get("sourceEventId"),
                "citations": [citation] if (citation := _typed_reference_citation(reference)) else [],
            })
    unique = {canonical_fingerprint(row): row for row in rows}
    return list(unique.values())


def portfolio_alpha_codes(
    alpha_scan: dict[str, Any],
    reconciliation: Optional[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Keep exact held or server-approved research entities from the full-date scan."""
    links: dict[str, str] = {}
    for row in (reconciliation or {}).get("holdings") or []:
        if not isinstance(row, dict):
            continue
        holding = str(row.get("holding") or "").strip().upper()
        research_entity = str(row.get("matchedResearchEntity") or "").strip().upper()
        if holding:
            links[holding] = holding
        if holding and research_entity:
            links[research_entity] = holding

    selected = []
    for row in (alpha_scan or {}).get("codes") or []:
        if not isinstance(row, dict):
            continue
        instrument = str(row.get("researchInstrument") or "").strip().upper()
        portfolio_link = links.get(instrument)
        if not instrument or not portfolio_link:
            continue
        selected.append({**row, "portfolioLink": portfolio_link})
    return list({canonical_fingerprint(row): row for row in selected}.values())


MARKET_FIELD_PATTERNS = {
    "spxGammaExposure": r"SPX\s+Gamma\s+Exposure\s*[:\-]\s*([^\n.;]+)",
    "systematicFlowRisk": r"Systematic\s+Flow\s+Risk\s*[:\-]\s*([^\n.;]+)",
    "pvBandRiskReward": r"PV\s+Band\s+Risk/?Reward\s*[:\-]\s*([^\n.;]+)",
    "strategicAllocation": r"Strategic\s+Allocation\s*[:\-]\s*([^\n.;]+)",
    "gammaRegime": r"gamma\s+regime\s*[:\-]\s*([^\n.;]+)",
    "cta": r"\bCTA\b\s*[:\-]\s*([^\n.;]+)",
    "breadth": r"\bbreadth\b\s*[:\-]\s*([^\n.;]+)",
    "leadership": r"\bleadership\b\s*[:\-]\s*([^\n.;]+)",
    "dispersion": r"\bdispersion\b\s*[:\-]\s*([^\n.;]+)",
    "correlation": r"\bcorrelations?\b\s*[:\-]\s*([^\n.;]+)",
    "liquidity": r"\bliquidity\b\s*[:\-]\s*([^\n.;]+)",
}


def extract_market_fields(excerpts: Iterable[dict[str, Any]]) -> dict[str, Any]:
    fields: dict[str, Any] = {}
    for field, pattern in MARKET_FIELD_PATTERNS.items():
        selected = None
        for row in excerpts:
            text = str((row or {}).get("excerpt") or "")
            match = re.search(pattern, text, re.I)
            if match:
                selected = {
                    "available": True,
                    "value": match.group(1).strip()[:500],
                    "citationId": ((row or {}).get("citation") or {}).get("id"),
                }
                break
        fields[field] = selected or {"available": False, "reasonCode": "NOT_STATED"}
    return fields


def build_macro_topics(exact_documents: dict[str, Any]) -> dict[str, Any]:
    products = exact_documents.get("products") if isinstance(exact_documents, dict) else []
    products = products if isinstance(products, list) else []
    text_by_product = {
        str(row.get("product")): "\n".join(str(item.get("excerpt") or "") for item in row.get("excerpts") or [])
        for row in products if isinstance(row, dict)
    }
    topic_terms = {
        "usd": ("usd", "dollar", "dxy"),
        "fx": ("eur", "yen", "jpy", "currency", "fx"),
        "rates": ("rate", "yield", "treasury", "curve"),
        "growth_inflation_quad": ("growth", "inflation", "quad", "cpi"),
        "equities_credit_volatility": ("equity", "stocks", "credit", "volatility", "vix"),
        "commodities": ("commodity", "oil", "gold", "copper"),
        "crypto": ("bitcoin", "crypto", "btc"),
    }
    output = []
    for topic in MACRO_TOPICS:
        terms = topic_terms[topic]
        matches = []
        for row in products:
            if not isinstance(row, dict):
                continue
            text = text_by_product.get(str(row.get("product")), "").lower()
            if any(term in text for term in terms):
                matches.append({
                    "product": row.get("product"),
                    "publicationDate": row.get("publicationDate"),
                    "excerpts": row.get("excerpts") or [],
                })
        output.append({
            "topic": topic,
            "status": "available" if matches else "not_stated",
            "sources": matches,
        })
    return {"topics": output, "completeTopicCount": sum(row["status"] == "available" for row in output)}


def compare_baseline(current: dict[str, Any], baseline: Optional[dict[str, Any]]) -> dict[str, Any]:
    if not baseline:
        return {"status": "no_baseline", "changes": [], "baselineRunId": None}
    baseline_sections = {row.get("sectionId"): row for row in baseline.get("sections") or []}
    baseline_risk = ((baseline_sections.get("risk-snapshot") or {}).get("result") or {}).get("metrics") or {}
    changes = []
    for field in ("grossExposure", "netExposure", "grossLeverage", "positionCount", "valuedCount"):
        before = baseline_risk.get(field)
        after = current.get(field)
        if before != after:
            changes.append({"field": field, "before": before, "after": after})
    return {
        "status": "available",
        "baselineRunId": baseline.get("runId"),
        "baselineAcceptedAt": baseline.get("acceptedAt"),
        "changes": changes,
    }


def _packet_citations(value: Any) -> list[dict[str, Any]]:
    selected: dict[str, dict[str, Any]] = {}

    def visit(candidate: Any) -> None:
        if isinstance(candidate, list):
            for item in candidate:
                visit(item)
            return
        if not isinstance(candidate, dict):
            return
        citation_id = str(candidate.get("id") or "")
        if (
            re.fullmatch(r"cite_[a-f0-9]{32}", citation_id)
            and re.fullmatch(r"doc_[a-f0-9]{32}(?::p\d+)?", str(candidate.get("documentId") or ""))
            and candidate.get("product")
            and candidate.get("sourceUri")
        ):
            selected[citation_id] = {
                key: candidate.get(key)
                for key in (
                    "id", "documentId", "product", "publicationDate",
                    "sourceUri", "title",
                )
                if candidate.get(key) is not None
            }
        for child in candidate.values():
            visit(child)

    visit(value)
    return [selected[key] for key in sorted(selected)]


def build_packets(section_rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    groups = (
        ("portfolio-risk", {"conflicts-changes", "portfolio-overlay", "risk-snapshot"}),
        ("market-macro", {"market-situation", "macro-overlay"}),
        ("alpha-history-coverage", {"alpha-codes", "what-changed", "coverage-data-quality"}),
    )
    packets = []
    for group_id, section_ids in groups:
        selected_sections = [row for row in section_rows if row.get("sectionId") in section_ids]
        payload = {
            "schemaVersion": SCHEMA_VERSION,
            "group": group_id,
            "sections": selected_sections,
            "citations": _packet_citations(selected_sections),
        }
        serialized = _canonical_json(payload)
        fragments = [
            serialized[index:index + PACKET_PAYLOAD_BUDGET]
            for index in range(0, len(serialized), PACKET_PAYLOAD_BUDGET)
        ] or [""]
        for index, fragment in enumerate(fragments):
            packet_id = f"{group_id}-{index + 1:02d}"
            packet = {
                "packetId": packet_id,
                "group": group_id,
                "continuationIndex": index,
                "continuationCount": len(fragments),
                "jsonFragment": fragment,
                "sha256": sha256(fragment.encode("utf-8")).hexdigest(),
            }
            size = len(_canonical_json(packet).encode("utf-8"))
            if size > MAX_PACKET_BYTES:
                raise ValueError(f"Portfolio Review packet {packet_id} exceeds {MAX_PACKET_BYTES} bytes.")
            packet["sizeBytes"] = size
            packets.append(packet)
    return packets


def packet_manifest(packets: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {key: packet[key] for key in (
            "packetId", "group", "continuationIndex", "continuationCount", "sha256", "sizeBytes"
        )}
        for packet in packets
    ]


def portfolio_review_canary() -> dict[str, Any]:
    """Exercise the pure coordinator finalization contract without live inputs."""
    sections = section_descriptors()
    for section_id, _title in SECTION_SPECS:
        sections = set_section(
            sections,
            section_id,
            status="ready",
            reason_code="CANARY_VERIFIED",
            result={"canary": True, "sectionId": section_id},
        )
    fingerprint = canonical_fingerprint({"schemaVersion": SCHEMA_VERSION, "canary": True})
    packets = build_packets(sections)
    if not re.fullmatch(r"[a-f0-9]{64}", fingerprint):
        raise RuntimeError("Portfolio Review canonical fingerprint contract failed.")
    if not packets or any(packet.get("sizeBytes", MAX_PACKET_BYTES + 1) > MAX_PACKET_BYTES for packet in packets):
        raise RuntimeError("Portfolio Review packet finalization contract failed.")
    return {
        "ready": True,
        "fingerprint": fingerprint,
        "packetCount": len(packets),
    }


def public_run_error(run: dict[str, Any]) -> tuple[Optional[str], Optional[str]]:
    """Return a stable code and safe user-facing error without leaking internals."""
    code = str(run.get("errorCode") or "").strip() or None
    if not code and run.get("status") == "failed" and run.get("error"):
        # Completed v1 failures created before error codes were added are
        # coordinator failures. Keep their raw exception only in SQLite/logs.
        code = "COORDINATOR_FINALIZATION_FAILED"
    messages = {
        "COORDINATOR_FINALIZATION_FAILED": (
            "Portfolio Review could not finish because the review service encountered an internal error."
        ),
        "COORDINATOR_ABORTED": "Portfolio Review stopped before every section could finish.",
    }
    return code, messages.get(code) if code else None


def public_run(run: dict[str, Any], *, include_results: bool = False) -> dict[str, Any]:
    sections = []
    for row in run.get("sections") or []:
        projected = {key: row.get(key) for key in (
            "sectionId", "title", "order", "status", "reasonCode", "retryable",
            "sourceTimestamps", "evidenceCount"
        )}
        if include_results:
            projected["result"] = row.get("result")
        sections.append(projected)
    error_code, safe_error = public_run_error(run)
    retryable = bool(
        run.get("status") in {"partial", "blocked", "failed"}
        and (
            run.get("status") == "failed"
            or any(section.get("retryable") is True for section in run.get("sections") or [])
        )
    )
    return {
        "schemaVersion": run.get("schemaVersion", SCHEMA_VERSION),
        "runId": run.get("runId"),
        "sessionId": run.get("sessionId"),
        "requestId": run.get("requestId"),
        "attempt": run.get("attempt"),
        "status": run.get("status"),
        "sections": sections,
        "packets": packet_manifest(run.get("packets") or []),
        "createdAt": run.get("createdAt"),
        "updatedAt": run.get("updatedAt"),
        "completedAt": run.get("completedAt"),
        "acceptedAt": run.get("acceptedAt"),
        "retryable": retryable,
        "errorCode": error_code,
        "error": safe_error,
    }


__all__ = [
    "MAX_PACKET_BYTES",
    "PortfolioReviewStore",
    "SCHEMA_VERSION",
    "SECTION_SPECS",
    "action_feed_changes",
    "build_macro_topics",
    "build_packets",
    "canonical_fingerprint",
    "compare_baseline",
    "decode_position_table",
    "extract_market_fields",
    "overall_status",
    "packet_manifest",
    "portfolio_review_canary",
    "portfolio_metrics",
    "public_run",
    "reconcile_positions",
    "section_descriptors",
    "set_section",
]
