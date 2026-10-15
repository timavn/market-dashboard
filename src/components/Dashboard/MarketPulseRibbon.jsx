import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import useMarketDailySnapshot, { validateMarketDailySnapshot } from '../../hooks/useMarketDailySnapshot';
import { MarketThemePanel, MarketFactorPanel } from './MarketRotationPanels';
import useMarketRotationSnapshot, { validateMarketRotationSnapshot } from '../../hooks/useMarketRotationSnapshot';
import MarketDailyDetailModal from './MarketDailyDetailModal';
import DelayedDataMarker from './DelayedDataMarker';
import './MarketDailyStrip.css';

const UNAVAILABLE = '—';
const SECTION_ORDER = ['breadth', 'leadership', 'themes', 'factors', 'movers', 'outliers'];
const VALID_QUOTE_STATUSES = new Set(['live', 'delayed', 'last-close']);
const REJECTED_STATE = /^(?:unavailable|offline|disconnected|error|failed|stale|cache[-_ ]?only|cached|mock|seed(?:ed)?|synthetic|fallback)$/i;
const BAD_FLAGS = ['stale', 'isStale', 'cacheOnly', 'cache_only', 'fromCache', 'mock', 'isMock', 'seed', 'seeded', 'synthetic', 'fallback', 'offline', 'disconnected'];
const finite = (value) => (typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')) && Number.isFinite(Number(value));
const number = (value) => finite(value) ? Number(value) : null;
const tone = (value) => !finite(value) || Number(value) === 0 ? 'is-neutral' : Number(value) > 0 ? 'is-positive' : 'is-negative';
const percent = (value, digits = 2) => finite(value) ? `${Number(value) > 0 ? '+' : ''}${Number(value).toFixed(digits)}%` : UNAVAILABLE;
const count = (value) => finite(value) && Number(value) >= 0 && Number.isInteger(Number(value)) ? Number(value).toLocaleString('en-US') : UNAVAILABLE;
const share = (value) => finite(value) && Number(value) >= 0 && Number(value) <= 100 ? `${Number(value).toFixed(0)}%` : UNAVAILABLE;

const hasRejectedEvidence = (value) => {
  if (!value || typeof value !== 'object') return false;
  if (BAD_FLAGS.some((key) => value[key] === true) || value.connected === false || value.available === false) return true;
  if (['status', 'availability', 'freshness', 'dataType', 'source', 'provider'].some((key) => typeof value[key] === 'string' && REJECTED_STATE.test(value[key]))) return true;
  return Object.values(value).some((child) => child && typeof child === 'object' && hasRejectedEvidence(child));
};

// The informational strip keeps expired verified observations as dated references.
export const usableDailySnapshot = (snapshot, now = Date.now()) => Boolean(validateMarketDailySnapshot(snapshot, now));

const verifiedRow = (row) => row
  && typeof row.ticker === 'string' && row.ticker.trim() !== ''
  && typeof row.source === 'string' && row.source.trim() !== ''
  && Number.isFinite(Date.parse(row.asOf)) && Date.parse(row.asOf) <= Date.now()
  && VALID_QUOTE_STATUSES.has(row.status)
  && !hasRejectedEvidence(row) ? row : null;

const timestamp = (value) => {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(parsed);
  }
  const parts = new Intl.DateTimeFormat('en-US', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'America/New_York',
  }).formatToParts(parsed);
  const part = (key) => parts.find((entry) => entry.type === key)?.value || '';
  return `${part('month')} ${part('day')} ${part('hour')}:${part('minute')} ET`;
};

const rowDetail = (row, methodology = '') => [
  methodology,
  row?.detail,
  timestamp(row?.cutoff) ? `Comparison through ${timestamp(row.cutoff)}` : '',
  row ? `${row.retained ? 'D · Last verified reading · ' : ''}${row.status === 'live' && !row.retained ? 'LIVE' : 'DELAYED'} · ${timestamp(row.asOf)}${row.delayedSource ? ' · DELAYED SOURCE' : ''}${row.marketDate ? ` · Session ${row.marketDate}` : ''}` : 'UNAVAILABLE',
  row?.source,
  row?.sourceUrl,
].filter(Boolean).join('\n');

const Signed = ({ value, unit = '%' }) => (
  <span className={`market-daily-strip__number ${tone(value)}`}>
    {unit === '%' ? percent(value) : finite(value) ? `${Number(value) > 0 ? '+' : ''}${Number(value).toFixed(2)} ${unit}` : UNAVAILABLE}
  </span>
);

const BreadthCount = ({ value, direction }) => {
  const display = count(value);
  return <span className={display === UNAVAILABLE ? 'is-neutral' : direction}>{display}</span>;
};

const partialHistory = (eligible, total) => finite(eligible) && finite(total)
  && Number(eligible) > 0 && Number(eligible) < Number(total);
const historyDetail = (label, eligible, total) => `${label} history: ${count(eligible)} / ${count(total)} holdings.${partialHistory(eligible, total) ? ` * History available for ${count(eligible)} of ${count(total)} holdings; denominator excludes holdings without the complete window.` : ''}`;
const HistoryMarker = ({ present, eligible, total, label }) => present && partialHistory(eligible, total)
  ? <span className="market-daily-strip__coverage" title={historyDetail(label, eligible, total)} aria-label={`${label}: partial history coverage`}>*</span>
  : null;

const Panel = ({ section, title, label, detail, status, observation, onExpand, expanded, detailId, children }) => (
  <section className="market-daily-strip__panel" data-daily-section={section} aria-label={label}>
    <h2 className="market-daily-strip__heading" title={detail}>
      <button type="button" className="market-daily-strip__expand" onClick={onExpand} aria-label={`Expand ${label.toLowerCase()}`} aria-haspopup="dialog" aria-expanded={expanded} aria-controls={expanded ? detailId : undefined}>
        <span>{title}</span>
      </button>
      {status === 'D' && observation ? <DelayedDataMarker
        status={observation.retained ? 'refresh-delayed' : 'delayed'}
        updatedAt={observation.asOf}
        marketSessionDate={observation.marketDate}
        popoverLabel={`Updated ${timestamp(observation.asOf)}`}
        className="market-daily-strip__status"
      /> : status ? <span className="market-daily-strip__status">{status}</span> : null}
    </h2>
    {children}
  </section>
);

const MetricTable = ({ label, children, variant = '' }) => (
  <table className={`market-daily-strip__table ${variant}`} aria-label={label}>
    <colgroup><col className="market-daily-strip__label-col" /><col /></colgroup>
    <tbody>{children}</tbody>
  </table>
);

const MetricRow = ({ label, children, detail }) => (
  <tr title={detail}><td>{label}</td><td className="market-daily-strip__value">{children}</td></tr>
);

const NamedChange = ({ row, contribution = false }) => row ? (
  <span className="market-daily-strip__named-value">
    <span className="market-daily-strip__security" title={row.name || row.ticker}>{contribution ? row.ticker : row.name || row.ticker}</span>
    <Signed value={contribution ? row.contributionPp : row.changePercent} unit={contribution ? 'pp' : '%'} />
  </span>
) : UNAVAILABLE;

const MoverCells = ({ row, divider = false }) => (
  <>
    <td className={divider ? 'market-daily-strip__divider' : undefined} title={rowDetail(row)}>{row?.ticker || UNAVAILABLE}</td>
    <td className="market-daily-strip__security" title={row ? `${row.name || row.ticker}\n${rowDetail(row)}` : 'UNAVAILABLE'}>{row?.name || UNAVAILABLE}</td>
    <td className="market-daily-strip__value" title={rowDetail(row)}><Signed value={row?.changePercent} /></td>
  </>
);

const MarketPulseRibbon = ({ snapshot: suppliedSnapshot, rotationSnapshot }) => {
  const { snapshot: fetchedSnapshot, loading } = useMarketDailySnapshot({ enabled: suppliedSnapshot === undefined });
  const { snapshot: fetchedRotation, loading: rotationLoading } = useMarketRotationSnapshot({ enabled: rotationSnapshot === undefined });
  const rotation = validateMarketRotationSnapshot(rotationSnapshot === undefined ? fetchedRotation : rotationSnapshot, Date.now(), true);
  const [expanded, setExpanded] = useState([]);
  const [allView, setAllView] = useState(false);
  const detailId = useId();
  const gridRef = useRef(null);
  const detailTrigger = useRef(null);
  const closeDetail = useCallback(() => {
    setExpanded([]);
    setAllView(false);
  }, []);
  const expansionId = section => `${detailId}-${section}`;
  const allExpanded = expanded.length === SECTION_ORDER.length;
  const toggleDetail = (section, event) => {
    detailTrigger.current = event.currentTarget;
    if (section === 'all') setAllView(!allExpanded);
    else if (expanded.length === 0) setAllView(false);
    setExpanded(current => {
      if (section === 'all') return current.length === SECTION_ORDER.length ? [] : SECTION_ORDER;
      if (current.includes(section)) return current.filter(id => id !== section);
      return current.length > 1 ? [...current, section] : [section];
    });
  };

  useEffect(() => {
    if (expanded.length === 0) return undefined;
    const handleKey = event => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      closeDetail();
      detailTrigger.current?.focus?.();
    };
    const handleOutside = event => {
      const target = event.target;
      const inExpansion = expanded.some(section => document.getElementById(`${detailId}-${section}`)?.contains(target));
      const header = target.closest?.('.market-daily-strip__heading, .market-daily-strip__all');
      if (!inExpansion && !gridRef.current?.contains(header)
        && !target.closest?.('.dashboard-delayed-data-timestamp')) closeDetail();
    };
    document.addEventListener('keydown', handleKey, true);
    document.addEventListener('pointerdown', handleOutside);
    return () => {
      document.removeEventListener('keydown', handleKey, true);
      document.removeEventListener('pointerdown', handleOutside);
    };
  }, [expanded, detailId, closeDetail]);
  const candidate = suppliedSnapshot === undefined ? fetchedSnapshot : suppliedSnapshot;
  const snapshot = validateMarketDailySnapshot(candidate);
  const breadth = snapshot?.breadth || {};
  const coverage = snapshot?.coverage || {};
  const universe = snapshot?.universe?.label || 'S&P 500 · SPY';
  const totalHoldings = coverage.total || snapshot?.universe?.count;
  const quoteRows = [
    ...(snapshot?.winners || []), ...(snapshot?.losers || []),
    ...Object.values(snapshot?.leadership || {}), ...Object.values(snapshot?.outliers || {}),
  ].filter(Boolean);
  const allLive = quoteRows.length > 0 && quoteRows.every((row) => row.status === 'live');
  const status = !snapshot ? 'UNAVAILABLE' : snapshot.retained ? 'D' : allLive ? '' : 'D';
  const observationDetail = evidence => evidence ? [
    `${evidence.universe?.label || universe} · ${count(evidence.coverage?.quotes)} / ${count(evidence.coverage?.total || evidence.universe?.count)} verified quotes`,
    `SPY equity holdings provide the constituent universe; this is an ETF proxy for the S&P 500. Holdings: ${timestamp(evidence.universe?.asOf)}.`,
    `${evidence.retained ? 'D · Last verified reading · ' : ''}${allLive && !evidence.retained ? 'LIVE' : 'DELAYED'} · ${timestamp(evidence.asOf)}`,
    evidence.marketDate ? `Session ${evidence.marketDate}` : '',
    evidence.source, evidence.sourceUrl,
  ].filter(Boolean).join('\n') : 'UNAVAILABLE · Waiting for verified observations.';
  const evidenceFor = group => snapshot?.referenceObservations?.[group] || snapshot;
  const detailFor = group => observationDetail(evidenceFor(group));
  const detail = observationDetail(snapshot);
  const coverageFor = group => evidenceFor(group)?.coverage || coverage;
  const totalFor = group => evidenceFor(group)?.universe?.count || totalHoldings;
  const observationFor = readings => [...readings.filter(Boolean)]
    .sort((left, right) => Date.parse(left.asOf) - Date.parse(right.asOf))[0];
  const statusFor = readings => readings.some(reading => reading && (reading.retained || reading.status !== 'live')) ? 'D' : undefined;
  const breadthObservation = observationFor(['breadth', 'above50', 'above200', 'highLow'].map(evidenceFor));

  const leaders = snapshot?.leadership || {};
  const outliers = snapshot?.outliers || {};
  const leadingSector = verifiedRow(leaders.leadingSector);
  const laggingSector = verifiedRow(leaders.laggingSector);
  const lift = verifiedRow(leaders.lift);
  const drag = verifiedRow(leaders.drag);
  const volume = verifiedRow(outliers.relativeVolume);
  const unusual = verifiedRow(outliers.unusualGain);
  const reversal = verifiedRow(outliers.reversal);
  const againstSector = verifiedRow(outliers.againstSector);
  const advancing = number(breadth.advancing);
  const declining = number(breadth.declining);
  const unchanged = number(breadth.unchanged);

  return (
    <div className="efr-market-pulse market-daily-strip" aria-label="Daily market readings" aria-busy={loading && !snapshot}>
      <div className="efr-market-pulse__metrics market-daily-strip__grid" ref={gridRef}>
        <Panel section="breadth" title="MARKET BREADTH · S&P 500" label="Market breadth" onExpand={event => toggleDetail('breadth', event)} expanded={expanded.includes('breadth')} detailId={expansionId('breadth')} detail={detail} status={status} observation={breadthObservation}>
          <MetricTable label="Market breadth readings" variant="market-daily-strip__breadth">
            <MetricRow label="Advancing / declining" detail={`${detailFor('breadth')}\nCounts use the same verified constituent universe; unchanged securities are counted separately.`}>
              {advancing == null && declining == null ? UNAVAILABLE : <><BreadthCount value={advancing} direction="is-positive" /> / <BreadthCount value={declining} direction="is-negative" />{unchanged != null ? ` (${count(unchanged)} flat)` : ''}</>}
            </MetricRow>
            <MetricRow label="Above 50D / 200D average" detail={`50D: ${detailFor('above50')}\n${historyDetail('50D', coverageFor('above50').history50, totalFor('above50'))}\n200D: ${detailFor('above200')}\n${historyDetail('200D', coverageFor('above200').history200, totalFor('above200'))}`}>
              {share(breadth.above50Pct)}<HistoryMarker present={share(breadth.above50Pct) !== UNAVAILABLE} eligible={coverageFor('above50').history50} total={totalFor('above50')} label="50D" /> / {share(breadth.above200Pct)}<HistoryMarker present={share(breadth.above200Pct) !== UNAVAILABLE} eligible={coverageFor('above200').history200} total={totalFor('above200')} label="200D" />
            </MetricRow>
            <MetricRow label="New 52-week highs / lows" detail={`${detailFor('highLow')}\nSecurities reaching a new 52-week extreme. ${historyDetail('52-week', coverageFor('highLow').year, totalFor('highLow'))}`}>
              <BreadthCount value={breadth.newHighs} direction="is-positive" /> / <BreadthCount value={breadth.newLows} direction="is-negative" /><HistoryMarker present={count(breadth.newHighs) !== UNAVAILABLE || count(breadth.newLows) !== UNAVAILABLE} eligible={coverageFor('highLow').year} total={totalFor('highLow')} label="52-week" />
            </MetricRow>
            <MetricRow label="Median constituent return" detail={`${detailFor('breadth')}\nMedian daily percentage return across the verified universe; each security has equal weight.`}><Signed value={breadth.medianReturn} /></MetricRow>
          </MetricTable>
        </Panel>
        <Panel section="leadership" title="LEADERSHIP · S&P 500" label="Sector leadership and SPY impact" onExpand={event => toggleDetail('leadership', event)} expanded={expanded.includes('leadership')} detailId={expansionId('leadership')} status={statusFor(Object.values(leaders))} observation={observationFor(Object.values(leaders))} detail={`${detail}\nContribution is based on published SPY fund weights, not official index contribution.`}>
          <MetricTable label="Leadership readings" variant="market-daily-strip__leadership">
            <MetricRow label="Leading sector" detail={rowDetail(leadingSector)}><NamedChange row={leadingSector} /></MetricRow>
            <MetricRow label="Lagging sector" detail={rowDetail(laggingSector)}><NamedChange row={laggingSector} /></MetricRow>
            <MetricRow label="SPY lift" detail={rowDetail(lift, 'Estimated SPY contribution = published ETF weight × daily security return, in percentage points.')}><NamedChange row={lift} contribution /></MetricRow>
            <MetricRow label="SPY drag" detail={rowDetail(drag, 'Estimated SPY contribution = published ETF weight × daily security return, in percentage points.')}><NamedChange row={drag} contribution /></MetricRow>
          </MetricTable>
        </Panel>
        <MarketThemePanel themes={rotation?.themes} loading={rotationLoading} onExpand={event => toggleDetail('themes', event)} expanded={expanded.includes('themes')} detailId={expansionId('themes')} />
        <MarketFactorPanel factors={rotation?.factors} loading={rotationLoading} onExpand={event => toggleDetail('factors', event)} expanded={expanded.includes('factors')} detailId={expansionId('factors')} />
        <Panel section="movers" title="WINNERS & LOSERS · S&P 500" label="Winners and losers" onExpand={event => toggleDetail('movers', event)} expanded={expanded.includes('movers')} detailId={expansionId('movers')} detail={detail} status={statusFor([...(snapshot?.winners || []), ...(snapshot?.losers || [])])} observation={observationFor([...(snapshot?.winners || []), ...(snapshot?.losers || [])])}>
          <table className="market-daily-strip__table market-daily-strip__movers" aria-label="Top three gainers and decliners">
            <colgroup><col /><col /><col /><col /><col /><col /></colgroup>
            <tbody>
              <tr><th>Ticker</th><th>Security</th><th className="market-daily-strip__value">Gain</th><th className="market-daily-strip__divider">Ticker</th><th>Security</th><th className="market-daily-strip__value">Decline</th></tr>
              {[0, 1, 2].map((index) => <tr key={index}><MoverCells row={verifiedRow(snapshot?.winners?.[index])} /><MoverCells row={verifiedRow(snapshot?.losers?.[index])} divider /></tr>)}
            </tbody>
          </table>
        </Panel>
        <Panel section="outliers" title="OUTLIERS · S&P 500" label="Daily market outliers" onExpand={event => toggleDetail('outliers', event)} expanded={expanded.includes('outliers')} detailId={expansionId('outliers')} detail={detail} status={statusFor(Object.values(outliers))} observation={observationFor(Object.values(outliers))}>
          <MetricTable label="Unusual activity readings" variant="market-daily-strip__outliers">
            <MetricRow label="Same-time relative volume" detail={rowDetail(volume, 'Cumulative regular-session volume compared with prior sessions at the same elapsed session time.')}>
              {volume && finite(volume.ratio) ? <>{volume.ticker} {Number(volume.ratio).toFixed(1)}× usual</> : UNAVAILABLE}
            </MetricRow>
            <MetricRow label="Largest gain in 40 sessions" detail={rowDetail(unusual, 'Daily return compared with the preceding 40 sessions at the same session time.')}>
              {unusual ? <>{unusual.ticker} <Signed value={unusual.changePercent} /></> : UNAVAILABLE}
            </MetricRow>
            <MetricRow label="Open → now" detail={rowDetail(reversal, 'Opening gap and latest return both use the prior regular-session close as their baseline.')}>
              {reversal ? <>{reversal.ticker} <Signed value={reversal.gapPercent} /> → <Signed value={reversal.changePercent} /></> : UNAVAILABLE}
            </MetricRow>
            <MetricRow label="Against its sector" detail={rowDetail(againstSector, `${againstSector?.sectorName || 'Sector'} comparison uses the same observation session.`)}>
              {againstSector ? <>{againstSector.ticker} <Signed value={againstSector.changePercent} /> / sector <Signed value={againstSector.sectorChangePercent} /></> : UNAVAILABLE}
            </MetricRow>
          </MetricTable>
        </Panel>
        <button type="button" className="market-daily-strip__all" aria-label="Open all daily market readings" aria-haspopup="dialog" aria-expanded={allExpanded} aria-controls={expanded.length ? SECTION_ORDER.filter(section => expanded.includes(section)).map(expansionId).join(' ') : undefined} title="All daily market readings" onClick={event => toggleDetail('all', event)}>+ All</button>
      </div>
      {allView && expanded.length > 0 && createPortal(<div className="market-daily-detail__backdrop" aria-hidden="true" />, document.body)}
      {SECTION_ORDER.filter(section => expanded.includes(section)).map(section => <MarketDailyDetailModal key={section} id={expansionId(section)} section={section} snapshot={snapshot} rotationSnapshot={rotation} anchor={gridRef.current?.querySelector(`[data-daily-section="${section}"]`)} />)}
    </div>
  );
};

export default MarketPulseRibbon;
