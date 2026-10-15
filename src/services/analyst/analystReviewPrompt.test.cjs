const test = require('node:test');
const assert = require('node:assert/strict');
const { reviewNarrativePrompt } = require('./analystReviewPrompt.cjs');

test('supporting dashboard reads avoid duplicate live acquisition while required individual tools remain explicit', () => {
  for (const kind of ['portfolio-review', 'prediction-markets-review']) {
    const prompt = reviewNarrativePrompt(kind, 'Captured evidence');
    assert.match(prompt, /get_dashboard_context with include_live_channels=false for supporting context only/);
    assert.match(prompt, /get_portfolio_context/);
    assert.match(prompt, /get_process_context/);
    assert.match(prompt, /before making current claims/);
    assert.ok(prompt.endsWith('Captured evidence'));
  }
  const prediction = reviewNarrativePrompt('prediction-markets-review', '');
  assert.match(prediction, /get_prediction_market_snapshot with review_universe=true/);
  assert.match(prediction, /get_balance_context/);
  assert.doesNotMatch(reviewNarrativePrompt('balance-review', ''), /get_dashboard_context/);
});

test('balance narrative asks for additional evidenced issues, without a second account recap', () => {
  const prompt = reviewNarrativePrompt('balance-review', '# Balance Review\nDated evidence', '2026-09-17');
  assert.match(prompt, /additional issues only/);
  assert.match(prompt, /## Balance issues/);
  assert.match(prompt, /at most 150 words/);
  assert.match(prompt, /not already stated in Exceptions & Data Status/);
  assert.match(prompt, /concrete discrepancy, financial risk, or data\/API\/technical failure/);
  assert.doesNotMatch(prompt, /Lead with verified net liquidation|start with ## Review notes|Limit the response to 600 words/);
  assert.match(prompt, /last exchange trading day was 2026-09-17/);
  assert.ok(prompt.endsWith('# Balance Review\nDated evidence'));
});

test('balance issue assessment preserves source gates and requires evidence before calling short costs excessive', () => {
  const prompt = reviewNarrativePrompt('balance-review', '');
  for (const tool of ['get_balance_context', 'get_portfolio_context', 'get_process_context']) assert.ok(prompt.includes(tool));
  assert.match(prompt, /Never describe short exposure or negative accrued interest alone as excessive/);
  assert.match(prompt, /verified fees, rates, comparisons, or an explicit policy breach/);
  assert.match(prompt, /Disconnected, stale, cache-only, seeded, or mock evidence is unavailable/);
  assert.match(prompt, /do not claim an all-clear when checks are incomplete/);
  assert.match(prompt, /Use only code-computed sizing/);
});

test('other review kinds retain their existing narrative format', () => {
  for (const kind of ['portfolio-review']) {
    const prompt = reviewNarrativePrompt(kind, 'Evidence');
    assert.match(prompt, /start with ## Review notes/);
    assert.doesNotMatch(prompt, /## Balance issues/);
  }
});

test('portfolio and prediction narratives call the shortest captured signal Tick while preserving HedgAI attribution', () => {
  for (const kind of ['portfolio-review', 'prediction-markets-review']) {
    const prompt = reviewNarrativePrompt(kind, '');
    assert.match(prompt, /Tick is the separately captured shortest-horizon signal before Trade and Trend, sourced from HedgAI/);
    assert.match(prompt, /retain HedgAI as the publication name in Sources/);
    assert.match(prompt, /qualify independently at 60%/);
    assert.match(prompt, /only the saved review's captured Tick evidence, never later publications/);
    assert.match(prompt, /Preserve source ETF proxy identities and the capture date/);
    assert.match(prompt, /explicit Wait is displayed as Wait/);
    assert.match(prompt, /Wait and Watch means no directional call; never relabel it Neutral/);
    assert.doesNotMatch(prompt, /Wait is Neutral/);
    assert.match(prompt, /Historical statistics never gate the published Tick bias/);
    assert.match(prompt, /historical or unverified captures remain unavailable/);
    assert.match(prompt, /Never infer Bullish or Bearish from Wait/);
    assert.match(prompt, /not a forecast probability/);
    assert.match(prompt, /or change contract odds, selected direction, strike comparisons, sizing or scoring from Tick/);
  }
  assert.doesNotMatch(reviewNarrativePrompt('balance-review', ''), /Tick|HedgAI/);
});

test('prediction narrative is analytical and keeps diagnostics out of the manager report', () => {
  const prompt = reviewNarrativePrompt('prediction-markets-review', 'Verified dated evidence');
  for (const value of ['portfolio manager', 'Trade and Trend', 'Risk Range', 'immediately adjacent strike', 'structured managerView', 'at most 300 words']) assert.ok(prompt.includes(value));
  assert.match(prompt, /Never include Missing data or Missing evidence sections/);
  assert.match(prompt, /Keep diagnostics internal/);
  assert.match(prompt, /use an em dash/);
  assert.match(prompt, /Sep 25, 2026 at 14:00 PDT/);
  assert.match(prompt, /Never print UTC or ISO timestamps/);
  assert.doesNotMatch(prompt, /under ## Missing data|Use visible bullets for actions and missing evidence|start with ## Review notes/);
  assert.ok(prompt.endsWith('Verified dated evidence'));
});

test('prediction daily research follows the requested venues and preserves product and asset authority', () => {
  const prompt = reviewNarrativePrompt('prediction-markets-review', '');
  assert.match(prompt, /same seven pinned monitors/);
  assert.match(prompt, /Interactive Brokers with CPI and S&P 500 on ForecastEx, then Kalshi with Nasdaq-100, Gold, Silver, Bitcoin, and Ethereum/);
  assert.match(prompt, /same dated research approach as Portfolio Review/);
  assert.match(prompt, /forward scenarios as distinct from current signals/);
  assert.match(prompt, /captured Bitcoin Tracker and Crypto Quant research/);
  assert.match(prompt, /never transfer Bitcoin-only evidence to Ethereum/);
  assert.match(prompt, /Crypto Quant commentary alone does not establish Trade or Trend/);
  assert.match(prompt, /Preserve the immutable publication capture for a saved review/);
  assert.match(prompt, /comma-separated Sources links/);
  assert.doesNotMatch(prompt, /eight pinned monitors|including Nasdaq 100 on ForecastEx/);
});

test('prediction interpretation retains verification and distinguishes quoted odds from an estimated probability', () => {
  const prompt = reviewNarrativePrompt('prediction-markets-review', '');
  for (const tool of ['get_prediction_market_snapshot', 'get_portfolio_context', 'get_balance_context', 'get_dashboard_context', 'get_process_context']) assert.ok(prompt.includes(tool));
  assert.match(prompt, /review_universe=true and no other selectors/);
  assert.match(prompt, /withhold sizing when required evidence is unavailable/);
  assert.match(prompt, /Disconnected, stale, cache-only, seeded, or mock inputs cannot support current quotes/);
  assert.match(prompt, /never invent a substitute/);
  assert.match(prompt, /not an independently estimated chance of success/);
  assert.match(prompt, /never manufacture a NO quote from YES/);
  assert.match(prompt, /do not skip an unquoted strike/);
  assert.match(prompt, /gross payout\/risk before fees/);
  assert.match(prompt, /Use only code-computed sizing/);
});

test('prediction signal comparisons require two published directions and never treat absent Trade as conflict', () => {
  const prompt = reviewNarrativePrompt('prediction-markets-review', '');
  assert.match(prompt, /agreement or disagreement only when both have independently verified published directions/);
  assert.match(prompt, /same underlying research instrument; preserve each publication date/);
  assert.match(prompt, /em-dash Trade is unknown, not Neutral and not evidence of agreement, disagreement, conflict, or a failed setup/);
  assert.match(prompt, /When only Trend is published, interpret that evidenced Trend directly, identify it as Trend, and omit commentary about the missing Trade/);
  assert.match(prompt, /A published Neutral is a distinct signal state, not a missing signal/);
});

test('prediction interpretation preserves reward-risk and current-strike reference bases', () => {
  const prompt = reviewNarrativePrompt('prediction-markets-review', '');
  assert.match(prompt, /managerView\.riskRange\.rewardRisk\.basisLabel and referenceValue/);
  assert.match(prompt, /Never attribute a CLX26 reward\/risk calculation to WBSX26, an SPX Risk Range to ES, or a COMPQ Risk Range to NDX/);
  assert.match(prompt, /only an exact comparable settlement reference can locate the nearest current strike/);
  assert.match(prompt, /quoted_level as a quoted level and last_close as near last close, never as near a current live price/);
});

test('prediction narrative omits recaps and missing-signal process conclusions', () => {
  const prompt = reviewNarrativePrompt('prediction-markets-review', '');
  assert.match(prompt, /do not describe missing Trade, unavailable sizing, failed process gates, or a lack of setups/);
  assert.match(prompt, /Do not add a Portfolio stance section or a closing process-status summary/);
  assert.match(prompt, /do not recap Trade\/Trend rows, underlying prices, ranges, asks, odds, or payoffs already displayed/);
  assert.match(prompt, /Omit an asset when its paragraph would only repeat those facts/);
  assert.match(prompt, /return an empty response without an explanation or status message/);
  for (const kind of ['portfolio-review', 'balance-review']) {
    assert.doesNotMatch(reviewNarrativePrompt(kind, ''), /Portfolio stance|failed process gates|em-dash Trade is unknown|managerView\.riskRange/);
  }
});

test('prediction missing-data and diagnostic presentation rules do not alter other review kinds', () => {
  for (const kind of ['portfolio-review', 'balance-review']) {
    const prompt = reviewNarrativePrompt(kind, 'Evidence');
    assert.doesNotMatch(prompt, /aggregate Partial|Monitored markets|## Missing data|Never echo provider or client/);
  }
  assert.match(reviewNarrativePrompt('balance-review', ''), /concrete discrepancy, financial risk, or data\/API\/technical failure/);
});


test('every review narrative uses California local instants while preserving date-only source dates', () => {
  for (const kind of ['balance-review', 'portfolio-review', 'prediction-markets-review']) {
    const report = 'Captured publication date 2026-09-25; original observation 2026-09-25T21:00:00Z.';
    const prompt = reviewNarrativePrompt(kind, report);
    assert.match(prompt, /California local time \(America\/Los_Angeles\)/);
    assert.match(prompt, /PST in standard time and PDT in daylight time with 24-hour HH:mm/);
    assert.match(prompt, /Convert evidenced UTC or other zoned instants/);
    assert.match(prompt, /never merely relabel their clock time/);
    assert.match(prompt, /Preserve date-only publication and market-session dates/);
    assert.match(prompt, /without adding an invented time or shifting the source date/);
    assert.match(prompt, /Never print UTC or ISO timestamps in the review/);
    assert.doesNotMatch(prompt, /include 24-hour time and ET|at 17:00 ET/);
    assert.ok(prompt.endsWith(report));
  }
});
