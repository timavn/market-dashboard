#!/usr/bin/env python3

from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path


SCRIPT_PATH = (
    Path(__file__).resolve().parents[1]
    / "scripts"
    / "backfill_inflation_nowcast_history.py"
)
SPEC = importlib.util.spec_from_file_location("cpi_history_backfill", SCRIPT_PATH)
backfill = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(backfill)


class InflationNowcastBackfillTest(unittest.TestCase):
    def test_manifest_is_complete_ordered_and_builds_current_legacy_projection(self):
        manifest = backfill.load_manifest(backfill.DEFAULT_MANIFEST)
        forecasts = backfill.validate_manifest(manifest)
        snapshot = backfill.build_snapshot(manifest)

        self.assertEqual(len(forecasts), 13)
        self.assertEqual(forecasts[0]["reportMonth"], "2025-07")
        self.assertEqual(forecasts[-1]["reportMonth"], "2026-07")
        self.assertEqual(snapshot["forecastCount"], 13)
        self.assertEqual(snapshot["data"]["reportMonth"], "2026-07")
        self.assertEqual(snapshot["data"]["releaseAt"], "2026-08-12T12:30:00.000Z")
        self.assertEqual(
            [scenario["value"] for scenario in snapshot["data"]["scenarios"]],
            [forecasts[-1]["scenarios"]["upper"],
             forecasts[-1]["scenarios"]["base"],
             forecasts[-1]["scenarios"]["lower"]],
        )

    def test_manual_sources_keep_hash_provenance_without_a_fake_timestamp(self):
        manifest = backfill.load_manifest(backfill.DEFAULT_MANIFEST)
        forecasts = backfill.validate_manifest(manifest)
        manual = [
            forecast
            for forecast in forecasts
            if forecast.get("selected") is True
        ]

        self.assertEqual([forecast["reportMonth"] for forecast in manual], ["2026-01", "2026-02"])
        self.assertTrue(all(forecast["publishedAt"] is None for forecast in manual))
        self.assertTrue(all(len(forecast["source"]["artifact"]["sha256"]) == 64 for forecast in manual))


if __name__ == "__main__":
    unittest.main()
