import copy
import unittest
from portfolio_stops import stop_checks

AS_OF = '2026-09-04T20:01:00Z'


def metrics(quantity=100):
    return {'available': True, 'observedAt': AS_OF, 'positions': [
        {'account': 'TEST', 'conId': 123, 'symbol': 'IGV', 'quantity': quantity, 'category': 'etf'}]}


def order(**extra):
    return {'account': 'TEST', 'conId': 123, 'orderId': 1, 'permId': 10, 'clientId': 8,
            'orderType': 'STP', 'action': 'SELL', 'status': 'PreSubmitted', 'remaining': 100,
            'auxPrice': 98, **extra}


def snapshot(orders):
    return {'ok': True, 'complete': True, 'liveVerified': True, 'source': 'ibkr_all_open_orders',
            'from_cache': False, 'accounts': ['TEST'], 'asOf': AS_OF, 'orders': orders}


class PortfolioStopsTests(unittest.TestCase):
    def check(self, orders, quantity=100):
        return stop_checks(metrics(quantity), snapshot(orders))['byHolding'][f'IGV:{"LONG" if quantity > 0 else "SHORT"}']

    def test_long_short_stop_limit_and_trailing_orders(self):
        for entry in [order(), order(orderType='STP LMT'), order(orderType='TRAIL', auxPrice=None, trailStopPrice=98)]:
            self.assertEqual(self.check([entry])['status'], 'covered')
        self.assertEqual(self.check([order(action='BUY')], -100)['status'], 'covered')

    def test_partial_missing_wrong_side_and_excess_quantity(self):
        self.assertEqual(self.check([order(remaining=60)])['coveragePct'], 60)
        self.assertEqual(self.check([order(remaining=60)])['status'], 'partial')
        self.assertEqual(self.check([])['status'], 'missing')
        self.assertEqual(self.check([order(action='BUY')])['status'], 'wrong_side')
        self.assertEqual(self.check([order(remaining=120)])['status'], 'oversized')
        self.assertEqual(self.check([order(orderType='LMT')])['status'], 'missing')
        self.assertEqual(self.check([order(status='Cancelled')])['status'], 'missing')

    def test_oca_and_duplicate_orders_are_not_double_counted(self):
        self.assertEqual(self.check([order(), order()])['status'], 'covered')
        self.assertEqual(self.check([order(ocaGroup='exit'), order(ocaGroup='exit', permId=11)])['status'], 'covered')
        self.assertEqual(self.check([order(), order(permId=11)])['status'], 'oversized')
        self.assertEqual(self.check([order(ocaGroup='exit'), order(conId=456, permId=11, ocaGroup='exit')])['status'], 'verify')

    def test_unverified_quantities_statuses_conditions_and_parents_do_not_claim_protection(self):
        for extra in [{'remaining': None}, {'status': 'Inactive'}, {'status': 'PendingCancel'}, {'conditional': True}, {'goodAfterTime': '20260908 09:30:00 US/Eastern'}, {'auxPrice': None}]:
            self.assertEqual(self.check([order(**extra)])['status'], 'verify')
        self.assertEqual(self.check([order(parentId=2), order(orderId=2, orderType='LMT', action='BUY', permId=12)])['status'], 'verify')

    def test_account_and_contract_matching_never_uses_ticker_as_proxy(self):
        for extra in [{'account': 'OTHER'}, {'conId': 456}]:
            self.assertEqual(self.check([order(**extra)])['status'], 'missing')
        book = metrics()
        book['positions'][0]['conId'] = None
        self.assertEqual(stop_checks(book, snapshot([order(conId=None)]))['byHolding']['IGV:LONG']['status'], 'verify')

    def test_disconnected_cached_failed_partial_and_undated_snapshots_are_unavailable(self):
        for extra in [{'liveVerified': False}, {'ok': False}, {'from_cache': True}, {'complete': False}, {'asOf': None}, {'asOf': '2026-09-07T20:01:00Z'}, {'source': 'mock'}]:
            self.assertEqual(stop_checks(metrics(), {**snapshot([order()]), **extra})['status'], 'unavailable')
        self.assertEqual(stop_checks({**metrics(), 'available': False}, snapshot([order()]))['byHolding'], {})

    def test_captured_evidence_is_immutable(self):
        book, data = metrics(), snapshot([order()])
        before = copy.deepcopy((book, data))
        stop_checks(book, data)
        self.assertEqual((book, data), before)
