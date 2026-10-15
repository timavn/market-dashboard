import { remarkAnalystVerificationTables } from './analystVerificationTables';

const table = headers => ({ type: 'table', children: [{ type: 'tableRow', children: headers.map(value => ({
  type: 'tableCell', children: [{ type: 'text', value }],
})) }] });

test('bounds securities and separate contract checks without tagging other tables', () => {
  const securities = table(['Ticker', 'Security', 'Held side', 'Dated source reading', 'Check / implication']);
  const contracts = table(['Ticker', 'Security', 'Held side / contract', 'Dated source reading', 'Check / implication']);
  const currentContracts = table(['Contract', 'YES/NO', 'Dated source reading', 'Check / implication']);
  const coverage = table(['Product', 'Latest publication']);
  const positioning = table(['Ticker', 'Security', 'Current side', 'Dated source action', 'Supported implication']);
  securities.data = { hProperties: { className: ['existing'], title: 'Captured holdings' } };
  const tree = { type: 'root', children: [securities, contracts, currentContracts, coverage, positioning] };
  const display = remarkAnalystVerificationTables({ reviewKind: 'portfolio-cross-verification' });
  display(tree);
  display(tree);
  expect(securities.data.hProperties).toEqual({ className: ['existing', 'is-holdings-check'], title: 'Captured holdings' });
  expect(contracts.data.hProperties.className).toEqual(['is-holdings-contracts']);
  expect(currentContracts.data.hProperties.className).toEqual(['is-holdings-contracts']);
  expect(coverage.data).toBeUndefined();
  expect(positioning.data.hProperties.className).toEqual(['is-realignment-check']);
  expect(positioning.children[0].children[3].children).toEqual([{ type: 'text', value: 'Action' }]);
});

test('renames only the realignment action header and preserves captured body cells and hover metadata', () => {
  const realignment = table(['Ticker', 'Security', 'Current side', 'Dated source action', 'Supported implication']);
  const capturedRow = { type: 'tableRow', children: ['CHH', 'Choice Hotels International', 'Short',
    'Real-Time Alert, 24 Sep 2026 15:37 EDT: Cover-SOME. [[1]]', 'Review dated action'].map(value => ({
    type: 'tableCell', children: [{ type: 'text', value }],
  })) };
  capturedRow.children[1].data = { hProperties: { title: 'Choice Hotels International' } };
  realignment.children.push(capturedRow);
  const originalBody = JSON.stringify(capturedRow);
  const other = table(['Ticker', 'Security', 'Trend', 'Dated source action']);
  const tree = { type: 'root', children: [realignment, other] };
  const present = remarkAnalystVerificationTables({ reviewKind: 'portfolio-cross-verification' });
  present(tree);
  expect(realignment.children[0].children[3].children).toEqual([{ type: 'text', value: 'Action' }]);
  expect(JSON.stringify(capturedRow)).toBe(originalBody);
  expect(other.data).toBeUndefined();
  expect(other.children[0].children[3].children[0].value).toBe('Dated source action');
  const displayed = JSON.stringify(tree);
  present(tree);
  expect(JSON.stringify(tree)).toBe(displayed);
});

test('the five-column Action/Source table uses compact realignment geometry, not complete-roster widths', () => {
  const realignment = table(['Ticker', 'Security', 'Held side', 'Action', 'Source']);
  remarkAnalystVerificationTables({ reviewKind: 'portfolio-cross-verification' })({ type: 'root', children: [realignment] });
  expect(realignment.data.hProperties.className).toEqual(['is-realignment-check']);
});

test.each(['chat', 'balance-review', 'portfolio-review', 'prediction-markets-review'])('leaves %s tables unchanged', reviewKind => {
  const tree = { type: 'root', children: [table(['Ticker', 'Security', 'Held side'])] };
  const before = JSON.stringify(tree);
  remarkAnalystVerificationTables({ reviewKind })(tree);
  expect(JSON.stringify(tree)).toBe(before);
});
