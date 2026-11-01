import React, { memo, useEffect, useMemo, useState } from 'react';
import { portfolioPositionNeedsAttention, sortPortfolioPositions, summarizePortfolioRules } from '../../utils/portfolioReviewRules';
import { portfolioReviewOutlook } from '../../utils/portfolioReviewOutlook';
import { portfolioExposurePercentages } from '../../utils/portfolioReviewExposure';
import { portfolioPositionProducts } from '../../utils/portfolioPositionProducts';
import { portfolioComparisonDateline, portfolioDate, publicationDatelineParts } from '../../utils/portfolioReviewDates';
import { formatAnalystReportDate } from '../../utils/analystReportDates';
import { isExplicitTradeProvenance } from '../../utils/publishedResearchSignals.cjs';
import { activeAttentionFinding, isActionRequired } from '../../utils/analystInboxAlerts.cjs';
import usePortfolioSecurityNames from '../../hooks/usePortfolioSecurityNames';
import AnalystSemanticText from './AnalystSemanticText';
import AnalystDailyRollup from './AnalystDailyRollup';
import PortfolioReviewDateline from './PortfolioReviewDateline';
import { PortfolioReviewTextProvider } from './PortfolioReviewTextContext';
import './AnalystPortfolioBrief.css';
import LoadingIndicator from '../common/LoadingIndicator';

// Exposure reads in whole dollars and whole percentages; cents and hundredths are noise here.
const money = value => value == null ? '—' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(Math.round(value) || 0);
function ExposureAmount({ value }) {
  const formatted = money(value);
  return <span className="portfolio-exposure-amount">{formatted.startsWith('-')
    ? <><span className="portfolio-exposure-sign">-</span>{formatted.slice(1)}</>
    : formatted}</span>;
}
// Limits move in 25 bp steps, so keep a second decimal when it carries one.
const weight = value => value == null ? 'unavailable' : `${value.toFixed(Math.abs(value * 10 - Math.round(value * 10)) > 1e-9 ? 2 : 1)}%`;
const adjustment = value => value > 0 && value < 0.1 ? '<0.1' : value.toFixed(1);
const holdingWeight = row => (row.action === 'REDUCE' && row.reduction < 0.2) || (row.weightDeviation > 0 && row.weightDeviation < 0.2) ? `${row.weightPct.toFixed(3)}%` : weight(row.weightPct);
// A Trade or Trend against the held side is red in the Inbox; sizing breaches are not.
const RED_RULES = new Set(['TRADE_BREAK', 'TREND_BREAK']);
const redRuleBreak = row => row.status === 'conflict' && RED_RULES.has(row.rule);
const label = value => typeof value === 'string' && value ? value[0].toUpperCase() + value.slice(1).toLowerCase() : 'Unavailable';
// Saved captures can contain legacy list-derived indications. A Trade label
// always requires an independently published Trade direction.
const indication = (row, field) => field !== 'trade' && !row[field] && row.signalContext?.[field]?.status === 'indication' ? row.signalContext[field] : null;
// A product call reads by its day; the tooltip keeps the full publication time.
const readingDay = value => formatAnalystReportDate(value, { year: false }).split(' ').slice(0, 2).join(' ');
export const reviewTime = value => formatAnalystReportDate(value) === '—' ? 'Time unavailable' : formatAnalystReportDate(value);
// Date-only research imports use midnight UTC. Keep the publication date
// instead of presenting that placeholder as an evening publication in Pacific time.
const sourceDate = source => /^\d{4}-\d{2}-\d{2}T00:00:00(?:\.0+)?(?:Z|\+00:00)$/.test(source?.publishedAt || '') && source.publishedAt.slice(0, 10) === source.citation?.publicationDate ? source.citation.publicationDate : source?.publishedAt;

function Source({ source, onCitation }) {
  if (!source) return null;
  const citation = source.citation;
  const generatedTitle = citation?.product && citation.title === `${citation.product} ${citation.publicationDate}`;
  const name = generatedTitle ? citation.product.replace(/-/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase()) : citation?.title || citation?.product || 'Source';
  return <span className="portfolio-brief-source">{source.citation ? <button type="button" onClick={() => onCitation(source.citation)}><AnalystSemanticText>{name}</AnalystSemanticText></button> : <AnalystSemanticText>{name}</AnalystSemanticText>} · <time dateTime={sourceDate(source)}><AnalystSemanticText>{reviewTime(sourceDate(source))}</AnalystSemanticText></time></span>;
}

export function PortfolioConflict({ row, onCitation, current = false }) {
  const field = row.rule === 'TRADE_BREAK' ? 'trade' : 'trend';
  const sizingConflict = ['ABOVE_MAX', 'RISK_CAP'].includes(row.rule);
  const prior = row.priorSignals?.[field];
  const value = row[field];
  return <article className={`portfolio-brief-conflict is-${row.action === 'EXIT' ? 'exit' : 'reduce'}`}>
    <h3><AnalystSemanticText>{row.action === 'EXIT' ? `Exit${row.heldSide === 'SHORT' ? ' short' : ''} under ${row.rule === 'TRADE_BREAK' ? 'Trade-break' : 'volatility'} rule` : `Reduce ${adjustment(row.reduction)} percentage points`}</AnalystSemanticText></h3>
    <p><strong><AnalystSemanticText context="Ticker">{row.holding}</AnalystSemanticText></strong> — {sizingConflict ? row.rule === 'ABOVE_MAX' ? 'Position exceeds MAX' : 'Too volatile to size' : <>{label(field)}: {prior && prior !== value && <><span className={`signal-${prior.toLowerCase()}`}>{label(prior)}</span> → </>}<span className={`signal-${value?.toLowerCase()}`}>{label(value)}</span></>}</p>
    {row.rule === 'TREND_BREAK' && row.trade && <p><AnalystSemanticText>{`Trade remains ${label(row.trade).toLowerCase()}`}</AnalystSemanticText></p>}
    <p>{current ? 'Current weight' : 'Held at snapshot'} <strong>{holdingWeight(row)}</strong> <span aria-hidden="true"> → </span> {row.targetLabel} <strong>{weight(row.targetWeight)}</strong></p>
    {sizingConflict ? <span className="portfolio-brief-source">Sizing inputs · ATR <time dateTime={row.sizingInputs?.atr14?.asOf}><AnalystSemanticText>{reviewTime(row.sizingInputs?.atr14?.asOf)}</AnalystSemanticText></time></span> : <Source source={row.sources?.[field]} onCitation={onCitation} />}
  </article>;
}

function PositionSignal({ row, field, onCitation }) {
  const context = indication(row, field);
  const research = field === 'trade' ? row.researchSignals?.trade : null;
  const published = research && ['published', 'historical'].includes(research.status)
    && ['BULLISH', 'BEARISH', 'NEUTRAL'].includes(research.value)
    && isExplicitTradeProvenance(research.signalProvenance) && research.source?.citation ? research : null;
  const value = published?.value || row[field] || context?.value;
  const source = published?.source || context?.source || row.sources?.[field];
  const name = label(field);
  const className = `signal-${value?.toLowerCase() || 'unavailable'}`;
  const title = `${row.holding} ${name}: ${label(value)}${context ? ` · ${source?.citation?.title || 'Research'} indication; published ${name} unavailable` : ''}${source ? ` · ${reviewTime(sourceDate(source))}` : ''}`;
  const display = value ? label(value) : row.signalContext?.[field]?.status === 'conflict' ? 'Mixed' : '—';
  return <span className="portfolio-position-field"><small>{name}</small>{source?.citation && onCitation
    ? <button type="button" className={className} title={title} aria-label={`${title} · View source`} onClick={() => onCitation(source.citation)}>{display}</button>
    : <span className={className} title={title}>{display}</span>}</span>;
}

function unsafeCapturedTick(value) {
  if (!value || typeof value !== 'object') return false;
  return ['mock', 'isMock', 'seed', 'isSeed', 'seeded', 'isSeeded', 'synthetic', 'inferred', 'fixture',
    'cacheOnly', 'cache_only', 'fromCache', 'offline', 'disconnected', 'stale', 'isStale'].some(flag => value[flag] === true)
    || ['verified', 'sourceVerified', 'connected', 'available'].some(field => value[field] === false)
    || ['status', 'sourceStatus', 'freshness', 'cacheState', 'providerStatus'].some(field =>
      /(?:^|[\s_-])(?:unavailable|unverified|offline|disconnected|stale|mock|seeded?|fixture|cache[-_ ]?only|error|failed)(?:$|[\s_-])/i.test(String(value[field] || '')))
    || ['metadata', 'meta', 'provenance', 'source', 'citation', 'quality', 'flags'].some(field => unsafeCapturedTick(value[field]));
}

function PositionTick({ row, citations, onCitation }) {
  const tick = row.tick;
  const source = tick?.source;
  const verified = source?.citation && Number.isFinite(Date.parse(sourceDate(source)))
    && !unsafeCapturedTick(tick);
  // Legacy "excluded" captures withheld the current publisher position only
  // because its historical strategy statistics did not qualify. The original
  // dated position remains captured evidence; never fill a historical capture.
  const positionDirection = { Buy: 'BULLISH', Short: 'BEARISH', Wait: 'NEUTRAL' }[tick?.position];
  const value = verified && ['published', 'excluded', 'wait'].includes(tick.status)
    && positionDirection && (tick.value == null || tick.value === positionDirection) ? positionDirection : null;
  const isWait = value === 'NEUTRAL' && tick.position === 'Wait';
  const display = value ? label(value) : '—';
  const detail = verified ? [isWait ? 'Wait and Watch: no directional call' : tick.contribution, 'HedgAI Signals', tick.sourceTicker, tick.sourceLabel, reviewTime(sourceDate(source))].filter(Boolean).join(' · ') : 'No captured Tick reading';
  const title = `${row.holding} Tick: ${display} · ${detail}`;
  const className = `signal-${value?.toLowerCase() || 'unavailable'}`;
  const relatedSources = verified ? [...new Map([source.citation, ...(tick.citationIds || []).map(id => citations?.get(id))]
    .filter(Boolean).map(citation => [citation.id, citation])).values()] : [];
  return <span className="portfolio-position-field portfolio-position-tick"><small>Tick</small>{verified && onCitation
    ? <button type="button" className={className} title={title} aria-label={`${title} · View source`} onClick={() => onCitation(source.citation, ...(relatedSources.length > 1 ? [{ relatedSources }] : []))}>{display}</button>
    : <span className={className} title={title}>{display}</span>}</span>;
}

function PositionRuleReview({ row }) {
  if (row.status === 'conflict') {
    const field = row.rule === 'TRADE_BREAK' ? 'trade' : 'trend';
    const prior = row.priorSignals?.[field];
    const transition = `${label(field)}: ${prior && prior !== row[field] ? `${label(prior)} → ` : ''}${label(row[field])}`;
    return <>
      <strong className={row.rule === 'ABOVE_MAX' ? undefined : 'portfolio-position-action'}>{row.rule === 'ABOVE_MAX' ? 'Overweight' : row.action === 'EXIT' ? `${row.heldSide === 'SHORT' ? 'Cover' : 'Exit'} to 0.0%` : `Reduce to ${weight(row.targetWeight)} MIN`}</strong>
      <span><AnalystSemanticText>{row.rule === 'ABOVE_MAX' ? `Trim ${adjustment(row.reduction)} pp to ${weight(row.targetWeight)} MAX` : row.rule === 'RISK_CAP' ? 'Too volatile to size' : transition}</AnalystSemanticText></span>
    </>;
  }
  if (row.status === 'aligned') return <span className="portfolio-position-aligned"><AnalystSemanticText>{row.reason || 'Within limits'}</AnalystSemanticText></span>;
  if (!row.trade || !row.trend) return null;
  if (row.weightPct == null) return <span>Verify weight</span>;
  if (row.minWeight == null || row.maxWeight == null) return <><span>Verify sizing</span><small>ATR / price needed</small></>;
  return <span>Verify range</span>;
}

function PositionWeightReview({ row }) {
  const overweight = row.weightStatus === 'overweight';
  return <>
    <strong>{overweight ? 'Overweight' : 'Underweight'}</strong>
    <span>{adjustment(row.weightDeviation)} pp {overweight ? 'above MAX' : 'below MIN'}</span>
  </>;
}

function PositionReview({ row }) {
  if (row.status === 'conflict') return <>
    <PositionRuleReview row={row} />
    {row.weightStatus && row.rule !== 'ABOVE_MAX' && <PositionWeightReview row={row} />}
  </>;
  if (row.weightStatus) return <>
    <PositionWeightReview row={row} />
    {row.status === 'verification' && <PositionRuleReview row={row} />}
  </>;
  return <PositionRuleReview row={row} />;
}

function PositionProducts({ row, brief, onCitation }) {
  const products = portfolioPositionProducts(row, brief);
  if (!products.length) return <span className="signal-unavailable">—</span>;
  return products.map(product => {
    const readingText = reading => `${reading.reading.replace(/^Source (Long|Short|Neutral) position$/, '$1')}${reading.relation === 'proxy' && reading.sourceTicker ? ` (${reading.sourceTicker} proxy)` : ''}`;
    const text = product.readings.map(reading => `${readingDay(reading.date)} ${product.productLabel}: ${readingText(reading)}`).join('; ');
    const title = product.readings.map(reading => `${product.productLabel}: ${readingText(reading)} · ${reviewTime(reading.date)}`).join('\n');
    // Each call is its own line, led by the day its product published it.
    const content = product.readings.map((reading, index) => <span key={index} className="portfolio-position-product-call">
      <time className="portfolio-position-product-date" dateTime={reading.date}>{readingDay(reading.date)}</time>{' '}
      <span><AnalystSemanticText context="Source position">{`${product.productLabel}: ${readingText(reading)}`}</AnalystSemanticText></span>
    </span>);
    const [citation] = product.citations;
    return citation && onCitation
      ? <button type="button" key={product.product} className="portfolio-position-product" title={title} aria-label={`${text} · View source`} onClick={() => onCitation(citation, ...(product.citations.length > 1 ? [{ relatedSources: product.citations }] : []))}>{content}</button>
      : <span key={product.product} className="portfolio-position-product" title={title}>{content}</span>;
  });
}

function PositionStop({ row }) {
  const title = row.stopPrice == null ? 'Stop needs verified ATR and price'
    : `2 × ATR ${row.heldSide === 'SHORT' ? 'above' : 'below'} the last close (${row.stopDistancePct.toFixed(1)}%)${row.stopLossPctNlv == null ? '' : ` · costs ${row.stopLossPctNlv.toFixed(2)}% of NLV at this weight`}`;
  return <span className="portfolio-position-field"><small>Stop</small><span title={title}>{row.stopPrice == null ? '—' : row.stopPrice.toFixed(2)}</span></span>;
}

// `review` picks the rows whose Review cell states a fix; without it the column is left out.
function PortfolioPositions({ rows, brief, citations, onCitation, emptyText, name, sizingFirst, review }) {
  const securityNames = usePortfolioSecurityNames(rows);
  return <div className="portfolio-brief-table-scroll"><table className="portfolio-positions" aria-label={name}>
    <colgroup><col className="portfolio-position-holding-col" /><col className="portfolio-position-name-col" /><col className="portfolio-position-signals-col" /><col className="portfolio-position-weight-col" /><col className="portfolio-position-limits-col" />{review && <col className="portfolio-position-review-col" />}<col className="portfolio-position-products-col" /></colgroup>
    <thead><tr><th scope="col">Ticker</th><th scope="col">Security</th><th scope="col" title="Tick / Trade / Trend">T/T/T</th><th scope="col" title="Weight as a percentage of net liquidation value">%</th><th scope="col" title="MIN / MAX / Stop · MIN and MAX cost 0.125% and 0.25% of NLV if the 2 × ATR stop is hit">M/M/S</th>{review && <th scope="col" title="Sizing flags allow a 10 bps buffer. Trade exits still take priority.">Review</th>}<th scope="col">Product</th></tr></thead>
    {!rows.length && <tbody><tr className="portfolio-position-placeholder"><td colSpan={review ? 7 : 6}>{emptyText}</td></tr></tbody>}
    {['LONG', 'SHORT'].map(side => {
      const positions = sortPortfolioPositions(rows.filter(row => row.heldSide === side), sizingFirst ? { preferredWeightStatus: side === 'LONG' ? 'overweight' : 'underweight' } : {});
      return positions.length > 0 && <tbody key={side} className={`portfolio-position-section is-${side.toLowerCase()}`} aria-label={`${label(side)} positions`}>
        {positions.map(row => <tr key={`${row.holding}:${side}`} className="portfolio-position-row">
          <th scope="row"><strong><AnalystSemanticText context="Ticker">{row.holding}</AnalystSemanticText></strong></th>
          <td><span className="portfolio-position-name" title={row.securityName || (securityNames[row.holding] ? `${securityNames[row.holding].name} · Current security name · ${securityNames[row.holding].source}` : undefined)}><AnalystSemanticText context="Security">{row.securityName || securityNames[row.holding]?.name || '—'}</AnalystSemanticText></span></td>
          <td><PositionTick row={row} citations={citations} onCitation={onCitation} /><PositionSignal row={row} field="trade" onCitation={onCitation} /><PositionSignal row={row} field="trend" onCitation={onCitation} /></td>
          <td className="portfolio-position-weight">{row.weightPct == null ? '—' : holdingWeight(row)}</td>
          <td className="portfolio-position-limits">{[['MIN', row.minWeight], ['MAX', row.maxWeight]].map(([name, value]) => <span className="portfolio-position-field" key={name}><small>{name}</small><span title={value == null ? `${name} needs verified sizing inputs` : `${name} as a percentage of NLV`}>{value == null ? '—' : weight(value)}</span></span>)}<PositionStop row={row} /></td>
          {review && <td className="portfolio-position-review">{review(row) && <PositionReview row={row} />}</td>}
          <td className="portfolio-position-products"><PositionProducts row={row} brief={brief} onCitation={onCitation} /></td>
        </tr>)}
      </tbody>;
    })}
  </table></div>;
}

const percent = value => `${Math.abs(value).toFixed(0)}%`;
// Weights change in basis points of NLV; dollar pairs change in whole dollars.
// The displayed sign sets the color: green up, red down, muted when flat or missing.
const exposureChange = (value, basisPoints) => {
  if (value === null) return { text: '—', color: 'signal-unavailable' };
  const rounded = Math.round(basisPoints ? value * 100 : value) || 0;
  const sign = rounded > 0 ? '+' : rounded < 0 ? '-' : '';
  return { text: `${sign}${basisPoints ? `${Math.abs(rounded).toLocaleString('en-US')} bp` : money(Math.abs(rounded))}`,
    color: rounded > 0 ? 'signal-bullish' : rounded < 0 ? 'signal-bearish' : 'signal-unavailable' };
};

// Exposure & risk: the capture's dollar values, then Current, Δ and Previous
// close side by side so the day-to-day move reads in one row.
function PortfolioExposure({ metrics, comparison, asOf, loading, state }) {
  const pairs = comparison?.status === 'available' ? comparison.metrics || {} : {};
  const capturedEndpoint = side => ({
    ...(side === 'current' ? metrics : {}),
    ...Object.fromEntries(Object.entries(pairs).filter(([, metric]) => Number.isFinite(metric?.[side]))
      .map(([name, metric]) => [name, metric[side]])),
  });
  const current = capturedEndpoint('current');
  const previous = capturedEndpoint('previous');
  const currentPercentages = portfolioExposurePercentages(current);
  const previousPercentages = portfolioExposurePercentages(previous);
  const pair = (currentValue, previousValue) => ({
    current: Number.isFinite(currentValue) ? currentValue : null,
    previous: Number.isFinite(previousValue) ? previousValue : null,
  });
  const displayedNet = Number.isFinite(metrics.netExposure) ? Math.round(metrics.netExposure) : null;
  const rows = [
    ['Gross', 'gross', 'grossExposure'],
    ['Long', 'long', 'longMarketValue', 'is-long'],
    ['Short', 'short', 'shortMarketValue', 'is-short'],
    ['Net', 'net', 'netExposure', displayedNet > 0 ? 'is-net-positive' : displayedNet < 0 ? 'is-net-negative' : undefined],
  ].map(([name, percentageKey, valueKey, className]) => {
    const percentagePair = pair(currentPercentages[percentageKey], previousPercentages[percentageKey]);
    const values = pair(current[valueKey], previous[valueKey]);
    const comparablePercentages = percentagePair.previous !== null && percentagePair.current !== null;
    const comparableValues = values.previous !== null && values.current !== null;
    const usePercentages = comparablePercentages || !comparableValues && percentagePair.current !== null;
    const metric = usePercentages ? percentagePair : values;
    const format = value => value === null ? '—' : usePercentages ? percent(value) : <ExposureAmount value={value} />;
    const color = value => value === null ? 'signal-unavailable' : name === 'Gross' || value === 0 ? undefined
      : name === 'Short' || value < 0 ? 'signal-bearish' : 'signal-bullish';
    // Weights display as magnitudes, so Long and Short change by magnitude; Net keeps its sign.
    const change = metric.current === null || metric.previous === null ? null
      : !usePercentages || name === 'Net' ? metric.current - metric.previous : Math.abs(metric.current) - Math.abs(metric.previous);
    return { name, className, metric, value: metrics[valueKey], current: format(metric.current), previous: format(metric.previous),
      change: exposureChange(change, usePercentages),
      currentColor: color(metric.current), previousColor: color(metric.previous) };
  });
  const previousUnavailable = rows.every(row => row.metric.previous === null);
  const previousDate = portfolioComparisonDateline(comparison?.currentAsOf || asOf, comparison?.baselineAsOf, comparison).text
    .replace(/^Previous close snapshot:/, 'Previous:');
  const sectionState = state || (previousUnavailable ? loading ? <LoadingIndicator label="Loading…" size="sm" /> : 'Previous close unavailable' : null);
  return <section className="portfolio-review-section portfolio-review-exposure" aria-label="Exposure and risk" aria-busy={(state || previousUnavailable) && loading || undefined}><h2>Exposure &amp; risk</h2>
    <PortfolioReviewDateline text={`Positioning: ${portfolioDate(asOf)}`} previous={previousDate} />
    <div className="portfolio-review-section-body"><div className="portfolio-brief-table-scroll"><table className="portfolio-brief-table portfolio-brief-exposure" aria-label="Portfolio exposure">
      <colgroup><col /><col /><col /><col /><col /></colgroup>
      <thead><tr><th scope="col">Exposure</th><th scope="col">Value</th><th scope="col" className="portfolio-exposure-percent">Current</th>
        <th scope="col" className="portfolio-exposure-change" title="Change since previous close; weights in basis points of NLV">Δ</th><th scope="col" className="portfolio-exposure-percent">Previous</th></tr></thead>
      <tbody>{rows.map(row => <tr key={row.name} className={row.className}>
        <th scope="row"><AnalystSemanticText>{row.name}</AnalystSemanticText></th>
        <td className="portfolio-exposure-value"><ExposureAmount value={row.value} /></td>
        <td className={`portfolio-exposure-percent ${row.currentColor || ''}`.trim()}>{row.current}</td>
        <td className={`portfolio-exposure-change ${row.change.color}`}>{row.change.text}</td>
        <td className={`portfolio-exposure-percent ${row.previousColor || ''}`.trim()}>{row.previous}</td>
      </tr>)}</tbody>
    </table></div>
    {sectionState && <p className="portfolio-review-section-state">{sectionState}</p>}</div>
  </section>;
}

export function PortfolioResearchUpdates({ brief, findings = [], onCitation }) {
  const [expanded, setExpanded] = useState(false);
  const [observedAt, setObservedAt] = useState(Date.now);
  useEffect(() => { const timer = setInterval(() => setObservedAt(Date.now()), 5000); return () => clearInterval(timer); }, []);
  const symbols = new Set((brief.holdings || []).map(row => row.holding));
  const seen = new Set();
  const updates = [...findings].sort((a, b) => String(b.payload?.publicationTime || '').localeCompare(String(a.payload?.publicationTime || ''))).filter(finding => {
    const payload = finding.payload || {};
    const key = `${finding.symbol}:${payload.event?.fieldPath || payload.event?.eventType || finding.action}`;
    if (!symbols.has(finding.symbol) || finding.state === 'resolved' || payload.event?.qualityStatus !== 'validated'
      || Date.parse(payload.publicationTime) <= Date.parse(brief.reviewedAt || brief.asOf) || !Number.isFinite(Date.parse(payload.publicationTime)) || seen.has(key)) return false;
    seen.add(key); return true;
  });
  if (!updates.length) return null;
  return <PortfolioReviewTextProvider brief={brief}><section className="portfolio-brief portfolio-research-updates portfolio-review-section" aria-label="Research since this snapshot">
    <h2>New research since this snapshot <span className="portfolio-brief-count">{updates.length}</span></h2>
    <PortfolioReviewDateline {...publicationDatelineParts(updates.map(finding => ({ ...finding.payload.citation, publishedAt: finding.payload.publicationTime })))} />
    {(expanded ? updates : updates.slice(0, 3)).map(finding => {
      const payload = finding.payload;
      const verified = payload.holdingsVerified === true && observedAt - Date.parse(payload.holdingsVerifiedAt) <= 60000 && Date.parse(payload.holdingsVerifiedAt) <= observedAt + 30000;
      return <div key={finding.id}>{verified && finding.state !== 'pending verification' && payload.rule?.status === 'conflict'
        ? <PortfolioConflict row={payload.rule} current onCitation={onCitation} />
        : <article className="portfolio-brief-research"><p><strong><AnalystSemanticText context="Ticker">{finding.symbol}</AnalystSemanticText></strong> — <AnalystSemanticText>{payload.signalField || payload.event.eventType?.includes('signal') ? `${payload.signalField === 'trade' ? 'Trade' : payload.signalField === 'trend' ? 'Trend' : 'Signal'} ${label(payload.event.signalValue)}` : `${label(finding.action)} reported`}</AnalystSemanticText></p><Source source={{ citation: payload.citation, publishedAt: payload.publicationTime }} onCitation={onCitation} /><p className="portfolio-brief-muted">{verified ? 'Rule comparison needs additional verified inputs.' : 'Held at the saved snapshot; current holding needs verification.'}</p></article>}</div>;
    })}
    {updates.length > 3 && <button type="button" className="portfolio-brief-more" onClick={() => setExpanded(!expanded)}>{expanded ? 'Show fewer updates' : `Show all ${updates.length} updates`}</button>}
  </section></PortfolioReviewTextProvider>;
}

// The red Inbox alerts on held positions, exactly as the Inbox lists them:
// unread, still open, and action-required.
function positionAlerts(findings = [], now = Date.now()) {
  return findings.filter(finding => finding.unread !== 0 && finding.unread !== false && isActionRequired(finding)
    && activeAttentionFinding(finding, now) && !['resolved', 'unavailable'].includes(finding.state || finding.payload?.state))
    .map(finding => {
      const payload = finding.payload || finding;
      const presentation = payload.presentation || finding.presentation;
      const quantity = typeof payload.quantity === 'number' ? payload.quantity : null;
      return { id: finding.id, symbol: finding.symbol || payload.symbol || presentation.subject,
        heldSide: quantity > 0 ? 'LONG' : quantity < 0 ? 'SHORT' : null, weightPct: payload.currentHolding?.weightPct ?? null };
    }).filter(alert => alert.symbol && alert.heldSide);
}

// Action required holds every position that changed against us: a red rule
// break in this review and every red Inbox alert. Corrections hold the rest
// (sizing breaches, volatility caps) that need fixing but not immediately.
function positionSections(rows, alerts) {
  const key = row => `${row.holding}:${row.heldSide}`;
  const alertsByPosition = new Map();
  for (const alert of alerts) {
    const id = `${alert.symbol}:${alert.heldSide}`;
    alertsByPosition.set(id, [...(alertsByPosition.get(id) || []), alert]);
  }
  const urgent = [];
  const corrections = [];
  for (const row of rows) {
    const rowAlerts = alertsByPosition.get(key(row));
    alertsByPosition.delete(key(row));
    if (rowAlerts || redRuleBreak(row)) urgent.push(rowAlerts ? { ...row, alerts: rowAlerts } : row);
    else if (portfolioPositionNeedsAttention(row)) corrections.push(row);
  }
  // A position opened after this capture still answers to its alert.
  for (const [, [first, ...rest]] of alertsByPosition) urgent.push({ holding: first.symbol, heldSide: first.heldSide,
    weightPct: first.weightPct == null ? null : Math.abs(first.weightPct), alerts: [first, ...rest] });
  return { urgent, corrections };
}

function PositionSection({ name, rows, emptyText, sizingFirst, review, brief, sources, onCitation, loading }) {
  const [expanded, setExpanded] = useState(false);
  const sides = ['LONG', 'SHORT'].map(side => sortPortfolioPositions(rows.filter(row => row.heldSide === side),
    sizingFirst ? { preferredWeightStatus: side === 'LONG' ? 'overweight' : 'underweight' } : {}));
  const displayed = sides.flatMap(group => expanded ? group : group.slice(0, 5));
  const hasMore = sides.some(group => group.length > 5);
  const period = publicationDatelineParts(rows.flatMap(row => [
    ...Object.values(row.sources || {}), ...Object.values(row.researchSignals || {}).map(signal => signal?.source), row.tick?.source,
  ]).filter(Boolean).map(source => ({ ...source.citation, publishedAt: source.publishedAt || source.citation?.publishedAt })), { label: 'Period' }).period;
  const noun = name.toLowerCase();
  return <section className="portfolio-review-section portfolio-brief-exceptions" aria-label={name} aria-busy={!brief.available && loading || undefined}><h2>{name}</h2>
    <PortfolioReviewDateline text={`Positioning: ${portfolioDate(brief.available ? brief.asOf : null)}`} period={period} />
    <div className="portfolio-review-section-body"><PortfolioPositions name={name} rows={displayed} brief={brief} citations={sources} onCitation={onCitation} sizingFirst={sizingFirst} review={review}
      emptyText={!brief.available || brief.coverageComplete === false ? loading ? <LoadingIndicator label="Loading…" size="sm" /> : 'Unavailable' : emptyText} /></div>
    {hasMore && <div className="portfolio-review-section-controls"><button type="button" className="portfolio-brief-more" onClick={() => setExpanded(!expanded)}>{expanded ? `Show fewer ${noun}` : `Show all ${rows.length} ${noun}`}</button></div>}
  </section>;
}

const loadingStates = ['queued', 'accepted', 'starting', 'running', 'reviewing'];
const placeholderBrief = { available: false, metrics: {}, holdings: [], citations: [], dailyRollup: { version: 1, sections: [] } };

export function PortfolioReviewPlaceholder({ message = {}, loading = true, historical = false, deferred = false }) {
  return <AnalystPortfolioBrief message={{ ...message, portfolioBrief: placeholderBrief }} onCitation={undefined}
    loading={loading} historical={historical} deferred={deferred} />;
}

// The capture's own Gateway verdict decides this copy; only a verified
// disconnect (or an older capture without a verdict) asks to connect.
const unavailableReasonText = {
  gateway_disconnected: 'Unavailable — connect to IB Gateway.',
  gateway_unverified: 'Unavailable — the IB Gateway connection could not be verified.',
  holdings_unverified: 'Unavailable — live holdings could not be verified.',
  prices_unverified: 'Unavailable — live prices could not be verified.',
  portfolio_unverified: 'Unavailable — the live portfolio could not be verified.',
};

const AnalystPortfolioBrief = memo(function AnalystPortfolioBrief({ message, onCitation, inboxFindings, historical = false, loading = loadingStates.includes(message.reviewState || message.state), deferred = false, unavailableText }) {
  const brief = message.portfolioBrief || placeholderBrief;
  const summary = useMemo(() => summarizePortfolioRules(brief.available ? brief : { ...brief, holdings: [] }), [brief]);
  const outlook = useMemo(() => portfolioReviewOutlook(brief), [brief]);
  const metrics = brief.available ? brief.metrics || {} : {};
  const exposureUnavailable = ['grossExposure', 'longMarketValue', 'shortMarketValue', 'netExposure'].every(key => !Number.isFinite(metrics[key]));
  const exposureState = !brief.available ? loading ? <LoadingIndicator label="Loading…" size="sm" />
    : unavailableText || unavailableReasonText[brief.unavailableReason] || unavailableReasonText.gateway_disconnected
    : exposureUnavailable ? loading ? <LoadingIndicator label="Loading…" size="sm" /> : 'Unavailable'
    : brief.reviewedAt && brief.historicalHoldings ? !brief.unavailableReason || brief.unavailableReason === 'gateway_disconnected'
      ? 'Last verified holdings. Connect to IB Gateway to update.' : 'Last verified holdings. Refresh to update.' : null;
  const sources = new Map((brief.citations || []).map(source => [source.id, source]));
  const hasDailyRollup = brief.dailyRollup?.version === 1;
  // A saved report keeps what it captured; only the current one meets live alerts.
  const { urgent, corrections } = useMemo(() => positionSections(summary.rows, historical || !brief.available ? [] : positionAlerts(inboxFindings)),
    [summary, historical, brief.available, inboxFindings]);
  // A Trade or Trend break states its exit or reduction in Review; an alert row
  // answers to its dated product calls, so without a break the column is left out.
  return <PortfolioReviewTextProvider brief={brief}><article data-message-id={message.id} className={`portfolio-brief portfolio-brief-centered${deferred ? ' analyst-captured-report-placeholder' : ''}${historical ? ' analyst-historical-report' : ''}`} aria-label="Portfolio Review summary" aria-busy={loading || undefined}>
    <PortfolioExposure metrics={metrics} comparison={brief.available ? brief.comparison : null} asOf={brief.available ? brief.asOf : null} loading={loading} state={exposureState} />
    <PositionSection name="Action required" rows={urgent} emptyText="No positions need immediate action" review={urgent.some(redRuleBreak) ? redRuleBreak : null} brief={brief} sources={sources} onCitation={onCitation} loading={loading} />
    <PositionSection name="Corrections" rows={corrections} emptyText="No corrections" sizingFirst review={() => true} brief={brief} sources={sources} onCitation={onCitation} loading={loading} />
    {brief.available && <>
      {!hasDailyRollup && outlook && <section className="portfolio-review-section" aria-label="Session outlook"><h2>Session outlook</h2>
        <PortfolioReviewDateline {...publicationDatelineParts([{ ...outlook.citation, publishedAt: outlook.publishedAt }])} />
        <p><strong><AnalystSemanticText>{outlook.from && outlook.from !== outlook.to ? `Quad ${outlook.from} → Quad ${outlook.to}` : `Quad ${outlook.to}`}</AnalystSemanticText> scenario</strong></p><Source source={{ citation: outlook.citation, publishedAt: outlook.publishedAt }} onCitation={onCitation} />
        <ul className="portfolio-brief-takeaways">
          {outlook.pressure.length > 0 && <li><strong>Recheck exposure:</strong> <AnalystSemanticText context="Held exposure">{outlook.pressure.slice(0, 3).map(row => `${row.holding} (${row.heldSide.toLowerCase()}, ${row.label})`).join('; ')}</AnalystSemanticText>. The +EV playbook is less favorable for this exposure.</li>}
          {outlook.support.length > 0 && <li><strong>Supported exposure:</strong> <AnalystSemanticText context="Held exposure">{outlook.support.slice(0, 3).map(row => `${row.holding} (${row.heldSide.toLowerCase()})`).join(', ')}</AnalystSemanticText> align with this Quad’s playbook.</li>}
          {outlook.candidates.length > 0 && <li><strong>Research candidates:</strong> <AnalystSemanticText context="Ticker">{outlook.candidates.map(row => row.symbol).join(', ')}</AnalystSemanticText> have positive historical +EV and <AnalystSemanticText>bullish</AnalystSemanticText> Trade/Trend. Check live entry ranges and sizing before an addition.</li>}
        </ul>
      </section>}
      {!hasDailyRollup && !outlook && brief.nextSession?.length > 0 && <section className="portfolio-review-section" aria-label="Next session"><h2>Next session</h2>
        <PortfolioReviewDateline {...publicationDatelineParts(brief.nextSession.map(fact => sources.get(fact.citationId)).filter(Boolean))} />
        <ul className="portfolio-brief-takeaways">{brief.nextSession.slice(0, 3).map((fact, index) => <li key={index}><AnalystSemanticText>{fact.text}</AnalystSemanticText>{sources.has(fact.citationId) && <button type="button" onClick={() => onCitation(sources.get(fact.citationId))} aria-label={`Source for takeaway ${index + 1}`}>Source</button>}</li>)}</ul></section>}
    </>}
    <AnalystDailyRollup stableLayout loading={loading} rollup={brief.dailyRollup} citations={brief.citations} onCitation={onCitation} holdingsAsOf={brief.asOf} />
    {/* A failed attempt keeps its published partial report and says why it stopped. */}
    {message.reviewStatusLine && <p className="portfolio-brief-caption" role="note">{message.reviewStatusLine}</p>}
  </article></PortfolioReviewTextProvider>;
});
export default AnalystPortfolioBrief;
