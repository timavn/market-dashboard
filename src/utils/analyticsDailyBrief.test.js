const {
  SOURCE_DEFINITIONS,
  buildAnalyticsDailyBrief,
  extractTicker,
  isMarketDay,
  latestExpectedRiskRangeDate,
} = require('./analyticsDailyBrief.cjs');

const currentDiff = (overrides = {}) => ({
  available: true,
  currentDate: '2026-07-16',
  previousDate: '2026-07-15',
  comparisonStatus: 'changed',
  ...overrides,
});

describe('analytics daily brief', () => {
  test('tracks normalized market-structure snapshots as a research source', () => {
    expect(SOURCE_DEFINITIONS).toContainEqual({
      id: 'market-structure',
      label: 'Market Structure',
      cadence: 'event_driven',
    });
  });

  test('keeps semantic current events and rejects parser artifacts', () => {
    const brief = buildAnalyticsDailyBrief({
      now: new Date('2026-07-16T17:00:00Z'),
      changelog: {
        'real-time-alert': currentDiff({
          alerts: [
            { ticker: 'FXC', signalPhrase: 'SELL SIGNAL - SHORTING FXC' },
            { ticker: 'SHORT', signalPhrase: 'BUY SIGNAL - COVERING SHORT' },
          ],
        }),
        'risk-ranges': currentDiff({
          trendChanges: [{ ticker: 'NIKK', oldTrend: 'BULLISH', newTrend: 'NEUTRAL' }],
        }),
        'portfolio-solutions': currentDiff({
          added: ['EWZ'],
          removed: [],
          updates: [{ ticker: 'SPY', field: 'rank', oldValue: 9, newValue: 4 }],
        }),
        'etf-pro': currentDiff({
          addedLongs: ['XLV'],
          addedShorts: [],
          removedLongs: [],
          removedShorts: [],
        }),
      },
    });

    expect(brief.events.map((event) => event.ticker)).toEqual(
      expect.arrayContaining(['FXC', 'NIKK', 'EWZ', 'SPY', 'XLV']),
    );
    expect(brief.events.map((event) => event.ticker)).not.toContain('SHORT');
    expect(brief.events.find((event) => event.ticker === 'FXC').direction).toBe('bearish');
  });

  test('suppresses actionable events when only stale cache is available', () => {
    const brief = buildAnalyticsDailyBrief({
      now: new Date('2026-07-16T17:00:00Z'),
      cacheState: 'stale',
      changelog: {
        'real-time-alert': currentDiff({
          alerts: [{ ticker: 'FXC', signalPhrase: 'SELL SIGNAL FXC' }],
        }),
      },
    });

    expect(brief.events).toEqual([]);
    expect(brief.trust.status).toBe('unavailable');
    expect(brief.issues[0].sourceId).toBe('analytics-cache');
  });

  test('excludes ETF events when the source carries a quality warning', () => {
    const brief = buildAnalyticsDailyBrief({
      now: new Date('2026-07-16T17:00:00Z'),
      changelog: {
        'etf-pro': currentDiff({
          addedLongs: ['XLV'],
          dataQuality: { status: 'partial', warnings: ['Base book is manually calibrated.'] },
        }),
      },
    });

    expect(brief.events.some((event) => event.sourceId === 'etf-pro')).toBe(false);
    expect(brief.issues.find((issue) => issue.sourceId === 'etf-pro').status).toBe('quality_warning');
  });

  test('uses market-day cutoff and US market holidays for Risk Ranges', () => {
    expect(latestExpectedRiskRangeDate(new Date('2026-07-16T11:00:00Z'))).toBe('2026-07-15');
    expect(latestExpectedRiskRangeDate(new Date('2026-07-16T17:00:00Z'))).toBe('2026-07-16');
    expect(isMarketDay(new Date('2026-07-03T12:00:00Z'))).toBe(false);
    expect(latestExpectedRiskRangeDate(new Date('2026-07-04T17:00:00Z'))).toBe('2026-07-02');
  });

  test('does not accept reserved words, filenames, or malformed symbols as tickers', () => {
    expect(extractTicker('SHORT')).toBe('');
    expect(extractTicker('relative_performance1.png')).toBe('');
    expect(extractTicker('Consumer Discretionary (XLY)')).toBe('XLY');
    expect(extractTicker('BRK.B')).toBe('BRK.B');
  });
});
