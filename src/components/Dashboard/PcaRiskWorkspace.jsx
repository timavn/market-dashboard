import React, { useEffect, useRef, useState } from 'react';
import usePcaRisk from '../../hooks/usePcaRisk';
import { pcaRiskService } from '../../services/api/pcaRiskService';
import './PcaRiskWorkspace.css';

const finite = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
const number = (value, digits = 3) => finite(value) ? Number(value).toFixed(digits).replace(/\.?0+$/, '') : '—';
const pct = (value, signed = false, digits = 1) => finite(value) ? `${signed && Number(value) > 0 ? '+' : ''}${(Number(value) * 100).toFixed(digits)}%` : '—';
const tone = value => !finite(value) || Number(value) === 0 ? '' : Number(value) > 0 ? 'is-positive' : 'is-negative';
const pcName = component => `PC${component.rank || String(component.id || '').replace(/\D/g, '')}`;
const SOURCE_LABELS = { yahoo: 'Yahoo Finance', fred: 'FRED', cboe: 'Cboe' };
const TRANSFORM_LABELS = { adjusted_return: 'Adjusted daily return', yield_change_bp: 'Daily yield change (bp)', spread_change_bp: 'Daily spread change (bp)', fx_return: 'Daily FX return', fx_inverse_return: 'Inverted FX return', volatility_change: 'Daily volatility change (points)' };
const COVERAGE_REASONS = {
  account_mismatch: 'Holding account could not be verified', prediction_contract_unmodeled: 'Prediction contract outside this securities model',
  unsupported_instrument: 'Instrument type not supported', base_currency_conversion_unavailable: 'Verified USD conversion unavailable',
  security_identity_unverified: 'Security identity or trading currency unverified', security_identity_collision: 'Conflicting security identities',
  position_unverified: 'Position quantity or source unverified', official_close_unavailable: 'Verified session close unavailable',
  history_unavailable: 'Verified daily history unavailable', history_unverified: 'Daily history failed verification',
  history_duplicate_dates: 'Conflicting daily observations', history_timezone_unverified: 'History session timezone unverified',
  zero_variance_history: 'No daily return variation to standardize',
};

function identityChanged(component, model) {
  const continuity = component?.continuity;
  if (!continuity) return false;
  if (typeof continuity.comparedToPrevious === 'boolean') return continuity.comparedToPrevious && !continuity.previousComponentId;
  if (['unmatched', 'weak'].includes(continuity.status)) return true;
  if (['initial', 'insufficient_overlap'].includes(continuity.status)) return false;
  const knownPrior = continuity.comparedToPrevious === true || [...(model.components || []), ...(model.otherComponents || [])].some(row => row.continuity?.previousComponentId);
  return knownPrior && !continuity.previousComponentId;
}

function comparisonPair(before, after, { scale = 100, suffix = '%', digits = 2, maximumDigits = 6, trim = false } = {}) {
  const format = (value, precision) => {
    if (!finite(value)) return '—';
    const rounded = (Number(value) * scale).toFixed(precision);
    const normalized = Number(rounded) === 0 ? (0).toFixed(precision) : rounded;
    return `${trim ? normalized.replace(/\.?0+$/, '') : normalized}${suffix}`;
  };
  let precision = digits;
  while (precision < maximumDigits && finite(before) && finite(after) && Number(before) !== Number(after)
    && format(before, precision) === format(after, precision)) precision += 1;
  return [format(before, precision), format(after, precision)];
}

const varianceComparisonPair = (before, after) => comparisonPair(before, after, { scale: 10000, suffix: '', digits: 4, maximumDigits: 8, trim: true });
function comparisonChange(value) {
  if (!finite(value)) return '—';
  const points = Number(value) * 100;
  if (Math.abs(points) <= 1e-10) return '0';
  if (Math.abs(points) < 0.01) return `${points < 0 ? '↓' : '↑'} <0.01`;
  return `${points > 0 ? '+' : ''}${points.toFixed(2)}`;
}

function comparisonTradeoff(result) {
  const before = result.before || {}, after = result.after || {};
  const falls = (left, right) => {
    const pair = comparisonPair(left, right);
    return finite(left) && finite(right) && Number(right) < Number(left) - 1e-12 && pair[0] !== pair[1];
  };
  const rises = (left, right) => falls(right, left);
  const decreased = (result.components || []).find(row => falls(row.beforeRiskShare, row.afterRiskShare));
  const reduction = falls(before.maxRiskShare, after.maxRiskShare)
    ? `Largest PC risk share falls ${comparisonPair(before.maxRiskShare, after.maxRiskShare).join(' → ')}`
    : falls(before.topFiveRiskShare, after.topFiveRiskShare)
      ? `First-five PC risk share falls ${comparisonPair(before.topFiveRiskShare, after.topFiveRiskShare).join(' → ')}`
      : decreased ? `${pcName(decreased)} risk share falls ${comparisonPair(decreased.beforeRiskShare, decreased.afterRiskShare).join(' → ')}` : null;
  if (!reduction) return null;
  const increases = [
    rises(before.annualizedVolatility, after.annualizedVolatility) ? `total volatility rises ${comparisonPair(before.annualizedVolatility, after.annualizedVolatility).join(' → ')}` : null,
    finite(before.residualVariance) && finite(after.residualVariance) && after.residualVariance > before.residualVariance + 1e-12
      && varianceComparisonPair(before.residualVariance, after.residualVariance)[0] !== varianceComparisonPair(before.residualVariance, after.residualVariance)[1]
      ? `Other risk rises ${varianceComparisonPair(before.residualVariance, after.residualVariance).join(' → ')} %²/day` : null,
  ].filter(Boolean);
  return increases.length ? `${reduction}, while ${increases.join(' and ')}.` : null;
}

function coverageReason(gap, window, compact = false) {
  if (gap.reason === 'history_gap') return compact ? 'return history incomplete' : `Incomplete ${window}-session adjusted return history`;
  if (compact && gap.reason === 'official_close_unavailable') return 'session close unavailable';
  return COVERAGE_REASONS[gap.reason] || 'Required verified data unavailable';
}

function CoverageNotice({ coverage, partial, window }) {
  const gaps = coverage.excluded || coverage.excludedHoldings || coverage.unavailableHoldings || coverage.gaps || [];
  const label = `Equities & ETFs${finite(coverage.modeledCount) && finite(coverage.holdingCount) ? ` · ${coverage.modeledCount}/${coverage.holdingCount} modeled` : ''}`;
  if (!gaps.length) return <div className="pca-risk__coverage">{label}{partial ? ' · Coverage incomplete' : ''}</div>;
  const gapSummary = gaps.length === 1
    ? `${gaps[0].symbol || gaps[0].id || 'Unknown'}: ${coverageReason(gaps[0], window, true)}`
    : `${gaps.slice(0, 2).map(gap => gap.symbol || gap.id || 'Unknown').join(', ')}${gaps.length > 2 ? ` +${gaps.length - 2} more` : ''} unavailable`;
  return <details className="pca-risk__coverage" aria-label="Equity and ETF coverage">
    <summary>{label} · {gapSummary}</summary>
    <div className="pca-risk__table-scroll"><table aria-label="Excluded PCA securities"><thead><tr><th>Security</th><th>Unavailable data</th></tr></thead><tbody>{gaps.map((gap, index) => <tr key={gap.id || gap.symbol || index}><th scope="row">{gap.symbol || gap.id || 'Unknown'}</th><td>{coverageReason(gap, window)}</td></tr>)}</tbody></table></div>
    <p>Risk totals cover the modeled equities and ETFs.</p>
  </details>;
}

function dateLabel(value) {
  if (!value) return '—';
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const date = new Date(dateOnly ? `${value}T12:00:00Z` : value);
  if (!Number.isFinite(date.getTime())) return '—';
  const parts = new Intl.DateTimeFormat('en-US', {
    month: 'short', day: 'numeric', timeZone: dateOnly ? 'UTC' : 'America/Los_Angeles',
    ...(!dateOnly ? { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' } : {}),
  }).formatToParts(date);
  const part = type => parts.find(item => item.type === type)?.value;
  return `${part('month')} ${part('day')}${dateOnly ? '' : ` ${part('hour')}:${part('minute')} PT`}`;
}

function concentration(share, config) {
  if (!finite(share)) return { label: 'UNAVAILABLE', className: '' };
  if (Number(share) >= config.highThreshold) return { label: 'High', className: 'is-negative' };
  if (Number(share) >= config.warnThreshold) return { label: 'Watch', className: 'is-watch' };
  return { label: 'Within limit', className: '' };
}

function Metric({ label, value }) {
  return <div className="pca-risk__metric"><span>{label}</span><span>{value}</span></div>;
}

function ComponentDetail({ component, model }) {
  if (!component) return null;
  const references = component.references || [];
  const dailyVariance = model.summary?.dailyVariance;
  return <section className="pca-risk__detail" aria-label={`${pcName(component)} detail`}>
    <h3>{pcName(component)} · {component.label || 'Unlabeled component'}</h3>
    {identityChanged(component, model) && <p className="pca-risk__continuity">Component identity changed · No reliable match to the previous snapshot.</p>}
    <div className="pca-risk__table-scroll">
      <table aria-label={`${pcName(component)} holding contributions`}>
        <thead><tr><th>Security</th><th>Signed NAV weight</th><th>Loading</th><th title="NAV return exposure for a one standard deviation move in this component">Exposure / 1σ</th><th title="Signed holding contribution divided by total daily portfolio variance">Signed portfolio risk share</th></tr></thead>
        <tbody>{(component.drivers || []).map((driver, index) => <tr key={driver.id || `${driver.symbol}-${index}`}>
          <th scope="row">{driver.symbol}</th>
          <td className={tone(driver.weight)}>{pct(driver.weight, true)}</td>
          <td>{number(driver.loading)}</td>
          <td className={tone(driver.exposureContribution)}>{pct(driver.exposureContribution, true, 3)}</td>
          <td className={tone(driver.riskContribution)}>{pct(dailyVariance > 0 && finite(driver.riskContribution) ? driver.riskContribution / dailyVariance : null, true)}</td>
        </tr>)}{!component.drivers?.length && <tr><td colSpan={5}>Holding attribution unavailable.</td></tr>}</tbody>
      </table>
    </div>
    <p>Negative risk contribution offsets this component. Exposure direction depends on the component’s orientation.</p>
    <details><summary>Macro interpretation · {references.length} references</summary>
      {references.length ? <div className="pca-risk__table-scroll"><table aria-label={`${pcName(component)} macro references`}>
        <thead><tr><th>Reference</th><th>Correlation</th><th>Transformation</th><th>As of</th></tr></thead>
        <tbody>{references.map((reference, index) => <tr key={reference.id || reference.symbol || index}>
          <th scope="row">{reference.symbol || reference.id}{reference.label || reference.name ? ` · ${reference.label || reference.name}` : ''}</th>
          <td className={tone(reference.correlation)}>{number(reference.correlation, 2)}</td>
          <td>{reference.transformLabel || TRANSFORM_LABELS[reference.transform] || '—'}</td><td>{dateLabel(reference.asOf)}</td>
        </tr>)}</tbody>
      </table></div> : <p>Reference interpretation unavailable.</p>}
      <p>References help describe observed components. They do not set quad factors, rankings, or target weights.</p>
    </details>
  </section>;
}

function Overview({ model, config, selected, onSelect }) {
  const components = model.components || [];
  return <>
    <div className="pca-risk__table-scroll"><table aria-label="PCA concentration overview">
      <thead><tr><th>Component</th><th>Interpretation</th><th title="Share of standardized return variation explained by this component">Variance explained</th><th title="Signed NAV return exposure for a one standard deviation move in this component">Exposure / 1σ</th><th title="Share of portfolio variance attributed to this component">Portfolio risk</th><th>Concentration</th><th>Largest contributors</th></tr></thead>
      <tbody>{components.map(component => {
        const flag = concentration(component.riskShare, config);
        return <tr key={component.id} className={selected === component.id ? 'is-selected' : ''}>
          <th scope="row"><button className="pca-risk__text-button" aria-pressed={selected === component.id} onClick={() => onSelect(component.id)}>{pcName(component)}</button></th>
          <td>{component.label || 'Unlabeled'}</td><td>{pct(component.explainedVarianceRatio)}</td>
          <td className={tone(component.exposure)}>{pct(component.exposure, true, 3)}</td><td>{pct(component.riskShare)}</td>
          <td className={flag.className}>{flag.label}</td><td>{(component.drivers || []).slice(0, 3).map(driver => driver.symbol).join(', ') || '—'}</td>
        </tr>;
      })}
      <tr><th scope="row">Other risk</th><td>Remaining components / residual</td><td>{finite(model.summary?.explainedVarianceRatio) ? pct(1 - model.summary.explainedVarianceRatio) : '—'}</td><td>—</td><td>{pct(model.summary?.residualRiskShare)}</td><td colSpan={2}>{Number(model.summary?.residualRiskShare) >= config.warnThreshold ? 'Material risk beyond the first five PCs' : 'Retained in total portfolio risk'}</td></tr>
      </tbody>
    </table></div>
    {(model.otherComponents || []).some(component => Number(component.riskShare) >= config.warnThreshold) && <p className="pca-risk__notice">Concentration beyond PC5: {model.otherComponents.filter(component => Number(component.riskShare) >= config.warnThreshold).map(component => `${pcName(component)} ${pct(component.riskShare)}`).join(' · ')}</p>}
    {!!model.otherComponents?.length && <details className="pca-risk__methodology"><summary>Remaining components · {model.otherComponents.length}</summary><table aria-label="Remaining PCA components"><thead><tr><th>Component</th><th>Variance explained</th><th>Portfolio risk</th><th>Concentration</th></tr></thead><tbody>{model.otherComponents.map(component => { const flag = concentration(component.riskShare, config); return <tr key={component.id}><th scope="row">{pcName(component)}</th><td>{pct(component.explainedVarianceRatio)}</td><td>{pct(component.riskShare)}</td><td className={flag.className}>{flag.label}</td></tr>; })}</tbody></table></details>}
    <ComponentDetail component={components.find(component => component.id === selected)} model={model} />
  </>;
}

function Holdings({ model, selected, onSelect }) {
  const components = model.components || [];
  return <>
    <div className="pca-risk__table-scroll"><table aria-label="Holdings PCA loadings">
      <thead><tr><th>Security</th><th>Signed NAV weight</th>{components.map(component => <th key={component.id}><button className="pca-risk__text-button" onClick={() => onSelect(component.id)}>{pcName(component)} loading</button></th>)}</tr></thead>
      <tbody>{(model.holdings || []).map((holding, index) => <tr key={holding.id || `${holding.symbol}-${index}`}>
        <th scope="row" title={holding.name || holding.symbol}>{holding.symbol}</th><td className={tone(holding.weight)}>{pct(holding.weight, true)}</td>
        {components.map(component => {
          const loading = Array.isArray(holding.loadings) ? holding.loadings.find(item => item.componentId === component.id) : null;
          return <td key={component.id}>{number(loading?.loading)}</td>;
        })}
      </tr>)}</tbody>
    </table></div>
    <ComponentDetail component={components.find(component => component.id === selected)} model={model} />
  </>;
}

function ComparisonResult({ result, config }) {
  const tradeoff = comparisonTradeoff(result);
  const residualShare = comparisonPair(result.before?.residualRiskShare, result.after?.residualRiskShare);
  const residualVariance = varianceComparisonPair(result.before?.residualVariance, result.after?.residualVariance);
  return <section className="pca-risk__detail" aria-label={`Scenario ${result.name}`}>
    <h3>{result.name}</h3>
    <div className="pca-risk__summary pca-risk__summary--comparison">
      <Metric label="Annualized volatility" value={comparisonPair(result.before?.annualizedVolatility, result.after?.annualizedVolatility).join(' → ')} />
      <Metric label="Largest PC risk share" value={comparisonPair(result.before?.maxRiskShare, result.after?.maxRiskShare).join(' → ')} />
      <Metric label="Other risk share" value={residualShare.join(' → ')} />
    </div>
    {tradeoff && <p className="pca-risk__notice" role="status">{tradeoff}</p>}
    <div className="pca-risk__table-scroll"><table aria-label={`${result.name} PCA comparison`}>
      <thead><tr><th>Component</th><th>Abs. exposure before</th><th>After</th><th title="Daily component variance in squared percentage points">Risk before (%²)</th><th>After (%²)</th><th>Risk share before</th><th>After</th><th>Change (pp)</th><th>Concentration after</th></tr></thead>
      <tbody>{(result.components || []).map(component => {
        const change = finite(component.riskShareDelta) ? Number(component.riskShareDelta) : finite(component.beforeRiskShare) && finite(component.afterRiskShare) ? component.afterRiskShare - component.beforeRiskShare : null;
        const flag = concentration(component.afterRiskShare, config);
        const sharePair = comparisonPair(component.beforeRiskShare, component.afterRiskShare);
        const exposurePair = comparisonPair(finite(component.beforeExposure) ? Math.abs(component.beforeExposure) : null, finite(component.afterExposure) ? Math.abs(component.afterExposure) : null, { digits: 3 });
        const variancePair = varianceComparisonPair(component.beforeVariance, component.afterVariance);
        return <tr key={component.id}><th scope="row">{pcName(component)}</th>
          <td>{exposurePair[0]}</td><td>{exposurePair[1]}</td>
          <td>{variancePair[0]}</td><td>{variancePair[1]}</td>
          <td>{sharePair[0]}</td><td>{sharePair[1]}</td>
          <td className={finite(change) ? change > 0 ? 'is-positive' : change < 0 ? 'is-negative' : '' : ''}>{comparisonChange(change)}</td>
          <td className={flag.className}>{flag.label}</td></tr>;
      })}
      <tr><th scope="row">Other risk</th><td>—</td><td>—</td><td>{residualVariance[0]}</td><td>{residualVariance[1]}</td><td>{residualShare[0]}</td><td>{residualShare[1]}</td><td>{comparisonChange(result.residual?.riskShareDelta)}</td><td>Included</td></tr>
      </tbody>
    </table></div>
    {(result.otherComponents || []).some(component => Number(component.afterRiskShare) >= config.warnThreshold) && <p className="pca-risk__notice">Concentration beyond PC5 after this scenario: {result.otherComponents.filter(component => Number(component.afterRiskShare) >= config.warnThreshold).map(component => `${pcName(component)} ${pct(component.afterRiskShare)}`).join(' · ')}</p>}
    <p>Other risk includes remaining PCs and candidate variation unexplained by the frozen basis. It remains in total volatility.</p>
    <p>{(result.changes || []).map(change => `${change.symbol} ${pct(change.deltaWeight, true)} NAV`).join(' · ')}</p>
  </section>;
}

function Compare({ snapshot, account, config }) {
  const [name, setName] = useState('Scenario 1');
  const [changes, setChanges] = useState([{ id: 1, symbol: '', delta: '' }]);
  const [results, setResults] = useState([]);
  const [selected, setSelected] = useState(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(null);
  const nextId = useRef(2);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const valid = name.trim() && changes.length && changes.every(change => /^[A-Z0-9.^=-]{1,24}$/.test(change.symbol.trim().toUpperCase()) && finite(change.delta) && Number(change.delta) !== 0);
  const run = async event => {
    event.preventDefault();
    if (!valid || pending) return;
    setPending(true); setError(null);
    try {
      const result = await pcaRiskService.compare({ snapshotId: snapshot.id, account, name: name.trim(), changes: changes.map(change => ({ symbol: change.symbol.trim().toUpperCase(), deltaWeight: Number(change.delta) / 100 })) });
      if (!mounted.current) return;
      if (result.snapshotId !== snapshot.id || !Array.isArray(result.components) || !result.before || !result.after || result.status === 'unavailable') throw new Error('unavailable');
      setResults(previous => [...previous, { ...result, name: result.name || name.trim(), changes: changes.map(change => ({ symbol: change.symbol.trim().toUpperCase(), deltaWeight: Number(change.delta) / 100 })) }]);
      setSelected(results.length);
      setName(`Scenario ${results.length + 2}`);
    } catch { if (mounted.current) setError('Comparison unavailable. Check candidate history and the dated snapshot.'); }
    finally { if (mounted.current) setPending(false); }
  };
  return <>
    <form className="pca-risk__compare" onSubmit={run} aria-label="Compare candidate trades">
      <label>Scenario name<input aria-label="Scenario name" value={name} onChange={event => setName(event.target.value)} maxLength={80} /></label>
      <p>Enter signed changes in percentage points of NAV. +1 adds a long or covers a short; −1 reduces a long or adds a short. Every scenario uses the same dated PCA basis.</p>
      {changes.map((change, index) => <div className="pca-risk__candidate" key={change.id}>
        <label>Security<input aria-label={`Candidate ${index + 1} security`} value={change.symbol} onChange={event => setChanges(previous => previous.map(row => row.id === change.id ? { ...row, symbol: event.target.value.toUpperCase() } : row))} placeholder="Ticker" /></label>
        <label>Change (pp NAV)<input aria-label={`Candidate ${index + 1} NAV change`} inputMode="decimal" type="number" step="any" value={change.delta} onChange={event => setChanges(previous => previous.map(row => row.id === change.id ? { ...row, delta: event.target.value } : row))} placeholder="+1.0" /></label>
        {changes.length > 1 && <button type="button" aria-label={`Remove candidate ${index + 1}`} onClick={() => setChanges(previous => previous.filter(row => row.id !== change.id))}>Remove</button>}
      </div>)}
      <div className="pca-risk__actions"><button type="button" onClick={() => { const id = nextId.current++; setChanges(previous => [...previous, { id, symbol: '', delta: '' }]); }}>Add security</button><button type="submit" disabled={!valid || pending}>{pending ? 'Comparing…' : 'Compare'}</button></div>
      {error && <p role="status" className="is-negative">{error}</p>}
    </form>
    {results.length > 1 && <label className="pca-risk__scenario-select">Result<select aria-label="Select comparison result" value={selected} onChange={event => setSelected(Number(event.target.value))}>{results.map((result, index) => <option key={index} value={index}>{result.name}</option>)}</select></label>}
    {results[selected] && <ComparisonResult result={results[selected]} config={config} />}
  </>;
}

function Settings({ config, window, onSave }) {
  const [draft, setDraft] = useState({ window, warn: config.warnThreshold * 100, high: config.highThreshold * 100 });
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const save = async event => {
    event.preventDefault();
    const days = Number(draft.window), warn = Number(draft.warn), high = Number(draft.high);
    if (!Number.isInteger(days) || days < 63 || days > 504 || !(warn > 0 && high > warn && high <= 100)) { setError('Use 63–504 sessions and 0 < watch < high ≤ 100%.'); return; }
    setSaving(true); setError(null);
    try { await onSave({ window: days, warnThreshold: warn / 100, highThreshold: high / 100 }); }
    catch { if (mounted.current) setError('Settings could not be saved.'); }
    finally { if (mounted.current) setSaving(false); }
  };
  return <form className="pca-risk__settings" onSubmit={save} aria-label="PCA settings">
    <label>Rolling sessions<input aria-label="Rolling sessions" type="number" min="63" max="504" value={draft.window} onChange={event => setDraft({ ...draft, window: event.target.value })} /></label>
    <label>Watch risk share (%)<input aria-label="Watch risk share" type="number" min="1" max="99" step="any" value={draft.warn} onChange={event => setDraft({ ...draft, warn: event.target.value })} /></label>
    <label>High risk share (%)<input aria-label="High risk share" type="number" min="1" max="100" step="any" value={draft.high} onChange={event => setDraft({ ...draft, high: event.target.value })} /></label>
    <button disabled={saving} type="submit">Save settings</button>{error && <span role="status" className="is-negative">{error}</span>}
  </form>;
}

export default function PcaRiskWorkspace({ accountId, portfolioData, onClose, active = true }) {
  const account = accountId || portfolioData?.accountId || null;
  const risk = usePcaRisk(account, active);
  const [tab, setTab] = useState('overview');
  const [selected, setSelected] = useState(null);
  const [settings, setSettings] = useState(false);
  const model = risk.snapshot?.model;
  const config = { ...risk.config, window: risk.window };
  const chosen = model?.components?.some(component => component.id === selected) ? selected : model?.components?.[0]?.id;
  const summary = model?.summary || {};
  const coverage = risk.snapshot?.coverage || {};
  return <section className="pca-risk" aria-label="PCA Risk" aria-busy={risk.loading || risk.refreshing}>
    <header className="pca-risk__header"><div><h2>PCA</h2><span>Post-close equity & ETF risk</span></div><div className="pca-risk__actions"><button onClick={() => risk.refresh()} disabled={!account || risk.loading || risk.refreshing}>{risk.snapshot ? 'Refresh snapshot' : 'Build snapshot'}</button>{onClose && <button onClick={onClose}>Close</button>}</div></header>
    <div className="pca-risk__date-line"><span>{risk.snapshot ? `${dateLabel(risk.snapshot.sessionDate)} close snapshot` : 'No verified snapshot'}</span>{risk.snapshot?.generatedAt && <span>Calculated {dateLabel(risk.snapshot.generatedAt)}</span>}{risk.snapshot && risk.envelope?.latestCompletedSession && risk.snapshot.sessionDate !== risk.envelope.latestCompletedSession && <span>Latest completed session {dateLabel(risk.envelope.latestCompletedSession)}</span>}{risk.refreshing && <span role="status">Preparing snapshot…</span>}</div>
    <div className="pca-risk__toolbar"><div role="tablist" aria-label="PCA views">{[['overview', 'Overview'], ['holdings', 'Holdings'], ['compare', 'Compare']].map(([id, label]) => <button role="tab" key={id} aria-selected={tab === id} className={tab === id ? 'is-active' : ''} onClick={() => setTab(id)}>{label}</button>)}</div>{risk.history.length > 0 && <label>Snapshot<select aria-label="PCA snapshot date" value={risk.snapshotId || ''} onChange={event => risk.setSnapshotId(event.target.value || null)}><option value="">Latest saved</option>{risk.history.map(item => <option value={item.id} key={item.id}>{dateLabel(item.sessionDate)} · {dateLabel(item.generatedAt)}</option>)}</select></label>}<label>Window<select aria-label="PCA window" value={risk.window} onChange={event => risk.setWindow(Number(event.target.value))}>{[...new Set([63, 126, 252, risk.window])].sort((a, b) => a - b).map(days => <option value={days} key={days}>{days} sessions</option>)}</select></label><button aria-expanded={settings} onClick={() => setSettings(value => !value)}>Settings</button></div>
    {settings && <Settings key={`${account}:${risk.window}:${config.warnThreshold}:${config.highThreshold}`} config={config} window={risk.window} onSave={risk.saveConfig} />}
    {risk.error && <p className="pca-risk__notice" role="status">{risk.error}</p>}
    <div className="pca-risk__body">
      {!risk.snapshot ? <div className="pca-risk__empty" role="status">{!account ? 'Select a verified portfolio account to build a risk snapshot.' : risk.loading || risk.refreshing ? 'Preparing the post-close risk snapshot…' : 'UNAVAILABLE · A verified post-close snapshot is required.'}</div> : <>
        <div className="pca-risk__summary"><Metric label="Annualized volatility" value={pct(summary.annualizedVolatility)} /><Metric label="First five · variance explained" value={pct(summary.explainedVarianceRatio)} /><Metric label="First five · portfolio risk" value={pct(summary.topFiveRiskShare)} /><Metric label="Largest PC · portfolio risk" value={pct(summary.maxRiskShare)} /></div>
        <CoverageNotice coverage={coverage} partial={risk.envelope?.status === 'partial'} window={risk.window} />
        <div role="tabpanel" aria-label={tab === 'overview' ? 'Overview' : tab === 'holdings' ? 'Holdings' : 'Compare'}>{tab === 'overview' && <Overview model={model} config={config} selected={chosen} onSelect={setSelected} />}{tab === 'holdings' && <Holdings model={model} selected={chosen} onSelect={setSelected} />}{tab === 'compare' && <Compare key={risk.snapshot.id} snapshot={risk.snapshot} account={account} config={config} />}</div>
        <details className="pca-risk__methodology"><summary>Method and data</summary><p>Long and short equities and ETFs only. Prediction contracts and other instruments are outside this model.{coverage.outOfScope?.length > 0 ? ` ${coverage.outOfScope.length} ${coverage.outOfScope.length === 1 ? 'position is' : 'positions are'} outside this scope.` : ''}</p><p>{risk.window} completed daily return observations; five principal components. Standardized security returns describe common movement. Signed NAV weights and security volatility determine portfolio exposure and risk contribution. Shorts retain their negative weight. Exposure / 1σ is the modeled NAV return for a one standard deviation component move.</p><p>Quad factors define desired exposures. PCA independently checks common portfolio risk. Macro references interpret the PCs; they do not replace quad factors. Candidate comparisons hold the PCA basis fixed and retain remaining risk.</p><p>Watch ≥ {pct(config.warnThreshold)} and high ≥ {pct(config.highThreshold)} of portfolio variance. These are configurable concentration limits.</p><p>Session {risk.snapshot.sessionDate} · snapshot {dateLabel(risk.snapshot.generatedAt)}{coverage.modeledCount != null ? ` · ${coverage.modeledCount}/${coverage.holdingCount ?? '—'} equities and ETFs modeled` : ''}</p>{finite(coverage.modeledGrossWeight) && <p>Modeled gross {pct(coverage.modeledGrossWeight)} NAV{finite(coverage.totalGrossWeight) ? ` / verified equity and ETF gross ${pct(coverage.totalGrossWeight)} NAV` : ''}. Risk totals cover the modeled equities and ETFs.</p>}{risk.snapshot.provenance?.holdingsObservedAt && <p>Holdings observed {dateLabel(risk.snapshot.provenance.holdingsObservedAt)} · NAV observed {dateLabel(risk.snapshot.provenance.navObservedAt)}</p>}{risk.snapshot.provenance?.sources?.length > 0 && <p>Holdings, NAV and session closes: IBKR · Daily history: {risk.snapshot.provenance.sources.map(source => SOURCE_LABELS[source] || source).join(', ')}</p>}<p>Valuation: {risk.snapshot.provenance?.valuationBasis || 'Signed portfolio weights from the snapshot’s verified close valuation.'}</p></details>
      </>}
    </div>
  </section>;
}
