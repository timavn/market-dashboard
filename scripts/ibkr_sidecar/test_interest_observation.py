import json
import unittest
from datetime import date, datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from ib_insync import Contract

import app


def account_rows(
    account="U1",
    *,
    ledger_suffix="",
    observed_at=None,
):
    observed = observed_at or app.now_iso()
    broker_date = datetime.now(app.ZoneInfo("America/New_York")).date()
    next_date = broker_date + timedelta(days=1)
    securities_ladder = (
        f"{broker_date:%Y%m%d}:40000;"
        f"{next_date:%Y%m%d}:40500{ledger_suffix}"
    )
    values = [
        ("Currency", "USD", "BASE"),
        ("NetLiquidation", "195000", "BASE"),
        ("TotalCashValue", "40500", "BASE"),
        ("TotalCashValue-S", "40500", "BASE"),
        ("TotalCashValue-C", "0", "BASE"),
        ("TotalCashValue-Z", "0", "BASE"),
        ("MaintMarginReq-C", "17.25", "BASE"),
        ("GrossPositionValue-S", "260000", "BASE"),
        ("StockMarketValue", "90000", "BASE"),
        ("AccruedCash-S", "-12.5", "BASE"),
        ("FxCashBalance", "0", "BASE"),
        ("SettledCashByDate-S", securities_ladder, "BASE"),
        ("SettledCashByDate-C", f"{broker_date:%Y%m%d}:0", "BASE"),
        ("SettledCashByDate-Z", f"{broker_date:%Y%m%d}:0", "BASE"),
        ("CashBalance", "40500", "USD"),
        ("AccountReady", "true", ""),
    ]
    return [
        {
            "account": account,
            "modelCode": "",
            "tag": tag,
            "value": value,
            "currency": currency,
            "received_at": observed,
        }
        for tag, value, currency in values
    ]


def stock_position(con_id, symbol, quantity, account="U1"):
    return SimpleNamespace(
        account=account,
        position=quantity,
        contract=Contract(
            conId=con_id,
            symbol=symbol,
            localSymbol=symbol,
            secType="STK",
            exchange="SMART",
            currency="USD",
        ),
    )


def execution_evidence(exec_id="exec-1"):
    row = {
        "execId": exec_id,
        "conId": 202,
        "side": "SLD",
        "shares": 5.0,
        "price": 95.0,
    }
    return {
        "asOf": app.now_iso(),
        "count": 1,
        "rows": [row],
        "signature": (
            json.dumps(
                row,
                sort_keys=True,
                separators=(",", ":"),
                allow_nan=False,
            ),
        ),
    }


class ObservationSession:
    def __init__(self, *, accounts=None, gateway_time=None):
        self.accounts = accounts if accounts is not None else ["U1"]
        self.gateway_time = gateway_time or datetime.now(timezone.utc)
        self.connected = True
        self.disconnect_count = 0

    def isConnected(self):
        return self.connected

    async def reqCurrentTimeAsync(self):
        return self.gateway_time

    def managedAccounts(self):
        return self.accounts

    def disconnect(self):
        self.connected = False
        self.disconnect_count += 1


class InterestObservationTests(unittest.IsolatedAsyncioTestCase):
    async def invoke(
        self,
        session,
        *,
        row_snapshots=None,
        position_snapshots=None,
        execution_snapshots=None,
        account="U1",
        current_session_scheduled=False,
    ):
        rows = row_snapshots or [account_rows(), account_rows()]
        positions = position_snapshots or [
            [
                stock_position(101, "SPY", 100),
                stock_position(202, "TLT", -5),
            ],
            [
                stock_position(101, "SPY", 100),
                stock_position(202, "TLT", -5),
            ],
        ]
        executions = execution_snapshots or [
            execution_evidence(),
            execution_evidence(),
        ]
        broker_date = session.gateway_time.astimezone(
            app.ZoneInfo("America/New_York")
        ).date()
        latest_completed = broker_date - timedelta(days=1)
        next_session = broker_date + timedelta(days=1)
        liquid_hours = (
            f"{broker_date:%Y%m%d}:"
            f"0930-{broker_date:%Y%m%d}:1600"
            if current_session_scheduled
            else f"{broker_date:%Y%m%d}:CLOSED"
        )
        liquid_hours += (
            f";{next_session:%Y%m%d}:"
            f"0930-{next_session:%Y%m%d}:1600"
        )
        short_evidence = [
            {
                "conId": 202,
                "symbol": "TLT",
                "currency": "USD",
                "quantity": -5.0,
                "referenceClose": 94.5,
                "referenceCloseSource": "ibkr_historical_daily_close",
                "referenceCloseSessionDate": latest_completed.isoformat(),
                "referenceCloseObservedAt": app.now_iso(),
            }
        ]

        original_session = app.funding_ib
        account_mock = AsyncMock(side_effect=rows)
        positions_mock = AsyncMock(side_effect=positions)
        executions_mock = AsyncMock(side_effect=executions)
        try:
            app.funding_ib = session
            with (
                patch.object(
                    app,
                    "request_fresh_account_updates_multi",
                    account_mock,
                ),
                patch.object(
                    app,
                    "request_fresh_supported_stock_positions",
                    positions_mock,
                ),
                patch.object(
                    app,
                    "request_fresh_account_execution_evidence",
                    executions_mock,
                ),
                patch.object(
                    app,
                    "request_us_equity_market_calendar",
                    AsyncMock(
                        return_value={
                            "contract": Contract(conId=756733),
                            "currentSessionScheduled": (
                                current_session_scheduled
                            ),
                            "liquidHours": liquid_hours,
                        }
                    ),
                ),
                patch.object(
                    app,
                    "request_latest_completed_us_equity_session",
                    AsyncMock(return_value=latest_completed),
                ),
                patch.object(
                    app,
                    "build_short_position_reference_evidence",
                    AsyncMock(return_value=short_evidence),
                ),
            ):
                response = await app.portfolio_interest_observation(account)
        finally:
            app.funding_ib = original_session
        return response, account_mock, positions_mock, executions_mock

    async def test_returns_double_read_live_observation_with_unsettled_activity(self):
        session = ObservationSession()
        response, account_mock, positions_mock, executions_mock = (
            await self.invoke(session)
        )
        payload = json.loads(response.body)

        self.assertEqual(response.status_code, 200)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["status"], "live")
        self.assertEqual(
            payload["source"],
            "ibkr_live_interest_observation",
        )
        self.assertEqual(payload["account"], "U1")
        self.assertFalse(payload["from_cache"])
        self.assertIn("no-store", response.headers["cache-control"])
        self.assertEqual(payload["summary"]["TotalCashValue-S"], 40500.0)
        self.assertEqual(payload["summary"]["TotalCashValue-C"], 0.0)
        self.assertEqual(payload["summary"]["TotalCashValue-Z"], 0.0)
        self.assertEqual(payload["summary"]["MaintMarginReq-C"], 17.25)
        self.assertEqual(payload["summary"]["AccruedCash-S"], -12.5)
        self.assertEqual(payload["summary"]["FxCashBalance"], 0.0)
        self.assertIn(";", payload["settlement_ladders"]["securities"])
        self.assertEqual(payload["execution_evidence"]["count"], 1)
        self.assertEqual(
            payload["execution_evidence"]["rows"][0]["execId"],
            "exec-1",
        )
        self.assertEqual(payload["short_positions"][0]["quantity"], -5.0)
        self.assertEqual(payload["short_positions"][0]["priorClose"], 94.5)
        self.assertEqual(
            payload["short_positions"][0]["priorCloseSessionDate"],
            payload["market_calendar"]["priorCompletedSessionDate"],
        )
        self.assertFalse(payload["forecast"]["eligible"])
        self.assertIsNone(payload["forecast"]["sessionDate"])
        self.assertEqual(
            payload["forecast"]["nextSessionDate"],
            payload["market_calendar"]["nextSessionDate"],
        )
        self.assertEqual(len(payload["evidence_hash"]), 64)
        self.assertEqual(account_mock.await_count, 2)
        self.assertEqual(positions_mock.await_count, 2)
        self.assertEqual(executions_mock.await_count, 2)
        self.assertEqual(session.disconnect_count, 0)

    async def test_forecast_uses_broker_session_close_and_next_open_date(self):
        session_date = date(2026, 7, 24)
        next_session_date = date(2026, 7, 27)
        market_calendar = {
            "currentSessionScheduled": True,
            "liquidHours": (
                "20260724:0930-20260724:1600;"
                "20260725:CLOSED;"
                "20260726:CLOSED;"
                "20260727:0930-20260727:1600"
            ),
        }

        before_close = app.build_interest_forecast_calendar(
            market_calendar,
            broker_time=datetime(
                2026,
                7,
                24,
                19,
                59,
                tzinfo=timezone.utc,
            ),
            prior_completed_session=date(2026, 7, 23),
        )
        after_close = app.build_interest_forecast_calendar(
            market_calendar,
            broker_time=datetime(
                2026,
                7,
                24,
                20,
                1,
                tzinfo=timezone.utc,
            ),
            prior_completed_session=date(2026, 7, 23),
        )

        self.assertFalse(before_close["eligible"])
        self.assertEqual(
            before_close["latestCompletedSessionDate"],
            "2026-07-23",
        )
        self.assertTrue(after_close["eligible"])
        self.assertEqual(
            after_close["sessionDate"],
            session_date.isoformat(),
        )
        self.assertEqual(after_close["accrualDays"], 3)
        self.assertEqual(
            after_close["nextSessionDate"],
            next_session_date.isoformat(),
        )
        self.assertEqual(
            after_close["latestCompletedSessionDate"],
            session_date.isoformat(),
        )

    async def test_rejects_changed_ledger_position_or_execution_signature(self):
        cases = [
            {
                "name": "ledger",
                "rows": [
                    account_rows(),
                    account_rows(ledger_suffix="0"),
                ],
                "positions": None,
                "executions": None,
            },
            {
                "name": "position",
                "rows": None,
                "positions": [
                    [stock_position(202, "TLT", -5)],
                    [stock_position(202, "TLT", -6)],
                ],
                "executions": None,
            },
            {
                "name": "execution",
                "rows": None,
                "positions": None,
                "executions": [
                    execution_evidence("exec-1"),
                    execution_evidence("exec-2"),
                ],
            },
        ]
        for case in cases:
            with self.subTest(case["name"]):
                session = ObservationSession()
                response, *_mocks = await self.invoke(
                    session,
                    row_snapshots=case["rows"],
                    position_snapshots=case["positions"],
                    execution_snapshots=case["executions"],
                )
                payload = json.loads(response.body)
                self.assertEqual(response.status_code, 409)
                self.assertEqual(
                    payload["errorCode"],
                    "INTEREST_OBSERVATION_CHANGED",
                )
                self.assertEqual(payload["status"], "unavailable")
                self.assertFalse(payload["from_cache"])
                self.assertEqual(session.disconnect_count, 1)

    async def test_rejects_duplicate_or_mismatched_accounts(self):
        duplicate_session = ObservationSession(accounts=["U1", "U1"])
        duplicate_response, *_mocks = await self.invoke(
            duplicate_session
        )
        duplicate_payload = json.loads(duplicate_response.body)
        self.assertEqual(duplicate_response.status_code, 409)
        self.assertEqual(
            duplicate_payload["errorCode"],
            "MANAGED_ACCOUNTS_DUPLICATE",
        )

        mismatch_session = ObservationSession(accounts=["U2"])
        mismatch_response, *_mocks = await self.invoke(
            mismatch_session
        )
        mismatch_payload = json.loads(mismatch_response.body)
        self.assertEqual(mismatch_response.status_code, 409)
        self.assertEqual(
            mismatch_payload["errorCode"],
            "ACCOUNT_NOT_MANAGED",
        )

    async def test_rejects_stale_broker_time(self):
        session = ObservationSession(
            gateway_time=(
                datetime.now(timezone.utc)
                - timedelta(
                    seconds=(
                        app.INTEREST_OBSERVATION_BROKER_TIME_MAX_AGE_SEC
                        + 5
                    )
                )
            )
        )
        response, account_mock, *_mocks = await self.invoke(session)
        payload = json.loads(response.body)

        self.assertEqual(response.status_code, 503)
        self.assertEqual(payload["errorCode"], "BROKER_TIME_STALE")
        self.assertEqual(payload["status"], "unavailable")
        self.assertEqual(account_mock.await_count, 0)
        self.assertEqual(session.disconnect_count, 1)

    async def test_rejects_disconnect_during_the_first_account_read(self):
        session = ObservationSession()

        async def disconnecting_account_read(*_args):
            session.connected = False
            return account_rows()

        original_session = app.funding_ib
        try:
            app.funding_ib = session
            with patch.object(
                app,
                "request_fresh_account_updates_multi",
                AsyncMock(side_effect=disconnecting_account_read),
            ):
                response = await app.portfolio_interest_observation("U1")
        finally:
            app.funding_ib = original_session
        payload = json.loads(response.body)

        self.assertEqual(response.status_code, 503)
        self.assertEqual(
            payload["errorCode"],
            "INTEREST_OBSERVATION_DISCONNECTED",
        )
        self.assertEqual(payload["status"], "unavailable")
        self.assertEqual(session.disconnect_count, 1)

    async def test_requires_an_explicit_account_and_rejects_busy_reads(self):
        missing_response = await app.portfolio_interest_observation(None)
        missing_payload = json.loads(missing_response.body)
        self.assertEqual(missing_response.status_code, 409)
        self.assertEqual(missing_payload["errorCode"], "ACCOUNT_REQUIRED")

        async with app.funding_snapshot_lock:
            busy_response = await app.portfolio_interest_observation("U1")
        busy_payload = json.loads(busy_response.body)
        self.assertEqual(busy_response.status_code, 409)
        self.assertEqual(
            busy_payload["errorCode"],
            "INTEREST_OBSERVATION_BUSY",
        )


if __name__ == "__main__":
    unittest.main()
