"""Small validated-publication journal shared by Gmail and PDF ingestion."""
import hashlib
import json
import os
from datetime import datetime, timezone
from decimal import Decimal


def emit_change(snapshot, dynamodb, manifest, events, content_sha256=None):
    if os.environ.get('ANALYST_CHANGE_JOURNAL_ENABLED', '0') != '1':
        return
    events = list(events)
    # Position instructions are journaled as typed actions so the Analyst can
    # match them against held positions; Investing Ideas "N Changes" emails
    # carry their side and range from the email body.
    labels = {'real-time-alert': 'Real-Time Alert', 'investing-ideas': 'Investing Ideas'}
    data = snapshot.get('data')
    # CFTC positioning stores its rows as a list; only dict payloads carry alerts.
    for alert in (data if isinstance(data, dict) else {}).get('alerts', []):
        product = snapshot.get('snapshotType')
        if product not in labels or not alert.get('ticker'):
            continue
        events.append({
            'entityType': 'security', 'entityId': alert['ticker'], 'qualityStatus': 'validated',
            'productKey': product, 'productLabel': labels[product], 'eventType': 'position_action',
            'fieldPath': 'data.alert.action', 'action': alert.get('action'), 'positionSide': alert.get('side'),
            **({'riskRange': {'lrr': alert['riskRangeLow'], 'hrr': alert['riskRangeHigh']}}
               if alert.get('riskRangeLow') is not None and alert.get('riskRangeHigh') is not None else {}),
            'sourceEventId': snapshot.get('gmailMessageId') or content_sha256,
            'sourceMessageId': snapshot.get('gmailMessageId'), 'contentSha256': content_sha256,
            'marketDate': snapshot.get('date'), 'publishedAt': snapshot.get('publishedAt') or snapshot.get('receivedAt') or snapshot.get('scrapedAt'),
            'excerpt': alert.get('headline') or alert.get('signalPhrase'), 'sourceUrl': snapshot.get('htmlSource') or snapshot.get('source'),
        })
    # A parser correction can change verified values without changing the
    # original source bytes or entity references. Journal that parsed revision
    # so every consumer receives it, while ignoring ingestion-only metadata.
    revision = {k: v for k, v in snapshot.items() if k not in {
        'rawText', 'html', 'body', 'text', 'ttl', 'capturedAt', 'updatedAt',
        'scrapedAt', 'ingestedAt', 'receivedAt',
    }}
    digest = hashlib.sha256(json.dumps([snapshot.get('gmailMessageId'), content_sha256, events, revision], sort_keys=True, default=str).encode()).hexdigest()
    journal = dynamodb.Table(os.environ.get('RESEARCH_EVENT_LEDGER_TABLE', 'ResearchEventLedgerV2'))
    receipt = {'productKey': 'analyst-change-receipts', 'eventKey': digest}
    if journal.get_item(Key=receipt, ConsistentRead=True).get('Item'):
        return
    body = {k: v for k, v in snapshot.items() if k not in {'rawText', 'html', 'body', 'text'}}
    if len(json.dumps(body, default=str).encode()) > 180000:
        # Keep the immutable source pointer. The local index reads bounded validated
        # entity excerpts; the source itself stays available in the existing archive.
        body = {k: body.get(k) for k in ('snapshotType', 'reportType', 'date', 'publishedAt', 'scrapedAt', 'gmailMessageId', 'htmlSource', 'pdfS3Key', 's3Key', 'sourceArtifact', 'article')}
        body['data'] = {'publicationIndexed': True}
    captured = datetime.now(timezone.utc).isoformat()
    chunks = [events[i:i+40] for i in range(0, len(events), 40)] or [[]]
    for index, chunk in enumerate(chunks):
        chunk_body = dict(body)
        if body.get('data') == {'publicationIndexed': True}:
            chunk_body['data'] = {'validatedEntityEvents': chunk}
        item = {'productKey': 'analyst-change', 'eventKey': f'{captured}#{digest}#{index:04d}', 'capturedAt': captured, 'stage': 'indexed', 'snapshot': chunk_body, 'entityEvents': chunk, 'manifest': {k: manifest.get(k) for k in ('marketDate', 'productKey', 'stage', 'updatedAt', 'version')}}
        serialized = json.dumps(item, default=str)
        if len(serialized.encode()) > 380000:
            raise ValueError('Validated journal record exceeds the bounded DynamoDB item size')
        journal.put_item(Item=json.loads(serialized, parse_float=Decimal))
    journal.put_item(Item={**receipt, 'capturedAt': captured})
