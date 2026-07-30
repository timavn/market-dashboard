import React, { useMemo, useState } from 'react';
import { Activity, FileText } from 'lucide-react';
import DataStatusChip from './DataStatusChip';
import './MarketSituationReportCard.css';

const STALE_AFTER_MS = 4 * 24 * 60 * 60 * 1000;

const formatAsOf = (value) => {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value).toUpperCase();
  return parsed.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).toUpperCase();
};

const getMarketSituationFreshness = (snapshot, now = Date.now()) => {
  const date = snapshot?.date || snapshot?.publishedAt;
  if (!date || !Array.isArray(snapshot?.data?.signals) || snapshot.data.signals.length !== 4) {
    return { status: 'unavailable', label: 'UNAVAILABLE', detail: null };
  }
  const asOf = /^\d{4}-\d{2}-\d{2}$/.test(date)
    ? new Date(`${date}T23:59:59Z`)
    : new Date(date);
  const age = now - asOf.getTime();
  const stale = !Number.isFinite(age) || age > STALE_AFTER_MS;
  const formatted = formatAsOf(date);
  return {
    status: stale ? 'delayed' : 'historical',
    label: stale ? 'STALE' : undefined,
    detail: stale ? `AS OF ${formatted}` : formatted,
    asOfLabel: `AS OF ${formatted}`,
  };
};

const SourceImage = ({ src, alt, className }) => {
  const [failed, setFailed] = useState(false);
  if (!src || failed) {
    return <div className="msr-source-image__missing">Source image unavailable</div>;
  }
  return (
    <img
      className={className}
      src={src}
      alt={alt}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  );
};

const MarketSituationReportCard = ({
  snapshot,
  loading = false,
  error = null,
}) => {
  const freshness = getMarketSituationFreshness(snapshot);
  const signals = Array.isArray(snapshot?.data?.signals) ? snapshot.data.signals : [];
  const chartData = snapshot?.data?.charts;
  const matrixUrl = snapshot?.data?.signalMatrixImageUrl;
  const supportingCharts = useMemo(
    () => (
      Array.isArray(chartData)
        ? chartData.filter((chart) => chart?.url && chart.url !== matrixUrl)
        : []
    ),
    [chartData, matrixUrl],
  );

  if (loading && !snapshot) {
    return <section className="msr-card msr-card--empty">Loading Market Situation Report…</section>;
  }

  if (!snapshot || signals.length !== 4) {
    return (
      <section className="msr-card msr-card--empty">
        <FileText size={22} aria-hidden="true" />
        <strong>Market Situation Report unavailable</strong>
        <span>{error || 'No verified four-signal snapshot has been published.'}</span>
      </section>
    );
  }

  return (
    <section className="msr-card" aria-label="Market Situation Report details">
      <header className="msr-card__header">
        <div className="msr-card__identity">
          <Activity size={16} aria-hidden="true" />
          <div>
            <span>Tier 1 Alpha · presented by Hedgeye</span>
            <h3>Market Situation Report</h3>
          </div>
        </div>
        <DataStatusChip
          status={freshness.status}
          label={freshness.label}
          detail={freshness.detail}
          context="Market Situation Report"
          issues={error ? [`Refresh: ${error}`] : []}
          compact
        />
      </header>

      <div className="msr-card__overview">
        <div className="msr-card__signals" aria-label="Market Situation signals">
          {signals.map((signal) => (
            <div className="msr-signal" key={signal.id || signal.label}>
              <span>{signal.label}</span>
              <strong className={`msr-signal--${signal.tone || 'neutral'}`}>
                {signal.value}
              </strong>
            </div>
          ))}
        </div>
        <div className="msr-card__narrative">
          <span className="msr-card__asof">{freshness.asOfLabel}</span>
          <h4>{snapshot.article?.headline || 'Market Situation Report'}</h4>
          {snapshot.article?.summary && <p>{snapshot.article.summary}</p>}
        </div>
      </div>

      <figure className="msr-card__matrix">
        <figcaption>Published signal matrix</figcaption>
        <SourceImage
          src={matrixUrl}
          alt={`Market Situation Report signal matrix for ${formatAsOf(snapshot.date)}`}
          className="msr-card__matrix-image"
        />
      </figure>

      {supportingCharts.length > 0 && (
        <section className="msr-card__charts" aria-label="Supporting report charts">
          <h4>Supporting report charts</h4>
          <div className="msr-card__chart-grid">
            {supportingCharts.map((chart, index) => (
              <figure key={chart.url}>
                <SourceImage
                  src={chart.url}
                  alt={`Market Situation Report supporting chart ${index + 1}`}
                  className="msr-card__chart-image"
                />
                <figcaption>Figure {index + 1}</figcaption>
              </figure>
            ))}
          </div>
        </section>
      )}

      <footer className="msr-card__footer">
        Historical research snapshot. Values are extracted from the published signal matrix;
        no inferred or fallback readings are shown.
      </footer>
    </section>
  );
};

export { formatAsOf, getMarketSituationFreshness };
export default MarketSituationReportCard;
