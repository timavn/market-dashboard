import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { EXPOSURE_DIMENSIONS, QUAD_PLAYBOOK } from '../../constants/quadExposureCatalog';
import { getQuadResearchCell, normalizeQuadResearch } from '../../hooks/useQuadResearch';
import QuadResearchExplanation from './QuadResearchExplanation';
import { useSurfaceActivity } from '../common/PersistentSurface';
import './PortfolioFactorQuadMatrix.css';

const QUADS = [1, 2, 3, 4];
const pct = value => `${Math.abs(value) < 0.05 ? '0.0' : value.toFixed(1)}%`;

export default function PortfolioFactorQuadMatrix({
  rows, available, loading = false, valuation = {}, selectedFactorId, onSelectFactor, onClearFactor, estimates = null,
}) {
  const active = useSurfaceActivity();
  const research = useMemo(() => normalizeQuadResearch(estimates), [estimates]);
  const [selectedResearch, setSelectedResearch] = useState(null);
  const closeResearch = useCallback(() => setSelectedResearch(null), []);
  useEffect(() => { if (!active) closeResearch(); }, [active, closeResearch]);
  // Quote updates, missing marks and reconnects must never move the worksheet.
  const orderedRows = useMemo(() => [...rows].sort((left, right) => (
    left.label.localeCompare(right.label)
  )), [rows]);
  const maximum = Math.max(1, ...orderedRows.map(row => Math.abs(row.netPct || 0)));
  const closeDate = valuation.asOf;
  const closeLabel = closeDate && new Date(`${closeDate}T12:00:00Z`).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', timeZone: 'UTC',
  });
  const valuationLabel = !available ? loading ? 'Loading…' : 'Unavailable' : null;
  const valuationTitle = [
    'Net = long minus short, as a percent of current verified broker NAV. Factors across categories overlap; do not add the rows together.',
    closeDate ? `Current broker quantities valued consistently at verified ${closeDate} closing prices, divided by current broker NAV. Reference only; not a live quote or trade size.` : '',
    '0.0% means verified zero or net exposure below 0.05% of NAV. N/A means the factor cannot be valued completely.',
    valuation.reason,
  ].filter(Boolean).join(' ');

  return (
    <section className="pcv2-card pcv2-factor-matrix" aria-label="Factor exposure balance">
      <div className="pcv2-factor-matrix__viewport" tabIndex={0} role="region" aria-label="Scrollable factor worksheet">
        <table aria-label="Portfolio factor exposures by quad" aria-busy={loading}>
          <colgroup>
            <col className="pcv2-factor-matrix__factor-col" />
            <col className="pcv2-factor-matrix__exposure-col" />
            {QUADS.map(quad => <col key={quad} />)}
          </colgroup>
          <thead>
            <tr>
              <th scope="col" aria-sort="ascending">
                Factor
                {selectedFactorId && <button
                  className="pcv2-factor-matrix__clear"
                  type="button"
                  aria-label="Clear factor filter"
                  title="Clear factor filter"
                  onClick={onClearFactor}
                >×</button>}
              </th>
              <th scope="col" title={valuationTitle}>
                Net % NAV
                {available && closeLabel && <span className="pcv2-factor-matrix__state">{closeLabel} close</span>}
                {valuationLabel && <span className="pcv2-factor-matrix__state" role="status">{valuationLabel}</span>}
              </th>
              {QUADS.map(quad => (
                <th key={quad} scope="col" className={`pcv2-factor-matrix__quad is-q${quad}`}>
                  Q{quad} {QUAD_PLAYBOOK[`q${quad}`].quad.split(': ')[1]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {orderedRows.map(row => {
              const value = row.netPct;
              const rowAvailable = available && Number.isFinite(value);
              const selected = selectedFactorId === row.id;
              const canFilter = rowAvailable && row.grossPct > 0 && row.dimension;
              const width = Math.abs(value || 0) / maximum * 50;
              const negative = rowAvailable && value <= -0.05;
              const positive = rowAvailable && value >= 0.05;
              const exposureLabel = rowAvailable
                ? `Net exposure to ${row.label}: ${pct(value)} of NAV`
                : `${row.label} exposure unavailable`;
              const classificationTitle = row.dimension
                ? `${EXPOSURE_DIMENSIONS[row.dimension].label}. A position with multiple labels in this category is split equally among those labels. Categories overlap.`
                : 'This holding needs a reviewed factor classification.';
              return (
                <tr key={row.id} className={selected ? 'is-selected' : undefined}>
                  <th scope="row" title={classificationTitle}>
                    {canFilter ? <button
                      type="button"
                      aria-pressed={selected}
                      aria-label={`${selected ? 'Clear' : 'Filter by'} ${row.label}; ${pct(row.shortPct)} short, ${pct(row.longPct)} long, ${pct(row.netPct)} net`}
                      onClick={() => onSelectFactor(row)}
                    >{row.label}</button> : row.label}
                  </th>
                  <td aria-label={exposureLabel} title={rowAvailable
                    ? `${exposureLabel}. Long ${pct(row.longPct)}; short ${pct(row.shortPct)}. ${closeDate ? `${valuation.asOf} close reference.` : ''}`
                    : row.unavailableReason || valuation.reason || exposureLabel}>
                    <span className={`pcv2-factor-matrix__exposure${negative ? ' is-negative' : positive ? ' is-positive' : ' is-neutral'}`}>
                      <span className="pcv2-factor-matrix__value">
                        {rowAvailable ? `${positive ? '+' : ''}${pct(value)}` : loading ? '…' : 'N/A'}
                      </span>
                      {rowAvailable && (negative || positive) && <span className="pcv2-factor-matrix__track is-net" aria-hidden="true">
                        <span className="pcv2-factor-matrix__bar" style={{
                          width: `${width}%`,
                          left: `${value < 0 ? 50 - width : 50}%`,
                        }} />
                      </span>}
                    </span>
                  </td>
                  {QUADS.map(quad => {
                    const fit = row.quadFits[`q${quad}`];
                    const listed = fit.status !== 'not-listed';
                    if (!listed) {
                      const cell = getQuadResearchCell(research, row.id, quad);
                      const supported = cell.status === 'supported';
                      const rankLabel = supported
                        ? `Rank ${cell.rank} of ${cell.peerCount}*; independently calculated historical rank`
                        : `Unavailable: ${cell.reason}`;
                      return <td key={quad}
                        className={`pcv2-factor-matrix__rank ${supported ? 'is-independent' : 'is-not-listed'}`}
                        title={`${row.label} · Quad ${quad} · ${rankLabel}`}
                        aria-label={`${row.label}, Quad ${quad}: ${rankLabel}`}
                      >
                        <button type="button" className="pcv2-factor-matrix__research"
                          aria-label={`Explain ${row.label}, Quad ${quad}: ${rankLabel}`}
                          onClick={() => setSelectedResearch({ exposureId: row.id, label: row.label, quad })}
                        >{supported ? `${cell.rank}*` : '—'}</button>
                      </td>;
                    }
                    const rankLabel = `${fit.status === 'best' ? 'Best' : 'Worst'} #${fit.rank}`;
                    return (
                      <td key={quad}
                        className={`pcv2-factor-matrix__rank is-${fit.status}${listed && fit.rank === 1 ? ' is-first' : ''}`}
                        title={`${row.label} · Quad ${quad} · ${rankLabel}`}
                        aria-label={`${row.label}, Quad ${quad}: ${rankLabel}`}
                      >{fit.rank}</td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {selectedResearch && active && <QuadResearchExplanation
        label={selectedResearch.label}
        quad={selectedResearch.quad}
        cell={getQuadResearchCell(research, selectedResearch.exposureId, selectedResearch.quad)}
        snapshot={research}
        onClose={closeResearch}
      />}
    </section>
  );
}
