import { formatOverviewPrice } from './formatOverviewPrice';

describe('formatOverviewPrice', () => {
  test.each([
    [7639.04, '7,639'],
    [544.38, '544'],
    [100, '100'],
    [99.96, '100'],
    [63.47, '63.5'],
    [10, '10'],
    [9.999, '10'],
    [2.5278, '2.53'],
    [2.5, '2.5'],
    [1, '1'],
    [0.9999, '1'],
    [0.45678, '0.457'],
    [0.004567, '0.00457'],
    [0.00000012345, '0.000000123'],
    [0.1, '0.1'],
    [0, '0'],
    [-0, '0'],
    [-7639.04, '-7,639'],
    [-63.47, '-63.5'],
    [-2.5278, '-2.53'],
    [-0.004567, '-0.00457'],
  ])('formats %s as %s', (value, expected) => {
    expect(formatOverviewPrice(value)).toBe(expected);
  });

  test.each([null, undefined, '', '2.5', true, NaN, Infinity, -Infinity])(
    'does not manufacture a price from %s',
    (value) => expect(formatOverviewPrice(value)).toBe('—'),
  );
});
