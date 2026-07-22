import asyncio
import json
import unittest
from datetime import datetime, timezone
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace

from ib_insync import Contract

import app


def july_request(catalog_contracts=None):
    return app.DiscoveryRequest(
        cpi=app.CpiDiscoveryContext(
            series="KXCPIYOY",
            releaseKey="KXCPIYOY#2026-07",
            metric="Headline CPI YoY",
            forecastMonth="July 2026",
            reportMonth="July 2026",
            reportMonthId="2026-07",
            releaseCode="Jul 26",
            releaseDate="2026-08-12",
            eventTicker="KXCPIYOY-26JUL",
            targetStrikes=[3.3, 3.4],
        ),
        catalogContracts=catalog_contracts or [],
    )


def authoritative_seed(con_id, local_symbol, expiry="20260812"):
    return {
        "conId": con_id,
        "localSymbol": local_symbol,
        "description": local_symbol,
        "releaseKey": "KXCPIYOY#2026-07",
        "catalog_source": "ibkr_contract_details",
        "lastTradeDateOrContractMonth": expiry,
        "secType": "OPT",
        "exchange": "FORECASTX",
        "tradingClass": "KXCPIYOY",
        "currency": "USD",
    }


class CatalogLifecycleTests(unittest.TestCase):
    def test_request_catalog_is_explicit_and_never_loaded_from_local_json(self):
        original_seed_path = app.SEED_PATH
        try:
            with TemporaryDirectory() as directory:
                app.SEED_PATH = Path(directory) / "event_contract_catalog.json"
                app.save_seed_contracts([
                    authoritative_seed(31, "IB-CPI-26JUL-T3.3-YES"),
                ])

                request = july_request([
                    authoritative_seed(44, "IB-CPI-26JUL-T3.4-NO"),
                ])

                contracts = app.request_catalog_contracts(request)
                self.assertEqual([contract["conId"] for contract in contracts], [44])
                self.assertNotEqual(contracts, app.load_seed_contracts())
        finally:
            app.SEED_PATH = original_seed_path

    def test_empty_authoritative_search_reports_unsupported_or_not_entitled(self):
        async def connected():
            return {"ok": True, "status": "connected"}

        async def empty_discovery(*_args, **_kwargs):
            return []

        original_seed_path = app.SEED_PATH
        original_ensure_connected = app.ensure_connected
        original_discover = app.discover_event_contract_seeds
        try:
            with TemporaryDirectory() as directory:
                app.SEED_PATH = Path(directory) / "event_contract_catalog.json"
                app.ensure_connected = connected
                app.discover_event_contract_seeds = empty_discovery
                response = asyncio.run(app.discover(july_request()))
        finally:
            app.SEED_PATH = original_seed_path
            app.ensure_connected = original_ensure_connected
            app.discover_event_contract_seeds = original_discover

        payload = json.loads(response.body)
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["status"], "unsupported_or_not_entitled")
        self.assertEqual(payload["errorCode"], "UNSUPPORTED_OR_NOT_ENTITLED")
        self.assertEqual(payload["catalog_promotion"]["type"], "catalog_candidate")
        self.assertFalse(payload["catalog_promotion"]["atomic"])
        self.assertEqual(payload["catalog_promotion"]["authority"], "PredictionMarketCatalogV2")

    def test_discovery_returns_candidates_without_writing_a_local_catalog(self):
        async def connected():
            return {"ok": True, "status": "connected"}

        candidates = [
            authoritative_seed(51, "IB-CPI-26JUL-T3.3-YES"),
            authoritative_seed(52, "IB-CPI-26JUL-T3.4-NO"),
        ]

        async def discovered(*_args, **_kwargs):
            return candidates

        original_seed_path = app.SEED_PATH
        original_ensure_connected = app.ensure_connected
        original_discover = app.discover_event_contract_seeds
        try:
            with TemporaryDirectory() as directory:
                app.SEED_PATH = Path(directory) / "event_contract_catalog.json"
                app.ensure_connected = connected
                app.discover_event_contract_seeds = discovered
                response = asyncio.run(app.discover(july_request()))
                self.assertFalse(app.SEED_PATH.exists())
        finally:
            app.SEED_PATH = original_seed_path
            app.ensure_connected = original_ensure_connected
            app.discover_event_contract_seeds = original_discover

        payload = json.loads(response.body)
        self.assertTrue(payload["ok"])
        self.assertEqual([row["conId"] for row in payload["catalog_contracts"]], [51, 52])
        self.assertEqual(payload["catalog_promotion"]["status"], "candidate")
        self.assertFalse(payload["catalog_promotion"]["atomic"])

    def test_refresh_quotes_only_the_v2_catalog_supplied_by_express(self):
        async def connected():
            return {"ok": True, "status": "connected"}

        def forbidden_local_load():
            raise AssertionError("refresh must not load local catalog JSON")

        class FakeIb:
            async def qualifyContractsAsync(self, contract):
                return [contract]

            def reqMktData(self, contract, *_args):
                return SimpleNamespace(
                    contract=contract,
                    bid=0.41,
                    ask=0.43,
                    last=0.42,
                    volume=12,
                )

            def cancelMktData(self, _contract):
                return None

        seed = authoritative_seed(61, "IB-CPI-26JUL-T3.3-YES")
        seed["quote_wait_sec"] = 0
        original_ensure_connected = app.ensure_connected
        original_load = app.load_seed_contracts
        original_ib = app.ib
        try:
            app.ensure_connected = connected
            app.load_seed_contracts = forbidden_local_load
            app.ib = FakeIb()
            response = asyncio.run(app.refresh(july_request([seed])))
        finally:
            app.ensure_connected = original_ensure_connected
            app.load_seed_contracts = original_load
            app.ib = original_ib

        payload = json.loads(response.body)
        self.assertEqual(payload["catalog_source"], "PredictionMarketCatalogV2")
        self.assertEqual(payload["contracts_total"], 1)
        self.assertEqual([event["conId"] for event in payload["events"]], [61])
        self.assertEqual(payload["events"][0]["yes_bid"], 0.41)

    def test_runtime_provenance_reports_workspace_managed_dependencies(self):
        runtime = app.runtime_provenance()

        self.assertTrue(runtime["interpreterInsideWorkspace"])
        self.assertTrue(runtime["dependenciesInsideWorkspace"])
        self.assertTrue(runtime["prefixInsideWorkspace"])
        self.assertTrue(runtime["appInsideWorkspace"])
        self.assertIsNone(runtime["errorCode"])
        self.assertTrue(runtime["interpreter"].startswith("/"))
        self.assertTrue(runtime["interpreterRealPath"].startswith("/"))
        self.assertEqual(runtime["appPath"], str(app.Path(app.__file__).resolve()))
        self.assertIn("fastapi", runtime["dependencyPaths"])
        self.assertIn("ib_insync", runtime["dependencyPaths"])

    def test_runtime_provenance_flags_dependency_drift(self):
        runtime = app.runtime_provenance(
            prefix=app.WORKSPACE_ROOT / "scripts/ibkr_sidecar/.venv",
            app_path=app.__file__,
            dependency_paths={"fastapi": "/opt/global/site-packages/fastapi/__init__.py"},
            workspace_root=app.WORKSPACE_ROOT,
        )

        self.assertFalse(runtime["dependenciesInsideWorkspace"])
        self.assertEqual(runtime["errorCode"], "RUNTIME_DRIFT")

    def test_runtime_provenance_flags_an_interpreter_invoked_outside_workspace(self):
        runtime = app.runtime_provenance(
            interpreter="/opt/global/bin/python",
            prefix=app.WORKSPACE_ROOT / "scripts/ibkr_sidecar/.venv",
            app_path=app.__file__,
            dependency_paths={
                "fastapi": app.WORKSPACE_ROOT / "scripts/ibkr_sidecar/.venv/lib/python/site-packages/fastapi/__init__.py",
            },
            workspace_root=app.WORKSPACE_ROOT,
        )

        self.assertFalse(runtime["interpreterInsideWorkspace"])
        self.assertEqual(runtime["errorCode"], "RUNTIME_DRIFT")

    def test_portfolio_pnl_uses_a_fresh_live_subscription_and_never_cached_nlv(self):
        async def connected():
            return {"ok": True, "status": "connected"}

        class ForbiddenCache:
            def get_account_summary_cache(self, *_args):
                raise AssertionError("live PnL must not read the account-summary cache")

        class FakeIb:
            def __init__(self):
                self.subscription = None
                self.cancel_count = 0

            async def reqCurrentTimeAsync(self):
                return datetime.now(timezone.utc)

            def managedAccounts(self):
                return ["U1"]

            def cancelPnL(self, _account, _model_code):
                self.cancel_count += 1
                self.subscription = None

            def reqPnL(self, _account, _model_code):
                self.subscription = SimpleNamespace(
                    dailyPnL=125.5,
                    unrealizedPnL=80.25,
                    realizedPnL=45.25,
                )
                return self.subscription

            def pnl(self, _account, _model_code):
                return [self.subscription] if self.subscription else []

        fake_ib = FakeIb()
        original_ensure_connected = app.ensure_connected
        original_stream_manager = app.stream_manager
        original_ib = app.ib
        try:
            app.ensure_connected = connected
            app.stream_manager = ForbiddenCache()
            app.ib = fake_ib
            response = asyncio.run(app.portfolio_pnl("U1"))
        finally:
            app.ensure_connected = original_ensure_connected
            app.stream_manager = original_stream_manager
            app.ib = original_ib

        payload = json.loads(response.body)
        self.assertEqual(response.status_code, 200)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["status"], "live")
        self.assertEqual(payload["source"], "ibkr_live_session")
        self.assertEqual(payload["account"], "U1")
        self.assertEqual(payload["pnl"]["dailyPnL"], 125.5)
        self.assertIsNone(payload["pnl"]["dailyPnLPercent"])
        self.assertIsNone(payload["pnl"]["dailyPnLPercentSource"])
        self.assertGreaterEqual(fake_ib.cancel_count, 2)

    def test_only_authoritative_current_unexpired_seeds_are_quote_eligible(self):
        current = authoritative_seed(1, "IB-CPI-26JUL-T3.3-YES")
        wrong_release = {
            **authoritative_seed(2, "IB-CPI-26JUN-T3.3-YES"),
            "releaseKey": "KXCPIYOY#2026-06",
        }
        expired = authoritative_seed(3, "IB-CPI-26JUL-T3.4-YES", "20260714")
        legacy = {
            "conId": 4,
            "localSymbol": "KXCPIYOY-26JUN-T3.4_YES",
            "releaseKey": "KXCPIYOY#2026-07",
        }

        eligible = app.quote_eligible_seeds(
            [current, wrong_release, expired, legacy],
            july_request(),
            now=datetime(2026, 7, 21, tzinfo=timezone.utc),
        )

        self.assertEqual([seed["conId"] for seed in eligible], [1])

    def test_catalog_qualification_requires_fresh_discovery_and_complete_target_coverage(self):
        first = authoritative_seed(1, "IB-CPI-26JUL-T3.3-YES")
        second = authoritative_seed(2, "IB-CPI-26JUL-T3.4-NO")

        retained_only = app.cpi_catalog_qualification_report(
            [first, second],
            [],
            july_request(),
        )
        complete = app.cpi_catalog_qualification_report(
            [first, second],
            [first, second],
            july_request(),
        )

        self.assertFalse(retained_only["complete"])
        self.assertEqual(retained_only["freshDiscoveredContracts"], 0)
        self.assertFalse(retained_only["freshTargetCoverageComplete"])
        self.assertTrue(complete["authoritative"])
        self.assertTrue(complete["targetCoverageComplete"])
        self.assertTrue(complete["freshTargetCoverageComplete"])
        self.assertTrue(complete["complete"])

    def test_wrong_release_expired_and_legacy_rows_are_retired_from_active_catalog(self):
        current = authoritative_seed(1, "IB-CPI-26JUL-T3.3-YES")
        wrong_release = {
            **authoritative_seed(2, "IB-CPI-26JUN-T3.3-YES"),
            "releaseKey": "KXCPIYOY#2026-06",
        }
        expired = authoritative_seed(3, "IB-CPI-26JUL-T3.4-YES", "20260714")
        legacy = {"conId": 4, "localSymbol": "IB-CPI-26JUL-T3.4-YES"}

        active, retired = app.partition_catalog_for_release(
            [current, wrong_release, expired, legacy],
            july_request(),
            now=datetime(2026, 7, 21, tzinfo=timezone.utc),
        )

        self.assertEqual([seed["conId"] for seed in active], [1])
        self.assertEqual(
            {seed["retired_reason"] for seed in retired},
            {"wrong_release", "expired_contract", "non_authoritative_seed"},
        )
        self.assertTrue(all(seed["catalog_state"] == "retired" for seed in retired))

    def test_discovery_queries_never_manufacture_strike_or_yes_no_local_symbols(self):
        queries = app.cpi_symbol_templates(july_request())

        self.assertGreater(len(queries), 0)
        self.assertTrue(all(not query.localSymbol for query in queries))
        self.assertTrue(all(not query.symbol for query in queries))
        self.assertTrue(all(query.exchange == "FORECASTX" for query in queries))

    def test_expired_event_is_closed_and_native_side_is_not_complemented(self):
        seed = authoritative_seed(7, "IB-CPI-26JUL-T3.3-NO", "20260714")
        seed["quote_wait_sec"] = 0
        contract = Contract(
            conId=7,
            symbol="CPI",
            secType="OPT",
            exchange="FORECASTX",
            currency="USD",
            localSymbol=seed["localSymbol"],
            lastTradeDateOrContractMonth="20260714",
        )
        ticker = SimpleNamespace(
            contract=contract,
            bid=0.31,
            ask=0.33,
            last=0.32,
            volume=10,
        )

        event = app.normalize_seeded_event(seed, ticker)

        self.assertEqual(event["status"], "closed")
        self.assertIn("expired_contract", event["data_quality_flags"])
        self.assertEqual(event["no_bid"], 0.31)
        self.assertEqual(event["no_ask"], 0.33)
        self.assertIsNone(event["yes_bid"])
        self.assertIsNone(event["yes_ask"])
        self.assertEqual(event["conId"], 7)
        self.assertEqual(event["exchange"], "FORECASTX")
        self.assertEqual(event["tradingClass"], "KXCPIYOY")
        self.assertEqual(event["lastTradeDateOrContractMonth"], "20260714")
        self.assertEqual(event["catalog_source"], "ibkr_contract_details")

    def test_release_aware_merge_updates_native_contract_metadata(self):
        old = authoritative_seed(9, "IB-CPI-26JUL-T3.3-YES")
        old["tradingClass"] = "OLD"
        updated = {**old, "tradingClass": "CURRENT", "exchange": "FORECASTX"}

        merged, added = app.merge_seed_lists([old], [updated])

        self.assertEqual(added, 0)
        self.assertEqual(len(merged), 1)
        self.assertEqual(merged[0]["tradingClass"], "CURRENT")

    def test_unknown_contract_side_is_never_treated_as_yes(self):
        seed = authoritative_seed(11, "IB-CPI-26JUL-T3.3")
        contract = Contract(
            conId=11,
            symbol="CPI",
            secType="OPT",
            exchange="FORECASTX",
            currency="USD",
            localSymbol=seed["localSymbol"],
            lastTradeDateOrContractMonth="20260812",
        )
        ticker = SimpleNamespace(contract=contract, bid=0.41, ask=0.44, last=0.42, volume=5)

        event = app.normalize_seeded_event(seed, ticker)

        self.assertEqual(event["quote_side"], "UNKNOWN")
        self.assertFalse(event["tradable_in_ibkr"])
        self.assertIn("unknown_contract_side", event["data_quality_flags"])
        self.assertIsNone(event["yes_bid"])
        self.assertIsNone(event["yes_ask"])
        self.assertIsNone(event["no_bid"])
        self.assertIsNone(event["no_ask"])

    def test_live_positions_verifies_socket_and_returns_all_managed_accounts_without_prices(self):
        class FakeIb:
            async def reqCurrentTimeAsync(self):
                return datetime(2026, 7, 21, 17, 0, tzinfo=timezone.utc)

            def managedAccounts(self):
                return ["U1", "U2"]

            def positions(self):
                return [
                    SimpleNamespace(
                        account="U1",
                        position=2,
                        contract=Contract(
                            conId=101,
                            symbol="SPY",
                            localSymbol="SPY",
                            secType="STK",
                            exchange="SMART",
                            currency="USD",
                        ),
                    ),
                    SimpleNamespace(
                        account="U2",
                        position=-1,
                        contract=Contract(
                            conId=202,
                            symbol="TLT",
                            localSymbol="TLT",
                            secType="STK",
                            exchange="SMART",
                            currency="USD",
                        ),
                    ),
                ]

        async def connected():
            return {"ok": True, "status": "connected"}

        original_ib = app.ib
        original_ensure_connected = app.ensure_connected
        try:
            app.ib = FakeIb()
            app.ensure_connected = connected
            response = asyncio.run(app.portfolio_live_positions())
        finally:
            app.ib = original_ib
            app.ensure_connected = original_ensure_connected

        payload = json.loads(response.body)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(payload["source"], "ibkr_live_session")
        self.assertEqual(payload["accounts"], ["U1", "U2"])
        self.assertEqual(payload["position_count"], 2)
        self.assertEqual({row["account"] for row in payload["positions"]}, {"U1", "U2"})
        self.assertTrue(all("marketValue" not in row and "avgCost" not in row for row in payload["positions"]))

    def test_live_account_summary_requires_socket_round_trip_and_native_nlv(self):
        class FakeIb:
            async def reqCurrentTimeAsync(self):
                return datetime(2026, 7, 21, 17, 0, tzinfo=timezone.utc)

            def managedAccounts(self):
                return ["U1", "U2"]

            async def accountSummaryAsync(self, account):
                self.requested_account = account
                return [
                    SimpleNamespace(tag="NetLiquidation", value="190539.25", currency="USD"),
                    SimpleNamespace(tag="BuyingPower", value="250000", currency="USD"),
                ]

        fake_ib = FakeIb()

        async def connected():
            return {"ok": True, "status": "connected"}

        original_ib = app.ib
        original_ensure_connected = app.ensure_connected
        try:
            app.ib = fake_ib
            app.ensure_connected = connected
            response = asyncio.run(app.portfolio_live_account_summary("U2"))
        finally:
            app.ib = original_ib
            app.ensure_connected = original_ensure_connected

        payload = json.loads(response.body)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(payload["source"], "ibkr_live_session")
        self.assertEqual(payload["account"], "U2")
        self.assertEqual(payload["summary"]["NetLiquidation"], 190539.25)
        self.assertEqual(fake_ib.requested_account, "U2")


if __name__ == "__main__":
    unittest.main()
