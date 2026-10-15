import asyncio
import json
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch
from ib_insync import Contract, Order, OrderState, Trade
import app
from open_order_snapshot import fresh_open_orders


class OpenOrderSnapshotTests(unittest.IsolatedAsyncioTestCase):
    def broker(self, quantity_reported=True):
        broker = Mock()
        broker.wrapper = SimpleNamespace(openOrder=Mock(), orderStatus=Mock())
        contract = Contract(conId=123, symbol='IGV', secType='STK', currency='USD')
        order = Order(orderId=1, permId=10, clientId=42, account='TEST', action='SELL', totalQuantity=100,
                      orderType='STP LMT', auxPrice=98, lmtPrice=97, tif='GTC')

        async def request():
            broker.wrapper.openOrder(1, contract, order, OrderState(status='PreSubmitted'))
            if quantity_reported:
                broker.wrapper.orderStatus(1, 'PreSubmitted', 20, 80, 0, 10, 0, 0, 42, '', 0)
            # A stale cached object must not supply this snapshot's fields.
            return [Trade(contract, Order(orderId=1, permId=10, clientId=42, auxPrice=1))]

        broker.reqAllOpenOrdersAsync = request
        broker.reqCurrentTimeAsync = AsyncMock()
        broker.isConnected.return_value = True
        broker.managedAccounts.return_value = ['TEST']
        return broker

    async def test_fresh_all_client_callbacks_include_stop_trigger_and_remaining_quantity(self):
        broker = self.broker()
        original = broker.wrapper.openOrder
        rows = await fresh_open_orders(broker, ['TEST'], 1, 1)
        self.assertEqual((rows[0]['auxPrice'], rows[0]['remaining'], rows[0]['clientId']), (98, 80, 42))
        self.assertEqual(rows[0]['status'], 'PreSubmitted')
        self.assertIsNone(rows[0]['trailingPercent'])
        self.assertIs(broker.wrapper.openOrder, original)

    async def test_default_zero_quantity_is_not_a_verified_remaining_quantity(self):
        rows = await fresh_open_orders(self.broker(False), ['TEST'], 1, 1)
        self.assertIsNone(rows[0]['remaining'])

    async def test_callbacks_restore_after_timeout_and_disconnection(self):
        for disconnected in [True, False]:
            broker = self.broker()
            original = broker.wrapper.openOrder
            if disconnected:
                broker.isConnected.return_value = False
            else:
                broker.reqAllOpenOrdersAsync = AsyncMock(side_effect=asyncio.TimeoutError)
            with self.assertRaises((ValueError, asyncio.TimeoutError)):
                await fresh_open_orders(broker, ['TEST'], 1, 1)
            self.assertIs(broker.wrapper.openOrder, original)

    async def test_endpoint_omits_orders_on_disconnection_or_failed_refresh(self):
        for health in [{'ok': False, 'status': 'disconnected'}, {'ok': True}]:
            broker = self.broker()
            broker.reqAllOpenOrdersAsync = AsyncMock(side_effect=asyncio.TimeoutError)
            with patch.object(app, 'ib', broker), patch.object(app, 'ensure_connected', AsyncMock(return_value=health)):
                response = await app.portfolio_open_orders(account=None)
            data = json.loads(response.body)
            self.assertFalse(data['liveVerified'])
            self.assertFalse(data['complete'])
            self.assertEqual(data['orders'], [])
            self.assertEqual(response.headers['cache-control'], 'no-store')

    async def test_endpoint_verified_empty_and_account_filtered_orders(self):
        for account, count in [(None, 1), ('TEST', 1)]:
            with patch.object(app, 'ib', self.broker()), patch.object(app, 'ensure_connected', AsyncMock(return_value={'ok': True})):
                data = json.loads((await app.portfolio_open_orders(account=account)).body)
            self.assertTrue(data['complete'])
            self.assertTrue(data['liveVerified'])
            self.assertEqual(len(data['orders']), count)
        broker = self.broker()
        broker.reqAllOpenOrdersAsync = AsyncMock(return_value=[])
        with patch.object(app, 'ib', broker), patch.object(app, 'ensure_connected', AsyncMock(return_value={'ok': True})):
            data = json.loads((await app.portfolio_open_orders(account=None)).body)
        self.assertTrue(data['complete'])
        self.assertEqual(data['orders'], [])
