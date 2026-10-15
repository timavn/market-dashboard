import { formatAnalystReportDate } from '../../utils/analystReportDates';

const cellsOf = line => /^ {0,3}\|/.test(line || '')
  ? line.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map(cell => cell.trim()) : [];
const plain = value => String(value || '').replace(/[*`]/g, '').trim();
const escapeMarkdown = value => String(value).replace(/[\\`*_{}[\]<>|]/g, character => `\\${character}`);
const reference = /\[([^\]\n]+)\]\((?:citation:\/\/([^\s)]+)|\[(\d+)\])\)|\[\s*\[(cite_[a-f0-9]{32}|\d+(?:\s*[,;]\s*\d+)*)\]\s*\]|(?<!\[)\[(cite_[a-f0-9]{32}|\d+)\](?![\](])/g;
const literalRanges = value => [...value.matchAll(/(`+)([^`]|(?!\1)`)*?\1|https?:\/\/[^\s<>]+/g)]
  .map(match => ({ start: match.index, end: match.index + match[0].length }));

function references(value, citations) {
  const found = [];
  const protectedRanges = literalRanges(value);
  for (const match of value.matchAll(reference)) {
    if (protectedRanges.some(range => match.index < range.end && match.index + match[0].length > range.start)) continue;
    const ids = (match[2] || match[3] || match[4] || match[5]).split(/\s*[,;]\s*/);
    ids.forEach(id => {
      const source = /^\d+$/.test(id) ? citations[Number(id) - 1] : citations.find(item => item?.id === id);
      const label = match[1] || '';
      if (source?.id && !found.some(item => item.source.id === source.id && item.label === label)) found.push({ source, label });
    });
  }
  return found;
}

function actionLabel(value) {
  const text = plain(value);
  // Normalize only explicit publisher actions; a negation or comparison is not
  // an action, and generic Cover never becomes a full or partial cover.
  if (/\b(?:not|no|versus|vs\.?|rather than|if|when|unless|until|provided|subject to|conditional|depending|may|might|could|consider|potential|possible|or|then)\b/i.test(text)) return text;
  const partial = text.match(/\b(cover|sell)[\s-]+some\b/i);
  if (partial) return partial[1].toLowerCase() === 'cover' ? 'Cover some' : 'Sell some';
  const removed = text.match(/\bRemoved source (Long|Short)\b/i);
  if (removed) return `Removed source ${removed[1]}`;
  const direct = text.match(/^\s*[“"']?((?:Cover|Sell)(?: all)?|Exit|Buy)(?:\s+Signal)?[”"']?(?:[.;,]|$)/i);
  return direct ? direct[1][0].toUpperCase() + direct[1].slice(1).toLowerCase() : text;
}

function sourceCell(sources) {
  const publications = new Set();
  return sources.flatMap(({ source }) => {
    const product = source.productLabel || (source.product
      ? source.product.replace(/-/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase()) : null);
    if (!product) return [];
    const publication = source.publicationDate || source.sourceEvidence?.publicationDate
      || source.publishedAt || source.sourceEvidence?.publishedAt;
    const date = formatAnalystReportDate(publication);
    const key = `${product}\n${publication}\n${source.documentId || source.sourceUri || source.id}`;
    if (publications.has(key)) return [];
    publications.add(key);
    return [`[${escapeMarkdown(product)}${date === '—' ? '' : ` · ${date}`}](citation://${source.id})`];
  }).join('; ') || '—';
}

/** Present saved action tables using their own issued sources. The raw report
 * and evidence remain immutable; today's research never fills a capture. */
export function presentVerificationActions(markdown, citations = []) {
  const captured = Array.isArray(citations) ? citations : [];
  const lines = String(markdown || '').split('\n');
  let inRealignment = false, sectionLevel = 0, fence = null;
  for (let index = 0; index < lines.length; index += 1) {
    const boundary = lines[index].match(/^\s{0,3}(`{3,}|~{3,})(.*)$/);
    if (boundary) {
      if (!fence) fence = { character: boundary[1][0], length: boundary[1].length };
      else if (boundary[1][0] === fence.character && boundary[1].length >= fence.length && !boundary[2].trim()) fence = null;
      continue;
    }
    if (fence) continue;
    const heading = lines[index].match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*$/);
    if (heading) {
      if (heading[1].length <= sectionLevel) inRealignment = false;
      if (/^Highest[ -]priority realignment$/i.test(plain(heading[2]))) {
        inRealignment = true;
        sectionLevel = heading[1].length;
      }
    }
    if (!inRealignment) continue;
    const headers = cellsOf(lines[index]).map(plain);
    const action = headers.findIndex(header => /^(?:Description|Dated source action|Source action|Action)$/i.test(header));
    const side = headers.findIndex(header => /^(?:Held|Current) side$/i.test(header));
    const source = headers.findIndex(header => /^(?:Source|Product)$/i.test(header));
    const separator = cellsOf(lines[index + 1]);
    if (headers[0]?.toLowerCase() !== 'ticker' || headers[1]?.toLowerCase() !== 'security' || action < 0 || side < 0
      || separator.length !== headers.length || !separator.every(cell => /^:?-{3,}:?$/.test(cell))) continue;
    let end = index + 2;
    while (cellsOf(lines[end]).length) end += 1;
    const rows = lines.slice(index + 2, end).map(cellsOf);
    if (!rows.length || rows.some(row => row.length !== headers.length)) continue;
    // Older answers cite each row in a named section footer rather than in the
    // row itself. Only that explicit ticker label establishes the association.
    let sectionEnd = end;
    while (sectionEnd < lines.length && !/^\s{0,3}#{1,6}\s/.test(lines[sectionEnd])) sectionEnd += 1;
    const footerSources = lines.slice(end, sectionEnd).filter(line => /^\s*(?:\*\*)?Sources?\s*:/i.test(line))
      .flatMap(line => references(line, captured));
    for (let footer = end; footer < sectionEnd; footer += 1) {
      if (!/^\s*(?:\*\*)?Sources?\s*:/i.test(lines[footer])) continue;
      const protectedRanges = literalRanges(lines[footer]);
      lines[footer] = lines[footer].replace(/\[([^\]\n]+)\]\(\[(\d+)\]\)/g, (match, label, number, offset) =>
        captured[Number(number) - 1]?.id && !protectedRanges.some(range => offset < range.end && offset + match.length > range.start)
          ? `[${label}](citation://${captured[Number(number) - 1].id})` : match);
    }
    const support = new Map();
    const displayed = rows.map(row => {
      const rowSources = references(source >= 0 ? row[source] : row[action], captured);
      row.forEach((cell, column) => {
        if ([0, 1, side, action, source].includes(column)) return;
        references(cell, captured).forEach(item => support.set(item.source.id, item.source));
      });
      const ticker = plain(row[0]).replace(/^\$/, '');
      const tickerPattern = new RegExp(`(?:^|[^A-Z0-9])${ticker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|[^A-Z0-9])`, 'i');
      const actionText = actionLabel(row[action]);
      const directAction = /^(?:(?:Cover|Sell)(?: some| all)?|Exit)$/i.test(actionText);
      const cited = rowSources.length ? rowSources : footerSources.filter(item => tickerPattern.test(item.label)
        && (!directAction || !/\b(?:Trend|Risk Ranges?|ranges?|quotes?|holdings?|valuation|marks?|confirmation)\b/i.test(item.label)));
      const cell = cited.length ? sourceCell(cited) : source >= 0 ? row[source] : '—';
      return `| ${row[0]} | ${row[1]} | ${row[side]} | ${actionText} | ${cell} |`;
    });
    const supportFooter = support.size ? ['', `Sources: ${[...support.values()].map(item => `[Source](citation://${item.id})`).join(' ')}`] : [];
    lines.splice(index, end - index, '| Ticker | Security | Held side | Action | Source |', '| --- | --- | --- | --- | --- |', ...displayed, ...supportFooter);
    index += displayed.length + 1;
  }
  return lines.join('\n');
}
