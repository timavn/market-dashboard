#!/usr/bin/env python3
"""Render the Lambda-safe Hermes contract from ops/services.json.

The operations manifest is the human-edited source of truth.  The generated
JSON lives beside the Lambda so SAM includes it in the deployment artifact.
Use --check in CI/deployments to fail on uncommitted manifest drift.
"""

from __future__ import annotations

import argparse
import json
import os
import tempfile
from pathlib import Path
from typing import Any, Dict


REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_MANIFEST = REPO_ROOT / "ops" / "services.json"
DEFAULT_OUTPUT = REPO_ROOT / "infra" / "lambdas" / "hermes_worker" / "service_contract.json"
EXPECTED_SERVICE_IDS = {
    "hermes.quant-analyst",
    "hermes.quant-developer",
    "hermes.security",
}


def _required_string(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{label} must be a non-empty string")
    return value.strip()


def build_contract(manifest: Dict[str, Any]) -> Dict[str, Any]:
    aws = manifest.get("aws") or {}
    resources = aws.get("resources") or {}
    services = {
        service.get("id"): service
        for service in manifest.get("services") or []
        if service.get("id") in EXPECTED_SERVICE_IDS
    }
    missing = sorted(EXPECTED_SERVICE_IDS - set(services))
    if missing:
        raise ValueError(f"ops/services.json is missing Hermes services: {', '.join(missing)}")

    workers: Dict[str, Any] = {}
    for service_id in sorted(EXPECTED_SERVICE_IDS):
        service = services[service_id]
        job_type = service_id.removeprefix("hermes.")
        service_aws = service.get("aws") or {}
        cadence = service.get("cadenceMinutes")
        if not isinstance(cadence, int) or cadence <= 0:
            raise ValueError(f"{service_id}.cadenceMinutes must be a positive integer")
        workers[job_type] = {
            "serviceId": _required_string(
                service_aws.get("heartbeatServiceId"),
                f"{service_id}.aws.heartbeatServiceId",
            ),
            "scheduleId": _required_string(
                service_aws.get("scheduleId"),
                f"{service_id}.aws.scheduleId",
            ),
            "scheduleExpression": _required_string(
                service_aws.get("scheduleExpression"),
                f"{service_id}.aws.scheduleExpression",
            ),
            "scheduleTimeZone": _required_string(
                service_aws.get("scheduleTimeZone"),
                f"{service_id}.aws.scheduleTimeZone",
            ),
            "cadenceMinutes": cadence,
        }
        expected_function = _required_string(
            resources.get("hermesFunction"), "aws.resources.hermesFunction"
        )
        if service_aws.get("functionName") != expected_function:
            raise ValueError(
                f"{service_id}.aws.functionName must match aws.resources.hermesFunction"
            )
        schedule_window = service.get("scheduleWindow") or {}
        if schedule_window.get("timeZone") != service_aws.get("scheduleTimeZone"):
            raise ValueError(
                f"{service_id}.scheduleWindow.timeZone must match aws.scheduleTimeZone"
            )

    capability_ids = sorted(
        _required_string(item.get("id"), "capabilities[].id")
        for item in manifest.get("capabilities") or []
    )
    if len(capability_ids) != len(set(capability_ids)):
        raise ValueError("capability IDs must be unique")

    return {
        "version": 1,
        "manifestVersion": manifest.get("version"),
        "awsRegion": _required_string(aws.get("region"), "aws.region"),
        "functionName": _required_string(
            resources.get("hermesFunction"), "aws.resources.hermesFunction"
        ),
        "inputSnapshotTable": _required_string(
            resources.get("hermesInputSnapshotTable"),
            "aws.resources.hermesInputSnapshotTable",
        ),
        "heartbeatTable": _required_string(
            resources.get("serviceHeartbeatTable"),
            "aws.resources.serviceHeartbeatTable",
        ),
        "capabilityIds": capability_ids,
        "workers": workers,
    }


def render_contract(manifest_path: Path = DEFAULT_MANIFEST) -> str:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    return json.dumps(build_contract(manifest), indent=2, sort_keys=True) + "\n"


def write_atomic(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", dir=path.parent, text=True
    )
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_name, path)
    finally:
        if os.path.exists(temporary_name):
            os.unlink(temporary_name)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()

    expected = render_contract(args.manifest)
    if args.check:
        actual = args.output.read_text(encoding="utf-8") if args.output.exists() else ""
        if actual != expected:
            parser.error(
                f"{args.output} is stale; run {Path(__file__).name} and commit the result"
            )
        return 0

    write_atomic(args.output, expected)
    print(args.output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
