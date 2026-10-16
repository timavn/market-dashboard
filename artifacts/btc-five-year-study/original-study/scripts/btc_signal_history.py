#!/usr/bin/env python3
"""Collect auditable BTC Crypto Tracker history for an offline experiment.

All cloud operations are reads. Research source artifacts are written only
beneath --output. Never updates dashboard ingestion. Connected-Gmail metadata
and HTML exports are explicit collection inputs; no OAuth secrets are read.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import datetime as dt
import decimal
import hashlib
import html
import json
import os
import re
import subprocess
import urllib.parse
import urllib.request
from email.utils import parsedate_to_datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import boto3
from dotenv import load_dotenv
from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parents[2]
UTC = dt.timezone.utc
ET = ZoneInfo('America/New_York')
AS_OF = '2026-09-15T18:10:12Z'
DEFAULT_OUTPUT = ROOT / 'artifacts/btc-hourly-bias-experiment/source-signals'
SWIFT_OCR = r'''
import Foundation
import Vision
import AppKit
let path = CommandLine.arguments[1]
guard let image = NSImage(contentsOfFile:path) else { exit(2) }
var rect = NSRect(origin:.zero,size:image.size)
guard let cg = image.cgImage(forProposedRect:&rect,context:nil,hints:nil) else { exit(3) }
let req = VNRecognizeTextRequest()
req.recognitionLevel = .accurate
req.usesLanguageCorrection = false
try VNImageRequestHandler(cgImage:cg,options:[:]).perform([req])
let rows:[[String:Any]] = (req.results ?? []).compactMap { r in
    guard let t = r.topCandidates(1).first else { return nil }
    return ["text":t.string,"confidence":t.confidence,
            "x":r.boundingBox.minX,"y":1-r.boundingBox.maxY,
            "width":r.boundingBox.width,"height":r.boundingBox.height]
}
let data = try JSONSerialization.data(withJSONObject:rows,options:[.sortedKeys])
print(String(data:data,encoding:.utf8)!)
'''


def json_default(value):
    if isinstance(value, decimal.Decimal):
        return int(value) if value % 1 == 0 else float(value)
    if isinstance(value, dt.datetime):
        return value.isoformat()
    raise TypeError(type(value).__name__)


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, default=json_default) + '\n')


def iso(value):
    return value.astimezone(UTC).isoformat().replace('+00:00', 'Z') if value else None


def parse_time(value):
    try:
        return dt.datetime.fromisoformat(str(value).replace('Z', '+00:00')).astimezone(UTC)
    except (ValueError, TypeError):
        return None


def cloud_clients():
    load_dotenv(ROOT / '.env', override=False)
    return boto3.Session(region_name=os.environ.get('AWS_REGION', 'us-west-1'))


def publication_time(text):
    match = re.search(r'(\d{2}/\d{2}/\d{4})\s+(\d{1,2}:\d{2})\s+([AP]M)\s+(EDT|EST)', text)
    if not match:
        return None
    date = dt.datetime.strptime(' '.join(match.groups()[:3]), '%m/%d/%Y %I:%M %p')
    zone = dt.timezone(dt.timedelta(hours=-4 if match[4] == 'EDT' else -5))
    return date.replace(tzinfo=zone).astimezone(UTC)


def receipt_time(message):
    """Inbox receipt evidence, never the sender-controlled Date header."""
    candidates = []
    if message.get('internalDate'):
        candidates.append(dt.datetime.fromtimestamp(int(message['internalDate']) / 1000, UTC))
    for header in message.get('payload', {}).get('headers', []):
        if header.get('name', '').lower() == 'received' and re.search(r'(?:by|from)\s+[^;]*google\.com', header.get('value', ''), re.I):
            try:
                candidates.append(parsedate_to_datetime(header['value'].rsplit(';', 1)[1]).astimezone(UTC))
            except (IndexError, ValueError, TypeError):
                pass
    return max(candidates) if candidates else None


def image_urls(raw):
    soup = BeautifulSoup(raw, 'html.parser')
    urls = []
    for tag in soup.find_all(['img', 'a']):
        url = html.unescape(tag.get('src') or tag.get('href') or '')
        if not url.startswith('https://'):
            continue
        # Preserve report-pinned image paths; remove email tracking only.
        url = urllib.parse.urlunsplit((*urllib.parse.urlsplit(url)[:3], '', ''))
        if 'cloudfront.net/charts/' in url and re.search(r'\.(?:png|jpe?g)$', url, re.I):
            if url not in urls:
                urls.append(url)
    return urls


def collect(args):
    output = args.output
    session = cloud_clients()
    table = session.resource('dynamodb').Table('HedgeyeDailySnapshot')
    index = table.query(IndexName=os.environ.get('HEDGEYE_SNAPSHOT_INDEX', 'snapshotType-date-meta-index'),
                        KeyConditionExpression=boto3.dynamodb.conditions.Key('snapshotType').eq('bitcoin-trend-tracker'),
                        ScanIndexForward=False, Limit=200)
    if index.get('LastEvaluatedKey'):
        raise RuntimeError('Archive exceeds bounded index query; explicit pagination needed')
    keys = [{'date': row['date'], 'snapshotType': row['snapshotType']} for row in index['Items']]
    rows = []
    for offset in range(0, len(keys), 100):
        response = session.resource('dynamodb').batch_get_item(RequestItems={
            'HedgeyeDailySnapshot': {'Keys': keys[offset:offset + 100], 'ConsistentRead': True}})
        if response.get('UnprocessedKeys'):
            raise RuntimeError('Incomplete source snapshot read')
        rows += response['Responses']['HedgeyeDailySnapshot']
    write_json(output / 'archive-snapshots.json', sorted(rows, key=lambda row: row['date']))
    # The connected Gmail app exports only the selected message metadata here.
    # The local AWS role intentionally cannot read Gmail OAuth secrets.
    inventory = json.loads((output / 'gmail-inventory.json').read_text())
    gmail_metadata = json.loads((output / 'gmail-metadata.json').read_text())
    metadata_by_id = {row['id']: row for row in gmail_metadata['messages'] if row.get('id')}
    ids = set(inventory['messageIds'])
    ids.update(row['gmailMessageId'] for row in rows if row.get('gmailMessageId'))
    snapshots_by_id = {row.get('gmailMessageId'): row for row in rows if row.get('gmailMessageId')}
    s3 = session.client('s3')
    def one(message_id):
        target = output / 'messages' / (message_id + '.json')
        html_path = output / 'html' / (message_id + '.html')
        if target.exists() and html_path.exists() and not args.refresh:
            cached = json.loads(target.read_text())
            if not cached.get('error'):
                return cached
        message = metadata_by_id.get(message_id, {'id': message_id})
        snapshot = snapshots_by_id.get(message_id, {})
        sender_date = next((header['value'] for header in message.get('payload', {}).get('headers', [])
                            if header.get('name', '').lower() == 'date'), None)
        report_date = snapshot.get('date')
        if sender_date:
            report_date = parsedate_to_datetime(sender_date).astimezone(ET).date().isoformat()
        key = snapshot.get('htmlSource')
        if not key and report_date:
            key = f'hedgeye-email/messages/{report_date}/crypto-quant/{message_id}-message-body-html-1-message-body.html'
        raw = None
        source_error = None
        if html_path.exists():
            raw = html_path.read_text()
        elif key:
            try:
                raw = s3.get_object(Bucket='market-dashboard-csv-data', Key=key)['Body'].read().decode('utf-8', errors='replace')
            except s3.exceptions.NoSuchKey:
                listing = s3.list_objects_v2(Bucket='market-dashboard-csv-data', Prefix=f'hedgeye-email/messages/{report_date}/', MaxKeys=200)
                candidates = [item['Key'] for item in listing.get('Contents', []) if message_id in item['Key'] and item['Key'].endswith('.html')]
                if len(candidates) == 1:
                    key = candidates[0]
                    raw = s3.get_object(Bucket='market-dashboard-csv-data', Key=key)['Body'].read().decode('utf-8', errors='replace')
                else:
                    source_error = 'NO_UNIQUE_ARCHIVED_HTML'
        if not raw:
            metadata = {'sourceMessageId': message_id, 'reportDate': report_date,
                        'receivedAt': iso(receipt_time(message)), 'error': source_error or 'NO_HTML_SOURCE'}
            write_json(target, metadata)
            return metadata
        text = BeautifulSoup(raw, 'html.parser').get_text(' ', strip=True)
        published = publication_time(text)
        received = receipt_time(message)
        headers = [header for header in message.get('payload', {}).get('headers', [])
                   if header.get('name', '').lower() in {'date', 'received', 'subject', 'from', 'message-id'}]
        metadata = {
            'sourceMessageId': message_id, 'publicationAt': iso(published), 'receivedAt': iso(received),
            'availableAt': iso(max(published, received)) if published and received else None,
            'reportDate': published.astimezone(ET).date().isoformat() if published else snapshots_by_id.get(message_id, {}).get('date'),
            'headers': headers, 'gmailInternalDate': message.get('internalDate'), 'imageUrls': image_urls(raw),
            'sourceUrl': 'https://mail.google.com/mail/u/0/#all/' + message_id,
            'htmlSha256': hashlib.sha256(raw.encode()).hexdigest(),
            'archiveSnapshotDate': snapshots_by_id.get(message_id, {}).get('date'),
            'archivedHtmlS3Key': key,
        }
        html_path.parent.mkdir(parents=True, exist_ok=True)
        html_path.write_text(raw)
        write_json(target, metadata)
        return metadata
    messages = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        for count, metadata in enumerate(pool.map(one, sorted(ids)), 1):
            messages.append(metadata)
            if count % 25 == 0:
                print(f'Collected {count}/{len(ids)} messages', flush=True)
    write_json(output / 'message-index.json', sorted(messages, key=lambda row: (row.get('reportDate') or '', row['sourceMessageId'])))
    print(json.dumps({'snapshots': len(rows), 'gmailMessages': len(inventory['messageIds']), 'collected': len(messages),
                      'errors': [row for row in messages if row.get('error')]}), flush=True)


def ocr(args):
    output = args.output
    runtime = output / 'runtime'
    runtime.mkdir(parents=True, exist_ok=True)
    source = runtime / 'tracker_ocr.swift'
    binary = runtime / 'tracker_ocr'
    if not source.exists() or source.read_text() != SWIFT_OCR or not binary.exists():
        source.write_text(SWIFT_OCR)
        subprocess.run(['swiftc', str(source), '-o', str(binary)], check=True, capture_output=True, timeout=90)
    messages = json.loads((output / 'message-index.json').read_text())
    selected = [row for row in messages if row.get('reportDate') and args.start <= row['reportDate'] <= args.end]
    if args.limit:
        selected = selected[:args.limit]
    def one(message):
        message_id = message['sourceMessageId']
        result_path = output / 'ocr' / (message_id + '.json')
        if result_path.exists() and not args.refresh:
            return json.loads(result_path.read_text())
        # Crypto Tracker's numeric second panel contains the risk-range table;
        # historical TREND_* panels are descriptive charts, not signal tables.
        urls = [url for url in message.get('imageUrls', [])
                if re.search(r'/(?:BTC_?2|2|CRR_[^/]+)\.png$', url, re.I)]
        urls.sort(key=lambda url: 0 if '/CRR_' in url else 1)
        if not urls:
            urls = message.get('imageUrls', [])[:3]
        candidates = []
        for url in urls:
            url_hash = hashlib.sha256(url.encode()).hexdigest()[:12]
            path = output / 'images' / message['reportDate'] / (url_hash + '-' + url.rsplit('/', 1)[1])
            headers_path = path.with_suffix(path.suffix + '.headers.json')
            path.parent.mkdir(parents=True, exist_ok=True)
            try:
                if not path.exists() or not headers_path.exists():
                    with urllib.request.urlopen(url, timeout=30) as response:
                        raw = response.read(5_000_001)
                        if len(raw) > 5_000_000:
                            raise ValueError('IMAGE_EXCEEDS_READ_BUDGET')
                        headers = {key: value for key, value in response.headers.items()
                                   if key.lower() in {'last-modified', 'etag', 'x-amz-version-id', 'content-type', 'content-length'}}
                    path.write_bytes(raw)
                    write_json(headers_path, headers)
                else:
                    headers = json.loads(headers_path.read_text())
                raw = path.read_bytes()
                recognized = json.loads(subprocess.check_output([str(binary), str(path)], timeout=45))
                candidates.append({'sourceUrl': url, 'imagePath': str(path.relative_to(output)),
                                   'headersPath': str(headers_path.relative_to(output)), 'headers': headers,
                                   'sha256': hashlib.sha256(raw).hexdigest(), 'observations': recognized})
            except Exception as error:
                candidates.append({'sourceUrl': url, 'error': type(error).__name__ + ': ' + str(error)})
        result = {'sourceMessageId': message_id, 'reportDate': message['reportDate'], 'candidates': candidates}
        write_json(result_path, result)
        return result
    results = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        for count, result in enumerate(pool.map(one, selected), 1):
            results.append(result)
            if count % 25 == 0:
                print(f'OCR {count}/{len(selected)} reports', flush=True)
    print(json.dumps({'ocrReports': len(results), 'noImages': sum(not row['candidates'] for row in results)}), flush=True)


def token(value):
    return re.sub(r'\s+', ' ', value.upper().replace('₿', 'B').replace('В', 'B')).strip()


def extract_table(candidate, message):
    observations = candidate.get('observations', [])
    buys = [row for row in observations if token(row['text']) == 'BUY TRADE']
    for buy in sorted(buys, key=lambda row: row['y']):
        headers = {key: next((row for row in observations if token(row['text']) == text
                              and abs(row['y'] - buy['y']) < 0.02), None)
                   for key, text in [('sell', 'SELL TRADE'), ('trend', 'TREND'), ('crypto', 'CRYPTO')]}
        if not all(headers.values()):
            continue
        btc = next((row for row in sorted(observations, key=lambda row: row['y'])
                    if token(row['text']) == 'BTC' and 0 < row['y'] - buy['y'] < 0.045
                    and abs(row['x'] - headers['crypto']['x']) < 0.10), None)
        if not btc:
            continue
        center_y = btc['y'] + btc['height'] / 2
        same_row = [row for row in observations
                    if abs(row['y'] + row['height'] / 2 - center_y) < max(0.006, btc['height'] * 0.7)]
        def cell(header):
            center_x = header['x'] + header['width'] / 2
            matches = [row for row in same_row if abs(row['x'] + row['width'] / 2 - center_x) < 0.07]
            return min(matches, key=lambda row: abs(row['x'] + row['width'] / 2 - center_x)) if matches else None
        trend_cell, low_cell, high_cell = cell(headers['trend']), cell(buy), cell(headers['sell'])
        trend = token(trend_cell['text']) if trend_cell else None
        if trend not in {'BULLISH', 'BEARISH', 'NEUTRAL'}:
            continue
        def number(observation):
            if not observation or observation['confidence'] < 0.8:
                return None
            raw = observation['text'].replace(',', '').replace('$', '').strip()
            return float(raw) if re.fullmatch(r'\d+(?:\.\d+)?', raw) else None
        low, high = number(low_cell), number(high_cell)
        range_ok = low is not None and high is not None and 0 < low < high
        headers_lower = {key.lower(): value for key, value in candidate.get('headers', {}).items()}
        modified = None
        try:
            modified = parsedate_to_datetime(headers_lower.get('last-modified', '')).astimezone(UTC)
        except (ValueError, TypeError):
            pass
        available = parse_time(message.get('availableAt'))
        pinned = bool(re.search(r'/charts/resized/\d+/original/', candidate['sourceUrl']))
        # Original dated email binds the image URL; HTTP version metadata proves
        # the fetched bytes predate the information-availability cutoff.
        identity_verified = pinned and bool(modified and available and modified <= available)
        reasons = []
        if not pinned:
            reasons.append('UNPINNED_IMAGE_URL')
        if not modified:
            reasons.append('IMAGE_VERSION_DATE_UNAVAILABLE')
        elif available and modified > available:
            reasons.append('IMAGE_REVISED_AFTER_REPORT_AVAILABILITY')
        if not message.get('publicationAt'):
            reasons.append('EXACT_PUBLICATION_TIME_UNAVAILABLE')
        if not message.get('receivedAt'):
            reasons.append('TRUSTED_RECEIPT_TIME_UNAVAILABLE')
        if trend_cell['confidence'] < 0.9:
            reasons.append('DIRECTION_OCR_CONFIDENCE_LOW')
        return {'trend': trend, 'lrr': low if range_ok else None, 'hrr': high if range_ok else None,
                'rangeQuality': 'verified_source_ocr' if range_ok else 'unavailable',
                'directionEligible': identity_verified and not reasons,
                'exclusionReason': ';'.join(reasons) or None,
                'sourceUrl': candidate['sourceUrl'], 'imageSha256': candidate['sha256'],
                'imageModifiedAt': iso(modified), 'imageIdentityVerified': identity_verified,
                'dateAudit': 'dated_original_email_url_and_version_modified_before_availability',
                'printedExactDate': None, 'directionConfidence': trend_cell['confidence'],
                'tableRow': sorted(same_row, key=lambda row: row['x']),
                'tableBox': {'top': buy['y'] - .035, 'bottom': center_y + .02},
                'evidencePaths': [candidate['imagePath'], candidate['headersPath']]}
    return None


def assemble(args):
    output = args.output
    messages = json.loads((output / 'message-index.json').read_text())
    reviews = {}
    for path in sorted((output / 'visual-review').glob('*reviews.json')):
        reviews.update(json.loads(path.read_text()).get('reviews', {}))
    records = []
    excluded_source_reports = []
    for message in messages:
        message_id = message['sourceMessageId']
        subject = next((header['value'] for header in message.get('headers', []) if header['name'].lower() == 'subject'), '')
        if subject and not re.search(r'CRYPTO\s+QUANT|BITCOIN\s+TREND\s+TRACKER', subject, re.I):
            excluded_source_reports.append({'sourceMessageId': message_id, 'reportDate': message['reportDate'],
                                            'subject': subject, 'reason': 'NOT_CRYPTO_TRACKER_REPORT'})
            continue
        path = output / 'ocr' / (message_id + '.json')
        candidates = json.loads(path.read_text()).get('candidates', []) if path.exists() else []
        extractions = [row for row in (extract_table(candidate, message) for candidate in candidates) if row]
        extraction = extractions[0] if extractions else {
            'trend': None, 'lrr': None, 'hrr': None, 'rangeQuality': 'unavailable',
            'directionEligible': False, 'exclusionReason': 'BTC_SOURCE_TABLE_UNRECOVERED', 'evidencePaths': []}
        review = reviews.get(message_id)
        if review:
            candidate = next((candidate for candidate in candidates if candidate.get('sha256') == review['imageSha256']
                              and candidate['sourceUrl'] == review['sourceUrl']), None)
            if candidate is None:
                raise ValueError('Visual review does not match original bytes: ' + message_id)
            modified_text = next((value for key, value in candidate['headers'].items() if key.lower() == 'last-modified'), None)
            modified = parsedate_to_datetime(modified_text).astimezone(UTC) if modified_text else None
            available = parse_time(message.get('availableAt'))
            eligible = bool(modified and available and modified <= available and message.get('receivedAt') and message.get('publicationAt'))
            low, high = review.get('lrr'), review.get('hrr')
            range_ok = low is not None and high is not None and 0 < low < high
            extraction.update({'trend': review['trend'], 'lrr': low if range_ok else None, 'hrr': high if range_ok else None,
                               'rangeQuality': 'visually_verified_original' if range_ok else 'unavailable',
                               'directionEligible': eligible, 'exclusionReason': None if eligible else 'REVIEWED_SOURCE_TIMING_UNAVAILABLE',
                               'sourceUrl': candidate['sourceUrl'], 'imageSha256': candidate['sha256'],
                               'imageModifiedAt': iso(modified), 'imageIdentityVerified': eligible,
                               'dateAudit': 'dated_original_email_url_and_version_modified_before_availability',
                               'printedExactDate': None, 'visualReview': review,
                               'evidencePaths': [candidate['imagePath'], candidate['headersPath']]})
        record = {key: message.get(key) for key in ['reportDate', 'publicationAt', 'receivedAt', 'availableAt', 'sourceMessageId', 'sourceUrl']}
        record.update(extraction)
        record['sourceImageUrl'] = record.get('sourceUrl') if record.get('imageSha256') else None
        record['sourceUrl'] = message.get('sourceUrl')
        record['quality'] = 'verified_source_ocr' if record['directionEligible'] else 'excluded'
        record['evidencePaths'] += [f'html/{message_id}.html', f'messages/{message_id}.json', f'ocr/{message_id}.json']
        records.append(record)
    records.sort(key=lambda row: (row['reportDate'] or '', row.get('availableAt') or '', row['sourceMessageId']))
    transitions = []
    previous = None
    for record in records:
        if record['directionEligible']:
            if previous is None or previous['trend'] != record['trend']:
                transitions.append({'reportDate': record['reportDate'], 'sourceMessageId': record['sourceMessageId'],
                                    'from': previous['trend'] if previous else None, 'to': record['trend'],
                                    'previousReportDate': previous['reportDate'] if previous else None,
                                    'evidencePaths': record['evidencePaths'][:2]})
        previous = record if record['directionEligible'] else None
    write_json(output / 'extraction-candidates.json', {'asOf': AS_OF, 'records': records, 'transitionsToReview': transitions,
                                                     'excludedSourceReports': excluded_source_reports})
    print(json.dumps({'records': len(records), 'eligible': sum(row['directionEligible'] for row in records),
                      'transitionsToReview': len(transitions),
                      'unrecoveredDates': [row['reportDate'] for row in records if not row['trend']],
                      'excludedWithTrend': [{'date': row['reportDate'], 'reason': row['exclusionReason']} for row in records if row['trend'] and not row['directionEligible']]}), flush=True)


def finalize(args):
    assemble(args)
    output = args.output
    extracted = json.loads((output / 'extraction-candidates.json').read_text())
    records = [record for record in extracted['records'] if args.start <= record['reportDate'] <= args.end]
    pending = [transition['reportDate'] for transition in extracted['transitionsToReview']
               if args.start <= transition['reportDate'] <= args.end
               if not next(record for record in records if record['sourceMessageId'] == transition['sourceMessageId']).get('visualReview')]
    if pending:
        raise ValueError('Transitions still require visual review: ' + ', '.join(pending))
    calendar_script = """
const {isMarketDay}=require('./src/utils/analyticsDailyBrief.cjs');
const rows=[];for(let date=new Date(process.argv[1]+'T12:00:00Z');date<=new Date(process.argv[2]+'T12:00:00Z');date.setUTCDate(date.getUTCDate()+1)){
rows.push({date:date.toISOString().slice(0,10),expectedPublicationDay:isMarketDay(date),weekend:[0,6].includes(date.getUTCDay())});}
process.stdout.write(JSON.stringify(rows));
"""
    calendar = json.loads(subprocess.check_output(['node', '-e', calendar_script, args.start, args.end], cwd=ROOT))
    report_dates = {record['reportDate'] for record in records}
    missing_market_days = [row['date'] for row in calendar if row['expectedPublicationDay'] and row['date'] not in report_dates]
    nonpublication = [{'date': row['date'], 'classification': 'weekend' if row['weekend'] else 'US_market_holiday',
                       'evidence': 'No matching report in complete Gmail inventory and dated snapshot archive; scheduled nonpublication day.'}
                      for row in calendar if not row['expectedPublicationDay'] and row['date'] not in report_dates]
    def effective(record):
        return parse_time(record['availableAt']) or dt.datetime.fromisoformat(record['reportDate']).replace(tzinfo=ET).astimezone(UTC)
    records.sort(key=lambda record: (effective(record), record['sourceMessageId']))
    cutoff = parse_time(AS_OF)
    gap_events = []
    for index, record in enumerate(records):
        starts = effective(record)
        record['validUntil'] = iso(effective(records[index + 1])) if index + 1 < len(records) else AS_OF
        if not record['directionEligible']:
            end = next((effective(future) for future in records[index + 1:] if future['directionEligible']), cutoff)
            gap_events.append({'startAt': iso(starts), 'endAt': iso(end), 'reason': record['exclusionReason'],
                               'sourceMessageIds': [record['sourceMessageId']], 'reportDates': [record['reportDate']]})
    for date in missing_market_days:
        starts = dt.datetime.fromisoformat(date).replace(tzinfo=ET).astimezone(UTC)
        end = next((effective(record) for record in records if record['directionEligible'] and effective(record) > starts), cutoff)
        gap_events.append({'startAt': iso(starts), 'endAt': iso(end), 'reason': 'EXPECTED_REPORT_NOT_FOUND_IN_SOURCE_INVENTORY',
                           'sourceMessageIds': [], 'reportDates': [date]})
    interruptions = []
    for gap in sorted(gap_events, key=lambda item: item['startAt']):
        if interruptions and parse_time(gap['startAt']) <= parse_time(interruptions[-1]['endAt']):
            previous = interruptions[-1]
            previous['endAt'] = iso(max(parse_time(previous['endAt']), parse_time(gap['endAt'])))
            previous['reason'] = ';'.join(sorted(set(previous['reason'].split(';') + gap['reason'].split(';'))))
            previous['reportDates'] = sorted(set(previous['reportDates'] + gap['reportDates']))
            previous['sourceMessageIds'] = sorted(set(previous['sourceMessageIds'] + gap['sourceMessageIds']))
        else:
            interruptions.append(dict(gap))
    for record in records:
        upcoming = [parse_time(gap['startAt']) for gap in interruptions
                    if effective(record) < parse_time(gap['startAt']) < parse_time(record['validUntil'])]
        if upcoming:
            record['validUntil'] = iso(min(upcoming))
    current = None
    if records and records[-1]['directionEligible']:
        first = len(records) - 1
        state = records[-1]['trend']
        while first > 0:
            previous = records[first - 1]
            between_gap = any(effective(previous) < parse_time(gap['endAt']) <= effective(records[first]) for gap in interruptions)
            if not previous['directionEligible'] or previous['trend'] != state or between_gap:
                break
            first -= 1
        prior = records[first - 1] if first else None
        verified_flip = bool(prior and prior['directionEligible'] and prior['trend'] != state
                             and not any(effective(prior) < parse_time(gap['endAt']) <= effective(records[first]) for gap in interruptions))
        current = {'trend': state, 'startedAt': records[first]['availableAt'], 'firstReportDate': records[first]['reportDate'],
                   'onsetQuality': 'verified_flip' if verified_flip else 'earliest_verified_after_gap',
                   'previousTrend': prior['trend'] if verified_flip else None,
                   'previousReportDate': prior['reportDate'] if verified_flip else None,
                   'sourceMessageId': records[first]['sourceMessageId'], 'sourceUrl': records[first]['sourceUrl'],
                   'explanation': ('Consecutive original reports verify the change; the signal begins at trusted inbox receipt, after publication.'
                                   if verified_flip else 'This is the earliest verified report after the data boundary or an unresolved gap; earlier onset is unknown.')}
    result = {'schemaVersion': 1, 'asOf': AS_OF, 'source': 'Hedgeye Crypto Quant / Bitcoin Trend Tracker original publications',
              'ticker': 'BTC', 'signalField': 'published TREND (positioning bias); trade is an alias, not a second signal',
              'records': records, 'interruptions': interruptions, 'currentRegime': current,
              'nonpublicationDates': nonpublication, 'unresolvedPublicationDates': missing_market_days,
              'publicationCadence': json.loads((output / 'publication-cadence.json').read_text()),
              'excludedSourceReports': extracted['excludedSourceReports'],
              'coverage': {'from': args.start, 'through': args.end, 'reportVersions': len(records),
                           'uniqueReportDates': len(report_dates), 'directionEligibleReports': sum(row['directionEligible'] for row in records),
                           'rangeEligibleReports': sum(row['directionEligible'] and row['lrr'] is not None for row in records),
                           'visuallyReviewedReports': sum(bool(row.get('visualReview')) for row in records),
                           'directionTransitionsReviewed': len(extracted['transitionsToReview']),
                           'archiveSnapshots': len(json.loads((output / 'archive-snapshots.json').read_text()))},
              'methodology': ['Use only the original published BTC table; never infer direction from price, color-only historical charts, headlines, or IBIT.',
                              'Availability is max(exact publication header, Gmail internal timestamp, trusted Gmail Received). Never use midnight publishedAt.',
                              'Image URLs come from dated original emails; save bytes, SHA256, ETag/version and require last-modified no later than availability.',
                              'All recovered direction changes and representative repeats receive visual inspection; low-confidence or inaccessible evidence is excluded.',
                              'Known invalid reports stop signal carry. Missing timing interrupts at report-date midnight Eastern. Expected weekday report gaps are excluded.',
                              'Hedgeye\'s official Bitcoin Trend Tracker User Guide specifies publication before the U.S. stock market opens on trading days; see publication-cadence.json.',
                              'Carry the last published research state between reports, including weekends/US-market holidays with no exceptional report in the full mailbox inventory. This is a stated analysis convention, not a new observed signal.',
                              'This is historical research, not executable quotes.']}
    write_json(output / 'signals.json', result)
    print(json.dumps({'coverage': result['coverage'], 'interruptions': interruptions, 'currentRegime': current}), flush=True)


def self_test():
    import unittest
    class SourceEvidenceTests(unittest.TestCase):
        def test_publication_offsets(self):
            self.assertEqual(iso(publication_time('08/20/2026 08:37 AM EDT')), '2026-08-20T12:37:00Z')
            self.assertEqual(iso(publication_time('01/20/2026 08:37 AM EST')), '2026-01-20T13:37:00Z')
            self.assertIsNone(publication_time('08/20/2026'))

        def test_sender_date_is_not_receipt(self):
            self.assertIsNone(receipt_time({'payload': {'headers': [{'name': 'Date', 'value': 'Thu, 20 Aug 2026 08:37:00 -0400'}]}}))

        def test_latest_trusted_receipt(self):
            message = {'internalDate': str(int(parse_time('2026-08-20T12:38:00Z').timestamp() * 1000)),
                       'payload': {'headers': [{'name': 'Received', 'value': 'from server by mx.google.com; Thu, 20 Aug 2026 05:38:43 -0700'}]}}
            self.assertEqual(iso(receipt_time(message)), '2026-08-20T12:38:43Z')

        def table(self):
            def box(text, x, y, confidence=1):
                return {'text': text, 'x': x, 'y': y, 'width': .08, 'height': .01, 'confidence': confidence}
            observations = [box('Crypto', .05, .20), box('Buy TRADE', .30, .20), box('Sell TRADE', .50, .20), box('TREND', .70, .20),
                            box('BTC', .05, .22), box('60,000', .30, .22), box('70,000', .50, .22), box('BULLISH', .70, .22)]
            candidate = {'sourceUrl': 'https://source.example/charts/resized/123/original/BTC_2.png',
                         'headers': {'Last-Modified': 'Thu, 20 Aug 2026 12:00:00 GMT'}, 'sha256': 'unit-test',
                         'imagePath': 'test.png', 'headersPath': 'test.headers.json', 'observations': observations}
            message = {'publicationAt': '2026-08-20T12:37:00Z', 'receivedAt': '2026-08-20T12:38:43Z', 'availableAt': '2026-08-20T12:38:43Z'}
            return candidate, message

        def test_source_version_must_predate_availability(self):
            candidate, message = self.table()
            self.assertTrue(extract_table(candidate, message)['directionEligible'])
            candidate['headers']['Last-Modified'] = 'Thu, 20 Aug 2026 14:00:00 GMT'
            result = extract_table(candidate, message)
            self.assertFalse(result['directionEligible'])
            self.assertIn('IMAGE_REVISED_AFTER_REPORT_AVAILABILITY', result['exclusionReason'])

        def test_missing_receipt_excludes_direction(self):
            candidate, message = self.table()
            message['receivedAt'] = message['availableAt'] = None
            result = extract_table(candidate, message)
            self.assertFalse(result['directionEligible'])
            self.assertIn('TRUSTED_RECEIPT_TIME_UNAVAILABLE', result['exclusionReason'])

        def test_range_quality_independent_from_direction(self):
            candidate, message = self.table()
            candidate['observations'][5]['text'] = 'Unreadable'
            result = extract_table(candidate, message)
            self.assertTrue(result['directionEligible'])
            self.assertIsNone(result['lrr'])

        def test_never_infer_trend_from_price(self):
            candidate, message = self.table()
            candidate['observations'][-1]['text'] = '5%'
            self.assertIsNone(extract_table(candidate, message))
    result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(SourceEvidenceTests))
    if not result.wasSuccessful():
        raise SystemExit(1)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument('--refresh', action='store_true')
    parser.add_argument('--start', default='2025-07-28')
    parser.add_argument('--end', default='2026-09-15')
    parser.add_argument('--limit', type=int)
    parser.add_argument('command', choices=['collect', 'ocr', 'assemble', 'finalize', 'self-test'])
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    if args.command == 'collect':
        collect(args)
    elif args.command == 'ocr':
        ocr(args)
    elif args.command == 'assemble':
        assemble(args)
    elif args.command == 'finalize':
        finalize(args)
    elif args.command == 'self-test':
        self_test()


if __name__ == '__main__':
    main()
