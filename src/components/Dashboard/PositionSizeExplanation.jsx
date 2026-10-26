import React from 'react';
import { ATR_FLOOR, SIZING_CONSTANTS as c } from '../../utils/signalWeightedPositionSizing';

const pct = (value, digits = 2) => `${value.toFixed(digits)}%`;
const floorPct = pct(ATR_FLOOR * 100);

export default function PositionSizeExplanation({ symbol, reference }) {
  const atrPct = reference.available ? reference.relativeAtr * 100 : null;
  const sizingStopPct = reference.available ? c.STOP_ATR_MULTIPLE * Math.max(atrPct, ATR_FLOOR * 100) : null;
  return (
    <div className="pcv2-sizing-explanation">
      <p><strong>{reference.available ? `${symbol}: ${reference.value} of NLV` : 'Size unavailable.'}</strong>{' '}
        {reference.available
          ? `Operating range based on completed daily bars through ${reference.asOf}.`
          : reference.reason}
      </p>
      <p><strong>Quick takeaway.</strong> Bigger daily moves mean a smaller position; steadier prices allow a larger one.
        Each range is set so that a stop two ATRs away costs about the same share of the portfolio for every holding.
        {reference.available && ` For ${symbol}, ${reference.value} is the share of your total portfolio allocated to it, not an expected return.`}
        {' '}The upper end is a limit, not a target you have to reach.
      </p>
      <p><strong>Rule.</strong> ATR % = 14-day ATR ÷ last close, floored at {floorPct}. Stop distance = {c.STOP_ATR_MULTIPLE} × ATR %.
        {' '}MIN = {pct(c.MIN_STOP_LOSS_PCT_NLV, 3)} ÷ stop distance; MAX = {pct(c.MAX_STOP_LOSS_PCT_NLV)} ÷ stop distance.
        {' '}So a stop-out costs about {pct(c.MIN_STOP_LOSS_PCT_NLV, 3)} of NLV at MIN and {pct(c.MAX_STOP_LOSS_PCT_NLV)} at MAX.
        The same equations apply to every asset class; there is no beta or asset-class adjustment.
      </p>
      {reference.available && <p><strong>{symbol} math.</strong>{' '}
        ATR {reference.atr14.value.toFixed(2)} ÷ close {reference.referencePrice.value.toFixed(2)} = {pct(atrPct)}.{' '}
        {reference.floorApplied && `That is below the ${floorPct} floor, so the floor sets the band. `}
        Stop distance = {c.STOP_ATR_MULTIPLE} × {pct(reference.floorApplied ? ATR_FLOOR * 100 : atrPct)} = {pct(sizingStopPct)}.{' '}
        {pct(c.MIN_STOP_LOSS_PCT_NLV, 3)} ÷ {pct(sizingStopPct)} rounds up to {pct(reference.minWeight)};{' '}
        {pct(c.MAX_STOP_LOSS_PCT_NLV)} ÷ {pct(sizingStopPct)} rounds down to {pct(reference.maxWeight)}.
        {' '}The reference stop is {pct(reference.stopDistance * 100)} from the entry price.
      </p>}
      <p><strong>Easy example.</strong> At 2% ATR the stop is 4% away and the band is 3.25–6.25%.
        At 4% ATR the stop is 8% away and the band is 1.75–3.00%; at 8% it is 1.00–1.50%.
        Twice the volatility gets half the dollars, so the loss at the stop stays level.
      </p>
      <p><strong>Limits applied here.</strong> ATR below {floorPct} of price is raised to the floor for sizing, which caps
        every band at {pct(c.MAX_POSITION_WEIGHT * c.MIN_STOP_LOSS_PCT_NLV / c.MAX_STOP_LOSS_PCT_NLV, 0)}–{pct(c.MAX_POSITION_WEIGHT, 0)} in very quiet assets. The stop still
        uses the measured ATR, so those positions risk less. Limits move in {pct(c.WEIGHT_INCREMENT)} steps.
        The same band applies to a long or a short.
      </p>
      <p><strong>Stops.</strong> A held position&apos;s reference stop is {c.STOP_ATR_MULTIPLE} × ATR from its IBKR average cost
        (below it for a long, above it for a short). A stop is a trigger, not a guaranteed loss limit: an overnight gap
        can fill beyond it. No stop order is created here.
      </p>
      <p><strong>Portfolio risk review.</strong> Each band is a standalone budget. It does not account for correlated
        holdings, sector or theme concentration, gross/net exposure, cash, liquidity, or event risk. Options and futures
        need contract-specific scenario sizing; leveraged/inverse ETFs use their own history.
      </p>
      <p><strong>Data and execution.</strong> Only sourced daily history for the latest completed session is accepted.
        Missing, stale, failed-refresh, cache-only, mock, or seeded inputs produce no band. ATR is a 14-day estimate and
        can lag a regime change. These percentages are planning references; dollars, shares, and any trade still require
        verified live portfolio and quote data.
      </p>
      <p className="pcv2-sizing-explanation-source">
        Method: Position Sizing v2.0 (ATR).{reference.available && ` Source: ${reference.source}. ATR through ${reference.atr14.asOf}.`}
      </p>
    </div>
  );
}
