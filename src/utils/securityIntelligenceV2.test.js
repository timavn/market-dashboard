const {
  buildSecurityIntelligenceV2,
  secondaryRangeDecision,
} = require('./securityIntelligenceV2.cjs');
const {
  manifestChecksumForArtifacts,
} = require('./securityIntelligence.cjs');

const MARKET_DATE = '2026-07-23';
const NOW = new Date('2026-07-23T18:00:00Z');

function indexedManifest(productKey, eventCount = 1, marketDate = MARKET_DATE) {
  const artifacts = [{
    artifactId: `${productKey}-${marketDate}`,
    stage: 'indexed',
    eventCount,
    parserVersion: 'security-intelligence-v2',
  }];
  return {
    marketDate,
    productKey,
    schemaVersion: 1,
    state: 'indexed',
    parserVersion: 'security-intelligence-v2',
    artifactCount: 1,
    receivedCount: 1,
    parsedCount: 1,
    validatedCount: 1,
    indexedCount: 1,
    entityEventCount: eventCount,
    manifestChecksum: manifestChecksumForArtifacts(artifacts),
    artifacts,
  };
}

function investingEvent(symbol, value, sourceEventId = symbol) {
  return {
    marketDate: MARKET_DATE,
    productKey: 'investing-ideas',
    entityKey: `ticker#${symbol}`,
    entityType: 'ticker',
    entityId: symbol,
    eventType: 'investing_idea_position',
    signalValue: value,
    excerpt: `${symbol} ${value.side}`,
    publishedAt: `${MARKET_DATE}T13:00:00Z`,
    sourceEventId,
    matchType: 'structured_membership',
  };
}

function trackerEvent(productKey, symbol, trade, sourceEventId = `${productKey}-${symbol}-${trade}`) {
  return {
    marketDate: MARKET_DATE,
    productKey,
    entityKey: `ticker#${symbol}`,
    entityType: 'ticker',
    entityId: symbol,
    eventType: 'tracker_trade',
    signalValue: trade,
    excerpt: `${symbol} Trade ${trade}`,
    publishedAt: `${MARKET_DATE}T13:00:00Z`,
    sourceEventId,
    matchType: 'structured_membership',
  };
}

describe('canonical security intelligence v2', () => {
  test('preserves published Trend independently of a withheld range and excludes old revision evidence', () => {
    const manifest = indexedManifest('early-look', 1);
    Object.assign(manifest.artifacts[0], {
      contentSha256: 'source-hash',
      sourceQuality: { revision: 'quality-1', status: 'discrepancy' },
    });
    manifest.manifestChecksum = manifestChecksumForArtifacts(manifest.artifacts);
    const original = {
      marketDate: MARKET_DATE, productKey: 'early-look', entityKey: 'ticker#RUT',
      entityType: 'ticker', entityId: 'RUT', eventType: 'supplemental_risk_range',
      contentSha256: 'source-hash', sourceEventId: 'source-hash',
      matchType: 'structured_membership', signalValue: 'BULLISH',
      excerpt: 'RUT: {"lrr":2834,"hrr":2825,"trend":"BULLISH"}',
      publishedAt: `${MARKET_DATE}T11:27:00Z`,
    };
    const response = buildSecurityIntelligenceV2({
      scope: 'universe', marketDate: MARKET_DATE, historyDays: 0, now: NOW,
      productManifests: [manifest],
      entityEvents: [original, {
        ...original, sourceQualityRevision: 'quality-1',
        excerpt: 'RUT: {"trend":"BULLISH","withheldFields":["hrr","lrr"]}',
      }],
    });
    const product = response.bySymbol.IWM.products['early-look'];
    expect(product.status).toBe('available');
    expect(product.fields.trend).toMatchObject({ value: 'BULLISH', authority: false });
    expect(product.fields.riskRange).toBeNull();
    expect(JSON.stringify(product.fields)).not.toMatch(/2834|2825/);
    expect(response.bySymbol.IWM.decision.riskRange.status).toBe('unavailable');
  });

  test('keeps independently published Trade separate from normalized Trend aliases', () => {
    const response = buildSecurityIntelligenceV2({
      symbols: ['AMZN', 'AAPL'],
      marketDate: MARKET_DATE,
      historyDays: 0,
      now: NOW,
      snapshots: [],
      productManifests: [
        indexedManifest('momo-tracker', 2),
        indexedManifest('risk-ranges', 1),
      ],
      entityEvents: [
        trackerEvent('momo-tracker', 'AMZN', 'BEARISH'),
        trackerEvent('momo-tracker', 'AAPL', 'NEUTRAL'),
      ],
      riskRangeEnvelope: {
        status: 'current',
        available: true,
        ranges: {
          AMZN: { lrr: 258, hrr: 300, trend: 'positive' },
          AAPL: { lrr: 190, hrr: 205, trend: 'neutral' },
        },
        manifest: {
          publicationDate: MARKET_DATE,
          persistedManifestVerified: true,
        },
      },
    });

    expect(response.bySymbol.AMZN.decision).toMatchObject({
      trade: { status: 'available', value: 'BEARISH' },
      trend: { status: 'available', value: 'BULLISH' },
    });
    expect(response.bySymbol.AAPL.decision).toMatchObject({
      trade: { status: 'available', value: 'NEUTRAL' },
      trend: { status: 'available', value: 'NEUTRAL' },
    });
    expect(response.bySymbol.AMZN.products['momo-tracker'].fields.trade.value)
      .toBe('BEARISH');
    expect(response.bySymbol.AMZN.products['risk-ranges'].fields.trend.value)
      .toBe('BULLISH');
  });

  test('normalizes Investing Ideas bias and range without promoting primary authority', () => {
    const response = buildSecurityIntelligenceV2({
      symbols: ['DDOG', 'AAPL'],
      marketDate: MARKET_DATE,
      historyDays: 0,
      now: NOW,
      snapshots: [],
      productManifests: [indexedManifest('investing-ideas', 1)],
      entityEvents: [investingEvent('DDOG', {
        side: 'Long',
        bias: 'BULLISH',
        prevClose: 267.97,
        lrr: 244,
        hrr: 275,
      })],
      riskRangeEnvelope: {
        status: 'stale',
        available: false,
        ranges: {},
        manifest: { publicationDate: '2026-07-22', persistedManifestVerified: true },
      },
    });

    const ddog = response.bySymbol.DDOG;
    expect(response.schemaVersion).toBe(2);
    expect(ddog.products['investing-ideas']).toMatchObject({
      status: 'available',
      fields: {
        side: 'LONG',
        previousClose: 267.97,
        bias: { value: 'BULLISH', kind: 'position', authority: false },
        riskRange: { value: { lrr: 244, hrr: 275 }, authority: false },
      },
    });
    expect(ddog.health).toMatchObject({
      status: 'ready',
      hasDirectionalBias: true,
      hasRiskRange: true,
    });
    expect(ddog.decision.trade.status).toBe('unavailable');
    expect(ddog.decision.trend.status).toBe('unavailable');
    expect(response.bySymbol.AAPL.products['investing-ideas'].status).toBe('not_listed');
    expect(response.bySymbol.AAPL.health).toMatchObject({
      status: 'attention',
      missing: expect.arrayContaining(['directional_bias', 'risk_range']),
    });
  });

  test('counts a directional product and range from different products', () => {
    const response = buildSecurityIntelligenceV2({
      symbols: ['DDOG'],
      marketDate: MARKET_DATE,
      historyDays: 0,
      now: NOW,
      snapshots: [],
      productManifests: [
        indexedManifest('investing-ideas', 1),
        indexedManifest('risk-ranges', 1),
      ],
      entityEvents: [investingEvent('DDOG', {
        side: 'Short',
        bias: 'BEARISH',
        prevClose: 267.97,
        lrr: 244,
        hrr: 275,
      })],
      riskRangeEnvelope: {
        status: 'current',
        available: true,
        ranges: {
          DDOG: { lrr: 250, hrr: 280, trend: null, timestamp: `${MARKET_DATE}T12:00:00Z` },
        },
        manifest: {
          publicationDate: MARKET_DATE,
          persistedManifestVerified: true,
          latestUpdatedAt: `${MARKET_DATE}T12:00:00Z`,
        },
      },
    });

    const row = response.bySymbol.DDOG;
    expect(row.health).toMatchObject({
      status: 'ready',
      biasProducts: ['investing-ideas'],
      riskRangeProducts: expect.arrayContaining(['risk-ranges', 'investing-ideas']),
    });
    expect(row.products['risk-ranges'].fields.riskRange.value).toEqual({ lrr: 250, hrr: 280 });
    expect(row.products['investing-ideas'].fields.bias.value).toBe('BEARISH');
  });

  test('maps a current Portfolio Solutions listing to reference-only bullish trade and trend', () => {
    const response = buildSecurityIntelligenceV2({
      symbols: ['CLOZ'],
      marketDate: MARKET_DATE,
      historyDays: 0,
      now: NOW,
      snapshots: [],
      productManifests: [indexedManifest('portfolio-solutions', 1)],
      entityEvents: [{
        marketDate: MARKET_DATE,
        productKey: 'portfolio-solutions',
        entityKey: 'ticker#CLOZ',
        entityType: 'ticker',
        entityId: 'CLOZ',
        eventType: 'portfolio_solutions_rank',
        signalValue: 4,
        excerpt: 'CLOZ ranked #4; Weekly ▲ 3; Monthly ▲ 7',
        publishedAt: `${MARKET_DATE}T13:00:00Z`,
        sourceEventId: 'cloz-portfolio-rank',
        matchType: 'structured_membership',
      }],
      riskRangeEnvelope: { status: 'stale', available: false, ranges: {} },
    });

    const product = response.bySymbol.CLOZ.products['portfolio-solutions'];
    expect(product).toMatchObject({
      status: 'available',
      fields: {
        trade: {
          value: 'BULLISH',
          authority: false,
          referenceOnly: true,
          rule: 'portfolio-solutions-listed',
        },
        trend: {
          value: 'BULLISH',
          authority: false,
          referenceOnly: true,
          rule: 'portfolio-solutions-listed',
        },
        rank: { value: 4 },
      },
    });
    expect(response.bySymbol.CLOZ.health).toMatchObject({
      status: 'attention',
      hasDirectionalBias: true,
      hasRiskRange: false,
      biasProducts: ['portfolio-solutions'],
      missing: ['risk_range'],
    });
    expect(response.bySymbol.CLOZ.decision.trade.status).toBe('unavailable');
    expect(response.bySymbol.CLOZ.decision.trend.status).toBe('unavailable');
  });

  test('returns deterministic universe pages', () => {
    const response = buildSecurityIntelligenceV2({
      scope: 'universe',
      limit: 1,
      cursor: null,
      marketDate: MARKET_DATE,
      historyDays: 0,
      now: NOW,
      snapshots: [],
      productManifests: [indexedManifest('investing-ideas', 2)],
      entityEvents: [
        investingEvent('ZZZ', { side: 'Long', bias: 'BULLISH', lrr: 1, hrr: 2 }, 'zzz'),
        investingEvent('AAA', { side: 'Short', bias: 'BEARISH', lrr: 3, hrr: 4 }, 'aaa'),
      ],
      riskRangeEnvelope: { status: 'stale', available: false, ranges: {} },
    });

    expect(response.requestedSymbols).toEqual(['AAA']);
    expect(response.page).toMatchObject({ total: 2, nextCursor: '1' });
    expect(Object.keys(response.bySymbol)).toEqual(['AAA']);
  });

  test('universe discovery ignores narrative tokens and keeps structured rows', () => {
    const response = buildSecurityIntelligenceV2({
      scope: 'universe',
      limit: 10,
      marketDate: MARKET_DATE,
      historyDays: 0,
      now: NOW,
      snapshots: [{
        date: MARKET_DATE,
        snapshotType: 'the-call',
        publishedAt: `${MARKET_DATE}T13:00:00Z`,
        data: {
          longs: ['BBB'],
          summary: 'AUG and BEARISH are narrative words, not securities.',
          rows: [{ ticker: 'CCC', id: 'CCC_0', side: 'Long' }],
        },
      }],
      productManifests: [indexedManifest('investing-ideas', 2)],
      entityEvents: [
        investingEvent('ZZZ', { side: 'Long', bias: 'BULLISH', lrr: 1, hrr: 2 }, 'zzz'),
        investingEvent('AAA', { side: 'Short', bias: 'BEARISH', lrr: 3, hrr: 4 }, 'aaa'),
      ],
      riskRangeEnvelope: { status: 'stale', available: false, ranges: {} },
    });

    expect(response.requestedSymbols).toEqual(['AAA', 'BBB', 'CCC', 'ZZZ']);
    expect(response.requestedSymbols).not.toEqual(expect.arrayContaining(['AUG', 'BEARISH']));
    expect(response.page).toMatchObject({ total: 4, nextCursor: null });
  });

  test('universe discovery requires structured provenance for AM and PM', () => {
    const generic = buildSecurityIntelligenceV2({
      scope: 'universe',
      limit: 10,
      marketDate: MARKET_DATE,
      historyDays: 0,
      now: NOW,
      snapshots: [],
      entityEvents: [
        {
          marketDate: MARKET_DATE,
          productKey: 'signal-strength',
          entityType: 'ticker',
          entityId: 'PM',
          entityKey: 'ticker#PM',
          eventType: 'signal_strength_membership',
          matchType: 'direct',
          excerpt: '07/23/2026 12:29 PM EDT.',
        },
        {
          marketDate: MARKET_DATE,
          productKey: 'real-time-alert',
          entityType: 'ticker',
          entityId: 'AM',
          entityKey: 'ticker#AM',
          eventType: 'position_change',
          matchType: 'direct_alias',
          excerpt: 'The alert arrived at 08:00 AM EDT.',
        },
      ],
      riskRangeEnvelope: { status: 'stale', available: false, ranges: {} },
    });
    expect(generic.requestedSymbols).toEqual([]);
    expect(generic.bySymbol).toEqual({});

    const structured = buildSecurityIntelligenceV2({
      scope: 'universe',
      limit: 10,
      marketDate: MARKET_DATE,
      historyDays: 0,
      now: NOW,
      snapshots: [{
        date: MARKET_DATE,
        snapshotType: 'investing-ideas',
        data: {
          positions: [{ ticker: 'AM', side: 'Short', lrr: 17, hrr: 19 }],
        },
      }],
      entityEvents: [{
        marketDate: MARKET_DATE,
        productKey: 'signal-strength',
        entityType: 'ticker',
        entityId: 'PM',
        entityKey: 'ticker#PM',
        eventType: 'signal_strength_added',
        matchType: 'structured_membership',
        excerpt: 'PM',
      }],
      riskRangeEnvelope: { status: 'stale', available: false, ranges: {} },
    });
    expect(structured.requestedSymbols).toEqual(['AM', 'PM']);
    expect(Object.keys(structured.bySymbol)).toEqual(['AM', 'PM']);
  });

  test('does not satisfy health with direction only, range only, prior-day, or inferred evidence', () => {
    const rangeOnly = buildSecurityIntelligenceV2({
      symbols: ['SPX'],
      marketDate: MARKET_DATE,
      historyDays: 0,
      now: NOW,
      snapshots: [],
      productManifests: [indexedManifest('risk-ranges', 0)],
      entityEvents: [],
      riskRangeEnvelope: {
        status: 'current',
        available: true,
        ranges: { SPX: { lrr: 5000, hrr: 5100, trend: null } },
        manifest: { publicationDate: MARKET_DATE, persistedManifestVerified: true },
      },
    });
    expect(rangeOnly.bySymbol.SPX.health).toMatchObject({
      status: 'attention',
      hasDirectionalBias: false,
      hasRiskRange: true,
      missing: ['directional_bias'],
    });

    const directionOnly = buildSecurityIntelligenceV2({
      symbols: ['DDOG'],
      marketDate: MARKET_DATE,
      historyDays: 0,
      now: NOW,
      snapshots: [],
      productManifests: [indexedManifest('investing-ideas', 1)],
      entityEvents: [investingEvent('DDOG', {
        side: 'Long', bias: 'BULLISH', prevClose: 267.97,
      })],
      riskRangeEnvelope: { status: 'stale', available: false, ranges: {} },
    });
    expect(directionOnly.bySymbol.DDOG.health).toMatchObject({
      status: 'attention',
      hasDirectionalBias: true,
      hasRiskRange: false,
      missing: ['risk_range'],
    });

    const priorDay = buildSecurityIntelligenceV2({
      symbols: ['DDOG'],
      marketDate: MARKET_DATE,
      historyDays: 1,
      now: NOW,
      snapshots: [],
      productManifests: [indexedManifest('investing-ideas', 1, '2026-07-22')],
      entityEvents: [
        investingEvent('DDOG', {
          side: 'Long', bias: 'BULLISH', prevClose: 267.97, lrr: 244, hrr: 275,
        }),
      ].map((event) => ({ ...event, marketDate: '2026-07-22' })),
      riskRangeEnvelope: { status: 'stale', available: false, ranges: {} },
    });
    expect(priorDay.bySymbol.DDOG.health.status).toBe('attention');
    expect(priorDay.bySymbol.DDOG.health.hasDirectionalBias).toBe(false);
    expect(priorDay.bySymbol.DDOG.health.hasRiskRange).toBe(false);
  });

  test('excludes conflicting current tracker rows from normalized health fields', () => {
    const response = buildSecurityIntelligenceV2({
      symbols: ['SPX'],
      marketDate: MARKET_DATE,
      historyDays: 0,
      now: NOW,
      snapshots: [],
      productManifests: [indexedManifest('bitcoin-trend-tracker', 2)],
      entityEvents: [
        trackerEvent('bitcoin-trend-tracker', 'SPX', 'BULLISH'),
        trackerEvent('bitcoin-trend-tracker', 'SPX', 'BEARISH'),
      ],
      riskRangeEnvelope: { status: 'stale', available: false, ranges: {} },
    });
    const product = response.bySymbol.SPX.products['bitcoin-trend-tracker'];
    expect(product.status).toBe('conflict');
    expect(product.fields.trade).toBeNull();
    expect(product.fields.bias).toBeNull();
    expect(response.bySymbol.SPX.health).toMatchObject({
      status: 'attention',
      hasDirectionalBias: false,
      hasRiskRange: false,
    });
  });

  test('deduplicates legacy Investing Ideas rows and excludes same-publication conflicts', () => {
    const value = {
      side: 'Long',
      bias: 'BULLISH',
      prevClose: 100,
      lrr: 90,
      hrr: 110,
    };
    const duplicate = buildSecurityIntelligenceV2({
      symbols: ['DDOG'],
      marketDate: MARKET_DATE,
      historyDays: 0,
      now: NOW,
      snapshots: [],
      productManifests: [indexedManifest('investing-ideas', 2)],
      entityEvents: [
        investingEvent('DDOG', value, 'legacy-position'),
        investingEvent('DDOG', value, 'legacy-ticker-leaf'),
      ],
      riskRangeEnvelope: { status: 'stale', available: false, ranges: {} },
    });
    expect(duplicate.bySymbol.DDOG.products['investing-ideas'].status).toBe('available');
    expect(duplicate.bySymbol.DDOG.products['investing-ideas'].fields.facts).toHaveLength(1);

    const conflict = buildSecurityIntelligenceV2({
      symbols: ['DDOG'],
      marketDate: MARKET_DATE,
      historyDays: 0,
      now: NOW,
      snapshots: [],
      productManifests: [indexedManifest('investing-ideas', 2)],
      entityEvents: [
        investingEvent('DDOG', value, 'long-row'),
        investingEvent('DDOG', { ...value, side: 'Short', bias: 'BEARISH' }, 'short-row'),
      ],
      riskRangeEnvelope: { status: 'stale', available: false, ranges: {} },
    });
    expect(conflict.bySymbol.DDOG.products['investing-ideas']).toMatchObject({
      status: 'conflict',
      fields: {
        bias: null,
        riskRange: { value: { lrr: 90, hrr: 110 } },
      },
    });
    expect(conflict.bySymbol.DDOG.health).toMatchObject({
      status: 'attention',
      hasDirectionalBias: false,
      hasRiskRange: true,
      riskRangeProducts: ['investing-ideas'],
    });
  });
});

describe('same-day secondary Risk Ranges', () => {
  const missingRange = { status: 'unavailable', value: null, sourceId: null, reason: 'symbol-not-in-verified-primary-publication', lrr: null, hrr: null, decisionEligible: false };
  const product = (label, lrr, hrr, extra = {}) => ({ label, status: 'available', conflicts: [], fields: { riskRange: {
    value: { lrr, hrr }, marketDate: MARKET_DATE, referenceOnly: false, qualityStatus: 'indexed', publishedAt: `${MARKET_DATE}T00:00:00+00:00`,
    sourceUrl: 'https://app.hedgeye.com/feed_items/1', trend: null, ...extra } } });

  test('fills a range the daily sheet left missing, labelled with its product', () => {
    const decision = secondaryRangeDecision(missingRange, { 'investing-ideas': product('Investing Ideas', 1022, 1136) }, MARKET_DATE);
    expect(decision).toMatchObject({ status: 'available', lrr: 1022, hrr: 1136, value: { lrr: 1022, hrr: 1136 }, sourceId: 'investing-ideas',
      sourceLabel: 'Investing Ideas', sourceDate: MARKET_DATE, secondary: true, decisionEligible: false, corroboratedBy: [],
      primaryReason: 'symbol-not-in-verified-primary-publication' });
  });

  test('agreeing products corroborate; Early Look leads and carries its Trend', () => {
    const decision = secondaryRangeDecision(missingRange, {
      'investing-ideas': product('Investing Ideas', 217, 226),
      'early-look': product('Early Look', 217, 226, { trend: 'BULLISH' }),
    }, MARKET_DATE);
    expect(decision).toMatchObject({ status: 'available', sourceId: 'early-look', trend: 'BULLISH', corroboratedBy: ['investing-ideas'] });
  });

  test('two products printing different ranges are a conflict, never a pick', () => {
    const decision = secondaryRangeDecision(missingRange, {
      'investing-ideas': product('Investing Ideas', 5.67, 7.98),
      'bitcoin-trend-tracker': product('Bitcoin Trend Tracker', 5.67, 7.78),
    }, MARKET_DATE);
    expect(decision.status).toBe('conflict');
    expect(decision.reason).toBe('conflicting-same-day-risk-ranges');
    expect(decision.conflictingRanges).toEqual([
      { sourceId: 'investing-ideas', lrr: 5.67, hrr: 7.98 },
      { sourceId: 'bitcoin-trend-tracker', lrr: 5.67, hrr: 7.78 },
    ]);
  });

  test('the verified daily sheet always wins and is left untouched', () => {
    const sheet = { status: 'available', lrr: 183, hrr: 192, value: { lrr: 183, hrr: 192 }, sourceId: 'risk-ranges', decisionEligible: true };
    expect(secondaryRangeDecision(sheet, { 'investing-ideas': product('Investing Ideas', 180, 195) }, MARKET_DATE)).toBe(sheet);
  });

  test('an earlier session, an unindexed read, a conflicted product or bad bounds count for nothing', () => {
    const products = {
      'investing-ideas': product('Investing Ideas', 100, 110, { marketDate: '2026-07-22' }),
      'early-look': product('Early Look', 100, 110, { qualityStatus: 'parsed' }),
      'momo-tracker': { ...product('Momo Tracker', 100, 110), conflicts: ['riskRange'] },
      'bitcoin-trend-tracker': product('Bitcoin Trend Tracker', 110, 100),
      'risk-ranges': product('Risk Ranges', 100, 110),
      'etf-pro': product('ETF Pro', 100, 110),
    };
    expect(secondaryRangeDecision(missingRange, products, MARKET_DATE)).toBe(missingRange);
  });
});
