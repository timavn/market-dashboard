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
    """Return all holdings for a given snapshotId via GSI query."""
    table = dynamodb.Table(HOLDINGS_TABLE)
    
    try:
        response = table.query(
            IndexName='snapshotId-index',
            KeyConditionExpression=boto3.dynamodb.conditions.Key('snapshotId').eq(snapshot_id)
        )
        return response.get('Items', [])
    except Exception as e:
        print(f"Error querying holdings: {e}")
        # Fallback (optional, but good for safety during index creation) or return empty
        return []


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
