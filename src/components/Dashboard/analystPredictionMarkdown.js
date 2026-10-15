import { formatAnalystReportDate } from '../../utils/analystReportDates';

const PREDICTION_TITLE = /^\s*#{1,6}\s+(?:Predictive|Prediction) Markets(?: Review)?(?:\s+[—–-]\s+(?:Ready|Partial|Blocked))?\s*$/im;
const DIAGNOSTIC = /\b(?:client error|server error|unsupported media type|internal server error|bad gateway|service unavailable|gateway timeout|HTTPStatusError|HTTPError|RequestError|ConnectError|ConnectionError|ConnectTimeout|ReadTimeout|TimeoutError|JSONDecodeError|TypeError|Traceback|stack trace|ECONN\w*|ENOTFOUND|ETIMEDOUT|fetch failed|failed to fetch|API (?:session|request|error|failure)|IB Gateway)\b|\bHTTP(?:\/\d(?:\.\d)?)?\s+[45]\d\d\b|\b[45]\d{2}\s+(?:Bad Request|Unauthorized|Forbidden|Not Found|Method Not Allowed)\b|\b(?:httpx|requests|urllib3|aiohttp)\.|\bFile ["'][^"']+["'], line \d+|\bat \S+\s*\([^\n]+:\d+:\d+\)/i;
const DIAGNOSTIC_URL = /https?:\/\/(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?(?:[/?#]|$)|https?:\/\/[^\s/<>]+\/(?:internal|api\/(?:analyst|prediction-markets|prediction-market-test|portfolio|ibkr))(?:[/?#]|$)|https?:\/\/developer\.mozilla\.org\/[^\s<>)]*\/Web\/HTTP\/(?:Reference\/)?Status\/\d{3}\b|https?:\/\/(?:www\.)?httpstatuses\.(?:com|io)\/\d{3}\b|https?:\/\/(?:www\.)?python-httpx\.org\/exceptions(?:[/?#]|$)/i;
const containsDiagnostic = value => DIAGNOSTIC_URL.test(value) || DIAGNOSTIC.test(value.replace(/https?:\/\/[^\s)<>]+/gi, ''));
const GAP_PROSE = /\b(?:missing (?:data|evidence|research|signals?|quotes?)|unavailable|withheld|unverified|cannot (?:establish|score|qualify)|does not establish executable|no immutable citation|no matching records|not jointly sufficient|no setup clear(?:ed|s)(?: the process gate)?|policy does not authorize)\b/i;
const HIDDEN_SECTION = /^(?:Missing(?: data| evidence)?|Risk limits|Process recommendations(?: and setup capacity)?|Contract coverage|Data status|Sources? verification)$/i;
const OMITTED_RESEARCH_SECTION = /^(?:Macro\s+(?:&|and)\s+regime|(?:The\s+)?Macro\s+Show|(?:Today['’]s\s+)?Market\s+drivers)$/i;
const HIDDEN_FIELD = /^(?:Contract|Contract expiration|Market status|Quote coverage|Live verification|Fresh coverage|Native-price evidence|Native prices|Readiness|Broker readiness|Research citations|Citations|Status|Mark status|Execution readiness|Process|Sizing|Timing|Hold)$/i;

function omitResearchSections(value) {
  let hiddenLevel = null;
  let fence = null;
  return value.split('\n').filter(line => {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
      return hiddenLevel === null;
    }
    if (marker) {
      fence = marker[1];
      return hiddenLevel === null;
    }
    const heading = line.match(/^ {0,3}(#{1,6})[ \t]+(.+?)[ \t]*$/);
    if (heading) {
      const level = heading[1].length;
      if (hiddenLevel !== null && level <= hiddenLevel) hiddenLevel = null;
      const title = heading[2].replace(/[ \t]+#+$/, '').replace(/[*_`]/g, '').replace(/:$/, '').trim();
      if (hiddenLevel === null && OMITTED_RESEARCH_SECTION.test(title)) hiddenLevel = level;
    }
    return hiddenLevel === null;
  }).join('\n');
}

function readableDates(value) {
  // Links, contract identifiers and literal code retain their exact identity.
  return value.split(/((?:https?|citation):\/\/[^\s)<>]+|`[^`]*`)/g).map(part => {
    if (/^(?:(?:https?|citation):\/\/|`)/.test(part)) return part;
    return part.replace(/\b\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2}))?\b/g, stamp => {
      if (stamp.includes('T')) {
        // Exact instants go straight to Pacific; an Eastern intermediate would
        // lose the instant in the repeated hour when daylight saving ends.
        const label = formatAnalystReportDate(stamp);
        return label === '—' ? stamp : label;
      }
      const date = new Date(`${stamp}T12:00:00Z`);
      if (!Number.isFinite(date.getTime())) return stamp;
      return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' }).format(date);
    });
  }).join('');
}

function tableCells(line) {
  const cells = [];
  let start = 0;
  let codeTicks = 0;
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] === '\\') { index += 1; continue; }
    if (line[index] === '`') {
      let count = 1;
      while (line[index + count] === '`') count += 1;
      if (!codeTicks) codeTicks = count;
      else if (codeTicks === count) codeTicks = 0;
      index += count - 1;
    } else if (line[index] === '|' && !codeTicks) {
      cells.push(line.slice(start, index));
      start = index + 1;
    }
  }
  cells.push(line.slice(start));
  return cells;
}

function isTableDivider(line) {
  const cells = tableCells(line);
  if (!cells[0]?.trim()) cells.shift();
  if (!cells.at(-1)?.trim()) cells.pop();
  return cells.length > 1 && cells.every(cell => /^\s*:?-{3,}:?\s*$/.test(cell));
}

function presentParagraph(paragraph) {
  // Older generated prose sometimes classified an absent Trade reading as a
  // conflict. Preserve the stated readings, but remove that unsupported claim.
  paragraph = paragraph.replace(/(Trade\s+—\s+and\s+Trend\s+(?:bullish|bearish|neutral)),?\s+so\s+(?:signals do not agree|no agreement)\./gi, '$1.');
  const lines = paragraph.split('\n');
  if (lines.some(isTableDivider)) {
    // A diagnostic in one cell cannot erase other contracts, prices or sources
    // in the same Markdown table. Keep its delimiters and verified cells intact.
    return lines.map(line => tableCells(line).map(cell => containsDiagnostic(cell) || GAP_PROSE.test(cell)
      ? `${cell.match(/^\s*/)[0]}—${cell.match(/\s*$/)[0]}` : cell).join('|')).join('\n');
  }
  return paragraph.split(/\n(?=\s{0,3}[-*+]\s)/)
    .filter(item => !containsDiagnostic(item) && !GAP_PROSE.test(item)).join('\n\n');
}

function presentProse(value) {
  let hiddenLevel = null;
  let hiddenGapList = false;
  const lines = value.split('\n').filter(line => {
    const heading = line.match(/^\s*(#{1,6})\s+(.+?)\s*$/);
    const plain = line.replace(/[*_`]/g, '').trim();
    if (heading) {
      hiddenGapList = false;
      if (hiddenLevel !== null && heading[1].length <= hiddenLevel) hiddenLevel = null;
      if (HIDDEN_SECTION.test(heading[2].replace(/[*_`]/g, '').replace(/:$/, ''))) hiddenLevel = heading[1].length;
    }
    if (hiddenLevel !== null) return false;
    if (/^Missing(?: data| evidence)?\s*:?$/i.test(plain)) { hiddenGapList = true; return false; }
    if (hiddenGapList) {
      if (/^\s*\*\*[^*]+:\*\*/.test(line)) hiddenGapList = false;
      else return false;
    }
    if (PREDICTION_TITLE.test(line) || /^\s*#{1,6}\s+(?:Monitored markets|Review notes|Actions)\s*$/i.test(line)) return false;
    const label = plain.match(/^(?:[-*+]\s+)?([^:]+):/);
    if (label && HIDDEN_FIELD.test(label[1])) return false;
    return !/^(?:Outcome:\s*)?(?:Ready|Partial|Blocked)$/i.test(plain);
  });
  return readableDates(lines.join('\n').split(/\n\s*\n/).map(presentParagraph).join('\n\n'));
}

// Present older saved reports cleanly without changing their stored evidence.
export function presentPredictionMarkdown(value, { reviewKind } = {}) {
  const source = String(value || '');
  if (reviewKind !== 'prediction-markets-review' && !PREDICTION_TITLE.test(source)) return source;
  const parts = [];
  let prose = [];
  const lines = omitResearchSections(source).split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const fence = lines[index].match(/^\s*(`{3,}|~{3,})/);
    if (!fence) { prose.push(lines[index]); continue; }
    parts.push(presentProse(prose.join('\n')));
    prose = [];
    const code = [lines[index]];
    while (++index < lines.length) {
      code.push(lines[index]);
      if (lines[index].trim().startsWith(fence[1])) break;
    }
    const block = code.join('\n');
    parts.push(containsDiagnostic(block) ? '' : block);
  }
  parts.push(presentProse(prose.join('\n')));
  return parts.filter(part => part.trim()).join('\n\n')
    .replace(/\n{3,}/g, '\n\n').trim();
}
