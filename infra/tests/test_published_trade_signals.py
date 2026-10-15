import os
import sys
import unittest
from pathlib import Path

os.environ.setdefault("AWS_EC2_METADATA_DISABLED", "true")
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lambdas" / "gmail_ingestor"))
from published_trade_signals import extract_published_trade_signals
from research_intelligence import build_entity_events
from parse_hedgeye_email_html import _parse_tracker_table


class PublishedTradeTests(unittest.TestCase):
    def publication(self, product="early-look", text="", data=None):
        return {"date": "2026-09-25", "publishedAt": "2026-09-25T11:30:00Z",
                "snapshotType": product, "gmailMessageId": "original",
                "htmlSource": "hedgeye-email/messages/2026-09-25/early-look/original.html",
                "data": data or {}, "article": {"bodyText": text, "feedUrl": "https://app.hedgeye.com/feed_items/187649"}}

    def test_explicit_statements_work_across_products_with_exact_instrument(self):
        for product in ("early-look", "the-macro-show", "risk-ranges"):
            item = self.publication(product, "SPX is BULLISH TRADE and TREND.\nNVDA Trade: BEARISH\nCorn remains NEUTRAL TRADE and TREND.")
            values = {(row["ticker"], row["value"]) for row in extract_published_trade_signals(item)}
            self.assertEqual(values, {("SPX", "BULLISH"), ("NVDA", "BEARISH"), ("CORN", "NEUTRAL")})
            events = [event for event in build_entity_events(item) if event["eventType"] == "trade_signal"]
            self.assertEqual({event["sourceTicker"] for event in events}, {"SPX", "NVDA", "CORN"})
            self.assertTrue(all(event["decisionEligible"] for event in events))
            self.assertTrue(all(event["signalProvenance"]["field"] == "trade" for event in events))

    def test_ranges_trend_old_and_hypothetical_claims_are_not_trade(self):
        for text in ("SPX is BULLISH TREND.", "If SPX is BULLISH TRADE we would add.",
                     "SPX was previously BULLISH TRADE.", "THIS is BULLISH TRADE.",
                     "SPX is BULLISH TRADE versus BEARISH TRADE last month."):
            self.assertEqual(extract_published_trade_signals(self.publication(text=text)), [])
        item = self.publication("momo-tracker", data={"NVDA": {"trade": "BULLISH", "trend": "BULLISH", "buyTrade": 210, "sellTrade": 230}})
        self.assertEqual(extract_published_trade_signals(item), [])
        self.assertFalse(any(event["eventType"] == "trade_signal" for event in build_entity_events(item)))

    def test_distinct_trade_column_is_independent_of_trend_and_range(self):
        rows = [["Ticker", "Buy Trade", "Sell Trade", "Trend", "Trade"],
                ["NVDA", "210", "230", "BULLISH", "BEARISH"]]
        parsed = _parse_tracker_table(rows, required_fields=("ticker", "buyTrade", "sellTrade", "trend"))
        self.assertEqual(parsed["NVDA"]["trend"], "BULLISH")
        self.assertEqual(parsed["NVDA"]["trade"], "BEARISH")
        signal = extract_published_trade_signals(self.publication("momo-tracker", data=parsed))[0]
        self.assertEqual(signal["value"], "BEARISH")
        self.assertEqual(signal["signalProvenance"]["sourceField"], "tracker.NVDA.Trade")

    def test_field_discrepancies_withhold_only_affected_trade(self):
        item = self.publication(text="SPX is BULLISH TRADE and TREND.")
        item["sourceQuality"] = {"issues": [{"ticker": "SPX", "affectedFields": ["lrr", "hrr"]}]}
        self.assertEqual(len(extract_published_trade_signals(item)), 1)
        item["sourceQuality"]["issues"][0]["affectedFields"] = ["trade"]
        self.assertEqual(extract_published_trade_signals(item), [])


if __name__ == "__main__":
    unittest.main()
