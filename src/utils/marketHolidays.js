const {
  getUsEquityHoliday,
  isTradingDateKey,
} = require('./usEquityMarketCalendar.cjs');

const formatLocalDateKey = (date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

/**
 * Check if a given date is a US market holiday
 * @param {Date} date - The date to check
 * @returns {boolean} - True if the date is a market holiday
 */
export const isMarketHoliday = (date) => {
  return Boolean(getUsEquityHoliday(formatLocalDateKey(date)));
};

/**
 * Get the name of the holiday for a given date
 * @param {Date} date - The date to check
 * @returns {string|null} - The name of the holiday, or null if not a holiday
 */
export const getHolidayName = (date) => {
  const holiday = getUsEquityHoliday(formatLocalDateKey(date));
  return holiday ? holiday.name : null;
};

/**
 * Check if a date is a trading day (not weekend and not holiday)
 * @param {Date} date - The date to check
 * @returns {boolean} - True if the date is a trading day
 */
export const isTradingDay = (date) => {
  return isTradingDateKey(formatLocalDateKey(date));
};

/**
 * Count actual trading days between two dates (inclusive)
 * Excludes weekends and holidays
 * @param {Date} startDate - Start date (inclusive)
 * @param {Date} endDate - End date (inclusive)
 * @returns {number} - Number of trading days
 */
export const getTradingDaysCount = (startDate, endDate) => {
  let count = 0;
  const current = new Date(startDate);
  current.setHours(0, 0, 0, 0);
  
  const end = new Date(endDate);
  end.setHours(0, 0, 0, 0);
  
  while (current <= end) {
    if (isTradingDay(current)) {
      count++;
    }
    current.setDate(current.getDate() + 1);
  }
  
  return count;
};
