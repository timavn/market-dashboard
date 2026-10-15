import React from 'react';

export const researchPercent = (value, digits = 1) => Number.isFinite(value) ? `${value.toFixed(digits)}%` : '—';
export const researchCount = (value) => Number.isFinite(value) ? value.toLocaleString('en-US') : '—';
export const researchSample = (sample, hourly) => sample
  ? hourly ? `${researchCount(sample.observations)} / ${researchCount(sample.days)}` : researchCount(sample.observations)
  : '—';
export const researchDelta = (value) => Number.isFinite(value) ? `${value > 0 ? '+' : ''}${value.toFixed(1)}` : '—';

export function heatColor(pct, limited = false) {
  if (!Number.isFinite(pct) || limited) return undefined;
  const strength = Math.min(1, Math.abs(pct - 50) / 20);
  return pct >= 50 ? `rgba(46, 158, 76, ${strength * .3})` : `rgba(210, 65, 57, ${strength * .26})`;
}

export function ResearchHeatCell({ sample, label, selected, onSelect, hourly, unavailable, groupStart = false }) {
  const title = unavailable || (sample?.observations
    ? `${label}: ${researchPercent(sample.pct)} · ${researchSample(sample, hourly)} ${hourly ? 'hours / days' : 'observations'}${sample.limitedSample ? ' · Below sample minimum' : ''}`
    : `${label}: no qualifying observations`);
  return <td className={`bitcoin-research__heat-cell${groupStart ? ' bitcoin-research__group-start' : ''}`}
    data-selected={selected || undefined} data-limited={sample?.limitedSample || undefined}
    style={{ backgroundColor: heatColor(sample?.pct, sample?.limitedSample) }}>
    <button type="button" aria-label={label} aria-pressed={Boolean(selected)} title={title}
      disabled={Boolean(unavailable) || !sample?.observations} onClick={onSelect}>
      <span>{researchPercent(sample?.pct)}{sample?.observations > 0 && sample.limitedSample ? ' †' : ''}</span>
      {!unavailable && <small>{researchSample(sample, hourly)}</small>}
    </button>
  </td>;
}

export function MainResearchMatrix({ rows, usdStates, volatilityStates, selected, onSelect, hourly, outcome }) {
  return <div className="bitcoin-research__table-wrap">
    <table className="bitcoin-research__matrix" aria-label="Bitcoin probability matrix">
      <colgroup><col className="bitcoin-research__regime-col" /><col className="bitcoin-research__zone-col" />
        {usdStates.flatMap((usd) => volatilityStates.map((vol) => <col key={`${usd.id}-${vol.id}`} />))}</colgroup>
      <thead><tr><th colSpan={2} scope="colgroup">{outcome === 'up' ? 'UP' : 'DOWN'} CLOSES %</th>
        {usdStates.map((usd) => <th className="bitcoin-research__group-start" colSpan={volatilityStates.length} scope="colgroup" key={usd.id}>USD {usd.label.toUpperCase()}</th>)}
      </tr><tr><th scope="col">Regime</th><th scope="col">Entry zone</th>
        {usdStates.flatMap((usd) => volatilityStates.map((vol, index) => <th scope="col" title={`BTC volatility · ${vol.label}`} key={`${usd.id}-${vol.id}`}
          className={`${index === 0 ? 'bitcoin-research__group-start ' : ''}${vol.id === 'investable' ? 'bitcoin-research__up' : vol.id === 'uninvestable' ? 'bitcoin-research__down' : ''}`}>{vol.label}</th>))}
      </tr></thead>
      <tbody>{rows.map((row) => <tr key={row.key} className={row.first ? 'bitcoin-research__regime-start' : ''}>
        {row.first && <th rowSpan={row.zoneCount} scope="rowgroup" className={`bitcoin-research__regime bitcoin-research__${row.cohort}`}>{row.cohortLabel}</th>}
        <th scope="row" className="bitcoin-research__zone">{row.zoneLabel}</th>
        {row.cells.map(({ key, ...cell }) => <ResearchHeatCell key={key} {...cell} hourly={hourly}
          selected={key === selected} onSelect={() => onSelect({ key, ...cell })} />)}
      </tr>)}</tbody>
    </table>
  </div>;
}

export function ResearchFactorMatrix({ rows, columns, rowAxis, columnAxis, selected, onSelect, hourly }) {
  return <div className="bitcoin-research__table-wrap">
    <table className="bitcoin-research__factor-matrix" aria-label="Refinement probability matrix" style={{ minWidth: Math.max(600, 150 + columns.length * 110) }}>
      <thead><tr><th scope="col">{rowAxis?.label || 'Selected setup'}</th>{columns.map((column) => <th key={column.id} scope="col">{column.label}</th>)}</tr></thead>
      <tbody>{rows.map((row) => <tr key={row.id}>
        <th scope="row" className={rowAxis?.id === 'quad' ? `bitcoin-research__quad-label bitcoin-research__${row.id}` : ''}>{row.label}</th>
        {row.cells.map(({ key, ...cell }) => <ResearchHeatCell key={key} {...cell} hourly={hourly}
          selected={selected === key} onSelect={() => onSelect({ key, ...cell })} />)}
      </tr>)}</tbody>
    </table>
    <span className="sr-only">Columns: {columnAxis?.label || 'All observations'}</span>
  </div>;
}
