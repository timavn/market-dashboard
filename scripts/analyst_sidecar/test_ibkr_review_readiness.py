"""Broker availability never waits behind research or current-account acquisition."""

import os as _isolation_os
import tempfile as _isolation_tempfile

# Importing app opens its stores and fails in-flight reviews; never touch the live data directory.
_APP_DATA_DIR = _isolation_tempfile.TemporaryDirectory(prefix="analyst-ibkr-review-readiness-test-")
_isolation_os.environ.setdefault("ANALYST_DATA_DIR", _APP_DATA_DIR.name)
_isolation_os.environ.setdefault("ANALYST_TEXTRACT_FALLBACK", "false")

import asyncio
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import AsyncMock, Mock, patch

import app as analyst_app
from analyst_review_sources import review_sources
from market import IbkrReader, aclose_shared_clients
from review_runs_v2 import ReviewCoordinatorV2, ReviewExecutionContext, ReviewRunV2Store
from test_gateway_probe_stall import ReadinessServer, stall_loop
from test_portfolio_review_coordinator import coordinator_sources, verified_balance_context, verified_prediction_universe


class IbkrReadinessTests(unittest.IsolatedAsyncioTestCase):
    @staticmethod
    def connected(**changes):
        return {"ok": True, "connected": True, "status": "connected",
                "socket_verified_at": datetime.now(timezone.utc).isoformat(), **changes}

    async def test_known_disconnection_uses_only_connection_readiness(self):
        request = AsyncMock(return_value={"ok": False, "connected": False,
            "status": "gateway_not_authenticated", "error_code": "IBKR_GATEWAY_NOT_AUTHENTICATED"})
        result = await IbkrReader(request=request).readiness()
        self.assertFalse(result["liveVerified"])
        self.assertEqual(result["errorCode"], "IBKR_GATEWAY_NOT_AUTHENTICATED")
        request.assert_awaited_once_with("/gateway-readiness", method="GET", json_body=None)

    async def test_reconnecting_socket_is_reported_without_a_disconnect(self):
        request = AsyncMock(return_value={"ok": False, "connected": False, "status": "reconnecting",
                                         "error_code": "IBKR_GATEWAY_RECONNECTING"})
        result = await IbkrReader(request=request).readiness()
        self.assertFalse(result["liveVerified"])
        self.assertEqual(result["errorCode"], "IBKR_GATEWAY_RECONNECTING")

    async def test_open_socket_still_requires_verified_gateway_status(self):
        request = AsyncMock(return_value={"ok": False, "connected": True, "status": "unverified",
                                         "error_code": "IBKR_GATEWAY_READINESS_TIMEOUT"})
        result = await IbkrReader(request=request).readiness()
        self.assertFalse(result["liveVerified"])
        self.assertEqual(result["errorCode"], "IBKR_GATEWAY_READINESS_TIMEOUT")
        self.assertEqual([call.args[0] for call in request.await_args_list], ["/gateway-readiness"])

    async def test_connected_readiness_does_not_acquire_or_supply_account_values(self):
        payload = self.connected(accounts=["PRIVATE"], positions=[{"symbol": "PRIVATE"}], balances={"PRIVATE": 1})
        request = AsyncMock(return_value=payload)
        result = await IbkrReader(request=request).readiness()
        self.assertTrue(result["liveVerified"])
        self.assertEqual(result["data"], {"connected": True})
        self.assertEqual(result["asOf"], payload["socket_verified_at"])
        self.assertEqual([call.args[0] for call in request.await_args_list], ["/gateway-readiness"])

    async def test_stale_missing_or_invalid_heartbeat_time_cannot_prove_readiness(self):
        for observed in (None, "bad", "2026-10-09", datetime.now(timezone.utc).replace(tzinfo=None).isoformat(),
                         (datetime.now(timezone.utc) - timedelta(seconds=20)).isoformat(),
                         (datetime.now(timezone.utc) + timedelta(seconds=20)).isoformat()):
            with self.subTest(observed=observed):
                request = AsyncMock(return_value=self.connected(socket_verified_at=observed))
                result = await IbkrReader(request=request).readiness()
                self.assertFalse(result["liveVerified"])
                self.assertEqual(result["errorCode"], "IBKR_GATEWAY_NOT_VERIFIED")

    async def test_hung_readiness_is_cancelled_within_one_shared_budget(self):
        cancelled = asyncio.Event()

        async def request(path, **_kwargs):
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.set()

        with patch("market.IBKR_READINESS_TIMEOUT_SECONDS", 0.03):
            started = time.monotonic()
            result = await IbkrReader(request=request).readiness()
        self.assertLess(time.monotonic() - started, 0.2)
        self.assertTrue(cancelled.is_set())
        self.assertEqual(result["errorCode"], "IBKR_GATEWAY_READINESS_TIMEOUT")

    async def test_cached_seeded_or_mock_status_never_proves_readiness(self):
        for flag in ("from_cache", "fromCache", "cacheOnly", "cached", "cache", "cachedOnly", "fallback", "inferred",
                     "stale", "seed", "seeded", "mock"):
            with self.subTest(flag=flag):
                request = AsyncMock(return_value=self.connected(**{flag: True}))
                self.assertFalse((await IbkrReader(request=request).readiness())["liveVerified"])


class PortfolioPreflightTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.store = ReviewRunV2Store(Path(self.temp.name) / "reviews.sqlite3")

    async def test_successful_connection_check_captures_only_connection_evidence(self):
        run, _ = self.store.create(review_kind="portfolio-review", request_id="connected-capture")
        context = ReviewExecutionContext(self.store, run["runId"], "portfolio-review")
        check_time = "2026-10-08T18:00:00Z"
        readiness = AsyncMock(return_value={"status": "available", "liveVerified": True, "freshness": "live",
            "asOf": "2026-10-08T17:59:59Z", "data": {"connected": True, "accounts": ["PRIVATE"]},
            "warnings": ["Private account 123456"]})
        with patch.object(analyst_app, "utc_now_iso", return_value=check_time):
            captured = await analyst_app._capture_ib_gateway_readiness(context, readiness)
        expected = {"status": "available", "liveVerified": True, "freshness": "live",
                    "asOf": check_time, "data": {"connected": True},
                    "connectionVerifiedAt": "2026-10-08T17:59:59Z"}
        self.assertEqual(captured, expected)
        saved = self.store.get(run["runId"])
        self.assertEqual(self.store.read_evidence(saved, "ibGateway"), expected)
        self.assertEqual(saved["dependencies"]["ibGateway"]["asOf"], check_time)
        self.assertEqual(saved["dependencies"]["ibGateway"]["status"], "ready")
        readiness.assert_awaited_once()

    async def test_connection_answered_during_a_loop_stall_is_captured_as_connected(self):
        server = ReadinessServer([0.03])
        self.addCleanup(server.close)
        self.addAsyncCleanup(aclose_shared_clients)
        run, _ = self.store.create(review_kind="portfolio-review", request_id="stalled-loop-capture")
        context = ReviewExecutionContext(self.store, run["runId"], "portfolio-review")
        stall = asyncio.create_task(stall_loop(3))
        captured = await analyst_app._capture_ib_gateway_readiness(context, IbkrReader(base_url=server.url).readiness)
        await stall
        self.assertTrue(captured["liveVerified"])
        # Evidence and checkpoint detail keep their existing shapes.
        self.assertEqual(set(captured), {"status", "asOf", "liveVerified", "freshness", "data", "connectionVerifiedAt"})
        saved = self.store.get(run["runId"])
        descriptor = saved["dependencies"]["ibGateway"]
        self.assertEqual(descriptor["status"], "ready")
        self.assertEqual(set(descriptor["detail"]), {"liveVerified", "elapsedMs", "attemptCount"})
        self.assertEqual(descriptor["detail"]["attemptCount"], 1)
        self.assertEqual(server.requests, 1)

    async def test_unverified_connection_cannot_be_captured_as_connected(self):
        connected = {"status": "available", "liveVerified": True, "freshness": "live", "data": {"connected": True}}
        for index, changes in enumerate(({"mock": True}, {"seeded": True}, {"cacheOnly": True}, {"stale": True},
            {"liveVerified": False}, {"data": {"connected": False}}, {"data": {"connected": True, "fromCache": True}})):
            with self.subTest(changes=changes):
                store = ReviewRunV2Store(Path(self.temp.name) / f"rejected-{index}.sqlite3")
                run, _ = store.create(review_kind="portfolio-review", request_id=f"rejected-capture-{index}")
                context = ReviewExecutionContext(store, run["runId"], "portfolio-review")
                result = await analyst_app._capture_ib_gateway_readiness(context, AsyncMock(return_value={**connected, **changes}))
                self.assertFalse(result["liveVerified"])
                self.assertEqual(result["errorCode"], "IBKR_GATEWAY_NOT_VERIFIED")
                saved = store.get(run["runId"])
                self.assertEqual(saved["dependencies"]["ibGateway"]["status"], "failed")

    async def test_production_balance_captures_connection_independently(self):
        unavailable = {"status": "unavailable", "liveVerified": False, "errorCode": "GATEWAY_UNAVAILABLE"}
        for kind, handler in (("balance-review", analyst_app._balance_review_v2_handler),):
            with (
                self.subTest(kind=kind),
                patch.object(analyst_app.ibkr, "readiness", new=AsyncMock(return_value=unavailable)) as readiness,
                patch.object(analyst_app.ibkr, "holdings_context", new=AsyncMock(return_value=unavailable)) as holdings,
                patch.object(analyst_app.balance_context, "context", new=AsyncMock(return_value=verified_balance_context())) as balance,
                patch.object(analyst_app.prediction_markets, "fixed_review_universe", new=AsyncMock(return_value=verified_prediction_universe())) as prediction,
                patch.object(analyst_app, "_review_market_date", new=AsyncMock(return_value="2026-10-08")),
                patch.object(analyst_app, "capture_prediction_research", new=AsyncMock(return_value={})),
            ):
                coordinator = ReviewCoordinatorV2(self.store, {kind: handler})
                run = await coordinator.start(review_kind=kind, request_id=f"independent-{kind}")
                await coordinator.tasks[run["runId"]]
                saved = self.store.get(run["runId"])
                source = next(item for item in review_sources(saved, self.store)["items"] if item["id"] == "ibGateway")
                self.assertEqual(source["status"], "unavailable")
                self.assertEqual(source["diagnostic"]["code"], "GATEWAY_UNAVAILABLE")
                self.assertEqual(saved["dependencies"]["ibGateway"]["status"], "failed")
                readiness.assert_awaited_once()
                holdings.assert_awaited_once()
                balance.assert_awaited_once()
                prediction.assert_not_awaited()

    async def test_disconnected_review_terminates_before_optional_or_account_requests(self):
        for pca_enabled in ("false", "true"):
            with self.subTest(pca_enabled=pca_enabled), patch.dict(
                    "os.environ", {"ANALYST_PORTFOLIO_PCA_ENABLED": pca_enabled}):
                await self._assert_disconnected_review_terminates(pca_enabled == "true")

    async def _assert_disconnected_review_terminates(self, pca_enabled):
        readiness = AsyncMock(return_value={"liveVerified": False, "errorCode": "GATEWAY_UNAVAILABLE"})
        portfolio = AsyncMock()
        balance = AsyncMock()
        orders = AsyncMock()
        pca = AsyncMock()
        historical = Mock()
        market_date = Mock()
        research = Mock()
        sources = replace(coordinator_sources(), broker_readiness=readiness,
            portfolio_context=portfolio, balance_context=balance, open_orders=orders,
            pca_research=pca, portfolio_reference=historical, market_date=market_date,
            research_coverage=research)

        async def handler(context):
            return await analyst_app._portfolio_review_v2_handler(context, sources=sources)

        coordinator = ReviewCoordinatorV2(self.store, {"portfolio-review": handler})
        request_id = f"offline-preflight-pca-{pca_enabled}"
        started = time.monotonic()
        run = await coordinator.start(review_kind="portfolio-review", request_id=request_id)
        await asyncio.wait_for(coordinator.tasks[run["runId"]], 0.5)
        self.assertLess(time.monotonic() - started, 0.5)
        saved = self.store.get(run["runId"])
        self.assertEqual((saved["state"], saved["phase"]), ("failed", "terminal"))
        self.assertEqual(saved["errorCode"], "GATEWAY_UNAVAILABLE")
        self.assertFalse(saved.get("reportMarkdown"))
        dependents = ("portfolio", "portfolioBalance", "portfolioOpenOrders", *(("portfolioPca",) if pca_enabled else ()))
        for name in ("ibGateway", *dependents):
            self.assertEqual(saved["dependencies"][name]["status"], "failed")
            # A verified disconnect settles dependents with the Gateway's own code.
            self.assertEqual(saved["dependencies"][name]["errorCode"], "GATEWAY_UNAVAILABLE")
        if not pca_enabled:
            # A paused PCA read was never a dependent and keeps its Pending state.
            self.assertEqual((saved["dependencies"]["portfolioPca"]["status"],
                              saved["dependencies"]["portfolioPca"]["errorCode"]), ("pending", "SOURCE_PAUSED"))
        projected = review_sources(saved, self.store)
        self.assertTrue(all(row["status"] != "checking" for row in projected["items"]))
        for reader in (portfolio, balance, orders, pca):
            reader.assert_not_awaited()
        for reader in (historical, market_date, research):
            reader.assert_not_called()
        readiness.assert_awaited_once()
        replay = await coordinator.start(review_kind="portfolio-review", request_id=request_id)
        self.assertEqual((replay["runId"], replay["state"]), (run["runId"], "failed"))
        readiness.assert_awaited_once()

    async def test_nonresponding_preflight_has_a_one_second_terminal_deadline(self):
        cancelled = asyncio.Event()

        async def readiness():
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.set()

        portfolio = AsyncMock()
        sources = replace(coordinator_sources(), broker_readiness=readiness, portfolio_context=portfolio)

        async def handler(context):
            return await analyst_app._portfolio_review_v2_handler(context, sources=sources)

        coordinator = ReviewCoordinatorV2(self.store, {"portfolio-review": handler})
        started = time.monotonic()
        run = await coordinator.start(review_kind="portfolio-review", request_id="hung-preflight")
        await asyncio.wait_for(coordinator.tasks[run["runId"]], 1.3)
        self.assertLess(time.monotonic() - started, 1.3)
        self.assertTrue(cancelled.is_set())
        saved = self.store.get(run["runId"])
        self.assertEqual((saved["state"], saved["phase"]), ("failed", "terminal"))
        self.assertEqual(saved["errorCode"], "IBKR_GATEWAY_READINESS_TIMEOUT")
        # An at-budget timeout on a free loop is final: one attempt, no re-probe.
        self.assertEqual(saved["dependencies"]["ibGateway"]["detail"]["attemptCount"], 1)
        for name in ("portfolio", "portfolioBalance", "portfolioOpenOrders"):
            self.assertEqual(saved["dependencies"][name]["status"], "failed")
            self.assertEqual(saved["dependencies"][name]["errorCode"], "IBKR_CONNECTION_UNVERIFIED_NOT_ATTEMPTED")
            self.assertIn("elapsedMs", saved["dependencies"][name]["detail"])
        portfolio.assert_not_awaited()

    async def test_known_disconnection_is_not_a_transient_broker_retry(self):
        run, _ = self.store.create(review_kind="portfolio-review", request_id="no-disconnect-retry")
        context = ReviewExecutionContext(self.store, run["runId"], "portfolio-review")
        unavailable = {"status": "unavailable", "liveVerified": False, "errorCode": "GATEWAY_UNAVAILABLE"}
        reader = AsyncMock(return_value=unavailable)
        result = await analyst_app._read_retrying_broker_review_source(context, "portfolio", reader, timeout_seconds=1)
        self.assertIs(result, unavailable)
        reader.assert_awaited_once()


if __name__ == "__main__":
    unittest.main()
