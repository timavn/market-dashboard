const PROVIDER = 'Trading Economics';
const SOURCE_URL = 'https://tradingeconomics.com/calendar';
const CPI_URL = 'https://tradingeconomics.com/united-states/inflation-cpi';
const TIME_ZONE = 'America/New_York';
const MAX_OBSERVATION_AGE_MS = 2 * 60 * 60 * 1000;
const FUTURE_TOLERANCE_MS = 2 * 60 * 1000;
const COUNTRIES = Object.freeze({
  'united states': { country: 'United States', countryCode: 'US', currency: 'USD', selector: 'usa' },
  'united kingdom': { country: 'United Kingdom', countryCode: 'UK', currency: 'GBP', selector: 'gbr' },
  japan: { country: 'Japan', countryCode: 'JP', currency: 'JPY', selector: 'jpn' },
  canada: { country: 'Canada', countryCode: 'CA', currency: 'CAD', selector: 'can' },
  'euro area': { country: 'Euro Area', countryCode: 'EU', currency: 'EUR', selector: 'emu' },
  germany: { country: 'Germany', countryCode: 'DE', currency: 'EUR', selector: 'deu' },
  france: { country: 'France', countryCode: 'FR', currency: 'EUR', selector: 'fra' },
  italy: { country: 'Italy', countryCode: 'IT', currency: 'EUR', selector: 'ita' },
});
const COUNTRY_SELECTORS = Object.values(COUNTRIES).map(({ selector }) => selector);

function fail(code, safeReason) {
  throw Object.assign(new Error(safeReason), { code, safeReason });
}

function invalidResponse() {
  fail('CALENDAR_INVALID_RESPONSE', 'The Trading Economics calendar could not be verified.');
}

function decodeText(value) {
  const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return String(value ?? '').replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (raw, entity) => {
    if (entity[0] !== '#') return entities[entity.toLowerCase()] || raw;
    const code = entity[1].toLowerCase() === 'x'
      ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : raw;
  });
}

function plainText(value, maxLength = 160) {
  const text = decodeText(String(value ?? '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, maxLength) : null;
}

function attributes(openingTag) {
  const result = {};
  const content = openingTag.replace(/^<\/?[\w-]+\b/, '').replace(/\/?\s*>$/, '');
  for (const match of content.matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
    result[match[1].toLowerCase()] = decodeText(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return result;
}

// These provider tables contain nested country tables. Match balanced elements
// so neither a nested </tr> nor a later event can supply another row's fields.
function elementAt(html, opening, tag) {
  const tokens = new RegExp(`<\\/?${tag}\\b[^>]*>`, 'gi');
  tokens.lastIndex = opening.index + opening[0].length;
  let depth = 1;
  let token;
  while ((token = tokens.exec(html))) {
    depth += token[0].startsWith('</') ? -1 : 1;
    if (!depth) {
      return {
        attrs: attributes(opening[0]),
        inner: html.slice(opening.index + opening[0].length, token.index),
        end: tokens.lastIndex,
      };
    }
  }
  invalidResponse();
}

function elements(html, tag, matches = () => true) {
  const openings = new RegExp(`<${tag}\\b[^>]*>`, 'gi');
  const found = [];
  let opening;
  while ((opening = openings.exec(html))) {
    if (!matches(attributes(opening[0]))) continue;
    const element = elementAt(html, opening, tag);
    found.push(element);
    openings.lastIndex = element.end;
  }
  return found;
}

function hasCheckedInput(html) {
  return [...html.matchAll(/<input\b[^>]*>/gi)].some(([tag]) => Object.hasOwn(attributes(tag), 'checked'));
}

function hasSelectedControl(html, call, value) {
  const pattern = new RegExp(`^\\s*${call}\\(\\s*['"]${value}['"]\\s*\\)\\s*;?\\s*$`);
  return elements(html, 'a', ({ onclick }) => pattern.test(onclick || ''))
    .some(({ inner }) => hasCheckedInput(inner));
}

function verifySelection(html, requestedOffset, coverage, { range, importance }) {
  const titles = elements(html, 'title');
  if (titles.length !== 1 || !/^(?:Economic )?Calendar$/i.test(plainText(titles[0].inner) || '')
      || !/<\/body\s*>\s*<\/html\s*>\s*$/i.test(html)) invalidResponse();
  if (!hasSelectedControl(html, 'setCalendarRange', range)
      || !hasSelectedControl(html, 'setCalendarImportance', importance)) {
    fail('CALENDAR_SELECTION_MISMATCH', 'The Trading Economics calendar did not return the requested week.');
  }
  const countries = elements(html, 'li', (attrs) => /(?:^|\s)te-c-option-[a-z]{3}(?:\s|$)/i.test(attrs.class || ''))
    .filter(({ inner }) => hasCheckedInput(inner))
    .map(({ attrs }) => attrs.class.match(/(?:^|\s)te-c-option-([a-z]{3})(?:\s|$)/i)[1].toLowerCase());
  if (countries.sort().join(',') !== [...COUNTRY_SELECTORS].sort().join(',')) {
    fail('CALENDAR_SELECTION_MISMATCH', 'The Trading Economics calendar did not return the requested countries.');
  }
  const timezone = elements(html, 'select', ({ id }) => id === 'DropDownListTimezone');
  const selected = timezone.length === 1
    ? elements(timezone[0].inner, 'option', (attrs) => Object.hasOwn(attrs, 'selected')) : [];
  if (selected.length !== 1 || selected[0].attrs.value !== String(requestedOffset)
      || plainText(selected[0].inner) !== `UTC ${requestedOffset / 60}`) {
    fail('CALENDAR_TIMEZONE_UNVERIFIED', 'The Trading Economics calendar timezone could not be verified.');
  }
  const inputs = [...html.matchAll(/<input\b[^>]*>/gi)].map(([tag]) => attributes(tag));
  const startDates = inputs.filter(({ id }) => id === 'startDate');
  const endDates = inputs.filter(({ id }) => id === 'endDate');
  const exclusiveEnd = new Date(Date.parse(`${coverage.to}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
  if (startDates.length !== 1 || endDates.length !== 1
      || startDates[0].value !== coverage.from || endDates[0].value !== exclusiveEnd) {
    fail('CALENDAR_WEEK_MISMATCH', 'The Trading Economics calendar does not match the requested ET week.');
  }
}

function headerValue(headers, name) {
  if (typeof headers?.get === 'function') return headers.get(name);
  const key = Object.keys(headers || {}).find((candidate) => candidate.toLowerCase() === name);
  return key ? headers[key] : null;
}

function observationTime(response, requestedAt) {
  const raw = headerValue(response.headers, 'date');
  const observedAt = raw ? Date.parse(raw) : NaN;
  if (!Number.isFinite(observedAt)) {
    fail('CALENDAR_OBSERVATION_MISSING', 'The Trading Economics calendar observation time could not be verified.');
  }
  if (requestedAt - observedAt > MAX_OBSERVATION_AGE_MS) {
    fail('CALENDAR_SOURCE_STALE', 'The Trading Economics calendar observation is too old.');
  }
  if (observedAt - requestedAt > FUTURE_TOLERANCE_MS) {
    fail('CALENDAR_OBSERVATION_FUTURE', 'The Trading Economics calendar observation time could not be verified.');
  }
  return new Date(observedAt).toISOString();
}

function validDateKey(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

function etDateKey(value) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(value));
  const fields = Object.fromEntries(parts.map(({ type, value: part }) => [type, part]));
  return `${fields.year}-${fields.month}-${fields.day}`;
}

function weekOffsets(coverage) {
  // ET changes offset on Sunday. Include both boundary offsets in a transition
  // week, then filter the union by IANA ET dates, so no boundary hour disappears.
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, timeZoneName: 'shortOffset' });
  return [...new Set([`${coverage.from}T00:00:00Z`, `${coverage.to}T23:59:59Z`].map((value) => {
    const offsetName = formatter.formatToParts(new Date(value)).find(({ type }) => type === 'timeZoneName')?.value;
    const hour = offsetName?.match(/^GMT(-[45])$/)?.[1];
    if (!hour) invalidResponse();
    return Number(hour) * 60;
  }))];
}

function sourceUrl(relativeUrl) {
  if (!relativeUrl || !/^\/(?!\/)/.test(relativeUrl) || /[\\\s]/.test(relativeUrl)) invalidResponse();
  const url = new URL(relativeUrl, SOURCE_URL);
  if (url.origin !== 'https://tradingeconomics.com') invalidResponse();
  return url.href;
}

function valueById(html, id) {
  const matches = ['a', 'span'].flatMap((tag) => elements(html, tag, (attrs) => attrs.id === id));
  if (matches.length > 1) invalidResponse();
  return matches.length ? plainText(matches[0].inner, 80) : null;
}

function parseRows(html, coverage, offsetMinutes) {
  const tables = elements(html, 'table', ({ id }) => id === 'calendar');
  if (tables.length !== 1) invalidResponse();
  const tableText = plainText(tables[0].inner, Infinity);
  if (/\b(?:load more|show more|more events|truncated|row limit|maximum number of (?:rows|events))\b/i.test(tableText || '')) invalidResponse();
  const rows = elements(tables[0].inner, 'tr', (attrs) => Object.hasOwn(attrs, 'data-event'));
  if (!rows.length) invalidResponse();
  const fingerprints = new Map();
  const parsed = [];
  let coveredRows = 0;
  for (const { attrs, inner } of rows) {
    const id = attrs['data-id'];
    if (!/^\d+$/.test(id || '')) invalidResponse();
    const dateCell = elements(inner, 'td', ({ class: classes }) => /(?:^|\s)\d{4}-\d{2}-\d{2}(?:\s|$)/.test(classes || ''));
    if (dateCell.length !== 1) invalidResponse();
    const dateKey = dateCell[0].attrs.class.match(/\b\d{4}-\d{2}-\d{2}\b/)[0];
    if (!validDateKey(dateKey)) invalidResponse();
    const clockElements = elements(dateCell[0].inner, 'span', ({ class: classes }) => /(?:^|\s)event-\d+(?:\s|$)/.test(classes || ''));
    if (clockElements.length !== 1) invalidResponse();
    const clock = plainText(clockElements[0].inner);
    const time = clock?.match(/^(0?[1-9]|1[0-2]):([0-5]\d)\s*(AM|PM)$/i);
    const baseFingerprint = JSON.stringify({ dateKey, clock, event: attrs['data-event'], country: attrs['data-country'] });
    const baseKey = `raw-${id}`;
    if (fingerprints.has(baseKey) && fingerprints.get(baseKey) !== baseFingerprint) invalidResponse();
    fingerprints.set(baseKey, baseFingerprint);
    if (!time) continue; // All-day and tentative releases have no verified instant.
    const titleElements = elements(inner, 'a', ({ class: classes }) => /(?:^|\s)calendar-event(?:\s|$)/.test(classes || ''));
    // Auctions and tenders are plain calendar entries, not indicator releases.
    if (!titleElements.length && attrs['data-category'] === 'calendar') continue;
    if (titleElements.length !== 1) invalidResponse();
    const name = plainText(titleElements[0].inner);
    const region = COUNTRIES[String(attrs['data-country'] || '').toLowerCase()];
    if (!name || !region) invalidResponse();
    const previous = valueById(inner, 'previous');
    // TE's separate forecast column is a model forecast, not survey consensus.
    const forecast = valueById(inner, 'consensus');
    const actual = valueById(inner, 'actual');
    const url = sourceUrl(attrs['data-url']);
    const highImpact = /(?:^|\s)calendar-date-3(?:\s|$)/.test(clockElements[0].attrs.class || '');
    const fingerprint = JSON.stringify({ name, dateKey, clock, country: region.countryCode, previous, forecast, url, highImpact });
    if (fingerprints.has(id)) {
      if (fingerprints.get(id) !== fingerprint) invalidResponse();
      continue;
    }
    fingerprints.set(id, fingerprint);
    const hour = (Number(time[1]) % 12) + (time[3].toUpperCase() === 'PM' ? 12 : 0);
    const sourceClock = `${dateKey}T${String(hour).padStart(2, '0')}:${time[2]}:00.000Z`;
    const startAt = new Date(Date.parse(sourceClock) - offsetMinutes * 60000).toISOString();
    const eventDate = etDateKey(startAt);
    if (eventDate < coverage.from || eventDate > coverage.to) continue;
    coveredRows += 1;
    parsed.push({
      id, name, region, startAt, previous, forecast, actual, url, highImpact,
      categoryText: plainText(attrs['data-category']) || '',
    });
  }
  return { rows: parsed, coveredRows };
}

function validLoadArguments({ httpClient, requestedAt, coverage }) {
  if (!httpClient?.get || !Number.isFinite(requestedAt) || !validDateKey(coverage?.from)
      || !validDateKey(coverage?.to)) invalidResponse();
  if (Date.parse(`${coverage.to}T00:00:00Z`) - Date.parse(`${coverage.from}T00:00:00Z`) !== 6 * 86400000
      || new Date(`${coverage.from}T00:00:00Z`).getUTCDay() !== 0) invalidResponse();
}

async function loadCalendarPages({ httpClient, requestedAt, coverage, range, importance }) {
  const pages = await Promise.all(weekOffsets(coverage).map(async (offsetMinutes) => {
    const cookie = `calendar-range=${range}; calendar-importance=${importance}; calendar-countries=${COUNTRY_SELECTORS.join(',')}; cal-timezone-offset=${offsetMinutes}`;
    const response = await httpClient.get(SOURCE_URL, {
      timeout: 10000,
      headers: { Accept: 'text/html', 'User-Agent': 'market-dashboard-calendar/1.0', Cookie: cookie },
    });
    if (response?.status !== 200 || typeof response.data !== 'string'
        || !/^text\/html(?:\s*;|$)/i.test(headerValue(response.headers, 'content-type') || '')) invalidResponse();
    const observedAt = observationTime(response, requestedAt);
    const html = response.data.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<!--[\s\S]*?-->/g, '');
    verifySelection(html, offsetMinutes, coverage, { range, importance });
    return { ...parseRows(html, coverage, offsetMinutes), observedAt };
  }));
  if (!pages.some(({ coveredRows }) => coveredRows > 0)) {
    fail('CALENDAR_WEEK_MISMATCH', 'The Trading Economics calendar does not match the requested ET week.');
  }
  return { rows: pages.flatMap((page) => page.rows), observedAt: pages.map((page) => page.observedAt).sort()[0] };
}

async function loadNextWeekCalendar({ httpClient, requestedAt, coverage, categorizeEvent } = {}) {
  validLoadArguments({ httpClient, requestedAt, coverage });
  if (typeof categorizeEvent !== 'function') invalidResponse();
  const { rows, observedAt } = await loadCalendarPages({ httpClient, requestedAt, coverage, range: '4', importance: '3' });
  const byId = new Map();
  for (const row of rows) {
    if (!row.highImpact) continue;
    const category = categorizeEvent(`${row.name} ${row.categoryText}`);
    if (!category) continue;
    const event = {
      id: `te-${row.id}`, name: row.name, category,
      country: row.region.country, countryCode: row.region.countryCode, currency: row.region.currency,
      startAt: row.startAt, importance: 3, forecast: row.forecast, previous: row.previous, actual: null, unit: null,
      source: PROVIDER, sourceUrl: row.url, lastUpdatedAt: null, observedAt,
      provider: PROVIDER, verification: 'provider-calendar',
    };
    if (byId.has(event.id) && JSON.stringify(byId.get(event.id)) !== JSON.stringify(event)) invalidResponse();
    byId.set(event.id, event);
  }
  const events = [...byId.values()].sort((left, right) => left.startAt.localeCompare(right.startAt) || left.id.localeCompare(right.id));
  return {
    status: 'verified', provider: PROVIDER, providerMode: 'calendar-page', timezone: TIME_ZONE,
    coverage: { ...coverage }, fetchedAt: new Date(requestedAt).toISOString(),
    sourceUpdatedAt: null, sourceObservedAt: observedAt, sourceUrl: SOURCE_URL,
    code: null, reason: null,
    events,
  };
}

// Released figures for the current ET week. Every importance level is
// requested because the primary calendar's high-impact set is broader than
// Trading Economics' own (e.g. Core PPI and Core Retail Sales).
async function loadCurrentWeekActuals({ httpClient, requestedAt, coverage } = {}) {
  validLoadArguments({ httpClient, requestedAt, coverage });
  const { rows, observedAt } = await loadCalendarPages({ httpClient, requestedAt, coverage, range: '3', importance: '1' });
  const byId = new Map();
  for (const row of rows) {
    if (!/\d/.test(row.actual || '')) continue;
    const release = {
      id: `te-${row.id}`, name: row.name, countryCode: row.region.countryCode,
      startAt: row.startAt, actual: row.actual, previous: row.previous, sourceUrl: row.url,
    };
    // A figure that changed between the two DST-week pages is not verified.
    if (byId.has(release.id) && byId.get(release.id)?.actual !== release.actual) byId.set(release.id, null);
    else if (!byId.has(release.id)) byId.set(release.id, release);
  }
  return {
    provider: PROVIDER, sourceUrl: SOURCE_URL, observedAt,
    releases: [...byId.values()].filter(Boolean),
  };
}

// Survey consensus for US CPI YoY prints, from the release calendar on Trading
// Economics' US CPI page. A print's consensus is blank until economists are surveyed.
const CPI_HEADINGS = 'Calendar GMT Reference Actual Previous Consensus TEForecast';
const MONTH_NUMBERS = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };

function percentValue(text) {
  const match = String(text || '').match(/^(-?\d+(?:\.\d+)?)%$/);
  return match ? Number(match[1]) : null;
}

async function loadUsCpiConsensus({ httpClient, requestedAt } = {}) {
  if (!httpClient?.get || !Number.isFinite(requestedAt)) invalidResponse();
  const response = await httpClient.get(CPI_URL, {
    timeout: 10000,
    headers: { Accept: 'text/html', 'User-Agent': 'market-dashboard-calendar/1.0' },
  });
  if (response?.status !== 200 || typeof response.data !== 'string'
      || !/^text\/html(?:\s*;|$)/i.test(headerValue(response.headers, 'content-type') || '')) invalidResponse();
  const observedAt = observationTime(response, requestedAt);
  const html = response.data.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<!--[\s\S]*?-->/g, '');
  const tables = elements(html, 'table', ({ id }) => id === 'calendar');
  if (tables.length !== 1) invalidResponse();
  // The page's header cells are not well formed, so the header is checked as text.
  const heads = elements(tables[0].inner, 'thead');
  if (heads.length !== 1 || plainText(heads[0].inner) !== CPI_HEADINGS) invalidResponse();
  const releases = [];
  for (const { inner } of elements(tables[0].inner, 'tr', (attrs) => /^\d+$/.test(attrs['data-id'] || ''))) {
    const cells = elements(inner, 'td').map((cell) => plainText(cell.inner));
    if (cells.length !== 8 || !validDateKey(cells[0])) invalidResponse();
    const [releaseDate, , name, reference, actual, previous, consensus] = cells;
    const month = MONTH_NUMBERS[reference];
    if (name !== 'Inflation Rate YoY' || !month) continue;
    // December prints in January: a reference month after the release month is the prior year.
    const releaseMonth = Number(releaseDate.slice(5, 7));
    const year = Number(releaseDate.slice(0, 4)) - (month > releaseMonth ? 1 : 0);
    releases.push({
      reportMonth: `${year}-${String(month).padStart(2, '0')}`, releaseDate,
      consensus: percentValue(consensus), previous: percentValue(previous), actual: percentValue(actual),
    });
  }
  if (!releases.length) invalidResponse();
  return { provider: PROVIDER, sourceUrl: CPI_URL, observedAt, releases };
}

module.exports = { PROVIDER, SOURCE_URL, loadCurrentWeekActuals, loadNextWeekCalendar, loadUsCpiConsensus };
