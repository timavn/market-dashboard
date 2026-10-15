#!/usr/bin/env python3
"""Archive a reviewed HedgAI baseline and append its immutable ledger event.

Local validation and preview are the default. --apply uses the repository's
verified administrator profile; existing source objects and events are never
overwritten. This imports research evidence, never quotes or account positions.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from decimal import Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_BASELINE = ROOT / "data/research/hedgai/2026-09-28-baseline.json"
PREFIX = "hedgeye/research/hedgai/baselines/"


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def sha(value):
    return hashlib.sha256(value if isinstance(value, bytes) else value.encode()).hexdigest()


def verification_value(value):
    # research-event-content-v1 normalizes all numbers to plain decimal strings.
    if isinstance(value, bool) or value is None:
        return value
    if isinstance(value, (int, float, Decimal)):
        number = Decimal(str(value))
        return "-0" if number.is_zero() and number.is_signed() else format(number.normalize(), "f")
    if isinstance(value, list):
        return [verification_value(item) for item in value]
    if isinstance(value, dict):
        return {key: verification_value(item) for key, item in value.items()}
    return value


def event_value(value):
    # Match the existing ResearchEventLedgerV2 eventHash convention separately.
    if isinstance(value, (float, Decimal)):
        return str(Decimal(str(value)).normalize())
    if isinstance(value, list):
        return [event_value(item) for item in value]
    if isinstance(value, dict):
        return {key: event_value(item) for key, item in value.items()}
    return value


def decimalize(value):
    if isinstance(value, float):
        return Decimal(str(value))
    if isinstance(value, list):
        return [decimalize(item) for item in value]
    if isinstance(value, dict):
        return {key: decimalize(item) for key, item in value.items()}
    return value


def prepare_baseline(filename=DEFAULT_BASELINE):
    raw = Path(filename).read_bytes()
    baseline = json.loads(raw)
    review = baseline.get("provenance", {})
    rows = baseline.get("rows", [])
    sources = baseline.get("sources", [])
    if (baseline.get("version") != 1 or baseline.get("product") != "hedgai-signals"
            or review.get("reviewed") is not True
            or review.get("method") != "visual-source-comparison"
            or len(rows) != review.get("expectedRowCount") or not rows
            or len(sources) != review.get("expectedSourceCount") or not sources
            or sha(canonical(rows)) != review.get("rowsHash")):
        raise ValueError("HedgAI transcription does not match its reviewed baseline")
    if len({row.get("instrumentId") for row in rows}) != len(rows):
        raise ValueError("Duplicate HedgAI instrument identity")
    artifacts = []
    date = baseline["baselineDate"]
    for source in sources:
        filename = (ROOT / source.get("artifactPath", "")).resolve()
        if not filename.is_relative_to(ROOT / "data/research/hedgai/sources"):
            raise ValueError("Source path is outside the HedgAI archive")
        content = filename.read_bytes()
        if (source.get("sourceType") != "reviewed-screenshot"
                or source.get("review", {}).get("method") != "visual-source-comparison"
                or not content.startswith(b"\x89PNG\r\n\x1a\n")
                or sha(content) != source.get("imageSha256")):
            raise ValueError("Archived screenshot does not match its visual review")
        artifacts.append((f"{PREFIX}{date}/{sha(content)}.png", content, "image/png"))
    baseline_key = f"{PREFIX}{date}/{sha(raw)}.baseline.json"
    artifacts.append((baseline_key, raw, "application/json"))
    event_type = "HEDGAI_BASELINE"
    payload = {**baseline, "archivedBaseline": baseline_key,
               "archivedSourceKeys": [key for key, _, _ in artifacts[:-1]]}
    digest = sha(json.dumps({"eventType": event_type, "payload": event_value(payload)},
                           sort_keys=True, separators=(",", ":"), ensure_ascii=True))
    verified = sha(canonical(verification_value({"eventType": event_type, "payload": payload})))
    source_id = "hedgai-reviewed-baseline:" + review["rowsHash"]
    item = {"productKey": "hedgai-signals",
            "eventKey": f"{baseline['publishedAt']}#{source_id}#0000",
            "eventTime": baseline["publishedAt"], "sourceMessageId": source_id,
            "sequence": 0, "sourceEventCount": 1, "eventType": event_type,
            "payload": payload, "snapshotDate": date,
            "sourceKind": "reviewed-screenshot-baseline", "source": "hedgeye-reviewed-publication",
            "sourceArtifact": baseline_key, "contentHash": sha(raw), "eventHash": digest,
            "verificationHashVersion": "research-event-content-v1", "verificationHash": verified,
            "parserVersion": "research-event-ledger-v2:hedgai-reviewed-baseline-v1",
            "capturedAt": review["reviewedAt"], "immutable": True}
    return item, artifacts


def import_baseline(table, s3, bucket, filename=DEFAULT_BASELINE):
    item, artifacts = prepare_baseline(filename)
    for key, content, content_type in artifacts:
        try:
            s3.put_object(Bucket=bucket, Key=key, Body=content, ContentType=content_type,
                          Metadata={"sha256": sha(content)}, IfNoneMatch="*")
        except Exception as error:
            code = getattr(error, "response", {}).get("Error", {}).get("Code")
            if code not in {"PreconditionFailed", "412", "ConditionalRequestConflict"}:
                raise
            existing = s3.get_object(Bucket=bucket, Key=key)["Body"].read()
            if sha(existing) != sha(content):
                raise RuntimeError("An archived HedgAI object conflicts with the reviewed source") from error
    try:
        table.put_item(Item=decimalize(item),
                       ConditionExpression="attribute_not_exists(#p) AND attribute_not_exists(#e)",
                       ExpressionAttributeNames={"#p": "productKey", "#e": "eventKey"})
        status = "imported"
    except Exception as error:
        if getattr(error, "response", {}).get("Error", {}).get("Code") != "ConditionalCheckFailedException":
            raise
        existing = table.get_item(Key={"productKey": item["productKey"], "eventKey": item["eventKey"]}, ConsistentRead=True).get("Item", {})
        if existing.get("eventHash") != item["eventHash"] or existing.get("verificationHash") != item["verificationHash"]:
            raise RuntimeError("Immutable HedgAI baseline event conflicts with the existing ledger") from error
        status = "already-imported"
    return {"status": status, "rows": len(item["payload"]["rows"]), "artifacts": len(artifacts), "eventKey": item["eventKey"]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path, nargs="?", default=DEFAULT_BASELINE)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--bucket", default="market-dashboard-csv-data")
    parser.add_argument("--table", default="ResearchEventLedgerV2")
    args = parser.parse_args()
    if args.apply:
        from aws_profile_contract import verified_session
        session = verified_session("market-dashboard-admin", purpose="admin")
        result = import_baseline(session.resource("dynamodb").Table(args.table), session.client("s3"), args.bucket, args.manifest)
    else:
        item, artifacts = prepare_baseline(args.manifest)
        result = {"status": "preview", "rows": len(item["payload"]["rows"]), "artifacts": len(artifacts),
                  "eventKey": item["eventKey"], "verificationHash": item["verificationHash"]}
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
