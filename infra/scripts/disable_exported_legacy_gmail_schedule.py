#!/usr/bin/env python3
"""Disable one exported legacy Gmail timer without definition drift."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile
from typing import Any


EXPECTED_ACCOUNT = "915328198276"
EXPECTED_REGION = "us-west-1"
EXPECTED_PROFILE = "market-dashboard-admin"
EXPECTED_TARGET_STACK = "market-dashboard-readiness-v2"
EXPECTED_BOOTSTRAP_STACK = "market-dashboard-deployment-role-v2"
CANONICAL_GMAIL_SCHEDULE = "market-dashboard-gmail-v2-every-15m"
NAME_PATTERN = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
REPO_ROOT = Path(__file__).resolve().parents[2]
CREDENTIAL_ENVIRONMENT_KEYS = {
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
}
UPDATE_FIELDS = (
    "Name",
    "GroupName",
    "ScheduleExpression",
    "ScheduleExpressionTimezone",
    "StartDate",
    "EndDate",
    "Description",
    "KmsKeyArn",
    "FlexibleTimeWindow",
    "Target",
    "ActionAfterCompletion",
)


class CutoverError(RuntimeError):
    """A fail-closed validation or AWS operation error."""


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Disable one legacy Gmail EventBridge Scheduler schedule or "
            "EventBridge rule only when it exactly matches a verified "
            "rollback export."
        )
    )
    parser.add_argument("--rollback-export", required=True, type=Path)
    parser.add_argument("--schedule-name", required=True)
    parser.add_argument("--admin-profile", default=EXPECTED_PROFILE)
    return parser.parse_args()


def private_aws_environment() -> dict[str, str]:
    environment = os.environ.copy()
    for key in CREDENTIAL_ENVIRONMENT_KEYS:
        environment.pop(key, None)
    environment.update(
        {
            "AWS_EC2_METADATA_DISABLED": "true",
            "AWS_PAGER": "",
            "AWS_CLI_AUTO_PROMPT": "off",
        }
    )
    return environment


def run_aws(
    arguments: list[str],
    *,
    profile: str | None = None,
    region: str | None = None,
) -> subprocess.CompletedProcess[str]:
    command = ["aws"]
    if profile is not None:
        command.extend(["--profile", profile])
    if region is not None:
        command.extend(["--region", region])
    command.extend(arguments)
    try:
        return subprocess.run(
            command,
            env=private_aws_environment(),
            check=True,
            capture_output=True,
            text=True,
        )
    except FileNotFoundError as error:
        raise CutoverError("AWS CLI v2 is required.") from error
    except subprocess.CalledProcessError as error:
        operation = " ".join(arguments[:2])
        raise CutoverError(
            f"AWS operation failed closed: {operation} (exit {error.returncode})."
        ) from error


def validate_aws_access(profile: str) -> None:
    if profile != EXPECTED_PROFILE:
        raise CutoverError(
            f"Legacy Gmail cutover requires the {EXPECTED_PROFILE} SSO profile."
        )
    version_response = run_aws(["--version"])
    version = (version_response.stdout or version_response.stderr).strip()
    if not version.startswith("aws-cli/2."):
        raise CutoverError(f"AWS CLI v2 is required; found {version or 'unknown'}.")

    profile_values = {}
    for key in (
        "region",
        "sso_account_id",
        "sso_session",
        "sso_start_url",
        "sso_role_name",
    ):
        try:
            profile_values[key] = run_aws(
                ["configure", "get", key, "--profile", profile]
            ).stdout.strip()
        except CutoverError:
            profile_values[key] = ""
    if (
        profile_values["region"] != EXPECTED_REGION
        or profile_values["sso_account_id"] != EXPECTED_ACCOUNT
    ):
        raise CutoverError(
            f"Profile {profile} must target account {EXPECTED_ACCOUNT} "
            f"in {EXPECTED_REGION}."
        )
    if not profile_values["sso_role_name"] or not (
        profile_values["sso_session"] or profile_values["sso_start_url"]
    ):
        raise CutoverError(
            f"Profile {profile} is not an AWS IAM Identity Center/SSO profile."
        )

    identity = json.loads(
        run_aws(
            ["sts", "get-caller-identity", "--output", "json"],
            profile=profile,
            region=EXPECTED_REGION,
        ).stdout
    )
    account = str(identity.get("Account") or "")
    arn = str(identity.get("Arn") or "")
    identity_pattern = re.compile(
        rf"^arn:aws:sts::{EXPECTED_ACCOUNT}:"
        r"assumed-role/AWSReservedSSO_[^/]+/.+$"
    )
    if account != EXPECTED_ACCOUNT or identity_pattern.fullmatch(arn) is None:
        raise CutoverError(
            "Administrator profile did not resolve to the required SSO "
            "account identity."
        )


def parse_checksum_manifest(rollback: Path) -> dict[Path, str]:
    manifest = rollback / "SHA256SUMS"
    if not manifest.is_file() or manifest.is_symlink():
        raise CutoverError("Rollback export has no regular SHA256SUMS manifest.")
    expected: dict[Path, str] = {}
    for line_number, raw_line in enumerate(
        manifest.read_text(encoding="utf-8").splitlines(),
        start=1,
    ):
        match = re.fullmatch(r"([0-9a-fA-F]{64})  (\./.+)", raw_line)
        if match is None:
            raise CutoverError(
                f"Invalid rollback checksum entry on line {line_number}."
            )
        relative = Path(match.group(2))
        if relative.is_absolute() or ".." in relative.parts:
            raise CutoverError("Rollback checksum path escapes the export.")
        candidate = (rollback / relative).resolve(strict=False)
        try:
            candidate.relative_to(rollback)
        except ValueError as error:
            raise CutoverError("Rollback checksum path escapes the export.") from error
        if candidate in expected:
            raise CutoverError("Rollback checksum manifest has a duplicate path.")
        expected[candidate] = match.group(1).lower()
    return expected


def validate_rollback_export(raw_path: Path) -> Path:
    if not raw_path.is_absolute():
        raise CutoverError("Rollback export path must be absolute.")
    rollback = raw_path.resolve(strict=False)
    try:
        rollback.relative_to(REPO_ROOT)
    except ValueError:
        pass
    else:
        raise CutoverError("Rollback export must be outside the repository.")
    if not rollback.is_dir() or rollback.is_symlink():
        raise CutoverError("Rollback export directory is missing or unsafe.")
    if stat.S_IMODE(rollback.stat().st_mode) & 0o077:
        raise CutoverError(
            "Rollback export must not be accessible by group or other users."
        )

    expected = parse_checksum_manifest(rollback)
    actual_files = {
        path.resolve(strict=False)
        for path in rollback.rglob("*")
        if path.is_file() and path.name != "SHA256SUMS"
    }
    if set(expected) != actual_files:
        raise CutoverError(
            "Rollback checksum manifest does not cover exactly every artifact."
        )
    for path, digest in expected.items():
        if path.is_symlink() or not path.is_file():
            raise CutoverError("Rollback export contains an unsafe artifact.")
        observed = hashlib.sha256(path.read_bytes()).hexdigest()
        if observed != digest:
            raise CutoverError(f"Rollback checksum mismatch for {path.name}.")

    preflight_path = rollback / "ownership-preflight.json"
    if preflight_path.resolve(strict=False) not in expected:
        raise CutoverError("Rollback preflight is not covered by the manifest.")
    preflight = json.loads(preflight_path.read_text(encoding="utf-8"))
    if preflight.get("passed") is not True or preflight.get("conflicts"):
        raise CutoverError("Rollback ownership preflight did not pass.")
    required_values = {
        "account": EXPECTED_ACCOUNT,
        "region": EXPECTED_REGION,
        "targetStack": EXPECTED_TARGET_STACK,
        "bootstrapStack": EXPECTED_BOOTSTRAP_STACK,
    }
    for key, value in required_values.items():
        if preflight.get(key) != value:
            raise CutoverError(f"Rollback preflight has an unexpected {key}.")
    return rollback


def load_exported_schedule(rollback: Path, schedule_name: str) -> dict[str, Any]:
    if not NAME_PATTERN.fullmatch(schedule_name):
        raise CutoverError("Schedule name contains unsupported characters.")
    if schedule_name == CANONICAL_GMAIL_SCHEDULE:
        raise CutoverError("The canonical Gmail schedule is not a legacy target.")
    schedule_path = rollback / "schedules" / f"{schedule_name}.json"
    absent_path = rollback / "schedules" / f"{schedule_name}.absent.json"
    if absent_path.exists():
        raise CutoverError("The explicitly named legacy schedule was exported absent.")
    if not schedule_path.is_file() or schedule_path.is_symlink():
        raise CutoverError("The legacy schedule has no verified exported definition.")
    payload = json.loads(schedule_path.read_text(encoding="utf-8"))
    if payload.get("Name") != schedule_name:
        raise CutoverError("Exported schedule name does not match the explicit target.")
    gmail_evidence = " ".join(
        [
            schedule_name,
            str(payload.get("Description") or ""),
            str((payload.get("Target") or {}).get("Arn") or ""),
            str((payload.get("Target") or {}).get("Input") or ""),
        ]
    ).casefold()
    if "gmail" not in gmail_evidence:
        raise CutoverError("Exported schedule is not identifiable as a Gmail pipeline.")
    if payload.get("State") not in {"ENABLED", "DISABLED"}:
        raise CutoverError("Exported schedule has an invalid state.")
    for field in ("ScheduleExpression", "FlexibleTimeWindow", "Target"):
        if field not in payload:
            raise CutoverError(f"Exported schedule is missing {field}.")
    return payload


def load_exported_event_rule(
    rollback: Path,
    rule_name: str,
) -> dict[str, Any]:
    rule_path = rollback / "event-rules" / f"{rule_name}.json"
    targets_path = rollback / "event-rules" / f"{rule_name}.targets.json"
    tags_path = rollback / "event-rules" / f"{rule_name}.tags.json"
    absent_path = rollback / "event-rules" / f"{rule_name}.absent.json"
    if absent_path.exists():
        raise CutoverError(
            "The explicitly named legacy EventBridge rule was exported absent."
        )
    for path, description in (
        (rule_path, "definition"),
        (targets_path, "targets"),
        (tags_path, "tags"),
    ):
        if not path.is_file() or path.is_symlink():
            raise CutoverError(
                f"The legacy EventBridge rule has no verified exported {description}."
            )

    rule = json.loads(rule_path.read_text(encoding="utf-8"))
    targets_payload = json.loads(targets_path.read_text(encoding="utf-8"))
    tags_payload = json.loads(tags_path.read_text(encoding="utf-8"))
    if rule.get("Name") != rule_name:
        raise CutoverError(
            "Exported EventBridge rule name does not match the explicit target."
        )
    expected_arn = (
        f"arn:aws:events:{EXPECTED_REGION}:{EXPECTED_ACCOUNT}:rule/{rule_name}"
    )
    if rule.get("Arn") != expected_arn:
        raise CutoverError("Exported EventBridge rule has an unexpected ARN.")
    if rule.get("CreatedBy") != EXPECTED_ACCOUNT:
        raise CutoverError("Exported EventBridge rule has an unexpected owner.")
    if rule.get("EventBusName") != "default":
        raise CutoverError(
            "Legacy Gmail cutover supports only the default EventBridge bus."
        )
    if rule.get("State") not in {"ENABLED", "DISABLED"}:
        raise CutoverError("Exported EventBridge rule has an invalid state.")
    if not rule.get("ScheduleExpression") or rule.get("ManagedBy"):
        raise CutoverError(
            "Exported EventBridge rule is not an unmanaged scheduled rule."
        )

    targets = targets_payload.get("Targets")
    if not isinstance(targets, list) or len(targets) != 1:
        raise CutoverError(
            "Legacy Gmail EventBridge rule must have exactly one exported target."
        )
    target = targets[0]
    target_arn = str(target.get("Arn") or "")
    expected_lambda_prefix = (
        f"arn:aws:lambda:{EXPECTED_REGION}:{EXPECTED_ACCOUNT}:function:"
    )
    if not target_arn.startswith(expected_lambda_prefix):
        raise CutoverError(
            "Legacy Gmail EventBridge rule target is not an expected Lambda."
        )
    if not isinstance(tags_payload.get("Tags"), list):
        raise CutoverError("Exported EventBridge rule tags are malformed.")

    gmail_evidence = " ".join(
        [
            rule_name,
            str(rule.get("Description") or ""),
            target_arn,
            str(target.get("Input") or ""),
        ]
    ).casefold()
    if "gmail" not in gmail_evidence:
        raise CutoverError(
            "Exported EventBridge rule is not identifiable as a Gmail pipeline."
        )
    return {
        "Rule": rule,
        "Targets": targets_payload,
        "Tags": tags_payload,
    }


def load_exported_trigger(
    rollback: Path,
    trigger_name: str,
) -> tuple[str, dict[str, Any]]:
    if not NAME_PATTERN.fullmatch(trigger_name):
        raise CutoverError("Schedule name contains unsupported characters.")
    if trigger_name == CANONICAL_GMAIL_SCHEDULE:
        raise CutoverError("The canonical Gmail schedule is not a legacy target.")

    scheduler_present = (
        rollback / "schedules" / f"{trigger_name}.json"
    ).is_file()
    event_rule_present = (
        rollback / "event-rules" / f"{trigger_name}.json"
    ).is_file()
    if scheduler_present and event_rule_present:
        raise CutoverError(
            "Rollback export contains ambiguous legacy Gmail timer types."
        )
    if scheduler_present:
        return "scheduler", load_exported_schedule(rollback, trigger_name)
    if event_rule_present:
        return "event-rule", load_exported_event_rule(rollback, trigger_name)

    scheduler_absent = (
        rollback / "schedules" / f"{trigger_name}.absent.json"
    ).exists()
    event_rule_absent = (
        rollback / "event-rules" / f"{trigger_name}.absent.json"
    ).exists()
    if scheduler_absent or event_rule_absent:
        raise CutoverError("The explicitly named legacy Gmail timer was exported absent.")
    raise CutoverError(
        "The legacy Gmail timer has no verified exported definition."
    )


def stable_definition(payload: dict[str, Any]) -> dict[str, Any]:
    return {
        key: value
        for key, value in payload.items()
        if key not in {"State", "LastModificationDate"}
    }


def get_live_schedule(profile: str, schedule_name: str) -> dict[str, Any]:
    response = run_aws(
        [
            "scheduler",
            "get-schedule",
            "--name",
            schedule_name,
            "--output",
            "json",
        ],
        profile=profile,
        region=EXPECTED_REGION,
    )
    return json.loads(response.stdout)


def disable_schedule(
    profile: str,
    schedule_name: str,
    exported: dict[str, Any],
) -> bool:
    live = get_live_schedule(profile, schedule_name)
    if live.get("Name") != schedule_name:
        raise CutoverError("AWS returned an unexpected schedule definition.")
    if stable_definition(live) != stable_definition(exported):
        raise CutoverError(
            "Live legacy schedule drifted from the verified rollback export."
        )
    if live.get("State") == "DISABLED":
        return False
    if live.get("State") != "ENABLED":
        raise CutoverError("Live legacy schedule has an unsupported state.")

    update_payload = {
        key: live[key]
        for key in UPDATE_FIELDS
        if key in live
    }
    update_payload["State"] = "DISABLED"
    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            prefix="market-dashboard-disable-legacy-gmail.",
            suffix=".json",
            delete=False,
        ) as handle:
            temporary_path = Path(handle.name)
            os.chmod(temporary_path, 0o600)
            json.dump(update_payload, handle, separators=(",", ":"), sort_keys=True)
            handle.write("\n")
        run_aws(
            [
                "scheduler",
                "update-schedule",
                "--cli-input-json",
                f"file://{temporary_path}",
                "--output",
                "json",
            ],
            profile=profile,
            region=EXPECTED_REGION,
        )
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)

    verified = get_live_schedule(profile, schedule_name)
    if verified.get("State") != "DISABLED":
        raise CutoverError("Legacy Gmail schedule did not verify disabled.")
    if stable_definition(verified) != stable_definition(live):
        raise CutoverError(
            "Legacy Gmail schedule definition changed while disabling it."
        )
    return True


def get_live_event_rule(
    profile: str,
    rule_name: str,
    rule_arn: str,
) -> dict[str, Any]:
    rule_response = run_aws(
        [
            "events",
            "describe-rule",
            "--name",
            rule_name,
            "--event-bus-name",
            "default",
            "--output",
            "json",
        ],
        profile=profile,
        region=EXPECTED_REGION,
    )
    targets_response = run_aws(
        [
            "events",
            "list-targets-by-rule",
            "--rule",
            rule_name,
            "--event-bus-name",
            "default",
            "--output",
            "json",
        ],
        profile=profile,
        region=EXPECTED_REGION,
    )
    tags_response = run_aws(
        [
            "events",
            "list-tags-for-resource",
            "--resource-arn",
            rule_arn,
            "--output",
            "json",
        ],
        profile=profile,
        region=EXPECTED_REGION,
    )
    return {
        "Rule": json.loads(rule_response.stdout),
        "Targets": json.loads(targets_response.stdout),
        "Tags": json.loads(tags_response.stdout),
    }


def stable_event_rule(payload: dict[str, Any]) -> dict[str, Any]:
    rule = dict(payload["Rule"])
    rule.pop("State", None)
    return {
        "Rule": rule,
        "Targets": payload["Targets"],
        "Tags": payload["Tags"],
    }


def disable_event_rule(
    profile: str,
    rule_name: str,
    exported: dict[str, Any],
) -> bool:
    rule_arn = str(exported["Rule"]["Arn"])
    live = get_live_event_rule(profile, rule_name, rule_arn)
    if live["Rule"].get("Name") != rule_name:
        raise CutoverError("AWS returned an unexpected EventBridge rule.")
    if stable_event_rule(live) != stable_event_rule(exported):
        raise CutoverError(
            "Live legacy EventBridge rule drifted from the rollback export."
        )
    if live["Rule"].get("State") == "DISABLED":
        return False
    if live["Rule"].get("State") != "ENABLED":
        raise CutoverError(
            "Live legacy EventBridge rule has an unsupported state."
        )

    run_aws(
        [
            "events",
            "disable-rule",
            "--name",
            rule_name,
            "--event-bus-name",
            "default",
        ],
        profile=profile,
        region=EXPECTED_REGION,
    )
    verified = get_live_event_rule(profile, rule_name, rule_arn)
    if verified["Rule"].get("State") != "DISABLED":
        raise CutoverError(
            "Legacy Gmail EventBridge rule did not verify disabled."
        )
    if stable_event_rule(verified) != stable_event_rule(live):
        raise CutoverError(
            "Legacy Gmail EventBridge rule changed while disabling it."
        )
    return True


def main() -> int:
    arguments = parse_arguments()
    try:
        rollback = validate_rollback_export(arguments.rollback_export)
        trigger_type, exported = load_exported_trigger(
            rollback,
            arguments.schedule_name,
        )
        validate_aws_access(arguments.admin_profile)
        if trigger_type == "scheduler":
            changed = disable_schedule(
                arguments.admin_profile,
                arguments.schedule_name,
                exported,
            )
        else:
            changed = disable_event_rule(
                arguments.admin_profile,
                arguments.schedule_name,
                exported,
            )
    except (CutoverError, json.JSONDecodeError, OSError) as error:
        print(f"Legacy Gmail cutover failed closed: {error}", file=sys.stderr)
        return 1

    disposition = "disabled and verified" if changed else "already disabled"
    print(f"Legacy Gmail schedule {arguments.schedule_name}: {disposition}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
