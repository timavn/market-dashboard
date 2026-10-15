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

describe('calendar reuse integrity', () => {
  test('year-specific observed dates and historic closures remain independent', () => {
    expect(getUsEquityHoliday('2021-07-05')?.name).toBe('Independence Day');
    expect(getUsEquityHoliday('2021-12-24')?.name).toBe('Christmas Day');
    expect(getUsEquityHoliday('2022-01-03')).toBeNull();
    expect(getUsEquityHoliday('2023-01-02')?.name).toBe("New Year's Day");
    expect(getUsEquityHoliday('2021-06-18')).toBeNull();
    expect(getUsEquityHoliday('2022-06-20')?.name).toBe('Juneteenth National Independence Day');
    expect(getUsEquityHoliday('1997-01-20')).toBeNull();
    expect(getUsEquityHoliday('1998-01-19')?.name).toBe('Martin Luther King Jr. Day');
    expect(getUsEquityHoliday('2001-09-12')?.name).toBe('September 11 market closure');
    expect(getUsEquityHoliday('2012-10-29')?.name).toBe('Hurricane Sandy market closure');
  });

  test('mutating public results cannot change later trading-date decisions', () => {
    const holidays = usEquityMarketHolidays(2026);
    const holiday = holidays.find(row => row.date === '2026-07-03');
    holiday.date = '2026-07-02';
    holiday.name = 'modified';
    holidays.length = 0;
    const lookup = getUsEquityHoliday('2026-07-03');
    lookup.name = 'also modified';
    expect(getUsEquityHoliday('2026-07-03')?.name).toBe('Independence Day');
    expect(isTradingDateKey('2026-07-03')).toBe(false);
    expect(isTradingDateKey('2026-07-02')).toBe(true);
  });

  test('bounded eviction preserves deterministic dates when an older year is revisited', () => {
    const original = usEquityMarketHolidays(2026);
    for (let year = 1700; year < 2000; year += 1) usEquityMarketHolidays(year);
    expect(usEquityMarketHolidays(2026)).toEqual(original);
    expect(isTradingDateKey('2026-09-07')).toBe(false);
  });

  test('invalid month/day keys remain invalid and genuine leap days stay supported', () => {
    for (const date of ['2026-02-29', '2026-13-01', '2026-00-20', '2026-2-03', 'invalid']) {
      expect(isTradingDateKey(date)).toBe(false);
      expect(getUsEquityHoliday(date)).toBeNull();
      expect(classifyUsEquityClosedDateKey(date)).toBeNull();
    }
    expect(isTradingDateKey('2024-02-29')).toBe(true);
  });
});
