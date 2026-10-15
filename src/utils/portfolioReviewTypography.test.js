import { portfolioCompanyNameRanges, portfolioNamedSecurityMentions, portfolioReviewCompanyNames, portfolioReviewTickers, portfolioTickerRanges, portfolioTopicTitle } from './portfolioReviewTypography';

const colored = (text, tickers, context) => portfolioTickerRanges(text, tickers, context).map(({ start, end }) => text.slice(start, end));

test('currency codes and complete FX pairs are blue independently of the captured ticker roster', () => {
  const codes = 'JPY EUR GBP CHF CAD AUD NZD CNY CNH HKD SGD NOK SEK INR KRW MXN BRL ZAR XXX';
  expect(colored(codes, new Set())).toEqual(codes.split(' '));
  const pairs = 'USD/JPY EUR/GBP NOK/SEK USD/CNH USD/XXX EUR/ALL USDJPY GBPCHF USD-JPY EUR.USD';
  expect(colored(pairs, new Set())).toEqual(pairs.split(' '));
});

test('currency styling preserves word boundaries and excludes source URLs and code', () => {
  expect(colored('JPYish preJPY usd/jpy XJPY JPY2 GDP CPI ABC/XYZ https://example.com/USD/JPY `JPY USD/XXX`', new Set())).toEqual([]);
  expect(colored('(JPY), USD/JPY; USD/XXX.', new Set())).toEqual(['JPY', 'USD/JPY', 'USD/XXX']);
});

test('ticker typography uses captured identities and exact token boundaries', () => {
  const tickers = new Set(['SPX', 'VIX', 'BRK.B', 'USDJPY', 'BTC-USD', 'ES=F', 'NEWCO']);
  expect(colored('SPX, VIX; BRK.B and USDJPY versus BTC-USD / ES=F. $NEWCO is Bullish.', tickers))
    .toEqual(['SPX', 'VIX', 'BRK.B', 'USDJPY', 'BTC-USD', 'ES=F', '$NEWCO']);
  expect(colored('SPXL spx preSPX SPXish https://example.com/SPX `VIX` GDP CPI NLV', tickers)).toEqual([]);
});

test('ambiguous words need explicit ticker context or explicit notation', () => {
  const tickers = new Set(['A', 'ON', 'ALL', 'NOW', 'PCA', 'SPY']);
  expect(colored('A view ON ALL holdings NOW. PCA data and SPY.', tickers)).toEqual(['SPY']);
  expect(colored('$ON (NOW) A', tickers)).toEqual(['$ON', 'NOW']);
  expect(colored('A', tickers, 'Ticker')).toEqual(['A']);
});

test('report ticker roster includes captured tables and explicit prose mentions without financial values', () => {
  const tickers = portfolioReviewTickers({ brief: { holdings: [{ holding: 'HOLDINGX' }] }, rollup: {
    securityTickers: ['SOURCEQ'], sections: [{ blocks: [
      { type: 'table', columns: ['Ticker', 'Security'], rows: [{ cells: ['TABLEQ', 'Company'] }] },
      { type: 'paragraph', text: 'The company $NEWCO and $CASHQ; GDP and NLV are metrics. FOMC (FOMC) and EBITDA (EBITDA).' },
    ] }],
  } });
  for (const ticker of ['HOLDINGX', 'SOURCEQ', 'TABLEQ', 'NEWCO', 'CASHQ']) expect(tickers.has(ticker)).toBe(true);
  expect(tickers.has('Company')).toBe(false);
  expect(tickers.has('FOMC')).toBe(false);
  expect(tickers.has('EBITDA')).toBe(false);
});

test('research ratios color their constituent tickers while registered FX pairs remain intact', () => {
  const tickers = new Set(['SPY', 'QQQ', 'VIX', 'EUR/USD', 'BRK.B']);
  expect(colored('SPY/QQQ and VIX/SPY; EUR/USD and BRK.B', tickers)).toEqual(['SPY', 'QQQ', 'VIX', 'SPY', 'EUR/USD', 'BRK.B']);
});

test('topic titles preserve explicit metadata and short legacy subheads', () => {
  expect(portfolioTopicTitle('RATES — Yields moved lower.', 'RATES')).toBe('RATES');
  expect(portfolioTopicTitle('EUROPE — DAX weakened.')).toBe('EUROPE');
  expect(portfolioTopicTitle('SPX — The first point — a second point.')).toBe('SPX');
  expect(portfolioTopicTitle('An ordinary sentence. — Continuation.')).toBe('');
  expect(portfolioTopicTitle('Plain paragraph without a title.')).toBe('');
});

test('explicit prose pairs identify full company names in paragraph leads and midway through commentary', () => {
  const prose = "Consumer Staples — Lamb Weston Holdings, Inc. (LW) has a long bias. Retail — Helen of Troy Limited (HELE) reports tomorrow. Deckers Outdoor Corporation (DECK) competes with NIKE, Inc. (NKE) and adidas AG (ADS.DE). Restaurants — Domino's Pizza, Inc. (DPZ) moved higher. HCA Healthcare, Inc. (HCA) and 10x Genomics, Inc. (TXG) have updates; with Boyd Gaming Corporation (BYD) and Red Rock Resorts, Inc. (RRR) the preferred shorts.";
  const expected = ['Lamb Weston Holdings, Inc.', 'Helen of Troy Limited', 'Deckers Outdoor Corporation', 'NIKE, Inc.', 'adidas AG', "Domino's Pizza, Inc.", 'HCA Healthcare, Inc.', '10x Genomics, Inc.', 'Boyd Gaming Corporation', 'Red Rock Resorts, Inc.'];
  const mentions = portfolioNamedSecurityMentions(prose);
  expect(mentions.map(mention => mention.name)).toEqual(expected);
  mentions.forEach(({ name, start, end }) => expect(prose.slice(start, end)).toBe(name));
  expect(portfolioCompanyNameRanges(prose).map(({ start, end }) => prose.slice(start, end))).toEqual(expected);
});

test('company names use only captured labels and do not replace them with a current catalog name', () => {
  const brief = { holdings: [{ holding: 'AAPL', securityName: 'Captured historical issuer' }, { holding: 'MISSING', securityName: 'Unavailable' }] };
  const rollup = { sections: [{ blocks: [
    { type: 'table', columns: ['Ticker', 'Security'], rows: [{ cells: ['HELE', 'Helen of Troy Limited'] }, { cells: ['HELE', '—'] }] },
    { type: 'paragraph', text: 'Deckers Outdoor Corporation (DECK) is compared with Helen of Troy Limited.' },
  ] }] };
  const before = JSON.stringify({ brief, rollup });
  const names = portfolioReviewCompanyNames({ brief, rollup });
  expect([...names]).toEqual(['Captured historical issuer', 'Helen of Troy Limited', 'Deckers Outdoor Corporation']);
  expect(names.has('Apple Inc.')).toBe(false);
  expect(JSON.stringify({ brief, rollup })).toBe(before);
  const tickers = portfolioReviewTickers({ brief, rollup });
  expect(tickers.has('HELE')).toBe(true);
  expect(tickers.has('DECK')).toBe(true);
});

test('exact company matching chooses complete captured names over nested ticker/name fragments', () => {
  const prose = 'HCA Healthcare, Inc. and HCA Healthcare; preHCA Healthcare and HCA Healthcareish stay plain.';
  const names = new Set(['HCA Healthcare', 'HCA Healthcare, Inc.']);
  expect(portfolioCompanyNameRanges(prose, names).map(({ start, end }) => prose.slice(start, end)))
    .toEqual(['HCA Healthcare, Inc.', 'HCA Healthcare']);
});

test('company typography protects source labels, URLs, code, acronyms and missing names', () => {
  const prose = 'Sources: Helen of Troy Limited (HELE)';
  const names = new Set(['Helen of Troy Limited']);
  expect(portfolioNamedSecurityMentions(prose)).toEqual([]);
  expect(portfolioCompanyNameRanges(prose, names)).toEqual([]);
  expect(portfolioCompanyNameRanges('Helen of Troy Limited', names, 'Source')).toEqual([]);
  expect(portfolioNamedSecurityMentions('GDP (GDP) and earnings per share (EPS), August regional gross gaming revenue (GGR).')).toEqual([]);
  expect(portfolioNamedSecurityMentions('https://research.example/Helen of Troy Limited (HELE) `Deckers Outdoor Corporation (DECK)`')).toEqual([]);
  const protectedProse = '`Helen of Troy Limited (HELE)` https://example.com/Helen_of_Troy_Limited/HELE';
  expect(portfolioCompanyNameRanges(protectedProse, names)).toEqual([]);
  for (const missing of ['—', 'Unavailable', 'Unknown', 'Not supplied', 'Security name unavailable']) {
    expect(portfolioCompanyNameRanges(missing, new Set(), 'Security')).toEqual([]);
  }
  expect(portfolioCompanyNameRanges('Verified fallback security name', new Set(), 'Security')).toEqual([
    { start: 0, end: 31, name: 'Verified fallback security name', tone: 'ticker' },
  ]);
});
