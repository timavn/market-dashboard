import asyncio
import json
import unittest
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace

from ib_insync import Contract

import app

DEFAULT_FUNDING_SETTLEMENT_DATE = date(2026, 7, 23)
DEFAULT_FUNDING_GATEWAY_TIME = datetime(2026, 7, 23, 16, tzinfo=timezone.utc)


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


def monitor_request(
    catalog_contracts=None,
    *,
    market_id="nasdaq100",
    product_code="FNQ",
    generation_key="FNQ_123199",
    event_prefix=None,
    close_time="2099-12-31T20:00:00Z",
    target_strikes=None,
):
    return app.DiscoveryRequest(
        monitor=app.PredictionMonitorContext(
            marketId=market_id,
            productCode=product_code,
            generationKey=generation_key,
            eventPrefix=event_prefix or generation_key,
            closeTime=close_time,
            targetStrikes=target_strikes or [28000],
        ),
        catalogContracts=catalog_contracts or [],
    )


def monitor_seed(
    con_id,
    local_symbol="FNQ_123199_28000_YES",
    *,
    product_code="FNQ",
    generation_key="FNQ_123199",
    strike=28000,
    expiry="20991231",
):
    quote_side = "NO" if local_symbol.upper().endswith("_NO") else "YES"
    public_contract_id = local_symbol
    if public_contract_id.upper().endswith(("_YES", "_NO")):
        public_contract_id = public_contract_id.rsplit("_", 1)[0]
    return {
        **authoritative_seed(con_id, local_symbol, expiry),
        "productCode": product_code,
        "publicContractId": public_contract_id,
        "contractId": public_contract_id,
        "releaseKey": generation_key,
        "underlying": product_code,
        "symbol": product_code,
        "tradingClass": product_code,
        "strike": strike,
        "right": "P" if quote_side == "NO" else "C",
        "quote_side": quote_side,
    }


def authoritative_seed(con_id, local_symbol, expiry="20991231"):
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

    def test_prediction_monitor_context_requires_exact_current_market_product_and_close_date(self):
        for market_id, product_code in app.PREDICTION_MONITOR_PRODUCTS.items():
            if market_id == "gdp":
                # GDP has quarter-based identities; covered in test_rgdp_contracts.
                continue
            with self.subTest(market_id=market_id):
                request = monitor_request(
                    market_id=market_id,
                    product_code=product_code,
                    generation_key=f"{product_code}_123199",
                )
                self.assertEqual(app.request_release_key(request), f"{product_code}_123199")

        chicago_boundary = monitor_request(
            generation_key="FNQ_123199",
            close_time="2100-01-01T01:00:00Z",
        )
        self.assertEqual(app.request_release_key(chicago_boundary), "FNQ_123199")

        invalid_requests = (
            monitor_request(market_id="nasdaq100", product_code="FES", generation_key="FES_123199"),
            monitor_request(generation_key="FNQ_123099", close_time="2099-12-31T20:00:00Z"),
            monitor_request(generation_key="FNQ_123199", event_prefix="FNQ_123099"),
            monitor_request(generation_key="FNQ_010120", close_time="2020-01-01T20:00:00Z"),
        )
        self.assertTrue(all(app.request_release_key(request) is None for request in invalid_requests))

    def test_prediction_monitor_catalog_rejects_relabelled_generation_product_strike_and_expiry(self):
        request = monitor_request()
        current = monitor_seed(101)
        wrong_generation = monitor_seed(102, "FNQ_123099_28000_YES")
        wrong_product = monitor_seed(103, product_code="FES")
        wrong_strike = monitor_seed(104, "FNQ_123199_28100_YES", strike=28100)
        expired = monitor_seed(105, expiry="20200101")

        active, retired = app.partition_catalog_for_release(
            [current, wrong_generation, wrong_product, wrong_strike, expired],
            request,
        )

        self.assertEqual([seed["conId"] for seed in active], [101])
        self.assertEqual(
            {seed["retired_reason"] for seed in retired},
            {"wrong_generation", "wrong_product", "wrong_strike", "expired_contract"},
        )

    def test_prediction_monitor_discovery_returns_only_exact_native_product_generation_and_strike(self):
        contracts = [
            Contract(
                conId=201,
                symbol="NQ",
                secType="FOP",
                exchange="FORECASTX",
                currency="USD",
                localSymbol="FNQ_123199_28000_YES",
                tradingClass="FNQ",
                lastTradeDateOrContractMonth="20991231",
                strike=28000,
                right="C",
            ),
            Contract(
                conId=202,
                symbol="NQ",
                secType="FOP",
                exchange="FORECASTX",
                currency="USD",
                localSymbol="FNQ_123099_28000_YES",
                tradingClass="FNQ",
                lastTradeDateOrContractMonth="20991231",
                strike=28000,
                right="C",
            ),
            Contract(
                conId=203,
                symbol="FES",
                secType="OPT",
                exchange="FORECASTX",
                currency="USD",
                localSymbol="FNQ_123199_28000_YES",
                tradingClass="FES",
                lastTradeDateOrContractMonth="20991231",
                strike=28000,
                right="C",
            ),
            Contract(
                conId=204,
                symbol="NQ",
                secType="FOP",
                exchange="FORECASTX",
                currency="USD",
                localSymbol="FNQ_123199_28100_YES",
                tradingClass="FNQ",
                lastTradeDateOrContractMonth="20991231",
                strike=28100,
                right="C",
            ),
        ]

        class FakeIb:
            async def reqContractDetailsAsync(self, query):
                self.query = query
                return [SimpleNamespace(contract=contract) for contract in contracts]

        fake_ib = FakeIb()
        original_ib = app.ib
        try:
            app.ib = fake_ib
            discovered = asyncio.run(app.discover_event_contract_seeds(request=monitor_request()))
        finally:
            app.ib = original_ib

        self.assertEqual(fake_ib.query.symbol, "NQ")
        self.assertEqual(fake_ib.query.secType, "FOP")
        self.assertEqual(fake_ib.query.exchange, "FORECASTX")
        self.assertEqual([seed["conId"] for seed in discovered], [201])
        self.assertTrue(all(seed["releaseKey"] == "FNQ_123199" for seed in discovered))

    def test_prediction_monitor_qualifies_exact_public_yes_and_no_contracts_without_local_symbol_discovery(self):
        public_contracts = []
        for right, side in (("C", "YES"), ("P", "NO")):
            public_contracts.append({
                "publicContractId": f"FNQ_123199_28000_{side}",
                "contractId": f"FNQ_123199_28000_{side}",
                "releaseKey": "FNQ_123199",
                "productCode": "FNQ",
                "symbol": "NQ",
                "underlying": "NQ",
                "secType": "FOP",
                "exchange": "FORECASTX",
                "currency": "USD",
                "tradingClass": "FNQ",
                "lastTradeDateOrContractMonth": "20991231",
                "strike": 28000,
                "right": right,
                "quote_side": side,
            })

        class FakeIb:
            def __init__(self):
                self.requests = []

            async def qualifyContractsAsync(self, requested):
                self.requests.append(requested)
                con_id = 301 if requested.right == "C" else 302
                return [Contract(
                    conId=con_id,
                    symbol=requested.symbol,
                    secType=requested.secType,
                    exchange=requested.exchange,
                    currency=requested.currency,
                    localSymbol=f"IBKR-CONID-{con_id}",
                    tradingClass=requested.tradingClass,
                    lastTradeDateOrContractMonth=requested.lastTradeDateOrContractMonth,
                    strike=requested.strike,
                    right=requested.right,
                )]

        public_contracts.append({**public_contracts[0], "symbol": "FNQ", "underlying": "FNQ", "secType": "OPT"})
        fake_ib = FakeIb()
        original_ib = app.ib
        try:
            app.ib = fake_ib
            qualified = asyncio.run(app.qualify_forecastx_public_contracts(
                monitor_request(catalog_contracts=public_contracts),
            ))
        finally:
            app.ib = original_ib

        self.assertEqual(len(fake_ib.requests), 2)
        self.assertEqual({seed["conId"] for seed in qualified}, {301, 302})
        self.assertEqual({seed["quote_side"] for seed in qualified}, {"YES", "NO"})
        self.assertEqual(
            {seed["publicContractId"] for seed in qualified},
            {"FNQ_123199_28000_YES", "FNQ_123199_28000_NO"},
        )
        self.assertTrue(all(request.secType == "FOP" for request in fake_ib.requests))
        self.assertTrue(all(request.symbol == "NQ" for request in fake_ib.requests))
        self.assertTrue(all(request.exchange == "FORECASTX" for request in fake_ib.requests))
        self.assertTrue(all(not request.localSymbol for request in fake_ib.requests))

    def test_fes_qualifies_distinct_yes_no_es_futures_options_and_rejects_legacy_opt_shape(self):
        public_contracts = []
        for right, side in (("C", "YES"), ("P", "NO")):
            public_contracts.append({
                "publicContractId": "FES_123199_7600",
                "contractId": "FES_123199_7600",
                "releaseKey": "FES_123199",
                "productCode": "FES",
                "symbol": "ES",
                "underlying": "ES",
                "secType": "FOP",
                "exchange": "FORECASTX",
                "currency": "USD",
                "tradingClass": "FES",
                "lastTradeDateOrContractMonth": "20991231",
                "strike": 7600,
                "right": right,
                "quote_side": side,
            })
        public_contracts.append({
            **public_contracts[0],
            "publicContractId": "FES_123199_7625",
            "contractId": "FES_123199_7625",
            "symbol": "FES",
            "underlying": "FES",
            "secType": "OPT",
            "strike": 7625,
        })

        class FakeIb:
            def __init__(self):
                self.requests = []

            async def qualifyContractsAsync(self, requested):
                self.requests.append(requested)
                con_id = 401 if requested.right == "C" else 402
                return [Contract(
                    conId=con_id,
                    symbol=requested.symbol,
                    secType=requested.secType,
                    exchange=requested.exchange,
                    currency=requested.currency,
                    localSymbol=f"FES_123199_7600_{'YES' if requested.right == 'C' else 'NO'}",
                    tradingClass=requested.tradingClass,
                    lastTradeDateOrContractMonth=requested.lastTradeDateOrContractMonth,
                    strike=requested.strike,
                    right=requested.right,
                )]

        request = monitor_request(
            catalog_contracts=public_contracts,
            market_id="sp500",
            product_code="FES",
            generation_key="FES_123199",
            target_strikes=[7600, 7625],
        )
        fake_ib = FakeIb()
        original_ib = app.ib
        try:
            app.ib = fake_ib
            qualified = asyncio.run(app.qualify_forecastx_public_contracts(request))
        finally:
            app.ib = original_ib

        self.assertEqual(app.monitor_broker_identity("FES"), {
            "productCode": "FES",
            "symbol": "ES",
            "secType": "FOP",
            "exchange": "FORECASTX",
            "currency": "USD",
            "tradingClass": "FES",
        })
        self.assertEqual({seed["conId"] for seed in qualified}, {401, 402})
        self.assertEqual({seed["quote_side"] for seed in qualified}, {"YES", "NO"})
        self.assertTrue(all(
            seed["quote_wait_sec"] == app.PREDICTION_REFRESH_QUOTE_WAIT_SEC
            for seed in qualified
        ))
        self.assertTrue(all(seed["productCode"] == "FES" for seed in qualified))
        self.assertTrue(all(seed["symbol"] == "ES" for seed in qualified))
        self.assertTrue(all(seed["secType"] == "FOP" for seed in qualified))
        self.assertEqual(len(fake_ib.requests), 2)
        self.assertTrue(all(contract.symbol == "ES" for contract in fake_ib.requests))
        self.assertTrue(all(contract.secType == "FOP" for contract in fake_ib.requests))
        self.assertTrue(all(contract.tradingClass == "FES" for contract in fake_ib.requests))

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
                    bidSize=10,
                    askSize=12,
                    last=0.42,
                    volume=12,
                    marketDataType=1,
                    time=datetime.now(timezone.utc),
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
        self.assertEqual(payload["events"][0]["native_bid_size"], 10)
        self.assertEqual(payload["events"][0]["dataType"], 1)
        self.assertTrue(payload["events"][0]["exchange_timestamp"].endswith("Z"))

    def test_forced_refresh_retries_only_an_unverified_prediction_book(self):
        async def connected():
            return {"ok": True, "status": "connected"}

        class RetryIb:
            def __init__(self):
                self.snapshot_flags = []

            async def qualifyContractsAsync(self, contract):
                return [contract]

            def reqMktData(self, contract, _fields, snapshot, _regulatory_snapshot):
                self.snapshot_flags.append(snapshot)
                valid = len(self.snapshot_flags) == 2
                return SimpleNamespace(
                    contract=contract,
                    bid=0.41 if valid else -1,
                    ask=0.43 if valid else -1,
                    bidSize=10 if valid else 0,
                    askSize=12 if valid else 0,
                    last=0.42 if valid else -1,
                    volume=12,
                    marketDataType=1,
                    time=datetime.now(timezone.utc),
                )

            def cancelMktData(self, _contract):
                return None

        seed = authoritative_seed(63, "IB-CPI-26JUL-T3.3-YES")
        seed["quote_wait_sec"] = 0
        request = july_request([seed])
        request.forceRefresh = True
        request.retryMissing = True
        fake_ib = RetryIb()
        original_ensure_connected = app.ensure_connected
        original_ib = app.ib
        try:
            app.ensure_connected = connected
            app.ib = fake_ib
            response = asyncio.run(app.refresh(request))
        finally:
            app.ensure_connected = original_ensure_connected
            app.ib = original_ib

        payload = json.loads(response.body)
        evidence = payload["refreshEvidence"]
        self.assertTrue(payload["ok"])
        self.assertEqual(fake_ib.snapshot_flags, [True, True])
        self.assertEqual(evidence["requestedContractCount"], 1)
        self.assertEqual(evidence["initialVerifiedContractCount"], 0)
        self.assertEqual(evidence["brokerSnapshotRequestedCount"], 1)
        self.assertEqual(evidence["brokerSnapshotRetryCount"], 1)
        self.assertEqual(evidence["brokerSnapshotRecoveredCount"], 1)
        self.assertEqual(evidence["verifiedContractCount"], 1)
        self.assertEqual(evidence["missingContractCount"], 0)
        self.assertTrue(evidence["coverageComplete"])
        self.assertFalse(payload["events"][0]["from_cache"])
        self.assertEqual(payload["events"][0]["observation_mode"], "broker_snapshot")
        self.assertEqual(payload["events"][0]["snapshot_attempt"], 2)

    def test_refresh_keeps_a_fresh_one_sided_native_book_and_does_not_retry_it(self):
        async def connected():
            return {"ok": True, "status": "connected"}

        class OneSidedIb:
            def __init__(self):
                self.requests = 0

            async def qualifyContractsAsync(self, contract):
                return [contract]

            def reqMktData(self, contract, *_args):
                self.requests += 1
                return SimpleNamespace(
                    contract=contract,
                    bid=-1,
                    ask=0.97,
                    bidSize=0,
                    askSize=40,
                    last=-1,
                    volume=12,
                    marketDataType=1,
                    time=datetime.now(timezone.utc),
                )

            def cancelMktData(self, _contract):
                return None

        seed = authoritative_seed(64, "IB-CPI-26JUL-T3.3-YES")
        seed["quote_wait_sec"] = 0
        request = july_request([seed])
        request.retryMissing = True
        fake_ib = OneSidedIb()
        original_ensure_connected = app.ensure_connected
        original_ib = app.ib
        try:
            app.ensure_connected = connected
            app.ib = fake_ib
            response = asyncio.run(app.refresh(request))
        finally:
            app.ensure_connected = original_ensure_connected
            app.ib = original_ib

        payload = json.loads(response.body)
        evidence = payload["refreshEvidence"]
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["providers"]["ibkr"]["status"], "connected")
        self.assertEqual(fake_ib.requests, 1)
        self.assertEqual(payload["events"][0]["yes_ask"], 0.97)
        self.assertIsNone(payload["events"][0]["yes_bid"])
        self.assertEqual(evidence["initialVerifiedContractCount"], 1)
        self.assertEqual(evidence["brokerSnapshotRetryCount"], 0)
        self.assertEqual(evidence["verifiedContractCount"], 1)
        self.assertEqual(evidence["missingContractCount"], 0)
        self.assertTrue(evidence["coverageComplete"])

    def test_refresh_reports_exact_qualification_failure_when_catalog_contracts_do_not_qualify(self):
        async def connected():
            return {"ok": True, "status": "connected"}

        class UnsupportedIb:
            async def qualifyContractsAsync(self, _contract):
                return []

        seed = authoritative_seed(62, "IB-CPI-26JUL-T3.4-NO")
        seed["quote_wait_sec"] = 0
        original_ensure_connected = app.ensure_connected
        original_ib = app.ib
        try:
            app.ensure_connected = connected
            app.ib = UnsupportedIb()
            response = asyncio.run(app.refresh(july_request([seed])))
        finally:
            app.ensure_connected = original_ensure_connected
            app.ib = original_ib

        payload = json.loads(response.body)
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["errorCode"], "FORECASTEX_QUALIFICATION_FAILED")
        self.assertEqual(payload["providers"]["ibkr"]["status"], "qualification_failed")
        self.assertEqual(payload["providers"]["ibkr"]["errorCode"], "FORECASTEX_QUALIFICATION_FAILED")

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

    def test_cpi_discovery_queries_native_product_and_release_without_inventing_contract_ids(self):
        queries = app.cpi_symbol_templates(july_request())

        self.assertGreater(len(queries), 0)
        self.assertTrue(all(not query.localSymbol for query in queries))
        self.assertTrue(all(query.symbol == "CPIY" and query.tradingClass == "CPIY" for query in queries))
        self.assertTrue(all(query.lastTradeDateOrContractMonth == "20260812" for query in queries))
        self.assertTrue(all(query.exchange == "FORECASTX" for query in queries))
        request = july_request()
        request.cpi.releaseDate = None
        self.assertEqual(app.cpi_symbol_templates(request), [])

    def test_cpi_native_numeric_month_matches_measured_month_not_release_month(self):
        tokens = app.cpi_release_tokens(july_request())
        self.assertTrue(app.seed_matches_release({"localSymbol": "CPIY_0726_3.4_YES"}, tokens))
        self.assertFalse(app.seed_matches_release({"localSymbol": "CPIY_0826_3.4_YES"}, tokens))

    def test_cpi_discovery_retains_native_sides_from_the_exact_numeric_month(self):
        request = july_request()
        request.cpi.releaseKey = "KXCPIYOY#2099-07"
        request.cpi.releaseDate = "2099-08-12"
        request.cpi.targetStrikes = [3.4]
        contracts = [Contract(
            conId=con_id, symbol="CPIY", secType="OPT", exchange="FORECASTX", currency="USD",
            tradingClass="CPIY", lastTradeDateOrContractMonth="20990812", strike=3.4,
            localSymbol=f"CPIY_{month}_3.4_{side}", right=right,
        ) for con_id, month, side, right in ((1, "0799", "YES", "C"), (2, "0799", "NO", "P"), (3, "0899", "YES", "C"))]

        class FakeIb:
            calls = 0

            async def reqContractDetailsAsync(self, query):
                self.query = query
                self.calls += 1
                if self.calls == 1:
                    raise asyncio.TimeoutError()
                return [SimpleNamespace(contract=contract) for contract in contracts]

        original_ib = app.ib
        fake_ib = FakeIb()
        try:
            app.ib = fake_ib
            rows = asyncio.run(app.discover_event_contract_seeds(request=request))
        finally:
            app.ib = original_ib
        self.assertEqual(fake_ib.query.symbol, "CPIY")
        self.assertEqual(fake_ib.calls, 2)
        self.assertEqual(fake_ib.query.lastTradeDateOrContractMonth, "20990812")
        self.assertEqual({(row["conId"], row["quote_side"]) for row in rows}, {(1, "YES"), (2, "NO")})
        self.assertTrue(all(row["catalog_source"] == "ibkr_contract_details" for row in rows))

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
