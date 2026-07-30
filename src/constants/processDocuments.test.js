import {
  PROCESS_DOCUMENTS,
  PROCESS_METHOD_DOCUMENTS,
  PROCESS_METHOD_IDS,
  PROCESS_RULES,
  PUBLISHED_PROCESS_DOCUMENTS,
  assertValidProcessRegistry,
  getProcessChildDocuments,
  getProcessDocument,
  getProcessDocumentByRoute,
  getProcessMethodDocuments,
  getPublishedProcessDocuments,
  getProcessRule,
  validateProcessRegistry,
} from './processDocuments';

const cloneRegistry = () => ({
  documents: JSON.parse(JSON.stringify(PROCESS_DOCUMENTS)),
  rules: JSON.parse(JSON.stringify(PROCESS_RULES)),
});

describe('process document and rule registry', () => {
  test('publishes the Process library at addressable routes', () => {
    expect(PUBLISHED_PROCESS_DOCUMENTS.map(({ id }) => id)).toEqual([
      'the-process',
      'methods-index',
      'signals-and-risk-ranges',
      'position-sizing',
      'stops-exits-and-reversals',
      'macro-regime-and-quad-overlay',
      'security-selection-and-pods',
      'portfolio-construction-and-diversification',
      'data-controls-and-execution',
      'validation-and-change-control',
    ]);
    expect(getPublishedProcessDocuments()).toBe(PUBLISHED_PROCESS_DOCUMENTS);
    expect(getProcessDocument('the-process')).toEqual(expect.objectContaining({
      route: '#/process',
      type: 'master',
      section: 'process',
      parentId: null,
      editable: true,
      version: '0.1',
      status: 'Draft',
      asOf: '2026-07-27',
    }));
    expect(getProcessDocumentByRoute('#/process/methods')).toEqual(
      expect.objectContaining({ id: 'methods-index', type: 'index' }),
    );
    expect(getProcessDocumentByRoute('#/process/principles')).toBeNull();
    expect(getProcessDocumentByRoute('#/process/playbook')).toBeNull();
    expect(getProcessDocumentByRoute('#/process/methods/position-sizing')).toEqual(
      expect.objectContaining({
        id: 'position-sizing',
        type: 'method',
        parentId: 'methods-index',
        editable: true,
        version: '1.1',
        status: 'Canonical',
      }),
    );
    expect(getProcessDocument('the-process').dependencies).toContainEqual({
      documentId: 'position-sizing',
      version: '1.1',
    });
  });

  test('registers all eight supporting Methods under the Methods index', () => {
    expect(PROCESS_METHOD_IDS).toHaveLength(8);
    expect(PROCESS_METHOD_DOCUMENTS.map(({ id }) => id)).toEqual(PROCESS_METHOD_IDS);
    expect(getProcessMethodDocuments()).toBe(PROCESS_METHOD_DOCUMENTS);
    expect(getProcessChildDocuments('methods-index').map(({ id }) => id)).toEqual(PROCESS_METHOD_IDS);

    PROCESS_METHOD_DOCUMENTS.forEach((document) => {
      expect(document).toEqual(expect.objectContaining({
        type: 'method',
        section: 'methods',
        parentId: 'methods-index',
        published: true,
      }));
      expect(document.route).toBe(`#/process/methods/${document.id}`);
      expect(typeof document.editable).toBe('boolean');
    });

    expect(getProcessDocument('security-selection-and-pods')).toMatchObject({
      status: 'Deferred',
      published: true,
      route: '#/process/methods/security-selection-and-pods',
    });
  });

  test('records the approved signal durations and asymmetric lifecycle precedence', () => {
    expect(getProcessRule('signal.trade.duration').parameters.maximumDurationWeeks).toBe(3);
    expect(getProcessRule('signal.trend.duration').parameters.minimumDurationMonths).toBe(3);

    const trendBreak = getProcessRule('lifecycle.trend_break_trade_holds');
    const tradeBreak = getProcessRule('lifecycle.trade_break');
    expect(trendBreak.parameters).toMatchObject({
      condition: { trend: 'broken', trade: 'aligned' },
      target: 'MIN',
    });
    expect(tradeBreak.parameters).toMatchObject({
      condition: { trade: 'broken' },
      target: 'ZERO',
    });
    expect(tradeBreak.parameters.precedence).toBeGreaterThan(trendBreak.parameters.precedence);
  });

  test('keeps unresolved mechanisms research-only', () => {
    [
      'signal.tail.authority',
      'macro.quad.authority',
      'risk.hard_stop.policy',
      'portfolio.limits',
      'selection.pods',
    ].forEach((id) => {
      expect(getProcessRule(id)).toEqual(expect.objectContaining({
        status: 'research',
        parameters: { authority: 'unresolved' },
      }));
    });
  });

  test('assigns canonical rules to the Method that defines them', () => {
    expect(getProcessDocument('signals-and-risk-ranges').canonicalRuleIds).toEqual(expect.arrayContaining([
      'signal.trade.duration',
      'signal.trend.duration',
      'data.signal_independence',
      'entry.long.range_half',
      'entry.short.range_half',
      'range.normalization',
      'structure.directional_streaks',
      'record.extension',
    ]));
    expect(getProcessDocument('stops-exits-and-reversals').canonicalRuleIds).toEqual([
      'lifecycle.trend_break_trade_holds',
      'lifecycle.trade_break',
      'lifecycle.reversal',
    ]);
    expect(getProcessDocument('position-sizing').canonicalRuleIds).toEqual(expect.arrayContaining([
      'risk.beta_band',
      'risk.atr_cap',
      'sizing.conviction',
      'sizing.target_rounding',
      'lifecycle.open_at_min',
      'lifecycle.incremental_steps',
      'data.optional_strength_missing',
    ]));
    expect(getProcessDocument('data-controls-and-execution').canonicalRuleIds).toEqual([
      'data.execution_gate',
    ]);
    expect(getProcessRule('signal.trade.duration')).toMatchObject({
      ownerDocumentId: 'signals-and-risk-ranges',
      ownerVersion: '0.1',
    });
    expect(getProcessRule('lifecycle.trade_break')).toMatchObject({
      ownerDocumentId: 'stops-exits-and-reversals',
      ownerVersion: '0.1',
    });
    expect(getProcessRule('risk.beta_band')).toMatchObject({
      ownerDocumentId: 'position-sizing',
      ownerVersion: '1.1',
    });
    expect(getProcessRule('sizing.conviction').parameters).toEqual({
      range: 0.2,
      structure: 0.3,
      record: 0.5,
    });
    expect(getProcessRule('lifecycle.incremental_steps').parameters).toMatchObject({
      normalStepPct: 0.5,
      acceleratedStepPct: 1,
      minimumAcceleratedStreak: 3,
    });
    expect(getProcessRule('data.execution_gate').parameters).toMatchObject({
      provider: 'IBKR',
      researchProvenanceRequired: true,
      instrumentVerificationRequired: true,
      readOnly: true,
      orderTransmissionAllowed: false,
    });
  });

  test('validates the canonical registry', () => {
    expect(validateProcessRegistry()).toEqual({ valid: true, errors: [] });
    expect(assertValidProcessRegistry()).toBe(true);
  });

  test('rejects route collisions and missing dependency versions', () => {
    const { documents, rules } = cloneRegistry();
    documents[1].route = documents[0].route;
    documents[0].dependencies
      .find(({ documentId }) => documentId === 'position-sizing')
      .version = '9.9';

    const result = validateProcessRegistry(documents, rules);
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      'Duplicate document route: #/process',
      'Document the-process requires position-sizing v9.9, but the registry contains v1.1.',
    ]));
  });

  test('rejects missing hierarchy metadata and invalid Method parents', () => {
    const { documents, rules } = cloneRegistry();
    delete documents.find(({ id }) => id === 'the-process').editable;
    documents.find(({ id }) => id === 'position-sizing').parentId = 'the-process';

    const result = validateProcessRegistry(documents, rules);
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      'Document the-process is missing hierarchy metadata.',
      'Method position-sizing must belong to the Methods index.',
    ]));
  });

  test('rejects duplicate canonical ownership and canonical claims for research rules', () => {
    const { documents, rules } = cloneRegistry();
    documents[0].canonicalRuleIds.push('signal.trade.duration');
    documents[0].canonicalRuleIds.push('signal.tail.authority');

    const result = validateProcessRegistry(documents, rules);
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      'Canonical rule signal.trade.duration must have exactly one canonical owner; found 2.',
      'research rule signal.tail.authority cannot be presented as canonical.',
    ]));
  });

  test('rejects lifecycle, entry terminology, and ATR-role drift', () => {
    const { documents, rules } = cloneRegistry();
    rules.find(({ id }) => id === 'lifecycle.trend_break_trade_holds').parameters.target = 'ZERO';
    rules.find(({ id }) => id === 'lifecycle.trade_break').parameters.precedence = 0;
    rules.find(({ id }) => id === 'entry.long.range_half').parameters.rangeTerms = ['LRR', 'TRR'];
    rules.find(({ id }) => id === 'risk.atr_cap').parameters.role = 'hard-stop';

    const result = validateProcessRegistry(documents, rules);
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      'Trend-break lifecycle rule must require Trade to hold and reduce the position to MIN.',
      'Trade-break exit must take precedence over the Trend-break reduction.',
      'Long opens and adds must use the bottom half of the LRR–HRR.',
      'ATR must remain a maximum-position cap, not an entry-size or stop rule.',
    ]));
  });

  test('rejects conviction, stepping, provenance-gate, and reversal drift', () => {
    const { documents, rules } = cloneRegistry();
    rules.find(({ id }) => id === 'sizing.conviction').parameters.record = 0.4;
    rules.find(({ id }) => id === 'lifecycle.incremental_steps').parameters.normalStepPct = 0.25;
    rules.find(({ id }) => id === 'data.execution_gate').parameters.instrumentVerificationRequired = false;
    rules.find(({ id }) => id === 'lifecycle.reversal').parameters.exitHeldSideFirst = false;

    const result = validateProcessRegistry(documents, rules);
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      'Conviction weights must match the production 20%/30%/50% constants.',
      'Incremental position steps must match the production 50/100-basis-point rules.',
      'Executable output must remain verified-IBKR, provenance-complete, instrument-verified, and read-only.',
      'Reversals must exit the held side before independently evaluating the opposite side.',
    ]));
  });
});
