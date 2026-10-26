import asyncio
import json
import unittest
from datetime import date, datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from ib_insync import CommissionReport, Contract, Execution, Fill

import app


def previous_weekday(value):
    candidate = value - timedelta(days=1)
    while candidate.weekday() >= 5:
        candidate -= timedelta(days=1)
    return candidate


def next_weekday(value):
    candidate = value + timedelta(days=1)
    while candidate.weekday() >= 5:
        candidate += timedelta(days=1)
    return candidate


def account_rows(
    account="U1",
    *,
    ledger_suffix="",
    observed_at=None,
    cash_anchor_date=None,
):
    observed = observed_at or app.now_iso()
    broker_date = datetime.now(app.ZoneInfo("America/New_York")).date()
    if cash_anchor_date is not None:
        prior_cash_date = cash_anchor_date - timedelta(days=1)
        securities_ladder = (
            f"{prior_cash_date:%Y%m%d}:40000;"
            f"{cash_anchor_date:%Y%m%d}:40500{ledger_suffix}"
        )
        zero_ladder = f"{cash_anchor_date:%Y%m%d}:0"
    else:
        next_date = broker_date + timedelta(days=1)
        securities_ladder = (
            f"{broker_date:%Y%m%d}:40000;"
            f"{next_date:%Y%m%d}:40500{ledger_suffix}"
        )
        zero_ladder = f"{broker_date:%Y%m%d}:0"
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
        ("SettledCashByDate-C", zero_ladder, "BASE"),
        ("SettledCashByDate-Z", zero_ladder, "BASE"),
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


def mixed_account_rows(
    account="U1",
    market_value=1490.0,
    commodity_cash=1000.0,
    cash_anchor_date=None,
):
    rows = account_rows(account, cash_anchor_date=cash_anchor_date)
    commodity_cash_date = (
        cash_anchor_date
        or datetime.now(app.ZoneInfo("America/New_York")).date()
    )
    replacements = {
        "TotalCashValue": 40500.0 + commodity_cash,
        "TotalCashValue-C": commodity_cash,
        "MaintMarginReq-C": market_value,
        "SettledCashByDate-C": (
            f"{commodity_cash_date:%Y%m%d}:"
            f"{commodity_cash}"
        ),
    }
    for row in rows:
        if row["tag"] in replacements:
            row["value"] = str(replacements[row["tag"]])
    observed = rows[-1]["received_at"]
    rows.extend([
        {
            "account": account,
            "modelCode": "",
            "tag": tag,
            "value": str(value),
            "currency": "BASE",
            "received_at": observed,
        }
        for tag, value in [
            ("GrossPositionValue", 260000.0 + market_value),
            ("GrossPositionValue-C", market_value),
            ("NetLiquidation-C", commodity_cash + market_value),
            ("InitMarginReq-C", market_value),
            ("AvailableFunds-C", commodity_cash),
            ("EquityWithLoanValue-C", commodity_cash),
        ]
    ])
    return rows


def event_position_snapshot(
    quantity=1490.0,
    account="U1",
    exchange="KALSHI",
):
    stock = stock_position(101, "SPY", 100, account)
    short = stock_position(202, "TLT", -5, account)
    event = SimpleNamespace(
        account=account,
        position=quantity,
        contract=Contract(
            conId=303,
            symbol="CPI",
            secType="OPT",
            currency="USD",
        ),
    )
    return {
        "all": [stock, short, event],
        "stocks": [stock, short],
        "eventContracts": [{
            "conId": 303,
            "symbol": "CPI",
            "localSymbol": "CPI-YES",
            "tradingClass": "CPI",
            "exchange": exchange,
            "secType": "OPT",
            "currency": "USD",
            "multiplier": 1,
            "quantity": quantity,
        }],
        "positionScope": {
            "mode": "stocks_and_event_contracts",
            "eventVenues": [exchange],
            "allSupportedForBalance": True,
            "allStock": False,
            "allBaseCurrency": True,
            "stockPositionCount": 2,
            "eventPositionCount": 1,
        },
    }


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
        include_prior_in_liquid_hours=True,
    ):
        broker_date = session.gateway_time.astimezone(
            app.ZoneInfo("America/New_York")
        ).date()
        if current_session_scheduled:
            latest_completed = broker_date - timedelta(days=1)
            next_session = broker_date + timedelta(days=1)
        else:
            latest_completed = previous_weekday(broker_date)
            next_session = next_weekday(broker_date)
        rows = row_snapshots or [
            account_rows(
                cash_anchor_date=(
                    None if current_session_scheduled else broker_date
                )
            ),
            account_rows(
                cash_anchor_date=(
                    None if current_session_scheduled else broker_date
                )
            ),
        ]
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
        position_reads = [
            snapshot
            if isinstance(snapshot, dict)
            else {
                "all": snapshot,
                "stocks": snapshot,
                "eventContracts": [],
                "positionScope": {
                    "mode": "stocks_only",
                    "eventVenues": [],
                    "allSupportedForBalance": True,
                    "allStock": True,
                    "allBaseCurrency": True,
                    "stockPositionCount": len(snapshot),
                    "eventPositionCount": 0,
                },
            }
            for snapshot in positions
        ]
        calendar_rows = []
        if include_prior_in_liquid_hours:
            calendar_rows.append(
                f"{latest_completed:%Y%m%d}:"
                f"0930-{latest_completed:%Y%m%d}:1600"
            )
        calendar_date = (
            latest_completed + timedelta(days=1)
            if include_prior_in_liquid_hours
            else broker_date
        )
        while calendar_date < next_session:
            if current_session_scheduled and calendar_date == broker_date:
                calendar_rows.append(
                    f"{calendar_date:%Y%m%d}:"
                    f"0930-{calendar_date:%Y%m%d}:1600"
                )
            else:
                calendar_rows.append(f"{calendar_date:%Y%m%d}:CLOSED")
            calendar_date += timedelta(days=1)
        calendar_rows.append(
            f"{next_session:%Y%m%d}:"
            f"0930-{next_session:%Y%m%d}:1600"
        )
        liquid_hours = ";".join(calendar_rows)
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
        positions_mock = AsyncMock(side_effect=position_reads)
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
                    "request_fresh_balance_positions",
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
        self.assertTrue(payload["forecast"]["eligible"])
        self.assertEqual(
            payload["forecast"]["forecastKind"],
            "closed_day_remaining_window",
        )
        self.assertEqual(
            payload["forecast"]["sessionDate"],
            session.gateway_time.astimezone(
                app.ZoneInfo("America/New_York")
            ).date().isoformat(),
        )
        self.assertEqual(
            payload["forecast"]["nextSessionDate"],
            payload["market_calendar"]["nextSessionDate"],
        )
        self.assertEqual(
            payload["forecast"]["forecastKind"],
            payload["market_calendar"]["forecastKind"],
        )
        self.assertEqual(
            payload["forecast"]["basisSessionDate"],
            payload["market_calendar"]["basisSessionDate"],
        )
        self.assertEqual(
            payload["forecast"]["cashAnchorDate"],
            payload["market_calendar"]["cashAnchorDate"],
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
            after_close["forecastKind"],
            "completed_session_window",
        )
        self.assertEqual(
            after_close["sessionDate"],
            session_date.isoformat(),
        )
        self.assertEqual(
            after_close["basisSessionDate"],
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

    async def test_closed_weekend_days_use_verified_remaining_window(self):
        market_calendar = {
            "currentSessionScheduled": False,
            "liquidHours": (
                "20260724:0930-20260724:1600;"
                "20260725:CLOSED;"
                "20260726:CLOSED;"
                "20260727:0930-20260727:1600"
            ),
        }
        cases = (
            (date(2026, 7, 25), 2),
            (date(2026, 7, 26), 1),
        )

        for broker_date, expected_days in cases:
            with self.subTest(broker_date=broker_date):
                forecast = app.build_interest_forecast_calendar(
                    market_calendar,
                    broker_time=datetime(
                        broker_date.year,
                        broker_date.month,
                        broker_date.day,
                        16,
                        tzinfo=timezone.utc,
                    ),
                    prior_completed_session=date(2026, 7, 24),
                )

                self.assertTrue(forecast["eligible"])
                self.assertEqual(
                    forecast["forecastKind"],
                    "closed_day_remaining_window",
                )
                self.assertEqual(
                    forecast["sessionDate"],
                    broker_date.isoformat(),
                )
                self.assertEqual(
                    forecast["basisSessionDate"],
                    "2026-07-24",
                )
                self.assertEqual(
                    forecast["cashAnchorDate"],
                    broker_date.isoformat(),
                )
                self.assertEqual(forecast["accrualDays"], expected_days)
                self.assertEqual(
                    forecast["nextSessionDate"],
                    "2026-07-27",
                )

    async def test_closed_day_accepts_live_liquid_hours_that_omit_friday(self):
        forecast = app.build_interest_forecast_calendar(
            {
                "currentSessionScheduled": False,
                "liquidHours": (
                    "20260816:CLOSED;"
                    "20260817:0930-20260817:1600;"
                    "20260818:0930-20260818:1600;"
                    "20260819:0930-20260819:1600;"
                    "20260820:0930-20260820:1600;"
                    "20260821:0930-20260821:1600"
                ),
            },
            broker_time=datetime(
                2026,
                8,
                16,
                16,
                tzinfo=timezone.utc,
            ),
            prior_completed_session=date(2026, 8, 14),
        )

        self.assertTrue(forecast["eligible"])
        self.assertEqual(
            forecast["forecastKind"],
            "closed_day_remaining_window",
        )
        self.assertEqual(forecast["sessionDate"], "2026-08-16")
        self.assertEqual(forecast["basisSessionDate"], "2026-08-14")
        self.assertEqual(forecast["cashAnchorDate"], "2026-08-16")
        self.assertEqual(forecast["nextSessionDate"], "2026-08-17")
        self.assertEqual(forecast["accrualDays"], 1)

    async def test_closed_day_calendar_requires_current_and_forward_evidence(self):
        invalid_calendars = (
            {
                "currentSessionScheduled": False,
                "liquidHours": (
                    "20260725:CLOSED;"
                    "20260727:0930-20260727:1600"
                ),
            },
            {
                "currentSessionScheduled": False,
                "liquidHours": (
                    "20260726:CLOSED;"
                    "20260728:0930-20260728:1600"
                ),
            },
        )

        for market_calendar in invalid_calendars:
            with self.subTest(liquid_hours=market_calendar["liquidHours"]):
                with self.assertRaises(app.FundingEvidenceError) as raised:
                    app.build_interest_forecast_calendar(
                        market_calendar,
                        broker_time=datetime(
                            2026,
                            7,
                            26,
                            16,
                            tzinfo=timezone.utc,
                        ),
                        prior_completed_session=date(2026, 7, 24),
                    )

                self.assertEqual(
                    raised.exception.code,
                    "MARKET_SESSION_SCHEDULE_AMBIGUOUS",
                )

    async def test_weekend_observation_uses_current_closed_day_cash_anchor(self):
        cases = (
            (datetime(2026, 7, 25, 16, tzinfo=timezone.utc), 2),
            (datetime(2026, 7, 26, 16, tzinfo=timezone.utc), 1),
        )

        def verified_broker_time(value, *, observed_at=None):
            return {
                "brokerTime": value,
                "socketVerifiedAt": app.iso_timestamp(value),
                "localObservedAt": observed_at or datetime.now(timezone.utc),
                "ageSeconds": 0.0,
            }

        for gateway_time, expected_days in cases:
            with self.subTest(gateway_time=gateway_time):
                session = ObservationSession(gateway_time=gateway_time)
                with patch.object(
                    app,
                    "require_fresh_interest_broker_time",
                    side_effect=verified_broker_time,
                ):
                    response, *_mocks = await self.invoke(
                        session,
                        include_prior_in_liquid_hours=False,
                    )
                payload = json.loads(response.body)

                self.assertEqual(response.status_code, 200)
                self.assertEqual(
                    payload["forecast"]["forecastKind"],
                    "closed_day_remaining_window",
                )
                self.assertEqual(
                    payload["forecast"]["basisSessionDate"],
                    "2026-07-24",
                )
                self.assertEqual(
                    payload["forecast"]["cashAnchorDate"],
                    gateway_time.date().isoformat(),
                )
                self.assertEqual(
                    payload["forecast"]["accrualDays"],
                    expected_days,
                )
                self.assertEqual(
                    payload["market_calendar"]["cashAnchorDate"],
                    gateway_time.date().isoformat(),
                )
                self.assertEqual(
                    payload["summary"]["SettledCashByDate-S"],
                    (
                        f"{gateway_time.date() - timedelta(days=1):%Y%m%d}:40000;"
                        f"{gateway_time.date():%Y%m%d}:40500"
                    ),
                )

    async def test_closed_day_observation_rejects_unreconciled_anchor_cash(self):
        gateway_time = datetime(2026, 7, 26, 16, tzinfo=timezone.utc)
        session = ObservationSession(gateway_time=gateway_time)
        rows = account_rows(cash_anchor_date=date(2026, 7, 26))
        for row in rows:
            if row["tag"] == "SettledCashByDate-S":
                row["value"] = "20260726:40000"

        def verified_broker_time(value, *, observed_at=None):
            return {
                "brokerTime": value,
                "socketVerifiedAt": app.iso_timestamp(value),
                "localObservedAt": observed_at or datetime.now(timezone.utc),
                "ageSeconds": 0.0,
            }

        with patch.object(
            app,
            "require_fresh_interest_broker_time",
            side_effect=verified_broker_time,
        ):
            response, *_mocks = await self.invoke(
                session,
                row_snapshots=[rows, rows],
            )
        payload = json.loads(response.body)

        self.assertEqual(response.status_code, 503)
        self.assertEqual(
            payload["errorCode"],
            "FORECAST_CASH_ANCHOR_UNRECONCILED",
        )

    async def test_closed_day_accepts_current_anchor_with_future_settlement(self):
        gateway_time = datetime(2026, 7, 26, 16, tzinfo=timezone.utc)
        session = ObservationSession(gateway_time=gateway_time)
        rows = account_rows(cash_anchor_date=date(2026, 7, 26))
        for row in rows:
            if row["tag"] == "SettledCashByDate-S":
                row["value"] = "20260726:40000;20260727:40500"

        def verified_broker_time(value, *, observed_at=None):
            return {
                "brokerTime": value,
                "socketVerifiedAt": app.iso_timestamp(value),
                "localObservedAt": observed_at or datetime.now(timezone.utc),
                "ageSeconds": 0.0,
            }

        with patch.object(
            app,
            "require_fresh_interest_broker_time",
            side_effect=verified_broker_time,
        ):
            response, *_mocks = await self.invoke(
                session,
                row_snapshots=[rows, rows],
                include_prior_in_liquid_hours=False,
            )
        payload = json.loads(response.body)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            payload["forecast"]["basisSessionDate"],
            "2026-07-24",
        )
        self.assertEqual(
            payload["forecast"]["cashAnchorDate"],
            "2026-07-26",
        )
        self.assertEqual(
            payload["summary"]["SettledCashByDate-S"],
            "20260726:40000;20260727:40500",
        )

    async def test_returns_reconciled_event_scope_without_adding_events_to_shorts(self):
        session = ObservationSession()
        cash_anchor = session.gateway_time.astimezone(
            app.ZoneInfo("America/New_York")
        ).date()
        response, *_mocks = await self.invoke(
            session,
            row_snapshots=[
                mixed_account_rows(cash_anchor_date=cash_anchor),
                mixed_account_rows(cash_anchor_date=cash_anchor),
            ],
            position_snapshots=[
                event_position_snapshot(exchange="FORECASTX"),
                event_position_snapshot(exchange="FORECASTX"),
            ],
        )
        payload = json.loads(response.body)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            payload["position_scope"]["mode"],
            "stocks_and_event_contracts",
        )
        self.assertEqual(
            payload["position_scope"]["eventVenues"],
            ["FORECASTX"],
        )
        self.assertEqual(
            payload["event_accounting"]["venues"],
            ["FORECASTX"],
        )
        self.assertEqual(payload["event_accounting"]["marketValue"], 1490.0)
        self.assertEqual(
            payload["event_accounting"]["maintenanceMargin"],
            1490.0,
        )
        self.assertEqual(payload["event_accounting"]["capacityContribution"], 0.0)
        self.assertEqual(len(payload["event_position_evidence"]), 1)
        self.assertEqual(len(payload["short_positions"]), 1)
        self.assertEqual(payload["short_positions"][0]["conId"], 202)

    async def test_reconciles_each_event_mark_read_without_requiring_identical_marks(self):
        session = ObservationSession()
        cash_anchor = session.gateway_time.astimezone(
            app.ZoneInfo("America/New_York")
        ).date()
        response, *_mocks = await self.invoke(
            session,
            row_snapshots=[
                mixed_account_rows(
                    market_value=1490.0,
                    cash_anchor_date=cash_anchor,
                ),
                mixed_account_rows(
                    market_value=1491.0,
                    cash_anchor_date=cash_anchor,
                ),
            ],
            position_snapshots=[
                event_position_snapshot(),
                event_position_snapshot(),
            ],
        )
        payload = json.loads(response.body)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(payload["event_accounting"]["marketValue"], 1491.0)

    async def test_fails_closed_when_event_account_values_do_not_reconcile(self):
        session = ObservationSession()
        cash_anchor = session.gateway_time.astimezone(
            app.ZoneInfo("America/New_York")
        ).date()
        bad_rows = mixed_account_rows(cash_anchor_date=cash_anchor)
        for row in bad_rows:
            if row["tag"] == "AvailableFunds-C":
                row["value"] = "1000.02"
        response, *_mocks = await self.invoke(
            session,
            row_snapshots=[
                bad_rows,
                mixed_account_rows(cash_anchor_date=cash_anchor),
            ],
            position_snapshots=[
                event_position_snapshot(),
                event_position_snapshot(),
            ],
        )
        payload = json.loads(response.body)

        self.assertEqual(response.status_code, 503)
        self.assertEqual(
            payload["errorCode"],
            "EVENT_CONTRACT_ACCOUNTING_UNRECONCILED",
        )

    async def test_rejects_event_quantity_changes_between_position_reads(self):
        session = ObservationSession()
        cash_anchor = session.gateway_time.astimezone(
            app.ZoneInfo("America/New_York")
        ).date()
        response, *_mocks = await self.invoke(
            session,
            row_snapshots=[
                mixed_account_rows(cash_anchor_date=cash_anchor),
                mixed_account_rows(cash_anchor_date=cash_anchor),
            ],
            position_snapshots=[
                event_position_snapshot(quantity=1490.0),
                event_position_snapshot(quantity=1490.5),
            ],
        )
        payload = json.loads(response.body)

        self.assertEqual(response.status_code, 409)
        self.assertEqual(
            payload["errorCode"],
            "INTEREST_OBSERVATION_CHANGED",
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

    async def test_unconnected_observation_client_carries_the_producer_gateway_code(self):
        for health, expected in (
            ({"ok": False, "error_code": "IBKR_GATEWAY_API_UNRESPONSIVE"}, "IBKR_GATEWAY_API_UNRESPONSIVE"),
            ({"ok": False, "error_code": "IBKR_GATEWAY_NOT_AUTHENTICATED"}, "IBKR_GATEWAY_NOT_AUTHENTICATED"),
            ({"ok": False}, None),
        ):
            with self.subTest(health=health), patch.object(
                app, "ensure_funding_connected", AsyncMock(return_value=health),
            ):
                response = await app.portfolio_interest_observation("U1")
            payload = json.loads(response.body)
            self.assertEqual(response.status_code, 503)
            self.assertEqual(payload["errorCode"], "GATEWAY_UNAVAILABLE")
            self.assertEqual(payload.get("gatewayErrorCode"), expected)
            self.assertEqual("gatewayErrorCode" in payload, expected is not None)

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


class AccountExecutionEvidenceTests(unittest.TestCase):
    def execution_fill(self, commission_report):
        execution_time = datetime(2026, 9, 14, 18, 8, 36, tzinfo=timezone.utc)
        return Fill(
            Contract(
                conId=9002,
                secType="FOP",
                symbol="ES",
                tradingClass="FES",
                localSymbol="FES_091426_7625_NO",
            ),
            Execution(
                execId="E-FES-1",
                acctNumber="U123",
                side="BOT",
                shares=5000,
                price=0.14,
                time=execution_time,
            ),
            commission_report,
            execution_time,
        )

    def test_does_not_turn_an_absent_or_unmatched_commission_report_into_zero_fees(self):
        for report in (
            CommissionReport(),
            CommissionReport(execId="other-execution", commission=5, currency="USD", realizedPNL=10),
        ):
            with self.subTest(report_execution_id=report.execId):
                session = SimpleNamespace(
                    reqExecutionsAsync=AsyncMock(return_value=[self.execution_fill(report)]),
                )
                result = asyncio.run(app.request_fresh_account_execution_evidence(session, "U123"))
                row = result["rows"][0]
                self.assertEqual(row["execId"], "E-FES-1")
                self.assertNotIn("commission", row)
                self.assertNotIn("commissionCurrency", row)
                self.assertNotIn("realizedPNL", row)

    def test_keeps_matched_commission_reports_including_verified_zero(self):
        for commission, realized_pnl in ((0, 0), (50, 125)):
            with self.subTest(commission=commission):
                session = SimpleNamespace(reqExecutionsAsync=AsyncMock(return_value=[
                    self.execution_fill(CommissionReport(
                        execId="E-FES-1",
                        commission=commission,
                        currency="USD",
                        realizedPNL=realized_pnl,
                    )),
                ]))
                result = asyncio.run(app.request_fresh_account_execution_evidence(session, "U123"))
                row = result["rows"][0]
                self.assertEqual(row["commission"], commission)
                self.assertEqual(row["commissionCurrency"], "USD")
                self.assertEqual(row["realizedPNL"], realized_pnl)

    def test_repeated_execution_reads_keep_fee_evidence_pending_until_matched(self):
        session = SimpleNamespace(reqExecutionsAsync=AsyncMock(side_effect=[
            [self.execution_fill(CommissionReport())],
            [self.execution_fill(CommissionReport(
                execId="E-FES-1", commission=50, currency="USD",
            ))],
            [self.execution_fill(CommissionReport())],
        ]))

        async def run():
            return [
                await app.request_fresh_account_execution_evidence(session, "U123")
                for _ in range(3)
            ]

        pending, verified, repeated = asyncio.run(run())
        self.assertNotIn("commission", pending["rows"][0])
        self.assertEqual(verified["rows"][0]["commission"], 50)
        self.assertNotIn("commission", repeated["rows"][0])
        self.assertEqual([result["count"] for result in (pending, verified, repeated)], [1, 1, 1])


if __name__ == "__main__":
    unittest.main()
