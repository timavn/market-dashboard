const PACIFIC = 'America/Los_Angeles';
const dateFormats = new Map();
const clockFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: PACIFIC, hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short',
});
const calendarFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit',
});
const easternFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});
const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const namedMonth = '(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)';
const civilDay = `(?:\\d{4}-\\d{2}-\\d{2}|${namedMonth}\\s+\\d{1,2},?\\s+\\d{4}|\\d{1,2}\\s+${namedMonth},?\\s+\\d{4})`;
const authoredTimestamp = new RegExp(`\\b(${civilDay})(?:T|,?\\s+(?:at\\s+)?)(\\d{1,2}):(\\d{2})(?::(\\d{2})(?:\\.\\d+)?)?\\s*(AM|PM)?\\s+(UTC|GMT|ET|EST|EDT)\\b`, 'gi');
const isoTimestamp = /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})\b/gi;
// Source links and literal code are immutable evidence, not report prose.
const protectedText = /(`{3,}[\s\S]*?`{3,}|~{3,}[\s\S]*?~{3,}|`+[^`\n]*`+|\]\([^\n)]*\)|(?:[a-z][a-z\d+.-]*:\/\/|analyst-source:|source:)[^\s<>]+)/gi;

const parts = (formatter, date) => Object.fromEntries(formatter.formatToParts(date).map(part => [part.type, part.value]));

function validDay(day) {
  const date = new Date(`${day}T12:00:00Z`);
  if (!Number.isFinite(date.getTime())) return false;
  const value = parts(calendarFormat, date);
  return `${value.year}-${value.month}-${value.day}` === day;
}

function dateLabel(date, year) {
  if (!dateFormats.has(year)) dateFormats.set(year, new Intl.DateTimeFormat('en-US', {
    timeZone: PACIFIC, month: 'short', day: 'numeric', ...(year ? { year: 'numeric' } : {}),
  }));
  return dateFormats.get(year).format(date);
}

/** Format verified instants in California; a publication day stays that day. */
export function formatAnalystReportDate(value, { year = true } = {}) {
  const raw = typeof value === 'string' ? value.trim() : '';
  const day = raw.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
  if (!day || !validDay(day) || !Number.isFinite(Date.parse(raw))) return '—';
  const timed = /[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw);
  const date = new Date(timed ? raw : `${day}T12:00:00Z`);
  if (!timed) return dateLabel(date, year);
  const clock = parts(clockFormat, date);
  return `${dateLabel(date, year)} ${clock.hour}:${clock.minute} ${clock.timeZoneName}`;
}

function parsedCivilDay(raw) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return validDay(raw) ? raw : null;
  const [first, second, year] = raw.replace(',', '').split(/\s+/);
  const [month, day] = /^\d/.test(first) ? [second, first] : [first, second];
  const index = months.indexOf(month.slice(0, 3).toLowerCase());
  const value = `${year}-${String(index + 1).padStart(2, '0')}-${day.padStart(2, '0')}`;
  return index >= 0 && validDay(value) ? value : null;
}

function authoredInstant(day, hour, minute, second, meridian, zone) {
  const normalizedDay = parsedCivilDay(day);
  let hours = Number(hour);
  const minutes = Number(minute);
  const seconds = Number(second || 0);
  if (!normalizedDay || minutes > 59 || seconds > 59 || hours > (meridian ? 12 : 23) || (meridian && hours < 1)) return null;
  if (meridian) hours = hours % 12 + (meridian.toUpperCase() === 'PM' ? 12 : 0);
  const civil = Date.parse(`${normalizedDay}T${String(hours).padStart(2, '0')}:${minute}:${String(seconds).padStart(2, '0')}Z`);
  const fixedOffsets = { UTC: 0, GMT: 0, EST: -5, EDT: -4 };
  if (zone in fixedOffsets) return new Date(civil - fixedOffsets[zone] * 3_600_000);
  // ET follows the published day's eastern offset. Reject a DST gap or an
  // ambiguous repeated hour instead of inventing which instant was observed.
  const candidates = [4, 5].map(offset => new Date(civil + offset * 3_600_000)).filter(date => {
    const local = parts(easternFormat, date);
    return `${local.year}-${local.month}-${local.day}` === normalizedDay
      && Number(local.hour) === hours && Number(local.minute) === minutes && Number(local.second) === seconds;
  });
  return candidates.length === 1 ? candidates[0] : null;
}

function presentText(value) {
  return value.replace(isoTimestamp, match => {
    const label = formatAnalystReportDate(match);
    return label === '—' ? match : label;
  }).replace(authoredTimestamp, (match, day, hour, minute, second, meridian, zone) => {
    const date = authoredInstant(day, hour, minute, second, meridian, zone.toUpperCase());
    return date ? formatAnalystReportDate(date.toISOString()) : match;
  });
}

/** Render new and saved report prose without rewriting its captured evidence. */
export function presentAnalystReportDates(value) {
  if (typeof value !== 'string') return '';
  let end = 0;
  let result = '';
  for (const match of value.matchAll(protectedText)) {
    result += presentText(value.slice(end, match.index)) + match[0];
    end = match.index + match[0].length;
  }
  return result + presentText(value.slice(end));
}
