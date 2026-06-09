#!/usr/bin/env python3
"""
Hermes Gmail ingestor for Hedgeye product emails.

Polls the Gmail API with OAuth refresh-token credentials, downloads matching
attachments, stores raw artifacts in S3, and records idempotency/status in
DynamoDB. PDF attachments are written below the existing `hedgeye/` prefix so
the Hedgeye PDF processor Lambda can parse them into HedgeyeDailySnapshot.

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
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import PurePosixPath
from typing import Any, Dict, Iterable, List, Optional, Tuple

import boto3
from botocore.exceptions import ClientError
from parse_hedgeye_email_html import parse_html_snapshot, save_snapshot_to_dynamodb


AWS_REGION = os.environ.get("AWS_REGION", os.environ.get("AWS_DEFAULT_REGION", "us-west-1"))
SECRET_NAME = os.environ.get("GMAIL_OAUTH_SECRET_NAME", "hermes/gmail/oauth")
LEDGER_TABLE = os.environ.get("HERMES_LEDGER_TABLE", "HermesEmailIngestLedger")
S3_BUCKET = os.environ.get("HERMES_S3_BUCKET", "market-dashboard-csv-data")
GMAIL_QUERY = os.environ.get(
    "HERMES_GMAIL_QUERY",
    "newer_than:30d hedgeye",
)
MAX_MESSAGES = int(os.environ.get("HERMES_MAX_MESSAGES", "100"))
ATTACHMENT_TTL_DAYS = int(os.environ.get("HERMES_LEDGER_TTL_DAYS", "730"))
GMAIL_API_ROOT = "https://gmail.googleapis.com/gmail/v1"
TOKEN_URL = "https://oauth2.googleapis.com/token"


secretsmanager = boto3.client("secretsmanager", region_name=AWS_REGION)
dynamodb = boto3.resource("dynamodb", region_name=AWS_REGION)
s3 = boto3.client("s3", region_name=AWS_REGION)


REPORT_RULES = [
    ("risk-ranges", ("risk range", "risk-range", "risk_ranges", "processing signals")),
    ("early-look", ("early look", "early-look", "early_look")),
    ("crypto-quant", ("crypto quant",)),
    ("bitcoin-trend-tracker", ("bitcoin", "btc", "bitcoin trend tracker")),
    ("portfolio-solutions", ("portfolio solution", "portfolio-solutions")),
    ("momo-tracker", ("momo", "momentum tracker")),
    ("signal-strength", ("signal strength", "signal-strength")),
    ("real-time-alert", ("real-time alert", "real time alert")),
    ("the-macro-show", ("macro show", "the macro show")),
    ("the-call", ("the call", "call @ hedgeye", "hedgeye call")),
    ("volume", ("volume", "market share volume")),
    ("cftc-positioning", ("cftc", "positioning")),
    ("etf-pro", ("etf pro", "etf-pro", "etfpro")),
]


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def ttl_epoch() -> int:
    return int(time.time() + ATTACHMENT_TTL_DAYS * 24 * 60 * 60)


def load_oauth_secret() -> Dict[str, str]:
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
    return secret


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

    while len(message_ids) < MAX_MESSAGES:
        batch_size = min(100, MAX_MESSAGES - len(message_ids))
        params = {"q": GMAIL_QUERY, "maxResults": batch_size}
        if page_token:
            params["pageToken"] = page_token

        data = http_json("GET", gmail_path(user_id, "messages"), access_token=access_token, params=params)
        message_ids.extend(msg["id"] for msg in data.get("messages", []) if msg.get("id"))
        page_token = data.get("nextPageToken")
        if not page_token:
            break

    return message_ids


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
        return f"hedgeye/{type_folder}/{date_prefix}/{short_message_id}-{short_attachment_id}-{safe_name}"

    if report_type == "etf-pro" and ext in {".xlsx", ".xls", ".csv"}:
        return f"hedgeye/etfpro/email-ingest/{date_prefix}/{short_message_id}-{short_attachment_id}-{safe_name}"

    if attachment_id.startswith("message-body-"):
        return f"hedgeye-email/messages/{date_prefix}/{report_type}/{short_message_id}-{short_attachment_id}-{safe_name}"

    return f"hedgeye-email/attachments/{date_prefix}/{report_type}/{short_message_id}-{short_attachment_id}-{safe_name}"


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
    now = utc_now().isoformat()
    try:
        table.put_item(
            Item={
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
            },
            ConditionExpression="attribute_not_exists(messageId) OR #status = :error",
            ExpressionAttributeNames={"#status": "status"},
            ExpressionAttributeValues={":error": "ERROR"},
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


def backfill_html_snapshot(
    *,
    table: Any,
    message_id: str,
    attachment_id: str,
    report_type: str,
    mime_type: str,
    received_at: datetime,
) -> bool:
    if attachment_id.startswith("message-body-") is False or mime_type != "text/html":
        return False

    item = table.get_item(Key={"messageId": message_id, "attachmentId": attachment_id}).get("Item")
    if not item or not item.get("s3Bucket") or not item.get("s3Key"):
        return False
    if item.get("snapshotType") and report_type not in {"etf-pro", "real-time-alert", "the-macro-show"}:
        return False

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
            return False
        save_snapshot_to_dynamodb(snapshot, dynamodb)
        mark_attachment(
            table,
            message_id=message_id,
            attachment_id=attachment_id,
            status=item.get("status", "STORED"),
            extra={
                "snapshotType": snapshot["snapshotType"],
                "snapshotDate": snapshot["date"],
                "snapshotSource": snapshot["source"],
            },
        )
        return True
    except Exception as parse_err:
        mark_attachment(
            table,
            message_id=message_id,
            attachment_id=attachment_id,
            status=item.get("status", "STORED"),
            extra={"parseError": str(parse_err)[:1000]},
        )
        return False


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

    try:
        if attachment.get("inlineData"):
            content = decode_base64url(attachment["inlineData"])
        else:
            content = get_attachment_data(access_token, user_id, message_id, attachment_id)

        content_sha256 = hashlib.sha256(content).hexdigest()
        s3_key = build_s3_key(
            report_type=report_type,
            received_at=received_at,
            message_id=message_id,
            attachment_id=attachment_id,
            filename=filename,
        )

        metadata = {
            "source": "gmail",
            "gmail-message-id": message_id[:120],
            "gmail-attachment-id": attachment_id[:120],
            "report-type": report_type[:120],
        }
        s3.put_object(
            Bucket=S3_BUCKET,
            Key=s3_key,
            Body=content,
            ContentType=mime_type,
            Metadata=metadata,
        )
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
                    save_snapshot_to_dynamodb(snapshot, dynamodb)
                    extra["snapshotType"] = snapshot["snapshotType"]
                    extra["snapshotDate"] = snapshot["date"]
                    extra["snapshotSource"] = snapshot["source"]
            except Exception as parse_err:
                extra["parseError"] = str(parse_err)[:1000]

        mark_attachment(
            table,
            message_id=message_id,
            attachment_id=attachment_id,
            status="STORED",
            extra=extra,
        )
        return "stored", s3_key
    except Exception as err:
        mark_attachment(
            table,
            message_id=message_id,
            attachment_id=attachment_id,
            status="ERROR",
            extra={"error": str(err)[:1000]},
        )
        raise


def process_message(access_token: str, user_id: str, message_id: str, table: Any) -> Dict[str, Any]:
    message = get_message(access_token, user_id, message_id)
    headers = get_headers(message)
    received_at = parse_received_date(headers, message.get("internalDate"))
    attachments = extract_attachments(message)
    if not attachments:
        body_artifact = extract_message_body_artifact(message)
        if body_artifact:
            attachments = [body_artifact]

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

    return result


def lambda_handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    secret = load_oauth_secret()
    user_id = event.get("userId") or secret.get("user_id") or os.environ.get("GMAIL_USER_ID", "me")
    access_token = refresh_access_token(secret)
    table = dynamodb.Table(LEDGER_TABLE)

    message_ids = event.get("messageIds")
    if not message_ids:
        message_ids = list_message_ids(access_token, user_id)

    results = []
    errors = []
    for message_id in message_ids:
        try:
            results.append(process_message(access_token, user_id, message_id, table))
        except Exception as err:
            errors.append({"messageId": message_id, "error": str(err)})

    stored_count = sum(len(item["stored"]) for item in results)
    skipped_count = sum(len(item["skipped"]) for item in results)

    return {
        "statusCode": 207 if errors else 200,
        "body": json.dumps(
            {
                "query": GMAIL_QUERY,
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
