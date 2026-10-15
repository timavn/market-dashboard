"""Source-only research beside each prediction market's independent live evidence.

Reuse the Portfolio Review projection, retaining only explicit asset mentions.
Tracker tables and CPI scenarios remain dated research: no spot prices, implied
odds, signal agreement, or contract recommendations are inferred here.
"""

from copy import deepcopy
from datetime import datetime, timezone
from hashlib import sha256
import json
import re
from hedgai_review import prediction_hedgai_readings

from daily_research_rollup import (
    PRODUCTS as DAILY_PRODUCTS, ALIASES, accepted_snapshots,
    build_daily_research_rollup, publication_time,
    _article_sections, _clean_lines, _date, _datetime, _dict, _display_prose,
    _eligible, _num, _number, _paragraphs, _source_uri, _text,
)

PRODUCTS = {**DAILY_PRODUCTS, "bitcoin-trend-tracker": "Bitcoin Tracker",
            "crypto-quant": "Crypto Quant", "inflation-nowcast": "Monthly Inflation Nowcast"}
# These patterns select source passages; they never establish instrument
# equivalence or transfer a proxy's signals/ranges to its underlying.
MENTIONS = {
    "cpi": r"\b(?:CPI|consumer pric\w*|inflation\w*|disinflation\w*|nowcast\w*)\b",
    "sp500": r"\b(?:S&P\s*500|SPX|SPY|S&P|U\.S\. equit\w*)\b",
    "nasdaq100": r"\b(?:Nasdaq(?:[ -]100)?|NDX|NQ|QQQ|COMPQ)\b",
    "gold": r"\b(?:gold|XAU(?:USD)?|GLD|IAU)\b",
    "silver": r"\b(?:silver|XAG(?:USD)?|SLV|SIVR)\b",
    "bitcoin": r"\b(?:bitcoin|BTC(?:USD)?|IBIT)\b|₿TC",
    "ethereum": r"\b(?:ethereum|ether|ETH(?:USD)?|ETHA)\b",
}
PATTERNS = {market: re.compile(pattern, re.I) for market, pattern in MENTIONS.items()}
CRYPTO_PRODUCTS = {"bitcoin-trend-tracker", "crypto-quant"}


def prediction_research_section_excluded(section):
    identities = {re.sub(r"[^a-z0-9]+", "-", str(section.get(key) or "").lower().replace("'", "").replace("’", "")).strip("-")
                  for key in ("id", "title")}
    return bool(identities & {"macro-regime", "macro-and-regime", "macro-show", "the-macro-show",
                              "market-drivers", "todays-market-drivers", "today-s-market-drivers", "hedgai-signals"})


def prediction_publication_identity(product, snapshot):
    """Resolve the documented legacy storage alias without changing authority."""
    snapshot = _dict(snapshot)
    if product not in CRYPTO_PRODUCTS:
        return product, snapshot
    declared = snapshot.get("reportType")
    if declared and declared not in CRYPTO_PRODUCTS:
        return None, {}
    actual = declared or product
    if product == "crypto-quant" and actual != product:
        return None, {}
    return actual, {**snapshot, "snapshotType": actual,
                    **({"storageSnapshotType": product} if actual != product else {})}


def prediction_publication_order(snapshot):
    published = publication_time(snapshot)
    return (snapshot.get("date") or _dict(snapshot.get("meta")).get("date") or "",
            published.isoformat() if published else "")


def accepted_prediction_snapshots(evidence, *, as_of=None):
    """Use the latest verified publication inside this review's own capture.

    The daily archive keeps today's edition separate from previous editions.
    Before a product publishes today, its captured prior edition is still the
    latest research; selecting it must not renew its date or fetch newer data.
    """
    evidence = _dict(evidence)
    day = _date(evidence.get("date"))
    cutoff = _datetime(as_of) if as_of is not None else datetime.now(timezone.utc)
    if not day or cutoff is None:
        return {}
    result = {}
    for candidates in (_dict(evidence.get("previousSnapshots")), _dict(evidence.get("snapshots"))):
        for product, snapshot in candidates.items():
            product = ALIASES.get(product, product)
            declared = _dict(snapshot).get("snapshotType")
            if (product not in PRODUCTS or not _eligible(snapshot, day, cutoff)
                    or (declared and ALIASES.get(declared, declared) != product)):
                continue
            product, snapshot = prediction_publication_identity(product, snapshot)
            if product and (product not in result or prediction_publication_order(snapshot) >= prediction_publication_order(result[product])):
                result[product] = {**snapshot, "date": snapshot.get("date") or _dict(snapshot.get("meta")).get("date"), "snapshotType": product}
    # The separate structure endpoint belongs to the requested market session.
    # Keep its existing exact-session selection instead of mixing observations.
    structure = accepted_snapshots({"date": day, "marketStructure": evidence.get("marketStructure")}, as_of=cutoff)
    result.update(structure)
    return result


def _citation(snapshot, product):
    day = snapshot["date"]
    article = _dict(snapshot.get("article"))
    uri = _source_uri(snapshot, product)
    document = sha256(json.dumps([product, day, uri], ensure_ascii=False).encode()).hexdigest()[:32]
    excerpt = _clean_lines(article.get("bodyText") or article.get("summary"))
    # Parsed tables are source evidence even when the original email is images.
    if product in CRYPTO_PRODUCTS:
        rows = _dict(_dict(snapshot.get("data")).get("cryptos"))
        published_rows = []
        for symbol in ("BTC", "ETH"):
            row = _dict(rows.get(symbol))
            if row:
                fields = [f"{label}: {_text(row[key])}" for key, label in (
                    ("trade" if product == "bitcoin-trend-tracker" and row.get("trade") else "trend", "Published reading"),
                    ("buyTrade" if "buyTrade" in row else "lrr", "Published lower range"),
                    ("sellTrade" if "sellTrade" in row else "hrr", "Published upper range")) if row.get(key) is not None]
                published_rows.append(f"{symbol} — " + "; ".join(fields))
        excerpt += "\n\n" + "\n".join(published_rows)
    cid = sha256((document + excerpt).encode()).hexdigest()[:32]
    citation = {"id": f"cite_{cid}", "documentId": f"doc_{document}", "product": product,
                "productLabel": PRODUCTS[product], "publicationDate": day, "sourceUri": uri,
                "title": _text(article.get("headline")) or PRODUCTS[product], "excerpt": excerpt.strip()}
    if published := publication_time(snapshot):
        citation["publishedAt"] = published.isoformat()
    return citation


def _ids(blocks):
    return list(dict.fromkeys(cid for block in blocks for cid in (
        block.get("citationIds", []) + [cid for row in block.get("rows", []) for cid in row.get("citationIds", [])])))


def _filtered_table(block, pattern):
    columns = block.get("columns") or []
    if not columns:
        return None
    # LOW/HIGH are Portfolio Review comparison columns. Keep prediction-market
    # research in its existing compact range/Trend format.
    if "Prior range" in columns and "Published range" in columns:
        keep = [index for index, column in enumerate(columns) if column not in {"LOW", "HIGH"}]
        block = {**block, "columns": [columns[index] for index in keep], "rows": [
            {**row, "cells": [row["cells"][index] if index < len(row.get("cells") or []) else "—"
                              for index in keep]}
            for row in block.get("rows") or []]}
        columns = block["columns"]
    # Position lists are bounded publisher lists, not the user's book. Filter
    # the individual entries so an asset mention doesn't import the full book.
    security_column = 1 if columns[0] in {"Positioning", "Change"} else 0
    rows = []
    for row in block.get("rows") or []:
        cells = list(row.get("cells") or [])
        if len(cells) <= security_column:
            continue
        if columns[:2] == ["Ticker", "Security"]:
            if any(pattern.search(str(value)) for value in cells[:2]):
                rows.append({**row, "cells": cells})
            continue
        entries = [entry.strip() for entry in cells[security_column].split(",")]
        matches = [entry for entry in entries if pattern.search(entry)]
        if not matches:
            continue
        cells[security_column] = ", ".join(matches)
        rows.append({**row, "cells": cells})
    return {**block, "rows": rows} if rows else None


def _append(markets, market_id, identity, title, blocks):
    if not blocks:
        return
    section = {"id": identity, "title": title, "blocks": blocks, "citationIds": _ids(blocks)}
    markets[market_id]["sections"].append(section)
    markets[market_id]["citationIds"] = list(dict.fromkeys(
        markets[market_id]["citationIds"] + section["citationIds"]))


def _tracker_blocks(snapshot, previous, symbol, cid, prior_cid, *, product="bitcoin-trend-tracker"):
    current = _dict(_dict(_dict(snapshot.get("data")).get("cryptos")).get(symbol))
    prior = _dict(_dict(_dict(_dict(previous).get("data")).get("cryptos")).get(symbol))
    def valid(row):
        return bool(row) and not any(row.get(key) is True for key in (
            "mock", "isMock", "seed", "seeded", "synthetic", "inferred", "fallback", "refreshFailed"
        )) and not re.search(r"mock|seed|synthetic|inferred|fallback", str(row.get("source") or ""), re.I)

    if not valid(current):
        return []
    if not valid(prior):
        prior, prior_cid = {}, None
    # The tracker importer historically stores its published direction in
    # `trend`; keep the neutral label Tracker reading rather than assigning it
    # as a second independent Trend or inferring a Trade/Trend agreement.
    tracker = product == "bitcoin-trend-tracker"
    reading_label = "Tracker reading" if tracker else "Crypto Quant reading"
    range_label = "Published tracker range" if tracker else "Published Crypto Quant range"
    direction = _text((current.get("trade") if tracker else None) or current.get("trend")).upper()
    low = _number(current.get("buyTrade", current.get("lrr")))
    high = _number(current.get("sellTrade", current.get("hrr")))
    rows = []
    if direction in {"BULLISH", "BEARISH", "NEUTRAL"}:
        rows.append({"cells": [reading_label, direction.title()], "citationIds": [cid]})
    if low is not None and high is not None and 0 < low < high:
        rows.append({"cells": [range_label, f"{_num(low)}–{_num(high)}"], "citationIds": [cid]})
    blocks = [{"type": "table", "columns": ["Research", "Published reading"], "rows": rows}] if rows else []
    before_direction = _text((prior.get("trade") if tracker else None) or prior.get("trend")).upper()
    before_low = _number(prior.get("buyTrade", prior.get("lrr")))
    before_high = _number(prior.get("sellTrade", prior.get("hrr")))
    changes = []
    if prior_cid and direction in {"BULLISH", "BEARISH", "NEUTRAL"} and before_direction in {"BULLISH", "BEARISH", "NEUTRAL"} and direction != before_direction:
        changes.append(f"{reading_label}: {before_direction.title()} → {direction.title()}.")
    if (prior_cid and None not in (before_low, before_high, low, high)
            and 0 < before_low < before_high and 0 < low < high and (before_low, before_high) != (low, high)):
        changes.append(f"{range_label}: {_num(before_low)}–{_num(before_high)} → {_num(low)}–{_num(high)}.")
    if changes:
        blocks.append({"type": "paragraph", "text": " ".join(changes), "citationIds": [prior_cid, cid]})
    return blocks


def build_prediction_research_rollup(evidence, *, as_of=None, prediction_evidence=None, prediction_as_of=None):
    from alpha_codes import captured_alpha_codes

    snapshots = accepted_prediction_snapshots(evidence, as_of=as_of)
    markets = {market_id: {"sections": [], "citationIds": []} for market_id in MENTIONS}
    daily = build_daily_research_rollup({**_dict(evidence), "snapshots": snapshots}, as_of=as_of)
    citations = {citation["id"]: citation for citation in daily["citations"]}
    hedgai, hedgai_sources = prediction_hedgai_readings(_dict(evidence).get("hedgai"), as_of=as_of)
    citations.update({source["id"]: source for source in hedgai_sources})
    for market_id, reading in hedgai.items():
        if market_id in markets:
            markets[market_id]["hedgai"] = reading
            markets[market_id]["citationIds"].extend(reading["citationIds"])
    for market_id, pattern in PATTERNS.items():
        paragraph_count = 0
        for section in daily["sections"]:
            if prediction_research_section_excluded(section):
                continue
            if section["id"] == "market-structure" and market_id == "sp500":
                from prediction_structure_review import structure_blocks

                raw_markets = _dict(_dict(prediction_evidence).get("data")).get("markets") or []
                matches = [row for row in raw_markets if isinstance(row, dict) and row.get("marketId") == "sp500"]
                monitor = _dict(matches[0].get("snapshot")) if len(matches) == 1 else {}
                from prediction_review import _manager_market_safe
                if not _manager_market_safe(prediction_evidence, matches[0] if len(matches) == 1 else {}, monitor):
                    monitor = {}
                cid = next(iter(section.get("citationIds") or []), None)
                blocks, added_citations = structure_blocks(
                    snapshots.get("market-structure") or {}, monitor, cid,
                    as_of=prediction_as_of or as_of, market_date=_dict(evidence).get("date"),
                    market_volume=_dict(evidence).get("marketVolume"),
                )
                citations.update({source["id"]: source for source in added_citations})
                _append(markets, market_id, section["id"], section["title"], blocks)
                continue
            blocks = []
            for block in section["blocks"]:
                if block["type"] == "paragraph" and pattern.search(block["text"]) and paragraph_count < 6:
                    blocks.append(deepcopy(block))
                    paragraph_count += 1
                elif block["type"] == "table":
                    filtered = _filtered_table(block, pattern)
                    if filtered:
                        blocks.append(filtered)
            _append(markets, market_id, section["id"], section["title"], blocks)

    for product in ("bitcoin-trend-tracker", "crypto-quant", "inflation-nowcast"):
        snapshot = snapshots.get(product)
        if not snapshot:
            continue
        citation = _citation(snapshot, product)
        cid = citation["id"]
        citations[cid] = citation
        prior = accepted_prediction_snapshots({"date": _dict(evidence).get("date"), "snapshots":
            _dict(_dict(evidence).get("previousSnapshots"))}, as_of=as_of).get(product)
        prior_cid = None
        if prior and prior["date"] < snapshot["date"]:
            prior_citation = _citation(prior, product)
            prior_cid = prior_citation["id"]
            citations[prior_cid] = prior_citation
        else:
            prior = None
        selected_markets = ("cpi",) if product == "inflation-nowcast" else ("bitcoin", "ethereum")
        for market_id in selected_markets:
            blocks = _tracker_blocks(snapshot, prior, "BTC" if market_id == "bitcoin" else "ETH", cid, prior_cid, product=product) if product in CRYPTO_PRODUCTS else []
            for _title, body in _article_sections(snapshot):
                for paragraph in _paragraphs(body):
                    if PATTERNS[market_id].search(paragraph) and len([b for b in blocks if b["type"] == "paragraph"]) < 3:
                        text = _display_prose(paragraph)
                        if text and not re.search(r"risk range calculations and market data reflect|performance in title is calculated", text, re.I):
                            blocks.append({"type": "paragraph", "text": text, "citationIds": [cid]})
            # CPI forecast numbers already live in the release-matched manager
            # comparison. This layer adds prose only, not a second unmatched model.
            _append(markets, market_id, product, PRODUCTS[product], blocks)
    alpha = captured_alpha_codes(evidence, as_of=as_of)
    alpha_citations = {row["id"]: row for row in alpha.get("citations", []) if isinstance(row, dict) and row.get("id")}
    for market_id, code in _dict(alpha.get("codes")).items():
        if market_id not in markets or not isinstance(code, dict):
            continue
        cited = [cid for cid in code.get("citationIds", []) if cid in alpha_citations]
        if not cited:
            continue
        markets[market_id]["alphaCode"] = deepcopy(code)
        markets[market_id]["citationIds"] = list(dict.fromkeys(markets[market_id]["citationIds"] + cited))
        citations.update({cid: alpha_citations[cid] for cid in cited})
    used = {cid for market in markets.values() for cid in market["citationIds"]}
    return {"version": 1, "markets": markets,
            "citations": [citation for cid, citation in citations.items() if cid in used]}
