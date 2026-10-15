const MONTH = '(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)';
const DATE = new RegExp(`\\b(?:${MONTH}\\s+\\d{1,2}(?:,?\\s+\\d{4})?|\\d{1,2}\\s+${MONTH}(?:\\s+\\d{4})?|\\d{4}-\\d{2}-\\d{2})(?:(?:,?\\s+(?:at\\s+)?)\\d{2}:\\d{2}\\s+(?:PST|PDT|PT))?\\b`, 'gi');
const NUMBER = '(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:/\\d+)?';
const COUNT_AFTER = new RegExp(`\\b(${NUMBER})(?=[ -]+(?:(?:returned|fresh|verified|current|held|indexed|available|registered|scanned|research)\\s+)*(?:positions?|holdings?|securities|publications?|reports?|documents?|products?|rows|fresh marks|valued)\\b)`, 'gi');
const COUNT_BEFORE = new RegExp(`\\b(?:engine scan(?:ned)?|(?:research |archive )?scan|position count|holdings count|current book)\\s*(?::|of)?\\s*(${NUMBER})\\b`, 'gi');

// Presentation of captured identifiers, coverage counts and dates. Financial
// values keep their existing meaning and directional colors take precedence.
export function analystReportHighlightRanges(value, context = '') {
  const text = String(value ?? '');
  const protectedRanges = [...text.matchAll(/(?:[a-z][a-z\d+.-]*:\/\/|www\.)[^\s<>]+|`+[^`]*`+/gi)]
    .map(match => ({ start: match.index, end: match.index + match[0].length }));
  const ranges = [];
  const add = (start, end) => {
    if (![...protectedRanges, ...ranges].some(range => start < range.end && end > range.start)) ranges.push({ start, end, tone: 'key' });
  };
  for (const match of text.matchAll(DATE)) add(match.index, match.index + match[0].length);
  for (const match of text.matchAll(/\b(?:[UFD]U?\d{5,}|Account\d+)\b/g)) add(match.index, match.index + match[0].length);
  for (const pattern of [COUNT_AFTER, COUNT_BEFORE]) {
    for (const match of text.matchAll(pattern)) {
      const start = match.index + match[0].lastIndexOf(match[1]);
      add(start, start + match[1].length);
    }
  }
  if (/^(?:Account(?: number| ID)?|Positions?|Holdings?|Position count|Engine scan|Indexed (?:research|publications|reports))$/i.test(context.trim())
    && /^(?:[\w-]*\d[\w-]*|[\d,]+)$/.test(text.trim())) {
    const start = text.indexOf(text.trim());
    add(start, start + text.trim().length);
  }
  return ranges.sort((a, b) => a.start - b.start);
}
