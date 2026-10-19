import React from 'react';
import { VOL_RANGES } from '../../utils/volatilityRegimes';
import { USD_CORRELATION_HEATMAP_THRESHOLDS } from '../../constants/usdCorrelationPresentation';

// Section-wide variables emitted by the setup board renderer as an ```analyst-drivers
// JSON block: US Dollar and USD-correlation cells, then a volatility table.
export function parsePredictionDrivers(text) {
  try {
    const value = JSON.parse(String(text || ''));
    if (!value || typeof value !== 'object') return null;
    // Saved reviews may carry the earlier cell strip; current ones carry volatility and correlation tables.
    const cells = Array.isArray(value.cells) ? value.cells.filter(cell => cell && typeof cell.label === 'string') : [];
    const volatility = Array.isArray(value.volatility) ? value.volatility.filter(row => row && typeof row.symbol === 'string') : [];
    const correlations = Array.isArray(value.correlations?.rows)
      ? { rows: value.correlations.rows.filter(row => row && typeof row.market === 'string'), asOf: value.correlations.asOf || null }
      : null;
    return cells.length || volatility.length || correlations?.rows.length ? { cells, volatility, correlations } : null;
  } catch {
    return null;
  }
}

const DIRECTION_CLASS = { Bullish: 'is-positive', Bearish: 'is-negative', Neutral: 'is-muted' };
const REGIME_CLASS = { green: 'is-positive', yellow: 'is-caution', red: 'is-negative' };

function volatilityRegime(row) {
  const ranges = VOL_RANGES[row.regimeKey]?.ranges;
  const value = Number(row.regimeValue);
  if (!ranges || !Number.isFinite(value)) return null;
  return ranges.find(range => value >= range.min && (range.max == null || value < range.max)) || null;
}

function Change({ value }) {
  const number = Number(value);
  if (value === null || value === undefined || !Number.isFinite(number)) return <span className="is-muted">N/A</span>;
  return <span className={number > 0 ? 'is-positive' : number < 0 ? 'is-negative' : 'is-muted'}>{`${number > 0 ? '+' : ''}${number.toFixed(1)}%`}</span>;
}

function DriverCell({ cell }) {
  return <div className="analyst-driver" role="listitem">
    <div className="analyst-driver__label">{cell.label}</div>
    {cell.value && <div className="analyst-driver__value">{cell.value}
      {cell.unit && <span className="analyst-driver__muted"> {cell.unit}</span>}
      {cell.change !== undefined && <span className="analyst-driver__change"> <Change value={cell.change} /></span>}</div>}
    {(cell.periods || cell.rows) && <div className="analyst-driver__rows">
      {(cell.periods || []).map(([label, value]) => <React.Fragment key={label}><span className="analyst-driver__muted">{label}</span><Change value={value} /></React.Fragment>)}
      {(cell.rows || []).map(([label, value]) => <React.Fragment key={label}><span className="analyst-driver__muted">{label}</span><span className="analyst-driver__value">{value}</span></React.Fragment>)}
    </div>}
    {cell.signal && <div className="analyst-driver__line"><span className={DIRECTION_CLASS[cell.signal]}>Trend {cell.signal}</span></div>}
    {cell.range && <div className="analyst-driver__line analyst-driver__muted">{cell.range}</div>}
    {cell.trade && <div className="analyst-driver__line"><span className={DIRECTION_CLASS[cell.trade]}>Trade {cell.trade}</span>
      {cell.tradeDate && <span className="analyst-driver__muted"> {cell.tradeDate}</span>}</div>}
    {cell.sub && <div className="analyst-driver__line analyst-driver__muted">{cell.sub}</div>}
    {cell.note && <div className="analyst-driver__line analyst-driver__muted">{cell.note}</div>}
  </div>;
}

function VolatilityTable({ rows }) {
  const implied = rows.some(row => row.implied);
  return <table className="analyst-drivers__table" aria-label="Volatility">
    <colgroup><col className="analyst-drivers__name-col" /><col /><col /><col /><col /><col className="analyst-drivers__regime-col" />
      {implied && <col className="analyst-drivers__implied-col" />}</colgroup>
    <thead><tr><th>Volatility</th><th className="is-number">Level</th><th className="is-number">1D</th><th className="is-number">15D</th>
      <th className="is-number">1M</th><th>Regime</th>{implied && <th>Implied 1D</th>}</tr></thead>
    <tbody>{rows.map(row => {
      const regime = volatilityRegime(row);
      return <tr key={row.symbol}>
        <td><span className="analyst-driver__stack">{row.symbol}</span>
          <span className="analyst-driver__stack analyst-driver__muted">{row.market}</span>
          {row.signal && <span className="analyst-driver__stack"><span className={DIRECTION_CLASS[row.signal]}>Trend {row.signal}</span>
            {row.range && <span className="analyst-driver__muted"> {row.range}</span>}</span>}</td>
        <td className="is-number analyst-driver__value">{row.level}</td>
        <td className="is-number"><Change value={row.d1} /></td>
        <td className="is-number"><Change value={row.d15} /></td>
        <td className="is-number"><Change value={row.m1} /></td>
        {/* A reading from an earlier session (e.g. MOVE's last verified close) keeps its date under its regime. */}
        <td>{regime ? <><span className={`analyst-driver__stack ${REGIME_CLASS[regime.color] || ''}`}>{regime.label}</span>
          {row.note && <span className="analyst-driver__stack analyst-driver__muted">{row.note}</span>}</>
          : <span className="analyst-driver__muted">{row.note || 'N/A'}</span>}</td>
        {implied && <td>{row.implied
          ? row.implied.split(' · ').map(part => <span key={part} className="analyst-driver__stack">{part}</span>)
          : <span className="analyst-driver__muted">N/A</span>}</td>}
      </tr>;
    })}</tbody>
  </table>;
}

// Same heat rules as the dashboard USD correlation table: neutral up to |0.50|, colored beyond, outlined from |0.75|.
export function correlationHeatClass(text) {
  const value = Number(String(text).replace('+', ''));
  if (!Number.isFinite(value)) return 'analyst-driver__muted';
  const magnitude = Math.abs(Number(value.toFixed(2)));
  if (magnitude <= USD_CORRELATION_HEATMAP_THRESHOLDS.neutralMagnitudeMax) return 'analyst-corr--neutral';
  const strength = magnitude >= USD_CORRELATION_HEATMAP_THRESHOLDS.strongMagnitudeMin ? 'strong' : 'light';
  return `analyst-corr--${value > 0 ? 'pos' : 'neg'}-${strength}`;
}

function CorrelationTable({ correlations }) {
  const value = text => <span className={correlationHeatClass(text)}>{text}</span>;
  // Saved reviews predate the 60D window; show it only when the rows carry it.
  const periods = ['d15', 'd30', ...(correlations.rows.some(row => row.d60 !== undefined) ? ['d60'] : []), 'd90'];
  return <table className="analyst-drivers__table" aria-label="Correlation with the US Dollar">
    <colgroup><col className="analyst-drivers__name-col" />{periods.map(key => <col key={key} />)}</colgroup>
    <thead><tr><th>vs USD</th>{periods.map(key => <th key={key} className="is-number">{key.slice(1)}D</th>)}</tr></thead>
    <tbody>
      {correlations.rows.map(row => <tr key={row.market}><td>{row.market}</td>
        {periods.map(key => <td key={key} className="is-number">{value(row[key] ?? 'N/A')}</td>)}</tr>)}
    </tbody>
  </table>;
}

export default function AnalystPredictionDrivers({ drivers }) {
  const { cells = [], volatility = [], correlations = null } = drivers;
  if (cells.length) {
    // Earlier saved layout: cells on the left, volatility on the right.
    return <div className="analyst-drivers has-volatility">
      <div className="analyst-drivers__cells" role="list" aria-label="US Dollar and correlations">
        {cells.map((cell, index) => <DriverCell key={`${cell.label}-${index}`} cell={cell} />)}
      </div>
      {volatility.length > 0 && <VolatilityTable rows={volatility} />}
    </div>;
  }
  // The as-of note sits above the row so both tables start and end level.
  return <div className={`analyst-drivers analyst-drivers--tables${volatility.length && correlations ? ' has-both' : ''}`}>
    {correlations?.rows.length > 0 && correlations.asOf
      && <div className="analyst-drivers__asof">vs USD as of {correlations.asOf}</div>}
    {volatility.length > 0 && <VolatilityTable rows={volatility} />}
    {correlations?.rows.length > 0 && <CorrelationTable correlations={correlations} />}
  </div>;
}
