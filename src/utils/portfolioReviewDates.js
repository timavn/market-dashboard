import { formatAnalystReportDate, presentAnalystReportDates } from './analystReportDates';

const text = value => typeof value === 'string' ? value.trim() : '';
const array = value => Array.isArray(value) ? value : [];

function dated(value, publicationDate, publication = false) {
  const raw = text(value);
  const day = raw.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
  if (!day || !Number.isFinite(Date.parse(raw)) || new Date(`${day}T12:00:00Z`).toISOString().slice(0, 10) !== day) return null;
  // Date-only publication imports sometimes carry a synthetic midnight UTC.
  const placeholder = publication && /T00:00(?::00(?:\.0+)?)?(?:Z|\+00:00)$/i.test(raw);
  const timed = /T.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw) && !placeholder;
  if (!timed) {
    if (placeholder && publicationDate && publicationDate !== day) return dated(publicationDate);
    const date = new Date(`${day}T12:00:00Z`);
    return { day, timed: false, time: date.getTime(), label: formatAnalystReportDate(day) };
  }
  const date = new Date(raw);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const part = type => parts.find(item => item.type === type).value;
  const localDay = `${part('year')}-${part('month')}-${part('day')}`;
  return { day: localDay, timed: true, time: date.getTime(), label: formatAnalystReportDate(raw) };
}

export const portfolioDate = value => dated(value)?.label || '—';

export const capturedSectionSources = (section, blocks, sources) => [...new Set([
  ...array(section.citationIds), ...array(blocks).flatMap(block => [
    ...array(block.citationIds), ...array(block.rows).flatMap(row => [
      ...array(row.citationIds), ...array(row.cellCitationIds).flatMap(array),
    ]),
  ]),
])].map(id => sources.get(id)).filter(Boolean);

export function publicationDatelineParts(sources, { comparison = false, label = 'Published' } = {}) {
  const dates = array(sources).filter(Boolean).map(source => dated(source.publishedAt, source.publicationDate, true) || dated(source.publicationDate)).filter(Boolean);
  if (!dates.length) return label === 'Period' ? { text: '', period: 'Period: —' } : { text: `${label}: —` };
  const days = [...new Set(dates.map(date => date.day))].sort();
  const latest = dates.filter(date => date.day === days.at(-1)).sort((a, b) => Number(b.timed) - Number(a.timed) || b.time - a.time)[0];
  if (days.length === 1) return label === 'Period'
    ? { text: '', period: `Period: ${latest.label}` } : { text: `${label}: ${latest.label}` };
  return {
    text: comparison && label !== 'Period' ? `${label}: ${latest.label}` : '',
    period: `Period: ${portfolioDate(days[0])} – ${portfolioDate(days.at(-1))}`,
  };
}

export function publicationDateline(sources, options) {
  const { text: left, period } = publicationDatelineParts(sources, options);
  return [left, period].filter(Boolean).join(' ');
}

export function portfolioComparisonDateline(asOf, baselineAsOf, comparison = {}) {
  const current = dated(asOf);
  const baseline = dated(baselineAsOf);
  const closingBaseline = comparison?.baselineKind === 'previous-session-close';
  const baselineLabel = closingBaseline ? 'Previous close snapshot' : 'Previous positioning';
  const expectedSession = closingBaseline && !baseline ? portfolioDate(comparison.baselineSessionDate) : null;
  return {
    text: `${baselineLabel}: ${baseline?.label || expectedSession || '—'}`,
    period: `Current positioning: ${current?.label || '—'}`,
  };
}

export function rollupDateline(section, blocks, sources, holdingsAsOf) {
  const first = blocks[0];
  const firstText = first?.type === 'paragraph' ? presentAnalystReportDates(text(first.text)) : '';
  if (section.id === 'hedgai-signals' && /^Positioning:.* · Statistics:/.test(firstText)) {
    return { text: firstText, consumed: first };
  }
  if (section.portfolioObservedAt && section.asOf) {
    const model = firstText.match(/ · (\d+-session model) through /)?.[1];
    const coverage = firstText.match(/ · (\d+\/\d+ stocks & ETFs modeled|\d+% of gross exposure modeled)$/)?.[1];
    return { text: `Positioning: ${portfolioDate(section.portfolioObservedAt)} · Statistics: ${portfolioDate(section.asOf)}${model ? ` · ${model}` : ''}${coverage ? ` · ${coverage}` : ''}`,
      consumed: /^(?:Portfolio captured |Historical sensitivities through )/.test(firstText) ? first : null };
  }
  if (section.id === 'market-structure' && /^(?:Report:|Published:?) /.test(firstText)) {
    return { text: firstText.replace(/^(?:Report:|Published:?) /, 'Published: ').replace(/ · Data as of:? /, ' · Data as of: '), consumed: first };
  }
  const alignment = ['position-confirmations', 'position-contradictions', 'refresh-realignment', 'refresh-watch-list', 'refresh-aligned', 'refresh-sequence'].includes(section.id);
  const research = publicationDatelineParts(capturedSectionSources(section, blocks, sources), {
    comparison: ['risk-ranges', 'macro-show', 'company-catalysts', 'the-call'].includes(section.id),
    label: alignment ? 'Period' : 'Published',
  });
  return alignment ? { ...research, text: `Positioning: ${portfolioDate(holdingsAsOf)}` } : research;
}
