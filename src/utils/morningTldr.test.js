import {
  articleTakeaways,
  buildRiskRangeComparison,
  classifyRiskRangeChanges,
  compareRiskRanges,
  diffPositionGroups,
  extractBodySections,
  getSignalChanges,
  getSourceStatus,
  getTopThreeThings,
} from './morningTldr';

describe('morning TL;DR helpers', () => {
  test('normalizes and orders the source-listed Top 3 Things', () => {
    expect(getTopThreeThings({
      data: {
        items: [
          { rank: 3, title: 'ATHs', body: 'Book some gains into strength.' },
          { rank: 1, title: 'USD', body: 'The dollar is making fresh lows.' },
          { rank: 2, title: 'Gold', body: 'Gold remains the clean expression.' },
        ],
      },
    })).toEqual([
      { rank: 1, title: 'USD', body: 'The dollar is making fresh lows.' },
      { rank: 2, title: 'Gold', body: 'Gold remains the clean expression.' },
      { rank: 3, title: 'ATHs', body: 'Book some gains into strength.' },
    ]);
  });

  test('compares position side changes and preserves explicit moves', () => {
    const diff = diffPositionGroups(
      { data: { longs: ['A', 'B'], shorts: ['C'], neutrals: [] } },
      { data: { longs: ['A'], shorts: ['B', 'D'], neutrals: [] } },
    );

    expect(diff.moved).toEqual([{ value: 'B', from: 'shorts', to: 'longs' }]);
    expect(diff.added).toEqual([{ value: 'C', side: 'shorts' }]);
    expect(diff.removed).toEqual([{ value: 'D', side: 'shorts' }]);
  });

  test('prioritizes risk trend flips and calculates range movement', () => {
    const changes = compareRiskRanges(
      {
        data: {
          GOOGL: { lrr: 330, hrr: 390, trend: 'BEARISH' },
          NVDA: { lrr: 100, hrr: 120, trend: 'BULLISH' },
        },
      },
      {
        data: {
          GOOGL: { lrr: 331, hrr: 386, trend: 'BULLISH' },
          NVDA: { lrr: 100, hrr: 110, trend: 'BULLISH' },
        },
      },
      { trendChanges: [{ ticker: 'GOOGL', oldTrend: 'BULLISH', newTrend: 'BEARISH' }] },
    );

    expect(changes[0]).toMatchObject({ key: 'GOOGL', trendChanged: true, boundsChanged: true });
    expect(changes.find((row) => row.key === 'NVDA')).toMatchObject({ hrrDelta: 10, boundsChanged: true });
  });

  test('keeps explicit OutBucket trend flips even without a regular range row', () => {
    const changes = compareRiskRanges(
      { data: { A: { lrr: 1, hrr: 2, trend: 'BULLISH' } } },
      { data: { A: { lrr: 1, hrr: 2, trend: 'BULLISH' } } },
      { trendChanges: [{ ticker: 'DRAM', oldTrend: 'BEARISH', newTrend: 'NEUTRAL', note: 'outbucket' }] },
    );
    expect(changes).toContainEqual(expect.objectContaining({ key: 'DRAM', trendChanged: true }));
  });

  test('builds one ordered comparison with trend changes, additions, current rows, and removals', () => {
    const comparison = buildRiskRangeComparison(
      {
        data: {
          RANGE: { lrr: 12, hrr: 24, trend: 'NEUTRAL' },
          ADDED: { lrr: 10, hrr: 20, trend: 'BULLISH' },
          TREND: { lrr: 31, hrr: 40, trend: 'BULLISH' },
          UNCHANGED: { lrr: 50, hrr: 60, trend: 'NEUTRAL' },
        },
      },
      {
        data: {
          REMOVED: { lrr: 5, hrr: 8, trend: 'BEARISH' },
          RANGE: { lrr: 11, hrr: 24, trend: 'NEUTRAL' },
          TREND: { lrr: 30, hrr: 40, trend: 'BEARISH' },
          UNCHANGED: { lrr: 50, hrr: 60, trend: 'NEUTRAL' },
        },
      },
    );

    expect(comparison.rows.map((row) => row.key)).toEqual(['TREND', 'ADDED', 'RANGE', 'UNCHANGED', 'REMOVED']);
    expect(comparison.rows.map((row) => row.state)).toEqual(['trend-change', 'added', 'current', 'current', 'removed']);
    expect(comparison.rows.find((row) => row.key === 'TREND')).toMatchObject({ lrrDelta: 1, hrrDelta: 0, trendChanged: true, boundsChanged: true });
    expect(comparison.rows.find((row) => row.key === 'UNCHANGED')).toMatchObject({ lrrDelta: 0, hrrDelta: 0, changed: false });
    expect(comparison.rows.find((row) => row.key === 'REMOVED')).toMatchObject({ lrr: null, hrr: null, priorLrr: 5, priorHrr: 8, priorPrevClose: null });
    expect(comparison.counts).toMatchObject({ changed: 4, trendChanged: 1, added: 1, removed: 1, unchanged: 1 });

    const buckets = classifyRiskRangeChanges(
      { data: { ADDED: { lrr: 10, hrr: 20, trend: 'BULLISH' } } },
      { data: { REMOVED: { lrr: 5, hrr: 8, trend: 'BEARISH' } } },
    );
    expect(buckets.added.map((row) => row.key)).toEqual(['ADDED']);
    expect(buckets.removed.map((row) => row.key)).toEqual(['REMOVED']);
  });

  test('does not classify current rows as new when no prior edition exists', () => {
    const comparison = buildRiskRangeComparison(
      { data: { A: { lrr: 10, hrr: 20, trend: 'BULLISH' } } },
      null,
    );

    expect(comparison.hasPrevious).toBe(false);
    expect(comparison.rows).toEqual([expect.objectContaining({ key: 'A', state: 'uncompared', added: false, lrrDelta: null, hrrDelta: null })]);
    expect(comparison.counts).toMatchObject({ changed: 0, added: 0, removed: 0, uncompared: 1 });
  });

  test('never infers a missing range endpoint or delta', () => {
    const comparison = buildRiskRangeComparison(
      { data: { A: { lrr: null, hrr: 22, trend: 'NEUTRAL' } } },
      { data: { A: { lrr: 10, hrr: 20, trend: 'NEUTRAL' } } },
    );

    expect(comparison.rows[0]).toMatchObject({ lrr: null, lrrDelta: null, hrrDelta: 2, boundsChanged: true });
    expect(comparison.counts.changed).toBe(1);
  });

  test('uses parsed article sections and takeaways when structured fields are absent', () => {
    const snapshot = {
      article: {
        bodyText: 'Key Takeaways\n• First point\n• Second point\n\nThe Big Picture\nThe macro frame is changing.\n\nMacro Grind\nWatch the dollar.',
      },
    };
    expect(articleTakeaways(snapshot)).toEqual(['First point', 'Second point']);
    expect(extractBodySections(snapshot.article.bodyText)).toHaveLength(3);
  });

  test('does not label an older or stale publication current', () => {
    const now = new Date('2026-08-06T14:00:00Z');
    expect(getSourceStatus({ date: '2026-08-06' }, { now })).toMatchObject({ label: 'Current', current: true });
    expect(getSourceStatus({ date: '2026-08-05' }, { now }).label).toBe('Older reference');
    expect(getSourceStatus({ date: '2026-08-06', _cache: { stale: true } }, { now }).label).toBe('Stale reference');
  });

  test('does not infer Signal Strength membership from a partial snapshot', () => {
    expect(getSignalChanges({ data: { stocks: [{ ticker: 'A' }] } })).toEqual({
      added: [],
      removed: [],
      stockCount: null,
      stocks: [{ ticker: 'A', daysOn: null, percentChangeSinceSignal: null }],
      membershipComplete: false,
    });
  });

  test('keeps only the requested fields for a validated Signal Strength table', () => {
    const changes = getSignalChanges({
      meta: { stockCount: 2 },
      data: {
        added: ['A'],
        removed: ['B'],
        stocks: [
          { ticker: 'A', daysOn: '4', percentChangeSinceSignal: '12.5', entryPrice: 10, recentPrice: 11, analyst: 'Someone' },
          { ticker: 'C', daysOn: 0, percentChange: -1.2, signalDate: '2026-08-01', rank: 'Bench' },
        ],
      },
    });

    expect(changes).toMatchObject({
      added: ['A'],
      removed: ['B'],
      stockCount: 2,
      membershipComplete: true,
    });
    expect(changes.stocks).toEqual([
      { ticker: 'A', daysOn: 4, percentChangeSinceSignal: 12.5 },
      { ticker: 'C', daysOn: 0, percentChangeSinceSignal: -1.2 },
    ]);
  });

  test('keeps a Signal Strength Shorts row\'s published Total Return, not a change since signal', () => {
    const changes = getSignalChanges({
      snapshotType: 'signal-strength-shorts',
      stockCount: 1,
      data: { added: [], removed: ['SKHY'], membershipComplete: true, stocks: [{ ticker: 'LVS', side: 'short', daysOn: 186, totalReturn: 29.26 }] },
    });
    expect(changes.removed).toEqual(['SKHY']);
    expect(changes.stocks).toEqual([{ ticker: 'LVS', daysOn: 186, percentChangeSinceSignal: null, totalReturn: 29.26 }]);
  });
});
