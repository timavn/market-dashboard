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

// Boards saved with an Alpha Code column show it in the range cell instead, as current captures do:
// ALPHA(trade;trend;tradeRel;trendRel;unit;approx;product) joins RR(...) as ;trade;trend;approx;dots;product.
const ALPHA_CELL = /^ALPHA\(([^;()]*);([^;()]*);[^;()]*;[^;()]*;%?;([01]);([^;()]*)\)$/;
const RANGE_CELL = /^RR\(([^;()]*;){4}%?\)$/;
const level = value => value.replace(/[~,]/g, '');
export function foldPredictionAlphaCode(markdown) {
  const lines = String(markdown || '').split('\n');
  for (let start = 0; start < lines.length; start += 1) {
    const headings = /^\s*\|/.test(lines[start]) ? cells(lines[start]) : [];
    const alpha = headings.findIndex(heading => /^Alpha Code$/i.test(plain(heading)));
    const range = headings.findIndex(heading => /^Price and Risk Range$/i.test(plain(heading)));
    if (alpha < 0 || range < 0) continue;
    let end = start + 2;
    while (end < lines.length && /^\s*\|/.test(lines[end])) end += 1;
    const rows = lines.slice(start + 2, end).map(cells);
    // A code with no range bar to sit in keeps the captured layout rather than being dropped.
    if (rows.some(row => row.length !== headings.length
      || (ALPHA_CELL.test(row[alpha]) && !RANGE_CELL.test(row[range])))) continue;
    const without = row => row.filter((_value, index) => index !== alpha);
    const folded = rows.map(row => {
      const code = row[alpha].match(ALPHA_CELL);
      if (!code) return without(row);
      const [, trade, trend, approximate, product] = code;
      // A range drawn on another instrument (MKT(...;COMPQ range)) shows the code without dots.
      const dots = /^MKT\(/.test(row[0]) ? 0 : 1;
      return without(row.map((value, index) => (index === range
        ? `${value.slice(0, -1)};${level(trade)};${level(trend)};${approximate};${dots};${product})` : value)));
    });
    // Cells are already escaped as captured; they are rejoined as they were.
    const line = row => `| ${row.join(' | ')} |`;
    lines.splice(start, end - start, line(without(headings)), line(without(headings).map(() => '---')), ...folded.map(line));
    start += folded.length + 1;
  }
  return lines.join('\n');
}

// Boards captured with price history carry each market's 20-session Z-score in its Market cell (NAME(name;;z),
// MKT(name;sub;z), REF(name;sub;z)). It reads in a Z column of its own before Tick, as Z(z).
const SCORED_MARKET = /^(MKT|REF|NAME)\(([^;()]+);([^;()]*);([-+]\d+(?:\.\d+)?)?\)$/;
export function splitPredictionZScore(markdown) {
  const lines = String(markdown || '').split('\n');
  for (let start = 0; start < lines.length; start += 1) {
    const headings = /^\s*\|/.test(lines[start]) ? cells(lines[start]) : [];
    if (!/^Market$/i.test(plain(headings[0] || '')) || !/^Tick$/i.test(plain(headings[1] || ''))) continue;
    let end = start + 2;
    while (end < lines.length && /^\s*\|/.test(lines[end])) end += 1;
    const rows = lines.slice(start + 2, end).map(cells);
    if (!rows.some(row => SCORED_MARKET.test(row[0])) || rows.some(row => row.length !== headings.length)) continue;
    const split = rows.map(([market, ...rest]) => {
      const scored = market.match(SCORED_MARKET);
      if (!scored) return [market, 'Z()', ...rest];
      const [, kind, name, sub, z = ''] = scored;
      return [kind !== 'NAME' && sub ? `${kind}(${name};${sub})` : name, `Z(${z})`, ...rest];
    });
    const line = row => `| ${row.join(' | ')} |`;
    const columns = [headings[0], 'Z', ...headings.slice(1)];
    lines.splice(start, end - start, line(columns), line(columns.map(() => '---')), ...split.map(line));
    start += split.length + 1;
  }
  return lines.join('\n');
}

// A sentence that names several markets ("Bearish Gold & Silver") is captured under each of them. It reads once,
// under the first market that shows it anywhere in the review; a market left with nothing else reads Not mentioned.
const researchKey = entry => [entry.product, entry.time, String(entry.source || entry.context || '').replace(/\s+/g, ' ').trim()].join('\u0000');
export function onceAcrossPredictionResearch(markdown) {
  const lines = String(markdown || '').split('\n');
  const seen = new Set();
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim() !== '```analyst-research' || lines[index + 2]?.trim() !== '```') continue;
    let block;
    try {
      block = JSON.parse(lines[index + 1]);
    } catch {
      continue;
    }
    if (!Array.isArray(block?.markets)) continue;
    const markets = block.markets.map(row => {
      if (!Array.isArray(row?.entries)) return row;
      const entries = row.entries.filter(entry => {
        const key = researchKey(entry || {});
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      return { ...row, entries };
    });
    lines[index + 1] = JSON.stringify({ ...block, markets });
    index += 2;
  }
  return lines.join('\n');
}

// Setup boards repeat the US Dollar reference row in every section. It shows once, above the
// first section, with its research ledger under it; each section's board keeps its own markets.
const DOLLAR_ROW = /^\s*\|\s*REF\(US Dollar;[^)]*\)\s*\|/;
export function pinPredictionDollar(markdown) {
  const text = String(markdown || '');
  const lines = text.split('\n');
  const rowIndex = lines.findIndex(line => DOLLAR_ROW.test(line));
  const firstSection = lines.findIndex(line => /^## /.test(line));
  if (rowIndex < 0 || firstSection < 0 || firstSection > rowIndex) return text;
  let start = rowIndex;
  while (start > 0 && /^\s*\|/.test(lines[start - 1])) start -= 1;
  const board = [lines[start], lines[start + 1], lines[rowIndex], ''];
  let research = null;
  const rest = [];
  for (let index = firstSection; index < lines.length; index += 1) {
    const line = lines[index];
    if (DOLLAR_ROW.test(line)) continue;
    if (!research && line.trim() === '```analyst-research' && lines[index + 2]?.trim() === '```') {
      try {
        const block = JSON.parse(lines[index + 1]);
        const markets = Array.isArray(block?.markets) ? block.markets : [];
        const dollar = markets.find(row => row?.market === 'US Dollar');
        if (dollar) {
          research = dollar;
          const others = markets.filter(row => row !== dollar);
          if (others.length) rest.push(line, JSON.stringify({ ...block, markets: others }), lines[index + 2]);
          index += 2;
          continue;
        }
      } catch {
        // An unreadable block renders as it was captured.
      }
    }
    rest.push(line);
  }
  const ledger = research ? ['```analyst-research', JSON.stringify({ markets: [research] }), '```', ''] : [];
  return [...lines.slice(0, firstSection), ...board, ...ledger, ...rest].join('\n');
}
