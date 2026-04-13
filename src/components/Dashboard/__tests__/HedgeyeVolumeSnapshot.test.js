const {
  buildHedgeyeVolumeSnapshotResponse,
  normalizeVolumeSnapshotData
} = require('../../../utils/hedgeyeVolumeSnapshot.cjs');
const { getMarketDayFreshness } = require('../../../utils/timeUtils');

describe('hedgeye volume snapshot response', () => {
  const snapshotItem = {
    date: '2026-03-20',
    snapshotType: 'volume',
    scrapedAt: '2026-03-20T13:45:00.000Z',
    source: 'textract',
    data: {
      slideDate: '2026-03-20',
      uploadDate: '2026-03-20',
      asOfLabel: '3/19',
      asOfTradingDate: '2026-03-19',
      methodologyVersion: 'hedgeye-volume-snapshot-v1',
      metrics: {
        totalMarket: {
          pctPriorDay: -1,
          pct1M: 9,
          pct3M: 11,
          pct1Y: 14
        },
        exchange: {
          pctPriorDay: 3,
          pct1M: 4,
          pct3M: 7,
          pct1Y: 11
        }
      },
      footnotes: [
        'Total Market Volume = Total US exchange volume plus OTC and OTCBB trading volume for all security types. Calculated by Bloomberg.',
        'Tape A+B+C volume = total US exchange volume.'
      ]
    }
  };

  it('normalizes the stored snapshot payload into the shared metric shape', () => {
    expect(normalizeVolumeSnapshotData(snapshotItem)).toEqual({
      slideDate: '2026-03-20',
      uploadDate: '2026-03-20',
      asOfLabel: '3/19',
      asOfTradingDate: '2026-03-19',
      metrics: {
        totalMarket: {
          priorDay: null,
          avg1M: null,
          avg3M: null,
          avg1Y: null,
          pctPriorDay: -1,
          pct1M: 9,
          pct3M: 11,
          pct1Y: 14
        },
        exchange: {
          priorDay: null,
          avg1M: null,
          avg3M: null,
          avg1Y: null,
          pctPriorDay: 3,
          pct1M: 4,
          pct3M: 7,
          pct1Y: 11
        }
      },
      footnotes: [
        'Total Market Volume = Total US exchange volume plus OTC and OTCBB trading volume for all security types. Calculated by Bloomberg.',
        'Tape A+B+C volume = total US exchange volume.'
      ]
    });
  });

  it('builds the direct card response without recomputing the slide values', () => {
    expect(buildHedgeyeVolumeSnapshotResponse(snapshotItem)).toEqual({
      asOf: '2026-03-19',
      totalMarket: [],
      totalExchange: [],
      metrics: {
        totalMarket: {
          priorDay: null,
          avg1M: null,
          avg3M: null,
          avg1Y: null,
          pctPriorDay: -1,
          pct1M: 9,
          pct3M: 11,
          pct1Y: 14
        },
        exchange: {
          priorDay: null,
          avg1M: null,
          avg3M: null,
          avg1Y: null,
          pctPriorDay: 3,
          pct1M: 4,
          pct3M: 7,
          pct1Y: 11
        }
      },
      meta: {
        sourceType: 'hedgeye-volume-snapshot',
        methodologyVersion: 'hedgeye-volume-snapshot-v1',
        sourceBreakdown: [
          {
            id: 'hedgeyeVolumeSnapshot',
            label: 'Hedgeye Volume Snapshot',
            description: 'Direct AWS Textract extraction from the uploaded Hedgeye volume slide PDF.',
            provider: 'Hedgeye',
            dataset: 'The Macro Show'
          }
        ],
        asOfTradingDate: '2026-03-19',
        uploadDate: '2026-03-20',
        slideDate: '2026-03-20',
        fetchedAt: '2026-03-20T13:45:00.000Z',
        status: 'current',
        footnotes: [
          'Total Market Volume = Total US exchange volume plus OTC and OTCBB trading volume for all security types. Calculated by Bloomberg.',
          'Tape A+B+C volume = total US exchange volume.'
        ]
      }
    });
  });
});

describe('getMarketDayFreshness', () => {
  it('returns current when the upload is from the latest trading day', () => {
    expect(getMarketDayFreshness('2026-03-20', new Date('2026-03-20T12:00:00'))).toBe('current');
  });

  it('returns stale when the upload is one or two market days behind', () => {
    expect(getMarketDayFreshness('2026-03-19', new Date('2026-03-20T12:00:00'))).toBe('stale');
    expect(getMarketDayFreshness('2026-03-18', new Date('2026-03-20T12:00:00'))).toBe('stale');
  });

  it('returns defective when the upload is more than two market days behind', () => {
    expect(getMarketDayFreshness('2026-03-17', new Date('2026-03-20T12:00:00'))).toBe('defective');
  });
});
