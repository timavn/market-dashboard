import { foldPredictionAlphaCode, onceAcrossPredictionResearch, pinPredictionDollar, predictionReportTables } from './analystPredictionTables';
import { predictionReportSources } from './analystPredictionSources';

test('CPI readings retain lower/base/upper together with publication and release dates at the right', () => {
  const markdown = `### CPI

**Hedgeye nowcast:** Lower 3.63% · Base 3.74% · Upper 3.85% · published Sep 29, 2026  
**Cleveland Fed nowcast:** 3.57% · published Sep 28, 2026  
**Previous CPI release:** 3.4% · Aug 2026 · BLS  
**CPI release:** Sep 2026 · Oct 14, 2026 08:30 ET
**Alpha codes:** —

| Level | Outcome | Side | Price | Market-implied odds |
| --- | --- | --- | --- | --- |
| Current strike | Above 3.6% | YES | 41¢ | 41% |`;
  const report = predictionReportTables(predictionReportSources(markdown).markdown);
  expect(report).toContain('| Metric | Reading | Date |');
  expect(report).toContain('| Hedgeye nowcast | Lower 3.63% · Base 3.74% · Upper 3.85% | Sep 29, 2026 |');
  expect(report).toContain('| Cleveland Fed nowcast | 3.57% | Sep 28, 2026 |');
  expect(report).toContain('| Previous CPI release | 3.4% | Aug 2026 |');
  expect(report).toContain('| CPI release | Sep 2026 | Oct 14, 2026 08:30 ET |');
  expect(report).toContain('| Alpha codes | — | — |');
  expect(report).toContain('| Current strike | > 3.6% | YES | 41¢ | 41% |');
  expect(report.trimEnd()).toMatch(/Sources: BLS$/);
  expect(markdown).toContain('**Previous CPI release:** 3.4% · Aug 2026 · BLS');
});

test('asset readings keep signal dates, initiation, proxies, last-close status and all captured values', () => {
  const markdown = `## Interactive Brokers
### S&P 500

**Tick:** Last known Long · SPY proxy · Sep 28, 2026 · initiated Sep 11, 2026 · historical batting 60.0% · 20 signals · W/L 1.33  
**Trade:** Bearish · SPX · Sep 17, 2026 · [Source](https://example.com/trade)  
**Trend:** Bullish · SPX · Sep 29, 2026  
**Underlying:** ESZ26 7,737.5 · Last close Sep 28, 2026  
**Risk Range:** 7,552–7,796 · SPX · Sep 29, 2026  
**Alpha codes:** Trade 7,600 · Trend 7,500 · Sep 21, 2026 · Sources: [Alpha](citation://alpha)
**Underlying reward/risk:** SPX 7,650 · Bullish · 1.5:1 · reward 2% · risk 1.3% · Last close Sep 28, 2026

| Level | Outcome | Side | Price | Market-implied odds |
| --- | --- | --- | --- | --- |
| Current strike | At or below 7,725 | NO | 41¢ | 41% |

**Trading closes:** Sep 30, 2026 16:00 ET · ForecastEx · CME  
**Expiration:** Oct 1, 2026 11:00 ET`;
  const report = predictionReportTables(predictionReportSources(markdown, [{ id: 'alpha', productLabel: 'Early Look' }]).markdown);
  expect(report).toContain('| Tick | Last known Long · SPY proxy · historical batting 60.0% · 20 signals · W/L 1.33 | Sep 28, 2026 · Initiated Sep 11, 2026 |');
  expect(report).toContain('| Trade | Bearish · SPX | Sep 17, 2026 |');
  expect(report).toContain('| Trend | Bullish · SPX | Sep 29, 2026 |');
  expect(report).toContain('| Underlying | ESZ26 7,737.5 · LAST CLOSE | Sep 28, 2026 |');
  expect(report).toContain('| Risk Range | 7,552–7,796 · SPX | Sep 29, 2026 |');
  expect(report).toContain('| Alpha codes | Trade 7,600 · Trend 7,500 | Sep 21, 2026 |');
  expect(report).toContain('| Underlying reward/risk | SPX 7,650 · Bullish · 1.5:1 · reward 2% · risk 1.3% · LAST CLOSE | Sep 28, 2026 |');
  expect(report).toContain('| Current strike | ≤ 7,725 | NO | 41¢ | 41% |');
  expect(report).toContain('| Trading closes | — | Sep 30, 2026 16:00 ET |');
  expect(report).toContain('| Expiration | — | Oct 1, 2026 11:00 ET |');
  expect(report.trimEnd()).toMatch(/Sources: \[Source\]\(https:\/\/example.com\/trade\), \[Early Look\]\(citation:\/\/group-0\), ForecastEx, CME$/);
});

test('trend/range rosters share a table without inventing tickers or dates for legacy security names', () => {
  const report = predictionReportTables(`### S&P 500
#### Trend & range changes
SPX · S&P 500 · Range: 7,550–7,765 → 7,552–7,796 · Trend: Bullish  

RSP · Invesco S&P 500 Equal Weight ETF · OutBucket Trend: Bearish · Since: Sep 3, 2026  
XAR · State Street SPDR S&P Aerospace & Defense ETF · OutBucket Trend: Bearish · Since: Jun 24, 2026
Gold Spot Price · Trend: Neutral → Bullish

Sources: [Risk Ranges](citation://group-0)
#### Company, catalyst & sector research
TSLA · Catalyst: Margin improvement · Sep 29, 2026`);
  expect(report).toContain('| Ticker | Security | Change | Date |');
  expect(report).toContain('| SPX | S&P 500 | Range: 7,550–7,765 → 7,552–7,796 · Trend: Bullish | — |');
  expect(report).toContain('| RSP | Invesco S&P 500 Equal Weight ETF | OutBucket Trend: Bearish | Since Sep 3, 2026 |');
  expect(report).toContain('| XAR | State Street SPDR S&P Aerospace & Defense ETF | OutBucket Trend: Bearish | Since Jun 24, 2026 |');
  expect(report).toContain('| — | Gold Spot Price | Trend: Neutral → Bullish | — |');
  expect(report).toContain('Sources: [Risk Ranges](citation://group-0)');
  expect(report).toContain('#### Company, catalyst & sector research\nTSLA · Catalyst: Margin improvement · Sep 29, 2026');
});

test('market structure preserves the full signal table, source dates and explanatory prose', () => {
  const prose = 'S&P 500 context: Trade is Bearish and Trend is Bullish. Gamma does not publish an executable price.';
  const report = predictionReportTables(`#### Market structure & flows
| Signal | As of | Reading |
| --- | --- | --- |
| SPX Gamma Exposure | Sep 29, 2026 | Neutral |
| Gamma Volatility Throttle | Sep 29, 2026 09:30 ET | -0.75 |
| SPY volume | Sep 28, 2026 | +10% |
| Gamma levels | — | — |

${prose}

Sources: [Signal Strength](citation://group-0)`);
  expect(report).toContain('| Signal | Reading | Date |');
  expect(report).toContain('| SPX Gamma Exposure | Neutral | Sep 29, 2026 |');
  expect(report).toContain('| Gamma Volatility Throttle | -0.75 | Sep 29, 2026 09:30 ET |');
  expect(report).toContain('| SPY volume | +10% | Sep 28, 2026 |');
  expect(report).toContain('| Gamma levels | — | — |');
  expect(report).toContain(prose);
});

test('older generated structure readings become tables while preserving unknown source observations', () => {
  const report = predictionReportTables(`#### Market structure & flows
SPX Gamma Exposure: Neutral  
Flow · Prior reading: 0 · Published observation: [Source level](https://example.org/research) · Change: — · Value 5: Additional recorded field  
Gamma · Positive · as of Sep 29, 2026 09:30 ET
Throttle · 2.73 · as of Sep 29, 2026 10:30 ET

Risk Range: SPX 7,552–7,796 (Sep 29, 2026). Published range context.`);
  expect(report).toContain('| SPX Gamma Exposure | Neutral | — |');
  expect(report).toContain('| Flow | Prior reading: 0 · Published observation: [Source level](https://example.org/research) · Change: — · Value 5: Additional recorded field | — |');
  expect(report).toContain('| Gamma | Positive | Sep 29, 2026 09:30 ET |');
  expect(report).toContain('| Throttle | 2.73 | Sep 29, 2026 10:30 ET |');
  expect(report).toContain('Risk Range: SPX 7,552–7,796 (Sep 29, 2026). Published range context.');
});

test.each([
  ['Above 3.6%', '> 3.6%'], ['At or above 3.6%', '≥ 3.6%'],
  ['Below 3.6%', '< 3.6%'], ['At or below 3.6%', '≤ 3.6%'],
  ['Greater than $100,000', '> $100,000'], ['Less than or equal to -2.5%', '≤ -2.5%'],
  ['Bullish Trend · At or below 7,725', 'Bullish Trend · ≤ 7,725'],
  ['Between 3.6% and 3.8%', 'Between 3.6% and 3.8%'],
])('native outcome %s retains its exact threshold inclusivity', (before, after) => {
  const report = predictionReportTables(`### CPI
| Level | Outcome | Side | Price | Market-implied odds | Gross reward/risk (before fees) |
| --- | --- | --- | --- | --- | --- |
| Next strike | ${before} | YES | — | — | — |`);
  expect(report).toContain(`| Next strike | ${after} | YES | — | — | — |`);
});

test('unavailable and delayed observations remain explicit without filling dates or values', () => {
  const report = predictionReportTables(`### Gold
**Underlying:** UNAVAILABLE
**Trade:** —
**Trend:** Bullish · GOLD · Sep 29, 2026
**Risk Range:** —
### Bitcoin
**Underlying:** DELAYED BTCUSD 100,001 (proxy) · as of Sep 29, 2026 10:35 ET`);
  expect(report).toContain('| Underlying | UNAVAILABLE | — |');
  expect(report).toContain('| Trade | — | — |');
  expect(report).toContain('| Risk Range | — | — |');
  expect(report).toContain('| Underlying | DELAYED BTCUSD 100,001 (proxy) | Sep 29, 2026 10:35 ET |');
});

test('ordinary prose, code, non-target sections and comparison disclosure remain untouched', () => {
  const markdown = `### S&P 500
The Sep 28, 2026 reversal preceded the next reading above 7,700.
[Report](https://example.com/Sep-28-2026)


\`\`\`
**Trade:** Bullish · SPX · Sep 29, 2026


\`\`\`
#### Company, catalyst & sector research
**Trade:** Bullish · SPX · Sep 29, 2026
<details data-analyst-hedgai>
<summary>Tick comparison</summary>
**Tick:** Long · SPY proxy · Sep 28, 2026
| Level | Outcome |
| --- | --- |
| Current strike | Above 100 |
</details>`;
  expect(predictionReportTables(markdown)).toBe(markdown);
});

test('display projection is idempotent and keeps unknown table date text as captured', () => {
  const report = predictionReportTables(`### Ethereum
**Underlying:** LIVE ETHUSD 4,100
#### Market structure & flows
| Signal | Reading | As of |
| --- | --- | --- |
| Gamma | Positive | exact date unknown |`);
  expect(report).toContain('| Gamma | Positive | exact date unknown |');
  expect(predictionReportTables(report)).toBe(report);
});

test('the US Dollar row shows once above the first section with its research; section boards keep their markets', () => {
  const header = '| Market | Tick | Trade | Trend | Alpha Code | Price and Risk Range | As of (PT) |\n| --- | --- | --- | --- | --- | --- | --- |';
  const dollar = '| REF(US Dollar;DXY) | BIAS(Bearish;;) | BIAS(Bullish;;) | BIAS(Bullish;;) | N/A | RR(100;103;101.9;2;) | ASOF(Oct 19 06:50;,;,;,) |';
  const research = { markets: [{ market: 'US Dollar', entries: [{ product: 'Early Look', context: 'We bought more USD via UUP' }] },
    { market: 'Gold', entries: [] }] };
  const markdown = ['## Metals', '', header, dollar, '| Gold | BIAS(Neutral;;) | BIAS(N/A;;) | BIAS(Bearish;;) | N/A | 4,100 | ASOF(;,;,;,) |', '',
    '```analyst-research', JSON.stringify(research), '```', '', '## Oil', '', header, dollar, '| WTI | x | x | x | x | x | x |', ''].join('\n');
  const pinned = pinPredictionDollar(markdown);
  const lines = pinned.split('\n');
  expect(lines.filter(line => line.startsWith('| REF(US Dollar'))).toHaveLength(1);
  expect(lines.slice(0, 4)).toEqual([...header.split('\n'), dollar, '']);
  expect(lines.slice(4, 7)).toEqual(['```analyst-research', JSON.stringify({ markets: [research.markets[0]] }), '```']);
  expect(pinned.split('## Metals')[1]).toContain(JSON.stringify({ markets: [{ market: 'Gold', entries: [] }] }));
  expect(pinned.split('## Oil')[1]).toContain('| WTI |');
  // Reports without a Dollar row are unchanged.
  expect(pinPredictionDollar('## Oil\n\nText')).toBe('## Oil\n\nText');
});

test('boards saved with an Alpha Code column carry the code in the range cell, with dots only on the range’s own instrument', () => {
  const saved = [
    '## Indices',
    '',
    '| Market | Tick | Trade | Trend | Alpha Code | Price and Risk Range | Structure (10d) | As of (PT) |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    '| Gold | BIAS(Neutral;;) | BIAS(N/A;;) | BIAS(Bearish;;) | ALPHA(4,180;4,120;above;above;;1;The Macro Show) | RR(4085;4199;4145;0;) | STRUCT(+;+1;-;-1;;;;0;) | ASOF(x) |',
    '| MKT(Nasdaq-100;COMPQ range) | BIAS(N/A;;) | BIAS(N/A;;) | BIAS(N/A;;) | ALPHA(29,500;;below;;;0;Top 3 Things) | RR(25979;26667;26703;0;) | N/A | ASOF(x) |',
    '| UST 2Y | BIAS(N/A;;) | BIAS(N/A;;) | BIAS(N/A;;) | N/A | RR(4.71;4.87;4.81;2;%) | N/A | ASOF(x) |',
    '',
  ].join('\n');
  expect(foldPredictionAlphaCode(saved).split('\n').slice(2, 7)).toEqual([
    '| Market | Tick | Trade | Trend | Price and Risk Range | Structure (10d) | As of (PT) |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    '| Gold | BIAS(Neutral;;) | BIAS(N/A;;) | BIAS(Bearish;;) | RR(4085;4199;4145;0;;4180;4120;1;1;The Macro Show) | STRUCT(+;+1;-;-1;;;;0;) | ASOF(x) |',
    '| MKT(Nasdaq-100;COMPQ range) | BIAS(N/A;;) | BIAS(N/A;;) | BIAS(N/A;;) | RR(25979;26667;26703;0;;29500;;0;0;Top 3 Things) | N/A | ASOF(x) |',
    '| UST 2Y | BIAS(N/A;;) | BIAS(N/A;;) | BIAS(N/A;;) | RR(4.71;4.87;4.81;2;%) | N/A | ASOF(x) |',
  ]);
  // A code whose market has no range bar keeps the captured layout.
  const unranged = saved.replace('RR(4085;4199;4145;0;)', '4,145');
  expect(foldPredictionAlphaCode(unranged)).toBe(unranged);
});

test('a sentence naming several markets reads once, under the first market that shows it in the review', () => {
  const happy = 'You should see how happy our subscribers who identify as Gold Bugs are with me about Bearish Gold & Silver!';
  const block = markets => ['```analyst-research', JSON.stringify({ markets }), '```'];
  const report = [
    '## Metals', ...block([
      { market: 'Gold', entries: [{ product: 'Early Look', time: '04:36', context: happy }, { product: 'Top 3 Things', time: '05:30', context: 'Gold still sucks' }] },
      { market: 'Silver', entries: [{ product: 'Early Look', time: '04:36', context: 'Don’t send them my Silver (SLV) shorts.' },
        { product: 'Early Look', time: '04:36', context: happy }] },
    ]),
    '## Crypto', ...block([
      // Only the shared sentence: the market says where it reads instead of Not mentioned.
      { market: 'Palladium', entries: [{ product: 'Early Look', time: '04:36', context: 'about Bearish Gold & Silver', source: happy }] },
      { market: 'Ethereum', entries: [] },
    ]),
  ].join('\n');
  const [metals, crypto] = onceAcrossPredictionResearch(report).split('\n').filter(line => line.startsWith('{')).map(JSON.parse);
  expect(metals.markets.map(row => row.entries.map(entry => entry.context))).toEqual([
    [happy, 'Gold still sucks'], ['Don’t send them my Silver (SLV) shorts.']]);
  // The same full sentence under a later section counts as a repeat even when its trimmed context differs.
  expect(crypto.markets).toEqual([{ market: 'Palladium', entries: [], mentionedWith: ['Gold'] }, { market: 'Ethereum', entries: [] }]);
  // The same words in another product or at another time are a separate mention.
  const other = block([{ market: 'Gold', entries: [{ product: 'Early Look', time: '04:36', context: happy }] },
    { market: 'Silver', entries: [{ product: 'The Call', time: '07:04', context: happy }] }]).join('\n');
  expect(onceAcrossPredictionResearch(other)).toBe(other.replace(/\n/g, '\n'));
});
