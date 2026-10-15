"""Exact research calendars, source gaps and offline response authenticity."""
import gzip
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from urllib.parse import urlencode

from btc_multiyear_prices import (CALENDAR_SOURCES, COINBASE, EARLY_CLOSES, PROVIDER_DOC, SOURCE,
    aggregate_window, calendar_schedule, derive, hourly_schedule, merge_candles,
    missing_runs, normalize_page, timestamp, verify_archive, verify_raw, windows)
from btc_nyse_sessions import holidays_for_years, normalize_quarter_hour, session_schedule
from btc_price_history import write_json


START = "2026-09-14T00:00:00Z"
CUTOFF = "2026-09-15T04:00:00Z"


def raw_candle(at):
    return [at, 99, 103, 100, 102, 2]


def slots_between(start, end):
    return {at: normalize_quarter_hour(raw_candle(at), "raw/coinbase/verified.json.gz")
            for at in range(timestamp(start), timestamp(end), 900)}


def archive_fixture(destination, conflicting=False):
    """Synthetic observations live only inside isolated test temporary directories."""
    parameters = {"granularity": 900, "start": START, "end": CUTOFF}
    url = COINBASE + "/products/BTC-USD/candles?" + urlencode(sorted(parameters.items()))
    relative = "raw/coinbase/" + hashlib.sha256(url.encode()).hexdigest()[:24] + ".json.gz"
    payload = [raw_candle(at) for at in range(timestamp(START), timestamp(CUTOFF), 900)]
    if conflicting:
        payload.append([timestamp(START), 99, 103, 100, 101, 2])
    body = json.dumps(payload).encode()
    raw_path = destination / relative
    raw_path.parent.mkdir(parents=True)
    raw_path.write_bytes(gzip.compress(body, mtime=0))
    request = {"url": url, "provider": "coinbase", "retrievedAt": "2026-09-15T20:00:00Z",
               "httpStatus": 200, "httpDate": "Tue, 15 Sep 2026 20:00:00 GMT",
               "sha256": hashlib.sha256(body).hexdigest(), "rawResponse": relative,
               "bodyBytes": len(body), "reusedArchive": False}
    write_json(raw_path.with_suffix(".metadata.json"), request)
    rows, rejected = normalize_page(payload, relative, timestamp(START), timestamp(CUTOFF))
    slots, conflicts = {}, set()
    merge_candles(slots, conflicts, rows)
    if conflicts:
        rejected.append({"startAt": START, "reason": "Conflicting provider candles"})
    metadata = {"schemaVersion": 1, "source": SOURCE, "provider": "Coinbase Exchange", "productId": "BTC-USD",
                "historical": True, "executable": False, "startInclusive": START,
                "studyStartInclusive": START, "cutoff": CUTOFF, "asOf": "2026-09-15T20:00:00Z",
                "warmupDays": 0, "providerDocumentation": PROVIDER_DOC}
    coverage = {"15m": {"expectedIntervals": 112, "observedIntervals": len(slots),
                        "missingIntervals": missing_runs(slots, timestamp(START), timestamp(CUTOFF)),
                        "missingIntervalCount": 112 - len(slots), "rejected": rejected, "gapRechecks": []}}
    write_json(destination / "candles-15m.json", {**metadata, "granularitySeconds": 900,
               "rows": [slots[at] for at in sorted(slots)], "coverage": coverage["15m"]})
    for interval_id, filename in (("hourly", "hourly.json"), ("calendar", "calendar-days.json"), ("nyse", "nyse-sessions.json")):
        rows, coverage[interval_id] = derive(slots, START, CUTOFF, interval_id)
        write_json(destination / filename, {**metadata, "interval": interval_id, "timeZone": "America/New_York",
                   "calendarSources": CALENDAR_SOURCES if interval_id == "nyse" else [],
                   "earlyCloseDates": sorted(EARLY_CLOSES) if interval_id == "nyse" else [],
                   "rows": rows, "coverage": coverage[interval_id]})
    write_json(destination / "fetch-manifest.json", {**metadata, "requests": [request], "coverage": coverage})
    return relative, slots


class CalendarTests(unittest.TestCase):
    def test_five_year_schedule_counts_and_frozen_cutoff(self):
        start, cutoff = "2021-09-15T04:00:00Z", "2026-09-15T18:00:00Z"
        for fn, expected, incomplete in ((hourly_schedule, 43838, 0),
                                         (calendar_schedule, 1826, 1), (session_schedule, 1254, 1)):
            with self.subTest(calendar=fn.__name__):
                rows, pending = fn(start, cutoff)
                self.assertEqual((len(rows), len(pending)), (expected, incomplete))
                self.assertTrue(all(row["endAt"] <= cutoff for row in rows))
                if pending:
                    self.assertEqual(pending[0]["sessionDate"], "2026-09-15")

    def test_calendar_day_dst_is_23_or_25_hours(self):
        for start, cutoff, expected in (("2026-03-08T05:00:00Z", "2026-03-09T04:00:00Z", 92),
                                        ("2025-11-02T04:00:00Z", "2025-11-03T05:00:00Z", 100)):
            rows, pending = calendar_schedule(start, cutoff)
            self.assertEqual((len(rows), len(pending), rows[0]["expectedCandles"]), (1, 0, expected))
            bars, coverage = derive(slots_between(start, cutoff), start, cutoff, "calendar")
            self.assertEqual((bars[0]["durationHours"], bars[0]["candleCount"]), (expected / 4, expected))
            self.assertEqual(coverage["missingIntervalCount"], 0)

    def test_calendar_skips_partial_first_day_and_includes_weekend(self):
        rows, pending = calendar_schedule("2026-09-11T13:30:00Z", "2026-09-14T18:00:00Z")
        self.assertEqual([r["sessionDate"] for r in rows], ["2026-09-12", "2026-09-13"])
        self.assertEqual([r["sessionDate"] for r in pending], ["2026-09-14"])

    def test_hourly_repeated_dst_hour_has_distinct_utc_keys(self):
        rows, pending = hourly_schedule("2025-11-02T05:00:00Z", "2025-11-02T07:00:00Z")
        self.assertEqual(len(rows), 2)
        self.assertFalse(pending)
        bars, _ = derive(slots_between(rows[0]["startAt"], rows[-1]["endAt"]), rows[0]["startAt"], rows[-1]["endAt"], "hourly")
        self.assertEqual([r["newYorkStart"] for r in bars], ["2025-11-02T01:00:00-04:00", "2025-11-02T01:00:00-05:00"])

    def test_official_holidays_and_early_closes_2021_through_2026(self):
        holidays = holidays_for_years(range(2021, 2027))
        for value in ("2022-06-20", "2023-06-19", "2024-06-19", "2025-01-09", "2026-07-03"):
            self.assertIn(value, holidays)
        for value in ("2021-06-18", "2021-12-31", "2026-07-02"):
            self.assertNotIn(value, holidays)
        rows, _ = session_schedule("2021-01-01T05:00:00Z", "2026-12-31T23:00:00Z", holidays)
        shortened = {row["sessionDate"]: row for row in rows if row["earlyClose"]}
        self.assertEqual(set(shortened), EARLY_CLOSES)
        self.assertTrue(all(row["expectedCandles"] == 14 for row in shortened.values()))
        self.assertEqual(next(row for row in rows if row["sessionDate"] == "2026-07-02")["expectedCandles"], 26)


class CandleTests(unittest.TestCase):
    def test_page_boundaries_never_extend_requested_window(self):
        first, last = timestamp(START), timestamp(START) + 3600
        payload = [raw_candle(at) for at in range(first - 900, last + 1800, 900)]
        rows, bad = normalize_page(payload, "raw/coinbase/x.json.gz", first, last)
        self.assertEqual([timestamp(row["startAt"]) for row in rows], list(range(first, last, 900)))
        self.assertFalse(bad)
        pages = list(windows(START, CUTOFF, page_size=30))
        self.assertEqual(pages[0][0], timestamp(START))
        self.assertEqual(pages[-1][1], timestamp(CUTOFF))
        self.assertTrue(all(left[1] == right[0] for left, right in zip(pages, pages[1:])))

    def test_invalid_and_off_boundary_provider_observations_rejected(self):
        first = timestamp(START)
        payload = [raw_candle(first + 1), [first, 99, 103, 100, float("inf"), 2],
                   [first, 99, 103, 100, 102, -1], [first, 99, 103, 100, 102, 1e1000]]
        rows, bad = normalize_page(payload, "raw/coinbase/x.json.gz", first, first + 3600)
        self.assertFalse(rows)
        self.assertEqual(len(bad), 4)

    def test_conflicting_duplicate_is_permanently_quarantined(self):
        row = normalize_quarter_hour(raw_candle(timestamp(START)), "raw/coinbase/z.json.gz")
        conflict = {**row, "close": 101, "rawResponse": "raw/coinbase/a.json.gz"}
        slots, conflicts = {}, set()
        for candidate in (row, conflict, row):
            merge_candles(slots, conflicts, [candidate])
        self.assertFalse(slots)
        self.assertEqual(conflicts, {timestamp(START)})

    def test_identical_duplicates_have_deterministic_provenance(self):
        row = normalize_quarter_hour(raw_candle(timestamp(START)), "raw/coinbase/z.json.gz")
        duplicate = {**row, "rawResponse": "raw/coinbase/a.json.gz"}
        for candidates in ([row, duplicate], [duplicate, row]):
            slots = {}
            merge_candles(slots, set(), candidates)
            self.assertEqual(slots[timestamp(START)], duplicate)

    def test_missing_candle_excludes_whole_interval_without_filling(self):
        slots = slots_between(START, CUTOFF)
        del slots[timestamp("2026-09-14T14:00:00Z")]
        for interval_id in ("hourly", "calendar", "nyse"):
            rows, coverage = derive(slots, START, CUTOFF, interval_id)
            self.assertEqual(coverage["missingIntervalCount"], 1)
            self.assertFalse(any(r["startAt"] <= "2026-09-14T14:00:00Z" < r["endAt"] for r in rows))

    def test_unverified_provenance_invalid_prices_and_partial_bars_fail_closed(self):
        window = hourly_schedule(START, CUTOFF)[0][0]
        slots = slots_between(window["startAt"], window["endAt"])
        first = timestamp(START)
        original = slots[first]
        for update in ({"mock": True}, {"isMock": "true"}, {"seeded": True}, {"source": "fallback"},
                       {"stale": True}, {"cacheOnly": True}, {"cache_only": True}, {"providerStatus": "offline"},
                       {"providerConnected": False}, {"rawResponse": ""}, {"complete": False},
                       {"high": 99}, {"low": 105}, {"open": 0}, {"volume": True}, {"volume": float("nan")},
                       {"endAt": "2026-09-14T00:30:00Z"}):
            with self.subTest(update=update):
                slots[first] = {**original, **update}
                self.assertIsNone(aggregate_window(window, slots, "hourly", CUTOFF)[0])
        slots[first] = original
        self.assertIsNone(aggregate_window(window, slots, "hourly", "2026-09-14T00:45:00Z")[0])


class ArchiveTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name)
        self.relative, self.slots = archive_fixture(self.path)

    def change_json(self, filename, change):
        path = self.path / filename
        document = json.loads(path.read_text())
        change(document)
        write_json(path, document)

    def test_archive_replays_all_intervals_offline_with_original_metadata(self):
        with patch("btc_price_history.Downloader.get", side_effect=AssertionError("Unexpected network call")):
            slots, metadata = verify_archive(self.path)
        self.assertEqual(slots, self.slots)
        self.assertEqual(metadata["verifiedRequests"], 1)
        self.assertEqual(metadata["asOf"], "2026-09-15T20:00:00Z")
        self.assertEqual(metadata["calendarSources"], CALENDAR_SOURCES)

    def test_original_response_hash_tamper_rejected(self):
        path = self.path / self.relative
        path.write_bytes(gzip.compress(b"[]", mtime=0))
        with self.assertRaisesRegex(ValueError, "hash mismatch"):
            verify_archive(self.path)

    def test_original_request_identity_tamper_rejected(self):
        metadata_path = (self.path / self.relative).with_suffix(".metadata.json")
        for field, value in (("provider", "unverified"), ("httpStatus", 500), ("bodyBytes", 1),
                             ("url", "https://api.exchange.coinbase.com/products/ETH-USD/candles?granularity=900")):
            original = json.loads(metadata_path.read_text())
            write_json(metadata_path, {**original, field: value})
            with self.assertRaises(ValueError):
                verify_raw(self.path, self.relative)
            write_json(metadata_path, original)

    def test_normalized_candle_tamper_rejected(self):
        self.change_json("candles-15m.json", lambda doc: doc["rows"][0].update(close=101))
        with self.assertRaisesRegex(ValueError, "Normalized candles"):
            verify_archive(self.path)

    def test_derived_interval_tamper_rejected(self):
        self.change_json("calendar-days.json", lambda doc: doc["rows"][0].update(close=101))
        with self.assertRaisesRegex(ValueError, "Derived calendar"):
            verify_archive(self.path)

    def test_manifest_request_tamper_rejected(self):
        self.change_json("fetch-manifest.json", lambda doc: doc["requests"][0].update(retrievedAt="2026-09-15T21:00:00Z"))
        with self.assertRaisesRegex(ValueError, "request does not match"):
            verify_archive(self.path)

    def test_conflict_quarantine_replays_from_original_responses(self):
        with tempfile.TemporaryDirectory() as target:
            path = Path(target)
            _, expected = archive_fixture(path, conflicting=True)
            slots, metadata = verify_archive(path)
            self.assertEqual(slots, expected)
            self.assertEqual(metadata["coverage"]["missingIntervalCount"], 1)
            self.assertNotIn(timestamp(START), slots)


if __name__ == "__main__":
    unittest.main()
