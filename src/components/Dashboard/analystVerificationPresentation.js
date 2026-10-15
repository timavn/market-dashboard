import { presentVerificationActions } from './analystVerificationActions';

const cellsOf = line => /^\s*\|/.test(line)
  ? line.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map(cell => cell.trim()) : [];
const plain = value => String(value || '').replace(/[*`]/g, '').trim();
const explanatoryCopy = new Set([
  'Your process exits an existing position when Trade breaks; a Trend break with Trade still aligned instead reduces it to MIN. Neither rule can be selected from “Trade and/or Trend,” a generic cover label, or list membership alone. The readable reconciliation did not authorize a current action for any of these holdings.',
  'The original alerts say Cover-SOME—not full cover. The reconciliation’s generic “Cover” label for CHH, VFC and JACK must not be interpreted as an instruction to close those shorts.',
  'These are the verification’s latest publication dates. They do not prove complete delivery or examination of every edition.',
]);
const paragraphText = node => typeof node?.value === 'string'
  ? node.value : (node?.children || []).map(paragraphText).join('');

// Omit only the requested standalone copy after its citations have been grouped.
// Captured table evidence and quoted source material keep their original text.
export function remarkAnalystVerificationCopy({ reviewKind } = {}) {
  return tree => {
    if (reviewKind !== 'portfolio-cross-verification') return;
    tree.children = (tree.children || []).filter(node => node.type !== 'paragraph'
      || !explanatoryCopy.has(paragraphText(node).replace(/\s+/g, ' ').trim()));
  };
}

const nextFence = (line, fence) => {
  const boundary = line.match(/^[ \t]{0,3}(`{3,}|~{3,})(.*)$/);
  if (!boundary) return fence;
  if (fence) return boundary[1][0] === fence.character && boundary[1].length >= fence.length && !boundary[2].trim()
    ? null : fence;
  if (boundary[1][0] === '`' && boundary[2].includes('`')) return null;
  return { character: boundary[1][0], length: boundary[1].length };
};
const missingName = (value, ticker) => {
  const name = plain(value);
  return !name || name === '—' || name === ticker || /^(?:n\/?a|unknown|unavailable)$/i.test(name)
    || /\b(?:name unavailable|name unknown|not supplied|not verified)\b/i.test(name)
    || (name.startsWith(`${ticker} `) && /^\((?:STK|ETF|FUT|OPT|CASH|BOND)\)$/i.test(name.slice(ticker.length).trim()));
};

// Read the report's captured roster, independent of today's portfolio.
export function verificationHoldings(markdown) {
  let tickerColumn = -1, securityColumn = -1, fence = null;
  const holdings = [];
  String(markdown || '').split('\n').forEach(line => {
    const followingFence = nextFence(line, fence);
    if (fence || followingFence) { fence = followingFence; tickerColumn = -1; securityColumn = -1; return; }
    const cells = cellsOf(line);
    if (!cells.length) { tickerColumn = -1; securityColumn = -1; return; }
    const tickerIndex = cells.findIndex(cell => /^(?:Ticker|Symbol|Holding)$/i.test(plain(cell)));
    const nameIndex = cells.findIndex(cell => /^(?:Security|Company|Issuer)(?: name)?$/i.test(plain(cell)));
    if (tickerIndex >= 0 && nameIndex >= 0) { tickerColumn = tickerIndex; securityColumn = nameIndex; return; }
    if (tickerColumn < 0 || securityColumn < 0) return;
    const holding = plain(cells[tickerColumn]).replace(/^\$/, '');
    if (!/^\^?[A-Z][A-Z0-9]*(?:[./-][A-Z0-9]+)*(?:=F)?$/.test(holding)) return;
    holdings.push({ holding, securityName: missingName(cells[securityColumn], holding) ? null : plain(cells[securityColumn]) });
  });
  return holdings;
}

function scopePresentation(lines) {
  const result = [];
  let scope = false, hiddenIndent = null, fence = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const followingFence = nextFence(line, fence);
    if (fence || followingFence) { fence = followingFence; result.push(line); continue; }
    const heading = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*$/);
    if (heading) { scope = /^Verification scope$/i.test(plain(heading[1])); hiddenIndent = null; }
    if (!scope) { result.push(line); continue; }
    const bullet = line.match(/^(\s*)[-*+]\s+(.*)$/);
    if (hiddenIndent !== null) {
      if (bullet && bullet[1].length <= hiddenIndent) hiddenIndent = null;
      else if (heading) hiddenIndent = null;
      else continue;
    }
    if (bullet && /^(?:Security metadata|Process context)\s*:/i.test(plain(bullet[2]))) {
      hiddenIndent = bullet[1].length;
      continue;
    }
    if (bullet && /^Indexed research coverage\s*:/i.test(plain(bullet[2]))) {
      const coverage = [];
      let next = index + 1;
      while (next < lines.length) {
        const entry = lines[next].match(/^(\s*)[-*+]\s+([^:]+):\s+(.+?)\s*$/);
        if (!entry || entry[1].length <= bullet[1].length) break;
        const products = entry[3].replace(/\.$/, '').replace(/,?\s+and\s+/g, ', ').split(/,\s*/);
        products.forEach(product => coverage.push(`| ${product.trim()} | ${entry[2].trim()} |`));
        next += 1;
      }
      if (coverage.length) {
        result.push(line.replace(/\s*Latest dates were:\s*$/i, ''), '', '| Product | Latest publication |', '| --- | --- |', ...coverage, '');
        index = next - 1;
        continue;
      }
    }
    result.push(line);
  }
  return result;
}

function holdingsTablePresentation(lines) {
  const result = [];
  let fence = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const followingFence = nextFence(line, fence);
    if (fence || followingFence) { fence = followingFence; result.push(line); continue; }
    const header = cellsOf(line);
    const tickerColumn = header.findIndex(cell => /^(?:Ticker|Symbol|Holding)$/i.test(plain(cell)));
    const securityColumn = header.findIndex(cell => /^(?:Security|Company|Issuer)(?: name)?$/i.test(plain(cell)));
    const sideColumn = header.findIndex(cell => /^Held side\s*\/\s*contract$/i.test(plain(cell)));
    const separator = cellsOf(lines[index + 1] || '');
    if (tickerColumn < 0 || securityColumn < 0 || sideColumn < 0 || separator.length !== header.length
      || !separator.every(cell => /^:?-{3,}:?$/.test(cell))) { result.push(line); continue; }
    let end = index + 2;
    while (end < lines.length && cellsOf(lines[end]).length) end += 1;
    const rows = lines.slice(index + 2, end);
    if (!rows.length || rows.some(row => cellsOf(row).length !== header.length)) { result.push(line); continue; }
    const isEventContract = row => {
      const cells = cellsOf(row);
      const held = plain(cells[sideColumn]);
      const identity = `${plain(cells[tickerColumn])} ${held}`;
      return /(?:^|[^A-Z0-9])(?:YES|NO)(?:$|[^A-Z0-9])/i.test(held)
        && /\b(?:KX[A-Z0-9]+(?:[-_][A-Z0-9._-]+)?|(?:CPIY|FES|FNQ|COMCO|METLG|METLS|CFBTC|CFETH)[_-][A-Z0-9._-]+)\b/i.test(identity);
    };
    const contracts = rows.filter(isEventContract);
    const securities = rows.filter(row => !isEventContract(row));
    if (!securities.length) {
      // An already separate contract table retains its captured columns.
      result.push(line, lines[index + 1], ...rows);
    } else {
      const securitiesHeader = [...header];
      securitiesHeader[sideColumn] = 'Held side';
      result.push(`| ${securitiesHeader.join(' | ')} |`, lines[index + 1], ...securities);
      if (contracts.length) result.push('', '#### Event contracts', '', line, lines[index + 1], ...contracts);
    }
    index = end - 1;
  }
  return result;
}

const markdownName = name => name.replace(/[\\`*_{}[\]<>]/g, character => `\\${character}`).replaceAll('|', '\\|');

// Display changes only: source evidence, marks, quantities and saved text stay
// captured. Current verified identities supplement missing descriptive labels.
export function presentVerificationMarkdown(markdown, names = {}, citations = []) {
  let tickerColumn = -1, securityColumn = -1, fence = null;
  const actionMarkdown = presentVerificationActions(markdown, citations);
  return holdingsTablePresentation(scopePresentation(actionMarkdown.split('\n'))).map(line => {
    const followingFence = nextFence(line, fence);
    if (fence || followingFence) { fence = followingFence; tickerColumn = -1; securityColumn = -1; return line; }
    const cells = cellsOf(line);
    if (!cells.length) { tickerColumn = -1; securityColumn = -1; return line; }
    const tickerIndex = cells.findIndex(cell => /^(?:Ticker|Symbol|Holding)$/i.test(plain(cell)));
    const nameIndex = cells.findIndex(cell => /^(?:Security|Company|Issuer)(?: name)?$/i.test(plain(cell)));
    if (tickerIndex >= 0 && nameIndex >= 0) { tickerColumn = tickerIndex; securityColumn = nameIndex; return line; }
    if (tickerColumn < 0 || securityColumn < 0) return line;
    const ticker = plain(cells[tickerColumn]).replace(/^\$/, '');
    if (!/^\^?[A-Z][A-Z0-9]*(?:[./-][A-Z0-9]+)*(?:=F)?$/.test(ticker)
      || !missingName(cells[securityColumn], ticker)) return line;
    const identity = names[ticker];
    cells[securityColumn] = typeof identity?.name === 'string' && identity.name.trim() && identity.source
      ? markdownName(identity.name.trim()) : '—';
    return `| ${cells.join(' | ')} |`;
  }).join('\n');
}
