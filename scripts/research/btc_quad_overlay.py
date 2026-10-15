"""Verified published US quarterly Quad cohorts for the historical BTC study.

Retrospective actual-quarter labels are distinct from a forecast known at entry.
The caller must choose that distinction explicitly; no Quad is inferred.
"""
from __future__ import annotations

from datetime import datetime
import hashlib
import json
from pathlib import Path
import re
from zoneinfo import ZoneInfo

from btc_usd_features import instant, iso, rejected_provenance

EASTERN = ZoneInfo("America/New_York")
SOURCE = "hedgeye-published-global-quads"
QUAD_MODES = {"retrospective_actual", "point_in_time"}


def digest(value):
    raw = value if isinstance(value, bytes) else json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(raw).hexdigest()


def quarter_bounds(quarter):
    if not re.fullmatch(r"20\d{2}-Q[1-4]", quarter or ""):
        raise ValueError("Invalid published quarter")
    year, number = map(int, quarter.split("-Q"))
    start = datetime(year, (number - 1) * 3 + 1, 1, tzinfo=EASTERN)
    end = datetime(year + 1, 1, 1, tzinfo=EASTERN) if number == 4 else datetime(year, number * 3 + 1, 1, tzinfo=EASTERN)
    return start, end


def unverified(value):
    return rejected_provenance(value) or any(str(value.get(key, "")).lower() == "true"
        for key in ("mock", "isMock", "seeded", "synthetic", "inferred", "portfolioDerived"))


def normalize_history(history, directory, cutoff):
    """Bind exact US cells to the reviewed transcription and original image hashes."""
    if unverified(history) or history.get("source") != "HedgeyeDailySnapshot/global-quads-history":
        raise ValueError("Unverified published Quad archive")
    tables, sources = {}, []
    for archived in history.get("rows", []):
        candidate, source = archived.get("candidate", {}), archived.get("source", {})
        group = candidate.get("group")
        if group not in ("g20", "global"):
            continue
        if group in tables or unverified(archived) or unverified(candidate) or unverified(source):
            raise ValueError("Duplicate or unverified US Quad source table")
        review = source.get("verification", {})
        normalized = {key: candidate.get(key) for key in ("group", "columns", "rows")}
        content_hash = digest(normalized)
        if (source.get("sourceType") != "reviewed-screenshot" or review.get("method") != "visual-source-comparison"
                or not review.get("reviewedBy") or candidate.get("contentHash") != content_hash
                or review.get("contentHash") != content_hash or archived.get("date") != content_hash
                or source.get("asOf") != candidate.get("asOf")):
            raise ValueError("Quad transcription is not bound to its source review")
        image = Path(directory) / f"{group}.png"
        if digest(image.read_bytes()) != source.get("id"):
            raise ValueError("Original Quad source image hash mismatch")
        received, reviewed = instant(source.get("receivedAt")), instant(review.get("reviewedAt"))
        available = max(received, reviewed)
        if available > instant(cutoff):
            raise ValueError("Quad source verification is after the frozen study cutoff")
        as_of = datetime.fromisoformat(candidate["asOf"]).replace(tzinfo=EASTERN)
        if available < as_of:
            raise ValueError("Quad source availability precedes its printed as-of date")
        columns = {column["id"]: column for column in candidate["columns"]}
        if len(columns) != len(candidate["columns"]):
            raise ValueError("Duplicate published quarter columns")
        us = [row for row in candidate["rows"] if row.get("country") == "United States" and row.get("aggregate") is False]
        if len(us) != 1:
            raise ValueError("Missing or ambiguous United States row")
        values = {}
        for quarter, value in us[0].get("values", {}).items():
            start, end = quarter_bounds(quarter)
            column = columns.get(quarter, {})
            kind, quad = value.get("kind"), value.get("quad")
            if (type(quad) is not int or quad not in (1, 2, 3, 4) or kind not in ("actual", "estimate")
                    or column.get("kind") != kind or unverified(value)):
                raise ValueError("Invalid or unsourced published US Quad cell")
            expected_label = f"{quarter[-1]}Q{quarter[2:4]}" + ("E" if kind == "estimate" else "")
            if column.get("label") != expected_label or (kind == "actual" and end > as_of):
                raise ValueError("Published quarter actual/estimate identity mismatch")
            values[quarter] = {"quarter": quarter, "quad": quad, "kind": kind,
                               "periodStart": iso(start), "periodEnd": iso(end)}
        tables[group] = values
        sources.append({"group": group, "sourceAsOf": candidate["asOf"], "availableAt": available.isoformat().replace("+00:00", "Z"),
                        "publishedAt": source.get("publishedAt"), "imageHash": source["id"],
                        "contentHash": content_hash, "sourceTitle": source.get("sourceTitle")})
    if set(tables) != {"g20", "global"}:
        raise ValueError("Both preserved US source tables are required for reconciliation")
    overlap = sorted(tables["g20"].keys() & tables["global"].keys())
    for quarter in overlap:
        if tables["g20"][quarter] != tables["global"][quarter]:
            raise ValueError("Published US Quad tables disagree")
    return {"schemaVersion": 1, "status": "verified", "source": SOURCE, "country": "United States",
            "frequency": "quarterly", "sourceAsOf": max(row["sourceAsOf"] for row in sources),
            "availableAt": max(row["availableAt"] for row in sources), "sources": sources,
            "quarters": [tables["g20"][quarter] for quarter in overlap]}


def assign_quads(observations, source, mode):
    if mode not in QUAD_MODES:
        raise ValueError("An explicit Quad timing convention is required")
    lookup = {row["quarter"]: row for row in source["quarters"]}
    output = []
    for original in observations:
        at = instant(original["hourStart"])
        local = at.astimezone(EASTERN)
        quarter = f"{local.year}-Q{(local.month - 1) // 3 + 1}"
        published = lookup.get(quarter)
        metadata = published or {}
        available_at = metadata.get("availableAt", source["availableAt"])
        reason = None
        if published is None:
            reason = "No published US quarterly classification"
        elif mode == "retrospective_actual" and published["kind"] != "actual":
            reason = "Current-quarter forecast excluded from actual-quarter cohorts"
        elif mode == "point_in_time" and metadata.get("retrospectiveOnly") is True:
            reason = "Recovered actual-quarter evidence supports retrospective classification only"
        elif mode == "point_in_time" and at < instant(available_at):
            reason = "Published Quad source was not yet available at entry"
        result = {**original, "quad": published["quad"] if reason is None else None,
                       "quadQuarter": quarter, "quadKind": published["kind"] if published else None,
                       "quadSource": SOURCE, "quadBasis": mode, "quadSourceAsOf": metadata.get("sourceAsOf", source["sourceAsOf"]),
                       "quadAvailableAt": available_at, "quadExclusionReason": reason}
        for source_key, result_key in (("publishedAt", "quadPublishedAt"), ("receivedAt", "quadReceivedAt"), ("reviewedAt", "quadReviewedAt")):
            if source_key in metadata:
                result[result_key] = metadata[source_key]
        output.append(result)
    return output
