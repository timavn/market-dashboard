import { filterLotsBySearch } from './realizedGainLossUtils';

describe('filterLotsBySearch', () => {
  const lots = [
    { symbol: 'AAAU', name: 'Gold ETF' },
    { symbol: 'SPY', name: 'S&P 500' },
  ];

  it('returns all lots when query empty', () => {
    expect(filterLotsBySearch(lots, '')).toEqual(lots);
    expect(filterLotsBySearch(lots, '   ')).toEqual(lots);
  });

  it('filters by symbol substring', () => {
    expect(filterLotsBySearch(lots, 'AAA')).toEqual([lots[0]]);
    expect(filterLotsBySearch(lots, 'aaau')).toEqual([lots[0]]);
  });

  it('filters by name substring', () => {
    expect(filterLotsBySearch(lots, 'gold')).toEqual([lots[0]]);
  });

  it('handles null lots', () => {
    expect(filterLotsBySearch(null, 'x')).toEqual([]);
  });
});
