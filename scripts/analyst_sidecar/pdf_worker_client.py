"""Bounded admission, cancellation and process containment for native PDFs."""
from __future__ import annotations

import asyncio
import contextvars
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time

MAX_WORKER_RSS_BYTES = 512 * 1024 * 1024
MAX_OUTPUT_BYTES = 32 * 1024 * 1024
_admission = threading.BoundedSemaphore(3)  # One running, at most two waiting.
_active = threading.Lock()
_cancellation = contextvars.ContextVar("pdf_cancellation", default=None)


class PdfWorkerError(ValueError):
    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code.replace("_", " "))


async def run_pdf_operation(function, *args, **kwargs):
    cancellation = threading.Event()
    token = _cancellation.set(cancellation)
    try:
        return await asyncio.to_thread(function, *args, **kwargs)
    except asyncio.CancelledError:
        cancellation.set()
        raise
    finally:
        _cancellation.reset(token)


def check_cancelled() -> None:
    event = _cancellation.get()
    if event is not None and event.is_set():
        raise PdfWorkerError("pdf_cancelled")


def worker_rss_bytes(pid: int) -> int:
    if sys.platform.startswith("linux"):
        try:
            for line in Path(f"/proc/{pid}/status").read_text().splitlines():
                if line.startswith("VmRSS:"):
                    return int(line.split()[1]) * 1024
        except FileNotFoundError:
            return 0
    result = subprocess.run(["/bin/ps", "-o", "rss=", "-p", str(pid)], capture_output=True, text=True, timeout=1)
    return int(result.stdout.strip() or "0") * 1024


def native_pdf(data: bytes, operation: str, argument: int, *, timeout: float | None = None) -> bytes:
    if operation not in {"extract", "render"}:
        raise PdfWorkerError("pdf_invalid_operation")
    if not _admission.acquire(blocking=False):
        raise PdfWorkerError("pdf_worker_busy")
    acquired = False
    try:
        queue_deadline = time.monotonic() + 60
        while not acquired:
            check_cancelled()
            acquired = _active.acquire(timeout=0.1)
            if not acquired and time.monotonic() >= queue_deadline:
                raise PdfWorkerError("pdf_worker_busy")
        check_cancelled()
        with tempfile.TemporaryDirectory(prefix="market-dashboard-pdf-") as directory:
            input_path = Path(directory) / "input.pdf"
            output_path = Path(directory) / "output"
            input_path.touch(mode=0o600); input_path.write_bytes(data)
            output_path.touch(mode=0o600)
            # -I ignores PYTHONPATH/user site packages. Do not pass AWS, model,
            # service tokens, HOME, proxy credentials or application settings.
            environment = {name: os.environ[name] for name in ("PATH", "LANG", "LC_ALL", "TMPDIR", "SYSTEMROOT") if name in os.environ}
            command = [sys.executable, "-I", str(Path(__file__).with_name("pdf_worker.py")), operation, str(input_path), str(output_path), str(argument)]
            process = subprocess.Popen(command, env=environment, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, start_new_session=True)
            deadline = time.monotonic() + (timeout if timeout is not None else 60 if operation == "extract" else 15)
            try:
                while process.poll() is None:
                    check_cancelled()
                    if time.monotonic() >= deadline:
                        raise PdfWorkerError("pdf_worker_timeout")
                    if worker_rss_bytes(process.pid) > MAX_WORKER_RSS_BYTES:
                        raise PdfWorkerError("pdf_worker_memory_limit")
                    if output_path.stat().st_size > MAX_OUTPUT_BYTES:
                        raise PdfWorkerError("pdf_output_oversize")
                    time.sleep(0.05)
                if process.returncode != 0:
                    detail = process.stdout.read(1024)
                    try:
                        code = json.loads(detail).get("code", "pdf_worker_failed")
                    except (ValueError, AttributeError):
                        code = "pdf_worker_failed"
                    raise PdfWorkerError(str(code)[:100])
                if output_path.stat().st_size > MAX_OUTPUT_BYTES:
                    raise PdfWorkerError("pdf_output_oversize")
                return output_path.read_bytes()
            finally:
                if process.poll() is None:
                    process.kill()
                process.wait(timeout=5)
                process.stdout.close()
    finally:
        if acquired:
            _active.release()
        _admission.release()
