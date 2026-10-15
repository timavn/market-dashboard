import React, { useCallback, useState } from 'react';
import {
  GDP_SELECTED_QUARTER, GDP_UNIT, GDP_HISTORY_STAGES, buildGdpContractRows, gdpNumber, gdpQuarterLabel,
  gdpShortQuarter, gdpSigned, gdpSourceUrl, gdpThresholdGap, selectGdpForecasts, selectGdpReadings, selectGdpSchedule,
  buildGdpReleaseHistory, selectGdpPreReleaseForecasts, buildGdpComponentComparison, selectGdpNearbyContracts, selectGdpQuarterEstimates,
} from '../../utils/gdpPredictionMarket';
import GdpReleaseHistoryChart from './GdpReleaseHistoryChart';
import GdpDetailModal from './GdpDetailModal';
import './GdpPredictionMarketCard.css';

const SOURCES = [{ id: 'hedgeye', label: 'Hedgeye' }, { id: 'gdpnow', label: 'GDPNow' }, { id: 'consensus', label: 'Consensus' }];
const TARGETS = { advance: 'First reading', second: 'First revision', third: 'Third reading', initial: 'Initial reading', updated: 'Updated reading', annual: 'Annual update' };
const percent = (value, digits = 1) => gdpNumber(value) === null ? '—' : `${Number(value).toFixed(digits)}%`;
const number = (value) => gdpNumber(value) === null ? '—' : Number(value).toLocaleString('en-US');
const tone = (value) => gdpNumber(value) === null || Number(value) === 0 ? 'is-unavailable' : Number(value) > 0 ? 'is-positive' : 'is-negative';
const date = (value, options = {}) => Number.isFinite(Date.parse(value || ''))
  ? new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC', ...options }).format(new Date(value)) : '—';
const releaseTime = (value) => {
  if (!Number.isFinite(Date.parse(value || '')) || value.length === 10) return null;
  const time = (timeZone) => new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone })
    .format(new Date(value)).toLowerCase().replace('am', 'a.m.').replace('pm', 'p.m.');
  return `${time('America/Los_Angeles')} Pacific / ${time('America/New_York')} Eastern`;
};
const sourceLabel = (id) => SOURCES.find((source) => source.id === id)?.label || (id === 'bea' ? 'BEA' : id);
const SourceLink = ({ href, children }) => gdpSourceUrl(href)
  ? <a href={href} target="_blank" rel="noreferrer">{children}</a> : children;
const DetailLink = ({ children, onClick }) => <button type="button" className="pm-gdp-detail-link" onClick={onClick}>{children} <span aria-hidden="true">›</span></button>;
const Readings = ({ schedule, readings, label }) => <div className="pm-gdp-readings" aria-label={label}>
  {schedule.map((entry) => {
    const reading = readings.find((row) => row.stage === entry.stage);
    return <section key={entry.stage} aria-label={entry.label}>
      <h4>{entry.label}</h4><small><SourceLink href={entry.sourceUrl}>{date(entry.releaseAt)} · {entry.officialLabel}</SourceLink></small>
      <strong className={tone(reading?.value)}><SourceLink href={reading?.sourceUrl}>{percent(reading?.value)}</SourceLink></strong>
    </section>;
  })}
</div>;
const QuoteCell = ({ value, size }) => <td className={value === null ? 'is-unavailable' : ''}>
  <span>{value === null ? '—' : `${Number((value * 100).toFixed(2))}¢`}</span>
  {value !== null && <small>{size === null ? '—' : number(size)}</small>}
</td>;
const spread = (bid, ask) => bid !== null && ask !== null && ask >= bid ? `${Number(((ask - bid) * 100).toFixed(2))}¢` : '—';

function ContractTable({ rows, reference, showVolume = false }) {
  const nearest = gdpNumber(reference?.value) !== null && rows.length ? rows.reduce((best, row) =>
    Math.abs(row.threshold - reference.value) < Math.abs(best.threshold - reference.value) ? row : best) : null;
  return <div className="pm-gdp-table-wrap"><table className="pm-gdp-contract-table"><thead>
    <tr><th rowSpan="2" scope="col">Threshold</th><th colSpan="2" scope="colgroup">YES</th><th colSpan="2" scope="colgroup">NO</th>
      <th rowSpan="2" scope="col">Spread<small>YES / NO</small></th>{showVolume && <th rowSpan="2" scope="col">Volume</th>}
      <th rowSpan="2" scope="col" title="Published open interest">OI</th><th rowSpan="2" scope="col">Δ vs {sourceLabel(reference?.sourceId || 'hedgeye')}<small>(pp)</small></th></tr>
    <tr><th scope="col">Bid<small className="pm-gdp-sr-only">YES size below price</small></th><th scope="col">Ask<small className="pm-gdp-sr-only">YES size below price</small></th>
      <th scope="col">Bid<small className="pm-gdp-sr-only">NO size below price</small></th><th scope="col">Ask<small className="pm-gdp-sr-only">NO size below price</small></th></tr>
  </thead><tbody>{rows.map((row) => {
    const gap = gdpThresholdGap(row.threshold, reference?.value);
    const activitySource = row.activityAsOf ? `ForecastEx · ${date(row.activityAsOf, { year: 'numeric' })} · ${releaseTime(row.activityAsOf) || 'Publication date'}` : null;
    return <tr key={row.contractId || row.ticker} className={row === nearest ? 'pm-gdp-nearest' : ''}>
      <th scope="row">&gt; {percent(row.threshold)}</th>
      <QuoteCell value={row.yesBid} size={row.yesBidSize} /><QuoteCell value={row.yesAsk} size={row.yesAskSize} />
      <QuoteCell value={row.noBid} size={row.noBidSize} /><QuoteCell value={row.noAsk} size={row.noAskSize} />
      <td>{spread(row.yesBid, row.yesAsk)} / {spread(row.noBid, row.noAsk)}</td>
      {showVolume && <td title={`${row.volume24h !== null ? '24-hour volume' : 'Published volume · period unspecified'}${activitySource ? ` · ${activitySource}` : ''}`}>{number(row.volume24h ?? row.volume)}</td>}
      <td title={activitySource || undefined}>{number(row.openInterest)}</td><td className={tone(gap)}>{gdpSigned(gap, 2)}</td>
    </tr>;
  })}</tbody></table></div>;
}

function ComponentTable({ comparison, first, latest }) {
  const revision = first && latest && first.key !== latest.key ? gdpThresholdGap(latest.value, first.value) : null;
  return <table className="pm-gdp-component-table"><thead><tr><th>Component</th><th>First</th><th>Latest</th><th>Revision</th></tr></thead>
    <tbody>{comparison.rows.map((row) => <tr key={row.id}><th scope="row">{row.label}</th>
      <td className="is-unavailable">{gdpSigned(row.first, 2)}</td><td className={`pm-gdp-current ${tone(row.latest)}`}>{gdpSigned(row.latest, 2)}</td>
      <td className={tone(row.revision)}>{gdpSigned(row.revision, 2)}</td></tr>)}</tbody>
    <tfoot><tr><th scope="row">GDP growth</th><td>{percent(first?.value)}</td><td>{percent(latest?.value)}</td><td className={tone(revision)}>{revision === null ? '—' : `${gdpSigned(revision)} pp`}</td></tr></tfoot>
  </table>;
}

export default function GdpPredictionMarketCard({ snapshot, loading = false, nowMs = Date.now() }) {
  const [selectedKey, setSelectedKey] = useState(null);
  const [comparison, setComparison] = useState('gdpnow');
  const [gapSource, setGapSource] = useState('hedgeye');
  const [detail, setDetail] = useState(null);
  const [sourcePage, setSourcePage] = useState(0);
  const closeDetail = useCallback(() => setDetail(null), []);
  const openDetail = (name) => { setSourcePage(0); setDetail(name); };
  const quarter = GDP_SELECTED_QUARTER;
  const research = snapshot?.gdp?.quarter === quarter && snapshot.gdp.unit === GDP_UNIT
    && ['real_gdp', 'U.S. real GDP'].includes(snapshot.gdp.metric) ? snapshot.gdp : {};
  const schedule = selectGdpSchedule(research.schedule, quarter);
  const forecasts = selectGdpForecasts(research.forecasts, quarter, nowMs);
  const reference = forecasts.find((row) => row.sourceId === gapSource);
  const history = buildGdpReleaseHistory(research, nowMs);
  const selected = history.visible.find((row) => row.key === selectedKey) || history.visible.at(-1);
  const allForecasts = [...(research.historicalForecasts || []), ...(research.forecastHistory || []), ...(research.forecasts || []), ...(research.futureForecasts || [])];
  const quarterEstimates = selectGdpQuarterEstimates(allForecasts, quarter, nowMs);
  const preRelease = selectGdpPreReleaseForecasts(allForecasts, selected, nowMs);
  const selectedFirst = history.first.get(selected?.quarter);
  const selectedLatest = history.latest.get(selected?.quarter);
  const revision = selectedFirst && selectedLatest && selectedFirst.key !== selectedLatest.key ? gdpThresholdGap(selectedLatest.value, selectedFirst.value) : null;
  const components = buildGdpComponentComparison(research.components, selectedFirst, selectedLatest, nowMs);
  const largest = components.rows.filter((row) => row.latest !== null && row.latest > 0).sort((a, b) => b.latest - a.latest)[0];
  const revisionDriver = components.rows.filter((row) => row.revision !== null && row.revision !== 0).sort((a, b) => Math.abs(b.revision) - Math.abs(a.revision))[0];
  const { event, rows, live, asOf } = buildGdpContractRows(snapshot, quarter, nowMs);
  const nearby = selectGdpNearbyContracts(rows, reference?.value);
  const first = schedule.find((entry) => entry.stage === 'advance');
  const readings = selectGdpReadings(research.readings, quarter, GDP_UNIT, nowMs);
  const future = (research.futureForecasts || []).filter((r) => r.quarter > quarter && selectGdpForecasts([r], r.quarter, nowMs).length);
  const releaseMessage = first?.releaseAt && event?.resolutionAt
    ? `The ${date(first.releaseAt, { month: 'long', day: undefined })} report may move this contract’s price; ${date(event.resolutionAt, { month: 'long', day: undefined })}’s third reading decides it.`
    : 'The first report may move this contract’s price; the third reading decides it.';
  const matched = preRelease.find((f) => f.sourceId === comparison && f.matchedTarget);
  const revisionText = revision === null ? '' : revision === 0 ? 'Latest GDP is unchanged from the first print at displayed precision.'
    : `GDP was revised ${revision > 0 ? 'up' : 'down'} ${Math.abs(revision).toFixed(1)} pp from its first print.`;
  const takeaway = matched ? `${TARGETS[selected.stage]} ${matched.gap === 0 ? 'matched' : matched.gap > 0 ? 'exceeded' : 'was below'} ${sourceLabel(comparison)}${matched.gap === 0 ? '' : ` by ${Math.abs(matched.gap).toFixed(1)} pp`}. ${revisionText}` : revisionText;
  const sourceRows = [...history.readings.filter((r) => r.quarter === selected?.quarter),
    ...selectGdpForecasts(allForecasts, selected?.quarter, nowMs)]
    .filter((r, i, arr) => arr.findIndex((x) => (x.recordId || `${x.sourceId}:${x.publishedAt}:${x.value}`) === (r.recordId || `${r.sourceId}:${r.publishedAt}:${r.value}`)) === i)
    .sort((a, b) => Date.parse(b.publishedAt || b.releasedAt) - Date.parse(a.publishedAt || a.releasedAt));
  const board = <section aria-label="GDP forecast board"><h3>{gdpQuarterLabel(quarter)} forecasts</h3><table className="pm-gdp-source-table"><tbody>{SOURCES.map(({ id, label }) => {
    const forecast = forecasts.find((r) => r.sourceId === id);
    return <tr key={id}><th scope="row"><SourceLink href={forecast?.sourceUrl}>{label}</SourceLink><small>{forecast ? `${date(forecast.publishedAt)} · ${TARGETS[forecast.targetStage] || 'Release target unconfirmed'}` : 'UNAVAILABLE'}</small></th><td>{percent(forecast?.value, id === 'hedgeye' ? 2 : 1)}</td></tr>;
  })}</tbody></table></section>;

  return <article className="pm-gdp-card" aria-label="GDP prediction market" aria-busy={loading}>
    <header className="pm-gdp-header"><div><h2>U.S. REAL GDP · QoQ SAAR</h2>
      <p>Gray: earlier reading · Color: latest reading · <span className="pm-gdp-legend-mark" />: pre-release estimate · Dashed bars: Hedgeye forecasts</p></div>
      <label className="pm-gdp-compare">Compare: <select aria-label="GDP chart comparison source" value={comparison} onChange={(e) => setComparison(e.target.value)}>
        {['consensus', 'gdpnow', 'hedgeye'].map((id) => <option key={id} value={id}>{sourceLabel(id)}</option>)}
      </select></label></header>
    <GdpReleaseHistoryChart history={history} forecasts={allForecasts} comparison={comparison} selectedKey={selected?.key} onSelect={setSelectedKey} nowMs={nowMs}
      quarterEstimates={quarterEstimates} onForecastDetails={() => openDetail('Forecasts & schedule')} />
    <section className="pm-gdp-comparison-strip" aria-label="Selected GDP release comparison">
      <div className="pm-gdp-selected-label"><h3>{selected ? `Selected · ${date(selected.releasedAt, { day: undefined, year: 'numeric' })}` : 'Select a release'}</h3>
        <p>{gdpShortQuarter(selected?.quarter)} · {TARGETS[selected?.stage] || 'No published reading'}</p></div>
      <div><span>Actual</span><strong><SourceLink href={selected?.sourceUrl}>{percent(selected?.value)}</SourceLink></strong><small>{selected ? date(selected.releasedAt) : 'UNAVAILABLE'}</small></div>
      {['consensus', 'gdpnow', 'hedgeye'].map((id) => {
        const forecast = preRelease.find((f) => f.sourceId === id);
        return <div key={id} aria-label={`${sourceLabel(id)} selected-release estimate`}><span><SourceLink href={forecast?.sourceUrl}>{sourceLabel(id)}</SourceLink></span>
          <strong className={!forecast ? 'is-unavailable' : ''}>{percent(forecast?.value, id === 'hedgeye' ? 2 : 1)}</strong>
          <small className={forecast?.matchedTarget ? tone(forecast.gap) : ''}>{forecast ? forecast.matchedTarget ? `Actual ${gdpSigned(forecast.gap)} pp` : forecast.targetStage ? `${TARGETS[forecast.targetStage]} target` : 'Target unconfirmed' : 'UNAVAILABLE'}</small>
          {forecast && <small>{date(forecast.publishedAt)}</small>}</div>;
      })}
      <div><span>Latest reading</span><strong><SourceLink href={selectedLatest?.sourceUrl}>{percent(selectedLatest?.value)}</SourceLink></strong>
        <small className={tone(revision)}>{revision === null ? 'No revision yet' : revision === 0 ? 'Unchanged' : `Revised ${gdpSigned(revision)} pp`}</small>
        {selectedLatest && <small>{date(selectedLatest.releasedAt)} · {GDP_HISTORY_STAGES[selectedLatest.stage]}</small>}</div>
    </section>
    <div className="pm-gdp-history-footer"><p>{takeaway || (selected ? 'No matched, dated pre-release estimate available.' : 'Verified readings will appear after publication.')}</p>
      <span>Release sequence · {date(history.rangeStart, { day: undefined, year: 'numeric' })}–{date(history.rangeEnd, { day: undefined, year: 'numeric' })}</span>
      <DetailLink onClick={() => openDetail('Release sources & dates')}>Sources & dates</DetailLink></div>
    <div className="pm-gdp-bottom">
      <section className="pm-gdp-ladder" aria-label="GDP ForecastEx contract ladder">
        <header className="pm-gdp-contract-header"><div><h3>ForecastEx contracts · {gdpShortQuarter(quarter)}</h3>
          <p title={gdpQuarterLabel(quarter)}>First report: <strong>{date(first?.releaseAt)}</strong> · Contract decides: <strong>{date(event?.resolutionAt)} · Third reading</strong></p>
          <small>{releaseTime(event?.resolutionAt) || 'Release time unavailable'}</small></div>
          <div className="pm-gdp-gap-select"><label>Gap reference: <select aria-label="GDP contract gap reference" value={gapSource} onChange={(e) => setGapSource(e.target.value)}>
            {SOURCES.map(({ id, label }) => <option key={id} value={id}>{label} {percent(forecasts.find((f) => f.sourceId === id)?.value, id === 'hedgeye' ? 2 : 1)}</option>)}
          </select></label><small>{reference ? `${date(reference.publishedAt)} · ${TARGETS[reference.targetStage] || 'Target unconfirmed'}` : 'UNAVAILABLE'}</small></div>
        </header>
        <ContractTable rows={nearby} reference={reference || { sourceId: gapSource }} />
        {!rows.length && <p className="pm-gdp-empty">{loading ? 'Loading contracts…' : 'Contracts unavailable'}</p>}
        <div className="pm-gdp-contract-footer"><div><DetailLink onClick={() => openDetail('All ForecastEx thresholds')}>{nearby.length} of {rows.length} thresholds · All thresholds</DetailLink>
          <DetailLink onClick={() => openDetail('Forecasts & schedule')}>Forecasts & schedule</DetailLink></div>
          <div><span>Above is strict; equality loses YES.</span><span>Gap = threshold − forecast</span></div>
          <div className="pm-gdp-quote-status"><span className={live ? 'is-positive' : 'is-unavailable'}>{loading && !rows.length ? 'LOADING' : live ? 'LIVE' : 'UNAVAILABLE'}</span>
            {live && <small>IBKR · {date(asOf)} · {new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit', timeZoneName: 'short', timeZone: 'America/Los_Angeles' }).format(new Date(asOf))}</small>}
            <small>{rows.some((r) => r.volume !== null || r.volume24h !== null) ? 'Volume in all thresholds' : 'Volume unavailable'}</small>
            <DetailLink onClick={() => openDetail('Contract rules')}>Contract rules</DetailLink></div></div>
        <p className="pm-gdp-release-note">{releaseMessage}</p>
      </section>
      <section className="pm-gdp-components" aria-label="GDP growth components"><header><h3>What drove GDP · {gdpShortQuarter(selected?.quarter)}</h3>
        <p>First → latest reading · Contribution to growth (pp)</p></header>
        <ComponentTable comparison={components} first={selectedFirst} latest={selectedLatest} />
        <p className="pm-gdp-component-takeaway">{largest ? `${largest.label} contributed ${gdpSigned(largest.latest, 2)} pp to the latest print.` : 'Component contributions unavailable.'}
          {revisionDriver && ` ${revisionDriver.label} had the largest revision (${gdpSigned(revisionDriver.revision, 2)} pp).`}</p>
        <footer><span>Components follow the selected quarter.</span><DetailLink onClick={() => openDetail('Component detail')}>Component detail</DetailLink>
          <DetailLink onClick={() => openDetail('Methodology')}>Methodology</DetailLink></footer>
      </section>
    </div>
    {detail && <GdpDetailModal title={detail} onClose={closeDetail}>
      {detail === 'All ForecastEx thresholds' && <><p>{gdpQuarterLabel(quarter)} · {sourceLabel(gapSource)} reference {percent(reference?.value, 2)} · {date(reference?.publishedAt)} · {TARGETS[reference?.targetStage] || 'Target unconfirmed'}</p>
        <p className={live ? 'is-positive' : 'is-unavailable'}>{live ? `LIVE · IBKR · ${date(asOf)} · ${releaseTime(asOf)}` : 'Quotes unavailable'}</p>
        <ContractTable rows={rows} reference={reference || { sourceId: gapSource }} showVolume /></>}
      {detail === 'Forecasts & schedule' && <>{board}<Readings schedule={schedule} readings={readings} label="Q3 official GDP readings" />
        <p>Reviewed Hedgeye publications are dated references; their release target remains unconfirmed. {forecasts.find((f) => f.sourceId === 'hedgeye')?.modelType && `Q3 model: ${forecasts.find((f) => f.sourceId === 'hedgeye').modelType}. `}Consensus survey identity: {forecasts.find((f) => f.sourceId === 'consensus')?.surveyIdentity || 'unconfirmed'}.</p>
        {future.length > 0 && <><h3>Later-quarter forecasts</h3><ul>{future.map((r) => <li key={r.recordId || `${r.sourceId}-${r.quarter}-${r.publishedAt}`}><SourceLink href={r.sourceUrl}>{sourceLabel(r.sourceId)} · {gdpShortQuarter(r.quarter)} · {date(r.publishedAt)}</SourceLink> · {percent(r.value, 2)} · {r.modelType}</li>)}</ul></>}
      </>}
      {detail === 'Contract rules' && <div className="pm-gdp-rules"><p>YES requires the third estimate to be strictly above the threshold. Equality loses for YES.</p>
        <dl><div><dt>Measured period</dt><dd>{gdpQuarterLabel(quarter)}</dd></div><div><dt>Trading cutoff</dt><dd>{date(event?.closeTime, { year: 'numeric' })}<small>{releaseTime(event?.closeTime)}</small></dd></div>
          <div><dt>Deciding release</dt><dd>{date(event?.resolutionAt, { year: 'numeric' })}<small>Third estimate · {releaseTime(event?.resolutionAt) || 'UNAVAILABLE'}</small></dd></div>
          <div><dt>Expected payout</dt><dd>{date(event?.payoutAt, { year: 'numeric' })}<small>{releaseTime(event?.payoutAt) || 'Time unconfirmed'}</small></dd></div></dl>
        <p>{releaseMessage}</p><SourceLink href={event?.rulesUrl}>ForecastEx full contract rules ↗</SourceLink></div>}
      {detail === 'Release sources & dates' && <><p>{gdpShortQuarter(selected?.quarter)} · Publication history</p><table className="pm-gdp-source-table"><thead><tr><th>Source / reading</th><th>Published</th><th>Value</th><th>Target</th></tr></thead><tbody>
        {sourceRows.slice(sourcePage * 8, sourcePage * 8 + 8).map((r, i) => <tr key={r.recordId || `${r.sourceId}-${i}`}><th><SourceLink href={r.sourceUrl}>{sourceLabel(r.sourceId || 'bea')}{r.stage ? ` · ${GDP_HISTORY_STAGES[r.stage]}` : ''}</SourceLink></th>
          <td>{date(r.publishedAt || r.releasedAt, { year: 'numeric' })}</td><td>{percent(r.value, r.sourceId === 'hedgeye' ? 2 : 1)}</td><td>{r.stage ? 'Official reading' : TARGETS[r.targetStage] || 'Unconfirmed'}</td></tr>)}
      </tbody></table>{!sourceRows.length && <p className="is-unavailable">No dated publications available.</p>}
        {sourceRows.length > 8 && <div className="pm-gdp-pagination"><button type="button" disabled={!sourcePage} onClick={() => setSourcePage((p) => p - 1)}>Previous</button><span>{sourcePage + 1} / {Math.ceil(sourceRows.length / 8)}</span><button type="button" disabled={(sourcePage + 1) * 8 >= sourceRows.length} onClick={() => setSourcePage((p) => p + 1)}>Next</button></div>}
      </>}
      {detail === 'Component detail' && <><h3>{gdpShortQuarter(selected?.quarter)} · BEA table 1.1.2</h3><ComponentTable comparison={components} first={selectedFirst} latest={selectedLatest} />
        <p>First: <SourceLink href={components.first?.sourceUrl}>{date(components.first?.releasedAt, { year: 'numeric' })}</SourceLink> · Latest: <SourceLink href={components.latest?.sourceUrl}>{date(components.latest?.releasedAt, { year: 'numeric' })}</SourceLink></p>
        <p>Contributions are percentage points at annual rates. Fixed investment excludes inventory changes. Net exports includes the published imports contribution. Revisions equal latest minus first; rounded contributions may not add exactly to GDP growth.</p></>}
      {detail === 'Methodology' && <div className="pm-gdp-methodology">
        <p>Real GDP is inflation-adjusted. QoQ SAAR is the quarter-to-quarter change expressed at a seasonally adjusted annual rate. Base effects describe the comparison period.</p>
        <p>Equal-width panels group releases by measured quarter, with equally spaced release slots and consistent bar widths. This is a release sequence, not a calendar-time axis. The recent 12-month window includes complete quarter histories at its boundary so earlier readings remain visible. Gray marks superseded readings; color marks the latest for each quarter.</p>
        <p>Dates below bars are publication dates, including the year. Scheduled readings stay blank and marked Pending until published. Delayed reports retain their actual dates and BEA’s Initial/Updated labels; the chart links to BEA’s explanation where a release cycle changed.</p>
        <p>Dashed bars on the right show dated Hedgeye forecasts for the contract quarter and following quarter, on the same QoQ SAAR scale. They are separate from official readings and use Hedgeye’s published quarterly figures without reconstructing them from YoY forecasts.</p>
        <p>Estimate markers and actual-minus-estimate gaps require the same quarter, unit, and release target, published before that release. Same-day forecasts without a timestamp are excluded. Unknown targets remain unconfirmed. GDPNow targets the first reading; it is not a revision forecast.</p>
        <p>Revisions compare latest minus first reading. Component revisions use archived BEA table 1.1.2 from those exact publications, in percentage points. Headline growth is percent; rounding can leave small differences.</p>
        <p>Contract gaps equal threshold minus the dated forecast in percentage points. They are descriptive and do not imply probabilities or trading recommendations. The Q3 2026 contract stays pinned when historical selections change.</p>
        <p>Later Hedgeye forecasts are Enhanced Comparative Base Effects Model outputs when identified in reviewed source evidence. Quarterly forecasts are not reconstructed from year-over-year figures. Spreads use only the displayed native ask minus native bid; missing sides remain blank.</p>
      </div>}
    </GdpDetailModal>}
  </article>;
}
