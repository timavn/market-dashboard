import asyncio
import copy
from datetime import datetime, timedelta, timezone
import unittest
from unittest.mock import AsyncMock, Mock, patch

from attention_context import capture_attention_context
from portfolio_sizing import PortfolioSizingReader
from test_portfolio_brief import reference_payload

NOW = datetime(2026, 9, 22, 16, tzinfo=timezone.utc)
ASOF = '2026-09-22T16:00:00Z'


def book(symbols=('IGV',)):
    return {'liveVerified': True, 'freshness': 'live', 'provider': 'ibkr', 'asOf': ASOF,
            'data': {'accounts': ['account'], 'coverageComplete': True, 'positions': [
                {'account': 'account', 'symbol': symbol, 'quantity': 10, 'instrumentCategory': 'other'} for symbol in symbols]}}


def project(source):
    data = source.get('data') or {}
    positions = [{'symbol': item['symbol'], 'quantity': item['quantity'], 'category': item.get('instrumentCategory')} for item in data.get('positions', [])]
    columns = ['symbol', 'quantity', 'category']
    return {**source, 'data': {**data, 'positionTable': {'columns': columns, 'rows': [[row.get(column) for column in columns] for row in positions], 'rowCount': len(positions)}}}


class ContextTests(unittest.IsolatedAsyncioTestCase):
    async def test_missing_interest_history_does_not_block_research_assessment(self):
        result = await self.capture(balance_reader=AsyncMock(return_value={'data': {'interestStatus': None}}))
        self.assertFalse(result['account']['historyVerified'])
        self.assertTrue(result['complete'])

    async def test_tick_is_display_context_that_never_blocks_the_scan(self):
        tick = {'value': 'BULLISH', 'status': 'published', 'position': 'Buy', 'publishedAt': ASOF}
        overlay = {'book': {'rows': []}}
        with patch('attention_context.portfolio_tick_readings', return_value=({'IGV': tick}, [])) as readings:
            result = await self.capture(tick_reader=AsyncMock(return_value=overlay))
        readings.assert_called_once_with(overlay, as_of=ASOF)
        self.assertEqual(result['holdings']['ruleHoldings'][0]['tick'], tick)
        self.assertTrue(result['complete'])
        failed = await self.capture(tick_reader=AsyncMock(side_effect=RuntimeError('down')))
        self.assertNotIn('tick', failed['holdings']['ruleHoldings'][0])
        self.assertIn({'component': 'tick', 'status': 'unavailable', 'reason': 'RuntimeError'}, failed['diagnostics'])
        self.assertTrue(failed['complete'])

    async def capture(self, **overrides):
        async def symbols_reader(symbols, day):
            return {'bySymbol': {symbol: {'directReferences': [], 'decision': {}} for symbol in symbols}}
        args = dict(market_date_reader=AsyncMock(return_value='2026-09-22'), holdings_reader=AsyncMock(return_value=book()),
                    portfolio_reader=AsyncMock(return_value=book()), universe_reader=AsyncMock(return_value={'bySymbol': {}, 'scanComplete': True}),
                    symbols_reader=symbols_reader, documents_reader=Mock(return_value={'products': []}), projector=project,
                    sizing_reader=Mock(read_current=AsyncMock(return_value={'bySymbol': {}, 'complete': True})), research_index=Mock(), now=NOW)
        args.update(overrides)
        with patch('attention_context.attach_finding_source_reports', side_effect=lambda value, _: value):
            return await capture_attention_context(**args)

    async def test_thirty_second_scans_never_claim_holdings_complete_without_sizing(self):
        # Regression: sizing inputs expired after 60s and were only re-read once
        # gone, so every other 30s scan lacked them. XLK's TREND_BREAK then
        # vanished from a scan still claiming the portfolio complete, and the
        # Inbox resolved and reopened it on alternate scans.
        clock = {'now': NOW}
        reader = PortfolioSizingReader('http://api', AsyncMock(side_effect=lambda symbols: reference_payload(symbols)),
                                       clock=lambda: clock['now'])
        scans = []
        for scan in range(6):
            clock['now'] = now = NOW + timedelta(seconds=30.5 * scan)
            value = {**book(('XLK',)), 'asOf': now.isoformat().replace('+00:00', 'Z')}
            result = await self.capture(holdings_reader=AsyncMock(return_value=value), portfolio_reader=AsyncMock(return_value=value),
                                        sizing_reader=reader, now=now)
            scans.append((result['holdings']['researchComplete'], bool(result['holdings']['ruleHoldings'][0]['sizingInputs'])))
            await asyncio.gather(*reader.pending.values())
        # Before the fix: [(True, False), (True, True), (True, False), ...]
        self.assertEqual(scans, [(True, True)] * 6)

    async def test_unanswered_sizing_read_is_not_a_complete_portfolio_scan(self):
        reader = PortfolioSizingReader('http://api', AsyncMock(side_effect=OSError('metrics offline')))
        result = await self.capture(sizing_reader=reader)
        self.assertEqual(result['holdings']['ruleHoldings'][0]['sizingInputs'], {})
        self.assertFalse(result['holdings']['researchComplete'])
        self.assertFalse(result['complete'])
        self.assertTrue(result['holdings']['complete'])

    async def test_independent_complete_book_is_used_when_valuation_fails(self):
        result = await self.capture(portfolio_reader=AsyncMock(side_effect=OSError('provider')))
        self.assertTrue(result['holdings']['complete'])
        self.assertEqual(result['holdings']['positions'][0]['symbol'], 'IGV')
        self.assertEqual(result['holdings']['currentHoldings'], [])
        self.assertIsNone(result['holdings']['ruleHoldings'][0]['weightPct'])
        self.assertTrue(result['complete'])

    async def test_incomplete_valuation_cannot_hide_holdings_beyond_its_limit(self):
        symbols = tuple('S' + str(i) for i in range(205))
        calls = []
        async def research_symbols(requested, day):
            calls.append(len(requested))
            return {'bySymbol': {symbol: {} for symbol in requested}}
        result = await self.capture(holdings_reader=AsyncMock(return_value=book(symbols)), portfolio_reader=AsyncMock(return_value=book(symbols[:200])), symbols_reader=research_symbols)
        self.assertEqual(len(result['holdings']['positions']), 205)
        self.assertEqual(sorted(calls), [5, 200])
        self.assertTrue(result['complete'])

    async def test_invalid_current_book_is_not_rescued_by_valuation(self):
        for change in ({'mock': True}, {'cacheOnly': True}, {'seeded': True}, {'connected': False}, {'stale': True}, {'asOf': '2026-09-22T15:58:00Z'}):
            value = book(); value.update(change)
            result = await self.capture(holdings_reader=AsyncMock(return_value=value))
            self.assertFalse(result['holdings']['complete'])
            self.assertEqual(result['holdings']['positions'], [])
            self.assertTrue(result['research']['scanComplete'])

    async def test_empty_verified_book_is_complete_and_does_not_need_symbol_reads(self):
        empty = book(())
        result = await self.capture(holdings_reader=AsyncMock(return_value=empty), portfolio_reader=AsyncMock(return_value=empty))
        self.assertTrue(result['holdings']['complete'])
        self.assertEqual(result['holdings']['positions'], [])

    async def test_research_failure_does_not_erase_independent_holdings(self):
        result = await self.capture(universe_reader=AsyncMock(side_effect=OSError('offline')))
        self.assertTrue(result['holdings']['complete'])
        self.assertFalse(result['complete'])
        self.assertEqual(result['documents'], {'products': []})

    async def test_balance_nested_cache_is_withheld_and_healthy_capacity_is_not_an_issue(self):
        balance = {'liveVerified': True, 'freshness': 'live_with_dated_verified_history', 'asOf': ASOF,
                   'data': {'current': {'available': True, 'status': 'live', 'source': 'ibkr_live_session', 'fromCache': False,
                                        'margin': {'available': True, 'status': 'live', 'cacheOnly': True},
                                        'capacity': {'available': True, 'status': 'live'}},
                            'interestStatus': {'available': True, 'comparison': {'status': 'verified'}}}}
        seen = []
        def exceptions(data, *, current_live):
            seen.append((copy.deepcopy(data), current_live))
            return ['Cash-floor and reserve requirements leave no buffered capacity for additional longs.']
        result = await self.capture(balance_reader=AsyncMock(return_value=balance), balance_exceptions=exceptions)
        self.assertTrue(result['account']['verified'])
        self.assertEqual(result['account']['issues'], [])
        self.assertNotIn('margin', seen[0][0]['current'])


if __name__ == '__main__':
    unittest.main()
