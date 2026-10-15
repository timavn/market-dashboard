"""Offline parity against the supplied Macro Show slide and frozen official records.

The two fixtures have independent origins: displayed expectations were transcribed
from the September 17 slide; inputs are original CFTC long/short observations.
They are test-only and never loaded by the publisher's runtime path.
"""

import copy
import json
import sys
import unittest
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "infra/lambdas/cftc_ingestor"))
import cftc_ingestor as cftc  # noqa: E402

FIXTURES = Path(__file__).parent / "fixtures"


def official_source():
    frozen = json.loads((FIXTURES / "cftc-2026-09-08-source.json").read_text())
    datasets = {"legacy": [], "disaggregated": []}
    for series in frozen["series"]:
        for report_date, long_position, short_position in series["observations"]:
            datasets[series["dataset"]].append({
                "market_and_exchange_names": series["marketName"],
                "report_date_as_yyyy_mm_dd": report_date,
                "cftc_contract_market_code": series["code"],
                "futonly_or_combined": "Combined",
                series["longField"]: str(long_position),
                series["shortField"]: str(short_position),
            })
    return {"reportDate": frozen["reportDate"], "retrievedAt": frozen["retrievedAt"], "datasets": datasets}


def displayed(value, places="0.01"):
    return Decimal(str(value)).quantize(Decimal(places), rounding=ROUND_HALF_UP)


class SeptemberShowParityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = official_source()
        cls.expected = json.loads((FIXTURES / "cftc-2026-09-08.json").read_text())
        cls.snapshot = cftc.build_snapshot(cls.source)

    def test_all_37_show_instruments_match_at_published_precision(self):
        self.assertEqual(len(self.expected["rows"]), 37)
        actual = {row["cftcContractMarketCode"]: row for row in self.snapshot["data"]}
        self.assertEqual(len(actual), 39)  # show roster plus Bitcoin and Eurodollar
        self.assertTrue(self.snapshot["contentComplete"])
        for expected in self.expected["rows"]:
            with self.subTest(metric=expected["metric"]):
                row = actual[expected["code"]]
                self.assertEqual(row["asOf"], self.expected["reportDate"])
                self.assertEqual(row["seriesType"], expected["seriesType"])
                self.assertEqual(row["latest"], expected["latest"])
                self.assertEqual(row["wwChg"], expected["wwChg"])
                for field in ("zScore1Y", "zScore3Y"):
                    self.assertEqual(displayed(row[field]), displayed(expected[field]))

    def test_all_five_history_statistics_match_corn_and_spx(self):
        for code, expected in self.expected["historyStatistics"].items():
            row = next(row for row in self.snapshot["data"] if row["cftcContractMarketCode"] == code)
            for field, value in expected.items():
                with self.subTest(code=code, field=field):
                    self.assertEqual(displayed(row["historyStatistics"][field], "1"), Decimal(value))
        corn = next(row for row in self.snapshot["data"] if row["metric"] == "Corn")
        self.assertEqual(corn["latest"], corn["historyStatistics"]["maximum3Y"])
        self.assertNotEqual(corn["historyStatistics"]["average1Y"], Decimal(93195))
        self.assertNotEqual(corn["zScore1Y"], Decimal("2.25"))

    def test_silver_alternative_is_the_original_managed_money_series(self):
        silver = next(row for row in self.snapshot["data"] if row["cftcContractMarketCode"] == "084691")
        alternate = silver["alternateSeries"]
        self.assertEqual(len(alternate), 1)
        managed = alternate[0]
        self.assertEqual(managed["seriesType"], "disaggregated-managed-money-combined")
        self.assertNotEqual(managed["seriesId"], silver["seriesId"])
        for field, expected in self.expected["managedMoneySilver"].items():
            self.assertEqual(displayed(managed[field]), displayed(expected))

    def test_missing_week_cannot_be_replaced_by_an_older_observation(self):
        source = copy.deepcopy(self.source)
        source["datasets"]["legacy"] = [row for row in source["datasets"]["legacy"]
            if not (row["cftc_contract_market_code"] == "002602"
                    and row["report_date_as_yyyy_mm_dd"] == "2026-09-01")]
        snapshot = cftc.build_snapshot(source)
        corn = next(row for row in snapshot["data"] if row["metric"] == "Corn")
        self.assertEqual(corn["latest"], 486620)
        self.assertIsNone(corn["wwChg"])
        self.assertIsNone(corn["zScore1Y"])


if __name__ == "__main__":
    unittest.main()
