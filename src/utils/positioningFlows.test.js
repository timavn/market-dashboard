/** @jest-environment node */
const {
  MARGIN_HEADERS,
  parseFinraMarginRows,
  summarizeMargin,
  summarizeMoneyFunds,
} = require('./positioningFlows.cjs');

const header = [MARGIN_HEADERS.month, MARGIN_HEADERS.debit, MARGIN_HEADERS.cashCredit, MARGIN_HEADERS.marginCredit];

// FINRA lists newest first, in millions.
function marginRows(months = 14) {
  return [header, ...Array.from({ length: months }, (_, index) => {
    const date = new Date(Date.UTC(2026, 8 - index, 1));
    return [date.toISOString().slice(0, 7), 1_400_000 - index * 10_000, 200_000, 200_000];
  })];
}

describe('FINRA margin statistics', () => {
  test('parses millions into billions, oldest first, and nets free credit', () => {
    const rows = parseFinraMarginRows(marginRows(2));
    expect(rows).toEqual([
      { month: '2026-08', marginDebt: 1390, freeCredit: 400, netLeverage: 990 },
      { month: '2026-09', marginDebt: 1400, freeCredit: 400, netLeverage: 1000 },
    ]);
  });

  test('rejects a workbook whose columns changed', () => {
    expect(() => parseFinraMarginRows([['Year-Month', 'Debit'], ['2026-09', 1]])).toThrow(/columns changed/);
  });

  test('labels rising leverage and dates the month at its last day', () => {
    const summary = summarizeMargin(parseFinraMarginRows(marginRows()), new Date('2026-10-24T00:00:00Z'));
    expect(summary.status).toBe('ok');
    expect(summary.latest).toMatchObject({ month: '2026-09', asOf: '2026-09-30', leverage: 'rising' });
    expect(summary.latest.changes['3m'].marginDebt).toBeCloseTo(1400 / 1370 - 1);
    expect(summarizeMargin(parseFinraMarginRows(marginRows()), new Date('2027-01-15T00:00:00Z')).status).toBe('stale');
  });
});

describe('retail money funds', () => {
  test('labels cash building and marks old weekly data stale', () => {
    const series = Array.from({ length: 20 }, (_, index) => ({
      date: new Date(Date.UTC(2026, 3, 13) + index * 7 * 86400000).toISOString().slice(0, 10),
      value: 2900 + index * 10,
    }));
    const summary = summarizeMoneyFunds(series, new Date('2026-09-05T00:00:00Z'));
    expect(summary).toMatchObject({ status: 'ok', latest: { date: '2026-08-24', retailMoneyFunds: 3090, cash: 'building' } });
    expect(summarizeMoneyFunds(series, new Date('2026-12-01T00:00:00Z')).status).toBe('stale');
    expect(summarizeMoneyFunds([])).toEqual({ status: 'unavailable', latest: null });
  });
});
