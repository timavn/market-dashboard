import asyncio
import json
import tempfile
import time
import unittest
from datetime import date, datetime, timedelta, timezone
from types import SimpleNamespace
from pathlib import Path

from ib_insync import Contract

import app
from stream_manager import StreamManager


BROKER_TIME = datetime(2026, 7, 25, 15, 0, tzinfo=timezone.utc)


def stock_position(account, con_id, symbol=None, quantity=1):
    symbol = symbol or f"S{con_id}"
    return SimpleNamespace(
        account=account,
        position=quantity,
        avgCost=50.0,
        contract=Contract(
            conId=con_id,
            symbol=symbol,
            localSymbol=symbol,
            secType="STK",
            exchange="SMART",
            currency="USD",
        ),
    )


def completed_bars(offset=0):
    return [
        SimpleNamespace(date=date(2026, 7, 23), close=100.0 + offset),
        SimpleNamespace(date=date(2026, 7, 24), close=101.0 + offset),
    ]


class FakeBroker:
    def __init__(
        self,
        *,
        positions=None,
        history=None,
        accounts=None,
        gateway_time=BROKER_TIME,
    ):
        self.connected = True
        self._positions = list(positions or [])
        self._history = {
            int(con_id): list(results)
            for con_id, results in (history or {}).items()
        }
        self._accounts = list(accounts or ["U1"])
        self._gateway_time = gateway_time
        self.current_time_requests = 0
        self.history_requests = []
        self.active_history_requests = 0
        self.max_active_history_requests = 0

    def isConnected(self):
        return self.connected

    async def reqCurrentTimeAsync(self):
        self.current_time_requests += 1
        await asyncio.sleep(0)
        return self._gateway_time

    def managedAccounts(self):
        return self._accounts

    def positions(self):
        return self._positions

    async def reqPositionsAsync(self):
        await asyncio.sleep(0)
        return self._positions

    async def reqHistoricalDataAsync(self, contract, **kwargs):
        con_id = int(contract.conId)
        self.history_requests.append((con_id, kwargs))
        self.active_history_requests += 1
        self.max_active_history_requests = max(
            self.max_active_history_requests,
            self.active_history_requests,
        )
        try:
            await asyncio.sleep(0)
            planned = self._history.get(con_id, [completed_bars()])
            result = planned.pop(0) if planned else completed_bars()
            if result == "disconnect":
                self.connected = False
                return completed_bars()
            if isinstance(result, BaseException):
                raise result
            return result
        finally:
            self.active_history_requests -= 1


class FakeStreamManager:
    def __init__(self, primary, live_marks=None):
        self.primary = primary
        self.live_marks = live_marks or {}
        self.connection_generation = 1

    async def ensure_connected(self):
        return {
            "ok": self.primary.isConnected(),
            "status": "connected" if self.primary.isConnected() else "offline",
        }

    def get_fresh_direct_live_marks(self, con_ids, *, max_age_seconds):
        return {
            con_id: self.live_marks[con_id]
            for con_id in con_ids
            if con_id in self.live_marks
        }


class ReferenceMarksAsyncTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.originals = {
            "ib": app.ib,
            "reference_marks_ib": app.reference_marks_ib,
            "stream_manager": app.stream_manager,
            "schedule_reference_marks_warm": app.schedule_reference_marks_warm,
            "persist_reference_close_cache": app.persist_reference_close_cache,
            "cache_path": app.REFERENCE_MARKS_CACHE_PATH,
            "history_gap": app.REFERENCE_MARKS_REQUEST_GAP_SEC,
            "retry_delay": app.REFERENCE_MARKS_RETRY_DELAY_SEC,
            "max_attempts": app.REFERENCE_MARKS_MAX_ATTEMPTS,
        }
        app.reference_close_cache.clear()
        app.reference_marks_warm_states.clear()
        app.reference_marks_terminal_failures.clear()
        app.reference_marks_requested_accounts.clear()
        app.reference_marks_worker_task = None
        app.reference_marks_active_account = None
        app.reset_primary_socket_heartbeat()
        app.REFERENCE_MARKS_REQUEST_GAP_SEC = 0
        app.REFERENCE_MARKS_RETRY_DELAY_SEC = 0
        app.REFERENCE_MARKS_MAX_ATTEMPTS = 3
        app.persist_reference_close_cache = lambda: None

    async def asyncTearDown(self):
        worker = app.reference_marks_worker_task
        if worker and not worker.done():
            worker.cancel()
            await asyncio.gather(worker, return_exceptions=True)
        for name, value in self.originals.items():
            if name == "history_gap":
                app.REFERENCE_MARKS_REQUEST_GAP_SEC = value
            elif name == "retry_delay":
                app.REFERENCE_MARKS_RETRY_DELAY_SEC = value
            elif name == "max_attempts":
                app.REFERENCE_MARKS_MAX_ATTEMPTS = value
            elif name == "cache_path":
                app.REFERENCE_MARKS_CACHE_PATH = value
            else:
                setattr(app, name, value)
        app.reference_close_cache.clear()
        app.reference_marks_warm_states.clear()
        app.reference_marks_terminal_failures.clear()
        app.reference_marks_requested_accounts.clear()
        app.reference_marks_worker_task = None
        app.reference_marks_active_account = None
        app.reset_primary_socket_heartbeat()

    def install_brokers(self, primary, reference=None):
        app.ib = primary
        app.reference_marks_ib = reference or primary
        app.stream_manager = FakeStreamManager(primary)

    async def endpoint_payload(self, account="U1", include_live=False):
        response = await app.portfolio_reference_marks(account, include_live)
        return response, json.loads(response.body)

    async def test_endpoint_is_cache_first_and_does_not_wait_for_history(self):
        primary = FakeBroker(
            positions=[
                stock_position("U1", 101, "SPY"),
                stock_position("U1", 202, "TLT"),
            ]
        )
        reference = FakeBroker(positions=primary.positions())
        self.install_brokers(primary, reference)
        scheduled = []
        app.schedule_reference_marks_warm = (
            lambda account: not scheduled.append(account)
        )

        started = time.monotonic()
        response, payload = await self.endpoint_payload()
        elapsed = time.monotonic() - started

        self.assertEqual(response.status_code, 200)
        self.assertLess(elapsed, 0.25)
        self.assertEqual(payload["status"], "warming")
        self.assertTrue(payload["warming"])
        self.assertEqual(payload["warming_count"], 2)
        self.assertEqual(payload["failure_count"], 0)
        self.assertEqual({row["conId"] for row in payload["pending"]}, {101, 202})
        self.assertEqual(reference.history_requests, [])
        self.assertEqual(scheduled, ["U1"])

    async def test_polls_share_heartbeat_and_do_not_advance_worker_progress(self):
        primary = FakeBroker(positions=[stock_position("U1", 101, "SPY")])
        self.install_brokers(primary, FakeBroker(positions=primary.positions()))
        app.schedule_reference_marks_warm = lambda _account: False
        app.reference_marks_warm_states["U1"] = {
            **app.reference_warm_state("U1"),
            "state": "warming",
            "startedAt": "2026-07-25T14:59:00Z",
            "updatedAt": "2026-07-25T14:59:30Z",
            "positionsObservedAt": "2026-07-25T14:59:10Z",
        }

        _first_response, first = await self.endpoint_payload()
        _second_response, second = await self.endpoint_payload()

        self.assertEqual(primary.current_time_requests, 1)
        self.assertEqual(
            first["progress"]["updatedAt"],
            "2026-07-25T14:59:30Z",
        )
        self.assertEqual(
            second["progress"]["updatedAt"],
            "2026-07-25T14:59:30Z",
        )
        self.assertEqual(
            second["progress"]["positionsObservedAt"],
            "2026-07-25T14:59:10Z",
        )

    async def test_49_contracts_complete_serially_with_incremental_progress(self):
        positions = [stock_position("U1", con_id) for con_id in range(1, 50)]
        history = {
            con_id: [completed_bars(con_id)]
            for con_id in range(1, 50)
        }
        reference = FakeBroker(positions=positions, history=history)
        self.install_brokers(FakeBroker(positions=positions), reference)
        observed_completed_counts = []
        original_update = app.update_reference_warm_state

        def capture_progress(account, **values):
            state = original_update(account, **values)
            observed_completed_counts.append(state["completedCount"])
            return state

        app.update_reference_warm_state = capture_progress
        try:
            await app.warm_reference_marks_account("U1")
        finally:
            app.update_reference_warm_state = original_update

        state = app.reference_marks_warm_states["U1"]
        self.assertEqual(state["state"], "complete")
        self.assertEqual(state["completedCount"], 49)
        self.assertEqual(state["pendingCount"], 0)
        self.assertEqual(reference.max_active_history_requests, 1)
        self.assertEqual(len(reference.history_requests), 49)
        self.assertEqual(
            {con_id for con_id, _kwargs in reference.history_requests},
            set(range(1, 50)),
        )
        self.assertIn(1, observed_completed_counts)
        self.assertIn(25, observed_completed_counts)
        self.assertIn(49, observed_completed_counts)

    async def test_retry_is_pushed_behind_other_contracts_then_succeeds(self):
        positions = [stock_position("U1", con_id) for con_id in (1, 2, 3)]
        reference = FakeBroker(
            positions=positions,
            history={
                1: [asyncio.TimeoutError(), completed_bars(1)],
                2: [completed_bars(2)],
                3: [completed_bars(3)],
            },
        )
        self.install_brokers(FakeBroker(positions=positions), reference)

        await app.warm_reference_marks_account("U1")

        self.assertEqual(
            [con_id for con_id, _kwargs in reference.history_requests],
            [1, 2, 3, 1],
        )
        self.assertEqual(
            app.reference_marks_warm_states["U1"]["state"],
            "complete",
        )
        self.assertEqual(app.reference_marks_terminal_failures["U1"], {})

    async def test_exhausted_failure_is_terminal_but_other_marks_complete(self):
        positions = [stock_position("U1", con_id) for con_id in (1, 2, 3)]
        reference = FakeBroker(
            positions=positions,
            history={
                1: [
                    asyncio.TimeoutError(),
                    asyncio.TimeoutError(),
                    asyncio.TimeoutError(),
                ],
                2: [completed_bars(2)],
                3: [completed_bars(3)],
            },
        )
        self.install_brokers(FakeBroker(positions=positions), reference)

        await app.warm_reference_marks_account("U1")

        failure = app.reference_marks_terminal_failures["U1"][1]
        self.assertEqual(failure["attemptCount"], 3)
        self.assertTrue(failure["terminal"])
        self.assertTrue(failure["exhausted"])
        self.assertEqual(
            failure["terminalReason"],
            "retry_budget_exhausted",
        )
        self.assertEqual(len(app.reference_close_cache["U1"]), 2)
        self.assertEqual(
            app.reference_marks_warm_states["U1"]["state"],
            "degraded",
        )

    async def test_disconnect_result_is_not_committed_to_cache(self):
        position = stock_position("U1", 101, "SPY")
        reference = FakeBroker(
            positions=[position],
            history={101: ["disconnect"]},
        )
        self.install_brokers(FakeBroker(positions=[position]), reference)

        await app.warm_reference_marks_account("U1")

        self.assertNotIn(101, app.reference_close_cache.get("U1", {}))
        state = app.reference_marks_warm_states["U1"]
        self.assertEqual(state["state"], "waiting")
        self.assertEqual(
            state["lastErrorCode"],
            "REFERENCE_MARKS_GATEWAY_DISCONNECTED",
        )

    async def test_cache_survives_weekend_without_retimestamping(self):
        position = stock_position("U1", 101, "SPY")
        reference = FakeBroker(
            positions=[position],
            history={101: [completed_bars()]},
        )
        self.install_brokers(FakeBroker(positions=[position]), reference)

        await app.warm_reference_marks_account("U1")
        cached = app.reference_close_cache["U1"][101]
        observed_at = cached["referenceCloseObservedAt"]
        reused = app.cached_portfolio_reference_close(
            account="U1",
            position=position,
            broker_time=BROKER_TIME + timedelta(hours=20),
        )

        self.assertIsNotNone(reused)
        self.assertEqual(reused["referenceCloseObservedAt"], observed_at)
        self.assertEqual(
            reused["referenceCacheState"],
            "broker_historical_snapshot_reused",
        )
        self.assertEqual(len(reference.history_requests), 1)

    async def test_sanitized_historical_cache_survives_process_restart(self):
        with tempfile.TemporaryDirectory() as directory:
            app.REFERENCE_MARKS_CACHE_PATH = (
                Path(directory) / "reference-marks.json"
            )
            app.persist_reference_close_cache = self.originals[
                "persist_reference_close_cache"
            ]
            mark = {
                "account": "U1",
                "conId": 101,
                "symbol": "SPY",
                "position": 999,
                "status": "reference",
                "price": 101,
                "priceState": "historical_close",
                "priceSource": "ibkr_historical_daily_close",
                "priceSessionDate": "2026-07-24",
                "priceObservedAt": "2026-07-25T15:00:00Z",
                "referenceClose": 101,
                "referenceCloseSource": "ibkr_historical_daily_close",
                "referenceCloseSessionDate": "2026-07-24",
                "referenceCloseObservedAt": "2026-07-25T15:00:00Z",
                "previousClose": 100,
                "previousCloseSessionDate": "2026-07-23",
                "referenceLastCheckedAt": "2026-07-25T15:00:00Z",
                "referenceRefreshAttemptCount": 0,
                "referenceRefreshAfter": "2026-07-27T20:15:00Z",
            }
            app.store_portfolio_reference_close("U1", mark)
            persisted = json.loads(
                app.REFERENCE_MARKS_CACHE_PATH.read_text(encoding="utf-8")
            )
            self.assertNotIn(
                "position",
                persisted["accounts"]["U1"]["101"],
            )

            app.reference_close_cache.clear()
            app.load_reference_close_cache()

            loaded = app.reference_close_cache["U1"][101]
            self.assertEqual(loaded["referenceClose"], 101)
            self.assertEqual(
                loaded["referenceCloseObservedAt"],
                "2026-07-25T15:00:00Z",
            )
            self.assertNotIn("position", loaded)
            app.persist_reference_close_cache = lambda: None


class DirectLiveMarkAsyncTests(unittest.IsolatedAsyncioTestCase):
    def make_manager(self):
        broker = SimpleNamespace(isConnected=lambda: True)
        manager = StreamManager(
            broker,
            host="127.0.0.1",
            port=4001,
            client_id=17,
            connect_timeout=1.0,
            instrument_to_contract=lambda _instrument: Contract(),
        )
        manager.connected = True
        manager._connection_generation = 7
        return manager

    async def emit(self, manager, ticker):
        manager._on_pending_tickers([ticker])
        task = manager._debounce_task
        if task and not task.done():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        manager._debounce_task = None

    async def test_only_tick_type_4_can_refresh_live_last(self):
        manager = self.make_manager()
        now = datetime.now(timezone.utc)
        ticker = SimpleNamespace(
            contract=Contract(conId=101, symbol="SPY"),
            marketDataType=1,
            bid=101.2,
            ask=101.3,
            last=101.25,
            close=100.0,
            prevClose=100.0,
            volume=1_000,
            time=now,
            ticks=[
                SimpleNamespace(
                    tickType=4,
                    price=101.25,
                    time=now,
                )
            ],
        )
        manager._ref_counts[101] = 1
        manager._tickers[101] = ticker
        await self.emit(manager, ticker)

        first = manager.get_fresh_direct_live_marks(
            [101],
            max_age_seconds=60,
        )
        self.assertEqual(first[101]["liveMark"], 101.25)
        first_observed_at = first[101]["liveMarkObservedAt"]

        ticker.ticks = [
            SimpleNamespace(
                tickType=1,
                price=999.0,
                time=now + timedelta(seconds=10),
            )
        ]
        await self.emit(manager, ticker)
        second = manager.get_fresh_direct_live_marks(
            [101],
            max_age_seconds=60,
        )
        self.assertEqual(second[101]["liveMark"], 101.25)
        self.assertEqual(
            second[101]["liveMarkObservedAt"],
            first_observed_at,
        )

    async def test_disconnect_rejects_old_last_until_new_generation_tick(self):
        manager = self.make_manager()
        now = datetime.now(timezone.utc)
        ticker = SimpleNamespace(
            contract=Contract(conId=101, symbol="SPY"),
            marketDataType=1,
            bid=101.2,
            ask=101.3,
            last=101.25,
            close=100.0,
            prevClose=100.0,
            volume=1_000,
            time=now,
            ticks=[SimpleNamespace(tickType=4, price=101.25, time=now)],
        )
        manager._ref_counts[101] = 1
        manager._tickers[101] = ticker
        await self.emit(manager, ticker)
        self.assertIn(
            101,
            manager.get_fresh_direct_live_marks(
                [101],
                max_age_seconds=60,
            ),
        )

        manager._on_disconnected()

        self.assertEqual(
            manager.get_fresh_direct_live_marks(
                [101],
                max_age_seconds=60,
            ),
            {},
        )
        self.assertEqual(manager._live_last_ticks, {})
        self.assertEqual(manager._tickers, {})


if __name__ == "__main__":
    unittest.main()
