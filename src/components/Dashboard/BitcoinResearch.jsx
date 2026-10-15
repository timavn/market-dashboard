import React, { useEffect, useMemo, useState } from 'react';
import { X } from 'lucide-react';
import PopoverSelect from '../common/PopoverSelect';
import { bitcoinResearchDownloadHref, loadBitcoinResearchStudy } from '../../services/bitcoinResearchService';
import {
  bitcoinUsdRules, bitcoinMatrixAxes, loadBitcoinMatrixObservations,
  calculateBitcoinMatrixCell, selectBitcoinMatrixRows,
} from '../../services/bitcoinResearchMatrix';
import {
  MainResearchMatrix, ResearchFactorMatrix, heatColor,
  researchPercent as percent, researchCount as count, researchSample as sampleCount, researchDelta as signed,
} from './BitcoinResearchHeatmap';
import './BitcoinResearch.css';

const REGIMES = [{ id: 'bullish', label: 'Bullish' }, { id: 'neutral', label: 'Neutral' }, { id: 'bearish', label: 'Bearish' }];
const USD_STATES = [{ id: 'up', label: 'Up' }, { id: 'off', label: 'Off' }, { id: 'down', label: 'Down' }];
const VOLATILITY_STATES = [{ id: 'all', label: 'All' }, { id: 'investable', label: 'Investable' }, { id: 'chop', label: 'Chop' }, { id: 'uninvestable', label: 'Uninvestable' }];
const QUADS = [{ id: 'all', label: 'All quads' }, ...Array.from({ length: 15 }, (_, i) => {
  const quads = [1, 2, 3, 4].filter((q) => (i + 1) & (1 << (q - 1)));
  return { id: quads.join(','), label: quads.length === 4 ? 'All known quads' : quads.map((q) => `Q${q}`).join(' + ') };
}).sort((a, b) => a.id.split(',').length - b.id.split(',').length || a.id.localeCompare(b.id))];
const AXIS_FIELDS = { quad: 'quads', volume: 'volume', year: 'years', hour: 'hours', weekday: 'weekdays' };
const labelFor = (list, id) => list?.find((item) => item.id === id)?.label || id;
const dateFormat = (value) => new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(value));
const timeFormat = (value) => new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short' }).format(new Date(value));
const bounds = (value) => value ? `${value[0].toFixed(1)}–${value[1].toFixed(1)}%` : '—';
const delta = (sample, baseline) => Number.isFinite(sample?.pct) && Number.isFinite(baseline?.pct) ? sample.pct - baseline.pct : null;
const initialSetup = { cohort: 'bullish', zone: 'bottom', usdState: 'off', volatility: 'all' };
const setupKey = (setup) => [setup.cohort, setup.zone, setup.usdState, setup.volatility].join('|');

function ResearchSelect({ label, caption = label, value, options, onChange, className = '' }) {
  return <div className={`bitcoin-research__filter ${className}`}><span>{caption}</span>
    <PopoverSelect ariaLabel={label} value={value} options={options.map(({ id, label: text }) => ({ value: id, label: text }))}
      onChange={onChange} preferredPlacement="bottom" menuOffset={0} menuMatchButtonWidth showChevron showSelectionMark
      buttonClassName="bitcoin-research__select" menuClassName="bitcoin-research__menu" optionClassName="bitcoin-research__option" />
  </div>;
}

function availableAxes(axes, constraints) {
  const localYear = (date) => Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric' }).format(new Date(date)));
  return axes.map((sourceAxis) => {
    const axis = sourceAxis.id === 'year' && constraints.startAt && constraints.endAt
      ? { ...sourceAxis, values: sourceAxis.values.filter(({ id }) => Number(id) >= localYear(constraints.startAt) && Number(id) <= localYear(constraints.endAt)) }
      : sourceAxis;
    const applied = constraints[AXIS_FIELDS[axis.id]];
    if (axis.id === 'volume') return applied && applied !== 'all' ? null : axis;
    if (!Array.isArray(applied) || !applied.length) return axis;
    if (applied.length === 1) return null;
    return { ...axis, values: axis.values.filter((value) => value.constraints[AXIS_FIELDS[axis.id]]?.some((id) => applied.includes(id))) };
  }).filter(Boolean).sort((a, b) => ['quad', 'volume', 'year', 'weekday', 'hour'].indexOf(a.id) - ['quad', 'volume', 'year', 'weekday', 'hour'].indexOf(b.id));
}

export default function BitcoinResearch({ onClose }) {
  const [research, setResearch] = useState(null);
  const [data, setData] = useState(null);
  const [status, setStatus] = useState('loading');
  const [dataStatus, setDataStatus] = useState('loading');
  const [revision, setRevision] = useState(0);
  const [intervalId, setIntervalId] = useState('hourly');
  const [period, setPeriod] = useState('5');
  const [sampling, setSampling] = useState('all_hours');
  const [quad, setQuad] = useState('all');
  const [usdRule, setUsdRule] = useState('main');
  const [outcome, setOutcome] = useState('up');
  const [minimum, setMinimum] = useState('30');
  const [setup, setSetup] = useState(initialSetup);
  const [layers, setLayers] = useState([]);
  const [rowAxisId, setRowAxisId] = useState('quad');
  const [columnAxisId, setColumnAxisId] = useState('volume');
  const [refinement, setRefinement] = useState(null);
  const [detail, setDetail] = useState(null);
  const hourly = intervalId === 'hourly';
  const unit = hourly ? 'hours' : intervalId === 'daily' ? 'sessions' : 'days';
  const sampleHeading = hourly ? 'Hours / days' : intervalId === 'daily' ? 'Sessions' : 'Days';

  useEffect(() => {
    const controller = new AbortController();
    setStatus('loading');
    setResearch(null);
    loadBitcoinResearchStudy({ signal: controller.signal }).then((result) => {
      if (!controller.signal.aborted) { setResearch(result); setStatus('ready'); }
    }).catch(() => { if (!controller.signal.aborted) setStatus('unavailable'); });
    return () => controller.abort();
  }, [revision]);
  const study = useMemo(() => research?.intervals.find(({ id }) => id === intervalId), [research, intervalId]);
  useEffect(() => {
    if (!study) return undefined;
    const controller = new AbortController();
    setDataStatus('loading');
    setData(null);
    loadBitcoinMatrixObservations(study, { signal: controller.signal }).then((result) => {
      if (!controller.signal.aborted) { setData(result); setDataStatus('ready'); }
    }).catch(() => { if (!controller.signal.aborted) { setData(null); setDataStatus('unavailable'); } });
    return () => controller.abort();
  }, [study, revision]);
  const dataset = data?.intervalId === intervalId ? data : null;
  const options = useMemo(() => ({ outcome, minimumObservations: Number(minimum), minimumDays: hourly ? (minimum === '100' ? 30 : 10) : Number(minimum) }), [outcome, minimum, hourly]);
  const globalConditions = useMemo(() => {
    if (!study) return {};
    const start = new Date(study.endAt);
    start.setUTCFullYear(start.getUTCFullYear() - Number(period));
    return { usdRule, quads: quad === 'all' ? [] : quad.split(',').map(Number),
      entryMode: hourly ? sampling : 'all_days',
      startAt: period === '5' ? study.startAt : new Date(Math.max(start.getTime(), Date.parse(study.startAt))).toISOString(), endAt: study.endAt };
  }, [study, period, usdRule, quad, hourly, sampling]);
  const baseConditions = useMemo(() => ({ ...globalConditions, ...setup }), [globalConditions, setup]);
  const currentConditions = useMemo(() => Object.assign({}, baseConditions, ...layers.map((layer) => layer.constraints)), [baseConditions, layers]);
  const axes = useMemo(() => dataset ? bitcoinMatrixAxes(dataset) : [], [dataset]);
  const remainingAxes = useMemo(() => availableAxes(axes, currentConditions), [axes, currentConditions]);
  const rowAxis = remainingAxes.find(({ id }) => id === rowAxisId) || remainingAxes[0];
  const columnAxis = remainingAxes.find(({ id }) => id === columnAxisId && id !== rowAxis?.id) || remainingAxes.find(({ id }) => id !== rowAxis?.id);
  const visibleColumns = columnAxis?.values || [{ id: 'all', label: 'All observations', constraints: {} }];
  const rules = useMemo(() => study ? bitcoinUsdRules(study) : [], [study]);
  const clearLayers = () => { setLayers([]); setRefinement(null); setRowAxisId('quad'); setColumnAxisId('volume'); };
  const changeControl = (setter) => (value) => { setter(value); clearLayers(); };

  const mainRows = useMemo(() => !dataset || !study ? [] : REGIMES.flatMap((regime) => study.zones.map((zone, zoneIndex) => ({
    key: `${regime.id}-${zone.id}`, cohort: regime.id, cohortLabel: regime.label, zoneLabel: zone.label, first: zoneIndex === 0, zoneCount: study.zones.length,
    cells: USD_STATES.flatMap((usd) => VOLATILITY_STATES.map((volatility, index) => {
      const cellSetup = { cohort: regime.id, zone: zone.id, usdState: usd.id, volatility: volatility.id };
      const unavailable = volatility.id !== 'all' ? 'BTC volatility history and regime bands are unavailable.' : null;
      return { key: setupKey(cellSetup), setup: cellSetup, groupStart: index === 0, unavailable,
        label: `${regime.label} · ${zone.label} · USD ${usd.label} · ${volatility.label} volatility`,
        sample: unavailable ? null : calculateBitcoinMatrixCell(dataset, { ...globalConditions, ...cellSetup }, options) };
    })),
  }))), [dataset, study, globalConditions, options]);
  const baseSample = useMemo(() => dataset ? calculateBitcoinMatrixCell(dataset, baseConditions, options) : null, [dataset, baseConditions, options]);
  const parentSample = useMemo(() => dataset ? calculateBitcoinMatrixCell(dataset, currentConditions, options) : null, [dataset, currentConditions, options]);
  const completeFields = useMemo(() => [...new Set([...(currentConditions.completeFields || []), rowAxis?.id, columnAxis?.id].filter(Boolean))], [currentConditions.completeFields, rowAxis?.id, columnAxis?.id]);
  const comparableConditions = useMemo(() => ({ ...currentConditions, completeFields }), [currentConditions, completeFields]);
  const comparableSample = useMemo(() => dataset ? calculateBitcoinMatrixCell(dataset, comparableConditions, options) : null, [dataset, comparableConditions, options]);
  const factorRows = useMemo(() => !dataset || !rowAxis ? [] : rowAxis.values.map((row) => ({ ...row,
    cells: (columnAxis?.values || [{ id: 'all', label: 'All observations', constraints: {} }]).map((column) => {
      const constraints = { ...row.constraints, ...column.constraints };
      return { key: `${rowAxis.id}:${row.id}|${columnAxis?.id || 'all'}:${column.id}`, constraints,
        label: `${row.label} · ${column.label}`,
        sample: calculateBitcoinMatrixCell(dataset, { ...comparableConditions, ...constraints }, options) };
    }),
  })), [dataset, rowAxis, columnAxis, comparableConditions, options]);
  const selectedRefinement = factorRows.flatMap((row) => row.cells).find((cell) => cell.key === refinement);
  const canApplyRefinement = Boolean(selectedRefinement && (
    Object.entries(selectedRefinement.constraints).some(([key, value]) => {
      const previous = currentConditions[key] ?? (key === 'volume' ? 'all' : []);
      return JSON.stringify(value) !== JSON.stringify(previous);
    }) || completeFields.some((field) => ['quad', 'volume', 'volatility'].includes(field) && !currentConditions.completeFields?.includes(field))
  ));
  const finalConditions = useMemo(() => selectedRefinement ? { ...comparableConditions, ...selectedRefinement.constraints } : currentConditions, [selectedRefinement, comparableConditions, currentConditions]);
  const selectedSample = useMemo(() => dataset ? calculateBitcoinMatrixCell(dataset, finalConditions, { ...options, interval: true }) : null, [dataset, finalConditions, options]);
  const yearly = useMemo(() => detail !== 'year' || !dataset ? [] : (axes.find(({ id }) => id === 'year')?.values || []).filter((year) => !finalConditions.years?.length || year.constraints.years.some((id) => finalConditions.years.includes(id)))
    .map((year) => ({ ...year, sample: calculateBitcoinMatrixCell(dataset, { ...finalConditions, ...year.constraints }, options) })), [detail, dataset, axes, finalConditions, options]);
  const setupLabel = `${labelFor(REGIMES, setup.cohort)} › ${labelFor(study?.zones, setup.zone)} › USD ${labelFor(USD_STATES, setup.usdState)} › ${labelFor(VOLATILITY_STATES, setup.volatility)} volatility`;
  const layerSamples = useMemo(() => !dataset ? [] : layers.map((layer, index) => ({ ...layer, sample: calculateBitcoinMatrixCell(dataset, Object.assign({}, baseConditions, ...layers.slice(0, index + 1).map((item) => item.constraints)), options) })), [dataset, layers, baseConditions, options]);
  const exportSelection = () => {
    if (!dataset) return;
    const rows = selectBitcoinMatrixRows(dataset, finalConditions);
    const contents = JSON.stringify({ status: 'historical', interval: intervalId, conditions: finalConditions, summary: selectedSample, observations: rows }, null, 2);
    const href = URL.createObjectURL(new Blob([contents], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = href; anchor.download = `bitcoin-${intervalId}-selected-setup.json`; anchor.click();
    setTimeout(() => URL.revokeObjectURL(href), 0);
  };
  const showDetail = (id) => setDetail((current) => current === id ? null : id);
  const ready = status === 'ready' && dataStatus === 'ready' && dataset && study;
  const unavailable = status === 'unavailable' || (status === 'ready' && dataStatus === 'unavailable');

  return <section className="bitcoin-research" aria-label="Bitcoin Research" aria-busy={!ready && !unavailable}>
    <h2 className="sr-only">Bitcoin Research</h2>
    <div className="bitcoin-research__body">
      <div className="bitcoin-research__toolbar">
        {study && <>
          <ResearchSelect label="Historical US Quad" value={quad} options={QUADS} onChange={changeControl(setQuad)} className="bitcoin-research__quad" />
          <ResearchSelect label="Study" value={period} options={[{ id: '5', label: '5Y' }, { id: '3', label: '3Y' }, { id: '1', label: '1Y' }]} onChange={changeControl(setPeriod)} />
          <ResearchSelect label="Interval" value={intervalId} options={research.intervals} onChange={changeControl(setIntervalId)} />
          {hourly && <ResearchSelect label="Sampling" value={sampling} options={study.entryModes} onChange={changeControl(setSampling)} />}
          <ResearchSelect label="Outcome" value={outcome} options={[{ id: 'up', label: 'Up closes %' }, { id: 'down', label: 'Down closes %' }]} onChange={setOutcome} />
          <ResearchSelect label="USD rule" value={usdRule} options={rules} onChange={changeControl(setUsdRule)} className="bitcoin-research__dollar" />
        </>}
        <button className="bitcoin-research__close" type="button" onClick={onClose} aria-label="Close Bitcoin Research"><X size={16} /></button>
      </div>
      {!ready && <p role="status" className="bitcoin-research__status">{unavailable ? <>UNAVAILABLE <button type="button" onClick={() => setRevision((value) => value + 1)}>Retry</button></> : 'Loading research…'}</p>}
      {ready && <>
        <div className="bitcoin-research__settings">
          <ResearchSelect label="Minimum sample" value={minimum} options={[{ id: '30', label: hourly ? '30 hours / 10 days' : `30 ${unit}` }, { id: '100', label: hourly ? '100 hours / 30 days' : `100 ${unit}` }]} onChange={setMinimum} />
          <span>BTC volatility buckets: UNAVAILABLE · bands not defined</span>
          <span className="bitcoin-research__historical">US Quad: retrospective actuals</span>
        </div>
        <MainResearchMatrix rows={mainRows} usdStates={USD_STATES} volatilityStates={VOLATILITY_STATES} selected={setupKey(setup)}
          onSelect={(cell) => { setSetup(cell.setup); clearLayers(); }} hourly={hourly} outcome={outcome} />
        <div className="bitcoin-research__selection" aria-label="Selected setup">
          <strong>SELECTED SETUP</strong><span>{labelFor(QUADS, quad)} › {setupLabel}</span>
          <span className="bitcoin-research__selection-value">{percent(baseSample?.pct)} · {sampleCount(baseSample, hourly)} {sampleHeading.toLowerCase()}</span>
        </div>
        {layerSamples.length > 0 && <div className="bitcoin-research__layers" aria-label="Applied layers">{layerSamples.map((layer, index) => <div key={`${index}-${layer.label}`}>
          <span>Layer {index + 1} · {layer.label}</span><span>{percent(layer.sample.pct)} · {sampleCount(layer.sample, hourly)}</span>
          <button type="button" aria-label={`Remove layer ${index + 1} and later layers`} onClick={() => { setLayers((value) => value.slice(0, index)); setRefinement(null); }}>Remove</button>
        </div>)}</div>}
        {rowAxis ? <>
          <div className="bitcoin-research__refine-controls">
            <strong>Refine selected setup</strong>
            <ResearchSelect label="Rows" value={rowAxis.id} options={remainingAxes} onChange={(value) => { setRowAxisId(value); setColumnAxisId(remainingAxes.find(({ id }) => id !== value)?.id); setRefinement(null); }} />
            {columnAxis && <ResearchSelect label="Columns" value={columnAxis.id} options={remainingAxes.filter(({ id }) => id !== rowAxis.id)} onChange={(value) => { setColumnAxisId(value); setRefinement(null); }} />}
            <span className="bitcoin-research__parent" title="Parent with complete inputs for both refinement axes; see Coverage for exclusions">Comparable parent: {percent(comparableSample?.pct)} · {sampleCount(comparableSample, hourly)}</span>
          </div>
          <ResearchFactorMatrix rows={factorRows} columns={visibleColumns} rowAxis={rowAxis} columnAxis={columnAxis} selected={refinement}
            onSelect={(cell) => setRefinement(cell.key)} hourly={hourly} />
        </> : <p className="bitcoin-research__note">All available factors are applied. Remove a layer to explore another combination.</p>}
        <div className="bitcoin-research__refinement" aria-label="Selected refinement">
          <span>{selectedRefinement ? selectedRefinement.label : 'Select a refinement below the main matrix'}</span>
          <span>{percent(selectedSample?.pct)}</span>
          <span>Δ {selectedRefinement ? signed(delta(selectedSample, comparableSample)) : '—'} pp</span>
          <span>{sampleCount(selectedSample, hourly)} {sampleHeading.toLowerCase()}</span>
          <span title="95% interval from resampling New York day blocks">95% interval {bounds(selectedSample?.pct95)}</span>
          <button type="button" disabled={!canApplyRefinement} onClick={() => {
            if (!canApplyRefinement) return;
            setLayers((value) => [...value, { label: selectedRefinement.label, constraints: { ...selectedRefinement.constraints, completeFields } }]);
            setRefinement(null);
          }}>Apply &amp; add layer</button>
        </div>
        <footer className="bitcoin-research__footer">
          <div className="bitcoin-research__links">{[['coverage', 'Coverage'], ['year', 'Year by year'], ['method', 'Method & sources'], ['export', 'Export']].map(([id, label]) => <button key={id} type="button" aria-expanded={detail === id} aria-controls="bitcoin-research-detail" onClick={() => showDetail(id)}>{label}</button>)}</div>
          <span>Cells: close % · {sampleHeading.toLowerCase()}. † Below sample minimum.</span>
          <span className="bitcoin-research__legend">{[40, 50, 60, 70].map((value) => <span key={value}><i style={{ backgroundColor: heatColor(value) }} />{value}%</span>)}</span>
        </footer>
        {detail && <section id="bitcoin-research-detail" className="bitcoin-research__detail" aria-label={detail === 'year' ? 'Year by year' : detail === 'method' ? 'Method and sources' : detail === 'export' ? 'Research exports' : 'Research coverage'}>
          {detail === 'coverage' && <>
            <h3>Coverage</h3>
            <p>Historical study · {dateFormat(study.startAt)}–{dateFormat(study.endAt)} {timeFormat(study.endAt)}. Report history is discontinuous.</p>
            <p>Verified signal and range: {count(study.coverage.eligibleEntryIntervals)} {unit}; unknown signal: {count(study.coverage.unknownSignalIntervals)} {unit}; missing complete price intervals: {count(study.coverage.missingIntervalCount)}.</p>
            <p>Selected parent: {sampleCount(parentSample, hourly)} {sampleHeading.toLowerCase()}. Complete inputs for this refinement: {sampleCount(comparableSample, hourly)}. Excluded before resampling: {count(Math.max(0, selectBitcoinMatrixRows(dataset, { ...currentConditions, entryMode: hourly ? 'all_hours' : 'all_days' }).length - selectBitcoinMatrixRows(dataset, { ...comparableConditions, entryMode: hourly ? 'all_hours' : 'all_days' }).length))} {unit}.</p>
            <p>USD Off keeps observations without dollar coverage. Quad selections exclude unclassified quarters. Volatility buckets remain unavailable until historical inputs and BTC-specific bands are defined.</p>
          </>}
          {detail === 'year' && <>
            <h3>Selected setup · year by year</h3>
            <table aria-label="Selected setup by year"><thead><tr><th>Year</th><th>{sampleHeading}</th><th>{outcome === 'up' ? 'Up' : 'Down'} closes</th><th>Mean return</th><th>Median return</th></tr></thead>
              <tbody>{yearly.map((year) => <tr key={year.id}><th scope="row">{year.label}</th><td>{sampleCount(year.sample, hourly)}</td><td>{percent(year.sample.pct)}{year.sample.observations > 0 && year.sample.limitedSample ? ' †' : ''}</td><td>{percent(year.sample.meanReturnPct, 3)}</td><td>{percent(year.sample.medianReturnPct, 3)}</td></tr>)}</tbody></table>
          </>}
          {detail === 'method' && <>
            <h3>Method &amp; sources</h3>
            <p>Historical Coinbase BTC-USD open-to-close frequencies. Every added condition is applied to the same underlying observations before sampling; separate percentages are never multiplied. Unchanged closes remain in the denominator.</p>
            <p>Refinement differences use the parent with complete inputs for both displayed factors. First per day is recomputed after all conditions; a child can select a different hour on the same date. 95% intervals resample New York calendar days. These exploratory comparisons are not adjusted for multiple testing.</p>
            <p>Historical US Quads are retrospective actual-quarter classifications, not forecasts known at entry. They describe historical groups and do not establish an entry-time Quad rule.</p>
            {[...new Set([...(study.methodology || []), ...(study.volume?.methodology || [])])].map((line) => <p key={line}>{line}</p>)}
          </>}
          {detail === 'export' && <>
            <h3>Export</h3><button type="button" onClick={exportSelection}>Selected setup and observations</button>
            <div className="bitcoin-research__downloads"><a href="/research/bitcoin/matrix-method.md" download>Matrix methodology</a>{(study.downloads || []).map((item) => {
              const href = bitcoinResearchDownloadHref(item.href);
              return href ? <a key={href} href={href} download>{item.label}</a> : null;
            })}</div>
          </>}
        </section>}
      </>}
    </div>
  </section>;
}
