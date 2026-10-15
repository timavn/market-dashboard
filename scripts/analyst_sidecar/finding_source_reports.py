"""Attach the exact indexed publication to an inbox observation, without writes.

The entity-event excerpt is deliberately small and can omit action scope from
the report body. This read projection joins it to its original indexed email;
it never searches for a similar report or infers an action from another ticker.
"""
from __future__ import annotations

import json
import re
import sqlite3
from urllib.parse import urlsplit


def _joined_chunks(rows):
    text = ""
    for row in rows:
        excerpt = str(row["excerpt"] or "")
        if not text:
            text = excerpt
            continue
        # ResearchIndex.chunk_text repeats a tail of up to 160 characters.
        overlap = next((size for size in range(min(160, len(text), len(excerpt)), 0, -1)
                        if text.endswith(excerpt[:size])), 0)
        text += excerpt[overlap:] if overlap else "\n\n" + excerpt
    return text


def _ledger_payload(text):
    # The feed normalizer appends the structured ingest-ledger record after
    # the email text. Require that complete record, not a prose hash match.
    decoder = json.JSONDecoder()
    for match in reversed(list(re.finditer(r"\{", text))):
        try:
            payload, end = decoder.raw_decode(text[match.start():])
        except ValueError:
            continue
        if isinstance(payload, dict) and not text[match.start() + end:].strip():
            return payload, text[:match.start()].strip()
    return None, ""


def _source_report(db, event):
    if event.get("qualityStatus") != "validated" or event.get("productKey") != "real-time-alert":
        return None
    if event.get("matchType") != "structured_membership" or not re.fullmatch(r"data\.alerts?(?:\[\d+\])?", str(event.get("fieldPath") or "")):
        return None
    message_id = str(event.get("sourceMessageId") or "")
    digest = str(event.get("contentSha256") or "").lower()
    date = str(event.get("marketDate") or event.get("publishedAt") or "")[:10]
    symbol = str(event.get("entityId") or "").upper()
    if not re.fullmatch(r"[a-fA-F0-9]{8,32}", message_id) or not re.fullmatch(r"[a-f0-9]{64}", digest):
        return None
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date) or not re.fullmatch(r"[A-Z0-9.^_-]{1,24}", symbol):
        return None
    try:
        source = json.loads(event.get("excerpt") or "")
    except (TypeError, ValueError):
        return None
    if not isinstance(source, dict) or str(source.get("ticker") or source.get("symbol") or "").upper() != symbol:
        return None
    source_url = str(event.get("sourceUrl") or "")
    try:
        url = urlsplit(source_url)
    except ValueError:
        return None
    if url.scheme != "https" or url.hostname not in {"app.hedgeye.com", "hedgeye.com", "www.hedgeye.com"} or not re.fullmatch(r"/feed_items/\d+/?", url.path):
        return None
    candidates = db.execute(
        "SELECT * FROM documents WHERE product=? AND publication_date=? AND source_uri LIKE ? ORDER BY indexed_at DESC LIMIT 9",
        (event["productKey"], date, f"%/{message_id}-%"),
    ).fetchall()
    if len(candidates) > 8:
        return None
    reports = []
    for document in candidates:
        try:
            metadata = json.loads(document["metadata_json"])
        except (TypeError, ValueError):
            continue
        if not isinstance(metadata, dict) or metadata.get("table") != "HermesEmailIngestLedger" or metadata.get("lifecycleStage") != "INDEXED":
            continue
        artifact = str(document["source_uri"] or "")
        if not re.search(rf"/{re.escape(message_id)}-[^/]+\.html?$", artifact):
            continue
        chunks = db.execute("SELECT citation_id,excerpt FROM chunks WHERE document_id=? ORDER BY ordinal LIMIT 129", (document["document_id"],)).fetchall()
        if not chunks or len(chunks) > 128:
            continue
        ledger, body = _ledger_payload(_joined_chunks(chunks))
        if not ledger or ledger.get("messageId") != message_id or str(ledger.get("contentSha256") or "").lower() != digest:
            continue
        if ledger.get("reportType") != event["productKey"] or ledger.get("snapshotDate") != date or ledger.get("status") != "INDEXED":
            continue
        if artifact != f"s3://{ledger.get('s3Bucket')}/{ledger.get('s3Key')}" or not re.search(re.escape(source_url) + r"(?=$|[\s<>\"'.,)])", body):
            continue
        # The publication must also identify this event's instrument. The
        # presentation layer determines whether its action sentence applies.
        headline = str(source.get("headline") or source.get("signalPhrase") or "").strip()
        if not headline or headline.casefold() not in re.sub(r"\s+", " ", body).casefold():
            continue
        reports.append({
            "documentId": document["document_id"],
            "citationId": chunks[0]["citation_id"],
            "title": document["title"],
            "bodyText": body,
            "sourceMessageId": message_id,
            "sourceUri": source_url,
            "sourceArtifactUri": artifact,
            "publicationDate": date,
            "contentHash": document["content_hash"],
            "sourceContentSha256": digest,
            "entityId": symbol,
        })
    # Competing indexed versions must never supply an arbitrary instruction.
    return reports[0] if reports and len({report["contentHash"] for report in reports}) == 1 else None


def attach_finding_source_reports(result, research_index):
    if not isinstance(result, dict) or not isinstance(result.get("findings"), list):
        return result
    findings = []
    cache = {}
    try:
        with research_index.connect() as db:
            for finding in result["findings"]:
                payload = finding.get("payload") or finding
                event = payload.get("event") or {}
                key = json.dumps(event, sort_keys=True, default=str)
                if key not in cache:
                    cache[key] = _source_report(db, event)
                report = cache[key]
                if not report:
                    findings.append(finding)
                    continue
                enriched = {**payload, "event": {**event, "sourceReport": report}}
                findings.append({**finding, "payload": enriched} if "payload" in finding else enriched)
    except (sqlite3.Error, OSError):
        # Supporting source detail must not make the existing inbox unavailable.
        return result
    return {**result, "findings": findings}
