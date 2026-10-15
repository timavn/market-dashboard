#!/usr/bin/env python3
"""Append source-bound HedgAI parsing repairs without overwriting source events.

The default run verifies archived source bytes and previews repairs. --apply
appends immutable repair envelopes; it never changes the original ledger rows.
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

from import_hedgai_baseline import canonical, decimalize, event_value, sha, verification_value

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "infra/lambdas/gmail_ingestor"))
from hedgai_signals import PARSER_VERSION  # noqa: E402
from parse_hedgeye_email_html import parse_html_snapshot  # noqa: E402

PRODUCT = "hedgai-signals"
SOURCE_TYPES = {"HEDGAI_PUBLICATION", "HEDGAI_ACTION", "HEDGAI_REAFFIRMATION", "HEDGAI_METRICS"}


def verification_hash(event):
    return sha(canonical(verification_value({"eventType": event["eventType"], "payload": event["payload"]})))


def prepare_source_reparse(events, source_bytes, *, captured_at=None):
    group = sorted(events, key=lambda event: event.get("sequence", -1))
    manifests = [event for event in group if event.get("eventType") == "HEDGAI_PUBLICATION"]
    if not group or len(manifests) != 1:
        raise ValueError("A complete original publication event group is required")
    manifest = manifests[0]
    count = group[0].get("sourceEventCount")
    if (not isinstance(count, int) or count <= 0 or len(group) != count
            or manifest["payload"].get("sourceMessageId") != manifest.get("sourceMessageId")
            or manifest["payload"].get("sourceArtifact") != manifest.get("sourceArtifact")
            or manifest["payload"].get("actionCount") != sum(event.get("eventType") == "HEDGAI_ACTION" for event in group)
            or any(event.get("sequence") != index or event.get("sourceEventCount") != count
                   or event.get("productKey") != PRODUCT or event.get("eventType") not in SOURCE_TYPES
                   or event.get("immutable") is not True
                   or not str(event.get("parserVersion", "")).startswith("research-event-ledger-v2")
                   or event.get("verificationHashVersion") != "research-event-content-v1"
                   or event.get("verificationHash") != verification_hash(event)
                   or event.get("sourceMessageId") != manifest.get("sourceMessageId")
                   or event.get("sourceArtifact") != manifest.get("sourceArtifact")
                   or event.get("contentHash") != manifest.get("contentHash")
                   or event.get("eventTime") != manifest.get("eventTime")
                   or event.get("payload", {}).get("publicationId") != manifest["payload"].get("publicationId")
                   for index, event in enumerate(group))):
        raise ValueError("Original HedgAI event sequence or content verification failed")
    content_hash = sha(source_bytes)
    if content_hash != manifest.get("contentHash"):
        raise ValueError("Archived HedgAI source bytes do not match the original content hash")
    original = manifest["payload"]
    snapshot = parse_html_snapshot(
        report_type=PRODUCT, html_body=source_bytes.decode("utf-8"), subject=original["headline"],
        received_at=datetime.fromisoformat(manifest["eventTime"].replace("Z", "+00:00")),
        message_id=manifest["sourceMessageId"], s3_key=manifest["sourceArtifact"],
    )
    data = snapshot.get("data", {}) if snapshot else {}
    publication = data.get("publication", {})
    if (publication.get("complete") is not True
            or publication.get("publicationTimeBasis") != "visible-publication-time"
            or publication.get("sourceQuality", {}).get("issues")
            or any(publication.get(field) != original.get(field)
                   for field in ("publicationId", "publicationDate", "publishedAt", "sourceUrl"))):
        raise ValueError("Reparsed HedgAI source is incomplete or changes its publication identity")
    payload = {"method": "canonical-parser-content-hash", "parserVersion": PARSER_VERSION,
               "originalMessageId": manifest["sourceMessageId"],
               "originalEvents": [{"eventKey": event["eventKey"], "verificationHash": event["verificationHash"]} for event in group],
               "sourceArtifact": manifest["sourceArtifact"], "sourceContentHash": content_hash,
               "publication": publication, "actions": data["actions"], "reaffirmations": data["reaffirmations"]}
    event_type = "HEDGAI_SOURCE_REPARSE"
    verified = verification_hash({"eventType": event_type, "payload": payload})
    message_id = f"{manifest['sourceMessageId']}#source-reparse-{verified}"
    return {"productKey": PRODUCT, "eventKey": f"{manifest['eventTime']}#{message_id}#0000",
            "eventTime": manifest["eventTime"], "sourceMessageId": message_id,
            "sequence": 0, "sourceEventCount": 1, "eventType": event_type, "payload": payload,
            "snapshotDate": original["publicationDate"], "sourceKind": "verified-source-reparse",
            "source": "hedgeye-archived-publication", "sourceArtifact": manifest["sourceArtifact"],
            "contentHash": content_hash,
            "eventHash": sha(canonical({"eventType": event_type, "payload": event_value(payload)})),
            "verificationHashVersion": "research-event-content-v1", "verificationHash": verified,
            "parserVersion": "research-event-ledger-v2:hedgai-source-reparse-v1",
            "capturedAt": captured_at or datetime.now(timezone.utc).isoformat(),
            "immutable": True, "decisionEligible": False}


def append_source_reparse(table, item):
    try:
        table.put_item(Item=decimalize(item),
                       ConditionExpression="attribute_not_exists(#p) AND attribute_not_exists(#e)",
                       ExpressionAttributeNames={"#p": "productKey", "#e": "eventKey"})
        return "imported"
    except Exception as error:
        if getattr(error, "response", {}).get("Error", {}).get("Code") != "ConditionalCheckFailedException":
            raise
        existing = table.get_item(Key={"productKey": item["productKey"], "eventKey": item["eventKey"]}, ConsistentRead=True).get("Item", {})
        if existing.get("verificationHash") != item["verificationHash"] or existing.get("eventHash") != item["eventHash"]:
            raise RuntimeError("Immutable HedgAI source repair conflicts with an existing event") from error
        return "already-imported"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--events", required=True, type=Path, help="Original unmarshalled research ledger JSON")
    parser.add_argument("--message-id", action="append", default=[], help="Bound replay to these message IDs")
    parser.add_argument("--bucket", default="market-dashboard-csv-data")
    parser.add_argument("--table", default="ResearchEventLedgerV2")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--output", type=Path, help="Save prepared repair envelopes for local projection verification")
    args = parser.parse_args()
    from aws_profile_contract import verified_session
    session = verified_session("market-dashboard-admin", purpose="admin")
    s3 = session.client("s3")
    table = session.resource("dynamodb").Table(args.table) if args.apply else None
    events = json.loads(args.events.read_text())
    groups = {}
    for event in events:
        if event.get("eventType") not in SOURCE_TYPES:
            continue
        message_id = event.get("sourceMessageId")
        if args.message_id and message_id not in args.message_id:
            continue
        groups.setdefault(message_id, []).append(event)
    if not groups:
        raise ValueError("No original publications matched the bounded replay")
    prepared = []
    # Verify every source before the first append, avoiding a partial repair
    # when any archived body or original event sequence is unverifiable.
    for group in groups.values():
        source_bytes = s3.get_object(Bucket=args.bucket, Key=group[0]["sourceArtifact"])["Body"].read()
        prepared.append(prepare_source_reparse(group, source_bytes))
    if args.output:
        args.output.write_text(json.dumps(prepared, indent=2) + "\n")
    results = [{"messageId": item["payload"]["originalMessageId"],
                "publicationId": item["payload"]["publication"]["publicationId"],
                "actions": len(item["payload"]["actions"]),
                "status": append_source_reparse(table, item) if args.apply else "preview",
                "eventKey": item["eventKey"]} for item in prepared]
    print(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
