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
from unittest.mock import patch


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
    for contract_index, contract in enumerate((*cftc.CONTRACTS, *cftc.ALTERNATE_CONTRACTS)):
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
    def test_catalog_matches_primary_categories_and_retains_managed_silver_alternate(self):
        legacy = [contract for contract in cftc.CONTRACTS if contract.dataset == "legacy"]
        managed = [contract for contract in cftc.CONTRACTS if contract.dataset == "disaggregated"]
        self.assertEqual(len(cftc.CONTRACTS), 38)
        self.assertEqual(len(legacy), 37)
        self.assertEqual(
            [(row.metric, row.code) for row in managed],
            [("GOLD", "088691")],
        )
        self.assertEqual([(row.metric, row.code) for row in cftc.ALTERNATE_CONTRACTS], [("SILVER", "084691")])
        self.assertEqual(next(row.dataset for row in cftc.CONTRACTS if row.metric == "SILVER"), "legacy")
        self.assertEqual(next(row.code for row in cftc.CONTRACTS if row.metric == "Soybeans"), "005602")
        self.assertEqual(next(row.code for row in cftc.CONTRACTS if row.metric == "Live Cattle"), "057642")
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
        self.assertEqual(snapshot["metricsCount"], 39)
        self.assertEqual(len(snapshot["sourceContentHash"]), 64)
        gold = next(row for row in snapshot["data"] if row["cftcContractMarketCode"] == "088691")
        self.assertEqual(gold["seriesType"], "disaggregated-managed-money-combined")
        silver = next(row for row in snapshot["data"] if row["cftcContractMarketCode"] == "084691")
        self.assertEqual(silver["seriesType"], "legacy-noncommercial-combined")
        self.assertEqual(silver["seriesId"], "084691:legacy-noncommercial-combined")
        self.assertEqual(silver["datasetId"], cftc.LEGACY_DATASET_ID)
        alternate = silver["alternateSeries"][0]
        self.assertEqual(alternate["seriesType"], "disaggregated-managed-money-combined")
        self.assertEqual(alternate["seriesId"], "084691:disaggregated-managed-money-combined")
        self.assertEqual(alternate["datasetId"], cftc.DISAGGREGATED_DATASET_ID)
        self.assertEqual(alternate["source"], cftc.SOURCE)
        self.assertEqual(alternate["asOf"], snapshot["reportDate"])
        self.assertTrue(alternate["decisionEligible"])
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
                "seriesId": "132741:legacy-noncommercial-combined",
                "source": cftc.SOURCE,
                "sourceUrl": cftc.SOURCE_URLS["legacy"],
                "datasetId": cftc.LEGACY_DATASET_ID,
                "historyStatistics": {field: None for field in cftc.HISTORY_WINDOWS},
            },
        )

    def test_z_scores_use_current_observation_and_sample_standard_deviation(self):
        source = synthetic_source()
        contract = cftc.CONTRACTS[0]
        row, warning = cftc.calculate_contract_row(contract, source, source["reportDate"])
        values = [20_000 + 156**2 - (2 * 156 * i) + i**2 for i in range(156)]
        expected_1y = (values[0] - statistics.mean(values[:52])) / statistics.stdev(values[:52])
        expected_3y = (values[0] - statistics.mean(values)) / statistics.stdev(values)
        self.assertIsNone(warning)
        self.assertIsInstance(row["zScore1Y"], Decimal)
        self.assertAlmostEqual(float(row["zScore1Y"]), expected_1y, places=14)
        self.assertAlmostEqual(float(row["zScore3Y"]), expected_3y, places=14)
        self.assertNotEqual(row["zScore1Y"], row["zScore1Y"].quantize(Decimal("0.01")))
        for field, count in (("average3M", 13), ("average6M", 26), ("average1Y", 52)):
            self.assertEqual(row["historyStatistics"][field], sum(map(Decimal, values[:count])) / count)
        self.assertEqual(row["historyStatistics"]["maximum3Y"], max(values))
        self.assertEqual(row["historyStatistics"]["minimum3Y"], min(values))

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

    def test_gap_inside_three_year_history_does_not_borrow_an_older_observation(self):
        source = synthetic_source(count=180)
        contract = next(item for item in cftc.CONTRACTS if item.metric == "VIX")
        original, _ = cftc.calculate_contract_row(contract, source, source["reportDate"])
        dates = cftc._report_calendar(source, source["reportDate"])
        source["datasets"]["legacy"] = [
            row for row in source["datasets"]["legacy"]
            if not (row["cftc_contract_market_code"] == contract.code and row["report_date_as_yyyy_mm_dd"] == dates[75])
        ]
        row, _ = cftc.calculate_contract_row(contract, source, source["reportDate"])
        self.assertEqual(row["status"], "partial")
        self.assertEqual(row["latest"], original["latest"])
        self.assertEqual(row["wwChg"], original["wwChg"])
        self.assertEqual(row["zScore1Y"], original["zScore1Y"])
        self.assertEqual(row["historyStatistics"]["average1Y"], original["historyStatistics"]["average1Y"])
        self.assertIsNone(row["zScore3Y"])
        self.assertIsNone(row["historyStatistics"]["maximum3Y"])
        self.assertIsNone(row["historyStatistics"]["minimum3Y"])
        self.assertEqual(row["historyCoverage"]["zScore3Y"]["status"], "missing-report")

    def test_missing_prior_week_keeps_latest_without_mislabeling_two_week_change(self):
        source = synthetic_source(count=180)
        contract = next(item for item in cftc.CONTRACTS if item.metric == "VIX")
        prior_date = cftc._report_calendar(source, source["reportDate"])[1]
        source["datasets"]["legacy"] = [
            row for row in source["datasets"]["legacy"]
            if not (row["cftc_contract_market_code"] == contract.code and row["report_date_as_yyyy_mm_dd"] == prior_date)
        ]
        row, _ = cftc.calculate_contract_row(contract, source, source["reportDate"])
        self.assertIsNotNone(row["latest"])
        self.assertIsNone(row["wwChg"])
        self.assertIsNone(row["zScore1Y"])
        self.assertIsNone(row["historyStatistics"]["average3M"])

    def test_calendar_union_detects_spx_gap_even_when_spx_has_156_other_observations(self):
        source = synthetic_source(count=180)
        missing_date = cftc._report_calendar(source, source["reportDate"])[75]
        source["datasets"]["legacy"] = [
            row for row in source["datasets"]["legacy"]
            if not (row["cftc_contract_market_code"] == cftc.SPX_CODE and row["report_date_as_yyyy_mm_dd"] == missing_date)
        ]
        with self.assertRaisesRegex(cftc.NoPublishError, "SPX 13874A"):
            cftc.build_snapshot(source)

    def test_all_market_missing_week_cannot_stretch_any_declared_window(self):
        source = synthetic_source(count=180)
        missing_date = cftc._report_calendar(source, source["reportDate"])[8]
        for dataset in source["datasets"]:
            source["datasets"][dataset] = [
                row for row in source["datasets"][dataset]
                if row["report_date_as_yyyy_mm_dd"] != missing_date
            ]
        with self.assertRaisesRegex(cftc.NoPublishError, "SPX 13874A"):
            cftc.build_snapshot(source)

    def test_official_holiday_shift_keeps_the_same_reporting_week_covered(self):
        source = synthetic_source()
        expected = cftc.build_snapshot(source)
        old_date = cftc._report_calendar(source, source["reportDate"])[8]
        shifted_date = datetime.fromordinal(datetime.fromisoformat(old_date).toordinal() + 1).date().isoformat()
        for rows in source["datasets"].values():
            for row in rows:
                if row["report_date_as_yyyy_mm_dd"] == old_date:
                    row["report_date_as_yyyy_mm_dd"] = shifted_date
        actual = cftc.build_snapshot(source)
        self.assertTrue(actual["contentComplete"])
        self.assertEqual(actual["data"][0]["historyStatistics"], expected["data"][0]["historyStatistics"])
        self.assertEqual(actual["data"][0]["zScore3Y"], expected["data"][0]["zScore3Y"])

    def test_alternate_silver_failure_never_invalidates_primary_silver(self):
        for mutation in ("missing", "duplicate", "wrong-cohort", "futures-only", "unexpected-date"):
            with self.subTest(mutation=mutation):
                source = synthetic_source()
                rows = source["datasets"]["disaggregated"]
                target = next(row for row in rows if row["cftc_contract_market_code"] == "084691")
                if mutation == "missing":
                    source["datasets"]["disaggregated"] = [row for row in rows if row["cftc_contract_market_code"] != "084691"]
                elif mutation == "duplicate":
                    rows.append(dict(target))
                elif mutation == "wrong-cohort":
                    target[cftc.LEGACY_LONG_FIELD] = target.pop(cftc.DISAGGREGATED_LONG_FIELD)
                    target[cftc.LEGACY_SHORT_FIELD] = target.pop(cftc.DISAGGREGATED_SHORT_FIELD)
                elif mutation == "futures-only":
                    target["futonly_or_combined"] = "FutOnly"
                else:
                    anomalous = dict(next(row for row in rows if row["cftc_contract_market_code"] == "084691" and row["report_date_as_yyyy_mm_dd"] == cftc._report_calendar(source, source["reportDate"])[8]))
                    anomalous["report_date_as_yyyy_mm_dd"] = datetime.fromordinal(datetime.fromisoformat(anomalous["report_date_as_yyyy_mm_dd"]).toordinal() + 1).date().isoformat()
                    rows.append(anomalous)
                snapshot = cftc.build_snapshot(source)
                silver = next(row for row in snapshot["data"] if row["metric"] == "SILVER")
                self.assertTrue(snapshot["contentComplete"])
                self.assertEqual(silver["status"], "current")
                if mutation == "unexpected-date":
                    self.assertEqual(silver["alternateSeries"][0]["status"], "partial")
                    self.assertIsNotNone(silver["alternateSeries"][0]["latest"])
                    self.assertIsNone(silver["alternateSeries"][0]["zScore1Y"])
                else:
                    self.assertEqual(silver["alternateSeries"][0]["status"], "unavailable")
                    self.assertIsNone(silver["alternateSeries"][0]["latest"])
                self.assertTrue(any(warning.startswith("ALTERNATE:") for warning in snapshot["warnings"]))

    def test_primary_silver_never_substitutes_a_different_trader_cohort(self):
        source = synthetic_source()
        target = next(row for row in source["datasets"]["legacy"] if row["cftc_contract_market_code"] == "084691")
        target[cftc.DISAGGREGATED_LONG_FIELD] = target.pop(cftc.LEGACY_LONG_FIELD)
        target[cftc.DISAGGREGATED_SHORT_FIELD] = target.pop(cftc.LEGACY_SHORT_FIELD)
        snapshot = cftc.build_snapshot(source)
        silver = next(row for row in snapshot["data"] if row["metric"] == "SILVER")
        self.assertEqual(silver["status"], "unavailable")
        self.assertIsNone(silver["latest"])
        self.assertEqual(silver["alternateSeries"][0]["status"], "current")
        self.assertFalse(snapshot["contentComplete"])

    def test_zero_variance_retains_verified_averages_and_extremes_without_a_z_score(self):
        source = synthetic_source()
        contract = next(item for item in cftc.CONTRACTS if item.metric == "VIX")
        for row in source["datasets"]["legacy"]:
            if row["cftc_contract_market_code"] == contract.code:
                row[cftc.LEGACY_LONG_FIELD] = "150000"
        row, _ = cftc.calculate_contract_row(contract, source, source["reportDate"])
        self.assertIsNone(row["zScore1Y"])
        self.assertEqual(row["historyStatistics"]["average1Y"], 50000)
        self.assertEqual(row["historyStatistics"]["maximum3Y"], 50000)

    def test_idempotent_rerun_and_official_revision(self):
        snapshot = cftc.build_snapshot(synthetic_source())
        table = FakeTable()
        self.assertEqual(cftc.persist_snapshot(snapshot, table), "created")
        self.assertEqual(cftc.persist_snapshot(snapshot, table), "unchanged")
        self.assertEqual(len(table.puts), 1)
        revised = dict(snapshot, sourceContentHash="a" * 64)
        self.assertEqual(cftc.persist_snapshot(revised, table), "revised")
        self.assertEqual(len(table.puts), 2)

    def test_daily_verification_recalculates_and_refreshes_retrieval_without_changing_report(self):
        original_source = synthetic_source()
        original = cftc.build_snapshot(original_source)
        table = FakeTable(copy.deepcopy(original))
        next_source = copy.deepcopy(original_source)
        next_source["retrievedAt"] = "2026-08-15T20:15:00+00:00"

        with patch.object(cftc, "_utc_now", return_value=datetime(2026, 8, 15, 20, 15, tzinfo=timezone.utc)), \
                patch.object(cftc, "fetch_official_source", return_value=next_source) as fetch, \
                patch.object(cftc, "build_snapshot", wraps=cftc.build_snapshot) as calculate, \
                patch.object(cftc, "boto3") as aws, \
                patch.object(cftc, "_heartbeat"):
            aws.resource.return_value.Table.return_value = table
            result = cftc.lambda_handler({"source": "aws-scheduler", "scheduleId": cftc.SCHEDULE_ID}, None)

        fetch.assert_called_once_with(target_report_date=None)
        calculate.assert_called_once_with(next_source)
        self.assertEqual(result["result"], "unchanged")
        self.assertEqual(len(table.puts), 1)
        self.assertEqual(table.item["retrievedAt"], next_source["retrievedAt"])
        self.assertEqual(table.item["scrapedAt"], next_source["retrievedAt"])
        self.assertEqual(table.item["date"], original["date"])
        self.assertEqual(table.item["reportDate"], original["reportDate"])
        self.assertEqual(table.item["sourceContentHash"], original["sourceContentHash"])
        self.assertEqual(table.item["data"], original["data"])

    def test_same_content_never_regresses_or_rewrites_equivalent_retrieval_in_another_timezone(self):
        original = cftc.build_snapshot(synthetic_source())
        original["retrievedAt"] = "2026-08-15T20:15:00+00:00"
        original["scrapedAt"] = original["retrievedAt"]
        for retrieved_at in ("2026-08-14T20:15:00Z", "2026-08-15T22:14:00+02:00", "2026-08-15T13:15:00-07:00"):
            with self.subTest(retrieved_at=retrieved_at):
                table = FakeTable(copy.deepcopy(original))
                incoming = dict(original, retrievedAt=retrieved_at, scrapedAt=retrieved_at)
                self.assertEqual(cftc.persist_snapshot(incoming, table), "unchanged")
                self.assertEqual(table.puts, [])
                self.assertEqual(table.item, original)

        # A later instant advances even when its ISO text sorts before the old value.
        table = FakeTable(copy.deepcopy(original))
        later = dict(original, retrievedAt="2026-08-15T13:16:00-07:00", scrapedAt="2026-08-15T13:16:00-07:00")
        self.assertEqual(cftc.persist_snapshot(later, table), "unchanged")
        self.assertEqual(table.item["retrievedAt"], later["retrievedAt"])
        self.assertEqual(len(table.puts), 1)

    def test_unparseable_daily_retrieval_cannot_refresh_same_content(self):
        original = cftc.build_snapshot(synthetic_source())
        for retrieved_at in (None, "invalid", "2026-08-15T20:15:00"):
            with self.subTest(retrieved_at=retrieved_at):
                table = FakeTable(copy.deepcopy(original))
                with self.assertRaises(cftc.NoPublishError):
                    cftc.persist_snapshot(dict(original, retrievedAt=retrieved_at), table)
                self.assertEqual(table.puts, [])
                self.assertEqual(table.item, original)

    def test_failed_stale_or_invalid_daily_check_cannot_refresh_verified_snapshot(self):
        original = cftc.build_snapshot(synthetic_source())
        for label, source in (
            ("failed source", cftc.CftcIngestionError("source unavailable")),
            ("stale report", synthetic_source(report_date="2026-08-01")),
            ("invalid SPX", synthetic_source(omit={cftc.SPX_CODE})),
        ):
            with self.subTest(label=label):
                table = FakeTable(copy.deepcopy(original))
                fetch_kwargs = {"side_effect": source} if isinstance(source, Exception) else {"return_value": source}
                with patch.object(cftc, "_utc_now", return_value=datetime(2026, 8, 15, 20, 15, tzinfo=timezone.utc)), \
                        patch.object(cftc, "fetch_official_source", **fetch_kwargs), \
                        patch.object(cftc, "boto3") as aws, \
                        patch.object(cftc, "_heartbeat"):
                    aws.resource.return_value.Table.return_value = table
                    with self.assertRaises(cftc.CftcIngestionError):
                        cftc.lambda_handler({"source": "aws-scheduler", "scheduleId": cftc.SCHEDULE_ID}, None)

                self.assertEqual(table.puts, [])
                self.assertEqual(table.item, original)
                aws.resource.assert_not_called()

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

    def test_hash_includes_schema_catalog_windows_and_alternate_contract(self):
        source = synthetic_source()
        original_hash = cftc._source_hash(source)
        with patch.object(cftc, "SCHEMA_VERSION", "cftc-positioning-next"):
            self.assertNotEqual(cftc._source_hash(source), original_hash)
        with patch.object(cftc, "CONTRACTS", cftc.CONTRACTS[:-1]):
            self.assertNotEqual(cftc._source_hash(source), original_hash)
        with patch.object(cftc, "ALTERNATE_CONTRACTS", ()):
            self.assertNotEqual(cftc._source_hash(source), original_hash)
        with patch.dict(cftc.WINDOW_CONTRACT, {"includesCurrent": False}):
            self.assertNotEqual(cftc._source_hash(source), original_hash)

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
                round(float(row["zScore1Y"]), 2),
                round(float(row["zScore3Y"]), 2),
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
            (spx["latest"], spx["wwChg"], round(float(spx["zScore1Y"]), 2), round(float(spx["zScore3Y"]), 2)),
            (25427, 32375, 2.42, 1.62),
        )


if __name__ == "__main__":
    unittest.main()
