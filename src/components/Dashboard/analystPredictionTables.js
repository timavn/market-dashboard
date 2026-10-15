const MONTH = '(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)';
const DATE = `${MONTH} \\d{1,2}, \\d{4}(?: \\d{2}:\\d{2} [A-Z]{2,4})?`;
const datePart = new RegExp(`^(?:(published|as of|since|initiated|last close):?\\s+)?(${DATE})$`, 'i');
const monthPart = new RegExp(`^${MONTH} \\d{4}$`);
const fieldLabels = /^(?:Hedgeye nowcast|Cleveland Fed nowcast|Previous CPI release|CPI release|Tick|HedgAI|Trade|Trend|Underlying|Risk Range|Alpha codes|Underlying reward\/risk|Trading closes|Expiration)$/i;
const plain = value => value.replace(/\*\*/g, '').trim();
const cells = line => line.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map(value => value.trim());
const cell = value => String(value || '—').replace(/(?<!\\)\|/g, '\\|').trim();
const table = (headings, rows) => [
  `| ${headings.join(' | ')} |`,
  `| ${headings.map(() => '---').join(' | ')} |`,
  ...rows.map(row => `| ${row.map(cell).join(' | ')} |`),
];

function separateDates(value, label = '') {
  const reading = [];
  const dates = [];
  for (const part of value.trim().split(/\s+·\s+/)) {
    const text = plain(part);
    const match = text.match(datePart);
    if (match) {
      const [, kind = '', date] = match;
      if (/^last close$/i.test(kind)) {
        if (!reading.some(item => /\bLAST CLOSE\b/i.test(item))) reading.push('LAST CLOSE');
      }
      const qualifier = /^(?:since|initiated)$/i.test(kind) ? `${kind[0].toUpperCase()}${kind.slice(1).toLowerCase()} ` : '';
      dates.push(`${qualifier}${date}`);
    } else if (label === 'Previous CPI release' && monthPart.test(text)) {
      dates.push(text);
    } else {
      reading.push(part.trim());
    }
  }
  return { reading: reading.join(' · ') || '—', date: [...new Set(dates)].join(' · ') || '—' };
}

function assetRow(line) {
  const match = line.trim().match(/^\*\*([^*]+):\*\*\s*(.*)$/);
  if (!match || !fieldLabels.test(match[1])) return null;
  const label = match[1].replace(/^HedgAI$/i, 'Tick');
  const { reading, date } = separateDates(match[2], label);
  return [label, reading, date];
}

function changeRow(line) {
  if (/^\s*(?:\*\*)?Sources?:/i.test(line)) return null;
  const parts = line.trim().split(/\s+·\s+/);
  if (parts.length < 2 || !parts.slice(1).some(part => /^(?:(?:Prior |OutBucket )?Trend|Range|Published range|LOW|HIGH):/i.test(plain(part)))) return null;
  const first = parts.shift();
  // The captured renderer emits Ticker · Security first. Older captures may
  // supply only a security name; leave the ticker empty rather than invent it.
  const hasSecurity = parts.length > 1 && !/^[^:]+:/.test(plain(parts[0]));
  const isTicker = /^[A-Z^][A-Z0-9.^/=-]{0,14}$/.test(plain(first));
  const ticker = hasSecurity || isTicker ? first : '—';
  const security = hasSecurity ? parts.shift() : isTicker ? '—' : first;
  const { reading, date } = separateDates(parts.join(' · '));
  return [ticker, security, reading, date];
}

function structureRow(line) {
  if (/^\s*(?:\*\*)?Sources?:/i.test(line)) return null;
  const parts = line.trim().split(/\s+·\s+/);
  const hardBreak = / {2,}$/.test(line);
  // Current captures already contain the full Signal/Reading table. These
  // forms cover older generated compact rows without tabulating commentary.
  if (parts.length > 1 && (hardBreak || parts.slice(1).some(part => datePart.test(plain(part))))) {
    const signal = parts.shift();
    const { reading, date } = separateDates(parts.join(' · '));
    return [signal, reading, date];
  }
  const match = line.trim().match(/^([^:]+):\s+(.+)$/);
  if (!match || !hardBreak) return null;
  const { reading, date } = separateDates(match[2]);
  return [match[1], reading, date];
}

function outcomeOperator(value) {
  return value.replace(/\b(?:at or (?:above|below)|(?:greater|less) than or equal to|(?:greater|less) than|above|below)\b(?=\s+[−+-]?(?:\$|€|£)?\d)/gi, phrase => ({
    'at or above': '≥', 'at or below': '≤', 'greater than or equal to': '≥', 'less than or equal to': '≤',
    'greater than': '>', 'less than': '<', above: '>', below: '<',
  })[phrase.toLowerCase()]);
}

function projectTable(lines, section) {
  const headings = cells(lines[0]);
  const rows = lines.slice(2).map(cells);
  if (rows.some(row => row.length !== headings.length)) return lines;
  const outcome = headings.findIndex(heading => /^Outcome$/i.test(plain(heading)));
  if (outcome >= 0) {
    return [lines[0], lines[1], ...rows.map(row => {
      const changed = [...row];
      changed[outcome] = outcomeOperator(changed[outcome]);
      return `| ${changed.join(' | ')} |`;
    })];
  }
  if (section !== 'structure' && section !== 'changes') return lines;
  const date = headings.findIndex(heading => /^(?:Date|As of|Published|Publication date|Since)$/i.test(plain(heading)));
  const signalTable = section === 'structure' && /^Signal$/i.test(plain(headings[0]));
  if (date < 0) return signalTable ? table([...headings, 'Date'], rows.map(row => [...row, '—'])) : lines;
  const qualifier = /^Since$/i.test(plain(headings[date])) ? 'Since ' : '';
  return table([...headings.filter((_heading, index) => index !== date), 'Date'], rows.map(row => [
    ...row.filter((_value, index) => index !== date),
    `${row[date] === '—' ? '' : qualifier}${row[date]}`,
  ]));
}

// Presentation only. The report's captured observations, source links, status,
// inclusivity and dates are retained; this never fetches or derives a reading.
export function predictionReportTables(markdown) {
  const lines = String(markdown || '').split('\n');
  const output = [];
  let section = '';
  let fence;
  let disclosure = false;
  let pending;
  const flush = () => {
    if (!pending) return;
    if (output.length && output[output.length - 1].trim()) output.push('');
    output.push(...table(pending.headings, pending.rows), '');
    pending = undefined;
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
    if (fenceMatch && !disclosure) {
      flush();
      if (!fence) fence = fenceMatch[1];
      else if (fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) fence = undefined;
      output.push(line);
      continue;
    }
    if (!fence && /^\s*<details\b/.test(line)) { flush(); disclosure = true; }
    if (fence || disclosure) {
      output.push(line);
      if (/^\s*<\/details>/.test(line)) disclosure = false;
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      flush();
      section = /^Trend & range changes$/i.test(heading[2]) ? 'changes'
        : /^Market structure & flows$/i.test(heading[2]) ? 'structure'
          : heading[1].length <= 3 ? 'asset' : '';
      output.push(line);
      continue;
    }
    if (/^\s*\|/.test(line) && /^\s*\|\s*:?-/.test(lines[index + 1] || '')) {
      flush();
      const block = [line, lines[++index]];
      while (/^\s*\|/.test(lines[index + 1] || '')) block.push(lines[++index]);
      output.push(...projectTable(block, section));
      continue;
    }
    const row = section === 'asset' ? assetRow(line) : section === 'changes' ? changeRow(line)
      : section === 'structure' ? structureRow(line) : null;
    if (row) {
      if (!pending) pending = { headings: section === 'changes' ? ['Ticker', 'Security', 'Change', 'Date']
        : [section === 'structure' ? 'Signal' : 'Metric', 'Reading', 'Date'], rows: [] };
      pending.rows.push(row);
    } else if (!line.trim() && pending) {
      // Captured table blocks may have blank lines between related rosters.
      // Merge only adjacent readings; prose and source footers still end them.
      continue;
    } else {
      flush();
      output.push(line);
    }
  }
  flush();
  return output.join('\n').replace(/\n$/, String(markdown || '').endsWith('\n') ? '\n' : '');
}
