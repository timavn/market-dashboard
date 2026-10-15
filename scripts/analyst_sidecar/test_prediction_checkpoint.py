"""Checkpoint quote verification never changes the raw monitor evidence."""

import copy
from datetime import datetime, timedelta, timezone
import os
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock

from test_prediction_review import monitor


_APP_DATA_DIR = tempfile.TemporaryDirectory(prefix="analyst-prediction-checkpoint-test-")
os.environ.setdefault("ANALYST_DATA_DIR", _APP_DATA_DIR.name)
os.environ.setdefault("ANALYST_TEXTRACT_FALLBACK", "false")

import app as analyst_app  # noqa: E402 -- isolate persistence before app initializes.


class PredictionCheckpointTests(unittest.IsolatedAsyncioTestCase):
    def source(self):
        now = datetime.now(timezone.utc)
        rows = [monitor(market_id, venue, now) for market_id, _asset, venue in analyst_app.PREDICTIVE_REVIEW_UNIVERSE]
        for row in rows:
            row["snapshot"]["displayContracts"].update(refreshPending=False, refreshRetained=False)
        return {
            "status": "available", "liveVerified": False, "freshness": "current_monitor",
            "asOf": now.isoformat(), "provider": "fixed_prediction_monitor_universe",
            "data": {"markets": rows, "policy": {"autoVenueAllowed": False, "alternateVenueFallbackAllowed": False}},
        }

    async def checkpoint(self, source):
        original = copy.deepcopy(source)
        context = SimpleNamespace(checkpoint=AsyncMock())
        await analyst_app._checkpoint_review_source(context, "predictionUniverse", source, None)
        self.assertEqual(source, original)
        call = context.checkpoint.await_args
        self.assertEqual(call.args, ("predictionUniverse",))
        self.assertIs(call.kwargs["evidence"], source)
        self.assertFalse(call.kwargs["evidence"]["liveVerified"])
        return call.kwargs

    async def test_all_verified_native_books_are_ready_without_changing_raw_envelope(self):
        result = await self.checkpoint(self.source())
        self.assertEqual(result["status"], "ready")
        self.assertIsNone(result["error_code"])
        self.assertEqual(result["detail"], {
            "providerStatus": "available", "liveVerified": True,
            "verificationScope": "native_quotes_only", "executionVerified": False,
            "quotedMarketCount": len(analyst_app.PREDICTIVE_REVIEW_UNIVERSE),
            "requestedMarketCount": len(analyst_app.PREDICTIVE_REVIEW_UNIVERSE),
        })

    async def test_partial_roster_is_partial_and_empty_roster_fails(self):
        source = self.source()
        source["data"]["markets"].pop()
        result = await self.checkpoint(source)
        self.assertEqual(result["status"], "partial")
        self.assertEqual(result["detail"]["quotedMarketCount"], len(analyst_app.PREDICTIVE_REVIEW_UNIVERSE) - 1)
        source["data"]["markets"] = []
        result = await self.checkpoint(source)
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["error_code"], "REVIEW_SOURCE_UNAVAILABLE")
        self.assertFalse(result["detail"]["liveVerified"])

    async def test_catalog_missing_expired_stale_cache_mock_and_seed_books_never_verify(self):
        for mutation in (
            {"lines": []}, {"bookExpiresAt": (datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat()},
            {"stale": True}, {"cacheOnly": True}, {"cachedOnly": True}, {"mock": True},
            {"seeded": True}, {"refreshFailed": True}, {"connected": False},
        ):
            with self.subTest(mutation=mutation):
                source = self.source()
                for row in source["data"]["markets"]:
                    row["snapshot"]["displayContracts"].update(mutation)
                result = await self.checkpoint(source)
                self.assertEqual(result["status"], "failed")
                self.assertEqual(result["detail"]["quotedMarketCount"], 0)
                self.assertFalse(result["detail"]["liveVerified"])

    async def test_wrong_venue_ambiguous_roster_and_unpinned_policy_cannot_pass(self):
        for case in ("wrong_venue", "duplicate", "auto", "fallback", "unsafe_envelope", "unsafe_snapshot"):
            with self.subTest(case=case):
                source = self.source()
                if case == "auto":
                    source["data"]["policy"]["autoVenueAllowed"] = True
                elif case == "fallback":
                    source["data"]["policy"]["alternateVenueFallbackAllowed"] = True
                elif case == "unsafe_envelope":
                    source["mock"] = True
                elif case == "duplicate":
                    source["data"]["markets"] *= 2
                else:
                    for row in source["data"]["markets"]:
                        if case == "wrong_venue":
                            row["requestedVenue"] = "auto"
                        else:
                            row["snapshot"]["cachedOnly"] = True
                result = await self.checkpoint(source)
                self.assertEqual(result["status"], "failed")
                self.assertFalse(result["detail"]["liveVerified"])


if __name__ == "__main__":
    unittest.main()
