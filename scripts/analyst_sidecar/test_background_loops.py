"""A failed pass of a background loop must not end the loop."""
from __future__ import annotations

import asyncio
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch


SIDECAR_DIR = Path(__file__).resolve().parent
if str(SIDECAR_DIR) not in sys.path:
    sys.path.insert(0, str(SIDECAR_DIR))

# Importing app opens its stores; never inherit the live data directory.
_APP_DATA_DIR = tempfile.TemporaryDirectory(prefix="analyst-loop-test-")
os.environ.setdefault("ANALYST_DATA_DIR", _APP_DATA_DIR.name)
os.environ.setdefault("ANALYST_TEXTRACT_FALLBACK", "false")

import app as analyst_app  # noqa: E402


class IndexingLoopTest(unittest.IsolatedAsyncioTestCase):
    async def test_one_failed_pass_does_not_stop_research_indexing(self):
        passes = []

        def sweep_due():
            passes.append(len(passes))
            if len(passes) == 1:
                raise sqlite3.OperationalError("database is locked")
            return False

        waits = []

        async def wait(seconds):
            waits.append(seconds)
            if len(waits) >= 4:
                raise asyncio.CancelledError()

        with patch.object(analyst_app, "feed_sweep_due", sweep_due), \
                patch.object(analyst_app.asyncio, "sleep", wait), \
                self.assertLogs(analyst_app.LOGGER, level="WARNING") as logged:
            with self.assertRaises(asyncio.CancelledError):
                await analyst_app.indexing_loop()

        # The pass after the failure still ran, and the failure was reported.
        self.assertGreaterEqual(len(passes), 3)
        self.assertIn("OperationalError", logged.output[0])


if __name__ == "__main__":
    unittest.main()
