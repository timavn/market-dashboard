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
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Dict, List, Optional, Tuple

from boto3.dynamodb.types import TypeSerializer
from botocore.exceptions import ClientError


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


def _parse_real_time_alert(headline: Optional[str], text: str, html_body: str) -> Optional[Dict[str, Any]]:
    if not headline:
        headline = _extract_headline(html_body, text)
    if not headline:
        return None

    normalized = re.sub(r"^[*\s]+", "", headline).strip()
    inline_match = re.search(
        r"\b(BUY|SELL-SOME|SELL|COVER)\s+SIGNAL(?:\s*-\s*(SHORTING|COVERING|BUYING|SELLING))?\s+([A-Z][A-Z0-9./-]{1,9})\b",
        normalized,
        re.IGNORECASE,
    )
    if inline_match:
        action = inline_match.group(1).upper()
        modifier = (inline_match.group(2) or "").upper()
        ticker = inline_match.group(3).upper()
        return {
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
        }

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
            ticker_match = re.search(r"\b([A-Z][A-Z0-9./-]{1,9})\b", target)
            if ticker_match and target == ticker_match.group(1):
                ticker = ticker_match.group(1).upper()
                name = ticker

        return {
            "headline": normalized,
            "signalFamily": family or signal_phrase,
            "signalPhrase": signal_phrase,
            "action": action,
            "context": context,
            "ticker": ticker,
            "name": name,
            "analyst": analyst,
        }

    simple_match = re.search(r"^(BUY|SELL-SOME|SELL|COVER)\s+SIGNAL\s+([A-Z][A-Z0-9./-]{1,9})$", normalized, re.IGNORECASE)
    if simple_match:
        action = simple_match.group(1).upper()
        ticker = simple_match.group(2).upper()
        analyst_match = re.search(r"\n\s*([A-Z]{2,4})\s*\n", text)
        analyst = analyst_match.group(1).upper() if analyst_match else None
        return {
            "headline": normalized,
            "signalFamily": "Real-Time",
            "signalPhrase": normalized,
            "action": action,
            "context": None,
            "ticker": ticker,
            "name": _extract_first_image_alt(html_body) or ticker,
            "analyst": analyst,
        }

    return None


def _extract_real_time_alert(headline: Optional[str], text: str, html_body: str) -> Optional[Dict[str, Any]]:
    alert = _parse_real_time_alert(headline, text, html_body)
    if alert:
        return alert
    return None


def _extract_position_change_alerts(headline: Optional[str]) -> List[Dict[str, Any]]:
    if not headline:
        return []
    normalized = re.sub(r"\s+", " ", headline).strip()
    match = re.search(r"\b\d+\s+Changes?:\s*(.+)$", normalized, re.IGNORECASE)
    if not match:
        return []

    alerts: List[Dict[str, Any]] = []
    active_action: Optional[str] = None
    for clause in re.split(r"\s*,\s*", match.group(1)):
        item = re.search(r"\b(Add|Remove)\s+([A-Z][A-Z0-9./-]{1,9})\b", clause, re.IGNORECASE)
        if item:
            active_action = "ADD" if item.group(1).upper() == "ADD" else "REMOVE"
            ticker = item.group(2).upper()
        else:
            continuation = re.fullmatch(r"\s*([A-Z][A-Z0-9./-]{1,9})\s*", clause, re.IGNORECASE)
            if not continuation or not active_action:
                continue
            ticker = continuation.group(1).upper()
        action = active_action
        alerts.append({
            "headline": normalized,
            "signalFamily": "Position Changes",
            "signalPhrase": clause,
            "action": action,
            "side": "long",
            "context": "position-change",
            "ticker": ticker,
            "name": ticker,
            "analyst": None,
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
    if _risk_range_row_signature(existing) == _risk_range_row_signature(row):
        return
    raise RiskRangeDuplicateConflictError(
        f"Conflicting duplicate Risk Range row for {ticker}"
    )


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
) -> Optional[Dict[str, Any]]:
    text = _strip_tags(html_body)

    if report_type == "early-look":
        levels = _extract_levels_from_text(text)
        if not levels:
            return None
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
        return snapshot

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
        added = _extract_label_symbols(text, "Added")
        removed = _extract_label_symbols(text, "Removed")
        count_text = _extract_first(r"Signal Strength Stocks:\s*(\d+)\s+Stocks", text, re.IGNORECASE)
        stock_count = int(count_text) if count_text else len(added)
        if not added and not removed and not stock_count:
            return None
        snapshot = _base_snapshot(
            snapshot_type="signal-strength",
            report_type=report_type,
            html_body=html_body,
            text=text,
            received_at=received_at,
            s3_key=s3_key,
            message_id=message_id,
        )
        snapshot["stockCount"] = stock_count
        snapshot["data"] = {
            "added": added,
            "removed": removed,
            "stocks": [{"ticker": ticker} for ticker in added],
        }
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
        charts = _extract_chart_items(html_body)
        if not charts:
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
        snapshot["chartCount"] = len(charts)
        snapshot["data"] = {
            item["name"]: {"chartUrl": item["url"]}
            for item in charts
        }
        snapshot["article"]["charts"] = charts
        return snapshot

    if report_type in {"crypto-quant", "bitcoin-trend-tracker"}:
        charts = _extract_chart_items(html_body)
        headline = _extract_headline(html_body, text)
        cryptos = _extract_crypto_title_data(headline)
        if not charts and not cryptos:
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
        snapshot["cryptoCount"] = len(cryptos) or len(charts)
        snapshot["data"] = {
            "cryptos": cryptos,
            "stocks": {},
            "charts": charts,
        }
        snapshot["article"]["charts"] = charts
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
        headline = _extract_headline(html_body, text) or subject
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
        alerts = _extract_position_change_alerts(headline)
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
        item["riskRangeCount"] = len(rows_by_ticker)

    for ticker, row in rows_by_ticker.items():
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

    if not normalized_rows:
        raise RiskRangePublicationError(
            "Primary Risk Range publication contains no valid rows"
        )
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
            f"{publication_order}|{checksum}"
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
