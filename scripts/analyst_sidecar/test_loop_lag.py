import asyncio
import time
import unittest
from unittest.mock import patch

from loop_lag import LoopLagMonitor


class LoopLagMonitorTests(unittest.IsolatedAsyncioTestCase):
    async def test_measures_a_synchronous_stall_on_the_loop(self):
        monitor = LoopLagMonitor(interval=0.02, warn_ms=10_000)
        monitor.start(asyncio.get_running_loop())
        try:
            await asyncio.sleep(0.1)
            started = time.monotonic()
            time.sleep(0.4)  # blocks the event loop
            await asyncio.sleep(0.05)
            self.assertGreaterEqual(monitor.max_lag_ms(started), 300)
        finally:
            monitor.stop()

    async def test_a_free_loop_reports_little_lag(self):
        monitor = LoopLagMonitor(interval=0.02, warn_ms=10_000)
        monitor.start(asyncio.get_running_loop())
        try:
            started = time.monotonic()
            await asyncio.sleep(0.2)
            self.assertLess(monitor.max_lag_ms(started), 100)
        finally:
            monitor.stop()

    async def test_counts_a_stall_that_is_still_in_progress(self):
        monitor = LoopLagMonitor(interval=0.02, warn_ms=10_000)
        monitor.start(asyncio.get_running_loop())
        try:
            await asyncio.sleep(0.1)
            started = time.monotonic()
            time.sleep(0.3)
            # Read before the loop drains the queued pings.
            self.assertGreaterEqual(monitor.max_lag_ms(started), 200)
        finally:
            monitor.stop()

    async def test_counts_a_gil_holding_thread_that_starves_the_watchdog(self):
        monitor = LoopLagMonitor(interval=0.02, warn_ms=10_000)
        monitor.start(asyncio.get_running_loop())
        try:
            await asyncio.sleep(0.1)
            started = time.monotonic()
            # Pure-Python work in a worker thread holds the GIL in 5 ms slices;
            # the watchdog must see its own wake-ups arriving late.
            await asyncio.to_thread(lambda: sum(i * i for i in range(6_000_000)))
            self.assertGreater(monitor.max_lag_ms(started), 0)
        finally:
            monitor.stop()

    async def test_one_stall_logs_one_warning_with_its_largest_lag(self):
        monitor = LoopLagMonitor(interval=0.02, warn_ms=100)
        monitor.start(asyncio.get_running_loop())
        try:
            await asyncio.sleep(0.1)
            with self.assertLogs("analyst.loop_lag", "WARNING") as logged:
                time.sleep(1.0)  # every queued ping is acknowledged late at once
                await asyncio.sleep(0.2)
        finally:
            monitor.stop()
        lines = [line for line in logged.output if "event loop lag" in line]
        self.assertEqual(len(lines), 1, logged.output)
        largest = float(lines[0].split("max ")[1].split(" ms")[0])
        self.assertGreaterEqual(largest, 800)
        self.assertGreater(int(lines[0].split("over ")[1].split(" samples")[0]), 1)

    def test_a_persistent_stall_reports_once_per_interval_and_when_it_ends(self):
        monitor = LoopLagMonitor(warn_ms=100, warn_interval=5.0)
        with patch("loop_lag.time.monotonic", side_effect=[0.0, 1.0, 2.0, 5.0, 6.0, 7.0]), \
                self.assertLogs("analyst.loop_lag", "WARNING") as logged:
            for lag in (300, 400, 350, 500, 300, 50):
                monitor._record(0.0, lag)
        self.assertEqual(logged.output, [
            "WARNING:analyst.loop_lag:event loop lag max 500 ms over 4 samples",
            "WARNING:analyst.loop_lag:event loop lag max 300 ms over 1 samples",
        ])
        # Every sample still counts toward the lag a readiness check reads.
        self.assertEqual(len(monitor._samples), 6)

    def test_late_watchdog_wakes_log_their_own_line_and_on_time_wakes_end_them(self):
        monitor = LoopLagMonitor(warn_ms=100)
        now = time.monotonic()
        with self.assertLogs("analyst.loop_lag", "WARNING") as logged:
            monitor._record(now, 400, "watchdog")
            monitor._record(now, 0.2, "watchdog")
        self.assertEqual(logged.output, ["WARNING:analyst.loop_lag:loop-lag watchdog woke late max 400 ms over 1 samples"])
        self.assertEqual([lag for _sent, lag in monitor._samples], [400])


if __name__ == "__main__":
    unittest.main()
