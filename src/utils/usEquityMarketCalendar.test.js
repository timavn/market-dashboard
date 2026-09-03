const {
  classifyUsEquityClosedDateKey,
  closedUsEquityDatesBetween,
  getUsEquityHoliday,
  isTradingDateKey,
  usEquityMarketHolidays,
} = require('./usEquityMarketCalendar.cjs');

describe('U.S. cash-equity calendar', () => {
  test('matches the 2026 full-day NYSE holiday dates used by the SPX chart', () => {
    const holidays = new Map(usEquityMarketHolidays(2026).map(({ date, name }) => [date, name]));

    expect(holidays.get('2026-04-03')).toBe('Good Friday');
    expect(holidays.has('2026-03-27')).toBe(false);
    expect(holidays.get('2026-07-03')).toBe('Independence Day');
    expect(holidays.get('2026-11-26')).toBe('Thanksgiving Day');
  });

  test('preserves the NYSE Saturday New Year exception', () => {
    expect(getUsEquityHoliday('2021-12-31')).toBeNull();
    expect(isTradingDateKey('2021-12-31')).toBe(true);
    expect(classifyUsEquityClosedDateKey('2022-01-01')).toEqual({
      date: '2022-01-01',
      type: 'weekend',
      holidayName: null,
    });
  });

  test('keeps scheduled early closes as trading sessions', () => {
    expect(isTradingDateKey('2026-11-27')).toBe(true);
    expect(isTradingDateKey('2026-12-24')).toBe(true);
    expect(getUsEquityHoliday('2026-11-27')).toBeNull();
    expect(getUsEquityHoliday('2026-12-24')).toBeNull();
  });

  test('enumerates each weekend and holiday calendar date separately', () => {
    expect(closedUsEquityDatesBetween('2026-09-04', '2026-09-08')).toEqual([
      { date: '2026-09-05', type: 'weekend', holidayName: null },
      { date: '2026-09-06', type: 'weekend', holidayName: null },
      { date: '2026-09-07', type: 'holiday', holidayName: 'Labor Day' },
    ]);
    expect(closedUsEquityDatesBetween('2026-11-25', '2026-11-27')).toEqual([
      { date: '2026-11-26', type: 'holiday', holidayName: 'Thanksgiving Day' },
    ]);
  });
});
