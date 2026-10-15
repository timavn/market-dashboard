import {
  buildSizingVolatilityPresentation,
  buildSizingVolatilityVerification,
} from './sizingVolatilityPresentation';

// Test-only validated references; provider acceptance remains with the portfolio owner.
const makeReference = ({ band = {}, rv = {}, ...overrides } = {}) => ({
  available: true,
  band: { volatility: 0.18, effectiveVolatility: 0.18, floorApplied: false, ...band },
  rv: {
    rv63: 0.18,
    rv252: 0.14,
    asOf: '2026-09-10',
    annualizationFactor: 252,
    observationCount: 300,
    limitedHistory: false,
    spikeWarning: false,
    warnings: [],
    ...rv,
  },
  ...overrides,
});

const makeInput = (overrides = {}) => ({
  symbol: 'IAK',
  reference: makeReference(),
  loading: false,
  asOfLabel: 'Sep 10, 2026',
  ...overrides,
});

const title = 'Sizing uses the higher of 3-month and 1-year annualized realized volatility. Reference only — not options IV.';
const formula = 'SizingVol = max(RV₆₃, RV₂₅₂); RV = stdev(ln returns) × √N';
const standardDetails = [
  'Uses Yahoo adjusted closes only.',
  'Leveraged/inverse ETFs use their own price history.',
  'Reference-only / non-executable.',
];

test.each([
  [0.18, 0.14, '18.0%', '18.00', '14.00'],
  [0.3, 0.24, '30.0%', '30.00', '24.00'],
])('preserves complete cell and explanation projections for measured volatility %s', (volatility, rv252, cellText, precise, longVol) => {
  const input = makeInput({ reference: makeReference({
    band: { volatility },
    rv: { rv63: volatility, rv252 },
  }) });
  expect(buildSizingVolatilityPresentation(input)).toEqual({
    metric: {
      value: cellText,
      meta: 'max(63d, 1Y) realized · Sep 10, 2026',
      title,
      tone: 'is-muted',
      className: 'is-reference',
      buttonLabel: 'Verify IAK sizing volatility',
    },
    display: { text: cellText, badge: null },
  });
  expect(buildSizingVolatilityVerification(input)).toEqual({
    symbol: 'IAK',
    metric: 'Sizing volatility',
    formula,
    equation: `RV₆₃ = ${precise}% · RV₂₅₂ = ${longVol}% · SizingVol = ${precise}% · N = 252 · Observations = 300`,
    result: `${precise}% annualized`,
    details: standardDetails,
  });
});

test('keeps one-decimal cell formatting separate from two-decimal explanation precision and preserves supplied date labels', () => {
  const input = makeInput({
    symbol: 'TLT',
    asOfLabel: 'Completed session label',
    reference: makeReference({ band: { volatility: 0.18567 }, rv: { rv63: 0.18567, rv252: 0.14234 } }),
  });
  const presentation = buildSizingVolatilityPresentation(input);
  expect(presentation.metric.value).toBe('18.6%');
  expect(presentation.display.text).toBe('18.6%');
  expect(presentation.metric.meta).toBe('max(63d, 1Y) realized · Completed session label');
  expect(presentation.metric.buttonLabel).toBe('Verify TLT sizing volatility');
  expect(buildSizingVolatilityVerification(input)).toMatchObject({
    symbol: 'TLT',
    equation: 'RV₆₃ = 18.57% · RV₂₅₂ = 14.23% · SizingVol = 18.57% · N = 252 · Observations = 300',
    result: '18.57% annualized',
  });
});

test.each([[false, 'Unavailable'], [true, '…']])('hides finite leftovers and explanation controls for an unavailable reference when loading is %s', (loading, value) => {
  const input = makeInput({
    loading,
    reference: makeReference({
      available: false,
      reason: 'Latest completed-session history is unavailable.',
      rv: { limitedHistory: true, spikeWarning: true, warnings: ['Unusable historical input.'] },
    }),
  });
  expect(buildSizingVolatilityPresentation(input)).toEqual({
    metric: {
      value,
      meta: 'Latest completed-session history is unavailable.',
      title,
      tone: 'is-muted',
      className: '',
      buttonLabel: null,
    },
    display: null,
  });
  expect(buildSizingVolatilityVerification(input)).toBeNull();
});

test('retains an available prepared reference even while the owner reports loading', () => {
  const input = makeInput({ loading: true });
  expect(buildSizingVolatilityPresentation(input)).toEqual(buildSizingVolatilityPresentation({ ...input, loading: false }));
  expect(buildSizingVolatilityVerification(input).result).toBe('18.00% annualized');
});

test('shows measured volatility below the sizing floor without substituting the effective sizing denominator', () => {
  const input = makeInput({ reference: makeReference({
    band: { volatility: 0.08, effectiveVolatility: 0.1, floorApplied: true },
    rv: { rv63: 0.07, rv252: 0.08 },
  }) });
  expect(buildSizingVolatilityPresentation(input).display).toEqual({ text: '8.0%', badge: null });
  expect(buildSizingVolatilityVerification(input)).toMatchObject({
    equation: 'RV₆₃ = 7.00% · RV₂₅₂ = 8.00% · SizingVol = 8.00% · N = 252 · Observations = 300',
    result: '8.00% annualized',
  });
});

test('does not coerce numeric strings or expose nonfinite measured volatility as a display or verification', () => {
  ['0.18', NaN, Infinity, -Infinity, null, undefined].forEach(volatility => {
    const input = makeInput({ reference: makeReference({
      reason: 'Realized volatility unavailable.',
      band: { volatility },
    }) });
    expect(buildSizingVolatilityPresentation(input)).toEqual({
      metric: {
        value: 'Unavailable',
        meta: 'Realized volatility unavailable.',
        title,
        tone: 'is-muted',
        className: '',
        buttonLabel: null,
      },
      display: null,
    });
    expect(buildSizingVolatilityVerification(input)).toBeNull();
  });
});

test.each([
  [false, false, '', null, []],
  [true, false, ' · Limited history', { className: 'is-limited', label: 'Limited' }, ['Limited-history warning.']],
  [false, true, ' · Spike', { className: 'is-spike', label: 'Spike' }, ['Spike warning.']],
  [true, true, ' · Limited history · Spike', { className: 'is-spike', label: 'Spike' }, ['Limited-history warning.', 'Spike warning.']],
])('preserves badge priority and warning order for limited=%s, spike=%s', (limitedHistory, spikeWarning, suffix, badge, warnings) => {
  const input = makeInput({ reference: makeReference({ rv: { limitedHistory, spikeWarning, warnings } }) });
  expect(buildSizingVolatilityPresentation(input)).toMatchObject({
    metric: { meta: `max(63d, 1Y) realized · Sep 10, 2026${suffix}`, tone: 'is-muted' },
    display: { text: '18.0%', badge },
  });
  expect(buildSizingVolatilityVerification(input).details).toEqual([...warnings, ...standardDetails]);
});

test('uses n/a for missing or nonnumeric lookbacks without replacing a prepared measured volatility', () => {
  const input = makeInput({ reference: makeReference({ rv: {
    rv63: '0.18',
    rv252: undefined,
    limitedHistory: true,
    annualizationFactor: undefined,
    observationCount: undefined,
    warnings: undefined,
  } }) });
  expect(buildSizingVolatilityVerification(input)).toMatchObject({
    equation: 'RV₆₃ = n/a · RV₂₅₂ = n/a · SizingVol = 18.00% · N = 252 · Observations = 0',
    details: standardDetails,
  });
  expect(buildSizingVolatilityPresentation(input).display).toEqual({
    text: '18.0%', badge: { className: 'is-limited', label: 'Limited' },
  });
  [NaN, Infinity, -Infinity].forEach(rv252 => {
    expect(buildSizingVolatilityVerification(makeInput({ reference: makeReference({ rv: { rv252 } }) })).equation)
      .toContain('RV₂₅₂ = n/a');
  });
});

test('preserves 365-day annualization and observation counts while retaining the original falsy fallbacks', () => {
  const input = makeInput({ symbol: 'BTC', reference: makeReference({ rv: { annualizationFactor: 365, observationCount: 731 } }) });
  expect(buildSizingVolatilityVerification(input).equation).toContain('N = 365 · Observations = 731');
  const zeroInput = makeInput({ reference: makeReference({
    band: { volatility: 0 },
    rv: { rv63: 0, rv252: 0, annualizationFactor: 0, observationCount: 0 },
  }) });
  expect(buildSizingVolatilityPresentation(zeroInput).display).toEqual({ text: '0.0%', badge: null });
  expect(buildSizingVolatilityVerification(zeroInput).equation)
    .toBe('RV₆₃ = 0.00% · RV₂₅₂ = 0.00% · SizingVol = 0.00% · N = 252 · Observations = 0');
});

test('does not mutate input references and returns fresh independently editable projection objects', () => {
  const warnings = Object.freeze(['Original warning.']);
  const reference = makeReference({ rv: { warnings, spikeWarning: true } });
  Object.freeze(reference.band);
  Object.freeze(reference.rv);
  Object.freeze(reference);
  const input = Object.freeze(makeInput({ reference }));
  const first = buildSizingVolatilityPresentation(input);
  const second = buildSizingVolatilityPresentation(input);
  const firstVerification = buildSizingVolatilityVerification(input);
  const secondVerification = buildSizingVolatilityVerification(input);
  expect(second).toEqual(first);
  expect(second).not.toBe(first);
  expect(second.metric).not.toBe(first.metric);
  expect(second.display).not.toBe(first.display);
  expect(second.display.badge).not.toBe(first.display.badge);
  expect(secondVerification).toEqual(firstVerification);
  expect(secondVerification).not.toBe(firstVerification);
  expect(secondVerification.details).not.toBe(firstVerification.details);
  first.metric.value = 'Edited only here';
  first.display.badge.label = 'Edited badge';
  firstVerification.details.push('Edited explanation');
  expect(second.metric.value).toBe('18.0%');
  expect(second.display.badge.label).toBe('Spike');
  expect(secondVerification.details).toEqual(['Original warning.', ...standardDetails]);
  expect(reference.rv.warnings).toEqual(['Original warning.']);
  expect(first.metric).not.toHaveProperty('onClick');
});

test('defers malformed warning iteration until verification is built, preserving the original click-time boundary', () => {
  const input = makeInput({ reference: makeReference({ rv: { warnings: { invalid: 'not iterable' } } }) });
  expect(() => buildSizingVolatilityPresentation(input)).not.toThrow();
  expect(buildSizingVolatilityPresentation(input).metric.value).toBe('18.0%');
  expect(() => buildSizingVolatilityVerification(input)).toThrow(TypeError);
  input.reference.available = false;
  expect(buildSizingVolatilityVerification(input)).toBeNull();
});

test('reads warning details only when building verification, not while preparing the cell', () => {
  const input = makeInput();
  const readWarnings = jest.fn(() => ['Latest warning at explanation time.']);
  Object.defineProperty(input.reference.rv, 'warnings', { get: readWarnings });
  buildSizingVolatilityPresentation(input);
  expect(readWarnings).not.toHaveBeenCalled();
  expect(buildSizingVolatilityVerification(input).details).toEqual(['Latest warning at explanation time.', ...standardDetails]);
  expect(readWarnings).toHaveBeenCalledTimes(1);
});
