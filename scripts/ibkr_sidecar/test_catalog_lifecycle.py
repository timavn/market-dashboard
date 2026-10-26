import asyncio
import json
import unittest
from datetime import date, datetime, timedelta, timezone
from types import SimpleNamespace

from ib_insync import Contract

import app

DEFAULT_FUNDING_SETTLEMENT_DATE = date(2026, 7, 23)
DEFAULT_FUNDING_GATEWAY_TIME = datetime(2026, 7, 23, 16, tzinfo=timezone.utc)


def funding_account_values(
    account="U1",
    *,
    include_account_ready=True,
    settlement_date=DEFAULT_FUNDING_SETTLEMENT_DATE,
):
    settlement_date_text = settlement_date.strftime("%Y%m%d")
    values = [
        ("Currency", "USD", "BASE"),
        ("NetLiquidation", "195000", "BASE"),
        ("TotalCashValue", "42000", "BASE"),
        ("TotalCashValue-S", "42000", "BASE"),
        ("TotalCashValue-C", "0", "BASE"),
        ("TotalCashValue-Z", "0", "BASE"),
        ("MaintMarginReq-C", "0", "BASE"),
        ("GrossPositionValue-S", "260000", "BASE"),
        ("GrossPositionValue", "260000", "BASE"),
        ("StockMarketValue", "90000", "BASE"),
        ("AccruedCash-S", "-12.5", "BASE"),
        ("FxCashBalance", "0", "BASE"),
        (
            "SettledCashByDate-S",
            f"{settlement_date_text}:42000",
            "BASE",
        ),
        (
            "SettledCashByDate-C",
            f"{settlement_date_text}:0",
            "BASE",
        ),
        (
            "SettledCashByDate-Z",
            f"{settlement_date_text}:0",
            "BASE",
        ),
        ("CashBalance", "42000", "USD"),
        ("CashBalance", "0", "EUR"),
    ]
    if include_account_ready:
        values.append(("AccountReady", "true", ""))
    return [
        {
            "account": account,
            "modelCode": "",
            "tag": tag,
            "value": value,
            "currency": currency,
        }
        for tag, value, currency in values
    ]


def stock_position(account, con_id, symbol, quantity, *, sec_type="STK", currency="USD"):
    return SimpleNamespace(
        account=account,
        position=quantity,
        contract=Contract(
            conId=con_id,
            symbol=symbol,
            localSymbol=symbol,
            secType=sec_type,
            exchange="SMART",
            currency=currency,
        ),
    )


class FakeFundingWrapper:
    def __init__(self):
        self.futures = {}

    def startReq(self, req_id):
        future = asyncio.get_running_loop().create_future()
        self.futures[req_id] = future
        return future

    def accountUpdateMulti(
        self,
        _req_id,
        _account,
        _model_code,
        _tag,
        _value,
        _currency,
    ):
        return None

    def accountUpdateMultiEnd(self, req_id):
        future = self.futures.pop(req_id)
        if not future.done():
            future.set_result(None)


class FakeFundingClient:
    def __init__(self, wrapper, values, call_order, value_snapshots=None):
        self.wrapper = wrapper
        self.values = values
        self.value_snapshots = value_snapshots
        self.request_count = 0
        self.call_order = call_order
        self.next_req_id = 700
        self.cancelled = []

    def getReqId(self):
        req_id = self.next_req_id
        self.next_req_id += 1
        return req_id

    def reqAccountUpdatesMulti(self, req_id, account, model_code, ledger_and_nlv):
        self.call_order.append("accountValues")
        if ledger_and_nlv:
            raise AssertionError("live funding must request the full account update set")
        rows = self.values
        if self.value_snapshots:
            rows = self.value_snapshots[
                min(self.request_count, len(self.value_snapshots) - 1)
            ]
        self.request_count += 1
        for row in rows:
            self.wrapper.accountUpdateMulti(
                req_id,
                row["account"],
                model_code,
                row["tag"],
                row["value"],
                row["currency"],
            )
        self.wrapper.accountUpdateMultiEnd(req_id)

    def cancelAccountUpdatesMulti(self, req_id):
        self.cancelled.append(req_id)


class FakeFundingIb:
    def __init__(
        self,
        *,
        values=None,
        positions=None,
        tickers=None,
        trades=None,
        accounts=None,
        connected=True,
        connect_error=None,
        ticker_hangs=False,
        historical_bars=None,
        value_snapshots=None,
        executions=None,
        execution_snapshots=None,
        gateway_time=DEFAULT_FUNDING_GATEWAY_TIME,
        liquid_hours=None,
        historical_schedule_dates=None,
        contract_details_error=None,
        historical_schedule_error=None,
    ):
        self.call_order = []
        self.wrapper = FakeFundingWrapper()
        self.client = FakeFundingClient(
            self.wrapper,
            values if values is not None else funding_account_values(),
            self.call_order,
            value_snapshots,
        )
        self._positions = positions if positions is not None else [
            stock_position("U1", 101, "SPY", 100),
            stock_position("U1", 202, "TLT", -5),
        ]
        self._tickers = tickers if tickers is not None else {
            202: SimpleNamespace(
                marketDataType=1,
                close=95.0,
                bid=94.0,
                ask=97.0,
                last=96.0,
                time=datetime.now(timezone.utc),
            ),
        }
        self._historical_bars = historical_bars or {}
        self._trades = trades if trades is not None else []
        self._executions = executions if executions is not None else []
        self._execution_snapshots = execution_snapshots
        self._gateway_time = gateway_time
        gateway_ny_date = gateway_time.astimezone(
            app.ZoneInfo("America/New_York")
        ).date()
        self._liquid_hours = liquid_hours or (
            f"{gateway_ny_date:%Y%m%d}:CLOSED"
            if gateway_ny_date.weekday() >= 5
            else (
                f"{gateway_ny_date:%Y%m%d}:"
                f"0930-{gateway_ny_date:%Y%m%d}:1600"
            )
        )
        if historical_schedule_dates is None:
            historical_schedule_dates = []
            candidate = gateway_ny_date - timedelta(days=1)
            while len(historical_schedule_dates) < 7:
                if candidate.weekday() < 5:
                    historical_schedule_dates.append(candidate)
                candidate -= timedelta(days=1)
        self._historical_schedule_dates = historical_schedule_dates
        self.contract_details_error = contract_details_error
        self.historical_schedule_error = historical_schedule_error
        self._accounts = accounts if accounts is not None else ["U1"]
        self.qualified_con_ids = []
        self.snapshot_con_ids = []
        self.qualification_request_count = 0
        self.ticker_snapshot_request_count = 0
        self.market_data_cancelled_con_ids = []
        self.historical_request_con_ids = []
        self.all_open_order_request_count = 0
        self.position_snapshot_request_count = 0
        self.execution_request_count = 0
        self.execution_filters = []
        self.contract_details_request_count = 0
        self.historical_schedule_request_count = 0
        self._connected = connected
        self.connect_error = connect_error
        self.ticker_hangs = ticker_hangs
        self.connect_calls = []
        self.disconnect_count = 0

    def isConnected(self):
        return self._connected

    async def connectAsync(
        self,
        host,
        port,
        *,
        clientId,
        timeout,
        readonly,
    ):
        self.connect_calls.append(
            {
                "host": host,
                "port": port,
                "clientId": clientId,
                "timeout": timeout,
                "readonly": readonly,
            }
        )
        if self.connect_error:
            raise self.connect_error
        self._connected = True
        return self

    def disconnect(self):
        self.disconnect_count += 1
        self._connected = False

    async def reqCurrentTimeAsync(self):
        self.call_order.append("currentTime")
        return self._gateway_time

    def managedAccounts(self):
        return self._accounts

    async def reqContractDetailsAsync(self, contract):
        self.call_order.append(f"contractDetails:{contract.conId}")
        self.contract_details_request_count += 1
        if self.contract_details_error:
            raise self.contract_details_error
        calendar_contract = Contract(
            conId=app.FUNDING_MARKET_CALENDAR_CON_ID,
            symbol="SPY",
            localSymbol="SPY",
            secType="STK",
            exchange="SMART",
            primaryExchange="ARCA",
            currency="USD",
        )
        return [
            SimpleNamespace(
                contract=calendar_contract,
                timeZoneId="US/Eastern",
                liquidHours=self._liquid_hours,
            )
        ]

    async def reqHistoricalScheduleAsync(
        self,
        contract,
        _num_days,
        *,
        endDateTime,
        useRTH,
    ):
        self.call_order.append(f"historicalSchedule:{contract.conId}")
        self.historical_schedule_request_count += 1
        if self.historical_schedule_error:
            raise self.historical_schedule_error
        if endDateTime != "" or useRTH is not True:
            raise AssertionError("funding calendar must request completed RTH sessions")
        return SimpleNamespace(
            timeZone="US/Eastern",
            sessions=[
                SimpleNamespace(refDate=value.strftime("%Y%m%d"))
                for value in self._historical_schedule_dates
            ],
        )

    def positions(self):
        raise AssertionError("live funding must not read the cached positions collection")

    async def reqPositionsAsync(self):
        self.call_order.append("positions")
        self.position_snapshot_request_count += 1
        return self._positions

    def openTrades(self):
        raise AssertionError("live funding must not read the cached openTrades collection")

    async def reqAllOpenOrdersAsync(self):
        self.call_order.append("openOrders")
        self.all_open_order_request_count += 1
        return self._trades

    async def reqExecutionsAsync(self, execution_filter):
        self.call_order.append("executions")
        self.execution_filters.append(execution_filter)
        fills = self._executions
        if self._execution_snapshots:
            fills = self._execution_snapshots[
                min(
                    self.execution_request_count,
                    len(self._execution_snapshots) - 1,
                )
            ]
        self.execution_request_count += 1
        return fills

    async def qualifyContractsAsync(self, *contracts):
        self.call_order.append("qualify")
        self.qualification_request_count += 1
        qualified = []
        for contract in contracts:
            self.qualified_con_ids.append(contract.conId)
            source = next(
                (
                    position.contract
                    for position in self._positions
                    if position.contract.conId == contract.conId
                ),
                None,
            )
            if not source:
                continue
            qualified.append(
                Contract(
                    conId=source.conId,
                    symbol=source.symbol,
                    localSymbol=source.localSymbol,
                    secType=source.secType,
                    exchange=source.exchange,
                    currency=source.currency,
                )
            )
        return qualified

    async def reqTickersAsync(self, *_contracts):
        raise AssertionError("live funding must not wait for IBKR snapshot-end events")

    def reqMktData(
        self,
        contract,
        _generic_ticks,
        _snapshot,
        _regulatory_snapshot,
    ):
        self.call_order.append(f"stream:{contract.conId}")
        self.ticker_snapshot_request_count += 1
        self.snapshot_con_ids.append(contract.conId)
        if self.ticker_hangs:
            return SimpleNamespace(
                marketDataType=0,
                close=float("nan"),
                bid=float("nan"),
                ask=float("nan"),
                last=float("nan"),
                time=None,
            )
        return self._tickers.get(contract.conId)

    def cancelMktData(self, contract):
        self.call_order.append(f"cancel:{contract.conId}")
        self.market_data_cancelled_con_ids.append(contract.conId)

    async def reqHistoricalDataAsync(self, contract, **_kwargs):
        self.call_order.append(f"history:{contract.conId}")
        self.historical_request_con_ids.append(contract.conId)
        return self._historical_bars.get(contract.conId, [])


def invoke_live_funding(fake_ib, account="U1"):
    original_funding_ib = app.funding_ib
    try:
        app.funding_ib = fake_ib
        return asyncio.run(app.portfolio_live_funding(account))
    finally:
        app.funding_ib = original_funding_ib


class CatalogLifecycleTests(unittest.TestCase):
    def setUp(self):
        # The Gateway governor is intentionally process-wide in production.
        # Unit cases must not inherit another case's circuit/backoff evidence.
        app.gateway_governor.reset()

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
            def isConnected(self):
                return True

            def __init__(self):
                self.subscription = None
                self.cancel_count = 0
                self.request_count = 0

            async def reqCurrentTimeAsync(self):
                return datetime.now(timezone.utc)

            def managedAccounts(self):
                return ["U1"]

            def cancelPnL(self, _account, _model_code):
                self.cancel_count += 1
                self.subscription = None

            def reqPnL(self, _account, _model_code):
                self.request_count += 1
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
        self.assertEqual(fake_ib.request_count, 1)
        self.assertEqual(fake_ib.cancel_count, 1)

    def test_concurrent_portfolio_pnl_callers_share_one_subscription_without_cross_cancellation(self):
        async def connected():
            return {"ok": True, "status": "connected"}

        async def verified_socket():
            return {"gatewayTime": datetime.now(timezone.utc)}

        class FakeIb:
            def __init__(self):
                self.subscription = None
                self.request_count = 0
                self.cancel_count = 0

            def managedAccounts(self):
                return ["U1"]

            def reqPnL(self, _account, _model_code):
                self.request_count += 1
                self.subscription = SimpleNamespace(
                    dailyPnL=None,
                    unrealizedPnL=None,
                    realizedPnL=None,
                )
                asyncio.get_running_loop().call_later(
                    0.05,
                    setattr,
                    self.subscription,
                    "dailyPnL",
                    42.0,
                )
                return self.subscription

            def pnl(self, _account, _model_code):
                return [self.subscription] if self.subscription else []

            def cancelPnL(self, _account, _model_code):
                self.cancel_count += 1
                self.subscription = None

        async def run_concurrently():
            app._pnl_inflight.clear()
            responses = await asyncio.gather(
                app.portfolio_pnl("U1"),
                app.portfolio_pnl("U1"),
                app.portfolio_pnl("U1"),
            )
            return [json.loads(response.body) for response in responses]

        fake_ib = FakeIb()
        original_ensure_connected = app.ensure_connected
        original_verify_primary_socket = app.verify_primary_socket
        original_ib = app.ib
        try:
            app.ensure_connected = connected
            app.verify_primary_socket = verified_socket
            app.ib = fake_ib
            payloads = asyncio.run(run_concurrently())
        finally:
            app.ensure_connected = original_ensure_connected
            app.verify_primary_socket = original_verify_primary_socket
            app.ib = original_ib
            app._pnl_inflight.clear()

        self.assertEqual(fake_ib.request_count, 1)
        self.assertEqual(fake_ib.cancel_count, 1)
        self.assertEqual([payload["pnl"]["dailyPnL"] for payload in payloads], [42.0, 42.0, 42.0])
        self.assertTrue(all(payload["source"] == "ibkr_live_session" for payload in payloads))

    def test_live_positions_verifies_socket_and_returns_basis_without_market_values(self):
        class FakeIb:
            def isConnected(self):
                return True

            async def reqCurrentTimeAsync(self):
                return datetime(2026, 7, 21, 17, 0, tzinfo=timezone.utc)

            def managedAccounts(self):
                return ["U1", "U2"]

            async def reqPositionsAsync(self):
                return [
                    SimpleNamespace(
                        account="U1",
                        position=2,
                        avgCost=0.25,
                        contract=Contract(
                            conId=101,
                            symbol="ES",
                            localSymbol="FES_082426_7700_YES",
                            secType="FOP",
                            exchange="FORECASTX",
                            currency="USD",
                            lastTradeDateOrContractMonth="20260824",
                            strike=7700,
                            right="C",
                            multiplier="1",
                            tradingClass="FES",
                        ),
                    ),
                    SimpleNamespace(
                        account="U2",
                        position=-1,
                        avgCost=88.75,
                        contract=Contract(
                            conId=202,
                            symbol="TLT",
                            localSymbol="TLT",
                            secType="STK",
                            exchange="SMART",
                            currency="USD",
                        ),
                    ),
                    SimpleNamespace(
                        account="U1",
                        position=0,
                        avgCost=0.03,
                        contract=Contract(
                            conId=303,
                            symbol="ES",
                            localSymbol="FES_082126_7750_YES",
                            secType="FOP",
                            exchange="FORECASTX",
                            currency="USD",
                            lastTradeDateOrContractMonth="20260821",
                            strike=7750,
                            right="C",
                            multiplier="1",
                            tradingClass="FES",
                        ),
                    ),
                ]

            def positions(self):
                raise AssertionError(
                    "The live-position endpoint must not read the positions cache."
                )

        async def connected():
            return {"ok": True, "status": "connected"}

        original_ib = app.ib
        original_positions_ib = app.positions_ib
        original_positions_factory = app.create_positions_snapshot_session
        original_positions_task = app.positions_snapshot_task
        original_ensure_connected = app.ensure_connected
        try:
            broker = FakeIb()
            app.ib = broker
            app.positions_ib = broker
            app.positions_snapshot_task = None
            app.create_positions_snapshot_session = lambda: broker
            app.ensure_connected = connected
            response = asyncio.run(app.portfolio_live_positions())
        finally:
            app.ib = original_ib
            app.positions_ib = original_positions_ib
            app.positions_snapshot_task = original_positions_task
            app.create_positions_snapshot_session = original_positions_factory
            app.ensure_connected = original_ensure_connected

        payload = json.loads(response.body)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(payload["source"], "ibkr_live_session")
        self.assertEqual(payload["accounts"], ["U1", "U2"])
        self.assertEqual(payload["position_count"], 2)
        self.assertEqual({row["account"] for row in payload["positions"]}, {"U1", "U2"})
        self.assertEqual(
            {row["account"]: row["avgCost"] for row in payload["positions"]},
            {"U1": 0.25, "U2": 88.75},
        )
        event_row = next(row for row in payload["positions"] if row["conId"] == 101)
        self.assertEqual(event_row["lastTradeDateOrContractMonth"], "20260824")
        self.assertEqual(event_row["strike"], 7700)
        self.assertEqual(event_row["right"], "C")
        self.assertEqual(event_row["multiplier"], "1")
        self.assertEqual(event_row["tradingClass"], "FES")
        self.assertNotIn(303, {row["conId"] for row in payload["positions"]})
        self.assertTrue(all("marketValue" not in row for row in payload["positions"]))

    def test_live_account_summary_requires_socket_round_trip_and_native_nlv(self):
        class FakeIb:
            def isConnected(self):
                return True

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

    def test_live_funding_returns_only_complete_fresh_ibkr_evidence(self):
        fake_ib = FakeFundingIb(
            trades=[
                SimpleNamespace(order=SimpleNamespace(account="U1")),
                SimpleNamespace(order=SimpleNamespace(account="U2")),
            ],
        )
        response = invoke_live_funding(fake_ib)

        payload = json.loads(response.body)
        self.assertEqual(response.status_code, 200)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["status"], "live")
        self.assertEqual(payload["source"], "ibkr_live_session")
        self.assertEqual(payload["account"], "U1")
        self.assertEqual(payload["summary"]["NetLiquidation"], 195000.0)
        self.assertEqual(payload["summary"]["TotalCashValue-S"], 42000.0)
        self.assertEqual(
            payload["summary"]["SettledCashByDate-S"],
            next(
                row["value"]
                for row in funding_account_values()
                if row["tag"] == "SettledCashByDate-S"
            ),
        )
        self.assertEqual(payload["summary"]["CashBalance"], {"EUR": 0.0, "USD": 42000.0})
        self.assertEqual(payload["summary"]["TotalCashValue-Z"], 0.0)
        self.assertEqual(
            payload["summary"]["SettledCashByDate-Z"],
            next(
                row["value"]
                for row in funding_account_values()
                if row["tag"] == "SettledCashByDate-Z"
            ),
        )
        self.assertEqual(payload["funding"]["openPositionCount"], 2)
        self.assertEqual(payload["funding"]["shortPositionCount"], 1)
        self.assertEqual(payload["funding"]["openOrderCount"], 1)
        self.assertEqual(payload["funding"]["sameDayExecutionCount"], 0)
        self.assertTrue(payload["funding"]["settledShortPositionsVerified"])
        self.assertTrue(payload["funding"]["noSameDayExecutionsVerified"])
        self.assertEqual(payload["funding"]["settlementStatus"], "settled")
        self.assertEqual(
            payload["funding"]["settlementDate"],
            DEFAULT_FUNDING_SETTLEMENT_DATE.strftime("%Y%m%d"),
        )
        self.assertEqual(
            payload["funding"]["settlementVerification"],
            "settled_segment_ledgers_double_snapshot",
        )
        self.assertEqual(payload["funding"]["shortStockPriorCloseValue"], 475.0)
        self.assertEqual(
            payload["funding"]["positionScope"],
            {"allStock": True, "allBaseCurrency": True},
        )
        self.assertEqual(
            payload["funding"]["shortPositionEvidence"][0]["currency"],
            "USD",
        )
        self.assertEqual(
            payload["funding"]["shortPositionEvidence"][0]["quantity"],
            -5.0,
        )
        self.assertEqual(
            payload["funding"]["shortPositionEvidence"][0]["priorClose"],
            95.0,
        )
        self.assertEqual(
            payload["funding"]["shortPositionEvidence"][0]["priorCloseSource"],
            "ibkr_live_tick_close",
        )
        self.assertEqual(
            payload["funding"]["shortPositionEvidence"][0]["currentPrice"],
            97.0,
        )
        self.assertEqual(
            payload["funding"]["shortPositionEvidence"][0]["currentPriceSource"],
            "ibkr_ticker_direct_max",
        )
        self.assertEqual(payload["funding"]["shortPositionEvidence"][0]["directAsk"], 97.0)
        self.assertEqual(payload["funding"]["shortPositionEvidence"][0]["directBid"], 94.0)
        self.assertEqual(payload["funding"]["shortPositionEvidence"][0]["directLast"], 96.0)
        self.assertTrue(payload["funding"]["shortPositionEvidence"][0]["snapshotTimestamp"])
        self.assertEqual(fake_ib.qualified_con_ids, [202])
        self.assertEqual(fake_ib.snapshot_con_ids, [202])
        self.assertEqual(fake_ib.qualification_request_count, 1)
        self.assertEqual(fake_ib.ticker_snapshot_request_count, 1)
        self.assertEqual(fake_ib.market_data_cancelled_con_ids, [202])
        self.assertEqual(fake_ib.historical_request_con_ids, [])
        self.assertEqual(fake_ib.all_open_order_request_count, 2)
        self.assertEqual(fake_ib.execution_request_count, 2)
        self.assertTrue(
            all(
                request.acctCode == "U1"
                for request in fake_ib.execution_filters
            )
        )
        self.assertEqual(fake_ib.position_snapshot_request_count, 2)
        self.assertEqual(fake_ib.client.cancelled, [700, 701])
        self.assertEqual(fake_ib.connect_calls, [])
        self.assertEqual(fake_ib.disconnect_count, 0)
        self.assertEqual(
            fake_ib.call_order,
            [
                "currentTime",
                "accountValues",
                "positions",
                f"contractDetails:{app.FUNDING_MARKET_CALENDAR_CON_ID}",
                "openOrders",
                "executions",
                "qualify",
                "stream:202",
                "cancel:202",
                "accountValues",
                "positions",
                "openOrders",
                "executions",
            ],
        )
        self.assertIn("short_live_quotes_ms", payload["timing"])

    def test_live_funding_connects_the_dedicated_client_read_only(self):
        fake_ib = FakeFundingIb(connected=False)

        response = invoke_live_funding(fake_ib)

        payload = json.loads(response.body)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(payload["source"], "ibkr_live_session")
        self.assertEqual(
            fake_ib.connect_calls,
            [
                {
                    "host": app.IB_HOST,
                    "port": app.IB_PORT,
                    "clientId": app.FUNDING_CLIENT_ID,
                    "timeout": app.CONNECT_TIMEOUT,
                    "readonly": True,
                }
            ],
        )
        self.assertTrue(fake_ib.isConnected())
        self.assertEqual(fake_ib.disconnect_count, 0)

    def test_live_funding_connection_failure_is_unavailable(self):
        fake_ib = FakeFundingIb(
            connected=False,
            connect_error=ConnectionRefusedError("offline"),
        )

        response = invoke_live_funding(fake_ib)

        payload = json.loads(response.body)
        self.assertEqual(response.status_code, 503)
        self.assertFalse(payload["ok"])
        self.assertFalse(payload["connected"])
        self.assertEqual(payload["errorCode"], "GATEWAY_UNAVAILABLE")
        # A refused connection is the producer's verified not-authenticated.
        self.assertEqual(payload["gatewayErrorCode"], "IBKR_GATEWAY_NOT_AUTHENTICATED")
        self.assertEqual(payload["summary"], {})
        self.assertIsNone(payload["funding"])
        self.assertEqual(fake_ib.disconnect_count, 1)
        self.assertEqual(fake_ib.position_snapshot_request_count, 0)
        self.assertEqual(fake_ib.ticker_snapshot_request_count, 0)

    def test_live_funding_quote_timeout_disconnects_and_reconnects_cleanly(self):
        fake_ib = FakeFundingIb(ticker_hangs=True)
        original_quote_timeout = app.FUNDING_QUOTE_TIMEOUT_SEC
        try:
            app.FUNDING_QUOTE_TIMEOUT_SEC = 0.01
            timed_out = invoke_live_funding(fake_ib)
        finally:
            app.FUNDING_QUOTE_TIMEOUT_SEC = original_quote_timeout

        timeout_payload = json.loads(timed_out.body)
        self.assertEqual(timed_out.status_code, 503)
        self.assertEqual(timeout_payload["errorCode"], "SHORT_SNAPSHOT_TIMEOUT")
        self.assertEqual(timeout_payload["summary"], {})
        self.assertIsNone(timeout_payload["funding"])
        self.assertFalse(fake_ib.isConnected())
        self.assertEqual(fake_ib.disconnect_count, 1)

        fake_ib.ticker_hangs = False
        recovered = invoke_live_funding(fake_ib)
        recovered_payload = json.loads(recovered.body)

        self.assertEqual(recovered.status_code, 200)
        self.assertTrue(recovered_payload["ok"])
        self.assertEqual(len(fake_ib.connect_calls), 1)
        self.assertEqual(
            fake_ib.connect_calls[0]["clientId"],
            app.FUNDING_CLIENT_ID,
        )
        self.assertTrue(fake_ib.connect_calls[0]["readonly"])

    def test_live_funding_fails_closed_when_account_is_not_ready(self):
        fake_ib = FakeFundingIb(
            values=funding_account_values(include_account_ready=False),
        )
        response = invoke_live_funding(fake_ib)

        payload = json.loads(response.body)
        self.assertEqual(response.status_code, 503)
        self.assertEqual(payload["status"], "unavailable")
        self.assertEqual(payload["source"], "unavailable")
        self.assertEqual(payload["errorCode"], "ACCOUNT_NOT_READY")
        self.assertEqual(payload["summary"], {})
        self.assertIsNone(payload["funding"])
        self.assertEqual(fake_ib.client.cancelled, [700])

    def test_live_funding_fails_closed_on_stale_short_snapshot(self):
        fake_ib = FakeFundingIb(
            tickers={
                202: SimpleNamespace(
                    marketDataType=1,
                    close=95.0,
                    bid=94.0,
                    ask=97.0,
                    last=96.0,
                    time=datetime.now(timezone.utc) - timedelta(minutes=5),
                ),
            },
        )
        original_quote_timeout = app.FUNDING_QUOTE_TIMEOUT_SEC
        try:
            app.FUNDING_QUOTE_TIMEOUT_SEC = 0.01
            response = invoke_live_funding(fake_ib)
        finally:
            app.FUNDING_QUOTE_TIMEOUT_SEC = original_quote_timeout

        payload = json.loads(response.body)
        self.assertEqual(response.status_code, 503)
        self.assertEqual(payload["errorCode"], "SHORT_SNAPSHOT_STALE")
        self.assertEqual(payload["summary"], {})
        self.assertIsNone(payload["funding"])

    def test_live_funding_fails_closed_on_delayed_short_snapshot(self):
        fake_ib = FakeFundingIb(
            tickers={
                202: SimpleNamespace(
                    marketDataType=3,
                    close=95.0,
                    bid=94.0,
                    ask=97.0,
                    last=96.0,
                    time=datetime.now(timezone.utc),
                ),
            },
        )
        original_quote_timeout = app.FUNDING_QUOTE_TIMEOUT_SEC
        try:
            app.FUNDING_QUOTE_TIMEOUT_SEC = 0.01
            response = invoke_live_funding(fake_ib)
        finally:
            app.FUNDING_QUOTE_TIMEOUT_SEC = original_quote_timeout

        payload = json.loads(response.body)
        self.assertEqual(response.status_code, 503)
        self.assertEqual(payload["errorCode"], "SHORT_SNAPSHOT_NOT_LIVE")
        self.assertEqual(payload["summary"], {})
        self.assertIsNone(payload["funding"])

    def test_live_funding_fails_closed_on_unsupported_open_position(self):
        fake_ib = FakeFundingIb(
            positions=[
                stock_position("U1", 303, "SPX", 1, sec_type="OPT"),
            ],
        )
        response = invoke_live_funding(fake_ib)

        payload = json.loads(response.body)
        self.assertEqual(response.status_code, 503)
        self.assertEqual(payload["errorCode"], "POSITION_SCOPE_UNSUPPORTED")
        self.assertEqual(payload["summary"], {})
        self.assertIsNone(payload["funding"])
        self.assertEqual(fake_ib.snapshot_con_ids, [])
        self.assertEqual(fake_ib.position_snapshot_request_count, 1)

    def test_live_funding_fails_closed_on_invalid_settled_cash_ledger(self):
        values = funding_account_values()
        for row in values:
            if row["tag"] == "SettledCashByDate-S":
                row["value"] = "41000"
        fake_ib = FakeFundingIb(values=values)
        response = invoke_live_funding(fake_ib)

        payload = json.loads(response.body)
        self.assertEqual(response.status_code, 503)
        self.assertEqual(payload["errorCode"], "ACCOUNT_VALUE_INVALID")
        self.assertEqual(payload["summary"], {})
        self.assertIsNone(payload["funding"])

    def test_live_funding_fails_closed_on_nonzero_ibukl_cash_segment(self):
        values = funding_account_values()
        for row in values:
            if row["tag"] == "SettledCashByDate-Z":
                row["value"] = "20260723:0;20260724:-1"
        fake_ib = FakeFundingIb(values=values)
        response = invoke_live_funding(fake_ib)

        payload = json.loads(response.body)
        self.assertEqual(response.status_code, 503)
        self.assertEqual(payload["errorCode"], "IBUKL_CASH_SEGMENT_UNSUPPORTED")
        self.assertEqual(payload["summary"], {})
        self.assertIsNone(payload["funding"])

    def test_live_funding_fails_closed_on_non_base_currency_cash(self):
        values = funding_account_values()
        for row in values:
            if row["tag"] == "CashBalance" and row["currency"] == "EUR":
                row["value"] = "-25"
        fake_ib = FakeFundingIb(values=values)
        response = invoke_live_funding(fake_ib)

        payload = json.loads(response.body)
        self.assertEqual(response.status_code, 503)
        self.assertEqual(payload["errorCode"], "NON_BASE_CURRENCY_CASH_UNSUPPORTED")
        self.assertEqual(payload["summary"], {})
        self.assertIsNone(payload["funding"])

    def test_live_funding_fails_closed_without_current_short_price(self):
        fake_ib = FakeFundingIb(
            tickers={
                202: SimpleNamespace(
                    marketDataType=1,
                    close=95.0,
                    bid=94.0,
                    ask=float("nan"),
                    last=96.0,
                    time=datetime.now(timezone.utc),
                ),
            },
        )
        original_quote_timeout = app.FUNDING_QUOTE_TIMEOUT_SEC
        try:
            app.FUNDING_QUOTE_TIMEOUT_SEC = 0.01
            response = invoke_live_funding(fake_ib)
        finally:
            app.FUNDING_QUOTE_TIMEOUT_SEC = original_quote_timeout

        payload = json.loads(response.body)
        self.assertEqual(response.status_code, 503)
        self.assertEqual(payload["errorCode"], "SHORT_LIVE_ASK_MISSING")
        self.assertEqual(payload["summary"], {})
        self.assertIsNone(payload["funding"])

    def test_live_funding_fails_closed_without_direct_live_bid(self):
        fake_ib = FakeFundingIb(
            tickers={
                202: SimpleNamespace(
                    marketDataType=1,
                    close=95.0,
                    bid=float("nan"),
                    ask=97.0,
                    last=96.0,
                    time=datetime.now(timezone.utc),
                ),
            },
        )
        original_quote_timeout = app.FUNDING_QUOTE_TIMEOUT_SEC
        try:
            app.FUNDING_QUOTE_TIMEOUT_SEC = 0.01
            response = invoke_live_funding(fake_ib)
        finally:
            app.FUNDING_QUOTE_TIMEOUT_SEC = original_quote_timeout

        payload = json.loads(response.body)
        self.assertEqual(response.status_code, 503)
        self.assertEqual(payload["errorCode"], "SHORT_LIVE_BID_MISSING")
        self.assertEqual(payload["summary"], {})
        self.assertIsNone(payload["funding"])
        self.assertEqual(fake_ib.market_data_cancelled_con_ids, [202])

    def test_live_funding_uses_fresh_history_only_for_missing_prior_close(self):
        ny_today = datetime.now(app.ZoneInfo("America/New_York")).date()
        prior_date = ny_today - timedelta(days=1)
        fake_ib = FakeFundingIb(
            tickers={
                202: SimpleNamespace(
                    marketDataType=1,
                    close=float("nan"),
                    bid=94.0,
                    ask=97.0,
                    last=96.0,
                    time=datetime.now(timezone.utc),
                ),
            },
            historical_bars={
                202: [
                    SimpleNamespace(date=prior_date, close=94.5),
                    SimpleNamespace(date=ny_today, close=999.0),
                ],
            },
        )

        response = invoke_live_funding(fake_ib)

        payload = json.loads(response.body)
        evidence = payload["funding"]["shortPositionEvidence"][0]
        self.assertEqual(response.status_code, 200)
        self.assertEqual(evidence["priorClose"], 94.5)
        self.assertEqual(
            evidence["priorCloseSource"],
            "ibkr_historical_daily_close",
        )
        self.assertEqual(evidence["priorCloseSessionDate"], prior_date.isoformat())
        self.assertTrue(evidence["priorCloseObservedAt"])
        self.assertEqual(evidence["currentPrice"], 97.0)
        self.assertEqual(fake_ib.historical_request_con_ids, [202])
        self.assertLess(
            fake_ib.call_order.index("cancel:202"),
            fake_ib.call_order.index("history:202"),
        )

    def test_live_funding_returns_a_non_actionable_weekend_reference(self):
        weekend_gateway_times = (
            datetime(2026, 7, 25, 16, tzinfo=timezone.utc),
            datetime(2026, 7, 26, 16, tzinfo=timezone.utc),
        )
        friday = date(2026, 7, 24)
        for gateway_time in weekend_gateway_times:
            with self.subTest(gateway_time=gateway_time):
                settlement_date = gateway_time.astimezone(
                    app.ZoneInfo("America/New_York")
                ).date()
                fake_ib = FakeFundingIb(
                    values=funding_account_values(
                        settlement_date=settlement_date,
                    ),
                    gateway_time=gateway_time,
                    historical_bars={
                        202: [
                            SimpleNamespace(date=friday, close=94.5),
                            SimpleNamespace(date=settlement_date, close=999.0),
                        ],
                    },
                )

                response = invoke_live_funding(fake_ib)
                payload = json.loads(response.body)

                self.assertEqual(response.status_code, 200)
                self.assertTrue(payload["ok"])
                self.assertEqual(payload["status"], "reference")
                self.assertEqual(
                    payload["source"],
                    "ibkr_completed_session_reference",
                )
                self.assertIsNone(payload["funding"])
                reference = payload["fundingReference"]
                self.assertTrue(reference["referenceOnly"])
                self.assertFalse(reference["actionable"])
                self.assertEqual(
                    reference["referenceSessionDate"],
                    friday.isoformat(),
                )
                self.assertEqual(
                    reference["cashLedgerObservedDate"],
                    settlement_date.isoformat(),
                )
                self.assertEqual(
                    reference["shortPositionReferenceEvidence"][0][
                        "referenceClose"
                    ],
                    94.5,
                )
                self.assertNotIn(
                    "currentPrice",
                    reference["shortPositionReferenceEvidence"][0],
                )
                self.assertEqual(fake_ib.client.request_count, 2)
                self.assertEqual(fake_ib.snapshot_con_ids, [])
                self.assertEqual(fake_ib.historical_request_con_ids, [202])

    def test_live_funding_returns_reference_on_a_weekday_market_holiday(self):
        holiday = date(2026, 7, 3)
        prior_session = date(2026, 7, 2)
        fake_ib = FakeFundingIb(
            values=funding_account_values(settlement_date=holiday),
            gateway_time=datetime(2026, 7, 3, 16, tzinfo=timezone.utc),
            liquid_hours="20260703:CLOSED;20260706:0930-20260706:1600",
            historical_schedule_dates=[prior_session, date(2026, 7, 1)],
            historical_bars={
                202: [SimpleNamespace(date=prior_session, close=94.5)],
            },
        )

        response = invoke_live_funding(fake_ib)
        payload = json.loads(response.body)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(payload["status"], "reference")
        self.assertEqual(
            payload["fundingReference"]["referenceSessionDate"],
            prior_session.isoformat(),
        )
        self.assertEqual(
            payload["fundingReference"]["shortPositionReferenceEvidence"][0][
                "referenceCloseSessionDate"
            ],
            prior_session.isoformat(),
        )
        self.assertEqual(fake_ib.contract_details_request_count, 1)
        self.assertEqual(fake_ib.historical_schedule_request_count, 1)
        self.assertEqual(fake_ib.snapshot_con_ids, [])

    def test_weekend_after_friday_holiday_uses_broker_session_for_no_shorts(self):
        saturday = date(2026, 7, 4)
        prior_session = date(2026, 7, 2)
        fake_ib = FakeFundingIb(
            values=funding_account_values(settlement_date=saturday),
            positions=[stock_position("U1", 101, "SPY", 100)],
            gateway_time=datetime(2026, 7, 4, 16, tzinfo=timezone.utc),
            historical_schedule_dates=[prior_session, date(2026, 7, 1)],
        )

        response = invoke_live_funding(fake_ib)
        payload = json.loads(response.body)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(payload["status"], "reference")
        reference = payload["fundingReference"]
        self.assertEqual(
            reference["referenceSessionDate"],
            prior_session.isoformat(),
        )
        self.assertEqual(reference["shortPositionCount"], 0)
        self.assertEqual(reference["shortPositionReferenceEvidence"], [])
        self.assertEqual(fake_ib.historical_request_con_ids, [])
        self.assertEqual(fake_ib.snapshot_con_ids, [])

    def test_normal_weekday_preopen_calendar_remains_live(self):
        settlement_date = date(2026, 7, 23)
        fake_ib = FakeFundingIb(
            values=funding_account_values(settlement_date=settlement_date),
            gateway_time=datetime(2026, 7, 23, 12, tzinfo=timezone.utc),
            liquid_hours="20260723:0930-20260723:1600",
        )

        response = invoke_live_funding(fake_ib)
        payload = json.loads(response.body)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(payload["status"], "live")
        self.assertEqual(fake_ib.contract_details_request_count, 1)
        self.assertEqual(fake_ib.historical_schedule_request_count, 0)

    def test_live_funding_fails_closed_on_invalid_market_calendar(self):
        fake_ib = FakeFundingIb(
            liquid_hours="20260723:NOT_A_SESSION",
        )

        response = invoke_live_funding(fake_ib)
        payload = json.loads(response.body)

        self.assertEqual(response.status_code, 503)
        self.assertEqual(
            payload["errorCode"],
            "MARKET_SESSION_SCHEDULE_INVALID",
        )
        self.assertIsNone(payload["funding"])
        self.assertEqual(fake_ib.snapshot_con_ids, [])

    def test_reference_fails_closed_when_short_close_misses_verified_session(self):
        saturday = date(2026, 7, 25)
        verified_session = date(2026, 7, 24)
        fake_ib = FakeFundingIb(
            values=funding_account_values(settlement_date=saturday),
            gateway_time=datetime(2026, 7, 25, 16, tzinfo=timezone.utc),
            historical_schedule_dates=[verified_session],
            historical_bars={
                202: [
                    SimpleNamespace(
                        date=verified_session - timedelta(days=1),
                        close=94.5,
                    )
                ],
            },
        )

        response = invoke_live_funding(fake_ib)
        payload = json.loads(response.body)

        self.assertEqual(response.status_code, 503)
        self.assertEqual(
            payload["errorCode"],
            "SHORT_REFERENCE_SESSION_MISMATCH",
        )
        self.assertIsNone(payload["funding"])
        self.assertEqual(fake_ib.snapshot_con_ids, [])

    def test_live_funding_accepts_saturday_reference_with_friday_ledger(self):
        friday = date(2026, 7, 24)
        fake_ib = FakeFundingIb(
            values=funding_account_values(settlement_date=friday),
            gateway_time=datetime(2026, 7, 25, 16, tzinfo=timezone.utc),
            historical_bars={
                202: [SimpleNamespace(date=friday, close=94.5)],
            },
        )

        response = invoke_live_funding(fake_ib)
        payload = json.loads(response.body)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(payload["status"], "reference")
        self.assertEqual(
            payload["fundingReference"]["settlementHorizonDate"],
            friday.isoformat(),
        )
        self.assertEqual(fake_ib.client.request_count, 2)
        self.assertEqual(fake_ib.snapshot_con_ids, [])

    def test_weekend_reference_keeps_future_settlement_and_uses_the_full_ladder(self):
        saturday = date(2026, 7, 25)
        monday = date(2026, 7, 27)
        friday = date(2026, 7, 24)
        values = funding_account_values(settlement_date=saturday)
        for row in values:
            if row["tag"] == "SettledCashByDate-S":
                row["value"] = (
                    f"{saturday:%Y%m%d}:41000;"
                    f"{monday:%Y%m%d}:42000"
                )
        fake_ib = FakeFundingIb(
            values=values,
            gateway_time=datetime(2026, 7, 25, 16, tzinfo=timezone.utc),
            historical_bars={
                202: [SimpleNamespace(date=friday, close=94.5)],
            },
        )

        response = invoke_live_funding(fake_ib)
        payload = json.loads(response.body)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(payload["status"], "reference")
        self.assertEqual(
            payload["summary"]["SettledCashByDate-S"],
            "20260725:41000;20260727:42000",
        )
        self.assertEqual(
            payload["fundingReference"]["settlementHorizonDate"],
            monday.isoformat(),
        )
        self.assertEqual(fake_ib.snapshot_con_ids, [])

    def test_live_funding_accepts_friday_current_ledger(self):
        friday = date(2026, 7, 24)
        fake_ib = FakeFundingIb(
            values=funding_account_values(settlement_date=friday),
            gateway_time=datetime(2026, 7, 24, 16, tzinfo=timezone.utc),
        )

        response = invoke_live_funding(fake_ib)
        payload = json.loads(response.body)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(payload["funding"]["settlementDate"], "20260724")

    def test_live_funding_rejects_future_or_unreconciled_settlement_ledger(self):
        current_date = DEFAULT_FUNDING_SETTLEMENT_DATE
        future_date = current_date + timedelta(days=1)

        cases = (
            (
                "SettledCashByDate-S",
                f"{current_date:%Y%m%d}:42000;{future_date:%Y%m%d}:41000",
            ),
            ("SettledCashByDate-S", f"{current_date:%Y%m%d}:41999"),
            (
                "SettledCashByDate-C",
                f"{current_date:%Y%m%d}:0;{future_date:%Y%m%d}:-100",
            ),
            ("SettledCashByDate-C", f"{current_date:%Y%m%d}:-1"),
        )
        for ledger_tag, ledger in cases:
            with self.subTest(ledger_tag=ledger_tag, ledger=ledger):
                values = funding_account_values()
                for row in values:
                    if row["tag"] == ledger_tag:
                        row["value"] = ledger
                fake_ib = FakeFundingIb(values=values)

                response = invoke_live_funding(fake_ib)
                payload = json.loads(response.body)

                self.assertEqual(response.status_code, 503)
                self.assertEqual(
                    payload["errorCode"],
                    "UNSETTLED_SECURITIES_ACTIVITY",
                )
                self.assertEqual(payload["summary"], {})
                self.assertIsNone(payload["funding"])
                self.assertEqual(fake_ib.snapshot_con_ids, [])

    def test_live_funding_requires_commodities_settlement_ledger(self):
        values = [
            row
            for row in funding_account_values()
            if row["tag"] != "SettledCashByDate-C"
        ]
        fake_ib = FakeFundingIb(values=values)

        response = invoke_live_funding(fake_ib)
        payload = json.loads(response.body)

        self.assertEqual(response.status_code, 503)
        self.assertEqual(payload["errorCode"], "ACCOUNT_VALUE_MISSING")
        self.assertEqual(payload["summary"], {})
        self.assertIsNone(payload["funding"])

    def test_live_funding_requires_explicit_zero_ibukl_fields(self):
        for missing_tag in ("TotalCashValue-Z", "SettledCashByDate-Z"):
            with self.subTest(missing_tag=missing_tag):
                values = [
                    row
                    for row in funding_account_values()
                    if row["tag"] != missing_tag
                ]
                fake_ib = FakeFundingIb(values=values)

                response = invoke_live_funding(fake_ib)
                payload = json.loads(response.body)

                self.assertEqual(response.status_code, 503)
                self.assertEqual(payload["errorCode"], "ACCOUNT_VALUE_MISSING")
                self.assertEqual(payload["summary"], {})
                self.assertIsNone(payload["funding"])

    def test_live_funding_accepts_a_proven_absent_z_segment(self):
        values = [
            row
            for row in funding_account_values()
            if row["tag"] not in {"TotalCashValue-Z", "SettledCashByDate-Z"}
        ]
        fake_ib = FakeFundingIb(values=values)

        response = invoke_live_funding(fake_ib)
        payload = json.loads(response.body)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(payload["summary"]["TotalCashValue-Z"], 0.0)
        self.assertEqual(
            payload["summary"]["cashSegmentZVerification"],
            "absent_reconciled_zero",
        )

    def test_live_funding_rejects_an_unreconciled_absent_z_segment(self):
        values = [
            row
            for row in funding_account_values()
            if row["tag"] not in {"TotalCashValue-Z", "SettledCashByDate-Z"}
        ]
        for row in values:
            if row["tag"] == "TotalCashValue":
                row["value"] = "42001"
        fake_ib = FakeFundingIb(values=values)

        response = invoke_live_funding(fake_ib)
        payload = json.loads(response.body)

        self.assertEqual(response.status_code, 503)
        self.assertEqual(
            payload["errorCode"],
            "CASH_SEGMENT_RECONCILIATION_FAILED",
        )

    def test_live_funding_rejects_a_named_z_segment_without_cash_evidence(self):
        values = [
            row
            for row in funding_account_values()
            if row["tag"] not in {"TotalCashValue-Z", "SettledCashByDate-Z"}
        ]
        values.append(
            {
                "account": "U1",
                "modelCode": "",
                "tag": "SegmentTitle-Z",
                "value": "Crypto",
                "currency": "",
            }
        )
        fake_ib = FakeFundingIb(values=values)

        response = invoke_live_funding(fake_ib)
        payload = json.loads(response.body)

        self.assertEqual(response.status_code, 503)
        self.assertEqual(payload["errorCode"], "ACCOUNT_VALUE_MISSING")

    def test_live_funding_rejects_nonzero_or_missing_fx_cash_balance(self):
        cases = {
            "nonzero": "1",
            "missing": None,
        }
        for case, replacement in cases.items():
            with self.subTest(case=case):
                values = funding_account_values()
                if replacement is None:
                    values = [
                        row
                        for row in values
                        if row["tag"] != "FxCashBalance"
                    ]
                else:
                    for row in values:
                        if row["tag"] == "FxCashBalance":
                            row["value"] = replacement
                fake_ib = FakeFundingIb(values=values)

                response = invoke_live_funding(fake_ib)
                payload = json.loads(response.body)

                self.assertEqual(response.status_code, 503)
                self.assertIn(
                    payload["errorCode"],
                    {
                        "IBUKL_CASH_SEGMENT_UNSUPPORTED",
                        "ACCOUNT_VALUE_MISSING",
                    },
                )

    def test_live_funding_never_reinterprets_foreign_account_values_as_base(self):
        for tag in ("TotalCashValue-S", "SettledCashByDate-S"):
            with self.subTest(tag=tag):
                values = funding_account_values()
                for row in values:
                    if row["tag"] == tag:
                        row["currency"] = "EUR"
                fake_ib = FakeFundingIb(values=values)

                response = invoke_live_funding(fake_ib)
                payload = json.loads(response.body)

                self.assertEqual(response.status_code, 503)
                self.assertEqual(
                    payload["errorCode"],
                    "ACCOUNT_VALUE_CURRENCY_MISMATCH",
                )
                self.assertEqual(payload["summary"], {})
                self.assertIsNone(payload["funding"])

    def test_live_funding_rejects_ledger_change_during_double_snapshot(self):
        first = funding_account_values()
        second = funding_account_values()
        current_date = DEFAULT_FUNDING_SETTLEMENT_DATE.strftime("%Y%m%d")
        for row in second:
            if row["tag"] == "TotalCashValue":
                row["value"] = "42001"
            if row["tag"] == "TotalCashValue-S":
                row["value"] = "42001"
            if row["tag"] == "SettledCashByDate-S":
                row["value"] = f"{current_date}:42001"
        fake_ib = FakeFundingIb(value_snapshots=[first, second])

        response = invoke_live_funding(fake_ib)

        payload = json.loads(response.body)
        self.assertEqual(response.status_code, 503)
        self.assertEqual(payload["errorCode"], "UNSETTLED_SECURITIES_ACTIVITY")
        self.assertEqual(payload["summary"], {})
        self.assertIsNone(payload["funding"])
        self.assertEqual(fake_ib.client.cancelled, [700, 701])
        self.assertEqual(fake_ib.market_data_cancelled_con_ids, [202])

    def test_live_funding_rejects_any_same_day_account_execution(self):
        fill = SimpleNamespace(
            execution=SimpleNamespace(
                acctNumber="U1",
                execId="exec-1",
            ),
        )
        fake_ib = FakeFundingIb(executions=[fill])

        response = invoke_live_funding(fake_ib)

        payload = json.loads(response.body)
        self.assertEqual(response.status_code, 503)
        self.assertEqual(payload["errorCode"], "UNSETTLED_SECURITIES_ACTIVITY")
        self.assertEqual(payload["summary"], {})
        self.assertIsNone(payload["funding"])
        self.assertEqual(fake_ib.execution_request_count, 1)
        self.assertEqual(fake_ib.snapshot_con_ids, [])

    def test_live_funding_rejects_malformed_or_cross_account_executions(self):
        cases = (
            ("", "EXECUTION_ACCOUNT_MISSING"),
            ("U2", "EXECUTION_ACCOUNT_MISMATCH"),
        )
        for execution_account, expected_code in cases:
            with self.subTest(execution_account=execution_account):
                fill = SimpleNamespace(
                    execution=SimpleNamespace(
                        acctNumber=execution_account,
                        execId="exec-1",
                    ),
                )
                fake_ib = FakeFundingIb(executions=[fill])

                response = invoke_live_funding(fake_ib)
                payload = json.loads(response.body)

                self.assertEqual(response.status_code, 503)
                self.assertEqual(payload["errorCode"], expected_code)
                self.assertEqual(payload["summary"], {})
                self.assertIsNone(payload["funding"])

    def test_live_funding_rejects_execution_appearing_during_double_read(self):
        fill = SimpleNamespace(
            execution=SimpleNamespace(
                acctNumber="U1",
                execId="exec-late",
            ),
        )
        fake_ib = FakeFundingIb(execution_snapshots=[[], [fill]])

        response = invoke_live_funding(fake_ib)

        payload = json.loads(response.body)
        self.assertEqual(response.status_code, 503)
        self.assertEqual(payload["errorCode"], "UNSETTLED_SECURITIES_ACTIVITY")
        self.assertEqual(payload["summary"], {})
        self.assertIsNone(payload["funding"])
        self.assertEqual(fake_ib.execution_request_count, 2)
        self.assertEqual(fake_ib.market_data_cancelled_con_ids, [202])

    def test_live_funding_rejects_concurrent_requests_without_queueing(self):
        fake_ib = FakeFundingIb()
        original_funding_ib = app.funding_ib

        async def invoke_while_locked():
            app.funding_ib = fake_ib
            try:
                async with app.funding_snapshot_lock:
                    return await app.portfolio_live_funding("U1")
            finally:
                app.funding_ib = original_funding_ib

        response = asyncio.run(invoke_while_locked())

        payload = json.loads(response.body)
        self.assertEqual(response.status_code, 503)
        self.assertEqual(payload["errorCode"], "FUNDING_SNAPSHOT_BUSY")
        self.assertEqual(payload["summary"], {})
        self.assertIsNone(payload["funding"])
        self.assertEqual(fake_ib.call_order, [])


if __name__ == "__main__":
    unittest.main()
