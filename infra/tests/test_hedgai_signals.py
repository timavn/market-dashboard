"""Published HedgAI changes remain distinct from Trade, Trend and model metrics."""
import hashlib
import os
import sys
import unittest
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

os.environ.setdefault("AWS_EC2_METADATA_DISABLED", "true")
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lambdas/gmail_ingestor"))

import hermes_gmail_ingestor as ingestor
import research_intelligence
from hedgai_signals import instrument_for_label
from parse_hedgeye_email_html import parse_html_snapshot
from infra.tests.test_hermes_gmail_ingestor import FakeEventDynamoDb, FakeLedgerTable


SUBJECT = "HedgAI Signals | Adding Long 30yr Yields; Remaining Long META Up 13%"
# The action markup and misleading teaser match the observed publication;
# personal email/tracking tokens are intentionally excluded from the fixture.
BODY = """<meta type="hedgeye-headline" content="HedgAI Signals | Adding Long 30yr Yields; Remaining Long META Up 13%" />
<meta type="hedgeye-teaser" content="HedgAI Signals | 4/12/2024" />
<meta type="hedgeye-stock-symbols" content="QQQ,NVDA,TSLA,META,PFIX,RFIX" />
<div class="time">09/28/2026 08:43 AM EDT</div>
<p>HedgAI Signals Update: +111% return since inception</p>
<p>A theoretical Sharpe Ratio of 1.6 (long-only strategy)</p>
<ul><li><strong>Buys Added: </strong>UST 30yr Yield</li>
<li><strong>Shorts Added: </strong>US Dollar</li>
<li><strong>Buys Closed:</strong> Palladium, UST 10yr Yield<strong><br /></strong></li>
<li><strong>Shorts Closed: </strong>Platinum</li></ul>
<p>System Expansion Underway</p><p>QQQ, NVDA, TSLA, META, NFLX, PFIX, RFIX</p>
<p>https://app.hedgeye.com/feed_items/187742</p>"""


def publication(body=BODY, subject=SUBJECT, message_id="message-1", received=None):
    return parse_html_snapshot(
        report_type="hedgai-signals", html_body=body, subject=subject,
        received_at=received or datetime(2026, 9, 28, 12, 44, tzinfo=timezone.utc),
        message_id=message_id, s3_key=f"verified/{message_id}.html",
    )


class HedgaiParserTests(unittest.TestCase):
    def test_empty_publisher_list_items_are_zero_actions_without_consuming_the_footer(self):
        body = '''<div>10/05/2026 09:42 AM EDT</div><ul>
        <li><strong>Buys Added:&nbsp;</strong></li>
        <li><strong>Shorts Added: </strong>Consumer Discretionary <abbr>XLY</abbr></li>
        <li><strong>Buys Closed:</strong>&nbsp;<strong><br /></strong></li>
        <li><strong>Shorts Closed:&nbsp;</strong></li></ul>
        <p>( VIEW LARGER IMAGE )</p><p>QQQ, GLD, SPY</p>
        <p>https://app.hedgeye.com/feed_items/188058</p>'''
        snapshot = publication(body=body, subject="HedgAI Signals | Daily update")
        self.assertTrue(snapshot["data"]["complete"])
        self.assertEqual(snapshot["sourceQuality"], {"status": "clear", "issues": []})
        self.assertEqual([(row["ticker"], row["action"]) for row in snapshot["data"]["actions"]], [("XLY", "open-short")])

    def test_wrapped_action_values_stay_within_their_list_item(self):
        body = '''<div>10/02/2026 09:55 AM EDT</div><ul>
        <li><strong>Buys Added:</strong><br />Netflix</li>
        <li><strong>Shorts Added:</strong></li>
        <li><strong>Buys Closed:</strong>Meta</li>
        <li><strong>Shorts Closed:</strong></li></ul>
        <p>https://app.hedgeye.com/feed_items/187974</p>'''
        snapshot = publication(body=body, subject="HedgAI Signals | Daily update")
        self.assertTrue(snapshot["data"]["complete"])
        self.assertEqual([(row["ticker"], row["action"]) for row in snapshot["data"]["actions"]], [("NFLX", "open-long"), ("META", "close-long")])

    def test_unbounded_empty_text_headings_remain_unresolved(self):
        from hedgai_signals import parse_publication
        snapshot = parse_publication(html_body="", text="10/05/2026 09:42 AM EDT\nBuys Added:\nShorts Added: None\nBuys Closed: None\nShorts Closed: None\n( VIEW LARGER IMAGE )",
                                     subject="HedgAI Signals | Daily update", received_at=datetime.now(timezone.utc), message_id="bounded", s3_key="verified/bounded.html")
        self.assertFalse(snapshot["data"]["complete"])
        self.assertEqual(snapshot["data"]["actions"], [])
        self.assertEqual(snapshot["sourceQuality"]["issues"][0]["code"], "HEDGAI_EMPTY_ACTION_CATEGORY")

    def test_correction_subjects_and_observed_action_aliases_cover_the_full_roster(self):
        self.assertEqual(ingestor.infer_report_type("message-body.html", "[CORRECTION] HedgAI Signals | Adding Long MSFT"), "hedgai-signals")
        self.assertIsNotNone(publication(subject="[CORRECTION] " + SUBJECT))
        for label, ticker in {"CAD To USD": "FXC", "Nasdaq": "QQQ", "USD": "UUP", "Healthcare XLV": "XLV",
                              "Copper": "CPER", "Consumer Discretionary XLY": "XLY", "Financials XLF": "XLF",
                              "Uranium URA": "URA", "High Yield HYG": "UJB"}.items():
            self.assertEqual(instrument_for_label(label)["ticker"], ticker)
        import json
        catalog = json.loads((Path(ingestor.__file__).parent / "hedgai_instruments.json").read_text())
        self.assertEqual(len(catalog["instruments"]), 47)
        self.assertEqual(len({row["instrumentId"] for row in catalog["instruments"]}), 47)
        for row in catalog["instruments"]:
            self.assertEqual(instrument_for_label(row["sourceLabel"])["instrumentId"], row["instrumentId"])
            self.assertEqual(instrument_for_label(row["ticker"])["instrumentId"], row["instrumentId"])

    def test_published_september_29_and_30_label_variants_parse_complete_editions(self):
        # Exact action headings from the received editions. Inline abbr markup
        # changes the publisher label from the reviewed table's dollar prefix.
        editions = [
            ("2026-09-29", "09/29/2026 05:45 AM EDT", "187796", """
                <li><strong>Buys Added: </strong>Tesla, Bitcoin</li>
                <li><strong>Shorts Added: </strong>Staples <abbr>XLP</abbr>, Euro To US Dollar</li>
                <li><strong>Buys Closed: </strong>Russell, UST 30yr Yield</li>
                <li><strong>Shorts Closed: </strong>Technology <abbr>XLK</abbr>, Soybean</li>
            """, [
                ("hedgai:TSLA", "open-long"), ("hedgai:IBIT", "open-long"),
                ("hedgai:XLP", "open-short"), ("hedgai:ULE", "open-short"),
                ("hedgai:IWM", "close-long"), ("hedgai:PFIX", "close-long"),
                ("hedgai:XLK", "close-short"), ("hedgai:SOYB", "close-short"),
            ]),
            ("2026-09-30", "09/30/2026 08:33 AM EDT", "187863", """
                <li><strong>Buys Added: </strong>Google, USD To Yen</li>
                <li><strong>Shorts Added: </strong>Palladium</li>
                <li><strong>Buys Closed: </strong>S&amp;P 500, Tesla, Energy <abbr>XLE</abbr>, Lithium <abbr>LIT</abbr></li>
                <li><strong>Shorts Closed: </strong>Nvidia, WTI Crude Oil</li>
            """, [
                ("hedgai:GOOGL", "open-long"), ("hedgai:YCS", "open-long"),
                ("hedgai:PALL", "open-short"), ("hedgai:SPY", "close-long"),
                ("hedgai:TSLA", "close-long"), ("hedgai:XLE", "close-long"),
                ("hedgai:LIT", "close-long"), ("hedgai:NVDA", "close-short"),
                ("hedgai:USO", "close-short"),
            ]),
        ]
        for date, timestamp, feed_id, actions, expected in editions:
            with self.subTest(date=date):
                body = f'<div>{timestamp}</div><ul>{actions}</ul><p>https://app.hedgeye.com/feed_items/{feed_id}</p>'
                snapshot = publication(body=body, subject="HedgAI Signals | Daily update")
                self.assertEqual(snapshot["date"], date)
                self.assertEqual(snapshot["sourceQuality"], {"status": "clear", "issues": []})
                self.assertTrue(snapshot["data"]["complete"])
                self.assertEqual([(row["instrumentId"], row["action"]) for row in snapshot["data"]["actions"]], expected)
                self.assertEqual(snapshot["data"]["publication"]["actionCount"], len(expected))
                self.assertIn("USD To Yen" if date.endswith("30") else "Russell", [row["sourceLabel"] for row in snapshot["data"]["actions"]])

    def test_added_labels_keep_currency_orientation_and_unknown_labels_unmapped(self):
        self.assertEqual(instrument_for_label("USD To Yen")["instrumentId"], "hedgai:YCS")
        self.assertEqual(instrument_for_label("Euro To US Dollar")["instrumentId"], "hedgai:ULE")
        for label in ("Yen To USD", "US Dollar To Euro", "Russell 1000", "Energy XOP", "Staples"):
            self.assertIsNone(instrument_for_label(label))

    def test_real_action_headings_preserve_source_identity_and_exact_time(self):
        snapshot = publication()
        self.assertEqual(snapshot["publishedAt"], "2026-09-28T12:43:00+00:00")
        self.assertEqual(snapshot["date"], "2026-09-28")
        self.assertEqual(snapshot["publicationId"], "hedgai:187742")
        self.assertEqual([(row["instrumentId"], row["action"]) for row in snapshot["data"]["actions"]], [
            ("hedgai:PFIX", "open-long"), ("hedgai:UUP", "open-short"),
            ("hedgai:PALL", "close-long"), ("hedgai:UST", "close-long"),
            ("hedgai:PPLT", "close-short"),
        ])
        self.assertEqual(snapshot["data"]["actions"][0]["sourceLabel"], "UST 30yr Yield")
        self.assertEqual(snapshot["data"]["reaffirmations"][0]["action"], "maintain-long")
        self.assertEqual(snapshot["data"]["reaffirmations"][0]["instrumentId"], "hedgai:META")
        self.assertEqual(snapshot["data"]["metricsPublications"], [])
        self.assertEqual(snapshot["sourceQuality"]["status"], "clear")
        self.assertEqual(research_intelligence.extract_entity_references(snapshot), [])

    def test_subjects_do_not_route_welcome_marketing_or_other_products(self):
        self.assertEqual(ingestor.infer_report_type("message-body.html", SUBJECT), "hedgai-signals")
        for subject in ("Welcome to HedgAI Signals", "HedgAI Signals | Special Offer: Bitcoin",
                        "Get Started With HedgAI Signals", "HedgAI Signals | Subscribe Today"):
            self.assertEqual(ingestor.infer_report_type("message-body.html", subject), "unknown")
            self.assertIsNone(publication(subject=subject))
        self.assertIsNone(publication(body="<p>Welcome to the newest product.</p>"))

    def test_nonpublication_is_ignored_before_body_fetch(self):
        table = FakeLedgerTable()
        metadata = {"payload": {"headers": [{"name": "Subject", "value": "Welcome to HedgAI Signals"}]}}
        with patch.object(ingestor, "get_message_metadata", return_value=metadata), \
                patch.object(ingestor, "get_message") as fetch_body:
            result = ingestor.process_message("token", "me", "welcome", table)
        self.assertTrue(result["ignored"])
        fetch_body.assert_not_called()

    def test_zero_actions_is_a_valid_publication_with_durable_evidence(self):
        body = BODY.replace("UST 30yr Yield</li>", "None</li>")
        body = body.replace("US Dollar</li>", "None</li>").replace("Palladium, UST 10yr Yield", "None")
        body = body.replace("Platinum</li>", "None</li>")
        snapshot = publication(body, "HedgAI Signals | No Changes Today")
        self.assertEqual(snapshot["data"]["actions"], [])
        self.assertTrue(snapshot["data"]["complete"])
        payloads = ingestor._research_event_payloads(snapshot)
        self.assertEqual([kind for kind, _ in payloads], ["HEDGAI_PUBLICATION"])

    def test_unknown_action_does_not_discard_valid_actions_or_source(self):
        snapshot = publication(BODY.replace("UST 30yr Yield</li>", "Unmapped Instrument, UST 30yr Yield</li>"))
        self.assertEqual(len(snapshot["data"]["actions"]), 5)
        self.assertFalse(snapshot["data"]["complete"])
        self.assertEqual(snapshot["sourceQuality"]["issues"][0]["code"], "HEDGAI_INSTRUMENT_UNMAPPED")
        self.assertIn("Unmapped Instrument", snapshot["article"]["bodyText"])
        self.assertIsNone(instrument_for_label("30 year Treasury bond"))

    def test_missing_category_is_a_retained_discrepancy(self):
        snapshot = publication(BODY.replace("<li><strong>Shorts Closed: </strong>Platinum</li>", ""))
        self.assertEqual(len(snapshot["data"]["actions"]), 4)
        self.assertEqual(snapshot["sourceQuality"]["issues"][0]["code"], "HEDGAI_ACTION_CATEGORIES_INCOMPLETE")

    def test_date_uses_new_york_session_and_standard_time(self):
        snapshot = publication(BODY.replace("09/28/2026 08:43 AM EDT", "11/30/2026 11:43 PM EST"))
        self.assertEqual(snapshot["date"], "2026-11-30")
        self.assertEqual(snapshot["publishedAt"], "2026-12-01T04:43:00+00:00")

    def test_events_are_immutable_idempotent_and_separate_from_trade(self):
        snapshot = publication()
        database = FakeEventDynamoDb()
        digest = hashlib.sha256(BODY.encode()).hexdigest()
        self.assertEqual(ingestor.persist_research_event_ledger(snapshot, database, content_sha256=digest), 7)
        self.assertEqual(ingestor.persist_research_event_ledger(snapshot, database, content_sha256=digest), 0)
        events = list(database.table.items.values())
        self.assertEqual({event["sourceEventCount"] for event in events}, {7})
        self.assertEqual({event["eventTime"] for event in events}, {snapshot["publishedAt"]})
        self.assertTrue(all(event["decisionEligible"] is False for event in events))
        self.assertEqual([event["eventType"] for event in events].count("HEDGAI_ACTION"), 5)
        self.assertEqual(research_intelligence.build_entity_events(snapshot), [])

    def test_same_day_publications_merge_even_when_received_out_of_order(self):
        morning = publication()
        later = publication(BODY.replace("08:43 AM", "02:43 PM").replace("187742", "187999"),
                            message_id="message-2", received=datetime(2026, 9, 28, 18, 45, tzinfo=timezone.utc))
        merged = ingestor._merge_materialized_snapshot(None, later)
        merged = ingestor._merge_materialized_snapshot(merged, morning)
        self.assertEqual([p["publicationId"] for p in merged["data"]["publications"]], ["hedgai:187742", "hedgai:187999"])
        self.assertEqual(merged["publishedAt"], later["publishedAt"])
        replayed = ingestor._merge_materialized_snapshot(merged, deepcopy(morning))
        self.assertEqual(replayed["data"], merged["data"])
        self.assertEqual(len(replayed["data"]["actions"]), 10)


if __name__ == "__main__":
    unittest.main()
