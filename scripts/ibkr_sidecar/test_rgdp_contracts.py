import asyncio
import unittest
from types import SimpleNamespace

from ib_insync import Contract

import app


def context(**overrides):
    return app.PredictionMonitorContext(**{
        "marketId": "gdp", "productCode": "RGDP", "generationKey": "RGDP_Q399",
        "eventPrefix": "RGDP_Q399", "measuredQuarter": "2099-Q3",
        "settlementStage": "third", "rulesUrl": app.RGDP_TERMS_URL,
        "closeTime": "2099-12-23T13:30:00Z", "targetStrikes": [-0.5, 0],
        **overrides,
    })


def requested_contract(strike=0, right="C", **overrides):
    return {
        "publicContractId": f"RGDP_Q399_{strike}", "contractId": f"RGDP_Q399_{strike}",
        "productCode": "RGDP", "symbol": "RGDP", "underlying": "RGDP", "secType": "OPT",
        "exchange": "FORECASTX", "currency": "USD", "tradingClass": "RGDP",
        "lastTradeDateOrContractMonth": "20991223", "strike": strike, "right": right,
        "releaseKey": "RGDP_Q399", "quote_side": "YES" if right == "C" else "NO",
        "question": f"Will the annualized growth rate in US Real GDP exceed {strike}% in Q3 2099?",
        "measuredQuarter": "2099-Q3", "metric": "real_gdp", "unit": "qoq_saar_pct",
        "settlementStage": "third", "comparator": ">", "rulesUrl": app.RGDP_TERMS_URL,
        "settlement_source": app.RGDP_TERMS_URL,
        "close_time": "2099-12-23T13:30:00Z", "expiration_time": "2099-12-23T13:30:00Z",
        "payoutAt": "2099-12-23T15:30:00Z",
        **overrides,
    }


class RgdpContractTests(unittest.TestCase):
    def test_measured_quarter_is_not_derived_from_the_december_expiration(self):
        request = app.DiscoveryRequest(monitor=context())
        self.assertEqual(app.request_release_key(request), "RGDP_Q399")
        for overrides in (
            {"measuredQuarter": "2099-Q4"},
            {"generationKey": "RGDP_Q299", "eventPrefix": "RGDP_Q299"},
            {"closeTime": "2099-10-29T12:30:00Z"},
            {"settlementStage": "advance"},
            {"rulesUrl": "https://example.com/RGDPTermsandConditions.pdf"},
            {"generationKey": "RGDP_122399", "eventPrefix": "RGDP_122399"},
        ):
            with self.subTest(overrides=overrides):
                self.assertIsNone(app.request_release_key(app.DiscoveryRequest(monitor=context(**overrides))))

    def test_native_contract_identity_rejects_wrong_quarter_question_rules_and_expiration(self):
        request = app.DiscoveryRequest(monitor=context())
        self.assertIsNone(app.monitor_seed_identity_reason(requested_contract(-0.5), request))
        self.assertIsNone(app.monitor_seed_identity_reason(requested_contract(0), request))
        for overrides in (
            {"question": "Will the annualized growth rate in US Real GDP exceed 0% in Q2 2099?"},
            {"unit": "yoy_pct"}, {"comparator": ">="}, {"settlementStage": "advance"},
            {"rulesUrl": "https://example.com/RGDPTermsandConditions.pdf"},
            {"strike": 0.5}, {"lastTradeDateOrContractMonth": "20991029"},
            {"expiration_time": "2099-10-29T12:30:00Z"},
        ):
            with self.subTest(overrides=overrides):
                seed = {**requested_contract(), **overrides}
                self.assertIsNotNone(app.monitor_seed_identity_reason(seed, request))

    def test_public_metadata_only_becomes_quote_eligible_after_exact_native_qualification(self):
        valid = [requested_contract(strike, right) for strike in (-0.5, 0) for right in ("C", "P")]
        request = app.DiscoveryRequest(monitor=context(), catalogContracts=valid + [
            requested_contract(unit="yoy_pct"), requested_contract(settlementStage="advance"),
        ])
        self.assertEqual(app.quote_eligible_seeds(valid, request), [])

        class FakeIb:
            def __init__(self):
                self.requested = []

            async def qualifyContractsAsync(self, contract):
                self.requested.append(contract)
                contract.conId = 100 + len(self.requested)
                contract.localSymbol = f"RGDP_Q399_{contract.strike}_{'YES' if contract.right == 'C' else 'NO'}"
                return [contract]

            async def reqContractDetailsAsync(self, contract):
                self.requested.append(contract)
                contract.conId = 100 + len(self.requested)
                return [SimpleNamespace(contract=contract)]

        original_ib = app.ib
        fake = FakeIb()
        try:
            app.ib = fake
            qualified = asyncio.run(app.qualify_forecastx_public_contracts(request))
        finally:
            app.ib = original_ib
        self.assertEqual(len(fake.requested), 4)
        self.assertEqual(len(qualified), 4)
        self.assertEqual(len(app.quote_eligible_seeds(qualified, request)), 4)
        self.assertEqual({seed["quote_side"] for seed in qualified}, {"YES", "NO"})
        for seed in qualified:
            self.assertEqual(seed["rulesUrl"], app.RGDP_TERMS_URL)
            self.assertEqual(seed["measuredQuarter"], "2099-Q3")
            self.assertEqual(seed["settlementStage"], "third")
            self.assertEqual(seed["catalog_source"], "ibkr_contract_details")

    def test_qualification_rejects_a_different_native_expiry_or_strike(self):
        requested = requested_contract()
        for overrides in ({"strike": 0.5}, {"lastTradeDateOrContractMonth": "20991029"}):
            native = Contract(**{
                "symbol": "RGDP", "secType": "OPT", "exchange": "FORECASTX", "currency": "USD",
                "tradingClass": "RGDP", "lastTradeDateOrContractMonth": "20991223",
                "strike": 0, "right": "C", "conId": 7, **overrides,
            })
            self.assertFalse(app.qualified_forecastx_contract_matches(native, requested))

    def test_zero_strike_wildcard_selects_exactly_one_authoritative_native_identity(self):
        request = app.DiscoveryRequest(monitor=context(), catalogContracts=[requested_contract(0)])

        class FakeIb:
            def __init__(self, ambiguous=False):
                self.ambiguous = ambiguous

            async def qualifyContractsAsync(self, _contract):
                raise AssertionError("IBKR qualification treats a zero strike as an ambiguous wildcard")

            async def reqContractDetailsAsync(self, _query):
                candidates = [(10, -0.5, "C"), (11, 0, "C"), (12, 0, "P"), (13, 0.5, "C")]
                if self.ambiguous:
                    candidates.append((14, 0, "C"))
                return [SimpleNamespace(contract=Contract(
                    conId=cid, symbol="RGDP", secType="OPT", exchange="FORECASTX", currency="USD",
                    lastTradeDateOrContractMonth="20991223", tradingClass="RGDP", strike=strike, right=right,
                )) for cid, strike, right in candidates]

        original_ib = app.ib
        try:
            app.ib = FakeIb()
            qualified = asyncio.run(app.qualify_forecastx_public_contracts(request))
            self.assertEqual([seed["conId"] for seed in qualified], [11])
            self.assertEqual(qualified[0]["strike"], 0)
            app.ib = FakeIb(ambiguous=True)
            self.assertEqual(asyncio.run(app.qualify_forecastx_public_contracts(request)), [])
        finally:
            app.ib = original_ib


if __name__ == "__main__":
    unittest.main()
