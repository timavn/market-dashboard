const sourceName = source => String(source.productLabel || '').trim()
  || (source.product ? source.product.replace(/-/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase()) : source.title || 'Source');
const groupKey = source => sourceName(source).toLowerCase().replace(/[\s_-]+/g, '');
const markdownLabel = value => value.replace(/([\\[\]])/g, '\\$1');
const sourcesPrefix = /^\s*(?:\*\*)?Sources?\s*:(?:\*\*)?\s*/i;
const sourceTokens = /\[([^\]]*)\]\((citation:\/\/[^\s)]+|https?:\/\/[^\s)]+)\)|\[([^\]\s]+)\](?!\()/g;
const venueHeading = /^##\s+(?:Interactive Brokers|IBKR|ForecastEx|Kalshi)\s*$/i;
const plainAttribution = /^(?:BLS|ForecastEx|CME)$/i;

function groupedSources(sources) {
  const groups = new Map();
  sources.forEach(source => {
    const key = groupKey(source);
    if (!groups.has(key)) groups.set(key, []);
    if (!groups.get(key).some(item => item.id === source.id)) groups.get(key).push(source);
  });
  return [...groups.values()].map(group => ({
    label: sourceName(group[0]),
    source: group[0],
    context: group.length > 1 ? { relatedSources: group } : {},
  }));
}

// Presentation only: each asset owns one footer, including its nested research.
// Publications remain tied to their captured evidence and never cross assets.
export function predictionReportSources(markdown, citations = []) {
  const byId = new Map((Array.isArray(citations) ? citations : []).filter(source => typeof source?.id === 'string').map(source => [source.id, source]));
  const links = new Map();
  const used = new Set();
  const lines = String(markdown || '').split('\n');
  const headingLevels = lines.filter(line => !venueHeading.test(line)).map(line => line.match(/^(#{2,3})\s+/)?.[1].length).filter(Boolean);
  const assetLevel = headingLevels.length ? Math.min(...headingLevels) : 3;

  function sourceItems(text) {
    const items = [];
    let cursor = 0;
    const keepText = value => {
      const raw = value.replace(/^[\s,;·]+|[\s,;·]+$/g, '');
      if (raw) items.push({ raw });
    };
    for (const match of text.matchAll(sourceTokens)) {
      keepText(text.slice(cursor, match.index));
      const [, label, href, bareId] = match;
      const id = href?.startsWith('citation://') ? href.slice('citation://'.length) : bareId;
      const source = byId.get(id);
      if (source) items.push({ source });
      else items.push({ raw: href?.startsWith('citation://') ? label : match[0] });
      cursor = match.index + match[0].length;
    }
    keepText(text.slice(cursor));
    return items;
  }

  function sourceFooter(items) {
    const groups = groupedSources(items.filter(item => item.source).map(item => item.source));
    const written = new Set();
    const labels = [];
    for (const item of items) {
      const key = item.source ? `product:${groupKey(item.source)}` : `raw:${item.raw}`;
      if (written.has(key)) continue;
      written.add(key);
      if (!item.source) {
        labels.push(item.raw);
        continue;
      }
      const group = groups.find(value => groupKey(value.source) === groupKey(item.source));
      const href = `citation://group-${links.size}`;
      links.set(href, group);
      (group.context.relatedSources || [group.source]).forEach(source => used.add(source.id));
      labels.push(`[${markdownLabel(group.label)}](${href})`);
    }
    return labels.length ? `Sources: ${labels.join(', ')}` : '';
  }

  function consolidate(section) {
    const items = [];
    const body = section.map(line => {
      if (sourcesPrefix.test(line)) {
        items.push(...sourceItems(line.replace(sourcesPrefix, '')));
        return '';
      }
      let changed = false;
      const hardBreak = / {2,}$/.test(line);
      let text = line.replace(/\s*·\s*(?:\*\*)?Sources?\s*:(?:\*\*)?\s*(.+)$/i, (_match, content) => {
        items.push(...sourceItems(content));
        changed = true;
        return '';
      });
      text = text.replace(sourceTokens, (match, label, href) => {
        if (!href?.startsWith('citation://') && !(/^https?:\/\//.test(href || '') && /^Source$/i.test(label))) return match;
        items.push(...sourceItems(match));
        changed = true;
        return '';
      });
      if (/^\s*(?:\*\*)?[^:\n]+:(?:\*\*)?\s/.test(text)) {
        const parts = text.split(/\s*·\s*/);
        const attributions = [];
        // The captured contract context records venue and settlement sources
        // after its first (closing-time) value, including native source names.
        const contractAttributions = /^\s*(?:\*\*)?Trading closes:(?:\*\*)?\s/i.test(text);
        while (parts.length > 1 && (contractAttributions || plainAttribution.test(parts[parts.length - 1].trim()))) {
          const raw = parts.pop().trim();
          if (raw) attributions.unshift({ raw });
        }
        if (attributions.length) {
          items.push(...attributions);
          text = parts.join(' · ');
          changed = true;
        }
      }
      text = text.replace(/[ \t]+([,;])/g, '$1');
      if (!changed) return text;
      text = text.replace(/[ \t]*·[ \t]*(?:·[ \t]*)+/g, ' · ')
        .replace(/[ \t]*(?:[·,;][ \t]*)+$/g, '').trimEnd();
      return text + (text && hardBreak ? '  ' : '');
    });
    const footer = sourceFooter(items);
    if (!footer) return body.join('\n');
    return body.join('\n').trimEnd() + (body.some(line => line.trim()) ? '\n\n' : '') + footer + '\n';
  }

  // This disclosure has its own sources and is rendered outside the asset body.
  // Retain that scope instead of attributing its comparison to the final asset.
  function disclosureSources(disclosure) {
    return disclosure.map(line => {
      if (sourcesPrefix.test(line)) return sourceFooter(sourceItems(line.replace(sourcesPrefix, '')));
      return line.replace(/\[([^\]]*)\]\(citation:\/\/([^\s)]+)\)/g, (match, label, id) => {
        const source = byId.get(id);
        if (!source) return label;
        const href = `citation://${id}`;
        used.add(id);
        links.set(href, { label: sourceName(source), source, context: {} });
        return match;
      });
    }).join('\n');
  }

  const sections = [];
  let section = [];
  const flush = () => {
    if (section.length) sections.push(consolidate(section));
    section = [];
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\s*<details data-analyst-hedgai>/.test(line)) {
      flush();
      const disclosure = [line];
      while (index + 1 < lines.length && !/<\/details>/.test(lines[index])) disclosure.push(lines[++index]);
      sections.push(disclosureSources(disclosure));
      continue;
    }
    const level = line.match(/^(#{1,6})\s+/)?.[1].length;
    if (level && level <= assetLevel) flush();
    section.push(line);
  }
  flush();
  const text = sections.join('\n');
  return { markdown: String(markdown || '').endsWith('\n') ? text : text.replace(/\n$/, ''), links,
    remaining: groupedSources([...byId.values()].filter(source => !used.has(source.id))) };
}
