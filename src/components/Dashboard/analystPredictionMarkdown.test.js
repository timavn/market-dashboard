import { prepareAnalystMarkdown } from './analystMarkdown';
import { presentPredictionMarkdown } from './analystPredictionMarkdown';

const failure = "Client error '415 Unsupported Media Type' for url 'http://127.0.0.1:3001/api/prediction-market-test/monitor/silver/refresh?venue=forecastex&view=full' For more information check:\nhttps://developer.mozilla.org/en-US/docs/Web/HTTP/Status/415";

test('saved prediction review omits redundant headings and omits internal evidence failures', () => {
  const source = `# Predictive Markets Review\n\n**Outcome:** Partial\n\n## Monitored markets\n\n### Silver\n\n**Venue:** ForecastEx\n\n**Missing evidence**\n\n- ${failure}\n\n### Gold\n\n**Venue:** Kalshi\n\n**Missing evidence**\n\n- HTTP 502 Bad Gateway`;
  const result = prepareAnalystMarkdown(source);
  expect(result).toBe('### Silver\n\n**Venue:** ForecastEx\n\n### Gold\n\n**Venue:** Kalshi');
  expect(prepareAnalystMarkdown(result, { reviewKind: 'prediction-markets-review' })).toBe(result);
  expect(source).toContain(failure);
});

test.each(['Ready', 'Partial', 'Blocked'])('titleless prediction reports also hide aggregate %s and diagnostics', status => {
  const result = presentPredictionMarkdown(`**${status}**\n\n### Silver\n\n${failure}`, { reviewKind: 'prediction-markets-review' });
  expect(result).toBe('### Silver');
});

test('verified contract fields, source links, dates, zeros and meaningful constraints survive', () => {
  const source = `# Prediction Markets Review\n\n| Contract | Native book | Value | Source |\n|---|---|---|---|\n| Gold YES | 0.42 / 0.44 | $0.00 | [issuer](https://example.com/contract) |\n\n**Settlement:** Partial\n\n- Source published Sep 18 10:30 PT.\n- Exact resolver quote unavailable; sizing withheld.\n- ${failure}`;
  const result = prepareAnalystMarkdown(source);
  for (const value of ['Gold YES', '0.42 / 0.44', '$0.00', '[issuer](https://example.com/contract)', '**Settlement:** Partial', 'Source published Sep 18 10:30 PT.']) expect(result).toContain(value);
  expect(result).not.toContain('Missing data');
  expect(result).not.toContain('sizing withheld');
  expect(result).not.toContain('415');
});

test('error traces are replaced as a whole while ordinary fenced content is preserved', () => {
  const code = '```text\nVerified reference\n\nGold: $2,450\n```';
  const result = presentPredictionMarkdown(`### Silver\n\n\`\`\`text\nTraceback (most recent call last):\n  File "/repo/provider.py", line 4\n    secret_debug_call()\nValueError: broken\n\`\`\`\n\n${code}`, { reviewKind: 'prediction-markets-review' });
  expect(result).toBe(`### Silver\n\n${code}`);
});

test('ordinary chat and other review formats remain unchanged', () => {
  for (const source of [`A user is asking about ${failure}`, `# Balance Review\n\nPartial\n\n${failure}`, '## Portfolio Review\n\n## Monitored markets\n\nPartial']) {
    expect(presentPredictionMarkdown(source)).toBe(source);
  }
});

test('manager quote comparisons and readable closing dates survive report presentation', () => {
  const source = '### Silver\n\n**Trade:** —  \n**Trend:** Neutral · Sep 18, 2026  \n**Quoted level · YES:** Above 65.99 · 57¢ · implied 57% · gross reward/risk 0.75:1 before fees  \n**Higher strike:** Above 66.99 · YES · 42¢ · implied 42%  \n**Trading closes:** Sep 25, 2026 17:00 ET · Kalshi · Pyth - Silver  \n**Expiration:** Oct 2, 2026 18:00 ET';
  expect(presentPredictionMarkdown(source, { reviewKind: 'prediction-markets-review' })).toBe(source);
});

test('structure range explanation preserves cash and futures basis distinction', () => {
  const text = '#### Market structure & flows\n\nRisk Range: SPX 7,513–7,727 (Sep 18, 2026). The quoted ESZ26 LAST CLOSE level 7,722.25 is the contract reference. SPX is the basis for this range; comparable reward/risk —.';
  expect(presentPredictionMarkdown(text, { reviewKind: 'prediction-markets-review' })).toBe(text);
});

test('an absent Trade is not rendered as a signal conflict in older generated prose', () => {
  const source = '**WTI:** Trade — and Trend bullish, so signals do not agree. Range reward/risk is 4.41:1.\n\n**Brent:** Trade — and Trend bullish, so no agreement.\n\n**Gold:** Trade bearish and Trend bullish conflict.\n\n**Portfolio stance:** Trade is absent, so no setup clears the process gate.';
  const result = presentPredictionMarkdown(source, { reviewKind: 'prediction-markets-review' });
  expect(result).toContain('**WTI:** Trade — and Trend bullish. Range reward/risk is 4.41:1.');
  expect(result).toContain('**Brent:** Trade — and Trend bullish.');
  expect(result).toContain('**Gold:** Trade bearish and Trend bullish conflict.');
  expect(result).not.toContain('Portfolio stance');
  expect(result).not.toContain('no agreement');
  expect(result).not.toContain('signals do not agree');
});

test('a failed cell in a titleless prediction table preserves verified sibling rows, fields and citations', () => {
  const source = '| Market | Native book | Status | Source |\n|---|---|---|---|\n| Gold | 0.42 / 0.44 | Verified | [issuer](https://example.com/contract) |\n| Silver | 0.00 / 0.25 | HTTP 415 Unsupported Media Type | [research](https://research.example/reports/415) |';
  const result = presentPredictionMarkdown(source, { reviewKind: 'prediction-markets-review' });
  expect(result).toBe(source.replace('HTTP 415 Unsupported Media Type', '—'));
  expect(presentPredictionMarkdown(result, { reviewKind: 'prediction-markets-review' })).toBe(result);
  expect(presentPredictionMarkdown(source)).toBe(source);
  expect(presentPredictionMarkdown(source, { reviewKind: 'balance-review' })).toBe(source);
});

test('table cell sanitization preserves escaped pipes, inline code and optional outer delimiters', () => {
  const source = 'Market | Quote | Status | Source\n:--- | ---: | :---: | ---\nGold \\| spot | `bid|ask` 0.42/0.44 | ReadTimeout: upstream failed | [issuer \\| report](https://issuer.example/source)';
  expect(presentPredictionMarkdown(source, { reviewKind: 'prediction-markets-review' }))
    .toBe(source.replace('ReadTimeout: upstream failed', '—'));
});

test.each([
  'ReadTimeout: upstream refresh failed',
  'ConnectTimeout: provider did not respond',
  'httpx.UnsupportedProtocol: request failed',
  'JSONDecodeError: invalid provider response',
  '404 Not Found for the requested event',
  'http://[::1]:3001/api/monitor',
  'http://localhost:6951/healthz',
  'https://gateway.example/internal/analyst/prediction-analysis',
  'https://gateway.example/api/prediction-market-test/monitor/silver/refresh',
  'https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Status/415',
  'https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/503',
  'https://httpstatuses.io/415',
  'https://www.python-httpx.org/exceptions/',
])('legacy prediction diagnostic is omitted: %s', diagnostic => {
  expect(presentPredictionMarkdown(`### Silver\n\n${diagnostic}`, { reviewKind: 'prediction-markets-review' }))
    .toBe('### Silver');
  const table = `| Market | Quote | Status |\n|---|---|---|\n| Silver | 0.42 / 0.44 | ${diagnostic} |`;
  expect(presentPredictionMarkdown(table, { reviewKind: 'prediction-markets-review' }))
    .toBe(table.replace(diagnostic, '—'));
});

test('public raw and Markdown source URLs remain intact even when their path contains diagnostic words', () => {
  const source = '### Gold\n\nSource: https://research.example/reports/HTTPError/415\n\n[Published research](https://issuer.example/source/ReadTimeout?status=415)\n\n[Official CPI](https://www.bls.gov/cpi/)';
  expect(presentPredictionMarkdown(source, { reviewKind: 'prediction-markets-review' })).toBe(source);
});


test('saved reports omit diagnostic sections and boilerplate but preserve the next asset analysis', () => {
  const report = '### Silver\n\n**Trade:** Bullish\n\n**Trend:** Neutral\n\n**Missing data**\n\n- No verified feed.\n- Internal acquisition pending.\n\n### Gold\n\n**Trend:** Bullish\n\n**Current level:** Above $4,400 · YES 52¢ · implied odds 52%\n\n## Missing data\n\n### CPI\n\nProvider failed.\n\n## Risk limits\n\nMaximum risk 5%.\n\n## Process recommendations\n\n### Gold\n\n**Status:** withheld';
  const result = presentPredictionMarkdown(report, { reviewKind: 'prediction-markets-review' });
  expect(result).toContain('**Trade:** Bullish');
  expect(result).toContain('**Trend:** Neutral');
  expect(result).toContain('**Current level:** Above $4,400 · YES 52¢ · implied odds 52%');
  expect(result).not.toMatch(/Missing|Internal|Provider|Risk limits|Process recommendations|withheld|Maximum risk/);
});

test('normal dates preserve timezone meaning and leave source URLs untouched', () => {
  const source = '### Silver\n\n**Settlement:** 2026-09-25T21:00:00.000Z\n\n**Research:** 2026-09-18\n\n**Contract expiration:** 2026-10-02T22:00:00.000Z\n\nSource: https://research.example/2026-09-18';
  const result = presentPredictionMarkdown(source, { reviewKind: 'prediction-markets-review' });
  expect(result).toContain('**Settlement:** Sep 25, 2026 14:00 PDT');
  expect(result).not.toMatch(/\bET\b/);
  expect(result).toContain('**Research:** Sep 18, 2026');
  expect(result).not.toContain('Contract expiration');
  expect(result).toContain('https://research.example/2026-09-18');
  expect(presentPredictionMarkdown(result, { reviewKind: 'prediction-markets-review' })).toBe(result);
});

test('exact instants stay exact in Pacific time, including the repeated hour when daylight saving ends', () => {
  const source = '### Silver\n\n**Settlement:** 2026-11-01T05:30:00Z\n\n**Close:** 2026-11-01T09:30:00Z\n\n**Offset:** 2026-11-01T01:30:00-04:00\n\n**Research:** 2026-11-01';
  const result = presentPredictionMarkdown(source, { reviewKind: 'prediction-markets-review' });
  expect(result).toContain('**Settlement:** Oct 31, 2026 22:30 PDT');
  expect(result).toContain('**Close:** Nov 1, 2026 01:30 PST');
  expect(result).toContain('**Offset:** Oct 31, 2026 22:30 PDT');
  expect(result).toContain('**Research:** Nov 1, 2026');
  expect(result).not.toMatch(/\bET\b/);
});

test('venue sections and research tables remain intact in the daily prediction rollup', () => {
  const source = '# Predictive Markets Review\n\n<!-- analyst-prediction-research-rollup -->\n\n## Interactive Brokers\n\n### CPI\n\n#### Research\n\n| Metric | Current |\n|---|---|\n| Headline | 0.2% |\n\nSources: [Inflation Nowcast](citation://cpi-2026-09-18)\n\n## Kalshi\n\n### Ethereum\n\nTrade —. Trend Neutral.';
  const result = prepareAnalystMarkdown(source, { reviewKind: 'prediction-markets-review' });
  expect(result).toContain('## Interactive Brokers');
  expect(result).toContain('## Kalshi');
  expect(result).toContain('### Ethereum');
  expect(result).toContain('| Metric | Current |\n|---|---|\n| Headline | 0.2% |');
  expect(result).toContain('[Inflation Nowcast](citation://cpi-2026-09-18)');
  expect(result).not.toContain('# Predictive Markets Review');
});

test('saved prediction reviews omit complete macro sections while keeping CPI, sources and later assets', () => {
  const source = '## Sources\n\n[Macro Show](citation://macro-source)\n\n## CPI\n\n**Hedgeye nowcast:** 3.61%\n\n## Macro & regime\n\nQuad 4 commentary.\n\n### Details\n\nNested regime evidence.\n\n## Macro Show\n\nMacro commentary.\n\n### Positions\n\nA source position.\n\n## Gold\n\n**Trade:** Bullish';
  const result = presentPredictionMarkdown(source, { reviewKind: 'prediction-markets-review' });
  expect(result).toBe('## Sources\n\n[Macro Show](citation://macro-source)\n\n## CPI\n\n**Hedgeye nowcast:** 3.61%\n\n## Gold\n\n**Trade:** Bullish');
  expect(presentPredictionMarkdown(result, { reviewKind: 'prediction-markets-review' })).toBe(result);
});

test.each(['## Macro & regime', '### Macro and regime', '#### **Macro Show**', '## The Macro Show ##'])('macro removal respects heading depth: %s', heading => {
  const source = `### CPI\n\nCPI analysis.\n\n${heading}\n\nMacro commentary.\n\n##### Detail\n\nMacro detail.\n\n## Kalshi\n\n### Silver\n\nSilver analysis.`;
  expect(presentPredictionMarkdown(source, { reviewKind: 'prediction-markets-review' }))
    .toBe('### CPI\n\nCPI analysis.\n\n## Kalshi\n\n### Silver\n\nSilver analysis.');
});

test('fenced headings do not start or end omitted macro sections', () => {
  const keptCode = '```text\n## Macro & regime\nLiteral heading example.\n```';
  const source = `### CPI\n\n${keptCode}\n\n## Macro & regime\n\nBefore code.\n\n~~~text\n## Gold\nNot an actual section boundary.\n~~~\n\nStill macro commentary.\n\n## Silver\n\nSilver analysis.`;
  expect(presentPredictionMarkdown(source, { reviewKind: 'prediction-markets-review' }))
    .toBe(`### CPI\n\n${keptCode}\n\n## Silver\n\nSilver analysis.`);
});

test('macro sections remain unchanged in ordinary chat and other review kinds', () => {
  const source = '## CPI\n\nCPI analysis.\n\n## Macro & regime\n\nQuad 4.\n\n## Macro Show\n\nMacro analysis.';
  for (const reviewKind of [undefined, 'portfolio-review', 'balance-review']) {
    expect(presentPredictionMarkdown(source, { reviewKind })).toBe(source);
  }
});

test.each(['Market drivers', "Today's market drivers", 'Today’s market drivers'])('saved prediction reports omit %s with its sources and preserve the next research section', title => {
  const source = `### S&P 500\n\n**Trend:** Bullish\n\n#### ${title}\n\nOld market commentary.\n\nSources: [Top 3 Things](citation://drivers)\n\n#### Trend & range changes\n\nS&P 500 · Trend: Neutral → Bullish\n\nSources: [Risk Ranges](citation://ranges)`;
  const result = presentPredictionMarkdown(source, { reviewKind: 'prediction-markets-review' });
  expect(result).not.toMatch(/market drivers|Old market commentary|citation:\/\/drivers/i);
  expect(result).toContain('S&P 500 · Trend: Neutral → Bullish');
  expect(result).toContain('[Risk Ranges](citation://ranges)');
  expect(presentPredictionMarkdown(result, { reviewKind: 'prediction-markets-review' })).toBe(result);
  expect(presentPredictionMarkdown(source, { reviewKind: 'portfolio-review' })).toBe(source);
});
