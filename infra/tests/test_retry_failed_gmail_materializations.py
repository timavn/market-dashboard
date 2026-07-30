"""Safety tests for the exact-three Gmail materialization retry wrapper."""

from __future__ import annotations

import importlib.util
import hashlib
import io
import json
import os
import tempfile
import unittest
from contextlib import redirect_stderr
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "infra" / "scripts" / "retry_failed_gmail_materializations.py"
SPEC = importlib.util.spec_from_file_location(
    "retry_failed_gmail_materializations",
    SCRIPT,
)
retry = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(retry)


NOW = datetime(2026, 7, 29, 18, 30, tzinfo=timezone.utc)
OBSERVED_AT = NOW - timedelta(minutes=2)
PRIVATE_IDS = {
    "the-call": "gmail-private-call-id",
    "the-macro-show": "gmail-private-macro-id",
    "risk-ranges": "gmail-private-risk-id",
}
RELEASE_COMMIT = "a" * 40


def write_profile_files(
    directory: Path,
    *,
    shadowed: bool = False,
) -> tuple[Path, Path]:
    config = directory / "config"
    credentials = directory / "credentials"
    config.write_text(
        "\n".join(
            [
                "[profile market-dashboard-admin]",
                "sso_session = market-dashboard-admin",
                f"sso_account_id = {retry.EXPECTED_ACCOUNT}",
                "sso_role_name = AdministratorAccess",
                f"region = {retry.EXPECTED_REGION}",
                "",
                "[sso-session market-dashboard-admin]",
                "sso_start_url = https://example.awsapps.com/start",
                "sso_region = us-east-1",
                "",
            ]
        ),
        encoding="utf-8",
    )
    credentials.write_text(
        (
            "[market-dashboard-admin]\n"
            "aws_access_key_id = temporary\n"
            "aws_secret_access_key = temporary\n"
            "aws_session_token = temporary\n"
        )
        if shadowed
        else "",
        encoding="utf-8",
    )
    return config, credentials


def failure_heartbeat(**overrides):
    result = {
        "serviceId": retry.EXPECTED_HEARTBEAT_SERVICE,
        "source": "aws-lambda",
        "triggerSource": "aws-scheduler",
        "scheduleId": retry.EXPECTED_SCHEDULE,
        "scheduled": True,
        "status": "error",
        "errorCode": retry.EXPECTED_ERROR_CODE,
        "observedAt": OBSERVED_AT.isoformat(),
        "counts": {"errors": 3, "dropped": 0},
    }
    result.update(overrides)
    return result


def active_failure_rows():
    rows = []
    for offset, report_type in enumerate(retry.EXPECTED_REPORT_TYPES):
        rows.append(
            {
                "messageId": PRIVATE_IDS[report_type],
                "attachmentId": f"message-body-html-{offset}",
                "status": "ERROR",
                "reportType": report_type,
                "materializationStatus": "ERROR",
                "errorCode": retry.EXPECTED_ERROR_CODE,
                "retryable": True,
                "updatedAt": (
                    OBSERVED_AT - timedelta(seconds=offset + 1)
                ).isoformat(),
            }
        )
    return rows


def incident_receipt(rows):
    heartbeat = failure_heartbeat()
    return {
        "heartbeat": retry.heartbeat_receipt_evidence(heartbeat),
        "failures": [
            {
                "messageId": row["messageId"],
                "attachmentId": row["attachmentId"],
                "reportType": row["reportType"],
                "updatedAt": row["updatedAt"],
            }
            for row in rows
        ],
    }


class FakeHeartbeatTable:
    def __init__(self, rows):
        self.rows = rows

    def query(self, **_kwargs):
        limit = int(_kwargs.get("Limit") or len(self.rows))
        return {"Items": deepcopy(self.rows[:limit])}

    def get_item(self, *, Key, **_kwargs):
        for row in self.rows:
            if (
                row.get("serviceId") == Key.get("serviceId")
                and row.get("observedAt") == Key.get("observedAt")
            ):
                return {"Item": deepcopy(row)}
        return {}


class FakeLedgerTable:
    def __init__(
        self,
        rows,
        *,
        runtime_state=None,
        runtime_queue=None,
        clear_runtime_on_invoke=True,
        yield_once_on_invoke=False,
    ):
        self.rows = {
            (row["messageId"], row["attachmentId"]): deepcopy(row)
            for row in rows
        }
        self.runtime_state = deepcopy(runtime_state or {"status": "READY"})
        self.runtime_queue = deepcopy(runtime_queue or [])
        self.clear_runtime_on_invoke = clear_runtime_on_invoke
        self.yield_once_on_invoke = yield_once_on_invoke

    def scan(self, **_kwargs):
        return {"Items": [deepcopy(row) for row in self.rows.values()]}

    def query(self, **_kwargs):
        limit = int(_kwargs.get("Limit") or len(self.runtime_queue))
        rows = deepcopy(self.runtime_queue[:limit])
        response = {"Items": rows}
        if len(self.runtime_queue) > limit:
            response["LastEvaluatedKey"] = {
                "messageId": retry.RUNTIME_STATE_MESSAGE_ID,
                "attachmentId": self.runtime_queue[limit - 1][
                    "attachmentId"
                ],
            }
        return response

    def get_item(self, *, Key, **_kwargs):
        if Key == {
            "messageId": retry.RUNTIME_STATE_MESSAGE_ID,
            "attachmentId": retry.RUNTIME_STATE_ATTACHMENT_ID,
        }:
            return {"Item": deepcopy(self.runtime_state)}
        return {"Item": deepcopy(self.rows.get((Key["messageId"], Key["attachmentId"])))}

    def recover(self, message_ids):
        for row in self.rows.values():
            if row["messageId"] in message_ids:
                row.update(
                    {
                        "status": "INDEXED",
                        "materializationStatus": "INDEXED",
                        "errorCode": None,
                        "retryable": False,
                        "materializationAttemptVersion": (
                            retry.EXPECTED_MATERIALIZATION_ATTEMPT_VERSION
                        ),
                        "materializationAttemptCount": 1,
                    }
                )


class FakeDynamo:
    def __init__(self, heartbeat_rows, ledger):
        self.heartbeat = FakeHeartbeatTable(heartbeat_rows)
        self.ledger = ledger

    def Table(self, name):
        if name == retry.EXPECTED_HEARTBEAT_TABLE:
            return self.heartbeat
        if name == retry.EXPECTED_LEDGER_TABLE:
            return self.ledger
        raise AssertionError(name)


class FakeLambda:
    def __init__(self, ledger):
        self.ledger = ledger
        self.invocations = []

    def get_function_configuration(self, **_kwargs):
        return {
            "FunctionName": retry.EXPECTED_FUNCTION,
            "FunctionArn": retry.EXPECTED_FUNCTION_ARN,
            "State": "Active",
            "LastUpdateStatus": "Successful",
            "Environment": {"Variables": {"BUILD_VERSION": RELEASE_COMMIT}},
        }

    def invoke(self, **kwargs):
        payload = json.loads(kwargs["Payload"].decode("utf-8"))
        self.invocations.append(payload)
        active_queue_count = sum(
            str(row.get("status") or "") in {"PENDING", "RETRYABLE"}
            for row in self.ledger.runtime_queue
        )
        message_count = (
            active_queue_count
            if self.ledger.runtime_queue
            else len(payload["messageIds"])
        )
        should_yield = (
            self.ledger.yield_once_on_invoke
            and len(self.invocations) == 1
        )
        if should_yield:
            for row in self.ledger.runtime_queue:
                if str(row.get("status") or "") == "RETRYABLE":
                    row["errorCode"] = "GMAIL_INVOCATION_NEAR_TIMEOUT"
        else:
            self.ledger.recover(payload["messageIds"])
            if (
                self.ledger.runtime_queue
                and self.ledger.clear_runtime_on_invoke
            ):
                self.ledger.runtime_state = {"status": "READY"}
                self.ledger.runtime_queue = []
        body = {
            "status": "IN_PROGRESS" if should_yield else "SUCCESS",
            "pollMode": "explicit",
            "messageCount": message_count,
            "remainingCount": active_queue_count if should_yield else 0,
            "storedCount": 0 if should_yield else message_count,
            "skippedCount": 0,
            "errorCount": 0,
            "quarantinedCount": 0,
            "results": [
                {
                    "messageId": message_id,
                    "subject": "must never be printed",
                    "body": "must never be printed",
                }
                for message_id in payload["messageIds"]
            ],
        }
        return {
            "StatusCode": 200,
            "Payload": io.BytesIO(
                json.dumps(
                    {"statusCode": 200, "body": json.dumps(body)}
                ).encode("utf-8")
            ),
        }


class FakeScheduler:
    def __init__(self):
        self.state = "ENABLED"

    def get_schedule(self, **_kwargs):
        return {
            "Name": retry.EXPECTED_SCHEDULE,
            "State": self.state,
            "ScheduleExpression": retry.EXPECTED_SCHEDULE_EXPRESSION,
            "Target": {
                "Arn": retry.EXPECTED_FUNCTION_ARN,
                "Input": json.dumps(retry.EXPECTED_SCHEDULE_INPUT),
            },
        }


class FakeSts:
    def get_caller_identity(self):
        return {
            "Account": retry.EXPECTED_ACCOUNT,
            "Arn": (
                f"arn:aws:sts::{retry.EXPECTED_ACCOUNT}:assumed-role/"
                "AWSReservedSSO_AdministratorAccess_hash/operator"
            ),
        }


class FakeSession:
    def __init__(self, heartbeat_rows, ledger):
        self.dynamo = FakeDynamo(heartbeat_rows, ledger)
        self.lambda_client = FakeLambda(ledger)
        self.scheduler = FakeScheduler()
        self.sts = FakeSts()

    def client(self, name):
        return {
            "lambda": self.lambda_client,
            "scheduler": self.scheduler,
            "sts": self.sts,
        }[name]

    def resource(self, name):
        if name != "dynamodb":
            raise AssertionError(name)
        return self.dynamo


class TargetedRetryTests(unittest.TestCase):
    @staticmethod
    def exact_resume_state_and_queue():
        batch_id = "signed-explicit-batch"
        state = {
            "status": "IN_PROGRESS",
            "activeBatchId": batch_id,
            "pendingHistoryId": None,
            "pendingPollMode": "explicit",
            "pendingForceBackfill": False,
            "pendingDiscoveredCount": 3,
            "discoveryStatus": "COMPLETE",
            "discoveryBatchId": batch_id,
            "discoveryMode": "explicit",
            "discoveryLabelId": None,
            "discoveryTargetHistoryId": None,
            "discoveryPageToken": None,
            "discoveryNextSequence": 3,
        }
        queue = []
        for sequence, report_type in enumerate(
            retry.EXPECTED_REPORT_TYPES
        ):
            message_id = PRIVATE_IDS[report_type]
            message_hash = hashlib.sha256(
                message_id.encode("utf-8")
            ).hexdigest()[:16]
            queue.append(
                {
                    "messageId": retry.RUNTIME_STATE_MESSAGE_ID,
                    "attachmentId": (
                        f"{retry.MESSAGE_QUEUE_ATTACHMENT_PREFIX}"
                        f"{batch_id}#p{sequence:018d}#{message_hash}"
                    ),
                    "batchId": batch_id,
                    "gmailMessageId": message_id,
                    "sequence": sequence,
                    "status": (
                        "RETRYABLE"
                        if report_type == "risk-ranges"
                        else "COMPLETED"
                    ),
                    "attemptCount": 1,
                    "errorCode": (
                        "RISK_RANGE_TRANSACTION_WRITE_FAILED"
                        if report_type == "risk-ranges"
                        else None
                    ),
                }
            )
        return state, queue

    def test_profile_rejects_static_shadow_credentials(self):
        with tempfile.TemporaryDirectory() as raw:
            config, credentials = write_profile_files(Path(raw), shadowed=True)
            with self.assertRaises(retry.TargetedRetryFailure) as raised:
                retry.require_admin_sso_profile(
                    retry.EXPECTED_ADMIN_PROFILE,
                    config_path=config,
                    credentials_path=credentials,
                )
        self.assertEqual(raised.exception.code, "AWS_SSO_PROFILE_SHADOWED")

    def test_latest_heartbeat_requires_exact_scheduler_failure_and_safe_gap(self):
        validated = retry.validate_latest_failure_heartbeat(
            [failure_heartbeat()],
            now=NOW,
        )
        self.assertEqual(validated["counts"]["errors"], 3)

        with self.assertRaises(retry.TargetedRetryFailure) as raised:
            retry.validate_latest_failure_heartbeat(
                [failure_heartbeat(status="success")],
                now=NOW,
            )
        self.assertEqual(
            raised.exception.code,
            "GMAIL_FAILURE_HEARTBEAT_MISMATCH",
        )

        with self.assertRaises(retry.TargetedRetryFailure) as raised:
            retry.validate_latest_failure_heartbeat(
                [
                    failure_heartbeat(
                        observedAt=(NOW - timedelta(minutes=23)).isoformat()
                    )
                ],
                now=NOW,
            )
        self.assertEqual(
            raised.exception.code,
            "GMAIL_FAILURE_HEARTBEAT_STALE",
        )

    def test_selection_requires_one_current_failed_message_per_category(self):
        ledger = FakeLedgerTable(active_failure_rows())
        selected = retry.select_current_failures(
            ledger,
            failure_heartbeat(),
        )
        self.assertEqual(
            [item["reportType"] for item in selected],
            list(retry.EXPECTED_REPORT_TYPES),
        )
        self.assertEqual(len({item["messageId"] for item in selected}), 3)

        ambiguous = active_failure_rows()
        duplicate = deepcopy(ambiguous[0])
        duplicate["messageId"] = "another-private-call-id"
        duplicate["attachmentId"] = "message-body-html-other"
        ambiguous.append(duplicate)
        with self.assertRaises(retry.TargetedRetryFailure) as raised:
            retry.select_current_failures(
                FakeLedgerTable(ambiguous),
                failure_heartbeat(),
            )
        self.assertEqual(
            raised.exception.code,
            "GMAIL_ACTIVE_FAILURE_SET_AMBIGUOUS",
        )

    def test_receipt_accepts_current_typed_risk_range_retry_failure(self):
        original = active_failure_rows()
        current = deepcopy(original)
        risk = next(
            row
            for row in current
            if row["reportType"] == "risk-ranges"
        )
        risk.update(
            {
                "errorCode": "RISK_RANGE_TRANSACTION_WRITE_FAILED",
                "materializationAttemptVersion": (
                    retry.EXPECTED_MATERIALIZATION_ATTEMPT_VERSION
                ),
                "materializationAttemptCount": 1,
                "updatedAt": OBSERVED_AT.isoformat(),
            }
        )

        selected = retry.verify_incident_live_evidence(
            FakeHeartbeatTable([failure_heartbeat()]),
            FakeLedgerTable(current),
            incident_receipt(original),
        )

        selected_risk = next(
            row
            for row in selected
            if row["reportType"] == "risk-ranges"
        )
        self.assertTrue(selected_risk["needsRetry"])

    def test_receipt_rejects_typed_risk_error_for_non_risk_category(self):
        original = active_failure_rows()
        current = deepcopy(original)
        call = next(
            row for row in current if row["reportType"] == "the-call"
        )
        call.update(
            {
                "errorCode": "RISK_RANGE_TRANSACTION_WRITE_FAILED",
                "materializationAttemptVersion": (
                    retry.EXPECTED_MATERIALIZATION_ATTEMPT_VERSION
                ),
                "materializationAttemptCount": 1,
                "updatedAt": OBSERVED_AT.isoformat(),
            }
        )

        with self.assertRaises(retry.TargetedRetryFailure) as raised:
            retry.verify_incident_live_evidence(
                FakeHeartbeatTable([failure_heartbeat()]),
                FakeLedgerTable(current),
                incident_receipt(original),
            )

        self.assertEqual(
            raised.exception.code,
            "GMAIL_INCIDENT_EVIDENCE_DRIFT",
        )

    def test_receipt_rejects_unknown_typed_risk_error(self):
        original = active_failure_rows()
        current = deepcopy(original)
        risk = next(
            row
            for row in current
            if row["reportType"] == "risk-ranges"
        )
        risk.update(
            {
                "errorCode": "RISK_RANGE_UNRECOGNIZED_FAILURE",
                "materializationAttemptVersion": (
                    retry.EXPECTED_MATERIALIZATION_ATTEMPT_VERSION
                ),
                "materializationAttemptCount": 1,
                "updatedAt": OBSERVED_AT.isoformat(),
            }
        )

        with self.assertRaises(retry.TargetedRetryFailure) as raised:
            retry.verify_incident_live_evidence(
                FakeHeartbeatTable([failure_heartbeat()]),
                FakeLedgerTable(current),
                incident_receipt(original),
            )

        self.assertEqual(
            raised.exception.code,
            "GMAIL_INCIDENT_EVIDENCE_DRIFT",
        )

    def test_receipt_rejects_typed_risk_error_from_wrong_materializer(self):
        original = active_failure_rows()
        current = deepcopy(original)
        risk = next(
            row
            for row in current
            if row["reportType"] == "risk-ranges"
        )
        risk.update(
            {
                "errorCode": "RISK_RANGE_TRANSACTION_WRITE_FAILED",
                "materializationAttemptVersion": "old-materializer",
                "materializationAttemptCount": 1,
                "updatedAt": OBSERVED_AT.isoformat(),
            }
        )

        with self.assertRaises(retry.TargetedRetryFailure) as raised:
            retry.verify_incident_live_evidence(
                FakeHeartbeatTable([failure_heartbeat()]),
                FakeLedgerTable(current),
                incident_receipt(original),
            )

        self.assertEqual(
            raised.exception.code,
            "GMAIL_INCIDENT_EVIDENCE_DRIFT",
        )

    def test_receipt_rejects_typed_risk_error_without_new_attempt(self):
        original = active_failure_rows()
        current = deepcopy(original)
        risk = next(
            row
            for row in current
            if row["reportType"] == "risk-ranges"
        )
        risk.update(
            {
                "errorCode": "RISK_RANGE_TRANSACTION_WRITE_FAILED",
                "materializationAttemptVersion": (
                    retry.EXPECTED_MATERIALIZATION_ATTEMPT_VERSION
                ),
                "materializationAttemptCount": 0,
                "updatedAt": OBSERVED_AT.isoformat(),
            }
        )

        with self.assertRaises(retry.TargetedRetryFailure) as raised:
            retry.verify_incident_live_evidence(
                FakeHeartbeatTable([failure_heartbeat()]),
                FakeLedgerTable(current),
                incident_receipt(original),
            )

        self.assertEqual(
            raised.exception.code,
            "GMAIL_INCIDENT_EVIDENCE_DRIFT",
        )

    def test_receipt_rejects_in_progress_row_as_recovered(self):
        original = active_failure_rows()
        current = deepcopy(original)
        risk = next(
            row
            for row in current
            if row["reportType"] == "risk-ranges"
        )
        risk.update(
            {
                "status": "IN_PROGRESS",
                "materializationStatus": None,
                "errorCode": None,
                "retryable": False,
                "materializationAttemptVersion": (
                    retry.EXPECTED_MATERIALIZATION_ATTEMPT_VERSION
                ),
                "materializationAttemptCount": 1,
                "updatedAt": OBSERVED_AT.isoformat(),
            }
        )

        with self.assertRaises(retry.TargetedRetryFailure) as raised:
            retry.verify_incident_live_evidence(
                FakeHeartbeatTable([failure_heartbeat()]),
                FakeLedgerTable(current),
                incident_receipt(original),
            )

        self.assertEqual(
            raised.exception.code,
            "GMAIL_INCIDENT_EVIDENCE_DRIFT",
        )

    def test_postcheck_rejects_in_progress_row_as_recovered(self):
        rows = active_failure_rows()
        ledger = FakeLedgerTable(rows)
        ledger.recover(PRIVATE_IDS.values())
        risk = next(
            row
            for row in ledger.rows.values()
            if row["reportType"] == "risk-ranges"
        )
        risk.update(
            {
                "status": "IN_PROGRESS",
                "materializationStatus": None,
            }
        )

        with self.assertRaises(retry.TargetedRetryFailure) as raised:
            retry.verify_selected_rows_recovered(
                ledger,
                incident_receipt(rows)["failures"],
            )

        self.assertEqual(
            raised.exception.code,
            "GMAIL_TARGETED_RETRY_POSTCHECK_FAILED",
        )

    def test_apply_retries_only_active_typed_risk_failure(self):
        with tempfile.TemporaryDirectory() as raw:
            private_dir = Path(raw)
            config, credentials = write_profile_files(private_dir)
            receipt = private_dir / "incident.json"
            receipt_key = private_dir / "incident.key"
            ledger = FakeLedgerTable(active_failure_rows())
            session = FakeSession([failure_heartbeat()], ledger)
            retry.run(
                retry.EXPECTED_ADMIN_PROFILE,
                mode="prepare",
                receipt_path=receipt,
                receipt_key_path=receipt_key,
                session_factory=lambda **_kwargs: session,
                config_path=config,
                credentials_path=credentials,
                now=NOW,
            )

            recovered_ids = [
                PRIVATE_IDS["the-call"],
                PRIVATE_IDS["the-macro-show"],
            ]
            ledger.recover(recovered_ids)
            risk = next(
                row
                for row in ledger.rows.values()
                if row["reportType"] == "risk-ranges"
            )
            risk.update(
                {
                    "errorCode": "RISK_RANGE_TRANSACTION_WRITE_FAILED",
                    "materializationAttemptVersion": (
                        retry.EXPECTED_MATERIALIZATION_ATTEMPT_VERSION
                    ),
                    "materializationAttemptCount": 1,
                    "updatedAt": OBSERVED_AT.isoformat(),
                }
            )
            state, queue = self.exact_resume_state_and_queue()
            ledger.runtime_state = state
            ledger.runtime_queue = queue
            ledger.yield_once_on_invoke = True
            session.scheduler.state = "DISABLED"
            result = retry.run(
                retry.EXPECTED_ADMIN_PROFILE,
                mode="apply",
                receipt_path=receipt,
                receipt_key_path=receipt_key,
                session_factory=lambda **_kwargs: session,
                config_path=config,
                credentials_path=credentials,
                release_commit=RELEASE_COMMIT,
            )

        self.assertTrue(result["passed"])
        self.assertEqual(result["activeFailureCount"], 1)
        self.assertEqual(result["invocationCount"], 2)
        self.assertEqual(ledger.runtime_state, {"status": "READY"})
        self.assertEqual(ledger.runtime_queue, [])
        self.assertEqual(
            session.lambda_client.invocations[0]["messageIds"],
            [
                PRIVATE_IDS[report_type]
                for report_type in retry.EXPECTED_REPORT_TYPES
            ],
        )

    def test_apply_clears_exact_completed_runtime_batch(self):
        with tempfile.TemporaryDirectory() as raw:
            private_dir = Path(raw)
            config, credentials = write_profile_files(private_dir)
            receipt = private_dir / "incident.json"
            receipt_key = private_dir / "incident.key"
            ledger = FakeLedgerTable(active_failure_rows())
            session = FakeSession([failure_heartbeat()], ledger)
            retry.run(
                retry.EXPECTED_ADMIN_PROFILE,
                mode="prepare",
                receipt_path=receipt,
                receipt_key_path=receipt_key,
                session_factory=lambda **_kwargs: session,
                config_path=config,
                credentials_path=credentials,
                now=NOW,
            )

            ledger.recover(PRIVATE_IDS.values())
            state, queue = self.exact_resume_state_and_queue()
            for row in queue:
                row["status"] = "COMPLETED"
                row["errorCode"] = None
            ledger.runtime_state = state
            ledger.runtime_queue = queue
            session.scheduler.state = "DISABLED"
            result = retry.run(
                retry.EXPECTED_ADMIN_PROFILE,
                mode="apply",
                receipt_path=receipt,
                receipt_key_path=receipt_key,
                session_factory=lambda **_kwargs: session,
                config_path=config,
                credentials_path=credentials,
                release_commit=RELEASE_COMMIT,
            )

        self.assertEqual(result["status"], "SUCCESS")
        self.assertEqual(result["activeFailureCount"], 0)
        self.assertEqual(result["invocationCount"], 1)
        self.assertEqual(ledger.runtime_state, {"status": "READY"})
        self.assertEqual(ledger.runtime_queue, [])

    def test_apply_rejects_success_when_runtime_does_not_clear(self):
        with tempfile.TemporaryDirectory() as raw:
            private_dir = Path(raw)
            config, credentials = write_profile_files(private_dir)
            receipt = private_dir / "incident.json"
            receipt_key = private_dir / "incident.key"
            ledger = FakeLedgerTable(
                active_failure_rows(),
                clear_runtime_on_invoke=False,
            )
            session = FakeSession([failure_heartbeat()], ledger)
            retry.run(
                retry.EXPECTED_ADMIN_PROFILE,
                mode="prepare",
                receipt_path=receipt,
                receipt_key_path=receipt_key,
                session_factory=lambda **_kwargs: session,
                config_path=config,
                credentials_path=credentials,
                now=NOW,
            )

            ledger.recover(PRIVATE_IDS.values())
            state, queue = self.exact_resume_state_and_queue()
            for row in queue:
                row["status"] = "COMPLETED"
                row["errorCode"] = None
            ledger.runtime_state = state
            ledger.runtime_queue = queue
            session.scheduler.state = "DISABLED"
            with self.assertRaises(retry.TargetedRetryFailure) as raised:
                retry.run(
                    retry.EXPECTED_ADMIN_PROFILE,
                    mode="apply",
                    receipt_path=receipt,
                    receipt_key_path=receipt_key,
                    session_factory=lambda **_kwargs: session,
                    config_path=config,
                    credentials_path=credentials,
                    release_commit=RELEASE_COMMIT,
                )

        self.assertEqual(raised.exception.code, "GMAIL_RUNTIME_BUSY")

    def test_run_invokes_only_selected_ids_and_never_returns_content(self):
        with tempfile.TemporaryDirectory() as raw:
            private_dir = Path(raw)
            config, credentials = write_profile_files(private_dir)
            receipt = private_dir / "incident.json"
            receipt_key = private_dir / "incident.key"
            ledger = FakeLedgerTable(active_failure_rows())
            session = FakeSession([failure_heartbeat()], ledger)
            environment = {
                key: "must-not-be-used"
                for key in retry.AMBIENT_CREDENTIAL_KEYS
            }
            with mock.patch.dict(os.environ, environment, clear=False):
                prepared = retry.run(
                    retry.EXPECTED_ADMIN_PROFILE,
                    mode="prepare",
                    receipt_path=receipt,
                    receipt_key_path=receipt_key,
                    session_factory=lambda **_kwargs: session,
                    config_path=config,
                    credentials_path=credentials,
                    now=NOW,
                )
                session.scheduler.state = "DISABLED"
                result = retry.run(
                    retry.EXPECTED_ADMIN_PROFILE,
                    mode="apply",
                    receipt_path=receipt,
                    receipt_key_path=receipt_key,
                    session_factory=lambda **_kwargs: session,
                    config_path=config,
                    credentials_path=credentials,
                    release_commit=RELEASE_COMMIT,
                )

        self.assertTrue(prepared["passed"])
        self.assertEqual(prepared["mode"], "prepare")
        self.assertTrue(result["passed"])
        self.assertEqual(result["selectedCount"], 3)
        self.assertEqual(
            session.lambda_client.invocations,
            [
                {
                    "messageIds": [
                        PRIVATE_IDS[report_type]
                        for report_type in retry.EXPECTED_REPORT_TYPES
                    ],
                    "source": "operator-targeted-retry",
                }
            ],
        )
        rendered = json.dumps(
            {"prepared": prepared, "applied": result},
            sort_keys=True,
        )
        for message_id in PRIVATE_IDS.values():
            self.assertNotIn(message_id, rendered)
        self.assertNotIn("must never be printed", rendered)
        for key in retry.AMBIENT_CREDENTIAL_KEYS:
            self.assertNotIn(key, os.environ)

    def test_busy_runtime_blocks_before_lambda_invocation(self):
        with tempfile.TemporaryDirectory() as raw:
            private_dir = Path(raw)
            config, credentials = write_profile_files(private_dir)
            ledger = FakeLedgerTable(
                active_failure_rows(),
                runtime_state={
                    "status": "IN_PROGRESS",
                    "activeBatchId": "active-private-batch",
                    "pendingPollMode": "history",
                },
            )
            session = FakeSession([failure_heartbeat()], ledger)
            with self.assertRaises(retry.TargetedRetryFailure) as raised:
                retry.run(
                    retry.EXPECTED_ADMIN_PROFILE,
                    mode="prepare",
                    receipt_path=private_dir / "incident.json",
                    receipt_key_path=private_dir / "incident.key",
                    session_factory=lambda **_kwargs: session,
                    config_path=config,
                    credentials_path=credentials,
                    now=NOW,
                )

        self.assertEqual(raised.exception.code, "GMAIL_RUNTIME_BUSY")
        self.assertEqual(session.lambda_client.invocations, [])

    def test_exact_signed_explicit_runtime_batch_can_resume(self):
        selected = [
            {
                "messageId": PRIVATE_IDS[report_type],
                "reportType": report_type,
                "needsRetry": report_type == "risk-ranges",
            }
            for report_type in retry.EXPECTED_REPORT_TYPES
        ]
        state, queue = self.exact_resume_state_and_queue()
        ledger = FakeLedgerTable(
            active_failure_rows(),
            runtime_state=state,
            runtime_queue=queue,
        )

        runtime_gate = (
            retry.require_idle_or_exact_incident_runtime_state(
                ledger,
                selected,
            )
        )

        self.assertEqual(runtime_gate["mode"], "resume")
        self.assertEqual(runtime_gate["expectedMessageCount"], 1)

    def test_active_runtime_with_extra_queue_item_is_blocked(self):
        selected = [
            {
                "messageId": PRIVATE_IDS[report_type],
                "reportType": report_type,
                "needsRetry": report_type == "risk-ranges",
            }
            for report_type in retry.EXPECTED_REPORT_TYPES
        ]
        state, queue = self.exact_resume_state_and_queue()
        extra = deepcopy(queue[-1])
        extra["attachmentId"] += "-extra"
        extra["gmailMessageId"] = "unrelated-private-id"
        queue.append(extra)
        ledger = FakeLedgerTable(
            active_failure_rows(),
            runtime_state=state,
            runtime_queue=queue,
        )

        with self.assertRaises(retry.TargetedRetryFailure) as raised:
            retry.require_idle_or_exact_incident_runtime_state(
                ledger,
                selected,
            )

        self.assertEqual(raised.exception.code, "GMAIL_RUNTIME_BUSY")

    def test_active_runtime_with_tampered_queue_key_is_blocked(self):
        selected = [
            {
                "messageId": PRIVATE_IDS[report_type],
                "reportType": report_type,
                "needsRetry": report_type == "risk-ranges",
            }
            for report_type in retry.EXPECTED_REPORT_TYPES
        ]
        state, queue = self.exact_resume_state_and_queue()
        queue[-1]["attachmentId"] += "-tampered"
        ledger = FakeLedgerTable(
            active_failure_rows(),
            runtime_state=state,
            runtime_queue=queue,
        )

        with self.assertRaises(retry.TargetedRetryFailure) as raised:
            retry.require_idle_or_exact_incident_runtime_state(
                ledger,
                selected,
            )

        self.assertEqual(raised.exception.code, "GMAIL_RUNTIME_BUSY")

    def test_prepare_idle_gate_rejects_exact_active_batch(self):
        state, queue = self.exact_resume_state_and_queue()
        ledger = FakeLedgerTable(
            active_failure_rows(),
            runtime_state=state,
            runtime_queue=queue,
        )

        with self.assertRaises(retry.TargetedRetryFailure) as raised:
            retry.require_idle_runtime_state(ledger)

        self.assertEqual(raised.exception.code, "GMAIL_RUNTIME_BUSY")

    def test_apply_accepts_same_incident_reobserved_before_schedule_disabled(self):
        with tempfile.TemporaryDirectory() as raw:
            private_dir = Path(raw)
            config, credentials = write_profile_files(private_dir)
            receipt = private_dir / "incident.json"
            receipt_key = private_dir / "incident.key"
            ledger = FakeLedgerTable(active_failure_rows())
            original = failure_heartbeat()
            session = FakeSession([original], ledger)
            retry.run(
                retry.EXPECTED_ADMIN_PROFILE,
                mode="prepare",
                receipt_path=receipt,
                receipt_key_path=receipt_key,
                session_factory=lambda **_kwargs: session,
                config_path=config,
                credentials_path=credentials,
                now=NOW,
            )

            repeated_at = OBSERVED_AT + timedelta(minutes=15)
            repeated = failure_heartbeat(observedAt=repeated_at.isoformat())
            session.dynamo.heartbeat.rows = [repeated, original]
            for offset, row in enumerate(ledger.rows.values()):
                row["updatedAt"] = (
                    repeated_at - timedelta(seconds=offset + 1)
                ).isoformat()
            session.scheduler.state = "DISABLED"
            result = retry.run(
                retry.EXPECTED_ADMIN_PROFILE,
                mode="apply",
                receipt_path=receipt,
                receipt_key_path=receipt_key,
                session_factory=lambda **_kwargs: session,
                config_path=config,
                credentials_path=credentials,
                release_commit=RELEASE_COMMIT,
            )

        self.assertTrue(result["passed"])
        self.assertEqual(result["selectedCount"], 3)

    def test_apply_rejects_tampered_receipt_before_invocation(self):
        with tempfile.TemporaryDirectory() as raw:
            private_dir = Path(raw)
            config, credentials = write_profile_files(private_dir)
            receipt = private_dir / "incident.json"
            receipt_key = private_dir / "incident.key"
            ledger = FakeLedgerTable(active_failure_rows())
            session = FakeSession([failure_heartbeat()], ledger)
            retry.run(
                retry.EXPECTED_ADMIN_PROFILE,
                mode="prepare",
                receipt_path=receipt,
                receipt_key_path=receipt_key,
                session_factory=lambda **_kwargs: session,
                config_path=config,
                credentials_path=credentials,
                now=NOW,
            )
            payload = json.loads(receipt.read_text(encoding="utf-8"))
            payload["failures"][0]["reportType"] = "risk-ranges"
            receipt.write_text(
                json.dumps(payload),
                encoding="utf-8",
            )
            session.scheduler.state = "DISABLED"
            with self.assertRaises(retry.TargetedRetryFailure) as raised:
                retry.run(
                    retry.EXPECTED_ADMIN_PROFILE,
                    mode="apply",
                    receipt_path=receipt,
                    receipt_key_path=receipt_key,
                    session_factory=lambda **_kwargs: session,
                    config_path=config,
                    credentials_path=credentials,
                    release_commit=RELEASE_COMMIT,
                )

        self.assertEqual(
            raised.exception.code,
            "GMAIL_INCIDENT_RECEIPT_AUTHENTICATION_FAILED",
        )
        self.assertEqual(session.lambda_client.invocations, [])

    def test_apply_is_idempotent_when_guarded_deploy_race_already_recovered_rows(self):
        with tempfile.TemporaryDirectory() as raw:
            private_dir = Path(raw)
            config, credentials = write_profile_files(private_dir)
            receipt = private_dir / "incident.json"
            receipt_key = private_dir / "incident.key"
            ledger = FakeLedgerTable(active_failure_rows())
            session = FakeSession([failure_heartbeat()], ledger)
            retry.run(
                retry.EXPECTED_ADMIN_PROFILE,
                mode="prepare",
                receipt_path=receipt,
                receipt_key_path=receipt_key,
                session_factory=lambda **_kwargs: session,
                config_path=config,
                credentials_path=credentials,
                now=NOW,
            )
            ledger.recover(PRIVATE_IDS.values())
            session.scheduler.state = "DISABLED"
            result = retry.run(
                retry.EXPECTED_ADMIN_PROFILE,
                mode="apply",
                receipt_path=receipt,
                receipt_key_path=receipt_key,
                session_factory=lambda **_kwargs: session,
                config_path=config,
                credentials_path=credentials,
                release_commit=RELEASE_COMMIT,
            )

        self.assertEqual(result["status"], "ALREADY_RECOVERED")
        self.assertEqual(result["invocationCount"], 0)
        self.assertEqual(session.lambda_client.invocations, [])

    def test_apply_requires_gmail_schedule_disabled(self):
        with tempfile.TemporaryDirectory() as raw:
            private_dir = Path(raw)
            config, credentials = write_profile_files(private_dir)
            receipt = private_dir / "incident.json"
            receipt_key = private_dir / "incident.key"
            ledger = FakeLedgerTable(active_failure_rows())
            session = FakeSession([failure_heartbeat()], ledger)
            retry.run(
                retry.EXPECTED_ADMIN_PROFILE,
                mode="prepare",
                receipt_path=receipt,
                receipt_key_path=receipt_key,
                session_factory=lambda **_kwargs: session,
                config_path=config,
                credentials_path=credentials,
                now=NOW,
            )
            with self.assertRaises(retry.TargetedRetryFailure) as raised:
                retry.run(
                    retry.EXPECTED_ADMIN_PROFILE,
                    mode="apply",
                    receipt_path=receipt,
                    receipt_key_path=receipt_key,
                    session_factory=lambda **_kwargs: session,
                    config_path=config,
                    credentials_path=credentials,
                    release_commit=RELEASE_COMMIT,
                )

        self.assertEqual(
            raised.exception.code,
            "GMAIL_SCHEDULE_CONTRACT_INVALID",
        )
        self.assertEqual(session.lambda_client.invocations, [])

    def test_function_must_match_exact_tested_release_commit(self):
        configuration = FakeLambda(
            FakeLedgerTable(active_failure_rows())
        ).get_function_configuration()
        configuration["Environment"]["Variables"]["BUILD_VERSION"] = "b" * 40
        with self.assertRaises(retry.TargetedRetryFailure) as raised:
            retry.validate_function(
                configuration,
                expected_release_commit=RELEASE_COMMIT,
            )
        self.assertEqual(raised.exception.code, "GMAIL_FUNCTION_NOT_READY")

    def test_cli_does_not_accept_operator_supplied_message_ids(self):
        with redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit):
                retry.parse_args(
                    [
                        "--prepare",
                        "--receipt",
                        "/tmp/incident.json",
                        "--receipt-key",
                        "/tmp/incident.key",
                        "--message-id",
                        "private-id",
                    ]
                )


if __name__ == "__main__":
    unittest.main()
