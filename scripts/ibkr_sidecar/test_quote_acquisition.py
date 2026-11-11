import asyncio
import unittest
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
import sys
from unittest.mock import patch

from ib_insync import Contract

sys.path.insert(0, str(Path(__file__).resolve().parent))

from stream_manager import StreamManager, ticker_to_raw_quote


def instrument(symbol, con_id):
    return SimpleNamespace(
        symbol=symbol,
        conId=con_id,
        secType="STK",
        exchange="SMART",
        currency="USD",
        lastTradeDateOrContractMonth=None,
        tradingClass=None,
        multiplier=None,
    )


def make_contract(inst):
    return Contract(
        conId=inst.conId,
        symbol=inst.symbol,
        localSymbol=inst.symbol,
        secType=inst.secType,
        exchange=inst.exchange,
        currency=inst.currency,
    )


class FakeBroker:
    def __init__(self, *, ready_after=0.02, make_ready=True):
        self.ready_after = ready_after
        self.make_ready = make_ready
        self.req_count = 0
        self.cancel_count = 0
        self.active = 0
        self.max_active = 0
        self._tasks = set()
        self.qualification_requests = []
        self.market_data_contracts = []

    def isConnected(self):
        return True

    async def qualifyContractsAsync(self, contract):
        await asyncio.sleep(0)
        self.qualification_requests.append(contract)
        return [contract]

    def reqMktData(self, contract, *_args):
        self.req_count += 1
        self.market_data_contracts.append(contract)
        self.active += 1
        self.max_active = max(self.max_active, self.active)
        ticker = SimpleNamespace(
            bid=None,
            ask=None,
            last=None,
            close=100.0,
            prevClose=None,
            volume=None,
            marketDataType=1,
            time=None,
            tickByTicks=[],
        )
        if self.make_ready:
            task = asyncio.create_task(self._publish_mark(ticker))
            self._tasks.add(task)
            task.add_done_callback(self._tasks.discard)
        return ticker

    async def _publish_mark(self, ticker):
        await asyncio.sleep(self.ready_after)
        ticker.last = 101.25
        ticker.time = datetime.now(timezone.utc)

    def cancelMktData(self, _contract):
        self.cancel_count += 1
        self.active = max(0, self.active - 1)


def make_manager(broker, *, concurrency=6, persistent_ids=None, tickers=None):
    manager = StreamManager.__new__(StreamManager)
    manager.ib = broker
    manager.connected = True
    manager._connection_generation = 1
    manager._subscription_owners = {}
    manager._owner_reconcile_lock = asyncio.Lock()
    manager._lock = asyncio.Lock()
    manager.instrument_to_contract = make_contract
    manager._quote_cache = {}
    manager._ref_counts = {int(cid): 1 for cid in (persistent_ids or [])}
    manager._contracts = {}
    manager._tickers = tickers or {}
    manager._quote_snapshot_semaphore = asyncio.Semaphore(concurrency)
    manager._forced_quote_snapshot_semaphore = asyncio.Semaphore(concurrency)
    manager._quote_snapshot_tasks = {}
    manager.last_error = None
    return manager


class QuoteAcquisitionTests(unittest.IsolatedAsyncioTestCase):
    async def test_authoritative_con_id_uses_the_broker_qualified_contract(self):
        class ExactContractBroker(FakeBroker):
            async def qualifyContractsAsync(self, contract):
                self.qualification_requests.append(contract)
                return [Contract(
                    conId=contract.conId,
                    symbol="EXPGY",
                    localSymbol="EXPGY",
                    secType="STK",
                    exchange="SMART",
                    primaryExchange="PINK",
                    currency="USD",
                )]

        broker = ExactContractBroker(ready_after=0.02)
        manager = make_manager(broker)
        manager.instrument_to_contract = lambda inst: Contract(conId=inst.conId)

        result = await manager.get_quote_for_instrument(
            SimpleNamespace(
                symbol="EXPGY",
                localSymbol="EXPGY",
                conId=41197624,
                secType="STK",
                exchange="PINK",
                currency="USD",
            ),
            timeout_sec=0.2,
        )

        self.assertIsNone(result["error"])
        self.assertEqual(broker.qualification_requests[0].conId, 41197624)
        self.assertEqual(broker.qualification_requests[0].exchange, "")
        self.assertEqual(broker.market_data_contracts[0].exchange, "SMART")
        self.assertEqual(broker.market_data_contracts[0].primaryExchange, "PINK")

    async def test_contract_qualification_is_bounded(self):
        class HangingQualificationBroker(FakeBroker):
            async def qualifyContractsAsync(self, _contract):
                await asyncio.Event().wait()

        manager = make_manager(HangingQualificationBroker())
        with patch("stream_manager.QUOTE_QUALIFY_TIMEOUT_SEC", 0.02):
            result = await manager.get_quote_for_instrument(
                instrument("EXPGY", 41197624),
                timeout_sec=0.2,
            )

        self.assertEqual(result["quote"], None)
        self.assertEqual(result["error"], "qualification_timeout for EXPGY")

    async def test_delayed_ticker_arrival_is_accepted_with_provider_timestamp(self):
        broker = FakeBroker(ready_after=0.02)
        manager = make_manager(broker)

        result = await manager.get_quote_for_instrument(
            instrument("SPY", 101),
            timeout_sec=0.2,
        )

        self.assertIsNone(result["error"])
        self.assertEqual(result["quote"]["priceState"], "market_mark")
        self.assertEqual(result["quote"]["dataType"], "live")
        self.assertIsNotNone(result["quote"]["timestamp"])
        self.assertEqual(broker.req_count, 1)
        self.assertEqual(broker.cancel_count, 1)

    async def test_timeout_does_not_fabricate_timestamp_and_cleans_up(self):
        broker = FakeBroker(make_ready=False)
        manager = make_manager(broker)

        result = await manager.get_quote_for_instrument(
            instrument("RUT", 102),
            timeout_sec=0.06,
        )

        self.assertEqual(result["error"], "quote_timeout")
        self.assertEqual(result["quote"]["priceState"], "reference_close")
        self.assertIsNone(result["quote"]["timestamp"])
        self.assertEqual(broker.req_count, 1)
        self.assertEqual(broker.cancel_count, 1)
        self.assertEqual(broker.active, 0)

    async def test_same_contract_requests_are_coalesced(self):
        broker = FakeBroker(ready_after=0.04)
        manager = make_manager(broker)
        first, second = await asyncio.gather(
            manager.get_quote_for_instrument(instrument("SPY", 103), timeout_sec=0.2),
            manager.get_quote_for_instrument(instrument("SPY_ALIAS", 103), timeout_sec=0.2),
        )

        self.assertIsNone(first["error"])
        self.assertIsNone(second["error"])
        self.assertEqual(broker.req_count, 1)
        self.assertEqual(broker.cancel_count, 1)

    async def test_temporary_snapshot_concurrency_is_bounded(self):
        broker = FakeBroker(ready_after=0.04)
        manager = make_manager(broker, concurrency=2)

        results = await asyncio.gather(*(
            manager.get_quote_for_instrument(
                instrument(symbol, con_id),
                timeout_sec=0.2,
            )
            for symbol, con_id in (("A", 201), ("B", 202), ("C", 203), ("D", 204))
        ))

        self.assertTrue(all(result["error"] is None for result in results))
        self.assertEqual(broker.req_count, 4)
        self.assertEqual(broker.cancel_count, 4)
        self.assertLessEqual(broker.max_active, 2)

    async def test_fresh_persistent_subscription_is_reused_without_cancel(self):
        broker = FakeBroker(make_ready=False)
        contract = make_contract(instrument("QQQ", 301))
        ticker = SimpleNamespace(
            bid=499.0,
            ask=500.0,
            last=499.5,
            close=498.0,
            prevClose=None,
            volume=10.0,
            marketDataType=1,
            time=datetime.now(timezone.utc),
            tickByTicks=[],
        )
        manager = make_manager(
            broker,
            persistent_ids=[301],
            tickers={301: ticker},
        )
        manager._contracts[301] = contract

        result = await manager.get_quote_for_instrument(
            instrument("QQQ", 301),
            timeout_sec=0.1,
        )

        self.assertIsNone(result["error"])
        expected = ticker_to_raw_quote(ticker, contract)
        self.assertEqual(
            {key: value for key, value in result["quote"].items() if key != "fetched_at"},
            {key: value for key, value in expected.items() if key != "fetched_at"},
        )
        self.assertEqual(broker.req_count, 0)
        self.assertEqual(broker.cancel_count, 0)

    async def test_forced_snapshot_bypasses_retained_stream_without_cancelling_it(self):
        broker = FakeBroker(ready_after=0.02)
        contract = make_contract(instrument("QQQ", 302))
        retained_ticker = SimpleNamespace(
            bid=499.0,
            ask=500.0,
            last=499.5,
            close=498.0,
            prevClose=None,
            volume=10.0,
            marketDataType=1,
            time=datetime.now(timezone.utc),
            tickByTicks=[],
        )
        manager = make_manager(
            broker,
            persistent_ids=[302],
            tickers={302: retained_ticker},
        )
        manager._contracts[302] = contract
        manager._quote_cache[302] = ticker_to_raw_quote(retained_ticker, contract)

        result = await manager.get_quote_for_instrument(
            instrument("QQQ", 302),
            timeout_sec=0.2,
            force_refresh=True,
        )

        self.assertIsNone(result["error"])
        self.assertEqual(result["refreshMode"], "broker_snapshot")
        self.assertEqual(result["quote"]["observationMode"], "broker_snapshot")
        self.assertFalse(result["quote"]["from_cache"])
        self.assertEqual(broker.req_count, 1)
        self.assertEqual(broker.cancel_count, 1)
        self.assertIs(manager._tickers[302], retained_ticker)
        self.assertIsNot(broker.market_data_contracts[0], contract)
        self.assertEqual(broker.qualification_requests, [])

    async def test_forced_snapshot_concurrency_is_bounded_separately(self):
        broker = FakeBroker(ready_after=0.04)
        manager = make_manager(broker, concurrency=2)

        results = await asyncio.gather(*(
            manager.get_quote_for_instrument(
                instrument(symbol, con_id),
                timeout_sec=0.2,
                force_refresh=True,
            )
            for symbol, con_id in (("A", 401), ("B", 402), ("C", 403), ("D", 404))
        ))

        self.assertTrue(all(result["error"] is None for result in results))
        self.assertEqual(broker.req_count, 4)
        self.assertEqual(broker.cancel_count, 4)
        self.assertLessEqual(broker.max_active, 2)


if __name__ == "__main__":
    unittest.main()

class SubscriptionOwnershipTests(unittest.IsolatedAsyncioTestCase):
    async def test_replayed_desired_set_is_idempotent_and_shared_owner_survives(self):
        broker = FakeBroker(make_ready=False)
        manager = make_manager(broker)
        spy = instrument("SPY", 101)
        await manager.reconcile_subscriptions("market-dashboard", [spy])
        await manager.reconcile_subscriptions("market-dashboard", [spy])
        self.assertEqual(manager._ref_counts[101], 1)
        self.assertEqual(broker.req_count, 1)
        await manager.reconcile_subscriptions("portfolio:U1", [spy])
        await manager.reconcile_subscriptions("market-dashboard", [])
        self.assertEqual(manager._ref_counts[101], 1)
        self.assertEqual(broker.cancel_count, 0)
        await manager.reconcile_subscriptions("portfolio:U1", [])
        self.assertNotIn(101, manager._ref_counts)
        self.assertEqual(broker.cancel_count, 1)

    async def test_failed_subscription_can_be_retried_without_phantom_membership(self):
        broker = FakeBroker(make_ready=False)
        manager = make_manager(broker)
        with patch.object(broker, "reqMktData", side_effect=RuntimeError("busy")):
            failed = await manager.reconcile_subscriptions("market-dashboard", [instrument("SPY", 101)])
        self.assertFalse(failed["ok"])
        self.assertEqual(manager._ref_counts, {})
        result = await manager.reconcile_subscriptions("market-dashboard", [instrument("SPY", 101)])
        self.assertTrue(result["ok"])
        self.assertEqual(manager._ref_counts[101], 1)

    async def test_quote_completed_across_connection_change_is_rejected(self):
        broker = FakeBroker(ready_after=0.05)
        manager = make_manager(broker)
        task = asyncio.create_task(manager.get_quote_for_instrument(instrument("SPY", 101)))
        await asyncio.sleep(0.01)
        manager._connection_generation += 1
        result = await task
        self.assertIsNone(result["quote"])
        self.assertEqual(result["error"], "connection_changed")


class RetainingBroker(FakeBroker):
    """Keeps a Ticker per contract object until told otherwise, as ib_insync does."""

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.wrapper = SimpleNamespace(tickers={}, reqId2Ticker={}, ticker2ReqId={"mktData": {}})
        self._held = {}

    def reqMktData(self, contract, *args):
        ticker = super().reqMktData(contract, *args)
        held = self.wrapper.tickers.setdefault(id(contract), object())
        self._held[id(contract)] = held
        self.wrapper.reqId2Ticker[self.req_count] = held
        self.wrapper.ticker2ReqId["mktData"][held] = self.req_count
        return ticker

    def cancelMktData(self, contract):
        super().cancelMktData(contract)
        # ib_insync's endTicker releases the request id only.
        self.wrapper.ticker2ReqId["mktData"].pop(self._held.get(id(contract)), None)


class EndpointTickerReleaseTests(unittest.IsolatedAsyncioTestCase):
    async def test_one_off_quotes_leave_no_ticker_behind(self):
        broker = RetainingBroker(ready_after=0.01)
        manager = make_manager(broker)

        for con_id in (201, 202, 203):
            result = await manager.get_quote_for_instrument(instrument("SPY", con_id), timeout_sec=0.5)
            self.assertIsNotNone(result["quote"])

        self.assertEqual(broker.req_count, 3)
        self.assertEqual(broker.cancel_count, 3)
        self.assertEqual(broker.wrapper.tickers, {})
        self.assertEqual(broker.wrapper.reqId2Ticker, {})

    async def test_forced_snapshots_leave_no_ticker_behind(self):
        broker = RetainingBroker(ready_after=0.01)
        manager = make_manager(broker, persistent_ids=[301])
        manager._contracts[301] = make_contract(instrument("SPY", 301))

        for _ in range(3):
            await manager.get_quote_for_instrument(instrument("SPY", 301), timeout_sec=0.5, force_refresh=True)

        self.assertEqual(broker.cancel_count, broker.req_count)
        self.assertEqual(broker.wrapper.tickers, {})
        self.assertEqual(broker.wrapper.reqId2Ticker, {})

    async def test_a_contract_with_a_live_subscription_is_left_alone(self):
        broker = RetainingBroker()
        manager = make_manager(broker)
        contract = make_contract(instrument("QQQ", 401))
        broker.reqMktData(contract)

        manager._forget_endpoint_ticker(contract)
        self.assertIn(id(contract), broker.wrapper.tickers)
        self.assertEqual(len(broker.wrapper.reqId2Ticker), 1)

        broker.cancelMktData(contract)
        manager._forget_endpoint_ticker(contract)
        self.assertEqual(broker.wrapper.tickers, {})
        self.assertEqual(broker.wrapper.reqId2Ticker, {})

    async def test_a_broker_without_that_bookkeeping_is_unaffected(self):
        manager = make_manager(FakeBroker())
        manager._forget_endpoint_ticker(make_contract(instrument("IWM", 501)))
