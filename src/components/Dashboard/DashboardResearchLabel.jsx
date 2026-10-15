import React from 'react';
import { formatOverviewPrice } from '../../utils/formatOverviewPrice';
import './DashboardResearchLabel.css';

const TREND_PRESENTATION = {
  BULLISH: { label: 'Bullish', arrow: '↑', tone: 'is-positive' },
  NEUTRAL: { label: 'Neutral', arrow: '→', tone: 'is-neutral' },
  BEARISH: { label: 'Bearish', arrow: '↓', tone: 'is-negative' },
};

const fieldProvenance = (reading, field) => {
  const provenance = reading?.[`${field}Evidence`] || reading;
  return {
    source: provenance?.source,
    date: provenance?.date,
    sourceUrl: provenance?.sourceUrl,
    referenceInstrument: provenance?.referenceInstrument || provenance?.sourceInstrument,
    basisRelationship: provenance?.basisRelationship,
    basisLabel: provenance?.basisLabel,
  };
};

const provenanceSuffix = ({ source, date, referenceInstrument, basisRelationship }) => (
  [source, date, basisRelationship || referenceInstrument].filter(Boolean).join(' · ')
);

const DashboardResearchLabel = ({
  label,
  children,
  reading = null,
  formatBound = formatOverviewPrice,
  showUnavailable = false,
  showName = true,
  tickFormat = 'compact',
}) => {
  const verified = reading?.verified === true;
  const tickPresentation = verified && reading.tickEvidence ? TREND_PRESENTATION[reading.tick] : null;
  const tick = tickPresentation && reading.tickEvidence.position === 'Wait'
    ? { label: 'Wait and Watch (no directional call)', displayLabel: 'Wait', arrow: '→', tone: 'is-neutral' }
    : tickPresentation;
  const tickReference = reading?.tickEvidence?.matchType === 'proxy' ? reading.tickEvidence.sourceTicker : null;
  const trend = verified ? TREND_PRESENTATION[reading.trend] : null;
  const trade = verified && reading.tradeEvidence ? TREND_PRESENTATION[reading.trade] : null;
  const hasRange = verified && Number.isFinite(reading.lrr) && Number.isFinite(reading.hrr)
    && reading.lrr <= reading.hrr;
  const trendProvenance = fieldProvenance(reading, 'trend');
  const tickProvenance = fieldProvenance(reading, 'tick');
  const tradeProvenance = fieldProvenance(reading, 'trade');
  const rangeProvenance = fieldProvenance(reading, 'range');
  const lower = hasRange ? formatBound(reading.lrr) : null;
  const upper = hasRange ? formatBound(reading.hrr) : null;
  const rangeBasis = rangeProvenance.basisLabel || reading?.basisLabel;
  const hasAnnotation = tick || trade || trend || hasRange || showUnavailable;

  return (
    <span className="dashboard-research-label">
      {showName && <span className="dashboard-research-label__name" title={label}>{children ?? label}</span>}
      {hasAnnotation && (
        <span className="dashboard-research-label__annotation">
          {tick && (
            <span className="dashboard-research-label__signal">
              {tickFormat === 'full' ? 'Tick' : 'Ti'}{tickReference ? `(${tickReference})` : ''} <span
                className={`dashboard-research-label__tick ${tick.tone}`}
                role="img"
                aria-label={`${label} tick: ${tick.label}`}
                title={[`${label} tick: ${tick.label}`, provenanceSuffix(tickProvenance),
                  [reading.tickEvidence.sourceTicker, reading.tickEvidence.sourceLabel].filter(Boolean).join(' · '),
                  reading.tickEvidence.evidenceText].filter(Boolean).join(' · ')}
                data-source={tickProvenance.source}
                data-source-url={tickProvenance.sourceUrl}
                data-publication-date={tickProvenance.date}
                data-source-ticker={reading.tickEvidence.sourceTicker}
                data-match-type={reading.tickEvidence.matchType}
              >{tickFormat === 'full' ? tick.displayLabel || tick.label : tick.arrow}</span>
            </span>
          )}
          {trade && (
            <span className="dashboard-research-label__signal">
              Ta <span
                className={`dashboard-research-label__trade ${trade.tone}`}
                role="img"
                aria-label={`${label} trade: ${trade.label}`}
                title={[`${label} trade: ${trade.label}`, provenanceSuffix(tradeProvenance), reading.tradeEvidence.evidenceText].filter(Boolean).join(' · ')}
                data-source={tradeProvenance.source}
                data-source-url={tradeProvenance.sourceUrl}
                data-publication-date={tradeProvenance.date}
              >{trade.arrow}</span>
            </span>
          )}
          {trend && (
            <span className="dashboard-research-label__signal">
              Te <span
                className={`dashboard-research-label__trend ${trend.tone}`}
                role="img"
                aria-label={`${label} trend: ${trend.label}`}
                title={[`${label} trend: ${trend.label}`, provenanceSuffix(trendProvenance)].filter(Boolean).join(' · ')}
                data-source={trendProvenance.source}
                data-source-url={trendProvenance.sourceUrl}
                data-publication-date={trendProvenance.date}
              >{trend.arrow}</span>
            </span>
          )}
          {!tick && !trade && !trend && !hasRange && showUnavailable && (
            <span className="dashboard-research-label__unavailable" title={`${label} research unavailable`}>—</span>
          )}
          {hasRange && (
            <span
              className="dashboard-research-label__range"
              aria-label={`${label}${rangeBasis ? ` ${rangeBasis}` : ''} Risk Range: ${lower} to ${upper}`}
              title={[`${label} Risk Range: ${reading.lrr}–${reading.hrr}`, provenanceSuffix(rangeProvenance)].filter(Boolean).join(' · ')}
              data-source={rangeProvenance.source}
              data-source-url={rangeProvenance.sourceUrl}
              data-publication-date={rangeProvenance.date}
            >
              ({rangeBasis ? `${rangeBasis} ` : ''}{lower}–{upper})
            </span>
          )}
        </span>
      )}
    </span>
  );
};

export default DashboardResearchLabel;
