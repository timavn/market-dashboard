import json
import os
from decimal import Decimal
from datetime import datetime
import boto3


dynamodb = boto3.resource('dynamodb')

PORTFOLIO_TABLE = os.environ.get('PORTFOLIO_TABLE', 'PortfolioSnapshots')
HOLDINGS_TABLE = os.environ.get('HOLDINGS_TABLE', 'Holdings')


def decimal_default(o):
    if isinstance(o, Decimal):
        return float(o)
    raise TypeError


def get_latest_snapshot():
    """Return the latest snapshot item by scanning and picking max timestamp."""
    table = dynamodb.Table(PORTFOLIO_TABLE)
    response = table.scan()
    items = response.get('Items', [])

    if not items:
        return None

    # Choose latest by timestamp ISO string; also keep snapshotId
    latest = max(items, key=lambda x: x.get('timestamp', ''))
    return latest


def get_holdings_for_snapshot(snapshot_id: str):
    """Return all holdings for a given snapshotId via scan filter."""
    table = dynamodb.Table(HOLDINGS_TABLE)

    holdings = []
    scan_kwargs = {}
    while True:
        resp = table.scan(**scan_kwargs)
        for item in resp.get('Items', []):
            if item.get('snapshotId') == snapshot_id:
                holdings.append(item)
        if 'LastEvaluatedKey' not in resp:
            break
        scan_kwargs['ExclusiveStartKey'] = resp['LastEvaluatedKey']

    return holdings


def lambda_handler(event, context):
    try:
        latest = get_latest_snapshot()
        if not latest:
            return {
                'statusCode': 404,
                'body': json.dumps({'message': 'No snapshots found'})
            }

        snapshot_id = latest['snapshotId']
        holdings = get_holdings_for_snapshot(snapshot_id)

        response_body = {
            'snapshot': latest,
            'holdings': holdings,
        }

        return {
            'statusCode': 200,
            'headers': {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
            },
            'body': json.dumps(response_body, default=decimal_default)
        }
    except Exception as e:
        return {
            'statusCode': 500,
            'body': json.dumps({'message': 'Internal error', 'error': str(e)})
        }
