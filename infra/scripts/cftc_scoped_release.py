#!/usr/bin/env python3
"""Build and verify a CFTC-only overlay of the deployed readiness templates.

This is a distinct scoped release contract, not a replacement for a full-stack
tested-release receipt. The CLI prepares local files only. AWS execution belongs
to an orchestrator that rechecks these baselines and inspects both change sets.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import hmac
import json
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Mapping, Sequence
from urllib.parse import parse_qs, urlparse
from zoneinfo import ZoneInfo

from prepare_tested_release import canonical_json_bytes, load_template


ACCOUNT = "915328198276"
REGION = "us-west-1"
ARTIFACT_BUCKET = f"market-dashboard-sam-artifacts-{ACCOUNT}-{REGION}"
READINESS_STACK = "market-dashboard-readiness-v2"
BOOTSTRAP_STACK = "market-dashboard-deployment-role-v2"
FUNCTION_NAME = "market-dashboard-cftc-ingestor-v1"
SCHEDULE_NAME = "market-dashboard-cftc-weekday-v1"
RECEIPT_KIND = "market-dashboard-cftc-scoped-overlay-release"
REQUIRED_CHECKS = {"cftc-tests", "cftc-template-validation"}
CFTC_TEST_MODULES = [
    "infra.tests.test_cftc_ingestor", "infra.tests.test_cftc_september_parity",
    "infra.tests.test_cftc_infrastructure_contract", "infra.tests.test_cftc_scoped_release",
]
SHA256 = re.compile(r"[a-f0-9]{64}")
ADDED_RESOURCES = {
    "CftcIngestorFunction", "CftcSchedulerInvokeRole", "CftcWeekdaySchedule",
}
ADDED_OUTPUTS = {"CftcIngestorFunctionName", "CftcWeekdayScheduleName"}
INSTALL_CHANGES = {
    "CftcIngestorFunction": "AWS::Lambda::Function",
    "CftcIngestorFunctionRole": "AWS::IAM::Role",
    "CftcIngestorFunctionEventInvokeConfig": "AWS::Lambda::EventInvokeConfig",
    "CftcSchedulerInvokeRole": "AWS::IAM::Role",
    "CftcWeekdaySchedule": "AWS::Scheduler::Schedule",
}


class ScopedReleaseError(ValueError):
    pass


def digest(value: Any) -> str:
    return hashlib.sha256(canonical_json_bytes(value)).hexdigest()


def load_export(path: str | Path) -> dict[str, Any]:
    """Accept original YAML, JSON templates, or JSON-encoded YAML exports."""
    raw = Path(path).read_text(encoding="utf-8")
    try:
        decoded = json.loads(raw)
    except json.JSONDecodeError:
        decoded = raw
    if isinstance(decoded, Mapping) and "TemplateBody" in decoded:
        decoded = decoded["TemplateBody"]
    return dict(load_template(decoded))


def _require_sha(value: Any, label: str) -> str:
    if not isinstance(value, str) or not SHA256.fullmatch(value):
        raise ScopedReleaseError(f"{label} must be an exact SHA-256 digest")
    return value


def validate_code_uri(code_uri: str) -> dict[str, str]:
    parsed = urlparse(code_uri)
    query = parse_qs(parsed.query)
    versions = query.get("versionId", [])
    if (parsed.scheme != "s3" or parsed.netloc != ARTIFACT_BUCKET
            or not parsed.path.strip("/") or set(query) != {"versionId"}
            or len(versions) != 1 or versions[0] in {"", "null"} or parsed.fragment):
        raise ScopedReleaseError("CFTC code must use one immutable version in the owned artifact bucket")
    return {"bucket": parsed.netloc, "key": parsed.path.lstrip("/"), "versionId": versions[0]}


def _deployment_statements(template: Mapping[str, Any]) -> list[dict[str, Any]]:
    try:
        role = template["Resources"]["DeploymentRole"]
        policies = role["Properties"]["Policies"]
        policy = next(item for item in policies if item["PolicyName"] == "market-dashboard-readiness-deployment")
        statements = policy["PolicyDocument"]["Statement"]
    except (KeyError, StopIteration, TypeError) as exc:
        raise ScopedReleaseError("Expected deployed bootstrap role policy is missing") from exc
    if role.get("Type") != "AWS::IAM::Role" or not isinstance(statements, list):
        raise ScopedReleaseError("Unexpected bootstrap role shape")
    return statements


def build_bootstrap_overlay(base: Mapping[str, Any]) -> dict[str, Any]:
    result = copy.deepcopy(dict(base))
    statements = _deployment_statements(result)
    additions = {
        "ManageOwnedFunctions": f"arn:${{AWS::Partition}}:lambda:${{AWS::Region}}:${{AWS::AccountId}}:function:{FUNCTION_NAME}",
        "ManageOwnedFunctionEventInvokeConfigs": f"arn:${{AWS::Partition}}:lambda:${{AWS::Region}}:${{AWS::AccountId}}:function:{FUNCTION_NAME}:$LATEST",
        "ManageOwnedSchedules": f"arn:${{AWS::Partition}}:scheduler:${{AWS::Region}}:${{AWS::AccountId}}:schedule/default/{SCHEDULE_NAME}",
    }
    for sid, arn in additions.items():
        candidates = [item for item in statements if item.get("Sid") == sid]
        if len(candidates) != 1 or not isinstance(candidates[0].get("Resource"), (list, str, dict)):
            raise ScopedReleaseError(f"Expected one resource allowlist for {sid}")
        original_resources = candidates[0]["Resource"]
        resources = original_resources if isinstance(original_resources, list) else [original_resources]
        addition = {"Fn::Sub": arn}
        literal = arn.replace("${AWS::Partition}", "aws").replace("${AWS::Region}", REGION).replace("${AWS::AccountId}", ACCOUNT)
        if addition not in resources and literal not in resources:
            candidates[0]["Resource"] = [*resources, addition]
    return result


def validate_bootstrap_overlay(base: Mapping[str, Any], target: Mapping[str, Any]) -> None:
    if target != build_bootstrap_overlay(base):
        raise ScopedReleaseError("Bootstrap overlay changes more than the three exact CFTC ARN allowlists")


def _scheduler_role() -> dict[str, Any]:
    return {
        "Type": "AWS::IAM::Role",
        "Properties": {
            "AssumeRolePolicyDocument": {"Version": "2012-10-17", "Statement": [{
                "Effect": "Allow", "Principal": {"Service": "scheduler.amazonaws.com"},
                "Action": "sts:AssumeRole",
            }]},
            "Policies": [{"PolicyName": "invoke-official-cftc-ingestor", "PolicyDocument": {
                "Version": "2012-10-17", "Statement": [{
                    "Effect": "Allow", "Action": "lambda:InvokeFunction",
                    "Resource": {"Fn::GetAtt": ["CftcIngestorFunction", "Arn"]},
                }],
            }}],
        },
    }


def _validate_cftc_resources(function: Mapping[str, Any], schedule: Mapping[str, Any]) -> None:
    properties = function.get("Properties", {})
    target = schedule.get("Properties", {})
    if (function.get("Type") != "AWS::Serverless::Function"
            or properties.get("FunctionName") != FUNCTION_NAME
            or properties.get("Handler") != "cftc_ingestor.lambda_handler"
            or properties.get("Architectures") != ["arm64"]
            or properties.get("Timeout") != 120
            or properties.get("ReservedConcurrentExecutions") != 1):
        raise ScopedReleaseError("Unexpected canonical CFTC Lambda contract")
    if (schedule.get("Type") != "AWS::Scheduler::Schedule"
            or target.get("Name") != SCHEDULE_NAME
            or target.get("State") != {"Ref": "CftcScheduleState"}
            or target.get("ScheduleExpression") != "cron(31 15 * * ? *)"
            or target.get("ScheduleExpressionTimezone") != "America/New_York"
            or target.get("FlexibleTimeWindow") != {"Mode": "OFF"}
            or target.get("Target", {}).get("Arn") != {"Fn::GetAtt": ["CftcIngestorFunction", "Arn"]}):
        raise ScopedReleaseError("Unexpected daily CFTC schedule contract")
    expected_input = {"source": "aws-scheduler", "scheduleId": SCHEDULE_NAME, "mode": "current"}
    try:
        actual_input = json.loads(target["Target"]["Input"])
    except (KeyError, TypeError, json.JSONDecodeError) as exc:
        raise ScopedReleaseError("Invalid CFTC schedule input") from exc
    if actual_input != expected_input:
        raise ScopedReleaseError("CFTC schedule must invoke only the current official-data path")


def build_readiness_overlay(
    base: Mapping[str, Any], canonical: Mapping[str, Any], code_uri: str, source_sha256: str,
) -> dict[str, Any]:
    validate_code_uri(code_uri)
    _require_sha(source_sha256, "Source identity")
    result = copy.deepcopy(dict(base))
    resources = result.setdefault("Resources", {})
    if ADDED_RESOURCES & resources.keys() or "CftcScheduleState" in result.get("Parameters", {}):
        raise ScopedReleaseError("Initial CFTC installation requires an unmodified pre-CFTC baseline")
    if ADDED_OUTPUTS & result.get("Outputs", {}).keys():
        raise ScopedReleaseError("CFTC output already exists in baseline")
    try:
        function = copy.deepcopy(canonical["Resources"]["CftcIngestorFunction"])
        schedule = copy.deepcopy(canonical["Resources"]["CftcWeekdaySchedule"])
        parameter = copy.deepcopy(canonical["Parameters"]["CftcScheduleState"])
        outputs = {key: copy.deepcopy(canonical["Outputs"][key]) for key in ADDED_OUTPUTS}
    except KeyError as exc:
        raise ScopedReleaseError("Canonical CFTC resource definitions are incomplete") from exc
    _validate_cftc_resources(function, schedule)
    if canonical["Resources"].get("CftcSchedulerInvokeRole") != _scheduler_role():
        raise ScopedReleaseError("Canonical CFTC scheduler role must invoke only the dedicated function")
    if parameter.get("Default") != "DISABLED" or set(parameter.get("AllowedValues", [])) != {"DISABLED", "ENABLED"}:
        raise ScopedReleaseError("CFTC installation must start disabled")
    function["Properties"]["CodeUri"] = code_uri
    function["Properties"].setdefault("Environment", {}).setdefault("Variables", {})["BUILD_VERSION"] = source_sha256
    schedule["Properties"]["Target"]["RoleArn"] = {"Fn::GetAtt": ["CftcSchedulerInvokeRole", "Arn"]}
    resources.update({"CftcIngestorFunction": function, "CftcSchedulerInvokeRole": _scheduler_role(), "CftcWeekdaySchedule": schedule})
    result.setdefault("Parameters", {})["CftcScheduleState"] = parameter
    result.setdefault("Outputs", {}).update(outputs)
    return result


def validate_readiness_overlay(
    base: Mapping[str, Any], target: Mapping[str, Any], canonical: Mapping[str, Any],
    code_uri: str, source_sha256: str,
) -> None:
    if target != build_readiness_overlay(base, canonical, code_uri, source_sha256):
        raise ScopedReleaseError("Readiness overlay changes definitions outside the exact CFTC additions")


def build_schedule_proof_overlay(
    installed_canonical: Mapping[str, Any], run_at: str, *, now_utc: datetime | None = None,
) -> dict[str, Any]:
    """Temporarily change only the daily schedule expression for a real trigger.

    The at() time is in the existing America/New_York timezone. Its target,
    source input, role, retry policy and every unrelated definition stay intact.
    State is enabled separately through the sole allowed parameter override.
    """
    try:
        target = installed_canonical["Resources"]["CftcWeekdaySchedule"]["Properties"]
        parsed = datetime.strptime(run_at, "%Y-%m-%dT%H:%M:%S")
    except (KeyError, TypeError, ValueError) as exc:
        raise ScopedReleaseError("Schedule proof requires a complete local second-resolution timestamp") from exc
    if target.get("ScheduleExpression") != "cron(31 15 * * ? *)" or target.get("ScheduleExpressionTimezone") != "America/New_York":
        raise ScopedReleaseError("Schedule proof must start from the tested daily schedule")
    current = now_utc or datetime.now(timezone.utc)
    if current.tzinfo is None:
        raise ScopedReleaseError("Schedule proof clock must include its timezone")
    scheduled = parsed.replace(tzinfo=ZoneInfo("America/New_York")).astimezone(timezone.utc)
    if not timedelta(0) < scheduled - current <= timedelta(minutes=15):
        raise ScopedReleaseError("Schedule proof must run in the next fifteen minutes")
    result = copy.deepcopy(dict(installed_canonical))
    result["Resources"]["CftcWeekdaySchedule"]["Properties"]["ScheduleExpression"] = f"at({run_at})"
    return result


def validate_schedule_overlay(
    installed_canonical: Mapping[str, Any], candidate: Mapping[str, Any], *,
    proof_at: str | None = None, now_utc: datetime | None = None,
) -> None:
    expected = (build_schedule_proof_overlay(installed_canonical, proof_at, now_utc=now_utc)
                if proof_at is not None else installed_canonical)
    if candidate != expected:
        raise ScopedReleaseError("Schedule transition changes more than the one allowed proof expression")


def build_schedule_retime_overlay(
    base: Mapping[str, Any], canonical: Mapping[str, Any],
) -> dict[str, Any]:
    """Move an installed CFTC schedule without changing its target or stack controls."""
    try:
        installed = copy.deepcopy(base["Resources"]["CftcWeekdaySchedule"])
        desired = copy.deepcopy(canonical["Resources"]["CftcWeekdaySchedule"])
        function = canonical["Resources"]["CftcIngestorFunction"]
        previous_expression = installed["Properties"]["ScheduleExpression"]
    except (KeyError, TypeError) as exc:
        raise ScopedReleaseError("Schedule retiming requires the installed CFTC resource") from exc
    _validate_cftc_resources(function, desired)
    if previous_expression not in {"cron(15 16 * * ? *)", "cron(31 15 * * ? *)"}:
        raise ScopedReleaseError("Schedule retiming requires a recognized daily CFTC baseline")
    changed_properties = ("Description", "ScheduleExpression")
    for resource in (installed, desired):
        for key in changed_properties:
            resource["Properties"].pop(key, None)
    if installed != desired:
        raise ScopedReleaseError("Schedule retiming cannot change CFTC identity, target, state, or delivery controls")
    result = copy.deepcopy(dict(base))
    for key in changed_properties:
        result["Resources"]["CftcWeekdaySchedule"]["Properties"][key] = canonical["Resources"]["CftcWeekdaySchedule"]["Properties"][key]
    return result


def validate_schedule_retime_overlay(
    base: Mapping[str, Any], candidate: Mapping[str, Any], canonical: Mapping[str, Any],
) -> None:
    if candidate != build_schedule_retime_overlay(base, canonical):
        raise ScopedReleaseError("Schedule retiming changes more than the CFTC expression and description")


def build_parameter_overrides(
    existing_parameters: Sequence[Mapping[str, Any]], schedule_state: str = "DISABLED",
) -> list[dict[str, Any]]:
    if schedule_state not in {"DISABLED", "ENABLED"}:
        raise ScopedReleaseError("Invalid CFTC schedule state")
    keys = [item.get("ParameterKey") for item in existing_parameters]
    if any(not isinstance(key, str) or not key for key in keys) or len(set(keys)) != len(keys):
        raise ScopedReleaseError("Invalid existing parameter inventory")
    return [
        {"ParameterKey": key, "UsePreviousValue": True}
        for key in keys if key != "CftcScheduleState"
    ] + [{"ParameterKey": "CftcScheduleState", "ParameterValue": schedule_state}]


def validate_change_set(changes: Sequence[Mapping[str, Any]] | Mapping[str, Any], phase: str) -> None:
    if isinstance(changes, Mapping):
        changes = changes.get("Changes", [])
    contracts = {
        "bootstrap": ({"DeploymentRole": "AWS::IAM::Role"}, "Modify"),
        "install": (INSTALL_CHANGES, "Add"),
        "enable": ({"CftcWeekdaySchedule": "AWS::Scheduler::Schedule"}, "Modify"),
        "retime": ({"CftcWeekdaySchedule": "AWS::Scheduler::Schedule"}, "Modify"),
    }
    if phase not in contracts:
        raise ScopedReleaseError("Unknown CFTC change-set phase")
    allowed, action = contracts[phase]
    observed = set()
    for change in changes:
        resource = change.get("ResourceChange", {})
        logical_id = resource.get("LogicalResourceId")
        if (logical_id in observed or logical_id not in allowed
                or resource.get("ResourceType") != allowed[logical_id]
                or resource.get("Action") != action
                or resource.get("Replacement") not in {None, False, "False"}):
            raise ScopedReleaseError(f"Unexpected or replacing {phase} resource change: {logical_id}")
        observed.add(logical_id)
    if observed != set(allowed):
        raise ScopedReleaseError(f"Incomplete {phase} change set")


def create_scoped_receipt(
    *, base_bootstrap: Mapping[str, Any], base_readiness: Mapping[str, Any],
    target_bootstrap: Mapping[str, Any], target_readiness: Mapping[str, Any],
    canonical: Mapping[str, Any], code_uri: str, source_sha256: str,
    artifact_sha256: str, source_manifest: Mapping[str, str],
    verifications: Sequence[Mapping[str, Any]], signing_key: bytes,
) -> dict[str, Any]:
    validate_bootstrap_overlay(base_bootstrap, target_bootstrap)
    validate_readiness_overlay(base_readiness, target_readiness, canonical, code_uri, source_sha256)
    _require_sha(artifact_sha256, "Packaged artifact")
    if not source_manifest or any(not SHA256.fullmatch(str(value)) for value in source_manifest.values()):
        raise ScopedReleaseError("An exact source manifest is required")
    if source_sha256 != digest(dict(source_manifest)):
        raise ScopedReleaseError("Source identity does not match the exact source manifest")
    if ({record.get("id") for record in verifications} != REQUIRED_CHECKS
            or len(verifications) != len(REQUIRED_CHECKS)):
        raise ScopedReleaseError("Both scoped code tests and target template validation are required")
    for record in verifications:
        command = record.get("command")
        valid_command = isinstance(command, (list, tuple)) and len(command) > 1
        if valid_command and record["id"] == "cftc-tests":
            valid_command = Path(command[0]).name.startswith("python3") and list(command[1:]) == ["-m", "unittest", *CFTC_TEST_MODULES]
        elif valid_command:
            valid_command = Path(command[0]).name == "sam" and list(command[1:4]) == ["validate", "--lint", "--template-file"] and len(command) == 5
        if (record.get("passed") is not True or record.get("returnCode") != 0
                or record.get("sourceSha256") != source_sha256
                or not valid_command
                or not SHA256.fullmatch(str(record.get("stdoutSha256", "")))
                or not SHA256.fullmatch(str(record.get("stderrSha256", "")))):
            raise ScopedReleaseError("Scoped test evidence is incomplete or failed")
        if record["id"] == "cftc-template-validation" and record.get("templateSha256") != digest(target_readiness):
            raise ScopedReleaseError("Template validation does not cover this exact overlay")
    if len(signing_key) < 32:
        raise ScopedReleaseError("Receipt signing key must contain at least 256 bits")
    payload = {
        "schemaVersion": 1, "kind": RECEIPT_KIND, "account": ACCOUNT, "region": REGION,
        "stacks": {"bootstrap": BOOTSTRAP_STACK, "readiness": READINESS_STACK},
        "baseline": {"bootstrap": digest(base_bootstrap), "readiness": digest(base_readiness)},
        "target": {"bootstrap": digest(target_bootstrap), "readiness": digest(target_readiness)},
        "sourceSha256": source_sha256, "sourceManifest": dict(source_manifest),
        "artifact": {**validate_code_uri(code_uri), "sha256": artifact_sha256},
        "verifications": list(verifications),
    }
    return {**payload, "authentication": {"algorithm": "HMAC-SHA256", "value": hmac.new(signing_key, canonical_json_bytes(payload), hashlib.sha256).hexdigest()}}


def verify_scoped_receipt(receipt: Mapping[str, Any], *, signing_key: bytes, **expected: Any) -> None:
    rebuilt = create_scoped_receipt(signing_key=signing_key, **expected)
    actual_mac = receipt.get("authentication", {}).get("value", "")
    if (receipt.get("kind") != RECEIPT_KIND or receipt != rebuilt
            or not hmac.compare_digest(str(actual_mac), rebuilt["authentication"]["value"])):
        raise ScopedReleaseError("Scoped receipt does not match the tested source, templates and artifact")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["prepare"])
    parser.add_argument("--bootstrap-base", required=True)
    parser.add_argument("--readiness-base", required=True)
    parser.add_argument("--canonical", required=True)
    parser.add_argument("--code-uri", required=True)
    parser.add_argument("--source-sha256", required=True)
    parser.add_argument("--output-dir", required=True)
    args = parser.parse_args()
    output = Path(args.output_dir).resolve()
    output.mkdir(mode=0o700, parents=True, exist_ok=False)
    bootstrap = load_export(args.bootstrap_base)
    readiness = load_export(args.readiness_base)
    canonical = load_export(args.canonical)
    target_bootstrap = build_bootstrap_overlay(bootstrap)
    target_readiness = build_readiness_overlay(readiness, canonical, args.code_uri, args.source_sha256)
    files = {"bootstrap-overlay.json": target_bootstrap, "readiness-overlay.json": target_readiness,
             "overlay-manifest.json": {"kind": "cftc-overlay-preparation-not-a-release-receipt",
                "baseline": {"bootstrap": digest(bootstrap), "readiness": digest(readiness)},
                "target": {"bootstrap": digest(target_bootstrap), "readiness": digest(target_readiness)},
                "sourceSha256": args.source_sha256, "artifact": validate_code_uri(args.code_uri)}}
    for filename, value in files.items():
        path = output / filename
        path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")
        path.chmod(0o600)
    print(json.dumps({"prepared": str(output), "awsExecuted": False}))


if __name__ == "__main__":
    main()
