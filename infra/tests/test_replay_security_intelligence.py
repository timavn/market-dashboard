#!/usr/bin/env python3
"""Contract tests for deterministic Security Intelligence replay windows."""

from __future__ import annotations

import json
import os
import sys
import unittest
from datetime import date, datetime, timezone
from pathlib import Path


os.environ.setdefault("AWS_EC2_METADATA_DISABLED", "true")
os.environ.setdefault("AWS_DEFAULT_REGION", "us-west-1")
REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "infra" / "scripts"))

import replay_security_intelligence as replay  # noqa: E402


class ReplayMarketCalendarTests(unittest.TestCase):
    def test_package_exposes_dry_run_replay_command(self):
        package = json.loads((REPO_ROOT / "package.json").read_text(encoding="utf-8"))
        self.assertEqual(
            package["scripts"]["research:intelligence:replay"],
            "python3 infra/scripts/replay_security_intelligence.py",
        )

    def test_current_plus_five_market_days_skips_weekend_and_independence_day(self):
        self.assertEqual(
            replay.market_dates("2026-07-07", 5),
            [
                "2026-07-07",
                "2026-07-06",
                "2026-07-02",
                "2026-07-01",
                "2026-06-30",
                "2026-06-29",
            ],
        )

    def test_holiday_or_weekend_final_date_starts_with_latest_market_session(self):
        self.assertEqual(
            replay.market_dates("2026-07-04", 2),
            ["2026-07-02", "2026-07-01", "2026-06-30"],
        )
        self.assertEqual(
            replay.market_dates("2026-11-26", 1),
            ["2026-11-25", "2026-11-24"],
        )

    def test_recurring_holidays_match_the_published_2026_nyse_calendar(self):
        holidays = replay.us_equity_market_holidays(2026)
        for expected in {
            date(2026, 1, 1),
            date(2026, 1, 19),
            date(2026, 2, 16),
            date(2026, 4, 3),
            date(2026, 5, 25),
            date(2026, 6, 19),
            date(2026, 7, 3),
            date(2026, 9, 7),
            date(2026, 11, 26),
            date(2026, 12, 25),
        }:
            with self.subTest(expected=expected):
                self.assertIn(expected, holidays)
                self.assertFalse(replay.is_us_equity_market_day(expected))

    def test_new_years_saturday_exception_and_christmas_observance(self):
        self.assertTrue(replay.is_us_equity_market_day(date(2021, 12, 31)))
        self.assertFalse(replay.is_us_equity_market_day(date(2021, 12, 24)))

    def test_known_extraordinary_exchange_closures_are_not_replayed(self):
        self.assertFalse(replay.is_us_equity_market_day(date(2025, 1, 9)))
        self.assertFalse(replay.is_us_equity_market_day(date(2018, 12, 5)))

    def test_default_date_uses_new_york_instead_of_utc_calendar_date(self):
        self.assertEqual(
            replay.current_market_date(datetime(2026, 7, 4, 2, 30, tzinfo=timezone.utc)),
            "2026-07-03",
        )

    def test_history_window_rejects_out_of_contract_values(self):
        with self.assertRaisesRegex(ValueError, "between 0 and 5"):
            replay.market_dates("2026-07-07", 6)

    def test_empty_inventory_and_parse_failures_are_not_successful_replays(self):
        self.assertEqual(replay.replay_exit_code([]), 1)
        self.assertEqual(
            replay.replay_exit_code([{"status": "failed"}, {"status": "would_index"}]),
            1,
        )
        self.assertEqual(
            replay.replay_exit_code([{"status": "would_index"}, {"status": "would_dispatch"}]),
            0,
        )


if __name__ == "__main__":
    unittest.main()
