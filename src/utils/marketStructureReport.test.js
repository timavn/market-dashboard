const {
  buildPublicMarketStructureSnapshot,
  resolveMarketStructureChartAsset,
  safeInlineFilename,
} = require('./marketStructureReport.cjs');

const SHA = 'a'.repeat(64);
const SECOND_SHA = 'b'.repeat(64);
const KEY = `hedgeye-email/assets/market-structure/${SHA}.png`;

function snapshot(overrides = {}) {
  return {
    date: '2026-08-10',
    snapshotType: 'market-structure',
    schemaVersion: 'market-structure-v2',
    contentComplete: true,
    htmlSource: 'hedgeye-email/messages/private-message.html',
    article: {
      headline: 'Market Situation Report for subscriber@example.com',
      reportHeading: 'WEEKLY GAME PLAN',
      bodyText: [
        'Having trouble viewing this email?\nView it in your browser',
        '08/10/2026 06:30 AM EDT',
        'The research note below was written by Tier 1 Alpha and Presented by Hedgeye.',
        'Complete market research for subscriber@example.com',
        'To access the full report, please Click Here!',
        'By Craig Peterson',
      ].join('\n\n'),
      byline: 'By Craig Peterson',
      disclaimer: 'Legal Disclaimer: subscriber-only research.',
      publisher: 'Hedgeye',
      feedUrl: 'https://app.hedgeye.com/feed_items/12345?email=subscriber@example.com',
      imageUrls: ['https://example.com/private.png'],
    },
    data: {
      signals: [],
      signalMatrixChartId: SHA,
      blocks: [
        { id: 'browser', type: 'paragraph', text: 'Having trouble viewing this email? View it in your browser' },
        { id: 'timestamp', type: 'paragraph', text: '08/10/2026 06:30 AM EDT' },
        { id: 'subject', type: 'heading', text: 'MARKET SITUATION REPORT: August 10th, 2026' },
        { id: 'attribution', type: 'paragraph', text: 'The research note below was written by Tier 1 Alpha and Presented by Hedgeye.' },
        { id: 'copy', type: 'paragraph', text: 'Narrative subscriber@example.com' },
        { id: 'figure', type: 'chart', chartId: SHA },
        { id: 'link', type: 'paragraph', text: 'To access the full report, please Click Here!' },
        { id: 'byline', type: 'byline', text: 'By Craig Peterson' },
      ],
      charts: [{
        id: SHA,
        name: 'signals.png',
        sha256: SHA,
        contentType: 'image/png',
        s3Key: KEY,
        sourceUrl: 'https://d1yhils6iwh5l5.cloudfront.net/signals.png?email=subscriber@example.com',
      }],
    },
    ...overrides,
  };
}

describe('Market Structure private report contract', () => {
  test('publishes a market-only response without raw keys, subscriber tracking, or email boilerplate', () => {
    const response = buildPublicMarketStructureSnapshot(snapshot());
    const serialized = JSON.stringify(response);

    expect(response.data.charts).toEqual([expect.objectContaining({
      id: SHA,
      contentUrl: `/api/hedgeye/market-structure/2026-08-10/charts/${SHA}`,
    })]);
    expect(response.data.signalMatrixImageUrl).toBe(
      `/api/hedgeye/market-structure/2026-08-10/charts/${SHA}`,
    );
    expect(response.article.reportHeading).toBe('WEEKLY GAME PLAN');
    expect(response.article.bodyText).toBe('Complete market research for');
    expect(response.data.blocks).toEqual([
      { id: 'copy', type: 'paragraph', text: 'Narrative' },
      { id: 'figure', type: 'chart', chartId: SHA },
    ]);
    expect(serialized).not.toContain('s3Key');
    expect(serialized).not.toContain('htmlSource');
    expect(serialized).not.toContain('subscriber@example.com');
    expect(serialized).not.toContain('sourceUrl');
    expect(serialized).not.toContain('Having trouble viewing');
    expect(serialized).not.toContain('06:30 AM EDT');
    expect(serialized).not.toContain('Tier 1 Alpha');
    expect(serialized).not.toContain('Click Here');
    expect(serialized).not.toContain('Craig Peterson');
    expect(serialized).not.toContain('Legal Disclaimer');
    expect(serialized).not.toContain('sourceAttribution');
    expect(serialized).not.toContain('feedUrl');
  });

  test('resolves only complete snapshots with a checksum-bound allowlisted asset key', () => {
    expect(resolveMarketStructureChartAsset(snapshot(), '2026-08-10', SHA)).toEqual({
      id: SHA,
      s3Key: KEY,
      contentType: 'image/png',
      name: 'signals.png',
    });
    expect(resolveMarketStructureChartAsset(
      snapshot({ contentComplete: false }),
      '2026-08-10',
      SHA,
    )).toBeNull();
    expect(resolveMarketStructureChartAsset(
      snapshot({
        data: {
          charts: [{
            id: SHA,
            sha256: SHA,
            contentType: 'image/png',
            s3Key: `hedgeye-email/messages/${SHA}.png`,
          }],
        },
      }),
      '2026-08-10',
      SHA,
    )).toBeNull();
  });

  test('publishes only checksum-bound v4 chart metrics with bounded numeric fields', () => {
    const base = snapshot();
    const response = buildPublicMarketStructureSnapshot(snapshot({
      schemaVersion: 'market-structure-v4',
      data: {
        ...base.data,
        charts: [
          ...base.data.charts,
          {
            id: SECOND_SHA,
            name: 'gamma-map.png',
            sha256: SECOND_SHA,
            contentType: 'image/png',
            s3Key: `hedgeye-email/assets/market-structure/${SECOND_SHA}.png`,
          },
        ],
        chartMetrics: {
          spxGammaVolatilityThrottle: {
            gammaThrottle: 0.56,
            tenDayRealizedVolatility: 9.37,
            chartDate: '2026-08-07',
            chartId: SHA,
            extractionBasis: 'labeled-chart-ocr',
            parserVersion: 'market-structure-chart-metrics-v2',
            source: 'Tier1Alpha.com',
          },
          spxProbableVolatilityGamma: {
            zeroGamma: 7646,
            upperPvBand: 7798,
            lowerPvBand: 7573,
            strikesInPlay: [7600, 7650, 7675, 7700, 7750],
            chartDate: '2026-08-07',
            chartId: SECOND_SHA,
            extractionBasis: 'labeled-chart-ocr',
            parserVersion: 'market-structure-chart-metrics-v2',
            source: 'Tier1Alpha.com',
          },
        },
      },
    }));

    expect(response.data.chartMetrics).toEqual({
      spxGammaVolatilityThrottle: expect.objectContaining({
        gammaThrottle: 0.56,
        tenDayRealizedVolatility: 9.37,
        chartId: SHA,
        chartDate: '2026-08-07',
      }),
      spxProbableVolatilityGamma: expect.objectContaining({
        zeroGamma: 7646,
        upperPvBand: 7798,
        lowerPvBand: 7573,
        strikesInPlay: [7600, 7650, 7675, 7700, 7750],
        chartId: SECOND_SHA,
        chartDate: '2026-08-07',
      }),
    });
  });

  test('does not expose unbound or legacy Market Situation chart metrics', () => {
    const base = snapshot();
    const legacy = buildPublicMarketStructureSnapshot(snapshot({
      data: {
        ...base.data,
        chartMetrics: {
          spxGammaVolatilityThrottle: {
            gammaThrottle: 0.56,
            tenDayRealizedVolatility: 9.37,
            chartDate: '2026-08-07',
            chartId: SHA,
            extractionBasis: 'labeled-chart-ocr',
            parserVersion: 'market-structure-chart-metrics-v2',
          },
        },
      },
    }));
    expect(legacy.data.chartMetrics).toEqual({});
  });

  test('rejects invalid route identifiers and makes safe inline filenames', () => {
    expect(() => resolveMarketStructureChartAsset(snapshot(), '08-10-2026', SHA))
      .toThrow('YYYY-MM-DD');
    expect(() => resolveMarketStructureChartAsset(snapshot(), '2026-08-10', '../secret'))
      .toThrow('chart ID is invalid');
    expect(safeInlineFilename('chart\r\nX-Bad: value', 'image/png'))
      .toBe('chart-X-Bad-value.png');
  });
});
