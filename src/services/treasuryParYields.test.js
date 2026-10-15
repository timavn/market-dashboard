const { fetchTreasuryParYieldSeries, parseTreasuryParYieldCsv } = require('./treasuryParYields.cjs');

const csv = (rows) => ['Date,"1 Mo","2 Yr","10 Yr","30 Yr"', ...rows].join('\n');

test('parses one tenor column into dated closes, skipping blank observations', () => {
  expect(parseTreasuryParYieldCsv(csv(['10/13/2026,4.10,4.79,5.21,5.56', '10/09/2026,4.13,,5.24,5.60', '1/2/2026,4.0,4.25,4.5,4.8']), '2 Yr'))
    .toEqual([{ date: '2026-10-13', close: 4.79 }, { date: '2026-01-02', close: 4.25 }]);
  expect(parseTreasuryParYieldCsv(csv(['10/13/2026,4.10,4.79,5.21,5.56']), '5 Yr')).toEqual([]);
  expect(parseTreasuryParYieldCsv('<html>error</html>', '2 Yr')).toEqual([]);
});

test('joins the requested years oldest first', async () => {
  const pages = {
    2025: csv(['12/31/2025,4.0,4.30,4.6,4.9']),
    2026: csv(['01/02/2026,4.0,4.25,4.5,4.8', '10/13/2026,4.10,4.79,5.21,5.56']),
  };
  const httpGet = jest.fn(async (url) => ({ data: pages[url.match(/\/(\d{4})\/all$/)[1]] }));
  const rows = await fetchTreasuryParYieldSeries('2 Yr', { httpGet, now: new Date('2026-10-14T12:00:00Z'), years: 2 });
  expect(httpGet).toHaveBeenCalledTimes(2);
  expect(rows.map((row) => row.date)).toEqual(['2025-12-31', '2026-01-02', '2026-10-13']);
});
