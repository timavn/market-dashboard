"""Measure event-loop lag from a watchdog thread so stalls are attributable.

A stalled loop cannot time itself: its own timers fire late. A separate thread
pings the loop and records how long each ping waited before the loop ran it.
"""

from __future__ import annotations

import asyncio
from collections import deque
import logging
import threading
import time
from typing import Optional

LOGGER = logging.getLogger("analyst.loop_lag")


# One line per stall: a stall queues a ping every interval, and each is
# acknowledged late together. A stall that persists reports at this cadence.
_WARNINGS = {"loop": "event loop lag max %.0f ms over %d samples",
             "watchdog": "loop-lag watchdog woke late max %.0f ms over %d samples"}


class LoopLagMonitor:
    def __init__(self, *, interval: float = 0.1, warn_ms: float = 250.0, history_seconds: float = 300.0,
                 warn_interval: float = 5.0):
        self.interval = interval
        self.warn_ms = warn_ms
        self.history_seconds = history_seconds
        self.warn_interval = warn_interval
        self._lock = threading.Lock()
        # Open stall episodes by kind: [first lagging sample time, max lag, count].
        self._stalls: dict[str, list[float]] = {}
        self._samples: deque[tuple[float, float]] = deque()
        self._pending: dict[int, float] = {}
        self._next_id = 0
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None

    def start(self, loop: asyncio.AbstractEventLoop) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._loop = loop
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name="analyst-loop-lag", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=1.0)
        self._thread = None
        with self._lock:
            stalls, self._stalls = self._stalls, {}
        for kind, (_started, lag_ms, count) in stalls.items():
            LOGGER.warning(_WARNINGS[kind], lag_ms, count)

    def _run(self) -> None:
        expected_wake = time.monotonic() + self.interval
        while not self._stop.wait(max(0.0, expected_wake - time.monotonic())):
            # A thread holding the GIL also delays this watchdog; count its lateness.
            self._record(expected_wake, (time.monotonic() - expected_wake) * 1000.0, "watchdog")
            expected_wake = time.monotonic() + self.interval
            loop = self._loop
            if loop is None or loop.is_closed():
                return
            with self._lock:
                ping_id = self._next_id
                self._next_id += 1
                sent = time.monotonic()
                self._pending[ping_id] = sent
            try:
                loop.call_soon_threadsafe(self._ack, ping_id)
            except RuntimeError:
                return

    def _ack(self, ping_id: int) -> None:
        received = time.monotonic()
        with self._lock:
            sent = self._pending.pop(ping_id, None)
        if sent is not None:
            self._record(sent, max(0.0, (received - sent) * 1000.0))

    def _record(self, sent: float, lag_ms: float, kind: str = "loop") -> None:
        now = time.monotonic()
        report = None
        with self._lock:
            if kind == "loop" or lag_ms >= 1.0:
                self._samples.append((sent, lag_ms))
            horizon = now - self.history_seconds
            while self._samples and self._samples[0][0] < horizon:
                self._samples.popleft()
            # Every sample counts toward max_lag_ms; a stall logs one line when
            # it ends, or once per warn_interval while it persists.
            stall = self._stalls.get(kind)
            if lag_ms >= self.warn_ms:
                if stall is None:
                    stall = self._stalls[kind] = [now, 0.0, 0]
                stall[1] = max(stall[1], lag_ms)
                stall[2] += 1
                if now - stall[0] >= self.warn_interval:
                    report = self._stalls.pop(kind)
            elif stall is not None:
                report = self._stalls.pop(kind)
        if report:
            LOGGER.warning(_WARNINGS[kind], report[1], report[2])

    def max_lag_ms(self, since: float) -> float:
        """Largest lag observed for pings sent at or after ``since`` (time.monotonic()).

        Includes pings the loop has not run yet, so an in-progress stall counts.
        """
        now = time.monotonic()
        with self._lock:
            observed = [lag for sent, lag in self._samples if sent >= since - self.interval]
            observed.extend((now - sent) * 1000.0 for sent in self._pending.values() if sent >= since - self.interval)
        return round(max(observed, default=0.0), 1)


monitor = LoopLagMonitor()
