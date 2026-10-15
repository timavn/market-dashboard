const { usEquityMarketHolidays } = require('../utils/usEquityMarketCalendar.cjs');

// Compatibility export for older consumers; the recurring NYSE calendar is
// authoritative so this list cannot drift from session-date calculations.
export const MARKET_HOLIDAYS_2026 = usEquityMarketHolidays(2026);

// Helper function to get holiday dates as Date objects
export const getHolidayDates = () => {
  return MARKET_HOLIDAYS_2026.map(holiday => ({
    date: new Date(holiday.date + 'T00:00:00'),
    name: holiday.name
  }));
};

// Helper function to format date as YYYY-MM-DD for comparison
export const formatDateKey = (date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};
