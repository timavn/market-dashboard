import { buildMultiDayChartLayout } from './riskRangeChartSessions';

const FIVE_SESSION_DATES = ['2026-09-04', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11'];
const TEN_SESSION_DATES = ['2026-08-28', '2026-08-31', '2026-09-01', '2026-09-02', '2026-09-03', ...FIVE_SESSION_DATES];
const PLOT_WIDTH = 1600;

// Historical prices are local test fixtures. Calendar extension must add only
// closure annotations, never prices, ranges, or additional trading sessions.
const chartFixture = (dates) => ({
  points: dates.flatMap((date, index) => [
    { timestamp: Date.parse(`${date}T13:30:00Z`), value: 6400 + index, sessionDate: date },
    { timestamp: Date.parse(`${date}T20:00:00Z`), value: 6410 + index, sessionDate: date },
  ]),
  dailyRanges: dates.map((date) => ({
    date,
    startAt: Date.parse(`${date}T13:30:00Z`),
    endAt: Date.parse(`${date}T20:00:00Z`),
    status: 'unavailable',
    references: [],
  })),
});

const layoutFor = (dates, configuration) => {
  const chart = chartFixture(dates);
  return buildMultiDayChartLayout(chart.points, chart.dailyRanges, dates.length, PLOT_WIDTH, configuration);
};

describe('multi-day chart trailing calendar closures', () => {
  test.each([
    [5, FIVE_SESSION_DATES, 44],
    [10, TEN_SESSION_DATES, 28],
  ])('extends %i trading sessions through Sunday without adding market observations', (count, dates, closedDayWidthPx) => {
    const chart = chartFixture(dates);
    const before = JSON.stringify(chart);
    const layout = buildMultiDayChartLayout(chart.points, chart.dailyRanges, count, PLOT_WIDTH, {
      calendar: 'us_equity', closedDayWidthPx, throughDate: '2026-09-13',
    });

    expect(layout.sessions.map((session) => session.date)).toEqual(dates);
    expect(layout.sessions).toHaveLength(count);
    expect(layout.trailingGap.closedDays.map(({ date, type }) => ({ date, type }))).toEqual([
      { date: '2026-09-12', type: 'weekend' },
      { date: '2026-09-13', type: 'weekend' },
    ]);
    expect(layout.gaps.at(-1)).toBe(layout.trailingGap);
    expect(layout.closedDays.slice(-2)).toEqual(layout.trailingGap.closedDays);
    expect(layout.trailingGap.segments.every((segment) => segment.type === 'closed')).toBe(true);
    expect(layout.trailingGap.startX).toBe(layout.sessions.at(-1).endX);
    expect(layout.maxX).toBe(layout.trailingGap.endX);
    expect(layout.latestPoint).toMatchObject({ sessionDate: '2026-09-11', value: 6410 + count - 1 });
    expect(layout.latestPoint.plotX).toBe(layout.sessions.at(-1).endX);
    expect(layout.latestPoint.plotX).toBeLessThan(layout.maxX);
    expect(layout.points.filter((point) => point.value != null).map((point) => point.value))
      .toEqual(chart.points.map((point) => point.value));
    expect(layout.points.filter((point) => point.plotX > layout.sessions.at(-1).endX)
      .every((point) => point.value == null)).toBe(true);
    expect(layout.points.some((point) => ['2026-09-12', '2026-09-13'].includes(point.sessionDate))).toBe(false);
    expect(layout.axisGridTemplate.endsWith(layout.trailingGap.segments.map((segment) => `${segment.width}fr`).join(' ')))
      .toBe(true);
    layout.closedDays.forEach((closure) => {
      expect(closure.width * (PLOT_WIDTH / layout.maxX)).toBeCloseTo(closedDayWidthPx, 5);
      expect((closure.bandEndX - closure.bandStartX) * (PLOT_WIDTH / layout.maxX)).toBeCloseTo(closedDayWidthPx - 4, 5);
    });
    expect(JSON.stringify(chart)).toBe(before);
  });

  test.each([
    ['2026-09-10', []],
    ['2026-09-11', []],
    ['2026-09-12', ['2026-09-12']],
    ['2026-09-13', ['2026-09-12', '2026-09-13']],
  ])('includes only closures through the requested calendar date %s', (throughDate, expectedDates) => {
    const layout = layoutFor(FIVE_SESSION_DATES, { calendar: 'us_equity', throughDate });

    expect(layout.trailingGap?.closedDays.map((closure) => closure.date) || []).toEqual(expectedDates);
    expect(layout.trailingGap === null).toBe(expectedDates.length === 0);
    expect(layout.maxX > layout.sessions.at(-1).endX).toBe(expectedDates.length > 0);
  });

  test('includes Labor Day after the weekend with its holiday identity', () => {
    const layout = layoutFor(['2026-09-03', '2026-09-04'], {
      calendar: 'us_equity', throughDate: '2026-09-07', closedDayWidthPx: 44,
    });

    expect(layout.trailingGap.closedDays.map(({ date, type, holidayName }) => ({ date, type, holidayName }))).toEqual([
      { date: '2026-09-05', type: 'weekend', holidayName: null },
      { date: '2026-09-06', type: 'weekend', holidayName: null },
      { date: '2026-09-07', type: 'holiday', holidayName: 'Labor Day' },
    ]);
    expect(layout.latestPoint.sessionDate).toBe('2026-09-04');
  });

  test('stops at a missing open date instead of jumping to a later weekend', () => {
    const missingFriday = layoutFor(['2026-09-09', '2026-09-10'], {
      calendar: 'us_equity', throughDate: '2026-09-13',
    });
    const laterWeekend = layoutFor(FIVE_SESSION_DATES, {
      calendar: 'us_equity', throughDate: '2026-09-20',
    });

    expect(missingFriday.trailingGap).toBeNull();
    expect(missingFriday.maxX).toBe(missingFriday.sessions.at(-1).endX);
    expect(laterWeekend.trailingGap.closedDays.map((closure) => closure.date))
      .toEqual(['2026-09-12', '2026-09-13']);
    expect(laterWeekend.closedDays.some((closure) => closure.date >= '2026-09-14')).toBe(false);
  });

  test.each([
    {},
    { throughDate: '2026-09-13' },
    { calendar: 'us_equity' },
    { calendar: 'us_equity', throughDate: 'invalid' },
    { calendar: 'continuous', throughDate: '2026-09-13' },
  ])('leaves the final trading session as the endpoint when extension is not applicable: %j', (configuration) => {
    const layout = layoutFor(FIVE_SESSION_DATES, configuration);

    expect(layout.trailingGap).toBeNull();
    expect(layout.maxX).toBe(layout.sessions.at(-1).endX);
    expect(layout.closedDays.some((closure) => closure.date > '2026-09-11')).toBe(false);
  });
});
