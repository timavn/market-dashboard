const {
  CPI_RELEASES,
  buildCpiNowcastHistory,
  roundCpiForDisplay,
} = require('./cpiNowcastHistory.cjs');

const BACKFILL = [
  ['2025-07', '2025-08-04T12:37:03.000Z', 2.72, 2.60, 2.49],
  ['2025-08', '2025-09-10T13:37:02.000Z', 2.94, 2.83, 2.71],
  ['2025-09', '2025-10-22T11:01:46.000Z', 3.21, 3.10, 2.99],
  ['2025-10', '2025-11-13T12:02:31.000Z', 3.07, 2.96, 2.85],
  ['2025-11', '2025-12-17T15:07:02.000Z', 3.15, 3.04, 2.93],
  ['2025-12', '2025-12-31T15:04:02.000Z', 2.67, 2.56, 2.45],
  ['2026-01', null, 2.61, 2.50, 2.39, 'user_confirmed_closest_pre_release'],
  ['2026-02', null, 2.55, 2.44, 2.33, 'user_confirmed_closest_pre_release'],
  ['2026-03', '2026-04-02T11:51:02.000Z', 3.42, 3.31, 3.20],
  ['2026-04', '2026-05-11T14:32:06.000Z', 3.73, 3.62, 3.51],
  ['2026-05', '2026-06-03T18:57:02.000Z', 4.35, 4.24, 4.13],
  ['2026-06', '2026-07-06T17:55:06.000Z', 3.94, 3.83, 3.72],
  ['2026-07', '2026-08-05T14:39:06.000Z', 3.58, 3.47, 3.36],
];

function snapshotFromForecasts(forecasts) {
  return {
    date: '2026-08-09',
    snapshotType: 'inflation-nowcast',
    data: {
      metric: 'Headline CPI YoY',
      forecasts: forecasts.map(([reportMonth, publishedAt, upper, base, lower, selectionBasis]) => ({
        reportMonth,
        releaseAt: CPI_RELEASES[reportMonth],
        publishedAt,
        selectionBasis,
        selected: Boolean(selectionBasis),
        source: selectionBasis
          ? { kind: 'user_confirmed_chart', priority: 100 }
          : { kind: 'gmail', messageId: `message-${reportMonth}`, product: 'macro-pro', priority: 20 },
        scenarios: { upper, base, lower },
      })),
    },
  };
}

test('uses BLS-style one-decimal rounding for midpoint values', () => {
  expect(roundCpiForDisplay(2.55)).toBe(2.6);
  expect(roundCpiForDisplay(3.15)).toBe(3.2);
  expect(roundCpiForDisplay(4.35)).toBe(4.4);
});

test('resolves the approved 13-month backfill and keeps July provisional', () => {
  const response = buildCpiNowcastHistory([snapshotFromForecasts(BACKFILL)], {
    from: '2025-07',
    to: '2026-07',
    now: new Date('2026-08-09T19:00:00.000Z'),
  });
  expect(response.entries).toHaveLength(13);
  expect(response.entries.map((entry) => [
    entry.scenarios.upper.rounded,
    entry.scenarios.base.rounded,
    entry.scenarios.lower.rounded,
  ])).toEqual([
    [2.7, 2.6, 2.5],
    [2.9, 2.8, 2.7],
    [3.2, 3.1, 3.0],
    [3.1, 3.0, 2.9],
    [3.2, 3.0, 2.9],
    [2.7, 2.6, 2.5],
    [2.6, 2.5, 2.4],
    [2.6, 2.4, 2.3],
    [3.4, 3.3, 3.2],
    [3.7, 3.6, 3.5],
    [4.4, 4.2, 4.1],
    [3.9, 3.8, 3.7],
    [3.6, 3.5, 3.4],
  ]);
  expect(response.entries.at(-1).status).toBe('provisional');
  expect(response.entries.at(-1).scenarios.base.raw).toBe(3.47);
  expect(response.entries[6].publishedAt).toBeNull();
  expect(response.entries[6].selectionBasis).toBe('user_confirmed_closest_pre_release');
});

test('takes the latest publication strictly before the 8:30 ET release', () => {
  const releaseAt = CPI_RELEASES['2025-10'];
  const snapshot = snapshotFromForecasts([]);
  snapshot.data.forecasts = [
    {
      reportMonth: '2025-10',
      releaseAt,
      publishedAt: '2025-11-05T12:02:04.000Z',
      source: { kind: 'gmail', messageId: 'older' },
      scenarios: { upper: 3.01, base: 2.90, lower: 2.79 },
    },
    {
      reportMonth: '2025-10',
      releaseAt,
      publishedAt: '2025-11-13T12:02:31.000Z',
      source: { kind: 'gmail', messageId: 'accepted' },
      scenarios: { upper: 3.07, base: 2.96, lower: 2.85 },
    },
    {
      reportMonth: '2025-10',
      releaseAt,
      publishedAt: '2025-11-13T13:30:00.000Z',
      source: { kind: 'gmail', messageId: 'at-cutoff' },
      scenarios: { upper: 9.9, base: 9.8, lower: 9.7 },
    },
  ];
  const [entry] = buildCpiNowcastHistory([snapshot], {
    from: '2025-10',
    to: '2025-10',
    now: new Date('2025-11-14T00:00:00.000Z'),
  }).entries;
  expect(entry.source.messageId).toBe('accepted');
  expect(entry.scenarios.base.raw).toBe(2.96);
  expect(entry.status).toBe('final-pre-release');
});

test('uses the latest available forecast before release and freezes it after release', () => {
  const snapshot = snapshotFromForecasts([]);
  snapshot.data.forecasts = [
    {
      reportMonth: '2026-07',
      releaseAt: CPI_RELEASES['2026-07'],
      publishedAt: '2026-08-03T11:30:07.000Z',
      source: { kind: 'gmail', messageId: 'first' },
      scenarios: { upper: 3.60, base: 3.49, lower: 3.38 },
    },
    {
      reportMonth: '2026-07',
      releaseAt: CPI_RELEASES['2026-07'],
      publishedAt: '2026-08-05T14:39:06.000Z',
      source: { kind: 'gmail', messageId: 'last' },
      scenarios: { upper: 3.58, base: 3.47, lower: 3.36 },
    },
    {
      reportMonth: '2026-07',
      releaseAt: CPI_RELEASES['2026-07'],
      publishedAt: '2026-08-12T13:08:03.000Z',
      source: { kind: 'gmail', messageId: 'post-release' },
      scenarios: { upper: 5.00, base: 4.90, lower: 4.80 },
    },
  ];
  const provisional = buildCpiNowcastHistory([snapshot], {
    from: '2026-07',
    to: '2026-07',
    now: new Date('2026-08-09T19:00:00.000Z'),
  }).entries[0];
  const frozen = buildCpiNowcastHistory([snapshot], {
    from: '2026-07',
    to: '2026-07',
    now: new Date('2026-08-13T19:00:00.000Z'),
  }).entries[0];
  expect(provisional.status).toBe('provisional');
  expect(frozen.status).toBe('final-pre-release');
  expect(provisional.source.messageId).toBe('last');
  expect(frozen.source.messageId).toBe('last');
});

test('deduplicates equivalent product deliveries and prefers Macro Pro provenance', () => {
  const snapshot = snapshotFromForecasts([]);
  snapshot.data.forecasts = [
    {
      reportMonth: '2026-07',
      releaseAt: CPI_RELEASES['2026-07'],
      publishedAt: '2026-08-05T14:39:07.000Z',
      source: { kind: 'gmail', messageId: 'info', product: 'general', priority: 10 },
      scenarios: { upper: 3.58, base: 3.47, lower: 3.36 },
    },
    {
      reportMonth: '2026-07',
      releaseAt: CPI_RELEASES['2026-07'],
      publishedAt: '2026-08-05T14:39:06.000Z',
      source: { kind: 'gmail', messageId: 'macro', product: 'macro-pro', priority: 20 },
      scenarios: { upper: 3.58, base: 3.47, lower: 3.36 },
    },
  ];
  const [entry] = buildCpiNowcastHistory([snapshot], {
    from: '2026-07',
    to: '2026-07',
    now: new Date('2026-08-09T19:00:00.000Z'),
  }).entries;
  expect(entry.source.messageId).toBe('macro');
  expect(entry.source.product).toBe('macro-pro');
});

test('returns unavailable for invalid scenario ordering instead of inventing values', () => {
  const snapshot = snapshotFromForecasts([]);
  snapshot.data.forecasts = [{
    reportMonth: '2026-07',
    releaseAt: CPI_RELEASES['2026-07'],
    publishedAt: '2026-08-05T14:39:06.000Z',
    scenarios: { upper: 3.40, base: 3.50, lower: 3.30 },
  }];
  const [entry] = buildCpiNowcastHistory([snapshot], {
    from: '2026-07',
    to: '2026-07',
    now: new Date('2026-08-09T19:00:00.000Z'),
  }).entries;
  expect(entry.status).toBe('unavailable');
  expect(entry.scenarios).toBeNull();
});
