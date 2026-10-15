import { isAccountComparisonTable } from '../../utils/analystAccountComparison';

// Presentation-only compatibility for immutable reports saved before the
// compact outline format. Never split an ambiguous group of financial values.
const REVIEW_TITLE = /^#{1,2} (?:Balance Review|Portfolio Review|Predictive Markets Review|Prediction Markets(?: Review)?)(?:[ \t]+[—–-][ \t]+(?:Ready|Partial|Blocked))?[ \t]*$/m;
export const isReviewMarkdown = value => REVIEW_TITLE.test(String(value || ''));

const GROUPS = {
  'account / currency': ['Account', 'Currency'],
  'available funds / buying power / excess liquidity': ['Available funds', 'Buying power', 'Excess liquidity'],
  'long / short / gross / net exposure': ['Long market value', 'Short market value', 'Gross exposure', 'Net exposure'],
  'long / short market value': ['Long market value', 'Short market value'],
  'settlement date / state': ['Settlement date', 'Settlement status'],
  'securities / commodity cash floors': ['Securities cash floor', 'Commodity cash floor'],
  'add-long room / trim requirement': ['Add-long room', 'Trim requirement'],
  'policy buffer / buffered room': ['Policy buffer', 'Buffered room'],
  'open orders / same-day executions': ['Open orders', 'Same-day executions'],
  'live mtd net accrued / verified debit': ['MTD net accrued', 'Verified debit'],
  'latest actual / residual': ['Latest actual', 'Residual'],
  'forecast rows / daily actual rows / postings': ['Forecast rows', 'Daily actual rows', 'Postings'],
  'latest posting': ['Latest posting date', 'Latest posting amount'],
};
const LABELS = {
  'net liquidation value': 'Net liquidation', 'verified nlv': 'Net liquidation',
  'broker margin health': 'Margin health', borrowing: 'Borrowing balance',
  'liquid buffer': 'Liquidity buffer', 'as of': 'Observed',
  'interest evidence generated': 'Interest observed',
  'independent marked-position cross-check': 'Independent position cross-check',
  'code-computed add-long room': 'Code-computed add-long room',
  'code-computed trim requirement to clear the no-borrow condition': 'Code-computed trim requirement to clear the no-borrow condition',
  'code-computed policy-buffered room': 'Code-computed policy-buffered room',
};
const METRICS = new Set([
  ...Object.values(LABELS).map(label => label.toLowerCase()),
  ...Object.values(GROUPS).flat().map(label => label.toLowerCase()),
  'observed', 'gross leverage', 'position marks', 'daily / unrealized p&l',
  'gross exposure', 'net exposure', 'stock-borrow status',
]);
const plain = value => value.replace(/\*\*/g, '').trim();
const field = (label, value) => `**${label}:** ${value}`;

function compactMetric(line) {
  const match = line.match(/^(?:- )?([^:*]+):\s+\*\*(.+)\*\*([.]?)$/);
  if (!match) return null;
  const key = match[1].trim().toLowerCase();
  const value = plain(match[2]);
  const labels = GROUPS[key];
  if (labels) {
    const values = value.split(/\s+\/\s+/);
    // Preserve the complete original line when one value contains its own
    // slash, or a provider omitted a slot. Guessing would relabel amounts.
    return values.length === labels.length ? labels.map((label, i) => field(label, values[i])) : null;
  }
  if (key === 'active forecast') {
    const forecast = value.match(/^(.+?) · (.+?) \/ (.+?) \/ (.+)$/);
    return forecast ? ['Forecast status', 'Forecast lower bound', 'Forecast estimate', 'Forecast upper bound'].map((label, i) => field(label, forecast[i + 1])) : null;
  }
  if (!(key in LABELS) && !METRICS.has(key)) return null;
  const label = LABELS[key] || match[1].trim().replace(/^./, char => char.toUpperCase());
  return [field(label, value)];
}

const cells = line => line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(cell => cell.trim());
const separator = line => /^\s*\|/.test(line || '') && cells(line).every(cell => /^:?-{3,}:?$/.test(cell));

function compactBlock(source) {
  const lines = source.split('\n');
  const balanceReport = /^#{1,2} Balance Review(?:[ \t]+[—–-][ \t]+(?:Ready|Partial|Blocked))?[ \t]*$/m.test(source);
  const output = [];
  let fence = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const marker = line.match(/^\s*(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1][0];
      else if (fence === marker[1][0]) fence = null;
      output.push(line);
      continue;
    }
    if (fence) { output.push(line); continue; }
    // Source readiness and dates already appear above the Balance Review.
    // Keep saved evidence intact; omit only redundant standalone display fields.
    if (balanceReport) {
      const text = plain(line).replace(/^[-*]\s+/, '');
      if (/^(?:Outcome:\s*)?(Ready|Partial|Blocked)(?:\s*·\s*(?:[A-Z]{3}|Unavailable))?$/i.test(text)
        || /^(?:Observed|As of):\s*\S/i.test(text)) continue;
    }
    if (/^\s*\|/.test(line) && separator(lines[i + 1])) {
      const headers = cells(line);
      const rows = [];
      let end = i + 2;
      while (end < lines.length && /^\s*\|/.test(lines[end])) { rows.push(cells(lines[end])); end += 1; }
      // Keep dated account comparisons intact for their dedicated table
      // presentation. Malformed tables also retain every original cell.
      if (rows.some(row => row.length !== headers.length)
        || isAccountComparisonTable(headers.map(plain), rows.map(row => plain(row[0])))) {
        output.push(...lines.slice(i, end));
      } else {
        for (const row of rows) {
          output.push('', `### ${plain(headers[0])}: ${row[0] || '—'}`, '');
          row.slice(1).forEach((value, index) => output.push(field(plain(headers[index + 1]), value || '—'), ''));
        }
        if (!rows.length) output.push('No rows were supplied for this section.', '');
      }
      i = end - 1;
      continue;
    }
    const status = line.match(/^\*\*Outcome:\*\*\s*(Ready|Partial|Blocked)\s*$/i);
    if (status) { output.push(status[1]); continue; }
    // Older overview lines pack several labeled amounts into one bullet.
    const segments = line.split(/[;.]\s+(?=[A-Za-z][^:;.]{0,65}:\s*\*\*)/);
    const metrics = segments.map(compactMetric);
    if (metrics.every(Boolean)) output.push(...metrics.flat().flatMap(row => [row, '']));
    else output.push(line);
  }
  return output.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function compactReviewMarkdown(value) {
  const source = String(value || '');
  if (!isReviewMarkdown(source)) return source;
  // Current Portfolio Reviews already contain the approved compact tables.
  if (source.includes('<!-- analyst-daily-rollup -->') || source.includes('<!-- analyst-prediction-research-rollup -->')) return source.trim();
  const marker = '<!-- analyst-details -->';
  const boundary = source.indexOf(marker);
  if (boundary < 0) return compactBlock(source);
  const summary = compactBlock(source.slice(0, boundary));
  const detail = compactBlock(source.slice(boundary + marker.length));
  if (!isReviewMarkdown(detail)) return compactBlock(source.replace(marker, '\n\n'));

  // Keep the full canonical report once. Retain all non-duplicate overview
  // findings (including process sizing, caveats and citations) after it.
  const titleStart = summary.search(REVIEW_TITLE);
  const preface = summary.slice(0, titleStart).trim();
  const summaryBody = summary.slice(titleStart).replace(REVIEW_TITLE, '').trim();
  const key = line => plain(line).replace(/[.]$/, '').toLowerCase();
  const detailLines = new Set(detail.split('\n').filter(Boolean).map(key));
  const summaryLines = summaryBody.split('\n');
  const retained = [];
  for (let index = 0; index < summaryLines.length; index += 1) {
    const line = summaryLines[index];
    if (/^\s*\|/.test(line) && separator(summaryLines[index + 1])) {
      let end = index + 2;
      while (end < summaryLines.length && /^\s*\|/.test(summaryLines[end])) end += 1;
      const tableLines = summaryLines.slice(index, end);
      const headers = cells(line);
      const rows = tableLines.slice(2).map(cells);
      if (rows.every(row => row.length === headers.length)
        && isAccountComparisonTable(headers.map(plain), rows.map(row => plain(row[0])))) {
        // Shared headers and separators do not make two dated comparisons
        // duplicates. Keep or omit the complete table so every row is readable.
        if (!`\n${detail}\n`.includes(`\n${tableLines.join('\n')}\n`)) retained.push(...tableLines);
        index = end - 1;
        continue;
      }
    }
    if (!/^(Ready|Partial|Blocked)$/.test(line.trim()) && !detailLines.has(key(line))) retained.push(line);
  }
  const additional = retained.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return [preface, detail, additional ? `## Additional findings\n\n${additional}` : ''].filter(Boolean).join('\n\n');
}
