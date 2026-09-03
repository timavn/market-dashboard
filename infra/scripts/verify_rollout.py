#!/usr/bin/env python3
"""Verify consecutive Gmail, CFTC, and Hermes heartbeat acceptance windows."""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Dict, List

import boto3
from boto3.dynamodb.conditions import Key
from aws_profile_contract import (
    LOCAL_PROFILE,
    AwsProfileContractError,
    verified_session,
)


def iso(value: Any) -> datetime:
    parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def query(table: Any, service_id: str, count: int) -> List[Dict[str, Any]]:
    response = table.query(
        KeyConditionExpression=Key("serviceId").eq(service_id),
        ScanIndexForward=False,
        Limit=count,
        ConsistentRead=True,
    )
    return response.get("Items") or []


def verify_service(
    table: Any,
    service_id: str,
    count: int,
    max_gap_minutes: int,
    min_gap_minutes: int,
    schedule_id: str | None = None,
) -> Dict[str, Any]:
    rows = query(table, service_id, count)
    failures = []
    if len(rows) < count:
        failures.append(f"expected {count} heartbeats, found {len(rows)}")
    for row in rows:
        if row.get("status") != "success":
            failures.append(f"{row.get('observedAt')}: status={row.get('status')}")
        if row.get("source") != "aws-lambda" or row.get("triggerSource") != "aws-scheduler":
            failures.append(
                f"{row.get('observedAt')}: runtime={row.get('source')}, trigger={row.get('triggerSource')}"
            )
        if schedule_id and row.get("scheduleId") != schedule_id:
            failures.append(
                f"{row.get('observedAt')}: scheduleId={row.get('scheduleId')}"
            )
        counts = row.get("counts") or {}
        if int(counts.get("errors") or 0) != 0 or int(counts.get("dropped") or 0) != 0:
            failures.append(
                f"{row.get('observedAt')}: errors={counts.get('errors', 0)}, "
                f"dropped={counts.get('dropped', 0)}"
            )
    ordered = sorted(rows, key=lambda row: str(row.get("observedAt") or ""))
    for earlier, later in zip(ordered, ordered[1:]):
        gap = (iso(later["observedAt"]) - iso(earlier["observedAt"])).total_seconds() / 60
        if gap > max_gap_minutes:
            failures.append(f"heartbeat gap {gap:.1f}m exceeds {max_gap_minutes}m")
        if gap < min_gap_minutes:
            failures.append(
                f"heartbeat gap {gap:.1f}m is below {min_gap_minutes}m; duplicate invocation suspected"
            )
    if rows:
        age = (datetime.now(timezone.utc) - iso(rows[0]["observedAt"])).total_seconds() / 60
        if age > max_gap_minutes:
            failures.append(f"latest heartbeat is {age:.1f}m old")
    return {
        "serviceId": service_id,
        "required": count,
        "observed": len(rows),
        "passed": not failures,
        "failures": failures,
        "latestAt": rows[0].get("observedAt") if rows else None,
    }


def json_default(value: Any) -> Any:
    if isinstance(value, Decimal):
        return float(value)
    raise TypeError(type(value).__name__)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--phase", choices=("gmail", "cftc", "hermes", "all"), default="all")
    parser.add_argument(
        "--worker",
        choices=("quant-analyst", "quant-developer", "security", "all"),
        default="all",
        help="For the Hermes phase, verify one worker during staged enablement.",
    )
    parser.add_argument("--region", default="us-west-1")
    parser.add_argument("--table", default="MarketDashboardServiceHeartbeats")
    parser.add_argument("--read-profile", default=LOCAL_PROFILE)
    args = parser.parse_args()

    if args.read_profile != LOCAL_PROFILE:
        parser.error(f"--read-profile must be {LOCAL_PROFILE}")
    try:
        session = verified_session(args.read_profile, purpose="api", region=args.region)
    except AwsProfileContractError as error:
        parser.error(f"{error.error_code}: {error.detail}")
    table = session.resource("dynamodb", region_name=args.region).Table(args.table)
    checks = []
    if args.phase in {"gmail", "all"}:
        checks.append(verify_service(table, "gmail:timsmithaviation@gmail.com", 4, 20, 10))
    if args.phase in {"cftc", "all"}:
        checks.append(verify_service(
            table,
            "cftc:official-positioning",
            2,
            4400,
            1200,
            "market-dashboard-cftc-weekday-v1",
        ))
    if args.phase in {"hermes", "all"}:
        worker_checks = {
            "quant-analyst": ("hermes:quant-analyst", 20, 10),
            "quant-developer": ("hermes:quant-developer", 20, 10),
            "security": ("hermes:security", 70, 50),
        }
        selected = worker_checks if args.worker == "all" else {args.worker: worker_checks[args.worker]}
        checks.extend(
            verify_service(table, service_id, 3, max_gap_minutes, min_gap_minutes)
            for service_id, max_gap_minutes, min_gap_minutes in selected.values()
        )
    report = {"passed": all(check["passed"] for check in checks), "checks": checks}
    print(json.dumps(report, indent=2, default=json_default))
    return 0 if report["passed"] else 2


if __name__ == "__main__":
    sys.exit(main())
