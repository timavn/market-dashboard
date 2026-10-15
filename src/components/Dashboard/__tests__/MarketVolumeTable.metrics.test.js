import { calculateVolumeMetrics } from '../../../utils/volumeCardUtils';

describe('calculateVolumeMetrics', () => {
  it('returns null metrics for insufficient data', () => {
    expect(calculateVolumeMetrics([1000000])).toEqual({
      priorDay: null,
      avg1M: null,
      avg3M: null,
      avg1Y: null,
      pctPriorDay: null,
      pct1M: null,
      pct3M: null,
      pct1Y: null,
    });
  });

  it('compares the latest session with complete preceding windows', () => {
    const result = calculateVolumeMetrics([120, ...Array(250).fill(100)]);

    expect(result.priorDay).toBe(120);
    expect(result.avg1M).toBe(100);
    expect(result.avg3M).toBe(100);
    expect(result.avg1Y).toBe(100);
    expect(Math.round(result.pctPriorDay)).toBe(20);
    expect(Math.round(result.pct1M)).toBe(20);
    expect(Math.round(result.pct3M)).toBe(20);
    expect(Math.round(result.pct1Y)).toBe(20);
  });

  it('does not label a short series as a monthly or yearly average', () => {
    const result = calculateVolumeMetrics([120, ...Array(21).fill(100)]);

    expect(Math.round(result.pctPriorDay)).toBe(20);
    expect(Math.round(result.pct1M)).toBe(20);
    expect(result.avg3M).toBeNull();
    expect(result.pct3M).toBeNull();
    expect(result.avg1Y).toBeNull();
    expect(result.pct1Y).toBeNull();
  });
});
