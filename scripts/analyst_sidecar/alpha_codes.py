"""Retained, cited Trade/Trend price thresholds from dated research publications.

No quote or directional signal is derived here. A complete, explicitly ordered
pair replaces a prior pair; isolated levels, risk ranges and ETF proxies do not.
"""
from collections import defaultdict
from copy import deepcopy
from hashlib import sha256
import json
import math
from pathlib import Path
import re
from zoneinfo import ZoneInfo

from daily_research_rollup import _date, _datetime, _dict, _eligible, _source_uri, publication_time

CATALOG = json.loads(Path(__file__).with_name("prediction_alpha_assets.json").read_text())
ALIASES = {alias.casefold(): key for key, spec in CATALOG.items() for alias in spec["aliases"]}
INSTRUMENT = re.compile(r"(?<![\w])(?:" + "|".join(re.escape(alias) for alias in sorted(ALIASES, key=len, reverse=True)) + r")(?![\w])", re.I)
NUMBER = r"(?<![\w.,])\$?\s*(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?\s*[kKmM]?(?![\w]|[.,]\d)"
# Tight connectors prevent ordinary prose, buy/sell Trade ranges and dates from
# being mistaken for price thresholds. Support both source label orders.
AFTER = re.compile(r"\b(?P<label>TRADE|TREND)\b(?:\s+(?:Signal|Support|Supports|Level|Levels|threshold|is|at|of|was|cited|around|approximately|roughly))*\s*[:=]?\s*(?P<number>" + NUMBER + r")", re.I)
BEFORE = re.compile(r"(?P<number>" + NUMBER + r")(?:\s+(?:representing|for|is|the|at|on))*\s+(?P<label>TRADE|TREND)\b", re.I)
RESPECTIVELY = re.compile(r"\b(?P<first>TRADE|TREND)\s+and\s+(?P<second>TRADE|TREND)\b[^\d.!?]{0,100}(?P<a>" + NUMBER + r")\s+and\s+(?P<b>" + NUMBER + r"),?\s+respectively\b", re.I)
SLASH = re.compile(r"(?P<a>" + NUMBER + r")\s*/\s*(?P<b>" + NUMBER + r")")
ALPHA = re.compile(r"\balpha\s+codes?\b", re.I)
ORDER = re.compile(r"\bTRADE\s+first\s*,?\s*(?:and\s+)?(?:then\s+)?TREND\b", re.I)
HISTORICAL = re.compile(r"\b(?:previous|prior|former|old|last\s+(?:week|month|year))\b", re.I)
HYPOTHETICAL = re.compile(r"\bhypothetical(?:ly)?\b", re.I)
BAD_KEYS = ("mock", "isMock", "seed", "seeded", "synthetic", "inferred", "modelOnly", "fallback", "refreshFailed")


def _normalize(text):
    return re.sub(r"[ \t\u00a0]+", " ", str(text or "").replace("\\r", "").replace("\\n", "\n").replace("\r", "").replace("’", "'"))


def _number(text):
    token = re.sub(r"[\s$,]", "", text)
    scale = {"k": 1000, "m": 1000000}.get(token[-1:].lower(), 1)
    if scale != 1:
        token = token[:-1]
    value = float(token) * scale
    return value if math.isfinite(value) and value > 0 else None


def _pair(scope, prefix):
    # Labeled full units take priority over shorthand (e.g. 64/68 expanded as
    # $64,000 Trade and $68,000 Trend). Never split a concatenated integer.
    candidates = []
    for match in RESPECTIVELY.finditer(scope):
        if match['first'].upper() != match['second'].upper():
            candidates.append((match.start(), match.end(), {match['first'].lower(): _number(match['a']), match['second'].lower(): _number(match['b'])}))
    levels = sorted([(m.start(), m.end(), m['label'].lower(), _number(m['number']))
                     for pattern in (AFTER, BEFORE) for m in pattern.finditer(scope)])
    for index, left in enumerate(levels):
        for right in levels[index + 1:]:
            gap = right[0] - left[1]
            if gap >= 110:
                break
            # AFTER and BEFORE can both match the same printed number, e.g.
            # "TRADE 4395\nTREND 4251". A pair needs two disjoint spans; skip
            # the overlap while still considering the next real level.
            if gap < 0 or left[2] == right[2]:
                continue
            between = scope[left[1]:right[0]]
            if not re.search(r"\b(?:risk range|buy|sell|previous|prior|formerly)\b|[!?]", between, re.I):
                candidates.append((left[0], right[1], {left[2]: left[3], right[2]: right[3]}))
    if not candidates:
        for match in SLASH.finditer(scope):
            leading = scope[:match.start()]
            explicit_alpha = ALPHA.search(leading[-100:])
            named_alpha = ALPHA.search(prefix[-100:]) and re.fullmatch(r"[\s:=()\-]*", leading)
            labeled_order = re.search(r"\b(TRADE|TREND)\s*/\s*(TRADE|TREND)\s*[:=]?\s*$", leading, re.I)
            if labeled_order and labeled_order[1].upper() == labeled_order[2].upper():
                labeled_order = None
            roster = ORDER.search(prefix[-1000:]) and ALPHA.search(prefix[-1000:]) and re.fullmatch(r"[\s:=()\-]*", leading)
            # Bare two-digit slash notation can abbreviate thousands. Use only
            # its explicit expansion unless a native currency/unit is printed.
            full_units = all(len(re.sub(r"\D", "", match[key])) >= 3 or re.search(r"[$.kKmM]", match[key]) for key in ("a", "b"))
            if (explicit_alpha or named_alpha or labeled_order or roster) and full_units:
                first, second = (labeled_order[1].lower(), labeled_order[2].lower()) if labeled_order else ("trade", "trend")
                candidates.append((match.start(), match.end(), {first: _number(match['a']), second: _number(match['b'])}))
    eligible = []
    for item in candidates:
        start, end, pair = item
        preceding = scope[max(0, start-60):start]
        # A source can qualify levels after printing them ("... last week").
        # Keep that qualification in the same clause rather than attributing
        # a later sentence's historical commentary to the current pair.
        following = re.split(r"[;!?\n]|\.(?=\s|$)", scope[end:], maxsplit=1)[0][:60]
        if (all(pair.values())
                and not HISTORICAL.search(preceding + " " + following)
                and not HYPOTHETICAL.search(preceding + scope[start:end] + following)
                and not re.search(r"\b(?:BUY|SELL)\s*$", scope[:start], re.I)):
            eligible.append(item)
    values = {(row[2]["trade"], row[2]["trend"]) for row in eligible}
    if len(values) != 1:
        return None
    start, end, pair = eligible[0]
    return {"tradeLevel": pair["trade"], "trendLevel": pair["trend"],
            "approximate": bool(re.search(r"\b(?:approximately|approx|roughly|around)\b|~|≈", scope[max(0, start-30):end], re.I))}


def _document_eligible(document, day, cutoff):
    metadata = _dict(document.get("metadata"))
    containers = (document, metadata, _dict(metadata.get("data")))
    if any(row.get(key) is True for row in containers for key in BAD_KEYS):
        return False
    if any(str(row.get('status') or '').lower() in {'failed', 'error', 'unavailable'} or row.get('error') for row in containers):
        return False
    if str(metadata.get("lifecycleStage") or "").upper() in {"FAILED", "ERROR", "REJECTED", "QUARANTINED"}:
        return False
    if re.search(r"\b(mock|seed(?:ed)?|synthetic|fixture|model-only)\b", str(document.get("sourceUri") or ""), re.I):
        return False
    date = _date(document.get("publicationDate"))
    if not date or date > day or date > cutoff.astimezone(ZoneInfo("America/New_York")).date().isoformat():
        return False
    for value in (document.get("indexedAt"), metadata.get("publishedAt"), metadata.get("observedAt")):
        if value and ((parsed := _datetime(value)) is None or parsed > cutoff):
            return False
    return bool(document.get("sourceUri") and document.get("documentId"))


def scan_alpha_codes(documents, publication_date, *, as_of):
    """Pure all-history scan; its compact result belongs to one immutable capture."""
    cutoff, day = _datetime(as_of), _date(publication_date)
    result = {"version": 1, "asOf": as_of, "marketDate": publication_date, "scannedDocumentCount": 0, "codes": {}, "citations": []}
    if cutoff is None or day is None:
        return result
    candidates = defaultdict(list)
    for document in documents:
        if not _document_eligible(document, day, cutoff):
            continue
        result["scannedDocumentCount"] += 1
        previous = ""
        for chunk in document.get("chunks") or []:
            text = _normalize(chunk.get("excerpt"))
            citation = chunk.get("citation") or {}
            if (not citation.get("id") or any(citation.get(key) != document.get(key)
                    for key in ("documentId", "sourceUri", "publicationDate"))):
                continue
            for paragraph_match in re.finditer(r"[^\n]+(?:\n(?!\n)[^\n]+)*", text):
                paragraph = paragraph_match.group()
                if not re.search(r"alpha|trade|trend", paragraph, re.I) and not SLASH.search(paragraph):
                    continue
                mentions = list(INSTRUMENT.finditer(paragraph))
                for i, mention in enumerate(mentions):
                    market = ALIASES[mention.group().casefold()]
                    if market == "excluded":
                        continue
                    end = next((other.start() for other in mentions[i+1:] if ALIASES[other.group().casefold()] != market), len(paragraph))
                    scope = paragraph[mention.end():end][:800]
                    prefix = previous + text[:paragraph_match.start()] + paragraph[:mention.start()]
                    pair = _pair(scope, prefix)
                    if pair is None:
                        continue
                    meta = _dict(document.get("metadata"))
                    published = _datetime(meta.get("publishedAt"))
                    if published and published.hour == published.minute == published.second == 0:
                        published = None
                    candidates[market].append({**pair, "marketId": market, "instrument": CATALOG[market]["instrument"],
                        "publicationDate": document["publicationDate"], "publishedAt": published.isoformat() if published else None,
                        "citationIds": [citation["id"]], "citation": deepcopy(citation)})
            previous = (previous + text)[-1000:]
    for market, rows in candidates.items():
        # Unknown-time conflicts are not resolved by import order/document ID.
        by_day = defaultdict(list)
        for row in rows:
            by_day[row["publicationDate"]].append(row)
        current = None
        for source_day in sorted(by_day):
            day_rows = by_day[source_day]
            pairs = {(r["tradeLevel"], r["trendLevel"]) for r in day_rows}
            if len(pairs) > 1:
                if not all(r.get("publishedAt") for r in day_rows):
                    current = None
                    continue
                latest = max(r["publishedAt"] for r in day_rows)
                day_rows = [r for r in day_rows if r["publishedAt"] == latest]
                if len({(r["tradeLevel"], r["trendLevel"]) for r in day_rows}) > 1:
                    current = None
                    continue
            row = sorted(day_rows, key=lambda r: r["citationIds"])[0]
            if current and (current["tradeLevel"], current["trendLevel"]) == (row["tradeLevel"], row["trendLevel"]):
                continue
            current = row
        if current:
            citation = current.pop("citation")
            result["codes"][market] = current
            result["citations"].append(citation)
    return result


def captured_alpha_codes(evidence, *, as_of):
    """Read a captured scan, or scan only publications inside an older capture."""
    evidence = _dict(evidence)
    scan = evidence.get("alphaCodes")
    if isinstance(scan, dict):
        captured, cutoff = _datetime(scan.get("asOf")), _datetime(as_of)
        return scan if scan.get("version") == 1 and captured and cutoff and captured <= cutoff else {}
    day, cutoff = _date(evidence.get("date")), _datetime(as_of)
    if not day or not cutoff:
        return {}
    documents = []
    for collection in ("previousSnapshots", "snapshots"):
        for product, snapshot in _dict(evidence.get(collection)).items():
            if not _eligible(snapshot, day, cutoff):
                continue
            article = _dict(snapshot.get("article"))
            text = article.get("bodyText") or article.get("summary") or ""
            uri = _source_uri(snapshot, product)
            published = publication_time(snapshot)
            identity = sha256(json.dumps([product, snapshot.get("date"), uri, text]).encode()).hexdigest()[:32]
            citation = {"id": "cite_alpha_" + identity, "documentId": "doc_alpha_" + identity,
                "product": product, "publicationDate": snapshot.get("date"), "sourceUri": uri,
                "title": article.get("headline") or product, "excerpt": text}
            documents.append({**citation, "metadata": {"publishedAt": published.isoformat() if published else None},
                              "chunks": [{"excerpt": text, "citation": citation}]})
    return scan_alpha_codes(documents, day, as_of=as_of)
