const {
  addCalendarDays,
  isTradingDateKey,
  previousTradingDateKey,
} = require('./usEquityMarketCalendar.cjs');

// A non-trading date counts as the most recent session's game.
export function seasonGame(dateKey) {
  const sessionDate = isTradingDateKey(dateKey) ? dateKey : previousTradingDateKey(dateKey);
  const year = sessionDate.slice(0, 4);
  let game = 0;
  let totalGames = 0;
  for (let date = `${year}-01-01`; date <= `${year}-12-31`; date = addCalendarDays(date, 1)) {
    if (!isTradingDateKey(date)) continue;
    totalGames += 1;
    if (date <= sessionDate) game += 1;
  }
  return { game, totalGames, year };
}
