#!/usr/bin/env python3
"""
Hermes Gmail ingestor for Hedgeye product emails.

Polls the Gmail API with OAuth refresh-token credentials, downloads matching
attachments, stores raw artifacts in S3, and records idempotency/status in
DynamoDB. PDF attachments are written below the dedicated `hedgeye-uploads/`
prefix so only the Hedgeye PDF processor Lambda receives those S3 events.

Required AWS resources:
  - Secrets Manager secret containing Gmail OAuth credentials
  - S3 bucket for raw attachments
  - DynamoDB ledger table keyed by messageId + attachmentId

Secret JSON:
{
  "client_id": "...apps.googleusercontent.com",
  "client_secret": "...",
  "refresh_token": "...",
  "user_id": "me"
}
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import mimetypes
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from email.utils import parsedate_to_datetime
from pathlib import PurePosixPath
from typing import Any, Callable, Dict, Iterable, List, Optional, Tuple

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError
from parse_hedgeye_email_html import parse_html_snapshot, save_snapshot_to_dynamodb
from research_intelligence import (
    PARSER_VERSION as SECURITY_INTELLIGENCE_PARSER_VERSION,
    finalize_snapshot_intelligence,
    persist_snapshot_failure,
    persist_snapshot_intelligence,
    product_definition,
    product_ids,
    reclassify_manifest_artifact,
    report_rules,
)


AWS_REGION = os.environ.get("AWS_REGION", os.environ.get("AWS_DEFAULT_REGION", "us-west-1"))
SECRET_NAME = os.environ.get("GMAIL_OAUTH_SECRET_NAME", "hermes/gmail/oauth")
LEDGER_TABLE = os.environ.get("HERMES_LEDGER_TABLE", "HermesEmailIngestLedger")
HEARTBEAT_TABLE = os.environ.get(
    "SERVICE_HEARTBEAT_TABLE",
    "MarketDashboardServiceHeartbeats",
)
RESEARCH_EVENT_LEDGER_TABLE = os.environ.get(
    "RESEARCH_EVENT_LEDGER_TABLE",
    "ResearchEventLedgerV2",
)
S3_BUCKET = os.environ.get("HERMES_S3_BUCKET", "market-dashboard-csv-data")
GMAIL_QUERY = os.environ.get(
    "HERMES_GMAIL_QUERY",
    "newer_than:30d hedgeye",
)
MAX_MESSAGES_PER_INVOCATION = min(
    25,
    max(1, int(os.environ.get("HERMES_MAX_MESSAGES", "25"))),
)
DISCOVERY_PAGE_SIZE = min(
    100,
    max(1, int(os.environ.get("HERMES_DISCOVERY_PAGE_SIZE", "100"))),
)
GMAIL_HTTP_TIMEOUT_SECONDS = 30
WORK_BUDGET_SECONDS = min(
    240,
    max(1, int(os.environ.get("HERMES_WORK_BUDGET_SECONDS", "240"))),
)
MIN_REMAINING_TIME_MS = max(
    60_000,
    int(os.environ.get("HERMES_MIN_REMAINING_TIME_MS", "60000")),
)
MESSAGE_QUEUE_MAX_ATTEMPTS = min(
    3,
    max(1, int(os.environ.get("HERMES_MESSAGE_QUEUE_MAX_ATTEMPTS", "3"))),
)
BACKLOG_STALLED_SECONDS = max(
    15 * 60,
    int(os.environ.get("HERMES_BACKLOG_STALLED_SECONDS", str(60 * 60))),
)
ATTACHMENT_TTL_DAYS = int(os.environ.get("HERMES_LEDGER_TTL_DAYS", "730"))
SECRET_CACHE_SECONDS = int(os.environ.get("HERMES_SECRET_CACHE_SECONDS", str(6 * 60 * 60)))
GMAIL_API_ROOT = "https://gmail.googleapis.com/gmail/v1"
TOKEN_URL = "https://oauth2.googleapis.com/token"
MESSAGE_LEDGER_ATTACHMENT_ID = "__MESSAGE__"
TEXTRACT_LEDGER_ATTACHMENT_ID = "__TEXTRACT_CONTENT__"
MATERIALIZED_SNAPSHOT_TYPES = {"real-time-alert", "etf-pro"}
RESEARCH_EVENT_SNAPSHOT_TYPES = set(product_ids())
MATERIALIZED_DATA_VERSION = "gmail-materialized-v10-quarantine-recovery"
MARKET_STRUCTURE_ASSET_PREFIX = "hedgeye-email/assets/market-structure/"
HTML_TEXTRACT_REPORT_TYPES = frozenset({
    "signal-strength",
    "momo-tracker",
    "crypto-quant",
    "bitcoin-trend-tracker",
})
RESEARCH_PARSER_VERSION = "research-event-ledger-v3-tracker-contract"
MATERIALIZATION_WRITE_RETRIES = 3
MATERIALIZATION_MAX_ATTEMPTS = 3
OPERATOR_REPLAY_SOURCE = "operator-quarantine-replay"
OPERATOR_REPLAY_MAX_MESSAGES = 8
IMMUTABLE_ARTIFACT_EVIDENCE_FIELDS = (
    "s3Bucket",
    "s3Key",
    "contentSha256",
    "byteSize",
    "receivedAt",
    "s3ArtifactCreated",
)
ATTACHMENT_CLAIM_STALE_SECONDS = int(
    os.environ.get("HERMES_ATTACHMENT_CLAIM_STALE_SECONDS", str(10 * 60))
)
TEXTRACT_CLAIM_STALE_SECONDS = 60 * 60
BUILD_VERSION = os.environ.get("BUILD_VERSION", "development")
HEARTBEAT_TTL_DAYS = int(os.environ.get("SERVICE_HEARTBEAT_TTL_DAYS", "90"))
GMAIL_ACCOUNT = str(
    os.environ.get("HERMES_GMAIL_ACCOUNT", "timsmithaviation@gmail.com")
).strip().casefold()
GMAIL_SERVICE_ID = f"gmail:{GMAIL_ACCOUNT}"
GMAIL_SCHEDULE_ID = os.environ.get(
    "HERMES_GMAIL_SCHEDULE_ID",
    "market-dashboard-gmail-v2-every-15m",
)
RUNTIME_STATE_MESSAGE_ID = f"runtime#gmail#{GMAIL_ACCOUNT.lower()}"
HISTORY_CURSOR_ATTACHMENT_ID = "history-cursor"
MESSAGE_QUEUE_ATTACHMENT_PREFIX = "message-queue#"
MESSAGE_QUEUE_ACTIVE_STATUSES = {"PENDING", "RETRYABLE", "IN_PROGRESS"}
MESSAGE_QUEUE_TERMINAL_STATUSES = {"COMPLETED", "QUARANTINED"}
MAX_RECORDED_QUARANTINES = 100
RISK_RANGE_BUILD_RECOVERY_ERROR_CODES = frozenset(
    {
        "RISK_RANGE_PUBLICATION_INVALID",
        "RISK_RANGE_DUPLICATE_TICKER_CONFLICT",
        "RISK_RANGE_TRANSACTION_LIMIT_EXCEEDED",
        "RISK_RANGE_TRANSACTION_WRITE_FAILED",
        "RISK_RANGE_PUBLICATION_VERIFICATION_FAILED",
        "RISK_RANGE_STALE_PUBLICATION_REJECTED",
        "RISK_RANGE_PUBLICATION_ORDER_UNVERIFIED",
    }
)
PDF_PROCESSOR_FUNCTION_NAME = os.environ.get(
    "PDF_PROCESSOR_FUNCTION_NAME",
    "market-dashboard-hedgeye-pdf-processor-v1",
)

AWS_CLIENT_CONFIG = Config(
    connect_timeout=3,
    read_timeout=15,
    retries={"max_attempts": 2, "mode": "standard"},
)


secretsmanager = boto3.client(
    "secretsmanager",
    region_name=AWS_REGION,
    config=AWS_CLIENT_CONFIG,
)
dynamodb = boto3.resource(
    "dynamodb",
    region_name=AWS_REGION,
    config=AWS_CLIENT_CONFIG,
)
s3 = boto3.client("s3", region_name=AWS_REGION, config=AWS_CLIENT_CONFIG)
textract = boto3.client("textract", region_name=AWS_REGION, config=AWS_CLIENT_CONFIG)
cloudwatch = boto3.client(
    "cloudwatch",
    region_name=AWS_REGION,
    config=AWS_CLIENT_CONFIG,
)
lambda_client = boto3.client(
    "lambda",
    region_name=AWS_REGION,
    config=AWS_CLIENT_CONFIG,
)


_oauth_secret_cache: Optional[Dict[str, Any]] = None


class RetryableResearchMaterializationError(RuntimeError):
    """A stored Gmail artifact whose research projection is not yet trustworthy."""

    error_code = "GMAIL_RESEARCH_MATERIALIZATION_ERROR"
    retryable = True


class GmailAccountProvenanceError(RuntimeError):
    """The OAuth token is not proven to belong to the configured mailbox."""

    error_code = "GMAIL_ACCOUNT_MISMATCH"


class GmailStateStoreError(RuntimeError):
    """The durable ingestion queue/cursor could not be read or checkpointed."""

    error_code = "GMAIL_STATE_STORE_ERROR"


class GmailInvocationBudgetYield(RuntimeError):
    """Stop safely before another unit of discovery work."""

    def __init__(self, error_code: str) -> None:
        super().__init__(error_code)
        self.error_code = error_code


class GmailOperatorReplayError(RuntimeError):
    """An operator replay event or active queue is outside the bounded contract."""

    error_code = "GMAIL_OPERATOR_REPLAY_INVALID"


class ImmutableArtifactDriftError(RuntimeError):
    """Archived S3 bytes no longer match the immutable ledger evidence."""

    error_code = "GMAIL_IMMUTABLE_ARTIFACT_DRIFT"


REPORT_RULES = report_rules()


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def ttl_epoch() -> int:
    return int(time.time() + ATTACHMENT_TTL_DAYS * 24 * 60 * 60)


def clear_oauth_secret_cache() -> None:
    """Forget the warm-runtime secret cache, primarily for rotation recovery/tests."""
    global _oauth_secret_cache
    _oauth_secret_cache = None


def load_oauth_secret(*, force_refresh: bool = False) -> Dict[str, str]:
    """Load and briefly cache the Gmail OAuth secret within a warm Lambda runtime."""
    global _oauth_secret_cache

    now = time.monotonic()
    if not force_refresh and _oauth_secret_cache:
        is_current_secret = _oauth_secret_cache.get("secretName") == SECRET_NAME
        is_unexpired = now < float(_oauth_secret_cache.get("expiresAt", 0))
        if is_current_secret and is_unexpired:
            return dict(_oauth_secret_cache["value"])

    resp = secretsmanager.get_secret_value(SecretId=SECRET_NAME)
    raw = resp.get("SecretString")
    if not raw and resp.get("SecretBinary"):
        raw = base64.b64decode(resp["SecretBinary"]).decode("utf-8")
    if not raw:
        raise RuntimeError(f"Secret {SECRET_NAME} has no SecretString or SecretBinary")

    secret = json.loads(raw)
    required = ("client_id", "client_secret", "refresh_token")
    missing = [key for key in required if not secret.get(key)]
    if missing:
        raise RuntimeError(f"Secret {SECRET_NAME} missing required keys: {', '.join(missing)}")
    secret["_secret_version"] = resp.get("VersionId") or hashlib.sha256(
        str(secret["refresh_token"]).encode("utf-8")
    ).hexdigest()[:16]
    _oauth_secret_cache = {
        "secretName": SECRET_NAME,
        "expiresAt": now + max(SECRET_CACHE_SECONDS, 60),
        "value": dict(secret),
    }
    return dict(secret)


def http_json(
    method: str,
    url: str,
    *,
    access_token: Optional[str] = None,
    params: Optional[Dict[str, Any]] = None,
    body: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    if params:
        url = f"{url}?{urllib.parse.urlencode(params, doseq=True)}"

    data = None
    headers = {"Accept": "application/json"}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    if access_token:
        headers["Authorization"] = f"Bearer {access_token}"

    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            text = resp.read().decode("utf-8")
            return json.loads(text) if text else {}
    except urllib.error.HTTPError as err:
        detail = err.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"{method} {url} failed with HTTP {err.code}: {detail}") from err


def refresh_access_token(secret: Dict[str, str]) -> str:
    form = urllib.parse.urlencode(
        {
            "client_id": secret["client_id"],
            "client_secret": secret["client_secret"],
            "refresh_token": secret["refresh_token"],
            "grant_type": "refresh_token",
        }
    ).encode("utf-8")
    req = urllib.request.Request(
        TOKEN_URL,
        data=form,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as err:
        detail = err.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Token refresh failed with HTTP {err.code}: {detail}") from err

    token = payload.get("access_token")
    if not token:
        raise RuntimeError("Token refresh response did not include access_token")
    return token


def gmail_path(user_id: str, suffix: str) -> str:
    return f"{GMAIL_API_ROOT}/users/{urllib.parse.quote(user_id, safe='')}/{suffix.lstrip('/')}"


class GmailDiscoveryPage(list):
    """One resumable Gmail discovery page and its opaque continuation token."""

    def __init__(
        self,
        message_ids: Iterable[str],
        *,
        next_page_token: Optional[str],
    ) -> None:
        super().__init__(message_ids)
        self.next_page_token = (
            str(next_page_token) if next_page_token is not None else None
        )


def list_message_ids(
    access_token: str,
    user_id: str,
    *,
    page_token: Optional[str] = None,
) -> GmailDiscoveryPage:
    """Read exactly one newest-first query page."""
    params = {"q": GMAIL_QUERY, "maxResults": DISCOVERY_PAGE_SIZE}
    if page_token:
        params["pageToken"] = page_token
    data = http_json(
        "GET",
        gmail_path(user_id, "messages"),
        access_token=access_token,
        params=params,
    )
    return GmailDiscoveryPage(
        (msg["id"] for msg in data.get("messages", []) if msg.get("id")),
        next_page_token=data.get("nextPageToken"),
    )


def _gmail_label_name_from_query(query: str) -> Optional[str]:
    """Return the configured Gmail label name when the query names one."""
    match = re.search(r"(?:^|\s)label:(?:\"([^\"]+)\"|'([^']+)'|([^\s]+))", query, re.IGNORECASE)
    if not match:
        return None
    return next((value for value in match.groups() if value), None)


def resolve_label_id(access_token: str, user_id: str) -> Optional[str]:
    label_name = _gmail_label_name_from_query(GMAIL_QUERY)
    if not label_name:
        return None
    payload = http_json("GET", gmail_path(user_id, "labels"), access_token=access_token)
    for label in payload.get("labels", []):
        if str(label.get("name", "")).casefold() == label_name.casefold():
            return label.get("id")
    return None


def get_profile_history_id(access_token: str, user_id: str) -> Optional[str]:
    payload = http_json("GET", gmail_path(user_id, "profile"), access_token=access_token)
    expected_account = str(GMAIL_ACCOUNT or "").strip().casefold()
    observed_account = str(payload.get("emailAddress") or "").strip().casefold()
    if not expected_account:
        raise GmailAccountProvenanceError(
            "The configured Gmail account is empty."
        )
    if not observed_account:
        raise GmailAccountProvenanceError(
            "The authenticated Gmail profile did not include a verifiable emailAddress."
        )
    if observed_account != expected_account:
        raise GmailAccountProvenanceError(
            "The authenticated Gmail profile does not match the configured account."
        )
    value = payload.get("historyId")
    return str(value) if value is not None else None


def list_history_message_ids(
    access_token: str,
    user_id: str,
    start_history_id: str,
    *,
    label_id: Optional[str],
    page_token: Optional[str] = None,
) -> GmailDiscoveryPage:
    """Read exactly one chronological history page."""
    message_ids: List[str] = []
    seen = set()
    params: Dict[str, Any] = {
        "startHistoryId": start_history_id,
        "historyTypes": "messageAdded",
        "maxResults": DISCOVERY_PAGE_SIZE,
    }
    if label_id:
        params["labelId"] = label_id
    if page_token:
        params["pageToken"] = page_token
    payload = http_json(
        "GET",
        gmail_path(user_id, "history"),
        access_token=access_token,
        params=params,
    )
    for history in payload.get("history", []):
        for added in history.get("messagesAdded", []):
            message_id = added.get("message", {}).get("id")
            if message_id and message_id not in seen:
                seen.add(message_id)
                message_ids.append(message_id)
    return GmailDiscoveryPage(
        message_ids,
        next_page_token=payload.get("nextPageToken"),
    )


def read_ingestion_state(table: Any) -> Dict[str, Any]:
    try:
        return table.get_item(
            Key={
                "messageId": RUNTIME_STATE_MESSAGE_ID,
                "attachmentId": HISTORY_CURSOR_ATTACHMENT_ID,
            },
            ConsistentRead=True,
        ).get("Item") or {}
    except Exception as err:
        raise GmailStateStoreError(
            f"Durable Gmail ingestion state read failed: {type(err).__name__}"
        ) from err


def write_ingestion_state(table: Any, **updates: Any) -> None:
    try:
        now = utc_now().isoformat()
        current = read_ingestion_state(table)
        item = {
            **current,
            "messageId": RUNTIME_STATE_MESSAGE_ID,
            "attachmentId": HISTORY_CURSOR_ATTACHMENT_ID,
            "status": updates.pop("status", current.get("status", "READY")),
            "accountEmail": GMAIL_ACCOUNT,
            "query": GMAIL_QUERY,
            "createdAt": current.get("createdAt") or now,
            "updatedAt": now,
            "ttl": ttl_epoch(),
            **updates,
        }
        table.put_item(Item=item)
    except GmailStateStoreError:
        raise
    except Exception as err:
        raise GmailStateStoreError(
            f"Durable Gmail ingestion state write failed: {type(err).__name__}"
        ) from err


def _queue_batch_id(
    _message_ids: Iterable[str],
    *,
    cursor_before: Optional[str],
    pending_history_id: Optional[str],
    poll_mode: str,
    force_backfill: bool,
) -> str:
    payload = {
        "account": GMAIL_ACCOUNT,
        "query": GMAIL_QUERY,
        "cursorBefore": cursor_before,
        "pendingHistoryId": pending_history_id,
        "pollMode": poll_mode,
        "forceBackfill": force_backfill,
    }
    return hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()[:24]


def persist_discovered_message_queue(
    table: Any,
    message_ids: List[str],
    *,
    cursor_before: Optional[str],
    pending_history_id: Optional[str],
    poll_mode: str,
    force_backfill: bool,
    start_sequence: int = 0,
    sequence_direction: int = 1,
    budget_check: Optional[Callable[[], Optional[str]]] = None,
) -> str:
    """Durably record a page before the mailbox page token can advance.

    Batch identity is independent of the discovered list, so a crash can
    re-fetch and idempotently persist the same page. Newest-first query pages
    use descending sequence values; later, older pages therefore sort first.
    """
    if sequence_direction not in {-1, 1}:
        raise ValueError("sequence_direction must be -1 or 1")
    ordered_ids = list(dict.fromkeys(
        str(value) for value in message_ids if str(value)
    ))
    batch_id = _queue_batch_id(
        (),
        cursor_before=cursor_before,
        pending_history_id=pending_history_id,
        poll_mode=poll_mode,
        force_backfill=force_backfill,
    )
    now = utc_now().isoformat()
    if budget_check:
        budget_reason = budget_check()
        if budget_reason:
            raise GmailInvocationBudgetYield(budget_reason)
    existing_by_message_id = {
        str(item.get("gmailMessageId") or ""): item
        for item in read_message_queue(table, batch_id)
        if item.get("gmailMessageId")
    }
    for index, gmail_message_id in enumerate(ordered_ids):
        if budget_check:
            budget_reason = budget_check()
            if budget_reason:
                raise GmailInvocationBudgetYield(budget_reason)
        sequence = start_sequence + sequence_direction * index
        if gmail_message_id in existing_by_message_id:
            # users.history can repeat an ID across records or pages.
            continue
        sequence_key = (
            f"p{sequence:018d}"
            if sequence >= 0
            else f"n{abs(sequence):018d}"
        )
        message_key = hashlib.sha256(
            gmail_message_id.encode("utf-8")
        ).hexdigest()[:16]
        item = {
            "messageId": RUNTIME_STATE_MESSAGE_ID,
            "attachmentId": (
                f"{MESSAGE_QUEUE_ATTACHMENT_PREFIX}{batch_id}#"
                f"{sequence_key}#{message_key}"
            ),
            "batchId": batch_id,
            "gmailMessageId": gmail_message_id,
            "sequence": sequence,
            "status": "PENDING",
            "attemptCount": 0,
            "createdAt": now,
            "updatedAt": now,
            "ttl": ttl_epoch(),
        }
        try:
            table.put_item(
                Item=item,
                ConditionExpression=(
                    "attribute_not_exists(#messageId) AND "
                    "attribute_not_exists(#attachmentId)"
                ),
                ExpressionAttributeNames={
                    "#messageId": "messageId",
                    "#attachmentId": "attachmentId",
                },
            )
        except ClientError as err:
            if err.response.get("Error", {}).get("Code") != "ConditionalCheckFailedException":
                raise GmailStateStoreError(
                    "Durable Gmail message queue write failed."
                ) from err
            existing = table.get_item(
                Key={
                    "messageId": RUNTIME_STATE_MESSAGE_ID,
                    "attachmentId": item["attachmentId"],
                },
                ConsistentRead=True,
            ).get("Item") or {}
            if (
                existing.get("batchId") != batch_id
                or existing.get("gmailMessageId") != gmail_message_id
                or int(existing.get("sequence", -1)) != sequence
            ):
                raise GmailStateStoreError(
                    "Durable Gmail message queue idempotency conflict."
                ) from err
        except Exception as err:
            raise GmailStateStoreError(
                f"Durable Gmail message queue write failed: {type(err).__name__}"
            ) from err
    return batch_id


def read_message_queue(table: Any, batch_id: str) -> List[Dict[str, Any]]:
    items: List[Dict[str, Any]] = []
    exclusive_start_key = None
    prefix = f"{MESSAGE_QUEUE_ATTACHMENT_PREFIX}{batch_id}#"
    try:
        while True:
            query: Dict[str, Any] = {
                "KeyConditionExpression": (
                    "#messageId = :messageId AND "
                    "begins_with(#attachmentId, :attachmentPrefix)"
                ),
                "ExpressionAttributeNames": {
                    "#messageId": "messageId",
                    "#attachmentId": "attachmentId",
                },
                "ExpressionAttributeValues": {
                    ":messageId": RUNTIME_STATE_MESSAGE_ID,
                    ":attachmentPrefix": prefix,
                },
                "ConsistentRead": True,
            }
            if exclusive_start_key:
                query["ExclusiveStartKey"] = exclusive_start_key
            response = table.query(**query)
            items.extend(
                item
                for item in response.get("Items") or []
                if item.get("batchId") == batch_id
                and str(item.get("attachmentId") or "").startswith(prefix)
            )
            exclusive_start_key = response.get("LastEvaluatedKey")
            if not exclusive_start_key:
                break
    except Exception as err:
        raise GmailStateStoreError(
            f"Durable Gmail message queue read failed: {type(err).__name__}"
        ) from err
    return sorted(
        items,
        key=lambda item: (
            int(item.get("sequence", 0)),
            str(item.get("attachmentId") or ""),
        ),
    )


def _queue_item_is_stale(item: Dict[str, Any], now: datetime) -> bool:
    try:
        updated_at = datetime.fromisoformat(
            str(item.get("updatedAt") or "").replace("Z", "+00:00")
        )
        if updated_at.tzinfo is None:
            updated_at = updated_at.replace(tzinfo=timezone.utc)
        updated_at = updated_at.astimezone(timezone.utc)
    except (TypeError, ValueError):
        return True
    return (now - updated_at).total_seconds() >= ATTACHMENT_CLAIM_STALE_SECONDS


def claim_queued_message(
    table: Any,
    item: Dict[str, Any],
) -> Optional[Dict[str, Any]]:
    """Atomically claim a pending/retryable message or reclaim a stale lease."""
    now = utc_now()
    status = str(item.get("status") or "")
    if status not in {"PENDING", "RETRYABLE"}:
        if status != "IN_PROGRESS" or not _queue_item_is_stale(item, now):
            return None
    claimed = {
        **item,
        "status": "IN_PROGRESS",
        "attemptCount": int(item.get("attemptCount") or 0) + 1,
        "updatedAt": now.isoformat(),
        "leaseExpiresAt": (
            now + timedelta(seconds=ATTACHMENT_CLAIM_STALE_SECONDS)
        ).isoformat(),
        "ttl": ttl_epoch(),
    }
    try:
        table.put_item(
            Item=claimed,
            ConditionExpression="#status = :expectedStatus AND #updatedAt = :expectedUpdatedAt",
            ExpressionAttributeNames={
                "#status": "status",
                "#updatedAt": "updatedAt",
            },
            ExpressionAttributeValues={
                ":expectedStatus": item.get("status"),
                ":expectedUpdatedAt": item.get("updatedAt"),
            },
        )
    except ClientError as err:
        if err.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
            return None
        raise GmailStateStoreError(
            "Durable Gmail message lease claim failed."
        ) from err
    except Exception as err:
        raise GmailStateStoreError(
            f"Durable Gmail message lease claim failed: {type(err).__name__}"
        ) from err
    return claimed


def checkpoint_queued_message(
    table: Any,
    claimed: Dict[str, Any],
    *,
    status: str,
    error_code: Optional[str] = None,
    error_detail: Optional[str] = None,
) -> Dict[str, Any]:
    if status not in MESSAGE_QUEUE_TERMINAL_STATUSES | {"RETRYABLE"}:
        raise ValueError(f"Unsupported Gmail queue checkpoint status: {status}")
    checkpoint = {
        **claimed,
        "status": status,
        "updatedAt": utc_now().isoformat(),
        "ttl": ttl_epoch(),
    }
    checkpoint.pop("leaseExpiresAt", None)
    if error_code:
        checkpoint["errorCode"] = error_code
    else:
        checkpoint.pop("errorCode", None)
    if error_detail:
        checkpoint["errorDetail"] = error_detail
    else:
        checkpoint.pop("errorDetail", None)
    try:
        table.put_item(
            Item=checkpoint,
            ConditionExpression="#status = :inProgress AND #updatedAt = :claimedAt",
            ExpressionAttributeNames={
                "#status": "status",
                "#updatedAt": "updatedAt",
            },
            ExpressionAttributeValues={
                ":inProgress": "IN_PROGRESS",
                ":claimedAt": claimed.get("updatedAt"),
            },
        )
    except ClientError as err:
        if err.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
            raise GmailStateStoreError(
                "Durable Gmail message checkpoint lost its lease."
            ) from err
        raise GmailStateStoreError(
            "Durable Gmail message checkpoint failed."
        ) from err
    except Exception as err:
        raise GmailStateStoreError(
            f"Durable Gmail message checkpoint failed: {type(err).__name__}"
        ) from err
    return checkpoint


def invocation_budget_reason(
    context: Any,
    *,
    monotonic_started_at: float,
    reserve_seconds: int = 0,
) -> Optional[str]:
    elapsed = time.monotonic() - monotonic_started_at
    if elapsed + max(0, reserve_seconds) >= WORK_BUDGET_SECONDS:
        return "GMAIL_WORK_BUDGET_EXHAUSTED"
    remaining = getattr(context, "get_remaining_time_in_millis", None)
    if callable(remaining):
        try:
            required_remaining_ms = (
                MIN_REMAINING_TIME_MS + max(0, reserve_seconds) * 1000
            )
            if int(remaining()) <= required_remaining_ms:
                return "GMAIL_INVOCATION_NEAR_TIMEOUT"
        except (TypeError, ValueError):
            pass
    return None


def gmail_call_budget_reason(
    context: Any,
    *,
    monotonic_started_at: float,
) -> Optional[str]:
    """Reserve a full HTTP timeout in addition to the shutdown margin."""
    return invocation_budget_reason(
        context,
        monotonic_started_at=monotonic_started_at,
        reserve_seconds=GMAIL_HTTP_TIMEOUT_SECONDS,
    )


def classify_runtime_error(error: Exception) -> str:
    typed_error_code = getattr(error, "error_code", None)
    if typed_error_code:
        return str(typed_error_code)
    message = str(error).lower()
    if (
        "invalid_grant" in message
        or "expired or revoked" in message
        or "invalid credentials" in message
        or "http 401" in message
    ):
        return "GMAIL_AUTH_REQUIRED"
    if "disabled_client" in message:
        return "GMAIL_OAUTH_CLIENT_DISABLED"
    if (
        "insufficient authentication scopes" in message
        or "insufficient permission" in message
        or "insufficientpermissions" in message
    ):
        return "GMAIL_SCOPE_INSUFFICIENT"
    if "accessdenied" in message or "not authorized" in message:
        return "AWS_ACCESS_DENIED"
    if "missing required keys" in message or "secret" in message and "missing" in message:
        return "GMAIL_SECRET_INVALID"
    if "history" in message and ("404" in message or "start history" in message):
        return "GMAIL_HISTORY_CURSOR_EXPIRED"
    return "GMAIL_INGEST_ERROR"


def safe_error_detail(error: Exception) -> str:
    """Return a bounded diagnostic that cannot contain OAuth credential values."""
    detail = str(error).replace("\n", " ")[:500]
    detail = re.sub(r'(?i)(client_secret|refresh_token|access_token)["\s:=]+[^,}\s]+', r"\1=[REDACTED]", detail)
    return detail


def write_service_heartbeat(
    *,
    started_at: str,
    status: str,
    trigger_source: str,
    schedule_id: Optional[str],
    error_code: Optional[str] = None,
    detail: Optional[str] = None,
    secret_version: Optional[str] = None,
    counts: Optional[Dict[str, int]] = None,
) -> bool:
    finished = utc_now()
    scheduled = trigger_source == "aws-scheduler" and schedule_id == GMAIL_SCHEDULE_ID
    service_id = GMAIL_SERVICE_ID if scheduled else f"{GMAIL_SERVICE_ID}:manual"
    item = {
        "serviceId": service_id,
        "observedAt": finished.isoformat(),
        "startedAt": started_at,
        "finishedAt": finished.isoformat(),
        "status": status,
        "source": "aws-lambda",
        "triggerSource": trigger_source or "unknown",
        "scheduleId": schedule_id,
        "scheduled": scheduled,
        "buildVersion": BUILD_VERSION,
        "accountEmail": GMAIL_ACCOUNT,
        "secretVersion": secret_version or "unknown",
        "counts": counts or {},
        "ttl": int(finished.timestamp() + HEARTBEAT_TTL_DAYS * 24 * 60 * 60),
    }
    if error_code:
        item["errorCode"] = error_code
    if detail:
        item["detail"] = detail
    heartbeat_written = True
    try:
        dynamodb.Table(HEARTBEAT_TABLE).put_item(Item=item)
    except Exception as err:
        # CloudWatch remains the out-of-band signal when the heartbeat store itself fails.
        heartbeat_written = False
        print(f"[gmail] heartbeat write unavailable: {type(err).__name__}")
    try:
        metric_data = [
            {
                "MetricName": "Healthy",
                "Dimensions": [{"Name": "ServiceId", "Value": service_id}],
                "Timestamp": finished,
                "Value": 1 if heartbeat_written and status == "success" else 0,
                "Unit": "Count",
            },
        ]
        if heartbeat_written:
            metric_data.insert(
                0,
                {
                    "MetricName": "Heartbeat",
                    "Dimensions": [{"Name": "ServiceId", "Value": service_id}],
                    "Timestamp": finished,
                    "Value": 1,
                    "Unit": "Count",
                },
            )
        else:
            metric_data.append(
                {
                    "MetricName": "HeartbeatWriteFailure",
                    "Dimensions": [{"Name": "ServiceId", "Value": service_id}],
                    "Timestamp": finished,
                    "Value": 1,
                    "Unit": "Count",
                },
            )
        cloudwatch.put_metric_data(
            Namespace="MarketDashboard/Readiness",
            MetricData=metric_data,
        )
    except Exception as err:
        print(f"[gmail] heartbeat metric unavailable: {type(err).__name__}")
    return heartbeat_written


def get_message(access_token: str, user_id: str, message_id: str) -> Dict[str, Any]:
    return http_json(
        "GET",
        gmail_path(user_id, f"messages/{urllib.parse.quote(message_id, safe='')}"),
        access_token=access_token,
        params={"format": "full"},
    )


def get_message_metadata(access_token: str, user_id: str, message_id: str) -> Dict[str, Any]:
    """Fetch only immutable routing headers before any message body is requested."""
    return http_json(
        "GET",
        gmail_path(user_id, f"messages/{urllib.parse.quote(message_id, safe='')}"),
        access_token=access_token,
        params={
            "format": "metadata",
            "metadataHeaders": ["Subject", "From", "Date"],
        },
    )


def get_attachment_data(access_token: str, user_id: str, message_id: str, attachment_id: str) -> bytes:
    data = http_json(
        "GET",
        gmail_path(
            user_id,
            f"messages/{urllib.parse.quote(message_id, safe='')}/attachments/{urllib.parse.quote(attachment_id, safe='')}",
        ),
        access_token=access_token,
    )
    encoded = data.get("data", "")
    return decode_base64url(encoded)


def decode_base64url(value: str) -> bytes:
    padding = "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode((value + padding).encode("utf-8"))


def get_headers(message: Dict[str, Any]) -> Dict[str, str]:
    headers = {}
    for header in message.get("payload", {}).get("headers", []):
        name = str(header.get("name", "")).lower()
        if name:
            headers[name] = str(header.get("value", ""))
    return headers


def parse_received_date(headers: Dict[str, str], internal_date_ms: Optional[str]) -> datetime:
    date_header = headers.get("date")
    if date_header:
        try:
            parsed = parsedate_to_datetime(date_header)
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            return parsed.astimezone(timezone.utc)
        except (TypeError, ValueError):
            pass

    if internal_date_ms:
        try:
            return datetime.fromtimestamp(int(internal_date_ms) / 1000, tz=timezone.utc)
        except (TypeError, ValueError):
            pass

    return utc_now()


def walk_parts(part: Dict[str, Any]) -> Iterable[Dict[str, Any]]:
    yield part
    for child in part.get("parts", []) or []:
        yield from walk_parts(child)


def extract_attachments(message: Dict[str, Any]) -> List[Dict[str, Any]]:
    attachments = []
    for part in walk_parts(message.get("payload", {})):
        filename = str(part.get("filename") or "").strip()
        body = part.get("body") or {}
        attachment_id = body.get("attachmentId")
        inline_data = body.get("data")
        if not filename and not attachment_id:
            continue
        if not filename:
            filename = f"gmail-part-{part.get('partId', 'attachment')}.bin"
        attachments.append(
            {
                "attachmentId": attachment_id or f"inline-{part.get('partId', len(attachments))}",
                "filename": filename,
                "mimeType": part.get("mimeType") or mimetypes.guess_type(filename)[0] or "application/octet-stream",
                "size": body.get("size"),
                "inlineData": inline_data,
            }
        )
    return attachments


def extract_message_body_artifact(message: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    best_html: Optional[Dict[str, Any]] = None
    best_text: Optional[Dict[str, Any]] = None

    for part in walk_parts(message.get("payload", {})):
        filename = str(part.get("filename") or "").strip()
        body = part.get("body") or {}
        inline_data = body.get("data")
        mime_type = str(part.get("mimeType") or "").lower()

        if filename or not inline_data:
            continue

        if mime_type == "text/html" and best_html is None:
            best_html = {
                "attachmentId": f"message-body-html-{part.get('partId', '0')}",
                "filename": "message-body.html",
                "mimeType": "text/html",
                "size": body.get("size"),
                "inlineData": inline_data,
            }
        elif mime_type == "text/plain" and best_text is None:
            best_text = {
                "attachmentId": f"message-body-text-{part.get('partId', '0')}",
                "filename": "message-body.txt",
                "mimeType": "text/plain",
                "size": body.get("size"),
                "inlineData": inline_data,
            }

    return best_html or best_text


def sanitize_filename(filename: str) -> str:
    base = PurePosixPath(filename).name.strip()
    base = re.sub(r"[^A-Za-z0-9._ -]+", "-", base)
    base = re.sub(r"\s+", "-", base)
    base = base.strip(".-")
    return base[:180] or "attachment.bin"


def is_market_structure_webcast_subject(subject: str) -> bool:
    normalized = re.sub(r"\s+", " ", str(subject or "")).strip().casefold()
    return (
        "market situation report" in normalized
        and bool(re.search(r"\b(?:video|webcast)\b", normalized))
    )


def infer_report_type(filename: str, subject: str) -> str:
    if is_market_structure_webcast_subject(subject):
        return "unknown"
    if re.search(r"\breal[- ]time alert\b", str(subject or ""), re.IGNORECASE):
        return "real-time-alert"
    haystack = f"{filename} {subject}".lower().replace("_", " ")
    for report_type, needles in REPORT_RULES:
        if any(needle in haystack for needle in needles):
            return report_type
    return "unknown"


def build_s3_key(
    *,
    report_type: str,
    received_at: datetime,
    message_id: str,
    attachment_id: str,
    filename: str,
) -> str:
    safe_name = sanitize_filename(filename)
    date_prefix = received_at.strftime("%Y-%m-%d")
    short_message_id = re.sub(r"[^A-Za-z0-9_-]+", "-", message_id)[:32]
    short_attachment_id = re.sub(r"[^A-Za-z0-9_-]+", "-", attachment_id)[:32]
    ext = PurePosixPath(safe_name).suffix.lower()

    if ext == ".pdf":
        type_folder = report_type if report_type != "unknown" else "email-ingest"
        return f"hedgeye-uploads/{type_folder}/{date_prefix}/{short_message_id}-{short_attachment_id}-{safe_name}"

    if report_type == "etf-pro" and ext in {".xlsx", ".xls", ".csv"}:
        return f"hedgeye/etfpro/email-ingest/{date_prefix}/{short_message_id}-{short_attachment_id}-{safe_name}"

    if attachment_id.startswith("message-body-"):
        return f"hedgeye-email/messages/{date_prefix}/{report_type}/{short_message_id}-{short_attachment_id}-{safe_name}"

    return f"hedgeye-email/attachments/{date_prefix}/{report_type}/{short_message_id}-{short_attachment_id}-{safe_name}"


def get_message_ledger_items(table: Any, message_id: str) -> List[Dict[str, Any]]:
    """Query the ledger by Gmail message ID without fetching the Gmail payload."""
    items: List[Dict[str, Any]] = []
    exclusive_start_key: Optional[Dict[str, Any]] = None

    while True:
        kwargs: Dict[str, Any] = {
            "KeyConditionExpression": "messageId = :messageId",
            "ExpressionAttributeValues": {":messageId": message_id},
            "ConsistentRead": True,
        }
        if exclusive_start_key:
            kwargs["ExclusiveStartKey"] = exclusive_start_key
        response = table.query(**kwargs)
        items.extend(response.get("Items", []))
        exclusive_start_key = response.get("LastEvaluatedKey")
        if not exclusive_start_key:
            return items


def attachment_records_are_terminal(items: Iterable[Dict[str, Any]]) -> bool:
    """Return true only when every discovered attachment reached a terminal state."""
    records = list(items)
    attachment_records = [
        item for item in records if item.get("attachmentId") != MESSAGE_LEDGER_ATTACHMENT_ID
    ]

    def is_terminal(item: Dict[str, Any]) -> bool:
        status = item.get("status")
        if status == "UNSUPPORTED":
            return True
        mime_type = str(item.get("mimeType") or "").lower()
        filename = str(item.get("filename") or "").lower()
        is_pdf = mime_type == "application/pdf" or filename.endswith(".pdf")
        if is_pdf:
            if status == "DUPLICATE":
                return True
            return status == "INDEXED"
        if status not in {"STORED", "DUPLICATE", "INDEXED"}:
            return False
        # Older deployments could persist a parser/materializer exception on a
        # STORED row. Treat those rows as unfinished so a message sentinel can
        # never turn a failed research projection into a cursor-safe success.
        if item.get("materializationStatus") == "ERROR":
            return False
        if item.get("retryable") is True:
            return False
        if item.get("parseError") and not item.get("materializationStatus"):
            return False
        report_type = str(item.get("reportType") or "")
        if (
            report_type in RESEARCH_EVENT_SNAPSHOT_TYPES
            and str(item.get("attachmentId") or "").startswith("message-body-")
            and item.get("materializationStatus") not in {
                "INDEXED",
                "MATERIALIZED",
                "EVENT_LEDGERED",
                "PARSED",
            }
        ):
            return False
        return True

    return bool(attachment_records) and all(is_terminal(item) for item in attachment_records)


def message_is_fully_processed(items: Iterable[Dict[str, Any]]) -> bool:
    """Return true when an immutable Gmail message has no unfinished ledger work."""
    records = list(items)
    if any(
        item.get("attachmentId") == MESSAGE_LEDGER_ATTACHMENT_ID
        and item.get("status") == "MESSAGE_IGNORED"
        for item in records
    ):
        # A metadata-only ignore decision is terminal even if a pre-upgrade
        # deployment previously left body-derived artifacts in the ledger.
        return True
    has_message_sentinel = any(
        item.get("attachmentId") == MESSAGE_LEDGER_ATTACHMENT_ID
        and item.get("status") == "MESSAGE_PROCESSED"
        for item in records
    )
    if not has_message_sentinel:
        return False
    attachment_records = [
        item for item in records if item.get("attachmentId") != MESSAGE_LEDGER_ATTACHMENT_ID
    ]
    return not attachment_records or attachment_records_are_terminal(
        attachment_records
    )


def mark_message_processed(
    table: Any,
    *,
    message_id: str,
    headers: Dict[str, str],
    attachment_count: int,
) -> None:
    """Write a small sentinel so later scheduled runs can skip messages cheaply."""
    now = utc_now().isoformat()
    table.put_item(
        Item={
            "messageId": message_id,
            "attachmentId": MESSAGE_LEDGER_ATTACHMENT_ID,
            "status": "MESSAGE_PROCESSED",
            "subject": headers.get("subject", ""),
            "sender": headers.get("from", ""),
            "attachmentCount": attachment_count,
            "createdAt": now,
            "updatedAt": now,
            "ttl": ttl_epoch(),
        }
    )


def mark_message_ignored(
    table: Any,
    *,
    message_id: str,
    headers: Dict[str, str],
    reason: str,
) -> None:
    """Persist a terminal metadata-only decision so ignored mail is never retried."""
    now = utc_now().isoformat()
    table.put_item(
        Item={
            "messageId": message_id,
            "attachmentId": MESSAGE_LEDGER_ATTACHMENT_ID,
            "status": "MESSAGE_IGNORED",
            "subject": headers.get("subject", ""),
            "sender": headers.get("from", ""),
            "attachmentCount": 0,
            "ignoredReason": reason,
            "bodyFetched": False,
            "createdAt": now,
            "updatedAt": now,
            "ttl": ttl_epoch(),
        }
    )


def _parse_ledger_datetime(item: Dict[str, Any]) -> datetime:
    for key in ("receivedAt", "createdAt", "updatedAt"):
        value = item.get(key)
        if not value:
            continue
        try:
            parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            return parsed.astimezone(timezone.utc)
        except (TypeError, ValueError):
            continue
    return utc_now()


def _immutable_artifact_evidence(item: Dict[str, Any]) -> Dict[str, Any]:
    return {
        key: item[key]
        for key in IMMUTABLE_ARTIFACT_EVIDENCE_FIELDS
        if item.get(key) is not None
    }


def claim_attachment(
    table: Any,
    *,
    message_id: str,
    attachment_id: str,
    headers: Dict[str, str],
    filename: str,
    mime_type: str,
    report_type: str,
) -> bool:
    now_dt = utc_now()
    now = now_dt.isoformat()
    claim_item = {
        "messageId": message_id,
        "attachmentId": attachment_id,
        "status": "IN_PROGRESS",
        "filename": filename,
        "mimeType": mime_type,
        "reportType": report_type,
        "subject": headers.get("subject", ""),
        "sender": headers.get("from", ""),
        "createdAt": now,
        "updatedAt": now,
        "ttl": ttl_epoch(),
    }
    try:
        table.put_item(
            Item=claim_item,
            ConditionExpression=(
                "attribute_not_exists(messageId) "
                "AND attribute_not_exists(attachmentId)"
            ),
        )
        return True
    except ClientError as err:
        if err.response.get("Error", {}).get("Code") != "ConditionalCheckFailedException":
            raise

    key = {"messageId": message_id, "attachmentId": attachment_id}
    existing = table.get_item(Key=key, ConsistentRead=True).get("Item")
    expected_updated_at = existing.get("updatedAt") if existing else None
    existing_status = str(existing.get("status") or "") if existing else ""
    if existing and existing_status in {"ERROR", "TEXTRACT_ERROR"}:
        if not expected_updated_at:
            return False
        reclaimed_item = {
            **claim_item,
            **_immutable_artifact_evidence(existing),
            "createdAt": existing.get("createdAt") or now,
            "reclaimedAt": now,
        }
        try:
            table.put_item(
                Item=reclaimed_item,
                ConditionExpression=(
                    "(#status = :error OR #status = :textractError) "
                    "AND #updatedAt = :expectedUpdatedAt"
                ),
                ExpressionAttributeNames={
                    "#status": "status",
                    "#updatedAt": "updatedAt",
                },
                ExpressionAttributeValues={
                    ":error": "ERROR",
                    ":textractError": "TEXTRACT_ERROR",
                    ":expectedUpdatedAt": expected_updated_at,
                },
            )
            return True
        except ClientError as err:
            if err.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
                return False
            raise
    is_pdf = (
        str(mime_type or "").lower() == "application/pdf"
        or str(filename or "").lower().endswith(".pdf")
    )
    if existing_status == "IN_PROGRESS":
        stale_seconds = ATTACHMENT_CLAIM_STALE_SECONDS
    elif is_pdf and existing_status in {
        "TEXTRACT_DISPATCHED",
        "RECEIVED",
        "PARSED",
        "VALIDATED",
    }:
        # A process can exit after dispatch or between projection stages. Keep
        # active 15-minute Lambda work protected, then let the scheduled Gmail
        # poll safely re-dispatch the immutable content after one hour.
        stale_seconds = TEXTRACT_CLAIM_STALE_SECONDS
    else:
        return False
    if not expected_updated_at:
        return False

    try:
        updated_at = datetime.fromisoformat(str(expected_updated_at).replace("Z", "+00:00"))
        if updated_at.tzinfo is None:
            updated_at = updated_at.replace(tzinfo=timezone.utc)
        updated_at = updated_at.astimezone(timezone.utc)
    except (TypeError, ValueError):
        return False
    if now_dt - updated_at < timedelta(seconds=stale_seconds):
        return False

    reclaimed_item = {
        **claim_item,
        **_immutable_artifact_evidence(existing),
        "createdAt": existing.get("createdAt") or now,
        "reclaimedAt": now,
    }
    try:
        table.put_item(
            Item=reclaimed_item,
            ConditionExpression="#status = :inProgress AND #updatedAt = :expectedUpdatedAt",
            ExpressionAttributeNames={"#status": "status", "#updatedAt": "updatedAt"},
            ExpressionAttributeValues={
                ":inProgress": existing_status,
                ":expectedUpdatedAt": expected_updated_at,
            },
        )
        return True
    except ClientError as err:
        if err.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
            return False
        raise


def mark_attachment(
    table: Any,
    *,
    message_id: str,
    attachment_id: str,
    status: str,
    extra: Optional[Dict[str, Any]] = None,
) -> None:
    names = {"#status": "status", "#updatedAt": "updatedAt"}
    values = {":status": status, ":updatedAt": utc_now().isoformat()}
    assignments = ["#status = :status", "#updatedAt = :updatedAt"]

    for idx, (key, value) in enumerate((extra or {}).items()):
        name_key = f"#n{idx}"
        value_key = f":v{idx}"
        names[name_key] = key
        values[value_key] = value
        assignments.append(f"{name_key} = {value_key}")

    table.update_item(
        Key={"messageId": message_id, "attachmentId": attachment_id},
        UpdateExpression="SET " + ", ".join(assignments),
        ExpressionAttributeNames=names,
        ExpressionAttributeValues=values,
    )


def _to_dynamodb_value(value: Any) -> Any:
    if isinstance(value, float):
        return Decimal(str(value))
    if isinstance(value, list):
        return [_to_dynamodb_value(item) for item in value]
    if isinstance(value, dict):
        return {key: _to_dynamodb_value(item) for key, item in value.items()}
    return value


def _canonical_value(value: Any) -> Any:
    if isinstance(value, Decimal):
        return str(value.normalize())
    if isinstance(value, float):
        return str(Decimal(str(value)).normalize())
    if isinstance(value, list):
        return [_canonical_value(item) for item in value]
    if isinstance(value, dict):
        return {key: _canonical_value(value[key]) for key in sorted(value)}
    return value


RESEARCH_EVENT_VERIFICATION_HASH_VERSION = "research-event-content-v1"


def _verification_value(value: Any) -> Any:
    if isinstance(value, bool) or value is None:
        return value
    if isinstance(value, (Decimal, float, int)):
        decimal_value = Decimal(str(value))
        if not decimal_value.is_finite():
            return str(decimal_value)
        normalized = format(decimal_value.normalize(), "f")
        return "-0" if decimal_value.is_zero() and decimal_value.is_signed() else normalized
    if isinstance(value, list):
        return [_verification_value(item) for item in value]
    if isinstance(value, dict):
        return {key: _verification_value(value[key]) for key in sorted(value)}
    return value


def _research_event_verification_hash(event_type: str, payload: Any) -> str:
    canonical = _verification_value({
        "eventType": event_type,
        "payload": payload,
    })
    return hashlib.sha256(
        json.dumps(
            canonical,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
        ).encode("utf-8")
    ).hexdigest()


def _research_event_payloads(snapshot: Dict[str, Any]) -> List[Tuple[str, Any]]:
    """Return canonical event records without mixing product books."""
    snapshot_type = str(snapshot.get("snapshotType") or "")
    data = snapshot.get("data") or {}
    if snapshot_type in {"real-time-alert", "investing-ideas"}:
        alerts = data.get("alerts") if isinstance(data.get("alerts"), list) else []
        if not alerts and data.get("alert"):
            alerts = [data["alert"]]
        return [("POSITION_ACTION", alert) for alert in alerts if isinstance(alert, dict)]
    if snapshot_type == "etf-pro":
        changes = data.get("changes") if isinstance(data.get("changes"), list) else []
        if changes:
            return [("POSITION_ACTION", change) for change in changes if isinstance(change, dict)]
        rows = data.get("rows") if isinstance(data.get("rows"), list) else []
        checkpoint_rows = []
        for row in rows:
            if not isinstance(row, dict) or not str(row.get("ticker") or "").strip():
                continue
            side = str(row.get("side") or row.get("call") or "").title()
            if side not in {"Long", "Short"}:
                continue
            checkpoint_rows.append({
                **deepcopy(row),
                "ticker": str(row["ticker"]).upper(),
                "call": side,
                "side": side,
            })
        if not checkpoint_rows:
            return []
        longs = [row["ticker"] for row in checkpoint_rows if row["side"] == "Long"]
        shorts = [row["ticker"] for row in checkpoint_rows if row["side"] == "Short"]
        return [("FULL_BOOK_CHECKPOINT", {
            "rows": checkpoint_rows,
            "fullBookLongs": list(data.get("fullBookLongs") or longs),
            "fullBookShorts": list(data.get("fullBookShorts") or shorts),
            "rowCount": len(checkpoint_rows),
            "longCount": len(longs),
            "shortCount": len(shorts),
            "headline": data.get("headline") or snapshot.get("article", {}).get("headline"),
        })]
    if snapshot_type == "risk-ranges":
        return [("DAILY_PRIMARY_MANIFEST", data)] if isinstance(data, dict) and data else []
    if snapshot_type == "early-look":
        return [("DAILY_SUPPLEMENTAL_SNAPSHOT", data)] if isinstance(data, dict) and data else []
    return []


def persist_research_event_ledger(
    snapshot: Dict[str, Any],
    db: Any,
    *,
    content_sha256: Optional[str] = None,
) -> int:
    """Persist immutable, idempotent parsed events before projection writes."""
    payloads = _research_event_payloads(snapshot)
    if not payloads:
        return 0
    product_key = str(snapshot.get("snapshotType") or snapshot.get("reportType") or "unknown")
    event_time = str(snapshot.get("scrapedAt") or snapshot.get("publishedAt") or utc_now().isoformat())
    message_id = str(snapshot.get("gmailMessageId") or "unknown-message")
    artifact_key = str(snapshot.get("htmlSource") or "")
    table = db.Table(RESEARCH_EVENT_LEDGER_TABLE)
    written = 0

    for sequence, (event_type, payload) in enumerate(payloads):
        canonical = {
            "eventType": event_type,
            "payload": _canonical_value(payload),
        }
        event_hash = hashlib.sha256(
            json.dumps(canonical, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("utf-8")
        ).hexdigest()
        verification_hash = _research_event_verification_hash(event_type, payload)
        event_key = f"{event_time}#{message_id}#{sequence:04d}"
        default_source_kind = {
            "POSITION_ACTION": "position-action",
            "FULL_BOOK_CHECKPOINT": "full-book-checkpoint",
            "DAILY_PRIMARY_MANIFEST": "daily-primary-manifest",
            "DAILY_SUPPLEMENTAL_SNAPSHOT": "daily-supplemental-snapshot",
        }.get(event_type, "research-event")
        item = {
            "productKey": product_key,
            "eventKey": event_key,
            "eventTime": event_time,
            "sourceMessageId": message_id,
            "sequence": sequence,
            "sourceEventCount": len(payloads),
            "eventType": event_type,
            "payload": payload,
            "snapshotDate": snapshot.get("date"),
            "sourceKind": snapshot.get("sourceKind") or default_source_kind,
            "source": "gmail",
            "sourceArtifact": artifact_key,
            "contentHash": content_sha256 or snapshot.get("contentHash") or event_hash,
            "eventHash": event_hash,
            "verificationHashVersion": RESEARCH_EVENT_VERIFICATION_HASH_VERSION,
            "verificationHash": verification_hash,
            "parserVersion": RESEARCH_PARSER_VERSION,
            "capturedAt": str(snapshot.get("scrapedAt") or utc_now().isoformat()),
            "immutable": True,
        }
        try:
            table.put_item(
                Item=_to_dynamodb_value(item),
                ConditionExpression="attribute_not_exists(#productKey) AND attribute_not_exists(#eventKey)",
                ExpressionAttributeNames={"#productKey": "productKey", "#eventKey": "eventKey"},
            )
            written += 1
        except ClientError as err:
            if err.response.get("Error", {}).get("Code") != "ConditionalCheckFailedException":
                raise
            existing = table.get_item(
                Key={"productKey": product_key, "eventKey": event_key},
                ConsistentRead=True,
            ).get("Item") or {}
            if existing.get("eventHash") != event_hash:
                raise RuntimeError(
                    f"RESEARCH_EVENT_CONFLICT: immutable event {product_key}/{event_key} changed"
                ) from err
            if (
                existing.get("verificationHashVersion") != RESEARCH_EVENT_VERIFICATION_HASH_VERSION
                or existing.get("verificationHash") != verification_hash
                or existing.get("sourceEventCount") != len(payloads)
            ):
                table.update_item(
                    Key={"productKey": product_key, "eventKey": event_key},
                    UpdateExpression=(
                        "SET #verificationHashVersion = :verificationHashVersion, "
                        "#verificationHash = :verificationHash, "
                        "#sourceEventCount = :sourceEventCount"
                    ),
                    ConditionExpression="#eventHash = :eventHash",
                    ExpressionAttributeNames={
                        "#eventHash": "eventHash",
                        "#verificationHashVersion": "verificationHashVersion",
                        "#verificationHash": "verificationHash",
                        "#sourceEventCount": "sourceEventCount",
                    },
                    ExpressionAttributeValues={
                        ":eventHash": event_hash,
                        ":verificationHashVersion": RESEARCH_EVENT_VERIFICATION_HASH_VERSION,
                        ":verificationHash": verification_hash,
                        ":sourceEventCount": len(payloads),
                    },
                )
    return written


def _integral_dynamodb_number(value: Any, *, minimum: int) -> Optional[int]:
    """Normalize live DynamoDB Number values without accepting lossy numerics."""
    if isinstance(value, bool) or not isinstance(value, (int, Decimal)):
        return None
    if isinstance(value, Decimal):
        if not value.is_finite() or value != value.to_integral_value():
            return None
    parsed = int(value)
    return parsed if parsed >= minimum else None


def verify_research_event_ledger(db: Any) -> Dict[str, Any]:
    table = db.Table(RESEARCH_EVENT_LEDGER_TABLE)
    products: Dict[str, Dict[str, int]] = {}
    for product_key in ("real-time-alert", "etf-pro"):
        items: List[Dict[str, Any]] = []
        exclusive_start_key = None
        while True:
            query: Dict[str, Any] = {
                "KeyConditionExpression": "#productKey = :productKey",
                "ExpressionAttributeNames": {"#productKey": "productKey"},
                "ExpressionAttributeValues": {":productKey": product_key},
                "ConsistentRead": True,
            }
            if exclusive_start_key:
                query["ExclusiveStartKey"] = exclusive_start_key
            response = table.query(**query)
            items.extend(response.get("Items") or [])
            exclusive_start_key = response.get("LastEvaluatedKey")
            if not exclusive_start_key:
                break
        unverified_keys = set()
        for index, item in enumerate(items):
            expected = _research_event_verification_hash(
                str(item.get("eventType") or ""),
                item.get("payload"),
            )
            if (
                item.get("verificationHashVersion")
                != RESEARCH_EVENT_VERIFICATION_HASH_VERSION
                or item.get("verificationHash") != expected
            ):
                unverified_keys.add(index)
        by_source: Dict[str, List[Tuple[int, Dict[str, Any]]]] = {}
        for index, item in enumerate(items):
            source_message_id = str(item.get("sourceMessageId") or "")
            by_source.setdefault(source_message_id, []).append((index, item))
        for source_message_id, source_items in by_source.items():
            normalized_counts = [
                _integral_dynamodb_number(item.get("sourceEventCount"), minimum=1)
                for _, item in source_items
            ]
            normalized_sequences = [
                _integral_dynamodb_number(item.get("sequence"), minimum=0)
                for _, item in source_items
            ]
            counts = {
                value for value in normalized_counts if value is not None
            }
            sequences = {
                value for value in normalized_sequences if value is not None
            }
            expected_count = next(iter(counts)) if len(counts) == 1 else None
            complete = (
                bool(source_message_id)
                and expected_count is not None
                and all(value == expected_count for value in normalized_counts)
                and all(value is not None for value in normalized_sequences)
                and len(source_items) == expected_count
                and len(sequences) == len(source_items)
                and sequences == set(range(expected_count))
            )
            if not complete:
                unverified_keys.update(index for index, _ in source_items)
        unverified = len(unverified_keys)
        products[product_key] = {
            "eventCount": len(items),
            "unverifiedEventCount": unverified,
        }
    event_count = sum(item["eventCount"] for item in products.values())
    unverified_count = sum(
        item["unverifiedEventCount"] for item in products.values()
    )
    verified = (
        unverified_count == 0
        and all(item["eventCount"] > 0 for item in products.values())
    )
    return {
        "verified": verified,
        "eventCount": event_count,
        "unverifiedEventCount": unverified_count,
        "products": products,
    }


def _ordered_unique(values: Iterable[Any]) -> List[str]:
    result: List[str] = []
    seen = set()
    for value in values:
        normalized = str(value or "").strip()
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        result.append(normalized)
    return result


def _snapshot_source_message_ids(snapshot: Dict[str, Any]) -> List[str]:
    values = list(snapshot.get("sourceMessageIds") or [])
    if snapshot.get("gmailMessageId"):
        values.append(snapshot["gmailMessageId"])
    return _ordered_unique(values)


def _with_event_metadata(
    rows: Iterable[Dict[str, Any]],
    *,
    message_id: Optional[str],
    event_time: Optional[str],
) -> List[Dict[str, Any]]:
    result = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        enriched = deepcopy(row)
        if message_id:
            enriched.setdefault("sourceMessageId", message_id)
        if event_time:
            enriched.setdefault("eventTime", event_time)
        result.append(enriched)
    return result


def _merge_rta_data(
    existing: Dict[str, Any],
    incoming: Dict[str, Any],
    *,
    replacing_source_ids: Iterable[str],
) -> Dict[str, Any]:
    existing_data = deepcopy(existing.get("data") or {})
    incoming_data = deepcopy(incoming.get("data") or {})
    existing_id = existing.get("gmailMessageId")
    incoming_id = incoming.get("gmailMessageId")

    existing_alerts = existing_data.get("alerts")
    if not isinstance(existing_alerts, list):
        existing_alerts = [existing_data["alert"]] if existing_data.get("alert") else []
    alerts = _with_event_metadata(
        existing_alerts,
        message_id=existing_id,
        event_time=existing.get("scrapedAt"),
    )
    replacement_sources = set(replacing_source_ids)
    alerts = [
        alert
        for alert in alerts
        if alert.get("sourceMessageId") not in replacement_sources
    ]

    incoming_alerts = incoming_data.get("alerts")
    if not isinstance(incoming_alerts, list):
        incoming_alerts = [incoming_data["alert"]] if incoming_data.get("alert") else []
    alerts.extend(
        _with_event_metadata(
            incoming_alerts,
            message_id=incoming_id,
            event_time=incoming.get("scrapedAt"),
        )
    )

    alerts.sort(key=lambda alert: (str(alert.get("eventTime") or ""), str(alert.get("sourceMessageId") or "")))
    latest_alert = alerts[-1] if alerts else incoming_data.get("alert") or existing_data.get("alert")
    latest_headline = (
        (latest_alert or {}).get("headline")
        or incoming_data.get("headline")
        or existing_data.get("headline")
    )
    result = {**existing_data, **incoming_data}
    result["alerts"] = alerts
    result["alert"] = latest_alert
    result["headline"] = latest_headline
    return result


def _merge_etf_pro_data(
    existing: Dict[str, Any],
    incoming: Dict[str, Any],
    *,
    replacing_source_ids: Iterable[str],
) -> Dict[str, Any]:
    existing_data = deepcopy(existing.get("data") or {})
    incoming_data = deepcopy(incoming.get("data") or {})
    replacement_sources = set(replacing_source_ids)

    checkpoint_events = deepcopy(existing_data.get("checkpointEvents") or [])
    if not checkpoint_events and existing_data.get("checkpointAvailable"):
        legacy_rows = [
            row
            for row in existing_data.get("rows", [])
            if isinstance(row, dict) and not row.get("action")
        ]
        if legacy_rows:
            checkpoint_events.append({
                "eventTime": existing.get("scrapedAt"),
                "sourceMessageId": existing.get("gmailMessageId"),
                "rows": legacy_rows,
                "headline": existing_data.get("headline"),
            })
    checkpoint_events = [
        checkpoint
        for checkpoint in checkpoint_events
        if checkpoint.get("sourceMessageId") not in replacement_sources
    ]

    incoming_rows = [
        row for row in incoming_data.get("rows", []) if isinstance(row, dict)
    ]
    incoming_is_checkpoint = bool(
        incoming_data.get("checkpointAvailable")
        and incoming_rows
        and not any(row.get("action") for row in incoming_rows)
    )
    if incoming_is_checkpoint:
        checkpoint_events.append({
            "eventTime": incoming.get("scrapedAt"),
            "sourceMessageId": incoming.get("gmailMessageId"),
            "rows": incoming_rows,
            "fullBookLongs": list(incoming_data.get("fullBookLongs") or []),
            "fullBookShorts": list(incoming_data.get("fullBookShorts") or []),
            "headline": incoming_data.get("headline"),
        })
    checkpoint_events.sort(
        key=lambda checkpoint: (
            str(checkpoint.get("eventTime") or ""),
            str(checkpoint.get("sourceMessageId") or ""),
        )
    )

    existing_changes = existing_data.get("changes")
    if not isinstance(existing_changes, list):
        existing_changes = [
            row for row in existing_data.get("rows", []) if isinstance(row, dict) and row.get("action")
        ]

    changes = _with_event_metadata(
        existing_changes,
        message_id=existing.get("gmailMessageId"),
        event_time=existing.get("scrapedAt"),
    )
    changes = [
        change
        for change in changes
        if change.get("sourceMessageId") not in replacement_sources
    ]
    incoming_changes = incoming_data.get("changes")
    if not isinstance(incoming_changes, list):
        incoming_changes = [
            row for row in incoming_data.get("rows", []) if isinstance(row, dict) and row.get("action")
        ]
    changes.extend(
        _with_event_metadata(
            incoming_changes,
            message_id=incoming.get("gmailMessageId"),
            event_time=incoming.get("scrapedAt"),
        )
    )

    # The API needs the current action for a ticker/side pair, not every repeated
    # notification. Chronological last-write-wins keeps ADD -> REMOVE (and the
    # reverse) semantically correct while sourceMessageIds retain provenance.
    changes.sort(
        key=lambda row: (
            str(row.get("eventTime") or ""),
            str(row.get("sourceMessageId") or ""),
        )
    )
    latest_checkpoint = checkpoint_events[-1] if checkpoint_events else None
    checkpoint_key = (
        str((latest_checkpoint or {}).get("eventTime") or ""),
        str((latest_checkpoint or {}).get("sourceMessageId") or ""),
    )
    replay_changes = [
        change
        for change in changes
        if not latest_checkpoint
        or (
            str(change.get("eventTime") or ""),
            str(change.get("sourceMessageId") or ""),
        ) > checkpoint_key
    ]
    latest_by_position: Dict[Tuple[str, str], Dict[str, Any]] = {}
    for change in replay_changes:
        ticker = str(change.get("ticker") or "").upper()
        side = str(change.get("side") or change.get("call") or "").title()
        if not ticker or side not in {"Long", "Short"}:
            continue
        latest_by_position[(ticker, side)] = change
    current_changes = list(latest_by_position.values())

    if latest_checkpoint:
        current_book: Dict[Tuple[str, str], Dict[str, Any]] = {}
        for row in latest_checkpoint.get("rows", []):
            ticker = str(row.get("ticker") or "").upper()
            side = str(row.get("side") or row.get("call") or "").title()
            if not ticker or side not in {"Long", "Short"}:
                continue
            current_book[(ticker, side)] = {
                **deepcopy(row),
                "ticker": ticker,
                "call": side,
                "side": side,
            }
        for change in replay_changes:
            ticker = str(change.get("ticker") or "").upper()
            side = str(change.get("side") or change.get("call") or "").title()
            if not ticker or side not in {"Long", "Short"}:
                continue
            key = (ticker, side)
            if str(change.get("action") or "").upper() == "REMOVE":
                current_book.pop(key, None)
            elif str(change.get("action") or "").upper() == "ADD":
                current_book[key] = {
                    **deepcopy(change),
                    "ticker": ticker,
                    "call": side,
                    "side": side,
                    "sourceAction": "ADD",
                }
        rows = list(current_book.values())
    else:
        rows = [deepcopy(change) for change in current_changes]
    rows.sort(key=lambda row: (str(row.get("side") or row.get("call") or ""), str(row.get("ticker") or "")))
    rows = [
        {**row, "id": f"{row.get('ticker', 'item')}_{index}"}
        for index, row in enumerate(rows)
    ]

    def tickers(action: str, side: str) -> List[str]:
        return _ordered_unique(
            change.get("ticker")
            for change in current_changes
            if str(change.get("action") or "").upper() == action
            and str(change.get("side") or change.get("call") or "").title() == side
        )

    added_longs = tickers("ADD", "Long")
    removed_longs = tickers("REMOVE", "Long")
    added_shorts = tickers("ADD", "Short")
    removed_shorts = tickers("REMOVE", "Short")
    result = {**existing_data, **incoming_data}
    result.update(
        {
            "checkpointAvailable": bool(latest_checkpoint),
            "checkpointEvents": checkpoint_events,
            "changes": current_changes,
            "rows": rows,
            "fullBookLongs": [
                row["ticker"]
                for row in rows
                if str(row.get("side") or row.get("call") or "").title() == "Long"
            ],
            "fullBookShorts": [
                row["ticker"]
                for row in rows
                if str(row.get("side") or row.get("call") or "").title() == "Short"
            ],
            "added": _ordered_unique([*added_longs, *added_shorts]),
            "removed": _ordered_unique([*removed_longs, *removed_shorts]),
            "addedLongs": added_longs,
            "removedLongs": removed_longs,
            "addedShorts": added_shorts,
            "removedShorts": removed_shorts,
        }
    )
    return result


def _compute_materialized_data_version(item: Dict[str, Any]) -> str:
    versioned = {
        key: value
        for key, value in item.items()
        if key not in {"dataVersion", "materializedAt", "ttl"}
    }
    encoded = json.dumps(
        _canonical_value(versioned),
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=True,
    ).encode("utf-8")
    return f"{MATERIALIZED_DATA_VERSION}:{hashlib.sha256(encoded).hexdigest()}"


def _merge_materialized_snapshot(
    existing: Optional[Dict[str, Any]], incoming: Dict[str, Any]
) -> Dict[str, Any]:
    current = deepcopy(existing or {})
    candidate = deepcopy(incoming)
    existing_sources = _snapshot_source_message_ids(current)
    incoming_sources = _snapshot_source_message_ids(candidate)

    incoming_is_latest = str(candidate.get("scrapedAt") or "") >= str(current.get("scrapedAt") or "")
    merged = deepcopy(candidate if not current or incoming_is_latest else current)
    merged["date"] = candidate["date"]
    merged["snapshotType"] = candidate["snapshotType"]

    if candidate["snapshotType"] == "real-time-alert":
        merged["data"] = _merge_rta_data(
            current,
            candidate,
            replacing_source_ids=incoming_sources,
        )
        merged["itemCount"] = len(merged["data"].get("alerts") or [])
    elif candidate["snapshotType"] == "etf-pro":
        merged["data"] = _merge_etf_pro_data(
            current,
            candidate,
            replacing_source_ids=incoming_sources,
        )
        merged["itemCount"] = len(merged["data"].get("rows") or [])
        merged["changeCount"] = len(merged["data"].get("changes") or [])

    merged["sourceMessageIds"] = sorted(
        _ordered_unique([*existing_sources, *incoming_sources])
    )
    merged["materializedAt"] = utc_now().isoformat()
    merged["ttl"] = ttl_epoch()
    merged["dataVersion"] = _compute_materialized_data_version(merged)
    return merged


def materialize_email_snapshot(
    snapshot: Dict[str, Any], db: Any
) -> Tuple[Dict[str, Any], bool]:
    """Idempotently merge an RTA/ETF email into its daily materialized snapshot."""
    if snapshot.get("snapshotType") not in MATERIALIZED_SNAPSHOT_TYPES:
        save_snapshot_to_dynamodb(snapshot, db)
        return snapshot, True

    table = db.Table("HedgeyeDailySnapshot")
    key = {"date": snapshot["date"], "snapshotType": snapshot["snapshotType"]}

    for attempt in range(MATERIALIZATION_WRITE_RETRIES):
        existing = table.get_item(Key=key).get("Item")
        merged = _merge_materialized_snapshot(existing, snapshot)
        if (
            existing
            and existing.get("dataVersion") == merged.get("dataVersion")
            and existing.get("sourceMessageIds") == merged.get("sourceMessageIds")
        ):
            return existing, False

        put_kwargs: Dict[str, Any] = {"Item": _to_dynamodb_value(merged)}
        if not existing:
            put_kwargs.update(
                {
                    "ConditionExpression": "attribute_not_exists(#date) AND attribute_not_exists(#snapshotType)",
                    "ExpressionAttributeNames": {
                        "#date": "date",
                        "#snapshotType": "snapshotType",
                    },
                }
            )
        elif existing.get("dataVersion") is None:
            put_kwargs.update(
                {
                    "ConditionExpression": "attribute_not_exists(#dataVersion)",
                    "ExpressionAttributeNames": {"#dataVersion": "dataVersion"},
                }
            )
        else:
            put_kwargs.update(
                {
                    "ConditionExpression": "#dataVersion = :expectedDataVersion",
                    "ExpressionAttributeNames": {"#dataVersion": "dataVersion"},
                    "ExpressionAttributeValues": {
                        ":expectedDataVersion": existing["dataVersion"]
                    },
                }
            )

        try:
            table.put_item(**put_kwargs)
            return merged, True
        except ClientError as err:
            is_conflict = (
                err.response.get("Error", {}).get("Code")
                == "ConditionalCheckFailedException"
            )
            if not is_conflict or attempt == MATERIALIZATION_WRITE_RETRIES - 1:
                raise

    raise RuntimeError("Unable to materialize email snapshot after conditional-write retries")


def _textract_content_key(content_sha256: str) -> Dict[str, str]:
    return {
        "messageId": f"CONTENT#{content_sha256}",
        "attachmentId": TEXTRACT_LEDGER_ATTACHMENT_ID,
    }


def _s3_object_exists(bucket: Optional[str], key: Optional[str]) -> bool:
    if not bucket or not key:
        return False
    try:
        s3.head_object(Bucket=bucket, Key=key)
        return True
    except ClientError as err:
        code = str(err.response.get("Error", {}).get("Code") or "")
        if code in {"404", "NoSuchKey", "NotFound"}:
            return False
        raise


def put_immutable_s3_object(
    *,
    bucket: str,
    key: str,
    body: bytes,
    content_type: str,
    metadata: Dict[str, str],
    content_sha256: str,
) -> bool:
    """Create one immutable artifact version and never overwrite it on retry.

    The deterministic key is bound to the Gmail message and attachment. S3
    versioning makes an ordinary overwrite billable and persistent, so the
    conditional write is a hard cost and integrity boundary. A pre-existing
    object is accepted only when its stored bytes prove the same SHA-256.
    """
    try:
        s3.put_object(
            Bucket=bucket,
            Key=key,
            Body=body,
            ContentType=content_type,
            Metadata=metadata,
            IfNoneMatch="*",
        )
        return True
    except ClientError as err:
        code = str(err.response.get("Error", {}).get("Code") or "")
        status_code = int(err.response.get("ResponseMetadata", {}).get("HTTPStatusCode") or 0)
        if (
            code not in {"PreconditionFailed", "ConditionalRequestConflict", "412"}
            and status_code not in {409, 412}
        ):
            raise

    existing = s3.head_object(Bucket=bucket, Key=key)
    existing_metadata = {
        str(name).casefold(): str(value)
        for name, value in (existing.get("Metadata") or {}).items()
    }
    existing_sha256 = existing_metadata.get("content-sha256")
    if not existing_sha256:
        response = s3.get_object(Bucket=bucket, Key=key)
        existing_body = response["Body"].read()
        existing_sha256 = hashlib.sha256(existing_body).hexdigest()
    if not hmac.compare_digest(existing_sha256, content_sha256):
        raise RuntimeError(
            "Immutable S3 key already exists with a different content checksum."
        )
    return False


def archive_market_structure_chart(
    *,
    chart: Dict[str, str],
    payload: bytes,
    content_type: str,
    extension: str,
    content_sha256: str,
) -> Dict[str, str]:
    """Store one verified report chart under a private content-addressed key."""
    if not re.fullmatch(r"[a-f0-9]{64}", content_sha256):
        raise ValueError("Market Situation chart checksum is invalid")
    if content_type not in {"image/png", "image/jpeg", "image/webp"}:
        raise ValueError("Market Situation chart content type is not allowlisted")
    expected_extension = {
        "image/png": "png",
        "image/jpeg": "jpg",
        "image/webp": "webp",
    }[content_type]
    if extension != expected_extension:
        raise ValueError("Market Situation chart extension does not match its content")

    s3_key = f"{MARKET_STRUCTURE_ASSET_PREFIX}{content_sha256}.{extension}"
    put_immutable_s3_object(
        bucket=S3_BUCKET,
        key=s3_key,
        body=payload,
        content_type=content_type,
        metadata={
            "source": "gmail-market-structure",
            "report-type": "market-structure",
            "content-sha256": content_sha256,
        },
        content_sha256=content_sha256,
    )
    return {
        "id": content_sha256,
        "s3Key": s3_key,
    }


def claim_textract_content(
    table: Any,
    *,
    content_sha256: str,
    report_type: str,
    message_id: str,
    attachment_id: str,
    s3_key: str,
) -> Tuple[bool, Optional[Dict[str, Any]]]:
    """Claim a PDF hash before S3 dispatch so Textract is triggered at most once."""
    key = _textract_content_key(content_sha256)
    now = utc_now()
    now_iso = now.isoformat()
    stale_before = (now - timedelta(seconds=TEXTRACT_CLAIM_STALE_SECONDS)).isoformat()
    item = {
        **key,
        "status": "TEXTRACT_PENDING",
        "contentSha256": content_sha256,
        "reportType": report_type,
        "sourceMessageId": message_id,
        "sourceAttachmentId": attachment_id,
        "s3Bucket": S3_BUCKET,
        "s3Key": s3_key,
        "createdAt": now_iso,
        "updatedAt": now_iso,
        "ttl": ttl_epoch(),
    }

    try:
        table.put_item(
            Item=item,
            ConditionExpression="attribute_not_exists(messageId) OR #status = :error",
            ExpressionAttributeNames={"#status": "status"},
            ExpressionAttributeValues={
                ":error": "TEXTRACT_ERROR",
            },
        )
        return True, item
    except ClientError as err:
        if err.response.get("Error", {}).get("Code") != "ConditionalCheckFailedException":
            raise

    existing = table.get_item(Key=key).get("Item")
    if existing and existing.get("status") == "TEXTRACT_PENDING":
        # A prior invocation may have uploaded successfully and then exited before
        # updating the claim. Confirm S3 before ever allowing a stale re-dispatch.
        if _s3_object_exists(existing.get("s3Bucket"), existing.get("s3Key")):
            mark_attachment(
                table,
                message_id=key["messageId"],
                attachment_id=key["attachmentId"],
                status="TEXTRACT_DISPATCHED",
                extra={"reconciledFromS3": True},
            )
            existing["status"] = "TEXTRACT_DISPATCHED"
            return False, existing

        if str(existing.get("updatedAt") or "") < stale_before:
            try:
                table.put_item(
                    Item=item,
                    ConditionExpression="#status = :pending AND #updatedAt = :expectedUpdatedAt",
                    ExpressionAttributeNames={"#status": "status", "#updatedAt": "updatedAt"},
                    ExpressionAttributeValues={
                        ":pending": "TEXTRACT_PENDING",
                        ":expectedUpdatedAt": existing.get("updatedAt"),
                    },
                )
                return True, item
            except ClientError as err:
                if err.response.get("Error", {}).get("Code") != "ConditionalCheckFailedException":
                    raise
    return False, existing


def mark_textract_content(
    table: Any,
    *,
    content_sha256: str,
    status: str,
    extra: Optional[Dict[str, Any]] = None,
) -> None:
    key = _textract_content_key(content_sha256)
    mark_attachment(
        table,
        message_id=key["messageId"],
        attachment_id=key["attachmentId"],
        status=status,
        extra=extra,
    )


def dispatch_pdf_processor(
    *,
    bucket: str,
    s3_key: str,
    message_id: str,
    attachment_id: str,
    content_sha256: str,
    report_type: str,
    received_at: datetime,
) -> None:
    """Invoke the completion-safe PDF processor after the immutable S3 write."""
    payload = {
        "source": "gmail-ingestor",
        "bucket": bucket,
        "key": s3_key,
        "messageId": message_id,
        "attachmentId": attachment_id,
        "contentSha256": content_sha256,
        "reportType": report_type,
        "receivedAt": received_at.isoformat(),
    }
    response = lambda_client.invoke(
        FunctionName=PDF_PROCESSOR_FUNCTION_NAME,
        InvocationType="Event",
        Payload=json.dumps(payload).encode("utf-8"),
    )
    if int(response.get("StatusCode", 0)) != 202:
        raise RuntimeError(
            f"PDF processor dispatch returned {response.get('StatusCode')!r}"
        )


def _materialization_attempt_count(item: Dict[str, Any]) -> int:
    if item.get("materializationAttemptVersion") != MATERIALIZED_DATA_VERSION:
        return 0
    if item.get("materializationAttemptCount") is None:
        return 1 if item.get("materializationStatus") else 0
    try:
        return max(0, int(item.get("materializationAttemptCount", 0)))
    except (TypeError, ValueError):
        return 0


def _retryable_materialization_error(
    error: Exception,
) -> RetryableResearchMaterializationError:
    if isinstance(error, RetryableResearchMaterializationError):
        return error
    wrapped = RetryableResearchMaterializationError(
        f"Research parse/materialization failed: {safe_error_detail(error)}"
    )
    typed_error_code = getattr(error, "error_code", None)
    if typed_error_code:
        wrapped.error_code = str(typed_error_code)
    return wrapped


def _materialization_failure_metadata(
    error: RetryableResearchMaterializationError,
    *,
    attempt_count: int,
) -> Dict[str, Any]:
    cause = error.__cause__ if isinstance(error.__cause__, Exception) else error
    return {
        "error": safe_error_detail(error),
        "errorCode": error.error_code,
        "retryable": True,
        "parseError": safe_error_detail(cause),
        "materializationAttemptVersion": MATERIALIZED_DATA_VERSION,
        "materializationAttemptCount": attempt_count,
        "materializationStatus": "ERROR",
    }


def backfill_html_snapshot(
    *,
    table: Any,
    message_id: str,
    attachment_id: str,
    report_type: str,
    mime_type: str,
    received_at: datetime,
    ledger_item: Optional[Dict[str, Any]] = None,
    replace_entity_projection: bool = False,
) -> bool:
    if attachment_id.startswith("message-body-") is False or mime_type != "text/html":
        return False

    item = ledger_item or table.get_item(
        Key={"messageId": message_id, "attachmentId": attachment_id}
    ).get("Item")
    if not item or not item.get("s3Bucket") or not item.get("s3Key"):
        return False
    if is_market_structure_webcast_subject(str(item.get("subject") or "")):
        return False
    is_investing_ideas_change = bool(
        re.search(r"\b\d+\s+Changes?:", str(item.get("subject") or ""), re.IGNORECASE)
    )
    if (
        item.get("snapshotType")
        and report_type not in {*RESEARCH_EVENT_SNAPSHOT_TYPES, "the-macro-show"}
        and not is_investing_ideas_change
    ):
        return False
    attempt_count = (
        _materialization_attempt_count(item) + 1
        if item.get("materializationAttemptVersion") == MATERIALIZED_DATA_VERSION
        else 1
    )

    snapshot: Optional[Dict[str, Any]] = None
    try:
        obj = s3.get_object(Bucket=item["s3Bucket"], Key=item["s3Key"])
        archived_body = obj["Body"].read()
        expected_sha256 = str(item.get("contentSha256") or "")
        if (
            not re.fullmatch(r"[0-9a-f]{64}", expected_sha256)
            or hashlib.sha256(archived_body).hexdigest() != expected_sha256
        ):
            raise ImmutableArtifactDriftError(
                "Archived Gmail HTML does not match its ledger content hash"
            )
        html_body = archived_body.decode("utf-8", errors="replace")
        snapshot = parse_html_snapshot(
            report_type=report_type,
            html_body=html_body,
            received_at=received_at,
            s3_key=item["s3Key"],
            message_id=message_id,
            subject=item.get("subject", ""),
            chart_archiver=(
                archive_market_structure_chart
                if report_type == "market-structure"
                else None
            ),
            textract_client=(
                textract if report_type in HTML_TEXTRACT_REPORT_TYPES else None
            ),
        )
        if not snapshot:
            if report_type in RESEARCH_EVENT_SNAPSHOT_TYPES:
                raise RetryableResearchMaterializationError(
                    f"Research parser returned no {report_type} snapshot"
                )
            mark_attachment(
                table,
                message_id=message_id,
                attachment_id=attachment_id,
                status="STORED",
                extra={
                    "error": None,
                    "errorCode": None,
                    "retryable": False,
                    "parseError": None,
                    "materializationAttemptVersion": MATERIALIZED_DATA_VERSION,
                    "materializationAttemptCount": attempt_count,
                    "materializationStatus": "NO_SNAPSHOT",
                },
            )
            return False
        event_count = persist_research_event_ledger(
            snapshot,
            dynamodb,
            content_sha256=item.get("contentSha256"),
        )
        entity_event_count = persist_snapshot_intelligence(
            snapshot,
            dynamodb,
            content_sha256=item.get("contentSha256"),
            finalize=False,
            replace_existing=replace_entity_projection,
        )
        materialized, _ = materialize_email_snapshot(snapshot, dynamodb)
        entity_projection_status = (
            "PARSED"
            if product_definition(snapshot["snapshotType"])
            .get("authorities", {})
            .get("trade")
            and entity_event_count == 0
            else "INDEXED"
        )
        if entity_projection_status == "INDEXED":
            finalize_snapshot_intelligence(
                snapshot,
                dynamodb,
                content_sha256=item.get("contentSha256"),
                event_count=entity_event_count,
            )
            source_product_id = str(
                item.get("snapshotType") or item.get("reportType") or ""
            )
            if (
                source_product_id in RESEARCH_EVENT_SNAPSHOT_TYPES
                and source_product_id != snapshot["snapshotType"]
            ):
                reclassify_manifest_artifact(
                    snapshot,
                    dynamodb,
                    source_product_id=source_product_id,
                    content_sha256=str(item.get("contentSha256") or ""),
                )
        materialization_extra = {
            "reportType": snapshot["reportType"],
            "snapshotType": snapshot["snapshotType"],
            "snapshotDate": snapshot["date"],
            "snapshotSource": snapshot["source"],
            "researchEventCount": event_count,
            "researchParserVersion": RESEARCH_PARSER_VERSION,
            "researchEntityEventCount": entity_event_count,
            "securityIntelligenceParserVersion": SECURITY_INTELLIGENCE_PARSER_VERSION,
            "error": None,
            "errorCode": None,
            "retryable": False,
            "parseError": None,
        }
        materialization_extra["materializationAttemptVersion"] = MATERIALIZED_DATA_VERSION
        materialization_extra["materializationAttemptCount"] = attempt_count
        materialization_extra["materializationStatus"] = entity_projection_status
        if materialized.get("dataVersion"):
            materialization_extra["materializedDataVersion"] = materialized["dataVersion"]
        if materialized.get("materializedAt"):
            materialization_extra["materializedAt"] = materialized["materializedAt"]
        mark_attachment(
            table,
            message_id=message_id,
            attachment_id=attachment_id,
            status="STORED" if entity_projection_status == "PARSED" else "INDEXED",
            extra=materialization_extra,
        )
        return True
    except Exception as parse_err:
        if snapshot or report_type in RESEARCH_EVENT_SNAPSHOT_TYPES:
            try:
                persist_snapshot_failure(
                    snapshot or _manifest_stub(
                        report_type=report_type,
                        received_at=received_at,
                        message_id=message_id,
                        s3_key=item.get("s3Key"),
                    ),
                    dynamodb,
                    content_sha256=item.get("contentSha256"),
                    error=parse_err,
                )
            except Exception:
                pass
        retryable_error = _retryable_materialization_error(parse_err)
        mark_attachment(
            table,
            message_id=message_id,
            attachment_id=attachment_id,
            status="ERROR",
            extra=_materialization_failure_metadata(
                retryable_error,
                attempt_count=attempt_count,
            ),
        )
        if retryable_error is parse_err:
            raise
        raise retryable_error from parse_err


def _should_backfill_materialized_snapshot(
    item: Dict[str, Any],
    *,
    allow_version_upgrade: bool = False,
) -> bool:
    status = str(item.get("status") or "")
    if status not in {"STORED", "DUPLICATE", "INDEXED"} and not (
        allow_version_upgrade and status in {"ERROR", "UNSUPPORTED"}
    ):
        return False
    if not str(item.get("attachmentId") or "").startswith("message-body-"):
        return False
    if str(item.get("mimeType") or "").lower() != "text/html":
        return False
    if not item.get("s3Bucket") or not item.get("s3Key"):
        return False

    report_type = str(item.get("snapshotType") or item.get("reportType") or "unknown")
    subject = str(item.get("subject") or "")
    if is_market_structure_webcast_subject(subject):
        return False
    if allow_version_upgrade:
        inferred_report_type = infer_report_type(
            str(item.get("filename") or ""),
            subject,
        )
        if inferred_report_type != "unknown":
            report_type = inferred_report_type
    is_materializable = report_type in RESEARCH_EVENT_SNAPSHOT_TYPES or bool(
        re.search(r"\b\d+\s+Changes?:", subject, re.IGNORECASE)
    )
    if not is_materializable:
        return False
    if item.get("materializationAttemptVersion") != MATERIALIZED_DATA_VERSION:
        # Parser-version migrations are explicit, metered repair work. A
        # scheduled poll must never turn a deployment into a historical replay.
        return allow_version_upgrade
    if allow_version_upgrade and (
        item.get("researchParserVersion") != RESEARCH_PARSER_VERSION
        or item.get("securityIntelligenceParserVersion")
        != SECURITY_INTELLIGENCE_PARSER_VERSION
    ):
        return True
    return (
        item.get("materializationStatus") == "ERROR"
        and _materialization_attempt_count(item) < MATERIALIZATION_MAX_ATTEMPTS
    )


def _manifest_stub(
    *,
    report_type: str,
    received_at: datetime,
    message_id: str,
    s3_key: Optional[str],
) -> Dict[str, Any]:
    return {
        "date": received_at.astimezone(timezone.utc).strftime("%Y-%m-%d"),
        "snapshotType": report_type or "unknown",
        "reportType": report_type or "unknown",
        "scrapedAt": received_at.astimezone(timezone.utc).isoformat(),
        "publishedAt": received_at.astimezone(timezone.utc).isoformat(),
        "gmailMessageId": message_id,
        "htmlSource": s3_key,
        "data": {},
    }


def upload_attachment(
    *,
    access_token: str,
    user_id: str,
    message_id: str,
    attachment: Dict[str, Any],
    headers: Dict[str, str],
    received_at: datetime,
    table: Any,
) -> Tuple[str, str]:
    attachment_id = attachment["attachmentId"]
    filename = attachment["filename"]
    subject = headers.get("subject", "")
    report_type = infer_report_type(filename, subject)
    mime_type = attachment["mimeType"]

    if not claim_attachment(
        table,
        message_id=message_id,
        attachment_id=attachment_id,
        headers=headers,
        filename=filename,
        mime_type=mime_type,
        report_type=report_type,
    ):
        if backfill_html_snapshot(
            table=table,
            message_id=message_id,
            attachment_id=attachment_id,
            report_type=report_type,
            mime_type=mime_type,
            received_at=received_at,
        ):
            return "stored", "snapshot-backfilled"
        return "skipped", "already-processed"

    content_sha256: Optional[str] = None
    textract_claimed = False
    textract_dispatched = False
    snapshot: Optional[Dict[str, Any]] = None
    try:
        if attachment.get("inlineData"):
            content = decode_base64url(attachment["inlineData"])
        else:
            content = get_attachment_data(access_token, user_id, message_id, attachment_id)

        content_sha256 = hashlib.sha256(content).hexdigest()
        is_pdf = (
            PurePosixPath(filename).suffix.lower() == ".pdf"
            or str(mime_type).lower() == "application/pdf"
        )
        key_filename = filename
        if is_pdf:
            filename_suffix = PurePosixPath(filename).suffix
            filename_stem = filename[: -len(filename_suffix)] if filename_suffix else filename
            key_filename = f"{filename_stem}.pdf"
        s3_key = build_s3_key(
            report_type=report_type,
            received_at=received_at,
            message_id=message_id,
            attachment_id=attachment_id,
            filename=key_filename,
        )

        if is_pdf:
            textract_claimed, existing_content = claim_textract_content(
                table,
                content_sha256=content_sha256,
                report_type=report_type,
                message_id=message_id,
                attachment_id=attachment_id,
                s3_key=s3_key,
            )
            if not textract_claimed:
                duplicate_extra = {
                    "contentSha256": content_sha256,
                    "byteSize": len(content),
                    "receivedAt": received_at.isoformat(),
                    "textractDeduplicated": True,
                }
                if existing_content:
                    duplicate_extra.update(
                        {
                            "s3Bucket": existing_content.get("s3Bucket"),
                            "s3Key": existing_content.get("s3Key"),
                            "duplicateOfMessageId": existing_content.get("sourceMessageId"),
                            "duplicateOfAttachmentId": existing_content.get("sourceAttachmentId"),
                            "textractContentStatus": existing_content.get("status"),
                        }
                    )
                mark_attachment(
                    table,
                    message_id=message_id,
                    attachment_id=attachment_id,
                    status="DUPLICATE",
                    extra=duplicate_extra,
                )
                return "skipped", "duplicate-pdf-content"

        metadata = {
            "source": "gmail",
            "gmail-message-id": message_id[:120],
            "gmail-attachment-id": attachment_id[:120],
            "report-type": report_type[:120],
            "content-sha256": content_sha256,
        }
        artifact_created = put_immutable_s3_object(
            bucket=S3_BUCKET,
            key=s3_key,
            body=content,
            content_type=mime_type,
            metadata=metadata,
            content_sha256=content_sha256,
        )
        if is_pdf:
            dispatch_pdf_processor(
                bucket=S3_BUCKET,
                s3_key=s3_key,
                message_id=message_id,
                attachment_id=attachment_id,
                content_sha256=content_sha256,
                report_type=report_type,
                received_at=received_at,
            )
            mark_textract_content(
                table,
                content_sha256=content_sha256,
                status="TEXTRACT_DISPATCHED",
                extra={"dispatchedAt": utc_now().isoformat()},
            )
            textract_dispatched = True
        extra = {
            "s3Bucket": S3_BUCKET,
            "s3Key": s3_key,
            "contentSha256": content_sha256,
            "byteSize": len(content),
            "receivedAt": received_at.isoformat(),
            "s3ArtifactCreated": artifact_created,
        }
        # Commit immutable artifact provenance before parsing or projection.
        # A later materialization failure updates this row in place and must
        # never erase the evidence needed for a deterministic retry.
        mark_attachment(
            table,
            message_id=message_id,
            attachment_id=attachment_id,
            status="IN_PROGRESS",
            extra=extra,
        )

        if attachment_id.startswith("message-body-") and mime_type == "text/html":
            try:
                html_body = content.decode("utf-8", errors="replace")
                snapshot = parse_html_snapshot(
                    report_type=report_type,
                    html_body=html_body,
                    received_at=received_at,
                    s3_key=s3_key,
                    message_id=message_id,
                    subject=subject,
                    chart_archiver=(
                        archive_market_structure_chart
                        if report_type == "market-structure"
                        else None
                    ),
                    textract_client=(
                        textract if report_type in HTML_TEXTRACT_REPORT_TYPES else None
                    ),
                )
                if snapshot:
                    event_count = persist_research_event_ledger(
                        snapshot,
                        dynamodb,
                        content_sha256=content_sha256,
                    )
                    entity_event_count = persist_snapshot_intelligence(
                        snapshot,
                        dynamodb,
                        content_sha256=content_sha256,
                        finalize=False,
                    )
                    materialized, _ = materialize_email_snapshot(snapshot, dynamodb)
                    entity_projection_status = (
                        "PARSED"
                        if product_definition(snapshot["snapshotType"])
                        .get("authorities", {})
                        .get("trade")
                        and entity_event_count == 0
                        else "INDEXED"
                    )
                    if entity_projection_status == "INDEXED":
                        finalize_snapshot_intelligence(
                            snapshot,
                            dynamodb,
                            content_sha256=content_sha256,
                            event_count=entity_event_count,
                        )
                    extra["snapshotType"] = snapshot["snapshotType"]
                    extra["snapshotDate"] = snapshot["date"]
                    extra["snapshotSource"] = snapshot["source"]
                    extra["researchEventCount"] = event_count
                    extra["researchParserVersion"] = RESEARCH_PARSER_VERSION
                    extra["researchEntityEventCount"] = entity_event_count
                    extra["securityIntelligenceParserVersion"] = (
                        SECURITY_INTELLIGENCE_PARSER_VERSION
                    )
                    if materialized.get("dataVersion"):
                        extra["materializedDataVersion"] = materialized["dataVersion"]
                    if materialized.get("materializedAt"):
                        extra["materializedAt"] = materialized["materializedAt"]
                    extra["materializationAttemptVersion"] = MATERIALIZED_DATA_VERSION
                    extra["materializationAttemptCount"] = 1
                    extra["materializationStatus"] = entity_projection_status
                elif report_type == "unknown":
                    unsupported = RetryableResearchMaterializationError(
                        "Received Hedgeye product is not registered or parseable"
                    )
                    persist_snapshot_failure(
                        _manifest_stub(
                            report_type=report_type,
                            received_at=received_at,
                            message_id=message_id,
                            s3_key=s3_key,
                        ),
                        dynamodb,
                        content_sha256=content_sha256,
                        error=unsupported,
                    )
                    extra.update(
                        {
                            "materializationAttemptVersion": MATERIALIZED_DATA_VERSION,
                            "materializationAttemptCount": 1,
                            "materializationStatus": "ERROR",
                            "parseError": str(unsupported),
                            "errorCode": "RESEARCH_PRODUCT_UNSUPPORTED",
                            "retryable": False,
                        }
                    )
                elif report_type in RESEARCH_EVENT_SNAPSHOT_TYPES:
                    raise RetryableResearchMaterializationError(
                        f"Research parser returned no {report_type} snapshot"
                    )
                elif re.search(r"\b\d+\s+Changes?:", subject, re.IGNORECASE):
                    extra["materializationAttemptVersion"] = MATERIALIZED_DATA_VERSION
                    extra["materializationAttemptCount"] = 1
                    extra["materializationStatus"] = "NO_SNAPSHOT"
            except Exception as parse_err:
                retryable_error = _retryable_materialization_error(parse_err)
                if retryable_error is parse_err:
                    raise
                raise retryable_error from parse_err

        mark_attachment(
            table,
            message_id=message_id,
            attachment_id=attachment_id,
            status="TEXTRACT_DISPATCHED" if is_pdf else (
                (
                    "INDEXED"
                    if extra.get("materializationStatus") == "INDEXED"
                    else "STORED"
                ) if snapshot else (
                    "UNSUPPORTED" if report_type == "unknown" else "STORED"
                )
            ),
            extra=extra,
        )
        return "stored", s3_key
    except Exception as err:
        if snapshot or (
            str(attachment_id).startswith("message-body-")
            and str(mime_type).lower() == "text/html"
        ):
            try:
                persist_snapshot_failure(
                    snapshot or _manifest_stub(
                        report_type=report_type,
                        received_at=received_at,
                        message_id=message_id,
                        s3_key=locals().get("s3_key"),
                    ),
                    dynamodb,
                    content_sha256=content_sha256,
                    error=err,
                )
            except Exception:
                pass
        if content_sha256 and textract_claimed and not textract_dispatched:
            mark_textract_content(
                table,
                content_sha256=content_sha256,
                status="TEXTRACT_ERROR",
                extra={"error": str(err)[:1000]},
            )
        failure_extra = {
            "error": safe_error_detail(err),
            "errorCode": classify_runtime_error(err),
            "retryable": bool(getattr(err, "retryable", False)),
        }
        if isinstance(err, RetryableResearchMaterializationError):
            failure_extra.update(
                _materialization_failure_metadata(err, attempt_count=1)
            )
        mark_attachment(
            table,
            message_id=message_id,
            attachment_id=attachment_id,
            status="ERROR",
            extra=failure_extra,
        )
        raise


def process_message(
    access_token: str,
    user_id: str,
    message_id: str,
    table: Any,
    *,
    allow_version_backfill: bool = False,
    budget_check: Optional[Callable[[], Optional[str]]] = None,
) -> Dict[str, Any]:
    def require_work_budget() -> None:
        reason = budget_check() if budget_check else None
        if reason:
            raise GmailInvocationBudgetYield(reason)

    require_work_budget()
    ledger_items = get_message_ledger_items(table, message_id)
    if allow_version_backfill:
        attachment_items = [
            item
            for item in ledger_items
            if item.get("attachmentId") != MESSAGE_LEDGER_ATTACHMENT_ID
        ]
        representative = next(iter(attachment_items or ledger_items), {})
        result = {
            "messageId": message_id,
            "subject": representative.get("subject", ""),
            "sender": representative.get("sender", ""),
            "attachmentCount": len(attachment_items),
            "stored": [],
            "skipped": [],
        }
        for item in attachment_items:
            require_work_budget()
            filename = str(item.get("filename") or "")
            if not _should_backfill_materialized_snapshot(
                item,
                allow_version_upgrade=True,
            ):
                result["skipped"].append(
                    {"filename": filename, "detail": "not-version-replay-eligible"}
                )
                continue
            report_type = str(item.get("reportType") or "unknown")
            inferred_report_type = infer_report_type(
                filename,
                str(item.get("subject") or ""),
            )
            if inferred_report_type != "unknown":
                report_type = inferred_report_type
            backfilled = backfill_html_snapshot(
                table=table,
                message_id=message_id,
                attachment_id=str(item["attachmentId"]),
                report_type=report_type,
                mime_type=str(item.get("mimeType") or ""),
                received_at=_parse_ledger_datetime(item),
                ledger_item=item,
                replace_entity_projection=True,
            )
            if backfilled:
                result["stored"].append(
                    {"filename": filename, "detail": "snapshot-backfilled"}
                )

        if not result["stored"]:
            raise GmailOperatorReplayError(
                "Operator replay found no version-eligible immutable artifact"
            )
        refreshed_items = get_message_ledger_items(table, message_id)
        if attachment_records_are_terminal(refreshed_items):
            mark_message_processed(
                table,
                message_id=message_id,
                headers={
                    "subject": representative.get("subject", ""),
                    "from": representative.get("sender", ""),
                },
                attachment_count=len(attachment_items),
            )
        return result

    if message_is_fully_processed(ledger_items):
        attachment_items = [
            item
            for item in ledger_items
            if item.get("attachmentId") != MESSAGE_LEDGER_ATTACHMENT_ID
        ]
        representative = next(iter(attachment_items or ledger_items), {})
        result = {
            "messageId": message_id,
            "subject": representative.get("subject", ""),
            "sender": representative.get("sender", ""),
            "attachmentCount": len(attachment_items),
            "stored": [],
            "skipped": [],
        }

        ignored_sentinel = next(
            (
                item
                for item in ledger_items
                if item.get("attachmentId") == MESSAGE_LEDGER_ATTACHMENT_ID
                and item.get("status") == "MESSAGE_IGNORED"
            ),
            None,
        )
        if ignored_sentinel:
            result["ignored"] = True
            result["skipped"].append(
                {
                    "filename": "",
                    "detail": str(
                        ignored_sentinel.get("ignoredReason")
                        or "metadata-only-ignore"
                    ),
                }
            )

        for item in attachment_items:
            require_work_budget()
            filename = item.get("filename", "")
            if _should_backfill_materialized_snapshot(
                item,
                allow_version_upgrade=allow_version_backfill,
            ):
                report_type = str(item.get("reportType") or "unknown")
                if allow_version_backfill:
                    inferred_report_type = infer_report_type(
                        filename,
                        str(item.get("subject") or ""),
                    )
                    if inferred_report_type != "unknown":
                        report_type = inferred_report_type
                backfilled = backfill_html_snapshot(
                    table=table,
                    message_id=message_id,
                    attachment_id=item["attachmentId"],
                    report_type=report_type,
                    mime_type=item.get("mimeType", ""),
                    received_at=_parse_ledger_datetime(item),
                    ledger_item=item,
                    replace_entity_projection=allow_version_backfill,
                )
                if backfilled:
                    result["stored"].append(
                        {"filename": filename, "detail": "snapshot-backfilled"}
                    )
                    continue
            result["skipped"].append(
                {"filename": filename, "detail": "already-processed"}
            )

        if not any(
            item.get("attachmentId") == MESSAGE_LEDGER_ATTACHMENT_ID
            for item in ledger_items
        ):
            mark_message_processed(
                table,
                message_id=message_id,
                headers={
                    "subject": representative.get("subject", ""),
                    "from": representative.get("sender", ""),
                },
                attachment_count=len(attachment_items),
            )
        return result

    require_work_budget()
    metadata = get_message_metadata(access_token, user_id, message_id)
    metadata_headers = get_headers(metadata)
    if is_market_structure_webcast_subject(metadata_headers.get("subject", "")):
        mark_message_ignored(
            table,
            message_id=message_id,
            headers=metadata_headers,
            reason="market-structure-webcast",
        )
        return {
            "messageId": message_id,
            "subject": metadata_headers.get("subject", ""),
            "sender": metadata_headers.get("from", ""),
            "attachmentCount": 0,
            "stored": [],
            "skipped": [
                {"filename": "", "detail": "market-structure-webcast"}
            ],
            "ignored": True,
        }

    require_work_budget()
    message = get_message(access_token, user_id, message_id)
    headers = get_headers(message)
    received_at = parse_received_date(headers, message.get("internalDate"))
    attachments = extract_attachments(message)
    body_artifact = extract_message_body_artifact(message)
    if body_artifact and body_artifact.get("attachmentId") not in {
        attachment.get("attachmentId") for attachment in attachments
    }:
        attachments.append(body_artifact)

    result = {
        "messageId": message_id,
        "subject": headers.get("subject", ""),
        "sender": headers.get("from", ""),
        "attachmentCount": len(attachments),
        "stored": [],
        "skipped": [],
    }

    for attachment in attachments:
        require_work_budget()
        status, detail = upload_attachment(
            access_token=access_token,
            user_id=user_id,
            message_id=message_id,
            attachment=attachment,
            headers=headers,
            received_at=received_at,
            table=table,
        )
        result[status].append({"filename": attachment["filename"], "detail": detail})

    if not attachments or attachment_records_are_terminal(
        get_message_ledger_items(table, message_id)
    ):
        mark_message_processed(
            table,
            message_id=message_id,
            headers=headers,
            attachment_count=len(attachments),
        )
    return result


def prepare_build_recovery(
    state: Dict[str, Any],
    *,
    build_version: str,
    attempted_at: str,
    limit: int = 1,
) -> Tuple[List[str], List[Dict[str, Any]]]:
    """Select each quarantined Risk Range message at most once per build."""
    selected: List[str] = []
    updated: List[Dict[str, Any]] = []
    for raw_item in state.get("quarantinedMessages") or []:
        if not isinstance(raw_item, dict):
            continue
        item = dict(raw_item)
        message_id = str(item.get("messageId") or "")
        eligible = (
            message_id
            and item.get("errorCode") in RISK_RANGE_BUILD_RECOVERY_ERROR_CODES
            and item.get("recoveryBuildVersion") != build_version
            and len(selected) < max(0, limit)
        )
        if eligible:
            selected.append(message_id)
            item["recoveryBuildVersion"] = build_version
            item["recoveryAttemptedAt"] = attempted_at
        updated.append(item)
    return selected, updated


def operator_replay_message_ids(event: Dict[str, Any]) -> List[str]:
    """Validate the narrow immutable-artifact version replay event."""
    allowed_keys = {
        "source",
        "messageIds",
        "forceBackfill",
        "materializationVersion",
    }
    if set(event) != allowed_keys:
        raise GmailOperatorReplayError("Operator replay event fields are invalid")
    if event.get("source") != OPERATOR_REPLAY_SOURCE:
        raise GmailOperatorReplayError("Operator replay source is invalid")
    if event.get("forceBackfill") is not True:
        raise GmailOperatorReplayError("Operator replay requires forceBackfill=true")
    if event.get("materializationVersion") != MATERIALIZED_DATA_VERSION:
        raise GmailOperatorReplayError("Operator replay materialization version is invalid")
    raw_message_ids = event.get("messageIds")
    if not isinstance(raw_message_ids, list):
        raise GmailOperatorReplayError("Operator replay message IDs must be a list")
    message_ids = [str(value) for value in raw_message_ids]
    if (
        not message_ids
        or len(message_ids) > OPERATOR_REPLAY_MAX_MESSAGES
        or len(set(message_ids)) != len(message_ids)
        or any(not re.fullmatch(r"[0-9a-f]{16,32}", value) for value in message_ids)
    ):
        raise GmailOperatorReplayError("Operator replay message IDs are invalid")
    return message_ids


def lambda_handler(event: Optional[Dict[str, Any]], context: Any) -> Dict[str, Any]:
    """Poll Gmail with cursoring, auth circuit-breaking, and an unconditional heartbeat."""
    monotonic_started_at = time.monotonic()
    event = event or {}
    trigger_source = str(event.get("source") or "manual").strip()
    schedule_id = str(event.get("scheduleId") or "").strip() or None
    started_at = utc_now().isoformat()
    table = dynamodb.Table(LEDGER_TABLE)
    secret: Dict[str, Any] = {}
    secret_version = "unknown"
    auth_probe_only = event.get("authProbeOnly") is True
    force_auth_probe_requested = event.get("forceAuthProbe") is True
    forced_auth_probe = auth_probe_only and force_auth_probe_requested

    def heartbeat_response(
        *,
        status_code: int,
        body: Dict[str, Any],
        heartbeat_status: str,
        error_code: Optional[str] = None,
        detail: Optional[str] = None,
        heartbeat_secret_version: Optional[str] = None,
        counts: Optional[Dict[str, int]] = None,
    ) -> Dict[str, Any]:
        """Return only after proving the typed heartbeat was persisted."""
        heartbeat_written = write_service_heartbeat(
            started_at=started_at,
            status=heartbeat_status,
            trigger_source=trigger_source,
            schedule_id=schedule_id,
            error_code=error_code,
            detail=detail,
            secret_version=heartbeat_secret_version,
            counts=counts,
        )
        response_body = dict(body)
        if not heartbeat_written:
            status_code = 503
            response_body.update({
                "status": "ERROR",
                "errorCode": "GMAIL_HEARTBEAT_WRITE_FAILED",
                "errorCount": max(1, int(response_body.get("errorCount") or 0)),
            })
        return {
            "statusCode": status_code,
            "body": json.dumps(response_body),
        }

    operator_replay_requested = trigger_source == OPERATOR_REPLAY_SOURCE
    operator_replay_ids: List[str] = []
    if operator_replay_requested:
        try:
            operator_replay_ids = operator_replay_message_ids(event)
        except GmailOperatorReplayError as err:
            return heartbeat_response(
                status_code=400,
                body={
                    "status": "ERROR",
                    "errorCode": err.error_code,
                    "pollMode": "rejected",
                    "messageCount": 0,
                    "errorCount": 1,
                },
                heartbeat_status="error",
                error_code=err.error_code,
                detail=safe_error_detail(err),
            )
    elif event.get("materializationVersion") is not None:
        return heartbeat_response(
            status_code=400,
            body={
                "status": "ERROR",
                "errorCode": GmailOperatorReplayError.error_code,
                "pollMode": "rejected",
                "messageCount": 0,
                "errorCount": 1,
            },
            heartbeat_status="error",
            error_code=GmailOperatorReplayError.error_code,
            detail="Materialization version replay requires the operator replay contract.",
        )

    if trigger_source == "aws-scheduler" and schedule_id != GMAIL_SCHEDULE_ID:
        return heartbeat_response(
            status_code=400,
            body={
                "status": "ERROR",
                "errorCode": "GMAIL_SCHEDULE_ID_MISMATCH",
                "pollMode": "rejected",
                "messageCount": 0,
                "errorCount": 1,
            },
            heartbeat_status="error",
            error_code="GMAIL_SCHEDULE_ID_MISMATCH",
            detail="Invocation did not identify the configured Gmail Scheduler job.",
        )

    if trigger_source == "aws-scheduler" and event.get("forceBackfill") is True:
        return heartbeat_response(
            status_code=400,
            body={
                "status": "ERROR",
                "errorCode": GmailOperatorReplayError.error_code,
                "pollMode": "rejected",
                "messageCount": 0,
                "errorCount": 1,
            },
            heartbeat_status="error",
            error_code=GmailOperatorReplayError.error_code,
            detail="Scheduled Gmail invocations cannot request force backfill.",
        )

    # The force flag is privileged because it bypasses an open auth circuit.
    # Accept it only as part of the bounded profile-only probe; never let an
    # unpaired force flag turn into a full mailbox poll.
    if force_auth_probe_requested and not auth_probe_only:
        return heartbeat_response(
            status_code=400,
            body={
                "status": "ERROR",
                "errorCode": "GMAIL_AUTH_PROBE_EVENT_INVALID",
                "pollMode": "rejected",
                "messageCount": 0,
                "errorCount": 1,
            },
            heartbeat_status="error",
            error_code="GMAIL_AUTH_PROBE_EVENT_INVALID",
            detail="forceAuthProbe requires authProbeOnly=true.",
        )

    try:
        secret = (
            load_oauth_secret(force_refresh=True)
            if forced_auth_probe
            else load_oauth_secret()
        )
        secret_version = str(secret.get("_secret_version") or "unknown")
    except Exception as err:
        error_code = classify_runtime_error(err)
        return heartbeat_response(
            status_code=503,
            body={
                "status": "ERROR",
                "errorCode": error_code,
                "pollMode": "secret_unavailable",
                "messageCount": 0,
                "errorCount": 1,
            },
            heartbeat_status="error",
            error_code=error_code,
            detail=safe_error_detail(err),
        )

    user_id = event.get("userId") or secret.get("user_id") or os.environ.get("GMAIL_USER_ID", "me")
    # A forced activation probe validates OAuth/Gmail without depending on or
    # mutating the ingestion cursor. Normal polls still require the ledger
    # state before deciding whether the auth circuit is open.
    try:
        state = (
            {}
            if forced_auth_probe
            else read_ingestion_state(table)
        )
    except Exception as err:
        error_code = classify_runtime_error(err)
        return heartbeat_response(
            status_code=503,
            body={
                "status": "ERROR",
                "errorCode": error_code,
                "pollMode": "state_unavailable",
                "messageCount": 0,
                "errorCount": 1,
            },
            heartbeat_status="error",
            error_code=error_code,
            detail=safe_error_detail(err),
            heartbeat_secret_version=secret_version,
        )
    # While auth is blocked, do not call Google, but do check Secrets Manager on
    # every scheduled invocation. A long-lived warm-runtime cache must not delay
    # recovery for hours after an operator atomically promotes a new version.
    if (
        state.get("status") == "AUTH_REQUIRED"
        and state.get("blockedSecretVersion") == secret_version
        and not forced_auth_probe
    ):
        try:
            secret = load_oauth_secret(force_refresh=True)
            secret_version = str(secret.get("_secret_version") or "unknown")
            user_id = (
                event.get("userId")
                or secret.get("user_id")
                or os.environ.get("GMAIL_USER_ID", "me")
            )
        except Exception as err:
            error_code = classify_runtime_error(err)
            return heartbeat_response(
                status_code=503,
                body={
                    "status": "ERROR",
                    "errorCode": error_code,
                    "pollMode": "secret_unavailable",
                    "messageCount": 0,
                    "errorCount": 1,
                },
                heartbeat_status="error",
                error_code=error_code,
                detail=safe_error_detail(err),
                heartbeat_secret_version=secret_version,
            )
    auth_blocked = (
        state.get("status") == "AUTH_REQUIRED"
        and state.get("blockedSecretVersion") == secret_version
        and not forced_auth_probe
    )
    if auth_blocked:
        return heartbeat_response(
            status_code=200,
            body={
                "status": "AUTH_REQUIRED",
                "errorCode": "GMAIL_AUTH_REQUIRED",
                "messageCount": 0,
            },
            heartbeat_status="auth_required",
            error_code="GMAIL_AUTH_REQUIRED",
            detail="OAuth authorization is blocked until the Secrets Manager version changes.",
            heartbeat_secret_version=secret_version,
        )

    scheduled_invocation = (
        trigger_source == "aws-scheduler"
        and schedule_id == GMAIL_SCHEDULE_ID
    )
    if (
        scheduled_invocation
        and state.get("activeBatchId")
        and state.get("pendingPollMode") == "operator_replay"
    ):
        return heartbeat_response(
            status_code=409,
            body={
                "status": "ERROR",
                "errorCode": "GMAIL_OPERATOR_REPLAY_REQUIRES_OPERATOR",
                "pollMode": "operator_replay",
                "messageCount": 0,
                "errorCount": 1,
            },
            heartbeat_status="error",
            error_code="GMAIL_OPERATOR_REPLAY_REQUIRES_OPERATOR",
            detail="An operator replay batch cannot be resumed by Scheduler.",
            heartbeat_secret_version=secret_version,
        )
    if (
        scheduled_invocation
        and state.get("errorCode") == "GMAIL_HISTORY_CURSOR_EXPIRED"
        and event.get("forceBackfill") is not True
    ):
        return heartbeat_response(
            status_code=409,
            body={
                "status": "ERROR",
                "errorCode": "GMAIL_HISTORY_CURSOR_EXPIRED",
                "pollMode": "cursor_reset_required",
                "historyId": state.get("historyId"),
                "messageCount": 0,
                "errorCount": 1,
            },
            heartbeat_status="error",
            error_code="GMAIL_HISTORY_CURSOR_EXPIRED",
            detail=(
                "The Gmail history cursor expired. A bounded operator-approved "
                "recovery is required; scheduled full-mailbox replay is disabled."
            ),
            heartbeat_secret_version=secret_version,
        )

    def budget_yield_response(
        reason: str,
        *,
        poll_mode: Optional[str] = None,
        discovered: int = 0,
        remaining: int = 0,
    ) -> Dict[str, Any]:
        effective_mode = poll_mode or str(
            state.get("discoveryMode")
            or state.get("pendingPollMode")
            or "pending"
        )
        counts = {
            "messages": 0,
            "stored": 0,
            "skipped": 0,
            "errors": 0,
            "dropped": int(state.get("quarantinedCount") or 0),
            "remaining": remaining,
        }
        if not forced_auth_probe:
            try:
                write_ingestion_state(
                    table,
                    status="IN_PROGRESS",
                    historyId=state.get("historyId"),
                    errorCode=reason,
                    errorDetail=(
                        "Invocation yielded before another potentially "
                        "30-second Gmail call."
                    ),
                    counts=counts,
                )
            except Exception as err:
                error_code = classify_runtime_error(err)
                return heartbeat_response(
                    status_code=503,
                    body={
                        "status": "ERROR",
                        "errorCode": error_code,
                        "pollMode": effective_mode,
                        "messageCount": 0,
                        "errorCount": 1,
                    },
                    heartbeat_status="error",
                    error_code=error_code,
                    detail=safe_error_detail(err),
                    heartbeat_secret_version=secret_version,
                    counts={**counts, "errors": 1},
                )
        return heartbeat_response(
            status_code=200,
            body={
                "status": "IN_PROGRESS",
                "errorCode": reason,
                "pollMode": effective_mode,
                "historyId": state.get("historyId"),
                "messageCount": 0,
                "discoveredCount": discovered,
                "remainingCount": remaining,
                "storedCount": 0,
                "skippedCount": 0,
                "errorCount": 0,
            },
            heartbeat_status="in_progress",
            error_code=reason,
            detail="Invocation yielded before another potentially 30-second Gmail call.",
            heartbeat_secret_version=secret_version,
            counts=counts,
        )

    initial_call_budget = gmail_call_budget_reason(
        context,
        monotonic_started_at=monotonic_started_at,
    )
    if initial_call_budget:
        return budget_yield_response(initial_call_budget)

    try:
        access_token = refresh_access_token(secret)
    except Exception:
        # Reload once so a rotation is immediately visible to a warm runtime.
        clear_oauth_secret_cache()
        try:
            secret = load_oauth_secret(force_refresh=True)
            secret_version = str(secret.get("_secret_version") or "unknown")
            user_id = event.get("userId") or secret.get("user_id") or os.environ.get("GMAIL_USER_ID", "me")
            retry_budget = gmail_call_budget_reason(
                context,
                monotonic_started_at=monotonic_started_at,
            )
            if retry_budget:
                return budget_yield_response(retry_budget)
            access_token = refresh_access_token(secret)
        except Exception as err:
            error_code = classify_runtime_error(err)
            if error_code in {"GMAIL_AUTH_REQUIRED", "GMAIL_OAUTH_CLIENT_DISABLED"}:
                try:
                    write_ingestion_state(
                        table,
                        status="AUTH_REQUIRED",
                        blockedSecretVersion=secret_version,
                        errorCode=error_code,
                        errorDetail=safe_error_detail(err),
                    )
                except Exception as state_err:
                    print(f"[gmail] auth state write unavailable: {type(state_err).__name__}")
                return heartbeat_response(
                    status_code=200,
                    body={
                        "status": "AUTH_REQUIRED",
                        "errorCode": error_code,
                        "messageCount": 0,
                    },
                    heartbeat_status="auth_required",
                    error_code=error_code,
                    detail=safe_error_detail(err),
                    heartbeat_secret_version=secret_version,
                )
            return heartbeat_response(
                status_code=503,
                body={
                    "status": "ERROR",
                    "errorCode": error_code,
                    "pollMode": "auth",
                    "messageCount": 0,
                    "errorCount": 1,
                },
                heartbeat_status="error",
                error_code=error_code,
                detail=safe_error_detail(err),
                heartbeat_secret_version=secret_version,
            )

    # Bind every successful invocation to the configured mailbox before any
    # listing or message processing. The same verified profile historyId is
    # committed only after all work succeeds, preserving fail-closed cursoring.
    profile_budget = gmail_call_budget_reason(
        context,
        monotonic_started_at=monotonic_started_at,
    )
    if profile_budget:
        return budget_yield_response(profile_budget)
    try:
        profile_history_id = get_profile_history_id(access_token, user_id)
    except Exception as err:
        error_code = classify_runtime_error(err)
        return heartbeat_response(
            status_code=503,
            body={
                "status": "ERROR",
                "errorCode": error_code,
                "pollMode": "auth_probe" if auth_probe_only else "profile",
                "messageCount": 0,
                "errorCount": 1,
            },
            heartbeat_status="error",
            error_code=error_code,
            detail=safe_error_detail(err),
            heartbeat_secret_version=secret_version,
        )

    if auth_probe_only:
        # Activation can validate the refresh grant and readonly Gmail API
        # access without listing messages, advancing the history cursor, or
        # materializing any research data. This remains a manual heartbeat and
        # can never satisfy the scheduled-poller rollout gate.

        return heartbeat_response(
            status_code=200,
            body={
                "status": "SUCCESS",
                "pollMode": "auth_probe",
                "messageCount": 0,
                "storedCount": 0,
                "skippedCount": 0,
                "errorCount": 0,
            },
            heartbeat_status="success",
            heartbeat_secret_version=secret_version,
            counts={"messages": 0, "stored": 0, "skipped": 0, "errors": 0, "dropped": 0},
        )

    def queue_failure_response(error: Exception, poll_mode: str) -> Dict[str, Any]:
        error_code = classify_runtime_error(error)
        return heartbeat_response(
            status_code=503,
            body={
                "status": "ERROR",
                "errorCode": error_code,
                "pollMode": poll_mode,
                "messageCount": 0,
                "storedCount": 0,
                "skippedCount": 0,
                "errorCount": 1,
                "errors": [{
                    "messageId": None,
                    "error": safe_error_detail(error),
                    "errorCode": error_code,
                    "retryable": True,
                }],
            },
            heartbeat_status="error",
            error_code=error_code,
            detail=safe_error_detail(error),
            heartbeat_secret_version=secret_version,
            counts={"messages": 0, "stored": 0, "skipped": 0, "errors": 1, "dropped": 0},
        )

    cursor_before = state.get("historyId")
    active_batch_id = str(state.get("activeBatchId") or "")
    pending_history_id = state.get("pendingHistoryId")
    pending_force_backfill = bool(state.get("pendingForceBackfill"))
    poll_mode = str(state.get("pendingPollMode") or "query")
    discovered_count = int(state.get("pendingDiscoveredCount") or 0)
    discovery_status = str(state.get("discoveryStatus") or "")
    discovery_in_progress = discovery_status == "IN_PROGRESS"
    explicit_message_ids = list(dict.fromkeys(
        str(message_id)
        for message_id in (event.get("messageIds") or [])
        if str(message_id)
    ))
    build_recovery_message_ids: List[str] = []
    if (
        scheduled_invocation
        and not active_batch_id
        and not explicit_message_ids
    ):
        recovery_attempted_at = utc_now().isoformat()
        (
            build_recovery_message_ids,
            _updated_quarantines,
        ) = prepare_build_recovery(
            state,
            build_version=BUILD_VERSION,
            attempted_at=recovery_attempted_at,
        )
        if build_recovery_message_ids:
            explicit_message_ids = build_recovery_message_ids

    if (
        scheduled_invocation
        and not cursor_before
        and not active_batch_id
        and not explicit_message_ids
        and event.get("forceBackfill") is not True
    ):
        bootstrap_counts = {
            "messages": 0,
            "stored": 0,
            "skipped": 0,
            "errors": 0,
            "dropped": int(state.get("quarantinedCount") or 0),
            "remaining": 0,
        }
        try:
            write_ingestion_state(
                table,
                status="READY",
                historyId=profile_history_id,
                activeBatchId=None,
                pendingHistoryId=None,
                pendingPollMode=None,
                pendingForceBackfill=False,
                pendingDiscoveredCount=0,
                discoveryStatus=None,
                discoveryBatchId=None,
                discoveryCursorBefore=None,
                discoveryTargetHistoryId=None,
                discoveryPageToken=None,
                discoveryNextSequence=None,
                discoveryMode=None,
                discoveryLabelId=None,
                pendingSince=None,
                lastProgressAt=utc_now().isoformat(),
                lastSuccessAt=utc_now().isoformat(),
                pollMode="cursor_bootstrap",
                blockedSecretVersion=None,
                errorCode=None,
                errorDetail=None,
                counts=bootstrap_counts,
            )
        except Exception as err:
            return queue_failure_response(err, "cursor_bootstrap")
        return heartbeat_response(
            status_code=200,
            body={
                "status": "SUCCESS",
                "pollMode": "cursor_bootstrap",
                "historyId": profile_history_id,
                "messageCount": 0,
                "discoveredCount": 0,
                "remainingCount": 0,
                "storedCount": 0,
                "skippedCount": 0,
                "errorCount": 0,
            },
            heartbeat_status="success",
            heartbeat_secret_version=secret_version,
            counts=bootstrap_counts,
        )

    if not active_batch_id:
        pending_force_backfill = event.get("forceBackfill") is True
        pending_history_id = (
            None if explicit_message_ids else profile_history_id
        )
        label_id = None
        if explicit_message_ids:
            poll_mode = (
                "operator_replay"
                if operator_replay_requested
                else (
                    "build_recovery:"
                    + hashlib.sha256(BUILD_VERSION.encode("utf-8")).hexdigest()[:12]
                    if build_recovery_message_ids
                    else "explicit"
                )
            )
        elif cursor_before and not pending_force_backfill:
            label_budget = gmail_call_budget_reason(
                context,
                monotonic_started_at=monotonic_started_at,
            )
            if label_budget:
                return budget_yield_response(label_budget, poll_mode="history")
            try:
                label_id = resolve_label_id(access_token, user_id)
            except Exception as err:
                return queue_failure_response(err, "history")
            poll_mode = "history" if label_id else "query"
        else:
            poll_mode = "query"

        active_batch_id = _queue_batch_id(
            (),
            cursor_before=(
                str(cursor_before) if cursor_before is not None else None
            ),
            pending_history_id=(
                str(pending_history_id)
                if pending_history_id is not None
                else None
            ),
            poll_mode=poll_mode,
            force_backfill=pending_force_backfill,
        )
        pending_started_at = utc_now().isoformat()
        discovery_status = "COMPLETE" if explicit_message_ids else "IN_PROGRESS"
        try:
            if explicit_message_ids:
                # Explicit requests are not paginated. Keep their batch pointer
                # invisible until every requested ID is durable.
                persist_discovered_message_queue(
                    table,
                    explicit_message_ids,
                    cursor_before=(
                        str(cursor_before)
                        if cursor_before is not None
                        else None
                    ),
                    pending_history_id=None,
                    poll_mode=poll_mode,
                    force_backfill=pending_force_backfill,
                )
                discovered_count = len(
                    read_message_queue(table, active_batch_id)
                )
            # Paginated polls persist their batch identity and current token
            # before the Gmail call. A crash can only repeat that same page.
            write_ingestion_state(
                table,
                status="IN_PROGRESS",
                historyId=cursor_before,
                activeBatchId=active_batch_id,
                pendingHistoryId=pending_history_id,
                pendingPollMode=poll_mode,
                pendingForceBackfill=pending_force_backfill,
                pendingDiscoveredCount=discovered_count,
                pendingSince=pending_started_at,
                lastProgressAt=pending_started_at,
                discoveryStatus=discovery_status,
                discoveryBatchId=active_batch_id,
                discoveryCursorBefore=cursor_before,
                discoveryTargetHistoryId=pending_history_id,
                discoveryPageToken=None,
                discoveryNextSequence=(
                    len(explicit_message_ids) if explicit_message_ids else 0
                ),
                discoveryMode=poll_mode,
                discoveryLabelId=label_id,
                blockedSecretVersion=None,
                errorCode=None,
                errorDetail=None,
            )
            state = {
                **state,
                "status": "IN_PROGRESS",
                "activeBatchId": active_batch_id,
                "pendingHistoryId": pending_history_id,
                "pendingPollMode": poll_mode,
                "pendingForceBackfill": pending_force_backfill,
                "pendingDiscoveredCount": discovered_count,
                "pendingSince": pending_started_at,
                "lastProgressAt": pending_started_at,
                "discoveryStatus": discovery_status,
                "discoveryBatchId": active_batch_id,
                "discoveryCursorBefore": cursor_before,
                "discoveryTargetHistoryId": pending_history_id,
                "discoveryPageToken": None,
                "discoveryNextSequence": (
                    len(explicit_message_ids) if explicit_message_ids else 0
                ),
                "discoveryMode": poll_mode,
                "discoveryLabelId": label_id,
            }
        except Exception as err:
            return queue_failure_response(err, poll_mode)
        discovery_in_progress = discovery_status == "IN_PROGRESS"

    if discovery_in_progress:
        poll_mode = str(state.get("discoveryMode") or poll_mode)
        cursor_before = state.get("discoveryCursorBefore")
        pending_history_id = state.get("discoveryTargetHistoryId")
        pending_force_backfill = bool(state.get("pendingForceBackfill"))
        page_token = state.get("discoveryPageToken")
        next_sequence = int(state.get("discoveryNextSequence") or 0)
        page_budget = gmail_call_budget_reason(
            context,
            monotonic_started_at=monotonic_started_at,
        )
        if page_budget:
            return budget_yield_response(
                page_budget,
                poll_mode=poll_mode,
                discovered=discovered_count,
                remaining=discovered_count,
            )
        try:
            if poll_mode == "history":
                page = list_history_message_ids(
                    access_token,
                    user_id,
                    str(cursor_before),
                    label_id=state.get("discoveryLabelId"),
                    page_token=(
                        str(page_token) if page_token is not None else None
                    ),
                )
            else:
                page = list_message_ids(
                    access_token,
                    user_id,
                    page_token=(
                        str(page_token) if page_token is not None else None
                    ),
                )
        except Exception as err:
            if (
                poll_mode == "history"
                and classify_runtime_error(err) == "GMAIL_HISTORY_CURSOR_EXPIRED"
            ):
                if scheduled_invocation and not pending_force_backfill:
                    error_detail = (
                        "The Gmail history cursor expired. A bounded "
                        "operator-approved recovery is required; scheduled "
                        "full-mailbox replay is disabled."
                    )
                    try:
                        write_ingestion_state(
                            table,
                            status="ERROR",
                            historyId=cursor_before,
                            activeBatchId=None,
                            pendingHistoryId=None,
                            pendingPollMode=None,
                            pendingForceBackfill=False,
                            pendingDiscoveredCount=0,
                            discoveryStatus=None,
                            discoveryBatchId=None,
                            discoveryCursorBefore=None,
                            discoveryTargetHistoryId=None,
                            discoveryPageToken=None,
                            discoveryNextSequence=None,
                            discoveryMode=None,
                            discoveryLabelId=None,
                            pendingSince=None,
                            errorCode="GMAIL_HISTORY_CURSOR_EXPIRED",
                            errorDetail=error_detail,
                        )
                    except Exception as state_err:
                        return queue_failure_response(state_err, poll_mode)
                    return heartbeat_response(
                        status_code=409,
                        body={
                            "status": "ERROR",
                            "errorCode": "GMAIL_HISTORY_CURSOR_EXPIRED",
                            "pollMode": "cursor_reset_required",
                            "historyId": cursor_before,
                            "messageCount": 0,
                            "errorCount": 1,
                        },
                        heartbeat_status="error",
                        error_code="GMAIL_HISTORY_CURSOR_EXPIRED",
                        detail=error_detail,
                        heartbeat_secret_version=secret_version,
                    )
                # Restart discovery as a deterministic full-query recovery.
                # The cursor remains unchanged and any orphan history rows are
                # never referenced by the new batch.
                poll_mode = "cursor_recovery"
                active_batch_id = _queue_batch_id(
                    (),
                    cursor_before=(
                        str(cursor_before)
                        if cursor_before is not None
                        else None
                    ),
                    pending_history_id=(
                        str(pending_history_id)
                        if pending_history_id is not None
                        else None
                    ),
                    poll_mode=poll_mode,
                    force_backfill=pending_force_backfill,
                )
                try:
                    write_ingestion_state(
                        table,
                        activeBatchId=active_batch_id,
                        pendingPollMode=poll_mode,
                        pendingDiscoveredCount=0,
                        discoveryStatus="IN_PROGRESS",
                        discoveryBatchId=active_batch_id,
                        discoveryPageToken=None,
                        discoveryNextSequence=0,
                        discoveryMode=poll_mode,
                        discoveryLabelId=None,
                    )
                except Exception as state_err:
                    return queue_failure_response(state_err, poll_mode)
                state.update({
                    "activeBatchId": active_batch_id,
                    "pendingPollMode": poll_mode,
                    "pendingDiscoveredCount": 0,
                    "discoveryStatus": "IN_PROGRESS",
                    "discoveryBatchId": active_batch_id,
                    "discoveryPageToken": None,
                    "discoveryNextSequence": 0,
                    "discoveryMode": poll_mode,
                    "discoveryLabelId": None,
                })
                return budget_yield_response(
                    "GMAIL_DISCOVERY_PENDING",
                    poll_mode=poll_mode,
                )
            return queue_failure_response(err, poll_mode)

        page_message_ids = list(dict.fromkeys(str(value) for value in page if value))
        next_page_token = getattr(page, "next_page_token", None)
        sequence_direction = (
            -1 if poll_mode in {"query", "cursor_recovery"} else 1
        )
        try:
            # IDs are durable first. Only the following state write may advance
            # Gmail's opaque page token.
            persist_discovered_message_queue(
                table,
                page_message_ids,
                cursor_before=(
                    str(cursor_before) if cursor_before is not None else None
                ),
                pending_history_id=(
                    str(pending_history_id)
                    if pending_history_id is not None
                    else None
                ),
                poll_mode=poll_mode,
                force_backfill=pending_force_backfill,
                start_sequence=next_sequence,
                sequence_direction=sequence_direction,
                budget_check=lambda: invocation_budget_reason(
                    context,
                    monotonic_started_at=monotonic_started_at,
                ),
            )
            next_sequence += sequence_direction * len(page_message_ids)
            queue_after_page = read_message_queue(table, active_batch_id)
            discovered_count = len(queue_after_page)
            discovery_status = (
                "IN_PROGRESS" if next_page_token else "COMPLETE"
            )
            last_progress_at = utc_now().isoformat()
            write_ingestion_state(
                table,
                status="IN_PROGRESS",
                historyId=cursor_before,
                activeBatchId=active_batch_id,
                pendingHistoryId=pending_history_id,
                pendingPollMode=poll_mode,
                pendingForceBackfill=pending_force_backfill,
                pendingDiscoveredCount=discovered_count,
                pendingSince=state.get("pendingSince") or started_at,
                lastProgressAt=last_progress_at,
                discoveryStatus=discovery_status,
                discoveryBatchId=active_batch_id,
                discoveryCursorBefore=cursor_before,
                discoveryTargetHistoryId=pending_history_id,
                discoveryPageToken=next_page_token,
                discoveryNextSequence=next_sequence,
                discoveryMode=poll_mode,
                errorCode=None,
                errorDetail=None,
            )
            state.update({
                "status": "IN_PROGRESS",
                "activeBatchId": active_batch_id,
                "pendingHistoryId": pending_history_id,
                "pendingPollMode": poll_mode,
                "pendingForceBackfill": pending_force_backfill,
                "pendingDiscoveredCount": discovered_count,
                "lastProgressAt": last_progress_at,
                "discoveryStatus": discovery_status,
                "discoveryBatchId": active_batch_id,
                "discoveryCursorBefore": cursor_before,
                "discoveryTargetHistoryId": pending_history_id,
                "discoveryPageToken": next_page_token,
                "discoveryNextSequence": next_sequence,
                "discoveryMode": poll_mode,
            })
        except GmailInvocationBudgetYield as err:
            return budget_yield_response(
                err.error_code,
                poll_mode=poll_mode,
                discovered=discovered_count,
                remaining=discovered_count,
            )
        except Exception as err:
            return queue_failure_response(err, poll_mode)

        if next_page_token:
            post_page_budget = gmail_call_budget_reason(
                context,
                monotonic_started_at=monotonic_started_at,
            )
            return budget_yield_response(
                post_page_budget or "GMAIL_DISCOVERY_PENDING",
                poll_mode=poll_mode,
                discovered=discovered_count,
                remaining=discovered_count,
            )

    try:
        queue_items = (
            read_message_queue(table, active_batch_id)
            if active_batch_id
            else []
        )
    except Exception as err:
        return queue_failure_response(err, poll_mode)

    if operator_replay_requested:
        active_queue_ids = {
            str(item.get("gmailMessageId") or "")
            for item in queue_items
            if str(item.get("status") or "") in MESSAGE_QUEUE_ACTIVE_STATUSES
        }
        if active_queue_ids != set(operator_replay_ids):
            return queue_failure_response(
                GmailOperatorReplayError(
                    "The active Gmail batch does not match the operator replay receipt"
                ),
                "operator_replay",
            )
        pending_force_backfill = True

    results: List[Dict[str, Any]] = []
    errors: List[Dict[str, Any]] = []
    successful_message_ids = set()
    new_quarantines: List[Dict[str, Any]] = []
    attempted_count = 0
    budget_reason = None
    last_progress_at = str(
        state.get("lastProgressAt")
        or state.get("pendingSince")
        or started_at
    )

    for queue_item in queue_items:
        if str(queue_item.get("status") or "") not in MESSAGE_QUEUE_ACTIVE_STATUSES:
            continue
        if attempted_count >= MAX_MESSAGES_PER_INVOCATION:
            break
        budget_reason = gmail_call_budget_reason(
            context,
            monotonic_started_at=monotonic_started_at,
        )
        if budget_reason:
            break
        try:
            claimed = claim_queued_message(table, queue_item)
        except Exception as err:
            return queue_failure_response(err, poll_mode)
        if claimed is None:
            continue

        attempted_count += 1
        gmail_message_id = str(claimed.get("gmailMessageId") or "")
        try:
            process_kwargs: Dict[str, Any] = {
                "budget_check": lambda: gmail_call_budget_reason(
                    context,
                    monotonic_started_at=monotonic_started_at,
                ),
            }
            if pending_force_backfill and operator_replay_requested:
                process_kwargs["allow_version_backfill"] = True
            result = process_message(
                access_token,
                user_id,
                gmail_message_id,
                table,
                **process_kwargs,
            )
        except GmailInvocationBudgetYield as err:
            budget_reason = err.error_code
            try:
                checkpoint_queued_message(
                    table,
                    claimed,
                    status="RETRYABLE",
                    error_code=budget_reason,
                    error_detail=(
                        "Invocation yielded before the next message work unit."
                    ),
                )
            except Exception as checkpoint_error:
                return queue_failure_response(checkpoint_error, poll_mode)
            break
        except Exception as err:
            error_code = classify_runtime_error(err)
            error_detail = safe_error_detail(err)
            quarantined = (
                poll_mode.startswith("build_recovery:")
                or int(claimed.get("attemptCount") or 0)
                >= MESSAGE_QUEUE_MAX_ATTEMPTS
            )
            try:
                checkpoint_queued_message(
                    table,
                    claimed,
                    status="QUARANTINED" if quarantined else "RETRYABLE",
                    error_code=error_code,
                    error_detail=error_detail,
                )
            except Exception as checkpoint_error:
                return queue_failure_response(checkpoint_error, poll_mode)
            error_item = {
                "messageId": gmail_message_id,
                "error": error_detail,
                "errorCode": error_code,
                "retryable": not quarantined,
                "attemptCount": int(claimed.get("attemptCount") or 0),
                "quarantined": quarantined,
            }
            errors.append(error_item)
            if quarantined:
                quarantine_record = {
                    "messageId": gmail_message_id,
                    "errorCode": error_code,
                    "quarantinedAt": utc_now().isoformat(),
                    "attemptCount": int(claimed.get("attemptCount") or 0),
                }
                if poll_mode.startswith("build_recovery:"):
                    quarantine_record.update(
                        {
                            "recoveryBuildVersion": BUILD_VERSION,
                            "recoveryAttemptedAt": utc_now().isoformat(),
                        }
                    )
                new_quarantines.append(quarantine_record)
        else:
            try:
                checkpoint_queued_message(
                    table,
                    claimed,
                    status="COMPLETED",
                )
            except Exception as checkpoint_error:
                return queue_failure_response(checkpoint_error, poll_mode)
            results.append(result)
            successful_message_ids.add(gmail_message_id)
            last_progress_at = utc_now().isoformat()

    try:
        queue_items = (
            read_message_queue(table, active_batch_id)
            if active_batch_id
            else []
        )
    except Exception as err:
        return queue_failure_response(err, poll_mode)

    remaining_items = [
        item
        for item in queue_items
        if str(item.get("status") or "") in MESSAGE_QUEUE_ACTIVE_STATUSES
    ]
    batch_quarantines = [
        item
        for item in queue_items
        if str(item.get("status") or "") == "QUARANTINED"
    ]

    recorded_quarantines = [
        dict(item)
        for item in (state.get("quarantinedMessages") or [])
        if isinstance(item, dict)
    ]
    recovered_quarantine_ids = {
        str(item.get("messageId") or "")
        for item in recorded_quarantines
    } & successful_message_ids
    if successful_message_ids:
        recorded_quarantines = [
            item
            for item in recorded_quarantines
            if item.get("messageId") not in successful_message_ids
        ]
    known_quarantined_ids = {
        str(item.get("messageId") or "")
        for item in recorded_quarantines
    }
    for item in new_quarantines:
        if item["messageId"] in known_quarantined_ids:
            recorded_quarantines = [
                (
                    {**existing, **item}
                    if existing.get("messageId") == item["messageId"]
                    else existing
                )
                for existing in recorded_quarantines
            ]
        else:
            recorded_quarantines.append(item)
            known_quarantined_ids.add(item["messageId"])
    recorded_quarantines = recorded_quarantines[-MAX_RECORDED_QUARANTINES:]
    previous_quarantine_count = max(
        len(recorded_quarantines),
        int(state.get("quarantinedCount") or 0)
        - len(recovered_quarantine_ids),
    )
    quarantined_count = max(
        previous_quarantine_count,
        len(recorded_quarantines),
        len(batch_quarantines),
    )

    stored_count = sum(len(item["stored"]) for item in results)
    skipped_count = sum(len(item["skipped"]) for item in results)
    counts = {
        "messages": attempted_count,
        "stored": stored_count,
        "skipped": skipped_count,
        "errors": len(errors),
        "dropped": quarantined_count,
        "remaining": len(remaining_items),
    }

    if remaining_items:
        stalled = False
        if not successful_message_ids:
            try:
                progress_time = datetime.fromisoformat(
                    last_progress_at.replace("Z", "+00:00")
                )
                if progress_time.tzinfo is None:
                    progress_time = progress_time.replace(tzinfo=timezone.utc)
                stalled = (
                    utc_now() - progress_time.astimezone(timezone.utc)
                ).total_seconds() >= BACKLOG_STALLED_SECONDS
            except (TypeError, ValueError):
                stalled = True

        if stalled:
            heartbeat_status = "error"
            heartbeat_error_code = "GMAIL_BACKLOG_STALLED"
        elif new_quarantines:
            heartbeat_status = "warning"
            heartbeat_error_code = "GMAIL_QUARANTINED_ARTIFACTS_PENDING"
        else:
            heartbeat_status = "in_progress"
            heartbeat_error_code = (
                budget_reason
                or (
                    "GMAIL_MESSAGE_RETRY_PENDING"
                    if errors
                    else "GMAIL_BACKLOG_PENDING"
                )
            )
        try:
            write_ingestion_state(
                table,
                status=(
                    "ERROR"
                    if heartbeat_status == "error"
                    else "WARNING"
                    if heartbeat_status == "warning"
                    else "IN_PROGRESS"
                ),
                historyId=cursor_before,
                activeBatchId=active_batch_id,
                pendingHistoryId=pending_history_id,
                pendingPollMode=poll_mode,
                pendingForceBackfill=pending_force_backfill,
                pendingDiscoveredCount=discovered_count,
                pendingSince=state.get("pendingSince") or started_at,
                lastProgressAt=last_progress_at,
                quarantinedCount=quarantined_count,
                quarantinedMessages=recorded_quarantines,
                errorCode=heartbeat_error_code,
                errorDetail=(
                    f"{len(remaining_items)} durable Gmail message(s) remain."
                ),
                counts=counts,
            )
        except Exception as err:
            return queue_failure_response(err, poll_mode)

        heartbeat_written = write_service_heartbeat(
            started_at=started_at,
            status=heartbeat_status,
            trigger_source=trigger_source,
            schedule_id=schedule_id,
            error_code=heartbeat_error_code,
            detail=f"{len(remaining_items)} durable Gmail message(s) remain.",
            secret_version=secret_version,
            counts=counts,
        )
        response_status = (
            "ERROR"
            if heartbeat_status == "error"
            else "ATTENTION"
            if heartbeat_status == "warning"
            else "IN_PROGRESS"
        )
        status_code = 207 if heartbeat_status == "error" else 200
        if not heartbeat_written:
            response_status = "ERROR"
            status_code = 503
            heartbeat_error_code = "GMAIL_HEARTBEAT_WRITE_FAILED"
            try:
                write_ingestion_state(
                    table,
                    status="ERROR",
                    historyId=cursor_before,
                    activeBatchId=active_batch_id,
                    pendingHistoryId=pending_history_id,
                    pendingPollMode=poll_mode,
                    pendingForceBackfill=pending_force_backfill,
                    pendingDiscoveredCount=discovered_count,
                    pendingSince=state.get("pendingSince") or started_at,
                    lastProgressAt=last_progress_at,
                    quarantinedCount=quarantined_count,
                    quarantinedMessages=recorded_quarantines,
                    errorCode=heartbeat_error_code,
                    errorDetail="Scheduled progress heartbeat could not be persisted.",
                    counts=counts,
                )
            except Exception:
                pass
        return {
            "statusCode": status_code,
            "body": json.dumps({
                "status": response_status,
                "errorCode": heartbeat_error_code,
                "query": GMAIL_QUERY,
                "pollMode": poll_mode,
                "historyId": cursor_before,
                "pendingHistoryId": pending_history_id,
                "messageCount": attempted_count,
                "discoveredCount": discovered_count,
                "remainingCount": len(remaining_items),
                "storedCount": stored_count,
                "skippedCount": skipped_count,
                "errorCount": len(errors),
                "quarantinedCount": quarantined_count,
                "results": results,
                "errors": errors,
            }),
        }

    canonical_verification = None
    if pending_force_backfill and not operator_replay_requested:
        try:
            canonical_verification = verify_research_event_ledger(dynamodb)
            if not canonical_verification["verified"]:
                errors.append({
                    "messageId": None,
                    "error": (
                        "Canonical RTA/ETF research-event verification is incomplete "
                        "after forceBackfill."
                    ),
                    "errorCode": "GMAIL_CANONICAL_VERIFICATION_INCOMPLETE",
                    "retryable": True,
                })
        except Exception as err:
            canonical_verification = {
                "verified": False,
                "eventCount": 0,
                "unverifiedEventCount": 0,
                "products": {},
            }
            errors.append({
                "messageId": None,
                "error": safe_error_detail(err),
                "errorCode": "GMAIL_CANONICAL_VERIFICATION_FAILED",
                "retryable": True,
            })

    counts["errors"] = len(errors)
    history_id = (
        pending_history_id
        if pending_history_id is not None
        else cursor_before
    )
    has_processing_error = any(
        item.get("quarantined") is not True
        for item in errors
    )
    has_quarantine_warning = bool(
        quarantined_count and not has_processing_error
    )
    error_codes = {
        str(item.get("errorCode") or "")
        for item in errors
        if item.get("errorCode")
    }
    heartbeat_error_code = None
    if has_processing_error and error_codes:
        heartbeat_error_code = (
            next(iter(error_codes))
            if len(error_codes) == 1
            else "GMAIL_MESSAGE_PROCESSING_ERROR"
        )
    elif quarantined_count:
        heartbeat_error_code = "GMAIL_QUARANTINED_ARTIFACTS_PENDING"

    try:
        write_ingestion_state(
            table,
            status=(
                "ERROR"
                if has_processing_error
                else "WARNING"
                if has_quarantine_warning
                else "READY"
            ),
            historyId=history_id,
            activeBatchId=None,
            pendingHistoryId=None,
            pendingPollMode=None,
            pendingForceBackfill=False,
            pendingDiscoveredCount=0,
            discoveryStatus=None,
            discoveryBatchId=None,
            discoveryCursorBefore=None,
            discoveryTargetHistoryId=None,
            discoveryPageToken=None,
            discoveryNextSequence=None,
            discoveryMode=None,
            discoveryLabelId=None,
            pendingSince=None,
            lastProgressAt=last_progress_at,
            blockedSecretVersion=None,
            errorCode=heartbeat_error_code,
            errorDetail=(
                (
                    f"{quarantined_count} Gmail message(s) remain quarantined."
                    if quarantined_count
                    else f"{len(errors)} message(s) failed processing."
                )
                if has_processing_error or has_quarantine_warning
                else None
            ),
            lastSuccessAt=(
                state.get("lastSuccessAt")
                if has_processing_error
                else utc_now().isoformat()
            ),
            pollMode=poll_mode,
            quarantinedCount=quarantined_count,
            quarantinedMessages=recorded_quarantines,
            counts=counts,
        )
    except Exception as err:
        return queue_failure_response(err, poll_mode)

    heartbeat_written = write_service_heartbeat(
        started_at=started_at,
        status=(
            "error"
            if has_processing_error
            else "warning"
            if has_quarantine_warning
            else "success"
        ),
        trigger_source=trigger_source,
        schedule_id=schedule_id,
        error_code=heartbeat_error_code,
        detail=(
            (
                f"{quarantined_count} Gmail message(s) remain quarantined."
                if quarantined_count
                else f"{len(errors)} message(s) failed processing."
            )
            if has_processing_error or has_quarantine_warning
            else None
        ),
        secret_version=secret_version,
        counts=counts,
    )
    if not heartbeat_written:
        heartbeat_error_code = "GMAIL_HEARTBEAT_WRITE_FAILED"
        try:
            write_ingestion_state(
                table,
                status="ERROR",
                historyId=history_id,
                errorCode=heartbeat_error_code,
                errorDetail="Scheduled completion heartbeat could not be persisted.",
                counts=counts,
            )
        except Exception:
            pass

    return {
        "statusCode": (
            503
            if not heartbeat_written
            else (207 if has_processing_error else 200)
        ),
        "body": json.dumps(
            {
                "status": (
                    "ERROR"
                    if has_processing_error or not heartbeat_written
                    else "ATTENTION"
                    if has_quarantine_warning
                    else "SUCCESS"
                ),
                "errorCode": heartbeat_error_code,
                "query": GMAIL_QUERY,
                "pollMode": poll_mode,
                "historyId": history_id,
                "messageCount": attempted_count,
                "discoveredCount": discovered_count,
                "remainingCount": 0,
                "storedCount": stored_count,
                "skippedCount": skipped_count,
                "errorCount": len(errors),
                "quarantinedCount": quarantined_count,
                "canonicalVerification": canonical_verification,
                "results": results,
                "errors": errors,
            }
        ),
    }


if __name__ == "__main__":
    print(json.dumps(lambda_handler({}, None), indent=2))
