"""Conservative faster-polling guard. No free-tier credits or savings discounts assumed."""
from datetime import datetime, timedelta, timezone
from decimal import Decimal
import calendar
import os
import boto3

SCHEDULE = 'market-dashboard-gmail-v2-every-15m'
FUNCTION = 'market-dashboard-gmail-ingestor-v2'
TABLES = ['ResearchEventLedgerV2', 'HermesEmailIngestLedger', 'ResearchEntityEventsV1', 'ResearchProductManifestsV1', 'HedgeyeDailySnapshot']
KEY = {'productKey': 'analyst-cost-guard', 'eventKey': 'current'}
# Deliberately rounded upward versus public on-demand pricing. Existing shared-table
# usage is included, making this an upper bound on incremental cost.
RATES = {'gbSecond': 0.000020, 'lambdaRequest': 0.00000025, 'readUnit': 0.00000030, 'writeUnit': 0.00000150, 'logByte': 0.70 / 1e9, 'scheduleRequest': 0.000001, 'metricCall': 0.00002}


def projection(duration, resources, *, days, elapsed_days, memory_mb=512):
    if not duration or elapsed_days <= 0:
        return {'complete': False, 'cadenceMinutes': 15, 'reason': 'Usage evidence unavailable'}
    samples = sum(float(p.get('SampleCount', 0)) for p in duration)
    if samples <= 0:
        return {'complete': False, 'cadenceMinutes': 15, 'reason': 'Duration samples unavailable'}
    total_seconds = sum(float(p.get('Sum', 0)) for p in duration) / 1000
    # Twice the maximum observed hour-average allows ample runtime variability.
    conservative_seconds = max(2.0, 2 * max(float(p.get('Average', 0)) for p in duration) / 1000)
    requests = days * 1440
    memory_gb = memory_mb / 1024
    parts = {'lambdaCompute': requests * memory_gb * conservative_seconds * RATES['gbSecond'], 'lambdaRequests': requests * RATES['lambdaRequest'], 'scheduler': requests * RATES['scheduleRequest'], 'cloudwatchApi': days * 24 * 14 * RATES['metricCall'], 'otherAwsReserve': 3.0}
    actual = total_seconds * memory_gb * RATES['gbSecond'] + samples * (RATES['lambdaRequest'] + RATES['scheduleRequest'])
    for name, (amount, rate) in resources.items():
        parts[name] = max(float(amount) * days / elapsed_days * rate, 0)
        actual += float(amount) * rate
    projected = sum(parts.values())
    # Reserve is prorated for elapsed time; all shared-table costs are charged to this guard.
    actual += 3.0 * elapsed_days / days
    safe = projected < 15 and actual < 15
    return {'complete': True, 'projectedMonthly': round(projected, 4), 'monthToDateUpperBound': round(actual, 4), 'components': {k: round(v, 4) for k, v in parts.items()}, 'cadenceMinutes': 1 if safe else 15, 'threshold': 15, 'budget': 20, 'reason': 'Below conservative threshold' if safe else 'Cost guard threshold reached', 'sampleCount': samples, 'conservativeDurationSeconds': conservative_seconds}


def measure(session=None, now=None):
    session = session or boto3
    now = now or datetime.now(timezone.utc)
    start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    cw = session.client('cloudwatch')
    def metric(namespace, name, dimensions, statistics):
        return cw.get_metric_statistics(Namespace=namespace, MetricName=name, Dimensions=dimensions, StartTime=start, EndTime=now, Period=3600, Statistics=statistics).get('Datapoints', [])
    duration = metric('AWS/Lambda', 'Duration', [{'Name': 'FunctionName', 'Value': FUNCTION}], ['Average', 'Sum', 'SampleCount'])
    resources = {}
    for table in TABLES:
        for suffix, metric_name, rate in [('reads', 'ConsumedReadCapacityUnits', RATES['readUnit']), ('writes', 'ConsumedWriteCapacityUnits', RATES['writeUnit'])]:
            points = metric('AWS/DynamoDB', metric_name, [{'Name': 'TableName', 'Value': table}], ['Sum'])
            resources[f'{table}.{suffix}'] = (sum(p['Sum'] for p in points), rate)
    points = metric('AWS/Logs', 'IncomingBytes', [{'Name': 'LogGroupName', 'Value': f'/aws/lambda/{FUNCTION}'}], ['Sum'])
    resources['logs'] = (sum(p['Sum'] for p in points), RATES['logByte'])
    result = projection(duration, resources, days=calendar.monthrange(now.year, now.month)[1], elapsed_days=max(1/24, (now-start).total_seconds()/86400), memory_mb=int(os.environ.get('AWS_LAMBDA_FUNCTION_MEMORY_SIZE', '512')))
    result['measuredAt'] = now.isoformat()
    return result


def set_cadence(minutes, session=None):
    client = (session or boto3).client('scheduler')
    saved = client.get_schedule(Name=SCHEDULE)
    expression = f'rate({minutes} minute' + ('s)' if minutes != 1 else ')')
    if saved.get('ScheduleExpression') == expression:
        return True
    allowed = ['Name', 'GroupName', 'Description', 'ScheduleExpression', 'StartDate', 'EndDate', 'ScheduleExpressionTimezone', 'State', 'KmsKeyArn', 'Target', 'FlexibleTimeWindow', 'ActionAfterCompletion']
    update = {k: v for k, v in saved.items() if k in allowed}
    update['ScheduleExpression'] = expression
    client.update_schedule(**update)
    return False


def check_fast_polling(event, dynamodb, now=None):
    if os.environ.get('ANALYST_FAST_POLLING_ENABLED', '0') != '1' or event.get('source') != 'aws-scheduler':
        return True
    now = now or datetime.now(timezone.utc)
    ledger = dynamodb.Table('ResearchEventLedgerV2')
    result = None
    try:
        result = ledger.get_item(Key=KEY, ConsistentRead=True).get('Item', {}).get('measurement')
        measured = datetime.fromisoformat(str((result or {}).get('measuredAt') or '1970-01-01T00:00:00+00:00'))
        if (now - measured).total_seconds() > 3600:
            result = measure(now=now)
            import json
            ledger.put_item(Item={**KEY, 'measurement': json.loads(json.dumps(result), parse_float=Decimal)})
        if not result.get('complete') or result.get('cadenceMinutes') != 1:
            # Rate schedules keep their creation phase, which need not land on
            # UTC quarter-hours. Once the scheduler confirms the slow cadence,
            # each invocation is eligible; skip the invocation that slows it.
            return set_cadence(15)
        return True
    except Exception as exc:
        # Incomplete cost evidence stops faster work even if schedule update is unavailable.
        print(f'Analyst cost guard unavailable: {type(exc).__name__}; requiring verified 15-minute work cadence')
        try:
            return set_cadence(15)
        except Exception:
            return False
