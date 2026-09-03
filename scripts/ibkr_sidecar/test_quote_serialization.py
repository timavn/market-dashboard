import unittest
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))

from stream_manager import raw_quote_is_ready, ticker_to_raw_quote


def contract(symbol="SPX"):
    return SimpleNamespace(
        symbol=symbol,
        conId=416904,
        secType="OPT",
        exchange="CBOE",
        currency="USD",
        localSymbol=f"{symbol}   260918P05000000",
        lastTradeDateOrContractMonth="20260918",
        strike=5000,
        right="P",
        tradingClass=symbol,
        multiplier="100",
    )


def ticker(**overrides):
    values = {
        "bid": None,
        "ask": None,
        "last": None,
        "close": None,
        "prevClose": None,
        "volume": None,
        "marketDataType": 1,
        "time": datetime.now(timezone.utc),
    }
    values.update(overrides)
    return SimpleNamespace(**values)


class QuoteSerializationTests(unittest.TestCase):
    def test_close_only_reference_has_no_market_observation_timestamp(self):
        raw = ticker_to_raw_quote(ticker(close=7709.96), contract())

        self.assertEqual(raw["close"], 7709.96)
        self.assertEqual(raw["priceState"], "reference_close")
        self.assertIsNone(raw["timestamp"])
        self.assertIsNotNone(raw["fetched_at"])

    def test_fresh_market_mark_preserves_the_ibkr_timestamp(self):
        observed_at = datetime(2026, 8, 7, 20, 0, tzinfo=timezone.utc)
        raw = ticker_to_raw_quote(
            ticker(last=7757.64, close=7709.96, time=observed_at),
            contract(),
        )

        self.assertEqual(raw["priceState"], "market_mark")
        self.assertEqual(raw["timestamp"], observed_at.isoformat())
        self.assertEqual(raw["last"], 7757.64)
        self.assertEqual(raw["lastTradeDateOrContractMonth"], "20260918")
        self.assertEqual(raw["strike"], 5000)
        self.assertEqual(raw["right"], "P")
        self.assertEqual(raw["tradingClass"], "SPX")
        self.assertEqual(raw["multiplier"], "100")

    def test_unavailable_quote_still_preserves_authoritative_contract_metadata(self):
        raw = ticker_to_raw_quote(None, contract())

        self.assertEqual(raw["priceState"], "unavailable")
        self.assertEqual(raw["lastTradeDateOrContractMonth"], "20260918")
        self.assertEqual(raw["strike"], 5000)
        self.assertEqual(raw["right"], "P")
        self.assertEqual(raw["tradingClass"], "SPX")
        self.assertEqual(raw["multiplier"], "100")

    def test_empty_quote_does_not_fabricate_market_evidence(self):
        raw = ticker_to_raw_quote(ticker(), contract("RUT"))

        self.assertEqual(raw["priceState"], "unavailable")
        self.assertIsNone(raw["timestamp"])

    def test_quote_readiness_requires_mark_timestamp_type_and_entitlement(self):
        observed_at = datetime.now(timezone.utc)
        ready = {
            "priceState": "market_mark",
            "last": 1.0,
            "dataType": "delayed",
            "entitlementStatus": "delayed",
            "timestamp": observed_at.isoformat(),
        }
        self.assertTrue(raw_quote_is_ready(ready))
        for field, value in (
            ("last", 0),
            ("priceState", "reference_close"),
            ("dataType", "frozen"),
            ("entitlementStatus", "denied"),
            ("timestamp", None),
        ):
            candidate = dict(ready)
            candidate[field] = value
            self.assertFalse(raw_quote_is_ready(candidate), field)


if __name__ == "__main__":
    unittest.main()
