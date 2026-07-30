#!/usr/bin/env python3
"""Safety and result-verification tests for the guarded Gmail backfill."""

from __future__ import annotations

import importlib.util
import io
import json
import os
import tempfile
import textwrap
import unittest
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from unittest import mock

from boto3.dynamodb.types import TypeSerializer


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "infra" / "scripts" / "run_gmail_backfill.py"
SPEC = importlib.util.spec_from_file_location("run_gmail_backfill", SCRIPT)
assert SPEC and SPEC.loader
backfill = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(backfill)
SERIALIZER = TypeSerializer()


def sso_config(path: Path) -> None:
    path.write_text(
        textwrap.dedent(
            """
            [profile market-dashboard-admin]
            sso_session = market-dashboard
            sso_account_id = 915328198276
            sso_role_name = AdministratorAccess
            region = us-west-1

            [sso-session market-dashboard]
            sso_start_url = https://example.awsapps.com/start
            sso_region = us-east-1
            """
        ).lstrip(),
        encoding="utf-8",
    )


def lambda_response(body: dict, *, function_error: str | None = None) -> dict:
    envelope = {"statusCode": 200, "body": json.dumps(body)}
    return {
        "StatusCode": 200,
        **({"FunctionError": function_error} if function_error else {}),
        "Payload": io.BytesIO(json.dumps(envelope).encode("utf-8")),
    }


def canonical_verification() -> dict:
    return {
        "verified": True,
        "eventCount": 9,
        "unverifiedEventCount": 0,
        "products": {
            "real-time-alert": {
                "eventCount": 4,
                "unverifiedEventCount": 0,
            },
            "etf-pro": {
                "eventCount": 5,
                "unverifiedEventCount": 0,
            },
        },
    }


def scheduler_heartbeats(
    *,
    now: datetime | None = None,
    status: str = "success",
    source: str = "aws-lambda",
    trigger_source: str = "aws-scheduler",
    schedule_id: str = "market-dashboard-gmail-v2-every-15m",
    scheduled: bool = True,
    errors: int = 0,
    dropped: int = 0,
    gap_minutes: int = 15,
) -> list[dict]:
    current = now or datetime.now(timezone.utc)
    plain = [
        {
            "serviceId": "gmail:timsmithaviation@gmail.com",
            "observedAt": (
                current - timedelta(minutes=gap_minutes * index)
            ).isoformat(),
            "status": status,
            "source": source,
            "triggerSource": trigger_source,
            "scheduleId": schedule_id,
            "scheduled": scheduled,
            "counts": {"errors": errors, "dropped": dropped},
        }
        for index in range(4)
    ]
    return [
        {
            key: SERIALIZER.serialize(value)
            for key, value in item.items()
        }
        for item in plain
    ]


class FakeSession:
    def __init__(
        self,
        response: dict | list[dict],
        *,
        heartbeats: list[dict] | None = None,
    ) -> None:
        self.responses = (
            list(response)
            if isinstance(response, list)
            else [response]
        )
        self.response_index = 0
        self.heartbeats = (
            scheduler_heartbeats()
            if heartbeats is None
            else heartbeats
        )
        self.invocations: list[dict] = []
        self.heartbeat_queries: list[dict] = []
        self.operations: list[str] = []

    def client(self, service: str):
        if service == "sts":
            return type(
                "Sts",
                (),
                {
                    "get_caller_identity": staticmethod(
                        lambda: {
                            "Account": "915328198276",
                            "Arn": (
                                "arn:aws:sts::915328198276:assumed-role/"
                                "AWSReservedSSO_AdministratorAccess_deadbeef/test@example.com"
                            ),
                        }
                    )
                },
            )()
        if service == "lambda":
            session = self

            class Lambda:
                @staticmethod
                def invoke(**kwargs):
                    session.operations.append("lambda:invoke")
                    session.invocations.append(kwargs)
                    index = min(
                        session.response_index,
                        len(session.responses) - 1,
                    )
                    session.response_index += 1
                    return session.responses[index]

            return Lambda()
        if service == "dynamodb":
            session = self

            class DynamoDb:
                @staticmethod
                def query(**kwargs):
                    session.operations.append("dynamodb:query")
                    session.heartbeat_queries.append(kwargs)
                    return {"Items": session.heartbeats}

            return DynamoDb()
        raise AssertionError(f"unexpected service: {service}")


class GmailBackfillTests(unittest.TestCase):
    def test_production_profile_lookup_ignores_ambient_aws_config_override(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            home = Path(temp_dir) / "home"
            aws_dir = home / ".aws"
            aws_dir.mkdir(parents=True)
            default_config = aws_dir / "config"
            sso_config(default_config)
            poisoned_config = Path(temp_dir) / "poisoned-config"
            poisoned_config.write_text(
                "[profile market-dashboard-admin]\n"
                "sso_account_id = 000000000000\n"
                "region = us-east-1\n",
                encoding="utf-8",
            )
            with (
                mock.patch.object(backfill.Path, "home", return_value=home),
                mock.patch.dict(
                    os.environ,
                    {"AWS_CONFIG_FILE": str(poisoned_config)},
                    clear=False,
                ),
            ):
                backfill.require_sso_profile("market-dashboard-admin")

    def test_success_uses_exact_sso_profile_event_and_reports_only_counts(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            config = Path(temp_dir) / "config"
            sso_config(config)
            session = FakeSession(
                lambda_response(
                    {
                        "status": "SUCCESS",
                        "pollMode": "query",
                        "messageCount": 12,
                        "storedCount": 7,
                        "skippedCount": 5,
                        "errorCount": 0,
                        "canonicalVerification": canonical_verification(),
                        "results": [{"private": "must-not-be-returned"}],
                    }
                )
            )
            session_calls = []

            def session_factory(**kwargs):
                session_calls.append(
                    {
                        "kwargs": kwargs,
                        "ambient": {
                            key: os.environ.get(key)
                            for key in backfill.AMBIENT_CREDENTIAL_KEYS
                            if os.environ.get(key)
                        },
                    }
                )
                return session

            poisoned = {
                key: "must-not-leak" for key in backfill.AMBIENT_CREDENTIAL_KEYS
            }
            with mock.patch.dict(os.environ, poisoned, clear=False):
                result = backfill.run(
                    "market-dashboard-admin",
                    session_factory=session_factory,
                    config_path=config,
                )

        heartbeat_gate = result.pop("schedulerHeartbeatGate")
        self.assertEqual(
            result,
            {
                "passed": True,
                "functionName": "market-dashboard-gmail-ingestor-v2",
                "status": "SUCCESS",
                "pollMode": "query",
                "messageCount": 12,
                "storedCount": 7,
                "skippedCount": 5,
                "errorCount": 0,
                "canonicalEventCount": 9,
                "unverifiedCanonicalEventCount": 0,
                "invocationCount": 1,
            },
        )
        self.assertTrue(heartbeat_gate["passed"])
        self.assertEqual(heartbeat_gate["required"], 4)
        self.assertEqual(heartbeat_gate["observed"], 4)
        self.assertEqual(heartbeat_gate["cadenceMinutes"], 15)
        self.assertEqual(
            heartbeat_gate["serviceId"],
            "gmail:timsmithaviation@gmail.com",
        )
        self.assertEqual(
            heartbeat_gate["scheduleId"],
            "market-dashboard-gmail-v2-every-15m",
        )
        self.assertEqual(
            session_calls,
            [
                {
                    "kwargs": {
                        "profile_name": "market-dashboard-admin",
                        "region_name": "us-west-1",
                    },
                    "ambient": {},
                }
            ],
        )
        self.assertEqual(len(session.invocations), 1)
        self.assertEqual(
            session.operations,
            ["dynamodb:query", "lambda:invoke"],
        )
        self.assertEqual(
            session.heartbeat_queries,
            [
                {
                    "TableName": "MarketDashboardServiceHeartbeats",
                    "KeyConditionExpression": "serviceId = :service_id",
                    "ExpressionAttributeValues": {
                        ":service_id": {
                            "S": "gmail:timsmithaviation@gmail.com"
                        }
                    },
                    "ScanIndexForward": False,
                    "ConsistentRead": True,
                    "Limit": 4,
                }
            ],
        )
        invocation = session.invocations[0]
        self.assertEqual(
            invocation["FunctionName"],
            "market-dashboard-gmail-ingestor-v2",
        )
        self.assertEqual(invocation["InvocationType"], "RequestResponse")
        self.assertEqual(
            json.loads(invocation["Payload"]),
            {"forceBackfill": True, "source": "activation-backfill"},
        )

    def test_durable_backfill_resumes_bounded_chunks_until_verified(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            config = Path(temp_dir) / "config"
            sso_config(config)
            session = FakeSession(
                [
                    lambda_response(
                        {
                            "status": "IN_PROGRESS",
                            "errorCode": "GMAIL_BACKLOG_PENDING",
                            "pollMode": "query",
                            "messageCount": 25,
                            "discoveredCount": 30,
                            "remainingCount": 5,
                            "storedCount": 20,
                            "skippedCount": 5,
                            "errorCount": 0,
                            "quarantinedCount": 0,
                        }
                    ),
                    lambda_response(
                        {
                            "status": "SUCCESS",
                            "pollMode": "query",
                            "messageCount": 5,
                            "discoveredCount": 30,
                            "remainingCount": 0,
                            "storedCount": 4,
                            "skippedCount": 1,
                            "errorCount": 0,
                            "quarantinedCount": 0,
                            "canonicalVerification": canonical_verification(),
                        }
                    ),
                ]
            )

            result = backfill.run(
                "market-dashboard-admin",
                session_factory=lambda **_kwargs: session,
                config_path=config,
            )

        self.assertTrue(result["passed"])
        self.assertEqual(result["invocationCount"], 2)
        self.assertEqual(result["messageCount"], 30)
        self.assertEqual(result["storedCount"], 24)
        self.assertEqual(result["skippedCount"], 6)
        self.assertEqual(len(session.invocations), 2)
        self.assertEqual(
            session.operations,
            ["dynamodb:query", "lambda:invoke", "lambda:invoke"],
        )

    def test_durable_backfill_aborts_when_checkpointed_queue_stalls(self):
        stalled_body = {
            "status": "IN_PROGRESS",
            "errorCode": "GMAIL_INVOCATION_NEAR_TIMEOUT",
            "pollMode": "query",
            "messageCount": 0,
            "discoveredCount": 10,
            "remainingCount": 10,
            "storedCount": 0,
            "skippedCount": 0,
            "errorCount": 0,
            "quarantinedCount": 0,
        }
        with tempfile.TemporaryDirectory() as temp_dir:
            config = Path(temp_dir) / "config"
            sso_config(config)
            session = FakeSession([
                lambda_response(stalled_body)
                for _ in range(4)
            ])

            with self.assertRaises(backfill.BackfillFailure) as raised:
                backfill.run(
                    "market-dashboard-admin",
                    session_factory=lambda **_kwargs: session,
                    config_path=config,
                )

        self.assertEqual(raised.exception.code, "GMAIL_BACKFILL_STALLED")
        self.assertEqual(len(session.invocations), 4)

    def test_backfill_is_never_invoked_until_exact_scheduler_gate_passes(self):
        scenarios = {
            "manual": scheduler_heartbeats(
                source="manual",
                trigger_source="manual",
                scheduled=False,
            ),
            "backfill-schedule-id": scheduler_heartbeats(
                schedule_id="market-dashboard-gmail-v2-force-backfill",
            ),
            "unhealthy": scheduler_heartbeats(status="warning"),
            "data-errors": scheduler_heartbeats(errors=1),
            "fractional-counts": scheduler_heartbeats(
                errors=Decimal("0.5")
            ),
            "cadence-gap": scheduler_heartbeats(gap_minutes=30),
            "insufficient": scheduler_heartbeats()[:3],
            "stale": scheduler_heartbeats(
                now=datetime.now(timezone.utc) - timedelta(hours=2)
            ),
        }
        for name, rows in scenarios.items():
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temp_dir:
                config = Path(temp_dir) / "config"
                sso_config(config)
                session = FakeSession(
                    lambda_response(
                        {
                            "status": "SUCCESS",
                            "pollMode": "query",
                            "errorCount": 0,
                            "canonicalVerification": canonical_verification(),
                        }
                    ),
                    heartbeats=rows,
                )
                with self.assertRaises(backfill.BackfillFailure) as raised:
                    backfill.run(
                        "market-dashboard-admin",
                        session_factory=lambda **_kwargs: session,
                        config_path=config,
                    )
                self.assertEqual(
                    raised.exception.code,
                    "GMAIL_SCHEDULER_HEARTBEAT_GATE_FAILED",
                )
                self.assertEqual(session.invocations, [])
                self.assertEqual(len(session.heartbeat_queries), 1)
                self.assertEqual(session.operations, ["dynamodb:query"])

    def test_partial_materialization_error_is_a_hard_failure(self):
        response = lambda_response(
            {
                "status": "PARTIAL_ERROR",
                "messageCount": 5,
                "storedCount": 4,
                "skippedCount": 0,
                "errorCount": 1,
                "errors": [{"error": "private detail"}],
            }
        )
        with self.assertRaises(backfill.BackfillFailure) as raised:
            backfill.verified_backfill_result(response)
        self.assertEqual(
            raised.exception.code,
            "GMAIL_BACKFILL_MATERIALIZATION_FAILED",
        )

        with self.assertRaises(backfill.BackfillFailure) as raised:
            backfill.verified_backfill_result(
                lambda_response(
                    {
                        "status": "SUCCESS",
                        "pollMode": "query",
                        "messageCount": 5,
                        "storedCount": 5,
                        "skippedCount": 0,
                        "errorCount": 0,
                        "canonicalVerification": {
                            **canonical_verification(),
                            "verified": False,
                            "unverifiedEventCount": 1,
                        },
                    }
                )
            )
        self.assertEqual(
            raised.exception.code,
            "GMAIL_BACKFILL_MATERIALIZATION_FAILED",
        )
        self.assertNotIn("private detail", str(raised.exception))

        with self.assertRaises(backfill.BackfillFailure) as raised:
            backfill.verified_backfill_result(
                lambda_response(
                    {
                        "status": "SUCCESS",
                        "pollMode": "history",
                        "messageCount": 1,
                        "storedCount": 1,
                        "skippedCount": 0,
                        "errorCount": 0,
                    }
                )
            )
        self.assertEqual(
            raised.exception.code,
            "GMAIL_BACKFILL_MATERIALIZATION_FAILED",
        )

    def test_function_error_and_invalid_envelope_are_rejected(self):
        with self.assertRaises(backfill.BackfillFailure) as raised:
            backfill.verified_backfill_result(
                lambda_response(
                    {"status": "SUCCESS", "errorCount": 0},
                    function_error="Unhandled",
                )
            )
        self.assertEqual(
            raised.exception.code,
            "GMAIL_BACKFILL_INVOCATION_FAILED",
        )

        with self.assertRaises(backfill.BackfillFailure) as raised:
            backfill.verified_backfill_result(
                {"StatusCode": 200, "Payload": io.BytesIO(b"not-json")}
            )
        self.assertEqual(
            raised.exception.code,
            "GMAIL_BACKFILL_RESPONSE_INVALID",
        )

    def test_identity_must_be_short_lived_sso_in_the_exact_account(self):
        with self.assertRaises(backfill.BackfillFailure) as raised:
            backfill.validate_identity(
                {
                    "Account": "915328198276",
                    "Arn": "arn:aws:iam::915328198276:user/permanent-admin",
                }
            )
        self.assertEqual(
            raised.exception.code,
            "AWS_SSO_IDENTITY_REQUIRED",
        )

        with self.assertRaises(backfill.BackfillFailure) as raised:
            backfill.validate_identity(
                {
                    "Account": "000000000000",
                    "Arn": (
                        "arn:aws:sts::000000000000:assumed-role/"
                        "AWSReservedSSO_AdministratorAccess_deadbeef/test"
                    ),
                }
            )
        self.assertEqual(raised.exception.code, "AWS_ACCOUNT_MISMATCH")

    def test_profile_configuration_must_be_complete_and_exact(self):
        with self.assertRaises(backfill.BackfillFailure) as raised:
            backfill.require_sso_profile(
                "some-other-admin",
                config_path=Path("/does/not/matter"),
            )
        self.assertEqual(
            raised.exception.code,
            "AWS_SSO_PROFILE_REQUIRED",
        )

        with tempfile.TemporaryDirectory() as temp_dir:
            config = Path(temp_dir) / "config"
            sso_config(config)
            backfill.require_sso_profile(
                "market-dashboard-admin",
                config_path=config,
            )
            config.write_text(
                config.read_text(encoding="utf-8").replace(
                    "915328198276",
                    "000000000000",
                ),
                encoding="utf-8",
            )
            with self.assertRaises(backfill.BackfillFailure) as raised:
                backfill.require_sso_profile(
                    "market-dashboard-admin",
                    config_path=config,
                )
            self.assertEqual(raised.exception.code, "AWS_ACCOUNT_MISMATCH")


if __name__ == "__main__":
    unittest.main()
