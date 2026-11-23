import React, { useMemo } from 'react';
import { QUAD_PLAYBOOK } from '../../constants/quadExposureCatalog';
import { QUAD_READING_SCOPES } from '../../utils/portfolioQuadReadings';
import { buildRiskMatrixRollup, quadFit, UNLABELLED } from '../../utils/portfolioRiskMatrix';
import usePortfolioQuadReadings from '../../hooks/usePortfolioQuadReadings';
import usePositionRisk from '../../hooks/usePositionRisk';
import securityClassifications from '../../constants/securityClassifications.json';
import LoadingIndicator from '../common/LoadingIndicator';
import './PortfolioRiskMatrix.css';

const QUADS = [1, 2, 3, 4];
// Every exposure a security in the universe can give, so one with nothing held still shows, at zero.
const UNIVERSE = Object.values(securityClassifications.securities);
const SCOPE_LABELS = { usMonthly: 'Monthly', usQuarterly: 'Quarterly', global: 'Global' };
const pct = (value, places = 1) => `${Math.abs(value).toFixed(places)}%`;
const tone = value => (value >= 0.05 ? ' is-positive' : value <= -0.05 ? ' is-negative' : '');
const signed = (value, places) => (Math.abs(value) < 0.5 / 10 ** places ? (0).toFixed(places) : value.toFixed(places));

// The book by asset class and group: how much is there, how much of the book's
// risk it carries, and whether Hedgeye's playbook favours it in each quad in force.
export default function PortfolioRiskMatrix({ holdings, nav, available, loading = false, valuation = {} }) {
  const positions = useMemo(() => (available && nav > 0 ? holdings
    .filter(holding => holding?.symbol && Number.isFinite(Number(holding.marketValue)))
    .map(holding => ({ symbol: String(holding.symbol).toUpperCase(), weightPct: Number(holding.marketValue) / nav * 100 })) : []), [available, holdings, nav]);
  const risk = usePositionRisk(positions, { enabled: available });
  const riskRows = risk.data?.rows;
  const rows = useMemo(() => (available ? buildRiskMatrixRollup({ holdings, nav, riskRows: riskRows || [], universe: UNIVERSE }) : []), [available, holdings, nav, riskRows]);
  const { current, update, saveError } = usePortfolioQuadReadings();

  const riskPending = !riskRows && risk.status !== 'error';
  const riskTitle = risk.data
    ? `Share of the book's variance over the last ${risk.data.window} sessions to ${risk.data.asOf}. Shares add to 100%; a negative share offsets the rest.`
    : 'Share of the book\'s variance';
  const state = !available ? (loading ? <LoadingIndicator label="Loading…" size="sm" announce={false} /> : 'Unavailable')
    : risk.status === 'error' && !riskRows ? 'Risk unavailable' : null;

  return (
    <section className="pcv2-card pcv2-risk-matrix" aria-label="Risk matrix">
      <div className="pcv2-risk-matrix__viewport" tabIndex={0} role="region" aria-label="Scrollable risk matrix">
      <table aria-label="Portfolio by asset class and group" aria-busy={loading || riskPending}>
        <thead>
          <tr>
            <th scope="col" className="is-label">
              Exposure
              {state && <span className="pcv2-risk-matrix__state" role="status">{state}</span>}
            </th>
            <th scope="col" className="is-holdings" title="Positions in the row, largest first. Hover a row's list to see all of them.">Holdings</th>
            <th scope="col">Pos.</th>
            <th scope="col" title={`Long minus short, % of NAV${valuation.asOf ? `, at ${valuation.asOf} closing prices` : ''}`}>Net</th>
            <th scope="col" title="Long plus short, % of NAV">Gross</th>
            <th scope="col" title={riskTitle}>Risk share</th>
            <th scope="col" title="This row's contribution to the book's beta to the S&P 500">Beta</th>
            {QUAD_READING_SCOPES.map(({ id, label }) => {
              const reading = current[id];
              return (
                <th key={id} scope="col" className={`pcv2-risk-matrix__quad${reading ? ` is-q${reading.quad}` : ''}`}>
                  <label>
                    <span>{SCOPE_LABELS[id]}</span>
                    <select
                      aria-label={`${label} current quad`}
                      title={reading
                        ? `${reading.sourceLabel || 'Manually entered Hedgeye reading'} · ${reading.asOf}. Select to update manually.`
                        : 'Set the current Hedgeye reading; none has been entered.'}
                      value={reading?.quad || ''}
                      onChange={event => update(id, event.target.value)}
                    >
                      <option value="">—</option>
                      {QUADS.map(quad => <option key={quad} value={quad}>Q{quad}</option>)}
                    </select>
                  </label>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const unlabelled = row.label === UNLABELLED;
            const riskCell = (value, render) => (value == null ? (riskPending ? '…' : '—') : render(value));
            const unmeasuredNote = row.unmeasured ? ` ${row.unmeasured} of ${row.positions} without enough price history are left out.` : '';
            return (
              <tr key={row.id} className={`is-${row.level}${unlabelled ? ' is-unlabelled' : ''}${row.positions ? '' : ' is-empty'}`}>
                <th scope="row">{row.label}</th>
                <td className="pcv2-risk-matrix__holdings" title={row.symbols.join(', ') || 'Nothing held'}>{row.symbols.join(' · ')}</td>
                <td>{row.positions}</td>
                <td className={tone(row.netPct)}>{pct(row.netPct)}</td>
                <td>{pct(row.grossPct)}</td>
                <td title={`${riskTitle}${unmeasuredNote}`}>{riskCell(row.riskSharePct, value => `${signed(value, 0)}%`)}</td>
                <td title={`Contribution to the book's beta to the S&P 500.${unmeasuredNote}`}>{riskCell(row.beta, value => signed(value, 2))}</td>
                {QUAD_READING_SCOPES.map(({ id, label }) => {
                  const quad = current[id]?.quad;
                  const fit = quadFit(row.playbook, quad);
                  const name = quad ? QUAD_PLAYBOOK[`q${quad}`].quad : null;
                  return (
                    <td key={id} className={`pcv2-risk-matrix__fit${fit ? ` is-${fit}` : ''}`}
                      title={!quad ? `No ${label} reading entered` : fit
                        ? `${row.playbook.label} is among Hedgeye's ${fit} in ${name}`
                        : `Hedgeye's playbook lists no view on this row in ${name}`}>
                      {fit ? (fit === 'best' ? 'Best' : 'Worst') : '—'}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
      </div>
      {saveError && <div className="pcv2-risk-matrix__note" role="status">Readings are available for this visit; browser storage could not save them.</div>}
    </section>
  );
}
