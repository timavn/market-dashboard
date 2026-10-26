import {
  buildSizingVolatilityPresentation,
  buildSizingVolatilityVerification,
} from './sizingVolatilityPresentation';

// Test-only validated references; provider acceptance remains with the portfolio owner.
// ATR % = ATR14 / close; the 2 × ATR stop distance uses the measured ATR %, and the
// 1.25% floor only flags the band (MIN / MAX), never the displayed ATR.
const makeReference = ({ atr = 2.08, close = 104, ...overrides } = {}) => ({
  available: true,
  atr14: { value: atr, observations: 14, asOf: '2026-09-10' },
  referencePrice: { value: close, observations: 1, asOf: '2026-09-10' },
  relativeAtr: atr / close,
  floorApplied: atr / close < 0.0125,
  stopDistance: (2 * atr) / close,
  asOf: '2026-09-10',
  ...overrides,
});

const makeInput = (overrides = {}) => ({
  symbol: 'IAK',
  reference: makeReference(),
  loading: false,
  asOfLabel: 'Sep 10, 2026',
  ...overrides,
});

const title = 'Sizing uses the 14-day ATR as a share of the last completed close. Reference only — not options IV.';
const formula = 'ATR % = ATR14 ÷ close; stop distance = 2 × ATR %';
const standardDetails = [
  'Completed daily bars through 2026-09-10.',
  'Leveraged/inverse ETFs use their own price history.',
  'Reference-only / non-executable.',
];
const floorDetail = 'Below the 1.25% floor: the floor sets MIN / MAX; the stop uses the measured ATR.';

test.each([
  // 2.08 / 104 = 2.00%; stop = 2 × 2.00% = 4.00%.
  [2.08, 104, '2.00%', '2.08', '104.00', '4.00'],
  // 2.32 / 58 = 4.00%; stop = 2 × 4.00% = 8.00%.
  [2.32, 58, '4.00%', '2.32', '58.00', '8.00'],
])('preserves complete cell and explanation projections for ATR %s on close %s', (atr, close, cellText, atrText, closeText, stopText) => {
  const input = makeInput({ reference: makeReference({ atr, close }) });
  expect(buildSizingVolatilityPresentation(input)).toEqual({
    metric: {
      value: cellText,
      meta: 'ATR14 ÷ close · Sep 10, 2026',
      title,
      tone: 'is-muted',
      className: 'is-reference',
      buttonLabel: 'Verify IAK sizing ATR',
    },
    display: { text: cellText, badge: null },
  });
  expect(buildSizingVolatilityVerification(input)).toEqual({
    symbol: 'IAK',
    metric: 'Sizing ATR',
    formula,
    equation: `ATR14 = ${atrText} · Close = ${closeText} · ATR % = ${cellText} · Stop distance = ${stopText}%`,
    result: `${cellText} of price`,
    details: standardDetails,
  });
});

test('shows two-decimal ATR % in both the cell and the explanation and preserves supplied date labels', () => {
  // 3.1 / 112.5 = 2.7556%; stop = 5.5111%.
  const input = makeInput({
    symbol: 'TLT',
    asOfLabel: 'Completed session label',
    reference: makeReference({ atr: 3.1, close: 112.5 }),
  });
  const presentation = buildSizingVolatilityPresentation(input);
  expect(presentation.metric.value).toBe('2.76%');
  expect(presentation.display.text).toBe('2.76%');
  expect(presentation.metric.meta).toBe('ATR14 ÷ close · Completed session label');
  expect(presentation.metric.buttonLabel).toBe('Verify TLT sizing ATR');
  expect(buildSizingVolatilityVerification(input)).toMatchObject({
    symbol: 'TLT',
    equation: 'ATR14 = 3.10 · Close = 112.50 · ATR % = 2.76% · Stop distance = 5.51%',
    result: '2.76% of price',
  });
});

test.each([[false, 'Unavailable'], [true, '…']])('hides finite leftovers and explanation controls for an unavailable reference when loading is %s', (loading, value) => {
  const input = makeInput({
    loading,
    reference: makeReference({
      available: false,
      reason: 'ATR needs 14 completed sessions',
      atr: 0.5,
      close: 50,
    }),
  });
  expect(buildSizingVolatilityPresentation(input)).toEqual({
    metric: {
      value,
      meta: 'ATR needs 14 completed sessions',
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
  expect(buildSizingVolatilityVerification(input).result).toBe('2.00% of price');
});

test('shows the measured ATR below the 1.25% floor with a Floor badge and the measured stop distance', () => {
  // 0.5 / 50 = 1.00% < 1.25%: the band uses the floor, the stop uses 2 × 1.00% = 2.00%.
  const input = makeInput({ reference: makeReference({ atr: 0.5, close: 50 }) });
  expect(input.reference.floorApplied).toBe(true);
  expect(buildSizingVolatilityPresentation(input)).toMatchObject({
    metric: { value: '1.00%', meta: 'ATR14 ÷ close · Sep 10, 2026 · 1.25% floor' },
    display: { text: '1.00%', badge: { className: 'is-limited', label: 'Floor' } },
  });
  expect(buildSizingVolatilityVerification(input)).toMatchObject({
    equation: 'ATR14 = 0.50 · Close = 50.00 · ATR % = 1.00% · Stop distance = 2.00%',
    result: '1.00% of price',
    details: [floorDetail, ...standardDetails],
  });
});

test('does not show the Floor badge at or above the 1.25% floor', () => {
  // 1.25 / 100 = 1.25% is not below the floor.
  const input = makeInput({ reference: makeReference({ atr: 1.25, close: 100 }) });
  expect(input.reference.floorApplied).toBe(false);
  expect(buildSizingVolatilityPresentation(input)).toMatchObject({
    metric: { meta: 'ATR14 ÷ close · Sep 10, 2026' },
    display: { text: '1.25%', badge: null },
  });
  expect(buildSizingVolatilityVerification(input).details).toEqual(standardDetails);
});

test('does not coerce numeric strings or expose nonfinite ATR % as a display or verification', () => {
  ['0.02', NaN, Infinity, -Infinity, null, undefined].forEach(relativeAtr => {
    const input = makeInput({ reference: makeReference({
      reason: 'Verified closing price needed',
      relativeAtr,
    }) });
    expect(buildSizingVolatilityPresentation(input)).toEqual({
      metric: {
        value: 'Unavailable',
        meta: 'Verified closing price needed',
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

test('does not mutate input references and returns fresh independently editable projection objects', () => {
  const reference = makeReference({ atr: 0.5, close: 50 });
  Object.freeze(reference.atr14);
  Object.freeze(reference.referencePrice);
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
  expect(second.metric.value).toBe('1.00%');
  expect(second.display.badge.label).toBe('Floor');
  expect(secondVerification.details).toEqual([floorDetail, ...standardDetails]);
  expect(reference.atr14.value).toBe(0.5);
  expect(first.metric).not.toHaveProperty('onClick');
});

test('reads ATR and close inputs only when building verification, not while preparing the cell', () => {
  const input = makeInput();
  const readAtr = jest.fn(() => ({ value: 2.08 }));
  const readClose = jest.fn(() => ({ value: 104 }));
  Object.defineProperty(input.reference, 'atr14', { get: readAtr });
  Object.defineProperty(input.reference, 'referencePrice', { get: readClose });
  buildSizingVolatilityPresentation(input);
  expect(readAtr).not.toHaveBeenCalled();
  expect(readClose).not.toHaveBeenCalled();
  expect(buildSizingVolatilityVerification(input).equation)
    .toBe('ATR14 = 2.08 · Close = 104.00 · ATR % = 2.00% · Stop distance = 4.00%');
  expect(readAtr).toHaveBeenCalledTimes(1);
  expect(readClose).toHaveBeenCalledTimes(1);
});
