import asyncio
import json
import unittest
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

import app


def fill(exec_id, account="TEST", *, side="BOT", shares=10, price=50.0, matched=True):
    contract = SimpleNamespace(conId=123, symbol="IGV", localSymbol="IGV", secType="STK", exchange="SMART")
    execution = SimpleNamespace(execId=exec_id, acctNumber=account, side=side, shares=shares, price=price,
                                orderId=1, permId=10, clientId=42, cumQty=shares, avgPrice=price)
    # ib_insync supplies a blank report until the broker's own arrives; only a matched one is evidence.
    report = SimpleNamespace(execId=exec_id if matched else "", commission=1.25, currency="USD", realizedPNL=12.5)
    return SimpleNamespace(contract=contract, execution=execution, commissionReport=report,
                           time=datetime(2026, 11, 20, 15, 0, tzinfo=timezone.utc))


class ExecutionsEndpointTests(unittest.IsolatedAsyncioTestCase):
    def broker(self, fills, accounts=("TEST",)):
        broker = Mock()
        broker.managedAccounts.return_value = list(accounts)
        broker.reqExecutionsAsync = AsyncMock(side_effect=lambda execution_filter: [
            row for row in fills if row.execution.acctNumber == execution_filter.acctCode])
        return broker

    async def read(self, broker, account=None, health=None):
        with patch.object(app, "ib", broker), patch.object(app, "ensure_connected", AsyncMock(return_value=health or {"ok": True})):
            response = await app.portfolio_executions(account=account)
        self.assertEqual(response.headers["cache-control"], "no-store")
        return json.loads(response.body)

    async def test_fresh_fills_carry_side_price_and_only_matched_commission_reports(self):
        data = await self.read(self.broker([fill("e1"), fill("e2", side="SLD", matched=False)]))
        self.assertTrue(data["ok"] and data["liveVerified"] and data["complete"])
        self.assertEqual((data["source"], data["from_cache"]), ("ibkr_executions", False))
        first, second = data["executions"]
        self.assertEqual((first["execId"], first["conId"], first["side"], first["shares"], first["price"]), ("e1", 123, "BOT", 10, 50.0))
        self.assertEqual((first["commission"], first["realizedPNL"]), (1.25, 12.5))
        self.assertEqual(first["executionTime"][:19], "2026-11-20T15:00:00")
        self.assertNotIn("commission", second)
        self.assertNotIn("realizedPNL", second)

    async def test_a_day_with_no_fills_is_a_verified_empty_list(self):
        data = await self.read(self.broker([]))
        self.assertTrue(data["complete"] and data["liveVerified"])
        self.assertEqual(data["executions"], [])

    async def test_every_managed_account_is_read_and_one_can_be_selected(self):
        broker = self.broker([fill("e1", "A"), fill("e2", "B")], accounts=("A", "B"))
        self.assertEqual([row["execId"] for row in (await self.read(broker))["executions"]], ["e1", "e2"])
        self.assertEqual([row["execId"] for row in (await self.read(broker, account="B"))["executions"]], ["e2"])
        unknown = await self.read(broker, account="C")
        self.assertFalse(unknown["liveVerified"])
        self.assertEqual(unknown["executions"], [])

    async def test_disconnection_timeout_or_a_foreign_account_yields_no_fills(self):
        offline = await self.read(self.broker([fill("e1")]), health={"ok": False, "status": "disconnected"})
        self.assertFalse(offline["liveVerified"] or offline["complete"])
        slow = self.broker([])
        slow.reqExecutionsAsync = AsyncMock(side_effect=asyncio.TimeoutError)
        timed_out = await self.read(slow)
        self.assertEqual((timed_out["liveVerified"], timed_out["executions"], timed_out["errorCode"]), (False, [], "EXECUTIONS_TIMEOUT"))
        foreign = self.broker([])
        foreign.reqExecutionsAsync = AsyncMock(return_value=[fill("e9", "OTHER")])
        mixed = await self.read(foreign)
        self.assertEqual((mixed["liveVerified"], mixed["executions"], mixed["errorCode"]), (False, [], "EXECUTION_ACCOUNT_MISMATCH"))


if __name__ == "__main__":
    unittest.main()
