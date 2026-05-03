#!/usr/bin/env python3
"""
Idempotent Hedgeye PDF processing ledger (DynamoDB).

Before Textract-heavy runs (batch backfill), conditional-write this table so each distinct
PDF payload is processed once per snapshotType.

Environment:
  HEDGEYE_PROCESSING_LEDGER_TABLE — default HedgeyeProcessingLedger
  AWS_REGION — default us-west-1
"""

from __future__ import annotations

import hashlib
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

DEFAULT_TABLE = os.environ.get('HEDGEYE_PROCESSING_LEDGER_TABLE', 'HedgeyeProcessingLedger')
DEFAULT_REGION = os.environ.get('AWS_REGION', os.environ.get('AWS_DEFAULT_REGION', 'us-west-1'))


def sha256_file(path: Path, chunk_size: int = 1024 * 1024) -> str:
    """SHA-256 hex digest of file contents."""
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        while True:
            block = f.read(chunk_size)
            if not block:
                break
            h.update(block)
    return h.hexdigest()


def ledger_key(snapshot_type: str, content_sha256: str) -> Dict[str, str]:
    """Primary key: snapshotType (HASH) + contentSha256 (RANGE)."""
    return {'snapshotType': snapshot_type, 'contentSha256': content_sha256}


def get_existing_item(
    snapshot_type: str,
    content_sha256: str,
    *,
    table_name: str = DEFAULT_TABLE,
    region_name: str = DEFAULT_REGION,
) -> Optional[Dict[str, Any]]:
    import boto3

    db = boto3.resource('dynamodb', region_name=region_name)
    tbl = db.Table(table_name)
    resp = tbl.get_item(Key=ledger_key(snapshot_type, content_sha256))
    return resp.get('Item')


def try_claim_pdf_processed(
    *,
    snapshot_type: str,
    content_sha256: str,
    report_date: Optional[str],
    pdf_s3_key: Optional[str],
    dynamo_snapshot_key: Optional[str],
    processor_version: str = '1',
    table_name: str = DEFAULT_TABLE,
    region_name: str = DEFAULT_REGION,
) -> Tuple[bool, Optional[str]]:
    """
    Attempt idempotent insert. Returns (claimed_new, error_message).

    claimed_new True when this PDF hash was not yet recorded for snapshotType.
    """
    import boto3
    from botocore.exceptions import ClientError

    db = boto3.resource('dynamodb', region_name=region_name)
    tbl = db.Table(table_name)
    ts = datetime.now(timezone.utc).isoformat()
    item = {
        **ledger_key(snapshot_type, content_sha256),
        'processedAt': ts,
        'processorVersion': processor_version,
    }
    if report_date:
        item['reportDate'] = report_date
    if pdf_s3_key:
        item['pdfSource'] = pdf_s3_key
    if dynamo_snapshot_key:
        item['dynamoSnapshotKey'] = dynamo_snapshot_key

    try:
        tbl.put_item(
            Item=item,
            ConditionExpression='attribute_not_exists(snapshotType) AND attribute_not_exists(contentSha256)',
        )
        return True, None
    except ClientError as e:
        if e.response['Error']['Code'] == 'ConditionalCheckFailedException':
            return False, None
        return False, str(e)
