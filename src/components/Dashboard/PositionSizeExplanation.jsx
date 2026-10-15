import React from 'react';
import { VOLATILITY_BAND_POLICY as policy } from '../../utils/volatilitySizingBand.cjs';

const vol = value => `${(value * 100).toFixed(2)}%`;

export default function PositionSizeExplanation({ symbol, reference }) {
  const { band, rv } = reference;
  return (
    <div className="pcv2-sizing-explanation">
      <p><strong>{reference.available ? `${symbol}: ${reference.value} of NAV` : 'Size unavailable.'}</strong>{' '}
        {reference.available
          ? `Operating range based on adjusted closes through ${reference.asOf}.`
          : reference.reason}
      </p>
      <p><strong>Quick takeaway.</strong> Bigger price swings mean a smaller position; steadier prices allow a larger one.
        The range gives you room to add and trim while keeping the amount at risk more consistent across holdings.
        {reference.available && ` For ${symbol}, ${reference.value} means the share of your total portfolio allocated to it, not an expected return.`}
        {' '}The upper end is a limit, not a target you have to reach.
      </p>
      {symbol === 'OIH' && <p>
        OIH is an equity ETF holding oil-services companies. Its businesses are exposed to oil activity,
        but the fund owns stocks. We use OIH’s own returns to size it.{' '}
        <a href="https://www.vaneck.com/us/en/investments/oil-services-etf-oih/overview/" target="_blank" rel="noreferrer">Fund description</a>.
      </p>}
      <p><strong>Rule.</strong> Start with {policy.referenceMinPct}–{policy.referenceMaxPct}% of portfolio net asset value (NAV)
        at {policy.referenceVolatility * 100}% annual volatility. Multiply both ends by the same risk adjustment:
        {' '}lower = 2% × (20% ÷ effective volatility); upper = 6% × (20% ÷ effective volatility).
        The 20% reference is a fixed policy yardstick, not today’s market volatility.
      </p>
      {reference.available && <p><strong>{symbol} math.</strong>{' '}
        {reference.limitedHistory
          ? `63-day volatility = ${vol(rv.rv63)}; one-year history is unavailable, so the 63-day estimate is used (limited history).`
          : `63-day volatility = ${vol(rv.rv63)}; 252-day volatility = ${vol(rv.rv252)}; use the higher, ${vol(band.volatility)}.`}{' '}
        {band.floorApplied && `The 10% floor raises the sizing denominator to ${vol(band.effectiveVolatility)}. `}
        2% × (20% ÷ {vol(band.effectiveVolatility)}) = {band.minWeightPct.toFixed(2)}%;{' '}
        6% × (20% ÷ {vol(band.effectiveVolatility)}) = {band.maxWeightPct.toFixed(2)}%.
        {' '}The table displays {reference.value}; rounding is for readability, not a trade increment.
      </p>}
      <p><strong>Easy example.</strong> At 20% volatility the band is 2–6% (4 percentage points of room).
        At 10% it is 4–12% (8 points); at 40% it is 1–3% (2 points).
        Twice the volatility gets half the dollars. Both ends and the room between them scale together;
        asset-class labels do not assign a different risk budget.
      </p>
      <p><strong>What volatility means.</strong> Calculate each daily log return as ln(adjusted close ÷ prior adjusted close).
        Take the sample standard deviation over the last 63 and 252 returns, then multiply by √252 for exchange-traded
        securities (√365 for daily crypto). A 1.26% daily standard deviation is about 20% annualized.
        This measures fluctuations, not expected return or a maximum possible loss. Use the higher lookback to respond
        to increased risk while avoiding excessive size after a quiet quarter. At least 63 returns are required;
        fewer than 252 are explicitly marked as limited history.
      </p>
      <p><strong>Working the range.</strong> The lower end is a light active position and the upper end is a ceiling,
        not a required target. For a supported long, additions near the lower price risk range and trims near the
        upper price risk range can move the weight within this band; reverse the price locations for a short.
        Direction, Trade/Trend, and price risk ranges remain separate decisions. Zero is always allowed when a thesis
        fails. There is no forced minimum holding, automatic midpoint target, or automatic order.
      </p>
      <p><strong>Limits applied here.</strong> Effective volatility is the greater of measured volatility and 10%.
        This caps every operating band at 4–12% in very quiet assets. There is no upper clamp on volatility:
        more volatile assets continue to receive smaller bands. The same absolute band applies to a long or short;
        it does not imply equal tail risk. Refreshes use newly completed daily history, not intraday price moves.
      </p>
      <p><strong>Portfolio risk review.</strong> Above the 10% floor, this equalizes standalone weight × volatility, not each position’s
        contribution to total portfolio risk. Before trading, check correlated holdings, sector/theme concentration,
        gross/net exposure, available cash, liquidity, and event or gap risk. The bands are independent budgets:
        do not add them up as a fully invested target or increase them to use spare cash. ATR, stops, loss budgets, and correlations
        do not automatically reduce this displayed band. A separate loss check is position weight × adverse move:
        a 2% weight losing 25% costs 0.5% of NAV. A stop is not a guaranteed loss limit. Options and futures need
        contract-specific scenario sizing; leveraged/inverse ETFs use their own history.
      </p>
      <p><strong>Data and execution.</strong> Only sourced adjusted daily history for the latest completed session is
        accepted. Missing, stale, failed-refresh, cache-only, mock, or seeded inputs produce no band. Weekends and
        exchange holidays retain the latest completed session. Historical volatility is an estimate and can lag a
        regime change. These percentages are planning references; dollars, shares, and any trade still require
        verified live portfolio and quote data.
      </p>
      <p className="pcv2-sizing-explanation-source">
        Method: {policy.version}.{reference.available && ` Source: ${reference.source}. ${reference.observationCount.toLocaleString()} daily returns available; history fetched ${reference.fetchedAt}.`}
      </p>
    </div>
  );
}
