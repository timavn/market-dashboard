"""Canonical research-product, entity-event, and publication-manifest helpers.

The Gmail and PDF ingestion paths use the same product vocabulary and write the
same immutable event/manifest contracts. Runtime consumers can rebuild their
portfolio projection from these records without treating a daily snapshot as an
authoritative or complete source.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
from copy import deepcopy
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any, Dict, Iterable, Iterator, List, Optional, Tuple

from botocore.exceptions import ClientError
from published_trade_signals import extract_published_trade_signals, explicit_provenance


MODULE_DIR = Path(__file__).resolve().parent
ENTITY_EVENTS_TABLE = os.environ.get(
    "RESEARCH_ENTITY_EVENTS_TABLE",
    "ResearchEntityEventsV1",
)
PRODUCT_MANIFEST_TABLE = os.environ.get(
    "RESEARCH_PRODUCT_MANIFEST_TABLE",
    "ResearchProductManifestsV1",
)
PARSER_VERSION = "security-intelligence-v5-signal-strength-books"
MAX_MANIFEST_WRITE_RETRIES = 4
MAX_BODY_TEXT_LENGTH = 40_000
MANIFEST_STAGES = {"received", "parsed", "validated", "indexed", "failed"}
AUTHORITATIVE_TRACKER_PRODUCTS = {"momo-tracker", "bitcoin-trend-tracker"}
AUTHORITATIVE_TRACKER_TRENDS = {"BULLISH", "BEARISH", "NEUTRAL"}
CONTROLLED_EXPOSURE_TYPES = {
    "factor",
    "sector",
    "country",
    "commodity",
    "macro",
}


def _load_json(filename: str) -> Dict[str, Any]:
    with (MODULE_DIR / filename).open("r", encoding="utf-8") as handle:
        return json.load(handle)


PRODUCT_REGISTRY = _load_json("research_products.json")
ENTITY_CATALOG = _load_json("research_entities.json")
PRODUCTS_BY_ID = {
    product["id"]: product for product in PRODUCT_REGISTRY.get("products", [])
}
STRUCTURED_ONLY_TICKERS = {
    str(token).upper()
    for token in ENTITY_CATALOG.get("structuredOnlyTickers", [])
}
RESERVED_TOKENS = {
    str(token).upper() for token in ENTITY_CATALOG.get("reservedTokens", [])
}
RESERVED_TOKENS.update(STRUCTURED_ONLY_TICKERS)
RESERVED_TOKENS.update(
    {
        "API",
        "ALL",
        "AND",
        "CEO",
        "CPI",
        "DAY",
        "ETF",
        "ETFS",
        "FED",
        "FOR",
        "FROM",
        "GDP",
        "HTML",
        "LOOK",
        "LRR",
        "MAIN",
        "MARKET",
        "NAV",
        "NOT",
        "NOW",
        "PDF",
        "RANGE",
        "RISK",
        "SHOW",
        "SUMMARY",
        "THAT",
        "THE",
        "THIS",
        "TODAY",
        "TRADE",
        "USD",
        "WEEK",
        "WITH",
    }
)

STRUCTURED_TICKER_COLLECTION_KEYS = {
    "added",
    "addedlongs",
    "addedshorts",
    "alerts",
    "changes",
    "cryptos",
    "fullbooklongs",
    "fullbookshorts",
    "longs",
    "neutrals",
    "positions",
    "rankings",
    "removed",
    "removedlongs",
    "removedshorts",
    "rows",
    "securities",
    "shorts",
    "stocks",
    "symbols",
    "tickers",
}


def product_ids() -> List[str]:
    return list(PRODUCTS_BY_ID)


def report_rules() -> List[Tuple[str, Tuple[str, ...]]]:
    return [
        (
            product["id"],
            tuple(str(term).lower() for term in product.get("matchTerms", [])),
        )
        for product in PRODUCT_REGISTRY.get("products", [])
        if product.get("matchTerms")
    ]


def product_definition(product_id: str) -> Dict[str, Any]:
    return PRODUCTS_BY_ID.get(
        str(product_id or ""),
        {
            "id": str(product_id or "unknown"),
            "label": str(product_id or "Unknown"),
            "cadence": "unsupported",
            "authorities": {},
        },
    )


def _alias_maps() -> Tuple[Dict[str, str], Dict[str, List[str]]]:
    alias_to_ticker: Dict[str, str] = {}
    aliases_by_ticker: Dict[str, List[str]] = {}
    for ticker, aliases in ENTITY_CATALOG.get("tickerAliases", {}).items():
        canonical = str(ticker).upper()
        values = [canonical, *[str(alias) for alias in aliases]]
        aliases_by_ticker[canonical] = values
        for value in values:
            alias_to_ticker[value.upper()] = canonical
    return alias_to_ticker, aliases_by_ticker


ALIAS_TO_TICKER, ALIASES_BY_TICKER = _alias_maps()


def _controlled_exposure_catalog() -> Dict[Tuple[str, str], Dict[str, Any]]:
    configured = ENTITY_CATALOG.get("controlledExposures") or {}
    if not configured:
        configured = {
            "factor": {
                exposure_id: {
                    "label": exposure_id,
                    "aliases": aliases,
                }
                for exposure_id, aliases in ENTITY_CATALOG.get(
                    "factorAliases",
                    {},
                ).items()
            }
        }

    catalog: Dict[Tuple[str, str], Dict[str, Any]] = {}
    for exposure_type, definitions in configured.items():
        normalized_type = str(exposure_type).strip().lower()
        if (
            normalized_type not in CONTROLLED_EXPOSURE_TYPES
            or not isinstance(definitions, dict)
        ):
            continue
        for exposure_id, definition in definitions.items():
            normalized_id = str(exposure_id).strip().lower()
            if not normalized_id:
                continue
            if isinstance(definition, dict):
                aliases = definition.get("aliases") or []
                label = definition.get("label") or normalized_id
            else:
                aliases = definition if isinstance(definition, list) else []
                label = normalized_id
            catalog[(normalized_type, normalized_id)] = {
                "type": normalized_type,
                "id": normalized_id,
                "label": str(label),
                "aliases": list(
                    dict.fromkeys(
                        [
                            normalized_id,
                            *[
                                str(alias).strip().lower()
                                for alias in aliases
                                if str(alias).strip()
                            ],
                        ]
                    )
                ),
            }
    return catalog


CONTROLLED_EXPOSURES = _controlled_exposure_catalog()


def canonical_ticker(
    value: Any,
    *,
    allow_structured_only: bool = False,
) -> Optional[str]:
    if isinstance(value, dict):
        value = value.get("ticker") or value.get("symbol") or value.get("asset")
    raw = str(value or "").strip()
    if not raw:
        return None

    parenthesized = re.findall(r"\(([A-Z][A-Z0-9./-]{0,11})\)", raw.upper())
    candidate = parenthesized[-1] if parenthesized else raw.upper()
    candidate = ALIAS_TO_TICKER.get(candidate, candidate)
    if candidate in RESERVED_TOKENS:
        if not (allow_structured_only and candidate in STRUCTURED_ONLY_TICKERS):
            return None
    if not re.fullmatch(r"[A-Z][A-Z0-9./-]{0,11}", candidate):
        return None
    return candidate


def _iter_content_blocks(
    value: Any,
    path: str = "",
) -> Iterator[Tuple[str, str]]:
    if isinstance(value, dict):
        for key, child in value.items():
            if key in {"sourceQualityIssueIds", "withheldFields"}:
                continue
            child_path = f"{path}.{key}" if path else str(key)
            yield from _iter_content_blocks(child, child_path)
        return
    if isinstance(value, list):
        for index, child in enumerate(value):
            yield from _iter_content_blocks(child, f"{path}[{index}]")
        return
    if not isinstance(value, str):
        return
    text = re.sub(r"\s+", " ", value).strip()
    if not text or text.startswith(("http://", "https://", "s3://")):
        return
    yield path, text[:MAX_BODY_TEXT_LENGTH]


def _direction_from_path(path: str, text: str = "") -> Optional[str]:
    haystack = f"{path} {text[:80]}".lower()
    # Structured tracker trends are authoritative. Neighboring JSON keys such
    # as sellTrade or downside must not turn an explicit bullish/neutral row
    # into a negative event.
    explicit = re.search(
        r'"?(?:trade|tradeBias|signal|trend)"?\s*[:=]\s*"?\s*'
        r"(BULLISH|BEARISH|NEUTRAL|LONG|SHORT|BUY|SELL)\b",
        text,
        re.IGNORECASE,
    )
    if explicit:
        value = explicit.group(1).upper()
        if value == "NEUTRAL":
            return "neutral"
        if value in {"BULLISH", "LONG", "BUY"}:
            return "positive"
        return "negative"
    if any(token in haystack for token in ("removed", "remove", "short", "bear", "sell")):
        return "negative"
    if any(token in haystack for token in ("added", "add", "long", "bull", "buy")):
        return "positive"
    if "neutral" in haystack:
        return "neutral"
    return None


def _tracker_typed_value(value: Any) -> Optional[Dict[str, Any]]:
    """Preserve the source Trend column separately from numerical Trade bounds."""
    if not isinstance(value, dict):
        return None
    trend = str(value.get("trend") or "").strip().upper()
    if trend not in {"BULLISH", "BEARISH", "NEUTRAL"}:
        return None
    result = {"trend": trend}
    try:
        lower = Decimal(str(value.get("lrr", value.get("buyTrade"))))
        upper = Decimal(str(value.get("hrr", value.get("sellTrade"))))
        if lower.is_finite() and upper.is_finite() and 0 < lower < upper:
            result.update({"lrr": lower, "hrr": upper, "trackerRange": {"lrr": lower, "hrr": upper}})
    except Exception:
        pass
    return result


def _etf_pro_typed_value(value: Any) -> Optional[Dict[str, str]]:
    if not isinstance(value, dict):
        return None
    action = str(value.get("action") or "").strip().upper()
    side = str(value.get("side") or value.get("call") or "").strip().upper()
    if action not in {"ADD", "REMOVE"} or side not in {"LONG", "SHORT"}:
        return None
    return {"action": action, "side": side}


def _has_signal_strength_book(data: Any) -> bool:
    return isinstance(data, dict) and (
        isinstance(data.get("shorts"), dict)
        or any(isinstance(data.get(key), list) for key in ("added", "removed", "stocks"))
    )


def _event_kind(product_id: str, path: str) -> str:
    lowered = path.lower()
    if product_id == "risk-ranges":
        return "risk_range"
    if product_id == "early-look":
        return "supplemental_risk_range"
    if product_id == "signal-strength":
        # The short list is a separate book; its events must never carry the
        # long-list kinds that consumers read as ADDED/LISTED.
        prefix = "signal_strength_short" if lowered.startswith("data.shorts") else "signal_strength"
        if "added" in lowered:
            return f"{prefix}_added"
        if "removed" in lowered:
            return f"{prefix}_removed"
        return f"{prefix}_membership"
    if product_id in {"momo-tracker", "bitcoin-trend-tracker"}:
        return "trend_signal"
    if product_id == "portfolio-solutions":
        return "portfolio_rank"
    if product_id in {"the-call", "the-macro-show"}:
        return "position_reference"
    if product_id == "investing-ideas":
        return "investing_idea_position"
    if product_id in {"real-time-alert", "etf-pro", "go-anywhere"}:
        return "position_change"
    return "mention"


def _excerpt(text: str, start: int, end: int, radius: int = 150) -> str:
    left = max(0, start - radius)
    right = min(len(text), end + radius)
    excerpt = text[left:right].strip()
    if left:
        excerpt = f"…{excerpt}"
    if right < len(text):
        excerpt = f"{excerpt}…"
    return excerpt


def _reference(
    *,
    entity_type: str,
    entity_id: str,
    match_type: str,
    matched_text: str,
    excerpt: str,
    field_path: str,
    product_id: str,
    direction: Optional[str] = None,
    value: Optional[Any] = None,
) -> Dict[str, Any]:
    reference = {
        "entityType": entity_type,
        "entityId": entity_id,
        "entityKey": f"{entity_type}#{entity_id}",
        "matchType": match_type,
        "matchedText": matched_text,
        "excerpt": excerpt[:700],
        "fieldPath": field_path,
        "eventType": _event_kind(product_id, field_path),
        "direction": direction,
    }
    if entity_type in CONTROLLED_EXPOSURE_TYPES:
        reference["exposureType"] = entity_type
        reference["exposureId"] = entity_id
        reference["exposureLabel"] = CONTROLLED_EXPOSURES.get(
            (entity_type, entity_id),
            {},
        ).get("label", entity_id)
    if value is not None:
        reference["value"] = value
    return reference


def _structured_ticker_references(
    snapshot: Dict[str, Any],
    product_id: str,
) -> List[Dict[str, Any]]:
    data = snapshot.get("data")
    references: List[Dict[str, Any]] = []

    if product_id == "signal-strength" and _has_signal_strength_book(data):
        # One typed reference per listed security. Name, sector and analyst
        # columns must not steer direction the way the generic walker would.
        books = [("data", data, ("positive", "negative", None))]
        if isinstance(data.get("shorts"), dict):
            books.append(("data.shorts", data["shorts"], ("negative", None, "negative")))
        for book_path, book, (added_direction, removed_direction, listed_direction) in books:
            for field, direction in (
                ("added", added_direction),
                ("removed", removed_direction),
                ("stocks", listed_direction),
            ):
                rows = book.get(field) if isinstance(book, dict) else None
                for index, row in enumerate(rows if isinstance(rows, list) else []):
                    ticker = canonical_ticker(row, allow_structured_only=True)
                    if not ticker:
                        continue
                    references.append(_reference(
                        entity_type="ticker",
                        entity_id=ticker,
                        match_type="structured_membership",
                        matched_text=ticker,
                        excerpt=row if isinstance(row, str) else json.dumps(row, sort_keys=True, default=str),
                        field_path=f"{book_path}.{field}[{index}]",
                        product_id=product_id,
                        direction=direction,
                    ))
        return references

    if product_id == "bitcoin-trend-tracker":
        # The tracker publishes two tables.  Treat each complete row as one
        # typed reference and stop the generic walker from re-emitting the
        # container names, range columns, or narrative JSON as separate
        # signals.  Older snapshots that only have buyTrade/sellTrade remain
        # compatible through _tracker_typed_value.
        saw_tracker_table = False
        for table_name in ("cryptos", "stocks"):
            table = data.get(table_name) if isinstance(data, dict) else None
            if not isinstance(table, dict):
                continue
            saw_tracker_table = True
            for index, (raw_ticker, row) in enumerate(table.items()):
                ticker = canonical_ticker(raw_ticker, allow_structured_only=True)
                typed_value = _tracker_typed_value(row)
                if not ticker or typed_value is None:
                    continue
                detail = f"Trend {typed_value['trend']}"
                if typed_value.get("lrr") is not None and typed_value.get("hrr") is not None:
                    detail += f"; Buy Trade {typed_value['lrr']}; Sell Trade {typed_value['hrr']}"
                reference = _reference(
                    entity_type="ticker",
                    entity_id=ticker,
                    match_type="structured_membership",
                    matched_text=ticker,
                    excerpt=detail,
                    field_path=f"data.{table_name}.{raw_ticker}",
                    product_id=product_id,
                    direction=typed_value["trend"],
                    value=typed_value,
                )
                if reference:
                    references.append(reference)
        if saw_tracker_table:
            return references

    if product_id in {"etf-pro", "go-anywhere"}:
        # ETF Pro and Go-Anywhere are actionable change feeds, not a prose/newsletter feed.
        # Keep only explicit ADD/REMOVE + LONG/SHORT rows and emit one clean
        # typed reference per ticker.
        changes = data.get("changes") if isinstance(data, dict) else None
        changes = changes if isinstance(changes, list) else []
        saw_change_payload = isinstance(data, dict) and any(
            key in data for key in ("changes", "rows")
        )
        for index, change in enumerate(changes):
            if not isinstance(change, dict):
                continue
            ticker = canonical_ticker(change, allow_structured_only=True)
            typed_value = _etf_pro_typed_value(change)
            if not ticker or typed_value is None:
                continue
            detail = f"{typed_value['action']} {typed_value['side']}"
            references.append(_reference(
                entity_type="ticker",
                entity_id=ticker,
                match_type="structured_membership",
                matched_text=ticker,
                excerpt=detail,
                field_path=f"data.changes[{index}]",
                product_id=product_id,
                direction=typed_value["side"],
                value=typed_value,
            ))
        if saw_change_payload:
            return references

    if product_id == "investing-ideas":
        positions = data.get("positions") if isinstance(data, dict) else None
        if not isinstance(positions, list) or not positions:
            positions = []
            if isinstance(data, dict):
                positions.extend(
                    {
                        "ticker": value,
                        "side": "Long",
                    }
                    for value in data.get("longs") or []
                )
                positions.extend(
                    {
                        "ticker": value,
                        "side": "Short",
                    }
                    for value in data.get("shorts") or []
                )

        for index, position in enumerate(positions):
            if isinstance(position, str):
                position = {"ticker": position}
            if not isinstance(position, dict):
                continue
            # A structured position field is authoritative ticker context.
            # ``AM`` and ``PM`` are real security symbols but are reserved for
            # generic text extraction because they are also meridiem tokens.
            ticker = canonical_ticker(position, allow_structured_only=True)
            if not ticker:
                continue
            raw_side = str(position.get("side") or position.get("position") or "").strip()
            side = "Long" if raw_side.lower() in {"long", "buy", "bullish"} else None
            if raw_side.lower() in {"short", "sell", "bearish"}:
                side = "Short"
            if side is None:
                continue
            bias = "BULLISH" if side == "Long" else "BEARISH"
            typed_value = {
                "side": side,
                "bias": bias,
                "prevClose": position.get("prevClose"),
                "lrr": position.get("lrr"),
                "hrr": position.get("hrr"),
            }
            detail = json.dumps(
                {"ticker": ticker, **typed_value},
                sort_keys=True,
                default=str,
            )
            references.append(
                _reference(
                    entity_type="ticker",
                    entity_id=ticker,
                    match_type="structured_membership",
                    matched_text=ticker,
                    excerpt=detail,
                    field_path=f"data.positions[{index}]",
                    product_id=product_id,
                    direction="positive" if side == "Long" else "negative",
                    value=typed_value,
                )
            )
        # Do not recurse into longs/shorts/positions: those fields are
        # redundant projections of the same row and previously created
        # duplicate events for one security. Legacy alert-only snapshots do
        # not have a position payload, so they continue through the generic
        # extractor below.
        has_position_payload = isinstance(data, dict) and any(
            key in data for key in ("positions", "longs", "shorts")
        )
        if references or has_position_payload:
            return references

    def signal_value(value: Dict[str, Any]) -> Any:
        for key in ("trend",):
            if value.get(key) is not None:
                return value[key]
        return None

    def security_record(value: Any) -> bool:
        return isinstance(value, dict) and any(
            key in value
            for key in (
                "ticker",
                "symbol",
                "asset",
                "trade",
                "tradeBias",
                "signal",
                "trend",
                "lrr",
                "hrr",
                "buyTrade",
                "sellTrade",
                "rank",
                "score",
            )
        )

    if isinstance(data, dict) and product_id in {
        "risk-ranges",
        "early-look",
        "momo-tracker",
    }:
        for key, value in data.items():
            ticker = canonical_ticker(key, allow_structured_only=True)
            if not ticker:
                continue
            detail = json.dumps(value, sort_keys=True, default=str)
            references.append(
                _reference(
                    entity_type="ticker",
                    entity_id=ticker,
                    match_type="structured_membership",
                    matched_text=str(key),
                    excerpt=f"{key}: {detail}",
                    field_path=f"data.{key}",
                    product_id=product_id,
                    direction=_direction_from_path(f"data.{key}", detail),
                    value=signal_value(value) if isinstance(value, dict) else None,
                )
            )

    def visit(value: Any, path: str = "data") -> None:
        if isinstance(value, dict):
            direct_value = value.get("ticker") or value.get("symbol") or value.get("asset")
            ticker = canonical_ticker(direct_value, allow_structured_only=True)
            if ticker:
                detail = json.dumps(value, sort_keys=True, default=str)
                references.append(
                    _reference(
                        entity_type="ticker",
                        entity_id=ticker,
                        match_type="structured_membership",
                        matched_text=str(direct_value),
                        excerpt=detail,
                        field_path=path,
                        product_id=product_id,
                        direction=_direction_from_path(path, detail),
                        value=signal_value(value),
                    )
                )
            for key, child in value.items():
                if key in {"sourceQualityIssueIds", "withheldFields"}:
                    continue
                child_path = f"{path}.{key}"
                key_ticker = canonical_ticker(key, allow_structured_only=True)
                if key_ticker and security_record(child):
                    detail = json.dumps(child, sort_keys=True, default=str)
                    references.append(
                        _reference(
                            entity_type="ticker",
                            entity_id=key_ticker,
                            match_type="structured_membership",
                            matched_text=str(key),
                            excerpt=f"{key}: {detail}",
                            field_path=child_path,
                            product_id=product_id,
                            direction=_direction_from_path(child_path, detail),
                            value=signal_value(child),
                        )
                    )
                visit(child, child_path)
            return
        if isinstance(value, list):
            for index, child in enumerate(value):
                child_path = f"{path}[{index}]"
                if isinstance(child, str):
                    collection_key = path.rsplit(".", 1)[-1].split("[", 1)[0].lower()
                    ticker = canonical_ticker(
                        child,
                        allow_structured_only=(
                            collection_key in STRUCTURED_TICKER_COLLECTION_KEYS
                        ),
                    )
                    if ticker:
                        references.append(
                            _reference(
                                entity_type="ticker",
                                entity_id=ticker,
                                match_type="structured_membership",
                                matched_text=child,
                                excerpt=child,
                                field_path=child_path,
                                product_id=product_id,
                                direction=_direction_from_path(path, child),
                            )
                        )
                else:
                    visit(child, child_path)

    visit(data)
    return references


def _deduplicate_entity_references(
    references: Iterable[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    deduplicated: Dict[str, Dict[str, Any]] = {}
    for reference in references:
        signature = "|".join(
            [
                reference["entityKey"],
                reference["eventType"],
                str(reference.get("direction") or ""),
                reference["fieldPath"],
                reference["excerpt"],
            ]
        )
        deduplicated[hashlib.sha256(signature.encode("utf-8")).hexdigest()] = reference
    return list(deduplicated.values())


def _is_authoritative_tracker_reference(reference: Dict[str, Any]) -> bool:
    event_type = reference.get("eventType")
    value = reference.get("value")
    if event_type == "trend_signal":
        trend = value.get("trend") if isinstance(value, dict) else value
        return str(trend or "").strip().upper() in AUTHORITATIVE_TRACKER_TRENDS
    if event_type == "trade_signal":
        return (
            str(value or "").strip().upper() in AUTHORITATIVE_TRACKER_TRENDS
            and explicit_provenance(reference.get("signalProvenance"))
        )
    return False


def extract_entity_references(snapshot: Dict[str, Any]) -> List[Dict[str, Any]]:
    product_id = str(
        snapshot.get("snapshotType") or snapshot.get("reportType") or "unknown"
    )
    if product_id == "hedgai-signals":
        # HedgAI uses a separate, shorter horizon. Its source instrument
        # identities and actions live in the typed research ledger; generic
        # body extraction would mis-map yield/dollar names and footer rosters.
        return []
    references = _structured_ticker_references(snapshot, product_id)
    for signal in extract_published_trade_signals(snapshot):
        ticker = canonical_ticker(signal["ticker"], allow_structured_only=True)
        if not ticker:
            continue
        reference = _reference(entity_type="ticker", entity_id=ticker,
                               match_type="structured_membership", matched_text=signal["sourceTicker"],
                               excerpt=signal["sourceText"], field_path=signal["fieldPath"],
                               product_id=product_id, direction=signal["value"], value=signal["value"])
        reference.update({"eventType": "trade_signal", "sourceTicker": signal["sourceTicker"],
                          "sourceText": signal["sourceText"], "signalProvenance": signal["signalProvenance"]})
        references.append(reference)
    if product_id in AUTHORITATIVE_TRACKER_PRODUCTS:
        # Tracker rows are the only authority for tracker products. OCR prose,
        # chart labels, image names, and neighboring JSON keys must never be
        # promoted into ticker signals. Keep the typed Trend row for each
        # security plus any explicit, provenance-backed Trade evidence.
        return _deduplicate_entity_references(
            reference
            for reference in references
            if _is_authoritative_tracker_reference(reference)
        )
    searchable_data = snapshot.get("data") or {}
    if product_id == "signal-strength" and _has_signal_strength_book(searchable_data):
        # The email body repeats the published table. Its typed rows are the
        # only authority, and a short-list body must not read as membership.
        return references
    if product_id == "investing-ideas" and isinstance(searchable_data, dict):
        # A complete Investing Ideas position book is already represented by
        # one typed row per ticker. Do not walk the article/body text as a
        # second event source: the newsletter repeats every ticker in the
        # headline, table, range graphic, and HTML metadata.
        if any(key in searchable_data for key in ("positions", "longs", "shorts")):
            return references
        # positions/longs/shorts are already represented by one typed
        # structured reference per security. Leaving them in the generic text
        # walker would re-emit ticker leaf, side, and range values as separate
        # duplicate events.
        searchable_data = {
            key: value
            for key, value in searchable_data.items()
            if key not in {"positions", "longs", "shorts"}
        }
    searchable = {
        "article": snapshot.get("article") or {},
        "data": searchable_data,
        "trendChanges": snapshot.get("trendChanges") or [],
    }

    ticker_token_pattern = re.compile(r"\b[A-Z][A-Z0-9./-]{1,11}\b")

    for path, text in _iter_content_blocks(searchable):
        occupied: set[Tuple[str, str]] = set()

        for ticker, aliases in ALIASES_BY_TICKER.items():
            if ticker in STRUCTURED_ONLY_TICKERS:
                continue
            for alias in sorted(aliases, key=len, reverse=True):
                pattern = re.compile(rf"(?<![A-Z0-9]){re.escape(alias)}(?![A-Z0-9])", re.IGNORECASE)
                for match in pattern.finditer(text):
                    match_type = "explicit_ticker" if alias.upper() == ticker else "name_alias"
                    references.append(
                        _reference(
                            entity_type="ticker",
                            entity_id=ticker,
                            match_type=match_type,
                            matched_text=match.group(0),
                            excerpt=_excerpt(text, match.start(), match.end()),
                            field_path=path,
                            product_id=product_id,
                            direction=_direction_from_path(path, text),
                        )
                    )
                    occupied.add((ticker, path))

        for match in ticker_token_pattern.finditer(text):
            ticker = canonical_ticker(match.group(0))
            if not ticker or (ticker, path) in occupied:
                continue
            references.append(
                _reference(
                    entity_type="ticker",
                    entity_id=ticker,
                    match_type="explicit_ticker",
                    matched_text=match.group(0),
                    excerpt=_excerpt(text, match.start(), match.end()),
                    field_path=path,
                    product_id=product_id,
                    direction=_direction_from_path(path, text),
                )
            )

        lowered = text.lower()
        for (exposure_type, exposure_id), definition in CONTROLLED_EXPOSURES.items():
            for alias in sorted(
                (str(item) for item in definition["aliases"]),
                key=len,
                reverse=True,
            ):
                pattern = re.compile(rf"(?<![a-z0-9]){re.escape(alias.lower())}(?![a-z0-9])")
                match = pattern.search(lowered)
                if not match:
                    continue
                references.append(
                    _reference(
                        entity_type=exposure_type,
                        entity_id=exposure_id,
                        match_type=f"{exposure_type}_reference",
                        matched_text=text[match.start() : match.end()],
                        excerpt=_excerpt(text, match.start(), match.end()),
                        field_path=path,
                        product_id=product_id,
                        direction=_direction_from_path(path, text),
                    )
                )
                break

    return _deduplicate_entity_references(references)


def build_entity_events(
    snapshot: Dict[str, Any],
    *,
    content_sha256: Optional[str] = None,
) -> List[Dict[str, Any]]:
    product_id = str(
        snapshot.get("snapshotType") or snapshot.get("reportType") or "unknown"
    )
    market_date = str(snapshot.get("date") or "")[:10]
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", market_date):
        raise ValueError(f"Research snapshot has no valid market date: {market_date!r}")

    published_at = str(
        snapshot.get("publishedAt")
        or snapshot.get("scrapedAt")
        or f"{market_date}T00:00:00+00:00"
    )
    source_event_id = str(
        content_sha256
        or snapshot.get("sourceEventId")
        or snapshot.get("gmailMessageId")
        or hashlib.sha256(
            json.dumps(snapshot, sort_keys=True, default=str).encode("utf-8")
        ).hexdigest()
    )
    source_url = (
        (snapshot.get("article") or {}).get("feedUrl")
        or snapshot.get("htmlSource")
        or snapshot.get("pdfS3Key")
        or snapshot.get("source")
    )
    definition = product_definition(product_id)
    events = []
    for reference in extract_entity_references(snapshot):
        identity = "|".join(
            [
                product_id,
                market_date,
                source_event_id,
                reference["entityKey"],
                reference["fieldPath"],
                reference["excerpt"],
            ]
        )
        quality_revision = (snapshot.get("sourceQuality") or {}).get("revision")
        if quality_revision:
            identity += f"|quality-{quality_revision}"
        event_id = hashlib.sha256(identity.encode("utf-8")).hexdigest()
        event_key = f"{market_date}#{published_at}#{product_id}#{event_id}"
        event = {
            "entityKey": reference["entityKey"],
            "eventKey": event_key,
            "marketDate": market_date,
            "dateEventKey": (
                f"{product_id}#{published_at}#{reference['entityKey']}#{event_id}"
            ),
            "schemaVersion": 2,
            "productKey": product_id,
            "productLabel": definition.get("label", product_id),
            "eventType": reference["eventType"],
            "direction": reference.get("direction"),
            "excerpt": reference["excerpt"],
            "matchedText": reference["matchedText"],
            "matchType": reference["matchType"],
            "fieldPath": reference["fieldPath"],
            "entityType": reference["entityType"],
            "entityId": reference["entityId"],
            "publishedAt": published_at,
            "ingestedAt": str(snapshot.get("scrapedAt") or published_at),
            "sourceEventId": source_event_id,
            "sourceMessageId": snapshot.get("gmailMessageId"),
            "sourceUrl": source_url,
            "contentSha256": content_sha256,
            "parserVersion": PARSER_VERSION,
            "qualityStatus": "validated",
            **({"sourceQualityRevision": quality_revision} if quality_revision else {}),
            **(
                {"signalValue": (
                    reference["value"].get("trend")
                    if product_id == "bitcoin-trend-tracker"
                    and isinstance(reference.get("value"), dict)
                    else reference["value"]
                )}
                if reference.get("value") is not None
                else {}
            ),
        }
        if product_id == "bitcoin-trend-tracker" and isinstance(
            reference.get("value"),
        dict,
        ):
            typed_tracker = reference["value"]
            event["value"] = typed_tracker
            event["trend"] = typed_tracker.get("trend")
            event["trackerRange"] = {
                "lrr": typed_tracker.get("lrr"),
                "hrr": typed_tracker.get("hrr"),
            }
        if product_id in {"etf-pro", "go-anywhere"} and isinstance(reference.get("value"), dict):
            event["value"] = reference["value"]
            event["action"] = reference["value"].get("action")
            event["positionSide"] = reference["value"].get("side")
        if reference.get("exposureType"):
            event["exposureType"] = reference["exposureType"]
            event["exposureId"] = reference["exposureId"]
            event["exposureLabel"] = reference["exposureLabel"]
        if explicit_provenance(reference.get("signalProvenance")):
            event.update({"signalProvenance": reference["signalProvenance"],
                          "sourceTicker": reference["sourceTicker"], "sourceText": reference["sourceText"]})
            event["decisionEligible"] = True
        elif product_id in {"risk-ranges", "early-look"}:
            event["decisionEligible"] = False
            event["verificationStatus"] = (
                "requires-primary-publication-manifest"
                if product_id == "risk-ranges"
                else "supplemental-only"
            )
        elif definition.get("authorities", {}).get("trade"):
            event["decisionEligible"] = bool(event.get("signalValue"))
        else:
            event["decisionEligible"] = False
        if product_id == "investing-ideas" and isinstance(
            reference.get("value"),
            dict,
        ):
            typed_value = reference["value"]
            event["positionSide"] = typed_value.get("side")
            event["bias"] = typed_value.get("bias")
            event["riskRange"] = {
                "lrr": typed_value.get("lrr"),
                "hrr": typed_value.get("hrr"),
            }
        events.append(event)
    return events


def _conditional_failure(error: ClientError) -> bool:
    return (
        error.response.get("Error", {}).get("Code")
        == "ConditionalCheckFailedException"
    )


def _dynamodb_safe(value: Any) -> Any:
    """Convert parser-native floats before handing nested values to DynamoDB."""
    if isinstance(value, float):
        decimal_value = Decimal(str(value))
        if not decimal_value.is_finite():
            raise ValueError("DynamoDB does not support non-finite numeric values")
        return decimal_value
    if isinstance(value, dict):
        return {key: _dynamodb_safe(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_dynamodb_safe(item) for item in value]
    if isinstance(value, tuple):
        return tuple(_dynamodb_safe(item) for item in value)
    if isinstance(value, set):
        return {_dynamodb_safe(item) for item in value}
    return value


def _manifest_checksum(artifacts: List[Dict[str, Any]]) -> str:
    canonical = [
        {
            "artifactId": artifact.get("artifactId"),
            "contentSha256": artifact.get("contentSha256"),
            "stage": artifact.get("stage"),
            "eventCount": int(artifact.get("eventCount", 0)),
            "parserVersion": artifact.get("parserVersion"),
        }
        for artifact in sorted(
            artifacts,
            key=lambda item: str(item.get("artifactId") or ""),
        )
    ]
    return hashlib.sha256(
        json.dumps(
            canonical,
            sort_keys=True,
            separators=(",", ":"),
            default=str,
        ).encode("utf-8")
    ).hexdigest()


def persist_entity_events(
    events: Iterable[Dict[str, Any]],
    dynamodb: Any,
) -> int:
    table = dynamodb.Table(ENTITY_EVENTS_TABLE)
    written = 0
    for event in events:
        item = _dynamodb_safe(
            {key: value for key, value in event.items() if value is not None}
        )
        try:
            table.put_item(
                Item=item,
                ConditionExpression=(
                    "attribute_not_exists(entityKey) AND attribute_not_exists(eventKey)"
                ),
            )
            written += 1
        except ClientError as error:
            if not _conditional_failure(error):
                raise
    return written


def _artifact_id(
    snapshot: Dict[str, Any],
    content_sha256: Optional[str],
) -> str:
    return str(
        content_sha256
        or snapshot.get("gmailMessageId")
        or snapshot.get("sourceEventId")
        or hashlib.sha256(
            json.dumps(snapshot, sort_keys=True, default=str).encode("utf-8")
        ).hexdigest()
    )


def update_product_manifest(
    snapshot: Dict[str, Any],
    dynamodb: Any,
    *,
    stage: str,
    content_sha256: Optional[str] = None,
    event_count: int = 0,
    error: Optional[str] = None,
    replace_existing: bool = False,
) -> Dict[str, Any]:
    if stage not in MANIFEST_STAGES:
        raise ValueError(f"Unsupported manifest stage: {stage}")
    product_id = str(
        snapshot.get("snapshotType") or snapshot.get("reportType") or "unknown"
    )
    market_date = str(snapshot.get("date") or "")[:10]
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", market_date):
        raise ValueError(f"Research snapshot has no valid market date: {market_date!r}")
    definition = product_definition(product_id)
    table = dynamodb.Table(PRODUCT_MANIFEST_TABLE)
    key = {"marketDate": market_date, "productKey": product_id}
    artifact_id = _artifact_id(snapshot, content_sha256)
    now = datetime.now(timezone.utc).isoformat()

    for _ in range(MAX_MANIFEST_WRITE_RETRIES):
        existing = table.get_item(Key=key, ConsistentRead=True).get("Item") or {}
        version = int(existing.get("version", 0))
        artifacts = {
            str(item.get("artifactId")): dict(item)
            for item in existing.get("artifacts", [])
            if item.get("artifactId")
        }
        previous = artifacts.get(artifact_id, {})
        if replace_existing:
            effective_stage = stage
        elif previous.get("stage") == "indexed" and stage != "indexed":
            effective_stage = "indexed"
        else:
            effective_stage = stage
        stage_history = list(previous.get("stageHistory") or [])
        transition = {"stage": stage, "at": now}
        if error:
            transition["error"] = str(error)[:1000]
        stage_history.append(transition)
        # An artifact's event count describes the current validated parser
        # output. Replays can legitimately reduce the count when a parser is
        # hardened (for example, replacing legacy Investing Ideas leaf rows
        # with one typed position event per security), so do not preserve a
        # stale, larger count once validation/indexing succeeds.
        # An operator replacement replay (replace_existing) also resets the
        # count so a superseded parser's larger total cannot survive reindex.
        effective_event_count = (
            int(event_count)
            if replace_existing or stage in {"validated", "indexed"}
            else max(int(previous.get("eventCount", 0)), int(event_count))
        )
        artifact = {
            **previous,
            "artifactId": artifact_id,
            "stage": effective_stage,
            "stageHistory": stage_history[-50:],
            "sourceMessageId": snapshot.get("gmailMessageId"),
            "sourceKey": snapshot.get("htmlSource") or snapshot.get("pdfS3Key"),
            "publishedAt": snapshot.get("publishedAt"),
            "parserVersion": PARSER_VERSION,
            "eventCount": effective_event_count,
            "updatedAt": now,
        }
        if content_sha256:
            artifact["contentSha256"] = content_sha256
        if snapshot.get("sourceQuality"):
            artifact["sourceQuality"] = snapshot["sourceQuality"]
        if product_id in {"risk-ranges", "early-look"}:
            artifact["decisionEligible"] = False
            artifact["verificationStatus"] = (
                "requires-primary-publication-manifest"
                if product_id == "risk-ranges"
                else "supplemental-only"
            )
        if error and effective_stage != "indexed":
            artifact["error"] = str(error)[:1000]
        else:
            artifact.pop("error", None)
        artifacts[artifact_id] = {key: value for key, value in artifact.items() if value is not None}

        artifact_list = sorted(artifacts.values(), key=lambda item: item["artifactId"])
        counts = {
            "receivedCount": len(artifact_list),
            "parsedCount": sum(
                item.get("stage") in {"parsed", "validated", "indexed"}
                for item in artifact_list
            ),
            "validatedCount": sum(
                item.get("stage") in {"validated", "indexed"}
                for item in artifact_list
            ),
            "indexedCount": sum(item.get("stage") == "indexed" for item in artifact_list),
            "failedCount": sum(item.get("stage") == "failed" for item in artifact_list),
        }
        state = (
            "failed"
            if counts["failedCount"]
            else "indexed"
            if counts["indexedCount"] == counts["receivedCount"]
            else "validated"
            if counts["validatedCount"] == counts["receivedCount"]
            else "parsed"
            if counts["parsedCount"] == counts["receivedCount"]
            else "received"
        )
        source_issues = {
            issue["id"]: issue
            for entry in artifact_list
            for issue in (entry.get("sourceQuality") or {}).get("issues", [])
            if isinstance(issue, dict) and issue.get("id")
        }
        item = {
            **key,
            "sourceQuality": {
                "status": "discrepancy" if source_issues else "clear",
                "issues": list(source_issues.values()),
            },
            "schemaVersion": 1,
            "label": definition.get("label", product_id),
            "cadence": definition.get("cadence", "unsupported"),
            "state": state,
            **counts,
            "entityEventCount": sum(
                int(entry.get("eventCount", 0)) for entry in artifact_list
            ),
            "manifestChecksum": _manifest_checksum(artifact_list),
            "artifacts": artifact_list,
            "parserVersion": PARSER_VERSION,
            "updatedAt": now,
            "version": version + 1,
        }
        if existing.get("reclassifiedArtifacts"):
            item["reclassifiedArtifacts"] = deepcopy(
                existing["reclassifiedArtifacts"]
            )
        try:
            kwargs: Dict[str, Any] = {"Item": item}
            if existing:
                kwargs.update(
                    {
                        "ConditionExpression": "#version = :expectedVersion",
                        "ExpressionAttributeNames": {"#version": "version"},
                        "ExpressionAttributeValues": {":expectedVersion": version},
                    }
                )
            else:
                kwargs["ConditionExpression"] = (
                    "attribute_not_exists(marketDate) AND attribute_not_exists(productKey)"
                )
            table.put_item(**{**kwargs, "Item": _dynamodb_safe(item)})
            return item
        except ClientError as write_error:
            if not _conditional_failure(write_error):
                raise
    raise RuntimeError(f"Unable to update product manifest for {market_date}/{product_id}")


def reclassify_manifest_artifact(
    snapshot: Dict[str, Any],
    dynamodb: Any,
    *,
    source_product_id: str,
    content_sha256: str,
) -> Dict[str, Any]:
    """Move one active manifest artifact only after its target is indexed.

    The source artifact and its complete stage history remain in the optional
    audit collection. Active counts and checksums intentionally exclude that
    audit evidence.
    """
    target_product_id = str(
        snapshot.get("snapshotType") or snapshot.get("reportType") or "unknown"
    )
    if source_product_id == target_product_id:
        raise ValueError("Manifest reclassification requires distinct products")
    known_products = set(product_ids())
    if source_product_id not in known_products or target_product_id not in known_products:
        raise ValueError("Manifest reclassification requires registered products")

    market_date = str(snapshot.get("date") or "")[:10]
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", market_date):
        raise ValueError("Manifest reclassification requires a valid market date")
    if not re.fullmatch(r"[0-9a-f]{64}", str(content_sha256 or "")):
        raise ValueError("Manifest reclassification requires an exact content hash")

    table = dynamodb.Table(PRODUCT_MANIFEST_TABLE)
    artifact_id = _artifact_id(snapshot, content_sha256)
    target_key = {"marketDate": market_date, "productKey": target_product_id}
    target_manifest = table.get_item(
        Key=target_key,
        ConsistentRead=True,
    ).get("Item") or {}
    target_artifact = next(
        (
            item
            for item in target_manifest.get("artifacts", [])
            if str(item.get("artifactId") or "") == artifact_id
        ),
        None,
    )
    if (
        not target_artifact
        or target_artifact.get("stage") != "indexed"
        or target_artifact.get("contentSha256") != content_sha256
    ):
        raise RuntimeError(
            "Target manifest does not contain the indexed reclassification artifact"
        )

    source_key = {"marketDate": market_date, "productKey": source_product_id}
    reclassification_id = hashlib.sha256(
        "|".join(
            (
                market_date,
                source_product_id,
                target_product_id,
                artifact_id,
                content_sha256,
            )
        ).encode("utf-8")
    ).hexdigest()

    for _ in range(MAX_MANIFEST_WRITE_RETRIES):
        existing = table.get_item(
            Key=source_key,
            ConsistentRead=True,
        ).get("Item") or {}
        if not existing:
            raise RuntimeError("Source manifest is missing during reclassification")
        version = int(existing.get("version", 0))
        audits = deepcopy(existing.get("reclassifiedArtifacts") or [])
        prior_audit = next(
            (
                item
                for item in audits
                if item.get("reclassificationId") == reclassification_id
            ),
            None,
        )
        artifacts = [
            deepcopy(item) for item in existing.get("artifacts", [])
        ]
        source_artifact = next(
            (
                item
                for item in artifacts
                if str(item.get("artifactId") or "") == artifact_id
            ),
            None,
        )
        if source_artifact is None:
            if prior_audit is not None:
                return existing
            raise RuntimeError("Source manifest artifact is missing during reclassification")
        if source_artifact.get("contentSha256") != content_sha256:
            raise RuntimeError("Source manifest content hash changed before reclassification")

        now = datetime.now(timezone.utc).isoformat()
        audits.append(
            {
                "reclassificationId": reclassification_id,
                "artifactId": artifact_id,
                "contentSha256": content_sha256,
                "sourceProductKey": source_product_id,
                "targetProductKey": target_product_id,
                "reclassifiedAt": now,
                "targetManifestVersion": int(target_manifest.get("version", 0)),
                "targetManifestChecksum": target_manifest.get("manifestChecksum"),
                "sourceArtifact": deepcopy(source_artifact),
            }
        )
        active_artifacts = sorted(
            (
                item
                for item in artifacts
                if str(item.get("artifactId") or "") != artifact_id
            ),
            key=lambda item: str(item.get("artifactId") or ""),
        )
        counts = {
            "receivedCount": len(active_artifacts),
            "parsedCount": sum(
                item.get("stage") in {"parsed", "validated", "indexed"}
                for item in active_artifacts
            ),
            "validatedCount": sum(
                item.get("stage") in {"validated", "indexed"}
                for item in active_artifacts
            ),
            "indexedCount": sum(
                item.get("stage") == "indexed" for item in active_artifacts
            ),
            "failedCount": sum(
                item.get("stage") == "failed" for item in active_artifacts
            ),
        }
        state = (
            "failed"
            if counts["failedCount"]
            else "indexed"
            if counts["indexedCount"] == counts["receivedCount"]
            else "validated"
            if counts["validatedCount"] == counts["receivedCount"]
            else "parsed"
            if counts["parsedCount"] == counts["receivedCount"]
            else "received"
        )
        replacement = {
            **existing,
            **source_key,
            "state": state,
            **counts,
            "entityEventCount": sum(
                int(item.get("eventCount", 0)) for item in active_artifacts
            ),
            "manifestChecksum": _manifest_checksum(active_artifacts),
            "artifacts": active_artifacts,
            "reclassifiedArtifacts": audits,
            "parserVersion": PARSER_VERSION,
            "updatedAt": now,
            "version": version + 1,
        }
        try:
            table.put_item(
                Item=replacement,
                ConditionExpression="#version = :expectedVersion",
                ExpressionAttributeNames={"#version": "version"},
                ExpressionAttributeValues={":expectedVersion": version},
            )
            return replacement
        except ClientError as write_error:
            if not _conditional_failure(write_error):
                raise
    raise RuntimeError(
        f"Unable to reclassify manifest artifact for {market_date}/{source_product_id}"
    )


def persist_snapshot_intelligence(
    snapshot: Dict[str, Any],
    dynamodb: Any,
    *,
    content_sha256: Optional[str] = None,
    finalize: bool = True,
    replace_existing: bool = False,
) -> int:
    events = build_entity_events(snapshot, content_sha256=content_sha256)
    product_id = str(
        snapshot.get("snapshotType") or snapshot.get("reportType") or "unknown"
    )
    definition = product_definition(product_id)
    # Tracker HTML frequently contains charts but not the published Trade
    # table. Do not issue an indexed manifest for that auxiliary artifact; the
    # PDF parser must provide at least one structured Trade signal.
    tracker_without_signals = definition.get("validationRule") == "published_tracker_rows" and not any(
        event.get("eventType") == "trend_signal" and event.get("signalValue")
        for event in events
    )
    update_product_manifest(
        snapshot,
        dynamodb,
        stage="received",
        content_sha256=content_sha256,
        replace_existing=replace_existing,
    )
    update_product_manifest(
        snapshot,
        dynamodb,
        stage="parsed",
        content_sha256=content_sha256,
    )
    if tracker_without_signals:
        return 0
    update_product_manifest(
        snapshot,
        dynamodb,
        stage="validated",
        content_sha256=content_sha256,
        event_count=len(events),
    )
    persist_entity_events(events, dynamodb)
    if finalize:
        finalize_snapshot_intelligence(
            snapshot,
            dynamodb,
            content_sha256=content_sha256,
            event_count=len(events),
        )
    return len(events)


def finalize_snapshot_intelligence(
    snapshot: Dict[str, Any],
    dynamodb: Any,
    *,
    content_sha256: Optional[str] = None,
    event_count: int = 0,
) -> Dict[str, Any]:
    """Mark an artifact indexed only after its primary projection succeeds."""
    manifest = update_product_manifest(
        snapshot, dynamodb, stage="indexed", content_sha256=content_sha256, event_count=event_count,
    )
    from analyst_change_journal import emit_change
    emit_change(snapshot, dynamodb, manifest, build_entity_events(snapshot, content_sha256=content_sha256), content_sha256)
    return manifest



def persist_snapshot_failure(
    snapshot: Dict[str, Any],
    dynamodb: Any,
    *,
    content_sha256: Optional[str] = None,
    error: Exception | str,
) -> Dict[str, Any]:
    return update_product_manifest(
        snapshot,
        dynamodb,
        stage="failed",
        content_sha256=content_sha256,
        error=str(error),
    )
