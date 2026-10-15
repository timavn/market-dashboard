import { analystFieldTone, analystSemanticRanges, remarkAnalystProcessColors } from './analystProcessColors';

const text = value => ({ type: 'text', value });
const paragraph = (...children) => ({ type: 'paragraph', children });
const fact = (label, value) => paragraph({ type: 'strong', children: [text(`${label}:`)] }, text(` ${value}`));
const content = node => node.value ?? (node.children || []).map(content).join('');
const colored = node => node.type === 'analystProcessText'
  ? [{ text: content(node), tone: node.data.hProperties.className[0] }]
  : (node.children || []).flatMap(colored);
const apply = (children, source = '# Portfolio Review', options) => {
  const tree = { type: 'root', children };
  remarkAnalystProcessColors(options)(tree, { value: source });
  return tree;
};

test('lifecycle color follows Trade EXIT and Trend BENCH without treating an aligned short as a failure', () => {
  expect(analystFieldTone('Process action', 'EXIT — target zero')).toBe('negative');
  expect(analystFieldTone('Conflict', 'BEARISH Trade opposes held long')).toBe('negative');
  expect(analystFieldTone('Process action', 'BENCH — cap at MIN')).toBe('caution');
  expect(analystFieldTone('Trade', 'broken')).toBe('negative');
  expect(analystFieldTone('Trend', 'broken')).toBe('caution');
  expect(analystFieldTone('Conflict', 'BULLISH Trend opposes held short')).toBe('caution');
  expect(analystFieldTone('Process action', 'ALIGNED — no lifecycle exception')).toBe('positive');
  expect(analystFieldTone('Side', 'SHORT')).toBeNull();
  expect(analystFieldTone('Side', 'NO')).toBeNull();
});

test.each(['stale', 'offline', 'disconnected', 'cache-only', 'cached-disconnected', 'mock', 'seeded', 'unverified', 'not verified', 'missing'])(
  '%s evidence keeps its unavailable status separate from the reported signal', state => {
    expect(analystFieldTone('Mark status', `verified · ${state}`)).toBe('muted');
    const tree = apply([fact('Trade', `BULLISH · ${state}`)]);
    expect(colored(tree)).toEqual([
      { text: 'BULLISH', tone: 'analyst-process--positive' },
      { text: state, tone: 'analyst-process--muted' },
    ]);
  },
);

test('a missing or blocked input takes precedence over a favorable word', () => {
  expect(analystFieldTone('Process action', 'ACTION BLOCKED — BULLISH Trade unavailable')).toBe('caution');
  expect(analystFieldTone('Status', 'sizing withheld')).toBe('caution');
  expect(analystFieldTone('Status', 'not qualified')).toBe('muted');
  expect(analystFieldTone('Status', 'unqualified')).toBeNull();
  expect(analystFieldTone('Status', 'no qualifying lines')).toBe('caution');
  expect(analystFieldTone('Margin health', 'unhealthy')).toBe('negative');
  expect(analystFieldTone('Trade', 'not bullish')).toBe('muted');
});

test('balance capacity and P&L are interpreted only under their own labels, with zero preserved', () => {
  expect(analystFieldTone('Available funds', '$85,173.30')).toBeNull();
  expect(analystFieldTone('Long market value', '$142,505.09')).toBeNull();
  expect(analystFieldTone('Short market value', '$85,592.32')).toBeNull();
  expect(analystFieldTone('Borrowing balance', 'Unavailable')).toBe('muted');
  expect(analystFieldTone('Borrowing balance', 'Unavailable as a standalone verified field')).toBe('muted');
  expect(analystFieldTone('Add-long room', '$0.00')).toBe('caution');
  expect(analystFieldTone('Code-computed trim requirement to clear the no-borrow condition', '$4,768.63')).toBe('negative');
  expect(analystFieldTone('Trim requirement', '$0.00')).toBeNull();
  expect(analystFieldTone('Daily P&L', '$-18.59')).toBe('negative');
  expect(analystFieldTone('Unrealized P&L', '+$18.59')).toBe('positive');
  expect(analystFieldTone('Daily P&L', '$0.00')).toBeNull();
  expect(analystFieldTone('Daily / Unrealized P&L', '$18.59 / $-18.59')).toBeNull();
  expect(analystFieldTone('Position marks', '2 of 60 verified')).toBe('caution');
  expect(analystFieldTone('Position marks', '60 of 60 verified')).toBe('positive');
  expect(analystFieldTone('Position marks', '0 of 0 verified')).toBe('muted');
});

test('mixed Trade and Trend directions retain separate colors and do not create an action', () => {
  const tree = apply([fact('Trade & Trend', 'Trade BULLISH / Trend BEARISH')]);
  expect(colored(tree)).toEqual([
    { text: 'BULLISH', tone: 'analyst-process--positive' },
    { text: 'BEARISH', tone: 'analyst-process--negative' },
  ]);
  expect(content(tree)).toBe('Trade & Trend: Trade BULLISH / Trend BEARISH');
});

test.each(['Balance Review', 'Portfolio Review', 'Predictive Markets Review', 'Prediction Markets', 'Review notes'])(
  '%s uses the shared process colors while preserving amounts, labels, citations and code', title => {
    const sourceLink = { type: 'link', url: 'https://example.com/research?asof=2026-09-07', children: [text('source')] };
    const code = { type: 'code', lang: 'markdown', value: '**Status:** qualified' };
    const quote = { type: 'blockquote', children: [fact('Status', 'qualified')] };
    const rows = [
      paragraph(text('Partial · USD')),
      fact('Net liquidation', '$170,188.01'),
      fact('Margin health', 'healthy'),
      fact('Native order book', 'Unavailable'),
      paragraph({ type: 'strong', children: [text('Process action:')] }, text(' EXIT — target zero '), sourceLink),
      { type: 'list', children: [{ type: 'listItem', children: [paragraph(text('Sizing withheld.'))] }] },
      code, quote,
    ];
    const original = content({ children: rows });
    const tree = apply(rows, `## ${title}`);
    expect(content(tree)).toBe(original);
    expect(colored(tree).map(row => row.tone)).toEqual([
      'analyst-process--caution', 'analyst-process--positive',
      'analyst-process--muted', 'analyst-process--negative', 'analyst-process--caution',
    ]);
    expect(tree.children[1]).toEqual(fact('Net liquidation', '$170,188.01'));
    expect(tree.children[2].children[0]).toEqual({ type: 'strong', children: [text('Margin health:')] });
    expect(tree.children[4].children.at(-1)).toBe(sourceLink);
    expect(tree.children[6]).toBe(code);
    expect(tree.children[7]).toBe(quote);
    expect(colored(quote)).toEqual([]);
  },
);

test('ordinary chat keeps lifecycle states plain and quoted inline code receives no annotation', () => {
  expect(colored(apply([fact('Status', 'qualified')], 'Explain process colors'))).toEqual([]);
  const tree = apply([paragraph(text('Trade: '), { type: 'inlineCode', value: 'BULLISH' })]);
  expect(colored(tree)).toEqual([]);
  expect(content(tree)).toBe('Trade: BULLISH');
});

test.each([
  ['Long', 'positive'], ['Short', 'negative'], ['Wait', 'muted'],
])('captured Last known %s colors only the directional reading in comparison columns', (reading, tone) => {
  const value = `Last known ${reading}`;
  expect(analystSemanticRanges(value, 'Contribution')).toEqual([
    { start: 'Last known '.length, end: value.length, tone },
  ]);
  expect(analystSemanticRanges('Last known long history', 'Contribution')).toEqual([]);
  expect(analystSemanticRanges('Last known wait time', 'Contribution')).toEqual([]);
});

test('all report prose, headings, lists and table cells receive word-level semantics, including saved noncanonical reports', () => {
  const prose = 'A held Long has a Bullish Trend, but a Short position remains Bearish; Neutral is unchanged.';
  const rows = [
    { type: 'heading', depth: 2, children: [text('Long positions in Quad 1')] },
    paragraph(text(prose)),
    { type: 'list', children: [{ type: 'listItem', children: [paragraph(text('Favor long equities during Quad2.'))] }] },
    { type: 'table', children: [
      { type: 'tableRow', children: ['Side', 'Trade', 'Quad regime', 'Fiscal quarter'].map(value => ({ type: 'tableCell', children: [text(value)] })) },
      { type: 'tableRow', children: ['Short', 'NEUTRAL', 'Q3', 'Q4'].map(value => ({ type: 'tableCell', children: [text(value)] })) },
    ] },
  ];
  const before = content({ children: rows });
  const tree = apply(rows, '# Saved market outlook — September 2024');
  expect(content(tree)).toBe(before);
  expect(colored(tree)).toEqual([
    { text: 'Long', tone: 'analyst-process--positive' },
    { text: 'Quad 1', tone: 'analyst-process--quad-1' },
    { text: 'Long', tone: 'analyst-process--positive' },
    { text: 'Bullish', tone: 'analyst-process--positive' },
    { text: 'Short', tone: 'analyst-process--negative' },
    { text: 'Bearish', tone: 'analyst-process--negative' },
    { text: 'Neutral', tone: 'analyst-process--muted' },
    { text: 'long', tone: 'analyst-process--positive' },
    { text: 'Quad2', tone: 'analyst-process--quad-2' },
    { text: 'Short', tone: 'analyst-process--negative' },
    { text: 'NEUTRAL', tone: 'analyst-process--muted' },
    { text: 'Q3', tone: 'analyst-process--quad-3' },
  ]);
});

test('semantic spans preserve emphasis, visible source labels, citation identifiers, destinations and code', () => {
  const url = 'https://research.example/Long/Quad4?signal=Bullish';
  const linked = { type: 'link', url, title: 'Source report', children: [{ type: 'emphasis', children: [text('Bearish Trend')] }] };
  const citation = { type: 'linkReference', identifier: 'report-bullish-quad4', referenceType: 'full', children: [text('Bullish report')] };
  const code = { type: 'inlineCode', value: 'Short Quad 3' };
  const block = { type: 'code', lang: 'text', value: 'Bullish Quad 1' };
  const tree = apply([
    paragraph({ type: 'strong', children: [text('Bullish')] }, text(' versus '), linked, text(' '), citation, text(` ${url} `), code),
    block,
    { type: 'blockquote', children: [paragraph(text('A Neutral signal in Quad 4.'))] },
  ], '# Research note');
  expect(colored(tree)).toEqual([
    { text: 'Bullish', tone: 'analyst-process--positive' },
    { text: 'Bearish', tone: 'analyst-process--negative' },
    { text: 'Bullish', tone: 'analyst-process--positive' },
    { text: 'Neutral', tone: 'analyst-process--muted' },
    { text: 'Quad 4', tone: 'analyst-process--quad-4' },
  ]);
  const paragraphNode = tree.children[0];
  expect(paragraphNode.children[0].type).toBe('strong');
  expect(paragraphNode.children[2]).toMatchObject({ type: 'link', url, title: 'Source report' });
  expect(paragraphNode.children[2].children[0].type).toBe('emphasis');
  expect(paragraphNode.children[4]).toMatchObject({ identifier: citation.identifier, referenceType: 'full' });
  expect(paragraphNode.children.at(-1)).toBe(code);
  expect(tree.children[1]).toBe(block);
});

const semanticWords = (value, context) => analystSemanticRanges(value, context).map(range => ({
  text: value.slice(range.start, range.end), tone: range.tone,
}));

test('Risk On and Risk Off color only their phrases in research tables and prose', () => {
  expect(semanticWords('Risk On → RISK OFF; risk-on → risk-off; Risk‑On → Risk–Off.')).toEqual([
    { text: 'Risk On', tone: 'positive' }, { text: 'RISK OFF', tone: 'negative' },
    { text: 'risk-on', tone: 'positive' }, { text: 'risk-off', tone: 'negative' },
    { text: 'Risk‑On', tone: 'positive' }, { text: 'Risk–Off', tone: 'negative' },
  ]);
  const plain = 'Positive gamma, negative gamma, dollar correlation -0.75 and +0.25; risk only, risk offset.';
  expect(semanticWords(plain)).toEqual([]);
  expect(semanticWords('https://example.org/risk-on `risk-off`')).toEqual([]);
  const table = { type: 'table', children: [
    { type: 'tableRow', children: ['Signal', 'Published reading'].map(value => ({ type: 'tableCell', children: [text(value)] })) },
    { type: 'tableRow', children: ['Strategic Allocation', 'Risk On'].map(value => ({ type: 'tableCell', children: [text(value)] })) },
  ] };
  const rows = [table, paragraph(text('A shift to risk-off. '), text(plain))];
  const before = content({ children: rows });
  const tree = apply(rows, '### Market structure & flows');
  expect(content(tree)).toBe(before);
  expect(colored(tree)).toEqual([
    { text: 'Risk On', tone: 'analyst-process--positive' },
    { text: 'risk-off', tone: 'analyst-process--negative' },
  ]);
});

test('Long and Short require a position meaning, excluding time horizons and everyday uses', () => {
  const ordinary = 'Short summary, long history, short-term Bullish and long–term Bearish; short of evidence, a long list, too long. The long and short of it.';
  expect(semanticWords(ordinary)).toEqual([
    { text: 'Bullish', tone: 'positive' }, { text: 'Bearish', tone: 'negative' },
  ]);
  expect(semanticWords('Held long; stay short; long AAPL; Short market value; Long → Short.')).toEqual([
    { text: 'long', tone: 'positive' }, { text: 'short', tone: 'negative' },
    { text: 'long', tone: 'positive' }, { text: 'Short', tone: 'negative' },
    { text: 'Long', tone: 'positive' }, { text: 'Short', tone: 'negative' },
  ]);
  expect(semanticWords('Long')).toEqual([{ text: 'Long', tone: 'positive' }]);
  expect(semanticWords('Short')).toEqual([{ text: 'Short', tone: 'negative' }]);
  expect(semanticWords('A short summary', 'Position context')).toEqual([]);
  expect(semanticWords('longer, shortest, bullishness, neutralize')).toEqual([]);
  expect(semanticWords('XLF (long, Financials); XLU (long), XLI (short)')).toEqual([
    { text: 'long', tone: 'positive' }, { text: 'long', tone: 'positive' }, { text: 'short', tone: 'negative' },
  ]);
  expect(semanticWords('Constrain additional longs. Do not add longs while buffered room is zero. Cover shorts.')).toEqual([
    { text: 'longs', tone: 'positive' }, { text: 'longs', tone: 'positive' }, { text: 'shorts', tone: 'negative' },
  ]);
});

test('Quad tokens use all four shared classes with boundaries and macro context for Q abbreviations', () => {
  expect(semanticWords('Quad 1, QUAD2, Quad 3, quad4; Quad 10, Quad 1.5, Q10, SQ1, Quad4x.')).toEqual([
    { text: 'Quad 1', tone: 'quad-1' }, { text: 'QUAD2', tone: 'quad-2' },
    { text: 'Quad 3', tone: 'quad-3' }, { text: 'quad4', tone: 'quad-4' },
  ]);
  expect(semanticWords('Macro regime: Q1 → Q2 → Q3 → Q4')).toEqual([
    { text: 'Q1', tone: 'quad-1' }, { text: 'Q2', tone: 'quad-2' },
    { text: 'Q3', tone: 'quad-3' }, { text: 'Q4', tone: 'quad-4' },
  ]);
  expect(semanticWords('Q1')).toEqual([]);
  expect(semanticWords('Q1', 'Quad regime')).toEqual([{ text: 'Q1', tone: 'quad-1' }]);
  expect(semanticWords('Q1 2026 earnings growth; fiscal Q2 revenue growth; Q3 results; calendar Q4', 'Macro')).toEqual([]);
  const tree = apply([
    { type: 'heading', depth: 2, children: [text('Macro regimes')] },
    paragraph(text('Q1 → Q4')),
  ], '# Old report');
  expect(colored(tree)).toEqual([
    { text: 'Q1', tone: 'analyst-process--quad-1' }, { text: 'Q4', tone: 'analyst-process--quad-4' },
  ]);
});

test('reported directions do not create a live quote, price, or an action', () => {
  const value = 'A held Long retains a Bullish signal in Quad 2. Quote unavailable; provider offline. No bid or ask is supplied.';
  const tree = apply([paragraph(text(value)), fact('Process action', 'ACTION BLOCKED — BULLISH Trade unavailable')]);
  expect(content(tree)).toBe(`${value}Process action: ACTION BLOCKED — BULLISH Trade unavailable`);
  expect(colored(tree)).toEqual([
    { text: 'Long', tone: 'analyst-process--positive' }, { text: 'Bullish', tone: 'analyst-process--positive' },
    { text: 'Quad 2', tone: 'analyst-process--quad-2' },
    { text: 'ACTION BLOCKED', tone: 'analyst-process--caution' },
    { text: 'BULLISH', tone: 'analyst-process--positive' },
    { text: 'unavailable', tone: 'analyst-process--caution' },
  ]);
  expect(colored(apply([fact('Process action', 'EXIT — target zero')]))).toEqual([
    { text: 'EXIT', tone: 'analyst-process--negative' },
  ]);
});

test('saved review headings keep their text and color only the outcome', () => {
  const tree = apply([{ type: 'heading', depth: 2, children: [text('Balance Review — Partial')] }], '## Balance Review — Partial');
  expect(content(tree)).toBe('Balance Review — Partial');
  expect(colored(tree)).toEqual([{ text: 'Partial', tone: 'analyst-process--caution' }]);
});

test('Portfolio Review Markdown colors ticker mentions and topic titles without replacing financial semantics', () => {
  const title = { type: 'heading', depth: 2, children: [text('Macro & regime')] };
  const sentence = 'RATES — AAPL remains Bullish; VIX is Bearish in Quad 4. GDP and NLV are unchanged.';
  const table = { type: 'table', children: [
    { type: 'tableRow', children: ['Ticker', 'Security', 'Trend'].map(value => ({ type: 'tableCell', children: [text(value)] })) },
    { type: 'tableRow', children: ['SPY', 'S&P 500 ETF', 'Neutral'].map(value => ({ type: 'tableCell', children: [text(value)] })) },
  ] };
  const tree = apply([title, paragraph(text(sentence)), table]);
  expect(title.data.hProperties.className).toContain('analyst-portfolio-title');
  expect(tree.children[1]).toMatchObject({ type: 'heading', depth: 3 });
  expect(content(tree.children[1])).toBe('RATES');
  expect(content(tree.children[2])).toBe(sentence.slice('RATES — '.length));
  expect(content(tree)).toBe(`Macro & regime${sentence.replace(' — ', '')}TickerSecurityTrendSPYS&P 500 ETFNeutral`);
  expect(colored(tree)).toEqual([
    { text: 'RATES', tone: 'analyst-process--title' },
    { text: 'AAPL', tone: 'analyst-process--ticker' },
    { text: 'Bullish', tone: 'analyst-process--positive' },
    { text: 'VIX', tone: 'analyst-process--ticker' },
    { text: 'Bearish', tone: 'analyst-process--negative' },
    { text: 'Quad 4', tone: 'analyst-process--quad-4' },
    { text: 'SPY', tone: 'analyst-process--ticker' },
    { text: 'Neutral', tone: 'analyst-process--muted' },
  ]);
});

test('saved Portfolio Review gives each sector its own heading above complete company commentary', () => {
  const staple = 'Consumer Staples — Lamb Weston Holdings, Inc. (LW): On the Long bias list.';
  const retail = 'Retail — Helen of Troy Limited (HELE) reports tomorrow; SharkNinja, Inc. (SN) is the comparison.';
  const continuation = 'Deckers Outdoor Corporation (DECK): The Short thesis includes NIKE, Inc. (NKE) and adidas AG (ADS.DE).';
  const healthcare = 'Health Care — 10x Genomics, Inc. (TXG) declined; Twist Bioscience Corporation (TWST) remains Bullish.';
  const evidence = { type: 'link', url: 'citation://company-research', children: [text('Captured publication')] };
  const tree = apply([
    paragraph(text(staple)), paragraph(text(retail), text(' '), evidence), paragraph(text(continuation)),
    paragraph(text(healthcare)), paragraph(text('Helen of Troy Limited and Deckers Outdoor Corporation are discussed above.')),
  ], '# Captured daily rollup', { reviewKind: 'portfolio-review' });
  expect(tree.children.map(node => node.type)).toEqual(['heading', 'paragraph', 'heading', 'paragraph', 'paragraph', 'heading', 'paragraph', 'paragraph']);
  expect(tree.children.filter(node => node.type === 'heading').map(content)).toEqual(['Consumer Staples', 'Retail', 'Health Care']);
  expect(content(tree.children[1])).toBe(staple.slice('Consumer Staples — '.length));
  expect(content(tree.children[3])).toBe(`${retail.slice('Retail — '.length)} Captured publication`);
  expect(content(tree.children[4])).toBe(continuation);
  expect(content(tree.children[6])).toBe(healthcare.slice('Health Care — '.length));
  expect(tree.children[3].children).toContain(evidence);
  const names = node => node.type === 'analystCompanyText' ? [content(node)] : (node.children || []).flatMap(names);
  expect(names(tree)).toEqual([
    'Lamb Weston Holdings, Inc.', 'Helen of Troy Limited', 'SharkNinja, Inc.', 'Deckers Outdoor Corporation',
    'NIKE, Inc.', 'adidas AG', '10x Genomics, Inc.', 'Twist Bioscience Corporation',
    'Helen of Troy Limited', 'Deckers Outdoor Corporation',
  ]);
  expect(colored(tree)).toEqual(expect.arrayContaining([
    { text: 'Long', tone: 'analyst-process--positive' }, { text: 'Short', tone: 'analyst-process--negative' },
    { text: 'Bullish', tone: 'analyst-process--positive' }, { text: 'HELE', tone: 'analyst-process--ticker' },
    { text: 'ADS.DE', tone: 'analyst-process--ticker' },
  ]));
});

test('Portfolio Review preserves inline emphasis and captured links when separating a topic prefix', () => {
  const emphasis = { type: 'strong', children: [text('Retail')] };
  const company = { type: 'emphasis', children: [text('Helen of Troy Limited')] };
  const link = { type: 'link', url: 'https://research.example/company?symbol=HELE', children: [text('Original publication')] };
  const tree = apply([paragraph(emphasis, text(' — '), company, text(' (HELE) remains Short. '), link)], '# Saved', { reviewKind: 'portfolio-review' });
  expect(tree.children[0]).toMatchObject({ type: 'heading', depth: 3 });
  expect(tree.children[0].children[0].type).toBe('strong');
  expect(tree.children[1].children[0].type).toBe('emphasis');
  expect(content(tree.children[0])).toBe('Retail');
  expect(content(tree.children[1])).toBe('Helen of Troy Limited (HELE) remains Short. Original publication');
  expect(tree.children[1].children).toContain(link);
  expect(link.url).toBe('https://research.example/company?symbol=HELE');
});

test('Portfolio Review company typography leaves captured sources, URLs, code and ordinary dash sentences intact', () => {
  const company = 'Bullish Technologies';
  const url = 'https://research.example/Bullish-Technologies?symbol=BTX';
  const citation = { type: 'link', url: 'citation://BTX-research', children: [text(`${company} (BTX)`)] };
  const source = { type: 'link', url, children: [text(`${company} source`)] };
  const code = { type: 'inlineCode', value: `${company} (BTX)` };
  const block = { type: 'code', lang: 'text', value: `${company} (BTX)` };
  const ordinary = 'A sentence already ended. — Another sentence follows.';
  const footer = 'Sources: Bullish Technologies research — original publication';
  const tree = apply([
    paragraph(text(`${company} (BTX) remains Bullish in Quad 1.`)),
    paragraph(text(`${url} `), citation, text(' '), source, text(' '), code),
    paragraph(text(ordinary)), paragraph(text(footer)), block,
    paragraph({ type: 'inlineCode', value: 'Retail' }, text(' — exact quoted code prefix')),
  ], '# Saved', { reviewKind: 'portfolio-review' });
  expect(tree.children.every(node => node.type !== 'heading')).toBe(true);
  const names = node => node.type === 'analystCompanyText' ? [content(node)] : (node.children || []).flatMap(names);
  expect(names(tree)).toEqual([company]);
  expect(tree.children[0].children[0].data.hProperties.className).toContain('analyst-portfolio-company');
  expect(colored(tree.children[0])).toEqual([
    { text: 'BTX', tone: 'analyst-process--ticker' }, { text: 'Bullish', tone: 'analyst-process--positive' },
    { text: 'Quad 1', tone: 'analyst-process--quad-1' },
  ]);
  expect(tree.children[1].children).toContain(code);
  const links = tree.children[1].children.filter(node => node.type === 'link');
  expect(links.map(node => ({ url: node.url, label: content(node) }))).toEqual([
    { url: citation.url, label: content(citation) }, { url, label: content(source) },
  ]);
  expect(content(tree.children[2])).toBe(ordinary);
  expect(content(tree.children[3])).toBe(footer);
  expect(tree.children[4]).toBe(block);
  expect(tree.children[5].children[0].type).toBe('inlineCode');
});

test.each(['prediction-markets-review', 'portfolio-cross-verification', 'balance-review', 'daily-chat'])(
  '%s keeps its existing topic and company presentation', reviewKind => {
    const sentence = 'Retail — Helen of Troy Limited (HELE) remains Bullish.';
    const tree = apply([paragraph(text(sentence))], '# Saved', { reviewKind });
    expect(tree.children[0].type).toBe('paragraph');
    expect(content(tree)).toBe(sentence);
    expect(JSON.stringify(tree)).not.toContain('analyst-portfolio-topic');
    expect(JSON.stringify(tree)).not.toContain('analyst-portfolio-company');
  },
);

test('review kind opts saved Markdown into identity colors while only Portfolio colors topic titles', () => {
  const source = '# Saved daily rollup';
  const makeNodes = () => [
    { type: 'heading', depth: 2, children: [text('Session outlook')] },
    paragraph(text('VOLATILITY — VIX remains Bearish.')),
  ];
  const portfolio = apply(makeNodes(), source, { reviewKind: 'portfolio-review' });
  expect(colored(portfolio)).toEqual([
    { text: 'VOLATILITY', tone: 'analyst-process--title' },
    { text: 'VIX', tone: 'analyst-process--ticker' },
    { text: 'Bearish', tone: 'analyst-process--negative' },
  ]);
  const prediction = apply(makeNodes(), source, { reviewKind: 'prediction-markets-review' });
  expect(prediction.children[0].data).toBeUndefined();
  expect(colored(prediction)).toEqual([
    { text: 'VIX', tone: 'analyst-process--ticker' },
    { text: 'Bearish', tone: 'analyst-process--negative' },
  ]);
  for (const reviewKind of ['balance-review', 'daily-chat']) {
    const tree = apply(makeNodes(), '# Portfolio Review', { reviewKind });
    expect(tree.children[0].data).toBeUndefined();
    expect(colored(tree)).toEqual([{ text: 'Bearish', tone: 'analyst-process--negative' }]);
  }
});

test('Portfolio Review Markdown preserves URLs, code, source links and ticker punctuation', () => {
  const url = 'https://research.example/SPY/VIX?symbol=AAPL';
  const code = { type: 'inlineCode', value: 'AAPL VIX' };
  const block = { type: 'code', lang: 'text', value: 'SPY Bearish' };
  const sourceLink = { type: 'link', url, children: [text('AAPL source')] };
  const nodes = [paragraph(text(`${url} `), code, text(' '), sourceLink, text(' SPY, VIX.')), block];
  const before = content({ children: nodes });
  const tree = apply(nodes);
  expect(content(tree)).toBe(before);
  expect(colored(tree)).toEqual([
    { text: 'AAPL', tone: 'analyst-process--ticker' },
    { text: 'SPY', tone: 'analyst-process--ticker' },
    { text: 'VIX', tone: 'analyst-process--ticker' },
  ]);
  expect(tree.children[0].children.find(node => node.type === 'inlineCode')).toBe(code);
  expect(tree.children[0].children.find(node => node.type === 'link')).toMatchObject({ url });
  expect(tree.children[1]).toBe(block);
});

test('explicit saved Ticker columns identify unfamiliar symbols throughout the same Markdown report', () => {
  const table = { type: 'table', children: [
    { type: 'tableRow', children: ['Ticker', 'Security'].map(value => ({ type: 'tableCell', children: [text(value)] })) },
    { type: 'tableRow', children: ['ZZZZ', 'Source-listed security'].map(value => ({ type: 'tableCell', children: [text(value)] })) },
  ] };
  const tree = apply([paragraph(text('ZZZZ remains Neutral; GDP does not change.')), table]);
  expect(colored(tree)).toEqual([
    { text: 'ZZZZ', tone: 'analyst-process--ticker' },
    { text: 'Neutral', tone: 'analyst-process--muted' },
    { text: 'ZZZZ', tone: 'analyst-process--ticker' },
  ]);
});

test('Predictive Markets Review colors captured securities throughout narratives and readings', () => {
  const table = { type: 'table', children: [
    { type: 'tableRow', children: ['Ticker', 'Security', 'Trend'].map(value => ({ type: 'tableCell', children: [text(value)] })) },
    { type: 'tableRow', children: ['NEWT', 'New Technology', 'Bullish'].map(value => ({ type: 'tableCell', children: [text(value)] })) },
  ] };
  const sentence = 'Apple (AAPL), MSFT and META: Bearish. SPX/SPY and QQQ remain Neutral; BTC is Bullish in Quad 4. NEWT and Acme (ACMEX) follow; ACMEX remains Bearish.';
  const tree = apply([paragraph(text(sentence)), table], '# Saved prediction report', { reviewKind: 'prediction-markets-review' });
  expect(content(tree)).toBe(`${sentence}TickerSecurityTrendNEWTNew TechnologyBullish`);
  expect(colored(tree)).toEqual([
    { text: 'AAPL', tone: 'analyst-process--ticker' },
    { text: 'MSFT', tone: 'analyst-process--ticker' },
    { text: 'META', tone: 'analyst-process--ticker' },
    { text: 'Bearish', tone: 'analyst-process--negative' },
    { text: 'SPX', tone: 'analyst-process--ticker' },
    { text: 'SPY', tone: 'analyst-process--ticker' },
    { text: 'QQQ', tone: 'analyst-process--ticker' },
    { text: 'Neutral', tone: 'analyst-process--muted' },
    { text: 'BTC', tone: 'analyst-process--ticker' },
    { text: 'Bullish', tone: 'analyst-process--positive' },
    { text: 'Quad 4', tone: 'analyst-process--quad-4' },
    { text: 'NEWT', tone: 'analyst-process--ticker' },
    { text: 'ACMEX', tone: 'analyst-process--ticker' },
    { text: 'ACMEX', tone: 'analyst-process--ticker' },
    { text: 'Bearish', tone: 'analyst-process--negative' },
    { text: 'NEWT', tone: 'analyst-process--ticker' },
    { text: 'Bullish', tone: 'analyst-process--positive' },
  ]);
});

test('prediction reading tables retain Tick direction and explicit underlying futures identity', () => {
  const table = { type: 'table', children: [
    ['Metric', 'Reading', 'Date'],
    ['Tick', 'Last known Long · SPY proxy', 'Sep 28, 2026'],
    ['Trade', 'Bearish · SPX', 'Sep 17, 2026'],
    ['Underlying', 'LIVE ESZ26 7,737.5', 'Sep 29, 2026 15:05 ET'],
  ].map(row => ({ type: 'tableRow', children: row.map(value => ({ type: 'tableCell', children: [text(value)] })) })) };
  const tree = apply([table, paragraph(text('ESZ26 compared with SPX. CPI (CPI), EPS (EPS), FOMC (FOMC), YES and NO stay plain.'))], '# Saved', { reviewKind: 'prediction-markets-review' });
  expect(colored(tree)).toEqual([
    { text: 'Long', tone: 'analyst-process--positive' },
    { text: 'SPY', tone: 'analyst-process--ticker' },
    { text: 'Sep 28, 2026', tone: 'analyst-process--key' },
    { text: 'Bearish', tone: 'analyst-process--negative' },
    { text: 'SPX', tone: 'analyst-process--ticker' },
    { text: 'Sep 17, 2026', tone: 'analyst-process--key' },
    { text: 'ESZ26', tone: 'analyst-process--ticker' },
    { text: 'Sep 29, 2026 12:05 PDT', tone: 'analyst-process--key' },
    { text: 'ESZ26', tone: 'analyst-process--ticker' },
    { text: 'SPX', tone: 'analyst-process--ticker' },
  ]);
});

test.each(['portfolio-review', 'prediction-markets-review', 'balance-review', 'portfolio-cross-verification', 'session-outlook'])(
  '%s presents saved priority facts and Pacific dates while preserving citations and code', reviewKind => {
    const source = 'Account: IBKR Account123. Fresh 71-position book; engine scan of 1,829 publications. Oct 5, 2026 at 14:17 UTC.';
    const account = { type: 'inlineCode', value: 'Account123' };
    const link = { type: 'link', url: 'https://example.com/2026-10-05T14:17:00Z', children: [text('Oct 5, 2026 at 14:17 UTC')] };
    const code = { type: 'code', value: '2026-10-05T14:17:00Z' };
    const tree = apply([paragraph(text('Account: IBKR '), account, text('. Fresh 71-position book; engine scan of 1,829 publications. '), link), code], source, { reviewKind });
    expect(account.data.hProperties.className).toContain('analyst-process--key');
    expect(colored(tree)).toEqual([
      { text: '71', tone: 'analyst-process--key' },
      { text: '1,829', tone: 'analyst-process--key' },
      { text: 'Oct 5, 2026 07:17 PDT', tone: 'analyst-process--key' },
    ]);
    expect(link.url).toBe('https://example.com/2026-10-05T14:17:00Z');
    expect(code.value).toBe('2026-10-05T14:17:00Z');
    expect(source).toContain('14:17 UTC');
  },
);

test('prediction ticker typography preserves citation labels, source footers, URLs and code', () => {
  const url = 'https://research.example/SPY/VIX?symbol=AAPL';
  const citation = { type: 'link', url: 'citation://SPY-report', children: [text('SPY research (NOTICK)')] };
  const source = { type: 'link', url, children: [text('AAPL source')] };
  const link = { type: 'link', url, children: [text('SPY')] };
  const code = { type: 'inlineCode', value: 'AAPL (NOTICK2)' };
  const block = { type: 'code', lang: 'text', value: 'SPY (NOTICK3)' };
  const tree = apply([
    paragraph(text(`${url} `), code, text(' '), citation, text(' '), source, text(' '), link), block,
    paragraph(text('Sources: SPY research, AAPL report, (NOTICK4)')),
    paragraph(text('NOTICK NOTICK2 NOTICK3 NOTICK4; SPY is Bullish.')),
  ], '# Saved', { reviewKind: 'prediction-markets-review' });
  expect(colored(tree)).toEqual([
    { text: 'SPY', tone: 'analyst-process--ticker' },
    { text: 'SPY', tone: 'analyst-process--ticker' },
    { text: 'Bullish', tone: 'analyst-process--positive' },
  ]);
  expect(tree.children[0].children).toContain(citation);
  expect(tree.children[0].children).toContain(source);
  expect(tree.children[0].children).toContain(code);
  expect(tree.children[1]).toBe(block);
});

test('manual portfolio verification retains the complete captured ticker roster and semantic colors', () => {
  const symbols = Array.from({ length: 73 }, (_value, index) => `BOOK${index}`);
  const table = { type: 'table', children: [
    ['Ticker', 'Security', 'Check result'],
    ...symbols.map(ticker => [ticker, `${ticker} (STK; name unavailable)`, 'Unknown']),
  ].map(row => ({ type: 'tableRow', children: row.map(value => ({ type: 'tableCell', children: [text(value)] })) })) };
  const sentence = `${symbols.join(', ')}; AAPL and $NEWCO remain Bullish in Quad 1. USD/JPY is Bearish; GDP, CPI, NLV and STK stay plain.`;
  const tree = apply([paragraph(text(sentence)), table], '# Captured manual check', { reviewKind: 'portfolio-cross-verification' });
  expect(content(tree)).toBe(sentence + content(table));
  const ranges = colored(tree);
  for (const ticker of symbols) expect(ranges.filter(range => range.text === ticker)).toHaveLength(3);
  expect(ranges).toEqual(expect.arrayContaining([
    { text: 'AAPL', tone: 'analyst-process--ticker' }, { text: '$NEWCO', tone: 'analyst-process--ticker' },
    { text: 'Bullish', tone: 'analyst-process--positive' }, { text: 'Quad 1', tone: 'analyst-process--quad-1' },
    { text: 'USD/JPY', tone: 'analyst-process--ticker' }, { text: 'Bearish', tone: 'analyst-process--negative' },
  ]));
  expect(ranges.some(range => ['GDP', 'CPI', 'NLV', 'STK'].includes(range.text))).toBe(false);
  expect(JSON.stringify(tree)).not.toContain('analyst-company-name');
});

test('manual section rendering uses only validated captured ticker options', () => {
  const sentence = 'UNLISTED remains Bullish, while GDP, MOCK TOKEN, XYZ? and arbitrary WORD stay plain.';
  const options = { reviewKind: 'portfolio-cross-verification', securityTickers: ['UNLISTED', 'MOCK TOKEN', 'XYZ?', null, 42] };
  const tree = apply([paragraph(text(sentence))], '# Manual section', options);
  expect(colored(tree)).toEqual([
    { text: 'UNLISTED', tone: 'analyst-process--ticker' }, { text: 'Bullish', tone: 'analyst-process--positive' },
  ]);
  const chat = apply([paragraph(text('UNLISTED remains Bullish.'))], '# Chat', { ...options, reviewKind: 'chat' });
  expect(colored(chat)).toEqual([{ text: 'Bullish', tone: 'analyst-process--positive' }]);
});

test('manual sections emphasize exact names captured elsewhere in the same report without supplying missing names', () => {
  const sentence = 'Acme Corporation and NAMEX (STK; name unavailable) remain in the captured book; UNNAMED has no company label.';
  const options = { reviewKind: 'portfolio-cross-verification', securityNames: [
    { name: 'Acme Corporation (ACMEX)', ticker: 'ACMEX' },
    { name: 'NAMEX (STK; name unavailable)', ticker: 'NAMEX' }, { name: 'UNNAMED', ticker: 'UNNAMED' },
    { name: null, ticker: 'MISSING' }, null,
  ] };
  const tree = apply([paragraph(text(sentence))], '# Manual section', options);
  const names = node => node.type === 'analystCompanyText' ? [content(node)] : (node.children || []).flatMap(names);
  expect(names(tree)).toEqual(['Acme Corporation']);
  expect(content(tree)).toBe(sentence);
  const chat = apply([paragraph(text(sentence))], '# Chat', { ...options, reviewKind: 'chat' });
  expect(names(chat)).toEqual([]);
});

test('manual verification bolds only captured real security names and protects source, URL and code text', () => {
  const table = { type: 'table', children: [
    ['Ticker', 'Company', 'Trend'],
    ['ACMEX', 'Acme Corporation', 'Bullish'],
    ['BTX', 'Bullish Technologies', 'Neutral'],
    ['MISSINGX', 'MISSINGX (STK; name unavailable)', 'Unknown'],
    ['UNNAMED', 'UNNAMED', 'Unknown'],
  ].map(row => ({ type: 'tableRow', children: row.map(value => ({ type: 'tableCell', children: [text(value)] })) })) };
  const citation = { type: 'link', url: 'citation://ACMEX-report', children: [text('Acme Corporation (ACMEX)')] };
  const source = { type: 'link', url: 'https://example.com/ACMEX', children: [text('Acme Corporation source')] };
  const code = { type: 'inlineCode', value: 'Acme Corporation ACMEX' };
  const block = { type: 'code', lang: 'text', value: 'Acme Corporation ACMEX' };
  const sentence = 'Acme Corporation and Bullish Technologies hold Long ACMEX in Quad 4; Acme Corporations is different.';
  const tree = apply([
    paragraph(text(sentence)), table,
    paragraph(citation, text(' '), source, text(' '), code), block,
    paragraph(text('Sources: Acme Corporation, ACMEX research')),
  ], '# Saved manual report', { reviewKind: 'portfolio-cross-verification' });
  const names = node => node.type === 'analystCompanyText' ? [content(node)] : (node.children || []).flatMap(names);
  expect(names(tree)).toEqual(['Acme Corporation', 'Bullish', ' Technologies', 'Acme Corporation', 'Bullish', ' Technologies']);
  expect(tree.children[0].children[0].data.hProperties.title).toBe('Acme Corporation');
  expect(colored(tree)).toEqual(expect.arrayContaining([
    { text: 'Bullish', tone: 'analyst-process--positive' }, { text: 'Long', tone: 'analyst-process--positive' },
    { text: 'ACMEX', tone: 'analyst-process--ticker' }, { text: 'Quad 4', tone: 'analyst-process--quad-4' },
  ]));
  expect(content(tree.children[0])).toBe(sentence);
  expect(tree.children[2].children).toContain(citation);
  expect(tree.children[2].children).toContain(source);
  expect(tree.children[2].children).toContain(code);
  expect(tree.children[3]).toBe(block);
  expect(tree.children[4].children).toEqual([text('Sources: Acme Corporation, ACMEX research')]);
});

test('captured ticker and numeric quantity labels color their held side without coloring time horizons', () => {
  const labels = ['CVI, long 75:', 'CHH, short 35:', 'BRK.B, Long 1,250.5:'];
  const nodes = labels.map(label => paragraph({ type: 'strong', children: [text(label)] }, text(' Dated research action.')));
  nodes.push(paragraph(text('CVI, short-term history and CHH, long-term thesis remain unchanged.')));
  const tree = apply(nodes, '# Manual exceptions', { reviewKind: 'portfolio-cross-verification', securityTickers: ['CVI', 'CHH', 'BRK.B'] });
  expect(colored(tree).filter(range => range.tone !== 'analyst-process--ticker')).toEqual([
    { text: 'long', tone: 'analyst-process--positive' }, { text: 'short', tone: 'analyst-process--negative' },
    { text: 'Long', tone: 'analyst-process--positive' },
  ]);
  labels.forEach((label, index) => expect(content(tree.children[index])).toBe(`${label} Dated research action.`));
  expect(content(tree.children[3])).toBe('CVI, short-term history and CHH, long-term thesis remain unchanged.');
});

test('manual source-action quotes color validated tickers while retaining code elements and exact text', () => {
  const values = ['Sold 100bps HGER', 'Sold 50bps IBIT', 'Buys Closed: Energy XLE'];
  const quotes = values.map(value => ({ type: 'inlineCode', value }));
  const protectedValues = ['HGER IBIT XLE', 'const ticker = "HGER"', 'https://example.com/HGER', 'Sold 100bps UNREGISTERED', 'Buys Closed: Energy OTHERX'];
  const protectedQuotes = protectedValues.map(value => ({ type: 'inlineCode', value }));
  const footerQuote = { type: 'inlineCode', value: values[0] };
  const linkedQuote = { type: 'inlineCode', value: values[1] };
  const block = { type: 'code', lang: 'text', value: values[2] };
  const tree = apply([
    paragraph(...quotes), paragraph(...protectedQuotes), paragraph(text('Sources: '), footerQuote),
    paragraph({ type: 'link', url: 'citation://report', children: [linkedQuote] }), block,
  ], '# Manual source actions', { reviewKind: 'portfolio-cross-verification', securityTickers: ['HGER', 'IBIT', 'XLE'] });
  quotes.forEach((quote, index) => {
    expect(tree.children[0].children[index]).toBe(quote);
    expect(quote).toMatchObject({ type: 'inlineCode', value: values[index] });
    expect(quote.data.hChildren.map(child => child.value || child.children.map(content).join('')).join('')).toBe(values[index]);
    expect(quote.data.hChildren.find(child => child.type === 'element')).toMatchObject({
      tagName: 'span', properties: { className: ['analyst-process--ticker'] },
    });
  });
  [...protectedQuotes, footerQuote, linkedQuote, block].forEach(node => expect(node.data).toBeUndefined());
  const chatQuote = { type: 'inlineCode', value: values[0] };
  apply([paragraph(chatQuote)], '# Chat', { reviewKind: 'chat', securityTickers: ['HGER'] });
  expect(chatQuote.data).toBeUndefined();
});
