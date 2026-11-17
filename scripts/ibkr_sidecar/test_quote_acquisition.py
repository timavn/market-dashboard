import asyncio
import gc
import unittest
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
import sys
from unittest.mock import patch

from ib_insync import IB, Contract
from ib_insync.client import Client

sys.path.insert(0, str(Path(__file__).resolve().parent))

import stream_manager
from stream_manager import StreamManager, contract_memory_key, ticker_to_raw_quote


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


def by_symbol(symbol, sec_type="STK", exchange="SMART"):
    """An instrument asked for by symbol, with no contract id."""
    return SimpleNamespace(
        symbol=symbol,
        conId=None,
        secType=sec_type,
        exchange=exchange,
        currency="USD",
        lastTradeDateOrContractMonth=None,
        tradingClass=None,
        multiplier=None,
    )


class SymbolBroker(FakeBroker):
    """Answers a symbol lookup with a contract id, as IBKR does."""

    CON_IDS = {"XLK": 9001, "XLV": 9002, "SPX": 9003, "CL": 9004}

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.unknown = set()
        self.front_month = "202612"

    async def qualifyContractsAsync(self, contract):
        await asyncio.sleep(0)
        self.qualification_requests.append(contract)
        if contract.symbol in self.unknown or contract.symbol not in self.CON_IDS:
            return []
        return [Contract(
            conId=self.CON_IDS[contract.symbol],
            symbol=contract.symbol,
            localSymbol=contract.symbol,
            secType="FUT" if contract.secType == "CONTFUT" else contract.secType,
            exchange=contract.exchange,
            currency=contract.currency,
            lastTradeDateOrContractMonth=self.front_month if contract.secType == "CONTFUT" else "",
        )]


class ContractMemoryTests(unittest.IsolatedAsyncioTestCase):
    """A symbol's contract is looked up once, not on every quote."""

    async def quote(self, manager, inst, **kwargs):
        return await manager.get_quote_for_instrument(inst, timeout_sec=0.2, **kwargs)

    async def test_a_stock_asked_by_symbol_is_looked_up_once(self):
        broker = SymbolBroker()
        manager = make_manager(broker)

        for _ in range(3):
            result = await self.quote(manager, by_symbol("XLK"))
            self.assertIsNone(result["error"])
            self.assertEqual(result["quote"]["priceState"], "market_mark")
        other = await self.quote(manager, by_symbol("XLV"))

        self.assertIsNone(other["error"])
        self.assertEqual([c.symbol for c in broker.qualification_requests], ["XLK", "XLV"])
        # The price is still requested from IBKR every time.
        self.assertEqual(broker.req_count, 4)
        self.assertEqual(manager.__dict__["_contract_lookup_counts"], {"asked": 2, "reused": 2})

    async def test_an_index_on_another_exchange_is_a_separate_lookup(self):
        broker = SymbolBroker()
        manager = make_manager(broker)

        await self.quote(manager, by_symbol("SPX", "IND", "CBOE"))
        await self.quote(manager, by_symbol("SPX", "IND", "CBOE"))
        await self.quote(manager, by_symbol("SPX", "STK", "SMART"))

        self.assertEqual(
            [(c.symbol, c.secType, c.exchange) for c in broker.qualification_requests],
            [("SPX", "IND", "CBOE"), ("SPX", "STK", "SMART")],
        )

    async def test_a_subscribed_contract_is_not_looked_up_for_an_ordinary_quote(self):
        broker = SymbolBroker()
        manager = make_manager(broker, persistent_ids=[201])
        held = Contract(conId=201, symbol="AAPL", localSymbol="AAPL", secType="STK", exchange="SMART", currency="USD")
        manager._contracts[201] = held
        manager._quote_cache[201] = {
            "symbol": "AAPL", "conId": 201, "priceState": "market_mark", "last": 190.5, "bid": 190.4, "ask": 190.6,
            "close": 189.0, "dataType": "live", "entitlementStatus": "live",
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "fetched_at": datetime.now(timezone.utc).isoformat(),
        }

        result = await self.quote(manager, instrument("AAPL", 201))

        self.assertIsNone(result["error"])
        self.assertTrue(result["from_cache"])
        self.assertEqual(broker.qualification_requests, [])
        self.assertEqual(broker.req_count, 0)

    async def test_an_unknown_symbol_is_remembered_briefly_then_asked_again(self):
        broker = SymbolBroker()
        broker.unknown.add("XLK")
        manager = make_manager(broker)

        first = await self.quote(manager, by_symbol("XLK"))
        second = await self.quote(manager, by_symbol("XLK"))
        self.assertEqual(first["error"], "Could not qualify XLK")
        self.assertEqual(second["error"], "Could not qualify XLK")
        self.assertEqual(len(broker.qualification_requests), 1)

        # Ten minutes later the symbol exists.
        broker.unknown.clear()
        key = contract_memory_key(make_contract(by_symbol("XLK")))
        generation, _expires, qualified, error = manager._contract_memory[key]
        manager._contract_memory[key] = (generation, time_before_now(), qualified, error)
        third = await self.quote(manager, by_symbol("XLK"))
        self.assertIsNone(third["error"])
        self.assertEqual(len(broker.qualification_requests), 2)

    async def test_a_timeout_or_an_error_is_never_remembered(self):
        class FailingOnce(SymbolBroker):
            failures = [asyncio.TimeoutError(), RuntimeError("socket closed")]

            async def qualifyContractsAsync(self, contract):
                if self.failures:
                    self.qualification_requests.append(contract)
                    raise self.failures.pop(0)
                return await super().qualifyContractsAsync(contract)

        broker = FailingOnce()
        manager = make_manager(broker)

        self.assertEqual((await self.quote(manager, by_symbol("XLK")))["error"], "qualification_timeout for XLK")
        self.assertEqual((await self.quote(manager, by_symbol("XLK")))["error"], "socket closed")
        self.assertIsNone((await self.quote(manager, by_symbol("XLK")))["error"])
        self.assertEqual(len(broker.qualification_requests), 3)

    async def test_a_future_asked_by_symbol_follows_the_front_month(self):
        broker = SymbolBroker()
        manager = make_manager(broker)
        manager.instrument_to_contract = lambda inst: Contract(
            symbol=inst.symbol, secType=inst.secType, exchange=inst.exchange, currency=inst.currency,
        )
        self.assertIsNone(contract_memory_key(Contract(symbol="CL", secType="CONTFUT", exchange="NYMEX")))
        self.assertIsNone(contract_memory_key(Contract(symbol="CL", secType="FUT", exchange="NYMEX")))
        self.assertIsNone(contract_memory_key(Contract(conId=9001, symbol="XLK", secType="STK", exchange="SMART")))

        await self.quote(manager, by_symbol("CL", "CONTFUT", "NYMEX"))
        broker.front_month = "202701"
        await self.quote(manager, by_symbol("CL", "CONTFUT", "NYMEX"))

        self.assertEqual(len(broker.qualification_requests), 2)
        self.assertEqual(
            [c.lastTradeDateOrContractMonth for c in broker.market_data_contracts],
            ["202612", "202701"],
        )

    async def test_a_new_gateway_session_looks_the_contract_up_again(self):
        broker = SymbolBroker()
        manager = make_manager(broker)

        await self.quote(manager, by_symbol("XLK"))
        manager._connection_generation += 1
        await self.quote(manager, by_symbol("XLK"))
        self.assertEqual(len(broker.qualification_requests), 2)

        # A disconnect empties the memory outright.
        manager._live_last_ticks = {}
        manager._pending_notify = set()
        manager._broadcast_status = lambda *_args: None
        manager._on_disconnected()
        self.assertEqual(manager._contract_memory, {})

    async def test_the_memory_is_bounded(self):
        broker = SymbolBroker()
        manager = make_manager(broker)
        with patch("stream_manager.CONTRACT_MEMORY_LIMIT", 2):
            for symbol in ("XLK", "XLV", "SPX"):
                await self.quote(manager, by_symbol(symbol))
        self.assertEqual(len(manager._contract_memory), 2)
        self.assertNotIn(contract_memory_key(make_contract(by_symbol("XLK"))), manager._contract_memory)


def time_before_now():
    return stream_manager.time.monotonic() - 1.0


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

    async def test_a_quiet_subscribed_contract_answers_at_once_instead_of_waiting_out_the_timeout(self):
        broker = FakeBroker(make_ready=False)
        contract = make_contract(instrument("XLRE", 302))
        # The stream delivered a tick five minutes ago and nothing since.
        ticker = SimpleNamespace(
            bid=41.0, ask=41.1, last=41.05, close=41.0, prevClose=None, volume=10.0, marketDataType=1,
            time=datetime.fromtimestamp(datetime.now(timezone.utc).timestamp() - 300, timezone.utc), tickByTicks=[],
        )
        manager = make_manager(broker, persistent_ids=[302], tickers={302: ticker})
        manager._contracts[302] = contract

        started = asyncio.get_running_loop().time()
        result = await manager.get_quote_for_instrument(instrument("XLRE", 302), timeout_sec=2.0)
        elapsed = asyncio.get_running_loop().time() - started

        self.assertEqual(result["error"], "quote_timeout")
        self.assertLess(elapsed, 1.0)
        self.assertEqual(broker.req_count, 0)
        self.assertEqual(broker.cancel_count, 0)

    async def test_a_new_subscription_still_gets_the_full_wait_for_its_first_tick(self):
        broker = FakeBroker(make_ready=False)
        contract = make_contract(instrument("XLRE", 303))
        ticker = SimpleNamespace(
            bid=None, ask=None, last=None, close=41.0, prevClose=None, volume=None, marketDataType=1,
            time=None, tickByTicks=[],
        )
        manager = make_manager(broker, persistent_ids=[303], tickers={303: ticker})
        manager._contracts[303] = contract

        async def first_tick():
            await asyncio.sleep(0.4)
            ticker.last = 41.05
            ticker.time = datetime.now(timezone.utc)

        task = asyncio.create_task(first_tick())
        with patch("stream_manager.SUBSCRIBED_QUOTE_WAIT_SEC", 0.05):
            result = await manager.get_quote_for_instrument(instrument("XLRE", 303), timeout_sec=1.5)
        await task

        self.assertIsNone(result["error"])
        self.assertEqual(result["quote"]["last"], 41.05)

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


class FakeGateway:
    """Answers a real ib_insync client the way IB Gateway answers a snapshot.

    The IB object, its wrapper and its client are the real library; only the
    socket is replaced. ``end_after`` is when the Gateway sends its
    end-of-snapshot message, or None for a snapshot it leaves open.
    """

    def __init__(self, *, ready_after=0.01, end_after=0.01, make_ready=True):
        self.ready_after = ready_after
        self.end_after = end_after
        self.make_ready = make_ready
        self.requests = []
        self.cancels = []
        self.ended = []
        self.sent = []
        self.ib = IB()
        client = self.ib.client
        client.connState = Client.CONNECTED
        client._apiReady = True
        client._serverVersion = 176
        # A real session starts from the Gateway's next valid id, never zero.
        client.updateReqId(1000)
        # The library's own limit of 45 a second is not what is under test.
        client.MaxRequests = 0
        client.conn.sendMsg = self._on_message

    def _on_message(self, message):
        loop = asyncio.get_running_loop()
        fields = message[4:].decode().split("\0")
        self.sent.append((loop.time(), fields[0]))
        if fields[0] == "1":
            req_id = int(fields[2])
            self.requests.append(req_id)
            if self.make_ready:
                loop.call_later(self.ready_after, self._publish, req_id)
            if self.end_after is not None:
                loop.call_later(self.end_after, self._end, req_id)
        elif fields[0] == "2":
            self.cancels.append(int(fields[2]))

    def _publish(self, req_id):
        wrapper = self.ib.wrapper
        wrapper.tcpDataArrived()
        wrapper.marketDataType(req_id, 1)
        wrapper.priceSizeTick(req_id, 4, 101.25, 100.0)
        wrapper.tcpDataProcessed()

    def _end(self, req_id):
        if req_id in self.cancels:
            return
        self.ended.append(req_id)
        self.ib.wrapper.tickSnapshotEnd(req_id)

    def nothing_left_behind(self):
        wrapper = self.ib.wrapper
        return not (
            wrapper.tickers
            or wrapper.reqId2Ticker
            or wrapper._futures
            or wrapper._results
            or any(wrapper.ticker2ReqId.values())
        )


def forced_manager(gateway, con_id=901, *, concurrency=6):
    manager = make_manager(gateway.ib, concurrency=concurrency, persistent_ids=[con_id])
    manager._contracts[con_id] = make_contract(instrument("SPY", con_id))
    return manager


async def closed(manager):
    """Wait for the snapshots still waiting on the Gateway to be closed."""
    closers = manager.__dict__.get("_broker_snapshot_closers") or set()
    if closers:
        await asyncio.gather(*list(closers))


class BrokerSnapshotEndTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        # Pacing has its own tests below.
        unpaced = patch("stream_manager.SNAPSHOT_MESSAGE_INTERVAL_SEC", 0.0)
        unpaced.start()
        self.addCleanup(unpaced.stop)

    async def forced(self, manager, con_id=901, timeout_sec=0.5):
        return await manager.get_quote_for_instrument(
            instrument("SPY", con_id), timeout_sec=timeout_sec, force_refresh=True,
        )

    async def test_a_snapshot_the_gateway_has_ended_is_not_cancelled(self):
        gateway = FakeGateway(ready_after=0.01, end_after=0.01)
        manager = forced_manager(gateway)

        result = await self.forced(manager)
        await closed(manager)

        self.assertIsNone(result["error"])
        self.assertEqual(result["quote"]["observationMode"], "broker_snapshot")
        self.assertEqual(result["quote"]["last"], 101.25)
        self.assertEqual(len(gateway.requests), 1)
        self.assertEqual(gateway.cancels, [])
        self.assertTrue(gateway.nothing_left_behind())
        self.assertEqual(
            manager._broker_snapshot_counts,
            {"requested": 1, "endedByGateway": 1, "cancelled": 0},
        )

    async def test_a_snapshot_that_ends_after_its_quote_is_read_is_not_cancelled(self):
        gateway = FakeGateway(ready_after=0.01, end_after=0.15)
        manager = forced_manager(gateway)

        result = await self.forced(manager)

        # The caller has its quote before the Gateway has ended the request.
        self.assertIsNone(result["error"])
        self.assertEqual(gateway.ended, [])
        await closed(manager)
        self.assertEqual(gateway.ended, gateway.requests)
        self.assertEqual(gateway.cancels, [])
        self.assertTrue(gateway.nothing_left_behind())

    async def test_a_snapshot_the_gateway_leaves_open_is_cancelled_once(self):
        gateway = FakeGateway(ready_after=0.01, end_after=None)
        manager = forced_manager(gateway)

        with patch("stream_manager.SNAPSHOT_END_GRACE_SEC", 0.05):
            result = await self.forced(manager)
            self.assertIsNone(result["error"])
            self.assertEqual(gateway.cancels, [])
            await closed(manager)

        self.assertEqual(gateway.cancels, gateway.requests)
        self.assertTrue(gateway.nothing_left_behind())
        self.assertEqual(
            manager._broker_snapshot_counts,
            {"requested": 1, "endedByGateway": 0, "cancelled": 1},
        )

    async def test_a_quote_that_never_arrives_is_reported_the_same_way(self):
        gateway = FakeGateway(make_ready=False, end_after=0.02)
        manager = forced_manager(gateway)

        result = await self.forced(manager, timeout_sec=0.08)
        await closed(manager)

        self.assertEqual(result["error"], "quote_timeout")
        self.assertIsNone(result["quote"]["timestamp"])
        self.assertEqual(gateway.cancels, [])
        self.assertTrue(gateway.nothing_left_behind())

    async def test_the_snapshot_slot_is_free_while_the_gateway_is_awaited(self):
        gateway = FakeGateway(ready_after=0.01, end_after=None)
        manager = forced_manager(gateway, concurrency=1)
        manager._contracts[902] = make_contract(instrument("QQQ", 902))
        manager._ref_counts[902] = 1

        with patch("stream_manager.SNAPSHOT_END_GRACE_SEC", 5.0):
            first = await self.forced(manager, 901)
            second = await asyncio.wait_for(self.forced(manager, 902), timeout=1.0)
            self.assertIsNone(first["error"])
            self.assertIsNone(second["error"])
            self.assertEqual(len(gateway.requests), 2)
            self.assertEqual(gateway.cancels, [])
            # Stopping the sidecar does not leave them waiting.
            for closer in list(manager._broker_snapshot_closers):
                closer.cancel()
            await asyncio.gather(*list(manager._broker_snapshot_closers), return_exceptions=True)

        self.assertEqual(sorted(gateway.cancels), sorted(gateway.requests))
        self.assertTrue(gateway.nothing_left_behind())

    async def test_a_dropped_socket_needs_no_cancel(self):
        unhandled = []
        loop = asyncio.get_running_loop()
        loop.set_exception_handler(lambda _loop, context: unhandled.append(context))
        gateway = FakeGateway(ready_after=0.01, end_after=None)
        manager = forced_manager(gateway)

        with patch("stream_manager.SNAPSHOT_END_GRACE_SEC", 5.0):
            result = await self.forced(manager)
            self.assertIsNone(result["error"])
            # ib_insync fails every open request and clears its records.
            gateway.ib.wrapper.connectionClosed()
            await closed(manager)

        gc.collect()
        await asyncio.sleep(0)
        self.assertEqual(gateway.cancels, [])
        self.assertTrue(gateway.nothing_left_behind())
        self.assertEqual(unhandled, [])
        self.assertIsNone(manager.last_error)

    async def test_a_request_that_cannot_be_sent_leaves_nothing_behind(self):
        gateway = FakeGateway()
        manager = forced_manager(gateway)
        gateway.ib.client.connState = Client.DISCONNECTED

        result = await self.forced(manager)

        self.assertIsNone(result["quote"])
        self.assertEqual(result["error"], "Not connected")
        self.assertEqual(gateway.requests, [])
        self.assertTrue(gateway.nothing_left_behind())

    async def test_a_whole_book_of_snapshots_sends_no_cancels(self):
        gateway = FakeGateway(ready_after=0.01, end_after=0.03)
        manager = forced_manager(gateway, concurrency=12)
        con_ids = list(range(1001, 1072))
        for con_id in con_ids:
            manager._contracts[con_id] = make_contract(instrument(f"S{con_id}", con_id))
            manager._ref_counts[con_id] = 1

        results = await asyncio.gather(*(self.forced(manager, con_id) for con_id in con_ids))
        await closed(manager)

        self.assertTrue(all(result["error"] is None for result in results))
        self.assertEqual(len(gateway.requests), 71)
        self.assertEqual(gateway.cancels, [])
        self.assertTrue(gateway.nothing_left_behind())


class BrokerSnapshotPacingTests(unittest.IsolatedAsyncioTestCase):
    INTERVAL = 0.02

    def book(self, gateway, count, *, concurrency=12):
        # As in production: the library's own limit stays on beneath the pacing.
        gateway.ib.client.MaxRequests = 45
        manager = forced_manager(gateway, concurrency=concurrency)
        con_ids = list(range(2001, 2001 + count))
        for con_id in con_ids:
            manager._contracts[con_id] = make_contract(instrument(f"S{con_id}", con_id))
            manager._ref_counts[con_id] = 1
        return manager, con_ids

    def gaps(self, gateway, message_id):
        times = [at for at, kind in gateway.sent if kind == message_id]
        return [later - earlier for earlier, later in zip(times, times[1:])]

    async def refresh(self, manager, con_ids, timeout_sec=1.0):
        return await asyncio.gather(*(
            manager.get_quote_for_instrument(
                instrument(f"S{con_id}", con_id), timeout_sec=timeout_sec, force_refresh=True,
            )
            for con_id in con_ids
        ))

    async def test_a_whole_book_refresh_leaves_one_snapshot_request_at_a_time(self):
        gateway = FakeGateway(ready_after=0.005, end_after=0.006)
        manager, con_ids = self.book(gateway, 12)

        with patch("stream_manager.SNAPSHOT_MESSAGE_INTERVAL_SEC", self.INTERVAL):
            results = await self.refresh(manager, con_ids)
            await closed(manager)

        self.assertTrue(all(result["error"] is None for result in results))
        self.assertEqual(len(gateway.requests), 12)
        # Twelve slots were free at once; the requests still left evenly.
        self.assertGreaterEqual(min(self.gaps(gateway, "1")), self.INTERVAL * 0.95)
        self.assertEqual(gateway.cancels, [])

    async def test_other_requests_never_wait_behind_the_snapshots(self):
        gateway = FakeGateway(ready_after=0.005, end_after=0.006)
        manager, con_ids = self.book(gateway, 12)

        with patch("stream_manager.SNAPSHOT_MESSAGE_INTERVAL_SEC", self.INTERVAL):
            refresh = asyncio.create_task(self.refresh(manager, con_ids))
            await asyncio.sleep(self.INTERVAL * 1.5)
            snapshots_so_far = len(gateway.requests)
            asked = asyncio.get_running_loop().time()
            # The heartbeat the connection governor sends.
            gateway.ib.client.reqCurrentTime()
            heartbeat = next(at for at, kind in gateway.sent if kind == "49")
            await refresh
            await closed(manager)

        self.assertLess(snapshots_so_far, 12)
        self.assertLess(heartbeat - asked, self.INTERVAL / 2)

    async def test_cancels_take_their_turn_as_well(self):
        gateway = FakeGateway(ready_after=0.005, end_after=None)
        manager, con_ids = self.book(gateway, 6)

        with patch("stream_manager.SNAPSHOT_MESSAGE_INTERVAL_SEC", self.INTERVAL), \
                patch("stream_manager.SNAPSHOT_END_GRACE_SEC", 0.01):
            await self.refresh(manager, con_ids)
            await closed(manager)

        self.assertEqual(sorted(gateway.cancels), sorted(gateway.requests))
        times = sorted(at for at, _kind in gateway.sent)
        gaps = [later - earlier for earlier, later in zip(times, times[1:])]
        self.assertGreaterEqual(min(gaps), self.INTERVAL * 0.95)
        self.assertTrue(gateway.nothing_left_behind())

    async def test_pacing_can_be_switched_off(self):
        gateway = FakeGateway(ready_after=0.005, end_after=0.006)
        manager, con_ids = self.book(gateway, 12)

        with patch("stream_manager.SNAPSHOT_MESSAGE_INTERVAL_SEC", 0.0):
            await self.refresh(manager, con_ids)
            await closed(manager)

        self.assertLess(max(self.gaps(gateway, "1")), self.INTERVAL / 2)
