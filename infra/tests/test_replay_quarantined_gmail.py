from __future__ import annotations

import io
import hashlib
import json
import os
import sys
import unittest
from contextlib import redirect_stderr
from pathlib import Path

os.environ.setdefault("AWS_EC2_METADATA_DISABLED", "true")
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import replay_quarantined_gmail as replay


class Table:
    def __init__(self, rows):
        self.rows = list(rows)

    def query(self, **_kwargs):
        rows = list(self.rows)
        expression = _kwargs.get("KeyConditionExpression")
        if expression is not None and hasattr(expression, "get_expression"):
            values = expression.get_expression().get("values") or []
            if len(values) == 2 and hasattr(values[0], "name"):
                rows = [row for row in rows if row.get(values[0].name) == values[1]]
        return {"Items": rows}

    def get_item(self, *, Key, **_kwargs):
        for row in self.rows:
            if all(row.get(field) == value for field, value in Key.items()):
                return {"Item": dict(row)}
        return {}


class Resource:
    def __init__(self, tables):
        self.tables = tables

    def Table(self, name):
        return self.tables[name]


class S3:
    def __init__(self, bodies):
        self.bodies = dict(bodies)

    def get_object(self, *, Bucket, Key):
        del Bucket
        return {"Body": io.BytesIO(self.bodies[Key])}


def quarantine(
    message_id="0000000000000001",
    report_type="momo-tracker",
    subject="MOMO Trend Tracker",
    received_at="2026-08-13T13:06:28+00:00",
    status="STORED",
    materialization_status=None,
    attempt_version=None,
    attempt_count=0,
    body=b"artifact-1",
):
    return {
        "messageId": message_id,
        "attachmentId": "message-body-html-1",
        "reportType": report_type,
        "filename": "message-body.html",
        "mimeType": "text/html",
        "subject": subject,
        "receivedAt": received_at,
        "status": status,
        "materializationStatus": materialization_status,
        "retryable": status == "ERROR",
        "errorCode": (
            "GMAIL_RESEARCH_MATERIALIZATION_ERROR" if status == "ERROR" else None
        ),
        "materializationAttemptVersion": attempt_version,
        "materializationAttemptCount": attempt_count,
        "contentSha256": hashlib.sha256(body).hexdigest(),
        "s3Bucket": "hedgeye-test",
        "s3Key": f"immutable/{message_id}.html",
        "updatedAt": "2026-08-13T13:06:28+00:00",
    }


def incident_rows():
    specs = (
        ("0000000000000001", "momo-tracker", "MOMO Trend Tracker", "2026-08-13T13:00:00+00:00"),
        ("0000000000000002", "momo-tracker", "MOMO Trend Tracker", "2026-08-14T13:00:00+00:00"),
        ("0000000000000003", "momo-tracker", "MOMO Trend Tracker", "2026-08-17T13:00:00+00:00"),
        ("0000000000000004", "crypto-quant", "Crypto Quant", "2026-08-13T14:00:00+00:00"),
        ("0000000000000005", "signal-strength", "Real-Time Alert: BUY Signal: BJRI (Signal Strength Stock)", "2026-08-13T15:00:00+00:00"),
        ("0000000000000006", "real-time-alert", "Real-Time Alert: Sell-SOME Signal: V -KM", "2026-08-14T15:00:00+00:00"),
        ("0000000000000007", "investing-ideas", "Investing Ideas Newsletter: August 17, 2026", "2026-08-17T16:00:00+00:00"),
        ("0000000000000008", "unknown", "Investing Ideas Newsletter: August 10, 2026", "2026-08-10T16:00:00+00:00"),
    )
    return [
        quarantine(
            message_id,
            report_type,
            subject,
            received_at,
            status="ERROR" if message_id in {"0000000000000003", "0000000000000007"} else "STORED",
            materialization_status=(
                "ERROR" if message_id in {"0000000000000003", "0000000000000007"} else None
            ),
            attempt_version=(
                "gmail-materialized-v7-market-structure-archive"
                if message_id in {"0000000000000003", "0000000000000007"}
                else None
            ),
            attempt_count=1 if message_id in {"0000000000000003", "0000000000000007"} else 0,
            body=f"artifact-{message_id}".encode(),
        )
        for message_id, report_type, subject, received_at in specs
    ]


def incident_state(rows):
    return {
        "status": "WARNING",
        "quarantinedCount": len(rows),
        "quarantinedMessages": [
            {
                "messageId": row["messageId"],
                "errorCode": "GMAIL_RESEARCH_MATERIALIZATION_ERROR",
            }
            for row in rows
        ],
    }


class ReplayQuarantinedGmailTests(unittest.TestCase):
    def test_selects_exact_eight_artifact_distribution_and_derives_ids(self):
        rows = incident_rows()
        stale = rows[-1]
        manifest_artifact = {
            "artifactId": stale["contentSha256"],
            "contentSha256": stale["contentSha256"],
            "sourceMessageId": stale["messageId"],
            "stage": "indexed",
        }
        manifest = {
            "marketDate": "2026-08-10",
            "productKey": "investing-ideas",
            "state": "indexed",
            "artifacts": [manifest_artifact],
            "manifestChecksum": replay._manifest_checksum([manifest_artifact]),
        }
        selected, active = replay.select_incident_artifacts(
            Table(rows),
            Table([manifest]),
            S3({row["s3Key"]: f"artifact-{row['messageId']}".encode() for row in rows}),
            incident_state(rows),
        )

        self.assertEqual(len(selected), 8)
        self.assertEqual(active, [])
        self.assertEqual(
            sum(item["expectedAction"] == replay.FORCE_VERSION_REPLAY for item in selected),
            7,
        )
        self.assertEqual(
            sum(item["expectedAction"] == replay.CANONICAL_RECONCILE for item in selected),
            1,
        )

    def test_selection_rejects_extra_quarantine(self):
        rows = incident_rows()
        extra = quarantine(
            "0000000000000009",
            "momo-tracker",
            body=b"extra",
        )
        with self.assertRaisesRegex(replay.ReplayFailure, "exactly eight"):
            replay.incident_message_ids(
                Table([*rows, extra]),
                incident_state([*rows, extra]),
            )

    def test_prepare_shape_accepts_seven_quarantines_plus_active_investing_retry(self):
        rows = incident_rows()
        active_message_id = "0000000000000007"
        quarantined = [row for row in rows if row["messageId"] != active_message_id]
        state = incident_state(quarantined)
        state.update(
            {
                "status": "IN_PROGRESS",
                "activeBatchId": "active-batch",
                "pendingPollMode": "explicit",
            }
        )
        queue = {
            "messageId": replay.RUNTIME_STATE_KEY["messageId"],
            "attachmentId": "message-queue#active-batch#0",
            "batchId": "active-batch",
            "gmailMessageId": active_message_id,
            "status": "RETRYABLE",
        }
        message_ids, active_ids = replay.incident_message_ids(
            Table([*rows, queue]),
            state,
        )
        self.assertEqual(len(message_ids), 8)
        self.assertEqual(active_ids, [active_message_id])

    def test_verify_rows_is_idempotent_after_indexing(self):
        row = quarantine(
            status="ERROR",
            materialization_status="ERROR",
            attempt_version="gmail-materialized-v7-market-structure-archive",
            attempt_count=1,
        )
        ledger = Table([row])
        receipt = {
            "currentMaterializationVersion": replay.CURRENT_MATERIALIZATION_VERSION,
            "artifacts": [{
                "messageId": row["messageId"],
                "attachmentId": "message-body-html-1",
                "sourceReportType": "momo-tracker",
                "targetProductType": "momo-tracker",
                "expectedAction": replay.FORCE_VERSION_REPLAY,
                "sourceStatus": "ERROR",
                "sourceMaterializationStatus": "ERROR",
                "contentSha256": row["contentSha256"],
                "s3Bucket": "hedgeye-test",
                "s3Key": row["s3Key"],
                "sourceAttemptVersion": row["materializationAttemptVersion"],
                "sourceAttemptCount": 1,
            }],
        }
        self.assertTrue(replay.verify_receipt_rows(ledger, receipt)[0]["needsRetry"])
        row.update({
            "status": "INDEXED",
            "materializationStatus": "INDEXED",
            "materializationAttemptVersion": replay.CURRENT_MATERIALIZATION_VERSION,
            "snapshotType": "momo-tracker",
            "researchParserVersion": replay.RESEARCH_PARSER_VERSION,
            "securityIntelligenceParserVersion": (
                "security-intelligence-v3-tracker-contract"
            ),
        })
        ledger.rows = [row]
        self.assertTrue(replay.verify_receipt_rows(ledger, receipt)[0]["needsRetry"])
        row["securityIntelligenceParserVersion"] = (
            replay.SECURITY_INTELLIGENCE_PARSER_VERSION
        )
        ledger.rows = [row]
        self.assertFalse(replay.verify_receipt_rows(ledger, receipt)[0]["needsRetry"])

    def test_invocation_rejects_quarantine_or_error_response(self):
        class Lambda:
            def invoke(self, **_kwargs):
                return {
                    "StatusCode": 200,
                    "Payload": io.BytesIO(
                        b'{"statusCode":200,"body":"{\\"status\\":\\"ATTENTION\\",\\"errorCount\\":1,\\"quarantinedCount\\":1}"}'
                    ),
                }

        with self.assertRaisesRegex(replay.ReplayFailure, "did not materialize"):
            replay.invoke_one(Lambda(), "0000000000000001")

    def test_force_and_reconciliation_invocations_use_distinct_contracts(self):
        class Lambda:
            def __init__(self):
                self.payloads = []

            def invoke(self, **kwargs):
                self.payloads.append(json.loads(kwargs["Payload"]))
                return {
                    "StatusCode": 200,
                    "Payload": io.BytesIO(
                        b'{"statusCode":200,"body":"{\\"status\\":\\"ATTENTION\\",\\"errorCount\\":0,\\"remainingCount\\":0,\\"quarantinedCount\\":7}"}'
                    ),
                }

        client = Lambda()
        replay.invoke_one(client, "0000000000000001")
        replay.invoke_one(
            client,
            "0000000000000008",
            action=replay.CANONICAL_RECONCILE,
        )
        self.assertEqual(
            client.payloads[0],
            {
                "messageIds": ["0000000000000001"],
                "source": replay.OPERATOR_REPLAY_SOURCE,
                "forceBackfill": True,
                "materializationVersion": replay.CURRENT_MATERIALIZATION_VERSION,
            },
        )
        self.assertEqual(
            client.payloads[1],
            {
                "messageIds": ["0000000000000008"],
                "source": "operator-targeted-reconcile",
            },
        )

    def test_apply_guards_reject_enabled_schedule_wrong_build_and_hash_drift(self):
        schedule = {
            "Name": replay.SCHEDULE,
            "State": "ENABLED",
            "ScheduleExpression": replay.SCHEDULE_EXPRESSION,
            "Target": {
                "Arn": replay.FUNCTION_ARN,
                "Input": json.dumps(
                    {
                        "poll": "incremental",
                        "scheduleId": replay.SCHEDULE,
                        "source": "aws-scheduler",
                    }
                ),
            },
        }
        with self.assertRaises(replay.ReplayFailure):
            replay.validate_schedule(schedule, "DISABLED")
        with self.assertRaises(replay.ReplayFailure):
            replay.validate_function(
                {
                    "FunctionName": replay.FUNCTION,
                    "State": "Active",
                    "LastUpdateStatus": "Successful",
                    "Environment": {"Variables": {"BUILD_VERSION": "wrong"}},
                },
                "a" * 40,
            )
        selected = {
            "s3Bucket": "test",
            "s3Key": "immutable/source.html",
            "contentSha256": hashlib.sha256(b"expected").hexdigest(),
            "archivedByteSize": len(b"expected"),
        }
        with self.assertRaisesRegex(replay.ReplayFailure, "hash"):
            replay.verify_artifact_hash(
                S3({"immutable/source.html": b"changed!"}),
                selected,
            )

    def test_cli_has_no_arbitrary_message_id_surface(self):
        with redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            replay.parse_args(
                [
                    "--prepare",
                    "--receipt",
                    "/tmp/receipt.json",
                    "--receipt-key",
                    "/tmp/receipt.key",
                    "--message-id",
                    "0000000000000001",
                ]
            )

    def test_materialization_contract_verifies_manifest_and_outbucket_entity(self):
        content = "a" * 64
        artifact = {
            "artifactId": content,
            "contentSha256": content,
            "sourceMessageId": "m1",
            "stage": "indexed",
            "eventCount": 1,
            "parserVersion": replay.SECURITY_INTELLIGENCE_PARSER_VERSION,
        }
        manifest = {
            "marketDate": "2026-08-13",
            "productKey": "momo-tracker",
            "state": "indexed",
            "parserVersion": replay.SECURITY_INTELLIGENCE_PARSER_VERSION,
            "artifacts": [artifact],
            "manifestChecksum": replay._manifest_checksum([artifact]),
        }
        resources = Resource({
            replay.MANIFEST_TABLE: Table([manifest]),
            replay.EVENT_LEDGER_TABLE: Table([]),
            replay.ENTITY_EVENTS_TABLE: Table([{
                "entityKey": "ticker#ORCL",
                "eventKey": "2026-08-13#event",
                "marketDate": "2026-08-13",
                "sourceMessageId": "m1",
                "contentSha256": content,
                "parserVersion": replay.SECURITY_INTELLIGENCE_PARSER_VERSION,
                "qualityStatus": "validated",
                "eventType": "trade_signal",
                "signalValue": "BULLISH",
                "decisionEligible": True,
            }]),
        })
        replay.verify_materialization_contract(resources, {
            "messageId": "m1",
            "reportType": "momo-tracker",
            "snapshotType": "momo-tracker",
            "snapshotDate": "2026-08-13",
            "contentSha256": content,
            "researchEventCount": 0,
            "researchEntityEventCount": 1,
        })

    def test_materialization_contract_rejects_bad_manifest_checksum(self):
        resources = Resource({
            replay.MANIFEST_TABLE: Table([{
                "state": "indexed",
                "parserVersion": replay.SECURITY_INTELLIGENCE_PARSER_VERSION,
                "artifacts": [],
                "manifestChecksum": "0" * 64,
            }]),
            replay.EVENT_LEDGER_TABLE: Table([]),
            replay.ENTITY_EVENTS_TABLE: Table([]),
        })
        with self.assertRaisesRegex(replay.ReplayFailure, "manifest"):
            replay.verify_materialization_contract(resources, {
                "messageId": "m1",
                "reportType": "momo-tracker",
                "snapshotType": "momo-tracker",
                "snapshotDate": "2026-08-13",
                "contentSha256": "a" * 64,
            })


if __name__ == "__main__":
    unittest.main()
