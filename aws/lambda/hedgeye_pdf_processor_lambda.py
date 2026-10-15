#!/usr/bin/env python3
"""Completion-safe Hedgeye PDF processor.

The Gmail ingestor invokes this Lambda after writing an immutable PDF below
``hedgeye-uploads/``. Every job either reaches INDEXED in both the attachment
ledger and product manifest or raises so Lambda retries/DLQ behavior remains
effective. Existing daily snapshots are still written for compatibility, while
immutable entity events preserve multiple same-product publications per day.
"""

from __future__ import annotations

import hashlib
import inspect
import json
import os
import re
import tempfile
import traceback
import urllib.parse
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, Iterator, List, Optional, Tuple

import boto3
from botocore.exceptions import ClientError

import parse_bitcoin_tracker as bitcoin_tracker_parser
from date_utils import extract_date_from_pdf
from parse_cftc import extract_cftc_data, save_audit_to_dynamodb as save_cftc_audit
from parse_early_look import extract_early_look
from parse_hedgeye_pdf import extract_all_risk_range_data
from parse_macro_show import extract_macro_show, save_to_dynamodb as save_macro_show
from parse_momo_tracker import extract_momo_tracker, save_to_dynamodb as save_momo
from parse_portfolio_solutions import (
    extract_portfolio_solutions,
    save_to_dynamodb as save_portfolio,
)
from parse_signal_strength import (
    extract_signal_strength,
    save_to_dynamodb as save_signal,
)
from parse_the_call import extract_the_call, save_to_dynamodb as save_the_call
from parse_volume import extract_volume_snapshot, save_to_dynamodb as save_volume

save_bitcoin = bitcoin_tracker_parser.save_to_dynamodb


AWS_REGION = os.environ.get("AWS_REGION", os.environ.get("AWS_DEFAULT_REGION", "us-west-1"))
LEDGER_TABLE = os.environ.get("HERMES_LEDGER_TABLE", "HermesEmailIngestLedger")
ENTITY_EVENTS_TABLE = os.environ.get(
    "RESEARCH_ENTITY_EVENTS_TABLE",
    "ResearchEntityEventsV1",
)
PRODUCT_MANIFEST_TABLE = os.environ.get(
    "RESEARCH_PRODUCT_MANIFEST_TABLE",
    "ResearchProductManifestsV1",
)
DAILY_SNAPSHOT_TABLE = os.environ.get(
    "HEDGEYE_DAILY_SNAPSHOT_TABLE",
    "HedgeyeDailySnapshot",
)
PARSER_VERSION = "hedgeye-pdf-security-intelligence-v1"
TEXTRACT_LEDGER_ATTACHMENT_ID = "__TEXTRACT_CONTENT__"
MAX_MANIFEST_RETRIES = 4
MANIFEST_STAGES = {"received", "parsed", "validated", "indexed", "failed"}

s3 = boto3.client("s3", region_name=AWS_REGION)
dynamodb = boto3.resource("dynamodb", region_name=AWS_REGION)


def _load_product_registry() -> Dict[str, Any]:
    candidates = [
        Path(__file__).resolve().with_name("research_products.json"),
        (
            Path(__file__).resolve().parents[2]
            / "infra"
            / "lambdas"
            / "gmail_ingestor"
            / "research_products.json"
        ),
    ]
    for path in candidates:
        if path.is_file():
            with path.open("r", encoding="utf-8") as handle:
                return json.load(handle)
    raise RuntimeError("Canonical research_products.json is not bundled")


PRODUCT_REGISTRY = _load_product_registry()
PRODUCTS_BY_ID = {
    product["id"]: product for product in PRODUCT_REGISTRY.get("products", [])
}


Extractor = Callable[..., Any]
Saver = Callable[..., Any]


def _nonempty(value: Any) -> bool:
    if isinstance(value, dict):
        return any(_nonempty(child) for child in value.values())
    if isinstance(value, (list, tuple, set)):
        return any(_nonempty(child) for child in value)
    return value not in (None, "")


def _save_early_look_snapshot(
    data: Dict[str, Any],
    pdf_s3_key: Optional[str] = None,
    pdf_date: Optional[str] = None,
) -> None:
    """Preserve the compatibility snapshot without promoting supplemental ranges.

    The legacy Early Look saver also writes HedgeyeRiskRanges and RiskRangeData.
    Those are primary/decision-grade stores, so supplemental Early Look data must
    never pass through that saver.
    """
    if not data or not pdf_date:
        raise ValueError("Early Look snapshot requires parsed data and pdf_date")
    now = datetime.now(timezone.utc)
    item = {
        "date": pdf_date,
        "snapshotType": "early-look",
        "riskRangeCount": len(data),
        "data": {
            ticker: {
                "lrr": Decimal(str(detail["lrr"])),
                "hrr": Decimal(str(detail["hrr"])),
                "trend": detail["trend"],
                "timestamp": detail.get("timestamp") or now.isoformat(),
                "index": detail.get("index", 999),
                "decisionEligible": False,
            }
            for ticker, detail in data.items()
        },
        "scrapedAt": now.isoformat(),
        "source": "hedgeye-early-look-pdf",
        "decisionEligible": False,
        "ttl": int(now.timestamp() + (730 * 24 * 60 * 60)),
    }
    if pdf_s3_key:
        item["pdfSource"] = pdf_s3_key
    dynamodb.Table(DAILY_SNAPSHOT_TABLE).put_item(Item=_decimalize(item))


def _save_risk_range_candidate_snapshot(
    data: Dict[str, Any],
    pdf_s3_key: Optional[str] = None,
    pdf_date: Optional[str] = None,
) -> None:
    """Retain parsed primary-PDF content without bypassing verified authority.

    Decision-grade ranges are published only by the existing
    RiskRangePublicationManifestsV2 transaction. This compatibility record uses
    a separate snapshot type, so parsing a PDF cannot overwrite that verified
    current-day projection or populate primary range tables by itself.
    """
    ranges = data.get("riskRanges") if isinstance(data, dict) else None
    if not ranges or not pdf_date:
        raise ValueError("Risk Range candidate requires parsed rows and pdf_date")
    now = datetime.now(timezone.utc)
    item = {
        "date": pdf_date,
        "snapshotType": "risk-ranges-pdf-candidate",
        "sourcePublicationType": "risk-ranges",
        "riskRangeCount": len(ranges),
        "trendChanges": data.get("trendChanges") or [],
        "outbucket": data.get("outbucket") or [],
        "data": {
            ticker: {
                "name": detail.get("name"),
                "lrr": Decimal(str(detail["buyTrade"])),
                "hrr": Decimal(str(detail["sellTrade"])),
                "prevClose": Decimal(str(detail.get("prevClose", 0))),
                "trend": detail["trend"],
                "timestamp": detail.get("ts") or now.isoformat(),
                "index": detail.get("index", 0),
                "decisionEligible": False,
            }
            for ticker, detail in ranges.items()
        },
        "scrapedAt": now.isoformat(),
        "source": "hedgeye-risk-ranges-pdf-candidate",
        "verificationStatus": "requires-primary-publication-manifest",
        "decisionEligible": False,
        "ttl": int(now.timestamp() + (730 * 24 * 60 * 60)),
    }
    if pdf_s3_key:
        item["pdfSource"] = pdf_s3_key
    dynamodb.Table(DAILY_SNAPSHOT_TABLE).put_item(Item=_decimalize(item))


def _extract_bitcoin_tracker_with_pdf_pages(
    pdf_path: str,
    s3_key: Optional[str] = None,
) -> Dict[str, Any]:
    """Send single-page PDF bytes to Textract without a Poppler dependency."""
    original_converter = bitcoin_tracker_parser.convert_page_to_image_bytes

    def page_pdf_bytes(path: str, page_number: int) -> bytes:
        return bitcoin_tracker_parser.extract_specific_pages_as_pdf(
            path,
            [page_number],
        )

    bitcoin_tracker_parser.convert_page_to_image_bytes = page_pdf_bytes
    try:
        return bitcoin_tracker_parser.extract_bitcoin_tracker(
            pdf_path,
            s3_key=s3_key,
        )
    finally:
        bitcoin_tracker_parser.convert_page_to_image_bytes = original_converter


PARSERS: Dict[str, Tuple[Extractor, Saver]] = {
    "risk-ranges": (
        extract_all_risk_range_data,
        _save_risk_range_candidate_snapshot,
    ),
    "bitcoin-trend-tracker": (
        _extract_bitcoin_tracker_with_pdf_pages,
        save_bitcoin,
    ),
    "early-look": (extract_early_look, _save_early_look_snapshot),
    "portfolio-solutions": (extract_portfolio_solutions, save_portfolio),
    "momo-tracker": (extract_momo_tracker, save_momo),
    "signal-strength": (extract_signal_strength, save_signal),
    "the-macro-show": (extract_macro_show, save_macro_show),
    "the-call": (extract_the_call, save_the_call),
    "volume": (extract_volume_snapshot, save_volume),
    "cftc-positioning": (extract_cftc_data, save_cftc_audit),
}

REGISTERED_PDF_PRODUCTS = {
    product["id"]
    for product in PRODUCT_REGISTRY.get("products", [])
    if "pdf" in product.get("parserModes", [])
}
if set(PARSERS) != REGISTERED_PDF_PRODUCTS:
    raise RuntimeError(
        "PDF parser registry drift: "
        f"implemented={sorted(PARSERS)} registered={sorted(REGISTERED_PDF_PRODUCTS)}"
    )
for product_id, (extractor, _saver) in PARSERS.items():
    registered_parser_id = (
        PRODUCTS_BY_ID.get(product_id, {}).get("parsers", {}).get("pdf")
    )
    if registered_parser_id != extractor.__name__:
        raise RuntimeError(
            "PDF parser identity drift for "
            f"{product_id}: implemented={extractor.__name__!r} "
            f"registered={registered_parser_id!r}"
        )

DETECTION_RULES = [
    (
        product["id"],
        tuple(str(term).lower() for term in product.get("matchTerms", [])),
    )
    for product in PRODUCT_REGISTRY.get("products", [])
    if product["id"] in PARSERS
]

RESERVED_TICKERS = {
    "ADD",
    "ADDED",
    "BEARISH",
    "BULLISH",
    "BUY",
    "CALL",
    "CLOSE",
    "COVER",
    "CRYPTOS",
    "DATA",
    "ETF",
    "HTML",
    "LONG",
    "LONGS",
    "LRR",
    "METRICS",
    "PDF",
    "REMOVE",
    "REMOVED",
    "SELL",
    "SHORT",
    "SHORTS",
    "SIGNAL",
    "STOCKS",
    "SUMMARY",
    "TRADE",
    "TREND",
    "USD",
}

TRACKER_PRODUCTS = {"momo-tracker", "bitcoin-trend-tracker"}
METADATA_ONLY_KEYS = {
    "capturedat",
    "contenthash",
    "contentsha256",
    "createdat",
    "date",
    "gmailmessageid",
    "htmlsource",
    "methodologyversion",
    "parserversion",
    "pdfs3key",
    "publishedat",
    "receivedat",
    "scrapedat",
    "source",
    "sourceeventid",
    "timestamp",
    "ttl",
    "updatedat",
}


def _security_record(value: Any) -> bool:
    if not isinstance(value, dict):
        return False
    return any(
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


def _iter_security_records(value: Any) -> Iterator[Dict[str, Any]]:
    if isinstance(value, dict):
        if _security_record(value):
            yield value
        for child in value.values():
            yield from _iter_security_records(child)
    elif isinstance(value, list):
        for child in value:
            yield from _iter_security_records(child)


def _tracker_signal(value: Dict[str, Any]) -> Optional[Any]:
    for key in ("trade", "tradeBias", "signal", "trend"):
        if value.get(key) is not None:
            return value[key]
    return None


def _has_entity_row(value: Any) -> bool:
    if isinstance(value, dict):
        direct = value.get("ticker") or value.get("symbol") or value.get("asset")
        if _canonical_ticker(direct):
            return True
        for key, child in value.items():
            if _canonical_ticker(key) and _security_record(child):
                return True
            if _has_entity_row(child):
                return True
        return False
    if isinstance(value, list):
        return any(
            bool(_canonical_ticker(child))
            if isinstance(child, str)
            else _has_entity_row(child)
            for child in value
        )
    return False


def _has_searchable_content(value: Any, key: str = "") -> bool:
    normalized_key = str(key or "").lower()
    if (
        normalized_key in METADATA_ONLY_KEYS
        or normalized_key.endswith("count")
    ):
        return False
    if isinstance(value, dict):
        return any(
            _has_searchable_content(child, str(child_key))
            for child_key, child in value.items()
        )
    if isinstance(value, (list, tuple, set)):
        return any(_has_searchable_content(child, key) for child in value)
    if isinstance(value, str):
        text = value.strip()
        return bool(
            text
            and not text.startswith(("http://", "https://", "s3://"))
        )
    return value is not None


def _validate_product_data(product_id: str, data: Any) -> None:
    """Apply the canonical product registry's validation rule fail closed."""
    if not _nonempty(data):
        raise ValueError(f"{product_id} parser extracted no usable data")
    definition = PRODUCTS_BY_ID.get(product_id)
    if not definition or "pdf" not in definition.get("parserModes", []):
        raise ValueError(f"{product_id} has no registered PDF parser")
    rule = definition.get("validationRule")
    if rule not in PRODUCT_REGISTRY.get("validationRules", {}):
        raise ValueError(f"{product_id} has no recognized validation rule")

    if rule == "primary_risk_ranges":
        ranges = data.get("riskRanges") if isinstance(data, dict) else None
        if not isinstance(ranges, dict) or not ranges:
            raise ValueError("risk-ranges parser extracted no primary risk ranges")
        if not any(
            isinstance(detail, dict)
            and detail.get("trend")
            and "buyTrade" in detail
            and "sellTrade" in detail
            for detail in ranges.values()
        ):
            raise ValueError("risk-ranges parser extracted no validated LRR/HRR records")

    elif rule == "supplemental_risk_ranges":
        if not isinstance(data, dict) or not any(
            isinstance(detail, dict)
            and detail.get("trend")
            and "lrr" in detail
            and "hrr" in detail
            for detail in data.values()
        ):
            raise ValueError("early-look parser extracted no supplemental LRR/HRR records")

    elif rule in {"published_trade_signals", "published_tracker_rows"}:
        # Trackers publish Trend (and sometimes Trade) per row; the registry's
        # "published_tracker_rows" rule accepts either published reading.
        if not any(
            _tracker_signal(record) for record in _iter_security_records(data)
        ):
            raise ValueError(
                f"{product_id} parser extracted no published Trade or Trend signals"
            )
    elif rule == "portfolio_rankings":
        rankings = data.get("rankings") if isinstance(data, dict) else None
        if not isinstance(rankings, list) or not any(
            isinstance(row, dict)
            and _canonical_ticker(row.get("ticker"))
            and row.get("rank") is not None
            for row in rankings
        ):
            raise ValueError(
                "portfolio-solutions parser extracted no validated ranking rows"
            )
    elif rule == "signal_strength_membership":
        stocks = data.get("stocks") if isinstance(data, dict) else None
        if not isinstance(stocks, list) or not any(
            _canonical_ticker(row) for row in stocks
        ):
            raise ValueError(
                "signal-strength parser extracted no validated membership rows"
            )
        reported_count = data.get("reportedStockCount") if isinstance(data, dict) else None
        if reported_count is not None and len(stocks) != int(reported_count):
            raise ValueError(
                "signal-strength parser extracted a partial membership list"
            )
    elif rule == "volume_metrics":
        metrics = data.get("metrics") if isinstance(data, dict) else None
        required_groups = ("totalMarket", "exchange")
        if not isinstance(metrics, dict) or not all(
            isinstance(metrics.get(group), dict)
            and any(
                value is not None
                for key, value in metrics[group].items()
                if str(key).lower().startswith("pct")
            )
            for group in required_groups
        ):
            raise ValueError("volume parser extracted no validated market metrics")
    elif rule == "cftc_metrics":
        metrics = data.get("metrics") if isinstance(data, dict) else None
        if not isinstance(metrics, list) or not any(
            isinstance(row, dict)
            and str(row.get("metric") or "").strip()
            and row.get("latest") is not None
            for row in metrics
        ):
            raise ValueError("cftc parser extracted no validated metric rows")
    elif rule == "entity_rows":
        if not _has_entity_row(data):
            raise ValueError(f"{product_id} parser extracted no valid entity rows")
    elif rule == "non_empty":
        if not _has_searchable_content(data):
            raise ValueError(
                f"{product_id} parser retained metadata but no searchable content"
            )
    else:
        raise ValueError(f"{product_id} validation rule is unsupported: {rule}")


def detect_pdf_type(name_or_key: str) -> Optional[str]:
    lowered = str(name_or_key or "").lower()
    for product_id, terms in DETECTION_RULES:
        if any(term in lowered for term in terms):
            return product_id
    return None


def _decimalize(value: Any) -> Any:
    if isinstance(value, float):
        return Decimal(str(value))
    if isinstance(value, list):
        return [_decimalize(item) for item in value]
    if isinstance(value, dict):
        return {key: _decimalize(item) for key, item in value.items()}
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


def _conditional_failure(error: ClientError) -> bool:
    return (
        error.response.get("Error", {}).get("Code")
        == "ConditionalCheckFailedException"
    )


def _canonical_ticker(value: Any) -> Optional[str]:
    if isinstance(value, dict):
        value = value.get("ticker") or value.get("symbol") or value.get("asset")
    raw = str(value or "").strip().upper()
    parenthesized = re.findall(r"\(([A-Z][A-Z0-9./-]{0,11})\)", raw)
    candidate = parenthesized[-1] if parenthesized else raw
    if candidate == "BITCOIN":
        candidate = "BTC"
    if candidate in RESERVED_TICKERS:
        return None
    if not re.fullmatch(r"[A-Z][A-Z0-9./-]{0,11}", candidate):
        return None
    return candidate


def _direction(path: str, value: Any) -> Optional[str]:
    text = f"{path} {value}".lower()
    if any(token in text for token in ("removed", "short", "bear", "sell")):
        return "negative"
    if any(token in text for token in ("added", "long", "bull", "buy")):
        return "positive"
    if "neutral" in text:
        return "neutral"
    return None


def _event_type(product_id: str, path: str) -> str:
    lowered = path.lower()
    if product_id == "risk-ranges":
        return "risk_range"
    if product_id == "early-look":
        return "supplemental_risk_range"
    if product_id in {"momo-tracker", "bitcoin-trend-tracker"}:
        return "trade_signal"
    if product_id == "signal-strength":
        if "added" in lowered:
            return "signal_strength_added"
        if "removed" in lowered:
            return "signal_strength_removed"
        return "signal_strength_membership"
    if product_id == "portfolio-solutions":
        return "portfolio_rank"
    if product_id in {"the-call", "the-macro-show"}:
        return "position_reference"
    return "mention"


def _iter_ticker_references(
    value: Any,
    path: str = "data",
) -> Iterator[Tuple[str, str, str, Optional[str], Optional[str]]]:
    """Yield ticker, field path, excerpt, direction, and raw tracker signal."""
    if isinstance(value, dict):
        direct = value.get("ticker") or value.get("symbol") or value.get("asset")
        ticker = _canonical_ticker(direct)
        if ticker:
            excerpt = json.dumps(value, sort_keys=True, default=str)[:700]
            signal_value = _tracker_signal(value)
            yield ticker, path, excerpt, _direction(path, value), (
                str(signal_value) if signal_value is not None else None
            )

        for key, child in value.items():
            child_path = f"{path}.{key}"
            key_ticker = _canonical_ticker(key)
            if key_ticker and _security_record(child):
                excerpt = f"{key}: {json.dumps(child, sort_keys=True, default=str)}"[:700]
                signal_value = _tracker_signal(child)
                yield key_ticker, child_path, excerpt, _direction(child_path, child), (
                    str(signal_value) if signal_value is not None else None
                )
            yield from _iter_ticker_references(child, child_path)
        return

    if isinstance(value, list):
        for index, child in enumerate(value):
            child_path = f"{path}[{index}]"
            if isinstance(child, str):
                ticker = _canonical_ticker(child)
                if ticker:
                    yield ticker, child_path, child[:700], _direction(path, child), None
            else:
                yield from _iter_ticker_references(child, child_path)
        return

    if isinstance(value, str):
        seen = set()
        for match in re.finditer(r"\(([A-Z][A-Z0-9./-]{0,11})\)|\b([A-Z][A-Z0-9./-]{1,11})\b", value):
            ticker = _canonical_ticker(match.group(1) or match.group(2))
            if not ticker or ticker in seen:
                continue
            seen.add(ticker)
            left = max(0, match.start() - 150)
            right = min(len(value), match.end() + 150)
            excerpt = value[left:right].strip()
            yield ticker, path, excerpt[:700], _direction(path, value), None


def build_entity_events(
    *,
    product_id: str,
    market_date: str,
    data: Any,
    content_sha256: str,
    message_id: Optional[str],
    s3_key: str,
    published_at: Optional[str] = None,
) -> List[Dict[str, Any]]:
    published_at = str(published_at or f"{market_date}T00:00:00+00:00")
    events: Dict[str, Dict[str, Any]] = {}
    for ticker, path, excerpt, direction, signal_value in _iter_ticker_references(data):
        identity = "|".join(
            [product_id, market_date, content_sha256, ticker, path, excerpt]
        )
        event_id = hashlib.sha256(identity.encode("utf-8")).hexdigest()
        event_key = f"{market_date}#{published_at}#{product_id}#{event_id}"
        item = {
            "entityKey": f"ticker#{ticker}",
            "eventKey": event_key,
            "marketDate": market_date,
            "dateEventKey": (
                f"{product_id}#{published_at}#ticker#{ticker}#{event_id}"
            ),
            "schemaVersion": 1,
            "productKey": product_id,
            "eventType": _event_type(product_id, path),
            "direction": direction,
            "excerpt": excerpt,
            "matchedText": ticker,
            "matchType": "structured_membership",
            "fieldPath": path,
            "entityType": "ticker",
            "entityId": ticker,
            "publishedAt": published_at,
            "ingestedAt": datetime.now(timezone.utc).isoformat(),
            "sourceEventId": content_sha256,
            "sourceMessageId": message_id,
            "sourceArtifact": s3_key,
            "contentSha256": content_sha256,
            "parserVersion": PARSER_VERSION,
            "qualityStatus": "validated",
        }
        if signal_value:
            item["signalValue"] = signal_value
        if product_id in {"risk-ranges", "early-look", "cftc-positioning"}:
            item["decisionEligible"] = False
            item["verificationStatus"] = (
                "requires-primary-publication-manifest"
                if product_id == "risk-ranges"
                else "official-cftc-required"
                if product_id == "cftc-positioning"
                else "supplemental-only"
            )
        elif product_id in TRACKER_PRODUCTS:
            item["decisionEligible"] = bool(signal_value)
        events[event_id] = {key: value for key, value in item.items() if value is not None}
    return list(events.values())


def persist_entity_events(events: Iterable[Dict[str, Any]]) -> int:
    table = dynamodb.Table(ENTITY_EVENTS_TABLE)
    written = 0
    for event in events:
        try:
            table.put_item(
                Item=_decimalize(event),
                ConditionExpression=(
                    "attribute_not_exists(entityKey) AND attribute_not_exists(eventKey)"
                ),
            )
            written += 1
        except ClientError as error:
            if not _conditional_failure(error):
                raise
    return written


def _manifest_snapshot(
    *,
    product_id: str,
    market_date: str,
    artifact_id: str,
    stage: str,
    s3_key: str,
    message_id: Optional[str],
    attachment_id: Optional[str],
    published_at: Optional[str] = None,
    event_count: int = 0,
    error: Optional[str] = None,
) -> Dict[str, Any]:
    if stage not in MANIFEST_STAGES:
        raise ValueError(f"Unsupported manifest stage: {stage}")
    table = dynamodb.Table(PRODUCT_MANIFEST_TABLE)
    key = {"marketDate": market_date, "productKey": product_id}
    now = datetime.now(timezone.utc).isoformat()
    for _ in range(MAX_MANIFEST_RETRIES):
        existing = table.get_item(Key=key, ConsistentRead=True).get("Item") or {}
        version = int(existing.get("version", 0))
        artifacts = {
            str(item.get("artifactId")): dict(item)
            for item in existing.get("artifacts", [])
            if item.get("artifactId")
        }
        previous = artifacts.get(artifact_id, {})
        effective_stage = (
            "indexed"
            if previous.get("stage") == "indexed" and stage != "indexed"
            else stage
        )
        stage_history = list(previous.get("stageHistory") or [])
        transition = {"stage": stage, "at": now}
        if error:
            transition["error"] = str(error)[:1000]
        stage_history.append(transition)
        artifact = {
            **previous,
            "artifactId": artifact_id,
            "contentSha256": artifact_id,
            "stage": effective_stage,
            "stageHistory": stage_history[-50:],
            "sourceKey": s3_key,
            "sourceMessageId": message_id,
            "sourceAttachmentId": attachment_id,
            "publishedAt": published_at,
            "parserVersion": PARSER_VERSION,
            "eventCount": max(int(previous.get("eventCount", 0)), event_count),
            "updatedAt": now,
        }
        if product_id in {"risk-ranges", "early-look", "cftc-positioning"}:
            artifact["decisionEligible"] = False
            artifact["verificationStatus"] = (
                "requires-primary-publication-manifest"
                if product_id == "risk-ranges"
                else "official-cftc-required"
                if product_id == "cftc-positioning"
                else "supplemental-only"
            )
        if error and effective_stage != "indexed":
            artifact["error"] = str(error)[:1000]
        else:
            artifact.pop("error", None)
        artifacts[artifact_id] = {
            key: value for key, value in artifact.items() if value is not None
        }
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
        try:
            kwargs: Dict[str, Any] = {"Item": _decimalize(item)}
            if existing:
                kwargs.update(
                    {
                        "ConditionExpression": "#version = :version",
                        "ExpressionAttributeNames": {"#version": "version"},
                        "ExpressionAttributeValues": {":version": version},
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
    raise RuntimeError(f"Unable to update manifest for {market_date}/{product_id}")


def _mark_ledger(
    *,
    message_id: Optional[str],
    attachment_id: Optional[str],
    content_sha256: str,
    status: str,
    extra: Optional[Dict[str, Any]] = None,
) -> None:
    table = dynamodb.Table(LEDGER_TABLE)
    now = datetime.now(timezone.utc).isoformat()
    targets = [(message_id, attachment_id)]
    if content_sha256:
        targets.append(
            (f"CONTENT#{content_sha256}", TEXTRACT_LEDGER_ATTACHMENT_ID)
        )
    for target_message, target_attachment in targets:
        if not target_message or not target_attachment:
            continue
        names = {"#status": "status", "#updatedAt": "updatedAt"}
        values: Dict[str, Any] = {":status": status, ":updatedAt": now}
        assignments = ["#status = :status", "#updatedAt = :updatedAt"]
        for index, (key, value) in enumerate((extra or {}).items()):
            name_key = f"#name{index}"
            value_key = f":value{index}"
            names[name_key] = key
            values[value_key] = value
            assignments.append(f"{name_key} = {value_key}")
        table.update_item(
            Key={
                "messageId": target_message,
                "attachmentId": target_attachment,
            },
            UpdateExpression="SET " + ", ".join(assignments),
            ExpressionAttributeNames=names,
            ExpressionAttributeValues=_decimalize(values),
        )


def _mark_processing_stage(
    *,
    stage: str,
    product_id: str,
    market_date: str,
    s3_key: str,
    message_id: Optional[str],
    attachment_id: Optional[str],
    content_sha256: str,
    extra: Optional[Dict[str, Any]] = None,
) -> None:
    status = stage.upper()
    _mark_ledger(
        message_id=message_id,
        attachment_id=attachment_id,
        content_sha256=content_sha256,
        status=status,
        extra={
            "materializationStatus": status,
            "researchLifecycleStage": stage,
            "snapshotType": product_id,
            "snapshotDate": market_date,
            "sourceArtifact": s3_key,
            "researchParserVersion": PARSER_VERSION,
            "retryable": stage != "indexed",
            **(extra or {}),
        },
    )


def _job_from_s3_record(record: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "bucket": record["s3"]["bucket"]["name"],
        "key": urllib.parse.unquote_plus(record["s3"]["object"]["key"]),
    }


def _jobs(event: Dict[str, Any]) -> List[Dict[str, Any]]:
    if isinstance(event.get("Records"), list):
        return [_job_from_s3_record(record) for record in event["Records"]]
    if event.get("bucket") and (event.get("key") or event.get("s3Key")):
        return [{**event, "key": event.get("key") or event.get("s3Key")}]
    raise ValueError("PDF processor event contains no S3 job")


def _object_metadata(bucket: str, key: str) -> Dict[str, str]:
    response = s3.head_object(Bucket=bucket, Key=key)
    return {
        str(name).lower(): str(value)
        for name, value in (response.get("Metadata") or {}).items()
    }


def _object_sha256(bucket: str, key: str) -> str:
    """Hash an S3 object when upstream metadata omitted the content checksum."""
    response = s3.get_object(Bucket=bucket, Key=key)
    body = response["Body"]
    digest = hashlib.sha256()
    try:
        while True:
            chunk = body.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
    finally:
        close = getattr(body, "close", None)
        if callable(close):
            close()
    return digest.hexdigest()


def _call_extractor(extractor: Extractor, temp_path: str, s3_key: str) -> Any:
    """Pass s3_key only when supported; never retry an internal TypeError."""
    parameters = inspect.signature(extractor).parameters.values()
    accepts_s3_key = any(
        parameter.name == "s3_key"
        or parameter.kind == inspect.Parameter.VAR_KEYWORD
        for parameter in parameters
    )
    if accepts_s3_key:
        return extractor(temp_path, s3_key=s3_key)
    return extractor(temp_path)


def _process_job(job: Dict[str, Any]) -> Dict[str, Any]:
    bucket = str(job["bucket"])
    s3_key = str(job["key"])
    if not s3_key.startswith("hedgeye-uploads/"):
        raise ValueError(f"Unsupported PDF source prefix: {s3_key}")

    metadata = _object_metadata(bucket, s3_key)
    product_id = str(
        job.get("reportType")
        or metadata.get("report-type")
        or detect_pdf_type(s3_key)
        or "unknown"
    )
    message_id = job.get("messageId") or metadata.get("gmail-message-id")
    attachment_id = job.get("attachmentId") or metadata.get("gmail-attachment-id")
    published_at = (
        job.get("publishedAt")
        or job.get("receivedAt")
        or metadata.get("published-at")
        or metadata.get("received-at")
    )
    content_sha256 = str(
        job.get("contentSha256") or metadata.get("content-sha256") or ""
    )
    if os.environ.get('GLOBAL_QUADS_INGEST_ENABLED', '0') == '1' and product_id in {'global-quads', 'the-macro-show'}:
        from global_quads import QuadStore
        if not published_at or not message_id:
            raise ValueError('Attached quad presentations require Gmail publication provenance')
        body = s3.get_object(Bucket=bucket, Key=s3_key)['Body'].read()
        quad_result = QuadStore(dynamodb, s3, boto3.client('textract', region_name=AWS_REGION), bucket=bucket).process_pdf(
            body, str(published_at), str(message_id))
        if product_id == 'global-quads' or any(r.get('group') for r in quad_result['results']):
            _mark_processing_stage(stage='indexed', product_id=product_id, market_date=str(published_at)[:10],
                s3_key=s3_key, message_id=message_id, attachment_id=attachment_id,
                content_sha256=content_sha256 or hashlib.sha256(body).hexdigest(),
                extra={'globalQuads': quad_result, 'retryable': False})
            return {'product': product_id, 's3Key': s3_key, 'globalQuads': quad_result, 'entityEventCount': 0}
    if product_id not in PARSERS:
        if not content_sha256:
            try:
                content_sha256 = _object_sha256(bucket, s3_key)
            except Exception as error:
                _mark_ledger(
                    message_id=message_id,
                    attachment_id=attachment_id,
                    content_sha256="",
                    status="TEXTRACT_ERROR",
                    extra={
                        "materializationStatus": "ERROR",
                        "parseError": str(error)[:1000],
                        "retryable": True,
                        "researchParserVersion": PARSER_VERSION,
                    },
                )
                raise
        failure_date = str(job.get("receivedAt") or "")[:10]
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", failure_date):
            failure_date = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        error = f"Unsupported or unknown PDF product: {product_id}"
        _manifest_snapshot(
            product_id=product_id,
            market_date=failure_date,
            artifact_id=content_sha256,
            stage="failed",
            s3_key=s3_key,
            message_id=message_id,
            attachment_id=attachment_id,
            published_at=str(published_at) if published_at else None,
            error=error,
        )
        _mark_ledger(
            message_id=message_id,
            attachment_id=attachment_id,
            content_sha256=content_sha256,
            status="UNSUPPORTED",
            extra={
                "materializationStatus": "ERROR",
                "parseError": error,
                "errorCode": "RESEARCH_PRODUCT_UNSUPPORTED",
                "retryable": False,
                "researchParserVersion": PARSER_VERSION,
            },
        )
        return {
            "product": product_id,
            "marketDate": failure_date,
            "s3Key": s3_key,
            "status": "unsupported",
            "entityEventCount": 0,
        }

    suffix = Path(s3_key).suffix or ".pdf"
    descriptor, temp_path = tempfile.mkstemp(prefix="hedgeye-", suffix=suffix)
    os.close(descriptor)
    market_date: Optional[str] = None
    try:
        s3.download_file(bucket, s3_key, temp_path)
        if not content_sha256:
            with open(temp_path, "rb") as handle:
                content_sha256 = hashlib.sha256(handle.read()).hexdigest()

        market_date = extract_date_from_pdf(temp_path)
        if not market_date or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", market_date):
            raise ValueError(f"{product_id} PDF has no valid publication date")
        _manifest_snapshot(
            product_id=product_id,
            market_date=market_date,
            artifact_id=content_sha256,
            stage="received",
            s3_key=s3_key,
            message_id=message_id,
            attachment_id=attachment_id,
            published_at=str(published_at) if published_at else None,
        )
        _mark_processing_stage(
            stage="received",
            product_id=product_id,
            market_date=market_date,
            s3_key=s3_key,
            message_id=message_id,
            attachment_id=attachment_id,
            content_sha256=content_sha256,
        )

        extractor, saver = PARSERS[product_id]
        data = _call_extractor(extractor, temp_path, s3_key)
        if not _nonempty(data):
            raise ValueError(f"{product_id} parser extracted no usable data")

        _manifest_snapshot(
            product_id=product_id,
            market_date=market_date,
            artifact_id=content_sha256,
            stage="parsed",
            s3_key=s3_key,
            message_id=message_id,
            attachment_id=attachment_id,
            published_at=str(published_at) if published_at else None,
        )
        _mark_processing_stage(
            stage="parsed",
            product_id=product_id,
            market_date=market_date,
            s3_key=s3_key,
            message_id=message_id,
            attachment_id=attachment_id,
            content_sha256=content_sha256,
        )
        _validate_product_data(product_id, data)

        _manifest_snapshot(
            product_id=product_id,
            market_date=market_date,
            artifact_id=content_sha256,
            stage="validated",
            s3_key=s3_key,
            message_id=message_id,
            attachment_id=attachment_id,
            published_at=str(published_at) if published_at else None,
        )
        _mark_processing_stage(
            stage="validated",
            product_id=product_id,
            market_date=market_date,
            s3_key=s3_key,
            message_id=message_id,
            attachment_id=attachment_id,
            content_sha256=content_sha256,
        )

        saver(data, pdf_s3_key=s3_key, pdf_date=market_date)
        events = build_entity_events(
            product_id=product_id,
            market_date=market_date,
            data=data,
            content_sha256=content_sha256,
            message_id=str(message_id) if message_id else None,
            s3_key=s3_key,
            published_at=str(published_at) if published_at else None,
        )
        persist_entity_events(events)
        _manifest_snapshot(
            product_id=product_id,
            market_date=market_date,
            artifact_id=content_sha256,
            stage="indexed",
            s3_key=s3_key,
            message_id=message_id,
            attachment_id=attachment_id,
            published_at=str(published_at) if published_at else None,
            event_count=len(events),
        )
        from analyst_change_journal import emit_change
        emit_change({"snapshotType": product_id, "reportType": product_id, "date": market_date,
                     "data": data, "pdfS3Key": s3_key, "gmailMessageId": message_id,
                     "publishedAt": published_at, "scrapedAt": datetime.now(timezone.utc).isoformat()},
                    dynamodb, {"marketDate": market_date, "productKey": product_id, "stage": "indexed"},
                    events, content_sha256)
        _mark_processing_stage(
            stage="indexed",
            product_id=product_id,
            market_date=market_date,
            s3_key=s3_key,
            message_id=message_id,
            attachment_id=attachment_id,
            content_sha256=content_sha256,
            extra={
                "researchEntityEventCount": len(events),
                "parseError": None,
                "retryable": False,
            },
        )
        return {
            "product": product_id,
            "marketDate": market_date,
            "s3Key": s3_key,
            "entityEventCount": len(events),
        }
    except Exception as error:
        failure_date = (
            market_date
            or str(job.get("receivedAt") or "")[:10]
            or datetime.now(timezone.utc).strftime("%Y-%m-%d")
        )
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", failure_date):
            failure_date = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        try:
            if content_sha256:
                _manifest_snapshot(
                    product_id=product_id,
                    market_date=failure_date,
                    artifact_id=content_sha256,
                    stage="failed",
                    s3_key=s3_key,
                    message_id=message_id,
                    attachment_id=attachment_id,
                    published_at=str(published_at) if published_at else None,
                    error=str(error),
                )
            _mark_ledger(
                message_id=message_id,
                attachment_id=attachment_id,
                content_sha256=content_sha256,
                status="TEXTRACT_ERROR",
                extra={
                    "materializationStatus": "ERROR",
                    "parseError": str(error)[:1000],
                    "retryable": True,
                    "researchParserVersion": PARSER_VERSION,
                },
            )
        except Exception:
            traceback.print_exc()
        raise
    finally:
        try:
            os.remove(temp_path)
        except FileNotFoundError:
            pass


def lambda_handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    results: List[Dict[str, Any]] = []
    errors: List[str] = []
    for job in _jobs(event):
        try:
            results.append(_process_job(job))
        except Exception as error:
            traceback.print_exc()
            errors.append(f"{job.get('key')}: {error}")
    if errors:
        raise RuntimeError("; ".join(errors))
    return {
        "processed": len(results),
        "results": results,
    }
