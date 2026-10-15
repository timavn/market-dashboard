"""NYSE boundaries and complete, verified historical session prices."""
from datetime import timedelta
import unittest

from btc_nyse_sessions import (SOURCE, aggregate_session, holidays_for_years,
                               normalize_quarter_hour, session_schedule)
from btc_usd_features import instant, iso


def session_candles(session):
    at = instant(session["startAt"])
    return [{"startAt": iso(at + timedelta(minutes=15 * index)),
             "endAt": iso(at + timedelta(minutes=15 * (index + 1))),
             "open": 100 + index, "high": 102 + index, "low": 99 + index,
             "close": 101 + index, "volume": 2, "source": SOURCE, "rawResponse": "raw/verified.json.gz"}
            for index in range(session["expectedCandles"])]


class CalendarTests(unittest.TestCase):
    def test_holidays_weekends_early_close_and_frozen_partial_day(self):
        holidays = holidays_for_years([2025, 2026])
        self.assertIn("2026-04-03", holidays)
        self.assertIn("2026-07-03", holidays)
        sessions, incomplete = session_schedule("2025-07-28T00:00:00Z", "2026-09-15T18:00:00Z", holidays)
        self.assertEqual(len(sessions), 285)
        self.assertEqual(sessions[0]["startAt"], "2025-07-28T13:30:00Z")
        self.assertEqual(sessions[-1]["endAt"], "2026-09-14T20:00:00Z")
        self.assertEqual([row["sessionDate"] for row in incomplete], ["2026-09-15"])
        self.assertEqual([(r["sessionDate"], r["endAt"], r["expectedCandles"]) for r in sessions if r["earlyClose"]],
                         [("2025-11-28", "2025-11-28T18:00:00Z", 14), ("2025-12-24", "2025-12-24T18:00:00Z", 14)])

    def test_ny_dst_changes_utc_boundaries(self):
        sessions, _ = session_schedule("2026-03-06T00:00:00Z", "2026-03-09T21:00:00Z", set())
        self.assertEqual([(row["startAt"], row["endAt"]) for row in sessions],
                         [("2026-03-06T14:30:00Z", "2026-03-06T21:00:00Z"),
                          ("2026-03-09T13:30:00Z", "2026-03-09T20:00:00Z")])

    def test_exact_close_is_complete_but_preclose_is_not(self):
        sessions, incomplete = session_schedule("2026-09-14T00:00:00Z", "2026-09-14T20:00:00Z", set())
        self.assertEqual((len(sessions), len(incomplete)), (1, 0))
        sessions, incomplete = session_schedule("2026-09-14T00:00:00Z", "2026-09-14T19:59:59Z", set())
        self.assertEqual((len(sessions), len(incomplete)), (0, 1))


class CandleTests(unittest.TestCase):
    def setUp(self):
        self.session = session_schedule("2026-09-14T00:00:00Z", "2026-09-14T20:00:00Z", set())[0][0]
        self.candles = session_candles(self.session)

    def test_session_uses_exact_first_open_and_last_close(self):
        row, reason = aggregate_session(self.session, list(reversed(self.candles)), self.session["endAt"])
        self.assertIsNone(reason)
        self.assertEqual((row["open"], row["close"], row["candleCount"]), (100, 126, 26))
        self.assertFalse(row["executable"])

    def test_no_missing_candle_fill_or_partial_day(self):
        for rows, cutoff in ((self.candles[1:], self.session["endAt"]),
                             (self.candles[:-1], self.session["endAt"]),
                             (self.candles, "2026-09-14T19:00:00Z")):
            self.assertIsNone(aggregate_session(self.session, rows, cutoff)[0])

    def test_bad_provenance_price_volume_and_conflicting_duplicates(self):
        for update in ({"mock": True}, {"seeded": True}, {"source": "inferred"}, {"rawResponse": None},
                       {"complete": False}, {"close": float("nan")}, {"low": 300},
                       {"volume": -1}, {"volume": float("nan")}, {"volume": "2"}, {"volume": None}):
            with self.subTest(update=update):
                rows = [{**self.candles[0], **update}, *self.candles[1:]]
                self.assertIsNone(aggregate_session(self.session, rows, self.session["endAt"])[0])
        self.assertIsNone(aggregate_session(self.session, self.candles + [{**self.candles[0], "close": 100.5}], self.session["endAt"])[0])
        self.assertEqual(aggregate_session(self.session, self.candles + [self.candles[0]], self.session["endAt"])[0]["candleCount"], 26)

    def test_quarter_hour_normalization_does_not_accept_hourly_approximation(self):
        row = normalize_quarter_hour([1800, 99, 102, 100, 101, 2], "verified")
        self.assertEqual(row["startAt"], "1970-01-01T00:30:00Z")
        self.assertEqual(row["endAt"], "1970-01-01T00:45:00Z")
        for candle in ([1801, 99, 102, 100, 101, 2], [1800, 99, 102, 100, 101, -1]):
            with self.assertRaises(ValueError):
                normalize_quarter_hour(candle, "verified")


if __name__ == "__main__":
    unittest.main()
