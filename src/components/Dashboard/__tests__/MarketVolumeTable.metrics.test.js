import { calculateVolumeMetrics } from '../../../utils/volumeCardUtils';

describe('calculateVolumeMetrics', () => {
  it('returns null metrics for insufficient data', () => {
    const result = calculateVolumeMetrics([1000000]);
    expect(result).toEqual({
      priorDay: null,
      avg1M: null,
      avg3M: null,
      avg1Y: null,
      pctPriorDay: null,
      pct1M: null,
      pct3M: null,
      pct1Y: null
    });
  });

  it('computes prior day and percentage differences correctly for a simple series', () => {
    // Newest first: current day, yesterday, then trailing history
    const volumes = [
      120, // current
      100, // prior day
      100,
      100,
      100,
      100
    ];

    const result = calculateVolumeMetrics(volumes);

    // Prior day volume is current day's volume
    expect(result.priorDay).toBe(120);

    // Prior-day % vs yesterday: (120 - 100) / 100 = 20%
    expect(Math.round(result.pctPriorDay)).toBe(20);

    // 1M/3M/1Y averages all use the trailing history (all 100s here),
    // so current vs average should also be ~20%
    expect(Math.round(result.pct1M || 0)).toBe(20);
    expect(Math.round(result.pct3M || 0)).toBe(20);
    expect(Math.round(result.pct1Y || 0)).toBe(20);
  });
});

