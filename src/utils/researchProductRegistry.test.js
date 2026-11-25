const {
  CONTROLLED_EXPOSURES,
  CONTROLLED_EXPOSURE_TYPES,
  RESEARCH_PRODUCTS,
  RESEARCH_PRODUCT_BY_ID,
  getControlledExposure,
  getResearchProduct,
  getSecurityExposureTags,
  isResearchProductDue,
  latestResearchMarketDate,
} = require('./researchProductRegistry.cjs');

describe('researchProductRegistry', () => {
  test('exposes canonical authorities and required processing stages', () => {
    expect(RESEARCH_PRODUCT_BY_ID['risk-ranges'].authorities).toMatchObject({
      trend: true,
      riskRange: true,
      trade: false,
    });
    expect(RESEARCH_PRODUCT_BY_ID['early-look'].authorities.supplementalRiskRange).toBe(true);
    expect(RESEARCH_PRODUCT_BY_ID['momo-tracker'].authorities.trade).toBe(false);
    expect(RESEARCH_PRODUCT_BY_ID['momo-tracker'].authorities.trend).toBe(true);
    expect(RESEARCH_PRODUCTS.every((product) => (
      product.requiredStages.join(',') === 'received,parsed,validated,indexed'
    ))).toBe(true);
    expect(getResearchProduct('risk-ranges')).toBe(RESEARCH_PRODUCT_BY_ID['risk-ranges']);
  });

  test('leaves out the retired Signal Strength Shorts product the deployed registry still names', () => {
    expect(RESEARCH_PRODUCTS.map((product) => product.id)).not.toContain('signal-strength-shorts');
    expect(getResearchProduct('signal-strength-shorts')).toBeNull();
    expect(getResearchProduct('signal-strength').id).toBe('signal-strength');
  });

  test('only marks scheduled products due after their New York deadline', () => {
    expect(isResearchProductDue('risk-ranges', {
      now: new Date('2026-07-23T11:59:00Z'),
      marketDate: '2026-07-23',
    })).toBe(false);
    expect(isResearchProductDue('risk-ranges', {
      now: new Date('2026-07-23T12:15:00Z'),
      marketDate: '2026-07-23',
    })).toBe(true);
    expect(isResearchProductDue('risk-ranges', {
      now: new Date('2026-07-23T12:14:59Z'),
      marketDate: '2026-07-23',
    })).toBe(false);
    expect(isResearchProductDue('the-call', {
      now: new Date('2026-07-23T18:00:00Z'),
      marketDate: '2026-07-23',
    })).toBe(false);
  });

  test('uses the latest market day on weekends and exchange holidays', () => {
    expect(latestResearchMarketDate(new Date('2026-07-26T18:00:00Z')))
      .toBe('2026-07-24');
    expect(latestResearchMarketDate(new Date('2026-07-04T18:00:00Z')))
      .toBe('2026-07-02');
    expect(latestResearchMarketDate(new Date('2026-07-23T18:00:00Z')))
      .toBe('2026-07-23');
  });

  test('normalizes typed controlled exposures and preserves legacy factor ids', () => {
    expect(CONTROLLED_EXPOSURE_TYPES).toEqual([
      'factor',
      'sector',
      'country',
      'commodity',
      'macro',
    ]);
    expect(new Set(CONTROLLED_EXPOSURES.map((exposure) => exposure.type))).toEqual(
      new Set(CONTROLLED_EXPOSURE_TYPES),
    );
    expect(getSecurityExposureTags('DDOG')).toEqual([
      expect.objectContaining({ id: 'growth', type: 'factor', label: 'Growth' }),
      expect.objectContaining({ id: 'technology', type: 'sector', label: 'Technology' }),
    ]);
    expect(getSecurityExposureTags('GLD')).toEqual([
      expect.objectContaining({ id: 'low-beta', type: 'factor', label: 'Low Beta' }),
      expect.objectContaining({ id: 'defensive', type: 'factor', label: 'Defensives' }),
      expect.objectContaining({ id: 'gold', type: 'commodity', label: 'Gold' }),
    ]);
    expect(getSecurityExposureTags('QQQ')).toEqual([
      expect.objectContaining({ id: 'secular-growth', type: 'factor', label: 'Secular Growth' }),
      expect.objectContaining({ id: 'high-beta', type: 'factor', label: 'High Beta' }),
      expect.objectContaining({ id: 'momentum', type: 'factor', label: 'Momentum' }),
      expect.objectContaining({ id: 'technology', type: 'sector', label: 'Technology' }),
    ]);
    expect(getSecurityExposureTags('AAPL')).toEqual([]);

    // Events written before typed entities used factor# for every exposure.
    expect(getControlledExposure('technology', 'factor', { legacyFactor: true }))
      .toMatchObject({ id: 'technology', type: 'sector' });
  });
});
