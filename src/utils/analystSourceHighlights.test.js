import { analystSourceHighlightRanges } from './analystSourceHighlights';

const highlighted = (excerpt, texts) => analystSourceHighlightRanges(excerpt, texts)
  .map(({ start, end }) => excerpt.slice(start, end));

describe('Analyst source highlights', () => {
  test('returns exact original offsets without including surrounding source text', () => {
    const passage = 'Front-end yields fell sharply as growth slowed.';
    const excerpt = `Market update\n${passage}\nOther observations follow.`;
    expect(analystSourceHighlightRanges(excerpt, [passage])).toEqual([
      { start: 14, end: 14 + passage.length },
    ]);
  });

  test('matches case and whitespace differences while preserving every source character', () => {
    const passage = 'Front-end yields fell\n\tsharply  as growth slowed.';
    const excerpt = `Morning report\n\n${passage}\n`;
    expect(highlighted(excerpt, [' FRONT-END yields fell sharply as growth slowed. ']))
      .toEqual([passage]);
    expect(excerpt).toBe(`Morning report\n\n${passage}\n`);
  });

  test('keeps UTF-16 offsets correct after emoji and expanding Unicode lowercase characters', () => {
    const passage = 'İnflation and growth slowed across the region.';
    const excerpt = `📊 ${passage}\nFront-end yields fell sharply as growth slowed.`;
    expect(analystSourceHighlightRanges(excerpt, [passage.toLowerCase()]))
      .toEqual([{ start: 3, end: 3 + passage.length }]);
  });

  test.each(['Rates — ', 'Rates: ', 'Macro & regime – '])('omits only the generated heading %s', (prefix) => {
    const excerpt = 'Front-end yields fell\nsharply as growth slowed.';
    expect(highlighted(excerpt, [`${prefix}Front-end yields fell sharply as growth slowed.`]))
      .toEqual([excerpt]);
  });

  test('matches complete supported sentences and paragraphs without synthesizing missing text', () => {
    const first = 'Front-end yields fell sharply as growth slowed.';
    const second = 'The dollar remained firm against major currencies.';
    const excerpt = `Morning report\n${first}\n\n${second}`;
    expect(highlighted(excerpt, [
      `Rates — ${first} This sentence does not appear in the source.\n\nCurrencies: ${second}`,
    ])).toEqual([first, second]);
  });

  test.each([
    'Front-end yields rose sharply as growth slowed.',
    'Front-end yields did not fall sharply as growth slowed.',
    'Front-end yields fell sharply as growth accelerated.',
    'Front-end yields fell 20 basis points as growth slowed.',
    'Front-end yields fell 10% as growth slowed.',
  ])('rejects unsupported polarity, negation, or numbers: %s', (text) => {
    const excerpt = 'Front-end yields fell 10 basis points as growth slowed.';
    expect(analystSourceHighlightRanges(excerpt, [text])).toEqual([]);
  });

  test('does not salvage common middle or trailing words from a mismatched sentence', () => {
    const excerpt = 'We are not bullish on long duration despite the slower growth backdrop.';
    expect(analystSourceHighlightRanges(excerpt, [
      'We are bullish on long duration despite the slower growth backdrop.',
      'The growth outlook improved despite the slower growth backdrop.',
    ])).toEqual([]);
  });

  test.each(['Not rates — ', 'Bearish — ', 'Sell — ', 'Rates 10% — '])('does not strip a material heading: %s', (prefix) => {
    const excerpt = 'Front-end yields fell sharply as growth slowed.';
    expect(analystSourceHighlightRanges(excerpt, [`${prefix}${excerpt}`])).toEqual([]);
  });

  test('rejects ticker labels, short headings, and generic one- or two-word fragments', () => {
    const excerpt = 'NVDA\nPortfolio Review\nFront-end yields\nInternational opportunities\nRisk assets';
    expect(analystSourceHighlightRanges(excerpt, [
      'NVDA', 'Portfolio Review', 'Front-end yields', 'International opportunities', 'Risk assets',
    ])).toEqual([]);
  });

  test('requires word boundaries rather than matching inside a longer word', () => {
    expect(analystSourceHighlightRanges('Disinflation is slowing across the region.', [
      'inflation is slowing across the region.',
    ])).toEqual([]);
  });

  test('merges duplicates and overlapping source passages but keeps separate occurrences', () => {
    const passage = 'Front-end yields fell sharply as growth slowed across the region.';
    const excerpt = `${passage}\nUnrelated note.\n${passage}`;
    expect(highlighted(excerpt, [
      passage, passage, 'Front-end yields fell sharply as growth slowed',
      'growth slowed across the region.',
    ])).toEqual([passage, passage]);
  });

  test('finds distant source passages and every supplied highlight without truncation', () => {
    const passages = Array.from({ length: 15 }, (_, index) => `The source recorded ${index + 1} basis points of movement.`);
    const excerpt = `${'Unrelated source text.\n'.repeat(1000)}${passages.join('\n')}`;
    expect(highlighted(excerpt, passages)).toEqual(passages);
  });

  test('treats markup and entities as literal text without decoding or interpreting them', () => {
    const excerpt = '<strong>Rates &amp; growth moved lower across the region.</strong>';
    expect(analystSourceHighlightRanges(excerpt, ['Rates & growth moved lower across the region.']))
      .toEqual([]);
    expect(highlighted(excerpt, [excerpt])).toEqual([excerpt]);
    expect(analystSourceHighlightRanges('Rates and growth moved lower across the region.', [
      '<strong>Rates and growth moved lower across the region.</strong>',
    ])).toEqual([]);
  });

  test.each([null, undefined, '', 123, {}])('quietly rejects invalid excerpts: %s', (excerpt) => {
    expect(analystSourceHighlightRanges(excerpt, ['Front-end yields fell sharply as growth slowed.']))
      .toEqual([]);
  });

  test('ignores invalid highlight inputs without throwing', () => {
    const excerpt = 'Front-end yields fell sharply as growth slowed.';
    expect(analystSourceHighlightRanges(excerpt, null)).toEqual([]);
    expect(analystSourceHighlightRanges(excerpt, excerpt)).toEqual([]);
    expect(analystSourceHighlightRanges(excerpt, [null, 42, {}, '', '  '])).toEqual([]);
  });
});
