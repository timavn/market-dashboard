"""Captured HedgAI publisher research, independent of Trade, Trend and quotes."""

from copy import deepcopy
from datetime import datetime, timezone
from math import isfinite
import json
from pathlib import Path
from zoneinfo import ZoneInfo

import httpx


def _object(value):
    return value if isinstance(value, dict) else {}


def _time(value):
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return parsed.astimezone(timezone.utc) if parsed.tzinfo else None
    except ValueError:
        return None


def _number(value):
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) and isfinite(value) else None


def _date_label(value):
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        if parsed.tzinfo:
            parsed = parsed.astimezone(ZoneInfo("America/New_York"))
        return f"{parsed:%b} {parsed.day}, {parsed.year}"
    except ValueError:
        return "—"


def _publication_label(value):
    # A clock reading is shown in Pacific time, with its own Pacific date;
    # a date-only publication keeps its exchange date.
    parsed = _time(value)
    if not parsed:
        return _date_label(value)
    local = parsed.astimezone(ZoneInfo("America/Los_Angeles"))
    return f"{local:%b} {local.day}, {local.year} {local:%H:%M %Z}"


def _record(row, side):
    metric = _object(_object(row.get("metrics")).get(side))
    signals = metric.get("signals")
    win_loss = metric.get("winLoss")
    return f"{_pct(row, side)} · {signals if signals is not None else '—'} signals · W/L {win_loss if win_loss is not None else '—'}"


def _side_eligible(row, side, threshold=.6):
    batting = _number(_object(_object(row.get("metrics")).get(side)).get("battingAverage"))
    return batting is not None and _number(threshold) is not None and 0 <= threshold <= batting <= 1


def hedgai_contribution(reading):
    position = reading.get("position")
    last_known = reading.get("status") == "last-known"
    if position == "Wait":
        bull, bear = (_side_eligible(reading, side) for side in ("buy", "short"))
        contribution = "Await Buy or Short" if bull and bear else "Await Buy" if bull else "Await Short" if bear else "Neither side qualifies"
        return f"Last known Wait · {contribution}" if last_known else contribution
    side = "buy" if position == "Buy" else "short"
    label = "Long" if position == "Buy" else "Short"
    if not _side_eligible(reading, side):
        return f"{'Last known ' if last_known else ''}{label} excluded"
    return label if reading.get("activeDirection") and not last_known else f"Last known {label}"


def _unsafe(value):
    value = _object(value)
    return any(value.get(key) is True for key in ("mock", "isMock", "seeded", "synthetic", "inferred"))


def accepted_hedgai(value, *, as_of):
    """Validate capture provenance, never grant live-price or execution status."""
    value = _object(value)
    cutoff, captured = _time(as_of), _time(value.get("asOf"))
    day = str(value.get("baselineDate") or "")
    if (value.get("version") != 1 or value.get("product") != "hedgai-signals"
            or value.get("availability") == "unavailable" or _unsafe(value)
            or not cutoff or not captured or captured > cutoff
            or not day or day > cutoff.astimezone(ZoneInfo("America/New_York")).date().isoformat()
            or not isinstance(_object(value.get("book")).get("rows"), list)
            or not value.get("sources")):
        return {}
    return value


async def read_hedgai_research(base_url, as_of, *, transport=None):
    """Optional bounded acquisition; the exact response is saved in the review."""
    try:
        async with httpx.AsyncClient(timeout=8, transport=transport) as client:
            response = await client.get(f"{base_url.rstrip('/')}/api/research/hedgai", params={"asOf": as_of})
            response.raise_for_status()
            return accepted_hedgai(response.json(), as_of=as_of)
    except (httpx.HTTPError, ValueError):
        return {}


def _ids(row):
    return list(dict.fromkeys(str(cid) for key in ("sourceIds", "positionSourceIds", "metricsSourceIds")
                             for cid in row.get(key) or [] if cid))


def _pct(row, side):
    value = _number(_object(_object(row.get("metrics")).get(side)).get("battingAverage"))
    return f"{value * 100:.1f}%" if value is not None and 0 <= value <= 1 else "—"


def _current_row(row, projection):
    quality = _object(projection.get("sourceQuality"))
    blocking = [issue for issue in quality.get("issues") or [] if isinstance(issue, dict) and issue.get("blocking")]
    identities = {item.get("instrumentId") for item in _object(projection.get("book")).get("rows") or [] if isinstance(item, dict)}
    row_blocked = any(not issue.get("instrumentId") or issue["instrumentId"] not in identities
                      or issue["instrumentId"] == row.get("instrumentId") for issue in blocking)
    return not (_unsafe(row) or row.get("status") != "current"
                or row_blocked or (quality.get("continuity") != "complete" and not blocking))


def _qualified_direction(row, projection):
    direction = row.get("activeDirection")
    side = "buy" if direction == "Bullish" else "short" if direction == "Bearish" else None
    metric = _number(_object(_object(row.get("metrics")).get(side)).get("battingAverage"))
    threshold = _number(projection.get("threshold"))
    if (not _current_row(row, projection) or side is None or metric is None or threshold is None
            or not 0 <= threshold <= metric <= 1
            or row.get("position") != {"buy": "Buy", "short": "Short"}[side]):
        return None
    return direction


def hedgai_citations(projection):
    actions = [*(projection.get("changes") or []), *(projection.get("reaffirmations") or []), *(projection.get("unresolvedActions") or [])]
    result = []
    for source in projection.get("sources") or []:
        if not isinstance(source, dict) or not source.get("id"):
            continue
        source_actions = list(dict.fromkeys(str(action["sourceText"]) for action in actions
            if isinstance(action, dict) and source["id"] in _ids(action) and action.get("sourceText")))
        excerpt = source.get("excerpt") or "\n".join(source_actions)
        if not excerpt:
            excerpt = (str(source.get("title") or "HedgAI Signals") + "\n" +
                ("Reviewed screenshot; open the original for published values." if source.get("imageSha256")
                 else "Captured source; open the original for published values."))
        result.append({**deepcopy(source), "product": "hedgai-signals", "productLabel": "HedgAI Signals",
                       "sourceUri": source.get("sourceUri") or source.get("sourceUrl") or source.get("artifactPath") or "",
                       "excerpt": excerpt, "publicationDate": None if source.get("publicationTimeVerified") is False
                       else source.get("publicationDate") or projection.get("baselineDate")})
    return result


def _captured_publication(value, cutoff):
    """Accept an original dated publication, never a guessed capture timestamp."""
    text = str(value or "")
    if len(text) == 10:
        try:
            day = datetime.strptime(text, "%Y-%m-%d").date()
            return day.isoformat() == text and day <= cutoff.astimezone(ZoneInfo("America/New_York")).date()
        except ValueError:
            return False
    published = _time(value)
    return published is not None and published <= cutoff


def portfolio_tick_readings(value, *, as_of):
    """Independent, captured Tick context keyed by an unambiguous source ticker.

    These rows never enter the Trade/Trend reconciliation or sizing rule inputs.
    Market mappings are retained as evidence, never used to infer held aliases.
    """
    projection = accepted_hedgai(value, as_of=as_of)
    if not projection:
        return {}, []
    cutoff = _time(as_of)
    citations = {source["id"]: source for source in hedgai_citations(projection)
                 if not _unsafe(source) and source.get("publicationTimeVerified") is not False
                 and source.get("sourceUri")
                 and _captured_publication(source.get("publishedAt") or source.get("publicationDate"), cutoff)}
    by_ticker = {}
    for row in _object(projection.get("book")).get("rows") or []:
        if isinstance(row, dict) and isinstance(row.get("ticker"), str):
            by_ticker.setdefault(row["ticker"].strip().upper(), []).append(row)
    readings = {}
    for ticker, rows in by_ticker.items():
        if not ticker or len(rows) != 1:
            continue
        row = rows[0]
        published = row.get("lastConfirmedAt") or row.get("publicationDate")
        if (_unsafe(row) or not row.get("instrumentId") or row.get("position") not in {"Buy", "Short", "Wait"}
                or not _captured_publication(published, cutoff)):
            continue
        position_ids = [cid for cid in row.get("positionSourceIds") or [] if cid in citations]
        metric_ids = [cid for cid in row.get("metricsSourceIds") or [] if cid in citations]
        if not position_ids:
            continue
        threshold = _portfolio_threshold(projection)
        metrics_date = row.get("metricsDate") or projection.get("metricsDate")
        metrics_verified = bool(metric_ids) and _captured_publication(metrics_date, cutoff)
        strategy_direction = _qualified_direction(row, projection) if metrics_verified and threshold is not None and threshold >= .6 else None
        signals = _object(_object(row.get("metrics")).get("buy" if row["position"] == "Buy" else "short")).get("signals")
        if type(signals) is not int or signals <= 0:
            strategy_direction = None
        current = _current_row(row, projection)
        direction = {"Buy": "BULLISH", "Short": "BEARISH", "Wait": "NEUTRAL"}[row["position"]] if current else None
        status = "published" if direction else "historical"
        position_label = {"Buy": "Long", "Short": "Short", "Wait": "Wait and Watch"}[row["position"]]
        contribution = position_label if direction else f"Last known {position_label}"
        source = max((citations[cid] for cid in position_ids), key=lambda item: str(item.get("publishedAt") or item.get("publicationDate")))
        published_at = source.get("publishedAt") or source.get("publicationDate")
        citation_ids = list(dict.fromkeys([*position_ids, *metric_ids]))
        readings[ticker] = {"value": direction, "status": status, "qualified": bool(strategy_direction),
            "strategyDirection": strategy_direction, "strategyQualified": bool(strategy_direction),
            "position": row["position"], "contribution": contribution,
            "sourceTicker": row["ticker"], "instrumentId": row["instrumentId"], "sourceLabel": row.get("sourceLabel"),
            "matchType": "exact", "marketMatches": deepcopy(row.get("marketMatches") or []),
            "publishedAt": published_at, "publicationDate": row.get("publicationDate"), "lastConfirmedAt": row.get("lastConfirmedAt"),
            "initiatedAt": row.get("initiatedAt"), "metricsDate": metrics_date, "threshold": threshold,
            "metrics": deepcopy(row.get("metrics")), "citationIds": citation_ids,
            "source": {"publishedAt": published_at, "citation": deepcopy(source)},
            "contextOnly": True, "decisionEligible": False, "executable": False}
    used_ids = {cid for reading in readings.values() for cid in reading["citationIds"]}
    return readings, [source for cid, source in citations.items() if cid in used_ids]


def _action_history(change, row, projection, publication_day):
    """Explain the named action side using dated, independently sourced metrics."""
    action = change.get("action")
    side = "buy" if action in {"open-long", "close-long", "maintain-long"} else "short" if action in {"open-short", "close-short", "maintain-short"} else None
    metric_date = str(row.get("metricsDate") or projection.get("metricsDate") or "")[:10]
    metric = _number(_object(_object(row.get("metrics")).get(side)).get("battingAverage"))
    threshold = _number(projection.get("threshold"))
    if not side or not metric_date or metric_date > publication_day or metric is None or threshold is None or not 0 <= metric <= 1:
        return None
    if metric < threshold:
        return f"{_pct(row, side)} history; below {threshold * 100:g}%"
    if str(action).startswith("close-"):
        return f"qualifying side ({_pct(row, side)})"
    return f"{_pct(row, side)} history; qualifies"


def _table_row(row, cells, citations):
    return {"cells": cells, "citationIds": [cid for cid in _ids(row) if cid in citations]}


def _portfolio_catalog(captured=None):
    if isinstance(captured, dict) and captured.get("version") == 1 and isinstance(captured.get("groups"), list) and isinstance(captured.get("securityNames"), dict):
        return deepcopy(captured)
    path = Path(__file__).resolve().parents[2] / "data/research/hedgai/portfolio-presentation.json"
    return json.loads(path.read_text())


def _action_day(change):
    published = _time(change.get("publishedAt"))
    return published.astimezone(ZoneInfo("America/New_York")).date().isoformat() if published else change.get("publicationDate")


def _action_label(change):
    return {"open-long": "Added Long", "open-short": "Added Short", "close-long": "Closed Long", "close-short": "Closed Short",
            "maintain-long": "Long reaffirmed", "maintain-short": "Short reaffirmed"}.get(change.get("action")) or change.get("sourceText") or change.get("displayText") or change.get("text") or "—"


def _action_side(change):
    return {"open-long": "buy", "close-long": "buy", "maintain-long": "buy",
            "open-short": "short", "close-short": "short", "maintain-short": "short"}.get(change.get("action"))


def _portfolio_history_side(row, actions, threshold):
    if row.get("position") in {"Buy", "Short"}:
        return "buy" if row["position"] == "Buy" else "short"
    if actions and _action_side(actions[-1]):
        return _action_side(actions[-1])
    return next((side for side in ("buy", "short") if _side_eligible(row, side, threshold)), None)


def _portfolio_threshold(projection):
    threshold = _number(projection.get("threshold"))
    return threshold if threshold is not None and 0 <= threshold <= 1 else None


def _portfolio_filter(row, actions, projection):
    threshold = _portfolio_threshold(projection)
    if threshold is None:
        return "—"
    if row.get("position") in {"Buy", "Short"}:
        side = "buy" if row["position"] == "Buy" else "short"
        label = "Long" if side == "buy" else "Short"
        if not _side_eligible(row, side, threshold):
            return f"{label} excluded"
        return "Qualifies" if _qualified_direction(row, projection) else "Last known"
    if actions and str(actions[-1].get("action")).startswith("close-"):
        history = _action_history(actions[-1], row, projection, _action_day(actions[-1]) or "")
        return "Closed qualifying side" if history and history.startswith("qualifying side") else "Closed below threshold" if history else "—"
    bull, bear = (_side_eligible(row, side, threshold) for side in ("buy", "short"))
    label = "Await either" if bull and bear else "Await Long" if bull else "Await Short" if bear else f"Below {threshold * 100:g}%"
    return f"Last known · {label}" if row.get("status") == "last-known" else label


def _combined_portfolio_row(row, actions, projection, catalog, group, source_ids, *, full=False):
    threshold = _portfolio_threshold(projection)
    side = _portfolio_history_side(row, actions, threshold)
    source_label = row.get("sourceLabel") or "—"
    security = catalog["securityNames"].get(row.get("instrumentId")) or source_label
    position = {"Buy": "Long", "Short": "Short", "Wait": "Wait"}.get(row.get("position"), "—")
    if row.get("status") == "last-known":
        position = f"Last known {position}"
    history = f"{'Long' if side == 'buy' else 'Short'} {_pct(row, side)}" if side else "—"
    metrics_date = row.get("metricsDate") or projection.get("metricsDate")
    action_ids = list(dict.fromkeys(cid for action in actions for cid in _ids(action) if cid in source_ids))
    position_ids = [cid for cid in row.get("positionSourceIds") or _ids(row) if cid in source_ids]
    metric_ids = [cid for cid in row.get("metricsSourceIds") or _ids(row) if cid in source_ids]
    dates = f"Positioning: {_publication_label(row.get('lastConfirmedAt') or row.get('publicationDate') or projection.get('baselineDate'))}; initiated: {_date_label(row.get('initiatedAt'))}"
    history_title = f"Long: {_record(row, 'buy')}\nShort: {_record(row, 'short')}\nStatistics: {_date_label(metrics_date)}"
    action_title = "\n".join(f"{_publication_label(action.get('publishedAt') or action.get('publicationDate'))} · "
        f"{action.get('sourceText') or _action_label(action)}" +
        (f" · {explanation}" if (explanation := _action_history(action, row, projection, _action_day(action) or "")) else "") for action in actions)
    contribution = _portfolio_filter(row, actions, projection)
    citations = list(dict.fromkeys([*_ids(row), *action_ids]))
    result = {"instrumentId": row.get("instrumentId"), "ticker": row.get("ticker"), "sourceLabel": source_label,
        "group": group, "cells": [row.get("ticker") or "—", security, position,
            "; ".join(_action_label(action) for action in actions) or "—", history, contribution],
        "citationIds": [cid for cid in citations if cid in source_ids],
        "cellCitationIds": [position_ids, position_ids, position_ids, action_ids, metric_ids, list(dict.fromkeys([*position_ids, *metric_ids, *action_ids]))],
        "cellTitles": [source_label, source_label, dates, action_title, history_title, f"{contribution}\n{history_title}"],
        "position": row.get("position"), "status": row.get("status"), "activeDirection": _qualified_direction(row, projection),
        "initiatedAt": row.get("initiatedAt"), "publicationDate": row.get("publicationDate"), "metricsDate": metrics_date,
        "metrics": deepcopy(row.get("metrics")), "todayActions": deepcopy(actions), "historySide": side,
        "bullEligible": _side_eligible(row, "buy", threshold), "bearEligible": _side_eligible(row, "short", threshold)}
    if full:
        result["cells"] = [*result["cells"][:4], _record(row, "buy"), _record(row, "short"),
            _date_label(row.get("initiatedAt")), _date_label(metrics_date), contribution]
        result["cellTitles"] = [source_label, source_label, dates, action_title,
            f"Long: {_record(row, 'buy')} · statistics {_date_label(metrics_date)}",
            f"Short: {_record(row, 'short')} · statistics {_date_label(metrics_date)}", dates, _date_label(metrics_date), result["cellTitles"][-1]]
        result["cellCitationIds"] = [position_ids, position_ids, position_ids, action_ids, metric_ids, metric_ids,
            position_ids, metric_ids, result["cellCitationIds"][-1]]
    return result


def portfolio_hedgai_section(value, *, as_of, presentation_catalog=None):
    projection = accepted_hedgai(value, as_of=as_of)
    if not projection:
        return None, []
    citations = hedgai_citations(projection)
    source_ids = {source["id"] for source in citations}
    rows = [row for row in _object(projection.get("book")).get("rows") or [] if isinstance(row, dict) and not _unsafe(row)]
    catalog = _portfolio_catalog(presentation_catalog)
    threshold = _portfolio_threshold(projection)
    latest = _object(projection.get("sourceQuality")).get("lastPublicationAt") or projection.get("baselineDate")
    blocks = [{"type": "paragraph", "text": f"Positioning: {_publication_label(latest)} · Statistics: {_date_label(projection.get('metricsDate'))}", "citationIds": list(source_ids)}]
    capture_day = _time(as_of).astimezone(ZoneInfo("America/New_York")).date().isoformat()
    by_id = {row.get("instrumentId"): row for row in rows}
    by_action, unresolved = {}, []
    for change in [*(projection.get("changes") or []), *(projection.get("reaffirmations") or [])]:
        if not isinstance(change, dict) or _unsafe(change):
            continue
        day = _action_day(change)
        if day != capture_day:
            continue
        if change.get("instrumentId") in by_id:
            by_action.setdefault(change["instrumentId"], []).append(change)
        else:
            unresolved.append(change)
    for action in projection.get("unresolvedActions") or []:
        if isinstance(action, dict) and not _unsafe(action) and action not in unresolved:
            unresolved.append(action)
    for actions in by_action.values():
        actions.sort(key=lambda action: str(action.get("publishedAt") or action.get("publicationDate") or ""))
    matched = {reading.get("instrumentId") for reading in _object(projection.get("marketReadings")).values() if isinstance(reading, dict)}
    preview, full = [], []
    limit = max(1, min(50, int(catalog.get("defaultRowsPerGroup") or 5)))
    for group in catalog["groups"]:
        grouped = [row for row in rows if row.get("group") == group["id"]]
        pins = group.get("pinnedInstrumentIds") or []
        def relevance(row):
            instrument = row.get("instrumentId")
            direction = _qualified_direction(row, projection)
            if instrument in pins:
                return (0, pins.index(instrument))
            if direction:
                side = "buy" if direction == "Bullish" else "short"
                return (1, -_number(row["metrics"][side]["battingAverage"]))
            return (2 if instrument in matched and row.get("position") == "Wait" else 3, grouped.index(row))
        relevant = [row for row in grouped if any(_side_eligible(row, side, threshold) for side in ("buy", "short"))]
        for row in sorted(relevant, key=relevance)[:limit]:
            preview.append(_combined_portfolio_row(row, by_action.get(row.get("instrumentId"), []), projection, catalog, group["label"], source_ids))
        for row in grouped:
            full.append(_combined_portfolio_row(row, by_action.get(row.get("instrumentId"), []), projection, catalog, group["label"], source_ids, full=True))
    filter_label = f"{threshold * 100:g}% filter" if threshold is not None else "Filter"
    columns = ["Ticker", "Security", "Tick", "Today", "History", filter_label]
    if preview:
        blocks.append({"type": "table", "groupRows": True, "columns": columns, "rows": preview})
    blocks.append({"type": "table", "groupRows": True, "disclosure": f"Full Tick book · {len(full)} securities",
                   "columns": ["Ticker", "Security", "Tick", "Today", "Bull history", "Bear history", "Initiated", "Statistics date", filter_label], "rows": full})
    if unresolved:
        blocks.append({"type": "table", "disclosure": "Other source actions", "columns": ["Ticker", "Security", "Published action", "Published"],
            "rows": [{"cells": [action.get("ticker") or "—", action.get("sourceLabel") or "—", action.get("sourceText") or _action_label(action),
                       _publication_label(action.get("publishedAt") or action.get("publicationDate"))],
                      "citationIds": [cid for cid in _ids(action) if cid in source_ids]} for action in unresolved]})
    return {"id": "hedgai-signals", "title": "Tick", "blocks": blocks,
            "metadata": {"presentationCatalog": catalog, "filterThreshold": threshold,
                "selectedInstrumentIds": [row["instrumentId"] for row in preview], "asOf": _time(as_of).isoformat()},
            "citationIds": [source["id"] for source in citations]}, citations


def reproject_portfolio_hedgai(rollup, captured_projection, *, as_of, original_rollup=None):
    """Refresh presentation only, honoring captured settings and source evidence."""
    original = original_rollup if isinstance(original_rollup, dict) else rollup
    prior = next((section for section in original.get("sections") or [] if section.get("id") == "hedgai-signals"), {})
    catalog = _object(prior.get("metadata")).get("presentationCatalog")
    section, citations = portfolio_hedgai_section(captured_projection, as_of=as_of, presentation_catalog=catalog)
    if not section:
        return rollup
    result = deepcopy(rollup)
    sections = result.setdefault("sections", [])
    index = next((index for index, existing in enumerate(sections) if existing.get("id") == "hedgai-signals"),
                 next((index for index, existing in enumerate(sections) if existing.get("id") == "risk-ranges"), len(sections)))
    result["sections"] = [existing for existing in sections if existing.get("id") != "hedgai-signals"]
    result["sections"].insert(index, section)
    replaced = {source["id"] for source in citations}
    result["citations"] = [source for source in result.get("citations") or [] if source.get("id") not in replaced] + citations
    return result


def prediction_hedgai_readings(value, *, as_of):
    projection = accepted_hedgai(value, as_of=as_of)
    if not projection:
        return {}, []
    citations = hedgai_citations(projection)
    ticks, _ = portfolio_tick_readings(projection, as_of=as_of)
    source_ids = {source["id"] for source in citations}
    captured_rows = {row.get("instrumentId"): row for row in _object(projection.get("book")).get("rows") or [] if isinstance(row, dict)}
    readings = {}
    for market_id, reading in _object(projection.get("marketReadings")).items():
        reading = _object(reading)
        row = captured_rows.get(reading.get("instrumentId"))
        mapping = _object(reading.get("mapping"))
        if not row or _unsafe(row) or mapping.get("marketId") != market_id or mapping.get("fit") not in {"exact", "proxy", "related_only"}:
            continue
        readings[market_id] = {**deepcopy(row), "mapping": deepcopy(mapping),
            "activeDirection": _qualified_direction(row, projection), "baselineDate": projection.get("baselineDate"),
            "tick": deepcopy(ticks.get(str(row.get("ticker") or "").strip().upper())),
            "metricsDate": row.get("metricsDate") or projection.get("metricsDate"), "threshold": projection.get("threshold"),
            "sourceQuality": deepcopy(projection.get("sourceQuality")), "citationIds": [cid for cid in _ids(row) if cid in source_ids],
            "contextOnly": True, "decisionEligible": False, "executable": False}
    return readings, citations


def _prediction_tick_direction(reading):
    """Use a captured publisher reading; statistics do not replace its bias."""
    if _unsafe(reading) or reading.get("status") != "current":
        return None
    tick = _object(reading.get("tick"))
    if "tick" in reading:
        value = tick.get("value")
        return value.capitalize() if (not _unsafe(tick) and tick.get("status") == "published"
            and value == {"Buy": "BULLISH", "Short": "BEARISH", "Wait": "NEUTRAL"}.get(reading.get("position"))
            and value in {"BULLISH", "BEARISH", "NEUTRAL"} and tick.get("source")) else None
    # Saved legacy market captures already contain their dated position and
    # captured citations. Read those fields without fetching today's research.
    quality = _object(reading.get("sourceQuality"))
    if (quality.get("continuity") != "complete" or any(_object(issue).get("blocking") for issue in quality.get("issues") or [])):
        return None
    position_ids = reading.get("positionSourceIds") or []
    confirmed = reading.get("lastConfirmedAt") or reading.get("publicationDate")
    if not position_ids or not set(position_ids).issubset(set(reading.get("citationIds") or [])) or not confirmed:
        return None
    verified_through = _time(quality.get("lastPublicationAt"))
    if verified_through and not _captured_publication(confirmed, verified_through):
        return None
    return {"Buy": "Bullish", "Short": "Bearish", "Wait": "Neutral"}.get(reading.get("position"))


def prediction_hedgai_text(reading, view):
    """Describe the independent horizon without changing contract direction."""
    reading = _object(reading)
    if not reading:
        return None, None
    direction = _prediction_tick_direction(reading)
    basis = reading.get("ticker") or reading.get("sourceLabel") or "—"
    if _object(reading.get("mapping")).get("fit") != "exact":
        basis += " proxy"
    dated = reading.get("lastConfirmedAt") or reading.get("publicationDate") or reading.get("baselineDate")
    contribution = {"Bullish": "Long", "Bearish": "Short", "Neutral": "Wait and Watch"}.get(direction) or hedgai_contribution(reading)
    if reading.get("position") == "Wait":
        side = "buy" if _side_eligible(reading, "buy") else "short" if _side_eligible(reading, "short") else None
        record = ("Buy " if side == "buy" else "Short ") + _record(reading, side) if side else ""
        if _side_eligible(reading, "buy") and _side_eligible(reading, "short"):
            record = "Buy " + _record(reading, "buy") + " / Short " + _record(reading, "short")
    else:
        record = _record(reading, "buy" if reading.get("position") == "Buy" else "short")
    parts = [contribution, basis, _date_label(dated)]
    if reading.get("initiatedAt"):
        parts.append(f"initiated {_date_label(reading['initiatedAt'])}")
    if record:
        parts.append("historical batting " + record)
    text = " · ".join(parts)
    comparisons = []
    if direction in {"Bullish", "Bearish"}:
        for key in ("trade", "trend"):
            signal = _object(view.get(key))
            other = signal.get("direction")
            if other not in {"BULLISH", "BEARISH"}:
                continue
            label = "Bullish" if other == "BULLISH" else "Bearish"
            comparisons.append(f"{'agrees with' if label == direction else 'conflicts with'} {label} {key.title()}")
    comparison = f"{direction} Tick {basis} " + "; ".join(comparisons) + "." if comparisons else None
    return text, comparison


def prediction_hedgai_comparison(markets):
    readings = {}
    for market in markets:
        reading = _object(_object(market.get("research")).get("hedgai"))
        if reading.get("instrumentId"):
            readings[reading["instrumentId"]] = reading
    return {"title": f"Tick comparison · {len(readings)} securities",
        "columns": ["Ticker", "Security", "Tick", "Contribution", "Initiated", "Bull history", "Bear history", "Statistics date"],
        "rows": [[row.get("ticker") or "—", (row.get("sourceLabel") or "—") + (" (proxy)" if _object(row.get("mapping")).get("fit") != "exact" else ""),
            {"Buy": "Long", "Short": "Short", "Wait": "Wait"}.get(row.get("position"), "—"), hedgai_contribution(row),
            _date_label(row.get("initiatedAt")), _record(row, "buy"), _record(row, "short"), _date_label(row.get("metricsDate"))] for row in readings.values()],
        "citationIds": list(dict.fromkeys(cid for row in readings.values() for cid in row.get("citationIds") or []))}
