import unittest
import json
from decimal import Decimal
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))

from stream_manager import raw_quote_is_ready, ticker_to_raw_quote
from app import finite_float, money_cents, request_live_short_quotes, FundingEvidenceError


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
    def test_market_data_type_requires_the_exact_integer_broker_enum(self):
        for value in (True, False, 1.0, Decimal("1"), "1", [], {}, None, 0, 5):
            with self.subTest(value=repr(value)):
                raw = ticker_to_raw_quote(ticker(last=100, marketDataType=value), contract())
                self.assertEqual(raw["dataType"], "unknown")
                self.assertFalse(raw_quote_is_ready(raw))
        for value, expected in ((1, "live"), (2, "frozen"), (3, "delayed"), (4, "delayed_frozen")):
            self.assertEqual(ticker_to_raw_quote(ticker(last=100, marketDataType=value), contract())["dataType"], expected)

    def test_python_number_boundary_rejects_coercible_non_numeric_values(self):
        class Floatable:
            def __float__(self):
                raise AssertionError("nonnumeric objects must not be coerced")

        for value in (True, False, [], [1], {}, Floatable(), "", " ", "100x", "0x64", "100\n", " 100", float("inf"), Decimal("NaN")):
            with self.subTest(value=repr(value)):
                self.assertIsNone(finite_float(value))
        for value, expected in ((1, 1.0), (-2.5, -2.5), (Decimal("12.34"), 12.34), ("1.25e2", 125.0), ("-.5", -0.5)):
            self.assertEqual(finite_float(value), expected)
        self.assertEqual(money_cents(Decimal("1.005")), 101)
        self.assertEqual(money_cents("1.005"), 101)
        with self.assertRaises(ValueError):
            money_cents(True)

    def test_boolean_or_container_quotes_never_serialize_as_numeric_prices(self):
        for value in (True, False, [], [100], {}, "100x", " "):
            with self.subTest(value=repr(value)):
                raw = ticker_to_raw_quote(ticker(last=value, bid=value, ask=value, close=value), contract())
                payload = json.loads(json.dumps(raw, allow_nan=False))
                for field in ("last", "bid", "ask", "close"):
                    self.assertIsNone(payload[field])
                self.assertFalse(raw_quote_is_ready(payload))
                self.assertIsNone(payload["timestamp"])

    def test_decimal_broker_values_survive_json_serialization(self):
        raw = ticker_to_raw_quote(ticker(last=Decimal("100.25"), bid="100.20", ask="100.30", close=Decimal("99.5")), contract())
        payload = json.loads(json.dumps(raw, allow_nan=False))
        self.assertEqual(payload["last"], 100.25)
        self.assertEqual(payload["bid"], 100.2)
        self.assertTrue(raw_quote_is_ready(payload))

    def test_boolean_contract_ids_cannot_become_contract_one(self):
        candidate = contract()
        candidate.conId = True
        self.assertIsNone(ticker_to_raw_quote(ticker(last=100), candidate)["conId"])

    def test_readiness_rejects_unserialized_non_numeric_fields(self):
        raw = ticker_to_raw_quote(ticker(last=100, bid=99, ask=101), contract())
        for value in (True, False, [], [100], {}, "100x", " "):
            self.assertFalse(raw_quote_is_ready({**raw, "bid": value}))

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

    def test_nonfinite_crossed_unknown_and_mock_observations_are_unavailable(self):
        self.assertIsNone(ticker_to_raw_quote(ticker(last=float("inf")), contract())["last"])
        ready = ticker_to_raw_quote(ticker(last=100, bid=99, ask=101, tickByTicks=[]), contract())
        self.assertEqual(ready["entitlementStatus"], "live")
        for change in ({"entitlementStatus": "unknown"}, {"bid": 102, "ask": 101}, {"mock": True}):
            self.assertFalse(raw_quote_is_ready({**ready, **change}))

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


class FundingQuoteEnumTests(unittest.IsolatedAsyncioTestCase):
    async def test_funding_quote_gate_rejects_boolean_float_and_container_enum(self):
        for value in (True, 1.0, "1", [], {}):
            candidate = ticker(bid=99, ask=101, last=100, marketDataType=value)
            cancelled = []
            broker = SimpleNamespace(reqMktData=lambda *_args: candidate, cancelMktData=lambda item: cancelled.append(item))
            with patch("app.FUNDING_QUOTE_TIMEOUT_SEC", 0):
                with self.assertRaises(FundingEvidenceError):
                    await request_live_short_quotes(broker, [contract()], include_shortability=False)
            self.assertEqual(len(cancelled), 1)


if __name__ == "__main__":
    unittest.main()
