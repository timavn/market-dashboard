#!/usr/bin/env python3
"""
Parse Hedgeye HTML email bodies into the existing DynamoDB snapshot shapes.
"""

from __future__ import annotations

import html
import hashlib
import json
import math
import os
import re
import struct
import unicodedata
import urllib.parse
import urllib.request
import zlib
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from html.parser import HTMLParser
from typing import Any, Callable, Dict, List, Optional, Tuple
from zoneinfo import ZoneInfo

from boto3.dynamodb.types import TypeSerializer
from botocore.exceptions import ClientError
from hedgai_signals import parse_publication as parse_hedgai_publication


RISK_RANGE_MANIFEST_TABLE = os.environ.get(
    "RISK_RANGE_MANIFEST_TABLE",
    "RiskRangePublicationManifestsV2",
)
RISK_RANGE_DATA_TABLE = os.environ.get(
    "HEDGEYE_RISK_RANGES_TABLE",
    "HedgeyeRiskRanges",
)
RISK_RANGE_HISTORY_TABLE = os.environ.get(
    "RISK_RANGE_HISTORY_TABLE",
    "RiskRangeData",
)
HEDGEYE_DAILY_SNAPSHOT_TABLE = os.environ.get(
    "HEDGEYE_DAILY_SNAPSHOT_TABLE",
    "HedgeyeDailySnapshot",
)
RISK_RANGE_PARSER_VERSION = "risk-range-email-v3"
DYNAMODB_TRANSACTION_MAX_OPERATIONS = 100
DYNAMODB_TRANSACTION_CHUNK_SIZE = 20
DYNAMODB_ITEM_MAX_BYTES = 400 * 1024
DYNAMODB_TRANSACTION_MAX_BYTES = 4 * 1024 * 1024
MARKET_SITUATION_IMAGE_HOST = "d1yhils6iwh5l5.cloudfront.net"
MARKET_SITUATION_IMAGE_MAX_BYTES = 8 * 1024 * 1024
MARKET_SITUATION_CHART_MAX_COUNT = 12
MARKET_SITUATION_SCHEMA_VERSION = "market-structure-v4"
MARKET_SITUATION_CHART_METRICS_PARSER_VERSION = (
    "market-structure-chart-metrics-v3"
)
INFLATION_NOWCAST_PARSER_VERSION = "inflation-nowcast-chart-v1"
INFLATION_NOWCAST_METRIC = "Headline CPI YoY"
INFLATION_NOWCAST_MONTH_NAMES = (
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
)
MARKET_SITUATION_SIGNAL_ROWS = (
    (
        "spxGammaExposure",
        "SPX Gamma Exposure",
        ("Positive", "Neutral", "Negative"),
    ),
    (
        "systematicFlowRisk",
        "Systematic Flow Risk",
        ("Bullish", "Neutral", "Bearish"),
    ),
    (
        "pvBandRiskReward",
        "PV Band Risk/Reward",
        ("Long", "Neutral", "Short"),
    ),
    (
        "strategicAllocation",
        "Strategic Allocation",
        ("Risk On", "Neutral", "Risk Off"),
    ),
)
MARKET_SITUATION_SIGNAL_COLORS = {
    (0, 128, 0): (0, "positive"),
    # Hedgeye's current rendered template uses a darker brand green.
    (55, 126, 34): (0, "positive"),
    (255, 165, 0): (1, "neutral"),
    (255, 0, 0): (2, "negative"),
    # The current rendered template uses Hedgeye red instead of pure red.
    (233, 51, 35): (2, "negative"),
}


TICKER_MAP = {
    "UST 30YR YIELD": "UST30Y",
    "UST30Y": "UST30Y",
    "UST 10YR YIELD": "UST10Y",
    "UST10Y": "UST10Y",
    "UST 2YR YIELD": "UST2Y",
    "UST2Y": "UST2Y",
    "HIGH YIELD (HYG)": "HYG",
    "HYG": "HYG",
    "INVESTMENT GRADE (LQD)": "LQD",
    "LQD": "LQD",
    "SPX": "SPX",
    "NASDAQ": "COMPQ",
    "COMPQ": "COMPQ",
    "RUT": "RUT",
    "TECH (XLK)": "XLK",
    "XLK": "XLK",
    "HEALTHCARE (XLV)": "XLV",
    "XLV": "XLV",
    "INDUSTRIALS (XLI)": "XLI",
    "XLI": "XLI",
    "SHANGHAI COMP": "SSEC",
    "SSEC": "SSEC",
    "NIKKEI 225 INDEX": "NIKK",
    "NIKK": "NIKK",
    "DAX": "DAX",
    "EUR/USD": "EUR/USD",
    "USD/YEN": "USD/YEN",
    "GBP/USD": "GBP/USD",
    "CAD/USD": "CAD/USD",
    "VIX": "VIX",
    "USD": "DXY",
    "DXY": "DXY",
    "OIL (WTI)": "USO",
    "WTI": "USO",
    "USO": "USO",
    "OIL & GAS STOCKS (XOP)": "XOP",
    "XOP": "XOP",
    "TELECOM (XTL)": "XTL",
    "XTL": "XTL",
    "UTILITIES (XLU)": "XLU",
    "XLU": "XLU",
    "NAT GAS": "NATGAS",
    "NATGAS": "NATGAS",
    "GOLD": "GLD",
    "GLD": "GLD",
    "COPPER": "COPPER",
    "SILVER (SLV)": "SILVER",
    "SILVER": "SILVER",
    "BITCOIN": "BITCOIN",
}


class RiskRangePublicationError(ValueError):
    """A primary Risk Range publication cannot be written safely."""

    error_code = "RISK_RANGE_PUBLICATION_INVALID"


class RiskRangeDuplicateConflictError(RiskRangePublicationError):
    """Two source rows resolve to one ticker but disagree on published values."""

    error_code = "RISK_RANGE_DUPLICATE_TICKER_CONFLICT"


class RiskRangeTransactionLimitError(RiskRangePublicationError):
    """The atomic primary publication would exceed DynamoDB's operation limit."""

    error_code = "RISK_RANGE_TRANSACTION_LIMIT_EXCEEDED"


class RiskRangeTransactionWriteError(RiskRangePublicationError):
    """DynamoDB rejected an otherwise preflighted publication chunk."""

    error_code = "RISK_RANGE_TRANSACTION_WRITE_FAILED"


class RiskRangePublicationVerificationError(RiskRangePublicationError):
    """A staged primary publication could not be read back exactly."""

    error_code = "RISK_RANGE_PUBLICATION_VERIFICATION_FAILED"


class RiskRangeStalePublicationError(RiskRangePublicationError):
    """An older primary publication must not replace the current same-day book."""

    error_code = "RISK_RANGE_STALE_PUBLICATION_REJECTED"


class RiskRangePublicationOrderError(RiskRangePublicationError):
    """Publication ordering or identity could not be proven safely."""

    error_code = "RISK_RANGE_PUBLICATION_ORDER_UNVERIFIED"


def _strip_tags(value: str) -> str:
    text = value
    text = re.sub(r"(?is)<(script|style).*?>.*?</\1>", " ", text)
    text = re.sub(r"(?i)<br\s*/?>", "\n", text)
    text = re.sub(r"(?i)</(p|div|tr|table|li|h1|h2|h3|h4|h5|h6|td|th|ul|ol)>", "\n", text)
    text = re.sub(r"(?i)<li\b[^>]*>", "\n", text)
    text = re.sub(r"(?i)<[^>]+>", " ", text)
    text = html.unescape(text)
    text = text.replace("\xa0", " ")
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n\s+\n", "\n\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def _extract_meta(html_body: str, meta_type: str) -> Optional[str]:
    pattern = rf'<meta[^>]+type="{re.escape(meta_type)}"[^>]+content="([^"]*)"'
    match = re.search(pattern, html_body, re.IGNORECASE)
    if not match:
        return None
    return html.unescape(match.group(1)).strip() or None


def _extract_first(pattern: str, text: str, flags: int = 0) -> Optional[str]:
    match = re.search(pattern, text, flags)
    if not match:
        return None
    return match.group(1).strip()


def _extract_feed_url(text: str) -> Optional[str]:
    match = re.search(r"https://app\.hedgeye\.com/feed_items/\d+", text)
    return match.group(0) if match else None


def _extract_image_urls(html_body: str) -> List[str]:
    urls = re.findall(r'<img[^>]+src="([^"]+)"', html_body, flags=re.IGNORECASE)
    seen = set()
    ordered = []
    for url in urls:
        url = html.unescape(url)
        if url not in seen:
            ordered.append(url)
            seen.add(url)
    return ordered


def _extract_headline(html_body: str, text: str) -> Optional[str]:
    meta_headline = _extract_meta(html_body, "hedgeye-headline")
    if meta_headline:
        return meta_headline

    match = re.search(
        r'<(?:div|td)[^>]+class="[^"]*headline[^"]*"[^>]*>(.*?)</(?:div|td)>',
        html_body,
        re.IGNORECASE | re.DOTALL,
    )
    if match:
        headline = _strip_tags(match.group(1))
        if headline:
            lines = [line.strip() for line in headline.splitlines() if line.strip()]
            return lines[0] if lines else headline

    subject = _extract_first(r"Subject:\s*(.+?)(?:\n|To:)", text, re.IGNORECASE | re.DOTALL)
    if subject:
        return re.sub(r"\s+", " ", subject).strip()
    return None


def _extract_first_image_alt(html_body: str) -> Optional[str]:
    match = re.search(r'<img[^>]+alt="([^"]+)"', html_body, re.IGNORECASE)
    if not match:
        return None
    return html.unescape(match.group(1)).strip() or None


def _chart_name_from_url(url: str) -> str:
    path = url.split("?", 1)[0].rstrip("/")
    name = path.rsplit("/", 1)[-1] or path
    return html.unescape(name)


def _extract_chart_items(html_body: str) -> List[Dict[str, str]]:
    charts = []
    for url in _extract_image_urls(html_body):
        name = _chart_name_from_url(url)
        lower = name.lower()
        if lower.endswith(".gif") or "email_assets/headers" in url or "attachments/" in url:
            continue
        charts.append({"name": name, "url": url})
    return charts


def _sanitize_research_image_url(url: str) -> Optional[str]:
    """Keep the public source image while removing subscriber tracking data."""
    try:
        parsed = urllib.parse.urlsplit(html.unescape(str(url or "")).strip())
    except ValueError:
        return None
    if parsed.scheme != "https" or parsed.hostname != MARKET_SITUATION_IMAGE_HOST:
        return None
    return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, parsed.path, "", ""))


def _fetch_market_situation_image(url: str) -> bytes:
    sanitized_url = _sanitize_research_image_url(url)
    if not sanitized_url:
        raise ValueError("Market Situation image URL is not an approved Hedgeye source")
    request = urllib.request.Request(
        sanitized_url,
        headers={"User-Agent": "market-dashboard-hermes/1.0"},
        method="GET",
    )
    with urllib.request.urlopen(request, timeout=10) as response:
        content_length = response.headers.get("Content-Length")
        if content_length and int(content_length) > MARKET_SITUATION_IMAGE_MAX_BYTES:
            raise ValueError("Market Situation image exceeds the ingestion size limit")
        payload = response.read(MARKET_SITUATION_IMAGE_MAX_BYTES + 1)
    if len(payload) > MARKET_SITUATION_IMAGE_MAX_BYTES:
        raise ValueError("Market Situation image exceeds the ingestion size limit")
    return payload


def _market_situation_image_type(payload: bytes) -> Tuple[str, str]:
    """Return the verified MIME type and safe extension for a chart payload."""
    if payload.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png", "png"
    if payload.startswith(b"\xff\xd8\xff"):
        return "image/jpeg", "jpg"
    if len(payload) >= 12 and payload[:4] == b"RIFF" and payload[8:12] == b"WEBP":
        return "image/webp", "webp"
    raise ValueError("Market Situation chart has an unsupported or invalid image signature")


def _market_situation_chart_ocr_response(
    textract_client: Any,
    payload: bytes,
) -> Dict[str, Any]:
    """Read one approved chart without treating unlabeled numbers as metrics."""
    if hasattr(textract_client, "detect_document_text"):
        return textract_client.detect_document_text(Document={"Bytes": payload})
    return textract_client.analyze_document(
        Document={"Bytes": payload},
        FeatureTypes=["TABLES"],
    )


def _market_situation_ocr_text(response: Dict[str, Any]) -> str:
    lines = [
        str(block.get("Text") or "").strip()
        for block in response.get("Blocks") or []
        if block.get("BlockType") == "LINE"
        and str(block.get("Text") or "").strip()
    ]
    return "\n".join(lines)


def _market_situation_decimal_metric(
    text: str,
    pattern: str,
    *,
    minimum: Decimal,
    maximum: Decimal,
) -> Optional[Decimal]:
    match = re.search(pattern, text, flags=re.IGNORECASE)
    if not match:
        return None
    try:
        value = Decimal(match.group(1).replace(",", ""))
    except Exception:
        return None
    if not value.is_finite() or not minimum <= value <= maximum:
        return None
    return value


def _market_situation_chart_date(text: str) -> Optional[str]:
    match = re.search(
        r"\bDate\s*[:=]?\s*(20\d{2}[/-]\d{1,2}[/-]\d{1,2})\b",
        text,
        flags=re.IGNORECASE,
    )
    if not match:
        return None
    raw_date = match.group(1).replace("-", "/")
    try:
        return datetime.strptime(raw_date, "%Y/%m/%d").strftime("%Y-%m-%d")
    except ValueError:
        return None


def _extract_spx_gamma_volatility_throttle_metric(
    response: Dict[str, Any],
    *,
    chart_id: str,
) -> Optional[Dict[str, Any]]:
    """Extract only the chart's explicitly labeled, source-dated callout."""
    text = _market_situation_ocr_text(response)
    if not re.search(
        r"\bSPX\s+Gamma\s+Volatility\s+Throttle\b",
        text,
        flags=re.IGNORECASE,
    ):
        return None
    gamma_throttle = _market_situation_decimal_metric(
        text,
        r"\bGamma[ \t]+Throttle[ \t]*[:=]?[ \t]*([-+]?\d+(?:\.\d+)?)\b",
        minimum=Decimal("-250"),
        maximum=Decimal("250"),
    )
    ten_day_realized_volatility = _market_situation_decimal_metric(
        text,
        r"\b10[ \t]*[-–—]?[ \t]*Day[ \t]+rVol[ \t]*[:=]?[ \t]*([-+]?\d+(?:\.\d+)?)\b",
        minimum=Decimal("0"),
        maximum=Decimal("250"),
    )
    chart_date = _market_situation_chart_date(text)
    if (
        (gamma_throttle is None and ten_day_realized_volatility is None)
        or chart_date is None
    ):
        return None
    source_match = re.search(
        r"\bSource[ \t]*[:=]?[ \t]*([A-Za-z0-9./-]+)",
        text,
        flags=re.IGNORECASE,
    )
    return {
        "id": "spxGammaVolatilityThrottle",
        "label": "SPX Gamma Volatility Throttle",
        **({"gammaThrottle": gamma_throttle} if gamma_throttle is not None else {}),
        **(
            {"tenDayRealizedVolatility": ten_day_realized_volatility}
            if ten_day_realized_volatility is not None else {}
        ),
        "chartDate": chart_date,
        "chartId": chart_id,
        "extractionBasis": "labeled-chart-ocr",
        "parserVersion": MARKET_SITUATION_CHART_METRICS_PARSER_VERSION,
        **({"source": source_match.group(1)} if source_match else {}),
    }


def _market_situation_strikes_in_play(response: Dict[str, Any]) -> List[Decimal]:
    """Associate a vertical callout with its own column, never adjacent axis ticks."""
    number = r"\d+(?:\.\d+)?"
    lines = [
        block for block in response.get("Blocks") or []
        if block.get("BlockType") == "LINE"
    ]
    for header in lines:
        match = re.fullmatch(
            r"Strikes?[ \t]+In[ \t]+Play[ \t]*[:=]?[ \t]*(.*)",
            str(header.get("Text") or "").strip(),
            flags=re.IGNORECASE,
        )
        if not match:
            continue
        raw_values = match.group(1).strip()
        if raw_values:
            if not re.fullmatch(rf"{number}(?:[ \t]*,[ \t]*{number})*", raw_values):
                return []
            values = [Decimal(value.strip()) for value in raw_values.split(",")]
        else:
            box = (header.get("Geometry") or {}).get("BoundingBox") or {}
            if not all(isinstance(box.get(key), (int, float)) for key in ("Left", "Top", "Width", "Height")):
                return []
            if box["Width"] <= 0 or box["Height"] <= 0:
                return []
            candidates = []
            for line in lines:
                text = str(line.get("Text") or "").strip()
                value_box = (line.get("Geometry") or {}).get("BoundingBox") or {}
                if not re.fullmatch(number, text) or not all(
                    isinstance(value_box.get(key), (int, float))
                    for key in ("Left", "Top", "Width", "Height")
                ):
                    continue
                # These source callouts align every strike below the left edge
                # of the heading. Textract may interleave far-right axis ticks.
                if (
                    abs(value_box["Left"] - box["Left"]) <= box["Width"] * 0.2
                    and value_box["Left"] + value_box["Width"] <= box["Left"] + box["Width"] * 1.2
                    and value_box["Top"] >= box["Top"] + box["Height"]
                ):
                    candidates.append((value_box["Top"], value_box["Height"], Decimal(text)))
            values = []
            previous_bottom = box["Top"] + box["Height"]
            for top, height, value in sorted(candidates):
                if height <= 0 or top - previous_bottom > box["Height"] * 2:
                    break
                values.append(value)
                previous_bottom = top + height
        if not 1 <= len(values) <= 20 or any(
            not Decimal("100") <= value <= Decimal("100000") for value in values
        ):
            return []
        return list(dict.fromkeys(values))
    return []


def _extract_spx_probable_volatility_gamma_metric(
    response: Dict[str, Any],
    *,
    chart_id: str,
) -> Optional[Dict[str, Any]]:
    """Extract only explicitly labeled SPX strike-map levels."""
    text = _market_situation_ocr_text(response)
    if not (
        re.search(r"\bSPX\b", text, flags=re.IGNORECASE)
        and re.search(r"\bGamma\b", text, flags=re.IGNORECASE)
        and re.search(r"\bStrike", text, flags=re.IGNORECASE)
    ):
        return None
    zero_gamma = _market_situation_decimal_metric(
        text,
        r"\b(?:Zero[ \t]+Gamma|Gamma[ \t]+Flip(?:[ \t]+(?:Line|Level))?)[ \t]*[:=]?[ \t]*([-+]?\d[\d,]*(?:\.\d+)?)\b",
        minimum=Decimal("100"),
        maximum=Decimal("100000"),
    )
    upper_pv_band = _market_situation_decimal_metric(
        text,
        r"\bUpper[ \t]+PV[ \t]+Band[ \t]*[:=]?[ \t]*([-+]?\d[\d,]*(?:\.\d+)?)\b",
        minimum=Decimal("100"),
        maximum=Decimal("100000"),
    )
    lower_pv_band = _market_situation_decimal_metric(
        text,
        r"\bLower[ \t]+PV[ \t]+Band[ \t]*[:=]?[ \t]*([-+]?\d[\d,]*(?:\.\d+)?)\b",
        minimum=Decimal("100"),
        maximum=Decimal("100000"),
    )
    strikes_in_play = _market_situation_strikes_in_play(response)
    # Preserve independently labeled levels when a sibling label is unreadable.
    # A contradictory band pair is not usable research evidence.
    if upper_pv_band is not None and lower_pv_band is not None and lower_pv_band >= upper_pv_band:
        upper_pv_band = lower_pv_band = None
    chart_date = _market_situation_chart_date(text)
    if (
        all(value is None for value in (zero_gamma, upper_pv_band, lower_pv_band))
        or chart_date is None
    ):
        return None
    source_match = re.search(
        r"\bSource[ \t]*[:=]?[ \t]*([A-Za-z0-9./-]+)",
        text,
        flags=re.IGNORECASE,
    )
    return {
        "id": "spxProbableVolatilityGamma",
        "label": "SPX Probable Volatility / Gamma By Strike",
        **({"zeroGamma": zero_gamma} if zero_gamma is not None else {}),
        **({"upperPvBand": upper_pv_band} if upper_pv_band is not None else {}),
        **({"lowerPvBand": lower_pv_band} if lower_pv_band is not None else {}),
        **({"strikesInPlay": strikes_in_play} if strikes_in_play else {}),
        "chartDate": chart_date,
        "chartId": chart_id,
        "extractionBasis": "labeled-chart-ocr",
        "parserVersion": MARKET_SITUATION_CHART_METRICS_PARSER_VERSION,
        **({"source": source_match.group(1)} if source_match else {}),
    }


_MARKET_SITUATION_EMAIL_PATTERN = re.compile(
    r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b",
    re.IGNORECASE,
)
_MARKET_SITUATION_IGNORED_TEXT = (
    "prepared exclusively for",
    "having trouble viewing this email",
    "view larger image",
    "view this email in your browser",
    "view it in your browser",
    "the research note below was written by",
    "presented by hedgeye",
    "manage preferences",
    "unsubscribe",
    "to access the full market situation report",
    "to access the full report",
    "click here",
    "all rights reserved",
)
_MARKET_SITUATION_DISCLAIMER_PREFIXES = (
    "disclaimer",
    "legal disclaimer",
    "important disclosures",
    "the information contained in this report",
    "hedgeye risk management, llc",
)


def _clean_market_situation_text(value: str) -> Optional[str]:
    text = html.unescape(str(value or "")).replace("\xa0", " ")
    text = _MARKET_SITUATION_EMAIL_PATTERN.sub("", text)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\s*\n\s*", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text).strip(" \n-|·")
    if not text:
        return None
    normalized = text.casefold()
    if any(phrase in normalized for phrase in _MARKET_SITUATION_IGNORED_TEXT):
        return None
    if re.fullmatch(
        r"\d{1,2}/\d{1,2}/\d{4}\s+\d{1,2}:\d{2}\s+[ap]m(?:\s+[a-z]{2,5})?",
        normalized,
        re.IGNORECASE,
    ):
        return None
    if re.match(r"^market situation report\s*:", normalized, re.IGNORECASE):
        return None
    if normalized in {"click here", "read more", "source", "view online"}:
        return None
    return text


def _is_market_situation_disclaimer(text: str) -> bool:
    normalized = str(text or "").strip().casefold()
    return any(normalized.startswith(prefix) for prefix in _MARKET_SITUATION_DISCLAIMER_PREFIXES)


def _market_situation_text_block_type(tag: str, text: str, attributes: Dict[str, str]) -> str:
    normalized = text.strip()
    class_name = attributes.get("class", "").casefold()
    if re.fullmatch(
        r"\d{1,2}/\d{1,2}/\d{4}(?:\s+\d{1,2}:\d{2}\s+[AP]M(?:\s+[A-Z]{2,5})?)?",
        normalized,
        re.IGNORECASE,
    ):
        return "paragraph"
    if re.match(r"^by\s+\S", normalized, re.IGNORECASE) or re.fullmatch(
        r"(?:craig\s+peterson)(?:\s*[|·,-].*)?",
        normalized,
        re.IGNORECASE,
    ):
        return "byline"
    if "important note" in normalized.casefold() or "callout" in class_name or "note" in class_name:
        return "callout"
    if tag in {"h1", "h2", "h3", "h4", "h5", "h6"} or "headline" in class_name or "title" in class_name:
        return "heading"
    if (
        len(normalized) <= 140
        and normalized == normalized.upper()
        and re.search(r"[A-Z]", normalized)
        and not normalized.endswith(".")
    ):
        return "heading"
    return "paragraph"


class _MarketSituationContentParser(HTMLParser):
    """Extract source-ordered narrative blocks and approved chart placeholders."""

    _TEXT_TAGS = {
        "blockquote",
        "div",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "li",
        "p",
        "td",
    }
    _IGNORED_TAGS = {"head", "script", "style"}

    def __init__(self, chart_urls: List[str]) -> None:
        super().__init__(convert_charrefs=True)
        self.blocks: List[Dict[str, Any]] = []
        self.disclaimer_parts: List[str] = []
        self._chart_urls = set(chart_urls)
        self._seen_charts = set()
        self._seen_text = set()
        self._text_stack: List[Dict[str, Any]] = []
        self._ignored_depth = 0
        self._in_disclaimer = False

    @staticmethod
    def _attributes(attrs: List[Tuple[str, Optional[str]]]) -> Dict[str, str]:
        return {
            str(name or "").casefold(): str(value or "")
            for name, value in attrs
            if name
        }

    def handle_starttag(self, tag: str, attrs: List[Tuple[str, Optional[str]]]) -> None:
        tag = tag.casefold()
        if tag in self._IGNORED_TAGS:
            self._ignored_depth += 1
            return
        if self._ignored_depth:
            return

        attributes = self._attributes(attrs)
        if tag == "img":
            source_url = _sanitize_research_image_url(attributes.get("src", ""))
            if source_url in self._chart_urls and source_url not in self._seen_charts:
                self._seen_charts.add(source_url)
                self.blocks.append(
                    {
                        "type": "chart-source",
                        "sourceUrl": source_url,
                        "name": _chart_name_from_url(source_url),
                        "caption": _clean_market_situation_text(
                            attributes.get("alt", "")
                        ),
                    }
                )
            return

        if tag == "br":
            for candidate in self._text_stack:
                candidate["parts"].append("\n")
            return

        if tag not in self._TEXT_TAGS:
            return
        inherited_disclaimer = any(
            candidate.get("isDisclaimer") for candidate in self._text_stack
        )
        for candidate in self._text_stack:
            candidate["hasTextChild"] = True
        self._text_stack.append(
            {
                "tag": tag,
                "attributes": attributes,
                "parts": [],
                "hasTextChild": False,
                "isDisclaimer": inherited_disclaimer or any(
                    "disclaimer" in attributes.get(name, "").casefold()
                    for name in ("id", "class")
                ),
            }
        )

    def handle_startendtag(self, tag: str, attrs: List[Tuple[str, Optional[str]]]) -> None:
        self.handle_starttag(tag, attrs)

    def handle_data(self, data: str) -> None:
        if self._ignored_depth:
            return
        for candidate in self._text_stack:
            candidate["parts"].append(data)

    def handle_endtag(self, tag: str) -> None:
        tag = tag.casefold()
        if tag in self._IGNORED_TAGS:
            if self._ignored_depth:
                self._ignored_depth -= 1
            return
        if self._ignored_depth or tag not in self._TEXT_TAGS:
            return

        candidate_index = next(
            (
                index
                for index in range(len(self._text_stack) - 1, -1, -1)
                if self._text_stack[index]["tag"] == tag
            ),
            None,
        )
        if candidate_index is None:
            return
        candidate = self._text_stack.pop(candidate_index)
        if candidate["hasTextChild"]:
            return
        text = _clean_market_situation_text("".join(candidate["parts"]))
        if not text:
            return
        if (
            candidate.get("isDisclaimer")
            or self._in_disclaimer
            or _is_market_situation_disclaimer(text)
        ):
            self._in_disclaimer = True
            self.disclaimer_parts.append(text)
            return
        dedupe_key = re.sub(r"\s+", " ", text).casefold()
        if dedupe_key in self._seen_text:
            return
        self._seen_text.add(dedupe_key)
        self.blocks.append(
            {
                "type": _market_situation_text_block_type(
                    candidate["tag"],
                    text,
                    candidate["attributes"],
                ),
                "text": text,
            }
        )


def _extract_market_situation_content(
    html_body: str,
    charts: List[Dict[str, str]],
) -> Tuple[List[Dict[str, Any]], Optional[str]]:
    parser = _MarketSituationContentParser([chart["url"] for chart in charts])
    parser.feed(html_body)
    parser.close()
    disclaimer = "\n\n".join(parser.disclaimer_parts).strip() or None
    return parser.blocks, disclaimer


def _textract_tables(textract_response: Dict[str, Any]) -> List[List[List[str]]]:
    """Return each Textract TABLE as its own ordered row collection."""
    blocks = textract_response.get("Blocks") or []
    blocks_by_id = {block.get("Id"): block for block in blocks if block.get("Id")}
    tables: List[List[List[str]]] = []
    for table in (block for block in blocks if block.get("BlockType") == "TABLE"):
        cells_by_row: Dict[int, Dict[int, str]] = {}
        for relationship in table.get("Relationships") or []:
            if relationship.get("Type") != "CHILD":
                continue
            for cell_id in relationship.get("Ids") or []:
                cell = blocks_by_id.get(cell_id)
                if not cell or cell.get("BlockType") != "CELL":
                    continue
                value_parts: List[str] = []
                for cell_relationship in cell.get("Relationships") or []:
                    if cell_relationship.get("Type") != "CHILD":
                        continue
                    for word_id in cell_relationship.get("Ids") or []:
                        word = blocks_by_id.get(word_id)
                        if word and word.get("BlockType") == "WORD":
                            value_parts.append(str(word.get("Text") or ""))
                row_index = int(cell.get("RowIndex") or 0)
                column_index = int(cell.get("ColumnIndex") or 0)
                cells_by_row.setdefault(row_index, {})[column_index] = " ".join(
                    value_parts
                ).strip()
        rows: List[List[str]] = []
        for row_index in sorted(cells_by_row):
            row_cells = cells_by_row[row_index]
            rows.append([row_cells[column] for column in sorted(row_cells)])
        if rows:
            tables.append(rows)
    return tables


def _textract_table_rows(textract_response: Dict[str, Any]) -> List[List[str]]:
    """Flatten all Textract tables for parsers that intentionally use one feed."""
    return [
        row
        for table_rows in _textract_tables(textract_response)
        for row in table_rows
    ]


def _signal_strength_header_key(value: str) -> str:
    return re.sub(r"[^a-z0-9%]+", " ", str(value or "").lower()).strip()


def _signal_strength_column_map(rows: List[List[str]]) -> Dict[str, int]:
    for row in rows[:4]:
        columns: Dict[str, int] = {}
        for index, value in enumerate(row):
            header = _signal_strength_header_key(value)
            if "days on" in header:
                columns["daysOn"] = index
            elif header == "ticker" or header.startswith("ticker "):
                columns["ticker"] = index
            elif "since initial signal" in header or ("since" in header and "signal" in header):
                columns["percentChangeSinceSignal"] = index
        if "ticker" in columns and ("daysOn" in columns or "percentChangeSinceSignal" in columns):
            return columns
    return {"daysOn": 0, "ticker": 1, "percentChangeSinceSignal": 5}


def _signal_strength_source_rows(
    *,
    html_body: str,
    textract_client: Any,
    image_fetcher: Optional[Callable[[str], bytes]],
) -> List[Dict[str, Any]]:
    """Extract the reader's three Signal Strength fields from the source chart."""
    chart = next(
        (
            item
            for item in _extract_chart_items(html_body)
            if re.search(r"(?:^|[_-])sss(?:[_-]|\.)|signal.?strength", item["name"], re.IGNORECASE)
        ),
        None,
    )
    if not chart or textract_client is None:
        return []
    source_url = _sanitize_research_image_url(chart["url"])
    if not source_url:
        return []
    payload = (image_fetcher or _fetch_market_situation_image)(source_url)
    response = textract_client.analyze_document(
        Document={"Bytes": payload},
        FeatureTypes=["TABLES"],
    )
    rows = _textract_table_rows(response)
    columns = _signal_strength_column_map(rows)
    parsed: List[Dict[str, Any]] = []
    seen = set()
    for row in rows:
        ticker_index = columns.get("ticker")
        ticker = str(row[ticker_index] if ticker_index is not None and ticker_index < len(row) else "").strip().upper()
        if ticker in {"TICKER", "SIGNAL", "STOCK", "STOCKS", "SYMBOL"} or not re.fullmatch(r"[A-Z]{1,6}(?:\.[A-Z])?", ticker):
            continue
        if ticker in seen:
            continue
        seen.add(ticker)
        stock: Dict[str, Any] = {"ticker": ticker}
        days_index = columns.get("daysOn")
        if days_index is not None and days_index < len(row):
            days_match = re.search(r"-?\d+", str(row[days_index]).replace(",", ""))
            if days_match:
                stock["daysOn"] = int(days_match.group(0))
        percent_index = columns.get("percentChangeSinceSignal")
        if percent_index is not None and percent_index < len(row):
            percent_match = re.search(r"[-+]?\d+(?:\.\d+)?", str(row[percent_index]).replace(",", ""))
            if percent_match:
                stock["percentChangeSinceSignal"] = Decimal(percent_match.group(0))
        parsed.append(stock)
    return parsed


SIGNAL_STRENGTH_TABLE_COLUMNS = {
    "ticker": "ticker",
    "name": "name",
    "sector": "sector",
    "analyst": "analyst",
    "entry date": "entryDate",
    "entry price": "entryPrice",
    "recent price": "recentPrice",
    "total return": "totalReturn",
    "best idea rank": "bestIdeaRank",
    "days held": "daysOn",
    "holding period": "daysOn",
}


def _signal_strength_decimal(value: str) -> Optional[Decimal]:
    match = re.search(r"[-+]?\d+(?:\.\d+)?", str(value or "").replace(",", ""))
    return Decimal(match.group(0)) if match else None


def _signal_strength_html_rows(html_body: str, *, side: str) -> List[Dict[str, Any]]:
    """Read the published open-positions table that replaced the SSS chart on 2026-09-25."""
    for table_match in re.finditer(r"<table\b[^>]*>(.*?)</table>", html_body, re.IGNORECASE | re.DOTALL):
        table_html = table_match.group(1)
        headers = [
            _signal_strength_header_key(_strip_tags(cell))
            for cell in re.findall(r"<th\b[^>]*>(.*?)</th>", table_html, re.IGNORECASE | re.DOTALL)
        ]
        columns = {
            SIGNAL_STRENGTH_TABLE_COLUMNS[header]: index
            for index, header in enumerate(headers)
            if header in SIGNAL_STRENGTH_TABLE_COLUMNS
        }
        if "ticker" not in columns or "entryDate" not in columns:
            continue
        body = re.search(r"<tbody\b[^>]*>(.*?)</tbody>", table_html, re.IGNORECASE | re.DOTALL)
        rows: List[Dict[str, Any]] = []
        seen = set()
        for row_match in re.finditer(r"<tr\b[^>]*>(.*?)</tr>", body.group(1) if body else table_html, re.IGNORECASE | re.DOTALL):
            cells = [
                re.sub(r"\s+", " ", _strip_tags(cell)).strip()
                for cell in re.findall(r"<td\b[^>]*>(.*?)</td>", row_match.group(1), re.IGNORECASE | re.DOTALL)
            ]

            def cell(field: str) -> str:
                index = columns.get(field)
                return cells[index] if index is not None and index < len(cells) else ""

            ticker = cell("ticker").upper()
            if not re.fullmatch(r"[A-Z]{1,6}(?:\.[A-Z])?", ticker) or ticker in seen:
                continue
            seen.add(ticker)
            stock: Dict[str, Any] = {"ticker": ticker, "side": side}
            for field in ("name", "sector", "analyst", "bestIdeaRank"):
                if cell(field):
                    stock[field] = cell(field)
            entry_date = _normalize_etf_date(cell("entryDate"))
            if entry_date:
                stock["entryDate"] = entry_date
            for field in ("entryPrice", "recentPrice", "totalReturn"):
                value = _signal_strength_decimal(cell(field))
                if value is not None:
                    stock[field] = value
            days = re.search(r"-?\d+", cell("daysOn").replace(",", ""))
            if days:
                stock["daysOn"] = int(days.group(0))
            # Hedgeye's Total Return is the position's return. Only for the
            # long book does it equal the price change since the signal.
            if side == "long" and "totalReturn" in stock:
                stock["percentChangeSinceSignal"] = stock["totalReturn"]
            rows.append(stock)
        if rows:
            return rows
    return []


def _signal_strength_change_symbols(text: str, labels: Tuple[str, ...]) -> List[str]:
    """Read "Added:" (through 2026-09-24) or "ADDING:" (since 2026-09-25) lists.

    A label with no symbols must not borrow the next label's line.
    """
    for label in labels:
        value = _extract_first(rf"\b{label}[ \t]*:\s*([^\n]+)", text, re.IGNORECASE)
        if value is None:
            continue
        if re.match(r"(?:ADDING|ADDED|REMOVING|REMOVED|Ticker)\b", value, re.IGNORECASE):
            return []
        return _extract_symbol_list(value)
    return []


TRACKER_TRENDS = frozenset({"BULLISH", "BEARISH", "NEUTRAL"})
TRACKER_TICKER_PATTERN = re.compile(r"[A-Z][A-Z0-9]{0,9}(?:[./-][A-Z0-9]{1,6})?")
TRACKER_OUTBUCKET_PATTERN = re.compile(
    r"#?OUT\s*BUCKET(?:\s*\(\s*(\d{1,2})\s*/\s*(\d{1,2})\s*\))?",
    re.IGNORECASE,
)
TRACKER_UNAVAILABLE_PATTERN = re.compile(
    r"(?:N\.?/?A\.?|NOT\s+AVAILABLE|UNAVAILABLE|[-\u2013\u2014]+)",
    re.IGNORECASE,
)


class TrackerTableHeaderError(ValueError):
    """A Textract table is not one of the approved tracker table shapes."""


def _sanitized_chart_items(html_body: str) -> List[Dict[str, str]]:
    charts: List[Dict[str, str]] = []
    for item in _extract_chart_items(html_body):
        source_url = _sanitize_research_image_url(item["url"])
        if source_url:
            charts.append({**item, "url": source_url})
    return charts


def _select_tracker_chart(
    charts: List[Dict[str, str]],
    *,
    preferred_name: str,
    fallback_index: int,
) -> Dict[str, str]:
    preferred = next(
        (
            item
            for item in charts
            if str(item.get("name") or "").strip().lower() == preferred_name.lower()
        ),
        None,
    )
    selected = preferred or (
        charts[fallback_index] if 0 <= fallback_index < len(charts) else None
    )
    if not selected:
        raise ValueError(f"Required tracker chart {preferred_name} is missing")
    source_url = _sanitize_research_image_url(selected.get("url") or "")
    if not source_url:
        raise ValueError(f"Required tracker chart {preferred_name} has an unsafe URL")
    return {**selected, "url": source_url}


def _tracker_header_key(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", str(value or "").lower()).strip()


def _tracker_column_map(
    rows: List[List[str]],
    *,
    required_fields: Tuple[str, ...],
) -> Tuple[int, Dict[str, int]]:
    for row_index, row in enumerate(rows[:6]):
        columns: Dict[str, int] = {}
        for index, value in enumerate(row):
            header = _tracker_header_key(value)
            if header in {"ticker", "symbol", "crypto", "cryptocurrency"}:
                columns["ticker"] = index
            elif header in {"price", "current price", "last price"}:
                columns["price"] = index
            elif header == "buy trade" or header.startswith("buy trade "):
                columns["buyTrade"] = index
            elif header == "sell trade" or header.startswith("sell trade "):
                columns["sellTrade"] = index
            elif header == "upside" or header.startswith("upside "):
                columns["upside"] = index
            elif header == "downside" or header.startswith("downside "):
                columns["downside"] = index
            elif header in {"trade", "trade signal", "trade direction"}:
                columns["trade"] = index
            elif header == "trend" or header.startswith("trend "):
                columns["trend"] = index

        # MOMO's source table intentionally leaves the first header cell blank.
        # Only infer that exact position after the other named columns prove the
        # expected table shape; never infer a ticker column from an arbitrary chart.
        if "ticker" not in columns and columns.get("buyTrade", 0) > 0:
            columns["ticker"] = 0
        if all(field in columns for field in required_fields):
            return row_index, columns
    raise TrackerTableHeaderError(
        "Tracker table does not contain the recognized required headers"
    )


def _parse_tracker_number(value: Any, *, field: str, ticker: str) -> Decimal:
    normalized = str(value or "").strip().replace(",", "")
    normalized = re.sub(r"^[+$]\s*", "", normalized)
    normalized = re.sub(r"%$", "", normalized).strip()
    if not re.fullmatch(r"[-+]?\d+(?:\.\d+)?", normalized):
        raise ValueError(f"Tracker row {ticker} has invalid {field}")
    parsed = Decimal(normalized)
    if not parsed.is_finite():
        raise ValueError(f"Tracker row {ticker} has invalid {field}")
    return parsed


def _normalize_tracker_trend(value: Any, *, ticker: str) -> str:
    """Normalize OCR separators while rejecting anything but a known trend."""
    normalized = unicodedata.normalize("NFKC", str(value or "")).strip().upper()
    if re.search(r"[^A-Z\s._/-]", normalized):
        raise ValueError(f"Tracker row {ticker} has invalid trend")
    letters_only = re.sub(r"[\s._/-]+", "", normalized)
    if letters_only not in TRACKER_TRENDS:
        raise ValueError(f"Tracker row {ticker} has invalid trend")
    return letters_only


def _parse_tracker_outbucket_marker(
    value: Any,
    *,
    field: str,
    ticker: str,
) -> Tuple[bool, Optional[str]]:
    normalized = str(value or "").strip()
    match = TRACKER_OUTBUCKET_PATTERN.fullmatch(normalized)
    if not match:
        return False, None
    if not match.group(1):
        return True, None

    month = int(match.group(1))
    day = int(match.group(2))
    try:
        # A leap year accepts every valid month/day pair without inferring the
        # publication year from the partial date printed in the chart.
        datetime(2000, month, day)
    except ValueError as error:
        raise ValueError(
            f"Tracker row {ticker} has invalid {field} outbucket date"
        ) from error
    return True, f"{month:02d}/{day:02d}"


def _tracker_value_is_unavailable(value: Any) -> bool:
    normalized = str(value or "").strip()
    return not normalized or bool(TRACKER_UNAVAILABLE_PATTERN.fullmatch(normalized))


def _parse_tracker_table(
    rows: List[List[str]],
    *,
    required_fields: Tuple[str, ...],
    allow_outbucket_rows: bool = False,
) -> Dict[str, Dict[str, Any]]:
    header_index, columns = _tracker_column_map(
        rows,
        required_fields=required_fields,
    )
    parsed: Dict[str, Dict[str, Any]] = {}
    for row in rows[header_index + 1:]:
        if not any(str(value or "").strip() for value in row):
            continue
        ticker_index = columns["ticker"]
        ticker = str(
            row[ticker_index] if ticker_index < len(row) else ""
        ).strip().upper()
        if not TRACKER_TICKER_PATTERN.fullmatch(ticker):
            raise ValueError("Tracker table contains an incomplete or invalid ticker row")
        if ticker in parsed:
            raise ValueError(f"Tracker table contains duplicate ticker {ticker}")

        raw_values = {
            field: (
                row[columns[field]] if columns[field] < len(row) else ""
            )
            for field in required_fields
            if field != "ticker"
        }

        def add_explicit_trade(record):
            if "trade" not in columns:
                return
            raw_trade = row[columns["trade"]] if columns["trade"] < len(row) else ""
            try:
                # Apply the same OCR-separator normalization as Trend, but an
                # unrecognized Trade cell is simply not published as a signal.
                trade = _normalize_tracker_trend(raw_trade, ticker=ticker)
            except ValueError:
                return
            record["trade"] = trade
            record["signalProvenance"] = {"field": "trade", "method": "explicit-field",
                                          "sourceField": f"tracker.{ticker}.Trade",
                                          "sourceText": f"{ticker}: Trade {raw_trade}"}

        trend = (
            _normalize_tracker_trend(raw_values.get("trend"), ticker=ticker)
            if "trend" in required_fields
            else ""
        )

        buy_is_outbucket, buy_status_date = _parse_tracker_outbucket_marker(
            raw_values.get("buyTrade"),
            field="buyTrade",
            ticker=ticker,
        )
        sell_is_outbucket, sell_status_date = _parse_tracker_outbucket_marker(
            raw_values.get("sellTrade"),
            field="sellTrade",
            ticker=ticker,
        )
        is_outbucket_row = buy_is_outbucket or sell_is_outbucket
        if is_outbucket_row:
            if not allow_outbucket_rows:
                raise ValueError(f"Tracker row {ticker} has an unsupported outbucket range")
            if not (buy_is_outbucket and sell_is_outbucket):
                raise ValueError(f"Tracker row {ticker} has a partial outbucket range")
            if buy_status_date != sell_status_date:
                raise ValueError(f"Tracker row {ticker} has mismatched outbucket dates")
            for field in ("upside", "downside"):
                if field in required_fields and not _tracker_value_is_unavailable(
                    raw_values.get(field)
                ):
                    raise ValueError(
                        f"Tracker row {ticker} has {field} for an outbucket range"
                    )

            record = {
                field: None
                for field in required_fields
                if field not in {"ticker", "trend"}
            }
            if "trend" in required_fields:
                record["trend"] = trend
            record["rangeStatus"] = "outbucket"
            if buy_status_date:
                record["rangeStatusDate"] = buy_status_date
            add_explicit_trade(record)
            record["lrr"] = None
            record["hrr"] = None
            record["index"] = len(parsed)
            parsed[ticker] = record
            continue

        record: Dict[str, Any] = {}
        for field in required_fields:
            if field == "ticker":
                continue
            if field == "trend":
                record[field] = trend
            else:
                record[field] = _parse_tracker_number(
                    raw_values.get(field),
                    field=field,
                    ticker=ticker,
                )

        if allow_outbucket_rows:
            record["rangeStatus"] = "available"

        for price_field in ("price", "buyTrade", "sellTrade"):
            if price_field in record and record[price_field] <= 0:
                raise ValueError(f"Tracker row {ticker} has non-positive {price_field}")
        if record.get("buyTrade") is not None and record.get("sellTrade") is not None:
            if record["buyTrade"] >= record["sellTrade"]:
                raise ValueError(f"Tracker row {ticker} has an unordered trade range")
        # The source Trend column is not a directional Trade signal. A Trade
        # field is present only when the publication has an independent column.
        add_explicit_trade(record)
        record["lrr"] = record.get("buyTrade")
        record["hrr"] = record.get("sellTrade")
        record["index"] = len(parsed)
        parsed[ticker] = record

    if not parsed:
        raise ValueError("Tracker table contains no complete security rows")
    return parsed


def _extract_tracker_chart_table(
    *,
    chart: Dict[str, str],
    textract_client: Any,
    image_fetcher: Optional[Callable[[str], bytes]],
    required_fields: Tuple[str, ...],
    allow_outbucket_rows: bool = False,
) -> Dict[str, Dict[str, Any]]:
    payload = (image_fetcher or _fetch_market_situation_image)(chart["url"])
    response = textract_client.analyze_document(
        Document={"Bytes": payload},
        FeatureTypes=["TABLES"],
    )
    parsed_tables: List[Dict[str, Dict[str, Any]]] = []
    for table_rows in _textract_tables(response):
        try:
            parsed_tables.append(_parse_tracker_table(
                table_rows,
                required_fields=required_fields,
                allow_outbucket_rows=allow_outbucket_rows,
            ))
        except TrackerTableHeaderError:
            # BTC_2.png also contains a volume table. Ignore only tables whose
            # headers prove they are not the approved risk-range/trend table.
            continue
    if len(parsed_tables) != 1:
        raise ValueError(
            "Tracker chart must contain exactly one recognized complete table"
        )
    return parsed_tables[0]


def _paeth_predictor(left: int, above: int, upper_left: int) -> int:
    estimate = left + above - upper_left
    left_distance = abs(estimate - left)
    above_distance = abs(estimate - above)
    upper_left_distance = abs(estimate - upper_left)
    if left_distance <= above_distance and left_distance <= upper_left_distance:
        return left
    if above_distance <= upper_left_distance:
        return above
    return upper_left


def _decode_png_rows(payload: bytes) -> Tuple[int, int, int, List[bytearray]]:
    """Decode the small RGB/RGBA PNG subset emitted by the report generator."""
    if not payload.startswith(b"\x89PNG\r\n\x1a\n"):
        raise ValueError("Market Situation signal matrix is not a PNG")

    offset = 8
    width = height = bit_depth = color_type = interlace = None
    compressed = bytearray()
    while offset + 12 <= len(payload):
        chunk_length = struct.unpack(">I", payload[offset:offset + 4])[0]
        chunk_type = payload[offset + 4:offset + 8]
        chunk_start = offset + 8
        chunk_end = chunk_start + chunk_length
        if chunk_end + 4 > len(payload):
            raise ValueError("Market Situation PNG is truncated")
        chunk = payload[chunk_start:chunk_end]
        if chunk_type == b"IHDR":
            if len(chunk) != 13:
                raise ValueError("Market Situation PNG has an invalid header")
            width, height, bit_depth, color_type, compression, filtering, interlace = struct.unpack(
                ">IIBBBBB",
                chunk,
            )
            if compression != 0 or filtering != 0:
                raise ValueError("Market Situation PNG uses an unsupported encoding")
        elif chunk_type == b"IDAT":
            compressed.extend(chunk)
        elif chunk_type == b"IEND":
            break
        offset = chunk_end + 4

    if (
        not width
        or not height
        or width > 5000
        or height > 2000
        or width * height > 5_000_000
        or bit_depth != 8
        or color_type not in {2, 6}
        or interlace != 0
    ):
        raise ValueError("Market Situation PNG format is unsupported")

    bytes_per_pixel = 3 if color_type == 2 else 4
    stride = width * bytes_per_pixel
    decoded = zlib.decompress(bytes(compressed))
    expected_length = height * (stride + 1)
    if len(decoded) != expected_length:
        raise ValueError("Market Situation PNG scanlines are incomplete")

    rows: List[bytearray] = []
    cursor = 0
    previous = bytearray(stride)
    for _ in range(height):
        filter_type = decoded[cursor]
        cursor += 1
        raw = decoded[cursor:cursor + stride]
        cursor += stride
        row = bytearray(stride)
        for index, value in enumerate(raw):
            left = row[index - bytes_per_pixel] if index >= bytes_per_pixel else 0
            above = previous[index]
            upper_left = previous[index - bytes_per_pixel] if index >= bytes_per_pixel else 0
            if filter_type == 0:
                predictor = 0
            elif filter_type == 1:
                predictor = left
            elif filter_type == 2:
                predictor = above
            elif filter_type == 3:
                predictor = (left + above) // 2
            elif filter_type == 4:
                predictor = _paeth_predictor(left, above, upper_left)
            else:
                raise ValueError("Market Situation PNG uses an unsupported row filter")
            row[index] = (value + predictor) & 0xFF
        rows.append(row)
        previous = row
    return width, height, bytes_per_pixel, rows


def _extract_market_situation_signals(payload: bytes) -> List[Dict[str, str]]:
    width, height, bytes_per_pixel, rows = _decode_png_rows(payload)
    row_hits: List[Dict[str, Any]] = []
    minimum_pixels_per_scanline = max(20, width // 20)

    for y, row in enumerate(rows):
        counts: Dict[Tuple[int, int, int], int] = {}
        x_sums: Dict[Tuple[int, int, int], int] = {}
        for offset in range(0, len(row), bytes_per_pixel):
            color = tuple(row[offset:offset + 3])
            if color not in MARKET_SITUATION_SIGNAL_COLORS:
                continue
            counts[color] = counts.get(color, 0) + 1
            x_sums[color] = x_sums.get(color, 0) + (offset // bytes_per_pixel)
        total = sum(counts.values())
        if total < minimum_pixels_per_scanline:
            continue
        dominant_color = max(counts, key=counts.get)
        row_hits.append(
            {
                "y": y,
                "count": counts[dominant_color],
                "xSum": x_sums[dominant_color],
                "color": dominant_color,
            }
        )

    bands: List[Dict[str, Any]] = []
    for hit in row_hits:
        if (
            not bands
            or hit["y"] > bands[-1]["lastY"] + 1
            or hit["color"] != bands[-1]["color"]
        ):
            bands.append(
                {
                    "firstY": hit["y"],
                    "lastY": hit["y"],
                    "count": hit["count"],
                    "xSum": hit["xSum"],
                    "color": hit["color"],
                }
            )
        else:
            bands[-1]["lastY"] = hit["y"]
            bands[-1]["count"] += hit["count"]
            bands[-1]["xSum"] += hit["xSum"]

    minimum_band_pixels = max(500, int(width * height * 0.002))
    signal_bands = [band for band in bands if band["count"] >= minimum_band_pixels]
    if len(signal_bands) != len(MARKET_SITUATION_SIGNAL_ROWS):
        raise ValueError(
            "Market Situation signal matrix did not contain four verified selections"
        )

    signals = []
    # Both source templates are published at multiple image resolutions. Choose
    # the layout from all four observed color/column selections, never pixel
    # width: a 1552px compact matrix is still the compact layout.
    known_layouts = ((0.412, 0.585, 0.758), (0.432, 0.658, 0.884))
    observed_centers = [
        (band["xSum"] / band["count"]) / width for band in signal_bands
    ]
    verified_layouts = [
        centers for centers in known_layouts
        if all(
            abs(centers[MARKET_SITUATION_SIGNAL_COLORS[band["color"]][0]] - observed) <= 0.04
            for band, observed in zip(signal_bands, observed_centers)
        )
    ]
    if not verified_layouts:
        raise ValueError(
            "Market Situation signal matrix selections failed color/position verification"
        )
    expected_centers = min(
        verified_layouts,
        key=lambda centers: sum(
            abs(centers[MARKET_SITUATION_SIGNAL_COLORS[band["color"]][0]] - observed)
            for band, observed in zip(signal_bands, observed_centers)
        ),
    )
    for row_definition, band in zip(MARKET_SITUATION_SIGNAL_ROWS, signal_bands):
        signal_id, label, choices = row_definition
        x_center = (band["xSum"] / band["count"]) / width
        choice_index = min(
            range(len(expected_centers)),
            key=lambda index: abs(expected_centers[index] - x_center),
        )
        color_choice_index, tone = MARKET_SITUATION_SIGNAL_COLORS[band["color"]]
        if choice_index != color_choice_index:
            raise ValueError(
                f"Market Situation {label} selection failed color/position verification"
            )
        signals.append(
            {
                "id": signal_id,
                "label": label,
                "value": choices[choice_index],
                "tone": tone,
            }
        )
    return signals


def _extract_market_situation_summary(text: str) -> Optional[str]:
    match = re.search(
        r"To access the full Market Situation Report\s*[-=]*>\s*Click Here\s+(.+)",
        text,
        re.IGNORECASE | re.DOTALL,
    )
    if not match:
        return None
    summary = re.split(
        r"(?:Disclaimer|Copyright|Unsubscribe|Click Here to Learn More)",
        match.group(1),
        maxsplit=1,
        flags=re.IGNORECASE,
    )[0]
    summary = re.sub(
        r"\(\s*VIEW LARGER IMAGE\s*\)",
        " ",
        summary,
        flags=re.IGNORECASE,
    )
    summary = re.sub(r"\s+", " ", summary).strip()
    if len(summary) > 2400:
        sentence_end = summary.rfind(". ", 0, 2400)
        summary = summary[:sentence_end + 1 if sentence_end >= 1200 else 2400].rstrip()
    return summary or None


def _extract_message_date(text: str, fallback: datetime) -> Tuple[str, str]:
    time_text = _extract_first(r"(\d{2}/\d{2}/\d{4}\s+\d{1,2}:\d{2}\s+[AP]M(?:\s+[A-Z]{2,4})?)", text)
    if not time_text:
        iso = fallback.astimezone(timezone.utc).isoformat()
        return fallback.strftime("%Y-%m-%d"), iso

    date_only = re.match(r"(\d{2})/(\d{2})/(\d{4})", time_text)
    if not date_only:
        iso = fallback.astimezone(timezone.utc).isoformat()
        return fallback.strftime("%Y-%m-%d"), iso

    month, day, year = map(int, date_only.groups())
    parsed = datetime(year, month, day, tzinfo=timezone.utc)
    return parsed.strftime("%Y-%m-%d"), parsed.isoformat()


def _extract_section_text(text: str, label: str, stop_labels: List[str]) -> str:
    stop_pattern = "|".join(re.escape(item) for item in stop_labels)
    pattern = rf"{re.escape(label)}\s*[:\-]\s*(.+?)(?=\n\s*(?:{stop_pattern})\b|$)"
    match = re.search(pattern, text, re.IGNORECASE | re.DOTALL)
    return match.group(1).strip() if match else ""


def _extract_symbols(raw_text: str) -> List[str]:
    if not raw_text:
        return []

    ignored_tokens = {
        "LONG",
        "LONGS",
        "SHORT",
        "SHORTS",
        "BULLISH",
        "BEARISH",
        "TOP",
        "POSITIONING",
        "MAIN",
        "SUMMARY",
        "NEUTRAL",
    }

    normalized_text = re.sub(r"\s*\([^)]*\)", "", raw_text)
    items = []
    for chunk in re.split(r"[;,\n]+", normalized_text):
        cleaned = chunk.strip().strip(".:")
        if not cleaned:
            continue

        slash_parts = [part.strip() for part in cleaned.split("/") if part.strip()]
        if len(slash_parts) > 1:
            right = slash_parts[-1]
            if re.fullmatch(r"[A-Z0-9]{2,8}", right):
                items.append(right)
                continue

        explicit_symbols = re.findall(r"\b[A-Z]{2,8}\b", cleaned)
        if explicit_symbols:
            items.extend(token for token in explicit_symbols if token not in ignored_tokens)
            continue

        fallback_words = re.findall(r"[A-Za-z]+", cleaned)
        if fallback_words:
            candidate = fallback_words[0].upper()
            if candidate not in ignored_tokens:
                items.append(candidate)

    return list(dict.fromkeys(items))


def _extract_investing_ideas_table(html_body: str) -> List[Dict[str, Any]]:
    """Extract the long/short table used by Investing Ideas newsletters.

    Hedgeye has published this product in two materially different HTML
    layouts: the older template marks rows with ``class=long|short`` and the
    newer template uses a normal table with named headers.  Keep the output
    shape stable, but make the row mapping explicit so a template change
    cannot silently turn a publication into an empty snapshot.
    """

    def normalize_side(value: Any) -> Optional[str]:
        normalized = re.sub(r"[^a-z]", "", _strip_tags(str(value or "")).lower())
        if normalized in {"long", "buy", "bullish"}:
            return "Long"
        if normalized in {"short", "sell", "bearish"}:
            return "Short"
        return None

    def normalized_header(value: Any) -> str:
        return re.sub(r"[^a-z0-9]", "", _strip_tags(str(value or "")).lower())

    def header_index(headers: List[str], patterns: Tuple[str, ...]) -> Optional[int]:
        for index, header in enumerate(headers):
            if any(pattern in header for pattern in patterns):
                return index
        return None

    def parse_row(
        cells: List[str],
        side: Optional[str],
        *,
        ticker_index: int = 0,
        side_index: Optional[int] = None,
        previous_close_index: int = 1,
        low_index: int = 2,
        high_index: int = 3,
    ) -> Optional[Dict[str, Any]]:
        if side is None and side_index is not None and side_index < len(cells):
            side = normalize_side(cells[side_index])
        if side is None or ticker_index >= len(cells):
            return None

        ticker = _normalize_ticker(_strip_tags(cells[ticker_index]))
        # A header row can contain a side-like label but is not a position.
        if not re.fullmatch(r"[A-Z][A-Z0-9./-]{0,9}", ticker):
            return None
        required_indexes = (previous_close_index, low_index, high_index)
        if any(index >= len(cells) for index in required_indexes):
            raise ValueError(
                f"Investing Ideas row for {ticker} is missing required risk-range cells"
            )

        previous_close = _parse_etf_money(_strip_tags(cells[previous_close_index]))
        low_end = _parse_etf_money(_strip_tags(cells[low_index]))
        high_end = _parse_etf_money(_strip_tags(cells[high_index]))
        if (
            previous_close is None
            or low_end is None
            or high_end is None
            or previous_close <= 0
            or low_end <= 0
            or high_end <= 0
        ):
            raise ValueError(f"Investing Ideas row for {ticker} has invalid numeric fields")
        if low_end >= high_end:
            raise ValueError(f"Investing Ideas row for {ticker} has an invalid LRR/HRR range")

        return {
            "ticker": ticker,
            "side": side,
            "position": side.lower(),
            "prevClose": previous_close,
            "lrr": low_end,
            "hrr": high_end,
            "originalName": ticker,
        }

    def direct_cells(row_body: str) -> List[str]:
        token_pattern = re.compile(
            r"<(?P<closing>/)?(?P<tag>td|th)\b[^>]*>",
            re.IGNORECASE,
        )
        cells: List[str] = []
        depth = 0
        start: Optional[int] = None
        for token in token_pattern.finditer(row_body):
            if token.group("closing"):
                if depth <= 0:
                    continue
                depth -= 1
                if depth == 0 and start is not None:
                    cells.append(row_body[start:token.start()])
                    start = None
            else:
                if depth == 0:
                    start = token.end()
                depth += 1
        return cells

    def class_rows(source: str) -> List[Tuple[str, str, List[str]]]:
        token_pattern = re.compile(
            r"<(?P<closing>/)?tr\b(?P<attrs>[^>]*)>",
            re.IGNORECASE,
        )
        class_open_pattern = re.compile(
            r"<tr(?P<attrs>[^>]*\bclass\s*=\s*[\"'][^\"']*(?:long|short)[^\"']*[\"'][^>]*)>",
            re.IGNORECASE,
        )
        parsed: List[Tuple[str, str, List[str]]] = []
        for opening in class_open_pattern.finditer(source):
            depth = 0
            closing_start: Optional[int] = None
            for token in token_pattern.finditer(source, opening.start()):
                if token.group("closing"):
                    depth -= 1
                    if depth == 0:
                        closing_start = token.start()
                        break
                else:
                    depth += 1
            if closing_start is None:
                raise ValueError("Investing Ideas table contains an unclosed position row")
            row_body = source[opening.end():closing_start]
            cells = direct_cells(row_body)
            if not cells:
                raise ValueError("Investing Ideas table contains an empty position row")
            parsed.append((opening.group("attrs") or "", row_body, cells))
        return parsed

    def simple_rows(source: str) -> List[Tuple[str, str, List[str]]]:
        table_blocks = re.findall(
            r"<table\b[^>]*>(.*?)</table>",
            source,
            re.IGNORECASE | re.DOTALL,
        ) or [source]
        row_pattern = re.compile(
            r"<tr(?P<attrs>[^>]*)>(?P<body>.*?)</tr>",
            re.IGNORECASE | re.DOTALL,
        )
        cell_pattern = re.compile(
            r"<(?:td|th)\b[^>]*>(.*?)</(?:td|th)>",
            re.IGNORECASE | re.DOTALL,
        )
        parsed: List[Tuple[str, str, List[str]]] = []
        for table in table_blocks:
            for match in row_pattern.finditer(table):
                row_body = match.group("body")
                cells = cell_pattern.findall(row_body)
                if cells:
                    parsed.append((match.group("attrs"), row_body, cells))
        return parsed

    rows: List[Dict[str, Any]] = []
    seen: Dict[str, Dict[str, Any]] = {}
    parsed_rows = class_rows(html_body) or simple_rows(html_body)
    if not parsed_rows:
        return rows

    header_row = next(
        (
            cells
            for _attrs, row_body, cells in parsed_rows
            if "<th" in row_body.lower()
            or any(
                header in {
                    "ticker",
                    "symbol",
                    "security",
                    "side",
                    "position",
                    "direction",
                    "prevclose",
                    "previousclose",
                    "lrr",
                    "hrr",
                }
                for header in [normalized_header(cell) for cell in cells]
            )
        ),
        None,
    )
    headers = [normalized_header(cell) for cell in header_row] if header_row else []
    ticker_index = header_index(headers, ("ticker", "symbol", "security", "stock"))
    side_index = header_index(headers, ("side", "position", "direction", "bias", "call"))
    previous_close_index = header_index(headers, ("prevclose", "previousclose", "close"))
    low_index = header_index(headers, ("lrr", "low", "lower"))
    high_index = header_index(headers, ("hrr", "high", "upper"))
    header_indexes_complete = all(
        index is not None
        for index in (
            ticker_index,
            side_index,
            previous_close_index,
            low_index,
            high_index,
        )
    )

    for attrs, _row_body, cells in parsed_rows:
        attrs_lower = attrs.lower()
        class_side = None
        if re.search(r"\bclass\s*=\s*[\"'][^\"']*\blong\b", attrs_lower):
            class_side = "Long"
        elif re.search(r"\bclass\s*=\s*[\"'][^\"']*\bshort\b", attrs_lower):
            class_side = "Short"

        # A repeated header row (same normalized labels) is never a position.
        is_header = header_row is not None and (
            cells == header_row
            or [normalized_header(cell) for cell in cells] == headers
        )
        if class_side:
            parsed = parse_row(cells, class_side)
            if parsed is None and not is_header:
                raise ValueError("Investing Ideas table contains an invalid classified row")
        elif header_indexes_complete and not is_header:
            parsed = parse_row(
                cells,
                None,
                ticker_index=int(ticker_index),
                side_index=int(side_index),
                previous_close_index=int(previous_close_index),
                low_index=int(low_index),
                high_index=int(high_index),
            )
            # Fail closed on any non-blank row that cannot be mapped; blank
            # spacer rows in the named-header layout carry no position.
            if parsed is None and any(_strip_tags(cell).strip() for cell in cells):
                raise ValueError("Investing Ideas table contains an invalid data row")
        else:
            parsed = None

        if parsed is None:
            continue
        ticker = parsed["ticker"]
        existing = seen.get(ticker)
        if existing is not None and existing != parsed:
            raise ValueError(
                f"Investing Ideas table contains conflicting duplicate row for {ticker}"
            )
        if existing is None:
            seen[ticker] = parsed
            rows.append(parsed)
    return rows


def _split_exact_items(raw_text: str) -> List[str]:
    if not raw_text:
        return []

    normalized_text = re.sub(r"[ \t]+", " ", raw_text).strip()
    normalized_text = re.sub(r"(?<=[A-Za-z])\\n(?=[A-Za-z])", "n", normalized_text)
    normalized_text = re.sub(r"(?<=[A-Za-z])\\n(?=\s|$|[;:,.])", "n", normalized_text)
    normalized_text = normalized_text.replace("\\n", "\n")

    if ";" in normalized_text:
        chunks = [part.strip() for part in normalized_text.split(";")]
    else:
        chunks = [part.strip() for part in re.split(r"[,\n]+", normalized_text)]

    items = []
    for chunk in chunks:
        cleaned = re.sub(r"^[•\-]+\s*", "", chunk).strip().strip(" .;:")
        if cleaned:
            items.append(cleaned)

    return list(dict.fromkeys(items))


def _extract_key_takeaways(text: str) -> List[str]:
    section = _extract_first(r"Key Takeaways\s+(.+?)\s+The Big Picture", text, re.IGNORECASE | re.DOTALL)
    if not section:
        return []
    lines = [line.strip(" -•") for line in section.splitlines()]
    return [line for line in lines if line and len(line) > 10]


def _extract_article_sections(text: str) -> Dict[str, str]:
    sections: Dict[str, str] = {}
    matches = list(
        re.finditer(
            r"\n([A-Z][A-Za-z0-9/&,' ]{3,})\n",
            text,
        )
    )
    for idx, match in enumerate(matches):
        title = match.group(1).strip()
        if title.lower() in {"key takeaways"}:
            continue
        start = match.end()
        end = matches[idx + 1].start() if idx + 1 < len(matches) else len(text)
        body = text[start:end].strip()
        if body and len(body) > 20:
            sections[title] = body
    return sections


def _extract_main_summary(text: str) -> Optional[str]:
    summary = _extract_first(
        r"MAIN SUMMARY\s*:?\s*(.+?)(?=\n\s*(?:Watch|Click Here|Disclosures?|Disclaimer|Copyright)\b|$)",
        text,
        re.IGNORECASE | re.DOTALL,
    )
    if not summary:
        return None
    normalized = re.sub(r"\s+", " ", summary).strip()
    return normalized[:40_000] or None


def _has_positive_article_evidence(snapshot: Dict[str, Any]) -> bool:
    article = snapshot.get("article") or {}
    return any(
        len(re.sub(r"\s+", " ", str(article.get(field) or "")).strip()) >= 5
        for field in ("headline", "teaser", "summary")
    )


TOP_THREE_MARKER_PATTERN = re.compile(
    r"(?:hedgeye(?:'|’)?s\s+)?top\s+(?:3|three)\s+things(?:\s+today)?\s*:?\s*",
    re.IGNORECASE,
)
TOP_THREE_FOOTER_PATTERN = re.compile(
    r"\n\s*(?:VIEW LINK|CLICK HERE|Please visit|©|If you believe)\b",
    re.IGNORECASE,
)


def _clean_top_three_item(value: str) -> str:
    source = _strip_tags(value) if "<" in value else html.unescape(value)
    source = re.sub(r"^\s*[1-3]\s*[).]\s*", "", source)
    return re.sub(r"\s+", " ", source).strip(" \t\r\n•")


def _parse_top_three_item(value: str, rank: int) -> Optional[Dict[str, Any]]:
    cleaned = _clean_top_three_item(value)
    if not cleaned:
        return None
    match = re.match(r"^(.{1,80}?)\s+(?:[–—]|-)\s+(.+)$", cleaned, re.DOTALL)
    if not match:
        match = re.match(r"^([^:]{1,80}):\s+(.+)$", cleaned, re.DOTALL)
    if not match:
        return None
    title = re.sub(r"\s+", " ", match.group(1)).strip(" .:;–—-")
    body = re.sub(r"\s+", " ", match.group(2)).strip()
    if not title or not body:
        return None
    return {"rank": rank, "title": title, "body": body}


def _top_three_intro(value: str) -> Optional[str]:
    lines = [
        line.strip()
        for line in value.splitlines()
        if line.strip()
        and not re.search(r"(?:VIEW LINK|CLICK HERE|ACCESS TODAY)", line, re.IGNORECASE)
    ]
    intro = re.sub(r"\s+", " ", " ".join(lines)).strip(" :")
    return intro[:1200] or None


def _extract_top_three_items(
    html_body: str,
    text: str,
) -> Tuple[List[Dict[str, Any]], Optional[str]]:
    markers = list(TOP_THREE_MARKER_PATTERN.finditer(text))
    if not markers:
        return [], None

    for marker in reversed(markers):
        section = text[marker.end():]
        numbered_markers = list(
            re.finditer(r"(?m)^\s*([1-3])\s*[).]\s+", section)
        )
        if [int(match.group(1)) for match in numbered_markers[:3]] != [1, 2, 3]:
            continue
        items: List[Dict[str, Any]] = []
        for index, item_marker in enumerate(numbered_markers[:3]):
            end = (
                numbered_markers[index + 1].start()
                if index + 1 < 3
                else len(section)
            )
            raw_item = section[item_marker.start():end]
            footer = TOP_THREE_FOOTER_PATTERN.search(raw_item)
            if footer:
                raw_item = raw_item[:footer.start()]
            parsed = _parse_top_three_item(raw_item, index + 1)
            if parsed:
                items.append(parsed)
        if len(items) == 3:
            return items, _top_three_intro(section[:numbered_markers[0].start()])

    for ordered_list in re.findall(
        r"<ol\b[^>]*>(.*?)</ol>",
        html_body,
        re.IGNORECASE | re.DOTALL,
    ):
        raw_items = re.findall(
            r"<li\b[^>]*>(.*?)</li>",
            ordered_list,
            re.IGNORECASE | re.DOTALL,
        )
        if len(raw_items) < 3:
            continue
        parsed_items = [
            _parse_top_three_item(raw_item, index + 1)
            for index, raw_item in enumerate(raw_items[:3])
        ]
        if all(parsed_items):
            return [item for item in parsed_items if item], None

    return [], None


def _extract_symbol_list(raw_text: str) -> List[str]:
    ignored_tokens = {
        "ADDED",
        "REMOVED",
        "STOCKS",
        "SIGNAL",
        "STRENGTH",
        "AND",
        "THE",
    }
    symbols = []
    for token in re.findall(r"\b[A-Z][A-Z0-9./-]{0,9}\b", raw_text or ""):
        if token not in ignored_tokens:
            symbols.append(token)
    return list(dict.fromkeys(symbols))


def _extract_label_symbols(text: str, label: str) -> List[str]:
    value = _extract_first(
        rf"{re.escape(label)}\s*:\s*(.+?)(?:\n|$)",
        text,
        re.IGNORECASE,
    )
    return _extract_symbol_list(value or "")


def _extract_portfolio_rankings(html_body: str) -> List[Dict[str, Any]]:
    rankings = []
    table_match = re.search(
        r'<table[^>]+class="[^"]*holdings-table[^"]*"[^>]*>(.*?)</table>',
        html_body,
        re.IGNORECASE | re.DOTALL,
    )

    if table_match:
        for row_match in re.finditer(r"<tr[^>]*>(.*?)</tr>", table_match.group(1), re.IGNORECASE | re.DOTALL):
            cells = re.findall(r"<td[^>]*>(.*?)</td>", row_match.group(1), re.IGNORECASE | re.DOTALL)
            if len(cells) < 2:
                continue
            rank_text = _strip_tags(cells[0])
            if not re.fullmatch(r"\d+", rank_text):
                continue

            ticker = _strip_tags(cells[1]).upper()
            if not ticker:
                continue
            rankings.append(
                {
                    "rank": int(rank_text),
                    "ticker": ticker,
                    "weekAgo": _strip_tags(cells[2]) if len(cells) > 2 else None,
                    "monthAgo": _strip_tags(cells[3]) if len(cells) > 3 else None,
                    "entryDate": _strip_tags(cells[4]) if len(cells) > 4 else None,
                    "assetClass": _strip_tags(cells[5]) if len(cells) > 5 else None,
                    "positionSizing": _strip_tags(cells[6]) if len(cells) > 6 else None,
                }
            )

    if rankings:
        return rankings

    rank_list = _extract_first(
        r"Macro ETFs by Rank:\s*(.+?)(?:Keith's Commentary|Watch Keith|1-WEEK|$)",
        _strip_tags(html_body),
        re.IGNORECASE | re.DOTALL,
    )
    if not rank_list:
        return []

    for idx, ticker in enumerate(_extract_symbol_list(rank_list), start=1):
        rankings.append({"rank": idx, "ticker": ticker})
    return rankings


def _extract_movers(text: str, label: str) -> List[List[Dict[str, Any]]]:
    groups = []
    pattern = re.compile(
        rf"{re.escape(label)}\s*:\s*([^\n]+)",
        re.IGNORECASE,
    )
    for match in pattern.finditer(text):
        movers = []
        for ticker, change in re.findall(r"\b([A-Z][A-Z0-9./-]{0,9})\s*\(([+-]?\d+)\)", match.group(1)):
            movers.append({"ticker": ticker, "change": int(change)})
        groups.append(movers)
    return groups


def _extract_crypto_title_data(headline: Optional[str]) -> Dict[str, Dict[str, Any]]:
    cryptos: Dict[str, Dict[str, Any]] = {}
    if not headline:
        return cryptos

    normalized = headline.replace("₿TC", "BTC")
    for ticker, percent in re.findall(r"\b([A-Z]{2,6})\s*\(([+-]?\d+(?:\.\d+)?)%\)", normalized):
        cryptos[ticker] = {"performancePercent": float(percent)}
    return cryptos


def _clean_macro_show_items(items: List[str]) -> List[str]:
    blocked_phrases = [
        "no explicit bearish positions",
        "reflect commentary from the macro show",
        "may not represent the full scope",
        "click here to access today's slides",
        "click here to access todays slides",
    ]
    cleaned = []
    for item in items:
        normalized = item.strip()
        if not normalized:
            continue
        lowered = normalized.lower()
        if any(phrase in lowered for phrase in blocked_phrases):
            continue
        cleaned.append(normalized)
    return cleaned


def _extract_etf_pro_changes(text: str) -> List[Dict[str, Any]]:
    changes = []
    block_pattern = re.compile(
        r"We are\s+(ADDING|REMOVING)\s+(Long|Short)\s*:\s*(.+?)(?=\n\s*We are\s+(?:ADDING|REMOVING)\s+(?:Long|Short)\s*:|\n\s*How to Use ETF Pro Plus Updates|\n\s*Please visit|$)",
        re.IGNORECASE | re.DOTALL,
    )

    for block in block_pattern.finditer(text):
        action = "ADD" if block.group(1).upper() == "ADDING" else "REMOVE"
        side = block.group(2).title()
        body = block.group(3)
        item_pattern = re.compile(
            r"([A-Za-z0-9&.,'’/+\- ]+?)\s+\(([A-Z][A-Z0-9./-]{0,9})\)(?:\s*-\s*\(([\d.,]+)\s*-\s*([\d.,]+)\))?",
            re.DOTALL,
        )
        for item in item_pattern.finditer(body):
            name = re.sub(r"\s+", " ", item.group(1)).strip(" -•\n\t")
            ticker = item.group(2).upper()
            range_low = item.group(3)
            range_high = item.group(4)
            change = {
                "action": action,
                "side": side,
                "ticker": ticker,
                "etf": name,
                "call": side,
            }
            if range_low and range_high:
                change["riskRangeLow"] = float(range_low.replace(",", ""))
                change["riskRangeHigh"] = float(range_high.replace(",", ""))
            changes.append(change)

    return changes


def _extract_go_anywhere_portfolio(text: str) -> Dict[str, Any]:
    """Go-Anywhere is a long-only ETF book: optional ADDING/REMOVING lines,
    then a "Current Open Positions" table in every edition."""
    changes: List[Dict[str, Any]] = []
    for block in re.finditer(r"WE ARE\s+(ADDING|REMOVING)\s+(.+?)(?=WE ARE\s+(?:ADDING|REMOVING)|Current Open Positions|$)",
                             text, re.IGNORECASE | re.DOTALL):
        action = "ADD" if block.group(1).upper() == "ADDING" else "REMOVE"
        for item in re.finditer(r"([A-Z][A-Z0-9./-]{0,9})\s*\(([^)\n]{1,80})\)", block.group(2)):
            ticker = _normalize_etf_ticker(item.group(1))
            if ticker:
                changes.append({"action": action, "side": "Long", "call": "Long", "ticker": ticker,
                                "etf": re.sub(r"\s+", " ", item.group(2)).strip()})
    rows: List[Dict[str, Any]] = []
    start = text.find("Current Open Positions")
    row_pattern = re.compile(
        r"^\s*(\d{1,2})\s*\n\s*([A-Z][A-Z0-9./-]{0,9})\s*\n\s*([^\n]+?)\s*\n\s*([^\n]+?)\s*\n"
        r"\s*(\$[\d,.]+|-)\s*\n\s*([+-]?[\d.,]+%|-)\s*\n\s*(\d{1,2}/\d{1,2}/\d{2,4})",
        re.MULTILINE,
    )
    for match in row_pattern.finditer(text[start:] if start >= 0 else ""):
        ticker = _normalize_etf_ticker(match.group(2))
        if not ticker:
            continue
        total_return = match.group(6).rstrip("%").replace(",", "")
        rows.append({
            "id": f"{ticker}_{len(rows)}",
            "ticker": ticker,
            "etf": match.group(3).strip(),
            "assetClass": match.group(4).strip(),
            "call": "Long",
            "side": "Long",
            "entryPrice": _parse_etf_money(match.group(5)),
            "totalReturnPct": float(total_return) if total_return not in {"", "-"} else None,
            "dateAdded": _normalize_etf_date(match.group(7)),
            "action": None,
        })
    takeaway = re.search(r"Takeaway:\s*\n?\s*([^\n]+)", text)
    return {"changes": changes, "rows": rows, "takeaway": takeaway.group(1).strip() if takeaway else None}


def _normalize_etf_ticker(value: Any) -> Optional[str]:
    raw = str(value or "").strip()
    if raw != raw.upper():
        return None
    if raw in {"ADD", "BEARISH", "BULLISH", "LONG", "REMOVE", "SHORT", "VIEW"}:
        return None
    return raw if re.fullmatch(r"[A-Z][A-Z0-9./-]{0,9}", raw) else None


def _normalize_etf_date(value: Any) -> Optional[str]:
    match = re.fullmatch(r"\s*(\d{1,2})/(\d{1,2})/(\d{2}|\d{4})\s*", str(value or ""))
    if not match:
        return None
    month, day, year = match.groups()
    normalized_year = f"20{year}" if len(year) == 2 else year
    try:
        parsed = datetime(int(normalized_year), int(month), int(day))
    except ValueError:
        return None
    return parsed.strftime("%Y-%m-%d")


def _parse_etf_money(value: Any) -> Optional[float]:
    cleaned = re.sub(r"[$,\s]", "", str(value or ""))
    if not cleaned or cleaned == "-":
        return None
    try:
        parsed = float(cleaned)
    except ValueError:
        return None
    return parsed if math.isfinite(parsed) else None


def _extract_etf_ticker_list(value: str) -> List[str]:
    tickers: List[str] = []
    seen = set()
    without_parentheticals = re.sub(r"\([^)]*\)", " ", value)
    for token in re.split(r"[\s,;]+", without_parentheticals):
        ticker = _normalize_etf_ticker(token)
        if ticker and ticker not in seen:
            seen.add(ticker)
            tickers.append(ticker)
    return tickers


def _etf_full_book_row(
    *,
    ticker: str,
    call: str,
    index: int,
    name: Optional[str] = None,
    date_added: Optional[str] = None,
    recent_price: Optional[float] = None,
    trend_low: Optional[float] = None,
    trend_high: Optional[float] = None,
    asset_class: Optional[str] = None,
) -> Dict[str, Any]:
    return {
        "id": f"{ticker}_{index}",
        "ticker": ticker,
        "etf": name or ticker,
        "assetClass": asset_class or "ETF Pro",
        "call": call,
        "side": call,
        "dateAdded": date_added,
        "lastPrice": recent_price,
        "recentPrice": recent_price,
        "trendLowEnd": trend_low,
        "trendHighEnd": trend_high,
        "action": None,
    }


def _is_etf_weekly_header(line: str) -> bool:
    return bool(
        re.fullmatch(
            r"(?:ticker|date added|recent price\*?|trend ranges|asset class)",
            str(line or "").strip(),
            re.IGNORECASE,
        )
    )


def _parse_etf_weekly_section(
    lines: List[str],
    *,
    start_index: int,
    end_index: int,
    call: str,
) -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    index = start_index + 1
    while index < end_index:
        name = lines[index]
        if _is_etf_weekly_header(name):
            index += 1
            continue
        if index + 6 >= end_index:
            break

        ticker = _normalize_etf_ticker(lines[index + 1])
        date_added = _normalize_etf_date(lines[index + 2])
        if not ticker or not date_added:
            index += 1
            continue

        rows.append(
            _etf_full_book_row(
                ticker=ticker,
                call=call,
                index=len(rows),
                name=name,
                date_added=date_added,
                recent_price=_parse_etf_money(lines[index + 3]),
                trend_low=_parse_etf_money(lines[index + 4]),
                trend_high=_parse_etf_money(lines[index + 5]),
                asset_class=lines[index + 6],
            )
        )
        index += 7
    return rows


def _extract_etf_pro_full_book(text: str) -> Optional[Dict[str, Any]]:
    compact = re.sub(r"\s+", " ", text).strip()
    lineup = re.search(
        r"current lineup of ETFs is as follows:\s*Long:\s*(.+?)\s+Short:\s*(.+?)"
        r"(?:\s+\(\s*VIEW LARGER IMAGE\s*\)|\s+The monthly Quad|\s+Since the|"
        r"\s+How to Use|\s+Dear ETF|$)",
        compact,
        re.IGNORECASE,
    )
    if lineup:
        long_tickers = _extract_etf_ticker_list(lineup.group(1))
        short_tickers = _extract_etf_ticker_list(lineup.group(2))
        if not long_tickers and not short_tickers:
            return None
        rows = [
            *[
                _etf_full_book_row(ticker=ticker, call="Long", index=index)
                for index, ticker in enumerate(long_tickers)
            ],
            *[
                _etf_full_book_row(
                    ticker=ticker,
                    call="Short",
                    index=len(long_tickers) + index,
                )
                for index, ticker in enumerate(short_tickers)
            ],
        ]
        return {
            "rows": rows,
            "longs": long_tickers,
            "shorts": short_tickers,
            "format": "lineup",
        }

    lines = [line.strip() for line in text.replace("\r", "\n").splitlines() if line.strip()]
    bullish_index = next(
        (index for index, line in enumerate(lines) if re.fullmatch(r"BULLISH", line, re.IGNORECASE)),
        -1,
    )
    bearish_index = next(
        (index for index, line in enumerate(lines) if re.fullmatch(r"BEARISH", line, re.IGNORECASE)),
        -1,
    )
    if bullish_index < 0 or bearish_index <= bullish_index:
        return None
    end_index = next(
        (
            index
            for index, line in enumerate(lines)
            if index > bearish_index
            and re.match(r"\*All ETF recent intra day prices", line, re.IGNORECASE)
        ),
        len(lines),
    )
    long_rows = _parse_etf_weekly_section(
        lines,
        start_index=bullish_index,
        end_index=bearish_index,
        call="Long",
    )
    short_rows = _parse_etf_weekly_section(
        lines,
        start_index=bearish_index,
        end_index=end_index,
        call="Short",
    )
    if not long_rows and not short_rows:
        return None
    rows = [
        {**row, "id": f"{row['ticker']}_{index}"}
        for index, row in enumerate([*long_rows, *short_rows])
    ]
    return {
        "rows": rows,
        "longs": [row["ticker"] for row in long_rows],
        "shorts": [row["ticker"] for row in short_rows],
        "format": "weekly-table",
    }


def _extract_refreshed_spx_risk_range(text: str) -> Optional[Dict[str, Any]]:
    if not text or not re.search(
        r"(?:SPX\s+refreshed\s+risk\s+range|refreshed\s+SPX\s+risk\s+range)",
        text,
        re.IGNORECASE,
    ):
        return None

    match = re.search(
        r"(?:SPX\s+refreshed\s+risk\s+range|refreshed\s+SPX\s+risk\s+range)"
        r"\s*(?:=|:|is|of)?\s*\$?([\d,]+(?:\.\d+)?)\s*[-–—]\s*\$?([\d,]+(?:\.\d+)?)",
        text,
        re.IGNORECASE,
    )
    if not match:
        return None

    low = float(match.group(1).replace(",", ""))
    high = float(match.group(2).replace(",", ""))
    if low <= 0 or high <= 0 or low >= high:
        return None
    return {
        "ticker": "SPX",
        "lrr": low,
        "hrr": high,
        "label": "SPX Refreshed Risk Range",
    }


def _with_refreshed_spx_risk_range(alert: Dict[str, Any], text: str) -> Dict[str, Any]:
    refreshed_range = _extract_refreshed_spx_risk_range(text)
    if refreshed_range:
        alert["refreshedRiskRange"] = refreshed_range
    return alert


def _parse_real_time_alert(headline: Optional[str], text: str, html_body: str) -> Optional[Dict[str, Any]]:
    if not headline:
        headline = _extract_headline(html_body, text)
    if not headline:
        return None

    normalized = re.sub(r"^[*\s]+", "", headline).strip()
    inline_match = re.search(
        r"\b(BUY|SELL-SOME|SELL|COVER)\s+SIGNAL(?:\s*-\s*(SHORTING|COVERING|BUYING|SELLING))?\s+([A-Z][A-Z0-9./-]{0,9})\b",
        normalized,
        re.IGNORECASE,
    )
    if inline_match:
        action = inline_match.group(1).upper()
        modifier = (inline_match.group(2) or "").upper()
        ticker = inline_match.group(3).upper()
        return _with_refreshed_spx_risk_range({
            "headline": normalized,
            "signalFamily": "Real-Time",
            "signalPhrase": inline_match.group(0),
            "action": action,
            "intent": "open-short" if modifier == "SHORTING" else "open-long" if modifier == "BUYING" else None,
            "side": "short" if modifier == "SHORTING" else "long" if modifier == "BUYING" else None,
            "context": modifier or None,
            "ticker": ticker,
            "name": _extract_first_image_alt(html_body) or ticker,
            "analyst": None,
        }, text)

    match = re.search(
        r"Real-Time Alert:\s*(.+?)\s+Signal(?:\s*\(([^)]*)\))?\s*:\s*(.+?)(?:\s*-\s*([A-Z]{1,4}))?\s*$",
        normalized,
        re.IGNORECASE,
    )
    if match:
        signal_phrase = re.sub(r"\s+", " ", match.group(1)).strip()
        context = match.group(2).strip() if match.group(2) else None
        target = re.sub(r"\s+", " ", match.group(3)).strip()
        analyst = match.group(4).upper() if match.group(4) else None

        action = None
        if re.search(r"\bSELL-SOME\b", signal_phrase, re.IGNORECASE):
            action = "SELL-SOME"
            family = re.sub(r"\bSELL-SOME\b", "", signal_phrase, flags=re.IGNORECASE).strip()
        elif re.search(r"\bBUY\b", signal_phrase, re.IGNORECASE):
            action = "BUY"
            family = re.sub(r"\bBUY\b", "", signal_phrase, flags=re.IGNORECASE).strip()
        elif re.search(r"\bSELL\b", signal_phrase, re.IGNORECASE):
            action = "SELL"
            family = re.sub(r"\bSELL\b", "", signal_phrase, flags=re.IGNORECASE).strip()
        elif re.search(r"\bCOVER\b", signal_phrase, re.IGNORECASE):
            action = "COVER"
            family = re.sub(r"\bCOVER\b", "", signal_phrase, flags=re.IGNORECASE).strip()
        else:
            family = signal_phrase

        ticker = None
        name = target
        paren_match = re.search(r"(.+?)\s+\(([A-Z][A-Z0-9./-]{0,9})\)$", target)
        if paren_match:
            name = paren_match.group(1).strip()
            ticker = paren_match.group(2).upper()
        else:
            ticker_match = re.search(r"\b([A-Z][A-Z0-9./-]{0,9})\b", target)
            if ticker_match and target == ticker_match.group(1):
                ticker = ticker_match.group(1).upper()
                name = ticker

        return _with_refreshed_spx_risk_range({
            "headline": normalized,
            "signalFamily": family or signal_phrase,
            "signalPhrase": signal_phrase,
            "action": action,
            "context": context,
            "ticker": ticker,
            "name": name,
            "analyst": analyst,
        }, text)

    simple_match = re.search(r"^(BUY|SELL-SOME|SELL|COVER)\s+SIGNAL\s+([A-Z][A-Z0-9./-]{0,9})$", normalized, re.IGNORECASE)
    if simple_match:
        action = simple_match.group(1).upper()
        ticker = simple_match.group(2).upper()
        analyst_match = re.search(r"\n\s*([A-Z]{2,4})\s*\n", text)
        analyst = analyst_match.group(1).upper() if analyst_match else None
        return _with_refreshed_spx_risk_range({
            "headline": normalized,
            "signalFamily": "Real-Time",
            "signalPhrase": normalized,
            "action": action,
            "context": None,
            "ticker": ticker,
            "name": _extract_first_image_alt(html_body) or ticker,
            "analyst": analyst,
        }, text)

    return None


def _extract_real_time_alert(headline: Optional[str], text: str, html_body: str) -> Optional[Dict[str, Any]]:
    alert = _parse_real_time_alert(headline, text, html_body)
    if alert:
        return alert
    return None


_POSITION_CHANGE_BODY_TOKEN = re.compile(
    r"\bWe (?:have|are)\s+(ADD(?:ED|ING)|REMOV(?:ED|ING))\b"
    r"|^\s*(Long|Short)s?\s*:"
    r"|\b([A-Z][A-Z0-9./-]{0,9})\s*\(\s*(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*\)",
)
# A heading can instead list bare tickers on the lines under it, with no range:
# "We are ADDING the following to Investing Ideas:" / "Short:" / "GS".
_POSITION_CHANGE_BARE_TICKER = re.compile(r"\s*([A-Z][A-Z0-9./-]{0,9})\s*")


def _extract_position_change_body(text: str) -> Dict[str, Dict[str, Any]]:
    """Read the side (and range, when published) of each change from the body.

    A multi-change subject ("3 Changes: Remove SNOW, DELL, WING") rarely states
    the side; the body lists each ticker under its "We have ADDED/REMOVED" or
    "We are ADDING/REMOVING" block and its "Long:" or "Short:" heading, either
    with the published risk range or as a bare ticker directly under the heading.
    """
    changes: Dict[str, Dict[str, Any]] = {}
    action: Optional[str] = None
    side: Optional[str] = None
    # Bare tickers count only in the run of lines right under a heading, so a
    # later sign-off ("KM") is never read as a position.
    listing = False
    for line in (text or "").splitlines():
        if not line.strip():
            continue
        bare = _POSITION_CHANGE_BARE_TICKER.fullmatch(line)
        if listing and bare and action and side:
            changes.setdefault(bare.group(1), {"action": action, "side": side})
            continue
        listing = False
        for match in _POSITION_CHANGE_BODY_TOKEN.finditer(line):
            if match.group(1):
                action = "ADD" if match.group(1).upper().startswith("ADD") else "REMOVE"
                side = None
            elif match.group(2):
                side = match.group(2).lower()
                listing = True
                inline = _POSITION_CHANGE_BARE_TICKER.fullmatch(line[match.end():])
                if inline and action:
                    changes.setdefault(inline.group(1), {"action": action, "side": side})
            elif action and side:
                low, high = float(match.group(4)), float(match.group(5))
                if not 0 < low < high:
                    continue
                changes.setdefault(match.group(3).upper(), {
                    "action": action,
                    "side": side,
                    "riskRangeLow": low,
                    "riskRangeHigh": high,
                })
    return changes


def _position_change_range(detail: Dict[str, Any]) -> Dict[str, Any]:
    if "riskRangeLow" not in detail:
        return {}
    return {"riskRangeLow": detail["riskRangeLow"], "riskRangeHigh": detail["riskRangeHigh"]}


_MULTI_POSITION_CHANGE_SUBJECT = re.compile(r"\b\d+\s+Changes?:\s*(.+)$", re.IGNORECASE)
# A single change names the side in the subject instead:
# "Add Airbnb Inc. (ABNB) to LONG Side" / "Remove ... (TICKER) from SHORT Side".
_SINGLE_POSITION_CHANGE_SUBJECT = re.compile(
    r"^(Add|Remove)\s+.+?\(\s*([A-Z][A-Z0-9./-]{0,9})\s*\)\s+(?:to|from)\s+(?:the\s+)?(LONG|SHORT)\s+Side\b",
    re.IGNORECASE,
)


def is_position_change_subject(subject: Optional[str]) -> bool:
    """True for an Investing Ideas position-change subject, multi or single."""
    normalized = re.sub(r"\s+", " ", str(subject or "")).strip()
    return bool(
        _MULTI_POSITION_CHANGE_SUBJECT.search(normalized)
        or _SINGLE_POSITION_CHANGE_SUBJECT.search(normalized)
    )


def _extract_position_change_alerts(
    headline: Optional[str],
    body_text: str = "",
) -> List[Dict[str, Any]]:
    if not headline:
        return []
    body = _extract_position_change_body(body_text)
    normalized = re.sub(r"\s+", " ", headline).strip()
    match = _MULTI_POSITION_CHANGE_SUBJECT.search(normalized)
    single = None if match else _SINGLE_POSITION_CHANGE_SUBJECT.search(normalized)
    if single and re.search(r"\binvesting ideas\b", body_text or "", re.IGNORECASE):
        action = single.group(1).upper()
        ticker = single.group(2).upper()
        side = single.group(3).lower()
        detail = body.get(ticker) or {}
        ranged = detail.get("action") == action and detail.get("side") == side
        return [{
            "headline": normalized,
            "signalFamily": "Position Changes",
            "signalPhrase": f"{single.group(1).title()} {ticker}",
            "action": action,
            "side": side,
            "context": "position-change",
            "ticker": ticker,
            "name": ticker,
            "analyst": None,
            **(_position_change_range(detail) if ranged else {}),
        }]
    if not match:
        return []

    alerts: List[Dict[str, Any]] = []
    active_action: Optional[str] = None
    for clause in re.split(r"\s*,\s*", match.group(1)):
        # A clause may name its side before the ticker: "Add Short GS".
        item = re.search(
            r"\b(Add|Remove)\s+(?:(Long|Short)\s+)?([A-Z][A-Z0-9./-]{1,9})\b",
            clause,
            re.IGNORECASE,
        )
        stated_side: Optional[str] = None
        if item:
            active_action = "ADD" if item.group(1).upper() == "ADD" else "REMOVE"
            stated_side = item.group(2).lower() if item.group(2) else None
            ticker = item.group(3).upper()
        else:
            continuation = re.fullmatch(r"\s*([A-Z][A-Z0-9./-]{1,9})\s*", clause, re.IGNORECASE)
            if not continuation or not active_action:
                continue
            ticker = continuation.group(1).upper()
        action = active_action
        detail = body.get(ticker) or {}
        # Never assume a side: a removed short is the opposite instruction to a
        # removed long. Only the clause itself or the body's Long/Short heading
        # establishes it.
        body_side = detail.get("side") if detail.get("action") == action else None
        side = stated_side or body_side
        alerts.append({
            "headline": normalized,
            "signalFamily": "Position Changes",
            "signalPhrase": clause,
            "action": action,
            "side": side,
            "context": "position-change",
            "ticker": ticker,
            "name": ticker,
            "analyst": None,
            **(_position_change_range(detail) if body_side and body_side == side else {}),
        })
    # A long subject can be truncated; the body still lists every change.
    listed = {alert["ticker"] for alert in alerts}
    for ticker, detail in body.items():
        if alerts and ticker not in listed:
            alerts.append({
                "headline": normalized,
                "signalFamily": "Position Changes",
                "signalPhrase": f"{detail['action'].title()} {ticker}",
                "action": detail["action"],
                "side": detail["side"],
                "context": "position-change",
                "ticker": ticker,
                "name": ticker,
                "analyst": None,
                **_position_change_range(detail),
            })
    return alerts


def _normalize_ticker(label: str) -> str:
    cleaned = re.sub(r"\s+", " ", label.strip()).upper()
    return TICKER_MAP.get(cleaned, cleaned)


def _risk_range_row_signature(row: Dict[str, Any]) -> Tuple[Decimal, Decimal, str, Optional[Decimal]]:
    previous_close = row.get("prevClose")
    return (
        Decimal(str(row["lrr"])),
        Decimal(str(row["hrr"])),
        str(row.get("trend") or "").strip().upper(),
        Decimal(str(previous_close)) if previous_close is not None else None,
    )


def _add_risk_range_row(
    data: Dict[str, Dict[str, Any]],
    ticker_label: str,
    row: Dict[str, Any],
) -> None:
    ticker = _normalize_ticker(ticker_label)
    if not ticker:
        raise RiskRangePublicationError("Risk Range row has no normalized ticker")
    existing = data.get(ticker)
    if existing is None:
        data[ticker] = row
        return
    try:
        identical = _risk_range_row_signature(existing) == _risk_range_row_signature(row)
    except (InvalidOperation, KeyError, TypeError, ValueError):
        identical = existing == row
    if identical:
        return
    # Keep every conflicting published reading as evidence. No arbitrary row
    # wins; validation withholds this ticker while retaining the publication.
    conflicts = list(existing.get("_conflictingRows") or [existing])
    if row not in conflicts:
        conflicts.append(row)
    data[ticker] = {"_conflictingRows": conflicts}


def _extract_levels_from_text(text: str) -> Dict[str, Dict[str, Any]]:
    data: Dict[str, Dict[str, Any]] = {}
    section = _extract_first(
        r"Our Levels\s+(.+?)(?:Have a great day|Please visit|©|\Z)",
        text,
        re.IGNORECASE | re.DOTALL,
    )
    if not section:
        return data

    for line in section.splitlines():
        cleaned = line.strip()
        match = re.match(
            r"^(.+?)\s+([\d,]+(?:\.\d+)?)-([\d,]+(?:\.\d+)?)\s+\((bullish|bearish|neutral)\)$",
            cleaned,
            re.IGNORECASE,
        )
        if not match:
            continue

        name = match.group(1).strip()
        lrr = float(match.group(2).replace(",", ""))
        hrr = float(match.group(3).replace(",", ""))
        trend = match.group(4).upper()
        ticker = _normalize_ticker(name)
        _add_risk_range_row(data, ticker, {
            "lrr": lrr,
            "hrr": hrr,
            "trend": trend,
            "originalName": name,
        })

    return data


def _source_evidence_value(value: Any) -> Any:
    """Keep literal problematic readings serializable without coercing them."""
    if isinstance(value, (Decimal, float)):
        return value if Decimal(str(value)).is_finite() else str(value)
    if isinstance(value, dict):
        return {key: _source_evidence_value(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_source_evidence_value(item) for item in value]
    return value


def validate_research_ranges(snapshot: Dict[str, Any]) -> Dict[str, Any]:
    """Keep source discrepancies separate from successful publication intake.

    Only affected fields are withheld. Independent published signals and all
    original readings remain available; no range is swapped or guessed.
    """
    product_id = snapshot.get("snapshotType")
    if product_id not in {"early-look", "risk-ranges"}:
        return snapshot
    rows: Dict[str, Dict[str, Any]] = {}
    for ticker, row in (snapshot.get("data") or {}).items():
        _add_risk_range_row(rows, ticker, row)
    previous = snapshot.get("rangeValidation") or {}
    excluded = list(previous.get("excludedRows") or [])
    issues = list((snapshot.get("sourceQuality") or {}).get("issues") or [])
    source = {
        "productId": product_id,
        "reportDate": snapshot.get("date"),
        "messageId": snapshot.get("gmailMessageId"),
        "artifactKey": snapshot.get("htmlSource"),
        "url": (snapshot.get("article") or {}).get("feedUrl"),
        "publishedAt": snapshot.get("publishedAt"),
    }
    data = {}
    valid_count = 0
    for ticker, original in rows.items():
        known_ids = {issue.get("id") for issue in issues}
        if isinstance(original, dict) and original.get("sourceQualityIssueIds") and all(
            issue_id in known_ids for issue_id in original["sourceQualityIssueIds"]
        ):
            # A second validation pass must not turn withheld values into new
            # missing-field incidents or lose their original observations.
            data[ticker] = original
            valid_count += not bool(set(original.get("withheldFields", [])) & {"lrr", "hrr", "trend"})
            continue
        row = dict(original) if isinstance(original, dict) else {}
        problems = []
        conflicts = row.pop("_conflictingRows", None)
        if conflicts:
            row = {
                key: value for key, value in conflicts[0].items()
                if all(candidate.get(key) == value for candidate in conflicts[1:])
            }
            differing = sorted({key for candidate in conflicts for key in candidate if key not in row})
            if set(differing) & {"lrr", "hrr"}:
                differing = sorted(set(differing) | {"lrr", "hrr"})
            problems.append(("conflicting_duplicate", "riskRange", differing))
        else:
            try:
                lower, upper = Decimal(str(row["lrr"])), Decimal(str(row["hrr"]))
                bounds_valid = lower.is_finite() and upper.is_finite() and lower < upper
            except (InvalidOperation, KeyError, TypeError, ValueError):
                bounds_valid = False
            if not bounds_valid:
                problems.append(("invalid_bounds", "riskRange", ["lrr", "hrr"]))
            if str(row.get("trend") or "").strip().upper() not in {"BULLISH", "BEARISH", "NEUTRAL"}:
                problems.append(("invalid_trend", "trend", ["trend"]))
            if row.get("prevClose") is not None:
                try:
                    close_valid = Decimal(str(row["prevClose"])).is_finite()
                except (InvalidOperation, TypeError, ValueError):
                    close_valid = False
                if not close_valid:
                    problems.append(("invalid_previous_close", "prevClose", ["prevClose"]))
        if not problems:
            data[ticker] = row
            valid_count += 1
            continue
        observed = _source_evidence_value(original)
        messages = {
            "invalid_bounds": f"Published {ticker} risk-range bounds are missing, nonnumeric, or not ordered from lower to upper.",
            "invalid_trend": f"Published {ticker} trend is missing or unrecognized.",
            "conflicting_duplicate": f"The publication contains conflicting risk-range rows for {ticker}.",
            "invalid_previous_close": f"Published {ticker} previous close is not a finite number.",
        }
        row_issue_ids, withheld = [], []
        for reason, field, affected_fields in problems:
            issue_identity = {"source": source, "ticker": ticker, "code": reason, "observed": observed}
            issue_id = hashlib.sha256(json.dumps(issue_identity, sort_keys=True, default=str).encode("utf-8")).hexdigest()[:24]
            issue = {
                "id": issue_id,
                "code": reason,
                "ticker": ticker,
                "field": field,
                "affectedFields": affected_fields,
                "observed": observed,
                "message": messages[reason],
                "disposition": "withheld_from_structured_data",
                "source": source,
            }
            if issue_id not in known_ids:
                issues.append(issue)
                known_ids.add(issue_id)
            row_issue_ids.append(issue_id)
            withheld.extend(affected_fields)
            exclusion = {"ticker": ticker, "reason": reason}
            if exclusion not in excluded:
                excluded.append(exclusion)
        for field in withheld:
            row.pop(field, None)
        row["withheldFields"] = sorted(set(withheld))
        row["sourceQualityIssueIds"] = row_issue_ids
        data[ticker] = row
        valid_count += not bool(set(withheld) & {"lrr", "hrr", "trend"})
    quality = {"status": "discrepancy" if issues else "clear", "issues": issues}
    if issues:
        previous_quality = snapshot.get("sourceQuality") or {}
        prior_ids = {issue.get("id") for issue in previous_quality.get("issues", [])}
        quality["revision"] = (
            previous_quality.get("revision")
            if previous_quality.get("revision") and prior_ids == {issue["id"] for issue in issues}
            else hashlib.sha256(
                json.dumps(sorted(issues, key=lambda issue: issue["id"]), sort_keys=True, default=str).encode("utf-8")
            ).hexdigest()[:24]
        )
    result = {**snapshot, "data": data, "riskRangeCount": valid_count, "sourceQuality": quality}
    if excluded:
        result["rangeValidation"] = {"status": "partial" if valid_count else "unavailable", "excludedRows": excluded}
        result["warnings"] = list(dict.fromkeys([
            *snapshot.get("warnings", []), "SOURCE_DATA_DISCREPANCY",
            "EARLY_LOOK_INVALID_RISK_RANGE_ROWS" if product_id == "early-look" else "INVALID_RISK_RANGE_ROWS",
        ]))
    return result


def validate_early_look_ranges(snapshot: Dict[str, Any]) -> Dict[str, Any]:
    """Compatibility entry point; all range publications use the same checks."""
    return validate_research_ranges(snapshot)


def _extract_risk_range_table(html_body: str) -> Dict[str, Dict[str, Any]]:
    data: Dict[str, Dict[str, Any]] = {}
    row_pattern = re.compile(
        r"<strong>([^<]+?)\s+\((BULLISH|BEARISH|NEUTRAL)\)</strong><br\s*/?><em[^>]*>([^<]*)</em>.*?"
        r'<td[^>]*>([\d,]+(?:\.\d+)?)</td>\s*<td[^>]*>([\d,]+(?:\.\d+)?)</td>\s*<td[^>]*>([\d,]+(?:\.\d+)?)</td>',
        re.IGNORECASE | re.DOTALL,
    )

    for match in row_pattern.finditer(html_body):
        ticker = _normalize_ticker(match.group(1))
        trend = match.group(2).upper()
        name = _strip_tags(match.group(3)) or match.group(1)
        lrr = float(match.group(4).replace(",", ""))
        hrr = float(match.group(5).replace(",", ""))
        prev_close = float(match.group(6).replace(",", ""))
        _add_risk_range_row(data, ticker, {
            "lrr": lrr,
            "hrr": hrr,
            "trend": trend,
            "prevClose": prev_close,
            "originalName": name,
        })

    return data


def _extract_trend_changes_from_html(text: str) -> List[Dict[str, str]]:
    changes = []
    pattern = re.compile(
        r"([A-Z0-9/]+)\s+changed from\s+(Bullish|Bearish|Neutral)\s+to\s+(Bullish|Bearish|Neutral)(?:\s+and was\s+in the #OutBucket)?",
        re.IGNORECASE,
    )
    for match in pattern.finditer(text):
        note = "outbucket" if "#OutBucket" in match.group(0) else None
        changes.append(
            {
                "ticker": _normalize_ticker(match.group(1)),
                "oldTrend": match.group(2).upper(),
                "newTrend": match.group(3).upper(),
                "note": note,
            }
        )
    return changes


def _inflation_month_id(value: str) -> Optional[str]:
    match = re.search(
        r"\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|"
        r"Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|"
        r"Dec(?:ember)?)[-\s/]*(\d{2}|20\d{2})\b",
        str(value or ""),
        re.IGNORECASE,
    )
    if not match:
        return None
    month_token = match.group(1)[:3].lower()
    month_index = next(
        (
            index
            for index, name in enumerate(INFLATION_NOWCAST_MONTH_NAMES)
            if name[:3].lower() == month_token
        ),
        None,
    )
    if month_index is None:
        return None
    year = int(match.group(2))
    if year < 100:
        year += 2000
    return f"{year:04d}-{month_index + 1:02d}"


def _inflation_month_label(month_id: str) -> str:
    year_text, month_text = month_id.split("-", 1)
    return f"{INFLATION_NOWCAST_MONTH_NAMES[int(month_text) - 1]} {year_text}"


def _inflation_release_at(text: str, report_month: str) -> Optional[str]:
    report_year, report_month_number = map(int, report_month.split("-"))
    month_pattern = "|".join(INFLATION_NOWCAST_MONTH_NAMES)
    release_pattern = re.compile(
        rf"\b({month_pattern})\s+CPI\s+Release\s+Date\s*:\s*"
        rf"({month_pattern})\s+(\d{{1,2}})(?:st|nd|rd|th)?"
        rf"(?:,?\s+(20\d{{2}}))?\b",
        re.IGNORECASE,
    )
    for match in release_pattern.finditer(text):
        report_name, release_name, day_text, explicit_year = match.groups()
        report_index = next(
            (
                index
                for index, name in enumerate(INFLATION_NOWCAST_MONTH_NAMES)
                if name.lower() == report_name.lower()
            ),
            None,
        )
        if report_index is None or report_index + 1 != report_month_number:
            continue
        release_index = next(
            (
                index
                for index, name in enumerate(INFLATION_NOWCAST_MONTH_NAMES)
                if name.lower() == release_name.lower()
            ),
            None,
        )
        if release_index is None:
            continue
        release_month_number = release_index + 1
        release_year = int(explicit_year) if explicit_year else report_year
        if not explicit_year and release_month_number <= report_month_number:
            release_year += 1
        try:
            eastern_release = datetime(
                release_year,
                release_month_number,
                int(day_text),
                8,
                30,
                tzinfo=ZoneInfo("America/New_York"),
            )
        except ValueError:
            return None
        return eastern_release.astimezone(timezone.utc).isoformat().replace(
            "+00:00",
            "Z",
        )
    return None


def _inflation_ocr_lines(response: Dict[str, Any]) -> List[Dict[str, Any]]:
    lines: List[Dict[str, Any]] = []
    for block in response.get("Blocks") or []:
        if block.get("BlockType") != "LINE" or not str(block.get("Text") or "").strip():
            continue
        box = (block.get("Geometry") or {}).get("BoundingBox") or {}
        lines.append(
            {
                "text": str(block.get("Text") or "").strip(),
                "left": float(box.get("Left") or 0),
                "top": float(box.get("Top") or 0),
            }
        )
    return sorted(lines, key=lambda line: (line["top"], line["left"]))


def _inflation_report_month(lines: List[Dict[str, Any]]) -> Optional[str]:
    month_ids = [
        month_id
        for line in lines
        for month_id in [_inflation_month_id(line.get("text") or "")]
        if month_id
    ]
    return max(month_ids) if month_ids else None


def _inflation_scenarios(lines: List[Dict[str, Any]]) -> Optional[Dict[str, Decimal]]:
    candidates: List[Dict[str, Any]] = []
    for line in lines:
        for raw_value in re.findall(
            r"(?<![\d.])([-+]?\d+(?:\.\d{1,3})?)\s*%",
            line.get("text") or "",
        ):
            value = Decimal(raw_value)
            if value.is_finite() and Decimal("-5") <= value <= Decimal("15"):
                candidates.append({**line, "value": value})
    if len(candidates) < 3:
        return None
    # The forecast branches are the three right-most percentage labels in the
    # chart. Historical point labels and y-axis ticks sit materially left of
    # them. Geometry is required so OCR text alone can never invent a mapping.
    rightmost = sorted(candidates, key=lambda item: item["left"], reverse=True)[:3]
    if min(item["left"] for item in rightmost) < 0.55:
        return None
    ordered = sorted(rightmost, key=lambda item: item["top"])
    upper, base, lower = (item["value"] for item in ordered)
    if not lower < base < upper:
        return None
    return {"upper": upper, "base": base, "lower": lower}


def _inflation_source(sender: Optional[str], message_id: str) -> Dict[str, Any]:
    normalized_sender = str(sender or "").lower()
    is_macro_pro = "sectorpro@hedgeye.com" in normalized_sender
    return {
        "kind": "gmail",
        "messageId": message_id,
        "product": "macro-pro" if is_macro_pro else "hedgeye-general",
        "priority": 20 if is_macro_pro else 10,
    }


def _extract_inflation_forecast(
    *,
    chart: Dict[str, str],
    email_text: str,
    published_at: str,
    message_id: str,
    sender: Optional[str],
    textract_client: Any,
    image_fetcher: Optional[Callable[[str], bytes]],
) -> Optional[Dict[str, Any]]:
    payload = (image_fetcher or _fetch_market_situation_image)(chart["url"])
    if hasattr(textract_client, "detect_document_text"):
        response = textract_client.detect_document_text(Document={"Bytes": payload})
    else:
        response = textract_client.analyze_document(
            Document={"Bytes": payload},
            FeatureTypes=["TABLES"],
        )
    lines = _inflation_ocr_lines(response)
    report_month = _inflation_report_month(lines)
    scenarios = _inflation_scenarios(lines)
    if not report_month or not scenarios:
        return None
    release_at = _inflation_release_at(email_text, report_month)
    if not release_at:
        return None
    source = {
        **_inflation_source(sender, message_id),
        "chartUrl": chart["url"],
        "chartSha256": hashlib.sha256(payload).hexdigest(),
    }
    return {
        "reportMonth": report_month,
        "forecastMonth": _inflation_month_label(report_month),
        "metric": INFLATION_NOWCAST_METRIC,
        "releaseAt": release_at,
        "releaseDate": release_at[:10],
        "publishedAt": published_at,
        "scenarios": scenarios,
        "source": source,
        "selectionBasis": "publication_candidate",
        "parserVersion": INFLATION_NOWCAST_PARSER_VERSION,
    }


def _select_operational_inflation_forecast(
    forecasts: List[Dict[str, Any]],
    published_at: str,
) -> Optional[Dict[str, Any]]:
    try:
        publication_time = datetime.fromisoformat(published_at.replace("Z", "+00:00"))
    except (AttributeError, ValueError):
        return None
    eligible: List[Tuple[datetime, Dict[str, Any]]] = []
    for forecast in forecasts:
        try:
            release_time = datetime.fromisoformat(
                str(forecast.get("releaseAt") or "").replace("Z", "+00:00")
            )
        except ValueError:
            continue
        if publication_time < release_time:
            eligible.append((release_time, forecast))
    if not eligible:
        return None
    return min(eligible, key=lambda pair: pair[0])[1]


def _inflation_legacy_scenarios(forecast: Dict[str, Any]) -> List[Dict[str, Any]]:
    scenarios = forecast["scenarios"]
    return [
        {"key": "upside", "label": "Upside", "value": scenarios["upper"]},
        {"key": "base", "label": "Base Case", "value": scenarios["base"]},
        {"key": "downside", "label": "Downside", "value": scenarios["lower"]},
    ]


def _base_snapshot(
    *,
    snapshot_type: str,
    report_type: str,
    html_body: str,
    text: str,
    received_at: datetime,
    s3_key: str,
    message_id: str,
) -> Dict[str, Any]:
    snapshot_date, published_at = _extract_message_date(text, received_at)
    return {
        "date": snapshot_date,
        "snapshotType": snapshot_type,
        "scrapedAt": received_at.astimezone(timezone.utc).isoformat(),
        "publishedAt": published_at,
        "source": "gmail-html",
        "htmlSource": s3_key,
        "gmailMessageId": message_id,
        "article": {
            "headline": _extract_headline(html_body, text),
            "teaser": _extract_meta(html_body, "hedgeye-teaser"),
            "feedUrl": _extract_feed_url(text),
            "imageUrls": _extract_image_urls(html_body),
            "bodyText": text[:40_000],
        },
        "reportType": report_type,
    }


def parse_html_snapshot(
    *,
    report_type: str,
    html_body: str,
    received_at: datetime,
    s3_key: str,
    message_id: str,
    subject: Optional[str] = None,
    sender: Optional[str] = None,
    image_fetcher: Optional[Callable[[str], bytes]] = None,
    chart_archiver: Optional[Callable[..., Dict[str, Any]]] = None,
    textract_client: Any = None,
) -> Optional[Dict[str, Any]]:
    text = _strip_tags(html_body)

    if report_type == "hedgai-signals":
        parsed = parse_hedgai_publication(
            html_body=html_body, text=text, subject=subject or _extract_headline(html_body, text) or "",
            received_at=received_at, message_id=message_id, s3_key=s3_key,
        )
        if parsed is None:
            return None
        snapshot = _base_snapshot(
            snapshot_type=report_type, report_type=report_type, html_body=html_body,
            text=text, received_at=received_at, s3_key=s3_key, message_id=message_id,
        )
        snapshot.update(parsed)
        snapshot["article"]["headline"] = subject or snapshot["article"].get("headline")
        snapshot["article"]["feedUrl"] = parsed["sourceUrl"]
        return snapshot

    if report_type == "inflation-nowcast":
        charts = _sanitized_chart_items(html_body)
        if not charts or textract_client is None:
            return None
        snapshot = _base_snapshot(
            snapshot_type="inflation-nowcast",
            report_type=report_type,
            html_body=html_body,
            text=text,
            received_at=received_at,
            s3_key=s3_key,
            message_id=message_id,
        )
        # Gmail's immutable internal timestamp is the cutoff authority. The
        # newsletter body timestamp is minute-granular and older generic
        # parsing intentionally discarded its time component, which could
        # misclassify a post-8:30 release email as pre-release.
        snapshot["date"] = received_at.astimezone(
            ZoneInfo("America/New_York")
        ).strftime("%Y-%m-%d")
        snapshot["publishedAt"] = received_at.astimezone(timezone.utc).isoformat()
        forecasts: List[Dict[str, Any]] = []
        warnings: List[str] = []
        for chart in charts:
            try:
                forecast = _extract_inflation_forecast(
                    chart=chart,
                    email_text=text,
                    published_at=snapshot["publishedAt"],
                    message_id=message_id,
                    sender=sender,
                    textract_client=textract_client,
                    image_fetcher=image_fetcher,
                )
            except Exception as error:
                warnings.append(f"{chart['name']}: {error}")
                continue
            if forecast:
                forecasts.append(forecast)
        deduped_forecasts: Dict[Tuple[Any, ...], Dict[str, Any]] = {}
        for forecast in forecasts:
            scenarios = forecast["scenarios"]
            identity = (
                forecast["reportMonth"],
                forecast["releaseAt"],
                scenarios["upper"],
                scenarios["base"],
                scenarios["lower"],
            )
            deduped_forecasts[identity] = forecast
        forecasts = sorted(
            deduped_forecasts.values(),
            key=lambda forecast: forecast["reportMonth"],
        )
        operational = _select_operational_inflation_forecast(
            forecasts,
            snapshot["publishedAt"],
        )
        if not forecasts or not operational:
            return None
        source = _inflation_source(sender, message_id)
        snapshot["sourceProduct"] = source["product"]
        snapshot["sourcePriority"] = source["priority"]
        snapshot["itemCount"] = 3
        snapshot["forecastCount"] = len(forecasts)
        snapshot["chartCount"] = len(forecasts)
        snapshot["parserVersion"] = INFLATION_NOWCAST_PARSER_VERSION
        snapshot["data"] = {
            "metric": INFLATION_NOWCAST_METRIC,
            "forecastMonth": operational["forecastMonth"],
            "reportMonth": operational["reportMonth"],
            "releaseDate": operational["releaseDate"],
            "releaseAt": operational["releaseAt"],
            "scenarios": _inflation_legacy_scenarios(operational),
            "forecasts": forecasts,
        }
        snapshot["article"]["headline"] = (
            snapshot["article"].get("headline") or subject
        )
        snapshot["article"]["imageUrls"] = [
            forecast["source"]["chartUrl"] for forecast in forecasts
        ]
        snapshot["article"]["charts"] = [
            {
                "name": _chart_name_from_url(forecast["source"]["chartUrl"]),
                "url": forecast["source"]["chartUrl"],
                "reportMonth": forecast["reportMonth"],
                "sha256": forecast["source"]["chartSha256"],
            }
            for forecast in forecasts
        ]
        snapshot["article"].pop("bodyText", None)
        snapshot["article"].pop("teaser", None)
        if warnings:
            snapshot["warnings"] = warnings[:10]
        return snapshot

    if report_type == "market-structure":
        source_charts = []
        for item in _extract_chart_items(html_body):
            sanitized_url = _sanitize_research_image_url(item["url"])
            if sanitized_url:
                source_charts.append({**item, "url": sanitized_url})
        if not source_charts:
            return None
        if len(source_charts) > MARKET_SITUATION_CHART_MAX_COUNT:
            raise ValueError(
                "Market Situation report exceeds the approved chart-count limit"
            )
        if chart_archiver is None:
            raise ValueError(
                "Market Situation reports require a private chart archiver"
            )

        ordered_source_blocks, _disclaimer = _extract_market_situation_content(
            html_body,
            source_charts,
        )
        source_urls_in_order = [
            block["sourceUrl"]
            for block in ordered_source_blocks
            if block.get("type") == "chart-source"
        ]
        if source_urls_in_order != [chart["url"] for chart in source_charts]:
            raise ValueError(
                "Market Situation chart ordering could not be verified from the source HTML"
            )

        archived_charts: List[Dict[str, Any]] = []
        archived_by_source: Dict[str, Dict[str, Any]] = {}
        signal_image: Optional[bytes] = None
        chart_metrics: Dict[str, Dict[str, Any]] = {}
        chart_ocr_errors: List[str] = []
        for index, chart in enumerate(source_charts):
            payload = (image_fetcher or _fetch_market_situation_image)(chart["url"])
            if len(payload) > MARKET_SITUATION_IMAGE_MAX_BYTES:
                raise ValueError("Market Situation image exceeds the ingestion size limit")
            content_type, extension = _market_situation_image_type(payload)
            content_sha256 = hashlib.sha256(payload).hexdigest()
            archived = chart_archiver(
                chart=chart,
                payload=payload,
                content_type=content_type,
                extension=extension,
                content_sha256=content_sha256,
            )
            chart_s3_key = str((archived or {}).get("s3Key") or "").strip()
            if not chart_s3_key:
                raise ValueError("Market Situation chart archive did not return an S3 key")
            chart_id = str((archived or {}).get("id") or content_sha256).strip()
            archived_chart = {
                "id": chart_id,
                "name": chart["name"],
                "sha256": content_sha256,
                "contentType": content_type,
                "s3Key": chart_s3_key,
            }
            archived_charts.append(archived_chart)
            archived_by_source[chart["url"]] = archived_chart
            if index == 0:
                signal_image = payload
            if textract_client is not None and content_type in {"image/png", "image/jpeg"}:
                try:
                    ocr_response = _market_situation_chart_ocr_response(
                        textract_client,
                        payload,
                    )
                    extractors = (
                        _extract_spx_gamma_volatility_throttle_metric,
                        _extract_spx_probable_volatility_gamma_metric,
                    )
                    for extractor in extractors:
                        metric = extractor(ocr_response, chart_id=chart_id)
                        if metric and metric["id"] not in chart_metrics:
                            chart_metrics[metric["id"]] = metric
                except Exception as error:
                    chart_ocr_errors.append(f"{chart['name']}: {error}")

        signals: List[Dict[str, str]] = []
        warnings: List[str] = []
        try:
            signals = _extract_market_situation_signals(signal_image or b"")
        except Exception as error:
            warnings.append(f"Signal summary unavailable: {error}")
        if textract_client is not None:
            missing_chart_metrics = [
                label
                for metric_id, label in (
                    ("spxGammaVolatilityThrottle", "SPX Gamma Volatility Throttle"),
                    ("spxProbableVolatilityGamma", "SPX probable-volatility gamma map"),
                )
                if metric_id not in chart_metrics
            ]
            if missing_chart_metrics:
                warnings.append(
                    "Market Situation labeled chart metrics unavailable: "
                    + ", ".join(missing_chart_metrics)
                )
        warnings.extend(
            f"Market Situation chart OCR unavailable: {detail}"
            for detail in chart_ocr_errors[:3]
        )

        ordered_blocks: List[Dict[str, Any]] = []
        body_text_parts: List[str] = []
        report_heading: Optional[str] = None
        for index, source_block in enumerate(ordered_source_blocks, start=1):
            block_type = source_block.get("type")
            if block_type == "chart-source":
                chart = archived_by_source[source_block["sourceUrl"]]
                ordered_blocks.append(
                    {
                        "id": f"block-{index}",
                        "type": "chart",
                        "chartId": chart["id"],
                        **(
                            {"caption": source_block["caption"]}
                            if source_block.get("caption")
                            else {}
                        ),
                    }
                )
                continue
            block_text = str(source_block.get("text") or "").strip()
            if not block_text or block_type == "byline":
                continue
            ordered_blocks.append(
                {
                    "id": f"block-{index}",
                    "type": block_type,
                    "text": block_text,
                }
            )
            body_text_parts.append(block_text)
            if (
                block_type == "heading"
                and not report_heading
                and "market situation report" not in block_text.casefold()
            ):
                report_heading = block_text

        body_text = "\n\n".join(body_text_parts).strip()
        if not body_text:
            raise ValueError("Market Situation report contains no substantive narrative text")
        snapshot = _base_snapshot(
            snapshot_type="market-structure",
            report_type=report_type,
            html_body=html_body,
            text=text,
            received_at=received_at,
            s3_key=s3_key,
            message_id=message_id,
        )
        snapshot["article"]["reportHeading"] = report_heading
        snapshot["article"]["bodyText"] = body_text[:40_000]
        snapshot["article"]["charts"] = archived_charts
        snapshot["article"].pop("headline", None)
        snapshot["article"].pop("summary", None)
        snapshot["article"].pop("byline", None)
        snapshot["article"].pop("disclaimer", None)
        snapshot["article"].pop("publisher", None)
        snapshot["article"].pop("imageUrls", None)
        snapshot["article"].pop("teaser", None)
        snapshot["signalCount"] = len(signals)
        snapshot["chartCount"] = len(archived_charts)
        snapshot["schemaVersion"] = MARKET_SITUATION_SCHEMA_VERSION
        snapshot["contentComplete"] = True
        snapshot["data"] = {
            "signals": signals,
            "chartMetrics": chart_metrics,
            "signalMatrixChartId": archived_charts[0]["id"],
            "blocks": ordered_blocks,
            "charts": archived_charts,
        }
        if warnings:
            snapshot["warnings"] = warnings
        return snapshot

    if report_type == "investing-ideas":
        positions = _extract_investing_ideas_table(html_body)
        long_summary = _extract_section_text(text, "Long", ["Short", "LEVELS"])
        short_summary = _extract_section_text(text, "Short", ["LEVELS"])
        headline_longs = _extract_symbols(
            re.split(r"\n\s*\n", long_summary, maxsplit=1)[0]
        )
        headline_shorts = _extract_symbols(
            re.split(r"\n\s*\n", short_summary, maxsplit=1)[0]
        )
        if not positions and not headline_longs and not headline_shorts:
            return None
        if not positions:
            # Headline-only Long/Short lists do not contain the required
            # previous close and LRR/HRR evidence. Do not index them as a
            # partial Investing Ideas position book.
            raise ValueError(
                "Investing Ideas publication is missing a complete ticker/side/previous-close/LRR/HRR table"
            )

        table_longs = [
            row["ticker"] for row in positions if row["side"] == "Long"
        ]
        table_shorts = [
            row["ticker"] for row in positions if row["side"] == "Short"
        ]
        missing_longs = sorted(set(headline_longs) - set(table_longs))
        if missing_longs:
            raise ValueError(
                "Investing Ideas long summary does not match the position table: "
                + ", ".join(missing_longs)
            )
        missing_shorts = sorted(set(headline_shorts) - set(table_shorts))
        if missing_shorts:
            raise ValueError(
                "Investing Ideas short summary does not match the position table: "
                + ", ".join(missing_shorts)
            )

        snapshot = _base_snapshot(
            snapshot_type="investing-ideas",
            report_type=report_type,
            html_body=html_body,
            text=text,
            received_at=received_at,
            s3_key=s3_key,
            message_id=message_id,
        )
        snapshot["positionCount"] = len(positions)
        snapshot["longCount"] = len(table_longs)
        snapshot["shortCount"] = len(table_shorts)
        snapshot["data"] = {
            "longs": table_longs,
            "shorts": table_shorts,
            "positions": positions,
        }
        return snapshot

    if report_type == "early-look":
        levels = _extract_levels_from_text(text)
        snapshot = _base_snapshot(
            snapshot_type="early-look",
            report_type=report_type,
            html_body=html_body,
            text=text,
            received_at=received_at,
            s3_key=s3_key,
            message_id=message_id,
        )
        snapshot["riskRangeCount"] = len(levels)
        snapshot["data"] = levels
        snapshot["article"]["keyTakeaways"] = _extract_key_takeaways(text)
        snapshot["article"]["sections"] = _extract_article_sections(text)
        return validate_early_look_ranges(snapshot)

    if report_type == "risk-ranges":
        levels = _extract_risk_range_table(html_body)
        if not levels:
            return None
        snapshot = _base_snapshot(
            snapshot_type="risk-ranges",
            report_type=report_type,
            html_body=html_body,
            text=text,
            received_at=received_at,
            s3_key=s3_key,
            message_id=message_id,
        )
        snapshot["riskRangeCount"] = len(levels)
        snapshot["data"] = levels
        snapshot["trendChanges"] = _extract_trend_changes_from_html(text)
        return validate_research_ranges(snapshot)

    if report_type == "top-3-things":
        items, intro = _extract_top_three_items(html_body, text)
        if len(items) != 3:
            return None
        snapshot = _base_snapshot(
            snapshot_type="top-3-things",
            report_type=report_type,
            html_body=html_body,
            text=text,
            received_at=received_at,
            s3_key=s3_key,
            message_id=message_id,
        )
        snapshot["itemCount"] = len(items)
        snapshot["data"] = {"items": items}
        if intro:
            snapshot["data"]["intro"] = intro
            snapshot["article"]["summary"] = intro
        return snapshot

    if report_type == "top-3-things":
        items, intro = _extract_top_three_items(html_body, text)
        if len(items) != 3:
            return None
        snapshot = _base_snapshot(
            snapshot_type="top-3-things",
            report_type=report_type,
            html_body=html_body,
            text=text,
            received_at=received_at,
            s3_key=s3_key,
            message_id=message_id,
        )
        snapshot["itemCount"] = len(items)
        snapshot["data"] = {"items": items}
        if intro:
            snapshot["data"]["intro"] = intro
            snapshot["article"]["summary"] = intro
        return snapshot

    if report_type == "the-call":
        longs_raw = _extract_section_text(text, "LONGS", ["SHORTS", "NEUTRAL", "TOP", "POSITIONING", "MAIN SUMMARY"])
        shorts_raw = _extract_section_text(text, "SHORTS", ["NEUTRAL", "TOP", "POSITIONING", "MAIN SUMMARY"])
        neutral_raw = _extract_section_text(text, "NEUTRAL", ["TOP", "POSITIONING", "MAIN SUMMARY"])
        longs = _extract_symbols(longs_raw)
        shorts = _extract_symbols(shorts_raw)
        neutrals = _extract_symbols(neutral_raw)
        snapshot = _base_snapshot(
            snapshot_type="the-call",
            report_type=report_type,
            html_body=html_body,
            text=text,
            received_at=received_at,
            s3_key=s3_key,
            message_id=message_id,
        )
        structured_positions_available = bool(longs or shorts or neutrals)
        if not structured_positions_available:
            snapshot["positionDataStatus"] = "unavailable"
            snapshot["data"] = {
                "longs": None,
                "shorts": None,
                "neutrals": None,
            }
            snapshot["article"]["summary"] = _extract_main_summary(text)
            if not _has_positive_article_evidence(snapshot):
                return None
            return snapshot
        snapshot["positionCount"] = len(longs) + len(shorts) + len(neutrals)
        snapshot["data"] = {
            "longs": longs,
            "shorts": shorts,
            "neutrals": neutrals,
        }
        snapshot["article"]["summary"] = _extract_main_summary(text)
        return snapshot

    if report_type == "the-macro-show":
        bullish_raw = _extract_section_text(text, "BULLISH", ["BEARISH", "MAIN SUMMARY", "Summary has been enhanced"])
        bearish_raw = _extract_section_text(text, "BEARISH", ["MAIN SUMMARY", "Summary has been enhanced"])
        neutral_raw = _extract_section_text(text, "NEUTRAL", ["MAIN SUMMARY", "Summary has been enhanced"])
        longs = _clean_macro_show_items(_split_exact_items(bullish_raw))
        shorts = _clean_macro_show_items(_split_exact_items(bearish_raw))
        neutrals = _clean_macro_show_items(_split_exact_items(neutral_raw))
        snapshot = _base_snapshot(
            snapshot_type="the-macro-show",
            report_type=report_type,
            html_body=html_body,
            text=text,
            received_at=received_at,
            s3_key=s3_key,
            message_id=message_id,
        )
        structured_positions_available = bool(longs or shorts or neutrals)
        if not structured_positions_available:
            snapshot["positionDataStatus"] = "unavailable"
            snapshot["data"] = {
                "longs": None,
                "shorts": None,
                "neutrals": None,
            }
            snapshot["article"]["summary"] = _extract_main_summary(text)
            if not _has_positive_article_evidence(snapshot):
                return None
            return snapshot
        snapshot["positionCount"] = len(longs) + len(shorts) + len(neutrals)
        snapshot["data"] = {
            "longs": longs,
            "shorts": shorts,
            "neutrals": neutrals,
            "rawLongsText": bullish_raw,
            "rawShortsText": bearish_raw,
            "rawNeutralText": neutral_raw,
        }
        snapshot["article"]["summary"] = _extract_main_summary(text)
        return snapshot

    if report_type == "signal-strength":
        # Since 2026-10-15 Hedgeye sends the long list ("Signal Strength
        # Stocks: N Stocks") and a separate short list ("Signal Strength
        # Shorts: N Stocks"). The short book is kept under data.shorts so no
        # consumer of the long list can read a short as a long.
        book_match = re.search(r"Signal Strength (Stocks|Shorts):\s*(\d+)\s+Stocks", text, re.IGNORECASE)
        side = "short" if book_match and book_match.group(1).lower() == "shorts" else "long"
        added = _signal_strength_change_symbols(text, ("Added", "ADDING"))
        removed = _signal_strength_change_symbols(text, ("Removed", "REMOVING"))
        stock_count = int(book_match.group(2)) if book_match else len(added)
        if not added and not removed and not stock_count:
            return None
        table_rows = _signal_strength_html_rows(html_body, side=side)
        snapshot = _base_snapshot(
            snapshot_type="signal-strength",
            report_type=report_type,
            html_body=html_body,
            text=text,
            received_at=received_at,
            s3_key=s3_key,
            message_id=message_id,
        )
        source_rows: List[Dict[str, Any]] = table_rows
        if not source_rows and textract_client is not None:
            try:
                source_rows = _signal_strength_source_rows(
                    html_body=html_body,
                    textract_client=textract_client,
                    image_fetcher=image_fetcher,
                )
            except Exception as error:
                # The explicit additions/removals remain useful if the chart
                # OCR service is temporarily unavailable. Never turn a failed
                # extraction into an inferred full membership list.
                print(f"Signal Strength chart extraction unavailable: {error}")
        membership_complete = bool(stock_count and len(source_rows) == stock_count)
        book = {
            "added": added,
            "removed": removed,
            "stocks": source_rows or [{"ticker": ticker} for ticker in added],
            "membershipComplete": membership_complete,
        }
        if side == "short":
            snapshot["shortCount"] = stock_count
            snapshot["data"] = {
                "shorts": {
                    **book,
                    "stockCount": stock_count,
                    "publishedAt": snapshot["publishedAt"],
                    "receivedAt": snapshot["scrapedAt"],
                    "gmailMessageId": message_id,
                },
            }
        else:
            snapshot["stockCount"] = stock_count
            snapshot["data"] = book
        return snapshot

    if report_type == "portfolio-solutions":
        rankings = _extract_portfolio_rankings(html_body)
        top_groups = _extract_movers(text, "Top Movers")
        bottom_groups = _extract_movers(text, "Bottom Movers")
        if not rankings and not top_groups and not bottom_groups:
            return None
        snapshot = _base_snapshot(
            snapshot_type="portfolio-solutions",
            report_type=report_type,
            html_body=html_body,
            text=text,
            received_at=received_at,
            s3_key=s3_key,
            message_id=message_id,
        )
        snapshot["rankingCount"] = len(rankings)
        snapshot["data"] = {
            "rankings": rankings,
            "topMovers": {
                "weekly": top_groups[0] if len(top_groups) > 0 else [],
                "monthly": top_groups[1] if len(top_groups) > 1 else [],
            },
            "bottomMovers": {
                "weekly": bottom_groups[0] if len(bottom_groups) > 0 else [],
                "monthly": bottom_groups[1] if len(bottom_groups) > 1 else [],
            },
        }
        return snapshot

    if report_type == "momo-tracker":
        raw_charts = _extract_chart_items(html_body)
        charts = _sanitized_chart_items(html_body)
        if not raw_charts or not charts:
            return None
        snapshot = _base_snapshot(
            snapshot_type="momo-tracker",
            report_type=report_type,
            html_body=html_body,
            text=text,
            received_at=received_at,
            s3_key=s3_key,
            message_id=message_id,
        )
        tracker_rows: Dict[str, Dict[str, Any]] = {}
        if textract_client is not None:
            table_chart = _select_tracker_chart(
                raw_charts,
                preferred_name="6.png",
                fallback_index=5,
            )
            tracker_rows = _extract_tracker_chart_table(
                chart=table_chart,
                textract_client=textract_client,
                image_fetcher=image_fetcher,
                required_fields=(
                    "ticker",
                    "buyTrade",
                    "sellTrade",
                    "upside",
                    "downside",
                    "trend",
                ),
                allow_outbucket_rows=True,
            )
        snapshot["chartCount"] = len(charts)
        snapshot["stockCount"] = len(tracker_rows)
        snapshot["rangeAvailableCount"] = sum(
            row.get("rangeStatus") == "available"
            for row in tracker_rows.values()
        )
        snapshot["outbucketCount"] = sum(
            row.get("rangeStatus") == "outbucket"
            for row in tracker_rows.values()
        )
        snapshot["data"] = tracker_rows or {
            item["name"]: {"chartUrl": item["url"]} for item in charts
        }
        snapshot["article"]["imageUrls"] = [item["url"] for item in charts]
        snapshot["article"]["charts"] = charts
        return snapshot

    if report_type in {"crypto-quant", "bitcoin-trend-tracker"}:
        raw_charts = _extract_chart_items(html_body)
        charts = _sanitized_chart_items(html_body)
        headline = _extract_headline(html_body, text)
        headline_cryptos = _extract_crypto_title_data(headline)
        if not raw_charts and not headline_cryptos:
            return None
        snapshot = _base_snapshot(
            snapshot_type="bitcoin-trend-tracker",
            report_type=report_type,
            html_body=html_body,
            text=text,
            received_at=received_at,
            s3_key=s3_key,
            message_id=message_id,
        )
        cryptos: Dict[str, Dict[str, Any]] = headline_cryptos
        stocks: Dict[str, Dict[str, Any]] = {}
        if textract_client is not None:
            crypto_chart = _select_tracker_chart(
                raw_charts,
                preferred_name="BTC_2.png",
                fallback_index=2,
            )
            equity_chart = _select_tracker_chart(
                raw_charts,
                preferred_name="BTC_9.png",
                fallback_index=9,
            )
            cryptos = _extract_tracker_chart_table(
                chart=crypto_chart,
                textract_client=textract_client,
                image_fetcher=image_fetcher,
                required_fields=(
                    "ticker",
                    "price",
                    "buyTrade",
                    "sellTrade",
                    "trend",
                ),
            )
            stocks = _extract_tracker_chart_table(
                chart=equity_chart,
                textract_client=textract_client,
                image_fetcher=image_fetcher,
                required_fields=(
                    "ticker",
                    "price",
                    "buyTrade",
                    "sellTrade",
                    "upside",
                    "downside",
                    "trend",
                ),
            )
            for ticker, title_values in headline_cryptos.items():
                if ticker in cryptos:
                    cryptos[ticker].update(title_values)

        snapshot["cryptoCount"] = len(cryptos)
        snapshot["stockCount"] = len(stocks)
        snapshot["chartCount"] = len(charts)
        snapshot["data"] = {
            "cryptos": cryptos,
            "stocks": stocks,
            "charts": charts,
        }
        snapshot["article"]["imageUrls"] = [item["url"] for item in charts]
        snapshot["article"]["charts"] = charts
        return snapshot

    if report_type == "go-anywhere":
        book = _extract_go_anywhere_portfolio(text)
        if not book["rows"] and not book["changes"]:
            return None
        snapshot = _base_snapshot(
            snapshot_type="go-anywhere",
            report_type=report_type,
            html_body=html_body,
            text=text,
            received_at=received_at,
            s3_key=s3_key,
            message_id=message_id,
        )
        changes, rows = book["changes"], book["rows"]
        headline = f"{subject or '10 ETF Go-Anywhere Portfolio'}: {book['takeaway']}" if book["takeaway"] else subject
        snapshot["article"]["headline"] = snapshot["article"].get("headline") or headline
        snapshot["sourceKind"] = "full-book-checkpoint" if rows else "position-actions"
        snapshot["itemCount"] = len(rows) or len(changes)
        snapshot["positionCount"] = len(rows)
        snapshot["changeCount"] = len(changes)
        snapshot["longCount"] = len(rows)
        snapshot["shortCount"] = 0
        snapshot["data"] = {
            "headline": headline,
            "takeaway": book["takeaway"],
            "checkpointAvailable": bool(rows),
            "checkpointFormat": "open-positions-table" if rows else None,
            "rows": rows,
            "changes": changes,
            "fullBookLongs": [row["ticker"] for row in rows],
            "fullBookShorts": [],
            "added": [item["ticker"] for item in changes if item["action"] == "ADD"],
            "removed": [item["ticker"] for item in changes if item["action"] == "REMOVE"],
        }
        return snapshot

    if report_type == "etf-pro":
        full_book = _extract_etf_pro_full_book(text)
        if full_book:
            snapshot = _base_snapshot(
                snapshot_type="etf-pro",
                report_type=report_type,
                html_body=html_body,
                text=text,
                received_at=received_at,
                s3_key=s3_key,
                message_id=message_id,
            )
            rows = full_book["rows"]
            snapshot["article"]["headline"] = snapshot["article"].get("headline") or subject
            snapshot["sourceKind"] = "full-book-checkpoint"
            snapshot["itemCount"] = len(rows)
            snapshot["positionCount"] = len(rows)
            snapshot["changeCount"] = 0
            snapshot["longCount"] = len(full_book["longs"])
            snapshot["shortCount"] = len(full_book["shorts"])
            snapshot["data"] = {
                "headline": snapshot["article"].get("headline"),
                "checkpointAvailable": True,
                "checkpointFormat": full_book["format"],
                "rows": rows,
                "changes": [],
                "fullBookLongs": full_book["longs"],
                "fullBookShorts": full_book["shorts"],
            }
            return snapshot

        changes = _extract_etf_pro_changes(text)
        if not changes:
            return None
        snapshot = _base_snapshot(
            snapshot_type="etf-pro",
            report_type=report_type,
            html_body=html_body,
            text=text,
            received_at=received_at,
            s3_key=s3_key,
            message_id=message_id,
        )
        snapshot["article"]["headline"] = snapshot["article"].get("headline") or subject
        snapshot["sourceKind"] = "position-actions"
        added_longs = [item["ticker"] for item in changes if item["action"] == "ADD" and item["side"] == "Long"]
        removed_longs = [item["ticker"] for item in changes if item["action"] == "REMOVE" and item["side"] == "Long"]
        added_shorts = [item["ticker"] for item in changes if item["action"] == "ADD" and item["side"] == "Short"]
        removed_shorts = [item["ticker"] for item in changes if item["action"] == "REMOVE" and item["side"] == "Short"]
        rows = [
            {
                "id": f"{item['ticker']}_{idx}",
                "ticker": item["ticker"],
                "etf": item["etf"],
                "call": item["side"],
                "side": item["side"],
                "action": item["action"],
                "riskRangeLow": item.get("riskRangeLow"),
                "riskRangeHigh": item.get("riskRangeHigh"),
            }
            for idx, item in enumerate(changes)
        ]
        snapshot["itemCount"] = len(changes)
        snapshot["changeCount"] = len(changes)
        snapshot["data"] = {
            "headline": snapshot["article"].get("headline"),
            "checkpointAvailable": False,
            "changes": changes,
            "rows": rows,
            "added": list(dict.fromkeys([*added_longs, *added_shorts])),
            "removed": list(dict.fromkeys([*removed_longs, *removed_shorts])),
            "addedLongs": added_longs,
            "removedLongs": removed_longs,
            "addedShorts": added_shorts,
            "removedShorts": removed_shorts,
        }
        return snapshot

    if report_type == "real-time-alert":
        body_headline = _extract_headline(html_body, text)
        subject_headline = str(subject or "").strip() or None
        headline = (
            subject_headline
            if subject_headline
            and re.search(
                r"\breal[- ]time alert\b",
                subject_headline,
                re.IGNORECASE,
            )
            else body_headline or subject_headline
        )
        alert = _extract_real_time_alert(headline, text, html_body)
        if not alert and body_headline and body_headline != headline:
            headline = body_headline
            alert = _extract_real_time_alert(headline, text, html_body)
        if not alert:
            return None
        snapshot = _base_snapshot(
            snapshot_type=report_type,
            report_type=report_type,
            html_body=html_body,
            text=text,
            received_at=received_at,
            s3_key=s3_key,
            message_id=message_id,
        )
        snapshot["itemCount"] = 1
        snapshot["data"] = {
            "headline": headline,
            "alert": alert,
            "alerts": [alert],
        }
        return snapshot

    if report_type == "unknown":
        headline = _extract_headline(html_body, text) or subject
        alerts = _extract_position_change_alerts(headline, text)
        if alerts:
            snapshot = _base_snapshot(
                snapshot_type="investing-ideas",
                report_type="investing-ideas",
                html_body=html_body,
                text=text,
                received_at=received_at,
                s3_key=s3_key,
                message_id=message_id,
            )
            snapshot["itemCount"] = len(alerts)
            snapshot["data"] = {
                "headline": headline,
                "alert": alerts[-1],
                "alerts": alerts,
                "checkpointAvailable": False,
            }
            return snapshot

    return None


def _decimalize(value: Any) -> Any:
    if isinstance(value, float):
        return Decimal(str(value))
    if isinstance(value, list):
        return [_decimalize(item) for item in value]
    if isinstance(value, dict):
        return {key: _decimalize(item) for key, item in value.items()}
    return value


def _publication_order(value: Any) -> Optional[int]:
    try:
        parsed = datetime.fromisoformat(str(value or "").replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    elapsed = parsed.astimezone(timezone.utc) - datetime(
        1970,
        1,
        1,
        tzinfo=timezone.utc,
    )
    return (
        ((elapsed.days * 24 * 60 * 60) + elapsed.seconds) * 1_000_000
        + elapsed.microseconds
    )


def _article_only_snapshot(snapshot: Dict[str, Any]) -> bool:
    return (
        snapshot.get("snapshotType") in {"the-call", "the-macro-show"}
        and snapshot.get("positionDataStatus") == "unavailable"
    )


def _put_non_risk_snapshot(
    table: Any,
    item: Dict[str, Any],
    *,
    article_only: bool,
) -> None:
    if not article_only:
        table.put_item(Item=item)
        return
    try:
        table.put_item(
            Item=item,
            ConditionExpression=(
                "attribute_not_exists(#date) "
                "OR ("
                "#positionDataStatus = :unavailable "
                "AND attribute_not_exists(#positionCount)"
                ")"
            ),
            ExpressionAttributeNames={
                "#date": "date",
                "#positionDataStatus": "positionDataStatus",
                "#positionCount": "positionCount",
            },
            ExpressionAttributeValues={":unavailable": "unavailable"},
        )
    except ClientError as error:
        if (
            error.response.get("Error", {}).get("Code")
            == "ConditionalCheckFailedException"
        ):
            # The immutable artifact and entity index retain this article. A
            # structured same-day position snapshot remains authoritative.
            return
        raise


def _manifest_compare_and_swap(
    existing: Optional[Dict[str, Any]],
    *,
    incoming_order: int,
    incoming_source_message_id: Optional[str],
) -> Tuple[str, Dict[str, str], Dict[str, Any]]:
    names: Dict[str, str] = {}
    values: Dict[str, Any] = {}
    if not existing:
        names.update({
            "#publicationDate": "publicationDate",
            "#manifestType": "manifestType",
        })
        return (
            "attribute_not_exists(#publicationDate) "
            "AND attribute_not_exists(#manifestType)",
            names,
            values,
        )

    existing_source = str(existing.get("sourceMessageId") or "").strip() or None
    try:
        existing_order = (
            int(existing["publicationOrder"])
            if existing.get("publicationOrder") is not None
            else _publication_order(existing.get("completedAt"))
        )
    except (TypeError, ValueError, OverflowError):
        existing_order = None
    same_source = bool(
        incoming_source_message_id
        and incoming_source_message_id == existing_source
    )
    if existing_order is None:
        raise RiskRangePublicationOrderError(
            "Existing Risk Range publication order could not be verified"
        )
    if existing_order > incoming_order:
        raise RiskRangeStalePublicationError(
            "Older Risk Range publication cannot replace the current manifest"
        )
    if existing_order == incoming_order and not same_source:
        raise RiskRangePublicationOrderError(
            "Risk Range publications have an ambiguous equal timestamp"
        )

    clauses = []
    for index, field in enumerate(
        (
            "sourceMessageId",
            "completedAt",
            "checksum",
            "completionState",
            "publicationOrder",
        )
    ):
        name_token = f"#expectedField{index}"
        names[name_token] = field
        expected_value = existing.get(field)
        if expected_value is None:
            clauses.append(f"attribute_not_exists({name_token})")
        else:
            value_token = f":expectedValue{index}"
            values[value_token] = expected_value
            clauses.append(f"{name_token} = {value_token}")
    return " AND ".join(clauses), names, values


def _monotonic_put_condition(
    *,
    publication_order: int,
) -> Tuple[str, Dict[str, str], Dict[str, Any]]:
    names = {"#publicationOrder": "publicationOrder"}
    values: Dict[str, Any] = {":incomingPublicationOrder": publication_order}
    clauses = [
        "attribute_not_exists(#publicationOrder)",
        "#publicationOrder <= :incomingPublicationOrder",
    ]
    return f"({' OR '.join(clauses)})", names, values


def _is_exact_primary_manifest_replay(
    existing: Optional[Dict[str, Any]],
    incoming: Dict[str, Any],
) -> bool:
    """Treat the atomic completion manifest as the idempotency receipt."""
    if not existing:
        return False
    receipt_fields = (
        "publicationDate",
        "manifestType",
        "completionState",
        "count",
        "checksum",
        "parserVersion",
        "source",
        "sourceMessageId",
        "sourceArtifact",
        "publishedAt",
        "completedAt",
        "publicationOrder",
        "sourceQuality",
    )
    return all(existing.get(field) == incoming.get(field) for field in receipt_fields)


def _serialized_item(
    serializer: TypeSerializer,
    item: Dict[str, Any],
) -> Dict[str, Any]:
    return {
        key: serializer.serialize(value)
        for key, value in item.items()
        if value is not None
    }


def _serialized_transaction_write(
    serializer: TypeSerializer,
    operation: Dict[str, Any],
) -> Dict[str, Any]:
    put = operation["Put"]
    serialized_put = {
        **put,
        "Item": _serialized_item(serializer, put["Item"]),
    }
    if "ExpressionAttributeValues" in put:
        serialized_put["ExpressionAttributeValues"] = {
            key: serializer.serialize(value)
            for key, value in put["ExpressionAttributeValues"].items()
        }
    return {"Put": serialized_put}


def _projection_matches(
    actual: Optional[Dict[str, Any]],
    expected: Dict[str, Any],
    fields: Tuple[str, ...],
) -> bool:
    return bool(actual) and all(actual.get(field) == expected.get(field) for field in fields)


def _verify_risk_range_projections(
    db: Any,
    daily_item: Dict[str, Any],
    rows: List[Tuple[str, Dict[str, Any], Dict[str, Any]]],
) -> int:
    daily = db.Table(HEDGEYE_DAILY_SNAPSHOT_TABLE).get_item(
        Key={
            "date": daily_item["date"],
            "snapshotType": daily_item["snapshotType"],
        },
        ConsistentRead=True,
    ).get("Item")
    if not _projection_matches(
        daily,
        daily_item,
        (
            "date",
            "snapshotType",
            "publicationOrder",
            "sourceMessageId",
            "riskRangeCount",
            "data",
        ),
    ):
        raise RiskRangePublicationVerificationError(
            "Risk Range daily projection did not match its staged publication"
        )

    verified = 1
    current_table = db.Table(RISK_RANGE_DATA_TABLE)
    history_table = db.Table(RISK_RANGE_HISTORY_TABLE)
    row_fields = (
        "date",
        "ticker",
        "lrr",
        "hrr",
        "trend",
        "publicationOrder",
        "sourceMessageId",
    )
    for ticker, current_item, history_item in rows:
        current = current_table.get_item(
            Key={"date": current_item["date"], "ticker": ticker},
            ConsistentRead=True,
        ).get("Item")
        if not _projection_matches(current, current_item, row_fields):
            raise RiskRangePublicationVerificationError(
                f"Risk Range current projection verification failed for {ticker}"
            )
        history = history_table.get_item(
            Key={"ticker": ticker, "date": history_item["date"]},
            ConsistentRead=True,
        ).get("Item")
        if not _projection_matches(history, history_item, row_fields):
            raise RiskRangePublicationVerificationError(
                f"Risk Range history projection verification failed for {ticker}"
            )
        verified += 2
    return verified


def save_snapshot_to_dynamodb(snapshot: Dict[str, Any], db: Any) -> None:
    snapshot = validate_early_look_ranges(snapshot)
    if snapshot.get("snapshotType") == "cftc-positioning":
        # Hedgeye email content is retained for audit only. The official CFTC
        # Lambda is the sole writer of the canonical positioning key.
        snapshot = {
            **snapshot,
            "reportType": "cftc-positioning",
            "snapshotType": "cftc-positioning-hedgeye-audit",
            "source": "hedgeye-email-html-audit",
            "contentComplete": False,
            "decisionEligible": False,
            "warnings": [
                *list(snapshot.get("warnings") or []),
                "AUDIT_ONLY_NOT_FOR_TRADING_DECISIONS",
            ],
        }
    snap_table = db.Table(HEDGEYE_DAILY_SNAPSHOT_TABLE)
    item = _decimalize(snapshot)
    item["ttl"] = int(datetime.now(timezone.utc).timestamp() + (730 * 24 * 60 * 60))

    if snapshot["snapshotType"] not in {"early-look", "risk-ranges"}:
        _put_non_risk_snapshot(
            snap_table,
            item,
            article_only=_article_only_snapshot(snapshot),
        )
        return

    history_table = db.Table("RiskRangeData")
    ts = snapshot["scrapedAt"]
    normalized_rows = []
    rows_by_ticker: Dict[str, Dict[str, Any]] = {}
    for ticker_label, row in snapshot.get("data", {}).items():
        _add_risk_range_row(rows_by_ticker, ticker_label, row)
    if snapshot["snapshotType"] == "risk-ranges":
        item["data"] = _decimalize(rows_by_ticker)
        item["riskRangeCount"] = snapshot["riskRangeCount"]

    for ticker, row in rows_by_ticker.items():
        if set(row.get("withheldFields", [])) & {"lrr", "hrr", "trend"}:
            continue
        lrr = Decimal(str(row["lrr"]))
        hrr = Decimal(str(row["hrr"]))
        if not lrr.is_finite() or not hrr.is_finite() or lrr >= hrr:
            raise RiskRangePublicationError(
                f"Invalid risk range for {ticker}: lrr={lrr}, hrr={hrr}"
            )
        trend = str(row.get("trend") or "").strip().upper()
        if not trend:
            raise RiskRangePublicationError(
                f"Invalid risk range for {ticker}: trend is missing"
            )
        current_item = {
            "date": snapshot["date"],
            "ticker": ticker,
            "name": row.get("originalName"),
            "lrr": lrr,
            "hrr": hrr,
            "trend": trend,
            "updatedAt": ts,
            "source": f"hedgeye-{snapshot['snapshotType']}-email",
            "ttl": int(datetime.now(timezone.utc).timestamp() + (730 * 24 * 60 * 60)),
        }
        if row.get("prevClose") is not None:
            current_item["prevClose"] = Decimal(str(row["prevClose"]))
        if snapshot.get("htmlSource"):
            current_item["htmlSource"] = snapshot["htmlSource"]

        history_item = {
            "ticker": ticker,
            "date": snapshot["date"],
            "lrr": lrr,
            "hrr": hrr,
            "trend": trend,
            "timestamp": ts,
            "source": f"hedgeye-{snapshot['snapshotType']}-email",
        }
        if row.get("prevClose") is not None:
            history_item["prevClose"] = Decimal(str(row["prevClose"]))
        normalized_rows.append((ticker, current_item, history_item))

    # Early Look is explicitly supplemental. It is retained in history but
    # never mutates the primary current-book table or marks a day complete.
    if snapshot["snapshotType"] == "early-look":
        snap_table.put_item(Item=item)
        for _, _, history_item in normalized_rows:
            history_table.put_item(Item=history_item)
        return

    publication_order = _publication_order(ts)
    if publication_order is None:
        raise RiskRangePublicationOrderError(
            "Risk Range publication timestamp could not be verified"
        )
    source_message_id = (
        str(snapshot.get("gmailMessageId") or "").strip() or None
    )
    item["publicationOrder"] = publication_order
    item["sourceMessageId"] = source_message_id
    for _, current_item, history_item in normalized_rows:
        current_item["publicationOrder"] = publication_order
        current_item["sourceMessageId"] = source_message_id
        history_item["publicationOrder"] = publication_order
        history_item["sourceMessageId"] = source_message_id

    checksum_payload = [
        {
            "ticker": ticker,
            "lrr": str(current_item["lrr"]),
            "hrr": str(current_item["hrr"]),
            "trend": current_item["trend"],
        }
        for ticker, current_item, _ in sorted(normalized_rows, key=lambda value: value[0])
    ]
    checksum = hashlib.sha256(
        json.dumps(checksum_payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    manifest = {
        "publicationDate": snapshot["date"],
        "manifestType": "primary",
        "completionState": "complete",
        "count": len(normalized_rows),
        "checksum": checksum,
        "parserVersion": RISK_RANGE_PARSER_VERSION,
        "source": "hedgeye-risk-ranges-email",
        "sourceMessageId": source_message_id,
        "sourceArtifact": snapshot.get("htmlSource"),
        "publishedAt": snapshot.get("publishedAt"),
        "completedAt": ts,
        "publicationOrder": publication_order,
        "sourceQuality": snapshot.get("sourceQuality", {"status": "clear", "issues": []}),
    }
    manifest_table = db.Table(RISK_RANGE_MANIFEST_TABLE)
    try:
        existing_manifest = manifest_table.get_item(
            Key={
                "publicationDate": snapshot["date"],
                "manifestType": "primary",
            },
            ConsistentRead=True,
        ).get("Item")
    except ClientError as error:
        raise RiskRangePublicationOrderError(
            "Current Risk Range manifest could not be verified"
        ) from error
    if _is_exact_primary_manifest_replay(existing_manifest, manifest):
        # A complete manifest is written only after every projection has been
        # read back. It is the idempotency receipt for this immutable message.
        return
    manifest_cas, manifest_cas_names, manifest_cas_values = (
        _manifest_compare_and_swap(
            existing_manifest,
            incoming_order=publication_order,
            incoming_source_message_id=source_message_id,
        )
    )
    serializer = TypeSerializer()
    monotonic_condition, monotonic_names, monotonic_values = (
        _monotonic_put_condition(
            publication_order=publication_order,
        )
    )

    def guarded_put(table_name: str, item_value: Dict[str, Any]) -> Dict[str, Any]:
        return {
            "Put": {
                "TableName": table_name,
                # db.meta.client belongs to the high-level DynamoDB resource
                # and already has boto3's native-value transformer installed.
                # Pre-serializing here double-wraps numbers as maps (M), which
                # makes the monotonic numeric condition fail in production.
                "Item": {
                    key: value
                    for key, value in item_value.items()
                    if value is not None
                },
                "ConditionExpression": monotonic_condition,
                "ExpressionAttributeNames": dict(monotonic_names),
                "ExpressionAttributeValues": dict(monotonic_values),
            }
        }

    projection_writes = [
        guarded_put(HEDGEYE_DAILY_SNAPSHOT_TABLE, item)
    ]
    for _, current_item, history_item in normalized_rows:
        projection_writes.extend([
            guarded_put(RISK_RANGE_DATA_TABLE, current_item),
            guarded_put(RISK_RANGE_HISTORY_TABLE, history_item),
        ])

    for operation in projection_writes:
        serialized = _serialized_item(
            serializer,
            operation["Put"]["Item"],
        )
        item_size = len(
            json.dumps(serialized, sort_keys=True, separators=(",", ":")).encode(
                "utf-8"
            )
        )
        if item_size >= DYNAMODB_ITEM_MAX_BYTES:
            raise RiskRangeTransactionLimitError(
                "Risk Range publication contains a projection at or above 400 KiB"
            )

    attempt_id = hashlib.sha256(
        (
            f"{snapshot['date']}|{source_message_id or ''}|"
            f"{publication_order}|{checksum}|quality-"
            f"{(snapshot.get('sourceQuality') or {}).get('revision') or 'clear'}"
        ).encode("utf-8")
    ).hexdigest()[:32]
    expected_projection_count = len(projection_writes)
    build_version = str(os.environ.get("BUILD_VERSION") or "development")
    preparing_manifest = {
        **manifest,
        "completionState": "preparing",
        "attemptId": attempt_id,
        "expectedProjectionCount": expected_projection_count,
        "verifiedProjectionCount": 0,
        "buildVersion": build_version,
        "startedAt": datetime.now(timezone.utc).isoformat(),
    }
    preparing_manifest = {
        key: value for key, value in preparing_manifest.items() if value is not None
    }

    manifest_condition_names = {**monotonic_names, **manifest_cas_names}
    manifest_condition_values = {**monotonic_values, **manifest_cas_values}
    try:
        manifest_table.put_item(
            Item=preparing_manifest,
            ConditionExpression=f"{monotonic_condition} AND ({manifest_cas})",
            ExpressionAttributeNames=manifest_condition_names,
            ExpressionAttributeValues=manifest_condition_values,
        )
    except ClientError as error:
        service_code = str(
            (error.response or {}).get("Error", {}).get("Code") or "DynamoDbError"
        )
        if service_code == "ConditionalCheckFailedException":
            raise RiskRangeStalePublicationError(
                "Risk Range publication lost its manifest compare-and-swap guard"
            ) from error
        raise RiskRangeTransactionWriteError(
            f"Risk Range preparing manifest failed ({service_code})"
        ) from error

    failed_chunk: Optional[int] = None
    try:
        for offset in range(0, len(projection_writes), DYNAMODB_TRANSACTION_CHUNK_SIZE):
            chunk_index = offset // DYNAMODB_TRANSACTION_CHUNK_SIZE
            chunk = projection_writes[
                offset : offset + DYNAMODB_TRANSACTION_CHUNK_SIZE
            ]
            serialized_chunk = [
                _serialized_transaction_write(serializer, operation)
                for operation in chunk
            ]
            chunk_size = len(
                json.dumps(
                    serialized_chunk,
                    sort_keys=True,
                    separators=(",", ":"),
                ).encode("utf-8")
            )
            if (
                len(chunk) > DYNAMODB_TRANSACTION_MAX_OPERATIONS
                or chunk_size >= DYNAMODB_TRANSACTION_MAX_BYTES
            ):
                raise RiskRangeTransactionLimitError(
                    "Risk Range publication chunk exceeds DynamoDB transaction limits"
                )
            failed_chunk = chunk_index
            client_request_token = hashlib.sha256(
                f"{attempt_id}:{chunk_index}".encode("utf-8")
            ).hexdigest()[:32]
            db.meta.client.transact_write_items(
                TransactItems=chunk,
                ClientRequestToken=client_request_token,
            )
        failed_chunk = None
        verified_projection_count = _verify_risk_range_projections(
            db,
            item,
            normalized_rows,
        )
    except ClientError as error:
        response = error.response or {}
        service_code = str(
            response.get("Error", {}).get("Code") or "DynamoDbError"
        )
        cancellation_codes = [
            str(reason.get("Code") or "None")
            for reason in response.get("CancellationReasons") or []
            if isinstance(reason, dict)
        ]
        reason_suffix = (
            f"; cancellation codes: {','.join(cancellation_codes)}"
            if cancellation_codes
            else ""
        )
        failed_manifest = {
            **preparing_manifest,
            "completionState": "failed",
            "failedAt": datetime.now(timezone.utc).isoformat(),
            "errorCode": "RISK_RANGE_TRANSACTION_WRITE_FAILED",
            "failedChunk": failed_chunk,
        }
        try:
            manifest_table.put_item(
                Item={
                    key: value
                    for key, value in failed_manifest.items()
                    if value is not None
                },
                ConditionExpression="#attemptId = :attemptId",
                ExpressionAttributeNames={"#attemptId": "attemptId"},
                ExpressionAttributeValues={":attemptId": attempt_id},
            )
        except ClientError:
            pass
        if "ConditionalCheckFailed" in cancellation_codes:
            raise RiskRangeStalePublicationError(
                "Risk Range publication lost its monotonic projection guard"
            ) from error
        raise RiskRangeTransactionWriteError(
            f"Risk Range publication chunk failed ({service_code}){reason_suffix}"
        ) from error
    except RiskRangePublicationError as error:
        failed_manifest = {
            **preparing_manifest,
            "completionState": "failed",
            "failedAt": datetime.now(timezone.utc).isoformat(),
            "errorCode": error.error_code,
            "failedChunk": failed_chunk,
        }
        try:
            manifest_table.put_item(
                Item={
                    key: value
                    for key, value in failed_manifest.items()
                    if value is not None
                },
                ConditionExpression="#attemptId = :attemptId",
                ExpressionAttributeNames={"#attemptId": "attemptId"},
                ExpressionAttributeValues={":attemptId": attempt_id},
            )
        except ClientError:
            pass
        raise

    complete_manifest = {
        **manifest,
        "attemptId": attempt_id,
        "expectedProjectionCount": expected_projection_count,
        "verifiedProjectionCount": verified_projection_count,
        "buildVersion": build_version,
        "verifiedAt": datetime.now(timezone.utc).isoformat(),
    }
    complete_manifest = {
        key: value for key, value in complete_manifest.items() if value is not None
    }
    try:
        manifest_table.put_item(
            Item=complete_manifest,
            ConditionExpression=(
                "#attemptId = :attemptId AND #completionState = :preparing"
            ),
            ExpressionAttributeNames={
                "#attemptId": "attemptId",
                "#completionState": "completionState",
            },
            ExpressionAttributeValues={
                ":attemptId": attempt_id,
                ":preparing": "preparing",
            },
        )
    except ClientError as error:
        service_code = str(
            (error.response or {}).get("Error", {}).get("Code") or "DynamoDbError"
        )
        if service_code == "ConditionalCheckFailedException":
            try:
                current_manifest = manifest_table.get_item(
                    Key={
                        "publicationDate": snapshot["date"],
                        "manifestType": "primary",
                    },
                    ConsistentRead=True,
                ).get("Item")
            except ClientError:
                current_manifest = None
            if _is_exact_primary_manifest_replay(
                current_manifest,
                complete_manifest,
            ):
                return
            raise RiskRangeStalePublicationError(
                "Risk Range publication lost its completion manifest guard"
            ) from error
        raise RiskRangeTransactionWriteError(
            f"Risk Range completion manifest failed ({service_code})"
        ) from error
