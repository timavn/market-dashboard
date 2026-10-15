import React from 'react';
import { finite } from './monitorNumbers';
import {
  FactorRow, formatFactorNumber, genericFactorValuePresentation,
} from './factorPresentation';
import './GenericFactorMonitor.css';
import HedgaiResearchRow from './HedgaiResearchRow';

const unusableFactor = (row) => row?.refreshFailed === true || row?.fromCache === true
  || row?.cachedOnly === true || row?.cacheOnly === true || row?.seeded === true
  || row?.mock === true || row?.stale === true || row?.connected === false
  || row?.providerConnected === false;

const GenericFactorMonitor = ({ snapshot, refreshDelayed, marketUi }) => {
  const rows = Array.isArray(snapshot?.factorRows) ? snapshot.factorRows : [];
  const venueId = snapshot?.selectedVenueId || snapshot?.selection?.venueId || snapshot?.displaySelection?.venueId || 'auto';
  const venueLabel = snapshot?.venues?.[venueId]?.label || (venueId === 'auto' ? 'AUTO' : venueId);
  const eventTicker = snapshot?.contracts?.event?.ticker || snapshot?.selectedGenerationId || null;
  const accessibleMetadata = [venueLabel, eventTicker, 'CURRENT'].filter(Boolean).join(' · ').toUpperCase();
  return (
    <section
      className="pm-spx-factor-panel"
      aria-label={`${marketUi.fullLabel} factor monitor · ${accessibleMetadata}`}
      data-selected-venue={venueId}
      data-event-ticker={eventTicker || undefined}
    >
      <table className="pm-spx-factor-table pm-generic-factor-table">
        <thead>
          <tr><th>FACTOR</th><th>VALUE</th><th>MAX PTS</th><th>POINTS</th><th>AS OF</th></tr>
        </thead>
        <tbody>
          {!rows.some(row => row.role === 'gate') && <HedgaiResearchRow reading={snapshot?.publishedResearch?.hedgai} />}
          {rows.map((row) => {
            const gate = row.role === 'gate';
            const metrics = Array.isArray(row.metrics) ? row.metrics : null;
            const availableMetrics = metrics?.filter((metric) => finite(metric.value));
            const available = !unusableFactor(row)
              && (gate || ['available', 'historical', 'proxy'].includes(row.status))
              && (!metrics || availableMetrics.length > 0);
            const displayValue = row.displayValue ?? (finite(row.value) ? formatFactorNumber(row.value) : row.value);
            const valuePresentation = genericFactorValuePresentation(row, displayValue || '—');
            return (
              <React.Fragment key={row.id || row.label}>
              {gate && <HedgaiResearchRow reading={snapshot?.publishedResearch?.hedgai} />}
              <FactorRow
                label={row.label}
                value={valuePresentation.value}
                valueTone={valuePresentation.tone}
                valueDetail={row.detail}
                detail={row.detail}
                source={[
                  row.status === 'historical' ? 'LAST COMPLETED SESSION' : null,
                  row.source,
                  row.fit ? `FIT ${String(row.fit).toUpperCase()}` : null,
                  row.note,
                ].filter(Boolean).join(' · ')}
                asOf={row.asOf}
                available={available}
                partial={available && Boolean(metrics && availableMetrics.length < metrics.length)}
                refreshDelayed={refreshDelayed || row.refreshDelayed}
                referenceStatus={row.status}
              />
              </React.Fragment>
            );
          })}
          {!rows.length && (
            <tr className="is-unavailable"><td colSpan="5">NO VERIFIED CURRENT FACTORS</td></tr>
          )}
        </tbody>
      </table>
    </section>
  );
};

export default GenericFactorMonitor;
