#!/usr/bin/env python3
"""
Parse Hedgeye HTML email bodies into the existing DynamoDB snapshot shapes.
"""

from __future__ import annotations

import html
import re
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Dict, List, Optional, Tuple


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
    for clause in re.split(r"\s*,\s*", match.group(1)):
        item = re.search(r"\b(Add|Remove)\s+([A-Z][A-Z0-9./-]{1,9})\b", clause, re.IGNORECASE)
        if not item:
            continue
        action = "ADD" if item.group(1).upper() == "ADD" else "REMOVE"
        ticker = item.group(2).upper()
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
        data[ticker] = {
            "lrr": lrr,
            "hrr": hrr,
            "trend": trend,
            "originalName": name,
        }

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
        data[ticker] = {
            "lrr": lrr,
            "hrr": hrr,
            "trend": trend,
            "prevClose": prev_close,
            "originalName": name,
        }

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
        if not longs and not shorts and not neutrals:
            return None
        snapshot = _base_snapshot(
            snapshot_type="the-call",
            report_type=report_type,
            html_body=html_body,
            text=text,
            received_at=received_at,
            s3_key=s3_key,
            message_id=message_id,
        )
        snapshot["positionCount"] = len(longs) + len(shorts) + len(neutrals)
        snapshot["data"] = {
            "longs": longs,
            "shorts": shorts,
            "neutrals": neutrals,
        }
        return snapshot

    if report_type == "the-macro-show":
        bullish_raw = _extract_section_text(text, "BULLISH", ["BEARISH", "MAIN SUMMARY", "Summary has been enhanced"])
        bearish_raw = _extract_section_text(text, "BEARISH", ["MAIN SUMMARY", "Summary has been enhanced"])
        neutral_raw = _extract_section_text(text, "NEUTRAL", ["MAIN SUMMARY", "Summary has been enhanced"])
        longs = _clean_macro_show_items(_split_exact_items(bullish_raw))
        shorts = _clean_macro_show_items(_split_exact_items(bearish_raw))
        neutrals = _clean_macro_show_items(_split_exact_items(neutral_raw))
        if not longs and not shorts and not neutrals:
            return None
        snapshot = _base_snapshot(
            snapshot_type="the-macro-show",
            report_type=report_type,
            html_body=html_body,
            text=text,
            received_at=received_at,
            s3_key=s3_key,
            message_id=message_id,
        )
        snapshot["positionCount"] = len(longs) + len(shorts) + len(neutrals)
        snapshot["data"] = {
            "longs": longs,
            "shorts": shorts,
            "neutrals": neutrals,
            "rawLongsText": bullish_raw,
            "rawShortsText": bearish_raw,
            "rawNeutralText": neutral_raw,
        }
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
                "action": item["action"],
                "riskRangeLow": item.get("riskRangeLow"),
                "riskRangeHigh": item.get("riskRangeHigh"),
            }
            for idx, item in enumerate(changes)
        ]
        snapshot["itemCount"] = len(changes)
        snapshot["changeCount"] = len(changes)
        snapshot["data"] = {
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
                snapshot_type="real-time-alert",
                report_type="real-time-alert",
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


def save_snapshot_to_dynamodb(snapshot: Dict[str, Any], db: Any) -> None:
    snap_table = db.Table("HedgeyeDailySnapshot")
    item = _decimalize(snapshot)
    item["ttl"] = int(datetime.now(timezone.utc).timestamp() + (730 * 24 * 60 * 60))
    snap_table.put_item(Item=item)

    if snapshot["snapshotType"] not in {"early-look", "risk-ranges"}:
        return

    range_table = db.Table("HedgeyeRiskRanges")
    history_table = db.Table("RiskRangeData")
    ts = snapshot["scrapedAt"]
    for ticker, row in snapshot.get("data", {}).items():
        lrr = Decimal(str(row["lrr"]))
        hrr = Decimal(str(row["hrr"]))
        current_item = {
            "date": snapshot["date"],
            "ticker": ticker,
            "name": row.get("originalName"),
            "lrr": lrr,
            "hrr": hrr,
            "trend": row["trend"],
            "updatedAt": ts,
            "source": f"hedgeye-{snapshot['snapshotType']}-email",
            "ttl": int(datetime.now(timezone.utc).timestamp() + (730 * 24 * 60 * 60)),
        }
        if row.get("prevClose") is not None:
            current_item["prevClose"] = Decimal(str(row["prevClose"]))
        if snapshot.get("htmlSource"):
            current_item["htmlSource"] = snapshot["htmlSource"]
        range_table.put_item(Item=current_item)

        history_item = {
            "ticker": ticker,
            "date": snapshot["date"],
            "lrr": lrr,
            "hrr": hrr,
            "trend": row["trend"],
            "timestamp": ts,
            "source": f"hedgeye-{snapshot['snapshotType']}-email",
        }
        if row.get("prevClose") is not None:
            history_item["prevClose"] = Decimal(str(row["prevClose"]))
        history_table.put_item(Item=history_item)
