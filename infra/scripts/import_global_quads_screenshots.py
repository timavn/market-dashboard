#!/usr/bin/env python3
"""Import visually reviewed, publisher-sourced quad screenshots. Preview by default.

This is an operator import, separate from the unattended 98% OCR gate. A review
binds the transcription to the original image hash; it never asserts OCR scores.
"""
import argparse
import json
import re
import sys
from datetime import date, datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'lambdas/gmail_ingestor'))
from botocore.exceptions import ClientError
from global_quads import QuadStore, QuadValidationError, PREFIX, QUARTER, STATE_KEY, HEALTH_KEY, decimalize, json_number, merge_table, sha

VERSION = 'global-quads-screenshot-v1'
GROUPS = {'g20', 'em', 'global'}
METHOD = 'visual-source-comparison'


def prepare_table(table, title):
    if table.get('group') not in GROUPS:
        raise QuadValidationError('Unknown quad table group')
    try:
        as_of = date.fromisoformat(table['asOf'])
    except (KeyError, ValueError) as error:
        raise QuadValidationError('A printed table date is required') from error
    if as_of.isoformat() != table['asOf'] or as_of > datetime.now(timezone.utc).date():
        raise QuadValidationError('Invalid or future table date')
    payload = Path(table['image']).read_bytes()
    image_hash = sha(payload)
    if image_hash != table.get('imageSha256') or not payload.startswith(b'\x89PNG\r\n\x1a\n'):
        raise QuadValidationError('Screenshot does not match the reviewed original')
    columns = []
    for label in table.get('columns', []):
        match = QUARTER.fullmatch(label)
        if not match:
            raise QuadValidationError('Unrecognized published quarter label')
        columns.append({'id': f'20{match[2]}-Q{match[1]}', 'label': label,
                        'kind': 'estimate' if match[3] else 'actual'})
    ids = [c['id'] for c in columns]
    if len(ids) < 3 or ids != sorted(set(ids)):
        raise QuadValidationError('Quarter headings must be complete, unique, and ordered')
    rows = []
    for row in table.get('rows', []):
        country = row.get('country', '')
        values = row.get('values', [])
        if not re.fullmatch(r'[A-Za-z /&().-]+', country) or not country.strip() or len(values) != len(columns):
            raise QuadValidationError('Country or quarter alignment is invalid')
        if any(v is not None and (type(v) is not int or v not in {1, 2, 3, 4}) for v in values):
            raise QuadValidationError('Quad readings must be published 1–4 or an explicit missing cell')
        aggregate = country.startswith('MODE/')
        if row.get('aggregate') is not aggregate:
            raise QuadValidationError('Published aggregate designation does not match its label')
        rows.append({'country': country, 'aggregate': aggregate,
                     'values': {c['id']: {'quad': v, 'kind': c['kind']} for c, v in zip(columns, values)}})
    if len(rows) < 3 or len({r['country'] for r in rows}) != len(rows) or not any(r['aggregate'] for r in rows):
        raise QuadValidationError('Incomplete or duplicate country/aggregate rows')
    normalized = {'group': table['group'], 'columns': columns, 'rows': rows}
    content_hash = sha(normalized)
    review = table.get('review', {})
    try:
        reviewed_at = datetime.fromisoformat(review.get('reviewedAt', '').replace('Z', '+00:00'))
    except ValueError as error:
        raise QuadValidationError('A recorded visual review is required') from error
    if (review.get('method') != METHOD or not review.get('reviewedBy') or review.get('contentHash') != content_hash
            or reviewed_at.tzinfo is None or reviewed_at > datetime.now(timezone.utc)
            or reviewed_at.date() < as_of):
        raise QuadValidationError('Review does not match the source transcription')
    candidate = {**normalized, 'contentHash': content_hash, 'asOf': as_of.isoformat(),
                 'effectiveAt': as_of.isoformat(), 'parserVersion': VERSION}
    source = {'id': image_hash, 'sourceType': 'reviewed-screenshot', 'sourceTitle': title,
              'asOf': as_of.isoformat(), 'publishedAt': None, 'receivedAt': review['reviewedAt'],
              's3Key': f'{PREFIX}{image_hash}.png', 'parserVersion': VERSION, 'verification': review}
    return candidate, source, payload


def import_reviewed(manifest, store, apply=False):
    title = manifest.get('sourceTitle', '')
    if manifest.get('schemaVersion') != 1 or not title or not manifest.get('tables'):
        raise QuadValidationError('A titled screenshot review manifest is required')
    prepared = [prepare_table(table, title) for table in manifest['tables']]
    if (len({candidate['group'] for candidate, _, _ in prepared}) != len(prepared)
            or len({source['id'] for _, source, _ in prepared}) != len(prepared)):
        raise QuadValidationError('Each group requires its own reviewed source image')
    current = store.table.get_item(Key=STATE_KEY, ConsistentRead=True).get('Item') or {}
    staged = current.get('data')
    for candidate, source, _ in prepared:
        staged, _ = merge_table(staged, candidate, source)
    results = []
    for candidate, source, payload in prepared:
        status = 'preview'
        if apply:
            store.archive(source['s3Key'], payload, 'image/png')
            store.archive(f'{PREFIX}{source["id"]}.{VERSION}.{candidate["contentHash"]}.review.json',
                          json.dumps({'candidate': candidate, 'source': source}).encode())
            status = store.publish(candidate, source)
        results.append({'group': candidate['group'], 'asOf': candidate['asOf'], 'status': status,
                        'rows': len(candidate['rows']), 'quarters': len(candidate['columns']),
                        'sourceId': source['id']})
    if apply:
        mark_screenshot_mode(store, results)
    return results


def mark_screenshot_mode(store, results):
    # Preserve inactive email issues for investigation. The user has chosen
    # screenshot updates; those email errors are not active feed failures.
    for _ in range(5):
        old = store.table.get_item(Key=HEALTH_KEY, ConsistentRead=True).get('Item') or {}
        store.archive(f'{PREFIX}control-history/{sha(old)}.json', json.dumps(old, default=json_number).encode())
        now = datetime.now(timezone.utc).isoformat()
        item = {**old, **HEALTH_KEY, 'mode': 'reviewed-screenshot', 'lastCheckedAt': now,
                'lastImportedAt': now, 'publishEnabled': False, 'lastImport': results,
                'dataVersion': sha({'mode': 'reviewed-screenshot', 'results': results, 'issues': old.get('issues', {})})}
        condition = {'ConditionExpression': '#v = :v', 'ExpressionAttributeNames': {'#v': 'dataVersion'},
                     'ExpressionAttributeValues': {':v': old['dataVersion']}} if old else {
                     'ConditionExpression': 'attribute_not_exists(#d)', 'ExpressionAttributeNames': {'#d': 'date'}}
        try:
            store.table.put_item(Item=decimalize(item), **condition)
            return
        except ClientError as error:
            if error.response['Error']['Code'] != 'ConditionalCheckFailedException':
                raise
    raise RuntimeError('Global Quads import health contention')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('manifest', type=Path)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    from aws_profile_contract import verified_session
    session = verified_session('market-dashboard-admin', purpose='admin')
    store = QuadStore(session.resource('dynamodb'), session.client('s3'), None, enabled=args.apply)
    results = import_reviewed(json.loads(args.manifest.read_text()), store, args.apply)
    print(json.dumps(results, indent=2))


if __name__ == '__main__':
    main()
