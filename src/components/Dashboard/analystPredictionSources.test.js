import { predictionReportSources } from './analystPredictionSources';

const crypto = { id: 'crypto-current', product: 'crypto-tracker', title: 'Crypto Tracker — Sep 18', excerpt: 'Bitcoin bullish; Ethereum neutral.' };
const previous = { id: 'crypto-prior', product: 'crypto-tracker', title: 'Crypto Tracker — Sep 17', excerpt: 'Bitcoin neutral.' };
const metals = { id: 'metals-current', product: 'metals-tracker', title: 'Metals Tracker — Sep 18' };

test('each section shows a product once and keeps its own cited publications in the evidence popup', () => {
  const markdown = '## Kalshi\n\n### Bitcoin\n\nTrade Bullish.\n\nSources: [Crypto Tracker](citation://crypto-current), [Crypto Tracker](citation://crypto-prior)\n\n### Ethereum\n\nTrend Neutral.\n\nSources: [Crypto Tracker](citation://crypto-current)';
  const result = predictionReportSources(markdown, [crypto, previous]);
  expect(result.markdown.match(/\[Crypto Tracker\]/g)).toHaveLength(2);
  const groups = [...result.links.values()];
  expect(groups).toHaveLength(2);
  expect(groups[0]).toMatchObject({ source: crypto, context: { relatedSources: [crypto, previous] } });
  expect(groups[1]).toMatchObject({ source: crypto, context: {} });
  expect(result.remaining).toEqual([]);
  expect(markdown).toContain('citation://crypto-prior');
});

test('legacy unlinked publications retain all evidence without changing the saved asset roster or venue', () => {
  const markdown = '### Silver\n\n**Venue:** ForecastEx\n\n**Trade:** Bearish';
  const result = predictionReportSources(markdown, [crypto, previous, metals]);
  expect(result.markdown).toBe(markdown);
  expect(result.links.size).toBe(0);
  expect(result.remaining.map(group => group.label)).toEqual(['Crypto Tracker', 'Metals Tracker']);
  expect(result.remaining[0].context.relatedSources).toEqual([crypto, previous]);
  expect(result.markdown).not.toMatch(/Kalshi|Ethereum/);
});

test('known bare citation ids can become source links while unknown or mixed public evidence is preserved', () => {
  const legacy = predictionReportSources('Sources: [crypto-current], [crypto-prior]', [crypto, previous]);
  expect(legacy.markdown).toBe('Sources: [Crypto Tracker](citation://group-0)');
  expect(legacy.links.get('citation://group-0').context.relatedSources).toEqual([crypto, previous]);
  const mixed = 'Sources: [Crypto Tracker](citation://crypto-current), [Exchange](https://kalshi.com/markets), [unrecognized-id]';
  const result = predictionReportSources(mixed, [crypto, previous]);
  expect(result.markdown).toBe('Sources: [Crypto Tracker](citation://group-0), [Exchange](https://kalshi.com/markets), [unrecognized-id]');
  expect(result.links.get('citation://group-0').source).toBe(crypto);
  expect(result.remaining.map(group => group.source)).toEqual([previous]);
});

test('unknown citation links become plain labels and never point at invented evidence', () => {
  const result = predictionReportSources('Sources: [Crypto Tracker](citation://missing)', null);
  expect(result.markdown).toBe('Sources: Crypto Tracker');
  expect(result.links.size).toBe(0);
  expect(result.remaining).toEqual([]);
});

test('duplicate imports of the same citation do not repeat its publication', () => {
  const result = predictionReportSources('Sources: [Crypto Tracker](citation://crypto-current), [Crypto Tracker](citation://crypto-current)', [crypto, crypto]);
  expect([...result.links.values()]).toEqual([{ label: 'Crypto Tracker', source: crypto, context: {} }]);
});

test('an asset footer follows all contract and nested research rows and groups every cited publication', () => {
  const markdown = `## Kalshi

### Bitcoin

**Trade:** Bullish · BTC · [Source](https://app.hedgeye.com/feed_items/123)  
**Alpha codes:** Trade 100 · Trend 90 · Sources: [Crypto Tracker](citation://crypto-current)  

Sources: [Crypto Tracker](citation://crypto-current)

| Level | Price |
| --- | --- |
| Current strike | 40¢ |

#### Trend & range changes

BTC · Trend: Neutral → Bullish · [Crypto Tracker](citation://crypto-prior)

Sources: [Crypto Tracker](citation://crypto-prior)

#### Positioning

BTC · Long

### Ethereum

**Trend:** Neutral · ETH

Sources: [Crypto Tracker](citation://crypto-current)`;
  const result = predictionReportSources(markdown, [crypto, previous]);
  const [bitcoin, ethereum] = result.markdown.split('### Ethereum');
  expect(bitcoin).toContain('**Trade:** Bullish · BTC  \n');
  expect(bitcoin).toContain('**Alpha codes:** Trade 100 · Trend 90  \n');
  expect(bitcoin).toContain('BTC · Trend: Neutral → Bullish\n');
  expect(bitcoin.match(/Sources:/g)).toHaveLength(1);
  expect(bitcoin.indexOf('Sources:')).toBeGreaterThan(bitcoin.indexOf('BTC · Long'));
  expect(bitcoin.indexOf('[Source](https://app.hedgeye.com/feed_items/123)')).toBeGreaterThan(bitcoin.indexOf('| Current strike | 40¢ |'));
  expect(ethereum).toContain('Sources: [Crypto Tracker]');
  expect([...result.links.values()].map(group => group.context)).toEqual([{ relatedSources: [crypto, previous] }, {}]);
  expect(result.remaining).toEqual([]);
});

test('legacy asset headings keep analytical public links and unknown source evidence intact', () => {
  const markdown = `## Bitcoin

**Trade:** Bullish · [Source](https://app.hedgeye.com/feed_items/123) · BTC  
Read the [contract rules](https://kalshi.com/markets/bitcoin) before settlement.

### Research

Trend unchanged.

Sources: [Unknown report](citation://not-captured), [unknown-raw-id], publisher commentary

## Ethereum

**Trend:** Neutral`;
  const result = predictionReportSources(markdown);
  expect(result.markdown).toContain('**Trade:** Bullish · BTC  ');
  expect(result.markdown).toContain('Read the [contract rules](https://kalshi.com/markets/bitcoin) before settlement.');
  expect(result.markdown).toContain('Sources: [Source](https://app.hedgeye.com/feed_items/123), Unknown report, [unknown-raw-id], publisher commentary');
  expect(result.markdown.indexOf('Sources:')).toBeGreaterThan(result.markdown.indexOf('Trend unchanged.'));
  expect(result.markdown.indexOf('Sources:')).toBeLessThan(result.markdown.indexOf('## Ethereum'));
  expect(result.links.size).toBe(0);
});

test('the final asset and Tick comparison retain separate evidence scopes', () => {
  const markdown = `### Bitcoin

**Trade:** Bullish · [Crypto Tracker](citation://crypto-current)

<details data-analyst-hedgai>
<summary>Tick comparison · 5 securities</summary>

| Ticker | Contribution |
| --- | --- |
| QQQ | Short excluded |

Sources: [crypto-prior]
</details>`;
  const result = predictionReportSources(markdown, [crypto, previous]);
  const [asset, disclosure] = result.markdown.split('<details data-analyst-hedgai>');
  expect(asset).toContain('Sources: [Crypto Tracker](citation://group-0)');
  expect(disclosure).toContain('Sources: [Crypto Tracker](citation://group-1)');
  expect([...result.links.values()].map(group => group.source)).toEqual([crypto, previous]);
  expect([...result.links.values()].every(group => !group.context.relatedSources)).toBe(true);
  expect(result.remaining).toEqual([]);
});

test('plain publisher attribution moves to the footer without changing named readings or section dates', () => {
  const markdown = `### CPI

[Sep 29, 2026](review-date://section-0)

**Hedgeye nowcast:** Lower 3.63% · Base 3.74% · Upper 3.85%  
**Cleveland Fed nowcast:** 3.57%  
**Previous CPI release:** 3.4% · Aug 2026 · BLS  
**Trading closes:** Oct 14, 2026 08:30 ET · ForecastEx · CME  
**Expiration:** Oct 14, 2026 08:30 ET`;
  const result = predictionReportSources(markdown);
  expect(result.markdown).toContain('[Sep 29, 2026](review-date://section-0)');
  expect(result.markdown).toContain('**Hedgeye nowcast:** Lower 3.63% · Base 3.74% · Upper 3.85%  ');
  expect(result.markdown).toContain('**Cleveland Fed nowcast:** 3.57%  ');
  expect(result.markdown).toContain('**Previous CPI release:** 3.4% · Aug 2026  ');
  expect(result.markdown).toContain('**Trading closes:** Oct 14, 2026 08:30 ET  ');
  expect(result.markdown).toMatch(/\*\*Expiration:\*\* Oct 14, 2026 08:30 ET\n\nSources: BLS, ForecastEx, CME$/);
  expect(result.links.size).toBe(0);
});

test.each(['Pyth - Gold', 'Pyth - Silver', 'CF Benchmarks'])('recorded Kalshi settlement attribution %s stays in the asset footer', settlement => {
  const result = predictionReportSources(`### Gold\n\n**Trading closes:** Sep 29, 2026 16:00 ET · Kalshi · ${settlement}  \n**Expiration:** Sep 29, 2026 16:30 ET\n**Reference:** Gold · USD · other analytical context`);
  expect(result.markdown).toContain('**Trading closes:** Sep 29, 2026 16:00 ET  \n');
  expect(result.markdown).toContain('**Expiration:** Sep 29, 2026 16:30 ET');
  expect(result.markdown).toContain('**Reference:** Gold · USD · other analytical context');
  expect(result.markdown).toMatch(new RegExp(`Sources: Kalshi, ${settlement}$`));
});

test('removing citations and legacy prose spacing never leaves a space before a comma', () => {
  const result = predictionReportSources('### S&P 500\n\nApple Inc. (AAPL) [Crypto Tracker](citation://crypto-current), Microsoft (MSFT) , and Amazon (AMZN).', [crypto]);
  expect(result.markdown).toContain('Apple Inc. (AAPL), Microsoft (MSFT), and Amazon (AMZN).');
  expect(result.markdown).toContain('Sources: [Crypto Tracker]');
  const captured = predictionReportSources('### S&P 500\n\nApple Inc. (AAPL) , Microsoft (MSFT).');
  expect(captured.markdown).toBe('### S&P 500\n\nApple Inc. (AAPL), Microsoft (MSFT).');
});
