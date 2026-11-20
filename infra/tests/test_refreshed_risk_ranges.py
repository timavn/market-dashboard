"""A Real-Time Alert's refreshed Risk Range revises the current range row and daily snapshot."""
from __future__ import annotations

import sys
import unittest
from copy import deepcopy
from decimal import Decimal
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lambdas" / "gmail_ingestor"))

from botocore.exceptions import ClientError  # noqa: E402

import hermes_gmail_ingestor as ingestor  # noqa: E402
import parse_hedgeye_email_html as email_parser  # noqa: E402


def conflict():
    return ClientError({"Error": {"Code": "ConditionalCheckFailedException"}}, "UpdateItem")


class RangeTable:
    """HedgeyeRiskRanges: (date, ticker) rows; the update sets `revision` under the ingestor's condition."""

    def __init__(self, rows):
        self.rows = {(row["date"], row["ticker"]): deepcopy(row) for row in rows}

    def get_item(self, Key, ConsistentRead=False):
        row = self.rows.get((Key["date"], Key["ticker"]))
        return {"Item": deepcopy(row)} if row else {}

    def update_item(self, Key, UpdateExpression, ConditionExpression, ExpressionAttributeNames, ExpressionAttributeValues):
        row = self.rows.get((Key["date"], Key["ticker"]))
        values = ExpressionAttributeValues
        existing = (row or {}).get("revision")
        if not row or row.get("sourceMessageId") != values[":src"] or (existing and existing["eventTime"] > values[":at"]):
            raise conflict()
        row["revision"] = deepcopy(values[":rev"])


class DailyTable:
    """HedgeyeDailySnapshot: the risk-ranges record's data[ticker].revision."""

    def __init__(self, items):
        self.items = {(item["date"], item["snapshotType"]): deepcopy(item) for item in items}

    def update_item(self, Key, UpdateExpression, ConditionExpression, ExpressionAttributeNames, ExpressionAttributeValues):
        item = self.items.get((Key["date"], Key["snapshotType"]))
        ticker = ExpressionAttributeNames["#ticker"]
        values = ExpressionAttributeValues
        row = ((item or {}).get("data") or {}).get(ticker)
        if row is None or item.get("sourceMessageId") != values[":src"] or (row.get("revision") and row["revision"]["eventTime"] > values[":at"]):
            raise conflict()
        row["revision"] = deepcopy(values[":rev"])


class Db:
    def __init__(self, ranges, daily):
        self.tables = {ingestor.RISK_RANGE_DATA_TABLE: ranges, ingestor.HEDGEYE_DAILY_SNAPSHOT_TABLE: daily}

    def Table(self, name):
        return self.tables[name]


def morning(date="2026-11-20", updated="2026-11-20T12:32:45+00:00", source="morning-email"):
    ranges = RangeTable([{"date": date, "ticker": "SPX", "lrr": Decimal("7106"), "hrr": Decimal("7518"),
                          "trend": "BEARISH", "updatedAt": updated, "sourceMessageId": source}])
    daily = DailyTable([{"date": date, "snapshotType": "risk-ranges", "sourceMessageId": source,
                         "data": {"SPX": {"lrr": Decimal("7106"), "hrr": Decimal("7518"), "trend": "BEARISH"}}}])
    return Db(ranges, daily)


def alert_snapshot(event_time="2026-11-20T19:23:35+00:00", lrr=6899, hrr=7367, message="1a1fa6a6a05e2a56"):
    alert = {"ticker": "ODFL", "eventTime": event_time, "sourceMessageId": message,
             "headline": "Real-Time Alert: Cover-SOME Signal (SPX Refreshed Range): ODFL -KM",
             "refreshedRiskRange": {"ticker": "SPX", "lrr": lrr, "hrr": hrr, "label": "SPX Refreshed Risk Range"}}
    return {"date": event_time[:10], "snapshotType": "real-time-alert", "scrapedAt": event_time,
            "gmailMessageId": message, "data": {"alert": alert, "alerts": [alert]}}


class RefreshedRiskRangeTests(unittest.TestCase):
    def test_parser_reads_any_ticker_and_keeps_the_spx_field(self):
        text = ("ODFL isn't at its LRR yet - this is just another SPX Levels update with VIX in the F-Bucket\n"
                "SPX Refreshed Risk Range = 6899-7367\nand the refreshed VIX Risk Range of 18.10-24.50")
        alert = email_parser._with_refreshed_spx_risk_range({}, text)
        self.assertEqual(alert["refreshedRiskRange"], {"ticker": "SPX", "lrr": 6899.0, "hrr": 7367.0, "label": "SPX Refreshed Risk Range"})
        self.assertEqual([row["ticker"] for row in alert["refreshedRiskRanges"]], ["SPX", "VIX"])
        self.assertEqual(email_parser._extract_refreshed_risk_ranges("SPX Refreshed Risk Range = 7400-7300"), [])

    def test_a_later_alert_revises_the_row_and_snapshot_and_keeps_the_published_range(self):
        db = morning()
        self.assertEqual(ingestor.apply_refreshed_risk_ranges(alert_snapshot(), db), ["2026-11-20:SPX"])
        row = db.tables[ingestor.RISK_RANGE_DATA_TABLE].rows[("2026-11-20", "SPX")]
        self.assertEqual((row["lrr"], row["hrr"]), (Decimal("7106"), Decimal("7518")))
        self.assertEqual(row["revision"]["lrr"], Decimal("6899"))
        self.assertEqual(row["revision"]["hrr"], Decimal("7367"))
        self.assertEqual(row["revision"]["publishedLrr"], Decimal("7106"))
        self.assertEqual(row["revision"]["sourceMessageId"], "1a1fa6a6a05e2a56")
        self.assertEqual(row["revision"]["eventTime"], "2026-11-20T19:23:35+00:00")
        daily = db.tables[ingestor.HEDGEYE_DAILY_SNAPSHOT_TABLE].items[("2026-11-20", "risk-ranges")]
        self.assertEqual(daily["data"]["SPX"]["revision"], row["revision"])
        self.assertEqual(daily["data"]["SPX"]["lrr"], Decimal("7106"))

    def test_replays_and_older_alerts_never_replace_a_later_revision(self):
        db = morning()
        ingestor.apply_refreshed_risk_ranges(alert_snapshot(), db)
        self.assertEqual(ingestor.apply_refreshed_risk_ranges(alert_snapshot(), db), ["2026-11-20:SPX"])
        older = alert_snapshot("2026-11-20T15:00:00+00:00", 7000, 7400, "older-alert")
        self.assertEqual(ingestor.apply_refreshed_risk_ranges(older, db), [])
        row = db.tables[ingestor.RISK_RANGE_DATA_TABLE].rows[("2026-11-20", "SPX")]
        self.assertEqual(row["revision"]["lrr"], Decimal("6899"))

    def test_an_alert_before_the_morning_email_is_superseded(self):
        db = morning(updated="2026-11-20T12:32:45+00:00")
        self.assertEqual(ingestor.apply_refreshed_risk_ranges(alert_snapshot("2026-11-20T11:00:00+00:00"), db), [])
        self.assertNotIn("revision", db.tables[ingestor.RISK_RANGE_DATA_TABLE].rows[("2026-11-20", "SPX")])

    def test_a_premarket_alert_revises_the_latest_earlier_row(self):
        db = morning(date="2026-11-19", updated="2026-11-19T12:30:00+00:00")
        self.assertEqual(ingestor.apply_refreshed_risk_ranges(alert_snapshot("2026-11-20T11:00:00+00:00"), db), ["2026-11-19:SPX"])

    def test_unknown_tickers_and_other_products_are_ignored(self):
        db = morning()
        snapshot = alert_snapshot()
        snapshot["data"]["alert"]["refreshedRiskRange"]["ticker"] = "ZZZZ"
        self.assertEqual(ingestor.apply_refreshed_risk_ranges(snapshot, db), [])
        self.assertEqual(ingestor.apply_refreshed_risk_ranges({**alert_snapshot(), "snapshotType": "etf-pro"}, db), [])

    def test_materialization_still_stores_the_alert_when_the_revision_fails(self):
        puts = []

        class Table:
            def get_item(self, Key):
                return {}

            def put_item(self, **kwargs):
                puts.append(kwargs["Item"]["snapshotType"])

        class Ok:
            def Table(self, name):
                return Table()

        with mock.patch.object(ingestor, "apply_refreshed_risk_ranges", side_effect=RuntimeError("down")):
            ingestor.materialize_email_snapshot(alert_snapshot(), Ok())
        self.assertEqual(puts, ["real-time-alert"])



if __name__ == "__main__":
    unittest.main()
