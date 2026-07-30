#!/usr/bin/env python3
"""Tests for the non-mutating runtime-failure queue auditor."""

from __future__ import annotations

import hashlib
import json
import os
import stat
import sys
import tempfile
import unittest
from contextlib import redirect_stderr
from datetime import datetime, timezone
from io import StringIO
from pathlib import Path
from unittest.mock import Mock


os.environ.setdefault("AWS_EC2_METADATA_DISABLED", "true")
os.environ.setdefault("AWS_DEFAULT_REGION", "us-west-1")
REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "infra" / "scripts"))

import audit_runtime_failure_queue as audit  # noqa: E402


class FakeCredentials:
    method = "sso"


class FakeBotocoreSession:
    full_config = {
        "profiles": {
            audit.EXPECTED_PROFILE: {
                "region": audit.EXPECTED_REGION,
                "sso_account_id": audit.EXPECTED_ACCOUNT_ID,
                "sso_role_name": "AdministratorAccess",
                "sso_session": "market-dashboard",
            }
        }
    }


class FakeSession:
    region_name = audit.EXPECTED_REGION
    _session = FakeBotocoreSession()

    def __init__(self, sts: Mock, sqs: Mock):
        self.sts = sts
        self.sqs = sqs

    def get_credentials(self):
        return FakeCredentials()

    def client(self, service_name, **kwargs):
        if service_name == "sts":
            return self.sts
        if service_name == "sqs":
            return self.sqs
        raise AssertionError(service_name)


def message(message_id: str, body: str, **message_attributes):
    return {
        "MessageId": message_id,
        "ReceiptHandle": f"secret-delete-capability-{message_id}",
        "Body": body,
        "MessageAttributes": message_attributes,
    }


class AuditRuntimeFailureQueueTests(unittest.TestCase):
    def test_queue_name_matches_cloudformation_plural_resource(self):
        template = (REPO_ROOT / "infra" / "template.yaml").read_text(encoding="utf-8")
        self.assertEqual(
            audit.EXPECTED_QUEUE_NAME,
            "market-dashboard-runtime-failures-v2",
        )
        self.assertIn(f"QueueName: {audit.EXPECTED_QUEUE_NAME}", template)
        self.assertNotEqual(
            audit.EXPECTED_QUEUE_NAME,
            "market-dashboard-runtime-failure-queue-v2",
        )

    def test_fingerprint_canonicalizes_json_and_message_attribute_order(self):
        left = message(
            "one",
            '{"b": 2, "a": 1}',
            report={"DataType": "String", "StringValue": "gmail"},
            binary={"DataType": "Binary", "BinaryValue": b"\x00\x01"},
        )
        right = message(
            "two",
            '{\n  "a": 1,\n  "b": 2\n}',
            binary={"BinaryValue": bytearray(b"\x00\x01"), "DataType": "Binary"},
            report={"StringValue": "gmail", "DataType": "String"},
        )
        self.assertEqual(audit.record_fingerprint(left), audit.record_fingerprint(right))
        right["MessageAttributes"]["report"]["StringValue"] = "risk-range"
        self.assertNotEqual(audit.record_fingerprint(left), audit.record_fingerprint(right))

    def test_text_fingerprint_preserves_non_json_content(self):
        first = message("one", "not-json")
        second = message("two", "not-json ")
        self.assertNotEqual(
            audit.record_fingerprint(first),
            audit.record_fingerprint(second),
        )

    def test_sampler_groups_distinct_messages_and_ignores_repeat_delivery(self):
        first = message("one", '{"event":"same"}')
        second = message("two", '{"event":"same"}')
        repeated_first = message("one", '{"event":"same"}')
        third = message("three", '{"event":"different"}')
        sqs = Mock()
        sqs.receive_message.side_effect = [
            {"Messages": [first, second]},
            {"Messages": [repeated_first, third]},
            {"Messages": []},
        ]

        sample = audit.sample_messages(
            sqs,
            "https://sqs.us-west-1.amazonaws.com/account/queue",
            max_messages=10,
        )

        self.assertEqual(sample["sampledDistinctRecords"], 3)
        self.assertEqual(sample["sampledDuplicateRecords"], 1)
        self.assertEqual(len(sample["sampledDuplicateGroups"]), 1)
        self.assertEqual(
            sample["sampledDuplicateGroups"][0]["recordCount"],
            2,
        )
        self.assertNotIn("ReceiptHandle", first)
        self.assertNotIn("ReceiptHandle", second)
        for call in sqs.receive_message.call_args_list:
            self.assertEqual(call.kwargs["VisibilityTimeout"], 0)
            self.assertEqual(call.kwargs["WaitTimeSeconds"], 0)
            self.assertNotIn("AttributeNames", call.kwargs)

        serialized = json.dumps(sample)
        self.assertNotIn("secret-delete-capability", serialized)
        self.assertNotIn('{"event":"same"}', serialized)
        self.assertNotIn("one", serialized)

    def test_sampler_is_bounded_and_stops_after_repeated_deliveries(self):
        sqs = Mock()
        sqs.receive_message.side_effect = lambda **_kwargs: {
            "Messages": [message("one", '{"event":"same"}')]
        }
        sample = audit.sample_messages(
            sqs,
            "https://sqs.us-west-1.amazonaws.com/account/queue",
            max_messages=100,
        )
        self.assertEqual(sample["sampledDistinctRecords"], 1)
        self.assertTrue(sample["stoppedAfterRepeatedDeliveries"])
        self.assertEqual(sqs.receive_message.call_count, 4)
        self.assertLessEqual(
            sample["receiveCalls"],
            sample["receiveCallLimit"],
        )
        with self.assertRaisesRegex(audit.AuditError, "between 1 and 100"):
            audit.sample_messages(
                sqs,
                "https://sqs.us-west-1.amazonaws.com/account/queue",
                max_messages=101,
            )

    def test_queue_depth_sums_visible_in_flight_and_delayed(self):
        self.assertEqual(
            audit.queue_depth(
                {
                    "ApproximateNumberOfMessages": "69",
                    "ApproximateNumberOfMessagesNotVisible": "2",
                    "ApproximateNumberOfMessagesDelayed": "1",
                }
            ),
            {
                "visible": 69,
                "inFlight": 2,
                "delayed": 1,
                "totalApproximate": 72,
            },
        )
        with self.assertRaisesRegex(audit.AuditError, "invalid"):
            audit.queue_depth({"ApproximateNumberOfMessages": "secret"})

    def test_rejects_ambient_static_or_container_credentials(self):
        audit.reject_ambient_credentials({})
        with self.assertRaisesRegex(audit.AuditError, "ambient AWS credentials"):
            audit.reject_ambient_credentials({"AWS_ACCESS_KEY_ID": "not-used"})
        with self.assertRaisesRegex(audit.AuditError, "ambient AWS credentials"):
            audit.reject_ambient_credentials(
                {"AWS_CONTAINER_CREDENTIALS_FULL_URI": "http://example.invalid"}
            )

    def test_profile_validation_requires_exact_sso_configuration(self):
        valid = FakeSession(Mock(), Mock())
        audit.validate_sso_session(valid)

        invalid_config = FakeSession(Mock(), Mock())
        invalid_config._session = Mock(
            full_config={
                "profiles": {
                    audit.EXPECTED_PROFILE: {
                        "region": "us-east-1",
                        "sso_account_id": audit.EXPECTED_ACCOUNT_ID,
                        "sso_role_name": "AdministratorAccess",
                        "sso_session": "market-dashboard",
                    }
                }
            }
        )
        with self.assertRaisesRegex(audit.AuditError, "region"):
            audit.validate_sso_session(invalid_config)

        non_sso_credentials = FakeSession(Mock(), Mock())
        non_sso_credentials.get_credentials = lambda: Mock(method="env")
        with self.assertRaisesRegex(audit.AuditError, "did not resolve"):
            audit.validate_sso_session(non_sso_credentials)

    def test_identity_must_be_expected_account_sso_assumed_role(self):
        audit.validate_sso_identity(
            {
                "Account": audit.EXPECTED_ACCOUNT_ID,
                "Arn": (
                    "arn:aws:sts::915328198276:assumed-role/"
                    "AWSReservedSSO_AdministratorAccess_deadbeef/operator"
                ),
            }
        )
        with self.assertRaisesRegex(audit.AuditError, "not 915328198276"):
            audit.validate_sso_identity(
                {
                    "Account": "111111111111",
                    "Arn": (
                        "arn:aws:sts::111111111111:assumed-role/"
                        "AWSReservedSSO_Admin_deadbeef/operator"
                    ),
                }
            )
        with self.assertRaisesRegex(audit.AuditError, "not an AWS IAM Identity"):
            audit.validate_sso_identity(
                {
                    "Account": audit.EXPECTED_ACCOUNT_ID,
                    "Arn": "arn:aws:iam::915328198276:user/local-admin",
                }
            )

    def test_queue_url_and_arn_are_fail_closed(self):
        canonical_url = (
            "https://sqs.us-west-1.amazonaws.com/915328198276/"
            "market-dashboard-runtime-failures-v2"
        )
        audit.validate_queue_url(canonical_url)
        audit.validate_queue_arn(audit.EXPECTED_QUEUE_ARN)
        for invalid in (
            canonical_url.replace("us-west-1", "us-east-1"),
            canonical_url.replace("915328198276", "111111111111"),
            canonical_url.replace("runtime-failures", "runtime-failure-queue"),
            canonical_url + "?receipt=secret",
            canonical_url.replace("https://", "http://"),
        ):
            with self.subTest(invalid=invalid):
                with self.assertRaises(audit.AuditError):
                    audit.validate_queue_url(invalid)
        with self.assertRaises(audit.AuditError):
            audit.validate_queue_arn(
                audit.EXPECTED_QUEUE_ARN.replace(
                    audit.EXPECTED_ACCOUNT_ID,
                    "111111111111",
                )
            )

    def test_report_explicitly_has_no_mutation_or_sensitive_payloads(self):
        sample = {
            "sampledDuplicateGroups": [
                {
                    "fingerprint": "sha256:" + ("a" * 64),
                    "recordCount": 2,
                    "recordRefs": [
                        "sha256:" + ("b" * 64),
                        "sha256:" + ("c" * 64),
                    ],
                    "duplicate": True,
                }
            ]
        }
        report = audit.build_report(
            generated_at=datetime(2026, 7, 27, tzinfo=timezone.utc),
            depth={"visible": 69, "inFlight": 0, "delayed": 0, "totalApproximate": 69},
            sample=sample,
        )
        self.assertEqual(report["mode"], "audit-only")
        self.assertEqual(report["safety"]["receiveVisibilityTimeoutSeconds"], 0)
        self.assertEqual(report["safety"]["mutatingActionsImplemented"], [])
        self.assertFalse(report["safety"]["receiptHandlesPersisted"])
        self.assertFalse(report["futurePostVerificationDeduplication"]["ready"])
        serialized = json.dumps(report)
        self.assertNotIn("ReceiptHandle", serialized)
        self.assertNotIn("secret-delete-capability", serialized)
        self.assertIn("bounded sample", serialized)

    def test_report_and_checksum_are_atomic_mode_0600_and_no_overwrite(self):
        report = {"mode": "audit-only", "sample": {"sampledDistinctRecords": 0}}
        with tempfile.TemporaryDirectory() as raw_directory:
            output = Path(raw_directory) / "audit.json"
            artifact = audit.write_report(report, output)
            checksum = Path(artifact["checksumPath"])

            self.assertEqual(stat.S_IMODE(output.stat().st_mode), 0o600)
            self.assertEqual(stat.S_IMODE(checksum.stat().st_mode), 0o600)
            encoded = output.read_bytes()
            self.assertEqual(hashlib.sha256(encoded).hexdigest(), artifact["sha256"])
            self.assertEqual(
                checksum.read_text(encoding="ascii"),
                f"{artifact['sha256']}  audit.json\n",
            )
            self.assertEqual(list(Path(raw_directory).glob("*.tmp")), [])
            with self.assertRaisesRegex(audit.AuditError, "overwrite"):
                audit.write_report(report, output)

    def test_output_requires_json_suffix(self):
        with tempfile.TemporaryDirectory() as raw_directory:
            with self.assertRaisesRegex(audit.AuditError, ".json"):
                audit.write_report(
                    {"mode": "audit-only"},
                    Path(raw_directory) / "audit.txt",
                )

    def test_cli_has_no_apply_or_mutation_mode(self):
        with redirect_stderr(StringIO()):
            with self.assertRaises(SystemExit):
                audit.parse_args(["--apply"])
            with self.assertRaises(SystemExit):
                audit.parse_args(["--max-messages", "101"])

    def test_run_audit_validates_scope_and_only_uses_safe_sqs_calls(self):
        sts = Mock()
        sts.get_caller_identity.return_value = {
            "Account": audit.EXPECTED_ACCOUNT_ID,
            "Arn": (
                "arn:aws:sts::915328198276:assumed-role/"
                "AWSReservedSSO_AdministratorAccess_deadbeef/operator"
            ),
        }
        sqs = Mock()
        queue_url = (
            "https://sqs.us-west-1.amazonaws.com/915328198276/"
            "market-dashboard-runtime-failures-v2"
        )
        sqs.get_queue_url.return_value = {"QueueUrl": queue_url}
        sqs.get_queue_attributes.return_value = {
            "Attributes": {
                "QueueArn": audit.EXPECTED_QUEUE_ARN,
                "ApproximateNumberOfMessages": "69",
                "ApproximateNumberOfMessagesNotVisible": "0",
                "ApproximateNumberOfMessagesDelayed": "0",
            }
        }
        sqs.receive_message.return_value = {"Messages": []}
        session = FakeSession(sts, sqs)
        factory = Mock(return_value=session)

        with tempfile.TemporaryDirectory() as raw_directory:
            result = audit.run_audit(
                max_messages=10,
                output_path=Path(raw_directory) / "audit.json",
                now=datetime(2026, 7, 27, 12, tzinfo=timezone.utc),
                session_factory=factory,
                environment={},
            )
            report = json.loads(Path(result["reportPath"]).read_text(encoding="utf-8"))

        factory.assert_called_once_with(
            profile_name=audit.EXPECTED_PROFILE,
            region_name=audit.EXPECTED_REGION,
        )
        sqs.get_queue_url.assert_called_once_with(
            QueueName=audit.EXPECTED_QUEUE_NAME,
            QueueOwnerAWSAccountId=audit.EXPECTED_ACCOUNT_ID,
        )
        self.assertEqual(report["queueDepth"]["totalApproximate"], 69)
        self.assertEqual(result["mode"], "audit-only")
        called_methods = {
            call_name
            for call_name, _args, _kwargs in sqs.mock_calls
            if call_name
        }
        self.assertEqual(
            called_methods,
            {"get_queue_url", "get_queue_attributes", "receive_message"},
        )

    def test_run_audit_rejects_queue_url_before_receiving(self):
        sts = Mock()
        sts.get_caller_identity.return_value = {
            "Account": audit.EXPECTED_ACCOUNT_ID,
            "Arn": (
                "arn:aws:sts::915328198276:assumed-role/"
                "AWSReservedSSO_AdministratorAccess_deadbeef/operator"
            ),
        }
        sqs = Mock()
        sqs.get_queue_url.return_value = {
            "QueueUrl": (
                "https://sqs.us-east-1.amazonaws.com/915328198276/"
                "market-dashboard-runtime-failures-v2"
            )
        }
        session = FakeSession(sts, sqs)
        with self.assertRaises(audit.AuditError):
            audit.run_audit(
                max_messages=10,
                session_factory=Mock(return_value=session),
                environment={},
            )
        sqs.receive_message.assert_not_called()


if __name__ == "__main__":
    unittest.main()
