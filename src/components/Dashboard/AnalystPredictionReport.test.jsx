import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import ReactMarkdown from 'react-markdown';
import AnalystPredictionReport, { BoardLinesContext, boardLines } from './AnalystPredictionReport';
import { remarkAnalystProcessColors } from './analystProcessColors';
import { analystWorkspaceApi } from '../../services/analyst/analystClient';
import { findQuote } from './AnalystSourceEmail';

jest.mock('../../services/analyst/analystClient', () => ({ analystWorkspaceApi: { request: jest.fn() } }));

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

test('a Neutral read from a broken Alpha Code line explains itself in the tooltip only', () => {
  ReactMarkdown.renderSpy.mockClear();
  render(<AnalystPredictionReport markdown="## Oil" />);
  const { td: Cell } = ReactMarkdown.renderSpy.mock.calls[0][0].components;
  const value = 'BIAS(Neutral;;;Below the Top 3 Things Trade line 97 since Nov 2 08:22 · The Call Bullish Oct 21 reads Neutral until reclaimed)';
  const { container } = render(<table><tbody><tr><Cell node={{ children: [{ type: 'text', value }] }}>{value}</Cell></tr></tbody></table>);
  const trade = container.querySelector('td');
  expect([...trade.children].map(span => span.textContent)).toEqual(['Neutral']);
  expect(trade).toHaveAttribute('title', 'Neutral · Below the Top 3 Things Trade line 97 since Nov 2 08:22 · The Call Bullish Oct 21 reads Neutral until reclaimed');
});

test('boards with price history stack the 20-session Z-score under the market name', () => {
  ReactMarkdown.renderSpy.mockClear();
  render(<AnalystPredictionReport markdown="## Metals" />);
  const { td: Cell } = ReactMarkdown.renderSpy.mock.calls[0][0].components;
  const cell = value => <Cell node={{ children: [{ type: 'text', value }] }}>{value}</Cell>;
  const { container } = render(<table><tbody><tr>
    {cell('NAME(Gold;;+2.1)')}{cell('MKT(Nasdaq-100;COMPQ range;-1.0)')}{cell('REF(US Dollar;DXY;+0.6)')}{cell('NAME(WTI;;)')}
  </tr></tbody></table>);
  const [gold, nasdaq, dollar, wti] = container.querySelectorAll('td');
  expect([...gold.children].map(span => span.textContent)).toEqual(['Gold', 'Z +2.1']);
  expect(gold.querySelector('.analyst-prediction-z--stretched')).toHaveTextContent('+2.1');
  expect([...nasdaq.children].map(span => span.textContent)).toEqual(['Nasdaq-100', 'COMPQ range', 'Z −1.0']);
  expect(nasdaq.querySelector('.analyst-prediction-z--stretched')).toBeNull();
  expect(dollar).toHaveClass('analyst-prediction-reference-cell');
  expect([...dollar.children].map(span => span.textContent)).toEqual(['US Dollar', 'DXY', 'Z +0.6']);
  expect([...wti.children].map(span => span.textContent)).toEqual(['WTI', 'Z N/A']);
  expect(gold).toHaveAttribute('title', 'Gold · Z-score +2.1 vs. the prior 20 daily closes');
  expect(container).not.toHaveTextContent(/NAME\(|MKT\(|REF\(/);
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

test('Structure cells stack today’s range moves, run counts with each session, and the all-time high', () => {
  ReactMarkdown.renderSpy.mockClear();
  render(<AnalystPredictionReport markdown="## Oil" />);
  const { td: Cell, table: Table } = ReactMarkdown.renderSpy.mock.calls[0][0].components;
  const cell = value => <Cell node={{ children: [{ type: 'text', value }] }}>{value}</Cell>;
  const headers = ['Market', 'Tick', 'Trade', 'Trend', 'Alpha Code', 'Price and Risk Range', 'Structure (10d)', 'As of (PT)'];
  const node = { children: [{ tagName: 'thead', children: [{ tagName: 'tr', children: headers.map(value => ({ tagName: 'th', children: [{ type: 'text', value }] })) }] }] };
  const { container } = render(<Table node={node}><tbody><tr>
    {cell('STRUCT(+-++++++++;+8;--+++-++--;-2;147.27;Jul 11, 2008;-34;0;)')}{cell('STRUCT(+-;+1;+-;-1;7,845;Oct 6, 2026;-1;1;)')}
    {cell('STRUCT(=-;-1;+=;+1;;;;0;%)')}
  </tr></tbody></Table>);
  expect(container.querySelector('.analyst-table-frame')).toHaveClass('is-range-board', 'has-alpha', 'has-structure');
  const [wti, spx, ust2y] = container.querySelectorAll('td');
  expect([...wti.children].map(span => span.textContent)).toEqual(['HLLHATH', 'LH 2', 'HL 8', 'ATH 147.27 : 34%']);
  expect(within(wti).getByText('HL')).toHaveClass('is-on');
  expect(within(wti).getByText('LH', { selector: '.analyst-prediction-structure-move' })).toHaveClass('is-against');
  expect(within(wti).getByText('HL 8')).toHaveClass('analyst-process--positive');
  // The level reads blue; the colon and how far price sits below it read black.
  expect(within(wti).getByText('ATH 147.27')).toHaveClass('analyst-prediction-structure-record');
  expect(within(wti).getByText(': 34%', { exact: false })).toHaveClass('analyst-prediction-structure-distance');
  // Clicking the ATH line shows the record's date beneath it; leaving it closes the note.
  fireEvent.click(within(wti).getByRole('button', { name: 'ATH 147.27 : 34%' }));
  expect(within(wti).getByRole('tooltip')).toHaveTextContent('ATH on Jul 11, 2008');
  fireEvent.blur(within(wti).getByRole('button', { name: 'ATH 147.27 : 34%' }));
  expect(within(wti).queryByRole('tooltip')).toBeNull();
  expect(wti.querySelectorAll('.analyst-prediction-structure-steps i.is-higher')).toHaveLength(9 + 5);
  expect(within(wti).getByLabelText(/^Highs, oldest to today: lower, lower, higher/)).toBeInTheDocument();
  expect(wti).toHaveAttribute('title', 'Today HL LH ATH · LH 2 · HL 8 · Price 34% below the all-time high of 147.27 (Jul 11, 2008)');
  // A range top above the all-time high reads blue.
  expect(within(spx).getByText('ATH', { selector: '.analyst-prediction-structure-move' })).toHaveClass('is-record');
  expect(within(spx).getByText('Top > ATH 7,845')).toHaveClass('analyst-prediction-structure-record');
  expect(spx.getAttribute('title')).toMatch(/Range top above the all-time high of 7,845 \(Oct 6, 2026\)$/);
  expect([...ust2y.children].map(span => span.textContent)).toEqual(['LL=HATH', 'HH 1', 'LL 1', 'ATH N/A']);
  expect(container).not.toHaveTextContent(/STRUCT\(/);
});

test('analyst-research blocks list one row per mention under its product, named once, and each quiet market', () => {
  ReactMarkdown.renderSpy.mockClear();
  render(<AnalystPredictionReport markdown="## Crypto" />);
  const { pre: Pre } = ReactMarkdown.renderSpy.mock.calls[0][0].components;
  const research = { markets: [
    { market: 'Bitcoin', entries: [
      { product: 'The Macro Show', time: '07:55', date: 'Oct 22', context: 'Bitcoin remained a minimum-sized long with bearish trade but bullish trend',
        source: 'Cooper noted that Keith sold all Ethereum on Tuesday. Bitcoin remained a minimum-sized long with bearish trade but bullish trend' },
      { product: 'Early Look', time: '06:10', context: 'Bitcoin led the risk-on move' },
      // An entry saved before dates keeps its Pacific time.
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
    ['Market', 'Product', 'Context', ''],
    ['Bitcoin', 'The Macro Show', 'Bitcoin remained a minimum-sized long with bearish trade but bullish trend', 'Source'],
    // A product's later point joins its block, ahead of the next product.
    ['', 'Long Bitcoin (BTC)', ''],
    ['Early Look', 'Bitcoin led the risk-on move', ''],
    ['Ethereum', 'Not mentioned'],
    ['Solana', 'Crypto Quant', 'Trend Bullish', 'Source'],
  ]);
  // The publication time reads on the product; a block saved without its section and date has no day picker.
  expect(within(table).getByText('The Macro Show')).toHaveAttribute('title', 'Oct 22 07:55 PT');
  expect(within(table).getAllByRole('row')[2]).toHaveClass('analyst-research__continued');
  expect(within(table).getAllByRole('row')[3]).not.toHaveClass('analyst-research__continued');
  expect(within(table).queryByRole('button', { name: /choose another day/ })).not.toBeInTheDocument();
  expect(within(table).getByText('bearish')).toHaveClass('analyst-process--negative');
  expect(within(table).getByText('Long')).toHaveClass('analyst-process--positive');
  const [source] = within(table).getAllByRole('button', { name: 'Source' });
  expect(source).toHaveAttribute('aria-expanded', 'false');
  fireEvent.click(source);
  expect(source).toHaveAttribute('aria-expanded', 'true');
  const panel = screen.getByRole('complementary', { name: 'Source: The Macro Show' });
  expect(panel).toHaveTextContent('Bitcoin · Oct 22 07:55 PT');
  expect(panel.querySelector('blockquote')).toHaveTextContent(/sold all Ethereum/);
  expect(within(panel.querySelector('blockquote')).getByText('Ethereum')).toHaveClass('analyst-process--ticker');
  expect(table.querySelector('blockquote')).toBeNull();
});

test('the research title is its market day; the four before it open above and read what was said that day', async () => {
  ReactMarkdown.renderSpy.mockClear();
  render(<AnalystPredictionReport markdown="## Crypto" />);
  const { pre: Pre } = ReactMarkdown.renderSpy.mock.calls[0][0].components;
  const block = (context) => ({ markets: [{ market: 'Bitcoin', entries: [{ product: 'Early Look', time: '04:28', context }] }] });
  const research = { section: 'crypto', marketDate: '2026-10-23', ...block('Bitcoin held its TREND support') };
  analystWorkspaceApi.request.mockResolvedValueOnce({ ok: true, sections: { crypto: block('Bitcoin broke its TRADE line') } })
    .mockRejectedValueOnce(new Error('down'));
  const node = { children: [{ tagName: 'code', properties: { className: ['language-analyst-research'] },
    children: [{ type: 'text', value: JSON.stringify(research) }] }] };
  render(<Pre node={node}><code>ignored</code></Pre>);
  const table = within(screen.getByRole('region', { name: 'Morning research' })).getByRole('table');
  const title = within(table).getByRole('button', { name: 'Research for Oct 23; choose another day' });
  fireEvent.click(title);
  // Oct 23 is a Friday: the four market days before it, skipping the weekend.
  expect(within(table).getAllByRole('option').map(option => option.textContent)).toEqual(['Oct 22', 'Oct 21', 'Oct 20', 'Oct 19']);
  fireEvent.click(within(table).getByRole('button', { name: 'Oct 21' }));
  expect(analystWorkspaceApi.request).toHaveBeenCalledWith('/prediction-research?date=2026-10-21');
  expect(within(table).queryByRole('listbox')).not.toBeInTheDocument();
  await waitFor(() => expect(table).toHaveTextContent('Bitcoin broke its TRADE line'));
  expect(within(table).getByRole('button', { name: 'Research for Oct 21; choose another day' })).toBeInTheDocument();
  // The report's own day is back in the list, and a failed read says so.
  fireEvent.click(within(table).getByRole('button', { name: /Oct 21; choose another day/ }));
  expect(within(table).getAllByRole('option').map(option => option.textContent)).toEqual(['Oct 23', 'Oct 22', 'Oct 20', 'Oct 19']);
  fireEvent.click(within(table).getByRole('button', { name: 'Oct 20' }));
  await waitFor(() => expect(table).toHaveTextContent('Research for Oct 20 is unavailable.'));
  fireEvent.click(within(table).getByRole('button', { name: /Oct 20; choose another day/ }));
  fireEvent.click(within(table).getByRole('button', { name: 'Oct 23' }));
  expect(table).toHaveTextContent('Bitcoin held its TREND support');
  expect(analystWorkspaceApi.request).toHaveBeenCalledTimes(2);
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
  const sentence = screen.getByText(/Immediate-term @Hedgeye Risk Ranges:/);
  expect(sentence.closest('ul')).toBeNull();
});

test('CPI nowcast reads Low · Base · High, Low red and High green on the values only', () => {
  const markdown = ['## CPI', '', '| Market | Kalshi | Nowcast low | Base | High | Published |', '| --- | --- | --- | --- | --- | --- |',
    '| CPI YoY · Oct 2026 | N/A | 3.77% | 3.88% | 3.99% | Oct 16 13:11 PDT |', ''].join('\n');
  ReactMarkdown.renderSpy.mockClear();
  render(<AnalystPredictionReport markdown={markdown} />);
  // Saved reports titled the first column "Nowcast low".
  expect(ReactMarkdown.renderSpy.mock.calls[0][0].children).toContain('| Market | Kalshi | Low | Base | High | Published |');
  const { td: Cell, table: Table } = ReactMarkdown.renderSpy.mock.calls[0][0].components;
  const cell = value => <Cell node={{ children: [{ type: 'text', value }] }}>{value}</Cell>;
  const headers = ['Market', 'Kalshi', 'Low', 'Base', 'High', 'Published'];
  const node = { children: [{ tagName: 'thead', children: [{ tagName: 'tr', children: headers.map(value => ({ tagName: 'th', children: [{ type: 'text', value }] })) }] }] };
  const { container } = render(<Table node={node}><tbody><tr>{cell('CPI')}{cell('N/A')}{cell('3.77%')}</tr></tbody></Table>);
  expect(container.querySelector('.analyst-table-frame')).toHaveClass('is-nowcast');
  // N/A keeps its plain color in a colored column.
  expect(container.querySelectorAll('td')[1]).toHaveClass('is-na');
});

test('volume draws under Tick, Trade and Trend as one shaded cell per window, and Structure adds DV or AV', () => {
  ReactMarkdown.renderSpy.mockClear();
  render(<AnalystPredictionReport markdown="## Crypto" />);
  const { td: Cell, tr: Row, table: Table } = ReactMarkdown.renderSpy.mock.calls[0][0].components;
  const text = value => ({ type: 'text', value });
  const headers = ['Market', 'Tick', 'Trade', 'Trend', 'Volume', 'Price and Risk Range', 'Structure (10d)', 'Status'];
  const values = ['Bitcoin', 'BIAS(Neutral;;)', 'BIAS(Bullish;;)', 'BIAS(Bullish;;)', 'VOL(+54;+35;+35;+8;2026-10-21;IBIT)',
    'RR(80796;83995;84271;0;)', 'STRUCT(+;+1;+;+1;126,198;Oct 2025;-33;0;;AV;)', 'ASOF(Oct 21 16:29;,;,;,)'];
  const headNode = { tagName: 'tr', children: headers.map(value => ({ tagName: 'th', children: [text(value)] })) };
  const rowNode = { tagName: 'tr', children: values.map(value => ({ tagName: 'td', children: [text(value)] })) };
  const table = { children: [{ tagName: 'thead', children: [headNode] }, { tagName: 'tbody', children: [rowNode] }] };
  const { container } = render(<Table node={table}>
    <thead><Row node={headNode}>{headers.map(value => <th key={value}>{value}</th>)}</Row></thead>
    <tbody><Row node={rowNode}>{rowNode.children.map((node, index) => <Cell key={index} node={node}>{values[index]}</Cell>)}</Row></tbody>
  </Table>);
  // The volume column has no header or column of its own.
  expect([...container.querySelectorAll('th')].map(th => th.textContent)).toEqual(headers.filter(value => value !== 'Volume'));
  expect(container.querySelectorAll('col')).toHaveLength(7);
  const [top, under] = container.querySelectorAll('tbody tr');
  // Market, the range, Structure and Status run the full height; Tick, Trade and Trend take the top half.
  expect([...top.children].map(cell => cell.rowSpan)).toEqual([2, 1, 1, 1, 2, 2, 2]);
  const volume = under.querySelector('td');
  expect(volume.colSpan).toBe(3);
  expect([...volume.querySelectorAll('.analyst-prediction-volume__window')].map(cell => cell.textContent))
    .toEqual(['1D+54%', '15D+35%', '30D+35%', '90D+8%']);
  // A saved board without the Trend side still reads each number by its sign.
  expect(volume.querySelector('.analyst-prediction-volume__window')).toHaveClass('analyst-prediction-volume__window', 'is-on', { exact: true });
  expect(volume).toHaveAttribute('title', 'IBIT volume on 2026-10-21 vs the prior session and its 15-, 30- and 90-day averages');
  // A saved board without the day's direction shows AV with the plain outline when it isn't against the Trend.
  expect(within(top).getByText('AV', { selector: '.analyst-prediction-structure-move' })).toHaveClass('analyst-prediction-structure-move', { exact: true });
  expect(container).not.toHaveTextContent(/VOL\(|STRUCT\(/);
});

test('the Z column joins Tick, Trade and Trend on top, each over one volume window', () => {
  ReactMarkdown.renderSpy.mockClear();
  render(<AnalystPredictionReport markdown="## Metals" />);
  const { td: Cell, tr: Row, table: Table } = ReactMarkdown.renderSpy.mock.calls[0][0].components;
  const text = value => ({ type: 'text', value });
  const headers = ['Market', 'Z', 'Tick', 'Trade', 'Trend', 'Volume', 'Price and Risk Range', 'Structure', 'Status'];
  const values = ['WTI', 'Z(-2.3)', 'BIAS(Neutral;;)', 'BIAS(N/A;;)', 'BIAS(Bullish;;)', 'VOL(-36;-31;-30;-33;2026-10-27;USO)',
    'RR(97.31;104.98;101.73;2;)', 'STRUCT(+;+1;+;+1;147.27;Mar 2022;-31;0;;AV;)', 'ASOF(Oct 28 06:32;,;,;,)'];
  const headNode = { tagName: 'tr', children: headers.map(value => ({ tagName: 'th', children: [text(value)] })) };
  const rowNode = { tagName: 'tr', children: values.map(value => ({ tagName: 'td', children: [text(value)] })) };
  const table = { children: [{ tagName: 'thead', children: [headNode] }, { tagName: 'tbody', children: [rowNode] }] };
  const { container } = render(<Table node={table}>
    <thead><Row node={headNode}>{headers.map(value => <th key={value}>{value}</th>)}</Row></thead>
    <tbody><Row node={rowNode}>{rowNode.children.map((node, index) => <Cell key={index} node={node}>{values[index]}</Cell>)}</Row></tbody>
  </Table>);
  expect(container.querySelector('.analyst-table-frame')).toHaveClass('has-z');
  expect(container.querySelectorAll('col')).toHaveLength(8);
  const [top, under] = container.querySelectorAll('tbody tr');
  // Market and the cells after Trend run the full height; Z, Tick, Trade and Trend take the top half.
  expect([...top.children].map(cell => [cell.className, cell.rowSpan])).toEqual([['', 2], ['analyst-prediction-z-cell', 1],
    ['analyst-prediction-bias-cell', 1], ['analyst-prediction-bias-cell', 1], ['analyst-prediction-bias-cell', 1],
    ['analyst-prediction-range-cell', 2], ['analyst-prediction-structure-cell', 2], ['analyst-prediction-as-of-cell', 2]]);
  const z = top.children[1];
  expect(z).toHaveTextContent(/^−2\.3$/);
  expect(z).toHaveAttribute('title', 'Z-score -2.3 vs. the prior 20 daily closes');
  expect(z.querySelector('.analyst-prediction-z--stretched')).toHaveTextContent('−2.3');
  // One volume window to a cell, under Z, Tick, Trade and Trend.
  expect([...under.children].map(cell => [cell.className, cell.colSpan, cell.textContent])).toEqual([
    ['analyst-prediction-volume-cell is-window', 1, '1D−36%'], ['analyst-prediction-volume-cell is-window', 1, '15D−31%'],
    ['analyst-prediction-volume-cell is-window', 1, '30D−30%'], ['analyst-prediction-volume-cell is-window', 1, '90D−33%']]);
  expect(under.children[0]).toHaveAttribute('title', 'USO volume on 2026-10-27 vs the prior session and its 15-, 30- and 90-day averages');
  expect(container).not.toHaveTextContent(/Z\(|VOL\(/);
});

test.each([
  ['-', 'DV', 'supports', '↓DV', 'is-on', 'Down day on volume below its 30-day average (against the Trend: setup)'],
  ['+', 'AV', 'warns', '↑AV', 'is-against', 'Up day on volume above its 30-day average (against the Trend: warning)'],
  ['+', 'DV', '', '↑DV', null, 'Up day on volume below its 30-day average (not against the Trend)'],
  ['+', 'AV', '', '↑AV', null, 'Up day on volume above its 30-day average (not against the Trend)'],
  ['+', 'AV', 'confirms', '↑AV', 'is-on', 'Up day on volume above its 30-day average (with the Trend: confirmation)'],
])('a %s day on %s against the Trend reads as a setup (green), warning (red) or neither (outline)', (direction, volume, tone, text, tint, sentence) => {
  ReactMarkdown.renderSpy.mockClear();
  render(<AnalystPredictionReport markdown="## Crypto" />);
  const { td: Cell } = ReactMarkdown.renderSpy.mock.calls[0][0].components;
  const value = `STRUCT(+;+1;+;+1;126,198;Oct 2025;-33;0;;${volume};${tone};${direction})`;
  const { container } = render(<table><tbody><tr><Cell node={{ tagName: 'td', children: [{ type: 'text', value }] }}>{value}</Cell></tr></tbody></table>);
  const badge = within(container).getByText(text, { selector: '.analyst-prediction-structure-move' });
  expect(badge.className).toBe(`analyst-prediction-structure-move${tint ? ` ${tint}` : ''}`);
  expect(container.querySelector('td').title).toContain(sentence);
});

test('an unavailable volume reads N/A in each window, and saved boards title As of (PT) as Status', () => {
  ReactMarkdown.renderSpy.mockClear();
  render(<AnalystPredictionReport markdown={'| Market | Tick | Trade | Trend | Price and Risk Range | As of (PT) |\n| --- | --- | --- | --- | --- | --- |'} />);
  expect(ReactMarkdown.renderSpy.mock.calls[0][0].children).toContain('| Price and Risk Range | Status |');
  ReactMarkdown.renderSpy.mockClear();
  render(<AnalystPredictionReport markdown={'| Market | Tick | Trade | Trend | Price and Risk Range | Structure (10d) | Status |\n| --- | --- | --- | --- | --- | --- | --- |'} />);
  expect(ReactMarkdown.renderSpy.mock.calls[0][0].children).toContain('| Price and Risk Range | Structure | Status |');
  const { td: Cell } = ReactMarkdown.renderSpy.mock.calls[0][0].components;
  const { container } = render(<table><tbody><tr><Cell node={{ children: [{ type: 'text', value: 'VOL(;;;-12;;)' }] }} /></tr></tbody></table>);
  expect([...container.querySelectorAll('.analyst-prediction-volume__value')].map(cell => cell.textContent)).toEqual(['N/A', 'N/A', 'N/A', '−12%']);
  // N/A stays plain; a number reads by its own sign.
  expect([...container.querySelectorAll('.analyst-prediction-volume__window')].map(window => window.className.replace('analyst-prediction-volume__window', '').trim()))
    .toEqual(['', '', '', 'is-against']);
});

test.each([
  ['-', 'Day against the Trend'],
  ['+', 'Day with the Trend'],
  ['', 'averages'],
])('volume windows read green when up and red when down on a day %s the Trend', (side, sentence) => {
  ReactMarkdown.renderSpy.mockClear();
  render(<AnalystPredictionReport markdown="## Metals" />);
  const { td: Cell } = ReactMarkdown.renderSpy.mock.calls[0][0].components;
  const value = `VOL(-12;+8;-30;0;2026-10-27;GLD;${side})`;
  const { container } = render(<table><tbody><tr><Cell node={{ children: [{ type: 'text', value }] }} /></tr></tbody></table>);
  // The Trend never changes a number's color: positive green, negative red, zero plain.
  expect([...container.querySelectorAll('.analyst-prediction-volume__window')].map(window => window.className.replace('analyst-prediction-volume__window', '').trim()))
    .toEqual(['is-against', 'is-on', 'is-against', '']);
  expect(container.querySelector('td').title).toContain(sentence);
});

test('a research Source opens the product\'s own email at the quoted line, and the line alone without one', async () => {
  ReactMarkdown.renderSpy.mockClear();
  analystWorkspaceApi.request.mockReset();
  render(<AnalystPredictionReport markdown="## Crypto" />);
  const { pre: Pre } = ReactMarkdown.renderSpy.mock.calls[0][0].components;
  const quote = 'Trend change: BITCOIN changed from Bullish to Bearish';
  const research = { markets: [{ market: 'Bitcoin', entries: [
    { product: 'Risk Ranges', context: 'Trend: Bullish → Bearish', facts: ['Trend: Bullish → Bearish'], source: quote, messageId: '1a18c949d0c80bdd' },
    { product: 'Crypto Quant', context: 'BTC is bearish', source: 'BTC is bearish', messageId: '1a18cad975d8a888' },
    // A report saved before entries named their email.
    { product: 'The Macro Show', context: 'Long Bitcoin', source: 'Long Bitcoin (BTC)' },
  ] }] };
  const node = { children: [{ tagName: 'code', properties: { className: ['language-analyst-research'] },
    children: [{ type: 'text', value: JSON.stringify(research) }] }] };
  analystWorkspaceApi.request.mockImplementation(path => (path === '/source-email/1a18c949d0c80bdd'
    ? Promise.resolve({ messageId: '1a18c949d0c80bdd', html: '<html><body><p>Our Levels</p></body></html>', found: false })
    : Promise.reject(Object.assign(new Error('Source email not stored'), { code: 'HTTP_404' }))));
  // The Analyst window's own Escape, which a Source panel must not reach.
  const closeAnalyst = jest.fn();
  const windowEscape = event => { if (event.key === 'Escape') closeAnalyst(); };
  window.addEventListener('keydown', windowEscape);
  render(<div className="analyst-panel"><Pre node={node}><code>ignored</code></Pre></div>);
  const region = screen.getByRole('region', { name: 'Morning research' });
  const table = within(region).getByRole('table');
  const tableMarkup = table.outerHTML;
  const [ranges, quant, macro] = within(table).getAllByRole('button', { name: 'Source' });
  fireEvent.click(ranges);
  expect(analystWorkspaceApi.request).toHaveBeenCalledWith('/source-email/1a18c949d0c80bdd');
  // The email reads in one panel beside the window, outside the table, which keeps its rows as they were.
  const panel = screen.getByRole('complementary', { name: 'Source: Risk Ranges' });
  expect(panel.parentElement).toHaveClass('analyst-panel');
  expect(region).not.toContainElement(panel);
  expect(await within(panel).findByTitle('Original email: Risk Ranges')).toHaveAttribute('srcdoc', expect.stringContaining('Our Levels'));
  expect(table.outerHTML).toBe(tableMarkup.replace('aria-expanded="false"', 'aria-expanded="true"'));
  // Another row's Source swaps the panel; an email that was not stored falls back to the quoted line.
  fireEvent.click(quant);
  expect(ranges).toHaveAttribute('aria-expanded', 'false');
  expect(quant).toHaveAttribute('aria-expanded', 'true');
  expect(screen.getAllByRole('complementary')).toHaveLength(1);
  expect(screen.getByRole('complementary', { name: 'Source: Crypto Quant' })).toBe(panel);
  await waitFor(() => expect(panel.querySelector('blockquote.analyst-research__quote')).toHaveTextContent('BTC is bearish'));
  expect(within(panel).queryByTitle('Original email: Risk Ranges')).not.toBeInTheDocument();
  fireEvent.click(macro);
  expect(analystWorkspaceApi.request).toHaveBeenCalledTimes(2);
  expect(panel.querySelector('blockquote.analyst-research__quote')).toHaveTextContent('Long Bitcoin (BTC)');
  expect(table.querySelector('blockquote')).toBeNull();
  // Escape closes the panel and not the Analyst window; the next Escape is the window's again.
  fireEvent.keyDown(document.body, { key: 'Escape' });
  expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
  expect(macro).toHaveAttribute('aria-expanded', 'false');
  expect(closeAnalyst).not.toHaveBeenCalled();
  fireEvent.keyDown(document.body, { key: 'Escape' });
  expect(closeAnalyst).toHaveBeenCalledTimes(1);
  window.removeEventListener('keydown', windowEscape);
  // Its close button closes it too, and so does its own row's Source.
  fireEvent.click(macro);
  fireEvent.click(within(screen.getByRole('complementary', { name: 'Source: The Macro Show' })).getByRole('button', { name: 'Close source' }));
  expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
  fireEvent.click(macro);
  fireEvent.click(macro);
  expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
});

test('one research Source panel shows at a time across the report\'s tables', () => {
  ReactMarkdown.renderSpy.mockClear();
  render(<AnalystPredictionReport markdown="## Crypto" />);
  const { pre: Pre } = ReactMarkdown.renderSpy.mock.calls[0][0].components;
  const block = (market, product) => ({ children: [{ tagName: 'code', properties: { className: ['language-analyst-research'] },
    children: [{ type: 'text', value: JSON.stringify({ markets: [{ market, entries: [{ product, context: `${market} is bullish`, source: `${market} is bullish` }] }] }) }] }] });
  render(<><Pre node={block('Bitcoin', 'Crypto Quant')}><code /></Pre><Pre node={block('Gold', 'Early Look')}><code /></Pre></>);
  const [bitcoin, gold] = screen.getAllByRole('button', { name: 'Source' });
  fireEvent.click(bitcoin);
  fireEvent.click(gold);
  expect(screen.getAllByRole('complementary')).toHaveLength(1);
  expect(screen.getByRole('complementary', { name: 'Source: Early Look' })).toHaveTextContent('Gold is bullish');
  expect(bitcoin).toHaveAttribute('aria-expanded', 'false');
});

test('findQuote finds a quoted line across the email\'s markup, without the label the dashboard added', () => {
  const doc = new DOMParser().parseFromString(`<html><head><style>td { color: red }</style></head><body>
    <p>BITCOIN Risk Range 104,000-112,000</p>
    <table><tr><td>BITCOIN</td> <td>changed from <b>Bullish</b> to Bearish</td></tr></table></body></html>`, 'text/html');
  expect(findQuote(doc, 'Trend change: BITCOIN changed from Bullish to Bearish').toString()).toBe('BITCOIN changed from Bullish to Bearish');
  // Curly quotes and dashes in the email still match a plain quote; a line the email never printed finds nothing.
  const prose = new DOMParser().parseFromString('<p>Keith’s view – Gold is down another 1.1%.</p>', 'text/html');
  expect(findQuote(prose, "Keith's view - Gold is down another 1.1%").toString()).toBe('Keith’s view – Gold is down another 1.1%.');
  expect(findQuote(prose, 'Silver broke its TREND line today')).toBeNull();
});

test('a market whose only mention reads under another market is Not mentioned, including in saved reports', () => {
  ReactMarkdown.renderSpy.mockClear();
  render(<AnalystPredictionReport markdown="## Metals" />);
  const { pre: Pre } = ReactMarkdown.renderSpy.mock.calls[0][0].components;
  const research = { markets: [{ market: 'Palladium', entries: [], mentionedWith: ['Gold'] }, { market: 'Copper', entries: [] }] };
  const node = { children: [{ tagName: 'code', properties: { className: ['language-analyst-research'] },
    children: [{ type: 'text', value: JSON.stringify(research) }] }] };
  render(<Pre node={node}><code>ignored</code></Pre>);
  const rows = within(screen.getByRole('region', { name: 'Morning research' })).getAllByRole('row').map(row => [...row.cells].map(cell => cell.textContent));
  expect(rows.slice(1)).toEqual([['Palladium', 'Not mentioned'], ['Copper', 'Not mentioned']]);
});

describe('Kalshi lines open from the board rows', () => {
  const ladder = [[84, 0.97], [86, 0.86], [88, 0.6], [90, 0.3], [92, 0.1], [94, 0.03]];
  const wti = { id: 'wti', market: 'WTI', event: 'KXWTI-26NOV1614', held: [], open: false, shade: 'SHORT',
    summary: { price: 88.5, centre: 88.6, unit: null, closeTime: '2026-11-16T19:30:00Z' },
    lines: { side: null, lines: ladder.map(([strike, odds]) => ({ ticker: `T${strike}`, strike, subtitle: `Above $${strike}`, kalshiOdds: odds })) } };
  const brent = { ...wti, id: 'brent', market: 'Brent', shade: null };
  const fence = '```';
  const block = `${fence}analyst-lines\n${JSON.stringify({ markets: [wti, brent] })}\n${fence}`;

  it('claims only the markets a setup board or the CPI nowcast lists, not the research table', () => {
    const markdown = ['## Oil', '| Market | Z | Tick | Price and Risk Range |', '| --- | --- | --- | --- |', '| WTI | Z(-1) | BIAS(Neutral;;) | RR(82;93;88;2;) |',
      '', '| Market | Product | Context |', '| --- | --- | --- |', '| Brent | The Call | Oil weak |', '', block,
      '## Rates', '| Market | Consensus | Low | Base | High | Published |', '| --- | --- | --- | --- | --- | --- |', '| CPI YoY · Nov 2026 | N/A | 3.6% | 3.7% | 3.8% | Nov 10 |'].join('\n');
    expect([...boardLines(markdown).markets.keys()]).toEqual(['WTI']);
    const cpi = { ...wti, id: 'cpi', market: 'CPI YoY' };
    expect([...boardLines(`${markdown}\n\n${fence}analyst-lines\n${JSON.stringify({ markets: [cpi] })}\n${fence}`).markets.keys()]).toEqual(['WTI', 'CPI YoY']);
  });

  it('stacks book over curve in the market cell and opens each under the row; the lines block keeps only unlisted markets', () => {
    ReactMarkdown.renderSpy.mockClear();
    render(<AnalystPredictionReport markdown="## Oil" />);
    const { td: Cell, tr: Row, table: Table, pre: Pre } = ReactMarkdown.renderSpy.mock.calls[0][0].components;
    const text = value => ({ type: 'text', value });
    const headers = ['Market', 'Z', 'Tick', 'Price and Risk Range'];
    const values = ['WTI', 'Z(-1)', 'BIAS(Neutral;;)', 'RR(82;93;88;2;)'];
    const headNode = { tagName: 'tr', children: headers.map(value => ({ tagName: 'th', children: [text(value)] })) };
    const rowNode = { tagName: 'tr', children: values.map(value => ({ tagName: 'td', children: [text(value)] })) };
    const table = { children: [{ tagName: 'thead', children: [headNode] }, { tagName: 'tbody', children: [rowNode] }] };
    const board = { markets: new Map([['WTI', wti]]) };
    const { container } = render(<BoardLinesContext.Provider value={board}><Table node={table}>
      <thead><Row node={headNode}>{headers.map(value => <th key={value}>{value}</th>)}</Row></thead>
      <tbody><Row node={rowNode}>{rowNode.children.map((node, index) => <Cell key={index} node={node}>{values[index]}</Cell>)}</Row></tbody>
    </Table></BoardLinesContext.Provider>);
    expect(container.querySelector('.analyst-table-frame')).toHaveClass('has-lines');
    const cell = container.querySelector('td.analyst-board-market');
    expect(cell).toHaveClass('is-shade-short');
    expect(cell).toHaveTextContent(/^WTI$/);
    expect([...cell.querySelectorAll('button')].map(button => button.getAttribute('aria-label'))).toEqual(['WTI order book', 'WTI settlement curve']);
    expect(container.querySelectorAll('tbody tr')).toHaveLength(1);
    fireEvent.click(within(cell).getByRole('button', { name: 'WTI settlement curve' }));
    const detail = container.querySelector('tr.analyst-board-detail--curve > td');
    expect(detail.colSpan).toBe(4);
    expect(within(detail).getByRole('figure', { name: 'WTI settlement curve' })).toBeInTheDocument();
    fireEvent.click(within(cell).getByRole('button', { name: 'WTI order book' }));
    expect(screen.getByRole('table', { name: 'WTI Kalshi lines' })).toBeInTheDocument();
    // Book first, then the curve.
    expect([...container.querySelector('.analyst-table-frame > table > tbody').children].map(row => row.className))
      .toEqual(['', 'analyst-board-detail', 'analyst-board-detail analyst-board-detail--curve']);

    const code = { tagName: 'code', properties: { className: ['language-analyst-lines'] }, children: [text(JSON.stringify({ markets: [wti, brent] }))] };
    const { container: lines } = render(<BoardLinesContext.Provider value={board}><Pre node={{ children: [code] }} /></BoardLinesContext.Provider>);
    expect([...lines.querySelectorAll('.analyst-lines__name')].map(name => name.textContent)).toEqual(['Brent']);
    const { container: none } = render(<BoardLinesContext.Provider value={{ markets: new Map([['WTI', wti], ['Brent', brent]]) }}>
      <Pre node={{ children: [code] }} /></BoardLinesContext.Provider>);
    expect(none).toBeEmptyDOMElement();
  });
});
