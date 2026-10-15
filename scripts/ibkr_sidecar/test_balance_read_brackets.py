import asyncio
import copy
import json
import unittest
from datetime import date, datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import app
from test_interest_observation import account_rows


OBSERVED = "2026-10-07T03:00:00Z"


def verified_rows():
    rows = account_rows(observed_at=OBSERVED, cash_anchor_date=date(2026, 10, 6))
    for row in rows:
        if row["tag"] in {"StockMarketValue", "GrossPositionValue-S", "MaintMarginReq-C"}:
            row["value"] = "0"
    rows.extend({"account": "U1", "modelCode": "", "tag": tag,
                 "value": "1000", "currency": "BASE", "received_at": OBSERVED}
                for tag in app.BALANCE_MARGIN_NUMERIC_TAGS)
    return rows


class BalanceReadBracketTests(unittest.IsolatedAsyncioTestCase):
    async def test_all_four_fresh_reads_start_before_any_finishes(self):
        started = set()
        ready = asyncio.Event()
        release = asyncio.Event()
        results = {"account": [{"account": "U1"}], "positions": [],
                   "orders": 2, "executions": ("execution-1",)}

        def reader(kind):
            async def read(session, account):
                self.assertEqual(account, "U1")
                started.add(kind)
                if len(started) == 4:
                    ready.set()
                await release.wait()
                return results[kind]
            return read

        timings = {}
        with (
            patch.object(app, "request_fresh_account_updates_multi", reader("account")),
            patch.object(app, "request_fresh_balance_position_rows", reader("positions")),
            patch.object(app, "request_fresh_open_order_count", reader("orders")),
            patch.object(app, "request_fresh_account_execution_signature", reader("executions")),
        ):
            async with app.fresh_balance_read_bracket(object(), "U1", timings) as reads:
                await asyncio.wait_for(ready.wait(), 1)
                self.assertTrue(all(not task.done() for task in reads.values()))
                release.set()
                self.assertEqual(await asyncio.gather(*reads.values()), list(results.values()))
        self.assertEqual(set(timings), {
            "account_values_ms", "positions_ms", "open_orders_ms", "executions_ms",
        })

    async def test_validation_failure_cancels_and_joins_unconsumed_reads(self):
        stopped = set()
        all_started = asyncio.Event()
        started = set()

        def reader(kind):
            async def read(*_args):
                started.add(kind)
                if len(started) == 4:
                    all_started.set()
                if kind == "account":
                    await all_started.wait()
                    raise app.FundingEvidenceError("Invalid current account", "ACCOUNT_NOT_READY")
                try:
                    await asyncio.Event().wait()
                finally:
                    stopped.add(kind)
            return read

        with (
            patch.object(app, "request_fresh_account_updates_multi", reader("account")),
            patch.object(app, "request_fresh_balance_position_rows", reader("positions")),
            patch.object(app, "request_fresh_open_order_count", reader("orders")),
            patch.object(app, "request_fresh_account_execution_signature", reader("executions")),
        ):
            with self.assertRaises(app.FundingEvidenceError) as raised:
                async with app.fresh_balance_read_bracket(object(), "U1", {}) as reads:
                    await reads["account"]
        self.assertEqual(raised.exception.code, "ACCOUNT_NOT_READY")
        self.assertEqual(stopped, {"positions", "orders", "executions"})
        self.assertTrue(all(task.done() for task in reads.values()))

    async def test_cancellation_joins_every_read_before_releasing_bracket(self):
        started = set()
        stopped = set()
        ready = asyncio.Event()

        def reader(kind):
            async def read(*_args):
                started.add(kind)
                if len(started) == 4:
                    ready.set()
                try:
                    await asyncio.Event().wait()
                finally:
                    stopped.add(kind)
            return read

        async def capture():
            async with app.fresh_balance_read_bracket(object(), "U1", {}) as reads:
                await reads["account"]

        with (
            patch.object(app, "request_fresh_account_updates_multi", reader("account")),
            patch.object(app, "request_fresh_balance_position_rows", reader("positions")),
            patch.object(app, "request_fresh_open_order_count", reader("orders")),
            patch.object(app, "request_fresh_account_execution_signature", reader("executions")),
        ):
            task = asyncio.create_task(capture())
            await asyncio.wait_for(ready.wait(), 1)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
        self.assertEqual(stopped, started)


class BalanceRouteBracketTests(unittest.IsolatedAsyncioTestCase):
    async def run_capture(self, *, change=None, connected=True, requested_account="U1", health=None):
        calls = {kind: 0 for kind in ("account", "positions", "orders", "executions")}
        brackets = [set(), set()]
        ready = [asyncio.Event(), asyncio.Event()]
        chronology = []
        raw_rows = verified_rows()

        def reader(kind):
            async def read(_session, account):
                self.assertEqual(account, "U1")
                index = calls[kind]
                calls[kind] += 1
                if kind == "account" and index == 2 and change in {"cash", "positions", "orders", "executions"}:
                    # Preserve the existing separate, fresh exposure recovery
                    # after capacity verification fails.
                    return copy.deepcopy(raw_rows)
                self.assertLess(index, 2)
                brackets[index].add(kind)
                chronology.append((index, kind))
                if len(brackets[index]) == 4:
                    ready[index].set()
                # A serial route cannot pass this gate; all sources must be
                # dispatched independently in each separate fresh bracket.
                await asyncio.wait_for(ready[index].wait(), 1)
                if kind == "account":
                    result = copy.deepcopy(raw_rows)
                    if change == "account-not-ready":
                        next(row for row in result if row["tag"] == "AccountReady")["value"] = "false"
                    if index and change == "cash":
                        for row in result:
                            if row["tag"] in {"TotalCashValue", "TotalCashValue-S", "CashBalance"}:
                                row["value"] = "40501"
                            if row["tag"] == "SettledCashByDate-S":
                                row["value"] = "20261005:40000;20261006:40501"
                    return result
                if kind == "positions":
                    if index and change == "positions":
                        return [SimpleNamespace(account="U1", position=1,
                                                contract=SimpleNamespace(conId=1, symbol="AAA", secType="STK", currency="USD"))]
                    return []
                if kind == "orders":
                    return 1 if index and change == "orders" else 0
                return ("changed",) if index and change == "executions" else ()
            return read

        async def short_evidence(*_args, **_kwargs):
            self.assertEqual(calls, dict.fromkeys(calls, 1))
            chronology.append("short-evidence")
            return []

        session = SimpleNamespace(managedAccounts=lambda: ["U1"])
        with (
            patch.object(app, "balance_ib", session),
            patch.object(app, "ensure_balance_connected", AsyncMock(return_value=health or {"ok": connected})),
            patch.object(app, "request_balance_broker_time", AsyncMock(return_value={
                "gatewayTime": datetime(2026, 10, 7, 3, tzinfo=timezone.utc), "socketVerifiedAt": OBSERVED,
            })),
            patch.object(app, "request_fresh_account_updates_multi", reader("account")),
            patch.object(app, "request_fresh_balance_position_rows", reader("positions")),
            patch.object(app, "request_fresh_open_order_count", reader("orders")),
            patch.object(app, "request_fresh_account_execution_signature", reader("executions")),
            patch.object(app, "build_balance_short_position_evidence", short_evidence),
            patch.object(app, "disconnect_balance_session"),
            patch.object(app, "now_iso", return_value=OBSERVED),
        ):
            response = await app._portfolio_live_balance_once(requested_account)
        return response, json.loads(response.body), calls, chronology

    async def test_full_capture_still_uses_two_new_verified_brackets_with_original_provenance(self):
        response, payload, calls, chronology = await self.run_capture()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(calls, dict.fromkeys(calls, 2))
        self.assertTrue(all(item[0] == 0 for item in chronology[:4]))
        self.assertEqual(chronology[4], "short-evidence")
        self.assertTrue(all(item[0] == 1 for item in chronology[5:]))
        self.assertEqual(payload["account"], "U1")
        self.assertFalse(payload["from_cache"])
        self.assertEqual(payload["socket_verified_at"], OBSERVED)
        self.assertEqual(payload["balanceEvidence"]["accountValuesObservedAt"], OBSERVED)
        self.assertEqual(payload["balanceEvidence"]["settlementVerification"], "segment_ladders_double_snapshot")
        self.assertEqual(payload["freshness"], {
            "status": "fresh", "maxAgeSeconds": 45, "accountReads": 2,
            "positionReads": 2, "activityReads": 2,
        })

    async def test_changed_second_bracket_never_returns_capacity(self):
        for change in ("cash", "positions", "orders", "executions"):
            with self.subTest(change=change):
                response, payload, calls, _ = await self.run_capture(change=change)
                self.assertEqual(response.status_code, 200)
                self.assertFalse(payload["balanceEvidence"]["capacityAvailable"])
                self.assertEqual(payload["balanceEvidence"]["capacityUnavailableCode"], "BALANCE_SNAPSHOT_CHANGED")
                self.assertEqual(payload["summary"]["NetLiquidation"], 195000)
                self.assertEqual(payload["balanceEvidence"]["settlementVerification"], "capacity_unavailable")
                self.assertEqual(calls["account"], 3)
                self.assertEqual(calls["positions"], 2)

    async def test_disconnected_foreign_or_unready_account_never_returns_values(self):
        for kwargs, code in (({"connected": False}, "GATEWAY_UNAVAILABLE"),
                             ({"requested_account": "U2"}, "ACCOUNT_NOT_MANAGED"),
                             ({"change": "account-not-ready"}, "ACCOUNT_NOT_READY")):
            with self.subTest(kwargs=kwargs):
                response, payload, calls, _ = await self.run_capture(**kwargs)
                self.assertEqual(response.status_code, 503)
                self.assertEqual(payload["errorCode"], code)
                self.assertEqual(payload["summary"], {})
                if code != "ACCOUNT_NOT_READY":
                    self.assertEqual(calls, dict.fromkeys(calls, 0))

    async def test_unconnected_balance_client_carries_the_producer_gateway_code(self):
        for health, expected in (
            ({"ok": False, "error_code": "IBKR_GATEWAY_API_UNRESPONSIVE"}, "IBKR_GATEWAY_API_UNRESPONSIVE"),
            ({"ok": False, "error_code": "IBKR_GATEWAY_NOT_AUTHENTICATED"}, "IBKR_GATEWAY_NOT_AUTHENTICATED"),
            ({"ok": False}, None),
        ):
            with self.subTest(health=health):
                response, payload, calls, _ = await self.run_capture(health=health)
                self.assertEqual(response.status_code, 503)
                self.assertEqual(payload["errorCode"], "GATEWAY_UNAVAILABLE")
                self.assertEqual(payload.get("gatewayErrorCode"), expected)
                self.assertEqual("gatewayErrorCode" in payload, expected is not None)
                self.assertEqual(calls, dict.fromkeys(calls, 0))


if __name__ == "__main__":
    unittest.main()
