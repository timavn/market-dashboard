import json
import os
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "infra" / "scripts" / "prepare_artifact_bucket.sh"
EXPECTED_BUCKET = "market-dashboard-sam-artifacts-915328198276-us-west-1"


class ArtifactBucketHarness:
    def __init__(self, temp_dir):
        self.temp_dir = Path(temp_dir)
        self.bin_dir = self.temp_dir / "bin"
        self.bin_dir.mkdir()
        self.log_path = self.temp_dir / "aws-calls.jsonl"
        self.state_dir = self.temp_dir / "state"
        self.state_dir.mkdir()
        self.aws_path = self.bin_dir / "aws"
        self.aws_path.write_text(
            textwrap.dedent(
                """
                #!/usr/bin/env python3
                import json
                import os
                import pathlib
                import sys

                args = sys.argv[1:]
                state_dir = pathlib.Path(os.environ["FAKE_AWS_STATE_DIR"])
                credential_names = (
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
                record = {
                    "args": args,
                    "ambient_credentials": {
                        name: os.environ.get(name)
                        for name in credential_names
                        if os.environ.get(name)
                    },
                }
                with open(os.environ["FAKE_AWS_LOG"], "a", encoding="utf-8") as handle:
                    handle.write(json.dumps(record) + "\\n")

                if args == ["--version"]:
                    print(os.environ.get("FAKE_AWS_VERSION", "aws-cli/2.17.0 Python/3.12"))
                    raise SystemExit(0)

                if args[:2] == ["configure", "get"]:
                    values = {
                        "region": os.environ.get("FAKE_PROFILE_REGION", "us-west-1"),
                        "sso_account_id": os.environ.get(
                            "FAKE_PROFILE_ACCOUNT", "915328198276"
                        ),
                        "sso_session": os.environ.get(
                            "FAKE_SSO_SESSION", "market-dashboard-admin"
                        ),
                        "sso_start_url": os.environ.get(
                            "FAKE_SSO_START_URL", "https://example.awsapps.com/start"
                        ),
                        "sso_role_name": os.environ.get(
                            "FAKE_SSO_ROLE_NAME", "AdministratorAccess"
                        ),
                    }
                    value = values.get(args[2], "")
                    if value:
                        print(value)
                        raise SystemExit(0)
                    raise SystemExit(1)

                operation = ()
                for index, argument in enumerate(args):
                    if argument in {"sts", "s3api"}:
                        operation = (argument, args[index + 1])
                        break

                if operation == ("sts", "get-caller-identity"):
                    account = os.environ.get(
                        "FAKE_CALLER_ACCOUNT", "915328198276"
                    )
                    arn = os.environ.get(
                        "FAKE_CALLER_ARN",
                        (
                            "arn:aws:sts::915328198276:assumed-role/"
                            "AWSReservedSSO_AdministratorAccess_abcd/session"
                        ),
                    )
                    print(f"{account}\\t{arn}")
                    raise SystemExit(0)

                if operation == ("s3api", "head-bucket"):
                    mode = os.environ.get("FAKE_HEAD_MODE", "existing")
                    if mode == "absent" and not (state_dir / "bucket-created").exists():
                        print(
                            "An error occurred (404) when calling the HeadBucket "
                            "operation: Not Found",
                            file=sys.stderr,
                        )
                        raise SystemExit(254)
                    if mode == "access-denied":
                        print(
                            "An error occurred (403) when calling the HeadBucket "
                            "operation: Forbidden",
                            file=sys.stderr,
                        )
                        raise SystemExit(254)
                    if mode == "network":
                        print(
                            "Could not connect to the endpoint URL: "
                            '"https://s3.us-west-1.amazonaws.com/"',
                            file=sys.stderr,
                        )
                        raise SystemExit(255)
                    raise SystemExit(0)

                if operation == ("s3api", "create-bucket"):
                    (state_dir / "bucket-created").touch()
                    print(json.dumps({
                        "Location": (
                            "/market-dashboard-sam-artifacts-"
                            "915328198276-us-west-1"
                        )
                    }))
                    raise SystemExit(0)

                if operation == ("s3api", "put-bucket-tagging"):
                    (state_dir / "tags-created").touch()
                    raise SystemExit(0)

                if operation == ("s3api", "get-bucket-tagging"):
                    mode = os.environ.get("FAKE_TAG_MODE", "exact")
                    if mode == "access-denied":
                        print(
                            "An error occurred (AccessDenied) when calling the "
                            "GetBucketTagging operation: denied",
                            file=sys.stderr,
                        )
                        raise SystemExit(254)
                    if mode == "missing" and not (state_dir / "tags-created").exists():
                        print(
                            "An error occurred (NoSuchTagSet) when calling the "
                            "GetBucketTagging operation: no tags",
                            file=sys.stderr,
                        )
                        raise SystemExit(254)
                    if mode == "conflict":
                        print(json.dumps({
                            "TagSet": [
                                {"Key": "owner", "Value": "someone-else"}
                            ]
                        }))
                        raise SystemExit(0)
                    print(json.dumps({
                        "TagSet": [
                            {
                                "Key": "market-dashboard:owner",
                                "Value": "market-dashboard-readiness-v2",
                            },
                            {
                                "Key": "market-dashboard:purpose",
                                "Value": "sam-artifacts",
                            },
                        ]
                    }))
                    raise SystemExit(0)

                if operation == ("s3api", "get-bucket-location"):
                    print(os.environ.get("FAKE_BUCKET_REGION", "us-west-1"))
                    raise SystemExit(0)

                if operation == (
                    "s3api",
                    "get-bucket-lifecycle-configuration",
                ):
                    mode = os.environ.get("FAKE_LIFECYCLE_MODE", "exact")
                    if (
                        mode == "missing"
                        and not (state_dir / "lifecycle-created").exists()
                    ):
                        print(
                            "An error occurred (NoSuchLifecycleConfiguration) when "
                            "calling the GetBucketLifecycleConfiguration operation: "
                            "The lifecycle configuration does not exist",
                            file=sys.stderr,
                        )
                        raise SystemExit(254)
                    if mode == "access-denied":
                        print(
                            "An error occurred (AccessDenied) when calling the "
                            "GetBucketLifecycleConfiguration operation: denied",
                            file=sys.stderr,
                        )
                        raise SystemExit(254)
                    if mode == "conflict":
                        print(
                            "2\\tDifferentRule\\tEnabled\\t7\\t3\\t1\\t0"
                        )
                        raise SystemExit(0)
                    print(
                        "1\\tMarketDashboardSamArtifactsRetention\\t"
                        "Enabled\\t90\\t30\\t7\\t0"
                    )
                    raise SystemExit(0)

                if operation == (
                    "s3api",
                    "put-bucket-lifecycle-configuration",
                ):
                    (state_dir / "lifecycle-created").touch()
                    raise SystemExit(0)

                if operation in {
                    ("s3api", "put-public-access-block"),
                    ("s3api", "put-bucket-ownership-controls"),
                    ("s3api", "put-bucket-encryption"),
                    ("s3api", "put-bucket-versioning"),
                }:
                    raise SystemExit(0)

                if operation == ("s3api", "get-public-access-block"):
                    if os.environ.get("FAKE_PUBLIC_ACCESS", "valid") == "invalid":
                        print("True\\tTrue\\tFalse\\tTrue")
                    else:
                        print("True\\tTrue\\tTrue\\tTrue")
                    raise SystemExit(0)

                if operation == ("s3api", "get-bucket-ownership-controls"):
                    print(
                        os.environ.get(
                            "FAKE_OBJECT_OWNERSHIP", "BucketOwnerEnforced"
                        )
                    )
                    raise SystemExit(0)

                if operation == ("s3api", "get-bucket-encryption"):
                    print(os.environ.get("FAKE_ENCRYPTION", "1\\tAES256"))
                    raise SystemExit(0)

                if operation == ("s3api", "get-bucket-versioning"):
                    print(os.environ.get("FAKE_VERSIONING", "Enabled"))
                    raise SystemExit(0)

                print(f"Unexpected fake AWS command: {args}", file=sys.stderr)
                raise SystemExit(99)
                """
            ).lstrip(),
            encoding="utf-8",
        )
        self.aws_path.chmod(0o755)

    def environment(self, **overrides):
        environment = os.environ.copy()
        environment.update(
            {
                "PATH": f"{self.bin_dir}:{environment['PATH']}",
                "FAKE_AWS_LOG": str(self.log_path),
                "FAKE_AWS_STATE_DIR": str(self.state_dir),
                "MARKET_DASHBOARD_SAM_ARTIFACT_BUCKET": EXPECTED_BUCKET,
                # Deliberately poison every ambient credential/profile variable.
                "AWS_ACCESS_KEY_ID": "must-not-leak",
                "AWS_SECRET_ACCESS_KEY": "must-not-leak",
                "AWS_SESSION_TOKEN": "must-not-leak",
                "AWS_SECURITY_TOKEN": "must-not-leak",
                "AWS_PROFILE": "wrong-profile",
                "AWS_DEFAULT_PROFILE": "wrong-default-profile",
                "AWS_ROLE_ARN": "arn:aws:iam::000000000000:role/wrong",
                "AWS_ROLE_SESSION_NAME": "wrong",
                "AWS_WEB_IDENTITY_TOKEN_FILE": "/tmp/wrong-token",
                "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI": "/wrong",
                "AWS_CONTAINER_CREDENTIALS_FULL_URI": "http://127.0.0.1/wrong",
                "AWS_CONTAINER_AUTHORIZATION_TOKEN": "wrong",
                "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE": "/tmp/wrong-container",
                "AWS_SHARED_CREDENTIALS_FILE": "/tmp/wrong-credentials",
            }
        )
        environment.update(overrides)
        return environment

    def run(self, **overrides):
        return subprocess.run(
            [str(SCRIPT)],
            cwd=ROOT,
            env=self.environment(**overrides),
            check=False,
            capture_output=True,
            text=True,
        )

    def calls(self):
        if not self.log_path.exists():
            return []
        return [
            json.loads(line)
            for line in self.log_path.read_text(encoding="utf-8").splitlines()
        ]

    def operations(self):
        operations = []
        for call in self.calls():
            args = call["args"]
            for index, argument in enumerate(args):
                if argument in {"sts", "s3api"}:
                    operations.append((argument, args[index + 1], args))
                    break
        return operations


class PrepareArtifactBucketTests(unittest.TestCase):
    def test_existing_bucket_is_hardened_and_verified_without_creating(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            harness = ArtifactBucketHarness(temp_dir)
            result = harness.run()

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn(f"Artifact bucket ready: {EXPECTED_BUCKET}", result.stdout)

            operations = harness.operations()
            operation_names = [(service, operation) for service, operation, _ in operations]
            self.assertNotIn(("s3api", "create-bucket"), operation_names)
            self.assertNotIn(
                ("s3api", "put-bucket-lifecycle-configuration"),
                operation_names,
            )
            self.assertNotIn(("s3api", "put-bucket-tagging"), operation_names)
            for required_operation in (
                "get-bucket-tagging",
                "put-public-access-block",
                "put-bucket-ownership-controls",
                "put-bucket-encryption",
                "put-bucket-versioning",
                "get-public-access-block",
                "get-bucket-ownership-controls",
                "get-bucket-encryption",
                "get-bucket-versioning",
            ):
                self.assertIn(("s3api", required_operation), operation_names)

            for call in harness.calls():
                self.assertEqual(call["ambient_credentials"], {})
            for service, _, args in operations:
                self.assertIn("--profile", args)
                self.assertEqual(args[args.index("--profile") + 1], "market-dashboard-admin")
                self.assertIn("--region", args)
                self.assertEqual(args[args.index("--region") + 1], "us-west-1")
                if service == "s3api" and "create-bucket" not in args:
                    self.assertIn("--expected-bucket-owner", args)
                    self.assertEqual(
                        args[args.index("--expected-bucket-owner") + 1],
                        "915328198276",
                    )

    def test_authoritative_404_creates_then_configures_bucket_and_lifecycle(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            harness = ArtifactBucketHarness(temp_dir)
            result = harness.run(
                FAKE_HEAD_MODE="absent",
                FAKE_LIFECYCLE_MODE="missing",
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            operations = harness.operations()
            operation_names = [(service, operation) for service, operation, _ in operations]
            self.assertEqual(operation_names.count(("s3api", "create-bucket")), 1)
            self.assertEqual(
                operation_names.count(("s3api", "put-bucket-tagging")),
                1,
            )
            self.assertEqual(
                operation_names.count(
                    ("s3api", "put-bucket-lifecycle-configuration")
                ),
                1,
            )

            create_args = next(
                args
                for service, operation, args in operations
                if (service, operation) == ("s3api", "create-bucket")
            )
            self.assertIn("LocationConstraint=us-west-1", create_args)
            self.assertIn("--object-ownership", create_args)
            self.assertEqual(
                create_args[create_args.index("--object-ownership") + 1],
                "BucketOwnerEnforced",
            )
            tagging_args = next(
                args
                for service, operation, args in operations
                if (service, operation) == ("s3api", "put-bucket-tagging")
            )
            self.assertEqual(
                json.loads(tagging_args[tagging_args.index("--tagging") + 1]),
                {
                    "TagSet": [
                        {
                            "Key": "market-dashboard:owner",
                            "Value": "market-dashboard-readiness-v2",
                        },
                        {
                            "Key": "market-dashboard:purpose",
                            "Value": "sam-artifacts",
                        },
                    ]
                },
            )

            lifecycle_args = next(
                args
                for service, operation, args in operations
                if (service, operation)
                == ("s3api", "put-bucket-lifecycle-configuration")
            )
            configuration = json.loads(
                lifecycle_args[lifecycle_args.index("--lifecycle-configuration") + 1]
            )
            self.assertEqual(
                configuration,
                {
                    "Rules": [
                        {
                            "ID": "MarketDashboardSamArtifactsRetention",
                            "Status": "Enabled",
                            "Filter": {},
                            "Expiration": {"Days": 90},
                            "NoncurrentVersionExpiration": {"NoncurrentDays": 30},
                            "AbortIncompleteMultipartUpload": {
                                "DaysAfterInitiation": 7
                            },
                        }
                    ]
                },
            )

    def test_ambiguous_head_failures_never_create_or_configure(self):
        for head_mode in ("access-denied", "network"):
            with self.subTest(head_mode=head_mode):
                with tempfile.TemporaryDirectory() as temp_dir:
                    harness = ArtifactBucketHarness(temp_dir)
                    result = harness.run(FAKE_HEAD_MODE=head_mode)

                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn("refusing to create it", result.stderr)
                    operation_names = [
                        (service, operation)
                        for service, operation, _ in harness.operations()
                    ]
                    self.assertNotIn(("s3api", "create-bucket"), operation_names)
                    self.assertFalse(
                        any(
                            service == "s3api" and operation.startswith("put-")
                            for service, operation, _ in harness.operations()
                        )
                    )

    def test_wrong_region_aborts_before_any_control_changes(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            harness = ArtifactBucketHarness(temp_dir)
            result = harness.run(FAKE_BUCKET_REGION="us-east-1")

            self.assertNotEqual(result.returncode, 0)
            self.assertIn("expected us-west-1", result.stderr)
            self.assertFalse(
                any(
                    service == "s3api" and operation.startswith("put-")
                    for service, operation, _ in harness.operations()
                )
            )

    def test_existing_bucket_requires_exact_project_ownership_tags(self):
        for tag_mode in ("missing", "conflict", "access-denied"):
            with self.subTest(tag_mode=tag_mode):
                with tempfile.TemporaryDirectory() as temp_dir:
                    harness = ArtifactBucketHarness(temp_dir)
                    result = harness.run(FAKE_TAG_MODE=tag_mode)

                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn("ownership tags", result.stderr)
                    mutation_operations = {
                        "put-bucket-tagging",
                        "put-public-access-block",
                        "put-bucket-ownership-controls",
                        "put-bucket-encryption",
                        "put-bucket-versioning",
                        "put-bucket-lifecycle-configuration",
                    }
                    self.assertFalse(
                        any(
                            service == "s3api"
                            and operation in mutation_operations
                            for service, operation, _ in harness.operations()
                        )
                    )

    def test_conflicting_lifecycle_is_not_replaced_or_partially_hardened(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            harness = ArtifactBucketHarness(temp_dir)
            result = harness.run(FAKE_LIFECYCLE_MODE="conflict")

            self.assertNotEqual(result.returncode, 0)
            self.assertIn("conflicting lifecycle", result.stderr)
            self.assertFalse(
                any(
                    service == "s3api" and operation.startswith("put-")
                    for service, operation, _ in harness.operations()
                )
            )

    def test_lifecycle_inspection_failure_is_not_treated_as_absence(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            harness = ArtifactBucketHarness(temp_dir)
            result = harness.run(FAKE_LIFECYCLE_MODE="access-denied")

            self.assertNotEqual(result.returncode, 0)
            self.assertIn("Unable to inspect", result.stderr)
            self.assertFalse(
                any(
                    service == "s3api" and operation.startswith("put-")
                    for service, operation, _ in harness.operations()
                )
            )

    def test_post_write_verification_is_mandatory(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            harness = ArtifactBucketHarness(temp_dir)
            result = harness.run(FAKE_PUBLIC_ACCESS="invalid")

            self.assertNotEqual(result.returncode, 0)
            self.assertIn("public-access-block verification failed", result.stderr)

    def test_requires_exact_bucket_name_cli_v2_and_sso_identity(self):
        cases = (
            (
                {"MARKET_DASHBOARD_SAM_ARTIFACT_BUCKET": ""},
                "Set MARKET_DASHBOARD_SAM_ARTIFACT_BUCKET",
            ),
            (
                {
                    "MARKET_DASHBOARD_SAM_ARTIFACT_BUCKET": (
                        "some-other-artifact-bucket"
                    )
                },
                "Refusing artifact bucket",
            ),
            (
                {"FAKE_AWS_VERSION": "aws-cli/1.42.0 Python/3.12"},
                "AWS CLI v2 is required",
            ),
            (
                {"FAKE_PROFILE_REGION": "us-east-1"},
                "must set region us-west-1",
            ),
            (
                {"FAKE_PROFILE_ACCOUNT": "111111111111"},
                "must target SSO account 915328198276",
            ),
            (
                {
                    "FAKE_CALLER_ARN": (
                        "arn:aws:iam::915328198276:user/permanent-admin"
                    )
                },
                "did not resolve to an AWS IAM Identity Center assumed role",
            ),
        )
        for overrides, expected_error in cases:
            with self.subTest(overrides=overrides):
                with tempfile.TemporaryDirectory() as temp_dir:
                    harness = ArtifactBucketHarness(temp_dir)
                    result = harness.run(**overrides)

                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn(expected_error, result.stderr)
                    self.assertNotIn(
                        ("s3api", "create-bucket"),
                        [
                            (service, operation)
                            for service, operation, _ in harness.operations()
                        ],
                    )


if __name__ == "__main__":
    unittest.main()
