import { capturedSectionSources, portfolioComparisonDateline, portfolioDate, publicationDateline, publicationDatelineParts, rollupDateline } from './portfolioReviewDates';

const source = (id, publicationDate, extra = {}) => ({ id, publicationDate, ...extra });
const sourceMap = (...sources) => new Map(sources.map(item => [item.id, item]));

test('a dated publication stays historical rather than adopting the current rendering date', () => {
  const old = source('early', '2026-09-21');
  expect(publicationDateline([old])).toBe('Published: Sep 21, 2026');
  expect(rollupDateline({ id: 'macro-regime', citationIds: [old.id] }, [], sourceMap(old), '2026-09-28T23:07:10Z').text)
    .toBe('Published: Sep 21, 2026');
});

test('comparison dates retain the current publication and complete captured period while ignoring duplicate dates', () => {
  const sources = [source('prior', '2026-09-25'), source('current', '2026-09-28', { publishedAt: '2026-09-28T11:20:00Z' }), source('duplicate', '2026-09-25')];
  expect(publicationDateline(sources, { comparison: true }))
    .toBe('Published: Sep 28, 2026 04:20 PDT Period: Sep 25, 2026 – Sep 28, 2026');
  expect(publicationDateline([...sources, source('older', '2026-09-21')], { comparison: true }))
    .toBe('Published: Sep 28, 2026 04:20 PDT Period: Sep 21, 2026 – Sep 28, 2026');
  expect(publicationDatelineParts(sources, { comparison: true })).toEqual({
    text: 'Published: Sep 28, 2026 04:20 PDT', period: 'Period: Sep 25, 2026 – Sep 28, 2026',
  });
});

test('mixed research dates describe the complete captured span', () => {
  expect(publicationDateline([source('new', '2026-09-28'), source('old', '2026-09-21')]))
    .toBe('Period: Sep 21, 2026 – Sep 28, 2026');
  expect(publicationDatelineParts([source('new', '2026-09-28'), source('old', '2026-09-21')]))
    .toEqual({ text: '', period: 'Period: Sep 21, 2026 – Sep 28, 2026' });
});

test('Period occupies its own slot for a single publication and is omitted without dates', () => {
  expect(publicationDatelineParts([source('single', '2026-09-28', { publishedAt: '2026-09-28T11:20:00Z' })], { label: 'Period' }))
    .toEqual({ text: '', period: 'Period: Sep 28, 2026 04:20 PDT' });
  expect(publicationDatelineParts([], { label: 'Period' })).toEqual({ text: '', period: '' });
  expect(publicationDatelineParts([source('invalid', 'invalid')], { label: 'Period' }))
    .toEqual({ text: '', period: '' });
  expect(publicationDatelineParts([source('single', '2026-09-28')]))
    .toEqual({ text: 'Published: Sep 28, 2026' });
});

test('a forced Period keeps the complete span without adding a comparison publication slot', () => {
  const sources = [source('older', '2026-09-21'), source('newer', '2026-09-28')];
  expect(publicationDatelineParts(sources, { label: 'Period', comparison: true }))
    .toEqual({ text: '', period: 'Period: Sep 21, 2026 – Sep 28, 2026' });
});

test('timestamp formatting uses the actual Pacific calendar day and a 24-hour clock', () => {
  expect(portfolioDate('2026-09-29T02:15:00Z')).toBe('Sep 28, 2026 19:15 PDT');
  expect(portfolioDate('2026-09-28T04:15:00Z')).toBe('Sep 27, 2026 21:15 PDT');
  expect(publicationDateline([source('dated', '2026-09-29', { publishedAt: '2026-09-29T02:15:00Z' })]))
    .toBe('Published: Sep 28, 2026 19:15 PDT');
});

test.each(['2026-09-28', '2026-09-28T13:05:00'])(
  'date-only or unverified publication time retains the reported day: %s', value => {
    expect(portfolioDate(value)).toBe('Sep 28, 2026');
  },
);

test('a verified holdings observation at midnight UTC keeps its actual Pacific time', () => {
  expect(portfolioDate('2026-09-28T00:00:00Z')).toBe('Sep 27, 2026 17:00 PDT');
  expect(publicationDateline([source('placeholder', '2026-09-28', { publishedAt: '2026-09-28T00:00:00.000+00:00' })]))
    .toBe('Published: Sep 28, 2026');
});

test('date-only evidence cannot hide a precise same-day publication time', () => {
  expect(publicationDateline([source('date-only', '2026-09-28'), source('timed', '2026-09-28', { publishedAt: '2026-09-28T10:30:00Z' })]))
    .toBe('Published: Sep 28, 2026 03:30 PDT');
});

test('a midnight placeholder defers to the explicit publication date and an invalid timestamp falls back to that date', () => {
  expect(publicationDateline([source('placeholder', '2026-09-28', { publishedAt: '2026-09-29T00:00:00Z' })]))
    .toBe('Published: Sep 28, 2026');
  expect(publicationDateline([source('invalid-time', '2026-09-28', { publishedAt: 'invalid' })]))
    .toBe('Published: Sep 28, 2026');
});

test.each([undefined, null, '', 'invalid', '2026-02-30', '2026-13-28', '2026-09-31T13:00:00Z'])(
  'missing or invalid dates stay unavailable: %s', value => {
    expect(portfolioDate(value)).toBe('—');
    expect(publicationDateline([source('bad', value)])).toBe('Published: —');
  },
);

test('every source level is collected once without adding unrelated publications', () => {
  const section = { citationIds: ['section', 'duplicate', 'missing'] };
  const blocks = [{ citationIds: ['block', 'duplicate'], rows: [
    { citationIds: ['row'], cellCitationIds: [[], ['cell', 'duplicate'], null] },
  ] }];
  const sources = sourceMap(...['section', 'duplicate', 'block', 'row', 'cell', 'unrelated'].map(id => source(id, '2026-09-28')));
  expect(capturedSectionSources(section, blocks, sources).map(item => item.id))
    .toEqual(['section', 'duplicate', 'block', 'row', 'cell']);
});

test('Tick keeps its separate positioning and statistics dates and consumes the original paragraph once', () => {
  const first = { type: 'paragraph', text: 'Positioning: Sep 28, 2026 08:43 ET · Statistics: Sep 21, 2026' };
  expect(rollupDateline({ id: 'hedgai-signals' }, [first], sourceMap(), '2026-09-29T12:00:00Z'))
    .toEqual({ text: 'Positioning: Sep 28, 2026 05:43 PDT · Statistics: Sep 21, 2026', consumed: first });
});

test.each(['Report: Sep 28, 2026 · Data as of Sep 25, 2026', 'Published Sep 28, 2026 · Data as of Sep 25, 2026', 'Published: Sep 28, 2026 · Data as of: Sep 25, 2026'])(
  'market structure preserves publication and data dates without duplicating existing metadata: %s', value => {
    const first = { type: 'paragraph', text: value };
    expect(rollupDateline({ id: 'market-structure' }, [first], sourceMap()))
      .toEqual({ text: 'Published: Sep 28, 2026 · Data as of: Sep 25, 2026', consumed: first });
  },
);

test('PCA takes holdings and model dates from their respective captures while retaining model coverage', () => {
  const first = { type: 'paragraph', text: 'Portfolio captured Sep 28, 2026 · 126-session model through Sep 25, 2026 · 71/72 stocks & ETFs modeled' };
  const section = { id: 'pca-risk', portfolioObservedAt: '2026-09-28T23:07:10Z', asOf: '2026-09-25' };
  expect(rollupDateline(section, [first], sourceMap()))
    .toEqual({ text: 'Positioning: Sep 28, 2026 16:07 PDT · Statistics: Sep 25, 2026 · 126-session model · 71/72 stocks & ETFs modeled', consumed: first });
});

test('factor metadata keeps model coverage without repeating its date caption', () => {
  const first = { type: 'paragraph', text: 'Historical sensitivities through 2026-09-25 · 90% of gross exposure modeled' };
  const section = { id: 'factor-exposure', portfolioObservedAt: '2026-09-28T23:07:10Z', asOf: '2026-09-25' };
  expect(rollupDateline(section, [first], sourceMap()))
    .toEqual({ text: 'Positioning: Sep 28, 2026 16:07 PDT · Statistics: Sep 25, 2026 · 90% of gross exposure modeled', consumed: first });
});

test.each(['position-confirmations', 'position-contradictions', 'refresh-realignment', 'refresh-watch-list', 'refresh-aligned', 'refresh-sequence'])('alignment %s retains separate held and research dates', id => {
  const sources = sourceMap(source('prior', '2026-09-21'), source('latest', '2026-09-28'));
  expect(rollupDateline({ id, citationIds: ['prior', 'latest'] }, [], sources, '2026-09-28T23:07:10Z'))
    .toEqual({ text: 'Positioning: Sep 28, 2026 16:07 PDT', period: 'Period: Sep 21, 2026 – Sep 28, 2026' });
});

test('an empty comparison never uses the render date as a holdings or publication timestamp', () => {
  expect(rollupDateline({ id: 'position-confirmations' }, [], sourceMap())).toEqual({ text: 'Positioning: —', period: '' });
  expect(rollupDateline({ id: 'market-drivers' }, [], sourceMap()).text).toBe('Published: —');
});

test('rollup comparisons preserve current publication time beside their complete historical period', () => {
  const prior = source('prior', '2026-09-21');
  const latest = source('latest', '2026-09-28', { publishedAt: '2026-09-28T11:20:00Z' });
  const sources = sourceMap(prior, latest);
  expect(rollupDateline({ id: 'risk-ranges', citationIds: ['prior', 'latest'] }, [], sources)).toEqual({
    text: 'Published: Sep 28, 2026 04:20 PDT', period: 'Period: Sep 21, 2026 – Sep 28, 2026',
  });
  expect(rollupDateline({ id: 'market-drivers', citationIds: ['prior', 'latest'] }, [], sources)).toEqual({
    text: '', period: 'Period: Sep 21, 2026 – Sep 28, 2026',
  });
});

test('holdings comparisons identify the prior baseline separately from current positioning', () => {
  expect(portfolioComparisonDateline('2026-09-28T23:07:10Z', '2026-09-21T20:00:00Z')).toEqual({
    text: 'Previous positioning: Sep 21, 2026 13:00 PDT', period: 'Current positioning: Sep 28, 2026 16:07 PDT',
  });
  expect(portfolioComparisonDateline('2026-09-21', '2026-09-28')).toEqual({
    text: 'Previous positioning: Sep 28, 2026', period: 'Current positioning: Sep 21, 2026',
  });
});

test.each([
  [undefined, undefined, 'Previous positioning: —', 'Current positioning: —'],
  ['2026-09-28', undefined, 'Previous positioning: —', 'Current positioning: Sep 28, 2026'],
  [undefined, '2026-09-21', 'Previous positioning: Sep 21, 2026', 'Current positioning: —'],
  ['invalid', '2026-09-21', 'Previous positioning: Sep 21, 2026', 'Current positioning: —'],
])('holdings comparisons do not infer an unavailable endpoint: %s / %s', (current, baseline, left, period) => {
  expect(portfolioComparisonDateline(current, baseline)).toEqual({ text: left, period });
});

test('previous-close comparisons retain the actual observation instead of relabeling it as the exact session close', () => {
  const comparison = { baselineKind: 'previous-session-close', baselineSessionDate: '2026-10-07', baselineSessionCloseAt: '2026-10-07T20:00:00Z' };
  expect(portfolioComparisonDateline('2026-10-09T02:37:00Z', '2026-10-07T21:27:00Z', comparison)).toEqual({
    text: 'Previous close snapshot: Oct 7, 2026 14:27 PDT', period: 'Current positioning: Oct 8, 2026 19:37 PDT',
  });
  expect(portfolioComparisonDateline('2026-10-09T02:37:00Z', null, comparison)).toEqual({
    text: 'Previous close snapshot: Oct 7, 2026', period: 'Current positioning: Oct 8, 2026 19:37 PDT',
  });
});

test('formatting sections and collecting sources leaves immutable saved evidence unchanged', () => {
  const citation = Object.freeze(source('source', '2026-09-21'));
  const section = Object.freeze({ id: 'risk-ranges', citationIds: Object.freeze([citation.id]) });
  const row = Object.freeze({ citationIds: Object.freeze([citation.id]), cellCitationIds: Object.freeze([Object.freeze([citation.id])]) });
  const blocks = Object.freeze([Object.freeze({ type: 'table', rows: Object.freeze([row]) })]);
  const before = JSON.stringify({ section, blocks, citation });
  const sources = sourceMap(citation);
  expect(rollupDateline(section, blocks, sources).text).toBe('Published: Sep 21, 2026');
  expect(capturedSectionSources(section, blocks, sources)).toEqual([citation]);
  expect(JSON.stringify({ section, blocks, citation })).toBe(before);
});

test('formatting a saved range uses only its frozen source capture', () => {
  const citations = Object.freeze([Object.freeze(source('prior', '2026-09-21')), Object.freeze(source('current', '2026-09-28'))]);
  const section = Object.freeze({ id: 'risk-ranges', citationIds: Object.freeze(citations.map(citation => citation.id)) });
  const before = JSON.stringify({ citations, section });
  expect(rollupDateline(section, [], sourceMap(...citations))).toEqual({
    text: 'Published: Sep 28, 2026', period: 'Period: Sep 21, 2026 – Sep 28, 2026',
  });
  expect(JSON.stringify({ citations, section })).toBe(before);
});
