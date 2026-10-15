"""Review connection checks stay independent of subscription/acquisition locks."""

import asyncio
from datetime import datetime, timezone
import json
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch

import app
from gateway_connection_governor import GatewayConnectionGovernor


class GatewayReadinessEndpointTests(unittest.IsolatedAsyncioTestCase):
    async def test_readiness_does_not_queue_behind_stream_resubscription_or_return_accounts(self):
        session = SimpleNamespace(
            isConnected=lambda: True,
            client=SimpleNamespace(conn=SimpleNamespace(transport=object())),
            reqCurrentTimeAsync=AsyncMock(return_value=datetime.now(timezone.utc)),
            managedAccounts=lambda: ["PRIVATE"],
            disconnect=Mock(),
        )
        governor = GatewayConnectionGovernor(host="127.0.0.1", port=4002,
                                            connect_timeout=0.1, verify_timeout=0.1, heartbeat_ttl=15)
        await governor.ensure_session("primary", session, client_id=17, primary=True)
        observed = governor._verification_cache[id(session)]["payload"]["socketVerifiedAt"]
        lock = asyncio.Lock()
        await lock.acquire()
        stream = SimpleNamespace(_connect_lock=lock, ensure_connected=AsyncMock())
        try:
            with patch.object(app, "ib", session), patch.object(app, "gateway_governor", governor), \
                    patch.object(app, "stream_manager", stream), patch.object(app, "ensure_connected", new=AsyncMock()) as full_status:
                response = await asyncio.wait_for(app.gateway_readiness(), 0.05)
                full_status.assert_not_awaited()
        finally:
            lock.release()
        self.assertEqual(json.loads(response.body), {"ok": True, "connected": True, "status": "connected",
                                                     "socket_verified_at": observed})
        self.assertEqual(response.headers["Cache-Control"], "no-store, max-age=0")
        stream.ensure_connected.assert_not_awaited()
        session.reqCurrentTimeAsync.assert_awaited_once()


if __name__ == "__main__":
    unittest.main()
