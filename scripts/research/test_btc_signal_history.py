"""Regression checks for original report recovery and point-in-time eligibility."""
import argparse
import base64
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import btc_signal_history as history
from btc_hourly_bias import SignalTimeline, instant


class SourceRecoveryTests(unittest.TestCase):
    def test_two_and_four_digit_publication_years(self):
        self.assertEqual(history.iso(history.publication_time('09/15/21 06:55 AM EDT')), '2021-09-15T10:55:00Z')
        self.assertEqual(history.iso(history.publication_time('12/16/2024 07:09 AM EST')), '2024-12-16T12:09:00Z')
        self.assertIsNone(history.publication_time('09/15/21'))

    def test_connector_internal_date_and_later_google_receipt(self):
        message = {'internal_date': str(int(instant('2024-12-16T12:09:14Z').timestamp() * 1000)),
                   'payload': {'headers': [{'name': 'Received', 'value': 'from example by mx.google.com; Mon, 16 Dec 2024 04:17:56 -0800'}]}}
        self.assertEqual(history.iso(history.receipt_time(message)), '2024-12-16T12:17:56Z')
        self.assertIsNone(history.receipt_time({'payload': {'headers': [{'name': 'Date', 'value': 'Mon, 16 Dec 2024 04:00:00 -0800'}]}}))

    def test_mime_connector_and_legacy_html(self):
        html = '<p>Original dated table</p>'
        direct = {'payload': {'parts': [{'mime_type': 'text/html', 'body': {'content': html}}]}}
        encoded = {'payload': {'mimeType': 'text/html', 'body': {'data': base64.urlsafe_b64encode(html.encode()).decode().rstrip('=')}}}
        self.assertEqual(history.gmail_html(direct), html)
        self.assertEqual(history.gmail_html(encoded), html)
        direct['payload']['parts'] *= 2
        with self.assertRaisesRegex(ValueError, 'EXPECTED_ONE'):
            history.gmail_html(direct)

    def panel(self):
        def box(text, x, y):
            return {'text': text, 'x': x, 'y': y, 'width': .07, 'height': .018, 'confidence': 1}
        rows = [box('BTC', .22, .05), box('Buy Trade', .15, .09), box('Sell Trade', .34, .09),
                box('TRADE', .01, .12), box('TREND', .01, .15), box('44,091', .15, .12),
                box('50,097', .34, .12), box('BULLISH', .25, .15)]
        # ETH is the same layout but a different direction; it must never leak into BTC.
        rows += [box('ETH', .76, .05), box('Buy Trade', .69, .09), box('Sell Trade', .88, .09),
                 box('TRADE', .55, .12), box('TREND', .55, .15), box('3,000', .69, .12),
                 box('3,500', .88, .12), box('BEARISH', .79, .15)]
        candidate = {'sourceUrl': 'https://example.test/charts/resized/123/original/BTC_2.png',
                     'headers': {'Last-Modified': 'Wed, 15 Sep 2021 10:50:00 GMT'}, 'sha256': 'test',
                     'imagePath': 'image.png', 'headersPath': 'image.headers.json', 'observations': rows}
        message = {'publicationAt': '2021-09-15T10:55:00Z', 'receivedAt': '2021-09-15T10:58:50Z',
                   'availableAt': '2021-09-15T10:58:50Z'}
        return candidate, message

    def test_legacy_panel_is_btc_only_and_requires_explicit_identity(self):
        candidate, message = self.panel()
        row = history.extract_table(candidate, message)
        self.assertEqual((row['trend'], row['lrr'], row['hrr']), ('BULLISH', 44091, 50097))
        candidate['observations'][0]['text'] = 'REDACTED'
        self.assertIsNone(history.extract_table(candidate, message))

    def test_stacked_other_asset_panel_is_excluded(self):
        candidate, message = self.panel()
        for row in candidate['observations'][8:]:
            row['x'] -= .54
            row['y'] += .14
        self.assertEqual(history.extract_table(candidate, message)['trend'], 'BULLISH')

    def test_malformed_ocr_number_has_no_range(self):
        candidate, message = self.panel()
        candidate['observations'][5]['text'] = '44,09'
        row = history.extract_table(candidate, message)
        self.assertTrue(row['directionEligible'])
        self.assertIsNone(row['lrr'])

    def test_missing_or_revised_image_timing_is_excluded(self):
        candidate, message = self.panel()
        candidate['headers']['Last-Modified'] = 'Wed, 15 Sep 2021 12:00:00 GMT'
        self.assertFalse(history.extract_table(candidate, message)['directionEligible'])
        candidate['headers'] = {}
        self.assertFalse(history.extract_table(candidate, message)['directionEligible'])

    def test_saved_source_hash_url_headers_and_mock_flags(self):
        candidate, message = self.panel()
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp)
            (output / 'image.png').write_bytes(b'original test image')
            (output / 'image.headers.json').write_text(json.dumps(candidate['headers']))
            candidate['sha256'] = hashlib.sha256(b'original test image').hexdigest()
            message['imageUrls'] = [candidate['sourceUrl']]
            history.validate_saved_candidate(candidate, message, output)
            for flag in ['mock', 'seed', 'seeded', 'simulated', 'stale', 'cacheOnly']:
                invalid = {**candidate, flag: True}
                with self.assertRaisesRegex(ValueError, 'UNVERIFIED_SOURCE'):
                    history.validate_saved_candidate(invalid, message, output)
            for status in ['offline', 'disconnected', 'error']:
                with self.assertRaisesRegex(ValueError, 'UNVERIFIED_SOURCE'):
                    history.validate_saved_candidate({**candidate, 'providerStatus': status}, message, output)
            with self.assertRaisesRegex(ValueError, 'NOT_IN_ORIGINAL'):
                history.validate_saved_candidate(candidate, {**message, 'imageUrls': []}, output)
            (output / 'image.png').write_bytes(b'changed')
            with self.assertRaisesRegex(ValueError, 'HASH_MISMATCH'):
                history.validate_saved_candidate(candidate, message, output)

    def test_missing_expected_report_stops_carry_and_future_report_is_removed(self):
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp)
            def record(date, at, mid):
                return {'reportDate': date, 'publicationAt': at, 'receivedAt': at, 'availableAt': at,
                        'sourceMessageId': mid, 'sourceUrl': 'https://example.test/report',
                        'directionEligible': True, 'trend': 'BULLISH', 'lrr': 40000, 'hrr': 50000,
                        'visualReview': {'verified': True}, 'exclusionReason': None}
            records = [record('2021-09-15', '2021-09-15T11:00:00Z', 'a'),
                       record('2021-09-17', '2021-09-17T11:00:00Z', 'b'),
                       record('2021-09-17', '2021-09-17T20:00:00Z', 'c')]
            for name, data in [('extraction-candidates.json', {'records': records, 'transitionsToReview': [], 'excludedSourceReports': []}),
                               ('publication-cadence.json', {}), ('archive-snapshots.json', [])]:
                (output / name).write_text(json.dumps(data))
            args = argparse.Namespace(output=output, start='2021-09-15', end='2021-09-17', as_of='2021-09-17T18:00:00Z')
            with patch.object(history, 'assemble'), patch('builtins.print'):
                history.finalize(args)
            document = json.loads((output / 'signals.json').read_text())
            self.assertEqual(len(document['records']), 2)
            self.assertEqual(document['records'][0]['validUntil'], '2021-09-16T04:00:00Z')
            timeline = SignalTimeline(document)
            self.assertIsNone(timeline.at(instant('2021-09-16T16:00:00Z'))[0])
            self.assertIsNotNone(timeline.at(instant('2021-09-17T11:00:00Z'))[0])
            self.assertIsNone(timeline.at(instant('2021-09-17T18:00:00Z'))[0])

    def test_archive_seal_detects_changed_missing_and_extra_raw_evidence(self):
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp)
            (output / 'signals.json').write_text(json.dumps({'asOf': '2026-09-15T18:00:00Z', 'source': 'historical test'}))
            (output / 'coverage-summary.json').write_text(json.dumps({'verifiedReports': 2}))
            (output / 'original.html').write_text('original evidence')
            self.assertEqual(history.seal_source_archive(output), {'verifiedReports': 2})
            (output / 'original.html').write_text('changed evidence')
            with self.assertRaisesRegex(ValueError, 'HASH_MISMATCH'):
                history.verify_source_archive(output)
            (output / 'original.html').write_text('original evidence')
            (output / 'unexpected.json').write_text('{}')
            with self.assertRaisesRegex(ValueError, 'FILE_SET_CHANGED'):
                history.verify_source_archive(output)
            (output / 'unexpected.json').unlink()
            (output / 'original.html').unlink()
            with self.assertRaisesRegex(ValueError, 'FILE_SET_CHANGED'):
                history.verify_source_archive(output)


if __name__ == '__main__':
    unittest.main()
