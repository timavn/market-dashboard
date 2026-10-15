import configparser
import json
import os
import stat
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
IAM_SCRIPT = ROOT / "infra" / "scripts" / "install_local_principal_policies.sh"
EXPORT_SCRIPT = ROOT / "infra" / "scripts" / "export_deployed_state.sh"
API_POLICY = ROOT / "infra" / "iam" / "local-readiness-catalog-policy.json"
ANALYST_POLICY = ROOT / "infra" / "iam" / "local-analyst-pdf-intake-policy.json"
BRIDGE_POLICY = ROOT / "infra" / "iam" / "local-bridge-policy.json"


def policy_action_resource_pairs(path):
    policy = json.loads(path.read_text(encoding="utf-8"))
    pairs = []
    for statement in policy["Statement"]:
        actions = statement["Action"]
        resources = statement["Resource"]
        if isinstance(actions, str):
            actions = [actions]
        if isinstance(resources, str):
            resources = [resources]
        pairs.extend((action, resource) for action in actions for resource in resources)
    return pairs


class ScriptHarness:
    def __init__(self, temp_dir):
        self.temp_dir = Path(temp_dir)
        self.bin_dir = self.temp_dir / "bin"
        self.bin_dir.mkdir()
        self.log_path = self.temp_dir / "aws-calls.jsonl"
        self.env_log_path = self.temp_dir / "aws-environment.jsonl"
        self.managed_policy_state_path = (
            self.temp_dir / "managed-policy-created"
        )
        self.inline_policy_state_path = (
            self.temp_dir / "inline-api-policy-deleted"
        )
        self.config_path = self.temp_dir / "aws-config"
        self.write_sso_config()
        self._write_executable(
            "aws",
            """
            #!/usr/bin/env python3
            import configparser
            import json
            import os
            import pathlib
            import sys
            import urllib.parse

            args = sys.argv[1:]
            with open(os.environ["FAKE_AWS_LOG"], "a", encoding="utf-8") as handle:
                handle.write(json.dumps(args) + "\\n")
            credential_variables = [
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
                "AWS_CONFIG_FILE",
            ]
            with open(os.environ["FAKE_AWS_ENV_LOG"], "a", encoding="utf-8") as handle:
                handle.write(json.dumps({
                    key: os.environ.get(key)
                    for key in credential_variables
                    if os.environ.get(key) is not None
                }) + "\\n")

            scenario = os.environ.get("FAKE_AWS_SCENARIO", "success")
            if args == ["--version"]:
                version = (
                    "aws-cli/1.42.50 Python/3.12 Darwin/24 botocore/1.40"
                    if scenario == "aws-cli-v1"
                    else "aws-cli/2.31.18 Python/3.13 Darwin/24 exe/arm64"
                )
                print(version)
                raise SystemExit(0)

            if args[:2] == ["configure", "get"]:
                key = args[2]
                values = {
                    "region": os.environ.get("FAKE_PROFILE_REGION", ""),
                    "sso_account_id": os.environ.get(
                        "FAKE_PROFILE_ACCOUNT", ""
                    ),
                    "sso_session": os.environ.get(
                        "FAKE_PROFILE_SSO_SESSION", ""
                    ),
                    "sso_start_url": os.environ.get(
                        "FAKE_PROFILE_SSO_START_URL", ""
                    ),
                    "sso_role_name": os.environ.get(
                        "FAKE_PROFILE_SSO_ROLE_NAME", ""
                    ),
                }
                print(values.get(key, ""))
                raise SystemExit(0)

            operation = ()
            for index, argument in enumerate(args):
                if argument in {
                    "sts",
                    "iam",
                    "lambda",
                    "scheduler",
                    "events",
                    "cloudformation",
                    "dynamodb",
                }:
                    operation = (argument, args[index + 1])
                    break

            def option(name, default=""):
                return args[args.index(name) + 1] if name in args else default

            if operation == ("sts", "get-caller-identity"):
                if "--query" in args:
                    print("915328198276")
                else:
                    arn = (
                        "arn:aws:iam::915328198276:user/permanent-admin"
                        if scenario == "non-sso-caller"
                        else (
                            "arn:aws:sts::915328198276:assumed-role/"
                            "AWSReservedSSO_AdministratorAccess_0123456789abcdef/"
                            "test@example.com"
                        )
                    )
                    print(json.dumps({
                        "Account": "915328198276",
                        "Arn": arn,
                        "UserId": "test",
                    }))
                raise SystemExit(0)

            if operation == ("iam", "get-user"):
                print("{}")
                raise SystemExit(0)
            if operation in {
                ("iam", "put-user-policy"),
                ("iam", "create-user"),
                ("iam", "attach-user-policy"),
                ("iam", "delete-policy-version"),
            }:
                print("{}")
                raise SystemExit(0)
            if operation == ("iam", "get-policy"):
                state_path = os.environ["FAKE_MANAGED_POLICY_STATE"]
                if (
                    scenario == "managed-policy-absent"
                    and not os.path.exists(state_path)
                ):
                    print(
                        "An error occurred (NoSuchEntity) when calling the "
                        "GetPolicy operation: missing",
                        file=sys.stderr,
                    )
                    raise SystemExit(254)
                print(json.dumps({
                    "Policy": {
                        "PolicyName": "MarketDashboardLocalReadinessCatalog",
                        "Arn": (
                            "arn:aws:iam::915328198276:policy/"
                            "MarketDashboardLocalReadinessCatalog"
                        ),
                        "DefaultVersionId": "v1",
                        "Path": (
                            "/unexpected/"
                            if scenario == "managed-policy-wrong-path"
                            else "/"
                        ),
                        "PermissionsBoundaryUsageCount": (
                            1
                            if scenario == "managed-policy-boundary-use"
                            else 0
                        ),
                    }
                }))
                raise SystemExit(0)
            if operation == ("iam", "create-policy"):
                pathlib.Path(
                    os.environ["FAKE_MANAGED_POLICY_STATE"]
                ).write_text("created\\n", encoding="utf-8")
                print(json.dumps({
                    "Policy": {
                        "PolicyName": "MarketDashboardLocalReadinessCatalog",
                        "Arn": (
                            "arn:aws:iam::915328198276:policy/"
                            "MarketDashboardLocalReadinessCatalog"
                        ),
                        "DefaultVersionId": "v1",
                        "Path": "/",
                        "PermissionsBoundaryUsageCount": 0,
                    }
                }))
                raise SystemExit(0)
            if operation == ("iam", "list-policy-tags"):
                tags = [
                        {
                            "Key": "market-dashboard:owner",
                            "Value": "market-dashboard-readiness-v2",
                        },
                        {
                            "Key": "market-dashboard:purpose",
                            "Value": "local-readiness-catalog",
                        },
                    ]
                if scenario == "managed-policy-extra-tag":
                    tags.append({"Key": "foreign", "Value": "true"})
                print(json.dumps({"Tags": tags}))
                raise SystemExit(0)
            if operation == ("iam", "get-policy-version"):
                with open(os.environ["FAKE_API_POLICY_PATH"], encoding="utf-8") as handle:
                    policy_document = json.load(handle)
                if scenario == "iam-policy-drift":
                    policy_document["Statement"] = policy_document["Statement"][:-1]
                if scenario == "five-versions-drift":
                    policy_document["Statement"] = policy_document["Statement"][:-1]
                if os.environ.get("FAKE_IAM_URL_ENCODE_POLICY") == "true":
                    policy_document = urllib.parse.quote(
                        json.dumps(policy_document, separators=(",", ":")),
                        safe="",
                    )
                print(json.dumps({
                    "PolicyVersion": {
                        "Document": policy_document,
                        "VersionId": (
                            "v9"
                            if scenario == "managed-policy-wrong-version"
                            else "v1"
                        ),
                        "IsDefaultVersion": (
                            scenario != "managed-policy-not-default"
                        ),
                    }
                }))
                raise SystemExit(0)
            if operation == ("iam", "list-policy-versions"):
                if scenario == "five-versions-drift":
                    print(json.dumps({
                        "Versions": [
                            {
                                "VersionId": f"v{index}",
                                "IsDefaultVersion": index == 5,
                                "CreateDate": f"2026-01-0{index}T00:00:00+00:00",
                            }
                            for index in range(1, 6)
                        ]
                    }))
                    raise SystemExit(0)
                print(json.dumps({
                    "Versions": [{
                        "VersionId": "v1",
                        "IsDefaultVersion": True,
                        "CreateDate": "2026-01-01T00:00:00+00:00",
                    }]
                }))
                raise SystemExit(0)
            if operation == ("iam", "create-policy-version"):
                print(json.dumps({
                    "PolicyVersion": {
                        "VersionId": "v2",
                        "IsDefaultVersion": True,
                    }
                }))
                raise SystemExit(0)
            if operation == ("iam", "list-attached-user-policies"):
                if scenario == "managed-policy-not-attached":
                    print(json.dumps({"AttachedPolicies": []}))
                    raise SystemExit(0)
                print(json.dumps({
                    "AttachedPolicies": [{
                        "PolicyName": "MarketDashboardLocalReadinessCatalog",
                        "PolicyArn": (
                            "arn:aws:iam::915328198276:policy/"
                            "MarketDashboardLocalReadinessCatalog"
                        ),
                    }]
                }))
                raise SystemExit(0)
            if operation == ("iam", "list-entities-for-policy"):
                if scenario == "managed-policy-foreign-entity":
                    print(json.dumps({
                        "PolicyGroups": [],
                        "PolicyUsers": [{"UserName": "market-dashboard-local"}],
                        "PolicyRoles": [{"RoleName": "foreign-role"}],
                    }))
                    raise SystemExit(0)
                print(json.dumps({
                    "PolicyGroups": [],
                    "PolicyUsers": [{"UserName": "market-dashboard-local"}],
                    "PolicyRoles": [],
                }))
                raise SystemExit(0)
            if operation == ("iam", "get-user-policy"):
                policy_name = option("--policy-name")
                if policy_name == "MarketDashboardServiceHeartbeatsQuery":
                    if scenario == "legacy-policy-persists":
                        print(json.dumps({
                            "PolicyDocument": {
                                "Version": "2012-10-17",
                                "Statement": [],
                            }
                        }))
                        raise SystemExit(0)
                    print(
                        "An error occurred (NoSuchEntity) when calling the "
                        "GetUserPolicy operation: missing",
                        file=sys.stderr,
                    )
                    raise SystemExit(254)
                if policy_name == "MarketDashboardLocalReadinessCatalog":
                    if (
                        scenario == "inline-api-policy-present"
                        and not os.path.exists(
                            os.environ["FAKE_INLINE_POLICY_STATE"]
                        )
                    ):
                        with open(
                            os.environ["FAKE_API_POLICY_PATH"],
                            encoding="utf-8",
                        ) as handle:
                            print(json.dumps({
                                "PolicyDocument": json.load(handle)
                            }))
                        raise SystemExit(0)
                    print(
                        "An error occurred (NoSuchEntity) when calling the "
                        "GetUserPolicy operation: missing",
                        file=sys.stderr,
                    )
                    raise SystemExit(254)
                if policy_name == "MarketDashboardAnalystPdfIntake":
                    policy_path = os.environ["FAKE_ANALYST_POLICY_PATH"]
                else:
                    policy_path = os.environ["FAKE_BRIDGE_POLICY_PATH"]
                with open(policy_path, encoding="utf-8") as handle:
                    policy_document = json.load(handle)
                if scenario == "iam-policy-drift":
                    policy_document["Statement"] = policy_document["Statement"][:-1]
                if os.environ.get("FAKE_IAM_URL_ENCODE_POLICY") == "true":
                    policy_document = urllib.parse.quote(
                        json.dumps(policy_document, separators=(",", ":")),
                        safe="",
                    )
                print(json.dumps({"PolicyDocument": policy_document}))
                raise SystemExit(0)
            if operation == ("iam", "simulate-principal-policy"):
                principal = option("--policy-source-arn")
                if principal.endswith(":user/market-dashboard-bridge"):
                    resource = option("--resource-arns")
                    expected_values = {
                        (
                            "arn:aws:dynamodb:us-west-1:915328198276:"
                            "table/HermesInputSnapshots"
                        ): (
                            "tim-market-dashboard#operations,"
                            "tim-market-dashboard#portfolio"
                        ),
                        (
                            "arn:aws:dynamodb:us-west-1:915328198276:"
                            "table/MarketDashboardServiceHeartbeats"
                        ): "bridge:local-dashboard",
                    }.get(resource)
                    context_entries = []
                    if "--context-entries" in args:
                        start = args.index("--context-entries") + 1
                        for value in args[start:]:
                            if value.startswith("--"):
                                break
                            context_entries.append(value)
                    expected_entry = (
                        "ContextKeyName=dynamodb:LeadingKeys,"
                        f"ContextKeyValues={expected_values},"
                        "ContextKeyType=stringList"
                    )
                    if (
                        expected_values is None
                        or expected_entry not in context_entries
                    ):
                        print("implicitDeny")
                        raise SystemExit(0)
                print(
                    "explicitDeny"
                    if scenario == "simulation-denied"
                    else "allowed"
                )
                raise SystemExit(0)
            if operation == ("iam", "delete-user-policy"):
                if scenario == "legacy-delete-denied":
                    print(
                        "An error occurred (AccessDenied) when calling the "
                        "DeleteUserPolicy operation: denied",
                        file=sys.stderr,
                    )
                    raise SystemExit(254)
                if (
                    option("--policy-name")
                    == "MarketDashboardLocalReadinessCatalog"
                ):
                    pathlib.Path(
                        os.environ["FAKE_INLINE_POLICY_STATE"]
                    ).write_text("deleted\\n", encoding="utf-8")
                print("{}")
                raise SystemExit(0)

            if operation == ("lambda", "list-functions"):
                functions = []
                if scenario == "discovered-legacy":
                    functions.append({
                        "FunctionName": "legacy-gmail-poller",
                        "FunctionArn": (
                            "arn:aws:lambda:us-west-1:915328198276:"
                            "function:legacy-gmail-poller"
                        ),
                        "Runtime": "python3.12",
                        "State": "Active",
                    })
                print(json.dumps(functions))
                raise SystemExit(0)
            if operation == ("scheduler", "list-schedules"):
                schedules = []
                if scenario == "discovered-legacy":
                    schedules.append({
                        "Name": "legacy-gmail-every-15m",
                        "Arn": (
                            "arn:aws:scheduler:us-west-1:915328198276:"
                            "schedule/default/legacy-gmail-every-15m"
                        ),
                        "GroupName": "default",
                        "State": "ENABLED",
                    })
                print(json.dumps(schedules))
                raise SystemExit(0)
            if operation == ("events", "list-rules"):
                rules = []
                if scenario == "discovered-legacy":
                    rules.append({
                        "Name": "legacy-hermes-gmail-rule",
                        "Arn": (
                            "arn:aws:events:us-west-1:915328198276:"
                            "rule/legacy-hermes-gmail-rule"
                        ),
                        "EventBusName": "default",
                        "State": "ENABLED",
                        "ScheduleExpression": "rate(15 minutes)",
                    })
                print(json.dumps(rules))
                raise SystemExit(0)

            if scenario == "all-absent":
                if operation in {
                    ("lambda", "get-function"),
                    ("scheduler", "get-schedule"),
                    ("events", "describe-rule"),
                }:
                    print(
                        "An error occurred (ResourceNotFoundException) when calling "
                        f"the {operation[1]} operation: missing",
                        file=sys.stderr,
                    )
                    raise SystemExit(254)
                if (
                    operation == ("dynamodb", "describe-table")
                    and option("--table-name")
                    not in {"HermesEmailIngestLedger", "HedgeyeDailySnapshot"}
                ):
                    print(
                        "An error occurred (ResourceNotFoundException) when calling "
                        "the DescribeTable operation: missing",
                        file=sys.stderr,
                    )
                    raise SystemExit(254)
                if operation == ("cloudformation", "describe-stacks"):
                    print(
                        "An error occurred (ValidationError) when calling the "
                        "DescribeStacks operation: Stack with id "
                        f"{option('--stack-name')} does not exist",
                        file=sys.stderr,
                    )
                    raise SystemExit(254)
                if operation == ("iam", "get-role"):
                    print(
                        "An error occurred (NoSuchEntity) when calling the "
                        "GetRole operation: missing",
                        file=sys.stderr,
                    )
                    raise SystemExit(254)

            failure_target = os.environ.get("FAKE_AWS_FAILURE_TARGET", "")
            if "/".join(operation) == failure_target:
                if scenario == "network-failure":
                    print(
                        "Could not connect to the endpoint URL: "
                        '"https://dynamodb.us-west-1.amazonaws.com/"',
                        file=sys.stderr,
                    )
                else:
                    print(
                        "An error occurred (AccessDeniedException) when calling the "
                        f"{operation[1]} operation: denied",
                        file=sys.stderr,
                    )
                raise SystemExit(255)

            if operation == ("lambda", "get-function"):
                if option("--function-name") != "test-function":
                    print(
                        "An error occurred (ResourceNotFoundException) when calling "
                        "the GetFunction operation: missing",
                        file=sys.stderr,
                    )
                    raise SystemExit(254)
                print(json.dumps({"Code": {"Location": "https://example.test/code.zip"}}))
                raise SystemExit(0)
            if operation in {
                ("lambda", "get-function-event-invoke-config"),
                ("lambda", "get-policy"),
            }:
                print(
                    "An error occurred (ResourceNotFoundException) when calling "
                    f"the {operation[1]} operation: optional configuration is absent",
                    file=sys.stderr,
                )
                raise SystemExit(254)
            if operation == ("scheduler", "get-schedule"):
                if option("--name") != "test-schedule":
                    print(
                        "An error occurred (ResourceNotFoundException) when calling "
                        "the GetSchedule operation: missing",
                        file=sys.stderr,
                    )
                    raise SystemExit(254)
                print(json.dumps({"Name": "test-schedule", "State": "DISABLED"}))
                raise SystemExit(0)
            if operation == ("events", "describe-rule"):
                if option("--name") != "test-event-rule":
                    print(
                        "An error occurred (ResourceNotFoundException) when calling "
                        "the DescribeRule operation: missing",
                        file=sys.stderr,
                    )
                    raise SystemExit(254)
                print(json.dumps({
                    "Name": "test-event-rule",
                    "Arn": (
                        "arn:aws:events:us-west-1:915328198276:"
                        "rule/test-event-rule"
                    ),
                    "ScheduleExpression": "rate(15 minutes)",
                    "State": "ENABLED",
                    "Description": "Legacy Gmail ingestion",
                    "EventBusName": "default",
                    "CreatedBy": "915328198276",
                }))
                raise SystemExit(0)
            if operation == ("events", "list-targets-by-rule"):
                print(json.dumps({
                    "Targets": [{
                        "Id": "1",
                        "Arn": (
                            "arn:aws:lambda:us-west-1:915328198276:"
                            "function:legacy-gmail-ingestor"
                        ),
                        "RetryPolicy": {"MaximumRetryAttempts": 0},
                    }]
                }))
                raise SystemExit(0)
            if operation == ("events", "list-tags-for-resource"):
                print(json.dumps({"Tags": []}))
                raise SystemExit(0)
            if operation == ("dynamodb", "describe-table"):
                table_name = option("--table-name")
                required_external = {
                    "HermesEmailIngestLedger",
                    "HedgeyeDailySnapshot",
                }
                present = (
                    scenario == "tables-present"
                    or table_name in required_external
                    or (
                        scenario == "external-table"
                        and table_name == "ResearchEntityEventsV1"
                    )
                )
                if (
                    scenario == "required-external-absent"
                    and table_name == "HermesEmailIngestLedger"
                ):
                    present = False
                if not present:
                    print(
                        "An error occurred (ResourceNotFoundException) when calling "
                        "the DescribeTable operation: missing",
                        file=sys.stderr,
                    )
                    raise SystemExit(254)
                print(json.dumps({
                    "Table": {
                        "TableName": table_name,
                        "TableArn": (
                            "arn:aws:dynamodb:us-west-1:915328198276:"
                            f"table/{table_name}"
                        ),
                        "TableStatus": "ACTIVE",
                    }
                }))
                raise SystemExit(0)
            if operation == ("dynamodb", "describe-time-to-live"):
                print(json.dumps({
                    "TimeToLiveDescription": {"TimeToLiveStatus": "DISABLED"}
                }))
                raise SystemExit(0)
            if operation == ("dynamodb", "describe-continuous-backups"):
                print(json.dumps({
                    "ContinuousBackupsDescription": {
                        "ContinuousBackupsStatus": "ENABLED",
                        "PointInTimeRecoveryDescription": {
                            "PointInTimeRecoveryStatus": "ENABLED"
                        },
                    }
                }))
                raise SystemExit(0)
            if operation == ("dynamodb", "list-tags-of-resource"):
                print(json.dumps({"Tags": [{"Key": "owner", "Value": "sam"}]}))
                raise SystemExit(0)
            if operation == ("cloudformation", "describe-stacks"):
                stack_name = option("--stack-name")
                bootstrap_name = "market-dashboard-deployment-role-v2"
                if (
                    stack_name == bootstrap_name
                    and scenario
                    not in {"owned-bootstrap", "owned-bootstrap-untagged"}
                ):
                    print(
                        "An error occurred (ValidationError) when calling the "
                        "DescribeStacks operation: Stack with id "
                        f"{stack_name} does not exist",
                        file=sys.stderr,
                    )
                    raise SystemExit(254)
                stack = {"StackName": stack_name}
                if stack_name == bootstrap_name and scenario == "owned-bootstrap":
                    stack["Tags"] = [
                        {
                            "Key": "market-dashboard:owner",
                            "Value": "market-dashboard-readiness-v2",
                        },
                        {
                            "Key": "market-dashboard:purpose",
                            "Value": "cloudformation-deployment",
                        },
                    ]
                elif (
                    stack_name != bootstrap_name
                    and scenario != "target-stack-untagged"
                ):
                    stack["Tags"] = [
                        {
                            "Key": "market-dashboard:owner",
                            "Value": "market-dashboard-readiness-v2",
                        },
                        {
                            "Key": "market-dashboard:purpose",
                            "Value": "readiness-stack",
                        },
                    ]
                print(json.dumps({"Stacks": [stack]}))
                raise SystemExit(0)
            if operation == ("cloudformation", "get-template"):
                print(json.dumps({"TemplateBody": {"Resources": {"Test": {}}}}))
                raise SystemExit(0)
            if operation == ("cloudformation", "list-stack-resources"):
                stack_name = option("--stack-name")
                if stack_name == "market-dashboard-deployment-role-v2":
                    resources = [
                        {
                            "LogicalResourceId": "DeploymentRole",
                            "PhysicalResourceId": (
                                "market-dashboard-cloudformation-deployment-v2"
                            ),
                            "ResourceType": "AWS::IAM::Role",
                        }
                    ]
                else:
                    resources = [
                        {
                            "LogicalResourceId": "GmailIngestorFunction",
                            "PhysicalResourceId": (
                                "market-dashboard-gmail-ingestor-v2"
                            ),
                            "ResourceType": "AWS::Lambda::Function",
                        },
                        {
                            "LogicalResourceId": "Test",
                            "PhysicalResourceId": "test",
                            "ResourceType": "AWS::DynamoDB::Table",
                        },
                    ]
                    if scenario == "tables-present":
                        resources.extend(
                            {
                                "LogicalResourceId": f"Table{index}",
                                "PhysicalResourceId": table_name,
                                "ResourceType": "AWS::DynamoDB::Table",
                            }
                            for index, table_name in enumerate([
                                "MarketDashboardServiceHeartbeats",
                                "HermesInputSnapshots",
                                "ResearchEventLedgerV2",
                                "ResearchEntityEventsV1",
                                "ResearchProductManifestsV1",
                                "PredictionMarketCatalogV2",
                                "PredictionMarketPerformanceLedger",
                                "RiskRangePublicationManifestsV2",
                            ])
                        )
                print(json.dumps({"StackResourceSummaries": resources}))
                raise SystemExit(0)
            if operation == ("iam", "get-role"):
                if scenario not in {
                    "owned-bootstrap",
                    "owned-bootstrap-untagged",
                    "external-role",
                }:
                    print(
                        "An error occurred (NoSuchEntity) when calling the "
                        "GetRole operation: missing",
                        file=sys.stderr,
                    )
                    raise SystemExit(254)
                print(json.dumps({
                    "Role": {
                        "RoleName": "market-dashboard-cloudformation-deployment-v2",
                        "Arn": (
                            "arn:aws:iam::915328198276:role/"
                            "market-dashboard-cloudformation-deployment-v2"
                        ),
                    }
                }))
                raise SystemExit(0)
            if operation == ("iam", "get-role-policy"):
                print(json.dumps({
                    "RoleName": "market-dashboard-cloudformation-deployment-v2",
                    "PolicyName": "market-dashboard-readiness-deployment",
                    "PolicyDocument": {"Version": "2012-10-17", "Statement": []},
                }))
                raise SystemExit(0)
            if operation == ("iam", "list-role-policies"):
                print(json.dumps({
                    "PolicyNames": ["market-dashboard-readiness-deployment"]
                }))
                raise SystemExit(0)
            if operation == ("iam", "list-attached-role-policies"):
                print(json.dumps({"AttachedPolicies": []}))
                raise SystemExit(0)
            if operation == ("iam", "list-role-tags"):
                if scenario == "owned-bootstrap-untagged":
                    print(json.dumps({"Tags": []}))
                    raise SystemExit(0)
                print(json.dumps({
                    "Tags": [
                        {
                            "Key": "market-dashboard:owner",
                            "Value": "market-dashboard-readiness-v2",
                        },
                        {
                            "Key": "market-dashboard:purpose",
                            "Value": "cloudformation-deployment",
                        },
                    ]
                }))
                raise SystemExit(0)

            print(f"Unexpected fake AWS command: {args}", file=sys.stderr)
            raise SystemExit(99)
            """,
        )
        self._write_executable(
            "curl",
            """
            #!/usr/bin/env python3
            import pathlib
            import sys

            args = sys.argv[1:]
            output_path = pathlib.Path(args[args.index("--output") + 1])
            output_path.write_bytes(b"test lambda archive")
            """,
        )

    def _write_executable(self, name, source):
        path = self.bin_dir / name
        path.write_text(textwrap.dedent(source).lstrip(), encoding="utf-8")
        path.chmod(0o755)

    def write_sso_config(self, account_id="915328198276", region="us-west-1"):
        self.config_path.write_text(
            textwrap.dedent(
                f"""
                [profile market-dashboard-admin]
                sso_session = market-dashboard
                sso_account_id = {account_id}
                sso_role_name = AdministratorAccess
                region = {region}

                [sso-session market-dashboard]
                sso_start_url = https://example.awsapps.com/start
                sso_region = us-east-1
                sso_registration_scopes = sso:account:access
                """
            ).lstrip(),
            encoding="utf-8",
        )

    def environment(self, **overrides):
        environment = os.environ.copy()
        parser = configparser.RawConfigParser()
        parser.read(self.config_path)
        profile = parser["profile market-dashboard-admin"]
        environment.update(
            {
                "PATH": f"{self.bin_dir}:{environment['PATH']}",
                "FAKE_AWS_LOG": str(self.log_path),
                "FAKE_AWS_ENV_LOG": str(self.env_log_path),
                "FAKE_API_POLICY_PATH": str(API_POLICY),
                "FAKE_ANALYST_POLICY_PATH": str(ANALYST_POLICY),
                "FAKE_BRIDGE_POLICY_PATH": str(BRIDGE_POLICY),
                "FAKE_MANAGED_POLICY_STATE": str(
                    self.managed_policy_state_path
                ),
                "FAKE_INLINE_POLICY_STATE": str(
                    self.inline_policy_state_path
                ),
                "AWS_CONFIG_FILE": str(self.config_path),
                "FAKE_PROFILE_REGION": profile.get("region", ""),
                "FAKE_PROFILE_ACCOUNT": profile.get("sso_account_id", ""),
                "FAKE_PROFILE_SSO_SESSION": profile.get("sso_session", ""),
                "FAKE_PROFILE_SSO_START_URL": profile.get("sso_start_url", ""),
                "FAKE_PROFILE_SSO_ROLE_NAME": profile.get("sso_role_name", ""),
            }
        )
        environment.update(overrides)
        return environment

    def calls(self):
        if not self.log_path.exists():
            return []
        return [
            json.loads(line)
            for line in self.log_path.read_text(encoding="utf-8").splitlines()
        ]

    def aws_environments(self):
        if not self.env_log_path.exists():
            return []
        return [
            json.loads(line)
            for line in self.env_log_path.read_text(encoding="utf-8").splitlines()
        ]


class LocalPrincipalInstallerScriptTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.harness = ScriptHarness(self.temp.name)

    def run_installer(self, *arguments, environment=None):
        return subprocess.run(
            [
                str(IAM_SCRIPT),
                "--admin-profile",
                "market-dashboard-admin",
                *arguments,
            ],
            cwd=ROOT,
            env=self.harness.environment(**(environment or {})),
            check=False,
            capture_output=True,
            text=True,
        )

    def assert_simulates_complete_policy(self, *policy_paths):
        calls = self.harness.calls()
        simulations = [
            call
            for call in calls
            if "iam" in call and "simulate-principal-policy" in call
        ]
        observed = {
            (
                call[call.index("--action-names") + 1],
                call[call.index("--resource-arns") + 1],
            )
            for call in simulations
        }
        expected = set().union(
            *(set(policy_action_resource_pairs(path)) for path in policy_paths)
        )
        self.assertEqual(observed, expected)
        self.assertGreaterEqual(
            len(simulations),
            len(expected),
        )

    def assert_bridge_simulation_contexts_match_policy(self):
        policy = json.loads(BRIDGE_POLICY.read_text(encoding="utf-8"))
        expected_by_pair = {}
        for statement in policy["Statement"]:
            actions = statement["Action"]
            resources = statement["Resource"]
            if isinstance(actions, str):
                actions = [actions]
            if isinstance(resources, str):
                resources = [resources]
            leading_keys = (
                statement.get("Condition", {})
                .get("ForAllValues:StringEquals", {})
                .get("dynamodb:LeadingKeys", [])
            )
            if isinstance(leading_keys, str):
                leading_keys = [leading_keys]
            expected_entry = (
                "ContextKeyName=dynamodb:LeadingKeys,"
                f"ContextKeyValues={','.join(leading_keys)},"
                "ContextKeyType=stringList"
            )
            for action in actions:
                for resource in resources:
                    expected_by_pair[(action, resource)] = expected_entry

        bridge_simulations = [
            call
            for call in self.harness.calls()
            if (
                "simulate-principal-policy" in call
                and any(
                    value.endswith(":user/market-dashboard-bridge")
                    for value in call
                )
            )
        ]
        self.assertEqual(len(bridge_simulations), len(expected_by_pair))
        for call in bridge_simulations:
            pair = (
                call[call.index("--action-names") + 1],
                call[call.index("--resource-arns") + 1],
            )
            context_start = call.index("--context-entries") + 1
            context_entries = []
            for value in call[context_start:]:
                if value.startswith("--"):
                    break
                context_entries.append(value)
            self.assertIn(expected_by_pair[pair], context_entries)

    def assert_no_managed_policy_mutation_or_cleanup(self):
        rendered = [" ".join(call) for call in self.harness.calls()]
        forbidden = (
            "iam create-policy ",
            "iam create-policy-version",
            "iam attach-user-policy",
            "iam delete-policy-version",
            "iam delete-user-policy",
            "iam simulate-principal-policy",
        )
        for fragment in forbidden:
            self.assertFalse(
                any(fragment in call for call in rendered),
                fragment,
            )

    def test_api_scope_applies_and_simulates_the_complete_api_policies(self):
        result = self.run_installer(
            "--apply",
            "--scope",
            "api",
            environment={"FAKE_AWS_SCENARIO": "managed-policy-absent"},
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        calls = self.harness.calls()
        rendered_calls = "\n".join(" ".join(call) for call in calls)
        self.assertIn("MarketDashboardLocalReadinessCatalog", rendered_calls)
        self.assertIn(f"file://{API_POLICY}", rendered_calls)
        self.assertIn("MarketDashboardAnalystPdfIntake", rendered_calls)
        self.assertIn(f"file://{ANALYST_POLICY}", rendered_calls)
        self.assertIn("market-dashboard-local", rendered_calls)
        self.assertIn("iam create-policy", rendered_calls)
        self.assertIn("iam attach-user-policy", rendered_calls)
        self.assertIn("iam put-user-policy", rendered_calls)
        self.assertIn("market-dashboard:owner", rendered_calls)
        self.assertIn("market-dashboard:purpose", rendered_calls)
        self.assertNotIn("market-dashboard-bridge", rendered_calls)
        self.assertNotIn("MarketDashboardLocalSnapshotBridge", rendered_calls)
        self.assertNotIn("create-access-key", rendered_calls)
        self.assertNotIn("iam list-policies", rendered_calls)
        expected_policy_arn = (
            "arn:aws:iam::915328198276:policy/"
            "MarketDashboardLocalReadinessCatalog"
        )
        for call in calls:
            if "--policy-arn" in call:
                self.assertEqual(
                    call[call.index("--policy-arn") + 1],
                    expected_policy_arn,
                )
        self.assert_simulates_complete_policy(API_POLICY, ANALYST_POLICY)

    def test_managed_policy_metadata_failures_precede_mutation_and_simulation(self):
        scenarios = (
            "managed-policy-extra-tag",
            "managed-policy-wrong-path",
            "managed-policy-boundary-use",
            "managed-policy-foreign-entity",
            "managed-policy-wrong-version",
            "managed-policy-not-default",
        )
        for scenario in scenarios:
            with self.subTest(scenario=scenario):
                result = self.run_installer(
                    "--apply",
                    "--scope",
                    "api",
                    environment={"FAKE_AWS_SCENARIO": scenario},
                )
                self.assertNotEqual(result.returncode, 0)
                self.assert_no_managed_policy_mutation_or_cleanup()

    def test_verify_requires_the_exact_managed_policy_attachment(self):
        result = self.run_installer(
            "--verify",
            "--scope",
            "api",
            environment={"FAKE_AWS_SCENARIO": "managed-policy-not-attached"},
        )

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("not attached", result.stderr)
        self.assert_no_managed_policy_mutation_or_cleanup()

    def test_five_policy_versions_fail_without_discarding_rollback_history(self):
        result = self.run_installer(
            "--apply",
            "--scope",
            "api",
            environment={"FAKE_AWS_SCENARIO": "five-versions-drift"},
        )

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("five versions", result.stderr)
        rendered = "\n".join(" ".join(call) for call in self.harness.calls())
        self.assertNotIn("iam delete-policy-version", rendered)
        self.assertNotIn("iam create-policy-version", rendered)
        self.assertNotIn("iam attach-user-policy", rendered)
        self.assertNotIn("iam delete-user-policy", rendered)
        self.assertNotIn("iam simulate-principal-policy", rendered)

    def test_inline_catalog_migration_simulates_before_and_after_exact_cleanup(self):
        result = self.run_installer(
            "--apply",
            "--scope",
            "api",
            environment={"FAKE_AWS_SCENARIO": "inline-api-policy-present"},
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        calls = self.harness.calls()
        delete_index = next(
            index
            for index, call in enumerate(calls)
            if (
                "delete-user-policy" in call
                and "MarketDashboardLocalReadinessCatalog" in call
            )
        )
        simulation_indices = [
            index
            for index, call in enumerate(calls)
            if "simulate-principal-policy" in call
        ]
        self.assertTrue(any(index < delete_index for index in simulation_indices))
        self.assertTrue(any(index > delete_index for index in simulation_indices))
        verification_index = next(
            index
            for index, call in enumerate(calls)
            if (
                index > delete_index
                and "get-user-policy" in call
                and "MarketDashboardLocalReadinessCatalog" in call
            )
        )
        self.assertLess(delete_index, verification_index)

    def test_api_scope_simulates_every_rta_rebuild_permission(self):
        result = self.run_installer("--verify", "--scope", "api")

        self.assertEqual(result.returncode, 0, result.stderr)
        simulations = {
            (
                call[call.index("--action-names") + 1],
                call[call.index("--resource-arns") + 1],
            )
            for call in self.harness.calls()
            if "simulate-principal-policy" in call
        }
        self.assertTrue(
            {
                (
                    "dynamodb:Scan",
                    "arn:aws:dynamodb:us-west-1:915328198276:"
                    "table/HermesEmailIngestLedger",
                ),
                (
                    "dynamodb:Scan",
                    "arn:aws:dynamodb:us-west-1:915328198276:"
                    "table/HedgeyeDailySnapshot",
                ),
                (
                    "dynamodb:PutItem",
                    "arn:aws:dynamodb:us-west-1:915328198276:"
                    "table/HedgeyeDailySnapshot",
                ),
                (
                    "s3:GetObject",
                    "arn:aws:s3:::market-dashboard-csv-data/"
                    "hedgeye-email/messages/*",
                ),
                (
                    "s3:GetObjectVersion",
                    "arn:aws:s3:::market-dashboard-csv-data/"
                    "hedgeye-email/messages/*",
                ),
            }.issubset(simulations)
        )
        staging_list_call = next(
            call
            for call in self.harness.calls()
            if (
                "simulate-principal-policy" in call
                and call[call.index("--action-names") + 1] == "s3:ListBucket"
                and call[call.index("--resource-arns") + 1]
                == "arn:aws:s3:::market-dashboard-csv-data"
            )
        )
        self.assertIn(
            "ContextKeyName=s3:prefix,ContextKeyValues=analyst-staging/,"
            "ContextKeyType=string",
            staging_list_call,
        )

    def test_bridge_scope_neither_requires_nor_mutates_the_api_principal(self):
        result = self.run_installer("--apply", "--scope", "bridge")

        self.assertEqual(result.returncode, 0, result.stderr)
        rendered_calls = "\n".join(" ".join(call) for call in self.harness.calls())
        self.assertIn("MarketDashboardLocalSnapshotBridge", rendered_calls)
        self.assertIn(f"file://{BRIDGE_POLICY}", rendered_calls)
        self.assertIn("market-dashboard-bridge", rendered_calls)
        self.assertNotIn("market-dashboard-local", rendered_calls)
        self.assertNotIn("MarketDashboardLocalReadinessCatalog", rendered_calls)
        self.assertNotIn("create-access-key", rendered_calls)
        self.assert_simulates_complete_policy(BRIDGE_POLICY)
        self.assert_bridge_simulation_contexts_match_policy()

    def test_default_scope_remains_both(self):
        result = self.run_installer("--apply")

        self.assertEqual(result.returncode, 0, result.stderr)
        rendered_calls = "\n".join(" ".join(call) for call in self.harness.calls())
        self.assertIn("MarketDashboardLocalReadinessCatalog", rendered_calls)
        self.assertIn("MarketDashboardLocalSnapshotBridge", rendered_calls)
        self.assertNotIn("create-access-key", rendered_calls)
        self.assertEqual(
            rendered_calls.count("iam simulate-principal-policy"),
            2 * len(policy_action_resource_pairs(API_POLICY))
            + 2 * len(policy_action_resource_pairs(ANALYST_POLICY))
            + len(policy_action_resource_pairs(BRIDGE_POLICY)),
        )

    def test_legacy_policy_is_removed_only_after_complete_api_verification(self):
        result = self.run_installer(
            "--apply",
            "--scope",
            "api",
            "--remove-legacy-heartbeat-policy",
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        calls = self.harness.calls()
        simulation_indices = [
            index
            for index, call in enumerate(calls)
            if "simulate-principal-policy" in call
        ]
        delete_index = next(
            index
            for index, call in enumerate(calls)
            if "delete-user-policy" in call
        )
        verify_index = next(
            index
            for index, call in enumerate(calls)
            if (
                index > delete_index
                and "get-user-policy" in call
                and "MarketDashboardServiceHeartbeatsQuery" in call
            )
        )
        self.assertTrue(simulation_indices)
        self.assertTrue(
            any(index < delete_index for index in simulation_indices)
        )
        self.assertLess(delete_index, verify_index)
        self.assertTrue(
            any(index > verify_index for index in simulation_indices)
        )
        delete_call = calls[delete_index]
        self.assertEqual(
            delete_call[delete_call.index("--user-name") + 1],
            "market-dashboard-local",
        )
        self.assertEqual(
            delete_call[delete_call.index("--policy-name") + 1],
            "MarketDashboardServiceHeartbeatsQuery",
        )
        self.assertIn("Removed and verified absent", result.stdout)

    def test_legacy_policy_removal_requires_apply_api_scope(self):
        for arguments in (
            ("--verify", "--scope", "api"),
            ("--apply", "--scope", "both"),
            ("--apply", "--scope", "bridge"),
        ):
            with self.subTest(arguments=arguments):
                result = self.run_installer(
                    *arguments,
                    "--remove-legacy-heartbeat-policy",
                )
                self.assertEqual(result.returncode, 2)
                self.assertIn("requires --apply --scope api", result.stderr)
        self.assertEqual(self.harness.calls(), [])

    def test_failed_simulation_prevents_legacy_policy_removal(self):
        result = self.run_installer(
            "--apply",
            "--scope",
            "api",
            "--remove-legacy-heartbeat-policy",
            environment={"FAKE_AWS_SCENARIO": "simulation-denied"},
        )

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("DENIED", result.stderr)
        self.assertFalse(
            any("delete-user-policy" in call for call in self.harness.calls())
        )

    def test_legacy_policy_removal_fails_closed_if_policy_still_exists(self):
        result = self.run_installer(
            "--apply",
            "--scope",
            "api",
            "--remove-legacy-heartbeat-policy",
            environment={"FAKE_AWS_SCENARIO": "legacy-policy-persists"},
        )

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("still exists", result.stderr)

    def test_invalid_scope_is_rejected_before_any_aws_call(self):
        result = self.run_installer("--scope", "everything")

        self.assertEqual(result.returncode, 2)
        self.assertIn("Invalid scope", result.stderr)
        self.assertEqual(self.harness.calls(), [])

    def test_admin_profile_name_is_pinned_for_this_rollout(self):
        result = subprocess.run(
            [
                str(IAM_SCRIPT),
                "--admin-profile",
                "another-sso-admin",
                "--verify",
                "--scope",
                "api",
            ],
            cwd=ROOT,
            env=self.harness.environment(),
            check=False,
            capture_output=True,
            text=True,
        )

        self.assertEqual(result.returncode, 2)
        self.assertIn("exact market-dashboard-admin", result.stderr)
        self.assertEqual(self.harness.calls(), [])

    def test_all_aws_calls_clear_poisoned_ambient_credential_sources(self):
        poisoned_environment = {
            "AWS_ACCESS_KEY_ID": "poison-access-key",
            "AWS_SECRET_ACCESS_KEY": "poison-secret-key",
            "AWS_SESSION_TOKEN": "poison-session-token",
            "AWS_SECURITY_TOKEN": "poison-security-token",
            "AWS_PROFILE": "poison-profile",
            "AWS_DEFAULT_PROFILE": "poison-default-profile",
            "AWS_ROLE_ARN": "arn:aws:iam::000000000000:role/poison",
            "AWS_ROLE_SESSION_NAME": "poison-session",
            "AWS_WEB_IDENTITY_TOKEN_FILE": "/tmp/poison-token",
            "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI": "/poison",
            "AWS_CONTAINER_CREDENTIALS_FULL_URI": "http://127.0.0.1/poison",
            "AWS_CONTAINER_AUTHORIZATION_TOKEN": "poison-container-token",
            "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE": "/tmp/poison-container-token",
            "AWS_SHARED_CREDENTIALS_FILE": "/tmp/poison-credentials",
            "AWS_CONFIG_FILE": "/tmp/poison-config",
        }
        result = self.run_installer(
            "--verify",
            "--scope",
            "api",
            environment=poisoned_environment,
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        aws_environments = self.harness.aws_environments()
        self.assertTrue(aws_environments)
        self.assertEqual(aws_environments, [{} for _ in aws_environments])

    def test_non_sso_caller_fails_before_any_iam_operation(self):
        result = self.run_installer(
            "--verify",
            "--scope",
            "api",
            environment={"FAKE_AWS_SCENARIO": "non-sso-caller"},
        )

        self.assertEqual(result.returncode, 3)
        self.assertIn("Refusing non-SSO administrator identity", result.stderr)
        self.assertFalse(any("iam" in call for call in self.harness.calls()))

    def test_aws_cli_v1_fails_before_sts_or_iam_operations(self):
        result = self.run_installer(
            "--verify",
            "--scope",
            "api",
            environment={"FAKE_AWS_SCENARIO": "aws-cli-v1"},
        )

        self.assertEqual(result.returncode, 2)
        self.assertIn("AWS CLI v2 is required", result.stderr)
        self.assertEqual(self.harness.calls(), [["--version"]])

    def test_sso_profile_must_pin_the_expected_account_and_region(self):
        for field, account_id, region, expected_message in [
            (
                "account",
                "000000000000",
                "us-west-1",
                "must set sso_account_id=915328198276",
            ),
            (
                "region",
                "915328198276",
                "us-east-1",
                "must set region=us-west-1",
            ),
        ]:
            with self.subTest(field=field):
                self.harness.write_sso_config(account_id=account_id, region=region)
                result = self.run_installer("--verify", "--scope", "api")

                self.assertNotEqual(result.returncode, 0)
                self.assertIn(expected_message, result.stderr)
                self.assertFalse(any("iam" in call for call in self.harness.calls()))

    def test_verify_accepts_a_url_encoded_semantically_identical_policy(self):
        result = self.run_installer(
            "--verify",
            "--scope",
            "api",
            environment={"FAKE_IAM_URL_ENCODE_POLICY": "true"},
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(
            "Matched and attached MarketDashboardLocalReadinessCatalog",
            result.stdout,
        )
        self.assert_simulates_complete_policy(API_POLICY, ANALYST_POLICY)

    def test_verify_rejects_policy_drift_before_simulation(self):
        result = self.run_installer(
            "--verify",
            "--scope",
            "api",
            environment={"FAKE_AWS_SCENARIO": "iam-policy-drift"},
        )

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("differs from the complete local policy", result.stderr)
        self.assertFalse(
            any(
                "simulate-principal-policy" in call
                for call in self.harness.calls()
            )
        )


class RollbackExportScriptTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.harness = ScriptHarness(self.temp.name)

    def run_export(self, output_dir, **environment):
        return subprocess.run(
            [str(EXPORT_SCRIPT), str(output_dir)],
            cwd=ROOT,
            env=self.harness.environment(
                MARKET_DASHBOARD_EXPORT_FUNCTIONS="test-function",
                MARKET_DASHBOARD_EXPORT_SCHEDULES="test-schedule",
                **environment,
            ),
            check=False,
            capture_output=True,
            text=True,
        )

    def test_absent_top_level_resources_are_explicit_and_export_succeeds(self):
        output_dir = Path(self.temp.name) / "rollback"
        result = self.run_export(output_dir, FAKE_AWS_SCENARIO="all-absent")

        self.assertEqual(result.returncode, 0, result.stderr)
        markers = [
            output_dir / "functions" / "test-function" / "function.absent.json",
            (
                output_dir
                / "functions"
                / "market-dashboard-hermes-cloud-watchdog-v1"
                / "function.absent.json"
            ),
            output_dir / "schedules" / "test-schedule.absent.json",
            (
                output_dir
                / "event-rules"
                / "market-dashboard-hermes-cloud-watchdog-v1.absent.json"
            ),
            output_dir / "cloudformation-stack.absent.json",
        ]
        for marker in markers:
            payload = json.loads(marker.read_text(encoding="utf-8"))
            self.assertEqual(payload["classification"], "safely-absent")
        self.assertFalse(
            (output_dir / "functions" / "test-function" / "get-function.json").exists()
        )
        cloudformation_operations = {
            call[call.index("cloudformation") + 1]
            for call in self.harness.calls()
            if "cloudformation" in call
        }
        self.assertEqual(cloudformation_operations, {"describe-stacks"})
        self.assertEqual(stat.S_IMODE(output_dir.stat().st_mode), 0o700)
        self.assertEqual(
            stat.S_IMODE((output_dir / "caller-identity.json").stat().st_mode),
            0o600,
        )
        self.assertTrue((output_dir / "SHA256SUMS").is_file())
        local_settings_path = output_dir / "local-settings" / "settings.json"
        local_settings = json.loads(local_settings_path.read_text(encoding="utf-8"))
        self.assertEqual(
            local_settings["classification"],
            "rollback-local-settings",
        )
        self.assertIn("supervisor", local_settings)
        self.assertIn("readinessController", local_settings)
        self.assertIn(
            "./local-settings/settings.json",
            (output_dir / "SHA256SUMS").read_text(encoding="utf-8"),
        )
        self.assertEqual(
            json.loads(
                (
                    output_dir
                    / "account-inventory"
                    / "lambda-functions.json"
                ).read_text(encoding="utf-8")
            ),
            [],
        )
        self.assertEqual(
            json.loads(
                (
                    output_dir
                    / "account-inventory"
                    / "schedules.json"
                ).read_text(encoding="utf-8")
            ),
            [],
        )

    def test_account_discovery_is_paginated_and_fails_on_unexported_legacy_candidates(
        self,
    ):
        output_dir = Path(self.temp.name) / "rollback"
        result = self.run_export(
            output_dir,
            FAKE_AWS_SCENARIO="discovered-legacy",
        )

        self.assertNotEqual(result.returncode, 0)
        self.assertIn(
            "DISCOVERED_RESOURCE_REQUIRES_EXPLICIT_EXPORT",
            result.stderr,
        )
        preflight = json.loads(
            (output_dir / "ownership-preflight.json").read_text(encoding="utf-8")
        )
        self.assertFalse(preflight["passed"])
        self.assertTrue(
            {
                (
                    conflict["resourceType"],
                    conflict["resource"],
                )
                for conflict in preflight["conflicts"]
                if conflict["code"]
                == "DISCOVERED_RESOURCE_REQUIRES_EXPLICIT_EXPORT"
            }
            >= {
                ("AWS::Lambda::Function", "legacy-gmail-poller"),
                ("AWS::Scheduler::Schedule", "legacy-gmail-every-15m"),
                ("AWS::Events::Rule", "legacy-hermes-gmail-rule"),
            }
        )
        inventory_calls = [
            call
            for call in self.harness.calls()
            if (
                ("lambda" in call and "list-functions" in call)
                or ("scheduler" in call and "list-schedules" in call)
                or ("events" in call and "list-rules" in call)
            )
        ]
        self.assertEqual(len(inventory_calls), 3)
        for call in inventory_calls:
            self.assertEqual(call[call.index("--page-size") + 1], "50")
            self.assertNotIn("--max-items", call)
            self.assertNotIn("--no-paginate", call)
        scheduler_call = next(
            call for call in inventory_calls if "list-schedules" in call
        )
        self.assertNotIn("--group-name", scheduler_call)
        events_call = next(
            call for call in inventory_calls if "list-rules" in call
        )
        self.assertNotIn("--event-bus-name", events_call)
        self.assertTrue((output_dir / "SHA256SUMS").is_file())

    def test_eventbridge_rule_definition_targets_and_tags_are_exported(self):
        output_dir = Path(self.temp.name) / "rollback"
        result = self.run_export(
            output_dir,
            MARKET_DASHBOARD_EXPORT_EVENT_RULES="test-event-rule",
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        rule_dir = output_dir / "event-rules"
        rule = json.loads(
            (rule_dir / "test-event-rule.json").read_text(encoding="utf-8")
        )
        targets = json.loads(
            (rule_dir / "test-event-rule.targets.json").read_text(
                encoding="utf-8"
            )
        )
        tags = json.loads(
            (rule_dir / "test-event-rule.tags.json").read_text(
                encoding="utf-8"
            )
        )
        self.assertEqual(rule["State"], "ENABLED")
        self.assertEqual(
            targets["Targets"][0]["Arn"],
            (
                "arn:aws:lambda:us-west-1:915328198276:"
                "function:legacy-gmail-ingestor"
            ),
        )
        self.assertEqual(tags, {"Tags": []})
        manifest = (output_dir / "SHA256SUMS").read_text(encoding="utf-8")
        self.assertIn("./event-rules/test-event-rule.json", manifest)
        self.assertIn("./event-rules/test-event-rule.targets.json", manifest)
        self.assertIn("./event-rules/test-event-rule.tags.json", manifest)

    def test_optional_lambda_resources_can_be_absent_from_a_valid_export(self):
        output_dir = Path(self.temp.name) / "rollback"
        result = self.run_export(output_dir)

        self.assertEqual(result.returncode, 0, result.stderr)
        function_dir = output_dir / "functions" / "test-function"
        self.assertTrue((function_dir / "get-function.json").is_file())
        self.assertEqual((function_dir / "code.zip").read_bytes(), b"test lambda archive")
        for name in [
            "event-invoke-config.absent.json",
            "resource-policy.absent.json",
        ]:
            payload = json.loads((function_dir / name).read_text(encoding="utf-8"))
            self.assertEqual(payload["classification"], "safely-absent")
        self.assertTrue((output_dir / "cloudformation-template.json").is_file())
        self.assertTrue(
            (output_dir / "cloudformation-stack-resources.json").is_file()
        )

    def test_all_seven_sam_tables_include_recovery_metadata(self):
        output_dir = Path(self.temp.name) / "rollback"
        result = self.run_export(
            output_dir,
            FAKE_AWS_SCENARIO="tables-present",
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        expected_tables = {
            "MarketDashboardServiceHeartbeats",
            "HermesInputSnapshots",
            "ResearchEventLedgerV2",
            "ResearchEntityEventsV1",
            "ResearchProductManifestsV1",
            "PredictionMarketCatalogV2",
            "PredictionMarketPerformanceLedger",
            "RiskRangePublicationManifestsV2",
        }
        self.assertEqual(
            {
                path.name
                for path in (output_dir / "tables").iterdir()
                if path.is_dir()
            },
            expected_tables,
        )
        for table_name in expected_tables:
            table_dir = output_dir / "tables" / table_name
            for artifact in (
                "describe-table.json",
                "time-to-live.json",
                "continuous-backups.json",
                "tags.json",
            ):
                self.assertTrue((table_dir / artifact).is_file())
        preflight = json.loads(
            (output_dir / "ownership-preflight.json").read_text(encoding="utf-8")
        )
        self.assertTrue(preflight["passed"])
        table_checks = {
            item["resource"]: item
            for item in preflight["checked"]
            if item["resourceType"] == "AWS::DynamoDB::Table"
            and item.get("classification") != "external-dependency"
        }
        self.assertEqual(set(table_checks), expected_tables)
        self.assertTrue(
            all(item["ownedByTargetStack"] for item in table_checks.values())
        )

    def test_external_dependency_tables_are_inventory_only_and_required_pair_exists(self):
        output_dir = Path(self.temp.name) / "rollback"
        result = self.run_export(output_dir)

        self.assertEqual(result.returncode, 0, result.stderr)
        expected_external_tables = {
            "HermesEmailIngestLedger",
            "HedgeyeDailySnapshot",
            "HedgeyeRiskRanges",
            "RiskRangeData",
            "HermesAgentRuns",
            "HermesAlerts",
        }
        self.assertEqual(
            {
                path.name
                for path in (output_dir / "external-tables").iterdir()
                if path.is_dir()
            },
            expected_external_tables,
        )
        preflight = json.loads(
            (output_dir / "ownership-preflight.json").read_text(encoding="utf-8")
        )
        external_checks = {
            item["resource"]: item
            for item in preflight["checked"]
            if item.get("classification") == "external-dependency"
        }
        self.assertEqual(set(external_checks), expected_external_tables)
        for table_name in ("HermesEmailIngestLedger", "HedgeyeDailySnapshot"):
            self.assertTrue(external_checks[table_name]["required"])
            self.assertTrue(external_checks[table_name]["present"])
            self.assertEqual(external_checks[table_name]["status"], "ACTIVE")
        self.assertNotIn(
            "ownedByTargetStack",
            external_checks["HermesEmailIngestLedger"],
        )

    def test_missing_required_external_dependency_fails_preflight(self):
        output_dir = Path(self.temp.name) / "rollback"
        result = self.run_export(
            output_dir,
            FAKE_AWS_SCENARIO="required-external-absent",
        )

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("REQUIRED_EXTERNAL_DEPENDENCY_ABSENT", result.stderr)
        preflight = json.loads(
            (output_dir / "ownership-preflight.json").read_text(encoding="utf-8")
        )
        self.assertIn(
            {
                "code": "REQUIRED_EXTERNAL_DEPENDENCY_ABSENT",
                "resourceType": "AWS::DynamoDB::Table",
                "resource": "HermesEmailIngestLedger",
            },
            preflight["conflicts"],
        )

    def test_bootstrap_stack_role_and_inline_policy_are_exported(self):
        output_dir = Path(self.temp.name) / "rollback"
        result = self.run_export(
            output_dir,
            FAKE_AWS_SCENARIO="owned-bootstrap",
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        bootstrap_dir = output_dir / "bootstrap"
        for artifact in (
            "cloudformation-stack.json",
            "cloudformation-template.json",
            "cloudformation-stack-resources.json",
            "deployment-role/get-role.json",
            "deployment-role/inline-policy.json",
            "deployment-role/inline-policy-names.json",
            "deployment-role/attached-policies.json",
            "deployment-role/role-tags.json",
        ):
            self.assertTrue((bootstrap_dir / artifact).is_file())
        preflight = json.loads(
            (output_dir / "ownership-preflight.json").read_text(encoding="utf-8")
        )
        self.assertTrue(preflight["passed"])
        role_check = next(
            item
            for item in preflight["checked"]
            if item["resourceType"] == "AWS::IAM::Role"
        )
        self.assertTrue(role_check["present"])
        self.assertTrue(role_check["ownedByBootstrapStack"])

    def test_externally_owned_table_conflict_aborts_after_verified_export(self):
        output_dir = Path(self.temp.name) / "rollback"
        result = self.run_export(
            output_dir,
            FAKE_AWS_SCENARIO="external-table",
        )

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("EXTERNALLY_OWNED_NAME_CONFLICT", result.stderr)
        self.assertTrue((output_dir / "SHA256SUMS").is_file())
        preflight = json.loads(
            (output_dir / "ownership-preflight.json").read_text(encoding="utf-8")
        )
        self.assertFalse(preflight["passed"])
        self.assertIn(
            {
                "code": "EXTERNALLY_OWNED_NAME_CONFLICT",
                "resourceType": "AWS::DynamoDB::Table",
                "resource": "ResearchEntityEventsV1",
            },
            preflight["conflicts"],
        )

    def test_externally_owned_bootstrap_role_conflict_aborts(self):
        output_dir = Path(self.temp.name) / "rollback"
        result = self.run_export(
            output_dir,
            FAKE_AWS_SCENARIO="external-role",
        )

        self.assertNotEqual(result.returncode, 0)
        preflight = json.loads(
            (output_dir / "ownership-preflight.json").read_text(encoding="utf-8")
        )
        self.assertFalse(preflight["passed"])
        self.assertIn(
            {
                "code": "EXTERNALLY_OWNED_NAME_CONFLICT",
                "resourceType": "AWS::IAM::Role",
                "resource": "market-dashboard-cloudformation-deployment-v2",
            },
            preflight["conflicts"],
        )

    def test_untagged_existing_bootstrap_stack_and_role_are_not_adopted(self):
        output_dir = Path(self.temp.name) / "rollback"
        result = self.run_export(
            output_dir,
            FAKE_AWS_SCENARIO="owned-bootstrap-untagged",
        )

        self.assertNotEqual(result.returncode, 0)
        preflight = json.loads(
            (output_dir / "ownership-preflight.json").read_text(encoding="utf-8")
        )
        mismatches = {
            (item["resourceType"], item["resource"])
            for item in preflight["conflicts"]
            if item["code"] == "OWNERSHIP_TAG_MISMATCH"
        }
        self.assertEqual(
            mismatches,
            {
                (
                    "AWS::CloudFormation::Stack",
                    "market-dashboard-deployment-role-v2",
                ),
                (
                    "AWS::IAM::Role",
                    "market-dashboard-cloudformation-deployment-v2",
                ),
            },
        )

    def test_untagged_existing_target_stack_is_not_adopted(self):
        output_dir = Path(self.temp.name) / "rollback"
        result = self.run_export(
            output_dir,
            FAKE_AWS_SCENARIO="target-stack-untagged",
        )

        self.assertNotEqual(result.returncode, 0)
        preflight = json.loads(
            (output_dir / "ownership-preflight.json").read_text(encoding="utf-8")
        )
        self.assertIn(
            {
                "code": "OWNERSHIP_TAG_MISMATCH",
                "resourceType": "AWS::CloudFormation::Stack",
                "resource": "market-dashboard-readiness-v2",
            },
            preflight["conflicts"],
        )

    def test_export_requires_cli_v2_and_sso_identity(self):
        v1_output = Path(self.temp.name) / "rollback-v1"
        v1_result = self.run_export(
            v1_output,
            FAKE_AWS_SCENARIO="aws-cli-v1",
        )
        self.assertEqual(v1_result.returncode, 2)
        self.assertIn("AWS CLI v2 is required", v1_result.stderr)
        self.assertFalse(v1_output.exists())

        non_sso_output = Path(self.temp.name) / "rollback-non-sso"
        non_sso_result = self.run_export(
            non_sso_output,
            FAKE_AWS_SCENARIO="non-sso-caller",
        )
        self.assertEqual(non_sso_result.returncode, 2)
        self.assertIn("non-SSO identity", non_sso_result.stderr)
        calls_after_failure = self.harness.calls()
        identity_index = max(
            index
            for index, call in enumerate(calls_after_failure)
            if "get-caller-identity" in call
        )
        self.assertFalse(
            any(
                any(
                    service in call
                    for service in ("lambda", "scheduler", "events", "dynamodb")
                )
                for call in calls_after_failure[identity_index + 1 :]
            )
        )

    def test_export_clears_every_ambient_credential_source(self):
        output_dir = Path(self.temp.name) / "rollback"
        poisoned_environment = {
            "AWS_ACCESS_KEY_ID": "poison-access-key",
            "AWS_SECRET_ACCESS_KEY": "poison-secret-key",
            "AWS_SESSION_TOKEN": "poison-session-token",
            "AWS_SECURITY_TOKEN": "poison-security-token",
            "AWS_PROFILE": "poison-profile",
            "AWS_DEFAULT_PROFILE": "poison-default-profile",
            "AWS_ROLE_ARN": "arn:aws:iam::000000000000:role/poison",
            "AWS_ROLE_SESSION_NAME": "poison-session",
            "AWS_WEB_IDENTITY_TOKEN_FILE": "/tmp/poison-token",
            "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI": "/poison",
            "AWS_CONTAINER_CREDENTIALS_FULL_URI": "http://127.0.0.1/poison",
            "AWS_CONTAINER_AUTHORIZATION_TOKEN": "poison-container-token",
            "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE": "/tmp/poison-container-token",
            "AWS_SHARED_CREDENTIALS_FILE": "/tmp/poison-credentials",
        }
        result = self.run_export(
            output_dir,
            FAKE_AWS_SCENARIO="all-absent",
            **poisoned_environment,
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        environments = self.harness.aws_environments()
        self.assertTrue(environments)
        self.assertEqual(environments, [{} for _ in environments])

    def test_stack_template_and_resource_inventory_fail_closed(self):
        for operation in ["get-template", "list-stack-resources"]:
            with self.subTest(operation=operation):
                output_dir = Path(self.temp.name) / f"rollback-{operation}"
                result = self.run_export(
                    output_dir,
                    FAKE_AWS_SCENARIO="access-denied",
                    FAKE_AWS_FAILURE_TARGET=f"cloudformation/{operation}",
                )

                self.assertNotEqual(result.returncode, 0)
                self.assertIn("AccessDeniedException", result.stderr)
                self.assertIn(
                    f"cloudformation {operation}",
                    result.stderr,
                )

    def test_access_denied_is_fatal_and_is_not_mislabeled_absent(self):
        output_dir = Path(self.temp.name) / "rollback"
        result = self.run_export(
            output_dir,
            FAKE_AWS_SCENARIO="access-denied",
            FAKE_AWS_FAILURE_TARGET="scheduler/get-schedule",
        )

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("AccessDeniedException", result.stderr)
        self.assertIn("Rollback export failed", result.stderr)
        self.assertFalse(
            (output_dir / "schedules" / "test-schedule.absent.json").exists()
        )
        self.assertEqual(stat.S_IMODE(output_dir.stat().st_mode), 0o700)

    def test_network_failure_is_fatal_and_is_not_mislabeled_absent(self):
        output_dir = Path(self.temp.name) / "rollback"
        result = self.run_export(
            output_dir,
            FAKE_AWS_SCENARIO="network-failure",
            FAKE_AWS_FAILURE_TARGET="cloudformation/describe-stacks",
        )

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Could not connect to the endpoint", result.stderr)
        self.assertFalse((output_dir / "cloudformation-stack.absent.json").exists())

    def test_output_must_be_new_and_outside_the_repository(self):
        existing = Path(self.temp.name) / "existing"
        existing.mkdir()
        existing_result = self.run_export(existing)
        self.assertNotEqual(existing_result.returncode, 0)
        self.assertIn("Refusing to overwrite", existing_result.stderr)

        inside_repo = ROOT / ".rollback-export-test"
        self.assertFalse(inside_repo.exists())
        inside_result = self.run_export(inside_repo)
        self.assertEqual(inside_result.returncode, 2)
        self.assertIn("outside the repository", inside_result.stderr)
        self.assertFalse(inside_repo.exists())

    def test_stack_name_override_cannot_escape_the_canonical_target(self):
        output_dir = Path(self.temp.name) / "rollback"
        result = self.run_export(
            output_dir,
            MARKET_DASHBOARD_STACK_NAME="some-other-stack",
        )

        self.assertEqual(result.returncode, 2)
        self.assertIn("pinned to stack market-dashboard-readiness-v2", result.stderr)
        self.assertEqual(self.harness.calls(), [])
        self.assertFalse(output_dir.exists())

    def test_extra_resource_names_cannot_escape_the_export_directory(self):
        for environment in (
            {"MARKET_DASHBOARD_EXPORT_FUNCTIONS": "../outside"},
            {"MARKET_DASHBOARD_EXPORT_SCHEDULES": "../../outside"},
            {"MARKET_DASHBOARD_EXPORT_EVENT_RULES": "../../../outside"},
        ):
            with self.subTest(environment=environment):
                output_dir = Path(self.temp.name) / "rollback"
                result = subprocess.run(
                    [str(EXPORT_SCRIPT), str(output_dir)],
                    cwd=ROOT,
                    env=self.harness.environment(**environment),
                    check=False,
                    capture_output=True,
                    text=True,
                )

                self.assertNotEqual(result.returncode, 0)
                self.assertIn("Unsafe", result.stderr)
                self.assertEqual(self.harness.calls(), [])
                self.assertFalse(output_dir.exists())

    def test_default_function_inventory_includes_the_pdf_processor(self):
        source = EXPORT_SCRIPT.read_text(encoding="utf-8")
        self.assertIn("market-dashboard-hedgeye-pdf-processor-v1", source)

    def test_default_inventory_includes_watchdog_function_and_event_rule(self):
        output_dir = Path(self.temp.name) / "rollback"
        result = self.run_export(output_dir, FAKE_AWS_SCENARIO="all-absent")

        self.assertEqual(result.returncode, 0, result.stderr)
        watchdog_name = "market-dashboard-hermes-cloud-watchdog-v1"
        self.assertTrue(
            (
                output_dir
                / "functions"
                / watchdog_name
                / "function.absent.json"
            ).is_file()
        )
        self.assertTrue(
            (
                output_dir
                / "event-rules"
                / f"{watchdog_name}.absent.json"
            ).is_file()
        )
        calls = self.harness.calls()
        self.assertTrue(
            any(
                "lambda" in call
                and "get-function" in call
                and call[call.index("--function-name") + 1] == watchdog_name
                for call in calls
            )
        )
        watchdog_rule_call = next(
            call
            for call in calls
            if (
                "events" in call
                and "describe-rule" in call
                and call[call.index("--name") + 1] == watchdog_name
            )
        )
        self.assertEqual(
            watchdog_rule_call[
                watchdog_rule_call.index("--event-bus-name") + 1
            ],
            "default",
        )


if __name__ == "__main__":
    unittest.main()
