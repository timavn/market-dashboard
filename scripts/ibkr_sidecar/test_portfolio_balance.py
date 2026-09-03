import unittest
import asyncio
import json
from datetime import date, datetime, timezone
from types import SimpleNamespace
from unittest.mock import patch

import app


class FakeEvent:
    def __init__(self):
        self.handlers = []

    def __iadd__(self, handler):
        self.handlers.append(handler)
        return self

    def __isub__(self, handler):
        self.handlers.remove(handler)
        return self

    def emit(self, value):
        for handler in list(self.handlers):
            handler(value)


class FakeAccountUpdatesClient:
    def __init__(self):
        self.cancellations = []

    def reqAccountUpdates(self, subscribe, account):
        self.cancellations.append((subscribe, account))


class FakeAccountPortfolioSession:
    def __init__(self, items):
        self.items = items
        self.updatePortfolioEvent = FakeEvent()
        self.client = FakeAccountUpdatesClient()

    async def reqAccountUpdatesAsync(self, account):
        await asyncio.sleep(0)
        for item in self.items:
            self.updatePortfolioEvent.emit(item)


class FakeIsolatedPositionSession:
    def __init__(
        self,
        items=None,
        *,
        connect_error=None,
        managed_accounts=None,
    ):
        self.items = list(items or [])
        self.connect_error = connect_error
        self._managed_accounts = list(managed_accounts or ["U1"])
        self.updatePortfolioEvent = FakeEvent()
        self.connect_calls = []
        self.disconnect_calls = 0
        self.positions_calls = 0

    async def connectAsync(
        self,
        host,
        port,
        *,
        clientId,
        timeout,
        readonly,
        account,
    ):
        self.connect_calls.append(
            {
                "host": host,
                "port": port,
                "clientId": clientId,
                "timeout": timeout,
                "readonly": readonly,
                "account": account,
            }
        )
        await asyncio.sleep(0)
        if self.connect_error is not None:
            raise self.connect_error
        for item in self.items:
            self.updatePortfolioEvent.emit(item)
        return self

    def managedAccounts(self):
        return list(self._managed_accounts)

    def positions(self, account):
        self.positions_calls += 1
        return [item for item in self.items if item.account == account]

    def disconnect(self):
        self.disconnect_calls += 1


class FakePersistentPositionSession:
    def __init__(self, items=None, *, connected=True, hang=False):
        self.items = list(items or [])
        self.connected = connected
        self.hang = hang
        self.connect_calls = []
        self.disconnect_calls = 0
        self.positions_calls = 0

    def isConnected(self):
        return self.connected

    async def connectAsync(self, host, port, *, clientId, timeout, readonly):
        self.connect_calls.append((host, port, clientId, timeout, readonly))
        self.connected = True
        return self

    async def reqCurrentTimeAsync(self):
        await asyncio.sleep(0)
        return datetime.now(timezone.utc)

    def managedAccounts(self):
        return ["U1"]

    async def reqPositionsAsync(self):
        self.positions_calls += 1
        if self.hang:
            await asyncio.Event().wait()
        await asyncio.sleep(0)
        return list(self.items)

    def cancelPositions(self):
        return None

    def disconnect(self):
        self.disconnect_calls += 1
        self.connected = False


def portfolio_item(account, con_id, quantity, sec_type="STK", currency="USD"):
    return SimpleNamespace(
        account=account,
        position=quantity,
        contract=SimpleNamespace(
            conId=con_id,
            symbol=f"S{con_id}",
            secType=sec_type,
            currency=currency,
        ),
    )


def event_contract_details(
    con_id,
    *,
    exchange="KALSHI",
    valid_exchanges=None,
    sec_type="OPT",
    currency="USD",
    multiplier="1",
):
    return SimpleNamespace(
        conId=con_id,
        symbol="KXCPIYOY",
        localSymbol=f"KXCPIYOY-{con_id}",
        tradingClass="KXCPIYOY",
        secType=sec_type,
        exchange=exchange,
        validExchanges=(
            exchange if valid_exchanges is None else valid_exchanges
        ),
        currency=currency,
        multiplier=multiplier,
    )


def event_evidence(con_id=201, exchange="KALSHI", quantity=1.0):
    return {
        "conId": con_id,
        "exchange": exchange,
        "quantity": quantity,
    }


class FakeContractDetailsSession:
    def __init__(self, details_by_con_id):
        self.details_by_con_id = dict(details_by_con_id)
        self.calls = []

    async def reqContractDetailsAsync(self, contract):
        con_id = int(getattr(contract, "conId", 0) or 0)
        self.calls.append(con_id)
        detail = self.details_by_con_id.get(con_id)
        return [
            SimpleNamespace(
                contract=detail,
                validExchanges=getattr(detail, "validExchanges", ""),
            )
        ] if detail is not None else []


def summary(**overrides):
    values = {
        "SettledCashByDate-S": "20260805:114000;20260807:113500",
        "TotalCashValue-S": 113500,
        "SettledCashByDate-C": "20260805:0;20260807:0",
        "TotalCashValue-C": 0,
    }
    values.update(overrides)
    return values


class PersistentBalancePositionTests(unittest.TestCase):
    def setUp(self):
        app.gateway_governor.reset()

    def test_two_fresh_reads_reuse_one_persistent_client_without_result_reuse(self):
        session = FakePersistentPositionSession([
            portfolio_item("U1", 101, 10),
        ])
        with patch.object(app, "create_positions_snapshot_session", return_value=session):
            async def read_twice():
                return (
                    await app.request_fresh_supported_stock_positions(app.balance_ib, "U1"),
                    await app.request_fresh_supported_stock_positions(app.balance_ib, "U1"),
                )

            first, second = asyncio.run(read_twice())

        self.assertEqual([first[0].position, second[0].position], [10, 10])
        self.assertEqual(session.positions_calls, 2)
        self.assertEqual(session.connect_calls, [])
        self.assertEqual(session.disconnect_calls, 0)

    def test_timeout_opens_circuit_without_trying_an_id_range(self):
        session = FakePersistentPositionSession(hang=True)
        original_timeout = app.POSITIONS_REQUEST_TIMEOUT_SEC
        original_grace = app.POSITIONS_CANCEL_GRACE_SEC
        app.POSITIONS_REQUEST_TIMEOUT_SEC = 0.02
        app.POSITIONS_CANCEL_GRACE_SEC = 0.01
        try:
            with patch.object(app, "create_positions_snapshot_session", return_value=session):
                async def fail_twice():
                    failures = []
                    for _index in range(2):
                        try:
                            await app.request_fresh_supported_stock_positions(
                                app.balance_ib,
                                "U1",
                            )
                        except app.FundingEvidenceError as error:
                            failures.append(error.code)
                    return failures

                failures = asyncio.run(fail_twice())
        finally:
            app.POSITIONS_REQUEST_TIMEOUT_SEC = original_timeout
            app.POSITIONS_CANCEL_GRACE_SEC = original_grace

        self.assertEqual(failures, [
            "IBKR_POSITIONS_REQUEST_TIMEOUT",
            "IBKR_POSITIONS_REQUEST_TIMEOUT",
        ])
        self.assertEqual(session.positions_calls, 1)
        self.assertEqual(session.connect_calls, [])
        self.assertGreaterEqual(session.disconnect_calls, 1)

    def test_data_validation_failure_does_not_reconnect(self):
        session = FakePersistentPositionSession([
            portfolio_item("U1", 101, 10, sec_type="OPT"),
        ])
        with patch.object(app, "create_positions_snapshot_session", return_value=session):
            with self.assertRaises(app.FundingEvidenceError) as raised:
                asyncio.run(
                    app.request_fresh_supported_stock_positions(app.balance_ib, "U1")
                )

        self.assertEqual(raised.exception.code, "POSITION_SCOPE_UNSUPPORTED")
        self.assertEqual(session.positions_calls, 1)
        self.assertEqual(session.connect_calls, [])

    def test_balance_reader_qualifies_kalshi_and_forecastx_contracts(self):
        raw_positions = [
            portfolio_item("U1", 101, 10),
            portfolio_item("U1", 201, 4, sec_type="FOP"),
            portfolio_item("U1", 202, 7, sec_type="OPT"),
        ]
        session = FakeContractDetailsSession({
            201: event_contract_details(
                201,
                exchange="FORECASTX",
                sec_type="FOP",
            ),
            202: event_contract_details(202, exchange="KALSHI"),
        })

        result = asyncio.run(
            app.balance_positions_from_snapshot(
                raw_positions,
                "U1",
                "USD",
                session,
            )
        )

        self.assertEqual(len(result["stocks"]), 1)
        self.assertEqual(
            [
                (row["conId"], row["quantity"], row["exchange"])
                for row in result["eventContracts"]
            ],
            [(201, 4, "FORECASTX"), (202, 7, "KALSHI")],
        )
        self.assertEqual(result["eventContracts"][0]["secType"], "FOP")
        self.assertEqual(
            result["positionScope"]["mode"],
            "stocks_and_event_contracts",
        )
        self.assertEqual(
            result["positionScope"]["eventVenues"],
            ["FORECASTX", "KALSHI"],
        )
        self.assertEqual(session.calls, [201, 202])

    def test_balance_reader_rejects_unknown_and_cme_contract_details(self):
        for exchange in ("CME", "UNKNOWN"):
            with self.subTest(exchange=exchange):
                session = FakeContractDetailsSession({
                    201: event_contract_details(
                        201,
                        exchange=exchange,
                        sec_type="FOP",
                    ),
                })
                with self.assertRaises(app.FundingEvidenceError) as raised:
                    asyncio.run(
                        app.balance_positions_from_snapshot(
                            [portfolio_item("U1", 201, 1, sec_type="FOP")],
                            "U1",
                            "USD",
                            session,
                        )
                    )

                self.assertEqual(
                    raised.exception.code,
                    "POSITION_SCOPE_UNSUPPORTED",
                )

    def test_balance_reader_rejects_kalshi_fop_and_type_mismatches(self):
        cases = (
            ("KALSHI", "FOP", "FOP"),
            ("FORECASTX", "FOP", "OPT"),
        )
        for exchange, qualified_type, raw_type in cases:
            with self.subTest(
                exchange=exchange,
                qualified_type=qualified_type,
                raw_type=raw_type,
            ):
                session = FakeContractDetailsSession({
                    201: event_contract_details(
                        201,
                        exchange=exchange,
                        sec_type=qualified_type,
                    ),
                })
                with self.assertRaises(app.FundingEvidenceError) as raised:
                    asyncio.run(
                        app.balance_positions_from_snapshot(
                            [portfolio_item("U1", 201, 1, sec_type=raw_type)],
                            "U1",
                            "USD",
                            session,
                        )
                    )

                self.assertEqual(
                    raised.exception.code,
                    "POSITION_SCOPE_UNSUPPORTED",
                )

    def test_balance_reader_rejects_mismatched_valid_exchanges(self):
        session = FakeContractDetailsSession({
            201: event_contract_details(
                201,
                exchange="FORECASTX",
                valid_exchanges="KALSHI",
            ),
        })
        with self.assertRaises(app.FundingEvidenceError) as raised:
            asyncio.run(
                app.balance_positions_from_snapshot(
                    [portfolio_item("U1", 201, 1, sec_type="OPT")],
                    "U1",
                    "USD",
                    session,
                )
            )

        self.assertEqual(raised.exception.code, "POSITION_SCOPE_UNSUPPORTED")

    def test_balance_reader_filters_cross_account_duplicate_conids(self):
        session = FakeContractDetailsSession({
            201: event_contract_details(
                201,
                exchange="FORECASTX",
                sec_type="FOP",
            ),
        })

        result = asyncio.run(
            app.balance_positions_from_snapshot(
                [
                    portfolio_item("U2", 201, 5500, sec_type="FOP"),
                    portfolio_item("U1", 201, 10000, sec_type="FOP"),
                ],
                "U1",
                "USD",
                session,
            )
        )

        self.assertEqual(len(result["eventContracts"]), 1)
        self.assertEqual(result["eventContracts"][0]["quantity"], 10000)
        self.assertEqual(result["positionScope"]["eventPositionCount"], 1)
        self.assertEqual(session.calls, [201])

    def test_balance_reader_rejects_same_account_duplicate_conids(self):
        session = FakeContractDetailsSession({
            201: event_contract_details(
                201,
                exchange="FORECASTX",
                sec_type="FOP",
            ),
        })

        with self.assertRaises(app.FundingEvidenceError) as raised:
            asyncio.run(
                app.balance_positions_from_snapshot(
                    [
                        portfolio_item("U1", 201, 5500, sec_type="FOP"),
                        portfolio_item("U1", 201, 10000, sec_type="FOP"),
                    ],
                    "U1",
                    "USD",
                    session,
                )
            )

        self.assertEqual(raised.exception.code, "POSITION_SCOPE_UNSUPPORTED")

    def test_balance_reader_preserves_live_fixed_point_event_quantity(self):
        session = FakeContractDetailsSession({
            201: event_contract_details(201, exchange="FORECASTX"),
        })

        result = asyncio.run(
            app.balance_positions_from_snapshot(
                [portfolio_item("U1", 201, 499.17, sec_type="OPT")],
                "U1",
                "USD",
                session,
            )
        )

        self.assertEqual(result["eventContracts"][0]["quantity"], 499.17)
        self.assertEqual(result["eventContracts"][0]["exchange"], "FORECASTX")


class ReconciledCashLadderTests(unittest.TestCase):
    def test_reads_broker_native_margin_health_and_fails_closed_when_missing(self):
        rows = [
            {"tag": tag, "value": value, "currency": "USD"}
            for tag, value in {
                "EquityWithLoanValue": "190000",
                "InitMarginReq": "80000",
                "MaintMarginReq": "75000",
                "AvailableFunds": "110000",
                "ExcessLiquidity": "115000",
                "BuyingPower": "380000",
            }.items()
        ]

        result = app.build_balance_margin_summary(rows, "USD")

        self.assertEqual(result["AvailableFunds"], 110000)
        self.assertEqual(result["ExcessLiquidity"], 115000)
        self.assertEqual(result["BuyingPower"], 380000)
        with self.assertRaises(app.FundingEvidenceError) as raised:
            app.build_balance_margin_summary(
                [row for row in rows if row["tag"] != "ExcessLiquidity"],
                "USD",
            )
        self.assertEqual(raised.exception.code, "ACCOUNT_VALUE_MISSING")

    def test_balance_snapshot_signature_changes_when_margin_health_changes(self):
        base_summary = {
            **summary(),
            "EquityWithLoanValue": 190000,
            "InitMarginReq": 80000,
            "MaintMarginReq": 75000,
            "AvailableFunds": 110000,
            "ExcessLiquidity": 115000,
            "BuyingPower": 380000,
        }
        settlement = {
            "state": "pending",
            "settlementDate": "2026-08-05",
            "horizonDate": "2026-08-07",
        }
        first = app.balance_snapshot_signature(
            base_summary,
            [],
            0,
            (),
            settlement,
        )
        second = app.balance_snapshot_signature(
            {**base_summary, "ExcessLiquidity": 114999},
            [],
            0,
            (),
            settlement,
        )

        self.assertNotEqual(first, second)

    def test_event_accounting_reconciles_mixed_venue_segment_values(self):
        rows = [
            {"tag": "GrossPositionValue-C", "value": "250", "currency": "USD"},
            {"tag": "NetLiquidation-C", "value": "350", "currency": "USD"},
            {"tag": "TotalCashValue-C", "value": "100", "currency": "USD"},
            {"tag": "InitMarginReq-C", "value": "250", "currency": "USD"},
            {"tag": "MaintMarginReq-C", "value": "250", "currency": "USD"},
            {"tag": "AvailableFunds-C", "value": "100", "currency": "USD"},
            {"tag": "EquityWithLoanValue-C", "value": "100", "currency": "USD"},
        ]

        result = app.build_event_contract_accounting_summary(
            rows,
            "USD",
            [
                event_evidence(201, "KALSHI"),
                event_evidence(202, "FORECASTX"),
            ],
            total_gross_position_value=101250,
            stock_gross_position_value=101000,
        )

        self.assertEqual(result["marketValue"], 250)
        self.assertEqual(result["capacityContribution"], 0.0)
        self.assertEqual(result["positionCount"], 2)
        self.assertEqual(result["venues"], ["FORECASTX", "KALSHI"])
        self.assertEqual(
            result["verification"],
            "ibkr_event_contract_commodity_segment_reconciled",
        )
        self.assertEqual(result["availableFundsHoldback"], 0.0)

    def test_event_accounting_accepts_one_cent_binary_float_differences(self):
        rows = [
            {"tag": "GrossPositionValue-C", "value": "3197.70", "currency": "USD"},
            {"tag": "NetLiquidation-C", "value": "13378.65", "currency": "USD"},
            {"tag": "TotalCashValue-C", "value": "10180.95", "currency": "USD"},
            {"tag": "InitMarginReq-C", "value": "3197.71", "currency": "USD"},
            {"tag": "MaintMarginReq-C", "value": "3197.71", "currency": "USD"},
            {"tag": "AvailableFunds-C", "value": "10180.95", "currency": "USD"},
            {"tag": "EquityWithLoanValue-C", "value": "10180.95", "currency": "USD"},
        ]

        # These broker values are one cent apart, even though the equivalent
        # binary-float margin comparison evaluates slightly above $0.01.
        self.assertGreater(3197.71 - 3197.70, app.ACCOUNT_VALUE_TOLERANCE)
        result = app.build_event_contract_accounting_summary(
            rows,
            "USD",
            [event_evidence()],
            total_gross_position_value=225718.85,
            stock_gross_position_value=222521.14,
        )

        self.assertEqual(result["marketValue"], 3197.70)
        self.assertEqual(result["initialMargin"], 3197.71)
        self.assertEqual(result["maintenanceMargin"], 3197.71)
        self.assertEqual(result["availableFunds"], 10180.95)

    def test_event_accounting_rejects_two_cent_segment_difference(self):
        rows = [
            {"tag": "GrossPositionValue-C", "value": "3197.70", "currency": "USD"},
            {"tag": "NetLiquidation-C", "value": "13378.65", "currency": "USD"},
            {"tag": "TotalCashValue-C", "value": "10180.95", "currency": "USD"},
            {"tag": "InitMarginReq-C", "value": "3197.70", "currency": "USD"},
            {"tag": "MaintMarginReq-C", "value": "3197.70", "currency": "USD"},
            {"tag": "AvailableFunds-C", "value": "10180.95", "currency": "USD"},
            {"tag": "EquityWithLoanValue-C", "value": "10180.95", "currency": "USD"},
        ]

        with self.assertRaises(app.FundingEvidenceError) as raised:
            app.build_event_contract_accounting_summary(
                rows,
                "USD",
                [event_evidence()],
                total_gross_position_value=225718.86,
                stock_gross_position_value=222521.14,
            )

        self.assertEqual(
            raised.exception.code,
            "EVENT_CONTRACT_ACCOUNTING_UNRECONCILED",
        )

    def test_event_accounting_rejects_two_cent_margin_equity_and_funds_differences(self):
        scenarios = {
            "initial margin": {
                "InitMarginReq-C": "250.02",
                "AvailableFunds-C": "99.98",
            },
            "maintenance margin": {
                "MaintMarginReq-C": "250.02",
                "EquityWithLoanValue-C": "99.98",
            },
            "equity": {"EquityWithLoanValue-C": "100.02"},
            "available funds": {"AvailableFunds-C": "100.02"},
        }
        base_values = {
            "GrossPositionValue-C": "250.00",
            "NetLiquidation-C": "350.00",
            "TotalCashValue-C": "100.00",
            "InitMarginReq-C": "250.00",
            "MaintMarginReq-C": "250.00",
            "AvailableFunds-C": "100.00",
            "EquityWithLoanValue-C": "100.00",
        }

        for label, overrides in scenarios.items():
            with self.subTest(label=label):
                values = {**base_values, **overrides}
                rows = [
                    {"tag": tag, "value": value, "currency": "USD"}
                    for tag, value in values.items()
                ]
                with self.assertRaises(app.FundingEvidenceError) as raised:
                    app.build_event_contract_accounting_summary(
                        rows,
                        "USD",
                        [event_evidence()],
                        total_gross_position_value=101250,
                        stock_gross_position_value=101000,
                    )

                self.assertEqual(
                    raised.exception.code,
                    "EVENT_CONTRACT_ACCOUNTING_UNRECONCILED",
                )

    def test_exposure_only_preserves_only_reverified_native_margin_tags(self):
        response = app.balance_exposure_only(
            account="U1",
            summary={
                "baseCurrency": "USD",
                "AccountReady": True,
                "NetLiquidation": 195000,
                "StockMarketValue": 95000,
                "GrossPositionValue-S": 295000,
            },
            margin_summary={
                "EquityWithLoanValue": 190000,
                "InitMarginReq": 80000,
                "MaintMarginReq": 75000,
                "AvailableFunds": 110000,
                "ExcessLiquidity": 115000,
                "BuyingPower": 380000,
            },
            account_values_observed_at="2026-08-28T17:46:28Z",
            capacity_code="EVENT_CONTRACT_ACCOUNTING_UNRECONCILED",
            capacity_message="Event accounting did not reconcile.",
            socket_verified_at="2026-08-28T17:46:29Z",
        )
        payload = json.loads(response.body)

        self.assertFalse(payload["balanceEvidence"]["capacityAvailable"])
        self.assertEqual(payload["summary"]["MaintMarginReq"], 75000)
        self.assertEqual(payload["summary"]["AvailableFunds"], 110000)
        self.assertNotIn("TotalCashValue", payload["summary"])
        self.assertIsNone(payload["balanceEvidence"]["settlementState"])

    def test_exposure_only_omits_unverified_margin_tags(self):
        response = app.balance_exposure_only(
            account="U1",
            summary={
                "baseCurrency": "USD",
                "AccountReady": True,
                "NetLiquidation": 195000,
                "StockMarketValue": 95000,
                "GrossPositionValue-S": 295000,
            },
            margin_summary=None,
            account_values_observed_at="2026-08-28T17:46:28Z",
            capacity_code="EVENT_CONTRACT_ACCOUNTING_UNRECONCILED",
            capacity_message="Event accounting did not reconcile.",
            socket_verified_at="2026-08-28T17:46:29Z",
        )
        payload = json.loads(response.body)

        self.assertFalse(payload["balanceEvidence"]["capacityAvailable"])
        self.assertNotIn("MaintMarginReq", payload["summary"])
        self.assertNotIn("AvailableFunds", payload["summary"])

    def test_event_accounting_caps_a_broker_available_funds_holdback(self):
        rows = [
            {"tag": "GrossPositionValue-C", "value": "250", "currency": "USD"},
            {"tag": "NetLiquidation-C", "value": "350", "currency": "USD"},
            {"tag": "TotalCashValue-C", "value": "100", "currency": "USD"},
            {"tag": "InitMarginReq-C", "value": "250", "currency": "USD"},
            {"tag": "MaintMarginReq-C", "value": "250", "currency": "USD"},
            {"tag": "AvailableFunds-C", "value": "72", "currency": "USD"},
            {"tag": "EquityWithLoanValue-C", "value": "100", "currency": "USD"},
        ]

        result = app.build_event_contract_accounting_summary(
            rows,
            "USD",
            [event_evidence()],
            total_gross_position_value=101250,
            stock_gross_position_value=101000,
        )

        self.assertEqual(result["theoreticalAvailableFunds"], 100)
        self.assertEqual(result["availableFunds"], 72)
        self.assertEqual(result["availableFundsHoldback"], 28)

    def test_event_accounting_rejects_available_funds_above_residual(self):
        rows = [
            {"tag": "GrossPositionValue-C", "value": "250", "currency": "USD"},
            {"tag": "NetLiquidation-C", "value": "350", "currency": "USD"},
            {"tag": "TotalCashValue-C", "value": "100", "currency": "USD"},
            {"tag": "InitMarginReq-C", "value": "250", "currency": "USD"},
            {"tag": "MaintMarginReq-C", "value": "250", "currency": "USD"},
            {"tag": "AvailableFunds-C", "value": "100.02", "currency": "USD"},
            {"tag": "EquityWithLoanValue-C", "value": "100", "currency": "USD"},
        ]

        with self.assertRaises(app.FundingEvidenceError) as raised:
            app.build_event_contract_accounting_summary(
                rows,
                "USD",
                [event_evidence()],
                total_gross_position_value=101250,
                stock_gross_position_value=101000,
            )

        self.assertEqual(
            raised.exception.code,
            "EVENT_CONTRACT_ACCOUNTING_UNRECONCILED",
        )

    def test_event_accounting_rejects_margin_mismatch(self):
        rows = [
            {"tag": "GrossPositionValue-C", "value": "250", "currency": "USD"},
            {"tag": "NetLiquidation-C", "value": "350", "currency": "USD"},
            {"tag": "TotalCashValue-C", "value": "100", "currency": "USD"},
            {"tag": "InitMarginReq-C", "value": "250", "currency": "USD"},
            {"tag": "MaintMarginReq-C", "value": "251", "currency": "USD"},
            {"tag": "AvailableFunds-C", "value": "100", "currency": "USD"},
            {"tag": "EquityWithLoanValue-C", "value": "100", "currency": "USD"},
        ]

        with self.assertRaises(app.FundingEvidenceError) as raised:
            app.build_event_contract_accounting_summary(
                rows,
                "USD",
                [event_evidence()],
            )

        self.assertEqual(
            raised.exception.code,
            "EVENT_CONTRACT_ACCOUNTING_UNRECONCILED",
        )

    def test_event_accounting_rejects_missing_gross_segment(self):
        rows = [
            {"tag": "GrossPositionValue-C", "value": "250", "currency": "USD"},
            {"tag": "NetLiquidation-C", "value": "350", "currency": "USD"},
            {"tag": "TotalCashValue-C", "value": "100", "currency": "USD"},
            {"tag": "InitMarginReq-C", "value": "250", "currency": "USD"},
            {"tag": "MaintMarginReq-C", "value": "250", "currency": "USD"},
            {"tag": "AvailableFunds-C", "value": "100", "currency": "USD"},
            {"tag": "EquityWithLoanValue-C", "value": "100", "currency": "USD"},
        ]

        with self.assertRaises(app.FundingEvidenceError) as raised:
            app.build_event_contract_accounting_summary(
                rows,
                "USD",
                [event_evidence()],
            )

        self.assertEqual(
            raised.exception.code,
            "EVENT_CONTRACT_ACCOUNTING_UNRECONCILED",
        )

    def test_persistent_positions_snapshot_filters_to_requested_account(self):
        session = FakePersistentPositionSession([
            portfolio_item("U1", 101, 10),
            portfolio_item("U1", 102, -5),
            portfolio_item("U2", 103, 7),
        ])
        app.gateway_governor.reset()
        with patch.object(app, "create_positions_snapshot_session", return_value=session):
            positions = asyncio.run(
                app.request_fresh_supported_stock_positions(app.balance_ib, "U1")
            )

        self.assertEqual([position.position for position in positions], [10, -5])
        self.assertEqual(session.positions_calls, 1)

    def test_persistent_positions_snapshot_rejects_unsupported_instrument(self):
        session = FakePersistentPositionSession([
            portfolio_item("U1", 101, 10),
            portfolio_item("U1", 202, 1, sec_type="OPT"),
        ])
        app.gateway_governor.reset()
        with patch.object(app, "create_positions_snapshot_session", return_value=session):
            with self.assertRaises(app.FundingEvidenceError) as raised:
                asyncio.run(
                    app.request_fresh_supported_stock_positions(app.balance_ib, "U1")
                )

        self.assertEqual(raised.exception.code, "POSITION_SCOPE_UNSUPPORTED")

    def test_exposure_summary_does_not_require_capacity_cash_evidence(self):
        rows = [
            {"tag": "AccountReady", "value": "true", "currency": "USD"},
            {"tag": "NetLiquidation", "value": "184016.42", "currency": "USD"},
            {"tag": "GrossPositionValue-S", "value": "224756.97", "currency": "USD"},
            {"tag": "StockMarketValue", "value": "33092.45", "currency": "USD"},
        ]

        result = app.build_balance_exposure_summary(rows)

        self.assertEqual(result["baseCurrency"], "USD")
        self.assertEqual(result["NetLiquidation"], 184016.42)
        self.assertNotIn("TotalCashValue-S", result)

    def test_future_settlements_are_live_pending_evidence(self):
        result = app.require_reconciled_cash_ladders(
            summary(),
            date(2026, 8, 5),
        )

        self.assertEqual(
            result,
            {
                "state": "pending",
                "settlementDate": "2026-08-05",
                "horizonDate": "2026-08-07",
            },
        )

    def test_current_date_terminal_rows_are_settled(self):
        result = app.require_reconciled_cash_ladders(
            summary(
                **{
                    "SettledCashByDate-S": "20260805:114000",
                    "TotalCashValue-S": 114000,
                    "SettledCashByDate-C": "20260805:250",
                    "TotalCashValue-C": 250,
                }
            ),
            date(2026, 8, 5),
        )

        self.assertEqual(result["state"], "settled")
        self.assertEqual(result["horizonDate"], "2026-08-05")

    def test_rejects_a_terminal_balance_that_does_not_reconcile(self):
        with self.assertRaises(app.FundingEvidenceError) as raised:
            app.require_reconciled_cash_ladders(
                summary(**{"TotalCashValue-S": 113499}),
                date(2026, 8, 5),
            )

        self.assertEqual(
            raised.exception.code,
            "BALANCE_CASH_LADDER_UNRECONCILED",
        )

    def test_rejects_a_ladder_whose_horizon_predates_broker_time(self):
        with self.assertRaises(app.FundingEvidenceError) as raised:
            app.require_reconciled_cash_ladders(
                summary(
                    **{
                        "SettledCashByDate-S": "20260804:114000",
                        "TotalCashValue-S": 114000,
                        "SettledCashByDate-C": "20260804:0",
                    }
                ),
                date(2026, 8, 5),
            )

        self.assertEqual(
            raised.exception.code,
            "BALANCE_CASH_LADDER_STALE",
        )

    def test_rejects_missing_segment_evidence_instead_of_estimating(self):
        values = summary()
        del values["SettledCashByDate-C"]

        with self.assertRaises(app.FundingEvidenceError) as raised:
            app.require_reconciled_cash_ladders(values, date(2026, 8, 5))

        self.assertEqual(
            raised.exception.code,
            "BALANCE_CASH_LADDER_UNAVAILABLE",
        )

    def test_rejects_a_future_only_ladder_without_a_current_cash_anchor(self):
        with self.assertRaises(app.FundingEvidenceError) as raised:
            app.require_reconciled_cash_ladders(
                summary(
                    **{
                        "SettledCashByDate-S": "20260807:113500",
                        "SettledCashByDate-C": "20260807:0",
                    }
                ),
                date(2026, 8, 5),
            )

        self.assertEqual(
            raised.exception.code,
            "BALANCE_CASH_LADDER_INCOMPLETE",
        )


class BalanceRequestConcurrencyTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        app.balance_request_task = None
        app.balance_request_account = None

    async def asyncTearDown(self):
        task = app.balance_request_task
        if task and not task.done():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        app.balance_request_task = None
        app.balance_request_account = None

    async def test_same_account_callers_share_only_the_in_flight_read(self):
        started = asyncio.Event()
        release = asyncio.Event()
        calls = {"count": 0}

        async def controlled(account):
            calls["count"] += 1
            started.set()
            await release.wait()
            return app.JSONResponse({"ok": True, "account": account})

        with patch.object(app, "_portfolio_live_balance_once", controlled):
            first_task = asyncio.create_task(app.portfolio_live_balance("U1"))
            await started.wait()
            second_task = asyncio.create_task(app.portfolio_live_balance("U1"))
            await asyncio.sleep(0)
            release.set()
            first, second = await asyncio.gather(first_task, second_task)
            third = await app.portfolio_live_balance("U1")

        self.assertEqual(calls["count"], 2)
        self.assertEqual(json.loads(first.body)["account"], "U1")
        self.assertEqual(json.loads(second.body)["account"], "U1")
        self.assertEqual(json.loads(third.body)["account"], "U1")

    async def test_different_account_is_rejected_without_waiting(self):
        started = asyncio.Event()
        release = asyncio.Event()

        async def controlled(account):
            started.set()
            await release.wait()
            return app.JSONResponse({"ok": True, "account": account})

        with patch.object(app, "_portfolio_live_balance_once", controlled):
            first_task = asyncio.create_task(app.portfolio_live_balance("U1"))
            await started.wait()
            second = await app.portfolio_live_balance("U2")
            release.set()
            await first_task

        payload = json.loads(second.body)
        self.assertEqual(second.status_code, 503)
        self.assertEqual(payload["errorCode"], "BALANCE_SNAPSHOT_ACCOUNT_BUSY")
        self.assertEqual(payload["summary"], {})

    async def test_total_deadline_returns_empty_fail_closed_response(self):
        async def hung(_account):
            await asyncio.Event().wait()

        with (
            patch.object(app, "_portfolio_live_balance_once", hung),
            patch.object(app, "BALANCE_TOTAL_DEADLINE_SEC", 0.02),
        ):
            response = await app.portfolio_live_balance("U1")

        payload = json.loads(response.body)
        self.assertEqual(response.status_code, 503)
        self.assertEqual(payload["errorCode"], "IBKR_BALANCE_REQUEST_TIMEOUT")
        self.assertEqual(payload["summary"], {})
        self.assertIsNone(payload["balanceEvidence"])


class BalanceSignatureTests(unittest.TestCase):
    def test_changed_broker_reads_produce_different_verification_signatures(self):
        settlement = {
            "state": "pending",
            "settlementDate": "2026-08-05",
            "horizonDate": "2026-08-07",
        }
        first = app.balance_snapshot_signature(
            summary(),
            [],
            0,
            ("execution-1",),
            settlement,
        )
        changed_cash = app.balance_snapshot_signature(
            summary(**{"TotalCashValue-S": 113499}),
            [],
            0,
            ("execution-1",),
            settlement,
        )
        changed_activity = app.balance_snapshot_signature(
            summary(),
            [],
            1,
            ("execution-1",),
            settlement,
        )

        self.assertNotEqual(first, changed_cash)
        self.assertNotEqual(first, changed_activity)

    def test_prior_close_remains_previous_session_after_todays_bar_completes(self):
        result = app.balance_prior_session_close(
            {
                "referenceClose": 102,
                "referenceCloseSource": "ibkr_historical_daily_close",
                "referenceCloseSessionDate": "2026-08-05",
                "referenceCloseObservedAt": "2026-08-05T21:00:00Z",
                "previousClose": 100,
                "previousCloseSessionDate": "2026-08-04",
            },
            date(2026, 8, 5),
        )

        self.assertEqual(result["close"], 100)
        self.assertEqual(result["sessionDate"], date(2026, 8, 4))

    def test_prior_close_fails_closed_when_no_earlier_session_exists(self):
        result = app.balance_prior_session_close(
            {
                "referenceClose": 102,
                "referenceCloseSource": "ibkr_historical_daily_close",
                "referenceCloseSessionDate": "2026-08-05",
                "referenceCloseObservedAt": "2026-08-05T21:00:00Z",
            },
            date(2026, 8, 5),
        )

        self.assertIsNone(result)


if __name__ == "__main__":
    unittest.main()
