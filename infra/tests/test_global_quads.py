import io
import sys
import unittest
from copy import deepcopy
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from unittest.mock import Mock, patch
from botocore.exceptions import ClientError
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'lambdas/gmail_ingestor'))
import global_quads as q


def cells():
    rows = [['8/27/2026', '2Q26', '3Q26E', '4Q26E', '1Q27E'],
            ['United States', '3', '4', '2', '4'], ['China', '3', '1', '1', '3'],
            ['MODE/MEDIAN', '3', '3', '2', '4']]
    return [{'row': r+1, 'col': c+1, 'text': v, 'confidence': 99.5} for r, row in enumerate(rows) for c,v in enumerate(row)]


def candidate():
    return q.parse_cells(cells(), 1, 'g20', '2026-08-31T14:22:14+00:00')


def source(id='a'):
    return {'id': id*64, 'asOf': '2026-08-27', 'publishedAt': '2026-08-31T14:22:14+00:00',
            'sourceUrl': 'https://mail.google.com/mail/#all/abc', 'gmailMessageId': 'abc',
            's3Key': q.PREFIX+id*64+'.png'}


class GlobalQuadsTest(unittest.TestCase):
    def test_extracts_explicit_asof_estimates_and_aggregate(self):
        result = candidate()
        self.assertEqual(result['asOf'], '2026-08-27')
        self.assertEqual(result['rows'][0]['values']['2026-Q3'], {'quad':4,'kind':'estimate'})
        self.assertEqual(result['rows'][-1]['country'], 'MODE/MEDIAN')
        self.assertEqual(result['columns'][-1]['id'], '2027-Q1')

    def test_low_confidence_anchor_or_value_is_held(self):
        for index in [0, 1, 5, 6]:
            with self.subTest(index=index):
                altered = cells(); altered[index]['confidence'] = 97.99
                with self.assertRaises(q.QuadValidationError): q.parse_cells(altered,1,'g20','2026-08-31T14:22:14+00:00')

    def test_missing_ambiguous_or_shifted_columns_rejected(self):
        for text in ['', '5', '1/2', '3 I']:
            altered=cells();altered[6]['text']=text
            with self.assertRaises(q.QuadValidationError):q.parse_cells(altered,1,'g20','2026-08-31T14:22:14+00:00')
        altered=cells();altered.pop(6)
        with self.assertRaises(q.QuadValidationError):q.parse_cells(altered,1,'g20','2026-08-31T14:22:14+00:00')

    def test_source_dash_is_missing_and_never_calculated(self):
        altered=cells();altered[7]['text']='-';altered[7]['confidence']=91
        result=q.parse_cells(altered,1,'g20','2026-08-31T14:22:14+00:00')
        self.assertIsNone(result['rows'][0]['values']['2026-Q3']['quad'])

    def test_duplicates_older_tables_and_same_date_conflict(self):
        current, changed=q.merge_table(None,candidate(),source());self.assertTrue(changed)
        duplicate={**candidate(),'asOf':'2026-09-08','effectiveAt':'2026-09-08'}
        unchanged, changed=q.merge_table(current,duplicate,source('b'))
        self.assertFalse(changed);self.assertEqual(unchanged,current)
        different=deepcopy(candidate());different['contentHash']='b'*64;different['rows'][0]['values']['2026-Q3']['quad']=2
        with self.assertRaises(q.QuadValidationError):q.merge_table(current,different,source('b'))
        different['effectiveAt']='2026-07-01';self.assertFalse(q.merge_table(current,different,source('b'))[1])

    def test_updates_one_group_and_keeps_history_and_forecast_designations(self):
        current,_=q.merge_table(None,candidate(),source())
        em={**candidate(),'group':'em','contentHash':'c'*64};current,_=q.merge_table(current,em,source('c'))
        revised=deepcopy(candidate());revised['effectiveAt']='2026-10-01';revised['asOf']='2026-10-01';revised['contentHash']='b'*64
        revised['columns']=revised['columns'][1:]
        for row in revised['rows']:row['values'].pop('2026-Q2')
        updated,changed=q.merge_table(current,revised,source('b'))
        self.assertTrue(changed);self.assertEqual(updated['groups']['em'],current['groups']['em'])
        self.assertEqual(updated['groups']['g20']['rows'][0]['values']['2026-Q2']['sourceId'],'a'*64)
        self.assertEqual(updated['groups']['g20']['rows'][0]['values']['2026-Q3']['kind'],'estimate')

    def test_content_identification_not_filename(self):
        response={'Blocks':[{'BlockType':'LINE','Text':'Emerging Market GIP Model Summary'}]}
        self.assertEqual(q.group_from_ocr(response),'em')
        self.assertIsNone(q.group_from_ocr({'Blocks':[{'BlockType':'LINE','Text':'CPI Forecast'}]}))

    def test_image_urls_are_restricted_and_tracking_removed(self):
        urls=q.image_urls('<img src="https://d1yhils6iwh5l5.cloudfront.net/charts/a.png?email=secret"><img src="http://127.0.0.1/private"><img src="https://evil.test/a.png">')
        self.assertEqual(urls,['https://d1yhils6iwh5l5.cloudfront.net/charts/a.png'])

    def test_no_table_is_normal_and_validation_errors_are_held(self):
        store=q.QuadStore(Mock(),Mock(),Mock(),enabled=False);store.health=Mock()
        self.assertEqual(store.process_html(html_body='<p>Replay at subscriber link</p>', received_at=datetime.now(timezone.utc),message_id='abc'),{'results':[],'errors':[]})
        store.process_image=Mock(side_effect=q.QuadValidationError('uncertain header'))
        with patch.object(q,'fetch_image',return_value=b'image'):
            result=store.process_html(html_body=f'<img src="https://{q.IMAGE_HOST}/charts/a.png">',received_at=datetime.now(timezone.utc),message_id='abc')
        self.assertFalse(result['errors'][0]['retryable'])

    def test_gmail_hook_preserves_macro_show_parser_and_no_table_is_normal(self):
        with patch('boto3.client'), patch('boto3.resource'):
            import hermes_gmail_ingestor as gmail
        with patch.dict(gmail.os.environ, {'GLOBAL_QUADS_INGEST_ENABLED':'1'}), patch.object(gmail,'QuadStore') as store, patch.object(gmail,'parse_html_snapshot',return_value={'original':'macro-show'}) as original:
            result=gmail.parse_email_with_global_quads(report_type='the-macro-show',subject='THE MACRO SHOW',html_body='<p>Replay</p>')
            self.assertEqual(result,{'original':'macro-show'})
            store.return_value.process_html.assert_called_once()
            original.assert_called_once()
            self.assertIsNone(gmail.parse_email_with_global_quads(report_type='global-quads',subject='Macro Themes'))
        self.assertEqual(gmail.infer_report_type('body.html','Quads/GIP Update: Mid-Quarter'),'global-quads')

    def test_dynamodb_roundtrip_preserves_numeric_readings(self):
        current,_=q.merge_table(None,candidate(),source())
        current['groups']['g20']['rows'][0]['values']['2026-Q2']['quad']=Decimal('3')
        serialized=q.decimalize(current)
        self.assertEqual(serialized['groups']['g20']['rows'][0]['values']['2026-Q2']['quad'],3)
        self.assertEqual(q.sha({'quad':Decimal('4')}),q.sha({'quad':4}))

    def test_transient_failure_requests_retry(self):
        store=q.QuadStore(Mock(),Mock(),Mock());store.health=Mock()
        with patch.object(q,'fetch_image',side_effect=TimeoutError()):
            with self.assertRaises(RuntimeError) as failure:
                store.process_html(html_body=f'<img src="https://{q.IMAGE_HOST}/charts/a.png">',received_at=datetime.now(timezone.utc),message_id='abc')
        self.assertTrue(failure.exception.retryable)

    def test_rejects_overlapping_cells_and_invalid_source_date(self):
        altered=cells();altered.append(deepcopy(altered[6]))
        with self.assertRaises(q.QuadValidationError):q.parse_cells(altered,1,'g20','2026-08-31')
        altered=cells();altered[6]['colSpan']=2
        with self.assertRaises(q.QuadValidationError):q.parse_cells(altered,1,'g20','2026-08-31')
        altered=cells();altered[0]['text']='2/30/2026'
        with self.assertRaises(q.QuadValidationError):q.parse_cells(altered,1,'g20','2026-08-31')

    def make_store(self, enabled=True):
        records={}
        store=q.QuadStore(Mock(),Mock(),Mock(),enabled=enabled)
        store.table.get_item.side_effect=lambda Key, **_: {'Item':deepcopy(records.get(tuple(Key.values())))}
        def put(Item, **_):
            records[(Item['date'],Item['snapshotType'])]=deepcopy(Item)
        store.table.put_item.side_effect=put
        return store,records,put

    def test_validation_mode_archives_without_publishing(self):
        store,records,_=self.make_store(enabled=False)
        self.assertEqual(store.publish(candidate(),source()),'validated')
        self.assertIn((candidate()['contentHash'],'global-quads-history'),records)
        self.assertNotIn(('LATEST','global-quads'),records)

    def test_resend_after_revision_never_reacquires_freshness(self):
        store,records,_=self.make_store()
        original=candidate();self.assertEqual(store.publish(original,source()),'published')
        revised=deepcopy(original);revised.update(contentHash='b'*64,asOf='2026-09-01',effectiveAt='2026-09-01')
        revised['rows'][0]['values']['2026-Q3']['quad']=2
        store.publish(revised,{**source('b'),'asOf':'2026-09-01'})
        resend={**original,'asOf':'2026-09-08','effectiveAt':'2026-09-08'}
        self.assertEqual(store.publish(resend,{**source('c'),'publishedAt':'2026-09-08T12:00:00Z'}),'unchanged')
        self.assertEqual(records[('LATEST','global-quads')]['data']['groups']['g20']['contentHash'],'b'*64)

    def test_concurrent_other_group_is_preserved_on_retry(self):
        store,records,put=self.make_store()
        em={**candidate(),'group':'em','contentHash':'c'*64}
        def concurrent(Item, **kwargs):
            if Item['snapshotType']=='global-quads' and not records.get(('LATEST','global-quads')):
                data,_=q.merge_table(None,em,source('c'))
                put(Item={**q.STATE_KEY,'data':data,'dataVersion':'other-writer'})
                raise ClientError({'Error':{'Code':'ConditionalCheckFailedException'}},'PutItem')
            put(Item=Item,**kwargs)
        store.table.put_item.side_effect=concurrent
        self.assertEqual(store.publish(candidate(),source()),'published')
        self.assertEqual(set(records[('LATEST','global-quads')]['data']['groups']),{'g20','em'})

    def test_quiet_inbox_or_other_attachment_does_not_clear_failure(self):
        store,records,_=self.make_store()
        error={'source':'image','detail':'uncertain heading','retryable':False}
        store.health('abc','2026-08-31',[],[error])
        store.health('def','2026-09-01',[{'status':'no-table'}],[])
        store.health('abc','2026-08-31',[{'status':'no-table'}],[],artifact='pdf-hash')
        self.assertIn('abc',records[('LATEST','global-quads-health')]['issues'])
        store.health('abc','2026-08-31',[],[])
        self.assertEqual(records[('LATEST','global-quads-health')]['issues'],{})

    def test_embedded_pdf_chart_is_inspected_even_with_unrelated_page_text(self):
        store=q.QuadStore(Mock(),Mock(),Mock());store.health=Mock()
        store.process_image=Mock(return_value={'status':'validated','group':'g20'})
        page=Mock();page.images=[{'name':'embedded chart'}];page.extract_text.return_value='Copyright and slide number'
        plain=Mock();plain.images=[];plain.extract_text.return_value='Presentation agenda'
        pdf=Mock();pdf.pages=[plain,page]
        module=Mock();module.open.return_value.__enter__=Mock(return_value=pdf)
        module.open.return_value.__exit__=Mock(return_value=False)
        with patch.dict(sys.modules,{'pdfplumber':module}),patch.object(q,'png_bytes',return_value=b'original page pixels'):
            result=store.process_pdf(b'pdf','2026-08-31','abc')
        self.assertEqual(result['results'][0]['group'],'g20')
        store.process_image.assert_called_once_with(b'original page pixels','2026-08-31','abc',None,page=2)
        store.health.assert_called_once()

if __name__ == '__main__': unittest.main()
