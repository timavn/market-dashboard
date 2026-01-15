/**
 * Global market configuration for the Day-Cycle Header component.
 * Includes timezone data, market hours, and pre/post market sessions.
 */

export const GLOBAL_MARKETS = [
  {
    id: 'nyc',
    code: 'NY',
    name: 'New York Stock Exchange',
    timezone: 'America/New_York',
    marketOpen: { hour: 9, minute: 30 },
    marketClose: { hour: 16, minute: 0 },
    preMarketOpen: { hour: 4, minute: 0 },
    postMarketClose: { hour: 20, minute: 0 }
  },
  {
    id: 'chi',
    code: 'CHI',
    name: 'Chicago Mercantile Exchange',
    timezone: 'America/Chicago',
    // CME Globex has extended hours, using core equity hours
    marketOpen: { hour: 8, minute: 30 },
    marketClose: { hour: 15, minute: 0 },
    preMarketOpen: { hour: 3, minute: 0 },
    postMarketClose: { hour: 19, minute: 0 }
  },
  {
    id: 'lax',
    code: 'LA',
    name: 'Pacific Exchange',
    timezone: 'America/Los_Angeles',
    // Follows NYSE hours in local time
    marketOpen: { hour: 6, minute: 30 },
    marketClose: { hour: 13, minute: 0 },
    preMarketOpen: { hour: 1, minute: 0 },
    postMarketClose: { hour: 17, minute: 0 }
  },
  {
    id: 'lon',
    code: 'LDN',
    name: 'London Stock Exchange',
    timezone: 'Europe/London',
    marketOpen: { hour: 8, minute: 0 },
    marketClose: { hour: 16, minute: 30 },
    preMarketOpen: null,
    postMarketClose: null
  },
  {
    id: 'hkg',
    code: 'HK',
    name: 'Hong Kong Stock Exchange',
    timezone: 'Asia/Hong_Kong',
    marketOpen: { hour: 9, minute: 30 },
    marketClose: { hour: 16, minute: 0 },
    // HKEX has a lunch break 12:00-13:00 but we simplify here
    preMarketOpen: null,
    postMarketClose: null
  },
  {
    id: 'tyo',
    code: 'TYO',
    name: 'Tokyo Stock Exchange',
    timezone: 'Asia/Tokyo',
    marketOpen: { hour: 9, minute: 0 },
    marketClose: { hour: 15, minute: 0 },
    // TSE has lunch break 11:30-12:30 but we simplify here
    preMarketOpen: null,
    postMarketClose: null
  }
];

/**
 * Get market status based on current time
 * @param {Object} market - Market configuration object
 * @param {Date} zonedTime - Current time in the market's timezone
 * @returns {'open' | 'pre-market' | 'post-market' | 'closed'}
 */
export const getMarketStatus = (market, zonedTime) => {
  const currentMinutes = zonedTime.getHours() * 60 + zonedTime.getMinutes();
  const dayOfWeek = zonedTime.getDay();

  // Weekend check (0 = Sunday, 6 = Saturday)
  if (dayOfWeek === 0 || dayOfWeek === 6) {
    return 'closed';
  }

  const openMinutes = market.marketOpen.hour * 60 + market.marketOpen.minute;
  const closeMinutes = market.marketClose.hour * 60 + market.marketClose.minute;

  // Regular trading hours
  if (currentMinutes >= openMinutes && currentMinutes < closeMinutes) {
    return 'open';
  }

  // Pre-market hours
  if (market.preMarketOpen) {
    const preOpenMinutes = market.preMarketOpen.hour * 60 + market.preMarketOpen.minute;
    if (currentMinutes >= preOpenMinutes && currentMinutes < openMinutes) {
      return 'pre-market';
    }
  }

  // Post-market hours
  if (market.postMarketClose) {
    const postCloseMinutes = market.postMarketClose.hour * 60 + market.postMarketClose.minute;
    if (currentMinutes >= closeMinutes && currentMinutes < postCloseMinutes) {
      return 'post-market';
    }
  }

  return 'closed';
};

/**
 * Calculate countdown to next market event
 * @param {Object} market - Market configuration object
 * @param {Date} zonedTime - Current time in the market's timezone
 * @param {'open' | 'pre-market' | 'post-market' | 'closed'} status - Current market status
 * @returns {string} Human-readable countdown string
 */
export const getMarketCountdown = (market, zonedTime, status) => {
  const currentMinutes = zonedTime.getHours() * 60 + zonedTime.getMinutes();
  const dayOfWeek = zonedTime.getDay();

  const openMinutes = market.marketOpen.hour * 60 + market.marketOpen.minute;
  const closeMinutes = market.marketClose.hour * 60 + market.marketClose.minute;

  let targetMinutes;
  let label;

  if (status === 'open') {
    targetMinutes = closeMinutes;
    label = 'Closes in';
  } else if (status === 'pre-market') {
    targetMinutes = openMinutes;
    label = 'Opens in';
  } else if (status === 'post-market') {
    const postCloseMinutes = market.postMarketClose.hour * 60 + market.postMarketClose.minute;
    targetMinutes = postCloseMinutes;
    label = 'Post-market ends in';
  } else {
    // Closed - calculate time until next open
    if (dayOfWeek === 6) {
      // Saturday: opens Monday
      return 'Opens Monday';
    } else if (dayOfWeek === 0) {
      // Sunday: opens tomorrow
      return 'Opens tomorrow';
    } else if (currentMinutes >= closeMinutes) {
      // After hours today
      return 'Opens tomorrow';
    } else {
      // Before open today
      targetMinutes = market.preMarketOpen
        ? market.preMarketOpen.hour * 60 + market.preMarketOpen.minute
        : openMinutes;
      label = market.preMarketOpen ? 'Pre-market in' : 'Opens in';
    }
  }

  if (targetMinutes === undefined) return '';

  const diffMinutes = targetMinutes - currentMinutes;
  if (diffMinutes <= 0) return '';

  const hours = Math.floor(diffMinutes / 60);
  const minutes = diffMinutes % 60;

  if (hours > 0) {
    return `${label} ${hours}h ${minutes}m`;
  }
  return `${label} ${minutes}m`;
};
