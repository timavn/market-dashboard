"""Merge separately reviewed historical actual US Quads from an original report.

This recovery is retrospective. Its current review date never becomes a claim
that the classification was known during the earlier historical quarter.
"""
from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime, parseaddr
import html
import json
from pathlib import Path, PurePosixPath
import re
from urllib.parse import urlsplit, urlunsplit

from btc_quad_overlay import SOURCE, EASTERN, digest, quarter_bounds, unverified
from btc_usd_features import instant, iso

REVIEW_CONTENT_FIELDS = ("country", "frequency", "sourceAsOf", "quarters", "excludedForecastQuarters")
QUARTER_FIELDS = ("quarter", "quad", "kind", "periodStart", "periodEnd")


def archived_path(directory, relative):
    relative = PurePosixPath(relative)
    directory = Path(directory).resolve()
    if relative.is_absolute() or ".." in relative.parts or not relative.parts:
        raise ValueError("Invalid supplemental evidence path")
    path = directory.joinpath(*relative.parts).resolve()
    if not path.is_relative_to(directory):
        raise ValueError("Supplemental evidence path escapes its archive")
    return path


def contents(part):
    body = part.get("body", {}).get("content")
    result = [body] if isinstance(body, str) else []
    for child in part.get("parts") or []:
        result.extend(contents(child))
    return result


def original_report_times(message, checkpoint):
    payload = message.get("payload", {})
    headers = payload.get("headers", [])
    values = lambda name: [h.get("value", "") for h in headers if h.get("name", "").lower() == name]
    sender = values("from")
    if (message.get("id") != checkpoint["sourceMessageId"] or not sender
            or not parseaddr(sender[0])[1].lower().endswith("@hedgeye.com")
            or values("subject") != [checkpoint["sourceTitle"]]):
        raise ValueError("Supplemental report identity does not match its original message")
    bodies = contents(payload)
    publication_times = set()
    for body in bodies:
        for date, clock, meridiem, zone in re.findall(r"\b(\d{2}/\d{2}/\d{4})\s+(\d{1,2}:\d{2})\s+(AM|PM)\s+(EDT|EST)\b", html.unescape(body)):
            at = datetime.strptime(f"{date} {clock} {meridiem}", "%m/%d/%Y %I:%M %p").replace(tzinfo=EASTERN)
            if at.tzname() == zone:
                publication_times.add(iso(at))
    if checkpoint["publishedAt"] not in publication_times:
        raise ValueError("Supplemental publication time is not present in the original report")
    received = []
    internal = message.get("internalDate") or message.get("internal_date")
    if internal:
        try:
            received.append(datetime.fromtimestamp(int(internal) / 1000, timezone.utc))
        except (ValueError, TypeError, OverflowError):
            pass
    for value in values("received"):
        hosts = re.findall(r"\b(?:by|from)\s+([^\s;()]+)", value.lower())
        if ";" in value and any(host == "google.com" or host.endswith(".google.com") for host in hosts):
            try:
                received.append(instant(parsedate_to_datetime(value.rsplit(";", 1)[-1].strip())))
            except (ValueError, TypeError):
                pass
    if not received or max(received) != instant(checkpoint["receivedAt"]):
        raise ValueError("Supplemental receipt time does not match the original trusted receipt")
    if max(instant(checkpoint["publishedAt"]), *received) != instant(checkpoint["availableAt"]):
        raise ValueError("Supplemental availability precedes its complete publication and receipt evidence")
    urls = [html.unescape(value) for body in bodies for value in re.findall(r'<img\b[^>]*\bsrc=["\']([^"\']+)', body, re.I)]
    canonical = lambda url: urlunsplit((*urlsplit(url)[:3], "", ""))
    if (urlsplit(checkpoint["imageUrl"]).scheme != "https"
            or checkpoint["imageUrl"] not in {canonical(url) for url in urls}):
        raise ValueError("Supplemental image is not linked by the original report")


def merge_supplemental_history(base, checkpoint_path, sourcearchive, cutoff):
    """Return a new source; original normalized source and archives stay unchanged."""
    checkpoint_path = Path(checkpoint_path)
    checkpoint = json.loads(checkpoint_path.read_text())
    for source in (base, checkpoint):
        if (unverified(source) or source.get("schemaVersion") != 1 or source.get("status") != "verified"
                or source.get("source") != SOURCE or source.get("country") != "United States"
                or source.get("frequency") != "quarterly"):
            raise ValueError("Unverified supplemental or base quarterly source")
    content_hash = digest({key: checkpoint.get(key) for key in REVIEW_CONTENT_FIELDS})
    if (not checkpoint.get("reviewer") or checkpoint.get("reviewMethodId") != "visual-source-comparison"
            or not checkpoint.get("reviewMethod") or checkpoint.get("contentHash") != content_hash
            or checkpoint.get("reviewContentHash") != content_hash):
        raise ValueError("Supplemental transcription is not bound to its visual review")
    received, published = instant(checkpoint["receivedAt"]), instant(checkpoint["publishedAt"])
    available, reviewed = instant(checkpoint["availableAt"]), instant(checkpoint["reviewedAt"])
    as_of = datetime.fromisoformat(checkpoint["sourceAsOf"]).replace(tzinfo=EASTERN)
    modified = instant(checkpoint["imageModifiedAt"])
    if (available != max(received, published) or not as_of <= modified <= published <= instant(cutoff)
            or received > instant(cutoff) or reviewed < available):
        raise ValueError("Invalid supplemental publication, receipt or review chronology")
    # Review can occur after the frozen study cutoff because this is a retrospective recovery.
    image = archived_path(sourcearchive, checkpoint["imagePath"])
    message_path = archived_path(sourcearchive, checkpoint["rawMessagePath"])
    headers_path = archived_path(sourcearchive, checkpoint["headersPath"])
    for path, key in ((image, "imageHash"), (message_path, "rawMessageHash"), (headers_path, "headersHash")):
        if digest(path.read_bytes()) != checkpoint.get(key):
            raise ValueError(f"Original supplemental {key} mismatch")
    if headers_path != Path(str(image) + ".headers.json"):
        raise ValueError("Supplemental image response headers are not bound to the image")
    headers = json.loads(headers_path.read_text())
    if (instant(parsedate_to_datetime(headers["Last-Modified"])) != modified
            or int(headers["Content-Length"]) != image.stat().st_size):
        raise ValueError("Supplemental image response metadata mismatch")
    original_report_times(json.loads(message_path.read_text()), checkpoint)
    excluded = checkpoint.get("excludedForecastQuarters")
    if not isinstance(excluded, list) or len(excluded) != len(set(excluded)):
        raise ValueError("Invalid excluded forecast-quarter identities")
    for quarter in excluded:
        quarter_bounds(quarter)
    incoming, seen = [], set()
    for row in checkpoint.get("quarters", []):
        start, end = quarter_bounds(row.get("quarter"))
        if (unverified(row) or row["quarter"] in seen or row["quarter"] in excluded
                or row.get("kind") != "actual" or type(row.get("quad")) is not int or row["quad"] not in (1, 2, 3, 4)
                or row.get("periodStart") != iso(start) or row.get("periodEnd") != iso(end)
                or end > as_of or (excluded and row["quarter"] >= min(excluded))):
            raise ValueError("Invalid, duplicate or forecast supplemental quarter")
        seen.add(row["quarter"])
        incoming.append({**{key: row[key] for key in QUARTER_FIELDS},
                         **{key: checkpoint[key] for key in ("sourceAsOf", "publishedAt", "receivedAt", "availableAt", "reviewedAt")},
                         "retrospectiveOnly": True})
    if not incoming:
        raise ValueError("Supplemental source contains no reviewed actual quarters")
    merged = deepcopy(base)
    lookup = {row["quarter"]: row for row in merged["quarters"]}
    if len(lookup) != len(merged["quarters"]):
        raise ValueError("Base source contains duplicate quarters")
    matched, added = [], []
    for row in incoming:
        previous = lookup.get(row["quarter"])
        if previous:
            if any(previous.get(key) != row[key] for key in QUARTER_FIELDS):
                raise ValueError("Supplemental actual classification conflicts with the verified base source")
            matched.append(row["quarter"])
        else:
            added.append(row["quarter"])
        # Keep the existing verified vintage on overlaps; record the independent agreement below.
        if previous is None:
            lookup[row["quarter"]] = row
    evidence = {key: checkpoint[key] for key in ("sourceAsOf", "publishedAt", "receivedAt", "availableAt", "reviewedAt",
                "sourceTitle", "sourceMessageId", "imageUrl", "imagePath", "imageHash", "imageModifiedAt",
                "rawMessagePath", "rawMessageHash", "headersPath", "headersHash", "reviewer", "reviewMethodId",
                "reviewMethod", "contentHash", "reviewContentHash", "excludedForecastQuarters")}
    evidence.update({"basis": "retrospective_actual", "checkpointHash": digest(checkpoint_path.read_bytes()),
                     "addedQuarters": added, "matchedQuarters": matched})
    merged["quarters"] = [lookup[quarter] for quarter in sorted(lookup)]
    merged["supplementalEvidence"] = [*merged.get("supplementalEvidence", []), evidence]
    return merged
