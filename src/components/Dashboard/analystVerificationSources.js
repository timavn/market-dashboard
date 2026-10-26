import { formatAnalystReportDate, presentAnalystReportDates } from '../../utils/analystReportDates';

const plain = value => String(value || '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[*`]/g, '').replace(/\\\|/g, '|').trim();
const monthNames = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const month = '(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)';
const dates = new RegExp(`\\b(\\d{4}-\\d{2}-\\d{2})\\b|\\b(${month})\\s+(\\d{1,2})(?:,?\\s+(\\d{4}))?\\b|\\b(\\d{1,2})\\s+(${month})(?:\\s+(\\d{4}))?\\b`, 'gi');
/** The first captured date is the archive publication; later dates belong to
 * monitor qualifications, which remain in the source row's existing tooltip. */
export function verificationSourceDate(value) {
  const publication = presentAnalystReportDates(plain(value));
  const match = [...publication.matchAll(dates)][0];
  if (!match) return null;
  const index = monthNames.indexOf((match[2] || match[6] || '').slice(0, 3).toLowerCase());
  const year = match[1]?.slice(0, 4) || match[4] || match[7];
  const day = match[1] || `${year || '2000'}-${String(index + 1).padStart(2, '0')}-${(match[3] || match[5]).padStart(2, '0')}`;
  const label = formatAnalystReportDate(day, { year: false });
  if (label === '—') return null;
  const clock = publication.slice(match.index + match[0].length).match(/^,?\s+(?:at\s+)?(\d{2}):(\d{2})\s+(PST|PDT|PT)\b/);
  if (clock && Number(clock[1]) < 24 && Number(clock[2]) < 60) {
    // A yearless or generic PT clock stays exactly as supplied, without an
    // invented timestamp or daylight-saving offset.
    if (!year || clock[3] === 'PT') return { label: `${label} ${clock[1]}:${clock[2]} ${clock[3]}` };
    const instant = `${day}T${clock[1]}:${clock[2]}:00${clock[3] === 'PDT' ? '-07:00' : '-08:00'}`;
    return { value: instant, label: formatAnalystReportDate(instant, { year: false }) };
  }
  return { ...(year ? { value: day } : {}), label };
}
