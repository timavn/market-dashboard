import copy
from datetime import datetime, timezone
import unittest

from inbox_holdings import current_holding_weights


NOW = datetime(2026, 9, 15, 17, 0, tzinfo=timezone.utc)
OBSERVED = "2026-09-15T16:59:50Z"


def portfolio():
    return {"liveVerified": True, "freshness": "live", "provider": "ibkr", "asOf": OBSERVED, "data": {
        "accounts": ["U1"],
        "accountSummaries": [{"account": "U1", "observedAt": OBSERVED,
            "summary": {"NetLiquidation": {"value": "100000", "currency": "USD"}}}],
        "positions": [{"account": "U1", "symbol": "WING", "quantity": -10,
            "instrumentCategory": "other", "marketValue": -2500, "currency": "USD",
            "currentValuesLiveVerified": True, "valuationBasis": "live_ibkr",
            "portfolioWeightVerified": True,
            "valuationSource": "ibkr_broker_snapshot", "quoteObservedAt": "2026-09-15T16:59:45Z"}],
    }}


class InboxHoldingsTests(unittest.TestCase):
    def test_short_and_long_weights_are_absolute_and_keep_oldest_provider_observation(self):
        source = portfolio()
        row = current_holding_weights(source, NOW)[0]
        self.assertEqual(row["heldSide"], "SHORT")
        self.assertEqual(row["currentHolding"], {
            "weightPct": 2.5, "source": "ibkr", "basis": "absolute_market_value_over_net_liquidation",
            "asOf": "2026-09-15T16:59:45Z", "currency": "USD",
        })
        source["data"]["positions"][0].update(quantity=10, marketValue=2500)
        self.assertEqual(current_holding_weights(source, NOW)[0]["currentHolding"]["weightPct"], 2.5)

    def test_all_accounts_contribute_nlv_and_same_holding_values(self):
        source = portfolio()
        source["data"]["accounts"].append("U2")
        source["data"]["accountSummaries"].append({"account": "U2", "observedAt": OBSERVED,
            "summary": {"NetLiquidation": {"value": 100000, "currency": "USD"}}})
        second = {**source["data"]["positions"][0], "account": "U2", "quantity": -6, "marketValue": -1500}
        source["data"]["positions"].append(second)
        row = current_holding_weights(source, NOW)[0]
        self.assertEqual(row["quantity"], -16)
        self.assertEqual(row["currentHolding"]["weightPct"], 2)
        source["data"]["accountSummaries"].pop()
        self.assertEqual(current_holding_weights(source, NOW), [])

    def test_native_account_summary_scalar_keeps_explicit_broker_currency(self):
        source = portfolio()
        source["data"]["accountSummaries"][0]["summary"] = {"NetLiquidation": 100000, "currency": "USD"}
        self.assertEqual(current_holding_weights(source, NOW)[0]["currentHolding"]["weightPct"], 2.5)

    def test_offline_stale_cache_seed_mock_and_unverified_source_omit_weights(self):
        for change in [{"liveVerified": False}, {"status": "offline"}, {"freshness": "cache-only"},
                       {"stale": True}, {"from_cache": True}, {"seeded": True}, {"mock": True},
                       {"provider": "mock"}, {"asOf": "2026-09-15T16:58:59Z"}]:
            with self.subTest(change=change):
                self.assertEqual(current_holding_weights({**portfolio(), **change}, NOW), [])

    def test_missing_mark_or_currency_mismatch_never_falls_back_to_cost_or_saved_weight(self):
        for change in [{"currentValuesLiveVerified": False}, {"portfolioWeightVerified": False}, {"marketValue": None}, {"currency": "EUR"},
                       {"stale": True}, {"fromCache": True}, {"seeded": True}, {"mock": True},
                       {"valuationBasis": "cost_basis"}, {"instrumentCategory": "listed_option"},
                       {"quoteObservedAt": "2026-09-15T16:58:59Z"}, {"quoteObservedAt": None}]:
            with self.subTest(change=change):
                source = portfolio()
                source["data"]["positions"][0].update(change, costBasis=2500, weightPct=2.5)
                self.assertIsNone(current_holding_weights(source, NOW)[0]["currentHolding"])

    def test_summary_requires_value_currency_freshness_and_complete_account_coverage(self):
        for change in [{"observedAt": None}, {"observedAt": "2026-09-15T16:58:59Z"}, {"from_cache": True},
                       {"summary": {"NetLiquidation": {"value": 100000}}},
                       {"summary": {"NetLiquidation": {"value": 100000, "currency": "BASE"}}},
                       {"summary": {"NetLiquidation": {"value": 0, "currency": "USD"}}}]:
            with self.subTest(change=change):
                source = copy.deepcopy(portfolio())
                source["data"]["accountSummaries"][0].update(change)
                self.assertEqual(current_holding_weights(source, NOW), [])


class InboxHoldingsReaderTests(unittest.IsolatedAsyncioTestCase):
    async def test_reader_preserves_only_verified_native_valuation_and_account_summary_inputs(self):
        from market import IbkrReader

        for change, expected in [({}, 2.5), ({"quote": {"last": None, "bid": 249, "ask": 251}}, None),
                                 ({"quote": {"mock": True}}, None), ({"summary": {"from_cache": True}}, None),
                                 ({"positions": {"seeded": True}}, None)]:
            with self.subTest(change=change):
                observed = datetime.now(timezone.utc).isoformat()

                async def request(path, **_kwargs):
                    if path == "/status":
                        return {"connected": True, "status": "connected", "accounts": ["U1"]}
                    if path == "/portfolio/live-positions":
                        return {"ok": True, "source": "ibkr_live_session", "accounts": ["U1"], "positions_observed_at": observed,
                            "positions": [{"account": "U1", "symbol": "WING", "conId": 123, "secType": "STK",
                                "exchange": "SMART", "currency": "USD", "position": -10, "avgCost": 200}], **change.get("positions", {})}
                    if path == "/quotes":
                        return {"quotes": [{"symbol": "WING", "conId": 123, "last": 250, "currency": "USD",
                            "dataType": "live", "priceState": "market_mark", "entitlementStatus": "tick_by_tick",
                            "timestamp": observed, **change.get("quote", {})}]}
                    if path.startswith("/portfolio/live-account-summary"):
                        return {"ok": True, "source": "ibkr_live_session", "observed_at": observed,
                            "summary": {"NetLiquidation": 100000, "currency": "USD"}, **change.get("summary", {})}
                    if path.startswith("/portfolio/pnl"):
                        return {"ok": True, "source": "ibkr_live_session", "observed_at": observed, "pnl": {}}
                    raise AssertionError(path)

                source = await IbkrReader(request=request).portfolio_context()
                rows = current_holding_weights(source)
                value = rows[0].get("currentHolding") if rows else None
                self.assertEqual(value["weightPct"] if value else None, expected)


if __name__ == "__main__":
    unittest.main()
