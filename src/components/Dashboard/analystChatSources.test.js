import { analystChatSources } from './analystChatSources';

const citations = [
  { id: 'cite_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', product: 'real-time-alert', title: 'Sep 30 AAPL' },
  { id: 'cite_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', product: 'real-time-alert', title: 'Sep 30 CVI' },
  { id: 'cite_cccccccccccccccccccccccccccccccc', product: 'portfolio-solutions', title: 'Sep 30 Portfolio' },
];

test('saved manual report moves captured citations to their own section and preserves every publication', () => {
  const original = 'The original capture.\n\n### Realignment\n- AAPL sell some. **【[1]】**\n- CVI sell some. 【[2]】【[3]】\n\n### Watch list\nCVI remains a dated watch. 【[2]】';
  const result = analystChatSources(original, citations);
  expect(result.sections.map(section => section.markdown)).toEqual([
    'The original capture.', '### Realignment\n- AAPL sell some.\n- CVI sell some.', '### Watch list\nCVI remains a dated watch.',
  ]);
  expect(result.sections[0].sources).toEqual([]);
  expect(result.sections[1].sources.map(group => group.numbers)).toEqual([[1, 2], [3]]);
  expect(result.sections[1].sources[0].context.relatedSources).toEqual(citations.slice(0, 2));
  expect(result.sections[2].sources[0]).toMatchObject({ source: citations[1], numbers: [2] });
  expect(result.remaining).toEqual([]);
  expect(original).toContain('**【[1]】**');
});

test('plain references, captured citation links, and explicit Sources lines share one footer', () => {
  const result = analystChatSources(`### Readings\nAAPL [1]. CVI [Source](citation://${citations[1].id}).\n\nSources: [${citations[0].id}]`, citations);
  expect(result.sections[0].markdown).toBe('### Readings\nAAPL. CVI.');
  expect(result.sections[0].sources).toHaveLength(1);
  expect(result.sections[0].sources[0].numbers).toEqual([1, 2]);
  expect(result.remaining[0].source).toBe(citations[2]);
});

test('legacy named numeric and identifier citations preserve table dates without creating empty or app-route links', () => {
  const text = `### All holdings checked\n| Ticker | Security | Dated source |\n| --- | --- | --- |\n| ODFL | Old Dominion Freight Line | [Oct 5, 2026]([1]) |\n| WST | West Pharmaceutical Services | [Oct 5, 2026](${citations[1].id}) |\n\nSources: [ODFL alert]([1]), [WST alert]([2]).`;
  const section = analystChatSources(text, citations).sections[0];
  expect(section.markdown).toContain('| ODFL | Old Dominion Freight Line | Oct 5, 2026 |');
  expect(section.markdown).toContain('| WST | West Pharmaceutical Services | Oct 5, 2026 |');
  expect(section.markdown).not.toMatch(/\]\(\)|\]\(\[|Sources:/);
  expect(section.sources[0].numbers).toEqual([1, 2]);
  expect(text).toContain('[Oct 5, 2026]([1])');
});

test('literal legacy examples and unresolved destinations retain their evidence for the safe link renderer', () => {
  const text = `### Findings\nLiteral \`[Oct 5]([1])\` and https://example.com/[1].\n\n| Ticker | Dated source |\n| --- | --- |\n| ODFL | [Oct 5]([99]) |\n| WST | [Oct 5](cite_ffffffffffffffffffffffffffffffff) |`;
  const section = analystChatSources(text, citations).sections[0];
  expect(section.markdown).toContain('`[Oct 5]([1])`');
  expect(section.markdown).toContain('https://example.com/[1]');
  expect(section.markdown).toContain('[Oct 5]([99])');
  expect(section.markdown).toContain('[Oct 5](cite_ffffffffffffffffffffffffffffffff)');
  expect(section.sources).toEqual([]);
});

test('saved double-bracket citations leave one linked Sources footer in every section', () => {
  const original = `### Realignment\nDated Cover-SOME. [[1]]\n\nSources: [[1]] [[2]]\n\n### Aligned\n| Ticker | Reading |\n| --- | --- |\n| CVI | Bullish, 30 Sep [[3]] |\n\n**Sources:** **[[3]]**, []`;
  const result = analystChatSources(original, citations);
  expect(result.sections.map(section => section.markdown)).toEqual([
    '### Realignment\nDated Cover-SOME.',
    '### Aligned\n| Ticker | Reading |\n| --- | --- |\n| CVI | Bullish, 30 Sep  |',
  ]);
  expect(result.sections[0].sources[0].numbers).toEqual([1, 2]);
  expect(result.sections[0].sources[0].context.relatedSources).toEqual(citations.slice(0, 2));
  expect(result.sections[1].sources[0].numbers).toEqual([3]);
  expect(result.remaining).toEqual([]);
  expect(original).toContain('Sources: [[1]] [[2]]');
});

test('empty Sources placeholders disappear without removing meaningful source text', () => {
  const result = analystChatSources('### Findings\nSources: [] []\n**Sources:** [] , []\nSource: []\nSources:\nSources: publisher commentary [[1]]\nSources: [99]\nSources: [Exchange](https://example.com/report)', citations);
  expect(result.sections[0].markdown).not.toMatch(/Sources?:\s*\[\s*\]/);
  expect(result.sections[0].markdown).toContain('Sources: publisher commentary');
  expect(result.sections[0].markdown).toContain('Sources: [99]');
  expect(result.sections[0].markdown).toContain('Sources: [Exchange](https://example.com/report)');
  expect(result.sections[0].sources[0].numbers).toEqual([1]);
});

test('complete grouped or identifier wrappers resolve while unknown wrappers stay intact', () => {
  const result = analystChatSources(`### Findings\nKnown [[1, 2]]. Known [[${citations[2].id}]]. Unknown [[31]]. Mixed [[1, 99]].`, citations);
  expect(result.sections[0].markdown).toBe('### Findings\nKnown. Known. Unknown [[31]]. Mixed [[1, 99]].');
  expect(result.sections[0].sources.map(group => group.numbers)).toEqual([[1, 2], [3]]);
});

test('existing empty citation tails disappear after their valid reference moves to the footer', () => {
  const result = analystChatSources('### Watch list\n- Dated support remains separate. [] [] [[1]]\n- Inline code stays `[]` [[2]]\n- Provider URL stays https://example.com/[] [[3]]', citations);
  expect(result.sections[0].markdown).toBe('### Watch list\n- Dated support remains separate.\n- Inline code stays `[]`\n- Provider URL stays https://example.com/[]');
  expect(result.sections[0].sources.map(group => group.numbers)).toEqual([[1, 2], [3]]);
});

test('double-bracket external links and code retain their original source placeholders', () => {
  const body = '### Evidence\n[[1]](https://example.com/report), [1](https://example.com/report), https://example.com/[[1]] and `[[1]]`.\n\n~~~~markdown\nSources: [] [[1]]\n```\n[[2]]\n~~~\n~~~~\n\nActual [[3]].';
  const result = analystChatSources(body, citations);
  expect(result.sections).toHaveLength(1);
  expect(result.sections[0].markdown).toContain('[[1]](https://example.com/report), [1](https://example.com/report), https://example.com/[[1]] and `[[1]]`.');
  expect(result.sections[0].markdown).toContain('~~~~markdown\nSources: [] [[1]]\n```\n[[2]]\n~~~\n~~~~');
  expect(result.sections[0].markdown).toMatch(/Actual\.$/);
  expect(result.sections[0].sources[0].numbers).toEqual([3]);
});

test('unknown references, external links, inline code, and fenced examples keep their content', () => {
  const body = '### Evidence\n`【[1]】` and [99] and [1](https://example.com/report)\nhttps://example.com/[1]\n\n```markdown\n### An example\n【[2]】\n```\n\nActual reference. 【[1]】';
  const result = analystChatSources(body, citations);
  expect(result.sections).toHaveLength(1);
  expect(result.sections[0].markdown).toContain('`【[1]】` and [99] and [1](https://example.com/report)');
  expect(result.sections[0].markdown).toContain('https://example.com/[1]');
  expect(result.sections[0].markdown).toContain('```markdown\n### An example\n【[2]】\n```');
  expect(result.sections[0].markdown).toMatch(/Actual reference\.$/);
  expect(result.sections[0].sources[0].numbers).toEqual([1]);
});

test('captured table ticker identities remain available to earlier report sections', () => {
  const result = analystChatSources('### Findings\nGIII, CVI, CHH.\n\n### Checked\n| Ticker | Security |\n| --- | --- |\n| GIII | G-III Apparel |\n| CVI | CVR Energy |\n| CHH | name unavailable |\n\nGDP is an economic reading.', []);
  expect(result.securityTickers).toEqual(['GIII', 'CVI', 'CHH']);
  expect(result.securityNames).toEqual(expect.arrayContaining([{ name: 'G-III Apparel', ticker: 'GIII' }, { name: 'CVR Energy', ticker: 'CVI' }]));
  expect(result.sections[1].markdown).toContain('G-III Apparel');
  expect(result.sections[1].markdown).toContain('name unavailable');
});

test('malformed source slots do not shift the original reference numbering', () => {
  const result = analystChatSources('### Findings\nKnown [2]. Unknown [1].', [null, citations[0]]);
  expect(result.sections[0].markdown).toBe('### Findings\nKnown. Unknown [1].');
  expect(result.sections[0].sources[0].numbers).toEqual([2]);
  expect(analystChatSources('No sources [1].', null).sections[0].markdown).toBe('No sources [1].');
});
