#!/usr/bin/env python3
"""Overlay Analyst hooks onto backed-up deployed packages, preserving newer parsers.
Stage is the default; --apply deploys the reviewed packages and narrow runtime policies.
One-minute scheduling remains a separate, cost-gated command.
"""
import argparse, ast, hashlib, json, zipfile
from pathlib import Path
import boto3

PDF_HOOK = '''        from analyst_change_journal import emit_change
        emit_change({"snapshotType": product_id, "reportType": product_id, "date": market_date,
                     "data": data, "pdfS3Key": s3_key, "gmailMessageId": message_id,
                     "publishedAt": published_at, "scrapedAt": datetime.now(timezone.utc).isoformat()},
                    dynamodb, {"marketDate": market_date, "productKey": product_id, "stage": "indexed"},
                    events, content_sha256)
'''

def pdf_hook(source):
    anchor = '        _mark_processing_stage(\n            stage="indexed",'
    assert source.count(anchor) == 1
    return source.replace(anchor, PDF_HOOK + anchor)

def stage(backup, root):
    outputs = []
    for name in ['market-dashboard-gmail-ingestor-v2', 'market-dashboard-hedgeye-pdf-processor-v1']:
        source = backup / f'{name}.zip'
        with zipfile.ZipFile(source) as z:
            files = {info.filename: (info, z.read(info.filename)) for info in z.infolist()}
        patches = {'analyst_change_journal.py': (root / 'infra/lambdas/gmail_ingestor/analyst_change_journal.py').read_bytes()}
        if 'gmail' in name:
            handler = files['hermes_gmail_ingestor.py'][1].decode()
            offset = handler.index('def lambda_handler(')
            before, after = handler[:offset], handler[offset:]
            assert '    event = event or {}\n' in after
            after = after.replace('    event = event or {}\n', '    event = event or {}\n    from analyst_cost_guard import check_fast_polling\n    if not check_fast_polling(event, dynamodb):\n        return {"statusCode": 200, "body": json.dumps({"status": "cost_guard_slowdown", "cadenceMinutes": 15})}\n', 1)
            patches['hermes_gmail_ingestor.py'] = (before + after).encode()
            research = files['research_intelligence.py'][1].decode()
            start, end = research.index('def finalize_snapshot_intelligence('), research.index('\ndef persist_snapshot_failure(')
            hook = research[start:end].replace('return update_product_manifest(', 'manifest = update_product_manifest(').rstrip() + '\n    from analyst_change_journal import emit_change\n    emit_change(snapshot, dynamodb, manifest, build_entity_events(snapshot, content_sha256=content_sha256), content_sha256)\n    return manifest\n\n'
            patches['research_intelligence.py'] = (research[:start] + hook + research[end:]).encode()
            patches['analyst_cost_guard.py'] = (root / 'infra/lambdas/gmail_ingestor/analyst_cost_guard.py').read_bytes()
        else:
            patches['hedgeye_pdf_processor_lambda.py'] = pdf_hook(files['hedgeye_pdf_processor_lambda.py'][1].decode()).encode()
        for filename, content in patches.items():
            ast.parse(content, filename=filename)
        output = backup / f'{name}.analyst.zip'
        with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as z:
            for filename, (info, content) in files.items():
                z.writestr(info, patches.pop(filename, content))
            for filename, content in patches.items():
                z.writestr(filename, content)
        with zipfile.ZipFile(output) as z:
            changed = [n for n in z.namelist() if n not in files or z.read(n) != files[n][1]]
        outputs.append((name, output, changed))
    return outputs

def apply(outputs, backup, session):
    lam, iam, scheduler = session.client('lambda'), session.client('iam'), session.client('scheduler')
    schedule = scheduler.get_schedule(Name='market-dashboard-gmail-v2-every-15m')
    (backup / 'schedule.before.json').write_text(json.dumps(schedule, default=str, indent=2))
    for name, package, changed in outputs:
        config = lam.get_function_configuration(FunctionName=name)
        role = config['Role'].split('/')[-1]
        account = config['FunctionArn'].split(':')[4]
        statements = [{'Effect': 'Allow', 'Action': ['dynamodb:GetItem', 'dynamodb:PutItem'], 'Resource': f'arn:aws:dynamodb:us-west-1:{account}:table/ResearchEventLedgerV2'}]
        if 'gmail' in name:
            statements += [{'Effect': 'Allow', 'Action': 'cloudwatch:GetMetricStatistics', 'Resource': '*'}, {'Effect': 'Allow', 'Action': ['scheduler:GetSchedule', 'scheduler:UpdateSchedule'], 'Resource': schedule['Arn']}, {'Effect': 'Allow', 'Action': 'iam:PassRole', 'Resource': schedule['Target']['RoleArn'], 'Condition': {'StringEquals': {'iam:PassedToService': 'scheduler.amazonaws.com'}}}]
        policy = {'Version': '2012-10-17', 'Statement': statements}
        (backup / f'{name}.analyst-policy.json').write_text(json.dumps(policy, indent=2))
        iam.put_role_policy(RoleName=role, PolicyName='AnalystValidatedJournalAndCostGuard', PolicyDocument=json.dumps(policy))
        lam.update_function_code(FunctionName=name, ZipFile=package.read_bytes(), RevisionId=config['RevisionId'])
        lam.get_waiter('function_updated_v2').wait(FunctionName=name, WaiterConfig={'Delay': 3, 'MaxAttempts': 40})
        config = lam.get_function_configuration(FunctionName=name)
        variables = {**config.get('Environment', {}).get('Variables', {}), 'ANALYST_CHANGE_JOURNAL_ENABLED': '1', 'RESEARCH_EVENT_LEDGER_TABLE': 'ResearchEventLedgerV2'}
        if 'gmail' in name:
            variables['ANALYST_FAST_POLLING_ENABLED'] = '1'
        lam.update_function_configuration(FunctionName=name, Environment={'Variables': variables}, RevisionId=config['RevisionId'])
        lam.get_waiter('function_updated_v2').wait(FunctionName=name, WaiterConfig={'Delay': 3, 'MaxAttempts': 40})
        print(json.dumps({'function': name, 'status': 'deployed', 'changedFiles': changed, 'sha256': hashlib.sha256(package.read_bytes()).hexdigest()}), flush=True)

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('backup', type=Path)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    outputs = stage(args.backup, root)
    for name, output, changed in outputs:
        print(json.dumps({'function': name, 'package': str(output), 'changedFiles': changed}), flush=True)
    if args.apply:
        apply(outputs, args.backup, boto3.Session(profile_name='market-dashboard-admin', region_name='us-west-1'))
