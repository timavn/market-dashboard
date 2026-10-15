"""Published quarterly GIP tables. OCR evidence is never a calculated quad.

Shared by Gmail, attached-PDF processing and the bounded operator replay.
Originals and OCR are content addressed; the small current projection uses CAS.
"""
from __future__ import annotations

import hashlib
import html
import io
import json
import os
import re
import urllib.parse
import urllib.request
from copy import deepcopy
from datetime import datetime, timezone
from decimal import Decimal
from html.parser import HTMLParser

from botocore.exceptions import ClientError

VERSION = 'global-quads-v1'
MIN_CONFIDENCE = 98.0
IMAGE_HOST = 'd1yhils6iwh5l5.cloudfront.net'
PREFIX = 'hedgeye-email/assets/global-quads/'
STATE_KEY = {'date': 'LATEST', 'snapshotType': 'global-quads'}
HEALTH_KEY = {'date': 'LATEST', 'snapshotType': 'global-quads-health'}
QUARTER = re.compile(r'^([1-4])Q(\d{2})(E?)$')
GROUPS = {'g20': 'G20 GIP Model Summary', 'em': 'Emerging Market GIP Model Summary'}


class QuadValidationError(ValueError):
    error_code = 'GLOBAL_QUADS_VALIDATION_FAILED'
    retryable = False


def eligible(subject, report_type=''):
    return report_type in {'global-quads', 'the-macro-show'} or bool(re.search(
        r'quads\s*/\s*gip|macro themes|quarterly macro|macro presentation|the macro show',
        subject or '', re.I))


def json_number(value):
    if isinstance(value, Decimal):
        return int(value) if value == value.to_integral_value() else float(value)
    raise TypeError(f"Unsupported research value: {type(value).__name__}")


def sha(value):
    if not isinstance(value, bytes):
        value = json.dumps(value, sort_keys=True, separators=(',', ':'), default=json_number).encode()
    return hashlib.sha256(value).hexdigest()


def decimalize(value):
    return json.loads(json.dumps(value, default=json_number), parse_float=Decimal)


def clean_image_url(value):
    parsed = urllib.parse.urlsplit(html.unescape(value or ''))
    if parsed.scheme == 'https' and parsed.hostname == IMAGE_HOST and parsed.path.startswith('/charts/'):
        return urllib.parse.urlunsplit(('https', IMAGE_HOST, parsed.path, '', ''))
    return None


class ChartImages(HTMLParser):
    def __init__(self):
        super().__init__()
        self.urls = []

    def handle_starttag(self, tag, attrs):
        if tag == 'img':
            url = clean_image_url(dict(attrs).get('src'))
            if url and url not in self.urls:
                self.urls.append(url)


def image_urls(body):
    parser = ChartImages()
    parser.feed(body)
    if len(parser.urls) > 64:
        raise QuadValidationError('Too many charts to inspect in one publication')
    return parser.urls


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def fetch_image(url):
    url = clean_image_url(url)
    if not url:
        raise QuadValidationError('Unapproved research image')
    request = urllib.request.Request(url, headers={'User-Agent': 'market-dashboard-hermes/1.0'})
    with urllib.request.build_opener(NoRedirect()).open(request, timeout=15) as response:
        if clean_image_url(response.url) != url:
            raise QuadValidationError('Unexpected research image redirect')
        payload = response.read(10_000_001)
    if len(payload) > 10_000_000 or not (payload.startswith(b'\x89PNG\r\n') or payload.startswith(b'\xff\xd8')):
        raise QuadValidationError('Invalid or oversized research image')
    return payload


def group_from_ocr(response):
    text = ' '.join(b.get('Text', '') for b in response.get('Blocks', []) if b['BlockType'] == 'LINE')
    if re.search(r'\bG20\s+GIP\s+Model\s+Summary\b', text, re.I):
        return 'g20'
    if re.search(r'Emerging\s+Markets?\s+GIP\s+Model\s+Summary', text, re.I):
        return 'em'
    return None


def cells_from_ocr(response):
    by = {b['Id']: b for b in response.get('Blocks', [])}
    tables = []
    for table in by.values():
        if table['BlockType'] != 'TABLE':
            continue
        cells = []
        for rel in table.get('Relationships', []):
            if rel['Type'] != 'CHILD':
                continue
            for ident in rel['Ids']:
                block = by[ident]
                if block['BlockType'] != 'CELL':
                    continue
                words = [by[i] for r in block.get('Relationships', []) if r['Type'] == 'CHILD'
                         for i in r['Ids'] if by[i]['BlockType'] == 'WORD']
                cells.append({
                    'row': block['RowIndex'], 'col': block['ColumnIndex'],
                    'text': ' '.join(w['Text'] for w in words).strip(),
                    'confidence': min((float(w.get('Confidence', 0)) for w in words), default=0),
                    'rowSpan': block.get('RowSpan', 1), 'colSpan': block.get('ColumnSpan', 1),
                    'box': block['Geometry']['BoundingBox'], 'words': words,
                })
        tables.append(cells)
    return tables


def table_cells(response):
    for cells in cells_from_ocr(response):
        rows = {}
        for cell in cells:
            rows.setdefault(cell['row'], []).append(cell)
        for index, row in rows.items():
            if sum(bool(QUARTER.fullmatch(c['text'].replace(' ', ''))) for c in row) >= 3:
                headers = sorted(row, key=lambda c: c['col'])
                # Only the quad matrix to the left of the first GDP COUNTRY column.
                stop = next((c['col'] for c in headers if c['text'].upper() == 'COUNTRY'), max(c['col'] for c in headers) + 1)
                return [c for c in cells if c['row'] >= index and c['col'] < stop], index
    raise QuadValidationError('Quarter header row could not be located unambiguously')


def png_bytes(image):
    buffer = io.BytesIO()
    image.save(buffer, format='PNG')
    return buffer.getvalue()


def crop_matrix(payload, full_response):
    from PIL import Image
    image = Image.open(io.BytesIO(payload)).convert('RGB')
    tables = [b for b in full_response['Blocks'] if b['BlockType'] == 'TABLE']
    country = [b for b in full_response['Blocks'] if b['BlockType'] == 'WORD' and b.get('Text', '').upper() == 'COUNTRY']
    if not tables or not country:
        return image
    table = min(tables, key=lambda b: b['Geometry']['BoundingBox']['Left'])['Geometry']['BoundingBox']
    right = min(b['Geometry']['BoundingBox']['Left'] for b in country)
    # Locate the column border, preserving the last quad heading and its cells.
    headers = [b for b in full_response['Blocks'] if b['BlockType'] == 'CELL'
               and b['Geometry']['BoundingBox']['Left'] < right
               and any(r['Type'] == 'CHILD' and any(i == w['Id'] for i in r['Ids'] for w in country) for r in b.get('Relationships', []))]
    if headers:
        right = min(b['Geometry']['BoundingBox']['Left'] for b in headers)
    matrix = image.crop((0, max(0, int(table['Top'] * image.height) - 2), int(right * image.width),
                         min(image.height, round((table['Top'] + table['Height']) * image.height) + 2)))
    return matrix.resize((matrix.width * 3, matrix.height * 3), Image.Resampling.LANCZOS)


def refine_cells(image, cells, tx):
    """Magnify source glyphs only; never substitute OCR text into an image."""
    from PIL import Image
    selected = [c for c in cells if c['text'] not in {'', '-', '—'} and c['confidence'] < MIN_CONFIDENCE]
    if not selected:
        return cells
    width, height = 1500, ((len(selected) + 4) // 5) * 100
    sheet = Image.new('RGB', (width, height), 'white')
    for i, cell in enumerate(selected):
        boxes = [w['Geometry']['BoundingBox'] for w in cell['words']]
        left = min(b['Left'] for b in boxes) * image.width
        top = min(b['Top'] for b in boxes) * image.height
        right = max(b['Left'] + b['Width'] for b in boxes) * image.width
        bottom = max(b['Top'] + b['Height'] for b in boxes) * image.height
        tile = image.crop((int(left)-2, int(top)-2, round(right)+2, round(bottom)+2))
        scale = min(50 / tile.height, 260 / tile.width)
        tile = tile.resize((max(1, round(tile.width * scale)), max(1, round(tile.height * scale))), Image.Resampling.LANCZOS)
        sheet.paste(tile, ((i % 5) * 300 + 20, (i // 5) * 100 + 20))
    result = tx.detect_document_text(Document={'Bytes': png_bytes(sheet)})
    found = {}
    by = {b['Id']: b for b in result['Blocks']}
    for block in result['Blocks']:
        if block['BlockType'] != 'LINE':
            continue
        box = block['Geometry']['BoundingBox']
        idx = int((box['Top'] + box['Height']/2) * height // 100) * 5 + int((box['Left'] + box['Width']/2) * width // 300)
        words = [by[w] for r in block.get('Relationships', []) if r['Type'] == 'CHILD' for w in r['Ids']]
        found.setdefault(idx, []).append((block['Text'], min((w.get('Confidence', 0) for w in words), default=0)))
    for i, cell in enumerate(selected):
        readings = found.get(i, [])
        if len(readings) == 1 and readings[0][1] >= MIN_CONFIDENCE:
            cell['text'], cell['confidence'] = readings[0]
    return cells


def parse_cells(cells, header_row, group, publication):
    by = {(c['row'], c['col']): c for c in cells}
    if len(by) != len(cells) or any(c.get('rowSpan', 1) != 1 or c.get('colSpan', 1) != 1 for c in cells):
        raise QuadValidationError('Overlapping or merged quad cells')
    headers = sorted((c for c in cells if c['row'] == header_row), key=lambda c: c['col'])
    columns = []
    for cell in headers[1:]:
        label = cell['text'].replace(' ', '')
        match = QUARTER.fullmatch(label)
        if not match or cell['confidence'] < MIN_CONFIDENCE:
            raise QuadValidationError(f'{GROUPS[group]}: uncertain quarter heading {label!r}')
        columns.append({'id': f'20{match[2]}-Q{match[1]}', 'label': label,
                        'kind': 'estimate' if match[3] else 'actual', 'column': cell['col']})
    if len({c['id'] for c in columns}) != len(columns) or len(columns) < 3:
        raise QuadValidationError('Duplicate or incomplete quarter headings')
    if [c['id'] for c in columns] != sorted(c['id'] for c in columns):
        raise QuadValidationError('Quarter headings are out of order')
    if [c['column'] for c in columns] != list(range(2, len(columns) + 2)):
        raise QuadValidationError('Quarter columns are not aligned')
    date_cell = headers[0]
    date_match = re.fullmatch(r'(\d{1,2})/(\d{1,2})/(\d{4})', date_cell['text'])
    effective = publication[:10]
    if not date_match and date_cell['text'] and re.search(r'\d', date_cell['text']):
        raise QuadValidationError('Unrecognized table as-of date')
    if date_match:
        if date_cell['confidence'] < MIN_CONFIDENCE:
            raise QuadValidationError('Uncertain table as-of date')
        month, day, year = map(int, date_match.groups())
        try:
            effective = datetime(year, month, day).date().isoformat()
        except ValueError as error:
            raise QuadValidationError('Invalid table as-of date') from error
    if effective > publication[:10]:
        raise QuadValidationError('Table as-of date is later than publication')
    rows = []
    for row_index in sorted({c['row'] for c in cells if c['row'] > header_row}):
        anchor = by.get((row_index, 1), {})
        name = re.sub(r'\s+', ' ', anchor.get('text', '')).strip()
        if not name or anchor.get('confidence', 0) < MIN_CONFIDENCE or not re.fullmatch(r'[A-Za-z /&().-]+', name):
            raise QuadValidationError(f'Uncertain country/aggregate in row {row_index}')
        values = {}
        for column in columns:
            cell = by.get((row_index, column['column']))
            if cell is None:
                raise QuadValidationError(f'Missing aligned cell: {name} {column["label"]}')
            text = cell['text'].strip()
            if text in {'-', '—'}:
                values[column['id']] = {'quad': None, 'kind': column['kind']}
            elif re.fullmatch('[1-4]', text) and cell['confidence'] >= MIN_CONFIDENCE:
                values[column['id']] = {'quad': int(text), 'kind': column['kind']}
            else:
                raise QuadValidationError(f'Uncertain quad: {name} {column["label"]} ({cell["confidence"]:.1f}%)')
        rows.append({'country': name, 'aggregate': bool(re.search(r'mode|median', name, re.I)), 'values': values})
    if len(rows) < 3 or len({r['country'] for r in rows}) != len(rows) or not any(r['aggregate'] for r in rows):
        raise QuadValidationError('Incomplete or duplicate country/aggregate rows')
    normalized = {'group': group, 'columns': [{k:v for k,v in c.items() if k != 'column'} for c in columns], 'rows': rows}
    return {**normalized, 'contentHash': sha(normalized), 'asOf': effective,
            'effectiveAt': effective if date_match else publication, 'parserVersion': VERSION}


def extract_table(payload, tx, cached_ocr=None):
    full = cached_ocr or tx.detect_document_text(Document={'Bytes': payload})
    group = group_from_ocr(full)
    if not group:
        return None, full
    if not any(b['BlockType'] == 'TABLE' for b in full['Blocks']):
        full = tx.analyze_document(Document={'Bytes': payload}, FeatureTypes=['TABLES'])
    matrix = crop_matrix(payload, full)
    cropped = tx.analyze_document(Document={'Bytes': png_bytes(matrix)}, FeatureTypes=['TABLES'])
    cells, header_row = table_cells(cropped)
    cells = refine_cells(matrix, cells, tx)
    return {'group': group, 'cells': cells, 'headerRow': header_row}, full


def merge_table(current, incoming, source):
    result = deepcopy(current or {})
    previous = result.get('groups', {}).get(incoming['group'])
    if previous:
        if previous['contentHash'] == incoming['contentHash']:
            return result, False
        if incoming['effectiveAt'] < previous['effectiveAt']:
            return result, False
        if incoming['effectiveAt'] == previous['effectiveAt']:
            raise QuadValidationError('Conflicting tables share the same source as-of date')
    merged = deepcopy(incoming)
    old_rows = {row['country']: row for row in (previous or {}).get('rows', [])}
    rows = []
    for row in incoming['rows']:
        old = old_rows.pop(row['country'], None)
        values = deepcopy((old or {}).get('values', {}))
        values.update({q: {**v, 'sourceId': source['id']} for q, v in row['values'].items()})
        rows.append({**row, 'values': values})
    # Older rows/periods remain sourced history, never a fill for a current blank.
    rows.extend(old_rows.values())
    columns = {c['id']: c for c in (previous or {}).get('columns', [])}
    columns.update({c['id']: c for c in incoming['columns']})
    merged.update({'rows': rows, 'columns': sorted(columns.values(), key=lambda c:c['id']), 'sourceId': source['id'],
                   'currentCountries': [r['country'] for r in incoming['rows']]})
    result.setdefault('groups', {})[incoming['group']] = merged
    result.setdefault('sources', {})[source['id']] = source
    used = {v['sourceId'] for g in result['groups'].values() for r in g['rows'] for v in r['values'].values()}
    result['sources'] = {k:v for k,v in result['sources'].items() if k in used}
    return result, True


class QuadStore:
    def __init__(self, db, s3, tx, bucket=None, enabled=None):
        self.table = db.Table(os.environ.get('HEDGEYE_DAILY_SNAPSHOT_TABLE', 'HedgeyeDailySnapshot'))
        self.s3, self.tx = s3, tx
        self.bucket = bucket or os.environ.get('HERMES_S3_BUCKET', 'market-dashboard-csv-data')
        self.enabled = os.environ.get('GLOBAL_QUADS_PUBLISH_ENABLED', '0') == '1' if enabled is None else enabled

    def load_json(self, key):
        try:
            return json.loads(self.s3.get_object(Bucket=self.bucket, Key=key)['Body'].read())
        except ClientError as error:
            if error.response['Error']['Code'] not in {'NoSuchKey', '404'}:
                raise
        return None

    def archive(self, key, data, kind='application/json'):
        try:
            self.s3.put_object(Bucket=self.bucket, Key=key, Body=data, ContentType=kind, IfNoneMatch='*')
        except ClientError as error:
            if error.response['Error']['Code'] not in {'PreconditionFailed', '412'}:
                raise

    def publish(self, candidate, source):
        history_key = {'date': candidate['contentHash'], 'snapshotType': 'global-quads-history'}
        old = self.table.get_item(Key=history_key, ConsistentRead=True).get('Item')
        # Do not re-date any already observed table, even after an intervening revision.
        if old:
            candidate, source = old['candidate'], old['source']
        else:
            try:
                self.table.put_item(Item=decimalize({**history_key, 'candidate': candidate, 'source': source}),
                                    ConditionExpression='attribute_not_exists(#d)', ExpressionAttributeNames={'#d':'date'})
            except ClientError as error:
                if error.response['Error']['Code'] != 'ConditionalCheckFailedException':
                    raise
                return self.publish(candidate, source)
        if not self.enabled:
            return 'validated'
        for _ in range(5):
            current = self.table.get_item(Key=STATE_KEY, ConsistentRead=True).get('Item') or {}
            merged, changed = merge_table(current.get('data'), candidate, source)
            if not changed:
                return 'unchanged'
            version = sha(merged)
            item = {**STATE_KEY, 'schemaVersion': 1, 'source': 'hedgeye-published-global-quads',
                    'reportDate': max(g['asOf'] for g in merged['groups'].values()), 'data': merged,
                    'publishedAt': max((s['publishedAt'] for s in merged['sources'].values() if s.get('publishedAt')), default=None),
                    'dataVersion': version, 'parserVersion': candidate['parserVersion']}
            condition = {'ConditionExpression': '#v = :v', 'ExpressionAttributeNames': {'#v':'dataVersion'},
                         'ExpressionAttributeValues': {':v': current['dataVersion']}} if current else {
                         'ConditionExpression': 'attribute_not_exists(#d)', 'ExpressionAttributeNames': {'#d':'date'}}
            try:
                self.table.put_item(Item=decimalize(item), **condition)
                return 'published'
            except ClientError as error:
                if error.response['Error']['Code'] != 'ConditionalCheckFailedException':
                    raise
        raise RuntimeError('Global Quads publication contention')

    def process_image(self, payload, publication, message_id, source_url, *, page=None):
        content_hash = sha(payload)
        extension = 'png' if payload.startswith(b'\x89PNG') else 'jpg'
        raw_key = f'{PREFIX}{content_hash}.{extension}'
        self.archive(raw_key, payload, f'image/{extension}')
        parsed_key = f'{PREFIX}{content_hash}.{VERSION}.json'
        cached = self.load_json(parsed_key)
        if cached is None:
            try:
                table, full = extract_table(payload, self.tx)
                self.archive(f'{PREFIX}{content_hash}.{VERSION}.ocr.json', json.dumps(full).encode())
                cached = {'table': table}
                self.archive(parsed_key, json.dumps(cached).encode())
            except QuadValidationError as error:
                cached = {'error': str(error)}
                self.archive(parsed_key, json.dumps(cached).encode())
        if cached.get('error'):
            raise QuadValidationError(cached['error'])
        if not cached.get('table'):
            return {'status': 'no-table'}
        parsed = cached['table']
        candidate = parse_cells(parsed['cells'], parsed['headerRow'], parsed['group'], publication)
        source = {'id': content_hash, 'gmailMessageId': message_id, 'publishedAt': publication,
                  'sourceUrl': f'https://mail.google.com/mail/#all/{message_id}',
                  'imageUrl': source_url, 's3Key': raw_key, 'page': page, 'asOf': candidate['asOf']}
        status = self.publish(candidate, source)
        return {'status': status, 'group': candidate['group'], 'asOf': candidate['asOf'], 'sourceId': content_hash}

    def process_html(self, *, html_body, received_at, message_id, **_):
        publication = received_at.astimezone(timezone.utc).isoformat()
        results, errors = [], []
        for url in image_urls(html_body):
            try:
                results.append(self.process_image(fetch_image(url), publication, message_id, url))
            except Exception as error:
                errors.append({'source': sha(url), 'detail': str(error)[:240],
                               'retryable': not isinstance(error, QuadValidationError)})
        self.health(message_id, publication, results, errors)
        if any(e['retryable'] for e in errors):
            error = RuntimeError('Global Quads source/OCR refresh failed; retry required')
            error.retryable = True
            error.error_code = 'GLOBAL_QUADS_REFRESH_FAILED'
            raise error
        return {'results': results, 'errors': errors}

    def process_pdf(self, payload, publication, message_id):
        import pdfplumber
        results, errors = [], []
        with pdfplumber.open(io.BytesIO(payload)) as pdf:
            if len(pdf.pages) > 250:
                raise QuadValidationError('Presentation exceeds the 250-page inspection limit')
            rendered = 0
            for number, page in enumerate(pdf.pages, 1):
                text = page.extract_text() or ''
                if text.strip() and not page.images and not re.search(r'GIP\s+Model\s+Summary', text, re.I):
                    continue
                rendered += 1
                if rendered > 40:
                    errors.append({'source': sha(payload), 'detail': 'Image-only presentation exceeds the 40-page OCR limit', 'retryable': False})
                    break
                try:
                    image = page.to_image(resolution=180).original
                    results.append(self.process_image(png_bytes(image), publication, message_id, None, page=number))
                except Exception as error:
                    errors.append({'source': f'page-{number}', 'detail': str(error)[:240], 'retryable': not isinstance(error, QuadValidationError)})
        self.health(message_id, publication, results, errors, artifact=sha(payload))
        if any(e['retryable'] for e in errors):
            raise RuntimeError('Global Quads attached PDF extraction requires retry')
        return {'results': results, 'errors': errors}

    def health(self, message_id, publication, results, errors, *, artifact='html'):
        # A new no-table email must not clear an unresolved extraction problem.
        for _ in range(5):
            old = self.table.get_item(Key=HEALTH_KEY, ConsistentRead=True).get('Item') or {}
            issues = deepcopy(old.get('issues', {}))
            remaining = [e for e in issues.get(message_id, {}).get('errors', []) if e.get('artifact', 'html') != artifact]
            combined = remaining + [{**e, 'artifact': artifact} for e in errors]
            if combined:
                issues[message_id] = {'publishedAt': publication, 'errors': combined}
            else:
                issues.pop(message_id, None)
                if {r.get('group') for r in results if r['status'] in {'published', 'unchanged'}} >= {'g20', 'em'}:
                    issues = {k:v for k,v in issues.items() if v['publishedAt'] >= publication}
            item = {**HEALTH_KEY, 'lastCheckedAt': datetime.now(timezone.utc).isoformat(),
                    'issues': issues, 'dataVersion': sha(issues), 'publishEnabled': self.enabled}
            condition = {'ConditionExpression':'#v = :v','ExpressionAttributeNames':{'#v':'dataVersion'},
                         'ExpressionAttributeValues':{':v':old['dataVersion']}} if old else {
                         'ConditionExpression':'attribute_not_exists(#d)','ExpressionAttributeNames':{'#d':'date'}}
            try:
                self.table.put_item(Item=decimalize(item), **condition)
                return
            except ClientError as error:
                if error.response['Error']['Code'] != 'ConditionalCheckFailedException':
                    raise
        raise RuntimeError('Global Quads health contention')
