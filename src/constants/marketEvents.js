/**
 * Market Events Data Structure
 * Defines recurring market events and their typical schedules
 * Events are organized by type and include metadata for display
 */

// Event types for categorization
export const EVENT_TYPES = {
  EARNINGS: 'earnings',
  ECONOMIC_DATA: 'economic',
  CENTRAL_BANK: 'central_bank',
  EMPLOYMENT: 'employment',
  INFLATION: 'inflation',
  GDP: 'gdp',
  OTHER: 'other'
};

// Event type colors for badges
export const EVENT_TYPE_COLORS = {
  [EVENT_TYPES.EARNINGS]: 'blue',
  [EVENT_TYPES.ECONOMIC_DATA]: 'purple',
  [EVENT_TYPES.CENTRAL_BANK]: 'amber',
  [EVENT_TYPES.EMPLOYMENT]: 'green',
  [EVENT_TYPES.INFLATION]: 'red',
  [EVENT_TYPES.GDP]: 'indigo',
  [EVENT_TYPES.OTHER]: 'gray'
};

/**
 * Get events for a specific month
 * @param {number} year - Year (e.g., 2025)
 * @param {number} month - Month (0-11, where 0 = January)
 * @returns {Array} Array of events for that month
 */
export const getEventsForMonth = (year, month) => {
  const events = [];
  
  // Helper to create date objects
  const createDate = (day) => new Date(year, month, day);
  
  // Weekly events (typically Thursdays)
  // Jobless Claims - Every Thursday
  const firstThursday = getFirstDayOfWeek(year, month, 4); // 4 = Thursday
  for (let week = 0; week < 5; week++) {
    const thursday = new Date(firstThursday);
    thursday.setDate(firstThursday.getDate() + (week * 7));
    if (thursday.getMonth() === month) {
      events.push({
        date: thursday,
        name: 'Jobless Claims',
        type: EVENT_TYPES.EMPLOYMENT,
        time: '8:30 AM ET',
        frequency: 'weekly'
      });
    }
  }
  
  // Monthly events
  // ISM Manufacturing PMI - First business day of month
  const firstBusinessDay = getFirstBusinessDay(year, month);
  events.push({
    date: firstBusinessDay,
    name: 'ISM Manufacturing PMI',
    type: EVENT_TYPES.ECONOMIC_DATA,
    time: '10:00 AM ET',
    frequency: 'monthly'
  });
  
  // ISM Services PMI - Third business day of month
  const thirdBusinessDay = getNthBusinessDay(year, month, 3);
  events.push({
    date: thirdBusinessDay,
    name: 'ISM Services PMI',
    type: EVENT_TYPES.ECONOMIC_DATA,
    time: '10:00 AM ET',
    frequency: 'monthly'
  });
  
  // JOLTS - First Tuesday of month (after first Monday)
  const firstMonday = getFirstDayOfWeek(year, month, 1);
  const firstTuesday = new Date(firstMonday);
  firstTuesday.setDate(firstMonday.getDate() + 1);
  events.push({
    date: firstTuesday,
    name: 'JOLTS Job Openings',
    type: EVENT_TYPES.EMPLOYMENT,
    time: '10:00 AM ET',
    frequency: 'monthly'
  });
  
  // Non-Farm Payrolls - First Friday of month
  const firstFriday = getFirstDayOfWeek(year, month, 5);
  events.push({
    date: firstFriday,
    name: 'Non-Farm Payrolls',
    type: EVENT_TYPES.EMPLOYMENT,
    time: '8:30 AM ET',
    frequency: 'monthly'
  });
  
  // CPI (Inflation) - Around 10th-15th of month
  const cpiDate = new Date(year, month, 12); // Rough estimate
  events.push({
    date: cpiDate,
    name: 'CPI (Consumer Price Index)',
    type: EVENT_TYPES.INFLATION,
    time: '8:30 AM ET',
    frequency: 'monthly'
  });
  
  // PPI - Around 13th-15th of month
  const ppiDate = new Date(year, month, 14); // Rough estimate
  events.push({
    date: ppiDate,
    name: 'PPI (Producer Price Index)',
    type: EVENT_TYPES.INFLATION,
    time: '8:30 AM ET',
    frequency: 'monthly'
  });
  
  // GDP - Quarterly (typically last Thursday/Friday of month in Jan, Apr, Jul, Oct)
  if ([0, 3, 6, 9].includes(month)) { // Jan, Apr, Jul, Oct
    const lastDay = new Date(year, month + 1, 0); // Last day of month
    const gdpDate = getLastBusinessDay(year, month);
    events.push({
      date: gdpDate,
      name: 'GDP (Advance/Revised)',
      type: EVENT_TYPES.GDP,
      time: '8:30 AM ET',
      frequency: 'quarterly'
    });
  }
  
  // FOMC Meetings - Typically 8 times per year
  // Rough schedule: Jan, Mar, May, Jun, Jul, Sep, Nov, Dec
  const fomcMonths = [0, 2, 4, 5, 6, 8, 10, 11]; // 0-indexed
  if (fomcMonths.includes(month)) {
    // Typically middle of month, around 13th-15th
    const fomcDate = new Date(year, month, 14);
    events.push({
      date: fomcDate,
      name: 'FOMC Meeting',
      type: EVENT_TYPES.CENTRAL_BANK,
      time: '2:00 PM ET',
      frequency: 'periodic'
    });
  }
  
  // Earnings season reminders (typically mid-Jan, mid-Apr, mid-Jul, mid-Oct)
  if ([0, 3, 6, 9].includes(month)) {
    const earningsDate = new Date(year, month, 15);
    events.push({
      date: earningsDate,
      name: 'Earnings Season Begins',
      type: EVENT_TYPES.EARNINGS,
      time: 'Market Open',
      frequency: 'quarterly'
    });
  }
  
  return events.sort((a, b) => a.date.getDate() - b.date.getDate());
};

/**
 * Helper: Get first occurrence of a weekday in a month
 * @param {number} year 
 * @param {number} month 
 * @param {number} dayOfWeek - 0 = Sunday, 1 = Monday, ..., 6 = Saturday
 * @returns {Date}
 */
const getFirstDayOfWeek = (year, month, dayOfWeek) => {
  const firstDay = new Date(year, month, 1);
  const day = firstDay.getDay();
  const diff = (dayOfWeek - day + 7) % 7;
  return new Date(year, month, 1 + diff);
};

/**
 * Helper: Get first business day of month (skip weekends)
 * @param {number} year 
 * @param {number} month 
 * @returns {Date}
 */
const getFirstBusinessDay = (year, month) => {
  const firstDay = new Date(year, month, 1);
  while (firstDay.getDay() === 0 || firstDay.getDay() === 6) {
    firstDay.setDate(firstDay.getDate() + 1);
  }
  return firstDay;
};

/**
 * Helper: Get Nth business day of month
 * @param {number} year 
 * @param {number} month 
 * @param {number} n - Nth business day (1-indexed)
 * @returns {Date}
 */
const getNthBusinessDay = (year, month, n) => {
  let date = new Date(year, month, 1);
  let businessDays = 0;
  
  while (businessDays < n) {
    if (date.getDay() !== 0 && date.getDay() !== 6) {
      businessDays++;
      if (businessDays === n) break;
    }
    date.setDate(date.getDate() + 1);
  }
  
  return date;
};

/**
 * Helper: Get last business day of month
 * @param {number} year 
 * @param {number} month 
 * @returns {Date}
 */
const getLastBusinessDay = (year, month) => {
  const lastDay = new Date(year, month + 1, 0); // Last day of month
  while (lastDay.getDay() === 0 || lastDay.getDay() === 6) {
    lastDay.setDate(lastDay.getDate() - 1);
  }
  return lastDay;
};

/**
 * Format date key for storage/lookup
 * @param {Date} date 
 * @returns {string} YYYY-MM-DD format
 */
export const formatDateKey = (date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};




