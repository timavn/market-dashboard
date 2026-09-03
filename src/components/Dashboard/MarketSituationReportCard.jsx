import React, { useMemo, useState } from 'react';
import './MarketSituationReportCard.css';

const STALE_AFTER_MS = 8 * 24 * 60 * 60 * 1000;

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

const hasReportContent = (snapshot) => {
  if (!snapshot || typeof snapshot !== 'object') return false;
  if (snapshot.contentComplete === true) return true;
  if (Array.isArray(snapshot?.data?.blocks) && snapshot.data.blocks.length > 0) return true;
  return Array.isArray(snapshot?.data?.signals) && snapshot.data.signals.length === 4;
};

const getMarketSituationFreshness = (snapshot, now = Date.now()) => {
  const date = snapshot?.date || snapshot?.publishedAt;
  if (!date || !hasReportContent(snapshot)) {
    return { status: 'unavailable', label: 'UNAVAILABLE', detail: null, asOfLabel: null };
  }
  const asOf = /^\d{4}-\d{2}-\d{2}$/.test(date)
    ? new Date(`${date}T23:59:59Z`)
    : new Date(date);
  const age = now - asOf.getTime();
  const stale = !Number.isFinite(age) || age > STALE_AFTER_MS;
  const formatted = formatAsOf(date);
  return {
    status: stale ? 'delayed' : 'historical',
    label: stale ? 'STALE RESEARCH' : 'DATED RESEARCH',
    detail: formatted,
    asOfLabel: `AS OF ${formatted}`,
  };
};

const MARKET_WRAPPER_TEXT = [
  /having trouble viewing this email/i,
  /view (?:it|this email) in your browser/i,
  /prepared exclusively for/i,
  /the research note below was written by/i,
  /presented by hedgeye/i,
  /to access the full (?:market situation )?report/i,
  /click here/i,
  /manage preferences/i,
  /unsubscribe/i,
  /legal disclaimer/i,
  /important disclosures/i,
  /all rights reserved/i,
];

const isMarketWrapperText = (value) => {
  const text = String(value || '').trim();
  if (!text || MARKET_WRAPPER_TEXT.some((pattern) => pattern.test(text))) return true;
  if (/^market situation report\s*:/i.test(text)) return true;
  return /^\d{1,2}\/\d{1,2}\/\d{4}\s+\d{1,2}:\d{2}\s+[ap]m(?:\s+[a-z]{2,5})?$/i.test(text);
};

const SourceImage = ({ src, alt }) => {
  const [failed, setFailed] = useState(false);
  if (!src || failed) {
    return (
      <p className="market-structure-reader__missing-image" role="status">
        Archived chart unavailable.
      </p>
    );
  }
  return (
    <a
      className="market-structure-reader__image-link"
      href={src}
      target="_blank"
      rel="noreferrer"
      title="Open chart full size"
    >
      <img
        className="market-structure-reader__chart"
        src={src}
        alt={alt}
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
      />
    </a>
  );
};

const VerifiedSignals = ({ signals }) => {
  if (!Array.isArray(signals) || signals.length !== 4) return null;
  return (
    <table className="market-structure-reader__signals" aria-label="Verified Market Structure signals">
      <caption>Verified signals</caption>
      <tbody>
        {signals.map((signal) => (
          <tr key={signal.id || signal.label}>
            <th scope="row">{signal.label}</th>
            <td className={`market-structure-reader__signal--${signal.tone || 'neutral'}`}>
              {signal.value}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
};

const MarketSituationReportCard = ({
  snapshot,
  loading = false,
  refreshing = false,
  error = null,
  embedded = false,
}) => {
  const freshness = getMarketSituationFreshness(snapshot);
  const charts = useMemo(
    () => (Array.isArray(snapshot?.data?.charts) ? snapshot.data.charts : []),
    [snapshot],
  );
  const chartsById = useMemo(
    () => new Map(charts.map((chart) => [chart?.id, chart]).filter(([id]) => id)),
    [charts],
  );
  const orderedBlocks = Array.isArray(snapshot?.data?.blocks) ? snapshot.data.blocks : [];
  const signals = Array.isArray(snapshot?.data?.signals) ? snapshot.data.signals : [];
  const reportHeading = String(snapshot?.article?.reportHeading || '').trim()
    || orderedBlocks.find((block) => block?.type === 'heading' && !isMarketWrapperText(block.text))?.text
    || null;
  const headingKey = reportHeading
    ? String(reportHeading).trim().toLowerCase()
    : null;
  const ReportHeading = embedded ? 'h3' : 'h1';
  const BlockHeading = embedded ? 'h4' : 'h2';
  const readerClassName = [
    !embedded && 'process-wiki',
    'market-structure-reader',
    embedded && 'market-structure-reader--embedded',
  ].filter(Boolean).join(' ');

  const renderBlock = (block, index) => {
    if (!block || typeof block !== 'object') return null;
    if (block.type === 'chart') {
      const chart = chartsById.get(block.chartId);
      const chartNumber = orderedBlocks
        .slice(0, index + 1)
        .filter((candidate) => candidate?.type === 'chart').length;
      return (
        <figure
          className="market-structure-reader__chart-figure"
          key={block.id || `${block.chartId}-${index}`}
          aria-label={`Market Structure chart ${chartNumber}`}
        >
          <SourceImage
            src={chart?.contentUrl}
            alt={block.caption || `Market Structure chart ${chartNumber}`}
          />
        </figure>
      );
    }

    const text = String(block.text || '').trim();
    if (!text || block.type === 'byline' || isMarketWrapperText(text)) return null;
    if (block.type === 'heading') {
      if (headingKey && text.toLowerCase() === headingKey) return null;
      return <BlockHeading key={block.id || index}>{text}</BlockHeading>;
    }
    if (block.type === 'callout') {
      return <aside className="market-structure-reader__callout" key={block.id || index}>{text}</aside>;
    }
    return <p key={block.id || index}>{text}</p>;
  };

  if (loading && !snapshot) {
    return embedded ? (
      <div className={readerClassName} data-testid="market-structure-reader">
        <p className="market-structure-reader__state" role="status">Loading dated market research…</p>
      </div>
    ) : (
      <main className={readerClassName} data-testid="market-structure-reader">
        <p className="market-structure-reader__state" role="status">Loading dated market research…</p>
      </main>
    );
  }

  if (!snapshot || !hasReportContent(snapshot)) {
    return embedded ? (
      <div className={readerClassName} data-testid="market-structure-reader">
        <p className="market-structure-reader__state" role="status">
          {error || 'No complete dated market research report is available.'}
        </p>
      </div>
    ) : (
      <main className={readerClassName} data-testid="market-structure-reader">
        <p className="market-structure-reader__state" role="status">
          {error || 'No complete dated market research report is available.'}
        </p>
      </main>
    );
  }

  const reportArticle = (
    <article className="wp-paper market-structure-reader__article" aria-label="Complete Market Situation Report">
      {reportHeading && <ReportHeading>{reportHeading}</ReportHeading>}
      <p
        className={`market-structure-reader__as-of market-structure-reader__as-of--${freshness.status}`}
        data-testid="market-structure-as-of"
      >
        {freshness.asOfLabel || 'AS OF DATE UNAVAILABLE'} · {freshness.label}
      </p>

      {(error || refreshing) && (
        <p className="market-structure-reader__refresh-warning" role="status">
          {error
            ? `Refresh delayed. Showing the last complete report. ${error}`
            : 'Checking the dated text edition…'}
        </p>
      )}

      <VerifiedSignals signals={signals} />
      {orderedBlocks.map(renderBlock)}
      {orderedBlocks.length === 0 && (
        charts.length > 0
          ? charts.map((chart, index) => (
            <figure
              className="market-structure-reader__chart-figure"
              key={chart.id || chart.contentUrl || index}
              aria-label={`Market Structure chart ${index + 1}`}
            >
              <SourceImage
                src={chart.contentUrl || chart.url}
                alt={`Market Structure chart ${index + 1}`}
              />
            </figure>
          ))
          : snapshot.data?.signalMatrixImageUrl && (
            <figure
              className="market-structure-reader__chart-figure"
              aria-label="Market Structure chart 1"
            >
              <SourceImage
                src={snapshot.data.signalMatrixImageUrl}
                alt="Market Structure chart 1"
              />
            </figure>
          )
      )}
    </article>
  );

  if (embedded) {
    return (
      <div className={readerClassName} data-testid="market-structure-reader">
        {reportArticle}
      </div>
    );
  }

  return (
    <main className={readerClassName} data-testid="market-structure-reader">
      <div className="market-structure-reader__scroll" data-testid="market-structure-reader-scroll">
        {reportArticle}
      </div>
    </main>
  );
};

export { formatAsOf, getMarketSituationFreshness, hasReportContent };
export default MarketSituationReportCard;
