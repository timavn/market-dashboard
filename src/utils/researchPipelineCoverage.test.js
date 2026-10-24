const {
  PIPELINE_STATUS,
  buildResearchPipelineCoverage,
  collectResearchPipelineCoverage,
} = require('./researchPipelineCoverage.cjs');
const {
  getResearchProduct,
} = require('./researchProductRegistry.cjs');

const NOW = new Date('2026-07-21T17:00:00.000Z');
const MARKET_DATE = '2026-07-21';

function product(id) {
  return getResearchProduct(id);
}

function buildFor(id, overrides = {}) {
  return buildResearchPipelineCoverage({
    now: NOW,
    marketDate: MARKET_DATE,
    products: [product(id)],
    ...overrides,
  });
}

describe('research pipeline coverage', () => {
  test('indexed partial publication preserves source discrepancies across snapshots and manifest artifacts', () => {
    const issue = { id: 'original-rut-range', code: 'invalid_bounds', ticker: 'RUT', field: 'riskRange',
      observed: { lrr: 2834, hrr: 2825, trend: 'BULLISH' }, disposition: 'withheld_from_structured_data',
      source: { productId: 'early-look', reportDate: MARKET_DATE, url: 'https://app.hedgeye.com/feed_items/187503' } };
    const quality = { status: 'discrepancy', issues: [issue] };
    const base = {
      snapshotItems: [{ snapshotType: 'early-look', date: MARKET_DATE, data: { SPX: { lrr: 7000, hrr: 7100 } },
        sourceQuality: quality }],
      manifestItems: [{ productKey: 'early-look', marketDate: MARKET_DATE, state: 'indexed',
        receivedCount: 1, indexedCount: 1, entityEventCount: 0,
        sourceQuality: quality, artifacts: [{ sourceKey: 'raw/early-look.html', stage: 'indexed', sourceQuality: quality }] }],
    };
    const indexed = buildFor('early-look', base);
    expect(indexed.products[0]).toMatchObject({ status: PIPELINE_STATUS.INDEXED, counts: { failures: 0 }, sourceQuality: quality });
    expect(indexed.products[0].sourceQuality.issues).toHaveLength(1);
    // The manifest still retains the original publication warning after a clean
    // snapshot/replay: success alone is not evidence of publisher correction.
    base.snapshotItems[0].sourceQuality = { status: 'clear', issues: [] };
    base.manifestItems[0].sourceQuality = { status: 'clear', issues: [] };
    const replayed = buildFor('early-look', base);
    expect(replayed.products[0].sourceQuality).toEqual(quality);
    expect(replayed.products[0].status).toBe(PIPELINE_STATUS.INDEXED);
  });
  test('shows event-driven products as not due until an artifact is received', () => {
    const result = buildFor('the-call');

    expect(result).toMatchObject({
      status: 'complete',
      products: [{
        id: 'the-call',
        due: false,
        status: PIPELINE_STATUS.NOT_DUE,
        statusLabel: 'Not due',
      }],
    });
  });

  test('uses the latest market session for weekend SYS coverage', () => {
    const result = buildResearchPipelineCoverage({
      now: new Date('2026-07-26T18:00:00.000Z'),
      products: [product('the-call')],
    });

    expect(result.marketDate).toBe('2026-07-24');
    expect(result.products[0]).toMatchObject({
      marketDate: '2026-07-24',
      status: PIPELINE_STATUS.NOT_DUE,
    });
  });

  test('marks a scheduled market-day product missing after its deadline', () => {
    const result = buildFor('risk-ranges');

    expect(result).toMatchObject({
      status: 'failed',
      summary: { missing: 1, incompleteDue: 1 },
      products: [{
        id: 'risk-ranges',
        due: true,
        status: PIPELINE_STATUS.MISSING,
        errorCode: 'RESEARCH_PRODUCT_DUE_MISSING',
      }],
    });
  });

  test('only marks risk ranges indexed when the current primary manifest gate is verified', () => {
    const unverified = buildFor('risk-ranges', {
      riskRange: {
        status: 'success',
        available: false,
        lastRun: MARKET_DATE,
        diagnostics: { manifestReasons: ['manifest-missing'] },
      },
    });
    expect(unverified.products[0].status).toBe(PIPELINE_STATUS.MISSING);

    const verified = buildFor('risk-ranges', {
      riskRange: {
        status: 'success',
        available: true,
        lastRun: MARKET_DATE,
        scrapedAt: '2026-07-21T12:00:00.000Z',
        diagnostics: { manifestReasons: [] },
      },
    });
    expect(verified.products[0]).toMatchObject({
      status: PIPELINE_STATUS.INDEXED,
      stages: { received: true, parsed: true, validated: true, indexed: true },
    });
  });

  test('does not let a generic indexed PDF candidate satisfy the primary Risk Range gate', () => {
    const result = buildFor('risk-ranges', {
      riskRange: {
        status: 'success',
        available: false,
        lastRun: MARKET_DATE,
        diagnostics: { manifestReasons: ['manifest-missing'] },
      },
      eventItems: [{
        productKey: 'risk-ranges',
        marketDate: MARKET_DATE,
        entityKey: 'ticker#SPY',
      }],
      manifestItems: [{
        marketDate: MARKET_DATE,
        productKey: 'risk-ranges',
        state: 'indexed',
        receivedCount: 1,
        parsedCount: 1,
        validatedCount: 1,
        indexedCount: 1,
        failedCount: 0,
        entityEventCount: 1,
      }],
    });

    expect(result.products[0]).toMatchObject({
      status: PIPELINE_STATUS.VALIDATED,
      stages: { received: true, parsed: true, validated: true, indexed: false },
    });
  });

  test.each([
    {
      label: 'received',
      override: {
        ledgerItems: [{
          messageId: 'm-1',
          attachmentId: 'a-1',
          reportType: 'the-call',
          status: 'STORED',
          receivedAt: '2026-07-21T12:00:00.000Z',
          s3Key: 'raw/the-call.html',
        }],
      },
      expected: PIPELINE_STATUS.RECEIVED,
    },
    {
      label: 'parsed',
      override: {
        ledgerItems: [{
          messageId: 'm-1',
          attachmentId: 'a-1',
          reportType: 'the-call',
          status: 'STORED',
          receivedAt: '2026-07-21T12:00:00.000Z',
          s3Key: 'raw/the-call.html',
        }],
        snapshotItems: [{
          snapshotType: 'the-call',
          date: MARKET_DATE,
          scrapedAt: '2026-07-21T12:01:00.000Z',
          data: {},
        }],
      },
      expected: PIPELINE_STATUS.PARSED,
    },
    {
      label: 'validated',
      override: {
        ledgerItems: [{
          messageId: 'm-1',
          attachmentId: 'a-1',
          reportType: 'the-call',
          status: 'STORED',
          receivedAt: '2026-07-21T12:00:00.000Z',
          s3Key: 'raw/the-call.html',
        }],
        snapshotItems: [{
          snapshotType: 'the-call',
          date: MARKET_DATE,
          scrapedAt: '2026-07-21T12:01:00.000Z',
          data: { longs: ['XLV'] },
          dataQuality: { status: 'ok' },
        }],
      },
      expected: PIPELINE_STATUS.VALIDATED,
    },
    {
      label: 'indexed',
      override: {
        ledgerItems: [{
          messageId: 'm-1',
          attachmentId: 'a-1',
          reportType: 'the-call',
          status: 'STORED',
          receivedAt: '2026-07-21T12:00:00.000Z',
          s3Key: 'raw/the-call.html',
        }],
        snapshotItems: [{
          snapshotType: 'the-call',
          date: MARKET_DATE,
          scrapedAt: '2026-07-21T12:01:00.000Z',
          data: { longs: ['XLV'] },
          dataQuality: { status: 'ok' },
        }],
        eventItems: [{
          productKey: 'the-call',
          marketDate: MARKET_DATE,
          eventTime: '2026-07-21T12:02:00.000Z',
          entityKey: 'ticker#XLV',
        }],
        manifestItems: [{
          marketDate: MARKET_DATE,
          productKey: 'the-call',
          state: 'indexed',
          receivedCount: 1,
          parsedCount: 1,
          validatedCount: 1,
          indexedCount: 1,
          failedCount: 0,
          entityEventCount: 1,
        }],
      },
      expected: PIPELINE_STATUS.INDEXED,
    },
  ])('reports the highest verified $label stage without inventing later stages', ({ override, expected }) => {
    const result = buildFor('the-call', override);

    expect(result.products[0].status).toBe(expected);
    expect(result.status).toBe(expected === PIPELINE_STATUS.INDEXED ? 'complete' : 'degraded');
  });

  test('a failed same-day artifact dominates a successful indexed publication', () => {
    const result = buildFor('the-call', {
      ledgerItems: [
        {
          messageId: 'm-good',
          attachmentId: 'a-good',
          reportType: 'the-call',
          status: 'STORED',
          receivedAt: '2026-07-21T12:00:00.000Z',
          s3Key: 'raw/good.html',
        },
        {
          messageId: 'm-bad',
          attachmentId: 'a-bad',
          reportType: 'the-call',
          status: 'ERROR',
          receivedAt: '2026-07-21T12:05:00.000Z',
          parseError: 'No usable entities',
        },
      ],
      eventItems: [{
        productKey: 'the-call',
        marketDate: MARKET_DATE,
        eventTime: '2026-07-21T12:02:00.000Z',
      }],
    });

    expect(result.products[0]).toMatchObject({
      status: PIPELINE_STATUS.FAILED,
      detail: 'No usable entities',
      counts: { failures: 1 },
    });
  });

  test('uses the canonical manifest state and fails when any manifest artifact failed', () => {
    const indexed = buildFor('signal-strength', {
      manifestItems: [{
        marketDate: MARKET_DATE,
        productKey: 'signal-strength',
        state: 'indexed',
        receivedCount: 1,
        parsedCount: 1,
        validatedCount: 1,
        indexedCount: 1,
        failedCount: 0,
        entityEventCount: 0,
        updatedAt: '2026-07-21T12:03:00.000Z',
      }],
    });
    expect(indexed.products[0]).toMatchObject({
      status: PIPELINE_STATUS.INDEXED,
      stages: { received: true, parsed: true, validated: true, indexed: true },
    });

    const failed = buildFor('signal-strength', {
      manifestItems: [{
        marketDate: MARKET_DATE,
        productKey: 'signal-strength',
        state: 'failed',
        receivedCount: 2,
        failedCount: 1,
        artifacts: [{ artifactId: 'a-2', stage: 'failed', error: 'empty parse' }],
        updatedAt: '2026-07-21T12:04:00.000Z',
      }],
    });
    expect(failed.products[0]).toMatchObject({
      status: PIPELINE_STATUS.FAILED,
      counts: { failures: 1 },
    });
  });

  test('fails an indexed manifest that omits a received artifact', () => {
    const result = buildFor('the-call', {
      ledgerItems: [
        {
          messageId: 'm-1',
          attachmentId: 'a-1',
          reportType: 'the-call',
          status: 'STORED',
          receivedAt: '2026-07-21T12:00:00.000Z',
          contentSha256: 'sha-one',
        },
        {
          messageId: 'm-2',
          attachmentId: 'a-2',
          reportType: 'the-call',
          status: 'STORED',
          receivedAt: '2026-07-21T12:01:00.000Z',
          contentSha256: 'sha-two',
        },
      ],
      manifestItems: [{
        marketDate: MARKET_DATE,
        productKey: 'the-call',
        state: 'indexed',
        receivedCount: 1,
        parsedCount: 1,
        validatedCount: 1,
        indexedCount: 1,
        failedCount: 0,
        entityEventCount: 0,
      }],
    });

    expect(result.products[0]).toMatchObject({
      status: PIPELINE_STATUS.FAILED,
      errorCode: 'RESEARCH_PRODUCT_ARTIFACT_COUNT_MISMATCH',
      stages: { received: true, parsed: true, validated: true, indexed: false },
      counts: { artifacts: 2, manifests: 1, failures: 1 },
    });
  });

  test('surfaces an unregistered received product as unsupported and failed', () => {
    const result = buildResearchPipelineCoverage({
      now: NOW,
      marketDate: MARKET_DATE,
      products: [product('the-call')],
      ledgerItems: [{
        messageId: 'm-new',
        attachmentId: 'a-new',
        reportType: 'mystery-alpha-letter',
        status: 'STORED',
        receivedAt: '2026-07-21T12:00:00.000Z',
        s3Key: 'raw/mystery.html',
      }],
    });

    expect(result.status).toBe('failed');
    expect(result.products).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'unsupported:mystery-alpha-letter',
        status: PIPELINE_STATUS.FAILED,
        errorCode: 'RESEARCH_PRODUCT_UNSUPPORTED',
      }),
    ]));
  });

  test('an unsupported manifest emptied by recovery raises nothing, while a remaining artifact still does', () => {
    const manifest = (artifacts) => ({
      marketDate: MARKET_DATE, productKey: 'unknown', artifacts, reclassifiedArtifacts: [{ targetProductKey: 'go-anywhere' }],
    });
    const unsupported = (artifacts) => buildResearchPipelineCoverage({
      now: NOW, marketDate: MARKET_DATE, products: [product('the-call')], manifestItems: [manifest(artifacts)],
    }).products.filter(row => row.id.startsWith('unsupported:'));

    expect(unsupported([])).toEqual([]);
    expect(unsupported([{ artifactId: 'a'.repeat(64), stage: 'failed' }])).toEqual([
      expect.objectContaining({ id: 'unsupported:unknown', status: PIPELINE_STATUS.FAILED }),
    ]);
  });

  test('fails closed when any evidence source cannot be read', () => {
    const result = buildFor('the-call', {
      collectionErrors: ['ResearchEntityEventsV1 (AccessDeniedException): denied'],
      eventItems: [{
        productKey: 'the-call',
        marketDate: MARKET_DATE,
      }],
    });

    expect(result.products[0]).toMatchObject({
      status: PIPELINE_STATUS.FAILED,
      errorCode: 'RESEARCH_PIPELINE_EVIDENCE_UNAVAILABLE',
    });
    expect(result.products[0].detail).toMatch(/AccessDeniedException/);
  });

  test('queries date-keyed snapshots, manifests, and events without scanning the Gmail ledger', async () => {
    const calls = [];
    const dynamodb = {
      query: jest.fn((params) => ({
        promise: async () => {
          calls.push(params);
          if (params.TableName === 'Events') {
            return {
              Items: [{
                productKey: 'the-call',
                marketDate: MARKET_DATE,
                eventTime: '2026-07-21T12:02:00.000Z',
              }],
            };
          }
          if (params.TableName === 'Manifests') {
            return {
              Items: [{
                marketDate: MARKET_DATE,
                productKey: 'the-call',
                state: 'indexed',
                receivedCount: 1,
                parsedCount: 1,
                validatedCount: 1,
                indexedCount: 1,
                entityEventCount: 1,
              }],
            };
          }
          return { Items: [] };
        },
      })),
    };

    const result = await collectResearchPipelineCoverage({
      dynamodb,
      now: NOW,
      marketDate: MARKET_DATE,
      tables: {
        ledger: 'Ledger',
        snapshots: 'Snapshots',
        events: 'Events',
        manifests: 'Manifests',
      },
    });

    expect(result.collectionErrors).toEqual([]);
    expect(calls).toEqual(expect.arrayContaining([
      expect.objectContaining({ TableName: 'Snapshots' }),
      expect.objectContaining({ TableName: 'Events', IndexName: 'marketDate-index' }),
      expect.objectContaining({ TableName: 'Manifests', KeyConditionExpression: '#marketDate = :marketDate' }),
    ]));
    expect(dynamodb.scan).toBeUndefined();
    expect(result.products.find((row) => row.id === 'the-call').status)
      .toBe(PIPELINE_STATUS.INDEXED);
  });
});
