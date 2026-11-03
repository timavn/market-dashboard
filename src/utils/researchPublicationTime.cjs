'use strict';

// Hedgeye emails print their send time ("10/15/2026 07:37 AM EDT"); imported
// publishedAt values are midnight placeholders. Mirrors daily_research_rollup.publication_time.
const PUB_LINE = /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?:\s*([AP]M))?\s+(EDT|EST|ET|PDT|PST|PT|UTC|GMT)\b/i;
const ZONES = { ET: 'America/New_York', EDT: 'America/New_York', EST: 'America/New_York',
  PT: 'America/Los_Angeles', PDT: 'America/Los_Angeles', PST: 'America/Los_Angeles' };

function zonedInstant(parts, zone) {
  const wall = Date.UTC(...parts);
  if (!zone) return new Date(wall);
  // The zone's offset at that wall time, applied twice to settle across a DST edge.
  const offset = (at) => {
    const local = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23',
      year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
      .formatToParts(new Date(at)).map(({ type, value }) => [type, Number(value)]));
    return Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second) - at;
  };
  const first = wall - offset(wall);
  return new Date(wall - offset(first));
}

/** The research email's own send time, or null when only a date is known. */
function emailPublishedAt(snapshot) {
  const line = String(snapshot?.article?.bodyText || '').match(PUB_LINE);
  if (line) {
    const [, month, day, year, clock, minute, meridiem, zone] = line;
    let hour = Number(clock);
    if (meridiem) hour = (hour % 12) + (meridiem.toUpperCase() === 'PM' ? 12 : 0);
    const instant = zonedInstant([Number(year), Number(month) - 1, Number(day), hour, Number(minute)],
      ZONES[zone.toUpperCase()]);
    return Number.isNaN(instant.getTime()) ? null : instant.toISOString();
  }
  for (const value of [snapshot?.article?.publishedAt, snapshot?.publishedAt]) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed) && new Date(parsed).toISOString().slice(11, 19) !== '00:00:00') return value;
  }
  return null;
}

const newYorkDate = (instant) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(instant));
/**
 * When a dated publication was sent: its printed send time when that falls on
 * its market date or the three days before it (a weekend email filed for
 * Monday; an older quoted email or a later forward does not count), else the
 * snapshot's own value, which may be a midnight placeholder.
 */
function publicationTime(snapshot) {
  const sent = emailPublishedAt(snapshot);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(snapshot?.date || '') ? snapshot.date : null;
  if (sent && date) {
    const earliest = new Date(Date.parse(`${date}T12:00:00Z`) - 3 * 86_400_000).toISOString().slice(0, 10);
    const day = newYorkDate(sent);
    if (day >= earliest && day <= date) return sent;
  }
  return snapshot?.publishedAt || null;
}

module.exports = { emailPublishedAt, publicationTime };
