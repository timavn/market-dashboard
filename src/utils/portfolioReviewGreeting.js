const {
  addCalendarDays,
  dateKeyToUtcDate,
  isTradingDateKey,
  previousTradingDateKey,
} = require('./usEquityMarketCalendar.cjs');

const marketDateFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
});

function marketDate(value) {
  if (typeof value !== 'string' || !dateKeyToUtcDate(value.slice(0, 10))) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  if (!/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) return null;
  const parts = Object.fromEntries(marketDateFormatter.formatToParts(new Date(value)).map(({ type, value: part }) => [type, part]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function portfolioReviewGreeting(message) {
  const brief = message?.portfolioBrief;
  // Bind the opening to this saved review, never today's date or the age of its research.
  const reviewDate = [brief?.reviewedAt, message?.created_at, brief?.asOf].map(marketDate).find(Boolean);
  if (!reviewDate) return 'Good morning.';
  const sessionDate = isTradingDateKey(reviewDate) ? reviewDate : previousTradingDateKey(reviewDate);
  const year = sessionDate.slice(0, 4);
  let game = 0;
  let totalGames = 0;
  for (let date = `${year}-01-01`; date <= `${year}-12-31`; date = addCalendarDays(date, 1)) {
    if (!isTradingDateKey(date)) continue;
    totalGames += 1;
    if (date <= sessionDate) game += 1;
  }
  return `Good morning, this is game ${game}/${totalGames} of the ${year} season.`;
}
