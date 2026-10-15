#!/usr/bin/env python3

from __future__ import annotations

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
import parse_hedgeye_email_html as parser


def line(text: str, left: float, top: float):
    return {
        "BlockType": "LINE",
        "Text": text,
        "Geometry": {
            "BoundingBox": {
                "Left": left,
                "Top": top,
                "Width": 0.08,
                "Height": 0.02,
            }
        },
    }


def chart_ocr(report_month: str, upper: str, base: str, lower: str):
    return {
        "Blocks": [
            line("Headline CPI YoY", 0.08, 0.05),
            line("3.1%", 0.03, 0.12),
            line("Apr-25", 0.15, 0.91),
            line(report_month, 0.80, 0.91),
            line(f"{upper}%", 0.91, 0.42),
            line(f"{base}%", 0.92, 0.53),
            line(f"{lower}%", 0.91, 0.64),
        ]
    }


class FakeInflationTextract:
    def __init__(self, responses):
        self.responses = responses
        self.calls = []

    def detect_document_text(self, **kwargs):
        self.calls.append(kwargs)
        chart_name = kwargs["Document"]["Bytes"].decode("utf-8")
        return self.responses[chart_name]


class InflationNowcastParserTest(unittest.TestCase):
    def test_classifies_monthly_inflation_newsletter(self):
        self.assertEqual(
            ingestor.infer_report_type(
                "message-body.html",
                "Hedgeye Monthly Inflation Nowcast",
            ),
            "inflation-nowcast",
        )
        self.assertIn("inflation-nowcast", ingestor.HTML_TEXTRACT_REPORT_TYPES)

    def test_extracts_every_chart_and_uses_earliest_unreleased_report(self):
        html_body = """
        <html><body>
          <p>June CPI Release Date: July 14th</p>
          <img src="https://d1yhils6iwh5l5.cloudfront.net/charts/june.png">
          <p>May CPI Release Date: June 10th</p>
          <img src="https://d1yhils6iwh5l5.cloudfront.net/charts/may.png">
        </body></html>
        """
        textract = FakeInflationTextract(
            {
                "june.png": chart_ocr("Jun-26", "3.94", "3.83", "3.72"),
                "may.png": chart_ocr("May-26", "4.35", "4.24", "4.13"),
            }
        )
        snapshot = parser.parse_html_snapshot(
            report_type="inflation-nowcast",
            html_body=html_body,
            received_at=datetime(2026, 6, 3, 18, 57, 2, tzinfo=timezone.utc),
            s3_key="hedgeye-email/messages/2026-06-03/message-body.html",
            message_id="macro-message",
            subject="Hedgeye Monthly Inflation Nowcast",
            sender="Hedgeye Macro Pro <sectorpro@hedgeye.com>",
            image_fetcher=lambda url: url.rsplit("/", 1)[-1].encode("utf-8"),
            textract_client=textract,
        )

        self.assertIsNotNone(snapshot)
        self.assertEqual(snapshot["snapshotType"], "inflation-nowcast")
        self.assertEqual(snapshot["forecastCount"], 2)
        self.assertEqual(snapshot["data"]["reportMonth"], "2026-05")
        self.assertEqual(snapshot["data"]["forecastMonth"], "May 2026")
        self.assertEqual(snapshot["data"]["releaseAt"], "2026-06-10T12:30:00Z")
        self.assertEqual(
            [forecast["reportMonth"] for forecast in snapshot["data"]["forecasts"]],
            ["2026-05", "2026-06"],
        )
        may = snapshot["data"]["forecasts"][0]
        self.assertEqual(
            may["scenarios"],
            {
                "upper": Decimal("4.35"),
                "base": Decimal("4.24"),
                "lower": Decimal("4.13"),
            },
        )
        self.assertEqual(may["source"]["product"], "macro-pro")
        self.assertEqual(may["source"]["priority"], 20)
        self.assertEqual(len(may["source"]["chartSha256"]), 64)
        self.assertEqual(len(textract.calls), 2)

    def test_rejects_unordered_or_geometry_free_scenario_values(self):
        html_body = """
        <p>July CPI Release Date: August 12th</p>
        <img src="https://d1yhils6iwh5l5.cloudfront.net/charts/july.png">
        """
        textract = FakeInflationTextract(
            {"july.png": chart_ocr("Jul-26", "3.40", "3.50", "3.30")}
        )
        snapshot = parser.parse_html_snapshot(
            report_type="inflation-nowcast",
            html_body=html_body,
            received_at=datetime(2026, 8, 5, 14, 39, 6, tzinfo=timezone.utc),
            s3_key="message.html",
            message_id="bad-values",
            subject="Hedgeye Monthly Inflation Nowcast",
            sender="sectorpro@hedgeye.com",
            image_fetcher=lambda _url: b"july.png",
            textract_client=textract,
        )
        self.assertIsNone(snapshot)

    def test_same_day_duplicate_products_collapse_to_macro_pro_provenance(self):
        def snapshot(message_id, product, priority, scraped_at):
            return {
                "date": "2026-08-05",
                "snapshotType": "inflation-nowcast",
                "scrapedAt": scraped_at,
                "publishedAt": scraped_at,
                "gmailMessageId": message_id,
                "sourceProduct": product,
                "sourcePriority": priority,
                "data": {
                    "metric": "Headline CPI YoY",
                    "forecastMonth": "July 2026",
                    "reportMonth": "2026-07",
                    "releaseAt": "2026-08-12T12:30:00Z",
                    "releaseDate": "2026-08-12",
                    "scenarios": [
                        {"key": "upside", "value": Decimal("3.58")},
                        {"key": "base", "value": Decimal("3.47")},
                        {"key": "downside", "value": Decimal("3.36")},
                    ],
                    "forecasts": [
                        {
                            "reportMonth": "2026-07",
                            "releaseAt": "2026-08-12T12:30:00Z",
                            "publishedAt": scraped_at,
                            "scenarios": {
                                "upper": Decimal("3.58"),
                                "base": Decimal("3.47"),
                                "lower": Decimal("3.36"),
                            },
                            "source": {
                                "kind": "gmail",
                                "messageId": message_id,
                                "product": product,
                                "priority": priority,
                                "chartSha256": "same-chart",
                            },
                        }
                    ],
                },
            }

        general = snapshot(
            "general-message",
            "hedgeye-general",
            10,
            "2026-08-05T14:39:07+00:00",
        )
        macro = snapshot(
            "macro-message",
            "macro-pro",
            20,
            "2026-08-05T14:39:06+00:00",
        )
        merged = ingestor._merge_materialized_snapshot(general, macro)
        self.assertEqual(len(merged["data"]["forecasts"]), 1)
        forecast = merged["data"]["forecasts"][0]
        self.assertEqual(forecast["source"]["messageId"], "macro-message")
        self.assertEqual(
            forecast["sourceMessageIds"],
            ["general-message", "macro-message"],
        )


if __name__ == "__main__":
    unittest.main()
