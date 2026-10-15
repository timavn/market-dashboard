const sourceName = source => String(source.productLabel || '').trim()
  || (source.product ? source.product.replace(/-/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase()) : source.title || 'Source');
const sourceKey = source => sourceName(source).toLowerCase().replace(/[\s_-]+/g, '');
const citationToken = /\[\s*\[(cite_[a-f0-9]{32}|\d+(?:\s*[,;]\s*\d+)*)\]\s*\](?!\()|\[([^\]]*)\]\(citation:\/\/([^\s)]+)\)|(?<!\[)\[(cite_[a-f0-9]{32})\](?![\](])|【\s*\[(\d+(?:\s*[,;]\s*\d+)*)\]\s*】|(?<!\[)\[(\d+)\](?![\](])/g;
const emptySourcesLine = /^\s*(?:\*\*)?Sources?\s*:(?:\*\*)?\s*(?:(?:\[\s*\]|[,;·.])\s*)*$/i;

function groupedSources(references) {
  const groups = new Map();
  references.forEach(({ source, number }) => {
    const key = sourceKey(source);
    if (!groups.has(key)) groups.set(key, { label: sourceName(source), source, publications: [], numbers: [] });
    const group = groups.get(key);
    if (!group.publications.some(item => item.id === source.id)) {
      group.publications.push(source);
      group.numbers.push(number);
    }
  });
  return [...groups.values()].map(({ publications, ...group }) => ({
    ...group,
    context: publications.length > 1 ? { relatedSources: publications } : {},
  }));
}

// Saved answers keep their evidence and original numbering. Move only issued
// references into their own section's footer; never infer a source from prose.
export function analystChatSources(markdown, citations = []) {
  const captured = Array.isArray(citations) ? citations : [];
  const byId = new Map(captured.flatMap((source, index) => typeof source?.id === 'string'
    ? [[source.id, { source, number: index + 1 }]] : []));
  const used = new Set();
  const securityTickers = new Set();
  const securityNames = [];
  const sections = [];
  const links = new Map();
  let lines = [], references = [], inlineSources = new Set(), fence = null, tickerColumns = [], nameColumns = [], actionSourceColumn = -1;
  const flush = () => {
    if (lines.some(line => line.trim()) || references.length) sections.push({
      markdown: lines.join('\n').trimEnd(), sources: groupedSources(references.filter(reference => !inlineSources.has(reference.source.id))),
    });
    lines = [];
    references = [];
    inlineSources = new Set();
  };
  const collect = reference => {
    if (!references.some(item => item.source.id === reference.source.id)) references.push(reference);
    used.add(reference.source.id);
  };
  const literalRanges = value => [...value.matchAll(/(`+)([^`]|(?!\1)`)*?\1|https?:\/\/[^\s<>]+/g)]
      .map(match => ({ start: match.index, end: match.index + match[0].length }));
  const stripReferences = (line, preserveSourceLinks = false, retainCitationLabels = false) => {
    const literal = literalRanges(line);
    // Older saved answers used [label]([1]) or [label](cite_ID). Resolve the
    // whole issued reference before stripping tokens, never its destination
    // alone: removing [1] from a Markdown href creates a page-reloading URL.
    const normalized = line.replace(/\[([^\]\n]*)\]\((?:\[(\d+)\]|(cite_[a-f0-9]{32}))\)/g, (match, label, number, id, offset) => {
      if (literal.some(range => offset < range.end && offset + match.length > range.start)) return match;
      const source = number ? captured[Number(number) - 1] : byId.get(id)?.source;
      return source?.id ? `[${label}](citation://${source.id})` : match;
    });
    const protectedRanges = literalRanges(normalized);
    let removed = false;
    let body = normalized.replace(citationToken, (match, nested, label, id, bareId, wrapped, numeric, offset) => {
      if (protectedRanges.some(range => offset < range.end && offset + match.length > range.start)) return match;
      const nestedId = nested?.startsWith('cite_') ? nested : null;
      const numbers = (wrapped || numeric || (!nestedId && nested) || '').split(/\s*[,;]\s*/).filter(Boolean).map(Number);
      const issued = id || bareId || nestedId ? [byId.get(id || bareId || nestedId)] : numbers.map(number => {
        const source = captured[number - 1];
        return source?.id ? byId.get(source.id) : null;
      });
      if (!issued.length || issued.some(reference => !reference)) return match;
      issued.forEach(collect);
      if (preserveSourceLinks && id) {
        const source = issued[0].source;
        const relatedSources = captured.filter(item => item?.id && item.product === source.product
          && item.publicationDate === source.publicationDate
          && (source.documentId ? item.documentId === source.documentId
            : source.sourceUri ? item.sourceUri === source.sourceUri : item.id === source.id));
        // This publication is already linked in its action row. Keep its body
        // excerpts in that popup without repeating the product in the footer.
        inlineSources.add(source.id);
        relatedSources.forEach(item => { inlineSources.add(item.id); used.add(item.id); });
        links.set(`citation://${id}`, { source, context: relatedSources.length > 1 ? { relatedSources } : {} });
        return match;
      }
      removed = true;
      return retainCitationLabels && id ? label : '';
    });
    if (emptySourcesLine.test(body)) return '';
    if (!removed) return body;
    body = body.replace(/\*\*\s*\*\*/g, '').replace(/[ \t]+([,.;!?])/g, '$1').trimEnd()
      .replace(/(?:[ \t]+\[\s*\])+[ \t]*$/g, '');
    if (emptySourcesLine.test(body)) return '';
    return body;
  };
  String(markdown || '').split('\n').forEach(line => {
    const boundary = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (boundary) {
      if (!fence) fence = { character: boundary[1][0], length: boundary[1].length };
      else if (boundary[1][0] === fence.character && boundary[1].length >= fence.length) fence = null;
      lines.push(line);
      return;
    }
    if (fence) { lines.push(line); return; }
    const cells = /^\s*\|/.test(line) ? line.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map(cell => cell.trim().replace(/[*`]/g, '')) : [];
    const headings = cells.flatMap((cell, index) => /^(?:Ticker|Symbol|Holding)$/i.test(cell) ? [index] : []);
    const names = cells.flatMap((cell, index) => /^(?:Security|Company|Issuer)(?: name)?$/i.test(cell) ? [index] : []);
    if (headings.length || names.length) {
      tickerColumns = headings; nameColumns = names;
      actionSourceColumn = cells[0] === 'Ticker' && cells[1] === 'Security' && cells[3] === 'Action' && cells[4] === 'Source' ? 4 : -1;
    }
    else if (!cells.length) { tickerColumns = []; nameColumns = []; actionSourceColumn = -1; }
    else {
      tickerColumns.forEach(index => {
        const ticker = cells[index]?.replace(/^\$/, '');
        if (/^\^?[A-Z][A-Z0-9]*(?:[./-][A-Z0-9]+)*(?:=F)?$/.test(ticker || '')) securityTickers.add(ticker);
      });
      nameColumns.forEach(index => {
        const name = cells[index], ticker = cells[tickerColumns[0]] || '';
        if (name && !securityNames.some(item => item.name === name && item.ticker === ticker)) securityNames.push({ name, ticker });
      });
    }
    if (/^\s{0,3}#{1,6}\s+\S/.test(line)) flush();
    if (actionSourceColumn >= 0 && cells.length === 5 && !headings.length) {
      const rawCells = line.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/);
      lines.push(`|${rawCells.map((cell, index) => stripReferences(cell, index === actionSourceColumn, true)).join('|')}|`);
    } else lines.push(stripReferences(line, false, cells.length > 0));
  });
  flush();
  return { sections, links, securityTickers: [...securityTickers], securityNames,
    remaining: groupedSources([...byId.values()].filter(reference => !used.has(reference.source.id))) };
}
