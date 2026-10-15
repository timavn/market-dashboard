const {
  batchGetSnapshots,
  buildSecurityIntelligence,
  canonicalizeSymbol,
  defaultResearchMarketDate,
  extractSnapshotReferences,
  filterSourceQualityRevisions,
  isValidMarketDate,
  loadSecurityIntelligenceInputs,
  manifestChecksumForArtifacts,
  marketDateSequence,
  normalizeRequestedSymbols,
  prepareNarrativeReferenceMatchers,
  prepareStructuredReferenceMatchers,
} = require('./securityIntelligence.cjs');

const MARKET_DATE = '2026-07-23';
const NOW = new Date('2026-07-23T18:00:00Z');
const explicitTrade = (ticker, value) => ({ trade: value, signalProvenance: { field: 'trade', method: 'explicit-field', sourceField: `data.${ticker}.trade`, sourceText: `${ticker}: Trade ${value}` } });

describe('request-local direct narrative matching', () => {
  const symbols = ['SPY', 'SPX', 'QQQ', 'TLT', 'DDOG', 'GLD', 'USO', 'UUP', 'AM', 'PM', 'BRK.B',
    ...Array.from({ length: 58 }, (_, index) => `TEST${index}`)];
  const direct = entries => entries.filter(entry => ['direct', 'direct_alias'].includes(entry.reference.matchType));
  const source = {
    date: MARKET_DATE, snapshotType: 'signal-strength', publishedAt: '2026-07-23T16:29:00Z',
    article: { feedUrl: 'https://app.hedgeye.com/feed_items/123',
      bodyText: 'SPX and BRK.B led growth and technology. Gold and the US dollar held. 08:00 AM and 12:29 PM EDT.' },
    data: { added: ['AM', 'PM', 'QQQ'], removed: ['TLT'],
      notes: ['DDOG and GLD appeared beside USO and UUP.', 'SPY TEST2 and TEST57; NOTSPY and TEST570 are different tokens.'] },
  };

  afterEach(() => jest.restoreAllMocks());

  test('prepared69-symbol direct-only results equal default direct results, preserving aliases and typed meridiem tickers', () => {
    const baseline = extractSnapshotReferences(source, symbols, 'indexed');
    expect(baseline.some(entry => entry.reference.matchType === 'inferred_exposure')).toBe(true);
    const preparedNarrativeMatchers = prepareNarrativeReferenceMatchers(symbols);
    const optimized = extractSnapshotReferences(source, symbols, 'indexed', {
      skipExposureMentions: true, preparedNarrativeMatchers,
    });
    expect(symbols).toHaveLength(69);
    expect(optimized).toEqual(direct(baseline));
    expect(optimized).toContainEqual(expect.objectContaining({ symbol: 'SPY', reference: expect.objectContaining({
      kind: 'summary_mention', matchedText: 'SPX', matchType: 'direct_alias',
    }) }));
    expect(optimized.filter(entry => ['AM', 'PM'].includes(entry.symbol)).map(entry => entry.reference.kind))
      .toEqual(['signal_strength_added', 'signal_strength_added']);
    expect(extractSnapshotReferences(source, symbols, 'indexed', { preparedNarrativeMatchers })).toEqual(baseline);
  });

  test('preparation copies capture identity and a different symbol request cannot inherit its matches', () => {
    const requested = ['SPY'];
    const preparedNarrativeMatchers = prepareNarrativeReferenceMatchers(requested);
    requested[0] = 'QQQ';
    const options = { skipExposureMentions: true, preparedNarrativeMatchers };
    expect(extractSnapshotReferences(source, ['SPY'], 'indexed', options))
      .toEqual(direct(extractSnapshotReferences(source, ['SPY'], 'indexed')));
    const different = extractSnapshotReferences(source, requested, 'indexed', options);
    expect(different).toEqual(direct(extractSnapshotReferences(source, requested, 'indexed')));
    expect(different.every(entry => entry.symbol === 'QQQ')).toBe(true);
  });

  test('direct token patterns compile once for many publications and structured-only reads skip every narrative pattern', () => {
    const expectedStructured = extractSnapshotReferences(source, symbols, 'indexed')
      .filter(entry => ['signal_strength_added', 'signal_strength_removed'].includes(entry.reference.kind));
    const NativeRegExp = RegExp;
    const constructor = jest.spyOn(global, 'RegExp').mockImplementation(function (pattern, flags) {
      return new NativeRegExp(pattern, flags);
    });
    const preparedNarrativeMatchers = prepareNarrativeReferenceMatchers(symbols);
    const compiled = constructor.mock.calls.filter(([pattern]) => String(pattern).startsWith('(^|[^A-Z0-9])')).length;
    expect(compiled).toBeGreaterThan(60);
    for (let index = 0; index < 40; index += 1) {
      extractSnapshotReferences({ ...source, date: `2026-07-${String(1 + index % 23).padStart(2, '0')}` }, symbols, 'indexed', {
        skipExposureMentions: true, preparedNarrativeMatchers,
      });
    }
    expect(constructor.mock.calls.filter(([pattern]) => String(pattern).startsWith('(^|[^A-Z0-9])'))).toHaveLength(compiled);
    constructor.mockClear();
    const structured = extractSnapshotReferences(source, symbols, 'indexed', { skipNarrativeMentions: true });
    expect(structured).toEqual(expectedStructured);
    expect(constructor.mock.calls.filter(([pattern]) => String(pattern).startsWith('(^|[^A-Z0-9])'))).toEqual([]);
  });
});

describe('request-local structured reference matching', () => {
  const symbols = ['SPX', 'SPY', 'SPX', 'GOLD', 'GC', 'GLD', 'AM', 'PM', 'BRK.B'];
  const sources = [
    { snapshotType: 'risk-ranges', data: {
      SPX: { ticker: 'SPX', lrr: 590, hrr: 610, trend: 'Bullish', trade: 'Bearish' },
      GOLD: { ticker: 'GOLD', lrr: 2500, hrr: 2600, trend: 'Neutral', trade: 'Bullish' },
      AM: { ticker: 'AM', lrr: 17, hrr: 19, trend: 'Neutral' },
    } },
    { snapshotType: 'signal-strength', data: { added: ['PM', 'AM'], removed: ['SPX'] } },
    { snapshotType: 'investing-ideas', data: { positions: [{ ticker: 'GLD', side: 'Long' }, { ticker: 'BRK.B', side: 'Short' }] } },
    { snapshotType: 'portfolio-solutions', data: { rankings: [{ ticker: 'SPX', rank: 2 }], topMovers: { weekly: [{ ticker: 'BRK.B', change: 3 }] } } },
    { snapshotType: 'momo-tracker', data: { stocks: { SPX: { ticker: 'SPX', trend: 'Bearish' } } } },
    { snapshotType: 'the-call', data: { longs: ['SPX'], shorts: ['BRK.B'], neutrals: ['AM'] } },
    { snapshotType: 'real-time-alert', data: { alerts: [{ ticker: 'PM', action: 'SELL-SOME' }] } },
    { snapshotType: 'etf-pro', data: { changes: [{ ticker: 'AM', action: 'REMOVE' }] } },
  ].map(source => ({ ...source, date: MARKET_DATE, publishedAt: '2026-07-23T16:00:00Z',
    article: { feedUrl: 'https://app.hedgeye.com/feed_items/123' } }));
  const options = { includeUnverifiedRiskRanges: true, skipNarrativeMentions: true };

  afterEach(() => {
    jest.restoreAllMocks();
    jest.dontMock('./publishedResearchSignals.cjs');
  });

  test('canonical indexes preserve ordered duplicate matches while exact Trade never inherits an exposure alias', () => {
    const requested = [...symbols];
    const preparedStructuredMatchers = prepareStructuredReferenceMatchers(requested);
    requested.reverse();
    const baseline = sources.flatMap(source => extractSnapshotReferences(source, symbols, 'indexed', options));
    const optimized = sources.flatMap(source => extractSnapshotReferences(source, symbols, 'indexed', {
      ...options, preparedStructuredMatchers,
    }));
    expect(optimized).toEqual(baseline);
    expect(optimized.filter(entry => entry.reference.kind === 'historical_risk_range' && entry.reference.matchedText === 'SPX')
      .map(entry => entry.symbol)).toEqual(['SPX', 'SPY', 'SPX']);
    const trades = optimized.filter(entry => entry.reference.kind === 'trade_signal');
    expect(trades.some(entry => entry.reference.sourceTicker === 'SPX' && entry.symbol === 'SPY')).toBe(false);
    expect(trades.some(entry => entry.reference.sourceTicker === 'GOLD' && ['GC', 'GLD'].includes(entry.symbol))).toBe(false);
    expect(trades.filter(entry => entry.reference.sourceTicker === 'SPX').map(entry => entry.symbol)).toEqual(['SPX', 'SPX']);
    expect(extractSnapshotReferences(sources[1], ['PM'], 'indexed', { ...options, preparedStructuredMatchers }))
      .toEqual(extractSnapshotReferences(sources[1], ['PM'], 'indexed', options));
  });

  test('typed rows normalize their ticker once instead of revalidating the entire69-symbol request', () => {
    const requested = ['SPY', 'SPX', 'AM', 'PM', ...Array.from({ length: 65 }, (_, index) => `TEST${index}`)];
    const source = sources[1];
    let validations = 0;
    const nativeTest = RegExp.prototype.test;
    jest.spyOn(RegExp.prototype, 'test').mockImplementation(function (value) {
      if (this.source.startsWith('^[A-Z0-9][A-Z0-9.')) validations += 1;
      return nativeTest.call(this, value);
    });
    const baseline = Array.from({ length: 40 }, () => extractSnapshotReferences(source, requested, 'indexed', options));
    const baselineValidations = validations;
    validations = 0;
    const preparedStructuredMatchers = prepareStructuredReferenceMatchers(requested);
    const optimized = Array.from({ length: 40 }, () => extractSnapshotReferences(source, requested, 'indexed', {
      ...options, preparedStructuredMatchers,
    }));
    expect(optimized).toEqual(baseline);
    expect(validations).toBeGreaterThan(0);
    expect(validations).toBeLessThan(baselineValidations / 10);
  });

  test('exact Trade matching is evaluated once per distinct source ticker and prepared request', () => {
    const signals = jest.requireActual('./publishedResearchSignals.cjs');
    const sameSignalInstrument = jest.fn(signals.sameSignalInstrument);
    jest.isolateModules(() => {
      jest.doMock('./publishedResearchSignals.cjs', () => ({ ...signals, sameSignalInstrument }));
      const utilities = require('./securityIntelligence.cjs');
      const requested = ['SPY', 'SPX', 'GOLD', 'GC', ...Array.from({ length: 65 }, (_, index) => `TEST${index}`)];
      const preparedStructuredMatchers = utilities.prepareStructuredReferenceMatchers(requested);
      const baseline = Array.from({ length: 30 }, () => utilities.extractSnapshotReferences(sources[0], requested, 'indexed', options));
      expect(sameSignalInstrument).toHaveBeenCalledTimes(30 * 2 * requested.length);
      sameSignalInstrument.mockClear();
      const optimized = Array.from({ length: 30 }, () => utilities.extractSnapshotReferences(sources[0], requested, 'indexed', {
        ...options, preparedStructuredMatchers,
      }));
      expect(optimized).toEqual(baseline);
      expect(sameSignalInstrument).toHaveBeenCalledTimes(2 * requested.length);
      const nextCapture = utilities.prepareStructuredReferenceMatchers(requested);
      utilities.extractSnapshotReferences(sources[0], requested, 'indexed', { ...options, preparedStructuredMatchers: nextCapture });
      expect(sameSignalInstrument).toHaveBeenCalledTimes(4 * requested.length);
    });
  });
});

function indexedManifest(productKey, marketDate = MARKET_DATE, {
  artifactCount = 1,
  eventCount = 0,
} = {}) {
  const artifacts = Array.from({ length: artifactCount }, (_, index) => ({
    artifactId: `${productKey}-${marketDate}-${index + 1}`,
    stage: 'indexed',
    eventCount: index === 0 ? eventCount : 0,
    parserVersion: 'research-entity-events-v1',
  }));
  return {
    marketDate,
    productKey,
    schemaVersion: 1,
    state: 'indexed',
    parserVersion: 'research-entity-events-v1',
    artifactCount,
    receivedCount: artifactCount,
    parsedCount: artifactCount,
    validatedCount: artifactCount,
    indexedCount: artifactCount,
    entityEventCount: eventCount,
    manifestChecksum: manifestChecksumForArtifacts(artifacts),
    artifacts,
  };
}

function verifiedRiskEnvelope(ranges, marketDate = MARKET_DATE) {
  return {
    status: 'current',
    available: true,
    ranges,
    manifest: {
      publicationDate: marketDate,
      persistedManifestVerified: true,
      latestUpdatedAt: `${marketDate}T12:10:00Z`,
    },
  };
}

describe('security intelligence projection', () => {
  test('uses only the manifest-selected discrepancy revision without losing valid report fields', () => {
    const revision = 'quality-revision-1';
    const contentSha256 = 'publication-content-hash';
    const manifest = indexedManifest('early-look', MARKET_DATE, { eventCount: 2 });
    Object.assign(manifest.artifacts[0], {
      contentSha256,
      sourceMessageId: 'original-publication',
      sourceQuality: { status: 'discrepancy', revision },
    });
    manifest.manifestChecksum = manifestChecksumForArtifacts(manifest.artifacts);
    const original = [
      { entityKey: 'ticker#RUT', excerpt: 'RUT: {"lrr":2834,"hrr":2825,"trend":"BULLISH"}' },
      { entityKey: 'ticker#SPX', excerpt: 'SPX: {"lrr":6500,"hrr":6700,"trend":"BULLISH"}' },
    ].map(event => ({
      ...event,
      marketDate: MARKET_DATE,
      productKey: 'early-look',
      eventType: 'supplemental_risk_range',
      sourceEventId: contentSha256,
      contentSha256,
      sourceMessageId: 'original-publication',
      signalValue: 'BULLISH',
      decisionEligible: false,
    }));
    const revised = original.map(event => ({ ...event, sourceQualityRevision: revision }));
    revised[0].excerpt = 'RUT: {"trend":"BULLISH","withheldFields":["hrr","lrr"]}';
    const response = buildSecurityIntelligence({
      symbols: ['RUT', 'SPX'], marketDate: MARKET_DATE, historyDays: 0, now: NOW,
      productManifests: [manifest], entityEvents: [...original, ...revised],
    });
    expect(response.products.find(product => product.id === 'early-look')).toMatchObject({ status: 'indexed' });
    expect(response.bySymbol.RUT.directReferences).toHaveLength(1);
    expect(response.bySymbol.RUT.directReferences[0]).toMatchObject({ value: 'BULLISH', qualityStatus: 'indexed' });
    expect(response.bySymbol.RUT.directReferences[0].excerpt).not.toMatch(/2834|2825/);
    expect(response.bySymbol.SPX.directReferences).toHaveLength(1);
    expect(response.bySymbol.SPX.directReferences[0].excerpt).toContain('6500');
    expect(original[0].excerpt).toContain('2834');
  });

  test('does not substitute old events when a selected discrepancy revision has not arrived', () => {
    const manifest = indexedManifest('early-look', MARKET_DATE, { eventCount: 1 });
    Object.assign(manifest.artifacts[0], {
      contentSha256: 'publication-hash',
      sourceQuality: { revision: 'selected-revision' },
    });
    manifest.manifestChecksum = manifestChecksumForArtifacts(manifest.artifacts);
    const response = buildSecurityIntelligence({
      symbols: ['RUT'], marketDate: MARKET_DATE, historyDays: 0, now: NOW,
      productManifests: [manifest],
      entityEvents: [{
        marketDate: MARKET_DATE, productKey: 'early-look', entityKey: 'ticker#RUT',
        contentSha256: 'publication-hash', excerpt: 'RUT LRR 2834 HRR 2825',
      }],
    });
    expect(response.bySymbol.RUT.directReferences).toEqual([]);
    expect(response.products.find(product => product.id === 'early-look')).toMatchObject({
      status: 'failed', error: 'manifest-event-count-mismatch',
    });
  });

  test('requires exact artifact revision and keeps independent artifacts from the same message', () => {
    const productKey = 'early-look';
    const record = { marketDate: MARKET_DATE, productKey, sourceMessageId: 'same-message' };
    const manifests = [{ marketDate: MARKET_DATE, productKey, artifacts: [
      { artifactId: 'revised', contentSha256: 'revised-hash', sourceMessageId: 'same-message', sourceQuality: { revision: 'r1' } },
      { artifactId: 'valid', contentSha256: 'valid-hash', sourceMessageId: 'same-message' },
    ] }];
    const current = { ...record, contentSha256: 'revised-hash', sourceQualityRevision: 'r1' };
    const independent = { ...record, contentSha256: 'valid-hash' };
    expect(filterSourceQualityRevisions([
      current, independent, record,
      { ...current, sourceQualityRevision: 'r0' },
      { ...current, contentSha256: 'wrong-hash' },
    ], manifests)).toEqual([current, independent]);
    expect(filterSourceQualityRevisions([current], [])).toEqual([]);
  });

  test('filters old snapshot projections using their publication and selected revision', () => {
    const original = { date: MARKET_DATE, snapshotType: 'early-look', gmailMessageId: 'message-1', data: { RUT: { lrr: 2834, hrr: 2825 } } };
    const revised = { ...original, sourceQuality: { revision: 'r1' }, data: { RUT: { trend: 'BULLISH' } } };
    const manifests = [{ marketDate: MARKET_DATE, productKey: 'early-look', artifacts: [{
      sourceMessageId: 'message-1', sourceQuality: { revision: 'r1' },
    }] }];
    expect(filterSourceQualityRevisions([original, revised], manifests, { snapshots: true })).toEqual([revised]);
  });

  test('keeps narrative Momo direction separate from the canonical structured bias', () => {
    const response = buildSecurityIntelligence({
      symbols: ['AMZN'],
      marketDate: MARKET_DATE,
      historyDays: 0,
      now: NOW,
      productManifests: [
        indexedManifest('momo-tracker', MARKET_DATE, { eventCount: 1 }),
        indexedManifest('risk-ranges', MARKET_DATE, { eventCount: 1 }),
      ],
      entityEvents: [{
        marketDate: MARKET_DATE,
        productKey: 'momo-tracker',
        entityKey: 'ticker#AMZN',
        eventType: 'trade_signal',
        direction: 'NEGATIVE',
        signalValue: 'BULLISH',
        excerpt: 'AMZN: Trade BULLISH; narrative direction negative.',
        publishedAt: `${MARKET_DATE}T13:00:00Z`,
        sourceEventId: 'amzn-momo-structured',
        matchType: 'direct',
      }],
      riskRangeEnvelope: verifiedRiskEnvelope({
        AMZN: {
          lrr: 258,
          hrr: 300,
          trend: 'BULLISH',
          timestamp: `${MARKET_DATE}T12:00:00Z`,
        },
      }),
    });

    expect(response.bySymbol.AMZN.decision).toMatchObject({
      trade: { status: 'available', value: 'BULLISH', sourceId: 'momo-tracker' },
      trend: { status: 'available', value: 'BULLISH', sourceId: 'risk-ranges' },
    });
    expect(response.bySymbol.AMZN.directReferences).toEqual(expect.arrayContaining([
      expect.objectContaining({
        productId: 'momo-tracker',
        direction: 'NEGATIVE',
        value: 'BULLISH',
      }),
    ]));
  });

  test('publishes only authority-approved decision inputs and separates exposure references', () => {
    const response = buildSecurityIntelligence({
      symbols: ['DDOG'],
      marketDate: MARKET_DATE,
      historyDays: 0,
      now: NOW,
      riskRangeEnvelope: verifiedRiskEnvelope({
        DDOG: {
          lrr: 139,
          hrr: 148,
          trend: 'BULLISH',
          timestamp: '2026-07-23T12:10:00Z',
        },
      }),
      productManifests: [
        indexedManifest('momo-tracker'),
        indexedManifest('early-look'),
        indexedManifest('signal-strength'),
        indexedManifest('the-macro-show', MARKET_DATE, { eventCount: 1 }),
      ],
      snapshots: [
        {
          date: MARKET_DATE,
          snapshotType: 'momo-tracker',
          publishedAt: '2026-07-23T13:00:00Z',
          data: {
            DDOG: { ...explicitTrade('DDOG', 'BEARISH'), trend: 'BULLISH', buyTrade: 135, sellTrade: 151 },
          },
        },
        {
          date: MARKET_DATE,
          snapshotType: 'early-look',
          publishedAt: '2026-07-23T11:30:00Z',
          data: {
            'DATADOG (DDOG)': { lrr: 137, hrr: 150, trend: 'NEUTRAL' },
          },
        },
        {
          date: MARKET_DATE,
          snapshotType: 'signal-strength',
          publishedAt: '2026-07-23T14:00:00Z',
          data: { added: ['DDOG'], removed: [], stocks: [{ ticker: 'DDOG' }] },
        },
      ],
      entityEvents: [
        {
          marketDate: MARKET_DATE,
          productId: 'the-macro-show',
          entityKey: 'factor#technology',
          eventType: 'factor_mention',
          excerpt: 'Software and technology leadership improved during the session.',
          publishedAt: '2026-07-23T14:15:00Z',
          sourceEventId: 'macro-1',
        },
      ],
    });

    const row = response.bySymbol.DDOG;
    expect(row.decision.trade).toMatchObject({
      status: 'available',
      value: 'BEARISH',
      sourceId: 'momo-tracker',
      sourceDate: MARKET_DATE,
    });
    expect(row.decision.trend).toMatchObject({
      status: 'available',
      value: 'BULLISH',
      sourceId: 'risk-ranges',
    });
    expect(row.decision.riskRange).toMatchObject({
      status: 'available',
      lrr: 139,
      hrr: 148,
      decisionEligible: true,
    });
    expect(row.supplementalRange).toMatchObject({
      status: 'available',
      pipelineStatus: 'indexed',
      lrr: 137,
      hrr: 150,
      decisionEligible: false,
      sourceId: 'early-look',
    });
    expect(row.decision.signalStrength).toMatchObject({
      status: 'available',
      value: 'ADDED',
    });
    expect(row.inferredReferences).toEqual(expect.arrayContaining([
      expect.objectContaining({
        matchType: 'inferred_exposure',
        exposure: 'technology',
        exposureId: 'technology',
        exposureType: 'sector',
        exposureLabel: 'Technology',
        matchedText: 'Technology',
        excerpt: 'Software and technology leadership improved during the session.',
      }),
    ]));
    expect(row.exposures).toEqual([
      expect.objectContaining({ id: 'growth', type: 'factor', label: 'Growth' }),
      expect.objectContaining({ id: 'technology', type: 'sector', label: 'Technology' }),
    ]);
    expect(row.directReferences.find((ref) => ref.kind === 'primary_risk_range'))
      .toMatchObject({ decisionEligible: true, qualityStatus: 'indexed', matchedText: 'DDOG' });
    expect(response.products.find((product) => product.id === 'the-macro-show'))
      .toMatchObject({ status: 'indexed', publishedAt: '2026-07-23T14:15:00.000Z' });
  });

  test('never promotes historical or stale publications into current decision fields', () => {
    const staleDate = '2026-07-22';
    const response = buildSecurityIntelligence({
      symbols: ['AAPL'],
      marketDate: MARKET_DATE,
      historyDays: 1,
      now: NOW,
      riskRangeEnvelope: {
        status: 'stale',
        available: false,
        ranges: {},
        manifest: {
          publicationDate: staleDate,
          persistedManifestVerified: true,
        },
      },
      productManifests: [indexedManifest('momo-tracker', staleDate)],
      snapshots: [
        {
          date: staleDate,
          snapshotType: 'momo-tracker',
          publishedAt: '2026-07-22T13:00:00Z',
          data: { AAPL: { trend: 'BULLISH', buyTrade: 210, sellTrade: 225 } },
        },
        {
          date: staleDate,
          snapshotType: 'risk-ranges',
          publishedAt: '2026-07-22T12:00:00Z',
          data: { AAPL: { lrr: 205, hrr: 229, trend: 'BEARISH' } },
        },
      ],
    });

    const row = response.bySymbol.AAPL;
    expect(row.decision.trade).toMatchObject({ status: 'unavailable', value: null });
    expect(row.decision.trend).toMatchObject({ status: 'unavailable', value: null });
    expect(row.decision.riskRange).toMatchObject({
      status: 'unavailable',
      lrr: null,
      hrr: null,
      decisionEligible: false,
    });
    expect(row.directReferences).toHaveLength(0);
    expect(row.history[0].marketDate).toBe(staleDate);
    expect(row.history[0].directReferences).toEqual(expect.arrayContaining([
      expect.objectContaining({ productId: 'momo-tracker', kind: 'trend_signal' }),
      expect.objectContaining({
        productId: 'risk-ranges',
        kind: 'historical_risk_range',
        decisionEligible: false,
      }),
    ]));
  });

  test('exposes indexed historical product events only as non-executable last-verified references', () => {
    const historicalDate = '2026-07-22';
    const response = buildSecurityIntelligence({
      symbols: ['AAPL'],
      marketDate: MARKET_DATE,
      historyDays: 1,
      now: NOW,
      productManifests: [
        indexedManifest('momo-tracker', historicalDate, { eventCount: 1 }),
        indexedManifest('signal-strength', historicalDate, { eventCount: 1 }),
        indexedManifest('the-call', historicalDate, { eventCount: 1 }),
      ],
      entityEvents: [
        {
          marketDate: historicalDate,
          productKey: 'momo-tracker',
          entityKey: 'ticker#AAPL',
          eventType: 'trade_signal',
          signalValue: 'BULLISH',
          excerpt: 'AAPL Trade BULLISH in the latest verified tracker publication.',
          publishedAt: '2026-07-22T13:00:00Z',
          sourceEventId: 'historical-momo-aapl',
        },
        {
          marketDate: historicalDate,
          productKey: 'signal-strength',
          entityKey: 'ticker#AAPL',
          eventType: 'signal_strength_removed',
          excerpt: 'AAPL was removed from Signal Strength.',
          publishedAt: '2026-07-22T14:00:00Z',
          sourceEventId: 'historical-signal-strength-aapl',
        },
        {
          marketDate: historicalDate,
          productKey: 'the-call',
          entityKey: 'ticker#AAPL',
          eventType: 'position_reference',
          direction: 'positive',
          excerpt: 'AAPL remained a long on The Call.',
          publishedAt: '2026-07-22T15:00:00Z',
          sourceEventId: 'historical-call-aapl',
        },
      ],
      riskRangeEnvelope: verifiedRiskEnvelope({}),
    });

    const row = response.bySymbol.AAPL;
    expect(row.decision.trade).toMatchObject({ status: 'unavailable', value: null });
    expect(row.decision.signalStrength).toMatchObject({ status: 'unavailable', value: null });
    expect(row.directReferences).toEqual([]);

    expect(row.lastVerifiedDecision.trade).toMatchObject({
      status: 'historical',
      value: 'BULLISH',
      sourceId: 'momo-tracker',
      sourceDate: historicalDate,
      qualityStatus: 'indexed',
      referenceOnly: true,
      executable: false,
      currentDecisionEligible: false,
    });
    expect(row.lastVerifiedDecision.signalStrength).toMatchObject({
      status: 'historical',
      value: 'REMOVED',
      sourceId: 'signal-strength',
      sourceDate: historicalDate,
      qualityStatus: 'indexed',
      referenceOnly: true,
      executable: false,
      currentDecisionEligible: false,
      changeOnly: true,
    });
    expect(response.latestVerifiedByProduct).toMatchObject({
      'momo-tracker': {
        marketDate: historicalDate,
        status: 'indexed',
        referenceOnly: true,
        executable: false,
      },
      'signal-strength': {
        marketDate: historicalDate,
        status: 'indexed',
        referenceOnly: true,
        executable: false,
      },
      'the-call': {
        marketDate: historicalDate,
        status: 'indexed',
        referenceOnly: true,
        executable: false,
      },
    });
  });

  test('does not carry parsed or otherwise unindexed historical evidence into last-verified fields', () => {
    const historicalDate = '2026-07-22';
    const response = buildSecurityIntelligence({
      symbols: ['AAPL'],
      marketDate: MARKET_DATE,
      historyDays: 1,
      now: NOW,
      productManifests: [{
        marketDate: historicalDate,
        productKey: 'momo-tracker',
        state: 'parsed',
        receivedCount: 1,
        parsedCount: 1,
        validatedCount: 0,
        indexedCount: 0,
      }],
      entityEvents: [{
        marketDate: historicalDate,
        productKey: 'momo-tracker',
        entityKey: 'ticker#AAPL',
        eventType: 'trade_signal',
        signalValue: 'BULLISH',
        excerpt: 'This historical tracker event has not completed indexing.',
        publishedAt: '2026-07-22T13:00:00Z',
        sourceEventId: 'parsed-only-historical-momo',
      }],
      riskRangeEnvelope: verifiedRiskEnvelope({}),
    });

    const row = response.bySymbol.AAPL;
    expect(row.decision.trade).toMatchObject({ status: 'unavailable', value: null });
    expect(row.lastVerifiedDecision.trade).toBeUndefined();
    expect(response.latestVerifiedByProduct['momo-tracker']).toBeUndefined();
    expect(row.history[0].directReferences).toEqual([
      expect.objectContaining({
        productId: 'momo-tracker',
        kind: 'mention',
        qualityStatus: 'parsed',
      }),
    ]);
  });

  test('parsed but unindexed tracker data remains unavailable for TRADE', () => {
    const response = buildSecurityIntelligence({
      symbols: ['AAPL'],
      marketDate: MARKET_DATE,
      historyDays: 0,
      now: NOW,
      snapshots: [{
        date: MARKET_DATE,
        snapshotType: 'momo-tracker',
        publishedAt: '2026-07-23T13:00:00Z',
        data: { AAPL: { trend: 'BULLISH', buyTrade: 210, sellTrade: 225 } },
      }],
      riskRangeEnvelope: verifiedRiskEnvelope({}),
    });

    expect(response.bySymbol.AAPL.decision.trade).toMatchObject({
      status: 'unavailable',
      value: null,
      reason: 'no-verified-published-trade-signal',
    });
    expect(response.bySymbol.AAPL.directReferences[0]).toMatchObject({
      productId: 'momo-tracker',
      qualityStatus: 'parsed',
    });
    expect(response.coverage.state).toBe('partial');
    expect(response.products.find((product) => product.id === 'momo-tracker').status).toBe('parsed');
  });

  test('does not let an indexed PDF candidate satisfy the primary Risk Range gate', () => {
    const response = buildSecurityIntelligence({
      symbols: ['SPY'],
      marketDate: MARKET_DATE,
      historyDays: 0,
      now: NOW,
      productManifests: [
        indexedManifest('risk-ranges', MARKET_DATE, { eventCount: 1 }),
      ],
      entityEvents: [{
        marketDate: MARKET_DATE,
        productKey: 'risk-ranges',
        entityKey: 'ticker#SPY',
        eventType: 'risk_range',
        excerpt: 'SPY candidate LRR 6200 – HRR 6300',
        publishedAt: '2026-07-23T12:00:00Z',
        sourceEventId: 'risk-pdf-candidate',
        decisionEligible: false,
      }],
      riskRangeEnvelope: {
        status: 'failed',
        available: false,
        ranges: {},
        manifest: {
          publicationDate: MARKET_DATE,
          persistedManifestVerified: false,
        },
        diagnostics: { manifestReasons: ['manifest-missing'] },
      },
    });

    expect(response.products.find((product) => product.id === 'risk-ranges')).toMatchObject({
      status: 'validated',
      error: 'primary-risk-range-manifest-unverified',
    });
    expect(response.coverage.state).toBe('partial');
    expect(response.bySymbol.SPY.decision.trend.status).toBe('unavailable');
    expect(response.bySymbol.SPY.decision.riskRange).toMatchObject({
      status: 'unavailable',
      decisionEligible: false,
    });
  });

  test('rejects legacy immutable tracker events that relabeled a Trend as Trade', () => {
    const response = buildSecurityIntelligence({
      symbols: ['AAPL'],
      marketDate: MARKET_DATE,
      historyDays: 0,
      now: NOW,
      productManifests: [indexedManifest('momo-tracker', MARKET_DATE, { eventCount: 1 })],
      entityEvents: [{
        marketDate: MARKET_DATE,
        productKey: 'momo-tracker',
        entityKey: 'ticker#AAPL',
        eventType: 'trade_signal',
        direction: 'positive',
        signalValue: 'BULLISH',
        excerpt: 'AAPL: {"trend":"BULLISH","buyTrade":210,"sellTrade":225}',
        publishedAt: '2026-07-23T13:00:00Z',
        sourceEventId: 'momo-event-1',
        qualityStatus: 'validated',
      }],
      riskRangeEnvelope: verifiedRiskEnvelope({}),
    });

    expect(response.bySymbol.AAPL.decision.trade).toMatchObject({
      status: 'unavailable',
      value: null,
      sourceId: null,
    });
    expect(response.bySymbol.AAPL.directReferences[0].qualityStatus).toBe('indexed');
  });

  test('rejects an indexed label when manifest counts do not match visible events', () => {
    const manifest = {
      ...indexedManifest('momo-tracker', MARKET_DATE, { eventCount: 2 }),
    };
    const response = buildSecurityIntelligence({
      symbols: ['AAPL'],
      marketDate: MARKET_DATE,
      historyDays: 0,
      now: NOW,
      productManifests: [manifest],
      entityEvents: [{
        marketDate: MARKET_DATE,
        productKey: 'momo-tracker',
        entityKey: 'ticker#AAPL',
        eventType: 'trade_signal',
        direction: 'positive',
        excerpt: 'AAPL Trade BULLISH',
        sourceEventId: 'only-visible-event',
      }],
      riskRangeEnvelope: verifiedRiskEnvelope({}),
    });

    expect(response.products.find((product) => product.id === 'momo-tracker')).toMatchObject({
      status: 'failed',
      error: 'manifest-event-count-mismatch',
    });
    expect(response.bySymbol.AAPL.decision.trade.status).toBe('unavailable');
    expect(response.coverage.state).toBe('partial');
  });

  test('rejects an indexed manifest whose artifact checksum does not verify', () => {
    const manifest = indexedManifest('momo-tracker');
    manifest.artifacts[0].contentSha256 = 'tampered-after-checksum';
    const response = buildSecurityIntelligence({
      symbols: ['AAPL'],
      marketDate: MARKET_DATE,
      historyDays: 0,
      now: NOW,
      productManifests: [manifest],
      snapshots: [{
        date: MARKET_DATE,
        snapshotType: 'momo-tracker',
        data: { AAPL: { trend: 'BULLISH' } },
      }],
      riskRangeEnvelope: verifiedRiskEnvelope({}),
    });

    expect(response.products.find((product) => product.id === 'momo-tracker')).toMatchObject({
      status: 'failed',
      error: 'manifest-checksum-mismatch',
    });
    expect(response.bySymbol.AAPL.decision.trade.status).toBe('unavailable');
  });

  test('fails closed when two indexed tracker publications conflict', () => {
    const response = buildSecurityIntelligence({
      symbols: ['AAPL'],
      marketDate: MARKET_DATE,
      historyDays: 0,
      now: NOW,
      snapshots: [
        {
          date: MARKET_DATE,
          snapshotType: 'momo-tracker',
          data: { AAPL: explicitTrade('AAPL', 'BULLISH') },
        },
        {
          date: MARKET_DATE,
          snapshotType: 'bitcoin-trend-tracker',
          data: { stocks: { AAPL: explicitTrade('AAPL', 'BEARISH') } },
        },
      ],
      productManifests: [
        indexedManifest('momo-tracker'),
        indexedManifest('bitcoin-trend-tracker'),
      ],
      riskRangeEnvelope: verifiedRiskEnvelope({}),
    });

    expect(response.bySymbol.AAPL.decision.trade).toMatchObject({
      status: 'conflict',
      value: null,
      reason: 'conflicting-published-trade-signals',
    });
  });

  test('requires an explicit tracker signal value and never promotes narrative direction', () => {
    const response = buildSecurityIntelligence({
      symbols: ['AAPL'],
      marketDate: MARKET_DATE,
      historyDays: 0,
      now: NOW,
      productManifests: [
        indexedManifest('momo-tracker', MARKET_DATE, { eventCount: 1 }),
      ],
      entityEvents: [{
        marketDate: MARKET_DATE,
        productKey: 'momo-tracker',
        entityKey: 'ticker#AAPL',
        eventType: 'trade_signal',
        direction: 'positive',
        excerpt: 'AAPL was mentioned positively in tracker commentary.',
        publishedAt: '2026-07-23T13:00:00Z',
        sourceEventId: 'momo-narrative-only',
      }],
      riskRangeEnvelope: verifiedRiskEnvelope({}),
    });

    expect(response.bySymbol.AAPL.decision.trade).toMatchObject({
      status: 'unavailable',
      value: null,
      reason: 'no-verified-published-trade-signal',
    });
    expect(response.bySymbol.AAPL.directReferences[0]).toMatchObject({
      qualityStatus: 'indexed',
      direction: 'POSITIVE',
    });
  });

  test('uses the latest immutable publication within one tracker and preserves both references', () => {
    const response = buildSecurityIntelligence({
      symbols: ['AAPL'],
      marketDate: MARKET_DATE,
      historyDays: 0,
      now: NOW,
      productManifests: [
        indexedManifest('momo-tracker', MARKET_DATE, {
          artifactCount: 2,
          eventCount: 2,
        }),
      ],
      entityEvents: [
        {
          marketDate: MARKET_DATE,
          productKey: 'momo-tracker',
          entityKey: 'ticker#AAPL',
          eventType: 'trade_signal',
          signalValue: 'BULLISH',
          excerpt: 'AAPL Trade BULLISH in the morning publication.',
          publishedAt: '2026-07-23T13:00:00Z',
          sourceEventId: 'momo-morning',
        },
        {
          marketDate: MARKET_DATE,
          productKey: 'momo-tracker',
          entityKey: 'ticker#AAPL',
          eventType: 'trade_signal',
          signalValue: 'BEARISH',
          excerpt: 'AAPL Trade BEARISH in the afternoon publication.',
          publishedAt: '2026-07-23T18:00:00Z',
          sourceEventId: 'momo-afternoon',
        },
      ],
      riskRangeEnvelope: verifiedRiskEnvelope({}),
    });

    expect(response.bySymbol.AAPL.decision.trade).toMatchObject({
      status: 'available',
      value: 'BEARISH',
      publishedAt: '2026-07-23T18:00:00Z',
    });
    expect(response.bySymbol.AAPL.directReferences).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceEventId: 'momo-morning' }),
      expect.objectContaining({ sourceEventId: 'momo-afternoon' }),
    ]));
  });

  test('normalizes immutable Signal Strength kinds to ADDED and REMOVED', () => {
    const response = buildSecurityIntelligence({
      symbols: ['AAPL'],
      marketDate: MARKET_DATE,
      historyDays: 0,
      now: NOW,
      productManifests: [
        indexedManifest('signal-strength', MARKET_DATE, {
          artifactCount: 2,
          eventCount: 2,
        }),
      ],
      entityEvents: [
        {
          marketDate: MARKET_DATE,
          productKey: 'signal-strength',
          entityKey: 'ticker#AAPL',
          eventType: 'signal_strength_added',
          direction: 'positive',
          excerpt: 'AAPL added to Signal Strength.',
          publishedAt: '2026-07-23T13:00:00Z',
          sourceEventId: 'signal-add',
        },
        {
          marketDate: MARKET_DATE,
          productKey: 'signal-strength',
          entityKey: 'ticker#AAPL',
          eventType: 'signal_strength_removed',
          direction: 'negative',
          excerpt: 'AAPL removed from Signal Strength.',
          publishedAt: '2026-07-23T18:00:00Z',
          sourceEventId: 'signal-remove',
        },
      ],
      riskRangeEnvelope: verifiedRiskEnvelope({}),
    });

    expect(response.bySymbol.AAPL.decision.signalStrength).toMatchObject({
      status: 'available',
      value: 'REMOVED',
      publishedAt: '2026-07-23T18:00:00Z',
    });
  });

  test('fails closed on conflicting Signal Strength events with the same publication time', () => {
    const response = buildSecurityIntelligence({
      symbols: ['AAPL'],
      marketDate: MARKET_DATE,
      historyDays: 0,
      now: NOW,
      productManifests: [
        indexedManifest('signal-strength', MARKET_DATE, {
          artifactCount: 2,
          eventCount: 2,
        }),
      ],
      entityEvents: [
        {
          marketDate: MARKET_DATE,
          productKey: 'signal-strength',
          entityKey: 'ticker#AAPL',
          eventType: 'signal_strength_added',
          excerpt: 'AAPL added to Signal Strength.',
          publishedAt: '2026-07-23T13:00:00Z',
          sourceEventId: 'signal-add-conflict',
        },
        {
          marketDate: MARKET_DATE,
          productKey: 'signal-strength',
          entityKey: 'ticker#AAPL',
          eventType: 'signal_strength_removed',
          excerpt: 'AAPL removed from Signal Strength.',
          publishedAt: '2026-07-23T13:00:00Z',
          sourceEventId: 'signal-remove-conflict',
        },
      ],
      riskRangeEnvelope: verifiedRiskEnvelope({}),
    });

    expect(response.bySymbol.AAPL.decision.signalStrength).toMatchObject({
      status: 'conflict',
      value: null,
      reason: 'conflicting-signal-strength-events',
    });
  });

  test('grades historical references against their own dated manifest', () => {
    const historicalDate = '2026-07-22';
    const response = buildSecurityIntelligence({
      symbols: ['AAPL'],
      marketDate: MARKET_DATE,
      historyDays: 1,
      now: NOW,
      productManifests: [
        indexedManifest('the-call', historicalDate, { eventCount: 1 }),
      ],
      entityEvents: [{
        marketDate: historicalDate,
        productKey: 'the-call',
        entityKey: 'ticker#AAPL',
        eventType: 'position_reference',
        direction: 'positive',
        excerpt: 'AAPL was a long on the prior day call.',
        publishedAt: '2026-07-22T14:00:00Z',
        sourceEventId: 'call-history',
      }],
      riskRangeEnvelope: verifiedRiskEnvelope({}),
    });

    expect(response.bySymbol.AAPL.directReferences).toEqual([]);
    expect(response.bySymbol.AAPL.history[0].directReferences[0]).toMatchObject({
      marketDate: historicalDate,
      qualityStatus: 'indexed',
      sourceEventId: 'call-history',
    });
  });

  test('canonicalizes legacy factor events to typed exposures and labels the match inferred', () => {
    const response = buildSecurityIntelligence({
      symbols: ['DDOG'],
      marketDate: MARKET_DATE,
      historyDays: 0,
      now: NOW,
      productManifests: [
        indexedManifest('the-macro-show', MARKET_DATE, { eventCount: 1 }),
      ],
      entityEvents: [{
        marketDate: MARKET_DATE,
        productKey: 'the-macro-show',
        entityKey: 'factor#software',
        eventType: 'factor_mention',
        excerpt: 'Software leadership strengthened through the session.',
        publishedAt: '2026-07-23T15:00:00Z',
        sourceEventId: 'macro-software',
      }],
      riskRangeEnvelope: verifiedRiskEnvelope({}),
    });

    expect(response.bySymbol.DDOG.inferredReferences[0]).toMatchObject({
      matchType: 'inferred_exposure',
      exposure: 'technology',
      exposureId: 'technology',
      exposureType: 'sector',
      qualityStatus: 'indexed',
    });
  });

  test('projects every controlled exposure type and leaves unmapped securities direct-only', () => {
    const events = [
      ['factor#growth', 'factor', 'growth', 'Growth leadership improved.'],
      ['sector#technology', 'sector', 'technology', 'Technology leadership improved.'],
      ['country#united-states', 'country', 'united-states', 'United States equities improved.'],
      ['commodity#gold', 'commodity', 'gold', 'Gold  held its breakout.\nExact source line.'],
      ['commodity#crude-oil', 'commodity', 'crude-oil', 'Crude oil weakened.'],
      ['macro#us-dollar', 'macro', 'us-dollar', 'The U.S. dollar strengthened.'],
    ].map(([entityKey, exposureType, exposureId, excerpt], index) => ({
      marketDate: MARKET_DATE,
      productKey: 'the-macro-show',
      entityKey,
      exposureType,
      exposureId,
      eventType: `${exposureType}_mention`,
      excerpt,
      publishedAt: `2026-07-23T15:0${index}:00Z`,
      sourceEventId: `typed-exposure-${index}`,
    }));
    events.push({
      marketDate: MARKET_DATE,
      productKey: 'the-macro-show',
      entityKey: 'ticker#AAPL',
      eventType: 'mention',
      excerpt: 'AAPL was mentioned directly.',
      publishedAt: '2026-07-23T15:06:00Z',
      sourceEventId: 'direct-aapl',
    });
    const response = buildSecurityIntelligence({
      symbols: ['DDOG', 'GLD', 'SPY', 'USO', 'UUP', 'AAPL'],
      marketDate: MARKET_DATE,
      historyDays: 0,
      now: NOW,
      productManifests: [
        indexedManifest('the-macro-show', MARKET_DATE, { eventCount: events.length }),
      ],
      entityEvents: events,
      riskRangeEnvelope: verifiedRiskEnvelope({}),
    });

    expect(response.bySymbol.DDOG.inferredReferences).toEqual(expect.arrayContaining([
      expect.objectContaining({
        exposureId: 'growth',
        exposureType: 'factor',
        excerpt: 'Growth leadership improved.',
        matchType: 'inferred_exposure',
      }),
      expect.objectContaining({
        exposureId: 'technology',
        exposureType: 'sector',
        excerpt: 'Technology leadership improved.',
        matchType: 'inferred_exposure',
      }),
    ]));
    expect(response.bySymbol.GLD.inferredReferences[0]).toMatchObject({
      exposure: 'gold',
      exposureId: 'gold',
      exposureType: 'commodity',
      exposureLabel: 'Gold',
      excerpt: 'Gold  held its breakout.\nExact source line.',
    });
    expect(response.bySymbol.GLD.exposures).toEqual([
      { id: 'low-beta', type: 'factor', label: 'Low Beta' },
      { id: 'defensive', type: 'factor', label: 'Defensives' },
      { id: 'gold', type: 'commodity', label: 'Gold' },
    ]);
    expect(response.bySymbol.SPY.inferredReferences[0]).toMatchObject({
      exposureId: 'united-states',
      exposureType: 'country',
    });
    expect(response.bySymbol.USO.inferredReferences[0]).toMatchObject({
      exposureId: 'crude-oil',
      exposureType: 'commodity',
    });
    expect(response.bySymbol.UUP.inferredReferences[0]).toMatchObject({
      exposureId: 'us-dollar',
      exposureType: 'macro',
    });
    expect(response.bySymbol.AAPL.exposures).toEqual([]);
    expect(response.bySymbol.AAPL.inferredReferences).toEqual([]);
    expect(response.bySymbol.AAPL.directReferences).toEqual([
      expect.objectContaining({
        excerpt: 'AAPL was mentioned directly.',
        matchType: 'direct',
      }),
    ]);
  });

  test('surfaces unsupported observed products as failed instead of dropping them', () => {
    const response = buildSecurityIntelligence({
      symbols: ['AAPL'],
      marketDate: MARKET_DATE,
      historyDays: 0,
      now: NOW,
      entityEvents: [{
        marketDate: MARKET_DATE,
        productKey: 'unknown-daily-product',
        entityKey: 'ticker#AAPL',
        eventType: 'mention',
        excerpt: 'AAPL appeared in an unregistered daily product.',
        publishedAt: '2026-07-23T15:00:00Z',
        sourceEventId: 'unknown-product-event',
      }],
      riskRangeEnvelope: verifiedRiskEnvelope({}),
    });

    expect(response.products).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'unknown-daily-product',
        status: 'failed',
        error: 'unsupported-product',
      }),
    ]));
    expect(response.coverage.state).toBe('partial');
    expect(response.bySymbol.AAPL.directReferences[0].qualityStatus).toBe('failed');
  });

  test('accepts AM and PM from typed snapshot rows but never from meridiem prose', () => {
    const narrativeSnapshots = [
      {
        date: MARKET_DATE,
        snapshotType: 'signal-strength',
        publishedAt: '2026-07-23T16:29:00Z',
        article: {
          bodyText: 'View it in your browser 07/23/2026 12:29 PM EDT Signal Strength Stocks.',
        },
        data: { added: ['AFRM'], removed: [] },
      },
      {
        date: MARKET_DATE,
        snapshotType: 'real-time-alert',
        publishedAt: '2026-07-23T12:00:00Z',
        article: { bodyText: 'The alert was distributed at 08:00 AM EDT.' },
        data: {},
      },
      {
        date: MARKET_DATE,
        snapshotType: 'etf-pro',
        publishedAt: '2026-07-23T18:05:00Z',
        article: { bodyText: '07/23/2026 02:05 PM EDT ETF Pro Plus.' },
        data: {},
      },
    ];
    const narrativeReferences = narrativeSnapshots.flatMap((snapshot) => (
      extractSnapshotReferences(snapshot, ['AM', 'PM'], 'indexed')
    ));
    expect(narrativeReferences).toEqual([]);

    const structuredSnapshots = [
      {
        date: MARKET_DATE,
        snapshotType: 'signal-strength',
        publishedAt: '2026-07-23T14:00:00Z',
        data: { added: ['PM'], removed: ['AM'] },
      },
      {
        date: MARKET_DATE,
        snapshotType: 'portfolio-solutions',
        publishedAt: '2026-07-23T15:00:00Z',
        data: { rankings: [{ ticker: 'PM', rank: 4 }, { ticker: 'AM', rank: 7 }] },
      },
      {
        date: MARKET_DATE,
        snapshotType: 'early-look',
        publishedAt: '2026-07-23T11:30:00Z',
        data: {
          PM: { lrr: 181, hrr: 202, trend: 'BULLISH' },
          AM: { lrr: 17, hrr: 19, trend: 'NEUTRAL' },
        },
      },
      {
        date: MARKET_DATE,
        snapshotType: 'investing-ideas',
        publishedAt: '2026-07-23T16:00:00Z',
        data: {
          positions: [
            { ticker: 'PM', side: 'Long', prevClose: 189.57, lrr: 182, hrr: 201 },
            { ticker: 'AM', side: 'Short', prevClose: 18.4, lrr: 17, hrr: 19 },
          ],
        },
      },
    ];
    const structuredReferences = structuredSnapshots.flatMap((snapshot) => (
      extractSnapshotReferences(snapshot, ['AM', 'PM'], 'indexed')
    ));
    const kindsFor = (symbol) => structuredReferences
      .filter((entry) => entry.symbol === symbol)
      .map((entry) => entry.reference.kind);

    expect(kindsFor('PM')).toEqual(expect.arrayContaining([
      'signal_strength_added',
      'portfolio_solutions_rank',
      'supplemental_risk_range',
      'investing_idea_position',
    ]));
    expect(kindsFor('AM')).toEqual(expect.arrayContaining([
      'signal_strength_removed',
      'portfolio_solutions_rank',
      'supplemental_risk_range',
      'investing_idea_position',
    ]));
    expect(structuredReferences.find((entry) => (
      entry.symbol === 'PM' && entry.reference.kind === 'investing_idea_position'
    )).reference.value).toMatchObject({
      side: 'LONG',
      bias: 'BULLISH',
      lrr: 182,
      hrr: 201,
    });
    expect(structuredReferences.some((entry) => entry.reference.kind === 'summary_mention')).toBe(false);
  });

  test('ignores legacy prose events for AM and PM in current and historical rows', () => {
    const historicalDate = '2026-07-22';
    const response = buildSecurityIntelligence({
      symbols: ['AM', 'PM'],
      marketDate: MARKET_DATE,
      historyDays: 1,
      now: NOW,
      productManifests: [
        indexedManifest('signal-strength', MARKET_DATE, { eventCount: 4 }),
        indexedManifest('signal-strength', historicalDate, { eventCount: 2 }),
      ],
      entityEvents: [
        {
          marketDate: MARKET_DATE,
          productKey: 'signal-strength',
          entityKey: 'ticker#PM',
          eventType: 'signal_strength_membership',
          matchType: 'explicit_ticker',
          matchedText: 'PM',
          fieldPath: 'article.bodyText',
          excerpt: 'View it in your browser 07/23/2026 12:29 PM EDT.',
          publishedAt: '2026-07-23T16:29:00Z',
          sourceEventId: 'pm-time-current',
        },
        {
          marketDate: MARKET_DATE,
          productKey: 'signal-strength',
          entityKey: 'ticker#AM',
          eventType: 'signal_strength_membership',
          matchType: 'explicit_ticker',
          matchedText: 'AM',
          fieldPath: 'article.bodyText',
          excerpt: 'The morning edition was delivered at 08:00 AM EDT.',
          publishedAt: '2026-07-23T12:00:00Z',
          sourceEventId: 'am-time-current',
        },
        {
          marketDate: MARKET_DATE,
          productKey: 'signal-strength',
          entityKey: 'ticker#PM',
          eventType: 'signal_strength_added',
          matchType: 'structured_membership',
          matchedText: 'PM',
          fieldPath: 'data.added[0]',
          excerpt: 'PM',
          publishedAt: '2026-07-23T14:00:00Z',
          sourceEventId: 'pm-structured-current',
        },
        {
          marketDate: MARKET_DATE,
          productKey: 'signal-strength',
          entityKey: 'ticker#AM',
          eventType: 'signal_strength_removed',
          matchType: 'structured_membership',
          matchedText: 'AM',
          fieldPath: 'data.removed[0]',
          excerpt: 'AM',
          publishedAt: '2026-07-23T14:00:00Z',
          sourceEventId: 'am-structured-current',
        },
        {
          marketDate: historicalDate,
          productKey: 'signal-strength',
          entityKey: 'ticker#PM',
          eventType: 'signal_strength_membership',
          matchType: 'explicit_ticker',
          excerpt: '07/22/2026 03:36 PM EDT.',
          publishedAt: '2026-07-22T19:36:00Z',
          sourceEventId: 'pm-time-history',
        },
        {
          marketDate: historicalDate,
          productKey: 'signal-strength',
          entityKey: 'ticker#AM',
          eventType: 'signal_strength_membership',
          matchType: 'explicit_ticker',
          excerpt: '07/22/2026 08:00 AM EDT.',
          publishedAt: '2026-07-22T12:00:00Z',
          sourceEventId: 'am-time-history',
        },
      ],
      riskRangeEnvelope: verifiedRiskEnvelope({}),
    });

    expect(response.bySymbol.PM.directReferences.map((reference) => reference.sourceEventId))
      .toEqual(['pm-structured-current']);
    expect(response.bySymbol.AM.directReferences.map((reference) => reference.sourceEventId))
      .toEqual(['am-structured-current']);
    expect(response.bySymbol.PM.history[0].directReferences).toEqual([]);
    expect(response.bySymbol.AM.history[0].directReferences).toEqual([]);
    expect(response.bySymbol.PM.decision.signalStrength).toMatchObject({
      status: 'available',
      value: 'ADDED',
    });
    expect(response.bySymbol.AM.decision.signalStrength).toMatchObject({
      status: 'available',
      value: 'REMOVED',
    });
  });

  test('matches controlled ticker aliases without creating inferred market data', () => {
    const response = buildSecurityIntelligence({
      symbols: ['SPY'],
      marketDate: MARKET_DATE,
      historyDays: 0,
      now: NOW,
      riskRangeEnvelope: verifiedRiskEnvelope({
        SPX: { lrr: 7400, hrr: 7550, trend: 'NEUTRAL' },
      }),
    });

    expect(canonicalizeSymbol('SPX')).toBe('SPY');
    expect(response.bySymbol.SPY.canonicalSymbol).toBe('SPY');
    expect(response.bySymbol.SPY.decision.riskRange).toMatchObject({
      status: 'available',
      lrr: 7400,
      hrr: 7550,
    });
    expect(response.bySymbol.SPY.directReferences[0].matchType).toBe('direct_alias');
  });

  test('reports loader failures explicitly instead of preserving old values', () => {
    const response = buildSecurityIntelligence({
      symbols: ['AAPL'],
      marketDate: MARKET_DATE,
      historyDays: 0,
      now: NOW,
      loadErrors: {
        snapshots: 'AccessDeniedException',
        entityEvents: 'ResourceNotFoundException',
        productManifests: 'ResourceNotFoundException',
        riskRangeEnvelope: 'AccessDeniedException',
      },
    });

    expect(response.coverage.state).toBe('unavailable');
    expect(response.bySymbol.AAPL.state).toBe('unavailable');
    expect(response.bySymbol.AAPL.decision.trade).toMatchObject({
      status: 'unavailable',
      value: null,
    });
    expect(response.bySymbol.AAPL.directReferences).toEqual([]);
  });

  test('keeps deterministic date and request normalization bounded', () => {
    expect(marketDateSequence(MARKET_DATE, 5)).toEqual([
      '2026-07-23',
      '2026-07-22',
      '2026-07-21',
      '2026-07-20',
      '2026-07-17',
      '2026-07-16',
    ]);
    expect(defaultResearchMarketDate(new Date('2026-07-26T18:00:00Z'))).toBe('2026-07-24');
    expect(normalizeRequestedSymbols([' aapl ', 'AAPL', 'bad ticker'])).toEqual(['AAPL']);
    expect(isValidMarketDate('2026-07-23')).toBe(true);
    expect(isValidMarketDate('2026-99-99')).toBe(false);
  });
});

describe('security intelligence bulk loaders', () => {
  test('batch-loads snapshot keys and retries unprocessed keys', async () => {
    const batchGet = jest
      .fn()
      .mockReturnValueOnce({
        promise: async () => ({
          Responses: { HedgeyeDailySnapshot: [{ date: MARKET_DATE, snapshotType: 'risk-ranges' }] },
          UnprocessedKeys: {
            HedgeyeDailySnapshot: {
              Keys: [{ date: MARKET_DATE, snapshotType: 'early-look' }],
            },
          },
        }),
      })
      .mockReturnValueOnce({
        promise: async () => ({
          Responses: { HedgeyeDailySnapshot: [{ date: MARKET_DATE, snapshotType: 'early-look' }] },
        }),
      });

    const rows = await batchGetSnapshots({ batchGet }, [MARKET_DATE], {
      snapshotTypes: ['risk-ranges', 'early-look'],
    });
    expect(batchGet).toHaveBeenCalledTimes(2);
    expect(rows).toHaveLength(2);
  });

  test('isolates missing projection tables as explicit load errors', async () => {
    const dynamodb = {
      batchGet: jest.fn(() => ({
        promise: async () => ({ Responses: { HedgeyeDailySnapshot: [] } }),
      })),
      query: jest.fn((params) => ({
        promise: async () => {
          if (params.TableName === 'ResearchEntityEventsV1') {
            const error = new Error('missing');
            error.code = 'ResourceNotFoundException';
            throw error;
          }
          return { Items: [] };
        },
      })),
    };
    const inputs = await loadSecurityIntelligenceInputs({
      dynamodb,
      marketDate: MARKET_DATE,
      historyDays: 0,
      now: NOW,
      riskRangeLoader: async () => verifiedRiskEnvelope({}),
    });

    expect(inputs.snapshots).toEqual([]);
    expect(inputs.entityEvents).toEqual([]);
    expect(inputs.productManifests).toEqual([]);
    expect(inputs.loadErrors).toEqual({
      entityEvents: 'ResourceNotFoundException',
    });
    expect(dynamodb.query).toHaveBeenCalledWith(expect.objectContaining({
      TableName: 'ResearchEntityEventsV1',
      IndexName: 'marketDate-index',
    }));
  });
});
