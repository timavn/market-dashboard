"""Large saved-report responses cannot starve the connection readiness check."""

import os as _isolation_os
import tempfile as _isolation_tempfile

# Importing app opens its stores and fails in-flight reviews; never touch the live data directory.
_APP_DATA_DIR = _isolation_tempfile.TemporaryDirectory(prefix="analyst-workspace-response-latency-test-")
_isolation_os.environ.setdefault("ANALYST_DATA_DIR", _APP_DATA_DIR.name)
_isolation_os.environ.setdefault("ANALYST_TEXTRACT_FALLBACK", "false")

import asyncio
import json
import threading
import unittest
from unittest.mock import AsyncMock, patch

import app as analyst_app


class WorkspaceResponseLatencyTests(unittest.IsolatedAsyncioTestCase):
    async def test_gateway_probe_finishes_while_report_encoding_is_pending(self):
        encoding = threading.Event()
        release = threading.Event()
        response_class = analyst_app.JSONResponse
        payload = {"conversation": {"id": "saved-review", "messages": [
            {"text": "Exact captured evidence", "created_at": "2026-10-09T19:00:00Z"}]}}

        def encode(value, **kwargs):
            encoding.set()
            release.wait(1)
            return response_class(value, **kwargs)

        request = AsyncMock()
        request.path_params = {"operation": "get"}
        request.json.return_value = {"conversationId": "saved-review", "includeBriefs": False}
        readiness = AsyncMock(return_value={"status": "available", "liveVerified": True,
            "freshness": "live", "data": {"connected": True}})
        context = AsyncMock()
        with patch.object(analyst_app.workspace_store, "dispatch", return_value=payload), \
                patch.object(analyst_app, "JSONResponse", side_effect=encode):
            response_task = asyncio.create_task(analyst_app.workspace_route(request))
            try:
                self.assertTrue(await asyncio.wait_for(asyncio.to_thread(encoding.wait, 1), 1.2))
                result = await asyncio.wait_for(analyst_app._capture_ib_gateway_readiness(context, readiness), 0.2)
                self.assertTrue(result["liveVerified"])
                self.assertFalse(response_task.done())
            finally:
                release.set()
                response = await response_task
        self.assertEqual(json.loads(response.body), payload)
        self.assertEqual(response.headers["Cache-Control"], "no-store")
        context.checkpoint.assert_awaited_once()


if __name__ == "__main__":
    unittest.main()
