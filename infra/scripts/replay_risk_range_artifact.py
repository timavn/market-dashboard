#!/usr/bin/env python3
"""Verify and, with explicit approval, replay the newest immutable Risk Range HTML.

The artifact is selected from the server-owned Gmail ledger. Callers cannot
provide a date, Gmail message ID, S3 key, or object version. Dry-run is the
default. Apply mode is pinned to the market-dashboard-admin IAM Identity
Center profile, account, and region and uses the existing Gmail parser and
materializers rather than constructing Risk Range rows itself.
"""

from __future__ import annotations

import argparse
import configparser
import hashlib
import json
import os
import re
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any, Callable, Mapping, Sequence

import boto3
from aws_profile_contract import AwsProfileContractError, validate_environment


REPO_ROOT = Path(__file__).resolve().parents[2]
GMAIL_INGESTOR_DIR = REPO_ROOT / "infra" / "lambdas" / "gmail_ingestor"

EXPECTED_ACCOUNT = "915328198276"
EXPECTED_REGION = "us-west-1"
ADMIN_PROFILE = "market-dashboard-admin"
DEFAULT_READ_PROFILE = "market-dashboard-local"
SSO_ARN_PREFIX = f"arn:aws:sts::{EXPECTED_ACCOUNT}:assumed-role/AWSReservedSSO_"

GMAIL_LEDGER_TABLE = "HermesEmailIngestLedger"
RAW_ARTIFACT_BUCKET = "market-dashboard-csv-data"
RESEARCH_EVENT_LEDGER_TABLE = "ResearchEventLedgerV2"
RESEARCH_ENTITY_EVENTS_TABLE = "ResearchEntityEventsV1"
RESEARCH_PRODUCT_MANIFEST_TABLE = "ResearchProductManifestsV1"
DAILY_SNAPSHOT_TABLE = "HedgeyeDailySnapshot"
RISK_RANGE_DATA_TABLE = "HedgeyeRiskRanges"
RISK_RANGE_HISTORY_TABLE = "RiskRangeData"
RISK_RANGE_MANIFEST_TABLE = "RiskRangePublicationManifestsV2"

PRODUCT_KEY = "risk-ranges"
PRIMARY_MANIFEST_TYPE = "primary"
CONTENT_HASH_PATTERN = re.compile(r"^[a-f0-9]{64}$")
ALLOWED_LEDGER_STATUSES = frozenset({"STORED", "INDEXED", "ERROR", "DUPLICATE"})
APPLY_COMMAND = "python3 infra/scripts/replay_risk_range_artifact.py --apply --admin-profile market-dashboard-admin"


class ReplayFailure(RuntimeError):
    """Typed, fail-closed replay failure."""

    def __init__(
        self,
        code: str,
        message: str,
        *,
        approval_only: bool = False,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.approval_only = approval_only


@dataclass(frozen=True)
class CanonicalContract:
    parse_html_snapshot: Callable[..., Mapping[str, Any] | None]
    persist_research_event_ledger: Callable[..., int]
    persist_snapshot_intelligence: Callable[..., int]
    finalize_snapshot_intelligence: Callable[..., Mapping[str, Any]]
    materialize_email_snapshot: Callable[..., tuple[Mapping[str, Any], bool]]
    risk_range_parser_version: str
    research_product_parser_version: str
    resource_names: Mapping[str, str]


def canonical_contract() -> CanonicalContract:
    """Load the deployed Gmail parser/materializer contract from this checkout."""

    if str(GMAIL_INGESTOR_DIR) not in sys.path:
        sys.path.insert(0, str(GMAIL_INGESTOR_DIR))

    import hermes_gmail_ingestor as ingestor  # noqa: WPS433
    import parse_hedgeye_email_html as parser  # noqa: WPS433
    import research_intelligence as intelligence  # noqa: WPS433

    return CanonicalContract(
        parse_html_snapshot=parser.parse_html_snapshot,
        persist_research_event_ledger=ingestor.persist_research_event_ledger,
        persist_snapshot_intelligence=intelligence.persist_snapshot_intelligence,
        finalize_snapshot_intelligence=intelligence.finalize_snapshot_intelligence,
        materialize_email_snapshot=ingestor.materialize_email_snapshot,
        risk_range_parser_version=parser.RISK_RANGE_PARSER_VERSION,
        research_product_parser_version=intelligence.PARSER_VERSION,
        resource_names={
            "gmailLedger": ingestor.LEDGER_TABLE,
            "rawArtifactBucket": ingestor.S3_BUCKET,
            "researchEventLedger": ingestor.RESEARCH_EVENT_LEDGER_TABLE,
            "researchEntityEvents": intelligence.ENTITY_EVENTS_TABLE,
            "researchProductManifest": intelligence.PRODUCT_MANIFEST_TABLE,
            "riskRangeData": parser.RISK_RANGE_DATA_TABLE,
            "riskRangeHistory": parser.RISK_RANGE_HISTORY_TABLE,
            "riskRangeManifest": parser.RISK_RANGE_MANIFEST_TABLE,
        },
    )


def validate_canonical_resources(contract: CanonicalContract) -> None:
    expected = {
        "gmailLedger": GMAIL_LEDGER_TABLE,
        "rawArtifactBucket": RAW_ARTIFACT_BUCKET,
        "researchEventLedger": RESEARCH_EVENT_LEDGER_TABLE,
        "researchEntityEvents": RESEARCH_ENTITY_EVENTS_TABLE,
        "researchProductManifest": RESEARCH_PRODUCT_MANIFEST_TABLE,
        "riskRangeData": RISK_RANGE_DATA_TABLE,
        "riskRangeHistory": RISK_RANGE_HISTORY_TABLE,
        "riskRangeManifest": RISK_RANGE_MANIFEST_TABLE,
    }
    drift = {
        key: {"expected": expected[key], "actual": contract.resource_names.get(key)}
        for key in expected
        if contract.resource_names.get(key) != expected[key]
    }
    if drift:
        raise ReplayFailure(
            "RISK_RANGE_CANONICAL_RESOURCE_DRIFT",
            f"Canonical parser resources do not match the fixed replay contract: {drift}",
            approval_only=True,
        )


def parse_timestamp(value: Any) -> datetime | None:
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def scan_all(table: Any) -> list[Mapping[str, Any]]:
    items: list[Mapping[str, Any]] = []
    exclusive_start_key: Mapping[str, Any] | None = None
    while True:
        kwargs: dict[str, Any] = {"ConsistentRead": True}
        if exclusive_start_key:
            kwargs["ExclusiveStartKey"] = exclusive_start_key
        response = table.scan(**kwargs)
        items.extend(response.get("Items") or [])
        exclusive_start_key = response.get("LastEvaluatedKey")
        if not exclusive_start_key:
            return items


def _eligible_source(item: Mapping[str, Any]) -> bool:
    attachment_id = str(item.get("attachmentId") or "")
    content_sha256 = str(item.get("contentSha256") or "").lower()
    s3_key = str(item.get("s3Key") or "")
    return (
        str(item.get("reportType") or item.get("snapshotType") or "").lower()
        == PRODUCT_KEY
        and attachment_id.startswith("message-body-")
        and str(item.get("mimeType") or "").lower() == "text/html"
        and str(item.get("status") or "").upper() in ALLOWED_LEDGER_STATUSES
        and str(item.get("s3Bucket") or "") == RAW_ARTIFACT_BUCKET
        and s3_key.startswith("hedgeye-email/messages/")
        and bool(str(item.get("messageId") or ""))
        and CONTENT_HASH_PATTERN.fullmatch(content_sha256) is not None
        and parse_timestamp(item.get("receivedAt")) is not None
    )


def select_newest_source(ledger_table: Any) -> dict[str, Any]:
    """Server-select the newest immutable Risk Range body from the full ledger."""

    candidates = [item for item in scan_all(ledger_table) if _eligible_source(item)]
    if not candidates:
        raise ReplayFailure(
            "RISK_RANGE_IMMUTABLE_SOURCE_MISSING",
            "No replayable Risk Range HTML with immutable checksum evidence exists in the Gmail ledger.",
            approval_only=True,
        )
    selected = max(
        candidates,
        key=lambda item: (
            parse_timestamp(item["receivedAt"]),
            str(item.get("s3Key") or ""),
            str(item.get("messageId") or ""),
            str(item.get("attachmentId") or ""),
        ),
    )
    return dict(selected)


def _metadata(response: Mapping[str, Any]) -> dict[str, str]:
    return {
        str(key).lower(): str(value)
        for key, value in (response.get("Metadata") or {}).items()
    }


def _head_fingerprint(response: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "versionId": response.get("VersionId"),
        "etag": response.get("ETag"),
        "contentLength": response.get("ContentLength"),
        "lastModified": str(response.get("LastModified") or ""),
        "metadata": _metadata(response),
    }


def load_verified_artifact(s3: Any, source: Mapping[str, Any]) -> dict[str, Any]:
    """Pin a version when present and verify ledger, S3, and body checksums.

    Older Gmail objects may have been written before bucket versioning. Those
    remain eligible only when the object is stable across the read and its
    ledger hash, S3 metadata hash, and calculated body hash all agree.
    """

    bucket = str(source["s3Bucket"])
    key = str(source["s3Key"])
    head = s3.head_object(Bucket=bucket, Key=key)
    version_id = str(head.get("VersionId") or "")
    version_id = version_id if version_id and version_id != "null" else ""
    get_kwargs = {"Bucket": bucket, "Key": key}
    if version_id:
        get_kwargs["VersionId"] = version_id
    response = s3.get_object(**get_kwargs)
    if version_id and str(response.get("VersionId") or "") != version_id:
        raise ReplayFailure(
            "RISK_RANGE_SOURCE_VERSION_DRIFT",
            "S3 returned a different Risk Range object version than the pinned version.",
        )
    body_stream = response.get("Body")
    body = body_stream.read() if hasattr(body_stream, "read") else body_stream
    if not isinstance(body, bytes) or not body:
        raise ReplayFailure(
            "RISK_RANGE_SOURCE_EMPTY",
            "The selected immutable Risk Range object is empty or unreadable.",
        )
    if not version_id:
        head_after = s3.head_object(Bucket=bucket, Key=key)
        if _head_fingerprint(head_after) != _head_fingerprint(head):
            raise ReplayFailure(
                "RISK_RANGE_SOURCE_CHANGED_DURING_READ",
                "The unversioned Risk Range object changed while its checksum was being verified.",
                approval_only=True,
            )

    expected_hash = str(source["contentSha256"]).lower()
    actual_hash = hashlib.sha256(body).hexdigest()
    metadata = _metadata(response)
    evidence = {
        "ledgerSha256": expected_hash,
        "metadataSha256": metadata.get("content-sha256"),
        "calculatedSha256": actual_hash,
    }
    if len(set(evidence.values())) != 1:
        raise ReplayFailure(
            "RISK_RANGE_SOURCE_CHECKSUM_MISMATCH",
            f"Risk Range source checksum evidence does not agree: {evidence}",
        )
    if metadata.get("report-type") != PRODUCT_KEY:
        raise ReplayFailure(
            "RISK_RANGE_SOURCE_TYPE_MISMATCH",
            "S3 metadata does not identify the selected artifact as Risk Ranges.",
        )
    if metadata.get("gmail-message-id") != str(source["messageId"]):
        raise ReplayFailure(
            "RISK_RANGE_SOURCE_MESSAGE_MISMATCH",
            "S3 metadata does not match the server-selected Gmail message.",
        )
    if metadata.get("gmail-attachment-id") != str(source["attachmentId"]):
        raise ReplayFailure(
            "RISK_RANGE_SOURCE_ATTACHMENT_MISMATCH",
            "S3 metadata does not match the server-selected Gmail attachment.",
        )
    byte_size = source.get("byteSize")
    if byte_size is not None and int(byte_size) != len(body):
        raise ReplayFailure(
            "RISK_RANGE_SOURCE_SIZE_MISMATCH",
            "S3 bytes do not match the immutable Gmail-ledger byte count.",
        )
    return {
        "body": body,
        "versionId": version_id or None,
        "contentSha256": actual_hash,
        "checksumEvidence": evidence,
        "immutabilityEvidence": (
            "s3-version+ledger-metadata-body-sha256"
            if version_id
            else "stable-read+ledger-metadata-body-sha256"
        ),
    }


def parse_source_snapshot(
    contract: CanonicalContract,
    source: Mapping[str, Any],
    artifact: Mapping[str, Any],
) -> dict[str, Any]:
    received_at = parse_timestamp(source.get("receivedAt"))
    if received_at is None:
        raise ReplayFailure(
            "RISK_RANGE_SOURCE_TIMESTAMP_INVALID",
            "The selected Gmail ledger row has no valid received timestamp.",
        )
    snapshot = contract.parse_html_snapshot(
        report_type=PRODUCT_KEY,
        html_body=artifact["body"].decode("utf-8", errors="replace"),
        received_at=received_at,
        s3_key=str(source["s3Key"]),
        message_id=str(source["messageId"]),
        subject=str(source.get("subject") or ""),
    )
    if not isinstance(snapshot, Mapping) or snapshot.get("snapshotType") != PRODUCT_KEY:
        raise ReplayFailure(
            "RISK_RANGE_CANONICAL_PARSE_FAILED",
            "The canonical parser did not produce a Risk Range snapshot from the newest immutable source.",
        )
    data = snapshot.get("data")
    if not isinstance(data, Mapping) or not data:
        raise ReplayFailure(
            "RISK_RANGE_CANONICAL_PARSE_EMPTY",
            "The canonical parser produced no Risk Range rows.",
        )
    return dict(snapshot)


def primary_checksum(snapshot: Mapping[str, Any]) -> str:
    payload = []
    for ticker, row in sorted((snapshot.get("data") or {}).items()):
        if not isinstance(row, Mapping):
            raise ReplayFailure(
                "RISK_RANGE_CANONICAL_ROW_INVALID",
                f"Canonical Risk Range row {ticker!r} is not an object.",
            )
        lrr = Decimal(str(row.get("lrr")))
        hrr = Decimal(str(row.get("hrr")))
        trend = str(row.get("trend") or "").strip()
        if not lrr.is_finite() or not hrr.is_finite() or lrr >= hrr or not trend:
            raise ReplayFailure(
                "RISK_RANGE_CANONICAL_ROW_INVALID",
                f"Canonical Risk Range row {ticker!r} failed LRR/HRR/TREND validation.",
            )
        payload.append(
            {
                "ticker": str(ticker),
                "lrr": str(lrr),
                "hrr": str(hrr),
                "trend": trend,
            }
        )
    return hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()


def product_manifest_checksum(artifacts: Sequence[Mapping[str, Any]]) -> str:
    canonical = [
        {
            "artifactId": artifact.get("artifactId"),
            "contentSha256": artifact.get("contentSha256"),
            "stage": artifact.get("stage"),
            "eventCount": int(artifact.get("eventCount", 0)),
            "parserVersion": artifact.get("parserVersion"),
        }
        for artifact in sorted(
            artifacts,
            key=lambda item: str(item.get("artifactId") or ""),
        )
    ]
    return hashlib.sha256(
        json.dumps(
            canonical,
            sort_keys=True,
            separators=(",", ":"),
            default=str,
        ).encode("utf-8")
    ).hexdigest()


def read_primary_manifest(dynamodb: Any, publication_date: str) -> Mapping[str, Any] | None:
    return (
        dynamodb.Table(RISK_RANGE_MANIFEST_TABLE)
        .get_item(
            Key={
                "publicationDate": publication_date,
                "manifestType": PRIMARY_MANIFEST_TYPE,
            },
            ConsistentRead=True,
        )
        .get("Item")
    )


def read_product_manifest(dynamodb: Any, market_date: str) -> Mapping[str, Any] | None:
    response = dynamodb.Table(RESEARCH_PRODUCT_MANIFEST_TABLE).query(
        KeyConditionExpression="#marketDate = :marketDate",
        ExpressionAttributeNames={"#marketDate": "marketDate"},
        ExpressionAttributeValues={":marketDate": market_date},
        ConsistentRead=True,
    )
    return next(
        (
            item
            for item in response.get("Items") or []
            if item.get("productKey") == PRODUCT_KEY
        ),
        None,
    )


def expected_primary(
    snapshot: Mapping[str, Any],
    source: Mapping[str, Any],
    contract: CanonicalContract,
) -> dict[str, Any]:
    return {
        "publicationDate": str(snapshot["date"]),
        "manifestType": PRIMARY_MANIFEST_TYPE,
        "completionState": "complete",
        "count": len(snapshot["data"]),
        "checksum": primary_checksum(snapshot),
        "parserVersion": contract.risk_range_parser_version,
        "source": "hedgeye-risk-ranges-email",
        "sourceMessageId": str(source["messageId"]),
        "sourceArtifact": str(source["s3Key"]),
    }


def verify_primary_manifest(
    manifest: Mapping[str, Any] | None,
    expected: Mapping[str, Any],
) -> dict[str, Any]:
    if not manifest:
        return {"passed": False, "status": "missing", "mismatches": ["manifest"]}
    keys = (
        "publicationDate",
        "manifestType",
        "completionState",
        "count",
        "checksum",
        "parserVersion",
        "source",
        "sourceMessageId",
        "sourceArtifact",
    )
    mismatches = [
        key
        for key in keys
        if manifest.get(key) != expected.get(key)
    ]
    return {
        "passed": not mismatches,
        "status": "verified" if not mismatches else "mismatch",
        "mismatches": mismatches,
        "checksum": manifest.get("checksum"),
        "expectedChecksum": expected["checksum"],
    }


def verify_product_manifest(
    manifest: Mapping[str, Any] | None,
    *,
    market_date: str,
    source: Mapping[str, Any],
    content_sha256: str,
    contract: CanonicalContract,
) -> dict[str, Any]:
    if not manifest:
        return {"passed": False, "status": "missing", "mismatches": ["manifest"]}
    artifacts = manifest.get("artifacts")
    if not isinstance(artifacts, Sequence) or isinstance(artifacts, (str, bytes)):
        return {"passed": False, "status": "invalid", "mismatches": ["artifacts"]}
    expected_checksum = product_manifest_checksum(artifacts)
    source_artifact = next(
        (
            item
            for item in artifacts
            if isinstance(item, Mapping)
            and item.get("artifactId") == content_sha256
        ),
        None,
    )
    mismatches = []
    exact = {
        "marketDate": market_date,
        "productKey": PRODUCT_KEY,
        "state": "indexed",
        "failedCount": 0,
        "indexedCount": len(artifacts),
        "receivedCount": len(artifacts),
        "manifestChecksum": expected_checksum,
        "parserVersion": contract.research_product_parser_version,
    }
    for key, value in exact.items():
        if manifest.get(key) != value:
            mismatches.append(key)
    artifact_exact = {
        "stage": "indexed",
        "contentSha256": content_sha256,
        "sourceMessageId": str(source["messageId"]),
        "sourceKey": str(source["s3Key"]),
        "parserVersion": contract.research_product_parser_version,
    }
    if source_artifact is None:
        mismatches.append("selectedArtifact")
    else:
        mismatches.extend(
            f"selectedArtifact.{key}"
            for key, value in artifact_exact.items()
            if source_artifact.get(key) != value
        )
    return {
        "passed": not mismatches,
        "status": "verified" if not mismatches else "incomplete",
        "mismatches": mismatches,
        "manifestChecksum": manifest.get("manifestChecksum"),
        "expectedManifestChecksum": expected_checksum,
        "artifactCount": len(artifacts),
    }


def ensure_no_overwrite_conflict(
    primary: Mapping[str, Any] | None,
    expected: Mapping[str, Any],
    product_manifest: Mapping[str, Any] | None,
    content_sha256: str,
) -> None:
    if primary:
        same_book = (
            primary.get("publicationDate") == expected["publicationDate"]
            and primary.get("manifestType") == PRIMARY_MANIFEST_TYPE
            and primary.get("completionState") == "complete"
            and primary.get("checksum") == expected["checksum"]
            and int(primary.get("count") or -1) == expected["count"]
        )
        same_partial_source = (
            primary.get("sourceMessageId") == expected["sourceMessageId"]
            and primary.get("sourceArtifact") == expected["sourceArtifact"]
        )
        if not same_book and not same_partial_source:
            raise ReplayFailure(
                "RISK_RANGE_PRIMARY_MANIFEST_CONFLICT",
                "A different Risk Range primary manifest already exists for the selected publication date.",
                approval_only=True,
            )

    if product_manifest:
        foreign_incomplete = [
            item
            for item in product_manifest.get("artifacts") or []
            if isinstance(item, Mapping)
            and item.get("artifactId") != content_sha256
            and item.get("stage") != "indexed"
        ]
        if foreign_incomplete:
            raise ReplayFailure(
                "RISK_RANGE_PRODUCT_MATRIX_CONFLICT",
                "The current Risk Range product matrix contains another incomplete artifact that replaying the newest source cannot repair.",
                approval_only=True,
            )


def require_admin_sso_profile(
    profile_name: str,
    *,
    config_path: Path | None = None,
) -> str:
    if profile_name != ADMIN_PROFILE:
        raise ReplayFailure(
            "AWS_SSO_PROFILE_REQUIRED",
            f"Apply requires the exact {ADMIN_PROFILE} IAM Identity Center profile.",
        )
    path = (config_path or (Path.home() / ".aws" / "config")).expanduser()
    parser = configparser.RawConfigParser()
    if not path.is_file() or not parser.read(path):
        raise ReplayFailure(
            "AWS_SSO_PROFILE_REQUIRED",
            f"AWS config file is missing or unreadable: {path}",
        )
    section_name = f"profile {profile_name}"
    if not parser.has_section(section_name):
        raise ReplayFailure(
            "AWS_SSO_PROFILE_REQUIRED",
            f"AWS profile {profile_name} is not configured.",
        )
    profile = parser[section_name]
    if profile.get("sso_account_id", "").strip() != EXPECTED_ACCOUNT:
        raise ReplayFailure(
            "AWS_ACCOUNT_MISMATCH",
            f"AWS profile {profile_name} must target account {EXPECTED_ACCOUNT}.",
        )
    if profile.get("region", "").strip() != EXPECTED_REGION:
        raise ReplayFailure(
            "AWS_REGION_MISMATCH",
            f"AWS profile {profile_name} must use region {EXPECTED_REGION}.",
        )
    if not profile.get("sso_role_name", "").strip():
        raise ReplayFailure(
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
        raise ReplayFailure(
            "AWS_SSO_PROFILE_REQUIRED",
            f"AWS profile {profile_name} is not a complete IAM Identity Center profile.",
        )
    return profile.get("sso_role_name", "").strip()


def validate_account_identity(identity: Mapping[str, Any], region: str) -> None:
    if region != EXPECTED_REGION:
        raise ReplayFailure(
            "AWS_REGION_MISMATCH",
            f"Refusing region {region}; expected {EXPECTED_REGION}.",
        )
    if str(identity.get("Account") or "") != EXPECTED_ACCOUNT:
        raise ReplayFailure(
            "AWS_ACCOUNT_MISMATCH",
            f"Refusing account {identity.get('Account') or 'unknown'}; expected {EXPECTED_ACCOUNT}.",
        )


def validate_admin_identity(
    identity: Mapping[str, Any],
    region: str,
    *,
    expected_role_name: str,
) -> None:
    validate_account_identity(identity, region)
    arn = str(identity.get("Arn") or "")
    expected_prefix = f"{SSO_ARN_PREFIX}{expected_role_name}_"
    if not arn.startswith(expected_prefix) or "/" not in arn[len(expected_prefix) :]:
        raise ReplayFailure(
            "AWS_SSO_IDENTITY_REQUIRED",
            "Apply identity is not the IAM Identity Center role configured by the exact administrator profile.",
        )


def source_summary(
    source: Mapping[str, Any],
    artifact: Mapping[str, Any],
    snapshot: Mapping[str, Any],
) -> dict[str, Any]:
    return {
        "selection": "newest-server-owned-gmail-ledger-artifact",
        "bucket": source["s3Bucket"],
        "key": source["s3Key"],
        "versionId": artifact["versionId"],
        "messageId": source["messageId"],
        "attachmentId": source["attachmentId"],
        "receivedAt": source["receivedAt"],
        "publicationDate": snapshot["date"],
        "contentSha256": artifact["contentSha256"],
        "rowCount": len(snapshot["data"]),
        "immutabilityEvidence": artifact["immutabilityEvidence"],
    }


def replay(
    *,
    apply: bool = False,
    read_profile: str = DEFAULT_READ_PROFILE,
    admin_profile: str | None = None,
    session_factory: Callable[..., Any] = boto3.Session,
    config_path: Path | None = None,
    contract_loader: Callable[[], CanonicalContract] = canonical_contract,
) -> dict[str, Any]:
    """Select, verify, optionally replay, and post-verify one Risk Range source."""

    profile = admin_profile if apply else read_profile
    expected_role_name = None
    if apply:
        expected_role_name = require_admin_sso_profile(
            profile,
            config_path=config_path,
        )
        try:
            validate_environment(profile, environment=os.environ)
        except AwsProfileContractError as error:
            raise ReplayFailure(error.error_code, error.detail) from None
    else:
        try:
            validate_environment(profile, environment=os.environ)
        except AwsProfileContractError as error:
            raise ReplayFailure(error.error_code, error.detail) from None
    session = session_factory(profile_name=profile, region_name=EXPECTED_REGION)
    identity = session.client("sts").get_caller_identity()
    if apply:
        validate_admin_identity(
            identity,
            str(session.region_name or ""),
            expected_role_name=str(expected_role_name),
        )
    else:
        validate_account_identity(identity, str(session.region_name or ""))

    dynamodb = session.resource("dynamodb")
    s3 = session.client("s3")
    contract = contract_loader()
    validate_canonical_resources(contract)

    source = select_newest_source(dynamodb.Table(GMAIL_LEDGER_TABLE))
    artifact = load_verified_artifact(s3, source)
    snapshot = parse_source_snapshot(contract, source, artifact)
    expected = expected_primary(snapshot, source, contract)

    primary_before = read_primary_manifest(dynamodb, str(snapshot["date"]))
    product_before = read_product_manifest(dynamodb, str(snapshot["date"]))
    primary_before_verification = verify_primary_manifest(primary_before, expected)
    product_before_verification = verify_product_manifest(
        product_before,
        market_date=str(snapshot["date"]),
        source=source,
        content_sha256=artifact["contentSha256"],
        contract=contract,
    )
    already_applied = (
        primary_before_verification["passed"]
        and product_before_verification["passed"]
    )
    selected_source = source_summary(source, artifact, snapshot)

    if already_applied:
        return {
            "ok": True,
            "status": "already_applied",
            "code": "RISK_RANGE_REPLAY_IDEMPOTENT",
            "mode": "apply" if apply else "dry-run",
            "source": selected_source,
            "mutation": {"performed": False, "reason": "verified-idempotent"},
            "verification": {
                "sourceChecksum": artifact["checksumEvidence"],
                "primaryManifest": primary_before_verification,
                "researchProductMatrix": product_before_verification,
            },
        }

    ensure_no_overwrite_conflict(
        primary_before,
        expected,
        product_before,
        artifact["contentSha256"],
    )

    if not apply:
        return {
            "ok": True,
            "status": "ready_for_apply",
            "code": "RISK_RANGE_REPLAY_DRY_RUN_READY",
            "mode": "dry-run",
            "source": selected_source,
            "mutation": {"performed": False, "reason": "dry-run"},
            "verification": {
                "sourceChecksum": artifact["checksumEvidence"],
                "primaryManifest": primary_before_verification,
                "researchProductMatrix": product_before_verification,
            },
            "manualAction": {
                "approvalRequired": True,
                "kind": "command",
                "command": APPLY_COMMAND,
                "label": "Replay the server-selected immutable Risk Range source with administrator SSO.",
            },
        }

    ledger_event_count = contract.persist_research_event_ledger(
        snapshot,
        dynamodb,
        content_sha256=artifact["contentSha256"],
    )
    entity_event_count = contract.persist_snapshot_intelligence(
        snapshot,
        dynamodb,
        content_sha256=artifact["contentSha256"],
        finalize=False,
    )
    _, projection_changed = contract.materialize_email_snapshot(snapshot, dynamodb)
    contract.finalize_snapshot_intelligence(
        snapshot,
        dynamodb,
        content_sha256=artifact["contentSha256"],
        event_count=entity_event_count,
    )

    primary_after = read_primary_manifest(dynamodb, str(snapshot["date"]))
    product_after = read_product_manifest(dynamodb, str(snapshot["date"]))
    primary_after_verification = verify_primary_manifest(primary_after, expected)
    product_after_verification = verify_product_manifest(
        product_after,
        market_date=str(snapshot["date"]),
        source=source,
        content_sha256=artifact["contentSha256"],
        contract=contract,
    )
    if not primary_after_verification["passed"]:
        raise ReplayFailure(
            "RISK_RANGE_PRIMARY_MANIFEST_VERIFICATION_FAILED",
            f"Canonical replay did not produce the exact primary manifest: {primary_after_verification['mismatches']}",
        )
    if not product_after_verification["passed"]:
        raise ReplayFailure(
            "RISK_RANGE_PRODUCT_MATRIX_VERIFICATION_FAILED",
            f"Canonical replay did not complete the current research product matrix: {product_after_verification['mismatches']}",
        )
    return {
        "ok": True,
        "status": "verified",
        "code": "RISK_RANGE_REPLAY_VERIFIED",
        "mode": "apply",
        "source": selected_source,
        "mutation": {
            "performed": True,
            "canonicalPath": [
                "persist_research_event_ledger",
                "persist_snapshot_intelligence",
                "materialize_email_snapshot",
            ],
            "ledgerEventCount": ledger_event_count,
            "entityEventCount": entity_event_count,
            "projectionChanged": bool(projection_changed),
        },
        "verification": {
            "sourceChecksum": artifact["checksumEvidence"],
            "primaryManifest": primary_after_verification,
            "researchProductMatrix": product_after_verification,
        },
    }


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Dry-run verification and guarded replay of the newest immutable "
            "Risk Range Gmail artifact. Artifact identifiers are deliberately "
            "not accepted."
        )
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Use the canonical parser/materializers after all preflight checks pass.",
    )
    parser.add_argument(
        "--read-profile",
        default=DEFAULT_READ_PROFILE,
        help=f"Read-only dry-run profile (default: {DEFAULT_READ_PROFILE}).",
    )
    parser.add_argument(
        "--admin-profile",
        default=None,
        help=f"Apply-only IAM Identity Center profile (must be {ADMIN_PROFILE}).",
    )
    return parser.parse_args(argv)


def failure_result(error: ReplayFailure, *, apply: bool) -> dict[str, Any]:
    result = {
        "ok": False,
        "status": "approval_required" if error.approval_only else "blocked",
        "code": error.code,
        "mode": "apply" if apply else "dry-run",
        "error": {"code": error.code, "message": str(error)},
        "approvalOnly": error.approval_only,
    }
    if error.approval_only:
        result["manualAction"] = {
            "approvalRequired": True,
            "kind": "manual",
            "label": "Inspect the immutable source and conflicting authoritative evidence; do not overwrite it automatically.",
        }
    return result


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        result = replay(
            apply=args.apply,
            read_profile=args.read_profile,
            admin_profile=args.admin_profile,
        )
        print(json.dumps(result, indent=2, sort_keys=True, default=str))
        return 0
    except ReplayFailure as error:
        print(
            json.dumps(
                failure_result(error, apply=args.apply),
                indent=2,
                sort_keys=True,
            )
        )
        return 2
    except Exception as error:  # keep AWS/botocore details typed without traceback
        wrapped = ReplayFailure(
            "RISK_RANGE_REPLAY_RUNTIME_FAILED",
            str(error),
        )
        print(
            json.dumps(
                failure_result(wrapped, apply=args.apply),
                indent=2,
                sort_keys=True,
            )
        )
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
