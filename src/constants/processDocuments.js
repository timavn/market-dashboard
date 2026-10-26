import { SIZING_CONSTANTS } from '../utils/signalWeightedPositionSizing';

const PROCESS_AS_OF = '2026-07-27';

const SIGNAL_AND_RANGE_RULES = [
  'signal.trade.duration',
  'signal.trend.duration',
  'entry.long.range_half',
  'entry.short.range_half',
  'data.signal_independence',
  'range.normalization',
  'structure.directional_streaks',
  'record.extension',
];

const POSITION_LIFECYCLE_RULES = [
  'lifecycle.trend_break_trade_holds',
  'lifecycle.trade_break',
  'lifecycle.reversal',
];

const POSITION_SIZING_RULES = [
  'risk.atr_band',
  'risk.atr_stop',
  'sizing.conviction',
  'sizing.target_rounding',
  'lifecycle.open_at_min',
  'lifecycle.incremental_steps',
  'data.optional_strength_missing',
];

const DATA_CONTROL_RULES = [
  'data.execution_gate',
];

const ALL_CANONICAL_PROCESS_RULES = [
  ...SIGNAL_AND_RANGE_RULES,
  ...POSITION_LIFECYCLE_RULES,
  ...POSITION_SIZING_RULES,
  ...DATA_CONTROL_RULES,
];

export const PROCESS_METHOD_IDS = [
  'signals-and-risk-ranges',
  'position-sizing',
  'stops-exits-and-reversals',
  'macro-regime-and-quad-overlay',
  'security-selection-and-pods',
  'portfolio-construction-and-diversification',
  'data-controls-and-execution',
  'validation-and-change-control',
];

const PROCESS_METHOD_DEPENDENCIES = [
  { documentId: 'signals-and-risk-ranges', version: '0.1' },
  { documentId: 'position-sizing', version: '2.0' },
  { documentId: 'stops-exits-and-reversals', version: '0.1' },
  { documentId: 'macro-regime-and-quad-overlay', version: '0.1' },
  { documentId: 'security-selection-and-pods', version: '0.1' },
  { documentId: 'portfolio-construction-and-diversification', version: '0.1' },
  { documentId: 'data-controls-and-execution', version: '0.1' },
  { documentId: 'validation-and-change-control', version: '0.1' },
];

export const PROCESS_DOCUMENTS = [
  {
    id: 'the-process',
    route: '#/process',
    type: 'master',
    section: 'process',
    parentId: null,
    editable: true,
    title: 'Process',
    subtitle: 'Portfolio Management Framework',
    version: '0.1',
    status: 'Draft',
    asOf: PROCESS_AS_OF,
    published: true,
    dependencies: [...PROCESS_METHOD_DEPENDENCIES],
    canonicalRuleIds: [],
    researchRuleIds: [],
    referencedRuleIds: [
      ...ALL_CANONICAL_PROCESS_RULES,
      'signal.tail.authority',
      'macro.quad.authority',
      'risk.hard_stop.policy',
      'portfolio.limits',
      'selection.pods',
    ],
  },
  {
    id: 'dashboard-guide',
    route: '#/process/dashboard-guide',
    type: 'guide',
    section: 'process',
    parentId: 'the-process',
    editable: true,
    title: 'Dashboard Guide',
    subtitle: 'Front-Page Math and Methodology',
    version: '0.1',
    status: 'Draft',
    asOf: '2026-09-03',
    published: true,
    dependencies: [
      { documentId: 'signals-and-risk-ranges', version: '0.1' },
      { documentId: 'macro-regime-and-quad-overlay', version: '0.1' },
      { documentId: 'data-controls-and-execution', version: '0.1' },
    ],
    canonicalRuleIds: [],
    researchRuleIds: [],
    referencedRuleIds: [
      'macro.quad.authority',
      'data.execution_gate',
    ],
  },
  {
    id: 'exposure-lab-guide',
    route: '#/process/exposure-lab',
    type: 'guide',
    section: 'process',
    parentId: 'the-process',
    editable: true,
    title: 'PCA Guide',
    subtitle: 'Operator Guide',
    version: '0.2',
    status: 'Draft',
    asOf: '2026-09-15',
    published: true,
    dependencies: [
      { documentId: 'portfolio-construction-and-diversification', version: '0.1' },
      { documentId: 'data-controls-and-execution', version: '0.1' },
    ],
    canonicalRuleIds: [],
    researchRuleIds: [],
    referencedRuleIds: [
      'portfolio.limits',
      'data.execution_gate',
    ],
  },
  {
    id: 'methods-index',
    route: '#/process/methods',
    type: 'index',
    section: 'methods',
    parentId: null,
    editable: true,
    title: 'Methods',
    subtitle: 'Process Methods',
    version: '0.1',
    status: 'Draft',
    asOf: PROCESS_AS_OF,
    published: true,
    dependencies: [...PROCESS_METHOD_DEPENDENCIES],
    canonicalRuleIds: [],
    researchRuleIds: [],
    referencedRuleIds: [
      ...ALL_CANONICAL_PROCESS_RULES,
      'signal.tail.authority',
      'macro.quad.authority',
      'risk.hard_stop.policy',
      'portfolio.limits',
      'selection.pods',
    ],
  },
  {
    id: 'signals-and-risk-ranges',
    route: '#/process/methods/signals-and-risk-ranges',
    type: 'method',
    section: 'methods',
    parentId: 'methods-index',
    editable: true,
    title: 'Signals and Risk Ranges',
    subtitle: 'Method',
    version: '0.1',
    status: 'Draft',
    asOf: PROCESS_AS_OF,
    published: true,
    dependencies: [],
    canonicalRuleIds: [...SIGNAL_AND_RANGE_RULES],
    researchRuleIds: ['signal.tail.authority'],
    referencedRuleIds: [
      ...SIGNAL_AND_RANGE_RULES,
      'signal.tail.authority',
    ],
  },
  {
    id: 'position-sizing',
    route: '#/process/methods/position-sizing',
    type: 'method',
    section: 'methods',
    parentId: 'methods-index',
    editable: true,
    title: 'Position Sizing',
    subtitle: 'Method',
    version: '2.0',
    status: 'Canonical',
    asOf: PROCESS_AS_OF,
    published: true,
    dependencies: [{ documentId: 'signals-and-risk-ranges', version: '0.1' }],
    canonicalRuleIds: [...POSITION_SIZING_RULES],
    researchRuleIds: [],
    referencedRuleIds: [
      ...SIGNAL_AND_RANGE_RULES,
      ...POSITION_LIFECYCLE_RULES,
      ...POSITION_SIZING_RULES,
      ...DATA_CONTROL_RULES,
    ],
  },
  {
    id: 'stops-exits-and-reversals',
    route: '#/process/methods/stops-exits-and-reversals',
    type: 'method',
    section: 'methods',
    parentId: 'methods-index',
    editable: true,
    title: 'Stops, Exits, and Reversals',
    subtitle: 'Method',
    version: '0.1',
    status: 'Draft',
    asOf: PROCESS_AS_OF,
    published: true,
    dependencies: [{ documentId: 'signals-and-risk-ranges', version: '0.1' }],
    canonicalRuleIds: [...POSITION_LIFECYCLE_RULES],
    researchRuleIds: ['risk.hard_stop.policy'],
    referencedRuleIds: [
      ...POSITION_LIFECYCLE_RULES,
      'risk.hard_stop.policy',
    ],
  },
  {
    id: 'macro-regime-and-quad-overlay',
    route: '#/process/methods/macro-regime-and-quad-overlay',
    type: 'method',
    section: 'methods',
    parentId: 'methods-index',
    editable: true,
    title: 'Macro Regime and Quad Overlay',
    subtitle: 'Method',
    version: '0.1',
    status: 'Draft',
    asOf: PROCESS_AS_OF,
    published: true,
    dependencies: [],
    canonicalRuleIds: [],
    researchRuleIds: ['macro.quad.authority'],
    referencedRuleIds: ['macro.quad.authority'],
  },
  {
    id: 'security-selection-and-pods',
    route: '#/process/methods/security-selection-and-pods',
    type: 'method',
    section: 'methods',
    parentId: 'methods-index',
    editable: true,
    title: 'Security Selection and Pods',
    subtitle: 'Method',
    version: '0.1',
    status: 'Deferred',
    asOf: PROCESS_AS_OF,
    published: true,
    dependencies: [],
    canonicalRuleIds: [],
    researchRuleIds: ['selection.pods'],
    referencedRuleIds: ['selection.pods'],
  },
  {
    id: 'portfolio-construction-and-diversification',
    route: '#/process/methods/portfolio-construction-and-diversification',
    type: 'method',
    section: 'methods',
    parentId: 'methods-index',
    editable: true,
    title: 'Portfolio Construction and Diversification',
    subtitle: 'Method',
    version: '0.1',
    status: 'Draft',
    asOf: PROCESS_AS_OF,
    published: true,
    dependencies: [{ documentId: 'position-sizing', version: '2.0' }],
    canonicalRuleIds: [],
    researchRuleIds: ['portfolio.limits'],
    referencedRuleIds: ['risk.atr_band', 'risk.atr_stop', 'portfolio.limits'],
  },
  {
    id: 'data-controls-and-execution',
    route: '#/process/methods/data-controls-and-execution',
    type: 'method',
    section: 'methods',
    parentId: 'methods-index',
    editable: true,
    title: 'Data Controls and Execution',
    subtitle: 'Method',
    version: '0.1',
    status: 'Draft',
    asOf: PROCESS_AS_OF,
    published: true,
    dependencies: [],
    canonicalRuleIds: [...DATA_CONTROL_RULES],
    researchRuleIds: [],
    referencedRuleIds: [...DATA_CONTROL_RULES],
  },
  {
    id: 'validation-and-change-control',
    route: '#/process/methods/validation-and-change-control',
    type: 'method',
    section: 'methods',
    parentId: 'methods-index',
    editable: true,
    title: 'Validation and Change Control',
    subtitle: 'Method',
    version: '0.1',
    status: 'Draft',
    asOf: PROCESS_AS_OF,
    published: true,
    dependencies: [],
    canonicalRuleIds: [],
    researchRuleIds: [],
    referencedRuleIds: [],
  },
];

export const PROCESS_RULES = [
  {
    id: 'signal.trade.duration',
    title: 'Trade duration',
    category: 'signals',
    status: 'canonical',
    ownerDocumentId: 'signals-and-risk-ranges',
    ownerVersion: '0.1',
    statement: 'Trade is the published directional signal with a duration of three weeks or less.',
    parameters: { maximumDurationWeeks: 3 },
  },
  {
    id: 'signal.trend.duration',
    title: 'Trend duration',
    category: 'signals',
    status: 'canonical',
    ownerDocumentId: 'signals-and-risk-ranges',
    ownerVersion: '0.1',
    statement: 'Trend is the published directional signal with a duration of three months or more.',
    parameters: { minimumDurationMonths: 3 },
  },
  {
    id: 'lifecycle.trend_break_trade_holds',
    title: 'Trend break while Trade holds',
    category: 'lifecycle',
    status: 'canonical',
    ownerDocumentId: 'stops-exits-and-reversals',
    ownerVersion: '0.1',
    statement: 'When Trend breaks but Trade remains aligned, an existing position is reduced immediately to MIN.',
    parameters: {
      condition: { trend: 'broken', trade: 'aligned' },
      target: 'MIN',
      precedence: 1,
    },
  },
  {
    id: 'lifecycle.trade_break',
    title: 'Trade break',
    category: 'lifecycle',
    status: 'canonical',
    ownerDocumentId: 'stops-exits-and-reversals',
    ownerVersion: '0.1',
    statement: 'When Trade breaks, the existing position is exited to zero regardless of Trend.',
    parameters: {
      condition: { trade: 'broken', trend: 'any' },
      target: 'ZERO',
      precedence: 2,
    },
  },
  {
    id: 'entry.long.range_half',
    title: 'Long entry location',
    category: 'entry',
    status: 'canonical',
    ownerDocumentId: 'signals-and-risk-ranges',
    ownerVersion: '0.1',
    statement: 'A long may open or add only in the bottom half of the current LRR–HRR.',
    parameters: {
      side: 'long',
      favorableHalf: 'bottom',
      actions: ['open', 'add'],
      rangeTerms: ['LRR', 'HRR'],
    },
  },
  {
    id: 'entry.short.range_half',
    title: 'Short entry location',
    category: 'entry',
    status: 'canonical',
    ownerDocumentId: 'signals-and-risk-ranges',
    ownerVersion: '0.1',
    statement: 'A short may open or add only in the top half of the current LRR–HRR.',
    parameters: {
      side: 'short',
      favorableHalf: 'top',
      actions: ['open', 'add'],
      rangeTerms: ['LRR', 'HRR'],
    },
  },
  {
    id: 'risk.atr_band',
    title: 'ATR sizing band',
    category: 'position-sizing',
    status: 'canonical',
    ownerDocumentId: 'position-sizing',
    ownerVersion: '2.0',
    statement: 'Each security is sized from its own 14-day ATR: MIN and MAX are the weights whose 2 × ATR stop costs 0.125% and 0.25% of NLV; an ATR floor of 1.25% of price caps MAX at 10%.',
    parameters: {
      role: 'sizing-band',
      atrSessions: SIZING_CONSTANTS.MIN_ATR_OBSERVATIONS,
      stopAtrMultiple: SIZING_CONSTANTS.STOP_ATR_MULTIPLE,
      minStopLossPctNlv: SIZING_CONSTANTS.MIN_STOP_LOSS_PCT_NLV,
      maxStopLossPctNlv: SIZING_CONSTANTS.MAX_STOP_LOSS_PCT_NLV,
      maxPositionWeightPct: SIZING_CONSTANTS.MAX_POSITION_WEIGHT,
      executableIncrementPct: SIZING_CONSTANTS.WEIGHT_INCREMENT,
      benchmark: null,
    },
  },
  {
    id: 'risk.atr_stop',
    title: 'ATR reference stop',
    category: 'position-sizing',
    status: 'canonical',
    ownerDocumentId: 'position-sizing',
    ownerVersion: '2.0',
    statement: 'The reference stop sits 2 × ATR against the position from its entry price, the same distance that sets MIN and MAX; it is a planning level, not an order.',
    parameters: {
      atrMultiple: SIZING_CONSTANTS.STOP_ATR_MULTIPLE,
      basis: 'ENTRY_PRICE',
      orderTransmissionAllowed: false,
    },
  },
  {
    id: 'data.signal_independence',
    title: 'Independent Trade and Trend inputs',
    category: 'data-controls',
    status: 'canonical',
    ownerDocumentId: 'signals-and-risk-ranges',
    ownerVersion: '0.1',
    statement: 'Trade comes only from the published tracker direction and Trend only from the published risk-range direction; neither may be copied from the other.',
    parameters: { tradeSource: 'published-tracker', trendSource: 'published-risk-range', inferenceAllowed: false },
  },
  {
    id: 'range.normalization',
    title: 'Normalized range position',
    category: 'entry',
    status: 'canonical',
    ownerDocumentId: 'signals-and-risk-ranges',
    ownerVersion: '0.1',
    statement: 'Spot is normalized within LRR–HRR; wrong-half and out-of-range prices remain visible but cannot authorize an open or add.',
    parameters: { longMaximum: 0.5, shortMinimum: 0.5, boundariesInclusive: true, wrongLocationAction: 'NO_OPEN_OR_ADD' },
  },
  {
    id: 'structure.directional_streaks',
    title: 'Directional risk-range streaks',
    category: 'position-sizing',
    status: 'canonical',
    ownerDocumentId: 'signals-and-risk-ranges',
    ownerVersion: '0.1',
    statement: 'HH/HL streaks support longs and LH/LL streaks support shorts; each endpoint streak is capped at five and resets independently on a tie or missing edition.',
    parameters: { long: ['HH', 'HL'], short: ['LH', 'LL'], maximum: SIZING_CONSTANTS.MAX_STREAK, independentReset: true },
  },
  {
    id: 'record.extension',
    title: 'Prior traded-price record extension',
    category: 'position-sizing',
    status: 'canonical',
    ownerDocumentId: 'signals-and-risk-ranges',
    ownerVersion: '0.1',
    statement: 'Long record extension requires current HRR above the strictly prior traded-price ATH; short extension requires current LRR below the strictly prior traded-price ATL.',
    parameters: { long: 'HRR>PRIOR_ATH', short: 'LRR<PRIOR_ATL', historyCutoff: 'STRICTLY_PRIOR_TO_RANGE_EDITION' },
  },
  {
    id: 'sizing.conviction',
    title: 'Conviction weights',
    category: 'position-sizing',
    status: 'canonical',
    ownerDocumentId: 'position-sizing',
    ownerVersion: '2.0',
    statement: 'Range proximity, directional structure, and record extension contribute 20%, 30%, and 50% of conviction, respectively.',
    parameters: {
      range: SIZING_CONSTANTS.RANGE_CONVICTION_WEIGHT,
      structure: SIZING_CONSTANTS.STRUCTURE_CONVICTION_WEIGHT,
      record: SIZING_CONSTANTS.RECORD_CONVICTION_WEIGHT,
    },
  },
  {
    id: 'sizing.target_rounding',
    title: 'Target calculation and rounding',
    category: 'position-sizing',
    status: 'canonical',
    ownerDocumentId: 'position-sizing',
    ownerVersion: '2.0',
    statement: 'The target is MIN plus conviction times the effective band width, rounded to the nearest 25 basis points and clamped within the band.',
    parameters: { incrementPct: SIZING_CONSTANTS.WEIGHT_INCREMENT, method: 'NEAREST', clampToBand: true },
  },
  {
    id: 'lifecycle.open_at_min',
    title: 'New-position opening size',
    category: 'lifecycle',
    status: 'canonical',
    ownerDocumentId: 'position-sizing',
    ownerVersion: '2.0',
    statement: 'A fully eligible new position opens at MIN rather than at its computed target.',
    parameters: { openingWeight: 'MIN' },
  },
  {
    id: 'lifecycle.incremental_steps',
    title: 'Incremental position changes',
    category: 'lifecycle',
    status: 'canonical',
    ownerDocumentId: 'position-sizing',
    ownerVersion: '2.0',
    statement: 'Normal edition changes move 50 basis points; record extension or two qualifying three-edition streaks permits a 100-basis-point move.',
    parameters: {
      normalStepPct: SIZING_CONSTANTS.NORMAL_STEP,
      acceleratedStepPct: SIZING_CONSTANTS.ACCELERATED_STEP,
      minimumAcceleratedStreak: 3,
      acceleratedTriggers: ['RECORD_EXTENSION', 'BOTH_STRUCTURE_STREAKS'],
    },
  },
  {
    id: 'data.optional_strength_missing',
    title: 'Missing optional strength data',
    category: 'data-controls',
    status: 'canonical',
    ownerDocumentId: 'position-sizing',
    ownerVersion: '2.0',
    statement: 'Missing optional structure or record inputs remain visible as unavailable and contribute zero rather than a negative signal.',
    parameters: { contribution: 0, state: 'UNAVAILABLE', negativeSignal: false },
  },
  {
    id: 'lifecycle.reversal',
    title: 'Reversal sequence',
    category: 'lifecycle',
    status: 'canonical',
    ownerDocumentId: 'stops-exits-and-reversals',
    ownerVersion: '0.1',
    statement: 'A reversal exits the held side first; the opposite side is a new candidate and must independently satisfy signal and entry-location rules.',
    parameters: { exitHeldSideFirst: true, oppositeSideRequiresIndependentEligibility: true },
  },
  {
    id: 'data.execution_gate',
    title: 'Executable output gate',
    category: 'data-controls',
    status: 'canonical',
    ownerDocumentId: 'data-controls-and-execution',
    ownerVersion: '0.1',
    statement: 'Actionable dollars and quantity require fresh verified IBKR quote, NLV, supported instrument metadata, and dated research provenance; output remains read-only.',
    parameters: { provider: 'IBKR', researchProvenanceRequired: true, instrumentVerificationRequired: true, readOnly: true, orderTransmissionAllowed: false },
  },
  {
    id: 'signal.tail.authority',
    title: 'Tail authority',
    category: 'signals',
    status: 'research',
    ownerDocumentId: 'signals-and-risk-ranges',
    ownerVersion: '0.1',
    statement: 'Tail remains research-only until its exact authority is approved.',
    parameters: { authority: 'unresolved' },
  },
  {
    id: 'macro.quad.authority',
    title: 'Quad overlay authority',
    category: 'macro-regime',
    status: 'research',
    ownerDocumentId: 'macro-regime-and-quad-overlay',
    ownerVersion: '0.1',
    statement: 'The Quad overlay remains descriptive until its role as context, ranking input, size modifier, or eligibility gate is approved.',
    parameters: { authority: 'unresolved' },
  },
  {
    id: 'risk.hard_stop.policy',
    title: 'Hard-stop policy',
    category: 'stops-and-exits',
    status: 'research',
    ownerDocumentId: 'stops-exits-and-reversals',
    ownerVersion: '0.1',
    statement: 'Hard-stop placement and behavior remain unresolved pending approval of the technical note.',
    parameters: { authority: 'unresolved' },
  },
  {
    id: 'portfolio.limits',
    title: 'Portfolio policy limits',
    category: 'portfolio-construction',
    status: 'research',
    ownerDocumentId: 'portfolio-construction-and-diversification',
    ownerVersion: '0.1',
    statement: 'Gross, net, correlation, sleeve, cash, and diversification limits remain descriptive until approved.',
    parameters: { authority: 'unresolved' },
  },
  {
    id: 'selection.pods',
    title: 'Security-selection Pods',
    category: 'security-selection',
    status: 'research',
    ownerDocumentId: 'security-selection-and-pods',
    ownerVersion: '0.1',
    statement: 'Pods remain research-only until real inputs, calculations, and decision authority are defined.',
    parameters: { authority: 'unresolved' },
  },
];

export const PUBLISHED_PROCESS_DOCUMENTS = PROCESS_DOCUMENTS.filter(({ published }) => published);

export const PROCESS_METHOD_DOCUMENTS = PROCESS_METHOD_IDS
  .map((id) => PROCESS_DOCUMENTS.find((document) => document.id === id))
  .filter(Boolean);

export const getPublishedProcessDocuments = () => PUBLISHED_PROCESS_DOCUMENTS;

export const getProcessMethodDocuments = () => PROCESS_METHOD_DOCUMENTS;

export const getProcessChildDocuments = (parentId) => (
  PROCESS_DOCUMENTS.filter((document) => document.parentId === parentId)
);

export const getProcessDocument = (id) => (
  PROCESS_DOCUMENTS.find((document) => document.id === id) || null
);

export const getProcessDocumentByRoute = (route) => (
  PROCESS_DOCUMENTS.find((document) => document.route === route) || null
);

export const getProcessRule = (id) => (
  PROCESS_RULES.find((rule) => rule.id === id) || null
);

const addDuplicateErrors = (items, valueFor, label, errors, { skipNull = false } = {}) => {
  const seen = new Set();
  items.forEach((item) => {
    const value = valueFor(item);
    if (skipNull && (value === null || value === undefined)) return;
    if (seen.has(value)) errors.push(`Duplicate ${label}: ${value}`);
    seen.add(value);
  });
};

export const validateProcessRegistry = (
  documents = PROCESS_DOCUMENTS,
  rules = PROCESS_RULES,
) => {
  const errors = [];
  const documentById = new Map(documents.map((document) => [document.id, document]));
  const ruleById = new Map(rules.map((rule) => [rule.id, rule]));

  addDuplicateErrors(documents, ({ id }) => id, 'document id', errors);
  addDuplicateErrors(documents, ({ route }) => route, 'document route', errors, { skipNull: true });
  addDuplicateErrors(rules, ({ id }) => id, 'rule id', errors);

  documents.forEach((document) => {
    if (!document.id || !document.type || !document.version || !document.status || !document.asOf) {
      errors.push(`Document ${document.id || '<unknown>'} is missing required metadata.`);
    }
    if (!document.section || typeof document.editable !== 'boolean' || !Object.prototype.hasOwnProperty.call(document, 'parentId')) {
      errors.push(`Document ${document.id || '<unknown>'} is missing hierarchy metadata.`);
    }
    if (document.published && !document.route) {
      errors.push(`Published document ${document.id} must have a route.`);
    }
    if (!document.published && document.route) {
      errors.push(`Unpublished document ${document.id} cannot have a publication route.`);
    }
    if (document.parentId) {
      const parentDocument = documentById.get(document.parentId);
      if (!parentDocument) {
        errors.push(`Document ${document.id} names missing parent ${document.parentId}.`);
      } else if (document.parentId === document.id) {
        errors.push(`Document ${document.id} cannot be its own parent.`);
      }
    }
    if (document.type === 'method' && document.parentId !== 'methods-index') {
      errors.push(`Method ${document.id} must belong to the Methods index.`);
    }

    (document.dependencies || []).forEach((dependency) => {
      const dependencyDocument = documentById.get(dependency.documentId);
      if (!dependencyDocument) {
        errors.push(`Document ${document.id} depends on missing document ${dependency.documentId}.`);
      } else if (dependencyDocument.version !== dependency.version) {
        errors.push(
          `Document ${document.id} requires ${dependency.documentId} v${dependency.version}, `
          + `but the registry contains v${dependencyDocument.version}.`,
        );
      }
    });

    [
      ...(document.canonicalRuleIds || []),
      ...(document.researchRuleIds || []),
      ...(document.referencedRuleIds || []),
    ].forEach((ruleId) => {
      if (!ruleById.has(ruleId)) {
        errors.push(`Document ${document.id} references missing rule ${ruleId}.`);
      }
    });
  });

  const canonicalClaims = new Map();
  const researchClaims = new Map();
  documents.forEach((document) => {
    (document.canonicalRuleIds || []).forEach((ruleId) => {
      canonicalClaims.set(ruleId, [...(canonicalClaims.get(ruleId) || []), document.id]);
    });
    (document.researchRuleIds || []).forEach((ruleId) => {
      researchClaims.set(ruleId, [...(researchClaims.get(ruleId) || []), document.id]);
    });
  });

  rules.forEach((rule) => {
    const owner = documentById.get(rule.ownerDocumentId);
    const claims = canonicalClaims.get(rule.id) || [];
    const unresolvedClaims = researchClaims.get(rule.id) || [];

    if (!['canonical', 'research', 'deprecated'].includes(rule.status)) {
      errors.push(`Rule ${rule.id} has unsupported status ${rule.status}.`);
    }
    if (!owner) {
      errors.push(`Rule ${rule.id} has missing owner ${rule.ownerDocumentId}.`);
    } else if (owner.version !== rule.ownerVersion) {
      errors.push(
        `Rule ${rule.id} names owner version ${rule.ownerVersion}, `
        + `but ${owner.id} is v${owner.version}.`,
      );
    }

    if (rule.status === 'canonical') {
      if (claims.length !== 1) {
        errors.push(`Canonical rule ${rule.id} must have exactly one canonical owner; found ${claims.length}.`);
      } else if (claims[0] !== rule.ownerDocumentId) {
        errors.push(`Canonical rule ${rule.id} is claimed by ${claims[0]}, not its named owner ${rule.ownerDocumentId}.`);
      }
      if (unresolvedClaims.length) {
        errors.push(`Canonical rule ${rule.id} cannot be listed as research.`);
      }
    } else {
      if (claims.length) {
        errors.push(`${rule.status} rule ${rule.id} cannot be presented as canonical.`);
      }
      if (rule.status === 'research') {
        if (unresolvedClaims.length !== 1) {
          errors.push(`Research rule ${rule.id} must have exactly one research owner; found ${unresolvedClaims.length}.`);
        } else if (unresolvedClaims[0] !== rule.ownerDocumentId) {
          errors.push(`Research rule ${rule.id} is claimed by ${unresolvedClaims[0]}, not its named owner ${rule.ownerDocumentId}.`);
        }
      }
    }
  });

  const requireRule = (id) => {
    const rule = ruleById.get(id);
    if (!rule) errors.push(`Required rule ${id} is missing.`);
    return rule;
  };

  const tradeDuration = requireRule('signal.trade.duration');
  const trendDuration = requireRule('signal.trend.duration');
  const trendBreak = requireRule('lifecycle.trend_break_trade_holds');
  const tradeBreak = requireRule('lifecycle.trade_break');
  const longEntry = requireRule('entry.long.range_half');
  const shortEntry = requireRule('entry.short.range_half');
  const atrBand = requireRule('risk.atr_band');
  const atrStop = requireRule('risk.atr_stop');
  const signalIndependence = requireRule('data.signal_independence');
  const rangeNormalization = requireRule('range.normalization');
  const structure = requireRule('structure.directional_streaks');
  const recordExtension = requireRule('record.extension');
  const conviction = requireRule('sizing.conviction');
  const targetRounding = requireRule('sizing.target_rounding');
  const openAtMin = requireRule('lifecycle.open_at_min');
  const incrementalSteps = requireRule('lifecycle.incremental_steps');
  const optionalMissing = requireRule('data.optional_strength_missing');
  const reversal = requireRule('lifecycle.reversal');
  const executionGate = requireRule('data.execution_gate');

  if (tradeDuration && tradeDuration.parameters?.maximumDurationWeeks !== 3) {
    errors.push('Trade duration must remain three weeks or less.');
  }
  if (trendDuration && trendDuration.parameters?.minimumDurationMonths !== 3) {
    errors.push('Trend duration must remain three months or more.');
  }
  if (
    trendBreak
    && (
      trendBreak.parameters?.condition?.trend !== 'broken'
      || trendBreak.parameters?.condition?.trade !== 'aligned'
      || trendBreak.parameters?.target !== 'MIN'
    )
  ) {
    errors.push('Trend-break lifecycle rule must require Trade to hold and reduce the position to MIN.');
  }
  if (
    tradeBreak
    && (
      tradeBreak.parameters?.condition?.trade !== 'broken'
      || tradeBreak.parameters?.target !== 'ZERO'
    )
  ) {
    errors.push('Trade-break lifecycle rule must exit the position to zero.');
  }
  if (
    trendBreak
    && tradeBreak
    && !(tradeBreak.parameters?.precedence > trendBreak.parameters?.precedence)
  ) {
    errors.push('Trade-break exit must take precedence over the Trend-break reduction.');
  }
  if (
    longEntry
    && (
      longEntry.parameters?.favorableHalf !== 'bottom'
      || longEntry.parameters?.rangeTerms?.join('/') !== 'LRR/HRR'
    )
  ) {
    errors.push('Long opens and adds must use the bottom half of the LRR–HRR.');
  }
  if (
    shortEntry
    && (
      shortEntry.parameters?.favorableHalf !== 'top'
      || shortEntry.parameters?.rangeTerms?.join('/') !== 'LRR/HRR'
    )
  ) {
    errors.push('Short opens and adds must use the top half of the LRR–HRR.');
  }
  if (
    atrBand
    && (
      atrBand.parameters?.stopAtrMultiple !== SIZING_CONSTANTS.STOP_ATR_MULTIPLE
      || atrBand.parameters?.minStopLossPctNlv !== SIZING_CONSTANTS.MIN_STOP_LOSS_PCT_NLV
      || atrBand.parameters?.maxStopLossPctNlv !== SIZING_CONSTANTS.MAX_STOP_LOSS_PCT_NLV
      || atrBand.parameters?.maxPositionWeightPct !== SIZING_CONSTANTS.MAX_POSITION_WEIGHT
    )
  ) {
    errors.push('ATR-band constants must match the production 2 × ATR stop, 0.125%/0.25% stop losses, and 10% ceiling.');
  }
  if (atrStop && atrStop.parameters?.atrMultiple !== atrBand?.parameters?.stopAtrMultiple) {
    errors.push('The reference stop must use the same ATR multiple as the sizing band.');
  }
  if (signalIndependence && signalIndependence.parameters?.inferenceAllowed !== false) {
    errors.push('Trade and Trend must remain independent published inputs.');
  }
  if (
    rangeNormalization
    && (
      rangeNormalization.parameters?.longMaximum !== 0.5
      || rangeNormalization.parameters?.shortMinimum !== 0.5
      || rangeNormalization.parameters?.boundariesInclusive !== true
    )
  ) {
    errors.push('Normalized range entry boundaries must remain the inclusive bottom half for longs and top half for shorts.');
  }
  if (structure && structure.parameters?.maximum !== SIZING_CONSTANTS.MAX_STREAK) {
    errors.push('Directional structure streaks must use the production five-edition cap.');
  }
  if (
    recordExtension
    && (
      recordExtension.parameters?.long !== 'HRR>PRIOR_ATH'
      || recordExtension.parameters?.short !== 'LRR<PRIOR_ATL'
      || recordExtension.parameters?.historyCutoff !== 'STRICTLY_PRIOR_TO_RANGE_EDITION'
    )
  ) {
    errors.push('Record extension must compare HRR/ATH and LRR/ATL against strictly prior traded-price history.');
  }
  if (
    conviction
    && (
      conviction.parameters?.range !== SIZING_CONSTANTS.RANGE_CONVICTION_WEIGHT
      || conviction.parameters?.structure !== SIZING_CONSTANTS.STRUCTURE_CONVICTION_WEIGHT
      || conviction.parameters?.record !== SIZING_CONSTANTS.RECORD_CONVICTION_WEIGHT
    )
  ) {
    errors.push('Conviction weights must match the production 20%/30%/50% constants.');
  }
  if (
    targetRounding
    && (
      targetRounding.parameters?.incrementPct !== SIZING_CONSTANTS.WEIGHT_INCREMENT
      || targetRounding.parameters?.method !== 'NEAREST'
      || targetRounding.parameters?.clampToBand !== true
    )
  ) {
    errors.push('Target rounding must remain nearest 25 basis points and clamped inside the band.');
  }
  if (openAtMin && openAtMin.parameters?.openingWeight !== 'MIN') {
    errors.push('New positions must open at MIN.');
  }
  if (
    incrementalSteps
    && (
      incrementalSteps.parameters?.normalStepPct !== SIZING_CONSTANTS.NORMAL_STEP
      || incrementalSteps.parameters?.acceleratedStepPct !== SIZING_CONSTANTS.ACCELERATED_STEP
      || incrementalSteps.parameters?.minimumAcceleratedStreak !== 3
    )
  ) {
    errors.push('Incremental position steps must match the production 50/100-basis-point rules.');
  }
  if (
    optionalMissing
    && (
      optionalMissing.parameters?.contribution !== 0
      || optionalMissing.parameters?.state !== 'UNAVAILABLE'
      || optionalMissing.parameters?.negativeSignal !== false
    )
  ) {
    errors.push('Missing optional strength inputs must remain unavailable and contribute zero.');
  }
  if (
    reversal
    && (
      reversal.parameters?.exitHeldSideFirst !== true
      || reversal.parameters?.oppositeSideRequiresIndependentEligibility !== true
    )
  ) {
    errors.push('Reversals must exit the held side before independently evaluating the opposite side.');
  }
  if (
    executionGate
    && (
      executionGate.parameters?.provider !== 'IBKR'
      || executionGate.parameters?.researchProvenanceRequired !== true
      || executionGate.parameters?.instrumentVerificationRequired !== true
      || executionGate.parameters?.readOnly !== true
      || executionGate.parameters?.orderTransmissionAllowed !== false
    )
  ) {
    errors.push('Executable output must remain verified-IBKR, provenance-complete, instrument-verified, and read-only.');
  }

  return { valid: errors.length === 0, errors };
};

export const assertValidProcessRegistry = (
  documents = PROCESS_DOCUMENTS,
  rules = PROCESS_RULES,
) => {
  const result = validateProcessRegistry(documents, rules);
  if (!result.valid) {
    throw new Error(`Invalid process registry:\n${result.errors.join('\n')}`);
  }
  return true;
};
