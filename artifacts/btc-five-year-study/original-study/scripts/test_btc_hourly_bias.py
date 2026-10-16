"""Boundary tests for the historical study (fixtures never enter report inputs)."""
import unittest
from datetime import timedelta

from btc_hourly_bias import (SignalTimeline, clean_candles, direction_return, instant,
                             make_hourly, make_settlement_changes, range_zone,
                             signal_fields, summarize)


def report(at="2026-08-01T10:05:00Z", trend="BULLISH", **updates):
    return {"reportDate": "2026-08-01", "trend": trend, "lrr": 90, "hrr": 110, "directionEligible": True,
            "availableAt": at, "publicationAt": at, "receivedAt": at,
            "sourceUrl": "https://example.test/report", "sourceMessageId": at, **updates}


def candle(at="2026-08-01T11:00:00Z", opening=100, close=101, **updates):
    start = instant(at)
    return {"startAt": at, "endAt": (start + timedelta(hours=1)).isoformat(),
            "open": opening, "high": max(opening, close), "low": min(opening, close),
            "close": close, "volume": 1, "source": "coinbase_exchange", "rawResponse": "raw/test.json", **updates}


class TimelineTests(unittest.TestCase):
    def test_signal_is_known_only_after_publication_and_receipt(self):
        timeline = SignalTimeline({"rows": [report("2026-08-01T09:01:00Z", "BEARISH"), report()]})
        rows = make_hourly([candle("2026-08-01T10:00:00Z"), candle()], timeline)
        self.assertEqual([r["trend"] for r in rows], ["BEARISH", "BULLISH"])
        self.assertEqual(timeline.at(instant("2026-08-01T09:00:00Z"))[1], "Before first timed report")

    def test_exact_hour_release_is_eligible(self):
        timeline = SignalTimeline({"rows": [report("2026-08-01T11:00:00Z")]})
        self.assertEqual(make_hourly([candle()], timeline)[0]["trend"], "BULLISH")

    def test_no_prepublication_or_prereceipt_signal(self):
        with self.assertRaises(ValueError):
            SignalTimeline({"rows": [report(receivedAt="2026-08-01T10:06:00Z")]})

    def test_invalid_report_terminates_prior_state_and_later_recovers(self):
        timeline = SignalTimeline({"rows": [report("2026-08-01T08:00:00Z"),
            report("2026-08-01T10:00:00Z", None, exclusionReason="Unreadable original"),
            report("2026-08-01T12:00:00Z", "BEARISH")]})
        self.assertIsNone(timeline.at(instant("2026-08-01T11:00:00Z"))[0])
        self.assertEqual(timeline.at(instant("2026-08-01T12:00:00Z"))[0]["trend"], "BEARISH")

    def test_date_only_unknown_interrupts_from_eastern_midnight(self):
        timeline = SignalTimeline({"rows": [report("2026-07-31T10:00:00Z"),
                                             report(availableAt=None, publicationAt=None, receivedAt=None)]})
        self.assertIsNotNone(timeline.at(instant("2026-08-01T03:00:00Z"))[0])
        self.assertIsNone(timeline.at(instant("2026-08-01T04:00:00Z"))[0])

    def test_explicit_gap_and_validity_bounds(self):
        timeline = SignalTimeline({"rows": [report(validUntil="2026-08-01T11:00:00Z"), report("2026-08-01T12:00:00Z", validUntil="2026-08-01T14:00:00Z")],
            "interruptions": [{"startAt": "2026-08-01T11:00:00Z", "endAt": "2026-08-01T12:00:00Z", "reason": "Gap"}]})
        self.assertIsNone(timeline.at(instant("2026-08-01T11:00:00Z"))[0])
        self.assertIsNotNone(timeline.at(instant("2026-08-01T12:00:00Z"))[0])
        self.assertIsNone(timeline.at(instant("2026-08-01T14:00:00Z"))[0])

    def test_closed_gap_never_resurrects_a_pre_gap_report(self):
        timeline = SignalTimeline({"rows": [report()], "interruptions": [
            {"startAt": "2026-08-01T11:00:00Z", "endAt": "2026-08-01T12:00:00Z"}]})
        self.assertIsNone(timeline.at(instant("2026-08-01T13:00:00Z"))[0])

    def test_conflicting_simultaneous_reports_are_unknown(self):
        timeline = SignalTimeline({"rows": [report(), report(trend="BEARISH")]})
        self.assertIsNone(timeline.at(instant("2026-08-01T11:00:00Z"))[0])

    def test_direction_does_not_require_available_range(self):
        timeline = SignalTimeline({"rows": [report(lrr=None, hrr=None)]})
        row = make_hourly([candle()], timeline)[0]
        self.assertEqual(row["trend"], "BULLISH")
        self.assertIsNone(row["rangeZone"])

    def test_dst_fall_back_keeps_two_distinct_hour_observations(self):
        timeline = SignalTimeline({"rows": [report("2025-11-01T10:00:00Z")]})
        first = signal_fields(timeline, instant("2025-11-02T08:00:00Z"))
        second = signal_fields(timeline, instant("2025-11-02T09:00:00Z"))
        self.assertEqual((first["pacificHour"], second["pacificHour"]), (1, 1))
        self.assertNotEqual(first["pacificStart"], second["pacificStart"])
        self.assertEqual(first["pacificDay"], second["pacificDay"])

    def test_dst_spring_forward_has_no_fabricated_two_oclock(self):
        timeline = SignalTimeline({"rows": [report("2026-03-07T10:00:00Z")]})
        self.assertEqual(signal_fields(timeline, instant("2026-03-08T09:00:00Z"))["pacificHour"], 1)
        self.assertEqual(signal_fields(timeline, instant("2026-03-08T10:00:00Z"))["pacificHour"], 3)


class PriceTests(unittest.TestCase):
    def test_no_gap_crossing_for_previous_close(self):
        timeline = SignalTimeline({"rows": [report()]})
        rows = make_hourly([candle(), candle("2026-08-01T13:00:00Z")], timeline)
        self.assertTrue(all(r["previousCloseDirection"] is None for r in rows))

    def test_close_open_and_close_previous_are_distinct(self):
        timeline = SignalTimeline({"rows": [report()]})
        rows = make_hourly([candle(close=103), candle("2026-08-01T12:00:00Z", opening=101, close=102)], timeline)
        self.assertEqual(rows[1]["direction"], "UP")
        self.assertEqual(rows[1]["previousCloseDirection"], "DOWN")

    def test_duplicates_missing_and_unfinished_hours(self):
        good = candle()
        rows, rejects = clean_candles({"rows": [good, good, candle("2026-08-01T13:00:00Z")]}, instant("2026-08-01T13:30:00Z"))
        self.assertEqual(len(rows), 1)
        self.assertEqual(len(rejects), 1)
        conflict, rejects = clean_candles({"rows": [good, candle(close=102), good]}, instant("2026-08-01T13:00:00Z"))
        self.assertEqual(conflict, [])
        self.assertEqual(len(rejects), 1)

    def test_boundaries_and_unchanged(self):
        self.assertEqual(direction_return(100, 100), ("UNCHANGED", 0))
        self.assertEqual([range_zone(v, 90, 110) for v in (89, 90, 100, 101, 110, 111)],
                         ["Below lower range", "Lower half", "Lower half", "Upper half", "Upper half", "Above upper range"])
        self.assertIsNone(range_zone(100, 110, 90))

    def test_inferred_or_mock_prices_do_not_enter_research(self):
        for overrides in ({"mock": True}, {"source": "portfolio_derived"}, {"synthetic": True}):
            rows, rejected = clean_candles({"rows": [candle(**overrides)]}, instant("2026-08-01T14:00:00Z"))
            self.assertEqual(rows, [])
            self.assertEqual(len(rejected), 1)

    def test_settlement_only_consecutive_finalized_agreeing_points(self):
        timeline = SignalTimeline({"rows": [report()]})
        points = [{"eventTicker": f"KXBTCD-{hour}", "closeAt": f"2026-08-01T{hour}:00:00Z", "value": 100 + i,
                   "rawResponses": ["raw/test.json"], "status": "finalized"} for i, hour in enumerate(("11", "12", "14", "15"))]
        points[-1]["status"] = "closed"
        rows, rejects = make_settlement_changes({"rows": points}, timeline, instant("2026-08-01T16:00:00Z"))
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["hourStart"], "2026-08-01T11:00:00Z")
        self.assertEqual(len(rejects), 1)
        self.assertEqual(make_settlement_changes({"rows": points}, timeline, instant("2026-08-01T16:00:00Z"),
                                               study_start=instant("2026-08-01T12:00:00Z"))[0], [])
        points.append({**points[1], "value": 500})
        self.assertEqual(make_settlement_changes({"rows": points}, timeline, instant("2026-08-01T16:00:00Z"))[0], [])

    def test_summary_counts_flats_and_daily_block_reproducibility(self):
        rows = [{"direction": direction, "returnPct": change, "pacificDay": day}
                for day in ("2026-08-01", "2026-08-02", "2026-08-03")
                for direction, change in (("UP", 1), ("DOWN", -1), ("UNCHANGED", 0))]
        result = summarize(rows, "fixture", iterations=100)
        self.assertEqual(result["hours"], 9)
        self.assertAlmostEqual(result["upPct"], 100 / 3)
        self.assertEqual(result["up"] + result["down"] + result["unchanged"], 9)
        self.assertEqual(result, summarize(rows, "fixture", iterations=100))
        self.assertTrue(result["limitedSample"])

    def test_missing_settlement_finality_is_rejected(self):
        timeline = SignalTimeline({"rows": [report()]})
        points = [{"eventTicker": f"KXBTCD-{hour}", "closeAt": f"2026-08-01T{hour}:00:00Z", "value": 100,
                   "rawResponses": ["raw/test.json"]} for hour in ("11", "12")]
        rows, rejects = make_settlement_changes({"rows": points}, timeline, instant("2026-08-01T13:00:00Z"))
        self.assertEqual(rows, [])
        self.assertEqual(len(rejects), 2)


if __name__ == "__main__":
    unittest.main()
