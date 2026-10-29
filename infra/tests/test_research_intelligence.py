#!/usr/bin/env python3
"""Tests for immutable per-entity research indexing and manifests."""

from __future__ import annotations

import os
import sys
import unittest
from copy import deepcopy
from decimal import Decimal
from pathlib import Path

from botocore.exceptions import ClientError


os.environ.setdefault("AWS_EC2_METADATA_DISABLED", "true")
sys.path.insert(
    0,
    str(Path(__file__).resolve().parents[1] / "lambdas" / "gmail_ingestor"),
)

import research_intelligence as intelligence  # noqa: E402


def conditional_failure() -> ClientError:
    return ClientError(
        {"Error": {"Code": "ConditionalCheckFailedException", "Message": "exists"}},
        "PutItem",
    )


class FakeTable:
    def __init__(self, key_fields):
        self.key_fields = key_fields
        self.items = {}

    def _key(self, item):
        return tuple(item[field] for field in self.key_fields)

    def get_item(self, *, Key, **_kwargs):
        item = self.items.get(self._key(Key))
        return {"Item": deepcopy(item)} if item else {}

    def put_item(
        self,
        *,
        Item,
        ConditionExpression=None,
        ExpressionAttributeValues=None,
        **_kwargs,
    ):
        key = self._key(Item)
        existing = self.items.get(key)
        if existing and ConditionExpression:
            expected = (ExpressionAttributeValues or {}).get(":expectedVersion")
            if expected is None or int(existing.get("version", 0)) != int(expected):
                raise conditional_failure()
        self.items[key] = deepcopy(Item)
        return {}


class FakeDynamoDb:
    def __init__(self):
        self.events = FakeTable(("entityKey", "eventKey"))
        self.manifests = FakeTable(("marketDate", "productKey"))

    def Table(self, name):
        if name == intelligence.ENTITY_EVENTS_TABLE:
            return self.events
        if name == intelligence.PRODUCT_MANIFEST_TABLE:
            return self.manifests
        raise AssertionError(name)


def snapshot(product, message_id, data, article=None):
    return {
        "date": "2026-07-23",
        "snapshotType": product,
        "publishedAt": "2026-07-23T12:00:00+00:00",
        "scrapedAt": "2026-07-23T12:05:00+00:00",
        "gmailMessageId": message_id,
        "htmlSource": f"hedgeye-email/{message_id}.html",
        "data": data,
        "article": article or {},
    }


class ResearchIntelligenceTests(unittest.TestCase):
    def test_registry_is_the_signal_authority(self):
        self.assertTrue(
            intelligence.product_definition("risk-ranges")["authorities"]["trend"]
        )
        self.assertFalse(
            intelligence.product_definition("early-look")["authorities"]["trend"]
        )
        self.assertFalse(
            intelligence.product_definition("momo-tracker")["authorities"]["trade"]
        )
        self.assertEqual(
            intelligence.product_definition("momo-tracker")["validationRule"],
            "published_tracker_rows",
        )

    def test_extracts_structured_tickers_aliases_and_typed_exposures(self):
        item = snapshot(
            "the-call",
            "call-1",
            {"longs": ["Healthcare (XLV)"], "shorts": [], "neutrals": []},
            {
                "summary": (
                    "DDOG remains in focus while software and technology leadership improves."
                )
            },
        )

        references = intelligence.extract_entity_references(item)
        keys = {reference["entityKey"] for reference in references}

        self.assertIn("ticker#XLV", keys)
        self.assertIn("ticker#DDOG", keys)
        self.assertIn("sector#technology", keys)
        technology = next(
            reference
            for reference in references
            if reference["entityKey"] == "sector#technology"
        )
        self.assertEqual(technology["matchType"], "sector_reference")
        self.assertEqual(technology["exposureType"], "sector")
        self.assertEqual(technology["exposureId"], "technology")
        self.assertEqual(technology["exposureLabel"], "Technology")
        self.assertIn("software", technology["excerpt"].lower())

    def test_emits_factor_sector_country_commodity_and_macro_entity_types(self):
        item = snapshot(
            "the-macro-show",
            "macro-exposures",
            {},
            {
                "summary": (
                    "Growth leadership held in United States equities while "
                    "technology strengthened, gold outperformed WTI, and the "
                    "DXY dollar index moved higher."
                )
            },
        )

        events = intelligence.build_entity_events(
            item,
            content_sha256="9" * 64,
        )
        by_key = {event["entityKey"]: event for event in events}

        expected = {
            "factor#growth": ("factor", "growth"),
            "sector#technology": ("sector", "technology"),
            "country#united-states": ("country", "united-states"),
            "commodity#gold": ("commodity", "gold"),
            "commodity#crude-oil": ("commodity", "crude-oil"),
            "macro#us-dollar": ("macro", "us-dollar"),
        }
        for entity_key, (exposure_type, exposure_id) in expected.items():
            with self.subTest(entity_key=entity_key):
                self.assertIn(entity_key, by_key)
                self.assertEqual(
                    by_key[entity_key]["exposureType"],
                    exposure_type,
                )
                self.assertEqual(
                    by_key[entity_key]["exposureId"],
                    exposure_id,
                )
                self.assertTrue(by_key[entity_key]["exposureLabel"])
                self.assertTrue(by_key[entity_key]["excerpt"])
                self.assertEqual(by_key[entity_key]["schemaVersion"], 2)

        self.assertIn(
            "technology strengthened",
            by_key["sector#technology"]["excerpt"].lower(),
        )

    def test_alias_canonicalization_and_boilerplate_rejection(self):
        item = snapshot(
            "early-look",
            "early-1",
            {"SPX": {"lrr": 6200, "hrr": 6300, "trend": "BULLISH"}},
            {"bodyText": "THE MAIN SUMMARY FOR TODAY"},
        )
        references = intelligence.extract_entity_references(item)
        keys = {reference["entityKey"] for reference in references}

        self.assertIn("ticker#SPY", keys)
        self.assertNotIn("ticker#THE", keys)
        self.assertNotIn("ticker#MAIN", keys)
        self.assertNotIn("ticker#TODAY", keys)

    def test_meridiem_tickers_require_structured_security_fields(self):
        narrative_only = snapshot(
            "real-time-alert",
            "meridiem-narrative",
            {},
            {
                "headline": "View it in your browser 08/10/2026 12:29 PM EDT",
                "bodyText": "The morning edition was delivered at 08:00 AM EDT.",
            },
        )
        narrative_keys = {
            reference["entityKey"]
            for reference in intelligence.extract_entity_references(narrative_only)
        }
        self.assertNotIn("ticker#PM", narrative_keys)
        self.assertNotIn("ticker#AM", narrative_keys)

        structured = snapshot(
            "signal-strength",
            "meridiem-structured",
            {"added": ["PM"], "removed": ["AM"]},
            {
                "headline": "View it in your browser 08/10/2026 12:29 PM EDT",
                "bodyText": "The prior edition was delivered at 08:00 AM EDT.",
            },
        )
        references = intelligence.extract_entity_references(structured)
        meridiem_references = [
            reference
            for reference in references
            if reference["entityId"] in {"AM", "PM"}
        ]
        self.assertEqual(len(meridiem_references), 2)
        self.assertEqual(
            {
                (reference["entityId"], reference["eventType"])
                for reference in meridiem_references
            },
            {
                ("PM", "signal_strength_added"),
                ("AM", "signal_strength_removed"),
            },
        )
        self.assertTrue(
            all(
                reference["matchType"] == "structured_membership"
                and reference["fieldPath"].startswith("data.")
                for reference in meridiem_references
            )
        )

    def test_signal_strength_shorts_product_never_carries_long_list_kinds(self):
        short_row = {"ticker": "LULU", "side": "short", "name": "lululemon athletica inc.",
                     "sector": "Retail", "analyst": "Brian McGough", "totalReturn": Decimal("44.02")}
        long_row = {"ticker": "OKTA", "side": "long", "name": "Okta Inc.", "sector": "Software",
                    "analyst": "Andrew Freedman", "totalReturn": Decimal("115.12")}
        longs = snapshot(
            "signal-strength",
            "signal-strength-long",
            {"added": ["MCK"], "removed": ["AMZN"], "stocks": [long_row]},
        )
        shorts = snapshot(
            "signal-strength-shorts",
            "signal-strength-shorts",
            {"added": ["SMCI"], "removed": ["DECK"], "stocks": [short_row]},
            {"bodyText": "Signal Strength Shorts: 68 Stocks ADDING: SMCI REMOVING: DECK LULU NVDA"},
        )

        long_references = intelligence.extract_entity_references(longs)
        short_references = intelligence.extract_entity_references(shorts)

        self.assertEqual(
            {(reference["entityId"], reference["eventType"], reference["direction"]) for reference in long_references},
            {
                ("MCK", "signal_strength_added", "positive"),
                ("AMZN", "signal_strength_removed", "negative"),
                ("OKTA", "signal_strength_membership", None),
            },
        )
        self.assertEqual(
            {(reference["entityId"], reference["eventType"], reference["direction"]) for reference in short_references},
            {
                ("SMCI", "signal_strength_short_added", "negative"),
                ("DECK", "signal_strength_short_removed", None),
                ("LULU", "signal_strength_short_membership", "negative"),
            },
        )
        # The body repeats the table; only typed rows count as membership.
        self.assertNotIn("ticker#NVDA", {reference["entityKey"] for reference in short_references})
        self.assertTrue(all(
            reference["matchType"] == "structured_membership"
            for reference in [*long_references, *short_references]
        ))

    def test_signal_strength_shorts_is_its_own_catalog_product(self):
        self.assertEqual(intelligence.product_definition("signal-strength-shorts")["label"], "Signal Strength Shorts")
        rules = [product_id for product_id, _ in intelligence.report_rules()]
        # The Shorts subject also contains "signal strength"; it must match first.
        self.assertLess(rules.index("signal-strength-shorts"), rules.index("signal-strength"))

    def test_same_day_publications_are_immutable_and_manifested_separately(self):
        database = FakeDynamoDb()
        first = snapshot(
            "signal-strength",
            "signal-1",
            {"added": ["DDOG"], "removed": []},
        )
        second = snapshot(
            "signal-strength",
            "signal-2",
            {"added": [], "removed": ["DDOG"]},
        )

        first_count = intelligence.persist_snapshot_intelligence(
            first,
            database,
            content_sha256="a" * 64,
        )
        second_count = intelligence.persist_snapshot_intelligence(
            second,
            database,
            content_sha256="b" * 64,
        )

        self.assertGreater(first_count, 0)
        self.assertGreater(second_count, 0)
        manifest = database.manifests.items[("2026-07-23", "signal-strength")]
        self.assertEqual(manifest["state"], "indexed")
        self.assertEqual(manifest["receivedCount"], 2)
        self.assertEqual(manifest["indexedCount"], 2)
        self.assertEqual(
            {artifact["artifactId"] for artifact in manifest["artifacts"]},
            {"a" * 64, "b" * 64},
        )
        self.assertEqual(
            [
                transition["stage"]
                for transition in manifest["artifacts"][0]["stageHistory"]
            ],
            ["received", "parsed", "validated", "indexed"],
        )
        self.assertEqual(
            manifest["manifestChecksum"],
            intelligence._manifest_checksum(manifest["artifacts"]),
        )
        self.assertEqual(
            {artifact["contentSha256"] for artifact in manifest["artifacts"]},
            {"a" * 64, "b" * 64},
        )
        event_keys = {
            item["eventKey"] for item in database.events.items.values()
        }
        self.assertEqual(len(event_keys), len(database.events.items))

    def test_reclassification_preserves_failure_audit_after_target_is_indexed(self):
        database = FakeDynamoDb()
        content_sha256 = "f" * 64
        source = snapshot(
            "signal-strength",
            "bjri-alert",
            {"added": [], "removed": []},
        )
        target = snapshot(
            "real-time-alert",
            "bjri-alert",
            {
                "alert": {
                    "ticker": "BJRI",
                    "action": "BUY",
                    "side": "long",
                },
                "alerts": [
                    {"ticker": "BJRI", "action": "BUY", "side": "long"}
                ],
            },
        )
        intelligence.persist_snapshot_failure(
            source,
            database,
            content_sha256=content_sha256,
            error="original signal-strength parse failure",
        )
        intelligence.persist_snapshot_intelligence(
            target,
            database,
            content_sha256=content_sha256,
        )

        moved = intelligence.reclassify_manifest_artifact(
            target,
            database,
            source_product_id="signal-strength",
            content_sha256=content_sha256,
        )

        self.assertEqual(moved["artifacts"], [])
        self.assertEqual(moved["failedCount"], 0)
        self.assertEqual(moved["manifestChecksum"], intelligence._manifest_checksum([]))
        self.assertEqual(len(moved["reclassifiedArtifacts"]), 1)
        audit = moved["reclassifiedArtifacts"][0]
        self.assertEqual(audit["targetProductKey"], "real-time-alert")
        self.assertEqual(audit["sourceArtifact"]["stage"], "failed")
        self.assertEqual(
            audit["sourceArtifact"]["error"],
            "original signal-strength parse failure",
        )
        self.assertEqual(
            database.manifests.items[("2026-07-23", "real-time-alert")]
            ["artifacts"][0]["stage"],
            "indexed",
        )

        version = moved["version"]
        replayed = intelligence.reclassify_manifest_artifact(
            target,
            database,
            source_product_id="signal-strength",
            content_sha256=content_sha256,
        )
        self.assertEqual(replayed["version"], version)
        self.assertEqual(len(replayed["reclassifiedArtifacts"]), 1)

    def test_recovered_unsupported_artifact_leaves_the_unknown_manifest(self):
        database = FakeDynamoDb()
        content_sha256 = "e" * 64
        target = snapshot(
            "real-time-alert",
            "recovered-alert",
            {"alert": {"ticker": "BJRI", "action": "BUY", "side": "long"},
             "alerts": [{"ticker": "BJRI", "action": "BUY", "side": "long"}]},
        )
        intelligence.persist_snapshot_failure(
            snapshot("unknown", "recovered-alert", {}),
            database,
            content_sha256=content_sha256,
            error="Received Hedgeye product is not registered or parseable",
        )
        intelligence.persist_snapshot_intelligence(
            target, database, content_sha256=content_sha256,
        )

        moved = intelligence.reclassify_manifest_artifact(
            target, database, source_product_id="unknown", content_sha256=content_sha256,
        )

        self.assertEqual(moved["artifacts"], [])
        self.assertEqual(moved["failedCount"], 0)
        self.assertEqual(moved["reclassifiedArtifacts"][0]["targetProductKey"], "real-time-alert")
        self.assertEqual(
            database.manifests.items[("2026-07-23", "unknown")]["state"], "indexed",
        )

    def test_unsupported_source_without_a_manifest_entry_has_nothing_to_move(self):
        database = FakeDynamoDb()
        content_sha256 = "d" * 64
        target = snapshot(
            "real-time-alert",
            "pre-manifest-alert",
            {"alert": {"ticker": "BJRI", "action": "BUY", "side": "long"},
             "alerts": [{"ticker": "BJRI", "action": "BUY", "side": "long"}]},
        )
        intelligence.persist_snapshot_intelligence(
            target, database, content_sha256=content_sha256,
        )

        self.assertEqual(
            intelligence.reclassify_manifest_artifact(
                target, database, source_product_id="unknown", content_sha256=content_sha256,
            ),
            {},
        )
        self.assertNotIn(("2026-07-23", "unknown"), database.manifests.items)
        with self.assertRaisesRegex(RuntimeError, "Source manifest is missing"):
            intelligence.reclassify_manifest_artifact(
                target, database, source_product_id="signal-strength",
                content_sha256=content_sha256,
            )

    def test_reclassification_rejects_an_unindexed_target(self):
        database = FakeDynamoDb()
        content_sha256 = "9" * 64
        source = snapshot(
            "signal-strength",
            "bjri-unindexed",
            {"added": [], "removed": []},
        )
        target = snapshot(
            "real-time-alert",
            "bjri-unindexed",
            {"alert": {"ticker": "BJRI", "action": "BUY"}},
        )
        intelligence.persist_snapshot_failure(
            source,
            database,
            content_sha256=content_sha256,
            error="original failure",
        )
        intelligence.persist_snapshot_intelligence(
            target,
            database,
            content_sha256=content_sha256,
            finalize=False,
        )

        with self.assertRaisesRegex(RuntimeError, "Target manifest"):
            intelligence.reclassify_manifest_artifact(
                target,
                database,
                source_product_id="signal-strength",
                content_sha256=content_sha256,
            )

    def test_zero_references_is_indexed_not_a_parse_failure(self):
        database = FakeDynamoDb()
        item = snapshot(
            "market-structure",
            "structure-1",
            {"summary": "Rates were unchanged."},
        )

        count = intelligence.persist_snapshot_intelligence(
            item,
            database,
            content_sha256="c" * 64,
        )

        self.assertEqual(count, 0)
        manifest = database.manifests.items[("2026-07-23", "market-structure")]
        self.assertEqual(manifest["state"], "indexed")
        self.assertEqual(manifest["entityEventCount"], 0)

    def test_validated_replay_replaces_stale_event_count_after_parser_hardening(self):
        database = FakeDynamoDb()
        item = snapshot(
            "investing-ideas",
            "investing-ideas-corrected",
            {
                "positions": [{
                    "ticker": "DDOG",
                    "side": "Long",
                    "prevClose": 100.0,
                    "lrr": 90.0,
                    "hrr": 110.0,
                }],
            },
        )
        artifact_id = "c" * 64
        database.manifests.items[("2026-07-23", "investing-ideas")] = {
            "marketDate": "2026-07-23",
            "productKey": "investing-ideas",
            "version": 1,
            "artifacts": [{
                "artifactId": artifact_id,
                "stage": "indexed",
                "eventCount": 259,
            }],
        }

        manifest = intelligence.update_product_manifest(
            item,
            database,
            stage="indexed",
            content_sha256=artifact_id,
            event_count=1,
        )

        self.assertEqual(manifest["entityEventCount"], 1)
        self.assertEqual(manifest["artifacts"][0]["eventCount"], 1)

    def test_indexed_stage_can_be_deferred_until_primary_projection_succeeds(self):
        database = FakeDynamoDb()
        item = snapshot(
            "risk-ranges",
            "risk-primary",
            {"SPY": {"lrr": 6200, "hrr": 6300, "trend": "BULLISH"}},
        )

        count = intelligence.persist_snapshot_intelligence(
            item,
            database,
            content_sha256="e" * 64,
            finalize=False,
        )

        manifest = database.manifests.items[("2026-07-23", "risk-ranges")]
        self.assertEqual(manifest["state"], "validated")
        self.assertEqual(manifest["indexedCount"], 0)

        intelligence.finalize_snapshot_intelligence(
            item,
            database,
            content_sha256="e" * 64,
            event_count=count,
        )

        manifest = database.manifests.items[("2026-07-23", "risk-ranges")]
        self.assertEqual(manifest["state"], "indexed")
        self.assertEqual(manifest["indexedCount"], 1)

    def test_chart_only_tracker_stops_at_parsed_without_trade_authority(self):
        database = FakeDynamoDb()
        item = snapshot(
            "momo-tracker",
            "momo-chart-only",
            {"momo-chart.png": {"chartUrl": "https://example.test/chart.png"}},
        )

        count = intelligence.persist_snapshot_intelligence(
            item,
            database,
            content_sha256="d" * 64,
        )

        self.assertEqual(count, 0)
        manifest = database.manifests.items[("2026-07-23", "momo-tracker")]
        self.assertEqual(manifest["state"], "parsed")
        self.assertEqual(manifest["receivedCount"], 1)
        self.assertEqual(manifest["parsedCount"], 1)
        self.assertEqual(manifest["indexedCount"], 0)

    def test_momo_outbucket_row_indexes_its_explicit_trend_without_a_range(self):
        item = snapshot(
            "momo-tracker",
            "momo-outbucket",
            {
                "ORCL": {
                    "buyTrade": None,
                    "sellTrade": None,
                    "upside": None,
                    "downside": None,
                    "trend": "BULLISH",
                    "trade": "BULLISH",
                    "lrr": None,
                    "hrr": None,
                    "rangeStatus": "outbucket",
                    "rangeStatusDate": "08/13",
                }
            },
        )

        events = intelligence.build_entity_events(
            item,
            content_sha256="d" * 64,
        )
        oracle_events = [
            event for event in events if event["entityKey"] == "ticker#ORCL"
        ]

        self.assertEqual(len(events), 1)
        self.assertTrue(oracle_events)
        self.assertTrue(all(event["signalValue"] == "BULLISH" for event in oracle_events))
        self.assertTrue(all(event["direction"] == "positive" for event in oracle_events))
        self.assertTrue(all(not event["decisionEligible"] for event in oracle_events))
        self.assertTrue(all(event["eventType"] == "trend_signal" for event in oracle_events))
        self.assertIn('"buyTrade": null', oracle_events[0]["excerpt"])

    def test_nested_bitcoin_tracker_rows_are_signals_not_container_tickers(self):
        item = snapshot(
            "bitcoin-trend-tracker",
            "bitcoin-1",
            {
                "cryptos": {
                    "BTC": {
                        "buyTrade": 100_000,
                        "sellTrade": 110_000,
                        "trend": "BULLISH",
                    }
                },
                "stocks": {
                    "IBIT": {
                        "buyTrade": 60,
                        "sellTrade": 70,
                        "trend": "BEARISH",
                    }
                },
            },
            {
                "bodyText": (
                    "CRYPTO QUANT IMAGE BEARISH VIEW LARGER BTC charts and OCR labels"
                )
            },
        )

        events = intelligence.build_entity_events(
            item,
            content_sha256="e" * 64,
        )
        by_key = {event["entityKey"]: event for event in events}

        self.assertEqual(set(by_key), {"ticker#BTC", "ticker#IBIT"})
        self.assertEqual(len(events), 2)
        self.assertEqual(by_key["ticker#BTC"]["signalValue"], "BULLISH")
        self.assertEqual(by_key["ticker#IBIT"]["signalValue"], "BEARISH")
        self.assertNotIn("ticker#CRYPTOS", by_key)
        self.assertNotIn("ticker#STOCKS", by_key)

    def test_investing_ideas_emits_one_typed_position_event_per_security(self):
        item = snapshot(
            "investing-ideas",
            "investing-ideas-1",
            {
                "longs": ["DDOG"],
                "shorts": ["HCA"],
                "positions": [
                    {
                        "ticker": "DDOG",
                        "side": "Long",
                        "prevClose": 267.97,
                        "lrr": 244.0,
                        "hrr": 275.0,
                    },
                    {
                        "ticker": "HCA",
                        "side": "Short",
                        "prevClose": 402.59,
                        "lrr": 363.0,
                        "hrr": 418.0,
                    },
                    {
                        "ticker": "PM",
                        "side": "Long",
                        "prevClose": 189.57,
                        "lrr": 182.0,
                        "hrr": 201.0,
                    },
                ],
            },
            {
                "headline": "DDOG, HCA, and PM remain in the current ideas table",
                "bodyText": "Long DDOG and PM; Short HCA. PM is also shown beside the publication time.",
            },
        )

        references = intelligence.extract_entity_references(item)
        position_references = [
            reference
            for reference in references
            if reference["eventType"] == "investing_idea_position"
        ]
        self.assertEqual(len(position_references), 3)
        self.assertEqual(
            {reference["entityId"] for reference in position_references},
            {"DDOG", "HCA", "PM"},
        )
        self.assertEqual(
            position_references[0]["value"],
            {
                "side": "Long",
                "bias": "BULLISH",
                "prevClose": 267.97,
                "lrr": 244.0,
                "hrr": 275.0,
            },
        )

        events = intelligence.build_entity_events(item, content_sha256="i" * 64)
        typed_events = [
            event for event in events if event["eventType"] == "investing_idea_position"
        ]
        self.assertEqual(len(typed_events), 3)
        self.assertEqual(typed_events[0]["signalValue"]["bias"], "BULLISH")
        self.assertEqual(typed_events[0]["riskRange"], {"lrr": 244.0, "hrr": 275.0})
        self.assertTrue(all(event["decisionEligible"] is False for event in typed_events))

        database = FakeDynamoDb()
        intelligence.persist_snapshot_intelligence(
            item,
            database,
            content_sha256="i" * 64,
        )
        stored = database.events.items[sorted(database.events.items)[0]]
        self.assertIsInstance(stored["signalValue"]["prevClose"], Decimal)
        self.assertIsInstance(stored["riskRange"]["lrr"], Decimal)
        self.assertIsInstance(stored["riskRange"]["hrr"], Decimal)

    def test_parser_replacement_resets_manifest_event_count_before_reindex(self):
        database = FakeDynamoDb()
        item = snapshot(
            "bitcoin-trend-tracker",
            "crypto-replacement",
            {"cryptos": {"BTC": {"trend": "BEARISH"}}},
        )
        content_sha256 = "c" * 64
        database.manifests.items[("2026-07-23", "bitcoin-trend-tracker")] = {
            "marketDate": "2026-07-23",
            "productKey": "bitcoin-trend-tracker",
            "version": 1,
            "state": "indexed",
            "artifacts": [
                {
                    "artifactId": content_sha256,
                    "contentSha256": content_sha256,
                    "sourceMessageId": "crypto-replacement",
                    "stage": "indexed",
                    "eventCount": 160,
                    "parserVersion": "security-intelligence-v3-tracker-contract",
                    "stageHistory": [{"stage": "indexed", "at": "before"}],
                }
            ],
        }

        manifest = intelligence.update_product_manifest(
            item,
            database,
            stage="received",
            content_sha256=content_sha256,
            replace_existing=True,
        )

        artifact = manifest["artifacts"][0]
        self.assertEqual(artifact["stage"], "received")
        self.assertEqual(artifact["eventCount"], 0)
        self.assertEqual(artifact["parserVersion"], intelligence.PARSER_VERSION)
        self.assertEqual(
            [transition["stage"] for transition in artifact["stageHistory"]],
            ["indexed", "received"],
        )

    def test_content_hash_deduplicates_replayed_publication_across_messages(self):
        first = snapshot(
            "signal-strength",
            "signal-original",
            {"added": ["DDOG"], "removed": []},
        )
        duplicate = snapshot(
            "signal-strength",
            "signal-forwarded",
            {"added": ["DDOG"], "removed": []},
        )

        first_events = intelligence.build_entity_events(
            first,
            content_sha256="f" * 64,
        )
        duplicate_events = intelligence.build_entity_events(
            duplicate,
            content_sha256="f" * 64,
        )

        self.assertEqual(
            {event["eventKey"] for event in first_events},
            {event["eventKey"] for event in duplicate_events},
        )
        self.assertEqual(
            {event["sourceEventId"] for event in first_events},
            {"f" * 64},
        )

    def test_unverified_primary_risk_events_are_explicitly_non_decision_grade(self):
        item = snapshot(
            "risk-ranges",
            "risk-candidate",
            {"SPX": {"lrr": 6200, "hrr": 6300, "trend": "BULLISH"}},
        )

        events = intelligence.build_entity_events(
            item,
            content_sha256="1" * 64,
        )

        self.assertTrue(events)
        self.assertTrue(all(event["decisionEligible"] is False for event in events))
        self.assertTrue(
            all(
                event["verificationStatus"]
                == "requires-primary-publication-manifest"
                for event in events
            )
        )


if __name__ == "__main__":
    unittest.main()
