const PT_TIME_ZONE = 'America/Los_Angeles';
const ET_TIME_ZONE = 'America/New_York';

function eventDate(value) {
  return new Date(value == null || value === '' ? NaN : value);
}

function timeText(date, timeZone) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(date);
}

function dateText(date, timeZone) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(date);
}

export function marketEventTime(value) {
  const date = eventDate(value);
  if (Number.isNaN(date.getTime())) return '--';
  return `${timeText(date, PT_TIME_ZONE)} (${timeText(date, ET_TIME_ZONE)})`;
}

export function marketEventPacificPreviousDay(value) {
  const date = eventDate(value);
  return !Number.isNaN(date.getTime())
    && dateText(date, PT_TIME_ZONE) !== dateText(date, ET_TIME_ZONE);
}

export function marketEventDateTime(value) {
  const date = eventDate(value);
  if (Number.isNaN(date.getTime())) return '--';
  const pacificDate = dateText(date, PT_TIME_ZONE);
  const easternDate = dateText(date, ET_TIME_ZONE);
  const easternDatePrefix = pacificDate === easternDate ? '' : `${easternDate} `;
  return `${pacificDate} ${timeText(date, PT_TIME_ZONE)} PT (${easternDatePrefix}${timeText(date, ET_TIME_ZONE)} ET)`;
}
