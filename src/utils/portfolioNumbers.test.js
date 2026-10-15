import { finiteOptionalNumber } from './portfolioNumbers';

test.each([
  [null, null], [undefined, null], ['', null], [NaN, null], [Infinity, null],
  [-Infinity, null], ['invalid', null], [0, 0], [-0, -0], [-2.5, -2.5],
  ['2.5', 2.5], ['  ', 0], [true, 1], [false, 0], [[], 0], [[4], 4],
])('preserves optional portfolio conversion for %p', (value, expected) => {
  expect(finiteOptionalNumber(value)).toBe(expected);
});

test('retains existing Number conversion and errors without inventing fallback values', () => {
  expect(finiteOptionalNumber(Object.freeze({ valueOf: () => 7 }))).toBe(7);
  expect(() => finiteOptionalNumber(Symbol('invalid number'))).toThrow(TypeError);
});
