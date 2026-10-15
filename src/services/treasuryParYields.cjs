// Daily Treasury par yield curve: the official same-day source Kalshi settles
// its Treasury yield markets on. FRED's copy of these series lags by days.
const TREASURY_PAR_YIELD_URL = 'https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv';

/** Parses one year's CSV into [{ date: 'YYYY-MM-DD', close }] for one tenor column (e.g. '2 Yr'). */
function parseTreasuryParYieldCsv(text, tenor) {
  const lines = String(text || '').trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const headings = lines[0].split(',').map((heading) => heading.replace(/"/g, '').trim());
  const column = headings.indexOf(tenor);
  if (headings[0] !== 'Date' || column < 0) return [];
  return lines.slice(1).map((line) => {
    const cells = line.split(',');
    const [month, day, year] = String(cells[0] || '').split('/');
    const close = cells[column] === '' || cells[column] == null ? NaN : Number(cells[column]);
    return /^\d{4}$/.test(year || '') && month && day
      ? { date: `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`, close }
      : null;
  }).filter((row) => row && Number.isFinite(row.close));
}

/** One tenor across the current and prior years, oldest first. */
async function fetchTreasuryParYieldSeries(tenor, { httpGet, now = new Date(), years = 3 } = {}) {
  const currentYear = now.getUTCFullYear();
  const yearList = Array.from({ length: years }, (_, index) => currentYear - years + 1 + index);
  const pages = await Promise.all(yearList.map(async (year) => {
    const response = await httpGet(`${TREASURY_PAR_YIELD_URL}/${year}/all`, {
      params: { type: 'daily_treasury_yield_curve', field_tdr_date_value: year, page: '', _format: 'csv' },
      timeout: 12_000,
      responseType: 'text',
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    return parseTreasuryParYieldCsv(response?.data, tenor);
  }));
  const byDate = new Map(pages.flat().map((row) => [row.date, row]));
  const rows = [...byDate.values()].sort((left, right) => left.date.localeCompare(right.date));
  return rows.length >= 2 ? rows : null;
}

module.exports = { TREASURY_PAR_YIELD_URL, fetchTreasuryParYieldSeries, parseTreasuryParYieldCsv };
