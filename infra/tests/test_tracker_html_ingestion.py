#!/usr/bin/env python3
"""Focused fail-closed coverage for HTML tracker chart ingestion."""

from __future__ import annotations

import json
import os
import sys
import unittest
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path

os.environ.setdefault("AWS_EC2_METADATA_DISABLED", "true")
sys.path.insert(
    0,
    str(Path(__file__).resolve().parents[1] / "lambdas" / "gmail_ingestor"),
)

import hermes_gmail_ingestor as ingestor
import parse_hedgeye_email_html as email_parser


def textract_tables_response(*tables):
    blocks = []
    for table_index, rows in enumerate(tables, start=1):
        table_blocks = []
        cell_ids = []
        for row_index, row in enumerate(rows, start=1):
            for column_index, value in enumerate(row, start=1):
                cell_id = f"table-{table_index}-cell-{row_index}-{column_index}"
                cell_ids.append(cell_id)
                cell = {
                    "BlockType": "CELL",
                    "Id": cell_id,
                    "RowIndex": row_index,
                    "ColumnIndex": column_index,
                }
                if str(value or ""):
                    word_id = f"table-{table_index}-word-{row_index}-{column_index}"
                    cell["Relationships"] = [{"Type": "CHILD", "Ids": [word_id]}]
                    table_blocks.append({
                        "BlockType": "WORD",
                        "Id": word_id,
                        "Text": str(value),
                    })
                table_blocks.append(cell)
        blocks.append({
            "BlockType": "TABLE",
            "Id": f"table-{table_index}",
            "Relationships": [{"Type": "CHILD", "Ids": cell_ids}],
        })
        blocks.extend(table_blocks)
    return {"Blocks": blocks}


class FakeTextract:
    def __init__(self, *responses):
        self.responses = list(responses)
        self.calls = []

    def analyze_document(self, **kwargs):
        self.calls.append(kwargs)
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return response


class CaptureTable:
    def __init__(self):
        self.items = []

    def put_item(self, *, Item, **_kwargs):
        self.items.append(Item)
        return {}


class CaptureDynamoDb:
    def __init__(self):
        self.snapshots = CaptureTable()

    def Table(self, name):
        if name != "HedgeyeDailySnapshot":
            raise AssertionError(name)
        return self.snapshots


class TrackerHtmlIngestionTests(unittest.TestCase):
    def test_momo_uses_only_sixth_chart_and_sanitizes_urls(self):
        source_root = "https://d1yhils6iwh5l5.cloudfront.net/charts/momo"
        html_body = "".join(
            f'<img src="{source_root}/{index}.png?subscriber=private&amp;src=email">'
            for index in (6, 1, 2, 3, 4, 5)
        )
        textract = FakeTextract(textract_tables_response([
            ["", "Buy Trade", "Sell Trade", "Upside", "Downside", "Trend"],
            ["NVDA", "203", "225", "2.74%", "-7.3%", "BULLISH"],
            ["ORCL", "Outbucket (08/13)", "Outbucket (08/13)", "", "", "BULLISH"],
        ]))
        fetched = []

        snapshot = email_parser.parse_html_snapshot(
            report_type="momo-tracker",
            html_body=html_body,
            received_at=datetime(2026, 8, 7, 15, tzinfo=timezone.utc),
            s3_key="momo/message.html",
            message_id="momo-aug-7",
            image_fetcher=lambda url: fetched.append(url) or b"chart",
            textract_client=textract,
        )

        self.assertEqual(snapshot["data"], {
            "NVDA": {
                "buyTrade": Decimal("203"),
                "sellTrade": Decimal("225"),
                "upside": Decimal("2.74"),
                "downside": Decimal("-7.3"),
                "trend": "BULLISH",
                "rangeStatus": "available",
            },
            "ORCL": {
                "buyTrade": None,
                "sellTrade": None,
                "upside": None,
                "downside": None,
                "trend": "BULLISH",
                "rangeStatus": "outbucket",
                "rangeStatusDate": "08/13",
            },
        })
        self.assertEqual(snapshot["stockCount"], 2)
        self.assertEqual(snapshot["rangeAvailableCount"], 1)
        self.assertEqual(snapshot["outbucketCount"], 1)
        self.assertEqual(fetched, [f"{source_root}/6.png"])
        self.assertNotIn("private", json.dumps(snapshot, default=str))

        database = CaptureDynamoDb()
        email_parser.save_snapshot_to_dynamodb(snapshot, database)
        stored = database.snapshots.items[-1]
        self.assertIsNone(stored["data"]["ORCL"]["buyTrade"])
        self.assertIsNone(stored["data"]["ORCL"]["sellTrade"])
        self.assertEqual(stored["data"]["ORCL"]["trend"], "BULLISH")
        self.assertEqual(stored["data"]["ORCL"]["rangeStatus"], "outbucket")

    def test_bitcoin_ignores_volume_table_and_extracts_crypto_and_equities(self):
        source_root = "https://d1yhils6iwh5l5.cloudfront.net/charts/bitcoin"
        chart_names = [
            "TREND.png", "BTC_9.png", "BTC_1.png", "BTC_3.png", "BTC_4.png",
            "BTC_5.png", "BTC_6.png", "BTC_7.png", "BTC_8.png", "BTC_2.png",
        ]
        textract = FakeTextract(
            textract_tables_response(
                [["", "COIN VOLUME"], ["BTC", "4.6%"]],
                [
                    ["Crypto", "Price", "Buy Trade", "Sell Trade", "Trend"],
                    ["BTC", "64,517", "62,800", "66,111", "BE ARISH"],
                ],
            ),
            textract_tables_response([
                ["Ticker", "Price", "Buy Trade", "Sell Trade", "Upside", "Downside", "Trend Signal"],
                ["IBIT", "36.74", "35.41", "37.50", "2.1%", "-3.6%", "BEARISH"],
            ]),
        )
        fetched = []

        snapshot = email_parser.parse_html_snapshot(
            report_type="crypto-quant",
            html_body="".join(
                f'<img src="{source_root}/{name}?subscriber=private">'
                for name in chart_names
            ),
            received_at=datetime(2026, 8, 7, 16, tzinfo=timezone.utc),
            s3_key="bitcoin/message.html",
            message_id="bitcoin-aug-7",
            image_fetcher=lambda url: fetched.append(url) or b"chart",
            textract_client=textract,
        )

        self.assertEqual(snapshot["snapshotType"], "bitcoin-trend-tracker")
        self.assertEqual(snapshot["data"]["cryptos"]["BTC"]["trend"], "BEARISH")
        self.assertEqual(snapshot["data"]["stocks"]["IBIT"]["trend"], "BEARISH")
        self.assertEqual(fetched, [
            f"{source_root}/BTC_2.png",
            f"{source_root}/BTC_9.png",
        ])

    def test_malformed_tracker_rows_and_unsafe_sources_fail_closed(self):
        required = (
            "ticker", "price", "buyTrade", "sellTrade", "upside", "downside", "trend",
        )
        invalid_rows = (
            [["Ticker", "Price", "Trend"], ["NVDA", "203", "BULLISH"]],
            [list(required), ["NVDA", "203", "225", "203", "2", "-7", "BULLISH"]],
            [list(required), ["NVDA", "203", "190", "225", "2", "-7", "UNKNOWN"]],
            [list(required), ["NVDA", "203", "190", "225", "2", "-7", "BEARISH123"]],
            [list(required), ["NVDA", "203", "190", "225", "2", "-7", "BE@ARISH"]],
        )
        for rows in invalid_rows:
            with self.subTest(rows=rows), self.assertRaises(ValueError):
                email_parser._parse_tracker_table(rows, required_fields=required)

        textract = FakeTextract(textract_tables_response([]))
        snapshot = email_parser.parse_html_snapshot(
            report_type="momo-tracker",
            html_body='<img src="https://example.com/6.png?subscriber=private">',
            received_at=datetime(2026, 8, 7, 15, tzinfo=timezone.utc),
            s3_key="momo/unsafe.html",
            message_id="momo-unsafe",
            textract_client=textract,
        )
        self.assertIsNone(snapshot)
        self.assertEqual(textract.calls, [])

    def test_momo_outbucket_contract_rejects_partial_or_contradictory_rows(self):
        required = (
            "ticker", "buyTrade", "sellTrade", "upside", "downside", "trend",
        )
        invalid_rows = (
            ["ORCL", "Outbucket (08/13)", "130", "", "", "BULLISH"],
            ["ORCL", "Outbucket (08/13)", "Outbucket (08/14)", "", "", "BULLISH"],
            ["ORCL", "Outbucket (08/13)", "Outbucket", "", "", "BULLISH"],
            ["ORCL", "Outbucket (08/13)", "Outbucket (08/13)", "1.2%", "", "BULLISH"],
            ["ORCL", "Outbuckat (08/13)", "Outbuckat (08/13)", "", "", "BULLISH"],
            ["ORCL", "Outbucket (08/13)", "Outbucket (08/13)", "", "", "UNKNOWN"],
        )
        header = ["Ticker", "Buy Trade", "Sell Trade", "Upside", "Downside", "Trend"]
        for row in invalid_rows:
            with self.subTest(row=row), self.assertRaises(ValueError):
                email_parser._parse_tracker_table(
                    [header, row],
                    required_fields=required,
                    allow_outbucket_rows=True,
                )

    def test_bitcoin_tracker_does_not_accept_outbucket_rows(self):
        required = ("ticker", "price", "buyTrade", "sellTrade", "trend")
        rows = [
            ["Crypto", "Price", "Buy Trade", "Sell Trade", "Trend"],
            ["BTC", "64517", "Outbucket (08/13)", "Outbucket (08/13)", "BULLISH"],
        ]

        with self.assertRaises(ValueError):
            email_parser._parse_tracker_table(rows, required_fields=required)

    def test_tracker_products_receive_textract_on_fresh_and_backfill_paths(self):
        self.assertEqual(
            ingestor.HTML_TEXTRACT_REPORT_TYPES,
            frozenset({
                "signal-strength",
                "momo-tracker",
                "crypto-quant",
                "bitcoin-trend-tracker",
            }),
        )
        self.assertEqual(
            ingestor.MATERIALIZED_DATA_VERSION,
            "gmail-materialized-v11-top-three-things",
        )


if __name__ == "__main__":
    unittest.main()
