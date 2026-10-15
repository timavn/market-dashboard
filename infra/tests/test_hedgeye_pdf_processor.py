#!/usr/bin/env python3
"""Focused contract tests for completion-safe Hedgeye PDF ingestion."""

from __future__ import annotations

import io
import json
import os
import sys
import unittest
from copy import deepcopy
from pathlib import Path
from unittest import mock


os.environ.setdefault("AWS_EC2_METADATA_DISABLED", "true")
REPO_ROOT = Path(__file__).resolve().parents[2]
PDF_LAMBDA_DIR = REPO_ROOT / "aws" / "lambda"
sys.path.insert(0, str(PDF_LAMBDA_DIR))

with mock.patch("boto3.client"), mock.patch("boto3.resource"):
    import hedgeye_pdf_processor_lambda as processor  # noqa: E402


class RecordingTable:
    def __init__(self):
        self.items = []
        self.updates = []

    def put_item(self, *, Item, **_kwargs):
        self.items.append(deepcopy(Item))
        return {}

    def get_item(self, **_kwargs):
        return {"Item": deepcopy(self.items[-1])} if self.items else {}

    def update_item(self, **kwargs):
        self.updates.append(deepcopy(kwargs))
        return {}


class RecordingDynamoDb:
    def __init__(self):
        self.tables = {}
        self.table_names = []

    def Table(self, name):
        self.table_names.append(name)
        return self.tables.setdefault(name, RecordingTable())


class PdfProcessorTests(unittest.TestCase):
    def setUp(self):
        self.original_s3 = processor.s3
        self.original_dynamodb = processor.dynamodb

    def tearDown(self):
        processor.s3 = self.original_s3
        processor.dynamodb = self.original_dynamodb

    def test_registry_pdf_products_have_concrete_processor_parsers(self):
        registry = json.loads(
            (
                REPO_ROOT
                / "infra"
                / "lambdas"
                / "gmail_ingestor"
                / "research_products.json"
            ).read_text(encoding="utf-8")
        )
        registered_pdf_products = {
            product["id"]
            for product in registry["products"]
            if "pdf" in product.get("parserModes", [])
        }

        self.assertEqual(registered_pdf_products, set(processor.PARSERS))
        for product_id, (extractor, _saver) in processor.PARSERS.items():
            definition = next(
                product
                for product in registry["products"]
                if product["id"] == product_id
            )
            self.assertEqual(
                definition["parsers"]["pdf"],
                extractor.__name__,
            )
        self.assertEqual(
            processor.detect_pdf_type("Hedgeye Risk Ranges - Processing Signals.pdf"),
            "risk-ranges",
        )

    def test_nested_tracker_events_exclude_structural_container_names(self):
        events = processor.build_entity_events(
            product_id="bitcoin-trend-tracker",
            market_date="2026-07-23",
            data={
                "cryptos": {
                    "BTC": {
                        "buyTrade": 100_000,
                        "sellTrade": 110_000,
                        "trend": "BULLISH",
                    }
                },
                "stocks": {
                    "IBIT": {
                        "buyTrade": 60,
                        "sellTrade": 70,
                        "trend": "BEARISH",
                    }
                },
            },
            content_sha256="a" * 64,
            message_id="message-1",
            s3_key="hedgeye-uploads/bitcoin.pdf",
        )
        by_key = {event["entityKey"]: event for event in events}

        self.assertEqual(by_key["ticker#BTC"]["signalValue"], "BULLISH")
        self.assertEqual(by_key["ticker#IBIT"]["signalValue"], "BEARISH")
        self.assertNotIn("ticker#CRYPTOS", by_key)
        self.assertNotIn("ticker#STOCKS", by_key)

    def test_bitcoin_extractor_sends_single_page_pdf_bytes_without_poppler(self):
        observed_page_bytes = []
        original_converter = (
            processor.bitcoin_tracker_parser.convert_page_to_image_bytes
        )

        def fake_extract(path, s3_key=None):
            observed_page_bytes.append(
                processor.bitcoin_tracker_parser.convert_page_to_image_bytes(
                    path,
                    3,
                )
            )
            return {
                "cryptos": {"BTC": {"trend": "BULLISH"}},
                "stocks": {},
            }

        with (
            mock.patch.object(
                processor.bitcoin_tracker_parser,
                "extract_specific_pages_as_pdf",
                return_value=b"%PDF-single-page",
            ) as extract_page,
            mock.patch.object(
                processor.bitcoin_tracker_parser,
                "extract_bitcoin_tracker",
                side_effect=fake_extract,
            ),
        ):
            result = processor._extract_bitcoin_tracker_with_pdf_pages(
                "/tmp/bitcoin.pdf",
                s3_key="hedgeye-uploads/bitcoin.pdf",
            )

        extract_page.assert_called_once_with("/tmp/bitcoin.pdf", [3])
        self.assertEqual(observed_page_bytes, [b"%PDF-single-page"])
        self.assertEqual(result["cryptos"]["BTC"]["trend"], "BULLISH")
        self.assertIs(
            processor.bitcoin_tracker_parser.convert_page_to_image_bytes,
            original_converter,
        )

    def test_same_day_pdf_publications_are_immutable_by_content_hash(self):
        arguments = {
            "product_id": "signal-strength",
            "market_date": "2026-07-23",
            "data": {"added": ["DDOG"], "removed": []},
            "message_id": "message-1",
            "s3_key": "hedgeye-uploads/signal.pdf",
        }
        first = processor.build_entity_events(
            **arguments,
            content_sha256="b" * 64,
        )
        replay = processor.build_entity_events(
            **arguments,
            content_sha256="b" * 64,
        )
        second_publication = processor.build_entity_events(
            **arguments,
            content_sha256="c" * 64,
        )

        self.assertEqual(
            {event["eventKey"] for event in first},
            {event["eventKey"] for event in replay},
        )
        self.assertTrue(
            {event["eventKey"] for event in first}.isdisjoint(
                {event["eventKey"] for event in second_publication}
            )
        )

    def test_manifest_checksum_covers_explicit_artifact_checksums(self):
        artifacts = [
            {
                "artifactId": "a" * 64,
                "contentSha256": "a" * 64,
                "stage": "indexed",
                "eventCount": 2,
                "parserVersion": processor.PARSER_VERSION,
            },
            {
                "artifactId": "b" * 64,
                "contentSha256": "b" * 64,
                "stage": "failed",
                "eventCount": 0,
                "parserVersion": processor.PARSER_VERSION,
            },
        ]

        checksum = processor._manifest_checksum(artifacts)

        self.assertRegex(checksum, r"^[a-f0-9]{64}$")
        self.assertEqual(checksum, processor._manifest_checksum(list(reversed(artifacts))))
        changed = [dict(item) for item in artifacts]
        changed[0]["stage"] = "validated"
        self.assertNotEqual(checksum, processor._manifest_checksum(changed))

    def test_manifest_persists_checksum_and_full_stage_history(self):
        database = RecordingDynamoDb()
        processor.dynamodb = database
        common = {
            "product_id": "the-call",
            "market_date": "2026-07-23",
            "artifact_id": "8" * 64,
            "s3_key": "hedgeye-uploads/the-call.pdf",
            "message_id": "message-call",
            "attachment_id": "attachment-call",
            "published_at": "2026-07-23T11:30:00+00:00",
        }
        for stage in ("received", "parsed", "validated", "indexed"):
            manifest = processor._manifest_snapshot(
                **common,
                stage=stage,
                event_count=3 if stage in {"validated", "indexed"} else 0,
            )

        artifact = manifest["artifacts"][0]
        self.assertEqual(artifact["contentSha256"], "8" * 64)
        self.assertEqual(
            [transition["stage"] for transition in artifact["stageHistory"]],
            ["received", "parsed", "validated", "indexed"],
        )
        self.assertEqual(
            manifest["manifestChecksum"],
            processor._manifest_checksum(manifest["artifacts"]),
        )

    def test_process_job_records_every_stage_in_order(self):
        processor.s3 = mock.Mock()
        processor.s3.download_file.side_effect = (
            lambda _bucket, _key, path: Path(path).write_bytes(b"%PDF")
        )
        extractor = mock.Mock(
            return_value={
                "DDOG": {
                    "buyTrade": 100,
                    "sellTrade": 120,
                    "trend": "BULLISH",
                }
            }
        )
        saver = mock.Mock()
        manifest = mock.Mock()
        ledger = mock.Mock()

        with (
            mock.patch.object(processor, "_object_metadata", return_value={}),
            mock.patch.object(
                processor,
                "extract_date_from_pdf",
                return_value="2026-07-23",
            ),
            mock.patch.dict(
                processor.PARSERS,
                {"momo-tracker": (extractor, saver)},
            ),
            mock.patch.object(processor, "_manifest_snapshot", manifest),
            mock.patch.object(processor, "persist_entity_events", return_value=1),
            mock.patch.object(processor, "_mark_ledger", ledger),
        ):
            result = processor._process_job(
                {
                    "bucket": "raw-artifacts",
                    "key": "hedgeye-uploads/momo.pdf",
                    "reportType": "momo-tracker",
                    "contentSha256": "d" * 64,
                    "messageId": "message-2",
                    "attachmentId": "attachment-2",
                }
            )

        self.assertEqual(
            [call.kwargs["stage"] for call in manifest.call_args_list],
            ["received", "parsed", "validated", "indexed"],
        )
        saver.assert_called_once()
        self.assertEqual(
            [call.kwargs["status"] for call in ledger.call_args_list],
            ["RECEIVED", "PARSED", "VALIDATED", "INDEXED"],
        )
        self.assertEqual(result["entityEventCount"], 1)

    def test_each_ledger_stage_updates_source_and_content_rows(self):
        database = RecordingDynamoDb()
        processor.dynamodb = database

        for stage in ("received", "parsed", "validated", "indexed"):
            processor._mark_processing_stage(
                stage=stage,
                product_id="the-call",
                market_date="2026-07-23",
                s3_key="hedgeye-uploads/the-call.pdf",
                message_id="message-call",
                attachment_id="attachment-call",
                content_sha256="7" * 64,
            )

        updates = database.tables[processor.LEDGER_TABLE].updates
        self.assertEqual(len(updates), 8)
        self.assertEqual(
            [updates[index]["ExpressionAttributeValues"][":status"] for index in range(0, 8, 2)],
            ["RECEIVED", "PARSED", "VALIDATED", "INDEXED"],
        )
        for index in range(0, 8, 2):
            self.assertEqual(
                updates[index]["Key"],
                {
                    "messageId": "message-call",
                    "attachmentId": "attachment-call",
                },
            )
            self.assertEqual(
                updates[index + 1]["Key"],
                {
                    "messageId": f"CONTENT#{'7' * 64}",
                    "attachmentId": processor.TEXTRACT_LEDGER_ATTACHMENT_ID,
                },
            )

    def test_empty_tracker_parse_fails_and_remains_retryable(self):
        processor.s3 = mock.Mock()
        processor.s3.download_file.side_effect = (
            lambda _bucket, _key, path: Path(path).write_bytes(b"%PDF")
        )
        extractor = mock.Mock(return_value={"cryptos": {}, "stocks": {}})
        manifest = mock.Mock()
        ledger = mock.Mock()

        with (
            mock.patch.object(processor, "_object_metadata", return_value={}),
            mock.patch.object(
                processor,
                "extract_date_from_pdf",
                return_value="2026-07-23",
            ),
            mock.patch.dict(
                processor.PARSERS,
                {"bitcoin-trend-tracker": (extractor, mock.Mock())},
            ),
            mock.patch.object(processor, "_manifest_snapshot", manifest),
            mock.patch.object(processor, "_mark_ledger", ledger),
        ):
            with self.assertRaisesRegex(ValueError, "no usable data"):
                processor._process_job(
                    {
                        "bucket": "raw-artifacts",
                        "key": "hedgeye-uploads/bitcoin.pdf",
                        "reportType": "bitcoin-trend-tracker",
                        "contentSha256": "e" * 64,
                        "messageId": "message-3",
                        "attachmentId": "attachment-3",
                    }
                )

        self.assertEqual(
            [call.kwargs["stage"] for call in manifest.call_args_list],
            ["received", "failed"],
        )
        self.assertEqual(ledger.call_args.kwargs["status"], "TEXTRACT_ERROR")
        self.assertTrue(ledger.call_args.kwargs["extra"]["retryable"])

    def test_tracker_without_published_signal_fails_validation_after_parse(self):
        processor.s3 = mock.Mock()
        processor.s3.download_file.side_effect = (
            lambda _bucket, _key, path: Path(path).write_bytes(b"%PDF")
        )
        extractor = mock.Mock(
            return_value={
                "DDOG": {
                    "buyTrade": 100,
                    "sellTrade": 120,
                    "timestamp": "2026-07-23T12:00:00+00:00",
                }
            }
        )
        manifest = mock.Mock()

        with (
            mock.patch.object(processor, "_object_metadata", return_value={}),
            mock.patch.object(
                processor,
                "extract_date_from_pdf",
                return_value="2026-07-23",
            ),
            mock.patch.dict(
                processor.PARSERS,
                {"momo-tracker": (extractor, mock.Mock())},
            ),
            mock.patch.object(processor, "_manifest_snapshot", manifest),
            mock.patch.object(processor, "_mark_ledger"),
        ):
            with self.assertRaisesRegex(ValueError, "no published Trade or Trend signals"):
                processor._process_job(
                    {
                        "bucket": "raw-artifacts",
                        "key": "hedgeye-uploads/momo.pdf",
                        "reportType": "momo-tracker",
                        "contentSha256": "9" * 64,
                    }
                )

        self.assertEqual(
            [call.kwargs["stage"] for call in manifest.call_args_list],
            ["received", "parsed", "failed"],
        )

    def test_registry_validation_rejects_metadata_only_and_incomplete_entity_products(self):
        malformed = {
            "portfolio-solutions": {
                "rankings": [],
                "topMovers": {"weekly": [{"ticker": "DDOG", "change": 3}]},
            },
            "signal-strength": {
                "added": ["DDOG"],
                "removed": [],
                "stocks": [],
            },
            "the-call": {
                "timestamp": "2026-07-23T12:00:00+00:00",
                "source": "pdf",
                "positionCount": 0,
            },
            "volume": {
                "methodologyVersion": "v1",
                "metricsCount": 0,
            },
        }

        for product_id, data in malformed.items():
            with self.subTest(product_id=product_id):
                with self.assertRaises(ValueError):
                    processor._validate_product_data(product_id, data)

    def test_registry_validation_accepts_searchable_notes_and_required_entity_rows(self):
        valid = {
            "portfolio-solutions": {
                "rankings": [{"ticker": "DDOG", "rank": 4}],
            },
            "signal-strength": {
                "added": ["DDOG"],
                "removed": [],
                "stocks": [{"ticker": "DDOG"}],
            },
            "the-call": {
                "summary": "DDOG remains a long on the published call.",
            },
            "cftc-positioning": {
                "metrics": [{"metric": "S&P 500", "latest": 12.5}],
            },
            "volume": {
                "metrics": {
                    "totalMarket": {"pctPriorDay": 12},
                    "exchange": {"pctPriorDay": 8},
                },
            },
        }

        for product_id, data in valid.items():
            with self.subTest(product_id=product_id):
                processor._validate_product_data(product_id, data)

    def test_internal_extractor_type_error_is_not_retried(self):
        calls = []

        def extractor(path):
            calls.append(path)
            raise TypeError("parser defect")

        with self.assertRaisesRegex(TypeError, "parser defect"):
            processor._call_extractor(
                extractor,
                "/tmp/publication.pdf",
                "hedgeye-uploads/publication.pdf",
            )

        self.assertEqual(calls, ["/tmp/publication.pdf"])

    def test_early_look_saver_only_writes_supplemental_daily_snapshot(self):
        database = RecordingDynamoDb()
        processor.dynamodb = database

        processor._save_early_look_snapshot(
            {
                "SPX": {
                    "lrr": 6200,
                    "hrr": 6300,
                    "trend": "BULLISH",
                    "timestamp": "2026-07-23T12:00:00+00:00",
                }
            },
            pdf_s3_key="hedgeye-uploads/early-look.pdf",
            pdf_date="2026-07-23",
        )

        self.assertEqual(database.table_names, [processor.DAILY_SNAPSHOT_TABLE])
        item = database.tables[processor.DAILY_SNAPSHOT_TABLE].items[0]
        self.assertFalse(item["decisionEligible"])
        self.assertFalse(item["data"]["SPX"]["decisionEligible"])
        self.assertNotIn("HedgeyeRiskRanges", database.table_names)
        self.assertNotIn("RiskRangeData", database.table_names)

    def test_risk_range_pdf_is_candidate_until_primary_manifest_verifies_it(self):
        database = RecordingDynamoDb()
        processor.dynamodb = database

        processor._save_risk_range_candidate_snapshot(
            {
                "riskRanges": {
                    "SPX": {
                        "buyTrade": 6200,
                        "sellTrade": 6300,
                        "prevClose": 6250,
                        "trend": "BULLISH",
                        "ts": "2026-07-23T12:00:00+00:00",
                    }
                },
                "trendChanges": [],
                "outbucket": [],
            },
            pdf_s3_key="hedgeye-uploads/risk-ranges.pdf",
            pdf_date="2026-07-23",
        )

        self.assertEqual(database.table_names, [processor.DAILY_SNAPSHOT_TABLE])
        item = database.tables[processor.DAILY_SNAPSHOT_TABLE].items[0]
        self.assertEqual(item["snapshotType"], "risk-ranges-pdf-candidate")
        self.assertFalse(item["decisionEligible"])
        self.assertEqual(
            item["verificationStatus"],
            "requires-primary-publication-manifest",
        )
        self.assertNotIn("HedgeyeRiskRanges", database.table_names)
        self.assertNotIn("RiskRangeData", database.table_names)

        events = processor.build_entity_events(
            product_id="risk-ranges",
            market_date="2026-07-23",
            data={
                "riskRanges": {
                    "SPX": {
                        "buyTrade": 6200,
                        "sellTrade": 6300,
                        "trend": "BULLISH",
                    }
                }
            },
            content_sha256="f" * 64,
            message_id="risk-message",
            s3_key="hedgeye-uploads/risk-ranges.pdf",
        )
        self.assertTrue(events)
        self.assertTrue(all(event["decisionEligible"] is False for event in events))

    def test_handler_attempts_every_attachment_before_raising_for_retry(self):
        jobs = [
            {"key": "hedgeye-uploads/first.pdf"},
            {"key": "hedgeye-uploads/second.pdf"},
        ]
        process = mock.Mock(
            side_effect=[
                ValueError("first failed"),
                {"product": "the-call", "status": "indexed"},
            ]
        )

        with (
            mock.patch.object(processor, "_jobs", return_value=jobs),
            mock.patch.object(processor, "_process_job", process),
            mock.patch.object(processor.traceback, "print_exc"),
            self.assertRaisesRegex(RuntimeError, "first failed"),
        ):
            processor.lambda_handler({}, None)

        self.assertEqual(process.call_count, 2)

    def test_unknown_attachment_without_metadata_is_still_checksummed_and_failed(self):
        processor.s3 = mock.Mock()
        processor.s3.get_object.return_value = {"Body": io.BytesIO(b"unknown-pdf")}
        manifest = mock.Mock()
        ledger = mock.Mock()

        with (
            mock.patch.object(processor, "_object_metadata", return_value={}),
            mock.patch.object(processor, "_manifest_snapshot", manifest),
            mock.patch.object(processor, "_mark_ledger", ledger),
        ):
            result = processor._process_job(
                {
                    "bucket": "raw-artifacts",
                    "key": "hedgeye-uploads/unregistered-publication.pdf",
                    "receivedAt": "2026-07-23T12:00:00+00:00",
                    "messageId": "message-unknown",
                    "attachmentId": "attachment-unknown",
                }
            )

        artifact_id = manifest.call_args.kwargs["artifact_id"]
        self.assertRegex(artifact_id, r"^[a-f0-9]{64}$")
        self.assertEqual(manifest.call_args.kwargs["stage"], "failed")
        self.assertEqual(ledger.call_args.kwargs["status"], "UNSUPPORTED")
        self.assertFalse(ledger.call_args.kwargs["extra"]["retryable"])
        self.assertEqual(result["status"], "unsupported")


if __name__ == "__main__":
    unittest.main()
