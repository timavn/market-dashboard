import { buildHedgeyeLatestUpdatesFeed } from './hedgeyeLatestUpdatesFeed';

describe('buildHedgeyeLatestUpdatesFeed', () => {
  test('normalizes real-time alert buy/sell style actions', () => {
    const feed = buildHedgeyeLatestUpdatesFeed({
      'real-time-alert': {
        currentDate: '2026-06-18',
        alerts: [
          { ticker: 'ATZAF', action: 'BUY', signalPhrase: 'ATZAF added to Long' },
          { ticker: 'BALL', action: 'SELL', signalPhrase: 'BALL removed from Short' },
        ],
      },
    });

    expect(feed).toEqual(expect.arrayContaining([
      expect.objectContaining({
        ticker: 'ATZAF',
        actionLabel: 'ADDED TO LONG',
        source: 'Real Time Alerts',
        tone: 'positive',
      }),
      expect.objectContaining({
        ticker: 'BALL',
        actionLabel: 'SHORT -> CLOSED',
        source: 'Real Time Alerts',
        tone: 'negative',
      }),
    ]));
  });

  test('normalizes ETF Pro long and short add/remove buckets', () => {
    const feed = buildHedgeyeLatestUpdatesFeed({
      'etf-pro': {
        currentDate: '2026-06-18',
        addedLongs: ['IAK'],
        removedLongs: ['PINK'],
        addedShorts: ['SHRT'],
        removedShorts: ['INDA'],
      },
    });

    expect(feed).toEqual(expect.arrayContaining([
      expect.objectContaining({ ticker: 'IAK', actionLabel: 'ADDED TO BULLISH', tone: 'positive' }),
      expect.objectContaining({ ticker: 'PINK', actionLabel: 'BULLISH -> CLOSED', tone: 'negative' }),
      expect.objectContaining({ ticker: 'SHRT', actionLabel: 'ADDED TO BEARISH', tone: 'negative' }),
      expect.objectContaining({ ticker: 'INDA', actionLabel: 'BEARISH -> CLOSED', tone: 'negative' }),
    ]));
  });

  test('normalizes Portfolio Solutions adds and removes', () => {
    const feed = buildHedgeyeLatestUpdatesFeed({
      'portfolio-solutions': {
        currentDate: '2026-06-18',
        added: ['IAK'],
        removed: ['OLD'],
      },
    });

    expect(feed).toEqual(expect.arrayContaining([
      expect.objectContaining({
        ticker: 'IAK',
        actionLabel: 'ADDED TO LONG',
        description: 'IAK added to Portfolio Solutions',
      }),
      expect.objectContaining({
        ticker: 'OLD',
        actionLabel: 'REMOVED',
        description: 'OLD removed from Portfolio Solutions',
      }),
    ]));
  });

  test('includes Risk Ranges trend changes and membership changes', () => {
    const feed = buildHedgeyeLatestUpdatesFeed({
      'risk-ranges': {
        currentDate: '2026-06-18',
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
    });

    expect(feed).toEqual(expect.arrayContaining([
      expect.objectContaining({
        ticker: 'SPY',
        actionLabel: 'BULLISH -> NEUTRAL',
        tone: 'neutral',
      }),
      expect.objectContaining({ ticker: 'NEW', actionLabel: 'ADDED TO RISK RANGES' }),
      expect.objectContaining({ ticker: 'OLD', actionLabel: 'REMOVED FROM RISK RANGES' }),
      expect.objectContaining({ ticker: 'XLE', actionLabel: 'ADDED TO RISK RANGES' }),
      expect.objectContaining({ ticker: 'OUT', actionLabel: 'REMOVED FROM RISK RANGES' }),
    ]));
  });

  test('returns an empty list for empty or malformed changelog payloads', () => {
    expect(buildHedgeyeLatestUpdatesFeed(null)).toEqual([]);
    expect(buildHedgeyeLatestUpdatesFeed([])).toEqual([]);
    expect(buildHedgeyeLatestUpdatesFeed({ nope: true })).toEqual([]);
  });
});
