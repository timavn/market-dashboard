"""Dated, source-only TL;DR projection for the Analyst's daily portfolio review.

These are research publications, never market quotes or user portfolio positions.
The projection is deliberately deterministic: it preserves the publisher's words,
explicit actions and time horizons, and only compares like-for-like dated fields.
"""
from __future__ import annotations

from datetime import datetime, time, timezone
from hashlib import sha256
import html
import json
import math
import re
from typing import Any
from urllib.parse import urlsplit, urlunsplit
from zoneinfo import ZoneInfo

from market_structure_evidence import evidence_safe, metric_rows
from market_structure_narrative import narrative_blocks
from hedgai_review import portfolio_hedgai_section

NY = ZoneInfo("America/New_York")
PRODUCTS = {
    "top-3-things": "Top 3 Things", "risk-ranges": "Risk Ranges",
    "early-look": "Early Look", "the-call": "The Call",
    "the-macro-show": "Macro Show", "signal-strength": "Signal Strength",
    "market-structure": "Market Structure",
}
ALIASES = {"top3": "top-3-things", "riskranges": "risk-ranges", "earlylook": "early-look",
           "thecall": "the-call", "macroshow": "the-macro-show", "signalstrength": "signal-strength",
           "marketstructure": "market-structure"}
# Event-driven Signal Strength keeps its latest eligible publication inside the
# immutable capture. Other daily products retain their exact-edition policy.
CAPTURE_SELECTION = {"signal-strength": "latest-captured-publication"}
HEADINGS = {
    "key takeaways", "the big picture", "macro grind", "quad path", "our levels",
    "top 5 most actionable", "macro commentary", "sector summary", "signal divergence",
    "main summary", "position changes and portfolio actions", "hedgeye positions",
    "tldr - positions mentioned", "tl;dr - positions mentioned",
}
POSITION_HEADINGS = {"hedgeye positions", "tldr - positions mentioned", "tl;dr - positions mentioned"}
WRAPPER = re.compile(
    r"^(?:hedgeye\s*$|this research was prepared|having trouble viewing|view (?:it|this email) in your browser|"
    r"click here|view link\b|\(?\s*view larger image|please visit\b|for more information\.?$|"
    r"©|copyright|if you believe this has been sent|best of luck out there|km$|"
    r"\(?(?:this )?summary has been enhanced (?:by|with) (?:ai|a\.i\.)|access the macro show dashboard|"
    r"how to (?:use|read) (?:signal strength|risk range)|the research note below was written|"
    r"to access the full|by craig peterson|prepared exclusively for|"
    r"the summary and positions listed here reflect|positions listed in order mentioned|"
    r"\(?positioning (?:refers|based)|\(?analyst positioning may|"
    r"\(?tickers where keith|helpful links|join new subscriber|hedgeye university|hedgeye education)", re.I)
PUB_LINE = re.compile(r"\b(\d{1,2}/\d{1,2}/\d{4})\s+(\d{1,2}:\d{2})(?:\s*([AP]M))?\s+(EDT|EST|ET|PDT|PST|PT|UTC|GMT)\b", re.I)
SIDE_LINE = re.compile(r"^\s*[•*\-]?\s*(LONGS?|SHORTS?|BULLISH|BEARISH|NEUTRALS?)\s*:\s*(.*)$", re.I)
DISPLAY_TIME = re.compile(r"(?<![\w.:])([1-9]|1[0-2])(?::([0-5]\d))?\s*([ap])\.?m\.?(?!\w)", re.I)


def _dict(value):
    return value if isinstance(value, dict) else {}


def _list(value):
    return value if isinstance(value, list) else []


def _text(value):
    if not isinstance(value, (str, int, float)) or isinstance(value, bool):
        return ""
    return re.sub(r"[ \t]+", " ", html.unescape(str(value)).replace("\r", "")).strip()


def _date(value):
    value = _text(value)
    try:
        return datetime.strptime(value, "%Y-%m-%d").date().isoformat()
    except ValueError:
        return None


def _datetime(value):
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc) if value.tzinfo else None
    try:
        parsed = datetime.fromisoformat(_text(value).replace("Z", "+00:00"))
        return parsed.astimezone(timezone.utc) if parsed.tzinfo else None
    except ValueError:
        return None


def publication_time(snapshot):
    """Prefer the email's actual sent time over imported midnight placeholders."""
    article = _dict(snapshot.get("article"))
    inline = PUB_LINE.search(_text(article.get("bodyText")))
    if inline:
        day, clock, meridiem, zone = inline.groups()
        try:
            parsed = datetime.strptime(f"{day} {clock} {meridiem or ''}".strip(),
                                       "%m/%d/%Y %I:%M %p" if meridiem else "%m/%d/%Y %H:%M")
        except ValueError:
            return None
        tz = NY if zone.upper() in {"ET", "EST", "EDT"} else (
            ZoneInfo("America/Los_Angeles") if zone.upper() in {"PT", "PST", "PDT"} else timezone.utc)
        return parsed.replace(tzinfo=tz).astimezone(timezone.utc)
    for value in (article.get("publishedAt"), snapshot.get("publishedAt")):
        parsed = _datetime(value)
        if parsed and parsed.time() != time(0):
            return parsed
    return None


def _eligible(snapshot, evidence_date, cutoff):
    if not isinstance(snapshot, dict):
        return False
    day = _date(snapshot.get("date") or _dict(snapshot.get("meta")).get("date"))
    if not day or day > evidence_date or day > cutoff.astimezone(NY).date().isoformat():
        return False
    # Immutable, dated research may be read after provider disconnects. Fabricated
    # snapshots and failed/partial refresh envelopes must not become publications.
    if (str(snapshot.get("status") or "").lower() in {"failed", "error", "unavailable"}
            or bool(snapshot.get("error")) or snapshot.get("refreshFailed") is True
            or bool(snapshot.get("refreshIssue"))):
        return False
    if any(container.get(key) is True for container in (snapshot, _dict(snapshot.get("data")), _dict(snapshot.get("meta")))
           for key in ("mock", "isMock", "seeded", "synthetic")):
        return False
    if re.search(r"\b(mock|seed(?:ed)?|synthetic|fixture)\b", str(snapshot.get("source") or ""), re.I):
        return False
    published = publication_time(snapshot)
    if published:
        return published <= cutoff
    declared = _datetime(snapshot.get("publishedAt"))
    if declared and declared > cutoff:
        return False
    # Capture time proves the dated article existed, but is never its publication
    # time in the report. A date-only publication is usable after that day ended.
    captured = next((instant for key in ("receivedAt", "scrapedAt", "retrievedAt", "createdAt")
                     if (instant := _datetime(snapshot.get(key)))), None)
    if captured:
        return captured <= cutoff
    return day < cutoff.astimezone(NY).date().isoformat()


def _clean_lines(value):
    lines = []
    for line in _text(value).splitlines():
        line = line.strip()
        if not line:
            lines.append("")
            continue
        if WRAPPER.search(line) or PUB_LINE.search(line):
            continue
        if re.match(r"^https?://app\.hedgeye\.com/feed_items/", line):
            continue
        if re.fullmatch(r"https?://\S+", line):
            continue
        if re.match(r"^[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}$", line):
            continue
        line = re.sub(r"\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b", "", line)
        lines.append(line.strip())
    return re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()


def _paragraphs(value):
    """Keep complete source paragraphs and bullet meaning; never truncate prose."""
    clean = _clean_lines(value)
    return [re.sub(r"^[•*]\s*", "", text.strip()) for text in re.split(r"\n\s*\n|\n(?=[•*]\s)", clean)
            if text.strip()]


def _display_prose(value):
    """Remove publisher banter while retaining complete financial statements."""
    value = _text(value)
    # These are rhetorical asides, not numbers, catalysts or source actions.
    # Removing them also leaves nearby conditional/forward-looking claims intact.
    value = re.sub(r"\b(?:Hold my beer|YOLO|Who cares|Like squid games|Another acronym)[!?.]+\s*", "", value, flags=re.I)
    value = re.sub(r"\b(?:We['’]ll find out|You can f\*?ck around)[.!?]+\s*", "", value, flags=re.I)
    value = re.sub(r"\bFAFO is not (?:a prediction of doom|a doom call)[.!?]+\s*", "", value, flags=re.I)
    value = re.sub(r"\b(?:It is a statement about consequences|The great finding out is rarely scheduled at a convenient time|From YOLO to FAFO)[.!?]+\s*", "", value, flags=re.I)
    value = re.sub(r"\bGreat conversation (?:this week|today|yesterday) between [^.]+\.\s*", "", value, flags=re.I)

    def clock(match):
        hour, minutes, meridiem = match.groups()
        hour = int(hour) % 12 + (12 if meridiem.lower() == "p" else 0)
        return f"{hour:02d}:{minutes or '00'}"

    return DISPLAY_TIME.sub(clock, value).strip()


def _heading(line):
    normalized = line.strip().strip("#: ").lower()
    if normalized in HEADINGS:
        return normalized
    # Macro Show uses descriptive all-capital headings between bullet paragraphs.
    if 5 <= len(line) <= 160 and line.upper() == line and re.search(r"[A-Z]{3}", line):
        if not SIDE_LINE.match(line) and not re.search(r"https?://|\d{1,2}:\d{2}", line):
            return normalized
    return None


def _article_sections(snapshot):
    article = _dict(snapshot.get("article"))
    body = _clean_lines(article.get("bodyText"))
    sections, current, lines = [], None, []
    for line in body.splitlines():
        heading = _heading(line)
        if heading:
            if current and any(lines):
                sections.append((current, "\n".join(lines).strip()))
            current, lines = line.strip().strip("#: "), []
        elif current:
            lines.append(line)
    if current and any(lines):
        sections.append((current, "\n".join(lines).strip()))
    known = [entry for entry in sections if entry[0].lower() in HEADINGS]
    structured = [(str(title), _clean_lines(text)) for title, text in _dict(article.get("sections")).items()
                  if isinstance(text, str) and _clean_lines(text)]
    # Some email importers incorrectly store the entire Early Look under its
    # author's job title. Real body headings are more faithful in that case.
    if known:
        return sections
    if structured:
        return structured
    summary = _clean_lines(article.get("summary"))
    return [("", summary or body)] if summary or body else []


def _source_uri(snapshot, product):
    article = _dict(snapshot.get("article"))
    for value in (article.get("feedUrl"), article.get("sourceUrl"), snapshot.get("sourceUrl")):
        uri = _text(value)
        if uri.startswith(("https://", "http://")):
            parts = urlsplit(uri)
            return urlunsplit((parts.scheme, parts.netloc, parts.path, "", ""))
    match = re.search(r"https://app\.hedgeye\.com/feed_items/\d+", _text(article.get("bodyText")))
    return match.group() if match else f"dynamodb://HedgeyeDailySnapshot/{snapshot['date']}/{product}"


def _citation(snapshot, product):
    day = snapshot.get("date") or _dict(snapshot.get("meta")).get("date")
    uri = _source_uri({**snapshot, "date": day}, product)
    article = _dict(snapshot.get("article"))
    canonical = lambda value: json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    document = sha256(canonical([product, day, uri]).encode()).hexdigest()[:32]
    excerpt = _clean_lines(article.get("bodyText") or article.get("summary"))
    chart_readings = []
    if product == "market-structure":
        if not excerpt:
            excerpt = "\n\n".join(_clean_lines(block.get("text"))
                for block in _list(_dict(snapshot.get("data")).get("blocks"))
                if isinstance(block, dict) and block.get("type") in {"heading", "paragraph", "callout"}
                and evidence_safe(block) and _clean_lines(block.get("text")))
        chart_readings = [{"cells": row["cells"], "provenance": row["provenance"]}
                          for row in metric_rows(snapshot, "")]
        if chart_readings:
            reading_text = "Published chart readings\n" + "\n".join(
                f"{row['cells'][0]}: {row['cells'][1]} · {row['cells'][2]}" for row in chart_readings)
            excerpt = "\n\n".join(part for part in (excerpt, reading_text) if part)
    identity = [document, excerpt, chart_readings] if chart_readings else [document, excerpt]
    citation = sha256(canonical(identity).encode()).hexdigest()[:32]
    result = {"id": f"cite_{citation}", "documentId": f"doc_{document}", "product": product,
              "publicationDate": day, "sourceUri": uri,
              "title": _text(article.get("headline") or article.get("reportHeading")) or PRODUCTS[product],
              "productLabel": PRODUCTS[product], "excerpt": excerpt}
    if chart_readings:
        result["chartReadings"] = chart_readings
    if published := publication_time(snapshot):
        result["publishedAt"] = published.isoformat()
    return result


def _number(value):
    if isinstance(value, bool) or value is None or value == "":
        return None
    try:
        numeric = float(str(value).replace(",", ""))
        return numeric if math.isfinite(numeric) else None
    except (ValueError, TypeError):
        return None


def _num(value):
    value = _number(value)
    return f"{value:,.6f}".rstrip("0").rstrip(".") if value is not None else "—"


def _range_boundary_change(previous, current, boundary):
    """Compare the captured endpoint before display rounding, independently."""
    previous, current = _number(previous), _number(current)
    if previous is None or current is None:
        return "—"
    if current == previous:
        return "Unchanged"
    return f"{'Higher' if current > previous else 'Lower'} {boundary}"


def _symbol(value):
    value = _text(value).strip("$")
    end = re.search(r"\(([A-Z0-9][A-Z0-9./^-]*)\)\s*$", value)
    return end.group(1) if end else value.upper()


def _range_rows(snapshot):
    data = snapshot.get("data")
    rows = data if isinstance(data, list) else [{"ticker": key, **row} for key, row in _dict(data).items()
                                               if isinstance(row, dict)]
    return {_symbol(row.get("ticker") or row.get("symbol") or row.get("originalName")): row for row in rows
            if isinstance(row, dict) and (row.get("ticker") or row.get("symbol") or row.get("originalName"))
            and (row.get("trend") or _number(row.get("lrr")) is not None or _number(row.get("hrr")) is not None)}


def _instrument_label(row, symbol):
    # Legacy importers sometimes map a spot/index series onto an ETF ticker
    # (for example Gold Spot Price stored under GLD). The published name is the
    # actual instrument evidence; the storage key is not an executable identity.
    return _text(row.get("originalName") or row.get("name")) or symbol


def _published_security_identities(snapshot):
    """Read ticker/name pairs from this captured publication, not storage aliases."""
    identities = {}
    body = _text(_dict(snapshot.get("article")).get("bodyText"))
    for ticker, name in re.findall(
        r"(?im)^\s*([A-Z0-9][A-Z0-9./^-]*)\s+\((?:BULLISH|BEARISH|NEUTRAL)\)"
        r"\s*\n\s*([^\n]+?)\s*\n\s*(?=[\d,]+(?:\.\d+)?\s*(?:\n|$))", body
    ):
        identities[ticker.upper()] = _text(name)
    for name, ticker in re.findall(
        r"(?im)^\s*([^\n]+?)\s+\(([A-Z0-9][A-Z0-9./^-]*)\)\s*=\s*"
        r"(?:Bullish|Bearish|Neutral)\s*\(\d{1,2}/\d{1,2}/\d{4}\)", body
    ):
        identities[ticker.upper()] = _text(name)
    raw = snapshot.get("outbucket")
    if isinstance(raw, dict):
        raw = [{"ticker": key, **value} for key, value in raw.items() if isinstance(value, dict)]
    for row in _list(raw):
        if not isinstance(row, dict):
            continue
        ticker = _text(row.get("ticker") or row.get("symbol"))
        name = _text(row.get("originalName") or row.get("name"))
        if ticker and name and ticker.upper() != name.upper():
            identities.setdefault(ticker.upper(), name)
    known_tickers = set(identities)
    for values in (_position_groups(snapshot) or {}).values():
        for value in values:
            known_tickers.add(_symbol(value))
            named = re.fullmatch(r"(.+?)\s*\(([A-Z0-9][A-Z0-9./^-]*)\)", value)
            if named:
                identities.setdefault(named.group(2), named.group(1).strip())
    for stock in _list(_dict(snapshot.get("data")).get("stocks")):
        if not isinstance(stock, dict):
            continue
        ticker = _text(stock.get("ticker") or stock.get("symbol"))
        if ticker:
            known_tickers.add(ticker.upper())
        name = _text(stock.get("originalName") or stock.get("name") or stock.get("securityName"))
        if ticker and name and ticker.upper() != name.upper():
            identities.setdefault(ticker.upper(), name)
    # The Call commonly gives a bare ticker in its position list and the
    # spelled-out company name at the start of that security's paragraph.
    # Require the ticker to be established above so prose acronyms never
    # become security identities.
    for name, ticker in re.findall(
        r"(?m)^\s*(?:[•*]\s*)?([^()\n]{1,120}?)\s*\(([A-Z][A-Z0-9./^-]*)\)(?=\s|[.,;:]|$)", body
    ):
        if ticker in known_tickers:
            identities.setdefault(ticker, _text(name))
    for name, ticker in re.findall(
        r"\([A-Z][A-Z0-9./^-]*\)\s*,?\s+and\s+([^()\n;]{1,120}?)\s*\(([A-Z][A-Z0-9./^-]*)\)", body
    ):
        if ticker in known_tickers:
            identities.setdefault(ticker, _text(name))
    return identities


def _security_cells(row, symbol, identities):
    name = _text(row.get("originalName") or row.get("name"))
    if name:
        named_tickers = [ticker for ticker, published_name in identities.items()
                         if published_name.casefold() == name.casefold()]
        if len(named_tickers) == 1:
            return [named_tickers[0], name]
        explicit = re.fullmatch(r"(.+?)\s*\(([A-Z0-9][A-Z0-9./^-]*)\)", name)
        if explicit:
            return [explicit.group(2), explicit.group(1).strip()]
    if symbol in identities:
        return [symbol, identities[symbol]]
    # A name-only capture cannot establish that its imported map key is the
    # published ticker (Gold Spot Price was historically imported under GLD).
    if name and name.upper() != symbol:
        return ["—", name]
    return [symbol if re.fullmatch(r"[A-Z0-9][A-Z0-9./^-]*", symbol) else "—", name if name and name.upper() != symbol else "—"]


def _level_identity(row, symbol):
    name = re.sub(r"\s*\([A-Z0-9./^-]+\)\s*$", "", _instrument_label(row, symbol))
    return re.sub(r"\W+", " ", name).casefold().strip()


def _position_groups(snapshot):
    """Use bounded publisher labels, not imported arrays that cross label borders."""
    body = _text(_dict(snapshot.get("article")).get("bodyText"))
    groups = {"Long": [], "Short": [], "Neutral": []}
    found, active = False, None
    for line in body.splitlines():
        line = line.strip()
        match = SIDE_LINE.match(line)
        if match:
            label, values = match.groups()
            active = "Long" if label.upper() in {"LONG", "LONGS", "BULLISH"} else (
                "Short" if label.upper() in {"SHORT", "SHORTS", "BEARISH"} else "Neutral")
            found = True
        elif not line:
            continue
        elif active and not WRAPPER.search(line) and not _heading(line):
            # Continuation lines are only accepted as comma-delimited lists of
            # ticker tokens or product names ending in an explicit ticker.
            values = line
        else:
            active = None
            continue
        for value in values.split(","):
            value = _text(value).strip("• $")
            if re.fullmatch(r"[A-Z][A-Z0-9./^-]{0,19}", value) or re.fullmatch(r"[^:;\n]+\([A-Z0-9][A-Z0-9./^-]*\)", value):
                if value not in groups[active]:
                    groups[active].append(value)
            elif value:
                # A prose/heading boundary ends this list, rather than being
                # treated as another ticker or another group's direction.
                active = None
                break
    if not found:
        return None
    # The same instrument on both sides is ambiguous; preserve prose instead.
    symbols = [_symbol(value) for values in groups.values() for value in values]
    if len(symbols) != len(set(symbols)):
        return None
    return groups


class _Report:
    def __init__(self, snapshots=()):
        self.sections = []
        self.citations = {}
        self.paragraphs = {}
        self.levels = {}
        self.identities = {}
        self.security_tickers = set()
        for snapshot in snapshots:
            identities = _published_security_identities(snapshot)
            self.identities.update(identities)
            self.security_tickers.update(identities)
            body = _text(_dict(snapshot.get("article")).get("bodyText"))
            self.security_tickers.update(re.findall(r"(?<![\w$])\$([A-Z][A-Z0-9]*(?:[./-][A-Z0-9]+)?)(?![\w.])", body))
            for symbol, row in _range_rows(snapshot).items():
                ticker = _security_cells(row, symbol, identities)[0]
                if ticker != "—":
                    self.security_tickers.add(ticker)
            for values in (_position_groups(snapshot) or {}).values():
                self.security_tickers.update(_symbol(value) for value in values)
            data = _dict(snapshot.get("data"))
            for value in [*_list(data.get("stocks")), *_list(data.get("added")), *_list(data.get("removed")),
                          *_list(snapshot.get("trendChanges"))]:
                ticker = _text(value.get("ticker") or value.get("symbol")) if isinstance(value, dict) else _text(value)
                if re.fullmatch(r"[A-Z0-9][A-Z0-9./^-]*", ticker):
                    captured_row = _range_rows(snapshot).get(ticker)
                    resolved = _security_cells(captured_row, ticker, identities)[0] if captured_row else ticker
                    if resolved != "—":
                        self.security_tickers.add(resolved)

    def security(self, row, symbol, identities=None):
        return _security_cells(row, symbol, {**self.identities, **(identities or {})})

    def source(self, snapshot, product):
        citation = _citation(snapshot, product)
        self.citations[citation["id"]] = citation
        return citation["id"]

    def section(self, identity, title):
        section = {"id": identity, "title": title, "blocks": [], "citationIds": []}
        self.sections.append(section)
        return section

    def cite(self, section, ids):
        for cid in ids:
            if cid and cid not in section["citationIds"]:
                section["citationIds"].append(cid)

    def paragraph(self, section, text, ids, *, title=None):
        text = _display_prose(text)
        if not text:
            return
        content = text.split(" — ", 1)[1] if " — " in text else text
        key = re.sub(r"\W+", " ", content).casefold().strip()
        if key in self.paragraphs:
            prior, prior_section = self.paragraphs[key]
            for cid in ids:
                if cid not in prior["citationIds"]:
                    prior["citationIds"].append(cid)
            self.cite(prior_section, ids)
            return
        block = {"type": "paragraph", "text": text, "citationIds": list(ids)}
        if title and text.startswith(f"{title} — "):
            block["title"] = title
        section["blocks"].append(block)
        self.paragraphs[key] = (block, section)
        self.cite(section, ids)

    def table(self, section, columns, rows):
        if rows:
            section["blocks"].append({"type": "table", "columns": columns, "rows": rows})
            self.cite(section, [cid for row in rows for cid in row["citationIds"]])
            if columns[:2] == ["Ticker", "Security"]:
                self.security_tickers.update(row["cells"][0] for row in rows if row["cells"][0] != "—")


def _row(cells, ids):
    return {"cells": [str(value) for value in cells], "citationIds": list(ids)}


def _prose(report, section, snapshot, cid, skip=()):
    for title, body in _article_sections(snapshot):
        normalized = title.lower()
        if normalized in {*POSITION_HEADINGS, *skip}:
            continue
        paragraphs = _paragraphs(body)
        # Source levels have their own de-duplicated table, not another long
        # prose list copied out of the email.
        if normalized == "our levels":
            continue
        sector = None
        for index, paragraph in enumerate(paragraphs):
            if SIDE_LINE.match(paragraph):
                continue
            if re.match(r"^FAFO\b", paragraph, re.I):
                continue
            # Sector label lines carry a presenter and replay time, not research.
            # Keep the sector with its first substantive paragraph instead.
            speaker = re.fullmatch(r"([^:\n]+):\s*[^\n]+\s[-–]\s\d{1,2}:\d{2}:\d{2}", paragraph)
            if speaker:
                sector = speaker.group(1).strip()
                continue
            if re.match(r"^(?:Portfolio Manager|Managing Director|Senior Analyst|Research Analyst),?\s*(?:at\s+)?Hedgeye", paragraph, re.I):
                continue
            if normalized == "the big picture" and not re.search(
                r"\b(?:market\w*|invest\w*|liquid\w*|inflation\w*|growth|rate\w*|price\w*|fiscal|"
                r"credit|debt|revenue|earning\w*|valuation\w*|volatil\w*|stock\w*|bond\w*|"
                r"equity|equities|econom\w*|quad|trade\w*|trend\w*|portfolio|supply|demand|"
                r"currency|dollar|oil|commodity|commodities)\b|\d", paragraph, re.I
            ):
                # Early Look often opens with a proverb or literary introduction.
                # Preserve the economic substance, not that publisher preamble.
                continue
            prefix = []
            if sector:
                prefix.append(sector)
                paragraph = f"{sector} — {paragraph}"
                sector = None
            if index == 0 and title:
                prefix.insert(0, title.title())
                paragraph = f"{title.title()} — {paragraph}"
            report.paragraph(section, paragraph, [cid], title=" — ".join(prefix) or None)


def _positions(report, section, snapshot, previous, cid, prior_cid):
    current = _position_groups(snapshot)
    if not current:
        return
    identities = _published_security_identities(snapshot)
    rows = [_row([*report.security({"name": value}, _symbol(value), identities), side], [cid])
            for side, values in current.items() for value in values]
    report.table(section, ["Ticker", "Security", "Positioning"], rows)
    prior = _position_groups(previous) if previous else None
    if not prior:
        return
    now = {_symbol(value): (side, value) for side, values in current.items() for value in values}
    before = {_symbol(value): (side, value) for side, values in prior.items() for value in values}
    changes = []
    prior_identities = _published_security_identities(previous)
    for symbol, (side, value) in now.items():
        old = before.get(symbol)
        if old and old[0] != side:
            changes.append(_row([*report.security({"name": value}, symbol, identities), f"{old[0]} → {side}"], [prior_cid, cid]))
        elif not old:
            changes.append(_row([*report.security({"name": value}, symbol, identities), f"Added to {side} mentions"], [prior_cid, cid]))
    for symbol, (side, value) in before.items():
        if symbol not in now:
            changes.append(_row([*report.security({"name": value}, symbol, prior_identities), f"No longer listed {side}"], [prior_cid, cid]))
    report.table(section, ["Ticker", "Security", "Research positioning change"], changes)


def _outbucket_rows(report, snapshot, cid):
    rows = []
    identities = _published_security_identities(snapshot)
    raw = snapshot.get("outbucket")
    if isinstance(raw, dict):
        raw = [{"ticker": symbol, **value} for symbol, value in raw.items() if isinstance(value, dict)]
    for value in _list(raw):
        if not isinstance(value, dict):
            continue
        symbol = _text(value.get("ticker") or value.get("symbol"))
        trend = _text(value.get("trend"))
        if symbol and trend:
            rows.append(_row([*report.security(value, symbol, identities), trend.title(), _text(value.get("date") or value.get("since")) or "—"], [cid]))
    seen = {row["cells"][0] for row in rows}
    body = _text(_dict(snapshot.get("article")).get("bodyText"))
    match = re.search(r"(?im)^\s*#OUTBUCKET\s*$", body)
    if match:
        for line in body[match.end():].splitlines():
            match = re.match(r"^\s*.+?\(([A-Z0-9./^-]+)\)\s*=\s*(Bullish|Bearish|Neutral)\s*\((\d{1,2}/\d{1,2}/\d{4})\)", line, re.I)
            if not match:
                continue
            symbol, trend, day = match.groups()
            try:
                day = datetime.strptime(day, "%m/%d/%Y").strftime("%b %-d, %Y")
            except ValueError:
                continue
            if symbol not in seen:
                rows.append(_row([*report.security({}, symbol, identities), trend.title(), day], [cid]))
                seen.add(symbol)
    return rows


def _risk_ranges(report, snapshot, previous, cid, prior_cid):
    section = report.section("risk-ranges", "Trend & range changes")
    current = _range_rows(snapshot)
    prior = _range_rows(previous) if previous else {}
    identities = _published_security_identities(snapshot)
    prior_identities = _published_security_identities(previous) if previous else {}
    trends, bounds, coverage = [], [], []
    explicit = {}
    for change in _list(snapshot.get("trendChanges")):
        if not isinstance(change, dict):
            continue
        symbol = _symbol(change.get("ticker") or change.get("symbol"))
        old, new = _text(change.get("oldTrend")), _text(change.get("newTrend"))
        if symbol and old and new and old.upper() != new.upper():
            explicit[symbol] = (old.title(), new.title(), _text(change.get("note")))
    for symbol, row in current.items():
        old = prior.get(symbol)
        security = report.security(row, symbol, identities)
        trend = _text(row.get("trend")).title()
        old_trend = _text(old.get("trend")).title() if old else ""
        if symbol in explicit:
            start, end, _ = explicit.pop(symbol)
            trends.append(_row([*security, start, end], [cid]))
        elif old_trend and trend and old_trend != trend:
            trends.append(_row([*security, old_trend, trend], [prior_cid, cid]))
        if old and (_number(old.get("lrr")), _number(old.get("hrr"))) != (_number(row.get("lrr")), _number(row.get("hrr"))):
            bounds.append(_row([*security, f"{_num(old.get('lrr'))}–{_num(old.get('hrr'))}",
                                f"{_num(row.get('lrr'))}–{_num(row.get('hrr'))}",
                                _range_boundary_change(old.get("lrr"), row.get("lrr"), "low"),
                                _range_boundary_change(old.get("hrr"), row.get("hrr"), "high"),
                                trend or "—"], [prior_cid, cid]))
        elif prior and not old:
            coverage.append(_row([*security, "+ Risk Ranges"], [prior_cid, cid]))
        report.levels[(_level_identity(row, symbol), _number(row.get("lrr")), _number(row.get("hrr")), trend.upper())] = cid
    for symbol, (old, new, _) in explicit.items():
        trends.append(_row([*report.security({}, symbol, identities), old, new], [cid]))
    # Explicit coverage text distinguishes movement to OutBucket from deletion.
    body = _text(_dict(snapshot.get("article")).get("bodyText"))
    statements = re.findall(r"(?m)^\s*([A-Z0-9./^-]+)\s+(was added to|moved to|was removed from)\s+(?:the\s+)?(#OutBucket|Risk Ranges)[^\n]*", body)
    explicit_symbols = set()
    for symbol, action, product in statements:
        explicit_symbols.add(symbol)
        security = report.security(current.get(symbol) or prior.get(symbol) or {}, symbol,
                                   {**prior_identities, **identities})
        coverage = [row for row in coverage if row["cells"][:2] != security]
        change = f"{'-' if action == 'was removed from' else '+'} {product.lstrip('#')}"
        coverage.append(_row([*security, change], [cid]))
    for symbol in prior:
        if symbol not in current and symbol not in explicit_symbols:
            coverage.append(_row([*report.security(prior[symbol], symbol, prior_identities), "- Risk Ranges"], [prior_cid, cid]))
    report.table(section, ["Ticker", "Security", "Prior Trend", "Trend"], trends)
    report.table(section, ["Ticker", "Security", "Prior range", "Published range", "LOW", "HIGH", "Trend"], bounds)
    report.table(section, ["Ticker", "Security", "Coverage change"], coverage)
    # With no comparison, provide the dated published levels, never invent a
    # change or call an initial reading an alert.
    if not prior and current:
        report.table(section, ["Ticker", "Security", "Published range", "Trend"], [
            _row([*report.security(row, symbol, identities), f"{_num(row.get('lrr'))}–{_num(row.get('hrr'))}", _text(row.get("trend")).title() or "—"], [cid])
            for symbol, row in current.items()])
    report.table(section, ["Ticker", "Security", "OutBucket Trend", "Since"], _outbucket_rows(report, snapshot, cid))


def _early_levels(report, section, snapshot, cid):
    rows = []
    identities = _published_security_identities(snapshot)
    for symbol, row in _range_rows(snapshot).items():
        key = (_level_identity(row, symbol), _number(row.get("lrr")), _number(row.get("hrr")), _text(row.get("trend")).upper())
        if key in report.levels:
            # The value is already attributed in the Risk Ranges section. Do not
            # repeat the entire level roster in Early Look.
            continue
        rows.append(_row([*report.security(row, symbol, identities), f"{_num(row.get('lrr'))}–{_num(row.get('hrr'))}",
                          _text(row.get("trend")).title() or "—"], [cid]))
        report.levels[key] = cid
    report.table(section, ["Ticker", "Security", "Published range", "Trend"], rows)


def _signal_strength(report, snapshot, cid):
    section = report.section("signal-strength", "Signal Strength")
    data, meta = _dict(snapshot.get("data")), _dict(snapshot.get("meta"))
    identities = _published_security_identities(snapshot)
    changes = []
    for label, key in (("Added", "added"), ("Removed", "removed")):
        values = [_text(value) for value in _list(data.get(key)) if isinstance(value, str) and _text(value)]
        changes.extend(_row([*report.security({"name": value}, _symbol(value), identities), label], [cid]) for value in values)
    report.table(section, ["Ticker", "Security", "Change"], changes)
    stocks = [stock for stock in _list(data.get("stocks")) if isinstance(stock, (str, dict))]
    count = _number(meta.get("stockCount", data.get("stockCount")))
    unique = {_text(stock.get("ticker") or stock.get("symbol")) if isinstance(stock, dict) else _text(stock) for stock in stocks}
    complete = bool(stocks) and "" not in unique and len(unique) == len(stocks) and (
        data.get("membershipComplete") is True or meta.get("membershipComplete") is True
        or (count is not None and count > 0 and len(stocks) == count))
    if complete:
        rows = []
        for stock in stocks:
            stock = stock if isinstance(stock, dict) else {"ticker": stock}
            days = next((stock.get(key) for key in ("daysOn", "days_on", "days") if stock.get(key) is not None), None)
            change = next((stock.get(key) for key in ("percentChangeSinceSignal", "percent_change_since_signal", "percentSinceSignal", "signalReturn", "percentChange") if stock.get(key) is not None), None)
            rows.append(_row([*report.security(stock, _symbol(stock.get("ticker") or stock.get("symbol")), identities), _num(days),
                              f"{_num(change)}%" if _number(change) is not None else "—"], [cid]))
        report.table(section, ["Ticker", "Security", "Days on", "Since signal"], rows)


def _market_structure(report, snapshot, cid):
    section = report.section("market-structure", "Market structure & flows")
    data = _dict(snapshot.get("data"))
    rows = [_row([signal.get("label") or signal.get("name"), signal.get("value")], [cid])
            for signal in _list(data.get("signals")) if isinstance(signal, dict)
            and evidence_safe(signal)
            and _text(signal.get("label") or signal.get("name")) and _text(signal.get("value"))]
    readings = metric_rows(snapshot, cid)
    article = _dict(snapshot.get("article"))
    narrative_source = {**snapshot, "article": {**article, "bodyText": _clean_lines(article.get("bodyText"))},
        "data": {**data, "blocks": [{**block, "text": _clean_lines(block.get("text"))}
            for block in _list(data.get("blocks")) if isinstance(block, dict) and evidence_safe(block)]}}
    narrative = narrative_blocks(narrative_source)
    if not rows and not readings and not narrative:
        return
    day = _date(snapshot.get("date"))
    if day:
        published = datetime.strptime(day, "%Y-%m-%d")
        date_label = f"Published {published:%b} {published.day}, {published.year}"
        reading_dates = {row["cells"][2] for row in readings}
        if len(reading_dates) == 1:
            date_label += f" · Data as of {next(iter(reading_dates))}"
        report.paragraph(section, date_label, [cid])
    report.table(section, ["Published signal", "Reading"], rows)
    report.table(section, ["SPX metric", "Reading", "Data as of"], readings)
    for block in narrative:
        report.paragraph(section, block["text"], [cid], title=block.get("title"))


def accepted_snapshots(evidence: dict[str, Any], *, as_of=None) -> dict[str, Any]:
    """Return canonical-product publications available at the evidence cutoff."""
    evidence = _dict(evidence)
    day = _date(evidence.get("date"))
    cutoff = _datetime(as_of) if as_of is not None else datetime.now(timezone.utc)
    if not day or cutoff is None:
        return {}
    snapshots = {ALIASES.get(key, key): value for key, value in _dict(evidence.get("snapshots")).items()}
    if evidence.get("marketStructure"):
        snapshots["market-structure"] = evidence["marketStructure"]
    accepted = {product: {**snapshot, "snapshotType": product} for product, snapshot in snapshots.items()
                if product in PRODUCTS and product not in CAPTURE_SELECTION and _eligible(snapshot, day, cutoff)}
    previous = {ALIASES.get(key, key): value for key, value in _dict(evidence.get("previousSnapshots")).items()}
    for product, policy in CAPTURE_SELECTION.items():
        if policy != "latest-captured-publication":
            continue
        candidates = []
        for snapshot in (snapshots.get(product), previous.get(product)):
            declared = _dict(snapshot).get("snapshotType")
            if (_eligible(snapshot, day, cutoff)
                    and (declared is None or (isinstance(declared, str) and ALIASES.get(declared, declared) == product))):
                candidates.append(snapshot)
        if candidates:
            def order(snapshot):
                instant = publication_time(snapshot)
                return (_date(snapshot.get("date") or _dict(snapshot.get("meta")).get("date")),
                        instant.isoformat() if instant else "")
            selected = max(candidates, key=order)
            accepted[product] = {**selected, "date": selected.get("date") or _dict(selected.get("meta")).get("date"),
                                 "snapshotType": product}
    return accepted


def build_daily_research_rollup(evidence: dict[str, Any], *, as_of=None, holdings=None) -> dict[str, Any]:
    """Build a reproducible research rollup at a review's evidence cutoff.

    ``holdings`` is intentionally not used to infer security mappings, exposure,
    market quotes, or trade recommendations. Portfolio calculations belong to
    the separately verified portfolio projection.
    """
    evidence = _dict(evidence)
    day = _date(evidence.get("date"))
    cutoff = _datetime(as_of) if as_of is not None else datetime.now(timezone.utc)
    if not day or cutoff is None:
        return {"version": 1, "sections": [], "citations": [], "securityTickers": []}
    snapshots = accepted_snapshots(evidence, as_of=cutoff)
    previous = {ALIASES.get(key, key): value for key, value in _dict(evidence.get("previousSnapshots")).items()}
    previous = {product: {**snapshot, "snapshotType": product} for product, snapshot in previous.items()
                if product in snapshots and _eligible(snapshot, day, cutoff)
                and _text(snapshot.get("date")) < _text(snapshots[product].get("date"))}
    report = _Report([*previous.values(), *snapshots.values()])
    citations = {product: report.source(snapshot, product) for product, snapshot in snapshots.items()}
    prior_citations = {product: report.source(snapshot, product) for product, snapshot in previous.items()}
    if snapshot := snapshots.get("top-3-things"):
        cid = citations["top-3-things"]
        section = report.section("market-drivers", "Today's market drivers")
        data = _dict(snapshot.get("data"))
        for paragraph in _paragraphs(data.get("intro")):
            report.paragraph(section, paragraph, [cid])
        items = sorted([item for item in _list(data.get("items")) if isinstance(item, dict)],
                       key=lambda item: _number(item.get("rank")) or 999)
        for item in items:
            paragraphs = _paragraphs(item.get("body") or item.get("summary") or item.get("text"))
            for index, paragraph in enumerate(paragraphs):
                title = _text(item.get("title") or item.get("label"))
                report.paragraph(section, f"{title} — {paragraph}" if index == 0 and title else paragraph, [cid],
                                 title=title if index == 0 else None)
    hedgai_section, hedgai_sources = portfolio_hedgai_section(evidence.get("hedgai"), as_of=cutoff.isoformat())
    if hedgai_section:
        report.sections.append(hedgai_section)
        report.citations.update({source["id"]: source for source in hedgai_sources})
        report.security_tickers.update(row.get("ticker") for row in _dict(_dict(evidence.get("hedgai")).get("book")).get("rows") or []
                                       if isinstance(row, dict) and row.get("ticker"))
    # Process levels before Early Look so identical published ranges appear once.
    if snapshot := snapshots.get("risk-ranges"):
        _risk_ranges(report, snapshot, previous.get("risk-ranges"), citations["risk-ranges"], prior_citations.get("risk-ranges"))
    if snapshot := snapshots.get("early-look"):
        section = report.section("macro-regime", "Macro & regime")
        cid = citations["early-look"]
        _prose(report, section, snapshot, cid)
        _early_levels(report, section, snapshot, cid)
    for product, identity, title in (("the-macro-show", "macro-show", "Macro Show"),
                                     ("the-call", "company-catalysts", "Company catalysts & sector research")):
        if snapshot := snapshots.get(product):
            section = report.section(identity, title)
            cid = citations[product]
            _prose(report, section, snapshot, cid)
            _positions(report, section, snapshot, previous.get(product), cid, prior_citations.get(product))
    if snapshot := snapshots.get("signal-strength"):
        _signal_strength(report, snapshot, citations["signal-strength"])
    if snapshot := snapshots.get("market-structure"):
        _market_structure(report, snapshot, citations["market-structure"])
    sections = [section for section in report.sections if section["blocks"]]
    used = {cid for section in sections for cid in section["citationIds"]}
    return {"version": 1, "sections": sections, "securityTickers": sorted(report.security_tickers),
            "citations": [citation for cid, citation in report.citations.items() if cid in used]}
