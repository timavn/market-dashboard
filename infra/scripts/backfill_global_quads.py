#!/usr/bin/env python3
"""Bounded, resumable email-only Global Quads replay. No browser/deck-link access.

Inventory is the default. --apply archives sources, performs metered OCR and
records candidates/health. --publish additionally promotes validated tables.
"""
import argparse
import json
import sys
import time
import threading
import queue
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path
from aws_profile_contract import verified_session

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'infra/lambdas/gmail_ingestor'))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--publish', action='store_true')
    parser.add_argument('--max-messages', type=int, default=1000)
    parser.add_argument('--message-id', action='append')
    parser.add_argument('--cache-dir', type=Path, default=ROOT / '.cache/global-quads/backfill')
    args = parser.parse_args()
    if args.publish and not args.apply:
        parser.error('--publish requires --apply')
    if not 1 <= args.max_messages <= 1500:
        parser.error('--max-messages must be between 1 and 1500')
    session = verified_session('market-dashboard-admin', purpose='admin')
    import hermes_gmail_ingestor as gmail
    from global_quads import QuadStore, VERSION
    gmail.secretsmanager = session.client('secretsmanager')
    secret = gmail.load_oauth_secret()
    token = gmail.refresh_access_token(secret)
    user = secret.get('user_id', 'me')
    gmail.get_profile_history_id(token, user)
    args.cache_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    ids = args.message_id or []
    if not ids:
        after = (datetime.now(timezone.utc)-timedelta(days=365)).strftime('%Y/%m/%d')
        query = f'from:hedgeye.com after:{after} {{subject:"Quads/GIP" subject:"Macro Themes" subject:"Macro Show" subject:"quarterly macro" subject:"macro presentation"}}'
        page = None
        while True:
            params = {'q':query, 'maxResults':100}
            if page: params['pageToken']=page
            result = gmail.http_json('GET', gmail.gmail_path(user,'messages'),access_token=token,params=params)
            ids.extend(m['id'] for m in result.get('messages',[]))
            page=result.get('nextPageToken')
            if len(ids)>args.max_messages:
                raise RuntimeError('Inventory exceeds the configured bound; no extraction started')
            if not page:break
    print(json.dumps({'stage':'discovered','messages':len(ids)}),flush=True)
    messages=[]
    for ident in dict.fromkeys(ids):
        path=args.cache_dir/f'{ident}.json'
        if not path.exists():
            for attempt in range(5):
                try:
                    content = gmail.get_message(token,user,ident)
                    path.write_text(json.dumps(content));path.chmod(0o600)
                    time.sleep(0.3)
                    break
                except RuntimeError as error:
                    if not any(word in str(error).lower() for word in ['quota exceeded', 'rate limit', '429']) or attempt == 4:
                        raise
                    print(json.dumps({'stage':'gmail-throttled','retryAfterSeconds':30}),flush=True)
                    time.sleep(30)
        message=json.loads(path.read_text());messages.append(message)
    messages.sort(key=lambda m:int(m['internalDate']))
    print(json.dumps({'stage':'inventory','messages':len(messages),'apply':args.apply,'publish':args.publish}),flush=True)
    if not args.apply:return
    workers = 1 if args.publish else 6
    stores = queue.Queue()
    for _ in range(workers):
        stores.put(QuadStore(session.resource('dynamodb'),session.client('s3'),session.client('textract'),enabled=args.publish))
    local = threading.local()
    def initialize_worker():
        local.store = stores.get()
    def process_message(message):
        store = local.store
        ident=message['id'];receipt=args.cache_dir/f'{ident}.{VERSION}.{"published" if args.publish else "validated"}.json'
        if receipt.exists():
            previous=json.loads(receipt.read_text())
            if not previous.get('retryable'):return None
        received=datetime.fromtimestamp(int(message['internalDate'])/1000,tz=timezone.utc)
        body=gmail.extract_message_body_artifact(message)
        try:
            result={'results':[],'errors':[]}
            if body:
                content=gmail.decode_base64url(body['inlineData'])
                store.archive(f'hedgeye-email/global-quads/{received.date()}/{ident}.html',content,'text/html')
                result=store.process_html(html_body=content.decode('utf8'),received_at=received,message_id=ident)
            for attachment in gmail.extract_attachments(message):
                if attachment['mimeType']!='application/pdf' and not attachment['filename'].lower().endswith('.pdf'):continue
                payload=gmail.decode_base64url(attachment['inlineData']) if attachment.get('inlineData') else gmail.get_attachment_data(token,user,ident,attachment['attachmentId'])
                pdf=store.process_pdf(payload,received.isoformat(),ident)
                result['results'].extend(pdf['results']);result['errors'].extend(pdf['errors'])
            output={'messageId':ident,'date':received.date().isoformat(),**result}
        except Exception as error:
            output={'messageId':ident,'date':received.date().isoformat(),'error':str(error)[:240],'retryable':True}
        receipt.write_text(json.dumps(output));return output
    with ThreadPoolExecutor(max_workers=workers, initializer=initialize_worker) as executor:
        for output in executor.map(process_message, messages):
            if output: print(json.dumps(output),flush=True)

if __name__=='__main__':main()
