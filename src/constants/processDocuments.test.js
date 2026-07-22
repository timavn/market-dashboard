import {
  PROCESS_DOCUMENTS,
  PROCESS_RULES,
  PUBLISHED_PROCESS_DOCUMENTS,
  assertValidProcessRegistry,
  getProcessDocument,
  getProcessDocumentByRoute,
  getPublishedProcessDocuments,
  getProcessRule,
  validateProcessRegistry,
} from './processDocuments';

const cloneRegistry = () => ({
  documents: JSON.parse(JSON.stringify(PROCESS_DOCUMENTS)),
  rules: JSON.parse(JSON.stringify(PROCESS_RULES)),
});

describe('process document and rule registry', () => {
  test('publishes the master paper and Position Sizing note at their canonical routes', () => {
    expect(PUBLISHED_PROCESS_DOCUMENTS.map(({ id }) => id)).toEqual([
      'the-process',
      'position-sizing',
    ]);
    expect(getPublishedProcessDocuments()).toBe(PUBLISHED_PROCESS_DOCUMENTS);
    expect(getProcessDocument('the-process')).toEqual(expect.objectContaining({
      route: '#/process',
      type: 'master',
      version: '0.1',
      status: 'Draft',
      asOf: '2026-07-18',
    }));
    expect(getProcessDocumentByRoute('#/process/methods/position-sizing')).toEqual(
      expect.objectContaining({ id: 'position-sizing', version: '1.1', status: 'Canonical' }),
    );
    expect(getProcessDocument('the-process').dependencies).toContainEqual({
      documentId: 'position-sizing',
      version: '1.1',
    });
  });

  test('keeps planned notes out of the publication routes', () => {
    const planned = PROCESS_DOCUMENTS.filter(({ status }) => status === 'Planned');
    expect(planned).toHaveLength(4);
    planned.forEach((document) => {
      expect(document.published).toBe(false);
      expect(document.route).toBeNull();
    });
    expect(getProcessDocument('security-selection-and-pods')).toMatchObject({
      status: 'Deferred',
      published: false,
      route: null,
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

  test('registers the complete canonical sizing mechanism rather than only its boundary rules', () => {
    expect(getProcessDocument('position-sizing').canonicalRuleIds).toEqual(expect.arrayContaining([
      'data.signal_independence',
      'range.normalization',
      'structure.directional_streaks',
      'record.extension',
      'sizing.conviction',
      'sizing.target_rounding',
      'lifecycle.open_at_min',
      'lifecycle.incremental_steps',
      'data.optional_strength_missing',
      'lifecycle.reversal',
      'data.execution_gate',
    ]));
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
    documents[0].dependencies[0].version = '9.9';

    const result = validateProcessRegistry(documents, rules);
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      'Duplicate document route: #/process',
      'Document the-process requires position-sizing v9.9, but the registry contains v1.1.',
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
