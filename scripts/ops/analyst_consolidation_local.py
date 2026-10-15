#!/usr/bin/env python3
"""Apply or restore the local half of The Analyst consolidation cutover."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping, Sequence


REPO_ROOT = Path(__file__).resolve().parents[2]
INFRA_SCRIPTS = REPO_ROOT / "infra" / "scripts"
sys.path.insert(0, str(INFRA_SCRIPTS))

from activate_reliability import (  # noqa: E402
    DEFAULT_ANALYST_SHADOW_ACCEPTANCE,
    verify_analyst_shadow_acceptance,
    verify_rollback_export,
)


ENV_PATH = REPO_ROOT / ".env"
APP_SUPPORT = Path.home() / "Library/Application Support/market-dashboard"
LOCAL_KEYS = frozenset(
    {
        "LEGACY_HERMES_MODE",
        "REACT_APP_ANALYST_SHADOW_MODE",
        "HERMES_BRIDGE_ENABLED",
        "HERMES_OPERATIONS_BRIDGE_ENABLED",
        "HERMES_PORTFOLIO_BRIDGE_ENABLED",
        "HERMES_BRIDGE_AWS_PROFILE",
        "READINESS_CONTROLLER_MODE",
        "READINESS_CONTROLLER_ENABLED_ACTIONS",
        "READINESS_CONTROLLER_HEARTBEAT_MAX_AGE_MS",
        "READINESS_CONTROLLER_POLL_INTERVAL_MS",
        "READINESS_CONTROLLER_STATE_FILE",
        "HERMES_RELIABILITY_CONTROLLER_MODE",
        "HERMES_RELIABILITY_ENABLED_ACTIONS",
        "HERMES_CONTROLLER_HEARTBEAT_MAX_AGE_MS",
        "HERMES_CONTROLLER_POLL_INTERVAL_MS",
        "HERMES_CONTROLLER_STATE_FILE",
    }
)


class LocalModeFailure(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def parse_env(contents: str) -> dict[str, str]:
    result: dict[str, str] = {}
    for raw_line in contents.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        result[key.strip()] = value.strip()
    return result


def render_env(contents: str, desired: Mapping[str, str | None]) -> str:
    if any(key not in LOCAL_KEYS for key in desired):
        raise LocalModeFailure(
            "LOCAL_SETTING_NOT_ALLOWLISTED",
            "A requested local setting is outside the consolidation allowlist.",
        )
    output = []
    replaced = set()
    for raw_line in contents.splitlines():
        stripped = raw_line.strip()
        if stripped and not stripped.startswith("#") and "=" in stripped:
            key = stripped.split("=", 1)[0].strip()
            if key in desired:
                if key not in replaced and desired[key] is not None:
                    output.append(f"{key}={desired[key]}")
                replaced.add(key)
                continue
        output.append(raw_line)
    for key in sorted(desired):
        value = desired[key]
        if key not in replaced and value is not None:
            output.append(f"{key}={value}")
    return "\n".join(output).rstrip() + "\n"


def cutover_settings(
    current: Mapping[str, str],
    exported_shadow: Mapping[str, str | None] | None = None,
) -> dict[str, str]:
    exported_shadow = exported_shadow or {}
    enabled_actions = ""
    for source, key in (
        (current, "READINESS_CONTROLLER_ENABLED_ACTIONS"),
        (current, "HERMES_RELIABILITY_ENABLED_ACTIONS"),
        (exported_shadow, "READINESS_CONTROLLER_ENABLED_ACTIONS"),
        (exported_shadow, "HERMES_RELIABILITY_ENABLED_ACTIONS"),
    ):
        if key in source and source[key] is not None:
            enabled_actions = str(source[key])
            break
    return {
        "LEGACY_HERMES_MODE": "read-only",
        "REACT_APP_ANALYST_SHADOW_MODE": "false",
        "HERMES_BRIDGE_ENABLED": "false",
        "HERMES_OPERATIONS_BRIDGE_ENABLED": "false",
        "HERMES_PORTFOLIO_BRIDGE_ENABLED": "false",
        "READINESS_CONTROLLER_MODE": "active",
        "READINESS_CONTROLLER_ENABLED_ACTIONS": enabled_actions,
    }


def rollback_settings(rollback_path: Path) -> dict[str, str | None]:
    settings_path = rollback_path / "local-settings" / "settings.json"
    try:
        payload = json.loads(settings_path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise LocalModeFailure(
            "ROLLBACK_LOCAL_SETTINGS_INVALID",
            "The verified rollback export has no readable local settings artifact.",
        ) from error
    if payload.get("classification") != "rollback-local-settings":
        raise LocalModeFailure(
            "ROLLBACK_LOCAL_SETTINGS_INVALID",
            "The rollback local settings classification is invalid.",
        )
    repository = payload.get("repositoryEnv") or {}
    launch_agent = (payload.get("launchAgent") or {}).get("environment") or {}
    desired: dict[str, str | None] = {key: None for key in LOCAL_KEYS}
    for source in (launch_agent, repository):
        for key, value in source.items():
            if key in LOCAL_KEYS:
                desired[key] = str(value)
    if str(desired.get("LEGACY_HERMES_MODE") or "shadow").lower() != "shadow":
        raise LocalModeFailure(
            "ROLLBACK_LOCAL_MODE_NOT_SHADOW",
            "The rollback export was not captured from legacy shadow mode.",
        )
    if str(desired.get("REACT_APP_ANALYST_SHADOW_MODE") or "true").lower() == "false":
        raise LocalModeFailure(
            "ROLLBACK_NAVIGATION_NOT_SHADOW",
            "The rollback export does not restore shadow navigation.",
        )
    return desired


def replace_env_atomically(path: Path, contents: str | None) -> None:
    if contents is None:
        if path.is_file() and not path.is_symlink():
            path.unlink()
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=".env.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(contents)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary_name, 0o600)
        os.replace(temporary_name, path)
    finally:
        if os.path.exists(temporary_name):
            os.unlink(temporary_name)


def write_env_atomically(path: Path, contents: str) -> Path | None:
    APP_SUPPORT.mkdir(parents=True, exist_ok=True)
    backup = APP_SUPPORT / (
        "pre-analyst-local-mode-"
        + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        + ".env"
    )
    if path.is_file():
        shutil.copy2(path, backup)
        os.chmod(backup, 0o600)
    else:
        backup = None
    replace_env_atomically(path, contents)
    return backup


def supervisor_environment(
    base: Mapping[str, str],
    desired: Mapping[str, str | None],
) -> dict[str, str]:
    environment = dict(base)
    for key in LOCAL_KEYS:
        environment.pop(key, None)
    for key, value in desired.items():
        if value is not None:
            environment[key] = value
    return environment


def settings_from_current(
    current: Mapping[str, str],
) -> dict[str, str | None]:
    return {
        key: current[key] if key in current else None
        for key in LOCAL_KEYS
    }


def install_launch_agent(desired: Mapping[str, str | None]) -> None:
    subprocess.run(
        ["npm", "run", "ops:launchagent:install"],
        cwd=REPO_ROOT,
        env=supervisor_environment(os.environ, desired),
        check=True,
    )


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=("cutover", "rollback"), required=True)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument(
        "--shadow-acceptance",
        default=str(DEFAULT_ANALYST_SHADOW_ACCEPTANCE),
    )
    parser.add_argument("--rollback-export", type=Path)
    args = parser.parse_args(argv)
    if args.rollback_export is None:
        parser.error("cutover and rollback require --rollback-export")
    return args


def main(argv: Sequence[str] | None = None) -> int:
    try:
        args = parse_args(argv)
        env_existed = ENV_PATH.is_file()
        current_contents = ENV_PATH.read_text(encoding="utf-8") if env_existed else ""
        current = parse_env(current_contents)
        evidence: dict[str, Any]
        verified = verify_rollback_export(args.rollback_export)
        rollback_path = Path(verified["path"])
        exported_shadow_settings = rollback_settings(rollback_path)
        if args.mode == "cutover":
            evidence = {
                "shadowAcceptance": verify_analyst_shadow_acceptance(
                    args.shadow_acceptance
                ),
                "rollbackExport": verified,
            }
            desired: dict[str, str | None] = cutover_settings(
                current,
                exported_shadow_settings,
            )
            prior_settings = exported_shadow_settings
        else:
            desired = exported_shadow_settings
            prior_settings = settings_from_current(current)
            evidence = verified
        changed_keys = sorted(
            key for key, value in desired.items() if current.get(key) != value
        )
        report: dict[str, Any] = {
            "passed": True,
            "mode": args.mode,
            "apply": args.apply,
            "changedKeys": changed_keys,
            "evidence": evidence,
        }
        if not args.apply:
            report["mutation"] = {
                "performed": False,
                "message": "Rerun with --apply to update local mode and reinstall the LaunchAgent.",
            }
            print(json.dumps(report, indent=2, sort_keys=True))
            return 0

        rendered = render_env(current_contents, desired)
        backup = write_env_atomically(ENV_PATH, rendered)
        try:
            install_launch_agent(desired)
        except subprocess.CalledProcessError as apply_error:
            replace_env_atomically(
                ENV_PATH,
                current_contents if env_existed else None,
            )
            try:
                install_launch_agent(prior_settings)
            except subprocess.CalledProcessError as compensation_error:
                raise LocalModeFailure(
                    "LOCAL_MODE_COMPENSATION_FAILED",
                    "The local mode update failed and the previous LaunchAgent "
                    "could not be restored; inspect launchd before proceeding.",
                ) from compensation_error
            raise LocalModeFailure(
                "LOCAL_MODE_APPLY_FAILED",
                "The local mode update failed; the prior environment and "
                "LaunchAgent settings were restored.",
            ) from apply_error
        report["mutation"] = {
            "performed": True,
            "envPath": str(ENV_PATH),
            "backupPath": str(backup) if backup else None,
            "launchAgentReinstalled": True,
        }
        print(json.dumps(report, indent=2, sort_keys=True))
        return 0
    except LocalModeFailure as error:
        failure = {"code": error.code, "message": error.message}
    except Exception as error:
        failure = {
            "code": getattr(error, "code", "LOCAL_CONSOLIDATION_FAILED"),
            "message": str(error)[:500],
        }
    print(json.dumps({"passed": False, "error": failure}, indent=2), file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
