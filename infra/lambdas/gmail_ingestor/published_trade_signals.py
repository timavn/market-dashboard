"""Independent directional Trade evidence; numerical ranges and Trend are separate."""
import json
import re
from pathlib import Path

SUBJECTS = json.loads(Path(__file__).with_name("published_signal_subjects.json").read_text())
BIAS = re.compile(r"^(BULLISH|BEARISH|NEUTRAL)$", re.I)
FORBIDDEN = re.compile(r"\b(?:if|unless|could|would|should|may|might|will|expects?|expected|forecast|assuming|scenario|previously|formerly|historically|prior|not|never|no longer|used to)\b|[?\"“”]", re.I)
VERB = r"(?:(?:is|remains|stays|turned|turns|flipped|flips)(?: now| back)?(?: to)?(?: signaling)? |(?:is )?back to signaling |[:=]\s*)"
TRACKERS = {"momo-tracker", "bitcoin-trend-tracker", "crypto-quant"}
NON_SECURITIES = {"TRADE", "TREND", "BUY", "SELL", "THIS", "THAT", "THESE", "THOSE", "THE", "OUR", "WE", "I", "IT", "ITS", "AND", "FOR", "NEW", "US", "USA", "ETF", "FED", "TODAY", "NOW", "EQUITIES", "SOFTWARE", "COMMODITIES", "MARKET", "MARKETS", "LONG", "SHORT", "BULLISH", "BEARISH", "NEUTRAL"}


def explicit_provenance(value):
    return (isinstance(value, dict) and value.get("field") == "trade"
            and value.get("method") in {"explicit-field", "explicit-statement"}
            and bool(value.get("sourceField")) and bool(value.get("sourceText"))
            and (value.get("method") != "explicit-field" or re.search(r"(?:^|\.)(?:trade|tradeSignal|tradeBias)$", value["sourceField"], re.I)))


def extract_published_trade_signals(snapshot):
    product = snapshot.get("snapshotType") or snapshot.get("reportType")
    result = []

    def add(ticker, value, path, source, method):
        result.append({"ticker": ticker.upper(), "sourceTicker": ticker.upper(), "value": value.upper(),
                       "fieldPath": path, "sourceText": source,
                       "signalProvenance": {"field": "trade", "sourceField": path,
                                            "method": method, "sourceText": source}})

    def walk(value, path="data", key=""):
        if isinstance(value, list):
            for index, row in enumerate(value):
                walk(row, f"{path}[{index}]")
        if not isinstance(value, dict):
            return
        ticker = value.get("sourceTicker") or value.get("ticker") or value.get("symbol") or value.get("asset")
        if not ticker and re.fullmatch(r"[A-Z][A-Z0-9./=^_-]{0,15}", key):
            ticker = key
        if ticker:
            for field in ("trade", "tradeSignal", "tradeBias"):
                if field in value.get("withheldFields", []):
                    continue
                raw = value.get(field)
                direction = raw.get("value") if isinstance(raw, dict) else raw
                if not BIAS.fullmatch(str(direction or "").strip()):
                    continue
                proof = (raw.get("signalProvenance") if isinstance(raw, dict) else None) or value.get("signalProvenance")
                if product in TRACKERS and not explicit_provenance(proof):
                    continue
                proof = proof or {}
                add(ticker, str(direction).strip(), proof.get("sourceField") or f"{path}.{field}",
                    proof.get("sourceText") or f"{ticker}: {field} {direction}", "explicit-field")
        for child_key, child in value.items():
            if child_key not in {"signalProvenance", "sourceQuality", "metadata"}:
                walk(child, f"{path}.{child_key}", child_key)

    walk(snapshot.get("data"))
    article = snapshot.get("article") or {}
    for field in ("bodyText", "summary", "headline"):
        if not re.search(r"\bTRADE\b", str(article.get(field) or ""), re.I):
            continue
        for raw in re.split(r"\r?\n|(?<=[.!?])\s+", str(article.get(field) or "")):
            line = re.sub(r"\s+", " ", re.sub(r"^[•*\-]\s+", "", raw.strip()))
            if not line or len(line) > 900 or FORBIDDEN.search(line) or not re.search(r"\bTRADE\b", line, re.I):
                continue
            claims = {next(value for value in match if value).upper() for match in re.findall(r"\b(BULLISH|BEARISH|NEUTRAL) (?:on )?TRADE\b|\bTRADE(?: signal)?(?:(?: is| remains|:)\s*|\s+)(BULLISH|BEARISH|NEUTRAL)\b", line, re.I)}
            if len(claims) > 1 or re.search(r"\bTRADE\b.*\b(?:versus|last month|last year|last week)\b", line, re.I):
                continue
            candidates = list(SUBJECTS)
            token = re.match(r"^\$?([A-Z][A-Z0-9./=^_-]{0,15})(?=\s|:)", line)
            if token and token.group(1) not in NON_SECURITIES:
                candidates.append({"sourceTicker": token.group(1), "subjectPattern": r"\$?" + re.escape(token.group(1))})
            for entry in candidates:
                subject = entry.get("subjectPattern") or re.escape(entry["subject"])
                prefix = rf"^{subject}(?:\s*[:=]\s*|\s+)" + entry.get("performancePrefixPattern", "")
                verb = entry.get("currentStatementPattern", VERB)
                match = re.search(prefix + rf"(?:{verb})?(BULLISH|BEARISH|NEUTRAL) (?:on )?TRADE\b", line, re.I)
                match = match or re.search(prefix + rf"(?:{VERB})?TRADE(?: signal)?(?:(?: is| remains|:)\s*|\s+)(BULLISH|BEARISH|NEUTRAL)\b", line, re.I)
                if match:
                    add(entry["sourceTicker"], match.group(1), f"article.{field}", line, "explicit-statement")
    issues = (snapshot.get("sourceQuality") or {}).get("issues") or []
    result = [item for item in result if not any(
        str(issue.get("ticker") or "").upper() == item["sourceTicker"]
        and set([issue.get("field"), *issue.get("affectedFields", [])]) & {"trade", "tradeSignal", "tradeBias", "narrative"}
        for issue in issues)]
    return list({(item["ticker"], item["value"], item["fieldPath"], item["sourceText"]): item for item in result}.values())
