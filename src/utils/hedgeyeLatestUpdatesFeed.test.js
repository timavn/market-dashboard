import {
  buildHedgeyeLatestUpdatesFeed,
  buildHedgeyeLatestUpdatesStatus,
  formatHedgeyeFeedTime,
} from './hedgeyeLatestUpdatesFeed';

describe('buildHedgeyeLatestUpdatesFeed', () => {
  test('normalizes real-time alert actions with Hedgeye display labels', () => {
    const feed = buildHedgeyeLatestUpdatesFeed({
      'real-time-alert': {
        currentDate: '2026-06-18',
        eventTime: '2026-06-18T13:00:00Z',
        alerts: [
          { ticker: 'ATZAF', action: 'BUY', signalPhrase: 'ATZAF added to Long' },
          { ticker: 'BALL', action: 'SELL', signalPhrase: 'BALL removed from Short' },
          { ticker: 'CP', action: 'BUY', signalPhrase: 'CP doubled in Long' },
          { ticker: 'URI', action: 'SELL', signalPhrase: 'SELL SIGNAL URI' },
        ],
      },
    }, {
      now: '2026-06-18T14:00:00Z',
    });

    expect(feed).toEqual(expect.arrayContaining([
      expect.objectContaining({
        ticker: 'ATZAF',
        displayAction: 'Added to Long',
        description: 'ATZAF added to Long',
        source: 'Real Time Alerts',
        tone: 'positive',
      }),
      expect.objectContaining({
        ticker: 'BALL',
        displayAction: 'Short -> Closed',
        description: 'BALL removed from Short',
        tone: 'negative',
      }),
      expect.objectContaining({
        ticker: 'CP',
        displayAction: 'Doubling Long',
        description: 'CP doubled in Long',
      }),
      expect.objectContaining({
        ticker: 'URI',
        displayAction: 'Long -> Closed',
        description: 'URI removed from Long',
      }),
    ]));
  });

  test('normalizes ETF Pro long and short add/remove buckets', () => {
    const feed = buildHedgeyeLatestUpdatesFeed({
      'etf-pro': {
        currentDate: '2026-06-18',
        eventTime: '2026-06-18T12:00:00Z',
        addedLongs: ['IAK'],
        removedLongs: ['PINK'],
        addedShorts: ['SHRT'],
        removedShorts: ['INDA'],
      },
    }, {
      now: '2026-06-18T14:00:00Z',
    });

    expect(feed).toEqual(expect.arrayContaining([
      expect.objectContaining({ ticker: 'IAK', displayAction: 'Added to Bullish', tone: 'positive' }),
      expect.objectContaining({ ticker: 'PINK', displayAction: 'Bullish -> Closed', tone: 'negative' }),
      expect.objectContaining({ ticker: 'SHRT', displayAction: 'Added to Bearish', tone: 'negative' }),
      expect.objectContaining({ ticker: 'INDA', displayAction: 'Bearish -> Closed', tone: 'negative' }),
    ]));
  });

  test('normalizes Portfolio Solutions adds and removes', () => {
    const feed = buildHedgeyeLatestUpdatesFeed({
      'portfolio-solutions': {
        currentDate: '2026-06-18',
        eventTime: '2026-06-18T13:00:00Z',
        added: ['IAK'],
        removed: ['OLD'],
      },
    }, {
      now: '2026-06-18T14:00:00Z',
    });

    expect(feed).toEqual(expect.arrayContaining([
      expect.objectContaining({
        ticker: 'IAK',
        displayAction: 'Added to Long',
        description: 'IAK added to Portfolio Solutions',
      }),
      expect.objectContaining({
        ticker: 'OLD',
        displayAction: 'Removed',
        description: 'OLD removed from Portfolio Solutions',
      }),
    ]));
  });

  test('includes Risk Ranges trend fields and membership changes', () => {
    const feed = buildHedgeyeLatestUpdatesFeed({
      'risk-ranges': {
        currentDate: '2026-06-18',
        eventTime: '2026-06-18T08:00:00Z',
        trendChanges: [
          { ticker: 'SPY', oldTrend: 'BULLISH', newTrend: 'NEUTRAL' },
        ],
        added: ['New Fund (NEW) - BULLISH'],
        removed: ['OLD'],
        outbucketDiff: {
          added: [{ ticker: 'XLE', name: 'Energy', trend: 'BULLISH' }],
          removed: ['Out Fund (OUT) - BEARISH'],
        },
      },
    }, {
      now: '2026-06-18T14:00:00Z',
    });

    expect(feed).toEqual(expect.arrayContaining([
      expect.objectContaining({
        ticker: 'SPY',
        trendFrom: 'bullish',
        trendTo: 'neutral',
        description: 'SPY trend changed from Bullish to Neutral',
        tone: 'neutral',
      }),
      expect.objectContaining({ ticker: 'NEW', displayAction: 'Added to Risk Ranges' }),
      expect.objectContaining({ ticker: 'OLD', displayAction: 'Removed from Risk Ranges' }),
      expect.objectContaining({ ticker: 'XLE', displayAction: 'Added to Risk Ranges' }),
      expect.objectContaining({ ticker: 'OUT', displayAction: 'Removed from Risk Ranges' }),
    ]));
  });

  test('uses eventTime before scrapedAt and formats relative times', () => {
    const feed = buildHedgeyeLatestUpdatesFeed({
      'portfolio-solutions': {
        currentDate: '2026-06-18',
        scrapedAt: '2026-06-18T10:00:00Z',
        eventTime: '2026-06-18T11:00:00Z',
        added: ['IAK'],
      },
    }, {
      now: '2026-06-18T12:05:00Z',
    });

    expect(feed[0].eventTime).toBe('2026-06-18T11:00:00Z');
    expect(formatHedgeyeFeedTime(feed[0], new Date('2026-06-18T12:05:00Z').getTime())).toBe('about 1 hour ago');
  });

  test('filters previous-day updates after the Eastern daily reset', () => {
    const feed = buildHedgeyeLatestUpdatesFeed({
      'real-time-alert': {
        currentDate: '2026-06-17',
        eventTime: '2026-06-17T23:00:00Z',
        alerts: [{ ticker: 'OLD', action: 'BUY', signalPhrase: 'OLD added to Long' }],
      },
      'portfolio-solutions': {
        currentDate: '2026-06-18',
        eventTime: '2026-06-18T05:00:00Z',
        added: ['IAK'],
      },
    }, {
      now: '2026-06-18T06:00:00Z',
    });

    expect(feed).toHaveLength(1);
    expect(feed[0]).toMatchObject({
      ticker: 'IAK',
      source: 'Portfolio Solutions',
    });
  });

  test('builds green status when polling is recent and current-day updates exist', () => {
    const status = buildHedgeyeLatestUpdatesStatus({
      'real-time-alert': {
        available: true,
        eventTime: '2026-06-18T13:00:00Z',
        alerts: [{ ticker: 'ATZAF' }],
      },
      'risk-ranges': {
        available: true,
        eventTime: '2026-06-18T08:00:00Z',
        trendChanges: [{ ticker: 'NVDA' }],
      },
    }, {
      now: '2026-06-18T13:00:20Z',
      lastSuccessAt: '2026-06-18T13:00:00Z',
    });

    expect(status.status).toBe('active');
    expect(status.emoji).toBe('🟢');
    expect(status.sources).toHaveLength(4);
    expect(status.sources[0]).toMatchObject({
      label: 'Real Time Alerts',
      detail: '1 update',
      status: 'current',
    });
  });

  test('builds yellow status when the 30-second poll is stale', () => {
    const status = buildHedgeyeLatestUpdatesStatus({
      'real-time-alert': {
        available: true,
        currentDate: '2026-06-18',
        eventTime: '2026-06-18T13:00:00Z',
        alerts: [{ ticker: 'ATZAF', action: 'BUY' }],
      },
    }, {
      now: '2026-06-18T13:02:00Z',
      lastSuccessAt: '2026-06-18T13:00:00Z',
    });

    expect(status.status).toBe('stale');
    expect(status.emoji).toBe('🟡');
    expect(status.sources[0].status).toBe('stale');
  });

  test('builds red status after daily reset with no current-day updates', () => {
    const status = buildHedgeyeLatestUpdatesStatus({
      'real-time-alert': {
        available: true,
        currentDate: '2026-06-17',
        eventTime: '2026-06-17T13:00:00Z',
        alerts: [{ ticker: 'OLD', action: 'BUY' }],
      },
    }, {
      now: '2026-06-18T05:01:00Z',
      lastSuccessAt: '2026-06-18T05:01:00Z',
    });

    expect(status.status).toBe('inactive');
    expect(status.emoji).toBe('🔴');
    expect(status.sources[0]).toMatchObject({
      detail: 'No updates today; latest Jun 17',
      status: 'current',
    });
  });

  test('builds red status on fetch failure or before the first successful poll', () => {
    expect(buildHedgeyeLatestUpdatesStatus(null, {
      now: '2026-06-18T13:00:00Z',
      error: 'Failed',
    })).toMatchObject({
      status: 'inactive',
      emoji: '🔴',
    });

    expect(buildHedgeyeLatestUpdatesStatus({
      'real-time-alert': {
        currentDate: '2026-06-18',
        eventTime: '2026-06-18T13:00:00Z',
        alerts: [{ ticker: 'ATZAF', action: 'BUY' }],
      },
    }, {
      now: '2026-06-18T13:00:00Z',
    })).toMatchObject({
      status: 'inactive',
      emoji: '🔴',
    });
  });

  test('returns an empty list for empty or malformed changelog payloads', () => {
    expect(buildHedgeyeLatestUpdatesFeed(null)).toEqual([]);
    expect(buildHedgeyeLatestUpdatesFeed([])).toEqual([]);
    expect(buildHedgeyeLatestUpdatesFeed({ nope: true })).toEqual([]);
  });
});
