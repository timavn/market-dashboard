import { formatAnalystReportDate, presentAnalystReportDates } from '../../utils/analystReportDates';

const cellsOf = line => /^ {0,3}\|/.test(line || '')
  ? line.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map(cell => cell.trim()) : [];
const plain = value => String(value || '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[*`]/g, '').replace(/\\\|/g, '|').trim();
const headingOf = line => line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*$/);
const coverageLabel = /^Indexed research coverage\b/i;
const monthNames = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const month = '(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)';
const dates = new RegExp(`\\b(\\d{4}-\\d{2}-\\d{2})\\b|\\b(${month})\\s+(\\d{1,2})(?:,?\\s+(\\d{4}))?\\b|\\b(\\d{1,2})\\s+(${month})(?:\\s+(\\d{4}))?\\b`, 'gi');
function hasPublicationDate(value) {
  return [...value.matchAll(dates)].some(match => {
    // Validate a yearless month/day against a leap calendar; this does not
    // assign a year or observation time to the captured publication label.
    const index = monthNames.indexOf((match[2] || match[6] || '').slice(0, 3).toLowerCase());
    const day = match[1] || `${match[4] || match[7] || '2000'}-${String(index + 1).padStart(2, '0')}-${(match[3] || match[5]).padStart(2, '0')}`;
    return formatAnalystReportDate(day) !== '—';
  });
}

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

// Move the saved report's indexed coverage into the shared Sources panel.
// Presence in an archive does not establish current delivery or readiness.
export function analystVerificationSources(markdown) {
  const original = String(markdown || '');
  const lines = original.split('\n');
  let fence = null;
  for (let start = 0; start < lines.length; start += 1) {
    const boundary = lines[start].match(/^\s{0,3}(`{3,}|~{3,})(.*)$/);
    if (boundary) {
      if (!fence) fence = { character: boundary[1][0], length: boundary[1].length };
      else if (boundary[1][0] === fence.character && boundary[1].length >= fence.length && !boundary[2].trim()) fence = null;
      continue;
    }
    if (fence) continue;
    const heading = headingOf(lines[start]);
    const label = plain(heading?.[2] || lines[start].replace(/^\s*[-*+]\s+/, ''));
    if (!coverageLabel.test(label)) continue;
    let table = start + 1;
    while (table < lines.length && !headingOf(lines[table]) && !/^\s*\|/.test(lines[table])
      && !/^\s{0,3}(?:`{3,}|~{3,})/.test(lines[table])) table += 1;
    const columns = cellsOf(lines[table]).map(plain);
    const separator = cellsOf(lines[table + 1]);
    if (columns.length !== 2 || !/^Product$/i.test(columns[0]) || !/^Latest publication$/i.test(columns[1])
      || separator.length !== 2 || !separator.every(cell => /^:?-{3,}:?$/.test(cell))) continue;
    const items = [];
    let end = table + 2;
    while (end < lines.length && /^\s*\|/.test(lines[end])) {
      const cells = cellsOf(lines[end]);
      // Leave an unrecognized capture in place instead of dropping its data.
      if (cells.length !== 2 || !plain(cells[0])) break;
      const publicationLabel = plain(cells[1]);
      const hasDate = hasPublicationDate(publicationLabel);
      const qualifications = publicationLabel.replace(/\b(?:not|no|without)\s+(?:marked\s+)?(?:partial(?: provenance)?|provenance gaps?|coverage gaps?|late|delayed|missing|unavailable)\b/gi, '');
      const status = /\b(?:unavailable|missing|rejected|failed|offline|disconnected|not supplied|not available)\b/i.test(qualifications) ? 'unavailable'
        : /\b(?:partial|provenance gaps?|coverage gaps?)\b/i.test(qualifications) ? 'partial'
          : /\b(?:late|delayed)\b/i.test(qualifications) ? 'late'
          : hasDate ? 'indexed' : 'unavailable';
      items.push({ id: `indexed-${plain(cells[0]).toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
        label: plain(cells[0]), status, publicationLabel: hasDate ? publicationLabel : null,
        detail: publicationLabel });
      end += 1;
    }
    if (!items.length || /^\s*\|/.test(lines[end] || '')) continue;
    const notes = lines.slice(start + 1, table).filter(line => line.trim()).map(plain).join(' ');
    return { markdown: [...lines.slice(0, start), ...lines.slice(end)].join('\n'),
      sources: { basis: 'indexed-research', items, ...(notes ? { detail: notes } : {}) } };
  }
  return { markdown: original, sources: null };
}
