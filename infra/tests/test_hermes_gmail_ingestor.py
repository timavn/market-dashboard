#!/usr/bin/env python3
"""Focused cost-containment tests for the Hermes Gmail ingestor."""

from __future__ import annotations

import base64
import hashlib
import json
import os
import struct
import sys
import unittest
import zlib
from copy import deepcopy
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from unittest.mock import MagicMock, patch

os.environ.setdefault("AWS_EC2_METADATA_DISABLED", "true")
sys.path.insert(
    0,
    str(Path(__file__).resolve().parents[1] / "lambdas" / "gmail_ingestor"),
)

from botocore.exceptions import ClientError

import hermes_gmail_ingestor as ingestor
import parse_hedgeye_email_html as email_parser
import research_intelligence


GMAIL_FIXTURE_DIR = Path(__file__).resolve().parent / "fixtures" / "gmail"


def research_email_html(*, headline, body_html, bylines=(), stamp="11/06/2026 12:12 PM EST"):
    """A Hedgeye research email in the layout the stored ones share."""
    escaped = headline.replace("&", "&amp;")
    byline_html = "".join(
        '<table align="left" class="byline"><tr>'
        '<td class="headshot"><img src="https://hedgeye.s3.amazonaws.com/attachments/headshot.png" /></td>'
        f'<td class="details"><div class="full-name"><p>{name}</p></div>'
        f'<div class="twitter-handle"><p>{handle}</p></div></td>'
        "</tr></table>"
        for name, handle in bylines
    )
    return (
        f'<html><head><meta type="hedgeye-headline" content="{escaped}" />'
        f'<meta type="hedgeye-teaser" content="{escaped}" /></head><body>'
        "<p>This research was prepared exclusively for reader@example.com as a subscriber "
        "of Hedgeye Risk Management.</p><p>Having trouble viewing this email?</p>"
        f'<p>{stamp}</p><div class="headline">{escaped}</div>{byline_html}{body_html}'
        '<p>Please visit <a href="https://app.hedgeye.com/feed_items/189609">'
        "https://app.hedgeye.com/feed_items/189609</a> for more information.</p>"
        "<p>© 2026 Hedgeye Risk Management LLC, all rights reserved.</p></body></html>"
    )


def parse_research_email(report_type, html_body, subject):
    return email_parser.parse_html_snapshot(
        report_type=report_type,
        html_body=html_body,
        received_at=datetime(2026, 11, 6, 17, 13, tzinfo=timezone.utc),
        s3_key=f"hedgeye-email/messages/2026-11-06/{report_type}/gmail-1-message-body.html",
        message_id="gmail-1",
        subject=subject,
    )


def market_situation_signal_png(
    selections=(2, 2, 1, 0),
    *,
    width=600,
    height=240,
    centers=None,
    colors=None,
) -> bytes:
    pixels = [bytearray([255, 255, 255] * width) for _ in range(height)]
    colors = colors or ((0, 128, 0), (255, 165, 0), (255, 0, 0))
    centers = centers or (0.412, 0.585, 0.758)
    box_width = 108
    for row_index, selection_index in enumerate(selections):
        center_x = round(width * centers[selection_index])
        start_x = center_x - (box_width // 2)
        start_y = 20 + (row_index * 50)
        for y in range(start_y, start_y + 32):
            for x in range(start_x, start_x + box_width):
                offset = x * 3
                pixels[y][offset:offset + 3] = bytes(colors[selection_index])

    raw = b"".join(b"\x00" + bytes(row) for row in pixels)
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)

    def chunk(kind, payload):
        return (
            struct.pack(">I", len(payload))
            + kind
            + payload
            + struct.pack(">I", zlib.crc32(kind + payload) & 0xFFFFFFFF)
        )

    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(raw))
        + chunk(b"IEND", b"")
    )


def archive_market_situation_chart(
    *,
    chart,
    payload,
    content_type,
    extension,
    content_sha256,
):
    del chart, payload, content_type
    return {
        "id": content_sha256,
        "s3Key": (
            "hedgeye-email/assets/market-structure/"
            f"{content_sha256}.{extension}"
        ),
    }


def textract_tables_response(*tables):
    blocks = []
    for table_index, rows in enumerate(tables, start=1):
        table_blocks = []
        cell_ids = []
        for row_index, row in enumerate(rows, start=1):
            for column_index, value in enumerate(row, start=1):
                cell_id = f"table-{table_index}-cell-{row_index}-{column_index}"
                cell_ids.append(cell_id)
                cell = {
                    "BlockType": "CELL",
                    "Id": cell_id,
                    "RowIndex": row_index,
                    "ColumnIndex": column_index,
                }
                if str(value or ""):
                    word_id = f"table-{table_index}-word-{row_index}-{column_index}"
                    cell["Relationships"] = [{"Type": "CHILD", "Ids": [word_id]}]
                    table_blocks.append({
                        "BlockType": "WORD",
                        "Id": word_id,
                        "Text": str(value),
                    })
                table_blocks.append(cell)
        blocks.append({
            "BlockType": "TABLE",
            "Id": f"table-{table_index}",
            "Relationships": [{"Type": "CHILD", "Ids": cell_ids}],
        })
        blocks.extend(table_blocks)
    return {"Blocks": blocks}


def textract_table_response(rows):
    return textract_tables_response(rows)


def textract_line_response(*lines):
    return {
        "Blocks": [
            {"BlockType": "LINE", "Id": f"line-{index}", "Text": text}
            for index, text in enumerate(lines, start=1)
        ],
    }


class FakeTextract:
    def __init__(self, *responses):
        self.responses = list(responses)
        self.calls = []

    def analyze_document(self, **kwargs):
        self.calls.append(kwargs)
        if not self.responses:
            raise AssertionError("unexpected Textract request")
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return response


class FakeDetectTextract:
    def __init__(self, *responses):
        self.responses = list(responses)
        self.calls = []

    def detect_document_text(self, **kwargs):
        self.calls.append(kwargs)
        if not self.responses:
            raise AssertionError("unexpected Textract request")
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return response


def conditional_failure() -> ClientError:
    return ClientError(
        {
            "Error": {
                "Code": "ConditionalCheckFailedException",
                "Message": "conditional test failure",
            }
        },
        "PutItem",
    )


class FakeSnapshotTable:
    def __init__(self) -> None:
        self.items = {}
        self.put_count = 0

    def get_item(self, *, Key, **_kwargs):
        return {"Item": deepcopy(self.items.get((Key["date"], Key["snapshotType"]))) }

    def put_item(self, *, Item, **_kwargs):
        self.put_count += 1
        self.items[(Item["date"], Item["snapshotType"])] = deepcopy(Item)
        return {}


class FakeGuardedSnapshotTable(FakeSnapshotTable):
    def put_item(
        self,
        *,
        Item,
        ConditionExpression=None,
        ExpressionAttributeValues=None,
        **kwargs,
    ):
        key = (Item["date"], Item["snapshotType"])
        existing = self.items.get(key)
        if (
            ConditionExpression
            and existing
            and (
                existing.get("positionDataStatus")
                != (ExpressionAttributeValues or {}).get(":unavailable")
                or "positionCount" in existing
            )
        ):
            raise conditional_failure()
        return super().put_item(Item=Item, **kwargs)


class FakeDynamoDb:
    def __init__(self, table) -> None:
        self.table = table

    def Table(self, name):
        if name != "HedgeyeDailySnapshot":
            raise AssertionError(f"unexpected table: {name}")
        return self.table


class FakeWriteTable:
    def __init__(self, key_fields=()) -> None:
        self.writes = []
        self.put_calls = []
        self.key_fields = tuple(key_fields)
        self.items = {}

    def _key(self, item):
        return tuple((field, item[field]) for field in self.key_fields)

    def store_transaction_item(self, item):
        if self.key_fields:
            self.items[self._key(item)] = deepcopy(item)

    def put_item(self, *, Item, **_kwargs):
        self.writes.append(deepcopy(Item))
        self.put_calls.append({"Item": deepcopy(Item), **deepcopy(_kwargs)})
        self.store_transaction_item(Item)
        return {}

    def get_item(self, *, Key, **_kwargs):
        if not self.key_fields:
            return {}
        item = self.items.get(self._key(Key))
        return {"Item": deepcopy(item)} if item else {}


class FakeManifestTable(FakeWriteTable):
    def __init__(self, existing=None) -> None:
        super().__init__(("publicationDate", "manifestType"))
        self.existing = deepcopy(existing)
        self.reads = []
        if self.existing:
            self.store_transaction_item(self.existing)

    def put_item(self, *, Item, **kwargs):
        response = super().put_item(Item=Item, **kwargs)
        self.existing = deepcopy(Item)
        return response

    def get_item(self, *, Key, **kwargs):
        self.reads.append({"Key": deepcopy(Key), **deepcopy(kwargs)})
        return super().get_item(Key=Key, **kwargs)


class FakeRuntimeDynamoDb:
    def __init__(self, ledger) -> None:
        self.ledger = ledger
        self.heartbeat = FakeWriteTable()

    def Table(self, name):
        if name == ingestor.LEDGER_TABLE:
            return self.ledger
        if name == ingestor.HEARTBEAT_TABLE:
            return self.heartbeat
        raise AssertionError(f"unexpected table: {name}")


class FakeLambdaContext:
    def __init__(self, remaining_ms: int) -> None:
        self.remaining_ms = remaining_ms

    def get_remaining_time_in_millis(self) -> int:
        return self.remaining_ms


class SequencedLambdaContext:
    def __init__(self, remaining_values) -> None:
        self.remaining_values = list(remaining_values)

    def get_remaining_time_in_millis(self) -> int:
        if len(self.remaining_values) > 1:
            return self.remaining_values.pop(0)
        return self.remaining_values[0]


class FakeImmutableEventTable:
    def __init__(self) -> None:
        self.items = {}

    def put_item(self, *, Item, ConditionExpression=None, **_kwargs):
        key = (Item["productKey"], Item["eventKey"])
        if ConditionExpression and key in self.items:
            raise conditional_failure()
        self.items[key] = deepcopy(Item)
        return {}

    def get_item(self, *, Key, **_kwargs):
        item = self.items.get((Key["productKey"], Key["eventKey"]))
        return {"Item": deepcopy(item)} if item else {}

    def update_item(
        self,
        *,
        Key,
        ExpressionAttributeValues,
        **_kwargs,
    ):
        item = self.items[(Key["productKey"], Key["eventKey"])]
        if item.get("eventHash") != ExpressionAttributeValues[":eventHash"]:
            raise conditional_failure()
        item["verificationHashVersion"] = ExpressionAttributeValues[
            ":verificationHashVersion"
        ]
        item["verificationHash"] = ExpressionAttributeValues[":verificationHash"]
        item["sourceEventCount"] = ExpressionAttributeValues[":sourceEventCount"]
        return {}

    def query(self, *, ExpressionAttributeValues, **_kwargs):
        product_key = ExpressionAttributeValues[":productKey"]
        return {
            "Items": [
                deepcopy(item)
                for (stored_product, _), item in self.items.items()
                if stored_product == product_key
            ]
        }


class FakeEventDynamoDb:
    def __init__(self) -> None:
        self.table = FakeImmutableEventTable()

    def Table(self, name):
        if name != ingestor.RESEARCH_EVENT_LEDGER_TABLE:
            raise AssertionError(f"unexpected table: {name}")
        return self.table


class FakeTransactionClient:
    def __init__(self, tables, error=None) -> None:
        self.transactions = []
        self.client_request_tokens = []
        self.tables = tables
        self.error = error

    def transact_write_items(self, *, TransactItems, ClientRequestToken=None):
        self.transactions.append(deepcopy(TransactItems))
        self.client_request_tokens.append(ClientRequestToken)
        if self.error:
            raise self.error
        for operation in TransactItems:
            put = operation["Put"]
            self.tables[put["TableName"]].store_transaction_item(put["Item"])
        return {}


class FakeRiskRangeDynamoDb:
    def __init__(self, transaction_error=None, existing_manifest=None) -> None:
        self.tables = {
            "HedgeyeDailySnapshot": FakeWriteTable(("date", "snapshotType")),
            "HedgeyeRiskRanges": FakeWriteTable(("date", "ticker")),
            "RiskRangeData": FakeWriteTable(("ticker", "date")),
            "RiskRangePublicationManifestsV2": FakeManifestTable(
                existing_manifest
            ),
        }
        self.meta = type(
            "Meta",
            (),
            {"client": FakeTransactionClient(self.tables, transaction_error)},
        )()

    def Table(self, name):
        return self.tables[name]


class FakeLedgerTable:
    def __init__(self, items=None) -> None:
        self.items = {
            (item["messageId"], item["attachmentId"]): deepcopy(item)
            for item in (items or [])
        }

    def query(self, **kwargs):
        message_id = kwargs["ExpressionAttributeValues"][":messageId"]
        return {
            "Items": [
                deepcopy(item)
                for (stored_message_id, _), item in self.items.items()
                if stored_message_id == message_id
            ]
        }

    def get_item(self, *, Key, **_kwargs):
        item = self.items.get((Key["messageId"], Key["attachmentId"]))
        return {"Item": deepcopy(item)} if item else {}

    def put_item(
        self,
        *,
        Item,
        ConditionExpression=None,
        ExpressionAttributeValues=None,
        **_kwargs,
    ):
        key = (Item["messageId"], Item["attachmentId"])
        existing = self.items.get(key)
        if ConditionExpression and existing:
            values = ExpressionAttributeValues or {}
            allows_cas_reclaim = (
                values.get(":inProgress") == existing.get("status")
                and values.get(":expectedUpdatedAt") == existing.get("updatedAt")
            )
            allows_queue_claim = (
                values.get(":expectedStatus") == existing.get("status")
                and values.get(":expectedUpdatedAt") == existing.get("updatedAt")
            )
            allows_queue_checkpoint = (
                values.get(":inProgress") == existing.get("status")
                and values.get(":claimedAt") == existing.get("updatedAt")
            )
            allows_error_retry = (
                (
                    values.get(":error") == existing.get("status")
                    or values.get(":textractError") == existing.get("status")
                )
                and values.get(":expectedUpdatedAt") == existing.get("updatedAt")
            )
            if not (
                allows_error_retry
                or allows_cas_reclaim
                or allows_queue_claim
                or allows_queue_checkpoint
            ):
                raise conditional_failure()
        self.items[key] = deepcopy(Item)
        return {}

    def update_item(
        self,
        *,
        Key,
        ExpressionAttributeNames,
        ExpressionAttributeValues,
        **_kwargs,
    ):
        key = (Key["messageId"], Key["attachmentId"])
        item = self.items.setdefault(key, deepcopy(Key))
        for value_key, value in ExpressionAttributeValues.items():
            suffix = value_key.removeprefix(":v")
            if value_key == ":status":
                item["status"] = value
            elif value_key == ":updatedAt":
                item["updatedAt"] = value
            elif suffix.isdigit():
                item[ExpressionAttributeNames[f"#n{suffix}"]] = value
        return {}


def rta_snapshot(message_id: str, scraped_at: str, action: str) -> dict:
    alert = {
        "headline": f"{action} SIGNAL XYZ",
        "ticker": "XYZ",
        "action": action,
        "side": "long",
    }
    return {
        "date": "2026-07-15",
        "snapshotType": "real-time-alert",
        "scrapedAt": scraped_at,
        "publishedAt": "2026-07-15",
        "source": "gmail-html",
        "htmlSource": f"message-{message_id}.html",
        "gmailMessageId": message_id,
        "article": {"headline": alert["headline"]},
        "reportType": "real-time-alert",
        "itemCount": 1,
        "data": {"headline": alert["headline"], "alert": alert, "alerts": [alert]},
    }


def etf_snapshot(message_id: str, scraped_at: str, action: str) -> dict:
    change = {
        "ticker": "SPY",
        "etf": "SPDR S&P 500",
        "side": "Long",
        "call": "Long",
        "action": action,
    }
    return {
        "date": "2026-07-15",
        "snapshotType": "etf-pro",
        "scrapedAt": scraped_at,
        "source": "gmail-html",
        "htmlSource": f"message-{message_id}.html",
        "gmailMessageId": message_id,
        "article": {"headline": f"ETF Pro {action}"},
        "reportType": "etf-pro",
        "itemCount": 1,
        "changeCount": 1,
        "data": {
            "changes": [change],
            "rows": [{**change, "id": "SPY_0"}],
            "added": ["SPY"] if action == "ADD" else [],
            "removed": ["SPY"] if action == "REMOVE" else [],
            "addedLongs": ["SPY"] if action == "ADD" else [],
            "removedLongs": ["SPY"] if action == "REMOVE" else [],
            "addedShorts": [],
            "removedShorts": [],
        },
    }


def etf_full_book_snapshot(message_id: str, scraped_at: str) -> dict:
    rows = [
        {
            "id": "SPY_0",
            "ticker": "SPY",
            "etf": "S&P 500",
            "call": "Long",
            "side": "Long",
            "action": None,
        },
        {
            "id": "TLT_1",
            "ticker": "TLT",
            "etf": "US Treasury Long",
            "call": "Short",
            "side": "Short",
            "action": None,
        },
    ]
    return {
        "date": "2026-07-15",
        "snapshotType": "etf-pro",
        "scrapedAt": scraped_at,
        "publishedAt": scraped_at,
        "source": "gmail-html",
        "sourceKind": "full-book-checkpoint",
        "htmlSource": f"message-{message_id}.html",
        "gmailMessageId": message_id,
        "article": {"headline": "ETF Pro Plus - New Weekly Report"},
        "reportType": "etf-pro",
        "itemCount": len(rows),
        "changeCount": 0,
        "data": {
            "headline": "ETF Pro Plus - New Weekly Report",
            "checkpointAvailable": True,
            "rows": rows,
            "changes": [],
            "fullBookLongs": ["SPY"],
            "fullBookShorts": ["TLT"],
        },
    }


def top_three_snapshot(message_id: str, scraped_at: str, label: str) -> dict:
    return {
        "date": "2026-08-17",
        "snapshotType": "top-3-things",
        "scrapedAt": scraped_at,
        "publishedAt": "2026-08-17T00:00:00+00:00",
        "source": "gmail-html",
        "htmlSource": f"message-{message_id}.html",
        "gmailMessageId": message_id,
        "article": {"headline": f"Top 3 Things {label}"},
        "reportType": "top-3-things",
        "itemCount": 3,
        "data": {
            "items": [
                {"rank": 1, "title": f"{label} One", "body": "First item."},
                {"rank": 2, "title": f"{label} Two", "body": "Second item."},
                {"rank": 3, "title": f"{label} Three", "body": "Third item."},
            ],
        },
    }


class HermesGmailIngestorTests(unittest.TestCase):
    def setUp(self) -> None:
        self.metadata_patcher = patch.object(
            ingestor,
            "get_message_metadata",
            return_value={"payload": {"headers": []}},
        )
        self.metadata_patcher.start()

    def tearDown(self) -> None:
        self.metadata_patcher.stop()
        ingestor.clear_oauth_secret_cache()

    def test_oauth_secret_is_cached_for_warm_invocations(self):
        secret_client = MagicMock()
        secret_client.get_secret_value.return_value = {
            "SecretString": json.dumps(
                {
                    "client_id": "client",
                    "client_secret": "secret",
                    "refresh_token": "refresh",
                    "user_id": "me",
                }
            )
        }

        with patch.object(ingestor, "secretsmanager", secret_client), patch.object(
            ingestor.time, "monotonic", return_value=100.0
        ):
            first = ingestor.load_oauth_secret()
            first["client_id"] = "mutated-by-caller"
            second = ingestor.load_oauth_secret()

        self.assertEqual(second["client_id"], "client")
        self.assertEqual(secret_client.get_secret_value.call_count, 1)

    def test_gmail_profile_requires_exact_normalized_configured_account(self):
        with patch.object(
            ingestor,
            "http_json",
            return_value={
                "emailAddress": "  TimSmithAviation@GMAIL.COM ",
                "historyId": 124,
            },
        ) as request:
            history_id = ingestor.get_profile_history_id("access", "me")

        self.assertEqual(history_id, "124")
        request.assert_called_once_with(
            "GET",
            ingestor.gmail_path("me", "profile"),
            access_token="access",
        )

        for profile in (
            {"historyId": "125"},
            {"emailAddress": "different-account@gmail.com", "historyId": "126"},
        ):
            with self.subTest(profile=profile), patch.object(
                ingestor,
                "http_json",
                return_value=profile,
            ):
                with self.assertRaises(ingestor.GmailAccountProvenanceError) as raised:
                    ingestor.get_profile_history_id("access", "me")
                self.assertEqual(
                    ingestor.classify_runtime_error(raised.exception),
                    "GMAIL_ACCOUNT_MISMATCH",
                )

    def test_zero_message_history_poll_writes_success_heartbeat_without_full_query(self):
        ledger = FakeLedgerTable()
        database = FakeRuntimeDynamoDb(ledger)
        secret = {
            "client_id": "client",
            "client_secret": "secret",
            "refresh_token": "refresh",
            "user_id": "me",
            "_secret_version": "version-2",
        }

        with patch.object(ingestor, "dynamodb", database), patch.object(
            ingestor, "cloudwatch", MagicMock()
        ), patch.object(ingestor, "load_oauth_secret", return_value=secret), patch.object(
            ingestor, "refresh_access_token", return_value="access"
        ), patch.object(
            ingestor, "read_ingestion_state", return_value={"status": "READY", "historyId": "123"}
        ), patch.object(ingestor, "resolve_label_id", return_value="Label_1"), patch.object(
            ingestor, "list_history_message_ids", return_value=[]
        ), patch.object(ingestor, "list_message_ids") as list_messages, patch.object(
            ingestor, "get_profile_history_id", return_value="124"
        ) as get_profile:
            response = ingestor.lambda_handler({
                "source": "aws-scheduler",
                "scheduleId": ingestor.GMAIL_SCHEDULE_ID,
            }, None)

        body = json.loads(response["body"])
        list_messages.assert_not_called()
        get_profile.assert_called_once_with("access", "me")
        self.assertEqual(body["pollMode"], "history")
        self.assertEqual(body["messageCount"], 0)
        self.assertEqual(body["historyId"], "124")
        state = ledger.items[(
            ingestor.RUNTIME_STATE_MESSAGE_ID,
            ingestor.HISTORY_CURSOR_ATTACHMENT_ID,
        )]
        self.assertEqual(state["historyId"], "124")
        self.assertEqual(database.heartbeat.writes[-1]["status"], "success")
        self.assertEqual(database.heartbeat.writes[-1]["serviceId"], ingestor.GMAIL_SERVICE_ID)
        self.assertEqual(database.heartbeat.writes[-1]["triggerSource"], "aws-scheduler")
        self.assertIn("authVerifiedAt", database.heartbeat.writes[-1])

    def test_scheduled_first_run_seeds_cursor_without_historical_query(self):
        ledger = FakeLedgerTable()
        database = FakeRuntimeDynamoDb(ledger)
        secret = {
            "client_id": "client",
            "client_secret": "secret",
            "refresh_token": "refresh",
            "user_id": "me",
            "_secret_version": "version-bootstrap",
        }

        with patch.object(ingestor, "dynamodb", database), patch.object(
            ingestor, "cloudwatch", MagicMock()
        ), patch.object(
            ingestor, "load_oauth_secret", return_value=secret
        ), patch.object(
            ingestor, "refresh_access_token", return_value="access"
        ), patch.object(
            ingestor, "get_profile_history_id", return_value="500"
        ), patch.object(
            ingestor, "resolve_label_id"
        ) as resolve_label, patch.object(
            ingestor, "list_message_ids"
        ) as list_messages, patch.object(
            ingestor, "list_history_message_ids"
        ) as list_history, patch.object(
            ingestor, "process_message"
        ) as process_message:
            response = ingestor.lambda_handler(
                {
                    "source": "aws-scheduler",
                    "scheduleId": ingestor.GMAIL_SCHEDULE_ID,
                },
                None,
            )

        body = json.loads(response["body"])
        self.assertEqual(response["statusCode"], 200)
        self.assertEqual(body["status"], "SUCCESS")
        self.assertEqual(body["pollMode"], "cursor_bootstrap")
        self.assertEqual(body["historyId"], "500")
        self.assertEqual(body["messageCount"], 0)
        resolve_label.assert_not_called()
        list_messages.assert_not_called()
        list_history.assert_not_called()
        process_message.assert_not_called()
        state = ledger.items[(
            ingestor.RUNTIME_STATE_MESSAGE_ID,
            ingestor.HISTORY_CURSOR_ATTACHMENT_ID,
        )]
        self.assertEqual(state["status"], "READY")
        self.assertEqual(state["historyId"], "500")
        self.assertEqual(state["pollMode"], "cursor_bootstrap")
        heartbeat = database.heartbeat.writes[-1]
        self.assertEqual(heartbeat["status"], "success")
        self.assertTrue(heartbeat["scheduled"])

    def test_scheduled_expired_cursor_opens_circuit_without_full_query(self):
        ledger = FakeLedgerTable([{
            "messageId": ingestor.RUNTIME_STATE_MESSAGE_ID,
            "attachmentId": ingestor.HISTORY_CURSOR_ATTACHMENT_ID,
            "status": "READY",
            "historyId": "100",
            "createdAt": "2026-07-27T12:00:00+00:00",
            "updatedAt": "2026-07-27T12:00:00+00:00",
        }])
        database = FakeRuntimeDynamoDb(ledger)
        secret = {
            "client_id": "client",
            "client_secret": "secret",
            "refresh_token": "refresh",
            "user_id": "me",
            "_secret_version": "version-expired",
        }
        expired = RuntimeError(
            "GET Gmail history failed with HTTP 404: start historyId expired"
        )

        with patch.object(ingestor, "dynamodb", database), patch.object(
            ingestor, "cloudwatch", MagicMock()
        ), patch.object(
            ingestor, "load_oauth_secret", return_value=secret
        ), patch.object(
            ingestor, "refresh_access_token", return_value="access"
        ) as refresh_token, patch.object(
            ingestor, "get_profile_history_id", return_value="200"
        ) as get_profile, patch.object(
            ingestor, "resolve_label_id", return_value="Label_1"
        ), patch.object(
            ingestor, "list_history_message_ids", side_effect=expired
        ) as list_history, patch.object(
            ingestor, "list_message_ids"
        ) as list_messages:
            first = ingestor.lambda_handler(
                {
                    "source": "aws-scheduler",
                    "scheduleId": ingestor.GMAIL_SCHEDULE_ID,
                },
                None,
            )
            second = ingestor.lambda_handler(
                {
                    "source": "aws-scheduler",
                    "scheduleId": ingestor.GMAIL_SCHEDULE_ID,
                },
                None,
            )

        for response in (first, second):
            body = json.loads(response["body"])
            self.assertEqual(response["statusCode"], 409)
            self.assertEqual(body["status"], "ERROR")
            self.assertEqual(
                body["errorCode"],
                "GMAIL_HISTORY_CURSOR_EXPIRED",
            )
            self.assertEqual(body["pollMode"], "cursor_reset_required")
        self.assertEqual(refresh_token.call_count, 1)
        self.assertEqual(get_profile.call_count, 1)
        self.assertEqual(list_history.call_count, 1)
        list_messages.assert_not_called()
        state = ledger.items[(
            ingestor.RUNTIME_STATE_MESSAGE_ID,
            ingestor.HISTORY_CURSOR_ATTACHMENT_ID,
        )]
        self.assertEqual(state["status"], "ERROR")
        self.assertEqual(state["historyId"], "100")
        self.assertEqual(state["errorCode"], "GMAIL_HISTORY_CURSOR_EXPIRED")
        self.assertIsNone(state["activeBatchId"])
        self.assertTrue(all(
            heartbeat["status"] == "error"
            and heartbeat["errorCode"] == "GMAIL_HISTORY_CURSOR_EXPIRED"
            for heartbeat in database.heartbeat.writes[-2:]
        ))

    def test_auth_probe_validates_oauth_without_listing_or_materializing_messages(self):
        ledger = FakeLedgerTable()
        database = FakeRuntimeDynamoDb(ledger)
        secret = {
            "client_id": "client",
            "client_secret": "secret",
            "refresh_token": "refresh",
            "user_id": "me",
            "_secret_version": "version-probe",
        }

        with patch.object(ingestor, "dynamodb", database), patch.object(
            ingestor, "cloudwatch", MagicMock()
        ), patch.object(
            ingestor, "load_oauth_secret", return_value=secret
        ) as load_secret, patch.object(
            ingestor, "refresh_access_token", return_value="access"
        ), patch.object(
            ingestor, "read_ingestion_state", return_value={}
        ) as read_state, patch.object(
            ingestor, "get_profile_history_id", return_value="profile-history"
        ) as get_profile, patch.object(
            ingestor, "list_message_ids"
        ) as list_messages, patch.object(
            ingestor, "list_history_message_ids"
        ) as list_history, patch.object(
            ingestor, "process_message"
        ) as process_message, patch.object(
            ingestor, "write_ingestion_state"
        ) as write_state:
            response = ingestor.lambda_handler(
                {
                    "source": "activation-canary",
                    "scheduleId": "market-dashboard-gmail-v2-activation-canary",
                    "authProbeOnly": True,
                    "forceAuthProbe": True,
                },
                None,
            )

        body = json.loads(response["body"])
        self.assertEqual(response["statusCode"], 200)
        self.assertEqual(body["status"], "SUCCESS")
        self.assertEqual(body["pollMode"], "auth_probe")
        load_secret.assert_called_once_with(force_refresh=True)
        read_state.assert_not_called()
        get_profile.assert_called_once_with("access", "me")
        list_messages.assert_not_called()
        list_history.assert_not_called()
        process_message.assert_not_called()
        write_state.assert_not_called()
        heartbeat = database.heartbeat.writes[-1]
        self.assertEqual(heartbeat["status"], "success")
        self.assertEqual(
            heartbeat["serviceId"],
            f"{ingestor.GMAIL_SERVICE_ID}:manual",
        )
        self.assertFalse(heartbeat["scheduled"])
        self.assertIn("authVerifiedAt", heartbeat)
        self.assertIsNotNone(datetime.fromisoformat(heartbeat["authVerifiedAt"]))

    def test_auth_probe_success_and_failure_never_hide_heartbeat_store_failure(self):
        secret = {
            "client_id": "client",
            "client_secret": "secret",
            "refresh_token": "refresh",
            "user_id": "me",
            "_secret_version": "version-heartbeat-failure",
        }
        for profile_result in (
            "profile-history",
            RuntimeError(
                "GET Gmail profile failed with HTTP 403: insufficientPermissions"
            ),
        ):
            with self.subTest(profile_result=type(profile_result).__name__):
                database = FakeRuntimeDynamoDb(FakeLedgerTable())
                database.heartbeat.put_item = MagicMock(
                    side_effect=RuntimeError("heartbeat table unavailable")
                )
                profile_kwargs = (
                    {"side_effect": profile_result}
                    if isinstance(profile_result, Exception)
                    else {"return_value": profile_result}
                )
                with patch.object(
                    ingestor, "dynamodb", database
                ), patch.object(
                    ingestor, "cloudwatch", MagicMock()
                ), patch.object(
                    ingestor, "load_oauth_secret", return_value=secret
                ), patch.object(
                    ingestor, "refresh_access_token", return_value="access"
                ), patch.object(
                    ingestor,
                    "get_profile_history_id",
                    **profile_kwargs,
                ):
                    response = ingestor.lambda_handler(
                        {
                            "source": "activation-canary",
                            "scheduleId": (
                                "market-dashboard-gmail-v2-activation-canary"
                            ),
                            "authProbeOnly": True,
                            "forceAuthProbe": True,
                        },
                        None,
                    )

                body = json.loads(response["body"])
                self.assertEqual(response["statusCode"], 503)
                self.assertEqual(body["status"], "ERROR")
                self.assertEqual(
                    body["errorCode"],
                    "GMAIL_HEARTBEAT_WRITE_FAILED",
                )

    def test_heartbeat_store_failure_emits_no_authoritative_heartbeat_metric(self):
        database = FakeRuntimeDynamoDb(FakeLedgerTable())
        database.heartbeat.put_item = MagicMock(
            side_effect=RuntimeError("heartbeat table unavailable")
        )
        metrics = MagicMock()

        with patch.object(ingestor, "dynamodb", database), patch.object(
            ingestor, "cloudwatch", metrics
        ):
            written = ingestor.write_service_heartbeat(
                started_at="2026-07-27T12:00:00+00:00",
                status="success",
                trigger_source="aws-scheduler",
                schedule_id=ingestor.GMAIL_SCHEDULE_ID,
            )

        self.assertFalse(written)
        metric_data = metrics.put_metric_data.call_args.kwargs["MetricData"]
        metric_values = {
            item["MetricName"]: item["Value"]
            for item in metric_data
        }
        self.assertNotIn("Heartbeat", metric_values)
        self.assertEqual(metric_values["Healthy"], 0)
        self.assertEqual(metric_values["HeartbeatWriteFailure"], 1)

    def test_forced_auth_probe_uses_new_awscurrent_instead_of_cached_old_secret(self):
        ledger = FakeLedgerTable()
        database = FakeRuntimeDynamoDb(ledger)
        cached_secret = {
            "client_id": "cached-client",
            "client_secret": "cached-secret",
            "refresh_token": "cached-refresh",
            "user_id": "me",
            "_secret_version": "cached-old-version",
        }
        current_secret = {
            "client_id": "current-client",
            "client_secret": "current-secret",
            "refresh_token": "current-refresh",
            "user_id": "me",
            "_secret_version": "new-awscurrent-version",
        }

        def load_secret(*, force_refresh=False):
            return current_secret if force_refresh else cached_secret

        with patch.object(ingestor, "dynamodb", database), patch.object(
            ingestor, "cloudwatch", MagicMock()
        ), patch.object(
            ingestor, "load_oauth_secret", side_effect=load_secret
        ) as secret_loader, patch.object(
            ingestor, "refresh_access_token", return_value="current-access"
        ) as refresh, patch.object(
            ingestor, "read_ingestion_state"
        ) as read_state, patch.object(
            ingestor, "get_profile_history_id", return_value="profile-history"
        ) as get_profile, patch.object(
            ingestor, "list_message_ids"
        ) as list_messages:
            response = ingestor.lambda_handler(
                {
                    "source": "activation-canary",
                    "scheduleId": "market-dashboard-gmail-v2-activation-canary",
                    "authProbeOnly": True,
                    "forceAuthProbe": True,
                },
                None,
            )

        self.assertEqual(response["statusCode"], 200)
        self.assertEqual(json.loads(response["body"])["status"], "SUCCESS")
        secret_loader.assert_called_once_with(force_refresh=True)
        refresh.assert_called_once_with(current_secret)
        get_profile.assert_called_once_with("current-access", "me")
        read_state.assert_not_called()
        list_messages.assert_not_called()
        self.assertEqual(
            database.heartbeat.writes[-1]["secretVersion"],
            "new-awscurrent-version",
        )
        self.assertIn("authVerifiedAt", database.heartbeat.writes[-1])

    def test_auth_probe_reports_insufficient_readonly_scope_with_typed_failure(self):
        ledger = FakeLedgerTable()
        database = FakeRuntimeDynamoDb(ledger)
        secret = {
            "client_id": "client",
            "client_secret": "secret",
            "refresh_token": "refresh",
            "user_id": "me",
            "_secret_version": "version-probe",
        }

        with patch.object(ingestor, "dynamodb", database), patch.object(
            ingestor, "cloudwatch", MagicMock()
        ), patch.object(ingestor, "load_oauth_secret", return_value=secret), patch.object(
            ingestor, "refresh_access_token", return_value="access"
        ), patch.object(
            ingestor, "read_ingestion_state", return_value={}
        ), patch.object(
            ingestor,
            "get_profile_history_id",
            side_effect=RuntimeError(
                "GET Gmail profile failed with HTTP 403: insufficientPermissions"
            ),
        ), patch.object(
            ingestor, "list_message_ids"
        ) as list_messages:
            response = ingestor.lambda_handler(
                {
                    "source": "activation-canary",
                    "scheduleId": "market-dashboard-gmail-v2-activation-canary",
                    "authProbeOnly": True,
                    "forceAuthProbe": True,
                },
                None,
            )

        body = json.loads(response["body"])
        self.assertEqual(response["statusCode"], 503)
        self.assertEqual(body["status"], "ERROR")
        self.assertEqual(body["errorCode"], "GMAIL_SCOPE_INSUFFICIENT")
        list_messages.assert_not_called()
        self.assertEqual(
            database.heartbeat.writes[-1]["errorCode"],
            "GMAIL_SCOPE_INSUFFICIENT",
        )
        self.assertNotIn("authVerifiedAt", database.heartbeat.writes[-1])

    def test_auth_probe_rejects_wrong_or_missing_profile_account_without_success(self):
        secret = {
            "client_id": "client",
            "client_secret": "secret",
            "refresh_token": "refresh",
            "user_id": "me",
            "_secret_version": "version-probe",
        }
        for profile in (
            {"historyId": "200"},
            {"emailAddress": "different-account@gmail.com", "historyId": "201"},
        ):
            with self.subTest(profile=profile):
                database = FakeRuntimeDynamoDb(FakeLedgerTable())
                with patch.object(ingestor, "dynamodb", database), patch.object(
                    ingestor, "cloudwatch", MagicMock()
                ), patch.object(
                    ingestor, "load_oauth_secret", return_value=secret
                ), patch.object(
                    ingestor, "refresh_access_token", return_value="access"
                ), patch.object(
                    ingestor, "http_json", return_value=profile
                ), patch.object(
                    ingestor, "list_message_ids"
                ) as list_messages, patch.object(
                    ingestor, "process_message"
                ) as process_message:
                    response = ingestor.lambda_handler(
                        {
                            "source": "activation-canary",
                            "scheduleId": "market-dashboard-gmail-v2-activation-canary",
                            "authProbeOnly": True,
                            "forceAuthProbe": True,
                        },
                        None,
                    )

                body = json.loads(response["body"])
                self.assertEqual(response["statusCode"], 503)
                self.assertEqual(body["status"], "ERROR")
                self.assertEqual(body["errorCode"], "GMAIL_ACCOUNT_MISMATCH")
                list_messages.assert_not_called()
                process_message.assert_not_called()
                self.assertTrue(database.heartbeat.writes)
                self.assertTrue(all(
                    heartbeat["status"] == "error"
                    and heartbeat["errorCode"] == "GMAIL_ACCOUNT_MISMATCH"
                    and "authVerifiedAt" not in heartbeat
                    for heartbeat in database.heartbeat.writes
                ))

    def test_scheduled_ingestion_reports_wrong_or_missing_profile_before_mailbox_reads(self):
        secret = {
            "client_id": "client",
            "client_secret": "secret",
            "refresh_token": "refresh",
            "user_id": "me",
            "_secret_version": "version-scheduled",
        }
        for profile in (
            {"historyId": "300"},
            {"emailAddress": "different-account@gmail.com", "historyId": "301"},
        ):
            with self.subTest(profile=profile):
                database = FakeRuntimeDynamoDb(FakeLedgerTable())
                with patch.object(ingestor, "dynamodb", database), patch.object(
                    ingestor, "cloudwatch", MagicMock()
                ), patch.object(
                    ingestor, "load_oauth_secret", return_value=secret
                ), patch.object(
                    ingestor, "refresh_access_token", return_value="access"
                ), patch.object(
                    ingestor, "read_ingestion_state", return_value={}
                ), patch.object(
                    ingestor, "http_json", return_value=profile
                ), patch.object(
                    ingestor, "list_message_ids"
                ) as list_messages, patch.object(
                    ingestor, "process_message"
                ) as process_message, patch.object(
                    ingestor, "write_ingestion_state"
                ) as write_state:
                    response = ingestor.lambda_handler(
                        {
                            "source": "aws-scheduler",
                            "scheduleId": ingestor.GMAIL_SCHEDULE_ID,
                        },
                        None,
                    )

                body = json.loads(response["body"])
                self.assertEqual(response["statusCode"], 503)
                self.assertEqual(body["status"], "ERROR")
                self.assertEqual(body["errorCode"], "GMAIL_ACCOUNT_MISMATCH")
                list_messages.assert_not_called()
                process_message.assert_not_called()
                write_state.assert_not_called()
                self.assertTrue(database.heartbeat.writes)
                self.assertTrue(all(
                    heartbeat["status"] == "error"
                    and heartbeat["errorCode"] == "GMAIL_ACCOUNT_MISMATCH"
                    and heartbeat["accountEmail"] == ingestor.GMAIL_ACCOUNT
                    for heartbeat in database.heartbeat.writes
                ))

    def test_history_listing_returns_one_resumable_page(self):
        first = {
            "history": [{
                "id": "101",
                "messagesAdded": [
                    {"message": {"id": f"m-{index:04d}"}}
                    for index in range(500)
                ],
            }],
            "nextPageToken": "page-2",
            "historyId": "150",
        }
        second = {
            "history": [{
                "id": "151",
                "messagesAdded": [
                    {"message": {"id": f"m-{index:04d}"}}
                    for index in range(500, 625)
                ],
            }],
            "historyId": "200",
        }
        with patch.object(ingestor, "http_json", side_effect=[first, second]) as request:
            first_page = ingestor.list_history_message_ids(
                "access",
                "me",
                "100",
                label_id="Label_1",
            )
            second_page = ingestor.list_history_message_ids(
                "access",
                "me",
                "100",
                label_id="Label_1",
                page_token=first_page.next_page_token,
            )

        self.assertEqual(len(first_page), 500)
        self.assertEqual(first_page[0], "m-0000")
        self.assertEqual(first_page[-1], "m-0499")
        self.assertEqual(first_page.next_page_token, "page-2")
        self.assertEqual(len(second_page), 125)
        self.assertEqual(second_page[0], "m-0500")
        self.assertEqual(second_page[-1], "m-0624")
        self.assertIsNone(second_page.next_page_token)
        self.assertEqual(request.call_count, 2)
        self.assertEqual(request.call_args_list[1].kwargs["params"]["pageToken"], "page-2")

    def test_multi_page_history_discovery_is_durable_and_resumes_before_processing(self):
        ledger = FakeLedgerTable([{
            "messageId": ingestor.RUNTIME_STATE_MESSAGE_ID,
            "attachmentId": ingestor.HISTORY_CURSOR_ATTACHMENT_ID,
            "status": "READY",
            "historyId": "100",
            "createdAt": "2026-07-27T12:00:00+00:00",
            "updatedAt": "2026-07-27T12:00:00+00:00",
        }])
        database = FakeRuntimeDynamoDb(ledger)
        secret = {
            "client_id": "client",
            "client_secret": "secret",
            "refresh_token": "refresh",
            "user_id": "me",
            "_secret_version": "version-multipage",
        }
        processed = []

        def process(_token, _user_id, message_id, _table, **_kwargs):
            processed.append(message_id)
            return {"stored": [], "skipped": []}

        pages = [
            ingestor.GmailDiscoveryPage(
                ["oldest", "middle"],
                next_page_token="history-page-2",
            ),
            ingestor.GmailDiscoveryPage(
                ["newest"],
                next_page_token=None,
            ),
        ]
        with patch.object(ingestor, "dynamodb", database), patch.object(
            ingestor, "cloudwatch", MagicMock()
        ), patch.object(
            ingestor, "load_oauth_secret", return_value=secret
        ), patch.object(
            ingestor, "refresh_access_token", return_value="access"
        ), patch.object(
            ingestor, "get_profile_history_id", side_effect=["200", "201"]
        ), patch.object(
            ingestor, "resolve_label_id", return_value="Label_1"
        ) as resolve_label, patch.object(
            ingestor, "list_history_message_ids", side_effect=pages
        ) as list_history, patch.object(
            ingestor, "process_message", side_effect=process
        ):
            first = ingestor.lambda_handler({
                "source": "aws-scheduler",
                "scheduleId": ingestor.GMAIL_SCHEDULE_ID,
            }, None)
            state_after_first = deepcopy(ledger.items[(
                ingestor.RUNTIME_STATE_MESSAGE_ID,
                ingestor.HISTORY_CURSOR_ATTACHMENT_ID,
            )])
            first_queue = [
                deepcopy(item)
                for item in ledger.items.values()
                if item.get("batchId")
            ]
            second = ingestor.lambda_handler({
                "source": "aws-scheduler",
                "scheduleId": ingestor.GMAIL_SCHEDULE_ID,
            }, None)

        first_body = json.loads(first["body"])
        second_body = json.loads(second["body"])
        self.assertEqual(first_body["status"], "IN_PROGRESS")
        self.assertEqual(first_body["errorCode"], "GMAIL_DISCOVERY_PENDING")
        self.assertEqual(processed, ["oldest", "middle", "newest"])
        self.assertEqual(state_after_first["historyId"], "100")
        self.assertEqual(state_after_first["discoveryCursorBefore"], "100")
        self.assertEqual(state_after_first["discoveryTargetHistoryId"], "200")
        self.assertEqual(state_after_first["discoveryPageToken"], "history-page-2")
        self.assertEqual(state_after_first["discoveryNextSequence"], 2)
        self.assertEqual(state_after_first["discoveryMode"], "history")
        self.assertEqual(len(first_queue), 2)
        self.assertTrue(all(item["status"] == "PENDING" for item in first_queue))
        self.assertEqual(second_body["status"], "SUCCESS")
        self.assertEqual(second_body["historyId"], "200")
        final_state = ledger.items[(
            ingestor.RUNTIME_STATE_MESSAGE_ID,
            ingestor.HISTORY_CURSOR_ATTACHMENT_ID,
        )]
        self.assertEqual(final_state["historyId"], "200")
        self.assertIsNone(final_state["activeBatchId"])
        resolve_label.assert_called_once()
        self.assertEqual(list_history.call_count, 2)
        self.assertEqual(
            list_history.call_args_list[1].kwargs["page_token"],
            "history-page-2",
        )

    def test_multi_page_forced_query_processes_globally_oldest_first(self):
        ledger = FakeLedgerTable()
        database = FakeRuntimeDynamoDb(ledger)
        secret = {
            "client_id": "client",
            "client_secret": "secret",
            "refresh_token": "refresh",
            "user_id": "me",
            "_secret_version": "version-query-pages",
        }
        processed = []

        def process(_token, _user_id, message_id, _table, **_kwargs):
            processed.append(message_id)
            return {"stored": [], "skipped": []}

        pages = [
            ingestor.GmailDiscoveryPage(
                ["newest", "middle"],
                next_page_token="query-page-2",
            ),
            ingestor.GmailDiscoveryPage(
                ["oldest"],
                next_page_token=None,
            ),
        ]
        with patch.object(ingestor, "dynamodb", database), patch.object(
            ingestor, "cloudwatch", MagicMock()
        ), patch.object(
            ingestor, "load_oauth_secret", return_value=secret
        ), patch.object(
            ingestor, "refresh_access_token", return_value="access"
        ), patch.object(
            ingestor, "get_profile_history_id", side_effect=["300", "301"]
        ), patch.object(
            ingestor, "list_message_ids", side_effect=pages
        ) as list_messages, patch.object(
            ingestor, "process_message", side_effect=process
        ):
            first = ingestor.lambda_handler(
                {"source": "manual", "forceBackfill": True},
                None,
            )
            first_state = deepcopy(ledger.items[(
                ingestor.RUNTIME_STATE_MESSAGE_ID,
                ingestor.HISTORY_CURSOR_ATTACHMENT_ID,
            )])
            second = ingestor.lambda_handler(
                {"source": "manual", "forceBackfill": True},
                None,
            )

        self.assertEqual(json.loads(first["body"])["status"], "IN_PROGRESS")
        self.assertEqual(first_state["discoveryNextSequence"], -2)
        self.assertEqual(first_state["discoveryPageToken"], "query-page-2")
        self.assertEqual(processed, ["oldest", "middle", "newest"])
        self.assertEqual(json.loads(second["body"])["historyId"], "300")
        self.assertEqual(
            list_messages.call_args_list[1].kwargs["page_token"],
            "query-page-2",
        )

    def test_discovery_crash_replays_same_page_idempotently_before_token_advance(self):
        ledger = FakeLedgerTable([{
            "messageId": ingestor.RUNTIME_STATE_MESSAGE_ID,
            "attachmentId": ingestor.HISTORY_CURSOR_ATTACHMENT_ID,
            "status": "READY",
            "historyId": "100",
            "createdAt": "2026-07-27T12:00:00+00:00",
            "updatedAt": "2026-07-27T12:00:00+00:00",
        }])
        database = FakeRuntimeDynamoDb(ledger)
        secret = {
            "client_id": "client",
            "client_secret": "secret",
            "refresh_token": "refresh",
            "user_id": "me",
            "_secret_version": "version-crash",
        }
        first_page = ingestor.GmailDiscoveryPage(
            ["oldest", "middle"],
            next_page_token="page-2",
        )
        final_page = ingestor.GmailDiscoveryPage(
            ["newest"],
            next_page_token=None,
        )
        real_write_state = ingestor.write_ingestion_state
        state_write_count = 0

        def crash_before_token_checkpoint(table, **updates):
            nonlocal state_write_count
            state_write_count += 1
            if state_write_count == 2:
                raise ingestor.GmailStateStoreError(
                    "simulated crash before page-token checkpoint"
                )
            return real_write_state(table, **updates)

        common_patches = (
            patch.object(ingestor, "dynamodb", database),
            patch.object(ingestor, "cloudwatch", MagicMock()),
            patch.object(ingestor, "load_oauth_secret", return_value=secret),
            patch.object(ingestor, "refresh_access_token", return_value="access"),
            patch.object(
                ingestor,
                "get_profile_history_id",
                side_effect=["200", "201", "202"],
            ),
            patch.object(ingestor, "resolve_label_id", return_value="Label_1"),
            patch.object(
                ingestor,
                "list_history_message_ids",
                side_effect=[first_page, first_page, final_page],
            ),
        )
        with common_patches[0], common_patches[1], common_patches[2], \
                common_patches[3], common_patches[4], common_patches[5], \
                common_patches[6] as list_history, patch.object(
                    ingestor,
                    "write_ingestion_state",
                    side_effect=crash_before_token_checkpoint,
                ):
            crashed = ingestor.lambda_handler({
                "source": "aws-scheduler",
                "scheduleId": ingestor.GMAIL_SCHEDULE_ID,
            }, None)

        state_after_crash = deepcopy(ledger.items[(
            ingestor.RUNTIME_STATE_MESSAGE_ID,
            ingestor.HISTORY_CURSOR_ATTACHMENT_ID,
        )])
        queue_after_crash = [
            deepcopy(item)
            for item in ledger.items.values()
            if item.get("batchId")
        ]
        processed = []

        def process(_token, _user_id, message_id, _table, **_kwargs):
            processed.append(message_id)
            return {"stored": [], "skipped": []}

        with patch.object(ingestor, "dynamodb", database), patch.object(
            ingestor, "cloudwatch", MagicMock()
        ), patch.object(
            ingestor, "load_oauth_secret", return_value=secret
        ), patch.object(
            ingestor, "refresh_access_token", return_value="access"
        ), patch.object(
            ingestor, "get_profile_history_id", side_effect=["201", "202"]
        ), patch.object(
            ingestor,
            "list_history_message_ids",
            side_effect=[first_page, final_page],
        ) as resumed_list, patch.object(
            ingestor, "process_message", side_effect=process
        ):
            resumed = ingestor.lambda_handler({
                "source": "aws-scheduler",
                "scheduleId": ingestor.GMAIL_SCHEDULE_ID,
            }, None)
            queue_after_replay = [
                deepcopy(item)
                for item in ledger.items.values()
                if item.get("batchId")
            ]
            completed = ingestor.lambda_handler({
                "source": "aws-scheduler",
                "scheduleId": ingestor.GMAIL_SCHEDULE_ID,
            }, None)

        self.assertEqual(crashed["statusCode"], 503)
        self.assertEqual(
            json.loads(crashed["body"])["errorCode"],
            "GMAIL_STATE_STORE_ERROR",
        )
        self.assertEqual(state_after_crash["historyId"], "100")
        self.assertIsNone(state_after_crash["discoveryPageToken"])
        self.assertEqual(len(queue_after_crash), 2)
        self.assertEqual(len(queue_after_replay), 2)
        self.assertEqual(len({
            item["gmailMessageId"] for item in queue_after_replay
        }), 2)
        self.assertEqual(json.loads(resumed["body"])["status"], "IN_PROGRESS")
        self.assertEqual(json.loads(completed["body"])["status"], "SUCCESS")
        self.assertEqual(processed, ["oldest", "middle", "newest"])
        self.assertEqual(resumed_list.call_count, 2)
        final_state = ledger.items[(
            ingestor.RUNTIME_STATE_MESSAGE_ID,
            ingestor.HISTORY_CURSOR_ATTACHMENT_ID,
        )]
        self.assertEqual(final_state["historyId"], "200")

    def test_near_deadline_does_not_enter_persisted_next_discovery_page(self):
        batch_id = ingestor._queue_batch_id(
            (),
            cursor_before="100",
            pending_history_id="200",
            poll_mode="history",
            force_backfill=False,
        )
        ledger = FakeLedgerTable([
            {
                "messageId": ingestor.RUNTIME_STATE_MESSAGE_ID,
                "attachmentId": ingestor.HISTORY_CURSOR_ATTACHMENT_ID,
                "status": "IN_PROGRESS",
                "historyId": "100",
                "activeBatchId": batch_id,
                "pendingHistoryId": "200",
                "pendingPollMode": "history",
                "pendingForceBackfill": False,
                "pendingDiscoveredCount": 1,
                "pendingSince": "2026-07-27T12:00:00+00:00",
                "lastProgressAt": "2026-07-27T12:00:00+00:00",
                "discoveryStatus": "IN_PROGRESS",
                "discoveryBatchId": batch_id,
                "discoveryCursorBefore": "100",
                "discoveryTargetHistoryId": "200",
                "discoveryPageToken": "page-2",
                "discoveryNextSequence": 1,
                "discoveryMode": "history",
                "discoveryLabelId": "Label_1",
                "createdAt": "2026-07-27T12:00:00+00:00",
                "updatedAt": "2026-07-27T12:00:00+00:00",
            },
            {
                "messageId": ingestor.RUNTIME_STATE_MESSAGE_ID,
                "attachmentId": (
                    f"{ingestor.MESSAGE_QUEUE_ATTACHMENT_PREFIX}"
                    f"{batch_id}#p000000000000000000"
                ),
                "batchId": batch_id,
                "gmailMessageId": "oldest",
                "sequence": 0,
                "status": "PENDING",
                "attemptCount": 0,
                "createdAt": "2026-07-27T12:00:00+00:00",
                "updatedAt": "2026-07-27T12:00:00+00:00",
            },
        ])
        database = FakeRuntimeDynamoDb(ledger)
        secret = {
            "client_id": "client",
            "client_secret": "secret",
            "refresh_token": "refresh",
            "user_id": "me",
            "_secret_version": "version-deadline-page",
        }

        with patch.object(ingestor, "dynamodb", database), patch.object(
            ingestor, "cloudwatch", MagicMock()
        ), patch.object(
            ingestor, "load_oauth_secret", return_value=secret
        ), patch.object(
            ingestor, "refresh_access_token", return_value="access"
        ), patch.object(
            ingestor, "get_profile_history_id", return_value="201"
        ), patch.object(
            ingestor, "list_history_message_ids"
        ) as list_history:
            response = ingestor.lambda_handler(
                {
                    "source": "aws-scheduler",
                    "scheduleId": ingestor.GMAIL_SCHEDULE_ID,
                },
                FakeLambdaContext(
                    ingestor.MIN_REMAINING_TIME_MS
                    + ingestor.GMAIL_HTTP_TIMEOUT_SECONDS * 1000
                ),
            )

        body = json.loads(response["body"])
        self.assertEqual(body["status"], "IN_PROGRESS")
        self.assertEqual(body["errorCode"], "GMAIL_INVOCATION_NEAR_TIMEOUT")
        self.assertEqual(body["historyId"], "100")
        list_history.assert_not_called()
        state = ledger.items[(
            ingestor.RUNTIME_STATE_MESSAGE_ID,
            ingestor.HISTORY_CURSOR_ATTACHMENT_ID,
        )]
        self.assertEqual(state["historyId"], "100")
        self.assertEqual(state["discoveryPageToken"], "page-2")

    def test_page_persistence_yields_mid_page_without_advancing_token(self):
        ledger = FakeLedgerTable([{
            "messageId": ingestor.RUNTIME_STATE_MESSAGE_ID,
            "attachmentId": ingestor.HISTORY_CURSOR_ATTACHMENT_ID,
            "status": "READY",
            "historyId": "100",
            "createdAt": "2026-07-27T12:00:00+00:00",
            "updatedAt": "2026-07-27T12:00:00+00:00",
        }])
        database = FakeRuntimeDynamoDb(ledger)
        secret = {
            "client_id": "client",
            "client_secret": "secret",
            "refresh_token": "refresh",
            "user_id": "me",
            "_secret_version": "version-mid-page-budget",
        }
        page = ingestor.GmailDiscoveryPage(
            ["oldest", "newest"],
            next_page_token="page-2",
        )
        context = SequencedLambdaContext(
            [300_000] * 6 + [ingestor.MIN_REMAINING_TIME_MS]
        )

        with patch.object(ingestor, "dynamodb", database), patch.object(
            ingestor, "cloudwatch", MagicMock()
        ), patch.object(
            ingestor, "load_oauth_secret", return_value=secret
        ), patch.object(
            ingestor, "refresh_access_token", return_value="access"
        ), patch.object(
            ingestor, "get_profile_history_id", return_value="200"
        ), patch.object(
            ingestor, "resolve_label_id", return_value="Label_1"
        ), patch.object(
            ingestor, "list_history_message_ids", return_value=page
        ):
            response = ingestor.lambda_handler(
                {
                    "source": "aws-scheduler",
                    "scheduleId": ingestor.GMAIL_SCHEDULE_ID,
                },
                context,
            )

        body = json.loads(response["body"])
        self.assertEqual(body["status"], "IN_PROGRESS")
        self.assertEqual(body["errorCode"], "GMAIL_INVOCATION_NEAR_TIMEOUT")
        state = ledger.items[(
            ingestor.RUNTIME_STATE_MESSAGE_ID,
            ingestor.HISTORY_CURSOR_ATTACHMENT_ID,
        )]
        self.assertEqual(state["historyId"], "100")
        self.assertEqual(state["discoveryStatus"], "IN_PROGRESS")
        self.assertIsNone(state["discoveryPageToken"])
        queue_rows = [
            item
            for item in ledger.items.values()
            if item.get("batchId")
        ]
        self.assertEqual(len(queue_rows), 1)
        self.assertEqual(queue_rows[0]["gmailMessageId"], "oldest")
        self.assertEqual(queue_rows[0]["status"], "PENDING")

        processed = []

        def process(_token, _user_id, message_id, _table, **_kwargs):
            processed.append(message_id)
            return {"stored": [], "skipped": []}

        with patch.object(ingestor, "dynamodb", database), patch.object(
            ingestor, "cloudwatch", MagicMock()
        ), patch.object(
            ingestor, "load_oauth_secret", return_value=secret
        ), patch.object(
            ingestor, "refresh_access_token", return_value="access"
        ), patch.object(
            ingestor, "get_profile_history_id", side_effect=["201", "202"]
        ), patch.object(
            ingestor,
            "list_history_message_ids",
            side_effect=[
                page,
                ingestor.GmailDiscoveryPage([], next_page_token=None),
            ],
        ), patch.object(
            ingestor, "process_message", side_effect=process
        ):
            replayed = ingestor.lambda_handler({
                "source": "aws-scheduler",
                "scheduleId": ingestor.GMAIL_SCHEDULE_ID,
            }, None)
            queue_after_replay = [
                deepcopy(item)
                for item in ledger.items.values()
                if item.get("batchId")
            ]
            completed = ingestor.lambda_handler({
                "source": "aws-scheduler",
                "scheduleId": ingestor.GMAIL_SCHEDULE_ID,
            }, None)

        self.assertEqual(json.loads(replayed["body"])["status"], "IN_PROGRESS")
        self.assertEqual(len(queue_after_replay), 2)
        self.assertEqual(len({
            item["gmailMessageId"] for item in queue_after_replay
        }), 2)
        self.assertEqual(json.loads(completed["body"])["status"], "SUCCESS")
        self.assertEqual(processed, ["oldest", "newest"])
        self.assertEqual(json.loads(completed["body"])["historyId"], "200")

    def test_history_poll_processes_chronological_ids_without_reversing_them(self):
        ledger = FakeLedgerTable()
        database = FakeRuntimeDynamoDb(ledger)
        secret = {
            "client_id": "client",
            "client_secret": "secret",
            "refresh_token": "refresh",
            "user_id": "me",
            "_secret_version": "version-2",
        }
        processed = []

        def process(_token, _user_id, message_id, _table, **_kwargs):
            processed.append(message_id)
            return {"stored": [], "skipped": []}

        with patch.object(ingestor, "dynamodb", database), patch.object(
            ingestor, "cloudwatch", MagicMock()
        ), patch.object(ingestor, "load_oauth_secret", return_value=secret), patch.object(
            ingestor, "refresh_access_token", return_value="access"
        ), patch.object(
            ingestor, "read_ingestion_state", return_value={"status": "READY", "historyId": "123"}
        ), patch.object(ingestor, "resolve_label_id", return_value="Label_1"), patch.object(
            ingestor, "list_history_message_ids", return_value=["oldest", "middle", "newest"]
        ), patch.object(ingestor, "process_message", side_effect=process), patch.object(
            ingestor, "get_profile_history_id", return_value="124"
        ):
            ingestor.lambda_handler({
                "source": "aws-scheduler",
                "scheduleId": ingestor.GMAIL_SCHEDULE_ID,
            }, None)

        self.assertEqual(processed, ["oldest", "middle", "newest"])

    def test_durable_queue_caps_each_invocation_and_resumes_without_relisting(self):
        ledger = FakeLedgerTable(
            [{
                "messageId": ingestor.RUNTIME_STATE_MESSAGE_ID,
                "attachmentId": ingestor.HISTORY_CURSOR_ATTACHMENT_ID,
                "status": "READY",
                "historyId": "123",
                "createdAt": "2026-07-27T12:00:00+00:00",
                "updatedAt": "2026-07-27T12:00:00+00:00",
            }]
        )
        database = FakeRuntimeDynamoDb(ledger)
        secret = {
            "client_id": "client",
            "client_secret": "secret",
            "refresh_token": "refresh",
            "user_id": "me",
            "_secret_version": "version-queue",
        }
        discovered = [f"gmail-{index:02d}" for index in range(30)]
        processed = []

        def process(_token, _user_id, message_id, _table, **_kwargs):
            processed.append(message_id)
            return {"stored": [], "skipped": []}

        with patch.object(ingestor, "dynamodb", database), patch.object(
            ingestor, "cloudwatch", MagicMock()
        ), patch.object(
            ingestor, "load_oauth_secret", return_value=secret
        ), patch.object(
            ingestor, "refresh_access_token", return_value="access"
        ), patch.object(
            ingestor, "get_profile_history_id", return_value="124"
        ), patch.object(
            ingestor, "resolve_label_id", return_value="Label_1"
        ) as resolve_label, patch.object(
            ingestor, "list_history_message_ids", return_value=discovered
        ) as list_history, patch.object(
            ingestor, "list_message_ids"
        ) as list_messages, patch.object(
            ingestor, "process_message", side_effect=process
        ):
            first = ingestor.lambda_handler(
                {
                    "source": "aws-scheduler",
                    "scheduleId": ingestor.GMAIL_SCHEDULE_ID,
                },
                None,
            )
            state_after_first = deepcopy(ledger.items[(
                ingestor.RUNTIME_STATE_MESSAGE_ID,
                ingestor.HISTORY_CURSOR_ATTACHMENT_ID,
            )])
            queue_after_first = [
                deepcopy(item)
                for item in ledger.items.values()
                if item.get("batchId")
            ]
            second = ingestor.lambda_handler(
                {
                    "source": "aws-scheduler",
                    "scheduleId": ingestor.GMAIL_SCHEDULE_ID,
                },
                None,
            )

        first_body = json.loads(first["body"])
        second_body = json.loads(second["body"])
        self.assertEqual(first_body["status"], "IN_PROGRESS")
        self.assertEqual(first_body["messageCount"], 25)
        self.assertEqual(first_body["remainingCount"], 5)
        self.assertEqual(first_body["historyId"], "123")
        self.assertEqual(state_after_first["historyId"], "123")
        self.assertEqual(state_after_first["status"], "IN_PROGRESS")
        self.assertEqual(
            state_after_first["activeBatchId"],
            queue_after_first[0]["batchId"],
        )
        self.assertEqual(len(queue_after_first), 30)
        self.assertEqual(
            len([
                item
                for item in queue_after_first
                if item["status"] in ingestor.MESSAGE_QUEUE_ACTIVE_STATUSES
            ]),
            5,
        )
        self.assertEqual(second_body["status"], "SUCCESS")
        self.assertEqual(second_body["messageCount"], 5)
        self.assertEqual(second_body["remainingCount"], 0)
        self.assertEqual(second_body["historyId"], "124")
        self.assertEqual(processed, discovered)
        self.assertEqual(len(set(processed)), 30)
        resolve_label.assert_called_once()
        list_history.assert_called_once()
        list_messages.assert_not_called()
        final_state = ledger.items[(
            ingestor.RUNTIME_STATE_MESSAGE_ID,
            ingestor.HISTORY_CURSOR_ATTACHMENT_ID,
        )]
        self.assertEqual(final_state["status"], "READY")
        self.assertEqual(final_state["historyId"], "124")
        self.assertIsNone(final_state["activeBatchId"])

    def test_remaining_time_guard_checkpoints_queue_and_emits_progress_heartbeat(self):
        ledger = FakeLedgerTable(
            [{
                "messageId": ingestor.RUNTIME_STATE_MESSAGE_ID,
                "attachmentId": ingestor.HISTORY_CURSOR_ATTACHMENT_ID,
                "status": "READY",
                "historyId": "123",
                "createdAt": "2026-07-27T12:00:00+00:00",
                "updatedAt": "2026-07-27T12:00:00+00:00",
            }]
        )
        database = FakeRuntimeDynamoDb(ledger)
        secret = {
            "client_id": "client",
            "client_secret": "secret",
            "refresh_token": "refresh",
            "user_id": "me",
            "_secret_version": "version-timeout",
        }

        with patch.object(ingestor, "dynamodb", database), patch.object(
            ingestor, "cloudwatch", MagicMock()
        ), patch.object(
            ingestor, "load_oauth_secret", return_value=secret
        ), patch.object(
            ingestor, "refresh_access_token", return_value="access"
        ), patch.object(
            ingestor, "get_profile_history_id", return_value="124"
        ), patch.object(
            ingestor, "resolve_label_id", return_value="Label_1"
        ), patch.object(
            ingestor, "list_history_message_ids", return_value=["gmail-pending"]
        ), patch.object(
            ingestor, "process_message"
        ) as process_message:
            response = ingestor.lambda_handler(
                {
                    "source": "aws-scheduler",
                    "scheduleId": ingestor.GMAIL_SCHEDULE_ID,
                },
                FakeLambdaContext(ingestor.MIN_REMAINING_TIME_MS),
            )

        body = json.loads(response["body"])
        self.assertEqual(response["statusCode"], 200)
        self.assertEqual(body["status"], "IN_PROGRESS")
        self.assertEqual(body["errorCode"], "GMAIL_INVOCATION_NEAR_TIMEOUT")
        self.assertEqual(body["messageCount"], 0)
        self.assertEqual(body["remainingCount"], 0)
        self.assertEqual(body["historyId"], "123")
        process_message.assert_not_called()
        heartbeat = database.heartbeat.writes[-1]
        self.assertEqual(heartbeat["status"], "in_progress")
        self.assertEqual(heartbeat["serviceId"], ingestor.GMAIL_SERVICE_ID)
        self.assertTrue(heartbeat["scheduled"])
        self.assertEqual(heartbeat["triggerSource"], "aws-scheduler")
        self.assertEqual(heartbeat["scheduleId"], ingestor.GMAIL_SCHEDULE_ID)
        self.assertEqual(
            heartbeat["errorCode"],
            "GMAIL_INVOCATION_NEAR_TIMEOUT",
        )
        queue_rows = [
            item
            for item in ledger.items.values()
            if item.get("batchId")
        ]
        self.assertEqual(queue_rows, [])
        state = ledger.items[(
            ingestor.RUNTIME_STATE_MESSAGE_ID,
            ingestor.HISTORY_CURSOR_ATTACHMENT_ID,
        )]
        self.assertEqual(state["historyId"], "123")
        self.assertEqual(state["status"], "IN_PROGRESS")

    def test_stale_message_queue_lease_is_reclaimed(self):
        now = datetime(2026, 7, 27, 12, tzinfo=timezone.utc)
        item = {
            "messageId": ingestor.RUNTIME_STATE_MESSAGE_ID,
            "attachmentId": (
                f"{ingestor.MESSAGE_QUEUE_ATTACHMENT_PREFIX}batch#000000000"
            ),
            "batchId": "batch",
            "gmailMessageId": "gmail-stale",
            "sequence": 0,
            "status": "IN_PROGRESS",
            "attemptCount": 1,
            "createdAt": "2026-07-27T10:00:00+00:00",
            "updatedAt": "2026-07-27T10:00:00+00:00",
        }
        ledger = FakeLedgerTable([item])

        with patch.object(ingestor, "utc_now", return_value=now):
            claimed = ingestor.claim_queued_message(ledger, item)

        self.assertIsNotNone(claimed)
        self.assertEqual(claimed["status"], "IN_PROGRESS")
        self.assertEqual(claimed["attemptCount"], 2)
        self.assertEqual(
            ledger.items[(item["messageId"], item["attachmentId"])]["updatedAt"],
            now.isoformat(),
        )

    def test_poison_message_is_quarantined_without_blocking_new_history(self):
        ledger = FakeLedgerTable(
            [{
                "messageId": ingestor.RUNTIME_STATE_MESSAGE_ID,
                "attachmentId": ingestor.HISTORY_CURSOR_ATTACHMENT_ID,
                "status": "READY",
                "historyId": "123",
                "createdAt": "2026-07-27T12:00:00+00:00",
                "updatedAt": "2026-07-27T12:00:00+00:00",
            }]
        )
        database = FakeRuntimeDynamoDb(ledger)
        secret = {
            "client_id": "client",
            "client_secret": "secret",
            "refresh_token": "refresh",
            "user_id": "me",
            "_secret_version": "version-poison",
        }
        processed = []

        def process(_token, _user_id, message_id, _table, **_kwargs):
            processed.append(message_id)
            if message_id == "gmail-poison":
                raise ingestor.RetryableResearchMaterializationError(
                    "Research provenance could not be verified."
                )
            return {"stored": [], "skipped": []}

        with patch.object(ingestor, "dynamodb", database), patch.object(
            ingestor, "cloudwatch", MagicMock()
        ), patch.object(
            ingestor, "load_oauth_secret", return_value=secret
        ), patch.object(
            ingestor, "refresh_access_token", return_value="access"
        ), patch.object(
            ingestor,
            "get_profile_history_id",
            side_effect=["124", "124", "124", "125"],
        ), patch.object(
            ingestor, "resolve_label_id", return_value="Label_1"
        ), patch.object(
            ingestor,
            "list_history_message_ids",
            side_effect=[["gmail-poison"], ["gmail-fresh"]],
        ) as list_history, patch.object(
            ingestor, "list_message_ids"
        ) as list_messages, patch.object(
            ingestor, "process_message", side_effect=process
        ):
            responses = [
                ingestor.lambda_handler(
                    {
                        "source": "aws-scheduler",
                        "scheduleId": ingestor.GMAIL_SCHEDULE_ID,
                    },
                    None,
                )
                for _ in range(4)
            ]

        bodies = [json.loads(response["body"]) for response in responses]
        self.assertEqual(
            [body["status"] for body in bodies],
            ["IN_PROGRESS", "IN_PROGRESS", "ATTENTION", "ATTENTION"],
        )
        self.assertEqual(
            bodies[2]["errorCode"],
            "GMAIL_QUARANTINED_ARTIFACTS_PENDING",
        )
        self.assertEqual(bodies[2]["historyId"], "124")
        self.assertEqual(bodies[3]["historyId"], "125")
        self.assertEqual(
            processed,
            ["gmail-poison", "gmail-poison", "gmail-poison", "gmail-fresh"],
        )
        self.assertEqual(list_history.call_count, 2)
        list_messages.assert_not_called()
        final_state = ledger.items[(
            ingestor.RUNTIME_STATE_MESSAGE_ID,
            ingestor.HISTORY_CURSOR_ATTACHMENT_ID,
        )]
        self.assertEqual(final_state["status"], "WARNING")
        self.assertEqual(final_state["historyId"], "125")
        self.assertEqual(final_state["quarantinedCount"], 1)
        self.assertEqual(
            final_state["quarantinedMessages"][0]["messageId"],
            "gmail-poison",
        )
        self.assertEqual(
            database.heartbeat.writes[-1]["errorCode"],
            "GMAIL_QUARANTINED_ARTIFACTS_PENDING",
        )
        self.assertEqual(database.heartbeat.writes[-1]["status"], "warning")

    def test_risk_range_quarantine_is_selected_only_once_per_build(self):
        state = {
            "quarantinedMessages": [
                {
                    "messageId": "risk-range-message",
                    "errorCode": "RISK_RANGE_TRANSACTION_WRITE_FAILED",
                },
                {
                    "messageId": "unrelated-message",
                    "errorCode": "GMAIL_RESEARCH_MATERIALIZATION_ERROR",
                },
            ]
        }

        selected, updated = ingestor.prepare_build_recovery(
            state,
            build_version="build-a",
            attempted_at="2026-07-30T18:00:00+00:00",
        )
        selected_again, updated_again = ingestor.prepare_build_recovery(
            {"quarantinedMessages": updated},
            build_version="build-a",
            attempted_at="2026-07-30T18:01:00+00:00",
        )
        selected_new_build, _ = ingestor.prepare_build_recovery(
            {"quarantinedMessages": updated_again},
            build_version="build-b",
            attempted_at="2026-07-30T18:02:00+00:00",
        )

        self.assertEqual(selected, ["risk-range-message"])
        self.assertEqual(
            updated[0]["recoveryBuildVersion"],
            "build-a",
        )
        self.assertEqual(selected_again, [])
        self.assertEqual(selected_new_build, ["risk-range-message"])

    def test_code_change_without_a_new_build_version_still_rearms_recovery(self):
        import tempfile
        from pathlib import Path

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "hermes_gmail_ingestor.py").write_text("print('a')\n")
            (root / "research_products.json").write_text("{}\n")
            (root / "notes.txt").write_text("not code\n")
            before = ingestor.source_code_fingerprint(root)
            (root / "notes.txt").write_text("still not code\n")
            self.assertEqual(ingestor.source_code_fingerprint(root), before)
            (root / "hermes_gmail_ingestor.py").write_text("print('b')\n")
            after = ingestor.source_code_fingerprint(root)
        self.assertNotEqual(after, before)

        # A message last tried by the Aug build (bare BUILD_VERSION) is retried
        # once by the same BUILD_VERSION running different code.
        state = {"quarantinedMessages": [{
            "messageId": "risk-range-message",
            "errorCode": "RISK_RANGE_PUBLICATION_INVALID",
            "recoveryBuildVersion": ingestor.BUILD_VERSION,
        }]}
        selected, updated = ingestor.prepare_build_recovery(
            state, build_version=ingestor.RECOVERY_BUILD_IDENTITY,
            attempted_at="2026-10-15T00:00:00+00:00",
        )
        self.assertEqual(selected, ["risk-range-message"])
        self.assertTrue(ingestor.RECOVERY_BUILD_IDENTITY.startswith(f"{ingestor.BUILD_VERSION}+"))
        self.assertEqual(updated[0]["recoveryBuildVersion"], ingestor.RECOVERY_BUILD_IDENTITY)
        selected_again, _ = ingestor.prepare_build_recovery(
            {"quarantinedMessages": updated}, build_version=ingestor.RECOVERY_BUILD_IDENTITY,
            attempted_at="2026-10-15T00:15:00+00:00",
        )
        self.assertEqual(selected_again, [])

    def test_backlog_without_progress_emits_distinct_stalled_error(self):
        batch_id = "stalled-batch"
        queue_attachment_id = (
            f"{ingestor.MESSAGE_QUEUE_ATTACHMENT_PREFIX}{batch_id}#000000000"
        )
        ledger = FakeLedgerTable(
            [
                {
                    "messageId": ingestor.RUNTIME_STATE_MESSAGE_ID,
                    "attachmentId": ingestor.HISTORY_CURSOR_ATTACHMENT_ID,
                    "status": "IN_PROGRESS",
                    "historyId": "123",
                    "activeBatchId": batch_id,
                    "pendingHistoryId": "124",
                    "pendingPollMode": "history",
                    "pendingForceBackfill": False,
                    "pendingDiscoveredCount": 1,
                    "pendingSince": "2026-07-27T08:00:00+00:00",
                    "lastProgressAt": "2026-07-27T08:00:00+00:00",
                    "createdAt": "2026-07-27T08:00:00+00:00",
                    "updatedAt": "2026-07-27T08:00:00+00:00",
                },
                {
                    "messageId": ingestor.RUNTIME_STATE_MESSAGE_ID,
                    "attachmentId": queue_attachment_id,
                    "batchId": batch_id,
                    "gmailMessageId": "gmail-stalled",
                    "sequence": 0,
                    "status": "RETRYABLE",
                    "attemptCount": 1,
                    "createdAt": "2026-07-27T08:00:00+00:00",
                    "updatedAt": "2026-07-27T08:15:00+00:00",
                },
            ]
        )
        database = FakeRuntimeDynamoDb(ledger)
        secret = {
            "client_id": "client",
            "client_secret": "secret",
            "refresh_token": "refresh",
            "user_id": "me",
            "_secret_version": "version-stalled",
        }
        now = datetime(2026, 7, 27, 12, tzinfo=timezone.utc)

        with patch.object(ingestor, "dynamodb", database), patch.object(
            ingestor, "cloudwatch", MagicMock()
        ), patch.object(
            ingestor, "load_oauth_secret", return_value=secret
        ), patch.object(
            ingestor, "refresh_access_token", return_value="access"
        ), patch.object(
            ingestor, "get_profile_history_id", return_value="124"
        ), patch.object(
            ingestor,
            "process_message",
            side_effect=RuntimeError("temporary Gmail API failure"),
        ), patch.object(
            ingestor, "utc_now", return_value=now
        ):
            response = ingestor.lambda_handler(
                {
                    "source": "aws-scheduler",
                    "scheduleId": ingestor.GMAIL_SCHEDULE_ID,
                },
                None,
            )

        body = json.loads(response["body"])
        self.assertEqual(response["statusCode"], 207)
        self.assertEqual(body["status"], "ERROR")
        self.assertEqual(body["errorCode"], "GMAIL_BACKLOG_STALLED")
        self.assertEqual(body["historyId"], "123")
        self.assertEqual(body["remainingCount"], 1)
        self.assertEqual(
            database.heartbeat.writes[-1]["errorCode"],
            "GMAIL_BACKLOG_STALLED",
        )

    def test_heartbeat_store_failure_is_a_typed_error_after_cursor_checkpoint(self):
        ledger = FakeLedgerTable(
            [{
                "messageId": ingestor.RUNTIME_STATE_MESSAGE_ID,
                "attachmentId": ingestor.HISTORY_CURSOR_ATTACHMENT_ID,
                "status": "READY",
                "historyId": "123",
                "createdAt": "2026-07-27T12:00:00+00:00",
                "updatedAt": "2026-07-27T12:00:00+00:00",
            }]
        )
        database = FakeRuntimeDynamoDb(ledger)
        database.heartbeat.put_item = MagicMock(
            side_effect=RuntimeError("heartbeat table unavailable")
        )
        secret = {
            "client_id": "client",
            "client_secret": "secret",
            "refresh_token": "refresh",
            "user_id": "me",
            "_secret_version": "version-heartbeat",
        }

        with patch.object(ingestor, "dynamodb", database), patch.object(
            ingestor, "cloudwatch", MagicMock()
        ), patch.object(
            ingestor, "load_oauth_secret", return_value=secret
        ), patch.object(
            ingestor, "refresh_access_token", return_value="access"
        ), patch.object(
            ingestor, "get_profile_history_id", return_value="124"
        ), patch.object(
            ingestor, "resolve_label_id", return_value="Label_1"
        ), patch.object(
            ingestor, "list_history_message_ids", return_value=[]
        ):
            response = ingestor.lambda_handler(
                {
                    "source": "aws-scheduler",
                    "scheduleId": ingestor.GMAIL_SCHEDULE_ID,
                },
                None,
            )

        body = json.loads(response["body"])
        self.assertEqual(response["statusCode"], 503)
        self.assertEqual(body["status"], "ERROR")
        self.assertEqual(body["errorCode"], "GMAIL_HEARTBEAT_WRITE_FAILED")
        state = ledger.items[(
            ingestor.RUNTIME_STATE_MESSAGE_ID,
            ingestor.HISTORY_CURSOR_ATTACHMENT_ID,
        )]
        self.assertEqual(state["historyId"], "124")
        self.assertEqual(state["status"], "ERROR")
        self.assertEqual(state["errorCode"], "GMAIL_HEARTBEAT_WRITE_FAILED")

    def test_macro_show_window_keeps_scheduled_safeguards_without_the_service_heartbeat(self):
        ledger = FakeLedgerTable([{
            "messageId": ingestor.RUNTIME_STATE_MESSAGE_ID,
            "attachmentId": ingestor.HISTORY_CURSOR_ATTACHMENT_ID,
            "status": "READY",
            "historyId": "100",
            "createdAt": "2026-07-27T12:00:00+00:00",
            "updatedAt": "2026-07-27T12:00:00+00:00",
        }])
        database = FakeRuntimeDynamoDb(ledger)
        secret = {
            "client_id": "client",
            "client_secret": "secret",
            "refresh_token": "refresh",
            "user_id": "me",
            "_secret_version": "version-expired",
        }
        expired = RuntimeError(
            "GET Gmail history failed with HTTP 404: start historyId expired"
        )
        with patch.object(ingestor, "dynamodb", database), patch.object(
            ingestor, "cloudwatch", MagicMock()
        ), patch.object(
            ingestor, "load_oauth_secret", return_value=secret
        ), patch.object(
            ingestor, "refresh_access_token", return_value="access"
        ), patch.object(
            ingestor, "get_profile_history_id", return_value="200"
        ), patch.object(
            ingestor, "resolve_label_id", return_value="Label_1"
        ), patch.object(
            ingestor, "list_history_message_ids", side_effect=expired
        ), patch.object(
            ingestor, "list_message_ids"
        ) as list_messages, patch.object(
            ingestor, "write_service_heartbeat", return_value=True
        ) as heartbeat:
            response = ingestor.lambda_handler(
                {
                    "source": "aws-scheduler",
                    "scheduleId": ingestor.GMAIL_MACRO_SHOW_SCHEDULE_ID,
                    "poll": "incremental",
                },
                None,
            )

        self.assertNotEqual(json.loads(response["body"]).get("errorCode"), "GMAIL_SCHEDULE_ID_MISMATCH")
        list_messages.assert_not_called()
        self.assertEqual(heartbeat.call_args.kwargs["schedule_id"], ingestor.GMAIL_MACRO_SHOW_SCHEDULE_ID)

    def test_macro_show_window_heartbeat_stays_off_the_scheduled_service(self):
        heartbeats = MagicMock()
        database = MagicMock()
        database.Table.return_value = heartbeats
        with patch.object(ingestor, "dynamodb", database), patch.object(ingestor, "cloudwatch", MagicMock()):
            ingestor.write_service_heartbeat(
                started_at="2026-11-09T15:00:00+00:00",
                status="success",
                trigger_source="aws-scheduler",
                schedule_id=ingestor.GMAIL_MACRO_SHOW_SCHEDULE_ID,
            )
        item = heartbeats.put_item.call_args.kwargs["Item"]
        self.assertEqual(item["serviceId"], f"{ingestor.GMAIL_SERVICE_ID}:manual")
        self.assertFalse(item["scheduled"])

    def test_scheduler_invocation_with_wrong_identity_is_rejected_before_auth(self):
        database = FakeRuntimeDynamoDb(FakeLedgerTable())
        with patch.object(ingestor, "dynamodb", database), patch.object(
            ingestor, "cloudwatch", MagicMock()
        ), patch.object(
            ingestor, "load_oauth_secret"
        ) as load_secret:
            response = ingestor.lambda_handler(
                {
                    "source": "aws-scheduler",
                    "scheduleId": "unexpected-schedule",
                },
                None,
            )

        body = json.loads(response["body"])
        self.assertEqual(response["statusCode"], 400)
        self.assertEqual(body["status"], "ERROR")
        self.assertEqual(body["errorCode"], "GMAIL_SCHEDULE_ID_MISMATCH")
        load_secret.assert_not_called()

    def test_retryable_materialization_failure_does_not_advance_cursor_or_heartbeat_success(self):
        ledger = FakeLedgerTable()
        database = FakeRuntimeDynamoDb(ledger)
        secret = {
            "client_id": "client",
            "client_secret": "secret",
            "refresh_token": "refresh",
            "user_id": "me",
            "_secret_version": "version-2",
        }
        failure = ingestor.RetryableResearchMaterializationError(
            "Research parse/materialization failed: parser exploded"
        )

        with patch.object(ingestor, "dynamodb", database), patch.object(
            ingestor, "cloudwatch", MagicMock()
        ), patch.object(ingestor, "load_oauth_secret", return_value=secret), patch.object(
            ingestor, "refresh_access_token", return_value="access"
        ), patch.object(
            ingestor, "read_ingestion_state", return_value={"status": "READY", "historyId": "123"}
        ), patch.object(
            ingestor, "process_message", side_effect=failure
        ), patch.object(
            ingestor, "get_profile_history_id"
        ) as get_profile_history_id, patch.object(
            ingestor, "write_ingestion_state"
        ) as write_ingestion_state:
            response = ingestor.lambda_handler(
                {
                    "source": "aws-scheduler",
                    "scheduleId": ingestor.GMAIL_SCHEDULE_ID,
                    "messageIds": ["gmail-bad-materialization"],
                },
                None,
            )

        body = json.loads(response["body"])
        self.assertEqual(response["statusCode"], 200)
        self.assertEqual(body["status"], "IN_PROGRESS")
        self.assertEqual(body["historyId"], "123")
        self.assertEqual(body["remainingCount"], 1)
        self.assertEqual(
            body["errors"],
            [{
                "messageId": "gmail-bad-materialization",
                "error": "Research parse/materialization failed: parser exploded",
                "errorCode": "GMAIL_RESEARCH_MATERIALIZATION_ERROR",
                "retryable": True,
                "attemptCount": 1,
                "quarantined": False,
            }],
        )
        get_profile_history_id.assert_called_once_with("access", "me")
        self.assertEqual(write_ingestion_state.call_count, 2)
        self.assertTrue(all(
            call.kwargs["historyId"] == "123"
            for call in write_ingestion_state.call_args_list
            if "historyId" in call.kwargs
        ))
        self.assertEqual(database.heartbeat.writes[-1]["status"], "in_progress")
        self.assertEqual(
            database.heartbeat.writes[-1]["errorCode"],
            "GMAIL_MESSAGE_RETRY_PENDING",
        )
        self.assertIn("authVerifiedAt", database.heartbeat.writes[-1])

    def test_invalid_grant_persists_auth_required_and_stops_retry_storm(self):
        ledger = FakeLedgerTable()
        database = FakeRuntimeDynamoDb(ledger)
        secret = {
            "client_id": "client",
            "client_secret": "secret",
            "refresh_token": "refresh",
            "user_id": "me",
            "_secret_version": "oauth-version-7",
        }

        with patch.object(ingestor, "dynamodb", database), patch.object(
            ingestor, "cloudwatch", MagicMock()
        ), patch.object(ingestor, "load_oauth_secret", return_value=secret), patch.object(
            ingestor,
            "refresh_access_token",
            side_effect=RuntimeError("invalid_grant: token expired or revoked"),
        ), patch.object(ingestor, "read_ingestion_state", return_value={}):
            response = ingestor.lambda_handler({}, None)

        body = json.loads(response["body"])
        self.assertEqual(response["statusCode"], 200)
        self.assertEqual(body["status"], "AUTH_REQUIRED")
        self.assertEqual(body["errorCode"], "GMAIL_AUTH_REQUIRED")
        state = ledger.items[(ingestor.RUNTIME_STATE_MESSAGE_ID, ingestor.HISTORY_CURSOR_ATTACHMENT_ID)]
        self.assertEqual(state["status"], "AUTH_REQUIRED")
        self.assertEqual(state["blockedSecretVersion"], "oauth-version-7")
        self.assertEqual(database.heartbeat.writes[-1]["status"], "auth_required")
        self.assertNotIn("authVerifiedAt", database.heartbeat.writes[-1])

    def test_auth_circuit_breaker_does_not_call_google_until_secret_rotates(self):
        ledger = FakeLedgerTable()
        database = FakeRuntimeDynamoDb(ledger)
        secret = {
            "client_id": "client",
            "client_secret": "secret",
            "refresh_token": "refresh",
            "_secret_version": "same-version",
        }
        state = {"status": "AUTH_REQUIRED", "blockedSecretVersion": "same-version"}

        with patch.object(ingestor, "dynamodb", database), patch.object(
            ingestor, "cloudwatch", MagicMock()
        ), patch.object(ingestor, "load_oauth_secret", return_value=secret) as load_secret, patch.object(
            ingestor, "read_ingestion_state", return_value=state
        ), patch.object(ingestor, "refresh_access_token") as refresh:
            response = ingestor.lambda_handler({}, None)

        refresh.assert_not_called()
        self.assertEqual(load_secret.call_count, 2)
        load_secret.assert_any_call(force_refresh=True)
        self.assertEqual(json.loads(response["body"])["status"], "AUTH_REQUIRED")

    def test_unpaired_force_auth_probe_cannot_bypass_circuit_or_poll_mailbox(self):
        ledger = FakeLedgerTable()
        database = FakeRuntimeDynamoDb(ledger)

        with patch.object(ingestor, "dynamodb", database), patch.object(
            ingestor, "cloudwatch", MagicMock()
        ), patch.object(
            ingestor, "load_oauth_secret"
        ) as load_secret, patch.object(
            ingestor, "read_ingestion_state"
        ) as read_state, patch.object(
            ingestor, "refresh_access_token"
        ) as refresh, patch.object(
            ingestor, "get_profile_history_id"
        ) as get_profile, patch.object(
            ingestor, "list_message_ids"
        ) as list_messages, patch.object(
            ingestor, "list_history_message_ids"
        ) as list_history, patch.object(
            ingestor, "process_message"
        ) as process_message:
            response = ingestor.lambda_handler(
                {"source": "manual", "forceAuthProbe": True},
                None,
            )

        body = json.loads(response["body"])
        self.assertEqual(response["statusCode"], 400)
        self.assertEqual(body["status"], "ERROR")
        self.assertEqual(body["errorCode"], "GMAIL_AUTH_PROBE_EVENT_INVALID")
        self.assertEqual(body["pollMode"], "rejected")
        load_secret.assert_not_called()
        read_state.assert_not_called()
        refresh.assert_not_called()
        get_profile.assert_not_called()
        list_messages.assert_not_called()
        list_history.assert_not_called()
        process_message.assert_not_called()
        self.assertEqual(
            database.heartbeat.writes[-1]["errorCode"],
            "GMAIL_AUTH_PROBE_EVENT_INVALID",
        )

    def test_generic_investing_ideas_changes_are_never_routed_to_rta(self):
        snapshot = ingestor.parse_html_snapshot(
            report_type="unknown",
            html_body="<html><body><h1>3 Changes: Remove SXT, SJM, Add GTLB</h1></body></html>",
            received_at=datetime(2026, 7, 16, 19, 21, 55, tzinfo=timezone.utc),
            s3_key="gmail/unknown/changes.html",
            message_id="sxt-remove",
            subject="3 Changes: Remove SXT, SJM, Add GTLB",
        )

        self.assertIsNotNone(snapshot)
        self.assertEqual(snapshot["snapshotType"], "investing-ideas")
        self.assertFalse(snapshot["data"]["checkpointAvailable"])
        self.assertEqual([row["ticker"] for row in snapshot["data"]["alerts"]], ["SXT", "SJM", "GTLB"])

    def test_investing_ideas_changes_take_each_side_and_range_from_the_body(self):
        html_body = """
            <h1>3 Changes: Remove SNOW, DELL, WING</h1>
            <div><p>We have <strong>REMOVED</strong> the following from <em>Investing Ideas</em>:</p>
            <p>Long:</p><ul><li><a>SNOW</a> (336.0 - 375.0)</li><li><a>DELL</a> (540.0 - 601.0)</li></ul></div>
            <p><em>These positions have stopped out on our #VASP (Volatility Adjusted Signaling Process).</em></p>
            <div><p>We have <strong>REMOVED</strong> the following from <em>Investing Ideas</em>:</p>
            <p>Short:</p><ul><li><a>WING</a> (97.74 - 126.0)</li></ul></div>
        """
        snapshot = ingestor.parse_html_snapshot(
            report_type="unknown",
            html_body=html_body,
            received_at=datetime(2026, 10, 16, 16, 23, tzinfo=timezone.utc),
            s3_key="gmail/unknown/changes.html",
            message_id="snow-dell-wing",
            subject="3 Changes: Remove SNOW, DELL, WING",
        )

        alerts = {row["ticker"]: row for row in snapshot["data"]["alerts"]}
        self.assertEqual(list(alerts), ["SNOW", "DELL", "WING"])
        self.assertEqual({ticker: row["side"] for ticker, row in alerts.items()},
                         {"SNOW": "long", "DELL": "long", "WING": "short"})
        self.assertEqual({row["action"] for row in alerts.values()}, {"REMOVE"})
        self.assertEqual((float(alerts["WING"]["riskRangeLow"]), float(alerts["WING"]["riskRangeHigh"])), (97.74, 126.0))

    def test_investing_ideas_changes_never_assume_a_side_the_body_omits(self):
        snapshot = ingestor.parse_html_snapshot(
            report_type="unknown",
            html_body="<html><body><h1>3 Changes: Remove SXT, SJM, Add GTLB</h1></body></html>",
            received_at=datetime(2026, 7, 16, 19, 21, 55, tzinfo=timezone.utc),
            s3_key="gmail/unknown/changes.html",
            message_id="sxt-remove",
            subject="3 Changes: Remove SXT, SJM, Add GTLB",
        )
        self.assertEqual({row["side"] for row in snapshot["data"]["alerts"]}, {None})

    def test_investing_ideas_newsletter_materializes_its_long_short_table(self):
        html_body = """
            <h1>Investing Ideas Newsletter: August 03, 2026</h1>
            <p>Long: DDOG, BRKR</p>
            <p>Short: OLLI, HCA</p>
            <table class="investing-ideas-table">
              <tr class="long">
                <td>DDOG</td><td>$267.97</td><td>$244.00</td><td>$275.00</td>
              </tr>
              <tr class="long">
                <td>BRKR</td><td>$62.84</td><td>$58.27</td><td>$65.48</td>
              </tr>
              <tr class="short">
                <td>OLLI</td><td>$73.47</td><td>$61.90</td><td>$74.98</td>
              </tr>
              <tr class="short">
                <td>HCA</td><td>$402.59</td><td>$363.00</td><td>$418.00</td>
              </tr>
            </table>
        """

        snapshot = ingestor.parse_html_snapshot(
            report_type="investing-ideas",
            html_body=html_body,
            received_at=datetime(2026, 8, 3, 12, 45, tzinfo=timezone.utc),
            s3_key="investing-ideas/newsletter.html",
            message_id="investing-ideas-2026-08-03",
            subject="Investing Ideas Newsletter: August 03, 2026",
        )

        self.assertIsNotNone(snapshot)
        self.assertEqual(snapshot["positionCount"], 4)
        self.assertEqual(snapshot["data"]["longs"], ["DDOG", "BRKR"])
        self.assertEqual(snapshot["data"]["shorts"], ["OLLI", "HCA"])
        self.assertEqual(
            snapshot["data"]["positions"][0],
            {
                "ticker": "DDOG",
                "side": "Long",
                "position": "long",
                "prevClose": 267.97,
                "lrr": 244.0,
                "hrr": 275.0,
                "originalName": "DDOG",
            },
        )

    def test_investing_ideas_supports_named_header_table_layout(self):
        snapshot = ingestor.parse_html_snapshot(
            report_type="investing-ideas",
            html_body="""
                <table>
                  <tr>
                    <th>Ticker</th><th>Position</th><th>Previous Close</th>
                    <th>LRR</th><th>HRR</th>
                  </tr>
                  <tr>
                    <td>DDOG</td><td>Long</td><td>$267.97</td>
                    <td>$244.00</td><td>$275.00</td>
                  </tr>
                  <tr>
                    <td>HCA</td><td>Short</td><td>$402.59</td>
                    <td>$363.00</td><td>$418.00</td>
                  </tr>
                </table>
            """,
            received_at=datetime(2026, 8, 3, 12, 45, tzinfo=timezone.utc),
            s3_key="investing-ideas/header-layout.html",
            message_id="header-investing-ideas",
            subject="Investing Ideas Newsletter",
        )

        self.assertEqual(
            snapshot["data"]["positions"],
            [
                {
                    "ticker": "DDOG",
                    "side": "Long",
                    "position": "long",
                    "prevClose": 267.97,
                    "lrr": 244.0,
                    "hrr": 275.0,
                    "originalName": "DDOG",
                },
                {
                    "ticker": "HCA",
                    "side": "Short",
                    "position": "short",
                    "prevClose": 402.59,
                    "lrr": 363.0,
                    "hrr": 418.0,
                    "originalName": "HCA",
                },
            ],
        )

    def test_investing_ideas_returns_no_snapshot_for_incomplete_rows(self):
        with self.assertRaisesRegex(ValueError, "missing required risk-range cells"):
            ingestor.parse_html_snapshot(
                report_type="investing-ideas",
                html_body="""
                    <h1>Investing Ideas Newsletter: August 03, 2026</h1>
                    <table>
                      <tr class="long">
                        <td>DDOG</td><td>$267.97</td><td>$244.00</td>
                      </tr>
                    </table>
                """,
                received_at=datetime(2026, 8, 3, 12, 45, tzinfo=timezone.utc),
                s3_key="investing-ideas/incomplete.html",
                message_id="incomplete-investing-ideas",
                subject="Investing Ideas Newsletter: August 03, 2026",
            )

    def test_investing_ideas_rejects_conflicting_duplicate_rows(self):
        with self.assertRaisesRegex(ValueError, "conflicting duplicate row"):
            ingestor.parse_html_snapshot(
                report_type="investing-ideas",
                html_body="""
                    <table>
                      <tr class="long">
                        <td>DDOG</td><td>$267.97</td><td>$244.00</td><td>$275.00</td>
                      </tr>
                      <tr class="long">
                        <td>DDOG</td><td>$268.97</td><td>$244.00</td><td>$275.00</td>
                      </tr>
                    </table>
                """,
                received_at=datetime(2026, 8, 3, 12, 45, tzinfo=timezone.utc),
                s3_key="investing-ideas/conflicting.html",
                message_id="conflicting-investing-ideas",
                subject="Investing Ideas Newsletter: August 03, 2026",
            )

    def test_real_time_alert_persists_refreshed_spx_risk_range(self):
        subject = "Real-Time Alert: Sell-SOME Signal (refreshed SPX Risk Range): APLE - KM"
        self.assertEqual(
            ingestor.infer_report_type("message-body.html", subject),
            "real-time-alert",
        )
        snapshot = ingestor.parse_html_snapshot(
            report_type="real-time-alert",
            html_body="""
                <div class="headline">Real-Time Alert: Sell-SOME Signal (refreshed SPX Risk Range): APLE - KM</div>
                <p>08/03/2026 10:23 AM EDT</p>
                <p>SPX Refreshed Risk Range = 7,344-7,585</p>
            """,
            received_at=datetime(2026, 8, 3, 14, 23, tzinfo=timezone.utc),
            s3_key="gmail/real-time-alert/refreshed-spx.html",
            message_id="rta-refreshed-spx",
            subject=subject,
        )

        self.assertIsNotNone(snapshot)
        self.assertEqual(
            snapshot["data"]["alert"]["refreshedRiskRange"],
            {
                "ticker": "SPX",
                "lrr": 7344.0,
                "hrr": 7585.0,
                "label": "SPX Refreshed Risk Range",
            },
        )

    def test_august_17_investing_ideas_materializes_all_fourteen_positions(self):
        html_body = (
            GMAIL_FIXTURE_DIR / "investing-ideas-2026-08-17-sanitized.html"
        ).read_text(encoding="utf-8")

        snapshot = ingestor.parse_html_snapshot(
            report_type="investing-ideas",
            html_body=html_body,
            received_at=datetime(2026, 8, 17, 13, 0, tzinfo=timezone.utc),
            s3_key="investing-ideas/2026-08-17-sanitized.html",
            message_id="sanitized-investing-ideas-2026-08-17",
            subject="Investing Ideas Newsletter: August 17, 2026",
        )

        self.assertEqual(snapshot["positionCount"], 14)
        self.assertEqual(snapshot["longCount"], 12)
        self.assertEqual(snapshot["shortCount"], 2)
        self.assertEqual(
            snapshot["data"]["longs"],
            [
                "DDOG", "LLY", "CZR", "SBUX", "KMX", "TXG",
                "PCAR", "RCL", "AMZN", "PVH", "DT", "EXPGY",
            ],
        )
        self.assertEqual(snapshot["data"]["shorts"], ["WING", "WMT"])

    def test_investing_ideas_rejects_partial_mismatched_and_duplicate_books(self):
        cases = (
            (
                "partial",
                "<p>Long: DDOG</p><table><tr class='long'>"
                "<td>DDOG</td><td>$140</td><td>$125</td></tr></table>",
            ),
            (
                "summary-mismatch",
                "<p>Long: LLY</p><table><tr class='long'>"
                "<td>DDOG</td><td>$140</td><td>$125</td><td>$152</td>"
                "</tr></table>",
            ),
            (
                "duplicate",
                "<table><tr class='long'><td>DDOG</td><td>$140</td>"
                "<td>$125</td><td>$152</td></tr><tr class='short'>"
                "<td>DDOG</td><td>$140</td><td>$125</td><td>$152</td>"
                "</tr></table>",
            ),
        )
        for name, html_body in cases:
            with self.subTest(name=name), self.assertRaises(ValueError):
                ingestor.parse_html_snapshot(
                    report_type="investing-ideas",
                    html_body=html_body,
                    received_at=datetime(2026, 8, 17, 13, 0, tzinfo=timezone.utc),
                    s3_key=f"investing-ideas/{name}.html",
                    message_id=f"sanitized-{name}",
                    subject="Investing Ideas Newsletter: August 17, 2026",
                )

    def test_real_time_alert_priority_and_single_letter_subject_are_strict(self):
        bjri_subject = (
            "Real-Time Alert: BUY Signal: BJRI (Signal Strength Stock)"
        )
        self.assertEqual(
            ingestor.infer_report_type("message-body.html", bjri_subject),
            "real-time-alert",
        )

        visa_subject = (
            "Real-Time Alert: Sell-SOME Signal "
            "(consistency and discipline): V -KM"
        )
        snapshot = ingestor.parse_html_snapshot(
            report_type="real-time-alert",
            html_body="<h1>SELL SIGNAL WRONG</h1><p>SELL SIGNAL V $364.78</p>",
            received_at=datetime(2026, 8, 14, 15, 0, tzinfo=timezone.utc),
            s3_key="real-time-alert/visa-sanitized.html",
            message_id="sanitized-visa-alert",
            subject=visa_subject,
        )
        self.assertEqual(snapshot["data"]["alert"]["ticker"], "V")
        self.assertEqual(snapshot["data"]["alert"]["action"], "SELL-SOME")
        self.assertEqual(snapshot["data"]["headline"], visa_subject)

        ambiguous = ingestor.parse_html_snapshot(
            report_type="real-time-alert",
            html_body="<h1>Real-Time Alert: portfolio note</h1>",
            received_at=datetime(2026, 8, 14, 15, 0, tzinfo=timezone.utc),
            s3_key="real-time-alert/ambiguous.html",
            message_id="sanitized-ambiguous-alert",
            subject="Real-Time Alert: portfolio note",
        )
        self.assertIsNone(ambiguous)

    def test_market_situation_report_is_classified_and_materialized_as_structured_signals(self):
        subject = (
            "MARKET SITUATION REPORT: July 30th 2026 | "
            "Structurally Vulnerable Setup"
        )
        self.assertIn("market-structure", ingestor.HTML_TEXTRACT_REPORT_TYPES)
        self.assertEqual(
            ingestor.infer_report_type("message-body.html", subject),
            "market-structure",
        )

        source_root = (
            "https://d1yhils6iwh5l5.cloudfront.net/"
            "charts/resized/158506/original"
        )
        html_body = f"""
            <html><body>
              <div>07/30/2026 06:30 AM EDT</div>
              <div class="headline">{subject}</div>
              <img class="chart"
                   src="{source_root}/signals.png?src=email&amp;email=subscriber@example.com">
              <img class="chart"
                   src="{source_root}/term-structure.png?src=email&amp;email=subscriber@example.com">
              <p>To access the full Market Situation Report -> Click Here</p>
              <p>Short gamma and systematic selling leave the market structurally vulnerable.</p>
              <p>Disclaimer: research use only.</p>
            </body></html>
        """

        snapshot = ingestor.parse_html_snapshot(
            report_type="market-structure",
            html_body=html_body,
            received_at=datetime(2026, 7, 30, 13, 30, tzinfo=timezone.utc),
            s3_key="hedgeye-email/messages/2026-07-30/market-structure/message.html",
            message_id="market-situation-2026-07-30",
            subject=subject,
            image_fetcher=lambda _url: market_situation_signal_png(),
            chart_archiver=archive_market_situation_chart,
        )

        self.assertIsNotNone(snapshot)
        self.assertEqual(snapshot["snapshotType"], "market-structure")
        self.assertEqual(snapshot["date"], "2026-07-30")
        self.assertEqual(snapshot["signalCount"], 4)
        self.assertEqual(snapshot["chartCount"], 2)
        self.assertEqual(
            [(signal["label"], signal["value"], signal["tone"]) for signal in snapshot["data"]["signals"]],
            [
                ("SPX Gamma Exposure", "Negative", "negative"),
                ("Systematic Flow Risk", "Bearish", "negative"),
                ("PV Band Risk/Reward", "Neutral", "neutral"),
                ("Strategic Allocation", "Risk On", "positive"),
            ],
        )
        self.assertEqual(
            snapshot["data"]["signalMatrixChartId"],
            snapshot["data"]["charts"][0]["sha256"],
        )
        self.assertEqual(snapshot["schemaVersion"], "market-structure-v4")
        self.assertTrue(snapshot["contentComplete"])
        self.assertEqual(
            [block["type"] for block in snapshot["data"]["blocks"]],
            ["chart", "chart", "paragraph"],
        )
        self.assertNotIn("subscriber@example.com", json.dumps(snapshot))
        self.assertNotIn("cloudfront.net", json.dumps(snapshot))
        self.assertIn(
            "structurally vulnerable",
            snapshot["article"]["bodyText"].lower(),
        )

    def test_market_situation_report_extracts_labeled_gamma_throttle_chart_metrics(self):
        root = "https://d1yhils6iwh5l5.cloudfront.net/charts/gamma"
        html_body = f"""
            <div>08/25/2026 06:30 AM EDT</div>
            <p>Neutral gamma limits current dealer influence.</p>
            <img class="chart" src="{root}/signals.png">
            <img class="chart" src="{root}/gamma-throttle.png">
        """
        signal_payload = market_situation_signal_png(selections=(1, 1, 1, 0))
        throttle_payload = signal_payload + b"\x00"
        textract_client = FakeDetectTextract(
            textract_line_response("Market Situation Signal Matrix"),
            textract_line_response(
                "SPX Gamma Volatility Throttle Vs. 10-Day Realized Volatility",
                "Gamma Throttle: 0.56",
                "10-Day rVol: 9.37",
                "Date: 2026/08/24",
                "Source: Tier1Alpha.com",
            ),
        )

        snapshot = ingestor.parse_html_snapshot(
            report_type="market-structure",
            html_body=html_body,
            received_at=datetime(2026, 8, 25, 13, 30, tzinfo=timezone.utc),
            s3_key="market-structure/2026-08-25.html",
            message_id="market-situation-gamma-throttle",
            image_fetcher=lambda url: (
                signal_payload if url.endswith("signals.png") else throttle_payload
            ),
            chart_archiver=archive_market_situation_chart,
            textract_client=textract_client,
        )

        self.assertEqual(snapshot["htmlSource"], "market-structure/2026-08-25.html")
        self.assertEqual(len(textract_client.calls), 2)
        self.assertEqual(
            snapshot["data"]["chartMetrics"]["spxGammaVolatilityThrottle"],
            {
                "id": "spxGammaVolatilityThrottle",
                "label": "SPX Gamma Volatility Throttle",
                "gammaThrottle": Decimal("0.56"),
                "tenDayRealizedVolatility": Decimal("9.37"),
                "chartDate": "2026-08-24",
                "chartId": hashlib.sha256(throttle_payload).hexdigest(),
                "extractionBasis": "labeled-chart-ocr",
                "parserVersion": "market-structure-chart-metrics-v3",
                "source": "Tier1Alpha.com",
            },
        )
        self.assertIn("SPX probable-volatility gamma map", snapshot["warnings"][0])

    def test_market_situation_report_extracts_labeled_spx_gamma_strike_map(self):
        root = "https://d1yhils6iwh5l5.cloudfront.net/charts/gamma-map"
        html_body = f"""
            <div>08/25/2026 06:30 AM EDT</div>
            <p>Neutral gamma leaves the index in no man's land.</p>
            <img class="chart" src="{root}/signals.png">
            <img class="chart" src="{root}/gamma-throttle.png">
            <img class="chart" src="{root}/gamma-by-strike.png">
        """
        signal_payload = market_situation_signal_png(selections=(1, 1, 1, 0))
        throttle_payload = signal_payload + b"\x00"
        strike_payload = signal_payload + b"\x00\x00"
        textract_client = FakeDetectTextract(
            textract_line_response("Market Situation Signal Matrix"),
            textract_line_response(
                "SPX Gamma Volatility Throttle Vs. 10-Day Realized Volatility",
                "Gamma Throttle: 0.56",
                "10-Day rVol: 9.37",
                "Date: 2026/08/24",
                "Source: Tier1Alpha.com",
            ),
            textract_line_response(
                "SPX Probable Volatility / Gamma By Strike",
                "Strikes In Play: 7600, 7650, 7675, 7700, 7750",
                "Zero Gamma: 7646",
                "Upper PV Band: 7798",
                "Lower PV Band: 7573",
                "Date: 2026/08/24",
                "Source: Tier1Alpha.com",
            ),
        )

        snapshot = ingestor.parse_html_snapshot(
            report_type="market-structure",
            html_body=html_body,
            received_at=datetime(2026, 8, 25, 13, 30, tzinfo=timezone.utc),
            s3_key="market-structure/2026-08-25.html",
            message_id="market-situation-gamma-map",
            image_fetcher=lambda url: (
                signal_payload if url.endswith("signals.png")
                else throttle_payload if url.endswith("gamma-throttle.png")
                else strike_payload
            ),
            chart_archiver=archive_market_situation_chart,
            textract_client=textract_client,
        )

        self.assertEqual(
            snapshot["data"]["chartMetrics"]["spxProbableVolatilityGamma"],
            {
                "id": "spxProbableVolatilityGamma",
                "label": "SPX Probable Volatility / Gamma By Strike",
                "zeroGamma": Decimal("7646"),
                "upperPvBand": Decimal("7798"),
                "lowerPvBand": Decimal("7573"),
                "strikesInPlay": [
                    Decimal("7600"), Decimal("7650"), Decimal("7675"),
                    Decimal("7700"), Decimal("7750"),
                ],
                "chartDate": "2026-08-24",
                "chartId": hashlib.sha256(strike_payload).hexdigest(),
                "extractionBasis": "labeled-chart-ocr",
                "parserVersion": "market-structure-chart-metrics-v3",
                "source": "Tier1Alpha.com",
            },
        )
        self.assertNotIn("warnings", snapshot)

    def test_gamma_throttle_chart_metrics_reject_unlabeled_numbers(self):
        metric = email_parser._extract_spx_gamma_volatility_throttle_metric(
            textract_line_response(
                "SPX Gamma Volatility Throttle Vs. 10-Day Realized Volatility",
                "0.56",
                "9.37",
                "Date: 2026/08/24",
            ),
            chart_id="chart-1",
        )

        self.assertIsNone(metric)

    def test_market_situation_report_keeps_complete_source_when_signal_matrix_is_incomplete(self):
        html_body = """
            <div>07/30/2026 06:30 AM EDT</div>
            <p>Substantive market structure research remains available.</p>
            <img class="chart"
                 src="https://d1yhils6iwh5l5.cloudfront.net/charts/signals.png">
        """

        snapshot = ingestor.parse_html_snapshot(
            report_type="market-structure",
            html_body=html_body,
            received_at=datetime(2026, 7, 30, 13, 30, tzinfo=timezone.utc),
            s3_key="market-structure/message.html",
            message_id="incomplete-market-situation",
            image_fetcher=lambda _url: market_situation_signal_png(
                selections=(2, 2, 1),
            ),
            chart_archiver=archive_market_situation_chart,
        )

        self.assertTrue(snapshot["contentComplete"])
        self.assertEqual(snapshot["data"]["signals"], [])
        self.assertEqual(snapshot["signalCount"], 0)
        self.assertIn("Signal summary unavailable", snapshot["warnings"][0])

    def test_market_situation_report_accepts_current_wide_brand_signal_matrix(self):
        html_body = """
            <div>08/05/2026 04:00 AM EDT</div>
            <div class="headline">MARKET SITUATION REPORT: August 5th 2026</div>
            <p>To access the full Market Situation Report -&gt; Click Here!</p>
            <p>Positive gamma continues to suppress realized volatility.</p>
            <img class="chart" src="https://d1yhils6iwh5l5.cloudfront.net/charts/signals.png">
        """

        snapshot = ingestor.parse_html_snapshot(
            report_type="market-structure",
            html_body=html_body,
            received_at=datetime(2026, 8, 5, 11, 0, tzinfo=timezone.utc),
            s3_key="market-structure/current.html",
            message_id="current-market-situation",
            image_fetcher=lambda _url: market_situation_signal_png(
                selections=(0, 2, 2, 2),
                width=1910,
                height=438,
                centers=(0.432, 0.658, 0.884),
                colors=((55, 126, 34), (255, 165, 0), (233, 51, 35)),
            ),
            chart_archiver=archive_market_situation_chart,
        )

        self.assertIsNotNone(snapshot)
        self.assertEqual(
            [signal["value"] for signal in snapshot["data"]["signals"]],
            ["Positive", "Bearish", "Short", "Risk Off"],
        )

    def test_market_situation_signal_layout_is_independent_of_image_resolution(self):
        # September 16 used the compact layout at 1552px wide. A width-based
        # switch incorrectly read its red Negative selection as Neutral and
        # discarded every signal even though the source chart was intact.
        for width, height, centers in (
            (1552, 294, (0.412, 0.585, 0.758)),
            (800, 240, (0.432, 0.658, 0.884)),
        ):
            with self.subTest(width=width):
                signals = email_parser._extract_market_situation_signals(
                    market_situation_signal_png(
                        selections=(2, 1, 1, 0), width=width, height=height,
                        centers=centers,
                    )
                )
                self.assertEqual(
                    [signal["value"] for signal in signals],
                    ["Negative", "Neutral", "Neutral", "Risk On"],
                )

    def test_market_situation_rejects_color_in_an_unverified_column(self):
        with self.assertRaisesRegex(ValueError, "color/position verification"):
            email_parser._extract_market_situation_signals(
                market_situation_signal_png(
                    selections=(2, 1, 1, 0), width=1552, height=294,
                    centers=(0.412, 0.585, 0.658),
                )
            )

    def test_market_situation_report_preserves_seven_charts_and_text_in_source_order(self):
        root = "https://d1yhils6iwh5l5.cloudfront.net/charts/resized/weekly"
        chart_tags = [
            f'<img class="chart" alt="Chart {index}" '
            f'src="{root}/chart-{index}.png?email=subscriber@example.com">'
            for index in range(1, 8)
        ]
        html_body = f"""
            <html><body>
              <div>This research was prepared exclusively for subscriber@example.com.</div>
              <div>Having trouble viewing this email?<br>View it in your browser</div>
              <div>08/10/2026 06:30 AM EDT</div>
              <h1>MARKET SITUATION REPORT: August 10th, 2026</h1>
              <p>The research note below was written by Tier 1 Alpha and Presented by Hedgeye®.</p>
              {chart_tags[0]}
              <h2>WEEKLY GAME PLAN</h2>
              <p>To access the full report, please Click Here!</p>
              <p>Important Note: This report is dated research, not an executable quote.</p>
              <p>On 08/10/2026 06:30 AM EDT, SPX remained in positive gamma. First complete narrative paragraph.</p>
              {chart_tags[1]}
              <p>Second complete narrative paragraph.</p>
              {chart_tags[2]}
              <p>Third complete narrative paragraph.</p>
              {chart_tags[3]}
              <p>Fourth complete narrative paragraph.</p>
              {chart_tags[4]}
              <p>Fifth complete narrative paragraph.</p>
              {chart_tags[5]}
              <p>Sixth complete narrative paragraph.</p>
              {chart_tags[6]}
              <p>By Craig Peterson</p>
              <div id="disclaimer">
                <div>Legal Disclaimer: subscriber-only research.</div>
                <div>All rights reserved.</div>
              </div>
              <img src="https://tracking.example.com/pixel.gif">
            </body></html>
        """
        signal_payload = market_situation_signal_png()
        payloads = {
            f"{root}/chart-{index}.png": signal_payload + (b"" if index == 1 else bytes([index]))
            for index in range(1, 8)
        }

        snapshot = ingestor.parse_html_snapshot(
            report_type="market-structure",
            html_body=html_body,
            received_at=datetime(2026, 8, 10, 10, 30, tzinfo=timezone.utc),
            s3_key="hedgeye-email/messages/2026-08-10/market-structure/message.html",
            message_id="market-situation-2026-08-10",
            subject="MARKET SITUATION REPORT: August 10th, 2026 | WEEKLY GAME PLAN",
            image_fetcher=lambda url: payloads[url],
            chart_archiver=archive_market_situation_chart,
        )

        blocks = snapshot["data"]["blocks"]
        self.assertEqual(snapshot["chartCount"], 7)
        self.assertEqual(len(snapshot["data"]["charts"]), 7)
        self.assertEqual(
            [block["type"] for block in blocks],
            [
                "chart", "heading", "callout", "paragraph",
                "chart", "paragraph", "chart", "paragraph", "chart",
                "paragraph", "chart", "paragraph", "chart", "paragraph",
                "chart",
            ],
        )
        self.assertEqual(snapshot["article"]["reportHeading"], "WEEKLY GAME PLAN")
        self.assertNotIn("byline", snapshot["article"])
        self.assertNotIn("disclaimer", snapshot["article"])
        self.assertNotIn("publisher", snapshot["article"])
        self.assertNotIn("headline", snapshot["article"])
        self.assertNotIn("sourceAttribution", snapshot["data"])
        self.assertIn("On 08/10/2026 06:30 AM EDT, SPX", snapshot["article"]["bodyText"])
        serialized = json.dumps(snapshot)
        self.assertNotIn("subscriber@example.com", serialized)
        self.assertNotIn("tracking.example.com", serialized)
        self.assertNotIn("?email=", serialized)
        self.assertNotIn("Having trouble viewing", serialized)
        self.assertNotIn("Tier 1 Alpha", serialized)
        self.assertNotIn("Click Here", serialized)
        self.assertNotIn("By Craig Peterson", serialized)
        self.assertNotIn("Legal Disclaimer", serialized)

    def test_market_situation_report_rejects_invalid_chart_bytes_before_archival(self):
        archive_chart = MagicMock()

        with self.assertRaisesRegex(ValueError, "invalid image signature"):
            ingestor.parse_html_snapshot(
                report_type="market-structure",
                html_body="""
                    <h1>MARKET SITUATION REPORT: August 10th, 2026</h1>
                    <p>Substantive dated market structure research.</p>
                    <img class="chart" src="https://d1yhils6iwh5l5.cloudfront.net/charts/invalid.png">
                """,
                received_at=datetime(2026, 8, 10, 10, 30, tzinfo=timezone.utc),
                s3_key="hedgeye-email/messages/2026-08-10/market-structure/message.html",
                message_id="market-situation-invalid-image",
                image_fetcher=lambda _url: b"this is not an image",
                chart_archiver=archive_chart,
            )

        archive_chart.assert_not_called()

    def test_market_situation_report_rejects_more_than_twelve_charts_before_fetching(self):
        chart_tags = "".join(
            f'<img class="chart" src="https://d1yhils6iwh5l5.cloudfront.net/charts/chart-{index}.png">'
            for index in range(13)
        )
        fetch_chart = MagicMock(return_value=market_situation_signal_png())
        archive_chart = MagicMock()

        with self.assertRaisesRegex(ValueError, "chart-count limit"):
            ingestor.parse_html_snapshot(
                report_type="market-structure",
                html_body=(
                    "<h1>MARKET SITUATION REPORT: August 10th, 2026</h1>"
                    "<p>Substantive dated market structure research.</p>"
                    f"{chart_tags}"
                ),
                received_at=datetime(2026, 8, 10, 10, 30, tzinfo=timezone.utc),
                s3_key="hedgeye-email/messages/2026-08-10/market-structure/message.html",
                message_id="market-situation-too-many-charts",
                image_fetcher=fetch_chart,
                chart_archiver=archive_chart,
            )

        fetch_chart.assert_not_called()
        archive_chart.assert_not_called()

    def test_signal_strength_html_chart_materializes_the_full_reader_row_set(self):
        def cell(block_id, row_index, column_index, text):
            word_id = f"{block_id}-word"
            return [
                {
                    "BlockType": "CELL",
                    "Id": block_id,
                    "RowIndex": row_index,
                    "ColumnIndex": column_index,
                    "Relationships": [{"Type": "CHILD", "Ids": [word_id]}],
                },
                {"BlockType": "WORD", "Id": word_id, "Text": text},
            ]

        blocks = [
            {"BlockType": "TABLE", "Id": "table", "Relationships": [{"Type": "CHILD", "Ids": [
                "h-days", "h-ticker", "h-percent", "r1-days", "r1-ticker", "r1-percent",
            ]}]},
        ]
        for block_id, row_index, column_index, text in (
            ("h-days", 1, 1, "Days On"),
            ("h-ticker", 1, 2, "Ticker"),
            ("h-percent", 1, 3, "% Since Initial Signal"),
            ("r1-days", 2, 1, "12"),
            ("r1-ticker", 2, 2, "AAPL"),
            ("r1-percent", 2, 3, "+4.5%"),
        ):
            blocks.extend(cell(block_id, row_index, column_index, text))

        class FakeTextract:
            def analyze_document(self, **_kwargs):
                return {"Blocks": blocks}

        snapshot = email_parser.parse_html_snapshot(
            report_type="signal-strength",
            html_body="""
                <div>08/06/2026 12:54 PM EDT</div>
                <p>Signal Strength Stocks: 1 Stocks (1 Added, 0 Removed)</p>
                <p>Added: AAPL</p>
                <img src="https://d1yhils6iwh5l5.cloudfront.net/charts/SSS_8_6.png?src=email&amp;email=subscriber@example.com">
            """,
            received_at=datetime(2026, 8, 6, 16, 54, tzinfo=timezone.utc),
            s3_key="signal-strength/message.html",
            message_id="signal-strength-chart",
            image_fetcher=lambda _url: b"source-chart",
            textract_client=FakeTextract(),
        )

        self.assertIsNotNone(snapshot)
        self.assertTrue(snapshot["data"]["membershipComplete"])
        self.assertEqual(
            snapshot["data"]["stocks"],
            [{"ticker": "AAPL", "daysOn": 12, "percentChangeSinceSignal": Decimal("4.5")}],
        )

    @staticmethod
    def _signal_strength_html(*, book, count, adding, removing, rows, stamp="10/22/2026 11:14 AM EDT"):
        def change_line(label, symbols):
            if symbols is None:
                return ""
            return (f'<p><span class="semibold">{label}: </span><span>{symbols}</span></p>')

        header = "".join(f'<th class="header-cell">{label}</th>' for label in (
            "Ticker", "Name", "Sector", "Analyst", "Entry Date", "Entry Price",
            "Recent Price", "Total Return", "Best Idea Rank", "Days Held"))
        body = "".join(
            "<tr>" + "".join(f'<td class="cell">{value}</td>' for value in row) + "</tr>"
            for row in rows
        )
        return f"""
            <div>{stamp}</div>
            <p>Signal Strength {book}: {count} Stocks</p>
            <p>Access Signal Strength Stocks Dashboard</p>
            {change_line("ADDING", adding)}
            {change_line("REMOVING", removing)}
            <div class="table-scroll"><table class="data-table open-positions-table">
            <thead><tr class="header-row">{header}</tr></thead><tbody>{body}</tbody></table></div>
        """

    def test_signal_strength_html_table_carries_the_full_long_book(self):
        snapshot = email_parser.parse_html_snapshot(
            report_type="signal-strength",
            html_body=self._signal_strength_html(
                book="Stocks", count=2, adding="MCK, PR", removing="AMZN",
                rows=[
                    ("OKTA", "Okta Inc.", "Software", "Andrew Freedman", "05/26/26", "$95.20", "$204.88", "+115.12%", "Bench", "149"),
                    ("MCK", "McKesson Corporation", "Healthcare", "Tom Tobin", "10/22/26", "$1,010.50", "$1,010.50", "+0.00%", "2/6", "0"),
                ],
            ),
            received_at=datetime(2026, 10, 22, 15, 13, tzinfo=timezone.utc),
            s3_key="signal-strength/longs.html",
            message_id="signal-strength-longs",
        )

        self.assertEqual(snapshot["stockCount"], 2)
        self.assertNotIn("shorts", snapshot["data"])
        self.assertEqual(snapshot["data"]["added"], ["MCK", "PR"])
        self.assertEqual(snapshot["data"]["removed"], ["AMZN"])
        self.assertTrue(snapshot["data"]["membershipComplete"])
        self.assertEqual(snapshot["data"]["stocks"][0], {
            "ticker": "OKTA", "side": "long", "name": "Okta Inc.", "sector": "Software",
            "analyst": "Andrew Freedman", "bestIdeaRank": "Bench", "entryDate": "2026-05-26",
            "entryPrice": Decimal("95.20"), "recentPrice": Decimal("204.88"),
            "totalReturn": Decimal("115.12"), "daysOn": 149,
            "percentChangeSinceSignal": Decimal("115.12"),
        })
        self.assertEqual(snapshot["data"]["stocks"][1]["entryPrice"], Decimal("1010.50"))

    def test_signal_strength_shorts_list_is_its_own_product(self):
        self.assertEqual(
            ingestor.infer_report_type("message-body.html", "Signal Strength Shorts: 67 Stocks (5 added, 11 removed)"),
            "signal-strength-shorts",
        )
        self.assertEqual(
            ingestor.infer_report_type("message-body.html", "Signal Strength Stocks: 51 Stocks (0 added, 3 removed)"),
            "signal-strength",
        )
        snapshot = email_parser.parse_html_snapshot(
            report_type="signal-strength-shorts",
            html_body=self._signal_strength_html(
                book="Shorts", count=1, adding=None, removing="BRBR, DECK",
                rows=[("LULU", "lululemon athletica inc.", "Retail", "Brian McGough", "02/15/26", "$177.72", "$100.10", "+44.02%", "25/30", "249")],
            ),
            received_at=datetime(2026, 10, 22, 15, 14, tzinfo=timezone.utc),
            s3_key="signal-strength/shorts.html",
            message_id="signal-strength-shorts",
        )

        self.assertIsNotNone(snapshot)
        self.assertEqual(snapshot["snapshotType"], "signal-strength-shorts")
        self.assertEqual(snapshot["reportType"], "signal-strength-shorts")
        self.assertEqual(snapshot["stockCount"], 1)
        self.assertNotIn("shortCount", snapshot)
        shorts = snapshot["data"]
        self.assertNotIn("shorts", shorts)
        self.assertEqual(shorts["added"], [])
        self.assertEqual(shorts["removed"], ["BRBR", "DECK"])
        self.assertTrue(shorts["membershipComplete"])
        # A short position's total return is not the price change since the signal.
        self.assertEqual(shorts["stocks"][0]["side"], "short")
        self.assertEqual(shorts["stocks"][0]["totalReturn"], Decimal("44.02"))
        self.assertNotIn("percentChangeSinceSignal", shorts["stocks"][0])

    def test_signal_strength_empty_adding_label_does_not_borrow_removals(self):
        html_body = self._signal_strength_html(book="Stocks", count=1, adding=None, removing=None, rows=[]).replace(
            "<div class=\"table-scroll\">",
            "<p>ADDING: </p><p>REMOVING: </p><p>VREOF</p><div class=\"table-scroll\">",
        )
        snapshot = email_parser.parse_html_snapshot(
            report_type="signal-strength",
            html_body=html_body,
            received_at=datetime(2026, 9, 25, 15, 32, tzinfo=timezone.utc),
            s3_key="signal-strength/removal-only.html",
            message_id="signal-strength-removal-only",
        )

        self.assertEqual(snapshot["data"]["added"], [])
        self.assertEqual(snapshot["data"]["removed"], ["VREOF"])

    def test_signal_strength_long_and_short_emails_materialize_separate_products(self):
        def parsed(book, message_id, minute, ticker, report_type="signal-strength"):
            return email_parser.parse_html_snapshot(
                report_type=report_type,
                html_body=self._signal_strength_html(
                    book=book, count=1, adding=ticker, removing=None,
                    rows=[(ticker, f"{ticker} Inc.", "Retail", "Analyst", "10/22/26", "$10.00", "$11.00", "+10.00%", "Bench", "0")],
                ),
                received_at=datetime(2026, 10, 22, 15, minute, tzinfo=timezone.utc),
                s3_key=f"signal-strength/{message_id}.html",
                message_id=message_id,
            )

        longs = parsed("Stocks", "longs-1113", 13, "MCK")
        shorts = parsed("Shorts", "shorts-1114", 14, "SMCI", "signal-strength-shorts")
        for order in ((longs, shorts), (shorts, longs)):
            table = FakeSnapshotTable()
            db = FakeDynamoDb(table)
            for snapshot in order:
                ingestor.materialize_email_snapshot(deepcopy(snapshot), db)
            stored_longs = table.items[("2026-10-22", "signal-strength")]
            stored_shorts = table.items[("2026-10-22", "signal-strength-shorts")]
            self.assertEqual([row["ticker"] for row in stored_longs["data"]["stocks"]], ["MCK"])
            self.assertEqual([row["ticker"] for row in stored_shorts["data"]["stocks"]], ["SMCI"])
            self.assertNotIn("shorts", stored_longs["data"])
            self.assertEqual(stored_longs["sourceMessageIds"], ["longs-1113"])
            self.assertEqual(stored_shorts["sourceMessageIds"], ["shorts-1114"])

        # The body's book heading decides even when the subject named the long list.
        self.assertEqual(parsed("Shorts", "shorts-1115", 15, "SMCI")["snapshotType"], "signal-strength-shorts")

        # Replaying an earlier long edition never replaces a later one.
        later_longs = parsed("Stocks", "longs-1130", 30, "PR")
        table = FakeSnapshotTable()
        db = FakeDynamoDb(table)
        for snapshot in (later_longs, shorts, longs):
            ingestor.materialize_email_snapshot(deepcopy(snapshot), db)
        self.assertEqual([row["ticker"] for row in table.items[("2026-10-22", "signal-strength")]["data"]["stocks"]], ["PR"])
        self.assertEqual([row["ticker"] for row in table.items[("2026-10-22", "signal-strength-shorts")]["data"]["stocks"]], ["SMCI"])

    def test_momo_tracker_extracts_the_approved_range_and_trend_table(self):
        source_root = "https://d1yhils6iwh5l5.cloudfront.net/charts/momo"
        html_body = """
            <div>08/07/2026 08:15 AM EDT</div>
            <div class="headline">MOMO Tracker</div>
        """ + "".join(
            f'<img src="{source_root}/{index}.png?src=email&amp;subscriber=private">'
            for index in (6, 1, 2, 3, 4, 5)
        )
        textract_client = FakeTextract(textract_table_response([
            ["", "Buy Trade", "Sell Trade", "Upside", "Downside", "Trend"],
            ["NVDA", "$171.50", "$183.25", "+6.8%", "-4.1%", "BULLISH"],
            ["META", "$744.00", "$781.00", "+5.0%", "-3.2%", "NEUTRAL"],
            ["ORCL", "Outbucket (08/13)", "Outbucket (08/13)", "", "", "BULLISH"],
        ]))
        fetched_urls = []

        snapshot = email_parser.parse_html_snapshot(
            report_type="momo-tracker",
            html_body=html_body,
            received_at=datetime(2026, 8, 7, 12, 15, tzinfo=timezone.utc),
            s3_key="momo-tracker/message.html",
            message_id="momo-2026-08-07",
            image_fetcher=lambda url: fetched_urls.append(url) or b"momo-table",
            textract_client=textract_client,
        )

        self.assertIsNotNone(snapshot)
        self.assertEqual(snapshot["stockCount"], 3)
        self.assertEqual(snapshot["rangeAvailableCount"], 2)
        self.assertEqual(snapshot["outbucketCount"], 1)
        self.assertEqual(snapshot["chartCount"], 6)
        self.assertEqual(snapshot["data"], {
            "NVDA": {
                "buyTrade": Decimal("171.50"),
                "sellTrade": Decimal("183.25"),
                "upside": Decimal("6.8"),
                "downside": Decimal("-4.1"),
                "trend": "BULLISH",
                "rangeStatus": "available",

                "lrr": Decimal("171.50"),
                "hrr": Decimal("183.25"),
                "index": 0,
            },
            "META": {
                "buyTrade": Decimal("744.00"),
                "sellTrade": Decimal("781.00"),
                "upside": Decimal("5.0"),
                "downside": Decimal("-3.2"),
                "trend": "NEUTRAL",
                "rangeStatus": "available",

                "lrr": Decimal("744.00"),
                "hrr": Decimal("781.00"),
                "index": 1,
            },
            "ORCL": {
                "buyTrade": None,
                "sellTrade": None,
                "upside": None,
                "downside": None,
                "trend": "BULLISH",
                "rangeStatus": "outbucket",
                "rangeStatusDate": "08/13",

                "lrr": None,
                "hrr": None,
                "index": 2,
            },
        })
        self.assertEqual(fetched_urls, [f"{source_root}/6.png"])
        self.assertEqual(len(textract_client.calls), 1)
        self.assertEqual(textract_client.calls[0]["FeatureTypes"], ["TABLES"])
        self.assertNotIn("subscriber", json.dumps(snapshot, default=str))
        self.assertNotIn("src=email", json.dumps(snapshot, default=str))

        snapshot_table = FakeSnapshotTable()
        email_parser.save_snapshot_to_dynamodb(
            snapshot,
            FakeDynamoDb(snapshot_table),
        )
        stored = snapshot_table.items[("2026-08-07", "momo-tracker")]
        self.assertIsNone(stored["data"]["ORCL"]["buyTrade"])
        self.assertIsNone(stored["data"]["ORCL"]["sellTrade"])
        self.assertEqual(stored["data"]["ORCL"]["trend"], "BULLISH")
        self.assertNotIn("trade", stored["data"]["ORCL"])
        self.assertEqual(stored["data"]["ORCL"]["rangeStatus"], "outbucket")

    def test_bitcoin_tracker_extracts_approved_crypto_and_equity_tables(self):
        source_root = "https://d1yhils6iwh5l5.cloudfront.net/charts/bitcoin"
        chart_names = [
            "TREND_Latest_TTM.png",
            "BTC_9.png",
            "BTC_1.png",
            "BTC_3.png",
            "BTC_4.png",
            "BTC_5.png",
            "BTC_6.png",
            "BTC_7.png",
            "BTC_8.png",
            "BTC_2.png",
        ]
        html_body = """
            <div>08/07/2026 09:05 AM EDT</div>
            <div class="headline">Bitcoin Tracker: BTC (+2.5%), ETH (-1.2%)</div>
        """ + "".join(
            f'<img src="{source_root}/{name}?email=private&amp;src=newsletter">'
            for name in chart_names
        )
        textract_client = FakeTextract(
            textract_tables_response(
                [
                    ["", "COIN VOLUME", "", "$USD VOLUME"],
                    ["BTC", "4.6%", "-15.1%", "5.4%"],
                    ["ETH", "21.8%", "-17.3%", "23.0%"],
                ],
                [
                    ["Crypto", "Price", "Buy Trade", "Sell Trade", "Trend"],
                    ["BTC", "$114,000", "$108,000", "$121,000", "BULLISH"],
                    ["ETH", "$3,610", "$3,350", "$3,900", "NEUTRAL"],
                ],
            ),
            textract_table_response([
                ["Ticker", "Price", "Buy Trade", "Sell Trade", "Upside", "Downside", "Trend"],
                ["NVDA", "$180.25", "$171.50", "$192.00", "+6.5%", "-4.9%", "BULLISH"],
                ["MSTR", "$412.00", "$380.00", "$450.00", "+9.2%", "-7.8%", "BEARISH"],
            ]),
        )
        fetched_urls = []

        snapshot = email_parser.parse_html_snapshot(
            report_type="crypto-quant",
            html_body=html_body,
            received_at=datetime(2026, 8, 7, 13, 5, tzinfo=timezone.utc),
            s3_key="crypto-quant/message.html",
            message_id="bitcoin-2026-08-07",
            image_fetcher=lambda url: fetched_urls.append(url) or b"tracker-table",
            textract_client=textract_client,
        )

        self.assertIsNotNone(snapshot)
        self.assertEqual(snapshot["snapshotType"], "bitcoin-trend-tracker")
        self.assertEqual(snapshot["cryptoCount"], 2)
        self.assertEqual(snapshot["stockCount"], 2)
        self.assertEqual(snapshot["data"]["cryptos"], {
            "BTC": {
                "price": Decimal("114000"),
                "buyTrade": Decimal("108000"),
                "sellTrade": Decimal("121000"),
                "trend": "BULLISH",

                "lrr": Decimal("108000"),
                "hrr": Decimal("121000"),
                "index": 0,
                "performancePercent": 2.5,
            },
            "ETH": {
                "price": Decimal("3610"),
                "buyTrade": Decimal("3350"),
                "sellTrade": Decimal("3900"),
                "trend": "NEUTRAL",

                "lrr": Decimal("3350"),
                "hrr": Decimal("3900"),
                "index": 1,
                "performancePercent": -1.2,
            },
        })
        self.assertEqual(snapshot["data"]["stocks"]["NVDA"], {
            "price": Decimal("180.25"),
            "buyTrade": Decimal("171.50"),
            "sellTrade": Decimal("192.00"),
            "upside": Decimal("6.5"),
            "downside": Decimal("-4.9"),
            "trend": "BULLISH",

            "lrr": Decimal("171.50"),
            "hrr": Decimal("192.00"),
            "index": 0,
        })
        self.assertEqual(fetched_urls, [
            f"{source_root}/BTC_2.png",
            f"{source_root}/BTC_9.png",
        ])
        self.assertEqual(len(textract_client.calls), 2)
        self.assertNotIn("private", json.dumps(snapshot, default=str))

    def test_tracker_chart_selection_uses_verified_ordinals_as_filename_fallback(self):
        source_root = "https://d1yhils6iwh5l5.cloudfront.net/charts/fallback"
        textract_client = FakeTextract(textract_table_response([
            ["Ticker", "Buy Trade", "Sell Trade", "Upside", "Downside", "Trend"],
            ["NVDA", "171", "183", "7", "-4", "BULLISH"],
        ]))
        fetched_urls = []
        snapshot = email_parser.parse_html_snapshot(
            report_type="momo-tracker",
            html_body="".join(
                f'<img src="{source_root}/chart-{index}.png">' for index in range(6)
            ),
            received_at=datetime(2026, 8, 7, 12, 15, tzinfo=timezone.utc),
            s3_key="momo-tracker/fallback.html",
            message_id="momo-fallback",
            image_fetcher=lambda url: fetched_urls.append(url) or b"momo-table",
            textract_client=textract_client,
        )

        self.assertEqual(snapshot["data"]["NVDA"]["trend"], "BULLISH")
        self.assertEqual(fetched_urls, [f"{source_root}/chart-5.png"])

    def test_tracker_tables_fail_closed_for_malformed_required_data(self):
        valid_header = [
            "Ticker", "Price", "Buy Trade", "Sell Trade", "Upside", "Downside", "Trend",
        ]
        cases = (
            ("headers", [["Ticker", "Price", "Trend"], ["NVDA", "180", "BULLISH"]]),
            ("incomplete", [valid_header, ["NVDA", "180", "171", "", "6", "-4", "BULLISH"]]),
            ("range", [valid_header, ["NVDA", "180", "190", "171", "6", "-4", "BULLISH"]]),
            ("trend", [valid_header, ["NVDA", "180", "171", "190", "6", "-4", "STRONG"]]),
            ("number", [valid_header, ["NVDA", "about 180", "171", "190", "6", "-4", "BULLISH"]]),
        )
        for label, rows in cases:
            with self.subTest(label=label):
                with self.assertRaises(ValueError):
                    email_parser._parse_tracker_table(
                        rows,
                        required_fields=(
                            "ticker",
                            "price",
                            "buyTrade",
                            "sellTrade",
                            "upside",
                            "downside",
                            "trend",
                        ),
                    )

    def test_momo_outbucket_rows_fail_closed_unless_the_contract_is_complete(self):
        required = (
            "ticker", "buyTrade", "sellTrade", "upside", "downside", "trend",
        )
        header = ["Ticker", "Buy Trade", "Sell Trade", "Upside", "Downside", "Trend"]
        invalid_rows = (
            ["ORCL", "Outbucket (08/13)", "130", "", "", "BULLISH"],
            ["ORCL", "Outbucket (08/13)", "Outbucket (08/14)", "", "", "BULLISH"],
            ["ORCL", "Outbucket (08/13)", "Outbucket", "", "", "BULLISH"],
            ["ORCL", "Outbucket (08/13)", "Outbucket (08/13)", "1.2%", "", "BULLISH"],
            ["ORCL", "Outbuckat (08/13)", "Outbuckat (08/13)", "", "", "BULLISH"],
            ["ORCL", "Outbucket (08/13)", "Outbucket (08/13)", "", "", "UNKNOWN"],
        )

        for row in invalid_rows:
            with self.subTest(row=row), self.assertRaises(ValueError):
                email_parser._parse_tracker_table(
                    [header, row],
                    required_fields=required,
                    allow_outbucket_rows=True,
                )

    def test_bitcoin_tracker_rejects_outbucket_rows(self):
        rows = [
            ["Crypto", "Price", "Buy Trade", "Sell Trade", "Trend"],
            ["BTC", "64517", "Outbucket (08/13)", "Outbucket (08/13)", "BULLISH"],
        ]

        with self.assertRaises(ValueError):
            email_parser._parse_tracker_table(
                rows,
                required_fields=("ticker", "price", "buyTrade", "sellTrade", "trend"),
            )

    def test_tracker_unsafe_url_oversize_and_textract_failures_never_index(self):
        unsafe_textract = FakeTextract(textract_table_response([]))
        unsafe = email_parser.parse_html_snapshot(
            report_type="momo-tracker",
            html_body='<img src="https://example.com/6.png?subscriber=private">',
            received_at=datetime(2026, 8, 7, 12, 15, tzinfo=timezone.utc),
            s3_key="momo-tracker/unsafe.html",
            message_id="momo-unsafe",
            textract_client=unsafe_textract,
        )
        self.assertIsNone(unsafe)
        self.assertEqual(unsafe_textract.calls, [])

        safe_html = (
            '<img src="https://d1yhils6iwh5l5.cloudfront.net/charts/6.png">'
        )
        for label, image_fetcher, textract_client in (
            (
                "oversized",
                lambda _url: (_ for _ in ()).throw(ValueError("image exceeds size limit")),
                FakeTextract(textract_table_response([])),
            ),
            (
                "textract",
                lambda _url: b"source-table",
                FakeTextract(RuntimeError("Textract unavailable")),
            ),
        ):
            with self.subTest(label=label):
                with self.assertRaises(Exception):
                    email_parser.parse_html_snapshot(
                        report_type="momo-tracker",
                        html_body=safe_html,
                        received_at=datetime(2026, 8, 7, 12, 15, tzinfo=timezone.utc),
                        s3_key=f"momo-tracker/{label}.html",
                        message_id=f"momo-{label}",
                        image_fetcher=image_fetcher,
                        textract_client=textract_client,
                    )

    def test_fresh_tracker_html_passes_textract_and_indexes_valid_events(self):
        tracker_snapshot = {
            "date": "2026-08-07",
            "snapshotType": "momo-tracker",
            "reportType": "momo-tracker",
            "source": "gmail-html",
            "scrapedAt": "2026-08-07T12:15:00+00:00",
            "publishedAt": "2026-08-07T12:15:00+00:00",
            "gmailMessageId": "momo-fresh",
            "data": {
                "NVDA": {
                    "buyTrade": Decimal("171"),
                    "sellTrade": Decimal("183"),
                    "trend": "BULLISH",
                },
            },
        }
        table = FakeLedgerTable()
        parser = MagicMock(return_value=tracker_snapshot)
        textract_client = object()
        with patch.object(ingestor, "textract", textract_client), patch.object(
            ingestor, "put_immutable_s3_object", return_value=True
        ), patch.object(
            ingestor, "parse_html_snapshot", parser
        ), patch.object(
            ingestor, "persist_research_event_ledger", return_value=1
        ), patch.object(
            ingestor, "persist_snapshot_intelligence", return_value=1
        ), patch.object(
            ingestor, "materialize_email_snapshot", return_value=({}, True)
        ), patch.object(
            ingestor, "finalize_snapshot_intelligence"
        ) as finalize:
            result = ingestor.upload_attachment(
                access_token="token",
                user_id="me",
                message_id="momo-fresh",
                attachment={
                    "attachmentId": "message-body-html-0",
                    "filename": "message-body.html",
                    "mimeType": "text/html",
                    "inlineData": base64.urlsafe_b64encode(
                        b"<html><body>MOMO Tracker</body></html>"
                    ).decode("ascii"),
                },
                headers={"subject": "MOMO Tracker", "from": "research@hedgeye.com"},
                received_at=datetime(2026, 8, 7, 12, 15, tzinfo=timezone.utc),
                table=table,
            )

        self.assertEqual(result[0], "stored")
        self.assertIs(parser.call_args.kwargs["textract_client"], textract_client)
        self.assertEqual(
            table.items[("momo-fresh", "message-body-html-0")]["materializationStatus"],
            "INDEXED",
        )
        finalize.assert_called_once()

    def test_forced_tracker_html_backfill_passes_textract_and_indexes_valid_events(self):
        archived_html = b"<html><body>Bitcoin Trend Tracker</body></html>"
        legacy_item = {
            "messageId": "bitcoin-backfill",
            "attachmentId": "message-body-html-0",
            "status": "INDEXED",
            "filename": "message-body.html",
            "mimeType": "text/html",
            "reportType": "crypto-quant",
            "subject": "Bitcoin Trend Tracker",
            "s3Bucket": "research",
            "s3Key": "crypto-quant/message.html",
            "contentSha256": hashlib.sha256(archived_html).hexdigest(),
            "materializationAttemptVersion": "gmail-materialized-v4-canonical-verification",
            "materializationStatus": "PARSED",
        }
        self.assertTrue(ingestor._should_backfill_materialized_snapshot(
            legacy_item,
            allow_version_upgrade=True,
        ))
        table = FakeLedgerTable([legacy_item])
        body = MagicMock()
        body.read.return_value = archived_html
        s3_client = MagicMock()
        s3_client.get_object.return_value = {"Body": body}
        tracker_snapshot = {
            "date": "2026-08-07",
            "snapshotType": "bitcoin-trend-tracker",
            "reportType": "crypto-quant",
            "source": "gmail-html",
            "scrapedAt": "2026-08-07T13:05:00+00:00",
            "publishedAt": "2026-08-07T13:05:00+00:00",
            "gmailMessageId": "bitcoin-backfill",
            "data": {
                "cryptos": {
                    "BTC": {
                        "buyTrade": Decimal("108000"),
                        "sellTrade": Decimal("121000"),
                        "trend": "BULLISH",
                    },
                },
            },
        }
        parser = MagicMock(return_value=tracker_snapshot)
        textract_client = object()
        with patch.object(ingestor, "textract", textract_client), patch.object(
            ingestor, "s3", s3_client
        ), patch.object(
            ingestor, "parse_html_snapshot", parser
        ), patch.object(
            ingestor, "persist_research_event_ledger", return_value=1
        ), patch.object(
            ingestor, "persist_snapshot_intelligence", return_value=1
        ), patch.object(
            ingestor, "materialize_email_snapshot", return_value=({}, True)
        ), patch.object(
            ingestor, "finalize_snapshot_intelligence"
        ) as finalize, patch.object(
            ingestor, "reclassify_manifest_artifact"
        ) as reclassify:
            materialized = ingestor.backfill_html_snapshot(
                table=table,
                message_id="bitcoin-backfill",
                attachment_id="message-body-html-0",
                report_type="crypto-quant",
                mime_type="text/html",
                received_at=datetime(2026, 8, 7, 13, 5, tzinfo=timezone.utc),
                ledger_item=legacy_item,
            )

        self.assertTrue(materialized)
        self.assertIs(parser.call_args.kwargs["textract_client"], textract_client)
        self.assertEqual(
            table.items[("bitcoin-backfill", "message-body-html-0")]["materializationStatus"],
            "INDEXED",
        )
        finalize.assert_called_once()
        # The legacy crypto-quant manifest artifact moves to the indexed
        # bitcoin-trend-tracker product only after finalization.
        reclassify.assert_called_once()
        self.assertEqual(
            reclassify.call_args.kwargs["source_product_id"],
            "crypto-quant",
        )

    def test_explicit_version_backfill_reclassifies_previously_unknown_market_situation_email(self):
        legacy_item = {
            "status": "UNSUPPORTED",
            "attachmentId": "message-body-html-0",
            "mimeType": "text/html",
            "filename": "message-body.html",
            "subject": (
                "MARKET SITUATION REPORT: July 30th 2026 | "
                "Structurally Vulnerable Setup"
            ),
            "reportType": "unknown",
            "s3Bucket": "research",
            "s3Key": "messages/market-situation.html",
            "materializationAttemptVersion": "older-parser",
        }

        self.assertFalse(
            ingestor._should_backfill_materialized_snapshot(
                legacy_item,
                allow_version_upgrade=False,
            )
        )
        self.assertTrue(
            ingestor._should_backfill_materialized_snapshot(
                legacy_item,
                allow_version_upgrade=True,
            )
        )

    def test_top_three_things_classification_wins_over_macro_show_materials_subject(self):
        self.assertEqual(
            ingestor.infer_report_type(
                "message-body.html",
                "THE MACRO SHOW: August 17th - Access Show, Slide Deck & Top 3 Things",
            ),
            "top-3-things",
        )
        self.assertEqual(
            ingestor.infer_report_type(
                "message-body.html",
                "THE MACRO SHOW: Summary Notes & Replay | Monday, August 17th, 2026",
            ),
            "the-macro-show",
        )

    def test_top_three_things_parser_preserves_macro_show_numbering(self):
        snapshot = ingestor.parse_html_snapshot(
            report_type="top-3-things",
            html_body="""
                <html>
                  <head>
                    <meta type="hedgeye-headline"
                          content="August 17th - Access Show, Slide Deck &amp; Top 3 Things">
                  </head>
                  <body>
                    <div>08/17/2026 08:41 AM EDT</div>
                    <div class="headline">THE MACRO SHOW: August 17th - Access Show, Slide Deck &amp; Top 3 Things</div>
                    <p>Hedgeye's top 3 things</p>
                    <p>SPY was down small on decelerating volume Friday.</p>
                    <p>1) USD – Dollar Index is making fresh two-month lows.</p>
                    <p>2) GOLD – Gold has the cleanest inverse correlation to USD.</p>
                    <p>3) ATHs (all-time highs) – RSP and IWM printed new highs.</p>
                    <p>VIEW LINK</p>
                  </body>
                </html>
            """,
            received_at=datetime(2026, 8, 17, 12, 42, tzinfo=timezone.utc),
            s3_key="sanitized/top-three-macro.html",
            message_id="top-three-macro",
            subject="THE MACRO SHOW: August 17th - Access Show, Slide Deck & Top 3 Things",
        )

        self.assertIsNotNone(snapshot)
        self.assertEqual(snapshot["snapshotType"], "top-3-things")
        self.assertEqual(snapshot["itemCount"], 3)
        self.assertEqual(
            snapshot["data"]["items"],
            [
                {
                    "rank": 1,
                    "title": "USD",
                    "body": "Dollar Index is making fresh two-month lows.",
                },
                {
                    "rank": 2,
                    "title": "GOLD",
                    "body": "Gold has the cleanest inverse correlation to USD.",
                },
                {
                    "rank": 3,
                    "title": "ATHs (all-time highs)",
                    "body": "RSP and IWM printed new highs.",
                },
            ],
        )
        self.assertEqual(
            snapshot["data"]["intro"],
            "SPY was down small on decelerating volume Friday.",
        )

    def test_top_three_things_parser_supports_standalone_km_ordered_list(self):
        snapshot = ingestor.parse_html_snapshot(
            report_type="top-3-things",
            html_body="""
                <html><body>
                  <div>08/13/2026 07:05 AM EDT</div>
                  <div class="headline">KM's Top 3 Things (Rates/KOSPI/Volatility)</div>
                  <p><b>Takeaway:</b> <i>Top 3 Things today: Rates, KOSPI, Volatility</i></p>
                  <ol>
                    <li><b>RATES –</b> The yield curve steepened.</li>
                    <li><b>KOSPI –</b> The signal improved.</li>
                    <li><b>VOLATILITY –</b> VIX signaled lower lows.</li>
                  </ol>
                </body></html>
            """,
            received_at=datetime(2026, 8, 13, 11, 5, tzinfo=timezone.utc),
            s3_key="sanitized/top-three-km.html",
            message_id="top-three-km",
            subject="KM's Top 3 Things (Rates/KOSPI/Volatility)",
        )

        self.assertEqual(
            snapshot["data"]["items"],
            [
                {"rank": 1, "title": "RATES", "body": "The yield curve steepened."},
                {"rank": 2, "title": "KOSPI", "body": "The signal improved."},
                {"rank": 3, "title": "VOLATILITY", "body": "VIX signaled lower lows."},
            ],
        )

    def test_top_three_classification_preserves_product_precedence(self):
        self.assertEqual(
            ingestor.infer_report_type(
                "message-body.html",
                "THE MACRO SHOW: August 17th - Access Show, Slide Deck & Top 3 Things",
            ),
            "top-3-things",
        )
        self.assertEqual(
            ingestor.infer_report_type(
                "message-body.html",
                "THE MACRO SHOW: Summary Notes & Replay | Monday, August 17th, 2026",
            ),
            "the-macro-show",
        )
        self.assertEqual(
            ingestor.infer_report_type(
                "message-body.html",
                "KM's Top 3 Things (Rates/KOSPI/Volatility)",
            ),
            "top-3-things",
        )
        self.assertEqual(
            ingestor.infer_report_type(
                "message-body.html",
                "EARLY LOOK: [COMPLIMENTARY] Top 3 Things | USD/Gold/VIX",
            ),
            "early-look",
        )

    def test_top_three_reclassification_requires_explicit_version_backfill(self):
        legacy_item = {
            "status": "INDEXED",
            "attachmentId": "message-body-html-1",
            "mimeType": "text/html",
            "filename": "message-body.html",
            "subject": "THE MACRO SHOW: August 17th - Access Show, Slide Deck & Top 3 Things",
            "reportType": "the-macro-show",
            "snapshotType": "the-macro-show",
            "s3Bucket": "research",
            "s3Key": "messages/top-three.html",
            "materializationAttemptVersion": "gmail-materialized-v7-market-structure-archive",
            "materializationStatus": "INDEXED",
        }

        self.assertFalse(
            ingestor._should_backfill_materialized_snapshot(
                legacy_item,
                allow_version_upgrade=False,
            )
        )
        self.assertTrue(
            ingestor._should_backfill_materialized_snapshot(
                legacy_item,
                allow_version_upgrade=True,
            )
        )

    def test_top_three_parser_preserves_numbered_macro_show_items(self):
        snapshot = ingestor.parse_html_snapshot(
            report_type="top-3-things",
            html_body="""
                <html><head><meta type="hedgeye-headline"
                  content="August 17th - Access Show, Slide Deck &amp; Top 3 Things"></head>
                <body>
                  <div>08/17/2026 08:41 AM EDT</div>
                  <p>Hedgeye's top 3 things</p>
                  <p>SPY was down small on decelerating volume Friday.</p>
                  <p>1) USD – Dollar Index is making fresh two-month lows.</p>
                  <p>2) GOLD – Gold has the cleanest inverse correlation to USD.</p>
                  <p>3) ATHs (all-time highs) – A Top 3 Things repeat; RSP and IWM printed new highs.</p>
                  <p>VIEW LINK</p>
                </body></html>
            """,
            received_at=datetime(2026, 8, 17, 12, 42, tzinfo=timezone.utc),
            s3_key="sanitized/top-three-macro.html",
            message_id="top-three-macro",
            subject="THE MACRO SHOW: August 17th - Access Show, Slide Deck & Top 3 Things",
        )

        self.assertEqual(snapshot["snapshotType"], "top-3-things")
        self.assertEqual(snapshot["itemCount"], 3)
        self.assertEqual(
            snapshot["data"]["items"],
            [
                {"rank": 1, "title": "USD", "body": "Dollar Index is making fresh two-month lows."},
                {"rank": 2, "title": "GOLD", "body": "Gold has the cleanest inverse correlation to USD."},
                {"rank": 3, "title": "ATHs (all-time highs)", "body": "A Top 3 Things repeat; RSP and IWM printed new highs."},
            ],
        )
        self.assertEqual(
            snapshot["data"]["intro"],
            "SPY was down small on decelerating volume Friday.",
        )

    def test_top_three_parser_supports_standalone_ordered_list_and_rejects_partial(self):
        valid = ingestor.parse_html_snapshot(
            report_type="top-3-things",
            html_body="""
                <html><body>
                  <div>08/13/2026 07:05 AM EDT</div>
                  <h1>KM's Top 3 Things (Rates/KOSPI/Volatility)</h1>
                  <p>Top 3 Things today:</p>
                  <ol>
                    <li><b>RATES –</b> The yield curve steepened.</li>
                    <li><b>KOSPI –</b> The signal improved.</li>
                    <li><b>VOLATILITY –</b> VIX signaled lower lows.</li>
                  </ol>
                </body></html>
            """,
            received_at=datetime(2026, 8, 13, 11, 5, tzinfo=timezone.utc),
            s3_key="sanitized/top-three-km.html",
            message_id="top-three-km",
            subject="KM's Top 3 Things (Rates/KOSPI/Volatility)",
        )
        partial = ingestor.parse_html_snapshot(
            report_type="top-3-things",
            html_body="""
                <html><body><p>Top 3 Things today:</p><ol>
                  <li>USD – First item.</li><li>GOLD – Second item.</li>
                </ol></body></html>
            """,
            received_at=datetime(2026, 8, 13, 11, 5, tzinfo=timezone.utc),
            s3_key="sanitized/top-three-partial.html",
            message_id="top-three-partial",
            subject="KM's Top 3 Things",
        )

        self.assertEqual(
            [item["title"] for item in valid["data"]["items"]],
            ["RATES", "KOSPI", "VOLATILITY"],
        )
        self.assertIsNone(partial)

    def test_article_only_call_and_macro_show_emails_materialize_without_inventing_positions(self):
        cases = (
            ("the-call", "the-call-article-only.html"),
            ("the-macro-show", "the-macro-show-article-only.html"),
        )
        for report_type, fixture_name in cases:
            with self.subTest(report_type=report_type):
                snapshot = ingestor.parse_html_snapshot(
                    report_type=report_type,
                    html_body=(GMAIL_FIXTURE_DIR / fixture_name).read_text(),
                    received_at=datetime(2026, 7, 29, 16, 0, tzinfo=timezone.utc),
                    s3_key=f"sanitized/{fixture_name}",
                    message_id=f"sanitized-{report_type}",
                    subject="Sanitized research email",
                )

                self.assertIsNotNone(snapshot)
                self.assertEqual(snapshot["snapshotType"], report_type)
                self.assertEqual(snapshot["positionDataStatus"], "unavailable")
                self.assertEqual(
                    snapshot["data"],
                    {"longs": None, "shorts": None, "neutrals": None},
                )
                self.assertNotIn("positionCount", snapshot)
                self.assertTrue(snapshot["article"]["headline"])
                self.assertTrue(snapshot["article"]["teaser"])

    def test_empty_or_misclassified_show_html_does_not_materialize(self):
        for report_type in ("the-call", "the-macro-show"):
            for html_body in (
                "<html></html>",
                "<html><body><p>Generic delivery footer and unsubscribe link.</p></body></html>",
            ):
                with self.subTest(report_type=report_type, html_body=html_body):
                    snapshot = ingestor.parse_html_snapshot(
                        report_type=report_type,
                        html_body=html_body,
                        received_at=datetime(2026, 7, 29, 16, 0, tzinfo=timezone.utc),
                        s3_key="sanitized/misclassified.html",
                        message_id=f"misclassified-{report_type}",
                        subject="Generic delivery",
                    )

                    self.assertIsNone(snapshot)

    def test_article_only_show_snapshot_never_replaces_structured_same_day_positions(self):
        for snapshot_type in ("the-call", "the-macro-show"):
            with self.subTest(snapshot_type=snapshot_type):
                structured = {
                    "date": "2026-07-29",
                    "snapshotType": snapshot_type,
                    "scrapedAt": "2026-07-29T15:00:00+00:00",
                    "data": {
                        "longs": ["SPY"],
                        "shorts": ["TLT"],
                        "neutrals": [],
                    },
                    "positionCount": 2,
                }
                article_only = {
                    "date": "2026-07-29",
                    "snapshotType": snapshot_type,
                    "scrapedAt": "2026-07-29T16:00:00+00:00",
                    "positionDataStatus": "unavailable",
                    "data": {
                        "longs": None,
                        "shorts": None,
                        "neutrals": None,
                    },
                    "article": {"headline": "Sanitized article update"},
                }
                table = FakeGuardedSnapshotTable()
                key = ("2026-07-29", snapshot_type)
                table.items[key] = deepcopy(structured)

                ingestor.save_snapshot_to_dynamodb(
                    article_only,
                    FakeDynamoDb(table),
                )

                self.assertEqual(table.items[key], structured)
                self.assertEqual(table.put_count, 0)

                empty_table = FakeGuardedSnapshotTable()
                ingestor.save_snapshot_to_dynamodb(
                    article_only,
                    FakeDynamoDb(empty_table),
                )
                self.assertEqual(
                    empty_table.items[key]["positionDataStatus"],
                    "unavailable",
                )

    GO_ANYWHERE_TABLE = """
        <p>Current Open Positions</p>
        <table>
          <tr><th>#</th><th>Ticker</th><th>Name</th><th>Asset Class</th><th>Entry Price</th><th>Total Return ‡</th><th>Date Added</th></tr>
          <tr><td>1</td><td>CLOZ</td><td>CLOs</td><td>fixed income </td><td> $25.89 </td><td> +1.22% </td><td>07/16/26</td></tr>
          <tr><td>2</td><td>PFIX</td><td>Interest Rate Hedge</td><td>us fixed income </td><td> $62.25 </td><td> -5.19% </td><td>10/12/26</td></tr>
          <tr><td>3</td><td>HGER</td><td>Commodity Strategy</td><td>commodities </td><td> $24.10 </td><td> +0.00% </td><td>10/21/26</td></tr>
        </table>
    """

    def test_go_anywhere_subject_is_a_registered_product(self):
        self.assertEqual(ingestor.infer_report_type("message-body.html", "10 ETF Go-Anywhere Portfolio"), "go-anywhere")

    def test_go_anywhere_daily_update_is_a_full_book_checkpoint(self):
        snapshot = ingestor.parse_html_snapshot(
            report_type="go-anywhere",
            html_body=f"<p>10 ETF Go-Anywhere Portfolio</p><p>Takeaway: </p><p>Daily Update</p>{self.GO_ANYWHERE_TABLE}",
            received_at=datetime(2026, 10, 21, 12, 31, tzinfo=timezone.utc),
            s3_key="hedgeye-email/messages/2026-10-21/go-anywhere/daily.html",
            message_id="go-anywhere-daily",
            subject="10 ETF Go-Anywhere Portfolio",
        )

        self.assertEqual(snapshot["sourceKind"], "full-book-checkpoint")
        self.assertEqual(snapshot["data"]["changes"], [])
        self.assertEqual(snapshot["data"]["fullBookLongs"], ["CLOZ", "PFIX", "HGER"])
        self.assertEqual(snapshot["data"]["rows"][1], {
            "id": "PFIX_1", "ticker": "PFIX", "etf": "Interest Rate Hedge", "assetClass": "us fixed income",
            "call": "Long", "side": "Long", "entryPrice": 62.25, "totalReturnPct": -5.19, "dateAdded": "2026-10-12", "action": None,
        })
        self.assertEqual(snapshot["data"]["headline"], "10 ETF Go-Anywhere Portfolio: Daily Update")
        self.assertEqual([kind for kind, _ in ingestor._research_event_payloads(snapshot)], ["FULL_BOOK_CHECKPOINT"])

    def test_go_anywhere_update_types_adds_and_removes_as_long_position_changes(self):
        snapshot = ingestor.parse_html_snapshot(
            report_type="go-anywhere",
            html_body=f"""
                <p>Takeaway: </p><p>Two updates</p>
                <p>WE ARE ADDING</p><p>HGER (Commodity Strategy)</p>
                <p>WE ARE REMOVING</p><p>XLK (Technology Sector)</p>
                {self.GO_ANYWHERE_TABLE}
            """,
            received_at=datetime(2026, 10, 21, 14, 27, tzinfo=timezone.utc),
            s3_key="hedgeye-email/messages/2026-10-21/go-anywhere/update.html",
            message_id="go-anywhere-update",
            subject="10 ETF Go-Anywhere Portfolio",
        )

        self.assertEqual(
            [(item["action"], item["side"], item["ticker"], item["etf"]) for item in snapshot["data"]["changes"]],
            [("ADD", "Long", "HGER", "Commodity Strategy"), ("REMOVE", "Long", "XLK", "Technology Sector")],
        )
        self.assertEqual(snapshot["data"]["removed"], ["XLK"])
        self.assertEqual(
            [kind for kind, _ in ingestor._research_event_payloads(snapshot)],
            ["POSITION_ACTION", "POSITION_ACTION", "FULL_BOOK_CHECKPOINT"],
        )
        typed = [
            (event["entityId"], event["eventType"], event["action"], event["positionSide"])
            for event in research_intelligence.build_entity_events(snapshot)
            if event.get("action")
        ]
        self.assertEqual(typed, [("HGER", "position_change", "ADD", "LONG"), ("XLK", "position_change", "REMOVE", "LONG")])

    def test_etf_full_lineup_email_becomes_a_full_book_checkpoint(self):
        snapshot = ingestor.parse_html_snapshot(
            report_type="etf-pro",
            html_body="""
                <p>Welcome back! The current lineup of ETFs is as follows:</p>
                <p>Long: BUXX, AAAU, CLOX</p>
                <p>Short: TLT, ZROZ</p>
                <p>( VIEW LARGER IMAGE )</p>
            """,
            received_at=datetime(2026, 7, 21, 14, 26, 5, tzinfo=timezone.utc),
            s3_key="hedgeye-email/messages/2026-07-21/etf-pro/full.html",
            message_id="etf-full-lineup",
            subject="ETF Pro Plus: July Update",
        )

        self.assertIsNotNone(snapshot)
        self.assertEqual(snapshot["sourceKind"], "full-book-checkpoint")
        self.assertEqual(snapshot["scrapedAt"], "2026-07-21T14:26:05+00:00")
        self.assertEqual(snapshot["longCount"], 3)
        self.assertEqual(snapshot["shortCount"], 2)
        self.assertTrue(snapshot["data"]["checkpointAvailable"])
        self.assertEqual(snapshot["data"]["fullBookLongs"], ["BUXX", "AAAU", "CLOX"])
        self.assertEqual(snapshot["data"]["fullBookShorts"], ["TLT", "ZROZ"])
        self.assertEqual(
            {(row["ticker"], row["call"], row["side"]) for row in snapshot["data"]["rows"]},
            {
                ("BUXX", "Long", "Long"),
                ("AAAU", "Long", "Long"),
                ("CLOX", "Long", "Long"),
                ("TLT", "Short", "Short"),
                ("ZROZ", "Short", "Short"),
            },
        )

    def test_etf_weekly_table_email_becomes_a_rich_full_book_checkpoint(self):
        snapshot = ingestor.parse_html_snapshot(
            report_type="etf-pro",
            html_body="""
                <p>BULLISH</p>
                <p>TICKER</p><p>DATE ADDED</p><p>RECENT PRICE*</p><p>TREND RANGES</p><p>ASSET CLASS</p>
                <p>Income Short Maturity</p><p>BUXX</p><p>10/25/2023</p><p>$20.25</p><p>$20.21</p><p>$20.29</p><p>Domestic Fixed Income</p>
                <p>BEARISH</p>
                <p>TICKER</p><p>DATE ADDED</p><p>RECENT PRICE*</p><p>TREND RANGES</p><p>ASSET CLASS</p>
                <p>Palladium</p><p>PALL</p><p>5/1/2026</p><p>$23.23</p><p>$21.26</p><p>$24.98</p><p>Commodities</p>
                <p>*All ETF recent intra day prices data through 7/21/2026</p>
            """,
            received_at=datetime(2026, 7, 21, 17, 58, 2, tzinfo=timezone.utc),
            s3_key="hedgeye-email/messages/2026-07-21/etf-pro/weekly.html",
            message_id="etf-weekly",
            subject="ETF Pro Plus - New Weekly Report",
        )

        self.assertIsNotNone(snapshot)
        self.assertEqual(snapshot["data"]["checkpointFormat"], "weekly-table")
        self.assertEqual(snapshot["data"]["fullBookLongs"], ["BUXX"])
        self.assertEqual(snapshot["data"]["fullBookShorts"], ["PALL"])
        self.assertEqual(
            snapshot["data"]["rows"],
            [
                {
                    "id": "BUXX_0",
                    "ticker": "BUXX",
                    "etf": "Income Short Maturity",
                    "assetClass": "Domestic Fixed Income",
                    "call": "Long",
                    "side": "Long",
                    "dateAdded": "2023-10-25",
                    "lastPrice": 20.25,
                    "recentPrice": 20.25,
                    "trendLowEnd": 20.21,
                    "trendHighEnd": 20.29,
                    "action": None,
                },
                {
                    "id": "PALL_1",
                    "ticker": "PALL",
                    "etf": "Palladium",
                    "assetClass": "Commodities",
                    "call": "Short",
                    "side": "Short",
                    "dateAdded": "2026-05-01",
                    "lastPrice": 23.23,
                    "recentPrice": 23.23,
                    "trendLowEnd": 21.26,
                    "trendHighEnd": 24.98,
                    "action": None,
                },
            ],
        )

    def test_research_event_ledger_is_immutable_and_idempotent(self):
        database = FakeEventDynamoDb()
        snapshot = rta_snapshot("gmail-rta", "2026-07-15T16:00:00+00:00", "BUY")

        first = ingestor.persist_research_event_ledger(snapshot, database, content_sha256="a" * 64)
        first_event = next(iter(database.table.items.values()))
        del first_event["sourceEventCount"]
        second = ingestor.persist_research_event_ledger(snapshot, database, content_sha256="a" * 64)

        self.assertEqual(first, 1)
        self.assertEqual(second, 0)
        event = next(iter(database.table.items.values()))
        self.assertEqual(event["productKey"], "real-time-alert")
        self.assertEqual(event["parserVersion"], ingestor.RESEARCH_PARSER_VERSION)
        self.assertEqual(
            event["verificationHashVersion"],
            ingestor.RESEARCH_EVENT_VERIFICATION_HASH_VERSION,
        )
        self.assertRegex(event["verificationHash"], r"^[a-f0-9]{64}$")
        self.assertEqual(event["sourceEventCount"], 1)
        self.assertTrue(event["immutable"])

        corrected = rta_snapshot("gmail-rta", "2026-07-15T16:00:00+00:00", "SELL")
        with self.assertRaisesRegex(RuntimeError, "RESEARCH_EVENT_CONFLICT"):
            ingestor.persist_research_event_ledger(corrected, database, content_sha256="b" * 64)

    def test_corrected_reparse_appends_a_revision_that_supersedes_the_original(self):
        database = FakeEventDynamoDb()
        original = rta_snapshot("gmail-rta", "2026-07-15T16:00:00+00:00", "BUY")
        corrected = rta_snapshot("gmail-rta", "2026-07-15T16:00:00+00:00", "SELL")
        ingestor.persist_research_event_ledger(original, database)
        [original_event] = database.table.items.values()

        written = ingestor.persist_research_event_ledger(corrected, database, allow_revision=True)
        again = ingestor.persist_research_event_ledger(corrected, database, allow_revision=True)

        self.assertEqual((written, again), (1, 0))
        events = list(database.table.items.values())
        self.assertEqual(len(events), 2)
        self.assertIn(original_event, events)  # the original is never rewritten
        [revision] = [event for event in events if event.get("parseRevision")]
        self.assertTrue(revision["eventKey"].endswith(f"#revision-{revision['parseRevision']}"))
        self.assertEqual(ingestor.current_research_events(events), [revision])
        self.assertEqual(
            ingestor.verify_research_event_ledger(database)["products"]["real-time-alert"],
            {"eventCount": 1, "unverifiedEventCount": 0},
        )

    def test_unchanged_reparse_with_revision_allowed_writes_nothing_new(self):
        database = FakeEventDynamoDb()
        snapshot = rta_snapshot("gmail-rta", "2026-07-15T16:00:00+00:00", "BUY")
        ingestor.persist_research_event_ledger(snapshot, database)

        self.assertEqual(ingestor.persist_research_event_ledger(snapshot, database, allow_revision=True), 0)
        self.assertEqual(len(database.table.items), 1)
        self.assertFalse(any(event.get("parseRevision") for event in database.table.items.values()))

    def test_newest_revision_wins_and_other_emails_are_untouched(self):
        events = [
            {"productKey": "investing-ideas", "sourceMessageId": "a", "eventKey": "t#a#0000"},
            {"productKey": "investing-ideas", "sourceMessageId": "a", "eventKey": "t#a#0000#revision-r1",
             "parseRevision": "r1", "revisedAt": "2026-10-29T01:00:00+00:00"},
            {"productKey": "investing-ideas", "sourceMessageId": "a", "eventKey": "t#a#0000#revision-r2",
             "parseRevision": "r2", "revisedAt": "2026-10-29T02:00:00+00:00"},
            {"productKey": "investing-ideas", "sourceMessageId": "b", "eventKey": "t#b#0000"},
        ]
        self.assertEqual(
            [event["eventKey"] for event in ingestor.current_research_events(events)],
            ["t#a#0000#revision-r2", "t#b#0000"],
        )

    def test_investing_ideas_materializes_one_typed_event_per_position(self):
        database = FakeEventDynamoDb()
        snapshot = ingestor.parse_html_snapshot(
            report_type="investing-ideas",
            html_body="""
                <table>
                  <tr><th>Ticker</th><th>Position</th><th>Previous Close</th><th>LRR</th><th>HRR</th></tr>
                  <tr><td>DDOG</td><td>Long</td><td>267.97</td><td>244</td><td>275</td></tr>
                  <tr><td>HCA</td><td>Short</td><td>402.59</td><td>363</td><td>418</td></tr>
                </table>
            """,
            received_at=datetime(2026, 8, 10, 12, 45, tzinfo=timezone.utc),
            s3_key="investing-ideas/2026-08-10.html",
            message_id="investing-ideas-2026-08-10",
            subject="Investing Ideas Newsletter",
        )

        written = ingestor.persist_research_event_ledger(
            snapshot,
            database,
            content_sha256="d" * 64,
        )

        self.assertEqual(written, 2)
        events = sorted(database.table.items.values(), key=lambda item: item["payload"]["ticker"])
        self.assertEqual([event["eventType"] for event in events], [
            "INVESTING_IDEA_POSITION",
            "INVESTING_IDEA_POSITION",
        ])
        self.assertEqual([event["payload"]["ticker"] for event in events], ["DDOG", "HCA"])
        self.assertTrue(all(event["sourceKind"] == "investing-idea-position" for event in events))
        self.assertEqual(events[0]["payload"]["side"], "Long")
        self.assertEqual(events[0]["payload"]["bias"], "BULLISH")
        self.assertEqual(events[0]["payload"]["prevClose"], Decimal("267.97"))
        self.assertEqual(events[0]["payload"]["lrr"], Decimal("244"))
        self.assertEqual(events[0]["payload"]["hrr"], Decimal("275"))
        self.assertFalse(events[0]["decisionEligible"])

        verification = ingestor.verify_research_event_ledger(database)
        self.assertEqual(
            verification["products"]["investing-ideas"],
            {"eventCount": 2, "unverifiedEventCount": 0},
        )

    def test_force_backfill_verification_requires_both_products_and_matching_hashes(self):
        database = FakeEventDynamoDb()
        ingestor.persist_research_event_ledger(
            rta_snapshot("gmail-rta", "2026-07-15T16:00:00+00:00", "BUY"),
            database,
        )
        ingestor.persist_research_event_ledger(
            etf_full_book_snapshot(
                "gmail-etf-checkpoint",
                "2026-07-15T16:42:31+00:00",
            ),
            database,
        )

        self.assertEqual(
            ingestor.verify_research_event_ledger(database),
            {
                "verified": True,
                "eventCount": 2,
                "unverifiedEventCount": 0,
                "products": {
                    "real-time-alert": {
                        "eventCount": 1,
                        "unverifiedEventCount": 0,
                    },
                    "etf-pro": {
                        "eventCount": 1,
                        "unverifiedEventCount": 0,
                    },
                },
            },
        )

        for event in database.table.items.values():
            event["sequence"] = Decimal(event["sequence"])
            event["sourceEventCount"] = Decimal(event["sourceEventCount"])
        decimal_result = ingestor.verify_research_event_ledger(database)
        self.assertTrue(decimal_result["verified"])
        self.assertEqual(decimal_result["unverifiedEventCount"], 0)

        next(iter(database.table.items.values()))["verificationHash"] = "0" * 64
        result = ingestor.verify_research_event_ledger(database)
        self.assertFalse(result["verified"])
        self.assertEqual(result["unverifiedEventCount"], 1)

    def test_force_backfill_verification_rejects_incomplete_source_sequence(self):
        database = FakeEventDynamoDb()
        ingestor.persist_research_event_ledger(
            rta_snapshot("gmail-rta", "2026-07-15T16:00:00+00:00", "BUY"),
            database,
        )
        snapshot = ingestor.parse_html_snapshot(
            report_type="etf-pro",
            html_body="""
                <p>We are ADDING Long : US Deflation (BNDD) Health Care (PINK)</p>
                <p>How to Use ETF Pro Plus Updates:</p>
            """,
            received_at=datetime(2026, 7, 21, 15, 4, 3, tzinfo=timezone.utc),
            s3_key="hedgeye-email/messages/2026-07-21/etf-pro/actions.html",
            message_id="gmail-etf-actions",
            subject="UPDATE: 2 New ETF Pro Changes",
        )
        ingestor.persist_research_event_ledger(snapshot, database)
        incomplete_key = next(
            key for key, item in database.table.items.items()
            if item["productKey"] == "etf-pro" and item["sequence"] == 1
        )
        del database.table.items[incomplete_key]

        result = ingestor.verify_research_event_ledger(database)

        self.assertFalse(result["verified"])
        self.assertEqual(
            result["products"]["etf-pro"],
            {"eventCount": 1, "unverifiedEventCount": 1},
        )

    def test_etf_full_book_event_contains_replay_complete_provenance(self):
        database = FakeEventDynamoDb()
        snapshot = etf_full_book_snapshot(
            "gmail-etf-checkpoint",
            "2026-07-15T16:42:31+00:00",
        )

        written = ingestor.persist_research_event_ledger(
            snapshot,
            database,
            content_sha256="c" * 64,
        )

        self.assertEqual(written, 1)
        event = next(iter(database.table.items.values()))
        self.assertEqual(event["eventType"], "FULL_BOOK_CHECKPOINT")
        self.assertEqual(event["eventTime"], "2026-07-15T16:42:31+00:00")
        self.assertEqual(event["sourceMessageId"], "gmail-etf-checkpoint")
        self.assertEqual(event["sequence"], 0)
        self.assertEqual(
            event["eventKey"],
            "2026-07-15T16:42:31+00:00#gmail-etf-checkpoint#0000",
        )
        self.assertEqual(event["snapshotDate"], "2026-07-15")
        self.assertEqual(event["sourceKind"], "full-book-checkpoint")
        self.assertEqual(event["sourceArtifact"], "message-gmail-etf-checkpoint.html")
        self.assertEqual(event["contentHash"], "c" * 64)
        self.assertEqual(event["payload"]["headline"], "ETF Pro Plus - New Weekly Report")
        self.assertEqual(event["payload"]["longCount"], 1)
        self.assertEqual(event["payload"]["shortCount"], 1)
        self.assertEqual(
            [(row["ticker"], row["call"], row["side"]) for row in event["payload"]["rows"]],
            [("SPY", "Long", "Long"), ("TLT", "Short", "Short")],
        )

    def test_etf_action_events_have_deterministic_message_and_sequence_order(self):
        database = FakeEventDynamoDb()
        snapshot = ingestor.parse_html_snapshot(
            report_type="etf-pro",
            html_body="""
                <p>We are ADDING Long : US Deflation (BNDD) Health Care (PINK)</p>
                <p>How to Use ETF Pro Plus Updates:</p>
            """,
            received_at=datetime(2026, 7, 21, 15, 4, 3, tzinfo=timezone.utc),
            s3_key="hedgeye-email/messages/2026-07-21/etf-pro/actions.html",
            message_id="gmail-etf-actions",
            subject="UPDATE: 2 New ETF Pro Changes",
        )

        written = ingestor.persist_research_event_ledger(snapshot, database)

        self.assertEqual(written, 2)
        events = sorted(database.table.items.values(), key=lambda item: item["sequence"])
        self.assertEqual([event["sequence"] for event in events], [0, 1])
        self.assertEqual([event["sourceEventCount"] for event in events], [2, 2])
        self.assertEqual(
            [event["eventKey"] for event in events],
            [
                "2026-07-21T15:04:03+00:00#gmail-etf-actions#0000",
                "2026-07-21T15:04:03+00:00#gmail-etf-actions#0001",
            ],
        )
        self.assertEqual([event["payload"]["ticker"] for event in events], ["BNDD", "PINK"])
        self.assertTrue(all(event["sourceMessageId"] == "gmail-etf-actions" for event in events))
        self.assertTrue(all(event["sourceKind"] == "position-actions" for event in events))

    def test_primary_risk_ranges_publish_in_verified_stages(self):
        database = FakeRiskRangeDynamoDb()
        snapshot = {
            "date": "2026-07-21",
            "snapshotType": "risk-ranges",
            "scrapedAt": "2026-07-21T12:00:00+00:00",
            "publishedAt": "2026-07-21",
            "gmailMessageId": "risk-primary",
            "htmlSource": "gmail/risk-primary.html",
            "data": {"SPY": {"lrr": 620.5, "hrr": 631.2, "trend": "BULLISH"}},
        }

        ingestor.save_snapshot_to_dynamodb(snapshot, database)

        transaction = database.meta.client.transactions[0]
        self.assertEqual(len(transaction), 3)
        self.assertEqual(
            [entry["Put"]["TableName"] for entry in transaction],
            [
                "HedgeyeDailySnapshot",
                "HedgeyeRiskRanges",
                "RiskRangeData",
            ],
        )
        self.assertEqual(len(database.meta.client.transactions), 1)
        self.assertEqual(len(database.meta.client.client_request_tokens[0]), 32)
        self.assertEqual(database.tables["HedgeyeDailySnapshot"].writes, [])
        self.assertEqual(database.tables["HedgeyeRiskRanges"].writes, [])
        expected_order = email_parser._publication_order(snapshot["scrapedAt"])
        for entry in transaction:
            put = entry["Put"]
            self.assertIn("ConditionExpression", put)
            self.assertEqual(
                put["ExpressionAttributeNames"]["#publicationOrder"],
                "publicationOrder",
            )
            self.assertEqual(
                put["ExpressionAttributeValues"][":incomingPublicationOrder"],
                expected_order,
            )
            self.assertEqual(
                put["Item"]["publicationOrder"],
                expected_order,
            )
        manifest_table = database.tables["RiskRangePublicationManifestsV2"]
        self.assertEqual(
            manifest_table.reads[:1],
            [{
                "Key": {
                    "publicationDate": "2026-07-21",
                    "manifestType": "primary",
                },
                "ConsistentRead": True,
            }],
        )
        self.assertEqual(
            [write["completionState"] for write in manifest_table.writes],
            ["preparing", "complete"],
        )
        preparing_put = manifest_table.put_calls[0]
        self.assertIn(
            "attribute_not_exists(#publicationDate)",
            preparing_put["ConditionExpression"],
        )
        completed = manifest_table.existing
        self.assertEqual(completed["expectedProjectionCount"], 3)
        self.assertEqual(completed["verifiedProjectionCount"], 3)

    def test_exact_primary_risk_manifest_replay_skips_the_write_transaction(self):
        snapshot = {
            "date": "2026-07-21",
            "snapshotType": "risk-ranges",
            "scrapedAt": "2026-07-21T12:00:00+00:00",
            "publishedAt": "2026-07-21",
            "gmailMessageId": "risk-primary",
            "htmlSource": "gmail/risk-primary.html",
            "data": {
                "SPY": {
                    "lrr": 620.5,
                    "hrr": 631.2,
                    "trend": "BULLISH",
                }
            },
        }
        initial = FakeRiskRangeDynamoDb()
        ingestor.save_snapshot_to_dynamodb(snapshot, initial)
        committed_manifest = initial.tables[
            "RiskRangePublicationManifestsV2"
        ].existing
        replay = FakeRiskRangeDynamoDb(existing_manifest=committed_manifest)

        ingestor.save_snapshot_to_dynamodb(snapshot, replay)

        self.assertEqual(replay.meta.client.transactions, [])
        self.assertEqual(
            len(replay.tables["RiskRangePublicationManifestsV2"].reads),
            1,
        )
        self.assertTrue(all(not table.writes for table in replay.tables.values()))

    def test_older_risk_range_retry_cannot_replace_newer_same_day_manifest(self):
        newer_order = email_parser._publication_order(
            "2026-07-21T13:00:00+00:00"
        )
        database = FakeRiskRangeDynamoDb(
            existing_manifest={
                "publicationDate": "2026-07-21",
                "manifestType": "primary",
                "completionState": "complete",
                "checksum": "newer-checksum",
                "sourceMessageId": "risk-newer",
                "completedAt": "2026-07-21T13:00:00+00:00",
                "publicationOrder": newer_order,
            }
        )
        snapshot = {
            "date": "2026-07-21",
            "snapshotType": "risk-ranges",
            "scrapedAt": "2026-07-21T12:00:00+00:00",
            "gmailMessageId": "risk-older",
            "data": {
                "SPY": {
                    "lrr": 620.5,
                    "hrr": 631.2,
                    "trend": "BULLISH",
                }
            },
        }

        with self.assertRaises(
            email_parser.RiskRangeStalePublicationError
        ) as raised:
            ingestor.save_snapshot_to_dynamodb(snapshot, database)

        self.assertEqual(
            raised.exception.error_code,
            "RISK_RANGE_STALE_PUBLICATION_REJECTED",
        )
        self.assertEqual(database.meta.client.transactions, [])
        self.assertTrue(
            all(not table.writes for table in database.tables.values())
        )
        wrapped = ingestor._retryable_materialization_error(
            raised.exception
        )
        self.assertEqual(
            wrapped.error_code,
            "RISK_RANGE_STALE_PUBLICATION_REJECTED",
        )

    def test_risk_range_manifest_update_uses_atomic_identity_cas(self):
        older_order = email_parser._publication_order(
            "2026-07-21T11:00:00+00:00"
        )
        existing_manifest = {
            "publicationDate": "2026-07-21",
            "manifestType": "primary",
            "completionState": "complete",
            "checksum": "older-checksum",
            "sourceMessageId": "risk-older",
            "completedAt": "2026-07-21T11:00:00+00:00",
            "publicationOrder": older_order,
        }
        database = FakeRiskRangeDynamoDb(
            existing_manifest=existing_manifest
        )
        snapshot = {
            "date": "2026-07-21",
            "snapshotType": "risk-ranges",
            "scrapedAt": "2026-07-21T12:00:00+00:00",
            "gmailMessageId": "risk-newer",
            "data": {
                "SPY": {
                    "lrr": 620.5,
                    "hrr": 631.2,
                    "trend": "BULLISH",
                }
            },
        }

        ingestor.save_snapshot_to_dynamodb(snapshot, database)

        manifest_put = database.tables[
            "RiskRangePublicationManifestsV2"
        ].put_calls[0]
        names = manifest_put["ExpressionAttributeNames"]
        values = manifest_put["ExpressionAttributeValues"]
        self.assertIn("#expectedField0 = :expectedValue0", manifest_put[
            "ConditionExpression"
        ])
        self.assertEqual(names["#expectedField0"], "sourceMessageId")
        self.assertEqual(values[":expectedValue0"], "risk-older")
        self.assertEqual(names["#expectedField4"], "publicationOrder")
        self.assertEqual(
            values[":expectedValue4"],
            older_order,
        )
        self.assertEqual(len(database.meta.client.transactions[0]), 3)

    def test_risk_range_manifest_race_fails_as_typed_stale_publication(self):
        service_error = ClientError(
            {
                "Error": {
                    "Code": "TransactionCanceledException",
                    "Message": "private service diagnostic",
                },
                "CancellationReasons": [
                    {"Code": "None"},
                    {
                        "Code": "ConditionalCheckFailed",
                        "Message": "private concurrent manifest diagnostic",
                    },
                ],
            },
            "TransactWriteItems",
        )
        database = FakeRiskRangeDynamoDb(transaction_error=service_error)
        snapshot = {
            "date": "2026-07-21",
            "snapshotType": "risk-ranges",
            "scrapedAt": "2026-07-21T12:00:00+00:00",
            "gmailMessageId": "risk-primary",
            "data": {
                "SPY": {
                    "lrr": 620.5,
                    "hrr": 631.2,
                    "trend": "BULLISH",
                }
            },
        }

        with self.assertRaises(
            email_parser.RiskRangeStalePublicationError
        ) as raised:
            ingestor.save_snapshot_to_dynamodb(snapshot, database)

        self.assertEqual(
            raised.exception.error_code,
            "RISK_RANGE_STALE_PUBLICATION_REJECTED",
        )
        self.assertNotIn("private", str(raised.exception))

    def test_primary_risk_ranges_collapse_exact_normalized_ticker_duplicates(self):
        database = FakeRiskRangeDynamoDb()
        row = {"lrr": 620.5, "hrr": 631.2, "trend": "bullish"}
        snapshot = {
            "date": "2026-07-21",
            "snapshotType": "risk-ranges",
            "scrapedAt": "2026-07-21T12:00:00+00:00",
            "data": {
                "spx": {**row, "originalName": "First label"},
                "SPX": {**row, "originalName": "Second label"},
            },
        }

        ingestor.save_snapshot_to_dynamodb(snapshot, database)

        transaction = database.meta.client.transactions[0]
        table_names = [entry["Put"]["TableName"] for entry in transaction]
        self.assertEqual(table_names.count("HedgeyeRiskRanges"), 1)
        self.assertEqual(table_names.count("RiskRangeData"), 1)
        daily_snapshot = next(
            entry["Put"]["Item"]
            for entry in transaction
            if entry["Put"]["TableName"] == "HedgeyeDailySnapshot"
        )
        self.assertEqual(set(daily_snapshot["data"]), {"SPX"})
        self.assertEqual(daily_snapshot["riskRangeCount"], 1)

    def test_conflicting_duplicate_rows_preserve_source_and_independent_signal(self):
        database = FakeRiskRangeDynamoDb()
        snapshot = {
            "date": "2026-07-21", "snapshotType": "risk-ranges",
            "scrapedAt": "2026-07-21T12:00:00+00:00",
            "data": {
                "spx": {"lrr": 620.5, "hrr": 631.2, "trend": "BULLISH"},
                "SPX": {"lrr": 621.5, "hrr": 631.2, "trend": "BULLISH"},
            },
        }
        ingestor.save_snapshot_to_dynamodb(snapshot, database)
        stored = database.tables["HedgeyeDailySnapshot"].get_item(Key={"date": "2026-07-21", "snapshotType": "risk-ranges"})["Item"]
        self.assertEqual(stored["data"]["SPX"]["trend"], "BULLISH")
        self.assertNotIn("lrr", stored["data"]["SPX"])
        issue = stored["sourceQuality"]["issues"][0]
        self.assertEqual(issue["code"], "conflicting_duplicate")
        self.assertEqual(len(issue["observed"]["_conflictingRows"]), 2)
        self.assertEqual(database.tables["RiskRangePublicationManifestsV2"].existing["count"], 0)

    def test_primary_risk_range_publication_chunks_above_one_transaction(self):
        database = FakeRiskRangeDynamoDb()
        snapshot = {
            "date": "2026-07-21",
            "snapshotType": "risk-ranges",
            "scrapedAt": "2026-07-21T12:00:00+00:00",
            "data": {
                f"T{index:03d}": {
                    "lrr": 100 + index,
                    "hrr": 101 + index,
                    "trend": "BULLISH",
                }
                for index in range(49)
            },
        }

        ingestor.save_snapshot_to_dynamodb(snapshot, database)

        self.assertEqual(
            [len(chunk) for chunk in database.meta.client.transactions],
            [20, 20, 20, 20, 19],
        )
        self.assertEqual(
            len(set(database.meta.client.client_request_tokens)),
            5,
        )
        manifest = database.tables["RiskRangePublicationManifestsV2"].existing
        self.assertEqual(manifest["completionState"], "complete")
        self.assertEqual(manifest["expectedProjectionCount"], 99)
        self.assertEqual(manifest["verifiedProjectionCount"], 99)

    def test_risk_range_transaction_failure_retains_only_typed_cancellation_codes(self):
        service_error = ClientError(
            {
                "Error": {
                    "Code": "TransactionCanceledException",
                    "Message": "private service diagnostic",
                },
                "CancellationReasons": [
                    {"Code": "None"},
                    {"Code": "ValidationError", "Message": "private row diagnostic"},
                ],
            },
            "TransactWriteItems",
        )
        database = FakeRiskRangeDynamoDb(transaction_error=service_error)
        snapshot = {
            "date": "2026-07-21",
            "snapshotType": "risk-ranges",
            "scrapedAt": "2026-07-21T12:00:00+00:00",
            "data": {
                "SPX": {"lrr": 620.5, "hrr": 631.2, "trend": "BULLISH"},
            },
        }

        with self.assertRaises(email_parser.RiskRangeTransactionWriteError) as raised:
            ingestor.save_snapshot_to_dynamodb(snapshot, database)

        self.assertEqual(
            raised.exception.error_code,
            "RISK_RANGE_TRANSACTION_WRITE_FAILED",
        )
        self.assertIn("TransactionCanceledException", str(raised.exception))
        self.assertIn("None,ValidationError", str(raised.exception))
        self.assertNotIn("private", str(raised.exception))
        manifest_writes = database.tables[
            "RiskRangePublicationManifestsV2"
        ].writes
        self.assertEqual(
            [write["completionState"] for write in manifest_writes],
            ["preparing", "failed"],
        )
        self.assertEqual(
            manifest_writes[-1]["errorCode"],
            "RISK_RANGE_TRANSACTION_WRITE_FAILED",
        )
        self.assertTrue(
            all(
                not table.writes
                for name, table in database.tables.items()
                if name != "RiskRangePublicationManifestsV2"
            )
        )

    def test_risk_range_manifest_never_completes_when_readback_verification_fails(self):
        database = FakeRiskRangeDynamoDb()
        snapshot = {
            "date": "2026-07-21",
            "snapshotType": "risk-ranges",
            "scrapedAt": "2026-07-21T12:00:00+00:00",
            "gmailMessageId": "risk-primary",
            "data": {
                "SPX": {
                    "lrr": 620.5,
                    "hrr": 631.2,
                    "trend": "BULLISH",
                },
            },
        }

        with patch.object(
            email_parser,
            "_verify_risk_range_projections",
            side_effect=email_parser.RiskRangePublicationVerificationError(
                "projection mismatch"
            ),
        ):
            with self.assertRaises(
                email_parser.RiskRangePublicationVerificationError
            ):
                ingestor.save_snapshot_to_dynamodb(snapshot, database)

        manifest_writes = database.tables[
            "RiskRangePublicationManifestsV2"
        ].writes
        self.assertEqual(
            [write["completionState"] for write in manifest_writes],
            ["preparing", "failed"],
        )
        self.assertEqual(
            manifest_writes[-1]["errorCode"],
            "RISK_RANGE_PUBLICATION_VERIFICATION_FAILED",
        )

    def test_early_look_never_mutates_primary_risk_range_book(self):
        database = FakeRiskRangeDynamoDb()
        snapshot = {
            "date": "2026-07-21",
            "snapshotType": "early-look",
            "scrapedAt": "2026-07-21T10:00:00+00:00",
            "publishedAt": "2026-07-21",
            "gmailMessageId": "early-look",
            "data": {"SPY": {"lrr": 619.0, "hrr": 632.0, "trend": "BULLISH"}},
        }

        ingestor.save_snapshot_to_dynamodb(snapshot, database)

        self.assertEqual(database.tables["HedgeyeRiskRanges"].writes, [])
        self.assertEqual(len(database.tables["RiskRangeData"].writes), 1)
        self.assertEqual(database.meta.client.transactions, [])

    def test_early_look_publisher_inverted_range_keeps_article_and_valid_evidence(self):
        snapshot = ingestor.parse_html_snapshot(
            report_type="early-look",
            html_body=(
                '<meta type="hedgeye-headline" content="Morning research" />'
                '<p>Key Takeaways</p><p>Growth signals diverge.</p>'
                '<p>Our Levels</p>'
                '<p>S&amp;P 500 (SPX) 7532-7797 (bullish)</p>'
                '<p>Russell 2000 (RUT) 2834-2825 (bearish)</p>'
            ),
            received_at=datetime(2026, 9, 22, 11, 27, 4, tzinfo=timezone.utc),
            s3_key="hedgeye-email/messages/early-look.html",
            message_id="early-look-inverted-range",
        )

        self.assertEqual(snapshot["date"], "2026-09-22")
        self.assertIn("Growth signals diverge.", snapshot["article"]["bodyText"])
        self.assertIn("2834-2825", snapshot["article"]["bodyText"])
        self.assertEqual(snapshot["riskRangeCount"], 1)
        self.assertEqual(snapshot["rangeValidation"]["excludedRows"], [
            {"ticker": "RUSSELL 2000 (RUT)", "reason": "invalid_bounds"},
        ])
        self.assertIn("EARLY_LOOK_INVALID_RISK_RANGE_ROWS", snapshot["warnings"])
        affected = snapshot["data"]["RUSSELL 2000 (RUT)"]
        self.assertEqual(affected["trend"], "BEARISH")
        self.assertNotIn("lrr", affected)
        self.assertNotIn("hrr", affected)
        issue = snapshot["sourceQuality"]["issues"][0]
        self.assertEqual(issue["observed"]["lrr"], 2834)
        self.assertEqual(issue["observed"]["hrr"], 2825)
        self.assertEqual(issue["source"]["messageId"], "early-look-inverted-range")

        events = ingestor._research_event_payloads(snapshot)
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0][1], snapshot["data"])
        references = research_intelligence.extract_entity_references(snapshot)
        rut_references = [reference for reference in references
                          if reference.get("fieldPath", "").startswith("data.") and reference.get("entityId") == "IWM"]
        self.assertTrue(any(reference.get("value") == "BEARISH" for reference in rut_references))
        self.assertFalse(any('2834' in reference.get("excerpt", "") or '2825' in reference.get("excerpt", "")
                             for reference in rut_references))

        database = FakeRiskRangeDynamoDb()
        ingestor.save_snapshot_to_dynamodb(snapshot, database)
        self.assertEqual(len(database.tables["HedgeyeDailySnapshot"].writes), 1)
        self.assertEqual(len(database.tables["RiskRangeData"].writes), 1)
        self.assertEqual(database.tables["HedgeyeRiskRanges"].writes, [])
        self.assertEqual(database.meta.client.transactions, [])

    def test_early_look_all_invalid_ranges_retains_only_source_article(self):
        snapshot = {
            "date": "2026-09-22",
            "snapshotType": "early-look",
            "scrapedAt": "2026-09-22T11:27:04+00:00",
            "article": {"headline": "Morning research", "bodyText": "RUT 2834-2825 (bearish)"},
            "data": {
                "RUT": {"lrr": 2834, "hrr": 2825, "trend": "BEARISH"},
                "EQUAL": {"lrr": 10, "hrr": 10, "trend": "BULLISH"},
                "NAN": {"lrr": "NaN", "hrr": 10, "trend": "BULLISH"},
                "MISSING": {"hrr": 10, "trend": "BULLISH"},
            },
        }
        database = FakeRiskRangeDynamoDb()

        ingestor.save_snapshot_to_dynamodb(snapshot, database)

        saved = database.tables["HedgeyeDailySnapshot"].writes[0]
        self.assertEqual(saved["article"], snapshot["article"])
        self.assertEqual(saved["data"]["RUT"]["trend"], "BEARISH")
        self.assertFalse(any("lrr" in row or "hrr" in row for row in saved["data"].values()))
        self.assertEqual(saved["riskRangeCount"], 0)
        self.assertEqual(saved["rangeValidation"]["status"], "unavailable")
        self.assertEqual(len(saved["rangeValidation"]["excludedRows"]), 4)
        self.assertEqual(database.tables["RiskRangeData"].writes, [])
        self.assertEqual(database.tables["HedgeyeRiskRanges"].writes, [])
        self.assertEqual(len(snapshot["data"]), 4)

    def test_malformed_risk_range_is_preserved_as_discrepancy_without_coercion(self):
        database = FakeRiskRangeDynamoDb()
        snapshot = {
            "date": "2026-07-21",
            "snapshotType": "risk-ranges",
            "scrapedAt": "2026-07-21T12:00:00+00:00",
            "data": {"SPY": {"lrr": 0, "hrr": 0, "trend": "BULLISH"}},
        }

        ingestor.save_snapshot_to_dynamodb(snapshot, database)
        manifest = database.tables["RiskRangePublicationManifestsV2"].existing
        self.assertEqual(manifest["completionState"], "complete")
        self.assertEqual(manifest["count"], 0)
        self.assertEqual(manifest["sourceQuality"]["issues"][0]["observed"]["lrr"], 0)
        self.assertEqual(database.tables["HedgeyeRiskRanges"].items, {})

    def test_rta_materialization_merges_chronologically_and_is_idempotent(self):
        table = FakeSnapshotTable()
        db = FakeDynamoDb(table)
        later = rta_snapshot("message-later", "2026-07-15T17:00:00+00:00", "SELL")
        earlier = rta_snapshot("message-earlier", "2026-07-15T16:00:00+00:00", "BUY")

        ingestor.materialize_email_snapshot(later, db)
        merged, changed = ingestor.materialize_email_snapshot(earlier, db)
        repeated, repeated_changed = ingestor.materialize_email_snapshot(earlier, db)

        self.assertTrue(changed)
        self.assertFalse(repeated_changed)
        self.assertEqual(table.put_count, 2)
        self.assertEqual(
            [alert["action"] for alert in merged["data"]["alerts"]],
            ["BUY", "SELL"],
        )
        self.assertEqual(set(merged["sourceMessageIds"]), {"message-earlier", "message-later"})
        self.assertEqual(repeated["dataVersion"], merged["dataVersion"])
        self.assertTrue(merged["dataVersion"].startswith(f"{ingestor.MATERIALIZED_DATA_VERSION}:"))
        self.assertIn("materializedAt", merged)

    def test_top_three_materialization_is_latest_wins_and_idempotent(self):
        table = FakeSnapshotTable()
        db = FakeDynamoDb(table)
        later = top_three_snapshot(
            "message-later",
            "2026-08-17T12:42:12+00:00",
            "Later",
        )
        earlier = top_three_snapshot(
            "message-earlier",
            "2026-08-17T11:07:04+00:00",
            "Earlier",
        )

        ingestor.materialize_email_snapshot(later, db)
        merged, changed = ingestor.materialize_email_snapshot(earlier, db)
        repeated, repeated_changed = ingestor.materialize_email_snapshot(earlier, db)

        self.assertTrue(changed)
        self.assertFalse(repeated_changed)
        self.assertEqual(merged["gmailMessageId"], "message-later")
        self.assertEqual(merged["data"]["items"][0]["title"], "Later One")
        self.assertEqual(
            set(merged["sourceMessageIds"]),
            {"message-earlier", "message-later"},
        )
        self.assertEqual(repeated["dataVersion"], merged["dataVersion"])

    def test_top_three_materialization_rejects_invalid_rank_contract(self):
        table = FakeSnapshotTable()
        db = FakeDynamoDb(table)
        invalid = top_three_snapshot(
            "message-invalid",
            "2026-08-17T12:42:12+00:00",
            "Invalid",
        )
        invalid["data"]["items"][2]["rank"] = 4

        with self.assertRaisesRegex(ValueError, "exactly three ranked items"):
            ingestor.materialize_email_snapshot(invalid, db)
        self.assertEqual(table.put_count, 0)

    def test_etf_materialization_keeps_latest_action_for_position(self):
        table = FakeSnapshotTable()
        db = FakeDynamoDb(table)

        ingestor.materialize_email_snapshot(
            etf_snapshot("message-add", "2026-07-15T16:00:00+00:00", "ADD"), db
        )
        merged, _ = ingestor.materialize_email_snapshot(
            etf_snapshot("message-remove", "2026-07-15T17:00:00+00:00", "REMOVE"), db
        )

        self.assertEqual(merged["data"]["addedLongs"], [])
        self.assertEqual(merged["data"]["removedLongs"], ["SPY"])
        self.assertEqual(merged["data"]["rows"][0]["action"], "REMOVE")
        self.assertEqual(len(merged["sourceMessageIds"]), 2)

    def test_etf_full_book_materialization_replays_later_actions(self):
        table = FakeSnapshotTable()
        db = FakeDynamoDb(table)
        checkpoint = etf_full_book_snapshot(
            "message-checkpoint",
            "2026-07-15T16:00:00+00:00",
        )
        remove_spy = etf_snapshot(
            "message-remove",
            "2026-07-15T17:00:00+00:00",
            "REMOVE",
        )

        ingestor.materialize_email_snapshot(remove_spy, db)
        merged, _ = ingestor.materialize_email_snapshot(checkpoint, db)

        self.assertTrue(merged["data"]["checkpointAvailable"])
        self.assertEqual(merged["data"]["fullBookLongs"], [])
        self.assertEqual(merged["data"]["fullBookShorts"], ["TLT"])
        self.assertEqual(
            [(row["ticker"], row["side"]) for row in merged["data"]["rows"]],
            [("TLT", "Short")],
        )
        self.assertEqual(
            merged["data"]["checkpointEvents"][0]["sourceMessageId"],
            "message-checkpoint",
        )
        self.assertEqual(merged["data"]["changes"][0]["sourceMessageId"], "message-remove")

    def test_rta_materialization_replaces_corrected_same_source(self):
        table = FakeSnapshotTable()
        db = FakeDynamoDb(table)
        original = rta_snapshot("message-corrected", "2026-07-15T16:00:00+00:00", "BUY")
        corrected = rta_snapshot("message-corrected", "2026-07-15T16:00:00+00:00", "SELL")

        ingestor.materialize_email_snapshot(original, db)
        merged, changed = ingestor.materialize_email_snapshot(corrected, db)
        repeated, repeated_changed = ingestor.materialize_email_snapshot(corrected, db)

        self.assertTrue(changed)
        self.assertFalse(repeated_changed)
        self.assertEqual(table.put_count, 2)
        self.assertEqual(len(merged["data"]["alerts"]), 1)
        self.assertEqual(merged["data"]["alerts"][0]["action"], "SELL")
        self.assertEqual(merged["sourceMessageIds"], ["message-corrected"])
        self.assertEqual(repeated["dataVersion"], merged["dataVersion"])

    def test_etf_materialization_replaces_corrected_same_source(self):
        table = FakeSnapshotTable()
        db = FakeDynamoDb(table)
        original = etf_snapshot("message-corrected", "2026-07-15T16:00:00+00:00", "ADD")
        corrected = etf_snapshot("message-corrected", "2026-07-15T16:00:00+00:00", "REMOVE")

        ingestor.materialize_email_snapshot(original, db)
        merged, changed = ingestor.materialize_email_snapshot(corrected, db)
        _, repeated_changed = ingestor.materialize_email_snapshot(corrected, db)

        self.assertTrue(changed)
        self.assertFalse(repeated_changed)
        self.assertEqual(table.put_count, 2)
        self.assertEqual(merged["data"]["addedLongs"], [])
        self.assertEqual(merged["data"]["removedLongs"], ["SPY"])
        self.assertEqual(len(merged["data"]["changes"]), 1)
        self.assertEqual(merged["data"]["changes"][0]["action"], "REMOVE")

    def test_processed_ledger_message_skips_full_gmail_download(self):
        table = FakeLedgerTable(
            [
                {
                    "messageId": "gmail-1",
                    "attachmentId": "attachment-1",
                    "status": "STORED",
                    "filename": "report.csv",
                    "mimeType": "text/csv",
                    "subject": "Hedgeye report",
                    "sender": "sender@example.com",
                    "createdAt": "2026-07-15T16:00:00+00:00",
                },
                {
                    "messageId": "gmail-1",
                    "attachmentId": ingestor.MESSAGE_LEDGER_ATTACHMENT_ID,
                    "status": "MESSAGE_PROCESSED",
                    "attachmentCount": 1,
                    "createdAt": "2026-07-15T16:01:00+00:00",
                }
            ]
        )

        with patch.object(ingestor, "get_message") as get_message:
            result = ingestor.process_message("token", "me", "gmail-1", table)

        get_message.assert_not_called()
        self.assertEqual(result["attachmentCount"], 1)
        self.assertEqual(result["skipped"][0]["detail"], "already-processed")
        self.assertEqual(
            table.items[("gmail-1", ingestor.MESSAGE_LEDGER_ATTACHMENT_ID)]["status"],
            "MESSAGE_PROCESSED",
        )

    def test_macro_week_summary_link_is_ignored_from_metadata_without_fetching_body(self):
        table = FakeLedgerTable()
        subject = "Macro Week Summary Notes | October 23rd, 2026"
        metadata = {
            "internalDate": "1792807389000",
            "payload": {
                "headers": [
                    {"name": "Subject", "value": subject},
                    {"name": "From", "value": "Hedgeye <info@hedgeye.com>"},
                    {"name": "Date", "value": "Fri, 23 Oct 2026 18:03:09 -0400"},
                ]
            },
        }

        with patch.object(
            ingestor, "get_message_metadata", return_value=metadata
        ), patch.object(ingestor, "get_message") as get_message, patch.object(
            ingestor, "s3"
        ) as s3_client:
            result = ingestor.process_message("token", "me", "gmail-macro-week", table)

        get_message.assert_not_called()
        s3_client.put_object.assert_not_called()
        self.assertTrue(result["ignored"])
        self.assertEqual(result["skipped"][0]["detail"], "macro-week-summary-link")
        sentinel = table.items[("gmail-macro-week", ingestor.MESSAGE_LEDGER_ATTACHMENT_ID)]
        self.assertEqual(sentinel["status"], "MESSAGE_IGNORED")
        self.assertEqual(sentinel["ignoredReason"], "macro-week-summary-link")
        self.assertIsNone(ingestor.link_only_notice_reason("The Macro Show | October 23rd, 2026"))
        self.assertEqual(ingestor.infer_report_type("message-body.html", subject), "unknown")

    def test_event_invites_and_chart_book_links_are_link_only_notices(self):
        for subject in [
            "HAPPENING NOW | MID-TERM MANIA: THE FINAL COUNTDOWN WITH NEIL HOWE AND JT TAYLOR",
            "HAPPENING IN ONE HOUR | Exclusive Q&A Session with Keith McCullough at 11AM ET",
            "HAPPENING IN 10 MINUTES | Exclusive Q&A Session With Keith McCullough at 11AM ET",
            "SUBMIT YOUR QUESTIONS FOR KEITH | Exclusive Q&A Session Tuesday at 11AM ET",
            "GEOPOLITICAL EVENT IN ONE HOUR | SPANNING THE GLOBE WITH COL. McCAUSLAND",
            "Keith Q&A | Read the Answers and Watch the Replay",
        ]:
            self.assertEqual(ingestor.link_only_notice_reason(subject), "event-notice", subject)
        self.assertEqual(ingestor.link_only_notice_reason("L1 Watch | Weekly Update"), "chart-book-link")
        for subject in [
            "Add Airbnb Inc. (ABNB) to LONG Side",
            "Digital Assets Position Monitor",
            "Early Look: Happening Now",
            "Real-Time Alert: Selling SPY",
        ]:
            self.assertIsNone(ingestor.link_only_notice_reason(subject), subject)

    def test_call_replays_and_dated_invites_are_event_notices(self):
        for subject in [
            # Filed as unknown between 27 Oct and 16 Nov 2026.
            "Call Replay | Q4 2026 / 1H 2027 US Housing Update & Outlook",
            "FLASH EVENT TODAY @ 12:00PM ET | Tier1 Alpha: From Hedge Unwind to Mechanical Deleveraging",
            "The Midterms Are Finally Over → Our Quick Take At The Terrain Ahead | Wednesday at 11AM ET",
            # Earlier invites that state the day and time the same way.
            "EVENT TOMORROW | Wednesday, October 14 @ 10AM | MID-TERM MANIA: UPDATE ON THE MIDTERM ELECTION WITH NEIL HOWE and JT TAYLOR",
            "Geopolitics Call Wednesday at 10AM ET | Spanning the Globe w/ JT Taylor & Col. McCausland",
            "Geopolitical Event Thursday at 10AM ET | Spanning the Globe w/ JT Taylor & Col. Jeff McCausland",
            "Call Tomorrow at 10AM ET | Will Trump's Sec. 301 Forced Labor Tariffs Survive Legal Challenge?",
            "TODAY AT 10AM ET | Geopolitical Risk Update w/ JT Taylor, Fernando Valle & Col. Jeff McCausland",
            "Hedgeye Policy Investing Themes - Thursday, July 9, 2026 at 12:30PM",
        ]:
            self.assertEqual(ingestor.link_only_notice_reason(subject), "event-notice", subject)
            self.assertEqual(ingestor.infer_report_type("message-body.html", subject), "unknown", subject)

    def test_weekly_theme_deck_links_are_link_only_notices(self):
        for subject in [
            "The Big Theme | AI Bubble | November 1, 2026 Update",
            "The Big Theme | AI Bubble | November 15, 2026 Update",
            "The AI Bubble Tracker | November 1, 2026 Update",
            "The Big Theme: October 18, 2026 Update",
        ]:
            self.assertEqual(ingestor.link_only_notice_reason(subject), "slide-deck-link", subject)
            self.assertEqual(ingestor.infer_report_type("message-body.html", subject), "unknown", subject)
        # The launch note is not a dated weekly update.
        self.assertIsNone(ingestor.link_only_notice_reason("The Big Theme, Q4 2026: The AI Bubble"))

    def test_research_subjects_are_not_link_only_notices(self):
        # These carry levels, position changes or analysis in the email body,
        # so no notice rule may hide them, registered or not.
        for subject in [
            "Trend & Tail Levels | Monthly Dashboard",
            "Hedgeye QIO | 4Q 2026 Mid-Quarter Update",
            "Digital Assets Position Monitor",
            "NFP | Rearview Report?",
            "ISM | That Which Cannot Continue",
            'WAGE ACCELERATION? | ECI RAISES "PROVE IT" BAR',
            # A clock time without a day, or a day without a clock time, is
            # not a closing day-and-time.
            "CPI at 8:30AM ET | What To Watch",
            "Retail Sales | What Changed Today",
            "Chart Check | Friday at the Fed",
        ]:
            self.assertIsNone(ingestor.link_only_notice_reason(subject), subject)

    def test_notice_wording_never_takes_an_email_from_a_registered_product(self):
        for subject, report_type in [
            ("CALL REPLAY | Q4 2026 MACRO THEMES MID-QUARTER UPDATE", "global-quads"),
            ("CALL TODAY @ 11AM | Q4 2026 MACRO THEMES PRESENTATION", "global-quads"),
            (
                "MARKET SITUATION REPORT: FLASH EVENT TODAY @ 12:00PM ET | "
                "Tier1 Alpha: From Hedge Unwind to Mechanical Deleveraging",
                "market-structure",
            ),
            ("Early Look: Fed Day | Wednesday at 2PM ET", "early-look"),
        ]:
            self.assertIsNone(ingestor.link_only_notice_reason(subject), subject)
            self.assertEqual(ingestor.infer_report_type("message-body.html", subject), report_type, subject)
        self.assertIsNone(ingestor.link_only_notice_reason("Add Airbnb Inc. (ABNB) to LONG Side | Today at 9AM ET"))

    def test_registered_report_type_names_the_product_before_notice_rules(self):
        webcast = "MARKET SITUATION REPORT: VIDEO | Market Situation Report Webcast | August 10, 2026"
        self.assertEqual(ingestor.registered_report_type("message-body.html", webcast), "market-structure")
        self.assertEqual(ingestor.infer_report_type("message-body.html", webcast), "unknown")
        self.assertEqual(
            ingestor.registered_report_type("", "The Big Theme | AI Bubble | November 1, 2026 Update"),
            "unknown",
        )

    def test_new_link_only_notices_are_ignored_from_metadata_without_fetching_body(self):
        for message_id, subject, reason in [
            ("gmail-big-theme", "The Big Theme | AI Bubble | November 15, 2026 Update", "slide-deck-link"),
            ("gmail-call-replay", "Call Replay | Q4 2026 / 1H 2027 US Housing Update & Outlook", "event-notice"),
            (
                "gmail-flash-event",
                "FLASH EVENT TODAY @ 12:00PM ET | Tier1 Alpha: From Hedge Unwind to Mechanical Deleveraging",
                "event-notice",
            ),
            (
                "gmail-day-ahead-invite",
                "The Midterms Are Finally Over → Our Quick Take At The Terrain Ahead | Wednesday at 11AM ET",
                "event-notice",
            ),
            (
                "gmail-renewal-reminder",
                "Your Signal Strength Stocks subscription renews on December 18, 2026",
                "account-notice",
            ),
        ]:
            with self.subTest(subject=subject):
                table = FakeLedgerTable()
                metadata = {
                    "internalDate": "1794744170000",
                    "payload": {
                        "headers": [
                            {"name": "Subject", "value": subject},
                            {"name": "From", "value": "Hedgeye <info@hedgeye.com>"},
                            {"name": "Date", "value": "Sun, 15 Nov 2026 07:02:50 -0500"},
                        ]
                    },
                }

                with patch.object(
                    ingestor, "get_message_metadata", return_value=metadata
                ), patch.object(ingestor, "get_message") as get_message, patch.object(
                    ingestor, "s3"
                ) as s3_client:
                    result = ingestor.process_message("token", "me", message_id, table)

                get_message.assert_not_called()
                s3_client.put_object.assert_not_called()
                self.assertTrue(result["ignored"])
                self.assertEqual(result["skipped"][0]["detail"], reason)
                sentinel = table.items[(message_id, ingestor.MESSAGE_LEDGER_ATTACHMENT_ID)]
                self.assertEqual(sentinel["status"], "MESSAGE_IGNORED")
                self.assertEqual(sentinel["ignoredReason"], reason)
                self.assertFalse(sentinel["bodyFetched"])

    def test_trend_tail_and_outlook_subjects_are_registered_products(self):
        for subject, report_type in [
            ("Trend & Tail Levels | Monthly Dashboard", "trend-tail-levels"),
            ("Hedgeye QIO | 4Q 2026 Mid-Quarter Update", "quarterly-investment-outlook"),
            ("Quarterly Investment Outlook | 4Q 2026", "quarterly-investment-outlook"),
            # Macro Themes call notices keep feeding Global Quads.
            ("CALL REPLAY | Q4 2026 MACRO THEMES MID-QUARTER UPDATE", "global-quads"),
            # A macro data note has no subject wording to match.
            ("NFP | Rearview Report?", "unknown"),
        ]:
            self.assertEqual(ingestor.infer_report_type("message-body.html", subject), report_type, subject)
            self.assertIsNone(ingestor.link_only_notice_reason(subject), subject)

    def test_trend_tail_levels_table_is_read_row_by_row(self):
        subject = "Trend & Tail Levels | Monthly Dashboard"
        html_body = research_email_html(
            headline=subject,
            stamp="11/01/2026 02:56 PM EST",
            body_html="""
            <div class="takeaway"><p><strong>Takeaway:</strong> Signal data refreshed with
            readings as of Nov 01, 2026 02:56 PM EST.</p>
            <p>(Previous signal data was as of Oct 04, 2026 06:44 PM EDT).</p></div>
            <table><tr><td>
            <table>
              <thead><tr><th>Ticker Description</th><th>Ticker</th><th>Closing<br />Price as of<br />11/01/2026</th>
                <th>Trend<br />Level</th><th>Current<br />Status</th><th>Tail<br />Level</th><th>Current<br />Status</th></tr></thead>
              <tbody>
                <tr><td>US Dollar Bullish</td><td>UUP</td><td><span>▲</span> 29.00</td><td>28.10</td><td>Above</td><td>27.75</td><td>Above</td></tr>
                <tr><td>Japanese Yen</td><td>FXY</td><td>▲ 58.19</td><td>57.74</td><td>Above <span>▲</span></td><td>58.24</td><td>Below</td></tr>
                <tr><th colspan="7">Commodities</th></tr>
                <tr><td>Gold</td><td>GLD</td><td>▼ 355.78</td><td>391.00</td><td>Below</td><td>392.00</td><td>Below ▼</td></tr>
                <tr><td>Bitcoin</td><td>IBIT</td><td>61.02</td><td>1,065.50</td><td>Below</td><td>70.00</td><td>Below</td></tr>
                <tr><td>No levels yet</td><td>NEW</td><td>10.00</td><td>n/a</td><td>Above</td><td>9.00</td><td>Above</td></tr>
                <tr><td>Gold again</td><td>GLD</td><td>1.00</td><td>1.00</td><td>Above</td><td>1.00</td><td>Above</td></tr>
              </tbody>
            </table>
            </td></tr></table>
            <p>Questions are welcome.</p>
            """,
        )

        snapshot = parse_research_email("trend-tail-levels", html_body, subject)

        self.assertEqual(snapshot["snapshotType"], "trend-tail-levels")
        self.assertEqual(snapshot["date"], "2026-11-01")
        self.assertEqual(snapshot["itemCount"], 4)
        data = snapshot["data"]
        self.assertEqual(data["closeDate"], "2026-11-01")
        self.assertEqual(data["asOf"], "Nov 01, 2026 02:56 PM EST")
        self.assertEqual(data["previousAsOf"], "Oct 04, 2026 06:44 PM EDT")
        self.assertEqual([row["ticker"] for row in data["rows"]], ["UUP", "FXY", "GLD", "IBIT"])
        self.assertEqual(
            data["rows"][0],
            {
                "ticker": "UUP",
                "name": "US Dollar Bullish",
                "close": Decimal("29.00"),
                "closeDirection": "up",
                "trendLevel": Decimal("28.10"),
                "trendStatus": "above",
                "trendStatusChanged": False,
                "tailLevel": Decimal("27.75"),
                "tailStatus": "above",
                "tailStatusChanged": False,
            },
        )
        # An arrow beside a status marks one that changed since the last edition.
        self.assertTrue(data["rows"][1]["trendStatusChanged"])
        self.assertFalse(data["rows"][1]["tailStatusChanged"])
        self.assertEqual(data["rows"][2]["group"], "Commodities")
        self.assertEqual(data["rows"][2]["closeDirection"], "down")
        self.assertTrue(data["rows"][2]["tailStatusChanged"])
        self.assertNotIn("closeDirection", data["rows"][3])
        self.assertEqual(data["rows"][3]["trendLevel"], Decimal("1065.50"))
        body = snapshot["article"]["bodyText"]
        self.assertIn("UUP (US Dollar Bullish): close 29.00 on 2026-11-01; above its Trend level 28.10; above its Tail level 27.75", body)
        self.assertNotIn("reader@example.com", json.dumps(snapshot, default=str))

    def test_trend_tail_edition_without_the_table_does_not_materialize(self):
        subject = "Trend & Tail Levels | Monthly Dashboard"
        html_body = research_email_html(
            headline=subject,
            body_html='<p>Takeaway: refreshed.</p><img src="https://example.com/dashboard.png" /><p>To view this in PDF form, click HERE.</p>',
        )

        self.assertIsNone(parse_research_email("trend-tail-levels", html_body, subject))

    def test_quarterly_investment_outlook_keeps_each_theme(self):
        subject = "Hedgeye QIO | 4Q 2026 Mid-Quarter Update"
        html_body = research_email_html(
            headline=subject,
            stamp="11/12/2026 03:11 PM EST",
            body_html="""
            <p>Dear Hedgeye Subscriber,</p><p>The mid-quarter update is below.</p>
            <p><a href="https://example.com/video"><img src="https://d1yhils6iwh5l5.cloudfront.net/charts/QIO.jpg?src=email&amp;email=reader%40example.com" /><br /><small>VIEW LINK</small></a></p>
            <ul>
              <li><span><strong>#Quad2 in Q4, Then #Quad4: </strong></span>Growth and inflation accelerate into year end before both slow in the first half.</li>
              <li><strong>The AI Bubble: </strong>The framework separates how stretched the complex is from how likely a break is.</li>
              <li><ul><li><p><b><span>Dollar Up, Rates Breaking Down!</span></b>: The long end turns lower first while the front end still prices a hike.</p></li></ul></li>
              <li>A short bullet without a title is not a theme.</li>
            </ul>
            """,
        )

        snapshot = parse_research_email("quarterly-investment-outlook", html_body, subject)

        self.assertEqual(snapshot["snapshotType"], "quarterly-investment-outlook")
        self.assertEqual(snapshot["date"], "2026-11-12")
        self.assertEqual(snapshot["data"]["quarter"], "4Q 2026")
        self.assertEqual(snapshot["data"]["edition"], "mid-quarter-update")
        self.assertEqual(
            [theme["title"] for theme in snapshot["data"]["themes"]],
            ["#Quad2 in Q4, Then #Quad4", "The AI Bubble", "Dollar Up, Rates Breaking Down!"],
        )
        self.assertEqual(
            snapshot["data"]["themes"][1]["text"],
            "The framework separates how stretched the complex is from how likely a break is.",
        )
        self.assertEqual(snapshot["itemCount"], 3)
        body = snapshot["article"]["bodyText"]
        self.assertTrue(body.startswith("Dear Hedgeye Subscriber,"))
        self.assertNotIn("VIEW LINK", body)
        self.assertNotIn("Please visit", body)
        # Image links lose the query string that names the subscriber.
        self.assertEqual(
            snapshot["article"]["imageUrls"],
            ["https://d1yhils6iwh5l5.cloudfront.net/charts/QIO.jpg"],
        )
        self.assertNotIn("reader", json.dumps(snapshot, default=str))
        outlook = parse_research_email(
            "quarterly-investment-outlook",
            research_email_html(headline="Quarterly Investment Outlook | 4Q 2026", body_html="<p>Dear Hedgeye Subscriber,</p>"),
            "Quarterly Investment Outlook | 4Q 2026",
        )
        self.assertEqual(outlook["data"]["edition"], "quarterly-outlook")
        self.assertEqual(outlook["data"]["themes"], [])

    def test_macro_note_is_recognised_by_its_sole_byline(self):
        drake = ("Christian Drake", "@hedgeyeusa")
        steiner = ("Josh Steiner, CFA", "@hedgeyefig")
        note = research_email_html(headline="NFP | Rearview Report?", bylines=[drake], body_html="<p>Payrolls rose.</p>")
        self.assertEqual(ingestor.byline_report_type(note), "us-macro-notes")
        for other in [
            # A sector piece several analysts sign.
            research_email_html(headline="L1 Watch | Weekly Update", bylines=[steiner, drake], body_html="<p>Charts.</p>"),
            research_email_html(headline="Why I sold", bylines=[("Keith McCullough", "@KeithMcCullough")], body_html="<p>Text.</p>"),
            research_email_html(headline="No byline", body_html="<p>Christian Drake is named in the text only.</p>"),
            "",
        ]:
            self.assertEqual(ingestor.byline_report_type(other), "unknown")

    def test_macro_note_keeps_its_prose_without_subscriber_lines(self):
        subject = "NFP | Rearview Report?"
        html_body = research_email_html(
            headline=subject,
            bylines=[("Christian Drake", "@hedgeyeusa")],
            body_html="""
            <p>Payrolls rose and the jobless rate fell.</p>
            <p><strong>THE DATA</strong></p>
            <ul><li>Headline: higher.</li><li>Revisions: higher.</li></ul>
            <p><a href="https://example.com/chart-1"><img src="https://d1yhils6iwh5l5.cloudfront.net/charts/nfp.png?src=email&amp;email=reader%40example.com" /><br />(VIEW LARGER IMAGE)</a></p>
            <p><a href="https://example.com/chart-2"><img src="https://d1yhils6iwh5l5.cloudfront.net/charts/hours.png" /><br />(VIEW LARGER IMAGE)</a></p>
            """,
        )

        snapshot = parse_research_email("us-macro-notes", html_body, subject)

        self.assertEqual(snapshot["snapshotType"], "us-macro-notes")
        self.assertEqual(snapshot["reportType"], "us-macro-notes")
        self.assertEqual(snapshot["date"], "2026-11-06")
        self.assertEqual(snapshot["article"]["headline"], subject)
        self.assertEqual(snapshot["article"]["feedUrl"], "https://app.hedgeye.com/feed_items/189609")
        self.assertEqual(
            snapshot["article"]["bodyText"],
            "Payrolls rose and the jobless rate fell.\nTHE DATA\nHeadline: higher.\nRevisions: higher.",
        )
        self.assertEqual(snapshot["data"], {"headline": subject, "author": "Christian Drake", "chartCount": 2})
        self.assertNotIn("reader", json.dumps(snapshot, default=str))

    def test_macro_note_is_filed_under_its_product_from_the_first_upload(self):
        subject = "ISM | That Which Cannot Continue"
        html_body = research_email_html(
            headline=subject,
            stamp="11/02/2026 02:59 PM EST",
            bylines=[("Christian Drake", "@hedgeyeusa")],
            body_html="<p>The headline index rose to 52.0.</p>",
        )
        table = FakeLedgerTable()
        with patch.object(
            ingestor, "put_immutable_s3_object", return_value=True
        ) as put_object, patch.object(
            ingestor, "persist_research_event_ledger", return_value=0
        ), patch.object(
            ingestor, "persist_snapshot_intelligence", return_value=1
        ) as persist_intelligence, patch.object(
            ingestor, "materialize_email_snapshot", return_value=({}, True)
        ), patch.object(
            ingestor, "finalize_snapshot_intelligence"
        ) as finalize:
            result = ingestor.upload_attachment(
                access_token="token",
                user_id="me",
                message_id="1a19dd92b68f1521",
                attachment={
                    "attachmentId": "message-body-html-1",
                    "filename": "message-body.html",
                    "mimeType": "text/html",
                    "inlineData": base64.urlsafe_b64encode(html_body.encode("utf-8")).decode("ascii"),
                },
                headers={"subject": subject, "from": "research@hedgeye.com"},
                received_at=datetime(2026, 11, 2, 20, 0, 16, tzinfo=timezone.utc),
                table=table,
            )

        self.assertEqual(result[0], "stored")
        ledger_row = table.items[("1a19dd92b68f1521", "message-body-html-1")]
        self.assertEqual(ledger_row["reportType"], "us-macro-notes")
        self.assertEqual(ledger_row["snapshotType"], "us-macro-notes")
        self.assertEqual(ledger_row["materializationStatus"], "INDEXED")
        self.assertIn("/2026-11-02/us-macro-notes/", put_object.call_args.kwargs["key"])
        self.assertEqual(put_object.call_args.kwargs["metadata"]["report-type"], "us-macro-notes")
        snapshot = persist_intelligence.call_args.args[0]
        self.assertEqual(snapshot["snapshotType"], "us-macro-notes")
        self.assertEqual(snapshot["data"]["author"], "Christian Drake")
        finalize.assert_called_once()

    def test_body_classification_leaves_notices_position_changes_and_attachments_alone(self):
        note = research_email_html(
            headline="Any subject",
            bylines=[("Christian Drake", "@hedgeyeusa")],
            body_html="<p>Text.</p>",
        )
        body = {
            "attachmentId": "message-body-html-1",
            "filename": "message-body.html",
            "mimeType": "text/html",
            "inlineData": base64.urlsafe_b64encode(note.encode("utf-8")).decode("ascii"),
        }
        self.assertEqual(ingestor.body_report_type(body, "NFP | Rearview Report?"), "us-macro-notes")
        for attachment, subject in [
            # A notice is ignored before its body is ever read.
            (body, "HAPPENING NOW | U.S. Macro Update With Christian Drake"),
            (body, "Call Replay | U.S. Macro Update"),
            # An Investing Ideas change is read from its subject.
            (body, "Remove Long Airbnb Inc. (ABNB)"),
            ({**body, "attachmentId": "att-1", "filename": "note.html"}, "NFP | Rearview Report?"),
            ({**body, "mimeType": "text/plain"}, "NFP | Rearview Report?"),
            ({**body, "inlineData": None}, "NFP | Rearview Report?"),
        ]:
            self.assertEqual(ingestor.body_report_type(attachment, subject), "unknown", subject)

    RENEWAL_SUBJECT = "Your Signal Strength Stocks subscription renews on December 18, 2026"
    RENEWAL_LEDGER_ROW = {
        "messageId": "1a1ee52a3bf0f168",
        "attachmentId": "message-body-html-1",
        "status": "ERROR",
        "filename": "message-body.html",
        "mimeType": "text/html",
        "reportType": "signal-strength",
        "subject": RENEWAL_SUBJECT,
        "sender": "Hedgeye <info@hedgeye.com>",
        "s3Bucket": "test-bucket",
        "s3Key": "hedgeye-email/messages/2026-11-18/signal-strength/1a1ee52a3bf0f168-message-body-html-1-message-body.html",
        "contentSha256": "e" * 64,
        "receivedAt": "2026-11-18T11:02:34+00:00",
        "error": "Research parser returned no signal-strength snapshot",
        "errorCode": "GMAIL_RESEARCH_MATERIALIZATION_ERROR",
        "parseError": "Research parser returned no signal-strength snapshot",
        "retryable": True,
        "materializationStatus": "ERROR",
    }

    def test_account_mail_is_a_notice_even_when_it_names_a_product(self):
        for subject in [
            self.RENEWAL_SUBJECT,
            "Your ETF Pro subscription renews on January 3, 2027",
            "Your subscription has been updated",
            "Your subscriptions have been updated",
            "Your trial has been activated",
            "Quick Start Guide for your Market Situation Report Subscription",
            "Quick Start Guide for your Elite Macro Subscription",
        ]:
            self.assertEqual(ingestor.link_only_notice_reason(subject), "account-notice", subject)
            self.assertEqual(ingestor.infer_report_type("message-body.html", subject), "unknown", subject)
        # The renewal reminder would otherwise be typed by the product it names.
        self.assertEqual(
            ingestor.registered_report_type("message-body.html", self.RENEWAL_SUBJECT),
            "signal-strength",
        )
        for subject, report_type in [
            ("Signal Strength Stocks: 51 Stocks (0 added, 3 removed)", "signal-strength"),
            ("Early Look: Your Subscription To Volatility", "early-look"),
            ("Your New “Macro Week Summary Notes” Starts Today", "unknown"),
            ("Welcome To Macro Pro", "unknown"),
        ]:
            self.assertIsNone(ingestor.link_only_notice_reason(subject), subject)
            self.assertEqual(ingestor.infer_report_type("message-body.html", subject), report_type, subject)

    def test_operator_replay_of_a_stored_notice_records_the_ignore_decision(self):
        row = dict(self.RENEWAL_LEDGER_ROW)
        table = FakeLedgerTable([row])

        with patch.object(ingestor, "backfill_html_snapshot") as backfill, patch.object(
            ingestor, "get_message_metadata"
        ) as get_metadata, patch.object(ingestor, "get_message") as get_message, patch.object(
            ingestor, "s3"
        ) as s3_client:
            result = ingestor.process_message("token", "me", row["messageId"], table, allow_version_backfill=True)

        # Nothing is fetched, read or parsed for a notice.
        backfill.assert_not_called()
        get_metadata.assert_not_called()
        get_message.assert_not_called()
        s3_client.get_object.assert_not_called()
        self.assertTrue(result["ignored"])
        self.assertEqual(result["stored"], [])
        self.assertEqual(result["skipped"], [{"filename": "", "detail": "account-notice"}])
        sentinel = table.items[(row["messageId"], ingestor.MESSAGE_LEDGER_ATTACHMENT_ID)]
        self.assertEqual(sentinel["status"], "MESSAGE_IGNORED")
        self.assertEqual(sentinel["ignoredReason"], "account-notice")
        self.assertEqual(sentinel["subject"], self.RENEWAL_SUBJECT)
        self.assertTrue(ingestor.message_is_fully_processed(table.items.values()))
        # The stored artifact row is left as the audit of what happened.
        self.assertEqual(table.items[(row["messageId"], row["attachmentId"])]["status"], "ERROR")

    def test_operator_replay_of_a_quarantined_notice_clears_the_quarantine(self):
        row = dict(self.RENEWAL_LEDGER_ROW)
        state_key = (ingestor.RUNTIME_STATE_MESSAGE_ID, ingestor.HISTORY_CURSOR_ATTACHMENT_ID)
        ledger = FakeLedgerTable(
            [
                {
                    "messageId": ingestor.RUNTIME_STATE_MESSAGE_ID,
                    "attachmentId": ingestor.HISTORY_CURSOR_ATTACHMENT_ID,
                    "status": "WARNING",
                    "historyId": "125",
                    "quarantinedCount": 1,
                    "quarantinedMessages": [
                        {
                            "messageId": row["messageId"],
                            "errorCode": "GMAIL_RESEARCH_MATERIALIZATION_ERROR",
                            "quarantinedAt": "2026-11-18T11:42:50+00:00",
                            "attemptCount": 3,
                        }
                    ],
                    "createdAt": "2026-11-18T11:00:00+00:00",
                    "updatedAt": "2026-11-18T11:42:50+00:00",
                },
                row,
            ]
        )
        database = FakeRuntimeDynamoDb(ledger)
        secret = {
            "client_id": "client",
            "client_secret": "secret",
            "refresh_token": "refresh",
            "user_id": "me",
            "_secret_version": "version-replay",
        }

        with patch.object(ingestor, "dynamodb", database), patch.object(
            ingestor, "cloudwatch", MagicMock()
        ), patch.object(
            ingestor, "load_oauth_secret", return_value=secret
        ), patch.object(
            ingestor, "refresh_access_token", return_value="access"
        ), patch.object(
            ingestor, "get_profile_history_id", return_value="125"
        ), patch.object(
            ingestor, "resolve_label_id", return_value="Label_1"
        ), patch.object(
            ingestor, "list_history_message_ids", return_value=[]
        ), patch.object(
            ingestor, "list_message_ids"
        ) as list_messages, patch.object(
            ingestor, "get_message_metadata"
        ) as get_metadata, patch.object(
            ingestor, "get_message"
        ) as get_message:
            response = ingestor.lambda_handler(
                {
                    "source": ingestor.OPERATOR_REPLAY_SOURCE,
                    "messageIds": [row["messageId"]],
                    "forceBackfill": True,
                    "materializationVersion": ingestor.MATERIALIZED_DATA_VERSION,
                },
                None,
            )

        body = json.loads(response["body"])
        self.assertEqual(body["status"], "SUCCESS")
        self.assertIsNone(body.get("errorCode"))
        final_state = ledger.items[state_key]
        self.assertEqual(final_state["status"], "READY")
        self.assertEqual(final_state["quarantinedCount"], 0)
        self.assertEqual(final_state["quarantinedMessages"], [])
        self.assertEqual(database.heartbeat.writes[-1]["status"], "success")
        self.assertNotIn("errorCode", database.heartbeat.writes[-1])
        self.assertEqual(
            ledger.items[(row["messageId"], ingestor.MESSAGE_LEDGER_ATTACHMENT_ID)]["ignoredReason"],
            "account-notice",
        )
        # The replay decides from the stored subject alone.
        get_metadata.assert_not_called()
        get_message.assert_not_called()
        list_messages.assert_not_called()

    def test_operator_replay_still_fails_when_a_stored_research_email_has_nothing_to_replay(self):
        row = dict(self.RENEWAL_LEDGER_ROW, subject="Signal Strength Stocks: 51 Stocks (0 added, 3 removed)")
        table = FakeLedgerTable([row])

        with patch.object(ingestor, "backfill_html_snapshot", return_value=False):
            with self.assertRaises(ingestor.GmailOperatorReplayError):
                ingestor.process_message("token", "me", row["messageId"], table, allow_version_backfill=True)

        self.assertNotIn((row["messageId"], ingestor.MESSAGE_LEDGER_ATTACHMENT_ID), table.items)

    def test_single_investing_ideas_add_takes_its_side_from_the_subject(self):
        subject = "Add Airbnb Inc. (ABNB) to LONG Side"
        html_body = """
            <h1>Add Airbnb Inc. (ABNB) to LONG Side</h1>
            <p>We are <strong>ADDING</strong> the following to <em>Investing Ideas</em>:</p>
            <p><strong>Long:</strong></p><ul><li><abbr name="Airbnb Inc.">ABNB</abbr></li></ul>
            <p>Travel related stocks are down with hotel stocks like HLT today...</p>
        """
        snapshot = ingestor.parse_html_snapshot(
            report_type=ingestor.infer_report_type("message-body.html", subject),
            html_body=html_body,
            received_at=datetime(2026, 10, 27, 19, 12, tzinfo=timezone.utc),
            s3_key="gmail/unknown/abnb.html",
            message_id="abnb-add",
            subject=subject,
        )

        self.assertEqual(snapshot["snapshotType"], "investing-ideas")
        [alert] = snapshot["data"]["alerts"]
        self.assertEqual((alert["ticker"], alert["action"], alert["side"]), ("ABNB", "ADD", "long"))
        self.assertNotIn("riskRangeLow", alert)
        self.assertNotIn("ADDING", {event["entityId"] for event in research_intelligence.build_entity_events(snapshot)})

    def test_single_investing_ideas_change_can_name_the_side_before_the_company(self):
        # The wording of a stop-out notice (16 November 2026). It was filed as
        # an unknown product, so the removal never reached Investing Ideas.
        subject = "Remove Short Broadcom Inc. (AVGO)"
        html_body = """
            <h1>Remove Short Broadcom Inc. (AVGO)</h1>
            <p><a href="https://app.hedgeye.com/investing_ideas">Access Investing Ideas Dashboard</a></p>
            <p>We have <strong>REMOVED</strong> the following from <em>Investing Ideas</em>:</p>
            <p><strong>Short:</strong> <abbr name="Broadcom Inc.">AVGO</abbr></p>
            <p>This position has stopped out on our #VASP (Volatility Adjusted Signaling Process).</p>
        """
        self.assertEqual(ingestor.infer_report_type("message-body.html", subject), "unknown")
        self.assertTrue(ingestor.is_position_change_subject(subject))
        snapshot = ingestor.parse_html_snapshot(
            report_type=ingestor.infer_report_type("message-body.html", subject),
            html_body=html_body,
            received_at=datetime(2026, 11, 16, 13, 26, tzinfo=timezone.utc),
            s3_key="hedgeye-email/messages/2026-11-16/unknown/avgo.html",
            message_id="avgo-remove",
            subject=subject,
        )

        self.assertEqual(snapshot["snapshotType"], "investing-ideas")
        [alert] = snapshot["data"]["alerts"]
        self.assertEqual((alert["ticker"], alert["action"], alert["side"]), ("AVGO", "REMOVE", "short"))
        self.assertEqual(alert["signalPhrase"], "Remove AVGO")
        self.assertNotIn("riskRangeLow", alert)
        self.assertNotIn("REMOVED", {event["entityId"] for event in research_intelligence.build_entity_events(snapshot)})

        for other, expected in [
            ("Add Long Airbnb Inc. (ABNB)", ("ADD", "ABNB", "long")),
            ("Add Short Goldman Sachs Group Inc. (GS)", ("ADD", "GS", "short")),
            ("Remove Long Berkshire Hathaway Inc. (BRK.B)", ("REMOVE", "BRK.B", "long")),
            ("remove short  Broadcom Inc.  ( AVGO )", ("REMOVE", "AVGO", "short")),
            # The older wording still states its side after the ticker.
            ("Remove Broadcom Inc. (AVGO) from SHORT Side", ("REMOVE", "AVGO", "short")),
        ]:
            normalized = " ".join(other.split())
            self.assertTrue(ingestor.is_position_change_subject(other), other)
            self.assertEqual(email_parser._single_position_change(normalized), expected, other)
        for other in [
            "Remove Short Squeeze Risk",
            "Short Broadcom Inc. (AVGO)",
            "Remove Broadcom Inc. (AVGO)",
            "Remove Short Broadcom Inc. (AVGO) | Replay",
            "Early Look: Remove Short Broadcom Inc. (AVGO)",
        ]:
            self.assertFalse(ingestor.is_position_change_subject(other), other)

    def test_a_side_first_subject_outside_investing_ideas_is_not_a_position_change_alert(self):
        subject = "Remove Short Broadcom Inc. (AVGO)"
        snapshot = ingestor.parse_html_snapshot(
            report_type=ingestor.infer_report_type("message-body.html", subject),
            html_body="<h1>Remove Short Broadcom Inc. (AVGO)</h1><p>A note that names no product.</p>",
            received_at=datetime(2026, 11, 16, 13, 26, tzinfo=timezone.utc),
            s3_key="hedgeye-email/messages/2026-11-16/unknown/other.html",
            message_id="avgo-other",
            subject=subject,
        )
        self.assertFalse(((snapshot or {}).get("data") or {}).get("alerts"))

    def test_multi_change_subject_side_word_is_not_a_ticker(self):
        subject = "2 Changes: Add Short GS, Add COST"
        html_body = """
            <h1>2 Changes: Add Short GS, Add COST</h1>
            <p>We are <strong>ADDING</strong> the following to <em>Investing Ideas</em>:</p>
            <p><strong>Long:</strong></p><ul><li><abbr name="Costco">COST</abbr></li></ul>
            <p>We are <strong>ADDING</strong> the following to <em>Investing Ideas</em>:</p>
            <p><strong>Short:</strong></p><ul><li><abbr name="Goldman Sachs">GS</abbr></li></ul>
            <p>Been waiting, patiently, for this relatively new Signal Strength Stock,</p>
            <p>KM</p>
        """
        snapshot = ingestor.parse_html_snapshot(
            report_type=ingestor.infer_report_type("message-body.html", subject),
            html_body=html_body,
            received_at=datetime(2026, 10, 28, 19, 29, tzinfo=timezone.utc),
            s3_key="gmail/unknown/gs-cost.html",
            message_id="gs-cost",
            subject=subject,
        )

        self.assertEqual(snapshot["snapshotType"], "investing-ideas")
        alerts = {row["ticker"]: row for row in snapshot["data"]["alerts"]}
        self.assertEqual(list(alerts), ["GS", "COST"])
        self.assertEqual({ticker: (row["action"], row["side"]) for ticker, row in alerts.items()},
                         {"GS": ("ADD", "short"), "COST": ("ADD", "long")})
        self.assertFalse(any("riskRangeLow" in row for row in alerts.values()))
        entities = {event["entityId"] for event in research_intelligence.build_entity_events(snapshot)}
        self.assertNotIn("SHORT", entities)

    ABNB_LEDGER_ROW = {
        "messageId": "1a17ec8a530b21d0",
        "attachmentId": "message-body-html-1",
        "status": "UNSUPPORTED",
        "errorCode": "RESEARCH_PRODUCT_UNSUPPORTED",
        "filename": "message-body.html",
        "mimeType": "text/html",
        "reportType": "unknown",
        "subject": "Add Airbnb Inc. (ABNB) to LONG Side",
        "sender": "Hedgeye <info@hedgeye.com>",
        "s3Bucket": "market-dashboard-csv-data",
        "s3Key": "hedgeye-email/messages/2026-10-27/unknown/1a17ec8a530b21d0-message-body-html-1-message-body.html",
        "receivedAt": "2026-10-27T19:13:59+00:00",
        "materializationAttemptVersion": ingestor.MATERIALIZED_DATA_VERSION,
        "materializationAttemptCount": 1,
        "materializationStatus": "ERROR",
        "retryable": False,
    }

    def test_operator_replay_reaches_an_unsupported_single_investing_ideas_change(self):
        row = dict(self.ABNB_LEDGER_ROW, contentSha256="a" * 64)
        self.assertTrue(ingestor.is_position_change_subject(row["subject"]))
        self.assertFalse(ingestor._should_backfill_materialized_snapshot(row))
        self.assertTrue(ingestor._should_backfill_materialized_snapshot(row, allow_version_upgrade=True))

        table = FakeLedgerTable([row])
        with patch.object(ingestor, "backfill_html_snapshot", return_value=True) as backfill, patch.object(
            ingestor, "get_message_metadata"
        ) as get_metadata, patch.object(ingestor, "get_message") as get_message:
            result = ingestor.process_message("token", "me", row["messageId"], table, allow_version_backfill=True)

        backfill.assert_called_once()
        get_metadata.assert_not_called()
        get_message.assert_not_called()
        self.assertEqual(result["stored"], [{"filename": "message-body.html", "detail": "snapshot-backfilled"}])

    def test_backfilled_single_investing_ideas_change_leaves_the_unknown_manifest(self):
        html_body = (
            "<h1>Add Airbnb Inc. (ABNB) to LONG Side</h1>"
            "<p>We are <strong>ADDING</strong> the following to <em>Investing Ideas</em>:</p>"
            "<p><strong>Long:</strong></p><ul><li><abbr name=\"Airbnb Inc.\">ABNB</abbr></li></ul>"
        ).encode()
        row = dict(self.ABNB_LEDGER_ROW, contentSha256=hashlib.sha256(html_body).hexdigest())
        table = FakeLedgerTable([row])
        s3_client = MagicMock()
        s3_client.get_object.return_value = {"Body": MagicMock(read=MagicMock(return_value=html_body))}

        with patch.object(ingestor, "s3", s3_client), patch.object(
            ingestor, "persist_research_event_ledger", return_value=1
        ), patch.object(ingestor, "persist_snapshot_intelligence", return_value=1), patch.object(
            ingestor, "materialize_email_snapshot", return_value=({}, None)
        ), patch.object(ingestor, "finalize_snapshot_intelligence"), patch.object(
            ingestor, "reclassify_manifest_artifact"
        ) as reclassify:
            backfilled = ingestor.backfill_html_snapshot(
                table=table,
                message_id=row["messageId"],
                attachment_id=row["attachmentId"],
                report_type="unknown",
                mime_type="text/html",
                received_at=datetime(2026, 10, 27, 19, 13, 59, tzinfo=timezone.utc),
                ledger_item=row,
                replace_entity_projection=True,
            )

        self.assertTrue(backfilled)
        [snapshot] = reclassify.call_args.args[:1]
        self.assertEqual(snapshot["snapshotType"], "investing-ideas")
        self.assertEqual(reclassify.call_args.kwargs["source_product_id"], "unknown")
        self.assertEqual(snapshot["data"]["alerts"][0]["ticker"], "ABNB")

    INVESTING_IDEAS_KEY = ("2026-11-16", "investing-ideas")
    AVGO_REMOVAL_HTML = (
        "<h1>Remove Short Broadcom Inc. (AVGO)</h1>"
        "<p>We have <strong>REMOVED</strong> the following from <em>Investing Ideas</em>:</p>"
        "<p><strong>Short:</strong> <abbr name=\"Broadcom Inc.\">AVGO</abbr></p>"
        "<p>This position has stopped out on our #VASP (Volatility Adjusted Signaling Process).</p>"
    )

    def _investing_ideas_roster(self, received_at, message_id="roster-1116"):
        return ingestor.parse_html_snapshot(
            report_type="investing-ideas",
            html_body="""
                <h1>Investing Ideas Newsletter: November 16, 2026</h1>
                <p>Long: DDOG, BRKR</p>
                <p>Short: OLLI, HCA</p>
                <table class="investing-ideas-table">
                  <tr class="long"><td>DDOG</td><td>$267.97</td><td>$244.00</td><td>$275.00</td></tr>
                  <tr class="long"><td>BRKR</td><td>$62.84</td><td>$58.27</td><td>$65.48</td></tr>
                  <tr class="short"><td>OLLI</td><td>$73.47</td><td>$61.90</td><td>$74.98</td></tr>
                  <tr class="short"><td>HCA</td><td>$402.59</td><td>$363.00</td><td>$418.00</td></tr>
                </table>
            """,
            received_at=received_at,
            s3_key=f"hedgeye-email/messages/2026-11-16/investing-ideas/{message_id}.html",
            message_id=message_id,
            subject="Investing Ideas Newsletter: November 16, 2026",
        )

    def _investing_ideas_removal(self, received_at, message_id="avgo-remove"):
        return ingestor.parse_html_snapshot(
            report_type="unknown",
            html_body=self.AVGO_REMOVAL_HTML,
            received_at=received_at,
            s3_key=f"hedgeye-email/messages/2026-11-16/unknown/{message_id}.html",
            message_id=message_id,
            subject="Remove Short Broadcom Inc. (AVGO)",
        )

    def test_replayed_investing_ideas_alert_keeps_the_roster_published_after_it(self):
        # 16 November 2026: the stop-out alert arrived at 08:25 Eastern and the
        # newsletter with the whole roster at 09:06. Replaying the alert later
        # must not turn the day's snapshot back into an alert with no roster.
        table = FakeSnapshotTable()
        db = FakeDynamoDb(table)
        roster = self._investing_ideas_roster(datetime(2026, 11, 16, 14, 6, 56, tzinfo=timezone.utc))
        alert = self._investing_ideas_removal(datetime(2026, 11, 16, 13, 25, 40, tzinfo=timezone.utc))
        self.assertEqual((roster["date"], roster["snapshotType"]), self.INVESTING_IDEAS_KEY)
        self.assertEqual((alert["date"], alert["snapshotType"]), self.INVESTING_IDEAS_KEY)
        self.assertNotIn("positions", alert["data"])

        ingestor.materialize_email_snapshot(deepcopy(roster), db)
        stored = deepcopy(table.items[self.INVESTING_IDEAS_KEY])
        _, written = ingestor.materialize_email_snapshot(deepcopy(alert), db)

        self.assertFalse(written)
        self.assertEqual(table.put_count, 1)
        self.assertEqual(table.items[self.INVESTING_IDEAS_KEY], stored)
        self.assertEqual(stored["gmailMessageId"], "roster-1116")
        self.assertEqual(stored["positionCount"], 4)
        self.assertEqual(stored["data"]["shorts"], ["OLLI", "HCA"])

    def test_investing_ideas_daily_snapshot_follows_the_latest_email_in_either_order(self):
        roster = self._investing_ideas_roster(datetime(2026, 11, 16, 14, 6, 56, tzinfo=timezone.utc))
        alert = self._investing_ideas_removal(datetime(2026, 11, 16, 13, 25, 40, tzinfo=timezone.utc))
        for order in ((alert, roster), (roster, alert)):
            table = FakeSnapshotTable()
            db = FakeDynamoDb(table)
            for snapshot in order:
                ingestor.materialize_email_snapshot(deepcopy(snapshot), db)
            self.assertEqual(table.items[self.INVESTING_IDEAS_KEY]["gmailMessageId"], "roster-1116")

        # A change sent after the newsletter becomes the day's snapshot, as before.
        afternoon = self._investing_ideas_removal(
            datetime(2026, 11, 16, 19, 30, tzinfo=timezone.utc), "avgo-remove-afternoon"
        )
        _, written = ingestor.materialize_email_snapshot(deepcopy(afternoon), db)
        self.assertTrue(written)
        self.assertEqual(table.items[self.INVESTING_IDEAS_KEY]["gmailMessageId"], "avgo-remove-afternoon")

        # A corrected parse of that same email still refreshes its own snapshot.
        corrected = deepcopy(afternoon)
        corrected["data"]["headline"] = "Remove Short Broadcom Inc. (AVGO), corrected"
        _, written = ingestor.materialize_email_snapshot(corrected, db)
        self.assertTrue(written)
        self.assertEqual(
            table.items[self.INVESTING_IDEAS_KEY]["data"]["headline"],
            "Remove Short Broadcom Inc. (AVGO), corrected",
        )

        # Two emails stamped the same second: the higher Gmail id is the later one.
        same_second = self._investing_ideas_removal(
            datetime(2026, 11, 16, 19, 30, tzinfo=timezone.utc), "avgo-remove-a"
        )
        _, written = ingestor.materialize_email_snapshot(same_second, db)
        self.assertFalse(written)
        self.assertEqual(table.items[self.INVESTING_IDEAS_KEY]["gmailMessageId"], "avgo-remove-afternoon")

    def test_investing_ideas_snapshot_without_a_readable_receipt_time_is_written_as_before(self):
        table = FakeSnapshotTable()
        db = FakeDynamoDb(table)
        roster = self._investing_ideas_roster(datetime(2026, 11, 16, 14, 6, 56, tzinfo=timezone.utc))
        legacy = deepcopy(roster)
        legacy["scrapedAt"] = "16 Nov 2026 9:06am"
        ingestor.materialize_email_snapshot(legacy, db)

        # The stored time cannot be ordered, so nothing is held back.
        alert = self._investing_ideas_removal(datetime(2026, 11, 16, 13, 25, 40, tzinfo=timezone.utc))
        _, written = ingestor.materialize_email_snapshot(deepcopy(alert), db)
        self.assertTrue(written)
        self.assertEqual(table.items[self.INVESTING_IDEAS_KEY]["gmailMessageId"], "avgo-remove")

    def test_only_investing_ideas_reads_the_stored_edition_before_writing(self):
        class UnreadSnapshotTable(FakeSnapshotTable):
            def get_item(self, **_kwargs):
                raise AssertionError("this product's daily snapshot must not be read before it is written")

        table = UnreadSnapshotTable()
        snapshot = {
            "date": "2026-11-16",
            "snapshotType": "the-call",
            "reportType": "the-call",
            "scrapedAt": "2026-11-16T12:45:00+00:00",
            "gmailMessageId": "the-call-1116",
            "data": {"headline": "The Call @ Hedgeye"},
        }

        _, written = ingestor.materialize_email_snapshot(snapshot, FakeDynamoDb(table))

        self.assertTrue(written)
        self.assertEqual(table.items[("2026-11-16", "the-call")]["gmailMessageId"], "the-call-1116")

    def test_backfilled_investing_ideas_alert_is_indexed_without_replacing_the_later_roster(self):
        html_body = self.AVGO_REMOVAL_HTML.encode()
        row = dict(
            self.ABNB_LEDGER_ROW,
            messageId="1a1e48957f3c105c",
            subject="Remove Short Broadcom Inc. (AVGO)",
            s3Key=(
                "hedgeye-email/messages/2026-11-16/unknown/"
                "1a1e48957f3c105c-message-body-html-1-message-body.html"
            ),
            receivedAt="2026-11-16T13:25:40+00:00",
            contentSha256=hashlib.sha256(html_body).hexdigest(),
        )
        snapshots = FakeSnapshotTable()
        ingestor.materialize_email_snapshot(
            self._investing_ideas_roster(datetime(2026, 11, 16, 14, 6, 56, tzinfo=timezone.utc)),
            FakeDynamoDb(snapshots),
        )
        stored = deepcopy(snapshots.items[self.INVESTING_IDEAS_KEY])
        s3_client = MagicMock()
        s3_client.get_object.return_value = {"Body": MagicMock(read=MagicMock(return_value=html_body))}

        with patch.object(ingestor, "s3", s3_client), patch.object(
            ingestor, "dynamodb", FakeDynamoDb(snapshots)
        ), patch.object(ingestor, "persist_research_event_ledger", return_value=1) as ledger, patch.object(
            ingestor, "persist_snapshot_intelligence", return_value=1
        ) as intelligence, patch.object(ingestor, "finalize_snapshot_intelligence") as finalize, patch.object(
            ingestor, "reclassify_manifest_artifact"
        ) as reclassify:
            backfilled = ingestor.backfill_html_snapshot(
                table=FakeLedgerTable([row]),
                message_id=row["messageId"],
                attachment_id=row["attachmentId"],
                report_type="unknown",
                mime_type="text/html",
                received_at=datetime(2026, 11, 16, 13, 25, 40, tzinfo=timezone.utc),
                ledger_item=row,
                replace_entity_projection=True,
            )

        # The alert still reaches the event ledger, the entity index and the
        # Investing Ideas manifest; only the day's snapshot is left alone.
        self.assertTrue(backfilled)
        [snapshot] = ledger.call_args.args[:1]
        self.assertEqual(
            [(alert["ticker"], alert["action"], alert["side"]) for alert in snapshot["data"]["alerts"]],
            [("AVGO", "REMOVE", "short")],
        )
        intelligence.assert_called_once()
        finalize.assert_called_once()
        self.assertEqual(reclassify.call_args.kwargs["source_product_id"], "unknown")
        self.assertEqual(snapshots.put_count, 1)
        self.assertEqual(snapshots.items[self.INVESTING_IDEAS_KEY], stored)

    def test_single_side_subject_without_investing_ideas_body_is_not_a_position_change(self):
        snapshot = ingestor.parse_html_snapshot(
            report_type="unknown",
            html_body="<h1>Add Airbnb Inc. (ABNB) to LONG Side</h1><p>Webinar recap.</p>",
            received_at=datetime(2026, 10, 27, 19, 12, tzinfo=timezone.utc),
            s3_key="gmail/unknown/abnb.html",
            message_id="abnb-other",
            subject="Add Airbnb Inc. (ABNB) to LONG Side",
        )
        self.assertIsNone(snapshot)

    def test_market_situation_webcast_is_ignored_from_metadata_without_fetching_body(self):
        table = FakeLedgerTable()
        subject = (
            "MARKET SITUATION REPORT: VIDEO | Market Situation Report Webcast | "
            "August 10, 2026"
        )
        metadata = {
            "internalDate": "1786357800000",
            "payload": {
                "headers": [
                    {"name": "Subject", "value": subject},
                    {"name": "From", "value": "Hedgeye <research@hedgeye.com>"},
                    {"name": "Date", "value": "Mon, 10 Aug 2026 03:30:00 -0400"},
                ]
            },
        }

        with patch.object(
            ingestor, "get_message_metadata", return_value=metadata
        ) as get_metadata, patch.object(
            ingestor, "get_message"
        ) as get_message, patch.object(
            ingestor, "s3"
        ) as s3_client:
            result = ingestor.process_message(
                "token", "me", "gmail-market-webcast", table
            )

        get_metadata.assert_called_once()
        get_message.assert_not_called()
        s3_client.put_object.assert_not_called()
        s3_client.get_object.assert_not_called()
        self.assertTrue(result["ignored"])
        self.assertEqual(result["skipped"][0]["detail"], "market-structure-webcast")
        sentinel = table.items[
            ("gmail-market-webcast", ingestor.MESSAGE_LEDGER_ATTACHMENT_ID)
        ]
        self.assertEqual(sentinel["status"], "MESSAGE_IGNORED")
        self.assertEqual(sentinel["ignoredReason"], "market-structure-webcast")
        self.assertFalse(sentinel["bodyFetched"])
        self.assertEqual(ingestor.infer_report_type("message-body.html", subject), "unknown")

        table.items[("gmail-market-webcast", "legacy-message-body")] = {
            "messageId": "gmail-market-webcast",
            "attachmentId": "legacy-message-body",
            "status": "ERROR",
            "retryable": True,
            "mimeType": "text/html",
            "filename": "message-body.html",
            "subject": subject,
        }
        with patch.object(ingestor, "get_message_metadata") as repeated_metadata, patch.object(
            ingestor, "get_message"
        ) as repeated_message:
            repeated = ingestor.process_message(
                "token", "me", "gmail-market-webcast", table
            )
        repeated_metadata.assert_not_called()
        repeated_message.assert_not_called()
        self.assertTrue(repeated["ignored"])
        self.assertEqual(
            repeated["skipped"][0]["detail"],
            "market-structure-webcast",
        )

        old_webcast = {
            "messageId": "old-webcast",
            "attachmentId": "message-body-html-0",
            "status": "INDEXED",
            "mimeType": "text/html",
            "filename": "message-body.html",
            "reportType": "market-structure",
            "snapshotType": "market-structure",
            "subject": subject,
            "s3Bucket": "private-bucket",
            "s3Key": "hedgeye-email/messages/private-webcast.html",
            "materializationAttemptVersion": "old-parser",
        }
        self.assertFalse(
            ingestor._should_backfill_materialized_snapshot(
                old_webcast,
                allow_version_upgrade=True,
            )
        )

    def test_terminal_row_without_sentinel_refetches_and_finishes_missing_attachment(self):
        table = FakeLedgerTable(
            [
                {
                    "messageId": "gmail-partial",
                    "attachmentId": "inline-one",
                    "status": "STORED",
                    "filename": "one.csv",
                    "mimeType": "text/csv",
                    "reportType": "unknown",
                    "subject": "Hedgeye reports",
                    "sender": "sender@example.com",
                    "createdAt": "2026-07-15T10:00:00+00:00",
                    "updatedAt": "2026-07-15T10:01:00+00:00",
                }
            ]
        )
        message = {
            "internalDate": "1784120400000",
            "payload": {
                "headers": [{"name": "Subject", "value": "Hedgeye reports"}],
                "parts": [
                    {
                        "partId": "one",
                        "filename": "one.csv",
                        "mimeType": "text/csv",
                        "body": {
                            "data": base64.urlsafe_b64encode(b"ticker\nSPY\n").decode("ascii")
                        },
                    },
                    {
                        "partId": "two",
                        "filename": "two.csv",
                        "mimeType": "text/csv",
                        "body": {
                            "data": base64.urlsafe_b64encode(b"ticker\nQQQ\n").decode("ascii")
                        },
                    },
                ],
            },
        }
        s3_client = MagicMock()

        with patch.object(ingestor, "get_message_metadata", return_value=message), patch.object(
            ingestor, "get_message", return_value=message
        ) as get_message, patch.object(
            ingestor, "s3", s3_client
        ):
            result = ingestor.process_message("token", "me", "gmail-partial", table)

        get_message.assert_called_once()
        self.assertEqual([item["filename"] for item in result["skipped"]], ["one.csv"])
        self.assertEqual([item["filename"] for item in result["stored"]], ["two.csv"])
        self.assertEqual(s3_client.put_object.call_count, 1)
        self.assertEqual(table.items[("gmail-partial", "inline-two")]["status"], "UNSUPPORTED")
        self.assertEqual(
            table.items[("gmail-partial", ingestor.MESSAGE_LEDGER_ATTACHMENT_ID)]["status"],
            "MESSAGE_PROCESSED",
        )

    def test_stale_in_progress_attachment_is_reclaimed_and_processed(self):
        table = FakeLedgerTable(
            [
                {
                    "messageId": "gmail-crash",
                    "attachmentId": "inline-file",
                    "status": "IN_PROGRESS",
                    "filename": "report.csv",
                    "mimeType": "text/csv",
                    "reportType": "unknown",
                    "subject": "Hedgeye report",
                    "sender": "sender@example.com",
                    "createdAt": "2026-07-15T08:00:00+00:00",
                    "updatedAt": "2026-07-15T08:00:00+00:00",
                }
            ]
        )
        message = {
            "internalDate": "1784120400000",
            "payload": {
                "headers": [
                    {"name": "Subject", "value": "Hedgeye report"},
                    {"name": "From", "value": "sender@example.com"},
                ],
                "parts": [
                    {
                        "partId": "file",
                        "filename": "report.csv",
                        "mimeType": "text/csv",
                        "body": {
                            "data": base64.urlsafe_b64encode(b"ticker,call\nSPY,Long\n").decode("ascii")
                        },
                    }
                ],
            },
        }
        now = datetime(2026, 7, 15, 12, tzinfo=timezone.utc)
        s3_client = MagicMock()

        with patch.object(ingestor, "get_message_metadata", return_value=message), patch.object(
            ingestor, "get_message", return_value=message
        ), patch.object(
            ingestor, "utc_now", return_value=now
        ), patch.object(ingestor, "s3", s3_client):
            result = ingestor.process_message("token", "me", "gmail-crash", table)

        self.assertEqual(result["stored"][0]["filename"], "report.csv")
        self.assertEqual(s3_client.put_object.call_count, 1)
        self.assertEqual(table.items[("gmail-crash", "inline-file")]["status"], "UNSUPPORTED")
        self.assertEqual(
            table.items[("gmail-crash", ingestor.MESSAGE_LEDGER_ATTACHMENT_ID)]["status"],
            "MESSAGE_PROCESSED",
        )

    def test_recent_in_progress_attachment_does_not_write_message_sentinel(self):
        table = FakeLedgerTable(
            [
                {
                    "messageId": "gmail-active",
                    "attachmentId": "inline-file",
                    "status": "IN_PROGRESS",
                    "filename": "report.csv",
                    "mimeType": "text/csv",
                    "reportType": "unknown",
                    "subject": "Hedgeye report",
                    "sender": "sender@example.com",
                    "createdAt": "2026-07-15T11:55:00+00:00",
                    "updatedAt": "2026-07-15T11:55:00+00:00",
                }
            ]
        )
        message = {
            "internalDate": "1784120400000",
            "payload": {
                "headers": [{"name": "Subject", "value": "Hedgeye report"}],
                "parts": [
                    {
                        "partId": "file",
                        "filename": "report.csv",
                        "mimeType": "text/csv",
                        "body": {
                            "data": base64.urlsafe_b64encode(b"ticker\nSPY\n").decode("ascii")
                        },
                    }
                ],
            },
        }
        now = datetime(2026, 7, 15, 12, tzinfo=timezone.utc)
        s3_client = MagicMock()

        with patch.object(ingestor, "get_message_metadata", return_value=message), patch.object(
            ingestor, "get_message", return_value=message
        ), patch.object(
            ingestor, "utc_now", return_value=now
        ), patch.object(ingestor, "s3", s3_client):
            result = ingestor.process_message("token", "me", "gmail-active", table)

        self.assertEqual(result["skipped"][0]["detail"], "already-processed")
        self.assertEqual(s3_client.put_object.call_count, 0)
        self.assertNotIn(
            ("gmail-active", ingestor.MESSAGE_LEDGER_ATTACHMENT_ID), table.items
        )

    def test_textract_error_attachment_is_immediately_retryable(self):
        table = FakeLedgerTable(
            [
                {
                    "messageId": "gmail-pdf-error",
                    "attachmentId": "attachment-pdf",
                    "status": "TEXTRACT_ERROR",
                    "filename": "signal-strength.pdf",
                    "mimeType": "application/pdf",
                    "reportType": "signal-strength",
                    "updatedAt": "2026-07-15T11:59:00+00:00",
                }
            ]
        )

        claimed = ingestor.claim_attachment(
            table,
            message_id="gmail-pdf-error",
            attachment_id="attachment-pdf",
            headers={"subject": "Signal Strength"},
            filename="signal-strength.pdf",
            mime_type="application/pdf",
            report_type="signal-strength",
        )

        self.assertTrue(claimed)
        self.assertEqual(
            table.items[("gmail-pdf-error", "attachment-pdf")]["status"],
            "IN_PROGRESS",
        )

    def test_error_reclaim_preserves_immutable_artifact_evidence(self):
        evidence = {
            "s3Bucket": "immutable-artifacts",
            "s3Key": "messages/risk.html",
            "contentSha256": "a" * 64,
            "byteSize": 1234,
            "receivedAt": "2026-07-15T11:58:00+00:00",
            "s3ArtifactCreated": True,
        }
        table = FakeLedgerTable(
            [
                {
                    "messageId": "gmail-risk-error",
                    "attachmentId": "message-body-html-0",
                    "status": "ERROR",
                    "filename": "message-body.html",
                    "mimeType": "text/html",
                    "reportType": "risk-ranges",
                    "createdAt": "2026-07-15T11:58:01+00:00",
                    "updatedAt": "2026-07-15T11:59:00+00:00",
                    "error": "old failure",
                    "errorCode": "RISK_RANGE_TRANSACTION_WRITE_FAILED",
                    **evidence,
                }
            ]
        )

        claimed = ingestor.claim_attachment(
            table,
            message_id="gmail-risk-error",
            attachment_id="message-body-html-0",
            headers={"subject": "Risk Ranges"},
            filename="message-body.html",
            mime_type="text/html",
            report_type="risk-ranges",
        )

        self.assertTrue(claimed)
        reclaimed = table.items[("gmail-risk-error", "message-body-html-0")]
        self.assertEqual(reclaimed["status"], "IN_PROGRESS")
        self.assertNotIn("error", reclaimed)
        self.assertNotIn("errorCode", reclaimed)
        for key, value in evidence.items():
            self.assertEqual(reclaimed[key], value)

    def test_stale_pdf_projection_stage_is_reclaimed_but_active_stage_is_not(self):
        now = datetime(2026, 7, 15, 12, tzinfo=timezone.utc)
        stale_evidence = {
            "s3Bucket": "immutable-artifacts",
            "s3Key": "pdf/the-call.pdf",
            "contentSha256": "b" * 64,
            "byteSize": 5678,
            "receivedAt": "2026-07-15T09:59:00+00:00",
            "s3ArtifactCreated": True,
        }
        stale = FakeLedgerTable(
            [
                {
                    "messageId": "gmail-pdf-stale",
                    "attachmentId": "attachment-pdf",
                    "status": "VALIDATED",
                    "filename": "the-call.pdf",
                    "mimeType": "application/pdf",
                    "reportType": "the-call",
                    "createdAt": "2026-07-15T09:00:00+00:00",
                    "updatedAt": "2026-07-15T10:00:00+00:00",
                    **stale_evidence,
                }
            ]
        )
        active = FakeLedgerTable(
            [
                {
                    "messageId": "gmail-pdf-active",
                    "attachmentId": "attachment-pdf",
                    "status": "PARSED",
                    "filename": "the-call.pdf",
                    "mimeType": "application/pdf",
                    "reportType": "the-call",
                    "createdAt": "2026-07-15T11:30:00+00:00",
                    "updatedAt": "2026-07-15T11:30:00+00:00",
                }
            ]
        )

        with patch.object(ingestor, "utc_now", return_value=now):
            self.assertTrue(
                ingestor.claim_attachment(
                    stale,
                    message_id="gmail-pdf-stale",
                    attachment_id="attachment-pdf",
                    headers={"subject": "The Call"},
                    filename="the-call.pdf",
                    mime_type="application/pdf",
                    report_type="the-call",
                )
            )
            self.assertFalse(
                ingestor.claim_attachment(
                    active,
                    message_id="gmail-pdf-active",
                    attachment_id="attachment-pdf",
                    headers={"subject": "The Call"},
                    filename="the-call.pdf",
                    mime_type="application/pdf",
                    report_type="the-call",
                )
            )

        self.assertEqual(
            stale.items[("gmail-pdf-stale", "attachment-pdf")]["status"],
            "IN_PROGRESS",
        )
        for key, value in stale_evidence.items():
            self.assertEqual(
                stale.items[("gmail-pdf-stale", "attachment-pdf")][key],
                value,
            )
        self.assertEqual(
            active.items[("gmail-pdf-active", "attachment-pdf")]["status"],
            "PARSED",
        )

    def test_stale_in_progress_reclaim_preserves_immutable_artifact_evidence(self):
        now = datetime(2026, 7, 15, 12, tzinfo=timezone.utc)
        evidence = {
            "s3Bucket": "immutable-artifacts",
            "s3Key": "messages/risk.html",
            "contentSha256": "c" * 64,
            "byteSize": 4321,
            "receivedAt": "2026-07-15T11:00:00+00:00",
            "s3ArtifactCreated": False,
        }
        table = FakeLedgerTable(
            [
                {
                    "messageId": "gmail-stale-html",
                    "attachmentId": "message-body-html-0",
                    "status": "IN_PROGRESS",
                    "filename": "message-body.html",
                    "mimeType": "text/html",
                    "reportType": "risk-ranges",
                    "createdAt": "2026-07-15T10:00:00+00:00",
                    "updatedAt": "2026-07-15T10:00:00+00:00",
                    **evidence,
                }
            ]
        )

        with patch.object(ingestor, "utc_now", return_value=now):
            claimed = ingestor.claim_attachment(
                table,
                message_id="gmail-stale-html",
                attachment_id="message-body-html-0",
                headers={"subject": "Risk Ranges"},
                filename="message-body.html",
                mime_type="text/html",
                report_type="risk-ranges",
            )

        self.assertTrue(claimed)
        reclaimed = table.items[("gmail-stale-html", "message-body-html-0")]
        self.assertEqual(reclaimed["status"], "IN_PROGRESS")
        for key, value in evidence.items():
            self.assertEqual(reclaimed[key], value)

    def test_html_body_is_added_once_when_message_has_an_attachment(self):
        table = FakeLedgerTable()
        message = {
            "internalDate": "1784120400000",
            "payload": {
                "headers": [
                    {"name": "Subject", "value": "Hedgeye daily summary"},
                    {"name": "From", "value": "sender@example.com"},
                ],
                "parts": [
                    {
                        "partId": "file",
                        "filename": "report.csv",
                        "mimeType": "text/csv",
                        "body": {
                            "data": base64.urlsafe_b64encode(b"ticker\nSPY\n").decode("ascii")
                        },
                    },
                    {
                        "partId": "body",
                        "filename": "",
                        "mimeType": "text/html",
                        "body": {
                            "data": base64.urlsafe_b64encode(b"<html><body>Summary</body></html>").decode("ascii")
                        },
                    },
                ],
            },
        }
        s3_client = MagicMock()

        with patch.object(ingestor, "get_message_metadata", return_value=message), patch.object(
            ingestor, "get_message", return_value=message
        ), patch.object(
            ingestor, "s3", s3_client
        ), patch.object(ingestor, "parse_html_snapshot", return_value=None), patch.object(
            ingestor, "persist_snapshot_failure"
        ) as persist_failure:
            result = ingestor.process_message("token", "me", "gmail-with-body", table)

        self.assertEqual(result["attachmentCount"], 2)
        self.assertEqual(
            {item["filename"] for item in result["stored"]},
            {"report.csv", "message-body.html"},
        )
        self.assertEqual(s3_client.put_object.call_count, 2)
        body_items = [
            item
            for (message_id, _), item in table.items.items()
            if message_id == "gmail-with-body" and item.get("filename") == "message-body.html"
        ]
        self.assertEqual(len(body_items), 1)
        persist_failure.assert_called_once()

    def test_new_html_parse_or_materialization_exception_is_never_stored(self):
        message = {
            "internalDate": "1784120400000",
            "payload": {
                "headers": [
                    {"name": "Subject", "value": "ETF Pro Plus - New Weekly Report"},
                    {"name": "From", "value": "sender@example.com"},
                ],
                "mimeType": "text/html",
                "body": {
                    "data": base64.urlsafe_b64encode(
                        b"<html><body>ETF Pro source</body></html>"
                    ).decode("ascii")
                },
            },
        }

        scenarios = (
            ("parse", RuntimeError("parser exploded")),
            ("materialize", RuntimeError("projection write failed")),
            ("no-snapshot", None),
        )
        for failure_stage, failure in scenarios:
            with self.subTest(failure_stage=failure_stage):
                table = FakeLedgerTable()
                s3_client = MagicMock()
                if failure_stage == "parse":
                    parser_result = failure
                elif failure_stage == "no-snapshot":
                    parser_result = None
                else:
                    parser_result = etf_full_book_snapshot(
                        f"gmail-{failure_stage}",
                        "2026-07-15T13:00:00+00:00",
                    )
                materialization_result = (
                    failure if failure_stage == "materialize" else MagicMock()
                )

                with patch.object(ingestor, "get_message_metadata", return_value=message), patch.object(
                    ingestor, "get_message", return_value=message
                ), patch.object(
                    ingestor, "s3", s3_client
                ), patch.object(
                    ingestor,
                    "parse_html_snapshot",
                    side_effect=parser_result if isinstance(parser_result, Exception) else None,
                    return_value=None if isinstance(parser_result, Exception) else parser_result,
                ), patch.object(
                    ingestor, "persist_research_event_ledger", return_value=1
                ), patch.object(
                    ingestor, "persist_snapshot_intelligence", return_value=1
                ), patch.object(
                    ingestor, "finalize_snapshot_intelligence"
                ) as finalize_intelligence, patch.object(
                    ingestor,
                    "persist_snapshot_failure",
                ), patch.object(
                    ingestor,
                    "materialize_email_snapshot",
                    side_effect=materialization_result if isinstance(materialization_result, Exception) else None,
                ):
                    with self.assertRaises(ingestor.RetryableResearchMaterializationError):
                        ingestor.process_message(
                            "token",
                            "me",
                            f"gmail-{failure_stage}",
                            table,
                        )
                    finalize_intelligence.assert_not_called()

                item = table.items[(f"gmail-{failure_stage}", "message-body-html-0")]
                self.assertEqual(item["status"], "ERROR")
                self.assertEqual(item["materializationStatus"], "ERROR")
                self.assertEqual(item["errorCode"], "GMAIL_RESEARCH_MATERIALIZATION_ERROR")
                self.assertTrue(item["retryable"])
                self.assertEqual(item["s3Bucket"], ingestor.S3_BUCKET)
                self.assertTrue(item["s3Key"])
                self.assertEqual(len(item["contentSha256"]), 64)
                self.assertTrue(item["receivedAt"])
                self.assertNotIn(
                    (f"gmail-{failure_stage}", ingestor.MESSAGE_LEDGER_ATTACHMENT_ID),
                    table.items,
                )
                self.assertEqual(s3_client.put_object.call_count, 1)

    def test_legacy_stored_materialization_error_becomes_nonterminal_retryable_error(self):
        table = FakeLedgerTable(
            [
                {
                    "messageId": "gmail-materialize-retry",
                    "attachmentId": "message-body-html-0",
                    "status": "STORED",
                    "filename": "message-body.html",
                    "mimeType": "text/html",
                    "reportType": "real-time-alert",
                    "subject": "Real-Time Alert: BUY Signal: SPY",
                    "sender": "sender@example.com",
                    "s3Bucket": "test-bucket",
                    "s3Key": "hedgeye-email/messages/rta.html",
                    "contentSha256": hashlib.sha256(
                        b"<html><body>broken parser input</body></html>"
                    ).hexdigest(),
                    "createdAt": "2026-07-15T10:00:00+00:00",
                    "updatedAt": "2026-07-15T10:00:00+00:00",
                    "receivedAt": "2026-07-15T10:00:00+00:00",
                    "materializationAttemptVersion": ingestor.MATERIALIZED_DATA_VERSION,
                    "materializationAttemptCount": 2,
                    "materializationStatus": "ERROR",
                },
                {
                    "messageId": "gmail-materialize-retry",
                    "attachmentId": ingestor.MESSAGE_LEDGER_ATTACHMENT_ID,
                    "status": "MESSAGE_PROCESSED",
                    "attachmentCount": 1,
                    "createdAt": "2026-07-15T10:01:00+00:00",
                }
            ]
        )
        body = MagicMock()
        body.read.return_value = b"<html><body>broken parser input</body></html>"
        s3_client = MagicMock()
        s3_client.get_object.return_value = {"Body": body}

        with patch.object(ingestor, "s3", s3_client), patch.object(
            ingestor, "parse_html_snapshot", side_effect=RuntimeError("parse failed")
        ), patch.object(
            ingestor,
            "get_message_metadata",
            return_value={
                "payload": {
                    "headers": [
                        {"name": "Subject", "value": "Real-Time Alert: BUY Signal: SPY"}
                    ]
                }
            },
        ), patch.object(
            ingestor,
            "get_message",
            return_value={
                "internalDate": "1784120400000",
                "payload": {
                    "headers": [
                        {"name": "Subject", "value": "Real-Time Alert: BUY Signal: SPY"}
                    ],
                    "body": {
                        "data": base64.urlsafe_b64encode(
                            b"<html><body>broken parser input</body></html>"
                        ).decode("ascii")
                    },
                    "mimeType": "text/html",
                },
            },
        ) as get_message:
            with self.assertRaises(ingestor.RetryableResearchMaterializationError):
                ingestor.process_message("token", "me", "gmail-materialize-retry", table)

        get_message.assert_called_once()
        self.assertEqual(s3_client.get_object.call_count, 1)
        item = table.items[("gmail-materialize-retry", "message-body-html-0")]
        self.assertEqual(item["materializationAttemptCount"], 3)
        self.assertEqual(item["materializationStatus"], "ERROR")
        self.assertEqual(item["status"], "ERROR")
        self.assertEqual(item["errorCode"], "GMAIL_RESEARCH_MATERIALIZATION_ERROR")
        self.assertTrue(item["retryable"])
        self.assertFalse(ingestor._should_backfill_materialized_snapshot(item))

    def test_prior_version_backfill_requires_explicit_migration(self):
        old_version = "gmail-materialized-v3-security-intelligence"
        table = FakeLedgerTable(
            [
                {
                    "messageId": "gmail-canonical-upgrade",
                    "attachmentId": "message-body-html-0",
                    "status": "INDEXED",
                    "filename": "message-body.html",
                    "mimeType": "text/html",
                    "reportType": "real-time-alert",
                    "snapshotType": "real-time-alert",
                    "subject": "Real-Time Alert: BUY Signal: SPY",
                    "sender": "sender@example.com",
                    "s3Bucket": "test-bucket",
                    "s3Key": "hedgeye-email/messages/rta.html",
                    "createdAt": "2026-07-15T10:00:00+00:00",
                    "updatedAt": "2026-07-15T10:00:00+00:00",
                    "receivedAt": "2026-07-15T10:00:00+00:00",
                    "materializationAttemptVersion": old_version,
                    "materializationAttemptCount": 1,
                    "materializationStatus": "INDEXED",
                },
                {
                    "messageId": "gmail-canonical-upgrade",
                    "attachmentId": ingestor.MESSAGE_LEDGER_ATTACHMENT_ID,
                    "status": "MESSAGE_PROCESSED",
                    "attachmentCount": 1,
                    "createdAt": "2026-07-15T10:01:00+00:00",
                },
            ]
        )

        with patch.object(
            ingestor,
            "backfill_html_snapshot",
            return_value=True,
        ) as backfill:
            scheduled_result = ingestor.process_message(
                "token",
                "me",
                "gmail-canonical-upgrade",
                table,
            )
            migration_result = ingestor.process_message(
                "token",
                "me",
                "gmail-canonical-upgrade",
                table,
                allow_version_backfill=True,
            )

        backfill.assert_called_once()
        self.assertEqual(
            scheduled_result["skipped"],
            [{"filename": "message-body.html", "detail": "already-processed"}],
        )
        self.assertEqual(
            migration_result["stored"],
            [{"filename": "message-body.html", "detail": "snapshot-backfilled"}],
        )

    def test_current_materialization_with_older_entity_parser_requires_operator_replay(self):
        item = {
            "status": "INDEXED",
            "attachmentId": "message-body-html-0",
            "mimeType": "text/html",
            "filename": "message-body.html",
            "subject": "Crypto Quant",
            "reportType": "crypto-quant",
            "snapshotType": "bitcoin-trend-tracker",
            "s3Bucket": "test-bucket",
            "s3Key": "immutable/crypto.html",
            "materializationAttemptVersion": ingestor.MATERIALIZED_DATA_VERSION,
            "materializationStatus": "INDEXED",
            "researchParserVersion": ingestor.RESEARCH_PARSER_VERSION,
            "securityIntelligenceParserVersion": (
                "security-intelligence-v3-tracker-contract"
            ),
        }

        self.assertFalse(
            ingestor._should_backfill_materialized_snapshot(
                item,
                allow_version_upgrade=False,
            )
        )
        self.assertTrue(
            ingestor._should_backfill_materialized_snapshot(
                item,
                allow_version_upgrade=True,
            )
        )

    def test_operator_batch_identity_and_terminal_rotation_are_parser_versioned(self):
        kwargs = {
            "cursor_before": "history-1",
            "pending_history_id": None,
            "poll_mode": "operator_replay",
            "force_backfill": True,
        }
        current_batch = ingestor._queue_batch_id((), **kwargs)
        with patch.object(
            ingestor,
            "SECURITY_INTELLIGENCE_PARSER_VERSION",
            "security-intelligence-v3-tracker-contract",
        ):
            prior_batch = ingestor._queue_batch_id((), **kwargs)

        queue = [
            {
                "gmailMessageId": "abcdef0123456789",
                "status": "COMPLETED",
            }
        ]
        self.assertNotEqual(current_batch, prior_batch)
        self.assertTrue(
            ingestor.operator_batch_requires_contract_rotation(
                prior_batch,
                current_batch,
                queue,
                ["abcdef0123456789"],
            )
        )
        self.assertFalse(
            ingestor.operator_batch_requires_contract_rotation(
                current_batch,
                current_batch,
                queue,
                ["abcdef0123456789"],
            )
        )
        self.assertFalse(
            ingestor.operator_terminal_batch_matches(
                [*queue, {"gmailMessageId": "extra", "status": "COMPLETED"}],
                ["abcdef0123456789"],
            )
        )

    def test_operator_version_replay_uses_only_immutable_ledger_html(self):
        message_id = "abcdef0123456789"
        table = FakeLedgerTable(
            [
                {
                    "messageId": message_id,
                    "attachmentId": "message-body-html-0",
                    "status": "ERROR",
                    "filename": "message-body.html",
                    "mimeType": "text/html",
                    "reportType": "momo-tracker",
                    "subject": "MOMO Trend Tracker",
                    "sender": "sender@example.com",
                    "s3Bucket": "test-bucket",
                    "s3Key": "immutable/momo.html",
                    "contentSha256": "a" * 64,
                    "receivedAt": "2026-08-13T10:00:00+00:00",
                    "materializationAttemptVersion": "gmail-materialized-v7-market-structure-archive",
                    "materializationAttemptCount": 3,
                    "materializationStatus": "ERROR",
                }
            ]
        )

        with patch.object(
            ingestor, "backfill_html_snapshot", return_value=True
        ) as backfill, patch.object(
            ingestor, "get_message_metadata"
        ) as get_metadata, patch.object(
            ingestor, "get_message"
        ) as get_message:
            result = ingestor.process_message(
                "token",
                "me",
                message_id,
                table,
                allow_version_backfill=True,
            )

        self.assertEqual(
            result["stored"],
            [{"filename": "message-body.html", "detail": "snapshot-backfilled"}],
        )
        backfill.assert_called_once()
        self.assertTrue(backfill.call_args.kwargs["replace_entity_projection"])
        get_metadata.assert_not_called()
        get_message.assert_not_called()

    def test_operator_replay_rejects_arbitrary_ids_and_wrong_versions(self):
        valid = {
            "source": ingestor.OPERATOR_REPLAY_SOURCE,
            "messageIds": ["abcdef0123456789"],
            "forceBackfill": True,
            "materializationVersion": ingestor.MATERIALIZED_DATA_VERSION,
        }
        self.assertEqual(
            ingestor.operator_replay_message_ids(valid),
            ["abcdef0123456789"],
        )
        invalid_events = (
            {**valid, "messageIds": ["operator-supplied-id"]},
            {**valid, "materializationVersion": "wrong-version"},
            {**valid, "unexpected": True},
            {**valid, "messageIds": ["abcdef0123456789"] * 2},
        )
        for event in invalid_events:
            with self.subTest(event=event), self.assertRaises(
                ingestor.GmailOperatorReplayError
            ):
                ingestor.operator_replay_message_ids(event)

    def test_scheduled_invocation_cannot_request_force_backfill(self):
        database = FakeRuntimeDynamoDb(FakeLedgerTable())
        with patch.object(ingestor, "dynamodb", database), patch.object(
            ingestor, "cloudwatch", MagicMock()
        ), patch.object(ingestor, "load_oauth_secret") as load_secret:
            response = ingestor.lambda_handler(
                {
                    "source": "aws-scheduler",
                    "scheduleId": ingestor.GMAIL_SCHEDULE_ID,
                    "forceBackfill": True,
                },
                None,
            )

        self.assertEqual(response["statusCode"], 400)
        self.assertEqual(
            json.loads(response["body"])["errorCode"],
            "GMAIL_OPERATOR_REPLAY_INVALID",
        )
        load_secret.assert_not_called()

    def test_archived_source_hash_drift_fails_before_parser_execution(self):
        message_id = "abcdef0123456789"
        item = {
            "messageId": message_id,
            "attachmentId": "message-body-html-0",
            "status": "ERROR",
            "filename": "message-body.html",
            "mimeType": "text/html",
            "reportType": "real-time-alert",
            "subject": "Real-Time Alert: BUY Signal: SPY",
            "s3Bucket": "test-bucket",
            "s3Key": "immutable/rta.html",
            "contentSha256": hashlib.sha256(b"original").hexdigest(),
            "receivedAt": "2026-08-13T10:00:00+00:00",
            "materializationAttemptVersion": "gmail-materialized-v7-market-structure-archive",
            "materializationAttemptCount": 3,
            "materializationStatus": "ERROR",
        }
        table = FakeLedgerTable([item])
        body = MagicMock()
        body.read.return_value = b"changed"
        s3_client = MagicMock()
        s3_client.get_object.return_value = {"Body": body}

        with patch.object(ingestor, "s3", s3_client), patch.object(
            ingestor, "parse_html_snapshot"
        ) as parser, patch.object(
            ingestor, "persist_snapshot_failure"
        ):
            with self.assertRaises(ingestor.RetryableResearchMaterializationError):
                ingestor.backfill_html_snapshot(
                    table=table,
                    message_id=message_id,
                    attachment_id="message-body-html-0",
                    report_type="real-time-alert",
                    mime_type="text/html",
                    received_at=datetime(2026, 8, 13, 10, tzinfo=timezone.utc),
                    ledger_item=item,
                )

        parser.assert_not_called()
        failed = table.items[(message_id, "message-body-html-0")]
        self.assertEqual(failed["errorCode"], "GMAIL_IMMUTABLE_ARTIFACT_DRIFT")

    def test_retry_reclassifies_from_original_report_after_target_snapshot_was_recorded(self):
        message_id = "abcdef0123456789"
        archived_body = b"<html><body>Crypto Quant tracker</body></html>"
        item = {
            "messageId": message_id,
            "attachmentId": "message-body-html-0",
            "status": "ERROR",
            "filename": "message-body.html",
            "mimeType": "text/html",
            "reportType": "crypto-quant",
            "snapshotType": "bitcoin-trend-tracker",
            "subject": "Crypto Quant",
            "s3Bucket": "test-bucket",
            "s3Key": "immutable/crypto.html",
            "contentSha256": hashlib.sha256(archived_body).hexdigest(),
            "receivedAt": "2026-08-13T10:00:00+00:00",
            "materializationAttemptVersion": ingestor.MATERIALIZED_DATA_VERSION,
            "materializationAttemptCount": 1,
            "materializationStatus": "ERROR",
        }
        table = FakeLedgerTable([item])
        body = MagicMock()
        body.read.return_value = archived_body
        s3_client = MagicMock()
        s3_client.get_object.return_value = {"Body": body}
        snapshot = {
            "date": "2026-08-13",
            "reportType": "crypto-quant",
            "snapshotType": "bitcoin-trend-tracker",
            "source": "gmail",
        }

        with patch.object(ingestor, "s3", s3_client), patch.object(
            ingestor, "dynamodb", MagicMock()
        ), patch.object(
            ingestor, "parse_html_snapshot", return_value=snapshot
        ), patch.object(
            ingestor, "persist_research_event_ledger", return_value=0
        ), patch.object(
            ingestor, "persist_snapshot_intelligence", return_value=1
        ), patch.object(
            ingestor, "materialize_email_snapshot", return_value=({}, False)
        ), patch.object(
            ingestor, "finalize_snapshot_intelligence"
        ), patch.object(
            ingestor, "reclassify_manifest_artifact"
        ) as reclassify:
            backfilled = ingestor.backfill_html_snapshot(
                table=table,
                message_id=message_id,
                attachment_id="message-body-html-0",
                report_type="crypto-quant",
                mime_type="text/html",
                received_at=datetime(2026, 8, 13, 10, tzinfo=timezone.utc),
                ledger_item=item,
                replace_entity_projection=True,
            )

        self.assertTrue(backfilled)
        reclassify.assert_called_once()
        self.assertEqual(
            reclassify.call_args.kwargs["source_product_id"],
            "crypto-quant",
        )

    def test_textract_content_claim_is_shared_by_content_hash(self):
        table = FakeLedgerTable()
        digest = "a" * 64

        claimed, _ = ingestor.claim_textract_content(
            table,
            content_sha256=digest,
            report_type="early-look",
            message_id="gmail-1",
            attachment_id="attachment-1",
            s3_key="hedgeye-uploads/early-look/one.pdf",
        )
        ingestor.mark_textract_content(
            table,
            content_sha256=digest,
            status="TEXTRACT_DISPATCHED",
        )
        duplicate_claimed, existing = ingestor.claim_textract_content(
            table,
            content_sha256=digest,
            report_type="early-look",
            message_id="gmail-2",
            attachment_id="attachment-2",
            s3_key="hedgeye-uploads/early-look/two.pdf",
        )

        self.assertTrue(claimed)
        self.assertFalse(duplicate_claimed)
        self.assertEqual(existing["sourceMessageId"], "gmail-1")
        self.assertEqual(existing["status"], "TEXTRACT_DISPATCHED")

    def test_duplicate_pdf_content_does_not_issue_second_s3_put(self):
        content = b"%PDF-1.7 same document"
        attachment = {
            "attachmentId": "attachment-1",
            "filename": "early-look.pdf",
            "mimeType": "application/pdf",
            "inlineData": base64.urlsafe_b64encode(content).decode("ascii"),
        }
        s3_client = MagicMock()
        first_claim = {
            "status": "TEXTRACT_PENDING",
            "sourceMessageId": "gmail-1",
            "sourceAttachmentId": "attachment-1",
            "s3Bucket": ingestor.S3_BUCKET,
            "s3Key": "hedgeye-uploads/early-look/first.pdf",
        }
        existing_claim = {**first_claim, "status": "TEXTRACT_DISPATCHED"}

        with patch.object(ingestor, "claim_attachment", return_value=True), patch.object(
            ingestor, "claim_textract_content", side_effect=[(True, first_claim), (False, existing_claim)]
        ), patch.object(ingestor, "mark_textract_content"), patch.object(
            ingestor, "mark_attachment"
        ), patch.object(
            ingestor, "dispatch_pdf_processor"
        ), patch.object(ingestor, "s3", s3_client):
            first = ingestor.upload_attachment(
                access_token="token",
                user_id="me",
                message_id="gmail-1",
                attachment=attachment,
                headers={"subject": "Early Look"},
                received_at=datetime(2026, 7, 15, tzinfo=timezone.utc),
                table=MagicMock(),
            )
            duplicate = ingestor.upload_attachment(
                access_token="token",
                user_id="me",
                message_id="gmail-2",
                attachment={**attachment, "attachmentId": "attachment-2"},
                headers={"subject": "Early Look"},
                received_at=datetime(2026, 7, 15, tzinfo=timezone.utc),
                table=MagicMock(),
            )

        self.assertEqual(first[0], "stored")
        self.assertEqual(duplicate, ("skipped", "duplicate-pdf-content"))
        self.assertEqual(s3_client.put_object.call_count, 1)
        self.assertTrue(first[1].startswith("hedgeye-uploads/"))

    def test_immutable_s3_retry_reuses_matching_object_without_new_version(self):
        content = b"same immutable Gmail artifact"
        digest = ingestor.hashlib.sha256(content).hexdigest()
        s3_client = MagicMock()
        s3_client.put_object.side_effect = ClientError(
            {
                "Error": {
                    "Code": "PreconditionFailed",
                    "Message": "object already exists",
                },
                "ResponseMetadata": {"HTTPStatusCode": 412},
            },
            "PutObject",
        )
        s3_client.head_object.return_value = {
            "Metadata": {"content-sha256": digest},
        }

        with patch.object(ingestor, "s3", s3_client):
            created = ingestor.put_immutable_s3_object(
                bucket="test-bucket",
                key="hedgeye-email/messages/immutable.html",
                body=content,
                content_type="text/html",
                metadata={"content-sha256": digest},
                content_sha256=digest,
            )

        self.assertFalse(created)
        s3_client.put_object.assert_called_once()
        s3_client.head_object.assert_called_once_with(
            Bucket="test-bucket",
            Key="hedgeye-email/messages/immutable.html",
        )
        s3_client.get_object.assert_not_called()

    def test_market_structure_chart_archive_is_content_addressed_and_private(self):
        payload = market_situation_signal_png()
        digest = hashlib.sha256(payload).hexdigest()

        with patch.object(
            ingestor, "put_immutable_s3_object", return_value=True
        ) as put_immutable:
            archived = ingestor.archive_market_structure_chart(
                chart={"name": "signals.png", "url": "https://approved.example/chart.png"},
                payload=payload,
                content_type="image/png",
                extension="png",
                content_sha256=digest,
            )

        expected_key = f"{ingestor.MARKET_STRUCTURE_ASSET_PREFIX}{digest}.png"
        self.assertEqual(archived, {"id": digest, "s3Key": expected_key})
        put_immutable.assert_called_once_with(
            bucket=ingestor.S3_BUCKET,
            key=expected_key,
            body=payload,
            content_type="image/png",
            metadata={
                "source": "gmail-market-structure",
                "report-type": "market-structure",
                "content-sha256": digest,
            },
            content_sha256=digest,
        )

    def test_message_budget_is_checked_before_each_attachment(self):
        table = FakeLedgerTable()
        budget_check = MagicMock(
            side_effect=[None, None, None, "GMAIL_INVOCATION_NEAR_TIMEOUT"]
        )
        message = {
            "internalDate": "1784120400000",
            "payload": {
                "headers": [
                    {"name": "Subject", "value": "Hedgeye report"},
                ],
                "parts": [{
                    "partId": "1",
                    "filename": "report.pdf",
                    "mimeType": "application/pdf",
                    "body": {
                        "attachmentId": "attachment-1",
                        "size": 100,
                    },
                }],
            },
        }

        with patch.object(
            ingestor, "get_message_metadata", return_value=message
        ), patch.object(
            ingestor, "get_message", return_value=message
        ) as get_message, patch.object(
            ingestor, "upload_attachment"
        ) as upload_attachment:
            with self.assertRaises(
                ingestor.GmailInvocationBudgetYield
            ) as raised:
                ingestor.process_message(
                    "token",
                    "me",
                    "gmail-budget",
                    table,
                    budget_check=budget_check,
                )

        self.assertEqual(
            raised.exception.error_code,
            "GMAIL_INVOCATION_NEAR_TIMEOUT",
        )
        get_message.assert_called_once()
        upload_attachment.assert_not_called()
        self.assertEqual(budget_check.call_count, 4)


if __name__ == "__main__":
    unittest.main()
