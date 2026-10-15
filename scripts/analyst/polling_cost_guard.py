#!/usr/bin/env python3
"""Inspect or enable the approved one-minute schedule only after a live cost projection."""
import argparse
from pathlib import Path
import sys
import json
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'infra/lambdas/gmail_ingestor'))
import boto3
from analyst_cost_guard import measure, set_cadence, KEY
from decimal import Decimal
parser = argparse.ArgumentParser()
parser.add_argument('--enable', action='store_true')
parser.add_argument('--profile', default='market-dashboard-admin')
args = parser.parse_args()
session = boto3.Session(profile_name=args.profile, region_name='us-west-1')
measurement = measure(session)
print(json.dumps(measurement, indent=2))
if args.enable:
    if not measurement.get('complete') or measurement['cadenceMinutes'] != 1:
        raise SystemExit('Faster polling withheld by the cost projection.')
    function = session.client('lambda').get_function_configuration(FunctionName='market-dashboard-gmail-ingestor-v2')
    variables = function.get('Environment', {}).get('Variables', {})
    if variables.get('ANALYST_FAST_POLLING_ENABLED') != '1':
        raise SystemExit('Deploy and verify the Lambda cost guard before enabling its schedule.')
    session.resource('dynamodb').Table('ResearchEventLedgerV2').put_item(Item={**KEY, 'measurement': json.loads(json.dumps(measurement), parse_float=Decimal)})
    set_cadence(1, session)
    print('Enabled one-minute Gmail polling with the $15 slowdown guard.')
