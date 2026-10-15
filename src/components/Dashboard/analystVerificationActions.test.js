import { presentVerificationActions } from './analystVerificationActions';
import { presentVerificationMarkdown } from './analystVerificationPresentation';
import { analystChatSources } from './analystChatSources';

const citations = [
  { id: 'cite_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', product: 'real-time-alert', documentId: 'odfl', publicationDate: '2026-10-05', excerpt: 'ODFL Cover-SOME' },
  { id: 'cite_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', product: 'real-time-alert', documentId: 'odfl', publicationDate: '2026-10-05', excerpt: 'book-SOME' },
  { id: 'cite_cccccccccccccccccccccccccccccccc', product: 'real-time-alert', productLabel: 'Real-Time Alerts', documentId: 'wst', publicationDate: '2026-10-05', excerpt: 'WST Sell-SOME' },
];
const original = `## Highest-priority realignment

| Ticker | Security | Held side | Description | Review implication |
|---|---|---|---|---|
| ODFL | Old Dominion Freight Line, Inc. | Short | “Cover-SOME Signal”; the body says “book-SOME.” Oct 5, 2026. | Review the published partial-cover action against the existing Short. The capture does not authorize an executable trade. |
| WST | West Pharmaceutical Services, Inc. | Long | “Sell-SOME Signal (refreshed SPX Range).” Oct 5, 2026. | Review a partial Long reduction, not a full exit. |

Sources: [ODFL alert and scope]([1]), [ODFL body]([2]), [WST alert and scope]([3]).`;

test('saved realignment has concise actions and each explicitly cited product and original publication date', () => {
  const display = presentVerificationMarkdown(original, {}, citations);
  expect(display).toContain('| Ticker | Security | Held side | Action | Source |');
  expect(display).toContain(`| ODFL | Old Dominion Freight Line, Inc. | Short | Cover some | [Real Time Alert · Oct 5, 2026](citation://${citations[0].id}) |`);
  expect(display).toContain(`| WST | West Pharmaceutical Services, Inc. | Long | Sell some | [Real-Time Alerts · Oct 5, 2026](citation://${citations[2].id}) |`);
  expect(display).not.toMatch(/Description|Review implication|body says|capture does not authorize|partial Long reduction/);
  expect(original).toContain('The capture does not authorize an executable trade.');
  expect(presentVerificationMarkdown(display, {}, citations)).toBe(display);
  const sectioned = analystChatSources(display, citations);
  expect(sectioned.sections[0].markdown).toContain(`[Real Time Alert · Oct 5, 2026](citation://${citations[0].id})`);
  expect(sectioned.sections[0].markdown).not.toMatch(/Sources:|\]\(\)/);
  expect(sectioned.links.get(`citation://${citations[0].id}`)).toEqual({ source: citations[0], context: { relatedSources: citations.slice(0, 2) } });
  expect(sectioned.links.get(`citation://${citations[2].id}`)).toEqual({ source: citations[2], context: {} });
  expect(sectioned.sections[0].sources).toEqual([]);
  expect(sectioned.remaining).toEqual([]);
});

test('the action source stays in its row while other section readings keep their own footer citations', () => {
  const risk = { id: 'risk', product: 'risk-ranges', publicationDate: '2026-10-05' };
  const displayed = presentVerificationActions(`${original}\n\nOther reading [[4]].\n\n## Watch list\nOriginal alert [[1]].`, [...citations, risk]);
  const sectioned = analystChatSources(displayed, [...citations, risk]);
  expect(sectioned.sections[0].sources).toEqual([expect.objectContaining({ source: risk, numbers: [4] })]);
  expect(sectioned.sections[1].sources).toEqual([expect.objectContaining({ source: citations[0], numbers: [1] })]);
});

test.each([
  ['Cover-SOME, Sep 24 [[1]]', 'Cover some'], ['Sell-SOME Signal. [[1]]', 'Sell some'],
  ['Cover. [[1]]', 'Cover'], ['Sell. [[1]]', 'Sell'], ['Exit. [[1]]', 'Exit'],
  ['Cover all. [[1]]', 'Cover all'], ['Removed source Short, Sep 24 [[1]]', 'Removed source Short'],
])('preserves partial versus full meaning for %s and uses the publication attached to the issued row citation', (description, action) => {
  const text = `## Highest-priority realignment\n\n| Ticker | Security | Current side | Dated source action | Supported implication |\n| --- | --- | --- | --- | --- |\n| ODFL | Original name | Short | ${description} | Internal interpretation |`;
  const display = presentVerificationActions(text, citations);
  expect(display).toContain(`| ODFL | Original name | Short | ${action} | [Real Time Alert · Oct 5, 2026]`);
  expect(display).not.toContain('Sep 24');
});

test('unknown source association never borrows another ticker publication or invents an action', () => {
  const text = original.replace('“Cover-SOME Signal”; the body says “book-SOME.” Oct 5, 2026.', 'No Cover-SOME instruction')
    .replace('[ODFL alert and scope]([1]), [ODFL body]([2]), ', '');
  const display = presentVerificationActions(text, citations);
  expect(display).toContain('| ODFL | Old Dominion Freight Line, Inc. | Short | No Cover-SOME instruction | — |');
  expect(display).toContain('| Long | Sell some | [Real-Time Alerts · Oct 5, 2026]');
});

test('one explicitly cited publication can support separate named action rows without dropping the second association', () => {
  const text = original.replace('[WST alert and scope]([3])', '[WST alert and scope]([1])');
  const display = presentVerificationActions(text, citations);
  expect(display).toContain(`| Long | Sell some | [Real Time Alert · Oct 5, 2026](citation://${citations[0].id}) |`);
});

test.each(['Cover some only if Trade breaks', 'Sell some when Trend breaks', 'Cover some or retain Short', 'Consider Sell-SOME'])('retains the qualification in %s rather than inventing an unconditional action', action => {
  const text = original.replace('“Cover-SOME Signal”; the body says “book-SOME.” Oct 5, 2026.', action);
  expect(presentVerificationActions(text, citations)).toContain(`| Short | ${action} |`);
});

test('supporting review citations remain in the section footer without becoming action provenance', () => {
  const source = { ...citations[0], publicationDate: '2026-09-24' };
  const range = { id: 'risk', product: 'risk-ranges', publicationDate: '2026-10-05' };
  const text = `## Highest-priority realignment\n\n| Ticker | Security | Held side | Description | Review implication |\n| --- | --- | --- | --- | --- |\n| ODFL | Captured name | Short | Cover-SOME [[1]] | Supported by newer range [[2]] |`;
  const display = presentVerificationActions(text, [source, range]);
  const actionRow = display.split('\n').find(line => line.startsWith('| ODFL |'));
  expect(actionRow).toContain('[Real Time Alert · Sep 24, 2026]');
  expect(actionRow).not.toContain('Risk Ranges');
  const sectioned = analystChatSources(display, [source, range]);
  expect(sectioned.sections[0].sources).toEqual([expect.objectContaining({ source: range, numbers: [2] })]);
  expect(sectioned.remaining).toEqual([]);
  const footerCited = text.replace('Cover-SOME [[1]]', 'Cover-SOME').replace('Supported by newer range [[2]]', 'Review captured action')
    + '\n\nSources: [ODFL alert]([1]), [ODFL Trend and range]([2]).';
  const footerDisplay = presentVerificationActions(footerCited, [source, range]);
  expect(footerDisplay.split('\n').find(line => line.startsWith('| ODFL |'))).not.toContain('Risk Ranges');
  expect(analystChatSources(footerDisplay, [source, range]).sections[0].sources).toEqual([expect.objectContaining({ source: range, numbers: [2] })]);
});

test('inline code citations never associate a source and indented code tables stay literal', () => {
  const inline = '## Highest-priority realignment\n\n| Ticker | Security | Held side | Description | Review implication |\n| --- | --- | --- | --- | --- |\n| ODFL | Captured name | Short | Cover-SOME `[[1]]` | Original interpretation |';
  expect(presentVerificationActions(inline, citations)).toContain('| Short | Cover some | — |');
  const literalFooter = `${inline}\n\nSources: \`[ODFL]([1])\``;
  expect(presentVerificationActions(literalFooter, citations)).toContain('Sources: `[ODFL]([1])`');
  const indented = original.split('\n').map(line => line.startsWith('|') ? `    ${line}` : line).join('\n');
  expect(presentVerificationActions(indented, citations)).toBe(indented);
});

test('new Action/Source tables are idempotent and publication instants display in Pacific time', () => {
  const source = { id: 'a', productLabel: 'Captured Product', publishedAt: '2026-10-05T14:49:58Z' };
  const text = '## Highest-priority realignment\n\n| Ticker | Security | Held side | Action | Source |\n| --- | --- | --- | --- | --- |\n| WST | Captured name | Long | Sell some | Captured Product [[1]] |';
  const display = presentVerificationActions(text, [source]);
  expect(display).toContain('[Captured Product · Oct 5, 2026 07:49 PDT](citation://a)');
  expect(presentVerificationActions(display, [source])).toBe(display);
});

test('unrelated tables, quote examples, malformed rows, and fenced source evidence stay untouched', () => {
  const outside = original.replace('Highest-priority realignment', 'All holdings checked');
  expect(presentVerificationActions(outside, citations)).toBe(outside);
  const fenced = `\`\`\`\`markdown\n${original}\n\`\`\`\n${original}\n\`\`\`\``;
  expect(presentVerificationActions(fenced, citations)).toBe(fenced);
  const malformed = original.replace('| WST | West Pharmaceutical Services, Inc. | Long |', '| WST | Long |');
  expect(presentVerificationActions(malformed, citations)).toBe(malformed);
});
