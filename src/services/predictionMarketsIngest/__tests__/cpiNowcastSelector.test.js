const {
  selectCpiForecast,
} = require('../cpiNowcastSelector.cjs');

function snapshot() {
  return {
    date: '2026-08-11',
    data: {
      metric: 'Headline CPI YoY',
      forecasts: [
        {
          reportMonth: '2026-07',
          forecastMonth: 'July 2026',
          releaseAt: '2026-08-12T12:30:00.000Z',
          publishedAt: '2026-08-11T15:00:00.000Z',
          scenarios: { upper: 3.58, base: 3.47, lower: 3.36 },
        },
        {
          reportMonth: '2026-08',
          forecastMonth: 'August 2026',
          releaseAt: '2026-09-11T12:30:00.000Z',
          publishedAt: '2026-08-11T15:00:00.000Z',
          scenarios: { upper: 3.70, base: 3.57, lower: 3.44 },
        },
      ],
    },
  };
}

describe('CPI nowcast release selector', () => {
  test('uses the outgoing month before 8:30 AM ET and the next month at the exact cutoff', () => {
    const before = selectCpiForecast([snapshot()], {
      now: new Date('2026-08-12T12:29:59.999Z'),
      current: true,
    });
    const atCutoff = selectCpiForecast([snapshot()], {
      now: new Date('2026-08-12T12:30:00.000Z'),
      current: true,
    });

    expect(before).toEqual(expect.objectContaining({
      monthId: '2026-07',
      releaseAt: '2026-08-12T12:30:00.000Z',
    }));
    expect(atCutoff).toEqual(expect.objectContaining({
      monthId: '2026-08',
      scenarios: { upper: 3.7, base: 3.57, lower: 3.44 },
    }));
  });

  test('fails closed when no future report has a validated pre-release forecast', () => {
    const selected = selectCpiForecast([snapshot()], {
      now: new Date('2026-10-01T12:00:00.000Z'),
      current: true,
    });
    expect(selected).toBeNull();
  });
});
