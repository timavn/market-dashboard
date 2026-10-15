"""Past-only entry evidence, interval counts, and private-source export boundaries."""
from datetime import timedelta
import gzip
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from urllib.parse import urlencode

from btc_hourly_bias import SignalTimeline
from btc_interval_study import (DAILY_MODES, HOURLY_MODES, add_quad_overlays, archived_daily_prices,
                               build_interval, calculate, past_features, prepare_daily, prepare_hourly,
                               public_rows, select, validate)
from btc_nyse_sessions import SOURCE, aggregate_session, session_schedule
from btc_quad_overlay import quarter_bounds
from btc_usd_features import instant, iso
from test_btc_nyse_sessions import session_candles


def hourly(at="2026-09-14T13:00:00Z", **updates):
    start = instant(at)
    return {"hourStart": at, "startAt": at, "endAt": iso(start + timedelta(hours=1)),
            "open": 110, "close": 111, "low": 100, "high": 115, "volume": 2,
            "source": "coinbase_exchange_public_hourly_candles", "rawResponse": "private.json.gz",
            "trend": "BULLISH", "signalAvailableAt": "2026-09-14T11:00:00Z",
            "lowerRange": 100, "upperRange": 160, "currentBullishRun": True,
            "pacificDay": start.date().isoformat(), "pacificHour": 6, "indicatorEligible": False, **updates}


class HourlyTests(unittest.TestCase):
    def test_recomputes_closed_outcome_deduplicates_and_rejects_conflicts(self):
        sample = hourly(direction="DOWN", returnPct=-50)
        (rows, _), _ = prepare_hourly([sample, sample], "2026-09-15T18:00:00Z")
        self.assertEqual((len(rows), rows[0]["direction"]), (1, "UP"))
        (rows, _), rejected = prepare_hourly([sample, {**sample, "close": 109}, sample], "2026-09-15T18:00:00Z")
        self.assertEqual(len(rows), 0)
        self.assertIn("Conflicting", rejected[0]["reason"])

    def test_invalid_live_flags_and_price_provenance_are_excluded(self):
        updates = [{"mock": True}, {"seeded": "True"}, {"source": "portfolio"}, {"rawResponse": None},
                   {"stale": True}, {"cacheOnly": True}, {"providerStatus": "offline"},
                   {"providerStatus": "disconnected"}, {"providerStatus": "error"}, {"connected": False},
                   {"close": None}, {"close": float("nan")}, {"endAt": "2026-09-16T14:00:00Z"}]
        for update in updates:
            (rows, _), rejected = prepare_hourly([hourly(**update)], "2026-09-15T18:00:00Z")
            self.assertEqual((len(rows), len(rejected)), (0, 1), update)

    def test_first_per_day_uses_new_york_day_across_pacific_midnight(self):
        samples = [hourly("2026-09-14T04:00:00Z"), hourly("2026-09-14T07:00:00Z")]
        for row in samples:
            row["signalAvailableAt"] = "2026-09-13T11:00:00Z"
        samples[0]["pacificDay"] = "2026-09-13"
        (rows, _), _ = prepare_hourly(samples, "2026-09-15T18:00:00Z")
        self.assertEqual(len(select(rows, "bullish", "bottom", "none", "first_per_day")), 1)


class TimingTests(unittest.TestCase):
    def test_daily_uses_0900_features_not_future_1000_snapshot(self):
        opening = instant("2026-09-14T13:30:00Z")
        prior = hourly(indicatorEligible=True, usdObservedAt="2026-09-14T12:00:00Z", usdAvailableAt="2026-09-14T13:00:00Z",
                       usdSessionMoveBp=-12, corr30Level=-.8, corrAvailableAt="2026-09-14T05:00:00Z")
        future = hourly("2026-09-14T14:00:00Z", usdSessionMoveBp=500)
        fields = past_features(opening, {prior["hourStart"]: prior, future["hourStart"]: future})
        self.assertEqual(fields["usdSessionMoveBp"], -12)
        self.assertEqual(fields["indicatorReferenceAt"], "2026-09-14T13:00:00Z")
        self.assertFalse(past_features(opening, {future["hourStart"]: future})["indicatorEligible"])
        prior["usdAvailableAt"] = "2026-09-14T13:31:00Z"
        self.assertFalse(past_features(opening, {prior["hourStart"]: prior})["indicatorEligible"])

    def test_tracker_rebuilt_at_exact_0930_before_later_report(self):
        def report(at, trend):
            return {"reportDate": "2026-09-14", "publicationAt": at, "receivedAt": at, "availableAt": at,
                    "directionEligible": True, "trend": trend, "lrr": 100, "hrr": 160}
        timeline = SignalTimeline({"records": [report("2026-09-14T13:20:00Z", "BEARISH"), report("2026-09-14T13:40:00Z", "BULLISH")]})
        price = {"sessionDate": "2026-09-14", "startAt": "2026-09-14T13:30:00Z", "endAt": "2026-09-14T20:00:00Z",
                 "open": 145, "close": 144, "high": 160, "low": 100, "volume": 1, "source": SOURCE,
                 "rawResponses": ["private.json.gz"]}
        rows, _ = prepare_daily([price], timeline, [hourly()], instant("2026-08-20T12:38:43Z"))
        self.assertEqual((rows[0]["trend"], rows[0]["entryZone"], rows[0]["direction"]), ("BEARISH", "top", "DOWN"))
        self.assertEqual(rows[0]["signalAvailableAt"], "2026-09-14T13:20:00Z")
        unknown, _ = prepare_daily([price], SignalTimeline({"records": [report("2026-09-14T13:40:00Z", "BULLISH")]}), [], None)
        self.assertFalse(unknown[0]["entryEligible"])

    def test_counts_daily_names_and_export_privacy(self):
        (rows, _), _ = prepare_hourly([hourly()], "2026-09-15T18:00:00Z")
        daily = calculate(rows, "daily", DAILY_MODES, 10)
        self.assertEqual(len(daily), 375)
        self.assertTrue(validate(rows, daily, DAILY_MODES, True)["countsReconciled"])
        self.assertTrue(all("hours" not in row and row["days"] == row["observations"] for row in daily))
        result = calculate(rows, "hourly", HOURLY_MODES, 10)
        self.assertEqual(len(result), 750)
        self.assertTrue(validate(rows, result, HOURLY_MODES)["countsReconciled"])
        rows[0].update(signalMessageId="private-id", signalSourceUrl="https://mail.google.com/private", rawResponses=["private"])
        exported = public_rows(rows)[0]
        self.assertFalse(set(("rawResponse", "rawResponses", "signalMessageId", "signalSourceUrl")) & exported.keys())
        self.assertEqual(exported["source"], "Coinbase BTC-USD")


class ArchiveTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.archive = Path(self.temporary.name)
        self.schedule = session_schedule("2026-09-14T00:00:00Z", "2026-09-14T20:00:00Z", set())[0]
        session = self.schedule[0]
        url = "https://api.exchange.coinbase.com/products/BTC-USD/candles?" + urlencode({"granularity": 900, "start": session["startAt"], "end": session["endAt"]})
        self.relative = "raw/coinbase/" + hashlib.sha256(url.encode()).hexdigest()[:24] + ".json.gz"
        self.path = self.archive / self.relative
        self.path.parent.mkdir(parents=True)
        candles = [{**row, "rawResponse": self.relative} for row in session_candles(session)]
        raw = json.dumps([[int(instant(row["startAt"]).timestamp()), row["low"], row["high"], row["open"], row["close"], row["volume"]] for row in candles]).encode()
        self.path.write_bytes(gzip.compress(raw))
        self.meta = {"sha256": hashlib.sha256(raw).hexdigest(), "httpStatus": 200, "provider": "coinbase", "url": url}
        self.path.with_suffix(".metadata.json").write_text(json.dumps(self.meta))
        price, _ = aggregate_session(session, candles, session["endAt"])
        self.document = {"source": SOURCE, "rows": [price]}

    def tearDown(self):
        self.temporary.cleanup()

    def load(self):
        return archived_daily_prices(self.document, self.archive, self.schedule, "2026-09-14T20:00:00Z")

    def test_verifies_original_bytes_and_exact_product_request(self):
        self.assertEqual(len(self.load()[0]), 1)
        self.meta["url"] = self.meta["url"].replace("BTC-USD", "ETH-USD")
        self.path.with_suffix(".metadata.json").write_text(json.dumps(self.meta))
        self.assertEqual(len(self.load()[0]), 0)

    def test_tampered_prices_hash_and_duplicate_days_excluded(self):
        self.document["rows"][0]["close"] += 1
        self.assertEqual(len(self.load()[0]), 0)
        self.document["rows"][0]["close"] -= 1
        self.document["rows"].append(dict(self.document["rows"][0]))
        self.assertEqual(len(self.load()[0]), 0)
        self.document["rows"].pop()
        self.meta["sha256"] = "wrong"
        self.path.with_suffix(".metadata.json").write_text(json.dumps(self.meta))
        self.assertEqual(len(self.load()[0]), 0)

    def test_explicit_mock_and_disconnected_archive_evidence_excluded(self):
        for update in ({"mock": True}, {"cacheOnly": True}, {"providerStatus": "offline"}):
            original = self.document["rows"][0]
            self.document["rows"][0] = {**original, **update}
            self.assertEqual(len(self.load()[0]), 0)
            self.document["rows"][0] = original


class QuadOverlayTests(unittest.TestCase):
    def setUp(self):
        samples = [hourly(at, signalAvailableAt="2025-07-01T00:00:00Z", currentBullishRun=False)
                   for at in ("2025-07-28T13:00:00Z", "2025-10-02T13:00:00Z", "2026-01-02T14:00:00Z",
                              "2026-04-02T13:00:00Z", "2026-09-14T13:00:00Z")]
        samples[3]["trend"] = "UNKNOWN"
        (self.rows, self.reasons), _ = prepare_hourly(samples, "2026-09-15T18:00:00Z")
        quarters = []
        for quarter, quad, kind in (("2025-Q3", 2, "actual"), ("2025-Q4", 4, "actual"),
                                  ("2026-Q1", 1, "actual"), ("2026-Q2", 3, "actual"), ("2026-Q3", 4, "estimate")):
            start, end = quarter_bounds(quarter)
            quarters.append({"quarter": quarter, "quad": quad, "kind": kind, "periodStart": iso(start), "periodEnd": iso(end)})
        self.source = {"quarters": quarters, "country": "United States", "source": "hedgeye-published-global-quads",
                       "sourceAsOf": "2026-08-12", "availableAt": "2026-09-09T18:02:55.426921Z"}

    def study(self, interval="hourly"):
        gaps = [{"startInclusive": "2025-10-25T16:00:00Z", "endExclusive": "2025-10-25T17:00:00Z", "hours": 1}] if interval == "hourly" else []
        return build_interval(interval, self.rows, self.reasons, len(self.rows) + len(gaps), gaps, [],
                              instant("2026-08-20T12:38:43Z"), 10, "2026-09-15T18:10:12Z")[0]

    def test_all_quads_remains_identical_forecast_excluded_and_counts_reconcile(self):
        study = self.study()
        original = json.dumps(study["rows"], sort_keys=True)
        classified, validations = add_quad_overlays(study, self.rows, self.source, 10)
        self.assertEqual(json.dumps(study["rows"], sort_keys=True), original)
        self.assertEqual(len(validations), 4)
        self.assertEqual([r["quad"] for r in classified], [2, 4, 1, 3, None])
        self.assertEqual(study["quadOverlay"]["classifiedIntervals"], 4)
        self.assertEqual(study["quadOverlay"]["unclassifiedIntervals"], 1)
        self.assertEqual(study["quadOverlay"]["classifiedEligibleEntries"], 3)
        self.assertEqual(study["quadOverlay"]["unclassifiedEligibleEntries"], 1)
        self.assertTrue(all(len(overlay["rows"]) == 750 for overlay in study["quadOverlays"]))
        by_quad = {overlay["quad"]: overlay for overlay in study["quadOverlays"]}
        self.assertEqual(by_quad[4]["coverage"]["missingIntervalCount"], 1)
        self.assertEqual(by_quad[4]["coverage"]["expectedIntervals"], 2)
        self.assertEqual(by_quad[3]["coverage"]["eligibleEntryIntervals"], 0)
        self.assertEqual(by_quad[3]["coverage"]["unknownSignalIntervals"], 1)
        self.assertTrue(all(row["observations"] == 0 for row in by_quad[3]["rows"]))

    def test_daily_quad_rows_keep_daily_count_semantics_and_auditable_exports(self):
        study = self.study("daily")
        classified, _ = add_quad_overlays(study, self.rows, self.source, 10)
        self.assertTrue(all(len(overlay["rows"]) == 375 for overlay in study["quadOverlays"]))
        self.assertTrue(all("hours" not in row and row["observations"] == row["days"]
                            for overlay in study["quadOverlays"] for row in overlay["rows"]))
        exported = public_rows(classified)
        self.assertEqual(exported[0]["quadBasis"], "retrospective_actual")
        self.assertEqual(exported[-1]["quadKind"], "estimate")
        self.assertIsNone(exported[-1]["quad"])
        self.assertIn("/research/bitcoin/daily-quad-statistics.csv", [item["href"] for item in study["downloads"]])


if __name__ == "__main__":
    unittest.main()
