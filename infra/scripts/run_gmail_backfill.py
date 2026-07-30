#!/usr/bin/env python3
"""Run and verify one bounded, oldest-first Gmail backfill through SSO."""

from __future__ import annotations

import argparse
import configparser
import json
import os
import sys
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any, Callable, Mapping, Sequence

import boto3
from boto3.dynamodb.types import TypeDeserializer


EXPECTED_ACCOUNT = "915328198276"
EXPECTED_REGION = "us-west-1"
EXPECTED_FUNCTION = "market-dashboard-gmail-ingestor-v2"
EXPECTED_HEARTBEAT_TABLE = "MarketDashboardServiceHeartbeats"
EXPECTED_HEARTBEAT_SERVICE = "gmail:timsmithaviation@gmail.com"
EXPECTED_GMAIL_SCHEDULE = "market-dashboard-gmail-v2-every-15m"
REQUIRED_SCHEDULER_HEARTBEATS = 4
SCHEDULER_CADENCE_MINUTES = 15
MAX_BACKFILL_INVOCATIONS = 200
MAX_STALLED_INVOCATIONS = 3
DEFAULT_ADMIN_PROFILE = "market-dashboard-admin"
SSO_ARN_PREFIX = (
    f"arn:aws:sts::{EXPECTED_ACCOUNT}:assumed-role/AWSReservedSSO_"
)
DESERIALIZER = TypeDeserializer()
AMBIENT_CREDENTIAL_KEYS = (
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
)


class BackfillFailure(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def require_sso_profile(
    profile_name: str,
    *,
    config_path: Path | None = None,
) -> None:
    if profile_name != DEFAULT_ADMIN_PROFILE:
        raise BackfillFailure(
            "AWS_SSO_PROFILE_REQUIRED",
            f"Backfill requires the {DEFAULT_ADMIN_PROFILE} SSO profile.",
        )
    path = config_path or (Path.home() / ".aws" / "config")
    path = path.expanduser()
    parser = configparser.RawConfigParser()
    if not path.is_file() or not parser.read(path):
        raise BackfillFailure(
            "AWS_SSO_PROFILE_REQUIRED",
            f"AWS config file is missing or unreadable: {path}",
        )
    section_name = (
        "default" if profile_name == "default" else f"profile {profile_name}"
    )
    if not parser.has_section(section_name):
        raise BackfillFailure(
            "AWS_SSO_PROFILE_REQUIRED",
            f"AWS profile {profile_name} is not configured.",
        )
    profile = parser[section_name]
    if profile.get("sso_account_id", "").strip() != EXPECTED_ACCOUNT:
        raise BackfillFailure(
            "AWS_ACCOUNT_MISMATCH",
            f"AWS profile {profile_name} must target account {EXPECTED_ACCOUNT}.",
        )
    if profile.get("region", "").strip() != EXPECTED_REGION:
        raise BackfillFailure(
            "AWS_REGION_MISMATCH",
            f"AWS profile {profile_name} must use region {EXPECTED_REGION}.",
        )
    if not profile.get("sso_role_name", "").strip():
        raise BackfillFailure(
            "AWS_SSO_PROFILE_REQUIRED",
            f"AWS profile {profile_name} does not configure an SSO role.",
        )
    session_name = profile.get("sso_session", "").strip()
    legacy_complete = bool(
        profile.get("sso_start_url", "").strip()
        and profile.get("sso_region", "").strip()
    )
    session_complete = False
    if session_name and parser.has_section(f"sso-session {session_name}"):
        session = parser[f"sso-session {session_name}"]
        session_complete = bool(
            session.get("sso_region", "").strip()
            and (
                session.get("sso_start_url", "").strip()
                or session.get("sso_issuer_url", "").strip()
            )
        )
    if not legacy_complete and not session_complete:
        raise BackfillFailure(
            "AWS_SSO_PROFILE_REQUIRED",
            f"AWS profile {profile_name} is not a complete IAM Identity Center profile.",
        )


def validate_identity(identity: Mapping[str, Any]) -> None:
    if str(identity.get("Account") or "") != EXPECTED_ACCOUNT:
        raise BackfillFailure(
            "AWS_ACCOUNT_MISMATCH",
            f"Refusing account {identity.get('Account') or 'unknown'}; expected {EXPECTED_ACCOUNT}.",
        )
    arn = str(identity.get("Arn") or "")
    if not arn.startswith(SSO_ARN_PREFIX) or "/" not in arn[len(SSO_ARN_PREFIX) :]:
        raise BackfillFailure(
            "AWS_SSO_IDENTITY_REQUIRED",
            "The administrator profile did not resolve to an AWS IAM Identity Center assumed role.",
        )


def parse_timestamp(value: Any) -> datetime | None:
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def integer_value(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if (
        isinstance(value, Decimal)
        and value.is_finite()
        and value == value.to_integral_value()
    ):
        return int(value)
    return None


def as_plain_item(item: Mapping[str, Any]) -> dict[str, Any]:
    return {
        str(key): DESERIALIZER.deserialize(value)
        for key, value in item.items()
    }


def verified_scheduler_heartbeat_window(
    rows: Sequence[Mapping[str, Any]],
    *,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Require the exact four-poll Gmail Scheduler provenance/cadence gate."""

    selected = list(rows[:REQUIRED_SCHEDULER_HEARTBEATS])
    failures: list[dict[str, str]] = []
    if len(selected) != REQUIRED_SCHEDULER_HEARTBEATS:
        failures.append(
            {
                "code": "HEARTBEAT_COUNT_INSUFFICIENT",
                "message": (
                    f"Expected {REQUIRED_SCHEDULER_HEARTBEATS} scheduled "
                    f"heartbeats, found {len(selected)}."
                ),
            }
        )

    for row in selected:
        observed = str(row.get("observedAt") or "")
        if row.get("status") != "success":
            failures.append(
                {
                    "code": "HEARTBEAT_STATUS_UNHEALTHY",
                    "message": f"{observed}: scheduled Gmail status was not success.",
                }
            )
        if (
            row.get("serviceId") != EXPECTED_HEARTBEAT_SERVICE
            or row.get("source") != "aws-lambda"
            or row.get("triggerSource") != "aws-scheduler"
            or row.get("scheduleId") != EXPECTED_GMAIL_SCHEDULE
            or row.get("scheduled") is not True
        ):
            failures.append(
                {
                    "code": "HEARTBEAT_PROVENANCE_INVALID",
                    "message": (
                        f"{observed}: heartbeat was not emitted by the exact "
                        "Gmail Scheduler job."
                    ),
                }
            )
        counts = row.get("counts")
        if not isinstance(counts, Mapping):
            counts = {}
        if (
            integer_value(counts.get("errors")) != 0
            or integer_value(counts.get("dropped")) != 0
        ):
            failures.append(
                {
                    "code": "GMAIL_HEARTBEAT_DATA_ERROR",
                    "message": (
                        f"{observed}: scheduled Gmail heartbeat reported "
                        "errors or dropped messages."
                    ),
                }
            )

    ordered = sorted(
        selected,
        key=lambda row: parse_timestamp(row.get("observedAt"))
        or datetime.min.replace(tzinfo=timezone.utc),
    )
    minimum_gap = SCHEDULER_CADENCE_MINUTES * 0.5
    maximum_gap = SCHEDULER_CADENCE_MINUTES * 1.5
    for earlier, later in zip(ordered, ordered[1:]):
        earlier_at = parse_timestamp(earlier.get("observedAt"))
        later_at = parse_timestamp(later.get("observedAt"))
        if earlier_at is None or later_at is None:
            failures.append(
                {
                    "code": "HEARTBEAT_TIMESTAMP_INVALID",
                    "message": "A scheduled Gmail heartbeat timestamp is invalid.",
                }
            )
            continue
        gap = (later_at - earlier_at).total_seconds() / 60
        if gap < minimum_gap or gap > maximum_gap:
            failures.append(
                {
                    "code": "HEARTBEAT_CADENCE_INVALID",
                    "message": (
                        f"Observed {gap:.1f}m gap; expected {minimum_gap:.1f}-"
                        f"{maximum_gap:.1f}m."
                    ),
                }
            )

    latest_at = selected[0].get("observedAt") if selected else None
    latest = parse_timestamp(latest_at)
    current = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    age = (
        (current - latest).total_seconds() / 60
        if latest is not None
        else None
    )
    if age is None or age < -1 or age > maximum_gap:
        failures.append(
            {
                "code": "HEARTBEAT_STALE",
                "message": (
                    "Latest scheduled Gmail heartbeat timestamp is invalid."
                    if age is None
                    else (
                        f"Latest scheduled Gmail heartbeat is {age:.1f}m old; "
                        f"limit is {maximum_gap:.1f}m."
                    )
                ),
            }
        )

    if failures:
        first = failures[0]
        raise BackfillFailure(
            "GMAIL_SCHEDULER_HEARTBEAT_GATE_FAILED",
            (
                "Backfill is blocked until four consecutive successful "
                "15-minute Scheduler heartbeats pass: "
                f"{first['code']}."
            ),
        )
    return {
        "passed": True,
        "serviceId": EXPECTED_HEARTBEAT_SERVICE,
        "scheduleId": EXPECTED_GMAIL_SCHEDULE,
        "required": REQUIRED_SCHEDULER_HEARTBEATS,
        "observed": len(selected),
        "latestAt": latest_at,
        "cadenceMinutes": SCHEDULER_CADENCE_MINUTES,
    }


def verified_backfill_result(response: Mapping[str, Any]) -> dict[str, Any]:
    if int(response.get("StatusCode") or 0) != 200 or response.get("FunctionError"):
        raise BackfillFailure(
            "GMAIL_BACKFILL_INVOCATION_FAILED",
            "The Gmail backfill Lambda invocation did not complete successfully.",
        )
    payload_stream = response.get("Payload")
    raw_payload = payload_stream.read() if hasattr(payload_stream, "read") else payload_stream
    if isinstance(raw_payload, bytes):
        raw_payload = raw_payload.decode("utf-8")
    try:
        envelope = json.loads(str(raw_payload or ""))
        body = envelope.get("body")
        body = json.loads(body) if isinstance(body, str) else body
    except (TypeError, ValueError) as error:
        raise BackfillFailure(
            "GMAIL_BACKFILL_RESPONSE_INVALID",
            "The Gmail backfill returned an invalid response envelope.",
        ) from error
    if (
        int(envelope.get("statusCode") or 0) != 200
        or not isinstance(body, Mapping)
        or str(body.get("pollMode") or "").lower() != "query"
    ):
        raise BackfillFailure(
            "GMAIL_BACKFILL_MATERIALIZATION_FAILED",
            "The Gmail backfill reported message or materialization errors.",
        )

    status = str(body.get("status") or "").upper()
    if status == "IN_PROGRESS":
        remaining_count = int(body.get("remainingCount") or 0)
        if (
            remaining_count <= 0
            or int(body.get("quarantinedCount") or 0) != 0
        ):
            raise BackfillFailure(
                "GMAIL_BACKFILL_MATERIALIZATION_FAILED",
                "The Gmail backfill returned an invalid in-progress checkpoint.",
            )
        return {
            "passed": False,
            "functionName": EXPECTED_FUNCTION,
            "status": "IN_PROGRESS",
            "pollMode": body.get("pollMode"),
            "messageCount": int(body.get("messageCount") or 0),
            "discoveredCount": int(body.get("discoveredCount") or 0),
            "remainingCount": remaining_count,
            "storedCount": int(body.get("storedCount") or 0),
            "skippedCount": int(body.get("skippedCount") or 0),
            "errorCount": int(body.get("errorCount") or 0),
        }

    canonical = body.get("canonicalVerification")
    products = canonical.get("products") if isinstance(canonical, Mapping) else None
    required_products_verified = (
        isinstance(products, Mapping)
        and all(
            int((products.get(product) or {}).get("eventCount") or 0) > 0
            and int((products.get(product) or {}).get("unverifiedEventCount") or 0) == 0
            for product in ("real-time-alert", "etf-pro")
        )
    )
    if (
        status != "SUCCESS"
        or int(body.get("errorCount") or 0) != 0
        or int(body.get("remainingCount") or 0) != 0
        or int(body.get("quarantinedCount") or 0) != 0
        or not isinstance(canonical, Mapping)
        or canonical.get("verified") is not True
        or int(canonical.get("unverifiedEventCount") or 0) != 0
        or not required_products_verified
    ):
        raise BackfillFailure(
            "GMAIL_BACKFILL_MATERIALIZATION_FAILED",
            "The Gmail backfill reported message or materialization errors.",
        )
    return {
        "passed": True,
        "functionName": EXPECTED_FUNCTION,
        "status": "SUCCESS",
        "pollMode": body.get("pollMode"),
        "messageCount": int(body.get("messageCount") or 0),
        "storedCount": int(body.get("storedCount") or 0),
        "skippedCount": int(body.get("skippedCount") or 0),
        "errorCount": 0,
        "canonicalEventCount": int(canonical.get("eventCount") or 0),
        "unverifiedCanonicalEventCount": 0,
    }


def run(
    profile_name: str,
    *,
    session_factory: Callable[..., Any] = boto3.Session,
    config_path: Path | None = None,
) -> dict[str, Any]:
    require_sso_profile(profile_name, config_path=config_path)
    for key in AMBIENT_CREDENTIAL_KEYS:
        os.environ.pop(key, None)
    os.environ["AWS_EC2_METADATA_DISABLED"] = "true"
    session = session_factory(
        profile_name=profile_name,
        region_name=EXPECTED_REGION,
    )
    validate_identity(session.client("sts").get_caller_identity())
    heartbeat_response = session.client("dynamodb").query(
        TableName=EXPECTED_HEARTBEAT_TABLE,
        KeyConditionExpression="serviceId = :service_id",
        ExpressionAttributeValues={
            ":service_id": {"S": EXPECTED_HEARTBEAT_SERVICE}
        },
        ScanIndexForward=False,
        ConsistentRead=True,
        Limit=REQUIRED_SCHEDULER_HEARTBEATS,
    )
    heartbeat_gate = verified_scheduler_heartbeat_window(
        [
            as_plain_item(item)
            for item in heartbeat_response.get("Items") or []
        ]
    )
    lambda_client = session.client("lambda")
    invocation_payload = json.dumps(
        {
            "forceBackfill": True,
            "source": "activation-backfill",
        },
        separators=(",", ":"),
    ).encode("utf-8")
    total_stored = 0
    total_skipped = 0
    discovered_count = 0
    previous_remaining = None
    stalled_invocations = 0
    for invocation_count in range(1, MAX_BACKFILL_INVOCATIONS + 1):
        response = lambda_client.invoke(
            FunctionName=EXPECTED_FUNCTION,
            InvocationType="RequestResponse",
            Payload=invocation_payload,
        )
        result = verified_backfill_result(response)
        total_stored += int(result.get("storedCount") or 0)
        total_skipped += int(result.get("skippedCount") or 0)
        discovered_count = max(
            discovered_count,
            int(result.get("discoveredCount") or 0),
        )
        if result["passed"]:
            return {
                **result,
                "messageCount": (
                    discovered_count
                    if discovered_count
                    else int(result.get("messageCount") or 0)
                ),
                "storedCount": total_stored,
                "skippedCount": total_skipped,
                "invocationCount": invocation_count,
                "schedulerHeartbeatGate": heartbeat_gate,
            }

        remaining_count = int(result["remainingCount"])
        made_progress = (
            previous_remaining is None
            or remaining_count < previous_remaining
            or int(result.get("messageCount") or 0) > 0
        )
        stalled_invocations = 0 if made_progress else stalled_invocations + 1
        if stalled_invocations >= MAX_STALLED_INVOCATIONS:
            raise BackfillFailure(
                "GMAIL_BACKFILL_STALLED",
                "The durable Gmail backfill queue stopped making progress.",
            )
        previous_remaining = remaining_count

    raise BackfillFailure(
        "GMAIL_BACKFILL_INVOCATION_LIMIT",
        (
            "The durable Gmail backfill did not complete within "
            f"{MAX_BACKFILL_INVOCATIONS} bounded Lambda invocations."
        ),
    )


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Require four exact scheduled Gmail heartbeats, then resume and "
            "verify one durable forceBackfill using the short-lived "
            "market-dashboard administrator SSO profile."
        )
    )
    parser.add_argument(
        "--admin-profile",
        default=DEFAULT_ADMIN_PROFILE,
        help=f"IAM Identity Center profile (default: {DEFAULT_ADMIN_PROFILE}).",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        print(json.dumps(run(args.admin_profile), indent=2, sort_keys=True))
        return 0
    except BackfillFailure as error:
        print(
            json.dumps(
                {
                    "passed": False,
                    "error": {"code": error.code, "message": str(error)},
                },
                indent=2,
                sort_keys=True,
            ),
            file=sys.stderr,
        )
        return 2
    except Exception as error:
        print(
            json.dumps(
                {
                    "passed": False,
                    "error": {
                        "code": "GMAIL_BACKFILL_AWS_ERROR",
                        "message": str(error)[:500],
                    },
                },
                indent=2,
                sort_keys=True,
            ),
            file=sys.stderr,
        )
        return 2


if __name__ == "__main__":
    sys.exit(main())
