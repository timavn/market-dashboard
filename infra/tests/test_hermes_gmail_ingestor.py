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
from decimal import Decimal
from pathlib import Path
from unittest.mock import MagicMock, patch

os.environ.setdefault("AWS_EC2_METADATA_DISABLED", "true")
sys.path.insert(
    0,
    str(Path(__file__).resolve().parents[1] / "lambdas" / "gmail_ingestor"),
)

from botocore.exceptions import ClientError
from boto3.dynamodb.types import TypeDeserializer

import hermes_gmail_ingestor as ingestor
import parse_hedgeye_email_html as email_parser


GMAIL_FIXTURE_DIR = Path(__file__).resolve().parent / "fixtures" / "gmail"


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
        deserializer = TypeDeserializer()
        for operation in TransactItems:
            put = operation["Put"]
            item = {
                key: deserializer.deserialize(value)
                for key, value in put["Item"].items()
            }
            self.tables[put["TableName"]].store_transaction_item(item)
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
                {"N": str(expected_order)},
            )
            self.assertEqual(
                put["Item"]["publicationOrder"],
                {"N": str(expected_order)},
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
        self.assertEqual(set(daily_snapshot["data"]["M"]), {"SPX"})
        self.assertEqual(daily_snapshot["riskRangeCount"], {"N": "1"})

    def test_conflicting_normalized_ticker_duplicates_fail_typed_before_any_write(self):
        database = FakeRiskRangeDynamoDb()
        snapshot = {
            "date": "2026-07-21",
            "snapshotType": "risk-ranges",
            "scrapedAt": "2026-07-21T12:00:00+00:00",
            "data": {
                "spx": {"lrr": 620.5, "hrr": 631.2, "trend": "BULLISH"},
                "SPX": {"lrr": 621.5, "hrr": 631.2, "trend": "BULLISH"},
            },
        }

        with self.assertRaises(email_parser.RiskRangeDuplicateConflictError) as raised:
            ingestor.save_snapshot_to_dynamodb(snapshot, database)

        self.assertEqual(
            raised.exception.error_code,
            "RISK_RANGE_DUPLICATE_TICKER_CONFLICT",
        )
        self.assertEqual(database.meta.client.transactions, [])
        self.assertTrue(all(not table.writes for table in database.tables.values()))

        wrapped = ingestor._retryable_materialization_error(raised.exception)
        self.assertEqual(
            wrapped.error_code,
            "RISK_RANGE_DUPLICATE_TICKER_CONFLICT",
        )

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
        self.assertTrue(all(not table.writes for table in database.tables.values()))

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

    def test_message_budget_is_checked_before_each_attachment(self):
        table = FakeLedgerTable()
        budget_check = MagicMock(
            side_effect=[None, None, "GMAIL_INVOCATION_NEAR_TIMEOUT"]
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
        self.assertEqual(budget_check.call_count, 3)


if __name__ == "__main__":
    unittest.main()
