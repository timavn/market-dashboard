import { buildStopLossPresentation } from './stopLossPresentation';

// Test-only prepared references. Eligibility, stop arithmetic, and semantic tone belong to the owner.
const makeReference = (overrides = {}) => ({
  value: 83.76,
  averageCostLabel: '$87.00',
  atrLabel: '$1.62',
  resultLabel: '$83.76',
  asOfLabel: 'Sep 10, 2026',
  tone: 'is-positive',
  ...overrides,
});

const makeInput = (overrides = {}) => ({
  symbol: 'TLT',
  isShort: false,
  hasAtr: true,
  reference: makeReference(),
  ...overrides,
});

const availableTitle = 'Non-executable reference: IBKR average cost adjusted by two historical ATR14 values.';
const unavailableTitle = 'A stop reference requires verified IBKR average cost and historical ATR14.';
const unavailableEquation = 'Not calculated — verified IBKR average cost and ATR14 are required.';
const unavailableDetails = ['No executable stop is created; this is a reference check only.'];

test('preserves the complete long stop-loss cell and reference-check payload', () => {
  expect(buildStopLossPresentation(makeInput())).toEqual({
    metric: {
      value: '83.76',
      meta: 'IBKR basis · 2×ATR14 · Sep 10, 2026 · reference only',
      title: availableTitle,
      tone: 'is-positive',
      className: 'is-reference',
      buttonLabel: 'Verify TLT stop loss calculation',
    },
    verification: {
      symbol: 'TLT',
      metric: 'Stop loss',
      formula: 'Stop = average cost − (2 × ATR14)',
      equation: '$87.00 − (2 × $1.62) = $83.76',
      result: '$83.76',
      details: ['Long position', 'Verified IBKR average cost', 'ATR14 through Sep 10, 2026'],
    },
  });
});

test('preserves the short-side addition formula, operator, and position label', () => {
  expect(buildStopLossPresentation(makeInput({
    isShort: true,
    reference: makeReference({ value: 90.24, resultLabel: '$90.24', tone: 'is-negative' }),
  }))).toEqual({
    metric: {
      value: '90.24',
      meta: 'IBKR basis · 2×ATR14 · Sep 10, 2026 · reference only',
      title: availableTitle,
      tone: 'is-negative',
      className: 'is-reference',
      buttonLabel: 'Verify TLT stop loss calculation',
    },
    verification: {
      symbol: 'TLT',
      metric: 'Stop loss',
      formula: 'Stop = average cost + (2 × ATR14)',
      equation: '$87.00 + (2 × $1.62) = $90.24',
      result: '$90.24',
      details: ['Short position', 'Verified IBKR average cost', 'ATR14 through Sep 10, 2026'],
    },
  });
});

test.each([
  [true, 'Verified IBKR average cost required'],
  [false, 'ATR14 reference unavailable'],
])('preserves the unavailable state and explanatory button when hasAtr is %s', (hasAtr, meta) => {
  expect(buildStopLossPresentation(makeInput({ reference: null, hasAtr }))).toEqual({
    metric: {
      value: '—',
      meta,
      title: unavailableTitle,
      tone: 'is-muted',
      className: '',
      buttonLabel: 'Verify TLT stop loss calculation',
    },
    verification: {
      symbol: 'TLT',
      metric: 'Stop loss',
      formula: 'Stop = average cost − (2 × ATR14)',
      equation: unavailableEquation,
      result: 'Unavailable',
      details: unavailableDetails,
    },
  });
});

test('keeps the short formula when no reference is available without manufacturing short-side math', () => {
  const { metric, verification } = buildStopLossPresentation(makeInput({ reference: null, isShort: true }));
  expect(metric.value).toBe('—');
  expect(verification).toEqual({
    symbol: 'TLT',
    metric: 'Stop loss',
    formula: 'Stop = average cost + (2 × ATR14)',
    equation: unavailableEquation,
    result: 'Unavailable',
    details: unavailableDetails,
  });
});

test('uses the supplied symbol for the explanation button and selection in both availability states', () => {
  [makeReference(), null].forEach(reference => {
    const result = buildStopLossPresentation(makeInput({ symbol: 'AMZN', reference }));
    expect(result.metric.buttonLabel).toBe('Verify AMZN stop loss calculation');
    expect(result.verification.symbol).toBe('AMZN');
    expect(result.metric).not.toHaveProperty('onClick');
  });
});

test.each([
  [0, '0.00', '$0.00'],
  [-4.25, '-4.25', '-$4.25'],
])('does not treat the prepared stop value %s as missing or clamp it', (value, cellLabel, resultLabel) => {
  const { metric, verification } = buildStopLossPresentation(makeInput({
    reference: makeReference({ value, resultLabel }),
  }));
  expect(metric.value).toBe(cellLabel);
  expect(metric.className).toBe('is-reference');
  expect(verification.result).toBe(resultLabel);
  expect(verification.equation).toBe(`$87.00 − (2 × $1.62) = ${resultLabel}`);
});

test('keeps numeric cell rounding separate from the supplied currency result formatting', () => {
  const { metric, verification } = buildStopLossPresentation(makeInput({
    reference: makeReference({ value: 1234.567, resultLabel: '$1,234.5670' }),
  }));
  expect(metric.value).toBe('1234.57');
  expect(verification.result).toBe('$1,234.5670');
  expect(verification.equation).toBe('$87.00 − (2 × $1.62) = $1,234.5670');
});

test('passes operand and date labels through verbatim, including intentionally empty labels', () => {
  const result = buildStopLossPresentation(makeInput({ reference: makeReference({
    averageCostLabel: ' 87.000 USD ',
    atrLabel: '1.6200 USD',
    resultLabel: '83.760 USD',
    asOfLabel: 'Completed session · custom date',
  }) }));
  expect(result.metric.meta).toBe('IBKR basis · 2×ATR14 · Completed session · custom date · reference only');
  expect(result.verification.equation).toBe(' 87.000 USD  − (2 × 1.6200 USD) = 83.760 USD');
  expect(result.verification.details[2]).toBe('ATR14 through Completed session · custom date');
  const emptyLabels = buildStopLossPresentation(makeInput({ reference: makeReference({
    averageCostLabel: '', atrLabel: '', resultLabel: '', asOfLabel: '',
  }) }));
  expect(emptyLabels.metric.meta).toBe('IBKR basis · 2×ATR14 ·  · reference only');
  expect(emptyLabels.verification.equation).toBe(' − (2 × ) = ');
  expect(emptyLabels.verification.result).toBe('');
  expect(emptyLabels.verification.details[2]).toBe('ATR14 through ');
});

test.each(['is-positive', 'is-negative', 'is-muted'])('passes the prepared %s distance tone through without deriving it from stop direction', tone => {
  [false, true].forEach(isShort => {
    expect(buildStopLossPresentation(makeInput({ isShort, reference: makeReference({ tone }) })).metric.tone)
      .toBe(tone);
  });
});

test('does not recalculate a stop from operand labels or replace the prepared numeric result', () => {
  const { metric, verification } = buildStopLossPresentation(makeInput({ reference: makeReference({
    value: 83.76,
    averageCostLabel: '$9.00',
    atrLabel: '$3.00',
    resultLabel: '$7.00',
  }) }));
  expect(metric.value).toBe('83.76');
  expect(verification.equation).toBe('$9.00 − (2 × $3.00) = $7.00');
  expect(verification.result).toBe('$7.00');
});

test('does not mutate inputs and returns fresh metric, verification, and detail objects', () => {
  const reference = Object.freeze(makeReference());
  const input = Object.freeze(makeInput({ reference }));
  const first = buildStopLossPresentation(input);
  const second = buildStopLossPresentation(input);
  expect(second).toEqual(first);
  expect(second).not.toBe(first);
  expect(second.metric).not.toBe(first.metric);
  expect(second.verification).not.toBe(first.verification);
  expect(second.verification.details).not.toBe(first.verification.details);
  first.metric.value = 'Edited cell';
  first.verification.result = 'Edited explanation';
  first.verification.details.push('Extra detail');
  expect(second.metric.value).toBe('83.76');
  expect(second.verification.result).toBe('$83.76');
  expect(second.verification.details).toEqual(['Long position', 'Verified IBKR average cost', 'ATR14 through Sep 10, 2026']);
  expect(reference).toEqual(makeReference());
  const unavailable = Object.freeze(makeInput({ reference: null }));
  expect(buildStopLossPresentation(unavailable).verification.details)
    .not.toBe(buildStopLossPresentation(unavailable).verification.details);
});

test('returns plain strings without callbacks, executable controls, or presentation elements', () => {
  const result = buildStopLossPresentation(makeInput({
    symbol: '<button>TLT</button>',
    reference: makeReference({
      averageCostLabel: '<span>$87.00</span>',
      asOfLabel: '<time>Sep 10, 2026</time>',
    }),
  }));
  expect(Object.keys(result)).toEqual(['metric', 'verification']);
  Object.values(result.metric).forEach(value => expect(typeof value).toBe('string'));
  Object.entries(result.verification).filter(([key]) => key !== 'details').forEach(([, value]) => {
    expect(typeof value).toBe('string');
  });
  result.verification.details.forEach(value => expect(typeof value).toBe('string'));
  expect(result.metric.buttonLabel).toBe('Verify <button>TLT</button> stop loss calculation');
  expect(result.verification.equation).toBe('<span>$87.00</span> − (2 × $1.62) = $83.76');
  expect(result.verification.details[2]).toBe('ATR14 through <time>Sep 10, 2026</time>');
  expect(result.metric).not.toHaveProperty('onClick');
  expect(result.verification).not.toHaveProperty('onClick');
});

test('leaves acceptance of a supplied reference to its owner rather than gating it again on hasAtr', () => {
  expect(buildStopLossPresentation(makeInput({ hasAtr: false })))
    .toEqual(buildStopLossPresentation(makeInput({ hasAtr: true })));
});
