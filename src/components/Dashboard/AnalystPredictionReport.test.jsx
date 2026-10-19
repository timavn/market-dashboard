import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import ReactMarkdown from 'react-markdown';
import AnalystPredictionReport from './AnalystPredictionReport';
import { remarkAnalystProcessColors } from './analystProcessColors';

jest.mock('remark-gfm', () => function mockGfm() {});
jest.mock('react-markdown', () => {
  function MarkdownMock(props) {
    MarkdownMock.renderSpy(props);
    return <div>{props.children}</div>;
  }
  MarkdownMock.renderSpy = jest.fn();
  return { __esModule: true, default: MarkdownMock, defaultUrlTransform: value => value };
});

test.each(['HedgAI', 'Tick'])('saved %s comparison displays Tick with shared semantics and original captured source links', signalLabel => {
  ReactMarkdown.renderSpy.mockClear();
  const source = { id: 'captured-hedgai', product: 'hedgai-signals', productLabel: 'HedgAI Signals', title: 'Captured Sep 28 book' };
  const onCitation = jest.fn();
  const markdown = `## S&P 500\n**${signalLabel}:** Long SPY proxy\n**Trade:** Bullish\n\n<details data-analyst-hedgai>\n<summary>${signalLabel} comparison · 5 securities</summary>\n\n| Ticker | Contribution |\n| --- | --- |\n| QQQ | Short excluded |\n\nSources: [captured-hedgai]\n</details>`;
  render(<AnalystPredictionReport markdown={markdown}
    citations={[source]} onCitation={onCitation} />);
  const summary = screen.getByText('Tick comparison · 5 securities');
  expect(summary.parentElement).toHaveProperty('open', false);
  const calls = ReactMarkdown.renderSpy.mock.calls.map(([props]) => props);
  expect(calls).toHaveLength(2);
  expect(calls[0].children).not.toContain('<details');
  expect(calls[0].children).not.toContain('QQQ');
  expect(calls[1].children).toContain('QQQ | Short excluded');
  expect(calls.every(props => props.remarkPlugins.some(plugin => Array.isArray(plugin)
    && plugin[0] === remarkAnalystProcessColors && plugin[1].reviewKind === 'prediction-markets-review'))).toBe(true);
  const Strong = calls[0].components.strong;
  render(<>
    <Strong node={{ children: [{ type: 'text', value: `${signalLabel}:` }] }}>{`${signalLabel}:`}</Strong>
    <Strong node={{ children: [{ type: 'text', value: 'HedgAI publication' }] }}>HedgAI publication</Strong>
  </>);
  expect(screen.getByText('Tick:', { exact: true })).toBeInTheDocument();
  expect(screen.getByText('HedgAI publication', { exact: true })).toBeInTheDocument();
  expect(markdown).toContain(`**${signalLabel}:** Long SPY proxy`);
  expect(markdown).toContain(`<summary>${signalLabel} comparison`);
  const href = calls[1].children.match(/\]\((citation:\/\/[^)]+)\)/)[1];
  const Link = calls[1].components.a;
  render(<Link href={href}>HedgAI Signals</Link>);
  fireEvent.click(screen.getByRole('button', { name: 'Source: HedgAI Signals' }));
  expect(onCitation).toHaveBeenCalledWith(source, {});
});

test('saved review puts dates in reading tables, keeps footer sources, and enables blue tickers', () => {
  ReactMarkdown.renderSpy.mockClear();
  render(<AnalystPredictionReport markdown={'### S&P 500\n**Trade:** Bearish · SPX · Sep 17, 2026 · [Source](https://example.com/report)\n**Trend:** Bullish · SPX · Sep 29, 2026'} />);
  const props = ReactMarkdown.renderSpy.mock.calls[0][0];
  expect(props.children).toContain('| Metric | Reading | Date |');
  expect(props.children).toContain('| Trade | Bearish · SPX | Sep 17, 2026 |');
  expect(props.children).toContain('| Trend | Bullish · SPX | Sep 29, 2026 |');
  expect(props.children.trim()).toMatch(/Sources: \[Source\]\(https:\/\/example.com\/report\)$/);
  expect(props.children).not.toContain('review-date://');
  expect(props.remarkPlugins).toContainEqual([remarkAnalystProcessColors, { reviewKind: 'prediction-markets-review' }]);
});

test('research tables use bordered table layout with a final date column and full-name tooltips', () => {
  ReactMarkdown.renderSpy.mockClear();
  render(<AnalystPredictionReport markdown="### S&P 500" />);
  const { table: Table, td: Cell } = ReactMarkdown.renderSpy.mock.calls[0][0].components;
  const headers = ['Ticker', 'Security', 'Change', 'Date'];
  const node = { children: [{ tagName: 'thead', children: [{ tagName: 'tr', children: headers.map(value => ({ tagName: 'th', children: [{ type: 'text', value }] })) }] }] };
  const fullName = 'State Street SPDR S&P Aerospace & Defense ETF';
  render(<Table node={node}><thead><tr>{headers.map(label => <th key={label}>{label}</th>)}</tr></thead>
    <tbody><tr><td>XAR</td><Cell node={{ children: [{ type: 'text', value: fullName }] }}>{fullName}</Cell><td>Bearish</td><td>Since Jun 24, 2026</td></tr></tbody>
  </Table>);
  const tableElement = screen.getByRole('table');
  expect(tableElement.parentElement).toHaveClass('analyst-table-frame', 'has-dates', 'has-securities');
  expect(screen.getByRole('cell', { name: fullName })).toHaveAttribute('title', fullName);
  expect(screen.getAllByRole('columnheader').map(header => header.textContent)).toEqual(headers);
});

test.each([false, true])('native contract comparison preserves captured labels and readings with payoff column %s', hasPayoff => {
  ReactMarkdown.renderSpy.mockClear();
  const headers = ['Level', 'Outcome', 'Side', 'Price', 'Market-implied odds',
    ...(hasPayoff ? ['Gross reward/risk (before fees)'] : [])];
  const values = ['Next strike', '≥ 3.6%', 'NO', '$0.42', '42%', ...(hasPayoff ? ['1.38×'] : [])];
  const markdown = `### CPI\n| ${headers.join(' | ')} |\n| ${headers.map(() => '---').join(' | ')} |\n| ${values.join(' | ')} |`;
  render(<AnalystPredictionReport markdown={markdown} />);
  const props = ReactMarkdown.renderSpy.mock.calls[0][0];
  expect(props.children).toContain(`| ${headers.join(' | ')} |`);
  expect(props.children).toContain(`| ${values.join(' | ')} |`);
  const Table = props.components.table;
  const node = { children: [{ tagName: 'thead', children: [{ tagName: 'tr', children: headers.map(value => ({ tagName: 'th', children: [{ type: 'text', value }] })) }] }] };
  render(<Table node={node}><thead><tr>{headers.map(label => <th key={label}>{label}</th>)}</tr></thead>
    <tbody><tr>{values.map((value, index) => <td key={headers[index]}>{value}</td>)}</tr></tbody>
  </Table>);
  const table = screen.getByRole('table');
  expect(table.parentElement).toHaveClass('is-contract-comparison');
  expect(screen.getAllByRole('columnheader').map(header => header.textContent)).toEqual(headers);
  expect(screen.getAllByRole('cell').map(value => value.textContent)).toEqual(values);
  expect([...table.querySelectorAll('col')].map(column => column.className)).toEqual([
    'analyst-prediction-contract-level-col', 'analyst-prediction-contract-outcome-col',
    'analyst-prediction-contract-side-col', 'analyst-prediction-contract-price-col',
    'analyst-prediction-contract-odds-col', ...(hasPayoff ? ['analyst-prediction-contract-payoff-col'] : []),
  ]);
});

test('observation and initiation dates retain their meaning in an inline reading', () => {
  ReactMarkdown.renderSpy.mockClear();
  render(<AnalystPredictionReport markdown="### S&P 500" />);
  const Cell = ReactMarkdown.renderSpy.mock.calls[0][0].components.td;
  const value = 'Sep 28, 2026 · Initiated Sep 11, 2026';
  render(<table><tbody><tr><Cell node={{ children: [{ type: 'text', value }] }}>{value}</Cell></tr></tbody></table>);
  expect(screen.getByText('Sep 28, 2026', { exact: true })).toHaveClass('analyst-prediction-cell-date');
  expect(screen.getByText('Initiated Sep 11, 2026', { exact: true })).toHaveClass('analyst-prediction-cell-date');
  expect(screen.getByRole('cell')).toHaveAttribute('title', value);
  expect(screen.getByRole('cell')).toHaveTextContent(value);
});

test('saved Tick comparison narrows security names and keeps short status readings inline', () => {
  ReactMarkdown.renderSpy.mockClear();
  render(<AnalystPredictionReport markdown="### S&P 500" />);
  const { table: Table, td: Cell } = ReactMarkdown.renderSpy.mock.calls[0][0].components;
  const headers = ['Ticker', 'Security', 'Tick', 'Contribution', 'Initiated', 'Bull history', 'Bear history', 'Statistics date'];
  const node = { children: [{ tagName: 'thead', children: [{ tagName: 'tr', children: headers.map(value => ({ tagName: 'th', children: [{ type: 'text', value }] })) }] }] };
  const fullName = 'Invesco Nasdaq 100 ETF (proxy)';
  render(<Table node={node}><thead><tr>{headers.map(label => <th key={label}>{label}</th>)}</tr></thead>
    <tbody><tr><td>QQQ</td><Cell node={{ children: [{ type: 'text', value: fullName }] }}>{fullName}</Cell>
      <Cell node={{ children: [{ type: 'text', value: 'Wait' }] }}>Wait</Cell>
      <Cell node={{ children: [{ type: 'text', value: 'Last known Wait' }] }}>Last known Wait</Cell>
      <td>—</td><td>—</td><td>—</td><td>—</td>
    </tr></tbody>
  </Table>);
  const tableElement = screen.getByRole('table');
  expect(tableElement.parentElement).toHaveClass('has-securities', 'is-tick-comparison');
  expect(tableElement.querySelectorAll('col')).toHaveLength(headers.length);
  expect(tableElement.querySelector('col:nth-child(2)')).toHaveClass('analyst-prediction-security-col');
  expect(screen.getByRole('cell', { name: fullName })).toHaveAttribute('title', fullName);
  expect(screen.getByRole('cell', { name: 'Last known Wait' })).toHaveClass('analyst-prediction-short-reading');
  expect(screen.getByRole('cell', { name: 'Last known Wait' })).toHaveAttribute('title', 'Last known Wait');
});

test('unchanged captured report props do not parse Markdown again while a revised capture does', () => {
  ReactMarkdown.renderSpy.mockClear();
  const props = { markdown: '### Silver\n**Trend:** Bullish', citations: [], onCitation: jest.fn() };
  const { rerender } = render(<AnalystPredictionReport {...props} />);
  expect(ReactMarkdown.renderSpy).toHaveBeenCalledTimes(1);
  rerender(<AnalystPredictionReport {...props} />);
  expect(ReactMarkdown.renderSpy).toHaveBeenCalledTimes(1);
  rerender(<AnalystPredictionReport {...props} markdown={'### Silver\n**Trend:** Bearish'} />);
  expect(ReactMarkdown.renderSpy).toHaveBeenCalledTimes(2);
  expect(ReactMarkdown.renderSpy.mock.calls[1][0].children).toContain('Bearish');
});

test('setup board tables use their own fit-to-width columns and wrapping observation times', () => {
  ReactMarkdown.renderSpy.mockClear();
  render(<AnalystPredictionReport markdown="## Metals" />);
  const { table: Table, td: Cell } = ReactMarkdown.renderSpy.mock.calls[0][0].components;
  const headers = ['Market', 'Price', 'Risk Range', 'In range', 'Tick', 'Trade', 'Trend', 'Setup', 'As of (PT)'];
  const node = { children: [{ tagName: 'thead', children: [{ tagName: 'tr', children: headers.map(value => ({ tagName: 'th', children: [{ type: 'text', value }] })) }] }] };
  render(<Table node={node}><thead><tr>{headers.map(label => <th key={label}>{label}</th>)}</tr></thead><tbody><tr>
    <Cell node={{ children: [{ type: 'text', value: 'Oct 12 07:06' }] }}>Oct 12 07:06</Cell></tr></tbody></Table>);
  expect(screen.getByRole('table').parentElement).toHaveClass('is-setup-board');
  expect(screen.getByRole('table').parentElement).not.toHaveClass('is-range-board');
  expect(screen.getByRole('table').parentElement).not.toHaveClass('has-dates');
  // A compact time is ordinary wrapping text, not a no-wrap date that can overflow the report.
  expect(screen.getByText('Oct 12 07:06')).not.toHaveClass('analyst-prediction-cell-date');
});

test('current setup boards draw the combined range column; saved boards keep their own columns', () => {
  ReactMarkdown.renderSpy.mockClear();
  render(<AnalystPredictionReport markdown="## Metals" />);
  const { table: Table, td: Cell } = ReactMarkdown.renderSpy.mock.calls[0][0].components;
  const headers = ['Market', 'Price and Risk Range', 'Tick', 'Trade', 'Trend', 'Setup', 'As of (PT)'];
  const node = { children: [{ tagName: 'thead', children: [{ tagName: 'tr', children: headers.map(value => ({ tagName: 'th', children: [{ type: 'text', value }] })) }] }] };
  render(<Table node={node}><thead><tr>{headers.map(label => <th key={label}>{label}</th>)}</tr></thead><tbody><tr>
    <Cell node={{ children: [{ type: 'text', value: 'RR(4100;4237;4197;0;)' }] }}>RR(4100;4237;4197;0;)</Cell></tr></tbody></Table>);
  expect(screen.getByRole('table').parentElement).toHaveClass('is-setup-board', 'is-range-board');
  expect(screen.getByRole('img')).toHaveAccessibleName('Price 4,197 · Risk Range 4,100–4,237 · 71%');
  expect(screen.queryByText(/RR\(/)).toBeNull();
});

test('bias cells stack direction, date and product; missing readings read N/A', () => {
  ReactMarkdown.renderSpy.mockClear();
  render(<AnalystPredictionReport markdown="## Metals" />);
  const { td: Cell } = ReactMarkdown.renderSpy.mock.calls[0][0].components;
  const cell = value => <Cell node={{ children: [{ type: 'text', value }] }}>{value}</Cell>;
  const { container } = render(<table><tbody><tr>
    {cell('BIAS(Neutral;Sep 28;HedgAI GLD)')}{cell('BIAS(N/A;;)')}{cell('BIAS(Bearish;Oct 13;Risk Ranges)')}{cell('MKT(Nasdaq-100;COMPQ range)')}
  </tr></tbody></table>);
  const [tick, trade, trend, market] = container.querySelectorAll('td');
  expect([...tick.children].map(span => span.textContent)).toEqual(['Neutral', 'Sep 28', 'HedgAI GLD']);
  expect([...trade.children].map(span => span.textContent)).toEqual(['N/A']);
  expect(trend.firstChild).toHaveClass('analyst-process--negative');
  expect([...market.children].map(span => span.textContent)).toEqual(['Nasdaq-100', 'COMPQ range']);
  expect(container).not.toHaveTextContent(/BIAS\(|MKT\(/);
});

test('the Dollar reference row and As of cells stack pull time with each signal publication and product', () => {
  ReactMarkdown.renderSpy.mockClear();
  render(<AnalystPredictionReport markdown="## Metals" />);
  const { td: Cell } = ReactMarkdown.renderSpy.mock.calls[0][0].components;
  const cell = value => <Cell node={{ children: [{ type: 'text', value }] }}>{value}</Cell>;
  const { container } = render(<table><tbody><tr>
    {cell('REF(US Dollar;DXY)')}{cell('BIAS(Bullish;;)')}{cell('ASOF(Oct 13 06:41;Sep 9,HedgAI GLD;,;Oct 13,Risk Ranges)')}
  </tr></tbody></table>);
  const [market, bias, asOf] = container.querySelectorAll('td');
  expect(market).toHaveClass('analyst-prediction-reference-cell');
  expect([...market.children].map(span => span.textContent)).toEqual(['US Dollar', 'DXY']);
  expect([...bias.children].map(span => span.textContent)).toEqual(['Bullish']);
  expect([...asOf.children].map(span => span.textContent))
    .toEqual(['Oct 13 06:41', 'Ti HedgAI GLD Sep 09', 'Ta N/A', 'Te Risk Ranges Oct 13']);
  expect(container).not.toHaveTextContent(/ASOF\(|REF\(/);
});


test('Alpha Code cells stack Trade and Trend with the price above or below each, and the product', () => {
  ReactMarkdown.renderSpy.mockClear();
  render(<AnalystPredictionReport markdown="## Rates" />);
  const { td: Cell, table: Table } = ReactMarkdown.renderSpy.mock.calls[0][0].components;
  const cell = value => <Cell node={{ children: [{ type: 'text', value }] }}>{value}</Cell>;
  const headers = ['Market', 'Tick', 'Trade', 'Trend', 'Alpha Code', 'Price and Risk Range', 'As of (PT)'];
  const node = { children: [{ tagName: 'thead', children: [{ tagName: 'tr', children: headers.map(value => ({ tagName: 'th', children: [{ type: 'text', value }] })) }] }] };
  const { container } = render(<Table node={node}><tbody><tr>
    {cell('ALPHA(5.10;4.76;below;above;%;0;Top 3 Things)')}{cell('ALPHA(83,000;78,000;below;above;;1;The Macro Show)')}{cell('ALPHA(;4.40;;above;%;0;Top 3 Things)')}
  </tr></tbody></Table>);
  expect(container.querySelector('.analyst-table-frame')).toHaveClass('is-range-board', 'has-alpha');
  const [ust10y, bitcoin, ust2y] = container.querySelectorAll('td');
  expect([...ust10y.children].map(span => span.textContent)).toEqual(['Ta 5.10%▼', 'Te 4.76%▲', 'Top 3 Things']);
  expect(ust10y).toHaveAttribute('title', 'Alpha Code · Trade 5.10% (price below) · Trend 4.76% (price above) · Top 3 Things');
  expect(ust10y.querySelector('[aria-label="price below"]')).toHaveClass('analyst-process--negative');
  expect([...bitcoin.children].map(span => span.textContent)).toEqual(['Ta ~83,000▼', 'Te ~78,000▲', 'The Macro Show']);
  expect([...ust2y.children].map(span => span.textContent)).toEqual(['Ta N/A', 'Te 4.40%▲', 'Top 3 Things']);
  expect(container).not.toHaveTextContent(/ALPHA\(/);
});

test('analyst-research blocks list one row per mention, its context, time and source, and each quiet market', () => {
  ReactMarkdown.renderSpy.mockClear();
  render(<AnalystPredictionReport markdown="## Crypto" />);
  const { pre: Pre } = ReactMarkdown.renderSpy.mock.calls[0][0].components;
  const research = { markets: [
    { market: 'Bitcoin', entries: [
      { product: 'The Macro Show', time: '07:55', context: 'Bitcoin remained a minimum-sized long with bearish trade but bullish trend',
        source: 'Cooper noted that Keith sold all Ethereum on Tuesday. Bitcoin remained a minimum-sized long with bearish trade but bullish trend' },
      { product: 'The Macro Show', time: '07:55', context: 'Long Bitcoin (BTC)' }] },
    { market: 'Ethereum', entries: [] },
    // Reports saved before entries keep their facts and quotes.
    { market: 'Solana', items: [{ product: 'Crypto Quant', facts: [{ text: 'Trend Bullish', tone: 'positive' }], quotes: ['SOL is bullish.'] }] },
  ] };
  const node = { children: [{ tagName: 'code', properties: { className: ['language-analyst-research'] },
    children: [{ type: 'text', value: JSON.stringify(research) }] }] };
  render(<Pre node={node}><code>ignored</code></Pre>);
  const table = within(screen.getByRole('region', { name: 'Morning research' })).getByRole('table');
  const rows = within(table).getAllByRole('row').map(row => [...row.cells].map(cell => cell.textContent));
  expect(rows).toEqual([
    ['Market', 'Product', 'Context', 'PT', ''],
    ['Bitcoin', 'The Macro Show', 'Bitcoin remained a minimum-sized long with bearish trade but bullish trend', '07:55', 'Source'],
    ['The Macro Show', 'Long Bitcoin (BTC)', '07:55', ''],
    ['Ethereum', 'Not mentioned'],
    ['Solana', 'Crypto Quant', 'Trend Bullish', '—', 'Source'],
  ]);
  expect(within(table).getByText('bearish')).toHaveClass('analyst-process--negative');
  expect(within(table).getByText('Long')).toHaveClass('analyst-process--positive');
  const [source] = within(table).getAllByRole('button', { name: 'Source' });
  expect(source).toHaveAttribute('aria-expanded', 'false');
  fireEvent.click(source);
  expect(source).toHaveAttribute('aria-expanded', 'true');
  expect(table.querySelector('blockquote')).toHaveTextContent(/sold all Ethereum/);
  expect(within(table.querySelector('blockquote')).getByText('Ethereum')).toHaveClass('analyst-process--ticker');
});

test('research excerpts color securities, quads, directions and signed moves as the other reports do', () => {
  ReactMarkdown.renderSpy.mockClear();
  render(<AnalystPredictionReport markdown="## Indices" />);
  const { pre: Pre } = ReactMarkdown.renderSpy.mock.calls[0][0].components;
  const research = { markets: [{ market: 'Nasdaq-100', entries: [
    { product: 'Early Look', time: '04:25',
      context: 'Since Bitcoin still has a positive correlation to USD, we stayed with both that and QQQ despite their -1.3% and -4.5% corrections last week.' },
    { product: 'Early Look', time: '04:25', context: 'Late-stage #Quad2 than #Quad4; WTI was up 10% while the Russell is down almost 11.3% and SP500 = 7611-7852' }] }] };
  const node = { children: [{ tagName: 'code', properties: { className: ['language-analyst-research'] },
    children: [{ type: 'text', value: JSON.stringify(research) }] }] };
  render(<Pre node={node}><code>ignored</code></Pre>);
  const table = within(screen.getByRole('region', { name: 'Morning research' })).getByRole('table');
  ['Bitcoin', 'USD', 'QQQ', 'WTI', 'Russell', 'SP500'].forEach(name => expect(within(table).getByText(name)).toHaveClass('analyst-process--ticker'));
  ['-1.3%', '-4.5%', '11.3%'].forEach(move => expect(within(table).getByText(move)).toHaveClass('analyst-process--negative'));
  expect(within(table).getByText('10%')).toHaveClass('analyst-process--positive');
  expect(within(table).getByText('Quad2')).toHaveClass('analyst-process--quad-2');
  expect(within(table).getByText('Quad4')).toHaveClass('analyst-process--quad-4');
  // A range's dash is not a sign.
  expect(within(table).getByText(/7611-7852/)).not.toHaveClass('analyst-process--negative');
});

test('reported data lists one fact per line, including saved reports that joined facts into one context', () => {
  ReactMarkdown.renderSpy.mockClear();
  render(<AnalystPredictionReport markdown="## Indices" />);
  const { pre: Pre } = ReactMarkdown.renderSpy.mock.calls[0][0].components;
  const research = { markets: [{ market: 'S&P 500', entries: [
    { product: 'Market Structure', time: '03:30',
      context: 'SPX Gamma Exposure: Negative · Systematic Flow Risk: Bearish · PV Band Risk/Reward: Long · Strategic Allocation: Risk On',
      facts: ['SPX Gamma Exposure: Negative', 'Systematic Flow Risk: Bearish', 'PV Band Risk/Reward: Long', 'Strategic Allocation: Risk On'] },
    { product: 'Market Structure', time: '03:30', context: 'Zero gamma: 7,733 · PV band: 7,610–7,852 · Gamma throttle: -5.89' },
    { product: 'Top 3 Things', time: '05:33', context: 'Immediate-term @Hedgeye Risk Ranges: SP500 = 7611-7852' }] }] };
  const node = { children: [{ tagName: 'code', properties: { className: ['language-analyst-research'] },
    children: [{ type: 'text', value: JSON.stringify(research) }] }] };
  render(<Pre node={node}><code>ignored</code></Pre>);
  const lists = within(screen.getByRole('region', { name: 'Morning research' })).getAllByRole('list');
  expect(lists.map(list => within(list).getAllByRole('listitem').map(item => [...item.children].map(span => span.textContent)))).toEqual([
    [['SPX Gamma Exposure', 'Negative'], ['Systematic Flow Risk', 'Bearish'], ['PV Band Risk/Reward', 'Long'], ['Strategic Allocation', 'Risk On']],
    [['Zero gamma', '7,733'], ['PV band', '7,610–7,852'], ['Gamma throttle', '-5.89']],
  ]);
  expect(within(lists[0]).getByText('Negative')).toHaveClass('analyst-process--negative');
  expect(within(lists[0]).getByText('Risk On')).toHaveClass('analyst-process--positive');
  expect(within(lists[0]).getByText('SPX')).toHaveClass('analyst-process--ticker');
  // A sentence with a colon stays a sentence.
  expect(screen.getByText(/Immediate-term @Hedgeye Risk Ranges:/).closest('ul')).toBeNull();
});
