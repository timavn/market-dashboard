import React, { useEffect, useState } from 'react';
import { EXPOSURE_DIMENSIONS, QUAD_PLAYBOOK } from '../../constants/quadExposureCatalog';
import {
  PORTFOLIO_QUAD_READINGS_KEY,
  QUAD_READING_SCOPES,
  currentPortfolioQuadReadings,
  loadPortfolioQuadReadings,
  quadReadingDate,
} from '../../utils/portfolioQuadReadings';
import './PortfolioQuadReference.css';

const QUADS = [1, 2, 3, 4];

export default function PortfolioQuadReference() {
  const [readings, setReadings] = useState(loadPortfolioQuadReadings);
  const [today, setToday] = useState(quadReadingDate);
  const [referenceQuad, setReferenceQuad] = useState(null);
  const [saveError, setSaveError] = useState(false);
  const current = currentPortfolioQuadReadings(readings, today);
  const monthlyQuad = current.usMonthly?.quad || null;
  const selectedQuad = referenceQuad ?? monthlyQuad;
  const playbook = QUAD_PLAYBOOK[`q${selectedQuad}`];

  useEffect(() => {
    const refreshDate = () => setToday(quadReadingDate());
    const onStorage = (event) => {
      if (event.key === PORTFOLIO_QUAD_READINGS_KEY || event.key === null) {
        setReadings(loadPortfolioQuadReadings());
      }
    };
    const interval = window.setInterval(refreshDate, 60000);
    window.addEventListener('focus', refreshDate);
    window.addEventListener('storage', onStorage);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', refreshDate);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  const updateReading = (scope, value) => {
    const updatedToday = quadReadingDate();
    const updated = {
      ...readings,
      [scope]: value ? { quad: Number(value), asOf: updatedToday, source: 'manual-hedgeye' } : null,
    };
    setToday(updatedToday);
    setReadings(updated);
    try {
      window.localStorage.setItem(PORTFOLIO_QUAD_READINGS_KEY, JSON.stringify(updated));
      setSaveError(false);
    } catch (_error) {
      setSaveError(true);
    }
  };

  return (
    <aside className="pcv2-card pcv2-quad-reference" aria-label="Hedgeye quad reference">
      <div className="pcv2-quad-reference__regimes" aria-label="Current quad readings">
        {QUAD_READING_SCOPES.map(({ id, label }) => {
          const reading = current[id];
          return (
            <label key={id} className={`pcv2-quad-reference__regime${reading ? ` is-q${reading.quad}` : ''}`}>
              <span>{label}</span>
              <span className="pcv2-quad-reference__select">
                <span className="pcv2-quad-reference__dot" aria-hidden="true" />
                <select
                  aria-label={`${label} current quad`}
                  title={reading
                    ? `${reading.sourceLabel || 'Manually entered Hedgeye reading'} · ${reading.asOf}. Select to update manually.`
                    : 'Set the current Hedgeye reading; no current reading has been entered.'}
                  value={reading?.quad || ''}
                  onChange={event => updateReading(id, event.target.value)}
                >
                  <option value="">—</option>
                  {QUADS.map(quad => <option key={quad} value={quad}>Quad {quad}</option>)}
                </select>
                <span className="pcv2-quad-reference__chevron" aria-hidden="true" />
              </span>
            </label>
          );
        })}
      </div>

      <div className="pcv2-quad-reference__quads" role="group" aria-label="Browse quad reference">
        {QUADS.map(quad => (
          <button key={quad} type="button" className={`is-q${quad}`}
            aria-label={`View Quad ${quad} ${QUAD_PLAYBOOK[`q${quad}`].quad.split(': ')[1]}`}
            aria-pressed={selectedQuad === quad}
            title={quad === monthlyQuad ? 'Current U.S. Monthly quad. Select to follow monthly updates.' : `View Quad ${quad} reference`}
            onClick={() => setReferenceQuad(quad === monthlyQuad ? null : quad)}>
            <strong>Q{quad}</strong>
            <span className="pcv2-quad-reference__quad-name">{QUAD_PLAYBOOK[`q${quad}`].quad.split(': ')[1]}</span>
            {selectedQuad === quad && <span className="pcv2-quad-reference__check" aria-hidden="true">✓</span>}
          </button>
        ))}
      </div>

      <div className="pcv2-quad-reference__body" aria-live="polite">
        {playbook ? (
          <table aria-label={`Hedgeye Quad ${selectedQuad} best and worst`}>
            <colgroup><col className="pcv2-quad-reference__category-col" /><col /><col /></colgroup>
            <thead><tr>
              <th scope="col" aria-label="Category" />
              <th scope="col" className="is-best">Best</th>
              <th scope="col" className="is-worst">Worst</th>
            </tr></thead>
            <tbody>
              {Object.entries(EXPOSURE_DIMENSIONS).map(([dimension, { label }]) => (
                <tr key={dimension}>
                  <th scope="row">{label}</th>
                  {['best', 'worst'].map(side => (
                    <td key={side} className={`is-${side}`}>
                      <ol aria-label={`${label} ${side}`}>
                        {playbook[dimension][side].map(item => <li key={item}>{item}</li>)}
                      </ol>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="pcv2-quad-reference__empty">
            <strong>Choose a quad to view Hedgeye’s best and worst.</strong>
            <span>Set U.S. Monthly above to make it the default.</span>
          </div>
        )}
      </div>
      {saveError && <div className="pcv2-quad-reference__save-error" role="status">Readings are available for this visit; browser storage could not save them.</div>}
    </aside>
  );
}
