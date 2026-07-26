#!/usr/bin/env python3
"""Focused cost-containment tests for the Hermes Gmail ingestor."""

from __future__ import annotations

import base64
import json
import os
import sys
import unittest
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import MagicMock, patch

os.environ.setdefault("AWS_EC2_METADATA_DISABLED", "true")
sys.path.insert(
    0,
    str(Path(__file__).resolve().parents[1] / "lambdas" / "gmail_ingestor"),
)

from botocore.exceptions import ClientError

import hermes_gmail_ingestor as ingestor


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

    def get_item(self, *, Key):
        return {"Item": deepcopy(self.items.get((Key["date"], Key["snapshotType"]))) }

    def put_item(self, *, Item, **_kwargs):
        self.put_count += 1
        self.items[(Item["date"], Item["snapshotType"])] = deepcopy(Item)
        return {}


class FakeDynamoDb:
    def __init__(self, table) -> None:
        self.table = table

    def Table(self, name):
        if name != "HedgeyeDailySnapshot":
            raise AssertionError(f"unexpected table: {name}")
        return self.table


class FakeWriteTable:
    def __init__(self) -> None:
        self.writes = []

    def put_item(self, *, Item, **_kwargs):
        self.writes.append(deepcopy(Item))
        return {}


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


class FakeEventDynamoDb:
    def __init__(self) -> None:
        self.table = FakeImmutableEventTable()

    def Table(self, name):
        if name != ingestor.RESEARCH_EVENT_LEDGER_TABLE:
            raise AssertionError(f"unexpected table: {name}")
        return self.table


class FakeTransactionClient:
    def __init__(self) -> None:
        self.transactions = []

    def transact_write_items(self, *, TransactItems):
        self.transactions.append(deepcopy(TransactItems))
        return {}


class FakeRiskRangeDynamoDb:
    def __init__(self) -> None:
        self.tables = {
            "HedgeyeDailySnapshot": FakeWriteTable(),
            "HedgeyeRiskRanges": FakeWriteTable(),
            "RiskRangeData": FakeWriteTable(),
        }
        self.meta = type("Meta", (), {"client": FakeTransactionClient()})()

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
            allows_error_retry = existing.get("status") in {"ERROR", "TEXTRACT_ERROR"}
            if not allows_error_retry and not allows_cas_reclaim:
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


class HermesGmailIngestorTests(unittest.TestCase):
    def tearDown(self) -> None:
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
        ):
            response = ingestor.lambda_handler({
                "source": "aws-scheduler",
                "scheduleId": ingestor.GMAIL_SCHEDULE_ID,
            }, None)

        body = json.loads(response["body"])
        list_messages.assert_not_called()
        self.assertEqual(body["pollMode"], "history")
        self.assertEqual(body["messageCount"], 0)
        self.assertEqual(database.heartbeat.writes[-1]["status"], "success")
        self.assertEqual(database.heartbeat.writes[-1]["serviceId"], ingestor.GMAIL_SERVICE_ID)
        self.assertEqual(database.heartbeat.writes[-1]["triggerSource"], "aws-scheduler")

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
        ), patch.object(ingestor, "load_oauth_secret", return_value=secret), patch.object(
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

    def test_history_listing_drains_more_than_the_old_500_message_limit(self):
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
            message_ids = ingestor.list_history_message_ids(
                "access",
                "me",
                "100",
                label_id="Label_1",
            )

        self.assertEqual(len(message_ids), 625)
        self.assertEqual(message_ids[0], "m-0000")
        self.assertEqual(message_ids[-1], "m-0624")
        self.assertEqual(request.call_count, 2)
        self.assertEqual(request.call_args_list[1].kwargs["params"]["pageToken"], "page-2")

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

        def process(_token, _user_id, message_id, _table):
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
        self.assertEqual(response["statusCode"], 207)
        self.assertEqual(body["status"], "PARTIAL_ERROR")
        self.assertIsNone(body["historyId"])
        self.assertEqual(
            body["errors"],
            [{
                "messageId": "gmail-bad-materialization",
                "error": "Research parse/materialization failed: parser exploded",
                "errorCode": "GMAIL_RESEARCH_MATERIALIZATION_ERROR",
                "retryable": True,
            }],
        )
        get_profile_history_id.assert_not_called()
        write_ingestion_state.assert_not_called()
        self.assertEqual(database.heartbeat.writes[-1]["status"], "error")
        self.assertEqual(
            database.heartbeat.writes[-1]["errorCode"],
            "GMAIL_RESEARCH_MATERIALIZATION_ERROR",
        )

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
        second = ingestor.persist_research_event_ledger(snapshot, database, content_sha256="a" * 64)

        self.assertEqual(first, 1)
        self.assertEqual(second, 0)
        event = next(iter(database.table.items.values()))
        self.assertEqual(event["productKey"], "real-time-alert")
        self.assertEqual(event["parserVersion"], ingestor.RESEARCH_PARSER_VERSION)
        self.assertTrue(event["immutable"])

        corrected = rta_snapshot("gmail-rta", "2026-07-15T16:00:00+00:00", "SELL")
        with self.assertRaisesRegex(RuntimeError, "RESEARCH_EVENT_CONFLICT"):
            ingestor.persist_research_event_ledger(corrected, database, content_sha256="b" * 64)

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

    def test_primary_risk_ranges_and_completion_manifest_are_one_transaction(self):
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
            ["HedgeyeRiskRanges", "RiskRangeData", "RiskRangePublicationManifestsV2"],
        )
        self.assertEqual(database.tables["HedgeyeRiskRanges"].writes, [])

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

    def test_malformed_risk_range_is_rejected_instead_of_coercing_to_zero(self):
        database = FakeRiskRangeDynamoDb()
        snapshot = {
            "date": "2026-07-21",
            "snapshotType": "risk-ranges",
            "scrapedAt": "2026-07-21T12:00:00+00:00",
            "data": {"SPY": {"lrr": 0, "hrr": 0, "trend": "BULLISH"}},
        }

        with self.assertRaisesRegex(ValueError, "Invalid risk range"):
            ingestor.save_snapshot_to_dynamodb(snapshot, database)
        self.assertEqual(database.meta.client.transactions, [])

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

        with patch.object(ingestor, "get_message", return_value=message) as get_message, patch.object(
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

        with patch.object(ingestor, "get_message", return_value=message), patch.object(
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

        with patch.object(ingestor, "get_message", return_value=message), patch.object(
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

    def test_stale_pdf_projection_stage_is_reclaimed_but_active_stage_is_not(self):
        now = datetime(2026, 7, 15, 12, tzinfo=timezone.utc)
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
        self.assertEqual(
            active.items[("gmail-pdf-active", "attachment-pdf")]["status"],
            "PARSED",
        )

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

        with patch.object(ingestor, "get_message", return_value=message), patch.object(
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

                with patch.object(ingestor, "get_message", return_value=message), patch.object(
                    ingestor, "s3", s3_client
                ), patch.object(
                    ingestor,
                    "parse_html_snapshot",
                    side_effect=parser_result if isinstance(parser_result, Exception) else None,
                    return_value=None if isinstance(parser_result, Exception) else parser_result,
                ), patch.object(
                    ingestor, "persist_research_event_ledger", return_value=1
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

                item = table.items[(f"gmail-{failure_stage}", "message-body-html-0")]
                self.assertEqual(item["status"], "ERROR")
                self.assertEqual(item["materializationStatus"], "ERROR")
                self.assertEqual(item["errorCode"], "GMAIL_RESEARCH_MATERIALIZATION_ERROR")
                self.assertTrue(item["retryable"])
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


if __name__ == "__main__":
    unittest.main()
