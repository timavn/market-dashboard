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
from typing import Any, Dict, Iterable, List, Optional, Tuple

import boto3
from botocore.exceptions import ClientError
from parse_hedgeye_email_html import parse_html_snapshot, save_snapshot_to_dynamodb
from research_intelligence import (
    PARSER_VERSION as SECURITY_INTELLIGENCE_PARSER_VERSION,
    persist_snapshot_failure,
    persist_snapshot_intelligence,
    product_definition,
    product_ids,
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
MAX_MESSAGES = int(os.environ.get("HERMES_MAX_MESSAGES", "500"))
ATTACHMENT_TTL_DAYS = int(os.environ.get("HERMES_LEDGER_TTL_DAYS", "730"))
SECRET_CACHE_SECONDS = int(os.environ.get("HERMES_SECRET_CACHE_SECONDS", str(6 * 60 * 60)))
GMAIL_API_ROOT = "https://gmail.googleapis.com/gmail/v1"
TOKEN_URL = "https://oauth2.googleapis.com/token"
MESSAGE_LEDGER_ATTACHMENT_ID = "__MESSAGE__"
TEXTRACT_LEDGER_ATTACHMENT_ID = "__TEXTRACT_CONTENT__"
MATERIALIZED_SNAPSHOT_TYPES = {"real-time-alert", "etf-pro"}
RESEARCH_EVENT_SNAPSHOT_TYPES = set(product_ids())
MATERIALIZED_DATA_VERSION = "gmail-materialized-v3-security-intelligence"
RESEARCH_PARSER_VERSION = "research-event-ledger-v2"
MATERIALIZATION_WRITE_RETRIES = 3
MATERIALIZATION_MAX_ATTEMPTS = 3
ATTACHMENT_CLAIM_STALE_SECONDS = int(
    os.environ.get("HERMES_ATTACHMENT_CLAIM_STALE_SECONDS", str(10 * 60))
)
TEXTRACT_CLAIM_STALE_SECONDS = 60 * 60
BUILD_VERSION = os.environ.get("BUILD_VERSION", "development")
HEARTBEAT_TTL_DAYS = int(os.environ.get("SERVICE_HEARTBEAT_TTL_DAYS", "90"))
GMAIL_ACCOUNT = os.environ.get("HERMES_GMAIL_ACCOUNT", "timsmithaviation@gmail.com")
GMAIL_SERVICE_ID = f"gmail:{GMAIL_ACCOUNT.lower()}"
GMAIL_SCHEDULE_ID = os.environ.get(
    "HERMES_GMAIL_SCHEDULE_ID",
    "market-dashboard-gmail-v2-every-15m",
)
RUNTIME_STATE_MESSAGE_ID = f"runtime#gmail#{GMAIL_ACCOUNT.lower()}"
HISTORY_CURSOR_ATTACHMENT_ID = "history-cursor"
PDF_PROCESSOR_FUNCTION_NAME = os.environ.get(
    "PDF_PROCESSOR_FUNCTION_NAME",
    "market-dashboard-hedgeye-pdf-processor-v1",
)


secretsmanager = boto3.client("secretsmanager", region_name=AWS_REGION)
dynamodb = boto3.resource("dynamodb", region_name=AWS_REGION)
s3 = boto3.client("s3", region_name=AWS_REGION)
cloudwatch = boto3.client("cloudwatch", region_name=AWS_REGION)
lambda_client = boto3.client("lambda", region_name=AWS_REGION)


_oauth_secret_cache: Optional[Dict[str, Any]] = None


class RetryableResearchMaterializationError(RuntimeError):
    """A stored Gmail artifact whose research projection is not yet trustworthy."""

    error_code = "GMAIL_RESEARCH_MATERIALIZATION_ERROR"
    retryable = True


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


def list_message_ids(access_token: str, user_id: str) -> List[str]:
    message_ids: List[str] = []
    page_token: Optional[str] = None

    # Drain every page before advancing the history cursor. Truncating a full
    # sync and then saving the mailbox's newest historyId permanently skips the
    # messages on later pages. Message processing itself is immutable and
    # idempotent, so a Lambda timeout safely resumes on the next poll without
    # ever acknowledging an incompletely listed mailbox.
    while True:
        params = {"q": GMAIL_QUERY, "maxResults": min(500, max(1, MAX_MESSAGES))}
        if page_token:
            params["pageToken"] = page_token

        data = http_json("GET", gmail_path(user_id, "messages"), access_token=access_token, params=params)
        message_ids.extend(msg["id"] for msg in data.get("messages", []) if msg.get("id"))
        page_token = data.get("nextPageToken")
        if not page_token:
            break

    return message_ids


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
    value = payload.get("historyId")
    return str(value) if value is not None else None


def list_history_message_ids(
    access_token: str,
    user_id: str,
    start_history_id: str,
    *,
    label_id: Optional[str],
) -> List[str]:
    """Read newly-added message IDs from Gmail history without replaying the mailbox."""
    message_ids: List[str] = []
    seen = set()
    page_token: Optional[str] = None
    while True:
        params: Dict[str, Any] = {
            "startHistoryId": start_history_id,
            "historyTypes": "messageAdded",
            "maxResults": min(500, max(1, MAX_MESSAGES)),
        }
        if label_id:
            params["labelId"] = label_id
        if page_token:
            params["pageToken"] = page_token
        payload = http_json("GET", gmail_path(user_id, "history"), access_token=access_token, params=params)
        for history in payload.get("history", []):
            for added in history.get("messagesAdded", []):
                message_id = added.get("message", {}).get("id")
                if message_id and message_id not in seen:
                    seen.add(message_id)
                    message_ids.append(message_id)
        page_token = payload.get("nextPageToken")
        if not page_token:
            break
    return message_ids


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
        print(f"[gmail] state read unavailable: {type(err).__name__}")
        return {}


def write_ingestion_state(table: Any, **updates: Any) -> None:
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
) -> None:
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
    try:
        dynamodb.Table(HEARTBEAT_TABLE).put_item(Item=item)
    except Exception as err:
        # CloudWatch remains the out-of-band signal when the heartbeat store itself fails.
        print(f"[gmail] heartbeat write unavailable: {type(err).__name__}")
    try:
        cloudwatch.put_metric_data(
            Namespace="MarketDashboard/Readiness",
            MetricData=[
                {
                    "MetricName": "Heartbeat",
                    "Dimensions": [{"Name": "ServiceId", "Value": service_id}],
                    "Timestamp": finished,
                    "Value": 1,
                    "Unit": "Count",
                },
                {
                    "MetricName": "Healthy",
                    "Dimensions": [{"Name": "ServiceId", "Value": service_id}],
                    "Timestamp": finished,
                    "Value": 1 if status == "success" else 0,
                    "Unit": "Count",
                },
            ],
        )
    except Exception as err:
        print(f"[gmail] heartbeat metric unavailable: {type(err).__name__}")


def get_message(access_token: str, user_id: str, message_id: str) -> Dict[str, Any]:
    return http_json(
        "GET",
        gmail_path(user_id, f"messages/{urllib.parse.quote(message_id, safe='')}"),
        access_token=access_token,
        params={"format": "full"},
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


def infer_report_type(filename: str, subject: str) -> str:
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
                "OR #status = :error "
                "OR #status = :textractError"
            ),
            ExpressionAttributeNames={"#status": "status"},
            ExpressionAttributeValues={
                ":error": "ERROR",
                ":textractError": "TEXTRACT_ERROR",
            },
        )
        return True
    except ClientError as err:
        if err.response.get("Error", {}).get("Code") != "ConditionalCheckFailedException":
            raise

    key = {"messageId": message_id, "attachmentId": attachment_id}
    existing = table.get_item(Key=key, ConsistentRead=True).get("Item")
    expected_updated_at = existing.get("updatedAt") if existing else None
    existing_status = str(existing.get("status") or "") if existing else ""
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
            "eventType": event_type,
            "payload": payload,
            "snapshotDate": snapshot.get("date"),
            "sourceKind": snapshot.get("sourceKind") or default_source_kind,
            "source": "gmail",
            "sourceArtifact": artifact_key,
            "contentHash": content_sha256 or snapshot.get("contentHash") or event_hash,
            "eventHash": event_hash,
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
    return written


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
    return RetryableResearchMaterializationError(
        f"Research parse/materialization failed: {safe_error_detail(error)}"
    )


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
) -> bool:
    if attachment_id.startswith("message-body-") is False or mime_type != "text/html":
        return False

    item = ledger_item or table.get_item(
        Key={"messageId": message_id, "attachmentId": attachment_id}
    ).get("Item")
    if not item or not item.get("s3Bucket") or not item.get("s3Key"):
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
    attempt_count = _materialization_attempt_count(item) + 1

    snapshot: Optional[Dict[str, Any]] = None
    try:
        obj = s3.get_object(Bucket=item["s3Bucket"], Key=item["s3Key"])
        html_body = obj["Body"].read().decode("utf-8", errors="replace")
        snapshot = parse_html_snapshot(
            report_type=report_type,
            html_body=html_body,
            received_at=received_at,
            s3_key=item["s3Key"],
            message_id=message_id,
            subject=item.get("subject", ""),
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
        materialization_extra = {
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


def _should_backfill_materialized_snapshot(item: Dict[str, Any]) -> bool:
    if item.get("status") not in {"STORED", "DUPLICATE"}:
        return False
    if not str(item.get("attachmentId") or "").startswith("message-body-"):
        return False
    if str(item.get("mimeType") or "").lower() != "text/html":
        return False
    if not item.get("s3Bucket") or not item.get("s3Key"):
        return False

    report_type = str(item.get("snapshotType") or item.get("reportType") or "unknown")
    subject = str(item.get("subject") or "")
    is_materializable = report_type in RESEARCH_EVENT_SNAPSHOT_TYPES or bool(
        re.search(r"\b\d+\s+Changes?:", subject, re.IGNORECASE)
    )
    if not is_materializable:
        return False
    if item.get("materializationAttemptVersion") != MATERIALIZED_DATA_VERSION:
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
        s3.put_object(
            Bucket=S3_BUCKET,
            Key=s3_key,
            Body=content,
            ContentType=mime_type,
            Metadata=metadata,
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
        }

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


def process_message(access_token: str, user_id: str, message_id: str, table: Any) -> Dict[str, Any]:
    ledger_items = get_message_ledger_items(table, message_id)
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

        for item in attachment_items:
            filename = item.get("filename", "")
            if _should_backfill_materialized_snapshot(item):
                report_type = str(item.get("reportType") or "unknown")
                backfilled = backfill_html_snapshot(
                    table=table,
                    message_id=message_id,
                    attachment_id=item["attachmentId"],
                    report_type=report_type,
                    mime_type=item.get("mimeType", ""),
                    received_at=_parse_ledger_datetime(item),
                    ledger_item=item,
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


def lambda_handler(event: Optional[Dict[str, Any]], context: Any) -> Dict[str, Any]:
    """Poll Gmail with cursoring, auth circuit-breaking, and an unconditional heartbeat."""
    event = event or {}
    trigger_source = str(event.get("source") or "manual").strip()
    schedule_id = str(event.get("scheduleId") or "").strip() or None
    started_at = utc_now().isoformat()
    table = dynamodb.Table(LEDGER_TABLE)
    secret: Dict[str, Any] = {}
    secret_version = "unknown"

    try:
        secret = load_oauth_secret()
        secret_version = str(secret.get("_secret_version") or "unknown")
    except Exception as err:
        error_code = classify_runtime_error(err)
        write_service_heartbeat(
            started_at=started_at,
            status="error",
            trigger_source=trigger_source,
            schedule_id=schedule_id,
            error_code=error_code,
            detail=safe_error_detail(err),
        )
        raise

    user_id = event.get("userId") or secret.get("user_id") or os.environ.get("GMAIL_USER_ID", "me")
    # A forced activation probe validates OAuth/Gmail without depending on or
    # mutating the ingestion cursor. Normal polls still require the ledger
    # state before deciding whether the auth circuit is open.
    state = (
        {}
        if event.get("authProbeOnly") and event.get("forceAuthProbe")
        else read_ingestion_state(table)
    )
    # While auth is blocked, do not call Google, but do check Secrets Manager on
    # every scheduled invocation. A long-lived warm-runtime cache must not delay
    # recovery for hours after an operator atomically promotes a new version.
    if (
        state.get("status") == "AUTH_REQUIRED"
        and state.get("blockedSecretVersion") == secret_version
        and not event.get("forceAuthProbe")
    ):
        secret = load_oauth_secret(force_refresh=True)
        secret_version = str(secret.get("_secret_version") or "unknown")
        user_id = event.get("userId") or secret.get("user_id") or os.environ.get("GMAIL_USER_ID", "me")
    auth_blocked = (
        state.get("status") == "AUTH_REQUIRED"
        and state.get("blockedSecretVersion") == secret_version
        and not event.get("forceAuthProbe")
    )
    if auth_blocked:
        write_service_heartbeat(
            started_at=started_at,
            status="auth_required",
            trigger_source=trigger_source,
            schedule_id=schedule_id,
            error_code="GMAIL_AUTH_REQUIRED",
            detail="OAuth authorization is blocked until the Secrets Manager version changes.",
            secret_version=secret_version,
        )
        return {
            "statusCode": 200,
            "body": json.dumps({
                "status": "AUTH_REQUIRED",
                "errorCode": "GMAIL_AUTH_REQUIRED",
                "messageCount": 0,
            }),
        }

    try:
        access_token = refresh_access_token(secret)
    except Exception:
        # Reload once so a rotation is immediately visible to a warm runtime.
        clear_oauth_secret_cache()
        try:
            secret = load_oauth_secret(force_refresh=True)
            secret_version = str(secret.get("_secret_version") or "unknown")
            user_id = event.get("userId") or secret.get("user_id") or os.environ.get("GMAIL_USER_ID", "me")
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
                write_service_heartbeat(
                    started_at=started_at,
                    status="auth_required",
                    trigger_source=trigger_source,
                    schedule_id=schedule_id,
                    error_code=error_code,
                    detail=safe_error_detail(err),
                    secret_version=secret_version,
                )
                return {
                    "statusCode": 200,
                    "body": json.dumps({
                        "status": "AUTH_REQUIRED",
                        "errorCode": error_code,
                        "messageCount": 0,
                    }),
                }
            write_service_heartbeat(
                started_at=started_at,
                status="error",
                trigger_source=trigger_source,
                schedule_id=schedule_id,
                error_code=error_code,
                detail=safe_error_detail(err),
                secret_version=secret_version,
            )
            raise

    if event.get("authProbeOnly"):
        # Activation can validate the refresh grant and readonly Gmail API
        # access without listing messages, advancing the history cursor, or
        # materializing any research data. This remains a manual heartbeat and
        # can never satisfy the scheduled-poller rollout gate.
        try:
            get_profile_history_id(access_token, user_id)
        except Exception as err:
            error_code = classify_runtime_error(err)
            write_service_heartbeat(
                started_at=started_at,
                status="error",
                trigger_source=trigger_source,
                schedule_id=schedule_id,
                error_code=error_code,
                detail=safe_error_detail(err),
                secret_version=secret_version,
            )
            return {
                "statusCode": 503,
                "body": json.dumps({
                    "status": "ERROR",
                    "errorCode": error_code,
                    "pollMode": "auth_probe",
                    "messageCount": 0,
                    "errorCount": 1,
                }),
            }

        write_service_heartbeat(
            started_at=started_at,
            status="success",
            trigger_source=trigger_source,
            schedule_id=schedule_id,
            secret_version=secret_version,
            counts={"messages": 0, "stored": 0, "skipped": 0, "errors": 0, "dropped": 0},
        )
        return {
            "statusCode": 200,
            "body": json.dumps({
                "status": "SUCCESS",
                "pollMode": "auth_probe",
                "messageCount": 0,
                "storedCount": 0,
                "skippedCount": 0,
                "errorCount": 0,
            }),
        }

    message_ids = list(event.get("messageIds") or [])
    poll_mode = "explicit" if message_ids else "query"
    cursor_before = state.get("historyId")
    if not message_ids and cursor_before and not event.get("forceBackfill"):
        try:
            label_id = resolve_label_id(access_token, user_id)
            if label_id:
                message_ids = list_history_message_ids(
                    access_token,
                    user_id,
                    str(cursor_before),
                    label_id=label_id,
                )
                poll_mode = "history"
        except Exception as err:
            if classify_runtime_error(err) != "GMAIL_HISTORY_CURSOR_EXPIRED":
                write_service_heartbeat(
                    started_at=started_at,
                    status="error",
                    trigger_source=trigger_source,
                    schedule_id=schedule_id,
                    error_code=classify_runtime_error(err),
                    detail=safe_error_detail(err),
                    secret_version=secret_version,
                )
                raise
            poll_mode = "cursor_recovery"

    # A successful history poll with zero new messages is real work completed,
    # not a reason to rescan the mailbox. Only initial/backfill and expired
    # cursor recovery paths should issue the broader Gmail query.
    if not message_ids and poll_mode in {"query", "cursor_recovery"}:
        message_ids = list_message_ids(access_token, user_id)
        if poll_mode != "cursor_recovery":
            poll_mode = "query"

    # users.messages.list is newest-first, while users.history.list is already
    # chronological (increasing historyId). Preserve that distinction so every
    # materialized action is replayed oldest-first.
    message_ids = list(dict.fromkeys(message_ids))
    if poll_mode in {"query", "cursor_recovery"}:
        message_ids.reverse()

    results = []
    errors = []
    for message_id in message_ids:
        try:
            results.append(process_message(access_token, user_id, message_id, table))
        except Exception as err:
            errors.append({
                "messageId": message_id,
                "error": safe_error_detail(err),
                "errorCode": classify_runtime_error(err),
                "retryable": bool(getattr(err, "retryable", False)),
            })

    stored_count = sum(len(item["stored"]) for item in results)
    skipped_count = sum(len(item["skipped"]) for item in results)
    counts = {
        "messages": len(message_ids),
        "stored": stored_count,
        "skipped": skipped_count,
        "errors": len(errors),
        "dropped": 0,
    }

    history_id = None
    if not errors:
        history_id = get_profile_history_id(access_token, user_id)
        write_ingestion_state(
            table,
            status="READY",
            historyId=history_id,
            blockedSecretVersion=None,
            errorCode=None,
            errorDetail=None,
            lastSuccessAt=utc_now().isoformat(),
            pollMode=poll_mode,
            counts=counts,
        )

    error_codes = {item["errorCode"] for item in errors}
    heartbeat_error_code = None
    if errors:
        heartbeat_error_code = (
            next(iter(error_codes))
            if len(error_codes) == 1
            else "GMAIL_MESSAGE_PROCESSING_ERROR"
        )

    write_service_heartbeat(
        started_at=started_at,
        status="error" if errors else "success",
        trigger_source=trigger_source,
        schedule_id=schedule_id,
        error_code=heartbeat_error_code,
        detail=f"{len(errors)} message(s) failed processing." if errors else None,
        secret_version=secret_version,
        counts=counts,
    )

    return {
        "statusCode": 207 if errors else 200,
        "body": json.dumps(
            {
                "status": "PARTIAL_ERROR" if errors else "SUCCESS",
                "query": GMAIL_QUERY,
                "pollMode": poll_mode,
                "historyId": history_id,
                "messageCount": len(message_ids),
                "storedCount": stored_count,
                "skippedCount": skipped_count,
                "errorCount": len(errors),
                "results": results,
                "errors": errors,
            }
        ),
    }


if __name__ == "__main__":
    print(json.dumps(lambda_handler({}, None), indent=2))
