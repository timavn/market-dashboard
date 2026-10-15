import asyncio
import io
import json
import math
from pathlib import Path
import sys
import subprocess
import tempfile
import threading
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import pymupdf as fitz
from local_http_trust import local_request_allowed
import pdf_worker_client as client
from pdf_worker import MAX_EDGE, MAX_PIXELS, render_scale


def sample_pdf(width=595, height=842):
    with fitz.open() as document:
        page = document.new_page(width=width, height=height)
        page.insert_text((72, 72), "A sourced research page with sufficient searchable words.")
        return document.tobytes()


class PdfWorkerTests(unittest.TestCase):
    def test_native_stdout_cannot_corrupt_worker_error_protocol(self):
        with tempfile.TemporaryDirectory() as directory:
            Path(directory, "pymupdf.py").write_text(
                'import os\n'
                'print("import diagnostic", flush=True)\n'
                'os.write(1, b"native import diagnostic\\n")\n'
                'def open(path):\n'
                '    os.write(1, b"native parser diagnostic\\n")\n'
                '    raise ValueError("invalid_page")\n'
            )
            worker = str(Path(__file__).with_name("pdf_worker.py"))
            command = (
                'import runpy,sys; sys.path.insert(0,sys.argv[1]); '
                'sys.argv=sys.argv[2:]; runpy.run_path(sys.argv[0],run_name="__main__")'
            )
            result = subprocess.run(
                [sys.executable, "-I", "-c", command, directory, worker,
                 "render", "unused.pdf", "unused.png", "1"],
                capture_output=True, text=True, timeout=10,
            )
            self.assertEqual(result.returncode, 2)
            self.assertEqual(json.loads(result.stdout), {"code": "invalid_page"})
            self.assertIn("native import diagnostic", result.stderr)
            self.assertIn("native parser diagnostic", result.stderr)

    def test_geometry_budget_precedes_raster_allocation(self):
        for width, height in [(595, 842), (100_000, 100_000), (1_000_000, 100)]:
            scale = render_scale(width, height)
            self.assertLessEqual(math.ceil(width * scale), MAX_EDGE)
            self.assertLessEqual(math.ceil(height * scale), MAX_EDGE)
            self.assertLessEqual(math.ceil(width * scale) * math.ceil(height * scale), MAX_PIXELS)
        for dimension in [0, -1, float("nan"), float("inf")]:
            with self.assertRaises(ValueError):
                render_scale(dimension, 842)

    def test_real_worker_extracts_and_downscales_large_page(self):
        data = sample_pdf(100_000, 100_000)
        extracted = json.loads(client.native_pdf(data, "extract", 500))
        self.assertEqual(extracted["pageCount"], 1)
        self.assertIn("sourced", extracted["pages"][0]["text"])
        rendered = fitz.Pixmap(client.native_pdf(data, "render", 1))
        self.assertLessEqual(rendered.width * rendered.height, MAX_PIXELS)
        self.assertLessEqual(max(rendered.width, rendered.height), MAX_EDGE)

    def test_timeout_memory_failure_and_queue_saturation_are_recoverable(self):
        data = sample_pdf()
        with self.assertRaises(client.PdfWorkerError) as timed_out:
            client.native_pdf(data, "extract", 500, timeout=0)
        self.assertEqual(timed_out.exception.code, "pdf_worker_timeout")
        with patch.object(client, "worker_rss_bytes", return_value=client.MAX_WORKER_RSS_BYTES + 1):
            with self.assertRaises(client.PdfWorkerError) as oversized:
                client.native_pdf(data, "extract", 500)
        self.assertEqual(oversized.exception.code, "pdf_worker_memory_limit")
        for _ in range(3):
            client._admission.acquire()
        try:
            with self.assertRaises(client.PdfWorkerError) as busy:
                client.native_pdf(data, "extract", 500)
            self.assertEqual(busy.exception.code, "pdf_worker_busy")
        finally:
            for _ in range(3):
                client._admission.release()
        self.assertEqual(json.loads(client.native_pdf(data, "extract", 500))["pageCount"], 1)

    def test_cancellation_kills_worker_and_does_not_block_event_loop(self):
        started = threading.Event()
        killed = threading.Event()

        class StalledWorker:
            pid = 1
            returncode = None
            stdout = io.BytesIO()

            def poll(self):
                started.set()
                return self.returncode

            def kill(self):
                self.returncode = -9
                killed.set()

            def wait(self, timeout=None):
                return self.returncode

        async def exercise():
            task = asyncio.create_task(client.run_pdf_operation(client.native_pdf, b"%PDF-stalled", "extract", 500))
            while not started.is_set():
                await asyncio.sleep(0.01)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
            self.assertTrue(await asyncio.to_thread(killed.wait, 2))

        with patch.object(client.subprocess, "Popen", return_value=StalledWorker()), patch.object(client, "worker_rss_bytes", return_value=0):
            asyncio.run(exercise())


class LocalTrustTests(unittest.TestCase):
    def test_sidecar_accepts_local_service_and_rejects_browser_rebinding(self):
        scope = {"client": ("127.0.0.1", 1000), "server": ("127.0.0.1", 6951), "headers": [(b"host", b"127.0.0.1:6951")]}
        self.assertTrue(local_request_allowed(scope))
        self.assertTrue(local_request_allowed({**scope, "headers": scope["headers"] + [
            (b"origin", b"http://localhost:3000"), (b"sec-fetch-site", b"same-site"),
        ]}))
        for headers in [
            [(b"host", b"untrusted.example:6951")],
            [(b"host", b"127.0.0.1:6951"), (b"origin", b"null")],
            [(b"host", b"127.0.0.1:6951"), (b"sec-fetch-site", b"cross-site")],
            [(b"host", b"127.0.0.1:6951"), (b"origin", b"http://localhost:3000"), (b"sec-fetch-site", b"cross-site")],
        ]:
            self.assertFalse(local_request_allowed({**scope, "headers": headers}))
        self.assertFalse(local_request_allowed({**scope, "client": ("192.168.1.2", 1000)}))


if __name__ == "__main__":
    unittest.main()
