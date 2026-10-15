// Product labels come only from the review's captured publications. They are
// research context, never evidence of why the user originally opened a position.
const text = value => typeof value === 'string' ? value.trim() : '';
const array = value => Array.isArray(value) ? value : [];
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const meaningfulKinds = new Set(['source-position', 'action', 'membership', 'rank', 'commentary', 'trade', 'trend', 'tick']);
const sourcePriority = value => ['source-position', 'action', 'membership', 'rank', 'commentary', 'trade', 'trend', 'tick'].indexOf(value.kind);
const safe = value => value?.verified !== false
  && !['mock', 'isMock', 'seed', 'seeded', 'isSeeded', 'fixture', 'synthetic', 'inferred'].some(flag => value?.[flag] === true);
const validDate = value => /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(`${value.slice(0, 10)}T12:00:00Z`).toISOString().slice(0, 10) === value.slice(0, 10);

function sourceCitations(value, capturedCitations) {
  const citations = [...array(value.citations), ...array(value.citationIds).map(id => capturedCitations.get(id))];
  return [...new Map(citations.filter(citation => citation && safe(citation) && text(citation.id)
    && (text(citation.product) || text(citation.documentId))).map(citation => [citation.id, citation])).values()];
}

export function portfolioPositionProducts(holding, brief = {}) {
  const row = object(holding);
  const symbol = text(row.holding).toUpperCase();
  if (!symbol) return [];
  const capturedCitations = new Map([
    ...array(brief.citations), ...array(brief.dailyRollup?.citations), ...array(brief.refreshReport?.citations),
  ].filter(citation => citation?.id).map(citation => [citation.id, citation]));
  const captured = array(row.productReadings).length ? [...row.productReadings] : array(brief.dailyRollup?.sections)
    .filter(section => ['position-confirmations', 'position-contradictions'].includes(section?.id))
    .flatMap(section => array(section.blocks).flatMap(block => array(block.rows)))
    .filter(candidate => text(candidate.holding).toUpperCase() === symbol
      && (!candidate.heldSide || candidate.heldSide === row.heldSide))
    .flatMap(candidate => array(candidate.evidence));
  if (!array(row.productReadings).length) captured.push(...array(brief.refreshReport?.holdings)
    .filter(candidate => text(candidate.ticker).toUpperCase() === symbol && candidate.heldSide === row.heldSide)
    .flatMap(candidate => array(candidate.evidence).map(item => ({ ...item,
      // Legacy archive ranks were already validated as exact direct references
      // by the captured refresh projection; they omitted only the display field.
      relation: item.relation || (item.kind === 'rank' ? 'direct' : ''),
      sourceTicker: item.sourceTicker || (item.relation === 'direct' || item.kind === 'rank' ? symbol : ''),
    }))));
  const tick = object(row.tick);
  const tickSourceTicker = text(tick.sourceTicker).toUpperCase();
  const tickMapping = object(tick.instrumentMapping);
  const tickRelation = tickSourceTicker === symbol && tick.matchType === 'exact' ? 'direct'
    : tick.matchType === 'proxy' && tickMapping.verified === true && tickMapping.heldTicker === symbol
      && tickMapping.sourceTicker === tickSourceTicker && tickMapping.relationship === 'proxy' && tickMapping.sourceUrl ? 'proxy' : '';
  if (safe(tick) && ['published', 'historical', 'excluded', 'wait'].includes(tick.status) && ['Buy', 'Short', 'Wait'].includes(tick.position)
    && tickRelation) captured.push({
      product: 'hedgai-signals', productLabel: 'HedgAI Signals', reading: tick.position,
      kind: 'tick', date: tick.publishedAt || tick.source?.publishedAt || tick.publicationDate,
      relation: tickRelation, sourceTicker: tickSourceTicker,
      citations: [tick.source?.citation].filter(Boolean), citationIds: tick.citationIds,
    });
  const groups = new Map();
  for (const value of captured) {
    const item = object(value);
    const product = text(item.product);
    const reading = text(item.reading);
    const date = text(item.date);
    const relation = text(item.relation);
    const sourceTicker = text(item.sourceTicker).toUpperCase();
    const citations = sourceCitations(item, capturedCitations);
    if (!safe(item) || !product || !reading || !validDate(date) || !meaningfulKinds.has(item.kind) || !citations.length
      || !['direct', 'proxy'].includes(relation) || (relation === 'proxy' && !sourceTicker)) continue;
    const group = groups.get(product) || { product, productLabel: text(item.productLabel)
      || text(citations[0].productLabel) || text(citations[0].title) || product, readings: [], citations: [] };
    const key = JSON.stringify([item.kind, reading, relation, sourceTicker]);
    const previous = group.readings.find(candidate => candidate.key === key);
    if (previous) {
      previous.citations = [...new Map([...previous.citations, ...citations].map(citation => [citation.id, citation])).values()];
      // A repeated label belongs once in the compact cell; every captured
      // publication still remains available from its product's evidence link.
      if (date > previous.date) previous.date = date;
    } else group.readings.push({ key, reading, kind: item.kind, date,
      ...(validDate(text(item.lastConfirmedAt)) ? { lastConfirmedAt: item.lastConfirmedAt } : {}), relation, sourceTicker, citations });
    group.citations = [...new Map([...group.citations, ...citations].map(citation => [citation.id, citation])).values()];
    groups.set(product, group);
  }
  return [...groups.values()].map(group => ({ ...group,
    readings: group.readings.filter(reading => !group.readings.some(other => other.kind === reading.kind
      && other.relation === reading.relation && other.sourceTicker === reading.sourceTicker
      && (other.lastConfirmedAt || other.date) > (reading.lastConfirmedAt || reading.date)))
      .sort((a, b) => sourcePriority(a) - sourcePriority(b) || b.date.localeCompare(a.date))
      .map(({ key, ...reading }) => reading),
  }));
}
