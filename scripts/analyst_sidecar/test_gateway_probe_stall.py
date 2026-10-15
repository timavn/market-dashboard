"""A stalled event loop must not turn a prompt IB Gateway answer into a timeout."""

import asyncio
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import threading
import time
import unittest
from unittest.mock import patch

import market
from market import IbkrReader, aclose_shared_clients, bounded_gateway_readiness


class ReadinessServer:
    """A real local /gateway-readiness endpoint with scripted answer delays.

    ``delays`` holds one entry per request (the last one repeats); ``None``
    never answers. ``heartbeat_age`` back-dates the heartbeat from the moment
    the request arrives, like a shared heartbeat served from cache.
    """

    def __init__(self, delays, *, heartbeat_age=0.0):
        self.delays = list(delays)
        self.heartbeat_age = heartbeat_age
        self.requests = 0
        self.release = threading.Event()
        self._lock = threading.Lock()
        owner = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def do_GET(self):
                with owner._lock:
                    index = owner.requests
                    owner.requests += 1
                heartbeat = datetime.now(timezone.utc) - timedelta(seconds=owner.heartbeat_age)
                delay = owner.delays[min(index, len(owner.delays) - 1)]
                if delay is None or owner.release.wait(delay):
                    owner.release.wait()
                    return
                body = json.dumps({"ok": True, "connected": True, "status": "connected",
                                   "socket_verified_at": heartbeat.isoformat().replace("+00:00", "Z")}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Cache-Control", "no-store, max-age=0")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *_args):
                pass

        class Server(ThreadingHTTPServer):
            daemon_threads = True

            def handle_error(self, *_args):
                # A probe that gave up closes its socket; that is expected here.
                pass

        self.httpd = Server(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}"
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    def close(self):
        self.release.set()
        self.httpd.shutdown()
        self.httpd.server_close()


async def stall_loop(seconds, *, after=0.005):
    """Block the event loop without holding the GIL, as a blocking call does.

    Other threads, including the probe worker and the loop-lag watchdog, keep
    running; ``hold_gil`` covers the stall that stops them too.
    """
    await asyncio.sleep(after)
    time.sleep(seconds)


def gil_hold_loops(seconds):
    """The ``sum(range(n))`` size that holds the GIL for about ``seconds`` here."""
    sample = 5_000_000
    started = time.perf_counter()
    sum(range(sample))
    return int(sample * seconds / max(time.perf_counter() - started, 1e-6))


def hold_gil(loops):
    """Hold the GIL in one C call, as decoding a multi-MB JSON payload does.

    No other Python thread runs meanwhile: not the probe worker and not the
    loop-lag watchdog. Returns the seconds it held.
    """
    started = time.monotonic()
    sum(range(loops))
    return time.monotonic() - started


class GatewayProbeStallTests(unittest.IsolatedAsyncioTestCase):
    def serve(self, delays, **kwargs):
        server = ReadinessServer(delays, **kwargs)
        self.addCleanup(server.close)
        return server

    async def asyncTearDown(self):
        await aclose_shared_clients()
        # Probe threads end on their own HTTP timeouts; never leak one into the
        # next test's busy accounting.
        deadline = time.monotonic() + 3
        while market._READINESS_IN_FLIGHT and time.monotonic() < deadline:
            await asyncio.sleep(0.01)

    async def test_answer_received_within_budget_survives_a_three_second_loop_stall(self):
        server = self.serve([0.03])
        reader = IbkrReader(base_url=server.url)
        stall = asyncio.create_task(stall_loop(3))
        started = time.monotonic()
        readiness, diagnostics = await bounded_gateway_readiness(reader.readiness, run_id="stall-ready")
        await stall
        self.assertGreaterEqual(time.monotonic() - started, 3)
        self.assertTrue(readiness["liveVerified"])
        self.assertEqual(readiness["data"], {"connected": True})
        self.assertEqual((diagnostics["verdict"], diagnostics["attempts"], diagnostics["code"]), ("ready", 1, None))
        self.assertEqual(diagnostics["bound"], "none")
        self.assertLess(diagnostics["ioMs"], 1000)
        # The stall is attributed to the loop rather than to the Gateway.
        self.assertGreater(diagnostics["loopLagMs"], 1000)
        self.assertEqual(server.requests, 1)

    async def test_receipt_time_is_the_connection_evidence_time(self):
        server = self.serve([0.03])
        before = datetime.now(timezone.utc)
        readiness = await IbkrReader(base_url=server.url).readiness()
        after = datetime.now(timezone.utc)
        self.assertTrue(readiness["liveVerified"])
        received = datetime.fromisoformat(readiness["asOf"].replace("Z", "+00:00"))
        self.assertTrue(before <= received <= after)

    async def test_worker_records_when_the_request_reached_the_service(self):
        server = self.serve([0.03])
        probe = market.GatewayProbe(market.IBKR_READINESS_TIMEOUT_SECONDS)
        started = time.monotonic()
        self.assertTrue((await IbkrReader(base_url=server.url).readiness(probe=probe))["liveVerified"])
        request = probe.request
        self.assertIsNotNone(request.sent)
        self.assertTrue(started <= request.began <= request.sent <= time.monotonic())
        self.assertLess(probe.start_delay_ms(started, time.monotonic()), 250)

    async def test_healthy_fifteen_second_heartbeat_is_not_aged_out_by_io_time(self):
        # 15.5 s old when requested, 16.3 s old when the answer arrives.
        server = self.serve([0.8], heartbeat_age=15.5)
        probe = market.GatewayProbe(market.IBKR_READINESS_TIMEOUT_SECONDS)
        readiness = await IbkrReader(base_url=server.url).readiness(probe=probe)
        self.assertTrue(readiness["liveVerified"])
        self.assertGreater(probe.heartbeat_age_ms, 16000)

    async def test_stale_heartbeat_still_cannot_prove_readiness(self):
        server = self.serve([0.01], heartbeat_age=20)
        readiness = await IbkrReader(base_url=server.url).readiness()
        self.assertFalse(readiness["liveVerified"])
        self.assertEqual(readiness["errorCode"], "IBKR_GATEWAY_NOT_VERIFIED")

    async def test_unanswered_probe_on_a_free_loop_times_out_once_within_budget(self):
        server = self.serve([None])
        reader = IbkrReader(base_url=server.url)
        started = time.monotonic()
        readiness, diagnostics = await bounded_gateway_readiness(reader.readiness, run_id="free-timeout")
        self.assertLess(time.monotonic() - started, 1.3)
        self.assertFalse(readiness["liveVerified"])
        self.assertEqual(readiness["errorCode"], "IBKR_GATEWAY_READINESS_TIMEOUT")
        self.assertEqual((diagnostics["verdict"], diagnostics["attempts"]), ("unverified", 1))
        self.assertIn(diagnostics["bound"], {"inner", "outer"})
        self.assertLess(diagnostics["loopLagMs"], 250)
        self.assertLess(diagnostics["startDelayMs"], 250)
        self.assertLess(diagnostics["busyMs"], 250)
        self.assertEqual(server.requests, 1)

    async def test_loop_stall_with_slow_gateway_is_local_contention_with_one_reprobe(self):
        server = self.serve([1.5])
        reader = IbkrReader(base_url=server.url)
        stall = asyncio.create_task(stall_loop(3))
        readiness, diagnostics = await bounded_gateway_readiness(reader.readiness, run_id="contention")
        await stall
        self.assertFalse(readiness["liveVerified"])
        self.assertEqual(readiness["errorCode"], "IBKR_GATEWAY_READINESS_TIMEOUT")
        self.assertEqual((diagnostics["verdict"], diagnostics["attempts"]), ("unverified-local-contention", 2))
        self.assertGreater(diagnostics["loopLagMs"], 250)
        self.assertEqual(server.requests, 2)

    async def test_contention_reprobe_can_verify_a_gateway_that_then_answers(self):
        server = self.serve([1.5, 0.03])
        reader = IbkrReader(base_url=server.url)
        stall = asyncio.create_task(stall_loop(3))
        readiness, diagnostics = await bounded_gateway_readiness(reader.readiness, run_id="contention-ready")
        await stall
        self.assertTrue(readiness["liveVerified"])
        self.assertEqual((diagnostics["verdict"], diagnostics["attempts"]), ("ready", 2))
        self.assertEqual(server.requests, 2)

    async def test_loop_lag_watchdog_classifies_a_stall_the_timer_did_not_overrun(self):
        # The watchdog sees a stall even when the timeout itself fired on time.
        server = self.serve([None, 0.03])
        reader = IbkrReader(base_url=server.url)
        market.loop_lag_monitor.start(asyncio.get_running_loop())
        self.addCleanup(market.loop_lag_monitor.stop)
        stall = asyncio.create_task(stall_loop(0.6, after=0.2))
        readiness, diagnostics = await bounded_gateway_readiness(reader.readiness, run_id="watchdog")
        await stall
        self.assertTrue(readiness["liveVerified"])
        self.assertEqual((diagnostics["verdict"], diagnostics["attempts"]), ("ready", 2))
        self.assertGreater(diagnostics["loopLagMs"], 250)

    async def test_gil_held_before_the_request_is_sent_is_local_contention(self):
        # The first answer comes 0.9 s after the request reaches the service,
        # which the GIL hold delays past the budget.
        server = self.serve([0.9, 0.05])
        reader = IbkrReader(base_url=server.url)
        loops = gil_hold_loops(0.9)
        start = market._start_readiness_probe
        stalls = []

        def submit_then_hold_gil(base_url, probe, function):
            if stalls:
                return start(base_url, probe, function)
            # The worker exists but cannot send until the hold ends, as when
            # it waits on the GIL; nothing lets it send before the hold starts.
            held = threading.Event()

            def after_hold(outcome):
                held.wait()
                return function(outcome)

            future = start(base_url, probe, after_hold)
            stalls.append(hold_gil(loops))
            held.set()
            return future

        market.loop_lag_monitor.start(asyncio.get_running_loop())
        self.addCleanup(market.loop_lag_monitor.stop)
        with patch.object(market, "_start_readiness_probe", side_effect=submit_then_hold_gil):
            readiness, diagnostics = await bounded_gateway_readiness(reader.readiness, run_id="gil-before-send")
        self.assertGreater(stalls[0], 0.3)
        self.assertTrue(readiness["liveVerified"])
        self.assertEqual((diagnostics["verdict"], diagnostics["attempts"], diagnostics["code"]), ("ready", 2, None))
        # The watchdog cannot run during the hold; the late request shows it.
        self.assertGreater(diagnostics["startDelayMs"], 250)
        self.assertGreater(diagnostics["busyMs"], 250)
        self.assertEqual(server.requests, 2)

    async def test_gil_held_by_another_thread_while_waiting_is_local_contention(self):
        # A to_thread decode holds the GIL. The timeout still fires on time, so
        # no loop lag shows, yet nothing could answer the check meanwhile. The
        # hold ends well inside the budget, so a busy host cannot delay the timer.
        loops = gil_hold_loops(0.5)
        calls = []

        async def reader(*, probe):
            calls.append(probe)
            if len(calls) == 1:
                threading.Thread(target=hold_gil, args=(loops,), daemon=True).start()
                await asyncio.sleep(5)
            return {"liveVerified": True, "freshness": "live", "data": {"connected": True}}

        readiness, diagnostics = await bounded_gateway_readiness(reader, run_id="gil-other-thread")
        self.assertTrue(readiness["liveVerified"])
        self.assertEqual((diagnostics["verdict"], diagnostics["attempts"]), ("ready", 2))
        self.assertLess(diagnostics["loopLagMs"], 250)
        self.assertGreater(diagnostics["busyMs"], 250)
        self.assertEqual(len(calls), 2)

    def test_start_delay_counts_only_time_before_the_request_left(self):
        probe = market.GatewayProbe(market.IBKR_READINESS_TIMEOUT_SECONDS)
        self.assertEqual(probe.start_delay_ms(10.0, 12.0), 0.0)  # the async path has no worker request
        shared = market._SharedReadinessRequest("http://127.0.0.1:1", probe)
        self.assertIs(probe.request, shared)
        self.assertEqual(probe.start_delay_ms(10.0, 10.6), 600.0)  # no worker began it
        shared.began = 10.002
        self.assertEqual(probe.start_delay_ms(10.0, 10.6), 2.0)  # still connecting is not local delay
        shared.sent = 10.4
        self.assertEqual(probe.start_delay_ms(10.0, 10.6), 400.0)
        self.assertEqual(probe.start_delay_ms(10.5, 10.6), 0.0)  # joined after it was sent

    async def started(self, server, count):
        while server.requests < count:
            await asyncio.sleep(0.005)

    async def test_check_with_every_worker_busy_joins_the_newest_request(self):
        # One worker is hung; the other is answering slowly but connected. A
        # third check must not report an unverified Gateway merely because no
        # worker was free.
        server = self.serve([None, 0.7])
        reader = IbkrReader(base_url=server.url)
        checks = []
        for index in range(market.IBKR_READINESS_PROBE_WORKERS):
            # Each request is older than the join window before the next check.
            checks.append(asyncio.create_task(bounded_gateway_readiness(reader.readiness, run_id=f"busy-{index}")))
            await self.started(server, index + 1)
            await asyncio.sleep(market.IBKR_READINESS_JOIN_SECONDS + 0.02)
        readiness, diagnostics = await bounded_gateway_readiness(reader.readiness, run_id="busy-joined")
        self.assertTrue(readiness["liveVerified"])
        self.assertEqual((diagnostics["verdict"], diagnostics["attempts"], diagnostics["bound"]), ("ready", 1, "none"))
        (_, hung), (slow, _) = await asyncio.gather(*checks)
        self.assertEqual(hung["code"], "IBKR_GATEWAY_READINESS_TIMEOUT")
        self.assertTrue(slow["liveVerified"])
        # The joined check shared the newest request instead of starting one.
        self.assertEqual(server.requests, market.IBKR_READINESS_PROBE_WORKERS)

    async def test_inherited_timeout_from_a_hung_request_gets_one_fresh_probe(self):
        server = self.serve([None, None, 0.03])
        reader = IbkrReader(base_url=server.url)
        hung = []
        for index in range(market.IBKR_READINESS_PROBE_WORKERS):
            hung.append(asyncio.create_task(reader.readiness()))
            await self.started(server, index + 1)
            await asyncio.sleep(market.IBKR_READINESS_JOIN_SECONDS + 0.02)
        started = time.monotonic()
        readiness, diagnostics = await bounded_gateway_readiness(reader.readiness, run_id="inherited")
        # The joined request timed out before this check's own budget ended,
        # which is not Gateway evidence: one fresh probe then verifies it.
        self.assertLess(time.monotonic() - started, 1.5)
        self.assertTrue(readiness["liveVerified"])
        self.assertEqual((diagnostics["verdict"], diagnostics["attempts"]), ("ready", 2))
        for result in await asyncio.gather(*hung):
            self.assertEqual(result["errorCode"], "IBKR_GATEWAY_READINESS_TIMEOUT")
        self.assertEqual(server.requests, market.IBKR_READINESS_PROBE_WORKERS + 1)

    async def test_busy_check_with_no_request_to_join_is_local_contention(self):
        probes = []

        async def reader(*, probe):
            probes.append(probe)
            if len(probes) == 1:
                probe.waited = "busy"
                return {"liveVerified": False, "errorCode": "IBKR_GATEWAY_NOT_VERIFIED"}
            return {"liveVerified": True, "freshness": "live", "data": {"connected": True}}

        readiness, diagnostics = await bounded_gateway_readiness(reader, run_id="busy-reprobe")
        self.assertTrue(readiness["liveVerified"])
        self.assertEqual((diagnostics["verdict"], diagnostics["attempts"]), ("ready", 2))

    async def test_checks_that_start_together_share_one_request(self):
        # More simultaneous checks than workers must not produce a false busy.
        server = self.serve([0.05])
        reader = IbkrReader(base_url=server.url)
        count = market.IBKR_READINESS_PROBE_WORKERS + 2
        probes = [market.GatewayProbe(market.IBKR_READINESS_TIMEOUT_SECONDS) for _ in range(count)]
        results = await asyncio.gather(*(reader.readiness(probe=probe) for probe in probes))
        self.assertTrue(all(result["liveVerified"] for result in results))
        self.assertEqual(len({result["asOf"] for result in results}), 1)
        self.assertEqual(server.requests, 1)
        self.assertTrue(all(probe.fired() == "none" and probe.io_ms is not None for probe in probes))

    async def test_unreachable_service_is_unverified_without_a_reprobe(self):
        server = self.serve([0.01])
        url = server.url
        server.close()
        readiness, diagnostics = await bounded_gateway_readiness(IbkrReader(base_url=url).readiness)
        self.assertEqual(readiness["errorCode"], "IBKR_SERVICE_UNAVAILABLE")
        self.assertEqual((diagnostics["verdict"], diagnostics["attempts"], diagnostics["bound"]),
                         ("unverified", 1, "none"))


if __name__ == "__main__":
    unittest.main()
