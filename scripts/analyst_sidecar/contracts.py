"""Shared contracts for The Analyst's read-only research and market tools."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import datetime, timezone
import hashlib
import json
from typing import Any, Iterable, Optional


ENVELOPE_FIELDS = (
    "status",
    "sourceSystem",
    "provider",
    "asOf",
    "freshness",
    "liveVerified",
    "warnings",
    "data",
    "citations",
)


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def stable_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def stable_id(prefix: str, *parts: Any) -> str:
    material = "\u001f".join(stable_json(part) for part in parts)
    return f"{prefix}_{hashlib.sha256(material.encode('utf-8')).hexdigest()[:32]}"


@dataclass(frozen=True)
class Citation:
    id: str
    documentId: str
    product: str
    publicationDate: Optional[str]
    sourceUri: str
    title: str
    section: Optional[str] = None
    page: Optional[int] = None
    excerpt: Optional[str] = None
    contentHash: Optional[str] = None
    pageToken: Optional[str] = None

    def as_dict(self) -> dict[str, Any]:
        return {key: value for key, value in asdict(self).items() if value is not None}


def make_citation_id(
    *,
    document_id: str,
    content_hash: str,
    section: Optional[str],
    page: Optional[int],
    ordinal: int,
) -> str:
    return stable_id(
        "cite",
        document_id,
        content_hash,
        section or "",
        page or 0,
        ordinal,
    )


def envelope(
    *,
    status: str,
    source_system: str,
    provider: str,
    data: Any,
    as_of: Optional[str] = None,
    freshness: str = "unknown",
    live_verified: bool = False,
    warnings: Optional[Iterable[str]] = None,
    citations: Optional[Iterable[dict[str, Any] | Citation]] = None,
) -> dict[str, Any]:
    normalized_citations = []
    for citation in citations or []:
        normalized_citations.append(
            citation.as_dict() if isinstance(citation, Citation) else dict(citation)
        )
    return {
        "status": status,
        "sourceSystem": source_system,
        "provider": provider,
        "asOf": as_of or utc_now_iso(),
        "freshness": freshness,
        "liveVerified": bool(live_verified),
        "warnings": [str(value) for value in warnings or [] if str(value).strip()],
        "data": data,
        "citations": normalized_citations,
    }


def validate_envelope(value: dict[str, Any]) -> None:
    missing = [field for field in ENVELOPE_FIELDS if field not in value]
    if missing:
        raise ValueError(f"Analyst result envelope is missing: {', '.join(missing)}")
    if value["liveVerified"] is True and value["provider"] == "fixed_prediction_monitor_universe":
        data = value.get("data") if isinstance(value.get("data"), dict) else {}
        rows = data.get("markets") if isinstance(data.get("markets"), list) else []
        quoted = sum(bool(row.get("quotedLineCount")) for row in rows if isinstance(row, dict))
        if not (value["freshness"] == "direct_venue_quotes_with_dated_research"
                and data.get("verificationScope") == "native_quotes_only"
                and data.get("executionVerified") is False
                and quoted > 0 and data.get("quotedMarketCount") == quoted):
            raise ValueError("Prediction review live verification requires independently verified native quotes and an explicit quote-only scope")
    elif value["liveVerified"] is True and value["provider"] not in {"ibkr", "kalshi"}:
        raise ValueError("Only verified IBKR live or direct Kalshi venue results may be marked liveVerified")
    if (
        value["liveVerified"] is True
        and value["provider"] == "kalshi"
        and value["freshness"] != "direct_venue_snapshot"
    ):
        raise ValueError("Kalshi liveVerified results require direct_venue_snapshot freshness")
    citation_ids = [row.get("id") for row in value["citations"] if isinstance(row, dict)]
    if any(not citation_id or not str(citation_id).startswith("cite_") for citation_id in citation_ids):
        raise ValueError("Every citation must have an immutable cite_ identifier")
    if len(citation_ids) != len(set(citation_ids)):
        raise ValueError("Duplicate citation identifiers are not allowed")
