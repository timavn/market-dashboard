import { predictionReportTables } from './analystPredictionTables';
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
