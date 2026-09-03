#!/usr/bin/env python3
"""Safely audit the canonical runtime-failure queue.

This utility is deliberately audit-only. It samples a bounded number of SQS
records with a zero-second visibility timeout, fingerprints canonicalized
message bodies and message attributes, and writes a mode-0600 report. It does
not implement replay, deletion, purge, redrive, or deduplication.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import math
import os
import sys
import tempfile
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, Mapping
from urllib.parse import urlparse

import boto3
from botocore.exceptions import BotoCoreError, ClientError


EXPECTED_ACCOUNT_ID = "915328198276"
EXPECTED_REGION = "us-west-1"
EXPECTED_PROFILE = "market-dashboard-admin"
# CloudFormation's canonical deployed resource is plural "failures". The
# recovery plan's singular "failure-queue" wording is not a resource override.
EXPECTED_QUEUE_NAME = "market-dashboard-runtime-failures-v2"
EXPECTED_QUEUE_ARN = (
    f"arn:aws:sqs:{EXPECTED_REGION}:{EXPECTED_ACCOUNT_ID}:{EXPECTED_QUEUE_NAME}"
)
DEFAULT_MAX_MESSAGES = 50
MAX_MESSAGES = 100
MAX_STAGNANT_RECEIVES = 3
FINGERPRINT_VERSION = "sha256-canonical-body-message-attributes-v1"
STATIC_CREDENTIAL_ENVIRONMENT_VARIABLES = (
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AWS_SECURITY_TOKEN",
    "AWS_ROLE_ARN",
    "AWS_ROLE_SESSION_NAME",
    "AWS_WEB_IDENTITY_TOKEN_FILE",
    "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
    "AWS_CONTAINER_CREDENTIALS_FULL_URI",
    "AWS_CONTAINER_AUTHORIZATION_TOKEN",
    "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
)
PROFILE_ENVIRONMENT_VARIABLES = (
    "AWS_PROFILE",
    "AWS_DEFAULT_PROFILE",
    "AWS_SHARED_CREDENTIALS_FILE",
    "AWS_CONFIG_FILE",
)


class AuditError(RuntimeError):
    """A fail-closed validation or audit error."""


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def isoformat_utc(value: datetime) -> str:
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def parse_args(argv: Iterable[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Audit the canonical runtime-failure SQS queue without replaying, "
            "deleting, purging, redriving, or changing message visibility."
        )
    )
    parser.add_argument(
        "--max-messages",
        type=int,
        default=DEFAULT_MAX_MESSAGES,
        help=f"Maximum distinct messages to sample (1-{MAX_MESSAGES}; default: 50).",
    )
    parser.add_argument(
        "--output",
        type=Path,
        help=(
            "New JSON report path. Defaults to a timestamped file beneath "
            "~/Library/Application Support/market-dashboard/audits/."
        ),
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Print a machine-readable, secret-free completion summary.",
    )
    args = parser.parse_args(argv)
    if not 1 <= args.max_messages <= MAX_MESSAGES:
        parser.error(f"--max-messages must be between 1 and {MAX_MESSAGES}")
    return args


def default_output_path(now: datetime) -> Path:
    timestamp = now.astimezone(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
    return (
        Path.home()
        / "Library"
        / "Application Support"
        / "market-dashboard"
        / "audits"
        / "runtime-failure-queue"
        / f"audit-{timestamp}.json"
    )


def reject_ambient_credentials(environment: Mapping[str, str] | None = None) -> None:
    source = environment if environment is not None else os.environ
    profile_overrides = sorted(
        name for name in PROFILE_ENVIRONMENT_VARIABLES[2:] if source.get(name)
    )
    configured_profiles = sorted(
        str(source.get(name) or "").strip()
        for name in PROFILE_ENVIRONMENT_VARIABLES[:2]
        if str(source.get(name) or "").strip()
    )
    if profile_overrides or any(value != EXPECTED_PROFILE for value in configured_profiles):
        raise AuditError(
            "Refusing an ambient AWS profile/configuration override; use the explicit "
            f"{EXPECTED_PROFILE} IAM Identity Center/SSO profile."
        )
    present = sorted(name for name in STATIC_CREDENTIAL_ENVIRONMENT_VARIABLES if source.get(name))
    if present:
        raise AuditError(
            "Refusing ambient AWS credentials; use the configured "
            f"{EXPECTED_PROFILE} IAM Identity Center/SSO profile."
        )


def _profile_configuration(session: Any) -> Mapping[str, Any]:
    botocore_session = getattr(session, "_session", None)
    full_config = getattr(botocore_session, "full_config", {}) or {}
    profiles = full_config.get("profiles", {}) or {}
    return profiles.get(EXPECTED_PROFILE, {}) or {}


def validate_sso_session(session: Any) -> None:
    configuration = _profile_configuration(session)
    if str(configuration.get("region") or "") != EXPECTED_REGION:
        raise AuditError(
            f"{EXPECTED_PROFILE} must be pinned to AWS region {EXPECTED_REGION}."
        )
    if str(configuration.get("sso_account_id") or "") != EXPECTED_ACCOUNT_ID:
        raise AuditError(
            f"{EXPECTED_PROFILE} must be pinned to AWS account {EXPECTED_ACCOUNT_ID}."
        )
    if not configuration.get("sso_role_name"):
        raise AuditError(f"{EXPECTED_PROFILE} is missing its SSO role name.")
    if not (configuration.get("sso_session") or configuration.get("sso_start_url")):
        raise AuditError(f"{EXPECTED_PROFILE} is not an IAM Identity Center/SSO profile.")
    if getattr(session, "region_name", None) != EXPECTED_REGION:
        raise AuditError(
            f"The active boto session is not pinned to {EXPECTED_REGION}."
        )
    credentials = session.get_credentials()
    if credentials is None or getattr(credentials, "method", None) != "sso":
        raise AuditError(
            f"{EXPECTED_PROFILE} did not resolve IAM Identity Center/SSO credentials."
        )


def validate_sso_identity(identity: Mapping[str, Any]) -> None:
    account = str(identity.get("Account") or "")
    arn = str(identity.get("Arn") or "")
    expected_prefix = f"arn:aws:sts::{EXPECTED_ACCOUNT_ID}:assumed-role/AWSReservedSSO_"
    if account != EXPECTED_ACCOUNT_ID:
        raise AuditError(
            f"Authenticated AWS account {account or '<missing>'} is not "
            f"{EXPECTED_ACCOUNT_ID}."
        )
    if not arn.startswith(expected_prefix):
        raise AuditError(
            "Authenticated principal is not an AWS IAM Identity Center/SSO assumed role "
            f"in account {EXPECTED_ACCOUNT_ID}."
        )


def validate_queue_url(queue_url: str) -> None:
    parsed = urlparse(queue_url)
    expected_host = f"sqs.{EXPECTED_REGION}.amazonaws.com"
    expected_path = f"/{EXPECTED_ACCOUNT_ID}/{EXPECTED_QUEUE_NAME}"
    if (
        parsed.scheme != "https"
        or parsed.hostname != expected_host
        or parsed.username
        or parsed.password
        or parsed.port is not None
        or parsed.path != expected_path
        or parsed.params
        or parsed.query
        or parsed.fragment
    ):
        raise AuditError(
            "SQS returned a queue URL outside the pinned account, region, or resource."
        )


def validate_queue_arn(queue_arn: str) -> None:
    if queue_arn != EXPECTED_QUEUE_ARN:
        raise AuditError(
            "SQS returned a queue ARN outside the pinned account, region, or resource."
        )


def _json_safe_attribute_value(value: Any) -> Any:
    if isinstance(value, bytes):
        return {"base64": base64.b64encode(value).decode("ascii")}
    if isinstance(value, bytearray):
        return {"base64": base64.b64encode(bytes(value)).decode("ascii")}
    if isinstance(value, list):
        return [_json_safe_attribute_value(item) for item in value]
    if isinstance(value, Mapping):
        return {
            str(key): _json_safe_attribute_value(item)
            for key, item in sorted(value.items(), key=lambda pair: str(pair[0]))
        }
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    return str(value)


def canonical_body(raw_body: str) -> Dict[str, Any]:
    try:
        parsed = json.loads(raw_body)
    except (TypeError, json.JSONDecodeError):
        return {"encoding": "utf-8-text", "value": raw_body}
    return {"encoding": "canonical-json", "value": parsed}


def record_fingerprint(message: Mapping[str, Any]) -> str:
    material = {
        "body": canonical_body(str(message.get("Body") or "")),
        "messageAttributes": _json_safe_attribute_value(
            message.get("MessageAttributes") or {}
        ),
    }
    encoded = json.dumps(
        material,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def stable_record_ref(message_id: str) -> str:
    material = f"{EXPECTED_QUEUE_ARN}\n{message_id}".encode("utf-8")
    return hashlib.sha256(material).hexdigest()


def queue_depth(attributes: Mapping[str, Any]) -> Dict[str, int]:
    def count(name: str) -> int:
        try:
            return max(0, int(attributes.get(name, 0)))
        except (TypeError, ValueError):
            raise AuditError(f"SQS returned an invalid {name} queue attribute.") from None

    visible = count("ApproximateNumberOfMessages")
    in_flight = count("ApproximateNumberOfMessagesNotVisible")
    delayed = count("ApproximateNumberOfMessagesDelayed")
    return {
        "visible": visible,
        "inFlight": in_flight,
        "delayed": delayed,
        "totalApproximate": visible + in_flight + delayed,
    }


def sample_messages(
    sqs: Any,
    queue_url: str,
    *,
    max_messages: int,
) -> Dict[str, Any]:
    if not 1 <= max_messages <= MAX_MESSAGES:
        raise AuditError(f"max_messages must be between 1 and {MAX_MESSAGES}.")
    max_receive_calls = min(40, max(4, math.ceil(max_messages / 10) * 4))
    seen_message_ids: set[str] = set()
    groups: Dict[str, set[str]] = defaultdict(set)
    receive_calls = 0
    observed_deliveries = 0
    stagnant_receives = 0

    while (
        len(seen_message_ids) < max_messages
        and receive_calls < max_receive_calls
        and stagnant_receives < MAX_STAGNANT_RECEIVES
    ):
        requested = min(10, max_messages - len(seen_message_ids))
        response = sqs.receive_message(
            QueueUrl=queue_url,
            MaxNumberOfMessages=requested,
            VisibilityTimeout=0,
            WaitTimeSeconds=0,
            MessageAttributeNames=["All"],
        )
        receive_calls += 1
        messages = response.get("Messages") or []
        had_messages = bool(messages)
        observed_deliveries += len(messages)
        newly_sampled = 0
        for message in messages:
            # Receipt handles can authorize deletion. Discard them immediately
            # and never include them in the returned sample or report.
            message.pop("ReceiptHandle", None)
            message_id = str(message.get("MessageId") or "")
            if not message_id or message_id in seen_message_ids:
                continue
            fingerprint = record_fingerprint(message)
            groups[fingerprint].add(stable_record_ref(message_id))
            seen_message_ids.add(message_id)
            newly_sampled += 1
            if len(seen_message_ids) >= max_messages:
                break
        messages.clear()
        if newly_sampled:
            stagnant_receives = 0
        else:
            stagnant_receives += 1
        if not had_messages:
            break

    group_rows = [
        {
            "fingerprint": f"sha256:{fingerprint}",
            "recordCount": len(record_refs),
            "recordRefs": [f"sha256:{value}" for value in sorted(record_refs)],
            "duplicate": len(record_refs) > 1,
        }
        for fingerprint, record_refs in groups.items()
    ]
    group_rows.sort(key=lambda row: (-row["recordCount"], row["fingerprint"]))
    duplicate_groups = [row for row in group_rows if row["duplicate"]]
    return {
        "requestedMaximum": max_messages,
        "receiveCallLimit": max_receive_calls,
        "receiveCalls": receive_calls,
        "observedDeliveries": observed_deliveries,
        "sampledDistinctRecords": len(seen_message_ids),
        "sampledUniqueGroups": group_rows,
        "sampledDuplicateGroups": duplicate_groups,
        "sampledDuplicateRecords": sum(
            row["recordCount"] - 1 for row in duplicate_groups
        ),
        "stoppedAfterRepeatedDeliveries": stagnant_receives
        >= MAX_STAGNANT_RECEIVES,
    }


def build_report(
    *,
    generated_at: datetime,
    depth: Mapping[str, int],
    sample: Mapping[str, Any],
) -> Dict[str, Any]:
    return {
        "schemaVersion": 1,
        "kind": "market-dashboard-runtime-failure-queue-audit",
        "mode": "audit-only",
        "generatedAt": isoformat_utc(generated_at),
        "scope": {
            "accountId": EXPECTED_ACCOUNT_ID,
            "region": EXPECTED_REGION,
            "profile": EXPECTED_PROFILE,
            "queueName": EXPECTED_QUEUE_NAME,
            "queueArn": EXPECTED_QUEUE_ARN,
        },
        "identityValidation": {
            "accountMatched": True,
            "regionMatched": True,
            "ssoProfileMatched": True,
            "ssoAssumedRoleMatched": True,
        },
        "safety": {
            "queueOperations": [
                "GetQueueUrl",
                "GetQueueAttributes",
                "ReceiveMessage",
            ],
            "receiveVisibilityTimeoutSeconds": 0,
            "receiptHandlesPersisted": False,
            "rawBodiesPersisted": False,
            "rawMessageAttributesPersisted": False,
            "mutatingActionsImplemented": [],
            "prohibitedActions": [
                "ChangeMessageVisibility",
                "DeleteMessage",
                "DeleteMessageBatch",
                "PurgeQueue",
                "StartMessageMoveTask",
                "SendMessage",
            ],
        },
        "queueDepth": dict(depth),
        "sample": dict(sample),
        "futurePostVerificationDeduplication": {
            "ready": False,
            "purpose": "review-input-only",
            "candidateGroups": list(sample.get("sampledDuplicateGroups") or []),
            "requiredGates": [
                "corrected Gmail poller deployed from a tested release commit",
                "four genuine aws-scheduler success or in_progress heartbeats verified",
                "failure records independently classified and retention approved",
                "a separate deletion design explicitly reviewed and approved",
            ],
            "note": (
                "This manifest cannot replay, purge, redrive, or delete records. "
                "Receipt handles are intentionally absent and expire independently."
            ),
        },
        "limitations": [
            "SQS queue depth values are approximate.",
            (
                "This is a bounded sample, not a complete queue export; unobserved "
                "records and duplicate groups may remain."
            ),
            (
                "ReceiveMessage uses the minimum zero-second visibility timeout, "
                "but SQS may still increment ApproximateReceiveCount."
            ),
            (
                "Repeated delivery of the same SQS MessageId is counted once; "
                "distinct MessageIds with identical canonical body and message "
                "attributes are grouped as duplicates."
            ),
            (
                "Fingerprinting is exact after JSON canonicalization and does not "
                "infer semantic equivalence across changed timestamps or identifiers."
            ),
            (
                "The report contains only hashes and aggregate metadata; raw bodies, "
                "raw message attributes, receipt handles, and caller identity are omitted."
            ),
        ],
    }


def _atomic_publish(path: Path, payload: bytes) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    if path.exists():
        raise AuditError(f"Refusing to overwrite existing audit artifact: {path}")
    descriptor, raw_temporary_path = tempfile.mkstemp(
        dir=path.parent,
        prefix=f".{path.name}.",
        suffix=".tmp",
    )
    temporary_path = Path(raw_temporary_path)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "wb") as output:
            descriptor = -1
            output.write(payload)
            output.flush()
            os.fsync(output.fileno())
        try:
            os.link(temporary_path, path)
        except FileExistsError:
            raise AuditError(
                f"Refusing to overwrite existing audit artifact: {path}"
            ) from None
        os.chmod(path, 0o600)
        directory_descriptor = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory_descriptor)
        finally:
            os.close(directory_descriptor)
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        temporary_path.unlink(missing_ok=True)


def write_report(report: Mapping[str, Any], output_path: Path) -> Dict[str, str]:
    path = output_path.expanduser().resolve(strict=False)
    if path.suffix.lower() != ".json":
        raise AuditError("Audit report output must use a .json suffix.")
    encoded = (
        json.dumps(report, indent=2, sort_keys=True, ensure_ascii=False) + "\n"
    ).encode("utf-8")
    digest = hashlib.sha256(encoded).hexdigest()
    checksum_path = Path(f"{path}.sha256")
    if checksum_path.exists():
        raise AuditError(
            f"Refusing to overwrite existing audit checksum: {checksum_path}"
        )
    _atomic_publish(path, encoded)
    try:
        _atomic_publish(
            checksum_path,
            f"{digest}  {path.name}\n".encode("ascii"),
        )
    except Exception:
        # Preserve the immutable report as evidence and surface the incomplete
        # export. Never remove an already-published audit artifact.
        raise
    return {
        "reportPath": str(path),
        "checksumPath": str(checksum_path),
        "sha256": digest,
    }


def run_audit(
    *,
    max_messages: int,
    output_path: Path | None = None,
    now: datetime | None = None,
    session_factory: Callable[..., Any] = boto3.Session,
    environment: Mapping[str, str] | None = None,
) -> Dict[str, Any]:
    reject_ambient_credentials(environment)
    generated_at = now or utc_now()
    session = session_factory(
        profile_name=EXPECTED_PROFILE,
        region_name=EXPECTED_REGION,
    )
    validate_sso_session(session)
    sts = session.client("sts", region_name=EXPECTED_REGION)
    validate_sso_identity(sts.get_caller_identity())

    sqs = session.client("sqs", region_name=EXPECTED_REGION)
    queue_url = str(
        sqs.get_queue_url(
            QueueName=EXPECTED_QUEUE_NAME,
            QueueOwnerAWSAccountId=EXPECTED_ACCOUNT_ID,
        ).get("QueueUrl")
        or ""
    )
    validate_queue_url(queue_url)
    attributes = (
        sqs.get_queue_attributes(
            QueueUrl=queue_url,
            AttributeNames=[
                "QueueArn",
                "ApproximateNumberOfMessages",
                "ApproximateNumberOfMessagesNotVisible",
                "ApproximateNumberOfMessagesDelayed",
            ],
        ).get("Attributes")
        or {}
    )
    validate_queue_arn(str(attributes.get("QueueArn") or ""))
    depth = queue_depth(attributes)
    sample = sample_messages(sqs, queue_url, max_messages=max_messages)
    report = build_report(
        generated_at=generated_at,
        depth=depth,
        sample=sample,
    )
    artifact = write_report(
        report,
        output_path or default_output_path(generated_at),
    )
    return {
        **artifact,
        "queueDepth": depth,
        "sampledDistinctRecords": sample["sampledDistinctRecords"],
        "sampledDuplicateGroups": len(sample["sampledDuplicateGroups"]),
        "sampledDuplicateRecords": sample["sampledDuplicateRecords"],
        "mode": "audit-only",
    }


def main(argv: Iterable[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        result = run_audit(
            max_messages=args.max_messages,
            output_path=args.output,
        )
    except AuditError as error:
        print(f"Audit refused: {error}", file=sys.stderr)
        return 2
    except ClientError as error:
        response = error.response or {}
        code = str((response.get("Error") or {}).get("Code") or "ClientError")
        operation = str(getattr(error, "operation_name", None) or "AWS operation")
        print(f"Audit failed: {operation} returned {code}.", file=sys.stderr)
        return 1
    except BotoCoreError as error:
        print(f"Audit failed before completion: {type(error).__name__}.", file=sys.stderr)
        return 1

    if args.json:
        print(json.dumps(result, sort_keys=True))
    else:
        print(
            "Audit-only report written: "
            f"{result['reportPath']} "
            f"(depth≈{result['queueDepth']['totalApproximate']}, "
            f"sampled={result['sampledDistinctRecords']}, "
            f"duplicate-groups={result['sampledDuplicateGroups']})."
        )
        print(f"SHA-256: {result['sha256']} ({result['checksumPath']})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
