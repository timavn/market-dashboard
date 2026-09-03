import unittest
from datetime import date, datetime, timezone
from types import SimpleNamespace

import app


def bar(session_date, high):
    return SimpleNamespace(date=session_date, high=high)


class FakeHistoricalSession:
    def __init__(self, chunks, head_value=datetime(2000, 1, 3, tzinfo=timezone.utc)):
        self.chunks = list(chunks)
        self.head_value = head_value
        self.requests = []
        self.head_requests = []

    async def reqHeadTimeStampAsync(self, *_args, **kwargs):
        self.head_requests.append(kwargs)
        return self.head_value

    async def reqHistoricalDataAsync(self, _contract, **kwargs):
        self.requests.append(kwargs)
        return self.chunks[min(len(self.requests) - 1, len(self.chunks) - 1)]


class HistoricalRecordTests(unittest.IsolatedAsyncioTestCase):
    def test_uses_broker_midpoints_for_spot_gold_history(self):
        self.assertEqual(
            app.historical_what_to_show(SimpleNamespace(secType="CMDTY")),
            "MIDPOINT",
        )
        self.assertEqual(
            app.historical_what_to_show(SimpleNamespace(secType="FUT")),
            "TRADES",
        )

    def test_con_id_is_not_combined_with_partial_position_identity(self):
        contract = app.instrument_to_contract(
            app.InstrumentIn(
                symbol="EXPGY",
                conId=41197624,
                secType="STK",
                exchange="PINK",
                currency="USD",
            )
        )

        self.assertEqual(contract.conId, 41197624)
        self.assertEqual(contract.symbol, "")
        self.assertEqual(contract.secType, "")
        self.assertEqual(contract.exchange, "")
        self.assertEqual(contract.currency, "")

    async def test_pages_to_the_provider_head_and_returns_the_strict_high_record(self):
        session = FakeHistoricalSession([
            [
                bar(date(2017, 1, 3), 6100),
                bar(date(2020, 8, 10), 8000),
                bar(date(2026, 8, 10), 7900),
            ],
            [
                bar(date(2000, 1, 3), 1500),
                bar(date(2016, 12, 30), 6000),
            ],
        ])

        result = await app.load_historical_high_record(
            session,
            SimpleNamespace(symbol="SPX"),
            date(2026, 8, 10),
        )

        self.assertEqual(result["record"], {"high": 8000, "date": "2020-08-10"})
        self.assertEqual(
            result["coverage"],
            {
                "complete": True,
                "start_date": "2000-01-03",
                "end_date": "2026-08-10",
                "head_date": "2000-01-03",
                "chunks": 2,
                "observations": 5,
            },
        )
        self.assertEqual(len(session.requests), 2)
        self.assertTrue(all(request["durationStr"] == "10 Y" for request in session.requests))
        self.assertTrue(all(request["barSizeSetting"] == "1 day" for request in session.requests))
        self.assertTrue(all(request["useRTH"] is True for request in session.requests))
        self.assertTrue(all(request["useRTH"] is True for request in session.head_requests))

    async def test_uses_full_verified_sessions_for_futures_records(self):
        session = FakeHistoricalSession([[
            bar(date(2000, 1, 3), 10),
            bar(date(2026, 8, 10), 80),
        ]])

        result = await app.load_historical_high_record(
            session,
            SimpleNamespace(symbol="SI", secType="FUT"),
            date(2026, 8, 10),
        )

        self.assertEqual(result["record"], {"high": 80, "date": "2026-08-10"})
        self.assertTrue(all(request["useRTH"] is False for request in session.requests))
        self.assertTrue(all(request["useRTH"] is False for request in session.head_requests))

    async def test_uses_full_verified_midpoint_sessions_for_spot_gold_records(self):
        session = FakeHistoricalSession([
            [
                bar(date(2005, 1, 3), 430),
                bar(date(2026, 8, 10), 4550),
            ],
            [],
        ], head_value=None)

        result = await app.load_historical_high_record(
            session,
            SimpleNamespace(symbol="XAUUSD", secType="CMDTY"),
            date(2026, 8, 10),
        )

        self.assertEqual(result["record"], {"high": 4550, "date": "2026-08-10"})
        self.assertTrue(all(request["whatToShow"] == "MIDPOINT" for request in session.requests))
        self.assertTrue(all(request["whatToShow"] == "MIDPOINT" for request in session.head_requests))
        self.assertTrue(all(request["useRTH"] is False for request in session.requests))
        self.assertTrue(all(request["useRTH"] is False for request in session.head_requests))
        self.assertEqual(result["coverage"]["start_date"], "2005-01-03")
        self.assertEqual(result["coverage"]["head_date"], "2005-01-03")
        self.assertEqual(result["coverage"]["chunks"], 2)

    async def test_uses_the_exact_futures_contract_boundary_when_root_head_predates_it(self):
        dated_contract_rows = [
            bar(date(2025, 7, 1), 35),
            bar(date(2026, 8, 10), 80),
        ]
        session = FakeHistoricalSession([dated_contract_rows, dated_contract_rows])

        result = await app.load_historical_high_record(
            session,
            SimpleNamespace(symbol="SI", secType="FUT", conId=535526329),
            date(2026, 8, 10),
        )

        self.assertEqual(result["record"], {"high": 80, "date": "2026-08-10"})
        self.assertEqual(result["coverage"], {
            "complete": True,
            "start_date": "2025-07-01",
            "end_date": "2026-08-10",
            "head_date": "2025-07-01",
            "chunks": 2,
            "observations": 2,
        })

    async def test_fails_closed_when_pagination_cannot_reach_the_provider_head(self):
        repeated = [bar(date(2020, 1, 2), 7000), bar(date(2026, 8, 10), 7900)]
        session = FakeHistoricalSession([repeated, repeated])

        with self.assertRaisesRegex(RuntimeError, "no usable daily highs"):
            await app.load_historical_high_record(
                session,
                SimpleNamespace(symbol="SPX"),
                date(2026, 8, 10),
            )

    def test_requires_an_exact_iso_cutoff_date(self):
        self.assertEqual(app.exact_date("2026-08-10"), date(2026, 8, 10))
        self.assertIsNone(app.exact_date("2026/08/10"))
        self.assertIsNone(app.exact_date("not-a-date"))


if __name__ == "__main__":
    unittest.main()
