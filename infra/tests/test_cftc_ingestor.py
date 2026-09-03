#!/usr/bin/env python3
"""Contract and parity tests for the official CFTC positioning publisher."""

from __future__ import annotations

import io
import importlib.util
import copy
import os
import statistics
import sys
import unittest
import urllib.error
from contextlib import redirect_stdout
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "infra" / "lambdas" / "cftc_ingestor"))
sys.path.insert(0, str(REPO_ROOT / "aws" / "lambda"))

import cftc_ingestor as cftc  # noqa: E402
import parse_cftc as hedgeye_cftc  # noqa: E402


def synthetic_source(
    *,
    report_date: str = "2026-08-11",
    count: int = 156,
    omit: set[str] | None = None,
) -> dict:
    omitted = omit or set()
    datasets = {"legacy": [], "disaggregated": []}
    end = datetime.fromisoformat(f"{report_date}T00:00:00+00:00")
    for contract_index, contract in enumerate(cftc.CONTRACTS):
        if contract.code in omitted:
            continue
        long_field, short_field = (
            (cftc.DISAGGREGATED_LONG_FIELD, cftc.DISAGGREGATED_SHORT_FIELD)
            if contract.dataset == "disaggregated"
            else (cftc.LEGACY_LONG_FIELD, cftc.LEGACY_SHORT_FIELD)
        )
        for observation in range(count):
            row_date = end.date().toordinal() - observation * 7
            net = 20_000 + contract_index * 100 + (count - observation) ** 2
            datasets[contract.dataset].append(
                {
                    "report_date_as_yyyy_mm_dd": datetime.fromordinal(row_date).date().isoformat(),
                    "cftc_contract_market_code": contract.code,
                    "futonly_or_combined": "Combined",
                    long_field: str(100_000 + net),
                    short_field: "100000",
                }
            )
    return {
        "reportDate": report_date,
        "retrievedAt": "2026-08-14T20:15:00+00:00",
        "datasets": datasets,
    }


class FakeTable:
    def __init__(self, item=None):
        self.item = item
        self.puts = []

    def get_item(self, **_kwargs):
        return {"Item": self.item} if self.item else {}

    def put_item(self, *, Item):
        self.puts.append(Item)
        self.item = Item


class CftcCalculationTests(unittest.TestCase):
    def test_fixed_catalog_includes_managed_money_metals_and_cme_bitcoin(self):
        legacy = [contract for contract in cftc.CONTRACTS if contract.dataset == "legacy"]
        managed = [contract for contract in cftc.CONTRACTS if contract.dataset == "disaggregated"]
        self.assertEqual(len(cftc.CONTRACTS), 36)
        self.assertEqual(len(legacy), 34)
        self.assertEqual(
            [(row.metric, row.code) for row in managed],
            [("GOLD", "088691"), ("SILVER", "084691")],
        )
        self.assertEqual(
            next(row.code for row in cftc.CONTRACTS if row.metric == "CME BITCOIN"),
            "133741",
        )
        self.assertEqual(next(row.code for row in cftc.CONTRACTS if row.metric.startswith("SPX")), "13874A")

    def test_builds_complete_official_snapshot_and_discontinued_reference(self):
        snapshot = cftc.build_snapshot(synthetic_source())
        self.assertEqual(snapshot["date"], "2026-08-11")
        self.assertEqual(snapshot["reportDate"], "2026-08-11")
        self.assertEqual(snapshot["source"], cftc.SOURCE)
        self.assertEqual(snapshot["schemaVersion"], cftc.SCHEMA_VERSION)
        self.assertEqual(snapshot["calculationVersion"], cftc.CALCULATION_VERSION)
        self.assertTrue(snapshot["contentComplete"])
        self.assertTrue(snapshot["decisionEligible"])
        self.assertEqual(snapshot["metricsCount"], 37)
        self.assertEqual(len(snapshot["sourceContentHash"]), 64)
        gold = next(row for row in snapshot["data"] if row["cftcContractMarketCode"] == "088691")
        self.assertEqual(gold["seriesType"], "disaggregated-managed-money-combined")
        silver = next(row for row in snapshot["data"] if row["cftcContractMarketCode"] == "084691")
        self.assertEqual(silver["seriesType"], "disaggregated-managed-money-combined")
        bitcoin = next(row for row in snapshot["data"] if row["cftcContractMarketCode"] == "133741")
        self.assertEqual(bitcoin["seriesType"], "legacy-noncommercial-combined")
        eurodollar = next(row for row in snapshot["data"] if row["metric"] == "Eurodollar")
        self.assertEqual(
            eurodollar,
            {
                "category": "RATES",
                "metric": "Eurodollar",
                "cftcContractMarketCode": "132741",
                "seriesType": "legacy-noncommercial-combined",
                "asOf": "2023-06-13",
                "status": "discontinued",
                "latest": 47_762,
                "wwChg": -6_488,
                "zScore1Y": None,
                "zScore3Y": None,
                "decisionEligible": False,
            },
        )

    def test_z_scores_use_current_observation_and_sample_standard_deviation(self):
        source = synthetic_source()
        contract = cftc.CONTRACTS[0]
        row, warning = cftc.calculate_contract_row(contract, source, source["reportDate"])
        values = [20_000 + 156**2 - (2 * 156 * i) + i**2 for i in range(156)]
        expected_1y = Decimal(str((values[0] - statistics.mean(values[:52])) / statistics.stdev(values[:52]))).quantize(Decimal("0.01"))
        expected_3y = Decimal(str((values[0] - statistics.mean(values)) / statistics.stdev(values))).quantize(Decimal("0.01"))
        self.assertIsNone(warning)
        self.assertEqual(row["zScore1Y"], expected_1y)
        self.assertEqual(row["zScore3Y"], expected_3y)

    def test_missing_gold_publishes_partial_but_missing_spx_writes_nothing(self):
        partial = cftc.build_snapshot(synthetic_source(omit={"088691"}))
        gold = next(row for row in partial["data"] if row["cftcContractMarketCode"] == "088691")
        self.assertFalse(partial["contentComplete"])
        self.assertTrue(partial["decisionEligible"])
        self.assertEqual(gold["status"], "unavailable")
        self.assertFalse(gold["decisionEligible"])
        with self.assertRaisesRegex(cftc.NoPublishError, "SPX 13874A"):
            cftc.build_snapshot(synthetic_source(omit={"13874A"}))

    def test_insufficient_secondary_history_is_explicitly_partial(self):
        source = synthetic_source()
        code = "1170E1"
        source["datasets"]["legacy"] = [
            row
            for row in source["datasets"]["legacy"]
            if row["cftc_contract_market_code"] != code
            or row["report_date_as_yyyy_mm_dd"] >= "2025-08-01"
        ]
        snapshot = cftc.build_snapshot(source)
        vix = next(row for row in snapshot["data"] if row["cftcContractMarketCode"] == code)
        self.assertEqual(vix["status"], "partial")
        self.assertIsNotNone(vix["latest"])
        self.assertIsNone(vix["zScore3Y"])
        self.assertFalse(snapshot["contentComplete"])

    def test_duplicate_futures_only_and_malformed_secondary_rows_fail_closed(self):
        for mutation in ("duplicate", "futures-only", "malformed"):
            with self.subTest(mutation=mutation):
                source = synthetic_source()
                row = next(
                    item
                    for item in source["datasets"]["legacy"]
                    if item["cftc_contract_market_code"] == "1170E1"
                )
                if mutation == "duplicate":
                    source["datasets"]["legacy"].append(dict(row))
                elif mutation == "futures-only":
                    row["futonly_or_combined"] = "FutOnly"
                else:
                    row[cftc.LEGACY_LONG_FIELD] = "not-a-number"
                snapshot = cftc.build_snapshot(source)
                vix = next(item for item in snapshot["data"] if item["cftcContractMarketCode"] == "1170E1")
                self.assertEqual(vix["status"], "unavailable")
                self.assertFalse(snapshot["contentComplete"])

    def test_same_errors_on_spx_prevent_publication(self):
        source = synthetic_source()
        row = next(
            item
            for item in source["datasets"]["legacy"]
            if item["cftc_contract_market_code"] == cftc.SPX_CODE
        )
        row["futonly_or_combined"] = "FutOnly"
        with self.assertRaisesRegex(cftc.NoPublishError, "SPX 13874A"):
            cftc.build_snapshot(source)

    def test_idempotent_rerun_and_official_revision(self):
        snapshot = cftc.build_snapshot(synthetic_source())
        table = FakeTable()
        self.assertEqual(cftc.persist_snapshot(snapshot, table), "created")
        self.assertEqual(cftc.persist_snapshot(snapshot, table), "unchanged")
        self.assertEqual(len(table.puts), 1)
        revised = dict(snapshot, sourceContentHash="a" * 64)
        self.assertEqual(cftc.persist_snapshot(revised, table), "revised")
        self.assertEqual(len(table.puts), 2)

    def test_source_hash_normalizes_equivalent_numbers_and_detects_revisions(self):
        source = synthetic_source()
        equivalent = copy.deepcopy(source)
        first = equivalent["datasets"]["legacy"][0]
        first[cftc.LEGACY_LONG_FIELD] = f"{int(first[cftc.LEGACY_LONG_FIELD]):,}.0"
        first["report_date_as_yyyy_mm_dd"] += "T00:00:00.000"
        self.assertEqual(cftc._source_hash(source), cftc._source_hash(equivalent))

        revised = copy.deepcopy(source)
        revised_row = revised["datasets"]["legacy"][0]
        revised_row[cftc.LEGACY_LONG_FIELD] = str(
            int(revised_row[cftc.LEGACY_LONG_FIELD]) + 1
        )
        self.assertNotEqual(cftc._source_hash(source), cftc._source_hash(revised))

    def test_report_freshness_rejects_old_and_future_reports(self):
        now = datetime(2026, 8, 17, tzinfo=timezone.utc)
        cftc.validate_report_freshness("2026-08-11", now)
        with self.assertRaises(cftc.NoPublishError):
            cftc.validate_report_freshness("2026-08-06", now)
        with self.assertRaises(cftc.NoPublishError):
            cftc.validate_report_freshness("2026-08-20", now)


class CftcHttpTests(unittest.TestCase):
    def test_retries_429_and_5xx_once_then_succeeds(self):
        class Response:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self):
                return b'[{"ok": true}]'

        for status in (429, 503):
            with self.subTest(status=status):
                calls = []

                def opener(_request, **_kwargs):
                    calls.append(True)
                    if len(calls) == 1:
                        raise urllib.error.HTTPError(
                            "https://example.test", status, "retry", {}, io.BytesIO()
                        )
                    return Response()

                sleeps = []
                self.assertEqual(
                    cftc.http_get_json(
                        "https://example.test", opener=opener, sleeper=sleeps.append
                    ),
                    [{"ok": True}],
                )
                self.assertEqual(len(calls), 2)
                self.assertEqual(sleeps, [1.0])

    def test_does_not_retry_non_retryable_response(self):
        calls = []

        def opener(_request, **_kwargs):
            calls.append(True)
            raise urllib.error.HTTPError("https://example.test", 400, "bad", {}, io.BytesIO())

        with self.assertRaisesRegex(cftc.CftcIngestionError, "HTTP 400"):
            cftc.http_get_json("https://example.test", opener=opener)
        self.assertEqual(len(calls), 1)

    def test_remaining_source_failure_never_reaches_snapshot_table(self):
        original_fetch = cftc.fetch_official_source
        original_heartbeat = cftc._heartbeat
        cftc.fetch_official_source = lambda **_kwargs: (_ for _ in ()).throw(
            cftc.CftcIngestionError("source unavailable")
        )
        cftc._heartbeat = lambda **_kwargs: None
        try:
            with self.assertRaisesRegex(cftc.CftcIngestionError, "source unavailable"):
                cftc.lambda_handler({"source": "aws-scheduler"}, None)
        finally:
            cftc.fetch_official_source = original_fetch
            cftc._heartbeat = original_heartbeat


class HedgeyeAuditIsolationTests(unittest.TestCase):
    def test_textract_and_manual_saver_can_only_write_audit_snapshot(self):
        table = FakeTable()

        class Database:
            def Table(self, name):
                self.name = name
                return table

        original_resource = hedgeye_cftc.boto3.resource
        hedgeye_cftc.boto3.resource = lambda *_args, **_kwargs: Database()
        try:
            with redirect_stdout(io.StringIO()):
                hedgeye_cftc.save_audit_to_dynamodb(
                    {
                        "metrics": [{
                            "category": "EQUITIES",
                            "metric": "SPX (Index + E-mini)",
                            "latest": -96215,
                            "wwChg": 7946,
                            "zScore1Y": 0.77,
                            "zScore3Y": 0.15,
                        }],
                    },
                    "hedgeye-pdfs/2026-05-06/cftc.pdf",
                    "2026-05-06",
                )
        finally:
            hedgeye_cftc.boto3.resource = original_resource
        item = table.puts[0]
        self.assertEqual(item["snapshotType"], "cftc-positioning-hedgeye-audit")
        self.assertEqual(item["source"], "hedgeye-pdf-textract")
        self.assertFalse(item["decisionEligible"])
        self.assertFalse(item["data"][0]["decisionEligible"])
        self.assertNotEqual(item["snapshotType"], cftc.SNAPSHOT_TYPE)

    def test_hedgeye_html_materializer_cannot_write_canonical_key(self):
        parser_path = (
            REPO_ROOT / "infra" / "lambdas" / "gmail_ingestor" / "parse_hedgeye_email_html.py"
        )
        spec = importlib.util.spec_from_file_location("cftc_audit_email_parser", parser_path)
        parser = importlib.util.module_from_spec(spec)
        assert spec.loader is not None
        spec.loader.exec_module(parser)
        table = FakeTable()

        class Database:
            def Table(self, _name):
                return table

        parser.save_snapshot_to_dynamodb(
            {
                "date": "2026-05-06",
                "snapshotType": "cftc-positioning",
                "scrapedAt": "2026-05-06T20:00:00+00:00",
                "data": {"metrics": [{"metric": "SPX", "latest": -96215}]},
            },
            Database(),
        )
        item = table.puts[0]
        self.assertEqual(item["snapshotType"], "cftc-positioning-hedgeye-audit")
        self.assertEqual(item["source"], "hedgeye-email-html-audit")
        self.assertFalse(item["decisionEligible"])


@unittest.skipUnless(os.environ.get("RUN_CFTC_LIVE_TESTS") == "1", "official CFTC network parity test")
class CftcOfficialParityTests(unittest.TestCase):
    APRIL_28 = {
        "13874A": (-96215, 7946, 0.77, 0.15),
        "1170E1": (-27842, -580, 0.93, 0.60),
        "239742": (-16438, -752, 0.57, 0.51),
        "124603": (-2284, 706, 0.08, -0.14),
        "209742": (-1877, -11044, -2.04, -1.54),
        "043602": (-788047, 6358, 0.23, -0.31),
        "042601": (-1730726, 24254, -2.47, -2.84),
        "044601": (-1525630, 35462, 2.46, 0.43),
        "020601": (-122827, -25994, -1.70, -0.91),
        "045601": (-14312, -9753, 0.34, 0.58),
        "098662": (4530, -486, 1.50, 0.07),
        "097741": (-109383, -8241, -1.94, -0.89),
        "099741": (2339, -6791, -1.73, -0.94),
        "096742": (-58246, -9166, -0.87, -1.55),
        "232741": (71598, 7397, 1.80, 2.62),
        "090741": (-37480, 20505, 0.73, 0.76),
        "095741": (67517, 420, -0.48, 0.02),
        "112741": (-46322, 2132, -1.07, -1.45),
        "092741": (-35675, -2045, -0.62, -0.75),
        "067651": (285061, -1163, 1.38, 0.94),
        "088691": (91574, -3924, -1.33, -0.92),
        "085692": (62995, 3609, 1.56, 1.58),
        "023651": (-167965, 3511, -0.81, -1.50),
        "111659": (56923, -956, -0.05, 0.21),
        "022651": (4535, -1410, -0.73, -0.49),
        "076651": (17681, -2051, -0.26, 0.19),
        "002602": (298680, 82944, 2.27, 1.94),
        "001602": (-1546, 23181, 2.06, 2.12),
        "054642": (57877, -8903, -1.92, -0.29),
        "080732": (-136923, 14221, -0.36, -1.29),
        "033661": (88922, 205, 3.23, 2.16),
        "083731": (24962, 5422, -0.72, -0.62),
        "073732": (-28083, -4054, -1.87, -1.91),
        "040701": (1812, -1045, 0.23, -0.55),
    }

    def test_april_28_full_table_and_august_11_spx_fixture(self):
        april = cftc.build_snapshot(cftc.fetch_official_source(target_report_date="2026-04-28"))
        actual = {
            row["cftcContractMarketCode"]: (
                row["latest"],
                row["wwChg"],
                float(row["zScore1Y"]),
                float(row["zScore3Y"]),
            )
            for row in april["data"]
            if row["status"] == "current"
            and row["cftcContractMarketCode"] in self.APRIL_28
        }
        self.assertEqual(actual, self.APRIL_28)
        new_contracts = {
            row["cftcContractMarketCode"]: row
            for row in april["data"]
            if row["cftcContractMarketCode"] in {"084691", "133741"}
        }
        self.assertEqual(set(new_contracts), {"084691", "133741"})
        self.assertTrue(all(row["status"] == "current" for row in new_contracts.values()))
        august = cftc.build_snapshot(cftc.fetch_official_source(target_report_date="2026-08-11"))
        spx = next(row for row in august["data"] if row["cftcContractMarketCode"] == cftc.SPX_CODE)
        self.assertEqual(
            (spx["latest"], spx["wwChg"], float(spx["zScore1Y"]), float(spx["zScore3Y"])),
            (25427, 32375, 2.42, 1.62),
        )


if __name__ == "__main__":
    unittest.main()
