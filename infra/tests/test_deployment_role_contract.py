#!/usr/bin/env python3
"""Contract checks for least-privilege SAM deployment infrastructure."""

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path
from typing import Any

import yaml


REPO_ROOT = Path(__file__).resolve().parents[2]
BOOTSTRAP_SCRIPT = (
    REPO_ROOT / "infra" / "scripts" / "bootstrap_deployment_role.sh"
)
EXPECTED_ROLE_ARN = (
    "arn:aws:iam::915328198276:"
    "role/market-dashboard-cloudformation-deployment-v2"
)


class CloudFormationLoader(yaml.SafeLoader):
    pass


def construct_cloudformation_tag(
    loader: CloudFormationLoader, tag_suffix: str, node: yaml.Node
) -> dict[str, Any]:
    if isinstance(node, yaml.ScalarNode):
        value = loader.construct_scalar(node)
    elif isinstance(node, yaml.SequenceNode):
        value = loader.construct_sequence(node)
    else:
        value = loader.construct_mapping(node)
    return {"tag": tag_suffix, "value": value}


CloudFormationLoader.add_multi_constructor("!", construct_cloudformation_tag)


def load_cloudformation(path: Path) -> dict[str, Any]:
    return yaml.load(path.read_text(encoding="utf-8"), Loader=CloudFormationLoader)


def policy_statement(template: dict[str, Any], sid: str) -> dict[str, Any]:
    policies = template["Resources"]["DeploymentRole"]["Properties"]["Policies"]
    statements = policies[0]["PolicyDocument"]["Statement"]
    return next(statement for statement in statements if statement.get("Sid") == sid)


def sub_values(resources: Any) -> set[str]:
    values = resources if isinstance(resources, list) else [resources]
    return {
        value["value"]
        for value in values
        if isinstance(value, dict) and value.get("tag") == "Sub"
    }


class DeploymentRoleContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.sam_template = load_cloudformation(REPO_ROOT / "infra" / "template.yaml")
        cls.role_template = load_cloudformation(
            REPO_ROOT / "infra" / "bootstrap" / "deployment-role.yaml"
        )

    def test_role_exactly_covers_every_sam_owned_lambda_without_wildcards(self):
        function_names = {
            resource["Properties"]["FunctionName"]
            for resource in self.sam_template["Resources"].values()
            if resource.get("Type") == "AWS::Serverless::Function"
        }
        expected = {
            (
                "arn:${AWS::Partition}:lambda:${AWS::Region}:${AWS::AccountId}:"
                f"function:{function_name}"
            )
            for function_name in function_names
        }
        actual = sub_values(
            policy_statement(self.role_template, "ManageOwnedFunctions")["Resource"]
        )

        self.assertEqual(actual, expected)
        self.assertFalse(
            any(re.search(r"[*?]", resource) for resource in actual),
            "SAM-owned Lambda permissions must name each function explicitly",
        )

    def test_role_exactly_covers_every_sam_owned_table_without_wildcards(self):
        table_names = {
            resource["Properties"]["TableName"]
            for resource in self.sam_template["Resources"].values()
            if resource.get("Type") == "AWS::DynamoDB::Table"
        }
        expected = {
            (
                "arn:${AWS::Partition}:dynamodb:${AWS::Region}:${AWS::AccountId}:"
                f"table/{table_name}"
            )
            for table_name in table_names
        }
        actual = sub_values(
            policy_statement(self.role_template, "ManageOwnedTables")["Resource"]
        )

        self.assertEqual(actual, expected)
        self.assertFalse(
            any(re.search(r"[*?]", resource) for resource in actual),
            "SAM-owned DynamoDB permissions must name each table explicitly",
        )

    def test_event_invoke_configs_use_exact_latest_function_arns(self):
        function_names = {
            resource["Properties"]["FunctionName"]
            for resource in self.sam_template["Resources"].values()
            if (
                resource.get("Type") == "AWS::Serverless::Function"
                and resource.get("Properties", {}).get("EventInvokeConfig")
            )
        }
        expected = {
            (
                "arn:${AWS::Partition}:lambda:${AWS::Region}:${AWS::AccountId}:"
                f"function:{function_name}:$LATEST"
            )
            for function_name in function_names
        }
        statement = policy_statement(
            self.role_template,
            "ManageOwnedFunctionEventInvokeConfigs",
        )

        self.assertEqual(sub_values(statement["Resource"]), expected)
        self.assertEqual(
            set(statement["Action"]),
            {
                "lambda:GetFunctionEventInvokeConfig",
                "lambda:PutFunctionEventInvokeConfig",
                "lambda:UpdateFunctionEventInvokeConfig",
                "lambda:DeleteFunctionEventInvokeConfig",
            },
        )
        self.assertFalse(
            any(
                re.search(r"[*?]", resource.removesuffix(":$LATEST"))
                for resource in expected
            ),
            "EventInvokeConfig permissions must use exact function qualifiers",
        )

    def test_watchdog_rule_deployment_permissions_are_exact_and_bounded(self):
        statement = policy_statement(
            self.role_template,
            "ManageOwnedWatchdogRule",
        )

        self.assertEqual(
            set(statement["Action"]),
            {
                "events:DeleteRule",
                "events:DescribeRule",
                "events:DisableRule",
                "events:EnableRule",
                "events:ListTagsForResource",
                "events:ListTargetsByRule",
                "events:PutRule",
                "events:PutTargets",
                "events:RemoveTargets",
                "events:TagResource",
                "events:UntagResource",
            },
        )
        self.assertEqual(
            sub_values(statement["Resource"]),
            {
                "arn:${AWS::Partition}:events:${AWS::Region}:"
                "${AWS::AccountId}:rule/market-dashboard-hermes-cloud-watchdog-v1"
            },
        )
        self.assertFalse(
            any(
                re.search(r"[*?]", resource)
                for resource in sub_values(statement["Resource"])
            ),
            "Watchdog rule deployment permissions must use the exact rule ARN.",
        )

    def test_no_statement_can_reintroduce_lambda_or_dynamodb_resource_wildcards(self):
        policies = self.role_template["Resources"]["DeploymentRole"]["Properties"][
            "Policies"
        ]
        for policy in policies:
            for statement in policy["PolicyDocument"]["Statement"]:
                raw_actions = statement.get("Action", [])
                actions = (
                    [raw_actions]
                    if isinstance(raw_actions, str)
                    else list(raw_actions)
                )
                if not any(
                    action.startswith(("lambda:", "dynamodb:"))
                    for action in actions
                ):
                    continue
                raw_resources = statement.get("Resource", [])
                resources = (
                    [raw_resources]
                    if isinstance(raw_resources, (str, dict))
                    else list(raw_resources)
                )
                rendered_resources = {
                    resource["value"]
                    if isinstance(resource, dict)
                    and resource.get("tag") == "Sub"
                    else str(resource)
                    for resource in resources
                }
                self.assertFalse(
                    any(
                        re.search(r"[*?]", resource)
                        for resource in rendered_resources
                    ),
                    (
                        f"{statement.get('Sid')} grants Lambda/DynamoDB "
                        f"through a wildcard resource: {rendered_resources}"
                    ),
                )

    def test_runtime_failure_queue_permissions_use_only_the_exact_queue_arn(self):
        statement = policy_statement(
            self.role_template,
            "ManageOwnedQueueAndTopic",
        )
        self.assertIn("sqs:GetQueueUrl", statement["Action"])
        self.assertEqual(
            sub_values(statement["Resource"]),
            {
                "arn:${AWS::Partition}:sqs:${AWS::Region}:"
                "${AWS::AccountId}:market-dashboard-runtime-failures-v2"
            },
        )
        statements = self.role_template["Resources"]["DeploymentRole"][
            "Properties"
        ]["Policies"][0]["PolicyDocument"]["Statement"]
        self.assertNotIn(
            "CreateQueueNeedsWildcard",
            {item.get("Sid") for item in statements},
        )
        self.assertFalse(
            any(item.get("Resource") == "*" for item in statements),
            "The deployment role must not contain a full Resource wildcard.",
        )

    def test_role_covers_current_cloudformation_read_and_tag_handlers(self):
        expected_actions = {
            "ManageOwnedFunctions": {
                "lambda:GetFunction",
                "lambda:GetFunctionCodeSigningConfig",
                "lambda:GetFunctionRecursionConfig",
                "lambda:GetFunctionScalingConfig",
                "lambda:GetRuntimeManagementConfig",
                "lambda:ListTags",
            },
            "ManageOwnedTables": {
                "dynamodb:DescribeTable",
                "dynamodb:DescribeContinuousBackups",
                "dynamodb:DescribeContributorInsights",
                "dynamodb:DescribeKinesisStreamingDestination",
                "dynamodb:DescribeTimeToLive",
                "dynamodb:GetResourcePolicy",
                "dynamodb:ListTagsOfResource",
            },
            "ManageOwnedQueueAndTopic": {
                "sqs:GetQueueAttributes",
                "sqs:ListQueueTags",
            },
            "ManageOwnedSns": {
                "sns:GetDataProtectionPolicy",
                "sns:GetTopicAttributes",
                "sns:ListSubscriptionsByTopic",
                "sns:ListTagsForResource",
            },
            "ManageOwnedAlarms": {
                "cloudwatch:DescribeAlarms",
                "cloudwatch:ListTagsForResource",
            },
        }

        for sid, required in expected_actions.items():
            with self.subTest(sid=sid):
                raw_actions = policy_statement(self.role_template, sid)["Action"]
                actions = (
                    {raw_actions}
                    if isinstance(raw_actions, str)
                    else set(raw_actions)
                )
                self.assertTrue(
                    required.issubset(actions),
                    f"{sid} is missing {sorted(required - actions)}",
                )

    def test_sam_transform_permission_is_exact_and_create_change_set_only(self):
        statement = policy_statement(self.role_template, "UseSamTransform")

        self.assertEqual(
            set(statement["Action"]),
            {"cloudformation:CreateChangeSet"},
        )
        self.assertEqual(
            sub_values(statement["Resource"]),
            {
                "arn:${AWS::Partition}:cloudformation:${AWS::Region}:"
                "aws:transform/Serverless-2016-10-31"
            },
        )
        self.assertFalse(
            any(
                re.search(r"[*?]", resource)
                for resource in sub_values(statement["Resource"])
            ),
            "The SAM transform permission must use its exact transform ARN.",
        )

    def test_runtime_role_permissions_exclude_the_deployment_role(self):
        statement = policy_statement(
            self.role_template,
            "ManageOwnedRuntimeRoles",
        )

        self.assertEqual(
            sub_values(statement["Resource"]),
            {
                "arn:${AWS::Partition}:iam::${AWS::AccountId}:"
                "role/market-dashboard-scheduler-invoke-v2",
                "arn:${AWS::Partition}:iam::${AWS::AccountId}:"
                "role/market-dashboard-readine*",
            },
        )
        self.assertNotIn(
            "arn:${AWS::Partition}:iam::${AWS::AccountId}:"
            "role/market-dashboard-cloudformation-deployment-v2",
            sub_values(statement["Resource"]),
        )

    def test_artifact_bucket_is_explicit_in_bootstrap_and_sam_deploy(self):
        parameters = self.role_template["Parameters"]
        artifact_parameter = parameters["ArtifactBucketName"]
        self.assertNotIn("Default", artifact_parameter)

        artifact_resources = sub_values(
            policy_statement(self.role_template, "ReadSamArtifacts")["Resource"]
        )
        self.assertEqual(
            artifact_resources,
            {
                "arn:${AWS::Partition}:s3:::${ArtifactBucketName}",
                "arn:${AWS::Partition}:s3:::${ArtifactBucketName}/*",
            },
        )

        deploy_script = (
            REPO_ROOT / "infra" / "scripts" / "deploy.sh"
        ).read_text(encoding="utf-8")
        bootstrap_script = (
            REPO_ROOT / "infra" / "scripts" / "bootstrap_deployment_role.sh"
        ).read_text(encoding="utf-8")
        self.assertIn("MARKET_DASHBOARD_SAM_ARTIFACT_BUCKET", deploy_script)
        self.assertIn("MARKET_DASHBOARD_SAM_ARTIFACT_BUCKET", bootstrap_script)
        self.assertRegex(
            deploy_script,
            r'--s3-bucket\s+"\$MARKET_DASHBOARD_SAM_ARTIFACT_BUCKET"',
        )
        self.assertRegex(
            deploy_script,
            r'--profile\s+"\$ADMIN_PROFILE"',
        )
        self.assertIn('ADMIN_PROFILE="${MARKET_DASHBOARD_AWS_ADMIN_PROFILE:-market-dashboard-admin}"', deploy_script)
        self.assertIn("sso_account_id", deploy_script)
        self.assertIn("AWSReservedSSO_", deploy_script)
        self.assertNotIn("run_sam build --no-cached", deploy_script)
        self.assertIn("prepare_tested_release.py", deploy_script)
        self.assertIn('BuildVersion=${build_version}', deploy_script)
        self.assertIn("MARKET_DASHBOARD_ROLLBACK_EXPORT", deploy_script)
        self.assertIn("Rollback ownership preflight did not pass", deploy_script)
        self.assertIn("Base deployment is all-disabled", deploy_script)
        self.assertIn('--stack-name "$TARGET_STACK_NAME"', deploy_script)
        self.assertIn("market-dashboard:purpose=readiness-stack", deploy_script)
        self.assertRegex(
            bootstrap_script,
            (
                r'"ArtifactBucketName='
                r'\$\{MARKET_DASHBOARD_SAM_ARTIFACT_BUCKET\}"'
            ),
        )
        self.assertNotIn("--resolve-s3", deploy_script)

        sam_config = (REPO_ROOT / "infra" / "samconfig.toml").read_text(
            encoding="utf-8"
        )
        self.assertNotRegex(sam_config, r"(?m)^\s*resolve_s3\s*=")

    def test_bootstrap_requires_v2_sso_identity_in_exact_account_and_region(self):
        bootstrap_path = (
            REPO_ROOT / "infra" / "scripts" / "bootstrap_deployment_role.sh"
        )
        bootstrap_script = bootstrap_path.read_text(encoding="utf-8")

        self.assertEqual(bootstrap_path.stat().st_mode & 0o111, 0o111)
        self.assertIn('EXPECTED_ACCOUNT_ID="915328198276"', bootstrap_script)
        self.assertIn('EXPECTED_REGION="us-west-1"', bootstrap_script)
        self.assertIn('ADMIN_PROFILE="market-dashboard-admin"', bootstrap_script)
        self.assertIn('^aws-cli/2\\.', bootstrap_script)
        self.assertIn("sso_account_id", bootstrap_script)
        self.assertIn("sso_session", bootstrap_script)
        self.assertIn("sso_start_url", bootstrap_script)
        self.assertIn("sso_role_name", bootstrap_script)
        self.assertIn("AWSReservedSSO_", bootstrap_script)
        self.assertIn("sts get-caller-identity", bootstrap_script)
        self.assertIn("-u AWS_ACCESS_KEY_ID", bootstrap_script)
        self.assertIn("-u AWS_SECRET_ACCESS_KEY", bootstrap_script)
        self.assertIn("-u AWS_SESSION_TOKEN", bootstrap_script)
        self.assertIn("ownership-preflight.json", bootstrap_script)
        self.assertIn("shasum -a 256 -c SHA256SUMS", bootstrap_script)

    def test_bootstrap_deploys_only_bounded_role_template_and_emits_role_arn(self):
        bootstrap_script = BOOTSTRAP_SCRIPT.read_text(encoding="utf-8")
        role_tags = {
            item["Key"]: item["Value"]
            for item in self.role_template["Resources"]["DeploymentRole"][
                "Properties"
            ]["Tags"]
        }

        self.assertEqual(
            role_tags,
            {
                "market-dashboard:owner": "market-dashboard-readiness-v2",
                "market-dashboard:purpose": "cloudformation-deployment",
            },
        )
        self.assertIn(
            'TEMPLATE_PATH="${INFRA_DIR}/bootstrap/deployment-role.yaml"',
            bootstrap_script,
        )
        self.assertEqual(bootstrap_script.count("cloudformation deploy"), 1)
        self.assertRegex(
            bootstrap_script,
            r"--template-file\s+\"\$TEMPLATE_PATH\"",
        )
        self.assertRegex(
            bootstrap_script,
            r"--capabilities\s+CAPABILITY_NAMED_IAM",
        )
        self.assertNotIn("CAPABILITY_AUTO_EXPAND", bootstrap_script)
        self.assertNotIn("create-bucket", bootstrap_script)
        self.assertNotIn("aws configure sso", bootstrap_script)
        self.assertIn("DeploymentRoleArn", bootstrap_script)
        self.assertIn("market-dashboard:owner", bootstrap_script)
        self.assertIn("market-dashboard:purpose", bootstrap_script)
        self.assertIn("iam list-role-tags", bootstrap_script)
        self.assertRegex(bootstrap_script, r"printf '%s\\n' \"\$ROLE_ARN\"")

    def test_bootstrap_stdout_is_exactly_the_role_arn(self):
        fake_aws_source = textwrap.dedent(
            """\
            #!/usr/bin/env python3
            import os
            import sys

            args = sys.argv[1:]
            if args == ["--version"]:
                print("aws-cli/2.36.8 Python/3.14.6 Darwin/25.5.0 source/arm64")
                raise SystemExit(0)

            for variable in (
                "AWS_ACCESS_KEY_ID",
                "AWS_SECRET_ACCESS_KEY",
                "AWS_SESSION_TOKEN",
            ):
                if variable in os.environ:
                    print(f"ambient credential leaked: {variable}", file=sys.stderr)
                    raise SystemExit(98)

            if args[:2] == ["configure", "get"]:
                values = {
                    "region": "us-west-1",
                    "sso_account_id": "915328198276",
                    "sso_session": "market-dashboard-admin",
                    "sso_start_url": "",
                    "sso_role_name": "AdministratorAccess",
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
                print(
                    '{"TagSet":['
                    '{"Key":"market-dashboard:owner",'
                    '"Value":"market-dashboard-readiness-v2"},'
                    '{"Key":"market-dashboard:purpose",'
                    '"Value":"sam-artifacts"}]}'
                )
                raise SystemExit(0)

            if "cloudformation" in args and "deploy" in args:
                if os.environ.get("FAKE_DEPLOY_MODE") == "no-op":
                    print(
                        "No changes to deploy. Stack "
                        "market-dashboard-deployment-role-v2 is up to date"
                    )
                else:
                    print(
                        "Successfully created/updated stack - "
                        "market-dashboard-deployment-role-v2"
                    )
                raise SystemExit(0)

            if "cloudformation" in args and "describe-stacks" in args:
                query = args[args.index("--query") + 1]
                if "Tags" in query:
                    print(
                        "market-dashboard-readiness-v2\\t"
                        "cloudformation-deployment"
                    )
                    raise SystemExit(0)
                print(
                    "arn:aws:iam::915328198276:"
                    "role/market-dashboard-cloudformation-deployment-v2"
                )
                raise SystemExit(0)

            if "iam" in args and "list-role-tags" in args:
                print(
                    "market-dashboard-readiness-v2\\t"
                    "cloudformation-deployment"
                )
                raise SystemExit(0)

            print(f"Unexpected fake AWS command: {args}", file=sys.stderr)
            raise SystemExit(99)
            """
        )

        for deploy_mode in ("changed", "no-op"):
            with self.subTest(deploy_mode=deploy_mode):
                with tempfile.TemporaryDirectory() as temp_dir:
                    temp_path = Path(temp_dir)
                    bin_dir = temp_path / "bin"
                    bin_dir.mkdir()
                    fake_aws = bin_dir / "aws"
                    fake_aws.write_text(fake_aws_source, encoding="utf-8")
                    fake_aws.chmod(0o755)

                    rollback_export = temp_path / "rollback"
                    rollback_export.mkdir(mode=0o700)
                    preflight_path = rollback_export / "ownership-preflight.json"
                    preflight_path.write_text(
                        json.dumps(
                            {
                                "passed": True,
                                "conflicts": [],
                                "account": "915328198276",
                                "region": "us-west-1",
                                "bootstrapStack": (
                                    "market-dashboard-deployment-role-v2"
                                ),
                            },
                            sort_keys=True,
                        )
                        + "\n",
                        encoding="utf-8",
                    )
                    digest = hashlib.sha256(preflight_path.read_bytes()).hexdigest()
                    (rollback_export / "SHA256SUMS").write_text(
                        f"{digest}  ./ownership-preflight.json\n",
                        encoding="utf-8",
                    )

                    environment = os.environ.copy()
                    environment.update(
                        {
                            "PATH": f"{bin_dir}:{environment['PATH']}",
                            "MARKET_DASHBOARD_SAM_ARTIFACT_BUCKET": (
                                "market-dashboard-sam-artifacts-"
                                "915328198276-us-west-1"
                            ),
                            "FAKE_DEPLOY_MODE": deploy_mode,
                            "MARKET_DASHBOARD_ROLLBACK_EXPORT": str(
                                rollback_export
                            ),
                            "AWS_ACCESS_KEY_ID": "must-not-leak",
                            "AWS_SECRET_ACCESS_KEY": "must-not-leak",
                            "AWS_SESSION_TOKEN": "must-not-leak",
                        }
                    )
                    result = subprocess.run(
                        [str(BOOTSTRAP_SCRIPT)],
                        cwd=REPO_ROOT,
                        env=environment,
                        check=False,
                        capture_output=True,
                        text=True,
                    )

                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout, f"{EXPECTED_ROLE_ARN}\n")
                expected_diagnostic = (
                    "No changes to deploy"
                    if deploy_mode == "no-op"
                    else "Successfully created/updated stack"
                )
                self.assertIn(expected_diagnostic, result.stderr)


if __name__ == "__main__":
    unittest.main()
