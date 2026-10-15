#!/usr/bin/env python3
"""Behavior checks for the all-disabled base SAM deployment entrypoint."""

from __future__ import annotations

import hashlib
import json
import os
import stat
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "infra" / "scripts"))

import prepare_tested_release as tested_release  # noqa: E402


SCRIPT = ROOT / "infra" / "scripts" / "deploy.sh"
EXPECTED_BUCKET = "market-dashboard-sam-artifacts-915328198276-us-west-1"
EXPECTED_ROLE = (
    "arn:aws:iam::915328198276:"
    "role/market-dashboard-cloudformation-deployment-v2"
)
CONTROL_VARIABLES = (
    "GMAIL_SCHEDULE_STATE",
    "HERMES_SCHEDULE_STATE",
    "HERMES_QUANT_ANALYST_SCHEDULE_STATE",
    "HERMES_QUANT_DEVELOPER_SCHEDULE_STATE",
    "HERMES_SECURITY_SCHEDULE_STATE",
    "HERMES_CLOUD_WATCHDOG_SCHEDULE_STATE",
    "OPERATIONAL_ALARMS_STATE",
)
CREDENTIAL_VARIABLES = (
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AWS_SECURITY_TOKEN",
    "AWS_PROFILE",
    "AWS_DEFAULT_PROFILE",
    "AWS_ROLE_ARN",
    "AWS_ROLE_SESSION_NAME",
    "AWS_WEB_IDENTITY_TOKEN_FILE",
    "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
    "AWS_CONTAINER_CREDENTIALS_FULL_URI",
    "AWS_CONTAINER_AUTHORIZATION_TOKEN",
    "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
    "AWS_SHARED_CREDENTIALS_FILE",
)


class DeployHarness:
    def __init__(self, temp_dir: str):
        self.temp_dir = Path(temp_dir)
        self.bin_dir = self.temp_dir / "bin"
        self.bin_dir.mkdir()
        self.log_path = self.temp_dir / "calls.jsonl"
        self.rollback_dir = self.temp_dir / "rollback"
        self.release_commit = subprocess.run(
            ["git", "-C", str(ROOT), "rev-parse", "HEAD"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
        self._write_rollback(passed=True)
        self._write_release_receipt()
        self._write_executable(
            "aws",
            """
            #!/usr/bin/env python3
            import json
            import os
            import sys

            args = sys.argv[1:]
            credentials = [
                "AWS_ACCESS_KEY_ID",
                "AWS_SECRET_ACCESS_KEY",
                "AWS_SESSION_TOKEN",
                "AWS_SECURITY_TOKEN",
                "AWS_PROFILE",
                "AWS_DEFAULT_PROFILE",
                "AWS_ROLE_ARN",
                "AWS_ROLE_SESSION_NAME",
                "AWS_WEB_IDENTITY_TOKEN_FILE",
                "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
                "AWS_CONTAINER_CREDENTIALS_FULL_URI",
                "AWS_CONTAINER_AUTHORIZATION_TOKEN",
                "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
                "AWS_SHARED_CREDENTIALS_FILE",
            ]
            with open(os.environ["FAKE_DEPLOY_LOG"], "a", encoding="utf-8") as handle:
                handle.write(json.dumps({
                    "tool": "aws",
                    "args": args,
                    "ambient": {
                        key: os.environ[key]
                        for key in credentials
                        if key in os.environ
                    },
                }) + "\\n")

            if args == ["--version"]:
                print("aws-cli/2.36.8 Python/3.14 Darwin/25 source/arm64")
                raise SystemExit(0)
            if args[:2] == ["configure", "get"]:
                values = {
                    "region": "us-west-1",
                    "sso_account_id": "915328198276",
                    "sso_session": "market-dashboard",
                    "sso_start_url": "",
                }
                print(values.get(args[2], ""))
                raise SystemExit(0)
            if "sts" in args and "get-caller-identity" in args:
                print(
                    "915328198276\\t"
                    "arn:aws:sts::915328198276:assumed-role/"
                    "AWSReservedSSO_AdministratorAccess_deadbeef/user@example.com"
                )
                raise SystemExit(0)
            if "s3api" in args and "head-bucket" in args:
                raise SystemExit(0)
            if "s3api" in args and "get-bucket-tagging" in args:
                if os.environ.get("FAKE_BUCKET_TAGS") == "wrong":
                    print('{"TagSet":[{"Key":"owner","Value":"other"}]}')
                else:
                    print(
                        '{"TagSet":['
                        '{"Key":"market-dashboard:owner",'
                        '"Value":"market-dashboard-readiness-v2"},'
                        '{"Key":"market-dashboard:purpose",'
                        '"Value":"sam-artifacts"}]}'
                    )
                raise SystemExit(0)
            if "cloudformation" in args and "describe-stacks" in args:
                print(os.environ["FAKE_RELEASE_COMMIT"])
                raise SystemExit(0)
            if "cloudformation" in args and "get-template" in args:
                with open(
                    os.environ["FAKE_PACKAGED_TEMPLATE"],
                    "r",
                    encoding="utf-8",
                ) as handle:
                    print(json.dumps(handle.read()))
                raise SystemExit(0)
            print(f"Unexpected fake AWS call: {args}", file=sys.stderr)
            raise SystemExit(99)
            """,
        )
        self._write_executable(
            "sam",
            """
            #!/usr/bin/env python3
            import json
            import os
            import sys

            credentials = [
                "AWS_ACCESS_KEY_ID",
                "AWS_SECRET_ACCESS_KEY",
                "AWS_SESSION_TOKEN",
                "AWS_SECURITY_TOKEN",
                "AWS_PROFILE",
                "AWS_DEFAULT_PROFILE",
                "AWS_ROLE_ARN",
                "AWS_ROLE_SESSION_NAME",
                "AWS_WEB_IDENTITY_TOKEN_FILE",
                "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
                "AWS_CONTAINER_CREDENTIALS_FULL_URI",
                "AWS_CONTAINER_AUTHORIZATION_TOKEN",
                "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
                "AWS_SHARED_CREDENTIALS_FILE",
            ]
            with open(os.environ["FAKE_DEPLOY_LOG"], "a", encoding="utf-8") as handle:
                handle.write(json.dumps({
                    "tool": "sam",
                    "args": sys.argv[1:],
                    "cwd": os.getcwd(),
                    "ambient": {
                        key: os.environ[key]
                        for key in credentials
                        if key in os.environ
                    },
                }) + "\\n")
            raise SystemExit(0)
            """,
        )

    def _write_release_receipt(self) -> None:
        self.release_dir = self.temp_dir / "tested-release"
        self.release_dir.mkdir(mode=0o700)
        self.release_dir.chmod(0o700)
        self.packaged_template = self.release_dir / "packaged-template.yaml"
        self.packaged_template.write_text(
            "\n".join(
                [
                    "Parameters:",
                    "  BuildVersion:",
                    "    Type: String",
                    "Resources:",
                    "  Worker:",
                    "    Type: AWS::Serverless::Function",
                    "    Properties:",
                    "      CodeUri:",
                    f"        Bucket: {EXPECTED_BUCKET}",
                    "        Key: tested-releases/code.zip",
                    "        Version: version-1",
                    "",
                ]
            ),
            encoding="utf-8",
        )
        self.packaged_template.chmod(0o600)
        package = tested_release.validate_packaged_template(
            self.packaged_template
        )
        template_object = {
            "bucket": EXPECTED_BUCKET,
            "key": (
                f"tested-releases/{self.release_commit}/"
                "packaged-template.yaml"
            ),
            "versionId": "template-version-1",
            "contentSha256": package["sha256"],
            "contentLength": self.packaged_template.stat().st_size,
        }
        artifact_evidence = [
            {
                **artifact,
                "contentSha256": hashlib.sha256(b"artifact").hexdigest(),
                "contentLength": len(b"artifact"),
            }
            for artifact in package["artifacts"]
        ]
        metadata = tested_release.exact_commit_metadata(
            ROOT,
            self.release_commit,
        )
        archive = tested_release.git_archive_bytes(ROOT, self.release_commit)
        empty_hash = hashlib.sha256(b"").hexdigest()
        verifications = [
            {
                "id": verification_id,
                "command": list(command),
                "releaseCommit": self.release_commit,
                "passed": True,
                "returnCode": 0,
                "startedAt": "2026-07-27T20:00:00+00:00",
                "finishedAt": "2026-07-27T20:00:01+00:00",
                "stdoutSha256": empty_hash,
                "stderrSha256": empty_hash,
            }
            for verification_id, command in tested_release.VERIFICATION_COMMANDS
        ]
        payload = {
            "schemaVersion": tested_release.RECEIPT_SCHEMA_VERSION,
            "kind": tested_release.RECEIPT_KIND,
            "createdAt": "2026-07-27T20:00:02+00:00",
            "releaseCommit": self.release_commit,
            "releaseTree": metadata["tree"],
            "sourceArchiveSha256": tested_release.sha256_bytes(archive),
            "sourceManifestSha256": "1" * 64,
            "verifications": verifications,
            "package": {
                "templatePath": str(self.packaged_template),
                "templateSha256": package["sha256"],
                "templateCanonicalSha256": package["canonicalSha256"],
                "templateObject": template_object,
                "artifacts": artifact_evidence,
                "artifactBucket": EXPECTED_BUCKET,
            },
        }
        self.receipt_key = self.temp_dir / "receipt.key"
        self.receipt_key.write_bytes(b"k" * 32)
        self.receipt_key.chmod(0o600)
        self.release_receipt = (
            self.release_dir / "tested-release-receipt.json"
        )
        tested_release.write_receipt(
            self.release_receipt,
            tested_release.authenticated_receipt(
                payload,
                self.receipt_key.read_bytes(),
            ),
        )

    def _write_executable(self, name: str, source: str) -> None:
        path = self.bin_dir / name
        path.write_text(textwrap.dedent(source).lstrip(), encoding="utf-8")
        path.chmod(0o755)

    def _write_rollback(self, *, passed: bool) -> None:
        if not self.rollback_dir.exists():
            self.rollback_dir.mkdir(mode=0o700)
        self.rollback_dir.chmod(0o700)
        preflight_path = self.rollback_dir / "ownership-preflight.json"
        conflicts = [] if passed else [{"code": "TEST_CONFLICT"}]
        preflight_path.write_text(
            json.dumps(
                {
                    "passed": passed,
                    "conflicts": conflicts,
                    "account": "915328198276",
                    "region": "us-west-1",
                    "targetStack": "market-dashboard-readiness-v2",
                    "bootstrapStack": "market-dashboard-deployment-role-v2",
                },
                sort_keys=True,
            )
            + "\n",
            encoding="utf-8",
        )
        digest = hashlib.sha256(preflight_path.read_bytes()).hexdigest()
        (self.rollback_dir / "SHA256SUMS").write_text(
            f"{digest}  ./ownership-preflight.json\n",
            encoding="utf-8",
        )

    def environment(self, **overrides: str) -> dict[str, str]:
        environment = os.environ.copy()
        environment.update(
            {
                "PATH": f"{self.bin_dir}:{environment['PATH']}",
                "FAKE_DEPLOY_LOG": str(self.log_path),
                "MARKET_DASHBOARD_CF_ROLE_ARN": EXPECTED_ROLE,
                "MARKET_DASHBOARD_SAM_ARTIFACT_BUCKET": EXPECTED_BUCKET,
                "MARKET_DASHBOARD_ROLLBACK_EXPORT": str(self.rollback_dir),
                "MARKET_DASHBOARD_RELEASE_COMMIT": self.release_commit,
                "MARKET_DASHBOARD_RELEASE_RECEIPT": str(
                    self.release_receipt
                ),
                "MARKET_DASHBOARD_RELEASE_RECEIPT_KEY": str(
                    self.receipt_key
                ),
                "MARKET_DASHBOARD_BUILD_VERSION": self.release_commit,
                "FAKE_RELEASE_COMMIT": self.release_commit,
                "FAKE_PACKAGED_TEMPLATE": str(self.packaged_template),
            }
        )
        environment.update(
            {name: f"poison-{name.lower()}" for name in CREDENTIAL_VARIABLES}
        )
        environment.update(overrides)
        return environment

    def run(self, **overrides: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [str(SCRIPT)],
            cwd=ROOT,
            env=self.environment(**overrides),
            check=False,
            capture_output=True,
            text=True,
        )

    def calls(self) -> list[dict]:
        if not self.log_path.exists():
            return []
        return [
            json.loads(line)
            for line in self.log_path.read_text(encoding="utf-8").splitlines()
        ]


class DeployScriptTests(unittest.TestCase):
    def test_valid_base_deploy_is_pinned_and_all_disabled(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            harness = DeployHarness(temp_dir)
            result = harness.run()

            self.assertEqual(result.returncode, 0, result.stderr)
            calls = harness.calls()
            self.assertTrue(calls)
            self.assertTrue(all(call["ambient"] == {} for call in calls))
            sam_calls = [call for call in calls if call["tool"] == "sam"]
            self.assertEqual(
                [call["args"][0] for call in sam_calls],
                ["deploy"],
            )
            deploy_args = sam_calls[-1]["args"]
            self.assertEqual(
                Path(sam_calls[-1]["cwd"]).resolve(),
                harness.release_dir.resolve(),
            )
            self.assertNotIn("--config-file", deploy_args)
            for override in (
                "GmailScheduleState=DISABLED",
                "CftcScheduleState=DISABLED",
                "QuantAnalystScheduleState=DISABLED",
                "QuantDeveloperScheduleState=DISABLED",
                "SecurityScheduleState=DISABLED",
                "OperationalAlarmsState=DISABLED",
                "ReservedConcurrencyState=DISABLED",
                f"BuildVersion={harness.release_commit}",
            ):
                self.assertIn(override, deploy_args)
            self.assertFalse(any("=ENABLED" in value for value in deploy_args))
            self.assertEqual(
                deploy_args[deploy_args.index("--stack-name") + 1],
                "market-dashboard-readiness-v2",
            )
            self.assertEqual(
                deploy_args[deploy_args.index("--s3-bucket") + 1],
                EXPECTED_BUCKET,
            )
            self.assertEqual(
                deploy_args[deploy_args.index("--role-arn") + 1],
                EXPECTED_ROLE,
            )
            self.assertEqual(
                Path(
                    deploy_args[deploy_args.index("--template-file") + 1]
                ).resolve(),
                harness.packaged_template.resolve(),
            )
            self.assertIn(
                "market-dashboard:owner=market-dashboard-readiness-v2",
                deploy_args,
            )
            self.assertIn(
                "market-dashboard:purpose=readiness-stack",
                deploy_args,
            )

    def test_any_enabled_or_invalid_control_is_rejected_before_tools_run(self):
        for control_name in CONTROL_VARIABLES:
            with self.subTest(control_name=control_name):
                with tempfile.TemporaryDirectory() as temp_dir:
                    harness = DeployHarness(temp_dir)
                    result = harness.run(**{control_name: "ENABLED"})

                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn("Base deployment is all-disabled", result.stderr)
                    self.assertEqual(harness.calls(), [])

    def test_release_commit_and_build_version_must_be_exact(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            harness = DeployHarness(temp_dir)
            result = harness.run(
                MARKET_DASHBOARD_RELEASE_COMMIT="not-a-commit",
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("40-character tested commit", result.stderr)
            self.assertEqual(harness.calls(), [])

        with tempfile.TemporaryDirectory() as temp_dir:
            harness = DeployHarness(temp_dir)
            result = harness.run(
                MARKET_DASHBOARD_BUILD_VERSION="different-build",
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn(
                "must equal MARKET_DASHBOARD_RELEASE_COMMIT",
                result.stderr,
            )
            self.assertEqual(harness.calls(), [])

    def test_verified_rollback_export_is_mandatory(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            harness = DeployHarness(temp_dir)
            result = harness.run(MARKET_DASHBOARD_ROLLBACK_EXPORT="")

            self.assertNotEqual(result.returncode, 0)
            self.assertIn("absolute verified rollback export", result.stderr)
            self.assertEqual(harness.calls(), [])

        with tempfile.TemporaryDirectory() as temp_dir:
            harness = DeployHarness(temp_dir)
            harness._write_rollback(passed=False)
            result = harness.run()

            self.assertNotEqual(result.returncode, 0)
            self.assertIn("ownership preflight did not pass", result.stderr)
            self.assertEqual(harness.calls(), [])

        with tempfile.TemporaryDirectory() as temp_dir:
            harness = DeployHarness(temp_dir)
            (harness.rollback_dir / "ownership-preflight.json").write_text(
                "{}\n",
                encoding="utf-8",
            )
            result = harness.run()

            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(harness.calls(), [])

    def test_artifact_bucket_tag_mismatch_stops_before_sam(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            harness = DeployHarness(temp_dir)
            result = harness.run(FAKE_BUCKET_TAGS="wrong")

            self.assertNotEqual(result.returncode, 0)
            self.assertIn("ownership tag does not match", result.stderr)
            self.assertFalse(
                any(call["tool"] == "sam" for call in harness.calls())
            )

    def test_rollback_export_must_remain_private(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            harness = DeployHarness(temp_dir)
            harness.rollback_dir.chmod(
                stat.S_IMODE(harness.rollback_dir.stat().st_mode) | 0o040
            )
            result = harness.run()

            self.assertNotEqual(result.returncode, 0)
            self.assertIn("must not be accessible", result.stderr)
            self.assertEqual(harness.calls(), [])


if __name__ == "__main__":
    unittest.main()
