#!/usr/bin/env python3
"""Focused tests for guarded, deterministic Risk Range artifact replay."""

from __future__ import annotations

import contextlib
import hashlib
import io
import sys
import tempfile
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "infra" / "scripts"))

import replay_risk_range_artifact as replay  # noqa: E402


HTML = b"<html><body>immutable primary risk ranges</body></html>"
CONTENT_SHA256 = hashlib.sha256(HTML).hexdigest()
SOURCE = {
    "messageId": "gmail-risk-newest",
    "attachmentId": "message-body-gmail-risk-newest",
    "status": "ERROR",
    "reportType": "risk-ranges",
    "mimeType": "text/html",
    "subject": "Hedgeye Risk Ranges",
    "receivedAt": "2026-07-24T12:30:00+00:00",
    "updatedAt": "2026-07-24T12:31:00+00:00",
    "s3Bucket": replay.RAW_ARTIFACT_BUCKET,
    "s3Key": (
        "hedgeye-email/messages/2026-07-24/risk-ranges/"
        "gmail-risk-newest-message-body.html"
    ),
    "contentSha256": CONTENT_SHA256,
    "byteSize": len(HTML),
}
SNAPSHOT = {
    "date": "2026-07-24",
    "snapshotType": "risk-ranges",
    "reportType": "risk-ranges",
    "scrapedAt": "2026-07-24T12:30:00+00:00",
    "publishedAt": "2026-07-24",
    "source": "gmail-html",
    "htmlSource": SOURCE["s3Key"],
    "gmailMessageId": SOURCE["messageId"],
    "data": {
        "SPY": {
            "lrr": 620.5,
            "hrr": 631.2,
            "trend": "BULLISH",
        }
    },
}


def canonical_resource_names() -> dict[str, str]:
    return {
        "gmailLedger": replay.GMAIL_LEDGER_TABLE,
        "rawArtifactBucket": replay.RAW_ARTIFACT_BUCKET,
        "researchEventLedger": replay.RESEARCH_EVENT_LEDGER_TABLE,
        "researchEntityEvents": replay.RESEARCH_ENTITY_EVENTS_TABLE,
        "researchProductManifest": replay.RESEARCH_PRODUCT_MANIFEST_TABLE,
        "riskRangeData": replay.RISK_RANGE_DATA_TABLE,
        "riskRangeHistory": replay.RISK_RANGE_HISTORY_TABLE,
        "riskRangeManifest": replay.RISK_RANGE_MANIFEST_TABLE,
    }


class FakeTable:
    def __init__(self, *, scan_pages=None, item=None):
        self.scan_pages = list(scan_pages or [])
        self.item = item
        self.scan_calls = []

    def scan(self, **kwargs):
        self.scan_calls.append(kwargs)
        if not self.scan_pages:
            return {"Items": []}
        return self.scan_pages.pop(0)

    def get_item(self, **_kwargs):
        return {"Item": self.item} if self.item is not None else {}

    def query(self, **_kwargs):
        return {"Items": [self.item]} if self.item is not None else {"Items": []}


class FakeDynamoDb:
    def __init__(self, source=SOURCE):
        self.tables = {
            replay.GMAIL_LEDGER_TABLE: FakeTable(
                scan_pages=[{"Items": [dict(source)]}]
            ),
            replay.RISK_RANGE_MANIFEST_TABLE: FakeTable(),
            replay.RESEARCH_PRODUCT_MANIFEST_TABLE: FakeTable(),
        }

    def Table(self, name):
        return self.tables[name]


class FakeS3:
    def __init__(
        self,
        *,
        body=HTML,
        metadata=None,
        version_id="version-7",
        head_responses=None,
    ):
        self.body = body
        self.metadata = metadata or {
            "content-sha256": CONTENT_SHA256,
            "report-type": "risk-ranges",
            "gmail-message-id": SOURCE["messageId"],
            "gmail-attachment-id": SOURCE["attachmentId"],
        }
        self.version_id = version_id
        self.head_responses = list(head_responses or [])
        self.get_calls = []

    def head_object(self, **_kwargs):
        if self.head_responses:
            return self.head_responses.pop(0)
        return {"VersionId": self.version_id}

    def get_object(self, **kwargs):
        self.get_calls.append(kwargs)
        return {
            "VersionId": self.version_id,
            "Metadata": dict(self.metadata),
            "Body": io.BytesIO(self.body),
        }


class FakeSts:
    def __init__(self, identity=None):
        self.identity = identity or {
            "Account": replay.EXPECTED_ACCOUNT,
            "Arn": (
                f"{replay.SSO_ARN_PREFIX}"
                "AdministratorAccess_abcdef/tim@example.com"
            ),
        }

    def get_caller_identity(self):
        return dict(self.identity)


class FakeSession:
    def __init__(self, dynamodb, s3, *, identity=None):
        self.region_name = replay.EXPECTED_REGION
        self.dynamodb = dynamodb
        self.s3 = s3
        self.sts = FakeSts(identity)

    def resource(self, name):
        if name != "dynamodb":
            raise AssertionError(name)
        return self.dynamodb

    def client(self, name):
        if name == "s3":
            return self.s3
        if name == "sts":
            return self.sts
        raise AssertionError(name)


def verified_product_manifest(contract, source=SOURCE):
    artifact = {
        "artifactId": CONTENT_SHA256,
        "contentSha256": CONTENT_SHA256,
        "stage": "indexed",
        "eventCount": 1,
        "parserVersion": contract.research_product_parser_version,
        "sourceMessageId": source["messageId"],
        "sourceKey": source["s3Key"],
    }
    artifacts = [artifact]
    return {
        "marketDate": SNAPSHOT["date"],
        "productKey": "risk-ranges",
        "state": "indexed",
        "failedCount": 0,
        "indexedCount": 1,
        "receivedCount": 1,
        "manifestChecksum": replay.product_manifest_checksum(artifacts),
        "parserVersion": contract.research_product_parser_version,
        "artifacts": artifacts,
    }


def fake_contract(dynamodb, calls):
    contract = None

    def parse(**kwargs):
        calls.append(("parse", kwargs))
        return dict(SNAPSHOT)

    def persist_ledger(snapshot, db, *, content_sha256):
        calls.append(("ledger", snapshot["date"], content_sha256))
        return 1

    def persist_intelligence(snapshot, db, *, content_sha256, finalize):
        calls.append(
            ("intelligence", snapshot["date"], content_sha256, finalize)
        )
        if finalize:
            raise AssertionError("primary replay must defer intelligence finalization")
        return 1

    def finalize_intelligence(
        snapshot,
        db,
        *,
        content_sha256,
        event_count,
    ):
        calls.append(
            (
                "finalize",
                snapshot["date"],
                content_sha256,
                event_count,
            )
        )
        db.tables[replay.RESEARCH_PRODUCT_MANIFEST_TABLE].item = (
            verified_product_manifest(contract)
        )
        return db.tables[replay.RESEARCH_PRODUCT_MANIFEST_TABLE].item

    def materialize(snapshot, db):
        calls.append(("materialize", snapshot["date"]))
        db.tables[replay.RISK_RANGE_MANIFEST_TABLE].item = replay.expected_primary(
            snapshot,
            SOURCE,
            contract,
        )
        return snapshot, True

    contract = replay.CanonicalContract(
        parse_html_snapshot=parse,
        persist_research_event_ledger=persist_ledger,
        persist_snapshot_intelligence=persist_intelligence,
        finalize_snapshot_intelligence=finalize_intelligence,
        materialize_email_snapshot=materialize,
        risk_range_parser_version="risk-range-email-v2",
        research_product_parser_version="security-intelligence-v2",
        resource_names=canonical_resource_names(),
    )
    return contract


class RiskRangeReplayTests(unittest.TestCase):
    def test_cli_is_dry_run_and_accepts_no_artifact_identifier(self):
        args = replay.parse_args([])
        self.assertFalse(args.apply)
        self.assertEqual(args.read_profile, replay.DEFAULT_READ_PROFILE)
        with contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit):
                replay.parse_args(["--message-id", "caller-chosen"])

    def test_server_selects_newest_eligible_source_across_scan_pages(self):
        older = {
            **SOURCE,
            "messageId": "older",
            "attachmentId": "message-body-older",
            "receivedAt": "2026-07-23T12:30:00+00:00",
        }
        in_progress = {
            **SOURCE,
            "messageId": "newer-but-in-progress",
            "attachmentId": "message-body-in-progress",
            "receivedAt": "2026-07-25T12:30:00+00:00",
            "status": "IN_PROGRESS",
        }
        table = FakeTable(
            scan_pages=[
                {
                    "Items": [older, in_progress],
                    "LastEvaluatedKey": {"messageId": "page-1"},
                },
                {"Items": [SOURCE]},
            ]
        )

        selected = replay.select_newest_source(table)

        self.assertEqual(selected["messageId"], SOURCE["messageId"])
        self.assertEqual(len(table.scan_calls), 2)
        self.assertTrue(all(call["ConsistentRead"] for call in table.scan_calls))

    def test_source_verification_pins_version_and_requires_three_matching_hashes(self):
        s3 = FakeS3()

        artifact = replay.load_verified_artifact(s3, SOURCE)

        self.assertEqual(artifact["contentSha256"], CONTENT_SHA256)
        self.assertEqual(artifact["versionId"], "version-7")
        self.assertEqual(s3.get_calls[0]["VersionId"], "version-7")

        mismatched = FakeS3(
            metadata={
                **s3.metadata,
                "content-sha256": "0" * 64,
            }
        )
        with self.assertRaisesRegex(
            replay.ReplayFailure,
            "checksum evidence does not agree",
        ) as raised:
            replay.load_verified_artifact(mismatched, SOURCE)
        self.assertEqual(
            raised.exception.code,
            "RISK_RANGE_SOURCE_CHECKSUM_MISMATCH",
        )

    def test_stable_unversioned_source_uses_existing_checksum_contract(self):
        artifact = replay.load_verified_artifact(
            FakeS3(version_id="null"),
            SOURCE,
        )
        self.assertIsNone(artifact["versionId"])
        self.assertEqual(
            artifact["immutabilityEvidence"],
            "stable-read+ledger-metadata-body-sha256",
        )

    def test_unversioned_source_that_changes_during_read_is_blocked(self):
        s3 = FakeS3(
            version_id="null",
            head_responses=[
                {"ETag": '"before"', "ContentLength": len(HTML)},
                {"ETag": '"after"', "ContentLength": len(HTML)},
            ],
        )
        with self.assertRaises(replay.ReplayFailure) as raised:
            replay.load_verified_artifact(s3, SOURCE)
        self.assertEqual(
            raised.exception.code,
            "RISK_RANGE_SOURCE_CHANGED_DURING_READ",
        )
        self.assertTrue(raised.exception.approval_only)

    def test_dry_run_parses_but_never_invokes_canonical_writers(self):
        dynamodb = FakeDynamoDb()
        calls = []
        contract = fake_contract(dynamodb, calls)
        session = FakeSession(dynamodb, FakeS3())

        result = replay.replay(
            session_factory=lambda **_kwargs: session,
            contract_loader=lambda: contract,
        )

        self.assertEqual(result["code"], "RISK_RANGE_REPLAY_DRY_RUN_READY")
        self.assertEqual(result["status"], "ready_for_apply")
        self.assertFalse(result["mutation"]["performed"])
        self.assertTrue(result["manualAction"]["approvalRequired"])
        self.assertEqual(result["manualAction"]["command"], replay.APPLY_COMMAND)
        self.assertEqual([call[0] for call in calls], ["parse"])

    def test_exact_existing_manifests_make_replay_idempotent(self):
        dynamodb = FakeDynamoDb()
        calls = []
        contract = fake_contract(dynamodb, calls)
        dynamodb.tables[replay.RISK_RANGE_MANIFEST_TABLE].item = (
            replay.expected_primary(SNAPSHOT, SOURCE, contract)
        )
        dynamodb.tables[replay.RESEARCH_PRODUCT_MANIFEST_TABLE].item = (
            verified_product_manifest(contract)
        )

        result = replay.replay(
            session_factory=lambda **_kwargs: FakeSession(dynamodb, FakeS3()),
            contract_loader=lambda: contract,
        )

        self.assertEqual(result["code"], "RISK_RANGE_REPLAY_IDEMPOTENT")
        self.assertFalse(result["mutation"]["performed"])
        self.assertEqual([call[0] for call in calls], ["parse"])

    def test_different_completed_primary_book_is_never_overwritten(self):
        dynamodb = FakeDynamoDb()
        calls = []
        contract = fake_contract(dynamodb, calls)
        dynamodb.tables[replay.RISK_RANGE_MANIFEST_TABLE].item = {
            **replay.expected_primary(SNAPSHOT, SOURCE, contract),
            "checksum": "f" * 64,
            "sourceMessageId": "different-message",
            "sourceArtifact": "different-key",
        }

        with self.assertRaises(replay.ReplayFailure) as raised:
            replay.replay(
                session_factory=lambda **_kwargs: FakeSession(
                    dynamodb,
                    FakeS3(),
                ),
                contract_loader=lambda: contract,
            )

        self.assertEqual(
            raised.exception.code,
            "RISK_RANGE_PRIMARY_MANIFEST_CONFLICT",
        )
        self.assertTrue(raised.exception.approval_only)
        self.assertEqual([call[0] for call in calls], ["parse"])

    def test_apply_requires_exact_admin_sso_profile_before_aws_calls(self):
        called = False

        def session_factory(**_kwargs):
            nonlocal called
            called = True
            raise AssertionError("session must not be created")

        with self.assertRaises(replay.ReplayFailure) as raised:
            replay.replay(
                apply=True,
                admin_profile="default",
                session_factory=session_factory,
            )

        self.assertEqual(raised.exception.code, "AWS_SSO_PROFILE_REQUIRED")
        self.assertFalse(called)

    def test_apply_runs_canonical_path_and_post_verifies_both_manifests(self):
        dynamodb = FakeDynamoDb()
        calls = []
        contract = fake_contract(dynamodb, calls)
        session = FakeSession(dynamodb, FakeS3())
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / "config"
            config.write_text(
                "\n".join(
                    [
                        "[profile market-dashboard-admin]",
                        f"sso_account_id = {replay.EXPECTED_ACCOUNT}",
                        "sso_role_name = AdministratorAccess",
                        "sso_session = dashboard",
                        f"region = {replay.EXPECTED_REGION}",
                        "",
                        "[sso-session dashboard]",
                        "sso_start_url = https://example.awsapps.com/start",
                        "sso_region = us-west-2",
                        "",
                    ]
                ),
                encoding="utf-8",
            )

            result = replay.replay(
                apply=True,
                session_factory=lambda **_kwargs: session,
                config_path=config,
                contract_loader=lambda: contract,
            )

        self.assertEqual(result["code"], "RISK_RANGE_REPLAY_VERIFIED")
        self.assertTrue(result["mutation"]["performed"])
        self.assertTrue(result["verification"]["primaryManifest"]["passed"])
        self.assertTrue(
            result["verification"]["researchProductMatrix"]["passed"]
        )
        self.assertEqual(
            [call[0] for call in calls],
            ["parse", "ledger", "intelligence", "materialize", "finalize"],
        )
        self.assertFalse(calls[2][3])

    def test_apply_never_finalizes_intelligence_when_materialization_fails(self):
        dynamodb = FakeDynamoDb()
        calls = []
        contract = fake_contract(dynamodb, calls)

        def fail_materialization(snapshot, db):
            calls.append(("materialize-failed", snapshot["date"]))
            raise RuntimeError("projection failed")

        contract = replay.CanonicalContract(
            **{
                **contract.__dict__,
                "materialize_email_snapshot": fail_materialization,
            }
        )
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / "config"
            config.write_text(
                "\n".join(
                    [
                        "[profile market-dashboard-admin]",
                        f"sso_account_id = {replay.EXPECTED_ACCOUNT}",
                        "sso_role_name = AdministratorAccess",
                        "sso_session = dashboard",
                        f"region = {replay.EXPECTED_REGION}",
                        "",
                        "[sso-session dashboard]",
                        "sso_start_url = https://example.awsapps.com/start",
                        "sso_region = us-west-2",
                        "",
                    ]
                ),
                encoding="utf-8",
            )

            with self.assertRaisesRegex(RuntimeError, "projection failed"):
                replay.replay(
                    apply=True,
                    session_factory=lambda **_kwargs: FakeSession(
                        dynamodb,
                        FakeS3(),
                    ),
                    config_path=config,
                    contract_loader=lambda: contract,
                )

        self.assertEqual(
            [call[0] for call in calls],
            ["parse", "ledger", "intelligence", "materialize-failed"],
        )

    def test_product_matrix_checksum_drift_is_not_verified(self):
        contract = fake_contract(FakeDynamoDb(), [])
        manifest = verified_product_manifest(contract)
        manifest["manifestChecksum"] = "0" * 64

        result = replay.verify_product_manifest(
            manifest,
            market_date=SNAPSHOT["date"],
            source=SOURCE,
            content_sha256=CONTENT_SHA256,
            contract=contract,
        )

        self.assertFalse(result["passed"])
        self.assertIn("manifestChecksum", result["mismatches"])

    def test_environment_resource_drift_blocks_before_mutation(self):
        dynamodb = FakeDynamoDb()
        calls = []
        contract = fake_contract(dynamodb, calls)
        contract = replay.CanonicalContract(
            **{
                **contract.__dict__,
                "resource_names": {
                    **contract.resource_names,
                    "riskRangeManifest": "CallerSelectedTable",
                },
            }
        )

        with self.assertRaises(replay.ReplayFailure) as raised:
            replay.replay(
                session_factory=lambda **_kwargs: FakeSession(
                    dynamodb,
                    FakeS3(),
                ),
                contract_loader=lambda: contract,
            )

        self.assertEqual(
            raised.exception.code,
            "RISK_RANGE_CANONICAL_RESOURCE_DRIFT",
        )
        self.assertTrue(raised.exception.approval_only)
        self.assertEqual(calls, [])


if __name__ == "__main__":
    unittest.main()
