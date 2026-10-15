import { remarkAnalystWatchList } from './analystWatchList';

const paragraph = value => ({ type: 'paragraph', children: [{ type: 'text', value }] });
const heading = (value, depth = 2) => ({ type: 'heading', depth, children: [{ type: 'text', value }] });
const list = (...items) => ({ type: 'list', ordered: false, children: items.map(children => ({ type: 'listItem', children })) });

test('Watch list items become paragraphs while captured formatting, evidence and other sections stay intact', () => {
  const first = paragraph('Unknown remains distinct from misaligned.');
  const citation = { type: 'link', url: 'citation://captured', children: [{ type: 'text', value: 'Source' }] };
  const second = { type: 'paragraph', children: [{ type: 'strong', children: [{ type: 'text', value: 'IBIT' }] }, citation] };
  const scope = list([paragraph('Account: captured')]);
  const sequence = { type: 'list', ordered: true, children: [{ type: 'listItem', children: [paragraph('Requalify')] }] };
  const otherList = list([paragraph('Aligned')]);
  const tree = { type: 'root', children: [heading('Verification scope'), scope, heading('Watch list'), list([first], [second]),
    heading('Recommended sequence'), sequence, otherList] };
  const present = remarkAnalystWatchList({ reviewKind: 'portfolio-cross-verification' });
  present(tree);
  expect(tree.children).toEqual([heading('Verification scope'), scope, heading('Watch list'), first, second,
    heading('Recommended sequence'), sequence, otherList]);
  expect(tree.children[4]).toBe(second);
  expect(second.children[1]).toBe(citation);
  const displayed = JSON.stringify(tree);
  present(tree);
  expect(JSON.stringify(tree)).toBe(displayed);
});

test('nested unordered items are paragraphs but code examples and ordered sequences stay unchanged', () => {
  const outer = paragraph('First reading');
  const inner = paragraph('Supporting reading');
  const code = { type: 'code', value: '## Watch list\n- Literal example' };
  const ordered = { type: 'list', ordered: true, children: [{ type: 'listItem', children: [paragraph('Step one')] }] };
  const tree = { type: 'root', children: [heading('Watch list'), list([outer, list([inner])]), code, ordered] };
  remarkAnalystWatchList({ reviewKind: 'portfolio-cross-verification' })(tree);
  expect(tree.children).toEqual([heading('Watch list'), outer, inner, code, ordered]);
});

test.each(['chat', 'balance-review', 'portfolio-review', 'prediction-markets-review'])('keeps %s lists unchanged', reviewKind => {
  const tree = { type: 'root', children: [heading('Watch list'), list([paragraph('Captured item')])] };
  const original = JSON.stringify(tree);
  remarkAnalystWatchList({ reviewKind })(tree);
  expect(JSON.stringify(tree)).toBe(original);
});
