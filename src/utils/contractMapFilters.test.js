const {
  filterContractMapEvents,
  groupContractMapByEvent,
  matchesVenueFilter,
  matchesCategoryFilter,
  matchesSearchQuery,
} = require('./contractMapFilters');

describe('contractMapFilters', () => {
  const sampleEvents = [
    {
      id: 'kalshi:1',
      venue: 'Kalshi',
      venues: ['Kalshi'],
      category: 'Index',
      question: 'Will SPX close above 6000?',
      event_title: 'SPX June',
      underlying: 'SPX',
      is_merged: false,
      ibkr_tradable: false,
      comparison_group_id: 'cg_a',
    },
    {
      id: 'cme:2',
      venue: 'CME',
      venues: ['CME', 'Kalshi'],
      category: 'Index',
      question: 'Will SPX close above 6000?',
      event_title: 'SPX June',
      underlying: 'SPX',
      is_merged: true,
      ibkr_tradable: true,
      tradable_in_ibkr: true,
      comparison_group_id: 'cg_a',
    },
    {
      id: 'kalshi:3',
      venue: 'Kalshi',
      venues: ['Kalshi'],
      category: 'Rates',
      question: 'Fed funds above 5%?',
      underlying: 'FF',
      is_merged: false,
      comparison_group_id: 'cg_b',
    },
  ];

  test('matchesCategoryFilter', () => {
    expect(matchesCategoryFilter(sampleEvents[0], 'Index')).toBe(true);
    expect(matchesCategoryFilter(sampleEvents[0], 'Rates')).toBe(false);
    expect(matchesCategoryFilter(sampleEvents[0], 'all')).toBe(true);
  });

  test('matchesVenueFilter', () => {
    expect(matchesVenueFilter(sampleEvents[0], 'kalshi')).toBe(true);
    expect(matchesVenueFilter(sampleEvents[1], 'ibkr')).toBe(true);
    expect(matchesVenueFilter(sampleEvents[1], 'merged')).toBe(true);
    expect(matchesVenueFilter(sampleEvents[0], 'merged')).toBe(false);
  });

  test('matchesSearchQuery', () => {
    expect(matchesSearchQuery(sampleEvents[0], 'spx')).toBe(true);
    expect(matchesSearchQuery(sampleEvents[2], 'bitcoin')).toBe(false);
  });

  test('filterContractMapEvents combines filters', () => {
    const filtered = filterContractMapEvents(sampleEvents, {
      categoryFilter: 'Index',
      venueFilter: 'ibkr',
      searchQuery: 'spx',
    });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].id).toBe('cme:2');
  });

  test('groupContractMapByEvent collapses shared comparison groups', () => {
    const grouped = groupContractMapByEvent(sampleEvents);
    expect(grouped).toHaveLength(2);
    const spxGroup = grouped.find((e) => e.comparison_group_id === 'cg_a');
    expect(spxGroup.contract_count).toBe(2);
  });
});
