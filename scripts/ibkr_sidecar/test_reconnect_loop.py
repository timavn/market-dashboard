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
