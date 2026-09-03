const {
  createExposureLabSecurityMaster,
  mergeSecurityMasterReviews,
  normalizeSecurityReview,
} = require('./exposureLabSecurityMaster.cjs');

function request(result) {
  return { promise: jest.fn().mockResolvedValue(result) };
}

describe('exposureLabSecurityMaster', () => {
  test('validates audited geography by instrument, allocation total, and provenance', () => {
    const stock = normalizeSecurityReview('abnb', {
      identityStatus: 'verified',
      canonicalSymbol: 'ABNB',
      instrumentType: 'STK',
      geography: {
        basis: 'country_of_risk',
        allocations: [{ countryCode: 'us', weightPct: 100 }],
        sourceName: 'Issuer annual report',
        sourceAsOf: '2026-06-30',
        sourceUrl: 'https://example.com/filing',
      },
      reviewedBy: 'Risk PM',
      reviewReason: 'Matched issuer and reviewed country of risk.',
      expectedVersion: 0,
    });
    expect(stock.geography).toEqual({
      basis: 'country_of_risk',
      allocations: [{ countryCode: 'US', weightPct: 100 }],
      sourceName: 'Issuer annual report',
      sourceAsOf: '2026-06-30',
      sourceUrl: 'https://example.com/filing',
    });

    expect(() => normalizeSecurityReview('ABNB', {
      identityStatus: 'verified',
      canonicalSymbol: 'ABNB',
      instrumentType: 'STK',
      geography: {
        basis: 'holdings_lookthrough',
        allocations: [{ countryCode: 'US', weightPct: 100 }],
        sourceName: 'Unsupported stock look-through',
        sourceAsOf: '2026-06-30',
      },
      reviewedBy: 'Risk PM',
      reviewReason: 'Invalid basis test.',
    })).toThrow(/country_of_risk/i);

    expect(() => normalizeSecurityReview('ACWI', {
      identityStatus: 'verified',
      canonicalSymbol: 'ACWI',
      instrumentType: 'ETF',
      geography: {
        basis: 'holdings_lookthrough',
        allocations: [
          { countryCode: 'US', weightPct: 70 },
          { countryCode: 'JP', weightPct: 20 },
        ],
        sourceName: 'Fund holdings',
        sourceAsOf: '2026-06-30',
      },
      reviewedBy: 'Risk PM',
      reviewReason: 'Invalid total test.',
    })).toThrow(/total 100%/i);

    expect(() => normalizeSecurityReview('ACWI', {
      identityStatus: 'verified',
      canonicalSymbol: 'ACWI',
      instrumentType: 'ETF',
      geography: {
        basis: 'single_country_mandate',
        allocations: [{ countryCode: 'US', weightPct: 100 }],
        sourceName: '',
        sourceAsOf: '2026-06-30',
      },
      reviewedBy: 'Risk PM',
      reviewReason: 'Missing provenance test.',
    })).toThrow(/sourceName/i);
  });

  test('clears geography whenever identity is no longer verified', () => {
    const review = normalizeSecurityReview('ABNB', {
      identityStatus: 'rejected',
      geography: {
        basis: 'country_of_risk',
        allocations: [{ countryCode: 'US', weightPct: 100 }],
        sourceName: 'Issuer filing',
        sourceAsOf: '2026-06-30',
      },
      reviewedBy: 'Risk PM',
      reviewReason: 'Identity no longer matches the discovered token.',
      expectedVersion: 2,
    });
    expect(review.geography).toBeNull();
  });

  test('requires verified identity before analysis or hedge eligibility', () => {
    const verified = normalizeSecurityReview('abnb', {
      identityStatus: 'verified',
      canonicalSymbol: 'ABNB',
      instrumentType: 'STK',
      analysisEligible: true,
      hedgeEligible: true,
      reviewedBy: 'Risk PM',
      reviewReason: 'Matched issuer and primary US listing.',
      expectedVersion: 0,
    });
    expect(verified.ticker).toBe('ABNB');
    expect(verified.hedgeEligible).toBe(true);

    const rejected = normalizeSecurityReview('ABOUT', {
      identityStatus: 'rejected',
      analysisEligible: true,
      hedgeEligible: true,
      reviewedBy: 'Risk PM',
      reviewReason: 'Legacy parser prose token, not a security.',
      expectedVersion: 0,
    });
    expect(rejected.analysisEligible).toBe(false);
    expect(rejected.hedgeEligible).toBe(false);

    expect(() => normalizeSecurityReview('ABNB', {
      identityStatus: 'verified',
      canonicalSymbol: 'ABNB',
      instrumentType: 'STK',
      hedgeEligible: true,
      reviewedBy: 'Risk PM',
      reviewReason: 'Matched issuer.',
    })).toThrow(/requires analysisEligible/i);
  });

  test('writes an immutable audit event and version-conditioned current record', async () => {
    const documentClient = {
      get: jest.fn(() => request({ Item: undefined })),
      transactWrite: jest.fn(() => request({})),
    };
    const store = createExposureLabSecurityMaster({
      documentClient,
      now: () => '2026-08-23T12:00:00.000Z',
      eventId: () => 'event-1',
    });

    const result = await store.writeReview('ABNB', {
      identityStatus: 'verified',
      canonicalSymbol: 'ABNB',
      instrumentType: 'STK',
      analysisEligible: true,
      hedgeEligible: false,
      geography: {
        basis: 'country_of_risk',
        allocations: [{ countryCode: 'US', weightPct: 100 }],
        sourceName: 'Issuer annual report',
        sourceAsOf: '2026-06-30',
      },
      reviewedBy: 'Risk PM',
      reviewReason: 'Matched issuer and listing.',
      expectedVersion: 0,
    });

    expect(result.version).toBe(1);
    const transaction = documentClient.transactWrite.mock.calls[0][0];
    expect(transaction.TransactItems).toHaveLength(2);
    expect(transaction.TransactItems[0].Put.Item.recordKey).toBe(
      'AUDIT#2026-08-23T12:00:00.000Z#event-1',
    );
    expect(transaction.TransactItems[1].Put.Item.recordKey).toBe('CURRENT');
    expect(transaction.TransactItems[1].Put.Item.geography).toEqual(expect.objectContaining({
      basis: 'country_of_risk',
      sourceName: 'Issuer annual report',
    }));
    expect(transaction.TransactItems[0].Put.Item.next.geography.allocations).toEqual([
      { countryCode: 'US', weightPct: 100 },
    ]);
    expect(transaction.TransactItems[0].Put.ConditionExpression).toBe('attribute_not_exists(#recordKey)');
    expect(transaction.TransactItems[1].Put.ConditionExpression).toBe('attribute_not_exists(#recordKey)');
  });

  test('rejects stale expected versions before writing either audit or current state', async () => {
    const documentClient = {
      get: jest.fn(() => request({
        Item: {
          ticker: 'ABNB',
          recordKey: 'CURRENT',
          identityStatus: 'verified',
          canonicalSymbol: 'ABNB',
          instrumentType: 'STK',
          version: 3,
        },
      })),
      transactWrite: jest.fn(() => request({})),
    };
    const store = createExposureLabSecurityMaster({ documentClient });

    await expect(store.writeReview('ABNB', {
      identityStatus: 'verified',
      canonicalSymbol: 'ABNB',
      instrumentType: 'STK',
      reviewedBy: 'Risk PM',
      reviewReason: 'Stale editor should be rejected.',
      expectedVersion: 2,
    })).rejects.toEqual(expect.objectContaining({
      code: 'SECURITY_REVIEW_VERSION_CONFLICT',
      status: 409,
    }));
    expect(documentClient.transactWrite).not.toHaveBeenCalled();
  });

  test('merges current reviews without dropping unreviewed discoveries', () => {
    const merged = mergeSecurityMasterReviews({
      rows: [
        { ticker: 'ABNB', identityStatus: 'unverified', analysisEligible: false },
        { ticker: 'ABOUT', identityStatus: 'unverified', analysisEligible: false },
      ],
      meta: { universeCount: 2 },
    }, [{
      ticker: 'ABNB',
      displayName: 'Airbnb, Inc.',
      identityStatus: 'verified',
      reviewStatus: 'reviewed',
      analysisEligible: true,
      hedgeEligible: false,
      version: 1,
    }]);

    expect(merged.rows).toHaveLength(2);
    expect(merged.rows[0].analysisEligible).toBe(true);
    expect(merged.rows[0]).toEqual(expect.objectContaining({
      name: 'Airbnb, Inc.',
      nameSource: 'Exposure Lab security master',
      nameVerified: true,
    }));
    expect(merged.rows[1].identityStatus).toBe('unverified');
    expect(merged.meta.reviewedCount).toBe(1);
  });
});
