import { getVolumeCardHeaderDate } from '../../../utils/volumeCardUtils';

describe('getVolumeCardHeaderDate', () => {
  it('returns "3/9" when asOf is 2026-03-09 (yesterday semantics)', () => {
    const response = {
      asOf: '2026-03-09',
      totalMarket: [{ date: '2026-03-09', volume: 1e8 }],
      totalExchange: [{ date: '2026-03-09', volume: 5e7 }]
    };
    expect(getVolumeCardHeaderDate(response)).toBe('3/9');
  });

  it('uses first date in totalMarket when asOf is missing', () => {
    const response = {
      totalMarket: [{ date: '2026-03-10', volume: 1e8 }, { date: '2026-03-09', volume: 9e7 }],
      totalExchange: []
    };
    expect(getVolumeCardHeaderDate(response)).toBe('3/10');
  });

  it('falls back to totalExchange when totalMarket is empty', () => {
    const response = {
      totalMarket: [],
      totalExchange: [{ date: '2026-03-09', volume: 5e7 }]
    };
    expect(getVolumeCardHeaderDate(response)).toBe('3/9');
  });

  it('returns empty string when response has no dates', () => {
    expect(getVolumeCardHeaderDate({})).toBe('');
    expect(getVolumeCardHeaderDate({ totalMarket: [], totalExchange: [] })).toBe('');
    expect(getVolumeCardHeaderDate(null)).toBe('');
  });
});
