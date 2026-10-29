#!/usr/bin/env python3
"""Safety tests for the bounded Signal Strength replay command."""

from __future__ import annotations

import contextlib
import hashlib
import io
import json
import os
import sys
import tempfile
import unittest
from copy import deepcopy
from datetime import datetime
from pathlib import Path


os.environ.setdefault("AWS_EC2_METADATA_DISABLED", "true")
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "infra" / "scripts"))
sys.path.insert(0, str(ROOT / "infra" / "tests"))

import backfill_signal_strength as backfill  # noqa: E402
import hermes_gmail_ingestor as ingestor  # noqa: E402
from test_hermes_gmail_ingestor import FakeDynamoDb, FakeSnapshotTable  # noqa: E402


def signal_strength_html(book: str, stamp: str, tickers: list[str], *, adding: str = "") -> bytes:
    rows = "".join(
        "<tr>" + "".join(f"<td>{value}</td>" for value in (
            ticker, f"{ticker} Inc.", "Retail", "Analyst", "10/01/26", "$10.00", "$11.00", "+10.00%", "Bench", "5",
        )) + "</tr>"
        for ticker in tickers
    )
    header = "".join(f"<th>{label}</th>" for label in (
        "Ticker", "Name", "Sector", "Analyst", "Entry Date", "Entry Price",
        "Recent Price", "Total Return", "Best Idea Rank", "Days Held",
    ))
    return f"""
        <html><body>
          <div>{stamp}</div>
          <p>Signal Strength {book}: {len(tickers)} Stocks</p>
          <p><span>ADDING: </span><span>{adding}</span></p>
          <table class="open-positions-table"><thead><tr>{header}</tr></thead><tbody>{rows}</tbody></table>
        </body></html>
    """.encode()


def announcement_html() -> bytes:
    return b"<html><body><div>09/25/2026 09:42 AM EDT</div><p>Signal Strength Stocks New Dashboard is LIVE</p></body></html>"


def ledger_row(message_id: str, received_at: str, content: bytes, subject: str, *, status: str = "INDEXED") -> dict:
    return {
        "messageId": message_id,
        "attachmentId": f"message-body-{message_id}",
        "filename": "message-body.html",
        "subject": subject,
        "mimeType": "text/html",
        "receivedAt": received_at,
        "status": status,
        "reportType": "signal-strength",
        "snapshotType": "signal-strength" if status == "INDEXED" else None,
        "materializationStatus": status,
        "materializationAttemptVersion": ingestor.MATERIALIZED_DATA_VERSION,
        "securityIntelligenceParserVersion": "security-intelligence-v4-authoritative-tracker",
        "updatedAt": received_at,
        "s3Bucket": "immutable-research",
        "s3Key": f"messages/{message_id}.html",
        "contentSha256": hashlib.sha256(content).hexdigest(),
        "byteSize": len(content),
    }


class ConsistentSnapshotTable(FakeSnapshotTable):
    def get_item(self, *, Key, ConsistentRead=False):
        return super().get_item(Key=Key)

    def update_item(self, *, Key, UpdateExpression, ConditionExpression, ExpressionAttributeValues):
        item = self.items[(Key["date"], Key["snapshotType"])]
        values = ExpressionAttributeValues
        assert UpdateExpression == "SET sourceMessageIds = :kept"
        if item.get("dataVersion") != values[":version"] or item.get("sourceMessageIds") != values[":sources"]:
            raise AssertionError("condition failed")
        item["sourceMessageIds"] = list(values[":kept"])
        return {}


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
    def __init__(self, rows: list[dict]) -> None:
        self.items = {(row["messageId"], row["attachmentId"]): deepcopy(row) for row in rows}

    def get_item(self, *, Key: dict, **_kwargs) -> dict:
        item = self.items.get((Key["messageId"], Key["attachmentId"]))
        return {"Item": deepcopy(item)} if item else {}

    def scan(self, **_kwargs) -> dict:
        return {"Items": [deepcopy(item) for item in self.items.values()]}


class MaterializingLambda:
    """Stands in for the deployed ingestor: parse, merge, mark the row indexed."""

    def __init__(self, ledger: FakeLedger, s3: FakeS3, db: FakeDynamoDb) -> None:
        self.ledger, self.s3, self.db = ledger, s3, db
        self.events: list[dict] = []

    def invoke(self, **request) -> dict:
        event = json.loads(request["Payload"])
        self.events.append(event)
        for message_id in event["messageIds"]:
            row = self.ledger.items[(message_id, f"message-body-{message_id}")]
            snapshot = backfill.parse_html_snapshot(
                report_type=backfill.infer_report_type(row["filename"], row["subject"]),
                html_body=self.s3.objects[(row["s3Bucket"], row["s3Key"])].decode(),
                received_at=datetime.fromisoformat(row["receivedAt"]),
                s3_key=row["s3Key"],
                message_id=message_id,
            )
            ingestor.materialize_email_snapshot(snapshot, self.db)
            row.update({
                "status": "INDEXED", "materializationStatus": "INDEXED", "snapshotType": snapshot["snapshotType"],
                "researchParserVersion": ingestor.RESEARCH_PARSER_VERSION,
                "securityIntelligenceParserVersion": backfill.SECURITY_PARSER_VERSION,
            })
        body = {"status": "SUCCESS", "errorCount": 0, "remainingCount": 0, "pollMode": "operator_replay"}
        payload = {"statusCode": 200, "body": json.dumps(body)}
        return {"StatusCode": 200, "Payload": io.BytesIO(json.dumps(payload).encode())}


def fixture():
    editions = [
        ("1a0d8ce30d7ef18d", "2026-09-25T13:43:00+00:00", announcement_html(),
         "Signal Strength Stocks New Dashboard is LIVE", "INDEXED"),
        ("1a0d932436401752", "2026-09-25T15:31:00+00:00",
         signal_strength_html("Stocks", "09/25/2026 11:31 AM EDT", ["AKAM", "TXG"], adding="AKAM"),
         "Signal Strength Stocks: 2 Stocks", "INDEXED"),
        ("1a0d932a1ffdfb54", "2026-09-25T15:32:00+00:00",
         signal_strength_html("Stocks", "09/25/2026 11:32 AM EDT", ["TXG"]),
         "Signal Strength Stocks: 1 Stocks", "INDEXED"),
        ("1a14047012d65241", "2026-10-15T15:55:00+00:00",
         signal_strength_html("Stocks", "10/15/2026 11:55 AM EDT", ["SNOW", "V"], adding="V"),
         "Signal Strength Stocks: 2 Stocks", "INDEXED"),
        ("1a140473308a7f9c", "2026-10-15T15:56:00+00:00",
         signal_strength_html("Shorts", "10/15/2026 11:56 AM EDT", ["LULU", "MCD", "NKE"]),
         "Signal Strength Shorts: 3 Stocks", "ERROR"),
        ("1a117d99bcc773a2", "2026-10-07T19:30:00+00:00",
         signal_strength_html("Stocks", "10/07/2026 03:30 PM EDT", ["CAKE"]),
         "**Real-Time Alert: Freedman Buy Signal (Signal Strength Stock)", "INDEXED"),
        ("1a0d453363014a72", "2026-09-24T16:50:00+00:00",
         signal_strength_html("Stocks", "09/24/2026 12:50 PM EDT", ["COIN"]),
         "Signal Strength Stocks: 1 Stocks", "INDEXED"),
    ]
    rows = [ledger_row(message_id, received, content, subject, status=status)
            for message_id, received, content, subject, status in editions]
    s3 = FakeS3({(row["s3Bucket"], row["s3Key"]): content for row, (_, _, content, _, _) in zip(rows, editions)})
    return FakeLedger(rows), s3


def prepared_editions(ledger: FakeLedger, s3: FakeS3) -> list[dict]:
    editions = [
        edition
        for edition in (backfill.parsed_edition(s3, row) for row in backfill.scan_candidate_rows(ledger, "2026-09-25"))
        if edition is not None
    ]
    return sorted(editions, key=lambda item: (item["receivedAt"], item["messageId"]))


class SignalStrengthBackfillTests(unittest.TestCase):
    def test_scope_is_list_editions_since_the_format_change(self):
        ledger, s3 = fixture()
        rows = backfill.scan_candidate_rows(ledger, "2026-09-25")
        # The 2026-09-24 edition predates the change; the Real-Time Alert is its own product.
        self.assertEqual(
            sorted(row["messageId"] for row in rows),
            ["1a0d8ce30d7ef18d", "1a0d932436401752", "1a0d932a1ffdfb54", "1a14047012d65241", "1a140473308a7f9c"],
        )
        self.assertIsNone(backfill.parsed_edition(s3, ledger.items[("1a0d8ce30d7ef18d", "message-body-1a0d8ce30d7ef18d")]))
        editions = prepared_editions(ledger, s3)
        self.assertEqual([(item["side"], item["stockCount"]) for item in editions],
                         [("long", 2), ("long", 1), ("long", 2), ("short", 3)])

    def test_each_day_expects_its_latest_long_and_short_editions(self):
        ledger, s3 = fixture()
        days = backfill.expected_books(prepared_editions(ledger, s3))
        self.assertEqual([day["date"] for day in days], ["2026-09-25", "2026-10-15"])
        self.assertEqual(days[0]["long"]["messageId"], "1a0d932a1ffdfb54")
        self.assertNotIn("short", days[0])
        self.assertEqual(days[1]["short"]["stockCount"], 3)
        self.assertEqual(days[0]["long"]["sourceMessageIds"], ["1a0d932436401752", "1a0d932a1ffdfb54"])
        self.assertEqual(days[1]["short"]["sourceMessageIds"], ["1a140473308a7f9c"])

    def test_an_edition_short_of_its_published_count_is_refused(self):
        content = signal_strength_html("Stocks", "10/15/2026 11:55 AM EDT", ["SNOW", "V"]).replace(
            b": 2 Stocks", b": 3 Stocks")
        row = ledger_row("1a14047012d65241", "2026-10-15T15:55:00+00:00", content, "Signal Strength Stocks: 3 Stocks")
        with self.assertRaises(backfill.SignalStrengthBackfillFailure) as raised:
            backfill.parsed_edition(FakeS3({(row["s3Bucket"], row["s3Key"]): content}), row)
        self.assertEqual(raised.exception.code, "SIGNAL_STRENGTH_PARSE_INCOMPLETE")

    def test_receipt_round_trips_and_detects_tampering(self):
        ledger, s3 = fixture()
        editions = prepared_editions(ledger, s3)
        function = {"Environment": {"Variables": {"BUILD_VERSION": "eda1a82e"}}, "CodeSha256": "abc"}
        with tempfile.TemporaryDirectory() as directory:
            os.chmod(directory, 0o700)
            receipt, key = Path(directory) / "replay.json", Path(directory) / "replay.key"
            backfill.write_receipt(receipt, key, backfill.receipt_payload(function, "2026-09-25", editions, ["1a0d8ce30d7ef18d"]))
            self.assertEqual(len(backfill.load_receipt(receipt, key)["editions"]), 4)
            tampered = json.loads(receipt.read_text())
            tampered["days"][1]["short"]["stockCount"] = 2
            receipt.write_text(json.dumps(tampered))
            with self.assertRaises(backfill.SignalStrengthBackfillFailure) as raised:
                backfill.load_receipt(receipt, key)
            self.assertEqual(raised.exception.code, "SIGNAL_STRENGTH_RECEIPT_AUTHENTICATION_FAILED")

    def replay(self, ledger, s3, editions, table):
        client = MaterializingLambda(ledger, s3, FakeDynamoDb(table))
        pending = [edition for edition in editions if backfill.needs_replay(ledger, s3, edition)]
        for offset in range(0, len(pending), backfill.OPERATOR_BATCH_SIZE):
            backfill.invoke_batch_until_complete(client, [item["messageId"] for item in pending[offset:offset + 8]])
        self.assertFalse(any(backfill.needs_replay(ledger, s3, edition) for edition in editions))
        return pending

    def test_replay_materializes_each_book_as_its_own_product(self):
        ledger, s3 = fixture()
        editions = prepared_editions(ledger, s3)
        days = backfill.expected_books(editions)
        table = ConsistentSnapshotTable()
        # The pre-fix import left a count-only long snapshot for the day.
        table.items[("2026-10-15", "signal-strength")] = {
            "date": "2026-10-15", "snapshotType": "signal-strength", "stockCount": 2,
            "scrapedAt": "2026-10-15T15:55:00+00:00", "gmailMessageId": "1a14047012d65241",
            "data": {"added": [], "removed": [], "stocks": []},
        }

        self.assertEqual(len(self.replay(ledger, s3, editions, table)), 4)
        self.assertEqual(backfill.retire_legacy_short_sources(table, days), 0)
        backfill.verify_snapshots(table, days)
        longs = table.items[("2026-10-15", "signal-strength")]
        shorts = table.items[("2026-10-15", "signal-strength-shorts")]
        self.assertEqual([row["ticker"] for row in longs["data"]["stocks"]], ["SNOW", "V"])
        self.assertEqual([row["ticker"] for row in shorts["data"]["stocks"]], ["LULU", "MCD", "NKE"])
        self.assertEqual(shorts["stockCount"], 3)
        self.assertNotIn("shorts", longs["data"])

        shorts["data"]["stocks"].pop()
        with self.assertRaises(backfill.SignalStrengthBackfillFailure) as raised:
            backfill.verify_snapshots(table, days)
        self.assertEqual(raised.exception.code, "SIGNAL_STRENGTH_SNAPSHOT_VERIFICATION_FAILED")

    def test_replay_moves_a_pre_split_short_book_out_of_the_long_row(self):
        ledger, s3 = fixture()
        editions = prepared_editions(ledger, s3)
        days = backfill.expected_books(editions)
        table = ConsistentSnapshotTable()
        # Before the split both editions shared one row, the short book under data.shorts.
        table.items[("2026-10-15", "signal-strength")] = {
            "date": "2026-10-15", "snapshotType": "signal-strength", "stockCount": 2, "shortCount": 3,
            "scrapedAt": "2026-10-15T15:55:00+00:00", "gmailMessageId": "1a14047012d65241",
            "sourceMessageIds": ["1a14047012d65241", "1a140473308a7f9c"],
            "data": {"added": ["V"], "removed": [], "stocks": [{"ticker": "SNOW"}, {"ticker": "V"}],
                     "shorts": {"stocks": [{"ticker": "LULU"}, {"ticker": "MCD"}, {"ticker": "NKE"}]}},
        }

        self.replay(ledger, s3, editions, table)
        longs = table.items[("2026-10-15", "signal-strength")]
        self.assertNotIn("shorts", longs["data"])
        self.assertNotIn("shortCount", longs)
        # Until retired, the long row still names the short edition as a source.
        with self.assertRaises(backfill.SignalStrengthBackfillFailure):
            backfill.verify_snapshots(table, days)
        self.assertEqual(backfill.retire_legacy_short_sources(table, days), 1)
        self.assertEqual(table.items[("2026-10-15", "signal-strength")]["sourceMessageIds"], ["1a14047012d65241"])
        backfill.verify_snapshots(table, days)

    def test_changed_immutable_artifact_is_refused(self):
        ledger, s3 = fixture()
        edition = prepared_editions(ledger, s3)[0]
        ledger.items[(edition["messageId"], edition["attachmentId"])]["contentSha256"] = "0" * 64
        with self.assertRaises(backfill.SignalStrengthBackfillFailure) as raised:
            backfill.needs_replay(ledger, s3, edition)
        self.assertEqual(raised.exception.code, "SIGNAL_STRENGTH_LEDGER_EVIDENCE_DRIFT")

    def test_shared_guard_failures_are_reported_as_this_replay(self):
        error = backfill._translated(backfill.TopThreeBackfillFailure(
            "TOP_THREE_RECEIPT_UNSAFE", "Top 3 backfill requires market-dashboard-admin."))
        self.assertEqual(error.code, "SIGNAL_STRENGTH_RECEIPT_UNSAFE")
        self.assertEqual(str(error), "Signal Strength backfill requires market-dashboard-admin.")

    def test_apply_requires_the_tested_release_receipt(self):
        with tempfile.TemporaryDirectory() as directory, contextlib.redirect_stderr(io.StringIO()):
            code = backfill.main(["--apply", "--receipt", f"{directory}/r.json", "--receipt-key", f"{directory}/r.key"])
        self.assertEqual(code, 2)


if __name__ == "__main__":
    unittest.main()
