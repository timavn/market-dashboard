// US Market Holidays for 2026 (NYSE/NASDAQ)
// Markets are closed on these dates

export const MARKET_HOLIDAYS_2026 = [
  // New Year's Day - January 1, 2026 (Thursday)
  { date: '2026-01-01', name: "New Year's Day" },
  
  // Martin Luther King Jr. Day - January 19, 2026 (3rd Monday)
  { date: '2026-01-19', name: "Martin Luther King Jr. Day" },
  
  // Presidents Day - February 16, 2026 (3rd Monday)
  { date: '2026-02-16', name: "Presidents Day" },
  
  // Good Friday - March 27, 2026
  { date: '2026-03-27', name: "Good Friday" },
  
  // Memorial Day - May 25, 2026 (last Monday)
  { date: '2026-05-25', name: "Memorial Day" },
  
  // Juneteenth - June 19, 2026 (Friday)
  { date: '2026-06-19', name: "Juneteenth" },
  
  // Independence Day - July 4, 2026 (Saturday)
  // When July 4 falls on Saturday, markets close on Friday, July 3
  { date: '2026-07-03', name: "Independence Day" },
  
  // Labor Day - September 7, 2026 (1st Monday)
  { date: '2026-09-07', name: "Labor Day" },
  
  // Thanksgiving - November 26, 2026 (4th Thursday)
  { date: '2026-11-26', name: "Thanksgiving" },
  
  // Christmas - December 25, 2026 (Friday)
  { date: '2026-12-25', name: "Christmas" },
];

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
