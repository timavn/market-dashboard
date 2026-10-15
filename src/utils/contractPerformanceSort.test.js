const { sortPerformanceRows } = require('./contractPerformanceSort.cjs');

describe('shared Contract P&L ordering', () => {
  test('sorts by entry date without changing the source rows or substituting event/expiry dates', () => {
    const rows = Object.freeze([
      Object.freeze({ id: 'early', openedAt: '2026-08-14', eventDate: '2026-08-18', expiration: '20260819' }),
      Object.freeze({ id: 'late', openedAt: '2026-08-17', eventDate: '2026-08-17', expiration: '20260818' }),
    ]);
    expect(sortPerformanceRows(rows).map((row) => row.id)).toEqual(['late', 'early']);
    expect(rows.map((row) => row.id)).toEqual(['early', 'late']);
  });

  test.each(['asc', 'desc'])('keeps absent numeric readings last for %s and uses stable id ties', (direction) => {
    const rows = [{ id: 'b', pnl: 1 }, { id: 'missing', pnl: null }, { id: 'a', pnl: 1 }];
    expect(sortPerformanceRows(rows, 'pnl', direction).map((row) => row.id)).toEqual(['a', 'b', 'missing']);
  });

  test('status direction reverses groups but preserves market and natural contract order inside a group', () => {
    const rows = [
      { id: 'fes-100', status: 'open', market: 'sp500', contractLabel: 'Above 100 YES' },
      { id: 'fes-20', status: 'open', market: 'sp500', contractLabel: 'Above 20 YES' },
      { id: 'gold', status: 'open', market: 'gold', contractLabel: 'Above 10 YES' },
      { id: 'settled', status: 'verified', resolutionType: 'expiry', market: 'wti' },
    ];
    expect(sortPerformanceRows(rows, 'status', 'asc').map((row) => row.id)).toEqual(['gold', 'fes-20', 'fes-100', 'settled']);
    expect(sortPerformanceRows(rows, 'status', 'desc').map((row) => row.id)).toEqual(['settled', 'gold', 'fes-20', 'fes-100']);
  });

  test('the ledger exposes the same shared sorter and keeps positional defaults', () => {
    const ledger = require('../services/predictionMarketPerformanceLedger.cjs');
    expect(ledger.sortPerformanceRows).toBe(sortPerformanceRows);
    expect(sortPerformanceRows()).toEqual([]);
  });
});
