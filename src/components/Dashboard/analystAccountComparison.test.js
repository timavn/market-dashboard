import { remarkAnalystAccountComparison } from './analystAccountComparison';
import { remarkAnalystProcessColors } from './analystProcessColors';
import { accountComparisonCents, accountComparisonMeaning, accountComparisonMetric, isAccountComparisonTable } from '../../utils/analystAccountComparison';

const text = value => ({ type: 'text', value });
const cell = value => ({ type: 'tableCell', children: [text(value)] });
const row = values => ({ type: 'tableRow', children: values.map(cell) });
const content = node => node?.value ?? (node?.children || []).map(content).join('');
const headers = ['Metric', 'Sep 22, 19:37 UTC', 'Sep 23, 16:13 UTC', 'Direction'];
const makeTable = (values, heading = headers) => ({ type: 'table', children: [row(heading), ...values.map(row)] });
const transform = table => {
  remarkAnalystAccountComparison()({ type: 'root', children: [table] });
  return table;
};
const values = [
  ['Net liquidation value', '$175,880.09', '$178,312.51', 'Improved'],
  ['Initial margin', '$85,027.82', '$83,016.21', 'Lower'],
  ['Maintenance margin', '$81,580.47', '$79,652.39', 'Lower'],
  ['Available funds', '$90,788.14', '$94,737.45', 'Higher'],
  ['Excess liquidity', '$94,237.15', '$98,590.24', 'Higher'],
  ['Buying power', '$363,152.54', '$380,904.93', 'Higher'],
  ['Gross market value', '$258,083.83', '$251,210.62', 'Lower'],
  ['Net market value', '+$6,025.30', '+$2,698.77', 'Less net long'],
  ['Maintenance deficit', '$0', '$0', 'No deficit'],
  ['Long market value', '$132,054.57', '$126,954.70', 'Lower'],
  ['Short market value', '$126,029.27', '$124,255.93', 'Lower'],
  ['Accrued debit', '$139.03', '$136.59', 'Lower'],
];

test('saved account tables gain exact changes and explanations without changing original observations', () => {
  const table = makeTable(values);
  const originalCells = table.children.map(item => item.children.slice(0, 3));
  transform(table);
  expect(table.data.hProperties.className).toContain('is-account-comparison');
  expect(table.children[0].children.map(content)).toEqual([...headers.slice(0, 3), 'Dollar change', 'What this means for the account']);
  expect(table.children.slice(1).map(item => content(item.children[3]))).toEqual([
    '+$2,432.42', '−$2,011.61', '−$1,928.08', '+$3,949.31', '+$4,353.09', '+$17,752.39', '−$6,873.21', '−$3,326.53', '$0.00', '−$5,099.87', '−$1,773.34', '−$2.44',
  ]);
  table.children.forEach((item, i) => item.children.slice(0, 3).forEach((node, j) => expect(node).toBe(originalCells[i][j])));
  expect(content(table.children[7].children[4])).toContain('146.74% to 140.88%');
  expect(content(table.children[8].children[4])).toContain('3.43% to 1.51%');
  expect(content(table.children[9].children[4])).toContain('Neither snapshot shows a maintenance shortfall');
  expect(content(table.children[12].children[4])).toContain('interest ledger');
  // Every dollar change reads by its own sign, whatever the metric: a fall is red.
  expect(table.children[2].children[3].data.hProperties.className).toEqual(['analyst-account-change--negative']);
  expect(table.children[7].children[3].data.hProperties.className).toEqual([expect.stringMatching(/^analyst-account-change--(?:positive|negative|muted)$/)]);
  const once = JSON.stringify(table);
  transform(table);
  expect(JSON.stringify(table)).toBe(once);
});

test.each([
  ['$0', 0], ['$0.30', 30], ['+$1,234.56', 123456], ['-$1,234.56', -123456], ['$-12.1', -1210], ['−$12.10', -1210], ['($12.10)', -1210],
  ['€12.10', null], ['$1.2k', null], ['$1.234', null], ['~$12', null], ['$12 stale', null], ['12%', null], ['—', null], ['', null], ['$1,23', null], ['-$-12', null], ['(-$12)', null],
])('parses complete, unambiguous dollar observations: %s', (input, expected) => {
  expect(accountComparisonCents(input)).toBe(expected);
});

test.each(['offline', 'stale', 'cache-only', 'mock', 'seeded', 'unverified', 'unavailable'])('does not derive a change from %s evidence', state => {
  const table = transform(makeTable([values[0], ['Initial margin', '$100', '$90', state]]));
  expect(content(table.children[2].children[3])).toBe('—');
  expect(content(table.children[2].children[4])).toContain(state);
  expect(content(table.children[2].children[4])).toContain('cannot be established');
});

test('missing and incompatible values retain their source text without false changes or ratios', () => {
  const table = transform(makeTable([['Net liquidation value', '$100', 'Unavailable', 'Unavailable'], ['Gross market value', '$150', '$140', 'Lower'], ['Initial margin', '€100', '$90', 'Lower']]));
  expect(content(table.children[1].children[3])).toBe('—');
  expect(content(table.children[2].children[4])).not.toContain('%');
  expect(content(table.children[3].children[1])).toBe('€100');
  expect(content(table.children[3].children[3])).toBe('—');
});

test('a declining balance and rising requirements get the appropriate interpretation', () => {
  const table = transform(makeTable([['Net liquidation value', '$200', '$100', 'Lower'], ['Initial margin', '$50', '$80', 'Higher']]));
  expect(content(table.children[1].children[4])).toContain('less capital');
  expect(content(table.children[2].children[4])).toContain('more collateral');
  // A rising requirement is a positive change, so it reads green like every positive number.
  expect(table.children[2].children[3].data.hProperties.className).toEqual(['analyst-account-change--positive']);
});

test('net side changes and signed short amounts do not imply trades or market neutrality', () => {
  expect(accountComparisonMeaning(accountComparisonMetric('Net exposure'), 100, -50)).toContain('from net long to net short');
  expect(accountComparisonMeaning(accountComparisonMetric('Net exposure'), -100, -50)).toContain('less net short');
  expect(accountComparisonMeaning(accountComparisonMetric('Short exposure'), -100, -50)).toContain('short side decreased');
  expect(accountComparisonMeaning(accountComparisonMetric('Net exposure'), 100, 0)).toContain('to dollar balanced');
});

test('source links and authored explanations remain intact', () => {
  const link = { type: 'link', url: 'https://www.ibkrguides.com/example', children: [text('Evidence')] };
  const table = makeTable(values.slice(0, 2));
  table.children[1].children[3].children = [text('Improved — '), link];
  transform(table);
  expect(table.children[1].children[4].children).toContain(link);
  const authored = makeTable([['Net liquidation value', '$100', '$101', '+$1.00', 'Reconciled deposit.'], ['Initial margin', '$50', '$49', '−$1.00', 'Published change.']], [...headers.slice(0, 3), 'Dollar change', 'What this means for the account']);
  const original = authored.children;
  transform(authored);
  expect(authored.children).toBe(original);
});

test('a single-metric answer in the explicit new format gets the same readable layout', () => {
  const table = makeTable([['Accrued debit', '$20', '$21', '+$1.00', 'The ledger identifies the new charge.']], [...headers.slice(0, 3), 'Dollar change', 'What this means for the account']);
  const original = table.children;
  transform(table);
  expect(table.data.hProperties.className).toContain('is-account-comparison');
  expect(table.children).toBe(original);
});

test('unrelated, undated, mixed-currency and malformed tables are not rewritten', () => {
  for (const table of [
    makeTable([['SPY', '$100', '$110', 'Bullish']], ['Ticker', ...headers.slice(1)]),
    makeTable(values.slice(0, 2), ['Metric', 'Yesterday', 'Today', 'Direction']),
    makeTable(values.slice(0, 2), ['Metric', 'Sep 22 USD', 'Sep 23 CAD', 'Direction']),
    makeTable([values[0], ['Unrecognized metric', '$5', '$6', 'Higher']]),
    makeTable([values[0], ['Initial margin', '$50', '$49']]),
  ]) {
    const original = JSON.stringify(table);
    transform(table);
    expect(JSON.stringify(table)).toBe(original);
  }
  expect(isAccountComparisonTable(headers, ['Trade', 'Trend'])).toBe(false);
});

test('the shared semantic pass colors directional words in added explanations', () => {
  const table = transform(makeTable([values[0], values[9]]));
  const tree = { type: 'root', children: [table] };
  const original = content(tree);
  remarkAnalystProcessColors({ reviewKind: 'chat' })(tree, { value: '' });
  expect(content(tree)).toBe(original);
  expect(table.children[2].children[4].children.some(node => node.type === 'analystProcessText' && content(node) === 'long')).toBe(true);
});
