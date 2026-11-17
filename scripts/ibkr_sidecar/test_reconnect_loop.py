"""One failed connect attempt must not end automatic reconnection."""
import asyncio
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent))

from stream_manager import StreamManager


class ReconnectLoopTest(unittest.IsolatedAsyncioTestCase):
    async def test_an_exception_from_connect_is_reported_and_retried(self):
        manager = StreamManager.__new__(StreamManager)
        manager._started = True
        manager.connected = False
        manager.reconnecting = False
        manager.last_error = None
        manager.ib = SimpleNamespace(isConnected=lambda: False)
        statuses = []
        manager._broadcast_status = lambda status, message: statuses.append((status, message))
        warmed = []

        async def pre_warm():
            warmed.append(True)

        manager._pre_warm_portfolio = pre_warm
        attempts = []

        async def connect():
            attempts.append(len(attempts))
            if len(attempts) == 1:
                raise ConnectionError("Not connected")
            manager.connected = True
            manager.ib = SimpleNamespace(isConnected=lambda: True)
            manager._started = False  # let the loop end after the successful attempt
            return {"ok": True}

        manager.connect = connect
        real_sleep = asyncio.sleep

        async def fast_sleep(_seconds):
            await real_sleep(0)

        import stream_manager
        original = stream_manager.asyncio.sleep
        stream_manager.asyncio.sleep = fast_sleep
        try:
            await asyncio.wait_for(manager._reconnect_loop(), timeout=2)
            await real_sleep(0)
        finally:
            stream_manager.asyncio.sleep = original

        self.assertEqual(len(attempts), 2)
        self.assertEqual(statuses[0], ("reconnecting", "Not connected"))
        self.assertEqual(statuses[-1], ("connected", None))
        self.assertEqual(manager.last_error, "Not connected")


if __name__ == "__main__":
    unittest.main()


class PortfolioWarmupTest(unittest.IsolatedAsyncioTestCase):
    """The portfolio's positions are subscribed even when the first attempt fails."""

    def manager(self, accounts):
        manager = StreamManager.__new__(StreamManager)
        manager.connected = True
        manager._connection_generation = 3
        manager._subscription_owners = {}
        manager._portfolio_positions = {}
        manager.ib = SimpleNamespace(managedAccounts=lambda: list(accounts))
        return manager

    async def run_warmup(self, manager):
        import stream_manager
        real_sleep = asyncio.sleep
        pauses = []

        async def fast_sleep(seconds):
            pauses.append(seconds)
            await real_sleep(0)

        original = stream_manager.asyncio.sleep
        stream_manager.asyncio.sleep = fast_sleep
        try:
            await asyncio.wait_for(manager._pre_warm_portfolio(), timeout=2)
        finally:
            stream_manager.asyncio.sleep = original
        return pauses

    async def test_a_timed_out_first_attempt_is_tried_again_until_the_positions_are_subscribed(self):
        manager = self.manager(["ACCT-A", "ACCT-B"])
        attempts = []

        async def ensure(acct):
            attempts.append(acct)
            # The first two attempts for the first account hit a busy Gateway.
            if acct == "ACCT-A" and attempts.count("ACCT-A") < 3:
                raise asyncio.TimeoutError()
            manager._subscription_owners[f"portfolio:{acct}"] = {1, 2}

        manager._ensure_portfolio_stream = ensure
        pauses = await self.run_warmup(manager)

        self.assertEqual(attempts, ["ACCT-A", "ACCT-B", "ACCT-A", "ACCT-A"])
        self.assertEqual(pauses, [1.0, 5.0, 10.0])
        self.assertEqual(sorted(manager._subscription_owners), ["portfolio:ACCT-A", "portfolio:ACCT-B"])

    async def test_a_partly_subscribed_book_is_tried_again(self):
        manager = self.manager(["ACCT-A"])
        manager._portfolio_positions = {"ACCT-A": {101: {}, 102: {}, 103: {}}}
        attempts = []

        async def ensure(acct):
            attempts.append(acct)
            # The first pass lost one contract lookup to a timeout.
            manager._subscription_owners[f"portfolio:{acct}"] = {101, 102} if len(attempts) == 1 else {101, 102, 103}

        manager._ensure_portfolio_stream = ensure
        pauses = await self.run_warmup(manager)

        self.assertEqual(attempts, ["ACCT-A", "ACCT-A"])
        self.assertEqual(pauses, [1.0, 5.0])

    async def test_one_clean_attempt_does_not_repeat(self):
        manager = self.manager(["ACCT-A"])
        attempts = []

        async def ensure(acct):
            attempts.append(acct)
            manager._subscription_owners[f"portfolio:{acct}"] = set()  # an account with no positions

        manager._ensure_portfolio_stream = ensure
        pauses = await self.run_warmup(manager)

        self.assertEqual(attempts, ["ACCT-A"])
        self.assertEqual(pauses, [1.0])

    async def test_retries_stop_with_the_connection_they_belong_to(self):
        manager = self.manager(["ACCT-A"])
        attempts = []

        async def ensure(acct):
            attempts.append(acct)
            manager._connection_generation += 1  # the Gateway dropped; a new connect warms up again
            raise asyncio.TimeoutError()

        manager._ensure_portfolio_stream = ensure
        await self.run_warmup(manager)
        self.assertEqual(attempts, ["ACCT-A"])

    async def test_it_gives_up_after_the_last_pause_without_raising(self):
        manager = self.manager(["ACCT-A"])
        attempts = []

        async def ensure(acct):
            attempts.append(acct)
            raise RuntimeError("positions request failed")

        manager._ensure_portfolio_stream = ensure
        pauses = await self.run_warmup(manager)
        self.assertEqual(len(attempts), 7)
        self.assertEqual(pauses, [1.0, 5.0, 10.0, 20.0, 40.0, 60.0, 60.0])
