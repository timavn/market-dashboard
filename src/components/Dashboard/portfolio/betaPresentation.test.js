import { buildBetaVerification } from './betaPresentation';

// Test-only validated historical references. Provider acceptance and operand/date formatting remain in the owner.
const makeBeta = (overrides = {}) => ({
  value: 1.42,
  benchmark: 'SPY',
  observations: 250,
  windowSessions: 252,
  asOf: '2026-09-10',
  ...overrides,
});

const makeInput = (overrides = {}) => ({
  symbol: 'AMZN',
  beta: makeBeta(),
  covarianceLabel: '0.000142',
  benchmarkVarianceLabel: '0.000100',
  asOfLabel: 'Sep 10, 2026',
  ...overrides,
});

const exposureCaveat = 'It helps assess market exposure; it does not capture every price swing or predict the next move. Size uses total volatility.';

test('preserves the complete positive beta calculation payload and historical-reference language', () => {
  expect(buildBetaVerification(makeInput())).toEqual({
    symbol: 'AMZN',
    metric: 'Beta',
    formula: 'Beta = covariance of AMZN and SPY returns ÷ variance of SPY returns',
    equation: '0.000142 ÷ 0.000100 = 1.42',
    result: '1.42',
    takeaway: `Beta shows how sensitive AMZN has been to moves in SPY, the stock-market benchmark. A 1% move in SPY has been associated with about a 1.42% move in AMZN in the same direction, on average. ${exposureCaveat}`,
    details: ['250 aligned daily returns', 'Completed adjusted closes', 'As of Sep 10, 2026'],
  });
});

test('preserves negative beta in the result while describing its absolute magnitude and opposite direction', () => {
  const result = buildBetaVerification(makeInput({
    symbol: 'TLT',
    beta: makeBeta({ value: -0.45 }),
    covarianceLabel: '-0.000045',
  }));
  expect(result.result).toBe('-0.45');
  expect(result.equation).toBe('-0.000045 ÷ 0.000100 = -0.45');
  expect(result.takeaway).toBe(`Beta shows how sensitive TLT has been to moves in SPY, the stock-market benchmark. A 1% move in SPY has been associated with about a 0.45% move in TLT in the opposite direction, on average. ${exposureCaveat}`);
});

test.each([
  [0, '0.00', null],
  [-0, '0.00', null],
  [0.0049, '0.00', null],
  [-0.0049, '-0.00', null],
  [0.005, '0.01', 'same'],
  [-0.005, '-0.01', 'opposite'],
])('preserves the strict near-zero threshold for beta %s', (value, formatted, direction) => {
  const result = buildBetaVerification(makeInput({ beta: makeBeta({ value }) }));
  expect(result.result).toBe(formatted);
  expect(result.equation).toBe(`0.000142 ÷ 0.000100 = ${formatted}`);
  const explanation = direction === null
    ? 'A beta near zero means AMZN has shown little tendency to move with the market.'
    : `A 1% move in SPY has been associated with about a 0.01% move in AMZN in the ${direction} direction, on average.`;
  expect(result.takeaway).toBe(`Beta shows how sensitive AMZN has been to moves in SPY, the stock-market benchmark. ${explanation} ${exposureCaveat}`);
});

test('preserves the existing Number conversion for numeric beta strings', () => {
  ['1.42', '-0.45', '0.0049', '-0', ' 1.42 '].forEach(value => {
    expect(buildBetaVerification(makeInput({ beta: makeBeta({ value }) })))
      .toEqual(buildBetaVerification(makeInput({ beta: makeBeta({ value: Number(value) }) })));
  });
});

test('uses aligned-return counts when one or both formatted operands are null, undefined, or omitted', () => {
  [
    [null, '0.000100'],
    ['0.000142', null],
    [undefined, '0.000100'],
    ['0.000142', undefined],
    [null, null],
    [undefined, undefined],
  ].forEach(([covarianceLabel, benchmarkVarianceLabel]) => {
    const result = buildBetaVerification(makeInput({ covarianceLabel, benchmarkVarianceLabel }));
    expect(result.equation).toBe('250 aligned daily returns = 1.42');
    expect(result.result).toBe('1.42');
  });
  expect(buildBetaVerification({ symbol: 'AMZN', beta: makeBeta(), asOfLabel: 'Sep 10, 2026' }).equation)
    .toBe('250 aligned daily returns = 1.42');
});

test('keeps zero operand labels and never recalculates the accepted beta value from display operands', () => {
  expect(buildBetaVerification(makeInput({ covarianceLabel: '0', benchmarkVarianceLabel: '0' })).equation)
    .toBe('0 ÷ 0 = 1.42');
  const result = buildBetaVerification(makeInput({ covarianceLabel: '9', benchmarkVarianceLabel: '3' }));
  expect(result.equation).toBe('9 ÷ 3 = 1.42');
  expect(result.result).toBe('1.42');
});

test.each([
  [{ benchmark: 'QQQ', observations: 300, windowSessions: 63 }, 'QQQ', '300'],
  [{ benchmark: '', observations: 0, windowSessions: 63 }, 'SPY', '63'],
  [{ benchmark: undefined, observations: undefined, windowSessions: 0 }, 'SPY', '252'],
  [{ benchmark: null, observations: '0', windowSessions: 63 }, 'SPY', '0'],
])('preserves benchmark and observations/window default precedence for %j', (overrides, benchmark, count) => {
  const result = buildBetaVerification(makeInput({
    beta: makeBeta(overrides), covarianceLabel: null, benchmarkVarianceLabel: null,
  }));
  expect(result.formula).toBe(`Beta = covariance of AMZN and ${benchmark} returns ÷ variance of ${benchmark} returns`);
  expect(result.equation).toBe(`${count} aligned daily returns = 1.42`);
  expect(result.details[0]).toBe(`${count} aligned daily returns`);
  expect(result.takeaway).toContain(`moves in ${benchmark}, the stock-market benchmark.`);
  expect(result.takeaway).toContain(`A 1% move in ${benchmark}`);
});

test('uses supplied operand and date labels verbatim rather than formatting source fields again', () => {
  const beta = makeBeta({
    asOf: 'not the display date',
    calculation: { covarianceSum: 400, benchmarkVarianceSum: 2 },
  });
  const result = buildBetaVerification(makeInput({
    beta,
    covarianceLabel: '1.4200e−4',
    benchmarkVarianceLabel: ' 0.00010000 ',
    asOfLabel: 'Completed session · custom date label',
  }));
  expect(result.equation).toBe('1.4200e−4 ÷  0.00010000  = 1.42');
  expect(result.details[2]).toBe('As of Completed session · custom date label');
  expect(buildBetaVerification(makeInput({ covarianceLabel: '', benchmarkVarianceLabel: '', asOfLabel: '' })))
    .toMatchObject({ equation: ' ÷  = 1.42', details: ['250 aligned daily returns', 'Completed adjusted closes', 'As of '] });
});

test.each([null, undefined])('keeps unavailable beta explicit and ignores populated display labels when beta is %s', beta => {
  expect(buildBetaVerification(makeInput({
    beta,
    covarianceLabel: '0.000142',
    benchmarkVarianceLabel: '0.000100',
    asOfLabel: 'Sep 10, 2026',
  }))).toEqual({
    symbol: 'AMZN',
    metric: 'Beta',
    formula: 'Beta = covariance of AMZN and SPY returns ÷ variance of SPY returns',
    equation: 'Not calculated — verified aligned return history is unavailable.',
    result: 'Unavailable',
    takeaway: `Beta shows how sensitive AMZN has been to moves in SPY, the stock-market benchmark. Matching daily return history is needed to calculate it. ${exposureCaveat}`,
    details: ['Historical beta inputs are unavailable.'],
  });
});

test('does not mutate validated inputs and returns a fresh payload and details array on each call', () => {
  const calculation = Object.freeze({ covarianceSum: 0.000142, benchmarkVarianceSum: 0.0001 });
  const beta = Object.freeze(makeBeta({ calculation }));
  const input = Object.freeze(makeInput({ beta }));
  const first = buildBetaVerification(input);
  const second = buildBetaVerification(input);
  expect(second).toEqual(first);
  expect(second).not.toBe(first);
  expect(second.details).not.toBe(first.details);
  first.result = 'Edited only here';
  first.details.push('Edited explanation');
  expect(second.result).toBe('1.42');
  expect(second.details).toEqual(['250 aligned daily returns', 'Completed adjusted closes', 'As of Sep 10, 2026']);
  expect(beta).toEqual(makeBeta({ calculation }));
  const unavailable = makeInput({ beta: null });
  expect(buildBetaVerification(unavailable).details).not.toBe(buildBetaVerification(unavailable).details);
});

test('returns plain explanation strings and no callbacks or presentation elements', () => {
  const result = buildBetaVerification(makeInput({
    symbol: '<button>AMZN</button>',
    covarianceLabel: '<span>0.000142</span>',
    asOfLabel: '<time>Sep 10, 2026</time>',
  }));
  expect(Object.keys(result)).toEqual(['symbol', 'metric', 'formula', 'equation', 'result', 'takeaway', 'details']);
  Object.entries(result).filter(([key]) => key !== 'details').forEach(([, value]) => {
    expect(typeof value).toBe('string');
  });
  result.details.forEach(value => expect(typeof value).toBe('string'));
  expect(result.symbol).toBe('<button>AMZN</button>');
  expect(result.equation).toBe('<span>0.000142</span> ÷ 0.000100 = 1.42');
  expect(result.details[2]).toBe('As of <time>Sep 10, 2026</time>');
  expect(result).not.toHaveProperty('onClick');
});
