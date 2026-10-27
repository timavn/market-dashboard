const { loadNextWeekCalendar, loadUsCpiConsensus } = require('./tradingEconomicsCalendarProvider.cjs');

const NOW = Date.parse('2026-09-16T17:30:00.000Z');
const COVERAGE = { from: '2026-09-20', to: '2026-09-26' };
const COUNTRIES = ['usa', 'gbr', 'jpn', 'can', 'emu', 'deu', 'fra', 'ita'];

// Reduced provider markup: the nested country table and separate consensus /
// model-forecast columns match the public calendar's actual HTML structure.
function row({
  id = '401030', date = '2026-09-23', time = '03:30 AM', impact = 3,
  country = 'germany', title = 'S&amp;P Global Manufacturing PMI Flash',
  category = 'manufacturing pmi', url = '/germany/manufacturing-pmi',
  consensus = '54.1', modelForecast = '53.6', previous = '54.3',
} = {}) {
  return `<tr data-url="${url}" data-id="${id}" data-country="${country}"
      data-category="${category}" data-event="${title}">
    <td class=" ${date}"><span class="event-0 calendar-date-${impact}">${time}</span></td>
    <td class="calendar-item"><table><tr><td>DE</td></tr></table></td>
    <td><a class="calendar-event" href="${url}">${title}</a><span class="calendar-reference">SEP</span></td>
    <td><span id="actual">999</span></td>
    <td><span id="previous">${previous}</span><span id="revised">54.2</span></td>
    <td><a id="consensus">${consensus}</a></span></td>
    <td><a id="forecast">${modelForecast}</a></span></td>
  </tr>`;
}

function page(rows = [row()], {
  offset = -240, countries = COUNTRIES, range = '4', importance = '3', checked = true,
  coverage = COVERAGE,
} = {}) {
  const until = new Date(Date.parse(`${coverage.to}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
  return `<html><head><title>Economic Calendar</title></head><body>
    <a onclick="setCalendarRange('${range}')"><input type="checkbox" ${checked ? 'checked' : ''}>Next Week</a>
    <a onclick="setCalendarImportance('${importance}');"><input type="checkbox" checked></a>
    <ul>${COUNTRIES.map((country) => `<li class="te-c-option te-c-option-${country}">
      <input type="checkbox" ${countries.includes(country) ? 'checked' : ''}></li>`).join('')}</ul>
    <select id="DropDownListTimezone"><option selected="selected" value="${offset}">UTC ${offset / 60}</option></select>
    <input id="startDate" value="${coverage.from}"><input id="endDate" value="${until}">
    <table id="calendar"><thead><tr><th>Wednesday September 23 2026</th></tr></thead>${rows.join('')}</table>
    <div>About our calendar</div>
  </body></html>`;
}

function response(data = page(), overrides = {}) {
  return {
    status: 200, data,
    headers: { 'content-type': 'text/html; charset=utf-8', date: new Date(NOW - 30000).toUTCString() },
    ...overrides,
  };
}

function load(providerResponse = response(), options = {}) {
  const httpClient = { get: jest.fn().mockResolvedValue(providerResponse) };
  const categorizeEvent = (title) => /pmi/i.test(title) ? 'pmi' : /retail sales/i.test(title) ? 'retail_sales' : null;
  return {
    httpClient,
    result: loadNextWeekCalendar({ httpClient, requestedAt: NOW, coverage: COVERAGE, categorizeEvent, ...options }),
  };
}

describe('Trading Economics next-week calendar provider', () => {
  test('requests the public next-week controls with the ET offset and preserves source provenance', async () => {
    const { httpClient, result } = load();
    const snapshot = await result;

    expect(httpClient.get).toHaveBeenCalledWith('https://tradingeconomics.com/calendar', {
      timeout: 10000,
      headers: {
        Accept: 'text/html', 'User-Agent': 'market-dashboard-calendar/1.0',
        Cookie: 'calendar-range=4; calendar-importance=3; calendar-countries=usa,gbr,jpn,can,emu,deu,fra,ita; cal-timezone-offset=-240',
      },
    });
    expect(snapshot).toMatchObject({
      status: 'verified', provider: 'Trading Economics', providerMode: 'calendar-page',
      timezone: 'America/New_York', coverage: COVERAGE,
      fetchedAt: '2026-09-16T17:30:00.000Z', sourceUpdatedAt: null,
      sourceObservedAt: '2026-09-16T17:29:30.000Z', sourceUrl: 'https://tradingeconomics.com/calendar',
    });
    expect(snapshot.events).toEqual([{
      id: 'te-401030', name: 'S&P Global Manufacturing PMI Flash', category: 'pmi',
      country: 'Germany', countryCode: 'DE', currency: 'EUR',
      startAt: '2026-09-23T07:30:00.000Z', importance: 3,
      forecast: '54.1', previous: '54.3', actual: null, unit: null,
      source: 'Trading Economics', sourceUrl: 'https://tradingeconomics.com/germany/manufacturing-pmi',
      lastUpdatedAt: null, observedAt: snapshot.sourceObservedAt,
      provider: 'Trading Economics', verification: 'provider-calendar',
    }]);
  });

  test('never substitutes the provider model forecast or revised value for missing survey consensus or previous', async () => {
    const { result } = load(response(page([row({ consensus: '', previous: '' })])));
    expect((await result).events[0]).toMatchObject({ forecast: null, previous: null, actual: null });
  });

  test('filters low impact, irrelevant, tentative, all-day and missing-time rows', async () => {
    const { result } = load(response(page([
      row(), row({ id: '2', impact: 2 }), row({ id: '3', title: 'Oil Stocks', category: 'energy' }),
      row({ id: '4', time: 'Tentative' }), row({ id: '5', time: 'All Day' }), row({ id: '6', time: '' }),
    ])));
    expect((await result).events.map(({ id }) => id)).toEqual(['te-401030']);
  });

  test('correctly converts midnight, noon and late-Saturday ET across the UTC date boundary', async () => {
    const { result } = load(response(page([
      row({ id: '1', date: '2026-09-20', time: '12:00 AM' }),
      row({ id: '2', date: '2026-09-23', time: '12:00 PM' }),
      row({ id: '3', date: '2026-09-26', time: '11:30 PM' }),
      row({ id: '4', date: '2026-09-27', time: '12:30 AM' }),
    ])));
    expect((await result).events.map(({ startAt }) => startAt)).toEqual([
      '2026-09-20T04:00:00.000Z', '2026-09-23T16:00:00.000Z', '2026-09-27T03:30:00.000Z',
    ]);
  });

  test('uses the winter ET offset', async () => {
    const coverage = { from: '2026-12-20', to: '2026-12-26' };
    const { result, httpClient } = load(response(page([row({ date: '2026-12-23', time: '08:30 AM' })], { offset: -300, coverage })), {
      coverage,
    });
    expect((await result).events[0].startAt).toBe('2026-12-23T13:30:00.000Z');
    expect(httpClient.get.mock.calls[0][1].headers.Cookie).toContain('cal-timezone-offset=-300');
  });

  test.each([
    ['non-HTML', response(page(), { headers: { 'content-type': 'application/json' } }), 'CALENDAR_INVALID_RESPONSE'],
    ['HTTP failure', response(page(), { status: 503 }), 'CALENDAR_INVALID_RESPONSE'],
    ['missing date', response(page(), { headers: { 'content-type': 'text/html' } }), 'CALENDAR_OBSERVATION_MISSING'],
    ['stale observation', response(page(), { headers: { 'content-type': 'text/html', date: 'Wed, 16 Sep 2026 14:00:00 GMT' } }), 'CALENDAR_SOURCE_STALE'],
    ['future observation', response(page(), { headers: { 'content-type': 'text/html', date: 'Wed, 16 Sep 2026 17:40:00 GMT' } }), 'CALENDAR_OBSERVATION_FUTURE'],
    ['wrong selected week', response(page(undefined, { range: '3' })), 'CALENDAR_SELECTION_MISMATCH'],
    ['unchecked next week', response(page(undefined, { checked: false })), 'CALENDAR_SELECTION_MISMATCH'],
    ['wrong importance', response(page(undefined, { importance: '2' })), 'CALENDAR_SELECTION_MISMATCH'],
    ['missing country', response(page(undefined, { countries: ['usa'] })), 'CALENDAR_SELECTION_MISMATCH'],
    ['wrong timezone', response(page(undefined, { offset: -300 })), 'CALENDAR_TIMEZONE_UNVERIFIED'],
    ['wrong source range despite overlapping rows', response(page(undefined, { coverage: { from: '2026-09-13', to: '2026-09-26' } })), 'CALENDAR_WEEK_MISMATCH'],
    ['missing source range', response(page().replace('<input id="endDate" value="2026-09-27">', '')), 'CALENDAR_WEEK_MISMATCH'],
    ['incomplete calendar', response(page().replace('</table>\n', '<tr><td>Load more events</td></tr></table>\n')), 'CALENDAR_INVALID_RESPONSE'],
    ['wrong source title', response(page().replace('<title>Economic Calendar</title>', '<title>Access Denied</title>')), 'CALENDAR_INVALID_RESPONSE'],
    ['impossible date', response(page([row({ date: '2026-02-30' })])), 'CALENDAR_INVALID_RESPONSE'],
    ['entirely wrong week', response(page([row({ date: '2026-09-16' })])), 'CALENDAR_WEEK_MISMATCH'],
    ['unapproved source host', response(page([row({ url: '//example.com/inflation' })])), 'CALENDAR_INVALID_RESPONSE'],
    ['missing calendar rows', response(page([])), 'CALENDAR_INVALID_RESPONSE'],
    ['truncated row', response(page().replace('</table></td>', '')), 'CALENDAR_INVALID_RESPONSE'],
  ])('fails closed for %s', async (_description, source, code) => {
    await expect(load(source).result).rejects.toMatchObject({ code, safeReason: expect.stringContaining('Trading Economics') });
  });

  test('does not trust selected controls appearing only inside a script', async () => {
    const html = page().replace('setCalendarRange(\'4\')', 'setCalendarRange(\'3\')');
    await expect(load(response(html.replace('</body>', `<script>${page()}</script></body>`))).result)
      .rejects.toMatchObject({ code: 'CALENDAR_SELECTION_MISMATCH' });
  });

  test('deduplicates identical rows but rejects conflicting occurrences of one provider ID', async () => {
    expect((await load(response(page([row(), row()]))).result).events).toHaveLength(1);
    await expect(load(response(page([row(), row({ consensus: '50.0' })]))).result)
      .rejects.toMatchObject({ code: 'CALENDAR_INVALID_RESPONSE' });
    await expect(load(response(page([row(), row({ time: '04:30 AM' })]))).result)
      .rejects.toMatchObject({ code: 'CALENDAR_INVALID_RESPONSE' });
  });

  test('propagates provider disconnection without manufacturing events', async () => {
    const offline = new Error('offline');
    await expect(load(undefined, { httpClient: { get: jest.fn().mockRejectedValue(offline) } }).result).rejects.toBe(offline);
  });

  test.each([
    [{ from: '2026-03-08', to: '2026-03-14' }, -300, -240, '2026-03-08', '12:30 AM', '2026-03-09', '08:30 AM', '09:30 AM', '2026-03-08T05:30:00.000Z'],
    [{ from: '2026-11-01', to: '2026-11-07' }, -240, -300, '2026-11-01', '12:30 AM', '2026-11-02', '09:30 AM', '08:30 AM', '2026-11-01T04:30:00.000Z'],
  ])('covers both ET offsets in transition week %j', async (coverage, firstOffset, secondOffset, startDate, startTime, duplicateDate, firstClock, secondClock, firstInstant) => {
    const first = response(page([
      row({ id: '1', date: startDate, time: startTime }),
      row({ id: '2', date: duplicateDate, time: firstClock }),
    ], { offset: firstOffset, coverage }));
    const second = response(page([
      row({ id: '2', date: duplicateDate, time: secondClock }),
      row({ id: '3', date: coverage.to, time: '11:30 PM' }),
    ], { offset: secondOffset, coverage }), {
      headers: { 'content-type': 'text/html', date: 'Wed, 16 Sep 2026 17:29:50 GMT' },
    });
    const httpClient = { get: jest.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second) };
    const snapshot = await load(undefined, { coverage, httpClient }).result;
    expect(httpClient.get).toHaveBeenCalledTimes(2);
    expect(snapshot.events.map(({ id }) => id)).toEqual(['te-1', 'te-2', 'te-3']);
    expect(snapshot.events[0].startAt).toBe(firstInstant);
    expect(snapshot.sourceObservedAt).toBe('2026-09-16T17:29:30.000Z');
    expect(snapshot.events.every(({ observedAt }) => observedAt === snapshot.sourceObservedAt)).toBe(true);
    expect(snapshot.events[2].startAt).toBe(coverage.from.startsWith('2026-03')
      ? '2026-03-15T03:30:00.000Z' : '2026-11-08T04:30:00.000Z');
  });
});

describe('Trading Economics US CPI consensus', () => {
  // Reduced from the US CPI page: its header cells are malformed (a <th> closed by </td>).
  const cpiRow = (id, date, name, reference, actual, previous, consensus) => `<tr data-id="${id}" data-country="United States">
    <td>${date}</td><td>12:30 PM</td><td><div class='d-none'>${name}</div></td><td id="reference">${reference}</span></td>
    <td id="actual">${actual}</td><td id="previous">${previous}</td><td>${consensus}</td><td>3.6%</td></tr>`;
  const cpiPage = (rows, headings = '<th>Calendar</td><th>GMT</th><th colspan="2"><span>Reference</span></th></th><th>Actual</th><th>Previous</th><th>Consensus</th><th>TEForecast</th>') =>
    `<html><head><title>United States Inflation Rate</title></head><body>
    <table id="calendar"><thead><tr>${headings}</tr></thead><tbody>${rows.join('')}</tbody></table></body></html>`;
  const loadCpi = (data) => loadUsCpiConsensus({ httpClient: { get: jest.fn().mockResolvedValue(response(data)) }, requestedAt: NOW });

  test('reads each CPI YoY print’s survey consensus, not the model forecast, by its reference month', async () => {
    const result = await loadCpi(cpiPage([
      cpiRow('1', '2026-10-14', 'Inflation Rate YoY', 'Sep', '3.7%', '3.4%', '3.6%'),
      cpiRow('2', '2026-10-14', 'Core Inflation Rate YoY', 'Sep', '3.1%', '3.0%', '3.0%'),
      cpiRow('3', '2026-11-10', 'Inflation Rate YoY', 'Oct', '', '3.7%', ''),
      cpiRow('4', '2027-01-13', 'Inflation Rate YoY', 'Dec', '', '', '3.5%'),
    ]));
    expect(result.releases).toEqual([
      { reportMonth: '2026-09', releaseDate: '2026-10-14', consensus: 3.6, previous: 3.4, actual: 3.7 },
      { reportMonth: '2026-10', releaseDate: '2026-11-10', consensus: null, previous: 3.7, actual: null },
      { reportMonth: '2026-12', releaseDate: '2027-01-13', consensus: 3.5, previous: null, actual: null },
    ]);
    expect(result.sourceUrl).toBe('https://tradingeconomics.com/united-states/inflation-cpi');
  });

  test('rejects a page whose calendar columns changed rather than misreading them', async () => {
    const shuffled = '<th>Calendar</th><th>GMT</th><th>Reference</th><th>Actual</th><th>Consensus</th><th>Previous</th><th>TEForecast</th>';
    await expect(loadCpi(cpiPage([cpiRow('1', '2026-10-14', 'Inflation Rate YoY', 'Sep', '3.7%', '3.4%', '3.6%')], shuffled)))
      .rejects.toMatchObject({ code: 'CALENDAR_INVALID_RESPONSE' });
  });
});
