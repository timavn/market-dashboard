import asyncio
import json
import unittest
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from ib_insync import CommissionReport, Contract, Execution, Fill

import app


class ManagedSession:
    def __init__(self, accounts=None):
        self.accounts = accounts or ["U123"]

    def managedAccounts(self):
        return self.accounts


class PredictionMarketPerformanceEvidenceTests(unittest.TestCase):
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
                self.assertTrue(app.valid_prediction_execution_evidence(row, "U123"))
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

    def test_keeps_two_managed_accounts_strictly_scoped_to_the_requested_roth(self):
        roth = "U25465536"
        positions_read = AsyncMock(return_value={
            "ok": True,
            "account": roth,
            "positions": [],
            "snapshot_started_at": "2026-09-02T20:19:59Z",
            "fetched_at": "2026-09-02T20:20:00Z",
        })
        executions_read = AsyncMock(return_value={
            "asOf": "2026-09-02T20:20:01Z",
            "count": 0,
            "rows": [],
            "signature": (),
        })

        async def run():
            with (
                patch.object(app, "ib", ManagedSession(["U25779973", roth])),
                patch.object(app, "ensure_connected", AsyncMock(return_value={"ok": True})),
                patch.object(app, "fetch_positions_snapshot", positions_read),
                patch.object(app, "ensure_funding_connected", AsyncMock(return_value={"ok": True})),
                patch.object(app, "require_funding_socket_connected"),
                patch.object(app, "request_fresh_account_execution_evidence", executions_read),
            ):
                return await app.portfolio_prediction_market_evidence(account=roth)

        payload = json.loads(asyncio.run(run()).body)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["account"], roth)
        self.assertEqual(payload["positions"], [])
        self.assertEqual(payload["executions"], [])
        positions_read.assert_awaited_once_with(roth)
        self.assertEqual(executions_read.await_args.args[1], roth)

    def test_returns_one_complete_snapshot_id_for_positions_and_executions(self):
        positions = [{
            "account": "U123",
            "conId": 9001,
            "position": 2.0,
            "secType": "OPT",
            "exchange": "",
            "symbol": "KXWTID",
            "localSymbol": "KXWTID-26AUG13-T81.49-YES",
        }, {
            "account": "U123",
            "conId": 9002,
            "position": 5.0,
            "secType": "FOP",
            "exchange": "",
            "symbol": "ES",
            "tradingClass": "FES",
            "localSymbol": "FES_081426_7800_NO",
        }, {
            "account": "U123",
            "conId": 100,
            "position": 10.0,
            "secType": "STK",
            "exchange": "NYSE",
            "symbol": "IBM",
            "localSymbol": "IBM",
        }]
        executions = [{
            "accountId": "U123",
            "execId": "E-1",
            "conId": 9001,
            "secType": "OPT",
            "exchange": "KALSHI",
            "symbol": "KXWTID",
            "localSymbol": "KXWTID-26AUG13-T81.49-YES",
            "side": "BOT",
            "shares": 2.0,
            "price": 0.4,
            "commission": 0.1,
            "executionTime": "2026-08-13T19:00:00Z",
        }, {
            "accountId": "U123",
            "execId": "E-FES-1",
            "conId": 9002,
            "secType": "FOP",
            "exchange": "",
            "symbol": "ES",
            "tradingClass": "FES",
            "localSymbol": "FES_081426_7800_NO",
            "side": "BOT",
            "shares": 5.0,
            "price": 0.42,
            "commission": 0.1,
            "executionTime": "2026-08-13T19:05:00Z",
        }, {
            "accountId": "U123",
            "execId": "E-2",
            "conId": 100,
            "secType": "STK",
            "exchange": "NYSE",
            "symbol": "IBM",
            "localSymbol": "IBM",
            "side": "BOT",
            "shares": 10.0,
            "price": 200.0,
            "commission": 1.0,
        }]

        async def run():
            with (
                patch.object(app, "ib", ManagedSession()),
                patch.object(app, "ensure_connected", AsyncMock(return_value={"ok": True})),
                patch.object(app, "fetch_positions_snapshot", AsyncMock(return_value={
                    "ok": True,
                    "account": "U123",
                    "positions": positions,
                    "snapshot_started_at": "2026-08-13T19:59:00Z",
                    "fetched_at": "2026-08-13T20:00:00Z",
                })),
                patch.object(app, "ensure_funding_connected", AsyncMock(return_value={"ok": True})),
                patch.object(app, "require_funding_socket_connected"),
                patch.object(app, "request_fresh_account_execution_evidence", AsyncMock(return_value={
                    "asOf": "2026-08-13T20:00:01Z",
                    "count": 2,
                    "rows": executions,
                    "signature": (json.dumps(executions[0], sort_keys=True, separators=(",", ":")),),
                })),
            ):
                return await app.portfolio_prediction_market_evidence(account="U123")

        response = asyncio.run(run())
        payload = json.loads(response.body)
        self.assertTrue(payload["ok"])
        self.assertTrue(payload["complete"])
        self.assertTrue(payload["coverageComplete"])
        self.assertFalse(payload["partial"])
        self.assertEqual(payload["positionCount"], 2)
        self.assertEqual(payload["executionCount"], 2)
        self.assertEqual([row["conId"] for row in payload["positions"]], [9001, 9002])
        self.assertEqual([row["execId"] for row in payload["executions"]], ["E-1", "E-FES-1"])
        self.assertEqual(payload["snapshotId"], payload["positionsPayload"]["snapshotId"])
        self.assertEqual(payload["snapshotId"], payload["executionsPayload"]["snapshotId"])
        self.assertEqual(payload["positionsPayload"]["snapshotStartedAt"], "2026-08-13T19:59:00Z")
        self.assertEqual(len(payload["snapshotId"]), 64)

    def test_rejects_an_execution_that_arrived_during_the_positions_snapshot(self):
        execution = {
            "accountId": "U123",
            "execId": "E-race",
            "conId": 9001,
            "secType": "OPT",
            "exchange": "KALSHI",
            "symbol": "KXWTID",
            "localSymbol": "KXWTID-26AUG13-T81.49-YES",
            "executionTime": "2026-08-13T20:00:00Z",
            "side": "BOT",
            "shares": 1.0,
            "price": 0.4,
            "commission": 0.1,
        }

        async def run():
            with (
                patch.object(app, "ib", ManagedSession()),
                patch.object(app, "ensure_connected", AsyncMock(return_value={"ok": True})),
                patch.object(app, "fetch_positions_snapshot", AsyncMock(return_value={
                    "ok": True,
                    "account": "U123",
                    "positions": [],
                    "snapshot_started_at": "2026-08-13T19:59:59Z",
                    "fetched_at": "2026-08-13T20:00:01Z",
                })),
                patch.object(app, "ensure_funding_connected", AsyncMock(return_value={"ok": True})),
                patch.object(app, "require_funding_socket_connected"),
                patch.object(app, "request_fresh_account_execution_evidence", AsyncMock(return_value={
                    "asOf": "2026-08-13T20:00:02Z",
                    "rows": [execution],
                })),
            ):
                return await app.portfolio_prediction_market_evidence(account="U123")

        payload = json.loads(asyncio.run(run()).body)
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["status"], "snapshot_temporal_overlap")
        self.assertNotIn("complete", payload)
        self.assertEqual(payload["positions"], [])
        self.assertEqual(payload["executions"], [])

    def test_keeps_unsupported_forecastex_contracts_for_server_review(self):
        self.assertTrue(app.is_prediction_market_contract_evidence({
            "secType": "OPT",
            "exchange": "",
            "symbol": "COMCO",
            "localSymbol": "COMCO_081326_82_NO",
        }))
        self.assertTrue(app.is_prediction_market_contract_evidence({
            "secType": "OPT",
            "exchange": "FORECASTX",
            "symbol": "COMCO",
        }))
        self.assertFalse(app.is_prediction_market_contract_evidence({
            "secType": "STK",
            "exchange": "NYSE",
            "symbol": "IBM",
            "localSymbol": "IBM",
        }))
        self.assertFalse(app.is_prediction_market_contract_evidence({
            "secType": "OPT",
            "exchange": "CBOE",
            "symbol": "SPY",
            "localSymbol": "SPY   260814C00780000",
        }))
        self.assertTrue(app.is_prediction_market_contract_evidence({
            "secType": "FOP",
            "exchange": "",
            "symbol": "ES",
            "tradingClass": "FES",
            "localSymbol": "FES_081426_7800_NO",
        }))
        self.assertTrue(app.is_prediction_market_contract_evidence({
            "secType": "FOP",
            "exchange": "",
            "symbol": "ES",
            "tradingClass": "ES",
            "localSymbol": "FES_081426_7775_YES",
        }))
        self.assertFalse(app.is_prediction_market_contract_evidence({
            "secType": "FOP",
            "exchange": "CME",
            "symbol": "ES",
            "tradingClass": "ES",
            "localSymbol": "ES   260814P07775000",
        }))
        self.assertFalse(app.is_prediction_market_contract_evidence({
            "secType": "FOP",
            "exchange": "",
            "symbol": "ES",
            "tradingClass": "FES",
            "localSymbol": "FES_081426_7800",
        }))
        self.assertFalse(app.is_prediction_market_contract_evidence({
            "secType": "FOP",
            "exchange": "",
            "symbol": "FES",
            "tradingClass": "FES",
            "localSymbol": "ES_081426_7800_NO",
        }))
        self.assertFalse(app.valid_prediction_execution_evidence({
            "accountId": "U123",
            "execId": "missing-time",
            "conId": 9001,
            "side": "BOT",
            "shares": 1,
            "price": 0.4,
        }, "U123"))

    def test_never_labels_failed_execution_evidence_complete(self):
        async def run():
            with (
                patch.object(app, "ib", ManagedSession()),
                patch.object(app, "ensure_connected", AsyncMock(return_value={"ok": True})),
                patch.object(app, "fetch_positions_snapshot", AsyncMock(return_value={
                    "ok": True,
                    "account": "U123",
                    "positions": [],
                    "fetched_at": "2026-08-13T20:00:00Z",
                })),
                patch.object(app, "ensure_funding_connected", AsyncMock(return_value={
                    "ok": False,
                    "status": "executions_unavailable",
                    "message": "funding socket unavailable",
                })),
            ):
                return await app.portfolio_prediction_market_evidence(account="U123")

        response = asyncio.run(run())
        payload = json.loads(response.body)
        self.assertFalse(payload["ok"])
        self.assertNotIn("complete", payload)
        self.assertEqual(payload["positions"], [])
        self.assertEqual(payload["executions"], [])


if __name__ == "__main__":
    unittest.main()
