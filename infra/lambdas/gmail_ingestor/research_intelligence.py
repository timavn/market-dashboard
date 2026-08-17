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
from pathlib import Path
from typing import Any, Dict, Iterable, Iterator, List, Optional, Tuple

from boto3.dynamodb.conditions import Key
from boto3.dynamodb.types import TypeSerializer
from botocore.exceptions import ClientError


MODULE_DIR = Path(__file__).resolve().parent
ENTITY_EVENTS_TABLE = os.environ.get(
    "RESEARCH_ENTITY_EVENTS_TABLE",
    "ResearchEntityEventsV1",
)
PRODUCT_MANIFEST_TABLE = os.environ.get(
    "RESEARCH_PRODUCT_MANIFEST_TABLE",
    "ResearchProductManifestsV1",
)
PARSER_VERSION = "security-intelligence-v4-authoritative-tracker"
MAX_MANIFEST_WRITE_RETRIES = 4
MAX_BODY_TEXT_LENGTH = 40_000
MAX_REPLACED_ENTITY_EVENTS = 500
TRANSACT_WRITE_LIMIT = 100
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
RESERVED_TOKENS = {
    str(token).upper() for token in ENTITY_CATALOG.get("reservedTokens", [])
}
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
        "PM",
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


def canonical_ticker(value: Any) -> Optional[str]:
    if isinstance(value, dict):
        value = value.get("ticker") or value.get("symbol") or value.get("asset")
    raw = str(value or "").strip()
    if not raw:
        return None

    parenthesized = re.findall(r"\(([A-Z][A-Z0-9./-]{0,11})\)", raw.upper())
    candidate = parenthesized[-1] if parenthesized else raw.upper()
    candidate = ALIAS_TO_TICKER.get(candidate, candidate)
    if candidate in RESERVED_TOKENS:
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


def _event_kind(product_id: str, path: str) -> str:
    lowered = path.lower()
    if product_id == "risk-ranges":
        return "risk_range"
    if product_id == "early-look":
        return "supplemental_risk_range"
    if product_id == "signal-strength":
        if "added" in lowered:
            return "signal_strength_added"
        if "removed" in lowered:
            return "signal_strength_removed"
        return "signal_strength_membership"
    if product_id in {"momo-tracker", "bitcoin-trend-tracker"}:
        return "trade_signal"
    if product_id == "portfolio-solutions":
        return "portfolio_rank"
    if product_id in {"the-call", "the-macro-show"}:
        return "position_reference"
    if product_id in {"real-time-alert", "investing-ideas", "etf-pro"}:
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

    def signal_value(value: Dict[str, Any]) -> Any:
        for key in ("trade", "tradeBias", "signal", "trend"):
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
            ticker = canonical_ticker(key)
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
            ticker = canonical_ticker(direct_value)
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
                child_path = f"{path}.{key}"
                key_ticker = canonical_ticker(key)
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
                    ticker = canonical_ticker(child)
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


def extract_entity_references(snapshot: Dict[str, Any]) -> List[Dict[str, Any]]:
    product_id = str(
        snapshot.get("snapshotType") or snapshot.get("reportType") or "unknown"
    )
    references = _structured_ticker_references(snapshot, product_id)
    if product_id in AUTHORITATIVE_TRACKER_PRODUCTS:
        # Tracker Trade rows are the only decision-grade authority. OCR prose,
        # chart labels, image names, and neighboring JSON keys must never be
        # promoted into ticker signals.
        return _deduplicate_entity_references(
            reference
            for reference in references
            if reference.get("eventType") == "trade_signal"
            and reference.get("value") in AUTHORITATIVE_TRACKER_TRENDS
        )
    searchable = {
        "article": snapshot.get("article") or {},
        "data": snapshot.get("data") or {},
        "trendChanges": snapshot.get("trendChanges") or [],
    }

    ticker_token_pattern = re.compile(r"\b[A-Z][A-Z0-9./-]{1,11}\b")

    for path, text in _iter_content_blocks(searchable):
        occupied: set[Tuple[str, str]] = set()

        for ticker, aliases in ALIASES_BY_TICKER.items():
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
            **(
                {"signalValue": reference["value"]}
                if reference.get("value") is not None
                else {}
            ),
        }
        if reference.get("exposureType"):
            event["exposureType"] = reference["exposureType"]
            event["exposureId"] = reference["exposureId"]
            event["exposureLabel"] = reference["exposureLabel"]
        if product_id in {"risk-ranges", "early-look"}:
            event["decisionEligible"] = False
            event["verificationStatus"] = (
                "requires-primary-publication-manifest"
                if product_id == "risk-ranges"
                else "supplemental-only"
            )
        elif definition.get("authorities", {}).get("trade"):
            event["decisionEligible"] = bool(event.get("signalValue"))
        events.append(event)
    return events


def _conditional_failure(error: ClientError) -> bool:
    return (
        error.response.get("Error", {}).get("Code")
        == "ConditionalCheckFailedException"
    )


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
        item = {key: value for key, value in event.items() if value is not None}
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


def replace_artifact_entity_projection(
    snapshot: Dict[str, Any],
    dynamodb: Any,
    *,
    content_sha256: str,
) -> int:
    """Remove only the prior entity projection for one immutable artifact.

    This is used exclusively by the authenticated operator version-replay path.
    Exact message and content-hash conditions prevent a parser migration from
    deleting another publication's projection.
    """
    market_date = str(snapshot.get("date") or "")[:10]
    source_message_id = str(snapshot.get("gmailMessageId") or "")
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", market_date):
        raise ValueError("Entity projection replacement requires a valid market date")
    if not source_message_id:
        raise ValueError("Entity projection replacement requires a source message")
    if not re.fullmatch(r"[0-9a-f]{64}", str(content_sha256 or "")):
        raise ValueError("Entity projection replacement requires an exact content hash")

    table = dynamodb.Table(ENTITY_EVENTS_TABLE)
    rows: List[Dict[str, Any]] = []
    last_key = None
    while True:
        request: Dict[str, Any] = {
            "IndexName": "marketDate-index",
            "KeyConditionExpression": Key("marketDate").eq(market_date),
        }
        if last_key:
            request["ExclusiveStartKey"] = last_key
        response = table.query(**request)
        rows.extend(
            row
            for row in response.get("Items", [])
            if row.get("sourceMessageId") == source_message_id
            and row.get("contentSha256") == content_sha256
        )
        last_key = response.get("LastEvaluatedKey")
        if not last_key:
            break

    if len(rows) > MAX_REPLACED_ENTITY_EVENTS:
        raise RuntimeError("Entity projection replacement exceeded its bounded scope")
    if not rows:
        return 0
    if any(not row.get("entityKey") or not row.get("eventKey") for row in rows):
        raise RuntimeError("Entity projection replacement found an invalid primary key")

    # The market-date index is eventually consistent. Resolve every candidate
    # through a strongly consistent primary-key read before issuing deletes so
    # a fast retry cannot be tripped by stale index entries from a prior batch.
    verified_rows: List[Dict[str, Any]] = []
    for row in rows:
        current = table.get_item(
            Key={"entityKey": row["entityKey"], "eventKey": row["eventKey"]},
            ConsistentRead=True,
        ).get("Item")
        if not current:
            continue
        if (
            current.get("sourceMessageId") != source_message_id
            or current.get("contentSha256") != content_sha256
        ):
            raise RuntimeError("Entity projection changed during replacement")
        verified_rows.append(current)
    rows = verified_rows
    if not rows:
        return 0

    serializer = TypeSerializer()
    client = dynamodb.meta.client
    for offset in range(0, len(rows), TRANSACT_WRITE_LIMIT):
        chunk = rows[offset : offset + TRANSACT_WRITE_LIMIT]
        transaction = [
            {
                "Delete": {
                    "TableName": ENTITY_EVENTS_TABLE,
                    "Key": {
                        "entityKey": serializer.serialize(row["entityKey"]),
                        "eventKey": serializer.serialize(row["eventKey"]),
                    },
                    "ConditionExpression": (
                        "#sourceMessageId = :sourceMessageId AND "
                        "#contentSha256 = :contentSha256"
                    ),
                    "ExpressionAttributeNames": {
                        "#sourceMessageId": "sourceMessageId",
                        "#contentSha256": "contentSha256",
                    },
                    "ExpressionAttributeValues": {
                        ":sourceMessageId": serializer.serialize(source_message_id),
                        ":contentSha256": serializer.serialize(content_sha256),
                    },
                }
            }
            for row in chunk
        ]
        token_material = "|".join(
            [
                PARSER_VERSION,
                content_sha256,
                *[
                    f"{row['entityKey']}#{row['eventKey']}"
                    for row in chunk
                ],
            ]
        )
        client.transact_write_items(
            TransactItems=transaction,
            ClientRequestToken=hashlib.sha256(
                token_material.encode("utf-8")
            ).hexdigest()[:36],
        )
    return len(rows)


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
        artifact = {
            **previous,
            "artifactId": artifact_id,
            "stage": effective_stage,
            "stageHistory": stage_history[-50:],
            "sourceMessageId": snapshot.get("gmailMessageId"),
            "sourceKey": snapshot.get("htmlSource") or snapshot.get("pdfS3Key"),
            "publishedAt": snapshot.get("publishedAt"),
            "parserVersion": PARSER_VERSION,
            "eventCount": (
                int(event_count)
                if replace_existing
                else max(int(previous.get("eventCount", 0)), int(event_count))
            ),
            "updatedAt": now,
        }
        if content_sha256:
            artifact["contentSha256"] = content_sha256
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
        item = {
            **key,
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
            table.put_item(**kwargs)
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
    if replace_existing:
        replace_artifact_entity_projection(
            snapshot,
            dynamodb,
            content_sha256=str(content_sha256 or ""),
        )
    product_id = str(
        snapshot.get("snapshotType") or snapshot.get("reportType") or "unknown"
    )
    definition = product_definition(product_id)
    # Tracker HTML frequently contains charts but not the published Trade
    # table. Do not issue an indexed manifest for that auxiliary artifact; the
    # PDF parser must provide at least one structured Trade signal.
    tracker_without_signals = definition.get("authorities", {}).get("trade") and not any(
        event.get("eventType") == "trade_signal" and event.get("signalValue")
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
    return update_product_manifest(
        snapshot,
        dynamodb,
        stage="indexed",
        content_sha256=content_sha256,
        event_count=event_count,
    )


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
