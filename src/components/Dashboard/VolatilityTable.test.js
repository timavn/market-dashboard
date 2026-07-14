import { VOL_RANGES, getBucketForSeries } from './VolatilityTable';

describe('volatility regime buckets', () => {
  test('uses the corrected VIX boundaries', () => {
    expect(getBucketForSeries('VIX', 19.99)).toBe('green');
    expect(getBucketForSeries('VIX', 20)).toBe('yellow');
    expect(getBucketForSeries('VIX', 28.99)).toBe('yellow');
    expect(getBucketForSeries('VIX', 29)).toBe('red');
  });

  test('uses the MOVE end-of-day regime boundaries', () => {
    expect(getBucketForSeries('MOVE', 99.99)).toBe('green');
    expect(getBucketForSeries('MOVE', 100)).toBe('yellow');
    expect(getBucketForSeries('MOVE', 119.99)).toBe('yellow');
    expect(getBucketForSeries('MOVE', 120)).toBe('red');
  });

  test('labels non-VIX thresholds as heuristic frameworks', () => {
    for (const name of ['RVX', 'NazVol', 'GVZ', 'OVX', 'MOVE', 'VVIX']) {
      expect(VOL_RANGES[name].source).toMatch(/Heuristic framework/i);
    }
  });
});
