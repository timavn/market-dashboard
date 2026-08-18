#!/usr/bin/env python3
"""Safety tests for the bounded Top 3 Things replay command."""

from __future__ import annotations

import hashlib
import io
import json
import os
import sys
import unittest
from copy import deepcopy
from pathlib import Path


os.environ.setdefault("AWS_EC2_METADATA_DISABLED", "true")
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "infra" / "scripts"))

import backfill_top_three_things as backfill  # noqa: E402


def top_three_html(label: str = "Latest") -> bytes:
    return f"""
        <html><body>
          <div>08/17/2026 08:41 AM EDT</div>
          <p>Hedgeye's Top 3 Things</p>
          <p>Opening context.</p>
          <p>1) {label} USD – Dollar body.</p>
          <p>2) {label} GOLD – Gold body.</p>
          <p>3) {label} ATHs – Highs body.</p>
          <p>VIEW LINK</p>
        </body></html>
    """.encode()


def partial_html() -> bytes:
    return b"""
        <html><body><p>Top 3 Things</p>
        <p>1) USD - First body.</p><p>2) GOLD - Second body.</p>
        </body></html>
    """


def ledger_row(
    message_id: str,
    received_at: str,
    content: bytes,
    *,
    report_type: str = "the-macro-show",
) -> dict:
    return {
        "messageId": message_id,
        "attachmentId": f"message-body-{message_id}",
        "filename": "message-body.html",
        "subject": "THE MACRO SHOW: Access Show, Slide Deck & Top 3 Things",
        "mimeType": "text/html",
        "receivedAt": received_at,
        "status": "INDEXED",
        "reportType": report_type,
        "snapshotType": report_type,
        "materializationStatus": "INDEXED",
        "materializationAttemptVersion": "gmail-materialized-v7-market-structure-archive",
        "updatedAt": "2026-08-17T13:00:00+00:00",
        "s3Bucket": "immutable-research",
        "s3Key": f"messages/{message_id}.html",
        "contentSha256": hashlib.sha256(content).hexdigest(),
        "byteSize": len(content),
    }


class FakeBody:
    def __init__(self, value: bytes) -> None:
        self.value = value

    def read(self, _limit: int | None = None) -> bytes:
        return self.value


class FakeS3:
    def __init__(self, objects: dict[tuple[str, str], bytes]) -> None:
        self.objects = objects

    def get_object(self, *, Bucket: str, Key: str) -> dict:
        return {"Body": FakeBody(self.objects[(Bucket, Key)])}


class FakeLedger:
    def __init__(self, items: dict[tuple[str, str], dict] | None = None) -> None:
        self.items = items or {}

    def get_item(self, *, Key: dict, **_kwargs) -> dict:
        key = (Key["messageId"], Key["attachmentId"])
        item = self.items.get(key)
        return {"Item": deepcopy(item)} if item else {}


class FakeLambda:
    def __init__(self) -> None:
        self.events = []

    def invoke(self, **request) -> dict:
        self.events.append(json.loads(request["Payload"]))
        response = {
            "statusCode": 200,
            "body": json.dumps(
                {
                    "status": "SUCCESS",
                    "errorCount": 0,
                    "remainingCount": 0,
                    "pollMode": "operator_replay",
                }
            ),
        }
        return {"StatusCode": 200, "Payload": io.BytesIO(json.dumps(response).encode())}


class TopThreeBackfillTests(unittest.TestCase):
    def test_latest_valid_source_wins_for_each_date(self):
        old = top_three_html("Old")
        latest = top_three_html("Latest")
        partial = partial_html()
        rows = [
            ledger_row("a" * 16, "2026-08-17T11:00:00+00:00", old),
            ledger_row("b" * 16, "2026-08-17T12:00:00+00:00", latest),
            ledger_row("c" * 16, "2026-08-17T13:00:00+00:00", partial),
        ]
        s3 = FakeS3(
            {
                (row["s3Bucket"], row["s3Key"]): content
                for row, content in zip(rows, (old, latest, partial))
            }
        )

        selected = backfill.select_latest_artifacts(s3, rows, ["2026-08-17"])
        self.assertEqual(selected[0]["messageId"], "b" * 16)
        with self.assertRaises(backfill.TopThreeBackfillFailure) as raised:
            backfill.parsed_candidate(s3, rows[2])
        self.assertEqual(raised.exception.code, "TOP_THREE_PARSE_INVALID")

    def test_selection_refuses_a_missing_visible_date(self):
        content = top_three_html()
        row = ledger_row("a" * 16, "2026-08-17T12:00:00+00:00", content)
        s3 = FakeS3({(row["s3Bucket"], row["s3Key"]): content})

        with self.assertRaises(backfill.TopThreeBackfillFailure) as raised:
            backfill.select_latest_artifacts(
                s3,
                [row],
                ["2026-08-17", "2026-08-14"],
            )
        self.assertEqual(raised.exception.code, "TOP_THREE_DATE_MISSING")

    def test_build_mismatch_is_refused(self):
        configuration = {
            "FunctionName": backfill.FUNCTION,
            "State": "Active",
            "LastUpdateStatus": "Successful",
            "Environment": {"Variables": {"BUILD_VERSION": "old"}},
        }
        with self.assertRaises(backfill.TopThreeBackfillFailure) as raised:
            backfill.validate_function(configuration, expected_build="tested")
        self.assertEqual(raised.exception.code, "GMAIL_BUILD_VERSION_MISMATCH")

    def test_busy_runtime_is_refused(self):
        state = {
            **backfill.RUNTIME_STATE_KEY,
            "status": "IN_PROGRESS",
            "activeBatchId": "active-batch",
        }
        ledger = FakeLedger(
            {
                (
                    backfill.RUNTIME_STATE_KEY["messageId"],
                    backfill.RUNTIME_STATE_KEY["attachmentId"],
                ): state
            }
        )
        with self.assertRaises(backfill.TopThreeBackfillFailure) as raised:
            backfill.require_idle_runtime(ledger)
        self.assertEqual(raised.exception.code, "GMAIL_RUNTIME_BUSY")

    def test_changed_immutable_artifact_is_refused(self):
        content = top_three_html()
        row = ledger_row("a" * 16, "2026-08-17T12:00:00+00:00", content)
        selected = backfill.parsed_candidate(
            FakeS3({(row["s3Bucket"], row["s3Key"]): content}),
            row,
        )
        changed = deepcopy(row)
        changed["contentSha256"] = "0" * 64
        ledger = FakeLedger(
            {(row["messageId"], row["attachmentId"]): changed}
        )

        with self.assertRaises(backfill.TopThreeBackfillFailure) as raised:
            backfill.verify_current_artifact(
                ledger,
                FakeS3({(row["s3Bucket"], row["s3Key"]): content}),
                selected,
            )
        self.assertEqual(raised.exception.code, "TOP_THREE_LEDGER_EVIDENCE_DRIFT")

    def test_invalid_three_item_contract_is_refused(self):
        snapshot = {
            "snapshotType": "top-3-things",
            "date": "2026-08-17",
            "itemCount": 3,
            "data": {
                "items": [
                    {"rank": 1, "title": "USD", "body": "Body"},
                    {"rank": 2, "title": "GOLD", "body": "Body"},
                    {"rank": 4, "title": "ATHs", "body": "Body"},
                ]
            },
        }
        with self.assertRaises(backfill.TopThreeBackfillFailure) as raised:
            backfill.validate_top_three_snapshot(snapshot, "2026-08-17")
        self.assertEqual(raised.exception.code, "TOP_THREE_PARSE_INVALID")

    def test_operator_replay_is_bounded_to_eight_then_two(self):
        client = FakeLambda()
        first = [f"{index:016x}" for index in range(8)]
        second = [f"{index:016x}" for index in range(8, 10)]

        self.assertEqual(backfill.invoke_batch_until_complete(client, first), 1)
        self.assertEqual(backfill.invoke_batch_until_complete(client, second), 1)
        self.assertEqual([len(event["messageIds"]) for event in client.events], [8, 2])
        self.assertTrue(all(event["forceBackfill"] for event in client.events))
        self.assertTrue(
            all(
                event["materializationVersion"] == backfill.MATERIALIZED_DATA_VERSION
                for event in client.events
            )
        )

    def test_macro_summary_fingerprint_drift_is_refused(self):
        expected = {
            "date": "2026-08-17",
            "sourceMessageId": "summary-message",
            "fingerprint": backfill.canonical_hash({"expected": True}),
        }

        class SnapshotTable:
            def get_item(self, **_kwargs):
                return {
                    "Item": {
                        "date": "2026-08-17",
                        "snapshotType": "the-macro-show",
                        "reportType": "the-macro-show",
                        "gmailMessageId": "summary-message",
                        "article": {"headline": "Summary Notes & Replay"},
                    }
                }

        with self.assertRaises(backfill.TopThreeBackfillFailure) as raised:
            backfill.verify_macro_snapshots(SnapshotTable(), [expected])
        self.assertEqual(raised.exception.code, "TOP_THREE_MACRO_SUMMARY_DRIFT")


if __name__ == "__main__":
    unittest.main()
