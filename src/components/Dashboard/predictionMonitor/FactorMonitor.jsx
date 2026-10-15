import React from 'react';
import { finite } from './monitorNumbers';
import { MARKET_UI } from './marketUi';
import { isSpxMonitorSectionUsable } from './monitorSectionValidation';
import GenericFactorMonitor from './GenericFactorMonitor';
import CpiSourceMonitor from './CpiSourceMonitor';
import HedgaiResearchRow from './HedgaiResearchRow';
import {
  CompoundFactorValue, FactorRow, factorToken, factorDirectionTone, factorSignTone,
  factorCorrelationTone, factorRelativeTone, factorVolatilityTone,
  formatFactorNumber, formatSignedFactorNumber,
} from './factorPresentation';

const FactorMonitor = ({ snapshot, nowMs, refreshDelayed, marketId = 'sp500', marketUi = MARKET_UI.sp500 }) => {
  if (marketId === 'cpi') {
    return <CpiSourceMonitor snapshot={snapshot} refreshDelayed={refreshDelayed} nowMs={nowMs} />;
  }
  if (marketId !== 'sp500') {
    return (
      <GenericFactorMonitor
        snapshot={snapshot}
        refreshDelayed={refreshDelayed}
        marketUi={marketUi}
      />
    );
  }
  const factors = snapshot?.factors || {};
  const riskRange = snapshot?.riskRange;
  const trade = snapshot?.publishedResearch?.trade || factors.trade;
  const trendRange = snapshot?.publishedResearch?.riskRange || riskRange;
  const usable = (factor) => isSpxMonitorSectionUsable(factor, nowMs);
  const dxyAvailable = usable(factors.dxy);
  const usdAvailable = usable(factors.usd);
  const cftcAvailable = usable(factors.cftc);
  const gammaAvailable = usable(factors.gamma);
  const gammaMetricUsable = usable({
    ...factors.gamma,
    status: factors.gamma?.metricStatus || factors.gamma?.status,
    expiresAt: factors.gamma?.metricExpiresAt || factors.gamma?.expiresAt,
  });
  const gammaLevelsAvailable = usable(factors.gammaLevels);
  const spyAvailable = usable(factors.spyVolume);
  const vixAvailable = usable(factors.vix);
  const vvixAvailable = usable(factors.vvix);
  const tradeAvailable = usable(trade);
  const rangeAvailable = usable(riskRange);
  const trendAvailable = usable(trendRange);
  const tradeDirection = tradeAvailable && factorToken(trade?.direction)
    ? factorToken(trade.direction)
    : null;
  const trendDirection = trendAvailable && factorToken(trendRange?.trend)
    ? factorToken(trendRange.trend)
    : null;
  const gateAvailable = Boolean(tradeDirection || trendDirection);
  const gateComplete = Boolean(tradeDirection && trendDirection);
  const gateValue = gateAvailable
    ? (
      <CompoundFactorValue
        separator=" / "
        values={[
          { key: 'trade', value: tradeDirection || '—', tone: factorDirectionTone(tradeDirection) },
          { key: 'trend', value: trendDirection || '—', tone: factorDirectionTone(trendDirection) },
        ]}
      />
    )
    : '—';
  const cftcValue = cftcAvailable ? (
    <CompoundFactorValue
      separator=" / "
      values={[
        { key: '1y', value: formatSignedFactorNumber(factors.cftc?.zScore1Y), tone: factorSignTone(factors.cftc?.zScore1Y) },
        { key: '3y', value: formatSignedFactorNumber(factors.cftc?.zScore3Y), tone: factorSignTone(factors.cftc?.zScore3Y) },
      ]}
    />
  ) : '—';
  const gammaThrottlePresent = finite(factors.gamma?.throttle);
  const realizedVolPresent = finite(factors.gamma?.realizedVol10d);
  const gammaMetricsAvailable = gammaMetricUsable && (gammaThrottlePresent || realizedVolPresent);
  const gammaMetricsComplete = gammaThrottlePresent && realizedVolPresent;
  const gammaMetricsValue = gammaMetricsAvailable ? (
    <CompoundFactorValue
      separator=" / "
      values={[
        {
          key: 'throttle',
          value: gammaThrottlePresent ? formatSignedFactorNumber(factors.gamma.throttle) : '—',
          tone: factorSignTone(factors.gamma?.throttle),
        },
        {
          key: 'rvol',
          value: realizedVolPresent ? formatFactorNumber(factors.gamma.realizedVol10d) : '—',
          tone: realizedVolPresent ? 'neutral' : 'unavailable',
        },
      ]}
    />
  ) : '—';
  const gammaLevelsValue = gammaLevelsAvailable ? (
    <CompoundFactorValue
      separator=" · "
      values={[
        { key: 'zero', value: `Flip ${formatFactorNumber(factors.gammaLevels?.zeroGamma, 0)}`, tone: finite(factors.gammaLevels?.zeroGamma) ? 'neutral' : 'unavailable' },
        {
          key: 'pv',
          value: `PV ${formatFactorNumber(factors.gammaLevels?.lowerPvBand, 0)}–${formatFactorNumber(factors.gammaLevels?.upperPvBand, 0)}`,
          tone: 'neutral',
        },
      ]}
    />
  ) : '—';
  const eventTicker = snapshot?.contracts?.event?.ticker || snapshot?.selectedGenerationId || 'KXINXU';
  const selectedVenueId = snapshot?.selectedVenueId || snapshot?.displaySelection?.venueId || 'auto';
  const factorRows = [
    {
      label: 'DXY · LAST CLOSE',
      value: formatFactorNumber(factors.dxy?.value, 2),
      source: factors.dxy?.source, asOf: factors.dxy?.asOf, available: dxyAvailable,
      detail: factors.dxy?.reason,
      valueTone: 'neutral',
      refreshDelayed: Boolean(factors.dxy?.refreshIssue),
      referenceStatus: factors.dxy?.status,
    },
    {
      label: 'USD CORR · SPX/DXY 30D',
      value: formatFactorNumber(factors.usd?.r30),
      source: factors.usd?.source, asOf: factors.usd?.asOf, available: usdAvailable,
      detail: factors.usd?.reason,
      valueTone: factorCorrelationTone(factors.usd?.r30),
      refreshDelayed: Boolean(factors.usd?.refreshIssue),
      referenceStatus: factors.usd?.status,
    },
    {
      label: 'CFTC · E-MINI · 1Y / 3Y Z',
      value: cftcValue,
      source: factors.cftc?.source, asOf: factors.cftc?.asOf, available: cftcAvailable,
      detail: cftcAvailable
        ? [
            finite(factors.cftc?.latest) ? `Net ${formatSignedFactorNumber(factors.cftc.latest, 0)}` : null,
            finite(factors.cftc?.weeklyChange) ? `W/W ${formatSignedFactorNumber(factors.cftc.weeklyChange, 0)}` : null,
            'Positioning context only; it does not add points.',
          ].filter(Boolean).join(' · ')
        : factors.cftc?.reason,
      unavailableValue: 'NOT VERIFIED',
      unavailableAsOf: factors.cftc?.date,
      refreshDelayed: Boolean(factors.cftc?.refreshIssue),
      referenceStatus: factors.cftc?.status,
    },
    {
      label: 'DEALER GAMMA · EXPOSURE',
      value: String(factors.gamma?.value || '').toUpperCase(),
      source: factors.gamma?.source, asOf: factors.gamma?.asOf, available: gammaAvailable,
      detail: factors.gamma?.reason,
      valueTone: factorDirectionTone(factors.gamma?.value),
      refreshDelayed: Boolean(factors.gamma?.refreshIssue),
      referenceStatus: factors.gamma?.status,
    },
    {
      label: 'GAMMA THROTTLE / 10D RVOL',
      value: gammaMetricsValue,
      source: factors.gamma?.metricSource || factors.gamma?.source,
      asOf: factors.gamma?.metricAsOf || factors.gamma?.asOf,
      available: gammaMetricsAvailable,
      partial: gammaMetricsAvailable && !gammaMetricsComplete,
      detail: gammaMetricsAvailable
        ? 'Source-dated Market Situation Report context; no independent point threshold is defined.'
        : 'The current Market Situation Report did not publish verified Gamma Throttle / 10D RVOL metrics.',
      unavailableValue: 'UNAVAILABLE',
      unavailableAsOf: factors.gamma?.asOf,
      refreshDelayed: Boolean(factors.gamma?.refreshIssue),
      referenceStatus: factors.gamma?.status,
    },
    {
      label: 'GAMMA FLIP / PV BANDS',
      value: gammaLevelsValue,
      source: factors.gammaLevels?.source,
      asOf: factors.gammaLevels?.asOf,
      available: gammaLevelsAvailable,
      partial: gammaLevelsAvailable && ![factors.gammaLevels?.zeroGamma, factors.gammaLevels?.lowerPvBand, factors.gammaLevels?.upperPvBand].every(finite),
      detail: gammaLevelsAvailable
        ? [
            `Gamma flip: ${formatFactorNumber(factors.gammaLevels?.zeroGamma, 0)}`,
            `PV bands: ${formatFactorNumber(factors.gammaLevels?.lowerPvBand, 0)}–${formatFactorNumber(factors.gammaLevels?.upperPvBand, 0)}`,
            Array.isArray(factors.gammaLevels?.strikesInPlay) && factors.gammaLevels.strikesInPlay.length
              ? `Strikes in play: ${factors.gammaLevels.strikesInPlay.map((value) => formatFactorNumber(value, 0)).join(', ')}`
              : null,
            'Location context only; Risk Range remains the scored geometry model.',
          ].filter(Boolean).join(' · ')
        : factors.gammaLevels?.reason,
      unavailableValue: 'UNAVAILABLE',
      unavailableAsOf: factors.gamma?.asOf,
      refreshDelayed: Boolean(factors.gammaLevels?.refreshIssue),
      referenceStatus: factors.gammaLevels?.status,
    },
    {
      label: `SPY RTH VOLUME / 20D${factors.spyVolume?.status === 'historical' ? ' · LAST SESSION' : ''}`,
      value: finite(factors.spyVolume?.ratio) ? `${Number(factors.spyVolume.ratio).toFixed(2)}×` : '—',
      source: factors.spyVolume?.source, asOf: factors.spyVolume?.asOf, available: spyAvailable,
      detail: factors.spyVolume?.reason,
      valueTone: factorRelativeTone(factors.spyVolume?.ratio),
      refreshDelayed: Boolean(factors.spyVolume?.refreshIssue),
      referenceStatus: factors.spyVolume?.status,
    },
    {
      label: `VIX${factors.vix?.status === 'historical' ? ' · LAST CLOSE' : ''}`,
      value: formatFactorNumber(factors.vix?.value, 2),
      source: factors.vix?.source, asOf: factors.vix?.asOf, available: vixAvailable,
      detail: factors.vix?.reason,
      valueTone: factorVolatilityTone('VIX', factors.vix?.value),
      refreshDelayed: Boolean(factors.vix?.refreshIssue),
      referenceStatus: factors.vix?.status,
    },
    {
      label: `VVIX${factors.vvix?.status === 'historical' ? ' · LAST CLOSE' : ''}`,
      value: formatFactorNumber(factors.vvix?.value, 2),
      source: factors.vvix?.source, asOf: factors.vvix?.asOf, available: vvixAvailable,
      detail: factors.vvix?.reason,
      valueTone: factorVolatilityTone('VVIX', factors.vvix?.value),
      refreshDelayed: Boolean(factors.vvix?.refreshIssue),
      referenceStatus: factors.vvix?.status,
    },
    {
      label: 'TRADE / TREND GATE',
      value: gateValue,
      source: [tradeDirection ? trade?.source : null, trendDirection ? trendRange?.source : null]
        .filter(Boolean).join(' · '),
      detail: [
        tradeDirection ? null : `Trade unavailable: ${trade?.reason || 'No verified independent Trade publication.'}`,
        trendDirection ? null : `Trend unavailable: ${riskRange?.reason || 'No verified current Risk Range trend.'}`,
      ].filter(Boolean).join(' · '),
      asOf: tradeDirection ? trade?.asOf : trendRange?.asOf,
      available: gateAvailable,
      partial: gateAvailable && !gateComplete,
      refreshDelayed: Boolean(trade?.refreshIssue || trendRange?.refreshIssue),
      referenceStatus: trade?.status,
    },
    {
      label: 'CONTRACT / RR GEOMETRY',
      value: 'PER STRIKE',
      source: riskRange?.source, asOf: riskRange?.asOf, available: rangeAvailable,
      detail: riskRange?.reason,
      refreshDelayed: Boolean(riskRange?.refreshIssue),
      referenceStatus: riskRange?.status,
    },
  ];
  return (
    <section
      className="pm-spx-factor-panel"
      aria-label="SPX factor monitor"
      data-selected-venue={selectedVenueId}
      data-event-ticker={eventTicker || undefined}
    >
      <table className="pm-spx-factor-table">
        <thead>
          <tr><th>FACTOR</th><th>VALUE</th><th>MAX PTS</th><th>POINTS</th><th>AS OF</th></tr>
        </thead>
        <tbody>
          {factorRows.map((row) => (
            <React.Fragment key={row.label}>
            {row.label === 'TRADE / TREND GATE' && <HedgaiResearchRow reading={snapshot?.publishedResearch?.hedgai} />}
            <FactorRow
              {...row}
              refreshDelayed={refreshDelayed || row.refreshDelayed}
            />
            </React.Fragment>
          ))}
        </tbody>
      </table>
    </section>
  );
};

export default FactorMonitor;
