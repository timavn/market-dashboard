/**
 * Global market configuration for the Day-Cycle Header component.
 * Includes timezone data, market hours, and pre/post market sessions.
 */

/**
 * US Market Holidays for 2024-2026
 * Format: 'YYYY-MM-DD'
 * Includes: New Year's Day, MLK Day, Presidents Day, Good Friday,
 * Memorial Day, Juneteenth, Independence Day, Labor Day,
 * Thanksgiving, Christmas
 */
export const US_MARKET_HOLIDAYS = [
  // 2024
  '2024-01-01', // New Year's Day
  '2024-01-15', // Martin Luther King Jr. Day
  '2024-02-19', // Presidents Day
  '2024-03-29', // Good Friday
  '2024-05-27', // Memorial Day
  '2024-06-19', // Juneteenth
  '2024-07-04', // Independence Day
  '2024-09-02', // Labor Day
  '2024-11-28', // Thanksgiving
  '2024-12-25', // Christmas
  // 2025
  '2025-01-01', // New Year's Day
  '2025-01-20', // Martin Luther King Jr. Day
  '2025-02-17', // Presidents Day
  '2025-04-18', // Good Friday
  '2025-05-26', // Memorial Day
  '2025-06-19', // Juneteenth
  '2025-07-04', // Independence Day
  '2025-09-01', // Labor Day
  '2025-11-27', // Thanksgiving
  '2025-12-25', // Christmas
  // 2026
  '2026-01-01', // New Year's Day
  '2026-01-19', // Martin Luther King Jr. Day (TODAY!)
  '2026-02-16', // Presidents Day
  '2026-04-03', // Good Friday
  '2026-05-25', // Memorial Day
  '2026-06-19', // Juneteenth
  '2026-07-03', // Independence Day (observed)
  '2026-09-07', // Labor Day
  '2026-11-26', // Thanksgiving
  '2026-12-25', // Christmas
];

/**
 * UK/European Market Holidays for 2024-2026
 * Format: 'YYYY-MM-DD'
 */
export const UK_MARKET_HOLIDAYS = [
  // 2024
  '2024-01-01', // New Year's Day
  '2024-03-29', // Good Friday
  '2024-04-01', // Easter Monday
  '2024-05-06', // Early May Bank Holiday
  '2024-05-27', // Spring Bank Holiday
  '2024-08-26', // Summer Bank Holiday
  '2024-12-25', // Christmas Day
  '2024-12-26', // Boxing Day
  // 2025
  '2025-01-01', // New Year's Day
  '2025-04-18', // Good Friday
  '2025-04-21', // Easter Monday
  '2025-05-05', // Early May Bank Holiday
  '2025-05-26', // Spring Bank Holiday
  '2025-08-25', // Summer Bank Holiday
  '2025-12-25', // Christmas Day
  '2025-12-26', // Boxing Day
  // 2026
  '2026-01-01', // New Year's Day
  '2026-04-03', // Good Friday
  '2026-04-06', // Easter Monday
  '2026-05-04', // Early May Bank Holiday
  '2026-05-25', // Spring Bank Holiday
  '2026-08-31', // Summer Bank Holiday
  '2026-12-25', // Christmas Day
  '2026-12-28', // Boxing Day (observed)
];

/**
 * Japanese Market Holidays for 2024-2026
 * Format: 'YYYY-MM-DD'
 */
export const JP_MARKET_HOLIDAYS = [
  // 2024
  '2024-01-01', // New Year's Day
  '2024-01-02', // Bank Holiday
  '2024-01-03', // Bank Holiday
  '2024-01-08', // Coming of Age Day
  '2024-02-11', // National Foundation Day (observed on 2/12)
  '2024-02-23', // Emperor's Birthday
  '2024-03-20', // Vernal Equinox Day
  '2024-04-29', // Showa Day
  '2024-05-03', // Constitution Memorial Day
  '2024-05-06', // Children's Day (observed)
  '2024-07-15', // Marine Day
  '2024-08-12', // Mountain Day (observed)
  '2024-09-16', // Respect for the Aged Day
  '2024-09-23', // Autumnal Equinox Day (observed)
  '2024-10-14', // Sports Day
  '2024-11-04', // Culture Day (observed)
  '2024-11-23', // Labor Thanksgiving Day (observed on 11/25)
  '2024-12-31', // Bank Holiday
  // 2025
  '2025-01-01', // New Year's Day
  '2025-01-02', // Bank Holiday
  '2025-01-03', // Bank Holiday
  '2025-01-13', // Coming of Age Day
  '2025-02-11', // National Foundation Day
  '2025-02-24', // Emperor's Birthday (observed)
  '2025-03-20', // Vernal Equinox Day
  '2025-04-29', // Showa Day
  '2025-05-03', // Constitution Memorial Day (observed on 5/5)
  '2025-05-05', // Children's Day
  '2025-05-06', // Substitute Holiday
  '2025-07-21', // Marine Day
  '2025-08-11', // Mountain Day
  '2025-09-15', // Respect for the Aged Day
  '2025-09-23', // Autumnal Equinox Day
  '2025-10-13', // Sports Day
  '2025-11-03', // Culture Day
  '2025-11-24', // Labor Thanksgiving Day (observed)
  '2025-12-31', // Bank Holiday
  // 2026
  '2026-01-01', // New Year's Day
  '2026-01-02', // Bank Holiday
  '2026-01-03', // Bank Holiday
  '2026-01-12', // Coming of Age Day
  '2026-02-11', // National Foundation Day
  '2026-02-23', // Emperor's Birthday
  '2026-03-20', // Vernal Equinox Day
  '2026-04-29', // Showa Day
  '2026-05-03', // Constitution Memorial Day (observed on 5/4)
  '2026-05-04', // Greenery Day
  '2026-05-05', // Children's Day
  '2026-05-06', // Substitute Holiday
  '2026-07-20', // Marine Day
  '2026-08-11', // Mountain Day
  '2026-09-21', // Respect for the Aged Day
  '2026-09-23', // Autumnal Equinox Day
  '2026-10-12', // Sports Day
  '2026-11-03', // Culture Day
  '2026-11-23', // Labor Thanksgiving Day
  '2026-12-31', // Bank Holiday
];

/**
 * Hong Kong Market Holidays for 2024-2026
 * Format: 'YYYY-MM-DD'
 */
export const HK_MARKET_HOLIDAYS = [
  // 2024
  '2024-01-01', // New Year's Day
  '2024-02-10', // Lunar New Year
  '2024-02-12', // Lunar New Year
  '2024-02-13', // Lunar New Year
  '2024-03-29', // Good Friday
  '2024-04-01', // Easter Monday
  '2024-04-04', // Ching Ming Festival
  '2024-05-01', // Labour Day
  '2024-05-15', // Buddha's Birthday
  '2024-06-10', // Tuen Ng Festival
  '2024-07-01', // HKSAR Establishment Day
  '2024-09-18', // Day after Mid-Autumn Festival
  '2024-10-01', // National Day
  '2024-10-11', // Chung Yeung Festival
  '2024-12-25', // Christmas Day
  '2024-12-26', // Boxing Day
  // 2025
  '2025-01-01', // New Year's Day
  '2025-01-29', // Lunar New Year
  '2025-01-30', // Lunar New Year
  '2025-01-31', // Lunar New Year
  '2025-04-04', // Ching Ming Festival
  '2025-04-18', // Good Friday
  '2025-04-21', // Easter Monday
  '2025-05-01', // Labour Day
  '2025-05-05', // Buddha's Birthday
  '2025-05-31', // Tuen Ng Festival (observed on 6/2)
  '2025-07-01', // HKSAR Establishment Day
  '2025-10-01', // National Day
  '2025-10-07', // Day after Mid-Autumn Festival
  '2025-10-29', // Chung Yeung Festival
  '2025-12-25', // Christmas Day
  '2025-12-26', // Boxing Day
  // 2026
  '2026-01-01', // New Year's Day
  '2026-02-17', // Lunar New Year
  '2026-02-18', // Lunar New Year
  '2026-02-19', // Lunar New Year
  '2026-04-03', // Good Friday
  '2026-04-06', // Easter Monday (Ching Ming on 4/5 weekend)
  '2026-05-01', // Labour Day
  '2026-05-24', // Buddha's Birthday (observed)
  '2026-06-19', // Tuen Ng Festival
  '2026-07-01', // HKSAR Establishment Day
  '2026-09-26', // Day after Mid-Autumn Festival (observed on 9/28)
  '2026-10-01', // National Day
  '2026-10-19', // Chung Yeung Festival (observed)
  '2026-12-25', // Christmas Day
  '2026-12-26', // Boxing Day (observed on 12/28)
];

/**
 * Check if a date is a market holiday
 * @param {Date} date - Date to check
 * @param {string[]} holidays - Array of holiday strings in 'YYYY-MM-DD' format
 * @returns {boolean}
 */
export const isMarketHoliday = (date, holidays) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const dateStr = `${year}-${month}-${day}`;
  return holidays.includes(dateStr);
};

export const GLOBAL_MARKETS = [
  // Ordered west to east (by UTC offset)
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
 * Get the appropriate holiday list for a market
 * @param {Object} market - Market configuration object
 * @returns {string[]} Array of holiday strings
 */
const getMarketHolidays = (market) => {
  switch (market.id) {
    case 'nyc':
    case 'chi':
    case 'lax':
      return US_MARKET_HOLIDAYS;
    case 'lon':
      return UK_MARKET_HOLIDAYS;
    case 'tyo':
      return JP_MARKET_HOLIDAYS;
    case 'hkg':
      return HK_MARKET_HOLIDAYS;
    default:
      return [];
  }
};

/**
 * Get market status based on current time
 * @param {Object} market - Market configuration object
 * @param {Date} zonedTime - Current time in the market's timezone
 * @returns {'open' | 'pre-market' | 'post-market' | 'closed' | 'holiday'}
 */
export const getMarketStatus = (market, zonedTime) => {
  const currentMinutes = zonedTime.getHours() * 60 + zonedTime.getMinutes();
  const dayOfWeek = zonedTime.getDay();

  // Weekend check (0 = Sunday, 6 = Saturday)
  if (dayOfWeek === 0 || dayOfWeek === 6) {
    return 'closed';
  }

  // Holiday check
  const holidays = getMarketHolidays(market);
  if (isMarketHoliday(zonedTime, holidays)) {
    return 'holiday';
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
