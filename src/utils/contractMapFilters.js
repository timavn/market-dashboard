const VENUE_FILTERS = ['all', 'kalshi', 'ibkr', 'merged'];

function eventSearchText(event) {
  return [
    event.question,
    event.event_title,
    event.eventTitle,
    event.contract_title,
    event.underlying,
    event.category,
    ...(event.venues || []),
    event.venue,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function matchesVenueFilter(event, venueFilter) {
  if (!venueFilter || venueFilter === 'all') return true;
  if (venueFilter === 'merged') return event.is_merged === true;
  if (venueFilter === 'kalshi') {
    return event.venue === 'Kalshi' || (event.venues || []).includes('Kalshi');
  }
  if (venueFilter === 'ibkr') {
    return (
      event.ibkr_tradable === true ||
      event.tradable_in_ibkr === true ||
      (event.venues || []).some((v) => v !== 'Kalshi')
    );
  }
  return true;
}

function matchesCategoryFilter(event, categoryFilter) {
  if (!categoryFilter || categoryFilter === 'all') return true;
  return (event.category || 'Other Macro') === categoryFilter;
}

function matchesSearchQuery(event, searchQuery) {
  const q = (searchQuery || '').trim().toLowerCase();
  if (!q) return true;
  return eventSearchText(event).includes(q);
}

/**
 * @param {object[]} events
 * @param {object} filters
 * @param {string} [filters.categoryFilter]
 * @param {string} [filters.venueFilter]
 * @param {string} [filters.searchQuery]
 */
function filterContractMapEvents(events, filters = {}) {
  const { categoryFilter = 'all', venueFilter = 'all', searchQuery = '' } = filters;
  return events.filter(
    (event) =>
      matchesCategoryFilter(event, categoryFilter) &&
      matchesVenueFilter(event, venueFilter) &&
      matchesSearchQuery(event, searchQuery)
  );
}

/**
 * Collapse rows sharing comparison_group_id into one representative row per group.
 *
 * @param {object[]} events
 */
function groupContractMapByEvent(events) {
  const groups = new Map();
  for (const event of events) {
    const key = event.comparison_group_id || event.id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(event);
  }

  return [...groups.values()].map((group) => {
    if (group.length === 1) return group[0];
    const best = [...group].sort((a, b) => {
      const la = Number(a.open_interest ?? a.liquidity ?? a.volume ?? 0);
      const lb = Number(b.open_interest ?? b.liquidity ?? b.volume ?? 0);
      return lb - la;
    })[0];
    return {
      ...best,
      contract_count: group.length,
      grouped_contracts: group,
    };
  });
}

module.exports = {
  VENUE_FILTERS,
  eventSearchText,
  matchesVenueFilter,
  matchesCategoryFilter,
  matchesSearchQuery,
  filterContractMapEvents,
  groupContractMapByEvent,
};
